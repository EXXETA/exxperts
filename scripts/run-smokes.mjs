#!/usr/bin/env node
// Runs the web-server smoke suite: every apps/web-server/scripts/*-smoke.ts.
// Usage: npm run smokes [-- [--jobs N] [--group I/N] [--list] <filter>...].
// Filters are substrings of the smoke file name; any match includes the
// smoke. N smokes run at once, the slowest of the last run first; N defaults
// to half the machine's cores, at most 6, and --jobs 1 runs them one after
// another in name order. --group I/N keeps, of the matching smokes in name
// order, every N-th one starting at the I-th (I from 1), so N runs with I
// from 1 to N run each smoke exactly once, and neighbours in name order (often
// one heavy family) land in different groups: GitHub's CI runs the suite as
// such groups side by side to stay inside its time limit. --list prints the
// names it would run and runs none. Each smoke has its own temp HOME and
// USERPROFILE and asks the system for free ports, so they do not collide.
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { pathToFileURL, fileURLToPath } from "node:url";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { noFlushNodeOptions } from "../apps/web-server/scripts/smoke-no-flush-preload.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const smokeDir = path.join(repoRoot, "apps", "web-server", "scripts");
const require = createRequire(import.meta.url);
// --import needs a URL, not a bare path — a Windows drive-letter path would be misparsed.
const tsxLoader = pathToFileURL(require.resolve("tsx/esm")).href;

const USAGE = "Usage: npm run smokes [-- [--jobs N] [--group I/N] [--list] <filter>...]";
const args = process.argv.slice(2);
let jobs = Math.max(1, Math.min(6, Math.floor(os.availableParallelism() / 2)));
let group;
let listOnly = false;
const filters = [];
for (let i = 0; i < args.length; i++) {
	if (args[i] === "--jobs" || args[i].startsWith("--jobs=")) {
		const jobsArg = args[i] === "--jobs" ? args[++i] : args[i].slice("--jobs=".length);
		jobs = Number(jobsArg);
		if (jobsArg === undefined || !Number.isInteger(jobs) || jobs < 1) {
			console.error(`--jobs needs a whole number of at least 1, got: ${jobsArg ?? "nothing"}`);
			process.exit(1);
		}
	} else if (args[i] === "--group" || args[i].startsWith("--group=")) {
		const groupArg = args[i] === "--group" ? args[++i] : args[i].slice("--group=".length);
		const match = /^(\d+)\/(\d+)$/.exec(groupArg ?? "");
		group = match && { index: Number(match[1]), count: Number(match[2]) };
		if (!group || group.index < 1 || group.index > group.count) {
			console.error(`--group needs I/N, two whole numbers with I from 1 to N, got: ${groupArg ?? "nothing"}\n${USAGE}`);
			process.exit(1);
		}
	} else if (args[i] === "--list") {
		listOnly = true;
	} else if (args[i].startsWith("-")) {
		console.error(`unknown option: ${args[i]}\n${USAGE}`);
		process.exit(1);
	} else filters.push(args[i]);
}
const matching = fs.readdirSync(smokeDir)
	.filter((name) => name.endsWith("-smoke.ts"))
	.filter((name) => filters.length === 0 || filters.some((f) => name.includes(f)))
	.sort();
const smokes = group ? matching.filter((_, k) => k % group.count === group.index - 1) : matching;

if (smokes.length === 0) {
	console.error(matching.length > 0 ? `Group ${group.index}/${group.count} holds none of the ${matching.length} matching smokes`
		: filters.length ? `No smokes match: ${filters.join(", ")}` : `No smokes found in ${smokeDir}`);
	process.exit(1);
}
if (listOnly) {
	for (const name of smokes) console.log(name);
	process.exit(0);
}

// Each smoke's time in the last run, so a parallel run starts the slow ones
// first and does not end waiting on one long smoke. It lives in the system's
// temp folder, never in the checkout; a missing or broken file only costs the
// order.
const timingsFile = path.join(os.tmpdir(), "exxperts-smoke-timings.json");
function readTimings() {
	try {
		const timings = JSON.parse(fs.readFileSync(timingsFile, "utf8"));
		return timings && typeof timings === "object" ? timings : {};
	} catch {
		return {};
	}
}
function saveTimings(timings, results) {
	for (const result of results) timings[result.name] = result.seconds;
	try {
		const next = `${timingsFile}.${process.pid}`;
		fs.writeFileSync(next, JSON.stringify(timings));
		fs.renameSync(next, timingsFile);
	} catch {}
}

