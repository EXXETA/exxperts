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
 *  - what a tool may DO is the person's choice for it, read on every call: a
 *    blocked tool never runs, an allowed one runs, and with nothing chosen a
 *    tool runs by itself only when the connection that will run it marks it
 *    read-only, it is a plain resource read, or an old room yes still counts;
 *    anything else stops on the room's question (askBeforeConnectorCall,
 *    called by the adapter right before it reaches the connector,
 *    scripts/patch-mcp-adapter.mjs patch 12);
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
	type AllowedConnectorTools,
	connectorAddressPin,
	effectiveGrantedMcpConnectors,
	ensurePersistentRoomMcpGrantsMigration,
	forgetMcpConnectorToolYesesInAllRooms,
	forgetPersistentRoomMcpTool,
	mcpGrantsFingerprint,
	persistentRoomMcpGrantsMigrationPending,
	readPersistentRoomMcpSettings,
	roomUsableMcpConnectors,
	type PersistentRoomMcpSettingsStorageOptions,
} from "../../../apps/web-server/src/persistent-room-mcp-settings.js";
import { connectorApprovalSubject, connectorApprovalTitle, connectorBlockedLine } from "../../../apps/web-server/src/room-approval-titles.js";
import { connectorShownName } from "../../../apps/web-server/src/connector-form.js";
import { connectorFailureModelWords, refusalFailure, refusalStatus, type ConnectorAccessFacts, type ConnectorCallFailure } from "../../../apps/web-server/src/connector-call-failures.js";
import { connectorAwayNote } from "../../../apps/web-server/src/thread-items-by-id.js";
import { CONNECTOR_CALL_END_RESULTS, connectorCallEnd } from "../../../apps/web-server/src/connector-call-ends.js";
import { isSharedServer } from "../../../apps/web-server/src/server-hooks.js";
import type { ConnectorApply, ConnectorCard, ConnectorFormAnswer, ConnectorFormCard } from "../../../apps/web-server/src/web-ui-context.js";
import { connectorFormModelLine, type ConnectorFormCheck, type ConnectorFormParams } from "../../../apps/web-server/src/connector-form-ask.js";
import { scanInvisibleUnicode } from "../../../apps/web-server/src/skills-import.js";
import { declareRoomAbilities } from "../../../apps/web-server/src/connector-abilities.js";
import { classifyAddress } from "../fetch_url/address-class.js";
import { connectorPin, connectorWhere, readConnectorToolChoices, setConnectorToolChoices, toolChoiceIn } from "../../../apps/web-server/src/connector-tool-choices.js";
import { marksReadOnly, toolOwnTitle, type MarkedTool } from "./tool-marks.js";

// Non-literal specifiers keep tsc from resolving the adapter's raw .ts
// sources (same pattern as index.ts).
const ADAPTER_CONFIG = "pi-mcp-adapter/config.ts" as string;
const ADAPTER_CACHE = "pi-mcp-adapter/metadata-cache.ts" as string;
const ADAPTER_TYPES = "pi-mcp-adapter/types.ts" as string;
const ADAPTER_DIRECT_TOOLS = "pi-mcp-adapter/direct-tools.ts" as string;
const ADAPTER_UTILS = "pi-mcp-adapter/utils.ts" as string;
const ADAPTER_TOOL_METADATA = "pi-mcp-adapter/tool-metadata.ts" as string;
const ADAPTER_SERVER_MANAGER = "pi-mcp-adapter/server-manager.ts" as string;
const ADAPTER_AUTH = "pi-mcp-adapter/mcp-auth.ts" as string;
const ADAPTER_AUTH_FLOW = "pi-mcp-adapter/mcp-auth-flow.ts" as string;

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
	/** The room's stored grants it may use, as read (before the configured intersection, sorted). */
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

