// The two surfaces that show a room's memory as a whole — Room settings →
// Memory and the Memory tab — say the same things about the same facts, so the
// sentences live here once instead of drifting apart in two components. Pure
// functions only: every string a person reads on either surface is checkable
// without a browser (see apps/web-server/scripts/memory-v2-copy-smoke.ts for
// the sibling module's suite).
//
// One vocabulary: conversations (never sessions), notes (never entries),
// topics, archive, open items, "memory N% full", "Memory budget". Tokens are
// said in exactly two places — beside the budget slider, and in a tooltip.

/** One memory-changing save, as the room's history route reports it. */
export interface MemorySaveEvent {
	ts: number;
	kind: "checkpoint" | "learn" | "review" | "user_edit" | "migrate" | "undo";
	/** the id the undo route takes a Memorize or Review save back by */
	saveId?: string | null;
	title?: string | null;
	/** user_edit: what the hand edit did; "archive_delete" is a note deleted for good, and names its topic */
	operation?: string | null;
	topic?: string | null;
	/** learn: how many waiting conversations it folded in */
	sessions?: number | null;
	/** review: how many topics the tidy touched */
	topicsTidied?: number | null;
	/** migrate: how many notes the one-time write gave an id to */
	entriesAssigned?: number | null;
	/** undo: which save was taken back, of which kind, and when it had been saved */
	undoneSaveId?: string | null;
	undoneKind?: "memorize" | "review" | null;
	undoneAt?: string | null;
	/** this save was taken back by a later undo; the row stays and says so */
	undone?: boolean;
	/** the stored copies this save replaced are still on disk, so "What changed" can be served */
	diffable?: boolean;
}

/** A history row as both surfaces render it: hand edits in a run are one row. */
export interface MemoryHistoryRow {
	key: string;
	ts: number;
	/** what happened, in the words a person reads */
	words: string;
	/** this save was taken back later */
	undone: boolean;
	/** the id Undo needs, on the rows Undo serves; null everywhere else */
	saveId: string | null;
	kind: MemorySaveEvent["kind"];
	/** "What changed" can be shown: one recorded save whose stored copies are still on disk */
	diffable: boolean;
	/** the recorded save's own id, on every row that is exactly one save; null on a folded run of hand edits */
	eventId: string | null;
}

// --- dates -------------------------------------------------------------------

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** A saved-on day as the rows say it: "12 Sep". */
export function fmtMemoryDay(value: string | number | null | undefined): string {
	if (value === null || value === undefined || value === "") return "";
	if (typeof value === "number") {
		if (!Number.isFinite(value)) return "";
		const at = new Date(value);
		return `${at.getDate()} ${MONTHS[at.getMonth()]}`;
	}
	// Stored days are plain YYYY-MM-DD. Reading them as a local date keeps a
	// note saved on the 12th from reading as the 11th west of Greenwich.
	const parts = value.trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
	if (!parts) return value;
	const month = Number(parts[2]);
	if (month < 1 || month > 12) return value;
	return `${Number(parts[3])} ${MONTHS[month - 1]}`;
}

/** A history row's moment: "13 Sep, 14:02". */
export function fmtMemoryMoment(ts: number): string {
	if (!Number.isFinite(ts)) return "";
	const at = new Date(ts);
	const hours = String(at.getHours()).padStart(2, "0");
	const minutes = String(at.getMinutes()).padStart(2, "0");
	return `${fmtMemoryDay(ts)}, ${hours}:${minutes}`;
}

/** How long ago something happened, in days at the coarsest: "1d ago". */
export function fmtMemoryAgo(ts: number | null | undefined): string | null {
	if (ts === null || ts === undefined || !Number.isFinite(ts) || ts <= 0) return null;
	const seconds = Math.max(0, Math.round((Date.now() - ts) / 1000));
	if (seconds < 60) return "just now";
	if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
	if (seconds < 86400) return `${Math.round(seconds / 3600)}h ago`;
	return `${Math.round(seconds / 86400)}d ago`;
}

