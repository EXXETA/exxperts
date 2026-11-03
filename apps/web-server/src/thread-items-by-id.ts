/**
 * The rules for conversation items the page and the server name alike.
 *
 * A turn the page sends with an id (its question's id, or a Try again's) is a
 * keyed turn. The server names every item that turn makes from that key:
 * `<key>-a<n>` for a stretch of answer text, `<key>-t<n>` for a step,
 * `<key>-p<n>` for a provider's own search, and `<key>-partial`,
 * `<key>-failure`, `<key>-declined-<n>` for its own lines. Both sides then
 * hold one item under one id, so a late save is merged by id, never by its
 * words. An item the server wrote or confirmed carries `landed: true`; a
 * stopped answer part carries `stoppedAt`, the count of characters kept, and
 * whatever follows them in its text is the Stop note.
 *
 * A turn without a key, and every item without a shared id, keep the old
 * rules (room-thread-routes.ts, persistent-agent-threads.ts); the limits here
 * keep those rules off the shared items.
 *
 * Pure: no file and no clock is read here.
 */
import { normaliseAssistantText } from "../../web-ui/src/assistant-stream.js";
import { PERSISTENT_ROOM_COMMAND_APPROVAL_TITLE, handOffApprovalSubject } from "./room-approval-titles.js";

export type ThreadItem = Record<string, unknown>;

/** A key has no hyphen, so the server's `<key>-<kind>` form has one reading; the page's own ids fit (room-thread-items.ts nid()). */
const TURN_KEY = /^[A-Za-z0-9_]{1,80}$/;
const SERVER_NAMED = /^([A-Za-z0-9_]{1,80})-(a\d+|t\d+|p\d+|partial|failure|declined-\d+)$/;
const ANSWER_PART = /^[A-Za-z0-9_]{1,80}-a\d+$/;
const DECLINED_NOTICE = /^[A-Za-z0-9_]{1,80}-declined-\d+$/;

/** The id of a keyed turn as the page sends it, or undefined: a missing or malformed id makes an old-style turn. */
export function readTurnKey(raw: unknown): string | undefined {
	return typeof raw === "string" && TURN_KEY.test(raw) ? raw : undefined;
}

export const answerPartId = (key: string, n: number): string => `${key}-a${n}`;
export const stepId = (key: string, n: number): string => `${key}-t${n}`;
export const searchStepId = (key: string, n: number): string => `${key}-p${n}`;
export const partialLineId = (key: string): string => `${key}-partial`;
export const failureLineId = (key: string): string => `${key}-failure`;
export const declinedNoticeIdPrefix = (key: string): string => `${key}-declined`;

/** A limit that stopped a turn nobody watched (room-live-sessions.ts): no progress for too long, or too long in total. */
export type AwayLimit = "no-progress" | "time-limit";

/** The cause a stop's line keeps (`failure`), so the page offers Try again from the field, never from the words. */
export type AwayLimitFailure = `away-${AwayLimit}`;

const AWAY_LIMIT_SENTENCE: Record<AwayLimit, string> = {
	"no-progress": "Stopped while you were away: it made no progress for 10 minutes.",
	"time-limit": "Stopped while you were away: it reached the 60-minute limit for working on its own.",
};

/**
 * The line under a turn an away limit stopped; `id` is the turn's partial or failure line id. `finished`: the turn left a step or
 * some of its answer above, which the line points to; with nothing, it says only why it stopped.
 */
export function awayLimitLine(id: string, limit: AwayLimit, finished: boolean): ThreadItem & { failure: AwayLimitFailure } {
	return { kind: "system", id, text: finished ? `${AWAY_LIMIT_SENTENCE[limit]} The steps it finished are above.` : AWAY_LIMIT_SENTENCE[limit], level: "error", failure: `away-${limit}` };
}

/** Whether the conversation's last message is under an away limit's line: its message stays above for Try again. */
export function endsOnAwayLimitStop(items: readonly unknown[] | undefined): boolean {
	const list = (items ?? []) as readonly (ThreadItem | null)[];
	let at = list.length - 1;
	while (at >= 0 && list[at]?.kind !== "user") at--;
	return list.slice(at + 1).some((item) => item?.kind === "system" && String(item.failure ?? "").startsWith("away-"));
}

const idOf = (item: unknown): string => String((item as ThreadItem | null)?.id ?? "");

/** The turn key an id belongs to: the key itself or a server-named id of it. */
export function keyOfId(id: string): string | undefined {
	const named = SERVER_NAMED.exec(id);
	return named ? named[1] : undefined;
}

/** One item both sides name alike: the server's mark, or an id of the server's form (also before any landing, as the page saved it live). */
export function isShared(item: unknown): boolean {
	if (!item || typeof item !== "object") return false;
	if ((item as ThreadItem).landed === true) return true;
	const id = idOf(item);
	return !id.startsWith("detached-") && SERVER_NAMED.test(id);
}

