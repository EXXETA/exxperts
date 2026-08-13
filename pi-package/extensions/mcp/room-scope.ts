/**
 * Per-room MCP enforcement: the ONE shared wrapper every door goes through.
 *
 * Rooms reach connectors through pi-mcp-adapter's single `mcp` proxy tool
 * (plus optional per-server direct tools). This module wraps those tool
 * registrations for a specific room so that:
 *
 *  - what the model can SEE is filtered: the proxy tool's description, the
 *    status/list/search answers, and describe all speak only of the room's
 *    granted connectors;
 *  - what the model can CALL is gated: every mode that names or resolves a
 *    server (call, connect, list, auth-start, auth-complete, server-scoped
 *    search) refuses connectors outside the grant list BEFORE the adapter
 *    runs, so no tool call ever opens a connection to an ungranted server
 *    on the room's behalf. Session START is scoped separately: the cold-cache
 *    bootstrap (which would otherwise connect every configured server once)
 *    is replaced by a granted-only warm-up in prepareRoomScopedMcpSessionCache;
 *    eager/keep-alive lifecycles and the adapter's direct-tools cache
 *    bootstrap deliberately keep their global warm behavior (the user opted
 *    those servers into background connections; owner decision 2026-08-11);
 *  - tool RESULTS are sanitized: any delegated result whose details name a
 *    server outside the grant list is replaced by the refusal, so a stray
 *    adapter-side resolution can never hand the room an ungranted answer.
 *
 * Grants are re-read from the room's mcp-settings.json on EVERY call (and
 * intersected with the live configured list), so a settings change applies
 * to the running conversation from the next call onward - room settings are
 * live, like every other room setting. The wrapper cannot reach the
 * adapter's in-memory state, so unqualified tool calls are resolved against
 * the same on-disk metadata cache the adapter maintains, then delegated with
 * an explicit `server` so the adapter's own cross-server scan (which would
 * lazily connect to ungranted servers) never runs for a room.
 *
 * Wording rule (product): refusals say the room's settings "control which
 * connectors this room can use" - never more than that.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
	effectiveGrantedMcpConnectors,
	ensurePersistentRoomMcpGrantsMigration,
	mcpGrantsFingerprint,
	persistentRoomMcpGrantsMigrationPending,
	readPersistentRoomMcpSettings,
	type PersistentRoomMcpSettingsStorageOptions,
} from "../../../apps/web-server/src/persistent-room-mcp-settings.js";

// Non-literal specifiers keep tsc from resolving the adapter's raw .ts
// sources (same pattern as index.ts and connectors-panel.ts).
const ADAPTER_CONFIG = "pi-mcp-adapter/config.ts" as string;
const ADAPTER_CACHE = "pi-mcp-adapter/metadata-cache.ts" as string;
const ADAPTER_TYPES = "pi-mcp-adapter/types.ts" as string;
const ADAPTER_DIRECT_TOOLS = "pi-mcp-adapter/direct-tools.ts" as string;
const ADAPTER_UTILS = "pi-mcp-adapter/utils.ts" as string;
const ADAPTER_TOOL_METADATA = "pi-mcp-adapter/tool-metadata.ts" as string;
const ADAPTER_SERVER_MANAGER = "pi-mcp-adapter/server-manager.ts" as string;

type PrefixMode = "server" | "none" | "short";

interface ProxyToolResultLike {
	content: Array<{ type: "text"; text: string }>;
	details?: Record<string, unknown>;
}

interface McpProxyParams {
	tool?: string;
	args?: string;
	connect?: string;
	describe?: string;
	search?: string;
	regex?: boolean;
	includeSchemas?: boolean;
	server?: string;
	action?: string;
}

type ProxyExecute = (
	toolCallId: string,
	params: McpProxyParams,
	signal: unknown,
	onUpdate: unknown,
	ctx: unknown,
) => Promise<ProxyToolResultLike>;

export interface RegisteredToolLike {
	name: string;
	description?: string;
	execute: (...args: unknown[]) => Promise<ProxyToolResultLike>;
	[key: string]: unknown;
}

interface RoomGrantContext {
	granted: Set<string>;
	/** Configured server names in config order (the adapter's scan order). */
	configuredNames: string[];
	config: { mcpServers: Record<string, Record<string, unknown>>; settings?: { toolPrefix?: PrefixMode } };
	prefixMode: PrefixMode;
	/** The room's stored grant list exactly as read (pre-intersection, sorted). */
	storedGrantedConnectors: string[];
}

