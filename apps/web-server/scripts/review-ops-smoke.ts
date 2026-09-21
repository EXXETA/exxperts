export {};

// Review v2: the note operation layer's promises as predicates.
//
// Everything is imported from the real module — never an inline copy. The
// things this smoke exists to pin are the ones that cannot be read off the
// code: that Review REFUSES to make a note longer, that a pinned note cannot be
// archived or closed however the model asks, that "Tidy the wording" cannot
// remove anything at all, that a merge keeps the pin of any member it swallows,
// that the three archive reasons land on the archive rows the design named, and
// that an older version of a note reaches the archive under a versioned id
// rather than fighting the note that replaced it for one address.
//
// Offline: no server, no provider, no network, no port.

import type { MemoryDocument, MemoryEntry } from "../src/memory-entries.js";
import type { ReviewNote, ReviewOp } from "../src/review-ops.js";

const {
	applyReviewOps,
	buildReviewGroupPrompt,
	buildReviewRetryPrompt,
	extractReviewOpsJson,
	isReviewOpsJsonProblem,
	partitionReviewTopics,
	parseReviewOps,
	renderReviewGroupContext,
	REVIEW_GROWTH_REFUSAL,
	REVIEW_GROWTH_SLACK_CHARS,
	REVIEW_MAX_OPS,
	REVIEW_MAX_TEXT_CHARS,
	REVIEW_TRIGGER_PROMPT,
	reviewGroupLabel,
	reviewGroupNotes,
	reviewGroupTopic,
	reviewReplySourceBudget,
	validateReviewOps,
} = await import("../src/review-ops.js");
const { emptyReviewGuidance } = await import("../src/review-guidance.js");
const { parseArchive, renderArchive, appendToArchive, renderMemoryDocument, demoteToBudget } = await import("../src/memory-entries.js");

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

/** A refusal is proven by the line that names it, not by the count of lines. */
function refusalMatching(refusals: string[], pattern: RegExp): string | undefined {
	return refusals.find((refusal) => pattern.test(refusal));
}

// --- The document, by hand ---------------------------------------------------

function entry(id: string, kind: MemoryEntry["kind"], text: string, extra: Partial<MemoryEntry> = {}): MemoryEntry {
	return { id, kind, saved: "2026-07-08", from: "RC-0003", pinned: false, text, ...extra };
}

const LONG = "- The Nordwind contract renews annually and legal signs it before June, which is the arrangement the account team has followed since the first renewal and expects to follow again.";
const PINNED = "- **must-keep** The escalation route is the account owner, then the delivery lead, and nobody else.";

function fixture(): MemoryDocument {
	return {
		preamble: "<!-- exxeta:l1b schema_version=1 -->\n\n",
		chronos: "## Chronos\n\n- Lifecycle state: ready\n\n",
		topics: [
			{
				section: "Deep Memory",
				title: "Commercial terms",
				heading: "### Commercial terms",
				intro: "",
				entries: [
					entry("m-0031", "fact", LONG),
					entry("m-0032", "fact", "- Invoices go out on the first working day of the month."),
					entry("m-0033", "fact", PINNED, { pinned: true }),
					entry("m-0034", "fact", "- Summaries are sent on Fridays, which is a working-style point filed in the wrong place."),
				],
			},
			{
				section: "Deep Memory",
				title: "Working style",
				heading: "### Working style",
				intro: "",
				entries: [entry("m-0041", "practice", "- Send commercial summaries as one page, numbers first.")],
			},
			{
				section: "Active Items",
				title: "Active Items",
				heading: null,
				intro: "",
				entries: [
					entry("m-0051", "item", "- Chase the vendor for the signed addendum.", { status: "open" }),
					entry("m-0052", "item", "- Confirm the invoicing day with finance.", { status: "open" }),
				],
			},
		],
		recentContext: "## Recent Context\n\nNo checkpointed sessions yet.\n",
		otherSections: [],
		nextEntryNumber: 60,
	};
}

const DOC = fixture();
const GROUP = DOC.topics.map(reviewGroupTopic);
const NOTES: ReviewNote[] = reviewGroupNotes(GROUP);
const noteOf = (id: string): ReviewNote => {
	const found = NOTES.find((note) => note.id === id);
	assert(found, `the fixture has no note ${id}`);
	return found!;
};

// --- 1. The grammar reads what a model actually writes ------------------------

const REPLY = [
	"Two of these say one thing between them, and one is already as short as it can be.",
	"",
	"### Operations",
	"",
	"```json",
	JSON.stringify({
		ops: [
			{ op: "update", id: "m-0031", text: "- The Nordwind contract renews annually; legal signs before June." },
			{ op: "merge", ids: ["m-0041", "m-0032"], text: "- Summaries go out as one page, numbers first; invoices on the first working day." },
			{ op: "archive", id: "m-0052", why: "duplicate" },
			{ op: "close", id: "m-0051" },
			{ op: "move", id: "m-0032", topic: "Working style" },
			{ op: "pin", id: "m-0041", because: "the reporting shape the account team agreed" },
		],
	}, null, 2),
	"```",
	"",
].join("\n");

const parsed = parseReviewOps(REPLY);
assert(parsed.problems.length === 0, `a well-formed reply should parse without problems, got ${JSON.stringify(parsed.problems)}`);
assert(parsed.ops.length === 6, `the reply holds six operations, got ${parsed.ops.length}`);
assert(parsed.narrative.startsWith("Two of these"), `the narrative before the fence should be kept, got ${JSON.stringify(parsed.narrative)}`);
assert(!parsed.narrative.includes("### Operations"), `a trailing heading labels the fence and is not narrative, got ${JSON.stringify(parsed.narrative)}`);

const cut = parseReviewOps("Here is what I did.\n\n```json\n{\"ops\": [{\"op\":\"update\",\"id\":\"m-00");
assert(cut.ops.length === 0 && /cut off/.test(cut.problems[0] ?? ""), `a reply cut off inside its fence should say so, got ${JSON.stringify(cut.problems)}`);
assert(isReviewOpsJsonProblem(extractReviewOpsJson("no fence at all")), "a reply with no fence should come back as a problem, not a throw");
assert(/"ops"/.test(String((extractReviewOpsJson("nothing here") as any).problem)), "the no-fence problem should say what the fence must hold");

const foreign = parseReviewOps('```json\n{"ops":[{"op":"update","id":"m-0031","text":"- shorter","area":"Commercial terms"}]}\n```');
assert(foreign.ops.length === 1, "an op with a foreign key still parses, so the validator can refuse it by name");
const foreignRefusals = validateReviewOps(foreign.ops, NOTES, "tidy");
assert(refusalMatching(foreignRefusals, /"area"/), `a key the grammar does not define should be refused by name, got ${JSON.stringify(foreignRefusals)}`);

// --- 2. Review makes notes shorter -------------------------------------------

