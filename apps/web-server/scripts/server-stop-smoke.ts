// The server's stop on the desktop, read on the server's own process.
//
// Each row starts the server as the launcher's loader mode starts it
// (bin/lib/server-entry.cjs with tsxLoader: Node with tsx's loader flags), so
// the spawned process is the server itself, never npx or tsx's CLI, and each
// row reads the server's own exit code and timing. No wait is registered
// (stopWaitSeconds is empty), so the stop waits two seconds. A stand-in model
// in this process answers over the OpenAI-compatible API, chosen by a marker in
// the prompt: a slow answer of about one second, an answer that never ends, one
// memory_recall call (and one whose short answer comes 400 ms after the
// recall's result), one memory_recall call followed by silence, and a busy
// reply the runtime waits three seconds to ask again. It counts the room's
// recovery asks for a thin answer after a tool.
//
// First, on every platform and with no server: a run the stop cancelled reads
// "Stopped when exxperts stopped." in the Scheduled tasks pane.
//
// Rows, each with its own server, its own signals and a bounded wait for the
// process's end:
//   - an idle stop exits 0 within 1 s;
//   - a running answer is cut at the wait's end: its end frames carry the
//     stop's flag, the process exits 0 within 4 s, the session file keeps
//     the partial, and the thread, which the client never saves, is landed by
//     the close within the 1 s endings ceiling: the message, the partial and
//     the stop's sentence, parked and marked unseen; an answer that ends
//     during the wait arrives whole;
//   - a turn that went on alone after its person left, cut after a tool call
//     with no text yet, lands the stop's sentence in the thread;
//   - a message sent while stopping gets the error frame with the stop's code
//     and changes neither the session nor the thread;
//   - a request sent on a busy connection after the server's close began goes
//     through the stop's door: a route that starts work gets its code, a
//     plain read is served, neither the framework's bare 503;
//   - a stop while the runtime waits to ask a busy model again hands the
//     message back as stopped, not with the busy reply's cause;
//   - a stop once a watched answer has ended, while the runtime's post-turn
//     work (held open by a preloaded patch) outlasts the stop's close: the
//     answer lands whole as watched, neither parked nor marked unseen;
//   - a thin answer after a recall that ends during the stop's wait starts
//     no recovery ask; the control, before the signal, does;
//   - SIGINT then SIGTERM within 1 s is one stop, as is a process-group
//     SIGTERM with a direct one; a SIGINT 1 s or more after the first signal
//     ends the process at once with exit 0;
//   - the exit listeners run: the memory-use counters hold a recall made just
//     before the signal, which SIGKILL loses.
//
// Last, in this process, as it installs the stop here: a stop that comes once a
// scheduled run's answer has ended, while the runtime's post-turn work still
// runs (held open by a patched prompt), lands the whole answer as completed,
// without the stop's line.
//
// On Windows a signal sent from another process is a forced kill, so the stop
// cannot run there: the smoke says so and passes without starting anything.
//
// Run: node --import tsx/esm apps/web-server/scripts/server-stop-smoke.ts
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { fileURLToPath, pathToFileURL } from "node:url";
import { authedFetch, freePort, smokeHomeEnv, SMOKE_AUTH_HEADERS, SMOKE_SERVER_AUTH_ENV, type AuthedFetchInit } from "./smoke-server-process.js";
import { SERVER_STOPPED_REASON, SERVER_STOPPING_CODE, SERVER_STOPPING_SENTENCE, STOP_CUT_ANSWER_SENTENCE, STOP_SCHEDULED_RUN_SENTENCE, installServerStop, serverStopping } from "../src/server-stop.js";

const SMOKE = "server-stop-smoke";

// The stopped run's line in the pane, before the Windows skip so it is read on every platform.
{
	const { formatFriendlyRunReason } = await import("../../web-ui/src/scheduled-run-reason.js") as { formatFriendlyRunReason: (run: unknown) => string | null };
	const line = formatFriendlyRunReason({ status: "cancelled", reason: SERVER_STOPPED_REASON });
	if (line !== "Stopped when exxperts stopped.") throw new Error(`the stopped run's line: a run cancelled with the stop's reason reads ${JSON.stringify(line)}, not "Stopped when exxperts stopped."`);
	console.log(`${SMOKE}: a run cancelled with the stop's reason reads "Stopped when exxperts stopped." in the Scheduled tasks pane`);
}

if (process.platform === "win32") {
	console.log(`${SMOKE}: skipped on Windows: a signal sent from another process is a forced kill there, so the server's stop cannot run`);
	process.exit(0);
}

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..", "..", "..");
const { serverLaunchArgs } = createRequire(import.meta.url)(path.join(repoRoot, "bin", "lib", "server-entry.cjs")) as {
	serverLaunchArgs: (root: string, options?: { tsxLoader?: boolean; env?: NodeJS.ProcessEnv }) => string[];
};
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "exxperts-server-stop-"));
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------------------
// The stand-in model.
// ---------------------------------------------------------------------------
const SLOW = "stop-smoke:slow";
const ENDLESS = "stop-smoke:endless";
const RECALL = "stop-smoke:recall";
// Its text holds no other marker's text: the markers are matched with includes.
const SILENT_AFTER_TOOL = "stop-smoke:silent-after-tool";
const BUSY = "stop-smoke:busy";
const HELD_RECALL = "stop-smoke:held-recall";
const TAIL = "stop-smoke:tail";
/** The runtime's wait before it asks a busy model again (settings.json). */
const RETRY_WAIT_MS = 3_000;
const SLOW_PARTS = 10;
const PART_GAP_MS = 100;
/** When the stand-in received the room's request carrying the recall's result. */
let recallResultAt = 0;
let recallResultText = "";
/** When the stand-in received the request carrying the silent turn's tool result. */
let silentResultAt = 0;
/** How many busy replies the stand-in sent. */
let busyReplies = 0;
/** When the stand-in received the held recall's result. */
let heldResultAt = 0;
/** When the stand-in received each recovery ask for a thin answer after a tool. */
const recoveryAsks: number[] = [];

function sseChunk(payload: unknown): string {
	return `data: ${JSON.stringify(payload)}\n\n`;
}
function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content.map((part) => (part as { text?: string })?.text ?? "").join("\n");
}

