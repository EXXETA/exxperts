// A kill at any write step of the small stores a shared server keeps beside
// its rooms leaves each one whole: the old value or the new one, read back
// through the store's own reader. The stores: a room's maintenance settings,
// its global-instructions switch, a schedule edit, a run record's update and a
// connector's removal from the connectors' file. None needs a room or a server,
// so a child process runs the store's own function under
// kill-at-write-preload.mjs: traced once, then killed at each step it traces.
//
// Each trace also passes the harness's flush check (each landing rename after
// its file's flush and before its folder's), and with any one of those flushes
// cut from it the check fails. Two connector removals at once both answer and
// leave a whole file; the later one's file can bring back the connector the
// other removed, as each reads the file before either writes. A removal whose
// folder flush fails after the file landed answers removed and gives no room
// its grant back; one whose write fails before it lands, with the file then
// unreadable, answers the failure and gives no grant back either.
//
// Run alone, from apps/web-server: node --import tsx/esm scripts/kill-at-write-stores-smoke.ts
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const THIS_FILE = fileURLToPath(import.meta.url);
const ROOM = "kill-room";
const RUN_ID = `bg_${"0".repeat(32)}`;
const JOB = "kill job";

/** The places each store reads, under one home. */
function placesOf(home: string) {
	const agentDir = path.join(home, ".exxperts", "agent");
	const agentsRoot = path.join(home, ".exxperts", "app", "personalized-agents");
	return { agentDir, agentsRoot, env: { HOME: home, USERPROFILE: home, EXXPERTS_STATE_HOME: home, PI_CODING_AGENT_DIR: agentDir, EXXETA_PERSISTENT_AGENTS_ROOT: agentsRoot } };
}

function useHome(home: string): ReturnType<typeof placesOf> {
	const places = placesOf(home);
	Object.assign(process.env, places.env);
	return places;
}

interface Store {
	name: string;
	/** The file the save replaces. */
	file(home: string): string;
	/** Writes the old value, the way the store itself writes it. */
	prepare(home: string): Promise<void>;
	/** The save, run in the child. */
	save(home: string): Promise<void>;
	/** "old", "new", or what was read instead. */
	read(home: string): Promise<string>;
}

