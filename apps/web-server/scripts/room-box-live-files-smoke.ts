// A live conversation's file tools in the box, on a Mac. A real server runs in
// this process, so the box can be watched where room-box-files-smoke watches it:
// each file call's program, and a job left behind played by swapping a path
// between the server's check and the program's open. A gateway plays the model
// and makes real tool calls through real room connections, from the computer
// and from a phone. Each row reads what the model got back.
//
// The rows run in order: a box that fails before any command has run must come
// before the turn that runs one. On any other computer each row says it was
// skipped, by name. Run: npm run smokes -- room-box-live-files
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { pairDevice } from "./smoke-pairing.js";
import { authedFetch, freePort, SMOKE_AUTH_HEADERS, SMOKE_SERVER_AUTH_ENV, type AuthedFetchInit, putRunWithoutAsking } from "./smoke-server-process.js";
import { waitForTurnSettled } from "./smoke-turn-settle.js";
import { waitEvery } from "./smoke-wait.js";

const ROWS = [
	"a live turn's read and write run in the box",
	"a swap between check and open in a live turn: the read gets nothing, and the write lands nowhere",
	"a box that fails in a live turn with no command since the computer started: file tools go on behind the server's fence",
	"a rebind on the same connection keeps the same box",
	"a phone's turn reads and writes in the box",
	"Stop in a live turn ends the file program at once, and a slow search ends at its deadline",
	"after a live turn ends, its file programs and its box are gone",
	"a server where commands don't run in a box: a live turn's file tools work as before, with no box",
	"a live command's long output reads by its exact path with the read tool",
	"after a command has run, a box that fails in a live turn stops file tools with the plain line",
];

if (process.platform !== "darwin") {
	for (const name of ROWS) console.log(`  skip ${name} (needs a Mac)`);
	process.exit(0);
}

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

const waitUntil = waitEvery(25, 30_000);
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..", "..", "..");
const tempRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "exxperts-box-live-files-")));
const home = path.join(tempRoot, "home");
const agentDir = path.join(home, ".exxperts", "agent");
const appRoot = path.join(home, ".exxperts", "app");
const agentsRoot = path.join(appRoot, "personalized-agents");
const folder = path.join(home, "room-folder");
const elsewhere = path.join(home, "elsewhere");
for (const dir of [agentDir, agentsRoot, folder, elsewhere]) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
const inRoom = (...names: string[]) => path.join(folder, ...names);
const MODEL = { provider: "openai-compatible", model: "room-model" };

// --- The gateway plays the model: each leg of a turn makes its scripted calls, then it answers in words.
type Call = { name: string; args: Record<string, unknown> };
/** A leg's calls, or what makes them from the results so far in this turn. */
type Leg = Call[] | ((results: string[]) => Call[]);
let legs: Leg[] = [];
let toolResults: string[] = [];
const sse = (payload: unknown): string => `data: ${JSON.stringify(payload)}\n\n`;
const gateway = http.createServer((req, res) => {
	let body = "";
	req.on("data", (chunk) => { body += chunk; });
	req.on("end", () => {
		const parsed = JSON.parse(body || "{}");
		const messages: any[] = Array.isArray(parsed.messages) ? parsed.messages : [];
		const userAt = messages.map((message) => message?.role).lastIndexOf("user");
		const sinceUser = messages.slice(userAt + 1);
		const offeredTools = (parsed.tools ?? []).length > 0;
		if (offeredTools) toolResults = sinceUser.filter((message) => message?.role === "tool").map((message) => (typeof message.content === "string" ? message.content : message.content.map((part: any) => String(part?.text ?? "")).join("")));
		const done = sinceUser.filter((message) => message?.role === "assistant").length;
		const leg = offeredTools ? legs[done] : undefined;
		const base = { id: `cmpl_${done}`, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: MODEL.model };
		res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
		if (leg) {
			const tool_calls = (typeof leg === "function" ? leg(toolResults) : leg).map((call, index) => ({ index, id: `call_${done}_${index}`, type: "function", function: { name: call.name, arguments: JSON.stringify(call.args) } }));
			res.write(sse({ ...base, choices: [{ index: 0, delta: { role: "assistant", tool_calls }, finish_reason: null }] }));
			res.write(sse({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } }));
		} else {
			res.write(sse({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: "Done." }, finish_reason: null }] }));
			res.write(sse({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 150, completion_tokens: 4, total_tokens: 154 } }));
		}
		res.end("data: [DONE]\n\n");
	});
});
await new Promise<void>((resolve) => gateway.listen(0, "127.0.0.1", resolve));
const writeSetting = (file: string, value: unknown) => fs.writeFileSync(file, JSON.stringify(value, null, 2), { mode: 0o600 });
writeSetting(path.join(agentDir, "models.json"), { providers: { "openai-compatible": { name: "Synthetic Gateway", baseUrl: `http://127.0.0.1:${(gateway.address() as AddressInfo).port}/v1`, api: "openai-completions", models: [{ id: "room-model", name: "Room Model", contextWindow: 200000, maxTokens: 4096 }] } } });
writeSetting(path.join(agentDir, "auth.json"), { "openai-compatible": { type: "api_key", key: "synthetic-box-live-files" } });
writeSetting(path.join(appRoot, "openai-compatible-ai-profile.json"), { profileId: "openai-compatible", providerId: "openai-compatible", label: "Synthetic Gateway", roomModels: [{ modelId: "room-model", label: "Room Model" }], maintenanceModel: "room-model" });
writeSetting(path.join(appRoot, "persistent-agent-ai-profile.json"), { profileId: "openai-compatible" });