const gateway = http.createServer((req, res) => {
	if (req.method !== "POST" || !String(req.url ?? "").endsWith("/chat/completions")) {
		res.writeHead(404).end();
		return;
	}
	let body = "";
	req.on("data", (chunk) => (body += chunk));
	req.on("end", () => {
		let parsed: { model?: unknown; messages?: { role?: string; content?: unknown }[] } = {};
		try {
			parsed = JSON.parse(body);
		} catch {}
		const messages = Array.isArray(parsed.messages) ? parsed.messages : [];
		const prompt = textOf([...messages].reverse().find((message) => message?.role === "user")?.content);
		const toolResults = messages.filter((message) => message?.role === "tool").map((message) => textOf(message.content));
		if (prompt.includes("[INTERNAL_RETRIEVAL_SYNTHESIS_REQUEST]") || prompt.includes("[INTERNAL_TOOL_SUMMARY_REQUEST]")) recoveryAsks.push(Date.now());
		if (prompt.includes(BUSY)) {
			busyReplies += 1;
			res.writeHead(503, { "content-type": "application/json" }).end(JSON.stringify({ error: { message: "The model is overloaded right now.", type: "server_error" } }));
			return;
		}
		res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
		const base = { id: `cmpl_${Date.now()}`, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: String(parsed.model ?? "room-model") };
		const delta = (content: string) => res.write(sseChunk({ ...base, choices: [{ index: 0, delta: { role: "assistant", content }, finish_reason: null }] }));
		const finish = (reason: "stop" | "tool_calls") => {
			res.write(sseChunk({ ...base, choices: [{ index: 0, delta: {}, finish_reason: reason }], usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } }));
			res.end("data: [DONE]\n\n");
		};
		if (prompt.includes(SILENT_AFTER_TOOL) && toolResults.length === 0) {
			res.write(sseChunk({ ...base, choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: "call_memory_recall", type: "function", function: { name: "memory_recall", arguments: JSON.stringify({ query: "zebra" }) } }] }, finish_reason: null }] }));
			return finish("tool_calls");
		}
		if (prompt.includes(SILENT_AFTER_TOOL)) {
			// Nothing is sent and the answer never ends; the room's client going away ends it.
			silentResultAt = Date.now();
			res.flushHeaders();
			return;
		}
		if (prompt.includes(HELD_RECALL)) {
			if (toolResults.length === 0) {
				res.write(sseChunk({ ...base, choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: "call_memory_recall", type: "function", function: { name: "memory_recall", arguments: JSON.stringify({ query: "zebra" }) } }] }, finish_reason: null }] }));
				return finish("tool_calls");
			}
			heldResultAt = Date.now();
			setTimeout(() => {
				delta("Noted.");
				finish("stop");
			}, 400);
			return;
		}
		if (prompt.includes(RECALL) && toolResults.length === 0) {
			res.write(sseChunk({ ...base, choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: "call_memory_recall", type: "function", function: { name: "memory_recall", arguments: JSON.stringify({ query: "zebra" }) } }] }, finish_reason: null }] }));
			return finish("tool_calls");
		}
		if (prompt.includes(RECALL)) {
			recallResultAt = Date.now();
			recallResultText = toolResults.join("\n");
			delta("Noted.");
			return finish("stop");
		}
		if (prompt.includes(SLOW) || prompt.includes(ENDLESS)) {
			// An endless answer goes on until the room's client goes away.
			const parts = prompt.includes(SLOW) ? SLOW_PARTS : Number.POSITIVE_INFINITY;
			let part = 0;
			const timer = setInterval(() => {
				part += 1;
				delta(Number.isFinite(parts) ? `part ${part} of ${parts}. ` : `part ${part}. `);
				if (part >= parts) {
					clearInterval(timer);
					finish("stop");
				}
			}, PART_GAP_MS);
			res.on("close", () => clearInterval(timer));
			return;
		}
		delta("Hello.");
		finish("stop");
	});
});

// ---------------------------------------------------------------------------
// The server, as the launcher's loader mode starts it.
// ---------------------------------------------------------------------------
type Exited = { code: number | null; signal: NodeJS.Signals | null; at: number };
type Server = { process: ChildProcessWithoutNullStreams; port: number; home: string; output: () => string; exited: Promise<Exited> };
const running = new Set<Server>();
let homes = 0;
let gatewayPort = 0;

async function startServer(what: string, options: { preload?: string } = {}): Promise<Server> {
	const home = path.join(tempRoot, `home-${++homes}`);
	const agentDir = path.join(home, ".exxperts", "agent");
	const appRoot = path.join(home, ".exxperts", "app");
	fs.mkdirSync(agentDir, { recursive: true, mode: 0o700 });
	fs.mkdirSync(path.join(appRoot, "personalized-agents"), { recursive: true, mode: 0o700 });
	const write = (file: string, value: unknown) => fs.writeFileSync(file, JSON.stringify(value, null, 2), { mode: 0o600 });
	write(path.join(agentDir, "models.json"), { providers: { "openai-compatible": { name: "Stand-in Model", baseUrl: `http://127.0.0.1:${gatewayPort}/v1`, api: "openai-completions", models: [{ id: "room-model", name: "Room Model", contextWindow: 128000, maxTokens: 16384 }] } } });
	write(path.join(agentDir, "auth.json"), { "openai-compatible": { type: "api_key", key: "stand-in-stop-key" } });
	write(path.join(appRoot, "openai-compatible-ai-profile.json"), { profileId: "openai-compatible", providerId: "openai-compatible", label: "Stand-in Model", roomModels: [{ modelId: "room-model", label: "Room Model" }], maintenanceModel: "room-model" });
	write(path.join(appRoot, "persistent-agent-ai-profile.json"), { profileId: "openai-compatible" });
	// The runtime asks a busy model again after a wait the stop's own 2 s wait ends inside; the provider's client never retries.
	write(path.join(agentDir, "settings.json"), { retry: { baseDelayMs: RETRY_WAIT_MS, provider: { maxRetries: 0 } } });

	const port = await freePort();
	const env = smokeHomeEnv(home, { PORT: String(port), ...SMOKE_SERVER_AUTH_ENV, EXXETA_HOME: repoRoot });
	// The source runs, never a hand-built bundle.
	delete env.EXXPERTS_SERVER_BUNDLE;
	// Detached: the server leads its own process group, so a row can signal the group.
	const args = serverLaunchArgs(repoRoot, { tsxLoader: true, env: env as NodeJS.ProcessEnv });
	// A preload goes after tsx's loader, just before the server's entry.
	if (options.preload) args.splice(args.length - 1, 0, "--import", pathToFileURL(path.join(scriptDir, options.preload)).href);
	const child = spawn(process.execPath, args, { cwd: repoRoot, detached: true, env: env as NodeJS.ProcessEnv });
	let output = "";
	child.stdout.on("data", (chunk) => (output += String(chunk)));
	child.stderr.on("data", (chunk) => (output += String(chunk)));
	const exited = new Promise<Exited>((resolve) => child.once("exit", (code, signal) => resolve({ code, signal, at: Date.now() })));
	const server: Server = { process: child, port, home, output: () => output, exited };
	running.add(server);
	void exited.then(() => running.delete(server));
	const deadline = Date.now() + 60_000;
	for (;;) {
		if (child.exitCode !== null || child.signalCode !== null) throw new Error(`${what}: the server ended before it was ready:\n${output.slice(-3000)}`);
		try {
			if ((await fetch(`http://127.0.0.1:${port}/healthz`)).ok) return server;
		} catch {
			// Not up yet.
		}
		if (Date.now() > deadline) throw new Error(`${what}: the server was not ready within 60 s:\n${output.slice(-3000)}`);
		await sleep(150);
	}
}

