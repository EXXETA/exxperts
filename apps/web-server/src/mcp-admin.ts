/**
 * MCP connector management for the web UI: add/remove servers, OAuth
 * login/logout, and one-off connection tests.
 *
 * Config writes go through the same files the adapter reads. Running room
 * sessions load MCP config at session start, so changes apply the next time
 * a room session is (re)entered — callers surface that in the UI.
 */

import fs from "node:fs";
import path from "node:path";
import { stateHome } from "../../../pi-package/product-state-paths.js";
import { installConnectorStartCheck, startRefusalOf, type ConnectorStartRefusal } from "./connector-start-check.js";
import { CONNECTOR_FORM_LINES, CONNECTOR_REQUEST_LINES, MAX_CONNECTOR_NAME_LENGTH, connectorDisplayName, connectorFixedName, connectorShownName, importAppName, isPassingStatus, readConnectorAddress, sameConnectorSite } from "./connector-form.js";
import { connectorKeyOf, isCredentialHeaderName, mcpServersKeyOf, movesToAnotherSite, writeMcpConnectorCheck } from "./mcp-status.js";
import { forgetMcpConnectorToolsInAllRooms } from "./persistent-room-mcp-settings.js";
import { isSharedServer, serverHooks } from "./server-hooks.js";

// Non-literal specifiers so tsc never resolves into the adapter's raw .ts
// sources (same pattern as mcp-status.ts).
const ADAPTER_CONFIG = "pi-mcp-adapter/config.ts" as string;
const ADAPTER_AUTH_FLOW = "pi-mcp-adapter/mcp-auth-flow.ts" as string;
const ADAPTER_AUTH_STORE = "pi-mcp-adapter/mcp-auth.ts" as string;
const ADAPTER_CALLBACK = "pi-mcp-adapter/mcp-callback-server.ts" as string;
const ADAPTER_SERVER_MANAGER = "pi-mcp-adapter/server-manager.ts" as string;
const ADAPTER_CACHE = "pi-mcp-adapter/metadata-cache.ts" as string;

export class McpAdminError extends Error {
	constructor(
		message: string,
		readonly statusCode: number = 400,
	) {
		super(message);
	}
}

function ensureAgentDirEnv(): void {
	if (!process.env.PI_CODING_AGENT_DIR) {
		process.env.PI_CODING_AGENT_DIR = path.join(stateHome(), ".exxperts", "agent");
	}
}

export interface AddMcpServerOAuthInput {
	clientId?: string;
	clientSecret?: string;
	scope?: string;
}

export interface AddMcpServerInput {
	/** The name a person typed; the fixed name is made from it. */
	name: string;
	url?: string;
	command?: string;
	args?: string[];
	bearerToken?: string;
	oauth?: AddMcpServerOAuthInput;
	/** Extra headers sent with every request, such as a key a server expects in its own header. */
	headers?: Record<string, string>;
}

interface ServerEntryShape {
	/** The name as typed, kept only when it differs from the fixed name. */
	displayName?: string;
	url?: string;
	command?: string;
	args?: string[];
	auth?: "bearer" | "oauth" | false;
	bearerToken?: string;
	headers?: Record<string, string>;
	oauth?: { clientId: string; clientSecret?: string; scope?: string };
}

// Headers the connection itself sets, or that would let a value reshape the
// request; a custom header may not replace them.
const RESERVED_HEADERS = new Set(["host", "content-length", "content-type", "accept", "connection", "transfer-encoding", "upgrade", "te", "trailer", "keep-alive", "proxy-authorization", "proxy-connection", "cookie", "mcp-session-id", "mcp-protocol-version", "last-event-id"]);
const HEADER_NAME_PATTERN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,100}$/;
const MAX_HEADERS = 20;
const MAX_HEADER_VALUE_LENGTH = 4096;

/**
 * Custom headers for a remote connector, checked before they reach the
 * config file: valid names, no line break or other control character in a
 * value (it could add a header of its own), none of the headers the
 * connection sets, no name twice, and no Authorization next to the API token
 * or an OAuth client, which set it themselves.
 */
