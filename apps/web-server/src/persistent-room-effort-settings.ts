import fs from "node:fs";
import path from "node:path";
import { safeRuntimeThreadId, writeFileAtomic } from "./persistent-agent-store.js";
import { DEFAULT_PERSISTENT_ROOM_AGENTS_ROOT, persistentAgentRootPath } from "./persistent-room-workspace-policy.js";

/**
 * The room's default reasoning effort, for new conversations.
 *
 * The effort last picked in the room (an explicit pick in any conversation),
 * or the models route's `effort`, sets how hard the model thinks in a
 * conversation that has no level of its own yet (the per-conversation choice below). It rides every
 * such conversation's turns, including turns sent after leaving and
 * re-entering, and a turn that detaches and finishes with nobody watching.
 *
 * A record exists ONLY after an explicit choice. No record means the room has
 * never been asked, and a room that has never been asked keeps whatever level
 * the session resolved for itself at creation, which is the machine-wide
 * default. Writing a "default" record on a room's behalf would silently
 * override that default for every room the moment it was first opened.
 *
 * This is also deliberately NOT the runtime's machine-wide default thinking
 * level. That default belongs to the person at the CLI, and a room must never
 * move it (see `applyRoomEffortToSession` in ai-models.ts, which sets the level on the bound
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
	return readEffortRecord(persistentRoomEffortSettingsPath(agentIdRaw, options));
}

export function writePersistentRoomEffortChoice(agentIdRaw: string, level: unknown, options: PersistentRoomEffortSettingsStorageOptions = {}, now = new Date()): PersistentRoomEffortSettings {
	if (!isRoomEffortLevel(level)) throw new Error("level must be a known reasoning effort level");
	const settingsPath = persistentRoomEffortSettingsPath(agentIdRaw, options);
	const settings: PersistentRoomEffortSettings = { schemaVersion: 1, level, updatedAt: now.toISOString() };
	writeEffortRecord(settingsPath, settings);
	return settings;
}

/** A temporary file, then a rename: a cut write leaves the old level, never half a file. */
function writeEffortRecord(file: string, settings: PersistentRoomEffortSettings): void {
	fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
	writeFileAtomic(file, JSON.stringify(settings, null, 2) + "\n");
}

/**
 * Per-conversation reasoning effort.
 *
 * A pick in the message box changes the open conversation, and becomes the
 * room's record above, the default a new conversation starts from; other
 * conversations keep their own. Each conversation's choice lives in a file of its own, so a
 * save of the conversation (which rebuilds the thread record) can never drop
 * it, and two conversations never write the same file.
 *
 * A conversation with no file follows the room's default. It gets a file of
 * its own at its first message (and, for a conversation from before this
 * existed, at its next bind): the room's default, or the level it runs at when
 * the room has none. So a later change of the default reaches only new
 * conversations. Stored raw, like the room's record.
 */
function conversationEffortPath(agentIdRaw: string, threadIdRaw: string, options: PersistentRoomEffortSettingsStorageOptions = {}): string {
	const threadId = safeRuntimeThreadId(threadIdRaw);
	if (!threadId) throw new Error("invalid persistent-agent thread id");
	return path.join(path.dirname(persistentRoomEffortSettingsPath(agentIdRaw, options)), "effort", `${threadId}.json`);
}

function readEffortRecord(file: string): RoomEffortLevel | null {
	try {
		if (!fs.existsSync(file)) return null;
		const raw = JSON.parse(fs.readFileSync(file, "utf-8"));
		if (!raw || typeof raw !== "object" || raw.schemaVersion !== 1) return null;
		return isRoomEffortLevel(raw.level) ? raw.level : null;
	} catch {
		return null;
	}
}

/** The conversation's own chosen level, or null when it has none yet (it then follows the room's default). */
export function readConversationEffortChoice(agentIdRaw: string, threadIdRaw: string, options: PersistentRoomEffortSettingsStorageOptions = {}): RoomEffortLevel | null {
	try {
		return readEffortRecord(conversationEffortPath(agentIdRaw, threadIdRaw, options));
	} catch {
		return null;
	}
}

/** The level a conversation runs at: its own, else the room's default, else null (the session keeps the level it resolved itself). */
export function effectiveConversationEffortChoice(agentIdRaw: string, threadIdRaw: string, options: PersistentRoomEffortSettingsStorageOptions = {}): RoomEffortLevel | null {
	return readConversationEffortChoice(agentIdRaw, threadIdRaw, options) ?? readPersistentRoomEffortChoice(agentIdRaw, options);
}

export function writeConversationEffortChoice(agentIdRaw: string, threadIdRaw: string, level: unknown, options: PersistentRoomEffortSettingsStorageOptions = {}, now = new Date()): PersistentRoomEffortSettings {
	if (!isRoomEffortLevel(level)) throw new Error("level must be a known reasoning effort level");
	const file = conversationEffortPath(agentIdRaw, threadIdRaw, options);
	const settings: PersistentRoomEffortSettings = { schemaVersion: 1, level, updatedAt: now.toISOString() };
	writeEffortRecord(file, settings);
	return settings;
}

/**
 * Gives a conversation with no level of its own one: the room's current
 * default, else `inForce`, the level its session runs at when the room has no
 * default. Called at its first message, and at the bind of a conversation that
 * already has messages. Run twice, it writes once. Returns the level the
 * conversation now runs at, or null when there is none anywhere. A failed write
 * is swallowed: the turn still runs at that level, only the keeping is lost,
 * and the next message tries again.
 */
export function settleConversationEffortChoice(agentIdRaw: string, threadIdRaw: string, inForce: unknown = null, options: PersistentRoomEffortSettingsStorageOptions = {}): RoomEffortLevel | null {
	const own = readConversationEffortChoice(agentIdRaw, threadIdRaw, options);
	if (own) return own;
	const level = readPersistentRoomEffortChoice(agentIdRaw, options) ?? (isRoomEffortLevel(inForce) ? inForce : null);
	if (!level) return null;
	try {
		writeConversationEffortChoice(agentIdRaw, threadIdRaw, level, options);
	} catch (error) {
		console.warn(`[effort] the conversation's level could not be kept: ${error instanceof Error ? error.message : String(error)}`);
	}
	return level;
}
