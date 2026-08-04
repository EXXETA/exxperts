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
const SLOW_ANSWER_CHUNKS = Array.from({ length: 10 }, (_, i) => `slow part ${i + 1}. `);
const HANG_ANSWER_CHUNKS = ["Hang part 1. "];
const FAST_ANSWER_CHUNKS = ["Quick ", "answer."];
const SLOW_CHUNK_DELAY_MS = 400;
// Watchdog override for section 6. Must comfortably exceed section 1's
// post-disconnect stream time (~9 chunks x 400ms), or the watchdog would kill
// the legitimately-finishing detached turn the smoke is there to prove.
const DETACHED_DEADLINE_OVERRIDE_MS = 6000;

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

// ---------------------------------------------------------------------------
// Synthetic OpenAI-compatible gateway (same rig as consult-streaming-smoke):
// bodies carrying SLOW_MARKER stream slowly for a deterministic in-flight
// window; every request records whether the CLIENT (the server's provider
// call) aborted it mid-stream or let it finish.
// ---------------------------------------------------------------------------
type GatewayRequest = { model: string; slow: boolean; hang: boolean; aborted: boolean; finished: boolean };
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
		const record: GatewayRequest = { model, slow, hang, aborted: false, finished: false };
		gatewayRequests.push(record);
		res.on("close", () => { if (!res.writableFinished) record.aborted = true; });

		const chunks = hang ? HANG_ANSWER_CHUNKS : slow ? SLOW_ANSWER_CHUNKS : FAST_ANSWER_CHUNKS;
		res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
		const base = { id: `cmpl_${gatewayRequests.length}`, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model };
		res.write(sseChunk({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }] }));
		let index = 0;
		const writeNext = () => {
			if (record.aborted || res.destroyed) return;
			if (index < chunks.length) {
				res.write(sseChunk({ ...base, choices: [{ index: 0, delta: { content: chunks[index] }, finish_reason: null }] }));
				index += 1;
				setTimeout(writeNext, slow || hang ? SLOW_CHUNK_DELAY_MS : 0);
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

	static async connect(persistentAgentId: string, conversationId: string): Promise<WsHarness> {
		const socket = new WebSocketImpl(`ws://127.0.0.1:${port}/ws?persistentAgentId=${persistentAgentId}&conversationId=${conversationId}&modelProvider=openai-compatible&model=room-model`, { headers: { ...SMOKE_AUTH_HEADERS } });
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

	// --- 2. While cooking: lock held, honest bounce message ------------------
	await new Promise((resolve) => setTimeout(resolve, 400));
	const slowRequest = gatewayRequests.find((request) => request.slow)!;
	assert(!slowRequest.aborted, "the provider stream must NOT be aborted by the disconnect");
	ws2 = await WsHarness.connect(roomId, conversationId);
	const bounceIndex = await ws2.waitFor((frame) => frame.type === "error", "busy bounce while cooking");
	assert(/finishing a response in the background/.test(String(ws2.frames[bounceIndex].message)), `bounce should name the background response, got: ${ws2.frames[bounceIndex].message}`);
	// The machine-readable code is the client's detach-vs-death signal: it
	// rewrites the "connection was lost" note honestly and stands its
	// reconnect loop down instead of burning attempts against this bounce.
	assert(ws2.frames[bounceIndex].code === "room_cooking", `bounce should carry code room_cooking, got: ${JSON.stringify(ws2.frames[bounceIndex].code)}`);
	ws2.close();
	ws2 = null;

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
	await stopSmokeServer(server ?? undefined);
	gateway.close();
	if (process.exitCode == null || process.exitCode === 0) {
		fs.rmSync(tempHome, { recursive: true, force: true });
	}
}