// The server's own end within the bound, or the row fails and the server is killed.
async function endWithin(server: Server, ms: number, what: string): Promise<Exited> {
	let timer: NodeJS.Timeout | undefined;
	const ended = await Promise.race([server.exited, new Promise<null>((resolve) => (timer = setTimeout(() => resolve(null), ms)))]);
	clearTimeout(timer);
	if (ended === null) {
		server.process.kill("SIGKILL");
		await server.exited;
		throw new Error(`${what}: the server did not end within ${ms / 1000} s:\n${server.output().slice(-3000)}`);
	}
	return ended;
}
function assertCleanExit(ended: Exited, what: string): void {
	assert(ended.code === 0 && ended.signal === null, `${what}: the server ended with exit code ${ended.code} and signal ${ended.signal}, not exit code 0`);
}
const alive = (server: Server) => server.process.exitCode === null && server.process.signalCode === null;

async function requestJson(server: Server, pathname: string, init: AuthedFetchInit = {}): Promise<{ status: number; body: any }> {
	const response = await authedFetch(`http://127.0.0.1:${server.port}${pathname}`, { ...init, headers: { ...(init.body ? { "content-type": "application/json" } : {}), ...init.headers } });
	const text = await response.text();
	let body: any = text;
	try {
		body = text ? JSON.parse(text) : null;
	} catch {}
	return { status: response.status, body };
}

// A room with one active conversation on the stand-in model.
async function makeRoom(server: Server, name: string): Promise<{ roomId: string; conversationId: string; roomDir: string }> {
	const made = await requestJson(server, "/api/persistent-agents", { method: "POST", body: JSON.stringify({ displayName: name, userName: "Stop Person", preferredUserAddress: "Stop Person" }) });
	assert(made.status === 201, `creating a room: ${made.status} ${JSON.stringify(made.body)}`);
	const roomId = String(made.body?.agent?.id ?? "");
	const roomDir = path.join(server.home, ".exxperts", "app", "personalized-agents", roomId);
	assert(fs.existsSync(path.join(roomDir, "runtime")), `the room's folder is not where the smoke reads it: ${roomDir}`);
	const conversationId = `stopconv_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
	const thread = await requestJson(server, `/api/persistent-agents/${encodeURIComponent(roomId)}/threads/${encodeURIComponent(conversationId)}`, { method: "PUT", body: JSON.stringify({ state: "active", origin: "launcher", model: { provider: "openai-compatible", model: "room-model" }, items: [] }) });
	assert(thread.status === 200, `making the conversation active: ${thread.status} ${JSON.stringify(thread.body)}`);
	return { roomId, conversationId, roomDir };
}

// ---------------------------------------------------------------------------
// The live connection.
// ---------------------------------------------------------------------------
type Frame = Record<string, any>;
type Live = { frames: { at: number; frame: Frame }[]; send: (frame: Frame) => void; close: () => void; closed: () => { code: number; at: number } | null; waitFor: (wanted: (frame: Frame) => boolean, ms: number, from?: number) => Promise<{ at: number; frame: Frame } | null> };
const WebSocketImpl: any = (await import("ws")).default;

async function openLive(server: Server, roomId: string, conversationId: string, what: string): Promise<Live> {
	const socket = new WebSocketImpl(`ws://127.0.0.1:${server.port}/ws?persistentAgentId=${roomId}&conversationId=${conversationId}&modelProvider=openai-compatible&model=room-model&reattach=1`, { headers: { ...SMOKE_AUTH_HEADERS } });
	const frames: Live["frames"] = [];
	let closed: { code: number; at: number } | null = null;
	socket.on("message", (raw: unknown) => {
		try {
			frames.push({ at: Date.now(), frame: JSON.parse(String(raw)) });
		} catch {}
	});
	socket.on("close", (code: number) => (closed = { code, at: Date.now() }));
	socket.on("error", () => {});
	const waitFor: Live["waitFor"] = async (wanted, ms, from = 0) => {
		const deadline = Date.now() + ms;
		for (;;) {
			const found = frames.slice(from).find((entry) => wanted(entry.frame));
			if (found) return found;
			if (Date.now() >= deadline) return null;
			await sleep(20);
		}
	};
	const live: Live = { frames, send: (frame) => socket.send(JSON.stringify(frame)), close: () => socket.close(), closed: () => closed, waitFor };
	assert(await waitFor((frame) => frame.type === "ready", 45_000), `${what}: the live connection did not bind (ready): ${JSON.stringify(frames.map((entry) => entry.frame.type))}`);
	return live;
}

const isDelta = (frame: Frame) => frame.type === "event" && frame.event?.type === "message_update" && frame.event.assistantMessageEvent?.type === "text_delta";
const isEnd = (type: string) => (frame: Frame) => frame.type === "event" && frame.event?.type === type;
const deltasOf = (live: Live) => live.frames.filter((entry) => isDelta(entry.frame)).map((entry) => String(entry.frame.event?.assistantMessageEvent?.delta ?? "")).join("");

async function promptUntilFirstDelta(live: Live, text: string, what: string): Promise<void> {
	const from = live.frames.length;
	live.send({ type: "prompt", text });
	assert(await live.waitFor(isDelta, 30_000, from), `${what}: no delta within 30 s: ${JSON.stringify(live.frames.slice(from).map((entry) => entry.frame))}`);
}

