// A connector's call ends when the answer is stopped, when the connector sends
// no sign of life for too long and when it runs too long in all, and the
// connector is asked to stop each time; a call that keeps reporting progress
// runs on. In a real room: a real server, a gateway that plays the model, a
// real window and a connector program of the smoke's own
// (connector-call-stand-in.mjs), reached through the mcp tool (Asana) and as
// a tool of its own (Linear). The limits are shortened by a preload only a
// smoke loads (smoke-connector-call-limits-preload.mjs). Each end shows its
// line on the step, marked as failed; an edit of the last message keeps the
// warning; a connector's own error, and a scheduled run's call, read as before.
// A conversation runs one copy of each program and ends them as it ends, a
// scheduled run's included; a tool a connector adds is asked about as any
// other, and Settings' Connectors and the room's Connectors pane, open in two
// more windows, show it once each is back in front; removing a connector ends its calls, its questions and its programs
// in every conversation; a connector's own words reach the assistant; forgetting
// a conversation doesn't wait for a program that is slow to exit, and a window
// closed during a model switch leaves no session or program of it running; the
// room's Connectors pane keeps a newer read over its slow first one; a message
// whose window closes while it waits on a rebind is still answered and saved.
// `--real-limits`: no preload, and a call that reports progress for 70 s,
// past the library's old limit of 60 s.
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type Page } from "playwright";
import { authedFetch, freePort, smokeHomeEnv, SMOKE_AUTH_HEADERS, SMOKE_AUTH_TOKEN, SMOKE_SERVER_AUTH_ENV, SMOKE_SERVER_SPAWN_TREE_OPTIONS, stopSmokeServer, waitForServer, type AuthedFetchInit } from "./smoke-server-process.js";
import { waitForTurnSettled } from "./smoke-turn-settle.js";
import { waitEvery } from "./smoke-wait.js";
import { CONNECTOR_CALL_END_RESULTS, connectorCallEndLine, type ConnectorCallEnd } from "../src/connector-call-ends.js";
import { SMOKE_CALL_LIMITS } from "./smoke-connector-call-limits-preload.mjs";

if (os.platform() === "win32") {
	console.log("SKIPPED: not yet on a real Windows PC: the stand-in's program start there is not checked yet");
	process.exit(0);
}

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

const REAL_LIMITS = process.argv.includes("--real-limits");
// The preload sets the shortened limits in this process too; the real-limits run takes them back.
if (REAL_LIMITS) delete (globalThis as { exxpertsConnectorCallLimits?: unknown }).exxpertsConnectorCallLimits;
const { silenceMs: SILENCE_MS, totalMs: TOTAL_MS } = SMOKE_CALL_LIMITS;

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const webServerDir = path.resolve(scriptDir, "..");
const repoRoot = path.resolve(webServerDir, "..", "..");
/** A connector in the room's Connectors pane whose switch reads `on`; off and enabled is a switch the save has settled. */
const inPane = (page: Page, name: string, on: boolean) => page.locator(`.room-skills-rows .room-skills-row[data-connector="${name}"]`).filter({ has: page.locator(on ? "input[role=switch]:checked" : "input[role=switch]:not(:checked):enabled") });
const standIn = path.join(scriptDir, "connector-call-stand-in.mjs");
const preload = path.join(scriptDir, "smoke-connector-call-limits-preload.mjs");
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "exxperts-connector-stop-"));
const home = path.join(tempRoot, "home");
const agentDir = path.join(home, ".exxperts", "agent");
const appRoot = path.join(home, ".exxperts", "app");
const agentsRoot = path.join(appRoot, "personalized-agents");
const MODEL = { provider: "openai-compatible", model: "room-model" };
/** The model case 16 switches a conversation to. */
const OTHER_MODEL = { provider: "openai-compatible", model: "room-model-2" };
const waitUntil = waitEvery(25, 30_000);
const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

// --- The connector program: what reached it, from its log.
const standInLog = path.join(tempRoot, "stand-in.log");
type Logged = { event: "start" | "child" | "exit" | "call" | "cancel" | "answer" | "sigterm"; name: string; pid: number; child?: number; tool?: string; id?: number; label?: string; at: number; progress?: boolean };
const logged = (): Logged[] => (fs.existsSync(standInLog) ? fs.readFileSync(standInLog, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)) : []);
const eventsOf = (label: string, event: Logged["event"]) => logged().filter((entry) => entry.label === label && entry.event === event);
/**
 * The cancel that reached the connector for `label`, waited for until `deadline`. A call ends here in the step that sends the
 * cancel, and the stand-in writes its line only once it has read it, so the line can come after the call has ended.
 */
async function cancelOf(label: string, deadline: number): Promise<Logged | undefined> {
	while (eventsOf(label, "cancel").length === 0 && Date.now() < deadline) await pause(25);
	return eventsOf(label, "cancel")[0];
}
const standInEntry = (name: string, directTools: boolean, env: Record<string, string> = {}) => ({ command: process.execPath, args: [standIn], env: { STAND_IN_LOG: standInLog, STAND_IN_NAME: name, ...env }, ...(directTools ? { directTools: true } : {}) });
const alive = (pid: number) => {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
};
/** The connector's programs still running, each with the program it started of its own, if any. */
const runningPrograms = (name: string) => {
	const children = new Map(logged().filter((entry) => entry.name === name && entry.event === "child").map((entry) => [entry.pid, entry.child!]));
	return logged().filter((entry) => entry.name === name && entry.event === "start").map((entry) => ({ pid: entry.pid, child: children.get(entry.pid) })).filter((program) => alive(program.pid) || (program.child !== undefined && alive(program.child)));
};
/** Toy space's own words to the assistant, given as it connects. */
const TOY_INSTRUCTIONS = "Toy space keeps one board per team; name the board in each call.";

// --- When the server lets each session's resources go (a session's dispose, which closes what the model's
// provider keeps for that session), written by a hook the server loads first, for case 13.
const sessionEndsLog = path.join(tempRoot, "session-ends.log");
const SESSION_ENDS_HOOK = `data:text/javascript;base64,${Buffer.from([
	`import fs from "node:fs";`,
	`import { registerSessionResourceCleanup } from ${JSON.stringify(import.meta.resolve("@exxeta/exxperts-ai"))};`,
	`registerSessionResourceCleanup((id) => { if (id) fs.appendFileSync(process.env.SMOKE_SESSION_ENDS_LOG, JSON.stringify({ id, at: Date.now() }) + "\\n"); });`,
].join("\n")).toString("base64")}`;
const sessionEnds = (): Array<{ id: string; at: number }> => (fs.existsSync(sessionEndsLog) ? fs.readFileSync(sessionEndsLog, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)) : []);

// --- The gateway plays the model: each leg makes its scripted calls, then it answers in words.
type Call = { name: string; arguments: Record<string, unknown> };
let script: Call[][] = [];
// The model's words once its script runs out. A landing saves an answer only when the conversation doesn't hold its text yet.
let answerText = "That is as far as I got.";
let requests: Array<{ userTexts: string[]; toolResults: string[]; tools: string[]; mcpDescription: string; at: number }> = [];
const sseChunk = (payload: unknown): string => `data: ${JSON.stringify(payload)}\n\n`;
const textOf = (content: unknown): string => (typeof content === "string" ? content : Array.isArray(content) ? content.map((part: any) => String(part?.text ?? "")).join("") : "");
const gateway = http.createServer((req, res) => {
	let body = "";
	req.on("data", (chunk) => { body += chunk; });
	req.on("end", () => {
		const parsed = JSON.parse(body || "{}");
		const messages: any[] = Array.isArray(parsed.messages) ? parsed.messages : [];
		const userAt = messages.map((message) => message?.role).lastIndexOf("user");
		const after = messages.slice(userAt + 1);
		requests.push({ userTexts: messages.filter((message) => message?.role === "user").map((message) => textOf(message.content)), toolResults: after.filter((message) => message?.role === "tool").map((message) => textOf(message.content)), tools: (parsed.tools ?? []).map((tool: any) => String(tool?.function?.name ?? "")), mcpDescription: String((parsed.tools ?? []).find((tool: any) => tool?.function?.name === "mcp")?.function?.description ?? ""), at: Date.now() });
		const legsDone = after.filter((message) => message?.role === "assistant").length;
		const leg = (parsed.tools ?? []).length > 0 ? script[legsDone] : undefined;
		res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
		const base = { id: `cmpl_${legsDone}`, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: String(parsed.model ?? MODEL.model) };
		if (leg) {
			const tool_calls = leg.map((call, index) => ({ index, id: `call_${requests.length}_${index}`, type: "function", function: { name: call.name, arguments: JSON.stringify(call.arguments) } }));
			res.write(sseChunk({ ...base, choices: [{ index: 0, delta: { role: "assistant", tool_calls }, finish_reason: null }] }));
			res.write(sseChunk({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } }));
		} else {
			res.write(sseChunk({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: answerText }, finish_reason: null }] }));
			res.write(sseChunk({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 150, completion_tokens: 12, total_tokens: 162 } }));
		}
		res.write("data: [DONE]\n\n");
		res.end();
	});
});

/** A call of the stand-in's `work` through the mcp tool, as Asana's. */
const work = (args: Record<string, unknown>): Call => ({ name: "mcp", arguments: { tool: "asana_work", server: "asana", args: JSON.stringify(args) } });
/** A call of Toy space's tool `tool` through the mcp tool. */
const toy = (tool: string, args: Record<string, unknown> = {}): Call => ({ name: "mcp", arguments: { tool: `toy_${tool}`, server: "toy", args: JSON.stringify(args) } });
const sticky = (tool: string, args: Record<string, unknown> = {}): Call => ({ name: "mcp", arguments: { tool: `sticky_${tool}`, server: "sticky", args: JSON.stringify(args) } });
/** The two ways a room reaches a connector's tool: the mcp tool (Asana here) and the connector's own tool (Linear). */
type Path = "proxy" | "direct";
const CONNECTOR: Record<Path, string> = { proxy: "Asana", direct: "Linear" };

