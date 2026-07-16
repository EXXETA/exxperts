#!/usr/bin/env node
// Bare-machine smoke for a prebuilt release archive (see bundle-release.mjs).
//
//   node scripts/smoke-release-archive.mjs <archive-path>
//
// Proves the archive is genuinely self-contained: it is unpacked to a temp
// dir and its shim is run with a SANITIZED environment (PATH reduced to OS
// system dirs, HOME/USERPROFILE pointed at a fresh temp dir, no NODE_*/npm_*
// leakage), so any accidental dependency on a system node, npm or git fails
// loudly here instead of on a user's machine.
//
// Steps (each prints pass/fail; exit 0 only if all pass):
//   1. `exxperts --version` prints "exxperts <version>" (version read from
//      the archive's app/package.json).
//   2. `exxperts web --no-open --port <free port>` boots the real web server
//      (tsx compiling the TS sources with the vendored node) and serves HTTP
//      on /healthz and /; then the whole process tree is torn down.
//
// State discipline: HOME/USERPROFILE point at a temp dir, so the launcher's
// first-run dirs (~/.exxperts/app) land there, never in the real home.

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";

const archiveArg = process.argv[2];
if (!archiveArg) {
	console.error("Usage: node scripts/smoke-release-archive.mjs <archive-path>");
	process.exit(2);
}
const archivePath = path.resolve(archiveArg);
if (!fs.existsSync(archivePath)) {
	console.error(`[smoke-release] archive not found: ${archivePath}`);
	process.exit(2);
}

const isWin = process.platform === "win32";

function log(msg) {
	console.log(`[smoke-release] ${msg}`);
}

let failed = false;
function step(name, ok, detail = "") {
	console.log(`[smoke-release] ${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` (${detail})` : ""}`);
	if (!ok) failed = true;
}

// ---------------------------------------------------------------------------
// Unpack to a temp dir.
// ---------------------------------------------------------------------------

const work = fs.mkdtempSync(path.join(os.tmpdir(), "exxperts-smoke-"));
const fakeHome = path.join(work, "home");
fs.mkdirSync(fakeHome, { recursive: true });

log(`unpacking ${path.basename(archivePath)}...`);
// The .zip case only occurs for win-x64 archives, which are smoked on
// Windows. PATH tar there can be GNU tar from Git for Windows (a bash shell
// step puts it first), which cannot read zip; System32 tar.exe is bsdtar and
// reads zip natively, so prefer it by absolute path. GNU/bsd tar both
// autodetect gzip for the POSIX .tar.gz case.
const systemRoot = process.env.SystemRoot || "C:\\Windows";
const system32Tar = path.join(systemRoot, "System32", "tar.exe");
const tarBin = isWin && fs.existsSync(system32Tar) ? system32Tar : "tar";
const untar = spawnSync(tarBin, ["-xf", archivePath, "-C", work], { stdio: "inherit" });
if (untar.status !== 0) {
	if (isWin && archivePath.endsWith(".zip")) {
		// Last resort without bsdtar: PowerShell Expand-Archive understands zip
		// on any Windows.
		log("tar could not unpack the zip; falling back to PowerShell Expand-Archive...");
		const expand = spawnSync("powershell", [
			"-NoProfile",
			"-Command",
			`Expand-Archive -Path '${archivePath.replace(/'/g, "''")}' -DestinationPath '${work.replace(/'/g, "''")}' -Force`,
		], { stdio: "inherit" });
		if (expand.status !== 0) {
			console.error("[smoke-release] failed to unpack the archive");
			process.exit(1);
		}
	} else {
		console.error("[smoke-release] failed to unpack the archive");
		process.exit(1);
	}
}

const top = path.join(work, "exxperts");
const shim = path.join(top, isWin ? "exxperts.cmd" : "exxperts");
const appPkgPath = path.join(top, "app", "package.json");
if (!fs.existsSync(shim) || !fs.existsSync(appPkgPath)) {
	console.error(`[smoke-release] archive layout unexpected: missing ${fs.existsSync(shim) ? appPkgPath : shim}`);
	process.exit(1);
}
const version = JSON.parse(fs.readFileSync(appPkgPath, "utf8")).version;

