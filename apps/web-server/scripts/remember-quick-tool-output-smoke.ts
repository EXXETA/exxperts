// "Remember without the preview" with a shortened tool output. A real
// Remember over a conversation holding one tool output longer than the
// 4,000-character cap: the proposal carries no warning for it, only the count
// on its read (for the diagnostics), so the quick path saves on its own and
// nothing on screen speaks of it. No engine warning stops the quick save; only
// an entry with no arc or body opens the preview, with no reason shown.

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { authedFetch, SMOKE_AUTH_HEADERS, SMOKE_SERVER_AUTH_ENV, SMOKE_SERVER_SPAWN_TREE_OPTIONS, smokeHomeEnv, stopSmokeServer, type AuthedFetchInit } from "./smoke-server-process.js";

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

function pass(label: string): void {
	console.log(`  ok  ${label}`);
}

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const webServerDir = path.resolve(scriptDir, "..");
const repoRoot = path.resolve(webServerDir, "..", "..");
const port = 27000 + Math.floor(Math.random() * 10000);
const baseUrl = `http://127.0.0.1:${port}`;

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "exxperts-remember-quick-tool-output-"));
const tempHome = path.join(tempRoot, "home");
const agentsRoot = path.join(tempHome, ".exxperts", "app", "personalized-agents");
const agentDir = path.join(tempHome, ".exxperts", "agent");
const appDir = path.join(tempHome, ".exxperts", "app");
const threadCwd = path.join(tempRoot, "cwd");
for (const dir of [agentsRoot, agentDir, threadCwd]) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
process.env.HOME = tempHome;
process.env.USERPROFILE = tempHome;
process.env.EXXPERTS_CODING_AGENT_DIR = agentDir;
process.env.EXXETA_PERSISTENT_AGENTS_ROOT = agentsRoot;

const CLAUDE = { provider: "fake-claude", model: "claude-fake" };
const GPT = { provider: "fake-gpt", model: "gpt-fake" };

// --- The two providers -------------------------------------------------------------

type Request = { api: "anthropic" | "openai"; body: any; raw: string; aborted: boolean };
const requests: Request[] = [];
let hangRemember = false;
/** The next room turn hangs mid-stream (the text stays in the history, so a flag, not a marker). */
let hangTurn = false;

function sse(res: http.ServerResponse, event: string | null, payload: unknown): void {
	res.write(`${event ? `event: ${event}\n` : ""}data: ${JSON.stringify(payload)}\n\n`);
}

const providers = http.createServer((req, res) => {
	let raw = "";
	req.on("data", (chunk) => { raw += chunk; });
	req.on("end", () => {
		const body = JSON.parse(raw || "{}");
		const api = String(req.url ?? "").includes("/messages") ? "anthropic" : "openai";
		const record: Request = { api, body, raw, aborted: false };
		requests.push(record);
		res.on("close", () => { if (!res.writableFinished) record.aborted = true; });
		res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
		const remember = raw.includes("Checkpoint Compression Constitution");
		const hang = remember ? hangRemember : hangTurn;
		const text = remember ? "TITLE:\nSwitch\n\nSESSION_ARC:\nMoved models.\n\nBODY:\n- Moved.\n\nPARKED:\nNone\n" : `Answer from ${body.model}.`;
		if (api === "anthropic") {
			sse(res, "message_start", { type: "message_start", message: { id: `msg_${requests.length}`, type: "message", role: "assistant", model: body.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 100, output_tokens: 1 } } });
			sse(res, "content_block_start", { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } });
			sse(res, "content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "Thinking it over." } });
			if (hang) return;
			sse(res, "content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: `sig_${requests.length}` } });
			sse(res, "content_block_stop", { type: "content_block_stop", index: 0 });
			sse(res, "content_block_start", { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } });
			sse(res, "content_block_delta", { type: "content_block_delta", index: 1, delta: { type: "text_delta", text } });
			sse(res, "content_block_stop", { type: "content_block_stop", index: 1 });
			sse(res, "message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 20 } });
			sse(res, "message_stop", { type: "message_stop" });
			res.end();
			return;
		}
		const base = { id: `cmpl_${requests.length}`, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: body.model };
		sse(res, null, { ...base, choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }] });
		if (hang) return;
		sse(res, null, { ...base, choices: [{ index: 0, delta: { content: text }, finish_reason: null }] });
		sse(res, null, { ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } });
		res.write("data: [DONE]\n\n");
		res.end();
	});
});

// --- Helpers -----------------------------------------------------------------------