function validateHeaders(raw: unknown, authorizationSet: boolean): Record<string, string> | undefined {
	if (raw === undefined || raw === null) return undefined;
	if (typeof raw !== "object" || Array.isArray(raw)) throw new McpAdminError("Custom headers must be a list of names and values.");
	const entries = Object.entries(raw as Record<string, unknown>);
	if (entries.length === 0) return undefined;
	if (entries.length > MAX_HEADERS) throw new McpAdminError(CONNECTOR_FORM_LINES.tooManyHeaders(MAX_HEADERS));
	const headers: Record<string, string> = {};
	const seen = new Set<string>();
	for (const [rawName, rawValue] of entries) {
		const name = rawName.trim();
		if (!name) throw new McpAdminError(CONNECTOR_FORM_LINES.headerUnnamed);
		if (!HEADER_NAME_PATTERN.test(name)) throw new McpAdminError(`"${name.slice(0, 40)}" is not a valid header name: use letters, digits and dashes.`);
		if (typeof rawValue !== "string") throw new McpAdminError(`The ${name} header's value must be text.`);
		const value = rawValue.trim();
		const lower = name.toLowerCase();
		if (RESERVED_HEADERS.has(lower)) throw new McpAdminError(`The ${name} header is set by the connection itself and cannot be changed.`);
		if (lower === "authorization" && authorizationSet) throw new McpAdminError(CONNECTOR_FORM_LINES.keyAndAuthorizationHeader);
		if (seen.has(lower)) throw new McpAdminError(`The ${name} header is listed twice.`);
		if (!value) throw new McpAdminError(`The ${name} header needs a value.`);
		if (value.length > MAX_HEADER_VALUE_LENGTH) throw new McpAdminError(`The ${name} header's value is too long.`);
		if (/\p{Cc}/u.test(value)) throw new McpAdminError(CONNECTOR_FORM_LINES.headerHiddenCharacter(name));
		// A header carries only Latin-1; a dash or quote pasted from a document
		// would otherwise pass here and fail only when the connector connects.
		if (/[^\u0000-\u00ff]/u.test(value)) throw new McpAdminError(`The ${name} header's value contains a character a header cannot carry, such as a typographic dash or quote. Type it again by hand.`);
		seen.add(lower);
		headers[name] = value;
	}
	return headers;
}

function validateAddInput(input: AddMcpServerInput): { name: string; entry: ServerEntryShape } {
	const name = connectorDisplayName(String(input.name ?? ""));
	if (!name) throw new McpAdminError(CONNECTOR_FORM_LINES.nameMissing);
	if (name.length > MAX_CONNECTOR_NAME_LENGTH) throw new McpAdminError(CONNECTOR_FORM_LINES.nameTooLong);
	const typedUrl = String(input.url ?? "").trim();
	const command = String(input.command ?? "").trim();
	if (typedUrl && command) throw new McpAdminError("Provide either a URL or a command, not both.");
	if (typedUrl) {
		const address = readConnectorAddress(typedUrl);
		if ("error" in address) throw new McpAdminError(address.error);
		const url = address.url;
		const bearerToken = String(input.bearerToken ?? "").trim();
		const clientId = String(input.oauth?.clientId ?? "").trim();
		const clientSecret = String(input.oauth?.clientSecret ?? "").trim();
		const scope = String(input.oauth?.scope ?? "").trim();
		if ((clientSecret || scope) && !clientId) throw new McpAdminError(CONNECTOR_FORM_LINES.clientIdMissing);
		if (bearerToken && clientId) throw new McpAdminError(CONNECTOR_FORM_LINES.keyAndSignInApp);
		const headers = validateHeaders(input.headers, Boolean(bearerToken || clientId));
		const withHeaders = headers ? { headers } : {};
		if (bearerToken) return { name, entry: { url, auth: "bearer", bearerToken, ...withHeaders } };
		if (clientId) {
			// Pre-registered client: the adapter's OAuth provider uses it directly
			// and skips dynamic client registration, which providers like HubSpot
			// do not support.
			return {
				name,
				entry: { url, auth: "oauth", oauth: { clientId, ...(clientSecret ? { clientSecret } : {}), ...(scope ? { scope } : {}) }, ...withHeaders },
			};
		}
		// A key in its own header is the sign-in: OAuth auto-detect is switched
		// off, as for one written into the file by hand, or the adapter would
		// ask for a login the server does not offer. Other headers (a tenant, a
		// version) leave auto-detect on.
		if (headers && Object.keys(headers).some(isCredentialHeaderName)) return { name, entry: { url, auth: false, headers } };
		return { name, entry: { url, ...withHeaders } };
	}
	if (input.bearerToken) throw new McpAdminError("API tokens only apply to remote (URL) connectors.");
	if (input.headers && Object.keys(input.headers).length > 0) throw new McpAdminError("Custom headers only apply to remote (URL) connectors.");
	if (input.oauth?.clientId) throw new McpAdminError("Custom OAuth clients only apply to remote (URL) connectors.");
	if (command) {
		const args = Array.isArray(input.args) ? input.args.map((a) => String(a)).filter((a) => a.trim() !== "") : [];
		return { name, entry: args.length > 0 ? { command, args } : { command } };
	}
	throw new McpAdminError("Provide a server URL (remote) or a command (local).");
}

