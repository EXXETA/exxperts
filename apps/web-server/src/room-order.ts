/**
 * The order of the rooms on the home screen: the ONE place that knows which
 * orders exist, what a saved preference may contain, and how a list of rooms
 * is put into an order.
 *
 * Browser-safe on purpose (no node imports): the server validates a save
 * against the same list of modes the home screen offers, and the home screen
 * orders its cards with the same function the smoke holds to its rules. Nothing
 * else sorts rooms; a second `.sort` over rooms anywhere is a bug.
 */

/** Every order this build can show. A mode is added here in the slice that can honour it, never before. */
export const ROOM_ORDER_MODES = ["recent", "name-asc", "name-desc", "custom"] as const;
export type RoomOrderMode = (typeof ROOM_ORDER_MODES)[number];

/**
 * What a home screen without a saved preference shows: the order it always
 * had, with one difference, numbers in names now count as numbers.
 */
export const ROOM_ORDER_DEFAULT_MODE: RoomOrderMode = "name-asc";

/** A ceiling for the saved arrangement, far above any real number of rooms; it bounds the file, nothing else. */
export const ROOM_ORDER_CUSTOM_MAX = 2000;

const ROOM_ID_PATTERN = /^[a-zA-Z0-9_-]{1,160}$/;

export interface RoomOrderPreference {
	mode: RoomOrderMode;
	/** The user's own arrangement, as room ids. Kept across every change of mode; never trusted to be total. */
	customOrder: string[];
}

/** The two fields of a room the name orders read. */
export interface RoomOrderable {
	id: string;
	displayName?: string;
}

/**
 * When each room was last used, as the order reads it: room id to a time in
 * milliseconds. A room that is not in it was never used, as far as the order
 * knows. A map of its own rather than a field read off the rooms, so the home
 * screen can hold one still for a whole visit while the rooms themselves go
 * on changing under it.
 */
export type RoomLastUsedTimes = ReadonlyMap<string, number>;

export function isRoomOrderMode(value: unknown): value is RoomOrderMode {
	return typeof value === "string" && (ROOM_ORDER_MODES as readonly string[]).includes(value);
}

function refuse(message: string): Error {
	const error = new Error(message);
	(error as any).statusCode = 400;
	return error;
}

/** A mode as a save sends it. Anything this build cannot show is refused, so the file never holds an order the screen cannot name. */
export function validateRoomOrderMode(value: unknown): RoomOrderMode {
	if (!isRoomOrderMode(value)) throw refuse(`mode must be one of: ${ROOM_ORDER_MODES.join(", ")}`);
	return value;
}

/** What a save carries: the mode always (a save states the order it wants), the arrangement when the user arranged. */
export interface RoomOrderChoice {
	mode: RoomOrderMode;
	customOrder?: string[];
}

/**
 * The arrangement as a save sends it: strict, because the client that sends
 * it built it from rooms it was shown. Every entry a well-formed id, none
 * twice, never above the ceiling; anything else is refused as the client's
 * to fix. The sentences are about the request, not about the disk.
 */
export function validateRoomOrderCustomOrder(value: unknown): string[] {
	if (!Array.isArray(value)) throw refuse("customOrder must be a list of room ids");
	if (value.length > ROOM_ORDER_CUSTOM_MAX) throw refuse(`customOrder must hold at most ${ROOM_ORDER_CUSTOM_MAX} room ids`);
	const seen = new Set<string>();
	for (const entry of value) {
		if (typeof entry !== "string" || !ROOM_ID_PATTERN.test(entry)) throw refuse("customOrder must hold well-formed room ids");
		if (seen.has(entry)) throw refuse("customOrder must not name a room twice");
		seen.add(entry);
	}
	return [...seen];
}

/**
 * Merge on write, the ONE rule for putting an arrangement a client sent into
 * the one that is saved. The client arranged the rooms it was shown, which
 * may be fewer than the saved list holds (a remote device sees only its
 * exposed rooms; a room archived since still has its id in the list) or
 * more (a room that was never listed). So: the saved list is first extended
 * with the sent ids it does not hold (appended, in the order sent); then the
 * sent ids are placed, in the order sent, into the slots those ids occupy in
 * the extended list; every other id keeps its slot. A save never replaces
 * the list; two clients saving in turn both land, and the later one wins
 * wherever it sent ids (the home screen sends every card it shows, so a
 * later full save takes every slot; a device that saw a subset moves only
 * within its own slots). What is kept is bounded by ROOM_ORDER_CUSTOM_MAX,
 * the same ceiling a read applies: when the extended list would exceed it,
 * ids that were NOT sent are dropped from the end until it fits, so the
 * arrangement just made is never the part that falls off: after the drop
 * the list is at most the ceiling long, and a read keeps all of it. Only at
 * the ceiling can a save drop an id the client did not see.
 */
