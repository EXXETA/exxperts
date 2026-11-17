// Runs the folder contract (folder-contract.ts) on a real folder, then plants a
// fault in the records the real saves wrote, restoring each after, and fails
// unless the row that reads them catches it. The faults under the other rows are in
// folder-contract-faults-smoke.ts, since together they would run past the
// runner's limit per smoke on a busy machine.
//
//   FOLDER_CONTRACT_DIR=<folder>   the folder under test; the system's temporary folder if unset
//   FOLDER_CONTRACT_ONLY=<part>    runs the rows and faults whose name holds this
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { FOLDER_CONTRACT, killProblems, recordProblems, roomFromRealSaves, rowProblems, runContractSmoke, runRoleIfAsked } from "./folder-contract.js";

// Before anything else: a folder cannot be flushed on Windows.
if (process.platform === "win32") {
	console.log("folder contract smoke skipped on Windows: it runs only on macOS and Linux");
	process.exit(0);
}

// --- Faults in a record ----------------------------------------------------------

interface RecordPlant {
	name: string;
	/** Which kill-left room it changes; a room no kill touched if unset. */
	killLeft?: string;
	file: (home: string) => string;
	change(text: string, home: string): string;
	caughtBy: RegExp;
}

const roomRecord = (home: string) => path.join(home, ".exxperts", "app", "personalized-agents", "kill-room", "agent.json");
const sessionFile = (home: string) => {
	const folder = path.join(home, ".exxperts", "app", "personalized-agents", "kill-room", "runtime", "pi-sessions");
	return path.join(folder, fs.readdirSync(folder).find((name) => name.endsWith(".jsonl"))!);
};
const leftIntent = (kind: string) => (home: string) => path.join(home, ".exxperts", "app", "personalized-agents", "kill-room", "runtime", "commit", `${kind}.json`);
const withField = (text: string, field: string, value: string) => JSON.stringify({ ...JSON.parse(text), [field]: value }, null, 2);
const firstLineAnd = (text: string, change: (header: Record<string, unknown>) => Record<string, unknown>) => {
	const [first, ...rest] = text.split("\n");
	return [JSON.stringify(change(JSON.parse(first!) as Record<string, unknown>)), ...rest].join("\n");
};

const INSTALL_FOLDER = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

const RECORD_PLANTS: readonly RecordPlant[] = [
	{ name: "the data folder's path in a record", file: roomRecord, change: (text, home) => withField(text, "folder", path.join(home, "rooms")), caughtBy: /agent\.json holds the data folder's path/ },
	{ name: "another absolute path in a record", file: roomRecord, change: (text) => withField(text, "folder", "/srv/somewhere/else"), caughtBy: /agent\.json holds the absolute path \/srv\/somewhere\/else/ },
	{ name: "a path of one name in a record", file: roomRecord, change: (text) => withField(text, "folder", "/data"), caughtBy: /agent\.json holds the absolute path \/data/ },
	{ name: "a file address in a record", file: roomRecord, change: (text) => withField(text, "folder", "file:///srv/somewhere"), caughtBy: /agent\.json holds the absolute path file:\/\// },
	{ name: "the install folder in a session's cwd", file: sessionFile, change: (text) => firstLineAnd(text, (header) => ({ ...header, cwd: INSTALL_FOLDER })), caughtBy: /jsonl holds the absolute path/ },
	{ name: "the install folder in another field of the header", file: sessionFile, change: (text) => firstLineAnd(text, (header) => ({ ...header, workspace: INSTALL_FOLDER })), caughtBy: /jsonl holds the absolute path/ },
	{ name: "the install folder on a later line of a session", file: sessionFile, change: (text) => `${text}${JSON.stringify({ type: "custom", cwd: INSTALL_FOLDER })}\n`, caughtBy: /jsonl holds the absolute path/ },
	{ name: "the install folder in a record of another kind", file: roomRecord, change: (text) => withField(text, "cwd", INSTALL_FOLDER), caughtBy: /agent\.json holds the absolute path/ },
	{ name: "the data folder in a session's cwd", file: sessionFile, change: (text, home) => firstLineAnd(text, (header) => ({ ...header, cwd: home })), caughtBy: /jsonl holds the data folder's path/ },
	{ name: "a parent session by its full path", file: sessionFile, change: (text, home) => firstLineAnd(text, (header) => ({ ...header, parentSession: sessionFile(home) })), caughtBy: /jsonl holds the data folder's path/ },
	{ name: "the install folder in a left intent's runtimeCwd", killLeft: "forget", file: leftIntent("forget"), change: (text) => withField(text, "runtimeCwd", INSTALL_FOLDER), caughtBy: /forget\.json holds the absolute path/ },
	{ name: "the install folder in another field of an intent", killLeft: "forget", file: leftIntent("forget"), change: (text) => withField(text, "folder", INSTALL_FOLDER), caughtBy: /forget\.json holds the absolute path/ },
	{ name: "the data folder in an intent's runtimeCwd", killLeft: "remember", file: leftIntent("remember"), change: (text, home) => withField(text, "runtimeCwd", home), caughtBy: /remember\.json holds the data folder's path/ },
	{ name: "a runtimeCwd in an intent of another kind", killLeft: "memory", file: leftIntent("memory"), change: (text) => withField(text, "runtimeCwd", "/srv/somewhere/else"), caughtBy: /memory\.json holds the absolute path/ },
];

function recordPlantProblems(plant: RecordPlant, home: string): string[] {
	const file = plant.file(home);
	const before = fs.readFileSync(file);
	try {
		fs.writeFileSync(file, plant.change(before.toString("utf-8"), home));
		const found = recordProblems(home);
		return found.some((problem) => plant.caughtBy.test(problem)) ? [] : [`${plant.name} passed the row: it found ${found.length ? found.join("; ") : "nothing"}`];
	} finally {
		fs.writeFileSync(file, before);
	}
}

await runRoleIfAsked();

// --- The run ---------------------------------------------------------------------

await runContractSmoke("folder contract", async ({ wanted, freshFolder, report }) => {
	console.log("the promises:");
	for (const promise of FOLDER_CONTRACT) {
		if (!wanted(promise.id)) continue;
		const started = Date.now();
		if (typeof promise.heldBy === "string") console.log(`  held elsewhere  ${promise.id}: ${promise.heldBy}`);
		else report(promise.id, await rowProblems(promise.id, freshFolder()), started);
	}

	if (wanted("a kill at every step")) {
		const started = Date.now();
		const without = killProblems([`await runKillMatrix(["forget", "add", "delete"]);`]);
		report("a save the kill smokes stopped running", without.join().includes("remember") ? [] : ["the row did not see Remember go"], started);
	}

	if (wanted("records stay relative")) {
		const { homes: [home], killLeft } = await roomFromRealSaves();
		for (const plant of RECORD_PLANTS) {
			const started = Date.now();
			report(plant.name, recordPlantProblems(plant, plant.killLeft ? killLeft[plant.killLeft]! : home!), started);
		}
	}
});