/**
 * Add a connector. The person's name may hold any text; the fixed name made
 * from it is the connector's key everywhere (room access, the saved sign-in,
 * the tool names), and the typed name is kept beside it only where the two
 * differ, so an entry named as before reads exactly as before.
 */
export async function addMcpServer(input: AddMcpServerInput): Promise<{ name: string; path: string }> {
	ensureAgentDirEnv();
	const configMod = await import(ADAPTER_CONFIG);
	const { name: displayName, entry } = validateAddInput(input);
	const refusal = serverHooks().connectorEntryRefusal?.(entry);
	if (refusal) throw new McpAdminError(refusal);
	const servers: Record<string, { displayName?: unknown }> = configMod.loadMcpConfig().mcpServers ?? {};
	const name = connectorFixedName(displayName, new Set(Object.keys(servers)));
	// Unique as people see them: the new one's shown name may be the directory's, not the typed one.
	// The line names the connector the person already has, as they see it.
	const shown = connectorShownName(name, displayName).toLowerCase();
	const holder = Object.entries(servers)
		.map(([existing, existingEntry]) => connectorShownName(existing, typeof existingEntry?.displayName === "string" ? existingEntry.displayName : undefined))
		.find((existingShown) => existingShown.toLowerCase() === shown);
	if (holder !== undefined) throw new McpAdminError(CONNECTOR_FORM_LINES.nameTaken(holder), 409);
	const target: string = configMod.getPiGlobalConfigPath();
	configMod.writeSharedServerEntry(target, name, name === displayName ? entry : { displayName, ...entry });
	return { name, path: target };
}

function removeEntryFromFile(filePath: string, name: string): boolean {
	let parsed: Record<string, unknown>;
	try {
		parsed = JSON.parse(fs.readFileSync(filePath, "utf-8"));
	} catch {
		return false;
	}
	const key = mcpServersKeyOf(parsed);
	if (!key) return false;
	const servers = parsed[key] as Record<string, unknown>;
	if (!(name in servers)) return false;
	delete servers[name];
	// Atomic write, matching the adapter's own config writes.
	const tmp = `${filePath}.tmp`;
	fs.writeFileSync(tmp, `${JSON.stringify(parsed, null, 2)}\n`);
	fs.renameSync(tmp, filePath);
	return true;
}

export async function removeMcpServer(name: string): Promise<{ name: string; removedFrom: string[] }> {
	ensureAgentDirEnv();
	const configMod = await import(ADAPTER_CONFIG);
	const merged = configMod.loadMcpConfig();
	if (!merged.mcpServers?.[name]) {
		throw new McpAdminError(CONNECTOR_REQUEST_LINES.noLongerExists, 404);
	}
	// Delete from every config file that literally defines the name. Provenance
	// can't drive this: entries in the shared global file report the exxperts
	// file as their write path, so deleting there would silently leave the
	// server configured.
	const paths: Array<{ path: string; exists: boolean }> = configMod.getConfigDiscoveryPaths();
	const removedFrom: string[] = [];
	for (const source of paths) {
		if (!source.exists) continue;
		if (removeEntryFromFile(source.path, name)) removedFrom.push(source.path);
	}
	if (removedFrom.length === 0) {
		throw new McpAdminError(CONNECTOR_REQUEST_LINES.notRemovable(importAppName(configMod.getServerProvenance().get(name)?.importKind)), 409);
	}
	// Best-effort: drop any stored OAuth credentials with the entry.
	try {
		const authFlow = await import(ADAPTER_AUTH_FLOW);
		await authFlow.removeAuth(name);
	} catch {
		// credentials cleanup is advisory
	}
	// Drop the cached tool list too: if the server is re-added later under the
	// same name, a surviving cache entry with no stored tokens would make the
	// UI claim "no login needed" until a test disproves it.
	await dropMetadataCacheEntry(name);
	writeMcpConnectorCheck(name, null);
	return { name, removedFrom };
}

