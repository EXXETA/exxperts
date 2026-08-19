import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SMOKE_AUTH_TOKEN, SMOKE_SERVER_AUTH_ENV, SMOKE_SERVER_SPAWN_TREE_OPTIONS, stopSmokeServer } from "./smoke-server-process.js";

// Pins the non-interactive `exxperts remote` CLI surface (bin/lib/
// remote-control.cjs) against a live server: status/hide/expose/devices/
// disable round-trips, the enable output's pairing URL (the class of bug a
// missing pin let through once: the CLI printed "undefined" instead of the
// URL), and the offline-disable fallback with its restart warning. The
// interactive pairing wait stays out (it needs a TTY answer); the enrollment
// machinery itself is pinned by remote-enroll-smoke.

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const webServerDir = path.resolve(scriptDir, "..");
const repoRoot = path.resolve(webServerDir, "..", "..");
const cliPath = path.join(repoRoot, "bin", "exxperts.cjs");
const port = 26000 + Math.floor(Math.random() * 10000);
const baseUrl = `http://127.0.0.1:${port}`;

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "exxperts-remote-cli-"));
const tempHome = path.join(tempRoot, "home");
fs.mkdirSync(path.join(tempHome, ".exxperts", "app", "personalized-agents"), { recursive: true, mode: 0o700 });

const cliEnv = {
	...process.env,
	HOME: tempHome,
	USERPROFILE: tempHome,
	...SMOKE_SERVER_AUTH_ENV,
};

function cli(...args: string[]): { status: number; out: string } {
	const res = spawnSync(process.execPath, [cliPath, "remote", ...args, "--port", String(port)], { env: cliEnv, encoding: "utf8", timeout: 30000 });
	return { status: res.status ?? -1, out: `${res.stdout ?? ""}${res.stderr ?? ""}` };
}

async function waitForServer(server: ChildProcessWithoutNullStreams): Promise<void> {
	const deadline = Date.now() + 20000;
	let lastError = "server did not respond";
	while (Date.now() < deadline) {
		if (server.exitCode != null) throw new Error(`server exited before startup with code ${server.exitCode}`);
		try {
			const response = await fetch(`${baseUrl}/healthz`);
			if (response.ok) return;
			lastError = `healthz returned ${response.status}`;
		} catch (error) {
			lastError = (error as Error).message;
		}
		await new Promise((resolve) => setTimeout(resolve, 150));
	}
	throw new Error(`server did not become ready: ${lastError}`);
}

