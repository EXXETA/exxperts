// Every write step of a memory add, a memory delete and an upload, killed,
// restarted and checked (kill-at-write-harness.ts says how). Also here, since
// they need no room: a kill at each step of the session rewrite leaves the old
// file or the new one, and the safe write behaves as Windows needs, which this
// computer shows by answering as Windows does.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { preload, runKillMatrix, tempRoot, webServerDir, type TraceStep } from "./kill-at-write-harness.js";

if (os.platform() === "win32") {
	console.log("SKIPPED: not yet on a real Windows PC: it needs longer there than the 300 seconds the runner gives each smoke");
	process.exit(0);
}

const OPEN_SESSION = `const { SessionManager } = await import("@exxeta/exxperts-runtime"); SessionManager.open(process.env.SESSION_FILE, process.env.SESSION_DIR, process.env.SESSION_DIR);`;
// A session from before entries had ids: opening it rewrites the whole file.
const OLD_SESSION = [
	{ type: "session", id: "old-session", timestamp: "2026-01-01T00:00:00.000Z", cwd: "/" },
	{ type: "message", timestamp: "2026-01-01T00:00:01.000Z", message: { role: "user", content: "a first question", timestamp: 1 } },
	{ type: "message", timestamp: "2026-01-01T00:00:02.000Z", message: { role: "user", content: "a second question", timestamp: 2 } },
].map((entry) => JSON.stringify(entry)).join("\n") + "\n";

function openSessionKilled(folder: string, step: number, how: string, trace?: string): string {
	fs.rmSync(folder, { recursive: true, force: true });
	fs.mkdirSync(folder, { recursive: true });
	const file = path.join(folder, "old.jsonl");
	fs.writeFileSync(file, OLD_SESSION);
	const arm = path.join(folder, "..", "armed");
	fs.writeFileSync(arm, "");
	spawnSync(process.execPath, ["--import", preload, "--input-type=module", "-e", OPEN_SESSION], {
		cwd: webServerDir,
		env: { ...process.env, SESSION_FILE: file, SESSION_DIR: folder, KILL_ROOT: folder, KILL_ARM: arm, KILL_STEP: String(step), KILL_HOW: how, ...(trace ? { KILL_TRACE: trace } : {}) },
	});
	return fs.readFileSync(file, "utf-8");
}

/** The old bytes, or every line of a rewritten file: a mix of the two is neither. */
function isWholeSession(text: string): boolean {
	if (text === OLD_SESSION) return true;
	if (!text.endsWith("\n")) return false;
	const lines = text.trimEnd().split("\n");
	if (lines.length !== OLD_SESSION.trimEnd().split("\n").length) return false;
	try {
		return lines.every((line) => JSON.parse(line)) && JSON.parse(lines[1]).id !== undefined;
	} catch {
		return false;
	}
}

function sessionRewriteProblems(): string[] {
	const folder = path.join(tempRoot, "rewrite", "session");
	const trace = path.join(tempRoot, "rewrite-trace.jsonl");
	const rewritten = openSessionKilled(folder, 0, "before", trace);
	if (rewritten === OLD_SESSION || !isWholeSession(rewritten)) return ["opening an old session did not rewrite it, so no kill below proves anything"];
	const steps = fs.readFileSync(trace, "utf-8").trim().split("\n").map((line) => JSON.parse(line) as TraceStep).filter((step) => step.op !== "fsyncSync");
	const problems: string[] = [];
	let kills = 0;
	for (const step of steps) {
		for (const how of step.bytes ? ["before", "torn-empty", "torn-half"] : ["before"]) {
			kills += 1;
			if (!isWholeSession(openSessionKilled(folder, step.step, how))) problems.push(`session rewrite k=${step.step} ${how} [${step.op}] left a mix of old and new`);
		}
	}
	console.log(`session rewrite: ${steps.length} write steps, ${kills} kills`);
	return problems;
}

/** Runs `work` answering as `platform` does, with each rename first refused `busy` times. */
function withPlatform<T>(platform: NodeJS.Platform, busy: number, code: string, work: (seen: { renames: number; folders: number }) => T): T {
	const realPlatform = Object.getOwnPropertyDescriptor(process, "platform")!;
	const realRename = fs.renameSync;
	const realOpen = fs.openSync;
	const seen = { renames: 0, folders: 0 };
	Object.defineProperty(process, "platform", { value: platform });
	(fs as any).renameSync = (from: string, to: string) => {
		seen.renames += 1;
		if (seen.renames <= busy) throw Object.assign(new Error("held open"), { code });
		return realRename(from, to);
	};
	(fs as any).openSync = (file: string, ...rest: any[]) => {
		if (fs.statSync(file, { throwIfNoEntry: false })?.isDirectory()) seen.folders += 1;
		return (realOpen as any)(file, ...rest);
	};
	try {
		return work(seen);
	} finally {
		Object.defineProperty(process, "platform", realPlatform);
		(fs as any).renameSync = realRename;
		(fs as any).openSync = realOpen;
	}
}

async function windowsProblems(): Promise<string[]> {
	const { writeFileAtomic } = await import("@exxeta/exxperts-runtime") as any;
	if (typeof writeFileAtomic !== "function") return ["the safe write is missing"];
	const folder = path.join(tempRoot, "windows");
	fs.mkdirSync(folder, { recursive: true });
	const file = path.join(folder, "target.txt");
	const leftovers = () => fs.readdirSync(folder).filter((name) => name !== "target.txt");
	const problems: string[] = [];
	const check = (held: boolean, what: string) => { if (!held) problems.push(`windows: ${what}`); };

	fs.writeFileSync(file, "old");
	withPlatform("win32", 2, "EPERM", (seen) => {
		try {
			writeFileAtomic(file, "new");
		} catch { /* the check below names it */ }
		check(seen.renames === 3 && fs.readFileSync(file, "utf-8") === "new", `a target held open for two tries lands on the third, took ${seen.renames}`);
		check(seen.folders === 0, "a folder is never opened for a flush");
	});

	fs.writeFileSync(file, "old");
	withPlatform("win32", Infinity, "EBUSY", (seen) => {
		let refused = false;
		try {
			writeFileAtomic(file, "new");
		} catch {
			refused = true;
		}
		check(refused && seen.renames === 8, `a target held open for good fails after a bounded wait, took ${seen.renames}`);
		check(fs.readFileSync(file, "utf-8") === "old" && leftovers().length === 0, "that failure leaves the old file and no temporary file");
	});

	// The neighbours: elsewhere the same answer fails at once, and a folder is flushed.
	fs.writeFileSync(file, "old");
	withPlatform("linux", 1, "EPERM", (seen) => {
		let refused = false;
		try {
			writeFileAtomic(file, "new");
		} catch {
			refused = true;
		}
		check(refused && seen.renames === 1, `off Windows a refused rename is not asked again, took ${seen.renames}`);
	});
	withPlatform("linux", 0, "EPERM", (seen) => {
		writeFileAtomic(file, "new");
		check(seen.folders === 1, `off Windows the folder is flushed, opened ${seen.folders} times`);
	});
	console.log("windows behaviour: 4 rows");
	return problems;
}

await runKillMatrix(["add", "delete", "upload"], async () => [...sessionRewriteProblems(), ...await windowsProblems()]);