const ROOM_SETTINGS_SENTENCE = "Room settings control which connectors this room can use.";

/**
 * The adapter resolves its agent-global config dir from PI_CODING_AGENT_DIR
 * (defaulting to ~/.pi/agent). Inside a session the extension entry has set
 * it already, but the migration and warm-up helpers are ALSO called directly
 * (web-server boot), where reading config before this is set would silently
 * see an empty connector list - the exact hazard the migration guards
 * against. Same logic as the extension entry and mcp-admin/mcp-status.
 */
function ensureAgentDirEnv(): void {
	if (!process.env.PI_CODING_AGENT_DIR) {
		process.env.PI_CODING_AGENT_DIR = path.join(os.homedir(), ".exxperts", "agent");
	}
}

function refusalResult(text: string, details: Record<string, unknown>): ProxyToolResultLike {
	return { content: [{ type: "text", text }], details };
}

function connectorNotEnabledResult(serverName: string): ProxyToolResultLike {
	return refusalResult(
		`Connector "${serverName}" is not enabled for this room. ${ROOM_SETTINGS_SENTENCE}`,
		{ error: "connector_not_enabled", server: serverName },
	);
}

function noConnectorsEnabledResult(): ProxyToolResultLike {
	return refusalResult(
		`No MCP connectors are enabled for this room. ${ROOM_SETTINGS_SENTENCE}`,
		{ error: "no_connectors_enabled", servers: [], totalTools: 0, connectedCount: 0 },
	);
}

/**
 * `cwd` matters: the adapter's session loads its config against the SESSION
 * cwd (a workspace room's runtime cwd, not the server's launch cwd), and the
 * grant context must see the same configured baseline or project-local
 * connectors become granted-but-refused. Callers pass the execution ctx cwd
 * when they have one; registration-time callers fall back to process.cwd(),
 * matching the adapter's own factory-time config read.
 */
async function loadRoomGrantContext(roomId: string, cwd?: string): Promise<RoomGrantContext> {
	ensureAgentDirEnv();
	const [configMod, utilsMod] = await Promise.all([import(ADAPTER_CONFIG), import(ADAPTER_UTILS)]);
	// Same baseline as the adapter's own loads: the --mcp-config argv override
	// (which the adapter factory and directToolSpecServers honor) plus the
	// session cwd - otherwise a connector defined only in the override file
	// would be granted-but-refused by the configured intersection.
	const config = configMod.loadMcpConfig(utilsMod.getConfigPathFromArgv(), cwd ?? process.cwd());
	const configuredNames = Object.keys(config.mcpServers ?? {});
	const settings = readPersistentRoomMcpSettings(roomId);
	const granted = new Set(effectiveGrantedMcpConnectors(settings.grantedConnectors, configuredNames));
	const prefixMode: PrefixMode = config.settings?.toolPrefix ?? "server";
	return { granted, configuredNames, config, prefixMode, storedGrantedConnectors: settings.grantedConnectors };
}

interface CachedToolMetadataLike {
	name: string;
	originalName?: string;
	description?: string;
	inputSchema?: unknown;
	resourceUri?: string;
}

/**
 * Per-server tool metadata reconstructed from the on-disk cache, honoring
 * the adapter's own validity rules (configHash + age): an entry the adapter
 * would not load into live metadata must not drive attribution here either.
 */
async function cachedMetadataByServer(context: RoomGrantContext): Promise<Map<string, CachedToolMetadataLike[]>> {
	const cacheMod = await import(ADAPTER_CACHE);
	const cache = cacheMod.loadMetadataCache();
	const byServer = new Map<string, CachedToolMetadataLike[]>();
	if (!cache?.servers) return byServer;
	for (const serverName of context.configuredNames) {
		const entry = cache.servers[serverName];
		const definition = context.config.mcpServers[serverName];
		if (!entry || !definition) continue;
		try {
			if (!cacheMod.isServerCacheValid(entry, definition)) continue;
			byServer.set(serverName, cacheMod.reconstructToolMetadata(serverName, entry, context.prefixMode, definition));
		} catch {
			// a malformed cache entry owns nothing
		}
	}
	return byServer;
}

