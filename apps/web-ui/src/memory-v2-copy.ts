// Memorize v2 reads a run, not a finished draft: the server reports numbers
// and outcomes, this module turns them into the sentences a person reads and
// into the two verdicts the flow needs (which screen a run is on, and whether
// automatic maintenance may apply it). Keeping it pure means the copy and the
// gate are checkable without a browser — see
// apps/web-server/scripts/memory-v2-copy-smoke.ts.

import type { AbsorbRun, AbsorbRunChangeKind, AbsorbRunSession, ArchivedEntryCard, ArchiveRow, EntryCard, EntryKind, ReviewDepth, ReviewRun, ReviewRunChange, ReviewRunChangeKind, RunBudget, RunDemotion } from "./types";
import { meaningfulMaintenanceWarnings } from "./maintenance-warnings";

/** Token counts are read, not scanned: group them the way the budget line does. */
export function fmtTokenCount(value: number): string {
	return Math.round(value).toLocaleString("en-US");
}

/** Which screen a run belongs on. The three working states share one screen. */
export type AbsorbRunScreen = "running" | "ready" | "approving" | "saved" | "cancelled" | "failed";

export function absorbRunScreen(state: AbsorbRun["state"]): AbsorbRunScreen {
	if (state === "prepass" || state === "folding" || state === "budget") return "running";
	return state;
}

export function absorbRunIsWorking(state: AbsorbRun["state"]): boolean {
	return absorbRunScreen(state) === "running";
}

/**
 * The headline of the working screen. "Folding" is the engine's word for it and
 * never reaches a person: what the user is watching is one remembered session
 * at a time being added to the room's memory, which is what the line says.
 */
export function absorbRunProgressLine(run: AbsorbRun): string {
	if (run.state === "prepass") return "Reading this room's memory…";
	if (run.state === "budget") return "Checking the memory budget…";
	// Every conversation of the run counts, the ones left out and the ones that
	// held nothing included: "4 of 10" is the person's own list, not the engine's.
	const total = run.progress.total;
	const current = run.progress.current;
	const at = current ? run.sessions.findIndex((session) => session.id === current.id) : -1;
	const position = at >= 0 ? at + 1 : Math.min(run.progress.folded + 1, Math.max(total, 1));
	if (!current) return `Working through ${total} ${total === 1 ? "conversation" : "conversations"}…`;
	return `Memorizing conversation ${position} of ${total} · ${current.title}`;
}

function countsClause(summary: NonNullable<AbsorbRunSession["summary"]>): string {
	const parts: string[] = [];
	if (summary.added > 0) parts.push(`${summary.added} added`);
	if (summary.updated > 0) parts.push(`${summary.updated} updated`);
	if (summary.superseded > 0) parts.push(`${summary.superseded} replaced`);
	if (summary.closed > 0) parts.push(`${summary.closed} closed`);
	return parts.length ? parts.join(", ") : "no changes";
}

/**
 * A failed session's line ends in what becomes of the session, once.
 *
 * Most reasons are a cause on their own — a reply cut at the output limit, a
 * reply the memory could not accept — so the promise is written here, in one
 * voice, for all of them. A reason that already says where the session goes
 * (the worker failures do) keeps its own words instead of saying it twice.
 */
function failedSessionLine(reason: string | undefined): string {
	const cause = (reason ?? "").trim() || "This conversation could not be read.";
	return /(?:next update|next time)\.$/i.test(cause) ? cause : `${cause} It stays for next time.`;
}

/** One line per session, on the working screen and on the card. */
export function absorbRunSessionLine(session: AbsorbRunSession): string {
	switch (session.outcome) {
		case "pending": return "Waiting";
		case "folding": return "Reading this conversation now";
		case "folded": return `Memorized · ${session.summary ? countsClause(session.summary) : "no changes"}`;
		case "dropped": return `Nothing to keep · ${session.reason || "this conversation held nothing worth remembering"}`;
		case "failed": return failedSessionLine(session.reason);
		case "skipped": return `Left out · ${session.reason || "you asked for this conversation to be left out"}`;
	}
}

/** Conversations that keep waiting because their run leg failed. */
export function absorbRunFailedSessionNote(run: AbsorbRun): string | null {
	const failed = run.sessions.filter((session) => session.outcome === "failed").length;
	if (failed === 0) return null;
	return failed === 1
		? "1 conversation keeps waiting for the next update."
		: `${failed} conversations keep waiting for the next update.`;
}

/** How full memory is after this update, as the percentage a person reads everywhere else. */
export function absorbRunFullPercent(run: AbsorbRun): number {
	if (run.budget.budgetTokens <= 0) return 0;
	return Math.round(((run.budget.after + Math.max(0, run.demotion.overageTokens)) / run.budget.budgetTokens) * 100);
}

/** Conversations the run finished reading, whether they added notes or held nothing. */
export function absorbRunReadCount(run: AbsorbRun): number {
	return run.sessions.filter((session) => session.outcome === "folded" || session.outcome === "dropped").length;
}

/** Notes this update adds, rewrites, replaces or closes, across every conversation. */
export function absorbRunNotesChanged(run: AbsorbRun): number {
	return run.sessions.reduce((sum, session) => sum + (session.summary ? session.summary.added + session.summary.updated + session.summary.superseded + session.summary.closed : 0), 0);
}

