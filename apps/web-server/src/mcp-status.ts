/**
 * Read-only MCP connector status for the web UI.
 *
 * Reuses pi-mcp-adapter's own config/auth/cache readers so the web UI reports
 * exactly what room sessions will see: the merged server list across the four
 * config locations, which file each server came from, OAuth credential state,
 * and cached tool metadata. Live connection state lives inside running agent
 * sessions and is intentionally not reported here.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { stateHome } from "../../../pi-package/product-state-paths.js";
import type { ConnectorStartRefusal, StartRefusalLookup } from "./connector-start-check.js";
import { mcpConnectorRoomUse, type McpConnectorRoomUse } from "./persistent-room-mcp-settings.js";
import { isSharedServer } from "./server-hooks.js";
import type { ConnectorKey } from "./connector-form.js";

// Non-literal specifiers so tsc never resolves into the adapter's raw .ts
// sources (same pattern as pi-package/extensions/mcp/index.ts).
const ADAPTER_CONFIG = "pi-mcp-adapter/config.ts" as string;
const ADAPTER_AUTH = "pi-mcp-adapter/mcp-auth.ts" as string;
const ADAPTER_CACHE = "pi-mcp-adapter/metadata-cache.ts" as string;
const ADAPTER_UTILS = "pi-mcp-adapter/utils.ts" as string;

export interface McpConnectorAuthStatus {
	mode: "oauth" | "bearer" | "none";
	// True when the entry explicitly configures OAuth (auth: "oauth" or a
	// custom client), as opposed to the URL-server auto-detect. Explicitly
	// configured OAuth means a login IS expected — even if the server lists
	// tools without one (Gmail and HubSpot expose their catalogs
	// unauthenticated, which otherwise looks like "no login needed").
	explicit: boolean;
	hasStoredTokens: boolean;
	tokenExpired: boolean | null;
	// An expired access token with a refresh token is not a problem — the
	// adapter renews it automatically on the next connection.
	hasRefreshToken: boolean;
}

export interface McpConnectorToolsStatus {
	count: number;
	names: string[];
	/** A tool's own title, by its name, when the connector gave one. */
	titles: Record<string, string>;
	cachedAt: number;
}

/** What the last connection check found, kept so the page shows it at once on its next open. */
export interface McpConnectorCheck {
	at: number;
	ok: boolean;
	needsAuth?: boolean;
	/** The status the address answered with, when the check learned it. */
	httpStatus?: number;
	/** The server's own words, for Technical details. */
	error?: string;
}

export interface McpConnectorStatus {
	name: string;
	transport: "http" | "stdio";
	target: string;
	/** importFile: the other tool's own file an imported entry is read from (Cursor's ~/.cursor/mcp.json); Remove cannot remove such an entry, so a change is made there. */
	source: { path: string; kind: string; importKind?: string; importFile?: string } | null;
	auth: McpConnectorAuthStatus;
	tools: McpConnectorToolsStatus | null;
	/** The name the person typed, when it differs from the fixed name. */
	displayName?: string;
	/** True for a web connector added here, whose address can be changed here. */
	editable: boolean;
	/** Where its key is, as Change key sees it. */
	key: ConnectorKey;
	/** Whether a new address on another site leaves it whole: only its name, its rooms and a key typed again go along. */
	movesToAnotherSite: boolean;
	/** Named in a file other apps read too (the shared MCP file or a project's .mcp.json), which Remove deletes it from as well. */
	inSharedFile?: true;
	/** The rooms that may use it; null where this server does not say (a shared server, whose rooms are other people's). */
	usedIn: McpConnectorRoomUse[] | null;
	lastCheck: McpConnectorCheck | null;
	/** A program that would not start now, because this room can change files where it runs from. */
	startRefused?: ConnectorStartRefusal;
}

/** The key an MCP config file keeps its connectors under, or null when it has none. */
export function mcpServersKeyOf(parsed: Record<string, unknown>): string | null {
	if (parsed.mcpServers && typeof parsed.mcpServers === "object") return "mcpServers";
	if (parsed["mcp-servers"] && typeof parsed["mcp-servers"] === "object") return "mcp-servers";
	return null;
}

/** The connector names a config file defines; none when it can't be read, as Remove then leaves it alone too. */
function namesInConfigFile(filePath: string): string[] {
	try {
		const parsed = JSON.parse(fs.readFileSync(filePath, "utf-8"));
		const key = mcpServersKeyOf(parsed);
		return key ? Object.keys(parsed[key] as Record<string, unknown>) : [];
	} catch {
		return [];
	}
}

