// Smoke for the Memorize v2 client copy and gate (apps/web-ui/src/memory-v2-copy.ts).
// Two things are pinned here because a browser would be a poor place to find
// them broken: the sentences a person reads on the run card (they carry the
// server's numbers, and a wrong one misstates what approving does), and the
// automatic-maintenance gate, which decides whether memory is written without
// a second look. The gate must block on anything a person would want to weigh:
// an archived entry, a budget crossing, an unfinished session, a warning.

import { absorbRunFailedSessionNote, absorbRunFastPathBlockers, absorbRunGuidanceSummary, absorbRunIsWorking, absorbRunMigrationSentence, absorbRunNewTopics, absorbRunProgressLine, absorbRunSavedSentence, absorbRunScreen, absorbRunSessionLine, ARCHIVE_EXPLANATION, ARCHIVE_ROW_TAG_INSTEAD, ARCHIVE_ROW_TAG_STAYS, archiveCountsLine, archiveHeading, archiveLimitSummary, archivedDuplicateReason, archiveReasonLabel, archiveRowTag, archiveTopicGroupSummary, archiveTopicKey, AUTOMATIC_APPLY_ON_SENTENCE, AUTOMATIC_APPLY_SETTING_LABEL, automaticApplyNeedsReviewSentence, entryFirstLine, entryGroupPage, entryOriginSentence, filterEntriesByText, fmtTokenCount, fmtTokenLimit, groupEntriesByTopic, isEntryIdMigrationNotice, KEEP_DEBOUNCE_MS, KEEP_TOPIC_LABEL, keepBatchAction, LIMIT_LOWERED_ON_UNDO_SENTENCE, LIMIT_RAISED_ON_SAVE_SENTENCE, MEMORY_LIMIT_BAR_LABEL, MEMORY_LIMIT_CEILING_TOKENS, memoryFullPercent, NEW_TOPIC_TAG, nextKeepIds, nextKeepTopics, overLimitFirstRead, raiseLimitTarget, REVIEW_DEPTH_ORDER, REVIEW_DEPTH_ROWS, REVIEW_FIRST_LABEL, reviewCardHeadline, reviewCardSentence, reviewChangeCounts, reviewChangeKindLabel, reviewDepthSentence, reviewRunArchiveCount, reviewRunFastPathBlockers, reviewRunFullPercent, reviewRunGuidanceSummary, reviewRunIsWorking, reviewRunProgressLine, reviewSavedArchiveSentence, reviewSavedHeadline, reviewSavedSentence, reviewTopicFoldedLine, reviewTopicGroupSummary, reviewTopicName, roundUpToThousand, showMoreLabel, topicKept, type ReviewChange } from "../../web-ui/src/memory-v2-copy.js";
import { allRoomsFactsLine, archivedLabel, archiveRowMeta, asOfSentence, budgetSettledHint, CHANGE_CONVERSATIONS_BLOCK, CHANGE_LINES_META, CHANGE_META, CHANGE_NONE, CHANGE_READ_ERROR, CHANGE_READING, CHANGE_UNVERIFIED, changeMetaLine, countNoteChanges, emptyNoteChangeCounts, fmtMemoryDay, fmtMemoryMoment, HIDE_CHANGE_LABEL, inMemorySinceLine, memorizedConversationsTitle, MEMORY_OVER_LIMIT_SENTENCE, memoryArchiveReason, memoryFullLine, memoryFullShort, memoryHistoryRows, memoryPercentFull, memoryTopicName, memoryUsageTitle, movedLabel, noteChangeTotals, noteFlagLabel, noteRowMeta, notesSummaryLine, roomMemoryFactsLine, topicChangeSummary, topicRowLine, type MemorySaveEvent, undoableHistoryRow, WHAT_CHANGED_LABEL } from "../../web-ui/src/memory-surface-copy.js";
import { diffWords, plainNoteText } from "../../web-ui/src/memory-diff.js";
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
	return { ...entry(), leaving: true, kept: false, instead: false, phase: "after", rank: 0, ...overrides };
}

