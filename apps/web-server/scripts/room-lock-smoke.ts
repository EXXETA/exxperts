// A room's lock is whole at every moment, and only one side ever wins it. Real
// processes race over the real module: a reader against a heartbeat, a racer held
// between two steps while another takes the room, many racers at once. A kill at
// every step of making, refreshing, taking over and giving back the lock in a
// small process, and at each step of a turn's lock in a real server on both
// editions, is followed by the next start. A planted link or rename failure still
// leaves no temporary file. A holder that is gone shows no lock to the next server,
// at once, on both editions, also under the same pid; a live holder keeps its lock.
// RESTART_ONLY=<part of a row's name> runs some.
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os, { hostname } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { AGENT, answerIsHeld, AT_ONCE_MS, EDITIONS, endChild, exited, firstTurnProblems, lanes, pool, preload, readJsonAnswer, releaseAnswer, roomProblems, roomUrl, runRestartParts, runStep, sendTurn, startServer, tempRoot, templateCopy, THREAD, traceSave, waitReady, wanted, webServerDir, type Child, type Run, type Save, type TraceStep } from "./kill-at-write-harness.js";
import { freePort, SMOKE_AUTH_HEADERS } from "./smoke-server-process.js";
import { waitEvery } from "./smoke-wait.js";

if (os.platform() === "win32") {
	console.log("SKIPPED: not yet on a real Windows PC: it ran past 300 seconds there");
	process.exit(0);
}

const WebSocketImpl: any = (await import("ws")).default;
type RoomSocket = { on(event: string, listener: (...args: any[]) => void): void; send(data: string): void; close(): void };
const LOCK_MODULE = path.resolve(webServerDir, "..", "..", "bin", "lib", "room-lock.cjs");
type Owner = { surface: string; lockId?: string; connectionId?: string; pid?: number };
const roomLock = createRequire(import.meta.url)(LOCK_MODULE) as {
	tryAcquire(agentId: string, owner: Owner): { ok: boolean; heldBy?: { lockId?: string } | null };
	heartbeat(agentId: string, owner: Owner): void;
	release(agentId: string, owner: Owner): void;
	readLock(agentId: string): { lockId?: string; connectionId?: string; lastSeen?: number } | null;
	isActive(lock: unknown): boolean;
};

const waitUntil = waitEvery(5);
const ROOM = "room";
const LOCK_NAME = `${ROOM}.json`;
// The name persistent-room-last-used.ts gives its temporary files: a start that checks the data folder knows a kill's leftover by it.
const LEFTOVER = /\.tmp-\d+-\d+-[a-z0-9]{0,6}$/;
const HEARTBEATS = 20_000;
const RACERS = 8;
const RACE_ROUNDS = 6;

const locksOf = (home: string) => path.join(home, ".exxperts", "app", ".room-locks");
const lockFile = (home: string) => path.join(locksOf(home), LOCK_NAME);
const takingFile = (home: string) => `${lockFile(home)}.taking-0`;
const namesIn = (home: string) => fs.readdirSync(locksOf(home)).sort();
const lockRecord = (home: string) => JSON.parse(fs.readFileSync(lockFile(home), "utf-8"));

function freshHome(name: string): string {
	const home = fs.mkdtempSync(path.join(tempRoot, `${name}-`));
	fs.mkdirSync(locksOf(home), { recursive: true });
	return home;
}

/** A lock nobody refreshes any more: its time is long past, whoever wrote it. */
function plantStale(home: string): void {
	fs.writeFileSync(lockFile(home), JSON.stringify({ surface: "scheduler", lockId: "gone", pid: process.pid, acquiredAt: 1, lastSeen: 1 }));
}

/** Runs the module in this process on one home; the module reads where its locks live at each call. */
function inHome<T>(home: string, work: () => T): T {
	const before = process.env.EXXPERTS_STATE_HOME;
	process.env.EXXPERTS_STATE_HOME = home;
	try {
		return work();
	} finally {
		if (before === undefined) delete process.env.EXXPERTS_STATE_HOME;
		else process.env.EXXPERTS_STATE_HOME = before;
	}
}

/** Replaces one `fs` call for the length of `work`, as a disk that refuses it does. */
function withRefused<T>(name: "linkSync" | "renameSync", code: string, work: (refusals: () => number) => T): T {
	const real = fs[name];
	let refusals = 0;
	(fs as Record<string, unknown>)[name] = () => {
		refusals += 1;
		throw Object.assign(new Error(`${code}: planted`), { code });
	};
	try {
		return work(() => refusals);
	} finally {
		(fs as Record<string, unknown>)[name] = real;
	}
}

