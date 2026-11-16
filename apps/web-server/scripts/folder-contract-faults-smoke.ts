// Plants a fault under each row of the folder contract (folder-contract.ts) that
// can be faulted, and fails unless the row catches it. folder-contract-smoke.ts
// runs the rows themselves, and the faults in a record, which need the room the
// real saves wrote.
//
// A fault in the disk or the room lock runs the same row in a child process with
// `fs` or the lock's source changed there, so nothing needs restoring. A fault
// in a save changes a source's text in memory.
//
//   FOLDER_CONTRACT_DIR=<folder>   the folder under test; the system's temporary folder if unset
//   FOLDER_CONTRACT_ONLY=<part>    runs the faults whose name, or whose row's name, holds this
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import Module from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { killStartedRoles, readSaves, rowProblems, runContractSmoke, runRoleIfAsked } from "./folder-contract.js";

// Before anything else: a folder cannot be flushed on Windows, and the planted tar below is a shell script.
if (process.platform === "win32") {
	console.log("folder contract faults smoke skipped on Windows: it runs only on macOS and Linux");
	process.exit(0);
}

const SERVER_SOURCE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "src");
const RUNTIME_SAFE_WRITE = path.resolve(SERVER_SOURCE, "..", "..", "..", "runtime", "packages", "coding-agent", "src", "core", "safe-write.ts");

// --- Faults in a disk or the lock ------------------------------------------------

interface Plant {
	name: string;
	row: string;
	/** What the row must say: a row that fails for another reason proves nothing. */
	caughtBy: RegExp;
	install(): void;
}

const ROOM_LOCK_TAKEOVER = `return existing.surface === "web" && owner.surface === "web";`;
const ROOM_LOCK_CREATE = "fs.linkSync(temporary, file);";

function changeRoomLockAsItLoads(from: string, to: string): void {
	const internals = Module.prototype as unknown as { _compile(content: string, filename: string): unknown };
	const compile = internals._compile;
	internals._compile = function (content, filename) {
		if (!filename.endsWith("room-lock.cjs")) return compile.call(this, content, filename);
		assert.ok(content.includes(from), "the room lock no longer holds the line this fault changes");
		return compile.call(this, content.replace(from, to), filename);
	};
}

const PLANTS: readonly Plant[] = [
	{
		name: "a rename with a gap",
		row: "atomic rename",
		caughtBy: /was missing/,
		install: () => {
			const rename = fs.renameSync;
			fs.renameSync = (from, to) => {
				fs.rmSync(to, { force: true });
				rename(from, to);
			};
		},
	},
	{
		name: "a rename that writes in place",
		row: "atomic rename",
		caughtBy: /neither whole version/,
		install: () => {
			fs.renameSync = (from, to) => {
				const bytes = fs.readFileSync(from);
				const fd = fs.openSync(to, "r+");
				for (let at = 0; at < bytes.length; at += 4096) fs.writeSync(fd, bytes, at, Math.min(4096, bytes.length - at), at);
				fs.closeSync(fd);
				fs.rmSync(from);
			};
		},
	},
	{
		name: "a link that overwrites",
		row: "link if absent",
		caughtBy: /not refused with EEXIST/,
		install: () => {
			const link = fs.linkSync;
			fs.linkSync = (from, to) => {
				fs.rmSync(to, { force: true });
				link(from, to);
			};
		},
	},
	{
		name: "a create that is not exclusive",
		row: "exclusive create",
		caughtBy: /not refused with EEXIST/,
		install: () => {
			const open = fs.openSync;
			fs.openSync = ((target: string, flags: string, ...rest: [number]) => open(target, flags === "wx" ? "w" : flags, ...rest)) as typeof fs.openSync;
		},
	},
	{
		name: "an append that rewrites the file",
		row: "append",
		// Which of these a rewrite race leaves depends on how the writers met.
		caughtBy: /appended lines are there|appended line was torn|appended file does not end/,
		install: () => {
			fs.appendFileSync = (file, line) => {
				const before = fs.existsSync(file as string) ? fs.readFileSync(file as string, "utf-8") : "";
				fs.writeFileSync(file as string, before + String(line));
			};
		},
	},
	{
		name: "a disk that refuses a flush",
		row: "fsync",
		caughtBy: /failed: ENOTSUP/,
		install: () => {
			fs.fsyncSync = () => {
				throw Object.assign(new Error("flush refused"), { code: "ENOTSUP" });
			};
		},
	},
	{
		name: "a pack that loses file times",
		row: "file times",
		caughtBy: /came back from the pack/,
		install: () => {
			const shim = fs.mkdtempSync(path.join(process.env.FOLDER_CONTRACT_ROW_FOLDER!, "tar-"));
			const realTar = spawnSync("sh", ["-c", "command -v tar"], { encoding: "utf-8" }).stdout.trim();
			fs.writeFileSync(path.join(shim, "tar"), `#!/bin/sh\nif [ "$1" = "-xpf" ]; then shift; exec "${realTar}" -xmpf "$@"; fi\nexec "${realTar}" "$@"\n`, { mode: 0o755 });
			process.env.PATH = `${shim}${path.delimiter}${process.env.PATH}`;
		},
	},
	{
		name: "a second writer",
		row: "one writer per room",
		caughtBy: /took a room a live run held/,
		install: () => changeRoomLockAsItLoads(ROOM_LOCK_TAKEOVER, "return true;"),
	},
	{
		name: "a lock that is not exclusive",
		row: "one writer per room",
		caughtBy: /took a room a live run held/,
		install: () => changeRoomLockAsItLoads(ROOM_LOCK_CREATE, "fs.renameSync(temporary, file);"),
	},
	{
		// Only the race can catch this one: a held lock is whole by the time anyone asks, and a racer finds it empty. A takeover's own lock stays quick, or the filled lock lands before the takeover looks again.
		name: "a lock made, then filled",
		row: "one writer per room",
		caughtBy: /racers won a room/,
		install: () => changeRoomLockAsItLoads(ROOM_LOCK_CREATE, `fs.closeSync(fs.openSync(file, "wx", 0o600)); if (!file.includes(".taking-")) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500); fs.writeFileSync(file, data);`),
	},
];