export interface McpConfigSourceStatus {
	label: string;
	path: string;
	exists: boolean;
	scope: "global" | "project";
	serverCount: number;
}

export interface McpConnectorsStatusResponse {
	servers: McpConnectorStatus[];
	configSources: McpConfigSourceStatus[];
	totalServers: number;
}

function ensureAgentDirEnv(): void {
	// The adapter resolves its agent-global config dir from PI_CODING_AGENT_DIR
	// (defaulting to ~/.pi/agent); point it at the exxperts agent dir, matching
	// what the mcp extension does inside room sessions.
	if (!process.env.PI_CODING_AGENT_DIR) {
		process.env.PI_CODING_AGENT_DIR = path.join(stateHome(), ".exxperts", "agent");
	}
}

function connectorChecksPath(): string {
	ensureAgentDirEnv();
	return path.join(String(process.env.PI_CODING_AGENT_DIR), "mcp-connector-checks.json");
}

/** Every connector's last check; a missing or unreadable file reads as none known. */
export function readMcpConnectorChecks(): Record<string, McpConnectorCheck> {
	try {
		const parsed = JSON.parse(fs.readFileSync(connectorChecksPath(), "utf-8"));
		const checks = parsed?.schemaVersion === 1 && parsed.checks && typeof parsed.checks === "object" ? parsed.checks : {};
		const kept: Record<string, McpConnectorCheck> = {};
		for (const [name, raw] of Object.entries(checks as Record<string, Partial<McpConnectorCheck>>)) {
			if (!raw || typeof raw.at !== "number" || typeof raw.ok !== "boolean") continue;
			kept[name] = {
				at: raw.at,
				ok: raw.ok,
				...(raw.needsAuth === true ? { needsAuth: true } : {}),
				...(typeof raw.httpStatus === "number" ? { httpStatus: raw.httpStatus } : {}),
				...(typeof raw.error === "string" ? { error: raw.error } : {}),
			};
		}
		return kept;
	} catch {
		return {};
	}
}

/**
 * Keep a connector's last check, or forget it (null) once it says nothing true
 * any more: after a sign-in or sign-out, a changed address, or a removal. Read,
 * change and write in one synchronous step through a temporary file, so two
 * checks finishing together in this process never lose one another.
 */
export function writeMcpConnectorCheck(name: string, check: McpConnectorCheck | null): void {
	const checks = readMcpConnectorChecks();
	if (check) checks[name] = check;
	else if (name in checks) delete checks[name];
	else return;
	const file = connectorChecksPath();
	fs.mkdirSync(path.dirname(file), { recursive: true });
	const tmp = `${file}.${process.pid}.tmp`;
	fs.writeFileSync(tmp, `${JSON.stringify({ schemaVersion: 1, checks }, null, 2)}\n`, { mode: 0o600 });
	fs.renameSync(tmp, file);
}

function tildePath(p: string): string {
	const home = os.homedir();
	return p.startsWith(home) ? `~${p.slice(home.length)}` : p;
}

/**
 * A header that carries a credential (an API key in its own header), by the
 * words in its name: Authorization, a token, a secret, or an API key
 * (X-Api-Key, Api-Key, ApiKey). Whole words, so Idempotency-Key or
 * Notion-Version are not taken for a sign-in.
 */
export function isCredentialHeaderName(name: string): boolean {
	const words = name.toLowerCase().split(/[-_.]/);
	return ["authorization", "token", "secret", "apikey"].some((word) => words.includes(word)) || (words.includes("api") && words.includes("key"));
}

/** A connector's entry as far as its key and sign-in go. */
interface ConnectorSignInEntry {
	auth?: "oauth" | "bearer" | false;
	bearerToken?: string;
	bearerTokenEnv?: string;
	headers?: Record<string, string>;
	oauth?: unknown;
}

export function connectorKeyOf(entry: ConnectorSignInEntry): ConnectorKey {
	const keyHeaders = Object.keys(entry.headers ?? {}).filter(isCredentialHeaderName).length;
	const token = Boolean(entry.bearerToken || entry.bearerTokenEnv || entry.auth === "bearer");
	if (!token) return keyHeaders === 0 ? "none" : keyHeaders === 1 ? "replaceable" : "fixed";
	return keyHeaders === 0 && !hasOwnSignInApp(entry) ? "replaceable" : "fixed";
}

