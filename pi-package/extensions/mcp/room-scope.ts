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
 *    those servers into background connections);
 *  - what a tool may DO is asked: a connector tool runs by itself only when
 *    the connection that will run it marks it read-only, it is a plain
 *    resource read, or the room was allowed that web connector's tool for
 *    itself; anything else stops on the room's question
 *    (askBeforeConnectorCall, called by the adapter right before it reaches
 *    the connector, scripts/patch-mcp-adapter.mjs patch 12);
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
 * A room's connectors are the ones in the person's own settings
 * (~/.config/mcp/mcp.json, ~/.exxperts/agent/mcp.json), never a connector file
 * in the room's folder: every config read for a room, the adapter's own session
 * load included, resolves the folder-relative files (`.mcp.json`,
 * `.pi/mcp.json`, a `.vscode/mcp.json` import) against roomConnectorConfigCwd().
 *
 * Wording rule (product): refusals say the room's settings "control which
 * connectors this room can use" - never more than that.
 */

import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { stateHome } from "../../product-state-paths.js";
import {
	allowedToolsOf,
	allowPersistentRoomMcpTool,
	type AllowedConnectorTools,
	connectorAddressPin,
	effectiveGrantedMcpConnectors,
	ensurePersistentRoomMcpGrantsMigration,
	forgetPersistentRoomMcpTool,
	mcpGrantsFingerprint,
	persistentRoomMcpGrantsMigrationPending,
	readPersistentRoomMcpSettings,
	type PersistentRoomMcpSettingsStorageOptions,
} from "../../../apps/web-server/src/persistent-room-mcp-settings.js";
import { connectorApprovalSubject, connectorApprovalTitle } from "../../../apps/web-server/src/room-approval-titles.js";
import { isSharedServer } from "../../../apps/web-server/src/server-hooks.js";
import type { ConnectorApply, ConnectorCard } from "../../../apps/web-server/src/web-ui-context.js";
import { scanInvisibleUnicode } from "../../../apps/web-server/src/skills-import.js";
import { classifyAddress } from "../fetch_url/address-class.js";
import { CONNECTOR_CATALOG } from "./connector-catalog.js";

// Non-literal specifiers keep tsc from resolving the adapter's raw .ts
// sources (same pattern as index.ts).
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
	isError?: boolean;
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
	/** The room's lasting yeses as stored, by connector. */
	allowedTools: AllowedConnectorTools;
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
		process.env.PI_CODING_AGENT_DIR = path.join(stateHome(), ".exxperts", "agent");
	}
}

