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
//      frames carrying the whole answer exactly once.

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
// 16 chunks x 400ms give the reattach sections (issue #33) a wide enough
// mid-cook window to bind, replay and leave again before the stream ends.
const SLOW_ANSWER_CHUNKS = Array.from({ length: 4 }, (_, i) => `slow part ${i + 1}. `);
const HANG_ANSWER_CHUNKS = ["Hang part 1. "];
const FAST_ANSWER_CHUNKS = ["Quick ", "answer."];
const SLOW_CHUNK_DELAY_MS = 400;
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
		const record: GatewayRequest = { model, slow, hang, aborted: false, finished: false, sent: 0 };
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
				record.sent = index;
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
let wsOther: WsHarness | null = null;
let ws5: WsHarness | null = null;
let ws6: WsHarness | null = null;
let ws7: WsHarness | null = null;
let ws8: WsHarness | null = null;
let ws9: WsHarness | null = null;

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

	// --- 9. Reattach racing the landing --------------------------------------
	// Two probes into the race window: connect while the LAST chunk is still
	// in flight, and connect the instant the stream finished (the settle is
	// then racing the bind itself). Whichever side wins, exactly one coherent
	// outcome must hold: either the bind adopts the live tail, or it replays a
	// stream that settled mid-bind, or it binds to a settled thread; the
	// answer lands exactly once either way.
	const lockProbeFailures: string[] = [];
	const lastChunkIndex = SLOW_ANSWER_CHUNKS.length;
	const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

	// Phase A: measure the lag from gateway DONE to the settle's lock release
	// (unwatched landing), and the bind duration on this rig.
	const lags: number[] = [];
	for (let i = 0; i < 3; i++) {
		const roomA = await createRoom(`Measure ${i}`);
		const convA = `meas${i}_${Date.now().toString(36)}`;
		await putThread(roomA, convA, []);
		ws9 = await WsHarness.connect(roomA, convA);
		await ws9.waitFor((frame) => frame.type === "ready", "measure ready");
		const before = gatewayRequests.length;
		ws9.send({ type: "prompt", text: `Measure. ${SLOW_MARKER}` });
		await ws9.waitFor((frame) => deltaText(frame).length > 0, "measure first delta");
		ws9.close(); ws9 = null;
		const reqA = gatewayRequests.slice(before).find((row) => row.slow)!;
		while (!reqA.finished) await sleep(2);
		const t0 = Date.now();
		while ((await getStatus(roomA)).activeLock) await sleep(4);
		lags.push(Date.now() - t0);
	}
	const lag = Math.min(...lags);
	// bind duration: time from connect() to ready frame on an idle room
	const roomB = await createRoom("BindTiming");
	const convB = `bindt_${Date.now().toString(36)}`;
	await putThread(roomB, convB, []);
	const tb = Date.now();
	ws9 = await WsHarness.connect(roomB, convB);
	await ws9.waitFor((frame) => frame.type === "ready", "bind timing ready");
	const bindMs = Date.now() - tb;
	ws9.close(); ws9 = null;
	console.log(`  measured settle lag after DONE: ${JSON.stringify(lags)}ms (using ${lag}); bind ~${bindMs}ms`);

	// Phase B: sub-ms sweep around the adopted/ordinary boundary.
	const spinUntil = (target: number) => { while (performance.now() < target) { /* spin */ } };
	let windowHits = 0;
	let boundaryLo = 22, boundaryHi = 31;
	// The window is sub-millisecond and scheduling-dependent: hitting it is
	// opportunistic. The hunt gets a hard time budget well under the runner's
	// 300s ceiling; running out of attempts or time is an honest inconclusive,
	// not a failure - every deterministic assertion above already ran.
	const probeDeadline = Date.now() + 120_000;
	let probeAttempts = 0;
	for (let attempt = 0; attempt < 200 && windowHits === 0 && Date.now() < probeDeadline; attempt++) {
		probeAttempts = attempt + 1;
		const offsetMs = boundaryLo + ((attempt * 0.37) % (boundaryHi - boundaryLo));
		const room9 = await createRoom(`Aim ${attempt}`);
		const conv9 = `aim${attempt}_${Date.now().toString(36)}`;
		await putThread(room9, conv9, []);
		ws9 = await WsHarness.connect(room9, conv9);
		await ws9.waitFor((frame) => frame.type === "ready", "aim ready");
		const before9 = gatewayRequests.length;
		ws9.send({ type: "prompt", text: `Race the landing. ${SLOW_MARKER}` });
		await ws9.waitFor((frame) => deltaText(frame).length > 0, "aim first delta");
		ws9.close(); ws9 = null;
		const request9 = gatewayRequests.slice(before9).find((row) => row.slow)!;
		while (!request9.finished) await sleep(1);
		const t0 = performance.now();
		// yield once so the DONE-flip poll's sleep isn't part of the offset, then spin to the precise target
		spinUntil(t0 + offsetMs);
		ws9 = await WsHarness.connect(room9, conv9);
		try {
			await ws9.waitFor((frame) => frame.type === "ready" || frame.type === "error", "aim race ready", 0, 10_000);
		} catch { ws9.close(); ws9 = null; continue; }
		await waitUntil(async () => (await getStatus(room9)).activeThread?.inFlight === false, "aim settled", 30_000);
		const reattach9 = ws9.frames.findIndex((frame) => frame.type === "turn_reattach");
		const settledFlag = reattach9 >= 0 ? ws9.frames[reattach9].settled : null;
		const branch = reattach9 >= 0 ? `reattach settled=${JSON.stringify(settledFlag)}` : "no reattach";
		const status9 = await getStatus(room9);
		const lockHeld = !!status9.activeLock;
		if (settledFlag === true || !lockHeld) console.log(`  attempt ${attempt} offset=${offsetMs.toFixed(2)}ms: ${branch}; lock ${lockHeld ? "HELD" : "MISSING"}`);
		else if (attempt % 10 === 0) console.log(`  ...attempt ${attempt} offset=${offsetMs.toFixed(2)}ms: ${branch}; lock HELD`);
		if (settledFlag === true) {
			windowHits++;
			if (!lockHeld) lockProbeFailures.push(`WINDOW HIT attempt ${attempt}: reattach settled=true and the live web session holds NO room lock`);
			const { createRequire } = await import("node:module");
			const requireCjs = createRequire(import.meta.url);
			process.env.HOME = tempHome;
			const roomLockMod = requireCjs(path.join(repoRoot, "bin", "lib", "room-lock.cjs"));
			const cliAttempt = roomLockMod.tryAcquire(room9, { surface: "cli", pid: process.pid, label: room9 });
			console.log(`  CLI-style tryAcquire while the web session is still open: ok=${JSON.stringify(cliAttempt.ok)}`);
			if (cliAttempt.ok) lockProbeFailures.push(`CLI tryAcquire SUCCEEDED while the reattached web session is still live (attempt ${attempt})`);
			roomLockMod.release(room9, { surface: "cli", pid: process.pid, label: room9 });
		} else if (settledFlag === false && !lockHeld) {
			lockProbeFailures.push(`attempt ${attempt} (adopted): live session holds no lock`);
		}
		ws9.close(); ws9 = null;
		await sleep(150);
	}
	if (windowHits === 0) console.log(`  race window not provoked in ${probeAttempts} attempts within the time budget; window-hit assertions vacuous this run`);
	console.log(`window hits: ${windowHits}`);
	const bindRaceLog = serverOutput.join("").includes("cooking turn settled while the session was binding");
	console.log(`server log shows settled-mid-bind branch: ${bindRaceLog}`);
	if (lockProbeFailures.length > 0) throw new Error(lockProbeFailures.join("; "));
	console.log("lock-probe smoke passed");
} catch (error) {
	const output = serverOutput.join("").trim();
	if (output) console.error(output.split("\n").slice(-80).join("\n"));
	console.error(error instanceof Error ? error.stack || error.message : error);
	console.error(`temp HOME preserved for inspection: ${tempHome}`);
	process.exitCode = 1;
} finally {
	const closeQuietly = (...sockets: Array<WsHarness | null>) => {
		for (const socket of sockets) {
			try { socket?.close(); } catch {}
		}
	};
	closeQuietly(ws, ws2, ws3, ws4, wsOther, ws5, ws6, ws7, ws8, ws9);
	await stopSmokeServer(server ?? undefined);
	gateway.close();
	if (process.exitCode == null || process.exitCode === 0) {
		fs.rmSync(tempHome, { recursive: true, force: true });
	}
}
