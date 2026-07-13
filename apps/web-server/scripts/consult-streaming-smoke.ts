import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import http from "node:http";
import type { AddressInfo } from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SMOKE_SERVER_SPAWN_TREE_OPTIONS, stopSmokeServer } from "./smoke-server-process.js";

// Consult MR-2 end-to-end: the consult_* WebSocket family against a real
// spawned server, with a synthetic OpenAI-compatible SSE gateway standing in
// for the provider. Proves: started/delta/end streaming, the start gate
// (no consult while the room answers), one-consult-at-a-time, run-free
// (prompts process while a consult runs), consult_abort ("stopped by you"),
// socket-close abort reaching the provider, and usage billed to the asking
// room with kind "consult".

const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "exxperts-consult-streaming-home-"));
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const webServerDir = path.resolve(scriptDir, "..");
const repoRoot = path.resolve(webServerDir, "..", "..");
const port = 24000 + Math.floor(Math.random() * 10000);
const baseUrl = `http://127.0.0.1:${port}`;
const agentDir = path.join(tempHome, ".exxperts", "agent");
const productAppRoot = path.join(tempHome, ".exxperts", "app");

const SLOW_MARKER = "SLOW_STREAM_MARKER";
const FAST_ANSWER_CHUNKS = ["From my memory: ", "the pricing decision ", "is X-42."];
const SLOW_ANSWER_CHUNKS = Array.from({ length: 8 }, (_, i) => `slow part ${i + 1}. `);
const ROOM_TURN_CHUNKS = ["Room turn ", "done."];
const SLOW_CHUNK_DELAY_MS = 400;

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

// ---------------------------------------------------------------------------
// Synthetic OpenAI-compatible gateway: POST /v1/chat/completions, SSE chunks.
// Any request whose serialized body carries SLOW_MARKER streams slowly, so the
// smoke gets a deterministic in-flight window for gate/abort tests.
// ---------------------------------------------------------------------------
type GatewayRequest = { model: string; slow: boolean; aborted: boolean; finished: boolean };
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
		const record: GatewayRequest = { model, slow, aborted: false, finished: false };
		gatewayRequests.push(record);
		// res 'close' fires on connection teardown; if the response never
		// finished, the client (the consult worker) aborted mid-stream.
		res.on("close", () => { if (!res.writableFinished) record.aborted = true; });

		const chunks = model === "room-model" ? ROOM_TURN_CHUNKS : slow ? SLOW_ANSWER_CHUNKS : FAST_ANSWER_CHUNKS;
		res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
		const base = { id: `cmpl_${gatewayRequests.length}`, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model };
		res.write(sseChunk({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }] }));
		let index = 0;
		const writeNext = () => {
			if (record.aborted || res.destroyed) return;
			if (index < chunks.length) {
				res.write(sseChunk({ ...base, choices: [{ index: 0, delta: { content: chunks[index] }, finish_reason: null }] }));
				index += 1;
				setTimeout(writeNext, slow ? SLOW_CHUNK_DELAY_MS : 0);
				return;
			}
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

async function requestJson(pathname: string, init?: RequestInit): Promise<{ status: number; body: any }> {
	const response = await fetch(`${baseUrl}${pathname}`, init);
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

/** Prompts require the room's current activeThread: PUT the thread record first (creates the Pi session runtime and activates the thread). */
async function prepareThread(agentId: string, threadId: string): Promise<void> {
	const response = await requestJson(`/api/persistent-agents/${agentId}/threads/${threadId}`, {
		method: "PUT",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ state: "active", origin: "launcher", model: { provider: "openai-compatible", model: "room-model" }, items: [] }),
	});
	assert(response.status === 200, `thread PUT should return 200, got ${response.status}: ${JSON.stringify(response.body)}`);
}

type Frame = Record<string, any>;

// CI runs Node 20, which has no global WebSocket client; fall back to the ws
// package (already present as @fastify/websocket's client library).
const WebSocketImpl: any = (globalThis as any).WebSocket ?? (await import("ws")).default;

class WsHarness {
	readonly frames: Frame[] = [];
	private socket: any;

	private constructor(socket: any) {
		this.socket = socket;
		socket.addEventListener("message", (event) => {
			try { this.frames.push(JSON.parse(String(event.data))); } catch {}
		});
	}

	static async connect(persistentAgentId: string, conversationId: string): Promise<WsHarness> {
		const socket = new WebSocketImpl(`ws://127.0.0.1:${port}/ws?persistentAgentId=${persistentAgentId}&conversationId=${conversationId}&modelProvider=openai-compatible&model=room-model`);
		const harness = new WsHarness(socket);
		await new Promise<void>((resolve, reject) => {
			socket.addEventListener("open", () => resolve());
			socket.addEventListener("error", () => reject(new Error("websocket failed to connect")));
		});
		await harness.waitFor((frame) => frame.type === "ready", "ready frame");
		return harness;
	}