// One process wanting the room. It stops before the first of HOLD_AT's fs calls,
// and after each of HOLD_AFTER's calls on the lock (or on HOLD_ON's name) in turn;
// stop n marks HELD-n and goes on once GO-n exists. It names this smoke as the owner's pid, so a
// winner that has ended still counts as alive for the racer after it.
const RACER = `
const fs = require("node:fs");
const lock = require(process.env.ROOM_LOCK);
const waitFor = (file) => { while (!fs.existsSync(file)) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1); };
let stops = 0;
const stop = () => {
	stops += 1;
	fs.writeFileSync(process.env.HELD + "-" + stops, "");
	waitFor(process.env.GO + "-" + stops);
};
let before = (process.env.HOLD_AT || "").split(",").filter(Boolean);
for (const name of [...before]) {
	const real = fs[name];
	fs[name] = function (...args) {
		if (before.length > 0) {
			before = [];
			stop();
		}
		return real.apply(fs, args);
	};
}
const after = (process.env.HOLD_AFTER || "").split(",").filter(Boolean);
for (const name of new Set(after)) {
	const real = fs[name];
	fs[name] = function (...args) {
		const result = real.apply(fs, args);
		if (after[0] === name && args.some((arg) => String(arg).includes(process.env.HOLD_ON || "room.json"))) {
			after.shift();
			stop();
		}
		return result;
	};
}
if (process.env.START) {
	fs.writeFileSync(process.env.READY, "");
	waitFor(process.env.START);
}
console.log(lock.tryAcquire("room", { surface: process.env.SURFACE || "scheduler", lockId: process.env.RACER, connectionId: process.env.RACER, pid: Number(process.env.LIVE_PID) }).ok);
`;

function racer(home: string, name: string, env: Record<string, string> = {}): Promise<boolean> {
	const child = spawn(process.execPath, ["-e", RACER], { stdio: ["ignore", "pipe", "inherit"], env: { ...process.env, EXXPERTS_STATE_HOME: home, ROOM_LOCK: LOCK_MODULE, RACER: name, LIVE_PID: String(process.pid), ...env } });
	let printed = "";
	child.stdout.on("data", (chunk) => { printed += String(chunk); });
	return new Promise((resolve) => child.on("close", () => resolve(printed.trim() === "true")));
}

function oneWinnerProblems(title: string, home: string, outcomes: Record<string, boolean>): string[] {
	const winners = Object.keys(outcomes).filter((name) => outcomes[name]);
	if (winners.length !== 1) return [`${title}: ${winners.length} racers won (${winners.join(", ")})`];
	const holder = lockRecord(home).lockId;
	return [
		...(holder === winners[0] ? [] : [`${title}: ${winners[0]} won, but the lock names ${holder}`]),
		...(namesIn(home).join() === LOCK_NAME ? [] : [`${title}: the folder holds ${namesIn(home).join(", ")}`]),
	];
}

/** A racer that stops as `hold` says, with what the row needs to wait on it and let it go. */
function heldRacer(home: string, hold: Record<string, string>, name = "first") {
	const held = path.join(home, `${name}-held`);
	const go = path.join(home, `${name}-go`);
	let ended = false;
	const outcome = racer(home, name, { ...hold, HELD: held, GO: go }).finally(() => { ended = true; });
	return {
		outcome,
		/** Waits for stop `n`; false when the racer ended without coming to it. */
		stopped: async (n: number) => {
			await waitUntil(() => fs.existsSync(`${held}-${n}`) || ended, `the held racer came to stop ${n} or ended`);
			return fs.existsSync(`${held}-${n}`);
		},
		letGo: (n: number) => fs.writeFileSync(`${go}-${n}`, ""),
	};
}

/** The first racer stops as `hold` says while a second one runs to its end. */
async function heldRacerRow(title: string, hold: Record<string, string>, plant?: (home: string) => void): Promise<string[]> {
	const home = freshHome("held");
	plant?.(home);
	const first = heldRacer(home, hold);
	if (!await first.stopped(1)) return [`${title}: the first racer never stopped at ${JSON.stringify(hold)}, so this row proves nothing`];
	const second = await racer(home, "second");
	first.letGo(1);
	return oneWinnerProblems(title, home, { first: await first.outcome, second });
}

/** A slow racer judged a lock stale, a quick owner took the room and gives it back: the room is free afterwards. */
async function releaseDuringTakeoverRow(): Promise<string[]> {
	const home = freshHome("release");
	plantStale(home);
	const slow = heldRacer(home, { HOLD_AFTER: "readFileSync,renameSync" });
	if (!await slow.stopped(1)) return ["the slow racer never read the stale lock, so this row proves nothing"];
	const quick = { surface: "scheduler", lockId: "quick", pid: process.pid };
	if (!inHome(home, () => roomLock.tryAcquire(ROOM, quick)).ok) return ["the quick owner never got the room"];
	slow.letGo(1);
	await slow.stopped(2);
	inHome(home, () => roomLock.release(ROOM, quick));
	slow.letGo(2);
	const problems = await slow.outcome ? ["the slow racer won a room the quick owner held"] : [];
	const next = inHome(home, () => roomLock.tryAcquire(ROOM, { surface: "scheduler", lockId: "next", pid: process.pid }));
	return next.ok ? problems : [...problems, `the room stayed locked after its owner gave it back, by ${JSON.stringify(next.heldBy)}`];
}

