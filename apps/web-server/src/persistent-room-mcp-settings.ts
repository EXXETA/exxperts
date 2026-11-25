import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DEFAULT_PERSISTENT_ROOM_AGENTS_ROOT, persistentAgentRootPath } from "./persistent-room-workspace-policy.js";
import { shownRoomName } from "./room-name.js";
import { isValidMcpConnectorName } from "./connector-form.js";
import { serverHooks } from "./server-hooks.js";

/**
 * Per-room MCP connector grants (per-room MCP v1). Clones the
 * `persistent-room-skill-settings.ts` shape: a per-room JSON file with a
 * schemaVersion, per-field merge/sanitize on read, 0o600 perms, and a
 * fallback-to-empty on a corrupt/foreign file.
 *
 * A room's grant list names the globally configured connectors the room can
 * use. Grants are keyed by connector NAME only: names are unique by
 * construction (the add API answers 409 on a duplicate), an edited connector
 * keeps its grants, and DELETING a connector revokes it from every room via
 * `revokeMcpConnectorFromAllRooms` - a later re-created connector with the
 * same name starts ungranted everywhere.
 *
 * Reads are the enforcement source of truth: the shared MCP room-scope
 * wrapper (pi-package/extensions/mcp/room-scope.ts) re-reads this file on
 * every proxy-tool call, so a settings change applies to a running
 * conversation from the next call onward. A missing/corrupt file reads as an
 * empty grant list - the room simply has no connectors until granted.
 *
 * Update-day migration: `ensurePersistentRoomMcpGrantsMigration` runs once
 * per install (guarded by a marker file next to the room roots) and writes
 * the FULL current connector list into every existing room that has no
 * settings file yet, so rooms keep working exactly as before the update.
 * Rooms created after the marker exists start from an explicit empty list.
 *
 * `allowedTools` holds the room's lasting yeses to a web connector's tool, by
 * connector name: each yes names the tool's own name on the connector and pins
 * the connector's web address as it was when the yes was given. Every write
 * keeps only the yeses of connectors still granted, so switching one off drops
 * them in the same write. An older app reading the file ignores the field.
 */
export interface PersistentRoomMcpSettings {
	schemaVersion: 1;
	grantedConnectors: string[];
	allowedTools: AllowedConnectorTools;
	updatedAt: string;
}

/** One lasting yes: the tool's own name, and the pin of the address it was given at (`connectorAddressPin`). */
export interface AllowedConnectorTool {
	tool: string;
	addressPin: string;
}

export type AllowedConnectorTools = Record<string, AllowedConnectorTool[]>;

/** A connector's yeses, read as its own key only: a connector may be named like an object's own members (`constructor`). */
export function allowedToolsOf(allowed: AllowedConnectorTools, connector: string): AllowedConnectorTool[] {
	return Object.hasOwn(allowed, connector) ? allowed[connector] : [];
}

export interface PersistentRoomMcpSettingsStorageOptions {
	persistentAgentsRoot?: string;
}

/** Per-granted-connector view the room settings panel renders. */
export interface GrantedConnectorStatus {
	name: string;
	/** False when the connector is no longer globally configured. */
	configured: boolean;
}

export type McpGrantMutationReason = "invalid-name" | "unknown-connector";

export type McpGrantMutationResult =
	| { ok: true; settings: PersistentRoomMcpSettings }
	| { ok: false; reason: McpGrantMutationReason };

const emptySettings = (): PersistentRoomMcpSettings => ({ schemaVersion: 1, grantedConnectors: [], allowedTools: {}, updatedAt: "" });

const TOOL_NAME_MAX_CHARS = 200;

/**
 * What a yes is pinned to: a hash of the connector's web address, never the
 * address itself, since an address can carry a key in its path or query and
 * the room's file must not hold a copy of it.
 */
export function connectorAddressPin(address: string): string {
	return createHash("sha256").update(address).digest("hex");
}


function safeSettingsAgentId(raw: string): string {
	const id = String(raw ?? "").trim();
	if (!/^[a-zA-Z0-9_-]{1,160}$/.test(id)) throw new Error("invalid persistent-room agent id");
	return id;
}

/**
 * Merge/sanitize a raw `grantedConnectors` value read off disk: keep only
 * well-formed names, dedupe, and sort - so a hand-edited or partly-corrupt
 * file degrades to its valid entries instead of throwing.
 */