export function mergeRoomOrderCustomOrder(saved: readonly string[], submitted: readonly string[]): string[] {
	const held = new Set(saved);
	const extended = [...saved, ...submitted.filter((id) => !held.has(id))];
	const sent = new Set(submitted);
	const merged = extended.slice();
	let next = 0;
	for (let slot = 0; slot < extended.length; slot++) {
		if (sent.has(extended[slot])) merged[slot] = submitted[next++];
	}
	for (let slot = merged.length - 1; merged.length > ROOM_ORDER_CUSTOM_MAX && slot >= 0; slot--) {
		if (!sent.has(merged[slot])) merged.splice(slot, 1);
	}
	return merged;
}

/**
 * Reconcile on read, the ONE rule for showing rooms in an arrangement that is
 * never trusted to be total: rooms whose id is in the list come first, in the
 * list's order; an id that names no room here (archived, purged, hidden from
 * this device) is skipped; rooms the list does not name come after, A to Z.
 * The list is never rewritten to clean it: a restored room finds its place
 * again.
 */
export function reconcileRoomsByCustomOrder<T extends RoomOrderable>(rooms: readonly T[], customOrder: readonly string[]): T[] {
	const byId = new Map<string, T>();
	for (const room of rooms) if (!byId.has(room.id)) byId.set(room.id, room);
	const placed: T[] = [];
	const seen = new Set<string>();
	for (const id of customOrder) {
		const room = byId.get(id);
		if (!room || seen.has(id)) continue;
		seen.add(id);
		placed.push(room);
	}
	const rest = rooms.filter((room) => !seen.has(room.id)).sort(compareRoomsByName);
	return [...placed, ...rest];
}

/**
 * The arrangement as found in a file somebody else may have written: every
 * well-formed id once, in the order found, the rest dropped. Lenient because
 * it is a read; a save validates strictly instead.
 */
export function sanitizeRoomOrderCustomOrder(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	const seen = new Set<string>();
	for (const entry of value) {
		if (typeof entry !== "string" || !ROOM_ID_PATTERN.test(entry) || seen.has(entry)) continue;
		seen.add(entry);
		if (seen.size >= ROOM_ORDER_CUSTOM_MAX) break;
	}
	return [...seen];
}

// The comparison the home screen always used (`localeCompare` on the name,
// the id where there is none), with one option added: digits count as numbers,
// "Room 2" before "Room 10". Nothing else differs, so a home screen nobody has
// touched keeps its order on upgrade except where a number was read as text.
// Built once; the locale is the runtime's.
const nameCollator = new Intl.Collator(undefined, { numeric: true });

function shownName(room: RoomOrderable): string {
	return room.displayName || room.id;
}

/**
 * A to Z, total: two different rooms never compare equal. Two rooms with the
 * same name fall back to their ids, so the order is the same on every load.
 */
export function compareRoomsByName(a: RoomOrderable, b: RoomOrderable): number {
	const byName = nameCollator.compare(shownName(a), shownName(b));
	if (byName !== 0) return byName;
	return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * The ONE reading of the rooms' last-used times. Each time is parsed here,
 * once; one that is absent or does not parse leaves its room out (never used),
 * so no comparison ever sees a NaN and the order stays total whatever a
 * record holds.
 */
export function roomLastUsedTimes(rooms: ReadonlyArray<{ id: string; lastUsedAt?: string | null }>): Map<string, number> {
	const times = new Map<string, number>();
	for (const room of rooms) {
		const time = typeof room.lastUsedAt === "string" ? Date.parse(room.lastUsedAt) : Number.NaN;
		if (Number.isFinite(time)) times.set(room.id, time);
	}
	return times;
}

/**
 * Recently used, total: the room used last comes first; rooms never used come
 * after all the used ones, A to Z; two rooms used at the same instant fall
 * back to A to Z as well (which itself falls back to the id).
 */
export function compareRoomsByRecentUse(lastUsed: RoomLastUsedTimes): (a: RoomOrderable, b: RoomOrderable) => number {
	return (a, b) => {
		const usedA = lastUsed.get(a.id);
		const usedB = lastUsed.get(b.id);
		if (usedA !== undefined && usedB !== undefined && usedA !== usedB) return usedA > usedB ? -1 : 1;
		if ((usedA === undefined) !== (usedB === undefined)) return usedA === undefined ? 1 : -1;
		return compareRoomsByName(a, b);
	};
}

/**
 * The rooms in the preferred order, as a new array. Z to A is A to Z read
 * backwards, ties included. Recently used reads `lastUsed` and nothing else;
 * without it no room was ever used, which is A to Z. Custom reads the
 * arrangement and nothing else (reconcileRoomsByCustomOrder); without one,
 * every room is in the tail, which is A to Z.
 */
export function orderRooms<T extends RoomOrderable>(rooms: readonly T[], preference: { mode: RoomOrderMode; customOrder?: readonly string[] }, lastUsed: RoomLastUsedTimes = new Map()): T[] {
	if (preference.mode === "custom") return reconcileRoomsByCustomOrder(rooms, preference.customOrder ?? []);
	if (preference.mode === "recent") return rooms.slice().sort(compareRoomsByRecentUse(lastUsed));
	const byName = rooms.slice().sort(compareRoomsByName);
	return preference.mode === "name-desc" ? byName.reverse() : byName;
}
