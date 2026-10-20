// A smoke's server never outlives the smoke, however the smoke ends
// (smoke-server-process.ts). A child run of this file plays a route smoke: it
// starts the web server as they do (npx, tsx, then node, in the process group
// of its own that SMOKE_SERVER_SPAWN_TREE_OPTIONS gives it), says the server's
// process group and port, and is then ended the way each hard stop ends one:
// - the runner's timeout: SIGKILL to the smoke's whole process group
//   (killSmokeTree in scripts/run-smokes.mjs);
// - Ctrl-C: SIGINT to the smoke's process group;
// - SIGTERM to the smoke alone;
// - an exit that skips the smoke's own clean-up (a failure path's process.exit).
// After each, no process of the server's group may be left and its port must
// be closed within 20 seconds, and nothing that stopped it may be left either.
// A server found left is stopped here before the failure is reported, so a
// failing run leaves nothing running. POSIX only: on Windows the runner ends a
// smoke with taskkill /T, which ends its server with it.

import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { SMOKE_SERVER_AUTH_ENV, SMOKE_SERVER_SPAWN_TREE_OPTIONS, smokeHomeEnv, stopSmokeServer } from "./smoke-server-process.js";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const webServerDir = path.resolve(scriptDir, "..");
const repoRoot = path.resolve(webServerDir, "..", "..");

const ENDINGS = {
	timeout: "the runner's timeout (SIGKILL to the smoke's process group)",
	"ctrl-c": "Ctrl-C (SIGINT to the smoke's process group)",
	sigterm: "SIGTERM to the smoke alone",
	exit: "an exit that skips the smoke's clean-up",
} as const;
type Ending = keyof typeof ENDINGS;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function freePort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const probe = net.createServer();
		probe.once("error", reject);
		probe.listen(0, "127.0.0.1", () => {
			const { port } = probe.address() as net.AddressInfo;
			probe.close(() => resolve(port));
		});
	});
}

// --- The played smoke: starts the server as the route smokes do, then waits to be ended. ---

async function playSmoke(ending: Ending): Promise<void> {
	const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "exxperts-smoke-server-process-"));
	const tempHome = path.join(tempRoot, "home");
	fs.mkdirSync(tempHome, { recursive: true, mode: 0o700 });
	const port = await freePort();
	// Offline: no provider key or token reaches the server; the smoke token is added after.
	const env = smokeHomeEnv(tempHome);
	for (const name of Object.keys(env)) if (/(_API_KEY|_TOKEN)$/.test(name)) delete env[name];
	Object.assign(env, {
		PORT: String(port),
		...SMOKE_SERVER_AUTH_ENV,
		EXXETA_HOME: repoRoot,
		EXXPERTS_CODING_AGENT_DIR: path.join(tempHome, ".exxperts", "agent"),
		EXXETA_PERSISTENT_AGENTS_ROOT: path.join(tempHome, ".exxperts", "app", "personalized-agents"),
	});
	const server: ChildProcessWithoutNullStreams = spawn("npx", ["tsx", "src/index.ts"], {
		shell: process.platform === "win32",
		...SMOKE_SERVER_SPAWN_TREE_OPTIONS,
		cwd: webServerDir,
		env: env as NodeJS.ProcessEnv,
	});
	const output: string[] = [];
	server.stdout.on("data", (chunk) => output.push(String(chunk)));
	server.stderr.on("data", (chunk) => output.push(String(chunk)));
	const deadline = Date.now() + 90_000;
	while (!(await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(2_000) }).then((r) => r.ok, () => false))) {
		if (server.exitCode != null || Date.now() > deadline) {
			console.error(output.join("").slice(-4000));
			await stopSmokeServer(server);
			fs.rmSync(tempRoot, { recursive: true, force: true });
			throw new Error(server.exitCode != null ? `the server exited before /healthz answered (code ${server.exitCode})` : "the server did not answer /healthz within 90 seconds");
		}
		await sleep(150);
	}
	const ready = `ready ${server.pid} ${port} ${tempRoot}\n`;
	// The exit comes once the line is out, as a failure path's process.exit would, with no clean-up.
	if (ending === "exit") process.stdout.write(ready, () => process.exit(1));
	else process.stdout.write(ready);
	// Otherwise it waits to be ended: the server's pipes keep this process alive.
}

// --- The check: plays each ending and looks for what is left. ---