function sanitizeGrantedConnectors(raw: unknown): string[] {
	if (!Array.isArray(raw)) return [];
	const names = new Set<string>();
	for (const item of raw) {
		if (isValidMcpConnectorName(item)) names.add(item);
	}
	return [...names].sort((a, b) => a.localeCompare(b));
}

/** A raw `allowedTools` value read leniently: well-formed entries only, one per tool, in tool order. */
function sanitizeAllowedTools(raw: unknown): AllowedConnectorTools {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
	const allowed: AllowedConnectorTools = {};
	for (const [connector, entries] of Object.entries(raw as Record<string, unknown>)) {
		if (!isValidMcpConnectorName(connector) || !Array.isArray(entries)) continue;
		const byTool = new Map<string, AllowedConnectorTool>();
		for (const entry of entries) {
			const { tool, addressPin } = (entry ?? {}) as Record<string, unknown>;
			if (typeof tool !== "string" || !tool || tool.length > TOOL_NAME_MAX_CHARS || typeof addressPin !== "string" || !/^[0-9a-f]{64}$/.test(addressPin)) continue;
			byTool.set(tool, { tool, addressPin });
		}
		if (byTool.size > 0) allowed[connector] = [...byTool.values()].sort((a, b) => a.tool.localeCompare(b.tool));
	}
	return allowed;
}

export function persistentRoomMcpSettingsPath(agentIdRaw: string, options: PersistentRoomMcpSettingsStorageOptions = {}): string {
	const agentId = safeSettingsAgentId(agentIdRaw);
	return path.join(persistentAgentRootPath(agentId, options.persistentAgentsRoot ?? DEFAULT_PERSISTENT_ROOM_AGENTS_ROOT), "runtime", "mcp-settings.json");
}

/** A settings file's text read leniently, or null when it is not JSON of this schema. */
function settingsFromText(text: string): PersistentRoomMcpSettings | null {
	let raw;
	try {
		raw = JSON.parse(text);
	} catch {
		return null;
	}
	if (!raw || typeof raw !== "object" || raw.schemaVersion !== 1) return null;
	return {
		schemaVersion: 1,
		grantedConnectors: sanitizeGrantedConnectors(raw.grantedConnectors),
		allowedTools: sanitizeAllowedTools(raw.allowedTools),
		updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : "",
	};
}

export function readPersistentRoomMcpSettings(agentIdRaw: string, options: PersistentRoomMcpSettingsStorageOptions = {}): PersistentRoomMcpSettings {
	const settingsPath = persistentRoomMcpSettingsPath(agentIdRaw, options);
	try {
		if (!fs.existsSync(settingsPath)) return emptySettings();
		return settingsFromText(fs.readFileSync(settingsPath, "utf-8")) ?? emptySettings();
	} catch {
		return emptySettings();
	}
}

/** Only a path that is not there; any other refusal leaves it unknown. */
function isMissing(error: unknown): boolean {
	const code = (error as NodeJS.ErrnoException | null)?.code;
	return code === "ENOENT" || code === "ENOTDIR";
}

/**
 * Writes the room's grants, and its yeses for the connectors still granted:
 * `allowedTools` when given, else the ones on disk, so a grant change drops
 * the yeses of a connector it switches off and keeps the others.
 */
export function writePersistentRoomMcpSettings(agentIdRaw: string, grantedConnectors: string[], options: PersistentRoomMcpSettingsStorageOptions = {}, now = new Date(), allowedTools?: AllowedConnectorTools): PersistentRoomMcpSettings {
	const settingsPath = persistentRoomMcpSettingsPath(agentIdRaw, options);
	const granted = sanitizeGrantedConnectors(grantedConnectors);
	const allowed = sanitizeAllowedTools(allowedTools ?? readPersistentRoomMcpSettings(agentIdRaw, options).allowedTools);
	const settings: PersistentRoomMcpSettings = {
		schemaVersion: 1,
		grantedConnectors: granted,
		allowedTools: Object.fromEntries(Object.entries(allowed).filter(([connector]) => granted.includes(connector))),
		updatedAt: now.toISOString(),
	};
	fs.mkdirSync(path.dirname(settingsPath), { recursive: true, mode: 0o700 });
	writeSettingsText(settingsPath, JSON.stringify(settings, null, 2) + "\n");
	return settings;
}

function writeSettingsText(settingsPath: string, text: string): void {
	// Atomic (tmp + rename): the enforcement wrapper re-reads this file on
	// every tool call, possibly from another process, and the corrupt-file
	// fallback is an EMPTY grant list - a torn write must never be observable.
	const tmp = `${settingsPath}.${process.pid}.tmp`;
	fs.writeFileSync(tmp, text, { mode: 0o600 });
	fs.renameSync(tmp, settingsPath);
}

