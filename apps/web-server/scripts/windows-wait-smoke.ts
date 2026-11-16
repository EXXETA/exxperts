// The wait between the file tools and the Windows box's commands
// (room-box/windows/folder-wait.ts), on any computer. Rows: the registry's
// rules, with this computer's paths and with Windows' case rule; the engine
// holding a command's folders until its end, at Stop, at the time limit, when
// the box's process crashes and at the turn's end, with the worker run against
// the stand-in for Microsoft's kit (windows-box-stand-in.mjs); and the six real
// file tools, which wait only when given the wait. Posix links stand in for
// Windows' links: while a command holds the room's folder, a file call has not
// begun its fence check, so a link put there meanwhile is refused after the
// release, as the fence refuses one today.
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { createPersistentRoomDefaultCapabilityPolicy, persistentAgentRootPath, writePersistentRoomDefaultCapabilityPolicy } from "../src/persistent-room-workspace-policy.js";
import { createPersistentRoomWorkspaceTools, PersistentRoomWorkspaceToolError, CHANGE_STOPPED } from "../src/persistent-room-workspace-tools.js";
import { saveAlsoAllowedFolders } from "../src/room-box/also-allowed.js";
import { BoxFault } from "../src/room-box/box-process.js";
import { AnswerFolders } from "../src/room-box/folder-question.js";
import { BOX_ROOT_NAME } from "../src/room-box/windows/box-root.js";
import { atOrInside, FolderWait, folderWait, type Holder } from "../src/room-box/windows/folder-wait.js";
import { type Machine, runStartCheck } from "../src/room-box/windows/start-check.js";
import { WindowsRoomBox } from "../src/room-box/windows/windows-engine.js";
// @ts-expect-error: plain JavaScript, loaded as the kit in the worker and for its path helpers here.
import { requestPath } from "./windows-box-stand-in.mjs";

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

async function row(name: string, ...rest: [() => Promise<void> | void] | [{ skip: boolean }, () => Promise<void> | void]): Promise<void> {
	const [{ skip }, body] = rest.length === 1 ? [{ skip: false }, rest[0]] : rest;
	if (skip) {
		console.log(`skip: ${name}`);
		return;
	}
	try {
		await body();
		console.log(`ok: ${name}`);
	} catch (error) {
		console.error(`FAIL: ${name}\n${(error as Error).stack}`);
		process.exit(1);
	}
}

const show = (value: unknown) => JSON.stringify(value);
const home = fs.realpathSync(os.homedir());
// In the home: a room's folder in the shared temp is one no room may use.
const work = fs.realpathSync(fs.mkdtempSync(path.join(home, "windows-wait-")));
function folderAt(name: string): string {
	fs.mkdirSync(path.join(work, name), { recursive: true });
	return fs.realpathSync(path.join(work, name));
}

/** A promise and the hand that settles it. */
function gate() {
	let open!: () => void;
	const opened = new Promise<void>((resolve) => { open = resolve; });
	return { open, opened };
}

/** A hold whose work runs until `release`, with whether it has begun and how it settled. */
function held(wait: FolderWait, holder: Holder, folders: string[], signal?: AbortSignal) {
	const { open: release, opened } = gate();
	const state = { begun: false, release, settled: null as null | "done" | Error, done: Promise.resolve() };
	state.done = wait.hold(holder, folders, signal, async () => {
		state.begun = true;
		await opened;
	}).then(() => { state.settled = "done"; }, (error: Error) => { state.settled = error; });
	return state;
}

/** Lets every queued promise step run; nothing here waits on a timer or a disk. */
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

// ---- The registry -----------------------------------------------------------------------------------

const ROOM = "/rooms/a";
const OTHER = "/rooms/b";

await row("registry: a file call on a folder a command holds waits, at the folder and inside it; one on another folder runs at once", async () => {
	const wait = new FolderWait();
	const command = held(wait, "command", [ROOM]);
	const inside = held(wait, "file", [`${ROOM}/notes`]);
	const at = held(wait, "file", [ROOM]);
	const elsewhere = held(wait, "file", [OTHER]);
	// A sibling whose name starts the same is another folder.
	const sibling = held(wait, "file", [`${ROOM}-old`]);
	await settle();
	assert(command.begun && elsewhere.begun && sibling.begun, "a hold that overlaps nothing waited");
	assert(!inside.begun && !at.begun, "a file call ran while a command held its folder");
	command.release();
	await command.done;
	await settle();
	assert(inside.begun && at.begun, "the file calls did not start after the command's end");
	for (const each of [inside, at, elsewhere, sibling]) each.release();
	await Promise.all([inside.done, at.done, elsewhere.done, sibling.done]);
});