// --- counted phrases ---------------------------------------------------------

export function notesPhrase(count: number): string {
	return `${count.toLocaleString()} ${count === 1 ? "note" : "notes"}`;
}

export function topicsPhrase(count: number): string {
	return `${count.toLocaleString()} ${count === 1 ? "topic" : "topics"}`;
}

export function waitingConversationsPhrase(count: number): string {
	return `${count.toLocaleString()} conversation${count === 1 ? "" : "s"} waiting`;
}

/** The one line a room's card carries: what it holds, what is waiting, when it last memorized. */
export function roomMemoryFactsLine(room: { notes: number; waiting: number; lastMemorizedAt: number | null }): string {
	const parts = [notesPhrase(room.notes), waitingConversationsPhrase(room.waiting)];
	const ago = fmtMemoryAgo(room.lastMemorizedAt);
	// The stamp is the newest save of any kind (a Remember or a Memorize), the
	// same fact the Home card calls "memory saved", so it reads "saved" here too.
	if (ago) parts.push(`saved ${ago}`);
	return parts.join(" · ");
}

// --- how full memory is ------------------------------------------------------

/** How full a room's memory is against its limit, as a whole percent. */
export function memoryPercentFull(tokens: number, limitTokens: number): number {
	if (!(limitTokens > 0)) return 0;
	return Math.round((tokens / limitTokens) * 100);
}

/** The usage line beside the limit and on every card: "memory 99% full". */
export function memoryFullLine(percent: number): string {
	return `memory ${percent}% full`;
}

/** The same fact where the word "memory" is already on screen: "99% full". */
export function memoryFullShort(percent: number): string {
	return `${percent}% full`;
}

/**
 * The meter's hover: how full the memory is against its budget, in the same
 * percent the line shows — no token count anywhere a person reads.
 */
export function memoryUsageTitle(tokens: number, limitTokens: number): string {
	const percent = memoryPercentFull(tokens, limitTokens);
	return tokens > limitTokens && limitTokens > 0 ? `Memory ${percent}% full, above its budget.` : `Memory ${percent}% full of its budget.`;
}

export const MEMORY_OVER_LIMIT_SENTENCE = "Above its budget. Memorize or Review brings it back.";

// --- Room settings → Memory --------------------------------------------------

export const ROOM_MEMORY_SUB = "What this room remembers, and how it saves new things.";
export const ROOM_MEMORY_TOGGLES_FOOTNOTE = "The two toggles below are off by default. Seeing what gets saved is how you decide what your room remembers.";
export const AUTOMATIC_APPLY_INFO = "A memory update with nothing to weigh is saved as soon as it is ready, instead of being shown to you one last time. An update that archives notes, crosses the memory budget or leaves a conversation unfinished always waits for you, and you can always see what changed afterwards in History.";
export const ROOM_MEMORY_TOGGLES_TITLE = "Saving without a second look";
export const REMEMBER_WITHOUT_PREVIEW_LABEL = "Remember: save without the preview";
export const REMEMBER_WITHOUT_PREVIEW_INFO = "Remember normally shows you what it is about to save from the conversation. With this on, the save happens without that preview. If a save looks incomplete, the preview comes back and you decide.";

export const MEMORY_LIMIT_LABEL = "Memory budget";
export const MEMORY_LIMIT_HINT = "How much long-term memory the room carries into every conversation. Waiting conversations do not count.";

/** Under the slider of a room whose budget was set to its own size when it came to 0.12: "Set to 75k when this room came to 0.12, so nothing it already had leaves. Lower it whenever you want." */
export function budgetSettledHint(tokens: number): string {
	return `Set to ${Math.round(tokens / 1000)}k when this room came to 0.12, so nothing it already had leaves. Lower it whenever you want.`;
}

export const NOTES_SEARCH_PLACEHOLDER = "Search these notes";
export const NOTES_EMPTY_SENTENCE = "This room has no notes yet. Memorize turns its conversations into notes.";
export const NOTES_LOADING_SENTENCE = "Reading this room's memory…";
export const NOTES_NO_MATCH_SENTENCE = "No notes match that.";
export const ADD_NOTE_LABEL = "Add note";
export const DELETE_NOTE_QUESTION = "Delete this note? It goes to the archive, so you can bring it back.";

