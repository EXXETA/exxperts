// An empty conversation follows the room's conversation pick until its
// first message. A conversation bound on model A, with nothing said in it,
// gets a new pick B in Room settings, Model (PUT /models); the next message
// rebinds it on B before the turn, the socket hears model_switched without a
// line, and the conversation's lock is B. A conversation that already has a
// turn keeps its lock when the pick moves again. The room's status says
// whether its open conversation still follows the pick (Home's card shows it).
// And while the room's pick cannot run (its provider signed out), an empty
// conversation waits with the room: the socket refuses with the room's
// sentence instead of binding on the lock the conversation was prepared with.

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

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "exxperts-empty-follows-pick-"));
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
	const agentId = agents.createPersistentAgentFromScaffoldInput({ displayName: "Empty Follows Pick Room", userName: "Synthetic User", preferredUserAddress: "Synthetic User" }).agent.agentId;
	const conversationId = "c_empty_follows_0001";
	roomModels.writeRoomModels(agentId, { conversation: CLAUDE });
	agents.writePersistentAgentThread(agentId, conversationId, { state: "active", origin: "home", model: CLAUDE, items: [] }, {
		createRuntime: ({ model }) => agents.createPersistentAgentPiSessionJsonlThreadRuntime({ agentId, threadId: conversationId, model, cwd: threadCwd }),
	});

	server = spawn("npx", ["tsx", "src/index.ts"], {
		shell: process.platform === "win32",
		...SMOKE_SERVER_SPAWN_TREE_OPTIONS,
		cwd: webServerDir,
		env: smokeHomeEnv(tempHome, { PORT: String(port), ...SMOKE_SERVER_AUTH_ENV, EXXETA_HOME: repoRoot, EXXPERTS_CODING_AGENT_DIR: agentDir, EXXETA_PERSISTENT_AGENTS_ROOT: agentsRoot }) as NodeJS.ProcessEnv,
	});
	server.stdout.on("data", (chunk) => serverOutput.push(String(chunk)));
	server.stderr.on("data", (chunk) => serverOutput.push(String(chunk)));
	await waitUntil(() => fetch(`${baseUrl}/healthz`).then((r) => r.ok).catch(() => false), "server ready");

	await connect(agentId, conversationId);
	assert(frames.find((frame) => frame.type === "ready")?.model?.model === CLAUDE.model, "the empty conversation binds on Claude");

	const picked = await api(`/api/persistent-agents/${agentId}/models`, { method: "PUT", body: JSON.stringify({ conversation: GPT }) });
	assert(picked.status === 200 && picked.body?.models?.conversation?.stored?.model === GPT.model, `the room's pick becomes GPT, got ${picked.status} ${JSON.stringify(picked.body).slice(0, 300)}`);
	// Home's card reads this flag: still empty, so it shows the room's pick.
	const beforeFirst = (await api(`/api/persistent-agents/${agentId}/status`)).body;
	assert(beforeFirst.activeThread?.threadId === conversationId && beforeFirst.activeThread?.followsConversationPick === true, `the empty conversation follows the pick, got ${JSON.stringify(beforeFirst.activeThread)}`);
	const first = await turn(agentId, "First message after the new pick.");
	assert(first.api === "openai" && first.body.model === GPT.model, `the first message runs on the new pick, got ${first.api} ${first.body.model}`);
	const moved = frames.find((frame) => frame.type === "model_switched");
	assert(moved?.model?.model === GPT.model && !moved.notice, `the socket hears the new model without a line, got ${JSON.stringify(moved)}`);
	let thread = (await api(`/api/persistent-agents/${agentId}/threads/${conversationId}`)).body.thread;
	assert(thread.model.model === GPT.model, `the conversation's lock is the new pick, got ${JSON.stringify(thread.model)}`);
	assert(!(thread.items as any[]).some((item) => item.kind === "system" && /^Continued on /.test(String(item.text))), "an empty conversation gets no Continued on line");
	const afterFirst = (await api(`/api/persistent-agents/${agentId}/status`)).body;
	assert(afterFirst.activeThread?.followsConversationPick === false, `a conversation with a turn no longer follows the pick, got ${JSON.stringify(afterFirst.activeThread?.followsConversationPick)}`);
	pass("an empty conversation bound on Claude runs its first message on the room's new pick, GPT, and the socket hears it; the status says it follows the pick until then");

	const back = await api(`/api/persistent-agents/${agentId}/models`, { method: "PUT", body: JSON.stringify({ conversation: CLAUDE }) });
	assert(back.status === 200, `the pick moves back to Claude, got ${back.status}`);
	const switchedBefore = frames.filter((frame) => frame.type === "model_switched").length;
	const second = await turn(agentId, "Second message, the pick moved again.");
	assert(second.api === "openai" && second.body.model === GPT.model, `a conversation with a turn keeps its lock, got ${second.api} ${second.body.model}`);
	assert(frames.filter((frame) => frame.type === "model_switched").length === switchedBefore, "no model change is announced for a conversation with a turn");
	thread = (await api(`/api/persistent-agents/${agentId}/threads/${conversationId}`)).body.thread;
	assert(thread.model.model === GPT.model, `the lock stays GPT, got ${JSON.stringify(thread.model)}`);
	pass("a conversation with a turn keeps its lock when the room's pick moves again");

	// A fresh empty conversation prepared on Claude; the room's pick is GPT,
	// and GPT signs out while Claude stays signed in.
	socket.close();
	await waitUntil(async () => (await api(`/api/persistent-agents/${agentId}/status`)).body?.activeLock == null, "the first socket let go of the room");
	const waitingId = "c_empty_follows_0002";
	await api(`/api/persistent-agents/${agentId}/models`, { method: "PUT", body: JSON.stringify({ conversation: GPT }) });
	agents.writePersistentAgentThread(agentId, waitingId, { state: "active", origin: "home", model: CLAUDE, items: [] }, {
		createRuntime: ({ model }) => agents.createPersistentAgentPiSessionJsonlThreadRuntime({ agentId, threadId: waitingId, model, cwd: threadCwd }),
	});
	fs.writeFileSync(path.join(agentDir, "auth.json"), JSON.stringify({ "fake-claude": { type: "api_key", key: "synthetic-claude" } }, null, 2), { mode: 0o600 });
	const requestsBefore = requests.length;
	frames.length = 0;
	socket = new WebSocketImpl(`ws://127.0.0.1:${port}/ws?persistentAgentId=${agentId}&conversationId=${waitingId}`, { headers: { ...SMOKE_AUTH_HEADERS } });
	socket.addEventListener("message", (event: { data: unknown }) => { try { frames.push(JSON.parse(String(event.data))); } catch {} });
	await waitUntil(() => frames.some((frame) => frame.type === "error" || frame.type === "ready"), "the waiting conversation's first frame");
	const refusal = frames.find((frame) => frame.type === "error");
	assert(refusal?.code === "provider_signed_out" && refusal.provider === "fake-gpt" && refusal.message === "This room's model, GPT Fake on Fake GPT, is signed out. Sign in again in Settings, AI setup, or choose another model in Room settings, Model.", `the empty conversation waits with the room's refusal, got ${JSON.stringify(frames)}`);
	assert(!frames.some((frame) => frame.type === "ready") && requests.length === requestsBefore, "nothing bound on Claude, the lock it was prepared with, and no model was asked");
	assert((await api(`/api/persistent-agents/${agentId}/threads/${waitingId}`)).body.thread.model.model === CLAUDE.model, "the conversation's lock is left as it was, for when the room can run again");
	pass("while the room's pick is signed out, an empty conversation refuses with the room's sentence instead of running on the model it was prepared with");

	console.log("empty conversation follows pick smoke passed");
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
