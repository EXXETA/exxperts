import { spawn, spawnSync } from "node:child_process";
import type { ChildProcess, ChildProcessByStdio } from "node:child_process";
import diagnosticsChannel from "node:diagnostics_channel";
import net from "node:net";
import type { AddressInfo, Socket } from "node:net";
import type { Writable } from "node:stream";

// Server-spawning smokes authenticate like a programmatic caller: the smoke
// pins the client auth token by putting EXXPERTS_AUTH_TOKEN in the server env
// (the server then uses the pinned value instead of minting one; enforcement
// is identical) and sends the same value back in the X-Exxperts-Auth header.
export const SMOKE_AUTH_TOKEN = "exxperts-smoke-pinned-auth-token";
export const SMOKE_SERVER_AUTH_ENV = { EXXPERTS_AUTH_TOKEN: SMOKE_AUTH_TOKEN } as const;
export const SMOKE_AUTH_HEADERS = { "X-Exxperts-Auth": SMOKE_AUTH_TOKEN } as const;

// The environment for a launcher or server a smoke starts against a temp home.
// A temp HOME alone is not enough: the launchers resolve the exxperts data
// folder from EXXPERTS_DATA_DIR and EXXPERTS_STATE_HOME ahead of the home, so
// a developer who has either exported would otherwise have the smoke write
// into their real data folder. Both are dropped here, along with the agent dir
// the supervisors derive from them.
export function smokeHomeEnv(tempHome: string, extra: Record<string, string | undefined> = {}): Record<string, string | undefined> {
	const env: Record<string, string | undefined> = { ...process.env, HOME: tempHome, USERPROFILE: tempHome, ...extra };
	delete env.EXXPERTS_DATA_DIR;
	delete env.EXXPERTS_STATE_HOME;
	delete env.EXXPERTS_CODING_AGENT_DIR;
	return env;
}

// A port nothing listens on, for a server or fake a smoke starts: the system
// picks it, and the probe closes before the smoke binds it. A random pick
// from a fixed range can clash with another smoke running alongside. Another
// process can still take the port in that short gap, so the runner retries a
// smoke once when its server or fake finds the port taken. A smoke that
// needs two ports asks twice and never gets the same one back. The remote
// smokes' tunnel listener binds the same port on ::1 later, so the port must
// be free there too (a system without IPv6 skips that half). The server
// itself never gets PORT=0: PORT also sets its allowed origins, remote mode
// and the live-connection origin. Each port handed out is printed ("smoke
// port N"), so the runner retries only a clash on one of them.
const portsGiven = new Set<number>();
// The bound port, or the listen error's code.
function probePort(port: number, host: string): Promise<number | string> {
	return new Promise((resolve) => {
		const probe = net.createServer();
		probe.once("error", (error: NodeJS.ErrnoException) => resolve(error.code ?? error.message));
		probe.listen(port, host, () => {
			const { port: bound } = probe.address() as AddressInfo;
			probe.close(() => resolve(bound));
		});
	});
}
export async function freePort(): Promise<number> {
	let lastError = "";
	for (let tries = 0; tries < 20; tries++) {
		const port = await probePort(0, "127.0.0.1");
		if (typeof port === "string") {
			lastError = `127.0.0.1: ${port}`;
			continue;
		}
		if (portsGiven.has(port)) continue;
		const v6 = await probePort(port, "::1");
		if (typeof v6 === "string" && v6 !== "EADDRNOTAVAIL" && v6 !== "EAFNOSUPPORT") {
			lastError = `::1: ${v6}`;
			continue;
		}
		portsGiven.add(port);
		console.error(`smoke port ${port}`);
		return port;
	}
	throw new Error(`freePort found no port free on 127.0.0.1 and ::1 in 20 tries${lastError ? ` (last error: ${lastError})` : ""}`);
}

// init.headers is deliberately narrowed to a plain object: a Headers instance
// would spread to {} and silently drop the auth header. Explicit caller
// headers win over the auth header, which is what a negative test wants.
// Smokes wrapping authedFetch should type their init as AuthedFetchInit, not
// RequestInit, so the narrowing carries through when scripts are typechecked.
export type AuthedFetchInit = Omit<RequestInit, "headers"> & { headers?: Record<string, string> };
export function authedFetch(url: string | URL, init: AuthedFetchInit = {}): Promise<Response> {
	return fetch(url, { ...init, headers: { ...SMOKE_AUTH_HEADERS, ...init.headers } });
}

// Smokes spawn the web server as npx → tsx → node, so a plain SIGTERM to the
// npx process leaves the actual server running on Linux and Windows (macOS
// happens to tear the tree down). On POSIX the server must therefore run in
// its own process group (detached) so the whole tree can be signalled at once.
export const SMOKE_SERVER_SPAWN_TREE_OPTIONS: { detached?: boolean } =
	process.platform === "win32" ? {} : { detached: true };