// One login may be in flight per server; the UI polls /api/mcp/status for the
// resulting tokens rather than holding the HTTP request open.
/** Why a sign-in failed, so the page offers Try again only where trying again can work. */
export type McpLoginFailure = "needs-own-app" | "refused" | "busy" | "no-sign-in" | "too-slow" | "other";

const pendingLogins = new Map<string, { startedAt: number; cause?: McpLoginFailure; detail?: string; done: boolean }>();

// OAuth is auto-detected for URL servers, so "log in" against a public server
// fails at endpoint discovery with SDK internals (404s, JSON parse noise).
// Translate that into what it actually means.
/**
 * Transport errors can embed the entire HTTP response body (the MCP SDK's
 * "Error POSTing to endpoint: <body>" includes full tool catalogs — observed
 * live with Google's Gmail MCP returning 403 with the complete tools list as
 * the body). Cap what reaches the UI; the point of the message is the first
 * line, not the payload.
 */
function trimTransportError(message: string, max = 280): string {
	const trimmed = message.trim();
	if (trimmed.length <= max) return trimmed;
	return `${trimmed.slice(0, max)}…`;
}

/**
 * The adapter's sign-in error, read once: why it failed and, for Technical
 * details, the service's own words. The page words the line from the cause,
 * as only it knows where the connector was added.
 */
export function loginFailureOf(message: string): { cause: McpLoginFailure; detail: string } {
	return { cause: loginCauseOf(message), detail: trimTransportError(message) };
}

function loginCauseOf(message: string): McpLoginFailure {
	if (/does not support dynamic client registration/i.test(message)) return "needs-own-app";
	// A 403 mid-flow is a refusal, not a missing login: providers like Figma
	// answer registration with a bare 403 for any app not on their partner
	// allowlist (observed live: "HTTP 403: Invalid OAuth error response: …
	// Raw body: Forbidden").
	if (/HTTP 403/i.test(message)) return "refused";
	// A status the next attempt may get past, even while it looks for its sign-in.
	const status = /HTTP (\d{3})\b/.exec(message);
	if (status && isPassingStatus(Number(status[1]))) return "busy";
	// Only OAuth *discovery* coming up empty means the server has no login.
	// (Matching any "404"/"not found" here mislabeled every downstream OAuth
	// failure — including bodies that merely contain those words.)
	if (/does not implement OAuth|trying to load well-known OAuth|no authorization server/i.test(message)) return "no-sign-in";
	if (/timed? ?out/i.test(message)) return "too-slow";
	return "other";
}

/**
 * Reject a login attempt stuck waiting for the browser callback (typically
 * because the user closed the window). Rejecting the pending callback makes
 * the in-flight authenticate() clean up and settle, freeing the server for a
 * fresh attempt.
 */
