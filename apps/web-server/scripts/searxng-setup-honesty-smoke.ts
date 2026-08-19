// The local search engine status must be found, not remembered.
//
// The bug this pins down: a setup run that finished well left the status
// saying "ready" for the rest of the server's life, so quitting Docker later
// still drew "Running." on the screen. The rule now is that once nothing is in
// flight, "ready" is only ever reported after the engine just answered an
// actual search, and a configured local address gets the same probe even when
// no run ever happened. When the engine is silent, the status also says which
// rung of the ladder is missing: no container runtime installed, runtime
// installed but not running, or runtime up with the engine down.
//
// The engine is stood in for by a plain HTTP listener and the helper by a stub
// script, because a smoke that needs Docker installed tests the machine.
//
// Run: node scripts/run-smokes.mjs searxng-setup-honesty

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import http from "node:http";
import { authedFetch, type AuthedFetchInit, SMOKE_SERVER_AUTH_ENV, SMOKE_SERVER_SPAWN_TREE_OPTIONS, stopSmokeServer } from "./smoke-server-process.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "exxperts-searxng-honesty-"));
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const webServerDir = path.resolve(scriptDir, "..");
const repoRoot = path.resolve(webServerDir, "..", "..");
const agentDir = path.join(tempHome, ".exxperts", "agent");
const productAppRoot = path.join(tempHome, ".exxperts", "app");
const stubScript = path.join(tempHome, "searxng-stub.mjs");

// The stub answers "runtime" with one word the way the real helper does, and
// plays a chosen part for "start". The daemon-down words are the real helper's
// own, so the server parses what it will really be handed.
const startDockerStopped = `console.error("Docker is installed but not running. Start Docker (or OrbStack) and retry.");
process.exit(1);`;

function stubSource(startBehavior: string, runtimeWord: "missing" | "stopped" | "up"): string {
	return `const cmd = process.argv[2] ?? "";
if (cmd === "runtime") { console.log(${JSON.stringify(runtimeWord)}); process.exit(0); }
${startBehavior}
`;
}

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

let port = 0;
let baseUrl = "";

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

async function requestJson(pathname: string, init?: AuthedFetchInit): Promise<{ status: number; body: any }> {
	const response = await authedFetch(`${baseUrl}${pathname}`, init);
	const text = await response.text();
	return { status: response.status, body: text ? JSON.parse(text) : null };
}

