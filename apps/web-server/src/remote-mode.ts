import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import os from "node:os";
import type { Socket } from "node:net";
import { ensureProductAppStateRoot, productAppStatePath } from "../../../pi-package/product-state-paths.js";
import { acquireTunnelTls, type RemoteTlsMaterial } from "./remote-tls.js";

// Remote mode: an OFF-by-default second listener on the machine's own tailnet
// address, so the user's enrolled phone can reach the app through a private
// tunnel. This module owns the mode's state file, tailnet-address detection,
// and the tunnel listener's lifecycle. Two invariants shape everything here:
//
// 1. Remote OFF is byte-identical to today. With no state file, this module
//    starts nothing, tags nothing, and no predicate elsewhere changes
//    behavior. A malformed state file boots the server with remote OFF and a
//    logged reason; it must never fail the boot.
// 2. A remote failure never takes the loopback listener down. Bind errors,
//    address loss, and runtime listener errors degrade to "remote off with a
//    logged reason"; nothing in this module can touch the primary server.

const REMOTE_STATE_FILE = () => productAppStatePath("remote-mode.json");

// Test hook (smokes only): forces tailnet-address detection to this value so
// the listener lifecycle can be exercised without a real tunnel. ::1 is the
// usual choice, since the primary listener binds 127.0.0.1 IPv4 only and the
// same port stays free on IPv6 loopback. Also unlocks the drop-listener test
// route in index.ts. Never set outside tests.
const TEST_ADDRESS_ENV = "EXXPERTS_REMOTE_TEST_ADDRESS";

export type RemoteStateFileKind = "absent" | "valid" | "malformed";

export interface RemoteStatus {
	/** True when the tunnel listener is up and serving. */
	enabled: boolean;
	/** The address the tunnel listener is bound to, null when not serving. */
	address: string | null;
	port: number;
	/**
	 * A tailnet address present on this machine right now, serving or not.
	 * This is what lets the Settings page distinguish "install a tunnel
	 * first" from "ready to turn on" before remote is ever enabled.
	 */
	tunnelAddress: string | null;
	/** What the tunnel listener speaks; null while not serving. */
	scheme: "http" | "https" | null;
	/** The MagicDNS name the https listener's certificate is valid for. */
	dnsName: string | null;
	/**
	 * Why the listener serves plain http although https was attempted (no
	 * Tailscale CLI, no MagicDNS, certificates not enabled, ...). Null when
	 * serving https or not serving at all.
	 */
	tlsFallbackReason: string | null;
	/**
	 * Set when the state file says enabled but the listener is not serving
	 * (no tailnet address, bind failure, address lost mid-run). The mode
	 * self-heals: while degraded, the manager retries when the address
	 * reappears.
	 */
	degradedReason: string | null;
	stateFile: RemoteStateFileKind;
	/**
	 * Whether the machine is asked to stay awake while remote is enabled
	 * (macOS: a caffeinate system-sleep assertion held for the enabled
	 * lifetime; elsewhere the preference persists but holds nothing yet).
	 */
	keepAwake: boolean;
}

export type RemoteEnableResult =
	| { ok: true; address: string }
	| { ok: false; code: "no_tunnel_address" | "bind_failed"; error: string };

interface RemoteModeLogger {
	info: (msg: string) => void;
	warn: (obj: unknown, msg?: string) => void;
}

// IPv4 tailnet addresses come from the CGNAT block 100.64.0.0/10; tailnets
// may pin a smaller pool inside it, so the /10 is the correct test and any
// narrower range would be wrong. IPv6 tailnet addresses come from
// fd7a:115c:a1e0::/48.
export function isTailnetAddress(address: string): boolean {
	const value = address.trim().toLowerCase();
	const v4 = value.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
	if (v4) {
		const [a, b, c, d] = v4.slice(1).map(Number);
		if ([a, b, c, d].some((n) => n > 255)) return false;
		return a === 100 && b >= 64 && b <= 127;
	}
	return value.startsWith("fd7a:115c:a1e0:");
}