	send(frame: Frame): void {
		this.socket.send(JSON.stringify(frame));
	}

	close(): void {
		try { this.socket.close(); } catch {}
	}

	/** Wait for the first frame (at or after fromIndex) matching the predicate; returns its index. */
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

	framesFor(consultId: string, fromIndex = 0): Frame[] {
		return this.frames.slice(fromIndex).filter((frame) => frame.consultId === consultId);
	}
}

/** Consult starts are gated while the room's turn machinery is busy; retry until accepted. */
async function consultWhenIdle(ws: WsHarness, consultId: string, targetRoomId: string, question: string): Promise<number> {
	const deadline = Date.now() + 25_000;
	let attempt = 0;
	while (Date.now() < deadline) {
		const attemptId = `${consultId}_a${attempt++}`;
		const before = ws.frames.length;
		ws.send({ type: "consult", consultId: attemptId, targetRoomId, question });
		const index = await ws.waitFor((frame) => (frame.type === "consult_started" || frame.type === "consult_error") && frame.consultId === attemptId, `consult ${attemptId} outcome`, before);
		if (ws.frames[index].type === "consult_started") {
			return ws.waitFor((frame) => frame.type === "consult_end" && frame.consultId === attemptId, `consult ${attemptId} end`, index);
		}
		assert(/answering right now/.test(String(ws.frames[index].message)), `idle-retry consult should only be rejected by the turn gate, got: ${ws.frames[index].message}`);
		await new Promise((resolve) => setTimeout(resolve, 150));
	}
	throw new Error("room never became idle for a consult");
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
	env.EXXETA_HOME = repoRoot;
	env.EXXPERTS_CODING_AGENT_DIR = agentDir;
	return env;
}

let server: ChildProcessWithoutNullStreams | null = null;
const serverOutput: string[] = [];
let ws: WsHarness | null = null;
let ws2: WsHarness | null = null;