// --- The server, in this process, on a throwaway home. The record of a boxed command lives in this home too.
const port = await freePort();
for (const name of ["EXXPERTS_DATA_DIR", "EXXPERTS_STATE_HOME", "EXXPERTS_REAL_HOME", "EXXPERTS_TEST_SHELL_PLATFORM"]) delete process.env[name];
Object.assign(process.env, SMOKE_SERVER_AUTH_ENV, {
	HOME: home,
	USERPROFILE: home,
	PORT: String(port),
	EXXETA_HOME: repoRoot,
	EXXPERTS_CODING_AGENT_DIR: agentDir,
	EXXETA_PERSISTENT_AGENTS_ROOT: agentsRoot,
	EXXPERTS_REMOTE_TEST_ADDRESS: "::1",
	EXXPERTS_TEST_INTROSPECTION: "1",
	LOG_LEVEL: process.env.LOG_LEVEL ?? "warn",
});
const { boxedCommandSinceStart, FILES_STOPPED_LINE } = await import("../src/room-box/box-files.js");
const { BoxProcess } = await import("../src/room-box/box-process.js");
const { RoomBox } = await import("../src/room-box/box-session.js");
const { DefaultResourceLoader } = await import("@exxeta/exxperts-runtime");
const { fileProgramPidsIn } = await import("./smoke-file-programs.js");
await import("../src/index.js");
await waitUntil(() => fetch(`http://127.0.0.1:${port}/healthz`).then((response) => response.ok, () => false), "the server is up", 60_000);

// --- What the box does, watched where the server calls it.
type BoxInstance = InstanceType<typeof RoomBox>;
const fileCalls: { box: BoxInstance; whole: boolean }[] = [];
let swapBeforeOpen: (() => void) | null = null;
const runFileProgram = RoomBox.prototype.runFileProgram;
RoomBox.prototype.runFileProgram = function (this: BoxInstance, ...args) {
	fileCalls.push({ box: this, whole: args[0].whole === true });
	const swap = swapBeforeOpen;
	swapBeforeOpen = null;
	swap?.();
	return runFileProgram.apply(this, args);
};
const boxes: Awaited<ReturnType<typeof BoxProcess.start>>[] = [];
let boxStarts: "start" | "fail" = "start";
const startBox = BoxProcess.start;
BoxProcess.start = (async (...args: Parameters<typeof BoxProcess.start>) => {
	if (boxStarts === "fail") throw new Error("no worker");
	const process = await startBox(...args);
	boxes.push(process);
	return process;
}) as typeof BoxProcess.start;
let binds = 0;
const reload = DefaultResourceLoader.prototype.reload;
DefaultResourceLoader.prototype.reload = async function (this: InstanceType<typeof DefaultResourceLoader>, ...args: Parameters<typeof reload>) {
	binds += 1;
	return reload.apply(this, args);
};

/** This smoke's file programs still alive. */
const programsAlive = (): number => fileProgramPidsIn(folder).length;

