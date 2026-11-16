// The Windows design's tripwire: every filesystem call and program start the
// server process itself makes in a room's folders and the design's other
// trees, recorded from a real run, never read from the code.
//
// Each run is a process of its own, started with the recorder
// (scripts/tripwire/recorder.mjs) loaded by --import before the server and the
// runtime: the Mac box on, as this Mac runs; Windows mode
// (EXXPERTS_TEST_SHELL_PLATFORM=win32), with today's fence on the server; and
// Windows mode again with the agent folder, the connector settings and the
// rooms' data moved outside `.exxperts` by their settings. The run
// (scripts/tripwire/run.ts) proves the recorder sees first, drives every
// route and tool, and fails on a touch at a site the known list
// (scripts/tripwire/known-sites.ts) doesn't name, and on a listed site it no
// longer sees.
//
// Before the runs, a source check: the server and the runtime never reach
// Node's internal bindings, which would go around the wrappers.
//
// macOS only: the Mac box run needs this Mac's protection, and the layout's
// paths are a Mac's. Run: npm run smokes -- server-touch-tripwire
// With TRIPWIRE_INVENTORY=<file.md>, each run's sites are written there too.
import { spawn } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { inventory, RUN_NAMES, type RunSites } from "./tripwire/inventory.js";
import { recorderFolders } from "./tripwire/layout.js";

const RUNS = ["mac", "win32", "moved"] as const;

if (process.platform !== "darwin") {
	console.log("server touch tripwire smoke skipped: it runs only on macOS");
	process.exit(0);
}

const repoRoot = path.resolve(import.meta.dirname, "..", "..", "..");
const failures: string[] = [];

// --- Nothing of the server's or the runtime's reaches Node's internal bindings.
const SOURCES = ["apps/web-server/src", "bin/lib", "runtime/packages/ai/src", "runtime/packages/agent/src", "runtime/packages/coding-agent/src", "runtime/packages/tui/src", "pi-package"];
const reaching: string[] = [];
function scan(folder: string): void {
	for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
		const full = path.join(folder, entry.name);
		if (entry.isDirectory()) {
			// A scripts folder holds tests and tools, which never run in the server.
			if (entry.name !== "node_modules" && entry.name !== "scripts") scan(full);
		} else if (/\.(?:[cm]?[jt]s|tsx)$/.test(entry.name) && /\bprocess\.binding\s*\(|\bprocess\s*\[\s*["'`]binding|\binternalBinding\s*\(/.test(fs.readFileSync(full, "utf8"))) {
			reaching.push(path.relative(repoRoot, full)); // portability-ok: shown only, and this smoke runs only on macOS
		}
	}
}
for (const folder of SOURCES) scan(path.join(repoRoot, folder));
if (reaching.length > 0) failures.push(`the server or the runtime reaches Node's internal bindings, around the recorder: ${reaching.join(", ")}`);
else console.log("  ok   no server or runtime code reaches process.binding or internalBinding");

// --- The runs, one after the other: each holds a server.
const tsxLoader = pathToFileURL(createRequire(import.meta.url).resolve("tsx/esm")).href;
const recorder = pathToFileURL(path.join(import.meta.dirname, "tripwire", "recorder.mjs")).href;
const recorded: RunSites[] = [];
for (const run of RUNS) {
	// Under /tmp, not the system's long temp folder: the box's socket in the test's shared temp must fit a socket path's 104 bytes.
	const root = fs.realpathSync(fs.mkdtempSync(path.join("/tmp", `exxperts-tw-${run}-`)));
	const folders = recorderFolders(root, run);
	const startedAt = Date.now();
	const sitesFile = path.join(root, "sites.json");
	const child = spawn(process.execPath, ["--import", tsxLoader, "--import", recorder, path.join(import.meta.dirname, "tripwire", "run.ts"), run], {
		cwd: repoRoot,
		env: { ...process.env, TRIPWIRE_ROOT: root, TRIPWIRE_WATCH: folders.watch.join(path.delimiter), TRIPWIRE_IGNORE: folders.ignore.join(path.delimiter), TRIPWIRE_SITES: sitesFile },
		stdio: ["ignore", "inherit", "inherit"],
	});
	const code = await new Promise<number>((resolve) => child.once("close", (exit) => resolve(exit ?? 1)));
	console.log(`  ${code === 0 ? "ok  " : "FAIL"} the ${RUN_NAMES[run]} run (${Math.round((Date.now() - startedAt) / 1000)} s)`);
	if (code !== 0) failures.push(`the ${run} run`);
	if (fs.existsSync(sitesFile)) recorded.push({ run, sites: JSON.parse(fs.readFileSync(sitesFile, "utf8")) });
	fs.rmSync(root, { recursive: true, force: true });
}

if (process.env.TRIPWIRE_INVENTORY) {
	fs.writeFileSync(process.env.TRIPWIRE_INVENTORY, inventory(recorded));
	fs.writeFileSync(`${process.env.TRIPWIRE_INVENTORY}.json`, JSON.stringify(recorded, null, 1));
}
console.log(`server touch tripwire smoke: ${failures.length === 0 ? "passed" : `failed: ${failures.join("; ")}`}`);
process.exit(failures.length > 0 ? 1 : 0);