// ---------------------------------------------------------------------------
// The room's files.
// ---------------------------------------------------------------------------
function threadPath(roomDir: string, conversationId: string): string {
	return path.join(roomDir, "runtime", "threads", `${conversationId}.json`);
}
function sessionText(roomDir: string, conversationId: string): string {
	const rel = (JSON.parse(fs.readFileSync(threadPath(roomDir, conversationId), "utf8")) as { runtime?: { sessionFileRelPath?: string } }).runtime?.sessionFileRelPath;
	assert(rel, "the conversation names no session file");
	return fs.readFileSync(path.join(roomDir, rel), "utf8");
}
// The session file's last assistant message: its text and its stopReason.
function lastAssistant(roomDir: string, conversationId: string): { text: string; stopReason: string } | null {
	let last: { text: string; stopReason: string } | null = null;
	for (const line of sessionText(roomDir, conversationId).split("\n")) {
		if (!line.trim()) continue;
		let entry: { type?: string; message?: { role?: string; stopReason?: string; content?: { type?: string; text?: string }[] } };
		try {
			entry = JSON.parse(line);
		} catch {
			continue;
		}
		if (entry.type !== "message" || entry.message?.role !== "assistant") continue;
		const text = (entry.message.content ?? []).filter((part) => part.type === "text").map((part) => part.text ?? "").join("");
		last = { text, stopReason: String(entry.message.stopReason ?? "") };
	}
	return last;
}

const passed: string[] = [];
function pass(line: string): void {
	passed.push(line);
	console.log(`${SMOKE}: ${line}`);
}

// ---------------------------------------------------------------------------
// The rows.
// ---------------------------------------------------------------------------
async function idleStop(): Promise<void> {
	const s = await startServer("the idle stop");
	const signalledAt = Date.now();
	s.process.kill("SIGTERM");
	const ended = await endWithin(s, 5_000, "the idle stop");
	assertCleanExit(ended, "the idle stop");
	assert(ended.at - signalledAt <= 1_000, `the idle stop took ${ended.at - signalledAt} ms, not at most 1 s`);
	pass(`an idle stop on SIGTERM ends with exit code 0, no signal, ${ended.at - signalledAt} ms after it (at most 1 s)`);
}

// The close lands the partial the client never saved, as cut. The stop's
// wait is 2 s, so its endings start 2 s after the signal at the latest.
const STOP_WAIT_MS = 2_000;
const ENDINGS_CEILING_MS = 1_000;
async function answerCut(): Promise<void> {
	const s = await startServer("the cut answer");
	const { roomId, conversationId, roomDir } = await makeRoom(s, "Cut Room");
	const live = await openLive(s, roomId, conversationId, "the cut answer");
	await promptUntilFirstDelta(live, `Tell me everything. ${ENDLESS}`, "the cut answer");
	const signalledAt = Date.now();
	s.process.kill("SIGTERM");
	await sleep(1_000);
	assert(alive(s), "control: the server ended within 1 s of the signal with an answer running");
	const ended = await endWithin(s, 8_000, "the cut answer");
	assertCleanExit(ended, "the cut answer");
	assert(ended.at - signalledAt <= 4_000, `the cut answer: the server ended ${ended.at - signalledAt} ms after the signal, not within 4 s`);
	const messageEnd = live.frames.find((entry) => isEnd("message_end")(entry.frame) && entry.frame.event?.message?.role === "assistant");
	const agentEnd = live.frames.find((entry) => isEnd("agent_end")(entry.frame));
	assert(messageEnd?.frame.event?.stoppedByServer === true && agentEnd?.frame.event?.stoppedByServer === true, `the cut answer: the end frames do not carry stoppedByServer: ${JSON.stringify([messageEnd?.frame.event?.stoppedByServer, agentEnd?.frame.event?.stoppedByServer])}`);
	assert(live.frames.filter((entry) => entry.frame.type === "server_stopping").length === 1, "the cut answer: the stop's frame did not come exactly once");
	const saved = lastAssistant(roomDir, conversationId);
	assert(saved?.stopReason === "aborted" && saved.text.includes("part 1. "), `the cut answer: the session file's last assistant message is not the aborted partial: ${JSON.stringify(saved)}`);
	// This client never saves the thread, as a page closed with the server: the server lands the partial.
	const cutThread = JSON.parse(fs.readFileSync(threadPath(roomDir, conversationId), "utf8")) as { state?: string; items?: { kind?: string; text?: string; level?: string }[] };
	const cutItems = cutThread.items ?? [];
	const cutUser = cutItems.findIndex((item) => item.kind === "user" && String(item.text ?? "").startsWith("Tell me everything."));
	const cutPartial = cutItems.findIndex((item, index) => index > cutUser && item.kind === "assistant" && String(item.text ?? "").includes("part 1. "));
	assert(cutUser >= 0 && cutPartial > cutUser, `the cut answer: the thread does not hold the message and, after it, the partial: ${JSON.stringify(cutItems)}`);
	const afterPartial = cutItems.slice(cutPartial + 1);
	assert(afterPartial.length === 1 && afterPartial[0].kind === "system" && afterPartial[0].level === "error" && afterPartial[0].text === STOP_CUT_ANSWER_SENTENCE, `the cut answer: the thread does not hold the stop's sentence, alone, after the partial: ${JSON.stringify(cutItems)}`);
	assert(cutThread.state === "standby", `the cut answer: the conversation is ${cutThread.state}, not parked (standby)`);
	const markerPath = path.join(roomDir, "runtime", "unseen-landed-answer.json");
	const marker = fs.existsSync(markerPath) ? (JSON.parse(fs.readFileSync(markerPath, "utf8")) as { threadId?: string; terminalReason?: string; landedAt?: number }) : null;
	assert(marker?.threadId === conversationId && marker.terminalReason === "failed", `the cut answer: no unseen marker for a cut answer: ${JSON.stringify(marker)}`);
	const landedAfterEndings = (marker.landedAt ?? Number.POSITIVE_INFINITY) - (signalledAt + STOP_WAIT_MS);
	assert(landedAfterEndings <= ENDINGS_CEILING_MS, `the cut answer: the landing finished ${landedAfterEndings} ms after the stop's endings began, not within the ${ENDINGS_CEILING_MS} ms ceiling`);
	pass(`an endless answer, SIGTERM at its first delta: still running 1 s after the signal; its end frames carry stoppedByServer; exit code 0 ${ended.at - signalledAt} ms after the signal (at most 4 s); the session file keeps the partial (stopReason aborted); the thread, never saved by the client, is landed by the close ${Math.max(0, landedAfterEndings)} ms into the endings (ceiling ${ENDINGS_CEILING_MS} ms): the message, the partial, then the stop's sentence at level error, parked, with an unseen marker`);

	const k = await startServer("the whole answer");
	const whole = await makeRoom(k, "Whole Room");
	const kept = await openLive(k, whole.roomId, whole.conversationId, "the whole answer");
	await promptUntilFirstDelta(kept, `Tell me a little. ${SLOW}`, "the whole answer");
	const keptAt = Date.now();
	k.process.kill("SIGTERM");
	const keptEnded = await endWithin(k, 8_000, "the whole answer");
	assertCleanExit(keptEnded, "the whole answer");
	const keptEnd = kept.frames.find((entry) => isEnd("agent_end")(entry.frame));
	assert(deltasOf(kept).includes(`part ${SLOW_PARTS} of ${SLOW_PARTS}.`) && keptEnd && keptEnd.frame.event?.stoppedByServer === undefined, `control: an answer ending inside the wait did not arrive whole and unflagged: ${JSON.stringify(deltasOf(kept))}`);
	const keptSaved = lastAssistant(whole.roomDir, whole.conversationId);
	assert(keptSaved?.text.includes(`part ${SLOW_PARTS} of ${SLOW_PARTS}.`) && keptSaved.stopReason !== "aborted", `control: the session file does not hold the whole answer: ${JSON.stringify(keptSaved)}`);
	pass(`control: an answer of about 1 s, SIGTERM at its first delta, arrives whole without the flag and is whole in the session file; exit code 0 ${keptEnded.at - keptAt} ms after the signal`);
}

