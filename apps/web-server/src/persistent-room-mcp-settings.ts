import fs from "node:fs";
import path from "node:path";
import { DEFAULT_PERSISTENT_ROOM_AGENTS_ROOT, persistentAgentRootPath } from "./persistent-room-workspace-policy.js";

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
 */
export interface PersistentRoomMcpSettings {
	schemaVersion: 1;
	grantedConnectors: string[];
	updatedAt: string;
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

const DEFAULT_SETTINGS: PersistentRoomMcpSettings = {
	schemaVersion: 1,
	grantedConnectors: [],
	updatedAt: "",
};

/** Same rule the connector add API enforces (mcp-admin.ts SERVER_NAME_PATTERN). */
const CONNECTOR_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;

/** True when `name` is a well-formed connector name. */
export function isValidMcpConnectorName(name: unknown): name is string {
	return typeof name === "string" && CONNECTOR_NAME_RE.test(name);
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

export function persistentRoomMcpSettingsPath(agentIdRaw: string, options: PersistentRoomMcpSettingsStorageOptions = {}): string {
	const agentId = safeSettingsAgentId(agentIdRaw);
	return path.join(persistentAgentRootPath(agentId, options.persistentAgentsRoot ?? DEFAULT_PERSISTENT_ROOM_AGENTS_ROOT), "runtime", "mcp-settings.json");
}

export function readPersistentRoomMcpSettings(agentIdRaw: string, options: PersistentRoomMcpSettingsStorageOptions = {}): PersistentRoomMcpSettings {
	const settingsPath = persistentRoomMcpSettingsPath(agentIdRaw, options);
	try {
		if (!fs.existsSync(settingsPath)) return { ...DEFAULT_SETTINGS, grantedConnectors: [] };
		const raw = JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
		if (!raw || typeof raw !== "object" || raw.schemaVersion !== 1) return { ...DEFAULT_SETTINGS, grantedConnectors: [] };
		return {
			schemaVersion: 1,
			grantedConnectors: sanitizeGrantedConnectors(raw.grantedConnectors),
			updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : "",
		};
	} catch {
		return { ...DEFAULT_SETTINGS, grantedConnectors: [] };
	}
}

export function writePersistentRoomMcpSettings(agentIdRaw: string, grantedConnectors: string[], options: PersistentRoomMcpSettingsStorageOptions = {}, now = new Date()): PersistentRoomMcpSettings {
	const settingsPath = persistentRoomMcpSettingsPath(agentIdRaw, options);
	const settings: PersistentRoomMcpSettings = {
		schemaVersion: 1,
		grantedConnectors: sanitizeGrantedConnectors(grantedConnectors),
		updatedAt: now.toISOString(),
	};
	fs.mkdirSync(path.dirname(settingsPath), { recursive: true, mode: 0o700 });
	// Atomic (tmp + rename): the enforcement wrapper re-reads this file on
	// every tool call, possibly from another process, and the corrupt-file
	// fallback is an EMPTY grant list - a torn write must never be observable.
	const tmp = `${settingsPath}.${process.pid}.tmp`;
	fs.writeFileSync(tmp, JSON.stringify(settings, null, 2) + "\n", { mode: 0o600 });
	fs.renameSync(tmp, settingsPath);
	return settings;
}

/**
 * Grant a connector to a room. Validates the name and requires the connector
 * to be globally configured RIGHT NOW (`configuredNames`), so a grant can
 * never point at a connector that does not exist. Idempotent upsert.
 */
export function grantPersistentRoomMcpConnector(
	agentIdRaw: string,
	name: string,
	configuredNames: readonly string[],
	options: PersistentRoomMcpSettingsStorageOptions = {},
	now = new Date(),
): McpGrantMutationResult {
	if (!isValidMcpConnectorName(name)) return { ok: false, reason: "invalid-name" };
	if (!configuredNames.includes(name)) return { ok: false, reason: "unknown-connector" };
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
 */
export function mcpGrantsFingerprint(grantedConnectors: readonly string[]): string {
	return JSON.stringify(grantedConnectors);
}

export function persistentRoomMcpGrantsFingerprint(agentIdRaw: string, options: PersistentRoomMcpSettingsStorageOptions = {}): string {
	return mcpGrantsFingerprint(readPersistentRoomMcpSettings(agentIdRaw, options).grantedConnectors);
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

export interface McpConnectorRevokeSweepResult {
	/** Rooms whose grant list actually held (and lost) the connector. */
	revokedFrom: string[];
	/** Rooms the sweep could not update - reported, never swallowed. */
	failures: Array<{ agentId: string; error: string }>;
}

/**
 * Connector-delete hook (grant identity rule): remove `name` from every
 * room's grant list, archived rooms included, so a re-created connector with
 * the same name starts with no grants anywhere. One unwritable room must not
 * stop the sweep, but every failure is reported to the caller so the delete
 * route can surface it instead of a namesake silently inheriting grants.
 */
export function revokeMcpConnectorFromAllRooms(name: string, options: PersistentRoomMcpSettingsStorageOptions = {}, now = new Date()): McpConnectorRevokeSweepResult {
	if (!isValidMcpConnectorName(name)) return { revokedFrom: [], failures: [] };
	const persistentAgentsRoot = options.persistentAgentsRoot ?? DEFAULT_PERSISTENT_ROOM_AGENTS_ROOT;
	const revokedFrom: string[] = [];
	const failures: Array<{ agentId: string; error: string }> = [];
	for (const agentId of listPersistentRoomAgentIds(persistentAgentsRoot)) {
		try {
			const current = readPersistentRoomMcpSettings(agentId, options);
			if (!current.grantedConnectors.includes(name)) continue;
			writePersistentRoomMcpSettings(agentId, current.grantedConnectors.filter((granted) => granted !== name), options, now);
			revokedFrom.push(agentId);
		} catch (error) {
			failures.push({ agentId, error: (error as Error).message });
		}
	}
	return { revokedFrom, failures };
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
 * Guarded by a marker file created atomically (wx), so concurrent surfaces
 * (web server and a CLI room) racing here converge on one migration; after
 * the marker exists, a room without a settings file simply has no grants.
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