function refusalResult(text: string, details: Record<string, unknown>): ProxyToolResultLike {
	return { content: [{ type: "text", text }], details, isError: true };
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
 * The folder a room's connector config is read against, in place of its working
 * folder. The adapter reads `.mcp.json`, `.pi/mcp.json` and a `.vscode/mcp.json`
 * import relative to the folder it is given; this one sits in the person's own
 * state and is never created, so a room sees only the connectors from the
 * person's settings. It is used for config discovery only: a connector still
 * starts in its own `cwd`, or else in the process's working folder.
 */
export function roomConnectorConfigCwd(): string {
	return path.join(stateHome(), ".exxperts", "agent", "room-connectors");
}

interface AdapterModules {
	configMod: any;
	utilsMod: any;
	typesMod: any;
}

async function adapterModules(): Promise<AdapterModules> {
	ensureAgentDirEnv();
	const [configMod, utilsMod, typesMod] = await Promise.all([import(ADAPTER_CONFIG), import(ADAPTER_UTILS), import(ADAPTER_TYPES)]);
	return { configMod, utilsMod, typesMod };
}

async function loadRoomGrantContext(roomId: string): Promise<RoomGrantContext> {
	return roomGrantContextFrom(await adapterModules(), roomId);
}

/** The room's grants read now, with the modules already loaded: nothing here waits, so a card's answer can read them in the same step as it stores. */
function roomGrantContextFrom({ configMod, utilsMod }: AdapterModules, roomId: string): RoomGrantContext {
	// Same baseline as the adapter's own session load for a room: the
	// --mcp-config argv override (which the adapter factory and
	// directToolSpecServers honor) plus the person's global files - otherwise a
	// connector defined only in the override file would be granted-but-refused
	// by the configured intersection.
	const config = configMod.loadMcpConfig(utilsMod.getConfigPathFromArgv(), roomConnectorConfigCwd());
	const configuredNames = Object.keys(config.mcpServers ?? {});
	const settings = readPersistentRoomMcpSettings(roomId);
	const granted = new Set(effectiveGrantedMcpConnectors(settings.grantedConnectors, configuredNames));
	const prefixMode: PrefixMode = config.settings?.toolPrefix ?? "server";
	return { granted, configuredNames, config, prefixMode, storedGrantedConnectors: settings.grantedConnectors, allowedTools: settings.allowedTools };
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

/** What the adapter hands the gate at the moment it would reach the connector (scripts/patch-mcp-adapter.mjs, patch 12). */
interface ConnectorCall {
	server: string;
	/** The tool's own name on the connector. */
	toolName: string;
	/** The tool as the connection that will run it listed it; none when it did not. */
	liveTool?: { annotations?: { readOnlyHint?: unknown; destructiveHint?: unknown } | null };
	resourceRead: boolean;
	args: unknown;
}

type ConnectorCallGate = (call: ConnectorCall) => Promise<ProxyToolResultLike | undefined>;

/** A call that ran on the room's kept yes carries the person's words for it ("Create task in Asana"), as a refused call does: the page's step row reads them, and the model never sees details. */
function withRoomYesWords<T extends ProxyToolResultLike>(result: T, use: string | undefined): T {
	return use && !result.isError ? { ...result, details: { ...(result.details ?? {}), use } } : result;
}

interface ConnectorCardContext {
	ui?: { askConnector?(card: ConnectorCard, apply: ConnectorApply): Promise<"once" | "room" | "decline"> };
}

const CARD_ARGS_MAX_CHARS = 1_200;
const CARD_NAME_MAX_CHARS = 80;

/** Characters a person can't see, written out: a page or a model can hide words in them. */
function withHiddenCharactersShown(text: string): string {
	const controlsShown = text.replace(/[\u0000-\u001f\u007f-\u009f]/g, (character) => `[U+${character.charCodeAt(0).toString(16).toUpperCase().padStart(4, "0")}]`);
	let shown = "";
	let at = 0;
	for (const { index, codePoint, label } of scanInvisibleUnicode(controlsShown).findings) {
		shown += `${controlsShown.slice(at, index)}[${label}]`;
		at = index + (codePoint > 0xffff ? 2 : 1);
	}
	return shown + controlsShown.slice(at);
}

function cardName(text: string): string {
	const characters = Array.from(withHiddenCharactersShown(text.trim()));
	return characters.length > CARD_NAME_MAX_CHARS ? `${characters.slice(0, CARD_NAME_MAX_CHARS - 1).join("")}…` : characters.join("");
}

function connectorWords(server: string): string {
	return cardName(CONNECTOR_CATALOG.find((entry) => entry.id === server)?.name ?? server);
}

/** A tool's name as people read it: "delete_project" and "deleteProject" read "Delete project" and "Delete Project". */
export function connectorToolWords(toolName: string): string {
	const words = cardName(toolName.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/[_-]+/g, " "));
	return words.charAt(0).toUpperCase() + words.slice(1);
}

/** What the room would send, as the question shows it: one line of JSON with every hidden character written out, cut at its end. */
function sentShown(args: unknown): { sent: string; cut: number } {
	const sent = Array.from(withHiddenCharactersShown(JSON.stringify(args ?? {})));
	return { sent: sent.slice(0, CARD_ARGS_MAX_CHARS).join(""), cut: Math.max(0, sent.length - CARD_ARGS_MAX_CHARS) };
}

/** Names that are this computer by convention, whatever a lookup would say. */
const THIS_COMPUTER_NAMES = new Set(["localhost", "localhost.localdomain", "ip6-localhost", "ip6-loopback"]);

/**
 * Whether a connector's address is this computer: `localhost`, a `.localhost`
 * name or another reserved name for it, this computer's own network name (with
 * or without `.local`), or a loopback or unspecified IP in any spelling (the
 * classes the web reader and a room's commands refuse as local). What listens
 * there is a program on this computer, with the person's rights. Names are
 * never looked up, so a web name that leads back here still counts as web. An
 * address the URL parser can't read counts as this computer.
 */
function addressIsThisComputer(address: string): boolean {
	let host: string;
	try {
		host = new URL(address).hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.+$/, "");
	} catch {
		return true;
	}
	const ownName = os.hostname().toLowerCase().replace(/\.+$/, "").replace(/\.local$/, "");
	if (THIS_COMPUTER_NAMES.has(host) || host.endsWith(".localhost") || (ownName !== "" && (host === ownName || host === `${ownName}.local`))) return true;
	return net.isIP(host) !== 0 && ["loopback", "unspecified"].includes(classifyAddress(host));
}