// A turn that went on alone after its person left and is cut with no text: a
// turn that ran a tool is not handed back to the box, so the landing speaks.
async function aloneCutWithoutText(): Promise<void> {
	const what = "the turn cut alone with no text";
	const s = await startServer(what);
	const { roomId, conversationId, roomDir } = await makeRoom(s, "Alone Room");
	const live = await openLive(s, roomId, conversationId, what);
	silentResultAt = 0;
	live.send({ type: "prompt", text: `Look it up. ${SILENT_AFTER_TOOL}` });
	const deadline = Date.now() + 30_000;
	while (silentResultAt === 0 && Date.now() < deadline) await sleep(20);
	assert(silentResultAt > 0, `${what}: the stand-in never got the recall's result`);
	live.close();
	await sleep(500);
	const signalledAt = Date.now();
	s.process.kill("SIGTERM");
	const ended = await endWithin(s, 8_000, what);
	assertCleanExit(ended, what);
	assert(ended.at - signalledAt <= 4_000, `${what}: the server ended ${ended.at - signalledAt} ms after the signal, not within 4 s`);
	const items = ((JSON.parse(fs.readFileSync(threadPath(roomDir, conversationId), "utf8")) as { items?: { id?: string; kind?: string; text?: string; level?: string }[] }).items ?? []);
	assert(items.some((item) => String(item.id ?? "").startsWith("detached-step-")), `${what}: the thread holds no landed step for the recall, so the row cannot tell the turn ran a tool: ${JSON.stringify(items)}`);
	assert(items.some((item) => item.kind === "system" && item.level === "error" && item.text === STOP_CUT_ANSWER_SENTENCE), `${what}: the thread holds no error item with the stop's sentence: ${JSON.stringify(items)}`);
	assert(!items.some((item) => String(item.text ?? "").includes("after you left the room")), `${what}: the thread holds the away line: ${JSON.stringify(items)}`);
	pass(`a turn that went on alone after its person left, cut after a recall with no text: exit code 0 ${ended.at - signalledAt} ms after the signal (at most 4 s); the thread holds the recall's landed step and the stop's sentence at level error, never the away line`);
}

async function refusedWhileStopping(): Promise<void> {
	const s = await startServer("the refused message");
	const busy = await makeRoom(s, "Busy Room");
	const idle = await makeRoom(s, "Idle Room");
	const a = await openLive(s, busy.roomId, busy.conversationId, "the refused message, the busy room");
	const b = await openLive(s, idle.roomId, idle.conversationId, "the refused message, the idle room");
	b.send({ type: "prompt", text: "Say hello." });
	assert(await b.waitFor(isEnd("agent_end"), 30_000), "control: a message before the signal did not run a turn");
	await promptUntilFirstDelta(a, `Keep going. ${ENDLESS}`, "the refused message, the busy room");
	await sleep(300);
	const threadBefore = fs.readFileSync(threadPath(idle.roomDir, idle.conversationId), "utf8");
	const sessionBefore = sessionText(idle.roomDir, idle.conversationId);

	s.process.kill("SIGTERM");
	assert(await b.waitFor((frame) => frame.type === "server_stopping", 3_000), "the idle room's live connection got no stop frame");
	const from = b.frames.length;
	b.send({ type: "prompt", text: "Say hello again." });
	const refused = await b.waitFor((frame) => frame.type === "error", 1_500, from);
	assert(refused?.frame.code === SERVER_STOPPING_CODE && refused.frame.message === SERVER_STOPPING_SENTENCE, `a message while stopping is not refused with the code: ${JSON.stringify(refused?.frame)}`);
	await sleep(200);
	assert(alive(s), "the refused message: the server ended before the session and thread were read");
	assert(fs.readFileSync(threadPath(idle.roomDir, idle.conversationId), "utf8") === threadBefore, "the refused message changed the thread");
	assert(sessionText(idle.roomDir, idle.conversationId) === sessionBefore, "the refused message changed the session file");
	assert(!b.frames.slice(from).some((entry) => isEnd("agent_start")(entry.frame) || isDelta(entry.frame)), "the refused message started a turn");
	assertCleanExit(await endWithin(s, 8_000, "the refused message"), "the refused message");
	pass(`a message sent while stopping gets the error frame with ${SERVER_STOPPING_CODE} and the stop's sentence; the session file and the thread are unchanged; exit code 0. Control: the same message before the signal ran a turn`);
}