export const isLanded = (item: unknown): boolean => !!item && typeof item === "object" && (item as ThreadItem).landed === true;

export const isAnswerPartId = (id: string): boolean => ANSWER_PART.test(id);

/** Whether an item belongs to the keyed turn `key`: its question or anything the server named for it. */
function ofTurn(item: unknown, key: string): boolean {
	const id = idOf(item);
	return id === key || keyOfId(id) === key;
}

/** The bubble's words and file chips, as the page shows the question. */
export type ShownPrompt = { text: string; files: Array<{ name: string; bytes: number; extension: string }> };

/** `prompt.shown`, checked for shape only: a malformed file entry is dropped alone; a `shown` that is no object is none. */
export function readShownPrompt(raw: unknown): ShownPrompt | undefined {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
	const value = raw as { text?: unknown; files?: unknown };
	const text = typeof value.text === "string" ? value.text : "";
	const files = (Array.isArray(value.files) ? value.files : []).flatMap((file: any) => (
		file && typeof file === "object" && typeof file.name === "string" && file.name && Number.isSafeInteger(file.bytes) && file.bytes >= 0 && typeof file.extension === "string"
			? [{ name: file.name, bytes: file.bytes, extension: file.extension }]
			: []
	));
	return { text, files };
}

/** The most ids one save may name as removed on purpose. */
export const REMOVED_IDS_CAP = 200;
const ITEM_ID = /^[\x21-\x7e]{1,200}$/;

/** A save's `removed`: the ids the page took out on purpose. Each is checked like an item id and a bad one is dropped alone; past the cap the rest are ignored. */
export function readRemovedIds(raw: unknown): string[] {
	if (!Array.isArray(raw)) return [];
	return [...new Set(raw.filter((id): id is string => typeof id === "string" && ITEM_ID.test(id)))].slice(0, REMOVED_IDS_CAP);
}

/** An answer part's words and its Stop note, read from its `stoppedAt`; a count that is no whole number within the text is none. */
function wordsOf(item: ThreadItem | undefined): { words: string; note: string; stopped: boolean } {
	const text = String(item?.text ?? "");
	const at = item?.stoppedAt;
	if (typeof at === "number" && Number.isSafeInteger(at) && at >= 0 && at <= text.length) return { words: text.slice(0, at), note: text.slice(at), stopped: true };
	return { words: text, note: "", stopped: false };
}

/**
 * One answer part from the server's copy and the page's: a stopped part only
 * ever gets shorter, and a Stop note already saved is never lost to a stale
 * copy. `pageStopCounts`: the page's stop count may shorten the words only
 * while the part's turn is the conversation's newest (the latest-turn marker).
 */
export function pickAnswerPart(landed: ThreadItem, page: ThreadItem, pageStopCounts: boolean): { text: string; stoppedAt?: number } {
	const server = wordsOf(landed);
	const pageRead = wordsOf(page);
	// A refused count shortens nothing, but the note it carries still belongs beside a cut the server made.
	const pageCopy = pageStopCounts ? pageRead : { words: String(page.text ?? ""), note: "", stopped: false };
	const stopped = [server, pageCopy].filter((copy) => copy.stopped);
	if (stopped.length === 0) return { text: server.words };
	// The shorter boundary wins; on a tie the page's copy.
	const words = (pageCopy.stopped && (!server.stopped || pageCopy.words.length <= server.words.length) ? pageCopy : server).words;
	const note = pageRead.stopped && pageRead.note ? pageRead.note : server.note;
	return { text: `${words}${note}`, stoppedAt: words.length };
}

/** A cut the server made: the part keeps at most its first `kept` words, and its note. */
export function cutAnswerPart(item: ThreadItem, kept: number): ThreadItem {
	const { words, note } = wordsOf(item);
	const cut = words.slice(0, Math.max(0, Math.min(kept, words.length)));
	return { ...item, text: `${cut}${note}`, stoppedAt: cut.length };
}

/** A part cut to nothing, with no note, shows nothing: it goes from the conversation. */
export const isEmptyCut = (item: ThreadItem): boolean => item.stoppedAt === 0 && !String(item.text ?? "");

/** Cuts the server accepted (part id to words kept), applied to a list about to be written: `applied` names the cuts that found their part, `gone` the parts cut to nothing. */
export function applyCuts(items: readonly unknown[], cuts: ReadonlyMap<string, number>): { items: unknown[]; applied: string[]; gone: string[] } {
	const applied: string[] = [];
	const gone: string[] = [];
	const next = items.flatMap((item) => {
		const id = idOf(item);
		const kept = cuts.get(id);
		if (kept === undefined || (item as ThreadItem)?.kind !== "assistant") return [item];
		applied.push(id);
		const cut = cutAnswerPart(item as ThreadItem, kept);
		if (isEmptyCut(cut)) { gone.push(id); return []; }
		return [cut];
	});
	return { items: applied.length ? next : [...items], applied, gone };
}

