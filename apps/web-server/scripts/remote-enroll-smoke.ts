import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { Socket } from "node:net";
import { fileURLToPath } from "node:url";
import { authedFetch, SMOKE_AUTH_TOKEN, SMOKE_SERVER_AUTH_ENV, SMOKE_SERVER_SPAWN_TREE_OPTIONS, stopSmokeServer } from "./smoke-server-process.js";

// Pins the enrollment + per-device-key unit (src/remote-devices.ts, the
// enrollment routes, and the device-auth arm of the guard's tunnel branch),
// with the tunnel faked on ::1:
//
// - the pairing code is single-use, approval-gated on the computer, and the
//   minted device key is handed over exactly once (Set-Cookie on the status
//   poll), never again;
// - a paired device reaches the app over the tunnel; the master token stays
//   refused there even while a device key works;
// - pages served over the tunnel carry the tunnel ws:// origin in
//   connect-src, while loopback pages keep the exact loopback CSP;
// - revocation force-closes the device's live sockets (asserted on an open
//   WebSocket) and the key stops authenticating immediately;
// - deny works, disable voids outstanding codes, the enrollment routes do
//   not exist on the loopback listener, and the enroll surface rate-limits.

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const webServerDir = path.resolve(scriptDir, "..");
const repoRoot = path.resolve(webServerDir, "..", "..");
const port = 26000 + Math.floor(Math.random() * 10000);
const baseUrl = `http://127.0.0.1:${port}`;
const tunnelHostHeader = `[::1]:${port}`;

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "exxperts-remote-enroll-"));
const tempHome = path.join(tempRoot, "home");
fs.mkdirSync(path.join(tempHome, ".exxperts", "app", "personalized-agents"), { recursive: true, mode: 0o700 });

function tunnelRequest(pathname: string, options: { method?: string; headers?: Record<string, string>; body?: string } = {}): Promise<{ status: number; body: string; headers: http.IncomingHttpHeaders }> {
	return new Promise((resolve, reject) => {
		const req = http.request(
			{ host: "::1", port, path: pathname, method: options.method ?? "GET", headers: { Host: tunnelHostHeader, ...options.headers } },
			(res) => {
				const chunks: Buffer[] = [];
				res.on("data", (chunk) => chunks.push(chunk as Buffer));
				res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8"), headers: res.headers }));
			},
		);
		req.on("error", reject);
		if (options.body != null) req.write(options.body);
		req.end();
	});
}

