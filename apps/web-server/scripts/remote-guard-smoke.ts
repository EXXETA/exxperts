import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { authedFetch, SMOKE_AUTH_TOKEN, SMOKE_SERVER_AUTH_ENV, SMOKE_SERVER_SPAWN_TREE_OPTIONS, stopSmokeServer } from "./smoke-server-process.js";

// Pins the request-guard branch for tunnel-tagged sockets (the remote-mode
// block at the top of the onRequest hook in src/index.ts), with the tunnel
// faked on ::1 via EXXPERTS_REMOTE_TEST_ADDRESS:
//
// - the reverse-proxy refusal is SHARED: proxied requests 403 on the tunnel
//   listener with the same error as on loopback;
// - Host and Origin on the tunnel listener are exact-self (the machine's own
//   tunnel address:port), so DNS rebinding stays dead there too;
// - /healthz over the tunnel returns liveness only ({ok:true}, no persona);
// - /auth/session does not exist on the tunnel listener, and the MASTER
//   token is not a credential there: a request carrying the correct master
//   token is refused identically to one carrying none (401
//   remote_device_auth_required, device keys land in the enrollment unit);
// - the widened predicates do not leak into the loopback listener: a
//   tailnet-shaped Host on loopback still 403s, and loopback auth still
//   works exactly as today.

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const webServerDir = path.resolve(scriptDir, "..");
const repoRoot = path.resolve(webServerDir, "..", "..");
const port = 26000 + Math.floor(Math.random() * 10000);
const baseUrl = `http://127.0.0.1:${port}`;

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "exxperts-remote-guard-"));
const tempHome = path.join(tempRoot, "home");
fs.mkdirSync(path.join(tempHome, ".exxperts", "app", "personalized-agents"), { recursive: true, mode: 0o700 });

