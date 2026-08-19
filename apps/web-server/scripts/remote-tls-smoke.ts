import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { authedFetch, SMOKE_SERVER_AUTH_ENV, SMOKE_SERVER_SPAWN_TREE_OPTIONS, stopSmokeServer } from "./smoke-server-process.js";

// Pins the TLS stage of remote mode (src/remote-tls.ts + the https path in
// src/remote-mode.ts): with certificate material present, the tunnel
// listener speaks https, its identity widens to EXACTLY the certificate's
// DNS name, the pairing URL flips name-primary, the device cookie gains
// Secure, and the tunnel CSP names the wss origin. The material comes from
// the smoke-only EXXPERTS_REMOTE_TEST_TLS_DIR hook (a self-signed test
// certificate below); the real path runs `tailscale cert`, which no smoke
// can do hermetically, so binary discovery and ACME failures are covered by
// the fallback-reason contract, not here.
//
// The fixture certificate is self-signed for exactly this name, valid for a
// century on purpose: a fixture that expires is a smoke that rots.

const TEST_DNS_NAME = "test-machine.test-tailnet.ts.net";

const TEST_CERT = `-----BEGIN CERTIFICATE-----
MIIB2zCCAYGgAwIBAgIUMYGe6AYl1IZP2siXzmZH2tA34mowCgYIKoZIzj0EAwIw
KzEpMCcGA1UEAwwgdGVzdC1tYWNoaW5lLnRlc3QtdGFpbG5ldC50cy5uZXQwIBcN
MjYwODE2MTI0NDQ3WhgPMjEyNjA3MjMxMjQ0NDdaMCsxKTAnBgNVBAMMIHRlc3Qt
bWFjaGluZS50ZXN0LXRhaWxuZXQudHMubmV0MFkwEwYHKoZIzj0CAQYIKoZIzj0D
AQcDQgAESW80NeyCqPbbg6QQ6rCdr3WR8RF5Pk7ertHw32hnXTAoqWr5mR03I+yQ
cCv0sqsNw+hZbkSAG1SaU7j79Upbr6OBgDB+MB0GA1UdDgQWBBTyOnysQd+vkT4E
7HGt3y5LdWnXUDAfBgNVHSMEGDAWgBTyOnysQd+vkT4E7HGt3y5LdWnXUDAPBgNV
HRMBAf8EBTADAQH/MCsGA1UdEQQkMCKCIHRlc3QtbWFjaGluZS50ZXN0LXRhaWxu
ZXQudHMubmV0MAoGCCqGSM49BAMCA0gAMEUCIEC9LSMcJCTn/eQLxlUHQs/ApZvy
AyrUjzYB4FhhjgW5AiEAw3wQbhNU4SB9xy+99Ae+PyZNEK6PRbDN1TvmZM24VIs=
-----END CERTIFICATE-----
`;

const TEST_KEY = `-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgbWTXYFG/7CoZaoiN
rzinURhX6eiJWV8cyTyf5IyKqh2hRANCAARJbzQ17IKo9tuDpBDqsJ2vdZHxEXk+
Tt6u0fDfaGddMCipavmZHTcj7JBwK/Syqw3D6FluRIAbVJpTuPv1Sluv
-----END PRIVATE KEY-----
`;

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const webServerDir = path.resolve(scriptDir, "..");
const repoRoot = path.resolve(webServerDir, "..", "..");
const port = 26000 + Math.floor(Math.random() * 10000);
const baseUrl = `http://127.0.0.1:${port}`;

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "exxperts-remote-tls-"));
const tempHome = path.join(tempRoot, "home");
fs.mkdirSync(path.join(tempHome, ".exxperts", "app", "personalized-agents"), { recursive: true, mode: 0o700 });
const tlsDir = path.join(tempRoot, "tls");
fs.mkdirSync(tlsDir, { recursive: true, mode: 0o700 });
fs.writeFileSync(path.join(tlsDir, "cert.pem"), TEST_CERT);
fs.writeFileSync(path.join(tlsDir, "key.pem"), TEST_KEY, { mode: 0o600 });
fs.writeFileSync(path.join(tlsDir, "dns-name.txt"), `${TEST_DNS_NAME}\n`);