const source = noteOf("m-0031");
const grown: ReviewOp[] = [{ op: "update", id: "m-0031", text: `${source.text} ${"And the same point again, at length, with nothing new in it. ".repeat(3)}` }];
const growthRefusals = validateReviewOps(grown, NOTES, "tidy");
assert(refusalMatching(growthRefusals, new RegExp(REVIEW_GROWTH_REFUSAL)), `an update that grows a note must be refused, got ${JSON.stringify(growthRefusals)}`);
// Red-without: nothing else catches it. Apply the same op with the growth line
// taken out and the note really is longer than it was.
const grownApplied = applyReviewOps(fixture(), grown, { savedDate: "2026-09-14" });
const grownNote = grownApplied.doc.topics[0].entries.find((e) => e.id === "m-0031");
assert((grownNote?.text.length ?? 0) > source.text.length, "without the growth refusal, a tidy really does make the note longer — which is the whole reason for it");

assert(validateReviewOps([{ op: "update", id: "m-0031", text: "- The Nordwind contract renews annually; legal signs before June." }], NOTES, "tidy").length === 0, "a genuinely shorter update passes");
// The boundary, exactly: the note plus the slack passes, so a comma or an
// article never refuses a genuine rewording; one character more is refused,
// so growth always is. The slack is a fixed count, never a share of the note.
const atSlack = `- ${"x".repeat(source.text.length + REVIEW_GROWTH_SLACK_CHARS - 2)}`;
assert(atSlack.length === source.text.length + REVIEW_GROWTH_SLACK_CHARS, "the fixture sits exactly at the slack");
assert(validateReviewOps([{ op: "update", id: "m-0031", text: atSlack }], NOTES, "tidy").length === 0, `an update ${REVIEW_GROWTH_SLACK_CHARS} characters longer than the note it replaces passes`);
const pastSlack = validateReviewOps([{ op: "update", id: "m-0031", text: `${atSlack}x` }], NOTES, "tidy");
assert(pastSlack.length === 1 && refusalMatching(pastSlack, new RegExp(REVIEW_GROWTH_REFUSAL)), `one character past the slack is refused for growth and nothing else, got ${JSON.stringify(pastSlack)}`);
assert(refusalMatching(pastSlack, new RegExp(`at most ${REVIEW_GROWTH_SLACK_CHARS} characters longer`)), `the refusal says what the rule is, got ${JSON.stringify(pastSlack)}`);
// A merge is measured against its members TAKEN TOGETHER, not against the first, with the same slack.
const mergeSources = noteOf("m-0031").text.length + noteOf("m-0032").text.length;
const mergeAtSlack = `- ${"x".repeat(mergeSources + REVIEW_GROWTH_SLACK_CHARS - 2)}`;
assert(validateReviewOps([{ op: "merge", ids: ["m-0031", "m-0032"], text: mergeAtSlack }], NOTES, "tidy").length === 0, "a merge at its members together plus the slack passes");
assert(refusalMatching(validateReviewOps([{ op: "merge", ids: ["m-0031", "m-0032"], text: `${mergeAtSlack}x` }], NOTES, "tidy"), new RegExp(REVIEW_GROWTH_REFUSAL)), "a merge one character past its members together is refused");
assert(refusalMatching(validateReviewOps([{ op: "merge", ids: ["m-0031", "m-0032"], text: `- ${"x".repeat(mergeSources * 2)}` }], NOTES, "tidy"), new RegExp(REVIEW_GROWTH_REFUSAL)), "a merge that outgrows its members together is refused");

// --- 3. A pinned note is the user's own --------------------------------------

for (const op of [{ op: "archive" as const, id: "m-0033", why: "stale" as const }, { op: "close" as const, id: "m-0033" }]) {
	const refusals = validateReviewOps([op], NOTES, "tidy");
	assert(refusalMatching(refusals, /is pinned/), `a pinned note must refuse ${op.op}, got ${JSON.stringify(refusals)}`);
}
assert(validateReviewOps([{ op: "update", id: "m-0033", text: "- **must-keep** Escalate to the account owner, then the delivery lead." }], NOTES, "tidy").length === 0, "a pinned note may be worded better: that is the one thing a tidy may do to it");

// --- 4. Depth gating ----------------------------------------------------------

for (const op of [{ op: "archive" as const, id: "m-0032", why: "stale" as const }, { op: "close" as const, id: "m-0051" }]) {
	const refusals = validateReviewOps([op], NOTES, "wording");
	assert(refusalMatching(refusals, /wording only/), `"${op.op}" must be refused at depth wording, got ${JSON.stringify(refusals)}`);
}
assert(validateReviewOps([{ op: "update", id: "m-0031", text: "- Nordwind renews annually; legal signs before June." }], NOTES, "wording").length === 0, "update is allowed at depth wording");
assert(validateReviewOps([{ op: "move", id: "m-0032", topic: "Working style" }], NOTES, "wording").length === 0, "move is allowed at depth wording");
assert(validateReviewOps([{ op: "archive", id: "m-0032", why: "stale" }], NOTES, "tidy").length === 0, "archive is allowed at depth tidy");

// --- 5. Ids, groups and the rest of the validator ------------------------------