/** Notes leaving for the archive if the update is saved as it stands. The server counts; the card reads. */
export function absorbRunArchiveCount(run: AbsorbRun): number {
	return run.demotion.counts.leaving;
}

// ── The budget bar over the archive list ────────────────────────────────────
// One bar on either card says where the budget sits and how much is leaving
// because of it. Tokens appear in exactly one place on the whole card: inside
// the button that raises the budget, where the number is the thing being set.

/** A budget as the raise button names it: "52k", the way the slider in Room settings does. */
export function fmtTokenLimit(tokens: number): string {
	return `${Math.round(tokens / 1000)}k`;
}

/**
 * The highest budget a room can have. A run carries it as `ceilingTokens`; the
 * first read, which runs before any run exists, does not, so the number lives
 * here too and mirrors the server's ceiling.
 */
export const MEMORY_LIMIT_CEILING_TOKENS = 80_000;

/** The next whole thousand at or above a size, which is what a limit is set to. */
export function roundUpToThousand(tokens: number): number {
	return Math.ceil(Math.max(0, tokens) / 1000) * 1000;
}

/** How much the rows leaving weigh, which is what the bar's grey part is drawn from. */
export function archiveLeavingTokens(entries: ArchiveRow[]): number {
	return entries.reduce((sum, row) => sum + (row.leaving ? row.tokens : 0), 0);
}

/**
 * The limit that would keep every note on the list, rounded up to the next
 * thousand: what memory would weigh with nothing leaving and everything kept.
 * Null when nothing leaves and nothing kept pushes past the limit.
 */
export function raiseLimitTarget(input: { budget: RunBudget; demotion: RunDemotion }): number | null {
	const leavingTokens = archiveLeavingTokens(input.demotion.entries);
	const overage = Math.max(0, input.demotion.overageTokens);
	if (leavingTokens <= 0 && overage <= 0) return null;
	return roundUpToThousand(input.budget.after + overage + leavingTokens);
}

/** The bar's kept, leaving and replacement counts on one line; a replacement count of zero is not said. */
export function archiveCountsLine(counts: RunDemotion["counts"]): string {
	if (counts.kept === 0) return "Nothing kept yet";
	const instead = counts.instead === 0 ? null : counts.instead === 1 ? "1 leaves instead of it" : `${counts.instead} leave instead of them`;
	return instead ? `Kept ${counts.kept} · ${instead}` : `Kept ${counts.kept}`;
}

export const MEMORY_LIMIT_BAR_LABEL = "Memory budget";

/** The one sentence under the bar: what the budget does, what Keep does, and where the archive is. */
export const ARCHIVE_EXPLANATION = "Keep marks a note that must stay; another note leaves in its place. The budget decides how many stay. Notes in the archive stay readable in Room settings and can come back any time.";

export interface ArchiveLimitSummary {
	/** How full memory is after saving, kept notes included. */
	percent: number;
	/** Nothing leaves and nothing kept pushes past the limit: the grey part collapses. */
	fits: boolean;
	/** The label on the filled part: "full" while anything is leaving or over, else the percentage. */
	fillLabel: string;
	/** The label on the grey part: how many notes are leaving. */
	overflowLabel: string;
	/** How wide the grey part is, as a share of the filled part; capped at one. */
	overflowRatio: number;
	/** "Kept 4 · Leaving 580 · 6 leave instead of the kept ones" */
	countsLine: string;
	/** Said instead of the counts line when everything fits. */
	fitsSentence: string | null;
	/** The raise button: null when there is nothing to raise for. */
	raise: { target: number; label: string; ceilingSentence: string | null } | null;
}

/**
 * Everything the limit bar shows, from the run's numbers alone. The same bar
 * serves both cards, so the same helper words it.
 */
export function archiveLimitSummary(input: { budget: RunBudget; demotion: RunDemotion }): ArchiveLimitSummary {
	const { budget, demotion } = input;
	const overage = Math.max(0, demotion.overageTokens);
	const leaving = demotion.counts.leaving;
	const leavingTokens = archiveLeavingTokens(demotion.entries);
	const percent = memoryFullPercent(budget.after + overage, budget.budgetTokens);
	const fits = leaving === 0 && overage <= 0;
	const excess = leavingTokens + overage;
	const overflowRatio = fits || budget.budgetTokens <= 0 ? 0 : Math.min(1, excess / budget.budgetTokens);
	const wanted = raiseLimitTarget(input);
	let raise: ArchiveLimitSummary["raise"] = null;
	if (wanted !== null) {
		if (wanted <= budget.ceilingTokens) {
			raise = { target: wanted, label: `Raise the budget to ${fmtTokenLimit(wanted)} to keep them all`, ceilingSentence: null };
		} else {
			raise = {
				target: budget.ceilingTokens,
				label: `Raise the budget to ${fmtTokenLimit(budget.ceilingTokens)}`,
				ceilingSentence: `Keeping them all needs more than the ${fmtTokenLimit(budget.ceilingTokens)} ceiling.`,
			};
		}
		// A run already at the ceiling has nothing left to set; the sentence still says why.
		if (raise.target <= budget.budgetTokens && raise.ceilingSentence === null) raise = null;
	}
	return {
		percent,
		fits,
		fillLabel: fits ? `${percent}% full` : typeof demotion.counts.staying === "number" ? `${demotion.counts.staying} ${demotion.counts.staying === 1 ? "note stays" : "notes stay"}` : "full",
		overflowLabel: leaving > 0 ? `${leaving} ${leaving === 1 ? "note leaves" : "notes leave"}` : "above its budget",
		overflowRatio,
		countsLine: archiveCountsLine(demotion.counts),
		fitsSentence: fits ? `Everything fits. Memory is ${percent}% full after saving.` : null,
		raise,
	};
}