const stores: Store[] = [
	{
		name: "maintenance settings",
		file: (home) => path.join(placesOf(home).agentsRoot, ROOM, "runtime", "maintenance-settings.json"),
		prepare: async (home) => {
			const { writePersistentRoomMaintenanceSettings } = await import("../src/persistent-room-maintenance-settings.js");
			writePersistentRoomMaintenanceSettings(ROOM, { memoryBudgetTokens: 50_000 }, { persistentAgentsRoot: useHome(home).agentsRoot });
		},
		save: async (home) => {
			const { writePersistentRoomMaintenanceSettings } = await import("../src/persistent-room-maintenance-settings.js");
			writePersistentRoomMaintenanceSettings(ROOM, { memoryBudgetTokens: 30_000 }, { persistentAgentsRoot: useHome(home).agentsRoot });
		},
		read: async (home) => {
			const { readPersistentRoomMaintenanceSettings } = await import("../src/persistent-room-maintenance-settings.js");
			const budget = readPersistentRoomMaintenanceSettings(ROOM, { persistentAgentsRoot: useHome(home).agentsRoot }).memoryBudgetTokens;
			return budget === 50_000 ? "old" : budget === 30_000 ? "new" : `a budget of ${budget}`;
		},
	},
	{
		name: "global-instructions switch",
		file: (home) => path.join(placesOf(home).agentsRoot, ROOM, "runtime", "global-instructions.json"),
		prepare: async (home) => {
			const { writePersistentRoomGlobalInstructionsEnabled } = await import("../src/persistent-room-global-instructions-setting.js");
			writePersistentRoomGlobalInstructionsEnabled(ROOM, false, { persistentAgentsRoot: useHome(home).agentsRoot });
		},
		save: async (home) => {
			const { writePersistentRoomGlobalInstructionsEnabled } = await import("../src/persistent-room-global-instructions-setting.js");
			writePersistentRoomGlobalInstructionsEnabled(ROOM, true, { persistentAgentsRoot: useHome(home).agentsRoot });
		},
		read: async (home) => {
			const { readPersistentRoomGlobalInstructionsSetting } = await import("../src/persistent-room-global-instructions-setting.js");
			// No record reads as switched on, as a room that never chose: so a lost "off" shows only here.
			const record = readPersistentRoomGlobalInstructionsSetting(ROOM, { persistentAgentsRoot: useHome(home).agentsRoot });
			return record?.enabled === false ? "old" : record?.enabled === true ? "new" : "no record, so switched on";
		},
	},
	{
		name: "schedule edit",
		file: (home) => path.join(home, ".exxperts", "app", "persistent-room-schedules", ROOM, "schedules.json"),
		prepare: async (home) => {
			const { addPersistentRoomScheduleJob } = await import("../../../pi-package/extensions/schedule-prompt/index.js");
			useHome(home);
			addPersistentRoomScheduleJob(ROOM, { name: JOB, type: "interval", schedule: "1h", prompt: "the old prompt" });
		},
		save: async (home) => {
			const { updatePersistentRoomScheduleJob } = await import("../../../pi-package/extensions/schedule-prompt/index.js");
			useHome(home);
			updatePersistentRoomScheduleJob(ROOM, { name: JOB }, { prompt: "the new prompt" });
		},
		read: async (home) => {
			const { readPersistentRoomScheduleStore } = await import("../../../pi-package/extensions/schedule-prompt/index.js");
			useHome(home);
			try {
				const prompt = readPersistentRoomScheduleStore(ROOM).jobs.find((job) => job.name === JOB)?.prompt;
				return prompt === "the old prompt" ? "old" : prompt === "the new prompt" ? "new" : `the prompt ${prompt}`;
			} catch (error) {
				return `a refusal: ${(error as Error).message}`;
			}
		},
	},
	{
		name: "run record update",
		file: (home) => path.join(home, ".exxperts", "app", "background-runs", "runs", RUN_ID, "run.json"),
		prepare: async (home) => {
			const { createBackgroundRun } = await import("../src/background-runs.js");
			useHome(home);
			createBackgroundRun({ runId: RUN_ID, kind: "scheduled-prompt", scope: { kind: "persistent-room", roomId: ROOM }, source: { trigger: "manual" }, status: "queued" });
		},
		save: async (home) => {
			const { updateBackgroundRunStatus } = await import("../src/background-runs.js");
			useHome(home);
			updateBackgroundRunStatus(RUN_ID, "running");
		},
		read: async (home) => {
			const { readBackgroundRun } = await import("../src/background-runs.js");
			useHome(home);
			try {
				const status = readBackgroundRun(RUN_ID).status;
				return status === "queued" ? "old" : status === "running" ? "new" : `the status ${status}`;
			} catch (error) {
				return `a refusal: ${(error as Error).message}`;
			}
		},
	},
	{
		name: "connector removal",
		file: (home) => path.join(placesOf(home).agentDir, "mcp.json"),
		prepare: async (home) => {
			const { agentDir } = placesOf(home);
			fs.mkdirSync(agentDir, { recursive: true, mode: 0o700 });
			fs.writeFileSync(path.join(agentDir, "mcp.json"), `${JSON.stringify({ mcpServers: { "kill-a": { url: "https://a.example.invalid/mcp" }, "kill-b": { url: "https://b.example.invalid/mcp" } } }, null, 2)}\n`, { mode: 0o600 });
		},
		save: async (home) => {
			const { removeMcpServer } = await import("../src/mcp-admin.js");
			useHome(home);
			await removeMcpServer(process.env.KILL_CONNECTOR ?? "kill-a");
		},
		read: async (home) => connectorsLeft(home),
	},
];

/** The connectors in the file: "old" with both, "new" with only kill-b. */
function connectorsLeft(home: string): string {
	try {
		const names = Object.keys(JSON.parse(fs.readFileSync(path.join(placesOf(home).agentDir, "mcp.json"), "utf-8")).mcpServers ?? {}).sort().join(",");
		return names === "kill-a,kill-b" ? "old" : names === "kill-b" ? "new" : `the connectors ${names || "(none)"}`;
	} catch (error) {
		return `a file that does not read: ${(error as Error).message}`;
	}
}

// --- The child -------------------------------------------------------------

/** Holds each rename onto the connectors' file until every child of the race has written its own. */
function meetBeforeRename(folder: string, expected: number): void {
	const realRename = fs.renameSync;
	(fs as any).renameSync = (from: fs.PathLike, to: fs.PathLike) => {
		if (path.basename(String(to)) === "mcp.json") {
			fs.writeFileSync(path.join(folder, `at-rename-${process.pid}`), "");
			const until = Date.now() + 15_000;
			while (fs.readdirSync(folder).length < expected && Date.now() < until) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
		}
		return realRename(from, to);
	};
}