assert(refusalMatching(validateReviewOps([{ op: "update", id: "m-9999", text: "- shorter" }], NOTES, "tidy"), /not a note of this group/), "an id the group does not hold is refused");
assert(refusalMatching(validateReviewOps([{ op: "update", id: "M-0031", text: "- shorter" }], NOTES, "tidy"), /did you mean "m-0031"/), "a near-miss id is refused with the id it nearly is");
assert(refusalMatching(validateReviewOps([{ op: "update", id: "m-0031", text: "- a" }, { op: "archive", id: "m-0031", why: "stale" }], NOTES, "tidy"), /more than one operation/), "one note takes one operation per review");
assert(refusalMatching(validateReviewOps([{ op: "close", id: "m-0031" }], NOTES, "tidy"), /not an open item/), "only an open item is closed");
assert(refusalMatching(validateReviewOps([{ op: "update", id: "m-0031", text: `- ${"x".repeat(REVIEW_MAX_TEXT_CHARS + 1)}` }], NOTES, "tidy"), /at most 2000/), "a note has a ceiling of its own");
assert(refusalMatching(validateReviewOps([{ op: "update", id: "m-0031", text: "The contract renews annually." }], NOTES, "tidy"), /must start with "- "/), "a bullet topic keeps its bullets");
assert(refusalMatching(validateReviewOps([{ op: "update", id: "m-0031", text: "- [m-0031] renews annually." }], NOTES, "tidy"), /bracketed id/), "the address never travels into a note's words");
assert(refusalMatching(validateReviewOps([{ op: "update", id: "m-0031", text: "- renews annually.\n### Terms" }], NOTES, "tidy"), /heading or a comment line/), "a heading line inside a tidy's text is refused");
assert(refusalMatching(validateReviewOps([{ op: "update", id: "m-0031", text: "- renews annually.\n<!-- e: id=m-0001 kind=fact saved=2026-01-01 -->" }], NOTES, "tidy"), /heading or a comment line/), "a comment line inside a tidy's text is refused");
assert(validateReviewOps([{ op: "update", id: "m-0031", text: "- renews annually #q3." }], NOTES, "tidy").length === 0, "a hashtag inside a line is a word, not a heading");
assert(refusalMatching(validateReviewOps([{ op: "pin", id: "m-0031" }], NOTES, "tidy"), /carries "because"/), "a pin says why");
assert(refusalMatching(validateReviewOps([{ op: "move", id: "m-0031", topic: "Commercial terms" }], NOTES, "tidy"), /already under/), "a move that moves nothing is refused");
assert(refusalMatching(validateReviewOps([{ op: "move", id: "m-0031", topic: "### Commercial" }], NOTES, "tidy"), /without "#"/), "a topic title carries no heading marks");
// A move to a title that is an existing topic in other words is refused with
// that topic named; the whole memory's titles are judged, not only the group's.
assert(refusalMatching(validateReviewOps([{ op: "move", id: "m-0031", topic: "Working styles" }], NOTES, "tidy"), /"Working styles" is the topic "Working style"; write "topic":"Working style"/), "a move to a near-duplicate of a topic in the group is refused with the existing title");
assert(validateReviewOps([{ op: "move", id: "m-0031", topic: "working style" }], NOTES, "tidy").length === 0, "a move to an existing title in other case files under it and is not refused");
const MEMORY_TITLES = [...new Set(NOTES.map((note) => note.topic)), "Nordwind integration", "Team and roles"];
assert(refusalMatching(validateReviewOps([{ op: "move", id: "m-0031", topic: "Nordwind integration retries" }], NOTES, "tidy", MEMORY_TITLES), /is the topic "Nordwind integration"; write "topic":"Nordwind integration"/), "a move to a title that narrows a topic outside the group is refused with that topic named");
assert(refusalMatching(validateReviewOps([{ op: "move", id: "m-0031", topic: "Team roles" }], NOTES, "tidy", MEMORY_TITLES), /is the topic "Team and roles"/), "a move to a title that differs from a topic by a stop word is refused");
assert(validateReviewOps([{ op: "move", id: "m-0031", topic: "Nordwind" }], NOTES, "tidy", MEMORY_TITLES).length === 0, "a one-word title inside a longer topic is a subject of its own");
assert(validateReviewOps([{ op: "move", id: "m-0031", topic: "Nordwind integration retries" }], NOTES, "tidy").length === 0, "without the memory's titles only the group's are judged, so a title outside the group is a new one");
assert(refusalMatching(validateReviewOps([{ op: "merge", ids: ["m-0031", "m-0051"], text: "- one" }], NOTES, "tidy"), /one section/), "a merge does not join Deep Memory to Active Items");
const tooMany: ReviewOp[] = Array.from({ length: REVIEW_MAX_OPS + 1 }, () => ({ op: "update" as const, id: "m-0031", text: "- a" }));
assert(refusalMatching(validateReviewOps(tooMany, NOTES, "tidy"), new RegExp(`at most ${REVIEW_MAX_OPS}`)), "a reply past the op ceiling is refused");
assert(validateReviewOps([], NOTES, "tidy").length === 0, "an empty list is a valid answer: these notes are already as short as they can be");

// --- 6. Applying: what the ops do to the document ------------------------------

const applied = applyReviewOps(fixture(), [
	{ op: "update", id: "m-0031", text: "- Nordwind renews annually; legal signs before June." },
	{ op: "merge", ids: ["m-0041", "m-0033"], text: "- **must-keep** One page, numbers first; escalate to the account owner." },
	{ op: "archive", id: "m-0032", why: "stale" },
	{ op: "close", id: "m-0051" },
	{ op: "move", id: "m-0034", topic: "Working style" },
], { savedDate: "2026-09-14" });

const commercial = applied.doc.topics.find((topic) => topic.title === "Commercial terms")!;
const updated = commercial.entries.find((e) => e.id === "m-0031")!;
assert(updated.text === "- Nordwind renews annually; legal signs before June.", "an update writes the new words");
assert(updated.saved === "2026-07-08" && updated.from === "RC-0003" && updated.kind === "fact", "an update keeps the note's id, its date, where it came from and its kind");
assert(updated.updated === undefined, `an update stamps nothing on the note: a tidy's wording is not new information, and the budget ranks by that stamp (got updated=${JSON.stringify(updated.updated)})`);
assert(!commercial.entries.some((e) => e.id === "m-0032"), "an archived note leaves the core");
assert(!commercial.entries.some((e) => e.id === "m-0033"), "a merged-away note leaves the core");

const workingStyle = applied.doc.topics.find((topic) => topic.title === "Working style")!;
const survivor = workingStyle.entries.find((e) => e.id === "m-0041")!;
assert(survivor.text.includes("One page, numbers first"), "the first id of a merge survives with the new text");
assert(survivor.pinned === true, "a merge that swallows a pinned note is pinned: the user's own note cannot be tidied away by being merged into something else");

const activeItems = applied.doc.topics.find((topic) => topic.section === "Active Items")!;
assert(!activeItems.entries.some((e) => e.id === "m-0051"), "a closed item leaves the core in the review that closed it");

// The archive rows, each with the reason the design named.
const byId = new Map(applied.archive.map((row) => [row.entry.id, row]));
assert(byId.get("m-0031-v1")?.why === "superseded", `the words an update replaced go to the archive as superseded, got ${JSON.stringify([...byId.keys()])}`);
assert(byId.get("m-0031-v1")?.entry.text === LONG, "the superseded row carries the words the note used to have, exactly");
assert(byId.get("m-0041-v1")?.why === "superseded", "the surviving note of a merge keeps its own replaced words as its previous version");
assert(byId.get("m-0033")?.why === "superseded", "a merged-away note goes to the archive under its own id, where a restore can find it");
assert(byId.get("m-0032")?.why === "stale", `"stale" reaches the archive as its own reason, got ${JSON.stringify(byId.get("m-0032")?.why)}`);
assert(byId.get("m-0051")?.why === "done" && byId.get("m-0051")?.entry.status === "done", `a close archives the item as done, got ${JSON.stringify(byId.get("m-0051"))}`);
assert(applied.archive.every((row) => row.topic && row.section), "every archive row carries the address a restore needs");

const duplicated = applyReviewOps(fixture(), [{ op: "archive", id: "m-0032", why: "duplicate" }], { savedDate: "2026-09-14" });
assert(duplicated.archive[0].why === "duplicate", '"duplicate" reaches the archive as its own reason');
const finished = applyReviewOps(fixture(), [{ op: "archive", id: "m-0031", why: "finished" }], { savedDate: "2026-09-14" });
assert(finished.archive[0].why === "done", '"finished" maps to the archive\'s existing "done"');