// Hard ceiling per smoke: a wedged smoke (or a server process it failed to
// tear down) must fail loudly instead of eating the CI job's entire timeout.
const SMOKE_TIMEOUT_MS = 300_000;

function killSmokeTree(child) {
	if (child.pid == null) return;
	if (process.platform === "win32") {
		spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
		return;
	}
	try { process.kill(-child.pid, "SIGKILL"); } catch { try { child.kill("SIGKILL"); } catch {} }
}

// A smoke runs in its own process group, so Ctrl-C on the terminal does not
// reach it: the runner passes the stop on to every smoke still running.
const runningSmokes = new Set();
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
	process.on(signal, () => {
		for (const child of runningSmokes) killSmokeTree(child);
		process.exit(130);
	});
}

// Playwright finds its browsers under the home on macOS and Linux (on Windows
// under LOCALAPPDATA), so the smokes' own homes would hide the installed ones.
const browsersPath = process.env.PLAYWRIGHT_BROWSERS_PATH
	?? (process.platform === "darwin" ? path.join(os.homedir(), "Library", "Caches", "ms-playwright")
		: process.platform === "linux" ? path.join(process.env.XDG_CACHE_HOME || path.join(os.homedir(), ".cache"), "ms-playwright")
		: undefined);

// The installed fd and rg live under the real home too; they are only read.
const realToolsDir = path.join(process.env.EXXPERTS_STATE_HOME || os.homedir(), ".exxperts", "agent", "bin");
const bundledToolsDir = process.env.EXXETA_BUNDLED_TOOLS_DIR || (fs.existsSync(realToolsDir) ? realToolsDir : undefined);

// A smoke that sets no home, or HOME without USERPROFILE (the home on
// Windows), still never writes into the real one. The data-folder settings
// that win over the home go too, as in smokeHomeEnv
// (apps/web-server/scripts/smoke-server-process.ts). A smoke that reads the
// real rooms, read-only, finds them under SMOKE_LOGIN_HOME. The drive flush
// is skipped but for a few smokes (smoke-no-flush-preload.mjs says why).
function smokeEnv(home, name) {
	const env = { ...process.env, HOME: home, USERPROFILE: home, SMOKE_LOGIN_HOME: os.homedir() };
	const nodeOptions = noFlushNodeOptions(process.env.NODE_OPTIONS, name, os.tmpdir());
	if (nodeOptions) env.NODE_OPTIONS = nodeOptions;
	if (browsersPath) env.PLAYWRIGHT_BROWSERS_PATH = browsersPath;
	if (bundledToolsDir) env.EXXETA_BUNDLED_TOOLS_DIR = bundledToolsDir;
	delete env.EXXPERTS_DATA_DIR;
	delete env.EXXPERTS_STATE_HOME;
	delete env.EXXPERTS_CODING_AGENT_DIR;
	return env;
}

function runSmoke(name) {
	return new Promise((resolve) => {
		const startedAt = Date.now();
		const home = fs.mkdtempSync(path.join(os.tmpdir(), "exxperts-smoke-home-"));
		const child = spawn(process.execPath, ["--import", tsxLoader, path.join(smokeDir, name)], {
			cwd: repoRoot,
			env: smokeEnv(home, name),
			stdio: ["ignore", "pipe", "pipe"],
			...(process.platform === "win32" ? {} : { detached: true }),
		});
		runningSmokes.add(child);
		let output = "";
		let timedOut = false;
		const timer = setTimeout(() => {
			timedOut = true;
			output += `\n[run-smokes] timed out after ${SMOKE_TIMEOUT_MS / 1000}s; killing the smoke's process tree\n`;
			killSmokeTree(child);
		}, SMOKE_TIMEOUT_MS);
		child.stdout.on("data", (chunk) => { output += chunk; });
		child.stderr.on("data", (chunk) => { output += chunk; });
		child.on("close", (code) => {
			runningSmokes.delete(child);
			clearTimeout(timer);
			// A file still held open on Windows only leaves the folder behind.
			try { fs.rmSync(home, { recursive: true, force: true, maxRetries: 3 }); } catch {}
			resolve({ name, code: timedOut ? 1 : (code ?? 1), output, seconds: (Date.now() - startedAt) / 1000 });
		});
	});
}