async function manyRacersRow(): Promise<string[]> {
	const problems: string[] = [];
	for (let round = 1; round <= RACE_ROUNDS; round += 1) {
		const home = freshHome("many");
		const start = path.join(home, "start");
		const names = Array.from({ length: RACERS }, (_, at) => `racer-${at}`);
		const readyFiles = names.map((name) => path.join(home, `${name}-ready`));
		const racing = names.map((name, at) => racer(home, name, { START: start, READY: readyFiles[at]! }));
		await waitUntil(() => readyFiles.every((file) => fs.existsSync(file)), "the racers stood ready");
		fs.writeFileSync(start, "");
		const results = await Promise.all(racing);
		problems.push(...oneWinnerProblems(`round ${round}`, home, Object.fromEntries(names.map((name, at) => [name, results[at]!]))));
	}
	return problems;
}

/** A kill left a takeover's lock. One racer judges it gone and stops; another passes it and stops just before it lands. The first one's old judgement must not open the way to a second winner. */
async function leftTakeoverRow(): Promise<string[]> {
	const home = freshHome("left-takeover");
	plantStale(home);
	fs.writeFileSync(takingFile(home), JSON.stringify({ surface: "scheduler", host: hostname(), pid: spawnSync(process.execPath, ["-e", ""]).pid, lastSeen: Date.now() }));
	const first = heldRacer(home, { HOLD_AFTER: "readFileSync", HOLD_ON: ".taking" });
	if (!await first.stopped(1)) return ["the first racer never read the left takeover, so this row proves nothing"];
	const second = heldRacer(home, { HOLD_AT: "renameSync" }, "second");
	if (!await second.stopped(1)) return ["the second racer never came to its takeover, so this row proves nothing"];
	first.letGo(1);
	const firstWon = await first.outcome;
	second.letGo(1);
	return oneWinnerProblems("a left takeover", home, { first: firstWon, second: await second.outcome });
}

/** What a takeover's own lock does: a live holder's stands, one that cannot be at work any more stops nobody, and the winner removes it. */
async function takingLockRows(): Promise<string[]> {
	const problems: string[] = [];
	const planted = (record: Record<string, unknown>) => {
		const home = freshHome("taking");
		plantStale(home);
		fs.writeFileSync(takingFile(home), JSON.stringify({ surface: "scheduler", host: hostname(), ...record }));
		return home;
	};
	const live = planted({ pid: process.pid, lastSeen: Date.now() });
	if (await racer(live, "racer")) problems.push("a racer took the lock past another process's live takeover");
	if (!fs.existsSync(takingFile(live))) problems.push("a racer dropped another process's live takeover");
	const old = planted({ pid: process.pid, lastSeen: 1 });
	if (!await racer(old, "racer")) problems.push("a takeover nobody finished stopped the room past its time");
	const own = planted({ pid: process.pid, lastSeen: Date.now() });
	if (!inHome(own, () => roomLock.tryAcquire(ROOM, { surface: "scheduler", lockId: "next", pid: process.pid })).ok) problems.push("a takeover left under this process's own pid stopped the room");
	return [...problems, ...[old, own].flatMap((home) => (namesIn(home).join() === LOCK_NAME ? [] : [`the folder holds ${namesIn(home).join(", ")}`]))];
}

/** A holder's heartbeats and a reader, in two processes, started together: every read finds the holder's whole lock. */
async function readerRow(): Promise<string[]> {
	const home = freshHome("reader");
	const go = path.join(home, "go");
	const done = path.join(home, "done");
	const owner = { surface: "scheduler", lockId: "holder", pid: process.pid };
	if (!inHome(home, () => roomLock.tryAcquire(ROOM, owner)).ok) return ["the holder never got the lock"];
	const started = (name: string) => path.join(home, `${name}-ready`);
	const common = `const fs = require("node:fs"); const lock = require(process.env.ROOM_LOCK);
		fs.writeFileSync(process.env.READY, "");
		while (!fs.existsSync(process.env.GO)) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1);`;
	const holderCode = `${common}
		const owner = ${JSON.stringify(owner)};
		for (let beat = 0; beat < ${HEARTBEATS}; beat += 1) lock.heartbeat("room", owner);
		fs.writeFileSync(process.env.DONE, "");`;
	const readerCode = `${common}
		let reads = 0, broken = 0;
		while (!fs.existsSync(process.env.DONE)) {
			const seen = lock.readLock("room");
			reads += 1;
			if (!seen || !lock.isActive(seen) || seen.lockId !== "holder") broken += 1;
		}
		console.log(JSON.stringify({ reads, broken }));`;
	const run = (name: string, code: string) => {
		const child = spawn(process.execPath, ["-e", code], { stdio: ["ignore", "pipe", "inherit"], env: { ...process.env, EXXPERTS_STATE_HOME: home, ROOM_LOCK: LOCK_MODULE, READY: started(name), GO: go, DONE: done } });
		let printed = "";
		child.stdout.on("data", (chunk) => { printed += String(chunk); });
		return new Promise<string>((resolve) => child.on("close", () => resolve(printed)));
	};
	const holder = run("holder", holderCode);
	const reader = run("reader", readerCode);
	await waitUntil(() => fs.existsSync(started("holder")) && fs.existsSync(started("reader")), "both processes stood ready");
	fs.writeFileSync(go, "");
	await holder;
	const { reads, broken } = JSON.parse(await reader) as { reads: number; broken: number };
	console.log(`  ${reads} reads against ${HEARTBEATS} heartbeats, ${broken} broken`);
	return [
		...(reads > 1_000 ? [] : [`only ${reads} reads came, so this row proves nothing`]),
		...(broken === 0 ? [] : [`${broken} of ${reads} reads found no whole lock of the holder's`]),
		...(lockRecord(home).lockId === "holder" ? [] : ["the holder's lock did not survive its heartbeats"]),
		...(namesIn(home).join() === LOCK_NAME ? [] : [`the folder holds ${namesIn(home).join(", ")}`]),
	];
}

