import fs from "node:fs";
import path from "node:path";
import { DEFAULT_PERSISTENT_ROOM_AGENTS_ROOT, persistentAgentRootPath } from "./persistent-room-workspace-policy.js";

/**
 * Per-room bash approval preference.
 *
 * `autoApprove` lets a Full-access room run bash commands without the
 * per-command approval card in the chat. Default off: every command asks
 * until the room explicitly opts out. One deliberate exception, applied once
 * at upgrade: a room that already had bash enabled BEFORE the approval card
 * existed ran commands without asking, so the startup migration grants it
 * autoApprove to preserve its behavior — an explicit write, never a
 * permissive default; a missing or malformed file always reads as ask. The live session guard reads this file on EVERY
 * bash call, so flipping it takes effect on the next command with no rebind;
 * nothing here widens the tool surface itself — whether bash exists at all
 * stays with the workspace policy.
 */
export interface PersistentRoomBashSettings {
	schemaVersion: 1;
	autoApprove: boolean;
	updatedAt: string;
}

export interface PersistentRoomBashSettingsStorageOptions {
	persistentAgentsRoot?: string;
}

const DEFAULT_SETTINGS: PersistentRoomBashSettings = {
	schemaVersion: 1,
	autoApprove: false,
	updatedAt: "",
};

function safeSettingsAgentId(raw: string): string {
	const id = String(raw ?? "").trim();
	if (!/^[a-zA-Z0-9_-]{1,160}$/.test(id)) throw new Error("invalid persistent-room agent id");
	return id;
}

export function persistentRoomBashSettingsPath(agentIdRaw: string, options: PersistentRoomBashSettingsStorageOptions = {}): string {
	const agentId = safeSettingsAgentId(agentIdRaw);
	return path.join(persistentAgentRootPath(agentId, options.persistentAgentsRoot ?? DEFAULT_PERSISTENT_ROOM_AGENTS_ROOT), "runtime", "bash-settings.json");
}

export function readPersistentRoomBashSettings(agentIdRaw: string, options: PersistentRoomBashSettingsStorageOptions = {}): PersistentRoomBashSettings {
	const settingsPath = persistentRoomBashSettingsPath(agentIdRaw, options);
	try {
		if (!fs.existsSync(settingsPath)) return { ...DEFAULT_SETTINGS };
		const raw = JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
		if (!raw || typeof raw !== "object" || raw.schemaVersion !== 1) return { ...DEFAULT_SETTINGS };
		return {
			schemaVersion: 1,
			// Anything but an explicit true asks per command: a malformed value
			// must never read as consent to stop asking.
			autoApprove: raw.autoApprove === true,
			updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : "",
		};
	} catch {
		return { ...DEFAULT_SETTINGS };
	}
}

export function writePersistentRoomBashSettings(agentIdRaw: string, input: { autoApprove?: unknown }, options: PersistentRoomBashSettingsStorageOptions = {}, now = new Date()): PersistentRoomBashSettings {
	if (input?.autoApprove !== undefined && typeof input.autoApprove !== "boolean") throw new Error("autoApprove must be a boolean");
	const current = readPersistentRoomBashSettings(agentIdRaw, options);
	const settingsPath = persistentRoomBashSettingsPath(agentIdRaw, options);
	const settings: PersistentRoomBashSettings = {
		schemaVersion: 1,
		autoApprove: input?.autoApprove !== undefined ? input.autoApprove as boolean : current.autoApprove,
		updatedAt: now.toISOString(),
	};
	fs.mkdirSync(path.dirname(settingsPath), { recursive: true, mode: 0o700 });
	fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n", { mode: 0o600 });
	return settings;
}

const BASH_AUTO_APPROVE_MIGRATION_MARKER = ".bash-auto-approve-defaults-v1";

/**
 * One-time upgrade grant: rooms with bash already enabled before the
 * per-command approval card shipped ran commands without asking, so they keep
 * that behavior via an explicit settings write. Runs once (marker file);
 * every room that enables bash after the marker exists starts at ask-each.
 * A room with a settings file already on disk made an explicit choice and is
 * never touched. Any failure leaves rooms asking — the safe direction.
 */
export function migratePersistentRoomBashAutoApproveDefaults(
	agents: ReadonlyArray<{ id: string; bashEnabled: boolean }>,
	options: PersistentRoomBashSettingsStorageOptions = {},
	now = new Date(),
): { migrated: string[] } {
	const root = options.persistentAgentsRoot ?? DEFAULT_PERSISTENT_ROOM_AGENTS_ROOT;
	const markerPath = path.join(root, BASH_AUTO_APPROVE_MIGRATION_MARKER);
	if (fs.existsSync(markerPath)) return { migrated: [] };
	const migrated: string[] = [];
	for (const agent of agents) {
		if (agent.bashEnabled !== true) continue;
		if (fs.existsSync(persistentRoomBashSettingsPath(agent.id, options))) continue;
		writePersistentRoomBashSettings(agent.id, { autoApprove: true }, options, now);
		migrated.push(agent.id);
	}
	fs.mkdirSync(root, { recursive: true, mode: 0o700 });
	fs.writeFileSync(markerPath, JSON.stringify({ migratedAt: now.toISOString(), migrated }, null, 2) + "\n", { mode: 0o600 });
	return { migrated };
}