await row("registry: a command waits for a file call already running on a folder inside its own, and file calls share a folder", async () => {
	const wait = new FolderWait();
	const first = held(wait, "file", [`${ROOM}/notes/a.txt`]);
	const second = held(wait, "file", [`${ROOM}/notes/a.txt`]);
	const command = held(wait, "command", [ROOM, OTHER]);
	await settle();
	assert(first.begun && second.begun && !command.begun, show({ first: first.begun, second: second.begun, command: command.begun }));
	first.release();
	await first.done;
	await settle();
	assert(!command.begun, "the command ran while a file call still held its folder");
	second.release();
	await second.done;
	await settle();
	assert(command.begun, "the command did not start after the file calls");
	command.release();
	await command.done;
});

await row("registry: several commands share a folder, and a file call waits for every one of them", async () => {
	const wait = new FolderWait();
	const one = held(wait, "command", [ROOM]);
	const two = held(wait, "command", [`${ROOM}/sub`]);
	const file = held(wait, "file", [`${ROOM}/sub/x`]);
	await settle();
	assert(one.begun && two.begun && !file.begun, show({ one: one.begun, two: two.begun, file: file.begun }));
	one.release();
	await one.done;
	await settle();
	assert(!file.begun, "the file call ran while a second command still held its folder");
	two.release();
	await two.done;
	await settle();
	assert(file.begun, "the file call did not start after both commands");
	file.release();
	await file.done;
});

await row("registry: order is kept: a command that comes after a waiting file call waits behind it, and starts when it ends", async () => {
	const wait = new FolderWait();
	const running = held(wait, "command", [ROOM]);
	const file = held(wait, "file", [ROOM]);
	const later = held(wait, "command", [ROOM]);
	// A command that overlaps nothing waiting is not held back.
	const free = held(wait, "command", [OTHER]);
	await settle();
	assert(running.begun && !file.begun && !later.begun && free.begun, show({ file: file.begun, later: later.begun, free: free.begun }));
	running.release();
	await running.done;
	await settle();
	assert(file.begun && !later.begun, "the file call did not go first, or the later command ran beside it");
	file.release();
	await file.done;
	await settle();
	assert(later.begun, "the later command did not start after the file call");
	later.release();
	free.release();
	await Promise.all([later.done, free.done]);
});

await row("registry: Stop while waiting rejects with the caller's error and leaves nothing held; one waiting behind it then starts", async () => {
	const wait = new FolderWait();
	const running = held(wait, "command", [ROOM]);
	const stop = new AbortController();
	const file = held(wait, "file", [ROOM], stop.signal);
	const behind = held(wait, "command", [ROOM]);
	await settle();
	assert(!file.begun && !behind.begun, "nothing should start yet");
	stop.abort();
	await file.done;
	await settle();
	assert(file.settled instanceof Error && file.settled.message === "aborted" && !file.begun, show(String(file.settled)));
	assert(behind.begun, "the command behind a stopped wait stayed waiting");
	running.release();
	behind.release();
	await Promise.all([running.done, behind.done]);
	// Nothing is left: a file call on the same folder runs at once.
	const after = held(wait, "file", [ROOM]);
	await settle();
	assert(after.begun, "a stopped wait left a hold behind");
	after.release();
	await after.done;
	const stopped = new AbortController();
	stopped.abort();
	const never = held(wait, "file", [ROOM], stopped.signal);
	await never.done;
	assert(never.settled instanceof Error && !never.begun, "a call stopped before it asked ran");
});

await row("registry: a hold whose work throws is released", async () => {
	const wait = new FolderWait();
	const thrown = await wait.hold("command", [ROOM], undefined, async () => { throw new Error("the box failed"); }).catch((error: Error) => error);
	assert(thrown instanceof Error && thrown.message === "the box failed", show(String(thrown)));
	const file = held(wait, "file", [ROOM]);
	await settle();
	assert(file.begun, "a hold stayed after its work threw");
	file.release();
	await file.done;
});