/** Runs one row in a child with its fault planted, and gives back the row's problems. */
function plantedRowProblems(plant: Plant, folder: string): Promise<string[]> {
	const answer = path.join(folder, "row-answer.json");
	return new Promise((resolve, reject) => {
		const child = spawn(process.execPath, [...process.execArgv, process.argv[1]!], {
			env: { ...process.env, FOLDER_CONTRACT_PLANTED_ROW: plant.name, FOLDER_CONTRACT_ROW_FOLDER: folder, FOLDER_CONTRACT_ROW_ANSWER: answer },
			stdio: ["ignore", "inherit", "inherit"],
		});
		child.once("error", reject);
		child.once("exit", () => {
			if (fs.existsSync(answer)) resolve(JSON.parse(fs.readFileSync(answer, "utf-8")) as string[]);
			else reject(new Error(`the row under "${plant.name}" gave no answer`));
		});
	});
}

const plantedName = process.env.FOLDER_CONTRACT_PLANTED_ROW;
if (plantedName) {
	const plant = PLANTS.find((candidate) => candidate.name === plantedName)!;
	plant.install();
	if (!process.env.FOLDER_CONTRACT_ROLE) {
		const problems = await rowProblems(plant.row, process.env.FOLDER_CONTRACT_ROW_FOLDER!);
		// This child's own fault may be in the very calls an answer needs, so the answer goes by a plain write.
		fs.writeFileSync(process.env.FOLDER_CONTRACT_ROW_ANSWER!, JSON.stringify(problems));
		killStartedRoles();
		process.exit(0);
	}
}
await runRoleIfAsked();

// --- Faults in a save ------------------------------------------------------------

const inServer = (name: string) => path.join(SERVER_SOURCE, name);
const FORGET = inServer("persistent-agent-forget.ts");
const REMEMBER = inServer("persistent-agent-remember-save.ts");
const MEMORY = inServer("memory-entries-store.ts");
const THREADS = inServer("persistent-agent-threads.ts");
const FORGET_INTENT = `writeCommitIntent(instance.rootDir, "forget", intent);`;
const FORGET_CLEAR = `clearCommitIntent(instance.rootDir, "forget");`;

const ASYNC_WRITE = `void fs.promises.writeFile("planted", "planted");`;

interface SavePlant {
	name: string;
	file: string;
	after: string;
	code: string;
	/** The spans that must fail; none means this is an allowed neighbour, and everything passes. */
	fails: readonly string[];
	caughtBy?: RegExp;
}

const EVERY_SPAN = ["forget save", "forget settle", "memory save", "memory settle", "remember save", "remember settle"];