/**
 * Of these connector names, those the room may use, in their order: on a
 * shared server the ones its owner may use (server-hooks.ts, roomConnectors),
 * elsewhere all. Every door that hands a room its connectors asks here.
 */
export function roomUsableMcpConnectors(agentId: string, names: readonly string[]): string[] {
	const usable = serverHooks().roomConnectors;
	if (!usable) return [...names];
	const allowed = new Set(usable(agentId, names));
	return names.filter((name) => allowed.has(name));
}

/**
 * Grant a connector to a room. Validates the name and requires the connector
 * to be globally configured RIGHT NOW (`configuredNames`) and usable by the
 * room, so a grant can never point at a connector that does not exist or that
 * the room may not use. Idempotent upsert.
 */
export function grantPersistentRoomMcpConnector(
	agentIdRaw: string,
	name: string,
	configuredNames: readonly string[],
	options: PersistentRoomMcpSettingsStorageOptions = {},
	now = new Date(),
): McpGrantMutationResult {
	if (!isValidMcpConnectorName(name)) return { ok: false, reason: "invalid-name" };
	if (!configuredNames.includes(name) || roomUsableMcpConnectors(agentIdRaw, [name]).length === 0) return { ok: false, reason: "unknown-connector" };
	const current = readPersistentRoomMcpSettings(agentIdRaw, options);
	if (current.grantedConnectors.includes(name)) return { ok: true, settings: current };
	return { ok: true, settings: writePersistentRoomMcpSettings(agentIdRaw, [...current.grantedConnectors, name], options, now) };
}

/**
 * Revoke a connector from a room. Validates the name (bad format is rejected)
 * but is otherwise idempotent - revoking an ungranted name is a no-op that
 * still returns the current settings. Deliberately does NOT require the name
 * to be configured, so dangling grants can always be cleaned up.
 */
export function revokePersistentRoomMcpConnector(
	agentIdRaw: string,
	name: string,
	options: PersistentRoomMcpSettingsStorageOptions = {},
	now = new Date(),
): McpGrantMutationResult {
	if (!isValidMcpConnectorName(name)) return { ok: false, reason: "invalid-name" };
	const current = readPersistentRoomMcpSettings(agentIdRaw, options);
	if (!current.grantedConnectors.includes(name)) return { ok: true, settings: current };
	return { ok: true, settings: writePersistentRoomMcpSettings(agentIdRaw, current.grantedConnectors.filter((granted) => granted !== name), options, now) };
}

/**
 * Stores a lasting yes for one tool of a granted connector, pinned to its
 * address; a yes already there is replaced. False when the connector is not
 * granted to the room (nothing written) or the file can't hold the yes.
 */
export function allowPersistentRoomMcpTool(agentIdRaw: string, connector: string, tool: string, addressPin: string, options: PersistentRoomMcpSettingsStorageOptions = {}, now = new Date()): boolean {
	const current = readPersistentRoomMcpSettings(agentIdRaw, options);
	if (!current.grantedConnectors.includes(connector)) return false;
	const others = allowedToolsOf(current.allowedTools, connector).filter((entry) => entry.tool !== tool);
	const written = writePersistentRoomMcpSettings(agentIdRaw, current.grantedConnectors, options, now, { ...current.allowedTools, [connector]: [...others, { tool, addressPin }] });
	return allowedToolsOf(written.allowedTools, connector).some((entry) => entry.tool === tool && entry.addressPin === addressPin);
}

/** Takes back a lasting yes; idempotent, and a name in a bad format is refused. */
export function forgetPersistentRoomMcpTool(agentIdRaw: string, connector: string, tool: string, options: PersistentRoomMcpSettingsStorageOptions = {}, now = new Date()): McpGrantMutationResult {
	if (!isValidMcpConnectorName(connector)) return { ok: false, reason: "invalid-name" };
	const current = readPersistentRoomMcpSettings(agentIdRaw, options);
	const entries = allowedToolsOf(current.allowedTools, connector);
	if (!entries.some((entry) => entry.tool === tool)) return { ok: true, settings: current };
	const allowed = { ...current.allowedTools, [connector]: entries.filter((entry) => entry.tool !== tool) };
	return { ok: true, settings: writePersistentRoomMcpSettings(agentIdRaw, current.grantedConnectors, options, now, allowed) };
}