await row("registry: with Windows' rule for names, folders that differ only in case overlap, and other folders don't", async () => {
	const wait = new FolderWait(atOrInside(path.win32));
	const command = held(wait, "command", [String.raw`C:\Users\Ana\Room`]);
	const cased = held(wait, "file", [String.raw`c:\users\ana\ROOM\Notes`]);
	const other = held(wait, "file", [String.raw`C:\Users\Ana\Room2`]);
	const drive = held(wait, "file", [String.raw`D:\Users\Ana\Room`]);
	await settle();
	assert(!cased.begun && other.begun && drive.begun, show({ cased: cased.begun, other: other.begun, drive: drive.begun }));
	command.release();
	await command.done;
	await settle();
	assert(cased.begun, "the file call did not start after the command");
	for (const each of [cased, other, drive]) each.release();
	await Promise.all([cased.done, other.done, drive.done]);
});

await row("registry: a folder whose name only starts with two dots is inside, and the folder above is not", async () => {
	const wait = new FolderWait();
	const command = held(wait, "command", [ROOM]);
	const dots = held(wait, "file", [`${ROOM}/..notes`]);
	const above = held(wait, "file", [`${ROOM}/../c`]);
	await settle();
	assert(!dots.begun && above.begun, show({ dots: dots.begun, above: above.begun }));
	command.release();
	await command.done;
	await settle();
	assert(dots.begun, "the file call did not start after the command");
	dots.release();
	above.release();
	await Promise.all([dots.done, above.done]);
});

// ---- The engine, with the stand-in for the kit --------------------------------------------------

const require = createRequire(import.meta.url);
const TSX = pathToFileURL(require.resolve("tsx/esm")).href;
const STAND_IN = pathToFileURL(path.join(import.meta.dirname, "windows-box-stand-in.mjs")).href;
const WORKER_FILE = path.join(import.meta.dirname, "../src/room-box/windows/box-worker-windows.ts");
const configFile = path.join(work, "stand-in.json");
const log = path.join(work, "stand-in.jsonl");
const configure = (more: Record<string, string> = {}) => fs.writeFileSync(configFile, JSON.stringify({ log, ...more }));
configure();
const kills = () => (fs.existsSync(log) ? fs.readFileSync(log, "utf8").split("\n").filter((line) => line.includes("\"kill\"")).length : 0);
const worker = { file: WORKER_FILE, execArgv: ["--import", TSX, "--import", `${STAND_IN}?config=${encodeURIComponent(configFile)}&register`] };
const MACHINE: Machine = {
	revision: 9711,
	profile: String.raw`C:\Users\Ana`,
	personal: [],
	environment: { SystemRoot: String.raw`C:\Windows`, USERPROFILE: String.raw`C:\Users\Ana`, PATH: String.raw`C:\Windows\System32` },
	pathFolders: [String.raw`C:\Windows\System32`],
	programs: { folder: String.raw`C:\Users\Ana\AppData\Local\Programs`, names: [] },
};
const answer = await runStartCheck({ system: { platform: "win32", arch: "x64", release: "10.0.26200", product: "Windows 11 Pro" }, readMachine: async () => MACHINE, worker, root: path.join(work, BOX_ROOT_NAME), requestPath });
assert(answer.state === "on", show(answer));

const engineRoom = folderAt("engine-room");
const engineData = folderAt("engine-room-data");
const engine = () => new WindowsRoomBox({ roomId: "windows-wait-smoke", conversationId: () => "c", rights: () => ({ canChangeFiles: true, skillFolders: [] }), warn: () => {}, folders: () => ({ folder: engineRoom, alsoAllowed: [] }), roomData: engineData, startAnswer: async () => answer });

/** Starts a command and resolves `running` at its first output; `result` is what the tool would get. */
function command(box: WindowsRoomBox, text: string, options: { timeout?: number; signal?: AbortSignal } = {}) {
	const { open, opened } = gate();
	const result = box.operations().exec(text, engineRoom, { onData: () => open(), timeout: options.timeout, signal: options.signal }).then(({ exitCode }) => ({ exitCode, error: null as Error | null }), (error: Error) => ({ exitCode: null, error }));
	return { running: opened, result };
}