// ---------------------------------------------------------------------------
// Sanitized environment: built from scratch, never filtered from
// process.env, so nothing (NODE_OPTIONS, npm_config_*, NVM paths) can leak
// in. PATH keeps only OS system dirs: enough for /bin/sh in the POSIX shim
// and OS-level libs, but with no node/npm/git on it.
// ---------------------------------------------------------------------------

// The per-user and machine-wide data dirs point under the fake home too, so
// anything the launcher writes through them stays out of the real profile.
const fakeAppData = path.join(fakeHome, "AppData", "Roaming");
const fakeLocalAppData = path.join(fakeHome, "AppData", "Local");
const fakeProgramData = path.join(fakeHome, "ProgramData");
if (isWin) {
	for (const dir of [fakeAppData, fakeLocalAppData, fakeProgramData]) fs.mkdirSync(dir, { recursive: true });
}
const sanitizedEnv = isWin
	? {
			PATH: [
				path.join(systemRoot, "System32"),
				systemRoot,
				path.join(systemRoot, "System32", "Wbem"),
				path.join(systemRoot, "System32", "WindowsPowerShell", "v1.0"),
			].join(";"),
			SystemRoot: systemRoot,
			windir: systemRoot,
			SystemDrive: process.env.SystemDrive || systemRoot.slice(0, 2),
			ComSpec: process.env.ComSpec || path.join(systemRoot, "System32", "cmd.exe"),
			// Without PATHEXT cmd.exe cannot resolve extension-less commands;
			// the explicit default list keeps the env reproducible.
			PATHEXT: process.env.PATHEXT || ".COM;.EXE;.BAT;.CMD;.VBS;.VBE;.JS;.JSE;.WSF;.WSH;.MSC",
			USERPROFILE: fakeHome,
			// Some Windows APIs consult these instead of USERPROFILE.
			HOMEDRIVE: fakeHome.slice(0, 2),
			HOMEPATH: fakeHome.slice(2),
			APPDATA: fakeAppData,
			LOCALAPPDATA: fakeLocalAppData,
			PROGRAMDATA: fakeProgramData,
			TEMP: work,
			TMP: work,
		}
	: {
			PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
			HOME: fakeHome,
			TMPDIR: work,
		};

// ---------------------------------------------------------------------------
// Process-tree teardown (same discipline as apps/web-server/scripts/
// smoke-server-process.ts): the shim execs node, which spawns tsx, which is
// the actual server, so a plain SIGTERM to the shim's pid leaves the server
// running on Linux. POSIX spawns detached (own process group) and signals
// the group; Windows uses taskkill /T.
// ---------------------------------------------------------------------------

function killTree(pid, signal) {
	if (isWin) {
		spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore" });
		return;
	}
	try { process.kill(-pid, signal); } catch { try { process.kill(pid, signal); } catch {} }
}

let server;
// A POSIX child killed by an unhandled signal (the normal SIGTERM outcome
// here) has exitCode null and signalCode set, so checking exitCode alone
// would misread a clean teardown as a live process, escalate to a pointless
// SIGKILL, and fail the final assertion.
function serverDead() {
	return server.exitCode != null || server.signalCode != null;
}
async function stopServer() {
	if (!server || serverDead() || server.pid == null) return;
	const exited = new Promise((resolve) => server.once("exit", resolve));
	const waitUpTo = (ms) => Promise.race([exited, new Promise((resolve) => setTimeout(resolve, ms))]);
	killTree(server.pid, "SIGTERM");
	await waitUpTo(10_000);
	if (!serverDead()) {
		killTree(server.pid, "SIGKILL");
		await waitUpTo(5_000);
	}
}
// Last-resort teardown if the smoke itself dies mid-run: leftover server
// processes holding ports are a known CI pain.
process.on("exit", () => {
	if (server && !serverDead() && server.pid != null) killTree(server.pid, "SIGKILL");
	try { fs.rmSync(work, { recursive: true, force: true }); } catch {}
});
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => process.exit(1));

