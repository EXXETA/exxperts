import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { authedFetch, SMOKE_SERVER_AUTH_ENV, SMOKE_SERVER_SPAWN_TREE_OPTIONS, stopSmokeServer } from "./smoke-server-process.js";
import { detectTailnetAddress, isTailnetAddress } from "../src/remote-mode.js";

// Pins remote mode's state machinery and its two structural invariants
// (src/remote-mode.ts + the /api/remote admin routes):
//
// 1. OFF is byte-identical to today: with no state file there is no tunnel
//    listener, and a MALFORMED state file boots the server with remote off
//    and a reason, never a failed boot.
// 2. A remote failure never takes the loopback listener down: dropping the
//    tunnel listener mid-run leaves loopback serving.
//
// The tailnet is faked via EXXPERTS_REMOTE_TEST_ADDRESS=::1 (the primary
// listener binds 127.0.0.1 IPv4 only, so the same port is free on IPv6
// loopback). That exercises the real lifecycle paths; the CGNAT/fd7a range
// arithmetic is asserted directly against the exported predicate below.

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

// 1. The address-shape predicates, directly.
for (const [address, expected] of [
	["100.64.0.1", true],
	["100.127.255.254", true],
	["100.63.255.255", false],
	["100.128.0.1", false],
	["100.100.100.100", true],
	["127.0.0.1", false],
	["192.168.1.20", false],
	["fd7a:115c:a1e0::1", true],
	["FD7A:115C:A1E0:ab12::7", true],
	["fd7a:115c:a1e1::1", false],
	["::1", false],
	["not-an-address", false],
] as const) {
	assert(isTailnetAddress(address) === expected, `isTailnetAddress(${address}): expected ${expected}`);
}
// The env override must win over interface scanning (it is how this smoke
// fakes a tailnet below).
process.env.EXXPERTS_REMOTE_TEST_ADDRESS = "::1";
assert(detectTailnetAddress() === "::1", "detectTailnetAddress must honor the test env override");
delete process.env.EXXPERTS_REMOTE_TEST_ADDRESS;

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const webServerDir = path.resolve(scriptDir, "..");
const repoRoot = path.resolve(webServerDir, "..", "..");
const port = 26000 + Math.floor(Math.random() * 10000);
const baseUrl = `http://127.0.0.1:${port}`;
const tunnelUrl = `http://[::1]:${port}`;

function makeTempHome(): string {
	const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "exxperts-remote-state-"));
	const tempHome = path.join(tempRoot, "home");
	fs.mkdirSync(path.join(tempHome, ".exxperts", "app", "personalized-agents"), { recursive: true, mode: 0o700 });
	return tempHome;
}

function spawnServer(tempHome: string, extraEnv: Record<string, string>): ChildProcessWithoutNullStreams {
	return spawn("npx", ["tsx", "src/index.ts"], {
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
			...extraEnv,
		},
	});
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

// The tunnel listener may come up moments after healthz (boot-state apply is
// post-listen), so tunnel probes retry briefly before concluding.
async function tunnelReachable(): Promise<boolean> {
	try {
		await fetch(`${tunnelUrl}/healthz`, { signal: AbortSignal.timeout(1500) });
		return true;
	} catch {
		return false;
	}
}

async function waitForTunnel(expected: boolean, label: string): Promise<void> {
	const deadline = Date.now() + 8000;
	while (Date.now() < deadline) {
		if ((await tunnelReachable()) === expected) return;
		await new Promise((resolve) => setTimeout(resolve, 150));
	}
	throw new Error(`${label}: tunnel listener did not become ${expected ? "reachable" : "unreachable"}`);
}

async function remoteStatus(): Promise<{ enabled: boolean; address: string | null; degradedReason: string | null; stateFile: string; keepAwake: boolean }> {
	const response = await authedFetch(`${baseUrl}/api/remote/status`);
	assert(response.status === 200, `remote status: expected 200, got ${response.status}`);
	return (await response.json()) as any;
}

let server: ChildProcessWithoutNullStreams | undefined;
const serverOutput: string[] = [];
function watch(child: ChildProcessWithoutNullStreams): ChildProcessWithoutNullStreams {
	child.stdout.on("data", (chunk) => serverOutput.push(String(chunk)));
	child.stderr.on("data", (chunk) => serverOutput.push(String(chunk)));
	return child;
}