// The first command of the process runs the box's proof, which holds nothing: a plain command first.
await row("engine: a command that ends on its own holds its folder only while it runs", async () => {
	const box = engine();
	const ran = command(box, "Write-Output started\nStart-Sleep -Milliseconds 300\nWrite-Output done");
	await ran.running;
	const file = held(folderWait, "file", [path.join(engineRoom, "a.txt")]);
	const elsewhere = held(folderWait, "file", [engineData]);
	await settle();
	assert(!file.begun && elsewhere.begun, show({ file: file.begun, elsewhere: elsewhere.begun }));
	const result = await ran.result;
	assert(result.exitCode === 0, show(result));
	await settle();
	assert(file.begun, "the file call did not start after the command's end");
	file.release();
	elsewhere.release();
	await Promise.all([file.done, elsewhere.done]);
	await box.endTurn();
});

await row("engine: Stop and the time limit end the hold only once the command has ended", async () => {
	const box = engine();
	const stop = new AbortController();
	const stopped = command(box, "Write-Output started\nStart-Sleep -Seconds 60\nWrite-Output late", { signal: stop.signal });
	await stopped.running;
	const file = held(folderWait, "file", [engineRoom]);
	await settle();
	assert(!file.begun, "a file call ran beside a running command");
	const killsBefore = kills();
	stop.abort();
	const result = await stopped.result;
	await settle();
	assert(result.error?.message === "aborted" && kills() === killsBefore + 1, show({ result: String(result.error), kills: kills() - killsBefore }));
	assert(file.begun, "the file call did not start after Stop");
	file.release();
	await file.done;
	const timed = command(box, "Write-Output started\nStart-Sleep -Seconds 60", { timeout: 1 });
	await timed.running;
	const after = held(folderWait, "file", [engineRoom]);
	await settle();
	assert(!after.begun, "a file call ran beside a command inside its limit");
	const limit = await timed.result;
	await settle();
	assert(limit.error?.message === "timeout:1" && after.begun, show({ result: String(limit.error), begun: after.begun }));
	after.release();
	await after.done;
	await box.endTurn();
});

await row("engine: the turn's end while a command runs: the box's process tells the command's end before it goes, and the hold ends then", async () => {
	const box = engine();
	const ran = command(box, "Write-Output started\nStart-Sleep -Seconds 60");
	await ran.running;
	const file = held(folderWait, "file", [engineRoom]);
	await settle();
	assert(!file.begun, "a file call ran beside a running command");
	await box.endTurn();
	const result = await ran.result;
	await settle();
	// Not "the box's process ended": the command's own end came back first.
	assert(result.error === null && result.exitCode === 1, show({ exitCode: result.exitCode, error: String(result.error) }));
	assert(file.begun, "the file call did not start after the turn's end");
	file.release();
	await file.done;
});

await row("engine: a crash of the box's process ends the command with the box's fault and leaves nothing held", async () => {
	const box = engine();
	configure({ crash: "run" });
	const result = await command(box, "Write-Output never").result;
	configure();
	assert(result.error instanceof BoxFault, show(String(result.error)));
	const file = held(folderWait, "file", [engineRoom]);
	await settle();
	assert(file.begun, "a crashed command's hold stayed");
	file.release();
	await file.done;
	await box.endTurn();
});

const spawns = () => (fs.existsSync(log) ? fs.readFileSync(log, "utf8").split("\n").filter((line) => line.includes("\"spawn\"")).length : 0);

/** Resolves once something has the pipe open to read: a write that doesn't wait opens only then. */
async function readerOn(fifo: string): Promise<number> {
	for (;;) {
		try {
			return fs.openSync(fifo, fs.constants.O_WRONLY | fs.constants.O_NONBLOCK);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENXIO") throw error;
			await new Promise((resolve) => setTimeout(resolve, 20));
		}
	}
}

// The stand-in ends a command at once on Stop. A read of a named pipe holds the box's process until the pipe is written, so the command's end comes only then.
await row("engine: after Stop the hold lasts until the box's process tells the command's end", { skip: process.platform === "win32" }, async () => {
	const box = engine();
	assert((await command(box, "Write-Output warm").result).exitCode === 0, "the first command");
	const fifo = path.join(engineRoom, "pipe");
	execFileSync("mkfifo", [fifo]);
	const stop = new AbortController();
	const ran = command(box, "Get-Content -LiteralPath pipe", { signal: stop.signal });
	const writer = await readerOn(fifo);
	const file = held(folderWait, "file", [engineRoom]);
	await settle();
	stop.abort();
	await settle();
	assert(!file.begun, "the hold ended at Stop, before the command's end");
	fs.writeSync(writer, "x");
	fs.closeSync(writer);
	const result = await ran.result;
	await settle();
	assert(result.error?.message === "aborted" && file.begun, show({ result: String(result.error), begun: file.begun }));
	file.release();
	await file.done;
	fs.rmSync(fifo);
	await box.endTurn();
});