// That group also keeps the server out of reach of whatever ends the smoke
// itself: the runner's timeout (SIGKILL to the smoke's process group,
// scripts/run-smokes.mjs), Ctrl-C, SIGTERM, or an exit that skips the smoke's
// clean-up would leave it running with its temp HOME. No handler can catch
// SIGKILL, so the first process a smoke starts also starts a watchdog: node in
// a session of its own, told through a pipe that only the smoke holds which
// children are running ("+pid" when one starts, "-pid" when it exits). When the
// smoke is gone, however it went, the pipe closes and the watchdog stops every
// child still listed (SIGTERM to its process group, SIGKILL after 10 s), then
// exits; after a clean run the list is empty and it exits at once. The smoke's
// children are seen through Node's child_process channel, so no smoke changes.
// POSIX only: on Windows the runner's taskkill /T ends the smoke's whole tree.
const WATCHDOG_SOURCE = [
	"const pids = new Set();",
	"let rest = '';",
	"process.stdin.setEncoding('utf8');",
	"process.stdin.on('data', (chunk) => {",
	"	const lines = (rest + chunk).split('\\n');",
	"	rest = lines.pop();",
	"	for (const line of lines) (line[0] === '+' ? pids.add(Number(line.slice(1))) : pids.delete(Number(line.slice(1))));",
	"});",
	"process.stdin.on('error', () => {});",
	"const signal = (pid, name) => {",
	"	try { process.kill(-pid, name); return true; } catch {}",
	"	try { process.kill(pid, name); return true; } catch { return false; }",
	"};",
	"process.stdin.on('close', () => {",
	"	for (const pid of pids) if (!signal(pid, 'SIGTERM')) pids.delete(pid);",
	"	const until = Date.now() + 10000;",
	"	const check = () => {",
	"		for (const pid of pids) if (!signal(pid, 0)) pids.delete(pid);",
	"		if (pids.size > 0 && Date.now() < until) return void setTimeout(check, 100);",
	"		for (const pid of pids) signal(pid, 'SIGKILL');",
	"		process.exit(0);",
	"	};",
	"	check();",
	"});",
].join("\n");

let watchdog: ChildProcessByStdio<Writable, null, null> | null | undefined;
let startingWatchdog = false;

function tellWatchdog(line: string): void {
	if (watchdog === undefined) {
		startingWatchdog = true;
		try {
			// Detached: a kill of the smoke's process group does not reach it. The
			// label names the smoke it watches, for ps and the smoke-server-process smoke.
			watchdog = spawn(process.execPath, ["-e", WATCHDOG_SOURCE, "exxperts-smoke-watchdog", String(process.pid)], { detached: true, stdio: ["pipe", "ignore", "ignore"], env: {} });
			watchdog.on("error", () => {
				watchdog = null;
			});
			watchdog.stdin.on("error", () => {});
			// Neither the watchdog nor its pipe keeps the smoke running.
			watchdog.unref();
			(watchdog.stdin as Socket).unref();
		} catch {
			watchdog = null;
		} finally {
			startingWatchdog = false;
		}
	}
	watchdog?.stdin.write(`${line}\n`);
}

if (process.platform !== "win32") {
	diagnosticsChannel.subscribe("child_process", (message) => {
		if (startingWatchdog) return;
		const child = (message as { process: ChildProcess }).process;
		child.once("spawn", () => {
			const pid = child.pid;
			if (pid === undefined) return;
			tellWatchdog(`+${pid}`);
			child.once("exit", () => tellWatchdog(`-${pid}`));
		});
	});
}

function killTree(pid: number, signal: NodeJS.Signals): void {
	if (process.platform === "win32") {
		spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore" });
		return;
	}
	try {
		process.kill(-pid, signal);
	} catch {
		try { process.kill(pid, signal); } catch {}
	}
}

// Stop the smoke's server without ever hanging: SIGTERM the tree, wait
// bounded, escalate to SIGKILL. An unbounded wait-for-exit here is exactly
// what turned one leaked server process into a 45-minute CI timeout. The
// bound's timer is cleared once the server exits: left pending, it kept every
// smoke alive for the full 10 s after a clean stop. A stop is printed: a
// port clash after it may be a restart finding the old server still there,
// which the runner must not retry away.
export async function stopSmokeServer(server: ChildProcess | null | undefined): Promise<void> {
	if (!server || server.exitCode != null || server.pid == null) return;
	console.error("smoke server stopped");
	const exited = new Promise<void>((resolve) => server.once("exit", () => resolve()));
	const waitUpTo = async (ms: number) => {
		let timer: NodeJS.Timeout | undefined;
		await Promise.race([exited, new Promise<void>((resolve) => { timer = setTimeout(resolve, ms); })]);
		clearTimeout(timer);
	};
	killTree(server.pid, "SIGTERM");
	await waitUpTo(10_000);
	if (server.exitCode == null) {
		killTree(server.pid, "SIGKILL");
		await waitUpTo(5_000);
	}
}