/** The Notes heading's one line: how much there is, and where it sits. */
export function notesSummaryLine(notes: number, topics: number): string {
	return `${notesPhrase(notes)} in ${topicsPhrase(topics)}`;
}

/** A closed topic's row: "Team and roles · 10 notes". */
export function topicRowLine(topic: string, notes: number): string {
	return `${topic} · ${notesPhrase(notes)}`;
}

/** The engine's name for the open-items section, in the words a person reads. */
export function memoryTopicName(topic: string): string {
	return topic.trim().toLowerCase() === "active items" ? "Open items" : topic;
}

export function archiveSummaryLine(count: number): string {
	return `${notesPhrase(count)} that left memory. They are not read in conversations; bring back any of them.`;
}

/** Why a note left memory, in the archive's own words. */
const ARCHIVE_REASONS: Record<string, string> = {
	budget: "to make room",
	superseded: "replaced",
	done: "finished",
	stale: "no longer holds",
	duplicate: "already said elsewhere",
	user: "removed by you",
};

export function memoryArchiveReason(why: string): string {
	return ARCHIVE_REASONS[why] ?? why;
}

/** One archived row's meta: "archived 13 Sep · to make room". */
export function archiveRowMeta(archived: string, why: string): string {
	return `archived ${fmtMemoryDay(archived)} · ${memoryArchiveReason(why)}`;
}

/** One note's meta: "fact · saved 12 Sep · pinned". */
export function noteRowMeta(note: { kind: string; saved: string; pinned?: boolean; status?: string }): string {
	const parts = [note.kind, `saved ${fmtMemoryDay(note.saved)}`];
	if (note.pinned) parts.push("pinned");
	if (note.status === "done") parts.push("finished");
	return parts.join(" · ");
}

/** Where a note came from, for the row's title attribute. */
export function noteOriginTitle(note: { from?: string; saved: string }): string | undefined {
	return note.from ? `From a conversation saved ${fmtMemoryDay(note.saved)}.` : undefined;
}

// --- History -----------------------------------------------------------------

export const HISTORY_SUB = "Every change to this room's memory, newest first.";
export const HISTORY_EMPTY_SENTENCE = "This room's memory has not changed yet.";
export const HISTORY_UNDO_LABEL = "Undo";
export const HISTORY_UNDONE_MARK = "undone";
export const MEMORY_TAB_HISTORY_SUB = "Every change to this room's memory, newest first. Undo lives in Room settings.";
export const OPEN_IN_ROOM_SETTINGS_LABEL = "Open in Room settings";

function saveWords(event: MemorySaveEvent): string {
	if (event.kind === "checkpoint") return "Remembered a conversation";
	if (event.kind === "learn") {
		const count = event.sessions ?? 0;
		return count > 0 ? `Memorized ${count} conversation${count === 1 ? "" : "s"}` : "Memorized the waiting conversations";
	}
	if (event.kind === "review") {
		const topics = event.topicsTidied ?? 0;
		return topics > 0 ? `Tidied ${topics} topic${topics === 1 ? "" : "s"}` : "Tidied the notes";
	}
	if (event.kind === "migrate") return "Notes given their ids";
	if (event.kind === "undo") {
		const what = event.undoneKind === "review" ? "Review" : "Memorize";
		// The date named is the save that was taken back, not the moment of the
		// undo: the row beside it carries that one.
		const undoneAt = event.undoneAt ? Date.parse(event.undoneAt) : NaN;
		const when = fmtMemoryDay(Number.isFinite(undoneAt) ? undoneAt : event.ts);
		return `Undone: the ${what} of ${when}`;
	}
	return "Edited by hand";
}

/** A note deleted from the archive for good: its own row, never folded into "edits by hand". */
function archiveDeleteWords(count: number, topic: string | null | undefined): string {
	if (count > 1) return `Deleted ${count} archived notes`;
	return topic ? `Deleted an archived note from "${memoryTopicName(topic)}"` : "Deleted an archived note";
}