// Endpoint-security tooling on a workstation can deny a file open at random
// (EPERM on our own node_modules), killing a smoke that has nothing wrong
// with it. That exact signature gets one retry; a genuine failure repeats
// and still fails, and the retry is said out loud rather than hidden.
function isInterferenceFailure(result) {
	if (result.code === 0) return false;
	if (result.output.includes("EPERM: operation not permitted, open")) return true;
	// The same agent can also deny process.cwd() at spawn, so a smoke's server
	// never comes up. uv_cwd only ever fails when something outside us blocks it.
	return result.output.includes("process.cwd failed with error operation not permitted");
}

// A free port can still be taken between the smoke asking for it and its
// server or fake binding it. The server says so on exit
// (apps/web-server/src/index.ts), a fake throws Node's own error, and the
// smoke gets one more try with new ports, said out loud like the above. Only
// a clash on a port the smoke was handed counts: freePort prints each one
// ("smoke port N"), so an assertion that quotes the phrase does not. A clash
// after the smoke stopped a server of its own ("smoke server stopped") may be
// a restart finding the old server still there, a real fault, so it is never
// retried. Returns the port that clashed.
function portTakenFailure(result) {
	if (result.code === 0) return undefined;
	const given = new Set(Array.from(result.output.matchAll(/^smoke port (\d+)$/gm), (match) => match[1]));
	const stopped = result.output.indexOf("smoke server stopped");
	for (const match of result.output.matchAll(/Port (\d+) is already in use|listen EADDRINUSE: address already in use \S*:(\d+)/g)) {
		if (stopped !== -1 && match.index > stopped) break;
		const port = match[1] ?? match[2];
		if (given.has(port)) return port;
	}
	return undefined;
}

// A smoke that could not exercise part of itself (no browser installed, say)
// still passes, but the run must say so next to its "ok" instead of hiding it.
// Only the smoke's own notice counts ("... smoke skipped ...", "smoke passed
// (... SKIPPED ...)", a line that starts "SKIPPED:"); an assertion that merely
// mentions skipping does not.
function skipLines(output) {
	return output.split("\n").map((line) => line.trim()).filter((line) => /\bsmoke\b.*\bskipped\b/i.test(line) || line.startsWith("SKIPPED:"));
}

// A part that only another system can run (its reason says "only Windows",
// "macOS only" or "only on Linux") is no gap in this run: that system's CI
// job runs it. It is still listed under its smoke, but only the other skips
// count as SKIPPED, which the GitHub sync's check refuses
// (scripts/check-public-copy.mjs).
const ONLY_ON = [
	{ platform: "win32", words: /\bonly (?:on )?Windows\b|\(Windows only\)/i },
	{ platform: "darwin", words: /\bonly (?:on )?macOS\b|\(macOS only\)/i },
	{ platform: "linux", words: /\bonly (?:on )?Linux\b|\(Linux only\)/i },
];
function forAnotherSystem(line) {
	return ONLY_ON.some((rule) => rule.platform !== process.platform && rule.words.test(line));
}

// The whole output of a failed try goes to a file in the system's temp
// folder, since the tail alone often cannot say why a smoke failed next to
// others. Not having the file never stops the run.
const failureDir = path.join(os.tmpdir(), "exxperts-smoke-failures");
function saveOutput(name, attempt, output) {
	try {
		fs.mkdirSync(failureDir, { recursive: true });
		const file = path.join(failureDir, `${name.replace(/\.ts$/, "")}.${process.pid}.${attempt}.log`);
		fs.writeFileSync(file, output);
		return file;
	} catch {
		return null;
	}
}

