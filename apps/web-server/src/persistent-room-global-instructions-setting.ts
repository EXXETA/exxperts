import fs from "node:fs";
import path from "node:path";
import { DEFAULT_PERSISTENT_ROOM_AGENTS_ROOT, persistentAgentRootPath } from "./persistent-room-workspace-policy.js";

/**
 * Whether a room follows the global instructions.
 *
 * The global instructions are one live text under the app's state
 * folder (persistent-room-instructions.ts); each room decides for itself
 * whether that text is part of its boot. The default is yes, and a room says
 * so by having no record at all: the switch arrived after rooms existed, and
 * the text starts empty, so "on" changes nothing for any room until the user
 * writes the text, at which point every room follows it unless it was
 * switched off. A record exists only after an explicit flip, in either
 * direction, so the pane can show when the room last decided.
 *
 * This is the ONLY per-room control: a room's own text has no switch, because
 * an empty text is off. A record that exists but cannot be understood reads
 * as the default rather than as some invented state; the pane shows the
 * state it reads from here, so what the user sees is what the boot does.
 *
 * Its own small file in the room's runtime folder, beside the effort choice,
 * rather than a field in a file other writers rewrite whole: the boot reads
 * it on every connect and the per-turn hook on every turn.
 */
export interface PersistentRoomGlobalInstructionsSetting {
	schemaVersion: 1;
	enabled: boolean;
	updatedAt: string;
}

export interface PersistentRoomGlobalInstructionsSettingStorageOptions {
	persistentAgentsRoot?: string;
}

function safeSettingsAgentId(raw: string): string {
	const id = String(raw ?? "").trim();
	if (!/^[a-zA-Z0-9_-]{1,160}$/.test(id)) throw new Error("invalid persistent-room agent id");
	return id;
}

export function persistentRoomGlobalInstructionsSettingPath(agentIdRaw: string, options: PersistentRoomGlobalInstructionsSettingStorageOptions = {}): string {
	const agentId = safeSettingsAgentId(agentIdRaw);
	return path.join(persistentAgentRootPath(agentId, options.persistentAgentsRoot ?? DEFAULT_PERSISTENT_ROOM_AGENTS_ROOT), "runtime", "global-instructions.json");
}

/** The record as written, or null when the room never flipped the switch (or the record cannot be understood). */
export function readPersistentRoomGlobalInstructionsSetting(agentIdRaw: string, options: PersistentRoomGlobalInstructionsSettingStorageOptions = {}): PersistentRoomGlobalInstructionsSetting | null {
	const settingsPath = persistentRoomGlobalInstructionsSettingPath(agentIdRaw, options);
	try {
		if (!fs.existsSync(settingsPath)) return null;
		const raw = JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
		if (!raw || typeof raw !== "object" || raw.schemaVersion !== 1 || typeof raw.enabled !== "boolean") return null;
		return { schemaVersion: 1, enabled: raw.enabled, updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : "" };
	} catch {
		return null;
	}
}

/** True unless the room explicitly switched the global instructions off. */
export function readPersistentRoomGlobalInstructionsEnabled(agentIdRaw: string, options: PersistentRoomGlobalInstructionsSettingStorageOptions = {}): boolean {
	return readPersistentRoomGlobalInstructionsSetting(agentIdRaw, options)?.enabled ?? true;
}

function refuse(message: string): Error {
	const error = new Error(message);
	(error as any).statusCode = 400;
	return error;
}

export function writePersistentRoomGlobalInstructionsEnabled(agentIdRaw: string, enabled: unknown, options: PersistentRoomGlobalInstructionsSettingStorageOptions = {}, now = new Date()): PersistentRoomGlobalInstructionsSetting {
	if (typeof enabled !== "boolean") throw refuse("enabled must be true or false");
	const settingsPath = persistentRoomGlobalInstructionsSettingPath(agentIdRaw, options);
	const settings: PersistentRoomGlobalInstructionsSetting = { schemaVersion: 1, enabled, updatedAt: now.toISOString() };
	fs.mkdirSync(path.dirname(settingsPath), { recursive: true, mode: 0o700 });
	fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n", { mode: 0o600 });
	return settings;
}
