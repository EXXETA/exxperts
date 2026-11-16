// The folder contract: what a room's folder must do and what the app must do
// with it, each promise beside the row that holds it. Everything the server
// tells a person rests on these, and so do moving a room between disks and
// copying a folder in one step while the server runs.
//
// A row returns its problems, none when the promise holds, and runs on a real
// folder. folder-contract-smoke.ts runs them, and folder-contract-faults-smoke.ts
// plants a fault under each row that can be faulted. FOLDER_CONTRACT_DIR names
// the folder under test, so the same rows run on another disk.
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { waitEvery } from "./smoke-wait.js";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const webServerDir = path.resolve(scriptDir, "..");
const repoRoot = path.resolve(webServerDir, "..", "..");
const require = createRequire(import.meta.url);
const waitUntil = waitEvery(10, 60_000);

export type Row = (folder: string) => Promise<string[]>;

export interface ContractPromise {
	/** The row's name; FOLDER_CONTRACT_ONLY and the planted faults find it by this. */
	id: string;
	side: "disk" | "app";
	says: string;
	/** The row in this file, or where a check outside this file holds the promise. */
	heldBy: Row | string;
	/** What a pass here does not show. */
	cannotProve: string;
}

// --- Other processes -----------------------------------------------------------
// Two calls in one thread cannot overlap, so anything about a second writer or a
// reader in the middle of a write needs a second process.

const started = new Set<ChildProcess>();

function startRole(role: string, settings: Record<string, string>): ChildProcess {
	const child = spawn(process.execPath, [...process.execArgv, process.argv[1]!], { env: { ...process.env, FOLDER_CONTRACT_ROLE: role, ...settings }, stdio: ["ignore", "inherit", "inherit"] });
	started.add(child);
	child.once("exit", () => started.delete(child));
	return child;
}

export function killStartedRoles(): void {
	for (const child of started) child.kill("SIGKILL");
}

const hasExited = (child: ChildProcess) => child.exitCode !== null || child.signalCode !== null;

function pauseUntilFile(file: string): void {
	while (!fs.existsSync(file)) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1);
}

const setting = (name: string): string => process.env[name] ?? "";
const errorCode = (error: unknown): string => (error as NodeJS.ErrnoException).code ?? "no code";

const RACERS = 6;

/** Starts every racer, lets them go at once, and gives back what each said. */
async function race(folder: string, act: string): Promise<string[]> {
	const go = path.join(folder, "go");
	const places = Array.from({ length: RACERS }, (_, at) => ({ ready: path.join(folder, `ready-${at}`), result: path.join(folder, `result-${at}`) }));
	const racers = places.map((place, at) => startRole("racer", { RACE_ACT: act, RACE_AT: String(at), RACE_PLACE: folder, RACE_GO: go, RACE_READY: place.ready, RACE_RESULT: place.result }));
	await waitUntil(() => places.every((place) => fs.existsSync(place.ready)), "every racer is ready");
	fs.writeFileSync(go, "");
	await waitUntil(() => racers.every(hasExited), "every racer has answered and gone");
	return places.map((place) => (fs.existsSync(place.result) ? fs.readFileSync(place.result, "utf-8") : "no answer"));
}

function oneWinner(what: string, results: string[]): string[] {
	const winners = results.filter((result) => result === "won").length;
	const others = results.filter((result) => result !== "won" && result !== "refused");
	return [
		...(winners === 1 ? [] : [`${winners} of ${results.length} racers won ${what}, not one`]),
		...others.map((other) => `a racer on ${what} answered: ${other}`),
	];
}

// --- What a disk must do ---------------------------------------------------------

const WHOLE_OLD = Buffer.alloc(256 * 1024, "a");
const WHOLE_NEW = Buffer.alloc(256 * 1024, "b");
const REPLACE_READ_MS = 1_500;
/** Fewer changes than this and the reader never stood in the middle of a replace. */
const REPLACES_SEEN_AT_LEAST = 20;

/** Another process replaces the file over and over while this one reads it: every read is one whole version. */
async function atomicRenameRow(folder: string): Promise<string[]> {
	const target = path.join(folder, "replaced");
	const ready = path.join(folder, "ready");
	const stop = path.join(folder, "stop");
	fs.writeFileSync(target, WHOLE_OLD);
	const writer = startRole("replacer", { REPLACE_TARGET: target, REPLACE_READY: ready, REPLACE_STOP: stop });
	await waitUntil(() => fs.existsSync(ready) || hasExited(writer), "the replacing process is running");
	const seen = { missing: 0, torn: 0, changes: 0 };
	let last: Buffer | undefined;
	for (const end = Date.now() + REPLACE_READ_MS; Date.now() < end;) {
		try {
			const bytes = fs.readFileSync(target);
			const version = bytes.equals(WHOLE_OLD) ? WHOLE_OLD : bytes.equals(WHOLE_NEW) ? WHOLE_NEW : undefined;
			if (!version) seen.torn += 1;
			else if (last !== version) {
				seen.changes += 1;
				last = version;
			}
		} catch (error) {
			if (errorCode(error) !== "ENOENT") throw error;
			seen.missing += 1;
		}
	}
	fs.writeFileSync(stop, "");
	await waitUntil(() => hasExited(writer), "the replacing process has stopped");
	return [
		...(seen.missing ? [`the file was missing in ${seen.missing} reads during a rename`] : []),
		...(seen.torn ? [`${seen.torn} reads got neither whole version`] : []),
		...(seen.changes < REPLACES_SEEN_AT_LEAST ? [`the reader saw only ${seen.changes} replaces, too few to prove anything`] : []),
	];
}

function refusedWithExists(act: () => void): boolean {
	try {
		act();
		return false;
	} catch (error) {
		return errorCode(error) === "EEXIST";
	}
}

/** A link lands on a free name, is refused on a taken one and leaves it alone, and of many at once exactly one lands. */
async function linkIfAbsentRow(folder: string): Promise<string[]> {
	const problems: string[] = [];
	const [first, second, name] = ["first", "second", "name"].map((file) => path.join(folder, file)) as [string, string, string];
	fs.writeFileSync(first, "the first bytes");
	fs.writeFileSync(second, "the second bytes");
	fs.linkSync(first, name);
	if (fs.statSync(name).ino !== fs.statSync(first).ino) problems.push("a link gave the name a copy, not the same file");
	if (!refusedWithExists(() => fs.linkSync(second, name))) problems.push("a link over a taken name was not refused with EEXIST");
	if (fs.readFileSync(name, "utf-8") !== "the first bytes") problems.push("a link over a taken name replaced what was there");
	const racing = path.join(folder, "race");
	fs.mkdirSync(racing);
	problems.push(...oneWinner("a free name by link", await race(racing, "link")));
	return problems;
}

/** A create takes a free name, is refused on a taken one and leaves it alone, and of many at once exactly one takes it. */
async function exclusiveCreateRow(folder: string): Promise<string[]> {
	const problems: string[] = [];
	const name = path.join(folder, "name");
	fs.closeSync(fs.openSync(name, "wx"));
	fs.writeFileSync(name, "the first bytes");
	if (!refusedWithExists(() => fs.closeSync(fs.openSync(name, "wx")))) problems.push("an exclusive create on a taken name was not refused with EEXIST");
	if (fs.readFileSync(name, "utf-8") !== "the first bytes") problems.push("an exclusive create on a taken name changed what was there");
	const racing = path.join(folder, "race");
	fs.mkdirSync(racing);
	problems.push(...oneWinner("a free name by exclusive create", await race(racing, "create")));
	return problems;
}

const LINES_PER_APPENDER = 300;
const APPENDED_LINE_PADDING = "x".repeat(600);

/** Several processes append at once: every line lands whole, once, and each writer's lines stay in its order. */
async function appendRow(folder: string): Promise<string[]> {
	await race(folder, "append");
	const lines = fs.readFileSync(path.join(folder, "appended"), "utf-8").split("\n");
	if (lines.pop() !== "") return ["the appended file does not end at a line's end"];
	const problems = lines.length === RACERS * LINES_PER_APPENDER ? [] : [`${lines.length} of ${RACERS * LINES_PER_APPENDER} appended lines are there`];
	const nextOf = new Map<string, number>();
	for (const line of lines) {
		const [writer, count, padding] = line.split(" ");
		if (writer === undefined || padding !== APPENDED_LINE_PADDING) {
			problems.push("an appended line was torn");
			break;
		}
		const expected = nextOf.get(writer) ?? 0;
		if (Number(count) !== expected) problems.push(`writer ${writer} wrote line ${expected} next, and the file holds ${count}`);
		nextOf.set(writer, Number(count) + 1);
	}
	return problems.slice(0, 5);
}

