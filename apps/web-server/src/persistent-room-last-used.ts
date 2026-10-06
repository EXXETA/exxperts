import fs from "node:fs";
import path from "node:path";
import { DEFAULT_PERSISTENT_ROOM_AGENTS_ROOT, persistentAgentRootPath } from "./persistent-room-workspace-policy.js";

/**
 * When a room was last used: the stamp the home screen's "Recently used"
 * order reads.
 *
 * "Used" is a turn starting in the room, through any door. No other record
 * carries that moment (a turn's start time lives in memory only, and a
 * conversation's `updatedAt` also moves on cache writes, handoffs and
 * maintenance), so this small file in the room's runtime folder is the only
 * source. A turn has two writers, one per process that can run one: the
 * server (`beginPersistentAgentTurn`, which the browser, the phone, detached
 * turns and scheduled runs all go through) and the terminal door (cli-rooms).
 * Each already holds the room when it writes, so a turn's stamp replaces
 * whatever is there, with no guard and no shared file; both call the ONE
 * `recordPersistentRoomLastUsed` below.
 *
 * The stamp is a courtesy to the home screen and must never cost a turn
 * anything: recording cannot throw, whatever the disk does. A failure is
 * logged with its cause and the room simply keeps its previous stamp.
 *
 * A room that was in use before the stamp existed is given one once, from
 * the newest change of any conversation somebody spoke in, closed ones
 * included (persistent-agents.ts, the status builder): door "estimate", so it
 * reads as what it is. That third writer holds no room, and the status is
 * built by the server and by the terminal alike, so it goes through
 * `recordPersistentRoomLastUsedIfAbsent`: it never replaces a stamp, whoever
 * wrote it in between. The room's first turn replaces the estimate.
 */
export type PersistentRoomLastUsedDoor = "server" | "cli" | "estimate";

export interface PersistentRoomLastUsed {
	schemaVersion: 1;
	lastUsedAt: string;
	/** Which process wrote the stamp; null when the record does not say. */
	door: PersistentRoomLastUsedDoor | null;
}

export interface PersistentRoomLastUsedStorageOptions {
	persistentAgentsRoot?: string;
}

function safeLastUsedAgentId(raw: string): string {
	const id = String(raw ?? "").trim();
	if (!/^[a-zA-Z0-9_-]{1,160}$/.test(id)) throw new Error("invalid persistent-room agent id");
	return id;
}

export function persistentRoomLastUsedPath(agentIdRaw: string, options: PersistentRoomLastUsedStorageOptions = {}): string {
	const agentId = safeLastUsedAgentId(agentIdRaw);
	return path.join(persistentAgentRootPath(agentId, options.persistentAgentsRoot ?? DEFAULT_PERSISTENT_ROOM_AGENTS_ROOT), "runtime", "last-used.json");
}

/**
 * The stamp as written, or null when the room was never stamped or the record
 * cannot be understood. A time that does not parse is no time: the order
 * compares these as numbers, and one bad record must not unsettle it. Only a
 * regular file is read: opening a pipe or a device would block the whole
 * server, synchronously, until something wrote to it.
 */
export function readPersistentRoomLastUsed(agentIdRaw: string, options: PersistentRoomLastUsedStorageOptions = {}): PersistentRoomLastUsed | null {
	try {
		const file = persistentRoomLastUsedPath(agentIdRaw, options);
		if (!fs.statSync(file).isFile()) return null;
		const raw = JSON.parse(fs.readFileSync(file, "utf-8"));
		if (!raw || typeof raw !== "object" || raw.schemaVersion !== 1 || typeof raw.lastUsedAt !== "string") return null;
		if (!Number.isFinite(Date.parse(raw.lastUsedAt))) return null;
		return { schemaVersion: 1, lastUsedAt: raw.lastUsedAt, door: raw.door === "server" || raw.door === "cli" || raw.door === "estimate" ? raw.door : null };
	} catch {
		return null;
	}
}

/** Stamp the room as used now: a turn's stamp, replacing whatever is there. Never throws. */
export function recordPersistentRoomLastUsed(agentIdRaw: string, door: PersistentRoomLastUsedDoor, options: PersistentRoomLastUsedStorageOptions = {}, now = new Date()): void {
	try {
		writeStamp(agentIdRaw, { schemaVersion: 1, lastUsedAt: now.toISOString(), door }, options, "replace");
	} catch (error) {
		console.warn(`[room-last-used] agent=${JSON.stringify(String(agentIdRaw))} door=${door}: the stamp was not written: ${(error as Error)?.message ?? String(error)}`);
	}
}

/**
 * Write `record` as the room's stamp only if the room has none: the estimate's
 * write. Never throws. Returns what the room holds afterwards: the record
 * written, the stamp that was already there or arrived meanwhile (the link
 * into place fails when a file exists, so a turn stamped by the other process
 * between the caller's read and this write wins), or null when nothing could
 * be written and nothing is there.
 */
export function recordPersistentRoomLastUsedIfAbsent(agentIdRaw: string, record: PersistentRoomLastUsed, options: PersistentRoomLastUsedStorageOptions = {}): PersistentRoomLastUsed | null {
	try {
		const written = writeStamp(agentIdRaw, record, options, "if-absent");
		return readPersistentRoomLastUsed(agentIdRaw, options) ?? (written ? record : null);
	} catch (error) {
		if ((error as NodeJS.ErrnoException)?.code === "EEXIST") return readPersistentRoomLastUsed(agentIdRaw, options);
		console.warn(`[room-last-used] agent=${JSON.stringify(String(agentIdRaw))} door=${record.door}: the stamp was not written: ${(error as Error)?.message ?? String(error)}`);
		return null;
	}
}

/**
 * The write itself, whole and atomic: a temporary file of this process's own,
 * then one step into place, so a reader never finds half a record and two
 * writers cannot tread on each other's temporary file. "replace" renames over
 * whatever is there; "if-absent" links, which fails with EEXIST when a stamp
 * exists. Only a room that is there is stamped: a room purged while its turn
 * was starting must not get its folder back from here, so nothing above the
 * runtime folder is ever created (false is returned). Throws; the callers
 * decide what a failure means.
 */
function writeStamp(agentIdRaw: string, record: PersistentRoomLastUsed, options: PersistentRoomLastUsedStorageOptions, mode: "replace" | "if-absent"): boolean {
	const file = persistentRoomLastUsedPath(agentIdRaw, options);
	const runtimeDir = path.dirname(file);
	if (!fs.existsSync(path.dirname(runtimeDir))) return false;
	if (!fs.existsSync(runtimeDir)) fs.mkdirSync(runtimeDir, { mode: 0o700 });
	const tmp = `${file}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
	try {
		fs.writeFileSync(tmp, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
		if (mode === "replace") fs.renameSync(tmp, file);
		else fs.linkSync(tmp, file);
		return true;
	} finally {
		// The clean-up is a courtesy; it must never replace the failure that matters.
		try { fs.rmSync(tmp, { force: true }); } catch { /* keep the write's own error */ }
	}
}