// A second version of one note in one run is -v2, not a second -v1: two rows
// claiming one address would make a restore a coin toss.
const twice = applyReviewOps(applied.doc, [{ op: "update", id: "m-0031", text: "- Nordwind renews annually." }], { savedDate: "2026-09-14", takenArchiveIds: applied.archive.map((row) => row.entry.id) });
assert(twice.archive[0].entry.id === "m-0031-v2", `a second replaced text of one note is -v2, got ${twice.archive[0].entry.id}`);

// The archive file reads the two new reasons back as themselves.
const archiveText = appendToArchive(renderArchive([]), applied.archive.map((row) => row.entry), applied.archive.map((row) => ({ archived: "2026-09-14", why: row.why, topic: row.topic, section: row.section })));
const readBack = new Map(parseArchive(archiveText).map((row) => [row.id, row]));
assert(readBack.get("m-0032")?.why === "stale", `the archive file should read "stale" back as itself, got ${JSON.stringify(readBack.get("m-0032")?.why)}`);
assert(parseArchive(appendToArchive(renderArchive([]), [duplicated.archive[0].entry], [{ archived: "2026-09-14", why: "duplicate", topic: "Commercial terms", section: "Deep Memory" }]))[0].why === "duplicate", 'the archive file should read "duplicate" back as itself');

// The changes the card reads, counted from what was APPLIED.
const kinds = applied.changes.map((change) => `${change.kind}:${change.id}`);
assert(kinds.includes("shortened:m-0031") && kinds.includes("merged:m-0041") && kinds.includes("archived:m-0032") && kinds.includes("closed:m-0051") && kinds.includes("moved:m-0034"), `every op should show as its own kind of change, got ${JSON.stringify(kinds)}`);
const merged = applied.changes.find((change) => change.kind === "merged")!;
assert(JSON.stringify(merged.mergedFrom) === JSON.stringify(["m-0041", "m-0033"]), `a merged row names the notes that became it, got ${JSON.stringify(merged.mergedFrom)}`);
const moved = applied.changes.find((change) => change.kind === "moved")!;
assert(moved.before === "Commercial terms" && moved.after === "Working style" && moved.topic === "Working style", `a move names the topic it came from and the one it went to, got ${JSON.stringify(moved)}`);
assert(workingStyle.entries.some((e) => e.id === "m-0034") && !commercial.entries.some((e) => e.id === "m-0034"), "a moved note really changes topic, and keeps its id doing it");

// A note nobody named is the document's own object, untouched.
const untouched = applied.doc.topics.find((topic) => topic.section === "Active Items")!.entries.find((e) => e.id === "m-0052")!;
assert(untouched.text === "- Confirm the invoicing day with finance." && untouched.saved === "2026-07-08", "a note the tidy did not reword keeps its words and its date");

// An op list that was never validated throws rather than half-applying.
let threw = false;
try {
	applyReviewOps(fixture(), [{ op: "update", id: "m-9999", text: "- a" }], { savedDate: "2026-09-14" });
} catch (error) {
	threw = /not validated/.test((error as Error).message);
}
assert(threw, "applying ops the validator never saw must throw, not half-apply");

// --- 6b. A tidy never stamps a note as touched --------------------------------
// The budget pass ranks by a score in which a recent touch keeps a note. A tidy
// that stamped the notes it reworded would send the notes it left alone out of
// memory ahead of them — the wrong way round: the tidy just judged the reworded
// ones worth keeping and said nothing about the rest. (A shortened note does
// score a little higher for its size; that is the size term, not a stamp.)

function budgetFixture(): MemoryDocument {
	const doc = fixture();
	doc.topics = [{
		section: "Deep Memory",
		title: "Commercial terms",
		heading: "### Commercial terms",
		intro: "",
		entries: [
			entry("m-0031", "fact", LONG, { saved: "2024-01-10" }),
			entry("m-0032", "fact", "- Invoices go out on the first working day of the month.", { saved: "2025-01-10" }),
			entry("m-0034", "fact", "- Summaries are sent on Fridays.", { saved: "2026-01-10" }),
		],
	}];
	return doc;
}
const tidiedOldest = applyReviewOps(budgetFixture(), [{ op: "update", id: "m-0031", text: "- Nordwind renews annually; legal signs before June." }], { savedDate: "2026-09-14" });
const leavingOrder = demoteToBudget(tidiedOldest.doc, 0, { today: "2026-09-14" }).demoted.map((e) => e.id);
assert(leavingOrder[leavingOrder.length - 1] === "m-0034" && leavingOrder.indexOf("m-0031") < leavingOrder.indexOf("m-0034"), `the note touched this year still leaves last, and the oldest note, shortened by the tidy, still leaves before it, got ${JSON.stringify(leavingOrder)}`);
// Red-without: stamp the shortened note the way a fold's update is stamped, and
// the ranking inverts — the note the tidy just kept would be the last to go.
const stampedDoc = tidiedOldest.doc;
stampedDoc.topics[0].entries.find((e) => e.id === "m-0031")!.updated = "2026-09-14";
const stampedOrder = demoteToBudget(stampedDoc, 0, { today: "2026-09-14" }).demoted.map((e) => e.id);
assert(stampedOrder[stampedOrder.length - 1] === "m-0031", `with the stamp the tidy would invert the budget's order, which is the whole reason it does not stamp, got ${JSON.stringify(stampedOrder)}`);

// --- 7. Groups ---------------------------------------------------------------

assert(reviewReplySourceBudget(16_384) === Math.floor(16_384 * 0.35), "the reply budget is the model's own output cap, by the share the design named");
assert(reviewReplySourceBudget(1_000) === 3_000, "the floor holds whatever the cap says, so a small cap does not slice a room into single topics");
assert(reviewReplySourceBudget(undefined) === Math.floor(16_384 * 0.35), "an unknown cap falls back to the default gateway row's");

assert(partitionReviewTopics(GROUP, 1_000_000).length === 1, "everything that fits together is one group, and one call");
const sliced = partitionReviewTopics(GROUP, 10);
assert(sliced.length === GROUP.length, `a budget nothing fits under gives every topic its own group, got ${sliced.length}`);
assert(sliced.every((group) => new Set(group.map((topic) => topic.section)).size === 1), "a group never straddles two sections");
assert(sliced.flat().map((topic) => topic.title).join("|") === GROUP.map((topic) => topic.title).join("|"), "grouping keeps document order, so a merge inside a group stays meaningful");
assert(reviewGroupLabel(GROUP) === "Commercial terms and 2 more topics", `a group is named by its first topic and how many ride with it, got ${JSON.stringify(reviewGroupLabel(GROUP))}`);
assert(reviewGroupLabel([GROUP[0]]) === "Commercial terms", "one topic is named by itself");
assert(partitionReviewTopics([], 1_000).length === 0, "no topics is no groups");
// Bonded titles travel as one unit: the pair always reaches one call, even
// when the budget would have split them or another topic sat between them.
const bonded = partitionReviewTopics(GROUP, 10, [["Commercial terms", "Working style"]]);
assert(bonded.length === 2 && bonded[0].map((topic) => topic.title).join("|") === "Commercial terms|Working style", `two bonded topics ride in one group whatever the budget, got ${JSON.stringify(bonded.map((group) => group.map((topic) => topic.title)))}`);
assert(partitionReviewTopics(GROUP, 10, [["working style", "Active Items"]]).length === GROUP.length, "a bond across two sections ties nothing: a group never straddles them");
assert(partitionReviewTopics(GROUP, 10, [["Commercial terms", "No such topic"]]).length === GROUP.length, "a bond naming a title that is not here ties nothing");