/** The archive section's heading: how many notes leave if this is saved as it stands; none, and it says so. */
export function archiveHeading(leaving: number): string {
	if (leaving === 0) return "Nothing goes to the archive";
	return `${leaving} ${leaving === 1 ? "note" : "notes"} going to the archive`;
}

/** The topic checkbox in the archive list. */
export const KEEP_TOPIC_LABEL = "Keep this topic";

/** The tags a row can carry: a replacement, and a row that stopped leaving. */
export const ARCHIVE_ROW_TAG_INSTEAD = "leaves instead";
export const ARCHIVE_ROW_TAG_STAYS = "stays";

/** The tag next to a topic the update created. */
export const NEW_TOPIC_TAG = "new topic";

/** What a row says beside its text, or nothing. A kept row is dimmed instead of tagged. */
export function archiveRowTag(row: Pick<ArchiveRow, "leaving" | "kept" | "instead">): string | null {
	if (row.leaving && row.instead) return ARCHIVE_ROW_TAG_INSTEAD;
	if (!row.leaving && !row.kept) return ARCHIVE_ROW_TAG_STAYS;
	return null;
}

/** A topic as the keep set names it: section and title, one string. */
export function archiveTopicKey(section: string, title: string): string {
	return `${section}/${title}`;
}

/** Section and title each trimmed and lowercased, so " Nordwind Integration " and "nordwind integration" are one topic. */
function normalTopicKey(key: string): string {
	const slash = key.indexOf("/");
	if (slash < 0) return key.trim().toLowerCase();
	return `${key.slice(0, slash).trim().toLowerCase()}/${key.slice(slash + 1).trim().toLowerCase()}`;
}

/** Whether a topic is protected, matched the way the server matches it: case-insensitive, trimmed. */
export function topicKept(keepTopics: string[], section: string, title: string): boolean {
	const wanted = normalTopicKey(archiveTopicKey(section, title));
	return keepTopics.some((key) => normalTopicKey(key) === wanted);
}

/** The protected topics after a toggle; order is stable so two equal sets are one request. */
export function nextKeepTopics(current: string[], section: string, title: string, keep: boolean): string[] {
	const key = archiveTopicKey(section, title);
	const wanted = normalTopicKey(key);
	const rest = current.filter((candidate) => normalTopicKey(candidate) !== wanted);
	return keep ? [...rest, key] : rest;
}

// ── The first read of a room already above its budget ───────────────────────
// Before any run exists, the first read says what memorizing now would do
// and offers the two other ways: a higher budget, or a Review first.

export interface OverLimitFirstRead {
	headline: string;
	sentence: string;
	raise: { target: number; label: string };
	reviewLabel: string;
}

export const REVIEW_FIRST_LABEL = "Review first";

/**
 * The block above the first read. The target is the room's memory as it
 * stands, rounded up; past the ceiling the button sets the ceiling and the
 * sentence says notes would still move. How many would is not known before a
 * run, so that sentence carries no count.
 */
export function overLimitFirstRead(input: { reviewTargetTokens: number; budgetTokens: number; entriesOverBudget: number; ceilingTokens?: number }): OverLimitFirstRead {
	const ceiling = input.ceilingTokens ?? MEMORY_LIMIT_CEILING_TOKENS;
	const percent = memoryFullPercent(input.reviewTargetTokens, input.budgetTokens);
	const count = input.entriesOverBudget;
	const wanted = roundUpToThousand(input.reviewTargetTokens);
	const pastCeiling = wanted > ceiling;
	const target = pastCeiling ? ceiling : wanted;
	const moves = `Memorizing now moves about ${count} of the least recently touched notes to the archive.`;
	return {
		headline: `Memory is ${percent}% full.`,
		sentence: pastCeiling
			? `${moves} Even at the ${fmtTokenLimit(ceiling)} ceiling some of them would still move. You can also:`
			: `${moves} You can also:`,
		raise: { target, label: pastCeiling ? `Raise the budget to ${fmtTokenLimit(target)}` : `Raise the budget to ${fmtTokenLimit(target)} to keep everything that is there now` },
		reviewLabel: REVIEW_FIRST_LABEL,
	};
}

/** The saved screen's line when the save also wrote a higher budget. The number stays on the button that chose it. */
export const LIMIT_RAISED_ON_SAVE_SENTENCE = "The memory budget was raised with this save.";

/** An undo took back a save that had raised the budget, and the budget went with it. */
export function LIMIT_LOWERED_ON_UNDO_SENTENCE(tokens: number): string {
	return `The budget is back at ${fmtTokenLimit(tokens)}.`;
}