const KILLED_WORK = `const lock = require(process.env.ROOM_LOCK);
	const owner = { surface: "scheduler", lockId: "killed" };
	if (!lock.tryAcquire("room", owner).ok) process.exit(3);
	lock.heartbeat("room", owner);
	if (!lock.tryAcquire("room", owner).ok) process.exit(3);
	lock.release("room", owner);`;

function killedWork(home: string, env: Record<string, string>) {
	return spawnSync(process.execPath, ["--import", preload, "-e", KILLED_WORK], { encoding: "utf-8", env: { ...process.env, EXXPERTS_STATE_HOME: home, ROOM_LOCK: LOCK_MODULE, KILL_ROOT: locksOf(home), KILL_ARM: path.join(home, "armed"), ...env } });
}

/** What a kill may leave: at most the lock and a takeover's lock, whole, beside them only names a start knows, and a file with two names only as one final name and its temporary ones. */
function leftProblems(home: string, lockName = LOCK_NAME): string[] {
	const known = (name: string) => name === lockName || (name.startsWith(`${lockName}.taking-`) && /^\d+$/.test(name.slice(lockName.length + ".taking-".length)));
	const problems = namesIn(home).filter((name) => !known(name.replace(LEFTOVER, ""))).map((name) => `the kill left ${name}, which no start knows as a leftover`);
	const twoNamed = new Map<number, string[]>();
	for (const name of namesIn(home)) {
		const stat = fs.statSync(path.join(locksOf(home), name));
		if (stat.nlink > 1) twoNamed.set(stat.ino, [...(twoNamed.get(stat.ino) ?? []), name]);
	}
	for (const names of twoNamed.values()) {
		const notTemporary = names.filter((name) => !LEFTOVER.test(name));
		if (notTemporary.length !== 1 || names.some((name) => name.replace(LEFTOVER, "") !== notTemporary[0])) problems.push(`the kill left one file named ${names.join(", ")}, which a start refuses`);
	}
	const file = path.join(locksOf(home), lockName);
	if (!fs.existsSync(file)) return problems;
	try {
		if (typeof JSON.parse(fs.readFileSync(file, "utf-8")).surface !== "string") problems.push("the kill left a lock with no owner");
	} catch {
		problems.push("the kill left a lock that is not whole");
	}
	return problems;
}

/** A kill at every step of the work and every way a step can die, then the next start takes the room. */
function killRows(title: string, plant?: (home: string) => void): string[] {
	const prepared = () => {
		const home = freshHome("kill");
		plant?.(home);
		fs.writeFileSync(path.join(home, "armed"), "");
		return home;
	};
	const traced = prepared();
	const trace = path.join(traced, "trace.jsonl");
	const run = killedWork(traced, { KILL_STEP: "0", KILL_TRACE: trace });
	if (run.status !== 0) return [`${title}: the work failed before any kill: ${run.status} ${run.stderr}`];
	const steps = fs.readFileSync(trace, "utf-8").trim().split("\n").map((line) => JSON.parse(line) as TraceStep).filter((step) => step.op !== "fsyncSync");
	const problems: string[] = [];
	let kills = 0;
	let twoNames = 0;
	for (const step of steps) {
		for (const how of step.bytes ? ["before", "after", "torn-empty", "torn-half"] : ["before", "after"]) {
			const home = prepared();
			const killed = killedWork(home, { KILL_STEP: String(step.step), KILL_HOW: how });
			const place = `${title} k=${step.step} ${how} [${step.op} ${path.basename(step.target)}]`;
			// A link refused because the lock is there throws, so it has no "after" to die at, and the work runs to its end.
			if (how === "after" && step.op === "linkSync" && killed.status === 0) continue;
			// Windows ends a process with exit code 1 and names no signal.
			if (killed.signal !== "SIGKILL" && !(process.platform === "win32" && killed.status === 1)) {
				problems.push(`${place}: the kill never came`);
				continue;
			}
			kills += 1;
			if (namesIn(home).some((name) => fs.statSync(path.join(locksOf(home), name)).nlink === 2)) twoNames += 1;
			problems.push(...leftProblems(home).map((problem) => `${place}: ${problem}`));
			const next = inHome(home, () => roomLock.tryAcquire(ROOM, { surface: "scheduler", lockId: "next", pid: process.pid }));
			if (!next.ok) problems.push(`${place}: the next start was refused, held by ${JSON.stringify(next.heldBy)}`);
			else if (lockRecord(home).lockId !== "next") problems.push(`${place}: the next start won, but the lock names ${lockRecord(home).lockId}`);
		}
	}
	console.log(`  ${title}: ${kills} kills over ${steps.length} steps, ${twoNames} left a file with two names`);
	return twoNames > 0 ? problems : [`${title}: no kill left a file with two names, so nothing here proves that case`, ...problems];
}

