// The locks a kill can leave on the desktop, and a lock a live holder has. A real
// kill at each step of taking and giving back the locks on auth.json and
// settings.json, then a restart on the same disk: the first turn works at once.
// Beside those: a kill during a sign-in's refresh, and a live holder's lock.
// The shared server's lock rows and the rows on a dead lock are in
// restart-lock-rows-shared-smoke.ts, since together they would run past the
// runner's five minutes on a busy machine.
// RESTART_ONLY=<part of a row's name> runs some.
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { EDITIONS, agentDirOf, exited, endChild, firstTurnProblems, lockParts, readJsonAnswer, runRestartParts, sendTurn, startServer, templateCopy, tsxLoader, waitReady, webServerDir, type Child, type Run } from "./kill-at-write-harness.js";
import { freePort } from "./smoke-server-process.js";
import { waitEvery } from "./smoke-wait.js";

if (os.platform() === "win32") {
	console.log("SKIPPED: not yet on a real Windows PC: it needs longer there than the 300 seconds the runner gives each smoke");
	process.exit(0);
}

const signIn = pathToFileURL(path.join(path.dirname(fileURLToPath(import.meta.url)), "restart-slow-sign-in.ts")).href;
const waitUntil = waitEvery(20);

// Past proper-lockfile's default stale time, which the sync path uses, and short of when a slower refresh of the lock's time would first come.
const PAST_SYNC_STALE_MS = 11_000;

const expiredSignIn = (home: string) => fs.writeFileSync(path.join(agentDirOf(home), "auth.json"), JSON.stringify({ "fake-gpt": { type: "oauth", refresh: "refresh", access: "expired", expires: Date.now() - 1_000 } }), { mode: 0o600 });
const refreshesBegun = (file: string) => (fs.existsSync(file) ? fs.readFileSync(file, "utf-8").trim().split("\n").length : 0);
const lockOwner = (home: string) => {
	try {
		return JSON.parse(fs.readFileSync(path.join(agentDirOf(home), "auth.json.lock"), "utf-8")).pid as number;
	} catch {
		return undefined;
	}
};

/** A sign-in's refresh holds the lock across its slow call, a kill lands there, and the first turn refreshes at once. A shared server serves no sign-in, so this path is the desktop's. */
async function asyncLockRow(): Promise<string[]> {
	const folder = templateCopy("async-lock");
	const home = path.join(folder, "home");
	expiredSignIn(home);
	const seen = path.join(folder, "refreshes");
	const port = await freePort();
	const run: Run = { home, base: `http://127.0.0.1:${port}` };
	const first = startServer({ imports: [signIn], env: { RESTART_REFRESH_SEEN: seen, RESTART_REFRESH_GO: path.join(folder, "never") } }, home, port);
	let second: Child | undefined;
	try {
		await waitReady(first, run);
		void sendTurn(run, "This turn's refresh is cut.").catch(() => undefined);
		await waitUntil(() => refreshesBegun(seen) === 1, "the refresh began");
		const problems = lockOwner(home) === first.process.pid ? [] : [`the kill would leave no lock of this server's: the lock names ${lockOwner(home)}`];
		first.process.kill("SIGKILL");
		await exited(first);
		if (lockOwner(home) === undefined) problems.push("the kill left no lock, so this row proves nothing");
		second = startServer({ imports: [signIn], env: { RESTART_REFRESH_SEEN: seen } }, home, port);
		await waitReady(second, run);
		problems.push(...await firstTurnProblems(run, () => sendTurn(run, "The first question after.")));
		if (refreshesBegun(seen) !== 2) problems.push(`${refreshesBegun(seen)} refreshes began`);
		if (!fs.readFileSync(path.join(agentDirOf(home), "auth.json"), "utf-8").includes("refreshed-token")) problems.push("the refreshed sign-in was not saved");
		return problems.map((problem) => `the async path: ${problem}`);
	} finally {
		await endChild(first);
		if (second) await endChild(second);
	}
}

/**
 * A process that read the sign-in before the lock was taken, as a running server
 * has, and asks for its key once `ask` exists; it prints the key it got. Its storage
 * must be open first: a process that starts under a live lock has its sync read
 * refused, and refusing is right.
 */