/**
 * Giving a room's entries their ids changes nothing a person would recognise in
 * what the room remembers, so it is never a reason to hold an update back. The
 * server still reports it; the card states it as a fact instead of a warning.
 */
export function isEntryIdMigrationNotice(warning: string): boolean {
	return /entry ids/i.test(warning);
}

/** The informational line a first-time migration puts on the card. */
export function absorbRunMigrationSentence(run: AbsorbRun): string | null {
	if (!run.migration?.pending) return null;
	return `This update also gives the room's ${fmtTokenCount(run.migration.entriesAssigned)} entries their ids, so they can be edited one by one. Nothing changes in what the room remembers.`;
}

/**
 * Automatic maintenance for a v2 run (the contract's client fast path): apply
 * only when there is nothing for a person to weigh. Anything archived, any
 * crossing of the budget, any session that did not finish, and any warning
 * falls to the card with the reason named. The room setting is checked by the
 * caller; this is the run's own verdict.
 */
export function absorbRunFastPathBlockers(run: AbsorbRun): string[] {
	const blockers: string[] = [];
	blockers.push(...meaningfulMaintenanceWarnings(run.warnings.filter((warning) => !isEntryIdMigrationNotice(warning))));
	const leaving = run.demotion.counts.leaving;
	if (leaving > 0) {
		blockers.push(leaving === 1
			? "1 note would move to the archive to stay within the budget"
			: `${leaving} notes would move to the archive to stay within the budget`);
	}
	if (run.budget.overBudgetAfter) blockers.push("saving would leave memory above its budget");
	const unfinished = run.sessions.filter((session) => session.outcome !== "folded" && session.outcome !== "dropped");
	if (unfinished.length > 0) {
		blockers.push(unfinished.length === 1
			? "1 conversation did not finish"
			: `${unfinished.length} conversations did not finish`);
	}
	return blockers;
}

/** The saved screen's headline: what the room now remembers, or what the update did instead. */
export function absorbRunSavedHeadline(result: { foldedSessions?: string[]; archivedForBudget?: number }, roomName: string): string {
	const folded = result.foldedSessions?.length ?? 0;
	if (folded === 0) return (result.archivedForBudget ?? 0) > 0 ? `${roomName} made room in its memory` : `Nothing new for ${roomName} to remember`;
	return `${roomName} memorized ${folded} ${folded === 1 ? "conversation" : "conversations"}`;
}

/** Topics this update created, counted across every conversation it read. */
export function absorbRunNewTopics(run: AbsorbRun): number {
	return run.sessions.reduce((sum, session) => sum + (session.changes?.filter((change) => change.newTopic === true).length ?? 0), 0);
}

/** What the saved screen says once the run is written. */
export function absorbRunSavedSentence(result: { foldedSessions?: string[]; remainingSessions?: string[]; archivedEntries?: number; archivedForBudget?: number; newTopics?: number }): string {
	const folded = result.foldedSessions?.length ?? 0;
	const remaining = result.remainingSessions?.length ?? 0;
	const archived = result.archivedEntries ?? 0;
	const archivedForBudget = result.archivedForBudget ?? 0;
	const newTopics = result.newTopics ?? 0;
	const parts: string[] = [];
	// A room already at its ceiling can spend a whole update making room and add
	// nothing: "0 sessions were saved into memory" reads as a failure when what
	// actually happened is the work the budget needed.
	if (folded === 0 && archivedForBudget > 0) {
		parts.push("No conversation was memorized this time.");
		parts.push(archivedForBudget === 1
			? "1 note moved to the archive to keep memory within its budget."
			: `${archivedForBudget} notes moved to the archive to keep memory within its budget.`);
		if (remaining > 0) parts.push(remaining === 1 ? "1 conversation keeps waiting for the next update." : `${remaining} conversations keep waiting for the next update.`);
		return parts.join(" ");
	}
	parts.push(folded === 1 ? "1 conversation became lasting notes." : `${folded} conversations became lasting notes.`);
	if (newTopics > 0) parts.push(newTopics === 1 ? "1 new topic." : `${newTopics} new topics.`);
	if (remaining > 0) parts.push(remaining === 1 ? "1 conversation keeps waiting for the next update." : `${remaining} conversations keep waiting for the next update.`);
	if (archived > 0) parts.push(archived === 1 ? "1 note moved to the archive." : `${archived} notes moved to the archive.`);
	return parts.join(" ");
}

const CHANGE_LABELS: Record<AbsorbRunChangeKind, string> = {
	added: "Added",
	updated: "Updated",
	superseded: "Replaced",
	closed: "Closed",
	pinned: "Pinned",
};

export function changeKindLabel(kind: AbsorbRunChangeKind): string {
	return CHANGE_LABELS[kind] ?? kind;
}

const KIND_LABELS: Record<EntryKind, string> = {
	event: "conversation",
	fact: "fact",
	practice: "practice",
	item: "item",
};

export function entryKindLabel(kind: EntryKind): string {
	return KIND_LABELS[kind] ?? kind;
}

/** The entry's origin, worded as a date rather than the server's session id. */
export function entryOriginSentence(entry: EntryCard): string | null {
	if (!entry.from) return null;
	return `from a conversation saved ${entry.saved}`;
}