// A request that reaches the server after its close began, on a connection
// busy across the close (a request whose body is still coming, then one sent
// behind it), goes through the stop's door like any other: a route that
// starts work gets the door's own answer and a plain read is served, never
// the web framework's bare "Service Unavailable".
async function requestsDuringClose(): Promise<void> {
	const what = "a request during the server's close";
	const s = await startServer(what);
	const head = (method: string, url: string, length?: number) => `${method} ${url} HTTP/1.1\r\nHost: 127.0.0.1\r\nX-Exxperts-Auth: ${SMOKE_AUTH_HEADERS["X-Exxperts-Auth"]}\r\n${length === undefined ? "" : `Content-Type: application/json\r\nContent-Length: ${length}\r\n`}\r\n`;
	// One connection kept busy across the close: the first request's body is held back.
	const busyConnection = async () => {
		const socket = net.connect(s.port, "127.0.0.1");
		await new Promise<void>((resolve, reject) => { socket.once("connect", () => resolve()); socket.once("error", reject); });
		let received = "";
		socket.on("data", (chunk) => (received += String(chunk)));
		socket.on("error", () => {});
		const ended = new Promise<void>((resolve) => socket.once("close", () => resolve()));
		socket.write(head("PUT", "/api/persistent-agents/held-room/threads/held-conversation", 2));
		return { socket, received: () => received, ended };
	};
	const refusedRoute = await busyConnection();
	const plainRead = await busyConnection();
	await sleep(200);
	s.process.kill("SIGTERM");
	// The close has begun once the server takes no new connection.
	for (const deadline = Date.now() + 3_000; ;) {
		const refused = await new Promise<boolean>((resolve) => {
			const probe = net.connect(s.port, "127.0.0.1");
			probe.once("connect", () => { probe.destroy(); resolve(false); });
			probe.once("error", () => resolve(true));
		});
		if (refused) break;
		assert(Date.now() < deadline, `${what}: the server still took new connections 3 s after the signal`);
		await sleep(5);
	}
	refusedRoute.socket.write(`{}${head("POST", "/api/persistent-agents/held-room/checkpoint/propose", 2)}{}`);
	plainRead.socket.write(`{}${head("GET", "/api/persistent-agents")}`);
	await Promise.race([Promise.all([refusedRoute.ended, plainRead.ended]), sleep(5_000)]);
	// The second response on each connection: its status line and its body.
	const second = (received: string) => {
		const responses = received.split(/(?=HTTP\/1\.1 \d{3} )/).filter(Boolean);
		const response = responses[1] ?? "";
		return { status: Number(/^HTTP\/1\.1 (\d{3})/.exec(response)?.[1] ?? 0), body: response.slice(response.indexOf("\r\n\r\n") + 4), all: received };
	};
	const refused = second(refusedRoute.received());
	const read = second(plainRead.received());
	const bare = (response: { all: string }) => response.all.includes('"message":"Service Unavailable"');
	assert(!bare(refused) && !bare(read), `${what}: a request during the close got the framework's bare 503: ${JSON.stringify(refused.all.slice(0, 600))} | ${JSON.stringify(read.all.slice(0, 600))}`);
	assert(refused.status === 503 && refused.body.includes(SERVER_STOPPING_CODE), `${what}: a route that starts work gets the door's answer, got ${refused.status} ${JSON.stringify(refused.all.slice(0, 600))}`);
	assert(read.status === 200, `${what}: a plain read is served, got ${read.status} ${JSON.stringify(read.all.slice(0, 600))}`);
	assertCleanExit(await endWithin(s, 8_000, what), what);
	pass(`a request sent on a busy connection after the close began: a route that starts work gets ${SERVER_STOPPING_CODE}, a plain read is served, neither gets the framework's bare 503; exit code 0`);
}

// The stop's endings end the runtime's wait to ask a busy model again: the
// message goes back to the box as stopped, without the busy reply's cause.
async function retryWaitStopped(): Promise<void> {
	const what = "the stop in a retry wait";
	const s = await startServer(what);
	const { roomId, conversationId } = await makeRoom(s, "Busy Room");
	const live = await openLive(s, roomId, conversationId, what);
	busyReplies = 0;
	const text = `Are you there? ${BUSY}`;
	live.send({ type: "prompt", text });
	assert(await live.waitFor(isEnd("auto_retry_start"), 30_000), `${what}: the runtime did not wait to ask again: ${JSON.stringify(live.frames.map((entry) => entry.frame.type))}`);
	const signalledAt = Date.now();
	s.process.kill("SIGTERM");
	const ended = await endWithin(s, 8_000, what);
	assertCleanExit(ended, what);
	assert(busyReplies === 1, `control: the stand-in sent ${busyReplies} busy replies, so the stop did not end the ${RETRY_WAIT_MS / 1000} s wait before the runtime asked again`);
	const returned = live.frames.find((entry) => entry.frame.type === "prompt_returned")?.frame;
	assert(returned?.text === text && returned.stopped === true && returned.failure === undefined && returned.words === undefined, `${what}: the message did not come back as stopped: ${JSON.stringify(returned)}`);
	pass(`a stop while the runtime waits ${RETRY_WAIT_MS / 1000} s to ask a busy model again: the message comes back as stopped, with no cause or words of the busy reply; exit code 0 ${ended.at - signalledAt} ms after the signal. Control: one busy reply, so the wait was ended before the next ask`);
}

// The stop comes once a watched answer has ended, while the runtime's
// post-turn work still runs: the preload signals the stop at the answer's end
// and holds that work open past the stop's close. The person watched the whole
// answer, so it lands as watched: whole, without the stop's line, not parked,
// no unseen marker.
async function watchedTail(): Promise<void> {
	const what = "the stop in a watched answer's tail";
	const s = await startServer(what, { preload: "server-stop-tail-preload.mjs" });
	const { roomId, conversationId, roomDir } = await makeRoom(s, "Tail Room");
	const live = await openLive(s, roomId, conversationId, what);
	live.send({ type: "prompt", text: `Say hello. ${TAIL}` });
	const ended = await endWithin(s, 10_000, what);
	assertCleanExit(ended, what);
	const agentEnd = live.frames.find((entry) => isEnd("agent_end")(entry.frame));
	const closed = live.closed();
	assert(deltasOf(live) === "Hello." && agentEnd && agentEnd.frame.event?.stoppedByServer === undefined && closed && agentEnd.at <= closed.at, `control: the answer did not end whole, unflagged, before the stop's close: ${JSON.stringify({ deltas: deltasOf(live), agentEnd: !!agentEnd, closed })}`);
	assert(s.output().includes("finishing the response in the background"), `control: the stop's close did not come while the post-turn work still ran:\n${s.output().slice(-3000)}`);
	const thread = JSON.parse(fs.readFileSync(threadPath(roomDir, conversationId), "utf8")) as { state?: string; items?: { kind?: string; text?: string; level?: string }[] };
	const items = thread.items ?? [];
	const user = items.findIndex((item) => item.kind === "user" && String(item.text ?? "").startsWith("Say hello."));
	assert(user >= 0 && items.slice(user + 1).some((item) => item.kind === "assistant" && item.text === "Hello."), `${what}: the thread does not hold the message and, after it, the whole answer: ${JSON.stringify(items)}`);
	assert(!items.some((item) => item.text === STOP_CUT_ANSWER_SENTENCE || String(item.text ?? "").includes("after you left the room")), `${what}: the thread holds the stop's line or the away line: ${JSON.stringify(items)}`);
	assert(thread.state !== "standby", `${what}: the conversation was parked (standby), as if nobody watched the answer`);
	const markerPath = path.join(roomDir, "runtime", "unseen-landed-answer.json");
	const marker = fs.existsSync(markerPath) ? (JSON.parse(fs.readFileSync(markerPath, "utf8")) as { threadId?: string }) : null;
	assert(marker?.threadId !== conversationId, `${what}: the watched answer got an unseen marker: ${JSON.stringify(marker)}`);
	pass(`a stop once a watched answer has ended, while the runtime's post-turn work outlasts the stop's close: the answer lands whole as watched (no stop line, conversation ${thread.state}, no unseen marker); exit code 0. Control: the answer ended unflagged before the close, and the close came while that work still ran`);
}

