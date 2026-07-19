import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { authedFetch, SMOKE_SERVER_AUTH_ENV, SMOKE_SERVER_SPAWN_TREE_OPTIONS, stopSmokeServer } from "./smoke-server-process.js";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "exxperts-artifact-route-"));
const tempHome = path.join(tempRoot, "home");
const tempAgentsRoot = path.join(tempHome, ".exxperts", "app", "personalized-agents");
const tempAgentRuntimeRoot = path.join(tempHome, ".exxperts", "agent");
fs.mkdirSync(tempAgentsRoot, { recursive: true, mode: 0o700 });

// Seed the artifact store the way a specialist session would leave it. The store
// root mirrors productAppStatePath("artifacts") == <HOME>/.exxperts/app/artifacts,
// and HOME is pointed at tempHome for the spawned server below.
const store = path.join(tempHome, ".exxperts", "app", "artifacts");
const taskDir = path.join(store, "tasks", "tsk-route1");
fs.mkdirSync(path.join(taskDir, "sub"), { recursive: true });
fs.mkdirSync(path.join(taskDir, ".thumbs"), { recursive: true });

const SVG_BODY = '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10"/></svg>';
const HTML_BODY = "<!doctype html><title>page</title><p>hello</p>";
const MD_BODY = "# notes\n\nsome markdown\n";
const INNER_BODY = "<!doctype html><title>inner</title><p>nested</p>";
const SECRET = "TOP-SECRET-ARTIFACT-CONTENTS-DO-NOT-LEAK";

fs.writeFileSync(path.join(taskDir, "diagram.svg"), SVG_BODY);
fs.writeFileSync(path.join(taskDir, "page.html"), HTML_BODY);
fs.writeFileSync(path.join(taskDir, "notes.md"), MD_BODY);
fs.writeFileSync(path.join(taskDir, "sub", "inner.html"), INNER_BODY);
fs.writeFileSync(path.join(taskDir, ".thumbs", "preview.png"), "not-really-a-png");
// A 41MB file inside the task dir to exercise the size cap (>40_000_000).
fs.writeFileSync(path.join(taskDir, "big.html"), Buffer.alloc(41 * 1024 * 1024, 0x20));
// A servable-extension file OUTSIDE the tasks tree that traversal must never reach.
fs.mkdirSync(path.join(store, "private"), { recursive: true });
fs.writeFileSync(path.join(store, "private", "secret.md"), SECRET);

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const webServerDir = path.resolve(scriptDir, "..");
const repoRoot = path.resolve(webServerDir, "..", "..");
const port = 26000 + Math.floor(Math.random() * 10000);
const baseUrl = `http://127.0.0.1:${port}`;

const EXPECTED_HEADERS: Record<string, string> = {
	// Hardening pass 2026-07-12: no allow-scripts / script-src — all v1 template
	// output is static, so a served artifact must have no execution capability.
	"content-security-policy": "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data:",
	"x-content-type-options": "nosniff",
	"referrer-policy": "no-referrer",
	"cache-control": "no-store",
};

function assertArtifactHeaders(headers: Headers, label: string): void {
	for (const [key, value] of Object.entries(EXPECTED_HEADERS)) {
		assert(headers.get(key) === value, `${label}: ${key} must equal "${value}", got "${headers.get(key)}"`);
	}
}

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

