import fs from "node:fs";
import path from "node:path";
import { DEFAULT_PERSISTENT_ROOM_AGENTS_ROOT, persistentAgentRootPath, readPersistentRoomDefaultCapabilityPolicy } from "./persistent-room-workspace-policy.js";
import { roomBoxComputer } from "./room-box/box-available.js";
import { localPath } from "./room-box/windows/box-request.js";

/**
 * Whether a room's commands run in its box: the one source every room-level
 * caller asks. Its file tools keep the box wherever the computer has one. The computer decides whether a box can work at all, a
 * Windows room's folder whether it can work there, and the person whether it runs.
 *
 * Her choice is kept in `<room>/runtime/protection.json` and read once, when the
 * server starts; from then on only `writePersistentRoomProtection` changes it,
 * in memory and on disk, so a file changed behind the app's back counts for
 * nothing until the next start. Missing, unreadable or anything but a
 * well-formed off reads On.
 */

/** Why a room can't be protected: this computer, the room's folder, or not known yet. */
export type PersistentRoomProtectionCause = "computer" | "folder" | "unknown";

/** As the reads and the chip carry it. Off with no cause: the person turned it off. */
export type PersistentRoomProtection = { state: "on" } | { state: "off"; cause?: PersistentRoomProtectionCause };

/** Whose a Run without asking given without protection was: hers, or the cause that stood. */
export type PersistentRoomUnprotectedBy = "person" | "computer" | "folder";

export interface PersistentRoomProtectionStorageOptions {
	persistentAgentsRoot?: string;
	/**
	 * Where a conversation is known (a bind, a command), its folder as Windows'
	 * box gets it (`conversationFolder` in room-box/windows/windows-engine.ts),
	 * which the caller works out only where `protectionJudgesFolder()`.
	 * Otherwise the room's default folder, by its text. A value, not a call: the
	 * fence's module can't be imported here, as it loads the workspace policy,
	 * which imports this one, and the saves that read protection must stay
	 * readable to folder-contract.ts.
	 */
	folder?: string | null;
}

const PROTECTED: PersistentRoomProtection = { state: "on" };

/** The state from its parts, so a stand-in computer can be judged as the real one is. */
export function protectionOf(parts: { computer: boolean | "unknown"; windows: boolean; folder: string | null; turnedOff: boolean }): PersistentRoomProtection {
	if (parts.computer === false) return { state: "off", cause: "computer" };
	if (parts.computer === "unknown") return { state: "off", cause: "unknown" };
	// The Windows box takes only a full local path: a network folder can't be kept in it.
	if (parts.windows && parts.folder !== null && localPath(parts.folder) === undefined) return { state: "off", cause: "folder" };
	return parts.turnedOff ? { state: "off" } : PROTECTED;
}

export function persistentRoomProtectionPath(agentId: string, options: PersistentRoomProtectionStorageOptions = {}): string {
	return path.join(persistentAgentRootPath(agentId, options.persistentAgentsRoot ?? DEFAULT_PERSISTENT_ROOM_AGENTS_ROOT), "runtime", "protection.json");
}

/** The rooms turned off, by their file's path, as read at start or set by the route since. */
const turnedOff = new Map<string, boolean>();

function storedOff(file: string): boolean {
	try {
		const raw = JSON.parse(fs.readFileSync(file, "utf-8"));
		return raw !== null && typeof raw === "object" && raw.schemaVersion === 1 && raw.state === "off";
	} catch {
		return false;
	}
}

/** At server start, beside the room scan: each room's stored choice, once. */
export function loadPersistentRoomProtection(agentIds: readonly string[], options: PersistentRoomProtectionStorageOptions = {}): void {
	for (const id of agentIds) {
		const file = persistentRoomProtectionPath(id, options);
		turnedOff.set(file, storedOff(file));
	}
}

/** A deleted room's choice goes with it: a room made with its name since starts with no file, so it reads On. */
export function forgetPersistentRoomProtection(agentId: string, options: PersistentRoomProtectionStorageOptions = {}): void {
	turnedOff.delete(persistentRoomProtectionPath(agentId, options));
}

/**
 * The folder judged for a room's default folder, from its stored root: as
 * typed, and as the fence resolves it. A mapped drive is typed as a drive and
 * resolves to its share, so whichever of the two the box can't keep is judged.
 */