const noTemporary = (place: string, home: string) => (namesIn(home).some((name) => LEFTOVER.test(name)) ? [`${place}: a temporary file stayed: ${namesIn(home).join(", ")}`] : []);

/** A disk with no hard links: the room still opens, exclusively, and nothing is left beside the lock. */
function linkFailureRows(): string[] {
	const problems: string[] = [];
	for (const code of ["EPERM", "ENOTSUP", "ENOSYS"]) {
		const home = freshHome("no-links");
		withRefused("linkSync", code, (refusals) => inHome(home, () => {
			const first = roomLock.tryAcquire(ROOM, { surface: "scheduler", lockId: "first", pid: process.pid });
			if (refusals() === 0) problems.push(`${code}: no link was tried, so the planted failure proves nothing`);
			if (!first.ok) problems.push(`${code}: the room did not open`);
			else if (lockRecord(home).lockId !== "first") problems.push(`${code}: the lock names ${lockRecord(home).lockId}`);
			problems.push(...noTemporary(code, home));
			const second = roomLock.tryAcquire(ROOM, { surface: "scheduler", lockId: "second", pid: process.pid });
			if (second.ok) problems.push(`${code}: a second owner took a held room`);
			else if (second.heldBy?.lockId !== "first") problems.push(`${code}: the refusal names ${JSON.stringify(second.heldBy)}`);
			problems.push(...noTemporary(`${code}, refused`, home));
		}));
	}
	// A disk that refuses the fallback's create too: no claim, and still nothing left.
	const home = freshHome("no-create");
	const realOpen = fs.openSync;
	fs.openSync = (() => { throw Object.assign(new Error("EACCES: planted"), { code: "EACCES" }); }) as typeof fs.openSync;
	try {
		withRefused("linkSync", "EPERM", () => inHome(home, () => {
			if (roomLock.tryAcquire(ROOM, { surface: "scheduler", lockId: "first", pid: process.pid }).ok) problems.push("a room opened on a disk that refused every create");
		}));
	} finally {
		fs.openSync = realOpen;
	}
	problems.push(...noTemporary("refused create", home));
	return problems;
}

/** A rename that fails: an owner's own lock stays its own, a takeover claims nothing, and the temporary file goes either way. */
function renameFailureRows(): string[] {
	const problems: string[] = [];
	const home = freshHome("no-rename");
	const owner = { surface: "web", connectionId: "first", pid: process.pid };
	inHome(home, () => roomLock.tryAcquire(ROOM, owner));
	const before = fs.readFileSync(lockFile(home), "utf-8");
	withRefused("renameSync", "EPERM", (refusals) => inHome(home, () => {
		roomLock.heartbeat(ROOM, owner);
		if (refusals() === 0) problems.push("the heartbeat tried no rename, so the planted failure proves nothing");
		problems.push(...noTemporary("heartbeat", home));
		if (!roomLock.tryAcquire(ROOM, owner).ok) problems.push("an owner's own refresh was refused");
		problems.push(...noTemporary("refresh", home));
		if (roomLock.tryAcquire(ROOM, { surface: "web", connectionId: "second", pid: process.pid }).ok) problems.push("a takeover that landed nothing claimed the lock");
		problems.push(...noTemporary("takeover", home));
	}));
	if (fs.readFileSync(lockFile(home), "utf-8") !== before) problems.push("the lock changed though no rename landed");
	const taken = inHome(home, () => roomLock.tryAcquire(ROOM, { surface: "web", connectionId: "second", pid: process.pid }));
	if (!taken.ok || lockRecord(home).connectionId !== "second") problems.push("a takeover on a working disk did not land");
	return problems;
}