async function cancelPendingLoginAttempt(name: string, record: { done: boolean }): Promise<void> {
	try {
		const [authStore, callbackMod] = await Promise.all([import(ADAPTER_AUTH_STORE), import(ADAPTER_CALLBACK)]);
		const oauthState = authStore.getOAuthState(name);
		if (oauthState) callbackMod.cancelPendingCallback(oauthState);
	} catch {
		// best effort — the attempt also dies on its own 5-minute timeout
	}
	const waitUntil = Date.now() + 3000;
	while (!record.done && Date.now() < waitUntil) {
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
}

export async function cancelMcpServerLogin(name: string): Promise<{ cancelled: boolean }> {
	ensureAgentDirEnv();
	const record = pendingLogins.get(name);
	if (!record || record.done) return { cancelled: false };
	await cancelPendingLoginAttempt(name, record);
	pendingLogins.delete(name);
	return { cancelled: true };
}

export async function startMcpServerLogin(name: string): Promise<{ started: boolean; pending?: boolean }> {
	ensureAgentDirEnv();
	const [configMod, authFlow] = await Promise.all([import(ADAPTER_CONFIG), import(ADAPTER_AUTH_FLOW)]);
	const merged = configMod.loadMcpConfig();
	const entry = merged.mcpServers?.[name];
	if (!entry) throw new McpAdminError(CONNECTOR_REQUEST_LINES.noLongerExists, 404);
	if (!entry.url) throw new McpAdminError("Only remote (URL) connectors use OAuth login.");
	if (!authFlow.supportsOAuth(entry)) throw new McpAdminError("This connector has authentication disabled in its config.");

	const pending = pendingLogins.get(name);
	if (pending && !pending.done) {
		// A previous attempt is stuck (e.g. the browser window was closed):
		// cancel it and start fresh instead of locking the user out.
		await cancelPendingLoginAttempt(name, pending);
		if (!pending.done) {
			throw new McpAdminError(CONNECTOR_REQUEST_LINES.signInStillClosing, 409);
		}
	}
	const record: { startedAt: number; done: boolean; cause?: McpLoginFailure; detail?: string } = { startedAt: Date.now(), done: false };
	pendingLogins.set(name, record);
	// Runs the adapter's real flow: prints + opens the authorization URL in the
	// local browser and completes via the loopback callback server.
	void authFlow
		.authenticate(name, entry.url, entry)
		.then(() => {
			record.done = true;
			// What the last check said about signing in is out of date now.
			writeMcpConnectorCheck(name, null);
		})
		.catch((e: Error) => {
			record.done = true;
			const failure = loginFailureOf(e.message ?? String(e));
			record.cause = failure.cause;
			record.detail = failure.detail;
		});
	return { started: true };
}

export function getMcpServerLoginState(name: string): { pending: boolean; cause?: McpLoginFailure; detail?: string } {
	const record = pendingLogins.get(name);
	if (!record) return { pending: false };
	return { pending: !record.done, cause: record.cause, detail: record.detail };
}

/**
 * Remove a server's entry from the metadata cache file. Must edit the file
 * directly: the adapter's saveMetadataCache() merges with what is on disk, so
 * saving a cache object with a key deleted silently resurrects the entry.
 */
async function dropMetadataCacheEntry(name: string): Promise<void> {
	try {
		const cacheMod = await import(ADAPTER_CACHE);
		const cachePath: string = cacheMod.getMetadataCachePath();
		const parsed = JSON.parse(fs.readFileSync(cachePath, "utf-8"));
		if (!parsed?.servers?.[name]) return;
		delete parsed.servers[name];
		const tmp = `${cachePath}.${process.pid}.tmp`;
		fs.writeFileSync(tmp, JSON.stringify(parsed, null, 2));
		fs.renameSync(tmp, cachePath);
	} catch {
		// cache cleanup is advisory
	}
}

export async function logoutMcpServer(name: string): Promise<void> {
	ensureAgentDirEnv();
	const authFlow = await import(ADAPTER_AUTH_FLOW);
	await authFlow.removeAuth(name);
	// Drop the cached tool list too: a cache entry with no stored tokens is how
	// the UI concludes "connects without a login", which would now be stale.
	await dropMetadataCacheEntry(name);
	writeMcpConnectorCheck(name, null);
}

/**
 * One direct streamable-HTTP initialize POST, with the entry's static
 * credentials attached, to recover the server's real verdict after the
 * adapter's SSE fallback obscured it. Returns null when the probe can't
 * improve on the original error (network failure, or the POST succeeds and
 * the failure lies elsewhere).
 */
async function explainSseFallback(entry: {
	url?: string;
	headers?: Record<string, string>;
	auth?: "bearer" | "oauth" | false;
	bearerToken?: string;
	bearerTokenEnv?: string;
}): Promise<{ message: string; needsAuth: boolean; httpStatus: number } | null> {
	const headers: Record<string, string> = { ...(entry.headers ?? {}) };
	// A shared server sends no variable's value as a token; a connector that names
	// one still counts as carrying a key, so a refusal keeps its own words.
	const sharedServer = process.env.EXXPERTS_SHARED_SERVER === "1";
	const tokenFromEnv = entry.bearerTokenEnv && !sharedServer ? process.env[entry.bearerTokenEnv] : undefined;
	const token = entry.auth === "bearer" ? (entry.bearerToken ?? tokenFromEnv) : undefined;
	if (token) headers.Authorization = `Bearer ${token}`;
	const hasStaticCredentials = Boolean(token) || (sharedServer && Boolean(entry.bearerTokenEnv)) || Object.keys(entry.headers ?? {}).length > 0;
	try {
		const response = await fetch(String(entry.url), {
			method: "POST",
			redirect: "manual",
			headers: {
				"Content-Type": "application/json",
				Accept: "application/json, text/event-stream",
				...headers,
			},
			body: JSON.stringify({
				jsonrpc: "2.0",
				id: 0,
				method: "initialize",
				params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "exxperts-connection-test", version: "1.0" } },
			}),
			signal: AbortSignal.timeout(5000),
		});
		const body = (await response.text()).trim();
		// For Technical details: the status and the service's own words, true for a refusal and a busy service alike.
		const answered = `HTTP ${response.status}${body ? `: ${body}` : ""}`;
		if (response.status === 401 || response.status === 403) {
			return hasStaticCredentials
				? { message: answered, needsAuth: false, httpStatus: response.status }
				: { message: `This server requires authentication (${answered}).`, needsAuth: true, httpStatus: response.status };
		}
		if (!response.ok) return { message: answered, needsAuth: false, httpStatus: response.status };
		return null;
	} catch {
		return null;
	}
}

