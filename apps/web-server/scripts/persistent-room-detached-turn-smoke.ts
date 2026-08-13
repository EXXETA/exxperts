import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import http from "node:http";
import type { AddressInfo } from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { authedFetch, type AuthedFetchInit, SMOKE_AUTH_HEADERS, SMOKE_SERVER_AUTH_ENV, SMOKE_SERVER_SPAWN_TREE_OPTIONS, stopSmokeServer } from "./smoke-server-process.js";

// Community #14 slice 1 end-to-end: closing the room websocket while a turn is
// in flight DETACHES the turn instead of aborting it. Against a real spawned
// server with a synthetic OpenAI-compatible SSE gateway, proves:
//   1. the provider stream is NOT aborted by the disconnect and runs to its end;
//   2. the room lock stays held while the turn cooks (a new connection bounces
//      with the "finishing a response in the background" message);
//   3. the finished answer lands in the thread file server-side, superseding a
//      partial assistant tail the client persisted before the drop, and the
//      thread parks as standby;
//   4. the turn state settles idle/completed and the lock releases, so a new
//      connection (Resume) succeeds afterwards;
//   5. a turn the user STOPPED before disconnecting still cancels (no detach);
//   6. a provider stream that HANGS after the disconnect is aborted by the
//      detach watchdog (deadline shortened via EXXETA_DETACHED_TURN_DEADLINE_MS),
//      the partial lands with its honest cut-short note, and the lock releases.
// Slice 3 (completion signal) rides the same sections: the landing records an
// unseen-landed-answer marker on the room status (threadId/turnId/terminal
// reason), binding a new session clears it, a cancelled turn never writes one,
// and the watchdog landing records the marker with terminalReason failed.
// Issue #33 (stepping back into a room) extends the run:
//   2. (rewritten) a connection for the SAME conversation no longer bounces
//      mid-cook: it binds, receives turn_reattach plus the replayed stream
//      from the turn's very first chunk, then the live continuation, and
//      leaving again re-detaches (watchdog re-armed, lock kept) so the
//      original landing sections 3 and 4 still prove the unwatched path; the
//      honest room_cooking bounce survives only for a mismatched conversation;
//   7. a reattach that stays: the adopted stream runs to the turn's end on the
//      new socket with the deltas joining seamlessly (no gap, no duplicate),
//      the landing is written exactly once with the room left active (not
//      standby), no unseen marker is recorded for an answer the user watched
//      land, and the next prompt works because the settle rebinds the session;
//   8. reattach then Stop: the adopted turn cancels through the ordinary
//      cancelling machinery (provider request aborted, terminal reason
//      cancelled, no marker);
//   9. reattach racing the landing: connecting while the last chunk is in
//      flight resolves coherently on either side of the race, with the answer
//      landing exactly once and, when the bind won a claim, the replayed
//      frames carrying the whole answer exactly once;
//  10. displacement: when a THIRD connection takes the adopted turn over, the
//      displaced session is actively told (error code room_displaced, never a
//      frozen busy spinner), its Stop loses authority over the turn
//      (claimant-checked), and the takeover session streams the whole answer;
//  11. the supersede anchor: with a completed earlier exchange persisted, the
//      cooking prompt missing from the file AND textually identical to the
//      earlier prompt, the reattach frame anchors on turn identity
//      (anchorItemId = last item at turn start) and the unwatched landing
//      keeps the earlier answer, restores the missing prompt, and appends the
//      new answer after it;
//  12. the mismatched-conversation bounce holds WHILE ADOPTED (keyed on the
//      cooking handle, not the cooking set adopt() clears), with the
//      adopter's stream and lock untouched;
//  13. reattach is opt-in: a connection without the reattach capability gets
//      the pre-#33 room_cooking bounce and zero replay frames, while a
//      capable connection adopts the same turn right afterwards;
//  14. settle during bind, made deterministic via the test-only bind delay:
//      the reattach frame arrives settled with the whole answer replayed
//      once, and the settle leaves the mid-bind claimant's room lock HELD;
//  15. replay-buffer lifecycle: an ordinary completed turn releases its
//      buffer at settle (probe: frames 0), and a turn that overflows the
//      byte cap frees the buffer immediately, bounces reattaches honestly
//      instead of replaying a gap, and still lands the whole answer;
//  16. overflow AND settle inside the claim-to-adopt window: the raced bind
//      is bounced rather than handed an empty settled replay, and the landed
//      answer survives in the thread file;
//  17. a claim takeover during another claimant's bind: the displaced
//      mid-bind claimant receives room_displaced and never a silent ordinary
//      bind, while the takeover adopts and streams the whole answer;
//  18. the landing cut drops post-anchor tool chips (same predicate as the
//      client's supersede), keeping everything before the anchor.

const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "exxperts-detached-turn-home-"));
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const webServerDir = path.resolve(scriptDir, "..");
const repoRoot = path.resolve(webServerDir, "..", "..");
const port = 24000 + Math.floor(Math.random() * 10000);
const baseUrl = `http://127.0.0.1:${port}`;
const agentDir = path.join(tempHome, ".exxperts", "agent");
const productAppRoot = path.join(tempHome, ".exxperts", "app");

const SLOW_MARKER = "SLOW_STREAM_MARKER";
const HANG_MARKER = "HANG_STREAM_MARKER";
const BIG_MARKER = "BIG_STREAM_MARKER";
// 16 chunks x 400ms give the reattach sections (issue #33) a wide enough
// mid-cook window to bind, replay and leave again before the stream ends.
const SLOW_ANSWER_CHUNKS = Array.from({ length: 16 }, (_, i) => `slow part ${i + 1}. `);
const HANG_ANSWER_CHUNKS = ["Hang part 1. "];
const FAST_ANSWER_CHUNKS = ["Quick ", "answer."];
// Section 15's overflow fodder: 10 chunks x ~16KB overflow the smoke's 64KB
// replay cap (EXXETA_REATTACH_REPLAY_CAP_BYTES below) around chunk 4, leaving
// a comfortable still-cooking window to assert the overflow bounce.
const BIG_ANSWER_CHUNKS = Array.from({ length: 10 }, (_, i) => `big part ${i + 1} ${"x".repeat(16000)} `);
const SLOW_CHUNK_DELAY_MS = 400;
const REPLAY_CAP_OVERRIDE_BYTES = 64 * 1024;
// Watchdog override for section 6. Must comfortably exceed the longest
// UNWATCHED cooking stretch (section 2 re-arms it when the adopter leaves at
// roughly chunk 8, leaving ~8 chunks x 400ms to stream), or the watchdog
// would kill the legitimately-finishing detached turn the smoke proves.
const DETACHED_DEADLINE_OVERRIDE_MS = 8000;

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

// ---------------------------------------------------------------------------
// Synthetic OpenAI-compatible gateway (same rig as consult-streaming-smoke):
// bodies carrying SLOW_MARKER stream slowly for a deterministic in-flight
// window; every request records whether the CLIENT (the server's provider
// call) aborted it mid-stream or let it finish.
// ---------------------------------------------------------------------------
type GatewayRequest = { model: string; slow: boolean; hang: boolean; aborted: boolean; finished: boolean; sent: number };
const gatewayRequests: GatewayRequest[] = [];

function sseChunk(payload: unknown): string {
	return `data: ${JSON.stringify(payload)}\n\n`;
}

const gateway = http.createServer((req, res) => {
	if (req.method !== "POST" || !String(req.url ?? "").endsWith("/chat/completions")) {
		res.writeHead(404).end();
		return;
	}
	let body = "";
	req.on("data", (chunk) => { body += chunk; });
	req.on("end", () => {
		let parsed: any = {};
		try { parsed = JSON.parse(body); } catch {}
		const model = String(parsed?.model ?? "");
		const slow = body.includes(SLOW_MARKER);
		const hang = body.includes(HANG_MARKER);
		const big = body.includes(BIG_MARKER);
		const record: GatewayRequest = { model, slow: slow || big, hang, aborted: false, finished: false, sent: 0 };
		gatewayRequests.push(record);
		res.on("close", () => { if (!res.writableFinished) record.aborted = true; });

		const chunks = hang ? HANG_ANSWER_CHUNKS : big ? BIG_ANSWER_CHUNKS : slow ? SLOW_ANSWER_CHUNKS : FAST_ANSWER_CHUNKS;
		res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
		const base = { id: `cmpl_${gatewayRequests.length}`, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model };
		res.write(sseChunk({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }] }));
		let index = 0;
		const writeNext = () => {
			if (record.aborted || res.destroyed) return;
			if (index < chunks.length) {
				res.write(sseChunk({ ...base, choices: [{ index: 0, delta: { content: chunks[index] }, finish_reason: null }] }));
				index += 1;
				record.sent = index;
				setTimeout(writeNext, slow || hang || big ? SLOW_CHUNK_DELAY_MS : 0);
				return;
			}
			// A hanging stream never finishes: keep the connection open until
			// the client aborts (the detach watchdog is what must do that).
			if (hang) return;
			res.write(sseChunk({
				...base,
				choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
				usage: { prompt_tokens: 120, completion_tokens: 30, total_tokens: 150 },
			}));
			res.write("data: [DONE]\n\n");
			record.finished = true;
			res.end();
		};
		writeNext();
	});
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
async function waitForServer(server: ChildProcessWithoutNullStreams): Promise<void> {
	const deadline = Date.now() + 20_000;
	let lastError = "server did not respond";
	while (Date.now() < deadline) {
		if (server.exitCode != null) throw new Error(`server exited before startup with code ${server.exitCode}`);
		try {
			const response = await fetch(`${baseUrl}/healthz`);
			if (response.ok) return;
			lastError = `healthz returned ${response.status}`;
		} catch (error) {
			lastError = (error as Error).message;
		}
		await new Promise((resolve) => setTimeout(resolve, 150));
	}
	throw new Error(`server did not become ready: ${lastError}`);
}