await row("engine: a command still waiting when its turn ends stops waiting then and never runs, so a later file call doesn't wait behind it", async () => {
	const box = engine();
	assert((await command(box, "Write-Output warm").result).exitCode === 0, "the first command");
	const ahead = held(folderWait, "file", [engineRoom]);
	await settle();
	const spawned = spawns();
	const waiting = command(box, "Write-Output never");
	await settle();
	await box.endTurn();
	// Bounded: a command that went on waiting would hold this row until the call ahead ends, which it never does here.
	const result = await Promise.race([waiting.result, new Promise<{ exitCode: null; error: Error }>((resolve) => setTimeout(() => resolve({ exitCode: null, error: new Error("still waiting") }), 5_000))]);
	assert(result.error?.message === "aborted" && spawns() === spawned, show({ result: String(result.error), spawns: spawns() - spawned }));
	const later = held(folderWait, "file", [engineRoom]);
	await settle();
	assert(ahead.begun && later.begun, `the later file call stayed behind a command whose turn had ended: ${show({ ahead: ahead.begun, later: later.begun })}`);
	ahead.release();
	later.release();
	await Promise.all([ahead.done, later.done]);
});

// ---- The six file tools -------------------------------------------------------------------------

const repoRoot = path.resolve(import.meta.dirname, "..", "..", "..");
function room(roomId: string, folder: string) {
	fs.mkdirSync(persistentAgentRootPath(roomId), { recursive: true });
	const policy = createPersistentRoomDefaultCapabilityPolicy({ agentId: roomId, repoRoot, root: folder, workspaceAccessMode: "localFiles", displayLabel: "Room Folder", source: "manual" });
	writePersistentRoomDefaultCapabilityPolicy(policy);
	return policy;
}

/** A wait that notes when a file call's own work begins: its fence check and open come only after. */
class Noting extends FolderWait {
	begun = 0;
	private fileAskedNow = () => {};
	/** Settles when a file call asks to hold, before its work may begin. */
	readonly fileAsked = new Promise<void>((resolve) => { this.fileAskedNow = resolve; });
	override hold<T>(holder: Holder, folders: readonly string[], signal: AbortSignal | undefined, work: () => Promise<T>, stopped?: () => Error): Promise<T> {
		if (holder === "file") this.fileAskedNow();
		return super.hold(holder, folders, signal, () => {
			this.begun += 1;
			return work();
		}, stopped);
	}
}

const filesRoom = folderAt("files-room");
fs.mkdirSync(path.join(filesRoom, "sub"));
fs.writeFileSync(path.join(filesRoom, "sub", "note.txt"), "INSIDE\n");
fs.writeFileSync(path.join(filesRoom, "edit.txt"), "before\n");
const outside = folderAt("outside");
fs.writeFileSync(path.join(outside, "note.txt"), "OUTSIDE\n");
const filesPolicy = room("windows-wait-files", filesRoom);

type Tool = { name: string; execute: (id: string, params: unknown, signal?: AbortSignal) => Promise<{ content: { type: string; text?: string }[] }> };
const toolsOf = (options: Parameters<typeof createPersistentRoomWorkspaceTools>[1]) => new Map((createPersistentRoomWorkspaceTools(filesPolicy, options) as unknown as Tool[]).map((tool) => [tool.name, tool]));
const text = (result: { content: { type: string; text?: string }[] }) => result.content.map((part) => part.text ?? "").join("\n");
const CALLS: [string, Record<string, unknown>][] = [
	["ls", { path: "sub" }],
	["find", { pattern: "*.txt" }],
	["grep", { pattern: "INSIDE" }],
	["read", { path: "sub/note.txt" }],
	["write", { path: "written.txt", content: "new\n" }],
	["edit", { path: "edit.txt", edits: [{ oldText: "before", newText: "after" }] }],
];