// --- 8. The prompt ------------------------------------------------------------

const context = renderReviewGroupContext(GROUP, DOC);
assert(context.includes("[m-0031]") && context.includes("[m-0033 · pinned]"), `the group render should carry every note's address in its own first line, got ${context.slice(0, 200)}`);
assert(!context.includes("<!-- e:"), "the group render is what the room reads: no storage metadata");
assert(!context.includes("Recent Context") && !context.includes("Chronos"), "a tidy reads the notes it may change and nothing else");

const assembly = buildReviewGroupPrompt({
	agentId: "pa_smoke",
	model: { provider: "openai-compatible", model: "gpt-5.5" },
	topics: context,
	notes: NOTES,
	depth: "tidy",
	guidance: { ...emptyReviewGuidance(), shorten: ["Commercial terms"], keepAsIs: ["the escalation route"] },
	groupIndex: 1,
	groupCount: 2,
	now: new Date("2026-09-14T09:00:00.000Z"),
});
assert(assembly.prompt.includes("## Task: Tidy These Notes"), "the prompt carries the task the run's scripted worker looks for");
assert(assembly.prompt.includes("[m-0031]"), "the prompt carries the notes with their addresses");
assert(assembly.prompt.includes('"op":"archive"'), "at depth tidy the archive operation is offered");
assert(assembly.prompt.includes("Commercial terms") && assembly.prompt.includes("the escalation route"), "the prompt carries what the person agreed in the discussion");
assert(assembly.telemetry.noteCount === NOTES.length && assembly.telemetry.promptEstimatedTokens > 0, "the prompt measures itself");
for (const word of ["token", "budget", "entry id", "section"]) {
	assert(!new RegExp(`\\b${word}s?\\b`).test(assembly.prompt.split("## Task")[1] ?? ""), `the task a business user's notes are tidied by should not speak of ${word}`);
}

const wording = buildReviewGroupPrompt({ ...{ agentId: "pa_smoke", model: { provider: "p", model: "m" }, topics: context, notes: NOTES, guidance: emptyReviewGuidance(), groupIndex: 1, groupCount: 1 }, depth: "wording" });
assert(!wording.prompt.includes('"op":"archive"') && !wording.prompt.includes('"op":"close"'), "at depth wording the removing operations are not even shown: the depth is a fact about the prompt, not only about the validator");
assert(wording.prompt.includes("Nothing leaves memory in this pass"), "the wording depth says so in the prompt's own words");

const retry = buildReviewRetryPrompt(assembly.prompt, ["op 1 (update): Review makes notes shorter"]);
assert(retry.includes("## Retry Notice") && retry.includes("Review makes notes shorter"), "a refused reply is asked again with the reasons named");
assert(retry.split("## Retry Notice").length === 2, "a retry adds ONE notice, never a second stacked on the first");
assert(REVIEW_TRIGGER_PROMPT.length > 0 && !REVIEW_TRIGGER_PROMPT.includes("{"), "the worker's trigger turn is a fixed sentence, carrying no material of its own");

// The machine's findings ride in the prompt as one section each, with the
// remedy the depth allows, and the task asks for every pair to be dealt with.
assert(!assembly.prompt.includes("Notes That Say The Same Twice") && !assembly.prompt.includes("Topics That Look The Same"), "a group with no findings carries no findings section and no sentence about one");
const base = { agentId: "pa_smoke", model: { provider: "p", model: "m" }, topics: context, notes: NOTES, guidance: emptyReviewGuidance(), groupIndex: 1, groupCount: 1 };
const findings = { duplicateNotes: [{ ids: ["m-0031", "m-0034"] as [string, string] }], lookAlikeTopics: [{ a: "Nordwind integration", b: "Nordwind integrations" }] };
const withFindings = buildReviewGroupPrompt({ ...base, ...findings, depth: "tidy" });
assert(withFindings.prompt.includes("## Material: Notes That Say The Same Twice\n\n- m-0031 and m-0034 say the same thing: merge them into one note, or archive one of them as duplicate."), "at depth tidy a pair of notes is listed with both remedies");
assert(withFindings.prompt.includes(`Every pair listed under "Notes That Say The Same Twice" is dealt with: merge them, or archive one as duplicate, or say in the narrative why both stay.`), "at depth tidy the task asks for every pair to be dealt with, the archive included");
assert(withFindings.prompt.includes(`## Material: Topics That Look The Same\n\n- "Nordwind integration" and "Nordwind integrations" look like one topic: fold the one with fewer notes into the other with merge_topics, unless they are two subjects after all.`), "at depth tidy a pair of look-alike topics is listed with the fold as the remedy");
assert(withFindings.prompt.includes('"op":"merge_topics"'), "at depth tidy the fold operation is offered");
const wordingFindings = buildReviewGroupPrompt({ ...base, ...findings, depth: "wording" });
assert(wordingFindings.prompt.includes("## Material: Notes That Say The Same Twice\n\n- m-0031 and m-0034 say the same thing: merge them into one note."), "at depth wording a pair of notes is listed with the merge alone: the archive is not open");
assert(wordingFindings.prompt.includes(`Every pair listed under "Notes That Say The Same Twice" is dealt with: merge them, or say in the narrative why both stay.`), "at depth wording the task asks for every pair to be dealt with, without the archive");
assert(!wordingFindings.prompt.includes("Topics That Look The Same") && !wordingFindings.prompt.includes('"op":"merge_topics"'), "at depth wording topics are not folded, so neither the finding nor the operation is shown");

// --- 9. Folding one topic into another -----------------------------------------