const WebSocketImpl: any = (await import("ws")).default;
let serverProcess: ChildProcessWithoutNullStreams | undefined;
const serverOutput: string[] = [];
let port = 0;
let room = "";
async function json(pathname: string, init: AuthedFetchInit = {}): Promise<{ status: number; body: any }> {
	const response = await authedFetch(`http://127.0.0.1:${port}${pathname}`, { ...init, headers: { ...(init.body ? { "content-type": "application/json" } : {}), ...init.headers } });
	const text = await response.text();
	return { status: response.status, body: text ? JSON.parse(text) : null };
}
const threadPath = (conversation: string) => `/api/persistent-agents/${encodeURIComponent(room)}/threads/${conversation}`;
const threadItems = async (conversation: string): Promise<any[]> => (await json(threadPath(conversation))).body?.thread?.items ?? [];
const stepsOf = (items: any[]) => items.filter((item) => item.kind === "tool" && (item.name === "mcp" || item.name === "linear_work"));

// The saved step as the room's card reads it: failed, and the line under it.
const look: any = await import(new URL("../../web-ui/src/work-look.ts", import.meta.url).href);
const stepLines: any = await import(new URL("../../web-ui/src/step-lines.ts", import.meta.url).href);
function readsEnded(step: any, end: ConnectorCallEnd, via: Path | "toy", label: string): void {
	assert(step, `${label}: the step was saved`);
	assert(step.status === "error" && look.stepState(step, undefined) === "failed", `${label}: the step reads failed, not Done, got ${step.status} / ${look.stepState(step, undefined)}`);
	assert(step.details?.error === end && step.result === CONNECTOR_CALL_END_RESULTS[end], `${label}: the model is told how the call ended, got ${JSON.stringify(step.details)} / ${step.result}`);
	const outcome = stepLines.stepOutcome(step.result, step);
	assert(outcome?.line === connectorCallEndLine(end, via === "toy" ? "Toy space" : CONNECTOR[via]) && outcome.refused === false, `${label}: the line under the step, got ${JSON.stringify(outcome)}`);
}

async function openWindow(conversation: string) {
	const query = `persistentAgentId=${room}&conversationId=${conversation}&modelProvider=${MODEL.provider}&model=${MODEL.model}&reattach=1`;
	const ws = new WebSocketImpl(`ws://127.0.0.1:${port}/ws?${query}`, { headers: { ...SMOKE_AUTH_HEADERS } });
	const frames: Array<{ frame: any; at: number }> = [];
	ws.addEventListener("message", (event: any) => { try { frames.push({ frame: JSON.parse(String(event.data)), at: Date.now() }); } catch {} });
	await new Promise<void>((resolve, reject) => { ws.addEventListener("open", () => resolve()); ws.addEventListener("error", () => reject(new Error("websocket failed to connect"))); });
	const find = (match: (frame: any) => boolean) => frames.find((entry) => match(entry.frame));
	const seen = async (match: (frame: any) => boolean, label: string, timeoutMs?: number): Promise<{ frame: any; at: number }> => {
		await waitUntil(() => find(match) !== undefined, `${label}; frames ${frames.map((entry) => entry.frame.type).join(",")}`, timeoutMs);
		return find(match)!;
	};
	await seen((frame) => frame.type === "ready", `${conversation}: the window is ready`);
	// A turn's end is the first one after its prompt.
	const isEnd = (frame: any) => frame.type === "event" && frame.event?.type === "agent_end";
	let endsBefore = 0;
	return {
		ws,
		frames,
		prompt: (text: string, id?: string, edit?: { replaces: string; text: string }) => {
			endsBefore = frames.filter((entry) => isEnd(entry.frame)).length;
			ws.send(JSON.stringify({ type: "prompt", text, ...(id ? { id, shown: { text, files: [] } } : {}), ...(edit ? { edit } : {}) }));
		},
		stop: () => ws.send(JSON.stringify({ type: "abort", shown: 0 })),
		// The steps as the page builds them from the turn's frames (App.tsx, a tool result's message_end): a stopped turn's page saves them.
		steps: () => {
			const events = frames.map((entry) => entry.frame).filter((frame) => frame.type === "event" && frame.event?.type === "message_end").map((frame) => frame.event.message);
			const calls = events.filter((message) => message?.role === "assistant").flatMap((message) => (Array.isArray(message.content) ? message.content : [])).filter((part: any) => part?.type === "toolCall");
			return events.filter((message) => message?.role === "toolResult").map((message) => {
				const call = calls.find((part: any) => part.id === message.toolCallId);
				return { name: call?.name, args: call?.arguments, status: message.isError ? "error" : "done", result: textOf(message.content), details: message.details };
			});
		},
		ended: async (timeoutMs?: number) => {
			await waitUntil(() => frames.filter((entry) => isEnd(entry.frame)).length > endsBefore, `the turn ended; frames ${frames.slice(-8).map((entry) => entry.frame.type).join(",")}`, timeoutMs);
			return frames.filter((entry) => isEnd(entry.frame))[endsBefore]!;
		},
	};
}

let turnBefore = false;
/** `alongside`: opened while another conversation's turn still runs, as a second window does. */
async function openConversation(conversation: string, alongside = false) {
	if (turnBefore && !alongside) await waitForTurnSettled(json, room, `the turn before ${conversation} has settled`);
	turnBefore = true;
	assert((await json(threadPath(conversation), { method: "PUT", body: JSON.stringify({ state: "active", origin: "launcher", model: MODEL, items: [] }) })).status === 200, `${conversation} was seeded`);
	requests = [];
	return openWindow(conversation);
}

/** Runs one turn whose model makes `calls` at once, and waits until each reached the connector. */
async function startCalls(conversation: string, calls: Call[], labels: string[], alongside = false) {
	const window = await openConversation(conversation, alongside);
	script = [calls];
	window.prompt(`Run ${labels.join(" and ")}.`, `${conversation}-ask`);
	await waitUntil(() => labels.every((label) => eventsOf(label, "call").length === 1), `${conversation}: the calls reached the connector`);
	return window;
}

const cleanUp = async () => {
	try { gateway.close(); } catch {}
	await stopSmokeServer(serverProcess);
	fs.rmSync(tempRoot, { recursive: true, force: true });
};