await row("tools: each of the six waits while a command holds the room's folder, and runs after it ends", async () => {
	const wait = new Noting();
	const tools = toolsOf({ folderWait: wait });
	assert(CALLS.every(([name]) => tools.has(name)), `tools: ${[...tools.keys()]}`);
	const hold = held(wait, "command", [filesRoom]);
	await settle();
	const calls = CALLS.map(([name, params]) => tools.get(name)!.execute(`wait-${name}`, params));
	await settle();
	assert(wait.begun === 1, `${wait.begun - 1} file calls began while a command held the room's folder`);
	hold.release();
	const results = await Promise.all(calls);
	assert(wait.begun === 1 + CALLS.length, `${wait.begun} holds began`);
	const [ls, find, grep, read, write, edit] = results.map(text);
	assert(ls.includes("note.txt") && find.includes("edit.txt") && grep.includes("INSIDE") && read.includes("INSIDE"), show({ ls, find, grep, read }));
	assert(write.includes("written.txt") && edit.includes("edit.txt"), show({ write, edit }));
	assert(fs.readFileSync(path.join(filesRoom, "edit.txt"), "utf8") === "after\n", "the edit did not land");
	await hold.done;
});

await row("tools: without the wait they run while a command holds the room's folder; with it, a command on another folder holds nothing back", async () => {
	const wait = new Noting();
	const hold = held(wait, "command", [filesRoom]);
	await settle();
	const plain = toolsOf(undefined);
	assert(text(await plain.get("read")!.execute("plain", { path: "sub/note.txt" })).includes("INSIDE"), "the read without the wait");
	hold.release();
	await hold.done;
	const elsewhere = held(wait, "command", [outside]);
	await settle();
	const read = await toolsOf({ folderWait: wait }).get("read")!.execute("elsewhere", { path: "sub/note.txt" });
	assert(text(read).includes("INSIDE"), "a read waited for a command on a folder the room can't open");
	elsewhere.release();
	await elsewhere.done;
});

await row("tools: the room's Also allowed and this-time folders are held too", async () => {
	const listed = folderAt("listed");
	const thisTime = folderAt("this-time");
	saveAlsoAllowedFolders(filesPolicy.agentId, [{ path: listed, access: "read" }]);
	const given = new AnswerFolders();
	given.give(thisTime, "write");
	try {
		for (const folder of [listed, thisTime]) {
			const wait = new Noting();
			const hold = held(wait, "command", [folder]);
			await settle();
			let ended = false;
			const call = toolsOf({ folderWait: wait, answer: () => given }).get("ls")!.execute("listed", { path: "." }).finally(() => { ended = true; });
			// The call asks to hold, or ends without asking, which the next line refuses.
			await Promise.race([wait.fileAsked, call.then(() => {}, () => {})]);
			await settle();
			assert(wait.begun === 1 && !ended, `a file call ran while a command held ${path.basename(folder)}`);
			hold.release();
			await call;
			assert((wait.begun as number) === 2, `the file call didn't wait for ${path.basename(folder)}: ${wait.begun - 1} holds began`);
			await hold.done;
		}
	} finally {
		given.end();
		saveAlsoAllowedFolders(filesPolicy.agentId, []);
	}
});

await row("tools: Stop while a call waits ends it with the stopped line, and nothing of it runs", async () => {
	const wait = new Noting();
	const hold = held(wait, "command", [filesRoom]);
	await settle();
	const stop = new AbortController();
	const call = toolsOf({ folderWait: wait }).get("write")!.execute("stopped", { path: "never.txt", content: "x" }, stop.signal).then(() => null, (error: Error) => error);
	await settle();
	stop.abort();
	// It ends while the command still holds the folder: the wait's own Stop, not the write's after a release.
	const error = await Promise.race([call, new Promise<"still waiting">((resolve) => setTimeout(() => resolve("still waiting"), 2_000))]);
	assert(error instanceof PersistentRoomWorkspaceToolError && error.code === "aborted" && error.message === CHANGE_STOPPED, show(String(error)));
	assert(wait.begun === 1 && !fs.existsSync(path.join(filesRoom, "never.txt")), "a stopped call ran");
	hold.release();
	await hold.done;
});