const SAVE_PLANTS: readonly SavePlant[] = [
	{ name: "an async write in Forget", file: FORGET, after: FORGET_INTENT, code: ASYNC_WRITE, fails: ["forget save"] },
	{ name: "an async write in Remember", file: REMEMBER, after: `writeCommitIntent(root, "remember", intent);`, code: ASYNC_WRITE, fails: ["remember save"] },
	{ name: "an async write in a memory save", file: MEMORY, after: `writeCommitIntent(rootDir, "memory", intent);`, code: ASYNC_WRITE, fails: ["memory save"] },
	{ name: "an async write in Forget's settle", file: FORGET, after: "function settleForgetCommit(agentId: string, roomDir: string, intent: ForgetCommitIntent): void {", code: ASYNC_WRITE, fails: ["forget settle"] },
	{ name: "an async write in Remember's settle", file: REMEMBER, after: "function settleRememberCommit(agentId: string, roomDir: string, intent: RememberCommitIntent): void {", code: ASYNC_WRITE, fails: ["remember settle"] },
	{ name: "an async write in a memory save's settle", file: MEMORY, after: `registerCommitSettler("memory", (agentId, rootDir, intent: MemoryCommitIntent) => {`, code: ASYNC_WRITE, fails: ["memory settle"] },
	{ name: "an await", file: FORGET, after: FORGET_INTENT, code: `await Promise.resolve();`, fails: ["forget save"], caughtBy: /an await/ },
	{ name: "a write by callback", file: FORGET, after: FORGET_INTENT, code: `fs.writeFile("planted", "planted", () => {});`, fails: ["forget save"], caughtBy: /Node's writeFile/ },
	{ name: "a write by Node's callback form of a named call", file: MEMORY, after: `writeCommitIntent(rootDir, "memory", intent);`, code: `crypto.randomBytes(1, () => fs.writeFileSync("planted", "planted"));`, fails: ["memory save"], caughtBy: /hands a function to Node/ },
	{ name: "a write after a timer", file: FORGET, after: FORGET_INTENT, code: `setTimeout(() => fs.writeFileSync("planted", "planted"), 0);`, fails: ["forget save"], caughtBy: /setTimeout/ },
	{ name: "a write after a then", file: FORGET, after: FORGET_INTENT, code: `Promise.resolve().then(() => fs.writeFileSync("planted", "planted"));`, fails: ["forget save"], caughtBy: /gives a promise/ },
	{ name: "a write behind an any", file: FORGET, after: FORGET_INTENT, code: `(fs as any).promises.writeFile("planted", "planted");`, fails: ["forget save"], caughtBy: /writeFile this check cannot read/ },
	{ name: "an async helper handed to a list", file: FORGET, after: FORGET_INTENT, code: `["planted"].forEach(async (name) => { fs.writeFileSync(name, name); });`, fails: ["forget save"], caughtBy: /an async function/ },
	{ name: "an async write two calls down", file: THREADS, after: "export function closePersistentAgentThreadForMemento(agentIdRaw: string, threadIdRaw: string, mementoIdRaw: string", code: "", fails: ["forget save"] },
	{ name: "an async write in the runtime's safe write", file: RUNTIME_SAFE_WRITE, after: "export function writeFileAtomic(file: string, content: string | Uint8Array, options: WriteFileAtomicOptions = {}): void {", code: ASYNC_WRITE, fails: EVERY_SPAN.filter((span) => span.endsWith("save")) },
	{ name: "a synchronous write inside a save", file: FORGET, after: FORGET_INTENT, code: `fs.writeFileSync("planted", "planted");`, fails: [] },
	{ name: "an async write after the clear", file: FORGET, after: FORGET_CLEAR, code: ASYNC_WRITE, fails: [] },
];

function plantedSource(plant: SavePlant): Map<string, string> {
	const text = fs.readFileSync(plant.file, "utf-8");
	assert.equal(text.split(plant.after).length, 2, `${plant.name}: the line it plants after must be there once`);
	if (plant.code) return new Map([[plant.file, text.replace(plant.after, `${plant.after}\n${plant.code}`)]]);
	// A signature that runs on past the anchor: plant at the first line of its body.
	const body = text.indexOf("{\n", text.indexOf(plant.after)) + 2;
	return new Map([[plant.file, `${text.slice(0, body)}${ASYNC_WRITE}\n${text.slice(body)}`]]);
}

function savePlantProblems(plant: SavePlant): string[] {
	const { problems } = readSaves(plantedSource(plant));
	if (!plant.fails.length) return problems.map((problem) => `${plant.name} should pass, and failed: ${problem}`);
	const caughtBy = plant.caughtBy ?? /gives a promise/;
	const missed = plant.fails.filter((span) => !problems.some((problem) => problem.startsWith(`${span}:`) && caughtBy.test(problem)));
	return missed.map((span) => `${plant.name} passed the ${span}`);
}

// --- The run ---------------------------------------------------------------------

await runContractSmoke("folder contract faults", async ({ wanted, freshFolder, report }) => {
	console.log("a fault under each row:");
	for (const plant of PLANTS) {
		if (!wanted(plant.row) && !wanted(plant.name)) continue;
		const started = Date.now();
		const problems = await plantedRowProblems(plant, freshFolder());
		const caught = problems.some((problem) => plant.caughtBy.test(problem));
		report(plant.name, caught ? [] : [`the row "${plant.row}" did not catch it: it said ${problems.length ? problems.join("; ") : "nothing"}`], started);
	}

	if (wanted("saves stay synchronous") || wanted("async")) {
		const reading = readSaves();
		console.log(`the saves read: ${reading.spans.join(", ")}; ${reading.functions} functions reached`);
		// A plant counts only against a clean reading: a span already failing would pass any of them.
		assert.deepEqual(reading.problems, [], "the saves must read clean before anything is planted");
		for (const plant of SAVE_PLANTS) {
			const started = Date.now();
			report(plant.name, savePlantProblems(plant), started);
		}
	}
});