// Raw node:http requests so Host/Via and friends can be overridden (undici
// forbids or normalizes them), pointed at either listener by address.
function rawRequest(host: string, pathname: string, headers: Record<string, string>): Promise<{ status: number; body: string }> {
	return new Promise((resolve, reject) => {
		const req = http.request(
			{ host, port, path: pathname, method: "GET", headers, setDefaultHeaders: false as any },
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

const tunnelHostHeader = `[::1]:${port}`;
function tunnelRequest(pathname: string, headers: Record<string, string> = {}): Promise<{ status: number; body: string }> {
	return rawRequest("::1", pathname, { Host: tunnelHostHeader, ...headers });
}

// Raw WS upgrade probe against the tunnel listener. Resolves the HTTP status
// the server answered with (101 for an accepted handshake), or -1 when the
// websocket plugin destroyed the socket while refusing (both are refusals,
// mirroring local-guard-smoke).
function tunnelWsUpgradeProbe(headers: Record<string, string>): Promise<{ status: number }> {
	return new Promise((resolve, reject) => {
		const req = http.request(
			{
				host: "::1", port, path: "/ws", method: "GET",
				agent: false,
				headers: {
					Host: tunnelHostHeader,
					Connection: "Upgrade",
					Upgrade: "websocket",
					"Sec-WebSocket-Key": Buffer.from("the sample nonce").toString("base64"),
					"Sec-WebSocket-Version": "13",
					...headers,
				},
			},
			(res) => {
				res.on("error", () => {});
				res.resume();
				resolve({ status: res.statusCode ?? 0 });
			},
		);
		req.on("upgrade", (res, socket) => {
			socket.destroy();
			resolve({ status: res.statusCode ?? 101 });
		});
		req.on("error", (error: NodeJS.ErrnoException) => {
			if (error.code === "ECONNRESET") resolve({ status: -1 });
			else reject(error);
		});
		req.end();
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
			EXXPERTS_CODING_AGENT_DIR: path.join(tempHome, ".exxperts", "agent"),
			EXXETA_PERSISTENT_AGENTS_ROOT: path.join(tempHome, ".exxperts", "app", "personalized-agents"),
			EXXPERTS_REMOTE_TEST_ADDRESS: "::1",
		},
	});
	server.stdout.on("data", (chunk) => serverOutput.push(String(chunk)));
	server.stderr.on("data", (chunk) => serverOutput.push(String(chunk)));
	await waitForServer(server);

	const enable = await authedFetch(`${baseUrl}/api/remote/enable`, { method: "POST" });
	assert(enable.status === 200, `enable: expected 200, got ${enable.status}`);

	// 1. Tunnel /healthz is liveness only: exactly {ok:true}, no persona.
	//    Served directly on the address-form Host: plain http has no
	//    canonical DNS name, so the https canonical-address redirect must be
	//    inert here (a 200, never a 3xx).
	const health = await tunnelRequest("/healthz");
	assert(health.status === 200, `tunnel healthz: expected 200, got ${health.status}`);
	assert(JSON.stringify(JSON.parse(health.body)) === JSON.stringify({ ok: true }), `tunnel healthz must be {ok:true} only, got ${health.body}`);

	// 2. The master token is not a credential on the tunnel listener, and its
	//    correctness must not be observable: correct token, wrong token, and
	//    no token all refuse identically.
	const withMaster = await tunnelRequest("/api/persistent-agents", { "X-Exxperts-Auth": SMOKE_AUTH_TOKEN });
	const withWrong = await tunnelRequest("/api/persistent-agents", { "X-Exxperts-Auth": "not-the-token" });
	const withNone = await tunnelRequest("/api/persistent-agents");
	for (const [label, res] of [["correct master token", withMaster], ["wrong token", withWrong], ["no token", withNone]] as const) {
		assert(res.status === 401, `tunnel ${label}: expected 401, got ${res.status}`);
		assert((JSON.parse(res.body) as any).code === "remote_device_auth_required", `tunnel ${label}: expected remote_device_auth_required`);
	}
	assert(withMaster.body === withNone.body && withMaster.status === withNone.status, "tunnel refusals must not differ by token correctness");

	// 3. /auth/session does not exist on the tunnel listener, even with the
	//    correct master token in the query.
	const exchange = await tunnelRequest(`/auth/session?token=${SMOKE_AUTH_TOKEN}`);
	assert(exchange.status === 404, `tunnel /auth/session: expected 404, got ${exchange.status}`);

	// 4. Exact-self Host: anything that is not the machine's own tunnel
	//    address:port is refused, including loopback names that are fine on
	//    the loopback listener.
	for (const host of ["evil.example", `localhost:${port}`, `127.0.0.1:${port}`, `[::1]:1`, "100.64.0.9:80"]) {
		const res = await rawRequest("::1", "/healthz", { Host: host });
		assert(res.status === 403, `tunnel Host ${host}: expected 403, got ${res.status}`);
		assert((JSON.parse(res.body) as any).code === "remote_request_required", `tunnel Host ${host}: expected remote_request_required`);
	}

	// 5. Exact-self Origin.
	const foreignOrigin = await tunnelRequest("/healthz", { Origin: "http://evil.example" });
	assert(foreignOrigin.status === 403, `tunnel foreign Origin: expected 403, got ${foreignOrigin.status}`);
	const loopbackOrigin = await tunnelRequest("/healthz", { Origin: `http://localhost:${port}` });
	assert(loopbackOrigin.status === 403, `tunnel loopback Origin: expected 403 (exact-self only), got ${loopbackOrigin.status}`);
	const selfOrigin = await tunnelRequest("/healthz", { Origin: `http://[::1]:${port}` });
	assert(selfOrigin.status === 200, `tunnel self Origin: expected 200, got ${selfOrigin.status}`);

	// 6. The reverse-proxy refusal is shared: a proxied request on the tunnel
	//    listener gets the same loud error as on loopback.
	const proxied = await tunnelRequest("/healthz", { "X-Forwarded-For": "203.0.113.7" });
	assert(proxied.status === 403, `tunnel proxied: expected 403, got ${proxied.status}`);
	assert((JSON.parse(proxied.body) as any).code === "reverse_proxy_unsupported", "tunnel proxied: expected reverse_proxy_unsupported");

	// 7. WebSocket upgrades run through the same onRequest hook, so the
	//    tunnel branch covers them: an upgrade on the tunnel listener must
	//    never reach the 101 handshake, and presenting the master token (as
	//    header or cookie) on the upgrade must not change the refusal. This
	//    pins the single most load-bearing routing assumption in the guard
	//    against a future refactor of WS handling.
	for (const [label, headers] of [
		["bare", {}],
		["master token header", { "X-Exxperts-Auth": SMOKE_AUTH_TOKEN }],
		["master token cookie", { Cookie: `exxperts_auth=${SMOKE_AUTH_TOKEN}` }],
	] as const) {
		const ws = await tunnelWsUpgradeProbe(headers);
		assert(ws.status === 401 || ws.status === -1, `tunnel WS upgrade (${label}): expected 401 or reset, got ${ws.status === -1 ? "reset" : ws.status}`);
	}
	// The refusals must not have wedged either listener.
	assert((await tunnelRequest("/healthz")).status === 200, "tunnel healthz after WS probes must still serve");
	assert((await fetch(`${baseUrl}/healthz`)).status === 200, "loopback healthz after WS probes must still serve");

	// 8. No leak into loopback: the loopback listener still refuses a
	//    tailnet-shaped Host, and loopback auth still works exactly as today.
	const tailnetHostOnLoopback = await rawRequest("127.0.0.1", "/healthz", { Host: "100.64.0.9:8787" });
	assert(tailnetHostOnLoopback.status === 403, `loopback with tailnet Host: expected 403, got ${tailnetHostOnLoopback.status}`);
	assert((JSON.parse(tailnetHostOnLoopback.body) as any).code === "local_request_required", "loopback with tailnet Host: expected local_request_required");
	const loopbackApi = await authedFetch(`${baseUrl}/api/persistent-agents`);
	assert(loopbackApi.status === 200, `loopback API with master token: expected 200, got ${loopbackApi.status}`);
	const loopbackHealth = await fetch(`${baseUrl}/healthz`);
	assert("persona" in ((await loopbackHealth.json()) as any), "loopback healthz keeps its full body");

	console.log("remote guard smoke passed");
} catch (error) {
	console.error(serverOutput.join(""));
	throw error;
} finally {
	await stopSmokeServer(server);
}