// Detection is by address shape, never by interface name: macOS allocates
// utunN dynamically (other VPNs claim the low numbers), Windows names the
// adapter after the vendor, and the tailscale CLI is not on PATH for either
// macOS GUI variant. The address ranges are the stable contract.
export function detectTailnetAddress(): string | null {
	const testAddress = String(process.env[TEST_ADDRESS_ENV] ?? "").trim();
	if (testAddress) return testAddress;
	for (const addresses of Object.values(os.networkInterfaces())) {
		for (const info of addresses ?? []) {
			if (info.internal) continue;
			if (isTailnetAddress(info.address)) return info.address;
		}
	}
	return null;
}

export function isRemoteTestModeEnabled(): boolean {
	return Boolean(String(process.env[TEST_ADDRESS_ENV] ?? "").trim());
}

// Peer addresses the tunnel listener accepts. Real tunnels deliver the peer's
// own tailnet address as the socket peer (no NAT on a direct peer
// connection); anything else on a tunnel-tagged socket is refused. In test
// mode the faked listener sits on loopback, so loopback peers are accepted
// THERE ONLY; this never widens the real predicate because the env var is a
// smoke-only hook.
export function isAllowedTunnelPeerAddress(address: string): boolean {
	if (isTailnetAddress(address)) return true;
	if (!isRemoteTestModeEnabled()) return false;
	return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}

type LoadedState =
	| { kind: "absent" }
	| { kind: "malformed"; reason: string }
	| { kind: "valid"; enabledAt: string; keepAwake: boolean };