/** A real server killed at each step of its room's lock, and the first turn after the restart. */
async function serverKillRows(turn: Save, edition: (typeof EDITIONS)[number]): Promise<string[]> {
	const row: Save = { ...turn, kills: undefined, sharedServer: edition.sharedServer };
	const steps = (await traceSave(row)).filter((step) => step.op !== "fsyncSync" && step.target.includes(".room-locks"));
	if (!steps.some((step) => step.op === "linkSync")) return [`${edition.name}: the lock did not land by a link`];
	const jobs = steps.flatMap((step) => (step.bytes ? ["before", "after", "torn-empty", "torn-half"] : ["before", "after"]).map((how) => ({ step, how })));
	const problems: string[] = [];
	await pool(jobs, lanes, async ({ step, how }, lane) => {
		const place = `${edition.name} k=${step.step} ${how} [${step.op} ${path.basename(step.target)}]`;
		let tookMs = 0;
		const result = await runStep({
			...row,
			alwaysAgain: true,
			send: async (run) => {
				const started = Date.now();
				const answer = await turn.send(run);
				tookMs = Date.now() - started;
				return answer;
			},
			afterKill: (home) => (fs.existsSync(locksOf(home)) ? leftProblems(home, `${AGENT}.json`) : []),
			afterRestart: roomProblems,
			afterRetry: async (run, answer) => [...(answer.status < 300 ? [] : [`the first turn failed: ${answer.status}`]), ...(tookMs < AT_ONCE_MS ? [] : [`the first turn took ${tookMs} ms`]), ...await roomProblems(run)],
		}, step.step, how, lane);
		if (!result.landed) problems.push(`${place}: the kill never came`);
		problems.push(...result.problems.map((problem) => `${place}: ${problem}`));
	});
	console.log(`  ${edition.name}: ${jobs.length} kills`);
	return problems;
}

/** What the lock says about a holder, on records real processes wrote or a holder of each kind would leave. */
async function holderJudgementRows(): Promise<string[]> {
	const problems: string[] = [];
	const gonePid = spawnSync(process.execPath, ["-e", ""]).pid;
	const now = Date.now();
	for (const surface of ["web", "scheduler"]) {
		const judged = (what: string, record: unknown, active: boolean) => {
			if (roomLock.isActive(record) !== active) problems.push(`${surface}: ${what} reads as ${active ? "gone" : "active"}`);
		};
		const here = { surface, host: hostname(), lastSeen: now };
		judged("a holder whose process ended", { ...here, pid: gonePid }, false);
		judged("a live process's holder", { ...here, pid: process.pid }, true);
		judged("a holder with no pid", here, true);
		judged("a holder past its time", { ...here, pid: process.pid, lastSeen: 1 }, false);
		judged("a holder on another computer", { ...here, host: "another-computer", pid: gonePid }, true);
		judged("a holder on another computer past its time", { ...here, host: "another-computer", pid: gonePid, lastSeen: 1 }, false);
		// A process that ended with this process's pid: the pid says nothing, as in a container after a restart.
		const home = freshHome("earlier-life");
		if (!await racer(home, "earlier", { SURFACE: surface })) problems.push(`${surface}: the earlier process never took the room`);
		judged("an earlier process under this pid", lockRecord(home), false);
		const own = freshHome("own-life");
		const owner = { surface, connectionId: "own", lockId: "own", pid: process.pid };
		inHome(own, () => {
			roomLock.tryAcquire(ROOM, owner);
			roomLock.heartbeat(ROOM, owner);
		});
		judged("this process's own holder", lockRecord(own), true);
	}
	return problems;
}

// Loaded first by a row's server. HOLD_AS_SCHEDULED_RUN takes the room as a
// scheduled run does, inside the server. NEXT_LIFE_ASK lets a row replace the
// server with the next one under the same pid, as a container's restart does: no
// close handler runs, and the lock stays behind with its pid and a fresh time.
const SERVER_ROW_PRELOAD = `
import fs from "node:fs";
import { createRequire } from "node:module";
const lock = createRequire(process.env.ROOM_LOCK)(process.env.ROOM_LOCK);
if (process.env.HOLD_AS_SCHEDULED_RUN && !process.env.IN_NEXT_LIFE) lock.tryAcquire(process.env.HOLD_AS_SCHEDULED_RUN, { surface: "scheduler", pid: process.pid, lockId: "live-run", runId: "live-run" });
if (process.env.NEXT_LIFE_ASK) setInterval(() => {
	if (!fs.existsSync(process.env.NEXT_LIFE_ASK)) return;
	fs.rmSync(process.env.NEXT_LIFE_ASK);
	process.execve(process.execPath, [process.execPath, ...process.execArgv, ...process.argv.slice(1)], { ...process.env, IN_NEXT_LIFE: "1" });
}, 20).unref();
`;

type Edition = (typeof EDITIONS)[number];
type DataFolder = { run: Run; folder: string; start(): Promise<Child>; startBeside(): Promise<Run> };

/** A fresh data folder on one edition, with how to start its server and a second one beside it. */
async function onDataFolder(edition: Edition, env: Record<string, string>, work: (data: DataFolder) => Promise<string[]>): Promise<string[]> {
	const folder = templateCopy("holder");
	const home = path.join(folder, "home");
	const rowPreload = path.join(folder, "server-row-preload.mjs");
	fs.writeFileSync(rowPreload, SERVER_ROW_PRELOAD);
	const port = await freePort();
	const run: Run = { home, base: `http://127.0.0.1:${port}` };
	const children: Child[] = [];
	const startOn = async (at: Run, atPort: number) => {
		const child = startServer({ sharedServer: edition.sharedServer, imports: [pathToFileURL(rowPreload).href], env: { ROOM_LOCK: LOCK_MODULE, ...env } }, home, atPort);
		children.push(child);
		await waitReady(child, at);
		return child;
	};
	try {
		return await work({
			run,
			folder,
			start: () => startOn(run, port),
			startBeside: async () => {
				const besidePort = await freePort();
				const beside: Run = { home, base: `http://127.0.0.1:${besidePort}` };
				await startOn(beside, besidePort);
				return beside;
			},
		});
	} finally {
		for (const child of children) await endChild(child);
	}
}

