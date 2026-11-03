import crypto from "node:crypto";
import { isAllowedTunnelPeerAddress, createRemoteModeManager } from "./remote-mode.js";
import { createRemoteDeviceStore, REMOTE_DEVICE_TTL_MS } from "./remote-devices.js";
import { createRemoteRoomExposureStore } from "./remote-room-exposure.js";
import { createRemoteAuditLog } from "./remote-audit-log.js";
import { serverHooks } from "./server-hooks.js";
import { serverStopping, SERVER_STOPPING_CODE, stopRefuses, refuseWhileStopping } from "./server-stop.js";
import { app, AUTH_COOKIE_NAME, AUTH_HEADER_NAME, AUTH_TOKEN, AUTH_TOKEN_FILE, PORT } from "./server-app.js";

// Both comparison sites (cookie and header) go through this so a candidate is
// never compared with an early-exit string equality. timingSafeEqual requires
// equal lengths; a length mismatch is an immediate non-match by definition.
function timingSafeTokenMatch(candidate: string): boolean {
	if (!candidate) return false;
	const candidateBuffer = Buffer.from(candidate);
	const tokenBuffer = Buffer.from(AUTH_TOKEN);
	if (candidateBuffer.length !== tokenBuffer.length) return false;
	return crypto.timingSafeEqual(candidateBuffer, tokenBuffer);
}

// The token is a hex string, so no cookie-value decoding is needed; a single
// hand-rolled Cookie header parse keeps this dependency-free.
function cookieValue(cookieHeader: unknown, name: string): string {
	for (const part of String(cookieHeader ?? "").split(";")) {
		const separator = part.indexOf("=");
		if (separator === -1) continue;
		if (part.slice(0, separator).trim() === name) return part.slice(separator + 1).trim();
	}
	return "";
}

// Origins the app itself is served from: the packaged server's own port plus
// the Vite dev server outside production. Browsers treat every localhost port
// as same-site, so the session cookie rides along on requests started by ANY
// locally served page; exact-origin pinning is what keeps another local
// program's page from riding it (see the WS check in the onRequest hook).
function isAppOrigin(origin: string): boolean {
	const allowed = [`http://localhost:${PORT}`, `http://127.0.0.1:${PORT}`, `http://[::1]:${PORT}`];
	if (process.env.NODE_ENV !== "production") allowed.push("http://localhost:5173", "http://127.0.0.1:5173", "http://[::1]:5173");
	return allowed.includes(origin);
}