await row("tools: a link put in the room's folder while a command holds it is seen by the fence after the release, and refused", async () => {
	const wait = new Noting();
	const tools = toolsOf({ folderWait: wait });
	// The allowed neighbour first: the same read through the real folder.
	assert(text(await tools.get("read")!.execute("before", { path: "sub/note.txt" })).includes("INSIDE"), "the read before the link");
	const hold = held(wait, "command", [filesRoom]);
	await settle();
	const begunBefore = wait.begun;
	const call = tools.get("read")!.execute("through", { path: "sub/note.txt" }).then((result) => text(result), (error: Error) => error);
	await settle();
	assert(wait.begun === begunBefore, "the read began its check while a command held the room's folder");
	// What a command could do while it runs: the folder swapped for a link to a place outside.
	fs.renameSync(path.join(filesRoom, "sub"), path.join(filesRoom, "sub-was"));
	fs.symlinkSync(outside, path.join(filesRoom, "sub"));
	hold.release();
	const result = await call;
	assert(result instanceof PersistentRoomWorkspaceToolError && result.code === "link", show(String(result)));
	await hold.done;
	fs.unlinkSync(path.join(filesRoom, "sub"));
	fs.renameSync(path.join(filesRoom, "sub-was"), path.join(filesRoom, "sub"));
});

/** Notes every path given to the server's synchronous disk calls, while on. */
const diskCalls: string[] = [];
let noting = false;
for (const name of ["statSync", "lstatSync", "existsSync", "readdirSync", "readFileSync", "openSync", "accessSync"] as const) {
	const real = fs[name] as (...args: unknown[]) => unknown;
	(fs as unknown as Record<string, unknown>)[name] = (...args: unknown[]) => {
		if (noting) diskCalls.push(String(args[0]));
		return real(...args);
	};
}
const realpath = fs.realpathSync;
const realpathNative = fs.realpathSync.native;
fs.realpathSync = Object.assign((...args: Parameters<typeof realpath>) => {
	if (noting) diskCalls.push(String(args[0]));
	return realpath(...args);
}, { native: (...args: Parameters<typeof realpathNative>) => {
	if (noting) diskCalls.push(String(args[0]));
	return realpathNative(...args);
} }) as typeof fs.realpathSync;
const callsInside = (folder: string) => diskCalls.filter((called) => atOrInside(path)(called, folder));

await row("tools: a room inside a folder a command holds touches nothing on disk there until the release", async () => {
	const parent = folderAt("parent-room");
	const nested = path.join(parent, "nested");
	fs.mkdirSync(nested);
	fs.writeFileSync(path.join(nested, "a.txt"), "NESTED\n");
	const policy = room("windows-wait-nested", fs.realpathSync(nested));
	const wait = new Noting();
	const hold = held(wait, "command", [parent]);
	await settle();
	diskCalls.length = 0;
	noting = true;
	const call = (createPersistentRoomWorkspaceTools(policy, { folderWait: wait }) as unknown as Tool[]).find((tool) => tool.name === "read")!.execute("nested", { path: "a.txt" });
	await settle();
	noting = false;
	assert(callsInside(parent).length === 0, `disk calls inside the held folder: ${show(callsInside(parent))}`);
	hold.release();
	assert(text(await call).includes("NESTED"), "the read after the release");
	await hold.done;
});

await row("tools: a folder given to the room while a call waits is waited for too", async () => {
	const given = folderAt("given-later");
	fs.writeFileSync(path.join(given, "g.txt"), "GIVEN\n");
	const wait = new Noting();
	const first = held(wait, "command", [filesRoom]);
	await settle();
	const call = toolsOf({ folderWait: wait }).get("read")!.execute("given", { path: path.join(given, "g.txt") });
	let settled = false;
	void call.then(() => { settled = true; }, () => { settled = true; });
	await settle();
	saveAlsoAllowedFolders(filesPolicy.agentId, [{ path: given, access: "read" }]);
	try {
		// Another room's command on the folder just given: it overlaps nothing that was waiting.
		const second = held(wait, "command", [given]);
		await settle();
		assert(second.begun, "the command on the given folder should start");
		diskCalls.length = 0;
		noting = true;
		first.release();
		await first.done;
		await settle();
		noting = false;
		assert(!settled && callsInside(given).length === 0, `the read went into the given folder while a command held it: ${show(callsInside(given))}`);
		second.release();
		await second.done;
		assert(text(await call).includes("GIVEN"), "the read after both commands");
	} finally {
		noting = false;
		saveAlsoAllowedFolders(filesPolicy.agentId, []);
	}
});

fs.rmSync(work, { recursive: true, force: true });
console.log("windows-wait-smoke: ok");