function isArchiveDelete(event: MemorySaveEvent): boolean {
	return event.kind === "user_edit" && event.operation === "archive_delete";
}

/**
 * The history as both surfaces list it. A run of hand edits — the five moves
 * it takes to reorganise a topic — is one row saying how many, because five
 * rows saying the same four words is a list nobody reads. A note deleted for
 * good is never one of those: it is the one change nothing brings back, so its
 * row says so on its own.
 */
export function memoryHistoryRows(events: MemorySaveEvent[]): MemoryHistoryRow[] {
	const rows: MemoryHistoryRow[] = [];
	let index = 0;
	while (index < events.length) {
		const event = events[index];
		if (event.kind === "user_edit") {
			const deleting = isArchiveDelete(event);
			let end = index;
			while (end + 1 < events.length && events[end + 1].kind === "user_edit" && isArchiveDelete(events[end + 1]) === deleting) end += 1;
			const count = end - index + 1;
			// A run folded into one row has no single before and after to show.
			const single = count === 1 && event.saveId ? event.saveId : null;
			rows.push({
				key: `${event.ts}-${event.saveId ?? index}`,
				ts: event.ts,
				words: deleting ? archiveDeleteWords(count, event.topic) : count === 1 ? "Edited by hand" : `${count} edits by hand`,
				undone: false,
				saveId: null,
				kind: "user_edit",
				diffable: single !== null && event.diffable === true,
				eventId: single,
			});
			index = end + 1;
			continue;
		}
		rows.push({
			key: `${event.ts}-${event.saveId ?? index}`,
			ts: event.ts,
			words: saveWords(event),
			undone: event.undone === true,
			saveId: (event.kind === "learn" || event.kind === "review") && event.saveId ? event.saveId : null,
			kind: event.kind,
			// A remembered conversation changes nothing in the notes yet, so it has no before and after.
			diffable: event.kind !== "checkpoint" && Boolean(event.saveId) && event.diffable === true,
			eventId: event.saveId ?? null,
		});
		index += 1;
	}
	return rows;
}

// --- What changed --------------------------------------------------------------
// One fold under a history row, on both surfaces: the notes before and after
// that one save, topic by topic, note by note — added, updated, moved,
// archived. A stored copy that does not read as notes falls back to its lines.

export const WHAT_CHANGED_LABEL = "What changed";
export const HIDE_CHANGE_LABEL = "Hide";
export const CHANGE_READING = "Reading the stored copies…";
export const CHANGE_READ_ERROR = "Couldn't read the copies for this change right now.";
export const CHANGE_NONE = "The notes read the same before and after.";
export const CHANGE_META = "Added notes are marked +, archived notes are struck, an updated note shows its old text struck above the new one.";
/** The same line when the two copies could only be compared line by line. */
export const CHANGE_LINES_META = "Removed lines are struck, added lines marked +.";
export const CHANGE_UNVERIFIED = " The after side is the next recorded state and may include a change made outside this save.";
export const UNDO_CHANGE_LEAD = "What this undo put back. ";
export const FULL_SCREEN_LABEL = "Full screen ⤢";
export const EXIT_FULL_SCREEN_LABEL = "Exit full screen";
export const READING_FULL_SCREEN_NOTE = "Reading in full screen.";
/** The last block of the note view: the waiting conversations that left or came back. */
export const CHANGE_CONVERSATIONS_BLOCK = "Waiting conversations";

/**
 * The line above the changes. An undo's fold shows what came back, and says so
 * first; an after side the record could not vouch for says so last. `notes`
 * false is the line-by-line fallback, which says what its marks mean instead.
 */
export function changeMetaLine(kind: MemorySaveEvent["kind"], afterVerified: boolean | null | undefined, notes = true): string {
	return `${kind === "undo" ? UNDO_CHANGE_LEAD : ""}${notes ? CHANGE_META : CHANGE_LINES_META}${afterVerified === false ? CHANGE_UNVERIFIED : ""}`;
}

