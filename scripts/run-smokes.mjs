#!/usr/bin/env node
// Runs the web-server smoke suite: every apps/web-server/scripts/*-smoke.ts,
// sequentially (smokes bind ports and isolate HOME; parallel runs would race).
// Usage: npm run smokes [-- <filter>...]  — filters are substrings of the
// smoke file name; any match includes the smoke.
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { pathToFileURL, fileURLToPath } from "node:url";
import fs from "node:fs";
import path from "node:path";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const smokeDir = path.join(repoRoot, "apps", "web-server", "scripts");
const require = createRequire(import.meta.url);
// --import needs a URL, not a bare path — a Windows drive-letter path would be misparsed.
const tsxLoader = pathToFileURL(require.resolve("tsx/esm")).href;

const filters = process.argv.slice(2).filter((arg) => !arg.startsWith("-"));
const smokes = fs.readdirSync(smokeDir)
	.filter((name) => name.endsWith("-smoke.ts"))
	.filter((name) => filters.length === 0 || filters.some((f) => name.includes(f)))
	.sort();

if (smokes.length === 0) {
	console.error(filters.length ? `No smokes match: ${filters.join(", ")}` : `No smokes found in ${smokeDir}`);
	process.exit(1);
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

function runSmoke(name) {
	return new Promise((resolve) => {
		const startedAt = Date.now();
		const child = spawn(process.execPath, ["--import", tsxLoader, path.join(smokeDir, name)], {
			cwd: repoRoot,
			stdio: ["ignore", "pipe", "pipe"],
			...(process.platform === "win32" ? {} : { detached: true }),
		});
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
			clearTimeout(timer);
			resolve({ name, code: timedOut ? 1 : (code ?? 1), output, seconds: (Date.now() - startedAt) / 1000 });
		});
	});
}

const results = [];
console.log(`Running ${smokes.length} smoke${smokes.length === 1 ? "" : "s"}…\n`);
for (const name of smokes) {
	process.stdout.write(`  ${name} … `);
	const result = await runSmoke(name);
	results.push(result);
	console.log(result.code === 0 ? `ok (${result.seconds.toFixed(1)}s)` : `FAIL (${result.seconds.toFixed(1)}s)`);
}

const failed = results.filter((result) => result.code !== 0);
const total = results.reduce((sum, result) => sum + result.seconds, 0);
console.log(`\n${results.length - failed.length}/${results.length} passed in ${Math.round(total)}s`);
for (const result of failed) {
	console.log(`\n--- ${result.name} (exit ${result.code}) ---`);
	// Last lines carry the assertion message; full logs would drown the summary.
	console.log(result.output.split("\n").slice(-25).join("\n"));
}
process.exit(failed.length === 0 ? 0 : 1);