function metadataToolMatch(metadata: CachedToolMetadataLike[] | undefined, toolName: string): CachedToolMetadataLike | undefined {
	if (!metadata) return undefined;
	const exact = metadata.find((tool) => tool.name === toolName);
	if (exact) return exact;
	const normalized = toolName.replace(/-/g, "_");
	return metadata.find((tool) => tool.name.replace(/-/g, "_") === normalized);
}

/**
 * Owners of a (possibly prefixed) tool name according to the VALID on-disk
 * metadata cache, in config order. Mirrors the adapter's findToolByName
 * matching (exact, then dash/underscore-normalized).
 */
async function cachedToolOwners(context: RoomGrantContext, toolName: string): Promise<string[]> {
	const byServer = await cachedMetadataByServer(context);
	const owners: string[] = [];
	for (const serverName of context.configuredNames) {
		if (metadataToolMatch(byServer.get(serverName), toolName)) owners.push(serverName);
	}
	return owners;
}

/** Granted servers whose tool prefix matches the name, longest prefix first. */
async function grantedPrefixCandidates(context: RoomGrantContext, toolName: string): Promise<string[]> {
	if (context.prefixMode === "none") return [];
	const typesMod = await import(ADAPTER_TYPES);
	return context.configuredNames
		.filter((serverName) => context.granted.has(serverName))
		.map((serverName) => ({ serverName, prefix: String(typesMod.getServerPrefix(serverName, context.prefixMode)) }))
		.filter((candidate) => candidate.prefix && toolName.startsWith(`${candidate.prefix}_`))
		.sort((a, b) => b.prefix.length - a.prefix.length)
		.map((candidate) => candidate.serverName);
}

/** Errors after which the adapter's own candidate loop would keep looking. */
const TRY_NEXT_CANDIDATE_ERRORS = new Set([
	"tool_not_found",
	"tool_not_found_after_reconnect",
	"server_not_found",
	"server_backoff",
	"server_not_connected",
	"connect_failed",
]);

function detailsErrorOf(result: ProxyToolResultLike): string | undefined {
	const error = result.details?.error;
	return typeof error === "string" ? error : undefined;
}

function detailsServerOf(result: ProxyToolResultLike): string | undefined {
	const server = result.details?.server;
	return typeof server === "string" ? server : undefined;
}

/**
 * Result sanitation, the last line of the wrapper: a delegated answer that
 * names an ungranted server is replaced wholesale. The replacement is
 * deliberately NEUTRAL: here the server name came from the ADAPTER's own
 * resolution, not from the model, so echoing it would leak an ungranted
 * connector's name into the conversation.
 */
function sanitizedRefusalResult(): ProxyToolResultLike {
	return refusalResult(
		`That answer involves a connector that is not enabled for this room. ${ROOM_SETTINGS_SENTENCE}`,
		{ error: "connector_not_enabled" },
	);
}

function sanitizeDelegatedResult(result: ProxyToolResultLike, granted: Set<string>): ProxyToolResultLike {
	const server = detailsServerOf(result);
	if (server && !granted.has(server)) return sanitizedRefusalResult();
	return result;
}

/** The adapter's own status line format, rebuilt over the granted subset. */
function rebuildStatusResult(result: ProxyToolResultLike, granted: Set<string>): ProxyToolResultLike {
	// A non-status answer (initialization failure, for example) passes through
	// the normal sanitation instead of being mistaken for an empty server list.
	if (result.details?.mode !== "status") return sanitizeDelegatedResult(result, granted);
	const allServers = Array.isArray(result.details?.servers) ? (result.details?.servers as Array<{ name: string; status: string; toolCount: number; failedAgo: number | null }>) : [];
	const servers = allServers.filter((server) => granted.has(String(server?.name ?? "")));
	if (servers.length === 0) return noConnectorsEnabledResult();
	const totalTools = servers.reduce((sum, server) => sum + (server.toolCount ?? 0), 0);
	const connectedCount = servers.filter((server) => server.status === "connected").length;
	let text = `MCP: ${connectedCount}/${servers.length} servers, ${totalTools} tools\n\n`;
	for (const server of servers) {
		if (server.status === "connected") text += `✓ ${server.name} (${server.toolCount} tools)\n`;
		else if (server.status === "needs-auth") text += `⚠ ${server.name} (needs auth)\n`;
		else if (server.status === "cached") text += `○ ${server.name} (${server.toolCount} tools, cached)\n`;
		else if (server.status === "failed") text += `✗ ${server.name} (failed ${server.failedAgo ?? 0}s ago)\n`;
		else text += `○ ${server.name} (not connected)\n`;
	}
	text += `\nmcp({ server: "name" }) to list tools, mcp({ search: "..." }) to search`;
	return {
		content: [{ type: "text", text: text.trim() }],
		details: { mode: "status", servers, totalTools, connectedCount },
	};
}

