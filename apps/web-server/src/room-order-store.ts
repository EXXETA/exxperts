import fs from "node:fs";
import path from "node:path";
import { productAppStatePath } from "../../../pi-package/product-state-paths.js";
import { ROOM_ORDER_DEFAULT_MODE, ROOM_ORDER_MODES, isRoomOrderMode, mergeRoomOrderCustomOrder, sanitizeRoomOrderCustomOrder, validateRoomOrderCustomOrder, validateRoomOrderMode, type RoomOrderPreference } from "./room-order.js";

/**
 * The saved order of the home screen, one small file under the app's state
 * folder: ~/.exxperts/app/room-order.json. In the state folder rather than in
 * the browser so that every door (the desktop app, a terminal install, another
 * browser, the phone) shows the same order, and a data profile carries its own.
 *
 * Reading never fails the home screen. No file is the order the home screen
 * always had; a file this build cannot understand is a third state,
 * `unreadable`, said in words without a path, and the rooms show A to Z.
 */

export const ROOM_ORDER_FILENAME = "room-order.json";

export interface RoomOrderStorageOptions {
	/** Where the app's state files live; the product state root when omitted. Smokes point it at a temp folder. */
	appStateRoot?: string;
}

export interface StoredRoomOrder {
	preference: RoomOrderPreference;
	/** When the preference was last saved; null when nothing was. */
	updatedAt: string | null;
	/** Set when something sits at the path and cannot be used: what is wrong with it, path-free. */
	unreadable?: string;
	/**
	 * Set when a save would be refused for what sits at the path (a folder,
	 * the one thing a save cannot replace). The home screen offers "choose an
	 * order" as the way out of every other unreadable state, and must not
	 * offer it for this one; it reads this flag, never the wording above.
	 */
	saveBlocked?: true;
}

export function roomOrderPath(options: RoomOrderStorageOptions = {}): string {
	return path.join(options.appStateRoot ?? productAppStatePath(), ROOM_ORDER_FILENAME);
}

/**
 * The ONE test for the state a save refuses: a folder at the path itself. A
 * link to a folder is not one (the rename replaces the link), which is why
 * this looks at the path and never at what it leads to. The read reports it
 * and the save refuses on it, so the two cannot disagree.
 */
function folderSitsAt(file: string): boolean {
	try {
		return fs.lstatSync(file).isDirectory();
	} catch {
		return false;
	}
}

function nothingSaved(unreadable?: string, file?: string): StoredRoomOrder {
	return {
		preference: { mode: ROOM_ORDER_DEFAULT_MODE, customOrder: [] },
		updatedAt: null,
		...(unreadable ? { unreadable } : {}),
		...(unreadable && file && folderSitsAt(file) ? { saveBlocked: true as const } : {}),
	};
}

function errorCode(error: unknown): string {
	return String((error as { code?: unknown } | null)?.code ?? "");
}

function describeReadProblem(error: unknown): string {
	const code = errorCode(error);
	if (code === "EACCES" || code === "EPERM") return "the app has no permission to read it";
	if (code === "EISDIR") return "it is a folder, not a file";
	if (code === "ENOENT") return "it is a link that points nowhere";
	if (code === "ELOOP") return "it is a link that loops";
	return "it could not be read";
}

/** True when a link (or anything) sits at the path, even one that leads nowhere. */
function somethingSitsAt(file: string): boolean {
	try {
		fs.lstatSync(file);
		return true;
	} catch {
		return false;
	}
}

/**
 * A mode this build does not know is not a broken file: it is what a newer
 * build saved. It reads as A to Z and the file is left exactly as it is, so
 * the newer build finds its order again.
 */
export function readRoomOrder(options: RoomOrderStorageOptions = {}): StoredRoomOrder {
	const file = roomOrderPath(options);
	try {
		let raw: string;
		try {
			const stat = fs.statSync(file);
			// Only a regular file is read: opening a pipe or a device would block
			// the whole server, synchronously, until something wrote to it.
			if (!stat.isFile()) return nothingSaved(stat.isDirectory() ? "it is a folder, not a file" : "it is not a file", file);
			raw = fs.readFileSync(file, "utf-8");
		} catch (error) {
			const code = errorCode(error);
			if ((code === "ENOENT" || code === "ENOTDIR") && !somethingSitsAt(file)) return nothingSaved();
			return nothingSaved(describeReadProblem(error));
		}
		let parsed: unknown;
		try {
			parsed = JSON.parse(raw);
		} catch {
			return nothingSaved("its contents are not what the app saved");
		}
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return nothingSaved("its contents are not what the app saved");
		const document = parsed as { mode?: unknown; customOrder?: unknown; updatedAt?: unknown };
		return {
			preference: {
				mode: isRoomOrderMode(document.mode) ? document.mode : ROOM_ORDER_DEFAULT_MODE,
				customOrder: sanitizeRoomOrderCustomOrder(document.customOrder),
			},
			updatedAt: typeof document.updatedAt === "string" && !Number.isNaN(Date.parse(document.updatedAt)) ? document.updatedAt : null,
		};
	} catch (error) {
		return nothingSaved(describeReadProblem(error));
	}
}