async function requestJson(pathname: string, init?: AuthedFetchInit): Promise<{ status: number; body: any }> {
	const response = await authedFetch(`${baseUrl}${pathname}`, init);
	const text = await response.text();
	return { status: response.status, body: text ? JSON.parse(text) : null };
}

async function createRoom(displayName: string): Promise<string> {
	const response = await requestJson("/api/persistent-agents", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ displayName, userName: "Synthetic User", preferredUserAddress: "Synthetic User" }),
	});
	assert(response.status === 201, `room creation should return 201, got ${response.status}: ${JSON.stringify(response.body)}`);
	const id = String(response.body?.agent?.id ?? "");
	assert(id, `room creation should return an agent id, got ${JSON.stringify(response.body)}`);
	return id;
}

async function putThread(agentId: string, threadId: string, items: unknown[], state: "active" | "standby" = "active"): Promise<{ status: number; body: any }> {
	return requestJson(`/api/persistent-agents/${agentId}/threads/${threadId}`, {
		method: "PUT",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ state, origin: "launcher", model: { provider: "openai-compatible", model: "room-model" }, items }),
	});
}

async function getThread(agentId: string, threadId: string): Promise<any> {
	const response = await requestJson(`/api/persistent-agents/${agentId}/threads/${threadId}`);
	assert(response.status === 200, `thread GET should return 200, got ${response.status}`);
	return response.body.thread;
}

async function getStatus(agentId: string): Promise<any> {
	const response = await requestJson("/api/persistent-agents");
	assert(response.status === 200, `statuses GET should return 200, got ${response.status}`);
	const status = (response.body?.agents ?? response.body ?? []).find?.((row: any) => row.id === agentId)
		?? (Array.isArray(response.body) ? response.body.find((row: any) => row.id === agentId) : null);
	assert(status, `status for ${agentId} should exist, got ${JSON.stringify(response.body).slice(0, 400)}`);
	return status;
}

type Frame = Record<string, any>;

// The assistant text carried by one frame, empty for every non-delta frame.
function deltaText(frame: Frame): string {
	const update = frame?.type === "event" && frame.event?.type === "message_update" ? frame.event.assistantMessageEvent : null;
	return update?.type === "text_delta" ? String(update.delta ?? "") : "";
}

// Every delta from `fromIndex` on, joined: the reattach seam proof (issue #33)
// is that replayed plus live deltas concatenate to the answer, once, in order.
function joinedDeltas(frames: Frame[], fromIndex: number): string {
	return frames.slice(fromIndex).map(deltaText).join("");
}

function countOccurrences(haystack: string, needle: string): number {
	return haystack.split(needle).length - 1;
}

const WebSocketImpl: any = (await import("ws")).default;

class WsHarness {
	readonly frames: Frame[] = [];
	private socket: any;

	private constructor(socket: any) {
		this.socket = socket;
		socket.addEventListener("message", (event: { data: unknown }) => {
			try { this.frames.push(JSON.parse(String(event.data))); } catch {}
		});
	}

	static async connect(persistentAgentId: string, conversationId: string, options: { reattach?: boolean; extraParams?: string } = {}): Promise<WsHarness> {
		// The reattach capability rides every connect by default, like the real
		// client; `reattach: false` impersonates a pre-#33 bundle.
		const reattachParam = options.reattach === false ? "" : "&reattach=1";
		const socket = new WebSocketImpl(`ws://127.0.0.1:${port}/ws?persistentAgentId=${persistentAgentId}&conversationId=${conversationId}&modelProvider=openai-compatible&model=room-model${reattachParam}${options.extraParams ?? ""}`, { headers: { ...SMOKE_AUTH_HEADERS } });
		const harness = new WsHarness(socket);
		await new Promise<void>((resolve, reject) => {
			socket.addEventListener("open", () => resolve());
			socket.addEventListener("error", () => reject(new Error("websocket failed to connect")));
		});
		return harness;
	}

	send(frame: Frame): void {
		this.socket.send(JSON.stringify(frame));
	}

	close(): void {
		try { this.socket.close(); } catch {}
	}

	async waitFor(predicate: (frame: Frame) => boolean, label: string, fromIndex = 0, timeoutMs = 25_000): Promise<number> {
		const deadline = Date.now() + timeoutMs;
		let index = fromIndex;
		while (Date.now() < deadline) {
			for (; index < this.frames.length; index++) {
				if (predicate(this.frames[index])) return index;
			}
			await new Promise((resolve) => setTimeout(resolve, 25));
		}
		const errors = this.frames.filter((frame) => String(frame.type).includes("error")).map((frame) => frame.message).join(" | ");
		throw new Error(`timed out waiting for ${label}; saw frame types: ${this.frames.map((frame) => frame.type).join(", ")}${errors ? `; errors: ${errors}` : ""}`);
	}
}

function smokeEnv(): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = { ...process.env };
	for (const key of [
		"ANTHROPIC_API_KEY",
		"ANTHROPIC_OAUTH_TOKEN",
		"OPENAI_API_KEY",
		"AZURE_OPENAI_API_KEY",
		"EXXETA_AI_API_KEY",
		"COPILOT_GITHUB_TOKEN",
		"GH_TOKEN",
		"GITHUB_TOKEN",
		"GEMINI_API_KEY",
		"GOOGLE_CLOUD_API_KEY",
		"OPENROUTER_API_KEY",
	]) {
		delete env[key];
	}
	env.HOME = tempHome;
	env.USERPROFILE = tempHome;
	env.PORT = String(port);
	Object.assign(env, SMOKE_SERVER_AUTH_ENV);
	env.EXXETA_HOME = repoRoot;
	env.EXXPERTS_CODING_AGENT_DIR = agentDir;
	env.EXXETA_DETACHED_TURN_DEADLINE_MS = String(DETACHED_DEADLINE_OVERRIDE_MS);
	// #33 test introspection: honors the testBindDelayMs connect param (pins
	// the settle-during-bind branch deterministically) and the replay-buffer
	// stats probe.
	env.EXXPERTS_TEST_INTROSPECTION = "1";
	// Small replay cap so section 15 can overflow it with the BIG turn while
	// every slow-turn section stays far below (a 16-chunk slow turn buffers a
	// few KB).
	env.EXXETA_REATTACH_REPLAY_CAP_BYTES = String(REPLAY_CAP_OVERRIDE_BYTES);
	return env;
}

async function waitUntil(predicate: () => Promise<boolean> | boolean, label: string, timeoutMs = 25_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 150));
	}
	throw new Error(`timed out waiting until ${label}`);
}

let server: ChildProcessWithoutNullStreams | null = null;
const serverOutput: string[] = [];
let ws: WsHarness | null = null;
let ws2: WsHarness | null = null;
let ws3: WsHarness | null = null;
let ws4: WsHarness | null = null;
let wsOther: WsHarness | null = null;
let ws5: WsHarness | null = null;
let ws6: WsHarness | null = null;
let ws7: WsHarness | null = null;
let ws8: WsHarness | null = null;
let ws9: WsHarness | null = null;
let ws10a: WsHarness | null = null;
let ws10b: WsHarness | null = null;
let ws10c: WsHarness | null = null;
let ws11a: WsHarness | null = null;
let ws11b: WsHarness | null = null;
let ws12a: WsHarness | null = null;
let ws12b: WsHarness | null = null;
let ws12x: WsHarness | null = null;
let ws13a: WsHarness | null = null;
let ws13o: WsHarness | null = null;
let ws13b: WsHarness | null = null;
let ws14a: WsHarness | null = null;
let ws14b: WsHarness | null = null;
let ws15a: WsHarness | null = null;
let ws15b: WsHarness | null = null;
let ws15c: WsHarness | null = null;
let ws16a: WsHarness | null = null;
let ws16b: WsHarness | null = null;
let ws17a: WsHarness | null = null;
let ws17b: WsHarness | null = null;
let ws17c: WsHarness | null = null;
let ws18: WsHarness | null = null;