/** The first line of an entry, for a row that has no room for the whole text. */
export function entryFirstLine(text: string): string {
	const line = text.split("\n").map((part) => part.replace(/^[\s\-*•]+/, "").trim()).find((part) => part.length > 0) ?? "";
	return line.length > 180 ? `${line.slice(0, 180)}…` : line;
}

const ARCHIVE_REASONS: Record<ArchivedEntryCard["why"], string> = {
	budget: "budget",
	superseded: "replaced",
	done: "finished",
	user: "removed by you",
	stale: "no longer holds",
	duplicate: "already said elsewhere",
};

export function archiveReasonLabel(why: ArchivedEntryCard["why"]): string {
	return ARCHIVE_REASONS[why] ?? why;
}

/** The reason of a note archived as a duplicate when the run knows where it is already said: the topic holding the other note. */
export function archivedDuplicateReason(topic: string): string {
	return `already said under "${topicLabel(topic)}"`;
}

// ── The archive lists on the card ──────────────────────────────────────────
// A room at the top of its budget archives hundreds of entries at once, and a
// flat list of those is a card 90 screens tall. The lists are therefore read
// the way memory itself is organised: by topic, closed, counted, and opened
// only where the person wants to look.

export interface EntryTopicGroup<T extends EntryCard = EntryCard> {
	section: EntryCard["section"];
	topic: string;
	entries: T[];
	tokens: number;
}

const SECTION_ORDER: EntryCard["section"][] = ["Deep Memory", "Active Items"];

/** Section first, then topic in the order the entries arrive, so the card reads like the memory does. */
export function groupEntriesByTopic<T extends EntryCard>(entries: T[]): EntryTopicGroup<T>[] {
	const groups = new Map<string, EntryTopicGroup<T>>();
	for (const entry of entries) {
		const key = `${entry.section} ${entry.topic}`;
		let group = groups.get(key);
		if (!group) {
			group = { section: entry.section, topic: entry.topic, entries: [], tokens: 0 };
			groups.set(key, group);
		}
		group.entries.push(entry);
		group.tokens += entry.tokens;
	}
	const ordered = [...groups.values()];
	ordered.sort((left, right) => SECTION_ORDER.indexOf(left.section) - SECTION_ORDER.indexOf(right.section));
	return ordered;
}

/** The engine's name for the open-items section, in the words a person reads. */
export function topicLabel(topic: string): string {
	return topic.trim().toLowerCase() === "active items" ? "Open items" : topic;
}

/** The one line a closed group shows: what it is, how much of it there is, and what becomes of it. A kept count of zero is not said. */
export function archiveTopicGroupSummary(group: EntryTopicGroup<ArchiveRow>): string {
	const count = group.entries.length;
	const kept = group.entries.filter((row) => row.kept).length;
	const leaving = group.entries.filter((row) => row.leaving).length;
	const parts = [topicLabel(group.topic), `${count} ${count === 1 ? "note" : "notes"}`];
	if (kept > 0) parts.push(`${kept} kept`);
	parts.push(`${leaving} leaving`);
	return parts.join(" · ");
}

/** The search box above a list: plain text against the entry and its topic. */
export function filterEntriesByText<T extends EntryCard>(entries: T[], query: string): T[] {
	const needle = query.trim().toLowerCase();
	if (!needle) return entries;
	return entries.filter((entry) => entry.text.toLowerCase().includes(needle) || entry.topic.toLowerCase().includes(needle));
}

/** Past this many entries in one list, an opened group shows a first page instead of everything. */
export const ENTRY_LIST_LARGE_THRESHOLD = 200;
/** How many rows an opened group shows first when the list is a large one. */
export const ENTRY_GROUP_PAGE_SIZE = 50;

/** What an opened group renders: the first page, and how many rows it is still holding back. */
export function entryGroupPage<T extends EntryCard>(entries: T[], listTotal: number, showAll: boolean): { visible: T[]; hidden: number } {
	if (showAll || listTotal <= ENTRY_LIST_LARGE_THRESHOLD || entries.length <= ENTRY_GROUP_PAGE_SIZE) {
		return { visible: entries, hidden: 0 };
	}
	return { visible: entries.slice(0, ENTRY_GROUP_PAGE_SIZE), hidden: entries.length - ENTRY_GROUP_PAGE_SIZE };
}

export function showMoreLabel(hidden: number): string {
	return `Show ${fmtTokenCount(hidden)} more`;
}

/** The keep set after a toggle; order is stable so two equal sets are one request. */
export function nextKeepIds(current: string[], entryIds: string[], keep: boolean): string[] {
	const changed = new Set(entryIds);
	const rest = current.filter((id) => !changed.has(id));
	return keep ? [...rest, ...entryIds] : rest;
}

/** How long a burst of keep toggles is collected before one request carries them all. */
export const KEEP_DEBOUNCE_MS = 400;

/**
 * Keep is one request with the whole set, never one per entry: a person ticking
 * twenty rows must not start twenty runs of the server's budget maths. While a
 * request is in flight the next set waits for it, so the last state the person
 * chose is the one the server ends on.
 */