/** `connector`: its name as the person knows it, said beside its key when the room knows it. */
function connectorNotEnabledResult(serverName: string, connector?: string): ProxyToolResultLike {
	return refusalResult(
		`Connector "${connector ? withKey(connector, serverName) : serverName}" is not enabled for this room. ${ROOM_SETTINGS_SENTENCE}`,
		// Its step names it as the model's words do, only where the room knows it.
		{ error: "connector_not_enabled", server: serverName, ...(connector ? { connector } : {}) },
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
	// Only the stored grants the room may use count, here where every tool and call of the room reads them.
	const usableGrants = roomUsableMcpConnectors(roomId, settings.grantedConnectors);
	const granted = new Set(effectiveGrantedMcpConnectors(usableGrants, configuredNames));
	const prefixMode: PrefixMode = config.settings?.toolPrefix ?? "server";
	return { granted, configuredNames, config, prefixMode, storedGrantedConnectors: usableGrants, allowedTools: settings.allowedTools };
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
		// Dashes read as underscores, as the adapter matches a tool: "toy-space_hello" names Toy space's tool as "toy_space_hello" does.
		.filter((candidate) => candidate.prefix && toolName.replace(/-/g, "_").startsWith(`${candidate.prefix}_`))
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
	liveTool?: { title?: unknown; annotations?: { title?: unknown; readOnlyHint?: unknown; destructiveHint?: unknown } | null; _meta?: unknown };
	resourceRead: boolean;
	args: unknown;
	/** The call comes from the connector's own page, which a call in this room opened, not from the assistant. */
	fromPage?: true;
}

type ConnectorCallGate = (call: ConnectorCall) => Promise<ProxyToolResultLike | undefined>;

interface ConnectorCardContext {
	ui?: { askConnector?(card: ConnectorCard, apply: ConnectorApply, closed?: AbortSignal): Promise<"once" | "room" | "decline"> };
}

/**
 * The questions about connector tools now waiting for an answer, by
 * connector, in every room: endConnectorQuestions closes them. Only what
 * waits right now is held, and nothing a restart would need: a restart ends
 * the questions too.
 */
const waitingQuestions = new Map<string, Set<AbortController>>();

/**
 * Ends every question waiting for an answer about this connector's tools, in
 * every room: their cards close and their calls don't run. For the
 * connector's removal, which then reads on the step as `removed`. Answers how
 * many it ended.
 */
export function endConnectorQuestions(server: string): number {
	const waits = waitingQuestions.get(server);
	if (!waits) return 0;
	waitingQuestions.delete(server);
	for (const wait of waits) wait.abort();
	return waits.size;
}

/** The connector's marks the question's risk line reads: read-only, else marked as not destructive; nothing for a tool it doesn't mark. */
function riskMarks(liveTool: ConnectorCall["liveTool"]): Pick<ConnectorCard, "readOnly" | "destructive"> {
	if (marksReadOnly(liveTool)) return { readOnly: true };
	return liveTool?.annotations?.destructiveHint === false ? { destructive: false } : {};
}

const CARD_ARGS_MAX_CHARS = 20_000;
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

/** A connector as the person knows it (connectorShownName: the directory's name, else the name they typed, else its key), made safe to show. */
function connectorWords(server: string, definition: Record<string, unknown> | undefined): string {
	return cardName(connectorShownName(server, typeof definition?.displayName === "string" ? definition.displayName : undefined));
}

/** A tool as the person reads it: the connector's own title for it, else its name in words. */
function toolWords(toolName: string, tool: MarkedTool): string {
	const title = toolOwnTitle(tool);
	return title ? cardName(title) : connectorToolWords(toolName);
}

/** For the model, a name the person reads with the key calls take beside it: "Write File (write_file)". */
function withKey(words: string, key: string): string {
	return words === key ? key : `${words} (${key})`;
}

/** What a call uses, in the person's words ("Hello in Toy space"), as the question's title has it. */
function useWords(tool: string, connector: string): string | undefined {
	return connectorApprovalSubject(connectorApprovalTitle(tool, connector)) ?? undefined;
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
 * The pin an old room yes for this call was kept with, from the room's
 * settings as they are now; null where such a yes isn't honoured: a shared
 * server, a connector that is a program on this computer (it runs with the
 * person's rights, outside the room's protection), a tool the live connection
 * doesn't list or marks destructive, a connector no longer enabled for the
 * room, a tool switched off for it, or a connector whose entry is no longer
 * the one this session connected with: the adapter connects and reconnects
 * from its own read at the session's start, so the call still goes there.
 * No question writes a room yes now; one kept from before counts in its room
 * until the person picks a choice for that tool.
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
 * What the room's settings say now for this call: whether an old room yes
 * still lets it run, the pin an Always allow is given and counts at (null
 * where it is neither offered nor honoured: a shared server, a choices file
 * that can't be read, a tool the live connection doesn't list (the
 * connector's page lists only the saved tools, so it could not show or take
 * back that choice; a resource read is a saved resource's, which the page
 * lists), a connector no longer enabled for the room or no longer
 * where this session connected it, a tool switched off for it), and where the
 * connector is. A read that fails offers and honours nothing.
 */
function lastingNow(modules: AdapterModules, roomId: string, call: ConnectorCall, connectedPlace: string | undefined, choicesReadable: boolean): { roomYes: boolean; pin: string | null; where: string | null } {
	try {
		const context = roomGrantContextFrom(modules, roomId);
		const definition = context.config.mcpServers[call.server];
		const yesPin = roomYesPin(context, modules.typesMod, call, connectedPlace);
		const roomYes = yesPin !== null && allowedToolsOf(context.allowedTools, call.server).some((entry) => entry.tool === call.toolName && entry.addressPin === yesPin);
		const offered = !isSharedServer() && choicesReadable && (call.liveTool !== undefined || call.resourceRead) && context.granted.has(call.server) && connectedPlace !== undefined && connectorWhere(definition) === connectedPlace && !modules.typesMod.isToolExcluded(call.toolName, call.server, context.prefixMode, definition?.excludeTools);
		return { roomYes, pin: offered ? connectorPin(definition) : null, where: connectorWhere(definition) };
	} catch {
		return { roomYes: false, pin: null, where: null };
	}
}

/** A call's tool and connector as the model is told of them: the person's words with the keys beside them. */
interface CallWords {
	tool: string;
	connector: string;
}

const namedForModel = (call: ConnectorCall, words: CallWords) => `${withKey(words.tool, call.toolName)} in ${withKey(words.connector, call.server)}`;

/** What the model reads for a tool the person blocked; the page shows connectorBlockedLine, by `use`. */
function blockedResult(call: ConnectorCall, words: CallWords, use: string | null): ProxyToolResultLike {
	return refusalResult(
		`${namedForModel(call, words)} is blocked in the person's settings, so it did not run. Don't try it again; if the task needs it, tell the person.`,
		{ mode: "call", error: "connector_tool_blocked", server: call.server, use },
	);
}

/**
 * A card can wait for a long time: what was allowed when it opened, where the
 * connector was, and whether the person blocked the tool since, is read again.
 * A read that fails withdraws.
 */
async function connectorCallWithdrawn(roomId: string, call: ConnectorCall, askedWhere: string | null, words: CallWords, use: string | null): Promise<ProxyToolResultLike | undefined> {
	try {
		const context = await loadRoomGrantContext(roomId);
		if (!context.granted.has(call.server)) return connectorNotEnabledResult(call.server, words.connector);
		if (connectorWhere(context.config.mcpServers[call.server]) !== askedWhere) {
			return refusalResult(
				`Connector "${withKey(words.connector, call.server)}" was moved to another address while this waited, so it did not run.`,
				{ mode: "call", error: "connector_moved", server: call.server },
			);
		}
		const typesMod = await import(ADAPTER_TYPES);
		if (!typesMod.isToolExcluded(call.toolName, call.server, context.prefixMode, context.config.mcpServers[call.server]?.excludeTools)) {
			const choices = readConnectorToolChoices();
			return choices.readable && toolChoiceIn(choices, call.server, call.toolName)?.choice === "blocked" ? blockedResult(call, words, use) : undefined;
		}
	} catch {
		return connectorNotEnabledResult(call.server, words.connector);
	}
	return refusalResult(
		`${namedForModel(call, words)} was switched off while this waited, so it did not run.`,
		{ mode: "call", error: "connector_tool_withdrawn", server: call.server },
	);
}

/**
 * The gate: every connector call passes it right before it reaches the
 * connector. It answers nothing to let the call run, or the result to give the
 * model instead. A connector's marks are its own word about its own tools, so
 * they guard against a fooled model, not a bad connector.
 *
 * The person's choice for the tool (connector-tool-choices.ts) is read on every
 * call, in this order: Blocked refuses, in every room, with nobody there too,
 * and asks nothing. A plain resource read runs unless the tool is set to Ask
 * first. Always allow runs, with nobody there too, while it still counts: the
 * connector is where it was when it was given and where this session connected
 * it, the live connection lists the tool (or it reads a saved resource), and a tool read-only then still is. A tool set to Ask first, or allowed
 * where that no longer counts, asks. With nothing chosen, a tool the live
 * connection marks read-only runs, and an old room yes still counts in its
 * room. Anything else asks: Allow this time, Always allow, which stores the
 * choice before the question says answered, only from the computer and after
 * the same reading (otherwise it counts as this time), or Decline. Any answer
 * is refused as withdrawn when the connector was switched off, the tool
 * excluded or blocked, or the connector moved while the question waited. A
 * choices file that can't be read honours nothing lasting and asks before
 * every call. A shared server reads no choice and keeps no yes.
 *
 * A room that asks nothing (`asksNothing`: Auto with protection off) runs what
 * would ask with no question, after the same withdrawn check, and stores
 * nothing; a read that throws asks. Auto with protection on is not read here:
 * it is about commands inside the box. With nobody there the question rejects
 * by itself, and whoever asked for it leaves the note: a scheduled run's
 * context, or the bridge when the person left or a view-only phone took over.
 * The rejection's words stay first, since the page reads a stopped step by
 * them (step-lines.ts). A refusal keeps what the card asked to use in its
 * details, the page's words for the step; the model never sees details.
 */
async function askBeforeConnectorCall(roomId: string, ctx: unknown, call: ConnectorCall, connectedPlace: string | undefined, asksNothing: RoomScopeExecuteOptions["asksNothing"], heard?: (use: string) => void, toolCallId?: string): Promise<ProxyToolResultLike | undefined> {
	const modules = await adapterModules();
	let definition: Record<string, unknown> | undefined;
	// Every call to the connector, a reading one too, drops the yeses of its tools excluded now.
	try {
		const context = roomGrantContextFrom(modules, roomId);
		definition = context.config.mcpServers[call.server];
		dropExcludedYeses(roomId, context, modules.typesMod, call.server);
	} catch {
		// A read that fails drops nothing; the yes is read again, and honoured only where the tool is not excluded.
	}
	const choices = readConnectorToolChoices();
	const stored = choices.readable ? toolChoiceIn(choices, call.server, call.toolName) : null;
	const words: CallWords = { tool: toolWords(call.toolName, call.liveTool), connector: connectorWords(call.server, definition) };
	const connector = words.connector;
	const title = connectorApprovalTitle(words.tool, connector);
	const use = connectorApprovalSubject(title);
	// The step names what the call uses by the live connection's words, whatever comes of it.
	if (use) heard?.(use);
	if (stored?.choice === "blocked") return blockedResult(call, words, use);
	if (choices.readable && call.resourceRead && !stored) return undefined;
	const before = lastingNow(modules, roomId, call, connectedPlace, choices.readable);
	if (stored?.choice === "allow" && before.pin !== null && stored.where === before.pin && (stored.readOnly !== true || marksReadOnly(call.liveTool))) return undefined;
	if (choices.readable && !stored) {
		if (marksReadOnly(call.liveTool)) return undefined;
		if (before.roomYes) return undefined;
	}
	if (choices.readable && asksNothingNow(asksNothing)) return connectorCallWithdrawn(roomId, call, before.where, words, use);
	const apply: ConnectorApply = (choice, answeredBy) => {
		if (choice !== "room" || answeredBy !== "computer" || before.pin === null) return "once";
		// Read again: the connector may have been switched off, the tool excluded or blocked, or the connector moved while this waited.
		// A block set meanwhile stays, and the withdrawn check then refuses the call. Nothing awaits between this read and the write.
		const choicesNow = readConnectorToolChoices();
		if (!choicesNow.readable || toolChoiceIn(choicesNow, call.server, call.toolName)?.choice === "blocked") return "once";
		const now = lastingNow(modules, roomId, call, connectedPlace, true);
		if (now.pin !== before.pin) return "once";
		setConnectorToolChoices(call.server, { [call.toolName]: { choice: "allow", where: now.pin, ...(marksReadOnly(call.liveTool) ? { readOnly: true as const } : {}) } });
		// As a pick on the connector's page does: the tool's old room yeses go, so Use default later brings none back.
		// The choice is saved: a rooms folder that can't be listed leaves them, and the gate ignores them.
		try {
			for (const failure of forgetMcpConnectorToolYesesInAllRooms(call.server, [call.toolName]).failures) console.warn(`connector tool choices: taking back the room's yeses failed in ${failure.agentId}: ${failure.error}`);
		} catch (error) {
			console.warn(`connector tool choices: taking back the room's yeses failed: ${(error as Error).message}`);
		}
		return "room";
	};
	let choice: "once" | "room" | "decline";
	// Kept by connector while it waits, so the connector's removal can end it (endConnectorQuestions).
	const wait = new AbortController();
	const waits = waitingQuestions.get(call.server) ?? new Set<AbortController>();
	waits.add(wait);
	waitingQuestions.set(call.server, waits);
	try {
		const ui = (ctx as ConnectorCardContext).ui;
		if (!ui?.askConnector) throw new Error("Nobody can answer a question here.");
		choice = await ui.askConnector({ title, connector, ...sentShown(call.args), lasting: before.pin !== null, ...riskMarks(call.liveTool), ...(toolCallId ? { toolCallId } : {}) }, apply, wait.signal);
	} catch (error) {
		return refusalResult(
			`${error instanceof Error ? error.message : String(error)} Nothing was sent to ${connector}. Leave this undone and say so.`,
			{ mode: "call", error: "connector_call_unanswered", server: call.server, use },
		);
	} finally {
		waits.delete(wait);
		if (waits.size === 0 && waitingQuestions.get(call.server) === waits) waitingQuestions.delete(call.server);
	}
	if (choice === "decline") {
		return refusalResult(
			`${declinedLine(connector)} Don't try it again unless the person asks.`,
			{ mode: "call", error: "connector_call_declined", server: call.server, use },
		);
	}
	return connectorCallWithdrawn(roomId, call, before.where, words, use);
}

/** The person's No, as the model's refusal starts and the page's call says it; step-lines.ts reads the step by it. */
function declinedLine(connector: string): string {
	return `You declined this, so nothing changed in ${connector}.`;
}

/** Whether a page may call this tool: the live connection lists it, and its MCP Apps visibility includes "app", as it does when it names none. */
function pageMayCall(liveTool: ConnectorCall["liveTool"]): boolean {
	if (!liveTool) return false;
	const ui = isRecord(liveTool._meta) ? liveTool._meta.ui : undefined;
	const visibility = isRecord(ui) ? ui.visibility : undefined;
	return visibility === undefined || (Array.isArray(visibility) && visibility.includes("app"));
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Why a page's call can't go on in this room now, or null: a page outlives the
 * call that opened it, so the connector may have been switched off in the room,
 * or the tool switched off, since. The assistant's calls are checked for this
 * before they reach the gate. A read that fails refuses.
 */
async function pageCallOffNow(roomId: string, call: ConnectorCall): Promise<string | null> {
	try {
		const modules = await adapterModules();
		const context = roomGrantContextFrom(modules, roomId);
		if (!context.granted.has(call.server)) return "connector_not_enabled";
		const excluded = modules.typesMod.isToolExcluded(call.toolName, call.server, context.prefixMode, context.config.mcpServers[call.server]?.excludeTools);
		return excluded ? "connector_tool_withdrawn" : null;
	} catch {
		return "connector_not_enabled";
	}
}

/**
 * A call from a connector's own page, which a call in this room opened. The
 * page may call only a tool it is allowed to (pageMayCall), of a connector
 * still on in the room, and not switched off (pageCallOffNow); then the call
 * passes the same gate as the assistant's call in this room would: Blocked is
 * refused, Always allow runs, the room's question asks the person where they
 * can answer, and a choices file that can't be read asks. It tells the room's
 * step nothing. A refusal carries a line the person reads, which the page can show.
 */
async function askBeforeConnectorPageCall(roomId: string, ctx: unknown, call: ConnectorCall, connectedPlace: string | undefined, asksNothing: RoomScopeExecuteOptions["asksNothing"]): Promise<ProxyToolResultLike | undefined> {
	const connector = connectorWords(call.server, connectorEntryNow(await adapterModules(), call.server));
	const use = connectorApprovalSubject(connectorApprovalTitle(toolWords(call.toolName, call.liveTool), connector)) ?? connector;
	let error = "connector_page_tool_hidden";
	if (pageMayCall(call.liveTool)) {
		const off = await pageCallOffNow(roomId, call);
		if (off) error = off;
		else {
			const refused = await askBeforeConnectorCall(roomId, ctx, call, connectedPlace, asksNothing);
			if (!refused) return undefined;
			error = detailsErrorOf(refused) ?? "connector_page_call_refused";
		}
	}
	const line = error === "connector_tool_blocked" ? connectorBlockedLine(use) : error === "connector_call_declined" ? declinedLine(connector) : error === "connector_call_unanswered" ? connectorAwayNote(use) : `Didn't run: ${use}.`;
	return refusalResult(line, { mode: "call", error, server: call.server, use, fromPage: true });
}

/**
 * The gate a room's connector call passes, handed to the adapter with the
 * call; a page that call opens calls the same gate, with `fromPage`.
 * `heard` hears what the assistant's call uses, in the live connection's
 * words, for its step; a page's call never tells it. `toolCallId`: the
 * assistant's call, which its question names so the page puts the question
 * on that call's step.
 */
function roomConnectorGate(roomId: string, ctx: unknown, options: RoomScopeExecuteOptions, heard: (use: string) => void, toolCallId: string): ConnectorCallGate {
	return (call) => {
		const connectedPlace = options.connectedPlaces?.()?.get(call.server);
		return call.fromPage === true ? askBeforeConnectorPageCall(roomId, ctx, call, connectedPlace, options.asksNothing) : askBeforeConnectorCall(roomId, ctx, call, connectedPlace, options.asksNothing, heard, toolCallId);
	};
}

export interface RoomScopeExecuteOptions {
	/** The session's registered tools, for the adapter's native-tool redirect hint. */
	getAllTools?: () => Array<{ name: string }>;
	/** Where this session's connections are made from: the adapter's own read of the settings at the session's start (index.ts). Without it no lasting yes is offered or honoured. */
	connectedPlaces?: () => ConnectorPlaces | undefined;
	/** Whether the room asks nothing now: Auto with protection off, read at each call. A live conversation passes it; a scheduled run doesn't. */
	asksNothing?: () => boolean;
	/** This session's connector calls running now, for the line a connector's form leaves for the model (index.ts makes one per session). */
	formNotes?: ConnectorFormNotes;
}

function asksNothingNow(asksNothing: RoomScopeExecuteOptions["asksNothing"]): boolean {
	try {
		return asksNothing?.() === true;
	} catch {
		return false;
	}
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

/**
 * A call the adapter ended itself, at the answer's stop or a time limit
 * (scripts/patch-mcp-adapter.mjs, patch 15): the model is told how it ended,
 * as an error; the step keeps the connector's name (placedResult) for the line
 * its card shows in place of what the model is told.
 */
function withCallEndWords<T extends ProxyToolResultLike>(result: T): T {
	const end = connectorCallEnd(result.details);
	if (!end) return result;
	return { ...result, content: [{ type: "text", text: CONNECTOR_CALL_END_RESULTS[end] }], isError: true };
}

/**
 * One session's connector calls running now, by connector, and the line a
 * connector's form left for the model on the call it belongs to. A form
 * doesn't say which call asked it (the protocol links them only on a web
 * connector's own requests) and a turn's calls run side by side, so a form
 * belongs to a call only when that call was its connector's one call running
 * as the form came; with two or more, no call gets the line.
 */
export interface ConnectorFormNotes {
	started(server: string, toolCallId: string): void;
	/** The call ended: the lines its forms left, in the order they were asked. */
	ended(toolCallId: string): string[];
	/** The connector's one call running now; none when it has none or several. */
	onlyCall(server: string): string | undefined;
	/** Kept only for a call still running: one that ended has had its result. */
	note(toolCallId: string, line: string): void;
}

export function connectorFormNotes(): ConnectorFormNotes {
	const running = new Map<string, Set<string>>();
	const lines = new Map<string, string[]>();
	return {
		started(server, toolCallId) {
			running.set(server, (running.get(server) ?? new Set()).add(toolCallId));
		},
		ended(toolCallId) {
			for (const [server, calls] of running) if (calls.delete(toolCallId) && calls.size === 0) running.delete(server);
			const left = lines.get(toolCallId) ?? [];
			lines.delete(toolCallId);
			return left;
		},
		onlyCall(server) {
			const calls = running.get(server);
			return calls?.size === 1 ? [...calls][0] : undefined;
		},
		note(toolCallId, line) {
			if ([...running.values()].some((calls) => calls.has(toolCallId))) lines.set(toolCallId, [...(lines.get(toolCallId) ?? []), line]);
		},
	};
}

/** What the adapter's form handler hands the room's UI (scripts/patch-mcp-adapter.mjs, patch 28). */
export interface AdapterFormAsk {
	server: string;
	params: ConnectorFormParams;
	check: ConnectorFormCheck;
}

/**
 * A room's ask for a connector's form: the card names the connector as the
 * person knows it, and how it ended is noted for the call that asked it. A card that closes unanswered (the connector stopped
 * waiting, Stop, nobody there) sends the connector a cancel.
 */
export function roomFormAsk(ui: { askForm(card: ConnectorFormCard, closed?: AbortSignal): Promise<ConnectorFormAnswer> }, notes: ConnectorFormNotes) {
	return async ({ server, params, check }: AdapterFormAsk, signal?: AbortSignal): Promise<ConnectorFormAnswer | { action: "cancel" }> => {
		const toolCallId = notes.onlyCall(server);
		const file = await connectorFileNow();
		const connector = connectorWords(server, file?.config.mcpServers[server]);
		let answer: ConnectorFormAnswer | { action: "cancel" };
		try {
			answer = await ui.askForm({ connector, params, check }, signal);
		} catch {
			answer = { action: "cancel" };
		}
		if (toolCallId) notes.note(toolCallId, connectorFormModelLine(answer.action === "accept" ? "sent" : answer.action === "decline" ? "not-now" : "nobody", connector));
		return answer;
	};
}

/** A call's result with its forms' lines for the model after the connector's own answer, which stays as it was. */
function withFormLines(result: ProxyToolResultLike, lines: string[]): ProxyToolResultLike {
	return lines.length > 0 ? { ...result, content: [...(result.content ?? []), ...lines.map((text) => ({ type: "text" as const, text }))] } : result;
}

type ConnectorFile = { config: RoomGrantContext["config"]; prefixMode: PrefixMode };

/** The person's connector settings as a room reads them now; null when they can't be read. */
async function connectorFileNow(): Promise<ConnectorFile | null> {
	try {
		const { configMod, utilsMod } = await adapterModules();
		const config: ConnectorFile["config"] = configMod.loadMcpConfig(utilsMod.getConfigPathFromArgv(), roomConnectorConfigCwd());
		return { config, prefixMode: config.settings?.toolPrefix ?? "server" };
	} catch {
		return null;
	}
}

/** The connector's entry in the person's settings now; none when it is gone or they can't be read. */
function connectorEntryNow(modules: AdapterModules, server: string): Record<string, unknown> | undefined {
	try {
		return modules.configMod.loadMcpConfig(modules.utilsMod.getConfigPathFromArgv(), roomConnectorConfigCwd()).mcpServers?.[server];
	} catch {
		return undefined;
	}
}

/** A saved tool as the connector listed it: its own name, title and marks. */
type SavedToolLike = { name?: unknown; title?: unknown; annotations?: { title?: unknown } | null };

/** A connector's tools in its saved list, each by the name the room calls it, with its own name and the person's words for it. */
async function savedToolsOf(file: ConnectorFile, server: string): Promise<Array<{ callName: string; tool: string; words: string; title: string | null }>> {
	const definition = file.config.mcpServers[server];
	if (!definition) return [];
	try {
		const cacheMod = await import(ADAPTER_CACHE);
		const entry = cacheMod.loadMetadataCache()?.servers?.[server];
		if (!entry) return [];
		const saved: SavedToolLike[] = Array.isArray(entry.tools) ? entry.tools : [];
		return (cacheMod.reconstructToolMetadata(server, entry, file.prefixMode, definition) as CachedToolMetadataLike[]).map((tool) => {
			const own = tool.originalName ?? tool.name;
			const listed = saved.find((one) => one?.name === own);
			return { callName: tool.name, tool: own, words: toolWords(own, listed), title: toolOwnTitle(listed) };
		});
	} catch {
		return [];
	}
}

/**
 * What each room has seen of its connectors, so a call after a connector's
 * removal can still say whose it was: the person's words for each connector
 * by its key, and each tool by the name the room calls it. Filled when the
 * room's description is built and at each call it places, only added to, and
 * lost at a restart, after which such a call reads as a tool no connector of
 * the room has. Names only.
 */
const seenByRoom = new Map<string, { connectors: Map<string, string>; tools: Map<string, { server: string; words: string }> }>();

/** A tool the room has seen, by the name a call gives it, matched as the adapter matches one: exactly, else with dashes read as underscores. */
function seenTool(roomId: string, callName: string): { server: string; words: string } | undefined {
	const tools = seenIn(roomId).tools;
	const owner = metadataToolMatch([...tools.keys()].map((name) => ({ name })), callName);
	return owner ? tools.get(owner.name) : undefined;
}

function seenIn(roomId: string) {
	let seen = seenByRoom.get(roomId);
	if (!seen) {
		seen = { connectors: new Map(), tools: new Map() };
		seenByRoom.set(roomId, seen);
	}
	return seen;
}

/** The names a call is shown by: the connector as the person knows it, and what the call uses in their words when the tool is known. */
interface CallNames {
	connector: string;
	use?: string;
}

/** A call's names from the person's settings and the saved tool list, else from what the room has seen; remembered for the room. */
async function callNamesOf(roomId: string, server: string, callName: string | undefined): Promise<CallNames> {
	const file = await connectorFileNow();
	const definition = file?.config.mcpServers[server];
	const seen = seenIn(roomId);
	const connector = definition ? connectorWords(server, definition) : seen.connectors.get(server) ?? cardName(server);
	if (definition) seen.connectors.set(server, connector);
	if (!callName) return { connector };
	const saved = file && definition ? (await savedToolsOf(file, server)).find((tool) => metadataToolMatch([{ name: tool.callName }], callName)) : undefined;
	if (saved) seen.tools.set(saved.callName, { server, words: saved.words });
	const known = seenTool(roomId, callName);
	const words = saved?.words ?? (known?.server === server ? known.words : undefined) ?? (file && definition ? await bareToolWords(file, server, callName) : undefined);
	return { connector, use: words ? useWords(words, connector) : undefined };
}

/** A tool no saved list names yet (a connector that never connected), in words from the call's own name with the connector's prefix taken off, as the adapter put it on. */
async function bareToolWords(file: ConnectorFile, server: string, callName: string): Promise<string | undefined> {
	try {
		const prefix: string = (await import(ADAPTER_TYPES)).getServerPrefix(server, file.prefixMode);
		const called = callName.replace(/-/g, "_");
		const bare = !prefix ? called : called.startsWith(`${prefix}_`) ? called.slice(prefix.length + 1) : "";
		return bare ? connectorToolWords(bare) : undefined;
	} catch {
		return undefined;
	}
}

/** What the gate hears a call use, kept for its result; the step is told again when it differs from the name it was first given. */
function hearingFor(place: CallPlace, onUpdate: unknown): (use: string) => void {
	return (use) => {
		place.heard = use;
		if (place.server && place.names && use !== place.names.use) tellPlaced(onUpdate, place.server, { ...place.names, use });
	};
}

/**
 * Tells the step what the call uses, in the person's words, as a connector
 * call's naming update: a step shows it while the call runs, with no
 * question asked. Nothing for a tool the room can't name yet.
 */
function tellPlaced(onUpdate: unknown, server: string, names: CallNames): void {
	if (typeof onUpdate !== "function" || !names.use) return;
	try {
		onUpdate({ content: [], details: { connector: names.connector, connectorId: server, use: names.use } });
	} catch {
		// The step keeps the tool's own name until the result names it.
	}
}

/** The model's words for a connector removed after the room saw it, with what the step shows. */
function removedResult(server: string, names: CallNames, mode: string): ProxyToolResultLike {
	return refusalResult(connectorFailureModelWords("removed", withKey(names.connector, server), isSharedServer()) ?? "", {
		mode,
		error: "connector_removed",
		server,
		connector: names.connector,
		connectorId: server,
		...(names.use ? { use: names.use } : {}),
		failure: "removed",
	});
}

/**
 * A refusal for a connector this room can't use: one removed since the room
 * saw it reads so, any other one as not enabled here. Only a connector the
 * room has had on is named: one it never had reads word for word as a key
 * that doesn't exist, so a room learns nothing of connectors kept from it.
 */
async function connectorRefused(roomId: string, context: RoomGrantContext, server: string, callName: string | undefined, mode: string): Promise<ProxyToolResultLike> {
	const definition = context.config.mcpServers[server];
	const hadIt = seenIn(roomId).connectors.has(server);
	if (!definition && hadIt) return removedResult(server, await callNamesOf(roomId, server, callName), mode);
	return connectorNotEnabledResult(server, definition && hadIt ? connectorWords(server, definition) : undefined);
}

// The adapter's words for what went wrong carry no code of their own: a service's 401 or 403 in the transport's own
// sentences (the MCP SDK's SSE and Streamable HTTP clients), a sign-in it couldn't renew, a connector's input check, and
// the person's No to a connector using the room's model (pi-mcp-adapter's sampling-handler.ts).
const REFUSAL_STATUS = /Non-200 status code \((40[13])\)|Server returned (40[13]) after/;
const SIGN_IN_ASKED = /^Failed to call tool: Unauthorized$/m;
const BAD_INPUT = /Input validation error|MCP error -32602/;
const MODEL_USE_DECLINED = /sampling request was declined/i;
const CONNECT_ERRORS: ReadonlySet<string> = new Set(["connect_failed", "server_not_connected", "server_unavailable", "not_connected"]);
const BACKOFF_ERRORS: ReadonlySet<string> = new Set(["server_backoff"]);

/** A service's refusal in the adapter's words: the sign-in it asks for, or its 401 or 403; null when the words hold none. */
function refusalIn(text: string): "sign-in" | 401 | 403 | null {
	const status = REFUSAL_STATUS.exec(text);
	if (status) return Number(status[1] ?? status[2]) as 401 | 403;
	return SIGN_IN_ASKED.test(text) || SIGN_IN_REFUSAL.test(text) ? "sign-in" : null;
}

/** Whether the connector carries a key or any header, signs in through its service, and has a sign-in stored: read only on a refusal, never what they hold. */
async function accessFacts(server: string, definition: Record<string, unknown>): Promise<ConnectorAccessFacts> {
	const headers = definition.headers;
	const carriesKey = (typeof headers === "object" && headers !== null && Object.keys(headers).length > 0) || Boolean(definition.bearerToken) || Boolean(definition.bearerTokenEnv);
	try {
		const [authMod, flowMod] = await Promise.all([import(ADAPTER_AUTH), import(ADAPTER_AUTH_FLOW)]);
		return { carriesKey, signsIn: flowMod.supportsOAuthWithoutSwitch(definition) === true, signedIn: authMod.hasStoredTokens(server) === true };
	} catch {
		return { carriesKey, signsIn: false, signedIn: false };
	}
}

/**
 * Each connector's last known failure to connect (a sign-in it asked for
 * included), with the settings it failed under. A back-off says only that a
 * connect failed moments ago, in whichever of the room's conversations, and
 * sometimes after the adapter dropped why (its lazy connect keeps no
 * error); it reads as this last known failure while the connector's settings
 * are the same and no call to it has worked since, else as a connector that
 * couldn't be reached. Kept while the server runs.
 */
const connectFailures = new Map<string, { failure: ConnectorCallFailure; settings: string }>();

/** Why a call failed, from the adapter's answer and the connector's own state; null for an answer that isn't a failure of the connector or the way to it. */
async function failureOf(result: ProxyToolResultLike, server: string, definition: Record<string, unknown>): Promise<ConnectorCallFailure | null> {
	const error = detailsErrorOf(result);
	if (!error) return null;
	const text = result.content?.map((part) => part.text).join("\n") ?? "";
	if (MODEL_USE_DECLINED.test(text)) return "model-declined";
	const refusal = error === "auth_required" ? "sign-in" : refusalIn(text);
	const refused = async () => (refusal ? refusalFailure(refusal, await accessFacts(server, definition)) : null);
	if (error === "auth_required" || CONNECT_ERRORS.has(error)) {
		const failure = (await refused()) ?? "cant-connect";
		connectFailures.set(server, { failure, settings: JSON.stringify(definition) });
		return failure;
	}
	if (BACKOFF_ERRORS.has(error)) {
		const last = connectFailures.get(server);
		return last && last.settings === JSON.stringify(definition) ? last.failure : "cant-connect";
	}
	if (error === "tool_not_found" || error === "tool_not_found_after_reconnect") return "no-such-tool";
	if (error === "server_not_found") return "removed";
	// A refusal is read from the way to the connector failing, never from the connector's own error text.
	if (error === "call_failed") {
		// The status the transport kept first (connector-call-failures.ts, refusalStatus), then its words.
		const status = refusalStatus(result.details);
		return status ? refusalFailure(status, await accessFacts(server, definition)) : ((await refused()) ?? (BAD_INPUT.test(text) ? "bad-input" : "connector-error"));
	}
	if (error === "tool_error") return BAD_INPUT.test(text) ? "bad-input" : "connector-error";
	return null;
}

/** Where a room's call went: the connector it was handed to, the tool as the call named it, its names, and what the gate heard it use. */
interface CallPlace {
	server?: string;
	callName?: string;
	names?: CallNames;
	heard?: string;
}

/**
 * Every connector result in a room, through the `mcp` tool or a direct tool,
 * carries the connector as the person knows it (`connector`), its key
 * (`connectorId`), what the call used in the person's words (`use`) and, for
 * a failed one, why (`failure`, connector-call-failures.ts), read again from
 * the settings: a connector no longer there was removed. The model gets the
 * module's words for the failures the transport's words would mislead it
 * on; a call one of ours ended keeps its own end and no failure.
 */
async function placedResult(roomId: string, result: ProxyToolResultLike, place: CallPlace): Promise<ProxyToolResultLike> {
	const server = place.server;
	if (!server || typeof result.details?.connectorId === "string") return result;
	const names = place.names ?? (await callNamesOf(roomId, server, place.callName));
	const use = place.heard ?? names.use;
	const failed = !connectorCallEnd(result.details) && (Boolean(detailsErrorOf(result)) || result.isError === true);
	let failure: ConnectorCallFailure | null = null;
	if (failed) {
		const file = await connectorFileNow();
		const definition = file?.config.mcpServers[server];
		if (file && !definition) failure = "removed";
		else if (definition) failure = await failureOf(result, server, definition);
	} else connectFailures.delete(server);
	const words = failure ? connectorFailureModelWords(failure, withKey(names.connector, server), isSharedServer()) : null;
	return {
		...result,
		...(words ? { content: [{ type: "text" as const, text: words }] } : {}),
		details: { ...(result.details ?? {}), connector: names.connector, connectorId: server, ...(use ? { use } : {}), ...(failure ? { failure } : {}) },
	};
}

/**
 * A search, list or describe answer of one connector, with that connector as
 * the person knows it (`connector`) and the tool described in their words
 * (`about`), for its step's head; the model's words stay as they were.
 */
async function namedRead(roomId: string, result: ProxyToolResultLike, server: string, described?: string): Promise<ProxyToolResultLike> {
	const names = await callNamesOf(roomId, server, described);
	return { ...result, details: { ...(result.details ?? {}), connector: names.connector, ...(described && names.use ? { about: names.use } : {}) } };
}

/** A list or search answer with each tool's title beside the name the room calls it, where the connector gives one: "- write_file (Write File) - …". */
async function withToolTitles(result: ProxyToolResultLike): Promise<ProxyToolResultLike> {
	const details = result.details;
	const named: Array<{ server: string; tool: string }> = details?.mode === "list" && typeof details.server === "string" && Array.isArray(details.tools)
		? details.tools.filter((tool): tool is string => typeof tool === "string").map((tool) => ({ server: String(details.server), tool }))
		: details?.mode === "search" && Array.isArray(details.matches)
			? details.matches.flatMap((match) => (isRecord(match) && typeof match.server === "string" && typeof match.tool === "string" ? [{ server: match.server, tool: match.tool }] : []))
			: [];
	const text = result.content?.[0]?.text;
	if (named.length === 0 || typeof text !== "string") return result;
	const file = await connectorFileNow();
	if (!file) return result;
	const titles = new Map<string, string>();
	for (const server of new Set(named.map((one) => one.server))) {
		for (const tool of await savedToolsOf(file, server)) if (tool.title) titles.set(tool.callName, tool.title);
	}
	const titled = text.split("\n").map((line) => {
		const name = named.find(({ tool }) => line === `- ${tool}` || line.startsWith(`- ${tool} - `) || line === tool)?.tool;
		const title = name ? titles.get(name) : undefined;
		if (!name || !title) return line;
		return line === name ? `${name} (${title})` : `- ${name} (${title})${line.slice(2 + name.length)}`;
	}).join("\n");
	return titled === text ? result : { ...result, content: [{ type: "text", text: titled }, ...result.content.slice(1)] };
}

function createRoomScopedProxyExecute(roomId: string, originalExecute: ProxyExecute, executeOptions: RoomScopeExecuteOptions = {}): ProxyExecute {
	return async (toolCallId, params, signal, onUpdate, ctx) => {
		const place: CallPlace = {};
		const scoped = createRoomScopedProxyAnswer(roomId, originalExecute, executeOptions, place);
		let result: ProxyToolResultLike;
		let formLines: string[] = [];
		try {
			const answer = asSignIn(withCallEndWords(await scoped(toolCallId, params, signal, onUpdate, ctx)), params);
			result = withErrorFlag(await placedResult(roomId, answer, place));
		} finally {
			formLines = executeOptions.formNotes?.ended(toolCallId) ?? [];
		}
		return withFormLines(result, formLines);
	};
}

/** `place`: filled with where a call or a connect went, for placedResult. */
function createRoomScopedProxyAnswer(roomId: string, originalExecute: ProxyExecute, executeOptions: RoomScopeExecuteOptions, place: CallPlace): ProxyExecute {
	return async (toolCallId, params, signal, onUpdate, ctx) => {
		const context = await loadRoomGrantContext(roomId);
		const granted = context.granted;
		const gate = roomConnectorGate(roomId, ctx, executeOptions, hearingFor(place, onUpdate), toolCallId);
		const delegate = async (overrides: Partial<McpProxyParams> = {}): Promise<ProxyToolResultLike> => {
			const server = overrides.server ?? params.server ?? params.connect;
			// Only a connector the room may use is named: a UI messages call or a sign-in reaches here with any key, and one kept from the room reads as a key that doesn't exist.
			if (server && granted.has(server) && (params.tool || params.connect)) {
				place.server = server;
				place.callName = params.tool;
				place.heard = undefined;
				place.names = await callNamesOf(roomId, server, params.tool);
				tellPlaced(onUpdate, server, place.names);
				executeOptions.formNotes?.started(server, toolCallId);
			}
			const result = await originalExecute(toolCallId, { ...params, ...overrides }, signal, onUpdate, gate);
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
				if (!granted.has(params.server)) return connectorRefused(roomId, context, params.server, params.tool, "call");
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
			// A tool of a connector removed since the room saw it says so; one no connector of the room ever had is not found.
			const seen = seenTool(roomId, params.tool);
			if (seen && !context.config.mcpServers[seen.server]) return removedResult(seen.server, await callNamesOf(roomId, seen.server, params.tool), "call");
			return refusalResult(`Tool "${params.tool}" not found. Use mcp({ search: "..." }) to search.`, {
				mode: "call",
				error: "tool_not_found",
				requestedTool: params.tool,
				failure: "no-such-tool",
			});
		}
		if (params.connect) {
			if (!granted.has(params.connect)) return connectorRefused(roomId, context, params.connect, undefined, "connect");
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
			if (!answeredServer) return delegated;
			if (granted.has(answeredServer)) return namedRead(roomId, delegated, answeredServer, params.describe);
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
				return namedRead(roomId, await withToolTitles(await delegate()), params.server);
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
			return withToolTitles(mergeSearchResults(results, params.search));
		}
		if (params.server) {
			if (!granted.has(params.server)) return connectorNotEnabledResult(params.server);
			return namedRead(roomId, await withToolTitles(await delegate()), params.server);
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
	return `${description}\n\n${await shownNamesLine(roomId, { config: context.config, prefixMode: context.prefixMode }, Object.keys(grantedServers))}`;
}

/**
 * The description's line that tells the model each connector's name as the
 * person knows it, so its own sentences use the person's words; calls still
 * take the keys. The room remembers each connector and its saved tools here,
 * so a call after a removal can still say whose it was.
 */
async function shownNamesLine(roomId: string, file: ConnectorFile, servers: string[]): Promise<string> {
	const seen = seenIn(roomId);
	const named: string[] = [];
	for (const server of servers) {
		const connector = connectorWords(server, file.config.mcpServers[server]);
		seen.connectors.set(server, connector);
		for (const tool of await savedToolsOf(file, server)) seen.tools.set(tool.callName, { server, words: tool.words });
		named.push(`${server} is "${connector}"`);
	}
	return `Connectors as the person knows them: ${named.join(", ")}. Use these names, and a tool's title where a list gives one, when you write to the person.`;
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

/** How long a warm-up gives each connector, and how long it then waits for an ended one to close: its program's input closed, then two steps of 2 s before it is killed. */
const WARM_UP_ATTEMPT_MS = 8_000;
const WARM_UP_SETTLE_MS = 5_000;
/**
 * Connectors a warm-up in this process reached for their instructions, with that
 * attempt and whether it connected: one that can't be reached is tried once a
 * run, not at every conversation's start; one that was is reached again once
 * its saved entry has run out or gone; on a cold cache every one is reached
 * again; and a warm-up that finds one under way waits for it.
 */
const instructionsSought = new Map<string, { attempt: Promise<unknown>; settled: boolean; reached: boolean }>();

/**
 * A room's warm-up, before its description is built. On a cold metadata cache
 * (no file yet) the adapter's session start would bootstrap-connect EVERY
 * configured server once to warm it, ungranted ones included: instead, create
 * the file empty (which switches that bootstrap off) and warm ONLY the room's
 * connectors. On a warm one, on the desktop only, connect once each room connector with no saved
 * entry, one written before the entry kept the connector's instructions, or
 * one the adapter would not take (another address, or too old), so a
 * conversation's first request has them; a connector another conversation's
 * warm-up is reaching is waited for, not reached twice. Each connection declares
 * what a room's does (connector-abilities.ts), so it saves the list a room
 * sees, with answers that decline: nobody is asked and no model is used. Each
 * attempt is ended at 8 s, a download or a program's start with it, and the
 * manager closes only once the ended attempts have closed, so nothing starts
 * afterwards. Best-effort throughout: a failed warm-up just leaves the server
 * to the adapter's lazy connect on first use. Eager/keep-alive lifecycles are
 * deliberately untouched.
 */
export async function prepareRoomScopedMcpSessionCache(roomId: string): Promise<void> {
	try {
		ensureAgentDirEnv();
		const cacheMod = await import(ADAPTER_CACHE);
		const cold = !fs.existsSync(cacheMod.getMetadataCachePath());
		// A shared server reaches a room's connectors here only on a cold cache, so a room's opening there connects nothing else;
		// a connector's instructions are saved by the first conversation that connects it. The switch the adapter reads
		// (scripts/patch-mcp-adapter.mjs) counts too: a process can set it without the server's hooks, and then still starts as a shared server's adapter.
		if (!cold && (isSharedServer() || process.env.EXXPERTS_SHARED_SERVER === "1")) return;
		if (cold) cacheMod.saveMetadataCache({ version: 1, servers: {} });
		const context = await loadRoomMcpGrantContextSafe(roomId);
		const saved: Record<string, { instructions?: unknown }> = cold ? {} : (cacheMod.loadMetadataCache()?.servers ?? {});
		// An entry for another address or from long ago doesn't count: its instructions are not this connector's now.
		const wanted = [...context.granted].filter((serverName) => {
			const definition = context.config.mcpServers[serverName];
			if (!definition) return false;
			const entry = saved[serverName];
			return cold || typeof entry?.instructions !== "string" || !cacheMod.isServerCacheValid(entry, definition);
		});
		// One another conversation's warm-up is reaching: this one waits for it, so its first request has them too.
		const waits = wanted.flatMap((serverName) => {
			const sought = instructionsSought.get(serverName);
			return sought && !sought.settled ? [sought.attempt] : [];
		});
		const toReach = wanted.filter((serverName) => {
			const sought = instructionsSought.get(serverName);
			if (!sought) return true;
			if (!sought.settled) return false;
			if (cold) return true;
			if (!sought.reached) return false;
			// Reached before, so its entry kept the instructions: again only once that entry has run out or gone.
			const entry = saved[serverName];
			return !entry || !cacheMod.isServerCacheValid(entry, context.config.mcpServers[serverName]);
		});
		if (toReach.length > 0) {
			// Connects each once, ended at 8 s, and saves the entries of those that connected, whose names it gives. Never throws.
			const reaching = (async (): Promise<string[]> => {
				try {
					const managerMod = await import(ADAPTER_SERVER_MANAGER);
					const manager = new managerMod.McpServerManager();
					declareRoomAbilities(manager, context.config.settings as Record<string, unknown> | undefined);
					// A removal reaches this manager from here on; one before it has taken the connector off the room.
					const now = await loadRoomMcpGrantContextSafe(roomId);
					const stillThere = toReach.filter((serverName) => now.granted.has(serverName) && now.config.mcpServers[serverName] !== undefined);
					const entries: Record<string, unknown> = {};
					const connects: Array<Promise<unknown>> = [];
					await Promise.all(
						stillThere.map(async (serverName) => {
							const definition = context.config.mcpServers[serverName];
							const attempt = new AbortController();
							let timer: ReturnType<typeof setTimeout> | undefined;
							try {
								const connecting = manager.connect(serverName, definition, { signal: attempt.signal });
								connects.push(connecting);
								// The signal ends a download and a program's start; a web connection's first request doesn't take it, so the wait ends here too.
								const connection = await Promise.race([
									connecting,
									new Promise<never>((_, reject) => {
										timer = setTimeout(() => {
											attempt.abort();
											reject(new Error("warm-up timeout"));
										}, WARM_UP_ATTEMPT_MS);
									}),
								]);
								if (connection?.status !== "connected") return;
								entries[serverName] = {
									configHash: cacheMod.computeServerHash(definition),
									tools: cacheMod.serializeTools(connection.tools ?? []),
									resources: cacheMod.serializeResources(connection.resources ?? []),
									// Kept by the adapter's connection (scripts/patch-mcp-adapter.mjs, patch 24); without it the entry stays without them.
									...(typeof connection.instructions === "string" ? { instructions: connection.instructions } : {}),
									cachedAt: Date.now(),
								};
							} catch {
								// lazy connect covers this server on first use
							} finally {
								if (timer) clearTimeout(timer);
							}
						}),
					);
					// A connector removed meanwhile was closed here, so its list is not saved again; nothing else runs between this check and the save.
					for (const serverName of Object.keys(entries)) {
						if (manager.getConnection(serverName)?.status !== "connected") delete entries[serverName];
					}
					if (Object.keys(entries).length > 0) {
						const cache = cacheMod.loadMetadataCache() ?? { version: 1, servers: {} };
						cache.servers = { ...cache.servers, ...entries };
						cacheMod.saveMetadataCache(cache);
					}
					// Ended attempts close before the manager does; one that outlasts the wait is closed once it settles.
					const settled = Promise.allSettled(connects);
					let settleTimer: ReturnType<typeof setTimeout> | undefined;
					const inTime = await Promise.race([settled.then(() => true), new Promise<boolean>((resolve) => { settleTimer = setTimeout(() => resolve(false), WARM_UP_SETTLE_MS); })]);
					clearTimeout(settleTimer);
					if (!inTime) void settled.then(() => manager.closeAll()).catch(() => {});
					try {
						await manager.closeAll();
					} catch {
						// already closed / never opened
					}
					return Object.keys(entries);
				} catch {
					// lazy connect covers these servers on first use
					return [];
				}
			})();
			for (const serverName of toReach) {
				const sought = { attempt: reaching, settled: false, reached: false };
				instructionsSought.set(serverName, sought);
				void reaching.then((reached) => {
					sought.settled = true;
					sought.reached = reached.includes(serverName);
				});
			}
			waits.push(reaching);
		}
		await Promise.all(waits);
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
			if (!liveContext.granted.has(serverName)) return connectorRefused(roomId, liveContext, serverName, tool.name, "call");
			// Placed by its registration: the same names, first update and decoration as a call through the `mcp` tool.
			const place: CallPlace = { server: serverName, callName: tool.name, names: await callNamesOf(roomId, serverName, tool.name) };
			tellPlaced(onUpdate, serverName, place.names!);
			const gate = roomConnectorGate(roomId, ctx, options, hearingFor(place, onUpdate), String(toolCallId));
			options.formNotes?.started(serverName, String(toolCallId));
			let result: ProxyToolResultLike;
			let formLines: string[] = [];
			try {
				result = withErrorFlag(await placedResult(roomId, withCallEndWords(await originalExecute(toolCallId, params, signal, onUpdate, gate)), place));
			} finally {
				formLines = options.formNotes?.ended(String(toolCallId)) ?? [];
			}
			return withFormLines(result, formLines);
		},
	};
}
