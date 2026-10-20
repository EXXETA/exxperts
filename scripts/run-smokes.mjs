#!/usr/bin/env node
// Runs every apps/{web-server,web-ui}/scripts/*-smoke.ts.
// Usage: npm run smokes [-- [--jobs N] <filter>...]. Filters are substrings
// of the smoke file name; any match includes the smoke. N smokes run at once,
// the slowest of the last run first; N defaults to half the machine's cores,
// at most 6, and --jobs 1 runs them one after another in name order. Each
// smoke has its own temp HOME and asks the system for free ports, so they do
// not collide.
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { pathToFileURL, fileURLToPath } from "node:url";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const suites = [
	{ name: "server", directory: "web-server", tsconfig: "tsconfig.scripts.json" },
	{ name: "ui", directory: "web-ui", tsconfig: "tsconfig.json" },
];
const require = createRequire(import.meta.url);
// --import needs a URL, not a bare path — a Windows drive-letter path would be misparsed.
const tsxLoader = pathToFileURL(require.resolve("tsx/esm")).href;

const args = process.argv.slice(2);
let jobs = Math.max(1, Math.min(6, Math.floor(os.availableParallelism() / 2)));
const filters = [];
for (let i = 0; i < args.length; i++) {
	if (args[i] === "--jobs" || args[i].startsWith("--jobs=")) {
		const jobsArg = args[i] === "--jobs" ? args[++i] : args[i].slice("--jobs=".length);
		jobs = Number(jobsArg);
		if (jobsArg === undefined || !Number.isInteger(jobs) || jobs < 1) {
			console.error(`--jobs needs a whole number of at least 1, got: ${jobsArg ?? "nothing"}`);
			process.exit(1);
		}
	} else if (args[i].startsWith("-")) {
		console.error(`unknown option: ${args[i]}\nUsage: npm run smokes [-- [--jobs N] <filter>...]`);
		process.exit(1);
	} else filters.push(args[i]);
}
const smokes = suites.flatMap((suite) => {
	const appDir = path.join(repoRoot, "apps", suite.directory);
	return fs.readdirSync(path.join(appDir, "scripts"))
		.filter((name) => name.endsWith("-smoke.ts"))
		.sort()
		.map((name) => ({ name: `${suite.name}/${name}`, file: path.join(appDir, "scripts", name), tsconfig: path.join(appDir, suite.tsconfig) }));
}).filter(({ name }) => filters.length === 0 || filters.some((filter) => name.includes(filter)));

if (smokes.length === 0) {
	console.error(filters.length ? `No smokes match: ${filters.join(", ")}` : "No server or UI smokes found");
	process.exit(1);
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

function runSmoke(smoke) {
	return new Promise((resolve) => {
		const startedAt = Date.now();
		const child = spawn(process.execPath, ["--import", tsxLoader, smoke.file], {
			cwd: repoRoot,
			env: { ...process.env, TSX_TSCONFIG_PATH: smoke.tsconfig },
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
			resolve({ name: smoke.name, code: timedOut ? 1 : (code ?? 1), output, seconds: (Date.now() - startedAt) / 1000 });
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
// (... SKIPPED ...)"); an assertion that merely mentions skipping does not.
function skipLines(output) {
	return output.split("\n").map((line) => line.trim()).filter((line) => /\bsmoke\b.*\bskipped\b/i.test(line));
}

// The whole output of a failed try goes to a file in the system's temp
// folder, since the tail alone often cannot say why a smoke failed next to
// others. Not having the file never stops the run.
const failureDir = path.join(os.tmpdir(), "exxperts-smoke-failures");
function saveOutput(name, attempt, output) {
	try {
		fs.mkdirSync(failureDir, { recursive: true });
		const file = path.join(failureDir, `${name.replace(/\.ts$/, "").replace(/[\\/]/g, "-")}.${process.pid}.${attempt}.log`);
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
async function runAndReport(smoke) {
	const { name } = smoke;
	let note = "";
	if (jobs === 1) process.stdout.write(`  ${name} … `);
	let result = await runSmoke(smoke);
	const interference = isInterferenceFailure(result);
	const takenPort = interference ? undefined : portTakenFailure(result);
	const retry = interference ? "retrying after a file-permission denial outside the smoke … "
		: takenPort ? `retrying after its port ${takenPort} was taken before its server bound it … ` : "";
	if (retry) {
		const firstTry = saveOutput(name, "first-try", result.output);
		const kept = firstTry ? `(first try: ${firstTry}) ` : "";
		if (jobs === 1) process.stdout.write(`${retry}${kept}`);
		else note = `${retry}${kept}`;
		result = await runSmoke(smoke);
		result.retried = true;
	}
	if (result.code !== 0) result.savedTo = saveOutput(name, "failed", result.output);
	const skips = result.code === 0 ? skipLines(result.output) : [];
	const verdict = result.code === 0 ? `ok (${result.seconds.toFixed(1)}s)${skips.map((line) => `\n      SKIP: ${line}`).join("")}` : `FAIL (${result.seconds.toFixed(1)}s)`;
	console.log(jobs === 1 ? verdict : `  ${name} … ${note}${verdict}`);
	// Printed at once as well as in the summary: a run cut off by a CI time
	// limit still shows why the smoke failed.
	if (result.code !== 0) console.log(failureTail(result));
	return result;
}

const timings = readTimings();
const queue = jobs === 1 ? [...smokes] : [...smokes].sort((a, b) => (timings[b.name] ?? 0) - (timings[a.name] ?? 0));
const results = [];
const startedAt = Date.now();
console.log(`Running ${smokes.length} smoke${smokes.length === 1 ? "" : "s"}${jobs > 1 ? `, ${jobs} at a time` : ""}…\n`);
await Promise.all(Array.from({ length: Math.min(jobs, queue.length) }, async () => {
	for (let smoke = queue.shift(); smoke !== undefined; smoke = queue.shift()) results.push(await runAndReport(smoke));
}));
results.sort((a, b) => a.name.localeCompare(b.name));
saveTimings(timings, results);

const failed = results.filter((result) => result.code !== 0);
const total = results.reduce((sum, result) => sum + result.seconds, 0);
const skipped = results.filter((result) => result.code === 0 && skipLines(result.output).length > 0);
const retried = results.filter((result) => result.retried);
// The summary line keeps its exact form: the GitHub sync accepts a SMOKES
// stamp only as "N/N passed in Ns" (scripts/sync-github.mjs). The time on the
// clock of a parallel run goes on its own line.
console.log(`\n${results.length - failed.length}/${results.length} passed in ${Math.round(total)}s`);
if (jobs > 1) console.log(`${Math.round((Date.now() - startedAt) / 1000)}s on the clock, ${jobs} at a time`);
if (skipped.length > 0) console.log(`${skipped.length} passed with parts SKIPPED: ${skipped.map((result) => result.name).join(", ")}`);
if (retried.length > 0) console.log(`${retried.length} retried once (reasons above): ${retried.map((result) => result.name).join(", ")}`);
for (const result of failed) console.log(failureTail(result));
process.exit(failed.length === 0 ? 0 : 1);