/** A connection to the room, as a window holds it, once it stands ready; refused with the server's words when it never does. */
function openRoom(run: Run): Promise<RoomSocket> {
	return new Promise((resolve, reject) => {
		const socket: RoomSocket = new WebSocketImpl(`${run.base.replace("http", "ws")}/ws?persistentAgentId=${AGENT}&conversationId=${THREAD}`, { headers: { ...SMOKE_AUTH_HEADERS } });
		socket.on("error", reject);
		socket.on("close", () => reject(new Error("the connection closed before it stood ready")));
		socket.on("message", (data: unknown) => {
			const frame = JSON.parse(String(data));
			if (frame.type === "ready") resolve(socket);
			if (frame.type === "error") reject(new Error(frame.message));
		});
	});
}

/** What the room card reads: the rooms list's row. */
async function roomCard(run: Run): Promise<{ activeLock: { surface: string } | null; answeringDetached: boolean }> {
	const list = await readJsonAnswer(`${run.base}/api/persistent-agents`);
	return (list.body as Array<{ id: string; activeLock: { surface: string } | null; answeringDetached: boolean }>).find((room) => room.id === AGENT)!;
}

const lockOf = (home: string) => path.join(locksOf(home), `${AGENT}.json`);

/** A window with a turn the fake model holds. A conversation's first request ends on a context message, so one finished turn comes first. */
async function cookingWindow(run: Run, hold: string): Promise<RoomSocket> {
	if ((await sendTurn(run, "A first question.")).status >= 300) throw new Error("a turn failed before the row began");
	await waitUntil(async () => (await readJsonAnswer(roomUrl(run, "/status"))).body?.activeThread?.inFlight === false, "the first turn ended");
	const window = await openRoom(run);
	window.send(JSON.stringify({ type: "prompt", text: `Please ${hold} now.`, id: `held_${hold}`, shown: `Please ${hold} now.` }));
	await waitUntil(() => answerIsHeld(hold), `the fake model holds ${hold}`);
	return window;
}

const ENDINGS = [
	{ name: "a kill", cooking: false, signal: "SIGKILL" },
	{ name: "a kill with a turn cooking", cooking: true, signal: "SIGKILL" },
	{ name: "a stop", cooking: false, signal: "SIGTERM" },
] as const;

/** A server ends with a room open; the next one on the same data shows the room free at once, and the room opens. */
function goneHolderRow(edition: Edition, ending: (typeof ENDINGS)[number]): Promise<string[]> {
	return onDataFolder(edition, {}, async ({ run, start }) => {
		const first = await start();
		const window = ending.cooking ? await cookingWindow(run, `hold-answer-gone-${edition.sharedServer ? "shared" : "desktop"}`) : await openRoom(run);
		window.on("error", () => undefined);
		const problems = (await roomCard(run)).activeLock?.surface === "web" ? [] : ["the open room showed no lock, so this row proves nothing"];
		first.process.kill(ending.signal);
		await exited(first);
		if (ending.signal === "SIGKILL" && !fs.existsSync(lockOf(run.home))) problems.push("the kill left no lock, so this row proves nothing");
		await start();
		const card = await roomCard(run);
		if (card.activeLock) problems.push(`the next server shows the room locked by a ${card.activeLock.surface} holder that is gone`);
		return [...problems, ...await firstTurnProblems(run, () => sendTurn(run, "The first question after."))];
	});
}

/** The next server has the pid of the one before it, as in a container: the lock's pid is alive, and it is the next server's own. */
function samePidRow(edition: Edition, surface: "web" | "scheduler"): Promise<string[]> {
	const scheduled: Record<string, string> = surface === "scheduler" ? { HOLD_AS_SCHEDULED_RUN: AGENT } : {};
	const ask = path.join(tempRoot, `next-life-${surface}-${edition.sharedServer ? "shared" : "desktop"}`);
	return onDataFolder(edition, { ...scheduled, NEXT_LIFE_ASK: ask }, async ({ run, start }) => {
		const server = await start();
		const window = surface === "web" ? await openRoom(run) : null;
		window?.on("error", () => undefined);
		const problems = (await roomCard(run)).activeLock?.surface === surface ? [] : ["the held room showed no lock, so this row proves nothing"];
		fs.writeFileSync(ask, "");
		await waitUntil(() => !fs.existsSync(ask), "the server took its next life");
		await waitReady(server, run);
		const left = JSON.parse(fs.readFileSync(lockOf(run.home), "utf-8")) as { pid: number };
		if (left.pid !== server.process.pid) problems.push(`the lock names pid ${left.pid}, not this server's ${server.process.pid}, so this row proves nothing`);
		const card = await roomCard(run);
		if (card.activeLock) problems.push(`the next server under the same pid shows the room locked by a ${card.activeLock.surface} holder that is gone`);
		return [...problems, ...await firstTurnProblems(run, () => sendTurn(run, "The first question after."))];
	});
}

