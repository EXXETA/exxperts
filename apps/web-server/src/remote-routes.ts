import { listPersistentAgents } from "./persistent-agents.js";
import { readPersistentRoomDefaultCapabilityPolicy, persistentRoomCapabilityPolicyView } from "./persistent-room-workspace-policy.js";
import { listTaskLedgerRecords } from "./persistent-room-task-ledger.js";
import { isRemoteTestModeEnabled } from "./remote-mode.js";
import { classifyRemoteRoute } from "./remote-route-policy.js";
import { qrMatrixFor } from "./remote-qr.js";
import { serverHooks, isSharedServer } from "./server-hooks.js";
import { app, PORT } from "./server-app.js";
import { ARTIFACT_SECURITY_HEADERS, enrollBeginLimiter, enrollStatusLimiter, refuseRemoteAdminFromTunnel, registeredRouteInventory, REMOTE_DEVICE_COOKIE_MAX_AGE_S, REMOTE_DEVICE_COOKIE_NAME, remoteAudit, remoteDevices, remoteMode, remoteRoomExposure, staticSecurityHeadersFor } from "./request-checks.js";

app.get("/api/remote/status", async (req, reply) => {
	if (refuseRemoteAdminFromTunnel(req, reply)) return;
	return remoteMode.status();
});

app.post("/api/remote/enable", async (req, reply) => {
	if (refuseRemoteAdminFromTunnel(req, reply)) return;
	const result = await remoteMode.enable();
	if (!result.ok) return reply.code(result.code === "no_tunnel_address" ? 412 : 500).send({ error: result.error, code: result.code });
	remoteAudit("remote_enabled");
	return { ok: true, address: result.address, status: remoteMode.status() };
});

app.post("/api/remote/disable", async (req, reply) => {
	if (refuseRemoteAdminFromTunnel(req, reply)) return;
	// Disable also kills any outstanding pairing code and pending approvals:
	// "off" means nothing about remote stays actionable.
	remoteDevices.invalidateEnrollment();
	await remoteMode.disable();
	remoteAudit("remote_disabled");
	return { ok: true, status: remoteMode.status() };
});

// Keep-awake preference (loopback only, like all remote admin): whether
// this computer holds a system-sleep assertion while remote access is on.
// The audit line is written only when the stored value actually changed.
app.post("/api/remote/keep-awake", async (req, reply) => {
	if (refuseRemoteAdminFromTunnel(req, reply)) return;
	const value = (req.body as Record<string, unknown> | undefined)?.keepAwake;
	if (typeof value !== "boolean") {
		return reply.code(400).send({ error: "keepAwake must be true or false", code: "remote_bad_keep_awake" });
	}
	if (remoteMode.setKeepAwake(value)) remoteAudit(value ? "keepawake_enabled" : "keepawake_disabled");
	return { ok: true, status: remoteMode.status() };
});

// Test hook (smokes only, gated on the same env var that fakes the tailnet
// address): runs the shared failure path as if the address vanished, so the
// resilience smoke can assert that remote degrades to off while loopback
// keeps serving.
app.post("/api/remote/test/drop-listener", async (req, reply) => {
	if (!isRemoteTestModeEnabled()) return reply.code(404).send({ error: "not found" });
	if (refuseRemoteAdminFromTunnel(req, reply)) return;
	remoteMode.simulateAddressLoss();
	return { ok: true, status: remoteMode.status() };
});

// Test hook (smokes only): force one watcher tick so the address-returns
// rebind can be asserted without waiting out the 30s interval.
app.post("/api/remote/test/recheck", async (req, reply) => {
	if (!isRemoteTestModeEnabled()) return reply.code(404).send({ error: "not found" });
	if (refuseRemoteAdminFromTunnel(req, reply)) return;
	remoteMode.simulateRecheck();
	return { ok: true, status: remoteMode.status() };
});

// Device administration (loopback only, like all remote admin): the list the
// Settings mirror renders, per-device revocation that force-closes the
// device's live sockets, and capability changes that do the same so a
// downgrade takes effect immediately instead of at the next reconnect.
app.get("/api/remote/devices", async (req, reply) => {
	if (refuseRemoteAdminFromTunnel(req, reply)) return;
	return { devices: remoteDevices.list() };
});