/** The fields the server owns on an item it landed; every other field stays the page's. */
function withServerFields(landed: ThreadItem, page: ThreadItem, pageStopCounts: boolean): ThreadItem {
	const merged: ThreadItem = { ...page, landed: true };
	if (landed.kind === "assistant" && page.kind === "assistant") {
		const picked = pickAnswerPart(landed, page, pageStopCounts);
		merged.text = picked.text;
		if (picked.stoppedAt === undefined) delete merged.stoppedAt;
		else merged.stoppedAt = picked.stoppedAt;
		merged.streaming = false;
	} else if (landed.kind === "tool") {
		for (const field of ["kind", "name", "args", "status", "result", "details"]) {
			if (field in landed) merged[field] = landed[field];
			else delete merged[field];
		}
	} else if (landed.kind === "system") {
		merged.kind = "system";
		merged.text = landed.text;
		merged.level = landed.level;
	}
	return merged;
}

/** Inserts `item` after the item with id `afterId`, or before `beforeId`, or at the end. */
function insertNear(items: ThreadItem[], item: ThreadItem, afterId: string | undefined, beforeId: string | undefined): void {
	const after = afterId === undefined ? -1 : items.findIndex((candidate) => idOf(candidate) === afterId);
	if (after >= 0) { items.splice(after + 1, 0, item); return; }
	const before = beforeId === undefined ? -1 : items.findIndex((candidate) => idOf(candidate) === beforeId);
	if (before >= 0) { items.splice(before, 0, item); return; }
	items.push(item);
}

/** The note a declined question leaves in the conversation; one note per wording. */
export function declinedQuestionNoteText(question: string): string {
	const title = String(question ?? "").trim().replace(/\s+/g, " ").slice(0, 200);
	if (title === PERSISTENT_ROOM_COMMAND_APPROVAL_TITLE) return "While you were away, the room asked to run a command. It did not run, because nobody was there to approve it.";
	if (handOffApprovalSubject(title) !== null) return "While you were away, the room asked to hand work to a specialist. It did not, because nobody was there to approve it.";
	if (!title) return "While you were away, a question came up and was answered with a safe default.";
	return `While you were away, a question came up and was answered with a safe default: ${title}`;
}

/** The notes the cards in `items` stand for: a question whose card was kept already says on that card that it ended (Approval.tsx). */
export function notesOfKeptCards(items: readonly unknown[]): Set<string> {
	return new Set(items.filter((item: any) => item?.kind === "approval" && !item.done).map((item: any) => declinedQuestionNoteText(String(item.title ?? ""))));
}

/**
 * The card rule over keyed turns: a landed declined notice goes when its
 * turn's stretch (from the turn's first item to the next question) holds a
 * kept card for the same question, even when that card was saved after the
 * landing.
 */
export function dropNoticesBesideKeptCards(items: ThreadItem[]): ThreadItem[] {
	const drop = new Set<number>();
	items.forEach((notice, index) => {
		const id = idOf(notice);
		if (!DECLINED_NOTICE.test(id) || !isLanded(notice)) return;
		const key = keyOfId(id)!;
		const start = items.findIndex((item) => ofTurn(item, key));
		let end = items.findIndex((item, at) => at > start && item?.kind === "user" && item.steered !== true && idOf(item) !== key);
		if (end < 0) end = items.length;
		if (notesOfKeptCards(items.slice(start, end)).has(String(notice.text ?? ""))) drop.add(index);
	});
	return drop.size ? items.filter((_, index) => !drop.has(index)) : items;
}

/** Where a keyed turn's first item goes when the file lacks everything of it before. */
export interface TurnPlace {
	key: string;
	/** A Try again makes no question: its first item goes right after its start anchor. */
	continued: boolean;
	/** The file's last item when the turn's message arrived (null: the file was empty). */
	startAnchorId: string | null | undefined;
	/** The conversation's recent turn keys in start order, this one among them. */
	recentKeys: readonly string[];
}

function firstItemPlace(items: ThreadItem[], place: TurnPlace): { afterId?: string; beforeId?: string } {
	const at = place.recentKeys.indexOf(place.key);
	const earlier = at < 0 ? [] : place.recentKeys.slice(0, at).reverse();
	const later = at < 0 ? [] : place.recentKeys.slice(at + 1);
	const lastOfEarlier = (): string | undefined => {
		for (const key of earlier) {
			for (let i = items.length - 1; i >= 0; i--) if (ofTurn(items[i], key)) return idOf(items[i]);
		}
		return undefined;
	};
	const firstOfLater = (): string | undefined => {
		for (const key of later) {
			const found = items.find((item) => ofTurn(item, key));
			if (found) return idOf(found);
		}
		return undefined;
	};
	const anchor = place.startAnchorId && items.some((item) => idOf(item) === place.startAnchorId) ? place.startAnchorId : undefined;
	if (place.continued) return { afterId: anchor ?? lastOfEarlier(), beforeId: firstOfLater() };
	return { afterId: lastOfEarlier() ?? anchor, beforeId: firstOfLater() };
}