/**
 * The room's EFFECTIVE connector list: granted AND currently configured.
 * This is what every enforcement door consumes - a dangling grant (connector
 * removed outside the delete API) grants nothing.
 */
export function effectiveGrantedMcpConnectors(grantedConnectors: readonly string[], configuredNames: readonly string[]): string[] {
	const configured = new Set(configuredNames);
	return grantedConnectors.filter((name) => configured.has(name));
}

/**
 * Stable fingerprint of a grant list, for bind-time drift detection: the web
 * session rebinds when this changes so the proxy tool's manifest description
 * matches the live grants from the next turn onward. (Call gating never
 * depends on it - the wrapper re-reads grants per call.) The list-taking form
 * exists so the description builder can fingerprint the very read it used.
 * Both take the stored grants the room may use, so a change to who may use a
 * connector rebinds the room too.
 */
export function mcpGrantsFingerprint(grantedConnectors: readonly string[]): string {
	return JSON.stringify(grantedConnectors);
}

export function persistentRoomMcpGrantsFingerprint(agentIdRaw: string, options: PersistentRoomMcpSettingsStorageOptions = {}): string {
	return mcpGrantsFingerprint(roomUsableMcpConnectors(agentIdRaw, readPersistentRoomMcpSettings(agentIdRaw, options).grantedConnectors));
}

/** Per-grant configured/missing view for the room settings panel. */
export function computeGrantedConnectorStatuses(grantedConnectors: readonly string[], configuredNames: readonly string[]): GrantedConnectorStatus[] {
	const configured = new Set(configuredNames);
	return grantedConnectors.map((name) => ({ name, configured: configured.has(name) }));
}

function listPersistentRoomAgentIds(persistentAgentsRoot: string): string[] {
	try {
		if (!fs.existsSync(persistentAgentsRoot)) return [];
		return fs
			.readdirSync(persistentAgentsRoot, { withFileTypes: true })
			.filter((entry) => entry.isDirectory() && /^[a-zA-Z0-9_-]{1,160}$/.test(entry.name))
			.filter((entry) => fs.existsSync(path.join(persistentAgentsRoot, entry.name, "agent.json")))
			.map((entry) => entry.name);
	} catch {
		return [];
	}
}

/** A room that may use a connector, as the Connectors page names it. */
export interface McpConnectorRoomUse {
	id: string;
	name: string;
}

/**
 * Which rooms may use each connector, by connector name: every room that is
 * not archived, named as people see it and sorted by that name. Read without
 * blocking (the Connectors page asks on every open), and a room that cannot
 * be read is left out rather than failing the list.
 */
export async function mcpConnectorRoomUse(options: PersistentRoomMcpSettingsStorageOptions = {}): Promise<Map<string, McpConnectorRoomUse[]>> {
	const persistentAgentsRoot = options.persistentAgentsRoot ?? DEFAULT_PERSISTENT_ROOM_AGENTS_ROOT;
	let folders: fs.Dirent[];
	try {
		folders = await fs.promises.readdir(persistentAgentsRoot, { withFileTypes: true });
	} catch {
		return new Map();
	}
	const rooms = await Promise.all(
		folders
			.filter((entry) => entry.isDirectory() && /^[a-zA-Z0-9_-]{1,160}$/.test(entry.name))
			.map(async (entry) => {
				try {
					const agent = JSON.parse(await fs.promises.readFile(path.join(persistentAgentsRoot, entry.name, "agent.json"), "utf-8"));
					if (Number(agent?.archivedAt ?? 0) > 0) return null;
					let granted: string[] = [];
					try {
						const raw = JSON.parse(await fs.promises.readFile(persistentRoomMcpSettingsPath(entry.name, options), "utf-8"));
						if (raw?.schemaVersion === 1) granted = sanitizeGrantedConnectors(raw.grantedConnectors);
					} catch {
						// no settings file yet: the room has no connectors
					}
					return { id: entry.name, name: shownRoomName(typeof agent?.displayName === "string" ? agent.displayName : "") || entry.name, granted };
				} catch {
					return null;
				}
			}),
	);
	const byConnector = new Map<string, McpConnectorRoomUse[]>();
	for (const room of rooms) {
		if (!room) continue;
		for (const name of room.granted) {
			const list = byConnector.get(name) ?? [];
			list.push({ id: room.id, name: room.name });
			byConnector.set(name, list);
		}
	}
	for (const list of byConnector.values()) list.sort((a, b) => a.name.localeCompare(b.name));
	return byConnector;
}