/** The fixture with two headings that look like one topic, and a topic that opens with a paragraph of its own. */
function foldFixture(): MemoryDocument {
	const doc = fixture();
	const active = doc.topics.pop()!;
	doc.topics.push(
		{ section: "Deep Memory", title: "Nordwind integration", heading: "### Nordwind integration", intro: "", entries: [entry("m-0061", "fact", "- Nordwind's orders arrive over the nightly feed at two in the morning."), entry("m-0062", "fact", "- Retries are attempted three times, ten minutes apart, before the feed is declared down.")] },
		{ section: "Deep Memory", title: "Nordwind integrations", heading: "### Nordwind integrations", intro: "", entries: [entry("m-0063", "fact", "- The feed's checksum is verified against the manifest before any order is accepted, and a mismatch stops the run.", { pinned: true, saved: "2026-05-02", refs: 3 })] },
		{ section: "Deep Memory", title: "Context", heading: "### Context", intro: "The room exists to keep the renewal cycle honest.", entries: [entry("m-0071", "fact", "- The account team meets the counterparty quarterly.")] },
		active,
	);
	return doc;
}
const FOLD_DOC = foldFixture();
const FOLD_GROUP = FOLD_DOC.topics.map(reviewGroupTopic);
const FOLD_NOTES = reviewGroupNotes(FOLD_GROUP);
const FOLD_TITLES = FOLD_DOC.topics.map((topic) => topic.title);
const FOLD_CONTEXT = { group: FOLD_GROUP, memoryTopics: FOLD_DOC.topics.map((topic) => ({ section: topic.section, title: topic.title, intro: topic.intro })) };
const fold = (ops: ReviewOp[], depth: "wording" | "tidy" = "tidy", context = FOLD_CONTEXT) => validateReviewOps(ops, FOLD_NOTES, depth, FOLD_TITLES, context);

// The grammar.
const foldParsed = parseReviewOps('```json\n{"ops":[{"op":"merge_topics","from":" Nordwind integrations ","into":"Nordwind integration"}]}\n```');
assert(foldParsed.problems.length === 0 && foldParsed.ops.length === 1 && foldParsed.ops[0].op === "merge_topics" && foldParsed.ops[0].from === "Nordwind integrations" && foldParsed.ops[0].into === "Nordwind integration", `a fold parses with both titles trimmed, got ${JSON.stringify(foldParsed)}`);
assert(/"into" is required/.test(parseReviewOps('```json\n{"ops":[{"op":"merge_topics","from":"Nordwind integrations"}]}\n```').problems[0] ?? ""), "a fold without its target is a named problem");
assert(refusalMatching(validateReviewOps(parseReviewOps('```json\n{"ops":[{"op":"merge_topics","from":"Nordwind integrations","into":"Nordwind integration","id":"m-0063"}]}\n```').ops, FOLD_NOTES, "tidy", FOLD_TITLES, FOLD_CONTEXT), /"id" is not part of this operation; write it with exactly "op", "from", "into"/), "a fold with a foreign key is refused by name");

// Every refusal, verbatim.
const GOOD_FOLD: ReviewOp = { op: "merge_topics", from: "Nordwind integrations", into: "Nordwind integration" };
assert(fold([GOOD_FOLD]).length === 0, `a fold of one look-alike topic into the other is accepted, got ${JSON.stringify(fold([GOOD_FOLD]))}`);
assert(fold([GOOD_FOLD, { op: "update", id: "m-0063", text: "- The feed's checksum is verified against the manifest; a mismatch stops the run." }]).length === 0, "a note of the folded topic may be worded better in the same reply: the fold claims topics, not notes");
const groupWithout = FOLD_GROUP.filter((topic) => topic.title !== "Nordwind integrations");
assert(fold([GOOD_FOLD], "tidy", { ...FOLD_CONTEXT, group: groupWithout }).join("|") === `op 1 (merge_topics): "Nordwind integrations" is not a topic of this group; fold only a topic listed above`, "only a topic of this group is folded");
assert(fold([{ op: "merge_topics", from: "Nordwind integrations", into: "Nordwind" }]).join("|") === `op 1 (merge_topics): "Nordwind" is not a topic of this memory; copy the title exactly as it is listed`, "a fold lands only in a topic the memory has");
assert(fold([{ op: "merge_topics", from: "Nordwind integrations", into: "nordwind integrations" }]).join("|") === `op 1 (merge_topics): "Nordwind integrations" cannot be folded into itself`, "a topic is not folded into itself, whatever the case");
assert(fold([{ op: "merge_topics", from: "Active Items", into: "Nordwind integration" }]).join("|") === `op 1 (merge_topics): open items are not folded; move them one by one instead`, "open items are not folded away");
assert(fold([{ op: "merge_topics", from: "Nordwind integrations", into: "Active Items" }]).join("|") === `op 1 (merge_topics): open items are not folded; move them one by one instead`, "nothing is folded into the open items");
assert(fold([{ op: "merge_topics", from: "Context", into: "Nordwind integration" }]).join("|") === `op 1 (merge_topics): "Context" opens with a paragraph of its own; move its notes one by one instead`, "a topic that opens with a paragraph is not folded");
assert(fold([GOOD_FOLD, { op: "merge_topics", from: "nordwind integrations", into: "Commercial terms" }]).join("|") === `op 2 (merge_topics): "Nordwind integrations" is folded by more than one operation`, "one topic is folded once per reply");
assert(fold([GOOD_FOLD, { op: "merge_topics", from: "Commercial terms", into: "Nordwind integrations" }]).join("|") === `op 2 (merge_topics): "Nordwind integrations" is folded away by op 1; fold into the topic that stays`, "nothing is folded into a topic an earlier operation folded away");
assert(fold([GOOD_FOLD], "wording").join("|") === `op 1 (merge_topics): this review is tidying the wording only; topics are folded in a tidy that may also move notes`, "at depth wording a fold is refused in its own words");
assert(refusalMatching(fold([{ op: "archive", id: "m-0032", why: "stale" }], "wording"), /word the note better with update or merge, or leave it as it is/), "the wording refusal for a note stays as it was");

