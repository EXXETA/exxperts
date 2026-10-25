import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import http from "node:http";
import type { AddressInfo } from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { authedFetch, freePort, type AuthedFetchInit, SMOKE_AUTH_HEADERS, SMOKE_SERVER_AUTH_ENV, SMOKE_SERVER_SPAWN_TREE_OPTIONS, stopSmokeServer } from "./smoke-server-process.js";

// A failed auto-compaction reaches the room, end to end against a real spawned
// server and a synthetic OpenAI-compatible gateway.
//
// The runtime condenses a room's history on its own once the context passes
// the model's window minus the reserve, and refuses a summary the model cut
// off at its output limit (stopReason "length") rather than keeping a
// half-summary as if it were whole. That refusal arrives on the session as a
// compaction_end event carrying errorMessage. The server used to forward the
// event and nothing else: the client ignores the type, no log line was
// written, and the room paid for the same doomed summary again on every later
// turn without anyone knowing why. Proves:
//   1. the turn itself still lands (agent_end, then usage);
//   2. the server logs the failure with the room id, the reason and the
//      runtime's message;
//   3. the client receives a red notify line AFTER the turn ended, in the
//      house wording, and no error frame (the turn did not fail: the answer
//      is on the screen and only the condensing did not happen);
//   4. a page that leaves, or Stop, while the runtime shortens a conversation
//      that overflowed leaves it free: the next message is answered, not
//      refused as still running, and the shortening stops without asking the
//      model again or showing a failure.

const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "exxperts-auto-compaction-failure-home-"));
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const webServerDir = path.resolve(scriptDir, "..");
const repoRoot = path.resolve(webServerDir, "..", "..");
const port = await freePort();
const baseUrl = `http://127.0.0.1:${port}`;
const agentDir = path.join(tempHome, ".exxperts", "agent");
const productAppRoot = path.join(tempHome, ".exxperts", "app");

// The runtime's threshold is contextWindow - reserveTokens (16384 by default),
// so one answer reported at this size trips auto-compaction right after it.
const NARROW_WINDOW = 64_000;
const PROMPT_TOKENS = 60_000;
const COMPLETION_TOKENS = 40;
const ANSWER_CHUNKS = ["Short ", "answer."];
const CUT_SUMMARY_CHUNKS = ["# Goal\n", "The user asked for"];
const RUNTIME_REASON = "generation hit the token cap and the summary is incomplete";

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

// ---------------------------------------------------------------------------
// Synthetic OpenAI-compatible gateway: a normal answer with an oversized
// context reading, then a summary cut off at the output limit.
// ---------------------------------------------------------------------------
let chatCalls = 0;
let summaryCalls = 0;
// Row 4: a message marked OVERFLOW is refused as too long; a summary asked for while a scene holds it waits for the scene to answer it.
let overflowMode = false;
let holdNextSummary = false;
const heldSummaries: http.ServerResponse[] = [];
// The chat requests made while overflowMode is on, a refused one included.
let overflowChats = 0;

function sseChunk(payload: unknown): string {
	return `data: ${JSON.stringify(payload)}\n\n`;
}

function messageText(message: any): string {
	const content = message?.content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content.map((part: any) => (typeof part?.text === "string" ? part.text : "")).join("");
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
		const messages: any[] = Array.isArray(parsed?.messages) ? parsed.messages : [];
		// The summarization request wraps the transcript in <conversation> tags.
		const isSummary = messages.some((message) => message?.role === "user" && messageText(message).includes("<conversation>"));
		if (overflowMode) {
			if (isSummary && holdNextSummary) { holdNextSummary = false; heldSummaries.push(res); return; }
			if (!isSummary) overflowChats += 1;
			if (messageText([...messages].reverse().find((message) => message?.role === "user")).includes("OVERFLOW")) {
				res.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({ error: { message: "This model's maximum context length is 64000 tokens. Please reduce the length of the messages.", type: "invalid_request_error", code: "context_length_exceeded" } }));
				return;
			}
		}
		if (isSummary) summaryCalls += 1; else chatCalls += 1;
		answer(res, model, isSummary);
	});
});