async function api(pathname: string, init: AuthedFetchInit = {}): Promise<{ status: number; body: any }> {
	const response = await authedFetch(`${baseUrl}${pathname}`, { ...init, headers: { ...(init.body ? { "content-type": "application/json" } : {}), ...init.headers } });
	const text = await response.text();
	return { status: response.status, body: text ? JSON.parse(text) : null };
}

async function waitUntil(predicate: () => Promise<boolean> | boolean, label: string, timeoutMs = 25_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
	throw new Error(`timed out waiting until ${label}`);
}

const WebSocketImpl: any = (await import("ws")).default;
let server: ChildProcessWithoutNullStreams | undefined;
const serverOutput: string[] = [];
let socket: any = null;
const frames: any[] = [];

async function connect(agentId: string, conversationId: string): Promise<void> {
	frames.length = 0;
	socket = new WebSocketImpl(`ws://127.0.0.1:${port}/ws?persistentAgentId=${agentId}&conversationId=${conversationId}`, { headers: { ...SMOKE_AUTH_HEADERS } });
	socket.addEventListener("message", (event: { data: unknown }) => { try { frames.push(JSON.parse(String(event.data))); } catch {} });
	await new Promise<void>((resolve, reject) => { socket.addEventListener("open", () => resolve()); socket.addEventListener("error", () => reject(new Error("websocket failed to connect"))); });
	await waitUntil(() => frames.some((frame) => frame.type === "ready"), "ready frame");
}

async function turn(agentId: string, text: string): Promise<Request> {
	const before = requests.length;
	socket.send(JSON.stringify({ type: "prompt", text }));
	await waitUntil(async () => requests.length > before && (await api(`/api/persistent-agents/${agentId}/status`)).body?.activeThread?.inFlight === false, `the turn "${text}" settled`);
	return requests[requests.length - 1]!;
}