try {
	// 2. OFF: no state file, no test env. Status reports off, no tunnel
	//    listener exists, enable without a tailnet address fails cleanly, and
	//    the test route is absent outside test mode.
	{
		const home = makeTempHome();
		server = watch(spawnServer(home, {}));
		await waitForServer(server);

		const off = await remoteStatus();
		assert(off.enabled === false, "off: expected enabled false");
		assert(off.address === null, "off: expected null address");
		assert(off.stateFile === "absent", `off: expected stateFile absent, got ${off.stateFile}`);
		assert(off.keepAwake === true, "off: keepAwake must default to true");
		assert(!(await tunnelReachable()), "off: no tunnel listener may exist");

		// This machine may or may not have a real tailnet; only assert the
		// no-address failure shape when there is none to find.
		if (!detectTailnetAddress()) {
			const enable = await authedFetch(`${baseUrl}/api/remote/enable`, { method: "POST" });
			assert(enable.status === 412, `enable without tailnet: expected 412, got ${enable.status}`);
			assert(((await enable.json()) as any).code === "no_tunnel_address", "enable without tailnet: expected no_tunnel_address");
			assert(!fs.existsSync(path.join(home, ".exxperts", "app", "remote-mode.json")), "failed enable must not persist a state file");
		}

		const testRoute = await authedFetch(`${baseUrl}/api/remote/test/drop-listener`, { method: "POST" });
		assert(testRoute.status === 404, `test route outside test mode: expected 404, got ${testRoute.status}`);

		await stopSmokeServer(server);
	}

	// 3. MALFORMED state file: the boot succeeds, remote is off with a
	//    degraded reason, loopback serves.
	{
		const home = makeTempHome();
		fs.writeFileSync(path.join(home, ".exxperts", "app", "remote-mode.json"), "{not json", { mode: 0o600 });
		server = watch(spawnServer(home, {}));
		await waitForServer(server);

		const status = await remoteStatus();
		assert(status.enabled === false, "malformed: expected enabled false");
		assert(status.stateFile === "malformed", `malformed: expected stateFile malformed, got ${status.stateFile}`);
		assert(String(status.degradedReason ?? "").includes("malformed"), "malformed: degradedReason must say so");

		await stopSmokeServer(server);
	}

	// 4. Lifecycle under a faked tailnet (::1): enable binds, disable unbinds
	//    and deletes the state file, drop-listener degrades while loopback
	//    keeps serving, and a persisted state file brings the listener up at
	//    boot.
	{
		const home = makeTempHome();
		const stateFile = path.join(home, ".exxperts", "app", "remote-mode.json");
		server = watch(spawnServer(home, { EXXPERTS_REMOTE_TEST_ADDRESS: "::1" }));
		await waitForServer(server);

		const enable = await authedFetch(`${baseUrl}/api/remote/enable`, { method: "POST" });
		assert(enable.status === 200, `enable: expected 200, got ${enable.status}`);
		assert(((await enable.json()) as any).address === "::1", "enable: expected the test address");
		await waitForTunnel(true, "after enable");
		assert(fs.existsSync(stateFile), "enable must persist the state file");
		const enabled = await remoteStatus();
		assert(enabled.enabled === true && enabled.address === "::1", "status after enable must show the listener");
		assert(enabled.keepAwake === true, "keepAwake must stay true through an enable");
		assert((JSON.parse(fs.readFileSync(stateFile, "utf8")) as any).keepAwake === true, "enable must persist keepAwake in the state file");

		// Keep-awake setter: a non-boolean refuses, false persists to the
		// state file and survives a fresh status read.
		const badKeepAwake = await authedFetch(`${baseUrl}/api/remote/keep-awake`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ keepAwake: "nope" }) });
		assert(badKeepAwake.status === 400, `keep-awake with a non-boolean: expected 400, got ${badKeepAwake.status}`);
		const keepAwakeOff = await authedFetch(`${baseUrl}/api/remote/keep-awake`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ keepAwake: false }) });
		assert(keepAwakeOff.status === 200, `keep-awake off: expected 200, got ${keepAwakeOff.status}`);
		assert(((await keepAwakeOff.json()) as any).status.keepAwake === false, "keep-awake off must answer with the new value");
		assert((await remoteStatus()).keepAwake === false, "keep-awake false must survive a fresh status read");
		assert((JSON.parse(fs.readFileSync(stateFile, "utf8")) as any).keepAwake === false, "keep-awake false must persist in the state file");

		// The failure path: remote degrades to off, loopback is untouched.
		const drop = await authedFetch(`${baseUrl}/api/remote/test/drop-listener`, { method: "POST" });
		assert(drop.status === 200, `drop-listener: expected 200, got ${drop.status}`);
		await waitForTunnel(false, "after drop");
		const degraded = await remoteStatus();
		assert(degraded.enabled === false, "after drop: expected enabled false");
		assert(String(degraded.degradedReason ?? "").includes("lost"), "after drop: degradedReason must name the loss");
		assert((await fetch(`${baseUrl}/healthz`)).status === 200, "after drop: loopback must keep serving");
		assert(fs.existsSync(stateFile), "a degrade must keep the user's enabled intent on disk");

		// Self-heal: the watcher outlives the degrade, so when the address is
		// back (the test address never left), one tick rebinds the listener.
		const recheck = await authedFetch(`${baseUrl}/api/remote/test/recheck`, { method: "POST" });
		assert(recheck.status === 200, `recheck: expected 200, got ${recheck.status}`);
		await waitForTunnel(true, "rebind after address returns");
		const healed = await remoteStatus();
		assert(healed.enabled === true && healed.address === "::1", "after recheck: the listener must be back");
		assert(healed.degradedReason === null, "after recheck: degradedReason must clear");

		// Disable: listener gone, state file gone, reason cleared.
		const disable = await authedFetch(`${baseUrl}/api/remote/disable`, { method: "POST" });
		assert(disable.status === 200, `disable: expected 200, got ${disable.status}`);
		assert(!fs.existsSync(stateFile), "disable must delete the state file");
		const off = await remoteStatus();
		assert(off.enabled === false && off.degradedReason === null && off.stateFile === "absent", "status after disable must be plain off");

		await stopSmokeServer(server);

		// Boot with a persisted state file: the listener comes up by itself.
		fs.writeFileSync(stateFile, `${JSON.stringify({ enabled: true, enabledAt: new Date().toISOString(), keepAwake: false })}\n`, { mode: 0o600 });
		server = watch(spawnServer(home, { EXXPERTS_REMOTE_TEST_ADDRESS: "::1" }));
		await waitForServer(server);
		await waitForTunnel(true, "boot with state file");
		const booted = await remoteStatus();
		assert(booted.enabled === true && booted.address === "::1" && booted.stateFile === "valid", "boot with state file must serve the tunnel listener");
		assert(booted.keepAwake === false, "a persisted keepAwake false must survive the restart");

		await stopSmokeServer(server);
	}

	console.log("remote state smoke passed");
} catch (error) {
	console.error(serverOutput.join(""));
	throw error;
} finally {
	await stopSmokeServer(server);
}