function answer(res: http.ServerResponse, model: string, isSummary: boolean): void {
		res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
		// The first answer reads little; the second reads enough to trip threshold compaction.
		const promptTokens = overflowMode || (!isSummary && chatCalls === 1) ? 100 : PROMPT_TOKENS;
		const base = { id: `cmpl_${chatCalls + summaryCalls}`, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model };
		res.write(sseChunk({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }] }));
		for (const chunk of isSummary ? (overflowMode ? ["# Goal\n", "Short answers."] : CUT_SUMMARY_CHUNKS) : ANSWER_CHUNKS) {
			res.write(sseChunk({ ...base, choices: [{ index: 0, delta: { content: chunk }, finish_reason: null }] }));
		}
		res.write(sseChunk({
			...base,
			choices: [{ index: 0, delta: {}, finish_reason: isSummary && !overflowMode ? "length" : "stop" }],
			usage: { prompt_tokens: promptTokens, completion_tokens: COMPLETION_TOKENS, total_tokens: promptTokens + COMPLETION_TOKENS },
		}));
		res.write("data: [DONE]\n\n");
		res.end();
}

/** Answers the newest held summary as a whole one, if its caller still waits for it. */
function answerHeldSummary(): void {
	const held = heldSummaries.at(-1);
	if (!held || held.writableEnded || held.socket?.destroyed) return;
	try { answer(held, "narrow-model", true); } catch {}
}

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

async function waitForServerOutput(predicate: (output: string) => boolean, label: string, timeoutMs = 10_000): Promise<string> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const output = serverOutput.join("");
		if (predicate(output)) return output;
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	throw new Error(`timed out waiting for ${label} in the server log`);
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
	// The warn line is the assertion; the launcher's production default keeps it.
	env.LOG_LEVEL = "warn";
	return env;
}

