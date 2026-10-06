// An open conversation continues on another model between turns.
//
// Against a real spawned server and two synthetic providers, one speaking the
// Anthropic Messages stream (signed thinking, tool_use, text) and one the
// OpenAI completions stream, a conversation seeded with a user message
// carrying two images, a Claude answer with signed thinking and a tool call,
// its result and a closing answer, moves Claude to GPT and back:
//
// - the switch is refused while a turn is in flight and while a Remember
//   reads the conversation, each with its plain sentence;
// - a target window too small for the conversation is refused, the sentence
//   naming Remember and Forget, with the numbers the fit used;
// - a switch rebinds the live session: the socket hears model_switched with a
//   "Continued on" line, the Pi session gains a model_change entry, the
//   conversation's lock moves with the old one in its history, and the room's
//   conversation pick follows;
// - each provider then gets the whole conversation in its own shape (two
//   images, the tool call and its result, no thinking block on the OpenAI
//   side), and neither ever sees the "Continued on" line, which is not in
//   Remember's items either;
// - the boot snapshot does not change with the model;
// - with no live socket the switch writes the conversation on disk and the
//   runtime state keeps its state.

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { createRequire } from "node:module";
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

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "exxperts-switch-model-"));
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
const TINY = { provider: "fake-gpt", model: "gemma-3-12b" };
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

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

	// The conversation, seeded before the server starts: two images, a signed
	// thinking block, a tool call and its result.
	const agents = await import("../src/persistent-agents.js");
	const roomModels = await import("../src/room-models.js");
	const agentId = agents.createPersistentAgentFromScaffoldInput({ displayName: "Switch Model Room", userName: "Synthetic User", preferredUserAddress: "Synthetic User" }).agent.agentId;
	const conversationId = "c_switch_0001";
	roomModels.writeRoomModels(agentId, { conversation: CLAUDE });
	const created = agents.writePersistentAgentThread(agentId, conversationId, { state: "active", origin: "home", model: CLAUDE, items: [] }, {
		createRuntime: ({ model }) => agents.createPersistentAgentPiSessionJsonlThreadRuntime({ agentId, threadId: conversationId, model, cwd: threadCwd }),
	});
	assert(created.thread.runtime.kind === "pi-session-jsonl", "the conversation is Pi-backed");
	const bootSha = created.thread.runtime.bootPromptSha256;
	const seed = agents.openPersistentAgentPiSessionManager(agentId, created.thread.runtime, threadCwd);
	const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
	seed.appendMessage({ role: "user", content: [{ type: "text", text: "Two screenshots of the plan." }, { type: "image", data: PNG, mimeType: "image/png" }, { type: "image", data: PNG, mimeType: "image/png" }], timestamp: Date.now() } as any);
	seed.appendMessage({ role: "assistant", content: [{ type: "thinking", thinking: "The plan needs the file.", thinkingSignature: "sig_seed" }, { type: "text", text: "Reading the plan file." }, { type: "toolCall", id: "toolu_seed_01", name: "read", arguments: { path: "plan.md" } }], api: "anthropic-messages", provider: CLAUDE.provider, model: CLAUDE.model, usage, stopReason: "toolUse", timestamp: Date.now() } as any);
	seed.appendMessage({ role: "toolResult", toolCallId: "toolu_seed_01", toolName: "read", content: [{ type: "text", text: "PLAN_FILE_CONTENT the launch moves to November." }], isError: false, timestamp: Date.now() } as any);
	seed.appendMessage({ role: "assistant", content: [{ type: "text", text: "The launch moves to November." }], api: "anthropic-messages", provider: CLAUDE.provider, model: CLAUDE.model, usage, stopReason: "stop", timestamp: Date.now() } as any);

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
	assert(frames.find((frame) => frame.type === "ready")?.model?.model === CLAUDE.model, "the conversation binds on Claude");
	const claudeFirst = await turn(agentId, "First question on Claude.");
	assert(claudeFirst.api === "anthropic" && (claudeFirst.raw.match(/"type":"image"/g) ?? []).length === 2 && claudeFirst.raw.includes("tool_use") && claudeFirst.raw.includes("tool_result"), "Claude gets the images and the tool pair in its own shape");
	pass("the seeded conversation (two images, signed thinking, a tool pair) runs on Claude");

	const switchTo = (lock: { provider: string; model: string }) => api(`/api/persistent-agents/${agentId}/threads/${conversationId}/switch-model`, { method: "POST", body: JSON.stringify(lock) });

	// --- Refused in flight ------------------------------------------------------------
	const hangBefore = requests.length;
	hangTurn = true;
	socket.send(JSON.stringify({ type: "prompt", text: "A long one." }));
	await waitUntil(() => requests.length > hangBefore, "the hanging turn reaches the provider");
	hangTurn = false;
	const inFlight = await switchTo(GPT);
	assert(inFlight.status === 409 && inFlight.body?.error === "The room is answering. Switch the model when the answer has finished.", `a switch during a turn is refused with the plain sentence, got ${inFlight.status} ${JSON.stringify(inFlight.body)}`);
	socket.send(JSON.stringify({ type: "abort" }));
	await waitUntil(async () => (await api(`/api/persistent-agents/${agentId}/status`)).body?.activeThread?.inFlight === false, "the stopped turn settled");
	pass("a switch while a turn is in flight is refused with the plain sentence");

	// --- Refused while Remember reads ---------------------------------------------------
	hangRemember = true;
	const cancel = new AbortController();
	const rememberBefore = requests.length;
	const propose = authedFetch(`${baseUrl}/api/persistent-agents/${agentId}/checkpoint/propose`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ conversationId, density: "standard" }), signal: cancel.signal }).catch(() => null);
	await waitUntil(() => requests.slice(rememberBefore).some((request) => request.raw.includes("Checkpoint Compression Constitution")), "the Remember call reaches the provider");
	const whileRemembering = await switchTo(GPT);
	assert(whileRemembering.status === 409 && whileRemembering.body?.error === "Remember is reading this conversation. Switch the model when it has finished, or cancel it.", `a switch while Remember reads is refused with the plain sentence, got ${whileRemembering.status} ${JSON.stringify(whileRemembering.body)}`);
	cancel.abort();
	await propose;
	hangRemember = false;
	await waitUntil(async () => (await api(`/api/persistent-agents/${agentId}/checkpoint/progress?conversationId=${conversationId}`)).status === 404, "the Remember ended");
	pass("a switch while Remember reads the conversation is refused with the plain sentence");

	// --- Refused when it does not fit ------------------------------------------------------
	const tooSmall = await switchTo(TINY);
	assert(tooSmall.status === 409 && /too long to continue on Gemma 3 12b:/.test(tooSmall.body?.error) && /Gemma 3 12b holds /.test(tooSmall.body?.error) && /Remember it and continue on Gemma 3 12b, or Forget it\.$/.test(tooSmall.body?.error) && !/gemma-3-12b/.test(tooSmall.body?.error), `a target too small is refused with Remember and Forget named, got ${tooSmall.status} ${JSON.stringify(tooSmall.body?.error)}`);
	const fit = tooSmall.body.fit;
	assert(fit.window === 20000 && fit.reserve === 16384 && fit.available === 3616 && fit.margin === 1.15 && fit.needed > fit.available && fit.estimated.systemPrompt > 0 && fit.estimated.tools > 0 && fit.estimated.toolsFrom === "session", `the refusal carries the numbers the fit used, got ${JSON.stringify(fit)}`);
	console.log(`      fit on Gemma 3 12b: measured ${fit.measured}, estimated messages ${fit.estimated.messages} + system prompt ${fit.estimated.systemPrompt} + tools ${fit.estimated.tools} (${fit.estimated.toolsFrom}), x${fit.margin} = ${fit.needed} needed against ${fit.window} - ${fit.reserve} = ${fit.available}`);
	pass("a target window too small is refused with Remember and Forget named and the fit's numbers");

	// --- Claude to GPT, live ------------------------------------------------------------------
	const toGpt = await switchTo(GPT);
	assert(toGpt.status === 200 && toGpt.body.fit.fits === true && toGpt.body.models.conversation.stored?.model === GPT.model, `the switch to GPT goes through and becomes the room's pick, got ${toGpt.status} ${JSON.stringify(toGpt.body).slice(0, 300)}`);
	await waitUntil(() => frames.some((frame) => frame.type === "model_switched"), "the model_switched frame");
	const switchedFrame = frames.find((frame) => frame.type === "model_switched");
	assert(switchedFrame.model?.model === GPT.model && switchedFrame.notice?.text === "Continued on GPT Fake", `the socket hears the new model and the line, got ${JSON.stringify(switchedFrame)}`);
	assert(toGpt.body.notice?.id === switchedFrame.notice?.id && toGpt.body.notice?.text === switchedFrame.notice?.text, `the answer names the same line as the frame, got ${JSON.stringify({ answer: toGpt.body.notice, frame: switchedFrame.notice })}`);
	let thread = (await api(`/api/persistent-agents/${agentId}/threads/${conversationId}`)).body.thread;
	assert(thread.model.model === GPT.model && thread.modelHistory?.length === 1 && thread.modelHistory[0].model === CLAUDE.model, `the lock moves with the old one in its history, got ${JSON.stringify({ model: thread.model, history: thread.modelHistory })}`);
	const sessionFile = path.join(agentsRoot, agentId, thread.runtime.sessionFileRelPath);
	const modelChanges = () => fs.readFileSync(sessionFile, "utf-8").split("\n").filter(Boolean).map((line) => JSON.parse(line)).filter((entry) => entry.type === "model_change");
	assert(modelChanges().some((entry) => entry.provider === GPT.provider && entry.modelId === GPT.model), "the Pi session gains a model_change entry for GPT");
	pass("the switch rebinds the live session: the frame, the line, the model_change entry, the lock and its history, the room's pick");

	const onGpt = await turn(agentId, "Second question, now on GPT.");
	assert(onGpt.api === "openai" && onGpt.body.model === GPT.model, "the next turn goes to GPT");
	assert((onGpt.raw.match(/"type":"image_url"/g) ?? []).length === 2, `GPT gets the two images, got ${(onGpt.raw.match(/"type":"image_url"/g) ?? []).length}`);
	assert(onGpt.raw.includes("PLAN_FILE_CONTENT") && onGpt.raw.includes("tool_calls") && onGpt.raw.includes("\"role\":\"tool\""), "GPT gets the tool call and its result in its own shape");
	assert(!onGpt.raw.includes("\"type\":\"thinking\"") && !onGpt.raw.includes("sig_seed"), "no Claude thinking block or signature reaches GPT");
	assert(!onGpt.raw.includes("Continued on"), "the Continued on line is not in the model's context");
	pass("GPT gets the whole conversation in its own shape (two images, the tool pair, no thinking block), without the line");

	// --- And back to Claude ------------------------------------------------------------------------
	const back = await switchTo(CLAUDE);
	assert(back.status === 200, `the switch back to Claude goes through, got ${back.status}`);
	await waitUntil(() => frames.filter((frame) => frame.type === "model_switched").length === 2, "the second model_switched frame");
	const onClaude = await turn(agentId, "Third question, back on Claude.");
	assert(onClaude.api === "anthropic" && (onClaude.raw.match(/"type":"image"/g) ?? []).length === 2 && onClaude.raw.includes("Answer from gpt-fake.") && onClaude.raw.includes("tool_use"), "Claude gets GPT's answer, the images and the tool pair back");
	assert(!onClaude.raw.includes("Continued on"), "the line is not in Claude's context either");
	thread = (await api(`/api/persistent-agents/${agentId}/threads/${conversationId}`)).body.thread;
	assert(thread.modelHistory.length === 2 && thread.runtime.bootPromptSha256 === bootSha, `the history grows and the boot snapshot is the same for both models, got ${JSON.stringify({ history: thread.modelHistory, sha: thread.runtime.bootPromptSha256 === bootSha })}`);
	const notices = (thread.items as any[]).filter((item) => item.kind === "system" && /^Continued on /.test(item.text));
	assert(notices.length === 2, `the display cache holds the two lines, got ${notices.length}`);
	const source = agents.buildPersistentAgentCheckpointTranscriptSource({ agentId, conversationId, l1b: fs.readFileSync(path.join(agentsRoot, agentId, "L1b", "current.md"), "utf-8"), runtimeCwd: threadCwd });
	assert(!JSON.stringify(source.items).includes("Continued on"), "Remember's items hold no Continued on line");
	pass("back on Claude: GPT's answer, the images and the tool pair replay; the boot snapshot is unchanged; the lines are display only, not in Remember's items");

	// --- With no live socket ------------------------------------------------------------------------
	socket.close();
	await waitUntil(async () => !(await api(`/api/persistent-agents/${agentId}/status`)).body?.activeLock, "the room lock released");
	// --- Refused while another process works the room -------------------------------------
	const roomLock = createRequire(import.meta.url)(path.join(repoRoot, "bin", "lib", "room-lock.cjs")) as {
		tryAcquire: (agentId: string, owner: { surface: string; pid?: number; lockId?: string }) => { ok: boolean };
		release: (agentId: string, owner: { surface: string; pid?: number; lockId?: string }) => void;
	};
	const client = await import("../../web-ui/src/room-models-api.js");
	for (const owner of [{ surface: "cli", pid: process.pid }, { surface: "scheduler", pid: process.pid, lockId: "smoke-run" }]) {
		assert(roomLock.tryAcquire(agentId, owner).ok, `the smoke holds the room as ${owner.surface}`);
		try {
			const held = await switchTo(GPT);
			const expected = client.switchRoomBusySentence({ surface: owner.surface });
			assert(held.status === 409 && held.body?.code === "switch_room_busy" && held.body?.error === expected, `a switch while ${owner.surface} holds the room is refused in the pane's words, got ${held.status} ${JSON.stringify(held.body)}`);
			const listed = (await api("/api/persistent-agents")).body;
			const status = (Array.isArray(listed) ? listed : listed?.agents ?? []).find((room: any) => room.id === agentId);
			assert(client.switchRoomBusySentence(status?.activeLock) === expected, `the status tells the pane the room is held by ${owner.surface}, got ${JSON.stringify(status?.activeLock)}`);
		} finally {
			roomLock.release(agentId, owner);
		}
	}
	thread = (await api(`/api/persistent-agents/${agentId}/threads/${conversationId}`)).body.thread;
	assert(thread.model.model === CLAUDE.model && thread.modelHistory.length === 2, "a refused switch leaves the conversation as it was");
	assert(client.switchRoomBusySentence({ surface: "web" }) === null && client.switchRoomBusySentence(null) === null, "the room's own web session never holds the switch back");
	pass("a switch while the CLI or a scheduled run holds the room is refused, in the same words the Model pane shows");

	const runtimeBefore = (await api(`/api/persistent-agents/${agentId}/status`)).body.runtime;
	const fileOnly = await switchTo(GPT);
	assert(fileOnly.status === 200 && fileOnly.body.fit.estimated.toolsFrom === "room tool list" && fileOnly.body.fit.measured === null, `with no live socket the switch goes through on the estimate, got ${fileOnly.status} ${JSON.stringify(fileOnly.body?.fit)}`);
	const runtimeAfter = (await api(`/api/persistent-agents/${agentId}/status`)).body.runtime;
	thread = (await api(`/api/persistent-agents/${agentId}/threads/${conversationId}`)).body.thread;
	assert(thread.model.model === GPT.model && modelChanges().filter((entry) => entry.modelId === GPT.model).length >= 2, "the conversation is switched on disk with its model_change entry");
	const savedLine = (thread.items as any[])[thread.items.length - 1];
	assert(fileOnly.body.notice?.id === savedLine?.id && fileOnly.body.notice?.text === "Continued on GPT Fake", `the answer names the line written on disk, got ${JSON.stringify({ answer: fileOnly.body.notice, saved: savedLine })}`);
	assert(runtimeAfter.state === runtimeBefore.state && runtimeAfter.model?.model === GPT.model, `the runtime state keeps its state and follows the model, got ${JSON.stringify({ before: runtimeBefore, after: runtimeAfter })}`);
	await connect(agentId, conversationId);
	assert(frames.find((frame) => frame.type === "ready")?.model?.model === GPT.model, "the next connection binds on the switched model");
	pass("with no live socket the switch writes the conversation on disk, the runtime state keeps its state, and the next bind runs on it");

	console.log("conversation switch model smoke passed");
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