/** Search errors that are query-shaped, identical whichever server answers. */
const SEARCH_QUERY_ERRORS = new Set(["query_too_long", "unsafe_pattern", "invalid_pattern", "empty_query"]);

function mergeSearchResults(results: ProxyToolResultLike[], query: string): ProxyToolResultLike {
	const matches: unknown[] = [];
	const texts: string[] = [];
	for (const result of results) {
		const count = typeof result.details?.count === "number" ? (result.details.count as number) : 0;
		if (count <= 0) continue;
		matches.push(...(Array.isArray(result.details?.matches) ? (result.details?.matches as unknown[]) : []));
		const text = result.content?.[0]?.text ?? "";
		if (text) texts.push(text);
	}
	if (matches.length === 0) {
		return {
			content: [{ type: "text", text: `No tools matching "${query}"` }],
			details: { mode: "search", matches: [], count: 0, query },
		};
	}
	return {
		content: [{ type: "text", text: texts.join("\n\n") }],
		details: { mode: "search", matches, count: matches.length, query },
	};
}

/** The adapter's describe answer, rebuilt from granted cached metadata. */
async function describeFromGrantedCache(context: RoomGrantContext, toolName: string): Promise<ProxyToolResultLike | null> {
	const byServer = await cachedMetadataByServer(context);
	for (const serverName of context.configuredNames) {
		if (!context.granted.has(serverName)) continue;
		const toolMeta = metadataToolMatch(byServer.get(serverName), toolName);
		if (!toolMeta) continue;
		const toolMetadataMod = await import(ADAPTER_TOOL_METADATA);
		let text = `${toolMeta.name}\n`;
		text += `Server: ${serverName}\n`;
		if (toolMeta.resourceUri) text += `Type: Resource (reads from ${toolMeta.resourceUri})\n`;
		text += `\n${toolMeta.description || "(no description)"}\n`;
		if (toolMeta.inputSchema && !toolMeta.resourceUri) text += `\nParameters:\n${toolMetadataMod.formatSchema(toolMeta.inputSchema)}`;
		else if (toolMeta.resourceUri) text += `\nNo parameters required (resource tool).`;
		else text += `\nNo parameters defined.`;
		return {
			content: [{ type: "text", text: text.trim() }],
			details: { mode: "describe", tool: toolMeta, server: serverName },
		};
	}
	return null;
}

export interface RoomScopeExecuteOptions {
	/** The session's registered tools, for the adapter's native-tool redirect hint. */
	getAllTools?: () => Array<{ name: string }>;
}