let server: ChildProcessWithoutNullStreams | undefined;
const serverOutput: string[] = [];
try {
	// 1. Offline behaviors first, before any server exists: disable is a
	//    no-op with honest copy, and the fallback path warns about a possibly
	//    still-running app.
	const offlineNoop = cli("disable");
	assert(offlineNoop.status === 0 && offlineNoop.out.includes("already OFF"), `offline disable with no state file: expected the already-off message, got (${offlineNoop.status}) ${offlineNoop.out}`);
	fs.writeFileSync(path.join(tempHome, ".exxperts", "app", "remote-mode.json"), `${JSON.stringify({ enabled: true, enabledAt: new Date().toISOString() })}\n`, { mode: 0o600 });
	const offlineDisable = cli("disable");
	assert(offlineDisable.status === 0 && offlineDisable.out.includes("OFF on disk"), `offline disable: expected the on-disk message, got ${offlineDisable.out}`);
	assert(offlineDisable.out.includes("restart it to be sure"), "offline disable must warn that a still-running app needs a restart");
	assert(!fs.existsSync(path.join(tempHome, ".exxperts", "app", "remote-mode.json")), "offline disable must delete the state file");
	const offlineStatus = cli("status");
	assert(offlineStatus.status === 1 && offlineStatus.out.includes("not running"), `offline status: expected the not-running error, got (${offlineStatus.status}) ${offlineStatus.out}`);

	server = spawn("npx", ["tsx", "src/index.ts"], {
		shell: process.platform === "win32",
		...SMOKE_SERVER_SPAWN_TREE_OPTIONS,
		cwd: webServerDir,
		env: {
			...process.env,
			HOME: tempHome, USERPROFILE: tempHome,
			PORT: String(port),
			...SMOKE_SERVER_AUTH_ENV,
			EXXETA_HOME: repoRoot,
			EXXPERTS_CODING_AGENT_DIR: path.join(tempHome, ".exxperts", "agent"),
			EXXETA_PERSISTENT_AGENTS_ROOT: path.join(tempHome, ".exxperts", "app", "personalized-agents"),
			EXXPERTS_REMOTE_TEST_ADDRESS: "::1",
		},
	});
	server.stdout.on("data", (chunk) => serverOutput.push(String(chunk)));
	server.stderr.on("data", (chunk) => serverOutput.push(String(chunk)));
	await waitForServer(server);

	// 2. Status while off.
	const statusOff = cli("status");
	assert(statusOff.status === 0 && statusOff.out.includes("OFF") && statusOff.out.includes("loopback-only"), `status off: got ${statusOff.out}`);
	assert(statusOff.out.includes("no paired devices"), "status must render the empty device list");

	// 3. Hide/expose round-trip, including the honesty line.
	const hide = cli("hide", "smoke-room");
	assert(hide.status === 0 && hide.out.includes("hidden from remote devices"), `hide: got ${hide.out}`);
	assert(hide.out.includes("not a security control"), "hide must say it is a preference, not a security control");
	const statusHidden = cli("status");
	assert(statusHidden.out.includes("Hidden from remote: smoke-room"), "status must list hidden rooms");
	const expose = cli("expose", "smoke-room");
	assert(expose.status === 0 && expose.out.includes("reachable remotely"), `expose: got ${expose.out}`);
	assert(!cli("status").out.includes("Hidden from remote"), "status must drop the hidden line once nothing is hidden");

	// 4. Enable prints the pairing URL with a real 64-hex code (the
	//    "undefined" regression class). Stdin is closed so the approval wait
	//    cannot block; the process is killed after the output appears.
	const enableOut = await new Promise<string>((resolve, reject) => {
		const child = spawn(process.execPath, [cliPath, "remote", "enable", "--port", String(port)], { env: cliEnv, stdio: ["ignore", "pipe", "pipe"] });
		let out = "";
		const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error(`enable did not print the pairing URL in time; got: ${out}`)); }, 20000);
		const onData = (chunk: Buffer) => {
			out += String(chunk);
			if (/http:\/\/\[::1\]:\d+\/remote\/enroll\?code=[0-9a-f]{64}/.test(out)) {
				clearTimeout(timer);
				child.kill("SIGKILL");
				resolve(out);
			}
		};
		child.stdout.on("data", onData);
		child.stderr.on("data", onData);
		child.on("error", (error) => { clearTimeout(timer); reject(error); });
	});
	assert(enableOut.includes("Remote mode is ON"), "enable must announce the serving state");
	assert(!enableOut.includes("undefined"), "enable output must never contain undefined");

	// 5. Devices listing (empty) and revoke of a nonexistent id.
	const devices = cli("devices");
	assert(devices.status === 0 && devices.out.includes("no paired devices"), `devices: got ${devices.out}`);
	const revokeMissing = cli("revoke", "nope");
	assert(revokeMissing.status === 1 && revokeMissing.out.includes("No such device"), `revoke missing: got ${revokeMissing.out}`);

	// 6. Online disable through the API.
	const disable = cli("disable");
	assert(disable.status === 0 && disable.out.includes("loopback-only again"), `disable: got ${disable.out}`);
	const statusAfter = cli("status");
	assert(statusAfter.out.includes("OFF"), "status after disable must be off");

	console.log("remote cli smoke passed");
} catch (error) {
	console.error(serverOutput.join(""));
	throw error;
} finally {
	await stopSmokeServer(server);
}
