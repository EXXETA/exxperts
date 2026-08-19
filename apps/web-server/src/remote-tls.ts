import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { ensureProductAppStateRoot, productAppStatePath } from "../../../pi-package/product-state-paths.js";
import { isRemoteTestModeEnabled } from "./remote-mode.js";

// TLS for the tunnel listener, fed by `tailscale cert`: a real Let's Encrypt
// certificate for the machine's own MagicDNS name, minted locally by the
// user's Tailscale (private key never leaves the machine), loaded into the
// app's own listener. No proxy enters the path, so the guard posture is
// unchanged; the only thing that changes is the scheme.
//
// Everything here is best-effort BY DESIGN: HTTPS needs MagicDNS plus the
// tailnet's HTTPS-certificates switch, and plenty of tailnets have neither.
// Any failure returns a reason and the listener serves plain http inside the
// encrypted tunnel, exactly as before; acquiring a certificate must never be
// able to break remote mode, let alone the boot.

export interface RemoteTlsMaterial {
	cert: string;
	key: string;
	/** The MagicDNS name the certificate is valid for (no trailing dot). */
	dnsName: string;
}

export type RemoteTlsResult = { ok: true; material: RemoteTlsMaterial } | { ok: false; reason: string };

// Test hook (smokes only, honored only alongside the faked tailnet address):
// a directory with cert.pem, key.pem, and dns-name.txt, so the TLS listener
// lifecycle can be exercised without a Tailscale install or a real ACME
// round-trip. Never set outside tests.
const TEST_TLS_DIR_ENV = "EXXPERTS_REMOTE_TEST_TLS_DIR";

// Detection is by well-known install locations, not PATH alone: both macOS
// GUI variants ship the CLI inside the app bundle and put nothing on PATH.
const TAILSCALE_CANDIDATES: string[] =
	process.platform === "darwin"
		? ["tailscale", "/Applications/Tailscale.app/Contents/MacOS/Tailscale", "/usr/local/bin/tailscale", "/opt/homebrew/bin/tailscale"]
		: process.platform === "win32"
			? ["tailscale", "C:\\Program Files\\Tailscale\\tailscale.exe"]
			: ["tailscale", "/usr/bin/tailscale", "/usr/local/bin/tailscale"];

function run(command: string, args: string[], timeoutMs: number): Promise<{ ok: true; stdout: string } | { ok: false; error: string }> {
	return new Promise((resolve) => {
		execFile(command, args, { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024, windowsHide: true }, (error, stdout, stderr) => {
			if (error) resolve({ ok: false, error: String(stderr || error.message).trim().slice(0, 400) });
			else resolve({ ok: true, stdout: String(stdout) });
		});
	});
}

async function findTailscaleBinary(): Promise<string | null> {
	for (const candidate of TAILSCALE_CANDIDATES) {
		if (candidate.includes(path.sep) && !fs.existsSync(candidate)) continue;
		const probe = await run(candidate, ["version"], 10_000);
		if (probe.ok) return candidate;
	}
	return null;
}

async function readDnsName(binary: string): Promise<{ ok: true; dnsName: string } | { ok: false; reason: string }> {
	const status = await run(binary, ["status", "--json"], 15_000);
	if (!status.ok) return { ok: false, reason: `Tailscale did not answer a status request: ${status.error}` };
	try {
		const parsed = JSON.parse(status.stdout) as { Self?: { DNSName?: unknown } };
		const dnsName = String(parsed.Self?.DNSName ?? "").trim().replace(/\.$/, "");
		if (!dnsName) return { ok: false, reason: "this machine has no MagicDNS name; turn on MagicDNS in the Tailscale admin console" };
		return { ok: true, dnsName };
	} catch {
		return { ok: false, reason: "Tailscale's status output could not be read" };
	}
}

function readTestMaterial(): RemoteTlsResult {
	const dir = String(process.env[TEST_TLS_DIR_ENV] ?? "").trim();
	try {
		return {
			ok: true,
			material: {
				cert: fs.readFileSync(path.join(dir, "cert.pem"), "utf8"),
				key: fs.readFileSync(path.join(dir, "key.pem"), "utf8"),
				dnsName: fs.readFileSync(path.join(dir, "dns-name.txt"), "utf8").trim(),
			},
		};
	} catch (error) {
		return { ok: false, reason: `test TLS material unreadable: ${(error as Error).message}` };
	}
}

/**
 * Split the CLI's stdout into the certificate chain and the private key.
 * With `--cert-file - --key-file -` in one invocation the CLI streams the
 * full chain (one or more CERTIFICATE blocks) followed by exactly one
 * PRIVATE KEY block. Returns null when stdout does not carry that shape.
 */
