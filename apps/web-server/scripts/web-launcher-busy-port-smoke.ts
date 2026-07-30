// Web-launcher busy-port pre-flight: when the chosen port is already held,
// `exxperts web` must say so up front with actionable guidance and exit,
// instead of spawning a server child that only dies with EADDRINUSE after its
// slow TypeScript startup — while the readiness poll, answered by the OLD
// listener, prints a false "running" banner and opens a browser at stale code.
// Covers both holder shapes: one that answers HTTP on /healthz (an earlier
// exxperts web server) and one that accepts connections but never replies (a
// wedged process). A free port must NOT trip the pre-flight (the launcher gets
// as far as spawning the real server, which the release-archive smoke boots
// for real; here the child is killed as soon as it appears).
import { spawn, spawnSync } from "node:child_process";
import http from "node:http";
import net from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "exxeta-web-launcher-busy-port-home-"));

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

function assertIncludes(haystack: string, needle: string, label: string): void {
	assert(haystack.includes(needle), `${label}: expected output to include ${JSON.stringify(needle)}; got:\n${haystack}`);
}

function assertNotIncludes(haystack: string, needle: string, label: string): void {
	assert(!haystack.includes(needle), `${label}: expected output not to include ${JSON.stringify(needle)}; got:\n${haystack}`);
}

// spawn, not spawnSync: the holder listeners live in THIS process, and a
// blocked event loop could never answer the launcher's pre-flight probe.
function runLauncher(port: number): Promise<{ status: number | null; output: string }> {
	return new Promise((resolve, reject) => {
		const child = spawn(process.execPath, [path.join(repoRoot, "bin", "exxperts.cjs"), "web", "--no-open", "--port", String(port)], {
			cwd: tempHome,
			env: { ...process.env, HOME: tempHome, USERPROFILE: tempHome },
			stdio: ["ignore", "pipe", "pipe"],
		});
		let output = "";
		child.stdout.on("data", (chunk) => { output += chunk; });
		child.stderr.on("data", (chunk) => { output += chunk; });
		const timer = setTimeout(() => {
			child.kill("SIGKILL");
			reject(new Error(`launcher did not exit within 30s; output so far:\n${output}`));
		}, 30_000);
		child.on("error", (err) => { clearTimeout(timer); reject(err); });
		child.on("close", (status) => { clearTimeout(timer); resolve({ status, output }); });
	});
}

function listeningPort(server: http.Server | net.Server): number {
	const address = server.address();
	assert(address && typeof address === "object", "listener has no bound address");
	return address.port;
}

// 1. A holder that answers /healthz — the earlier-exxperts-server shape. The
//    launcher must name the conflict and the recovery paths, and never print
//    the running banner.
{
	const holder = http.createServer((_req, res) => res.end(JSON.stringify({ ok: true })));
	await new Promise<void>((resolve) => holder.listen(0, "127.0.0.1", resolve));
	const port = listeningPort(holder);
	const { status, output } = await runLauncher(port);
	holder.close();
	assert(status === 1, `responding holder: expected exit 1, got ${status}:\n${output}`);
	assertIncludes(output, `Port ${port} is already in use`, "responding holder");
	assertIncludes(output, "Task Manager", "responding holder (recovery instructions)");
	assertIncludes(output, `--port ${port + 1}`, "responding holder (alternate-port suggestion)");
	assertIncludes(output, `open http://localhost:${port} in your browser`, "responding holder (reuse hint)");
	assertNotIncludes(output, "exxperts web running at", "responding holder (no false success)");
}

// 2. A holder that accepts the connection but never replies — the wedged
//    process shape. Same exit, "not responding" wording, no reuse hint.
{
	const holder = net.createServer(() => { /* accept and stay silent */ });
	await new Promise<void>((resolve) => holder.listen(0, "127.0.0.1", resolve));
	const port = listeningPort(holder);
	const { status, output } = await runLauncher(port);
	holder.close();
	assert(status === 1, `unresponsive holder: expected exit 1, got ${status}:\n${output}`);
	assertIncludes(output, `Port ${port} is held by a process that is not responding`, "unresponsive holder");
	assertIncludes(output, `--port ${port + 1}`, "unresponsive holder (alternate-port suggestion)");
	assertNotIncludes(output, "in your browser", "unresponsive holder (no reuse hint for a wedged holder)");
	assertNotIncludes(output, "exxperts web running at", "unresponsive holder (no false success)");
}

// 3. A free port must pass the pre-flight: the launcher survives it and spawns
//    the server child (proven by it still running after the pre-flight window),
//    then the whole tree is torn down without waiting for a full server boot.
{
	const probe = net.createServer();
	await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
	const port = listeningPort(probe);
	await new Promise<void>((resolve) => probe.close(() => resolve()));

	const child = spawn(process.execPath, [path.join(repoRoot, "bin", "exxperts.cjs"), "web", "--no-open", "--port", String(port)], {
		cwd: tempHome,
		env: { ...process.env, HOME: tempHome, USERPROFILE: tempHome },
		stdio: ["ignore", "pipe", "pipe"],
	});
	let output = "";
	child.stdout.on("data", (chunk) => { output += chunk; });
	child.stderr.on("data", (chunk) => { output += chunk; });
	// The pre-flight probe on a free port refuses near-instantly; 4s is far
	// beyond it. Still alive here means the pre-flight did not misfire.
	await new Promise((resolve) => setTimeout(resolve, 4000));
	const survivedPreflight = child.exitCode === null;
	if (process.platform === "win32") spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
	else child.kill("SIGTERM");
	await new Promise((resolve) => child.on("close", resolve));
	assert(survivedPreflight, `free port: launcher exited early (code ${child.exitCode}):\n${output}`);
	assertNotIncludes(output, "already in use", "free port (pre-flight must not misfire)");
	assertNotIncludes(output, "not responding", "free port (pre-flight must not misfire)");
}

fs.rmSync(tempHome, { recursive: true, force: true });
console.log("web-launcher-busy-port-smoke: OK");