/** Fails each flush of the connectors' folder, as a disk answers EIO, once the file has landed there. */
function failFolderFlushAfterRename(folder: string): void {
	const real = { openSync: fs.openSync, fsyncSync: fs.fsyncSync, renameSync: fs.renameSync };
	const folders = new Set<number>();
	let landed = false;
	(fs as any).renameSync = (from: fs.PathLike, to: fs.PathLike) => {
		real.renameSync(from, to);
		if (String(to) === path.join(folder, "mcp.json")) landed = true;
	};
	(fs as any).openSync = (file: fs.PathLike, ...rest: any[]) => {
		const descriptor = (real.openSync as any)(file, ...rest);
		if (String(file) === folder) folders.add(descriptor);
		return descriptor;
	};
	(fs as any).fsyncSync = (descriptor: number) => {
		if (landed && folders.has(descriptor)) throw Object.assign(new Error("EIO: i/o error, fsync"), { code: "EIO" });
		return real.fsyncSync(descriptor);
	};
}

/** Fails the connectors' file's temporary write with EIO, before any rename, and every read of the file after it. */
function failWriteThenRead(folder: string): void {
	const real = { openSync: fs.openSync, readFileSync: fs.readFileSync };
	const file = path.join(folder, "mcp.json");
	let failed = false;
	(fs as any).openSync = (target: fs.PathLike, ...rest: any[]) => {
		if (String(target).startsWith(`${file}.tmp-`)) {
			failed = true;
			throw Object.assign(new Error("EIO: i/o error, open"), { code: "EIO" });
		}
		return (real.openSync as any)(target, ...rest);
	};
	(fs as any).readFileSync = (target: any, ...rest: any[]) => {
		if (failed && String(target) === file) throw Object.assign(new Error("EIO: i/o error, read"), { code: "EIO" });
		return (real.readFileSync as any)(target, ...rest);
	};
}

if (process.argv[2] === "--save") {
	const store = stores.find((candidate) => candidate.name === process.argv[3])!;
	if (process.env.RACE_FOLDER) meetBeforeRename(process.env.RACE_FOLDER, 2);
	if (process.env.FAIL_FOLDER_FLUSH) failFolderFlushAfterRename(placesOf(process.env.KILL_ROOT!).agentDir);
	if (process.env.FAIL_WRITE_THEN_READ) failWriteThenRead(placesOf(process.env.KILL_ROOT!).agentDir);
	await store.save(process.env.KILL_ROOT!);
	process.exit(0);
}

// --- The parent ------------------------------------------------------------

if (os.platform() === "win32") {
	console.log("SKIPPED: not yet on a real Windows PC: it ran past 300 seconds there");
	process.exit(0);
}

const { flushOrderProblems, lanes, pool, preload, tempRoot, tsxLoader, webServerDir, provider } = await import("./kill-at-write-harness.js");
type TraceStep = import("./kill-at-write-harness.js").TraceStep;

function freshHome(name: string): string {
	const folder = fs.mkdtempSync(path.join(tempRoot, `${name.replace(/\W+/g, "-")}-`));
	const home = path.join(folder, "home");
	fs.mkdirSync(home, { recursive: true });
	return home;
}

function runSave(store: Store, home: string, env: Record<string, string>): ReturnType<typeof spawnSync> {
	return spawnSync(process.execPath, ["--import", tsxLoader, "--import", preload, THIS_FILE, "--save", store.name], {
		cwd: webServerDir,
		env: { ...process.env, ...placesOf(home).env, KILL_ROOT: home, ...env },
		encoding: "utf-8",
		timeout: 60_000,
	});
}

/** A home with the old value, armed so every write of the save counts. */
async function preparedHome(store: Store): Promise<{ home: string; arm: string }> {
	const home = freshHome(store.name);
	await store.prepare(home);
	const arm = path.join(path.dirname(home), "armed");
	fs.writeFileSync(arm, "");
	return { home, arm };
}

async function traceOf(store: Store): Promise<{ steps: TraceStep[]; problems: string[] }> {
	const { home, arm } = await preparedHome(store);
	const trace = path.join(path.dirname(home), "trace.jsonl");
	const ran = runSave(store, home, { KILL_ARM: arm, KILL_STEP: "0", KILL_TRACE: trace });
	if (ran.status !== 0) return { steps: [], problems: [`${store.name}: the save failed before any kill: ${ran.stderr}`] };
	const read = await store.read(home);
	if (read !== "new") return { steps: [], problems: [`${store.name}: the save left ${read}, so no kill below proves anything`] };
	const steps = fs.readFileSync(trace, "utf-8").trim().split("\n").map((line) => {
		const step = JSON.parse(line) as TraceStep;
		return { ...step, target: path.relative(home, step.target), ...(step.from ? { from: path.relative(home, step.from) } : {}) };
	});
	return { steps, problems: [] };
}