// Served to a browser navigation that arrives without the session cookie
// (someone typed the URL, or a stale bookmark). Self-contained on purpose:
// asset routes also require auth, so this page must not reference any.
const UNAUTHENTICATED_PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Exxperts</title>
<style>
body { font-family: system-ui, sans-serif; background: #111; color: #eee; display: flex; min-height: 100vh; align-items: center; justify-content: center; margin: 0; }
main { max-width: 34rem; padding: 2rem; }
h1 { font-size: 1.3rem; }
code { background: #222; border-radius: 4px; padding: 0.1rem 0.4rem; }
p { line-height: 1.5; }
</style>
</head>
<body>
<main>
<h1>Exxperts is running, but this tab is not signed in</h1>
<p>Start the app with the <code>exxperts</code> command. It opens a browser tab that signs itself in automatically.</p>
<p>If no tab opens, run it again and use the link the command prints. If <code>exxperts</code> says it is already running, stop it with Ctrl+C in its terminal first, or reuse the sign-in link that terminal printed. Signing in needs that link once; after that this browser stays signed in.</p>
</main>
</body>
</html>
`;

// Served to a phone browser that reaches the tunnel listener without a
// device cookie (expired, revoked, or never enrolled). Self-contained like
// the loopback hint page: asset routes require device auth too.
const REMOTE_UNAUTHENTICATED_PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Exxperts</title>
<style>
body { font-family: system-ui, sans-serif; background: #111; color: #eee; display: flex; min-height: 100vh; align-items: center; justify-content: center; margin: 0; }
main { max-width: 34rem; padding: 2rem; }
h1 { font-size: 1.3rem; }
p { line-height: 1.5; }
</style>
</head>
<body>
<main>
<h1>This device is not paired with Exxperts</h1>
<p>On the computer running Exxperts, generate a pairing code and scan it with this device. Pairing needs an approval on the computer; after that this device stays signed in.</p>
<p>If this phone was already paired, open exactly the address shown in the app's Remote access settings. Pairing is tied to that exact address, so another spelling of the same machine will not be recognized.</p>
<p>A device is also signed out when it is removed in those settings or has gone unused for a month. Pairing again once after that is normal.</p>
</main>
</body>
</html>
`;

// Live route inventory, for the remote-route-policy coverage check: every
// registered route must carry an explicit remote classification, and the
// classification smoke fails when one does not, so a new route can never
// silently become remotely reachable.
const registeredRouteInventory: Array<{ method: string; url: string }> = [];

app.addHook("onRoute", (route) => {
	for (const method of ([] as string[]).concat(route.method)) {
		if (method === "HEAD" || method === "OPTIONS") continue;
		registeredRouteInventory.push({ method, url: route.url });
	}
});

// A shared-server entry's edge (server-hooks.ts; none on the desktop) decides instead of every check in the onRequest hook below.
const edgeRequest = serverHooks().edgeRequest;

// This server is local-only by design. Binding to 127.0.0.1 (see listen())
// keeps other machines out; this guard additionally rejects any request whose
// remote address, Host, or Origin is not loopback, so a browser page on a
// foreign origin cannot drive the API/WS via DNS rebinding (such requests
// arrive with the attacker's hostname in Host/Origin).
app.addHook("onRequest", async (req, reply) => {
	if (edgeRequest) return edgeRequest(req, reply, { tokenMatches: timingSafeTokenMatch });
	// A reverse proxy in front of this server would make every request arrive
	// from loopback, silently defeating the checks below while exposing an
	// unauthenticated API to whatever network the proxy listens on. Proxied
	// requests are recognizable by the headers proxies attach, so refuse them
	// outright with an error that names the unsupported deployment.
	const proxyHeader = findProxyHeader(req.headers);
	if (proxyHeader) {
		return reply.code(403).send({
			error: `Request carries the proxy header "${proxyHeader}". Reverse proxies are not supported: Exxperts is a local, single-user app and must be reached directly at its loopback address. See SECURITY.md in the repository.`,
			code: "reverse_proxy_unsupported",
		});
	}
	// Requests accepted by the remote-mode tunnel listener take their own
	// branch: everything the loopback guard demands, minus loopback shape,
	// plus device identity. The socket tag is the
	// authority; the checks inside are belt-and-suspenders on top of it.
	// With remote OFF no socket is ever tagged, so this branch is dead code
	// and the loopback path below is byte-identical to today.
	if (remoteMode.isRemoteSocket((req.raw as any)?.socket)) {
		// A real tunnel delivers the peer's own tailnet address; anything
		// else has no business on this listener.
		if (!requestRemoteAddresses(req).some(isAllowedTunnelPeerAddress)) {
			return reply.code(403).send({ error: "This listener only accepts requests from devices on the private tunnel.", code: "remote_request_required" });
		}
		// Exact-self Host and Origin (the machine's own tunnel identity),
		// never a range: DNS rebinding stays dead on this listener too.
		if (!remoteMode.isOwnTunnelHost(String(req.headers.host ?? ""))) {
			return reply.code(403).send({ error: "This listener only accepts requests addressed to the machine's own tunnel address.", code: "remote_request_required" });
		}
		const tunnelOrigin = String(req.headers.origin ?? "").trim();
		if (tunnelOrigin && !remoteMode.isOwnTunnelOrigin(tunnelOrigin)) {
			return reply.code(403).send({ error: "This listener only accepts requests addressed to the machine's own tunnel address.", code: "remote_request_required" });
		}
		// Canonical-address redirect, AFTER every refusal above and BEFORE any
		// auth or dispatch: under https the exact-self Host check accepts two
		// spellings of this machine (the certificate's DNS name and the raw
		// tunnel address), but the device cookie is scoped to the DNS name
		// only, so a validly paired phone arriving on the raw-address form
		// (old bookmark, hand-typed IP) sends no cookie and would be told it
		// is not paired. Send it to the one true address instead, keeping
		// path and query. Only requests that already passed the exact-self
		// checks reach this point, so a foreign Host still gets the 403 above,
		// never a redirect; a request already carrying the canonical Host
		// falls through, so no loop; on plain http there is no canonical name
		// and this is inert; and the loopback listener never enters this
		// branch at all.
		const canonicalTunnelHost = remoteMode.canonicalTunnelHost();
		if (canonicalTunnelHost && String(req.headers.host ?? "").trim().toLowerCase() !== canonicalTunnelHost) {
			return reply.redirect(`https://${canonicalTunnelHost}${String(req.raw.url ?? "/")}`, 302);
		}
		const tunnelPathname = String(req.raw.url ?? "").split("?")[0];
		// The readiness probe leaks nothing to enrolled devices: liveness only.
		if (tunnelPathname === "/healthz") {
			return reply.send({ ok: true });
		}
		// The master-token exchange does not exist on this listener; the
		// master token never travels to a phone in any form.
		if (tunnelPathname === "/auth/session") {
			return reply.code(404).send({ error: "not found" });
		}
		// The enrollment surface is the tunnel's only pre-auth surface (the
		// loopback /auth/session analog). The route handlers validate codes,
		// rate-limit, and log; nothing else on the tunnel is reachable
		// without a device key.
		if (tunnelPathname === "/remote/enroll" || tunnelPathname === "/remote/enroll.js" || tunnelPathname === "/remote/enroll/exchange" || tunnelPathname === "/remote/enroll/status") {
			return;
		}
		// Device-key auth. Deliberately never consults the master token: it
		// is not a credential on this listener, so its presence or
		// correctness must not be observable in any refusal.
		const device = remoteDevices.authenticate(cookieValue(req.headers.cookie, REMOTE_DEVICE_COOKIE_NAME));
		if (!device) {
			// Auth failures on the tunnel are logged and audited (redacted: no
			// key material, query strings stripped) and rate limited; today's
			// loopback listener has neither, and the tunnel is where they
			// become mandatory.
			app.log.warn({ listener: "tunnel", path: tunnelPathname, method: req.method }, "remote device auth failed");
			remoteAudit("device_auth_failed", { method: req.method, path: tunnelPathname.slice(0, 200) });
			if (!remoteAuthFailureLimiter()) {
				remoteAudit("rate_limited", { path: tunnelPathname.slice(0, 200) });
				return reply.code(429).send({ error: "Too many failed attempts. Wait a minute and try again.", code: "remote_rate_limited" });
			}
			if (req.method === "GET" && (tunnelPathname === "/" || String(req.headers.accept ?? "").includes("text/html"))) {
				return reply.code(401).headers(staticSecurityHeadersFor(req)).type("text/html; charset=utf-8").send(REMOTE_UNAUTHENTICATED_PAGE);
			}
			return reply.code(401).send({ error: "This device is not paired with Exxperts. Generate a pairing code on the computer and scan it with this device.", code: "remote_device_auth_required" });
		}
		// Authenticated device: bind the socket for per-device revocation,
		// refresh last-seen, attach the record for capability checks, and let
		// the request proceed to the shared routes. The route capability check
		// and the hidden-room filters read this attachment.
		remoteMode.registerDeviceSocket((req.raw as any)?.socket, device.id);
		remoteDevices.touchLastSeen(device.id);
		(req as any).exxRemoteDevice = device;
		return;
	}
	if (!requestRemoteAddresses(req).some(isLoopbackAddress)) {
		return reply.code(403).send({ error: "This server only accepts local requests from the Exxperts app.", code: "local_request_required" });
	}
	if (!isLoopbackHostHeader(String(req.headers.host ?? ""))) {
		return reply.code(403).send({ error: "This server only accepts local requests from the Exxperts app.", code: "local_request_required" });
	}
	const origin = String(req.headers.origin ?? "").trim();
	if (origin && !isLoopbackOrLocalhostOrigin(origin)) {
		return reply.code(403).send({ error: "This server only accepts local requests from the Exxperts app.", code: "local_request_required" });
	}
	// Client auth, after the network-shape checks above: every route except the
	// launcher's readiness probe and the token exchange itself requires the
	// minted token, either as the session cookie set by /auth/session or as the
	// X-Exxperts-Auth header (CLI/programmatic callers). The WS upgrade request
	// runs through this same hook, so an unauthenticated upgrade is refused
	// before any handshake.
	const pathname = String(req.raw.url ?? "").split("?")[0];
	if (pathname === "/healthz" || pathname === "/auth/session") return;
	const headerAuthenticated = timingSafeTokenMatch(String(req.headers[AUTH_HEADER_NAME] ?? ""));
	// Header auth takes precedence: a request that proves possession of the
	// token itself is never classified as cookie-backed, so it is exempt from
	// the WS origin pinning below even if a cookie also rides along. Do not
	// "simplify" this into two independent checks.
	const cookieAuthenticated = headerAuthenticated ? false : timingSafeTokenMatch(cookieValue(req.headers.cookie, AUTH_COOKIE_NAME));
	if (!headerAuthenticated && !cookieAuthenticated) {
		if (req.method === "GET" && (pathname === "/" || String(req.headers.accept ?? "").includes("text/html"))) {
			// A browser navigation without the cookie gets a plain page saying how
			// to open the app, instead of a JSON error nobody can act on.
			return reply.code(401).headers(STATIC_SECURITY_HEADERS).type("text/html; charset=utf-8").send(UNAUTHENTICATED_PAGE);
		}
		return reply.code(401).send({ error: `This request is not authenticated. Open the app with the exxperts command, or send the token from ${AUTH_TOKEN_FILE} in the X-Exxperts-Auth header.`, code: "auth_required" });
	}
	// The cookie rides along automatically on anything same-site, and browsers
	// treat every localhost port as same-site, so a page served by any OTHER
	// local program could open an authenticated WebSocket with it (WS has no
	// CORS). Cookie-backed upgrades are therefore pinned to the app's own
	// origins; header callers prove possession of the token itself.
	if (cookieAuthenticated && String(req.headers.upgrade ?? "").toLowerCase() === "websocket" && !isAppOrigin(origin)) {
		return reply.code(403).send({ error: "WebSocket connections using the browser session must come from the Exxperts app page itself.", code: "ws_origin_required" });
	}
});

// A shared-server entry's request guard (server-hooks.ts; none on the desktop):
// after the checks above, before any handler, the /ws upgrade included.
// Nothing with side effects may run before it (a preParsing or preValidation hook, a writing body parser).
const guardRequest = serverHooks().guardRequest;

if (guardRequest) app.addHook("preHandler", async (req, reply) => guardRequest(req, reply));

// A stopping server (server-stop.ts): /healthz answers 503, and requests that start work are refused with the code.
// Callback style, so a server that is not stopping adds no await to any request
// (one more async hook here empties the body of reply.callNotFound()'s 404).
app.addHook("preHandler", (req, reply, done) => {
	if (!serverStopping()) return done();
	if (req.routeOptions.url === "/healthz") return void reply.code(503).send({ ok: false, code: SERVER_STOPPING_CODE });
	if (stopRefuses(req.method, req.routeOptions.url)) return void refuseWhileStopping(reply);
	done();
});

app.get("/healthz", async () => ({ ok: true, persona: process.env.EXXETA_PERSONA ?? "business" }));

// Browser handoff: the launcher opens /auth/session?token=<token>; a matching
// token becomes an HttpOnly session cookie and the browser is redirected to
// "/", so the token never stays in the address bar or history. Deliberately
// not Secure: the app is plain http on loopback by design (SECURITY.md).
app.get("/auth/session", async (req, reply) => {
	const token = String((req.query as Record<string, unknown> | undefined)?.token ?? "");
	if (!timingSafeTokenMatch(token)) {
		return reply.code(403).send({ error: "Invalid auth token. Start the app with the exxperts command and use the link it opens.", code: "auth_invalid" });
	}
	reply.header("set-cookie", `${AUTH_COOKIE_NAME}=${AUTH_TOKEN}; HttpOnly; SameSite=Strict; Path=/; Max-Age=31536000`);
	return reply.redirect("/", 302);
});

// Remote mode (SECURITY.md's "explicit opt-in may come later", now explicit):
// an OFF-by-default tunnel listener on the machine's own tailnet address.
// This unit is state + lifecycle only; the tunnel listener serves, but the
// request guard above still holds every request to loopback shape, so until
// the guard learns tailnet identities (separate change), remote requests are
// refused. OFF stays byte-identical: with no state file nothing below runs.
const remoteMode = createRemoteModeManager({ port: PORT, appServer: app.server, log: app.log });

const remoteDevices = createRemoteDeviceStore(app.log);

const remoteRoomExposure = createRemoteRoomExposureStore(app.log);

const remoteAudit = createRemoteAuditLog(app.log);

// The phone's credential is its own device key, never the master token. The
// cookie name is distinct from the loopback session cookie so the two
// credential classes cannot be confused by any code path.
const REMOTE_DEVICE_COOKIE_NAME = "exxperts_remote_device";

// The Max-Age is a hint for the browser; the device record's server-side
// expiry (same 30 days, sliding on use) is what actually authorizes.
const REMOTE_DEVICE_COOKIE_MAX_AGE_S = Math.floor(REMOTE_DEVICE_TTL_MS / 1000);

// Fixed-window rate limiting for the tunnel listener's unauthenticated
// surface. Single-user product, so global windows (not per-IP) are the
// honest model: the budget is "how fast can anything hammer this machine".
function makeFixedWindowLimiter(limitPerMinute: number): () => boolean {
	let windowStart = 0;
	let count = 0;
	return () => {
		const now = Date.now();
		if (now - windowStart > 60_000) {
			windowStart = now;
			count = 0;
		}
		count += 1;
		return count <= limitPerMinute;
	};
}

const enrollBeginLimiter = makeFixedWindowLimiter(10);

const enrollStatusLimiter = makeFixedWindowLimiter(120);

const remoteAuthFailureLimiter = makeFixedWindowLimiter(30);

// Admin surface for the CLI and the Settings mirror. Loopback-only by
// intent: a request arriving over the tunnel must never be able to flip
// remote state (a phone cannot disable, re-enable, or reconfigure its own
// access path). The socket tag is the authority.
function refuseRemoteAdminFromTunnel(req: any, reply: any): boolean {
	if (remoteMode.isRemoteSocket(req.raw?.socket)) {
		reply.code(403).send({ error: "Remote-mode settings can only be changed on the computer itself.", code: "remote_admin_local_only" });
		return true;
	}
	return false;
}

function isPromptDiagnosticsEnabled(): boolean {
	return process.env.EXXETA_PROMPT_DIAGNOSTICS === "1";
}

function requestRemoteAddresses(req: any): string[] {
	return [req.ip, req.socket?.remoteAddress, req.raw?.socket?.remoteAddress]
		.map((value) => String(value ?? "").trim())
		.filter(Boolean);
}

// Headers that only appear when a proxy relayed the request: the RFC 7239
// Forwarded header, the de-facto X-Forwarded-* family (For/Host/Proto/Port/
// Prefix and friends), nginx's X-Real-IP, and the RFC 9110 Via header that
// intermediaries are required to append. A browser talking straight to
// 127.0.0.1 sends none of these. Node lowercases incoming header names.
function findProxyHeader(headers: Record<string, unknown>): string | undefined {
	for (const name of Object.keys(headers)) {
		if (name === "forwarded" || name === "via" || name === "x-real-ip" || name.startsWith("x-forwarded-")) return name;
	}
	return undefined;
}

function isLoopbackAddress(address: string): boolean {
	return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}

// ANY localhost port passes here (network-shape check for the DNS-rebinding
// guard); contrast isAppOrigin, which pins to the app's own exact origins.
function isLoopbackOrLocalhostOrigin(origin: string): boolean {
	try {
		const parsed = new URL(origin);
		const hostname = parsed.hostname.toLowerCase();
		return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1" || hostname === "[::1]";
	} catch {
		return false;
	}
}

function isLoopbackHostHeader(hostHeader: string): boolean {
	const value = hostHeader.trim();
	if (!value) return false;
	try {
		return isLoopbackOrLocalhostOrigin(`http://${value}`);
	} catch {
		return false;
	}
}

function isLocalSystemChooseFolderRequest(req: any): boolean {
	const actionHeader = String(req.headers?.["x-exxperts-local-action"] ?? "").trim();
	if (actionHeader !== "choose-folder") return false;
	if (!requestRemoteAddresses(req).some(isLoopbackAddress)) return false;
	const origin = req.headers?.origin;
	if (typeof origin === "string" && origin.trim() && !isLoopbackOrLocalhostOrigin(origin.trim())) return false;
	return true;
}

function isLocalPromptDiagnosticsRequest(req: any): boolean {
	return requestRemoteAddresses(req).some(isLoopbackAddress);
}

// Baseline security headers for everything the static path serves. A script
// running on the app origin carries the auth cookie on every request, so the
// app origin must never execute anything beyond the built bundle: no external scripts,
// no framing, no plugin content. style-src keeps 'unsafe-inline' (mermaid
// injects style attributes into its rendered SVG); connect-src names loopback
// websockets explicitly because CSP 'self' does not reliably match ws:;
// frame-src 'self' is reserved for the sandboxed artifact viewer, which
// frames a same-origin route.
const STATIC_SECURITY_HEADERS: Record<string, string> = {
	"content-security-policy": [
		"default-src 'self'",
		"script-src 'self'",
		"style-src 'self' 'unsafe-inline'",
		"img-src 'self' data: blob:",
		"font-src 'self'",
		"connect-src 'self' ws://127.0.0.1:* ws://localhost:*",
		"frame-src 'self'",
		"object-src 'none'",
		"base-uri 'self'",
		"frame-ancestors 'none'",
		"form-action 'self'",
	].join("; "),
	"x-content-type-options": "nosniff",
	"referrer-policy": "no-referrer",
};

// A shared-server entry's page headers (server-hooks.ts); on the desktop the very object above.
const PAGE_SECURITY_HEADERS = serverHooks().pageSecurityHeaders?.(STATIC_SECURITY_HEADERS) ?? STATIC_SECURITY_HEADERS;

// Static security headers per listener. Loopback requests (and remote OFF,
// where no socket is ever tunnel-tagged) get the exact object above,
// byte-identical to today. Pages served over the tunnel need the tunnel's
// own ws:// origin in connect-src, or the app's WebSocket is silently
// CSP-blocked ('self' does not reliably match ws:, see the comment above).
let tunnelSecurityHeadersCache: { identity: string; headers: Record<string, string> } | null = null;

function staticSecurityHeadersFor(req: { raw?: { socket?: unknown } }): Record<string, string> {
	if (!remoteMode.isRemoteSocket(req.raw?.socket)) return PAGE_SECURITY_HEADERS;
	const status = remoteMode.status();
	if (!status.address) return STATIC_SECURITY_HEADERS;
	// Under https the page's own origin is the MagicDNS name and its
	// WebSocket is wss; under http it is the tunnel address and ws. Either
	// way exactly one WebSocket origin is added: the listener's own.
	const host = status.scheme === "https" && status.dnsName ? status.dnsName : status.address.includes(":") ? `[${status.address}]` : status.address;
	const wsOrigin = `${status.scheme === "https" ? "wss" : "ws"}://${host}:${PORT}`;
	if (!tunnelSecurityHeadersCache || tunnelSecurityHeadersCache.identity !== wsOrigin) {
		tunnelSecurityHeadersCache = {
			identity: wsOrigin,
			headers: {
				...STATIC_SECURITY_HEADERS,
				"content-security-policy": STATIC_SECURITY_HEADERS["content-security-policy"].replace(
					"connect-src 'self' ",
					`connect-src 'self' ${wsOrigin} `,
				),
			},
		};
	}
	return tunnelSecurityHeadersCache.headers;
}

// Artifact bytes are model-generated and potentially hostile, and a same-origin
// document carries the auth cookie on its requests, so such a document would
// own the whole instance. Every artifact response therefore carries a CSP
// sandbox header, which hands even a directly-navigated top-level document an
// opaque origin: no cookies/localStorage, and same-origin fetch to the API
// fails. This header is load-bearing, not hygiene. Distinct from the static
// bundle's STATIC_SECURITY_HEADERS — different policy, different purpose.
// No allow-scripts / script-src: every v1 template's output is static by
// construction (deck = deterministic renderer, others = no-script templates in
// a sandbox="" viewer), so nothing legitimate needs to execute even in a
// directly-opened tab. Opaque origin + default-src 'none' stays the real
// containment; this just removes an execution capability nothing uses.
// (A future scripted template must widen this deliberately, per-decision,
// not inherit it.)
const ARTIFACT_SECURITY_HEADERS: Record<string, string> = {
	"content-security-policy": "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data:",
	"x-content-type-options": "nosniff",
	"referrer-policy": "no-referrer",
	"cache-control": "no-store",
};

export { ARTIFACT_SECURITY_HEADERS, REMOTE_DEVICE_COOKIE_MAX_AGE_S, REMOTE_DEVICE_COOKIE_NAME, enrollBeginLimiter, enrollStatusLimiter, isLocalPromptDiagnosticsRequest, isLocalSystemChooseFolderRequest, isLoopbackAddress, isLoopbackOrLocalhostOrigin, isPromptDiagnosticsEnabled, refuseRemoteAdminFromTunnel, registeredRouteInventory, remoteAudit, remoteDevices, remoteMode, remoteRoomExposure, requestRemoteAddresses, staticSecurityHeadersFor };