try {
	await new Promise<void>((resolve) => gateway.listen(0, "127.0.0.1", resolve));
	const gatewayPort = (gateway.address() as AddressInfo).port;

	fs.mkdirSync(agentDir, { recursive: true, mode: 0o700 });
	fs.mkdirSync(productAppRoot, { recursive: true, mode: 0o700 });
	fs.writeFileSync(
		path.join(agentDir, "models.json"),
		JSON.stringify(
			{
				providers: {
					"openai-compatible": {
						name: "Synthetic SSE Gateway",
						baseUrl: `http://127.0.0.1:${gatewayPort}/v1`,
						api: "openai-completions",
						models: [
							{ id: "room-model", name: "Room Model", contextWindow: 128000, maxTokens: 16384 },
							{ id: "consult-model", name: "Consult Model", contextWindow: 128000, maxTokens: 16384 },
						],
					},
				},
			},
			null,
			2,
		),
		{ mode: 0o600 },
	);
	fs.writeFileSync(
		path.join(agentDir, "auth.json"),
		JSON.stringify({ "openai-compatible": { type: "api_key", key: "synthetic-consult-streaming-key" } }, null, 2),
		{ mode: 0o600 },
	);
	fs.writeFileSync(
		path.join(productAppRoot, "openai-compatible-ai-profile.json"),
		JSON.stringify(
			{
				profileId: "openai-compatible",
				providerId: "openai-compatible",
				label: "Synthetic SSE Gateway",
				roomModels: [{ modelId: "room-model", label: "Room Model" }],
				maintenanceModel: "consult-model",
			},
			null,
			2,
		),
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

	const askerId = await createRoom("Consult Streaming Asker");
	const targetId = await createRoom("Consult Streaming Euler");
	const conversationId = `smokeconv_${Date.now().toString(36)}`;
	await prepareThread(askerId, conversationId);

	ws = await WsHarness.connect(askerId, conversationId);

	// --- 1. Happy path: started → deltas → end, streamed live -------------
	ws.send({ type: "consult", consultId: "c_happy", targetRoomId: targetId, question: "What did we decide about the pricing model?" });
	const startedIndex = await ws.waitFor((frame) => frame.type === "consult_started" && frame.consultId === "c_happy", "consult_started");
	const started = ws.frames[startedIndex];
	assert(started.targetRoomId === targetId, `consult_started should carry the target room id, got ${JSON.stringify(started)}`);
	assert(started.targetDisplayName === "Consult Streaming Euler", `consult_started should carry the target display name, got ${JSON.stringify(started)}`);
	assert(started.model?.provider === "openai-compatible" && started.model?.model === "consult-model", `consult_started should carry the locked consult model, got ${JSON.stringify(started.model)}`);

	const endIndex = await ws.waitFor((frame) => frame.type === "consult_end" && frame.consultId === "c_happy", "consult_end", startedIndex);
	const end = ws.frames[endIndex];
	const expectedAnswer = FAST_ANSWER_CHUNKS.join("");
	assert(end.text === expectedAnswer, `consult_end text should be the full answer, got ${JSON.stringify(end.text)}`);
	const deltas = ws.framesFor("c_happy").filter((frame) => frame.type === "consult_delta");
	assert(deltas.length >= 2, `expected streamed consult deltas, got ${deltas.length}`);
	assert(deltas.map((frame) => frame.delta).join("") === expectedAnswer, "joined consult deltas should equal the final text");
	assert(end.l1bFingerprint?.algorithm === "sha256" && /^[0-9a-f]{64}$/.test(String(end.l1bFingerprint?.value)), `consult_end should carry the L1b fingerprint, got ${JSON.stringify(end.l1bFingerprint)}`);
	assert(typeof end.generatedAt === "string" && end.generatedAt.length > 0, "consult_end should carry generatedAt");
	assert(Array.isArray(end.warnings) && end.warnings.includes("no memory has been written"), `consult_end should carry the no-write warning, got ${JSON.stringify(end.warnings)}`);
	assert(end.usage?.input > 0 && end.usage?.output > 0, `consult_end should carry worker usage, got ${JSON.stringify(end.usage)}`);

	// --- 2. Usage bills to the asking room with kind "consult" ------------
	const usage = await requestJson("/api/usage");
	assert(usage.status === 200, `usage endpoint should return 200, got ${usage.status}`);
	const askerUsage = (usage.body?.byAgent ?? []).find((row: any) => row.agent === askerId);
	assert(askerUsage?.kinds?.consult?.turns === 1, `consult usage should bill to the asking room as kind consult, got ${JSON.stringify(usage.body?.byAgent)}`);
	const targetUsage = (usage.body?.byAgent ?? []).find((row: any) => row.agent === targetId);
	assert(!targetUsage, `the consulted room must not be billed, got ${JSON.stringify(targetUsage)}`);

	// --- 3. One consult at a time ------------------------------------------
	const beforeBusy = ws.frames.length;
	ws.send({ type: "consult", consultId: "c_slow1", targetRoomId: targetId, question: `Take your time. ${SLOW_MARKER}` });
	await ws.waitFor((frame) => frame.type === "consult_started" && frame.consultId === "c_slow1", "slow consult started", beforeBusy);
	ws.send({ type: "consult", consultId: "c_second", targetRoomId: targetId, question: "Am I allowed?" });
	const secondErrorIndex = await ws.waitFor((frame) => frame.type === "consult_error" && frame.consultId === "c_second", "second consult rejected", beforeBusy);
	assert(/already running/.test(String(ws.frames[secondErrorIndex].message)), `second consult should be rejected as already running, got: ${ws.frames[secondErrorIndex].message}`);

	// --- 4. Run-free: a prompt completes while the consult streams ---------
	ws.send({ type: "prompt", text: "Say hello." });
	const usageTurnIndex = await ws.waitFor((frame) => frame.type === "usage_turn", "prompt turn usage while consult runs", beforeBusy);
	assert(!ws.frames.slice(0, usageTurnIndex + 1).some((frame) => frame.type === "consult_end" && frame.consultId === "c_slow1"), "the prompt turn should complete while the slow consult is still streaming");
	const slowEndIndex = await ws.waitFor((frame) => frame.type === "consult_end" && frame.consultId === "c_slow1", "slow consult end", usageTurnIndex);
	assert(ws.frames[slowEndIndex].text === SLOW_ANSWER_CHUNKS.join("").trim(), `slow consult should still deliver its full answer, got ${JSON.stringify(ws.frames[slowEndIndex].text)}`);

	// --- 5. Start gate: no consult while the room is answering -------------
	const beforeGate = ws.frames.length;
	ws.send({ type: "prompt", text: `Answer slowly please. ${SLOW_MARKER}` });
	ws.send({ type: "consult", consultId: "c_gated", targetRoomId: targetId, question: "Can I start now?" });
	const gatedIndex = await ws.waitFor((frame) => frame.type === "consult_error" && frame.consultId === "c_gated", "gated consult rejected", beforeGate);
	assert(/answering right now/.test(String(ws.frames[gatedIndex].message)), `start gate should name the in-flight turn, got: ${ws.frames[gatedIndex].message}`);
	await ws.waitFor((frame) => frame.type === "usage_turn", "slow prompt turn finished", beforeGate);

	// --- 6. Abort: consult_abort → "stopped by you", no consult_end --------
	const abortEndIndex = await (async () => {
		const before = ws!.frames.length;
		ws!.send({ type: "consult", consultId: "c_abort", targetRoomId: targetId, question: `Long one. ${SLOW_MARKER}` });
		// The turn gate may still be closing after the previous prompt; retry there.
		const outcome = await ws!.waitFor((frame) => (frame.type === "consult_started" || frame.type === "consult_error") && frame.consultId === "c_abort", "abort consult outcome", before);
		if (ws!.frames[outcome].type === "consult_error") {
			assert(/answering right now/.test(String(ws!.frames[outcome].message)), `unexpected consult rejection: ${ws!.frames[outcome].message}`);
			await new Promise((resolve) => setTimeout(resolve, 300));
			ws!.send({ type: "consult", consultId: "c_abort", targetRoomId: targetId, question: `Long one. ${SLOW_MARKER}` });
			return ws!.waitFor((frame) => frame.type === "consult_started" && frame.consultId === "c_abort", "abort consult started", outcome);
		}
		return outcome;
	})();
	await ws.waitFor((frame) => frame.type === "consult_delta" && frame.consultId === "c_abort", "abort consult first delta", abortEndIndex);
	ws.send({ type: "consult_abort", consultId: "c_abort" });
	const stoppedIndex = await ws.waitFor((frame) => frame.type === "consult_error" && frame.consultId === "c_abort", "stopped consult error", abortEndIndex);
	assert(/stopped by you/i.test(String(ws.frames[stoppedIndex].message)), `abort should read as stopped by you, got: ${ws.frames[stoppedIndex].message}`);
	await new Promise((resolve) => setTimeout(resolve, 800));
	assert(!ws.framesFor("c_abort", stoppedIndex).some((frame) => frame.type === "consult_end"), "an aborted consult must not deliver consult_end");

	// --- 7. Stale consult_abort is ignored, later consults still work ------
	ws.send({ type: "consult_abort", consultId: "c_abort" });
	await consultWhenIdle(ws, "c_after_abort", targetId, "Still working?");

	// --- 8. Rejections: unknown target, self-consult -----------------------
	const beforeUnknown = ws.frames.length;
	ws.send({ type: "consult", consultId: "c_unknown", targetRoomId: "consult-streaming-missing", question: "Anyone home?" });
	const unknownIndex = await ws.waitFor((frame) => frame.type === "consult_error" && frame.consultId === "c_unknown", "unknown target rejected", beforeUnknown);
	assert(/not found/.test(String(ws.frames[unknownIndex].message)), `unknown target should be a not-found error, got: ${ws.frames[unknownIndex].message}`);

	ws.send({ type: "consult", consultId: "c_self", targetRoomId: askerId, question: "Ask myself?" });
	const selfIndex = await ws.waitFor((frame) => frame.type === "consult_error" && frame.consultId === "c_self", "self-consult rejected", beforeUnknown);
	assert(/cannot consult itself/.test(String(ws.frames[selfIndex].message)), `self-consult should be rejected, got: ${ws.frames[selfIndex].message}`);

	// --- 9. Socket close aborts the running consult worker -----------------
	ws.close();
	ws = null;
	ws2 = await WsHarness.connect(askerId, conversationId);
	const beforeClose = gatewayRequests.length;
	ws2.send({ type: "consult", consultId: "c_dropped", targetRoomId: targetId, question: `About to vanish. ${SLOW_MARKER}` });
	await ws2.waitFor((frame) => frame.type === "consult_delta" && frame.consultId === "c_dropped", "dropped consult first delta");
	ws2.close();
	ws2 = null;
	{
		const deadline = Date.now() + 20_000;
		let workerRequest: GatewayRequest | undefined;
		while (Date.now() < deadline) {
			workerRequest = gatewayRequests.slice(beforeClose).find((request) => request.model === "consult-model");
			if (workerRequest?.aborted) break;
			await new Promise((resolve) => setTimeout(resolve, 100));
		}
		assert(workerRequest?.aborted === true, "closing the socket should abort the consult worker's provider request");
	}

	console.log("consult streaming smoke passed");
} catch (error) {
	const output = serverOutput.join("").trim();
	if (output) console.error(output.split("\n").slice(-80).join("\n"));
	console.error(error instanceof Error ? error.stack || error.message : error);
	console.error(`temp HOME preserved for inspection: ${tempHome}`);
	process.exitCode = 1;
} finally {
	try { ws?.close(); } catch {}
	try { ws2?.close(); } catch {}
	await stopSmokeServer(server ?? undefined);
	gateway.close();
	if (process.exitCode == null || process.exitCode === 0) {
		fs.rmSync(tempHome, { recursive: true, force: true });
	}
}