/** The safe write flushes the file, renames, then flushes the folder, and the append flushes too; each call works on this disk. */
async function fsyncRow(folder: string): Promise<string[]> {
	const { appendFileFlushed, writeFileAtomic } = await import("@exxeta/exxperts-runtime");
	const problems: string[] = [];
	const steps: string[] = [];
	const opened = new Map<number, string>();
	const real = { openSync: fs.openSync, closeSync: fs.closeSync, fsyncSync: fs.fsyncSync, renameSync: fs.renameSync };
	const short = (target: string) => (target === folder ? "the folder" : path.basename(target).replace(/\.tmp-.*/, ".tmp"));
	fs.openSync = ((target: string, ...rest: [string, number]) => {
		const fd = real.openSync(target, ...rest);
		opened.set(fd, target);
		return fd;
	}) as typeof fs.openSync;
	fs.fsyncSync = (fd) => {
		real.fsyncSync(fd);
		steps.push(`flush ${short(opened.get(fd) ?? "an unknown file")}`);
	};
	fs.renameSync = (from, to) => {
		real.renameSync(from, to);
		steps.push(`rename ${short(String(from))} to ${short(String(to))}`);
	};
	try {
		writeFileAtomic(path.join(folder, "saved"), "the saved bytes");
		appendFileFlushed(path.join(folder, "log"), "a line\n");
	} catch (error) {
		problems.push(`a safe write failed: ${errorCode(error)}`);
	} finally {
		Object.assign(fs, real);
	}
	const expected = ["flush saved.tmp", "rename saved.tmp to saved", "flush the folder", "flush log"];
	if (!problems.length && steps.join(", ") !== expected.join(", ")) problems.push(`the flushes ran as ${steps.join(", ")}`);
	// The safe write forgives a folder flush the disk refuses, so ask for it here.
	for (const target of [path.join(folder, "saved"), folder]) {
		let fd: number | undefined;
		try {
			fd = fs.openSync(target, "r");
			fs.fsyncSync(fd);
		} catch (error) {
			problems.push(`flushing ${short(target)} failed: ${errorCode(error)}`);
		} finally {
			if (fd !== undefined) fs.closeSync(fd);
		}
	}
	return problems;
}

const PACKED_TIMES: ReadonlyArray<readonly [string, string]> = [
	["note.md", "2021-03-04T05:06:07Z"],
	["runtime/threads/record.json", "2021-03-04T05:06:09Z"],
	[".hidden/kept", "2021-03-04T05:06:11Z"],
	["runtime/threads", "2021-03-05T05:06:13Z"],
	["runtime", "2021-03-05T05:06:15Z"],
	[".hidden", "2021-03-05T05:06:17Z"],
];

/** A pack and a restore, the way a server's folder is copied, give every file and folder back its modified time, to the second. */
async function fileTimesRow(folder: string): Promise<string[]> {
	const source = path.join(folder, "source");
	const restored = path.join(folder, "restored");
	const pack = path.join(folder, "pack.tar");
	fs.mkdirSync(path.join(source, "runtime", "threads"), { recursive: true });
	fs.mkdirSync(path.join(source, ".hidden"));
	fs.mkdirSync(restored);
	// Files first: writing into a folder moves the folder's own time.
	for (const [name] of PACKED_TIMES.slice(0, 3)) fs.writeFileSync(path.join(source, name), name);
	for (const [name, time] of PACKED_TIMES) fs.utimesSync(path.join(source, name), new Date(time), new Date(time));
	for (const args of [["-cf", pack, "-C", source, "."], ["-xpf", pack, "-C", restored]]) {
		const run = spawnSync("tar", args, { encoding: "utf-8" });
		if (run.status !== 0) return [`tar ${args[0]} failed: ${run.stderr}`];
	}
	return PACKED_TIMES.flatMap(([name, time]) => {
		const stored = new Date(fs.statSync(path.join(source, name)).mtimeMs).toISOString().replace(/\.\d+Z$/, "Z");
		const back = new Date(fs.statSync(path.join(restored, name)).mtimeMs).toISOString().replace(/\.\d+Z$/, "Z");
		const want = new Date(time).toISOString().replace(/\.\d+Z$/, "Z");
		return [
			...(stored === want ? [] : [`this disk kept ${stored} for ${name}, not ${want}`]),
			...(back === want ? [] : [`${name} came back from the pack with the time ${back}, not ${want}`]),
		];
	});
}

// --- What the app must do --------------------------------------------------------

interface RoomLock {
	tryAcquire(room: string, owner: Record<string, unknown>): { ok: boolean };
	release(room: string, owner: Record<string, unknown>): void;
}

const roomLock = (): RoomLock => require(path.join(repoRoot, "bin", "lib", "room-lock.cjs")) as RoomLock;
const scheduledRun = (lockId: string) => ({ surface: "scheduler", lockId });
const webConnection = (connectionId: string) => ({ surface: "web", connectionId });

/** One owner holds a room against other owners, one of them in another process, a killed scheduled run frees it, and of owners racing in separate processes one wins. */
async function oneWriterRow(folder: string): Promise<string[]> {
	const problems: string[] = [];
	const stateHomeBefore = process.env.EXXPERTS_STATE_HOME;
	process.env.EXXPERTS_STATE_HOME = folder;
	try {
		const lock = roomLock();
		const held = path.join(folder, "held");
		const holder = startRole("lock-holder", { LOCK_HELD: held });
		await waitUntil(() => fs.existsSync(held) || hasExited(holder), "another process holds the room");
		if (lock.tryAcquire("room", scheduledRun("second")).ok) problems.push("a second scheduled run took a room a live run held");
		if (lock.tryAcquire("room", webConnection("window")).ok) problems.push("a connection took a room a live scheduled run held");
		holder.kill("SIGKILL");
		await waitUntil(() => hasExited(holder), "the holder is gone");
		if (!lock.tryAcquire("room", scheduledRun("after-kill")).ok) problems.push("a killed holder kept the room");
		lock.release("room", scheduledRun("after-kill"));

		if (!lock.tryAcquire("room", webConnection("first")).ok) problems.push("a connection could not take a free room");
		if (lock.tryAcquire("room", scheduledRun("second")).ok) problems.push("a scheduled run took a room a connection held");
		// The allowed neighbour: one server's reconnect gets a new id while the old lock lingers.
		if (!lock.tryAcquire("room", webConnection("reconnected")).ok) problems.push("a reconnect could not take its own room back");
		lock.release("room", webConnection("reconnected"));

		const racing = path.join(folder, "racing");
		fs.mkdirSync(racing);
		problems.push(...oneWinner("a room", await race(racing, "lock")));
	} finally {
		if (stateHomeBefore === undefined) delete process.env.EXXPERTS_STATE_HOME;
		else process.env.EXXPERTS_STATE_HOME = stateHomeBefore;
	}
	return problems;
}

/** The saves a room's records come from. Remember and Forget each close the one conversation a turn is sent to, so each list gets its own copy of the room. */
const RECORD_SAVES = [["add", "delete", "upload", "remember"], ["turn", "forget", "create"], ["turn"]];

/** The saves that keep an intent on disk only if a kill leaves it, each with the write that is its commit point, so finishing it is what comes next. */
const KILLED_SAVES_LEFT = [
	{ save: "forget", intent: "forget", commitPoint: /runtime[\\/]threads[\\/]pi_kill_room\.json$/ },
	{ save: "remember", intent: "remember", commitPoint: /L1b[\\/]current\.md$/ },
	{ save: "add", intent: "memory", commitPoint: /L1b[\\/]current\.md$/ },
];

type Harness = typeof import("./kill-at-write-harness.js");

export interface ChosenKill {
	home: string;
	/** The chosen folder, as the server resolves it. */
	chosen: string;
}

export interface RealRoom {
	/** One data folder for each list of saves. */
	homes: string[];
	/** A data folder killed at a save's commit point, by the name of its intent. */
	killLeft: Record<string, string>;
	/** The same kill in a room that works in a folder the person chose. */
	chosenKillLeft: Record<string, ChosenKill>;
	harness: Harness;
	saveProblems: string[];
}

let realRoom: Promise<RealRoom> | undefined;