/** What one note did between the two copies, as the diff route names it. */
export type NoteChangeKind = "added" | "archived" | "updated" | "moved" | "pinned" | "unpinned" | "closed" | "reopened";

/** How many notes did what, plus the waiting conversations that left or came back. */
export interface NoteChangeCounts {
	added: number;
	updated: number;
	moved: number;
	archived: number;
	closed: number;
	reopened: number;
	pinned: number;
	unpinned: number;
	left: number;
	joined: number;
}

const NOTE_CHANGE_ORDER: Array<Exclude<keyof NoteChangeCounts, "left" | "joined">> = ["added", "updated", "moved", "archived", "closed", "reopened", "pinned", "unpinned"];

export function emptyNoteChangeCounts(): NoteChangeCounts {
	return { added: 0, updated: 0, moved: 0, archived: 0, closed: 0, reopened: 0, pinned: 0, unpinned: 0, left: 0, joined: 0 };
}

/** Count the rows of one or more topics; the conversations are counted by the caller. */
export function countNoteChanges(changes: Array<{ change: NoteChangeKind }>, into: NoteChangeCounts = emptyNoteChangeCounts()): NoteChangeCounts {
	for (const row of changes) into[row.change] += 1;
	return into;
}

/**
 * The totals line under the meta line: "5 notes added · 2 updated · 1 moved ·
 * 7 archived · 10 conversations left the waiting list". The first count says
 * what is being counted; the rest are the bare number and word. Empty when
 * nothing changed.
 */
export function noteChangeTotals(counts: NoteChangeCounts): string {
	const parts: string[] = [];
	for (const key of NOTE_CHANGE_ORDER) {
		const n = counts[key];
		if (n <= 0) continue;
		parts.push(parts.length === 0 ? `${notesPhrase(n)} ${key}` : `${n.toLocaleString()} ${key}`);
	}
	if (counts.left > 0) parts.push(`${counts.left.toLocaleString()} conversation${counts.left === 1 ? "" : "s"} left the waiting list`);
	if (counts.joined > 0) parts.push(`${counts.joined.toLocaleString()} conversation${counts.joined === 1 ? "" : "s"} came back to the waiting list`);
	return parts.join(" · ");
}

/** Beside a topic's heading in the fold: "2 added · 1 updated". */
export function topicChangeSummary(counts: NoteChangeCounts): string {
	const parts: string[] = [];
	for (const key of NOTE_CHANGE_ORDER) if (counts[key] > 0) parts.push(`${counts[key].toLocaleString()} ${key}`);
	return parts.join(" · ");
}

/**
 * After an archived note's struck text: "archived", or "archived · to make room"
 * when the record says why, and "archived · to make room · not touched since
 * 2 Mar, never recalled" when it also says what the ranking saw.
 */
export function archivedLabel(why: string | null | undefined, reason?: string | null): string {
	const parts = ["archived"];
	if (why) parts.push(memoryArchiveReason(why));
	if (reason?.trim()) parts.push(reason.trim());
	return parts.join(" · ");
}

/** On the card's archive section, when open items were left in place while the limit was still not met. */
export function protectedOpenItemsSentence(count: number): string {
	if (count <= 0) return "";
	if (count === 1) return "1 open item is kept; close it to free room.";
	return `${count.toLocaleString()} open items are kept; close them to free room.`;
}

/** After a note that changed topic: moved from "Team and roles". */
export function movedLabel(from: string): string {
	return `moved from "${memoryTopicName(from)}"`;
}

/** After a note whose flag changed: the one word the route already uses. */
export function noteFlagLabel(change: "pinned" | "unpinned" | "closed" | "reopened"): string {
	return change;
}

/**
 * Undo is offered on the newest Memorize or Review save, and only while it is
 * still the newest change — anything saved since is what the room now holds,
 * and putting an older memory back under it is not an undo. The server checks
 * this too, with its own sentence; this is the client not offering a button it
 * already knows would be refused.
 */
