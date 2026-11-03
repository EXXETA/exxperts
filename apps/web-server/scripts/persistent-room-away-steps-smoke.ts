import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { authedFetch, freePort, smokeHomeEnv, SMOKE_AUTH_HEADERS, SMOKE_SERVER_AUTH_ENV, SMOKE_SERVER_SPAWN_TREE_OPTIONS, stopSmokeServer, type AuthedFetchInit } from "./smoke-server-process.js";
import { pairDevice } from "./smoke-pairing.js";
import { waitForTurnSettled } from "./smoke-turn-settle.js";

// A turn that finishes with nobody in the room keeps its steps: the reads it
// made, the one it was refused, and a call that never got its result, saved
// as done, failed or stopped cards before the answer. The same for a
// scheduled run, and a turn that failed after a question nobody answered. And a thread saved with a landed answer twice reads it once. A keyed turn's
// declined question gets its notice under the turn's key when nobody could
// answer it, and none beside a card the page kept. A real server with a synthetic gateway that plays the model,
// then the background run in this process. Throwaway HOME.

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const webServerDir = path.resolve(scriptDir, "..");
const repoRoot = path.resolve(webServerDir, "..", "..");

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "exxperts-away-steps-"));
const home = path.join(tempRoot, "home");
const workspaceRoot = path.join(tempRoot, "workspace");
fs.mkdirSync(workspaceRoot, { recursive: true, mode: 0o700 });
fs.writeFileSync(path.join(workspaceRoot, "notes.txt"), "NOTES-NEEDLE: the export runs on Fridays.\n", { mode: 0o600 });
fs.writeFileSync(path.join(workspaceRoot, "server.key"), "-----BEGIN PRIVATE KEY-----\nnot a real key\n", { mode: 0o600 });
const agentDir = path.join(home, ".exxperts", "agent");
const appRoot = path.join(home, ".exxperts", "app");
const agentsRoot = path.join(appRoot, "personalized-agents");

// --- 1. The step log on its own: hidden tools stay hidden, a call with no result is stopped.
{
	const { createTurnStepLog } = await import("../src/persistent-room-turn-steps.js");
	const log = createTurnStepLog();
	log.note({ role: "assistant", content: [
		{ type: "text", text: "Reading." },
		{ type: "toolCall", id: "c1", name: "read", arguments: { path: "notes.txt" } },
		{ type: "toolCall", id: "c2", name: "memory_search", arguments: { query: "export" } },
		{ type: "toolCall", id: "c3", name: "memory_recall", arguments: { query: "export" } },
		{ type: "toolCall", id: "c4", name: "delegate_task", arguments: { template: "ok" } },
		{ type: "toolCall", id: "c5", name: "delegate_task", arguments: { template: "nope" } },
		{ type: "toolCall", id: "c6", name: "read", arguments: { path: "late.txt" } },
		{ type: "toolCall", id: "c7", name: "memory_edit", arguments: { id: "m1" } },
	] });
	log.note({ role: "toolResult", toolCallId: "c1", toolName: "read", content: [{ type: "text", text: "the notes" }], isError: false, details: { lines: 1 } });
	log.note({ role: "toolResult", toolCallId: "c2", toolName: "memory_search", content: [{ type: "text", text: "hidden" }], isError: false });
	log.note({ role: "toolResult", toolCallId: "c3", toolName: "memory_recall", content: [{ type: "text", text: "found" }], isError: false });
	log.note({ role: "toolResult", toolCallId: "c4", toolName: "delegate_task", content: [{ type: "text", text: "started" }], isError: false });
	log.note({ role: "toolResult", toolCallId: "c5", toolName: "delegate_task", content: [{ type: "text", text: "not a specialist" }], isError: true });
	// A memory tool stays hidden live unless it failed, when the page shows its card.
	log.note({ role: "toolResult", toolCallId: "c7", toolName: "memory_edit", content: [{ type: "text", text: "no such note" }], isError: true });
	const items = log.items("away-step-t1").flatMap((item) => (item.kind === "tool" ? [item] : []));
	const shape = items.map((item) => `${item.name}:${item.status}`).join(",");
	assert(shape === "read:done,memory_recall:done,delegate_task:error,read:stopped,memory_edit:error", `the saved steps follow the live rules, got ${shape}`);
	assert(items.every((item, index) => item.kind === "tool" && item.id === `away-step-t1-${index + 1}`), `each step has its own id, got ${JSON.stringify(items.map((item) => item.id))}`);
	assert(items[0].result === "the notes" && (items[0].details as any)?.lines === 1 && JSON.stringify(items[0].args) === JSON.stringify({ path: "notes.txt" }), `a done step keeps its result, details and arguments, got ${JSON.stringify(items[0])}`);
	assert(items[3].result === undefined, "a stopped step has no result");
	console.log("ok 1 the step log keeps what the live page shows");
}

// --- 1b. The provider's own search lands as a step, where it ran among the message's blocks: done, failed, or stopped when it never ended.
{
	const { createTurnStepLog } = await import("../src/persistent-room-turn-steps.js");
	const log = createTurnStepLog();
	const update = (assistantMessageEvent: Record<string, unknown>) => log.frame({ type: "message_update", assistantMessageEvent });
	log.frame({ type: "message_start", message: { role: "assistant", content: [] } });
	update({ type: "text_start", contentIndex: 0 });
	update({ type: "server_tool_start", id: "srv-1", name: "web_search" });
	update({ type: "server_tool_start", id: "srv-1", name: "web_search", input: { query: "node lts" } });
	update({ type: "server_tool_end", id: "srv-1", ok: true });
	update({ type: "toolcall_start", contentIndex: 1 });
	update({ type: "server_tool_start", id: "srv-2", name: "web_search", input: { query: "node 24 release date" } });
	update({ type: "server_tool_end", id: "srv-2", ok: false });
	update({ type: "server_tool_start", id: "srv-3", name: "web_search", input: { query: "node 26" } });
	// An end for a search this message never started is nobody's step.
	update({ type: "server_tool_end", id: "srv-unknown", ok: true });
	log.note({ role: "assistant", content: [{ type: "text", text: "Let me search." }, { type: "toolCall", id: "c1", name: "read", arguments: { path: "notes.txt" } }] });
	log.note({ role: "toolResult", toolCallId: "c1", toolName: "read", content: [{ type: "text", text: "the notes" }], isError: false });
	// The next message starts clean: a search it never saw is not carried over.
	log.frame({ type: "message_start", message: { role: "assistant", content: [] } });
	log.note({ role: "assistant", content: [{ type: "text", text: "Node 24 is current." }] });
	const items = log.items("away-search").flatMap((item) => (item.kind === "tool" ? [item] : []));
	const shape = items.map((item) => `${item.name}:${item.status}:${JSON.stringify(item.args)}`).join(",");
	assert(shape === 'web_search:done:{"query":"node lts"},read:done:{"path":"notes.txt"},web_search:error:{"query":"node 24 release date"},web_search:stopped:{"query":"node 26"}', `the provider's searches land in order, done, failed or stopped, got ${shape}`);
	assert(items.every((item) => item.result === undefined || item.name === "read"), "a provider's search lands with no result text");
	console.log("ok 1b the step log keeps the provider's own search where it ran");
}