/** Poll until the run stops moving, the way the screen does. */
async function settle(): Promise<any> {
	const deadline = Date.now() + 15000;
	let latest: any = null;
	while (Date.now() < deadline) {
		const { body } = await requestJson("/api/web-search/searxng/setup");
		latest = body;
		if (!body?.running) return body;
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
	throw new Error(`setup never settled, last status ${JSON.stringify(latest)}`);
}

/** A stand-in engine that answers the JSON search probe the way SearXNG does. */
function listen(enginePort: number): Promise<http.Server> {
	return new Promise((resolve, reject) => {
		const server = http.createServer((_req, res) => {
			res.writeHead(200, { "content-type": "application/json" });
			res.end(JSON.stringify({ results: [] }));
		});
		server.on("error", reject);
		server.listen(enginePort, "127.0.0.1", () => resolve(server));
	});
}

function close(server: http.Server): Promise<void> {
	return new Promise((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
}

let server: ChildProcessWithoutNullStreams | null = null;
let engine: http.Server | null = null;
const serverOutput: string[] = [];

try {
	fs.mkdirSync(agentDir, { recursive: true, mode: 0o700 });
	fs.mkdirSync(productAppRoot, { recursive: true, mode: 0o700 });
	fs.writeFileSync(stubScript, stubSource(startDockerStopped, "stopped"), { mode: 0o600 });

	port = 24000 + Math.floor(Math.random() * 10000);
	baseUrl = `http://127.0.0.1:${port}`;
	const enginePort = 24000 + Math.floor(Math.random() * 10000);
	const engineUrl = `http://127.0.0.1:${enginePort}`;
	server = spawn("npx", ["tsx", "src/index.ts"], {
		shell: process.platform === "win32",
		...SMOKE_SERVER_SPAWN_TREE_OPTIONS,
		cwd: webServerDir,
		env: {
			...process.env,
			HOME: tempHome,
			USERPROFILE: tempHome,
			PORT: String(port),
			EXXPERTS_AUTH_TOKEN: SMOKE_SERVER_AUTH_ENV.EXXPERTS_AUTH_TOKEN,
			EXXETA_HOME: repoRoot,
			EXXPERTS_CODING_AGENT_DIR: agentDir,
			EXXPERTS_SEARXNG_SCRIPT: stubScript,
		},
	});
	server.stdout.on("data", (chunk) => serverOutput.push(String(chunk)));
	server.stderr.on("data", (chunk) => serverOutput.push(String(chunk)));
	await waitForServer(server);

	// ---- nothing configured, nothing claimed -------------------------------
	const before = await requestJson("/api/web-search/searxng/setup");
	assert(before.status === 200, `status reads before any run, got ${before.status}`);
	assert(before.body.phase === "idle", `nothing configured means idle, got ${JSON.stringify(before.body)}`);

	// ---- the daemon is down, and the run says so, not "running" ------------
	const started = await requestJson("/api/web-search/searxng/setup", { method: "POST" });
	assert(started.status === 200, `starting answers 200, got ${started.status}`);
	const stoppedRun = await settle();
	assert(stoppedRun.phase === "docker-stopped", `a down daemon reads as docker-stopped, got ${JSON.stringify(stoppedRun)}`);
	assert(/docker desktop|orbstack/i.test(stoppedRun.message ?? ""), `the sentence names what to start, got ${stoppedRun.message}`);
	assert(stoppedRun.baseUrl === null, "nothing is running, so no address is claimed");

	// ---- a configured local address is probed, never assumed ---------------
	engine = await listen(enginePort);
	const saved = await requestJson("/api/settings/web-search", {
		method: "PUT",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ provider: "searxng", baseUrl: engineUrl }),
	});
	assert(saved.status === 200, `saving the address answers 200, got ${saved.status} ${JSON.stringify(saved.body)}`);
	const live = await requestJson("/api/web-search/searxng/setup");
	assert(live.body.phase === "ready", `an engine that answers reads ready, got ${JSON.stringify(live.body)}`);
	assert(live.body.baseUrl === engineUrl, `ready carries the probed address, got ${JSON.stringify(live.body)}`);

	// ---- the engine goes away: the ladder says which rung is missing -------
	await close(engine);
	engine = null;

	// Runtime up, engine down: press Start, nothing else to fix.
	fs.writeFileSync(stubScript, stubSource(startDockerStopped, "up"), { mode: 0o600 });
	const engineDown = await requestJson("/api/web-search/searxng/setup");
	assert(engineDown.body.phase === "stopped", `runtime up with a dead engine reads stopped, got ${JSON.stringify(engineDown.body)}`);
	assert(engineDown.body.baseUrl === null, "a dead engine claims no address");
	assert(/not answering/i.test(engineDown.body.message ?? ""), `the sentence says it is not answering, got ${engineDown.body.message}`);
	assert(/start one on this computer/i.test(engineDown.body.message ?? ""), `and points at the button, got ${engineDown.body.message}`);

	// Runtime installed but not running: name it and say to start it.
	fs.writeFileSync(stubScript, stubSource(startDockerStopped, "stopped"), { mode: 0o600 });
	const daemonDown = await requestJson("/api/web-search/searxng/setup");
	assert(daemonDown.body.phase === "docker-stopped", `a stopped daemon reads docker-stopped from idle too, got ${JSON.stringify(daemonDown.body)}`);
	assert(/installed but not running/i.test(daemonDown.body.message ?? ""), `the sentence says it is installed but not running, got ${daemonDown.body.message}`);
	assert(/start one on this computer/i.test(daemonDown.body.message ?? ""), `and points at the button, got ${daemonDown.body.message}`);

	// No runtime at all: say what to install, naming both engines.
	fs.writeFileSync(stubScript, stubSource(startDockerStopped, "missing"), { mode: 0o600 });
	const noRuntime = await requestJson("/api/web-search/searxng/setup");
	assert(noRuntime.body.phase === "docker-missing", `no runtime reads docker-missing from idle too, got ${JSON.stringify(noRuntime.body)}`);
	assert(/orbstack/i.test(noRuntime.body.message ?? "") && /docker desktop/i.test(noRuntime.body.message ?? ""), `the sentence names both engines, got ${noRuntime.body.message}`);

	// ---- a run that ends well is still re-verified afterwards --------------
	fs.writeFileSync(stubScript, stubSource(`console.log("SearXNG ready at ${engineUrl}");\nprocess.exit(0);`, "up"), { mode: 0o600 });
	await requestJson("/api/web-search/searxng/setup", { method: "POST" });
	const afterRun = await settle();
	// The run exited claiming ready, but nothing answers at the address, so the
	// settled status must say stopped. This is the reported lie.
	assert(afterRun.phase === "stopped", `a finished run with no live engine must not read ready, got ${JSON.stringify(afterRun)}`);

	// ---- and the moment it answers again, the status follows --------------
	engine = await listen(enginePort);
	const back = await requestJson("/api/web-search/searxng/setup");
	assert(back.body.phase === "ready", `an engine back up reads ready again, got ${JSON.stringify(back.body)}`);
	assert(back.body.baseUrl === engineUrl, `and carries its address, got ${JSON.stringify(back.body)}`);

	console.log("searxng-setup-honesty smoke passed");
} catch (error) {
	console.error(serverOutput.join(""));
	throw error;
} finally {
	if (engine) await close(engine).catch(() => {});
	await stopSmokeServer(server);
	fs.rmSync(tempHome, { recursive: true, force: true });
}