export function defaultFolderJudged(root: { path: string; realpath?: string } | undefined): string | null {
	if (!root) return null;
	return [root.path, root.realpath].find((place) => place !== undefined && localPath(place) === undefined) ?? root.path;
}

/** Whether a room's protection judges its folder: on Windows alone. The rule reads Windows' own paths, so a computer acting as Windows keeps its own (protectionOf judges a stand-in). */
export function protectionJudgesFolder(): boolean {
	return roomBoxComputer() === "windows" && process.platform === "win32";
}

/** The folder a Windows room's protection judges: see `folder`. */
function judgedFolder(agentId: string, options: PersistentRoomProtectionStorageOptions): string | null {
	return options.folder !== undefined ? options.folder : defaultFolderJudged(readPersistentRoomDefaultCapabilityPolicy(agentId, options)?.roots[0]);
}

/** The room's protection now. A room the start never read, such as one made since, reads On unless the route turned it off. */
export function persistentRoomProtection(agentId: string, options: PersistentRoomProtectionStorageOptions = {}): PersistentRoomProtection {
	const box = roomBoxComputer();
	const windows = protectionJudgesFolder();
	return protectionOf({ computer: box === "unknown" ? "unknown" : box !== null, windows, folder: windows ? judgedFolder(agentId, options) : null, turnedOff: turnedOff.get(persistentRoomProtectionPath(agentId, options)) === true });
}

export function persistentRoomProtected(agentId: string, options: PersistentRoomProtectionStorageOptions = {}): boolean {
	return persistentRoomProtection(agentId, options).state === "on";
}

/** Whether the room's commands run in Windows' box now: where Git for Windows plays no part in them. */
export function persistentRoomWindowsBoxed(agentId: string, options: PersistentRoomProtectionStorageOptions = {}): boolean {
	return roomBoxComputer() === "windows" && persistentRoomProtected(agentId, options);
}

/** Whether the room's box could run, whatever she chose: what a start-on default and an automatic yes follow. */
export function persistentRoomProtectionCanRun(agentId: string, options: PersistentRoomProtectionStorageOptions = {}): boolean {
	const protection = persistentRoomProtection(agentId, options);
	return protection.state === "on" || protection.cause === undefined;
}

/** Who a yes given in this state belongs to, or null where it is protected or not known. */
export function unprotectedBy(protection: PersistentRoomProtection): PersistentRoomUnprotectedBy | null {
	if (protection.state === "on" || protection.cause === "unknown") return null;
	return protection.cause ?? "person";
}

/** Whether the room, not the computer, is why its commands reach every file: she turned protection off, or its folder is why. */
export function unprotectedByRoom(protection: PersistentRoomProtection): boolean {
	return protection.state === "off" && (protection.cause === undefined || protection.cause === "folder");
}

export function sameProtection(a: PersistentRoomProtection, b: PersistentRoomProtection): boolean {
	return a.state === b.state && (a.state === "on" || (b.state === "off" && a.cause === b.cause));
}

/** A protection as a request carries it, or null for anything else. */
export function parsePersistentRoomProtection(value: unknown): PersistentRoomProtection | null {
	if (value === null || typeof value !== "object") return null;
	const { state, cause } = value as { state?: unknown; cause?: unknown };
	if (state === "on" && cause === undefined) return PROTECTED;
	if (state !== "off") return null;
	if (cause === undefined) return { state: "off" };
	return cause === "computer" || cause === "folder" || cause === "unknown" ? { state: "off", cause } : null;
}

/**
 * The person's own Turn off or Turn on, from the app's control alone: stored,
 * then held. A failed write changes nothing. Only the settings route imports it.
 */
export function writePersistentRoomProtection(agentId: string, state: "on" | "off", options: PersistentRoomProtectionStorageOptions = {}, now = new Date()): void {
	const file = persistentRoomProtectionPath(agentId, options);
	fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
	const temporary = `${file}.${process.pid}.tmp`;
	fs.writeFileSync(temporary, JSON.stringify({ schemaVersion: 1, state, updatedAt: now.toISOString() }, null, 2) + "\n", { mode: 0o600 });
	fs.renameSync(temporary, file);
	turnedOff.set(file, state === "off");
}