async function makeRealRoom(): Promise<RealRoom> {
	const { freePort } = await import("./smoke-server-process.js");
	const harness = await import("./kill-at-write-harness.js");
	const { approveBody, seedEntryId } = await harness.prepareTemplate();
	const all = harness.saves(approveBody, seedEntryId);
	const saveProblems: string[] = [];
	// Each data folder has a server of its own, so they are made side by side: one after another takes minutes on a busy machine.
	const homes = await Promise.all(RECORD_SAVES.map(async (names) => {
		const home = path.join(harness.templateCopy("records"), "home");
		const port = await freePort();
		const run = { home, base: `http://127.0.0.1:${port}` };
		const child = harness.startServer({}, home, port);
		try {
			await harness.waitReady(child, run);
			for (const name of names) {
				const answer = await all.find((save) => save.name === name)!.send(run);
				if (answer.status >= 300) saveProblems.push(`${name} answered ${answer.status}, so its records were never written`);
			}
		} finally {
			await harness.endChild(child);
		}
		return home;
	}));
	const killLeft: Record<string, string> = {};
	const chosenKillLeft: Record<string, ChosenKill> = {};
	const killAt = async (save: ReturnType<Harness["saves"]>[number], step: number, intent: string, folder: string): Promise<void> => {
		const home = path.join(folder, "home");
		const arm = path.join(folder, "armed");
		const port = await freePort();
		const run = { home, base: `http://127.0.0.1:${port}` };
		const child = harness.startServer(save, home, port, { step, how: "after", arm });
		try {
			await harness.waitReady(child, run);
			fs.writeFileSync(arm, "");
			await save.send(run).catch(() => null);
			await waitUntil(() => hasExited(child.process), `${save.name} was killed at its commit point`);
		} finally {
			await harness.endChild(child);
		}
		if (!fs.existsSync(intentFile(harness, home, intent))) saveProblems.push(`the kill in ${save.name} left no intent to read`);
	};
	await Promise.all(KILLED_SAVES_LEFT.map(async ({ save: name, intent, commitPoint }) => {
		const save = all.find((candidate) => candidate.name === name)!;
		const trace = await harness.traceSave(save);
		const intentAt = trace.findIndex((step) => step.op === "renameSync" && step.target.endsWith(`${intent}.json`) && step.target.includes("commit"));
		const landing = trace.slice(intentAt).find((step) => step.op === "renameSync" && commitPoint.test(step.target));
		if (intentAt === -1 || !landing) {
			saveProblems.push(`${name} wrote no intent and commit point to kill at`);
			return;
		}
		const folder = harness.templateCopy(`killed-${name}`);
		await killAt(save, landing.step, intent, folder);
		killLeft[intent] = path.join(folder, "home");
		if (intent === "memory") return;
		const chosenFolder = harness.templateCopy(`killed-chosen-${name}`);
		const chosen = await chooseWorkspace(harness, path.join(chosenFolder, "home"));
		await killAt(save, landing.step, intent, chosenFolder);
		chosenKillLeft[intent] = { home: path.join(chosenFolder, "home"), chosen };
	}));
	return { homes, killLeft, chosenKillLeft, harness, saveProblems };
}

/** Runs a role to its end on a data folder, and gives back what it answered: null if it answered nothing. */
async function roleAnswer<T>(harness: Harness, role: string, home: string, settings: Record<string, string> = {}): Promise<T | null> {
	const answer = path.join(fs.mkdtempSync(path.join(harness.tempRoot, `${role}-`)), "answer.json");
	const child = startRole(role, { EXXETA_PERSISTENT_AGENTS_ROOT: harness.agentsRootOf(home), EXXPERTS_CODING_AGENT_DIR: harness.agentDirOf(home), OPEN_ROOM: harness.AGENT, OPEN_THREAD: harness.THREAD, OPEN_ANSWER: answer, ...settings });
	await waitUntil(() => hasExited(child), `the role ${role} has ended`);
	return fs.existsSync(answer) ? JSON.parse(fs.readFileSync(answer, "utf-8")) as T : null;
}

/** Sets a folder of its own as the room's workspace, as a person does on the desktop, and gives back its real path. */
async function chooseWorkspace(harness: Harness, home: string): Promise<string> {
	const chosen = path.join(path.dirname(home), "chosen-workspace");
	fs.mkdirSync(chosen);
	await roleAnswer(harness, "workspace-chooser", home, { CHOSEN: chosen });
	return fs.realpathSync(chosen);
}

const intentFile = (harness: Harness, home: string, intent: string) => path.join(harness.agentsRootOf(home), harness.AGENT, "runtime", "commit", `${intent}.json`);

/** One room, made by a real server through the real saves, shared by the rows that read it. */
export const roomFromRealSaves = (): Promise<RealRoom> => (realRoom ??= makeRealRoom());

export async function closeRealRoom(): Promise<void> {
	if (!realRoom) return;
	const { harness } = await realRoom;
	harness.provider.close();
	fs.rmSync(harness.tempRoot, { recursive: true, force: true, maxRetries: 5 });
}

function filesUnder(folder: string): string[] {
	return fs.readdirSync(folder, { withFileTypes: true }).flatMap((entry) => {
		const full = path.join(folder, entry.name);
		return entry.isDirectory() ? filesUnder(full) : [full];
	});
}

const isSessionFile = (file: string) => /[\\/]runtime[\\/]pi-sessions[\\/][^\\/]+\.jsonl$/.test(file);

const isLeftIntent = (file: string) => /[\\/]runtime[\\/]commit[\\/](forget|remember|memory)\.json$/.test(file);