// Applying: the notes move as they are, the heading goes, and a note claim after the fold resolves by id.
const foldApplied = applyReviewOps(foldFixture(), [
	GOOD_FOLD,
	{ op: "update", id: "m-0063", text: "- The feed's checksum is verified against the manifest; a mismatch stops the run." },
], { savedDate: "2026-09-14" });
assert(!foldApplied.doc.topics.some((topic) => topic.title === "Nordwind integrations"), "the folded topic leaves the document");
const into = foldApplied.doc.topics.find((topic) => topic.title === "Nordwind integration")!;
assert(into.entries.map((e) => e.id).join("|") === "m-0061|m-0062|m-0063", `the folded topic's notes are appended after the target's own, got ${JSON.stringify(into.entries.map((e) => e.id))}`);
const movedNote = into.entries[2];
assert(movedNote.pinned === true && movedNote.saved === "2026-05-02" && movedNote.refs === 3 && movedNote.from === "RC-0003" && movedNote.kind === "fact", `a moved note keeps its pin, its date, its refs, where it came from and its kind, got ${JSON.stringify(movedNote)}`);
assert(movedNote.text.endsWith("a mismatch stops the run.") && movedNote.updated === undefined, "the update on a note of the folded topic still applied after the fold, by id, and stamped nothing");
assert(into.entries[0].updated === undefined && into.entries[1].updated === undefined, "the fold stamps nothing on the notes it moves or the notes it moves them beside");
const foldRow = foldApplied.changes.find((change) => change.kind === "topic_folded")!;
assert(JSON.stringify(foldRow) === JSON.stringify({ id: "m-0063", section: "Deep Memory", topic: "Nordwind integration", kind: "topic_folded", before: "Nordwind integrations", after: "Nordwind integration", notesMoved: 1 }), `a fold is one change row naming the first note moved, got ${JSON.stringify(foldRow)}`);
assert(foldApplied.changes.find((change) => change.kind === "shortened")?.topic === "Nordwind integration", "the shortened row names the topic the note now sits under");
assert(foldApplied.archive.length === 1 && foldApplied.archive[0].entry.id === "m-0063-v1", "the fold itself archives nothing; only the update's previous words go");
const storage = renderMemoryDocument(foldApplied.doc, "storage");
assert(!storage.includes("### Nordwind integrations"), "the storage render carries no heading for the folded topic");
for (const block of storage.slice(storage.indexOf("## Deep Memory"), storage.indexOf("## Active Items")).split(/^### /m).slice(1)) assert(block.includes("<!-- e:"), `no heading is left empty, and "${block.split("\n")[0]}" is`);
assert(renderReviewGroupContext([reviewGroupTopic(into)], foldApplied.doc).includes("[m-0063 · pinned]"), "the group render after a fold shows the moved note under its new topic");
assert(FOLD_DOC.topics.some((topic) => topic.title === "Nordwind integrations") && FOLD_DOC.topics.find((topic) => topic.title === "Nordwind integration")!.entries.length === 2, "the source document is not mutated: the applier is pure");
let foldThrew = false;
try { applyReviewOps(foldFixture(), [{ op: "merge_topics", from: "No such topic", into: "Nordwind integration" }], { savedDate: "2026-09-14" }); } catch (error) { foldThrew = /not validated/.test((error as Error).message); }
assert(foldThrew, "a fold the validator never saw throws rather than half-applying");

// --- 10. Notes that disagree ------------------------------------------------------
// Two notes that share their words but not a value are one point with two
// values, never twins. The validator refuses an archive-as-duplicate of
// either member, and a merge of the two whose text keeps the older value
// while the dates decide; the applier says on the merged row, and on the
// archive row of the member that left, which value replaced which and why.

const OLDER_TEXT = "- The Nordwind maintenance contract renews automatically on 1 June.";
const NEWER_TEXT = "- The Nordwind maintenance contract renews automatically on 1 July.";
/** The fixture with the disagreeing pair under a topic of its own, the older note first. */
function conflictFixture(): MemoryDocument {
	const doc = fixture();
	const active = doc.topics.pop()!;
	doc.topics.push(
		{ section: "Deep Memory", title: "Maintenance renewals", heading: "### Maintenance renewals", intro: "", entries: [entry("m-0081", "fact", OLDER_TEXT, { saved: "2026-06-02" }), entry("m-0082", "fact", NEWER_TEXT, { saved: "2026-09-14" })] },
		active,
	);
	return doc;
}
const CONFLICT_DOC = conflictFixture();
const CONFLICT_NOTES = reviewGroupNotes(CONFLICT_DOC.topics.map(reviewGroupTopic));
const DECIDED = { ids: ["m-0081", "m-0082"] as [string, string], newer: "b" as const, texts: [OLDER_TEXT, NEWER_TEXT] as [string, string], dates: ["2026-06-02", "2026-09-14"] as [string, string] };
const UNDECIDED = { ...DECIDED, newer: null, dates: ["2026-09-14", "2026-09-14"] as [string, string] };
const judge = (ops: ReviewOp[], pair: typeof DECIDED | typeof UNDECIDED = DECIDED, depth: "wording" | "tidy" = "tidy") => validateReviewOps(ops, CONFLICT_NOTES, depth, undefined, { conflictNotes: [pair], today: "2026-09-14" });

// The archive: neither member is a duplicate of the other.
const ARCHIVE_REFUSAL = `m-0081 and m-0082 disagree, they are not twins; merge them keeping the newer text, or leave both`;
assert(judge([{ op: "archive", id: "m-0081", why: "duplicate" }]).join("|") === `op 1 (archive): ${ARCHIVE_REFUSAL}`, `archiving the older member as a duplicate is refused in the words the spec fixed, got ${JSON.stringify(judge([{ op: "archive", id: "m-0081", why: "duplicate" }]))}`);
assert(judge([{ op: "archive", id: "m-0082", why: "duplicate" }]).join("|") === `op 1 (archive): ${ARCHIVE_REFUSAL}`, "archiving the newer member as a duplicate is refused in the same words, the ids in document order");
assert(judge([{ op: "archive", id: "m-0081", why: "stale" }]).length === 0, "archiving a member as stale is the model's own call and passes");
assert(judge([{ op: "archive", id: "m-0032", why: "duplicate" }]).length === 0, "a note outside the pair is archived as a duplicate as before");

// The merge: the newer value stands when the dates decide.
const MERGE_REFUSAL = `op 1 (merge): the merged text keeps 1 June, but m-0082 (saved 14 Sep) is newer; keep 1 July or say why in the narrative`;
assert(judge([{ op: "merge", ids: ["m-0082", "m-0081"], text: OLDER_TEXT }]).join("|") === MERGE_REFUSAL, `a merge whose text keeps the older value is refused in the words the spec fixed, got ${JSON.stringify(judge([{ op: "merge", ids: ["m-0082", "m-0081"], text: OLDER_TEXT }]))}`);
assert(judge([{ op: "merge", ids: ["m-0081", "m-0082"], text: "- Nordwind maintenance renews automatically on 1 June." }]).join("|") === MERGE_REFUSAL, "the refusal holds whichever member survives and however the words are shortened: the value is what is judged");
assert(judge([{ op: "merge", ids: ["m-0082", "m-0081"], text: NEWER_TEXT }]).length === 0, "a merge keeping the newer value passes");
assert(judge([{ op: "merge", ids: ["m-0081", "m-0082"], text: "- The Nordwind maintenance contract renewed on 1 June and renews on 1 July." }]).length === 0, "a merge that carries both values keeps the newer one and passes");
assert(judge([{ op: "merge", ids: ["m-0082", "m-0081"], text: OLDER_TEXT }], UNDECIDED).length === 0 && judge([{ op: "merge", ids: ["m-0082", "m-0081"], text: NEWER_TEXT }], UNDECIDED).length === 0, "with equal dates nothing decides, and a merge keeping either value passes");
assert(judge([{ op: "merge", ids: ["m-0082", "m-0081"], text: OLDER_TEXT }], DECIDED, "wording").join("|") === MERGE_REFUSAL, "at depth wording the merge is open and the same rule holds");
assert(judge([{ op: "merge", ids: ["m-0082", "m-0032"], text: "- Invoices go out on the first working day; the contract renews on 1 July." }]).length === 0, "a merge that joins one member with a note outside the pair is not judged by the pair");
assert(validateReviewOps([{ op: "archive", id: "m-0081", why: "duplicate" }], CONFLICT_NOTES, "tidy").length === 0, "a caller that hands the validator no pairs gets the validator it had");

// The prompt: one line per pair with both days and both first lines, at either depth, and the rule that every pair is dealt with.
const CONFLICT_LINE = `m-0081 (saved 2 Jun) says "The Nordwind maintenance contract renews automatically on 1 June."; m-0082 (saved 14 Sep) says "The Nordwind maintenance contract renews automatically on 1 July.": the newer date decides; merge them keeping the newer text, or say in the narrative why both stay`;
const CONFLICT_RULE = `Every pair listed under "Notes That Disagree" is dealt with: merge them keeping the newer text, or say in the narrative why both stay.`;
const conflictPrompt = { conflictNotes: [{ ids: ["m-0081", "m-0082"] as [string, string], line: CONFLICT_LINE }] };
const disagreeing = buildReviewGroupPrompt({ ...base, notes: CONFLICT_NOTES, ...findings, ...conflictPrompt, depth: "tidy" });
assert(disagreeing.prompt.includes(`## Material: Notes That Disagree\n\n- ${CONFLICT_LINE}`), "at depth tidy a disagreeing pair is listed as one line, in the words the run builds");
assert(disagreeing.prompt.includes(`Every pair listed under "Notes That Say The Same Twice" is dealt with: merge them, or archive one as duplicate, or say in the narrative why both stay. ${CONFLICT_RULE}`), "the task asks for every disagreeing pair to be dealt with, right after the twins' rule");
assert(disagreeing.prompt.indexOf("## Material: Notes That Say The Same Twice") < disagreeing.prompt.indexOf("## Material: Notes That Disagree") && disagreeing.prompt.indexOf("## Material: Notes That Disagree") < disagreeing.prompt.indexOf("## Material: Topics That Look The Same"), "the disagreeing pairs sit after the twins and before the look-alike topics");
const disagreeingWording = buildReviewGroupPrompt({ ...base, notes: CONFLICT_NOTES, ...conflictPrompt, depth: "wording" });
assert(disagreeingWording.prompt.includes(`## Material: Notes That Disagree\n\n- ${CONFLICT_LINE}`) && disagreeingWording.prompt.includes(CONFLICT_RULE), "at depth wording the pair is listed with the same line and the same rule: a merge is open at either depth");
assert(!disagreeingWording.prompt.includes("Notes That Say The Same Twice"), "the disagree rule stands on its own when there are no twins");
assert(!withFindings.prompt.includes("Notes That Disagree"), "a group with no disagreeing pair carries neither the section nor the rule");

// Applying: the merged row and the archive row of the member that left say why.
const REASON = `1 July (saved 14 Sep) replaces 1 June (saved 2 Jun); the newer date decides`;
const resolved = applyReviewOps(conflictFixture(), [{ op: "merge", ids: ["m-0082", "m-0081"], text: NEWER_TEXT }], { savedDate: "2026-09-14", conflictNotes: [DECIDED] });
const resolvedRow = resolved.changes.find((change) => change.kind === "merged")!;
assert(resolvedRow.id === "m-0082" && resolvedRow.reason === REASON && JSON.stringify(resolvedRow.conflictWith) === JSON.stringify({ id: "m-0081", topic: "Maintenance renewals" }), `a merge that resolves a disagreeing pair carries the reason and names the member that left with its topic, got ${JSON.stringify(resolvedRow)}`);
const resolvedById = new Map(resolved.archive.map((row) => [row.entry.id, row]));
assert(resolvedById.get("m-0081")?.why === "superseded" && resolvedById.get("m-0081")?.reason === REASON, `the member that left is in the archive as superseded with the same reason, got ${JSON.stringify(resolvedById.get("m-0081"))}`);
assert(resolvedById.get("m-0082-v1")?.why === "superseded" && resolvedById.get("m-0082-v1")?.reason === undefined, "the survivor's previous words carry no reason: they lost to nothing");
const olderSurvives = applyReviewOps(conflictFixture(), [{ op: "merge", ids: ["m-0081", "m-0082"], text: NEWER_TEXT }], { savedDate: "2026-09-14", conflictNotes: [DECIDED] });
assert(olderSurvives.changes[0].id === "m-0081" && olderSurvives.changes[0].reason === REASON && olderSurvives.changes[0].conflictWith?.id === "m-0082" && olderSurvives.archive.find((row) => row.entry.id === "m-0082")?.reason === REASON, `when the older note survives with the newer text the reason is the same and the newer member is the one that left, got ${JSON.stringify(olderSurvives.changes[0])}`);
// With equal dates the merged text itself says which value stands.
const undecidedNewer = applyReviewOps(conflictFixture(), [{ op: "merge", ids: ["m-0082", "m-0081"], text: NEWER_TEXT }], { savedDate: "2026-09-14", conflictNotes: [UNDECIDED] });
assert(undecidedNewer.changes[0].reason === `1 July replaces 1 June (both saved 14 Sep)`, `an undecided pair resolved to the second value says so with both days as one, got ${JSON.stringify(undecidedNewer.changes[0].reason)}`);
const undecidedOlder = applyReviewOps(conflictFixture(), [{ op: "merge", ids: ["m-0081", "m-0082"], text: OLDER_TEXT }], { savedDate: "2026-09-14", conflictNotes: [UNDECIDED] });
assert(undecidedOlder.changes[0].reason === `1 June replaces 1 July (both saved 14 Sep)`, `an undecided pair resolved to the first value says that, not the other way round, got ${JSON.stringify(undecidedOlder.changes[0].reason)}`);
// A merge of notes that are no pair says nothing more, and neither does a caller that hands over no pairs.
const plainMerge = applyReviewOps(conflictFixture(), [{ op: "merge", ids: ["m-0041", "m-0032"], text: "- Summaries go out as one page, numbers first; invoices on the first working day." }], { savedDate: "2026-09-14", conflictNotes: [DECIDED] });
assert(plainMerge.changes[0].reason === undefined && plainMerge.changes[0].conflictWith === undefined && plainMerge.archive.every((row) => row.reason === undefined), "a merge outside the pair carries no reason and no partner");
const unaware = applyReviewOps(conflictFixture(), [{ op: "merge", ids: ["m-0082", "m-0081"], text: NEWER_TEXT }], { savedDate: "2026-09-14" });
assert(unaware.changes[0].reason === undefined && unaware.archive.every((row) => row.reason === undefined), "without the pairs the applier is the applier it was");

console.log("review-ops-smoke: OK");
