import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { SMOKE_SERVER_SPAWN_TREE_OPTIONS, stopSmokeServer } from "./smoke-server-process.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "exxperts-static-security-headers-"));
const tempHome = path.join(tempRoot, "home");
const tempAgentsRoot = path.join(tempHome, ".exxperts", "app", "personalized-agents");
const tempAgentRuntimeRoot = path.join(tempHome, ".exxperts", "agent");
fs.mkdirSync(tempAgentsRoot, { recursive: true, mode: 0o700 });

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const webServerDir = path.resolve(scriptDir, "..");
const repoRoot = path.resolve(webServerDir, "..", "..");
const port = 26000 + Math.floor(Math.random() * 10000);
const baseUrl = `http://127.0.0.1:${port}`;

async function waitForServer(server: ChildProcessWithoutNullStreams): Promise<void> {
	const deadline = Date.now() + 15000;
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

// The static path must carry the baseline headers whether or not the web-UI
// dist is built (the 404 fallback is still a browser-rendered response), so
// the assertions run against headers only, never the status code.
function assertSecurityHeaders(headers: Headers, label: string): void {
	const csp = headers.get("content-security-policy") ?? "";
	assert(csp.length > 0, `${label}: content-security-policy header must be present`);
	for (const directive of [
		"default-src 'self'",
		"script-src 'self'",
		"object-src 'none'",
		"frame-ancestors 'none'",
		"base-uri 'self'",
	]) {
		assert(csp.includes(directive), `${label}: CSP must include "${directive}", got: ${csp}`);
	}
	assert(/connect-src [^;]*ws:\/\/127\.0\.0\.1:\*/.test(csp), `${label}: CSP connect-src must allow loopback websockets, got: ${csp}`);
	assert(!/script-src[^;]*'unsafe-eval'/.test(csp), `${label}: CSP must not allow unsafe-eval, got: ${csp}`);
	assert(headers.get("x-content-type-options") === "nosniff", `${label}: x-content-type-options must be nosniff`);
	assert(headers.get("referrer-policy") === "no-referrer", `${label}: referrer-policy must be no-referrer`);
}

let server: ChildProcessWithoutNullStreams | undefined;
const serverOutput: string[] = [];
try {
	server = spawn("npx", ["tsx", "src/index.ts"], {
		shell: process.platform === "win32",
		...SMOKE_SERVER_SPAWN_TREE_OPTIONS,
		cwd: webServerDir,
		env: {
			...process.env,
			HOME: tempHome, USERPROFILE: tempHome,
			PORT: String(port),
			EXXETA_HOME: repoRoot,
			EXXPERTS_CODING_AGENT_DIR: tempAgentRuntimeRoot,
			EXXETA_PERSISTENT_AGENTS_ROOT: tempAgentsRoot,
		},
	});
	server.stdout.on("data", (chunk) => serverOutput.push(String(chunk)));
	server.stderr.on("data", (chunk) => serverOutput.push(String(chunk)));
	await waitForServer(server);

	const root = await fetch(`${baseUrl}/`);
	assertSecurityHeaders(root.headers, "GET /");

	const asset = await fetch(`${baseUrl}/assets/does-not-exist.js`);
	assertSecurityHeaders(asset.headers, "GET /assets/*");

	// API responses are out of scope for the static policy — but they must not
	// have silently inherited a document CSP that could mask a future regression
	// in how the static headers are applied.
	const api = await fetch(`${baseUrl}/healthz`);
	assert(api.headers.get("content-security-policy") == null, "GET /healthz: API responses must not carry the static CSP");

	console.log("static security headers smoke passed");
} catch (error) {
	console.error(serverOutput.join(""));
	throw error;
} finally {
	await stopSmokeServer(server);
}