export function keepBatchAction(inFlight: boolean): "send" | "queue" {
	return inFlight ? "queue" : "send";
}

// ── What the person asked for ──────────────────────────────────────────────
// A discussion ends in instructions the run is meant to honour. The card shows
// them back in the person's own terms, so approving is a check of what was
// asked for and not only of what the model did.

export interface AbsorbRunGuidanceSummary {
	pins: string[];
	drops: { text: string; leftOut: boolean }[];
	corrections: string[];
	topics: string[];
	instructions: string[];
}

function joinList(items: string[]): string {
	if (items.length <= 1) return items[0] ?? "";
	if (items.length === 2) return `${items[0]} and ${items[1]}`;
	return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

/**
 * Ids are the engine's handle on an entry, never a person's: a pinned id is
 * shown as the line it stands for wherever the card holds that entry, and only
 * falls back to the id when the entry is not on this card at all.
 */
export function absorbRunGuidanceSummary(run: AbsorbRun): AbsorbRunGuidanceSummary | null {
	const guidance = run.guidance;
	if (!guidance) return null;
	const known = new Map<string, EntryCard>();
	for (const entry of run.demotion.entries) known.set(entry.id, entry);
	const pins = (guidance.pin ?? []).map((id) => {
		const entry = known.get(id);
		return entry ? entryFirstLine(entry.text) : id;
	});
	const drops = (guidance.drop ?? []).map((drop) => {
		const session = run.sessions.find((candidate) => candidate.id === drop.session);
		const title = session?.title ?? drop.session;
		const reason = (drop.reason ?? "").trim();
		return { text: reason ? `${title} · ${reason}` : title, leftOut: session?.outcome === "skipped" };
	});
	const topics = (guidance.topics ?? []).map((topic) => (
		"create" in topic
			? `Create the topic "${topic.create}"`
			: `Merge ${joinList(topic.merge.map((name) => `"${name}"`))} into "${topic.into}"`
	));
	const summary: AbsorbRunGuidanceSummary = {
		pins,
		drops,
		corrections: guidance.corrections ?? [],
		topics,
		instructions: guidance.instructions ?? [],
	};
	const empty = summary.pins.length === 0 && summary.drops.length === 0 && summary.corrections.length === 0 && summary.topics.length === 0 && summary.instructions.length === 0;
	return empty ? null : summary;
}

// ── One name for applying a memory update without a second look ───────────
// The setting, the notes on the card and the saved screen all mean the same
// thing, so they say it in the same words. The stored setting key is older
// than the name and stays as it is.

/** The room setting's label, wherever it is named. */
export const AUTOMATIC_APPLY_SETTING_LABEL = "Memorize: save a clean update without the card";

/** The same fact as a clause, for the sentences that build on it. */
export const AUTOMATIC_APPLY_ON_SENTENCE = "This room applies memory updates automatically";

/** Why an update the room would have applied is waiting for a person instead. */
export function automaticApplyNeedsReviewSentence(reasons: string[]): string {
	const because = reasons.length ? reasons.map((reason) => reason.replace(/\.$/, "")).join("; ") : "of the warnings listed above";
	return `${AUTOMATIC_APPLY_ON_SENTENCE}, but this update needs your review because ${because}.`;
}

/**
 * A room whose previous run was left mid-flight (a closed tab, a lost
 * connection) refuses the next update until that one stops. The person did not
 * abandon anything on purpose, so the screen states the fact plainly and hands
 * them the one action that clears it.
 */
export const ABSORB_RUN_ACTIVE_SENTENCE = "This room is still working on a previous memory update.";
export const ABSORB_RUN_ACTIVE_ACTION = "Stop that update";

/** The same fact for a tidy the room never finished. */
export const REVIEW_RUN_ACTIVE_SENTENCE = "This room is still working on a previous tidy of its notes.";
export const REVIEW_RUN_ACTIVE_ACTION = "Stop that tidy";

/** The one sentence a busy room shows instead of its memory editing actions. */
export const MEMORY_EDIT_BLOCKED_SENTENCE = "Finish or forget the current conversation to edit memory.";

/** Lost contact with a run after the poll retries ran out. */
export const RUN_POLL_LOST_SENTENCE = "This screen lost contact with the update, which may still be running. Check your connection, then try again.";

/** How many times a poll may fail before the connection sentence replaces the screen. */
export const RUN_POLL_MAX_RETRIES = 3;

/** How often a working run is polled. */
export const RUN_POLL_INTERVAL_MS = 2000;


// --- Review (tidying the notes) -------------------------------------------------------------
// Review works note by note: it says the same things in fewer words, folds two
// notes that say one thing into one, and — at the deeper setting — moves what is
// finished or stale to the archive. The screens speak of topics, notes, the
// archive and how full memory is; the engine's words never reach them.

/** One change the tidy makes to a note, as the server reports it. */
export type ReviewChange = ReviewRunChange;

export interface ReviewChangeCounts {
	shortened: number;
	merged: number;
	archived: number;
	closed: number;
	moved: number;
	pinned: number;
	/** Topics folded into another; the row's notes count once, as the strip counts rows. */
	topic_folded: number;
	/** Notes whose words this tidy rewrote. */
	tidied: number;
	/** Notes that leave for the archive. */
	leaving: number;
	/** Every note this tidy touches. */
	notes: number;
	/** Topics holding at least one change. */
	topics: number;
}

/** How full the memory is against its limit, as a whole percent; 0 without a limit. */
export function memoryFullPercent(tokens: number, budgetTokens: number): number {
	if (budgetTokens <= 0) return 0;
	return Math.round((tokens / budgetTokens) * 100);
}

export function reviewChangeCounts(changes: ReviewChange[]): ReviewChangeCounts {
	const counts: ReviewChangeCounts = { shortened: 0, merged: 0, archived: 0, closed: 0, moved: 0, pinned: 0, topic_folded: 0, tidied: 0, leaving: 0, notes: 0, topics: 0 };
	const topics = new Set<string>();
	for (const change of changes) {
		counts[change.kind] += 1;
		topics.add(`${change.section} ${change.topic}`);
	}
	counts.tidied = counts.shortened + counts.merged;
	counts.leaving = counts.archived + counts.closed;
	counts.notes = changes.length;
	counts.topics = topics.size;
	return counts;
}

const REVIEW_CHANGE_LABELS: Record<ReviewRunChangeKind, string> = {
	shortened: "Shortened",
	merged: "Merged",
	archived: "Moved to the archive",
	closed: "Closed",
	moved: "Moved",
	pinned: "Kept",
	topic_folded: "Topic folded",
};

export function reviewChangeKindLabel(kind: ReviewRunChangeKind): string {
	return REVIEW_CHANGE_LABELS[kind] ?? kind;
}

/** The one line of a fold row: which topic went into which, and how many notes went with it. */
export function reviewTopicFoldedLine(change: Pick<ReviewChange, "before" | "after" | "notesMoved">): string {
	const moved = change.notesMoved ?? 0;
	return `"${change.before ?? ""}" folded into "${change.after ?? ""}" — ${moved} ${moved === 1 ? "note" : "notes"} moved`;
}

/** The topic a person reads: the title without the section it sits in. */
export function reviewTopicName(change: Pick<ReviewChange, "topic" | "section">): string {
	const topic = change.topic.replace(/^(Deep Memory|Active Items)\s*\/\s*/, "").trim();
	if (!topic || topic === change.section) return topicLabel(change.section);
	return topicLabel(topic);
}

function plural(n: number, one: string, many: string): string {
	return `${n} ${n === 1 ? one : many}`;
}

/** "3 shortened, 1 merged, 2 moved to the archive" — only the parts that happened. */
export function reviewChangeParts(counts: ReviewChangeCounts): string {
	const parts: string[] = [];
	if (counts.shortened > 0) parts.push(`${counts.shortened} shortened`);
	if (counts.merged > 0) parts.push(`${counts.merged} merged`);
	if (counts.archived > 0) parts.push(`${counts.archived} moved to the archive`);
	if (counts.closed > 0) parts.push(`${counts.closed} closed`);
	if (counts.moved > 0) parts.push(`${counts.moved} filed under another topic`);
	if (counts.pinned > 0) parts.push(`${counts.pinned} kept`);
	// A fold is a topic, not a note, so it comes last and names itself.
	if (counts.topic_folded > 0) parts.push(`${counts.topic_folded} ${counts.topic_folded === 1 ? "topic" : "topics"} folded`);
	return parts.join(", ");
}

export function reviewCardHeadline(counts: ReviewChangeCounts): string {
	if (counts.notes === 0) return "Nothing needed changing.";
	return `${plural(counts.topics, "topic", "topics")} tidied.`;
}

export function reviewCardSentence(counts: ReviewChangeCounts, percentAfter: number, overAfter: boolean): string {
	// The percent lives on the strip and the budget line below; the sentence
	// says what happened and what to do, like the Memorize card's.
	if (counts.notes === 0) return `The notes are already tidy. Memory is ${percentAfter}% full.`;
	const over = overAfter ? ` Memory stays above its budget (${percentAfter}% full).` : "";
	return `${reviewChangeParts(counts)}. Read the changes, keep any note the room should not let go, then save.${over}`;
}

export function reviewSavedHeadline(roomName: string, counts: ReviewChangeCounts): string {
	if (counts.notes === 0) return `Nothing changed in ${roomName}'s memory.`;
	return `${roomName} tidied its memory.`;
}

export function reviewSavedSentence(counts: ReviewChangeCounts, percent: number, over: boolean): string {
	const memory = over ? `Memory is still above its budget (${percent}% full).` : `Memory is ${percent}% full.`;
	if (counts.notes === 0) return `The notes were already tidy. ${memory}`;
	return `${plural(counts.topics, "topic", "topics")}: ${reviewChangeParts(counts)}. ${memory}`;
}

/** One line for a topic's row on the card: "Incident history · 3 notes shortened, 1 moved to the archive". */
export function reviewTopicGroupSummary(topic: string, changes: ReviewChange[]): string {
	const counts = reviewChangeCounts(changes);
	const parts = reviewChangeParts(counts);
	// The first part gets the word "notes" unless it is a fold, which already names itself as a topic.
	const worded = parts
		? parts.replace(/^(\d+)(?! topics? folded)/, (match) => `${match} ${Number(match) === 1 ? "note" : "notes"}`)
		: plural(counts.notes, "note", "notes");
	return `${topicLabel(topic)} · ${worded}`;
}

export const REVIEW_DEPTH_ORDER: readonly ReviewDepth[] = ["wording", "tidy"];

export const REVIEW_DEPTH_ROWS: Record<ReviewDepth, { title: string; text: string }> = {
	wording: { title: "Tidy the wording", text: "Make the notes shorter and clearer. Nothing leaves memory." },
	tidy: { title: "Tidy and move what is finished or stale to the archive", text: "Shorter wording, and notes that are finished, stale or said twice move to the archive, where they can be brought back." },
};

/** Why one depth is offered first, in the person's terms: how full the memory is, never tokens. */
export function reviewDepthSentence(input: { overBudget: boolean; staleFlagged: boolean; budgetTokens: number; reviewTargetTokens: number }): string {
	if (input.overBudget) return "Memory is above its budget, so moving what is finished or stale to the archive is recommended.";
	if (input.staleFlagged) return "The first read found stale notes, so moving them to the archive is recommended.";
	return `Memory is ${memoryFullPercent(input.reviewTargetTokens, input.budgetTokens)}% full and nothing looks stale, so tidying the wording is enough.`;
}

// --- The Review run --------------------------------------------------------

/** Which screen a tidy belongs on. The three working states share one screen. */
export type ReviewRunScreen = "running" | "ready" | "approving" | "saved" | "cancelled" | "failed";

export function reviewRunScreen(state: ReviewRun["state"]): ReviewRunScreen {
	if (state === "prepass" || state === "tidying" || state === "budget") return "running";
	return state;
}

export function reviewRunIsWorking(state: ReviewRun["state"]): boolean {
	return reviewRunScreen(state) === "running";
}

/** The working screen's one line. The server's label is already a topic title. */
export function reviewRunProgressLine(run: ReviewRun): string {
	if (run.state === "prepass") return "Reading this room's notes…";
	if (run.state === "budget") return "Checking the memory budget…";
	const label = (run.progress.label ?? "").trim();
	if (run.progress.groups <= 1) return label ? `Tidying ${topicLabel(label)}…` : "Tidying the notes…";
	const position = Math.min(run.progress.group + 1, run.progress.groups);
	return `Tidying part ${position} of ${run.progress.groups}${label ? ` · ${topicLabel(label)}` : ""}`;
}

/** How full memory is after this tidy, as the percentage a person reads everywhere else. */
export function reviewRunFullPercent(run: ReviewRun): number {
	return memoryFullPercent(run.budget.after + Math.max(0, run.demotion.overageTokens), run.budget.budgetTokens);
}

/** Notes the limit sends to the archive if this is saved as it stands. The tidy's own archive moves are listed under Changes. */
export function reviewRunArchiveCount(run: ReviewRun): number {
	return run.demotion.counts.leaving;
}

/**
 * Automatic maintenance for a tidy: apply only when there is nothing for a
 * person to weigh. Anything leaving for the archive, any crossing of the limit,
 * any topic the tidy could not do, and any warning falls to the card with the
 * reason named.
 */
export function reviewRunFastPathBlockers(run: ReviewRun): string[] {
	const blockers: string[] = [];
	blockers.push(...meaningfulMaintenanceWarnings(run.warnings.filter((warning) => !isEntryIdMigrationNotice(warning))));
	const leaving = run.demotion.counts.leaving;
	if (leaving > 0) {
		blockers.push(leaving === 1
			? "1 note would move to the archive to stay within the budget"
			: `${leaving} notes would move to the archive to stay within the budget`);
	}
	if (run.budget.overBudgetAfter) blockers.push("saving would leave memory above its budget");
	const leftAsIs = run.leftAsIs.reduce((sum, group) => sum + group.topics.length, 0);
	if (leftAsIs > 0) {
		blockers.push(leftAsIs === 1 ? "1 topic was left as it was" : `${leftAsIs} topics were left as they were`);
	}
	return blockers;
}

/** What the person agreed in the discussion, as the card lists it back. */
export interface ReviewGuidanceSummary {
	keepAsIs: string[];
	shorten: string[];
	remove: string[];
	answers: string[];
	instructions: string[];
	topics: string[];
}

export function reviewRunGuidanceSummary(run: ReviewRun): ReviewGuidanceSummary | null {
	const guidance = run.guidance;
	if (!guidance) return null;
	const summary: ReviewGuidanceSummary = {
		keepAsIs: guidance.keepAsIs ?? [],
		shorten: guidance.shorten ?? [],
		remove: guidance.remove ?? [],
		answers: guidance.answers ?? [],
		instructions: guidance.instructions ?? [],
		topics: guidance.topics ?? [],
	};
	const empty = Object.values(summary).every((list) => list.length === 0);
	return empty ? null : summary;
}

/** The saved screen's extra line when the budget, not the tidy, sent notes to the archive. */
export function reviewSavedArchiveSentence(archivedForBudget: number): string | null {
	if (archivedForBudget <= 0) return null;
	return archivedForBudget === 1
		? "1 note moved to the archive to stay within the budget."
		: `${archivedForBudget} notes moved to the archive to stay within the budget.`;
}