/** A web connector's address; null for a program on this computer: one the adapter starts, whenever its entry names a command, or one listening at this computer's own address. */
function webAddressOf(definition: Record<string, unknown> | undefined): string | null {
	const url = definition && !definition.command && typeof definition.url === "string" ? definition.url : "";
	return url && !addressIsThisComputer(url) ? url : null;
}

/** Where a connector's entry says it is, as a question compares it before and after its answer. */
function connectorWhere(definition: Record<string, unknown> | undefined): string {
	return JSON.stringify([definition?.url ?? null, definition?.command ?? null, definition?.args ?? null]);
}

/** Where each connector is, by name (connectorWhere), as one read of the person's settings has them. */
export type ConnectorPlaces = ReadonlyMap<string, string>;

/**
 * A reader of the connector places that waits for nothing once made, so it can
 * run inside the adapter's own read of its settings (index.ts). It reads as the
 * adapter does, from the folder a room's settings are read against and the
 * given --mcp-config path. A read that fails knows no place, so it offers and
 * honours no lasting yes.
 */
export async function connectorPlacesReader(): Promise<(configPath: string | undefined) => ConnectorPlaces> {
	const { configMod } = await adapterModules();
	return (configPath) => {
		try {
			const servers: Record<string, Record<string, unknown>> = configMod.loadMcpConfig(configPath, roomConnectorConfigCwd()).mcpServers ?? {};
			return new Map(Object.entries(servers).map(([name, definition]) => [name, connectorWhere(definition)]));
		} catch {
			return new Map();
		}
	};
}

/**
 * The pin a lasting yes for this call is kept with, from the room's settings
 * as they are now; null where Allow for this room is neither offered nor
 * honoured: a shared server, a connector that is a program on this computer
 * (it runs with the person's rights, outside the room's protection), a tool
 * the live connection doesn't list or marks destructive, a connector no longer
 * enabled for the room, a tool switched off for it, or a connector whose entry
 * is no longer the one this session connected with: the adapter connects and
 * reconnects from its own read at the session's start, so the call still goes
 * there, and it asks as on any other call until the room is opened again.
 */
function roomYesPin(context: RoomGrantContext, typesMod: AdapterModules["typesMod"], call: ConnectorCall, connectedPlace: string | undefined): string | null {
	if (isSharedServer() || !call.liveTool || call.liveTool.annotations?.destructiveHint === true || !context.granted.has(call.server)) return null;
	const definition = context.config.mcpServers[call.server];
	if (connectedPlace === undefined || connectorWhere(definition) !== connectedPlace) return null;
	const address = webAddressOf(definition);
	if (address === null || typesMod.isToolExcluded(call.toolName, call.server, context.prefixMode, definition?.excludeTools)) return null;
	return connectorAddressPin(address);
}

