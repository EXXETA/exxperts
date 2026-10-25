// Smoke for the Memorize v2 client copy and gate (apps/web-ui/src/memory-v2-copy.ts).
// Two things are pinned here because a browser would be a poor place to find
// them broken: the sentences a person reads on the run card (they carry the
// server's numbers, and a wrong one misstates what approving does), and the
// automatic-maintenance gate, which decides whether memory is written without
// a second look. The gate must block on anything a person would want to weigh:
// an archived entry, a budget crossing, an unfinished session, a warning.

import fs from "node:fs";
import path from "node:path";
import { absorbRunFailedSessionNote, absorbRunFastPathBlockers, absorbRunNotDoneSentence, changeBesideTag, changeKindLabel, HISTORY_ROW_LINE, KEEP_BOTH_LABEL, MAY_DISAGREE_TAG, REPLACE_OLDER_LABEL, REPLACE_PINNED_LABEL, absorbRunGuidanceSummary, absorbRunIsWorking, absorbRunNewTopics, absorbRunProgressLine, absorbRunSavedSentence, absorbRunScreen, absorbRunSessionLine, ARCHIVE_EXPLANATION, ARCHIVE_ROW_TAG_INSTEAD, ARCHIVE_ROW_TAG_STAYS, archiveCountsLine, archiveHeading, archiveLimitSummary, archivedDuplicateReason, archiveReasonLabel, archiveRowTag, archiveTopicGroupSummary, archiveTopicKey, AUTOMATIC_APPLY_ON_SENTENCE, AUTOMATIC_APPLY_SETTING_LABEL, automaticApplyNeedsReviewSentence, DISCUSS_FIRST_LABEL, maintainChooserFootnote, memorizeChooserText, entryFirstLine, entryGroupPage, entryOriginSentence, filterEntriesByText, fmtTokenCount, fmtTokenLimit, groupEntriesByTopic, KEEP_DEBOUNCE_MS, KEEP_NOTE_HINT, KEEP_TOPIC_LABEL, keepBatchAction, LIMIT_LOWERED_ON_UNDO_SENTENCE, LIMIT_RAISED_ON_SAVE_SENTENCE, MEMORY_LIMIT_BAR_LABEL, MEMORY_LIMIT_CEILING_TOKENS, memoryFullPercent, NEW_TOPIC_TAG, nextKeepIds, nextKeepTopics, overLimitFirstRead, raiseLimitTarget, REVIEW_DEPTH_ORDER, REVIEW_DEPTH_ROWS, REVIEW_FIRST_LABEL, reviewCardHeadline, reviewCardSentence, reviewChangeCounts, reviewChangeKindLabel, reviewDepthSentence, reviewRunArchiveCount, reviewRunFastPathBlockers, reviewRunFullPercent, reviewRunGuidanceSummary, reviewRunIsWorking, reviewRunProgressLine, reviewSavedArchiveSentence, reviewSavedHeadline, reviewSavedSentence, reviewTopicFoldedLine, reviewTopicGroupSummary, reviewTopicName, roundUpToThousand, showMoreLabel, topicKept, type ReviewChange } from "../../web-ui/src/memory-v2-copy.js";
import { AUTOMATIC_APPLY_INFO } from "../../web-ui/src/memory-surface-copy.js";
import { allRoomsFactsLine, allRoomsNotesShown, archivedLabel, archiveRowMeta, asOfSentence, budgetSettledHint, CHANGE_CONVERSATIONS_BLOCK, CHANGE_LINES_META, CHANGE_META, CHANGE_NONE, CHANGE_READ_ERROR, CHANGE_READING, CHANGE_UNVERIFIED, changeMetaLine, countNoteChanges, emptyNoteChangeCounts, fmtMemoryDay, fmtMemoryMoment, HIDE_CHANGE_LABEL, inMemorySinceLine, memorizedConversationsTitle, MEMORY_OVER_LIMIT_SENTENCE, memoryArchiveReason, memoryFullLine, memoryFullShort, memoryHistoryRows, memoryPercentFull, memoryTopicName, memoryUsageTitle, movedLabel, noteChangeTotals, noteFlagLabel, noteRowMeta, notesSummaryLine, roomMemoryFactsLine, topicChangeSummary, topicRowLine, type MemorySaveEvent, undoableHistoryRow, WHAT_CHANGED_LABEL } from "../../web-ui/src/memory-surface-copy.js";
import { diffWords, plainNoteText } from "../../web-ui/src/memory-diff.js";
import { recommendedReviewDepth } from "../src/review-assess.js";
import type { AbsorbRun, AbsorbRunSession, ArchiveRow, EntryCard, ReviewRun, RunBudget, RunDemotion } from "../../web-ui/src/types.js";

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

function session(overrides: Partial<AbsorbRunSession> = {}): AbsorbRunSession {
	return { id: "RC-0007", title: "Nordwind pricing call", date: "2026-07-08", outcome: "folded", attempts: 1, summary: { added: 2, updated: 1, superseded: 1, closed: 1 }, ...overrides };
}

function entry(overrides: Partial<EntryCard> = {}): EntryCard {
	return { id: "m-0031", section: "Deep Memory", topic: "Commercial terms", kind: "fact", saved: "2026-07-08", from: "RC-0007", pinned: false, tokens: 40, text: "- The Nordwind contract renews annually; legal signs before June.", ...overrides };
}

/** One row of the stable archive list: leaving, not kept, not a replacement, unless said otherwise. */
function row(overrides: Partial<ArchiveRow> = {}): ArchiveRow {
	return { ...entry(), leaving: true, kept: false, instead: false, phase: "after", rank: 0, reason: "", ...overrides };
}

/** The demotion block the way the server sends it: the counts come from the rows, never from the browser. */
function demotion(rows: ArchiveRow[], overrides: Partial<Omit<RunDemotion, "entries" | "counts">> = {}): RunDemotion {
	return {
		entries: rows,
		keepIds: rows.filter((candidate) => candidate.kept).map((candidate) => candidate.id),
		keepTopics: [],
		overageTokens: 0,
		protectedOpenItems: 0,
		counts: {
			leaving: rows.filter((candidate) => candidate.leaving).length,
			kept: rows.filter((candidate) => candidate.kept).length,
			instead: rows.filter((candidate) => candidate.leaving && candidate.instead).length,
		},
		...overrides,
	};
}

function budget(overrides: Partial<RunBudget> = {}): RunBudget {
	return { before: 19_000, after: 19_800, budgetTokens: 20_000, savedBudgetTokens: 20_000, overBudgetAfter: false, ceilingTokens: 80_000, ...overrides };
}

function run(overrides: Partial<AbsorbRun> = {}): AbsorbRun {
	return {
		runId: "absorb-run-1",
		agentId: "room-1",
		state: "ready",
		startedAt: "2026-09-13T09:00:00.000Z",
		updatedAt: "2026-09-13T09:04:00.000Z",
		progress: { folded: 10, total: 10 },
		sessions: [session()],
		prepass: { demoted: [] },
		budget: budget(),
		demotion: demotion([]),
		candidate: { sourceFingerprint: { algorithm: "sha256", value: "abc" }, estimatedTokens: 19_800 },
		guidance: null,
		migration: null,
		warnings: [],
		...overrides,
	};
}

// 1. Run state decides the screen, and only the three working states wait.
{
	assert(absorbRunScreen("prepass") === "running" && absorbRunScreen("folding") === "running" && absorbRunScreen("budget") === "running", "the three working states share the progress screen");
	assert(absorbRunScreen("ready") === "ready" && absorbRunScreen("failed") === "failed" && absorbRunScreen("cancelled") === "cancelled", "resting states keep their own name");
	assert(absorbRunIsWorking("folding") && !absorbRunIsWorking("ready"), "only a working run is polled");
}

// 2. The progress line counts the session being read, not the ones behind it.
{
	const folding = run({ state: "folding", progress: { folded: 3, total: 10, current: { id: "RC-0004", title: "Budget review" } } });
	assert(absorbRunProgressLine(folding) === "Memorizing conversation 4 of 10 · Budget review", `the progress line names the session in hand, without the engine's word for it (got: ${absorbRunProgressLine(folding)})`);
	assert(absorbRunProgressLine(run({ state: "prepass" })).startsWith("Reading this room's memory"), "the pre-pass says what it is doing, and never shows a session number it does not have");
	assert(absorbRunProgressLine(run({ state: "budget" })).includes("budget"), "the budget step names the budget");
	const noCurrent = run({ state: "folding", progress: { folded: 0, total: 4 } });
	assert(absorbRunProgressLine(noCurrent) === "Working through 4 conversations…", `without a current session the line stays honest (got: ${absorbRunProgressLine(noCurrent)})`);
}

// 3. Every outcome has a sentence, and a failed session promises to come back.
{
	assert(absorbRunSessionLine(session()) === "Memorized · 2 added, 1 updated, 1 replaced, 1 closed", `the counts read as words (got: ${absorbRunSessionLine(session())})`);
	assert(absorbRunSessionLine(session({ summary: { added: 0, updated: 0, superseded: 0, closed: 0 } })).endsWith("no changes"), "a fold that changed nothing says so instead of listing zeroes");
	const older = { kind: "history" as const, id: "m-0950", topic: "Renewals", after: "- The contract renews in May." };
	assert(absorbRunSessionLine(session({ summary: { added: 0, updated: 0, superseded: 0, closed: 0 }, changes: [older] })) === "Memorized · 1 older value kept as history", "a page whose text was all older than memory says what became of it, not no changes");
	assert(absorbRunSessionLine(session({ summary: { added: 1, updated: 0, superseded: 0, closed: 0 }, changes: [older, { ...older, id: "m-0951" }] })) === "Memorized · 1 added, 2 older values kept as history", "older values are counted after the changes");
	assert(absorbRunSessionLine(session({ outcome: "dropped", reason: "it was small talk about the weather" })) === "Nothing to keep · it was small talk about the weather", "a dropped session carries its reason");
	// A session that waits says so, with no cause: the cause is the diagnostics'.
	const failed = absorbRunSessionLine(session({ outcome: "failed", reason: "The model took too long to answer." }));
	assert(failed === "Waits for the next Memorize.", `a failed session waits, with no cause (got: ${failed})`);
	assert(absorbRunSessionLine(session({ outcome: "skipped", reason: "you asked to leave this one out" })).startsWith("Left out ·"), "a skipped session is the user's own choice, not a failure");
	assert(absorbRunSessionLine(session({ outcome: "pending" })) === "Waiting" && absorbRunSessionLine(session({ outcome: "folding" })) === "Reading this conversation now", "waiting and in-hand sessions read plainly");
}

// 4. The limit bar: the limit, what leaves because of it, and the one button that carries a token count.
{
	assert(fmtTokenCount(19_800) === "19,800", "token counts are grouped for reading");
	assert(fmtTokenLimit(52_000) === "52k" && fmtTokenLimit(80_000) === "80k", `a limit is named the way the slider names it (got: ${fmtTokenLimit(52_000)})`);
	assert(roundUpToThousand(51_600) === 52_000 && roundUpToThousand(52_000) === 52_000 && roundUpToThousand(0) === 0, "a limit is set at the next whole thousand");
	assert(MEMORY_LIMIT_BAR_LABEL === "Memory budget", "the bar is named like the setting it draws");

	// The fixture room: 584 notes leaving, 4 kept, 6 of them replacements, and
	// memory back at its limit once they go. Keeping everything would need 52k.
	const leaving = Array.from({ length: 580 }, (_, index) => row({ id: `m-${index}`, tokens: 54, rank: index, instead: index < 6, topic: index % 2 ? "Commercial terms" : "Team and roles" }));
	const kept = Array.from({ length: 4 }, (_, index) => row({ id: `k-${index}`, tokens: 60, leaving: false, kept: true, rank: 600 + index }));
	const over = archiveLimitSummary({ budget: budget({ before: 51_600, after: 20_000 }), demotion: demotion([...leaving, ...kept]) });
	assert(over.fillLabel === "full", `while notes leave, the filled part reads full (got: ${over.fillLabel})`);
	assert(over.overflowLabel === "580 notes leave", `the grey part counts the notes leaving (got: ${over.overflowLabel})`);
	assert(over.overflowRatio === 1, `580 notes at 54 tokens against a 20k limit is past the limit's own width, so the grey part is capped at it (got: ${over.overflowRatio})`);
	assert(over.countsLine === "Kept 4 · 6 leave instead of them", `the counts line (got: ${over.countsLine})`);
	assert(over.fitsSentence === null && !over.fits, "nothing fits yet");
	assert(over.raise !== null && over.raise.target === 52_000 && over.raise.label === "Raise the budget to 52k to keep them all" && over.raise.ceilingSentence === null, `the raise offer is the next thousand that keeps everything (got: ${JSON.stringify(over.raise)})`);
	assert(archiveCountsLine({ kept: 0, leaving: 12, instead: 0 }) === "Nothing kept yet", "nothing kept says so");
	assert(archiveCountsLine({ kept: 3, leaving: 12, instead: 0 }) === "Kept 3", "no replacements, no second part");
	assert(archiveLimitSummary({ budget: budget({ before: 51_600, after: 20_000 }), demotion: { ...demotion(leaving), counts: { leaving: 580, kept: 0, instead: 0, staying: 340 } } }).fillLabel === "340 notes stay", "the filled part counts the notes that stay when the run says how many");
	assert(archiveCountsLine({ kept: 1, leaving: 1, instead: 1 }) === "Kept 1 · 1 leaves instead of it", "one replacement reads in the singular");

	// A small overage: the grey part is drawn to scale.
	const some = archiveLimitSummary({ budget: budget({ after: 20_000 }), demotion: demotion([row({ tokens: 2_000 })]) });
	assert(some.overflowRatio === 0.1 && some.overflowLabel === "1 note leaves", `2k leaving against 20k is a tenth of the filled part (got: ${some.overflowRatio}, ${some.overflowLabel})`);
	assert(some.raise?.target === 22_000, "and keeping it needs 22k");

	// Everything kept but above the budget: the grey part stays, the button remains.
	const keptOver = archiveLimitSummary({ budget: budget({ after: 20_000 }), demotion: demotion([row({ leaving: false, kept: true, tokens: 40 })], { overageTokens: 1_500 }) });
	assert(!keptOver.fits && keptOver.overflowLabel === "above its budget" && keptOver.percent === 108, `kept notes past the budget are said as such (got: ${keptOver.overflowLabel}, ${keptOver.percent}%)`);
	assert(keptOver.raise?.target === 22_000, `the raise offer covers what was kept (got: ${keptOver.raise?.target})`);

	// After a raise that fits everything: the grey part collapses and the sentence says so.
	const fits = archiveLimitSummary({ budget: budget({ after: 51_600, budgetTokens: 52_000 }), demotion: demotion([row({ leaving: false, kept: false })]) });
	assert(fits.fits && fits.overflowRatio === 0 && fits.fillLabel === "99% full", `once everything fits the filled part shows the percentage (got: ${fits.fillLabel})`);
	assert(fits.fitsSentence === "Everything fits. Memory is 99% full after saving." && fits.raise === null, `and the sentence replaces the counts (got: ${fits.fitsSentence})`);
	assert(raiseLimitTarget({ budget: budget(), demotion: demotion([]) }) === null, "nothing leaving, nothing to raise for");

	// Past the ceiling: the button sets the ceiling and the sentence says why.
	const past = archiveLimitSummary({ budget: budget({ after: 78_000, budgetTokens: 78_000 }), demotion: demotion([row({ tokens: 5_000 })]) });
	assert(past.raise !== null && past.raise.target === 80_000 && past.raise.label === "Raise the budget to 80k" && past.raise.ceilingSentence === "Keeping them all needs more than the 80k ceiling.", `a raise past the ceiling offers the ceiling (got: ${JSON.stringify(past.raise)})`);
	const atCeiling = archiveLimitSummary({ budget: budget({ after: 80_000, budgetTokens: 80_000 }), demotion: demotion([row({ tokens: 5_000 })]) });
	assert(atCeiling.raise !== null && atCeiling.raise.target === 80_000 && atCeiling.raise.ceilingSentence !== null, "at the ceiling the sentence still says why the rest must leave");

	// Tokens live in the raise button and nowhere else on the bar.
	for (const text of [over.fillLabel, over.overflowLabel, over.countsLine, fits.fitsSentence ?? "", past.raise?.ceilingSentence ?? "", ARCHIVE_EXPLANATION]) {
		assert(!/token/i.test(text), `no token count outside the raise button (got: ${text})`);
	}
	assert(ARCHIVE_EXPLANATION === "Keep holds a note for this update only; another note leaves in its place. The budget decides how many stay. Notes in the archive stay readable in Room settings and can come back any time.", `the one explanation above the list (got: ${ARCHIVE_EXPLANATION})`);
	assert(!/least[- ]used/i.test(ARCHIVE_EXPLANATION), "nothing records chat use, so the copy never claims least-used");
}

// 5. The fast path: a clean run passes, and each thing a person would weigh blocks it.
{
	// A clean fold adds, updates and replaces. One that closed an open item, or
	// one the model judged not worth keeping, is a judgement a person sees.
	const folded = (overrides: Partial<AbsorbRunSession> = {}): AbsorbRunSession => session({ summary: { added: 2, updated: 1, superseded: 0, closed: 0 }, ...overrides });
	const clean = (overrides: Partial<AbsorbRun> = {}): AbsorbRun => run({ sessions: [folded()], ...overrides });
	assert(absorbRunFastPathBlockers(clean()).length === 0, "a clean run needs no second look");
	// A run the Memory model or a restart stopped is never saved on its own: the person sees why and the ways on.
	const absorbStop = { kind: "outage", model: { provider: "openai-compatible", model: "gpt-5.5" }, cause: "not-answering" } as const;
	assert(absorbRunFastPathBlockers(clean({ stop: absorbStop } as any)).join("|") === "the Memory model stopped before it finished", `a stopped Memorize waits for a person (got: ${absorbRunFastPathBlockers(clean({ stop: absorbStop } as any)).join("|")})`);
	assert(absorbRunFastPathBlockers(clean({ stop: { ...absorbStop, kind: "restart", cause: "restarted" } } as any)).join("|") === "the app restarted before it finished", "a restarted Memorize waits for a person");
	assert(absorbRunFastPathBlockers(clean({ warnings: ["proposal missing Section-level change log"] })).length === 0, "an engine warning never blocks");
	assert(absorbRunFastPathBlockers(clean({ warnings: ["no memory has been written"] })).length === 0, "the status line the server always sends is not a warning");
	assert(absorbRunFastPathBlockers(clean({ demotion: demotion([row({ phase: "before" })]) }))[0] === "1 note would move to the archive to stay within the budget", "a note leaving, before or after the read, falls to the card");
	assert(absorbRunFastPathBlockers(clean({ demotion: demotion([row(), row({ id: "m-2" })]) }))[0].startsWith("2 notes would move"), "the count is the server's leaving count");
	assert(absorbRunFastPathBlockers(clean({ demotion: demotion([row({ leaving: false, kept: true })]) })).length === 0, "a list where nothing leaves any more does not block");
	assert(absorbRunFastPathBlockers(clean({ budget: budget({ after: 21_000, overBudgetAfter: true }) }))[0].includes("above its budget"), "a budget crossing is never automatic");
	assert(absorbRunFastPathBlockers(clean({ sessions: [folded(), folded({ id: "RC-0008", outcome: "failed", reason: "The model took too long to answer." })] })).length === 0, "an unfinished session waits for the next Memorize and holds nothing");
	// A new note beside a pinned note, or one that may disagree with memory, holds the save; a plain add does not.
	const added = (beside?: "pinned" | "may-disagree") => ({ kind: "added" as const, id: `m-${beside ?? "plain"}`, topic: "Pricing", after: "- A note.", ...(beside ? { beside } : {}) });
	const tagged = (...changes: ReturnType<typeof added>[]) => clean({ sessions: [folded({ changes })] });
	assert(absorbRunFastPathBlockers(tagged(added())).length === 0, "a plain add holds nothing");
	assert(absorbRunFastPathBlockers(tagged(added("pinned"))).join("|") === "1 new note may disagree with a pinned note", `a note beside a pinned note holds the save (got: ${absorbRunFastPathBlockers(tagged(added("pinned"))).join("|")})`);
	assert(absorbRunFastPathBlockers(tagged(added("pinned"), added("pinned"))).join("|") === "2 new notes may disagree with pinned notes", "two say so in the plural");
	assert(absorbRunFastPathBlockers(tagged(added("may-disagree"))).join("|") === "1 new note may disagree with one already in memory", "a note that may disagree holds the save");
	assert(absorbRunFastPathBlockers(tagged(added("may-disagree"), added("may-disagree"), added("pinned"))).join("|") === "1 new note may disagree with a pinned note|2 new notes may disagree with notes already in memory", "both reasons, each counted");
	// The line under a tagged row names the other note by its first line, always in view, with the two answers.
	const withLine = (beside: "pinned" | "may-disagree", extra: object = {}) => ({ ...added(beside), besideLine: "- Send commercial summaries as one page, numbers first.", ...extra });
	const pinnedTag = changeBesideTag(withLine("pinned"));
	assert(pinnedTag?.tag === MAY_DISAGREE_TAG && pinnedTag.line === 'May disagree with your pinned note: "Send commercial summaries as one page, numbers first."' && pinnedTag.replaceLabel === REPLACE_PINNED_LABEL && REPLACE_PINNED_LABEL === "Replace my pinned note with this", `beside a pinned note, the one tag, its line and its Replace (got ${JSON.stringify(pinnedTag)})`);
	const pinnedGone = changeBesideTag({ ...added("pinned"), besideState: "gone" as const });
	assert(pinnedGone?.tag === MAY_DISAGREE_TAG && pinnedGone.line === "The pinned note it may disagree with is no longer in memory.", `a pinned note that left says so in the same words (got ${JSON.stringify(pinnedGone)})`);
	const disagreeTag = changeBesideTag(withLine("may-disagree"));
	assert(disagreeTag?.tag === MAY_DISAGREE_TAG && MAY_DISAGREE_TAG === "may disagree" && disagreeTag.line === 'May disagree with: "Send commercial summaries as one page, numbers first."' && disagreeTag.replaceLabel === REPLACE_OLDER_LABEL && REPLACE_OLDER_LABEL === "Replace the older note with this" && KEEP_BOTH_LABEL === "Keep both", `the may-disagree tag, its line and its Replace (got ${JSON.stringify(disagreeTag)})`);
	// Two notes that may disagree say the day each was learned, when known; a pinned note's line does not.
	const dated = changeBesideTag(withLine("may-disagree", { besideLearned: "2026-08-02", learned: "2026-09-11" }));
	assert(dated?.line === 'May disagree with: "Send commercial summaries as one page, numbers first." (as of 2 Aug; new note as of 11 Sep)', `a may-disagree line shows both days (got ${JSON.stringify(dated?.line)})`);
	assert(changeBesideTag(withLine("may-disagree", { learned: "2026-09-11" }))?.line.endsWith('first." (new note as of 11 Sep)') && changeBesideTag(withLine("may-disagree", { besideLearned: "2026-08-02" }))?.line.endsWith('first." (as of 2 Aug)'), "only a known day is shown");
	assert(changeBesideTag(withLine("pinned", { besideLearned: "2026-08-02", learned: "2026-09-11" }))?.line === 'May disagree with your pinned note: "Send commercial summaries as one page, numbers first." (as of 2 Aug; new note as of 11 Sep)', "a pinned note's line carries the days too: the person weighs a Replace there as well");
	assert(changeBesideTag(withLine("may-disagree", { besideState: "leaving", besideLearned: "2026-08-02", learned: "2026-09-11" }))?.line.startsWith('May disagree with: "Send commercial summaries as one page, numbers first." (as of 2 Aug; new note as of 11 Sep). One of the two'), "the days sit after the other note, and a period ends them before what the state adds");
	assert(changeBesideTag(withLine("may-disagree", { besideState: "self-closed", learned: "2026-09-11" }))?.line === 'May disagree with: "Send commercial summaries as one page, numbers first." (new note as of 11 Sep). This new note is closed later in this update, so it replaces nothing.', "a period ends the days before the self-closed sentence");
	const leavingTag = changeBesideTag(withLine("may-disagree", { besideState: "leaving" }));
	assert(leavingTag?.replaceLabel === null && leavingTag.line.startsWith('May disagree with: "Send') && leavingTag.line.includes("going to the archive"), `a note going to the archive offers no Replace and says why (got ${JSON.stringify(leavingTag)})`);
	const goneTag = changeBesideTag({ ...added("may-disagree"), besideState: "gone" as const });
	assert(goneTag?.replaceLabel === null && goneTag.line === "The note it may disagree with is no longer in memory.", `a note whose other note left says so, never a blank line (got ${JSON.stringify(goneTag)})`);
	const closedTag = changeBesideTag({ ...added("may-disagree"), besideState: "closed" as const });
	assert(closedTag?.replaceLabel === null && closedTag.line === "The note it may disagree with is closed by this update.", `a note this same update closes is still in memory until the save, and the line says it is closed (got ${JSON.stringify(closedTag)})`);
	const closedNamed = changeBesideTag(withLine("may-disagree", { besideState: "closed", besideLearned: "2026-08-02", learned: "2026-09-11" }));
	assert(closedNamed?.replaceLabel === null && closedNamed.line === 'May disagree with: "Send commercial summaries as one page, numbers first." (as of 2 Aug; new note as of 11 Sep). That note is closed by this update.', `a closed note whose line is known is named, as the self-closed line does (got ${JSON.stringify(closedNamed)})`);
	assert(changeBesideTag(withLine("pinned", { besideState: "closed", choice: "replace" }))?.line === 'May disagree with your pinned note: "Send commercial summaries as one page, numbers first." That note is closed by this update.', "a closed pinned note is named the same way, and a stale Replace changes nothing");
	const selfClosedTag = changeBesideTag(withLine("may-disagree", { besideState: "self-closed" }));
	assert(selfClosedTag?.replaceLabel === null && selfClosedTag.line === 'May disagree with: "Send commercial summaries as one page, numbers first." This new note is closed later in this update, so it replaces nothing.', `a new note this update closes later names the other note and offers no Replace (got ${JSON.stringify(selfClosedTag)})`);
	assert(absorbRunFastPathBlockers(tagged({ ...added("pinned"), choice: "replace" } as ReturnType<typeof added>)).join("|") === "1 new note may disagree with a pinned note", "a Replace chosen still holds the automatic save: the person looks anyway");
	assert(changeBesideTag(added()) === null, "a plain add carries no tag");
	// The line follows the choice: with Replace pressed it says what the save will do; Keep both keeps the line as it was.
	const replacingPinned = changeBesideTag(withLine("pinned", { choice: "replace", besideLearned: "2026-08-02", learned: "2026-09-11" }));
	assert(replacingPinned?.line === 'Replaces your pinned note: "Send commercial summaries as one page, numbers first." (as of 2 Aug; new note as of 11 Sep)' && replacingPinned.replaceLabel === REPLACE_PINNED_LABEL, `with Replace pressed, the pinned line says it replaces (got ${JSON.stringify(replacingPinned)})`);
	assert(changeBesideTag(withLine("may-disagree", { choice: "replace" }))?.line === 'Replaces the older note: "Send commercial summaries as one page, numbers first."', "with Replace pressed, the older note's line says it replaces");
	assert(changeBesideTag(withLine("may-disagree", { choice: "keep-both" }))?.line === 'May disagree with: "Send commercial summaries as one page, numbers first."' && changeBesideTag(withLine("pinned", { choice: "keep-both" }))?.line === 'May disagree with your pinned note: "Send commercial summaries as one page, numbers first."', "with Keep both, the line stays");
	assert(changeBesideTag(withLine("may-disagree", { choice: "replace", besideState: "leaving" }))?.line.startsWith('May disagree with: "Send'), "where no Replace is offered, a stale choice changes nothing");
	const dropped = absorbRunFastPathBlockers(clean({ sessions: [folded(), folded({ id: "RC-0008", outcome: "dropped", reason: "small talk" })] }));
	assert(dropped.join("|") === "1 conversation would be dropped as nothing to keep", `a conversation the model judged not worth keeping is a judgement a person sees (got: ${dropped.join("|")})`);
	assert(absorbRunFastPathBlockers(clean({ sessions: [folded({ outcome: "dropped" }), folded({ id: "RC-0008", outcome: "dropped" })] }))[0] === "2 conversations would be dropped as nothing to keep", "two dropped conversations read in the plural");
	// A closed item blocks, counted from the summary when that is all the run
	// carries, and from the rows when it carries them; a replace does not.
	const bySummary = absorbRunFastPathBlockers(clean({ sessions: [session()] }));
	assert(bySummary.join("|") === "1 open item would be closed", `a fold that closed an item waits for a person, and one that replaced a note does not (got: ${bySummary.join("|")})`);
	const byRows = absorbRunFastPathBlockers(clean({ sessions: [folded({ changes: [{ kind: "superseded", id: "m-1", topic: "Pricing" }, { kind: "superseded", id: "m-2", topic: "Pricing" }, { kind: "closed", id: "m-3", topic: "Active Items" }, { kind: "closed", id: "m-4", topic: "Active Items" }, { kind: "added", id: "m-5", topic: "Pricing" }] })] }));
	assert(byRows.join("|") === "2 open items would be closed", `the rows are counted when the run carries them, two read in the plural, and the replaced rows do not block (got: ${byRows.join("|")})`);
	assert(absorbRunFastPathBlockers(clean({ sessions: [folded({ changes: [{ kind: "added", id: "m-5", topic: "Pricing" }, { kind: "updated", id: "m-6", topic: "Pricing" }, { kind: "pinned", id: "m-7", topic: "Pricing" }] })] })).length === 0, "an add, a plain update and a pin are the fast path's own business");
}