/** Whether any process of the process group is left. */
function groupLeft(pgid: number): boolean {
	try {
		process.kill(-pgid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

function portOpen(port: number): Promise<boolean> {
	return new Promise((resolve) => {
		const socket = net.connect(port, "127.0.0.1");
		socket.once("connect", () => {
			socket.destroy();
			resolve(true);
		});
		socket.once("error", () => resolve(false));
	});
}

/** The watchdogs still running for the played smoke (smoke-server-process.ts marks each with its smoke's pid): what stops the server must not be left either. */
function watchdogsLeft(smokePid: number): { pids: number[]; checked: boolean } {
	const ps = spawnSync("ps", ["-A", "-ww", "-o", "pid=,command="], { encoding: "utf8" });
	if (ps.status !== 0 || typeof ps.stdout !== "string") return { pids: [], checked: false };
	const pids = ps.stdout
		.split("\n")
		.filter((line) => line.includes(`exxperts-smoke-watchdog ${smokePid}`))
		.map((line) => Number.parseInt(line, 10))
		.filter((pid) => pid > 0);
	return { pids, checked: true };
}

async function playAndEnd(ending: Ending, tsxLoader: string, thisFile: string): Promise<{ failure?: string; note?: string }> {
	// As the runner starts a smoke: node with the tsx loader, in a process group of its own.
	const smoke = spawn(process.execPath, ["--import", tsxLoader, thisFile, "--as-smoke", ending], { cwd: repoRoot, stdio: ["ignore", "pipe", "pipe"], detached: true });
	let output = "";
	smoke.stdout.on("data", (chunk) => { output += chunk; });
	smoke.stderr.on("data", (chunk) => { output += chunk; });
	const exited = new Promise<void>((resolve) => smoke.once("exit", () => resolve()));
	let closed = false;
	smoke.once("close", () => { closed = true; });
	const smokePid = smoke.pid!;
	const startedBy = Date.now() + 120_000;
	let ready: RegExpExecArray | null;
	while (!(ready = /^ready (\d+) (\d+) (.+)$/m.exec(output))) {
		if (closed || Date.now() > startedBy) {
			try { process.kill(-smokePid, "SIGKILL"); } catch {}
			return { failure: `the played smoke did not start its server: ${output.trim().split("\n").slice(-12).join("\n")}` };
		}
		await sleep(100);
	}
	const pgid = Number(ready[1]);
	const port = Number(ready[2]);
	const tempRoot = ready[3];
	try {
		if (ending === "timeout") process.kill(-smokePid, "SIGKILL");
		else if (ending === "ctrl-c") process.kill(-smokePid, "SIGINT");
		else if (ending === "sigterm") process.kill(smokePid, "SIGTERM");
		let endTimer: NodeJS.Timeout | undefined;
		await Promise.race([exited, new Promise<void>((resolve) => { endTimer = setTimeout(resolve, 10_000); })]);
		clearTimeout(endTimer);
		if (smoke.exitCode == null && smoke.signalCode == null) {
			try { process.kill(-smokePid, "SIGKILL"); } catch {}
			return { failure: "the played smoke did not end" };
		}
		const deadline = Date.now() + 20_000;
		while (groupLeft(pgid) || (await portOpen(port))) {
			if (Date.now() > deadline) {
				const open = await portOpen(port);
				return { failure: `the server was still running 20 s after the smoke ended (process group ${pgid}${groupLeft(pgid) ? " has processes" : ""}${open ? `, port ${port} open` : ""}); stopped here` };
			}
			await sleep(200);
		}
		let left = watchdogsLeft(smokePid);
		for (const until = Date.now() + 5_000; left.pids.length > 0 && Date.now() < until; left = watchdogsLeft(smokePid)) await sleep(200);
		if (left.pids.length > 0) {
			for (const pid of left.pids) try { process.kill(pid, "SIGKILL"); } catch {}
			return { failure: `the server is gone, but its watchdog was still running 5 s later (${left.pids.join(", ")}); stopped here` };
		}
		return left.checked ? {} : { note: "ps could not run, so the watchdog was not looked for" };
	} finally {
		// Whatever this check finds left is stopped here (a gone group answers ESRCH).
		try { process.kill(-pgid, "SIGKILL"); } catch {}
		fs.rmSync(tempRoot, { recursive: true, force: true });
	}
}

if (process.argv[2] === "--as-smoke") {
	await playSmoke(process.argv[3] as Ending);
} else if (process.platform === "win32") {
	console.log("smoke-server-process smoke skipped: process groups are POSIX only; on Windows the runner's taskkill /T ends a smoke's server with it");
} else {
	const tsxLoader = pathToFileURL(createRequire(import.meta.url).resolve("tsx/esm")).href;
	const thisFile = fileURLToPath(import.meta.url);
	const endings = Object.keys(ENDINGS) as Ending[];
	const results = await Promise.all(endings.map((ending) => playAndEnd(ending, tsxLoader, thisFile).catch((error: unknown) => ({ failure: `the check threw: ${error instanceof Error ? error.message : String(error)}` }) as { failure?: string; note?: string })));
	const failures: string[] = [];
	endings.forEach((ending, index) => {
		const result = results[index];
		if (result.failure) {
			failures.push(`${ENDINGS[ending]}: ${result.failure}`);
			console.log(`  FAIL ${ENDINGS[ending]}`);
		} else {
			console.log(`  ok  ${ENDINGS[ending]}: no server is left${result.note ? ` (${result.note})` : ", nor anything that stopped it"}`);
		}
	});
	if (failures.length > 0) throw new Error(`${failures.length} ending(s) left the smoke's server running:\n${failures.join("\n")}`);
	console.log("smoke-server-process smoke passed");
}