function spawnServer(): ChildProcessWithoutNullStreams {
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
			EXXPERTS_REMOTE_TEST_ADDRESS: "::1",
			EXXPERTS_REMOTE_TEST_TLS_DIR: tlsDir,
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

// An https request into the tunnel listener on ::1, addressed (Host header
// and SNI) however the test wants. rejectUnauthorized is off because the
// fixture is self-signed; what the smoke verifies is the SERVER's identity
// checks, not the client's.
function tlsRequest(pathname: string, options: { host?: string; origin?: string; method?: string; headers?: Record<string, string>; body?: string } = {}): Promise<{ status: number; body: string; headers: Record<string, string | string[] | undefined> }> {
	return new Promise((resolve, reject) => {
		const req = https.request(
			{
				host: "::1",
				port,
				path: pathname,
				method: options.method ?? "GET",
				rejectUnauthorized: false,
				servername: TEST_DNS_NAME,
				headers: {
					Host: options.host ?? `${TEST_DNS_NAME}:${port}`,
					...(options.origin ? { Origin: options.origin } : {}),
					...(options.body ? { "content-type": "application/json" } : {}),
					...options.headers,
				},
			},
			(res) => {
				const chunks: Buffer[] = [];
				res.on("data", (chunk) => chunks.push(chunk as Buffer));
				res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8"), headers: res.headers }));
			},
		);
		req.on("error", reject);
		if (options.body) req.write(options.body);
		req.end();
	});
}

// --- Mint contract against a fake sandboxed CLI ---------------------------
// The Mac App Store build's `tailscale` runs in a sandbox that cannot write
// outside its own container, so acquireTunnelTls must ask for the PEMs on
// stdout (`--cert-file - --key-file -`) and write cert.pem/key.pem itself.
// The fake below pins that contract: it REFUSES a path-shaped --cert-file or
// --key-file (exit 3, the sandboxed failure), streams chain-then-key on "-",
// always writes a warning line to stderr on success (the macOS sandbox
// notice, which must not be read as failure), and has failure modes for the
// old honesty case (nonzero exit with a reason) and for unusable stdout.
// POSIX shell fake, so this stage is skipped on Windows.

function runMintProbe(mode: string): Promise<{ code: number; stdout: string }> {
	const fakeBin = path.join(tempRoot, "fake-bin");
	const pemFile = path.join(tempRoot, "fake-chain.pem");
	const runner = path.join(tempRoot, "mint-probe.mts");
	if (!fs.existsSync(path.join(fakeBin, "tailscale"))) {
		fs.mkdirSync(fakeBin, { recursive: true });
		fs.writeFileSync(pemFile, TEST_CERT + TEST_CERT + TEST_KEY);
		fs.writeFileSync(
			path.join(fakeBin, "tailscale"),
			[
				"#!/bin/sh",
				'case "$1" in',
				'  version) echo "1.99.9 fake"; exit 0;;',
				"  status) printf '{\"Self\":{\"DNSName\":\"test-machine.test-tailnet.ts.net.\"}}'; exit 0;;",
				"  cert)",
				"    expect=none",
				"    for arg in \"$@\"; do",
				'      if [ "$expect" != none ]; then',
				'        if [ "$arg" != - ]; then echo "sandbox: open $arg: operation not permitted" >&2; exit 3; fi',
				"        expect=none",
				"      elif [ \"$arg\" = --cert-file ] || [ \"$arg\" = --key-file ]; then expect=path; fi",
				"    done",
				'    echo "tailscale is sandboxed on macOS" >&2',
				'    case "$FAKE_TAILSCALE_CERT_MODE" in',
				'      fail) echo "500 Internal Server Error: your Tailscale account does not support getting TLS certs" >&2; exit 1;;',
				'      garbage) echo "here is not a pem"; exit 0;;',
				'      *) cat "$FAKE_TAILSCALE_PEM_FILE"; exit 0;;',
				"    esac;;",
				"esac",
				"exit 1",
			].join("\n"),
			{ mode: 0o755 },
		);
		fs.writeFileSync(
			runner,
			[
				'import fs from "node:fs";',
				'import path from "node:path";',
				`import { acquireTunnelTls } from ${JSON.stringify(pathToFileURL(path.join(webServerDir, "src", "remote-tls.ts")).href)};`,
				"const result = await acquireTunnelTls();",
				"const out: Record<string, unknown> = { ok: result.ok };",
				'if (!result.ok) out.reason = result.reason;',
				"else {",
				"\tout.dnsName = result.material.dnsName;",
				'\tout.certBlocks = (result.material.cert.match(/BEGIN CERTIFICATE/g) ?? []).length;',
				'\tout.keyOk = /BEGIN [A-Z0-9 ]*PRIVATE KEY/.test(result.material.key) && !result.material.key.includes("CERTIFICATE");',
				'\tconst dir = path.join(String(process.env.HOME), ".exxperts", "app", "remote-tls");',
				'\tout.modes = ["cert.pem", "key.pem"].map((name) => (fs.statSync(path.join(dir, name)).mode & 0o777).toString(8));',
				"}",
				"console.log(JSON.stringify(out));",
			].join("\n"),
		);
	}
	const mintHome = path.join(tempRoot, `mint-home-${mode}`);
	fs.mkdirSync(mintHome, { recursive: true });
	const env: NodeJS.ProcessEnv = { ...process.env, HOME: mintHome, USERPROFILE: mintHome, PATH: `${fakeBin}${path.delimiter}${process.env.PATH ?? ""}`, FAKE_TAILSCALE_CERT_MODE: mode, FAKE_TAILSCALE_PEM_FILE: pemFile };
	delete env.EXXPERTS_REMOTE_TEST_ADDRESS;
	delete env.EXXPERTS_REMOTE_TEST_TLS_DIR;
	return new Promise((resolve) => {
		execFile("npx", ["tsx", runner], { cwd: webServerDir, env, timeout: 60_000 }, (error, stdout) => {
			resolve({ code: error ? 1 : 0, stdout: String(stdout) });
		});
	});
}

if (process.platform !== "win32") {
	const okProbe = await runMintProbe("ok");
	assert(okProbe.code === 0, `mint ok probe: runner failed: ${okProbe.stdout}`);
	const okOut = JSON.parse(okProbe.stdout) as { ok: boolean; dnsName?: string; certBlocks?: number; keyOk?: boolean; modes?: string[] };
	assert(okOut.ok, `mint ok probe: expected ok, got ${okProbe.stdout}`);
	assert(okOut.dnsName === TEST_DNS_NAME, `mint ok probe: expected dnsName ${TEST_DNS_NAME}, got ${okOut.dnsName}`);
	assert(okOut.certBlocks === 2, `mint ok probe: expected the full 2-block chain, got ${okOut.certBlocks}`);
	assert(okOut.keyOk === true, "mint ok probe: key material must be exactly the private key block");
	assert(okOut.modes?.join(",") === "600,600", `mint ok probe: cert.pem/key.pem must be mode 600, got ${okOut.modes?.join(",")}`);

	const failProbe = await runMintProbe("fail");
	const failOut = JSON.parse(failProbe.stdout) as { ok: boolean; reason?: string };
	assert(!failOut.ok, "mint fail probe: a nonzero cert exit must fail honestly");
	assert(String(failOut.reason).includes("Tailscale could not issue a certificate"), `mint fail probe: reason must keep the honest prefix, got ${failOut.reason}`);
	assert(String(failOut.reason).includes("does not support getting TLS certs"), `mint fail probe: reason must carry the CLI's own error, got ${failOut.reason}`);

	const garbageProbe = await runMintProbe("garbage");
	const garbageOut = JSON.parse(garbageProbe.stdout) as { ok: boolean; reason?: string };
	assert(!garbageOut.ok, "mint garbage probe: unusable stdout must not become material");
	assert(String(garbageOut.reason).includes("did not return usable certificate material"), `mint garbage probe: reason must say what happened, got ${garbageOut.reason}`);
	assert(String(garbageOut.reason).includes("here is not a pem"), `mint garbage probe: reason must show what was received, got ${garbageOut.reason}`);
	console.log("remote-tls smoke: mint contract assertions passed");
} else {
	console.log("remote-tls smoke: mint contract stage skipped on Windows (POSIX shell fake)");
}

const server = spawnServer();
let failed = false;
try {
	await waitForServer(server);

	// 1. Enable serves https and reports the certificate identity.
	const enable = await authedFetch(`${baseUrl}/api/remote/enable`, { method: "POST" });
	assert(enable.status === 200, `enable: expected 200, got ${enable.status}`);
	const status = ((await enable.json()) as { status: { scheme: string; dnsName: string; tlsFallbackReason: string | null } }).status;
	assert(status.scheme === "https", `enable: expected scheme https, got ${status.scheme}`);
	assert(status.dnsName === TEST_DNS_NAME, `enable: expected dnsName ${TEST_DNS_NAME}, got ${status.dnsName}`);
	assert(status.tlsFallbackReason === null, `enable: expected no fallback reason, got ${status.tlsFallbackReason}`);

	// 2. The listener answers TLS under the DNS name identity...
	const health = await tlsRequest("/healthz");
	assert(health.status === 200 && health.body.trim() === '{"ok":true}', `healthz over https: expected minimal ok, got ${health.status} ${health.body}`);
	// ...and the bound-address identity, the listener's OTHER exact-self
	// spelling, is redirected to the canonical DNS name instead of served:
	// the device cookie is scoped to the name, so answering the raw-address
	// form directly would tell a validly paired phone it is not paired. The
	// redirect preserves path and query, and a request already on the
	// canonical Host (every tlsRequest above) is served without one, so no
	// loop.
	const healthByAddress = await tlsRequest("/healthz", { host: `[::1]:${port}` });
	assert(healthByAddress.status === 302, `healthz with address Host: expected 302 to the canonical name, got ${healthByAddress.status}`);
	assert(healthByAddress.headers.location === `https://${TEST_DNS_NAME}:${port}/healthz`, `address-Host redirect must target the canonical URL, got ${healthByAddress.headers.location}`);
	const deepByAddress = await tlsRequest("/api/persistent-agents?probe=1", { host: `[::1]:${port}` });
	assert(deepByAddress.status === 302, `deep path with address Host: expected 302 before any auth answer, got ${deepByAddress.status}`);
	assert(deepByAddress.headers.location === `https://${TEST_DNS_NAME}:${port}/api/persistent-agents?probe=1`, `address-Host redirect must keep path and query, got ${deepByAddress.headers.location}`);
	// A foreign Host stays refused: rebinding is as dead on https as on http.
	const foreignHost = await tlsRequest("/healthz", { host: `evil.example:${port}` });
	assert(foreignHost.status === 403, `foreign Host: expected 403, got ${foreignHost.status}`);
	// The https listener's origin is scheme-exact: its own https origin
	// passes, the http spelling of the same name does not.
	const goodOrigin = await tlsRequest("/healthz", { origin: `https://${TEST_DNS_NAME}:${port}` });
	assert(goodOrigin.status === 200, `own https Origin: expected 200, got ${goodOrigin.status}`);
	const schemeMismatch = await tlsRequest("/healthz", { origin: `http://${TEST_DNS_NAME}:${port}` });
	assert(schemeMismatch.status === 403, `http Origin on https listener: expected 403, got ${schemeMismatch.status}`);

	// 3. Plain http into the TLS port fails at the transport, not with a page.
	let plainHttpFailed = false;
	try {
		await fetch(`http://[::1]:${port}/healthz`, { signal: AbortSignal.timeout(3000) });
	} catch {
		plainHttpFailed = true;
	}
	assert(plainHttpFailed, "plain http against the TLS listener must not get an answer");

	// 4. The pairing URL is name-primary under https.
	const minted = await authedFetch(`${baseUrl}/api/remote/enroll-code`, { method: "POST" });
	assert(minted.status === 200, `enroll-code: expected 200, got ${minted.status}`);
	const mintedBody = (await minted.json()) as { url: string };
	assert(mintedBody.url.startsWith(`https://${TEST_DNS_NAME}:${port}/remote/enroll?code=`), `enroll-code url must be https name-primary, got ${mintedBody.url}`);
	const code = new URL(mintedBody.url).searchParams.get("code") ?? "";

	// 5. The enroll page over https carries the wss CSP origin.
	const enrollPage = await tlsRequest(`/remote/enroll?code=${code}`);
	assert(enrollPage.status === 200, `enroll page over https: expected 200, got ${enrollPage.status}`);
	const csp = String(enrollPage.headers["content-security-policy"] ?? "");
	assert(csp.includes(`wss://${TEST_DNS_NAME}:${port}`), `tunnel CSP must name the wss origin, got: ${csp}`);
	// The loopback ws:// baseline entries stay (they are the shared header's
	// base and are inert on a remote page); what must not exist is a plain-ws
	// spelling of the tunnel identity itself.
	assert(!csp.includes(`ws://${TEST_DNS_NAME}`) && !csp.includes("ws://[::1]"), `tunnel CSP must not carry a plain ws tunnel origin, got: ${csp}`);

	// 6. Full pairing over https: the device key cookie arrives Secure.
	const exchange = await tlsRequest("/remote/enroll/exchange", { method: "POST", body: JSON.stringify({ code, name: "TLS smoke phone" }) });
	assert(exchange.status === 200, `exchange: expected 200, got ${exchange.status} ${exchange.body}`);
	const requestId = String((JSON.parse(exchange.body) as { requestId: string }).requestId);
	const approve = await authedFetch(`${baseUrl}/api/remote/enroll-approve`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ requestId }),
	});
	assert(approve.status === 200, `approve: expected 200, got ${approve.status}`);
	const poll = await tlsRequest(`/remote/enroll/status?requestId=${requestId}`);
	assert(poll.status === 200, `status poll: expected 200, got ${poll.status}`);
	const setCookie = String(poll.headers["set-cookie"] ?? "");
	assert(setCookie.includes("exxperts_remote_device="), `status poll must set the device cookie, got: ${setCookie.replace(/=[^;]+/, "=[redacted]")}`);
	assert(/;\s*Secure/i.test(setCookie), "the device cookie must carry Secure on the https listener");
	assert(/HttpOnly/i.test(setCookie) && /SameSite=Strict/i.test(setCookie), "the device cookie must keep HttpOnly and SameSite=Strict");

	// 7. Loopback is untouched by all of this: still plain http, still the
	// exact loopback CSP with its ws:// origins.
	const loopbackPage = await fetch(`${baseUrl}/`, { redirect: "manual" });
	assert(loopbackPage.status !== 301 && loopbackPage.status !== 302, `loopback must never get the canonical-address redirect, got ${loopbackPage.status}`);
	const loopbackCsp = String(loopbackPage.headers.get("content-security-policy") ?? "");
	assert(loopbackCsp.includes("ws://127.0.0.1:*"), `loopback CSP must be unchanged, got: ${loopbackCsp}`);
	assert(!loopbackCsp.includes("wss://"), "loopback CSP must not gain a wss origin");

	console.log("remote-tls smoke: all assertions passed");
} catch (error) {
	failed = true;
	console.error(`remote-tls smoke FAILED: ${(error as Error).message}`);
} finally {
	await stopSmokeServer(server);
	fs.rmSync(tempRoot, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);