/** Every way a record could spell a folder: as given, resolved, as a URL, and as the runtime turns a path into a folder name. */
function spellingsOf(folder: string): string[] {
	const forms = [folder, fs.realpathSync(folder)];
	return [...new Set(forms.flatMap((form) => [form, encodeURI(form), form.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")]))];
}

// A slash at the start of a name, not one inside a word, a web address, a
// relative path or a closing tag. One name counts: a data folder can be /data.
// So a person's own /remember in a conversation would count too, which is why
// this row reads rooms it made and never a real one.
const ABSOLUTE_PATH = /(?<![\w.~:/\\<-])\/[\w.@+~-]+(?:\/[\w.@+~-]+)*\/?/g;
const OTHER_ABSOLUTE_FORMS = /file:\/\/|(?<![\w])[A-Za-z]:[\\/]{1,2}[\w.-]|(?<![\w/])~\/[\w.-]/g;

/**
 * Every name and every byte of a data folder: nothing spells the folder's own
 * path, and nothing else is an absolute path, wherever it sits. Files we did not
 * parse count too, so a record in a new shape is read the same way.
 */
export function recordProblems(home: string): string[] {
	const spellings = spellingsOf(home);
	const problems: string[] = [];
	for (const file of filesUnder(home)) {
		const name = path.relative(home, file);
		for (const spelling of spellings) if (name.includes(spelling)) problems.push(`the file name ${name} holds the data folder's path`);
		const text = fs.readFileSync(file, "latin1");
		for (const spelling of spellings) if (text.includes(spelling)) problems.push(`${name} holds the data folder's path`);
		for (const match of [...text.matchAll(ABSOLUTE_PATH), ...text.matchAll(OTHER_ABSOLUTE_FORMS)]) problems.push(`${name} holds the absolute path ${match[0]}`);
	}
	return [...new Set(problems)];
}

async function relativeRecordsRow(): Promise<string[]> {
	const room = await roomFromRealSaves();
	const homes = [...room.homes, ...Object.values(room.killLeft)];
	const read = homes.flatMap(filesUnder);
	console.log(`  read ${read.length} files, ${read.filter(isSessionFile).length} of them session files and ${read.filter(isLeftIntent).length} left intents, after: ${RECORD_SAVES.flat().join(", ")}, and a kill in ${Object.keys(room.killLeft).join(", ")}`);
	return [...room.saveProblems, ...homes.flatMap(recordProblems)];
}

const NEXT_TURN_WORD = "after-the-header-moved";
const RUNTIME_CLI = path.join(repoRoot, "runtime", "packages", "coding-agent", "src", "cli.ts");
const COMMAND_LINE_HEADER = ["type", "version", "id", "timestamp", "cwd"];
/** What the kill harness's stand-in model always answers. */
const ANSWER_WORDS = "A fresh answer.";

const firstLineOf = (file: string) => JSON.parse(fs.readFileSync(file, "utf-8").split("\n")[0]!) as Record<string, unknown>;

/** Sends the next turn and shows it reached the model and landed in one of these session files, with its answer after it. */
async function nextTurnProblems(harness: Harness, run: { home: string; base: string }, sessions: readonly string[], conversationId?: string): Promise<string[]> {
	const problems: string[] = [];
	const callsBefore = harness.lastMessagesHeard.length;
	const answer = await harness.sendTurn(run, `One more turn, ${NEXT_TURN_WORD}.`, conversationId);
	if (answer.status >= 300) problems.push(`the next turn answered ${answer.status}`);
	if (harness.lastMessagesHeard.length === callsBefore) problems.push("the model was never called for the next turn");
	const landed = sessions.filter((file) => fs.existsSync(file)).map((file) => fs.readFileSync(file, "utf-8")).find((text) => text.includes(NEXT_TURN_WORD));
	if (!landed) problems.push("the next turn's words did not land in the session file");
	else if (!landed.slice(landed.indexOf(NEXT_TURN_WORD)).includes(ANSWER_WORDS)) problems.push("the model's answer did not land after the next turn's words");
	return problems;
}

const sessionFileOf = (harness: Harness, home: string, conversationId: string) => path.join(harness.agentsRootOf(home), harness.AGENT, "runtime", "pi-sessions", `${conversationId}.jsonl`);

/** Starts a server on this folder, runs the check on it, and always ends the server. */
async function onServer(harness: Harness, home: string, check: (run: { home: string; base: string }) => Promise<string[]>): Promise<string[]> {
	const { freePort } = await import("./smoke-server-process.js");
	const port = await freePort();
	const run = { home, base: `http://127.0.0.1:${port}` };
	const child = harness.startServer({}, home, port);
	try {
		await harness.waitReady(child, run);
		return await check(run);
	} finally {
		await harness.endChild(child);
	}
}

/**
 * Rooms have no way to branch or fork yet, so this makes each from a room's own
 * session, puts it where the room reads its session, and sends the next turn.
 * Every session a real server created is read too.
 */
async function roomSessionHeadersRow(): Promise<string[]> {
	const { harness, homes } = await roomFromRealSaves();
	const created = homes.flatMap(filesUnder).filter(isSessionFile);
	const problems = created.filter((file) => "cwd" in firstLineOf(file)).map((file) => `the created session ${path.basename(file)} has a cwd on its first line`);
	if (!created.length) problems.push("no room made a session to read");
	for (const how of ["branch", "fork"]) {
		const home = path.join(harness.templateCopy(`made-by-${how}`), "home");
		const made = await roleAnswer<{ file: string }>(harness, "session-maker", home, { MAKE: how });
		if (!made) {
			problems.push(`the room's session could not ${how}`);
			continue;
		}
		const header = firstLineOf(made.file);
		if ("cwd" in header) problems.push(`a ${how} has a cwd on its first line`);
		problems.push(...recordProblems(home).map((problem) => `after a ${how}: ${problem}`));
		const session = sessionFileOf(harness, home, harness.THREAD);
		fs.renameSync(made.file, session);
		const record = path.join(harness.agentsRootOf(home), harness.AGENT, "runtime", "threads", `${harness.THREAD}.json`);
		const thread = JSON.parse(fs.readFileSync(record, "utf-8")) as { runtime: { sessionId: unknown } };
		fs.writeFileSync(record, JSON.stringify({ ...thread, runtime: { ...thread.runtime, sessionId: header.id } }));
		problems.push(...(await onServer(harness, home, (run) => nextTurnProblems(harness, run, [session]))).map((problem) => `after a ${how}: ${problem}`));
	}
	return problems;
}

/** The command line's own sessions: its new session and its fork through the real program, its branch through the same manager, each with the header it always wrote. */
async function commandLineHeaderRow(): Promise<string[]> {
	const { harness } = await roomFromRealSaves();
	const { SessionManager } = await import("@exxeta/exxperts-runtime");
	const home = path.join(harness.templateCopy("command-line"), "home");
	const work = fs.realpathSync(fs.mkdtempSync(path.join(harness.tempRoot, "command-line-work-")));
	const sessions = path.join(work, "sessions");
	const run = async (...extra: string[]): Promise<void> => {
		const child = spawn(process.execPath, ["--import", harness.tsxLoader, RUNTIME_CLI, "-p", "hello", "--provider", "fake-gpt", "--model", "gpt-fake", "--session-dir", sessions, ...extra], { cwd: work, env: { ...process.env, HOME: home, EXXPERTS_CODING_AGENT_DIR: harness.agentDirOf(home) }, stdio: ["ignore", "ignore", "inherit"] });
		await new Promise((resolve) => child.once("exit", resolve));
	};
	await run();
	const [first] = fs.existsSync(sessions) ? fs.readdirSync(sessions) : [];
	if (!first) return ["the command line wrote no session"];
	const source = path.join(sessions, first);
	const problems: string[] = [];
	const expect = (name: string, file: string, keys: readonly string[], parent?: string) => {
		const header = firstLineOf(file);
		if (Object.keys(header).join() !== keys.join()) problems.push(`the command line's ${name} wrote the header fields ${Object.keys(header).join()}`);
		if (header.cwd !== work) problems.push(`the command line's ${name} wrote the folder ${String(header.cwd)}`);
		if (header.parentSession !== parent) problems.push(`the command line's ${name} named its parent ${String(header.parentSession)}`);
	};
	expect("new session", source, COMMAND_LINE_HEADER);
	await run("--fork", source);
	const forked = fs.readdirSync(sessions).find((name) => name !== first);
	if (!forked) return [...problems, "the command line wrote no fork"];
	expect("fork", path.join(sessions, forked), [...COMMAND_LINE_HEADER, "parentSession"], source);
	const manager = SessionManager.open(source);
	const branched = manager.createBranchedSession(manager.getLeafId()!);
	if (!branched) return [...problems, "the command line's manager wrote no branch"];
	expect("branch", branched, [...COMMAND_LINE_HEADER, "parentSession"], source);
	return problems;
}

/** The session's header points at a folder that does not exist, the server starts on that disk, and the next turn works and lands. */
async function sessionHeaderRow(): Promise<string[]> {
	const { harness } = await roomFromRealSaves();
	const copy = path.join(harness.templateCopy("header-moved"), "home");
	const sessions = filesUnder(path.join(harness.agentsRootOf(copy), harness.AGENT)).filter(isSessionFile);
	const gone = path.join(copy, "a-folder-that-does-not-exist");
	for (const file of sessions) {
		const [first, ...rest] = fs.readFileSync(file, "utf-8").split("\n");
		fs.writeFileSync(file, [JSON.stringify({ ...JSON.parse(first!), cwd: gone }), ...rest].join("\n"));
	}
	if (!sessions.length) return ["the room holds no session file to point elsewhere"];
	return onServer(harness, copy, async (run) => [...await harness.roomProblems(run), ...await nextTurnProblems(harness, run, sessions), ...await harness.roomProblems(run), ...await headerCwdProblems(harness, copy, gone)]);
}

/**
 * A plain turn never asks the session's folder, so the turn above would pass on
 * a server that trusted the header. This asks the open itself, in a process of
 * its own, because the store fixes its root folder when it loads.
 */
async function headerCwdProblems(harness: Harness, home: string, gone: string): Promise<string[]> {
	const answer = await roleAnswer<{ file: string; opened: string }>(harness, "session-opener", home);
	if (!answer) return ["the session could not be opened with its header pointing nowhere"];
	const { file, opened } = answer;
	if (!fs.readFileSync(file, "utf-8").split("\n")[0]!.includes(gone)) return ["the session opened is not the one whose header was changed, so this proves nothing"];
	return opened === repoRoot ? [] : [`a session opened in the folder its header names, ${opened}, not the one the server gave it`];
}

const copyOfKilled = (harness: Harness, killed: string, name: string) => {
	const home = path.join(fs.mkdtempSync(path.join(harness.tempRoot, `${name}-`)), "home");
	fs.cpSync(killed, home, { recursive: true });
	return home;
};

/** The next start on a folder a kill left: the save finishes, the room moves to its fresh conversation, whose header holds no folder, and the next turn lands there. */
function finishProblems(harness: Harness, home: string, intent: string): Promise<string[]> {
	return onServer(harness, home, async (run) => {
		const problems = await harness.roomProblems(run);
		const status = await harness.readJsonAnswer(harness.roomUrl(run, "/status"));
		const fresh: unknown = status.body?.runtime?.activeThreadId;
		if (fs.existsSync(intentFile(harness, home, intent))) problems.push("the save was not finished: its intent is still there");
		if (typeof fresh !== "string" || fresh === harness.THREAD) return [...problems, `the room did not move to a fresh conversation: ${String(fresh)}`];
		const session = sessionFileOf(harness, home, fresh);
		if (!fs.existsSync(session)) return [...problems, "the fresh conversation has no session file"];
		if ("cwd" in firstLineOf(session)) problems.push(`the fresh conversation has the folder ${String(firstLineOf(session).cwd)} on its first line`);
		return [...problems, ...await nextTurnProblems(harness, run, [session], fresh), ...await harness.roomProblems(run)];
	});
}

/** A kill's own intent: it names no folder, and the next start finishes it. */
const leftIntentRow = (intent: string): Row => async () => {
	const { harness, killLeft } = await roomFromRealSaves();
	const killed = killLeft[intent];
	if (!killed) return [`no kill left a ${intent} intent`];
	const held = JSON.parse(fs.readFileSync(intentFile(harness, killed, intent), "utf-8")) as Record<string, unknown>;
	return [...("runtimeCwd" in held ? [`the intent holds the folder ${String(held.runtimeCwd)}`] : []), ...await finishProblems(harness, copyOfKilled(harness, killed, `left-${intent}`), intent)];
};

/** A room restored after a kill from an older version: its intent names a folder that does not exist, and that decides nothing. */
function finishedWithDeadFolderProblems(harness: Harness, killed: string, intent: string): Promise<string[]> {
	const home = copyOfKilled(harness, killed, "dead-folder");
	const file = intentFile(harness, home, intent);
	fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, "utf-8")), runtimeCwd: path.join(home, "a-folder-that-does-not-exist") }));
	return finishProblems(harness, home, intent);
}