export interface McpServerTestResult {
	ok: boolean;
	toolCount?: number;
	toolNames?: string[];
	needsAuth?: boolean;
	error?: string;
	/** The status the address answered with, when the test learned it; the page words its next step from it. */
	httpStatus?: number;
	/** The connector changed while it was checked (a new address or key): this result is not about it any more, and nothing of it was kept. */
	superseded?: true;
	/** The program did not start, because this room can change files where it runs from. Kept as no check: the status says it while it holds. */
	startRefused?: ConnectorStartRefusal;
}

export async function testMcpServer(name: string): Promise<McpServerTestResult> {
	ensureAgentDirEnv();
	installConnectorStartCheck();
	const [configMod, managerMod, cacheMod] = await Promise.all([
		import(ADAPTER_CONFIG),
		import(ADAPTER_SERVER_MANAGER),
		import(ADAPTER_CACHE),
	]);
	const merged = configMod.loadMcpConfig();
	const entry = merged.mcpServers?.[name];
	if (!entry) throw new McpAdminError(CONNECTOR_REQUEST_LINES.noLongerExists, 404);
	// A check describes the entry it ran against. One the person changed meanwhile keeps nothing of it.
	const unchanged = () => JSON.stringify(configMod.loadMcpConfig().mcpServers?.[name]) === JSON.stringify(entry);

	const manager = new managerMod.McpServerManager();
	try {
		const connection = await Promise.race([
			manager.connect(name, entry),
			new Promise<never>((_, reject) => setTimeout(() => reject(new Error("Connection timed out after 20s.")), 20_000)),
		]);
		const toolNames = (connection.tools ?? []).map((tool: { name: string }) => tool.name);
		if (!unchanged()) return { ok: true, toolCount: toolNames.length, toolNames, superseded: true };
		// Refresh the metadata cache so the Connectors page lists the tools. A
		// tool's own title rides along; the adapter's own cache writes leave it
		// out, and the page then words the tool from its name.
		const titles = new Map<string, string>(
			(connection.tools ?? []).flatMap((tool: { name: string; title?: unknown; annotations?: { title?: unknown } }) => {
				const title = typeof tool.title === "string" ? tool.title : typeof tool.annotations?.title === "string" ? tool.annotations.title : "";
				return title.trim() ? [[tool.name, title.trim()] as [string, string]] : [];
			}),
		);
		try {
			const cache = cacheMod.loadMetadataCache() ?? { version: 1, servers: {} };
			cache.servers[name] = {
				configHash: cacheMod.computeServerHash(entry),
				tools: cacheMod.serializeTools(connection.tools ?? []).map((tool: { name: string }) => (titles.has(tool.name) ? { ...tool, title: titles.get(tool.name) } : tool)),
				resources: cacheMod.serializeResources(connection.resources ?? []),
				cachedAt: Date.now(),
			};
			cacheMod.saveMetadataCache(cache);
		} catch {
			// cache refresh is best-effort
		}
		writeMcpConnectorCheck(name, { at: Date.now(), ok: true });
		return { ok: true, toolCount: toolNames.length, toolNames };
	} catch (e) {
		const startRefused = startRefusalOf(e);
		if (startRefused) return { ok: false, error: (e as Error).message, startRefused, ...(unchanged() ? {} : { superseded: true as const }) };
		let message = (e as Error).message ?? String(e);
		let needsAuth = /unauthorized|401|needs-auth|oauth|authentication required/i.test(message);
		let httpStatus: number | undefined;
		// The adapter probes streamable HTTP first and, when that probe dies
		// mid-OAuth (Figma refusing client registration, for example), silently
		// falls back to legacy SSE — whose GET then fails with a status code
		// that has nothing to do with the real problem ("SSE error: Non-200
		// status code (405)"). Ask the server directly what it thinks of a
		// plain streamable POST and report that answer instead.
		if (/SSE error: Non-200 status code/i.test(message) && typeof entry.url === "string") {
			const explained = await explainSseFallback(entry);
			if (explained) ({ message, needsAuth, httpStatus } = explained);
		}
		const error = trimTransportError(message);
		if (!unchanged()) return { ok: false, error, needsAuth, ...(httpStatus === undefined ? {} : { httpStatus }), superseded: true };
		if (needsAuth) {
			// A stale tool cache would keep the UI claiming "no login needed";
			// this connection attempt just proved otherwise.
			await dropMetadataCacheEntry(name);
		}
		writeMcpConnectorCheck(name, { at: Date.now(), ok: false, error, ...(needsAuth ? { needsAuth } : {}), ...(httpStatus === undefined ? {} : { httpStatus }) });
		return { ok: false, error, needsAuth, ...(httpStatus === undefined ? {} : { httpStatus }) };
	} finally {
		try {
			await manager.closeAll();
		} catch {
			// already closed / never opened
		}
	}
}