/**
 * What the route answers when the write itself fails. Here rather than in the
 * route so the smoke can hold it: like the folder refusal below, it speaks of
 * the attempt ("failed", "was not changed") and never of the disk as it is,
 * because the home screen keeps a failed save's sentence until the next save
 * and another door may have saved something else by then.
 */
export const ROOM_ORDER_SAVE_FAILED_SENTENCE = "Saving the order failed because of a server error, and the saved order was not changed. Check the server logs for details.";

function refuse(message: string): Error {
	const error = new Error(message);
	(error as any).statusCode = 400;
	return error;
}

/** Which rooms a request must not see: a remote device's hidden rooms. Null for the computer's own screen, which sees everything. */
export type HiddenRooms = ((roomId: string) => boolean) | null;

/**
 * What the routes answer. The arrangement goes out as ids, but never one of
 * a room the asking device cannot see: a remote device gets the list with
 * its hidden rooms left out, and what it sends back is merged into the whole
 * (mergeRoomOrderCustomOrder), so the hidden ones keep their places (except
 * at the merge's ceiling, where unsent ids make room from the end) without
 * their ids ever leaving this machine.
 */
export function roomOrderPayload(stored: StoredRoomOrder, hidden: HiddenRooms = null): { order: { mode: string; customOrder: string[]; updatedAt: string | null; unreadable?: string; saveBlocked?: true }; modes: readonly string[] } {
	const customOrder = hidden ? stored.preference.customOrder.filter((id) => !hidden(id)) : stored.preference.customOrder;
	return { order: { mode: stored.preference.mode, customOrder, updatedAt: stored.updatedAt, ...(stored.unreadable ? { unreadable: stored.unreadable } : {}), ...(stored.saveBlocked ? { saveBlocked: true as const } : {}) }, modes: ROOM_ORDER_MODES };
}

/**
 * Save a choice: the mode always, the arrangement when the user arranged.
 * An arrangement is merged into the saved one, never put in its place
 * (mergeRoomOrderCustomOrder); a choice without one leaves the arrangement
 * exactly as it was, so going to A to Z and back finds it. A remote device
 * arranges only the rooms it can see: an id of a hidden room in what it
 * sends is left out before the merge (it can only be a room hidden since
 * the device's list was drawn, which for the device has vanished, and an
 * id not sent keeps its slot, the merge's ceiling apart), so the device is
 * never answered about a room it cannot see.
 *
 * A file that cannot be read is replaced, which is the way out the home
 * screen offers for it (there is nothing in it this build could keep). A
 * folder at the path cannot be replaced by a rename; that one case is refused
 * with the remedy in the sentence. The sentence speaks of the attempt ("was
 * not saved", "was found"), not of the disk as it is: the home screen keeps a
 * failed save's sentence until the next save, and by then the folder may be
 * gone. Every other failure of the write itself is
 * the server's, tagged 500 so the route answers with its own sentence and
 * never the file system's; the previous file is still in place, because the
 * rename is the only step that touches it.
 */
export function saveRoomOrder(choiceRaw: unknown, options: RoomOrderStorageOptions = {}, now = new Date(), hidden: HiddenRooms = null): StoredRoomOrder {
	const choice = choiceRaw && typeof choiceRaw === "object" && !Array.isArray(choiceRaw) ? (choiceRaw as { mode?: unknown; customOrder?: unknown }) : {};
	const mode = validateRoomOrderMode(choice.mode);
	const validated = choice.customOrder === undefined ? null : validateRoomOrderCustomOrder(choice.customOrder);
	const submitted = validated && hidden ? validated.filter((id) => !hidden(id)) : validated;
	const file = roomOrderPath(options);
	if (folderSitsAt(file)) throw refuse(`The order was not saved: a folder was found where the saved order (${ROOM_ORDER_FILENAME}) belongs. Remove that folder, then choose the order again.`);

	const saved = readRoomOrder(options).preference.customOrder;
	const preference: RoomOrderPreference = { mode, customOrder: submitted ? mergeRoomOrderCustomOrder(saved, submitted) : saved };
	const updatedAt = now.toISOString();
	const tmp = `${file}.tmp-${process.pid}-${now.getTime()}`;
	try {
		fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
		try {
			fs.writeFileSync(tmp, `${JSON.stringify({ schemaVersion: 1, ...preference, updatedAt }, null, 2)}\n`, { mode: 0o600 });
			fs.renameSync(tmp, file);
		} catch (error) {
			// The clean-up is a courtesy; it must never replace the failure that matters.
			try { fs.rmSync(tmp, { force: true }); } catch { /* keep the write's own error */ }
			throw error;
		}
	} catch (error) {
		if (!(error as any).statusCode) (error as any).statusCode = 500;
		throw error;
	}
	return { preference, updatedAt };
}