/** The lands of `file`, each with the flushes the check needs around it. */
function flushesOf(steps: TraceStep[], file: string): TraceStep[] {
	const lands = steps.filter((step) => (step.op === "renameSync" || step.op === "linkSync") && step.target === file && step.from);
	return steps.filter((step) => step.op === "fsyncSync" && lands.some((land) => step.target === land.from || step.target === path.dirname(file)));
}

async function storeProblems(store: Store): Promise<string[]> {
	const { steps, problems } = await traceOf(store);
	if (problems.length) return problems;
	const file = steps.find((step) => path.basename(step.target) === path.basename(store.file("/")) && (step.op === "renameSync" || step.op === "linkSync"));
	const landing = file?.target;
	problems.push(...flushOrderProblems(store.name, steps).map((problem) => `${store.name} flush order: ${problem}`));
	if (!landing) problems.push(`${store.name}: the file never landed by a rename`);
	else {
		const flushes = flushesOf(steps, landing);
		if (flushes.length < 2) problems.push(`${store.name}: ${flushes.length} flushes around the landing, not the file's and its folder's`);
		for (const cut of flushes) {
			if (flushOrderProblems(store.name, steps.filter((step) => step !== cut)).length === 0) problems.push(`${store.name}: with the flush at step ${cut.step} cut, the flush check still passes`);
		}
	}
	const jobs: Array<{ step: TraceStep; how: string }> = [];
	for (const step of steps) {
		if (step.op === "fsyncSync") continue;
		for (const how of step.bytes ? ["before", "torn-empty", "torn-half"] : ["before"]) jobs.push({ step, how });
		if (step.op === "renameSync" || step.op === "linkSync") jobs.push({ step, how: "after" });
	}
	let landed = 0;
	await pool(jobs, lanes, async ({ step, how }) => {
		const { home, arm } = await preparedHome(store);
		const ran = runSave(store, home, { KILL_ARM: arm, KILL_STEP: String(step.step), KILL_HOW: how });
		const place = `${store.name} k=${step.step} ${how} [${step.op} ${path.basename(step.target)}]`;
		if (ran.signal === "SIGKILL") landed += 1;
		else problems.push(`${place}: the kill never came`);
		const read = await store.read(home);
		if (read !== "old" && read !== "new") problems.push(`${place}: left ${read}`);
		if (how === "after" && step.target === path.relative(home, store.file(home)) && read !== "new") problems.push(`${place}: landed, yet reads ${read}`);
		fs.rmSync(path.dirname(home), { recursive: true, force: true });
	});
	console.log(`${store.name}: ${steps.length} traced steps, ${jobs.length} kills, ${landed} landed`);
	return problems;
}

/** Two removals of two connectors at once, each holding at its rename until both have written: both answer and the file reads whole. */
async function raceProblems(): Promise<string[]> {
	const store = stores.find((candidate) => candidate.name === "connector removal")!;
	const home = freshHome("race");
	await store.prepare(home);
	const file = store.file(home);
	fs.writeFileSync(file, `${JSON.stringify({ mcpServers: { "kill-a": { url: "https://a.example.invalid/mcp" }, "kill-b": { url: "https://b.example.invalid/mcp" }, "kill-c": { url: "https://c.example.invalid/mcp" } } }, null, 2)}\n`);
	const race = path.join(path.dirname(home), "race");
	fs.mkdirSync(race);
	const arm = path.join(path.dirname(home), "never-armed");
	const child = (connector: string) => new Promise<{ status: number | null; stderr: string }>((resolve) => {
		const proc = spawn(process.execPath, ["--import", tsxLoader, THIS_FILE, "--save", store.name], { cwd: webServerDir, env: { ...process.env, ...placesOf(home).env, KILL_ROOT: home, KILL_ARM: arm, RACE_FOLDER: race, KILL_CONNECTOR: connector } });
		let stderr = "";
		proc.stderr.on("data", (chunk: Buffer) => { stderr += String(chunk); });
		proc.on("exit", (status: number | null) => resolve({ status, stderr }));
	});
	const answers = await Promise.all([child("kill-a"), child("kill-b")]);
	const problems: string[] = [];
	answers.forEach((answer, at) => { if (answer.status !== 0) problems.push(`connector race: removal ${at + 1} failed: ${answer.stderr.split("\n").find((line) => /Error/.test(line)) ?? answer.stderr.trim()}`); });
	if (fs.readdirSync(race).length !== 2) problems.push(`connector race: ${fs.readdirSync(race).length} removals met at the rename, not 2`);
	try {
		const servers = JSON.parse(fs.readFileSync(file, "utf-8")).mcpServers;
		if (!servers || !Object.hasOwn(servers, "kill-c")) problems.push("connector race: the connector nobody removed is gone");
	} catch (error) {
		problems.push(`connector race: the file does not read: ${(error as Error).message}`);
	}
	const leftovers = fs.readdirSync(path.dirname(file)).filter((name) => name.startsWith("mcp.json."));
	if (leftovers.length) problems.push(`connector race: left ${leftovers.join(", ")}`);
	console.log("connector race: 2 removals");
	return problems;
}