// --- The room: its folder with Full access and commands on Semi, so a command needs no card.
async function json(pathname: string, init: AuthedFetchInit = {}): Promise<{ status: number; body: any }> {
	const response = await authedFetch(`http://127.0.0.1:${port}${pathname}`, { ...init, headers: { ...(init.body ? { "content-type": "application/json" } : {}), ...init.headers } });
	const text = await response.text();
	return { status: response.status, body: text ? JSON.parse(text) : null };
}
const created = await json("/api/persistent-agents", { method: "POST", body: JSON.stringify({ displayName: "Sales Review", userName: "Synthetic User", preferredUserAddress: "Synthetic User" }) });
const room = String(created.body?.agent?.id ?? "");
assert(created.status === 201 && room, `the room was made, got ${created.status}`);
const setFolder = async (bashEnabled: boolean) => {
	const saved = await json(`/api/persistent-agents/${encodeURIComponent(room)}/workspace-default`, { method: "PUT", body: JSON.stringify({ root: folder, displayLabel: "Sales", workspaceAccessMode: "localFiles", bashEnabled }) });
	assert(saved.status === 200, `the room's folder was set, got ${saved.status}: ${JSON.stringify(saved.body)}`);
};
await setFolder(true);
assert((await putRunWithoutAsking(`http://127.0.0.1:${port}/api/persistent-agents/${encodeURIComponent(room)}/bash-settings`, true)).status === 200, "commands are on Semi");
fs.writeFileSync(inRoom("notes.txt"), "line one\nneedle here\n");

const WebSocketImpl: any = (await import("ws")).default;
let conversations = 0;
// A new room has no active thread to settle, so the wait starts after its first turn.
let turnBefore = false;
async function openWindow(deviceCookie?: string) {
	if (turnBefore) await waitForTurnSettled(json, room, "the turn before has settled");
	const conversation = `conversation-${++conversations}`;
	const seeded = await json(`/api/persistent-agents/${encodeURIComponent(room)}/threads/${conversation}`, { method: "PUT", body: JSON.stringify({ state: "active", origin: "launcher", model: MODEL, items: [] }) });
	assert(seeded.status === 200, `${conversation} was seeded, got ${seeded.status}: ${JSON.stringify(seeded.body)}`);
	const query = `persistentAgentId=${room}&conversationId=${conversation}&modelProvider=${MODEL.provider}&model=${MODEL.model}&reattach=1`;
	const ws = deviceCookie
		? new WebSocketImpl(`ws://[::1]:${port}/ws?${query}`, { headers: { Origin: `http://[::1]:${port}`, Cookie: deviceCookie } })
		: new WebSocketImpl(`ws://127.0.0.1:${port}/ws?${query}`, { headers: { ...SMOKE_AUTH_HEADERS } });
	const frames: any[] = [];
	ws.addEventListener("message", (event: any) => { try { frames.push(JSON.parse(String(event.data))); } catch {} });
	await new Promise<void>((resolve, reject) => { ws.addEventListener("open", () => resolve()); ws.addEventListener("error", () => reject(new Error("websocket failed to connect"))); });
	const seen = (match: (frame: any) => boolean, label: string) => waitUntil(() => frames.some(match), `${label}; frames ${frames.map((frame) => frame.type).join(",")}`);
	await seen((frame) => frame.type === "ready", `${conversation} is ready`);
	const ends = () => frames.filter((frame) => frame.type === "event" && frame.event?.type === "agent_end").length;
	return {
		ws,
		/** Sends a message whose turn makes these calls, one leg each, without waiting. */
		send(calls: Leg[]): () => Promise<string[]> {
			const before = ends();
			turnBefore = true;
			legs = calls;
			toolResults = [];
			ws.send(JSON.stringify({ type: "prompt", text: "Work in the folder." }));
			return async () => {
				await seen(() => ends() > before, "the turn ended");
				return toolResults;
			};
		},
		/** A whole turn: what each call gave the model back, in order. */
		turn(calls: Leg[]): Promise<string[]> {
			return this.send(calls)();
		},
		stop: () => ws.send(JSON.stringify({ type: "abort", shown: 0 })),
		close: () => ws.close(),
	};
}
const read = (file: string): Call => ({ name: "read", args: { path: file } });
const write = (file: string, content: string): Call => ({ name: "write", args: { path: file, content } });

let passed = 0;
const failures: string[] = [];
let rowAt = 0;
async function row(name: string, body: () => Promise<void>): Promise<void> {
	assert(ROWS[rowAt++] === name, `rows run in the order ROWS lists them: ${name}`);
	try {
		await body();
		passed += 1;
		console.log(`  ok   ${name}`);
	} catch (error) {
		failures.push(name);
		console.log(`  FAIL ${name}: ${(error as Error).message}`);
	}
}