/**
 * The folder given to a finish reaches no file, so a wrong one can only be seen
 * as it is handed over: the settle runs in a process of its own that notes the
 * folder of each session it opens.
 */
async function chosenWorkspaceKillProblems(harness: Harness, { home, chosen }: ChosenKill, intent: string): Promise<string[]> {
	const settled = await roleAnswer<{ opened: string[]; active: string }>(harness, "room-settler", home);
	if (!settled) return ["the room could not be settled"];
	const problems = settled.opened.filter((folder) => folder !== chosen).map((folder) => `the finish opened a session in ${folder}, not the chosen folder ${chosen}`);
	if (!settled.opened.length) problems.push("the finish opened no session, so this proves nothing");
	if (settled.active === harness.THREAD) problems.push("the finish did not move the room to its fresh conversation");
	const opened = await roleAnswer<{ opened: string }>(harness, "session-opener", home, { OPEN_THREAD: settled.active });
	if (opened?.opened !== chosen) problems.push(`the fresh conversation opens in ${String(opened?.opened)}, not the chosen folder ${chosen}`);
	return [...problems, ...await finishProblems(harness, home, intent)];
}

/** A room that works in a folder the person chose: a new conversation there, and a kill during each save. */
async function chosenWorkspaceRow(): Promise<string[]> {
	const { authedFetch } = await import("./smoke-server-process.js");
	const { harness, chosenKillLeft } = await roomFromRealSaves();
	const home = path.join(harness.templateCopy("chosen-workspace"), "home");
	const chosen = await chooseWorkspace(harness, home);
	const conversation = "pi_chosen_workspace";
	const session = sessionFileOf(harness, home, conversation);
	const problems = await onServer(harness, home, async (run) => {
		const made = await authedFetch(harness.roomUrl(run, `/threads/${conversation}`), { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ state: "active", origin: "home", items: [] }) });
		return made.ok ? nextTurnProblems(harness, run, [session], conversation) : [`the new conversation answered ${made.status}`];
	});
	if (fs.existsSync(session) && "cwd" in firstLineOf(session)) problems.push(`the new conversation has the folder ${String(firstLineOf(session).cwd)} on its first line`);
	const opened = await roleAnswer<{ opened: string }>(harness, "session-opener", home, { OPEN_THREAD: conversation });
	if (opened?.opened !== chosen) problems.push(`the new conversation opens in ${String(opened?.opened)}, not the chosen folder ${chosen}`);
	for (const intent of ["forget", "remember"]) {
		const killed = chosenKillLeft[intent];
		if (!killed) problems.push(`no kill left a ${intent} intent in a room with a chosen workspace`);
		else problems.push(...(await chosenWorkspaceKillProblems(harness, killed, intent)).map((problem) => `${intent}: ${problem}`));
	}
	return problems;
}

async function deadFolderRow(): Promise<string[]> {
	const { harness, killLeft } = await roomFromRealSaves();
	const problems: string[] = [];
	for (const intent of ["forget", "remember"]) {
		const killed = killLeft[intent];
		if (!killed) problems.push(`no kill left a ${intent} intent`);
		else problems.push(...(await finishedWithDeadFolderProblems(harness, killed, intent)).map((problem) => `${intent}: ${problem}`));
	}
	return problems;
}

/** Each kind of save, by the name the kill smokes run it under. */
const KILLED_SAVES: Record<CommitKind, readonly string[]> = { forget: ["forget"], remember: ["remember"], memory: ["add", "delete"] };

