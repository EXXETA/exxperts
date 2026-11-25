import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import Fastify, { LogController, type FastifyRequest } from "fastify";
import websocket from "@fastify/websocket";
import { applyShellLookupTestSwitch } from "./persistent-room-shell-missing.js";
import { productAppStatePath, ensureProductAppStateRoot } from "../../../pi-package/product-state-paths.js";
import { serverHooks } from "./server-hooks.js";
import { REPO_ROOT } from "./server-install-root.js";

applyShellLookupTestSwitch();

// A shared-server entry may serve another page build (server-hooks.ts).
const WEB_UI_DIST = serverHooks().webUiDist?.(REPO_ROOT) ?? path.join(REPO_ROOT, "apps", "web-ui", "dist");

// Default persona for new web connections is `business`. Each WS
// connection can override via `?persona=` (see /ws handler). We don't
// pin it process-wide here — that's done per-connection right before
// the loader is created so each session's permission gate / system
// prompt picks up the right value.
if (!process.env.EXXETA_PERSONA) process.env.EXXETA_PERSONA = "business";

const PORT = Number(process.env.PORT ?? 8787);

// Client auth token (SECURITY.md "Client auth token"). Minted once per install
// under the app state root; rotation = delete the file and restart. Test
// callers may pin the token via EXXPERTS_AUTH_TOKEN instead of minting a
// random one; the enforcement itself is identical and never disabled.
const AUTH_COOKIE_NAME = "exxperts_auth";

const AUTH_HEADER_NAME = "x-exxperts-auth";

const AUTH_TOKEN_FILE = productAppStatePath("auth-token");

const AUTH_TOKEN = resolveAuthToken();

function resolveAuthToken(): string {
	// A shared-server entry's token (server-hooks.ts; none on the desktop): no variable, no file, nothing minted.
	const authToken = serverHooks().authToken;
	if (authToken) return authToken();
	const fromEnv = String(process.env.EXXPERTS_AUTH_TOKEN ?? "").trim();
	if (fromEnv) return fromEnv;
	try {
		const existing = fs.readFileSync(AUTH_TOKEN_FILE, "utf8").trim();
		if (existing) return existing;
	} catch {
		// No token file yet: first run, mint below.
	}
	const minted = crypto.randomBytes(32).toString("hex");
	try {
		ensureProductAppStateRoot();
		// 0600 like other server-side secrets. The mode is a POSIX concept and a
		// no-op on win32, matching how the rest of the state root is created.
		fs.writeFileSync(AUTH_TOKEN_FILE, `${minted}\n`, { mode: 0o600 });
	} catch (error) {
		// Fail closed with an actionable message: booting without a persisted
		// token would strand every future launch behind an unknown secret.
		console.error(`Cannot write the auth token at ${AUTH_TOKEN_FILE}: ${(error as Error).message}. Fix permissions on the .exxperts directory in your home folder and start Exxperts again.`);
		process.exit(1);
	}
	return minted;
}

// Request logs are pino JSON — useful when developing, noise in a user's
// terminal. The launcher runs with NODE_ENV=production, so default to
// warnings there; LOG_LEVEL overrides in either direction.
const LOG_LEVEL = process.env.LOG_LEVEL ?? (process.env.NODE_ENV === "production" ? "warn" : "info");

// The request log never shows a value that opens access from the address: the
// sign-in token, a phone's pairing code, and the pairing request's id, whose
// first poll after the approval collects the new device's key
// (remote-routes.ts). The query parser reads a parameter by its decoded name
// ("%74oken" is "token" too), starting after the first "?" or "#" and
// splitting on "&". So after every "?", "#" or "&", a name that decodes to one
// of these has its value, up to the next "&", logged as [redacted]: every
// spelling the parser reads as that name, a repeated one included. Every other
// parameter is logged as sent.
const REDACTED_QUERY_NAMES: ReadonlySet<string> = new Set(["token", "code", "requestId"]);

function redactAddressSecrets(url: string): string {
	let redacted = "";
	let from = 0;
	for (const match of url.matchAll(/[?#&]([^=&?#]*)=/g)) {
		if (match.index < from || !REDACTED_QUERY_NAMES.has(queryNameAsParsed(match[1]))) continue;
		const valueStart = match.index + match[0].length;
		const valueEnd = url.indexOf("&", valueStart);
		redacted += `${url.slice(from, valueStart)}[redacted]`;
		from = valueEnd === -1 ? url.length : valueEnd;
	}
	return redacted + url.slice(from);
}

// A query name as the parser reads it: "+" is a space, then percent-decoded.
function queryNameAsParsed(name: string): string {
	const spaced = name.replace(/\+/g, " ");
	try {
		return decodeURIComponent(spaced);
	} catch {
		return spaced;
	}
}

// Fastify's own line for an unknown route prints the raw address, outside the
// request serializer below, so it redacts the same values the same way.
class SecretRedactingLogController extends LogController {
	routeNotFound(request: FastifyRequest): void {
		if (this.isLogDisabled(request)) return;
		request.log.info(`Route ${request.raw.method}:${redactAddressSecrets(String(request.raw.url ?? ""))} not found`);
	}
}

// The request serializer mirrors Fastify's default fields but redacts those
// query values, so neither the /auth/session exchange nor a phone's pairing
// lands a usable value in dev logs (production logs at warn and skips request
// lines anyway).
const app = Fastify({
	// Room ids reach 120 characters; the default of 100 answered 414 for them.
	maxParamLength: 256,
	// A request reaching a closing server goes through the stop's door (server-stop.ts), never the framework's bare 503.
	return503OnClosing: false,
	logController: new SecretRedactingLogController(),
	// A shared-server entry may give the logger options of its own (server-hooks.ts).
	logger: (serverHooks().loggerOptions ?? ((base) => base))({
		level: LOG_LEVEL,
		serializers: {
			req(request: any) {
				return {
					method: request.method,
					url: redactAddressSecrets(String(request.url ?? "")),
					host: request.host,
					remoteAddress: request.ip,
					remotePort: request.socket?.remotePort,
				};
			},
			// The websocket plugin logs an upgrade to a route without a socket
			// handler with its raw address under "path", outside req above.
			path: (value: unknown) => (typeof value === "string" ? redactAddressSecrets(value) : value),
		},
	}),
});

await app.register(websocket);

export { AUTH_COOKIE_NAME, AUTH_HEADER_NAME, AUTH_TOKEN, AUTH_TOKEN_FILE, PORT, WEB_UI_DIST, app };