// 6. What stays behind, and what the saved screen states.
{
	assert(absorbRunFailedSessionNote(run()) === null, "no failures, no note");
	assert(absorbRunFailedSessionNote(run({ sessions: [session({ outcome: "failed" })] })) === "1 conversation waits for the next Memorize.", "one failure reads in the singular");
	assert(absorbRunFailedSessionNote(run({ sessions: [session({ outcome: "failed" }), session({ id: "RC-0008", outcome: "failed" })] })) === "2 conversations wait for the next Memorize.", "two failures read in the plural");
	const saved = absorbRunSavedSentence({ foldedSessions: ["RC-0007", "RC-0008"], remainingSessions: ["RC-0009"], archivedEntries: 5 });
	assert(saved === "2 conversations became lasting notes. 1 conversation waits for the next Memorize. 5 notes moved to the archive.", `the saved screen states all three numbers (got: ${saved})`);
	const meanwhile = absorbRunSavedSentence({ foldedSessions: ["RC-0007"], remainingSessions: [], archivedEntries: 0, rebasedOnto: ["RC-0009"] });
	assert(meanwhile === "1 conversation became lasting notes. 1 conversation waits for the next Memorize.", `a conversation remembered during the run is named as still waiting (got: ${meanwhile})`);
	assert(absorbRunSavedSentence({ foldedSessions: ["RC-0007"], remainingSessions: [], archivedEntries: 0, rebasedOnto: [] }).endsWith("lasting notes."), "an empty rebase list says nothing");
	assert(absorbRunSavedSentence({ foldedSessions: ["RC-0007"], remainingSessions: [], archivedEntries: 0 }) === "1 conversation became lasting notes.", "a clean run says only what happened");
	const topics = absorbRunSavedSentence({ foldedSessions: ["RC-0007"], remainingSessions: [], archivedEntries: 0, newTopics: 2 });
	assert(topics === "1 conversation became lasting notes. 2 new topics.", `topics the update created are counted (got: ${topics})`);
	assert(absorbRunSavedSentence({ foldedSessions: ["RC-0007"], newTopics: 1 }).includes("1 new topic."), "one new topic reads in the singular");
	// A note replaced is said apart: it did not leave memory, a newer text took its place.
	const replaced = absorbRunSavedSentence({ foldedSessions: ["RC-0007"], remainingSessions: [], archivedEntries: 1, replacedEntries: 1 });
	assert(replaced === "1 conversation became lasting notes. 1 note replaced; the old one is in the archive.", `one replaced note (got: ${replaced})`);
	const replacedAndMoved = absorbRunSavedSentence({ foldedSessions: ["RC-0007", "RC-0008"], remainingSessions: [], archivedEntries: 5, replacedEntries: 2 });
	assert(replacedAndMoved === "2 conversations became lasting notes. 2 notes replaced; the old ones are in the archive. 3 notes moved to the archive.", `replaced notes apart from the ones moved to the archive (got: ${replacedAndMoved})`);
	const history = absorbRunSavedSentence({ foldedSessions: ["RC-0007", "RC-0008"], remainingSessions: [], archivedEntries: 1, historyKept: 2 });
	assert(history === "2 conversations became lasting notes. 1 note moved to the archive. 2 older values kept as history.", `older values kept as history are counted apart from notes that left memory (got: ${history})`);
	assert(absorbRunSavedSentence({ foldedSessions: ["RC-0007"], historyKept: 1 }).endsWith("1 older value kept as history."), "one older value reads in the singular");
	assert(changeKindLabel("history") === "Older" && HISTORY_ROW_LINE === "An older conversation said this. A newer note says otherwise, so this is kept in the archive as history.", `an older value's row is labelled Older and never says the newer note stays, since a Replace on another row may archive it (got: ${JSON.stringify(HISTORY_ROW_LINE)})`);
	assert(LIMIT_RAISED_ON_SAVE_SENTENCE === "The memory budget was raised with this save." && !/\d/.test(LIMIT_RAISED_ON_SAVE_SENTENCE), "the saved screen says the budget rose, without repeating the number");
	assert(LIMIT_LOWERED_ON_UNDO_SENTENCE(20_000) === "The budget is back at 20k." && LIMIT_LOWERED_ON_UNDO_SENTENCE(52_000) === "The budget is back at 52k.", `an undo that took a raise back names the budget the way the slider does (got: ${LIMIT_LOWERED_ON_UNDO_SENTENCE(20_000)})`);
}

// 7. Entry wording: the room's own vocabulary never reaches the screen.
{
	assert(entryOriginSentence(entry()) === "from a conversation saved 2026-07-08", `a session id is shown as a date (got: ${entryOriginSentence(entry())})`);
	assert(entryOriginSentence(entry({ from: undefined })) === null, "an entry with no origin says nothing about one");
	assert(entryFirstLine(entry().text) === "The Nordwind contract renews annually; legal signs before June.", "the first line drops the bullet marker");
	assert(archiveReasonLabel("budget") === "budget" && archiveReasonLabel("superseded") === "replaced" && archiveReasonLabel("done") === "finished" && archiveReasonLabel("user") === "removed by you", "archive reasons read as plain words");
	assert(NEW_TOPIC_TAG === "new topic", "a topic the update created is tagged as such");
	const created = run({ sessions: [session({ changes: [{ kind: "added", id: "m-1", topic: "Pricing", after: "- a", newTopic: true }, { kind: "added", id: "m-2", topic: "Pricing", after: "- b" }] }), session({ id: "RC-0008", changes: [{ kind: "added", id: "m-3", topic: "Legal", after: "- c", newTopic: true }] })] });
	assert(absorbRunNewTopics(created) === 2 && absorbRunNewTopics(run()) === 0, `new topics are counted across conversations, once per add that created one (got: ${absorbRunNewTopics(created)})`);
}

// 8. The archive lists: grouped, counted, searchable, tagged, and paged when huge.
{
	const rows: ArchiveRow[] = [
		row({ id: "m-1", topic: "Commercial terms", tokens: 40, rank: 3 }),
		row({ id: "m-2", topic: "Commercial terms", tokens: 60, text: "- The Berlin pilot ends in March.", leaving: false, kept: true, rank: 9 }),
		row({ id: "m-3", topic: "General", tokens: 30, text: "- The wiki page owns the advisory board.", instead: true, rank: 1 }),
		row({ id: "m-4", section: "Active Items", topic: "Active Items", kind: "item", tokens: 10, text: "- Send the renewal note.", leaving: false, rank: 12 }),
	];
	const groups = groupEntriesByTopic(rows);
	assert(groups.length === 3, `one group per topic (got: ${groups.length})`);
	assert(groups[groups.length - 1].section === "Active Items", "Deep Memory topics come before Active Items, as the memory itself reads");
	assert(archiveTopicGroupSummary(groups[0]) === "Commercial terms · 2 notes · 1 kept · 1 leaving", `a closed group states what it holds and what becomes of it (got: ${archiveTopicGroupSummary(groups[0])})`);
	assert(archiveTopicGroupSummary(groups[1]) === "General · 1 note · 1 leaving", `a kept count of zero is not said (got: ${archiveTopicGroupSummary(groups[1])})`);
	assert(archiveTopicGroupSummary(groups[2]) === "Open items · 1 note · 0 leaving", `one entry reads in the singular, and the open-items section gets the person's word (got: ${archiveTopicGroupSummary(groups[2])})`);
	assert(archiveHeading(584) === "584 notes going to the archive" && archiveHeading(1) === "1 note going to the archive", "the heading counts what leaves");
	assert(archiveHeading(0) === "Nothing goes to the archive", `when nothing leaves the heading says so instead of counting to zero (got: ${archiveHeading(0)})`);
	assert(KEEP_TOPIC_LABEL === "Keep this topic", "the topic checkbox keeps the topic, not every row in it");
	assert(/for this update only/.test(KEEP_NOTE_HINT) && /not pinned/.test(KEEP_NOTE_HINT) && /for this update only/.test(ARCHIVE_EXPLANATION), `a keep says it lasts for this update and pins nothing (got: ${KEEP_NOTE_HINT})`);
	assert(reviewChangeKindLabel("pinned") === "Pinned", `a pin row reads as a pin, never as a keep (got: ${reviewChangeKindLabel("pinned")})`);
	assert(filterEntriesByText(rows, "berlin").length === 1, "the search box finds an entry by its text");
	assert(filterEntriesByText(rows, "COMMERCIAL").length === 2, "and by its topic, whatever the case");
	assert(filterEntriesByText(rows, "  ").length === rows.length, "an empty search hides nothing");
	// The tags: a replacement says so, a row that stopped leaving says so, a kept row is dimmed instead.
	assert(archiveRowTag(rows[2]) === ARCHIVE_ROW_TAG_INSTEAD && ARCHIVE_ROW_TAG_INSTEAD === "leaves instead", "a replacement carries its tag");
	assert(archiveRowTag(rows[3]) === ARCHIVE_ROW_TAG_STAYS && ARCHIVE_ROW_TAG_STAYS === "stays", "a row that no longer leaves says so");
	assert(archiveRowTag(rows[0]) === null && archiveRowTag(rows[1]) === null, "a plain leaving row and a kept row carry no tag");
	assert(archiveRowTag({ leaving: false, kept: false, instead: true }) === ARCHIVE_ROW_TAG_STAYS, "a replacement that stopped leaving reads as staying, not as a replacement");
	// A list under the threshold is never paged; a large one hands out a page.
	const many = Array.from({ length: 120 }, (_, index) => row({ id: `m-${index}`, topic: "Commercial terms" }));
	assert(entryGroupPage(many, 120, false).hidden === 0, "a list of 120 entries is short enough to open whole");
	const paged = entryGroupPage(many, 240, false);
	assert(paged.visible.length === 50 && paged.hidden === 70, `past 200 entries a topic opens 50 rows first (got: ${paged.visible.length} shown, ${paged.hidden} hidden)`);
	assert(showMoreLabel(paged.hidden) === "Show 70 more", `the rest are one click away (got: ${showMoreLabel(paged.hidden)})`);
	assert(entryGroupPage(many, 240, true).hidden === 0, "once opened fully, a topic holds nothing back");
	assert(showMoreLabel(1_250) === "Show 1,250 more", "a big remainder is grouped for reading");
}

// 9. Keep is local first and sent as one set, never one request per entry; a topic is kept by name.
{
	assert(nextKeepIds([], ["m-1"], true).join() === "m-1", "keeping an entry adds it");
	assert(nextKeepIds(["m-1", "m-2"], ["m-1"], false).join() === "m-2", "unkeeping removes it and leaves the rest");
	assert(nextKeepIds(["m-1"], ["m-1", "m-2"], true).join() === "m-1,m-2", "a set carries every entry in it, without duplicating one already kept");
	assert(nextKeepIds(["m-1", "m-2", "m-3"], ["m-1", "m-2"], false).join() === "m-3", "and clears several at once");
	assert(keepBatchAction(false) === "send" && keepBatchAction(true) === "queue", "a keep request in flight collects the next set instead of racing it");
	assert(KEEP_DEBOUNCE_MS === 400, "a burst of toggles is collected before anything is sent");
	assert(archiveTopicKey("Deep Memory", "Nordwind integration") === "Deep Memory/Nordwind integration", "a topic is named to the server as section and title");
	assert(topicKept(["Deep Memory/Nordwind integration"], "Deep Memory", " nordwind Integration "), "a protected topic matches case-insensitive and trimmed, the way the server matches it");
	assert(!topicKept(["Deep Memory/Nordwind integration"], "Active Items", "Nordwind integration"), "the same title in another section is another topic");
	assert(nextKeepTopics([], "Deep Memory", "Hiring", true).join() === "Deep Memory/Hiring", "keeping a topic adds it");
	assert(nextKeepTopics(["Deep Memory/Hiring", "Deep Memory/Payments"], "Deep Memory", "hiring", false).join() === "Deep Memory/Payments", "unkeeping removes it however it was cased, and leaves the rest");
	assert(nextKeepTopics(["Deep Memory/Hiring"], "Deep Memory", "Hiring", true).join() === "Deep Memory/Hiring", "keeping a kept topic does not double it");
}

// 10. The instructions the person gave, read back in their own words.
{
	assert(absorbRunGuidanceSummary(run()) === null, "a run started without instructions shows no instructions section");
	assert(absorbRunGuidanceSummary(run({ guidance: { pin: [], drop: [], corrections: [], topics: [], instructions: [] } })) === null, "and neither does an empty sign-off");
	const guided = run({
		sessions: [session({ id: "RC-0007" }), session({ id: "RC-0009", title: "Monday standup", outcome: "skipped", reason: "only status chatter" })],
		demotion: demotion([row({ id: "m-0031" })]),
		guidance: {
			pin: ["m-0031", "m-9999"],
			drop: [{ session: "RC-0009", reason: "only status chatter" }, { session: "RC-0011", reason: "a duplicate" }],
			corrections: ["The Berlin pilot ends in March, not May."],
			topics: [{ create: "Pricing" }, { merge: ["Legal", "Contracts"], into: "Commercial terms" }],
			instructions: ["Keep the wording short."],
		},
	});
	const summary = absorbRunGuidanceSummary(guided);
	assert(summary !== null, "a run started with instructions shows them");
	assert(summary!.pins[0] === "The Nordwind contract renews annually; legal signs before June.", `a pinned entry is shown as its line, not its id (got: ${summary!.pins[0]})`);
	assert(summary!.pins[1] === "m-9999", "an entry this card does not hold falls back to the id it was given");
	assert(summary!.drops[0].text === "Monday standup · only status chatter" && summary!.drops[0].leftOut, `a session that was left out says so (got: ${summary!.drops[0].text})`);
	assert(summary!.drops[1].text === "RC-0011 · a duplicate" && !summary!.drops[1].leftOut, "a drop the run did not apply is not marked as applied");
	assert(summary!.topics[0] === 'Create the topic "Pricing"', `a new topic reads as an instruction (got: ${summary!.topics[0]})`);
	assert(summary!.topics[1] === 'Merge "Legal" and "Contracts" into "Commercial terms"', `a merge names both sides (got: ${summary!.topics[1]})`);
	assert(summary!.corrections.length === 1 && summary!.instructions.length === 1, "corrections and plain instructions are carried through as written");
	// A removal is listed as done only when the run did it; one it could not do says so; free text is what the model was told.
	const removal = absorbRunGuidanceSummary(run({ guidance: { pin: [], drop: [], corrections: [], topics: [], instructions: ["Keep the wording short.", 'Remove the "Shared calendar" task.', 'Delete "the old offsite".'] }, requests: [{ text: 'Remove the "Shared calendar" task.', done: true, entry: "- Shared calendar." }, { text: 'Delete "the old offsite".', done: false }] }));
	assert(JSON.stringify(removal?.removed) === JSON.stringify(["Shared calendar."]) && JSON.stringify(removal?.notDone) === JSON.stringify([{ text: 'Delete "the old offsite".', several: false }]) && JSON.stringify(removal?.instructions) === JSON.stringify(["Keep the wording short."]), `removals split by what the run did, got ${JSON.stringify(removal)}`);
	assert(absorbRunNotDoneSentence('Delete "the old offsite".') === 'Not done: Delete "the old offsite". Nothing in memory matched it exactly; you can delete the entry on the Memory page.', `the not-done line, got ${absorbRunNotDoneSentence('Delete "the old offsite".')}`);
	const several = absorbRunNotDoneSentence('Close the "Call the venue" task.', true);
	assert(several === 'Not done: Close the "Call the venue" task. More than one entry in memory matches those words; you can delete the right one on the Memory page.', `two matches are named as two, got ${several}`);
}

// 10c. A page as the person sees it: plain labels and no must-keep marker; the
// Remember editor shows a marker as "Keep:" and gives it back on save, so the
// stored page is as before.
{
	const copy = await import("../../web-ui/src/memory-v2-copy.js") as any;
	assert(typeof copy.plainMemoryText === "function" && typeof copy.editableMemoryBody === "function" && typeof copy.storedMemoryBody === "function", "the display helpers exist");
	const page = "**Session arc:** We planned Porto.\n\n**Body:**\n- **must-keep:** The guest is vegetarian.\n- The trip is in May **must-keep**.\n- Other.\n\n**Parked:**\nNone";
	const shown = copy.plainMemoryText(page);
	assert(shown === "**What happened:** We planned Porto.\n\n**What to keep:**\n- The guest is vegetarian.\n- The trip is in May.\n- Other.\n\n**Still open:**\nNone", `the page as shown, got ${JSON.stringify(shown)}`);
	// Every importance marker the Remember prompt asks for goes the way must-keep does, and so does a quoted trigger.
	const marked = "- **Key:** The launch is in May.\n- The budget is **provisional**.\n- **Critical** The client signs on Friday.\n- Fernando is vegetarian (\u201cNote that\u201d).\n- Keep the \u201cblue plan\u201d name.";
	assert(copy.plainMemoryText(marked) === "- The launch is in May.\n- The budget is provisional.\n- The client signs on Friday.\n- Fernando is vegetarian.\n- Keep the \u201cblue plan\u201d name.", `no engine marker on the page, got ${JSON.stringify(copy.plainMemoryText(marked))}`);
	const body = "- **must-keep:** The guest is vegetarian.\n- Other.";
	assert(copy.editableMemoryBody(body) === "- Keep: The guest is vegetarian.\n- Other.", `the editor shows the marker as Keep, got ${JSON.stringify(copy.editableMemoryBody(body))}`);
	assert(copy.storedMemoryBody(copy.editableMemoryBody(body), body) === body, "and saves it back as it was");
	// A line the model wrote as "Keep:" stays as written: only the person marks a note must-keep.
	const written = "- Keep: the weekly sync on Mondays.\n- Other.";
	assert(copy.storedMemoryBody(copy.editableMemoryBody(written), written) === written, `a model-written Keep line is saved as written, got ${JSON.stringify(copy.storedMemoryBody(copy.editableMemoryBody(written), written))}`);
	assert(copy.storedMemoryBody("- Keep: the weekly sync on Mondays.\n- Keep: Other.", written) === "- Keep: the weekly sync on Mondays.\n- **must-keep:** Other.", "a line the person marked Keep in the editor is must-keep");
	assert(/storedMemoryBody\(approvedFields\.body, proposal\.fields\.body\)/.test((await import("node:fs")).readFileSync(new URL("../../web-ui/src/App.tsx", import.meta.url), "utf-8")), "the reviewed save compares against the proposal's own page");
	const appSource = (await import("node:fs")).readFileSync(new URL("../../web-ui/src/App.tsx", import.meta.url), "utf-8");
	assert(!/<span>(Session arc|Body|Parked \/ Open items)<\/span>/.test(appSource), "the editor's labels are plain");
	const memorySource = (await import("node:fs")).readFileSync(new URL("../../web-ui/src/components/Memory.tsx", import.meta.url), "utf-8");
	assert(memorySource.includes("plainMemoryText(s.content)"), "a saved page on the Memory page is shown plain");
}