export interface ChangeMcpServerAddressInput {
	url?: unknown;
	/** The key for the new address: needed on another site when the connector had one, or to replace it. */
	key?: unknown;
}

/**
 * The new key as the header it replaces carries it: an Authorization header's
 * scheme word ("Bearer ") stays in front, unless the typed key brings its own.
 * Any other header takes the key as typed.
 */
function keyAsHeaderValue(header: string, old: string, typed: string): string {
	if (header.toLowerCase() !== "authorization") return typed;
	const scheme = /^([A-Za-z][\w-]*)\s+\S/.exec(old)?.[1];
	return scheme && !/^[A-Za-z][\w-]*\s+\S/.test(typed) ? `${scheme} ${typed}` : typed;
}

/**
 * Change a web connector's address, its key, or both. Its fixed name stays,
 * so every room keeps its access. On the same site (scheme, host and port) the
 * saved sign-in and key stay too. On another site they would go to whoever
 * answers there, so the sign-in and the key are dropped, and the key is asked
 * for again when there was one; a connector that would lose more (its own
 * sign-in app, a header that isn't its key) is refused instead. The cached
 * tools and the last check are dropped either way: they described the old
 * address. A new address takes back every room's yes to its tools: they were
 * given for the old one.
 */
export async function changeMcpServerAddress(name: string, input: ChangeMcpServerAddressInput): Promise<{ name: string; sameSite: boolean }> {
	ensureAgentDirEnv();
	const configMod = await import(ADAPTER_CONFIG);
	if (!configMod.loadMcpConfig().mcpServers?.[name]) throw new McpAdminError(CONNECTOR_REQUEST_LINES.noLongerExists, 404);
	const file: string = configMod.getPiGlobalConfigPath();
	let raw: Record<string, unknown> = {};
	try {
		raw = JSON.parse(fs.readFileSync(file, "utf-8"));
	} catch {
		// no file of our own: the connector comes from another app's file
	}
	const key = mcpServersKeyOf(raw);
	const own = key ? ((raw[key] as Record<string, ServerEntryShape & { bearerTokenEnv?: string }>)[name] ?? null) : null;
	if (!own) throw new McpAdminError(CONNECTOR_FORM_LINES.addressNotChangeable, 409);
	if (typeof own.url !== "string") throw new McpAdminError("Only a connector with a web address can change its address here.");
	const address = readConnectorAddress(String(input.url ?? ""));
	if ("error" in address) throw new McpAdminError(address.error);
	const newKey = String(input.key ?? "").trim();
	const sameSite = sameConnectorSite(own.url, address.url);
	const keyPlace = connectorKeyOf(own);
	const keyHeaders = Object.keys(own.headers ?? {}).filter(isCredentialHeaderName);
	const next: ServerEntryShape & { bearerTokenEnv?: string } = { ...own, url: address.url };
	if (!sameSite && !movesToAnotherSite(own)) throw new McpAdminError(CONNECTOR_FORM_LINES.cantMoveSite);
	if (newKey && keyPlace !== "replaceable") throw new McpAdminError(CONNECTOR_FORM_LINES.keyNotChangeable);
	if (!sameSite) {
		if (keyPlace !== "none" && !newKey) throw new McpAdminError(CONNECTOR_FORM_LINES.anotherSiteKey);
		// Sign-in switched off on purpose stays off; switched off only because a key header was the sign-in, it goes with the key.
		if (!(own.auth === false && keyHeaders.length === 0)) delete next.auth;
		delete next.bearerToken;
		delete next.bearerTokenEnv;
		delete next.oauth;
		// Its only headers are its key, which comes back below with the new one.
		delete next.headers;
	}
	if (newKey) {
		// The key goes where the connector kept it: its one key header, else the bearer token.
		if (keyHeaders.length === 1) {
			const header = keyHeaders[0];
			next.headers = validateHeaders({ ...(next.headers ?? {}), [header]: keyAsHeaderValue(header, own.headers?.[header] ?? "", newKey) }, false);
			// A new key in the same header changes nothing else: the sign-in stays as the connector had it.
			if (own.auth === undefined) delete next.auth;
			else next.auth = own.auth;
		} else {
			next.auth = "bearer";
			next.bearerToken = newKey;
			delete next.bearerTokenEnv;
		}
	}
	const refusal = serverHooks().connectorEntryRefusal?.(next);
	if (refusal) throw new McpAdminError(refusal);
	if (!sameSite) {
		// The old site's sign-in goes before the new address is written, so a
		// failure here leaves the old address, never the old sign-in on the new
		// one. A sign-in still running would save its result for the old site.
		await cancelMcpServerLogin(name);
		const authFlow = await import(ADAPTER_AUTH_FLOW);
		await authFlow.removeAuth(name);
	}
	// Before the new address is written, so a failure between the two leaves rooms asking, never a yes for the new address.
	// A shared server keeps no yes, so it reads no room's file here.
	if (address.url !== own.url && !isSharedServer()) {
		for (const failure of forgetMcpConnectorToolsInAllRooms(name).failures) console.warn(`connector address change: taking back the room's yeses failed in ${failure.agentId}: ${failure.error}`);
	}
	configMod.writeSharedServerEntry(file, name, next);
	if (sameSite) {
		// The adapter keeps a sign-in for the exact address it was made at and
		// ignores it once the address differs, so the kept sign-in moves along.
		const authStore = await import(ADAPTER_AUTH_STORE);
		const saved = authStore.getAuthEntry(name);
		if (saved?.serverUrl === own.url) authStore.saveAuthEntry(name, saved, address.url);
	}
	await dropMetadataCacheEntry(name);
	writeMcpConnectorCheck(name, null);
	return { name, sameSite };
}