console.log("room box live files smoke");
try {
	await row(ROWS[0], async () => {
		const window = await openWindow();
		const calls = fileCalls.length;
		const [got, wrote] = await window.turn([[read("notes.txt")], [write("from-live.txt", "written live")]]);
		assert(got?.includes("needle here"), `the read: ${got}`);
		assert(!wrote?.toLowerCase().includes("error") && fs.readFileSync(inRoom("from-live.txt"), "utf8") === "written live", `the write: ${wrote}`);
		const made = fileCalls.slice(calls);
		assert(made.some((call) => !call.whole) && made.some((call) => call.whole), `the read and the write each ran a program in the box, got ${JSON.stringify(made.map((call) => call.whole))}`);
		window.close();
	});

	await row(ROWS[1], async () => {
		fs.writeFileSync(path.join(elsewhere, "private.txt"), "outside the fence");
		const swap = () => {
			fs.rmSync(inRoom("sub"), { recursive: true, force: true });
			fs.symlinkSync(elsewhere, inRoom("sub"));
		};
		const fresh = () => {
			fs.rmSync(inRoom("sub"), { recursive: true, force: true });
			fs.mkdirSync(inRoom("sub"));
			fs.writeFileSync(inRoom("sub", "private.txt"), "inside");
		};
		const window = await openWindow();
		fresh();
		swapBeforeOpen = swap;
		const [got] = await window.turn([[read("sub/private.txt")]]);
		assert(swapBeforeOpen === null && fs.lstatSync(inRoom("sub")).isSymbolicLink(), "the swap happened between check and open");
		assert(got !== undefined && !got.includes("outside the fence") && !got.includes("inside"), `the read: ${got}`);
		fresh();
		swapBeforeOpen = swap;
		const [wrote] = await window.turn([[write("sub/planted.txt", "planted")]]);
		assert(swapBeforeOpen === null, "the swap happened between check and open");
		assert(!fs.existsSync(path.join(elsewhere, "planted.txt")) && !fs.existsSync(path.join(fs.realpathSync(inRoom("sub")), "planted.txt")), `the write landed: ${wrote}`);
		fs.rmSync(inRoom("sub"), { force: true });
		window.close();
	});

	await row(ROWS[2], async () => {
		assert(!boxedCommandSinceStart(), "no command has run yet");
		const window = await openWindow();
		const calls = fileCalls.length;
		boxStarts = "fail";
		try {
			const [got, wrote] = await window.turn([[read("notes.txt")], [write("fenced.txt", "behind the fence")]]);
			assert(got?.includes("needle here"), `the read: ${got}`);
			assert(fs.readFileSync(inRoom("fenced.txt"), "utf8") === "behind the fence", `the write: ${wrote}`);
			assert(fileCalls.length > calls, "the calls tried the box first");
			assert(!boxedCommandSinceStart(), "a box that failed counted as a command");
		} finally {
			boxStarts = "start";
			window.close();
		}
	});

	await row(ROWS[3], async () => {
		const window = await openWindow();
		const calls = fileCalls.length;
		await window.turn([[read("notes.txt")]]);
		const first = fileCalls.at(-1)?.box;
		assert(first && fileCalls.length > calls, "the first turn read in a box");
		const bindsBefore = binds;
		await waitForTurnSettled(json, room, "the first turn has settled");
		await setFolder(false);
		const [got] = await window.turn([[read("notes.txt")]]);
		assert(binds > bindsBefore, "the changed folder setting rebound the session");
		assert(got?.includes("needle here"), `the read after the rebind: ${got}`);
		assert(fileCalls.at(-1)?.box === first, "the read after the rebind ran in another box");
		await waitForTurnSettled(json, room, "the second turn has settled");
		await setFolder(true);
		window.close();
	});

	await row(ROWS[4], async () => {
		assert((await json("/api/remote/enable", { method: "POST" })).status === 200, "remote access is on");
		const phone = await pairDevice(port, "Box phone", "full");
		assert((await json("/api/remote/rooms/exposure", { method: "POST", body: JSON.stringify({ id: room, exposed: true }) })).status === 200, "the room is on the phones");
		const window = await openWindow(phone.cookie);
		const calls = fileCalls.length;
		const [got] = await window.turn([[read("notes.txt")], [write("from-phone.txt", "written on a phone")]]);
		assert(got?.includes("needle here"), `the read: ${got}`);
		assert(fs.readFileSync(inRoom("from-phone.txt"), "utf8") === "written on a phone", "the write");
		const made = fileCalls.slice(calls);
		assert(made.length >= 2 && made.every((call) => call.box === made[0].box), `the phone's read and write ran in one box, got ${made.length} calls`);
		window.close();
	});

	await row(ROWS[5], async () => {
		fs.writeFileSync(inRoom("slow.txt"), `${"a".repeat(40)}!\n`.repeat(50));
		const window = await openWindow();
		const ended = window.send([[{ name: "grep", args: { pattern: "(a+)+$" } }]]);
		await waitUntil(() => programsAlive() > 0, "the search's program runs");
		const stoppedAt = Date.now();
		window.stop();
		await ended();
		assert(Date.now() - stoppedAt < 5_000, `Stop took ${Date.now() - stoppedAt} ms`);
		await waitUntil(() => programsAlive() === 0, "no program outlives its Stop", 5_000);
		await waitForTurnSettled(json, room, "the stopped turn has settled");
		const [timed] = await window.turn([[{ name: "grep", args: { pattern: "(a+)+$" } }]]);
		assert(timed?.includes("Search stopped after"), `the deadline: ${timed}`);
		assert(programsAlive() === 0, "a program outlived its deadline");
		fs.rmSync(inRoom("slow.txt"));
		window.close();
	});

	await row(ROWS[6], async () => {
		const window = await openWindow();
		const started = boxes.length;
		await window.turn([[read("notes.txt")], [{ name: "ls", args: {} }]]);
		const turnBoxes = boxes.slice(started);
		assert(turnBoxes.length > 0, "the turn started a box");
		await waitForTurnSettled(json, room, "the turn has settled");
		await waitUntil(() => turnBoxes.every((process) => !process.alive), "the turn's box is gone", 10_000);
		assert(programsAlive() === 0, "a file program outlived its turn");
		window.close();
	});

	await row(ROWS[7], async () => {
		process.env.EXXPERTS_TEST_SHELL_PLATFORM = "linux";
		try {
			const window = await openWindow();
			const calls = fileCalls.length;
			const [got, wrote] = await window.turn([[read("notes.txt")], [write("no-box.txt", "no box here")]]);
			assert(got?.includes("needle here"), `the read: ${got}`);
			assert(fs.readFileSync(inRoom("no-box.txt"), "utf8") === "no box here", `the write: ${wrote}`);
			assert(fileCalls.length === calls, "a file call ran a program in a box");
			window.close();
		} finally {
			delete process.env.EXXPERTS_TEST_SHELL_PLATFORM;
		}
	});

	await row(ROWS[8], async () => {
		const window = await openWindow();
		const spillOf = (text: string | undefined) => /Full output: (\S+?)\]/.exec(text ?? "")?.[1];
		const [long, got] = await window.turn([[{ name: "bash", args: { command: "seq 1 5000" } }], (results) => [read(spillOf(results[0]) ?? "no-spill")]]);
		assert(spillOf(long) && !long.includes("the read tool can't open it"), `the command's long output: ${JSON.stringify(long?.slice(-400))}`);
		// The command's result shows the end; the read opens the whole file from its first line.
		assert(got?.startsWith("1\n2\n3\n") && !long.includes("\n3\n"), `the read of ${spillOf(long)}: ${JSON.stringify(got?.slice(0, 100))}`);
		window.close();
	});

	await row(ROWS[9], async () => {
		const window = await openWindow();
		const [ran] = await window.turn([[{ name: "bash", args: { command: "true" } }]]);
		assert(boxedCommandSinceStart(), `the command left no record: ${ran}`);
		await waitForTurnSettled(json, room, "the command's turn has settled");
		boxStarts = "fail";
		try {
			const results = await window.turn([[read("notes.txt")], [write("after.txt", "x")], [{ name: "ls", args: {} }]]);
			assert(results.length === 3 && results.every((result) => result.includes(FILES_STOPPED_LINE)), `each call: ${JSON.stringify(results)}`);
			assert(!fs.existsSync(inRoom("after.txt")), "a write went on");
		} finally {
			boxStarts = "start";
			window.close();
		}
	});
} catch (error) {
	failures.push(`the smoke stopped: ${(error as Error).message}`);
	console.log(`  FAIL ${(error as Error).message}`);
}

gateway.close();
fs.rmSync(tempRoot, { recursive: true, force: true });
console.log(`room box live files smoke: ${passed} passed, ${failures.length} failed`);
process.exit(failures.length > 0 ? 1 : 0);
