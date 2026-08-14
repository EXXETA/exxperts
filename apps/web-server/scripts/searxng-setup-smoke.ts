// Starting a local search engine from the app, when the machine cannot.
//
// The point of the endpoint is that nobody has to open a terminal, which means
// the failure everyone will actually hit has to arrive as a sentence on a
// screen rather than as an exit code nobody sees. So this drives the path where
// no container engine is installed, and proves three things: the POST answers
// straight away instead of blocking on a run that can take minutes, the phase
// settles on docker-missing with plain words and no command in them, and asking
// twice starts nothing twice and crashes nothing.
//
// The container engine is stood in for by a stub helper, because a smoke that
// only passes on machines with Docker installed tests the machine, not the code.
//
// Run: node scripts/run-smokes.mjs searxng-setup

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { authedFetch, type AuthedFetchInit, SMOKE_SERVER_AUTH_ENV, SMOKE_SERVER_SPAWN_TREE_OPTIONS, stopSmokeServer } from "./smoke-server-process.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "exxperts-searxng-setup-"));
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const webServerDir = path.resolve(scriptDir, "..");
const repoRoot = path.resolve(webServerDir, "..", "..");
const agentDir = path.join(tempHome, ".exxperts", "agent");
const productAppRoot = path.join(tempHome, ".exxperts", "app");

// The real helper's own words for this case, so the server is parsing the text
// it will really be handed rather than something invented here.
const stubScript = path.join(tempHome, "searxng-stub.mjs");
const stubSource = `console.error(\`Docker is not installed. SearXNG runs in a container, so you need a container
engine first (one-time setup, like installing Node):
  Docker Desktop             https://www.docker.com/products/docker-desktop/
  OrbStack (lighter, macOS)  https://orbstack.dev
Install one, start it, then re-run: exxperts setup search\`);
process.exit(1);
`;

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

let server: ChildProcessWithoutNullStreams | null = null;
const serverOutput: string[] = [];

try {
	fs.mkdirSync(agentDir, { recursive: true, mode: 0o700 });
	fs.mkdirSync(productAppRoot, { recursive: true, mode: 0o700 });
	fs.writeFileSync(stubScript, stubSource, { mode: 0o600 });

	port = 24000 + Math.floor(Math.random() * 10000);
	baseUrl = `http://127.0.0.1:${port}`;
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

	// ---- nothing asked for, nothing claimed --------------------------------
	const before = await requestJson("/api/web-search/searxng/setup");
	assert(before.status === 200, `status reads before any run, got ${before.status}`);
	assert(before.body.phase === "idle", `no run means idle, got ${JSON.stringify(before.body)}`);
	assert(before.body.running === false, "an idle status is not a running one");

	// ---- the POST answers now, not in five minutes -------------------------
	const startedAt = Date.now();
	const started = await requestJson("/api/web-search/searxng/setup", { method: "POST" });
	const elapsed = Date.now() - startedAt;
	assert(started.status === 200, `starting answers 200, got ${started.status}`);
	assert(elapsed < 4000, `the POST must not wait for the run, took ${elapsed}ms`);
	assert(typeof started.body.phase === "string", `the answer carries a phase, got ${JSON.stringify(started.body)}`);

	// ---- the machine cannot, and says so in words --------------------------
	const settled = await settle();
	assert(settled.phase === "docker-missing", `no engine installed reads as docker-missing, got ${JSON.stringify(settled)}`);
	assert(settled.running === false, "a finished run is not a running one");
	assert(typeof settled.message === "string" && settled.message.length > 0, "the phase carries a sentence");
	assert(/docker desktop|orbstack/i.test(settled.message), `the sentence names what to install, got ${settled.message}`);
	assert(!/\bexxperts \w|npm |node |docker (run|pull|start)\b/i.test(settled.message), `no command in the sentence, got ${settled.message}`);
	assert(settled.baseUrl === null, "nothing is running, so no address is claimed");

	// ---- asking twice is harmless ------------------------------------------
	const again = await requestJson("/api/web-search/searxng/setup", { method: "POST" });
	assert(again.status === 200, `a second ask answers 200, got ${again.status}`);
	const settledAgain = await settle();
	assert(settledAgain.phase === "docker-missing", `and lands in the same place, got ${JSON.stringify(settledAgain)}`);

	// ---- the server is still alive after all of it -------------------------
	const health = await fetch(`${baseUrl}/healthz`);
	assert(health.ok, "the server survived a failed setup run");

	console.log("searxng-setup smoke passed");
} catch (error) {
	console.error(serverOutput.join(""));
	throw error;
} finally {
	await stopSmokeServer(server);
	fs.rmSync(tempHome, { recursive: true, force: true });
}
