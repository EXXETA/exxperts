import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { authedFetch, freePort, smokeHomeEnv, SMOKE_AUTH_HEADERS, SMOKE_SERVER_AUTH_ENV, SMOKE_SERVER_SPAWN_TREE_OPTIONS, stopSmokeServer, type AuthedFetchInit } from "./smoke-server-process.js";

// A turn that finishes with nobody in the room keeps its steps: the reads it
// made, the one it was refused, and a call that never got its result, saved
// as done, failed or stopped cards before the answer. The same for a
// scheduled run, and a turn that failed after a question nobody answered. And a thread saved with a landed answer twice reads it once. A real server with a synthetic gateway that plays the model,
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
	const items = log.items("away-step-t1");
	const shape = items.map((item) => `${item.name}:${item.status}`).join(",");
	assert(shape === "read:done,memory_recall:done,delegate_task:error,read:stopped,memory_edit:error", `the saved steps follow the live rules, got ${shape}`);
	assert(items.every((item, index) => item.kind === "tool" && item.id === `away-step-t1-${index + 1}`), `each step has its own id, got ${JSON.stringify(items.map((item) => item.id))}`);
	assert(items[0].result === "the notes" && (items[0].details as any)?.lines === 1 && JSON.stringify(items[0].args) === JSON.stringify({ path: "notes.txt" }), `a done step keeps its result, details and arguments, got ${JSON.stringify(items[0])}`);
	assert(items[3].result === undefined, "a stopped step has no result");
	console.log("ok 1 the step log keeps what the live page shows");
}

// --- The synthetic gateway plays the model: each leg calls the next scripted tool.
interface ScriptedCall { name: string; args: Record<string, unknown>; before?: () => void; fail?: boolean }
let script: ScriptedCall[] = [];
// What the gateway answered, leg by leg, for a timeout's message.
const gatewayLog: string[] = [];
const sseChunk = (payload: unknown): string => `data: ${JSON.stringify(payload)}\n\n`;
const gateway = http.createServer((req, res) => {
	if (req.method !== "POST" || !String(req.url ?? "").endsWith("/chat/completions")) { res.writeHead(404).end(); return; }
	let body = "";
	req.on("data", (chunk) => { body += chunk; });
	req.on("end", () => {
		let parsed: any = {};
		try { parsed = JSON.parse(body); } catch {}
		const messages: any[] = Array.isArray(parsed?.messages) ? parsed.messages : [];
		const toolMessages = messages.filter((m) => m?.role === "tool");
		gatewayLog.push(script[toolMessages.length]?.fail ? "fail" : Array.isArray(parsed?.tools) && parsed.tools.length > 0 && script[toolMessages.length] ? script[toolMessages.length].name : "text");
		// A scripted failure: the model call itself fails, so the turn ends with no answer.
		if (script[toolMessages.length]?.fail) { res.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({ error: { message: "scripted failure", type: "invalid_request_error" } })); return; }
		res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
		const base = { id: `cmpl_${toolMessages.length}`, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: String(parsed?.model ?? "room-model") };
		const next = Array.isArray(parsed?.tools) && parsed.tools.length > 0 ? script[toolMessages.length] : undefined;
		if (next) {
			next.before?.();
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
const read = (p: string, before?: () => void): ScriptedCall => ({ name: "read", args: { path: p }, ...(before ? { before } : {}) });
const steps = (items: any[]) => items.filter((item) => item.kind === "tool").map((item) => `${item.name}:${item.status}`).join(",");

try {
	await new Promise<void>((resolve) => gateway.listen(0, "127.0.0.1", resolve));
	const gatewayPort = (gateway.address() as AddressInfo).port;
	for (const dir of [agentsRoot, agentDir, appRoot]) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
	fs.writeFileSync(path.join(agentDir, "models.json"), JSON.stringify({ providers: { "openai-compatible": { name: "Synthetic Gateway", baseUrl: `http://127.0.0.1:${gatewayPort}/v1`, api: "openai-completions", models: [{ id: "room-model", name: "Room Model", contextWindow: 128000, maxTokens: 16384 }] } } }, null, 2), { mode: 0o600 });
	fs.writeFileSync(path.join(agentDir, "auth.json"), JSON.stringify({ "openai-compatible": { type: "api_key", key: "synthetic-away-steps" } }, null, 2), { mode: 0o600 });
	fs.writeFileSync(path.join(appRoot, "openai-compatible-ai-profile.json"), JSON.stringify({ profileId: "openai-compatible", providerId: "openai-compatible", label: "Synthetic Gateway", roomModels: [{ modelId: "room-model", label: "Room Model" }], maintenanceModel: "room-model" }, null, 2), { mode: 0o600 });
	fs.writeFileSync(path.join(appRoot, "persistent-agent-ai-profile.json"), JSON.stringify({ profileId: "openai-compatible" }, null, 2), { mode: 0o600 });

	port = await freePort();
	serverProcess = spawn("npx", ["tsx", "src/index.ts"], {
		shell: process.platform === "win32",
		...SMOKE_SERVER_SPAWN_TREE_OPTIONS,
		cwd: webServerDir,
		env: { ...process.env, ...smokeHomeEnv(home), EXXPERTS_CODING_AGENT_DIR: agentDir, EXXETA_PERSISTENT_AGENTS_ROOT: agentsRoot, PORT: String(port), ...SMOKE_SERVER_AUTH_ENV, EXXETA_HOME: repoRoot } as NodeJS.ProcessEnv,
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