/** The demotion block the way the server sends it: the counts come from the rows, never from the browser. */
function demotion(rows: ArchiveRow[], overrides: Partial<Omit<RunDemotion, "entries" | "counts">> = {}): RunDemotion {
	return {
		entries: rows,
		keepIds: rows.filter((candidate) => candidate.kept).map((candidate) => candidate.id),
		keepTopics: [],
		overageTokens: 0,
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
	assert(absorbRunSessionLine(session({ outcome: "dropped", reason: "it was small talk about the weather" })) === "Nothing to keep · it was small talk about the weather", "a dropped session carries its reason");
	const failed = absorbRunSessionLine(session({ outcome: "failed", reason: "The model took too long to answer." }));
	assert(failed.includes("It stays for next time."), `a failed session promises the next run (got: ${failed})`);
	// A worker failure's own sentence already says where the session goes; the
	// line must not say it twice in two voices.
	const waits = absorbRunSessionLine(session({ outcome: "failed", reason: "The connection to the model dropped while this session was being added, so it waits for the next update." }));
	assert(waits === "The connection to the model dropped while this session was being added, so it waits for the next update.", `a reason that already promises the next update keeps its own words (got: ${waits})`);
	assert(!/next time/.test(waits), `and does not promise it twice (got: ${waits})`);
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
	assert(ARCHIVE_EXPLANATION === "Keep marks a note that must stay; another note leaves in its place. The budget decides how many stay. Notes in the archive stay readable in Room settings and can come back any time.", `the one explanation above the list (got: ${ARCHIVE_EXPLANATION})`);
	assert(!/least[- ]used/i.test(ARCHIVE_EXPLANATION), "nothing records chat use, so the copy never claims least-used");
}

// 5. The fast path: a clean run passes, and each thing a person would weigh blocks it.
{
	// A clean fold adds, updates and replaces. One that closed an open item, or
	// one the model judged not worth keeping, is a judgement a person sees.
	const folded = (overrides: Partial<AbsorbRunSession> = {}): AbsorbRunSession => session({ summary: { added: 2, updated: 1, superseded: 0, closed: 0 }, ...overrides });
	const clean = (overrides: Partial<AbsorbRun> = {}): AbsorbRun => run({ sessions: [folded()], ...overrides });
	assert(absorbRunFastPathBlockers(clean()).length === 0, "a clean run needs no second look");
	assert(absorbRunFastPathBlockers(clean({ warnings: ["proposal missing Section-level change log"] })).length === 1, "a meaningful warning blocks");
	assert(absorbRunFastPathBlockers(clean({ warnings: ["no memory has been written"] })).length === 0, "the status line the server always sends is not a warning");
	assert(absorbRunFastPathBlockers(clean({ demotion: demotion([row({ phase: "before" })]) }))[0] === "1 note would move to the archive to stay within the budget", "a note leaving, before or after the read, falls to the card");
	assert(absorbRunFastPathBlockers(clean({ demotion: demotion([row(), row({ id: "m-2" })]) }))[0].startsWith("2 notes would move"), "the count is the server's leaving count");
	assert(absorbRunFastPathBlockers(clean({ demotion: demotion([row({ leaving: false, kept: true })]) })).length === 0, "a list where nothing leaves any more does not block");
	assert(absorbRunFastPathBlockers(clean({ budget: budget({ after: 21_000, overBudgetAfter: true }) }))[0].includes("above its budget"), "a budget crossing is never automatic");
	assert(absorbRunFastPathBlockers(clean({ sessions: [folded(), folded({ id: "RC-0008", outcome: "failed", reason: "The model took too long to answer." })] }))[0].includes("did not finish"), "an unfinished session falls to the card");
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
	assert(absorbRunFailedSessionNote(run({ sessions: [session({ outcome: "failed" })] })) === "1 conversation keeps waiting for the next update.", "one failure reads in the singular");
	assert(absorbRunFailedSessionNote(run({ sessions: [session({ outcome: "failed" }), session({ id: "RC-0008", outcome: "failed" })] })) === "2 conversations keep waiting for the next update.", "two failures read in the plural");
	const saved = absorbRunSavedSentence({ foldedSessions: ["RC-0007", "RC-0008"], remainingSessions: ["RC-0009"], archivedEntries: 5 });
	assert(saved === "2 conversations became lasting notes. 1 conversation keeps waiting for the next update. 5 notes moved to the archive.", `the saved screen states all three numbers (got: ${saved})`);
	const meanwhile = absorbRunSavedSentence({ foldedSessions: ["RC-0007"], remainingSessions: [], archivedEntries: 0, rebasedOnto: ["RC-0009"] });
	assert(meanwhile === "1 conversation became lasting notes. 1 conversation remembered meanwhile stays waiting.", `a conversation remembered during the run is named as still waiting (got: ${meanwhile})`);
	assert(absorbRunSavedSentence({ foldedSessions: ["RC-0007"], remainingSessions: [], archivedEntries: 0, rebasedOnto: [] }).endsWith("lasting notes."), "an empty rebase list says nothing");
	assert(absorbRunSavedSentence({ foldedSessions: ["RC-0007"], remainingSessions: [], archivedEntries: 0 }) === "1 conversation became lasting notes.", "a clean run says only what happened");
	const topics = absorbRunSavedSentence({ foldedSessions: ["RC-0007"], remainingSessions: [], archivedEntries: 0, newTopics: 2 });
	assert(topics === "1 conversation became lasting notes. 2 new topics.", `topics the update created are counted (got: ${topics})`);
	assert(absorbRunSavedSentence({ foldedSessions: ["RC-0007"], newTopics: 1 }).includes("1 new topic."), "one new topic reads in the singular");
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
}

// 11. Entry ids: a fact the card states, never a reason to hold an update back.
{
	assert(absorbRunMigrationSentence(run()) === null, "a room that already has entry ids says nothing about them");
	assert(absorbRunMigrationSentence(run({ migration: { pending: false, entriesAssigned: 0 } })) === null, "and neither does a migration that is not pending");
	const migrating = run({ migration: { pending: true, entriesAssigned: 1_240 } });
	assert(
		absorbRunMigrationSentence(migrating) === "This update also gives the room's 1,240 entries their ids, so they can be edited one by one. Nothing changes in what the room remembers.",
		`the migration line says what it is and what it is not (got: ${absorbRunMigrationSentence(migrating)})`,
	);
	assert(isEntryIdMigrationNotice("this room's memory was given entry ids before this update"), "the server's own note about it is recognised");
	assert(!isEntryIdMigrationNotice("proposal missing Section-level change log"), "and nothing else is mistaken for it");
	const migratingClean = run({ sessions: [session({ summary: { added: 2, updated: 1, superseded: 0, closed: 0 } })], migration: { pending: true, entriesAssigned: 1_240 }, warnings: ["This room's memory was given entry ids before this update; that change is in its history and can be rolled back from it."] });
	assert(absorbRunFastPathBlockers(migratingClean).length === 0, "an otherwise clean update is still applied automatically while the ids are assigned");
}

// 12. One name for applying updates automatically, wherever it is named.
{
	assert(AUTOMATIC_APPLY_SETTING_LABEL === "Memorize: save a clean update without the card", "the room setting has one label");
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
		one === "No conversation was memorized this time. 1 note moved to the archive to keep memory within its budget. 1 conversation keeps waiting for the next update.",
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
	assert(first.raise.target === 52_000 && first.raise.label === "Raise the budget to 52k to keep everything that is there now", `the raise is the room's memory rounded up (got: ${JSON.stringify(first.raise)})`);
	assert(first.reviewLabel === REVIEW_FIRST_LABEL && REVIEW_FIRST_LABEL === "Review first", "the other way is a Review");
	const huge = overLimitFirstRead({ reviewTargetTokens: 96_000, budgetTokens: 20_000, entriesOverBudget: 1_200 });
	assert(huge.raise.target === MEMORY_LIMIT_CEILING_TOKENS && huge.raise.label === "Raise the budget to 80k", `past the ceiling the button sets the ceiling (got: ${JSON.stringify(huge.raise)})`);
	assert(huge.sentence.includes("Even at the 80k ceiling some of them would still move."), `and the sentence says notes would still move (got: ${huge.sentence})`);
	assert(overLimitFirstRead({ reviewTargetTokens: 96_000, budgetTokens: 20_000, entriesOverBudget: 1_200, ceilingTokens: 100_000 }).raise.target === 96_000, "a ceiling handed in wins over the mirrored one");
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
	assert(reviewRunFastPathBlockers(wordingOnly({ leftAsIs: [{ topics: ["Hiring", "Payments"], reason: "The room's answer for these was cut off." }] })).includes("2 topics were left as they were"), "a topic the tidy could not do blocks");
	assert(reviewRunFastPathBlockers(wordingOnly({ warnings: ["A pinned note was rewritten."] })).length === 1, "a warning blocks");
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
	assert(allRoomsFactsLine({ rooms: 3, notes: 1_204, waiting: 12 }) === "3 rooms · 1,204 notes · 12 conversations waiting", `the cross-room line (got: ${allRoomsFactsLine({ rooms: 3, notes: 1_204, waiting: 12 })})`);
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

console.log("memory v2 copy smoke passed: the run card, the limit bar, the automatic-maintenance gate, the Review sentences, and the words both memory surfaces speak");