export function hasOwnSignInApp(entry: ConnectorSignInEntry): boolean {
	return typeof entry.oauth === "object" && entry.oauth !== null;
}

/**
 * On another site a connector keeps only its name, its rooms and a key typed
 * again. One with its own sign-in app, a header that isn't its key, or a key
 * that can't be typed again in one field would lose it, with no way to put it
 * back without adding the connector again.
 */
export function movesToAnotherSite(entry: ConnectorSignInEntry): boolean {
	return !hasOwnSignInApp(entry) && Object.keys(entry.headers ?? {}).every(isCredentialHeaderName) && connectorKeyOf(entry) !== "fixed";
}

function authModeFor(entry: {
	url?: string;
	auth?: "oauth" | "bearer" | false;
	bearerToken?: string;
	bearerTokenEnv?: string;
	headers?: Record<string, string>;
	oauth?: unknown;
}): McpConnectorAuthStatus["mode"] {
	if (entry.auth === "bearer" || entry.bearerToken || entry.bearerTokenEnv) return "bearer";
	// Static credential headers (API keys in their own header) come with
	// auth: false to switch off OAuth auto-detect, but to the UI they are
	// token auth, not "no login needed".
	if (entry.auth === false && Object.keys(entry.headers ?? {}).some(isCredentialHeaderName)) return "bearer";
	// Mirrors the adapter's supportsOAuth: HTTP servers auto-detect OAuth
	// unless auth/oauth is explicitly disabled.
	if (entry.url && entry.auth !== false && entry.oauth !== false) return "oauth";
	return "none";
}

/**
 * The current globally configured connector names (merged across the config
 * files, exactly what a session's adapter would load). This is the universe
 * per-room grants are validated against and intersected with.
 */
export async function listConfiguredMcpConnectorNames(): Promise<string[]> {
	ensureAgentDirEnv();
	const configMod = await import(ADAPTER_CONFIG);
	const config = configMod.loadMcpConfig();
	return Object.keys(config.mcpServers ?? {}).sort((a, b) => a.localeCompare(b));
}

/**
 * Each configured connector's name as typed, where one was given: the only
 * part of an entry a room's own Connectors pane needs beyond its fixed name,
 * and nothing that could carry an address, a command or a key.
 */
export async function listConfiguredMcpConnectorDisplayNames(): Promise<Record<string, string>> {
	ensureAgentDirEnv();
	const configMod = await import(ADAPTER_CONFIG);
	const servers: Record<string, { displayName?: unknown }> = configMod.loadMcpConfig().mcpServers ?? {};
	return Object.fromEntries(Object.entries(servers).flatMap(([name, entry]) => (typeof entry?.displayName === "string" && entry.displayName ? [[name, entry.displayName]] : [])));
}

/**
 * startCheck says which program would not start; without it no row carries
 * `startRefused`. It comes in from the caller, so this file never imports the
 * room folders' modules: a program that takes only isCredentialHeaderName from
 * here is built into one file that must not carry them.
 */