// Last lines carry the assertion message; full logs would drown the summary.
function failureTail(result) {
	const saved = result.savedTo ? ` (whole output: ${result.savedTo})` : "";
	return `\n--- ${result.name} (exit ${result.code})${saved} ---\n${result.output.split("\n").slice(-25).join("\n")}`;
}

// One run alone writes each smoke's name before it starts, so a smoke that
// hangs is plain to see. Smokes running side by side each get one whole line
// when they end, so their lines never mix.
async function runAndReport(name) {
	let note = "";
	if (jobs === 1) process.stdout.write(`  ${name} … `);
	let result = await runSmoke(name);
	const interference = isInterferenceFailure(result);
	const takenPort = interference ? undefined : portTakenFailure(result);
	const retry = interference ? "retrying after a file-permission denial outside the smoke … "
		: takenPort ? `retrying after its port ${takenPort} was taken before its server bound it … ` : "";
	if (retry) {
		const firstTry = saveOutput(name, "first-try", result.output);
		const kept = firstTry ? `(first try: ${firstTry}) ` : "";
		if (jobs === 1) process.stdout.write(`${retry}${kept}`);
		else note = `${retry}${kept}`;
		result = await runSmoke(name);
		result.retried = true;
	}
	if (result.code !== 0) result.savedTo = saveOutput(name, "failed", result.output);
	const skips = result.code === 0 ? skipLines(result.output) : [];
	const verdict = result.code === 0 ? `ok (${result.seconds.toFixed(1)}s)${skips.map((line) => `\n      ${forAnotherSystem(line) ? "NOT HERE" : "SKIP"}: ${line}`).join("")}` : `FAIL (${result.seconds.toFixed(1)}s)`;
	console.log(jobs === 1 ? verdict : `  ${name} … ${note}${verdict}`);
	// Printed at once as well as in the summary: a run cut off by a CI time
	// limit still shows why the smoke failed.
	if (result.code !== 0) console.log(failureTail(result));
	return result;
}

const timings = readTimings();
const queue = jobs === 1 ? [...smokes] : [...smokes].sort((a, b) => (timings[b] ?? 0) - (timings[a] ?? 0));
const results = [];
const startedAt = Date.now();
console.log(`Running ${smokes.length} smoke${smokes.length === 1 ? "" : "s"}${jobs > 1 ? `, ${jobs} at a time` : ""}…\n`);
await Promise.all(Array.from({ length: Math.min(jobs, queue.length) }, async () => {
	for (let name = queue.shift(); name !== undefined; name = queue.shift()) results.push(await runAndReport(name));
}));
results.sort((a, b) => a.name.localeCompare(b.name));
saveTimings(timings, results);

const failed = results.filter((result) => result.code !== 0);
const total = results.reduce((sum, result) => sum + result.seconds, 0);
const skipped = results.filter((result) => result.code === 0 && skipLines(result.output).some((line) => !forAnotherSystem(line)));
const elsewhere = results.filter((result) => result.code === 0 && skipLines(result.output).some(forAnotherSystem));
const retried = results.filter((result) => result.retried);
// The summary line keeps its exact form: the GitHub sync accepts a SMOKES
// stamp only as "N/N passed in Ns" (scripts/sync-github.mjs). The time on the
// clock of a parallel run goes on its own line.
console.log(`\n${results.length - failed.length}/${results.length} passed in ${Math.round(total)}s`);
if (jobs > 1) console.log(`${Math.round((Date.now() - startedAt) / 1000)}s on the clock, ${jobs} at a time`);
if (group) console.log(`Group ${group.index}/${group.count}: ${smokes.length} of ${matching.length} smokes, one in every ${group.count} in name order, starting with number ${group.index}`);
if (skipped.length > 0) console.log(`${skipped.length} passed with parts SKIPPED: ${skipped.map((result) => result.name).join(", ")}`);
if (elsewhere.length > 0) console.log(`${elsewhere.length} passed with parts only another system runs: ${elsewhere.map((result) => result.name).join(", ")}`);
if (retried.length > 0) console.log(`${retried.length} retried once (reasons above): ${retried.map((result) => result.name).join(", ")}`);
for (const result of failed) console.log(failureTail(result));
process.exit(failed.length === 0 ? 0 : 1);