export interface McpConnectorRevokeSweepResult {
	/** Rooms whose grant list actually held (and lost) the connector. */
	revokedFrom: string[];
	/** Rooms the sweep could not update - reported, never swallowed. */
	failures: Array<{ agentId: string; error: string }>;
}

/**
 * The rooms a sweep must go through: every folder that may be a room. Unlike
 * a room's own reading, a folder whose room file can't be checked counts, and
 * a rooms folder that can't be listed throws, so a sweep never passes over a
 * room it could not see.
 */
function sweptRoomAgentIds(persistentAgentsRoot: string): string[] {
	let folders: fs.Dirent[];
	try {
		folders = fs.readdirSync(persistentAgentsRoot, { withFileTypes: true });
	} catch (error) {
		if (isMissing(error)) return [];
		throw error;
	}
	return folders
		.filter((entry) => entry.isDirectory() && /^[a-zA-Z0-9_-]{1,160}$/.test(entry.name))
		.filter((entry) => {
			try {
				fs.statSync(path.join(persistentAgentsRoot, entry.name, "agent.json"));
				return true;
			} catch (error) {
				return !isMissing(error);
			}
		})
		.map((entry) => entry.name);
}

/**
 * A room's settings as a sweep for `name` must know them. A room with no file
 * has no grants. A file that can't be read throws. A file that is there but
 * isn't settings this version understands throws only when its text names the
 * connector, as a quoted name: a hand repair or another version could read that grant again,
 * and a file that never names it can't give it back.
 */
function sweptRoomMcpSettings(agentId: string, name: string, options: PersistentRoomMcpSettingsStorageOptions): { settings: PersistentRoomMcpSettings; text: string } {
	let text: string;
	try {
		text = fs.readFileSync(persistentRoomMcpSettingsPath(agentId, options), "utf-8");
	} catch (error) {
		if (isMissing(error)) return { settings: emptySettings(), text: "" };
		throw error;
	}
	const settings = settingsFromText(text);
	if (settings) return { settings, text };
	if (text.includes(JSON.stringify(name))) throw new Error(`its connector settings aren't readable as settings and name ${name}`);
	return { settings: emptySettings(), text };
}

/** Every room, archived ones included, whose file names `name`: `change` writes it, and a room that can't be read or written is reported. */
function sweepRooms(name: string, options: PersistentRoomMcpSettingsStorageOptions, holds: (settings: PersistentRoomMcpSettings) => boolean, change: (agentId: string, settings: PersistentRoomMcpSettings, text: string) => void): McpConnectorRevokeSweepResult {
	if (!isValidMcpConnectorName(name)) return { revokedFrom: [], failures: [] };
	const revokedFrom: string[] = [];
	const failures: Array<{ agentId: string; error: string }> = [];
	for (const agentId of sweptRoomAgentIds(options.persistentAgentsRoot ?? DEFAULT_PERSISTENT_ROOM_AGENTS_ROOT)) {
		try {
			const { settings: current, text } = sweptRoomMcpSettings(agentId, name, options);
			if (!holds(current)) continue;
			change(agentId, current, text);
			revokedFrom.push(agentId);
		} catch (error) {
			failures.push({ agentId, error: (error as Error).message });
		}
	}
	return { revokedFrom, failures };
}

export interface McpConnectorRevoke extends McpConnectorRevokeSweepResult {
	/** Puts back each swept room's file as it was; the rooms that could not be written. */
	undo: () => McpConnectorRevokeSweepResult["failures"];
}

/**
 * Connector-delete hook (grant identity rule): remove `name` from every
 * room's grant list and its yeses, archived rooms included, so a re-created
 * connector with the same name starts with no grants and no yeses anywhere.
 * All or nothing: when a room can't be read or written, the rooms already
 * swept get their files back, every failure is reported and `revokedFrom` is
 * empty, so the delete keeps the connector and a retry sweeps again. `undo`
 * does the same for a delete that fails after the sweep. A process stopped
 * mid-sweep leaves grants gone and the connector kept: never a grant left for
 * a namesake to inherit.
 */