function splitPemStream(stdout: string): { cert: string; key: string } | null {
	const blocks = stdout.match(/-----BEGIN [^-]+-----[\s\S]*?-----END [^-]+-----/g) ?? [];
	const certBlocks = blocks.filter((block) => block.startsWith("-----BEGIN CERTIFICATE-----"));
	const keyBlocks = blocks.filter((block) => /^-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/.test(block));
	if (certBlocks.length === 0 || keyBlocks.length !== 1) return null;
	return { cert: `${certBlocks.join("\n")}\n`, key: `${keyBlocks[0]}\n` };
}

/**
 * Say what stdout actually carried when it was not usable PEM material,
 * without ever echoing key material back. Raw text is only quoted when no
 * PEM block of any kind was present.
 */
function describeUnusableStdout(stdout: string): string {
	if (!/-----BEGIN /.test(stdout)) {
		const snippet = stdout.trim().slice(0, 200);
		return snippet ? `got: ${snippet}` : "stdout was empty";
	}
	const certCount = (stdout.match(/-----BEGIN CERTIFICATE-----/g) ?? []).length;
	const keyCount = (stdout.match(/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/g) ?? []).length;
	return `stdout carried ${certCount} certificate block(s) and ${keyCount} private key block(s)`;
}

/** Write a private file next to its final name, then rename into place. */
function writePrivateFileAtomic(file: string, content: string): void {
	const tmp = `${file}.tmp-${process.pid}`;
	fs.writeFileSync(tmp, content, { mode: 0o600 });
	fs.renameSync(tmp, file);
}

/**
 * Mint or renew the tunnel certificate and return the PEM material. The
 * renewal recipe is `--min-validity=720h`, which no-ops while the cert is
 * fresh (Let's Encrypt duplicate-certificate limits are real) and renews
 * synchronously when it is not; an older client without the flag gets a
 * plain `tailscale cert` retry. Renewal is our job: tailscaled auto-renews
 * only for its own file-less integrations.
 *
 * The PEMs are streamed to stdout (`--cert-file - --key-file -`) and OUR
 * process writes cert.pem/key.pem, because the Mac App Store build's CLI is
 * sandboxed and cannot write outside its own container: handing it paths in
 * our state dir fails with "operation not permitted". Streaming to stdout
 * works from inside the sandbox, and success is exit 0 plus parseable PEM;
 * anything the CLI prints to stderr on a zero exit (the macOS sandbox
 * warning line, for one) is noise, not failure.
 */
export async function acquireTunnelTls(): Promise<RemoteTlsResult> {
	// Test mode never reaches the real CLI: with fixture material it is used,
	// without it the mint fails deterministically. A machine whose own
	// Tailscale could mint a real certificate must not leak that into a smoke
	// that faked its tunnel and expects plain http.
	if (isRemoteTestModeEnabled()) {
		if (String(process.env[TEST_TLS_DIR_ENV] ?? "").trim()) return readTestMaterial();
		return { ok: false, reason: "test mode provides no TLS material" };
	}
	const binary = await findTailscaleBinary();
	if (!binary) return { ok: false, reason: "the Tailscale command-line tool was not found on this machine" };
	const named = await readDnsName(binary);
	if (!named.ok) return { ok: false, reason: named.reason };

	// First issuance is a live ACME round-trip and can take a while; renewals
	// and no-ops return quickly.
	let minted = await run(binary, ["cert", "--cert-file", "-", "--key-file", "-", "--min-validity", "720h", named.dnsName], 120_000);
	if (!minted.ok && /min-validity|flag provided|unknown flag/i.test(minted.error)) {
		minted = await run(binary, ["cert", "--cert-file", "-", "--key-file", "-", named.dnsName], 120_000);
	}
	if (!minted.ok) {
		return { ok: false, reason: `Tailscale could not issue a certificate: ${minted.error}` };
	}
	const material = splitPemStream(minted.stdout);
	if (!material) {
		return { ok: false, reason: `Tailscale answered but did not return usable certificate material (${describeUnusableStdout(minted.stdout)})` };
	}

	// Keep the on-disk copy our own job too, for the same sandbox reason.
	// The material in hand is what the listener uses; a failed disk write
	// must not cost us a certificate we already hold.
	try {
		ensureProductAppStateRoot();
		const dir = productAppStatePath("remote-tls");
		fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
		writePrivateFileAtomic(path.join(dir, "cert.pem"), material.cert);
		writePrivateFileAtomic(path.join(dir, "key.pem"), material.key);
	} catch {
		// Best-effort by design; the returned material is complete without it.
	}
	return { ok: true, material: { cert: material.cert, key: material.key, dnsName: named.dnsName } };
}