/**
 * A keyed turn's landing, by id: each of the turn's items, in its order,
 * replaces the file's copy (the server's fields by the pick rule) or is
 * inserted after the turn's item before it; the first one, when the file
 * holds nothing of the turn before it, goes where `place` says. A question
 * the page saved is only stamped. An id the conversation removed on purpose,
 * and a part cut to nothing, go from the file. Nothing else is removed.
 */
export function landTurnItems(file: readonly unknown[], turn: readonly ThreadItem[], place: TurnPlace, removed: ReadonlySet<string>): ThreadItem[] {
	const items = file.filter((item): item is ThreadItem => !!item && typeof item === "object") as ThreadItem[];
	let previous: string | undefined;
	for (const own of turn) {
		const id = idOf(own);
		if (!id) continue;
		const at = items.findIndex((item) => idOf(item) === id);
		if (removed.has(id) || (own.kind === "assistant" && isEmptyCut(own))) {
			if (at >= 0) items.splice(at, 1);
			continue;
		}
		const landed = { ...own, landed: true };
		if (at >= 0) {
			items[at] = own.kind === "user" ? { ...items[at], landed: true } : withServerFields(landed, items[at], true);
		} else if (previous !== undefined) {
			insertNear(items, landed, previous, undefined);
		} else {
			const spot = firstItemPlace(items, place);
			insertNear(items, landed, spot.afterId, spot.beforeId);
		}
		previous = id;
	}
	return dropNoticesBesideKeptCards(items);
}

/**
 * A page save merged with the file by id. Every id the save names as
 * removed, or the conversation removed on purpose lately, goes first. The
 * page's list and order stand; an item the file holds landed takes the
 * server's fields; a landed item the save lacks comes back after the file's
 * item before it. `pageStopCounts(key)`: whether a stop count from the page
 * may shorten that turn's parts.
 */
export function mergeSaveById(file: readonly unknown[], save: readonly unknown[], removed: ReadonlySet<string>, pageStopCounts: (key: string) => boolean): ThreadItem[] {
	const fileItems = file.filter((item): item is ThreadItem => !!item && typeof item === "object") as ThreadItem[];
	const landedById = new Map(fileItems.filter(isLanded).map((item) => [idOf(item), item]));
	const result: ThreadItem[] = save
		.filter((item): item is ThreadItem => !!item && typeof item === "object" && !removed.has(idOf(item)))
		.map((item) => {
			const landed = landedById.get(idOf(item));
			if (landed) {
				if (landed.kind === "user") return { ...item, landed: true };
				const key = keyOfId(idOf(item));
				return withServerFields(landed, item, key !== undefined && pageStopCounts(key));
			}
			if (!("landed" in item)) return item;
			const { landed: _ignored, ...rest } = item;
			return rest;
		});
	const present = new Set(result.map(idOf));
	let lastPlaced: string | undefined;
	fileItems.forEach((item, index) => {
		const id = idOf(item);
		if (present.has(id)) { lastPlaced = id; return; }
		if (!isLanded(item) || removed.has(id)) return;
		const before = lastPlaced === undefined ? fileItems.slice(index + 1).map(idOf).find((later) => present.has(later)) : undefined;
		insertNear(result, item, lastPlaced, before);
		present.add(id);
		lastPlaced = id;
	});
	return dropNoticesBesideKeptCards(result);
}

/**
 * The old merge's limit in a thread that also holds shared items: an item it
 * brings back goes no later than the first shared item the file holds after
 * that old item, when the merged list has it. `todayIndex` is where the old
 * rule puts it.
 */
export function legacyInsertIndex(merged: readonly unknown[], file: readonly unknown[], legacyId: string, todayIndex: number): number {
	const from = file.findIndex((item) => idOf(item) === legacyId);
	if (from < 0) return todayIndex;
	for (const later of file.slice(from + 1)) {
		if (!isShared(later)) continue;
		const at = merged.findIndex((item) => idOf(item) === idOf(later));
		if (at >= 0) return Math.min(todayIndex, at);
	}
	return todayIndex;
}

/** The text form both sides compare an echo in. */
export const evenedText = (text: string): string => normaliseAssistantText(text);

/** How long after a part ends an equal message that streamed nothing counts as its echo, as on the page (assistant-stream.ts). */
export const ECHO_WINDOW_MS = 30_000;