export function undoableHistoryRow(rows: MemoryHistoryRow[]): MemoryHistoryRow | null {
	const first = rows[0];
	if (!first || first.undone || !first.saveId) return null;
	return first.kind === "learn" || first.kind === "review" ? first : null;
}

// --- Memory tab --------------------------------------------------------------

export const MEMORY_TAB_LEGEND = ["Notes", "Open items", "Waiting conversations"] as const;
export const TOPICS_PANEL_TITLE = "Topics";
export const TOPICS_PANEL_SUB = "How this room's notes are grouped. Open a topic to read what it holds.";
export const TOPICS_PANEL_EMPTY = "No notes yet.";
/** The reading panel under one topic: its notes, as the room holds them. */
export function topicPanelSub(topic: string): string {
	return `What this room holds under "${topic}", word for word. Read-only.`;
}
/** The reading panel under "Full memory": the notes and open items the room reads every time. */
export const FULL_MEMORY_PANEL_SUB = "What this room reads at the start of every conversation. Read-only.";
export const WAITING_PANEL_TITLE = "Waiting conversations";
export const WAITING_PANEL_SUB = "Conversations you remembered that are not memorized yet. Newest first.";
export const WAITING_PANEL_EMPTY = "All caught up. Every remembered conversation has been memorized.";
export const WAITING_PANEL_NONE_YET = "No memories yet. This room has not had a conversation.";
export const OPEN_CONVERSATION_LABEL = "open the conversation";

// --- Memorized conversations -------------------------------------------------
// Under the waiting list: the conversations the room already turned into
// notes, each still readable as it was stored while its file exists.

/** The fold's title: "Memorized conversations (12)". */
export function memorizedConversationsTitle(count: number): string {
	return `Memorized conversations (${count.toLocaleString()})`;
}
export const MEMORIZED_SUB = "Conversations this room already turned into notes. Open one to read it as it was stored.";
export const CONVERSATION_GONE = "no longer stored";

// --- Memory as of a moment ---------------------------------------------------
// The growth graph is the control: a click on one of its points reads the
// room's memory as it was then, from the stored copy that save left behind.

export const GROWTH_SUB = "How this room's memory has grown, save by save. Hover a point for details; click one to read the memory as it was then.";
export const ASOF_READING = "Reading the stored copy…";
export const ASOF_ERROR = "Couldn't read a copy for that moment right now.";
export const BACK_TO_TODAY_LABEL = "Back to today";
export const YOU_ARE_VIEWING_HERE = "you are viewing here";
/** Appended to the History sub while a past moment is being viewed. */
export const HISTORY_ASOF_TAIL = " Saves after the viewed moment had not happened yet.";

/** The chip beside a heading whose content is a past moment's: "as of 12 Sep". */
export function asOfChip(at: number): string {
	return `as of ${fmtMemoryDay(at)}`;
}

/**
 * The banner above the graph while a past moment is viewed. `boundaryTs` is
 * the next recorded change after that moment; without one, the stored copy
 * is what the room holds today.
 */
export function asOfSentence(at: number, boundaryTs: number | null): string {
	const head = `Viewing this room's memory as it was on ${fmtMemoryDay(at)}.`;
	return boundaryTs ? `${head} It changed next on ${fmtMemoryDay(boundaryTs)}.` : `${head} Nothing was saved after that moment, so this is today's memory.`;
}

/** The expanded room's strip: when its memory began, then today's facts. "In memory since 3 Sep · 953 notes · …" */
export function inMemorySinceLine(sinceTs: number, facts: string): string {
	return `In memory since ${fmtMemoryDay(sinceTs)} · ${facts}`;
}

/** The cross-room line above the cards: the same words a room's own card uses. */
export function allRoomsFactsLine(totals: { rooms: number; notes: number; waiting: number }): string {
	return `${totals.rooms.toLocaleString()} room${totals.rooms === 1 ? "" : "s"} · ${notesPhrase(totals.notes)} · ${waitingConversationsPhrase(totals.waiting)}`;
}