app.post("/api/remote/devices/revoke", async (req, reply) => {
	if (refuseRemoteAdminFromTunnel(req, reply)) return;
	const id = String((req.body as Record<string, unknown> | undefined)?.id ?? "");
	if (!remoteDevices.revoke(id)) return reply.code(404).send({ error: "No such device.", code: "remote_device_not_found" });
	remoteMode.closeDeviceSockets(id);
	remoteAudit("device_revoked", { deviceId: id });
	return { ok: true, devices: remoteDevices.list() };
});

app.post("/api/remote/devices/capability", async (req, reply) => {
	if (refuseRemoteAdminFromTunnel(req, reply)) return;
	const body = (req.body ?? {}) as Record<string, unknown>;
	const id = String(body.id ?? "");
	const capability = String(body.capability ?? "");
	if (capability !== "full" && capability !== "read-only") {
		return reply.code(400).send({ error: "capability must be full or read-only", code: "remote_bad_capability" });
	}
	if (!remoteDevices.setCapability(id, capability)) return reply.code(404).send({ error: "No such device.", code: "remote_device_not_found" });
	remoteMode.closeDeviceSockets(id);
	remoteAudit("device_capability_changed", { deviceId: id, capability });
	return { ok: true, devices: remoteDevices.list() };
});

// Enrollment, computer side (loopback only): mint the single-use code the QR
// carries, list pending approvals, approve or deny. The code is random and
// unrelated to the master token; minting a new one replaces any outstanding
// one.
app.post("/api/remote/enroll-code", async (req, reply) => {
	if (refuseRemoteAdminFromTunnel(req, reply)) return;
	const status = remoteMode.status();
	if (!status.enabled || !status.address) {
		return reply.code(412).send({ error: "Remote mode is not serving; enable it first.", code: "remote_not_serving" });
	}
	const minted = remoteDevices.mintEnrollCode();
	remoteAudit("enroll_code_minted");
	// Under https the QR flips from address-primary to name-primary: the
	// certificate carries a DNS SAN only (no public CA validates CGNAT
	// space), so the MagicDNS name is the address that gets the padlock.
	const host = status.scheme === "https" && status.dnsName ? status.dnsName : status.address.includes(":") ? `[${status.address}]` : status.address;
	const url = `${status.scheme ?? "http"}://${host}:${PORT}/remote/enroll?code=${minted.code}`;
	// The matrix rides along for the Settings page, which renders it as an
	// SVG; the CLI keeps drawing its own terminal QR from the same url. A
	// null matrix (encoder unavailable) is simply omitted: the page falls
	// back to showing the URL, which is the mechanism anyway.
	const matrix = qrMatrixFor(url);
	return { ok: true, url, ...(matrix ? { matrix } : {}), expiresAt: minted.expiresAt };
});

app.get("/api/remote/enroll-pending", async (req, reply) => {
	if (refuseRemoteAdminFromTunnel(req, reply)) return;
	return { pending: remoteDevices.pendingApprovals() };
});

app.post("/api/remote/enroll-approve", async (req, reply) => {
	if (refuseRemoteAdminFromTunnel(req, reply)) return;
	const body = (req.body ?? {}) as Record<string, unknown>;
	const capability = body.capability === "read-only" ? "read-only" : "full";
	const approvedDeviceId = remoteDevices.approve(String(body.requestId ?? ""), capability);
	if (!approvedDeviceId) {
		return reply.code(404).send({ error: "No such pending pairing request.", code: "remote_enroll_not_found" });
	}
	remoteAudit("enroll_approved", { deviceId: approvedDeviceId, capability });
	return { ok: true, devices: remoteDevices.list() };
});

app.post("/api/remote/enroll-deny", async (req, reply) => {
	if (refuseRemoteAdminFromTunnel(req, reply)) return;
	if (!remoteDevices.deny(String((req.body as Record<string, unknown> | undefined)?.requestId ?? ""))) {
		return reply.code(404).send({ error: "No such pending pairing request.", code: "remote_enroll_not_found" });
	}
	remoteAudit("enroll_denied");
	return { ok: true };
});