let server: ChildProcessWithoutNullStreams | null = null;
const serverOutput: string[] = [];
let ws: WsHarness | null = null;
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
						{ id: "narrow-model", name: "Narrow Model", contextWindow: NARROW_WINDOW, maxTokens: 16384 },
					],
				},
			},
		}, null, 2),
		{ mode: 0o600 },
	);
	fs.writeFileSync(
		path.join(agentDir, "auth.json"),
		JSON.stringify({ "openai-compatible": { type: "api_key", key: "synthetic-compaction-key" } }, null, 2),
		{ mode: 0o600 },
	);
	fs.writeFileSync(
		path.join(productAppRoot, "openai-compatible-ai-profile.json"),
		JSON.stringify({
			profileId: "openai-compatible",
			providerId: "openai-compatible",
			label: "Synthetic SSE Gateway",
			roomModels: [{ modelId: "narrow-model", label: "Narrow Model" }],
			maintenanceModel: "narrow-model",
		}, null, 2),
		{ mode: 0o600 },
	);
	// A small kept window, so the first exchange is what the summary condenses.
	fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({ compaction: { keepRecentTokens: 5 } }, null, 2), { mode: 0o600 });
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

	const roomId = await createRoom("Compaction Failure Room");
	const conversationId = `compconv_${Date.now().toString(36)}`;
	await putThread(roomId, conversationId, "narrow-model", []);

	ws = await WsHarness.connect(roomId, conversationId, "narrow-model");
	await ws.waitFor((frame) => frame.type === "ready", "ready frame");

	// --- 1. Two turns land; the runtime then tries to condense the first and is refused --
	ws.send({ type: "prompt", text: "Say something short." });
	const firstEndIndex = await ws.waitFor((row) => row.type === "event" && row.event?.type === "agent_end", "the first agent_end");
	for (const deadline = Date.now() + 15_000; (await requestJson(`/api/persistent-agents/${roomId}/status`)).body?.activeThread?.inFlight !== false;) {
		assert(Date.now() < deadline, "the first turn should settle");
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
	ws.send({ type: "prompt", text: "Say something short again." });
	const agentEndIndex = await ws.waitFor((row) => row.type === "event" && row.event?.type === "agent_end", "agent_end", firstEndIndex + 1);
	await ws.waitFor((row) => row.type === "usage_turn", "usage_turn frame", firstEndIndex + 1);
	const compactionEndIndex = await ws.waitFor((row) => row.type === "event" && row.event?.type === "compaction_end", "compaction_end event");
	const compactionEnd = ws.frames[compactionEndIndex].event;
	assert(compactionEnd.reason === "threshold", `the oversized reading should trip threshold compaction, got ${JSON.stringify(compactionEnd)}`);
	assert(typeof compactionEnd.errorMessage === "string" && compactionEnd.errorMessage.includes(RUNTIME_REASON), `the cut summary should be refused by the runtime, got ${JSON.stringify(compactionEnd)}`);
	assert(summaryCalls === 1, `the gateway should have seen exactly one summary request, got ${summaryCalls}`);
	assert(chatCalls === 2, `the gateway should have seen exactly two chat requests, got ${chatCalls}`);
	pass("the turn lands and the runtime refuses the summary the gateway cut off");

	// --- 2. The server says so in its log ------------------------------------
	const output = await waitForServerOutput((text) => text.includes("auto-compaction failed"), "the auto-compaction warn line");
	const warnLine = output.split("\n").find((line) => line.includes("auto-compaction failed")) ?? "";
	let warn: any = null;
	try { warn = JSON.parse(warnLine); } catch {}
	assert(warn, `the warn line should be a pino record, got ${JSON.stringify(warnLine)}`);
	assert(warn.level === 40, `the line should be at warn level, got ${JSON.stringify(warn.level)}`);
	assert(warn.agentId === roomId, `the line should name the room, got ${JSON.stringify(warn.agentId)}`);
	assert(warn.reason === "threshold", `the line should carry the compaction reason, got ${JSON.stringify(warn.reason)}`);
	assert(typeof warn.err === "string" && warn.err.includes(RUNTIME_REASON), `the line should carry the runtime's message, got ${JSON.stringify(warn.err)}`);
	pass("the server logs the failure with the room id, the reason and the runtime's message");

	// --- 3. The room is told, after the turn, without the turn failing -------
	const noticeIndex = await ws.waitFor((row) => row.type === "ui_request" && row.kind === "notify" && row.level === "error", "the compaction notice", 0, 10_000);
	const notice = ws.frames[noticeIndex];
	// The runtime's words stay in the log line above, never on the room's line. The page words the line from
	// the notice's fields: a summary cut at the model's output limit, whose way on is a model that writes longer answers.
	assert(notice.failure === "could-not-shorten" && notice.summaryCut === true && notice.reason === "threshold" && notice.model?.model === "narrow-model", `the notice carries what the page words its line from, got ${JSON.stringify(notice)}`);
	assert(notice.message === undefined && notice.words === undefined, `the notice carries no words of its own, got ${JSON.stringify(notice)}`);
	assert(noticeIndex > agentEndIndex, "the notice should follow the turn's end, not interrupt it");
	assert(!ws.frames.some((frame) => frame.type === "error"), `a failed compaction must not fail the turn, saw ${JSON.stringify(ws.frames.filter((frame) => frame.type === "error"))}`);
	assert(ws.frames.filter((frame) => frame.type === "ui_request" && frame.kind === "notify" && frame.level === "error").length === 1, "one attempt, one notice");
	pass("the client receives one red notice line after the turn, and no error frame");

	// --- 4. Leaving or Stop while the runtime shortens an overflowing conversation frees it, and the shortening stops quietly --
	ws.close();
	overflowMode = true;
	const settled = async (roomId: string, label: string) => {
		for (const deadline = Date.now() + 15_000; (await requestJson(`/api/persistent-agents/${roomId}/status`)).body?.activeThread?.inFlight !== false;) {
			assert(Date.now() < deadline, label);
			await new Promise((resolve) => setTimeout(resolve, 100));
		}
	};
	// A room with one answer, then a message too long for the model, whose shortening the gateway holds.
	const overflowing = async (name: string) => {
		const roomId = await createRoom(name);
		const conversationId = `overflow_${Date.now().toString(36)}`;
		await putThread(roomId, conversationId, "narrow-model", []);
		ws = await WsHarness.connect(roomId, conversationId, "narrow-model");
		await ws.waitFor((frame) => frame.type === "ready", `${name}'s ready frame`);
		ws.send({ type: "prompt", text: "Say something short." });
		await ws.waitFor((row) => row.type === "event" && row.event?.type === "agent_end", `${name}'s first answer`);
		await settled(roomId, `${name}'s first turn should settle`);
		const held = heldSummaries.length;
		holdNextSummary = true;
		ws.send({ type: "prompt", text: "OVERFLOW: read this very long paste." });
		for (const deadline = Date.now() + 15_000; heldSummaries.length === held;) {
			assert(Date.now() < deadline, `the runtime should start shortening after the overflow, saw ${ws.frames.map((frame) => frame.event?.type ?? frame.type).join(", ")}`);
			await new Promise((resolve) => setTimeout(resolve, 50));
		}
		return { roomId, conversationId };
	};
	const failureFramesFrom = (from: number) => ws!.frames.slice(from).filter((frame) => (frame.type === "ui_request" && frame.kind === "notify" && frame.level === "error") || frame.event?.failure || frame.type === "error");
	const answeredFrom = async (from: number, label: string) => {
		ws!.send({ type: "prompt", text: "Say something short." });
		const outcome = await ws!.waitFor((row) => (row.type === "error" && row.code === "turn_running") || (row.type === "event" && row.event?.type === "agent_end"), label, from);
		assert(ws!.frames[outcome].type !== "error", `${label}: the conversation is free, got ${JSON.stringify(ws!.frames[outcome])}`);
	};

	const left = await overflowing("Overflow Leave Room");
	ws.close();
	await new Promise((resolve) => setTimeout(resolve, 500));
	ws = await WsHarness.connect(left.roomId, left.conversationId, "narrow-model");
	const back = await ws.waitFor((frame) => frame.type === "ready", "the ready frame after coming back");
	await answeredFrom(back + 1, "the answer after coming back");
	await settled(left.roomId, "the answer after coming back should settle");
	const chatsAfterBack = overflowChats;
	answerHeldSummary();
	await new Promise((resolve) => setTimeout(resolve, 1200));
	assert(overflowChats === chatsAfterBack, `the left session's shortening never asks the model again, got ${overflowChats - chatsAfterBack} chat requests`);
	assert(failureFramesFrom(back + 1).length === 0, `coming back shows no failure, got ${JSON.stringify(failureFramesFrom(back + 1))}`);
	pass("leaving while the runtime shortens an overflowing conversation frees it, and the shortening never asks again behind it");

	ws.close();
	const stopped = await overflowing("Overflow Stop Room");
	const stopIndex = ws.frames.length;
	const chatsAtStop = overflowChats;
	ws.send({ type: "abort" });
	await settled(stopped.roomId, "Stop during the shortening should end the turn");
	answerHeldSummary();
	await new Promise((resolve) => setTimeout(resolve, 1200));
	assert(overflowChats === chatsAtStop, `after Stop the shortening never asks the model again, got ${overflowChats - chatsAtStop} chat requests`);
	assert(failureFramesFrom(stopIndex).length === 0, `Stop during the shortening shows no failure line, got ${JSON.stringify(failureFramesFrom(stopIndex))}`);
	await answeredFrom(ws.frames.length, "the answer after Stop");
	pass("Stop while the runtime shortens stops it quietly, and the next message is answered");

	console.log(`auto-compaction-failure-smoke: ${passes} checks passed`);
} catch (error) {
	console.error(`auto-compaction-failure-smoke FAILED: ${(error as Error).message}`);
	if (serverOutput.length > 0) console.error(serverOutput.join("").slice(-4000));
	process.exitCode = 1;
} finally {
	ws?.close();
	for (const held of heldSummaries) held.destroy();
	if (server) await stopSmokeServer(server);
	await new Promise<void>((resolve) => gateway.close(() => resolve()));
	try { fs.rmSync(tempHome, { recursive: true, force: true }); } catch {}
}