// A thin answer after a recall asks the model once more for a real answer.
// That ask is a fresh paid turn, so a stop never starts it: the exit would end it.
async function noRecoveryWhileStopping(): Promise<void> {
	const what = "the recovery ask during the stop";
	const s = await startServer(what);
	const control = await makeRoom(s, "Recall Room");
	const held = await makeRoom(s, "Held Room");
	const c = await openLive(s, control.roomId, control.conversationId, `${what}, the control`);
	recoveryAsks.length = 0;
	c.send({ type: "prompt", text: `Where is the crossing? ${RECALL}` });
	const controlDeadline = Date.now() + 30_000;
	while (recoveryAsks.length === 0 && Date.now() < controlDeadline) await sleep(20);
	assert(recoveryAsks.length > 0, `control: a thin answer after a recall, with no stop, made no recovery ask: ${JSON.stringify(c.frames.map((entry) => entry.frame.type))}`);
	await sleep(500);
	const h = await openLive(s, held.roomId, held.conversationId, what);
	heldResultAt = 0;
	h.send({ type: "prompt", text: `Look it up. ${HELD_RECALL}` });
	const deadline = Date.now() + 30_000;
	while (heldResultAt === 0 && Date.now() < deadline) await sleep(20);
	assert(heldResultAt > 0, `${what}: the stand-in never got the held recall's result`);
	const signalledAt = Date.now();
	s.process.kill("SIGTERM");
	const ended = await endWithin(s, 8_000, what);
	assertCleanExit(ended, what);
	const agentEnd = h.frames.find((entry) => isEnd("agent_end")(entry.frame) && entry.at >= signalledAt);
	assert(deltasOf(h).includes("Noted.") && agentEnd && agentEnd.frame.event?.stoppedByServer === undefined, `control: the thin answer did not end by itself during the stop's wait: ${JSON.stringify(deltasOf(h))}`);
	const asked = recoveryAsks.filter((at) => at >= signalledAt).length;
	assert(asked === 0, `${what}: a thin answer that ended during the stop's wait made ${asked} recovery ask(s), a paid turn the exit ends`);
	pass(`a thin answer after a recall, ended by itself during the stop's wait, makes no recovery ask; exit code 0 ${ended.at - signalledAt} ms after the signal. Control: the same shape before the signal makes one`);
}

// Two signals within 1 s, then a SIGINT 1.2 s after the first.
async function signalPair(label: string, send: (s: Server) => Promise<void>): Promise<void> {
	const s = await startServer(label);
	const { roomId, conversationId } = await makeRoom(s, "Signal Room");
	const live = await openLive(s, roomId, conversationId, label);
	await promptUntilFirstDelta(live, `Keep going. ${ENDLESS}`, label);
	const firstAt = Date.now();
	await send(s);
	await sleep(Math.max(0, firstAt + 1_100 - Date.now()));
	assert(alive(s), `${label}: the server ended on the second signal, within 1 s of the first`);
	await sleep(Math.max(0, firstAt + 1_200 - Date.now()));
	const lateAt = Date.now();
	s.process.kill("SIGINT");
	const ended = await endWithin(s, 3_000, label);
	assertCleanExit(ended, label);
	assert(ended.at - lateAt <= 500 && ended.at - firstAt < 2_000, `${label}: the late SIGINT ended the server ${ended.at - lateAt} ms after it (${ended.at - firstAt} ms after the first signal), not at once and before the wait's end`);
	assert(s.output().includes("server stop: a second SIGINT; exiting now"), `${label}: no line for the late SIGINT`);
	pass(`${label}: still running 1.1 s after the first signal; a SIGINT 1.2 s after the first ends it ${ended.at - lateAt} ms later with exit code 0, before the 2 s wait's end`);
}

async function signals(): Promise<void> {
	await signalPair("SIGINT then SIGTERM 200 ms later", async (s) => {
		s.process.kill("SIGINT");
		await sleep(200);
		s.process.kill("SIGTERM");
	});
	await signalPair("a SIGTERM to the process group and one to the server", async (s) => {
		process.kill(-(s.process.pid as number), "SIGTERM");
		s.process.kill("SIGTERM");
	});
	const c = await startServer("one SIGINT");
	const { roomId, conversationId } = await makeRoom(c, "Signal Room");
	const live = await openLive(c, roomId, conversationId, "one SIGINT");
	await promptUntilFirstDelta(live, `Keep going. ${ENDLESS}`, "one SIGINT");
	const at = Date.now();
	c.process.kill("SIGINT");
	await sleep(1_000);
	assert(alive(c), "control: one SIGINT with an answer running ended the server within 1 s");
	const ended = await endWithin(c, 8_000, "one SIGINT");
	assertCleanExit(ended, "one SIGINT");
	assert(c.output().includes("server stop: started by SIGINT;"), "control: one SIGINT did not start the stop");
	pass(`control: one SIGINT with an answer running starts the stop and waits: still running 1 s after it, exit code 0 ${ended.at - at} ms after it`);
}