/** A home whose connectors' file defines kill-a and kill-b, and a room granted both. */
async function grantedHome(name: string): Promise<{ home: string; granted: () => Promise<string[]> }> {
	const store = stores.find((candidate) => candidate.name === "connector removal")!;
	const home = freshHome(name);
	await store.prepare(home);
	const { agentsRoot } = useHome(home);
	const grants = await import("../src/persistent-room-mcp-settings.js");
	fs.mkdirSync(path.join(agentsRoot, ROOM), { recursive: true });
	fs.writeFileSync(path.join(agentsRoot, ROOM, "agent.json"), "{}\n");
	grants.writePersistentRoomMcpSettings(ROOM, ["kill-a", "kill-b"], { persistentAgentsRoot: agentsRoot });
	return { home, granted: async () => grants.readPersistentRoomMcpSettings(ROOM, { persistentAgentsRoot: agentsRoot }).grantedConnectors };
}

/**
 * A removal whose write fails: after the file landed (its folder's flush) it
 * answers removed and the room's grant stays gone; before it, with the file
 * then unreadable, nobody can say it landed, so it answers a failure and the
 * grant still stays gone, as after a stop midway.
 */
async function failedWriteProblems(): Promise<string[]> {
	const store = stores.find((candidate) => candidate.name === "connector removal")!;
	const never = (home: string) => path.join(path.dirname(home), "never-armed");
	const problems: string[] = [];
	const flush = await grantedHome("failed-flush");
	const flushed = runSave(store, flush.home, { KILL_ARM: never(flush.home), FAIL_FOLDER_FLUSH: "1" });
	if (flushed.status !== 0) problems.push(`failed flush: the removal answered a failure: ${String(flushed.stderr).split("\n").find((line) => /Error/.test(line)) ?? flushed.stderr}`);
	if (!String(flushed.stderr).includes("failed after it landed")) problems.push("failed flush: no flush failed, so this row proves nothing");
	const read = await store.read(flush.home);
	if (read !== "new") problems.push(`failed flush: the connectors' file reads ${read}`);
	const afterFlush = await flush.granted();
	if (afterFlush.includes("kill-a")) problems.push("failed flush: the room has its grant back for a connector that is gone");
	if (!afterFlush.includes("kill-b")) problems.push("failed flush: the room lost its grant to the connector nobody removed");
	const unread = await grantedHome("failed-write");
	const written = runSave(store, unread.home, { KILL_ARM: never(unread.home), FAIL_WRITE_THEN_READ: "1" });
	if (written.status === 0) problems.push("failed write, file unreadable: the removal answered removed");
	else if (!String(written.stderr).includes("EIO: i/o error, open")) problems.push(`failed write, file unreadable: it failed otherwise: ${String(written.stderr).split("\n").find((line) => /Error/.test(line))}`);
	if ((await store.read(unread.home)) !== "old") problems.push("failed write, file unreadable: the file changed");
	if ((await unread.granted()).includes("kill-a")) problems.push("failed write, file unreadable: the room has its grant back");
	console.log("connector removal with a failed write: 2 rows");
	return problems;
}

let exitCode = 0;
try {
	const found: string[] = [];
	const only = process.env.KILL_ONLY;
	for (const store of stores) if (!only || store.name === only) found.push(...await storeProblems(store));
	if (!only || only === "race") found.push(...await raceProblems());
	if (!only || only === "failed write") found.push(...await failedWriteProblems());
	for (const problem of found) console.log(`  PROBLEM ${problem}`);
	console.log(`kill at write, stores: ${found.length} problems`);
	if (found.length) exitCode = 1;
} catch (error) {
	console.error(error);
	exitCode = 1;
} finally {
	provider.close();
	fs.rmSync(tempRoot, { recursive: true, force: true, maxRetries: 5 });
}
process.exit(exitCode);