// Enrollment, phone side (tunnel only; on the loopback listener these routes
// answer with Fastify's own not-found so the loopback surface is unchanged).
// The guard's tunnel branch lets exactly these paths through pre-auth; they
// rate-limit and validate here.
function refuseEnrollOutsideTunnel(req: any, reply: any): boolean {
	if (!remoteMode.isRemoteSocket(req.raw?.socket)) {
		reply.callNotFound();
		return true;
	}
	return false;
}

const REMOTE_ENROLL_PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Pair with Exxperts</title>
<style>
body { font-family: system-ui, sans-serif; background: #111; color: #eee; display: flex; min-height: 100vh; align-items: center; justify-content: center; margin: 0; }
main { max-width: 34rem; padding: 2rem; text-align: center; }
h1 { font-size: 1.3rem; }
p { line-height: 1.5; }
</style>
</head>
<body>
<main>
<h1>Pairing this device</h1>
<p id="msg">Contacting your computer...</p>
</main>
<script src="/remote/enroll.js"></script>
</body>
</html>
`;

// Separate file instead of an inline script: the static CSP allows only
// script-src 'self', and the enroll page must not weaken it.
const REMOTE_ENROLL_SCRIPT = `"use strict";
const msg = document.getElementById("msg");
function guessName() {
	const ua = navigator.userAgent;
	const device = /iPhone/.test(ua) ? "iPhone" : /iPad/.test(ua) ? "iPad" : /Android/.test(ua) ? "Android device" : /Macintosh/.test(ua) ? "Mac" : /Windows/.test(ua) ? "Windows device" : "Device";
	const browser = /CriOS|Chrome/.test(ua) ? "Chrome" : /FxiOS|Firefox/.test(ua) ? "Firefox" : /Safari/.test(ua) ? "Safari" : "browser";
	return device + " (" + browser + ")";
}
async function run() {
	const code = new URLSearchParams(location.search).get("code") || "";
	if (!code) { msg.textContent = "This pairing link is missing its code. Scan the QR on your computer again."; return; }
	let requestId = "";
	try {
		const res = await fetch("/remote/enroll/exchange", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code, name: guessName() }) });
		if (!res.ok) { msg.textContent = "This pairing code is no longer valid. Generate a fresh one on your computer and scan again."; return; }
		requestId = String((await res.json()).requestId || "");
	} catch { msg.textContent = "Could not reach your computer. Check that it is awake and on the tunnel, then scan again."; return; }
	msg.textContent = "Now approve this device on your computer.";
	for (;;) {
		await new Promise((r) => setTimeout(r, 2000));
		let body;
		try {
			const res = await fetch("/remote/enroll/status?requestId=" + requestId);
			if (!res.ok) continue;
			body = await res.json();
		} catch { continue; }
		if (body.state === "approved") { msg.textContent = "Paired. Opening Exxperts..."; location.replace("/"); return; }
		if (body.state === "denied") { msg.textContent = "Pairing was declined on the computer."; return; }
		if (body.state === "unknown") { msg.textContent = "This pairing attempt expired. Generate a fresh code on your computer and scan again."; return; }
	}
}
run();
`;

app.get("/remote/enroll", async (req, reply) => {
	if (refuseEnrollOutsideTunnel(req, reply)) return;
	if (!enrollBeginLimiter()) {
		remoteAudit("rate_limited", { path: "/remote/enroll" });
		return reply.code(429).send({ error: "Too many pairing attempts. Wait a minute and scan again.", code: "remote_rate_limited" });
	}
	return reply.headers(staticSecurityHeadersFor(req)).type("text/html; charset=utf-8").send(REMOTE_ENROLL_PAGE);
});

app.get("/remote/enroll.js", async (req, reply) => {
	if (refuseEnrollOutsideTunnel(req, reply)) return;
	return reply.headers(staticSecurityHeadersFor(req)).type("application/javascript; charset=utf-8").send(REMOTE_ENROLL_SCRIPT);
});

app.post("/remote/enroll/exchange", async (req, reply) => {
	if (refuseEnrollOutsideTunnel(req, reply)) return;
	if (!enrollBeginLimiter()) {
		app.log.warn({ listener: "tunnel" }, "enroll exchange rate limited");
		remoteAudit("rate_limited", { path: "/remote/enroll/exchange" });
		return reply.code(429).send({ error: "Too many pairing attempts. Wait a minute and scan again.", code: "remote_rate_limited" });
	}
	const body = (req.body ?? {}) as Record<string, unknown>;
	const result = remoteDevices.beginExchange(String(body.code ?? ""), body.name);
	if (!result.ok) {
		// Redacted on purpose: never log code material, only the outcome.
		app.log.warn({ listener: "tunnel" }, "enroll exchange with invalid or expired code");
		remoteAudit("enroll_exchange_invalid");
		return reply.code(403).send({ error: "This pairing code is not valid.", code: "remote_enroll_invalid_code" });
	}
	// The device name is user-controlled input; it is sanitized by the store
	// and shown in the approval list, not echoed into logs or the audit file.
	app.log.info("remote pairing requested; approve or deny on the computer");
	remoteAudit("enroll_requested");
	return { ok: true, requestId: result.requestId };
});

app.get("/remote/enroll/status", async (req, reply) => {
	if (refuseEnrollOutsideTunnel(req, reply)) return;
	if (!enrollStatusLimiter()) {
		remoteAudit("rate_limited", { path: "/remote/enroll/status" });
		return reply.code(429).send({ error: "Too many attempts. Wait a minute.", code: "remote_rate_limited" });
	}
	const requestId = String((req.query as Record<string, unknown> | undefined)?.requestId ?? "");
	const status = remoteDevices.exchangeStatus(requestId);
	if (status.state === "approved" && status.key) {
		// The one moment the device key crosses the wire: as an HttpOnly
		// cookie on the poll response, over the encrypted tunnel, exactly
		// once. Max-Age is a hint; the record's server-side expiry decides.
		// Secure rides along whenever the transport is TLS (read off the
		// actual socket, not configuration), so on the https listener the
		// key can never be replayed over a plain-http downgrade.
		const secure = (req.raw.socket as { encrypted?: boolean }).encrypted === true ? "; Secure" : "";
		reply.header("set-cookie", `${REMOTE_DEVICE_COOKIE_NAME}=${status.key}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${REMOTE_DEVICE_COOKIE_MAX_AGE_S}${secure}`);
	}
	return { state: status.state };
});

app.addHook("onClose", async () => {
	await remoteMode.stop();
});

// A shared-server entry's client-context (server-hooks.ts; none on the desktop): it may add to the local answer.
const clientContext = serverHooks().clientContext ?? ((_req, _reply, base) => base);

// What kind of client is this connection? The web-ui asks once at boot and
// hides host-local affordances (native folder picker, save-to-disk) for
// remote devices. Purely cosmetic: the server enforces regardless.
app.get("/api/remote/client-context", async (req, reply) => {
	const device = (req as any).exxRemoteDevice as { capability?: string } | undefined;
	const sharedServer = isSharedServer();
	if (!device) return clientContext(req, reply, { remote: false, capability: "full", sharedServer });
	return { remote: true, capability: device.capability === "full" ? "full" : "read-only", sharedServer };
});

// Per-room exposure admin (loopback only). Every room is remotely reachable
// by default; the user can hide any room from remote devices. The write path
// living here, behind refuseRemoteAdminFromTunnel, is what makes "a phone
// can never widen its own access" structural.
app.get("/api/remote/rooms", async (req, reply) => {
	if (refuseRemoteAdminFromTunnel(req, reply)) return;
	return {
		rooms: listPersistentAgents().map((agent) => {
			const defaultPolicy = readPersistentRoomDefaultCapabilityPolicy(agent.id);
			const policyView = defaultPolicy ? persistentRoomCapabilityPolicyView(defaultPolicy) : null;
			return {
				id: agent.id,
				displayName: agent.displayName || agent.id,
				exposed: !remoteRoomExposure.isHidden(agent.id),
				// The Settings page flags rooms that can reach the computer: such a
				// room is still exposable by default (the user's own devices, full
				// capability by design), but the flags keep the reach visible.
				bashEnabled: policyView?.bashEnabled === true,
				writeEnabled: policyView?.writeEnabled === true,
			};
		}),
		hidden: [...remoteRoomExposure.hiddenRooms()].sort(),
	};
});

app.post("/api/remote/rooms/exposure", async (req, reply) => {
	if (refuseRemoteAdminFromTunnel(req, reply)) return;
	const body = (req.body ?? {}) as Record<string, unknown>;
	const id = String(body.id ?? "").trim();
	if (!id) return reply.code(400).send({ error: "id is required", code: "remote_bad_room" });
	remoteRoomExposure.setExposed(id, body.exposed === true);
	return { ok: true, hidden: [...remoteRoomExposure.hiddenRooms()].sort() };
});

// Test hook (smokes only): the live route table with each route's remote
// classification, so the coverage smoke can assert the policy is total.
app.get("/api/remote/test/routes", async (req, reply) => {
	if (!isRemoteTestModeEnabled()) return reply.code(404).send({ error: "not found" });
	if (refuseRemoteAdminFromTunnel(req, reply)) return;
	return {
		routes: registeredRouteInventory.map((route) => ({ ...route, class: classifyRemoteRoute(route.method, route.url) })),
	};
});

// Remote-device enforcement, after routing so the matched route pattern is
// known. Three layers, all fail-closed:
// 1. Route class: unclassified refuses; "local" is the computer's own
//    surface; "write" needs a full-capability device. Capability is read
//    from the device record on every request, and anything that is not
//    exactly "full" is treated as read-only.
// 2. Per-room exposure on room-keyed routes: a hidden room answers with the
//    same not-found shape as a nonexistent one, so remote devices cannot
//    distinguish hidden from absent.
// 3. Task artifacts: an artifact belonging to a hidden room's task is not
//    found, closing the taskId side channel.
// A room's words never sit in an HTTP cache (the desktop's, a phone's): a Forget leaves no copy behind.
app.addHook("onSend", async (req, reply, payload) => {
	if (req.url.startsWith("/api/") && !reply.hasHeader("cache-control")) reply.header("cache-control", "no-store");
	return payload;
});

app.addHook("preHandler", async (req, reply) => {
	const device = (req as any).exxRemoteDevice as { capability?: string } | undefined;
	if (!device) return;
	const routeUrl = String((req as any).routeOptions?.url ?? (req as any).routerPath ?? "");
	const routeClass = classifyRemoteRoute(req.method, routeUrl);
	if (routeClass === null) {
		app.log.warn({ route: `${req.method} ${routeUrl}` }, "remote device reached an unclassified route; refusing");
		return reply.code(403).send({ error: "This action is not available remotely.", code: "remote_unclassified_route" });
	}
	if (routeClass === "local") {
		return reply.code(403).send({ error: "This action is only available on the computer running Exxperts.", code: "remote_local_only" });
	}
	if (routeClass === "write" && device.capability !== "full") {
		return reply.code(403).send({ error: "This device is set to viewing only. Change it on the computer to interact remotely.", code: "remote_read_only" });
	}
	const params = (req.params ?? {}) as Record<string, string>;
	if (routeUrl.startsWith("/api/persistent-agents/:id")) {
		const id = String(params.id ?? "");
		if (id && remoteRoomExposure.isHidden(id)) {
			// The same body a nonexistent room answers with on these routes,
			// so hidden and nonexistent are indistinguishable.
			return reply.code(404).send({ error: `persistent agent not found: ${id}` });
		}
	} else if (routeUrl.startsWith("/api/persistent-agents/:targetId")) {
		const targetId = String(params.targetId ?? "");
		if (targetId && remoteRoomExposure.isHidden(targetId)) {
			return reply.code(404).send({ error: `persistent agent not found: ${targetId}` });
		}
	} else if (routeUrl.startsWith("/api/memory/rooms/:id")) {
		const id = String(params.id ?? "");
		// This family's own unknown-room shape.
		if (id && remoteRoomExposure.isHidden(id)) return reply.code(404).send({ error: "Room not found." });
	} else if (routeUrl.startsWith("/api/artifacts/:taskId") && remoteRoomExposure.hiddenRooms().size > 0) {
		const taskId = String(params.taskId ?? "");
		for (const roomId of remoteRoomExposure.hiddenRooms()) {
			let owned = false;
			try {
				owned = listTaskLedgerRecords(roomId).some((record) => record.taskId === taskId);
			} catch {
				// An unreadable hidden-room ledger must not grant access.
				owned = true;
			}
			if (owned) return reply.headers(ARTIFACT_SECURITY_HEADERS).code(404).send({ error: "Artifact not found." });
		}
	}
});