// fetch/undici forbid overriding the Host header, so the loopback-guard check
// uses a raw node:http request to smuggle a foreign Host in.
function requestWithHost(pathname: string, host: string): Promise<{ status: number; body: string }> {
	return new Promise((resolve, reject) => {
		const req = http.request(
			{ host: "127.0.0.1", port, path: pathname, method: "GET", headers: { Host: host } },
			(res) => {
				const chunks: Buffer[] = [];
				res.on("data", (chunk) => chunks.push(chunk as Buffer));
				res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
			},
		);
		req.on("error", reject);
		req.end();
	});
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
			...SMOKE_SERVER_AUTH_ENV,
			EXXETA_HOME: repoRoot,
			EXXPERTS_CODING_AGENT_DIR: tempAgentRuntimeRoot,
			EXXETA_PERSISTENT_AGENTS_ROOT: tempAgentsRoot,
		},
	});
	server.stdout.on("data", (chunk) => serverOutput.push(String(chunk)));
	server.stderr.on("data", (chunk) => serverOutput.push(String(chunk)));
	await waitForServer(server);

	// 1. Each legit file: 200, exact MIME, all four headers, exact Content-Length.
	const legit = [
		{ rel: "diagram.svg", type: "image/svg+xml; charset=utf-8", body: SVG_BODY },
		{ rel: "page.html", type: "text/html; charset=utf-8", body: HTML_BODY },
		{ rel: "notes.md", type: "text/plain; charset=utf-8", body: MD_BODY },
		{ rel: "sub/inner.html", type: "text/html; charset=utf-8", body: INNER_BODY },
	];
	for (const file of legit) {
		const res = await authedFetch(`${baseUrl}/api/artifacts/tsk-route1/${file.rel}`);
		assert(res.status === 200, `GET ${file.rel}: expected 200, got ${res.status}`);
		assert(res.headers.get("content-type") === file.type, `GET ${file.rel}: content-type must be "${file.type}", got "${res.headers.get("content-type")}"`);
		assertArtifactHeaders(res.headers, `GET ${file.rel}`);
		const expectedLength = Buffer.byteLength(file.body);
		assert(res.headers.get("content-length") === String(expectedLength), `GET ${file.rel}: content-length must be ${expectedLength}, got "${res.headers.get("content-length")}"`);
		const text = await res.text();
		assert(text === file.body, `GET ${file.rel}: body mismatch`);
	}

	// 2. Server-internal dot-directory must never be servable.
	const thumbs = await authedFetch(`${baseUrl}/api/artifacts/tsk-route1/.thumbs/preview.png`);
	assert(thumbs.status === 404, `.thumbs/preview.png: expected 404, got ${thumbs.status}`);
	assertArtifactHeaders(thumbs.headers, ".thumbs 404");
	assert(!(await thumbs.text()).includes("not-really-a-png"), ".thumbs/preview.png: body leaked file contents");

	// 3. Traversal attempts to a servable file outside the tasks tree. Each must
	//    404 and never expose the secret in the body or any header value.
	const traversals = [
		"/api/artifacts/tsk-route1/../private/secret.md",
		"/api/artifacts/tsk-route1/%2e%2e%2fprivate%2fsecret.md",
		"/api/artifacts/../private/secret.md",
	];
	for (const attempt of traversals) {
		const res = await authedFetch(`${baseUrl}${attempt}`);
		const text = await res.text();
		assert(res.status === 404, `${attempt}: expected 404, got ${res.status}`);
		assert(!text.includes(SECRET), `${attempt}: response body leaked secret`);
		for (const [key, value] of res.headers.entries()) {
			assert(!String(value).includes(SECRET), `${attempt}: header ${key} leaked secret`);
		}
	}

	// 4. Unknown and malformed taskIds → 404 (with headers when the route matches).
	const unknown = await authedFetch(`${baseUrl}/api/artifacts/tsk-nonexistent/page.html`);
	assert(unknown.status === 404, `unknown taskId: expected 404, got ${unknown.status}`);
	assertArtifactHeaders(unknown.headers, "unknown taskId 404");

	const hidden = await authedFetch(`${baseUrl}/api/artifacts/.hidden/page.html`);
	assert(hidden.status === 404, `.hidden taskId: expected 404, got ${hidden.status}`);
	assertArtifactHeaders(hidden.headers, ".hidden taskId 404");

	const dotdot = await authedFetch(`${baseUrl}/api/artifacts/../page.html`);
	assert(dotdot.status === 404, `.. taskId: expected 404, got ${dotdot.status}`);

	const slashEncoded = await authedFetch(`${baseUrl}/api/artifacts/a%2fb/page.html`);
	assert(slashEncoded.status === 404, `a/b taskId: expected 404, got ${slashEncoded.status}`);

	// 5. ?download=1 → attachment disposition with the file's basename.
	const download = await authedFetch(`${baseUrl}/api/artifacts/tsk-route1/page.html?download=1`);
	assert(download.status === 200, `download: expected 200, got ${download.status}`);
	assert(download.headers.get("content-disposition") === 'attachment; filename="page.html"', `download: content-disposition wrong, got "${download.headers.get("content-disposition")}"`);
	const nestedDownload = await authedFetch(`${baseUrl}/api/artifacts/tsk-route1/sub/inner.html?download=1`);
	assert(nestedDownload.headers.get("content-disposition") === 'attachment; filename="inner.html"', `nested download: content-disposition wrong, got "${nestedDownload.headers.get("content-disposition")}"`);

	// 6. Size cap.
	const big = await authedFetch(`${baseUrl}/api/artifacts/tsk-route1/big.html`);
	assert(big.status === 413, `big.html: expected 413, got ${big.status}`);
	assertArtifactHeaders(big.headers, "413 big.html");

	// 7. Guard inheritance: a foreign Host must be rejected by the onRequest hook.
	const evil = await requestWithHost("/api/artifacts/tsk-route1/page.html", "evil.example");
	assert(evil.status === 403, `foreign Host: expected 403, got ${evil.status}`);
	assert(!evil.body.includes(HTML_BODY), "foreign Host: served artifact bytes despite guard");

	console.log("artifact route smoke passed");
} catch (error) {
	console.error(serverOutput.join(""));
	throw error;
} finally {
	await stopSmokeServer(server);
}
