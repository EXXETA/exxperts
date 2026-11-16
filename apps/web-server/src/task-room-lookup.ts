// The room a task belongs to, by its ledger record (persistent-room-task-ledger.ts).
// The artifact route (artifact-routes.ts) serves a task's shelf files from this
// room, and an edition's request guard may ask the same question, among the
// person's own rooms, before the route runs: both judge by taskRoomAmong.
//
// It loads no server and keeps no state path: the rooms folder is resolved at
// each call, since a caller may load before the server's state folder is set.
import fs from "node:fs";
import path from "node:path";

import { productAppStatePath } from "../../../pi-package/product-state-paths.js";

// The ledger's own id rules (persistent-room-task-ledger.ts), so that a task id
// never builds a path the ledger would not.
const ROOM_ID = /^[a-zA-Z0-9_-]{1,160}$/;
const TASK_ID = /^[a-zA-Z0-9_-]{1,80}$/;

// PERSISTENT_AGENTS_ROOT (persistent-agent-store.ts), resolved now; the two change together.
function roomsFolder(): string {
	return process.env.EXXETA_PERSISTENT_AGENTS_ROOT || productAppStatePath("personalized-agents");
}

// "held", "absent", or "unknown" when the disk would not say.
async function ledgerFileState(file: string): Promise<"held" | "absent" | "unknown"> {
	try {
		return (await fs.promises.lstat(file)).isFile() ? "held" : "unknown";
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		return code === "ENOENT" || code === "ENOTDIR" ? "absent" : "unknown";
	}
}

// Whether the record at this file is the task's own record in this room.
async function ledgerNamesRoom(file: string, taskId: string, roomId: string): Promise<boolean> {
	try {
		const record: unknown = JSON.parse(await fs.promises.readFile(file, "utf8"));
		if (typeof record !== "object" || record === null) return false;
		const { schemaVersion, taskId: recordTask, roomId: recordRoom } = record as Record<string, unknown>;
		return schemaVersion === 1 && recordTask === taskId && recordRoom === roomId;
	} catch {
		return false;
	}
}

/**
 * The id of the one room whose ledger holds this task, or null: for an id the
 * ledger would refuse, no room or more than one, a room the disk would not
 * answer for, and a record that cannot be read or is not this task's in that room.
 */
export async function roomIdOfTask(taskId: string): Promise<string | null> {
	if (!TASK_ID.test(taskId)) return null;
	let entries: fs.Dirent[];
	try {
		entries = await fs.promises.readdir(roomsFolder(), { withFileTypes: true });
	} catch {
		return null;
	}
	return taskRoomAmong(taskId, entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name));
}

/**
 * The judge both lookups share: among these rooms, each id asked once, the id
 * of the one room whose ledger holds this task, or null as roomIdOfTask gives
 * it. An edition's guard may ask it over the person's own rooms: a room
 * outside the list is never read. One lstat of the ledger file per room,
 * and one read of the one record found.
 */
export async function taskRoomAmong(taskId: string, roomIds: Iterable<string>): Promise<string | null> {
	if (!TASK_ID.test(taskId)) return null;
	const root = roomsFolder();
	let found: { roomId: string; file: string } | null = null;
	for (const roomId of new Set(roomIds)) {
		if (!ROOM_ID.test(roomId)) continue;
		const file = path.join(root, roomId, "runtime", "task-ledger", `${taskId}.json`);
		const state = await ledgerFileState(file);
		if (state === "absent") continue;
		if (state === "unknown" || found) return null;
		found = { roomId, file };
	}
	if (!found) return null;
	return (await ledgerNamesRoom(found.file, taskId, found.roomId)) ? found.roomId : null;
}
