// The locks a kill can leave on a shared server: a real kill at each step of
// taking and giving back the locks on auth.json and settings.json, then a restart
// on the same disk, and the first turn works at once. Beside those, with no
// server: a kill at each step of clearing a dead lock, and several processes
// meeting one dead lock. The desktop's lock rows and a live holder's lock are in
// restart-lock-rows-smoke.ts, since together they would run past the runner's
// five minutes on a busy machine.
// RESTART_ONLY=<part of a row's name> runs some.
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import { hostname } from "node:os";
import path from "node:path";
import { AT_ONCE_MS, EDITIONS, lanes, lockParts, pool, preload, runRestartParts, tempRoot, webServerDir, type TraceStep } from "./kill-at-write-harness.js";

function deadPid(): number {
	return spawnSync(process.execPath, ["-e", ""]).pid;
}

const LEFT_NOTE = "tmp-1-1-left";
const ownerNote = (pid: number) => JSON.stringify({ pid, host: hostname(), run: "a-run-a-kill-ended", note: LEFT_NOTE });

const AUTH_CODE = `const { AuthStorage } = await import("@exxeta/exxperts-runtime"); const auth = AuthStorage.create(process.env.AUTH_FILE); console.log(JSON.stringify({ errors: auth.drainErrors().map((error) => error.code), key: auth.get("fake-gpt")?.key }));`;

/** Runs code that reads auth.json in a process of its own; `killing` loads the kill preload. */
function authChild(file: string, code: string, env: Record<string, string> = {}, killing = false): Promise<{ stdout: string; stderr: string; signal: NodeJS.Signals | null }> {
	return new Promise((resolve, reject) => {
		const child = spawn(process.execPath, [...(killing ? ["--import", preload] : []), "--input-type=module", "-e", code], { cwd: webServerDir, env: { ...process.env, AUTH_FILE: file, ...env } });
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (chunk) => { stdout += String(chunk); });
		child.stderr.on("data", (chunk) => { stderr += String(chunk); });
		child.once("error", reject);
		child.once("close", (_code, signal) => resolve({ stdout, stderr, signal }));
	});
}

function freshLeftLock(folder: string): string {
	fs.rmSync(folder, { recursive: true, force: true });
	fs.mkdirSync(folder, { recursive: true });
	const file = path.join(folder, "auth.json");
	fs.writeFileSync(file, JSON.stringify({ "fake-gpt": { type: "api_key", key: "kept-key" } }));
	// What a kill right after the link leaves: the lock and its note, one file with two names.
	fs.writeFileSync(`${file}.lock.${LEFT_NOTE}`, ownerNote(deadPid()));
	fs.linkSync(`${file}.lock.${LEFT_NOTE}`, `${file}.lock`);
	return file;
}

/** A kill at each step of clearing a dead lock leaves a folder the next process reads at once. Each kill has a folder of its own, so they run side by side. */
async function clearingKillRows(): Promise<string[]> {
	const root = path.join(tempRoot, "clearing");
	const arm = path.join(root, "armed");
	const trace = path.join(root, "trace.jsonl");
	const traced = path.join(root, "traced");
	const file = freshLeftLock(traced);
	fs.writeFileSync(arm, "");
	await authChild(file, AUTH_CODE, { KILL_ROOT: traced, KILL_ARM: arm, KILL_STEP: "0", KILL_TRACE: trace }, true);
	const steps = fs.readFileSync(trace, "utf-8").trim().split("\n").map((line) => JSON.parse(line) as TraceStep).filter((step) => step.op !== "fsyncSync");
	// The first link meets the left lock and lands nothing, so it has no "after".
	const refusedLink = steps.find((step) => step.op === "linkSync" && path.basename(step.target) === "auth.json.lock");
	const jobs = steps.flatMap((step) => (step.bytes ? ["before", "after", "torn-empty", "torn-half"] : step === refusedLink ? ["before"] : ["before", "after"]).map((how) => ({ step, how })));
	const problems: string[] = [];
	await pool(jobs, lanes, async ({ step, how }) => {
		const folder = path.join(root, `k-${step.step}-${how}`);
		const left = freshLeftLock(folder);
		const killed = await authChild(left, AUTH_CODE, { KILL_ROOT: folder, KILL_ARM: arm, KILL_STEP: String(step.step), KILL_HOW: how }, true);
		if (killed.signal !== "SIGKILL") problems.push(`clearing k=${step.step} ${how}: the kill never came`);
		const started = Date.now();
		const read = await authChild(left, AUTH_CODE);
		const took = Date.now() - started;
		if (fs.existsSync(`${left}.lock.${LEFT_NOTE}`)) problems.push(`clearing k=${step.step} ${how} [${step.op} ${path.basename(step.target)}]: the left lock's note is still there`);
		if (!read.stdout.includes('"errors":[],"key":"kept-key"') || took >= AT_ONCE_MS) problems.push(`clearing k=${step.step} ${how} [${step.op} ${path.basename(step.target)}]: the next read gave ${read.stdout.trim() || read.stderr.slice(-200)} in ${took} ms`);
	});
	console.log(`clearing a dead lock: ${steps.length} write steps, ${jobs.length} kills`);
	return steps.some((step) => path.basename(step.target) === "auth.json.lock" && step.op === "rmSync") ? problems : ["the left lock was never cleared, so nothing here proves anything", ...problems];
}

/** Six processes meet one dead lock, each writing its own key under the lock: a lock two of them held loses a key. */
async function contendersRow(): Promise<string[]> {
	const folder = path.join(tempRoot, "contenders", "agent");
	const file = freshLeftLock(folder);
	const names = Array.from({ length: 6 }, (_, at) => `contender-${at}`);
	const code = `const { AuthStorage } = await import("@exxeta/exxperts-runtime");
		const name = process.env.KEY_NAME;
		for (let tries = 0; tries < 500; tries++) {
			const auth = AuthStorage.create(process.env.AUTH_FILE);
			auth.set(name, { type: "api_key", key: name });
			if (auth.drainErrors().length === 0) process.exit(0);
		}
		process.exit(1);`;
	const codes = await Promise.all(names.map((name) => new Promise<number | null>((resolve) => {
		spawn(process.execPath, ["--input-type=module", "-e", code], { cwd: webServerDir, stdio: "ignore", env: { ...process.env, AUTH_FILE: file, KEY_NAME: name } }).on("exit", resolve);
	})));
	const saved = JSON.parse(fs.readFileSync(file, "utf-8"));
	return [...codes.filter((exit) => exit !== 0).map((exit) => `contenders: a process ended with ${exit}`), ...names.filter((name) => !saved[name]).map((name) => `contenders: ${name}'s write was lost`)];
}

await runRestartParts("restart lock rows, shared server", async (part, all) => {
	await lockParts(part, all, EDITIONS.find((edition) => edition.sharedServer)!);
	await part("lock clearing kills", clearingKillRows);
	await part("lock contenders", contendersRow);
});