function loadStateFile(): LoadedState {
	let raw: string;
	try {
		raw = fs.readFileSync(REMOTE_STATE_FILE(), "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return { kind: "absent" };
		return { kind: "malformed", reason: `unreadable: ${(error as Error).message}` };
	}
	try {
		const parsed = JSON.parse(raw) as { enabled?: unknown; enabledAt?: unknown; keepAwake?: unknown };
		if (parsed?.enabled !== true) return { kind: "malformed", reason: "state file present but enabled is not true" };
		// Only an explicit false turns keep-awake off: the flag defaults to
		// true, and state files written before it existed mean "on".
		return { kind: "valid", enabledAt: String(parsed.enabledAt ?? ""), keepAwake: parsed.keepAwake !== false };
	} catch (error) {
		return { kind: "malformed", reason: `invalid JSON: ${(error as Error).message}` };
	}
}

export interface RemoteModeManager {
	status(): RemoteStatus;
	enable(): Promise<RemoteEnableResult>;
	disable(): Promise<void>;
	/** Start the listener at boot when the state file asks for it. Never throws. */
	applyBootState(): Promise<void>;
	/** True when this socket was accepted by the tunnel listener. */
	isRemoteSocket(socket: unknown): boolean;
	/**
	 * Exact-self Host allowlist for tunnel requests: the machine's OWN bound
	 * tunnel address with the port, nothing range-shaped. This is the
	 * DNS-rebinding guard restated for the tunnel listener (Host must match
	 * bind host): a foreign hostname resolving to this address still arrives
	 * with the attacker's name in Host and fails the exact match.
	 */
	isOwnTunnelHost(hostHeader: string): boolean;
	/** Exact-self Origin allowlist, the http origin form of the same identity. */
	isOwnTunnelOrigin(origin: string): boolean;
	/**
	 * The one address the session cookie is scoped to: "name:port" when the
	 * listener serves https under a certificate's DNS name, null on plain
	 * http (where the bound address IS the only identity and nothing needs
	 * canonicalizing). The guard uses this to redirect a request that arrived
	 * on the listener's OTHER accepted self-spelling (the raw tunnel
	 * address), which would otherwise carry no cookie and look unpaired.
	 */
	canonicalTunnelHost(): string | null;
	/**
	 * Associate an authenticated tunnel socket with its device, so revoking
	 * the device can force-close its live connections instead of waiting for
	 * cookies or keep-alive to drain.
	 */
	registerDeviceSocket(socket: unknown, deviceId: string): void;
	/** Destroy every live socket bound to this device. */
	closeDeviceSockets(deviceId: string): void;
	/**
	 * Persist the keep-awake preference and apply it now: while remote is
	 * enabled, turning it on holds the sleep assertion and turning it off
	 * releases it. Returns true when the stored value actually changed.
	 */
	setKeepAwake(value: boolean): boolean;
	/** Test hook: run the shared failure path as if the address vanished. */
	simulateAddressLoss(): void;
	/** Test hook: force one watcher tick instead of waiting out the 30s interval. */
	simulateRecheck(): void;
	stop(): Promise<void>;
}

export function createRemoteModeManager(options: {
	port: number;
	/** The primary Fastify server; tunnel requests/upgrades are forwarded into its listeners. */
	appServer: http.Server;
	log: RemoteModeLogger;
}): RemoteModeManager {
	const { port, appServer, log } = options;

	let listener: http.Server | https.Server | null = null;
	let boundAddress: string | null = null;
	let degradedReason: string | null = null;
	let stateFileKind: RemoteStateFileKind = "absent";
	let recheckTimer: NodeJS.Timeout | null = null;
	// TLS state. Material is acquired (or refused with a reason) once per
	// enable/boot and reused across address rebinds; the renewal timer keeps
	// a serving https listener's certificate fresh via setSecureContext.
	let tlsMaterial: RemoteTlsMaterial | null = null;
	let tlsFallbackReason: string | null = null;
	let tlsAttempted = false;
	let boundScheme: "http" | "https" | null = null;
	let tlsRenewTimer: NodeJS.Timeout | null = null;
	// Keep-awake state. The preference defaults to on and rides in the
	// remote state file; the caffeinate child exists only while remote is
	// enabled on macOS with the preference on.
	let keepAwake = true;
	let persistedEnabledAt: string | null = null;
	let caffeinateChild: ChildProcess | null = null;
	let exitKillerInstalled = false;
	// Tagging uses object identity, not address arithmetic: downstream guards
	// trust "this socket was accepted by the tunnel listener" first and check
	// address ranges only as belt-and-suspenders.
	const remoteSockets = new WeakSet<object>();
	// Live sockets, so disable/degrade can force-close active connections
	// instead of waiting for keep-alive to drain.
	const liveSockets = new Set<Socket>();
	// Authenticated socket -> device associations, for per-device revocation.
	const deviceSockets = new Map<string, Set<Socket>>();

	// Closes the listener and its sockets, nothing else. Deliberately does
	// NOT touch the recheck timer: the self-heal watcher must outlive a
	// degrade (the common real case is the tunnel dropping on sleep and
	// coming back later), so only a deliberate off (disable/stop) stops it.
	function closeListener(): void {
		for (const socket of liveSockets) socket.destroy();
		liveSockets.clear();
		if (listener) {
			try { listener.close(); } catch {}
			listener = null;
		}
		boundAddress = null;
		boundScheme = null;
		stopTlsRenewTimer();
	}

	function stopTlsRenewTimer(): void {
		if (tlsRenewTimer) {
			clearInterval(tlsRenewTimer);
			tlsRenewTimer = null;
		}
	}

	// One TLS attempt per enable/boot, reused across rebinds: the material is
	// per-machine, not per-address. A refusal is remembered with its reason
	// and the listener serves plain http inside the encrypted tunnel, as
	// before the TLS stage; nothing here can fail an enable.
	async function ensureTlsMaterial(): Promise<void> {
		if (tlsAttempted) return;
		tlsAttempted = true;
		log.info("remote mode: checking for an https certificate (Tailscale)");
		const result = await acquireTunnelTls();
		if (result.ok) {
			tlsMaterial = result.material;
			tlsFallbackReason = null;
		} else {
			tlsMaterial = null;
			tlsFallbackReason = result.reason;
			log.warn(`remote mode: serving plain http over the tunnel (${result.reason}). The tunnel itself stays encrypted end to end.`);
		}
	}

	// Renewal is our job (tailscaled auto-renews only for its own file-less
	// integrations). --min-validity makes the periodic run a cheap no-op
	// while the certificate is fresh; when it does renew, the listener hot
	// swaps its context without dropping connections. A failed renewal keeps
	// serving on the still-valid certificate and retries next tick.
	function startTlsRenewTimer(): void {
		tlsRenewTimer = setInterval(() => {
			void (async () => {
				const result = await acquireTunnelTls();
				if (!result.ok) {
					log.warn(`remote mode: certificate renewal check failed (${result.reason}); the current certificate stays in use`);
					return;
				}
				if (tlsMaterial && result.material.cert === tlsMaterial.cert) return;
				tlsMaterial = result.material;
				const current = listener;
				if (current && "setSecureContext" in current) {
					(current as https.Server).setSecureContext({ cert: result.material.cert, key: result.material.key });
					log.info("remote mode: https certificate renewed and hot-swapped");
				}
			})();
		}, 12 * 60 * 60 * 1000);
		tlsRenewTimer.unref();
	}

	function stopRecheckTimer(): void {
		if (recheckTimer) {
			clearInterval(recheckTimer);
			recheckTimer = null;
		}
	}

	// The shared failure path. Only ever touches the tunnel listener; the
	// primary server is not reachable from here by construction. Keeps (or
	// arms) the watcher so the address's return triggers a rebind.
	function degradeToOff(reason: string): void {
		closeListener();
		degradedReason = reason;
		if (stateFileKind === "valid" && !recheckTimer) startRecheckTimer();
		log.warn(`remote mode degraded to off: ${reason}. Local use is unaffected; remote retries when the tunnel address is back.`);
	}

	// One watcher tick: degrade when the address disappeared, rebind when it
	// is back or changed. Shared by the 30s interval and the test hook. The
	// rebind arm is gated on persisted intent: the watcher self-heals an
	// ENABLED remote, it never turns remote on by itself.
	function recheckNow(): void {
		const current = detectTailnetAddress();
		if (!current) {
			if (listener) degradeToOff("tailnet address lost");
			return;
		}
		if (stateFileKind !== "valid") return;
		if (!listener || current !== boundAddress) void bindListener(current);
	}

	function startRecheckTimer(): void {
		// While the state file asks for remote, watch the tailnet address.
		recheckTimer = setInterval(recheckNow, 30_000);
		recheckTimer.unref();
	}

	async function bindListener(address: string): Promise<RemoteEnableResult> {
		await ensureTlsMaterial();
		return new Promise((resolve) => {
			closeListener();
			const scheme: "http" | "https" = tlsMaterial ? "https" : "http";
			const server: http.Server | https.Server = tlsMaterial
				? https.createServer({ cert: tlsMaterial.cert, key: tlsMaterial.key })
				: http.createServer();
			// Mirror the primary server's HTTP-level timeouts so both listeners
			// present identical connection behavior.
			server.keepAliveTimeout = appServer.keepAliveTimeout;
			server.headersTimeout = appServer.headersTimeout;
			server.requestTimeout = appServer.requestTimeout;
			// Tagging must mark the socket a REQUEST will carry: on plain http
			// that is the TCP socket from "connection", but on https requests
			// carry the TLSSocket, which only exists from "secureConnection".
			// The raw TCP socket still joins liveSockets either way, so
			// disable/degrade can also kill handshakes still in flight.
			server.on("connection", (socket) => {
				if (scheme === "http") remoteSockets.add(socket);
				liveSockets.add(socket);
				socket.on("close", () => liveSockets.delete(socket));
			});
			if (scheme === "https") {
				(server as https.Server).on("secureConnection", (socket) => {
					remoteSockets.add(socket);
					liveSockets.add(socket);
					socket.on("close", () => liveSockets.delete(socket));
				});
			}
			// Forward into the Fastify server's own listeners so both listeners
			// share identical routing, hooks, and WS handling. The upgrade
			// forwarding is load-bearing: without it, remote WebSockets die
			// before the guard ever sees them.
			server.on("request", (req, res) => {
				for (const handler of appServer.listeners("request")) (handler as (...args: unknown[]) => void)(req, res);
			});
			server.on("upgrade", (req, socket, head) => {
				const handlers = appServer.listeners("upgrade");
				if (handlers.length === 0) {
					socket.destroy();
					return;
				}
				for (const handler of handlers) (handler as (...args: unknown[]) => void)(req, socket, head);
			});
			// A persistent handler, not once(): a server object with no "error"
			// listener turns any second emission into an uncaught exception,
			// which would take the whole process (and the loopback listener)
			// down. First emission decides; repeats are swallowed.
			let errorHandled = false;
			server.on("error", (error: NodeJS.ErrnoException) => {
				if (errorHandled) return;
				errorHandled = true;
				if (listener === server) {
					degradeToOff(`listener error: ${error.message}`);
				} else {
					// Bind-time failure: report to the caller, stay off.
					degradedReason = `bind failed: ${error.message}`;
					resolve({ ok: false, code: "bind_failed", error: `Could not bind the remote listener on ${address}:${port}: ${error.message}` });
				}
			});
			server.listen({ port, host: address }, () => {
				listener = server;
				boundAddress = address;
				boundScheme = scheme;
				degradedReason = null;
				const hostForLog = scheme === "https" && tlsMaterial ? tlsMaterial.dnsName : address.includes(":") ? `[${address}]` : address;
				log.info(`remote mode serving on ${scheme}://${hostForLog}:${port} (tunnel listener)`);
				if (!recheckTimer) startRecheckTimer();
				if (scheme === "https" && !tlsRenewTimer) startTlsRenewTimer();
				resolve({ ok: true, address });
			});
		});
	}

	// Hold a system-sleep assertion for the enabled lifetime (macOS only):
	// caffeinate -s blocks system sleep while on AC power, and -w <pid>
	// makes the OS release the assertion by itself the moment this process
	// dies, so a crash can never leave the machine sleepless. Idempotent: a
	// live child is reused, so repeated enables never stack assertions.
	function startKeepAwake(): void {
		if (process.platform !== "darwin" || !keepAwake) return;
		if (caffeinateChild && caffeinateChild.exitCode === null && !caffeinateChild.killed) return;
		const child = spawn("caffeinate", ["-s", "-w", String(process.pid)], { stdio: "ignore" });
		child.on("error", (error) => {
			if (caffeinateChild === child) caffeinateChild = null;
			log.warn(`remote mode: could not hold the machine awake (caffeinate failed to start: ${error.message}); remote keeps serving until the machine sleeps`);
		});
		child.on("exit", () => {
			if (caffeinateChild === child) caffeinateChild = null;
		});
		child.unref();
		caffeinateChild = child;
		if (!exitKillerInstalled) {
			exitKillerInstalled = true;
			// Best effort on process exit; -w above is the real safety net.
			process.once("exit", () => {
				try { caffeinateChild?.kill(); } catch {}
			});
		}
		log.info("remote mode: holding this computer awake while remote access is on (caffeinate)");
	}

	function stopKeepAwake(): void {
		if (!caffeinateChild) return;
		try { caffeinateChild.kill(); } catch {}
		caffeinateChild = null;
	}

	function writeStateFile(): void {
		ensureProductAppStateRoot();
		if (!persistedEnabledAt) persistedEnabledAt = new Date().toISOString();
		fs.writeFileSync(REMOTE_STATE_FILE(), `${JSON.stringify({ enabled: true, enabledAt: persistedEnabledAt, keepAwake }, null, "\t")}\n`, { mode: 0o600 });
		stateFileKind = "valid";
	}

	function deleteStateFile(): void {
		try {
			fs.unlinkSync(REMOTE_STATE_FILE());
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
		stateFileKind = "absent";
	}

	return {
		status(): RemoteStatus {
			return {
				enabled: listener !== null,
				address: boundAddress,
				port,
				tunnelAddress: detectTailnetAddress(),
				scheme: listener ? boundScheme : null,
				dnsName: listener && boundScheme === "https" && tlsMaterial ? tlsMaterial.dnsName : null,
				tlsFallbackReason: listener && boundScheme === "http" ? tlsFallbackReason : null,
				degradedReason,
				stateFile: stateFileKind,
				keepAwake,
			};
		},

		async enable(): Promise<RemoteEnableResult> {
			// An explicit enable re-probes TLS: the user may have just enabled
			// MagicDNS or certificates in the admin console, and "turn it off
			// and on again" should pick that up.
			tlsAttempted = false;
			const address = detectTailnetAddress();
			if (!address) {
				return {
					ok: false,
					code: "no_tunnel_address",
					error: "No tailnet address found on this machine. Install and start Tailscale (or your tunnel), sign in, then enable remote again.",
				};
			}
			const result = await bindListener(address);
			// Persist intent only after a successful bind: a failed enable
			// leaves no state file behind, so the next boot stays plain OFF.
			if (result.ok) {
				persistedEnabledAt = new Date().toISOString();
				writeStateFile();
				startKeepAwake();
			}
			return result;
		},

		async disable(): Promise<void> {
			stopKeepAwake();
			persistedEnabledAt = null;
			closeListener();
			stopRecheckTimer();
			degradedReason = null;
			tlsAttempted = false;
			tlsMaterial = null;
			tlsFallbackReason = null;
			deleteStateFile();
			log.info("remote mode disabled; the server is loopback-only again");
		},

		async applyBootState(): Promise<void> {
			const state = loadStateFile();
			stateFileKind = state.kind === "valid" ? "valid" : state.kind === "absent" ? "absent" : "malformed";
			if (state.kind === "absent") return;
			if (state.kind === "malformed") {
				// Fail to OFF, never to a failed boot: local use must survive a
				// corrupt remote state file.
				degradedReason = `state file malformed (${state.reason}); remote stays off. Run exxperts remote enable to rewrite it.`;
				log.warn(`remote mode: ${degradedReason}`);
				return;
			}
			keepAwake = state.keepAwake;
			persistedEnabledAt = state.enabledAt || null;
			// The enabled intent survived the restart, so the sleep assertion
			// resumes with it, even while degraded: staying awake is what lets
			// the watcher find the tunnel address again.
			startKeepAwake();
			const address = detectTailnetAddress();
			if (!address) {
				degradedReason = "enabled in state, but no tailnet address is present; remote stays off until the tunnel is back";
				log.warn(`remote mode: ${degradedReason}`);
				startRecheckTimer();
				return;
			}
			const result = await bindListener(address);
			if (!result.ok) log.warn(`remote mode: ${result.error}; remote stays off, local use is unaffected`);
			if (!recheckTimer) startRecheckTimer();
		},

		isRemoteSocket(socket: unknown): boolean {
			return typeof socket === "object" && socket !== null && remoteSockets.has(socket);
		},

		// Exact-self identity, in both of its spellings: the bound tunnel
		// address, and (under https) the MagicDNS name the certificate is for.
		// Still nothing range-shaped; a foreign hostname resolving here keeps
		// arriving with the attacker's name in Host and keeps failing.
		isOwnTunnelHost(hostHeader: string): boolean {
			if (!boundAddress) return false;
			const value = hostHeader.trim().toLowerCase();
			const bracketed = boundAddress.includes(":") ? `[${boundAddress.toLowerCase()}]` : boundAddress;
			if (value === `${bracketed}:${port}`) return true;
			if (boundScheme === "https" && tlsMaterial) return value === `${tlsMaterial.dnsName.toLowerCase()}:${port}`;
			return false;
		},

		canonicalTunnelHost(): string | null {
			if (!listener || boundScheme !== "https" || !tlsMaterial) return null;
			return `${tlsMaterial.dnsName.toLowerCase()}:${port}`;
		},

		isOwnTunnelOrigin(origin: string): boolean {
			if (!boundAddress || !boundScheme) return false;
			const value = origin.trim().toLowerCase();
			const bracketed = boundAddress.includes(":") ? `[${boundAddress.toLowerCase()}]` : boundAddress;
			if (value === `${boundScheme}://${bracketed}:${port}`) return true;
			if (boundScheme === "https" && tlsMaterial) return value === `https://${tlsMaterial.dnsName.toLowerCase()}:${port}`;
			return false;
		},

		registerDeviceSocket(socket: unknown, deviceId: string): void {
			if (typeof socket !== "object" || socket === null || !remoteSockets.has(socket)) return;
			const typed = socket as Socket;
			let set = deviceSockets.get(deviceId);
			if (!set) {
				set = new Set();
				deviceSockets.set(deviceId, set);
			}
			if (!set.has(typed)) {
				set.add(typed);
				typed.on("close", () => {
					set.delete(typed);
					if (set.size === 0) deviceSockets.delete(deviceId);
				});
			}
		},

		closeDeviceSockets(deviceId: string): void {
			const set = deviceSockets.get(deviceId);
			if (!set) return;
			for (const socket of [...set]) socket.destroy();
			deviceSockets.delete(deviceId);
		},

		setKeepAwake(value: boolean): boolean {
			if (keepAwake === value) return false;
			keepAwake = value;
			// Persist alongside the enabled intent; with remote off there is
			// no state file to carry it and the default (on) applies anew.
			if (stateFileKind === "valid") writeStateFile();
			if (value && stateFileKind === "valid") startKeepAwake();
			else stopKeepAwake();
			return true;
		},

		simulateAddressLoss(): void {
			degradeToOff("tailnet address lost (test)");
		},

		simulateRecheck(): void {
			recheckNow();
		},

		async stop(): Promise<void> {
			stopKeepAwake();
			closeListener();
			stopRecheckTimer();
		},
	};
}