export function revokeMcpConnectorFromAllRooms(name: string, options: PersistentRoomMcpSettingsStorageOptions = {}, now = new Date()): McpConnectorRevoke {
	const before = new Map<string, string>();
	const sweep = sweepRooms(name, options, (settings) => settings.grantedConnectors.includes(name) || Object.hasOwn(settings.allowedTools, name), (agentId, settings, text) => {
		writePersistentRoomMcpSettings(agentId, settings.grantedConnectors.filter((granted) => granted !== name), options, now, settings.allowedTools);
		before.set(agentId, text);
	});
	const undo = () => {
		const failures: McpConnectorRevokeSweepResult["failures"] = [];
		for (const [agentId, text] of before) {
			try {
				writeSettingsText(persistentRoomMcpSettingsPath(agentId, options), text);
			} catch (error) {
				failures.push({ agentId, error: (error as Error).message });
			}
		}
		before.clear();
		return failures;
	};
	if (sweep.failures.length === 0) return { ...sweep, undo };
	return { revokedFrom: [], failures: [...sweep.failures, ...undo()], undo };
}

/** A connector moved to another address: its yeses go in every room, and its grants stay. */
export function forgetMcpConnectorToolsInAllRooms(name: string, options: PersistentRoomMcpSettingsStorageOptions = {}, now = new Date()): McpConnectorRevokeSweepResult {
	return sweepRooms(name, options, (settings) => Object.hasOwn(settings.allowedTools, name), (agentId, settings) => {
		const { [name]: _gone, ...rest } = settings.allowedTools;
		writePersistentRoomMcpSettings(agentId, settings.grantedConnectors, options, now, rest);
	});
}

/** The person picked a choice for these tools of a connector: their old yeses go in every room, and its grants stay. */
export function forgetMcpConnectorToolYesesInAllRooms(name: string, tools: readonly string[], options: PersistentRoomMcpSettingsStorageOptions = {}, now = new Date()): McpConnectorRevokeSweepResult {
	const picked = new Set(tools);
	return sweepRooms(name, options, (settings) => allowedToolsOf(settings.allowedTools, name).some((entry) => picked.has(entry.tool)), (agentId, settings) => {
		const allowed = { ...settings.allowedTools, [name]: allowedToolsOf(settings.allowedTools, name).filter((entry) => !picked.has(entry.tool)) };
		writePersistentRoomMcpSettings(agentId, settings.grantedConnectors, options, now, allowed);
	});
}

function migrationMarkerPath(persistentAgentsRoot: string): string {
	return path.join(persistentAgentsRoot, ".mcp-grants-migration.json");
}

/** True while the one-time update-day migration has not stamped its marker. */
export function persistentRoomMcpGrantsMigrationPending(options: PersistentRoomMcpSettingsStorageOptions = {}): boolean {
	try {
		return !fs.existsSync(migrationMarkerPath(options.persistentAgentsRoot ?? DEFAULT_PERSISTENT_ROOM_AGENTS_ROOT));
	} catch {
		return false;
	}
}

/**
 * One-time update-day migration: every existing room without an
 * mcp-settings.json is granted the FULL current global connector list, so
 * nothing a room could do before the update stops working on update day.
 * Guarded by a marker file created atomically (wx), so concurrent callers
 * (the server's boot and a room session's registration) racing here
 * converge on one migration; after the marker exists, a room without a
 * settings file simply has no grants.
 * Returns the ids of the rooms that received the migrated full list.
 */
export function ensurePersistentRoomMcpGrantsMigration(configuredNames: readonly string[], options: PersistentRoomMcpSettingsStorageOptions = {}, now = new Date()): string[] {
	const persistentAgentsRoot = options.persistentAgentsRoot ?? DEFAULT_PERSISTENT_ROOM_AGENTS_ROOT;
	const markerPath = migrationMarkerPath(persistentAgentsRoot);
	try {
		if (fs.existsSync(markerPath)) return [];
	} catch {
		return [];
	}
	const migrated: string[] = [];
	for (const agentId of listPersistentRoomAgentIds(persistentAgentsRoot)) {
		try {
			if (fs.existsSync(persistentRoomMcpSettingsPath(agentId, options))) continue;
			writePersistentRoomMcpSettings(agentId, [...configuredNames], options, now);
			migrated.push(agentId);
		} catch {
			// a room we cannot write degrades to an empty grant list, never to a crash
		}
	}
	try {
		fs.mkdirSync(persistentAgentsRoot, { recursive: true, mode: 0o700 });
		fs.writeFileSync(markerPath, JSON.stringify({ schemaVersion: 1, migratedAt: now.toISOString(), migratedRooms: migrated.length }, null, 2) + "\n", { mode: 0o600, flag: "wx" });
	} catch {
		// another surface won the race and wrote the marker first
	}
	return migrated;
}