async function exitListeners(): Promise<void> {
	const run = async (signal: NodeJS.Signals, what: string): Promise<string | null> => {
		const s = await startServer(what);
		const { roomId, conversationId, roomDir } = await makeRoom(s, "Recall Room");
		const seeded = await requestJson(s, `/api/persistent-agents/${encodeURIComponent(roomId)}/memory/entries`, { method: "POST", body: JSON.stringify({ kind: "fact", topic: "Crossings", text: "The zebra crossing sits on Kestrel Street." }) });
		assert(seeded.status === 200, `${what}: seeding the note: ${seeded.status} ${JSON.stringify(seeded.body)}`);
		const live = await openLive(s, roomId, conversationId, what);
		recallResultAt = 0;
		recallResultText = "";
		live.send({ type: "prompt", text: `Where is the crossing? ${RECALL}` });
		// Polled closely: the recall is counted when the tool runs, and written 200 ms later.
		const deadline = Date.now() + 30_000;
		while (recallResultAt === 0 && Date.now() < deadline) await sleep(2);
		assert(recallResultAt > 0, `${what}: the room never recalled (the stand-in got no tool result)`);
		assert(recallResultText.includes("Kestrel Street"), `${what}: the recall did not show the seeded note: ${recallResultText.slice(0, 500)}`);
		await sleep(Math.max(0, recallResultAt + 50 - Date.now()));
		s.process.kill(signal);
		const ended = await endWithin(s, 8_000, what);
		if (signal === "SIGTERM") assertCleanExit(ended, what);
		const usePath = path.join(roomDir, "runtime", "memory-use.json");
		return fs.existsSync(usePath) ? fs.readFileSync(usePath, "utf8") : null;
	};
	const counted = (text: string | null) => (text ? Object.values((JSON.parse(text) as { notes?: Record<string, { hits?: number }> }).notes ?? {}).some((row) => (row.hits ?? 0) >= 1) : false);
	const clean = await run("SIGTERM", "the exit listeners");
	assert(counted(clean), `the memory-use counters do not hold the recall made 50 ms before the signal: ${clean}`);
	const killed = await run("SIGKILL", "the exit listeners' control");
	assert(!counted(killed), `control: SIGKILL 50 ms after the recall kept the counter, so the row cannot tell the exit listeners ran: ${killed}`);
	pass("a note recalled by the room, SIGTERM 50 ms later: after the exit the memory-use counters hold the recall. Control: the same steps ended by SIGKILL lose it");
}

// In this process, which installs the stop as the server does: the stop comes
// once a scheduled run's answer has ended, while a patched prompt holds the
// runtime's post-turn work open. The run completes with the whole answer.
// Last, since the stop stays installed here and takes over process.exit.
async function scheduledTail(): Promise<void> {
	const what = "the stop in a scheduled run's tail";
	const s = await startServer(what);
	const { roomId } = await makeRoom(s, "Scheduled Room");
	s.process.kill("SIGTERM");
	assertCleanExit(await endWithin(s, 5_000, what), what);
	const agentDir = path.join(s.home, ".exxperts", "agent");
	Object.assign(process.env, { HOME: s.home, USERPROFILE: s.home, EXXETA_HOME: repoRoot, EXXPERTS_CODING_AGENT_DIR: agentDir, EXXETA_PERSISTENT_AGENTS_ROOT: path.join(s.home, ".exxperts", "app", "personalized-agents") });
	delete process.env.EXXPERTS_DATA_DIR;
	delete process.env.EXXPERTS_STATE_HOME;
	const runtime = (await import("@exxeta/exxperts-runtime")) as unknown as { AgentSession: { prototype: { prompt: (this: unknown, text: string, options?: unknown) => Promise<void> } } };
	const background = await import("../src/persistent-room-background-execution.js");
	const { getPersistentAgentThread } = await import("../src/persistent-agents.js");
	const prompt = runtime.AgentSession.prototype.prompt;
	const realExit = process.exit;
	let stopExitCode: number | undefined;
	let stopAt = 0;
	try {
		process.exit = ((code?: number) => {
			stopExitCode = code ?? 0;
		}) as typeof process.exit;
		installServerStop({
			app: { close: async () => {}, server: { closeAllConnections: () => {} } } as unknown as Parameters<typeof installServerStop>[0]["app"],
			sharedServer: false,
			waitSeconds: () => 0,
			turnsRunning: () => 0,
			specialistTasksRunning: () => 0,
			abortSpecialistTasks: () => {},
			schedulerTickRunning: () => false,
			stopLoops: () => {},
		});
		runtime.AgentSession.prototype.prompt = async function (this: unknown, text: string, options?: unknown) {
			await prompt.call(this, text, options);
			if (!text.includes(TAIL)) return;
			stopAt = Date.now();
			process.emit("SIGTERM", "SIGTERM");
			await sleep(300);
		};
		const runId = "stop-tail";
		let failure: unknown;
		const result = await background.executePersistentRoomBackgroundPrompt({ roomId, target: { kind: "fresh-thread", model: { provider: "openai-compatible", model: "room-model" } }, prompt: `Say hello. ${TAIL}`, executionId: runId, agentDir } as Parameters<typeof background.executePersistentRoomBackgroundPrompt>[0]).catch((error: unknown) => {
			failure = error;
			return null;
		});
		const deadline = Date.now() + 3_000;
		while (stopExitCode === undefined && Date.now() < deadline) await sleep(20);
		assert(stopAt > 0 && serverStopping() && stopExitCode === 0, `control: the stop did not run to its end in the run's tail (${JSON.stringify({ stopAt, stopExitCode })})`);
		const items = (getPersistentAgentThread(roomId, background.scheduledPromptBackgroundThreadId(runId))?.items ?? []) as { id?: string; kind?: string; text?: string }[];
		assert(!failure, `${what}: the run failed with ${JSON.stringify((failure as Error)?.message)} (code ${JSON.stringify((failure as { code?: unknown })?.code)}); the thread: ${JSON.stringify(items)}`);
		assert(result?.assistantText === "Hello.", `${what}: the run did not complete with the whole answer: ${JSON.stringify(result?.assistantText)}`);
		assert(items.find((item) => item.id === background.scheduledPromptBackgroundAssistantItemId(runId))?.text === "Hello." && !items.some((item) => item.text === STOP_SCHEDULED_RUN_SENTENCE), `${what}: the thread does not hold the whole answer without the stop's line: ${JSON.stringify(items)}`);
		pass(`a stop once a scheduled run's answer has ended, while the runtime's post-turn work still runs: the run completes with the whole answer and no stop line. Control: the stop ran to its end during that tail`);
	} finally {
		process.exit = realExit;
		runtime.AgentSession.prototype.prompt = prompt;
	}
}

try {
	await new Promise<void>((resolve) => gateway.listen(0, "127.0.0.1", resolve));
	gatewayPort = (gateway.address() as AddressInfo).port;
	await idleStop();
	await answerCut();
	await aloneCutWithoutText();
	await refusedWhileStopping();
	await requestsDuringClose();
	await retryWaitStopped();
	await watchedTail();
	await noRecoveryWhileStopping();
	await signals();
	await exitListeners();
	await scheduledTail();
	console.log(`${SMOKE}: OK (${passed.length} rows)`);
} catch (error) {
	for (const server of running) console.error(server.output().slice(-4000));
	throw error;
} finally {
	for (const server of [...running]) {
		server.process.kill("SIGKILL");
		await Promise.race([server.exited, sleep(5_000)]);
	}
	try {
		(gateway as unknown as { closeAllConnections?: () => void }).closeAllConnections?.();
	} catch {}
	gateway.close();
	fs.rmSync(tempRoot, { recursive: true, force: true });
}