/** What is wrong between the kill smokes' sources and the saves that must be killed. */
export function killProblems(smokeSources: readonly string[]): string[] {
	const run = new Set(smokeSources.flatMap((source) => [...source.matchAll(/runKillMatrix\(\[([^\]]*)\]/g)].flatMap((call) => [...call[1]!.matchAll(/"([^"]+)"/g)].map((name) => name[1]!))));
	return Object.values(KILLED_SAVES).flat().filter((name) => !run.has(name)).map((name) => `no kill smoke runs the save ${name}`);
}

async function killRow(): Promise<string[]> {
	const smokes = fs.readdirSync(scriptDir).filter((name) => name.startsWith("kill-at-write") && name.endsWith("-smoke.ts"));
	return killProblems(smokes.map((name) => fs.readFileSync(path.join(scriptDir, name), "utf-8")));
}

// --- Saves stay synchronous ------------------------------------------------------
// A copy taken in one step on the server's thread can land inside a save only if
// the save gives the thread up, and the settle that runs from any status read
// leans on the same thing (memory-commit.ts). A run could not hold this: it sees
// the branch it took, and these saves branch. A look at the save's own lines
// could not either: most of a save is in helpers, some in the runtime. So this
// reads the source with the TypeScript checker, from each save through everything
// it reaches, on every branch, and fails on what it cannot read.

type CommitKind = "forget" | "memory" | "remember";
const COMMIT_KINDS: readonly CommitKind[] = ["forget", "memory", "remember"];

const RUNTIME_PACKAGES = path.join(repoRoot, "runtime", "packages");
// The packages' source, not their built types: a type has no body to read.
const READ_FROM_SOURCE = {
	"@exxeta/exxperts-runtime": [path.join(RUNTIME_PACKAGES, "coding-agent", "src", "index.ts")],
	"@exxeta/exxperts-core": [path.join(RUNTIME_PACKAGES, "agent", "src", "index.ts")],
	"@exxeta/exxperts-ai": [path.join(RUNTIME_PACKAGES, "ai", "src", "index.ts")],
};

/** Node calls known to be done when they return. Anything else of Node's fails, a new module or a callback form included. */
const NODE_CALLS_DONE_ON_RETURN: Readonly<Record<string, RegExp>> = {
	"buffer.buffer.d.ts": /./,
	"buffer.d.ts": /./,
	"console.d.ts": /^(error|log|warn)$/,
	"crypto.d.ts": /^(createHash|digest|randomBytes|randomUUID|update)$/,
	"fs.d.ts": /Sync$|^(isDirectory|isFile|isSymbolicLink|native)$/,
	"os.d.ts": /^(homedir|hostname|tmpdir)$/,
	"path.d.ts": /./,
	"process.d.ts": /^cwd$/,
};

/** Calls on a value the checker cannot type, which do their work before they return whatever the value is. */
const DONE_ON_RETURN_ON_ANY = new Set(["filter", "flatMap", "map", "trim"]);

const DEFERRING_NAMES = new Set(["queueMicrotask", "setImmediate", "setInterval", "setTimeout"]);

/** Calls with no body to read, each by file and name, with why it is done when it returns. */
export const READ_AS_SYNCHRONOUS: Readonly<Record<string, string>> = {
	"persistent-agent-forget.ts:deletionLanded": "A server hook slot typed to give a boolean; its one filling writes one small file through a temporary name, or one more in the room's folder when that fails, never throws, and answers at once.",
	"persistent-agent-forget.ts:stop": "A running Remember's stop, set in room-remember-routes.ts: cancelRememberJob marks the job and aborts its controller, and the job ends on its own later.",
	"persistent-agent-remember-save.ts:stop": "The same stop as Forget's.",
	"persistent-agent-threads.ts:createRuntime": "An option; the two a save passes are arrows in its own body, read with the save, and each only builds a record.",
	"persistent-room-workspace-policy.ts:ignoresStoredWorkspaceSettings": "A server hook slot typed to give a boolean; its one filling answers at once.",
	"session-manager.ts:has": "The has of the Map of a session's entries, behind a narrow parameter type.",
	"session-manager.ts:uuidv7": "The uuid package's id maker, which returns a string.",
};

export interface SaveReading {
	spans: string[];
	functions: number;
	problems: string[];
}

// A file no reading plants into is the same for every reading in a run, so it is parsed once: a reading per planted fault would parse the whole source again, which takes seconds on a busy machine.
const unplantedFiles = new Map<string, ts.SourceFile | undefined>();

function programOver(planted: ReadonlyMap<string, string>): ts.Program {
	const parsed = ts.getParsedCommandLineOfConfigFile(path.join(webServerDir, "tsconfig.json"), {}, { ...ts.sys, onUnRecoverableConfigFileDiagnostic: (diagnostic) => { throw new Error(String(diagnostic.messageText)); } });
	if (!parsed) throw new Error("the server's tsconfig.json could not be read");
	const options = { ...parsed.options, noEmit: true, baseUrl: webServerDir, paths: READ_FROM_SOURCE };
	const host = ts.createCompilerHost(options, true);
	const readFile = host.readFile.bind(host);
	host.readFile = (file) => planted.get(path.resolve(file)) ?? readFile(file);
	const getSourceFile = host.getSourceFile.bind(host);
	host.getSourceFile = (file, ...rest) => {
		if (planted.has(path.resolve(file))) return getSourceFile(file, ...rest);
		if (!unplantedFiles.has(file)) unplantedFiles.set(file, getSourceFile(file, ...rest));
		return unplantedFiles.get(file);
	};
	return ts.createProgram(parsed.fileNames, options, host);
}

const placeOf = (node: ts.Node): string => {
	const file = node.getSourceFile();
	return `${path.relative(repoRoot, file.fileName)}:${file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1}`;
};

const calleeName = (call: ts.CallExpression | ts.NewExpression): string => {
	const callee = call.expression;
	return ts.isPropertyAccessExpression(callee) ? callee.name.text : ts.isIdentifier(callee) ? callee.text : callee.getText();
};

function functionOf(declaration: ts.Declaration | undefined): ts.Node | undefined {
	if (!declaration || declaration.getSourceFile().isDeclarationFile) return undefined;
	if (ts.isFunctionLike(declaration)) return (declaration as ts.FunctionLikeDeclaration).body ? declaration : undefined;
	const value = ts.isVariableDeclaration(declaration) || ts.isPropertyDeclaration(declaration) || ts.isPropertyAssignment(declaration) ? declaration.initializer : undefined;
	return value && (ts.isArrowFunction(value) || ts.isFunctionExpression(value)) ? value : undefined;
}

const enclosingFunction = (node: ts.Node): ts.Node | undefined => {
	let current: ts.Node | undefined = node.parent;
	while (current && !ts.isFunctionLike(current)) current = current.parent;
	return current;
};

class SaveReader {
	private readonly checker: ts.TypeChecker;
	readonly problems = new Set<string>();
	readonly readAsSynchronous = new Set<string>();
	functions = new Set<ts.Node>();
	constructor(program: ts.Program) {
		this.checker = program.getTypeChecker();
	}

	/** The function a call runs, when it is one of memory-commit.ts's own. */
	isCommitCall(call: ts.CallExpression, name: string): boolean {
		const declaration = this.checker.getResolvedSignature(call)?.declaration;
		return !!declaration && ts.isFunctionDeclaration(declaration) && declaration.name?.text === name && declaration.getSourceFile().fileName.endsWith("memory-commit.ts");
	}

	callsTo(node: ts.Node, name: string): ts.CallExpression[] {
		const calls: ts.CallExpression[] = [];
		const visit = (current: ts.Node): void => {
			if (ts.isCallExpression(current) && this.isCommitCall(current, name)) calls.push(current);
			ts.forEachChild(current, visit);
		};
		visit(node);
		return calls;
	}

	private symbolOf(node: ts.Node): ts.Symbol | undefined {
		const symbol = this.checker.getSymbolAtLocation(node);
		return symbol && symbol.flags & ts.SymbolFlags.Alias ? this.checker.getAliasedSymbol(symbol) : symbol;
	}

	settlerOf(argument: ts.Expression): ts.Node | undefined {
		if (ts.isArrowFunction(argument) || ts.isFunctionExpression(argument)) return argument;
		return functionOf(this.symbolOf(argument)?.valueDeclaration);
	}

	/** Reads one span, from `start` to `end` of `root`, and everything it reaches. */
	read(span: string, root: ts.Node, start: number, end: number): void {
		const seen = new Set<ts.Node>();
		const queue: ts.Node[] = [];
		const fail = (node: ts.Node, what: string) => this.problems.add(`${span}: ${what} at ${placeOf(node)}`);
		const enter = (target: ts.Node | undefined) => {
			if (target && !seen.has(target)) {
				seen.add(target);
				queue.push(target);
			}
		};
		const visit = (node: ts.Node, from: number, to: number): void => {
			if (node.getEnd() <= from || node.getStart() >= to) return;
			const whole = node.getStart() >= from && node.getEnd() <= to;
			if (whole) this.judge(node, fail, enter);
			ts.forEachChild(node, (child) => visit(child, from, to));
		};
		visit(root, start, end);
		while (queue.length) {
			const body = queue.pop()!;
			this.functions.add(body);
			if (ts.getCombinedModifierFlags(body as ts.Declaration) & ts.ModifierFlags.Async) fail(body, "an async function");
			visit(body, body.getStart(), body.getEnd());
		}
	}

	private judge(node: ts.Node, fail: (node: ts.Node, what: string) => void, enter: (target: ts.Node | undefined) => void): void {
		if (ts.isAwaitExpression(node) || (ts.isForOfStatement(node) && node.awaitModifier)) fail(node, "an await");
		if (ts.isFunctionLike(node) && ts.getCombinedModifierFlags(node as ts.Declaration) & ts.ModifierFlags.Async) fail(node, "an async function");
		if (ts.isIdentifier(node)) enter(functionOf(this.symbolOf(node)?.valueDeclaration));
		if (ts.isCallExpression(node) || ts.isNewExpression(node)) this.judgeCall(node, fail, enter);
	}

	private judgeCall(call: ts.CallExpression | ts.NewExpression, fail: (node: ts.Node, what: string) => void, enter: (target: ts.Node | undefined) => void): void {
		const name = calleeName(call);
		const result = this.checker.getTypeAtLocation(call);
		const parts = result.isUnion() ? result.types : [result];
		if (parts.some((part) => part.getProperty("then"))) return fail(call, `a call to ${name} that gives a promise`);
		if (DEFERRING_NAMES.has(name)) return fail(call, `${name}, which runs its work later`);
		const declaration = this.checker.getResolvedSignature(call)?.declaration;
		const file = declaration && !ts.isJSDocSignature(declaration) ? declaration.getSourceFile() : undefined;
		const body = declaration && !ts.isJSDocSignature(declaration) ? functionOf(declaration) : undefined;
		if (body) return enter(body);
		if (file && /[\\/]typescript[\\/]lib[\\/]lib\./.test(file.fileName)) return;
		if (file && /[\\/]@types[\\/]node[\\/]/.test(file.fileName)) {
			// A name alone cannot tell randomBytes(1) from randomBytes(1, callback).
			if (call.arguments?.some((argument) => this.checker.getTypeAtLocation(argument).getCallSignatures().length)) return fail(call, `a call that hands a function to Node's ${name}`);
			const allowed = NODE_CALLS_DONE_ON_RETURN[path.basename(file.fileName)];
			if (!allowed?.test(name)) fail(call, `Node's ${name}, not known to be done when it returns`);
			return;
		}
		if (ts.isNewExpression(call) && !declaration) return;
		if (!declaration && DONE_ON_RETURN_ON_ANY.has(name)) return;
		const key = `${path.basename(call.getSourceFile().fileName)}:${name}`;
		if (key in READ_AS_SYNCHRONOUS) this.readAsSynchronous.add(key);
		else fail(call, `a call to ${name} this check cannot read`);
	}
}

/** Reads every save in the server's source. `planted` replaces files' text, by full path, without touching them. */
export function readSaves(planted: ReadonlyMap<string, string> = new Map()): SaveReading {
	const program = programOver(planted);
	const reader = new SaveReader(program);
	const spans: string[] = [];
	const sources = program.getSourceFiles().filter((file) => !file.isDeclarationFile && !file.fileName.endsWith("memory-commit.ts"));
	for (const file of sources) {
		if (!file.text.includes("CommitIntent") && !file.text.includes("registerCommitSettler")) continue;
		for (const intent of reader.callsTo(file, "writeCommitIntent")) {
			const kind = intent.arguments[1]?.getText().replace(/"/g, "") ?? "unknown";
			const owner = enclosingFunction(intent);
			const clears = owner ? reader.callsTo(owner, "clearCommitIntent").filter((clear) => clear.getStart() > intent.getStart() && clear.arguments[1]?.getText() === intent.arguments[1]?.getText()) : [];
			if (!owner || !clears.length) {
				reader.problems.add(`${kind} save: no clear of its intent in the same function at ${placeOf(intent)}, so its end cannot be read`);
				continue;
			}
			spans.push(`${kind} save`);
			reader.read(`${kind} save`, owner, intent.getStart(), clears.at(-1)!.getEnd());
		}
		for (const register of reader.callsTo(file, "registerCommitSettler")) {
			const kind = register.arguments[0]?.getText().replace(/"/g, "") ?? "unknown";
			const settler = register.arguments[1] && reader.settlerOf(register.arguments[1]);
			if (!settler) {
				reader.problems.add(`${kind} settle: its settler at ${placeOf(register)} cannot be read`);
				continue;
			}
			spans.push(`${kind} settle`);
			reader.read(`${kind} settle`, settler, settler.getStart(), settler.getEnd());
		}
	}
	for (const kind of COMMIT_KINDS) {
		for (const span of [`${kind} save`, `${kind} settle`]) if (!spans.includes(span)) reader.problems.add(`${span}: the check found no such span, so it holds nothing`);
	}
	for (const span of spans) if (!COMMIT_KINDS.some((kind) => span.startsWith(`${kind} `))) reader.problems.add(`${span}: a kind this contract does not know; add it here and to the kill smokes`);
	for (const key of Object.keys(READ_AS_SYNCHRONOUS)) if (!reader.readAsSynchronous.has(key)) reader.problems.add(`${key} is on the list of calls read as synchronous and no save reaches it: take its line off`);
	return { spans: [...new Set(spans)].sort(), functions: reader.functions.size, problems: [...reader.problems] };
}

async function savesRow(): Promise<string[]> {
	return readSaves().problems;
}

// --- The contract ----------------------------------------------------------------

export const FOLDER_CONTRACT: readonly ContractPromise[] = [
	{
		id: "atomic rename",
		side: "disk",
		says: "A rename over a file is seen whole: a reader in another process gets the old bytes or the new ones, never nothing and never a mix.",
		heldBy: atomicRenameRow,
		cannotProve: "A reader on another machine, and that a rename survives a power cut.",
	},
	{
		id: "link if absent",
		side: "disk",
		says: "A hard link lands on a free name and is refused with EEXIST on a taken one, leaving it as it was, and of several at once exactly one lands.",
		heldBy: linkIfAbsentRow,
		cannotProve: "Racers on another machine.",
	},
	{
		id: "exclusive create",
		side: "disk",
		says: "An exclusive create takes a free name and is refused with EEXIST on a taken one, leaving it as it was, and of several at once exactly one takes it.",
		heldBy: exclusiveCreateRow,
		cannotProve: "Racers on another machine.",
	},
	{
		id: "append",
		side: "disk",
		says: "An append lands at the file's end, whole and once, even with several processes appending, and each writer's lines keep their order.",
		heldBy: appendRow,
		cannotProve: "Appenders on another machine, and lines longer than the row's.",
	},
	{
		id: "fsync",
		side: "disk",
		says: "The safe write flushes the file, renames it, then flushes the folder, an append flushes, and on this disk a file's flush and a folder's flush both work.",
		heldBy: fsyncRow,
		cannotProve: "That flushed bytes reach the disk. Only a power cut shows that: this row proves the call is made and answers, and a disk that lies about a flush passes it.",
	},
	{
		id: "file times",
		side: "disk",
		says: "A file or folder's modified time survives a pack and a restore with tar, to the second, on this disk.",
		heldBy: fileTimesRow,
		cannotProve: "Parts of a second, which tar's formats may drop, and any pack other than tar.",
	},
	{
		id: "one writer per room",
		side: "app",
		says: "Inside one server the room lock lets one owner hold a room: a live scheduled run or connection refuses the other, a live holder in another process included, and a killed scheduled run frees it at once. A reconnect takes its own room back. Of owners racing in separate processes, exactly one wins.",
		heldBy: oneWriterRow,
		cannotProve: "Racers on another machine, and a disk with no hard links, whose plain exclusive create a racer can still catch empty. Two servers on one folder: connections also take over from each other, because the lock assumes one server, which is the next line; the desktop has no lock there, only its single-instance lock and its port.",
	},
	{
		id: "one server per data folder",
		side: "app",
		says: "A shared server refuses to start on a data folder another server is using.",
		heldBy: "The shared server's start, and the check kept with it.",
		cannotProve: "Two machines or two network namespaces on one disk, which the lock cannot see.",
	},
	{
		id: "records stay relative",
		side: "app",
		says: "No file a real server writes holds the data folder's path in any spelling, or any other absolute path, in a name or in a byte, a kill's leftovers included.",
		heldBy: relativeRecordsRow,
		cannotProve: "A record these saves do not write, such as a schedule, a skill, a connector or an archived room; and a path written in a form the row does not know. On the desktop only, a room's workspace grant stores the folders a person chose, as absolute paths: a shared server ignores stored workspace settings, and no room this row reads has a grant.",
	},
	{
		id: "room session headers",
		side: "app",
		says: "A session a room creates, branches or forks has no cwd on its first line, and names no parent by an absolute path; the same session opens, takes a turn and lands.",
		heldBy: roomSessionHeadersRow,
		cannotProve: "A branch or a fork made by the server, since rooms have no way to make either yet: this row makes each with the room's own session manager.",
	},
	{
		id: "command line header",
		side: "app",
		says: "The runtime's own command line writes the header it always wrote: its working folder on a session's first line, and a branch's or a fork's parent as a full path.",
		heldBy: commandLineHeaderRow,
		cannotProve: "An interactive branch, which goes through the same session manager this row calls.",
	},
	{
		id: "forget intent left by a kill",
		side: "app",
		says: "A Forget a kill left names no folder, and the next start finishes it: the room opens on its fresh conversation, and the next turn works and lands.",
		heldBy: leftIntentRow("forget"),
		cannotProve: "A tool the model runs in that fresh conversation, since the stand-in model calls none.",
	},
	{
		id: "remember intent left by a kill",
		side: "app",
		says: "A Remember a kill left names no folder, and the next start finishes it: the room opens on its fresh conversation, and the next turn works and lands.",
		heldBy: leftIntentRow("remember"),
		cannotProve: "A tool the model runs in that fresh conversation, since the stand-in model calls none.",
	},
	{
		id: "chosen workspace",
		side: "app",
		says: "On the desktop, a room with a chosen workspace works in that folder: a new conversation opens there with no folder on its first line, and a kill during its Forget or Remember finishes the save with every session opened there.",
		heldBy: chosenWorkspaceRow,
		cannotProve: "A conversation with a workspace of its own, different from the room's: the fresh conversation a save opens follows the room, as a normal open does. A tool the model runs, since the stand-in model calls none.",
	},
	{
		id: "session header unread",
		side: "app",
		says: "With an old session file's cwd pointing at a folder that does not exist, the room opens, the next turn works and lands, and a session opens in the folder the server gives it, not the one its header names.",
		heldBy: sessionHeaderRow,
		cannotProve: "A tool the model runs that reads the session's folder, since the stand-in model calls none; and what the model was sent, since it records only the last message, which is the room's state. The row shows the model was called and that the words and the answer landed.",
	},
	{
		id: "dead folder in an intent",
		side: "app",
		says: "A Forget or Remember an older version's kill left, restored with its runtimeCwd pointing at a folder that does not exist, finishes on the next request, and that folder decides nothing: the room opens on its fresh conversation, and the next turn works and lands.",
		heldBy: deadFolderRow,
		cannotProve: "A tool the model runs in that fresh conversation, since the stand-in model calls none.",
	},
	{
		id: "fixed data path",
		side: "app",
		says: "A shared server's data path is fixed by its image, so a restored folder lands on the same path.",
		heldBy: "The shared server's image, and the check kept with it.",
		cannotProve: "Nothing here looks at it: the rows above hold that the records would not care.",
	},
	{
		id: "a kill at every step",
		side: "app",
		says: "A kill at any write of a save leaves a room that opens, with nothing the person was told is saved lost and nothing doubled. The kill-at-write smokes hold this: this row holds only that they still run each save. Set TMPDIR to run them on another disk.",
		heldBy: killRow,
		cannotProve: "A power cut: a process kill leaves what the system already holds.",
	},
	{
		id: "saves stay synchronous",
		side: "app",
		says: "From writing its intent to clearing it, a save never gives up the thread, on any branch, and neither does a settle.",
		heldBy: savesRow,
		cannotProve: "A call that hides its work behind a synchronous signature inside a body this check cannot read, which is why such calls must be listed. A save with no intent is not read: an upload, a room's creation or a turn's append can be cut between two writes, and the kill smokes hold that each of those steps leaves a good room.",
	},
];

// --- What the other processes do --------------------------------------------------

const RACE_ACTS: Readonly<Record<string, () => string>> = {
	// The row's pid as the owner's: a winner that has answered and gone must still count as live for the racer after it.
	lock: () => (roomLock().tryAcquire("racing", { ...scheduledRun(`racer-${setting("RACE_AT")}`), pid: process.ppid }).ok ? "won" : "refused"),
	link: () => {
		const at = setting("RACE_AT");
		const mine = path.join(setting("RACE_PLACE"), `mine-${at}`);
		fs.writeFileSync(mine, at);
		try {
			fs.linkSync(mine, path.join(setting("RACE_PLACE"), "name"));
			return "won";
		} catch (error) {
			return errorCode(error) === "EEXIST" ? "refused" : errorCode(error);
		}
	},
	create: () => {
		try {
			fs.closeSync(fs.openSync(path.join(setting("RACE_PLACE"), "name"), "wx"));
			return "won";
		} catch (error) {
			return errorCode(error) === "EEXIST" ? "refused" : errorCode(error);
		}
	},
	append: () => {
		for (let count = 0; count < LINES_PER_APPENDER; count += 1) fs.appendFileSync(path.join(setting("RACE_PLACE"), "appended"), `${setting("RACE_AT")} ${count} ${APPENDED_LINE_PADDING}\n`);
		return "won";
	},
};

/** Opens a room's session in the folder the server gives that conversation, worked out with the same two calls as a live connection; the live connection itself is not watched. */
async function openRoomSession() {
	const agents = await import("../src/persistent-agents.js");
	const policy = await import("../src/persistent-room-workspace-policy.js");
	const room = setting("OPEN_ROOM");
	const conversation = setting("OPEN_THREAD");
	const thread = agents.getPersistentAgentThread(room, conversation);
	if (thread?.runtime.kind !== "pi-session-jsonl") return null;
	return agents.openPersistentAgentPiSessionManager(room, thread.runtime, policy.persistentRoomRuntimeCwdForEffectiveWorkspacePolicy(policy.resolvePersistentRoomEffectiveWorkspacePolicy(room, conversation), repoRoot));
}

export const ROLES: Readonly<Record<string, () => void | Promise<void>>> = {
	racer: () => {
		const act = RACE_ACTS[setting("RACE_ACT")]!;
		fs.writeFileSync(setting("RACE_READY"), "");
		pauseUntilFile(setting("RACE_GO"));
		fs.writeFileSync(setting("RACE_RESULT"), act());
	},
	replacer: () => {
		const target = setting("REPLACE_TARGET");
		for (let turn = 0; !fs.existsSync(setting("REPLACE_STOP")); turn += 1) {
			fs.writeFileSync(`${target}.next`, turn % 2 ? WHOLE_OLD : WHOLE_NEW);
			fs.renameSync(`${target}.next`, target);
			if (turn === 1) fs.writeFileSync(setting("REPLACE_READY"), "");
		}
	},
	"session-opener": async () => {
		const session = await openRoomSession();
		if (session) fs.writeFileSync(setting("OPEN_ANSWER"), JSON.stringify({ file: session.getSessionFile(), opened: session.getCwd() }));
	},
	"session-maker": async () => {
		const session = await openRoomSession();
		if (!session) return;
		const { SessionManager } = await import("@exxeta/exxperts-runtime");
		const { ROOM_SESSION_HEADER } = await import("../src/persistent-agent-conversation-model.js");
		const file = session.getSessionFile()!;
		const made = setting("MAKE") === "branch" ? session.createBranchedSession(session.getLeafId()!) : SessionManager.forkFrom(file, session.getCwd(), path.dirname(file), ROOM_SESSION_HEADER).getSessionFile();
		fs.writeFileSync(setting("OPEN_ANSWER"), JSON.stringify({ file: made }));
	},
	"workspace-chooser": async () => {
		const policy = await import("../src/persistent-room-workspace-policy.js");
		policy.writePersistentRoomDefaultCapabilityPolicy(policy.createPersistentRoomDefaultCapabilityPolicy({ agentId: setting("OPEN_ROOM"), repoRoot, root: setting("CHOSEN"), workspaceAccessMode: "localFiles", source: "manual" }));
	},
	"room-settler": async () => {
		const { SessionManager } = await import("@exxeta/exxperts-runtime");
		const opened: unknown[] = [];
		const open = SessionManager.open.bind(SessionManager);
		SessionManager.open = (...args: Parameters<typeof open>) => {
			opened.push(args[2]);
			return open(...args);
		};
		const { settleRoom } = await import("../src/room-settle.js");
		const agents = await import("../src/persistent-agents.js");
		settleRoom(setting("OPEN_ROOM"));
		fs.writeFileSync(setting("OPEN_ANSWER"), JSON.stringify({ opened, active: agents.getPersistentAgentRuntimeState(setting("OPEN_ROOM")).activeThreadId }));
	},
	"lock-holder": () => {
		if (roomLock().tryAcquire("room", scheduledRun("holder")).ok) fs.writeFileSync(setting("LOCK_HELD"), "");
		pauseUntilFile(`${setting("LOCK_HELD")}.never`);
	},
};

/** A process a row started runs its role and ends; anything else goes on. */
export async function runRoleIfAsked(): Promise<void> {
	const role = process.env.FOLDER_CONTRACT_ROLE;
	if (!role) return;
	await ROLES[role]!();
	process.exit(0);
}

// --- A smoke's run ---------------------------------------------------------------

export async function rowProblems(id: string, folder: string): Promise<string[]> {
	const held = FOLDER_CONTRACT.find((promise) => promise.id === id)?.heldBy;
	assert.ok(typeof held === "function", `the contract has no row named ${id}`);
	try {
		return await held(folder);
	} catch (error) {
		return [`the row could not finish: ${(error as Error).message}`];
	}
}

export interface ContractRun {
	/** FOLDER_CONTRACT_ONLY=<part of a name> runs the rows and faults whose name holds it. */
	wanted(name: string): boolean;
	/** A new empty folder on the disk under test. */
	freshFolder(): string;
	report(name: string, problems: readonly string[], started: number): void;
}

/** Runs a smoke's rows on the folder under test, then ends the process: with 1 if any row found a problem. */
export async function runContractSmoke(title: string, work: (run: ContractRun) => Promise<void>): Promise<never> {
	const underTest = path.resolve(process.env.FOLDER_CONTRACT_DIR ?? os.tmpdir());
	// The kill harness makes its folders in the system's temporary folder, so the rows that use it run on the disk under test too.
	process.env.TMPDIR = underTest;
	const scratch = fs.mkdtempSync(path.join(underTest, "folder-contract-"));
	const only = process.env.FOLDER_CONTRACT_ONLY;
	let rowNumber = 0;
	const found: string[] = [];
	const run: ContractRun = {
		wanted: (name) => !only || name.includes(only),
		freshFolder: () => {
			const folder = path.join(scratch, `row-${(rowNumber += 1)}`);
			fs.mkdirSync(folder);
			return folder;
		},
		report: (name, problems, started) => {
			console.log(`  ${problems.length ? "FAILED" : "ok"}  ${name} (${((Date.now() - started) / 1000).toFixed(1)}s)`);
			for (const problem of problems) console.log(`        ${problem}`);
			found.push(...problems.map((problem) => `${name}: ${problem}`));
		},
	};
	const cleanUp = () => {
		killStartedRoles();
		fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 5 });
	};
	for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as NodeJS.Signals[]) {
		process.on(signal, () => {
			cleanUp();
			process.exit(1);
		});
	}
	let exitCode = 0;
	try {
		console.log(`${title} on ${underTest}`);
		await work(run);
		console.log(`${title}: ${found.length} problems`);
		if (found.length) exitCode = 1;
	} catch (error) {
		console.error(error);
		exitCode = 1;
	} finally {
		try {
			await closeRealRoom();
		} finally {
			cleanUp();
		}
	}
	process.exit(exitCode);
}