/** A yes for a tool of this connector that is excluded now is dropped, so taking the exclusion away again asks. Never on a shared server, which keeps no yes. */
function dropExcludedYeses(roomId: string, context: RoomGrantContext, typesMod: AdapterModules["typesMod"], server: string): void {
	if (isSharedServer()) return;
	const excludeTools = context.config.mcpServers[server]?.excludeTools;
	for (const { tool } of allowedToolsOf(context.allowedTools, server)) {
		if (typesMod.isToolExcluded(tool, server, context.prefixMode, excludeTools)) forgetPersistentRoomMcpTool(roomId, server, tool);
	}
}

/**
 * The pin read now, whether the room already allowed this tool at it, and
 * where the connector is. A read that fails offers and honours nothing.
 */
function roomYesNow(modules: AdapterModules, roomId: string, call: ConnectorCall, connectedPlace: string | undefined): { pin: string | null; allowed: boolean; where: string | null } {
	try {
		const context = roomGrantContextFrom(modules, roomId);
		const pin = roomYesPin(context, modules.typesMod, call, connectedPlace);
		const allowed = pin !== null && allowedToolsOf(context.allowedTools, call.server).some((entry) => entry.tool === call.toolName && entry.addressPin === pin);
		return { pin, allowed, where: connectorWhere(context.config.mcpServers[call.server]) };
	} catch {
		return { pin: null, allowed: false, where: null };
	}
}

/** Read-only and not destructive, in the protocol's own true and false; anything else is unknown, and unknown asks. */
function connectorMarksReadOnly(tool: ConnectorCall["liveTool"]): boolean {
	const marks = tool?.annotations;
	return marks?.readOnlyHint === true && (marks.destructiveHint === undefined || marks.destructiveHint === false);
}

/** A card can wait for a long time: what was allowed when it opened, and where the connector was, is read again. A read that fails withdraws. */
async function connectorCallWithdrawn(roomId: string, call: ConnectorCall, askedWhere: string | null): Promise<ProxyToolResultLike | undefined> {
	try {
		const context = await loadRoomGrantContext(roomId);
		if (!context.granted.has(call.server)) return connectorNotEnabledResult(call.server);
		if (connectorWhere(context.config.mcpServers[call.server]) !== askedWhere) {
			return refusalResult(
				`Connector "${call.server}" was moved to another address while this waited, so it did not run.`,
				{ mode: "call", error: "connector_moved", server: call.server },
			);
		}
		const typesMod = await import(ADAPTER_TYPES);
		if (!typesMod.isToolExcluded(call.toolName, call.server, context.prefixMode, context.config.mcpServers[call.server]?.excludeTools)) return undefined;
	} catch {
		return connectorNotEnabledResult(call.server);
	}
	return refusalResult(
		`Tool "${call.toolName}" was switched off for connector "${call.server}" while this waited, so it did not run.`,
		{ mode: "call", error: "connector_tool_withdrawn", server: call.server },
	);
}

/**
 * The gate: every connector call passes it right before it reaches the
 * connector. It answers nothing to let the call run, or the result to give the
 * model instead. A connector's marks are its own word about its own tools, so
 * they guard against a fooled model, not a bad connector.
 *
 * A tool the room was allowed for itself runs with no question, with nobody
 * there too: its yes is read on every call and holds only while roomYesPin
 * gives the pin it was stored with. Anything else asks. The answer Allow for
 * this room stores that yes before the question says answered, and only from
 * the computer, after the same reading; otherwise it counts as this time. Any
 * answer is refused as withdrawn when the connector was switched off, the tool
 * excluded or the connector moved while the question waited.
 *
 * Auto is not read here: it is about commands inside the box. With nobody there
 * the question rejects by itself, and whoever asked for it leaves the note: a
 * scheduled run's context, or the bridge when the person left or a view-only
 * phone took over. The rejection's words stay first, since the page reads a
 * stopped step by them (step-lines.ts). A refusal keeps what the card asked to
 * use in its details, the page's words for the step; the model never sees details.
 */