try {
	await new Promise<void>((resolve) => gateway.listen(0, "127.0.0.1", resolve));
	const gatewayPort = (gateway.address() as AddressInfo).port;

	fs.mkdirSync(agentDir, { recursive: true, mode: 0o700 });
	fs.mkdirSync(productAppRoot, { recursive: true, mode: 0o700 });
	fs.writeFileSync(
		path.join(agentDir, "models.json"),
		JSON.stringify({
			providers: {
				"openai-compatible": {
					name: "Synthetic SSE Gateway",
					baseUrl: `http://127.0.0.1:${gatewayPort}/v1`,
					api: "openai-completions",
					models: [
						{ id: "room-model", name: "Room Model", contextWindow: 128000, maxTokens: 16384 },
					],
				},
			},
		}, null, 2),
		{ mode: 0o600 },
	);
	fs.writeFileSync(
		path.join(agentDir, "auth.json"),
		JSON.stringify({ "openai-compatible": { type: "api_key", key: "synthetic-detached-turn-key" } }, null, 2),
		{ mode: 0o600 },
	);
	fs.writeFileSync(
		path.join(productAppRoot, "openai-compatible-ai-profile.json"),
		JSON.stringify({
			profileId: "openai-compatible",
			providerId: "openai-compatible",
			label: "Synthetic SSE Gateway",
			roomModels: [{ modelId: "room-model", label: "Room Model" }],
			maintenanceModel: "room-model",
		}, null, 2),
		{ mode: 0o600 },
	);
	fs.writeFileSync(path.join(productAppRoot, "persistent-agent-ai-profile.json"), JSON.stringify({ profileId: "openai-compatible" }, null, 2), { mode: 0o600 });

	server = spawn("npx", ["tsx", "src/index.ts"], {
		shell: process.platform === "win32",
		...SMOKE_SERVER_SPAWN_TREE_OPTIONS,
		cwd: webServerDir,
		env: smokeEnv(),
	});
	server.stdout.on("data", (chunk) => serverOutput.push(String(chunk)));
	server.stderr.on("data", (chunk) => serverOutput.push(String(chunk)));
	await waitForServer(server);

	const roomId = await createRoom("Detached Turn Room");
	const conversationId = `smokeconv_${Date.now().toString(36)}`;
	await putThread(roomId, conversationId, []);

	// --- 1. Detach: disconnect mid-stream, turn keeps cooking ----------------
	ws = await WsHarness.connect(roomId, conversationId);
	await ws.waitFor((frame) => frame.type === "ready", "ready frame");
	const promptText = `Please think out loud. ${SLOW_MARKER}`;
	ws.send({ type: "prompt", text: promptText });
	// Simulate the client's debounced persist landing the user's message plus
	// a partial assistant tail before the drop.
	await ws.waitFor((frame) => frame.type === "event" && frame.event?.type === "message_update", "first streamed delta");
	const partialItems = [
		{ kind: "user", id: "u1", text: promptText },
		{ kind: "assistant", id: "a1-partial", text: "slow part 1. ", streaming: true },
	];
	const partialPut = await putThread(roomId, conversationId, partialItems);
	assert(partialPut.status === 200, `mid-stream client persist should succeed, got ${partialPut.status}: ${JSON.stringify(partialPut.body)}`);
	const requestsBeforeClose = gatewayRequests.filter((request) => request.slow).length;
	assert(requestsBeforeClose === 1, `exactly one slow provider request should be in flight, got ${requestsBeforeClose}`);
	ws.close();
	ws = null;

	// --- 2. While cooking: stepping back in ADOPTS the turn (issue #33) ------
	await new Promise((resolve) => setTimeout(resolve, 400));
	const slowRequest = gatewayRequests.find((request) => request.slow)!;
	assert(!slowRequest.aborted, "the provider stream must NOT be aborted by the disconnect");
	// The status advertises the open door: cooking with no client attached.
	const cookingStatus = await getStatus(roomId);
	assert(cookingStatus.answeringDetached === true, `a cooking room with no client should report answeringDetached, got ${JSON.stringify(cookingStatus.answeringDetached)}`);
	// A connection for a DIFFERENT conversation still bounces, honestly: the
	// machine-readable code stays the client's detach-vs-death signal.
	wsOther = await WsHarness.connect(roomId, `smokeconv_other_${Date.now().toString(36)}`);
	const bounceIndex = await wsOther.waitFor((frame) => frame.type === "error", "mismatched-conversation bounce while cooking");
	assert(/finishing a response in the background/.test(String(wsOther.frames[bounceIndex].message)), `bounce should name the background response, got: ${wsOther.frames[bounceIndex].message}`);
	assert(wsOther.frames[bounceIndex].code === "room_cooking", `bounce should carry code room_cooking, got: ${JSON.stringify(wsOther.frames[bounceIndex].code)}`);
	wsOther.close();
	wsOther = null;
	// The SAME conversation binds instead of bouncing: ready frame, then the
	// reattach frame, then the whole stream so far replayed, then live deltas.
	ws2 = await WsHarness.connect(roomId, conversationId);
	await ws2.waitFor((frame) => frame.type === "ready", "reattach ready frame");
	const reattachIndex = await ws2.waitFor((frame) => frame.type === "turn_reattach", "turn_reattach frame");
	const reattachFrame = ws2.frames[reattachIndex];
	assert(reattachFrame.settled === false, `a mid-cook reattach should not be settled, got ${JSON.stringify(reattachFrame.settled)}`);
	assert(reattachFrame.conversationId === conversationId, `turn_reattach should name the cooking conversation, got ${JSON.stringify(reattachFrame.conversationId)}`);
	assert(String(reattachFrame.userText ?? "").includes(SLOW_MARKER), `turn_reattach should carry the turn's user text, got ${JSON.stringify(reattachFrame.userText)}`);
	// The replay reaches back to the turn's very first chunk, which streamed
	// before this connection even existed.
	await ws2.waitFor((frame) => deltaText(frame).includes("slow part 1. "), "replayed first chunk", reattachIndex);
	// Live continuation: a later chunk arrives on this socket as it streams.
	await ws2.waitFor((frame) => deltaText(frame).includes("slow part 8. "), "live continuation past the replay", reattachIndex, 15_000);
	const seamText = joinedDeltas(ws2.frames, reattachIndex);
	assert(seamText.startsWith("slow part 1. slow part 2. "), `replayed and live deltas must join seamlessly, got ${JSON.stringify(seamText.slice(0, 60))}`);
	assert(countOccurrences(seamText, "slow part 1. ") === 1, `the seam must not duplicate replayed text, got ${JSON.stringify(seamText.slice(0, 120))}`);
	const adoptedStatus = await getStatus(roomId);
	assert(adoptedStatus.answeringDetached === false, `an adopted turn is no longer detached cooking, got ${JSON.stringify(adoptedStatus.answeringDetached)}`);
	assert(adoptedStatus.activeLock, "the room lock stays held while the adopter is inside");
	// Leaving again mid-cook re-detaches: the turn keeps cooking with the lock
	// held and the door reopens, so sections 3 and 4 still prove the original
	// UNWATCHED landing (standby parking plus the unseen marker).
	ws2.close();
	ws2 = null;
	await waitUntil(async () => (await getStatus(roomId)).answeringDetached === true, "room back to detached cooking after the adopter left", 10_000);
	assert(!slowRequest.aborted, "the provider stream must survive a reattach and a second leave");

	// --- 3. The turn runs to its end and lands in the thread file ------------
	await waitUntil(() => slowRequest.finished, "provider stream finished", 30_000);
	const expectedText = SLOW_ANSWER_CHUNKS.join("").trim();
	await waitUntil(async () => {
		const thread = await getThread(roomId, conversationId);
		return (thread.items ?? []).some((item: any) => String(item.id ?? "").startsWith("detached-assistant-"));
	}, "landed detached assistant item", 30_000);
	const landedThread = await getThread(roomId, conversationId);
	assert(landedThread.state === "standby", `thread should park as standby after landing, got ${landedThread.state}`);
	const landedItems: any[] = landedThread.items ?? [];
	const landed = landedItems.find((item) => String(item.id ?? "").startsWith("detached-assistant-"));
	assert(landed?.kind === "assistant" && landed.text === expectedText, `landed assistant item should carry the full answer, got ${JSON.stringify(landed)}`);
	assert(landed.streaming === false, "landed assistant item must not be marked streaming");
	assert(!landedItems.some((item) => item.id === "a1-partial"), "the partial assistant tail must be superseded by the landed answer");
	assert(landedItems.some((item) => item.id === "u1" && item.kind === "user"), "the user's message must survive the landing");
	assert(landedItems.filter((item) => item.kind === "assistant").length === 1, `exactly one assistant item should remain, got ${JSON.stringify(landedItems.map((item) => item.id))}`);

	// --- 4. Turn settled + lock released: reopening works --------------------
	const status = await getStatus(roomId);
	assert(status.activeThread?.inFlight === false, `turn should be settled, got ${JSON.stringify(status.activeThread?.activeTurn)}`);
	assert(status.activeThread?.activeTurn?.lastTerminalReason === "completed", `turn should settle completed, got ${JSON.stringify(status.activeThread?.activeTurn)}`);
	assert(!status.activeLock, `room lock should be released after landing, got ${JSON.stringify(status.activeLock)}`);
	// Slice 3: the landing recorded the unseen marker — a fresh session's Home
	// reads it off the status to badge the room.
	assert(status.unseenLandedAnswer, `the landing should record an unseen-landed-answer marker, got ${JSON.stringify(status.unseenLandedAnswer)}`);
	assert(status.unseenLandedAnswer.threadId === conversationId, `marker should name the landed thread, got ${JSON.stringify(status.unseenLandedAnswer)}`);
	assert(status.unseenLandedAnswer.terminalReason === "completed", `marker should carry terminalReason completed, got ${JSON.stringify(status.unseenLandedAnswer)}`);
	assert(String(landed.id) === `detached-assistant-${status.unseenLandedAnswer.turnId}`, `marker turnId should match the landed item id, got ${JSON.stringify({ landedId: landed.id, marker: status.unseenLandedAnswer })}`);
	const reopenPut = await putThread(roomId, conversationId, landedItems);
	assert(reopenPut.status === 200, `resume PUT should succeed, got ${reopenPut.status}`);
	ws3 = await WsHarness.connect(roomId, conversationId);
	await ws3.waitFor((frame) => frame.type === "ready", "resume ready frame");
	// Slice 3: binding a session to the room clears the marker (the user is
	// looking at the landed answer now).
	const boundStatus = await getStatus(roomId);
	assert(!boundStatus.unseenLandedAnswer, `binding a session should clear the unseen marker, got ${JSON.stringify(boundStatus.unseenLandedAnswer)}`);

	// Slice 3 self-heal: a marker whose thread is no longer the room's active
	// thread (read in the CLI, thread retired from another door) must be
	// dropped by the status read instead of badging the room forever.
	const staleMarkerPath = path.join(tempHome, ".exxperts", "app", "personalized-agents", roomId, "runtime", "unseen-landed-answer.json");
	fs.writeFileSync(staleMarkerPath, JSON.stringify({ threadId: "thread_smoke_retired_000000", turnId: "turn-smoke-stale", terminalReason: "completed", landedAt: Date.now() }));
	const healedStatus = await getStatus(roomId);
	assert(!healedStatus.unseenLandedAnswer, `a marker for a retired thread should self-heal away on status read, got ${JSON.stringify(healedStatus.unseenLandedAnswer)}`);
	assert(!fs.existsSync(staleMarkerPath), "the stale marker file should be removed by the self-heal");

	// --- 5. Stop-then-disconnect still cancels (no detach) -------------------
	const requestsBeforeStop = gatewayRequests.length;
	ws3.send({ type: "prompt", text: `Another long one. ${SLOW_MARKER}` });
	await ws3.waitFor((frame) => frame.type === "event" && frame.event?.type === "message_update", "second turn first delta");
	ws3.send({ type: "abort" });
	ws3.close();
	ws3 = null;
	await waitUntil(() => {
		const request = gatewayRequests.slice(requestsBeforeStop).find((row) => row.slow);
		return !!request && (request.aborted || request.finished);
	}, "stopped turn's provider request settled", 20_000);
	const stoppedRequest = gatewayRequests.slice(requestsBeforeStop).find((row) => row.slow)!;
	assert(stoppedRequest.aborted, "a turn the user stopped must abort its provider request on disconnect");
	await waitUntil(async () => {
		const after = await getStatus(roomId);
		return after.activeThread?.inFlight === false && !after.activeLock;
	}, "stopped turn settled and lock released", 20_000);
	const afterStop = await getThread(roomId, conversationId);
	assert(!(afterStop.items ?? []).some((item: any) => String(item.id ?? "").startsWith("detached-assistant-") && item.id !== landed.id), "a cancelled turn must not land a detached assistant item");
	// Slice 3: no landing means no marker — a stopped turn is a SEEN ending.
	const afterStopStatus = await getStatus(roomId);
	assert(!afterStopStatus.unseenLandedAnswer, `a cancelled turn must not record an unseen marker, got ${JSON.stringify(afterStopStatus.unseenLandedAnswer)}`);

	// --- 6. Watchdog: a hung provider stream cannot cook forever -------------
	// The gateway streams one chunk and then goes silent. After the disconnect
	// the shortened deadline (EXXETA_DETACHED_TURN_DEADLINE_MS) must abort the
	// turn, land the partial with the honest cut-short note, and release the
	// lock — without a hang the room would refuse connections forever.
	ws4 = await WsHarness.connect(roomId, conversationId);
	await ws4.waitFor((frame) => frame.type === "ready", "hang turn ready frame");
	const requestsBeforeHang = gatewayRequests.length;
	ws4.send({ type: "prompt", text: `This provider goes silent. ${HANG_MARKER}` });
	await ws4.waitFor((frame) => frame.type === "event" && frame.event?.type === "message_update", "hang turn first delta");
	ws4.close();
	ws4 = null;
	await waitUntil(() => {
		const request = gatewayRequests.slice(requestsBeforeHang).find((row) => row.hang);
		return !!request && request.aborted;
	}, "hung provider request aborted by the detach watchdog", 30_000);
	await waitUntil(async () => {
		const after = await getStatus(roomId);
		return after.activeThread?.inFlight === false && !after.activeLock;
	}, "watchdog-aborted turn settled and lock released", 20_000);
	const afterHangStatus = await getStatus(roomId);
	assert(afterHangStatus.activeThread?.activeTurn?.lastTerminalReason === "failed", `watchdog-aborted turn should settle failed, got ${JSON.stringify(afterHangStatus.activeThread?.activeTurn)}`);
	const hangThread = await getThread(roomId, conversationId);
	assert(hangThread.state === "standby", `thread should park as standby after the watchdog landing, got ${hangThread.state}`);
	const hangItems: any[] = hangThread.items ?? [];
	const hangLanded = hangItems.find((item) => String(item.id ?? "").startsWith("detached-assistant-") && item.id !== landed.id);
	assert(hangLanded?.kind === "assistant" && hangLanded.text === HANG_ANSWER_CHUNKS.join("").trim(), `the watchdog landing should carry the partial answer, got ${JSON.stringify(hangLanded)}`);
	assert(hangItems.some((item) => String(item.id ?? "").startsWith("detached-partial-") && item.kind === "system"), `the partial landing must carry the honest cut-short note, got ${JSON.stringify(hangItems.map((item) => item.id))}`);
	// Slice 3: the watchdog landing records the marker too, with the honest
	// failed reason — the client badges completed landings only, so the reason
	// must survive the wire.
	assert(afterHangStatus.unseenLandedAnswer?.terminalReason === "failed", `the watchdog landing should record an unseen marker with terminalReason failed, got ${JSON.stringify(afterHangStatus.unseenLandedAnswer)}`);
	assert(afterHangStatus.unseenLandedAnswer.threadId === conversationId, `watchdog marker should name the landed thread, got ${JSON.stringify(afterHangStatus.unseenLandedAnswer)}`);

	// --- 7. Full reattach: watch the answer land (issue #33) -----------------
	// A fresh room so the landing assertions cannot be polluted by earlier
	// sections' landed items.
	const room7 = await createRoom("Reattach Watch Room");
	const conv7 = `smokeconv7_${Date.now().toString(36)}`;
	await putThread(room7, conv7, []);
	ws5 = await WsHarness.connect(room7, conv7);
	await ws5.waitFor((frame) => frame.type === "ready", "room7 ready frame");
	const prompt7 = `Watch me finish. ${SLOW_MARKER}`;
	const requestsBefore7 = gatewayRequests.length;
	ws5.send({ type: "prompt", text: prompt7 });
	await ws5.waitFor((frame) => deltaText(frame).length > 0, "room7 first delta");
	// The client's leave-save: the user's message plus a partial tail.
	const partial7 = await putThread(room7, conv7, [
		{ kind: "user", id: "u7", text: prompt7 },
		{ kind: "assistant", id: "a7-partial", text: "slow part 1. ", streaming: true },
	]);
	assert(partial7.status === 200, `room7 mid-stream persist should succeed, got ${partial7.status}`);
	ws5.close();
	ws5 = null;
	await new Promise((resolve) => setTimeout(resolve, 300));
	ws6 = await WsHarness.connect(room7, conv7);
	await ws6.waitFor((frame) => frame.type === "ready", "room7 reattach ready frame");
	const reattach7 = await ws6.waitFor((frame) => frame.type === "turn_reattach", "room7 turn_reattach frame");
	// Watch it land: the adopted stream runs to the turn's end on THIS socket.
	await ws6.waitFor((frame) => frame.type === "event" && frame.event?.type === "agent_end", "room7 adopted turn end", reattach7, 40_000);
	const joined7 = joinedDeltas(ws6.frames, reattach7);
	assert(joined7.trim() === expectedText, `replay plus live deltas must carry the whole answer with no gap, got ${JSON.stringify(joined7.slice(0, 120))}`);
	assert(countOccurrences(joined7, "slow part 1. ") === 1, `the watched stream must carry the answer exactly once, got ${JSON.stringify(joined7.slice(0, 160))}`);
	const request7 = gatewayRequests.slice(requestsBefore7).find((row) => row.slow)!;
	assert(request7.finished && !request7.aborted, "the adopted turn's provider stream must run to its end");
	// The landing is written exactly once, and as a WATCHED landing: the open
	// room is not parked standby, the partial tail is superseded, and no unseen
	// marker is recorded for an answer the user watched land.
	await waitUntil(async () => {
		const thread = await getThread(room7, conv7);
		return (thread.items ?? []).some((item: any) => String(item.id ?? "").startsWith("detached-assistant-"));
	}, "room7 adopted landing written", 20_000);
	const thread7 = await getThread(room7, conv7);
	assert(thread7.state === "active", `a watched landing must not park the open room as standby, got ${thread7.state}`);
	const assistants7 = (thread7.items ?? []).filter((item: any) => item.kind === "assistant");
	assert(assistants7.length === 1 && assistants7[0].text === expectedText, `room7 should land exactly one assistant item carrying the full answer, got ${JSON.stringify(assistants7.map((item: any) => [item.id, String(item.text).slice(0, 40)]))}`);
	assert(!(thread7.items ?? []).some((item: any) => item.id === "a7-partial"), "room7's partial tail must be superseded by the watched landing");
	const status7 = await getStatus(room7);
	assert(status7.activeThread?.inFlight === false, `room7 turn should be settled, got ${JSON.stringify(status7.activeThread?.activeTurn)}`);
	assert(status7.activeThread?.activeTurn?.lastTerminalReason === "completed", `room7 turn should settle completed, got ${JSON.stringify(status7.activeThread?.activeTurn)}`);
	assert(!status7.unseenLandedAnswer, `a watched landing must not record an unseen marker, got ${JSON.stringify(status7.unseenLandedAnswer)}`);
	assert(status7.activeLock, "the adopter keeps the room lock as an ordinary live session");
	// The next prompt works: the settle rebound the session onto the landed
	// history, so the room keeps chatting without a reconnect. (The session
	// history carries the SLOW marker, so the gateway streams slowly again;
	// what matters is that the rebound session streams and completes at all.)
	const beforeFollowUp = ws6.frames.length;
	const requestsBeforeFollowUp = gatewayRequests.length;
	ws6.send({ type: "prompt", text: "Say something else now." });
	await ws6.waitFor((frame) => deltaText(frame).length > 0, "room7 follow-up prompt streams", beforeFollowUp, 30_000);
	await ws6.waitFor((frame) => frame.type === "event" && frame.event?.type === "agent_end", "room7 follow-up turn end", beforeFollowUp, 40_000);
	assert(gatewayRequests.length > requestsBeforeFollowUp, "room7 follow-up must reach the provider through the rebound session");
	ws6.close();
	ws6 = null;
	await waitUntil(async () => !(await getStatus(room7)).activeLock, "room7 lock released after the adopter left", 20_000);

	// --- 8. Reattach then Stop -----------------------------------------------
	const room8 = await createRoom("Reattach Stop Room");
	const conv8 = `smokeconv8_${Date.now().toString(36)}`;
	await putThread(room8, conv8, []);
	ws7 = await WsHarness.connect(room8, conv8);
	await ws7.waitFor((frame) => frame.type === "ready", "room8 ready frame");
	const requestsBefore8 = gatewayRequests.length;
	ws7.send({ type: "prompt", text: `Stop me after the comeback. ${SLOW_MARKER}` });
	await ws7.waitFor((frame) => deltaText(frame).length > 0, "room8 first delta");
	ws7.close();
	ws7 = null;
	await new Promise((resolve) => setTimeout(resolve, 300));
	ws8 = await WsHarness.connect(room8, conv8);
	await ws8.waitFor((frame) => frame.type === "ready", "room8 reattach ready frame");
	await ws8.waitFor((frame) => frame.type === "turn_reattach", "room8 turn_reattach frame");
	const request8 = gatewayRequests.slice(requestsBefore8).find((row) => row.slow)!;
	assert(!request8.aborted, "room8's provider stream must still be cooking at reattach");
	// Stop from the adopted session cancels through the ordinary machinery.
	ws8.send({ type: "abort" });
	await waitUntil(() => request8.aborted, "room8 provider request aborted by Stop after reattach", 15_000);
	await waitUntil(async () => (await getStatus(room8)).activeThread?.inFlight === false, "room8 stopped turn settled", 20_000);
	const status8 = await getStatus(room8);
	assert(status8.activeThread?.activeTurn?.lastTerminalReason === "cancelled", `a stop after reattach should settle cancelled, got ${JSON.stringify(status8.activeThread?.activeTurn)}`);
	assert(!status8.unseenLandedAnswer, `a stop the user watched must not record an unseen marker, got ${JSON.stringify(status8.unseenLandedAnswer)}`);
	ws8.close();
	ws8 = null;
	await waitUntil(async () => !(await getStatus(room8)).activeLock, "room8 lock released after the stopping session left", 20_000);

	// --- 9. Reattach racing the landing --------------------------------------
	// Two probes into the race window: connect while the LAST chunk is still
	// in flight, and connect the instant the stream finished (the settle is
	// then racing the bind itself). Whichever side wins, exactly one coherent
	// outcome must hold: either the bind adopts the live tail, or it replays a
	// stream that settled mid-bind, or it binds to a settled thread; the
	// answer lands exactly once either way.
	const raceProbes: Array<{ label: string; trigger: (request: GatewayRequest) => boolean }> = [
		{ label: "last chunk in flight", trigger: (request) => request.sent >= SLOW_ANSWER_CHUNKS.length - 1 },
		{ label: "stream just finished", trigger: (request) => request.finished },
	];
	for (const probe of raceProbes) {
		const room9 = await createRoom(`Reattach Race Room ${raceProbes.indexOf(probe) + 1}`);
		const conv9 = `smokeconv9_${Date.now().toString(36)}`;
		await putThread(room9, conv9, []);
		ws9 = await WsHarness.connect(room9, conv9);
		await ws9.waitFor((frame) => frame.type === "ready", "room9 ready frame");
		const requestsBefore9 = gatewayRequests.length;
		ws9.send({ type: "prompt", text: `Race the landing. ${SLOW_MARKER}` });
		await ws9.waitFor((frame) => deltaText(frame).length > 0, "room9 first delta");
		ws9.close();
		ws9 = null;
		const request9 = gatewayRequests.slice(requestsBefore9).find((row) => row.slow)!;
		await waitUntil(() => probe.trigger(request9), `room9 race trigger (${probe.label})`, 30_000);
		ws9 = await WsHarness.connect(room9, conv9);
		await ws9.waitFor((frame) => frame.type === "ready", "room9 race ready frame");
		await waitUntil(async () => (await getStatus(room9)).activeThread?.inFlight === false, "room9 race turn settled", 30_000);
		await waitUntil(async () => {
			const thread = await getThread(room9, conv9);
			return (thread.items ?? []).some((item: any) => String(item.id ?? "").startsWith("detached-assistant-"));
		}, "room9 landing written", 20_000);
		const thread9 = await getThread(room9, conv9);
		const assistants9 = (thread9.items ?? []).filter((item: any) => item.kind === "assistant");
		assert(assistants9.length === 1 && assistants9[0].text === expectedText, `the race must land the answer exactly once, got ${JSON.stringify(assistants9.map((item: any) => [item.id, String(item.text).slice(0, 40)]))}`);
		const reattach9 = ws9.frames.findIndex((frame) => frame.type === "turn_reattach");
		if (reattach9 >= 0) {
			// The bind won a claim: whether it adopted the live tail or replayed
			// a stream that settled mid-bind, the frames carry the whole answer
			// exactly once and reach the turn's terminal frame.
			await ws9.waitFor((frame) => frame.type === "event" && frame.event?.type === "agent_end", "room9 race stream reaches the turn end", reattach9, 20_000);
			const joined9 = joinedDeltas(ws9.frames, reattach9);
			assert(joined9.trim() === expectedText, `the raced replay must carry the whole answer with no gap, got ${JSON.stringify(joined9.slice(0, 120))}`);
			assert(countOccurrences(joined9, "slow part 1. ") === 1, `the raced replay must not duplicate text, got ${JSON.stringify(joined9.slice(0, 160))}`);
			console.log(`  race branch (${probe.label}): reattach (settled=${JSON.stringify(ws9.frames[reattach9].settled)})`);
		} else {
			// The landing beat the connect entirely: an ordinary bind onto the
			// settled thread, whose file already carries the landed answer.
			console.log(`  race branch (${probe.label}): landing won before the bind`);
		}
		const status9 = await getStatus(room9);
		assert(!status9.unseenLandedAnswer, `no unseen marker may survive a session inside the room, got ${JSON.stringify(status9.unseenLandedAnswer)}`);
		ws9.close();
		ws9 = null;
		await waitUntil(async () => !(await getStatus(room9)).activeLock, "room9 lock released after the racing session left", 20_000);
	}

	// --- 10. Displacement: a second reattach takes over cleanly ---------------
	// A detaches, B adopts and streams, C connects for the same conversation:
	// C wins the claim (ordinary web-over-web takeover), B is TOLD it was
	// displaced (never a frozen spinner), B's Stop loses authority over the
	// turn (claimant-checked), and C streams the whole answer to completion.
	const room10 = await createRoom("Reattach Displace Room");
	const conv10 = `smokeconv10_${Date.now().toString(36)}`;
	await putThread(room10, conv10, []);
	ws10a = await WsHarness.connect(room10, conv10);
	await ws10a.waitFor((frame) => frame.type === "ready", "room10 ready frame");
	const requestsBefore10 = gatewayRequests.length;
	ws10a.send({ type: "prompt", text: `Three windows walk into a room. ${SLOW_MARKER}` });
	await ws10a.waitFor((frame) => deltaText(frame).length > 0, "room10 first delta");
	ws10a.close();
	ws10a = null;
	await new Promise((resolve) => setTimeout(resolve, 300));
	ws10b = await WsHarness.connect(room10, conv10);
	await ws10b.waitFor((frame) => frame.type === "ready", "room10 first reattach ready");
	await ws10b.waitFor((frame) => frame.type === "turn_reattach", "room10 first reattach frame");
	await ws10b.waitFor((frame) => deltaText(frame).includes("slow part 3. "), "room10 first adopter receives live deltas");
	ws10c = await WsHarness.connect(room10, conv10);
	await ws10c.waitFor((frame) => frame.type === "ready", "room10 second reattach ready");
	const reattach10c = await ws10c.waitFor((frame) => frame.type === "turn_reattach", "room10 second reattach frame");
	assert(ws10c.frames[reattach10c].settled === false, `the takeover reattach should be live, got ${JSON.stringify(ws10c.frames[reattach10c].settled)}`);
	// B is actively told; silence would freeze its window busy forever.
	const displacedIndex = await ws10b.waitFor((frame) => frame.type === "error" && frame.code === "room_displaced", "displacement signal to the first adopter", 0, 10_000);
	assert(String(ws10b.frames[displacedIndex].message).includes("This room is now open in another window."), `the displacement message should be honest, got ${JSON.stringify(ws10b.frames[displacedIndex].message)}`);
	const framesAfterDisplacement = ws10b.frames.length;
	// B's Stop no longer reaches the turn C is watching.
	ws10b.send({ type: "abort" });
	await new Promise((resolve) => setTimeout(resolve, 1200));
	const request10 = gatewayRequests.slice(requestsBefore10).find((row) => row.slow)!;
	assert(!request10.aborted, "a displaced session's Stop must NOT abort the stream the new session is watching");
	assert(ws10b.frames.slice(framesAfterDisplacement).every((frame) => deltaText(frame) === ""), "a displaced session must receive no further stream deltas");
	// C watches the whole answer land, exactly once.
	await ws10c.waitFor((frame) => frame.type === "event" && frame.event?.type === "agent_end", "room10 takeover stream reaches the turn end", reattach10c, 40_000);
	const joined10 = joinedDeltas(ws10c.frames, reattach10c);
	assert(joined10.trim() === expectedText, `the takeover session must see the whole answer with no gap, got ${JSON.stringify(joined10.slice(0, 120))}`);
	assert(countOccurrences(joined10, "slow part 1. ") === 1, `the takeover replay must not duplicate text, got ${JSON.stringify(joined10.slice(0, 160))}`);
	assert(request10.finished && !request10.aborted, "the displaced Stop must leave the provider stream to finish");
	const status10 = await getStatus(room10);
	assert(!status10.unseenLandedAnswer, `a landing the takeover session watched must not record an unseen marker, got ${JSON.stringify(status10.unseenLandedAnswer)}`);
	ws10b.close();
	ws10b = null;
	ws10c.close();
	ws10c = null;
	await waitUntil(async () => !(await getStatus(room10)).activeLock, "room10 lock released after both sessions left", 20_000);
	const thread10 = await getThread(room10, conv10);
	const assistants10 = (thread10.items ?? []).filter((item: any) => item.kind === "assistant");
	assert(assistants10.length === 1 && assistants10[0].text === expectedText, `room10 must land the answer exactly once, got ${JSON.stringify(assistants10.map((item: any) => [item.id, String(item.text).slice(0, 40)]))}`);

	// --- 11. Reattach anchor: a missing prompt cannot cost the prior answer --
	// The crash-leave scenario: the thread file carries a COMPLETED earlier
	// exchange, the cooking turn's prompt was never persisted, and that prompt
	// is TEXTUALLY IDENTICAL to the earlier one (the "continue continue"
	// amplifier). The reattach frame must anchor on turn identity (the last
	// persisted item at turn start), and the unwatched landing must keep the
	// earlier answer, restore the missing prompt, and append the new answer
	// after it.
	const room11 = await createRoom("Reattach Anchor Room");
	const conv11 = `smokeconv11_${Date.now().toString(36)}`;
	const repeatedPrompt = `continue please ${SLOW_MARKER}`;
	await putThread(room11, conv11, [
		{ kind: "user", id: "u-prior", text: repeatedPrompt },
		{ kind: "assistant", id: "a-prior-done", text: "The earlier answer, fully finished.", streaming: false },
	]);
	ws11a = await WsHarness.connect(room11, conv11);
	await ws11a.waitFor((frame) => frame.type === "ready", "room11 ready frame");
	ws11a.send({ type: "prompt", text: repeatedPrompt });
	await ws11a.waitFor((frame) => deltaText(frame).length > 0, "room11 first delta");
	// No mid-stream persist: the cooking prompt never reaches the file.
	ws11a.close();
	ws11a = null;
	await new Promise((resolve) => setTimeout(resolve, 300));
	ws11b = await WsHarness.connect(room11, conv11);
	await ws11b.waitFor((frame) => frame.type === "ready", "room11 reattach ready");
	const reattach11 = await ws11b.waitFor((frame) => frame.type === "turn_reattach", "room11 reattach frame");
	assert(ws11b.frames[reattach11].anchorItemId === "a-prior-done", `the reattach must anchor on the last item at turn start, got ${JSON.stringify(ws11b.frames[reattach11].anchorItemId)}`);
	assert(String(ws11b.frames[reattach11].userText ?? "") === repeatedPrompt, `the reattach must carry the cooking prompt, got ${JSON.stringify(ws11b.frames[reattach11].userText)}`);
	// Leave again so the landing runs UNWATCHED, the path that used to delete.
	ws11b.close();
	ws11b = null;
	await waitUntil(async () => {
		const thread = await getThread(room11, conv11);
		return (thread.items ?? []).some((item: any) => String(item.id ?? "").startsWith("detached-assistant-"));
	}, "room11 landing written", 40_000);
	const thread11 = await getThread(room11, conv11);
	const items11: any[] = thread11.items ?? [];
	const priorAnswer = items11.find((item) => item.id === "a-prior-done");
	assert(priorAnswer && priorAnswer.text === "The earlier answer, fully finished.", `the prior completed answer must survive the landing, got ${JSON.stringify(items11.map((item) => item.id))}`);
	assert(items11.some((item) => item.id === "u-prior"), "the prior prompt must survive the landing");
	const restoredUserIndex = items11.findIndex((item) => String(item.id ?? "").startsWith("detached-user-"));
	const landedIndex11 = items11.findIndex((item) => String(item.id ?? "").startsWith("detached-assistant-"));
	const priorAnswerIndex = items11.findIndex((item) => item.id === "a-prior-done");
	assert(restoredUserIndex >= 0 && items11[restoredUserIndex].kind === "user" && items11[restoredUserIndex].text === repeatedPrompt, `the missing prompt must be restored into the landing, got ${JSON.stringify(items11.map((item) => item.id))}`);
	assert(priorAnswerIndex < restoredUserIndex && restoredUserIndex < landedIndex11, `the restored prompt must sit between the prior answer and the landed answer, got ${JSON.stringify(items11.map((item) => item.id))}`);
	assert(items11[landedIndex11].text === expectedText, `the landed answer must carry the full text, got ${JSON.stringify(String(items11[landedIndex11].text).slice(0, 80))}`);
	assert(items11.filter((item) => item.kind === "assistant").length === 2, `exactly the prior and the landed answers must remain, got ${JSON.stringify(items11.map((item) => item.id))}`);

	// --- 12. The mismatched-conversation bounce holds WHILE ADOPTED -----------
	// adopt() clears detachedCookingRooms, but the room-level bounce must not
	// clear with it: a stale connection under a different conversation id would
	// otherwise take the cooking turn's lock over mid-stream. The adopter's
	// stream must not even flinch.
	const room12 = await createRoom("Reattach Gate Room");
	const conv12 = `smokeconv12_${Date.now().toString(36)}`;
	await putThread(room12, conv12, []);
	ws12a = await WsHarness.connect(room12, conv12);
	await ws12a.waitFor((frame) => frame.type === "ready", "room12 ready frame");
	const requestsBefore12 = gatewayRequests.length;
	ws12a.send({ type: "prompt", text: `Guard the door while I answer. ${SLOW_MARKER}` });
	await ws12a.waitFor((frame) => deltaText(frame).length > 0, "room12 first delta");
	ws12a.close();
	ws12a = null;
	await new Promise((resolve) => setTimeout(resolve, 300));
	ws12b = await WsHarness.connect(room12, conv12);
	await ws12b.waitFor((frame) => frame.type === "ready", "room12 reattach ready");
	const reattach12 = await ws12b.waitFor((frame) => frame.type === "turn_reattach", "room12 reattach frame");
	await ws12b.waitFor((frame) => deltaText(frame).includes("slow part 3. "), "room12 adopter receives live deltas", reattach12);
	// While the adopter watches, a different conversation id still bounces.
	ws12x = await WsHarness.connect(room12, `smokeconv12_other_${Date.now().toString(36)}`);
	const bounce12 = await ws12x.waitFor((frame) => frame.type === "error", "room12 mismatched-conversation bounce while adopted");
	assert(ws12x.frames[bounce12].code === "room_cooking", `the while-adopted bounce should carry code room_cooking, got ${JSON.stringify(ws12x.frames[bounce12].code)}`);
	assert(!ws12x.frames.some((frame) => frame.type === "turn_reattach" || frame.type === "ready"), `the bounced connection must get neither ready nor a reattach, got ${JSON.stringify(ws12x.frames.map((frame) => frame.type))}`);
	ws12x.close();
	ws12x = null;
	// The adopter's stream is undisturbed: later chunks keep arriving and the
	// provider request was never touched.
	await ws12b.waitFor((frame) => deltaText(frame).includes("slow part 6. "), "room12 adopter still streaming after the bounce", reattach12, 15_000);
	const request12 = gatewayRequests.slice(requestsBefore12).find((row) => row.slow)!;
	assert(!request12.aborted, "the bounced stale connection must not touch the provider stream");
	const adoptedStatus12 = await getStatus(room12);
	assert(adoptedStatus12.activeLock, "the adopter must still hold the room lock after the bounce");
	// Cleanup: stop the turn and leave.
	ws12b.send({ type: "abort" });
	await waitUntil(async () => (await getStatus(room12)).activeThread?.inFlight === false, "room12 stopped turn settled", 20_000);
	ws12b.close();
	ws12b = null;
	await waitUntil(async () => !(await getStatus(room12)).activeLock, "room12 lock released", 20_000);

	// --- 13. Reattach is opt-in: a pre-#33 client keeps its bounce ------------
	// A client that does not declare the reattach capability would ignore
	// turn_reattach, double-render the replay under its persisted partial, and
	// then persist the duplicated transcript over the clean landing. It must
	// get the pre-#33 room_cooking bounce and NOTHING else; a capable
	// connection for the same conversation still adopts normally afterwards.
	const room13 = await createRoom("Reattach Optin Room");
	const conv13 = `smokeconv13_${Date.now().toString(36)}`;
	await putThread(room13, conv13, []);
	ws13a = await WsHarness.connect(room13, conv13);
	await ws13a.waitFor((frame) => frame.type === "ready", "room13 ready frame");
	const requestsBefore13 = gatewayRequests.length;
	ws13a.send({ type: "prompt", text: `An old tab is watching. ${SLOW_MARKER}` });
	await ws13a.waitFor((frame) => deltaText(frame).length > 0, "room13 first delta");
	ws13a.close();
	ws13a = null;
	await new Promise((resolve) => setTimeout(resolve, 300));
	ws13o = await WsHarness.connect(room13, conv13, { reattach: false });
	const bounce13 = await ws13o.waitFor((frame) => frame.type === "error", "room13 old-client bounce");
	assert(ws13o.frames[bounce13].code === "room_cooking", `the old client should get the room_cooking bounce, got ${JSON.stringify(ws13o.frames[bounce13])}`);
	assert(/finishing a response in the background/.test(String(ws13o.frames[bounce13].message)), `the old-client bounce keeps the pre-#33 copy, got ${JSON.stringify(ws13o.frames[bounce13].message)}`);
	await new Promise((resolve) => setTimeout(resolve, 400));
	assert(!ws13o.frames.some((frame) => frame.type === "ready" || frame.type === "turn_reattach" || frame.type === "event"), `the old client must receive no ready, no reattach and ZERO replay frames, got ${JSON.stringify(ws13o.frames.map((frame) => frame.type))}`);
	ws13o.close();
	ws13o = null;
	const request13 = gatewayRequests.slice(requestsBefore13).find((row) => row.slow)!;
	assert(!request13.aborted, "the old-client bounce must not disturb the cooking stream");
	// A CAPABLE connection still adopts the same turn right afterwards.
	ws13b = await WsHarness.connect(room13, conv13);
	await ws13b.waitFor((frame) => frame.type === "ready", "room13 capable reattach ready");
	await ws13b.waitFor((frame) => frame.type === "turn_reattach", "room13 capable reattach frame");
	ws13b.send({ type: "abort" });
	await waitUntil(async () => (await getStatus(room13)).activeThread?.inFlight === false, "room13 stopped turn settled", 20_000);
	ws13b.close();
	ws13b = null;
	await waitUntil(async () => !(await getStatus(room13)).activeLock, "room13 lock released", 20_000);

	// --- 14. Settle during bind: the raced session keeps its lock -------------
	// The previously-unpinned middle branch of the landing race, made
	// deterministic with the test-only bind delay: the connection claims the
	// cooking turn, the turn settles while the bind is (artificially) slow,
	// and phase two replays the finished stream. The settle must NOT release
	// the mid-bind claimant's lock: it continues as an ordinary live session
	// and must still hold the room when the replay lands.
	const room14 = await createRoom("Reattach Bindrace Room");
	const conv14 = `smokeconv14_${Date.now().toString(36)}`;
	await putThread(room14, conv14, []);
	ws14a = await WsHarness.connect(room14, conv14);
	await ws14a.waitFor((frame) => frame.type === "ready", "room14 ready frame");
	const requestsBefore14 = gatewayRequests.length;
	ws14a.send({ type: "prompt", text: `Finish while I bind. ${SLOW_MARKER}` });
	await ws14a.waitFor((frame) => deltaText(frame).length > 0, "room14 first delta");
	ws14a.close();
	ws14a = null;
	const request14 = gatewayRequests.slice(requestsBefore14).find((row) => row.slow)!;
	await waitUntil(() => request14.sent >= SLOW_ANSWER_CHUNKS.length - 1, "room14 stream almost finished", 30_000);
	ws14b = await WsHarness.connect(room14, conv14, { extraParams: "&testBindDelayMs=2500" });
	await ws14b.waitFor((frame) => frame.type === "ready", "room14 raced ready frame");
	const reattach14 = await ws14b.waitFor((frame) => frame.type === "turn_reattach", "room14 raced reattach frame", 0, 15_000);
	assert(ws14b.frames[reattach14].settled === true, `the settle must have beaten this bind (deterministic via the delay), got ${JSON.stringify(ws14b.frames[reattach14].settled)}`);
	await ws14b.waitFor((frame) => frame.type === "event" && frame.event?.type === "agent_end", "room14 settled replay reaches the turn end", reattach14, 15_000);
	const joined14 = joinedDeltas(ws14b.frames, reattach14);
	assert(joined14.trim() === expectedText, `the settled replay must carry the whole answer, got ${JSON.stringify(joined14.slice(0, 120))}`);
	assert(countOccurrences(joined14, "slow part 1. ") === 1, `the settled replay must not duplicate text, got ${JSON.stringify(joined14.slice(0, 160))}`);
	// THE LOCK ORDERING ASSERTION: the settle that raced this bind ran with a
	// live mid-bind claimant and must have left that claimant's lock alone.
	const status14 = await getStatus(room14);
	assert(status14.activeThread?.inFlight === false, `room14 turn should be settled, got ${JSON.stringify(status14.activeThread?.activeTurn)}`);
	assert(status14.activeLock, "the settle that raced this bind must NOT release the live session's room lock");
	assert(!status14.unseenLandedAnswer, `the raced session watched the replay; no unseen marker may remain, got ${JSON.stringify(status14.unseenLandedAnswer)}`);
	const thread14 = await getThread(room14, conv14);
	const assistants14 = (thread14.items ?? []).filter((item: any) => item.kind === "assistant");
	assert(assistants14.length === 1 && assistants14[0].text === expectedText, `room14 must land the answer exactly once, got ${JSON.stringify(assistants14.map((item: any) => [item.id, String(item.text).slice(0, 40)]))}`);
	ws14b.close();
	ws14b = null;
	await waitUntil(async () => !(await getStatus(room14)).activeLock, "room14 lock released after the session left", 20_000);

	// --- 15. Replay-buffer lifecycle: released at settle, capped on overflow --
	const room15 = await createRoom("Reattach Buffer Room");
	const conv15 = `smokeconv15_${Date.now().toString(36)}`;
	await putThread(room15, conv15, []);
	const bufferStats = async (roomId: string): Promise<{ frames: number; bytes: number; overflowed: boolean }> => {
		const response = await requestJson(`/api/persistent-agents/${roomId}/reattach-buffer-stats`);
		assert(response.status === 200, `buffer stats should return 200, got ${response.status}`);
		return response.body;
	};
	// 15a: an ORDINARY completed turn on a connection that stays attached must
	// release its replay buffer at settle, not hold it until the next prompt.
	ws15a = await WsHarness.connect(room15, conv15);
	await ws15a.waitFor((frame) => frame.type === "ready", "room15 ready frame");
	ws15a.send({ type: "prompt", text: "Just answer quickly please." });
	await ws15a.waitFor((frame) => frame.type === "event" && frame.event?.type === "agent_end", "room15 ordinary turn end");
	await waitUntil(async () => {
		const stats = await bufferStats(room15);
		return stats.frames === 0 && stats.bytes === 0;
	}, "room15 replay buffer released after the ordinary turn settled", 10_000);
	const statsMidBuffer = await bufferStats(room15);
	assert(statsMidBuffer.overflowed === false, `an ordinary turn must not mark overflow, got ${JSON.stringify(statsMidBuffer)}`);
	ws15a.close();
	ws15a = null;
	await waitUntil(async () => !(await getStatus(room15)).activeLock, "room15 lock released", 20_000);
	// 15b: a turn that overflows the cap frees the buffer immediately, and a
	// reattach degrades to the honest bounce instead of a truncated replay;
	// the landing still carries the whole answer.
	const room15b = await createRoom("Reattach Overflow Room");
	const conv15b = `smokeconv15b_${Date.now().toString(36)}`;
	await putThread(room15b, conv15b, []);
	ws15b = await WsHarness.connect(room15b, conv15b);
	await ws15b.waitFor((frame) => frame.type === "ready", "room15b ready frame");
	const requestsBefore15 = gatewayRequests.length;
	ws15b.send({ type: "prompt", text: `Stream something enormous. ${BIG_MARKER}` });
	await ws15b.waitFor((frame) => deltaText(frame).length > 0, "room15b first big delta");
	ws15b.close();
	ws15b = null;
	const request15 = gatewayRequests.slice(requestsBefore15).find((row) => row.slow)!;
	await waitUntil(async () => (await bufferStats(room15b)).overflowed === true, "room15b replay buffer overflowed the cap", 15_000);
	const overflowStats = await bufferStats(room15b);
	assert(overflowStats.frames === 0, `overflow must free the buffer immediately, got ${JSON.stringify(overflowStats)}`);
	assert(!request15.finished, "the overflow assertion must land while the big turn still cooks");
	// A capable reattach now bounces honestly rather than replaying a gap.
	ws15c = await WsHarness.connect(room15b, conv15b);
	const bounce15 = await ws15c.waitFor((frame) => frame.type === "error", "room15b overflow bounce");
	assert(ws15c.frames[bounce15].code === "room_cooking", `the overflow bounce should carry code room_cooking, got ${JSON.stringify(ws15c.frames[bounce15])}`);
	assert(!ws15c.frames.some((frame) => frame.type === "turn_reattach" || frame.type === "event"), `an overflow reattach must replay nothing, got ${JSON.stringify(ws15c.frames.map((frame) => frame.type))}`);
	ws15c.close();
	ws15c = null;
	// The answer still lands whole, and the buffer stays free after settle.
	const expectedBig = BIG_ANSWER_CHUNKS.join("").trim();
	await waitUntil(async () => {
		const thread = await getThread(room15b, conv15b);
		return (thread.items ?? []).some((item: any) => String(item.id ?? "").startsWith("detached-assistant-"));
	}, "room15b landing written despite the overflow", 30_000);
	const thread15 = await getThread(room15b, conv15b);
	const landed15 = (thread15.items ?? []).find((item: any) => String(item.id ?? "").startsWith("detached-assistant-"));
	assert(landed15?.text === expectedBig, `the overflow landing must carry the whole big answer, got ${JSON.stringify(String(landed15?.text ?? "").slice(0, 60))}... (${String(landed15?.text ?? "").length} chars)`);
	const settledStats15 = await bufferStats(room15b);
	assert(settledStats15.frames === 0 && settledStats15.bytes === 0, `the buffer must stay free after the overflow turn settled, got ${JSON.stringify(settledStats15)}`);
	await waitUntil(async () => !(await getStatus(room15b)).activeLock, "room15b lock released after the landing", 20_000);

	// --- 16. Overflow AND settle inside the claim-to-adopt window -------------
	// The claim passes while the turn is under the cap and still cooking; the
	// widened bind window then sees the turn BOTH overflow the cap and settle.
	// A settled adoption would replay the freed (empty) buffer, superseding
	// the client's partial with nothing, so the phase-two guard must degrade
	// to the honest bounce and the thread file must keep the landed answer.
	const room16 = await createRoom("Reattach Overflow Race Room");
	const conv16 = `smokeconv16_${Date.now().toString(36)}`;
	await putThread(room16, conv16, []);
	ws16a = await WsHarness.connect(room16, conv16);
	await ws16a.waitFor((frame) => frame.type === "ready", "room16 ready frame");
	const requestsBefore16 = gatewayRequests.length;
	ws16a.send({ type: "prompt", text: `Enormous and racing. ${BIG_MARKER}` });
	await ws16a.waitFor((frame) => deltaText(frame).length > 0, "room16 first big delta");
	ws16a.close();
	ws16a = null;
	// Claim BEFORE the overflow (~chunk 4 of 10); the 4.5s bind delay spans
	// both the overflow and the settle (stream ends around 4s).
	await new Promise((resolve) => setTimeout(resolve, 200));
	ws16b = await WsHarness.connect(room16, conv16, { extraParams: "&testBindDelayMs=4500" });
	await ws16b.waitFor((frame) => frame.type === "ready", "room16 raced ready frame");
	const bounce16 = await ws16b.waitFor((frame) => frame.type === "error", "room16 overflow-then-settle bounce", 0, 20_000);
	assert(ws16b.frames[bounce16].code === "room_cooking", `the overflow-then-settle window should bounce with room_cooking, got ${JSON.stringify(ws16b.frames[bounce16])}`);
	assert(!ws16b.frames.some((frame) => frame.type === "turn_reattach"), `no reattach frame may ride an unreplayable settled turn, got ${JSON.stringify(ws16b.frames.map((frame) => frame.type))}`);
	assert(!ws16b.frames.some((frame) => frame.type === "event"), `an empty settled replay must never be delivered, got ${JSON.stringify(ws16b.frames.map((frame) => frame.type))}`);
	ws16b.close();
	ws16b = null;
	const request16 = gatewayRequests.slice(requestsBefore16).find((row) => row.slow)!;
	assert(request16.finished && !request16.aborted, "room16's big turn must have finished on its own");
	// The landing survived the whole dance.
	const expectedBig16 = BIG_ANSWER_CHUNKS.join("").trim();
	const thread16 = await getThread(room16, conv16);
	const landed16 = (thread16.items ?? []).find((item: any) => String(item.id ?? "").startsWith("detached-assistant-"));
	assert(landed16?.text === expectedBig16, `the landed answer must survive the bounced raced bind, got ${String(landed16?.text ?? "").length} chars`);
	await waitUntil(async () => !(await getStatus(room16)).activeLock, "room16 lock released after the bounced bind closed", 20_000);

	// --- 17. A claim takeover during another claimant's bind is told ----------
	// The third displacement variant: C2 claims and is still binding (widened
	// via the test delay) when C3 claims. C2 must receive room_displaced and
	// never a silent ordinary bind, and C3 must adopt and stream undisturbed.
	const room17 = await createRoom("Reattach Midbind Room");
	const conv17 = `smokeconv17_${Date.now().toString(36)}`;
	await putThread(room17, conv17, []);
	ws17a = await WsHarness.connect(room17, conv17);
	await ws17a.waitFor((frame) => frame.type === "ready", "room17 ready frame");
	const requestsBefore17 = gatewayRequests.length;
	ws17a.send({ type: "prompt", text: `Two rivals mid-bind. ${SLOW_MARKER}` });
	await ws17a.waitFor((frame) => deltaText(frame).length > 0, "room17 first delta");
	ws17a.close();
	ws17a = null;
	await new Promise((resolve) => setTimeout(resolve, 300));
	// C2 claims and is held mid-bind by the test delay.
	ws17b = await WsHarness.connect(room17, conv17, { extraParams: "&testBindDelayMs=3500" });
	await ws17b.waitFor((frame) => frame.type === "ready", "room17 mid-bind claimant ready");
	await new Promise((resolve) => setTimeout(resolve, 500));
	// C3 claims while C2 is still inside its bind window, then adopts.
	ws17c = await WsHarness.connect(room17, conv17);
	await ws17c.waitFor((frame) => frame.type === "ready", "room17 takeover ready");
	const reattach17 = await ws17c.waitFor((frame) => frame.type === "turn_reattach", "room17 takeover reattach frame");
	assert(ws17c.frames[reattach17].settled === false, `the takeover should adopt the live turn, got ${JSON.stringify(ws17c.frames[reattach17].settled)}`);
	// C2 is actively told, and never silently becomes an ordinary session.
	const displaced17 = await ws17b.waitFor((frame) => frame.type === "error" && frame.code === "room_displaced", "displacement signal to the mid-bind claimant", 0, 10_000);
	assert(String(ws17b.frames[displaced17].message).includes("This room is now open in another window."), `the mid-bind displacement message should be honest, got ${JSON.stringify(ws17b.frames[displaced17].message)}`);
	assert(!ws17b.frames.some((frame) => frame.type === "turn_reattach"), `a displaced mid-bind claimant must never receive a reattach, got ${JSON.stringify(ws17b.frames.map((frame) => frame.type))}`);
	assert(!ws17b.frames.some((frame) => frame.type === "event"), `a displaced mid-bind claimant must never stream as a silent ordinary session, got ${JSON.stringify(ws17b.frames.map((frame) => frame.type))}`);
	ws17b.close();
	ws17b = null;
	// C3 watches the whole answer land, exactly once, with the lock held.
	await ws17c.waitFor((frame) => frame.type === "event" && frame.event?.type === "agent_end", "room17 takeover stream reaches the turn end", reattach17, 40_000);
	const joined17 = joinedDeltas(ws17c.frames, reattach17);
	assert(joined17.trim() === expectedText, `the takeover session must see the whole answer, got ${JSON.stringify(joined17.slice(0, 120))}`);
	assert(countOccurrences(joined17, "slow part 1. ") === 1, `the takeover replay must not duplicate text, got ${JSON.stringify(joined17.slice(0, 160))}`);
	const request17 = gatewayRequests.slice(requestsBefore17).find((row) => row.slow)!;
	assert(request17.finished && !request17.aborted, "room17's stream must finish untouched by the displaced claimant");
	const status17 = await getStatus(room17);
	assert(status17.activeLock, "the takeover session must hold the room lock");
	assert(!status17.unseenLandedAnswer, `a landing the takeover watched must not record a marker, got ${JSON.stringify(status17.unseenLandedAnswer)}`);
	ws17c.close();
	ws17c = null;
	await waitUntil(async () => !(await getStatus(room17)).activeLock, "room17 lock released after the takeover left", 20_000);
	const thread17 = await getThread(room17, conv17);
	const assistants17 = (thread17.items ?? []).filter((item: any) => item.kind === "assistant");
	assert(assistants17.length === 1 && assistants17[0].text === expectedText, `room17 must land the answer exactly once, got ${JSON.stringify(assistants17.map((item: any) => [item.id, String(item.text).slice(0, 40)]))}`);

	// --- 18. The landing cut drops post-anchor tool chips too -----------------
	// A tool chip persisted mid-turn can never resolve after the landing (its
	// toolCallId died with the connection that ran it); the unwatched landing
	// must drop it like the client's supersede does, while everything before
	// the anchor survives.
	const room18 = await createRoom("Reattach Toolcut Room");
	const conv18 = `smokeconv18_${Date.now().toString(36)}`;
	const prompt18 = `Use your tools please. ${SLOW_MARKER}`;
	await putThread(room18, conv18, [
		{ kind: "user", id: "u-prior-18", text: "An earlier question." },
		{ kind: "assistant", id: "a-prior-18", text: "An earlier finished answer.", streaming: false },
	]);
	ws18 = await WsHarness.connect(room18, conv18);
	await ws18.waitFor((frame) => frame.type === "ready", "room18 ready frame");
	ws18.send({ type: "prompt", text: prompt18 });
	await ws18.waitFor((frame) => deltaText(frame).length > 0, "room18 first delta");
	// The client's mid-stream persist: prompt, a running tool chip, a partial.
	const midPut18 = await putThread(room18, conv18, [
		{ kind: "user", id: "u-prior-18", text: "An earlier question." },
		{ kind: "assistant", id: "a-prior-18", text: "An earlier finished answer.", streaming: false },
		{ kind: "user", id: "u-18", text: prompt18 },
		{ kind: "tool", id: "t-stale-18", name: "kb_search", args: {}, status: "running" },
		{ kind: "assistant", id: "a-18-partial", text: "slow part 1. ", streaming: true },
	]);
	assert(midPut18.status === 200, `room18 mid-stream persist should succeed, got ${midPut18.status}: ${JSON.stringify(midPut18.body)}`);
	ws18.close();
	ws18 = null;
	await waitUntil(async () => {
		const thread = await getThread(room18, conv18);
		return (thread.items ?? []).some((item: any) => String(item.id ?? "").startsWith("detached-assistant-"));
	}, "room18 landing written", 40_000);
	const thread18 = await getThread(room18, conv18);
	const items18: any[] = thread18.items ?? [];
	assert(!items18.some((item) => item.id === "t-stale-18"), `the landed transcript must not keep the unresolvable tool chip, got ${JSON.stringify(items18.map((item) => item.id))}`);
	assert(!items18.some((item) => item.id === "a-18-partial"), "the partial must be superseded by the landing");
	assert(items18.some((item) => item.id === "u-18"), "the persisted prompt must survive the landing");
	const prior18 = items18.find((item) => item.id === "a-prior-18");
	assert(prior18 && prior18.text === "An earlier finished answer.", `the earlier answer must survive the tool cut, got ${JSON.stringify(items18.map((item) => item.id))}`);
	const landed18 = items18.find((item) => String(item.id ?? "").startsWith("detached-assistant-"));
	assert(landed18?.text === expectedText, `the landed answer must carry the full text, got ${JSON.stringify(String(landed18?.text ?? "").slice(0, 60))}`);
	assert(items18.filter((item) => item.kind === "assistant").length === 2, `exactly the prior and the landed answers must remain, got ${JSON.stringify(items18.map((item) => item.id))}`);
	assert(!items18.some((item) => String(item.id ?? "").startsWith("detached-user-")), "no prompt restore is needed when the prompt was persisted");
	await waitUntil(async () => !(await getStatus(room18)).activeLock, "room18 lock released after the landing", 20_000);

	console.log("persistent-room detached turn smoke passed");
} catch (error) {
	const output = serverOutput.join("").trim();
	if (output) console.error(output.split("\n").slice(-80).join("\n"));
	console.error(error instanceof Error ? error.stack || error.message : error);
	console.error(`temp HOME preserved for inspection: ${tempHome}`);
	process.exitCode = 1;
} finally {
	try { ws?.close(); } catch {}
	try { ws2?.close(); } catch {}
	try { ws3?.close(); } catch {}
	try { ws4?.close(); } catch {}
	try { wsOther?.close(); } catch {}
	try { ws5?.close(); } catch {}
	try { ws6?.close(); } catch {}
	try { ws7?.close(); } catch {}
	try { ws8?.close(); } catch {}
	try { ws9?.close(); } catch {}
	try { ws10a?.close(); } catch {}
	try { ws10b?.close(); } catch {}
	try { ws10c?.close(); } catch {}
	try { ws11a?.close(); } catch {}
	try { ws11b?.close(); } catch {}
	try { ws12a?.close(); } catch {}
	try { ws12b?.close(); } catch {}
	try { ws12x?.close(); } catch {}
	try { ws13a?.close(); } catch {}
	try { ws13o?.close(); } catch {}
	try { ws13b?.close(); } catch {}
	try { ws14a?.close(); } catch {}
	try { ws14b?.close(); } catch {}
	try { ws15a?.close(); } catch {}
	try { ws15b?.close(); } catch {}
	try { ws15c?.close(); } catch {}
	try { ws16a?.close(); } catch {}
	try { ws16b?.close(); } catch {}
	try { ws17a?.close(); } catch {}
	try { ws17b?.close(); } catch {}
	try { ws17c?.close(); } catch {}
	try { ws18?.close(); } catch {}
	await stopSmokeServer(server ?? undefined);
	gateway.close();
	if (process.exitCode == null || process.exitCode === 0) {
		fs.rmSync(tempHome, { recursive: true, force: true });
	}
}