// --- The synthetic gateway plays the model: each leg calls the next scripted tool.
interface ScriptedCall { name: string; args: Record<string, unknown>; before?: () => void | Promise<void>; fail?: boolean }
let script: ScriptedCall[] = [];
// What the gateway answered, leg by leg, for a timeout's message.
const gatewayLog: string[] = [];
// The newest tool result the room sent back to the model.
let lastToolResult = "";
// A before hook's error: the row's waits throw it, so the row fails with it
// through the smoke's own catch and cleanup, not as a crash or a later timeout.
let hookFailure: unknown;
const sseChunk = (payload: unknown): string => `data: ${JSON.stringify(payload)}\n\n`;
// The provider's own web search, as an Anthropic Messages stream (the shape room-steer-smoke.ts plays): a lead, the search, then the answer.
const SEARCH = { provider: "anthropic-api-key", model: "claude-haiku-5-5" };
function searchingAnswer(res: http.ServerResponse): void {
	const send = (event: Record<string, unknown>) => res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
	const text = (index: number, words: string) => {
		send({ type: "content_block_start", index, content_block: { type: "text", text: "" } });
		send({ type: "content_block_delta", index, delta: { type: "text_delta", text: words } });
		send({ type: "content_block_stop", index });
	};
	res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
	send({ type: "message_start", message: { id: "msg_away_search", type: "message", role: "assistant", model: SEARCH.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 100, output_tokens: 1 } } });
	text(0, "Let me search.");
	send({ type: "content_block_start", index: 1, content_block: { type: "server_tool_use", id: "srvtoolu_away", name: "web_search", input: {} } });
	send({ type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: JSON.stringify({ query: "node lts" }) } });
	send({ type: "content_block_stop", index: 1 });
	send({ type: "content_block_start", index: 2, content_block: { type: "web_search_tool_result", tool_use_id: "srvtoolu_away", content: [{ type: "web_search_result", title: "Node.js releases", url: "https://nodejs.org/en/about/previous-releases", encrypted_content: "synthetic", page_age: null }] } });
	send({ type: "content_block_stop", index: 2 });
	text(3, " Node.js 24 is the active LTS line.");
	send({ type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 30 } });
	send({ type: "message_stop" });
	res.end();
}
const gateway = http.createServer((req, res) => {
	if (req.method === "POST" && String(req.url ?? "").endsWith("/v1/messages")) { req.resume(); req.on("end", () => searchingAnswer(res)); return; }
	if (req.method !== "POST" || !String(req.url ?? "").endsWith("/chat/completions")) { res.writeHead(404).end(); return; }
	let body = "";
	req.on("data", (chunk) => { body += chunk; });
	req.on("end", async () => {
		let parsed: any = {};
		try { parsed = JSON.parse(body); } catch {}
		const messages: any[] = Array.isArray(parsed?.messages) ? parsed.messages : [];
		const toolMessages = messages.filter((m) => m?.role === "tool");
		const newestTool = toolMessages.at(-1)?.content;
		lastToolResult = typeof newestTool === "string" ? newestTool : Array.isArray(newestTool) ? newestTool.map((part: any) => String(part?.text ?? "")).join("") : "";
		gatewayLog.push(script[toolMessages.length]?.fail ? "fail" : Array.isArray(parsed?.tools) && parsed.tools.length > 0 && script[toolMessages.length] ? script[toolMessages.length].name : "text");
		// A scripted failure: the model call itself fails, so the turn ends with no answer.
		if (script[toolMessages.length]?.fail) { res.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({ error: { message: "scripted failure", type: "invalid_request_error" } })); return; }
		res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
		const base = { id: `cmpl_${toolMessages.length}`, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: String(parsed?.model ?? "room-model") };
		const next = Array.isArray(parsed?.tools) && parsed.tools.length > 0 ? script[toolMessages.length] : undefined;
		if (next) {
			try {
				await next.before?.();
			} catch (error) {
				hookFailure ??= error;
				res.end();
				return;
			}
			const id = `call_${toolMessages.length}`;
			res.write(sseChunk({ ...base, choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id, type: "function", function: { name: next.name, arguments: "" } }] }, finish_reason: null }] }));
			res.write(sseChunk({ ...base, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: JSON.stringify(next.args) } }] }, finish_reason: null }] }));
			res.write(sseChunk({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } }));
		} else {
			res.write(sseChunk({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: "The export runs on Fridays. The key file stayed closed." }, finish_reason: null }] }));
			res.write(sseChunk({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 150, completion_tokens: 12, total_tokens: 162 } }));
		}
		res.write("data: [DONE]\n\n");
		res.end();
	});
});