async function askBeforeConnectorCall(roomId: string, ctx: unknown, call: ConnectorCall, connectedPlace: string | undefined, ranOnYes?: (use: string) => void): Promise<ProxyToolResultLike | undefined> {
	const modules = await adapterModules();
	// Every call to the connector, a reading one too, drops the yeses of its tools excluded now.
	try {
		dropExcludedYeses(roomId, roomGrantContextFrom(modules, roomId), modules.typesMod, call.server);
	} catch {
		// A read that fails drops nothing; the yes is read again, and honoured only where the tool is not excluded.
	}
	if (call.resourceRead || connectorMarksReadOnly(call.liveTool)) return undefined;
	const before = roomYesNow(modules, roomId, call, connectedPlace);
	const connector = connectorWords(call.server);
	const title = connectorApprovalTitle(connectorToolWords(call.toolName), connector);
	const use = connectorApprovalSubject(title);
	if (before.allowed) {
		if (use) ranOnYes?.(use);
		return undefined;
	}
	const apply: ConnectorApply = (choice, answeredBy) => {
		if (choice !== "room" || answeredBy !== "computer" || before.pin === null) return "once";
		// Read again: the connector may have been switched off, the tool excluded or the address changed while this waited.
		if (roomYesNow(modules, roomId, call, connectedPlace).pin !== before.pin) return "once";
		return allowPersistentRoomMcpTool(roomId, call.server, call.toolName, before.pin) ? "room" : "once";
	};
	let choice: "once" | "room" | "decline";
	try {
		const ui = (ctx as ConnectorCardContext).ui;
		if (!ui?.askConnector) throw new Error("Nobody can answer a question here.");
		choice = await ui.askConnector({ title, connector, ...sentShown(call.args), lasting: before.pin !== null }, apply);
	} catch (error) {
		return refusalResult(
			`${error instanceof Error ? error.message : String(error)} Nothing was sent to ${connector}. Leave this undone and say so.`,
			{ mode: "call", error: "connector_call_unanswered", server: call.server, use },
		);
	}
	if (choice === "decline") {
		return refusalResult(
			`You declined this, so nothing changed in ${connector}. Don't try it again unless the person asks.`,
			{ mode: "call", error: "connector_call_declined", server: call.server, use },
		);
	}
	return connectorCallWithdrawn(roomId, call, before.where);
}

export interface RoomScopeExecuteOptions {
	/** The session's registered tools, for the adapter's native-tool redirect hint. */
	getAllTools?: () => Array<{ name: string }>;
	/** Where this session's connections are made from: the adapter's own read of the settings at the session's start (index.ts). Without it no lasting yes is offered or honoured. */
	connectedPlaces?: () => ConnectorPlaces | undefined;
}

/**
 * The adapter answers a refusal with `details.error` and no error flag; the
 * room's card and the model read failures by the flag, so it is set here.
 */
function withErrorFlag(result: ProxyToolResultLike): ProxyToolResultLike {
	return detailsErrorOf(result) && !result.isError ? { ...result, isError: true } : result;
}

/**
 * The adapter meets a connector's sign-in refusal while it sets the connection
 * up, outside the step that reports "needs-auth" (pi-mcp-adapter's
 * server-manager.ts), so it answers with a failed connection, and with a
 * back-off for the calls that follow. Both are read as the sign-in they are.
 */
const SIGN_IN_REFUSAL = /Re-authentication required for MCP server|requires OAuth authentication/i;
const signInFailedAt = new Map<string, number>();

function asSignIn(result: ProxyToolResultLike, params: McpProxyParams): ProxyToolResultLike {
	const error = detailsErrorOf(result);
	if (error !== "connect_failed" && error !== "server_backoff") return result;
	const text = result.content?.[0]?.text ?? "";
	const server = detailsServerOf(result) ?? /MCP server: (\S+)/.exec(text)?.[1] ?? params.server ?? params.connect;
	if (!server) return result;
	if (SIGN_IN_REFUSAL.test(text)) signInFailedAt.set(server, Date.now());
	else {
		// A back-off names how long ago the failure it waits on happened: the remembered sign-in, or another one.
		const ago = Number(/\(last failed (\d+)s ago\)/.exec(text)?.[1]);
		const failedAt = signInFailedAt.get(server);
		if (error !== "server_backoff" || failedAt === undefined || !Number.isFinite(ago) || Math.abs((Date.now() - failedAt) / 1000 - ago) > 2) return result;
	}
	return refusalResult(`Connector "${server}" needs a sign-in before this room can use it. Tell the person; the sign-in happens outside this conversation.`, { mode: result.details?.mode, error: "auth_required", server });
}

