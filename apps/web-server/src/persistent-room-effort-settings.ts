import fs from "node:fs";
import path from "node:path";
import { DEFAULT_PERSISTENT_ROOM_AGENTS_ROOT, persistentAgentRootPath } from "./persistent-room-workspace-policy.js";

/**
 * Per-room reasoning effort.
 *
 * The web composer lets a room pick how hard the model thinks. The choice is
 * sticky for the ROOM: the last level explicitly chosen rides every following
 * turn, including turns sent after leaving and re-entering, and including a
 * turn that detaches and finishes with nobody watching.
 *
 * A record exists ONLY after an explicit choice. No record means the room has
 * never been asked, and a room that has never been asked keeps whatever level
 * the session resolved for itself at creation, which is the machine-wide
 * default. Writing a "default" record on a room's behalf would silently
 * override that default for every room the moment it was first opened.
 *
 * This is also deliberately NOT the runtime's machine-wide default thinking
 * level. That default belongs to the person at the CLI, and a room must never
 * move it (see the apply path in index.ts, which sets the level on the bound
 * agent state instead of going through the settings-writing session setter).
 *
 * Levels are stored RAW, never clamped: the room's locked model decides what
 * is reachable at bind time, and a model swap must not silently burn a
 * preference the room may reach again later. Nothing may write back a level
 * that came out of the clamp, which is why the client never echoes the level
 * it was told and why only an explicit choice reaches the write path.
 */
export const ROOM_EFFORT_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type RoomEffortLevel = (typeof ROOM_EFFORT_LEVELS)[number];

export interface PersistentRoomEffortSettings {
	schemaVersion: 1;
	level: RoomEffortLevel;
	updatedAt: string;
}

export interface PersistentRoomEffortSettingsStorageOptions {
	persistentAgentsRoot?: string;
}

export function isRoomEffortLevel(raw: unknown): raw is RoomEffortLevel {
	return typeof raw === "string" && (ROOM_EFFORT_LEVELS as readonly string[]).includes(raw);
}

function safeSettingsAgentId(raw: string): string {
	const id = String(raw ?? "").trim();
	if (!/^[a-zA-Z0-9_-]{1,160}$/.test(id)) throw new Error("invalid persistent-room agent id");
	return id;
}

export function persistentRoomEffortSettingsPath(agentIdRaw: string, options: PersistentRoomEffortSettingsStorageOptions = {}): string {
	const agentId = safeSettingsAgentId(agentIdRaw);
	return path.join(persistentAgentRootPath(agentId, options.persistentAgentsRoot ?? DEFAULT_PERSISTENT_ROOM_AGENTS_ROOT), "runtime", "effort-settings.json");
}

/**
 * The room's explicitly chosen level, or null when the room never chose.
 * An unreadable or unrecognized record reads as "never chose" rather than as
 * some invented level, so a corrupted file cannot pin a room to a depth
 * nobody picked.
 */
export function readPersistentRoomEffortChoice(agentIdRaw: string, options: PersistentRoomEffortSettingsStorageOptions = {}): RoomEffortLevel | null {
	const settingsPath = persistentRoomEffortSettingsPath(agentIdRaw, options);
	try {
		if (!fs.existsSync(settingsPath)) return null;
		const raw = JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
		if (!raw || typeof raw !== "object" || raw.schemaVersion !== 1) return null;
		return isRoomEffortLevel(raw.level) ? raw.level : null;
	} catch {
		return null;
	}
}

export function writePersistentRoomEffortChoice(agentIdRaw: string, level: unknown, options: PersistentRoomEffortSettingsStorageOptions = {}, now = new Date()): PersistentRoomEffortSettings {
	if (!isRoomEffortLevel(level)) throw new Error("level must be a known reasoning effort level");
	const settingsPath = persistentRoomEffortSettingsPath(agentIdRaw, options);
	const settings: PersistentRoomEffortSettings = { schemaVersion: 1, level, updatedAt: now.toISOString() };
	fs.mkdirSync(path.dirname(settingsPath), { recursive: true, mode: 0o700 });
	fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n", { mode: 0o600 });
	return settings;
}