function runShim(args, opts = {}) {
	// .cmd files are not executables; cmd.exe must run them. POSIX shims have
	// a #!/bin/sh shebang and are directly spawnable. On Windows the /c tail
	// is built by hand under windowsVerbatimArguments: cmd /s strips the
	// outermost quote pair from the tail, so Node's default per-arg quoting
	// breaks a shim path containing spaces; the canonical form wraps the
	// whole individually-quoted command in one extra pair of quotes.
	if (isWin) {
		const tail = `/d /s /c "${[shim, ...args].map((a) => `"${a}"`).join(" ")}"`;
		return {
			cmd: sanitizedEnv.ComSpec,
			cmdArgs: [tail],
			spawnOpts: { env: sanitizedEnv, cwd: top, windowsVerbatimArguments: true, ...opts },
		};
	}
	return { cmd: shim, cmdArgs: args, spawnOpts: { env: sanitizedEnv, cwd: top, ...opts } };
}

// ---------------------------------------------------------------------------
// Step 1: --version.
// ---------------------------------------------------------------------------

{
	const { cmd, cmdArgs, spawnOpts } = runShim(["--version"]);
	const res = spawnSync(cmd, cmdArgs, { ...spawnOpts, encoding: "utf8", timeout: 60_000 });
	const output = (res.stdout ?? "").trim();
	const expected = `exxperts ${version}`;
	step("--version under sanitized env", res.status === 0 && output === expected, `got "${output || res.stderr?.trim() || `exit ${res.status}`}", want "${expected}"`);
	if (failed) process.exit(1);
}

// ---------------------------------------------------------------------------
// Step 2: boot the web server through the product path, assert HTTP, tear
// down. --no-open is the launcher's real browser-suppression flag (see
// bin/lib/web-launcher.cjs), so CI never hangs on xdg-open/open.
// ---------------------------------------------------------------------------

const port = await freePort();
{
	const { cmd, cmdArgs, spawnOpts } = runShim(["web", "--no-open", "--port", String(port)]);
	server = spawn(cmd, cmdArgs, {
		...spawnOpts,
		stdio: ["ignore", "pipe", "pipe"],
		...(isWin ? {} : { detached: true }),
	});
	let serverOutput = "";
	server.stdout.on("data", (c) => { serverOutput += c; });
	server.stderr.on("data", (c) => { serverOutput += c; });

	// Generous ceiling: first boot compiles the TS server through tsx with a
	// cold esbuild cache.
	const deadline = Date.now() + 180_000;
	let healthy = false;
	while (Date.now() < deadline) {
		if (serverDead()) break;
		if (await httpStatus(`http://127.0.0.1:${port}/healthz`) === 200) { healthy = true; break; }
		await new Promise((r) => setTimeout(r, 500));
	}
	step("web server answers /healthz", healthy, healthy ? `port ${port}` : `server ${serverDead() ? `exited (${server.exitCode ?? server.signalCode})` : "never became healthy"}`);

	if (healthy) {
		const rootStatus = await httpStatus(`http://127.0.0.1:${port}/`);
		step("web server serves / (UI)", rootStatus === 200, `HTTP ${rootStatus}`);
	}

	await stopServer();
	step("server tree torn down", serverDead() || server.pid == null);

	if (failed) {
		console.error("\n[smoke-release] server output (tail):");
		console.error(serverOutput.split("\n").slice(-40).join("\n"));
	}
}

if (!failed) log(`all steps passed for ${path.basename(archivePath)} (version ${version})`);
process.exit(failed ? 1 : 0);

// ---------------------------------------------------------------------------

function freePort() {
	// Ask the OS for an ephemeral port, then release it for the server. A
	// small race window exists, but this matches the repo's smoke pattern and
	// avoids hardcoded ports colliding across CI jobs.
	return new Promise((resolve, reject) => {
		const srv = net.createServer();
		srv.listen(0, "127.0.0.1", () => {
			const { port } = srv.address();
			srv.close(() => resolve(port));
		});
		srv.on("error", reject);
	});
}

function httpStatus(url) {
	return new Promise((resolve) => {
		const req = http.get(url, (res) => {
			res.resume();
			resolve(res.statusCode ?? 0);
		});
		req.on("error", () => resolve(0));
		req.setTimeout(2_000, () => { req.destroy(); resolve(0); });
	});
}