export async function getMcpConnectorsStatus(startCheck?: StartRefusalLookup): Promise<McpConnectorsStatusResponse> {
	ensureAgentDirEnv();
	const [configMod, authMod, cacheMod, utilsMod] = await Promise.all([
		import(ADAPTER_CONFIG),
		import(ADAPTER_AUTH),
		import(ADAPTER_CACHE),
		import(ADAPTER_UTILS),
	]);

	const summary = configMod.getMcpDiscoverySummary();
	const config = configMod.loadMcpConfig();
	const provenance: Map<string, { path: string; kind: string; importKind?: string }> = configMod.getServerProvenance();
	const cache = cacheMod.loadMetadataCache();
	// The shared global file is no import kind, so its entries get no importFile: Remove works there.
	const importFiles = new Map<string, string>((configMod.findAvailableImportConfigs() as Array<{ kind: string; path: string }>).map((found) => [found.kind, found.path]));
	const checks = readMcpConnectorChecks();
	const inSharedFiles = new Set(
		((summary.sources ?? []) as Array<{ kind: string; path: string; exists: boolean }>)
			.filter((source) => source.kind === "shared" && source.exists)
			.flatMap((source) => namesInConfigFile(source.path)),
	);
	// A shared server's rooms belong to other people, so their names stay out of
	// the admin's answer; each room still shows its own connectors.
	const roomUse = isSharedServer() ? null : await mcpConnectorRoomUse();
	// The start check as a start would make it now, before the npx lookup, which can download.
	const writePlaces = startCheck && Object.values(config.mcpServers ?? {}).some((entry) => typeof (entry as { command?: unknown } | null)?.command === "string") ? await startCheck.roomWritePlaces() : [];

	const servers: McpConnectorStatus[] = Object.entries(config.mcpServers ?? {}).map(([name, rawEntry]) => {
		const entry = rawEntry as {
			url?: string;
			command?: string;
			args?: string[];
			cwd?: string;
			env?: Record<string, string>;
			auth?: "oauth" | "bearer" | false;
			bearerToken?: string;
			bearerTokenEnv?: string;
			headers?: Record<string, string>;
			oauth?: unknown;
			displayName?: unknown;
		};
		const mode = authModeFor(entry);
		const source = provenance.get(name);
		const cacheEntry = cache?.servers?.[name];
		const cacheValid = cacheEntry ? cacheMod.isServerCacheValid(cacheEntry, entry) : false;
		// Looked up as the start looks it up: on the connector's own PATH when it declares one.
		const startRefused = startCheck && typeof entry.command === "string" ? startCheck.connectorStartRefusal({ command: entry.command, args: Array.isArray(entry.args) ? entry.args : [], cwd: utilsMod.resolveConfigPath(entry.cwd), environment: utilsMod.interpolateEnvRecord(entry.env) }, writePlaces) : null;
		return {
			name,
			transport: entry.url ? "http" : "stdio",
			target: entry.url ?? [entry.command ?? "", ...(entry.args ?? [])].join(" ").trim(),
			source: source ? { path: tildePath(source.path), kind: source.kind, importKind: source.importKind, ...(source.importKind && importFiles.has(source.importKind) ? { importFile: tildePath(importFiles.get(source.importKind)!) } : {}) } : null,
			auth: {
				mode,
				explicit: mode === "oauth" && (entry.auth === "oauth" || (typeof entry.oauth === "object" && entry.oauth !== null)),
				hasStoredTokens: mode === "oauth" ? Boolean(authMod.hasStoredTokens(name)) : false,
				tokenExpired: mode === "oauth" ? (authMod.isTokenExpired(name) as boolean | null) : null,
				hasRefreshToken: mode === "oauth" ? Boolean(authMod.getAuthEntry(name)?.tokens?.refreshToken) : false,
			},
			tools: cacheValid
				? {
						count: cacheEntry.tools?.length ?? 0,
						names: (cacheEntry.tools ?? []).map((tool: { name: string }) => tool.name),
						titles: Object.fromEntries((cacheEntry.tools ?? []).filter((tool: { title?: unknown }) => typeof tool.title === "string" && tool.title.trim()).map((tool: { name: string; title: string }) => [tool.name, tool.title.trim()])),
						cachedAt: cacheEntry.cachedAt,
					}
				: null,
			...(typeof entry.displayName === "string" && entry.displayName.trim() ? { displayName: entry.displayName.trim() } : {}),
			// Only an entry in exxperts' own file, which the address route writes.
			editable: Boolean(entry.url) && source?.kind === "user" && !source.importKind,
			key: connectorKeyOf(entry),
			movesToAnotherSite: movesToAnotherSite(entry),
			...(inSharedFiles.has(name) ? { inSharedFile: true as const } : {}),
			usedIn: roomUse ? (roomUse.get(name) ?? []) : null,
			lastCheck: checks[name] ?? null,
			...(startRefused ? { startRefused } : {}),
		};
	});

	// The adapter labels sources in Pi terms ("Pi global override"); present
	// them in product terms instead.
	const SOURCE_LABELS: Record<string, string> = {
		"shared-global": "shared user config (Cursor/Claude compatible)",
		"pi-global": "exxperts user config",
		"shared-project": "project config",
		"pi-project": "project override",
	};
	// Project-scoped files resolve against this server process's cwd, which is
	// meaningless to a web user (project configs are a per-folder CLI concept)
	// — only report the global files here.
	const configSources: McpConfigSourceStatus[] = (summary.sources ?? [])
		.filter((source: { scope: string }) => source.scope === "global")
		.map(
			(source: { id: string; label: string; path: string; exists: boolean; scope: "global" | "project"; serverCount: number }) => ({
				label: SOURCE_LABELS[source.id] ?? source.label,
				path: tildePath(source.path),
				exists: source.exists,
				scope: source.scope,
				serverCount: source.serverCount,
			}),
		);

	return {
		servers: servers.sort((a, b) => a.name.localeCompare(b.name)),
		configSources,
		totalServers: servers.length,
	};
}