function createRoomScopedProxyExecute(roomId: string, originalExecute: ProxyExecute, executeOptions: RoomScopeExecuteOptions = {}): ProxyExecute {
	const scoped = createRoomScopedProxyAnswer(roomId, originalExecute, executeOptions);
	return async (toolCallId, params, signal, onUpdate, ctx) => withErrorFlag(asSignIn(await scoped(toolCallId, params, signal, onUpdate, ctx), params));
}

function createRoomScopedProxyAnswer(roomId: string, originalExecute: ProxyExecute, executeOptions: RoomScopeExecuteOptions): ProxyExecute {
	return async (toolCallId, params, signal, onUpdate, ctx) => {
		const context = await loadRoomGrantContext(roomId);
		const granted = context.granted;
		let ranOnYes: string | undefined;
		const gate: ConnectorCallGate = (call) => askBeforeConnectorCall(roomId, ctx, call, executeOptions.connectedPlaces?.()?.get(call.server), (use) => { ranOnYes = use; });
		const delegate = async (overrides: Partial<McpProxyParams> = {}): Promise<ProxyToolResultLike> => {
			ranOnYes = undefined;
			const result = await originalExecute(toolCallId, { ...params, ...overrides }, signal, onUpdate, gate);
			return withRoomYesWords(sanitizeDelegatedResult(result, granted), ranOnYes);
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

async function loadRoomMcpGrantContextSafe(roomId: string): Promise<RoomGrantContext> {
	try {
		return await loadRoomGrantContext(roomId);
	} catch {
		return { granted: new Set(), configuredNames: [], config: { mcpServers: {} }, prefixMode: "server", storedGrantedConnectors: [], allowedTools: {} };
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
		const config = configMod.loadMcpConfig(utilsMod.getConfigPathFromArgv(), roomConnectorConfigCwd());
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
 * a room session's registration): whichever comes first migrates, and the
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
	const discoveryPaths: Array<{ path: string; exists: boolean }> = configMod.getConfigDiscoveryPaths(overridePath, roomConnectorConfigCwd());
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
		const availableImports: Array<{ kind: string; path: string }> = configMod.findAvailableImportConfigs(roomConnectorConfigCwd());
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
	const merged = configMod.loadMcpConfig(overridePath, roomConnectorConfigCwd());
	const configuredNames: string[] = Object.keys(merged.mcpServers ?? {});
	const configuredSet = new Set(configuredNames);
	for (const name of definedNames) {
		if (!configuredSet.has(name)) return { migrated: [], skipped: "unreadable-config" };
	}
	return { migrated: ensurePersistentRoomMcpGrantsMigration(configuredNames, options), skipped: null };
}

/**
 * Cold-cache session preparation for a room: when the adapter's metadata cache file does not exist yet,
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
 * must not be registered for this room. A tool that doesn't say it stops at the
 * gate is never offered: an install that skipped the patcher would run it unasked.
 */
export async function roomScopedMcpToolRegistration(roomId: string, tool: RegisteredToolLike, options: RoomScopeRegistrationOptions = {}): Promise<RegisteredToolLike | null> {
	if (tool.asksBeforeConnectorCalls !== true) return null;
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
		execute: async (toolCallId: unknown, params: unknown, signal: unknown, onUpdate: unknown, ctx: unknown) => {
			const liveContext = await loadRoomMcpGrantContextSafe(roomId);
			if (!liveContext.granted.has(serverName)) return connectorNotEnabledResult(serverName);
			let ranOnYes: string | undefined;
			const gate: ConnectorCallGate = (call) => askBeforeConnectorCall(roomId, ctx, call, options.connectedPlaces?.()?.get(call.server), (use) => { ranOnYes = use; });
			return withRoomYesWords(await originalExecute(toolCallId, params, signal, onUpdate, gate), ranOnYes);
		},
	};
}