function createRoomScopedProxyExecute(roomId: string, originalExecute: ProxyExecute, executeOptions: RoomScopeExecuteOptions = {}): ProxyExecute {
	return async (toolCallId, params, signal, onUpdate, ctx) => {
		const sessionCwd = typeof (ctx as { cwd?: unknown } | undefined)?.cwd === "string" ? (ctx as { cwd: string }).cwd : undefined;
		const context = await loadRoomGrantContext(roomId, sessionCwd);
		const granted = context.granted;
		const delegate = async (overrides: Partial<McpProxyParams> = {}): Promise<ProxyToolResultLike> => {
			const result = await originalExecute(toolCallId, { ...params, ...overrides }, signal, onUpdate, ctx);
			return sanitizeDelegatedResult(result, granted);
		};

		// Mode precedence mirrors the adapter exactly:
		// action > tool (call) > connect > describe > search > server (list) > status.
		if (params.action === "ui-messages") {
			// UI sessions only ever accumulate from this session's own granted
			// calls; draining them is not a server operation.
			return delegate();
		}
		if (params.action === "auth-start" || params.action === "auth-complete") {
			// Missing server falls through: the adapter's own usage error answers.
			if (params.server && !granted.has(params.server)) return connectorNotEnabledResult(params.server);
			return delegate();
		}
		if (params.tool) {
			if (params.server) {
				if (!granted.has(params.server)) return connectorNotEnabledResult(params.server);
				return delegate();
			}
			// Unqualified call: resolve the owner OURSELVES (valid cache first,
			// then granted prefix candidates) and always delegate with an
			// explicit server, so the adapter's cross-server scan never touches
			// an ungranted connector on the room's behalf. Prefix candidates run
			// even when the cache attributes the name only to ungranted servers:
			// a granted connector with a stale or missing cache entry may still
			// own the tool, and refusing without trying it would deny granted
			// capability on cache freshness alone.
			const owners = await cachedToolOwners(context, params.tool);
			const grantedOwner = owners.find((owner) => granted.has(owner));
			if (grantedOwner) return delegate({ server: grantedOwner });
			const candidates = await grantedPrefixCandidates(context, params.tool);
			let lastResult: ProxyToolResultLike | null = null;
			for (const candidate of candidates) {
				const result = await delegate({ server: candidate });
				const error = detailsErrorOf(result);
				if (!error || !TRY_NEXT_CANDIDATE_ERRORS.has(error)) return result;
				lastResult = result;
			}
			// A tried granted candidate's real failure beats a blanket refusal.
			if (lastResult) return lastResult;
			if (owners.length > 0) {
				return refusalResult(
					`Tool "${params.tool}" belongs to a connector that is not enabled for this room. ${ROOM_SETTINGS_SENTENCE}`,
					{ mode: "call", error: "connector_not_enabled", requestedTool: params.tool },
				);
			}
			// The adapter's native-tool redirect, preserved for rooms.
			const nativeTool = executeOptions.getAllTools?.().find((registered) => registered.name === params.tool && registered.name !== "mcp");
			if (nativeTool) {
				return refusalResult(`"${params.tool}" is a native Pi tool. Call ${params.tool} directly instead of using mcp({ tool: "${params.tool}" }).`, {
					mode: "call",
					error: "native_tool",
					requestedTool: params.tool,
				});
			}
			return refusalResult(`Tool "${params.tool}" not found. Use mcp({ search: "..." }) to search.`, {
				mode: "call",
				error: "tool_not_found",
				requestedTool: params.tool,
			});
		}
		if (params.connect) {
			if (!granted.has(params.connect)) return connectorNotEnabledResult(params.connect);
			return delegate();
		}
		if (params.describe) {
			// Read-only in the adapter (no lazy connect), but executeDescribe has
			// no server parameter and answers with its FIRST match across all
			// servers - which can be an ungranted namesake of a granted tool. So:
			// delegate for the common case (freshest metadata), and when the
			// adapter's answer names an ungranted owner, re-resolve from the
			// room's granted cached metadata instead of destroying the describe.
			// The neutral fallback never names the ungranted server.
			const delegated = await originalExecute(toolCallId, params, signal, onUpdate, ctx);
			const answeredServer = detailsServerOf(delegated);
			if (!answeredServer || granted.has(answeredServer)) return delegated;
			const grantedDescribe = await describeFromGrantedCache(context, params.describe);
			if (grantedDescribe) return grantedDescribe;
			return refusalResult(
				`Tool "${params.describe}" is not available in this room. ${ROOM_SETTINGS_SENTENCE}`,
				{ mode: "describe", error: "connector_not_enabled", requestedTool: params.describe },
			);
		}
		if (params.search) {
			if (params.server) {
				if (!granted.has(params.server)) return connectorNotEnabledResult(params.server);
				return delegate();
			}
			if (granted.size === 0) return noConnectorsEnabledResult();
			// Fan the unscoped search out per granted connector and merge, so the
			// adapter's all-servers scan never surfaces an ungranted tool.
			const results: ProxyToolResultLike[] = [];
			for (const serverName of context.configuredNames) {
				if (!granted.has(serverName)) continue;
				const result = await delegate({ server: serverName });
				const error = detailsErrorOf(result);
				if (error && SEARCH_QUERY_ERRORS.has(error)) return result;
				results.push(result);
			}
			return mergeSearchResults(results, params.search);
		}
		if (params.server) {
			if (!granted.has(params.server)) return connectorNotEnabledResult(params.server);
			return delegate();
		}
		// Status: delegate (read-only), then rebuild the answer over the granted
		// subset in the adapter's own format.
		const statusResult = await originalExecute(toolCallId, params, signal, onUpdate, ctx);
		return rebuildStatusResult(statusResult, granted);
	};
}

