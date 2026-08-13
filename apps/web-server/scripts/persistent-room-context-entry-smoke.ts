import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import http from "node:http";
import type { AddressInfo } from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { authedFetch, type AuthedFetchInit, SMOKE_AUTH_HEADERS, SMOKE_SERVER_AUTH_ENV, SMOKE_SERVER_SPAWN_TREE_OPTIONS, stopSmokeServer } from "./smoke-server-process.js";

// The room's context chip ON ENTRY, end to end against a real spawned server
// and a synthetic OpenAI-compatible gateway.
//
// The ready frame used to report an unconditional null, so the chip read
// "Measuring tokens" until this connection's own first answer landed, even in
// a room whose history was already long. It is not that the number was
// unavailable: a room's session manager is opened over the thread's session
// file at bind, so the history is in the session before a frame is sent. The
// frame simply never asked. Proves:
//   1. a brand-new room reads zero, because an empty conversation really does
//      hold nothing and the system prompt and tools are only paid for once the
//      first message is sent;
//   2. a room with a landed answer reports real tokens on the ready frame of a
//      BRAND-NEW connection that never sends a prompt, under the live
//      runtime-context-usage source, with a percentage of the recommended
//      checkpoint threshold and a zone;
//   3. the window on that reading is the current thread's model's, and the
//      percentage is anchored to the fixed checkpoint threshold rather than to
//      the window, so a thread on a different model reports a different window
//      and the same percentage for the same history;
//   4. a room whose session was compacted with no answer since reports unknown
//      rather than the pre-compaction size: the runtime deliberately declines
//      to size a just-compacted context, and that silence must reach the user
//      as silence instead of a red chip on a room that was just emptied. This
//      is the one entry that stays quiet, and it is why the zero above has to
//      be told apart from a decline rather than lumped in with it.

const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "exxperts-room-context-entry-home-"));
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const webServerDir = path.resolve(scriptDir, "..");
const repoRoot = path.resolve(webServerDir, "..", "..");
const port = 24000 + Math.floor(Math.random() * 10000);
const baseUrl = `http://127.0.0.1:${port}`;
const agentDir = path.join(tempHome, ".exxperts", "agent");
const productAppRoot = path.join(tempHome, ".exxperts", "app");

// The recommended-checkpoint threshold the server anchors its percentage to.
// It is machine-wide and has nothing to do with the model's context window,
// which is reported beside it as its own field.
const CHECKPOINT_TOKENS = 125_000;
const WIDE_WINDOW = 400_000;
const NARROW_WINDOW = 64_000;
const PROMPT_TOKENS = 1200;
const COMPLETION_TOKENS = 40;
const ANSWER_CHUNKS = ["Short ", "answer."];

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

// ---------------------------------------------------------------------------
// Synthetic OpenAI-compatible gateway with fixed, checkable usage numbers.
// ---------------------------------------------------------------------------
let gatewayCalls = 0;

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
		gatewayCalls += 1;
		res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
		const base = { id: `cmpl_${gatewayCalls}`, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model };
		res.write(sseChunk({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }] }));
		for (const chunk of ANSWER_CHUNKS) {
			res.write(sseChunk({ ...base, choices: [{ index: 0, delta: { content: chunk }, finish_reason: null }] }));
		}
		res.write(sseChunk({
			...base,
			choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
			usage: { prompt_tokens: PROMPT_TOKENS, completion_tokens: COMPLETION_TOKENS, total_tokens: PROMPT_TOKENS + COMPLETION_TOKENS },
		}));
		res.write("data: [DONE]\n\n");
		res.end();
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

async function putThread(agentId: string, threadId: string, modelId: string, items: unknown[]): Promise<void> {
	const response = await requestJson(`/api/persistent-agents/${agentId}/threads/${threadId}`, {
		method: "PUT",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ state: "active", origin: "launcher", model: { provider: "openai-compatible", model: modelId }, items }),
	});
	assert(response.status === 200, `thread PUT should return 200, got ${response.status}: ${JSON.stringify(response.body)}`);
}