// 10d. Home and Room settings speak plainly: no runtime, thread or Bash in a
// tooltip or a line, and one name for a room due to memorize.
{
	const fs = await import("node:fs");
	const read = (file: string) => fs.readFileSync(new URL(`../../web-ui/src/${file}`, import.meta.url), "utf-8");
	const sources = ["components/launcher-room-card.tsx", "components/RoomSettingsModal.tsx", "components/RoomWorkspaceSection.tsx", "App.tsx"].map((file) => [file, read(file)] as const);
	for (const [file, source] of sources) {
		const found = source.match(/prepared room runtime|persistent chat"|standby thread|use Bash/g);
		assert(!found, `${file} still says ${JSON.stringify(found)}`);
	}
	for (const file of ["components/launcher-room-card.tsx", "components/RoomSettingsModal.tsx"]) {
		assert(!read(file).includes('"ready to memorize"'), `${file}: a room due to memorize is called what Home's badge calls it`);
	}
}

// 10e. The judge's wording nits: no "active thread", no "room transcript", no
// promise to pick up where you left off in an empty conversation, Connectors
// with no CLI, MCP or file path, and the skills count with no tokens.
{
	const fs = await import("node:fs");
	const read = (file: string) => fs.readFileSync(new URL(`../../web-ui/src/${file}`, import.meta.url), "utf-8");
	for (const [file, banned] of [
		["App.tsx", /return to the active thread|current room transcript|pick up right where you left off|temporary and will be discarded|Discard discussion|Abort this memory discussion|so this can be undone/],
		["components/ConnectorsPage.tsx", /Same list on the web and in the CLI|Add any MCP server|Configured MCP servers|Saved to ~\/\.exxperts\/agent\/mcp\.json\. Test/],
		["components/RoomSkillsSection.tsx", /tokens per turn/],
	] as const) {
		const found = read(file).match(banned);
		assert(!found, `${file} still says ${JSON.stringify(found?.[0])}`);
	}
	assert(read("components/topic-move.tsx").includes('<label className="memory-entry-move-label"') && read("components/room-memory-entries.tsx").includes("<TopicMove ") && read("components/absorb-run-screen.tsx").includes("<TopicMove "), "the Move box says what it does, and Room settings and the Memorize card share it");
	// Deleting an archived note is true about what stays: earlier versions in the memory's history still hold it.
	const entriesSource = read("components/room-memory-entries.tsx");
	assert(entriesSource.includes('"Delete this archived note?"') && entriesSource.includes('"It leaves the archive and cannot be brought back. Earlier versions in this memory\'s history still show it."') && entriesSource.includes('const DELETE_ARCHIVED_NOTE_LABEL = "Delete";') && !/for good|or undone/.test(entriesSource), "the archive delete says what it does and what stays");
	// Leaving a discussion says it is kept, as it is; one on a missing first read is never kept, so its confirm says so.
	const words = await import("../../web-ui/src/memory-v2-copy.js") as any;
	assert(words.discussionKeptSentence?.("Review", true) === "With no first read, your discussion is not kept: it does not come back when you open Review again." && words.discussionKeptSentence?.("Memorize", true) === "With no first read, your discussion is not kept: it does not come back when you open Memorize again.", "a discussion on a missing first read is not promised back");
	assert(words.discussionKeptSentence("Memorize", false) === "Your discussion is kept; it comes back when you open Memorize again, unless your memory or its Memory model changes first." && words.discussionKeptSentence("Review", false) === "Your discussion is kept; it comes back when you open Review again, unless your memory or its Memory model changes first.", "leaving a discussion says it is kept, as it is");
	const appText = read("App.tsx");
	assert((appText.match(/body: discussionKeptSentence\("Review", Boolean\(reviewWorkflow\.assessment\?\.firstReadMissing\)\)/g) ?? []).length === 2 && (appText.match(/body: discussionKeptSentence\("Memorize", Boolean\(absorbWorkflow\.assessment\?\.firstReadMissing\)\)/g) ?? []).length === 2 && !appText.includes("Your discussion is kept;"), "the Leave and Back confirms on both screens say it from the first read they stand on");
}

// 10f. A note the sort placed and the same run then read again into notes is
// shown once, as the row that read it; the sorted block lists the rest.
{
	const copy = await import("../../web-ui/src/memory-v2-copy.js") as any;
	const both = run({
		sorted: [{ id: "m-0101", text: "- Call about the Nordwind contract", topic: "Nordwind contract" }, { id: "m-0102", text: "- Invoices go out on the first.", topic: "Invoicing" }],
		rereads: [{ id: "m-0101", title: "Call about the Nordwind contract", outcome: "folded", attempts: 1, changes: [{ kind: "added", text: "- One point." }] }] as any,
	});
	const rows = typeof copy.absorbRunSortedRows === "function" ? copy.absorbRunSortedRows(both) : null;
	assert(rows && rows.length === 1 && rows[0].id === "m-0102", `the sorted block leaves out a note read again into notes, got ${JSON.stringify(rows)}`);
	// The count is the same while the run works and at its end: a note waiting to be read again is left out from the
	// start, and one whose read kept nothing comes back to the block.
	const waiting = copy.absorbRunSortedRows(run({ sorted: both.sorted, rereads: [{ id: "m-0101", title: "Call about the Nordwind contract", outcome: "pending", attempts: 0 }] as any }));
	assert(waiting.length === 1 && waiting[0].id === "m-0102", `a note waiting to be read again is not counted as sorted, got ${JSON.stringify(waiting)}`);
	const keptNothing = copy.absorbRunSortedRows(run({ sorted: both.sorted, rereads: [{ id: "m-0101", title: "Call about the Nordwind contract", outcome: "folded", attempts: 1, changes: [] }] as any }));
	assert(keptNothing.length === 2, `a note whose read kept nothing stays in the sorted block, got ${JSON.stringify(keptNothing)}`);
	// Its row says it is a note, never an undated conversation.
	const noteRow = copy.absorbRunRows(both, false).find((row: any) => row.session.id === "m-0101");
	assert(noteRow?.note === true && copy.ABSORB_REREAD_ROW_LABEL === "From a note in memory", `the row read from a note says so, got ${JSON.stringify(noteRow)}`);
	assert((await import("node:fs")).readFileSync(new URL("../../web-ui/src/components/absorb-run-screen.tsx", import.meta.url), "utf-8").includes("note ? ABSORB_REREAD_ROW_LABEL : fmtMemoryDay(session.date)"), "the card shows it in the date's place");
	const card = (await import("node:fs")).readFileSync(new URL("../../web-ui/src/components/absorb-run-screen.tsx", import.meta.url), "utf-8");
	assert(card.includes("absorbRunSortedRows(run)") && !/<NoteEditor text=\{row\.topic\}/.test(card), "the card uses the same list, and Move has its own topic box");
}

// 10g. Review's card claims only what code did (the topics it went through);
// the rest is listed as what the Memory model was told.
{
	const review = (await import("node:fs")).readFileSync(new URL("../../web-ui/src/components/review-screen.tsx", import.meta.url), "utf-8");
	const askedAt = review.indexOf("<h3>What you asked for</h3>");
	const asked = review.slice(askedAt, review.indexOf("</section>", askedAt));
	assert(review.includes("<h3>What you told the Memory model</h3>") && asked.includes("guidance.topics") && !/guidance\.(keepAsIs|shorten|remove|answers|instructions)/.test(asked), "Review lists only the code-applied topics as done");
}

// 10b. The saved line counts what was applied: notes, nothing to keep, new topics.
{
	const line = absorbRunSavedSentence({ foldedSessions: ["RC-1", "RC-2", "RC-3", "RC-4"], notedSessions: 3, nothingToKeep: 1, newTopics: 5, remainingSessions: [], archivedEntries: 0 });
	assert(line === "3 conversations became lasting notes. 1 had nothing to keep. 5 new topics.", `got ${line}`);
}

// 11. Entry ids: never a line on the card, never a reason to hold an update back.
{
	const migratingClean = run({ sessions: [session({ summary: { added: 2, updated: 1, superseded: 0, closed: 0 } })], migration: { pending: true, entriesAssigned: 1_240 }, warnings: ["This room's memory was given entry ids before this update; that change is in its history and can be rolled back from it."] });
	assert(absorbRunFastPathBlockers(migratingClean).length === 0, "an otherwise clean update is still applied automatically while the ids are assigned");
}

// 12. One name for applying updates automatically, wherever it is named.
{
	assert(AUTOMATIC_APPLY_SETTING_LABEL === "Memorize without the first read or the card", "the room setting has one label, and it names both things the room goes without");
	// In such a room the chooser promises neither a first read nor a look before the save.
	const automatic = memorizeChooserText(3, true);
	assert(automatic.includes("3 remembered conversations") && automatic.includes("with no first read") && automatic.includes("saved without the card"), `the Memorize card says what Start does there (got: ${automatic})`);
	assert(!/You read what will be kept/.test(automatic) && !/Nothing is saved until you approve/.test(maintainChooserFootnote(true)), "and neither it nor the footnote promises a look before the save");
	assert(memorizeChooserText(1, false) === "Turn the remembered conversation into lasting notes. You read what will be kept before it is saved; whatever does not fit in the budget goes to the archive.", "every other room's card is as it was");
	assert(maintainChooserFootnote(false) === "Nothing is saved until you approve it. The memory budget is set in Room settings.", "and so is its footnote");
	// The chooser has no hint for notes in Unsorted: every Memorize sorts them, and its card says so.
	assert(!("unsortedHintText" in (await import("../../web-ui/src/memory-v2-copy.js"))), "the Unsorted hint's sentence is gone");
	const appSource = (await import("node:fs")).readFileSync(new URL("../../web-ui/src/App.tsx", import.meta.url), "utf-8");
	assert(!appSource.includes("maintain-hint") && !appSource.includes("unsortedAfterReread"), "the Maintain chooser shows no Unsorted hint and no Review button for it");
	assert(AUTOMATIC_APPLY_INFO.startsWith("Start on Memorize goes straight to the update, with no first read; Discuss first still reads the conversations with you."), `the setting's info says the first read is skipped (got: ${AUTOMATIC_APPLY_INFO})`);
	assert(AUTOMATIC_APPLY_INFO.endsWith("A memory update with nothing to weigh is saved as soon as it is ready, instead of being shown to you one last time. Anything you need to weigh always waits for you, for example a note leaving memory or a new note that may disagree with another. You can always see what changed afterwards in History."), `the setting's info says anything to weigh waits, not only three of the reasons the card stays (got: ${AUTOMATIC_APPLY_INFO})`);
	assert(DISCUSS_FIRST_LABEL === "Discuss first", "the way to a first read there keeps the name it has on the first read");
	assert(AUTOMATIC_APPLY_ON_SENTENCE === "This room applies memory updates automatically", "and the sentences build on that same name");
	const sentence = automaticApplyNeedsReviewSentence(["2 entries would move to the archive to stay under budget", "1 session did not finish."]);
	assert(
		sentence === "This room applies memory updates automatically, but this update needs your review because 2 entries would move to the archive to stay under budget; 1 session did not finish.",
		`the note names the setting and every reason, once each (got: ${sentence})`,
	);
	assert(automaticApplyNeedsReviewSentence([]).endsWith("because of the warnings listed above."), "a note with no named reason still points at what is on screen");
}

// 13. An update that added nothing says what it did do instead.
{
	const budgetOnly = absorbRunSavedSentence({ foldedSessions: [], remainingSessions: [], archivedEntries: 34, archivedForBudget: 34 });
	assert(
		budgetOnly === "No conversation was memorized this time. 34 notes moved to the archive to keep memory within its budget.",
		`a run that only made room says so, instead of counting to zero (got: ${budgetOnly})`,
	);
	assert(!budgetOnly.includes("0 conversations"), "and never reads as a failure");
	const one = absorbRunSavedSentence({ foldedSessions: [], remainingSessions: ["RC-0009"], archivedEntries: 1, archivedForBudget: 1 });
	assert(
		one === "No conversation was memorized this time. 1 note moved to the archive to keep memory within its budget. 1 conversation waits for the next Memorize.",
		`one entry reads in the singular, and what stays behind is still stated (got: ${one})`,
	);
	assert(absorbRunSavedSentence({ foldedSessions: [], remainingSessions: [], archivedEntries: 0, archivedForBudget: 0 }) === "0 conversations became lasting notes.", "a run that did nothing at all keeps the plain count");
	assert(
		absorbRunSavedSentence({ foldedSessions: ["RC-0007"], remainingSessions: [], archivedEntries: 3, archivedForBudget: 3 }) === "1 conversation became lasting notes. 3 notes moved to the archive.",
		"a run that did add a session reads as it always did",
	);
}

// 14. The first read of a room already above its budget: what memorizing now does, and the two other ways.
{
	const first = overLimitFirstRead({ reviewTargetTokens: 51_600, budgetTokens: 20_000, entriesOverBudget: 584 });
	assert(first.headline === "Memory is 258% full.", `the headline is the percentage the rest of the product uses (got: ${first.headline})`);
	assert(first.sentence === "Memorizing now moves about 584 of the least recently touched notes to the archive. You can also:", `the sentence says what happens and hands over (got: ${first.sentence})`);
	assert(first.raise?.target === 52_000 && first.raise.label === "Raise the budget to 52k to keep everything that is there now", `the raise is the room's memory rounded up (got: ${JSON.stringify(first.raise)})`);
	assert(first.reviewLabel === REVIEW_FIRST_LABEL && REVIEW_FIRST_LABEL === "Review first", "the other way is a Review");
	const huge = overLimitFirstRead({ reviewTargetTokens: 96_000, budgetTokens: 20_000, entriesOverBudget: 1_200 });
	assert(huge.raise?.target === MEMORY_LIMIT_CEILING_TOKENS && huge.raise.label === "Raise the budget to 80k", `past the ceiling the button sets the ceiling (got: ${JSON.stringify(huge.raise)})`);
	assert(huge.sentence.includes("Even at the 80k ceiling some of them would still move."), `and the sentence says notes would still move (got: ${huge.sentence})`);
	assert(overLimitFirstRead({ reviewTargetTokens: 96_000, budgetTokens: 20_000, entriesOverBudget: 1_200, ceilingTokens: 100_000 }).raise?.target === 96_000, "a ceiling handed in wins over the mirrored one");
	// Already at the ceiling: a raise would change nothing, so none is offered.
	const atCeiling = overLimitFirstRead({ reviewTargetTokens: 96_000, budgetTokens: MEMORY_LIMIT_CEILING_TOKENS, entriesOverBudget: 300 });
	assert(atCeiling.raise === null && atCeiling.sentence === "Memorizing now moves about 300 of the least recently touched notes to the archive. You can also:", `no raise is offered at the ceiling (got: ${JSON.stringify(atCeiling)})`);
	assert(!/least[- ]used/i.test(first.sentence), "the first read never claims least-used either");
}

// 15. House style: no em-dashes anywhere in the copy this module produces.
{
	const bar = archiveLimitSummary({ budget: budget({ after: 20_000 }), demotion: demotion([row({ tokens: 2_000, instead: true }), row({ id: "k", leaving: false, kept: true })]) });
	const sentences = [
		absorbRunProgressLine(run({ state: "folding", progress: { folded: 1, total: 3, current: { id: "RC-0002", title: "Kickoff" } } })),
		absorbRunProgressLine(run({ state: "prepass" })),
		absorbRunSessionLine(session()),
		absorbRunSessionLine(session({ outcome: "failed", reason: "The model took too long to answer." })),
		bar.countsLine,
		bar.raise?.label ?? "",
		archiveLimitSummary({ budget: budget({ after: 78_000, budgetTokens: 78_000 }), demotion: demotion([row({ tokens: 5_000 })]) }).raise?.ceilingSentence ?? "",
		ARCHIVE_EXPLANATION,
		overLimitFirstRead({ reviewTargetTokens: 96_000, budgetTokens: 20_000, entriesOverBudget: 12 }).sentence,
		absorbRunFailedSessionNote(run({ sessions: [session({ outcome: "failed" })] })) ?? "",
		absorbRunSavedSentence({ foldedSessions: ["RC-0007"], remainingSessions: ["RC-0008"], archivedEntries: 2, newTopics: 1 }),
		...absorbRunFastPathBlockers(run({ demotion: demotion([row()]), budget: budget({ after: 21_000, overBudgetAfter: true }) })),
	];
	for (const sentence of sentences) {
		assert(!sentence.includes("—"), `no em-dash in product copy (got: ${sentence})`);
	}
}

// --- Review copy: the card and the saved screen speak in topics and % full ---
{
	const change = (overrides: Partial<ReviewChange>): ReviewChange => ({ id: "m-0031", section: "Deep Memory", topic: "Hiring", kind: "shortened", before: "a", after: "b", ...overrides });
	const changes = [
		change({ kind: "shortened" }),
		change({ id: "m-0032", kind: "shortened" }),
		change({ id: "m-0040", topic: "Payments", kind: "merged", mergedFrom: ["m-0040", "m-0041"] }),
		change({ id: "m-0050", topic: "Office move", kind: "archived", why: "stale" }),
		change({ id: "m-0051", section: "Active Items", topic: "Active Items / Hiring", kind: "closed", why: "done" }),
	];
	const counts = reviewChangeCounts(changes);
	assert(counts.tidied === 3 && counts.leaving === 2 && counts.notes === 5 && counts.topics === 4, `counts tally what happened (got ${JSON.stringify(counts)})`);
	assert(reviewCardHeadline(counts) === "4 topics tidied.", `the headline counts the topics that changed (got: ${reviewCardHeadline(counts)})`);
	const sentence = reviewCardSentence(counts, 90, false);
	assert(sentence === "2 shortened, 1 merged, 1 moved to the archive, 1 closed. Read the changes, keep any note the room should not let go, then save.", `the card sentence (got: ${sentence})`);
	assert(reviewCardSentence(counts, 246, true).includes("above its budget (246% full)"), "above the budget is said in words, not only as a percent");
	const none = reviewChangeCounts([]);
	assert(reviewCardHeadline(none) === "Nothing needed changing." && reviewCardSentence(none, 40, false).startsWith("The notes are already tidy."), "a no-op tidy says so");
	// Nothing changed because the tidy calls failed: the card says it could not finish, never that the notes are tidy.
	// The topics left are named, so the person knows which ones.
	const three = ["Hiring", "Payments", "Office move"];
	const notFinished = "The Memory model could not tidy 3 topics this time (Hiring, Payments, Office move), so they were left as they were. Nothing was lost. Try again; if it repeats, choose another model.";
	const headlineLeft = (reviewCardHeadline as (counts: typeof none, topicsLeft?: string[]) => string)(none, three);
	const sentenceLeft = (reviewCardSentence as (counts: typeof none, percent: number, over: boolean, topicsLeft?: string[]) => string)(none, 40, false, three);
	assert(headlineLeft === "Review could not finish." && sentenceLeft === notFinished, `a tidy whose calls failed says it could not finish (got: ${headlineLeft} / ${sentenceLeft})`);
	assert((reviewCardSentence as any)(none, 40, false, ["Office move"]) === "The Memory model could not tidy Office move this time, so it was left as it was. Nothing was lost. Try again; if it repeats, choose another model.", "one topic left is named, in the singular");
	assert((reviewCardSentence as any)(none, 40, false, ["A", "B", "C", "D", "E"]).includes("could not tidy 5 topics this time (A, B, C and 2 more), so"), "a long list names three and counts the rest");
	// A save that tidied nothing saved only what left for the budget: the saved screen says that, never "could not finish".
	const madeRoomHeadline = (reviewSavedHeadline as any)("Ledgerline", none, three, 53);
	const madeRoomSentence = (reviewSavedSentence as any)(none, 40, false, three, 53);
	assert(madeRoomHeadline === "Ledgerline made room in its memory." && madeRoomSentence === "53 notes moved to the archive to stay within the budget. The Memory model could not tidy 3 topics this time (Hiring, Payments, Office move); they are unchanged. Try again tidies them; if it repeats, choose another model.", `a save that only archived for the budget says so, and what its Try again does (got: ${madeRoomHeadline} / ${madeRoomSentence})`);
	assert((reviewSavedSentence as any)(none, 40, false, [], 53) === "53 notes moved to the archive to stay within the budget.", "with no topic left there is no Try again, and no line for it");
	const copyModule = await import("../../web-ui/src/memory-v2-copy.js") as any;
	assert(copyModule.reviewBudgetOnlyConfirmBody?.(53) === "53 notes move to the archive to stay within the budget. Nothing else changes." && copyModule.reviewBudgetOnlyConfirmBody?.(1) === "1 note moves to the archive to stay within the budget. Nothing else changes.", "Save's confirm for a budget-only save says what it saves");
	const appForConfirm = fs.readFileSync(path.join(process.cwd(), "apps", "web-ui", "src", "App.tsx"), "utf8");
	assert(/body: reviewRun\.changes\.length === 0 && reviewRun\.demotion\.counts\.leaving > 0\s*\? reviewBudgetOnlyConfirmBody\(reviewRun\.demotion\.counts\.leaving\)/.test(appForConfirm), "the confirm uses it when nothing was tidied");
	assert((reviewSavedSentence as any)(none, 40, false, ["Office move"], 1) === "1 note moved to the archive to stay within the budget. The Memory model could not tidy Office move this time; it is unchanged. Try again tidies it; if it repeats, choose another model.", `one note and one topic, in the singular (got: ${(reviewSavedSentence as any)(none, 40, false, ["Office move"], 1)})`);
	// The Try again clause comes only with the Try again button.
	assert((reviewSavedSentence as any)(none, 40, false, three, 53, false) === "53 notes moved to the archive to stay within the budget. The Memory model could not tidy 3 topics this time (Hiring, Payments, Office move); they are unchanged.", `without Try again the budget-only sentence ends at "unchanged." (got: ${(reviewSavedSentence as any)(none, 40, false, three, 53, false)})`);
	assert((reviewSavedSentence as any)(counts, 90, false, ["Office move"], 0, false).endsWith("Memory is 90% full. Office move could not be tidied this time and was left as it was."), `without Try again the partly done sentence ends with the topic left (got: ${(reviewSavedSentence as any)(counts, 90, false, ["Office move"], 0, false)})`);
	// Some topics tidied and some failed: both are said, live and saved.
	assert((reviewCardHeadline as any)(counts, ["Office move"]) === "4 topics tidied." && (reviewCardSentence as any)(counts, 90, false, ["Office move"]).endsWith("then save. Office move could not be tidied this time and was left as it was."), `a partly done tidy says both (got: ${(reviewCardSentence as any)(counts, 90, false, ["Office move"])})`);
	assert((reviewSavedSentence as any)(counts, 90, false, ["Payments", "Office move"]).endsWith("Memory is 90% full. 2 topics could not be tidied this time (Payments, Office move) and were left as they were. Try again; if it repeats, choose another model."), `the saved card says both, and the way on for the topics left (got: ${(reviewSavedSentence as any)(counts, 90, false, ["Payments", "Office move"])})`);
	assert((reviewSavedSentence as any)(counts, 90, false, ["Office move"]).endsWith("Office move could not be tidied this time and was left as it was. Try again; if it repeats, choose another model."), "one topic left on the saved card, in the singular");
	assert(reviewSavedHeadline("Ledgerline", counts) === "Ledgerline tidied its memory." && reviewSavedHeadline("Ledgerline", none) === "Nothing changed in Ledgerline's memory.", "the saved headline names the room");
	assert(reviewSavedSentence(counts, 90, false) === "4 topics: 2 shortened, 1 merged, 1 moved to the archive, 1 closed. Memory is 90% full.", `the saved sentence (got: ${reviewSavedSentence(counts, 90, false)})`);
	assert(reviewTopicName(changes[0]) === "Hiring" && reviewTopicName({ topic: "Active Items", section: "Active Items" }) === "Open items", "a topic is named without its section; the open-items section gets the person's word");
	const group = reviewTopicGroupSummary("Incident history", [change({ kind: "shortened" }), change({ id: "m-0033", kind: "shortened" }), change({ id: "m-0034", kind: "shortened" }), change({ id: "m-0035", kind: "archived", why: "stale" })]);
	assert(group === "Incident history · 3 notes shortened, 1 moved to the archive", `a topic row says what happened in it (got: ${group})`);
	assert(reviewSavedArchiveSentence(3) === "3 notes moved to the archive to stay within the budget." && reviewSavedArchiveSentence(0) === null, "the saved screen says what the budget alone sent away");

	// A topic folded into another: one row, labelled, naming both titles and what moved.
	const folded = change({ id: "m-0060", topic: "Commercial terms", kind: "topic_folded", before: "Contracts", after: "Commercial terms", notesMoved: 3 });
	assert(reviewChangeKindLabel("topic_folded") === "Topic folded", `the fold row's label (got: ${reviewChangeKindLabel("topic_folded")})`);
	assert(reviewTopicFoldedLine(folded) === '"Contracts" folded into "Commercial terms" — 3 notes moved', `the fold row's line (got: ${reviewTopicFoldedLine(folded)})`);
	assert(reviewTopicFoldedLine({ before: "Legal", after: "Contracts", notesMoved: 1 }) === '"Legal" folded into "Contracts" — 1 note moved', "one note moved reads in the singular");
	const foldedCounts = reviewChangeCounts([folded]);
	assert(foldedCounts.topic_folded === 1 && foldedCounts.notes === 1 && foldedCounts.topics === 1 && foldedCounts.tidied === 0 && foldedCounts.leaving === 0, `a fold counts as a topic touched, and nothing tidied or leaving (got ${JSON.stringify(foldedCounts)})`);
	assert(reviewCardSentence(foldedCounts, 80, false) === "1 topic folded. Read the changes, keep any note the room should not let go, then save.", `a tidy that only folded a topic still reads whole (got: ${reviewCardSentence(foldedCounts, 80, false)})`);
	assert(reviewTopicGroupSummary("Commercial terms", [folded]) === "Commercial terms · 1 topic folded", `a fold-only topic row does not call the fold a note (got: ${reviewTopicGroupSummary("Commercial terms", [folded])})`);
	assert(reviewTopicGroupSummary("Commercial terms", [change({ kind: "shortened", topic: "Commercial terms" }), folded]) === "Commercial terms · 1 note shortened, 1 topic folded", `a fold comes last on a mixed row (got: ${reviewTopicGroupSummary("Commercial terms", [change({ kind: "shortened", topic: "Commercial terms" }), folded])})`);
	assert(memoryFullPercent(19_963, 20_000) === 100 && memoryFullPercent(0, 0) === 0, "percent full rounds and survives a missing limit");
	assert(archiveReasonLabel("stale") === "no longer holds" && archiveReasonLabel("duplicate") === "already said elsewhere" && archiveReasonLabel("done") === "finished", "an archived note carries the reason it left, in the room's words");
	assert(archivedDuplicateReason("Commercial terms") === 'already said under "Commercial terms"', `a duplicate the machine paired names the topic that already says it (got: ${archivedDuplicateReason("Commercial terms")})`);
	assert(archivedDuplicateReason("Active Items") === 'already said under "Open items"', `and the open-items section reads by its person-facing name (got: ${archivedDuplicateReason("Active Items")})`);

	const depth = (overBudget: boolean, staleFlagged: boolean, over = -4_000) => reviewDepthSentence({ overBudget, staleFlagged, budgetTokens: 20_000, reviewTargetTokens: 20_000 + over });
	assert(depth(false, false) === "Memory is 80% full and nothing looks stale, so tidying the wording is enough.", `the wording depth (got: ${depth(false, false)})`);
	assert(depth(false, true) === "The first read found stale notes, so moving them to the archive is recommended.", `a stale first read points at the archive (got: ${depth(false, true)})`);
	assert(depth(true, false, 3_000) === "Memory is above its budget, so moving what is finished or stale to the archive is recommended.", `above the budget points at the archive (got: ${depth(true, false, 3_000)})`);
	const disagreeing = (count: number, overBudget = false, staleFlagged = false) => reviewDepthSentence({ overBudget, staleFlagged, disagreeing: count, budgetTokens: 20_000, reviewTargetTokens: overBudget ? 23_000 : 16_000 });
	assert(disagreeing(1) === "Two notes disagree. Either tidy can merge them into one note, and the text it replaces is kept in the archive.", `one disagreeing pair says how either tidy settles it (got: ${disagreeing(1)})`);
	assert(disagreeing(2) === "Some notes disagree. Either tidy can merge each pair into one note, and the texts it replaces are kept in the archive.", `several pairs read in the plural (got: ${disagreeing(2)})`);
	assert(disagreeing(0) === depth(false, false) && disagreeing(1, true) === depth(true, false, 3_000) && disagreeing(1, false, true) === depth(false, true), "with none, or over the budget, or with stale notes, the sentence is as it was");
	// With no first read nothing was read, so the sentence says nothing of what a read would have found.
	const missingDepth = reviewDepthSentence({ overBudget: false, staleFlagged: false, firstReadMissing: true, budgetTokens: 20_000, reviewTargetTokens: 16_000 } as Parameters<typeof reviewDepthSentence>[0]);
	assert(missingDepth === "Memory is 80% full, so tidying the wording is enough.", `with no first read the depth sentence claims nothing about stale notes (got: ${missingDepth})`);
	const lookAlike = reviewDepthSentence({ overBudget: false, staleFlagged: false, lookAlike: true, disagreeing: 1, budgetTokens: 20_000, reviewTargetTokens: 16_000 });
	assert(lookAlike === "Some topics look the same, and only the second option can join them, so it is recommended.", `topics that look the same say why the second option is recommended, before any disagreement (got: ${lookAlike})`);
	// The sentence never contradicts the recommendation: "tidying the wording is enough" only where the server recommends the wording tidy.
	for (const overBudget of [false, true]) for (const staleFlagged of [false, true]) for (const lookAlikeTopics of [false, true]) for (const count of [0, 1, 2]) {
		const sentence = reviewDepthSentence({ overBudget, staleFlagged, lookAlike: lookAlikeTopics, disagreeing: count, budgetTokens: 20_000, reviewTargetTokens: overBudget ? 23_000 : 16_000 });
		const recommended = recommendedReviewDepth({ overBudget, staleOrContradicts: staleFlagged ? ["a stale note"] : [], lookAlikeTopics });
		assert(!sentence.includes("tidying the wording is enough") || recommended === "wording", `the depth sentence never says the wording is enough when the second option is recommended (${JSON.stringify({ overBudget, staleFlagged, lookAlikeTopics, count, recommended })}, got: ${sentence})`);
	}
	assert(REVIEW_DEPTH_ROWS.wording.text === "Make the notes shorter and clearer, and merge notes that repeat or disagree.", `the wording row says what it does, merges included (got: ${REVIEW_DEPTH_ROWS.wording.text})`);
	assert(REVIEW_DEPTH_ORDER.length === 2 && REVIEW_DEPTH_ROWS.wording.title === "Tidy the wording" && REVIEW_DEPTH_ROWS.tidy.text.includes("brought back"), "two depths, each saying what leaves memory");

	const tidy = (overrides: Partial<ReviewRun> = {}): ReviewRun => ({
		runId: "review-run-1",
		agentId: "room-1",
		state: "ready",
		depth: "tidy",
		startedAt: "2026-09-14T09:00:00.000Z",
		updatedAt: "2026-09-14T09:04:00.000Z",
		progress: { group: 3, groups: 5, label: "Commercial terms" },
		topics: ["Hiring", "Payments"],
		changes,
		leftAsIs: [],
		budget: budget({ after: 17_500 }),
		demotion: demotion([]),
		candidate: { sourceFingerprint: { algorithm: "sha256", value: "abc" }, estimatedTokens: 17_500 },
		guidance: null,
		migration: null,
		warnings: [],
		...overrides,
	});
	assert(reviewRunIsWorking("tidying") && reviewRunIsWorking("prepass") && !reviewRunIsWorking("ready"), "the three working states share one screen");
	assert(reviewRunProgressLine(tidy({ state: "tidying" })) === "Tidying part 4 of 5 · Commercial terms", `the working line names the topic in hand (got: ${reviewRunProgressLine(tidy({ state: "tidying" }))})`);
	assert(reviewRunFullPercent(tidy()) === 88, `the card's percent full (got: ${reviewRunFullPercent(tidy())})`);
	assert(reviewRunArchiveCount(tidy()) === 0 && reviewRunArchiveCount(tidy({ demotion: demotion([row(), row({ id: "m-2", leaving: false, kept: true })]) })) === 1, "the archive count is the server's leaving count; a kept note stops counting");
	// The same bar serves the Review card, from the same fields.
	const reviewBar = archiveLimitSummary({ budget: tidy().budget, demotion: demotion([row({ tokens: 4_000 })]) });
	assert(reviewBar.raise?.target === 22_000 && reviewBar.raise.label === "Raise the budget to 22k to keep them all", `the Review card's raise offer (got: ${JSON.stringify(reviewBar.raise)})`);
	assert(archiveLimitSummary({ budget: tidy().budget, demotion: demotion([]) }).fitsSentence === "Everything fits. Memory is 88% full after saving.", "a tidy with nothing leaving says everything fits");

	// The gate: anything a person would want to weigh keeps the tidy on the card.
	// A tidy that only reworded, moved or pinned notes is clean; one that sent a
	// note to the archive, merged notes, closed an item or folded a topic is
	// not, whatever the budget says.
	const wordingOnly = (overrides: Partial<ReviewRun> = {}): ReviewRun => tidy({ changes: [change({ kind: "shortened" }), change({ id: "m-0032", kind: "moved", before: "Payments", after: "Hiring" }), change({ id: "m-0033", kind: "pinned" })], ...overrides });
	assert(reviewRunFastPathBlockers(wordingOnly()).length === 0, "a clean tidy needs no second look");
	assert(reviewRunFastPathBlockers(wordingOnly({ demotion: demotion([row()], { overageTokens: 300 }) }))[0] === "1 note would move to the archive to stay within the budget", "a note leaving for the budget blocks");
	assert(reviewRunFastPathBlockers(wordingOnly({ budget: budget({ after: 21_000, overBudgetAfter: true }) })).includes("saving would leave memory above its budget"), "crossing the budget blocks");
	assert(reviewRunFastPathBlockers(wordingOnly({ leftAsIs: [{ topics: ["Hiring", "Payments"], reason: "The room's answer for these was cut off." }] })).length === 0, "a topic the tidy left as it was never stops the automatic save");
	const reviewStop = { kind: "outage", model: { provider: "openai-compatible", model: "gpt-5.5" }, cause: "not-answering" } as const;
	assert(reviewRunFastPathBlockers(wordingOnly({ stop: reviewStop, leftAsIs: [{ topics: ["Hiring"], reason: "The Memory model could not be reached, so these notes were not tidied." }] })).join("|") === "the Memory model stopped before it finished", "a stopped tidy waits for a person, with its paused notice");
	assert(reviewRunFastPathBlockers(wordingOnly({ stop: { ...reviewStop, kind: "restart", cause: "restarted" } })).join("|") === "the app restarted before it finished", "a restarted tidy waits for a person");
	const leftLine = (await import("../../web-ui/src/memory-v2-copy.js") as any).reviewLeftAsIsSentence;
	assert(leftLine?.(["Hiring"]) === "Hiring could not be tidied this time and was left as it was." && leftLine?.(["Hiring", "Payments"]) === "2 topics could not be tidied this time (Hiring, Payments) and were left as they were.", "the card's one line for topics left as they were");
	// Every tidy failed: nothing to save. The card offers Try again for the topics left and Close, never Save, and automatic maintenance does not save it.
	{
		const copy = await import("../../web-ui/src/memory-v2-copy.js") as any;
		const failedAll = tidy({ changes: [], leftAsIs: [{ topics: ["Hiring", "Payments", "Office move"], reason: "The model could not tidy these notes this time." }] });
		assert(copy.reviewRunNothingToSave?.(failedAll) === true, "a tidy that tidied nothing has nothing to save");
		assert(copy.reviewRunNothingToSave?.(tidy({ leftAsIs: failedAll.leftAsIs })) === false && copy.reviewRunNothingToSave?.(tidy({ changes: [] })) === false, "a partly done tidy, or one that found nothing to change, is saved as before");
		const budgetOnly = tidy({ changes: [], leftAsIs: failedAll.leftAsIs, demotion: demotion([row()], { overageTokens: 300 }) });
		assert(copy.reviewRunNothingToSave?.(budgetOnly) === false, "a note leaving for the budget is still something to save");
		// A budget raised (or lowered) on the card is something to save, as on Memorize's card: Save stays, so Close never drops it.
		const raisedOnly = tidy({ changes: [], leftAsIs: failedAll.leftAsIs, budget: budget({ budgetTokens: 30_000, savedBudgetTokens: 20_000 }) });
		assert(copy.reviewRunNothingToSave?.(raisedOnly) === false, "a raised budget is something to save");
		const app = fs.readFileSync(path.join(process.cwd(), "apps", "web-ui", "src", "App.tsx"), "utf8");
		const fastPath = app.slice(app.indexOf("async function maybeFastPathReviewRun"), app.indexOf("async function withReviewRunRequest"));
		assert(/if \(!fastPathOn \|\| reviewRunNothingToSave\(reviewRun\)\) return false;/.test(fastPath), "automatic maintenance shows a tidy that tidied nothing, and never saves it");
		const pageRequire = (await import("node:module")).createRequire(new URL("../../web-ui/package.json", import.meta.url));
		const { createElement } = pageRequire("react");
		(globalThis as any).React = pageRequire("react");
		const { renderToStaticMarkup } = pageRequire("react-dom/server");
		const screen: any = await import(new URL("../../web-ui/src/components/review-screen.tsx", import.meta.url).href);
		const noop = () => {};
		const card = (run: ReviewRun) => renderToStaticMarkup(createElement(screen.ReviewCard, { run, roomName: "Supplier Desk", keepIds: [], busy: false, error: null, onToggleKeep: noop, onToggleKeepTopic: noop, onRaiseBudget: noop, onCancel: noop, onBack: noop, backLabel: "Back", onSave: noop, onClose: noop, onTryAgain: noop, onChooseModel: noop, onSignIn: noop })) as string;
		const buttons = (html: string) => [...html.matchAll(/<button[^>]*>([^<]*)<\/button>/g)].map((match) => match[1]);
		const rowButtons = (html: string) => buttons(html.slice(html.lastIndexOf("checkpoint-preview-actions")));
		// A missing first read read nothing: it lists only what the app found on its own, with no "None" under the model's headings.
		const readSections = (missing: boolean) => renderToStaticMarkup(createElement(screen.ReviewFirstReadSections, { fields: { couldBeShorter: [], staleOrContradicts: [], needsYourCall: [], topics: [], saysTheSameTwice: ["Alpha and Gamma both say: the report goes out on Mondays."] }, missing })) as string;
		assert(!readSections(true).includes("<p>None</p>") && !readSections(true).includes("Could be shorter") && !readSections(true).includes("Looks stale") && readSections(true).includes("Says the same twice"), `a missing first read shows no "None" sections (got: ${readSections(true)})`);
		assert(readSections(false).includes("Could be shorter") && readSections(false).includes("<p>None</p>"), "a real read still says when it found nothing");
		const reviewShellSource = fs.readFileSync(path.join(process.cwd(), "apps", "web-ui", "src", "App.tsx"), "utf8");
		assert(reviewShellSource.includes("<ReviewFirstReadSections fields={assessment.fields} missing={Boolean(assessment.firstReadMissing)} />") && reviewShellSource.includes("firstReadMissing={Boolean(assessment.firstReadMissing)}"), "the first read screen tells both parts when the read is missing");
		const failedHtml = card(failedAll);
		assert(failedHtml.includes("<h2>Review could not finish.</h2>") && failedHtml.includes(notFinished) && !failedHtml.includes("already tidy") && !failedHtml.includes("Nothing in these notes needed changing.") && !failedHtml.includes("<h3>Changes</h3>"), `the card says the tidy could not finish, and lists no empty changes (got: ${failedHtml.slice(0, 600)})`);
		assert(buttons(failedHtml).join("|") === "Close|Choose another model|Try again", `the card offers Close, Choose another model and Try again, never Save (got: ${buttons(failedHtml).join("|")})`);
		// Every tidy failed but a note still leaves for the budget: Save is offered, and the card says what it saves.
		const budgetHtml = card(budgetOnly);
		assert(budgetHtml.includes("The Memory model could not tidy 3 topics this time (Hiring, Payments, Office move), so they were left as they were. Saving moves 1 note to the archive to stay within the budget; nothing else changes.") && !budgetHtml.includes("Try again;") && rowButtons(budgetHtml).slice(0, 3).join("|") === "Cancel|Back|Try again" && rowButtons(budgetHtml)[3]?.startsWith("Save"), `the card says what Save saves, and offers Try again for the topics left (got: ${budgetHtml.slice(0, 700)})`);
		const partHtml = card(tidy({ leftAsIs: [{ topics: ["Office move"], reason: "The model could not tidy these notes this time." }] }));
		assert(partHtml.includes("Office move could not be tidied this time and was left as it was.") && (partHtml.match(/could not be tidied/g) ?? []).length === 1, "a partly done tidy says both once");
		assert(rowButtons(partHtml).join("|") === "Cancel|Back|Try again|Save to memory", `a partly done tidy offers Try again for the topics left before Save (got: ${rowButtons(partHtml).join("|")})`);
		// Stopped by an unreachable model before anything was tidied: the same layout as every tidy failed, the sentence and then one row.
		const stoppedHtml = card(tidy({ changes: [], leftAsIs: [{ topics: ["Hiring"], reason: "The Memory model could not be reached, so these notes were not tidied." }], stop: { kind: "outage", model: { provider: "openai-compatible", model: "gpt-5.5" }, cause: "not-answering" } }));
		// The sentence under the headline is announced, as the notice box it replaced was.
		assert(stoppedHtml.includes("<h2>Review paused.</h2>") && !stoppedHtml.includes(notFinished) && stoppedHtml.includes('<p role="status">GPT-5.5 isn&#x27;t answering right now. Nothing was lost.</p>') && !stoppedHtml.includes("What was tidied can be saved"), `a stop with nothing tidied says nothing was lost, announced (got: ${stoppedHtml.slice(0, 900)})`);
		assert(buttons(stoppedHtml).join("|") === "Close|Choose another model|Try again", `one row: Close, Choose another model, Try again (got: ${buttons(stoppedHtml).join("|")})`);
		assert(!stoppedHtml.includes("absorb-run-stop-note") && !failedHtml.includes("absorb-run-stop-note") && /<h2>Review paused\.<\/h2><p role="status">GPT-5\.5 isn&#x27;t answering right now\./.test(stoppedHtml), `the paused card puts its sentence where the failed card puts its own, with no notice box (got: ${stoppedHtml.slice(0, 500)})`);
		// Under the "Review paused." headline the line is the cause alone, as the first read's notice says it.
		assert(!stoppedHtml.includes("Review paused because") && !stoppedHtml.includes("Review paused:"), `no "Review paused" twice (got: ${stoppedHtml.slice(0, 500)})`);
		const failingHtml = card(tidy({ changes: [], leftAsIs: [{ topics: ["Hiring"], reason: "The model could not tidy these notes this time." }], stop: { kind: "failing", model: { provider: "openai-compatible", model: "gpt-5.5" }, cause: "repeated" } as any }));
		assert(failingHtml.includes('<p role="status">The Memory model failed the same way twice, so Review stopped. Nothing was lost. Choose another model, or try again later.</p>') && buttons(failingHtml).join("|") === "Close|Choose another model|Try again", `the same failure twice says so, announced, with the ways on (got: ${failingHtml.slice(0, 600)})`);
		assert(/rs-btn rs-btn-primary"[^>]*>Choose another model</.test(failingHtml) && !/rs-btn rs-btn-primary"[^>]*>Try again</.test(failingHtml), `the same failure twice: Choose another model leads, Try again is a plain button (got: ${failingHtml.slice(failingHtml.lastIndexOf("checkpoint-preview-actions"))})`);
		assert(failingHtml.includes("<h2>Review could not finish.</h2>"), `a run the same failure stopped is not paused (got: ${failingHtml.slice(0, 300)})`);
		const restartedHtml = card(tidy({ changes: [], leftAsIs: [{ topics: ["Hiring"], reason: "The app restarted before these notes were tidied." }], stop: { kind: "restart", model: { provider: "openai-compatible", model: "gpt-5.5" }, cause: "restarted" } }));
		assert(restartedHtml.includes("<h2>Review paused.</h2>") && restartedHtml.includes('<p role="status">The app restarted. Nothing was lost.</p>') && buttons(restartedHtml).join("|") === "Close|Continue", `a restart with nothing tidied: its sentence, then Close and Continue (got: ${buttons(restartedHtml).join("|")})`);
		// Stopped before anything was tidied, with notes still leaving for the budget: Save is offered, so the card says what it saves.
		for (const stop of [{ kind: "outage", model: { provider: "openai-compatible", model: "gpt-5.5" }, cause: "not-answering" }, { kind: "failing", model: { provider: "openai-compatible", model: "gpt-5.5" }, cause: "repeated" }] as const) {
			const leavingHtml = card(tidy({ changes: [], leftAsIs: [{ topics: ["Hiring"], reason: "The Memory model could not be reached, so these notes were not tidied." }], demotion: demotion([row(), row({ id: "m-2" })], { overageTokens: 300 }), stop: stop as any }));
			assert(/<\/h2><p>Saving moves 2 notes to the archive to stay within the budget; nothing else changes\.<\/p>/.test(leavingHtml) && rowButtons(leavingHtml).some((label) => label.startsWith("Save")), `${stop.kind}: a stopped card with notes leaving says what Save saves (got: ${leavingHtml.slice(0, 900)})`);
			// Its notice sits under the "Review paused." headline too, so it says the cause alone.
			if (stop.kind === "outage") assert(leavingHtml.includes("<h2>Review paused.</h2>") && leavingHtml.includes("<p>GPT-5.5 isn&#x27;t answering right now. Nothing was lost.</p>") && !leavingHtml.includes("Review paused because"), `outage: the notice under "Review paused." is the cause alone (got: ${leavingHtml.slice(0, 900)})`);
		}
		// No Try again where it is sure to fail: the way that works comes first. A spent quota is sure to fail while its way on or its plan's reset is unknown.
		const unknownReset = { kind: "sign-in", provider: "ChatGPT" } as const;
		for (const [cause, extra] of [["quota", { quotaWay: unknownReset }], ["not-offered", {}], ["not-on-account", {}], ["region-or-plan", {}]] as const) {
			const sure = card(tidy({ changes: [], leftAsIs: [{ topics: ["Hiring"], reason: "The Memory model could not be reached, so these notes were not tidied." }], stop: { kind: "outage", model: { provider: "openai-compatible", model: "gpt-5.5" }, cause, ...extra } }));
			assert(rowButtons(sure).join("|") === "Close|Choose another model", `${cause}: no Try again on the paused card (got: ${rowButtons(sure).join("|")})`);
			// With no Try again and no sign-in way, another model is the way on, so it leads.
			assert(/rs-btn rs-btn-primary"[^>]*>Choose another model</.test(sure), `${cause}: Choose another model is the main button (got: ${sure.slice(sure.lastIndexOf("checkpoint-preview-actions"))})`);
			const part = card(tidy({ leftAsIs: [{ topics: ["Hiring"], reason: "The Memory model could not be reached, so these notes were not tidied." }], stop: { kind: "outage", model: { provider: "openai-compatible", model: "gpt-5.5" }, cause, ...extra } }));
			assert(!buttons(part).includes("Try again") && buttons(part).includes("Choose another model"), `${cause}: no Try again in a partly done card's notice (got: ${buttons(part).join("|")})`);
		}
		// The first reads' notice follows the same rule.
		const notice: any = await import(new URL("../../web-ui/src/components/model-notice.tsx", import.meta.url).href);
		const noticeHtml = renderToStaticMarkup(createElement(notice.ModelNoticePanel, { notice: { detail: "not-on-account", sentence: "GPT-5.5 isn't available on your ChatGPT account. Nothing was lost." }, onTryAgain: noop, onChooseModel: noop })) as string;
		assert(notice.retryCanHelp("not-on-account") === false && !buttons(noticeHtml).includes("Try again") && buttons(noticeHtml).includes("Choose another model"), `not on the account: no Try again on the notice either (got: ${buttons(noticeHtml).join("|")})`);
		const signedOutHtml = card(tidy({ changes: [], leftAsIs: [{ topics: ["Hiring"], reason: "The Memory model could not be reached, so these notes were not tidied." }], stop: { kind: "outage", model: { provider: "openai-compatible", model: "gpt-5.5" }, cause: "signed-out" } }));
		assert(buttons(signedOutHtml).length === 3 && buttons(signedOutHtml)[0] === "Close" && buttons(signedOutHtml)[2] === "Choose another model" && !buttons(signedOutHtml).includes("Try again") && /rs-btn rs-btn-primary"[^>]*>[^<]+<\/button><button[^>]*>Choose another model/.test(signedOutHtml), `signed out: the sign-in way first and primary, then Choose another model, no Try again (got: ${buttons(signedOutHtml).join("|")})`);
		assert(signedOutHtml.includes('<h2>Review paused.</h2><p role="status">GPT-5.5&#x27;s provider is signed out. Nothing was lost.</p>'), `signed out under the paused headline: the provider's state alone (got: ${signedOutHtml.slice(0, 700)})`);
		assert(!/rs-btn rs-btn-primary"[^>]*>Choose another model</.test(signedOutHtml), `signed out: the sign-in way stays the one main button (got: ${signedOutHtml.slice(signedOutHtml.lastIndexOf("checkpoint-preview-actions"))})`);
		const partStoppedHtml = card(tidy({ leftAsIs: [{ topics: ["Hiring"], reason: "The Memory model could not be reached, so these notes were not tidied." }], stop: { kind: "outage", model: { provider: "openai-compatible", model: "gpt-5.5" }, cause: "not-answering" } }));
		assert(partStoppedHtml.includes("Review paused because GPT-5.5 isn&#x27;t answering right now. What was tidied can be saved; the rest is unchanged."), `a stop after some tidying names the model alone, as the first read's notice does (got: ${partStoppedHtml.slice(0, 900)})`);
		assert(buttons(partStoppedHtml).filter((label) => label === "Try again").length === 1, `a stop after some tidying keeps one Try again, in its notice (got: ${buttons(partStoppedHtml).join("|")})`);
		// One Try again rule for the notice and both cards: a spent quota someone can lift, or a plan whose reset is ahead or has passed, keeps it;
		// a gateway refusing the request offers its key first, with no Try again until a way is taken.
		const leftOne = [{ topics: ["Hiring"], reason: "The Memory model could not be reached, so these notes were not tidied." }];
		const passedReset = { kind: "sign-in", provider: "ChatGPT", resetsAt: new Date(Date.now() - 5 * 60_000).toISOString() } as const;
		const resetAhead = { kind: "sign-in", provider: "ChatGPT", resetsAt: new Date(Date.now() + 42 * 60_000).toISOString() } as const;
		const keyQuota = { kind: "key", provider: "OpenAI" } as const;
		for (const [label, quotaWay] of [["a plan whose reset has passed", passedReset], ["a plan that resets later", resetAhead], ["a key's spent credit", keyQuota]] as const) {
			const canWork = rowButtons(card(tidy({ changes: [], leftAsIs: leftOne, stop: { kind: "outage", model: { provider: "openai-compatible", model: "gpt-5.5" }, cause: "quota", quotaWay } })));
			assert(canWork.join("|") === "Close|Choose another model|Try again", `${label}: Try again on the paused card (got: ${canWork.join("|")})`);
		}
		const gatewayRefusedRow = rowButtons(card(tidy({ changes: [], leftAsIs: leftOne, stop: { kind: "outage", model: { provider: "openai-compatible", model: "gpt-5.5" }, cause: "gateway-refused", key: "refused", gateway: "Test Gateway" } })));
		assert(gatewayRefusedRow.join("|") === "Close|Replace key|Choose another model", `a gateway refusing the request: Replace key first, no Try again (got: ${gatewayRefusedRow.join("|")})`);
		const rule = notice.retryCanHelp as (cause: string, quotaWay?: unknown) => boolean;
		assert(!rule("quota") && !rule("quota", unknownReset) && rule("quota", passedReset) && rule("quota", resetAhead) && rule("quota", keyQuota) && !rule("region-or-plan") && !rule("gateway-refused") && !rule("not-on-account") && !rule("signed-out") && !rule("not-offered") && !rule("too-small") && rule("not-answering") && rule("repeated"), "the notice's Try again rule is the cards' rule");
		const passedNotice = renderToStaticMarkup(createElement(notice.ModelNoticePanel, { notice: { detail: "quota", sentence: "GPT-5.5 has reached your plan's usage limit. Nothing was lost.", quotaWay: passedReset, modelName: "GPT-5.5" }, onTryAgain: noop, onChooseModel: noop })) as string;
		assert(buttons(passedNotice).join("|") === "Try again|Choose another model", `a passed reset: Try again on the notice (got: ${buttons(passedNotice).join("|")})`);
		const gatewayNotice = renderToStaticMarkup(createElement(notice.ModelNoticePanel, { notice: { detail: "gateway-refused", sentence: "Test Model refused this request. Nothing was lost.", provider: "test-gateway", key: "refused" }, onTryAgain: noop, onChooseModel: noop, onSignIn: noop })) as string;
		assert(buttons(gatewayNotice).join("|") === "Replace key|Choose another model", `a gateway refusing the request: Replace key on the notice, no Try again (got: ${buttons(gatewayNotice).join("|")})`);
		// A paused card never shows a provider's raw id: the model is named alone, whether or not the room's Memory model
		// lends its label, and a gateway by the name AI setup gives it.
		const memorizeScreen: any = await import(new URL("../../web-ui/src/components/absorb-run-screen.tsx", import.meta.url).href);
		const onGateway = { provider: "test-gateway", model: "test-model" };
		const memorizeCard = (stop: unknown, memoryModel: unknown) => renderToStaticMarkup(createElement(memorizeScreen.AbsorbRunCard, { run: run({ progress: { folded: 1, total: 2 }, sessions: [session(), session({ id: "RC-0002", outcome: "pending" as any, summary: undefined })], stop: stop as any }), roomName: "Supplier Desk", memoryModel, keepIds: [], busy: false, error: null, onToggleKeep: noop, onToggleKeepTopic: noop, onRaiseBudget: noop, onApprove: noop, onCancel: noop, onBackToAssessment: noop, onResume: noop, onChooseModel: noop, onSignIn: noop })) as string;
		for (const cause of ["quota", "not-answering", "busy", "signed-out", "gateway-refused", "region-or-plan", "not-offered", "not-on-account"] as const) {
			const stop = { kind: "outage", model: onGateway, cause, ...(cause === "quota" ? { quotaWay: { kind: "gateway", provider: "Test Gateway" } } : {}), ...(cause === "signed-out" || cause === "gateway-refused" ? { key: "refused" } : {}), gateway: "Test Gateway" } as any;
			const reviewHtml = card(tidy({ leftAsIs: leftOne, stop }));
			assert(!reviewHtml.includes("test-gateway") && (reviewHtml.includes("Review paused because Test Model ") || reviewHtml.includes("Review paused: Test Gateway ")), `${cause}: Review's paused card shows no raw provider id (got: ${reviewHtml.slice(0, 900)})`);
			for (const memoryModel of [{ ...onGateway, label: "Test Model" }, { provider: "test-gateway", model: "other-model", label: "Other Model" }, null]) {
				const memorizeHtml = memorizeCard(stop, memoryModel);
				assert(!memorizeHtml.includes("test-gateway") && (memorizeHtml.includes("Memorize paused because Test Model ") || memorizeHtml.includes("Memorize paused: Test Gateway ")), `${cause}: Memorize's paused card shows no raw provider id, with ${memoryModel ? memoryModel.model : "no Memory model"} chosen (got: ${memorizeHtml.slice(0, 900)})`);
			}
		}
		const quotaOnGateway = memorizeCard({ kind: "outage", model: onGateway, cause: "quota", quotaWay: { kind: "gateway", provider: "Test Gateway" }, gateway: "Test Gateway" }, null);
		assert(quotaOnGateway.includes("Memorize paused because Test Model has reached its usage limit or run out of credit. 1 conversation is still waiting. Ask whoever runs Test Gateway about the limit."), `a spent gateway quota on Memorize's card names the model alone and the gateway by its name (got: ${quotaOnGateway.slice(0, 900)})`);
		// Memorize's paused card follows the same Try again rule.
		const memorizePassed = memorizeCard({ kind: "outage", model: onGateway, cause: "quota", quotaWay: passedReset }, null);
		const memorizeUnknown = memorizeCard({ kind: "outage", model: onGateway, cause: "quota", quotaWay: unknownReset }, null);
		const memorizeRefused = memorizeCard({ kind: "outage", model: onGateway, cause: "gateway-refused", key: "refused", gateway: "Test Gateway" }, null);
		assert(buttons(memorizePassed).includes("Try again") && !buttons(memorizeUnknown).includes("Try again") && buttons(memorizeRefused).includes("Replace key") && !buttons(memorizeRefused).includes("Try again"), `Memorize's paused card: Try again for a passed reset, none for an unknown one or a gateway's refusal, whose key comes first (got: ${[memorizePassed, memorizeUnknown, memorizeRefused].map((html) => buttons(html).join("|")).join(" / ")})`);
		// The page around the card: no step line over a card that could not finish, and no first-read heading over a lone notice.
		const appSource = fs.readFileSync(path.join(process.cwd(), "apps", "web-ui", "src", "App.tsx"), "utf8");
		const reviewShell = appSource.slice(appSource.indexOf("function ReviewWorkflowShell"), appSource.indexOf("function AbsorbWorkflowShell"));
		assert(/state\.step === "run_card" && run && reviewRunNothingToSave\(run\) \? null/.test(reviewShell) && reviewShell.includes("{stepLine && <p>{stepLine}</p>}"), "the could-not-finish card has no step line above it");
		assert(/\{!unreachableRead && \(\s*<div className="checkpoint-input-heading checkpoint-proposal-heading">\s*<h2>What \{targetLabel\}'s notes need<\/h2>/.test(reviewShell), "the first read's heading goes when the page holds only the notice");
		// Reopening Maintain on a room whose Review is still working (a reload) reopens that run, as Memorize's does; a card left ready waits behind the chooser.
		const chooserOpen = appSource.slice(appSource.indexOf("function openMaintainChooser"), appSource.indexOf("function closeMaintainChooser"));
		assert(/fetchReviewStatus\(target\.agentId\)\.then\(async \(status\) => \{\s*if \(!status\.waitingRunId \|\| opened !== maintainRunRef\.current\) return;\s*const waiting = await fetchReviewRun\(target\.agentId, status\.waitingRunId\);\s*if \(reviewRunIsWorking\(waiting\.state\) && opened === maintainRunRef\.current\) void startPruneMemoryWorkflow\(target\);/.test(chooserOpen), "a reload during a tidy reopens the working Review run, and a ready card left behind waits behind the chooser");
		// Review's error screen says once that memory is unchanged: never "No memory was changed." beside the error's own "No memory was updated."
		const reviewErrorScreen = reviewShell.slice(reviewShell.indexOf("<h2>Review could not start</h2>"), reviewShell.indexOf("Start Maintain again"));
		assert(reviewErrorScreen.includes('{!/No memory was (?:updated|changed)/.test(state.error ?? "") && <p>No memory was changed. You can open Maintain again right away.</p>}'), "Review's error screen says memory is unchanged only once");
		// A first read that failed while the model answers: Read again asks again, and another model is one click away.
		assert(reviewShell.includes('{assessment.firstReadMissing && !unreachableRead && <button className="rs-btn" onClick={onChooseModel}>{ABSORB_CHOOSE_MODEL_LABEL}</button>}') && reviewShell.includes('title={assessment.firstReadMissing ? "Read the notes again. Nothing is saved." : "Read the notes again, asking the room to fix what this read got wrong. Nothing is saved."}'), "a missing Review read offers Read again and Choose another model");
		// Save on a tidy another window is working on says so; on one another window stopped, it is not "still here".
		const approvalWords = appSource.slice(appSource.indexOf("function formatReviewApprovalError"), appSource.indexOf("function CheckpointPreviewShell"));
		assert(approvalWords.includes('if (code === "review_run_not_ready") return "This tidy is being worked on in another window, so nothing was saved here. Finish it there, or reload this page to follow it here.";'), "Save on a tidy another window is working on says so, and how to follow it here");
		assert(approvalWords.includes('if (code === "review_run_unknown") return "This tidy is no longer open, so nothing was saved. Start Review again to read the notes as they are now.";') && (appSource.match(/formatReviewApprovalError\(\(e as Error\)\.message, apiErrorCode\(e\)\)/g) ?? []).length === 2, "Save on a stopped tidy says it is no longer open");
		// A missing first read still offers Discuss first, as Memorize's does; only an unreachable model hides it.
		assert(/\{!unreachableRead && <button className=\{`rs-btn\$\{assessment\.fields\.needsYourCall\.length > 0 \? " rs-btn-primary" : ""\}`\} onClick=\{onDiscuss\}/.test(reviewShell), "Review's missing read offers Discuss first");
		// Review's discussion names what it feeds: the tidy, not Memorize's update.
		const discussionAside = appSource.slice(appSource.indexOf("function MaintenanceDiscussion"), appSource.indexOf("function MaintenanceDiscussion") + 9000);
		assert(discussionAside.includes("What you agree here goes into the {outcome}, not into this list.") && /aside=\{<ReviewFirstReadSections fields=\{assessment\.fields\} compact missing=\{Boolean\(assessment\.firstReadMissing\)\} \/>\}\s*outcome="tidy"/.test(reviewShell), "Review's discussion says what you agree goes into the tidy");
		assert(!appSource.includes("runReviewTidyAgain") && /onTryAgain=\{onResumeRun\}/.test(reviewShell), "Try again on the card resumes the same run; nothing starts Review over");
		// The saved screen after a save that tidied nothing: Try again starts a Review of only the topics left, at the run's depth.
		const savedScreen = (counts: ReturnType<typeof reviewChangeCounts>, topicsLeft: string[], done = false, stop?: unknown) => renderToStaticMarkup(createElement(screen.ReviewSavedScreen, { roomName: "Supplier Desk", counts, topicsLeft, percent: 40, over: false, archivedEntries: 1, archivedForBudget: 1, warnings: [], undo: { busy: false, done, error: null }, onUndo: noop, onTryAgain: noop, onChooseModel: noop, onReturn: noop, returnLabel: "Done", ...(stop ? { stop } : {}) })) as string;
		const savedLeft = savedScreen(none, ["Office move"]);
		assert(savedLeft.includes("<h2>Supplier Desk made room in its memory.</h2>") && savedLeft.includes("1 note moved to the archive to stay within the budget. The Memory model could not tidy Office move this time; it is unchanged. Try again tidies it; if it repeats, choose another model.") && (savedLeft.match(/moved to the archive to stay within the budget/g) ?? []).length === 1 && !savedLeft.includes("could not finish"), `the saved screen after a budget-only save says what it saved, once, and what Try again does (got: ${savedLeft.slice(0, 700)})`);
		assert(rowButtons(savedLeft).join("|") === "Undo|Done|Choose another model|Try again" && /rs-btn rs-btn-primary"[^>]*>Try again</.test(savedLeft) && !/rs-btn rs-btn-primary"[^>]*>Choose another model</.test(savedLeft), `the saved screen offers Try again for the topics left, the main button, with Choose another model beside it (got: ${rowButtons(savedLeft).join("|")})`);
		// The saved run's stop decides Try again, by the card's own rule: the same failure twice can still be tried again.
		const failingStop = { kind: "failing", model: { provider: "openai-compatible", model: "gpt-5.5" }, cause: "repeated" };
		assert(rowButtons(savedScreen(none, ["Office move"], false, failingStop)).join("|") === "Undo|Done|Choose another model|Try again" && /rs-btn rs-btn-primary"[^>]*>Try again</.test(savedScreen(none, ["Office move"], false, failingStop)), "a save after the same failure twice keeps Try again as the main button");
		// Where Try again is sure to fail, it is not offered and the sentence does not promise it; another model leads.
		const sureStop = { kind: "outage", model: { provider: "openai-compatible", model: "gpt-5.5" }, cause: "not-on-account" };
		const savedSure = savedScreen(none, ["Office move"], false, sureStop);
		assert(rowButtons(savedSure).join("|") === "Undo|Done|Choose another model" && /rs-btn rs-btn-primary"[^>]*>Choose another model</.test(savedSure) && (savedSure.match(/rs-btn-primary/g) ?? []).length === 1, `not on the account: Choose another model leads and Try again is not offered (got: ${rowButtons(savedSure).join("|")})`);
		assert(savedSure.includes("The Memory model could not tidy Office move this time; it is unchanged.</p>") && !savedSure.includes("Try again tidies"), `without Try again the sentence ends at "unchanged." (got: ${savedSure.slice(0, 700)})`);
		const savedPart = savedScreen(counts, ["Office move"]);
		assert(rowButtons(savedPart).join("|") === "Undo|Done|Choose another model|Try again" && /rs-btn rs-btn-primary"[^>]*>Done</.test(savedPart) && (savedPart.match(/rs-btn-primary/g) ?? []).length === 1, `a partly done save offers Choose another model and Try again after Done, which stays the main button (got: ${rowButtons(savedPart).join("|")})`);
		assert(savedPart.includes("Office move could not be tidied this time and was left as it was. Try again; if it repeats, choose another model.</p>"), `with Try again the partly done sentence names it (got: ${savedPart.slice(0, 700)})`);
		const savedPartSure = savedScreen(counts, ["Office move"], false, sureStop);
		assert(rowButtons(savedPartSure).join("|") === "Undo|Done|Choose another model" && /rs-btn rs-btn-primary"[^>]*>Done</.test(savedPartSure) && savedPartSure.includes("Office move could not be tidied this time and was left as it was.</p>"), `a partly done save where Try again is sure to fail: no Try again, and the sentence ends with the topic left (got: ${rowButtons(savedPartSure).join("|")} / ${savedPartSure.slice(0, 700)})`);
		assert(!rowButtons(savedScreen(counts, ["Office move"], true)).includes("Try again") && !rowButtons(savedScreen(none, ["Office move"], true)).includes("Try again") && !rowButtons(savedScreen(none, [])).includes("Try again") && !rowButtons(savedScreen(counts, [])).includes("Try again"), "no Try again after an undo, or with no topic left");
		assert(!rowButtons(savedScreen(none, ["Office move"], true)).includes("Choose another model") && !rowButtons(savedScreen(none, [])).includes("Choose another model") && !rowButtons(savedScreen(counts, [])).includes("Choose another model"), "no Choose another model after an undo, or with no topic left");
		assert(/<ReviewSavedScreen[\s\S]{0,1600}?onTryAgain=\{onTryTopicsLeft\}\s*onChooseModel=\{onChooseModel\}/.test(appSource), "the saved screen's Choose another model opens the Memory model's setting, as the card's does");
		// Taking another model brings Try again back, as on the card: the saved screen reads the saved run's stop through the same offer.
		const savedSource = fs.readFileSync(path.join(process.cwd(), "apps", "web-ui", "src", "components", "review-screen.tsx"), "utf8");
		const savedBody = savedSource.slice(savedSource.indexOf("export function ReviewSavedScreen"), savedSource.indexOf("export function reviewPercent"));
		assert(/<ReviewSavedScreen[\s\S]{0,1600}?stop=\{run\?\.stop\}/.test(appSource) && savedBody.includes("useMemoryWaysOn(stop?.cause, stop?.quotaWay, { onTryAgain: left ? onTryAgain : undefined, onChooseModel: left ? onChooseModel : undefined,"), "the saved screen follows the card's Try again rule, and Choose another model brings it back");
		assert(/onTryTopicsLeft=\{\(\) => void startReviewTidy\(\{ topicsLeftOf: reviewWorkflow\.run \}\)\}/.test(appSource) && appSource.includes("const topics = options?.topicsLeftOf ? options.topicsLeftOf.leftAsIs.flatMap((row) => row.topics) : assessment.fields.topics;") && appSource.includes("const depth = options?.topicsLeftOf?.depth ??") && appSource.includes("await startReviewRun(target.agentId, { depth, topics, ...(guidance ? { guidance } : {}) });"), "the saved screen's Try again asks for the topics left only, at the saved run's depth");
		// Its guidance is the saved run's own, which a reload does not lose; the page's would be gone.
		assert(appSource.includes("const guidance = options?.withoutDiscussion ? null : options?.topicsLeftOf ? options.topicsLeftOf.guidance ?? null : reviewWorkflow.guidance ?? null;"), "the saved screen's Try again asks with the saved run's guidance");
		// A new run's screens never carry the last run's automatic-save line, blocked reasons or undo.
		assert(/function beginReviewRunWatch\(base: ReviewWorkflowState, runId: string\): void \{[\s\S]{0,200}setReviewWorkflow\(\{ \.\.\.base, step: "running", runId, run: null, runBusy: false, runPollError: null, approvalResult: null, fastPathApplied: undefined, fastPathBlockedReasons: undefined, undo: undefined, error: null \}\);/.test(appSource), "watching a new Review run clears the last run's saved-screen state");
	}
	const reviewScreen = fs.readFileSync(path.join(process.cwd(), "apps", "web-ui", "src", "components", "review-screen.tsx"), "utf8");
	assert(!/group\.reason/.test(reviewScreen) && !reviewScreen.includes(" \u2014 "), "no reason under it and no em dash");
	const failedScreen = reviewScreen.slice(reviewScreen.indexOf("export function ReviewRunFailedScreen"), reviewScreen.indexOf("export interface ReviewUndoState"));
	assert(failedScreen.includes("<h2>The tidy stopped</h2>") && failedScreen.includes("Nothing was saved. The notes are as they were.") && !failedScreen.includes("{error}"), "a tidy that stopped shows no raw error");
	assert(reviewRunFastPathBlockers(wordingOnly({ warnings: ["A pinned note was rewritten."] })).length === 0, "an engine warning never blocks");
	// The tidy's own judgements, each named: the fixture archives one note as
	// stale, merges two into one and closes one item.
	const judged = reviewRunFastPathBlockers(tidy());
	assert(judged.join("|") === "1 note would move to the archive|2 notes would be merged|1 open item would be closed", `a tidy that archived, merged or closed waits for a person, with each reason named (got: ${judged.join("|")})`);
	assert(reviewRunFastPathBlockers(wordingOnly({ changes: [change({ kind: "archived", why: "duplicate" }), change({ id: "m-0032", kind: "archived", why: "finished" })] }))[0] === "2 notes would move to the archive", "an archive blocks whatever its reason, and two read in the plural");
	assert(reviewRunFastPathBlockers(wordingOnly({ changes: [folded] })).join("|") === "1 topic would be folded into another", `a fold is a judgement a person sees (got: ${reviewRunFastPathBlockers(wordingOnly({ changes: [folded] })).join("|")})`);
	const plural = reviewRunFastPathBlockers(wordingOnly({ changes: [folded, change({ id: "m-0061", topic: "Legal", kind: "topic_folded", before: "Contracts", after: "Legal", notesMoved: 1 }), change({ id: "m-0070", kind: "closed", why: "done" }), change({ id: "m-0071", kind: "closed", why: "done" }), change({ id: "m-0080", kind: "merged", mergedFrom: ["m-0080", "m-0081", "m-0082"] })] }));
	assert(plural.join("|") === "3 notes would be merged|2 open items would be closed|2 topics would be folded into another", `a merge counts the notes it took in, and two of each read in the plural (got: ${plural.join("|")})`);
	assert(reviewRunGuidanceSummary(tidy()) === null, "nothing asked for, nothing listed back");
	const asked = reviewRunGuidanceSummary(tidy({ guidance: { keepAsIs: ["The pricing note"], shorten: [], remove: [], answers: [], instructions: [], topics: [] } }));
	assert(asked?.keepAsIs[0] === "The pricing note", "what the person asked for comes back on the card");
	// The sign-off is the model's words: the card shows them with no note ids, the app's names for the sections, no
	// "the person", and an archive the run did not make as not done, never as asked-for-and-made.
	const removeLines = ["Ways of working: \"Set up a shared calendar for the release dates\" [m-0009] - the calendar has been set up", "Active Items: \"Get to know Fernando\u2026\" The person asked to close it."];
	const plainAsked = reviewRunGuidanceSummary(tidy({ guidance: { keepAsIs: [], shorten: [], remove: removeLines, answers: ["Is the audit done? (m-0118) - not yet"], instructions: ["Keep the data residency audit (m-0118) as an open item."], topics: [] }, removeNotDone: [removeLines[1]] }));
	assert(JSON.stringify(plainAsked?.remove) === JSON.stringify(["Ways of working: \"Set up a shared calendar for the release dates\" - the calendar has been set up"]), `ids leave the archive lines, and the one not done is not among them, got ${JSON.stringify(plainAsked?.remove)}`);
	assert(JSON.stringify(plainAsked?.removeNotDone) === JSON.stringify(["Not done: Open items: \"Get to know Fernando\u2026\" You asked to close it. It is still in memory; you can delete it on the Memory page."]), `an archive the run did not make says so, got ${JSON.stringify(plainAsked?.removeNotDone)}`);
	assert(plainAsked?.instructions[0] === "Keep the data residency audit as an open item." && plainAsked?.answers[0] === "Is the audit done? - not yet", `no id in any line, got ${JSON.stringify([plainAsked?.instructions, plainAsked?.answers])}`);

	for (const text of [sentence, group, depth(false, false), reviewSavedSentence(counts, 90, false), reviewRunProgressLine(tidy({ state: "tidying" })), reviewBar.countsLine, reviewBar.overflowLabel, ...judged]) {
		assert(!/token|area|pass\b|draft|fold|prune/i.test(text), `no engine words on the Review screens (got: ${text})`);
		assert(!text.includes("—"), `no em-dash in product copy (got: ${text})`);
	}
}

// --- The two memory surfaces speak one vocabulary --------------------------
// Room settings and the Memory tab say the same things about the same facts,
// so the sentences and the history rows are pinned here once. Tokens are
// allowed in exactly two places: beside the limit slider, and in a tooltip.
{
	const day = new Date(2026, 8, 13, 14, 2).getTime();
	assert(fmtMemoryDay("2026-09-12") === "12 Sep", `a saved day reads as a day (got: ${fmtMemoryDay("2026-09-12")})`);
	assert(fmtMemoryMoment(day) === "13 Sep, 14:02", `a history row names its moment (got: ${fmtMemoryMoment(day)})`);
	assert(memoryPercentFull(19_963, 20_000) === 100 && memoryPercentFull(1, 0) === 0, "percent full rounds and survives a missing limit");
	assert(memoryFullLine(99) === "memory 99% full" && memoryFullShort(99) === "99% full", "how full memory is, in the two shapes the surfaces use");
	assert(MEMORY_OVER_LIMIT_SENTENCE === "Above its budget. Memorize or Review brings it back.", "above the budget names the two ways back, without sounding like an error");
	assert(memoryUsageTitle(12_400, 20_000) === "Memory 62% full of its budget." && memoryUsageTitle(20_200, 20_000) === "Memory 101% full, above its budget.", `the meter's hover says how full, never a token count (got: ${memoryUsageTitle(12_400, 20_000)} / ${memoryUsageTitle(20_200, 20_000)})`);
	assert(notesSummaryLine(953, 42) === "953 notes in 42 topics", `the Notes heading (got: ${notesSummaryLine(953, 42)})`);
	assert(topicRowLine("Team and roles", 10) === "Team and roles · 10 notes", `a closed topic (got: ${topicRowLine("Team and roles", 10)})`);
	assert(memoryTopicName("Active Items") === "Open items" && memoryTopicName("Team and roles") === "Team and roles", "the open-items section gets the person's word");
	assert(noteRowMeta({ kind: "fact", saved: "2026-09-12", pinned: true }) === "fact · saved 12 Sep · pinned", `a note's meta (got: ${noteRowMeta({ kind: "fact", saved: "2026-09-12", pinned: true })})`);
	assert(memoryArchiveReason("budget") === "to make room" && memoryArchiveReason("done") === "finished" && memoryArchiveReason("superseded") === "replaced", "the archive says why in plain words");
	assert(archiveRowMeta("2026-09-13", "budget") === "archived 13 Sep · to make room", `an archived row (got: ${archiveRowMeta("2026-09-13", "budget")})`);
	assert(roomMemoryFactsLine({ notes: 953, waiting: 10, lastMemorizedAt: Date.now() - 86_400_000 }) === "953 notes · 10 conversations waiting · saved 1d ago", `a room's one line (got: ${roomMemoryFactsLine({ notes: 953, waiting: 10, lastMemorizedAt: Date.now() - 86_400_000 })})`);
	// At a glance counts the notes the rows show: a room never saved shows none, so its starter notes are not counted.
	const glanceRooms = [{ notes: 13, lastCheckpointAt: 1 }, { notes: 2, lastCheckpointAt: 2 }, { notes: 2, lastCheckpointAt: null }, { notes: 2, lastCheckpointAt: null }];
	assert(allRoomsNotesShown(glanceRooms) === 15 && /notes: allRoomsNotesShown\(data\.rooms\)/.test(fs.readFileSync(new URL("../../web-ui/src/components/Memory.tsx", import.meta.url), "utf-8")), "at a glance adds up to the rows");
	assert(roomMemoryFactsLine({ notes: 2, waiting: 1, lastMemorizedAt: null }) === "no memories saved yet \u00b7 1 conversation waiting", `a room never saved, with a conversation waiting, says the card's words and what waits (got: ${roomMemoryFactsLine({ notes: 2, waiting: 1, lastMemorizedAt: null })})`);
	assert(roomMemoryFactsLine({ notes: 2, waiting: 0, lastMemorizedAt: null }) === "no memories saved yet", `a room never saved says what its Home card says, not its starter text as notes (got: ${roomMemoryFactsLine({ notes: 2, waiting: 0, lastMemorizedAt: null })})`);
	// Counts follow the machine's number format: "1'204" on a Swiss one.
	assert(allRoomsFactsLine({ rooms: 3, notes: 1_204, waiting: 12 }) === `3 rooms · ${(1_204).toLocaleString()} notes · 12 conversations waiting`, `the cross-room line (got: ${allRoomsFactsLine({ rooms: 3, notes: 1_204, waiting: 12 })})`);
	const viewed = new Date(2026, 8, 12, 9, 0).getTime();
	const changedNext = new Date(2026, 8, 14, 9, 0).getTime();
	assert(asOfSentence(viewed, changedNext) === "Viewing this room's memory as it was on 12 Sep. It changed next on 14 Sep.", `the banner names the viewed day and the next change (got: ${asOfSentence(viewed, changedNext)})`);
	assert(asOfSentence(viewed, null) === "Viewing this room's memory as it was on 12 Sep. Nothing was saved after that moment, so this is today's memory.", `the banner says when the copy is today's (got: ${asOfSentence(viewed, null)})`);
	assert(memorizedConversationsTitle(12) === "Memorized conversations (12)", `the memorized fold counts its rows (got: ${memorizedConversationsTitle(12)})`);
	const began = new Date(2026, 8, 3, 10, 0).getTime();
	assert(inMemorySinceLine(began, "953 notes · 10 conversations waiting") === "In memory since 3 Sep · 953 notes · 10 conversations waiting", `the strip leads with the day memory began (got: ${inMemorySinceLine(began, "953 notes · 10 conversations waiting")})`);
	assert(budgetSettledHint(75_000) === "Set to 75k when this room came to 0.12, so nothing it already had leaves. Lower it whenever you want.", `the hint under the slider of a room whose budget started at its size (got: ${budgetSettledHint(75_000)})`);

	const event = (overrides: Partial<MemorySaveEvent> & { kind: MemorySaveEvent["kind"] }): MemorySaveEvent => ({ ts: day, saveId: `s-${Math.random().toString(36).slice(2, 7)}`, ...overrides });
	const rows = memoryHistoryRows([
		event({ kind: "learn", saveId: "ab_1", sessions: 10 }),
		event({ kind: "user_edit", saveId: "me_1" }),
		event({ kind: "user_edit", saveId: "me_2" }),
		event({ kind: "user_edit", saveId: "me_3" }),
		event({ kind: "review", saveId: "rv_1", topicsTidied: 5 }),
		event({ kind: "review", saveId: "rv_0" }),
		event({ kind: "checkpoint", saveId: "cp_1" }),
		event({ kind: "migrate", saveId: "mg_1", entriesAssigned: 4 }),
		event({ kind: "undo", saveId: "me_0", undoneKind: "review", undoneAt: "2026-09-13T08:00:00.000Z" }),
	]);
	const words = rows.map((row) => row.words);
	assert(
		words.join(" | ") === "Memorized 10 conversations | 3 edits by hand | Tidied 5 topics | Tidied the notes | Remembered a conversation | Notes given their ids | Undone: the Review of 13 Sep",
		`the history rows, in the words both surfaces read (got: ${words.join(" | ")})`,
	);
	for (const text of words) assert(!/session|entry|entries|budget|fold|absorb|prune|timeline/i.test(text), `no engine words in a history row (got: ${text})`);
	assert(rows[0].saveId === "ab_1" && rows[1].saveId === null, "only a Memorize or Review row carries the key undo needs");
	assert(undoableHistoryRow(rows)?.saveId === "ab_1", "Undo is offered on the newest save, while it is still the newest change");
	assert(undoableHistoryRow(rows.slice(1)) === null, "Undo is not offered when hand edits came after the save");
	assert(undoableHistoryRow(memoryHistoryRows([event({ kind: "learn", saveId: "ab_2", sessions: 1, undone: true })])) === null, "a save already taken back is not offered again");
	assert(memoryHistoryRows([event({ kind: "learn", saveId: "ab_3", sessions: 1, undone: true })])[0].undone === true, "an undone save keeps its row and says so");
	// A note deleted for good is its own row, never folded into a run of hand
	// edits, and never offered Undo: nothing brings it back.
	const goneRows = memoryHistoryRows([
		event({ kind: "user_edit", saveId: "me_4", operation: "archive_delete", topic: "Commercial terms" }),
		event({ kind: "user_edit", saveId: "me_5", operation: "edit" }),
		event({ kind: "user_edit", saveId: "me_6", operation: "archive_delete", topic: "Active Items" }),
		event({ kind: "user_edit", saveId: "me_7", operation: "archive_delete", topic: "Working style" }),
		event({ kind: "learn", saveId: "ab_4", sessions: 1 }),
	]);
	assert(
		goneRows.map((row) => row.words).join(" | ") === 'Deleted an archived note from "Commercial terms" | Edited by hand | Deleted 2 archived notes | Memorized 1 conversation',
		`a delete for good has its own row, and two in a row are counted (got: ${goneRows.map((row) => row.words).join(" | ")})`,
	);
	assert(memoryHistoryRows([event({ kind: "user_edit", saveId: "me_8", operation: "archive_delete", topic: "Active Items" })])[0].words === 'Deleted an archived note from "Open items"', "the row names the topic in the words a person reads");
	assert(goneRows.every((row) => row.kind !== "user_edit" || row.saveId === null) && undoableHistoryRow(goneRows) === null, "a delete for good is never offered Undo");

	// "What changed" is offered on a row that is exactly one recorded save with
	// its stored copies still on disk: a folded run of hand edits has no single
	// before and after, and a remembered conversation changes no note yet.
	const changeRows = memoryHistoryRows([
		event({ kind: "learn", saveId: "ab_9", sessions: 2, diffable: true }),
		event({ kind: "user_edit", saveId: "me_9", diffable: true }),
		event({ kind: "user_edit", saveId: "me_10", diffable: true }),
		event({ kind: "undo", saveId: "me_11", undoneKind: "memorize", diffable: true }),
		event({ kind: "checkpoint", saveId: "cp_9", diffable: true }),
		event({ kind: "review", saveId: "rv_9" }),
	]);
	assert(
		changeRows.map((row) => `${row.diffable}:${row.eventId}`).join(" | ") === "true:ab_9 | false:null | true:me_11 | false:cp_9 | false:rv_9",
		`which rows can show what changed, and by which id (got: ${changeRows.map((row) => `${row.diffable}:${row.eventId}`).join(" | ")})`,
	);
	const oneEdit = memoryHistoryRows([event({ kind: "user_edit", saveId: "me_12", diffable: true })])[0];
	assert(oneEdit.diffable && oneEdit.eventId === "me_12" && oneEdit.saveId === null, "a single hand edit shows what changed without being offered Undo");
	assert(WHAT_CHANGED_LABEL === "What changed" && HIDE_CHANGE_LABEL === "Hide", "the fold's button, closed and open");
	assert(changeMetaLine("learn", true) === "Added notes are marked +, archived notes are struck, an updated note shows its old text struck above the new one.", `the fold's line above the notes (got: ${changeMetaLine("learn", true)})`);
	assert(changeMetaLine("review", null) === CHANGE_META, "an after side the record cannot vouch for or against says nothing more");
	assert(
		changeMetaLine("undo", false) === "What this undo put back. Added notes are marked +, archived notes are struck, an updated note shows its old text struck above the new one. The after side is the next recorded state and may include a change made outside this save.",
		`an undo's fold says what came back first, and an unverified after side last (got: ${changeMetaLine("undo", false)})`,
	);
	assert(changeMetaLine("learn", true, false) === "Removed lines are struck, added lines marked +." && changeMetaLine("undo", null, false) === `What this undo put back. ${CHANGE_LINES_META}`, `two copies compared line by line say what their marks mean (got: ${changeMetaLine("learn", true, false)})`);
	assert(memoryTopicName("Team and roles · open items") === "Team and roles · open items" && memoryTopicName("Waiting conversations") === "Waiting conversations", "a changed section's name passes through as the server wrote it");
	for (const text of [WHAT_CHANGED_LABEL, HIDE_CHANGE_LABEL, CHANGE_READING, CHANGE_READ_ERROR, CHANGE_NONE, CHANGE_META, CHANGE_LINES_META, CHANGE_UNVERIFIED, CHANGE_CONVERSATIONS_BLOCK]) {
		assert(!/token|snapshot|event|section|entry/i.test(text), `no engine words in the fold (got: ${text})`);
	}

	// The note view counts what a save did, in a fixed order, the first count
	// naming what is counted and the rest the bare number and word.
	const counts = { ...emptyNoteChangeCounts(), added: 5, updated: 2, moved: 1, archived: 7, left: 10 };
	assert(noteChangeTotals(counts) === "5 notes added · 2 updated · 1 moved · 7 archived · 10 conversations left the waiting list", `the totals line (got: ${noteChangeTotals(counts)})`);
	assert(noteChangeTotals({ ...emptyNoteChangeCounts(), archived: 1, joined: 1 }) === "1 note archived · 1 conversation came back to the waiting list", `one of each is singular, and an undo's conversations come back (got: ${noteChangeTotals({ ...emptyNoteChangeCounts(), archived: 1, joined: 1 })})`);
	assert(noteChangeTotals({ ...emptyNoteChangeCounts(), closed: 2, reopened: 1, pinned: 3, unpinned: 1 }) === "2 notes closed · 1 reopened · 3 pinned · 1 unpinned", `the flag changes follow the text changes in order (got: ${noteChangeTotals({ ...emptyNoteChangeCounts(), closed: 2, reopened: 1, pinned: 3, unpinned: 1 })})`);
	assert(noteChangeTotals({ ...emptyNoteChangeCounts(), left: 3 }) === "3 conversations left the waiting list" && noteChangeTotals(emptyNoteChangeCounts()) === "", "a save that only cleared the waiting list says so alone; nothing changed says nothing");
	const topicCounts = countNoteChanges([{ change: "updated" }, { change: "added" }, { change: "added" }, { change: "archived" }]);
	assert(topicChangeSummary(topicCounts) === "2 added · 1 updated · 1 archived", `beside a topic's heading, bare numbers in the same order (got: ${topicChangeSummary(topicCounts)})`);
	assert(topicChangeSummary({ ...topicCounts, left: 4, joined: 2 }) === "2 added · 1 updated · 1 archived", "a topic's summary never counts conversations");
	assert(archivedLabel(undefined) === "archived" && archivedLabel(null) === "archived" && archivedLabel("") === "archived", "an archived note without a reason says only that it was");
	assert(archivedLabel("budget") === "archived · to make room" && archivedLabel("superseded") === "archived · replaced" && archivedLabel("user") === "archived · removed by you", `an archived note's reason in the archive list's own words (got: ${archivedLabel("budget")})`);
	assert(movedLabel("Team and roles") === 'moved from "Team and roles"' && movedLabel("Active Items") === 'moved from "Open items"', `a moved note names where it came from, in the words a person reads (got: ${movedLabel("Active Items")})`);
	assert(["pinned", "unpinned", "closed", "reopened"].every((flag) => noteFlagLabel(flag as "pinned") === flag), "a flag change is labelled by its one word");
	const updatedWords = diffWords("the cat sat on the mat", "the cat lay on the rug");
	assert(updatedWords.map((t) => `${t.type}:${t.text}`).join(" ") === "same:the same:cat del:sat add:lay same:on same:the del:mat add:rug", `an updated note's words, each with its type (got: ${updatedWords.map((t) => `${t.type}:${t.text}`).join(" ")})`);
	assert(diffWords("", "").length === 0 && diffWords("  a  b ", "a b").every((t) => t.type === "same"), "whitespace is not a word");
	assert(plainNoteText("- **Budget** is `fixed`  at\n  ten") === "Budget is fixed at ten", `a note reads as one plain line in the fold (got: ${plainNoteText("- **Budget** is `fixed`  at\n  ten")})`);
}

// A conversation kept whole as its summary, a run the model stopped
// answering, and a run whose every conversation was kept whole: the card's
// words, and a summary never holds the automatic save back.
{
	const copy: Record<string, unknown> = await import("../../web-ui/src/memory-v2-copy.js");
	const kept = session({ id: "RC-0002", outcome: "summarized" as AbsorbRun["sessions"][number]["outcome"], summary: { added: 1, updated: 0, superseded: 0, closed: 0 } });
	assert(absorbRunSessionLine({ ...kept, summary: { added: 1, updated: 0, superseded: 0, closed: 0 } }) === "Memorized · 1 added", `a page placed as one note reads like any other (got: ${absorbRunSessionLine(kept)})`);
	assert(!("ABSORB_SUMMARIZED_HOVER" in copy) && !("ABSORB_SUMMARIZED_LINE" in copy), "no one-note line and no hover");
	const readCount = copy.absorbRunReadCount as (r: AbsorbRun) => number;
	assert(readCount(run({ sessions: [session(), kept] })) === 2, "a summary counts as read");
	const blockers = absorbRunFastPathBlockers(run({ sessions: [session(), kept] }));
	assert(!blockers.some((reason) => /did not finish/.test(reason)), `a summary never holds the automatic save back (got: ${JSON.stringify(blockers)})`);
	const waiting = session({ id: "RC-0003", outcome: "pending" });
	assert(!absorbRunFastPathBlockers(run({ sessions: [session(), waiting] })).some((reason) => /did not finish/.test(reason)), "a conversation still waiting waits for the next Memorize and holds nothing");
	const outage = copy.absorbRunOutageSentence as ((model: string, cause: "not-answering" | "busy" | "signed-out" | "quota" | "not-offered", waiting: number) => string) | undefined;
	assert(outage, "the outage sentence exists");
	assert(outage("Claude Opus 5.5", "not-answering", 3) === "Memorize paused because Claude Opus 5.5 isn't answering right now. 3 conversations are still waiting.", `the outage sentence (got: ${outage("Claude Opus 5.5", "not-answering", 3)})`);
	// A model busy past the shared patience; a quota is its own cause now (model-call-causes.ts).
	assert(outage("GPT-5.5", "busy", 1) === "Memorize paused because GPT-5.5 is still busy after several tries. 1 conversation is still waiting.", `the busy sentence, one waiting (got: ${outage("GPT-5.5", "busy", 1)})`);
	assert(outage("GPT-5.5", "signed-out", 1) === "Memorize paused: GPT-5.5's provider is signed out. 1 conversation is still waiting.", `the signed-out sentence (got: ${outage("GPT-5.5", "signed-out", 1)})`);
	const keyOutage = copy.absorbRunOutageSentence as (model: string, cause: "signed-out", waiting: number, provider?: string, key?: "missing" | "refused" | "no-workspace") => string;
	// A gateway is named as AI setup names it, from the run's stop, never by the id a shown name may carry;
	// without that name, and for a known provider, it is "{model}'s provider", the model named without its provider.
	const gatewayOutage = copy.absorbRunOutageSentence as (model: string, cause: "signed-out", waiting: number, provider?: string, key?: "refused", unreached?: undefined, quotaWay?: undefined, gateway?: string) => string;
	const gatewayRefused = gatewayOutage("Test Model (test-gateway)", "signed-out", 1, "test-gateway", "refused", undefined, undefined, "Test Gateway");
	assert(gatewayRefused === "Memorize paused: Test Gateway did not accept the saved key. 1 conversation is still waiting.", `a gateway's refused key names the gateway as AI setup does (got: ${gatewayRefused})`);
	const reviewPaused = copy.reviewRunPausedSentence as (model: string, stop: { cause: "signed-out"; model: { provider: string }; key: "refused"; gateway?: string }, tidied: boolean) => string;
	// Nothing tidied: the card's headline says "Review paused.", so the line is the cause alone.
	const reviewGateway = reviewPaused("Test Model (test-gateway)", { cause: "signed-out", model: { provider: "test-gateway" }, key: "refused", gateway: "Test Gateway" }, false);
	assert(reviewGateway === "Test Gateway did not accept the saved key. Nothing was lost.", `Review's paused line names the gateway as AI setup does (got: ${reviewGateway})`);
	const unnamed = reviewPaused("Test Model (gateway-acme)", { cause: "signed-out", model: { provider: "gateway-acme" }, key: "refused" }, false);
	assert(unnamed === "Test Model's provider did not accept the saved key. Nothing was lost.", `a gateway with no name on the stop is the model's provider, never its id (got: ${unnamed})`);
	const tidiedGateway = reviewPaused("Test Model (test-gateway)", { cause: "signed-out", model: { provider: "test-gateway" }, key: "refused", gateway: "Test Gateway" }, true);
	assert(tidiedGateway === "Review paused: Test Gateway did not accept the saved key. What was tidied can be saved; the rest is unchanged.", `with something tidied no headline says it paused, so the line does (got: ${tidiedGateway})`);
	const known = keyOutage("Claude Sonnet 5.5 (Claude API key)", "signed-out", 2, "anthropic-api-key", "refused");
	assert(known === "Memorize paused: Claude Sonnet 5.5's provider did not accept the saved key. 2 conversations are still waiting.", `a known provider's line names the model without its provider (got: ${known})`);
	assert(keyOutage("GPT-5.5", "signed-out", 1, "openai", "missing") === "Memorize paused: GPT-5.5's provider has no key saved. 1 conversation is still waiting.", `the key-missing sentence (got: ${keyOutage("GPT-5.5", "signed-out", 1, "openai", "missing")})`);
	assert(keyOutage("GPT-5.5", "signed-out", 1, "openai", "refused") === "Memorize paused: GPT-5.5's provider did not accept the saved key. 1 conversation is still waiting.", `the key-refused sentence (got: ${keyOutage("GPT-5.5", "signed-out", 1, "openai", "refused")})`);
	assert(outage("GPT-5.5", "quota", 2) === "Memorize paused because GPT-5.5 has reached its usage limit or run out of credit. 2 conversations are still waiting.", `the quota sentence (got: ${outage("GPT-5.5", "quota", 2)})`);
	assert(outage("GPT-5.5", "not-offered", 1) === "Memorize paused because GPT-5.5 is no longer offered. 1 conversation is still waiting.", `the not-offered sentence (got: ${outage("GPT-5.5", "not-offered", 1)})`);
	// A paused card says the cause, then what is safe, then the way on, as the chat's line does; Choose another model is the button below.
	const unreachedOutage = copy.absorbRunOutageSentence as (model: string, cause: "not-answering", waiting: number, provider?: string, key?: undefined, unreached?: "connection" | "local-connection") => string;
	const offline = unreachedOutage("GPT-5.5", "not-answering", 2, "openai", undefined, "connection");
	assert(offline === "Memorize paused because GPT-5.5 could not be reached. 2 conversations are still waiting. Check your internet connection, then try again.", `the no-connection sentence (got: ${offline})`);
	const localOff = unreachedOutage("Qwen", "not-answering", 1, "local-llm", undefined, "local-connection");
	assert(localOff === "Memorize paused because Qwen could not be reached on this computer. 1 conversation is still waiting. Check that the app running it is open, then try again.", `the on-this-computer sentence (got: ${localOff})`);
	assert(keyOutage("Claude Sonnet 5.5", "signed-out", 2, "anthropic-api-key", "no-workspace") === "Memorize paused: Claude Sonnet 5.5's provider has a key that isn't tied to a workspace. 2 conversations are still waiting.", `the key-outside-a-workspace sentence (got: ${keyOutage("Claude Sonnet 5.5", "signed-out", 2, "anthropic-api-key", "no-workspace")})`);
	type PausedStop = { cause: "not-answering" | "quota" | "busy" | "signed-out"; model: { provider: string }; key?: "missing" | "refused" | "no-workspace"; unreached?: "connection" | "local-connection" };
	const paused = copy.reviewRunPausedSentence as (model: string, stop: PausedStop, tidied: boolean) => string;
	const unreached: PausedStop = { cause: "not-answering", model: { provider: "openai" }, unreached: "connection" };
	assert(paused("Test Model", unreached, false) === "Test Model could not be reached. Nothing was lost. Check your internet connection, then try again.", `Review paused with nothing tidied: the cause alone, under the paused headline (got: ${paused("Test Model", unreached, false)})`);
	assert(paused("Test Model", unreached, true) === "Review paused because Test Model could not be reached. What was tidied can be saved; the rest is unchanged. Check your internet connection, then try again.", `Review paused with something tidied (got: ${paused("Test Model", unreached, true)})`);
	assert(paused("Qwen", { cause: "not-answering", model: { provider: "local-llm" }, unreached: "local-connection" }, false) === "Qwen could not be reached on this computer. Nothing was lost. Check that the app running it is open, then try again.", "Review paused on this computer");
	assert(paused("GPT-5.5", { cause: "quota", model: { provider: "openai" } }, false) === "GPT-5.5 has reached its usage limit or run out of credit. Nothing was lost.", `Review paused at a usage limit (got: ${paused("GPT-5.5", { cause: "quota", model: { provider: "openai" } }, false)})`);
	assert(paused("Test Model", { cause: "not-answering", model: { provider: "openai" } }, false) === "Test Model isn't answering right now. Nothing was lost.", `the first read's notice words it the same (got: ${paused("Test Model", { cause: "not-answering", model: { provider: "openai" } }, false)})`);
	// A gone credential is the provider's state, never "paused because X cannot answer because…".
	for (const [key, state] of [[undefined, "is signed out"], ["missing", "has no key saved"], ["refused", "did not accept the saved key"], ["no-workspace", "has a key that isn't tied to a workspace"]] as const) {
		const line = paused("Test Model", { cause: "signed-out", model: { provider: "anthropic-api-key" }, ...(key ? { key } : {}) }, false);
		assert(line === `Test Model's provider ${state}. Nothing was lost.`, `Review paused on a gone credential (${key ?? "signed out"}) (got: ${line})`);
	}
	assert(paused("GPT-5.5", { cause: "busy", model: { provider: "openai" } }, true) === "Review paused because GPT-5.5 is still busy after several tries. What was tidied can be saved; the rest is unchanged.", "a cause with no way on of its own ends with what is safe");
	for (const tidied of [false, true]) for (const stop of [unreached, { cause: "quota" as const, model: { provider: "openai" } }]) {
		const line = paused("Test Model", stop, tidied);
		assert(!(line.includes("Nothing was lost.") && line.includes("What was tidied")) && !line.includes("Room settings"), `one sentence of what is safe, and no Room settings beside the button (got: ${line})`);
	}
	// The notice names the model that stopped, from the run's own stop, even
	// after the person chose another Memory model and that one stopped too.
	const outageModel = copy.absorbRunOutageModelName as ((stopped: { provider: string; model: string }, memoryModel?: { provider: string; model: string; label?: string } | null) => string) | undefined;
	assert(outageModel, "the notice's model name comes from the run's stop");
	const swapped = outageModel({ provider: "anthropic", model: "claude-opus-5-5" }, { provider: "openai", model: "gpt-5.5", label: "GPT-5.5" });
	assert(swapped === "Claude Opus 5.5", `a notice after a switch names the model that stopped, alone, never the room's earlier one (got: ${swapped})`);
	const sameModel = outageModel({ provider: "openai-compatible", model: "rm-7" }, { provider: "openai-compatible", model: "rm-7", label: "Room Model" });
	assert(sameModel === "Room Model", `the room's label names the model that stopped when it is that model (got: ${sameModel})`);
	const otherLabel = outageModel({ provider: "openai-compatible", model: "rm-7" }, { provider: "openai-compatible", model: "narrow-7", label: "Narrow Model" });
	assert(!otherLabel.includes("Narrow Model"), `another model's label never names the one that stopped (got: ${otherLabel})`);
	const waitingCount = copy.absorbRunWaitingCount as (r: AbsorbRun) => number;
	assert(waitingCount(run({ sessions: [session(), kept, waiting, session({ id: "RC-0004", outcome: "failed" }), session({ id: "RC-0005", outcome: "skipped" })] })) === 2, "the waiting count is the pending and failed conversations");
	assert(copy.ABSORB_TRY_AGAIN_LABEL === "Try again" && copy.ABSORB_CHOOSE_MODEL_LABEL === "Choose another model", "the two ways out");
	const allSummarized = copy.absorbRunAllSummarized as (r: AbsorbRun) => boolean;
	assert(allSummarized(run({ sessions: [kept, session({ id: "RC-0006", outcome: "summarized" }), session({ id: "RC-0007", outcome: "skipped" })] })) && !allSummarized(run({ sessions: [kept, session()] })) && !allSummarized(run({ sessions: [session({ id: "RC-0008", outcome: "skipped" })] })), "every conversation read was kept whole, and at least one was");
	assert((copy.absorbRunAllSummarizedSentence as (model: string) => string)("GPT-5.5") === "GPT-5.5 could not sort these conversations into topics. Another Memory model may do better.", "the all-summaries sentence");
	// After an automatic save the saved sentence names the sort, as after a reviewed one; no second line says it again.
	assert(!("absorbRunAutomaticSaveLines" in copy), "the automatic save adds no second sort line");
	const app = (await import("node:fs")).readFileSync(new URL("../../web-ui/src/App.tsx", import.meta.url), "utf-8");
	assert(!app.includes("absorbRunAutomaticSaveLines"), "the saved screen shows the sort once");
}

// The first read never blocks Memorize: one sentence when there is none, and
// the client stands in only for a request that failed without the server
// saying why (the network, or a server error with no code).
{
	const copy: Record<string, unknown> = await import("../../web-ui/src/memory-v2-copy.js");
	assert(copy.FIRST_READ_MISSING_SENTENCE === "No first read this time. Read again, or continue without it.", `the missing first read's sentence (got: ${copy.FIRST_READ_MISSING_SENTENCE})`);
	const api: Record<string, unknown> = await import("../../web-ui/src/api.js");
	const unexplained = api.isUnexplainedRequestFailure as ((error: unknown) => boolean) | undefined;
	const RequestError = api.ApiRequestError as (new (message: string, status: number, code?: string) => Error) | undefined;
	assert(unexplained && RequestError, "the api module tells an unexplained request failure apart");
	assert(unexplained(new TypeError("Failed to fetch")) && unexplained(new RequestError("Request failed (502)", 502)), "a network failure and an uncoded server error are unexplained");
	assert(!unexplained(new RequestError("This room is busy right now.", 409, "room_busy")) && !unexplained(new RequestError("This room has no Memory model.", 400)) && !unexplained(new RequestError("Failed.", 503, "absorb_x")), "a sentence the server wrote, or a code it sent, is its answer");
	assert(!unexplained(new DOMException("The operation was aborted.", "AbortError")), "the person's own cancel is never a failed first read");
	assert((api.apiErrorCode as (error: unknown) => string | undefined)(new RequestError("Gone.", 404, "absorb_run_unknown")) === "absorb_run_unknown", "the server's code is kept on a failed request");
}

// 13. The summary notes a run reads again: rows like any conversation's.
{
	const { absorbRunAllSummarized, absorbRunNotesChanged, absorbRunRows, archivedEntryRestorable } = await import("../../web-ui/src/memory-v2-copy.js");
	const reread = (overrides: Partial<AbsorbRunSession> = {}): AbsorbRunSession => session({ id: "m-0101", title: "Call about the renewal", date: "2026-08-01", summary: { added: 2, updated: 0, superseded: 0, closed: 0 }, ...overrides });
	// A re-read's note that may disagree holds the automatic save like any row.
	const tagged = run({ sessions: [session({ summary: { added: 1, updated: 0, superseded: 0, closed: 0 } })], rereads: [reread({ changes: [{ kind: "added", id: "m-0901", section: "Deep Memory", topic: "Maintenance terms", after: "- It renews on 1 July.", beside: "may-disagree", besideOf: "m-0003" } as any] })] });
	assert(absorbRunFastPathBlockers(tagged).some((reason) => /may disagree/.test(reason)), `a re-read's note that may disagree holds the automatic save (got: ${JSON.stringify(absorbRunFastPathBlockers(tagged))})`);
	assert(absorbRunRows(run({ sessions: [], rereads: [reread({ changes: [{ kind: "added", id: "m-0903", topic: "Maintenance terms", after: "- A." } as any] })] }), false)[0]?.line === "Memorized · 2 added", "a note read again reads like any conversation");
	assert(absorbRunRows(run({ sessions: [], rereads: [reread()] }), false).length === 0 && absorbRunRows(run({ sessions: [], rereads: [reread({ outcome: "failed" })] }), true).length === 0, "a note read again that changed nothing, or was not sorted, has no row");
	const sorting = run({ state: "folding", progress: { folded: 3, total: 3, current: { id: "m-0101", title: "Call about the renewal" } }, rereads: [reread({ outcome: "folding" })] });
	assert(absorbRunProgressLine(sorting) === "Memorizing · Call about the renewal", `a note read again is not counted as a conversation (got: ${absorbRunProgressLine(sorting)})`);
	// A re-read that never finished holds nothing back and is no conversation left unfinished.
	const unfinished = run({ sessions: [session()], rereads: [reread({ outcome: "failed" }), reread({ id: "m-0102", outcome: "pending" })] });
	assert(unfinished.sessions.length === 1 && absorbRunFastPathBlockers(run({ sessions: [session({ summary: { added: 1, updated: 0, superseded: 0, closed: 0 } })], rereads: [reread({ outcome: "failed" })] })).length === 0, "an unsorted note is not an unfinished conversation, and does not hold the automatic save");
	assert(absorbRunNotesChanged(run({ sessions: [session({ summary: { added: 1, updated: 0, superseded: 0, closed: 0 } })], rereads: [reread()] })) === 3, "the notes a re-read added are counted with the rest");
	assert(absorbRunAllSummarized(run({ sessions: [session({ outcome: "summarized" })], rereads: [reread()] })), "a sorted note does not stop the all-summaries notice");
	// An outage in the re-read pass: the notice names no notes and never "0 conversations".
	const { absorbRunOutageSentence, absorbRunWaitingCount } = await import("../../web-ui/src/memory-v2-copy.js");
	const stopped = run({ state: "ready", stop: { kind: "outage", model: { provider: "openai", model: "gpt-5.5" }, cause: "not-answering" }, sessions: [session()], rereads: [reread(), reread({ id: "m-0102", outcome: "pending" })] });
	const notice = absorbRunOutageSentence("GPT-5.5", "not-answering", absorbRunWaitingCount(stopped));
	assert(notice === "Memorize paused because GPT-5.5 isn't answering right now.", `the notice names no notes, and no conversation count of 0 (got: ${notice})`);
	// A paused run that read no conversation has nothing to save; one that read any has.
	const { absorbRunNothingRead, absorbRunNothingToSave, ABSORB_NOTHING_READ_SENTENCE, ABSORB_NOTHING_READ_SAVE_TITLE } = await import("../../web-ui/src/memory-v2-copy.js");
	const busyFromTheStart = run({ state: "ready", stop: { kind: "outage", model: { provider: "openai", model: "gpt-5.5" }, cause: "busy" }, sessions: [session({ outcome: "pending" }), session({ id: "RC-0002", outcome: "pending" })] });
	assert(absorbRunNothingRead(busyFromTheStart) && ABSORB_NOTHING_READ_SENTENCE === "No conversation was read yet." && ABSORB_NOTHING_READ_SAVE_TITLE === "Nothing to save yet: no conversation was read.", "a paused run that read nothing says so, and Save says why it is off");
	for (const outcome of ["folded", "dropped", "summarized"] as const) assert(!absorbRunNothingRead(run({ ...busyFromTheStart, sessions: [session({ outcome }), session({ id: "RC-0002", outcome: "pending" })] })), `a run with a ${outcome} conversation has something to save`);
	assert(!absorbRunNothingRead(run({ ...busyFromTheStart, rereads: [reread()] })) && absorbRunNothingRead(run({ ...busyFromTheStart, rereads: [reread({ outcome: "pending" })] })), "a sorted note from Unsorted counts as read; one still waiting does not");
	// Save is off only when a save would change nothing; four things a save still records keep it on while the sentence says nothing was read.
	assert(absorbRunNothingToSave(busyFromTheStart), "the busy-from-the-start run (room 14h) has nothing to save");
	const stillSaves: Array<[string, AbsorbRun]> = [
		["a conversation left out", run({ ...busyFromTheStart, sessions: [session({ outcome: "skipped" }), session({ id: "RC-0002", outcome: "pending" })] })],
		["notes leaving for the budget", run({ ...busyFromTheStart, demotion: demotion([row()]) })],
		["a limit raised on the card", run({ ...busyFromTheStart, budget: budget({ budgetTokens: 24_000 }) })],
		...(["failed", "dropped", "summarized"] as const).map((outcome): [string, AbsorbRun] => [`a re-read note that was tried (${outcome})`, run({ ...busyFromTheStart, rereads: [reread({ outcome })] })]),
	];
	for (const [what, candidate] of stillSaves) assert(absorbRunNothingRead(candidate) && !absorbRunNothingToSave(candidate), `${what} keeps Save on while no conversation was read`);
	assert(absorbRunNothingToSave(run({ ...busyFromTheStart, rereads: [reread({ outcome: "pending" }), reread({ id: "m-0102", outcome: "folding" })] })), "a re-read note not tried yet saves nothing");
	// The chooser's "notes in Unsorted can be sorted": a run that only sorted them saves the sort, as the server does.
	const sortOnly = run({ ...busyFromTheStart, stop: undefined, progress: { folded: 0, total: 0 }, sessions: [], sorted: [{ id: "m-0101", text: "- Invoices go out on the first.", topic: "Invoicing" }] });
	assert(absorbRunNothingRead(sortOnly) && !absorbRunNothingToSave(sortOnly), "a run that only sorted notes out of Unsorted can be saved");
	// The saved screen and the archive.
	assert(!/read again/.test(absorbRunSavedSentence({ foldedSessions: ["RC-0001"], sortedNotes: 2 })), "the saved screen says nothing of notes read again");
	assert(!absorbRunSavedSentence({ foldedSessions: ["RC-0001"] }).includes("Unsorted"), "and says nothing when none was");
	// A Memorize that only sorted says so, never "Nothing new" over "0 conversations".
	const sortedOnly = absorbRunSavedSentence({ foldedSessions: [], sortedNotes: 3 });
	assert(sortedOnly === "3 notes waiting in Unsorted were sorted into topics.", `a run that only sorted names the sort, got ${sortedOnly}`);
	const foldedAndSorted = absorbRunSavedSentence({ foldedSessions: ["RC-0001"], sortedNotes: 2 });
	assert(foldedAndSorted === "1 conversation became lasting notes. 2 notes waiting in Unsorted were sorted into topics.", `a run that also sorted says it, got ${foldedAndSorted}`);
	const { absorbRunSavedHeadline: savedHeadline } = await import("../../web-ui/src/memory-v2-copy.js") as any;
	assert(savedHeadline({ foldedSessions: [], sortedNotes: 3 }, "Atlas") === "Atlas sorted its notes into topics", `the headline names the sort, got ${savedHeadline({ foldedSessions: [], sortedNotes: 3 }, "Atlas")}`);
	const savedScreen = fs.readFileSync(new URL("../../web-ui/src/App.tsx", import.meta.url), "utf8");
	assert((savedScreen.match(/sortedNotes: absorbRunSortedRows\(state\.run\)\.length/g) ?? []).length === 2, "the saved screen counts the notes the run's sort moved");
	assert(archiveReasonLabel("sorted") === "sorted into topics" && memoryArchiveReason("sorted") === "sorted into topics" && archivedEntryRestorable({ why: "sorted" }), "a sorted note's archive row names why, and can be brought back");
}

// A scheduled task waits after every Remember and Forget, not only a full room's, until the next conversation starts.
{
	const pane = fs.readFileSync(new URL("../../web-ui/src/scheduled-run-reason.ts", import.meta.url), "utf8");
	assert(pane.includes('case "prepared_runtime_boundary": return "Waits until the next conversation in this room has started.";'), "the wait line names what it waits for");
}

// A scheduled run's line in the pane: a revived run still says what it waits for, never the engine's sentence, and a
// run that met the prepared conversation and will not run says so plainly.
{
	const { formatFriendlyRunReason } = await import("../../web-ui/src/scheduled-run-reason.js") as { formatFriendlyRunReason: (run: unknown) => string | null };
	const engine = "Background run was blocked by a transient condition; it will be rechecked before execution.";
	const revived = (blockedFor: string) => formatFriendlyRunReason({ status: "deferred", reason: "transient_block_revived", message: engine, readiness: { reason: blockedFor, message: engine } });
	assert(revived("prepared_runtime_boundary") === "Waits until the next conversation in this room has started.", `a revived run still says what it waits for, got ${revived("prepared_runtime_boundary")}`);
	assert(revived("provider_not_connected") === "AI provider is not connected.", "a revived run says the condition it was blocked for");
	assert(revived("transient_block_revived") === "Waiting to run.", "a revived run with nothing more to say is plainly waiting");
	const ended = (reason: string) => formatFriendlyRunReason({ status: "blocked", reason, message: "engine words" });
	assert(ended("superseded_by_later_run") === "A later run of this task took its place.", `an older occurrence says a later one took its place, got ${ended("superseded_by_later_run")}`);
	assert(ended("prepared_conversation_ended") === "Did not run. The conversation it was waiting for has ended.", `a run that met an earlier conversation says it did not run, got ${ended("prepared_conversation_ended")}`);
	assert(ended("prepared_conversation_not_recorded") === "Did not run.", `a run blocked before the update says only that it did not run, got ${ended("prepared_conversation_not_recorded")}`);
	// A failure the pane has no words for shows a plain line, never the server's own text.
	const raw = "Scheduled prompt background execution failed: invalid background run target thread id: postcp_20261011T150343Z_v5ngbi";
	const failed = formatFriendlyRunReason({ status: "failed", reason: "execution_failed", message: raw, error: { code: "execution_failed", message: raw } });
	assert(failed === "Something went wrong, so this run did not finish.", `a failed run shows a plain line, got ${failed}`);
	const blockedOther = formatFriendlyRunReason({ status: "blocked", reason: "room_error", message: "Room runtime state is unreadable: ENOENT" });
	assert(blockedOther === "Waiting to run.", `a blocked run the pane has no words for is still checked again, so it is waiting, got ${blockedOther}`);
	const revivedOther = formatFriendlyRunReason({ status: "deferred", reason: "transient_block_revived", message: "x", readiness: { reason: "schedule_store_unreadable", message: "x" } });
	assert(revivedOther === "Waiting to run.", `a revived run whose reason the pane has no words for is waiting, got ${revivedOther}`);
	assert(formatFriendlyRunReason({ status: "cancelled", reason: "lease_expired", message: "x" }) === "Did not run.", "a cancelled run did not run");
}

// Nothing ever locks Maintain (decision 14): a room open in another window, or answering there, can still be maintained.
{
	// A page component (.tsx): loaded at run time, as the server build compiles scripts without JSX.
	const { roomCanMaintain } = await import(new URL("../../web-ui/src/components/launcher-room-card.tsx", import.meta.url).href) as any;
	const ready = { id: "r", exists: true, status: "ready", memoryStatus: { recentContextCount: 3, lastMemoryWriteAt: "2026-10-09T10:00:00.000Z" } };
	assert(roomCanMaintain({ ...ready, activeLock: { surface: "web" }, activeThread: { working: true } }), "a room open and answering elsewhere can be maintained");
	assert(roomCanMaintain({ ...ready, activeLock: { surface: "scheduler" } }), "a room a scheduled task holds can be maintained");
	assert(!roomCanMaintain({ ...ready, memoryStatus: { recentContextCount: 0, lastMemoryWriteAt: null } }) && !roomCanMaintain(ready, true), "only nothing to maintain or a delete in progress closes it");
}

// A first read is the model's words about the notes: the person reads them with no must-keep marker and with the
// app's dates, in Memorize's first read and Review's.
{
	const { plainFirstReadLine } = await import("../../web-ui/src/memory-v2-copy.js") as any;
	assert(plainFirstReadLine("Must-keep: Fernando is vegetarian (saved 2026-10-11).") === "Fernando is vegetarian (saved 11 Oct).", `got ${plainFirstReadLine("Must-keep: Fernando is vegetarian (saved 2026-10-11).")}`);
	assert(plainFirstReadLine("From the 2026-10-02 \u201cTravel plan for Lisbon\u201d conversation: **must-keep:** the hotel is booked.") === "From the 2 Oct \u201cTravel plan for Lisbon\u201d conversation: the hotel is booked.", `got ${plainFirstReadLine("From the 2026-10-02 \u201cTravel plan for Lisbon\u201d conversation: **must-keep:** the hotel is booked.")}`);
	const app = fs.readFileSync(new URL("../../web-ui/src/App.tsx", import.meta.url), "utf8");
	const review = fs.readFileSync(new URL("../../web-ui/src/components/review-screen.tsx", import.meta.url), "utf8");
	// An entry that asks to be generated again cannot be saved: Generate again leads, and Save to memory is not offered.
	const entryApp = fs.readFileSync(new URL("../../web-ui/src/App.tsx", import.meta.url), "utf8");
	assert(/: !mustGenerateAgain && <button className="rs-btn rs-btn-primary"[^\n]{0,160}?>\{approvalLoading \? "Saving…" : "Save to memory"\}/.test(entryApp) && /generateAgain && <button className=\{mustGenerateAgain \? "rs-btn rs-btn-primary" : "rs-btn"\} disabled=\{approvalLoading\} onClick=\{onGenerate\}>Generate again/.test(entryApp) && /const mustGenerateAgain = generateAgain && \/changed after Remember read it\|The Memory model changed after this entry was written\//.test(entryApp), "Generate again leads where the conversation or the Memory model changed after the read");
	// Nothing can be saved there, so no Edit either: an editor left open closes, and the edits stay on the entry for Generate again to ask about.
	assert(/\{!readOnly && !editing && !mustGenerateAgain && <button className="rs-btn" disabled=\{approvalLoading\} onClick=\{\(\) => setEditing\(true\)\}/.test(entryApp) && /useEffect\(\(\) => \{\s*if \(mustGenerateAgain\) setEditing\(false\);\s*\}, \[mustGenerateAgain\]\);/.test(entryApp), "no Edit where nothing can be saved");
	// Memorize's rows date a conversation as the first read does ("15 Sep"), never as stored.
	const runScreen = fs.readFileSync(new URL("../../web-ui/src/components/absorb-run-screen.tsx", import.meta.url), "utf8");
	assert(!runScreen.includes(": session.date}") && (runScreen.match(/: fmtMemoryDay\(session\.date\)\}/g) ?? []).length === 2, "both row layouts show the day in the app's form");
	// The memory file's section names never show: a first read uses the app's words for them.
	const sectionLine = plainFirstReadLine("Nordwind contract: the floor price also appears under Active Items. Active Items: \"Get to know Sam\" has no date; Deep Memory and Recent Context repeat it.");
	assert(sectionLine === "Nordwind contract: the floor price also appears under Open items. Open items: \"Get to know Sam\" has no date; Notes and Waiting conversations repeat it.", `got ${sectionLine}`);
	assert(/items=\{fields\.whatToRemember\.map\(plainFirstReadLine\)\}/.test(app) && /function ReadSection[\s\S]{0,400}plainFirstReadLine/.test(review), "both first reads show their lines plainly");
}

// In Room settings the budget refusal points at the Model pane above, not at Room settings.
{
	const { roomSettingsBudgetRefusal } = await import("../../web-ui/src/memory-v2-copy.js") as any;
	const refused = "A memory budget of 20k needs a larger Memory model than Team Small 32k. Choose one in Room settings, Model first.";
	assert(roomSettingsBudgetRefusal(refused) === "A memory budget of 20k needs a larger Memory model than Team Small 32k. Choose a larger Memory model in Model first.", `got ${roomSettingsBudgetRefusal(refused)}`);
	const section = fs.readFileSync(new URL("../../web-ui/src/components/RoomMaintenanceSection.tsx", import.meta.url), "utf8");
	assert((section.match(/text: roomSettingsBudgetRefusal\(/g) ?? []).length === 2, "the Memory pane shows the refusal in its own words, at a save and when it asks again after the Memory model changes");
}

// A note shows its lines as written: a line that starts with a point marker is a point, every other line a plain line, a blank line a gap; the first line is the note's own and always plain.
{
	const { noteBlocks } = await import("../../web-ui/src/memory-v2-copy.js") as any;
	const blocks = (text: string) => JSON.stringify(typeof noteBlocks === "function" ? noteBlocks(text) : null);
	const want = (text: string, expected: unknown, what: string) => assert(blocks(text) === JSON.stringify(expected), `${what} (got ${blocks(text)})`);
	want("Cueta is wrogly pronnounced\n#Plan\nPizza\nremind me in May", [{ line: "Cueta is wrogly pronnounced" }, { line: "#Plan" }, { line: "Pizza" }, { line: "remind me in May" }], "four typed lines show as four plain lines, none a point");
	want("Budget review\n- a\n- b", [{ line: "Budget review" }, { points: ["a", "b"] }], "a first line and two points show the line plain and the points as one list");
	want("- Nordwind pricing\n  - The rate holds.\n  - **must-keep:** Renewal in April.", [{ line: "Nordwind pricing" }, { points: ["The rate holds.", "Renewal in April."] }], "a Memorize note keeps its first line plain and its points as a list");
	want("First\n\n\nSecond\n* one\nThird\n+ two\n\u2022 three", [{ line: "First" }, { gap: true }, { line: "Second" }, { points: ["one"] }, { line: "Third" }, { points: ["two", "three"] }], "blank lines show as one gap, and each run of points is its own list");
	want("-dash without a space\n  indented line", [{ line: "-dash without a space" }, { line: "indented line" }], "a dash with no space after it is not a point");
	const entries = fs.readFileSync(new URL("../../web-ui/src/components/room-memory-entries.tsx", import.meta.url), "utf8");
	assert(!entries.includes('<p className="memory-entry-text">{entry.text}</p>') && (entries.match(/<NoteText text=\{entry\.text\} \/>/g) ?? []).length === 2, "both lists show a note through its lines");
}

// Scheduled tasks speak the app's dates and clock: "11 Oct, 17:18", never the browser's "10/11/2026, 5:18:23 PM".
{
	const presets = await import("../../web-ui/src/persistent-room-schedule-presets.js") as any;
	const at = new Date(2026, 9, 11, 17, 18);
	const later = new Date(2026, 9, 20, 9, 5);
	assert(presets.formatFriendlyWhenForJob({ type: "once", schedule: later.toISOString() }, at) === "Once on 20 Oct at 09:05.", `got ${presets.formatFriendlyWhenForJob({ type: "once", schedule: later.toISOString() }, at)}`);
	assert(presets.formatNativeTimeSummary("17:18") === "17:18", `got ${presets.formatNativeTimeSummary("17:18")}`);
	const pane = fs.readFileSync(new URL("../../web-ui/src/components/RoomScheduledTasksSection.tsx", import.meta.url), "utf8");
	assert(!pane.includes("toLocaleString()") && pane.includes("fmtMemoryMoment("), "the pane's timestamps are the app's");
	// A task that only waits (decision 47) reads as a wait in the pane's neutral tone, never as a red block.
	const { runShownStatus } = await import("../../web-ui/src/scheduled-run-reason.js") as { runShownStatus: (run: unknown) => string };
	for (const reason of ["prepared_runtime_boundary", "room_in_use", "active_turn_in_flight"]) assert(runShownStatus({ status: "blocked", reason }) === "deferred", `a run blocked for ${reason} only waits`);
	assert(runShownStatus({ status: "blocked", reason: "model_not_found" }) === "blocked" && runShownStatus({ status: "blocked", reason: "prepared_conversation_ended" }) === "blocked", "a run that cannot go on stays blocked");
	assert(!/formatRunStatus\((?:latestRun|run)\.status\)|status-\$\{run\.status\}/.test(pane) && /case "deferred": return \{ label: "Waiting", tone: "default" \}/.test(pane), "every status in the pane is the shown one, and a wait is neutral");
	const css = fs.readFileSync(new URL("../../web-ui/src/styles.css", import.meta.url), "utf8");
	assert(!/\.room-schedules-run-status\.status-deferred[^{]*\{[^}]*--warning/.test(css), "a waiting run's chip is neutral");
	// A completed one-time task is no longer enabled in the summary's count.
	assert(/enabledCount=\{activeScheduleRows\.filter\(\(\{ job \}\) => job\.enabled\)\.length\}/.test(pane) && /\$\{enabledCount\} enabled/.test(pane), "the summary counts only the schedules still to run as enabled");
}

// A Review archive line is judged by the note it names first: a second id in its reason is not what it asked to archive.
{
	const { reviewRemovalsNotDone } = await import("../src/review-guidance.js");
	const line = "\"Set up a shared calendar\" [m-0009], its content is already in [m-0010]";
	assert(reviewRemovalsNotDone([line], [], [{ id: "m-0010", open: true }]).length === 0, "the first id was archived: the line is done");
	assert(reviewRemovalsNotDone([line], [], [{ id: "m-0009", open: true }, { id: "m-0010", open: true }]).length === 1, "the first id stays: the line is not done");
}

// The heading of a saved entry says CLOSED when Still open is empty, as an empty field now is when nothing is open; the server builds it from the parts.
{
	const { rememberPageFromParts } = await import("../src/memory-typed-text.js");
	const heading = "### RC-DRAFT | OPEN | 2026-10-13 | The plan";
	const first = (parked: string) => rememberPageFromParts(heading, { sessionArc: "", body: "- The plan holds.", parked }).split("\n")[0];
	assert(first("") === "### RC-DRAFT | CLOSED | 2026-10-13 | The plan" && first("None.") === "### RC-DRAFT | CLOSED | 2026-10-13 | The plan", "an empty Still open reads CLOSED in the heading");
	assert(first("- The fee is unpaid.") === "### RC-DRAFT | OPEN | 2026-10-13 | The plan", "a Still open with words reads OPEN");
}

// The Remember options form's Discard is hidden on a read-only device, as the entry view's is.
{
	const app = fs.readFileSync(new URL("../../web-ui/src/App.tsx", import.meta.url), "utf8");
	assert(app.includes('{!readOnly && asksGenerateAgain(error) && <button className="rs-btn" onClick={onDiscard}'), "a read-only device gets no Discard on the options form");
}

// The discussion counter says the messages; the characters only once they near their limit.
{
	const app = fs.readFileSync(new URL("../../web-ui/src/App.tsx", import.meta.url), "utf8");
	assert(!app.includes("{messages.length} of {DISCUSSION_MAX_MESSAGES} messages · {compactCount(transcriptChars)}") && app.includes("transcriptChars >= DISCUSSION_MAX_TRANSCRIPT_CHARS * 0.75 ? ` · ${compactCount(transcriptChars)} of"), "the counter keeps only what the person can act on");
}

// Review's saved page says only the plain outcome: the sign-off's and the save's own notes ("no memory has been
// written") are engine notes, untrue after a save.
{
	const app = fs.readFileSync(new URL("../../web-ui/src/App.tsx", import.meta.url), "utf8");
	const saved = app.slice(app.indexOf("<ReviewSavedScreen"), app.indexOf("/>", app.indexOf("<ReviewSavedScreen")));
	assert(saved.includes("warnings={") && !saved.includes("signoffWarnings") && !saved.includes("approvalResult.warnings"), "Review's saved page shows no engine notes");
}

// After a restart, a card's work is on the card until Save; the Remember dialog reads "Remembering…".
{
	const copySource = fs.readFileSync(new URL("../../web-ui/src/memory-v2-copy.ts", import.meta.url), "utf8");
	const reviewSource = fs.readFileSync(new URL("../../web-ui/src/components/review-screen.tsx", import.meta.url), "utf8");
	const appSource = fs.readFileSync(new URL("../../web-ui/src/App.tsx", import.meta.url), "utf8");
	assert(copySource.includes('"The app restarted. Finished conversations are on this card. Save keeps them."') && !copySource.includes("Finished conversations are kept."), "Memorize's restart line says Save keeps them");
	assert(reviewSource.includes('`The app restarted. ${nothingTidied ? "Nothing was lost." : "What was tidied is on this card; the rest is unchanged."}`') && !reviewSource.includes("What was tidied is kept;"), "Review's restart line says the tidy is on the card");
	assert(appSource.includes('"Remembering…"') && !appSource.includes("Drafting memory proposal"), "the dialog's heading has no engine word");
}

// No older engine words in Maintain's failure lines (decision 44).
{
	const appSource = fs.readFileSync(new URL("../../web-ui/src/App.tsx", import.meta.url), "utf8");
	for (const words of ["shrink stable memory", "your assessment is untouched", "Restart Maintain", "start Maintain again", "this workflow was open"]) assert(!appSource.includes(words), `the page no longer says "${words}"`);
}

// A Memorize or Review that cannot start on its Memory model (signed out, too small) shows the one notice with its ways out.
{
	const app = fs.readFileSync(new URL("../../web-ui/src/App.tsx", import.meta.url), "utf8");
	assert(/const notice = modelNoticeFromError\(e\);\n\t\t\tsetAbsorbWorkflow\(\{ step: "error", target, availability: null, assessment: null, approvalResult: null, notice, error: notice \? null : formatAbsorbWorkflowError/.test(app), "Memorize's start asks for the notice");
	assert(/const notice = modelNoticeFromError\(e\);\n\t\t\tsetReviewWorkflow\(\{ \.\.\.CLOSED_REVIEW_WORKFLOW, step: "error", target, notice, error: notice \? null : formatReviewWorkflowError/.test(app), "Review's start asks for the notice");
	assert((app.match(/\{state\.notice && <ModelNoticePanel notice=\{state\.notice\} onTryAgain=\{onRestart\} onChooseModel=\{onChooseModel\} onSignIn=\{\(provider\) => onSignIn\(provider \?\? ""\)\} \/>\}/g) ?? []).length === 2, "both error steps show it");
}

// A start Memorize or Review refuses keeps the server's code, so the room shows its one notice with the ways out.
{
	const { ApiRequestError } = await import("../../web-ui/src/api.js");
	const { startAbsorbRun } = await import("../../web-ui/src/absorb-run-api.js");
	const { startReviewRun } = await import("../../web-ui/src/review-api.js");
	const realFetch = globalThis.fetch;
	globalThis.fetch = (async () => new Response(JSON.stringify({ error: "Team Small 32k cannot read all of this room's memory at once.", code: "memory_model_too_small" }), { status: 409, headers: { "content-type": "application/json" } })) as typeof fetch;
	try {
		for (const [name, start] of [["Memorize", () => startAbsorbRun("room-a" as any, "assessment")], ["Review", () => startReviewRun("room-a" as any, { depth: "wording" } as any)]] as const) {
			const refused = await start().then(() => null, (error: unknown) => error);
			assert(refused instanceof ApiRequestError && refused.code === "memory_model_too_small" && refused.status === 409, `${name}'s start keeps the server's code, got ${refused instanceof Error ? `${refused.constructor.name} ${(refused as any).code}` : String(refused)}`);
		}
	} finally {
		globalThis.fetch = realFetch;
	}
}

// Memorize's own screens say the same as Review's, and nothing false.
{
	const copy = await import("../../web-ui/src/memory-v2-copy.js") as any;
	const names = await import("../../web-ui/src/model-names.js") as any;
	const stopped = { provider: "openai-compatible", model: "gpt-5.5" };
	// The paused card names the model alone, as Review's card and the first read's notice do.
	const named = copy.absorbRunOutageModelName(stopped, { ...stopped, label: "Test Model" });
	assert(named === names.modelDisplayName({ ...stopped, modelLabel: "Test Model" }) && !named.includes("("), `Memorize's paused card names the model alone (got: ${named})`);
	// A restart before any conversation was read, with something still to save: the notice's own line, nothing was lost, and Continue reads them.
	const restarted = copy.absorbRunOutageSentence("Test Model", "restarted", 2, undefined, undefined, undefined, undefined, undefined, true);
	assert(restarted === "The app restarted. Nothing was lost. Continue reads the 2 waiting conversations.", `a restart with nothing read says nothing was lost (got: ${restarted})`);
	assert(copy.absorbRunOutageSentence("Test Model", "restarted", 1, undefined, undefined, undefined, undefined, undefined, true) === "The app restarted. Nothing was lost. Continue reads the waiting conversation.", "one waiting conversation, in the singular");
	assert(copy.absorbRunOutageSentence("Test Model", "restarted", 1).startsWith("The app restarted. Finished conversations are on this card."), "a restart after some reading keeps its line");
	assert(copy.absorbRunOutageSentence("Test Model", "not-answering", 2, undefined, undefined, undefined, undefined, undefined, true) === "Memorize paused because Test Model isn't answering right now. 2 conversations are still waiting.", "nothing read but something to save: the notice says it paused");
	// The paused card, with nothing to save: its headline says "Memorize paused.", so the line is the cause alone, and after a restart Review's words.
	assert(copy.absorbRunPausedSentence?.("Test Model", "restarted") === "The app restarted. Nothing was lost.", `the paused card after a restart, as Review's (got: ${copy.absorbRunPausedSentence?.("Test Model", "restarted")})`);
	const alone = (cause: string, extra: { key?: string; unreached?: string; quotaWay?: unknown; gateway?: string } = {}) => copy.absorbRunPausedSentence?.("Test Model", cause, "test-gateway", extra.key, extra.unreached, extra.quotaWay, extra.gateway);
	assert(alone("not-answering") === "Test Model isn't answering right now. Nothing was lost.", `nothing read: the cause alone (got: ${alone("not-answering")})`);
	assert(alone("not-answering", { unreached: "connection" }) === "Test Model could not be reached. Nothing was lost. Check your internet connection, then try again.", `nothing read, offline: the cause and its way on (got: ${alone("not-answering", { unreached: "connection" })})`);
	assert(alone("signed-out", { key: "refused", gateway: "Test Gateway" }) === "Test Gateway did not accept the saved key. Nothing was lost.", `nothing read, a refused key: the gateway's state alone (got: ${alone("signed-out", { key: "refused", gateway: "Test Gateway" })})`);
	assert(alone("quota", { quotaWay: { kind: "gateway", provider: "Test Gateway" }, gateway: "Test Gateway" }) === "Test Model has reached its usage limit or run out of credit. Nothing was lost. Ask whoever runs Test Gateway about the limit.", `nothing read, a spent quota: the cause and its way on (got: ${alone("quota", { quotaWay: { kind: "gateway", provider: "Test Gateway" }, gateway: "Test Gateway" })})`);
	assert(copy.absorbRunOutageSentence("Test Model", "not-answering", 2) === "Memorize paused because Test Model isn't answering right now. 2 conversations are still waiting.", "with something read no headline says it paused, so the line does");
	// No conversation became a note: the headline does not say the room memorized them.
	const nothingNew = { foldedSessions: ["RC-0001", "RC-0002"], notedSessions: 0, nothingToKeep: 2 };
	assert(copy.absorbRunSavedHeadline(nothingNew, "Offsite Planning") === "Nothing new for Offsite Planning to remember", `no new note, no "memorized" (got: ${copy.absorbRunSavedHeadline(nothingNew, "Offsite Planning")})`);
	assert(!copy.absorbRunSavedSentence(nothingNew).includes("0 conversations"), `the sentence counts no zero (got: ${copy.absorbRunSavedSentence(nothingNew)})`);
	assert(copy.absorbRunSavedHeadline({ foldedSessions: ["RC-0001", "RC-0002"], notedSessions: 1, nothingToKeep: 1 }, "Offsite Planning") === "Offsite Planning memorized 2 conversations", "a save that kept notes reads as before");

	const app = fs.readFileSync(path.join(process.cwd(), "apps", "web-ui", "src", "App.tsx"), "utf8");
	const memorizeShell = app.slice(app.indexOf("function AbsorbWorkflowShell"), app.indexOf("// Shared discussion surface"));
	// A paused card with nothing to save changes nothing, so no step line names a change above it, as on Review's.
	assert(/state\.step === "run_card" && state\.run\?\.stop && absorbRunNothingToSave\(state\.run\) \? null : `Step 2 of 2 · what \$\{targetLabel\} will keep`/.test(memorizeShell) && memorizeShell.includes("{stepLine && <p>{stepLine}</p>}"), "a paused Memorize card with nothing to save has no step line above it");
	// Its Cancel asks nothing, as Review's Close on such a card: there is nothing to lose.
	assert(/function confirmCancelAbsorbRun\(\): void \{\s*const run = absorbWorkflow\.run;\s*if \(absorbWorkflow\.step === "run_card" && run\?\.stop && absorbRunNothingToSave\(run\)\) return void absorbRunBackToAssessment\(\);/.test(app), "Cancel on a paused card with nothing to save asks nothing");
	// The waiting list under the notice dates its conversations as the card does.
	assert(/<span className="absorb-run-session-date">\{fmtMemoryDay\(conversation\.date\)\}<\/span>/.test(memorizeShell), "the waiting list uses the card's date form");
	// A notes-only Memorize names no "0 conversations".
	assert(!/What these \$\{assessment\.availability\.recentContextEntryCount\} conversations hold/.test(memorizeShell) || /recentContextEntryCount === 0/.test(memorizeShell.slice(memorizeShell.indexOf("<h2>{assessment.availability"), memorizeShell.indexOf("<h2>{assessment.availability") + 300)), "a first read with no conversation names no zero");
	// Undo on Memorize's saved screen, as on Review's.
	const savedBlock = memorizeShell.slice(memorizeShell.indexOf('state.step === "saved" && state.approvalResult && state.run'), memorizeShell.indexOf('state.step === "error"', memorizeShell.indexOf('state.step === "saved" && state.approvalResult && state.run')));
	assert(/onClick=\{onUndo\}/.test(savedBlock) && app.includes("function undoAbsorbSave()") && /undoMemorySave\(target\.agentId, saveId\)/.test(app.slice(app.indexOf("async function performAbsorbUndo"))), "Memorize's saved screen offers Undo through the same undo route");
	assert(savedBlock.includes("{!state.undo?.done && (absorbRunNotesChanged(state.run) > 0 || (state.approvalResult.archivedEntries ?? 0) > 0 || absorbRunSortedRows(state.run).length > 0) && <button"), "a save that only sorted notes into topics offers Undo too");
	// The Discuss first titles agree with the leave confirm: the discussion is kept, and never saved to memory.
	assert(!app.includes("the discussion itself is not saved") && !app.includes("The discussion itself is not saved."), "neither Discuss first title says the discussion is not kept");
	assert(app.includes('title="Talk the first read through before anything is tidied. The discussion is not saved to memory.">Discuss first</button>'), "Review's Discuss first title says what Memorize's says");
	assert(!app.includes("what you wrote here stays available from the update"), "no line promises the discussion stays once the update runs");
	// Read again reads again: both screens ask the server for a fresh read.
	const reviewApi = fs.readFileSync(path.join(process.cwd(), "apps", "web-ui", "src", "review-api.ts"), "utf8");
	assert(/fresh: true/.test(reviewApi.slice(reviewApi.indexOf("export function requestFirstRead"), reviewApi.indexOf("export function cancelFirstReadAt"))), "Read again asks for a fresh read, on both screens");
	// Only Cancel ends a first read: every ask carries its own id, and leaving Maintain or a newer read cancels it on the server.
	assert((app.match(/askFirstRead\(target\.agentId, "memorize", \(first\) => requestFirstRead<AbsorbAssessmentResponse>\(absorbBaseUrl\(target\.agentId\), |askFirstRead\(target\.agentId, "review", \(first\) => requestFirstRead<ReviewAssessmentResponse>\(reviewBase\(target\.agentId\), /g) ?? []).length === 4 && !/firstReadSignal|firstReadAbortRef/.test(app), "every first read is asked with its own id");
	assert((app.match(/maintainRunRef\.current \+= 1;\n\t\tcancelFirstRead\(\);/g) ?? []).length === 2 && app.includes("void cancelFirstReadAt((current.kind === \"review\" ? reviewBase : absorbBaseUrl)(current.agentId), current.ask).catch(() => {});"), "leaving Maintain cancels the first read on the server");
	assert(reviewApi.slice(reviewApi.indexOf("export function cancelFirstReadAt")).includes("body: JSON.stringify({ ask, cancel: true }),"), "Cancel names the ask it ends, on both screens");
	// A missing read is never kept, so its Read again joins a read a dropped request left running instead of paying for another.
	assert((app.match(/\.\.\.\(prior\.firstReadMissing \? \{\} : \{ fresh: true \}\), \.\.\.first/g) ?? []).length === 2, "Read again on a missing first read joins a read still being made");
	// A request cut off without an answer keeps its ask: Read again joins under it, and leaving or going on to the run still cancels it.
	assert(app.includes("firstReadRef.current = isUnexplainedRequestFailure(error) ? { ...current, cut: true } : null;") && app.includes("ask: cut?.ask ??") && app.includes("if (!cut) cancelFirstRead();"), "a cut request's ask is kept for Read again and for Cancel");
	assert((app.match(/const run = maintainRunRef\.current;\n\t\tcancelFirstRead\(\);/g) ?? []).length === 4, "going on to the run, on both screens, cancels a first read a cut request left running");
	// Stop or Back on a run opened because it was waiting asks for the first read, not "No first read this time".
	const back = app.slice(app.indexOf("async function absorbRunBackToAssessment"), app.indexOf("async function resumeAbsorbRunAfterStop"));
	assert(/openedWaiting/.test(back) && /startAbsorbWorkflow\(\{ target, readFirst: true \}\)/.test(back) && !/discuss: true/.test(back), "Stop or Back on a waiting run reads the conversations first and shows that read, not the discussion");
	// A room that saves on its own skipped the first read: Stop or Back reads it then, never "No first read this time".
	assert(back.includes('(absorbWorkflow.openedWaiting || absorbWorkflow.assessment?.firstReadMissing === "skipped")'), "Stop or Back on a run whose first read was skipped reads the conversations first");
	assert(app.includes("if ((fastPathEnabled && !options?.discuss && !options?.readFirst) || availability.recentContextEntryCount === 0) {"), "the read asked for after Stop or Back is shown even in a room that saves on its own");
	assert(app.includes('{assessment.firstReadMissing && assessment.firstReadMissing !== "skipped" && !unreachableRead && <button className="rs-btn" onClick={onChooseModel}>{ABSORB_CHOOSE_MODEL_LABEL}</button>}'), "Memorize's missing read offers another model where one can help, as Review's does");
	const reviewBack = app.slice(app.indexOf("async function reviewRunBackToAssessment"), app.indexOf("/** A tidy with nothing to save is dropped without a confirm"));
	assert(/openedWaiting/.test(reviewBack) && /startPruneMemoryWorkflow\(target\)/.test(reviewBack) && /status\.waitingRunId\) return beginReviewRunWatch\(\{ \.\.\.CLOSED_REVIEW_WORKFLOW, step: "assessment", target, openedWaiting: true,/.test(app), "Stop or Back on Review's waiting run reads the notes first, as Memorize does");

	// The card: no "From 2 conversations. Read it…" over nothing read, no "New in memory" over rows with nothing to keep.
	const pageRequire = (await import("node:module")).createRequire(new URL("../../web-ui/package.json", import.meta.url));
	const { createElement } = pageRequire("react");
	(globalThis as any).React = pageRequire("react");
	const { renderToStaticMarkup } = pageRequire("react-dom/server");
	const screen: any = await import(new URL("../../web-ui/src/components/absorb-run-screen.tsx", import.meta.url).href);
	const noop = () => {};
	const card = (absorb: AbsorbRun) => renderToStaticMarkup(createElement(screen.AbsorbRunCard, { run: absorb, roomName: "Offsite Planning", keepIds: [], busy: false, error: null, onToggleKeep: noop, onToggleKeepTopic: noop, onRaiseBudget: noop, onApprove: noop, onCancel: noop, onBackToAssessment: noop, onResume: noop, onChooseModel: noop, onSignIn: noop })) as string;
	const buttons = (html: string) => [...html.matchAll(/<button[^>]*>([^<]*)<\/button>/g)].map((match) => match[1]);
	const rowButtons = (html: string) => buttons(html.slice(html.lastIndexOf("checkpoint-preview-actions")));
	const waitingRows = [session({ id: "RC-0001", outcome: "pending" as any, summary: undefined }), session({ id: "RC-0002", outcome: "pending" as any, summary: undefined })];
	const notRead = card(run({ progress: { folded: 0, total: 2 }, sessions: waitingRows, stop: { kind: "restart", model: stopped, cause: "restarted" } as any }));
	assert(!notRead.includes("From 2 conversations.") && notRead.includes('<h2>Memorize paused.</h2><p role="status">The app restarted. Nothing was lost.</p>'), `nothing read after a restart: Review's words under "Memorize paused.", announced (got: ${notRead.slice(0, 900)})`);
	assert(rowButtons(notRead).join("|") === "Cancel|Continue" && /rs-btn rs-btn-primary"[^>]*>Continue</.test(notRead) && !notRead.includes("absorb-run-stop-note"), `after a restart one row: Cancel, then Continue as the main button (got: ${buttons(notRead).join("|")})`);
	// Paused with nothing read: Review's paused card, word for word but its name.
	const pausedCard = card(run({ progress: { folded: 0, total: 2 }, sessions: waitingRows, stop: { kind: "outage", model: stopped, cause: "not-answering" } as any }));
	assert(pausedCard.includes('<h2>Memorize paused.</h2><p role="status">GPT-5.5 isn&#x27;t answering right now. Nothing was lost.</p>') && !pausedCard.includes("will keep") && !pausedCard.includes("Memorize paused because"), `the paused card: its headline, then the cause alone, announced (got: ${pausedCard.slice(0, 900)})`);
	assert(pausedCard.includes('Nothing was lost.</p></div><div class="absorb-review-strip">') && pausedCard.includes("0 of 2 read"), `the chips follow the sentence, as on Review's card (got: ${pausedCard.slice(0, 900)})`);
	assert(!pausedCard.includes("New in memory") && !pausedCard.includes("No conversation was read yet.") && !pausedCard.includes("absorb-run-stop-note"), `no empty block and no notice box (got: ${pausedCard.slice(0, 1200)})`);
	assert(buttons(pausedCard).join("|") === "Cancel|Choose another model|Try again" && /rs-btn rs-btn-primary"[^>]*>Try again</.test(pausedCard) && (pausedCard.match(/rs-btn-primary/g) ?? []).length === 1, `one row: Cancel, Choose another model, Try again as the main button, and no Back or Save (got: ${buttons(pausedCard).join("|")})`);
	const signedOutCard = card(run({ progress: { folded: 0, total: 2 }, sessions: waitingRows, stop: { kind: "outage", model: stopped, cause: "signed-out", key: "refused", gateway: "Test Gateway" } as any }));
	assert(signedOutCard.includes('<h2>Memorize paused.</h2><p role="status">Test Gateway did not accept the saved key. Nothing was lost.</p>') && buttons(signedOutCard).join("|") === "Cancel|Replace key|Choose another model" && /rs-btn rs-btn-primary"[^>]*>Replace key</.test(signedOutCard) && (signedOutCard.match(/rs-btn-primary/g) ?? []).length === 1, `a refused key: the key's button leads, as on Review's card (got: ${buttons(signedOutCard).join("|")})`);
	const sureToFail = card(run({ progress: { folded: 0, total: 2 }, sessions: waitingRows, stop: { kind: "outage", model: stopped, cause: "not-on-account" } as any }));
	assert(buttons(sureToFail).join("|") === "Cancel|Choose another model", `no Try again where it is sure to fail, as on Review's card (got: ${buttons(sureToFail).join("|")})`);
	// With no Try again and no sign-in way, another model is the way on, so it leads.
	assert(/rs-btn rs-btn-primary"[^>]*>Choose another model</.test(sureToFail), `where Try again is sure to fail, Choose another model is the main button (got: ${sureToFail.slice(sureToFail.lastIndexOf("checkpoint-preview-actions"))})`);
	// Paused with nothing read but something to save: the card as it was before the paused card, its notice saying it paused, and Save.
	const leftOut = card(run({ progress: { folded: 0, total: 2 }, sessions: [session({ id: "RC-0001", outcome: "skipped" as any, summary: undefined }), waitingRows[1]], stop: { kind: "outage", model: stopped, cause: "not-answering" } as any }));
	assert(leftOut.includes("<h2>What Offsite Planning will keep</h2>") && !leftOut.includes("Memorize paused.</h2>") && leftOut.includes("absorb-run-stop-note") && leftOut.includes("Memorize paused because GPT-5.5 isn&#x27;t answering right now. 1 conversation is still waiting.") && rowButtons(leftOut).join("|") === "Cancel|Back|Save to memory", `paused with a conversation left out: the card's own headline, the notice that says it paused, and Save (got: ${leftOut.slice(0, 1200)})`);
	const leaving = card(run({ progress: { folded: 0, total: 2 }, sessions: waitingRows, demotion: demotion([row(), row({ id: "m-2" })]), stop: { kind: "outage", model: stopped, cause: "not-answering" } as any }));
	assert(leaving.includes("<h2>What Offsite Planning will keep</h2>") && leaving.includes("Memorize paused because GPT-5.5 isn&#x27;t answering right now. 2 conversations are still waiting.") && leaving.includes("<h3>New in memory</h3>") && leaving.includes("No conversation was read yet.") && rowButtons(leaving).join("|") === "Cancel|Back|Save to memory", `paused with notes leaving for the budget: the card as before (got: ${leaving.slice(0, 1400)})`);
	const restartLeftOut = card(run({ progress: { folded: 0, total: 2 }, sessions: [session({ id: "RC-0001", outcome: "skipped" as any, summary: undefined }), waitingRows[1]], stop: { kind: "restart", model: stopped, cause: "restarted" } as any }));
	assert(restartLeftOut.includes("<h2>What Offsite Planning will keep</h2>") && restartLeftOut.includes("The app restarted. Nothing was lost. Continue reads the waiting conversation.") && rowButtons(restartLeftOut).join("|") === "Cancel|Back|Save to memory", `a restart with something to save: the card as before (got: ${restartLeftOut.slice(0, 1200)})`);
	// Something read: no paused headline, so the notice keeps its "Memorize paused because".
	const partRead = card(run({ progress: { folded: 1, total: 2 }, sessions: [session(), waitingRows[1]], stop: { kind: "outage", model: stopped, cause: "not-answering" } as any }));
	assert(partRead.includes("<h2>What Offsite Planning will keep</h2>") && partRead.includes("Memorize paused because GPT-5.5 isn&#x27;t answering right now. 1 conversation is still waiting."), `something read: the card's own headline, and the notice says it paused (got: ${partRead.slice(0, 900)})`);
	const nothingKept = card(run({ progress: { folded: 2, total: 2 }, sessions: [session({ id: "RC-0001", outcome: "dropped", reason: "small talk", summary: undefined }), session({ id: "RC-0002", outcome: "dropped", reason: "small talk", summary: undefined })] }));
	assert(!nothingKept.includes("<h3>New in memory</h3>") && nothingKept.includes("Nothing to keep"), `rows that all kept nothing sit under no "New in memory" (got: ${nothingKept.slice(0, 900)})`);
	const notesOnly = card(run({ progress: { folded: 0, total: 0 }, sessions: [] }));
	assert(!notesOnly.includes("From 0 conversations"), "a notes-only card names no zero");
	// A run that only sorted notes out of Unsorted offers Save, which saves the sort.
	const sortOnlyCard = card(run({ progress: { folded: 0, total: 0 }, sessions: [], sorted: [{ id: "m-0101", text: "- Invoices go out on the first.", topic: "Invoicing" }] }));
	const sortOnlySave = /<button class="rs-btn rs-btn-primary"[^>]*>Save[^<]*<\/button>/.exec(sortOnlyCard)?.[0] ?? "";
	assert(sortOnlySave && !sortOnlySave.includes("disabled"), `a sort-only card's Save is on (got: ${sortOnlySave || sortOnlyCard.slice(-600)})`);
	// Not on the account: Try again would meet the same refusal, so the paused card offers the way that works.
	const notOnAccount = card(run({ progress: { folded: 1, total: 2 }, sessions: [session(), waitingRows[1]], stop: { kind: "outage", model: stopped, cause: "not-on-account" } as any }));
	assert(notOnAccount.includes("absorb-run-stop-note") && !notOnAccount.includes(">Try again<") && notOnAccount.includes(">Choose another model<"), `not on the account: no Try again on the paused Memorize card (got: ${notOnAccount.slice(0, 1200)})`);
}

console.log("memory v2 copy smoke passed: the run card, the limit bar, the automatic-maintenance gate, the Review sentences, and the words both memory surfaces speak");