try {
	await new Promise<void>((resolve) => gateway.listen(0, "127.0.0.1", resolve));
	const gatewayPort = (gateway.address() as AddressInfo).port;
	for (const dir of [agentsRoot, agentDir, appRoot]) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
	const writeSetting = (file: string, value: unknown) => fs.writeFileSync(file, JSON.stringify(value, null, 2), { mode: 0o600 });
	writeSetting(path.join(agentDir, "models.json"), { providers: { "openai-compatible": { name: "Synthetic Gateway", baseUrl: `http://127.0.0.1:${gatewayPort}/v1`, api: "openai-completions", models: [{ id: "room-model", name: "Room Model", contextWindow: 200000, maxTokens: 4096 }, { id: "room-model-2", name: "Room Model 2", contextWindow: 200000, maxTokens: 4096 }] } } });
	writeSetting(path.join(agentDir, "auth.json"), { "openai-compatible": { type: "api_key", key: "synthetic-connector-stop" } });
	writeSetting(path.join(appRoot, "openai-compatible-ai-profile.json"), { profileId: "openai-compatible", providerId: "openai-compatible", label: "Synthetic Gateway", roomModels: [{ modelId: "room-model", label: "Room Model" }, { modelId: "room-model-2", label: "Room Model 2" }], maintenanceModel: "room-model" });
	writeSetting(path.join(appRoot, "persistent-agent-ai-profile.json"), { profileId: "openai-compatible" });
	const asana = standInEntry("asana", false);
	const linear = standInEntry("linear", true);
	// Toy space starts a program of its own, as a browser-driving connector does, and gives the assistant its own words.
	const toySpace = { ...standInEntry("toy", false, { STAND_IN_CHILD: "1", STAND_IN_INSTRUCTIONS: TOY_INSTRUCTIONS }), displayName: "Toy space" };
	// Sticky keeps running when told to end, until it is killed: on only in case 11.
	const stickyEntry = standInEntry("sticky", false, { STAND_IN_STAYS: "1" });
	// Keeper starts with each conversation and runs while it is open: on only in case 16.
	const keeperEntry = { ...standInEntry("keeper", false), lifecycle: "keep-alive" };
	writeSetting(path.join(agentDir, "mcp.json"), { mcpServers: { asana, linear, toy: toySpace, sticky: stickyEntry, keeper: keeperEntry } });
	// Linear's tools as a first connection leaves them, so the room registers its direct tool at once.
	const { computeServerHash } = await import("pi-mcp-adapter/metadata-cache.ts" as string);
	const cachedTools = [{ name: "work", description: "Works for as long as it is told.", inputSchema: { type: "object" } }, { name: "fail", description: "Answers with its own error.", inputSchema: { type: "object" } }];
	writeSetting(path.join(agentDir, "mcp-cache.json"), { version: 1, servers: { linear: { configHash: computeServerHash(linear), cachedAt: Date.now(), resources: [], tools: cachedTools } } });

	port = await freePort();
	const env = { ...process.env, ...smokeHomeEnv(home) } as NodeJS.ProcessEnv;
	// Added to what the smoke runner already loads.
	if (!REAL_LIMITS) env.NODE_OPTIONS = `${env.NODE_OPTIONS ?? ""} --import=${new URL(`file://${preload}`).href}`.trim();
	env.NODE_OPTIONS = `${env.NODE_OPTIONS ?? ""} --import=${SESSION_ENDS_HOOK}`.trim();
	env.SMOKE_SESSION_ENDS_LOG = sessionEndsLog;
	serverProcess = spawn("npx", ["tsx", "src/index.ts"], {
		shell: process.platform === "win32",
		...SMOKE_SERVER_SPAWN_TREE_OPTIONS,
		cwd: webServerDir,
		env: { ...env, EXXPERTS_CODING_AGENT_DIR: agentDir, EXXETA_PERSISTENT_AGENTS_ROOT: agentsRoot, PORT: String(port), ...SMOKE_SERVER_AUTH_ENV, EXXETA_HOME: repoRoot } as NodeJS.ProcessEnv,
	});
	serverProcess.stdout.on("data", (chunk) => serverOutput.push(String(chunk)));
	serverProcess.stderr.on("data", (chunk) => serverOutput.push(String(chunk)));
	await waitForServer(serverProcess, `http://127.0.0.1:${port}`, 60_000);
	const created = await json("/api/persistent-agents", { method: "POST", body: JSON.stringify({ displayName: "Connector Room", userName: "Synthetic User", preferredUserAddress: "Synthetic User" }) });
	room = String(created.body?.agent?.id ?? created.body?.agent?.agentId ?? "");
	assert(created.status === 201 && room, `room created, got ${created.status}`);
	for (const name of ["asana", "linear", "toy"]) {
		const grant = await json(`/api/persistent-agents/${encodeURIComponent(room)}/mcp-connectors`, { method: "PUT", body: JSON.stringify({ action: "grant", name }) });
		assert(grant.status === 200, `${name} was enabled, got ${grant.status}`);
	}

	if (REAL_LIMITS) {
		// --- R. A call that reports progress for 70 s returns its result.
		const window = await startCalls("conv-real", [work({ label: "real", ms: 70_000, progressEvery: 5_000 })], ["real"]);
		await window.ended(90_000);
		await waitForTurnSettled(json, room, "the long call's turn landed");
		const step = window.steps()[0];
		assert(eventsOf("real", "answer").length === 1 && eventsOf("real", "cancel").length === 0 && step?.status === "done" && String(step.result).includes("real done after 70000 ms"), `a call that reports progress for 70 s returns its result, got ${JSON.stringify(eventsOf("real", "cancel"))} / ${step?.status}: ${step?.result}`);
		window.ws.close();
		console.log("ok R a call that reports progress for 70 s returns its result");
		console.log("connector-call-stop-smoke --real-limits: OK");
		await cleanUp();
		process.exit(0);
	}

	// --- 1. Stop at 2 s of a 40 s call: the connector is asked to stop within a second, the turn has ended within two.
	{
		const via = "proxy";
		const label = `stop-${via}`;
		const conversation = `conv-${label}`;
		// It reports progress, so only Stop can end it before the shortened limits.
		const window = await startCalls(conversation, [work({ label, ms: 40_000, progressEvery: 300 })], [label]);
		await pause(2_000);
		const stoppedAt = Date.now();
		window.stop();
		await waitUntil(() => eventsOf(label, "cancel").length === 1, `${via}: the connector was asked to stop`, 5_000);
		const ended = await window.ended(5_000);
		const cancel = eventsOf(label, "cancel")[0]!;
		assert(cancel.at - stoppedAt <= 1_000 && ended.at - stoppedAt <= 2_000, `${via}: the cancel came ${cancel.at - stoppedAt} ms after Stop, the turn ended ${ended.at - stoppedAt} ms after it`);
		window.ws.close();
		await waitForTurnSettled(json, room, `${via}: the stopped turn landed`);
		readsEnded(window.steps()[0], "stopped", via, `${via}: Stop`);
		console.log(`ok 1 Stop at 2 s of a 40 s call asks the connector to stop at once and ends the turn`);
	}

	// --- 2. A connector that ignores the cancel: the turn ends the same way, its late answer changes nothing, and the next call works.
	{
		const conversation = "conv-ignores";
		const window = await startCalls(conversation, [work({ label: "ignores", ms: 4_000, progressEvery: 300, ignoreCancel: true })], ["ignores"]);
		await pause(500);
		const stoppedAt = Date.now();
		window.stop();
		const ended = await window.ended(5_000);
		await cancelOf("ignores", stoppedAt + 1_000);
		assert(ended.at - stoppedAt <= 2_000 && eventsOf("ignores", "cancel").length === 1, `the turn ended ${ended.at - stoppedAt} ms after Stop, though the connector goes on`);
		await waitForTurnSettled(json, room, "the stopped turn landed");
		const before = JSON.stringify(await threadItems(conversation));
		const framesBefore = window.frames.length;
		await waitUntil(() => eventsOf("ignores", "answer").length === 1, "the connector answered late", 10_000);
		await pause(500);
		assert(JSON.stringify(await threadItems(conversation)) === before && window.frames.length === framesBefore, `the late answer changed nothing the person or the model sees, got ${window.frames.slice(framesBefore).map((entry) => entry.frame.type).join(",")}`);
		readsEnded(window.steps()[0], "stopped", "proxy", "ignored cancel");
		script = [[work({ label: "next", ms: 100 })]];
		window.prompt("Run next.");
		await window.ended();
		await waitForTurnSettled(json, room, "the next turn landed");
		const next = window.steps().at(-1);
		assert(next?.status === "done" && String(next.result).includes("next done after 100 ms"), `the next call to the connector works, got ${next?.status}: ${next?.result}`);
		window.ws.close();
		console.log("ok 2 a connector that ignores the cancel: the turn ends, its late answer changes nothing, the next call works");
	}

	// --- 3. Three calls at once to one connector: progress keeps one alive past the silence limit, silence ends one at it while
	// the others go on, and progress forever ends one at the total limit.
	{
		const via = "proxy";
		const conversation = `conv-limits-${via}`;
		const alive = `alive-${via}`;
		const silent = `silent-${via}`;
		const forever = `forever-${via}`;
		const window = await startCalls(conversation, [
			work({ label: alive, ms: SILENCE_MS * 2.5, progressEvery: 300 }),
			work({ label: silent, ms: TOTAL_MS * 3 }),
			work({ label: forever, ms: TOTAL_MS * 3, progressEvery: 300 }),
		], [alive, silent, forever]);
		const ended = await window.ended(TOTAL_MS * 3);
		assert(eventsOf(alive, "call")[0]?.progress === true, `${via}: the call asked the connector for progress`);
		assert(eventsOf(alive, "answer").length === 1 && eventsOf(alive, "cancel").length === 0, `${via}: a call that reports progress runs past the silence limit and returns, got ${JSON.stringify(logged().filter((entry) => entry.label === alive))}`);
		// Both calls had ended before the turn did.
		const silentCancel = await cancelOf(silent, ended.at + 1_000);
		const foreverCancel = await cancelOf(forever, ended.at + 1_000);
		// From the stand-in's own times: the call reached it, then the cancel.
		const silentFor = silentCancel ? silentCancel.at - eventsOf(silent, "call")[0]!.at : undefined;
		const foreverFor = foreverCancel ? foreverCancel.at - eventsOf(forever, "call")[0]!.at : undefined;
		assert(silentFor !== undefined && silentFor >= SILENCE_MS - 200 && silentFor < TOTAL_MS, `${via}: a silent call is stopped at the silence limit and asked to stop, got ${silentFor ?? "no cancel"}`);
		assert(foreverFor !== undefined && foreverFor >= TOTAL_MS - 200, `${via}: a call that reports progress forever is stopped at the total limit and asked to stop, got ${foreverFor ?? "no cancel"}`);
		await waitForTurnSettled(json, room, `${via}: the limits' turn landed`);
		const steps = window.steps();
		const stepOf = (label: string) => steps.find((step) => JSON.stringify(step.args).includes(label));
		assert(stepOf(alive)?.status === "done", `${via}: the call that reported progress reads Done, got ${stepOf(alive)?.status}`);
		readsEnded(stepOf(silent), "no_answer", via, `${via}: silence`);
		readsEnded(stepOf(forever), "too_long", via, `${via}: progress forever`);
		const told = requests.flatMap((request) => request.toolResults);
		assert(told.includes(CONNECTOR_CALL_END_RESULTS.no_answer) && told.includes(CONNECTOR_CALL_END_RESULTS.too_long), `${via}: the model is told how each call ended, got ${JSON.stringify(told)}`);
		window.ws.close();
		console.log(`ok 3 progress keeps a call alive past the silence limit; silence and progress forever each end theirs, with a cancel`);
	}

	// --- 4. Two calls at once to one connector: stopping the answer cancels both.
	{
		const window = await startCalls("conv-two-stop", [work({ label: "two-a", ms: 40_000, progressEvery: 300 }), work({ label: "two-b", ms: 40_000, progressEvery: 300 })], ["two-a", "two-b"]);
		window.stop();
		await window.ended(5_000);
		await waitUntil(() => eventsOf("two-a", "cancel").length === 1 && eventsOf("two-b", "cancel").length === 1, "both calls were asked to stop", 3_000);
		window.ws.close();
		console.log("ok 4 two calls at once: stopping the answer cancels both");
	}

	// --- 5. A connector's own error reads as before: its words, no new line.
	{
		const conversation = "conv-own-error";
		const window = await openConversation(conversation);
		script = [[{ name: "mcp", arguments: { tool: "asana_fail", server: "asana", args: "{}" } }]];
		window.prompt("Run fail.");
		await window.ended();
		await waitForTurnSettled(json, room, "the failed call landed");
		const step = window.steps()[0];
		assert(step?.status === "error" && step.details?.error === "tool_error" && String(step.result).startsWith("Error: The project Q3 is locked.") && stepLines.stepOutcome(step.result, step) === null, `a connector's own error keeps its words, got ${JSON.stringify(step)}`);
		window.ws.close();
		console.log("ok 5 a connector's own error reads as before");
	}

	// --- 6. Editing the last message after a stopped or a timed-out call keeps the warning in what the model is told.
	for (const [end, args] of [["stopped", { ms: 40_000, progressEvery: 300 }], ["no_answer", { ms: TOTAL_MS * 3 }]] as const) {
		const label = `edit-${end}`;
		const conversation = `conv-${label}`;
		const window = await startCalls(conversation, [work({ label, ...args })], [label]);
		if (end === "stopped") window.stop();
		await window.ended(TOTAL_MS * 2);
		await waitForTurnSettled(json, room, `${end}: the turn landed`);
		script = [];
		window.prompt("Run it again, but smaller.", `${conversation}-edit`, { replaces: `${conversation}-ask`, text: `Run ${label}.` });
		await waitUntil(() => window.frames.some((entry) => entry.frame.type === "edit_applied"), `${end}: the edit is taken`);
		await window.ended();
		// The room's upkeep asks the same model too, so the edited turn's request is found by its message.
		const told = requests.flatMap((request) => request.userTexts).find((text) => text.endsWith("Run it again, but smaller.")) ?? "";
		assert(told.includes("these steps had already run and their effects remain: used asana_work (asana), maybe only in part."), `${end}: the edited message carries the warning, got ${JSON.stringify(told)}`);
		window.ws.close();
		console.log(`ok 6 ${end}: editing the last message keeps the "may have done part" warning`);
	}

	// --- 9. A conversation's programs: one copy while it is open, whatever it asks; none once it ends, also after a new
	// page, and the program a connector started of its own ends with it. The connector's own words reach the assistant
	// in the first request, though nobody pressed Check connection.
	{
		const conversation = "conv-copies";
		const window = await openConversation(conversation);
		script = [[toy("work", { label: "copies-1", ms: 100 })]];
		window.prompt("Run copies-1.");
		await window.ended();
		assert(requests[0]?.mcpDescription.includes(TOY_INSTRUCTIONS), `the first request gives the assistant Toy space's own words, got ${JSON.stringify(requests[0]?.mcpDescription.slice(-600))}`);
		// The room's warm-up reached the connector too: its program ends within its own limits.
		await waitUntil(() => runningPrograms("toy").length === 1, `one open conversation runs one copy, got ${JSON.stringify(runningPrograms("toy"))}`, 20_000);
		const [first] = runningPrograms("toy");
		assert(first?.child !== undefined && alive(first.child), "its program runs one of its own");
		await waitForTurnSettled(json, room, "the first copies turn landed");
		script = [[toy("work", { label: "copies-2", ms: 100 })]];
		window.prompt("Run copies-2.");
		await window.ended();
		assert(JSON.stringify(runningPrograms("toy")) === JSON.stringify([first]), `a second call in the same conversation uses the same copy, got ${JSON.stringify(runningPrograms("toy"))}`);
		await waitForTurnSettled(json, room, "the second copies turn landed");
		const closedAt = Date.now();
		window.ws.close();
		await waitUntil(() => runningPrograms("toy").length === 0, `the conversation ended: its program and the program's own have exited, got ${JSON.stringify(runningPrograms("toy"))}`, 10_000);
		console.log(`  the closed conversation's programs exited ${Date.now() - closedAt} ms after it ended`);
		// A new page on the same conversation: one copy again, and none once it closes.
		const again = await openWindow(conversation);
		script = [[toy("work", { label: "copies-3", ms: 100 })]];
		again.prompt("Run copies-3.");
		await again.ended();
		await waitUntil(() => runningPrograms("toy").length === 1, `a new page runs one copy, got ${JSON.stringify(runningPrograms("toy"))}`);
		await waitForTurnSettled(json, room, "the new page's turn landed");
		again.ws.close();
		await waitUntil(() => runningPrograms("toy").length === 0, `the new page ended: no copy runs, got ${JSON.stringify(runningPrograms("toy"))}`, 10_000);
		console.log("ok 9 one copy per open conversation, none once it ends, also after a new page; the connector's own words reach the assistant");
	}

	// --- 10. Toy space adds a tool mid-conversation: it is found and asked about as any other. Then Toy space is removed
	// while that question waits, while a call of it runs in another conversation, and while a third has it connected:
	// the call ends as removed, the question closes with nothing sent, every program of it exits, and nothing starts it again.
	{
		const other = await openConversation("conv-removed-other");
		script = [[toy("work", { label: "removed-other", ms: 100 })]];
		other.prompt("Run removed-other.");
		await other.ended();
		await waitForTurnSettled(json, room, "the other conversation's turn landed");
		// Two more windows hold Settings' Connectors and the room's Connectors pane open while Toy space adds a tool.
		const executable = typeof chromium?.executablePath === "function" ? chromium.executablePath() : "";
		const browser: Browser | null = executable && fs.existsSync(executable) ? await chromium.launch() : null;
		if (!browser) console.log("  the two-window row skipped (Chromium not installed)");
		// What's new, shown once, would cover the windows.
		if (browser) assert((await json("/api/whats-new/seen", { method: "POST", body: "{}" })).status === 200, "what's new was marked seen");
		const toyCountIn = async (page: Page) => Number(/Toy space[\s\S]*?(\d+) tools/.exec(await page.locator(".settings-overlay, .rs-shell").first().innerText())?.[1] ?? Number.NaN);
		const windowAt = async (open: (page: Page) => Promise<void>) => {
			const page = await browser!.newPage({ viewport: { width: 1440, height: 900 } });
			await page.goto(`http://127.0.0.1:${port}/auth/session?token=${SMOKE_AUTH_TOKEN}`);
			await page.locator(".persistent-agent-card").first().waitFor({ timeout: 20_000 });
			await open(page);
			await page.locator(".settings-dialog-nav-item").filter({ hasText: /^Connectors$/ }).first().click();
			await waitUntil(async () => Number.isFinite(await toyCountIn(page)), "the window shows Toy space's tool count", 15_000);
			return page;
		};
		const views = browser
			? {
					settings: await windowAt(async (page) => {
						await page.locator("button.sidebar-config-gear, .product-sidebar-footer button, .home-gear, button[aria-label='Settings']").filter({ visible: true }).first().click();
						await page.locator(".sidebar-config-menu button, .sidebar-config-menu a").filter({ hasText: /Settings/ }).first().click();
						await page.waitForSelector(".settings-overlay", { timeout: 10_000 });
					}),
					pane: await windowAt(async (page) => {
						await page.locator(".persistent-agent-card").filter({ hasText: "Connector Room" }).locator(".card-gear-btn").click();
						await page.waitForSelector(".rs-shell", { timeout: 10_000 });
					}),
				}
			: null;
		const countsBefore = views ? { settings: await toyCountIn(views.settings), pane: await toyCountIn(views.pane) } : null;
		const asked = await openConversation("conv-removed-asked");
		script = [[toy("add_tool")], [toy("added")]];
		asked.prompt("Add a tool, then use it.");
		const questionOf = () => asked.frames.find((entry) => entry.frame.type === "ui_request" && entry.frame.kind === "connector")?.frame;
		await waitUntil(() => questionOf() !== undefined, "the added tool is asked about as any other", 15_000);
		const question = questionOf()!;
		assert(String(question.title ?? "").includes("Added Tool") && question.connector === "Toy space", `the question names the added tool by its title, got ${JSON.stringify(question)}`);
		if (browser && views && countsBefore) {
			// Each window back in front shows the new count, with neither closed and reopened.
			for (const [view, page] of Object.entries(views)) {
				await page.bringToFront();
				await page.evaluate(() => window.dispatchEvent(new Event("focus")));
				const before = countsBefore[view as keyof typeof countsBefore];
				await waitUntil(async () => (await toyCountIn(page)) === before + 1, `${view}: back in front, it shows Toy space's new tool (was ${before}, shows ${await toyCountIn(page)})`, 12_000);
			}
			await browser.close();
			console.log("  Settings' Connectors and the room's Connectors pane each showed the added tool once back in front");
		}
		const running = await startCalls("conv-removed-running", [toy("work", { label: "removed-running", ms: 40_000, progressEvery: 300 })], ["removed-running"], true);
		await waitUntil(() => runningPrograms("toy").length === 3, `three conversations each run a copy, got ${JSON.stringify(runningPrograms("toy"))}`, 20_000);
		const startsBefore = logged().filter((entry) => entry.name === "toy" && entry.event === "start").length;
		const removedAt = Date.now();
		const removed = await json("/api/mcp/servers/toy", { method: "DELETE" });
		assert(removed.status === 200, `Toy space was removed, got ${removed.status}`);
		await running.ended(5_000);
		const cancel = await cancelOf("removed-running", Date.now() + 1_000);
		assert(cancel, "the running call's connector was asked to stop");
		await waitForTurnSettled(json, room, "the removed call's turn landed");
		const ended = running.steps()[0];
		readsEnded(ended, "removed", "toy", "a call whose connector was removed");
		assert(stepLines.stepOutcome(ended.result, ended)?.line === "Toy space was removed, so this step was stopped. It may already have done part of the work.", `the step's line, got ${JSON.stringify(stepLines.stepOutcome(ended.result, ended))}`);
		await waitUntil(() => asked.frames.some((entry) => entry.frame.type === "ui_request_closed" && entry.frame.id === question.id), "the waiting question closed", 5_000);
		await asked.ended();
		await waitForTurnSettled(json, room, "the asked turn landed");
		const unasked = asked.steps().find((step) => String(step.args?.tool) === "toy_added");
		assert(unasked?.status === "error" && unasked.details?.failure === "removed", `the question's call reads removed, got ${JSON.stringify(unasked)}`);
		assert(!logged().some((entry) => entry.name === "toy" && entry.event === "call" && entry.tool === "added"), "nothing was sent for the question's call");
		await waitUntil(() => runningPrograms("toy").length === 0, `every program of Toy space has exited, got ${JSON.stringify(runningPrograms("toy"))}`, 10_000);
		console.log(`  Toy space's programs exited ${Date.now() - removedAt} ms after its removal`);
		// Nothing starts it again: a later call in a conversation that had it connected reads removed.
		script = [[toy("work", { label: "removed-after", ms: 100 })]];
		running.prompt("Run removed-after.");
		await running.ended();
		await waitForTurnSettled(json, room, "the call after the removal landed");
		const after = running.steps().at(-1);
		assert(after?.status === "error" && after.details?.failure === "removed", `a call after the removal reads removed, got ${JSON.stringify(after)}`);
		await pause(1_000);
		assert(logged().filter((entry) => entry.name === "toy" && entry.event === "start").length === startsBefore, "nothing started Toy space again");
		for (const window of [other, asked, running]) window.ws.close();
		console.log("ok 10 a tool added mid-conversation is asked about; removal ends its call as removed, closes its question, ends every program, and nothing starts it again");
	}

	// --- 11. Forget this conversation while it has a program connected that is slow to exit: the forget doesn't wait
	// for it, and the program still ends.
	{
		const grant = await json(`/api/persistent-agents/${encodeURIComponent(room)}/mcp-connectors`, { method: "PUT", body: JSON.stringify({ action: "grant", name: "sticky" }) });
		assert(grant.status === 200, `sticky was enabled, got ${grant.status}`);
		const conversation = "conv-forget";
		const window = await openConversation(conversation);
		script = [[sticky("work", { label: "sticky-1", ms: 100 })]];
		window.prompt("Run sticky-1.");
		await window.ended();
		await waitForTurnSettled(json, room, "the sticky turn landed");
		await waitUntil(() => runningPrograms("sticky").length === 1, `one sticky program runs, got ${JSON.stringify(runningPrograms("sticky"))}`, 20_000);
		const forgetAt = Date.now();
		const forgot = await json(`/api/persistent-agents/${encodeURIComponent(room)}/memento`, { method: "POST", body: JSON.stringify({ conversationId: conversation }) });
		const tookMs = Date.now() - forgetAt;
		assert(forgot.status === 200, `the conversation was forgotten, got ${forgot.status} ${JSON.stringify(forgot.body)}`);
		assert(tookMs < 2_000, `forgetting doesn't wait for the slow program, took ${tookMs} ms`);
		await waitUntil(() => runningPrograms("sticky").length === 0, `the slow program has ended, got ${JSON.stringify(runningPrograms("sticky"))}`, 15_000);
		console.log(`ok 11 forgetting took ${tookMs} ms with a program slow to exit, and the program ended`);
	}

	// --- 12. The room's Connectors pane comes back in front while a change it made is being saved: a read that has
	// the room from before the save and answers after it leaves the change shown.
	{
		const executable = typeof chromium?.executablePath === "function" ? chromium.executablePath() : "";
		const browser: Browser | null = executable && fs.existsSync(executable) ? await chromium.launch() : null;
		if (!browser) console.log("  case 12 skipped (Chromium not installed)");
		if (browser) {
			const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
			await page.goto(`http://127.0.0.1:${port}/auth/session?token=${SMOKE_AUTH_TOKEN}`);
			await page.locator(".persistent-agent-card").filter({ hasText: "Connector Room" }).locator(".card-gear-btn").click();
			await page.waitForSelector(".rs-shell", { timeout: 10_000 });
			await page.locator(".settings-dialog-nav-item").filter({ hasText: /^Connectors$/ }).first().click();
			const asanaOn = inPane(page, "asana", true);
			await asanaOn.waitFor({ timeout: 15_000 });
			// Past the gap between two reads on coming back (READ_AGAIN_GAP_MS, ConnectorsPage.tsx), so coming back reads at once.
			await pause(5_500);
			// The save waits until the window has come back and any read that started then has the room from before the save;
			// that read's answer reaches the page only once the save shows.
			let holdRead = true;
			let cameBack!: () => void;
			const back = new Promise<void>((resolve) => { cameBack = resolve; });
			let readFetched!: () => void;
			const fetched = new Promise<void>((resolve) => { readFetched = resolve; });
			let heldRead: Promise<void> | undefined;
			await page.route("**/api/persistent-agents/*/mcp-connectors", async (route) => {
				const method = route.request().method();
				if (method === "PUT") {
					await back;
					await Promise.race([fetched, pause(1_000)]);
					await route.continue();
				} else if (method === "GET" && holdRead) {
					holdRead = false;
					const before = await route.fetch();
					readFetched();
					heldRead = (async () => {
						await waitUntil(async () => (await inPane(page, "asana", false).count()) === 1, "the save shows Asana off", 15_000);
						await route.fulfill({ response: before });
					})();
				} else await route.continue();
			});
			const saved = page.waitForResponse((response) => response.request().method() === "PUT" && response.url().includes("/mcp-connectors"));
			await page.locator('.room-skills-row[data-connector="asana"]').getByRole("switch").click();
			await page.evaluate(() => window.dispatchEvent(new Event("focus")));
			cameBack();
			await saved;
			await heldRead;
			// Any late answer has been handed to the page; one turn of its event loop and a frame later it has drawn whatever it does with it.
			await page.evaluate(() => new Promise((resolve) => setTimeout(() => requestAnimationFrame(resolve), 0)));
			assert((await asanaOn.count()) === 0 && (await inPane(page, "asana", false).count()) === 1, "a read from before the save, answering after it, leaves Asana shown off");
			await browser.close();
			const grant = await json(`/api/persistent-agents/${encodeURIComponent(room)}/mcp-connectors`, { method: "PUT", body: JSON.stringify({ action: "grant", name: "asana" }) });
			assert(grant.status === 200, `asana was enabled again, got ${grant.status}`);
			console.log("ok 12 a read from before a change, answering after it, leaves the change shown");
		}
	}

	// --- 17. The room's Connectors pane opens with its first read slow, and a connector is turned off elsewhere meanwhile:
	// the read on coming back in front shows it off, and the slow first answer, from before, doesn't bring it back.
	{
		const executable = typeof chromium?.executablePath === "function" ? chromium.executablePath() : "";
		const browser: Browser | null = executable && fs.existsSync(executable) ? await chromium.launch() : null;
		if (!browser) console.log("  case 17 skipped (Chromium not installed)");
		if (browser) {
			const connectors = `/api/persistent-agents/${encodeURIComponent(room)}/mcp-connectors`;
			// The pane's first read is fetched with Asana on, then held until the newer read has shown, 30 s at most.
			let holdRead = true;
			let readFetched = false;
			let readAnswered = false;
			let releaseRead!: () => void;
			const release = new Promise<void>((resolve) => { releaseRead = resolve; });
			try {
				const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
				await page.goto(`http://127.0.0.1:${port}/auth/session?token=${SMOKE_AUTH_TOKEN}`);
				// Settings mounts every pane as it opens, so the pane's first read starts with the dialog.
				await page.route("**/api/persistent-agents/*/mcp-connectors", async (route) => {
					if (route.request().method() === "GET" && holdRead) {
						holdRead = false;
						const before = await route.fetch();
						readFetched = true;
						await Promise.race([release, pause(30_000)]);
						await route.fulfill({ response: before }).catch(() => undefined);
						readAnswered = true;
					} else await route.continue();
				});
				await page.locator(".persistent-agent-card").filter({ hasText: "Connector Room" }).locator(".card-gear-btn").click();
				await page.waitForSelector(".rs-shell", { timeout: 10_000 });
				await page.locator(".settings-dialog-nav-item").filter({ hasText: /^Connectors$/ }).first().click();
				await waitUntil(() => readFetched, "the pane's first read was fetched", 15_000);
				const revoke = await json(connectors, { method: "PUT", body: JSON.stringify({ action: "revoke", name: "asana" }) });
				assert(revoke.status === 200, `asana was turned off elsewhere, got ${revoke.status}`);
				// Back in front: the read on return comes once the gap between two reads is up (READ_AGAIN_GAP_MS, ConnectorsPage.tsx).
				await page.evaluate(() => window.dispatchEvent(new Event("focus")));
				const linearOn = inPane(page, "linear", true);
				const asanaOn = inPane(page, "asana", true);
				await linearOn.waitFor({ timeout: 20_000 });
				assert((await asanaOn.count()) === 0, "the read on coming back shows Asana off");
				releaseRead();
				await waitUntil(() => readAnswered, "the pane's held first read was answered", 10_000);
				// The late answer has been handed to the page; one turn of its event loop and a frame later it has drawn whatever it does with it.
				await page.evaluate(() => new Promise((resolve) => setTimeout(() => requestAnimationFrame(resolve), 0)));
				assert((await asanaOn.count()) === 0, "the pane's slow first read, answering after a newer read, leaves Asana shown off");
			} finally {
				releaseRead();
				await browser.close();
			}
			const grant = await json(connectors, { method: "PUT", body: JSON.stringify({ action: "grant", name: "asana" }) });
			assert(grant.status === 200, `asana was enabled again, got ${grant.status}`);
			console.log("ok 17 the pane's slow first read, answering after a newer read, leaves the newer list shown");
		}
	}

	// --- 20. The room's Connectors pane's first read fails, and the read on coming back in front answers: the pane shows the
	// connectors, and the line saying they could not be loaded, with its Try again, is gone.
	{
		const executable = typeof chromium?.executablePath === "function" ? chromium.executablePath() : "";
		const browser: Browser | null = executable && fs.existsSync(executable) ? await chromium.launch() : null;
		if (!browser) console.log("  case 20 skipped (Chromium not installed)");
		if (browser) {
			let failRead = true;
			try {
				const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
				await page.goto(`http://127.0.0.1:${port}/auth/session?token=${SMOKE_AUTH_TOKEN}`);
				// Settings mounts every pane as it opens, so the pane's first read starts with the dialog.
				await page.route("**/api/persistent-agents/*/mcp-connectors", async (route) => {
					if (route.request().method() === "GET" && failRead) {
						failRead = false;
						await route.abort();
					} else await route.continue();
				});
				await page.locator(".persistent-agent-card").filter({ hasText: "Connector Room" }).locator(".card-gear-btn").click();
				await page.waitForSelector(".rs-shell", { timeout: 10_000 });
				await page.locator(".settings-dialog-nav-item").filter({ hasText: /^Connectors$/ }).first().click();
				const failure = page.locator(".connector-load-error");
				await failure.waitFor({ timeout: 10_000 });
				// Back in front: the read on return comes once the gap between two reads is up (READ_AGAIN_GAP_MS, ConnectorsPage.tsx).
				await page.evaluate(() => window.dispatchEvent(new Event("focus")));
				await page.locator('.room-skills-rows .room-skills-row[data-connector="linear"]').waitFor({ timeout: 20_000 });
				assert((await failure.count()) === 0, "the line saying the connectors could not be loaded is gone once the read on coming back answered");
			} finally {
				await browser.close();
			}
			console.log("ok 20 a failed first read, then a read on coming back that answers, shows the connectors with no failure line");
		}
	}

	// --- 13. A conversation is bound again (here, the room's connectors changed) while a program of it is slow to exit:
	// the old session is let go before the new one asks the model, so its end can't close what the new one answers on.
	{
		const conversation = "conv-rebind";
		const window = await openConversation(conversation);
		script = [[sticky("work", { label: "sticky-2", ms: 100 })]];
		window.prompt("Run sticky-2.");
		await window.ended();
		await waitForTurnSettled(json, room, "the sticky-2 turn landed");
		await waitUntil(() => runningPrograms("sticky").length === 1, `one sticky program runs, got ${JSON.stringify(runningPrograms("sticky"))}`, 20_000);
		const changedAt = Date.now();
		const revoke = await json(`/api/persistent-agents/${encodeURIComponent(room)}/mcp-connectors`, { method: "PUT", body: JSON.stringify({ action: "revoke", name: "asana" }) });
		assert(revoke.status === 200, `asana was turned off, got ${revoke.status}`);
		const asked = requests.length;
		script = [];
		window.prompt("Anything new?");
		await window.ended(20_000);
		const askedAt = requests[asked]?.at;
		await waitUntil(() => sessionEnds().some((entry) => entry.at >= changedAt), "the old session was let go", 10_000);
		const letGo = sessionEnds().find((entry) => entry.at >= changedAt);
		assert(askedAt !== undefined && letGo !== undefined && letGo.at <= askedAt, `the old session was let go before the new one asked the model, got let go ${letGo ? letGo.at - changedAt : "never"} ms and asked ${askedAt === undefined ? "never" : askedAt - changedAt} ms after the change`);
		console.log(`  the old session was let go ${letGo.at - changedAt} ms after the change, the new one asked the model ${askedAt - changedAt} ms after it`);
		window.ws.close();
		await waitForTurnSettled(json, room, "the rebound turn landed");
		await waitUntil(() => runningPrograms("sticky").length === 0, `the slow program has ended, got ${JSON.stringify(runningPrograms("sticky"))}`, 15_000);
		const grant = await json(`/api/persistent-agents/${encodeURIComponent(room)}/mcp-connectors`, { method: "PUT", body: JSON.stringify({ action: "grant", name: "asana" }) });
		assert(grant.status === 200, `asana was enabled again, got ${grant.status}`);
		console.log("ok 13 a conversation bound again lets its old session go before the new one asks the model");
	}

	// --- 16. A conversation's only window closes while a model switch waits for its old session's end (a program of it
	// slow to exit): the switch's new session ends too, and with it the conversation's keep-alive program.
	{
		const connectors = `/api/persistent-agents/${encodeURIComponent(room)}/mcp-connectors`;
		const grant = await json(connectors, { method: "PUT", body: JSON.stringify({ action: "grant", name: "keeper" }) });
		assert(grant.status === 200, `keeper was enabled, got ${grant.status}`);
		const conversation = "conv-switch-closed";
		const switchModel = (lock: typeof MODEL) => json(`/api/persistent-agents/${encodeURIComponent(room)}/threads/${conversation}/switch-model`, { method: "POST", body: JSON.stringify(lock) });
		const window = await openConversation(conversation);
		script = [[sticky("work", { label: "sticky-3", ms: 100 })]];
		window.prompt("Run sticky-3.");
		await window.ended();
		await waitForTurnSettled(json, room, "the sticky-3 turn landed");
		await waitUntil(() => runningPrograms("sticky").length === 1 && runningPrograms("keeper").length === 1, `the conversation runs one sticky and one keeper program, got ${JSON.stringify([runningPrograms("sticky"), runningPrograms("keeper")])}`, 20_000);
		const switchAt = Date.now();
		const switched = switchModel(OTHER_MODEL);
		// The old session's end is under way and still waiting: the slow program was told to end and stays until it is killed.
		await waitUntil(() => logged().some((entry) => entry.name === "sticky" && entry.event === "sigterm" && entry.at >= switchAt), "the switch is ending the old session", 10_000);
		const closed = new Promise<number>((resolve) => window.ws.addEventListener("close", () => resolve(Date.now())));
		window.ws.close();
		const closedAt = await Promise.race([closed, pause(10_000).then(() => Number.POSITIVE_INFINITY)]);
		assert(Number.isFinite(closedAt), "the window closed within 10 s");
		const answer = await switched;
		assert(answer.status === 200, `the switch answered, got ${answer.status} ${JSON.stringify(answer.body)}`);
		const ends = () => sessionEnds().filter((entry) => entry.at >= switchAt);
		assert(ends().length >= 1 && closedAt < ends()[0]!.at, `the window closed while the switch waited for the old session's end, got closed ${closedAt - switchAt} ms and let go ${ends().length ? ends()[0]!.at - switchAt : "never"} ms after the switch`);
		await waitUntil(() => ends().length === 2, `no session of the closed conversation is left: the switch's new session ended too, got ${ends().length} session end(s) since the switch`, 10_000);
		await waitUntil(() => runningPrograms("keeper").length === 0 && runningPrograms("sticky").length === 0, `the conversation's programs have ended, got ${JSON.stringify([runningPrograms("sticky"), runningPrograms("keeper")])}`, 10_000);
		const revoke = await json(connectors, { method: "PUT", body: JSON.stringify({ action: "revoke", name: "keeper" }) });
		assert(revoke.status === 200, `keeper was turned off, got ${revoke.status}`);
		// Back to the room's first model, with no window open, so the cases after this one run on it.
		const back = await switchModel(MODEL);
		assert(back.status === 200, `the conversation was switched back, got ${back.status} ${JSON.stringify(back.body)}`);
		console.log(`ok 16 a window closed ${closedAt - switchAt} ms into a model switch leaves no session and no program of the conversation running`);
	}

	// --- 18. A message waits on its conversation being bound again (here, the room's connectors changed) while a program
	// of the old session is slow to exit, and its only window closes then: the message is still answered and the answer
	// saved, and afterwards no session or program of the conversation runs.
	{
		const connectors = `/api/persistent-agents/${encodeURIComponent(room)}/mcp-connectors`;
		const grant = await json(connectors, { method: "PUT", body: JSON.stringify({ action: "grant", name: "keeper" }) });
		assert(grant.status === 200, `keeper was enabled, got ${grant.status}`);
		const conversation = "conv-prompt-closed";
		const window = await openConversation(conversation);
		script = [[sticky("work", { label: "sticky-4", ms: 100 })]];
		window.prompt("Run sticky-4.");
		await window.ended();
		await waitForTurnSettled(json, room, "the sticky-4 turn landed");
		await waitUntil(() => runningPrograms("sticky").length === 1 && runningPrograms("keeper").length === 1, `the conversation runs one sticky and one keeper program, got ${JSON.stringify([runningPrograms("sticky"), runningPrograms("keeper")])}`, 20_000);
		const revoke = await json(connectors, { method: "PUT", body: JSON.stringify({ action: "revoke", name: "asana" }) });
		assert(revoke.status === 200, `asana was turned off, got ${revoke.status}`);
		script = [];
		answerText = "Nothing new since you last asked.";
		const sentAt = Date.now();
		window.prompt("Anything new for me?", "conv-prompt-closed-ask");
		// The old session's end is under way and still waiting: the slow program was told to end and stays until it is killed.
		await waitUntil(() => logged().some((entry) => entry.name === "sticky" && entry.event === "sigterm" && entry.at >= sentAt), "the message's rebind is ending the old session", 10_000);
		const closed = new Promise<number>((resolve) => window.ws.addEventListener("close", () => resolve(Date.now())));
		window.ws.close();
		const closedAt = await Promise.race([closed, pause(10_000).then(() => Number.POSITIVE_INFINITY)]);
		assert(Number.isFinite(closedAt), "the window closed within 10 s");
		const ends = () => sessionEnds().filter((entry) => entry.at >= sentAt);
		await waitUntil(() => ends().length >= 1, "the old session was let go", 10_000);
		assert(closedAt < ends()[0]!.at, `the window closed while the message waited for the old session's end, got closed ${closedAt - sentAt} ms and let go ${ends()[0]!.at - sentAt} ms after the message`);
		// The session the message was bound to ends too, once its turn is done.
		await waitUntil(() => ends().length === 2, `no session of the closed conversation is left, got ${ends().length} session end(s) since the message`, 30_000);
		await waitForTurnSettled(json, room, "the message's turn settled");
		const items = await threadItems(conversation);
		const asked = items.findIndex((item) => item?.kind === "user" && JSON.stringify(item).includes("Anything new for me?"));
		const answered = asked >= 0 && items.slice(asked + 1).some((item) => item?.kind === "assistant" && String(item.text ?? "").includes("Nothing new since you last asked."));
		answerText = "That is as far as I got.";
		assert(answered, `the message sent before its window closed was answered and the answer saved, got ${JSON.stringify(items.slice(-3)).slice(0, 600)}`);
		await waitUntil(() => runningPrograms("keeper").length === 0 && runningPrograms("sticky").length === 0, `the conversation's programs have ended, got ${JSON.stringify([runningPrograms("sticky"), runningPrograms("keeper")])}`, 10_000);
		for (const [action, name] of [["grant", "asana"], ["revoke", "keeper"]]) {
			const changed = await json(connectors, { method: "PUT", body: JSON.stringify({ action, name }) });
			assert(changed.status === 200, `${name}: ${action}, got ${changed.status}`);
		}
		console.log(`ok 18 a message whose window closed ${closedAt - sentAt} ms into its rebind is answered and saved, and nothing of the conversation runs on`);
	}

	// --- 19. A conversation's window closes while a program of it is slow to exit; the conversation is opened and closed
	// once with nothing asked, whose end is quick, then opened again and asked at once: the new session asks the model
	// only once the first one has let go of what the model's provider keeps for the conversation, which they all share.
	{
		const conversation = "conv-reopened";
		const window = await openConversation(conversation);
		script = [[sticky("work", { label: "sticky-5", ms: 100 })]];
		window.prompt("Run sticky-5.");
		await window.ended();
		await waitForTurnSettled(json, room, "the sticky-5 turn landed");
		await waitUntil(() => runningPrograms("sticky").length === 1, `one sticky program runs, got ${JSON.stringify(runningPrograms("sticky"))}`, 20_000);
		const closedAt = Date.now();
		window.ws.close();
		// The closed window's end is under way and still waiting: the slow program was told to end and stays until it is killed.
		await waitUntil(() => logged().some((entry) => entry.name === "sticky" && entry.event === "sigterm" && entry.at >= closedAt), "the closed window's session is ending", 10_000);
		const ends = () => sessionEnds().filter((entry) => entry.at >= closedAt);
		const idle = await openWindow(conversation);
		const idleClosed = new Promise<void>((resolve) => idle.ws.addEventListener("close", () => resolve()));
		idle.ws.close();
		await Promise.race([idleClosed, pause(10_000)]);
		await waitUntil(() => ends().length === 1, "the session opened with nothing asked was let go", 10_000);
		assert(runningPrograms("sticky").length === 1, "the session opened with nothing asked was let go while the first one's slow program still ran");
		const again = await openWindow(conversation);
		script = [];
		const asked = requests.length;
		const sentAt = Date.now();
		again.prompt("Back again: anything new?");
		await again.ended(20_000);
		const askedAt = requests[asked]?.at;
		await waitUntil(() => ends().length === 2, `the first session was let go, got ${ends().length} session end(s) since the close`, 10_000);
		const letGo = ends()[1]!;
		assert(sentAt < letGo.at, `the message was sent while the closed window's session was still ending, got sent ${sentAt - closedAt} ms and let go ${letGo.at - closedAt} ms after the close`);
		assert(askedAt !== undefined && letGo.at <= askedAt, `the old session was let go before the reopened one asked the model, got let go ${letGo.at - closedAt} ms and asked ${askedAt === undefined ? "never" : askedAt - closedAt} ms after the close`);
		again.ws.close();
		await waitForTurnSettled(json, room, "the reopened conversation's turn landed");
		await waitUntil(() => runningPrograms("sticky").length === 0, `the slow program has ended, got ${JSON.stringify(runningPrograms("sticky"))}`, 15_000);
		console.log(`ok 19 a conversation reopened ${sentAt - closedAt} ms after its window closed, opened and closed once meanwhile, asks the model ${askedAt - letGo.at} ms after its first session let go`);
	}

	// --- 14. Settings' Connectors comes back in front just before a connector is removed there: a read that has the
	// list from before the removal and answers after the removal's own read leaves the removed connector gone.
	{
		const executable = typeof chromium?.executablePath === "function" ? chromium.executablePath() : "";
		const browser: Browser | null = executable && fs.existsSync(executable) ? await chromium.launch() : null;
		if (!browser) console.log("  case 14 skipped (Chromium not installed)");
		if (browser) {
			const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
			await page.goto(`http://127.0.0.1:${port}/auth/session?token=${SMOKE_AUTH_TOKEN}`);
			await page.locator(".persistent-agent-card").first().waitFor({ timeout: 20_000 });
			await page.locator("button.sidebar-config-gear, .product-sidebar-footer button, .home-gear, button[aria-label='Settings']").filter({ visible: true }).first().click();
			await page.locator(".sidebar-config-menu button, .sidebar-config-menu a").filter({ hasText: /Settings/ }).first().click();
			await page.waitForSelector(".settings-overlay", { timeout: 10_000 });
			await page.locator(".settings-dialog-nav-item").filter({ hasText: /^Connectors$/ }).first().click();
			const stickyRow = page.locator(".connector-list .connector-item").filter({ has: page.locator(".connector-item-name-text", { hasText: /^sticky$/i }) });
			const listed = () => page.locator(".connector-list .connector-item-name-text").allInnerTexts();
			await stickyRow.waitFor({ timeout: 15_000 });
			// Past the gap between two reads on coming back (READ_AGAIN_GAP_MS, ConnectorsPage.tsx), so coming back reads at once.
			await pause(5_500);
			let holdRead = true;
			let readFetched!: () => void;
			const fetched = new Promise<void>((resolve) => { readFetched = resolve; });
			let heldRead: Promise<void> | undefined;
			await page.route("**/api/mcp/status*", async (route) => {
				if (!holdRead) return route.continue();
				holdRead = false;
				const before = await route.fetch();
				readFetched();
				heldRead = (async () => {
					await waitUntil(async () => { const names = await listed(); return names.length > 0 && !names.some((name) => /^sticky$/i.test(name)); }, "the removal's own read lists the connectors without Sticky", 20_000);
					await route.fulfill({ response: before });
				})();
			});
			await page.evaluate(() => window.dispatchEvent(new Event("focus")));
			await fetched;
			await stickyRow.locator(".connector-item-hit").click();
			await page.locator(".connector-page").waitFor({ timeout: 10_000 });
			await page.locator(".connector-remove-group").getByRole("button", { name: "Remove", exact: true }).click();
			await page.locator(".confirm-dialog-backdrop").getByRole("button", { name: "Remove", exact: true }).click();
			await heldRead;
			// The late answer has been handed to the page; one turn of its event loop and a frame later it has drawn whatever it does with it.
			await page.evaluate(() => new Promise((resolve) => setTimeout(() => requestAnimationFrame(resolve), 0)));
			const after = await listed();
			assert(after.length > 0 && !after.some((name) => /^sticky$/i.test(name)), `a read from before the removal, answering after the removal's own read, leaves Sticky gone, got ${JSON.stringify(after)}`);
			await browser.close();
			console.log("ok 14 a read from before a removal, answering after it, leaves the removed connector gone");
		}
	}

	// --- 15. Settings' Connectors comes back in front while its first read is slow: that read answering before the
	// newer one doesn't show "no connectors" for a list that has some; the newer one's answer shows them.
	{
		const executable = typeof chromium?.executablePath === "function" ? chromium.executablePath() : "";
		const browser: Browser | null = executable && fs.existsSync(executable) ? await chromium.launch() : null;
		if (!browser) console.log("  case 15 skipped (Chromium not installed)");
		if (browser) {
			const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
			await page.goto(`http://127.0.0.1:${port}/auth/session?token=${SMOKE_AUTH_TOKEN}`);
			await page.locator(".persistent-agent-card").first().waitFor({ timeout: 20_000 });
			await page.locator("button.sidebar-config-gear, .product-sidebar-footer button, .home-gear, button[aria-label='Settings']").filter({ visible: true }).first().click();
			await page.locator(".sidebar-config-menu button, .sidebar-config-menu a").filter({ hasText: /Settings/ }).first().click();
			await page.waitForSelector(".settings-overlay", { timeout: 10_000 });
			const held: Array<() => Promise<void>> = [];
			await page.route("**/api/mcp/status*", async (route) => {
				const answer = await route.fetch();
				held.push(() => route.fulfill({ response: answer }));
			});
			await page.locator(".settings-dialog-nav-item").filter({ hasText: /^Connectors$/ }).first().click();
			await waitUntil(() => held.length === 1, "Settings' Connectors asked for its list", 15_000);
			// Past the gap between two reads on coming back (READ_AGAIN_GAP_MS, ConnectorsPage.tsx), so coming back reads at once.
			await pause(5_500);
			await page.evaluate(() => window.dispatchEvent(new Event("focus")));
			await waitUntil(() => held.length === 2, "coming back in front asked for the list again", 15_000);
			await held[0]();
			await page.evaluate(() => new Promise((resolve) => setTimeout(() => requestAnimationFrame(resolve), 0)));
			const overlay = await page.locator(".settings-overlay").innerText();
			assert(!overlay.includes("No connectors yet."), "the first read answering before the newer one doesn't say there are no connectors");
			await held[1]();
			await page.locator(".connector-list .connector-item").first().waitFor({ timeout: 15_000 });
			await browser.close();
			console.log("ok 15 a slow first read answering before a newer one shows no empty list, and the newer one shows the connectors");
		}
	}

	// --- 22. Settings' Connectors' first read fails, and coming back in front reads again: while that read is under way the
	// page says it is loading, never that there are no connectors; its answer shows them.
	{
		const executable = typeof chromium?.executablePath === "function" ? chromium.executablePath() : "";
		const browser: Browser | null = executable && fs.existsSync(executable) ? await chromium.launch() : null;
		if (!browser) console.log("  case 22 skipped (Chromium not installed)");
		if (browser) {
			// The first read fails; the next is held until the page has been looked at, 30 s at most.
			let reads = 0;
			let releaseRead!: () => void;
			const release = new Promise<void>((resolve) => { releaseRead = resolve; });
			try {
				const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
				await page.goto(`http://127.0.0.1:${port}/auth/session?token=${SMOKE_AUTH_TOKEN}`);
				await page.locator(".persistent-agent-card").first().waitFor({ timeout: 20_000 });
				await page.locator("button.sidebar-config-gear, .product-sidebar-footer button, .home-gear, button[aria-label='Settings']").filter({ visible: true }).first().click();
				await page.locator(".sidebar-config-menu button, .sidebar-config-menu a").filter({ hasText: /Settings/ }).first().click();
				await page.waitForSelector(".settings-overlay", { timeout: 10_000 });
				await page.route("**/api/mcp/status*", async (route) => {
					reads += 1;
					if (reads === 1) return route.abort();
					if (reads === 2) {
						// The browser can close while this read is held, when a check above fails.
						const answer = await route.fetch().catch(() => null);
						if (!answer) return;
						await Promise.race([release, pause(30_000)]);
						return route.fulfill({ response: answer }).catch(() => undefined);
					}
					return route.continue();
				});
				await page.locator(".settings-dialog-nav-item").filter({ hasText: /^Connectors$/ }).first().click();
				await page.locator(".settings-overlay .connector-load-error").waitFor({ timeout: 10_000 });
				// Past the gap between two reads on coming back (READ_AGAIN_GAP_MS, ConnectorsPage.tsx), so coming back reads at once.
				await pause(5_500);
				await page.evaluate(() => window.dispatchEvent(new Event("focus")));
				await waitUntil(() => reads === 2, "coming back in front asked for the list again", 15_000);
				await page.locator(".settings-overlay .connector-load-error").waitFor({ state: "detached", timeout: 10_000 });
				const overlay = await page.locator(".settings-overlay").innerText();
				assert(!overlay.includes("No connectors yet."), "while the read on coming back is under way the page doesn't say there are no connectors");
				assert(overlay.includes("Loading connectors"), "while the read on coming back is under way the page says it is loading");
				releaseRead();
				await page.locator(".connector-list .connector-item").first().waitFor({ timeout: 15_000 });
			} finally {
				releaseRead();
				await browser.close();
			}
			console.log("ok 22 after a failed first read, the read on coming back shows loading, then the connectors");
		}
	}

	// --- 7. A scheduled run's call: bounded by the same limits.
	await waitForTurnSettled(json, room, "the last live turn has settled");
	await stopSmokeServer(serverProcess);
	serverProcess = undefined;
	{
		Object.assign(process.env, { HOME: home, USERPROFILE: home, EXXPERTS_CODING_AGENT_DIR: agentDir, EXXETA_PERSISTENT_AGENTS_ROOT: agentsRoot, EXXETA_HOME: repoRoot });
		(globalThis as { exxpertsConnectorCallLimits?: unknown }).exxpertsConnectorCallLimits = SMOKE_CALL_LIMITS;
		const background = await import("../src/persistent-room-background-execution.js");
		const { getPersistentAgentThread } = await import("../src/persistent-agents.js");
		script = [[work({ label: "scheduled", ms: TOTAL_MS * 3, progressEvery: 300 })]];
		const startedAt = Date.now();
		await background.executePersistentRoomBackgroundPrompt({ roomId: room, target: { kind: "fresh-thread", model: MODEL }, prompt: "Run scheduled.", executionId: "connector-stop-scheduled", cwd: tempRoot, agentDir } as any);
		const cancel = await cancelOf("scheduled", Date.now() + 1_000);
		assert(cancel && cancel.at - startedAt >= TOTAL_MS && cancel.at - startedAt < TOTAL_MS * 3, `a scheduled run's call that reports progress forever ends at the total limit, with a cancel, got ${cancel ? cancel.at - startedAt : "no cancel"}`);
		const items: any[] = getPersistentAgentThread(room, background.scheduledPromptBackgroundThreadId("connector-stop-scheduled"))?.items ?? [];
		readsEnded(stepsOf(items)[0], "too_long", "proxy", "a scheduled run");
		// The server is stopped, so the programs left are the scheduled run's: they end with it.
		await waitUntil(() => runningPrograms("asana").length === 0, `the scheduled run's program has exited, got ${JSON.stringify(runningPrograms("asana"))}`, 10_000);
		console.log("ok 7 a scheduled run's call ends at the total limit, and its program with the run");
	}

	// --- 21. A scheduled run resumes a conversation whose last session is still ending: it asks the model only once that
	// end is done, since the end closes what the model's provider keeps under the conversation's id, which the two share.
	{
		const background = await import("../src/persistent-room-background-execution.js");
		const { endRoomSession } = await import("../src/room-session-end.js");
		const { getPersistentAgentThread } = await import("../src/persistent-agents.js");
		const conversation = "conv-reopened";
		const thread = getPersistentAgentThread(room, conversation);
		assert(thread?.runtime.kind === "pi-session-jsonl", `${conversation} has a session of its own`);
		// A session of the conversation whose extensions never finish ending, as one with a program slow to exit: the end
		// disposes it at its own limit.
		let disposedAt = 0;
		const ending = endRoomSession({ sessionId: (thread!.runtime as { sessionId: string }).sessionId, extensionRunner: { hasHandlers: () => true, emit: () => new Promise(() => {}) }, dispose: () => { disposedAt = Date.now(); } } as any);
		script = [];
		const asked = requests.length;
		await background.executePersistentRoomBackgroundPrompt({ roomId: room, target: { kind: "resume-thread", threadId: conversation, model: MODEL }, prompt: "Anything new for the schedule?", executionId: "connector-stop-resumed", cwd: tempRoot, agentDir } as any);
		await ending;
		const askedAt = requests[asked]?.at;
		assert(askedAt !== undefined && disposedAt > 0 && disposedAt <= askedAt, `the scheduled run asked the model after the conversation's last session ended, got ended ${disposedAt ? disposedAt - (askedAt ?? 0) : "never"} ms after the ask`);
		// It was ready before: it asked as soon as the end was done, not after a start of its own as long.
		assert(askedAt - disposedAt < 1_000, `the scheduled run asked within a second of the end, got ${askedAt - disposedAt} ms`);
		console.log(`ok 21 a scheduled run on a conversation still ending asks the model ${askedAt - disposedAt} ms after that end`);
	}

	// --- 8. Linear's own tool, as the room registers it (mcp/room-scope.ts), with the signal the runtime hands a tool: the same
	// ends. A room's turns offer the mcp tool alone (persistent-room-tool-policy.ts), so this path is driven at the registered tool.
	{
		const registered: any[] = [];
		const handlers = new Map<string, Array<(event: unknown, ctx: unknown) => unknown>>();
		const pi = {
			registerTool: (tool: any) => registered.push(tool),
			registerCommand() {},
			registerFlag() {},
			getFlag: () => undefined,
			getAllTools: () => registered.map((tool) => ({ name: tool.name })),
			sendMessage() {},
			on: (event: string, handler: (event: unknown, ctx: unknown) => unknown) => handlers.set(event, [...(handlers.get(event) ?? []), handler]),
		};
		const { createRoomScopedMcpExtension } = await import("../../../pi-package/extensions/mcp/index.js");
		await createRoomScopedMcpExtension(room, { onBoundGrants: () => {} })(pi as any);
		const ctx = { cwd: tempRoot, hasUI: false, ui: undefined, modelRegistry: undefined, model: undefined, signal: undefined };
		for (const handler of handlers.get("session_start") ?? []) await handler({}, ctx);
		const tool = registered.find((candidate) => candidate.name === "linear_work");
		assert(tool, `the room registers Linear's own tool, got ${registered.map((candidate) => candidate.name).join(", ")}`);
		const run = async (args: Record<string, unknown>, stopAfterMs?: number) => {
			const turn = new AbortController();
			let stoppedAt = 0;
			if (stopAfterMs !== undefined) setTimeout(() => { stoppedAt = Date.now(); turn.abort(); }, stopAfterMs);
			const result = await tool.execute(`direct-${args.label}`, args, turn.signal, undefined, ctx);
			// As the runtime reads a tool's own failure (agent-loop.ts) and the page then saves the step.
			return { stoppedAt, endedAt: Date.now(), step: { name: "linear_work", args, status: result.isError === true ? "error" : "done", result: textOf(result.content), details: result.details } };
		};
		const stopped = await run({ label: "stop-direct", ms: 40_000, progressEvery: 300 }, 2_000);
		const cancel = await cancelOf("stop-direct", stopped.stoppedAt + 1_000);
		assert(cancel && cancel.at - stopped.stoppedAt <= 1_000 && stopped.endedAt - stopped.stoppedAt <= 2_000, `direct: the cancel came ${cancel ? cancel.at - stopped.stoppedAt : "never"} ms after the stop, the call ended ${stopped.endedAt - stopped.stoppedAt} ms after it, with ${JSON.stringify(stopped.step)}`);
		readsEnded(stopped.step, "stopped", "direct", "direct: Stop");
		const startedAt = Date.now();
		const [alive, silent, forever] = await Promise.all([
			run({ label: "alive-direct", ms: SILENCE_MS * 2.5, progressEvery: 300 }),
			run({ label: "silent-direct", ms: TOTAL_MS * 3 }),
			run({ label: "forever-direct", ms: TOTAL_MS * 3, progressEvery: 300 }),
		]);
		assert(alive.step.status === "done" && eventsOf("alive-direct", "answer").length === 1 && eventsOf("alive-direct", "cancel").length === 0, `direct: a call that reports progress runs past the silence limit and returns, got ${JSON.stringify(alive.step)}`);
		const silentCancel = await cancelOf("silent-direct", silent.endedAt + 1_000);
		const foreverCancel = await cancelOf("forever-direct", forever.endedAt + 1_000);
		assert(silentCancel && silentCancel.at - startedAt >= SILENCE_MS && silentCancel.at - startedAt < TOTAL_MS, `direct: a silent call is stopped at the silence limit, with a cancel, got ${silentCancel ? silentCancel.at - startedAt : "no cancel"}`);
		assert(foreverCancel && foreverCancel.at - startedAt >= TOTAL_MS, `direct: progress forever is stopped at the total limit, with a cancel, got ${foreverCancel ? foreverCancel.at - startedAt : "no cancel"}`);
		readsEnded(silent.step, "no_answer", "direct", "direct: silence");
		readsEnded(forever.step, "too_long", "direct", "direct: progress forever");
		for (const handler of handlers.get("session_shutdown") ?? []) await handler({}, ctx);
		console.log("ok 8 Linear's own tool: Stop, silence and progress forever end its call with a cancel, and progress keeps one alive");
	}

	console.log("connector-call-stop-smoke: OK");
} catch (error) {
	console.error(serverOutput.join("").slice(-4000));
	throw error;
} finally {
	await cleanUp();
}
// Nothing a row left in this process, a timer or a socket, may hold the smoke open.
process.exit(0);