const WebSocketImpl: any = (await import("ws")).default;
let serverProcess: ChildProcessWithoutNullStreams | undefined;
const serverOutput: string[] = [];
let port = 0;
async function json(pathname: string, init: AuthedFetchInit = {}): Promise<{ status: number; body: any }> {
	const response = await authedFetch(`http://127.0.0.1:${port}${pathname}`, { ...init, headers: { ...(init.body ? { "content-type": "application/json" } : {}), ...init.headers } });
	const text = await response.text();
	return { status: response.status, body: text ? JSON.parse(text) : null };
}
const read = (p: string, before?: () => void | Promise<void>): ScriptedCall => ({ name: "read", args: { path: p }, ...(before ? { before } : {}) });
const steps = (items: any[]) => items.filter((item) => item.kind === "tool").map((item) => `${item.name}:${item.status}`).join(",");

try {
	await new Promise<void>((resolve) => gateway.listen(0, "127.0.0.1", resolve));
	const gatewayPort = (gateway.address() as AddressInfo).port;
	for (const dir of [agentsRoot, agentDir, appRoot]) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
	fs.writeFileSync(path.join(agentDir, "models.json"), JSON.stringify({ providers: { "openai-compatible": { name: "Synthetic Gateway", baseUrl: `http://127.0.0.1:${gatewayPort}/v1`, api: "openai-completions", models: [{ id: "room-model", name: "Room Model", contextWindow: 128000, maxTokens: 16384 }] }, [SEARCH.provider]: { baseUrl: `http://127.0.0.1:${gatewayPort}` } } }, null, 2), { mode: 0o600 });
	fs.writeFileSync(path.join(agentDir, "auth.json"), JSON.stringify({ "openai-compatible": { type: "api_key", key: "synthetic-away-steps" }, [SEARCH.provider]: { type: "api_key", key: "synthetic-away-search" } }, null, 2), { mode: 0o600 });
	fs.writeFileSync(path.join(appRoot, "openai-compatible-ai-profile.json"), JSON.stringify({ profileId: "openai-compatible", providerId: "openai-compatible", label: "Synthetic Gateway", roomModels: [{ modelId: "room-model", label: "Room Model" }], maintenanceModel: "room-model" }, null, 2), { mode: 0o600 });
	fs.writeFileSync(path.join(appRoot, "persistent-agent-ai-profile.json"), JSON.stringify({ profileId: "openai-compatible" }, null, 2), { mode: 0o600 });

	port = await freePort();
	serverProcess = spawn("npx", ["tsx", "src/index.ts"], {
		shell: process.platform === "win32",
		...SMOKE_SERVER_SPAWN_TREE_OPTIONS,
		cwd: webServerDir,
		env: { ...process.env, ...smokeHomeEnv(home), EXXPERTS_CODING_AGENT_DIR: agentDir, EXXETA_PERSISTENT_AGENTS_ROOT: agentsRoot, PORT: String(port), ...SMOKE_SERVER_AUTH_ENV, EXXETA_HOME: repoRoot, EXXPERTS_REMOTE_TEST_ADDRESS: "::1" } as NodeJS.ProcessEnv,
	});
	serverProcess.stdout.on("data", (chunk) => serverOutput.push(String(chunk)));
	serverProcess.stderr.on("data", (chunk) => serverOutput.push(String(chunk)));
	const ready = Date.now() + 20_000;
	for (;;) {
		assert(Date.now() < ready, "the server came up");
		try { if ((await fetch(`http://127.0.0.1:${port}/healthz`)).ok) break; } catch {}
		await new Promise((resolve) => setTimeout(resolve, 150));
	}
	const created = await json("/api/persistent-agents", { method: "POST", body: JSON.stringify({ displayName: "Away Steps Room", userName: "Synthetic User", preferredUserAddress: "Synthetic User" }) });
	const room = String(created.body?.agent?.id ?? created.body?.agent?.agentId ?? "");
	assert(created.status === 201 && room, `room created, got ${created.status}`);
	const workspace = await json(`/api/persistent-agents/${encodeURIComponent(room)}/workspace-default`, { method: "PUT", body: JSON.stringify({ root: workspaceRoot, displayLabel: "Away Workspace", workspaceAccessMode: "localFiles", bashEnabled: false }) });
	assert(workspace.status === 200, `workspace set, got ${workspace.status}`);

	// --- 2. The person leaves while the turn runs: the landing keeps both reads before the answer.
	const conversationId = "conv-away";
	const seeded = await json(`/api/persistent-agents/${encodeURIComponent(room)}/threads/${conversationId}`, { method: "PUT", body: JSON.stringify({ state: "active", origin: "launcher", model: { provider: "openai-compatible", model: "room-model" }, items: [] }) });
	assert(seeded.status === 200, `thread seeded, got ${seeded.status}`);
	const socket = new WebSocketImpl(`ws://127.0.0.1:${port}/ws?persistentAgentId=${room}&conversationId=${conversationId}&modelProvider=openai-compatible&model=room-model&reattach=1`, { headers: { ...SMOKE_AUTH_HEADERS } });
	await new Promise<void>((resolve, reject) => { socket.addEventListener("open", () => resolve()); socket.addEventListener("error", () => reject(new Error("websocket failed to connect"))); });
	script = [read("notes.txt"), read("server.key", () => { try { socket.close(); } catch {} })];
	socket.send(JSON.stringify({ type: "prompt", text: "Read the notes while I step away." }));
	const landedBy = Date.now() + 60_000;
	let items: any[] = [];
	for (;;) {
		assert(Date.now() < landedBy, `the answer landed while nobody watched, items ${JSON.stringify(items.map((item) => item.id))}`);
		const thread = await json(`/api/persistent-agents/${encodeURIComponent(room)}/threads/${conversationId}`);
		items = thread.body?.thread?.items ?? thread.body?.items ?? [];
		if (items.some((item) => String(item.id ?? "").startsWith("detached-assistant-"))) break;
		await new Promise((resolve) => setTimeout(resolve, 150));
	}
	assert(steps(items) === "read:done,read:error", `the landing keeps the read and the refused read, got ${steps(items)} in ${JSON.stringify(items.map((item) => `${item.kind}:${item.id}`))}`);
	const firstStep = items.findIndex((item) => item.kind === "tool");
	const answer = items.findIndex((item) => String(item.id ?? "").startsWith("detached-assistant-"));
	assert(firstStep >= 0 && firstStep < answer && items[firstStep - 1]?.kind === "user", `the steps sit between the prompt and the answer, got ${JSON.stringify(items.map((item) => item.kind))}`);
	const doneRead = items[firstStep];
	assert(String(doneRead.result ?? "").includes("NOTES-NEEDLE") && doneRead.args?.path === "notes.txt", `the done read keeps its result, got ${JSON.stringify(doneRead).slice(0, 300)}`);
	assert(String(items[firstStep + 1].result ?? "").includes("server.key") && items[firstStep + 1].args?.path === "server.key", `the refused read keeps what the room was told, got ${JSON.stringify(items[firstStep + 1]).slice(0, 300)}`);
	console.log("ok 2 a turn that landed while the person was away keeps its steps");
	// A save the page sent before the landing arrives after it: the landed prompt, steps and answer stay, once each.
	const threadPath = `/api/persistent-agents/${encodeURIComponent(room)}/threads/${conversationId}`;
	const stale = await json(threadPath, { method: "PUT", body: JSON.stringify({ state: "active", origin: "launcher", model: { provider: "openai-compatible", model: "room-model" }, items: [] }) });
	assert(stale.status === 200, `the stale save is taken, got ${stale.status}`);
	const afterStale: any[] = (await json(threadPath)).body?.thread?.items ?? [];
	assert(steps(afterStale) === "read:done,read:error" && afterStale.findIndex((item) => item.kind === "tool") < afterStale.findIndex((item) => String(item.id ?? "").startsWith("detached-assistant-")), `a stale save keeps the landed steps before the answer, got ${JSON.stringify(afterStale.map((item) => `${item.kind}:${item.id}`))}`);
	const own = await json(threadPath, { method: "PUT", body: JSON.stringify({ state: "active", origin: "launcher", model: { provider: "openai-compatible", model: "room-model" }, items: [{ kind: "user", id: "u-own", text: "Read the notes while I step away." }, { kind: "tool", id: "call-own", name: "read", args: { path: "notes.txt" }, status: "running" }] }) });
	assert(own.status === 200, `the save with the page's own step is taken, got ${own.status}`);
	const afterOwn: any[] = (await json(threadPath)).body?.thread?.items ?? [];
	assert(steps(afterOwn) === "read:done,read:error", `the page's running copy gives way to the landed steps, once each and finished, got ${JSON.stringify(afterOwn.map((item) => `${item.kind}:${item.id}:${item.status ?? ""}`))}`);
	assert(String(afterOwn.find((item) => item.kind === "tool")?.result ?? "").includes("NOTES-NEEDLE"), "the finished read keeps its result");
	console.log("ok 2b a stale save keeps the landed steps, finished, and never doubles the page's own");

	// --- 2c. The room asks to run a command, the page keeps the card, the person leaves, and the next model
	// call fails, so the turn ends with no answer: the step of the command says it did not run, after the card.
	const commandCreated = await json("/api/persistent-agents", { method: "POST", body: JSON.stringify({ displayName: "Away Command Room", userName: "Synthetic User", preferredUserAddress: "Synthetic User" }) });
	const commandRoom = String(commandCreated.body?.agent?.id ?? commandCreated.body?.agent?.agentId ?? "");
	assert(commandCreated.status === 201 && commandRoom, `the command room was created, got ${commandCreated.status}`);
	const commandWorkspace = await json(`/api/persistent-agents/${encodeURIComponent(commandRoom)}/workspace-default`, { method: "PUT", body: JSON.stringify({ root: workspaceRoot, displayLabel: "Away Workspace", workspaceAccessMode: "localFiles", bashEnabled: true }) });
	assert(commandWorkspace.status === 200, `Full access with the terminal on, got ${commandWorkspace.status}`);
	const commandThread = `/api/persistent-agents/${encodeURIComponent(commandRoom)}/threads/conv-command`;
	const commandModel = { provider: "openai-compatible", model: "room-model" };
	assert((await json(commandThread, { method: "PUT", body: JSON.stringify({ state: "active", origin: "launcher", model: commandModel, items: [] }) })).status === 200, "the command thread was seeded");
	const commandSocket = new WebSocketImpl(`ws://127.0.0.1:${port}/ws?persistentAgentId=${commandRoom}&conversationId=conv-command&modelProvider=openai-compatible&model=room-model&reattach=1`, { headers: { ...SMOKE_AUTH_HEADERS } });
	await new Promise<void>((resolve, reject) => { commandSocket.addEventListener("open", () => resolve()); commandSocket.addEventListener("error", () => reject(new Error("websocket failed to connect"))); });
	const asked = new Promise<any>((resolve) => commandSocket.addEventListener("message", (event: any) => { try { const frame = JSON.parse(String(event.data)); if (frame?.type === "ui_request" && frame.kind === "confirm") resolve(frame); } catch {} }));
	script = [{ name: "bash", args: { command: "rm report-old.txt" } }, { name: "", args: {}, fail: true }];
	commandSocket.send(JSON.stringify({ type: "prompt", text: "Remove the old report while I close the window." }));
	const question = await Promise.race([asked, new Promise<never>((_, reject) => setTimeout(() => reject(new Error("the room never asked to run the command")), 30_000))]);
	const keptCard = { kind: "approval", id: "card-command", requestId: question.id, uiKind: "confirm", title: question.title, message: question.message };
	assert((await json(commandThread, { method: "PUT", body: JSON.stringify({ state: "active", origin: "launcher", model: commandModel, items: [{ kind: "user", id: "u-command", text: "Remove the old report while I close the window." }, keptCard] }) })).status === 200, "the page's save with the card is taken");
	commandSocket.close();
	// A landing nobody watched leaves the conversation on standby.
	const commandLandedBy = Date.now() + 60_000;
	let commandItems: any[] = [];
	for (;;) {
		assert(Date.now() < commandLandedBy, `the turn with no answer landed, items ${JSON.stringify(commandItems.map((item) => `${item.kind}:${item.id}`))}, the gateway answered ${gatewayLog.join(",")}`);
		const thread = (await json(commandThread)).body?.thread;
		commandItems = thread?.items ?? [];
		if (thread?.state === "standby") break;
		await new Promise((resolve) => setTimeout(resolve, 150));
	}
	assert(gatewayLog.slice(-2).join(",") === "bash,fail", `the room asked for the command, then its next model call failed, got ${gatewayLog.join(",")}`);
	const commandStep = commandItems.find((item) => item.kind === "tool" && item.name === "bash");
	assert(commandStep?.status === "error" && String(commandStep.result ?? "").startsWith("The user left the room"), `a turn with no answer keeps the step of the command nobody approved, got ${steps(commandItems) || "(none)"} in ${JSON.stringify(commandItems.map((item) => `${item.kind}:${item.id}`))}`);
	assert(commandItems.findIndex((item) => item.id === "card-command") < commandItems.indexOf(commandStep) && !commandItems.some((item) => item.kind === "assistant"), `the card, then the step, and no answer, got ${JSON.stringify(commandItems.map((item) => `${item.kind}:${item.id}`))}`);
	// The page's last save, sent before it closed, arrives after the landing: the landed step stays.
	assert((await json(commandThread, { method: "PUT", body: JSON.stringify({ state: "active", origin: "launcher", model: commandModel, items: [{ kind: "user", id: "u-command", text: "Remove the old report while I close the window." }, keptCard] }) })).status === 200, "the late save is taken");
	const afterLate: any[] = (await json(commandThread)).body?.thread?.items ?? [];
	assert(steps(afterLate) === "bash:error" && afterLate.findIndex((item) => item.id === "card-command") < afterLate.findIndex((item) => item.kind === "tool"), `a late save keeps the landed step after the card, got ${JSON.stringify(afterLate.map((item) => `${item.kind}:${item.id}`))}`);
	console.log("ok 2c a turn that failed after a question nobody answered keeps that question's step, a late save too");
	// The page stays open and the person goes on: each later save keeps the landed step under its own message, and the new turn's step under the new one.
	const firstPrompt = { kind: "user", id: "u-command", text: "Remove the old report while I close the window." };
	const secondTurn = [{ kind: "user", id: "u-next", text: "Now list the folder." }, { kind: "tool", id: "call-next", name: "ls", args: { path: "." }, status: "done", result: "notes.txt" }];
	const placed = (list: any[]) => list.map((item) => `${item.kind}:${item.kind === "tool" ? item.name : item.id}`).join(" ");
	assert((await json(commandThread, { method: "PUT", body: JSON.stringify({ state: "active", origin: "launcher", model: commandModel, items: [firstPrompt, keptCard, ...secondTurn] }) })).status === 200, "the save with a second message is taken");
	const afterNext: any[] = (await json(commandThread)).body?.thread?.items ?? [];
	assert(placed(afterNext) === "user:u-command approval:card-command tool:bash user:u-next tool:ls", `a later save keeps the landed step under its own message and the new step under the new one, got ${placed(afterNext)}`);
	const pageCopy = { ...commandStep, id: "call-own-bash" };
	assert((await json(commandThread, { method: "PUT", body: JSON.stringify({ state: "active", origin: "launcher", model: commandModel, items: [firstPrompt, keptCard, pageCopy, ...secondTurn, { kind: "assistant", id: "a-next", text: "The folder holds notes.txt." }] }) })).status === 200, "the save with the page's own copy is taken");
	const afterCopy: any[] = (await json(commandThread)).body?.thread?.items ?? [];
	assert(placed(afterCopy) === "user:u-command approval:card-command tool:bash user:u-next tool:ls assistant:a-next", `the page's own finished copy stands in for the landed step, once, got ${placed(afterCopy)}`);
	// A page copy stopped by an interruption does not stand for a step that finished after it: the landed result stays.
	const stoppedThread = `/api/persistent-agents/${encodeURIComponent(commandRoom)}/threads/conv-stopped-copy`;
	const stoppedPrompt = { kind: "user", id: "u-stopped", text: "Clean the folder." };
	const cleanArgs = { command: "rm old.txt" };
	assert((await json(stoppedThread, { method: "PUT", body: JSON.stringify({ state: "active", origin: "launcher", model: commandModel, items: [stoppedPrompt, { kind: "tool", id: "detached-step-stopped-1", name: "bash", args: cleanArgs, status: "done", result: "removed old.txt" }] }) })).status === 200, "the landed finished step was saved");
	assert((await json(stoppedThread, { method: "PUT", body: JSON.stringify({ state: "active", origin: "launcher", model: commandModel, items: [stoppedPrompt, { kind: "tool", id: "call-stopped", name: "bash", args: cleanArgs, status: "stopped" }] }) })).status === 200, "the save with the page's stopped copy is taken");
	const afterStopped: any[] = (await json(stoppedThread)).body?.thread?.items ?? [];
	assert(steps(afterStopped) === "bash:done" && afterStopped.find((item) => item.kind === "tool")?.result === "removed old.txt", `a stopped page copy gives way to the landed finished step, once, got ${JSON.stringify(afterStopped.map((item) => `${item.kind}:${item.id}:${item.status ?? ""}`))}`);
	// Steps landed with no message before them keep their old place: after the newest message.
	const orphanThread = `/api/persistent-agents/${encodeURIComponent(commandRoom)}/threads/conv-orphan`;
	assert((await json(orphanThread, { method: "PUT", body: JSON.stringify({ state: "active", origin: "launcher", model: commandModel, items: [{ kind: "tool", id: "detached-step-orphan-1", name: "ls", args: { path: "." }, status: "done", result: "notes.txt" }] }) })).status === 200, "the steps with no message were saved");
	assert((await json(orphanThread, { method: "PUT", body: JSON.stringify({ state: "active", origin: "launcher", model: commandModel, items: [{ kind: "user", id: "u-orphan", text: "List the folder." }] }) })).status === 200, "the save after them is taken");
	const afterOrphan: any[] = (await json(orphanThread)).body?.thread?.items ?? [];
	assert(placed(afterOrphan) === "user:u-orphan tool:ls", `steps with no message before them go after the newest message, got ${placed(afterOrphan)}`);
	console.log("ok 2d later saves keep each turn's steps under its own message");

	// --- 2e. The person leaves mid-turn and comes back while it still works: the room's next command asks
	// them. A second tab that takes the room over gets the open card, and only its answer counts.
	// With a device cookie the window opens from a paired device through the remote address.
	const openRoomSocket = async (conversation: string, deviceCookie?: string) => {
		const query = `persistentAgentId=${commandRoom}&conversationId=${conversation}&modelProvider=openai-compatible&model=room-model&reattach=1`;
		const ws = deviceCookie
			? new WebSocketImpl(`ws://[::1]:${port}/ws?${query}`, { headers: { Origin: `http://[::1]:${port}`, Cookie: deviceCookie } })
			: new WebSocketImpl(`ws://127.0.0.1:${port}/ws?${query}`, { headers: { ...SMOKE_AUTH_HEADERS } });
		const frames: any[] = [];
		ws.addEventListener("message", (event: any) => { try { frames.push(JSON.parse(String(event.data))); } catch {} });
		await new Promise<void>((resolve, reject) => { ws.addEventListener("open", () => resolve()); ws.addEventListener("error", () => reject(new Error("websocket failed to connect"))); });
		const waitFor = async (match: (frame: any) => boolean, label: string): Promise<any> => {
			const by = Date.now() + 30_000;
			for (;;) {
				if (hookFailure) throw hookFailure;
				const found = frames.find(match);
				if (found) return found;
				assert(Date.now() < by, `${label}; frames ${frames.map((frame) => frame.type).join(",")}, the gateway answered ${gatewayLog.join(",")}`);
				await new Promise((resolve) => setTimeout(resolve, 50));
			}
		};
		return { ws, frames, waitFor };
	};
	const waitDetached = async () => {
		const detachedBy = Date.now() + 10_000;
		for (;;) {
			const rooms = await json("/api/persistent-agents");
			const list: any[] = rooms.body?.agents ?? rooms.body ?? [];
			if (list.some((row) => row.id === commandRoom && row.answeringDetached === true)) return;
			assert(Date.now() < detachedBy, "the turn went on with nobody in the room");
			await new Promise((resolve) => setTimeout(resolve, 50));
		}
	};
	const returnConversation = "conv-return";
	assert((await json(`/api/persistent-agents/${encodeURIComponent(commandRoom)}/threads/${returnConversation}`, { method: "PUT", body: JSON.stringify({ state: "active", origin: "launcher", model: commandModel, items: [] }) })).status === 200, "the return thread was seeded");
	const leaving = await openRoomSocket(returnConversation);
	await leaving.waitFor((frame) => frame.type === "ready", "the first window is ready");
	let returned: Awaited<ReturnType<typeof openRoomSocket>> | undefined;
	// The first leg holds the turn while the person leaves and comes back.
	script = [read("notes.txt", async () => {
		leaving.ws.close();
		await waitDetached();
		returned = await openRoomSocket(returnConversation);
		await returned.waitFor((frame) => frame.type === "turn_reattach_replay_done", "the returning window took the turn over");
	}), { name: "bash", args: { command: "ls" } }];
	leaving.ws.send(JSON.stringify({ type: "prompt", text: "Read the notes, then list the folder." }));
	const returnedCard = await (async () => {
		const by = Date.now() + 30_000;
		while (!returned) { if (hookFailure) throw hookFailure; assert(Date.now() < by, "the person came back"); await new Promise((resolve) => setTimeout(resolve, 50)); }
		return returned.waitFor((frame) => frame.type === "ui_request" && frame.kind === "confirm", "the command card reached the person who came back");
	})();
	assert(String(returnedCard.message ?? "").includes("ls"), `the card names the command, got ${JSON.stringify(returnedCard)}`);
	assert(!leaving.frames.some((frame) => frame.type === "ui_request" && frame.kind === "confirm"), "the window that left never got the card");
	const takeover = await openRoomSocket(returnConversation);
	const movedCard = await takeover.waitFor((frame) => frame.type === "ui_request" && frame.kind === "confirm", "the open card is asked again in the tab that came back last");
	assert(movedCard.id === returnedCard.id && movedCard.message === returnedCard.message, `the same question moves, got ${JSON.stringify(movedCard)}`);
	const replayDone = takeover.frames.findIndex((frame) => frame.type === "turn_reattach_replay_done");
	assert(replayDone >= 0 && replayDone < takeover.frames.indexOf(movedCard), "the card comes after the replay, so the page shows it live");
	await returned!.waitFor((frame) => frame.type === "error" && frame.code === "room_displaced", "the displaced window is told");
	returned!.ws.send(JSON.stringify({ type: "ui_response", id: returnedCard.id, value: false }));
	takeover.ws.send(JSON.stringify({ type: "ui_response", id: movedCard.id, value: true }));
	await takeover.waitFor((frame) => frame.type === "event" && frame.event?.type === "agent_end", "the turn ended in the tab that answered");
	assert(gatewayLog.slice(-3).join(",") === "read,bash,text" && lastToolResult.includes("notes.txt"), `the approved command ran (the displaced window's decline did not count), got ${gatewayLog.join(",")} with ${JSON.stringify(lastToolResult.slice(0, 200))}`);
	returned!.ws.close();
	takeover.ws.close();
	console.log("ok 2e a person who comes back mid-answer gets the command card, and the tab that came back last answers it");

	// --- 2f. A viewing-only device comes back mid-answer: it cannot answer, so the room's next command is
	// declined at once with the words for a room nobody is in, as before anyone came back.
	assert((await json("/api/remote/enable", { method: "POST" })).status === 200, "remote access is on");
	const viewerCookie = (await pairDevice(port, "Viewing phone", "read-only")).cookie;
	const viewConversation = "conv-view";
	await waitForTurnSettled(json, commandRoom, `${returnConversation}: the turn has settled before the next seed`);
	assert((await json(`/api/persistent-agents/${encodeURIComponent(commandRoom)}/threads/${viewConversation}`, { method: "PUT", body: JSON.stringify({ state: "active", origin: "launcher", model: commandModel, items: [] }) })).status === 200, "the viewing thread was seeded");
	const writer = await openRoomSocket(viewConversation);
	await writer.waitFor((frame) => frame.type === "ready", "the computer's window is ready");
	let viewing: Awaited<ReturnType<typeof openRoomSocket>> | undefined;
	script = [read("notes.txt", async () => {
		writer.ws.close();
		await waitDetached();
		viewing = await openRoomSocket(viewConversation, viewerCookie);
		await viewing.waitFor((frame) => frame.type === "turn_reattach_replay_done", "the viewing-only device watches the turn");
	}), { name: "bash", args: { command: "ls" } }];
	writer.ws.send(JSON.stringify({ type: "prompt", text: "Read the notes, then list the folder." }));
	const viewedBy = Date.now() + 30_000;
	while (!viewing) { if (hookFailure) throw hookFailure; assert(Date.now() < viewedBy, "the viewing-only device came back"); await new Promise((resolve) => setTimeout(resolve, 50)); }
	await viewing.waitFor((frame) => frame.type === "event" && frame.event?.type === "agent_end", "the command was declined at once and the turn ended");
	assert(!viewing.frames.some((frame) => frame.type === "ui_request" && frame.kind === "confirm"), "the viewing-only device got no card it cannot answer");
	assert(gatewayLog.slice(-3).join(",") === "read,bash,text" && lastToolResult.startsWith("The user left the room"), `the room was told nobody is there to approve, got ${gatewayLog.join(",")} with ${JSON.stringify(lastToolResult.slice(0, 200))}`);
	viewing.ws.close();
	console.log("ok 2f a viewing-only device that comes back mid-answer leaves the room's questions declined as if nobody were there");
	// --- 2g. The same with a keyed turn (thread-items-by-id.ts): the watched landing writes the declined question's notice under the turn's key;
	// a turn whose page kept the card gets none.
	const keyedView = "conv-view-keyed";
	await waitForTurnSettled(json, commandRoom, `${viewConversation}: the turn has settled before the next seed`);
	const keyedViewThread = `/api/persistent-agents/${encodeURIComponent(commandRoom)}/threads/${keyedView}`;
	assert((await json(keyedViewThread, { method: "PUT", body: JSON.stringify({ state: "active", origin: "launcher", model: commandModel, items: [] }) })).status === 200, "the keyed viewing thread was seeded");
	const keyedWriter = await openRoomSocket(keyedView);
	await keyedWriter.waitFor((frame) => frame.type === "ready", "the computer's window is ready for the keyed turn");
	let keyedViewing: Awaited<ReturnType<typeof openRoomSocket>> | undefined;
	script = [read("notes.txt", async () => {
		keyedWriter.ws.close();
		await waitDetached();
		keyedViewing = await openRoomSocket(keyedView, viewerCookie);
		await keyedViewing.waitFor((frame) => frame.type === "turn_reattach_replay_done", "the viewing-only device watches the keyed turn");
	}), { name: "bash", args: { command: "ls" } }];
	const keyedAsk = "Read the notes, then list the folder, keyed.";
	keyedWriter.ws.send(JSON.stringify({ type: "prompt", text: keyedAsk, id: "kv2g", shown: { text: keyedAsk, files: [] } }));
	const keyedViewedBy = Date.now() + 30_000;
	while (!keyedViewing) { if (hookFailure) throw hookFailure; assert(Date.now() < keyedViewedBy, "the viewing-only device came back to the keyed turn"); await new Promise((resolve) => setTimeout(resolve, 50)); }
	await keyedViewing.waitFor((frame) => frame.type === "event" && frame.event?.type === "agent_end", "the keyed command was declined and the turn ended");
	keyedViewing.ws.close();
	await waitForTurnSettled(json, commandRoom, `${keyedView}: the keyed turn has settled`);
	const keyedViewItems: any[] = (await json(keyedViewThread)).body?.thread?.items ?? [];
	const keyedNotice = keyedViewItems.find((item) => item.id === "kv2g-declined-1");
	assert(keyedNotice?.kind === "system" && String(keyedNotice.text).includes("asked to run a command") && keyedNotice.landed === true, `the watched keyed landing writes the notice, got ${JSON.stringify(keyedViewItems.map((item) => `${item.kind}:${item.id}`))}`);
	assert(keyedViewItems.findIndex((item) => item.id === "kv2g") < keyedViewItems.indexOf(keyedNotice), "after its question");
	// The page showed the card and kept it: the notice would say again what the card says.
	const keptView = "conv-kept-keyed";
	const keptThread = `/api/persistent-agents/${encodeURIComponent(commandRoom)}/threads/${keptView}`;
	assert((await json(keptThread, { method: "PUT", body: JSON.stringify({ state: "active", origin: "launcher", model: commandModel, items: [] }) })).status === 200, "the kept-card thread was seeded");
	const keptSocket = await openRoomSocket(keptView);
	await keptSocket.waitFor((frame) => frame.type === "ready", "the kept-card window is ready");
	script = [{ name: "bash", args: { command: "rm report-old.txt" } }, { name: "", args: {}, fail: true }];
	const keptAsk = "Remove the old report while I close the window, keyed.";
	keptSocket.ws.send(JSON.stringify({ type: "prompt", text: keptAsk, id: "kv2h", shown: { text: keptAsk, files: [] } }));
	const keptQuestion = await keptSocket.waitFor((frame) => frame.type === "ui_request" && frame.kind === "confirm", "the room asks to run the command");
	assert((await json(keptThread, { method: "PUT", body: JSON.stringify({ state: "active", origin: "launcher", model: commandModel, items: [{ kind: "user", id: "kv2h", text: keptAsk }, { kind: "approval", id: "card-kept", requestId: keptQuestion.id, uiKind: "confirm", title: keptQuestion.title, message: keptQuestion.message }] }) })).status === 200, "the page's save with the card is taken");
	keptSocket.ws.close();
	await waitForTurnSettled(json, commandRoom, `${keptView}: the kept-card turn has settled`);
	const keptItems: any[] = (await json(keptThread)).body?.thread?.items ?? [];
	assert(keptItems.some((item) => item.id === "card-kept") && keptItems.some((item) => item.id === "kv2h-t1") && !keptItems.some((item) => String(item.id).startsWith("kv2h-declined-")), `the card stays and no notice lands beside it, got ${JSON.stringify(keptItems.map((item) => `${item.kind}:${item.id}`))}`);
	console.log("ok 2g a keyed turn's declined question gets its notice when nobody could answer, and none beside a kept card");
	// The searching model is offered to rooms, for row 3b's scheduled run.
	const approved = await json("/api/persistent-agent-ai-profiles/custom", { method: "PUT", body: JSON.stringify({ providerId: SEARCH.provider, label: "Claude API key", roomModels: [SEARCH.model], learnModel: SEARCH.model }) });
	assert(approved.status === 200, `the search model is approved, got ${approved.status}`);
	await stopSmokeServer(serverProcess);
	serverProcess = undefined;

	// --- 3. A scheduled run keeps its steps too, before its answer.
	Object.assign(process.env, { HOME: home, USERPROFILE: home, EXXPERTS_CODING_AGENT_DIR: agentDir, EXXETA_PERSISTENT_AGENTS_ROOT: agentsRoot, EXXETA_HOME: repoRoot });
	const background = await import("../src/persistent-room-background-execution.js");
	const { getPersistentAgentThread } = await import("../src/persistent-agents.js");
	script = [read("notes.txt"), read("server.key")];
	await background.executePersistentRoomBackgroundPrompt({
		roomId: room,
		target: { kind: "fresh-thread", model: { provider: "openai-compatible", model: "room-model" } },
		prompt: "Check the notes.",
		executionId: "away-steps-scheduled",
		cwd: workspaceRoot,
		agentDir,
	} as any);
	const scheduledItems: any[] = getPersistentAgentThread(room, background.scheduledPromptBackgroundThreadId("away-steps-scheduled"))?.items ?? [];
	assert(steps(scheduledItems) === "read:done,read:error", `a scheduled run keeps its steps, got ${steps(scheduledItems)} in ${JSON.stringify(scheduledItems.map((item) => item.id))}`);
	const scheduledAnswer = scheduledItems.findIndex((item) => item.id === background.scheduledPromptBackgroundAssistantItemId("away-steps-scheduled"));
	const scheduledFirstStep = scheduledItems.findIndex((item) => item.kind === "tool");
	assert(scheduledFirstStep > 0 && scheduledFirstStep < scheduledAnswer && scheduledItems[0].kind === "user", `the scheduled steps sit between the prompt and the answer, got ${JSON.stringify(scheduledItems.map((item) => item.kind))}`);
	console.log("ok 3 a scheduled run keeps its steps");

	// --- 3b. A scheduled run whose model searches the web itself keeps that search among its steps, before its answer.
	await background.executePersistentRoomBackgroundPrompt({
		roomId: room,
		target: { kind: "fresh-thread", model: SEARCH },
		prompt: "Which Node line is LTS?",
		executionId: "away-steps-search",
		cwd: workspaceRoot,
		agentDir,
	} as any);
	const searchItems: any[] = getPersistentAgentThread(room, background.scheduledPromptBackgroundThreadId("away-steps-search"))?.items ?? [];
	const searchStep = searchItems.find((item) => item.kind === "tool");
	assert(steps(searchItems) === "web_search:done" && JSON.stringify(searchStep?.args) === JSON.stringify({ query: "node lts" }), `a scheduled run keeps the provider's search with its query, got ${JSON.stringify(searchItems)}`);
	const searchAnswer = searchItems.findIndex((item) => item.id === background.scheduledPromptBackgroundAssistantItemId("away-steps-search"));
	assert(searchItems.indexOf(searchStep) > 0 && searchItems.indexOf(searchStep) < searchAnswer && String(searchItems[searchAnswer]?.text ?? "").includes("Node.js 24"), `the search sits between the prompt and the answer, got ${JSON.stringify(searchItems.map((item) => item.kind))}`);
	console.log("ok 3b a scheduled run whose model searches keeps the search");

	// --- 4. A thread an older version saved with the answer twice (the client's copy and the landing) reads it once.
	const { writePersistentAgentThread } = await import("../src/persistent-agents.js");
	const answerText = "The export runs on Fridays.\n\nThe key file stayed closed.";
	writePersistentAgentThread(room, "conv-doubled", { state: "standby", origin: "launcher", model: { provider: "openai-compatible", model: "room-model" }, items: [
		{ kind: "user", id: "u-1", text: "When is the export?" },
		{ kind: "assistant", id: "a-1", text: "An earlier answer." },
		{ kind: "user", id: "u-2", text: "And the key?" },
		{ kind: "assistant", id: "stream_1_abc", text: "The export runs on Fridays. The key file stayed closed. " },
		{ kind: "assistant", id: "detached-assistant-turn_x", text: answerText },
		{ kind: "user", id: "u-3", text: "Thanks." },
		{ kind: "assistant", id: "a-3", text: "The export runs on Fridays." },
	] } as any, { allowInactiveProfileModel: true });
	const healed = (getPersistentAgentThread(room, "conv-doubled")?.items ?? []).map((item: any) => item.id);
	assert(JSON.stringify(healed) === JSON.stringify(["u-1", "a-1", "u-2", "detached-assistant-turn_x", "u-3", "a-3"]), `a doubled landed answer reads once, and other turns are untouched, got ${JSON.stringify(healed)}`);
	console.log("ok 4 a doubled landed answer reads once");
	console.log("persistent-room-away-steps-smoke: OK");
} catch (error) {
	console.error(serverOutput.join("").slice(-6000));
	throw error;
} finally {
	try { gateway.close(); } catch {}
	await stopSmokeServer(serverProcess);
	fs.rmSync(tempRoot, { recursive: true, force: true });
}