function signInUser(home: string, seen: string, open: string, ask: string, work = `console.log(await auth.getApiKey("fake-gpt"));`) {
	const code = `const fs = await import("node:fs");
		const { AuthStorage } = await import("@exxeta/exxperts-runtime");
		const auth = AuthStorage.create();
		fs.writeFileSync(process.env.USER_OPEN, "");
		while (!fs.existsSync(process.env.USER_ASK)) await new Promise((resolve) => setTimeout(resolve, 20));
		${work}`;
	const child = spawn(process.execPath, ["--import", tsxLoader, "--import", signIn, "--input-type=module", "-e", code], { cwd: webServerDir, env: { ...process.env, HOME: home, EXXPERTS_CODING_AGENT_DIR: agentDirOf(home), RESTART_REFRESH_SEEN: seen, USER_OPEN: open, USER_ASK: ask } });
	let printed = "";
	child.stdout.on("data", (chunk) => { printed += String(chunk); });
	return new Promise<string>((resolve) => child.on("exit", () => resolve(printed.trim())));
}

/**
 * A live server holds the lock across its refresh. A second server on the same
 * data folder starts, a third process needs the same refresh, and a read comes
 * once the refresh has run past the sync path's stale time: none takes the lock,
 * the refresh runs once, and the waiting process gets its result.
 */
async function liveLockRow(): Promise<string[]> {
	const folder = templateCopy("live-lock");
	const home = path.join(folder, "home");
	expiredSignIn(home);
	const seen = path.join(folder, "refreshes");
	const go = path.join(folder, "go");
	const port = await freePort();
	const otherPort = await freePort();
	const run: Run = { home, base: `http://127.0.0.1:${port}` };
	const other: Run = { home, base: `http://127.0.0.1:${otherPort}` };
	const holder = startServer({ imports: [signIn], env: { RESTART_REFRESH_SEEN: seen, RESTART_REFRESH_GO: go } }, home, port);
	let beside: Child | undefined;
	const userOpen = path.join(folder, "user-open");
	const userAsk = path.join(folder, "user-ask");
	const readerOpen = path.join(folder, "reader-open");
	const readerAsk = path.join(folder, "reader-ask");
	try {
		const waiting = signInUser(home, seen, userOpen, userAsk);
		const reader = signInUser(home, seen, readerOpen, readerAsk, "auth.reload();");
		await waitUntil(() => fs.existsSync(userOpen) && fs.existsSync(readerOpen), "the other processes read the sign-in");
		await waitReady(holder, run);
		const turn = sendTurn(run, "This turn holds the lock.");
		await waitUntil(() => refreshesBegun(seen) === 1, "the refresh began");
		const refreshBegan = Date.now();
		const problems: string[] = [];
		const stillHeld = (when: string) => { if (lockOwner(home) !== holder.process.pid) problems.push(`${when}: the live holder's lock was taken, it now names ${lockOwner(home)}`); };
		stillHeld("before anything else came");
		beside = startServer({ imports: [signIn], env: { RESTART_REFRESH_SEEN: seen } }, home, otherPort);
		await waitReady(beside, other);
		stillHeld("after a second server started");
		await readJsonAnswer(`${other.base}/api/persistent-agents`);
		stillHeld("after a second server read the rooms");
		fs.writeFileSync(userAsk, "");
		// A process that took the lock would begin its own refresh at once, and the lock would name it. Nothing else marks a process that rightly waits.
		await new Promise((resolve) => setTimeout(resolve, 1_500));
		stillHeld("while a third process wanted the refresh");
		await new Promise((resolve) => setTimeout(resolve, Math.max(0, PAST_SYNC_STALE_MS - (Date.now() - refreshBegan))));
		fs.writeFileSync(readerAsk, "");
		await reader;
		stillHeld("after a read with the refresh past the sync path's stale time");
		if (refreshesBegun(seen) !== 1) problems.push(`${refreshesBegun(seen)} refreshes began while the lock was held`);
		fs.writeFileSync(go, "");
		const answer = await turn;
		if (answer.status >= 300) problems.push(`the holder's own turn failed: ${answer.status}`);
		const key = await waiting;
		if (key !== "refreshed-token") problems.push(`the process that waited got ${key || "nothing"}`);
		if (refreshesBegun(seen) !== 1) problems.push(`${refreshesBegun(seen)} refreshes ran for one expired token`);
		return problems.map((problem) => `a live holder: ${problem}`);
	} finally {
		await endChild(holder);
		if (beside) await endChild(beside);
	}
}

await runRestartParts("restart lock rows", async (part, all) => {
	await lockParts(part, all, EDITIONS.find((edition) => !edition.sharedServer)!);
	await part("lock async path", asyncLockRow);
	await part("lock live holder", liveLockRow);
});