async function readThread(agentId: string, threadId: string): Promise<any> {
	const response = await requestJson(`/api/persistent-agents/${agentId}/threads/${threadId}`);
	assert(response.status === 200, `thread GET should return 200, got ${response.status}: ${JSON.stringify(response.body)}`);
	return response.body?.thread;
}

function roomRootPath(agentId: string): string {
	return path.join(tempHome, ".exxperts", "app", "personalized-agents", agentId);
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

	static async connect(persistentAgentId: string, conversationId: string, modelId: string): Promise<WsHarness> {
		const socket = new WebSocketImpl(`ws://127.0.0.1:${port}/ws?persistentAgentId=${persistentAgentId}&conversationId=${conversationId}&modelProvider=openai-compatible&model=${modelId}&reattach=1`, { headers: { ...SMOKE_AUTH_HEADERS } });
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

// One full turn. A real user types between turns; this harness does not, so a
// prompt landing in the previous turn's bookkeeping window is retried rather
// than treated as a failure.
async function runTurn(harness: WsHarness): Promise<Frame> {
	for (let attempt = 0; attempt < 40; attempt++) {
		const fromIndex = harness.frames.length;
		harness.send({ type: "prompt", text: "Say something short." });
		const settledIndex = await harness.waitFor(
			(row) => (row.type === "event" && row.event?.type === "agent_end") || (row.type === "error" && /still running|is cancelling/.test(String(row.message ?? ""))),
			"turn end",
			fromIndex,
			20_000,
		);
		if (harness.frames[settledIndex].type === "error") {
			await new Promise((resolve) => setTimeout(resolve, 250));
			continue;
		}
		const usageIndex = await harness.waitFor((row) => row.type === "usage_turn", "usage_turn frame", fromIndex, 10_000);
		return harness.frames[usageIndex];
	}
	throw new Error("the room never accepted a new turn");
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
	return env;
}

let server: ChildProcessWithoutNullStreams | null = null;
const serverOutput: string[] = [];
let ws: WsHarness | null = null;
let ws2: WsHarness | null = null;
let ws3: WsHarness | null = null;
let ws4: WsHarness | null = null;
let passes = 0;

function pass(label: string): void {
	passes += 1;
	console.log(`  ok ${label}`);
}

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
						{ id: "wide-model", name: "Wide Model", contextWindow: WIDE_WINDOW, maxTokens: 16384 },
						// Same gateway, same answers, a very different window: the
						// window is only visibly the model's when the model moves.
						{ id: "narrow-model", name: "Narrow Model", contextWindow: NARROW_WINDOW, maxTokens: 16384 },
					],
				},
			},
		}, null, 2),
		{ mode: 0o600 },
	);
	fs.writeFileSync(
		path.join(agentDir, "auth.json"),
		JSON.stringify({ "openai-compatible": { type: "api_key", key: "synthetic-context-entry-key" } }, null, 2),
		{ mode: 0o600 },
	);
	fs.writeFileSync(
		path.join(productAppRoot, "openai-compatible-ai-profile.json"),
		JSON.stringify({
			profileId: "openai-compatible",
			providerId: "openai-compatible",
			label: "Synthetic SSE Gateway",
			roomModels: [
				{ modelId: "wide-model", label: "Wide Model" },
				{ modelId: "narrow-model", label: "Narrow Model" },
			],
			maintenanceModel: "wide-model",
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

	const roomId = await createRoom("Context Entry Room");
	const conversationId = `ctxconv_${Date.now().toString(36)}`;
	await putThread(roomId, conversationId, "wide-model", []);

	// --- 1. A room with no history honestly reads zero -----------------------
	ws = await WsHarness.connect(roomId, conversationId, "wide-model");
	const firstReadyIndex = await ws.waitFor((frame) => frame.type === "ready", "ready frame");
	const firstHealth = ws.frames[firstReadyIndex].contextHealth;
	assert(firstHealth, `ready should carry contextHealth, got ${JSON.stringify(ws.frames[firstReadyIndex])}`);
	assert(firstHealth.tokens === 0, `an empty room should report zero tokens, got ${JSON.stringify(firstHealth)}`);
	assert(firstHealth.source === "runtime-context-usage", `zero is a measurement, so it should carry the live source, got ${JSON.stringify(firstHealth.source)}`);
	assert(firstHealth.checkpointPercent === 0, `an empty room should sit at zero percent, got ${JSON.stringify(firstHealth.checkpointPercent)}`);
	assert(firstHealth.zone === "green", `an empty room should be green, got ${JSON.stringify(firstHealth.zone)}`);
	assert(firstHealth.contextWindow === WIDE_WINDOW, `ready should report the locked model's window, got ${JSON.stringify(firstHealth.contextWindow)}`);
	pass("a room with no history reads zero rather than refusing to answer");

	// --- 2. A room with a landed answer speaks on ENTRY ----------------------
	const usageFrame = await runTurn(ws);
	const liveTokens = usageFrame.contextHealth?.tokens;
	assert(typeof liveTokens === "number" && liveTokens > 0, `a landed turn should report measured tokens, got ${JSON.stringify(usageFrame.contextHealth)}`);
	ws.close();
	ws = null;
	await new Promise((resolve) => setTimeout(resolve, 500));
	// A brand-new connection that never prompts: this is the entry the chip used
	// to spend reading "Measuring tokens".
	ws2 = await WsHarness.connect(roomId, conversationId, "wide-model");
	const entryReadyIndex = await ws2.waitFor((frame) => frame.type === "ready", "ready frame after re-entering");
	const entryHealth = ws2.frames[entryReadyIndex].contextHealth;
	assert(typeof entryHealth?.tokens === "number" && entryHealth.tokens > 0, `entering a room with history must report a size, got ${JSON.stringify(entryHealth)}`);
	assert(entryHealth?.source === "runtime-context-usage", `the entry reading should be the live one, got ${JSON.stringify(entryHealth?.source)}`);
	assert(entryHealth?.tokens === liveTokens, `the entry reading should match what the last turn measured, got ${JSON.stringify(entryHealth?.tokens)} against ${liveTokens}`);
	assert(entryHealth?.checkpointTokens === CHECKPOINT_TOKENS, `the reading should name the checkpoint threshold, got ${JSON.stringify(entryHealth?.checkpointTokens)}`);
	assert(
		typeof entryHealth?.checkpointPercent === "number" && Math.abs(entryHealth.checkpointPercent - (liveTokens / CHECKPOINT_TOKENS) * 100) < 0.0001,
		`the percentage should be of the checkpoint threshold, got ${JSON.stringify(entryHealth?.checkpointPercent)}`,
	);
	assert(entryHealth?.zone !== "unknown", `a reading with tokens must not sit in the unknown zone, got ${JSON.stringify(entryHealth?.zone)}`);
	assert(entryHealth?.contextWindow === WIDE_WINDOW, `the reading should carry this thread's model window, got ${JSON.stringify(entryHealth?.contextWindow)}`);
	// No prompt was sent on this connection, which is the entire point.
	assert(
		!ws2.frames.some((frame) => frame.type === "usage_turn"),
		"the entry reading must arrive without this connection running a turn",
	);
	ws2.close();
	ws2 = null;
	pass("entering a room with a landed answer reports its real size on the ready frame, with no prompt sent");

	// --- 3. Window follows the model, percentage follows the threshold -------
	// The same room's history on a thread locked to a much narrower model. Only
	// the window moves: the percentage is a fraction of the machine-wide
	// checkpoint threshold and has nothing to do with the model.
	const narrowRoomId = await createRoom("Narrow Entry Room");
	const narrowConversationId = `ctxnarrow_${Date.now().toString(36)}`;
	await putThread(narrowRoomId, narrowConversationId, "narrow-model", []);
	ws3 = await WsHarness.connect(narrowRoomId, narrowConversationId, "narrow-model");
	await ws3.waitFor((frame) => frame.type === "ready", "ready frame for the narrow room");
	const narrowUsageFrame = await runTurn(ws3);
	const narrowTokens = narrowUsageFrame.contextHealth?.tokens;
	assert(typeof narrowTokens === "number" && narrowTokens > 0, `the narrow room's turn should measure something, got ${JSON.stringify(narrowUsageFrame.contextHealth)}`);
	ws3.close();
	ws3 = null;
	await new Promise((resolve) => setTimeout(resolve, 500));
	ws3 = await WsHarness.connect(narrowRoomId, narrowConversationId, "narrow-model");
	const narrowReadyIndex = await ws3.waitFor((frame) => frame.type === "ready", "ready frame after re-entering the narrow room");
	const narrowHealth = ws3.frames[narrowReadyIndex].contextHealth;
	assert(narrowHealth?.contextWindow === NARROW_WINDOW, `the window must be the thread model's, got ${JSON.stringify(narrowHealth?.contextWindow)}`);
	assert(
		typeof narrowHealth?.checkpointPercent === "number" && Math.abs(narrowHealth.checkpointPercent - (narrowHealth.tokens / CHECKPOINT_TOKENS) * 100) < 0.0001,
		`the percentage should stay anchored to the checkpoint threshold on any model, got ${JSON.stringify(narrowHealth)}`,
	);
	ws3.close();
	ws3 = null;
	pass("the window on the reading is the thread model's while the percentage stays anchored to the checkpoint threshold");

	// --- 4. A just-compacted room stays quiet --------------------------------
	// The runtime declines to size a context whose latest compaction has no
	// answer after it, because the only usage it could reuse describes the
	// conversation as it was BEFORE the compaction. Passing that on would paint
	// a room red at the exact moment it was emptied.
	const thread = await readThread(roomId, conversationId);
	const sessionFileRelPath = String(thread?.runtime?.sessionFileRelPath ?? "");
	assert(sessionFileRelPath, `the room thread should be on the session-file runtime, got ${JSON.stringify(thread?.runtime)}`);
	const sessionFile = path.join(roomRootPath(roomId), sessionFileRelPath);
	const sessionLines = fs.readFileSync(sessionFile, "utf-8").split("\n").filter((line) => line.trim());
	const sessionEntries = sessionLines.map((line) => JSON.parse(line));
	const lastEntry = sessionEntries[sessionEntries.length - 1];
	const firstMessageEntry = sessionEntries.find((entry: any) => entry?.type === "message");
	assert(lastEntry?.id && firstMessageEntry?.id, `the session file should hold identified entries, got ${JSON.stringify(lastEntry)}`);
	// A compaction as the runtime writes one: the newest entry on the branch,
	// with nothing answered after it.
	fs.appendFileSync(sessionFile, JSON.stringify({
		type: "compaction",
		id: `compaction_${Date.now().toString(36)}`,
		parentId: lastEntry.id,
		timestamp: new Date().toISOString(),
		summary: "The conversation so far, compacted.",
		firstKeptEntryId: firstMessageEntry.id,
		tokensBefore: liveTokens,
	}) + "\n");
	ws4 = await WsHarness.connect(roomId, conversationId, "wide-model");
	const compactedReadyIndex = await ws4.waitFor((frame) => frame.type === "ready", "ready frame after compaction");
	const compactedHealth = ws4.frames[compactedReadyIndex].contextHealth;
	assert(compactedHealth?.tokens === null, `a just-compacted room must not report a size, got ${JSON.stringify(compactedHealth)}`);
	assert(compactedHealth?.source === "unknown", `a just-compacted room should report unknown, got ${JSON.stringify(compactedHealth?.source)}`);
	assert(compactedHealth?.zone === "unknown", `a just-compacted room should be in the unknown zone, got ${JSON.stringify(compactedHealth?.zone)}`);
	ws4.close();
	ws4 = null;
	pass("a just-compacted room reports unknown rather than the size it had before the compaction");

	console.log(`persistent-room-context-entry-smoke: ${passes} checks passed`);
} catch (error) {
	console.error(`persistent-room-context-entry-smoke FAILED: ${(error as Error).message}`);
	if (serverOutput.length > 0) console.error(serverOutput.join("").slice(-4000));
	process.exitCode = 1;
} finally {
	ws?.close();
	ws2?.close();
	ws3?.close();
	ws4?.close();
	if (server) await stopSmokeServer(server);
	await new Promise<void>((resolve) => gateway.close(() => resolve()));
	try { fs.rmSync(tempHome, { recursive: true, force: true }); } catch {}
}