/**
 * Filtered proxy-tool description: what the model SEES in its tool manifest
 * speaks only of granted connectors. Built from the same config + cache the
 * adapter's own description uses, computed at registration time (the web
 * server rebinds the room session when grants change, so it stays current).
 * `onBoundGrants` receives the fingerprint of the grant list THIS read used,
 * so the caller's drift detection can never race a concurrent grant edit.
 */
export async function buildRoomScopedProxyDescription(roomId: string, onBoundGrants?: (fingerprint: string) => void): Promise<string> {
	const [context, cacheMod, directToolsMod] = await Promise.all([
		loadRoomMcpGrantContextSafe(roomId),
		import(ADAPTER_CACHE),
		import(ADAPTER_DIRECT_TOOLS),
	]);
	try {
		onBoundGrants?.(mcpGrantsFingerprint(context.storedGrantedConnectors));
	} catch {
		// fingerprint reporting must never break registration
	}
	const grantedServers: Record<string, Record<string, unknown>> = {};
	for (const serverName of context.configuredNames) {
		if (context.granted.has(serverName)) grantedServers[serverName] = context.config.mcpServers[serverName];
	}
	const cache = cacheMod.loadMetadataCache();
	const filteredCache = cache
		? { ...cache, servers: Object.fromEntries(Object.entries(cache.servers ?? {}).filter(([serverName]) => context.granted.has(serverName))) }
		: null;
	const description = String(directToolsMod.buildProxyDescription({ ...context.config, mcpServers: grantedServers }, filteredCache, []));
	if (context.granted.size === 0) {
		return `${description}\n\nNo MCP connectors are enabled for this room. ${ROOM_SETTINGS_SENTENCE}`;
	}
	return description;
}

async function loadRoomMcpGrantContextSafe(roomId: string, cwd?: string): Promise<RoomGrantContext> {
	try {
		return await loadRoomGrantContext(roomId, cwd);
	} catch {
		return { granted: new Set(), configuredNames: [], config: { mcpServers: {} }, prefixMode: "server", storedGrantedConnectors: [] };
	}
}

/**
 * The REAL owner of every registered direct tool, by registered tool name.
 * Rebuilt with the adapter's own spec resolution (same config path, cache,
 * prefix mode and MCP_DIRECT_TOOLS parsing its factory uses), so attribution
 * is the spec's serverName - never re-derived from the tool NAME, whose
 * prefix is ambiguous ("foo_bar_baz" could be foo's "bar_baz" or foo-bar's
 * "baz") and absent entirely under toolPrefix "none".
 */
async function directToolSpecServers(): Promise<Map<string, string>> {
	const byRegisteredName = new Map<string, string>();
	try {
		const [configMod, cacheMod, directToolsMod, utilsMod] = await Promise.all([
			import(ADAPTER_CONFIG),
			import(ADAPTER_CACHE),
			import(ADAPTER_DIRECT_TOOLS),
			import(ADAPTER_UTILS),
		]);
		const config = configMod.loadMcpConfig(utilsMod.getConfigPathFromArgv());
		const cache = cacheMod.loadMetadataCache();
		const prefix: PrefixMode = config.settings?.toolPrefix ?? "server";
		const envRaw = process.env.MCP_DIRECT_TOOLS;
		const specs: Array<{ prefixedName: string; serverName: string }> = envRaw === "__none__"
			? []
			: directToolsMod.resolveDirectTools(config, cache, prefix, envRaw?.split(",").map((item: string) => item.trim()).filter(Boolean));
		for (const spec of specs) byRegisteredName.set(spec.prefixedName, spec.serverName);
	} catch {
		// no attribution -> no direct tools for rooms (conservative)
	}
	return byRegisteredName;
}