try {
	await new Promise<void>((resolve) => providers.listen(0, "127.0.0.1", resolve));
	const providerPort = (providers.address() as AddressInfo).port;
	fs.writeFileSync(path.join(agentDir, "models.json"), JSON.stringify({
		providers: {
			"fake-claude": { name: "Fake Claude", baseUrl: `http://127.0.0.1:${providerPort}`, api: "anthropic-messages", models: [{ id: "claude-fake", name: "Claude Fake", reasoning: true, input: ["text", "image"], contextWindow: 200000, maxTokens: 32000 }] },
			"fake-gpt": {
				name: "Fake GPT",
				baseUrl: `http://127.0.0.1:${providerPort}/v1`,
				api: "openai-completions",
				models: [
					{ id: "gpt-fake", name: "GPT Fake", input: ["text", "image"], contextWindow: 128000, maxTokens: 16000 },
					{ id: "gemma-3-12b", name: "gemma-3-12b", input: ["text", "image"], contextWindow: 20000, maxTokens: 4000 },
				],
			},
		},
	}, null, 2), { mode: 0o600 });
	fs.writeFileSync(path.join(agentDir, "auth.json"), JSON.stringify({ "fake-claude": { type: "api_key", key: "synthetic-claude" }, "fake-gpt": { type: "api_key", key: "synthetic-gpt" } }, null, 2), { mode: 0o600 });
	fs.writeFileSync(path.join(appDir, "custom-ai-profiles.json"), JSON.stringify({ version: 1, profiles: [
		{ id: "custom-fake-claude", providerId: "fake-claude", label: "Fake Claude", roomModels: ["claude-fake"], learnModel: "claude-fake", reviewMemoryModel: "claude-fake" },
		{ id: "custom-fake-gpt", providerId: "fake-gpt", label: "Fake GPT", roomModels: ["gpt-fake", "gemma-3-12b"], learnModel: "gpt-fake", reviewMemoryModel: "gpt-fake" },
	] }, null, 2), { mode: 0o600 });
	fs.writeFileSync(path.join(appDir, "persistent-agent-ai-profile.json"), JSON.stringify({ profileId: "custom-fake-claude" }, null, 2), { mode: 0o600 });

	const agents = await import("../src/persistent-agents.js");
	const roomModels = await import("../src/room-models.js");
	const client = await import("../../web-ui/src/remember-read.js");
	const agentId = agents.createPersistentAgentFromScaffoldInput({ displayName: "Quick Remember Room", userName: "Synthetic User", preferredUserAddress: "Synthetic User" }).agent.agentId;
	const conversationId = "c_quick_tool_output_0001";
	roomModels.writeRoomModels(agentId, { conversation: CLAUDE, memory: CLAUDE });
	const created = agents.writePersistentAgentThread(agentId, conversationId, { state: "active", origin: "home", model: CLAUDE, items: [] }, {
		createRuntime: ({ model }) => agents.createPersistentAgentPiSessionJsonlThreadRuntime({ agentId, threadId: conversationId, model, cwd: threadCwd }),
	});
	assert(created.thread.runtime.kind === "pi-session-jsonl", "the conversation is Pi-backed");
	const seed = agents.openPersistentAgentPiSessionManager(agentId, created.thread.runtime, threadCwd);
	const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
	seed.appendMessage({ role: "user", content: [{ type: "text", text: "List the release folder and tell me what matters." }], timestamp: Date.now() } as any);
	seed.appendMessage({ role: "assistant", content: [{ type: "text", text: "Listing it." }, { type: "toolCall", id: "toolu_list_01", name: "bash", arguments: { command: "ls -la release" } }], api: "anthropic-messages", provider: CLAUDE.provider, model: CLAUDE.model, usage, stopReason: "toolUse", timestamp: Date.now() } as any);
	seed.appendMessage({ role: "toolResult", toolCallId: "toolu_list_01", toolName: "bash", content: [{ type: "text", text: "release-file-line ".repeat(400) }], isError: false, timestamp: Date.now() } as any);
	seed.appendMessage({ role: "assistant", content: [{ type: "text", text: "Two files matter: the notes and the checksum." }], api: "anthropic-messages", provider: CLAUDE.provider, model: CLAUDE.model, usage, stopReason: "stop", timestamp: Date.now() } as any);

	server = spawn("npx", ["tsx", "src/index.ts"], {
		shell: process.platform === "win32",
		...SMOKE_SERVER_SPAWN_TREE_OPTIONS,
		cwd: webServerDir,
		env: smokeHomeEnv(tempHome, { PORT: String(port), ...SMOKE_SERVER_AUTH_ENV, EXXETA_HOME: repoRoot, EXXPERTS_CODING_AGENT_DIR: agentDir, EXXETA_PERSISTENT_AGENTS_ROOT: agentsRoot }) as NodeJS.ProcessEnv,
	});
	server.stdout.on("data", (chunk) => serverOutput.push(String(chunk)));
	server.stderr.on("data", (chunk) => serverOutput.push(String(chunk)));
	await waitUntil(() => fetch(`${baseUrl}/healthz`).then((r) => r.ok).catch(() => false), "server ready");

	const proposal = await api(`/api/persistent-agents/${agentId}/checkpoint/propose`, { method: "POST", body: JSON.stringify({ conversationId, density: "standard" }) });
	assert(proposal.status === 200, `the proposal is written, got ${proposal.status} ${JSON.stringify(proposal.body).slice(0, 300)}`);
	const warnings: string[] = proposal.body.warnings ?? [];
	assert(!warnings.some((warning) => /tool output|shortened|trimmed/i.test(warning)), `a shortened tool output is not a warning, got ${JSON.stringify(warnings)}`);
	assert(proposal.body.rememberRead?.mode === "one-pass" && proposal.body.rememberRead?.trimmedToolOutputs === 1 && proposal.body.rememberRead?.toolOutputCapChars === 4000, `the read counts the one shortened tool output, got ${JSON.stringify(proposal.body.rememberRead)}`);
	pass("the proposal carries the shortened tool output as a count on its read, not as a warning");

	const needsPreview = (client as any).quickRememberNeedsPreview;
	assert(typeof needsPreview === "function" && needsPreview(proposal.body) === false, "Remember without the preview saves on its own");
	assert(needsPreview({ warnings: ["the model declined twice to write the entry, so it was put together from the notes"], fields: { sessionArc: "Arc.", body: "- Body." } }) === false, "an engine warning never stops the quick save");
	assert(needsPreview({ warnings: [], fields: { sessionArc: "Arc.", body: " " } }) === true, "an entry with no body opens the preview");
	for (const gone of ["quickRememberBlockers", "rememberToolOutputSentence", "rememberReadSentences", "rememberChipValue"]) assert(!(gone in client), `${gone} is gone`);
	const appSource = fs.readFileSync(path.join(process.cwd(), "apps", "web-ui", "src", "App.tsx"), "utf8");
	assert(!/shortened before reading|rememberReadSentences|displayWarnings|approval\.warnings/.test(appSource), "the preview and the saved line say nothing of how the entry was read");
	pass("no engine warning stops the quick save, and nothing on screen says how the entry was read");

	console.log("remember quick path tool output smoke passed");
} catch (error) {
	console.error(serverOutput.join("").slice(-8000));
	throw error;
} finally {
	try { socket?.close(); } catch {}
	try { (providers as any).closeAllConnections?.(); } catch {}
	try { providers.close(); } catch {}
	await stopSmokeServer(server);
	fs.rmSync(tempRoot, { recursive: true, force: true });
}
