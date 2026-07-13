/**
 * MCP connector management for the web UI: add/remove servers, OAuth
 * login/logout, and one-off connection tests.
 *
 * Config writes go through the same files the adapter reads. Running room
 * sessions load MCP config at session start, so changes apply the next time
 * a room session is (re)entered — callers surface that in the UI.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

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
		process.env.PI_CODING_AGENT_DIR = path.join(os.homedir(), ".exxperts", "agent");
	}
}

const SERVER_NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;

export interface AddMcpServerOAuthInput {
	clientId?: string;
	clientSecret?: string;
	scope?: string;
}

export interface AddMcpServerInput {
	name: string;
	url?: string;
	command?: string;
	args?: string[];
	bearerToken?: string;
	oauth?: AddMcpServerOAuthInput;
}

interface ServerEntryShape {
	url?: string;
	command?: string;
	args?: string[];
	auth?: "bearer" | "oauth";
	bearerToken?: string;
	oauth?: { clientId: string; clientSecret?: string; scope?: string };
}

function validateAddInput(input: AddMcpServerInput): { name: string; entry: ServerEntryShape } {
	const name = String(input.name ?? "").trim();
	if (!SERVER_NAME_PATTERN.test(name)) {
		throw new McpAdminError("Connector name must be 1-64 characters: letters, digits, dashes, underscores.");
	}
	const url = String(input.url ?? "").trim();
	const command = String(input.command ?? "").trim();
	if (url && command) throw new McpAdminError("Provide either a URL or a command, not both.");
	if (url) {
		let parsed: URL;
		try {
			parsed = new URL(url);
		} catch {
			throw new McpAdminError("The server URL is not a valid URL.");
		}
		if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
			throw new McpAdminError("The server URL must use http(s).");
		}
		const bearerToken = String(input.bearerToken ?? "").trim();
		const clientId = String(input.oauth?.clientId ?? "").trim();
		const clientSecret = String(input.oauth?.clientSecret ?? "").trim();
		const scope = String(input.oauth?.scope ?? "").trim();
		if ((clientSecret || scope) && !clientId) {
			throw new McpAdminError("A custom OAuth client needs at least a client ID.");
		}
		if (bearerToken && clientId) {
			throw new McpAdminError("Provide either an API token or a custom OAuth client, not both.");
		}
		if (bearerToken) return { name, entry: { url, auth: "bearer", bearerToken } };
		if (clientId) {
			// Pre-registered client: the adapter's OAuth provider uses it directly
			// and skips dynamic client registration, which providers like HubSpot
			// do not support.
			return {
				name,
				entry: { url, auth: "oauth", oauth: { clientId, ...(clientSecret ? { clientSecret } : {}), ...(scope ? { scope } : {}) } },
			};
		}
		return { name, entry: { url } };
	}
	if (input.bearerToken) throw new McpAdminError("API tokens only apply to remote (URL) connectors.");
	if (input.oauth?.clientId) throw new McpAdminError("Custom OAuth clients only apply to remote (URL) connectors.");
	if (command) {
		const args = Array.isArray(input.args) ? input.args.map((a) => String(a)).filter((a) => a.trim() !== "") : [];
		return { name, entry: args.length > 0 ? { command, args } : { command } };
	}
	throw new McpAdminError("Provide a server URL (remote) or a command (local).");
}

export async function addMcpServer(input: AddMcpServerInput): Promise<{ name: string; path: string }> {
	ensureAgentDirEnv();
	const configMod = await import(ADAPTER_CONFIG);
	const { name, entry } = validateAddInput(input);
	const merged = configMod.loadMcpConfig();
	if (merged.mcpServers?.[name]) {
		throw new McpAdminError(`A connector named "${name}" already exists. Remove it first or pick another name.`, 409);
	}
	const target: string = configMod.getPiGlobalConfigPath();
	configMod.writeSharedServerEntry(target, name, entry);
	return { name, path: target };
}

function serversKeyOf(parsed: Record<string, unknown>): string | null {
	if (parsed.mcpServers && typeof parsed.mcpServers === "object") return "mcpServers";
	if (parsed["mcp-servers"] && typeof parsed["mcp-servers"] === "object") return "mcp-servers";
	return null;
}

function removeEntryFromFile(filePath: string, name: string): boolean {
	let parsed: Record<string, unknown>;
	try {
		parsed = JSON.parse(fs.readFileSync(filePath, "utf-8"));
	} catch {
		return false;
	}
	const key = serversKeyOf(parsed);
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
		throw new McpAdminError(`No connector named "${name}" is configured.`, 404);
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
		const provenance = configMod.getServerProvenance().get(name);
		const from = provenance?.importKind ? ` It is imported from your ${provenance.importKind} config` : "";
		throw new McpAdminError(
			`"${name}" is not defined in an exxperts config file.${from} Remove it in that tool, or drop the import from ~/.exxperts/agent/mcp.json.`,
			409,
		);
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
	return { name, removedFrom };
}

// One login may be in flight per server; the UI polls /api/mcp/status for the
// resulting tokens rather than holding the HTTP request open.
const pendingLogins = new Map<string, { startedAt: number; error?: string; done: boolean }>();

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
	return `${trimmed.slice(0, max)}… [response body trimmed]`;
}

function friendlyLoginError(message: string): string {
	if (/does not support dynamic client registration/i.test(message)) {
		return "This provider needs a pre-registered OAuth app: create one in the provider's developer settings with redirect URL http://localhost:19876/callback, then re-add the connector with its client ID and secret under Custom OAuth client.";
	}
	if (/invalid oauth error response|404|not found|no authorization server/i.test(message)) {
		return "This connector doesn't offer a login. It likely works without one. Use Test connection to check.";
	}
	if (/timed? ?out/i.test(message)) {
		return "The login timed out. Try again.";
	}
	return `Login failed: ${trimTransportError(message)}`;
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
	if (!entry) throw new McpAdminError(`No connector named "${name}" is configured.`, 404);
	if (!entry.url) throw new McpAdminError("Only remote (URL) connectors use OAuth login.");
	if (!authFlow.supportsOAuth(entry)) throw new McpAdminError("This connector has authentication disabled in its config.");

	const pending = pendingLogins.get(name);
	if (pending && !pending.done) {
		// A previous attempt is stuck (e.g. the browser window was closed):
		// cancel it and start fresh instead of locking the user out.
		await cancelPendingLoginAttempt(name, pending);
		if (!pending.done) {
			throw new McpAdminError("A previous login attempt is still winding down. Try again in a few seconds.", 409);
		}
	}
	const record = { startedAt: Date.now(), done: false as boolean, error: undefined as string | undefined };
	pendingLogins.set(name, record);
	// Runs the adapter's real flow: prints + opens the authorization URL in the
	// local browser and completes via the loopback callback server.
	void authFlow
		.authenticate(name, entry.url, entry)
		.then(() => {
			record.done = true;
		})
		.catch((e: Error) => {
			record.done = true;
			record.error = friendlyLoginError(e.message ?? String(e));
		});
	return { started: true };
}

export function getMcpServerLoginState(name: string): { pending: boolean; error?: string } {
	const record = pendingLogins.get(name);
	if (!record) return { pending: false };
	return { pending: !record.done, error: record.error };
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
}

export interface McpServerTestResult {
	ok: boolean;
	toolCount?: number;
	toolNames?: string[];
	needsAuth?: boolean;
	error?: string;
}

export async function testMcpServer(name: string): Promise<McpServerTestResult> {
	ensureAgentDirEnv();
	const [configMod, managerMod, cacheMod] = await Promise.all([
		import(ADAPTER_CONFIG),
		import(ADAPTER_SERVER_MANAGER),
		import(ADAPTER_CACHE),
	]);
	const merged = configMod.loadMcpConfig();
	const entry = merged.mcpServers?.[name];
	if (!entry) throw new McpAdminError(`No connector named "${name}" is configured.`, 404);

	const manager = new managerMod.McpServerManager();
	try {
		const connection = await Promise.race([
			manager.connect(name, entry),
			new Promise<never>((_, reject) => setTimeout(() => reject(new Error("Connection timed out after 20s.")), 20_000)),
		]);
		const toolNames = (connection.tools ?? []).map((tool: { name: string }) => tool.name);
		// Refresh the metadata cache so the Connectors page lists the tools.
		try {
			const cache = cacheMod.loadMetadataCache() ?? { version: 1, servers: {} };
			cache.servers[name] = {
				configHash: cacheMod.computeServerHash(entry),
				tools: cacheMod.serializeTools(connection.tools ?? []),
				resources: cacheMod.serializeResources(connection.resources ?? []),
				cachedAt: Date.now(),
			};
			cacheMod.saveMetadataCache(cache);
		} catch {
			// cache refresh is best-effort
		}
		return { ok: true, toolCount: toolNames.length, toolNames };
	} catch (e) {
		const message = (e as Error).message ?? String(e);
		const needsAuth = /unauthorized|401|needs-auth|oauth|authentication required/i.test(message);
		if (needsAuth) {
			// A stale tool cache would keep the UI claiming "no login needed";
			// this connection attempt just proved otherwise.
			await dropMetadataCacheEntry(name);
		}
		return { ok: false, error: trimTransportError(message), needsAuth };
	} finally {
		try {
			await manager.closeAll();
		} catch {
			// already closed / never opened
		}
	}
}