export type RoomMcpMigrationSkipReason = "marker" | "unreadable-config";

export interface RoomMcpMigrationResult {
	migrated: string[];
	skipped: RoomMcpMigrationSkipReason | null;
}

/**
 * The update-day migration, callable from EVERY room door (web-server boot,
 * CLI room registration): whichever surface boots first migrates, and the
 * marker makes the race converge. The adapter's loadMcpConfig silently
 * degrades a corrupt config file to "no servers", which would make this
 * migration grant every legacy room an EMPTY list and stamp the irreversible
 * marker - so before migrating, every existing discovery-path config file
 * must parse, and every connector name a file literally defines must appear
 * in the merged config. Any mismatch aborts WITHOUT the marker; the next
 * boot retries.
 */
export async function ensureRoomScopedMcpGrantsMigration(options: PersistentRoomMcpSettingsStorageOptions = {}): Promise<RoomMcpMigrationResult> {
	if (!persistentRoomMcpGrantsMigrationPending(options)) return { migrated: [], skipped: "marker" };
	ensureAgentDirEnv();
	const [configMod, utilsMod] = await Promise.all([import(ADAPTER_CONFIG), import(ADAPTER_UTILS)]);
	const overridePath = utilsMod.getConfigPathFromArgv();
	const definedNames = new Set<string>();
	const declaredImportKinds = new Set<string>();
	const discoveryPaths: Array<{ path: string; exists: boolean }> = configMod.getConfigDiscoveryPaths(overridePath);
	for (const source of discoveryPaths) {
		if (!source.exists) continue;
		let parsed: unknown;
		try {
			parsed = JSON.parse(fs.readFileSync(source.path, "utf-8"));
		} catch {
			return { migrated: [], skipped: "unreadable-config" };
		}
		if (!parsed || typeof parsed !== "object") return { migrated: [], skipped: "unreadable-config" };
		const record = parsed as Record<string, unknown>;
		// Mirror the adapter's validateConfig EXACTLY: `mcpServers ?? mcp-servers`,
		// second key ignored when the first is present, non-object shapes read as
		// no servers. Names the adapter itself would drop must not count as
		// expected, or a valid dual-key file would abort the migration forever.
		const serversValue = record.mcpServers ?? record["mcp-servers"];
		if (serversValue && typeof serversValue === "object" && !Array.isArray(serversValue)) {
			for (const name of Object.keys(serversValue)) definedNames.add(name);
		}
		if (Array.isArray(record.imports)) {
			for (const kind of record.imports) {
				if (typeof kind === "string" && kind) declaredImportKinds.add(kind);
			}
		}
	}
	// The imports mechanism (Cursor/Claude/etc compatibility files) is the
	// other silent-drop path: expandImports answers a parse failure with a
	// console.warn and simply loses that file's servers from the merged
	// config. Symmetric guard: every EXISTING import file a discovery config
	// declares must parse, or the migration aborts without the marker.
	if (declaredImportKinds.size > 0) {
		const availableImports: Array<{ kind: string; path: string }> = configMod.findAvailableImportConfigs();
		for (const entry of availableImports) {
			if (!declaredImportKinds.has(entry.kind)) continue;
			let parsedImport: unknown;
			try {
				parsedImport = JSON.parse(fs.readFileSync(entry.path, "utf-8"));
			} catch {
				return { migrated: [], skipped: "unreadable-config" };
			}
			if (!parsedImport || typeof parsedImport !== "object") return { migrated: [], skipped: "unreadable-config" };
		}
	}
	const merged = configMod.loadMcpConfig(overridePath);
	const configuredNames: string[] = Object.keys(merged.mcpServers ?? {});
	const configuredSet = new Set(configuredNames);
	for (const name of definedNames) {
		if (!configuredSet.has(name)) return { migrated: [], skipped: "unreadable-config" };
	}
	return { migrated: ensurePersistentRoomMcpGrantsMigration(configuredNames, options), skipped: null };
}