/** An open window: its own server and a live one beside it show the lock; once the holder is killed, the one beside shows it free at once. */
function liveWindowRow(edition: Edition): Promise<string[]> {
	return onDataFolder(edition, {}, async ({ run, start, startBeside }) => {
		const holder = await start();
		const beside = await startBeside();
		(await openRoom(run)).on("error", () => undefined);
		const problems: string[] = [];
		if ((await roomCard(run)).activeLock?.surface !== "web") problems.push("the server holding the window shows no lock");
		if ((await roomCard(beside)).activeLock?.surface !== "web") problems.push("a live server beside it shows no lock");
		holder.process.kill("SIGKILL");
		await exited(holder);
		if ((await roomCard(beside)).activeLock) problems.push("the server beside still shows the lock of a holder that is gone");
		return problems;
	});
}

/** A turn cooking with its window gone keeps the lock, here and on a live server beside it, until it lands. */
function liveCookingRow(edition: Edition): Promise<string[]> {
	return onDataFolder(edition, {}, async ({ run, start, startBeside }) => {
		await start();
		const beside = await startBeside();
		const hold = `hold-answer-live-${edition.sharedServer ? "shared" : "desktop"}`;
		const window = await cookingWindow(run, hold);
		window.close();
		await waitUntil(async () => (await roomCard(run)).answeringDetached, "the turn went on with its window gone");
		const problems: string[] = [];
		if ((await roomCard(run)).activeLock?.surface !== "web") problems.push("a detached turn's server shows no lock");
		if ((await roomCard(beside)).activeLock?.surface !== "web") problems.push("a live server beside a detached turn shows no lock");
		releaseAnswer(hold);
		await waitUntil(async () => (await roomCard(run)).activeLock === null, "the landed turn gave the room back");
		return problems;
	});
}

/** A scheduled run inside the server keeps the room: the card says so, here and beside it, and a window is refused. */
function liveScheduledRunRow(edition: Edition): Promise<string[]> {
	return onDataFolder(edition, { HOLD_AS_SCHEDULED_RUN: AGENT }, async ({ run, start, startBeside }) => {
		await start();
		const beside = await startBeside();
		const problems: string[] = [];
		if ((await roomCard(run)).activeLock?.surface !== "scheduler") problems.push("the server of a live scheduled run shows no lock");
		if ((await roomCard(beside)).activeLock?.surface !== "scheduler") problems.push("a live server beside a scheduled run shows no lock");
		const refusal = await openRoom(run).then(() => "", (error: Error) => error.message);
		if (!refusal.includes("scheduled background task")) problems.push(`a window was not refused for the scheduled run: "${refusal}"`);
		return problems;
	});
}

await runRestartParts("room lock rows", async (part, all) => {
	const turn = all.find((save) => save.name === "turn")!;
	await part("a reader during heartbeats", readerRow);
	await part("a racer between making and filling", () => heldRacerRow("before the lock lands", { HOLD_AT: "writeSync,linkSync" }));
	await part("a racer with its temporary file still there", () => heldRacerRow("after the lock landed", { HOLD_AT: "writeSync,rmSync" }));
	await part("two racers on a stale lock", () => heldRacerRow("a slow racer", { HOLD_AFTER: "readFileSync" }, plantStale));
	await part("a release while a stale lock is taken over", releaseDuringTakeoverRow);
	await part("a takeover's own lock", takingLockRows);
	await part("two racers past a killed takeover", leftTakeoverRow);
	await part("many racers on a free room", manyRacersRow);
	await part("kills on a free room", () => killRows("free room"));
	await part("kills on a stale lock", () => killRows("stale lock", plantStale));
	await part("a planted link failure", linkFailureRows);
	await part("a planted rename failure", renameFailureRows);
	await part("what a holder's record says", holderJudgementRows);
	for (const edition of EDITIONS) {
		for (const ending of ENDINGS) await part(`${ending.name} shows no lock, ${edition.name}`, () => goneHolderRow(edition, ending));
		// Windows and older Node have no process.execve, so no way to start a server under the pid of the one before it. "What a holder's record says" still judges an earlier process under this pid there.
		for (const surface of ["web", "scheduler"] as const) {
			const name = `a ${surface} lock under the same pid, ${edition.name}`;
			if ("execve" in process) await part(name, () => samePidRow(edition, surface));
			else if (wanted(name)) console.log(`${name}: skipped, this Node has no process.execve`);
		}
		await part(`a live window keeps its lock, ${edition.name}`, () => liveWindowRow(edition));
		await part(`a detached turn keeps its lock, ${edition.name}`, () => liveCookingRow(edition));
		await part(`a live scheduled run keeps its lock, ${edition.name}`, () => liveScheduledRunRow(edition));
	}
	for (const edition of EDITIONS) await part(`a killed server, ${edition.name}`, () => serverKillRows(turn, edition));
});