// WS upgrade that HOLDS the socket open on success, so revocation's
// force-close can be observed on it.
function tunnelWsOpen(headers: Record<string, string>): Promise<{ status: number; socket: Socket | null }> {
	return new Promise((resolve, reject) => {
		const req = http.request(
			{
				host: "::1", port, path: "/ws", method: "GET",
				agent: false,
				headers: {
					Host: tunnelHostHeader,
					Origin: `http://[::1]:${port}`,
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
				resolve({ status: res.statusCode ?? 0, socket: null });
			},
		);
		req.on("upgrade", (res, socket) => resolve({ status: res.statusCode ?? 101, socket }));
		req.on("error", (error: NodeJS.ErrnoException) => {
			if (error.code === "ECONNRESET") resolve({ status: -1, socket: null });
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

async function mintCode(): Promise<string> {
	const res = await authedFetch(`${baseUrl}/api/remote/enroll-code`, { method: "POST" });
	assert(res.status === 200, `enroll-code: expected 200, got ${res.status}`);
	const body = (await res.json()) as any;
	const url = String(body.url ?? "");
	const code = new URL(url).searchParams.get("code") ?? "";
	assert(code.length === 64, `enroll-code: expected a 64-hex code in the url, got "${url}"`);
	// The QR matrix the Settings page renders: square, boolean, and with the
	// three finder patterns a scanner needs (corner module is always dark).
	// The server may omit the matrix when its vendored encoder is missing
	// (best-effort by design), but in a healthy checkout the encoder is
	// present, so THIS smoke stays strict: an absent matrix here means the
	// deep require into qrcode-terminal broke and should fail loudly.
	const matrix = body.matrix as boolean[][];
	assert(Array.isArray(matrix) && matrix.length >= 21, `enroll-code: expected a QR matrix, got ${typeof body.matrix}`);
	assert(matrix.every((row) => Array.isArray(row) && row.length === matrix.length && row.every((cell) => typeof cell === "boolean")), "enroll-code: QR matrix is not a square of booleans");
	assert(matrix[0][0] === true && matrix[0][matrix.length - 1] === true && matrix[matrix.length - 1][0] === true, "enroll-code: QR matrix is missing finder-pattern corners");
	return code;
}

async function exchange(code: string, name = "Smoke phone"): Promise<{ status: number; requestId: string }> {
	const res = await tunnelRequest("/remote/enroll/exchange", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ code, name }),
	});
	const requestId = res.status === 200 ? String((JSON.parse(res.body) as any).requestId ?? "") : "";
	return { status: res.status, requestId };
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

	// 1. Minting requires a serving remote; the loopback listener has no
	//    enrollment surface at all (Fastify's own not-found, so the loopback
	//    route table is unchanged).
	const mintBeforeEnable = await authedFetch(`${baseUrl}/api/remote/enroll-code`, { method: "POST" });
	assert(mintBeforeEnable.status === 412, `enroll-code before enable: expected 412, got ${mintBeforeEnable.status}`);
	// Unauthenticated: the auth hook 401s exactly as it would today for any
	// path. Authenticated: Fastify's own not-found, as if the route did not
	// exist, so the loopback surface is unchanged.
	const loopbackEnrollNoAuth = await fetch(`${baseUrl}/remote/enroll?code=x`);
	assert(loopbackEnrollNoAuth.status === 401, `loopback /remote/enroll unauthenticated: expected 401, got ${loopbackEnrollNoAuth.status}`);
	const loopbackEnroll = await authedFetch(`${baseUrl}/remote/enroll?code=x`);
	assert(loopbackEnroll.status === 404, `loopback /remote/enroll: expected 404, got ${loopbackEnroll.status}`);
	assert(((await loopbackEnroll.json()) as any).error === "Not Found", "loopback /remote/enroll must be Fastify's own not-found");

	const enable = await authedFetch(`${baseUrl}/api/remote/enable`, { method: "POST" });
	assert(enable.status === 200, `enable: expected 200, got ${enable.status}`);

	// 2. The pairing surface serves pre-auth on the tunnel; the page carries
	//    no inline script (CSP script-src 'self' stays intact).
	const page = await tunnelRequest("/remote/enroll?code=whatever");
	assert(page.status === 200 && page.body.includes("/remote/enroll.js"), "enroll page must serve and reference the external script");
	assert(!/<script>[^<]/.test(page.body), "enroll page must not carry inline script");
	const script = await tunnelRequest("/remote/enroll.js");
	assert(script.status === 200 && String(script.headers["content-type"]).includes("javascript"), "enroll script must serve as javascript");

	// 3. Exchange: wrong code refused; right code single-use; the pending
	//    approval shows the sanitized name; deny works and burns the code.
	const wrong = await exchange("f".repeat(64));
	assert(wrong.status === 403, `exchange with wrong code: expected 403, got ${wrong.status}`);

	const deniedCode = await mintCode();
	const deniedExchange = await exchange(deniedCode, "Sneaky phone");
	assert(deniedExchange.status === 200, `exchange: expected 200, got ${deniedExchange.status}`);
	const reuse = await exchange(deniedCode);
	assert(reuse.status === 403, `code reuse: expected 403, got ${reuse.status}`);
	const pending = (await (await authedFetch(`${baseUrl}/api/remote/enroll-pending`)).json()) as any;
	assert(pending.pending.length === 1 && pending.pending[0].deviceName === "Sneaky phone", "pending approval must show the sanitized device name");
	const deny = await authedFetch(`${baseUrl}/api/remote/enroll-deny`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ requestId: deniedExchange.requestId }) });
	assert(deny.status === 200, `deny: expected 200, got ${deny.status}`);
	const deniedStatus = await tunnelRequest(`/remote/enroll/status?requestId=${deniedExchange.requestId}`);
	assert((JSON.parse(deniedStatus.body) as any).state === "denied", "denied exchange must poll as denied");

	// 4. Approval mints the device key, delivered exactly once as an
	//    HttpOnly cookie on the status poll.
	const code = await mintCode();
	const started = await exchange(code);
	assert(started.status === 200, "exchange for approval must succeed");
	const beforeApproval = await tunnelRequest(`/remote/enroll/status?requestId=${started.requestId}`);
	assert((JSON.parse(beforeApproval.body) as any).state === "pending", "pre-approval poll must be pending");
	assert(!beforeApproval.headers["set-cookie"], "pre-approval poll must not set a cookie");
	const approve = await authedFetch(`${baseUrl}/api/remote/enroll-approve`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ requestId: started.requestId }) });
	assert(approve.status === 200, `approve: expected 200, got ${approve.status}`);
	const approvedPoll = await tunnelRequest(`/remote/enroll/status?requestId=${started.requestId}`);
	const setCookie = ([] as string[]).concat((approvedPoll.headers["set-cookie"] as string[] | undefined) ?? []).join("; ");
	assert((JSON.parse(approvedPoll.body) as any).state === "approved", "post-approval poll must be approved");
	assert(setCookie.includes("exxperts_remote_device=") && setCookie.includes("HttpOnly") && setCookie.includes("SameSite=Strict"), `approved poll must set the HttpOnly device cookie, got "${setCookie}"`);
	const deviceKey = setCookie.match(/exxperts_remote_device=([0-9a-f]+)/)?.[1] ?? "";
	assert(deviceKey.length === 64, "device key must be 64 hex chars");
	const secondPoll = await tunnelRequest(`/remote/enroll/status?requestId=${started.requestId}`);
	assert(!secondPoll.headers["set-cookie"], "the device key must be handed over exactly once");

	// 5. The paired device reaches the app; the master token stays refused on
	//    the tunnel even while a device key works.
	const deviceCookie = { Cookie: `exxperts_remote_device=${deviceKey}` };
	const api = await tunnelRequest("/api/persistent-agents", { headers: deviceCookie });
	assert(api.status === 200, `tunnel API with device key: expected 200, got ${api.status}`);
	const master = await tunnelRequest("/api/persistent-agents", { headers: { "X-Exxperts-Auth": SMOKE_AUTH_TOKEN } });
	assert(master.status === 401, `tunnel API with master token: still expected 401, got ${master.status}`);
	const wrongKey = await tunnelRequest("/api/persistent-agents", { headers: { Cookie: `exxperts_remote_device=${"0".repeat(64)}` } });
	assert(wrongKey.status === 401, `tunnel API with wrong device key: expected 401, got ${wrongKey.status}`);

	// 6. CSP: the app page over the tunnel gains the tunnel ws:// origin;
	//    the loopback page keeps the exact loopback policy.
	const tunnelPage = await tunnelRequest("/", { headers: deviceCookie });
	assert(tunnelPage.status === 200, `tunnel GET / with device key: expected 200, got ${tunnelPage.status}`);
	assert(String(tunnelPage.headers["content-security-policy"]).includes(`ws://[::1]:${port}`), "tunnel page CSP must include the tunnel ws origin");
	const loopbackPage = await fetch(`${baseUrl}/auth/session?token=${SMOKE_AUTH_TOKEN}`, { redirect: "manual" });
	assert(loopbackPage.status === 302, "loopback auth exchange must still redirect");
	const loopbackCsp = await fetch(`${baseUrl}/`, { headers: { Cookie: `exxperts_auth=${SMOKE_AUTH_TOKEN}` } });
	assert(!String(loopbackCsp.headers.get("content-security-policy")).includes("ws://[::1]"), "loopback CSP must not gain tunnel origins");

	// 7. Device admin: the list carries no key material; revocation
	//    force-closes the device's live WebSocket and the key dies instantly.
	const list = (await (await authedFetch(`${baseUrl}/api/remote/devices`)).json()) as any;
	assert(list.devices.length === 1 && list.devices[0].capability === "full", "device list must show the approved device with full capability");
	assert(!("keyHash" in list.devices[0]), "device list must not expose key hashes");
	const deviceId = String(list.devices[0].id);

	const ws = await tunnelWsOpen(deviceCookie);
	assert(ws.status === 101 && ws.socket, `tunnel WS with device key: expected 101, got ${ws.status === -1 ? "reset" : ws.status}`);
	const wsClosed = new Promise<void>((resolve) => ws.socket!.once("close", () => resolve()));
	const revoke = await authedFetch(`${baseUrl}/api/remote/devices/revoke`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: deviceId }) });
	assert(revoke.status === 200, `revoke: expected 200, got ${revoke.status}`);
	await Promise.race([wsClosed, new Promise((_, reject) => setTimeout(() => reject(new Error("revocation did not close the device's live socket within 5s")), 5000))]);
	const afterRevoke = await tunnelRequest("/api/persistent-agents", { headers: deviceCookie });
	assert(afterRevoke.status === 401, `revoked device key: expected 401, got ${afterRevoke.status}`);

	// 8. Disable voids an outstanding code (fresh code, disable+enable, old
	//    code refused).
	const staleCode = await mintCode();
	await authedFetch(`${baseUrl}/api/remote/disable`, { method: "POST" });
	await authedFetch(`${baseUrl}/api/remote/enable`, { method: "POST" });
	const stale = await exchange(staleCode);
	assert(stale.status === 403, `code minted before disable: expected 403, got ${stale.status}`);

	// 9. The enroll surface rate-limits (shared 10/min window across page +
	//    exchange; everything above consumed part of it, so a burst of bad
	//    exchanges must trip 429 within the remaining budget).
	let sawRateLimit = false;
	for (let i = 0; i < 12; i++) {
		const res = await exchange("e".repeat(64));
		if (res.status === 429) { sawRateLimit = true; break; }
		assert(res.status === 403, `rate-limit burst: expected 403 or 429, got ${res.status}`);
	}
	assert(sawRateLimit, "a burst of bad exchanges must trip the rate limit");

	// 10. The audit log: security events landed as JSONL, and the file is
	//     redacted by construction: no device key, no enrollment code, no
	//     64-hex secret of any shape anywhere in it.
	const auditFile = path.join(tempHome, ".exxperts", "app", "remote-auth-audit.jsonl");
	const audit = fs.readFileSync(auditFile, "utf8");
	const events = audit.trim().split("\n").map((line) => (JSON.parse(line) as { event: string; deviceId?: string }));
	for (const expected of ["remote_enabled", "enroll_code_minted", "enroll_exchange_invalid", "enroll_requested", "enroll_approved", "enroll_denied", "device_auth_failed", "device_revoked", "remote_disabled", "rate_limited"]) {
		assert(events.some((entry) => entry.event === expected), `audit log must record ${expected}`);
	}
	const approvedEntry = events.find((entry) => entry.event === "enroll_approved");
	assert(approvedEntry?.deviceId, "enroll_approved must carry the device id");
	assert(!/[0-9a-f]{64}/.test(audit), "audit log must never contain a 64-hex secret");
	assert(!audit.includes(deviceKey) && !audit.includes(code), "audit log must not contain the device key or the enrollment code");
	assert(!audit.includes("Sneaky phone") && !audit.includes("Smoke phone"), "audit log must not contain user-typed device names");

	console.log("remote enroll smoke passed");
} catch (error) {
	console.error(serverOutput.join(""));
	throw error;
} finally {
	await stopSmokeServer(server);
}