/**
 * Cold-cache session preparation for a room (owner decision 2026-08-11, the
 * middle path): when the adapter's metadata cache file does not exist yet,
 * its session start would bootstrap-connect EVERY configured server once to
 * warm the cache - ungranted ones included. Instead, create the cache file
 * empty (which switches that bootstrap off) and warm ONLY the room's granted
 * connectors ourselves, bounded per server. Best-effort throughout: a failed
 * warm-up just leaves the server to the adapter's lazy connect on first use.
 * Eager/keep-alive lifecycles are deliberately untouched.
 */
export async function prepareRoomScopedMcpSessionCache(roomId: string): Promise<void> {
	try {
		ensureAgentDirEnv();
		const cacheMod = await import(ADAPTER_CACHE);
		const cachePath: string = cacheMod.getMetadataCachePath();
		if (fs.existsSync(cachePath)) return;
		cacheMod.saveMetadataCache({ version: 1, servers: {} });
		const context = await loadRoomMcpGrantContextSafe(roomId);
		if (context.granted.size === 0) return;
		const managerMod = await import(ADAPTER_SERVER_MANAGER);
		const manager = new managerMod.McpServerManager();
		const entries: Record<string, unknown> = {};
		await Promise.all(
			[...context.granted].map(async (serverName) => {
				const definition = context.config.mcpServers[serverName];
				if (!definition) return;
				let timer: ReturnType<typeof setTimeout> | undefined;
				try {
					const connection = await Promise.race([
						manager.connect(serverName, definition),
						new Promise<never>((_, reject) => {
							timer = setTimeout(() => reject(new Error("warm-up timeout")), 8000);
						}),
					]);
					if (connection?.status !== "connected") return;
					entries[serverName] = {
						configHash: cacheMod.computeServerHash(definition),
						tools: cacheMod.serializeTools(connection.tools ?? []),
						resources: cacheMod.serializeResources(connection.resources ?? []),
						cachedAt: Date.now(),
					};
				} catch {
					// lazy connect covers this server on first use
				} finally {
					if (timer) clearTimeout(timer);
				}
			}),
		);
		try {
			await manager.closeAll();
		} catch {
			// already closed / never opened
		}
		if (Object.keys(entries).length > 0) {
			const cache = cacheMod.loadMetadataCache() ?? { version: 1, servers: {} };
			cache.servers = { ...cache.servers, ...entries };
			cacheMod.saveMetadataCache(cache);
		}
	} catch {
		// warm-up is best-effort; enforcement never depends on it
	}
}

export interface RoomScopeRegistrationOptions extends RoomScopeExecuteOptions {
	/**
	 * Reports the grants fingerprint the proxy description was actually built
	 * from, so bind-time drift detection compares against the SAME read.
	 */
	onBoundGrants?: (fingerprint: string) => void;
}

/**
 * Room-scope a tool the adapter registers. The `mcp` proxy tool gets the
 * gated execute above plus the filtered description; a per-server direct
 * tool is dropped when its connector is not granted at registration time and
 * keeps a live per-call grant check either way. Returns null when the tool
 * must not be registered for this room.
 */
export async function roomScopedMcpToolRegistration(roomId: string, tool: RegisteredToolLike, options: RoomScopeRegistrationOptions = {}): Promise<RegisteredToolLike | null> {
	if (tool.name === "mcp") {
		const originalExecute = tool.execute as unknown as ProxyExecute;
		return {
			...tool,
			description: await buildRoomScopedProxyDescription(roomId, options.onBoundGrants),
			execute: createRoomScopedProxyExecute(roomId, originalExecute, options) as unknown as RegisteredToolLike["execute"],
		};
	}
	// Direct tools: gated by the registration's REAL spec server. A tool the
	// spec resolution cannot attribute is not exposed to a room at all.
	const [context, specServers] = await Promise.all([loadRoomMcpGrantContextSafe(roomId), directToolSpecServers()]);
	const serverName = specServers.get(tool.name) ?? null;
	if (!serverName || !context.granted.has(serverName)) return null;
	const originalExecute = tool.execute;
	return {
		...tool,
		execute: async (...args: unknown[]) => {
			const liveContext = await loadRoomMcpGrantContextSafe(roomId);
			if (!liveContext.granted.has(serverName)) return connectorNotEnabledResult(serverName);
			return originalExecute(...args);
		},
	};
}
