// Review — the note operation layer (memory v2), the pure layer.
//
// Review stops rewriting whole topics. The old pass handed a model the text of
// an area and took its prose back, which re-attached nothing: every note in a
// rewritten topic lost its id, its saved-on date and its pin the moment the
// result was saved. Memory v2 made every note an addressable entry, so Review
// now speaks the same way Memorize does — a short list of operations against
// notes named by id, checked here and applied to the parsed document, which is
// rendered back with every note's metadata intact.
//
// Everything a promise depends on is a predicate here, not prompt text:
//   - a note the tidy does not NAME is never touched, so stamps, provenance and
//     pinned notes survive by construction;
//   - a pinned note is the user's: it may be worded better and nothing else,
//     and the refusal says so;
//   - Review makes notes SHORTER: an update or a merge whose text outgrows what
//     it replaced is refused, so "tidy" can never mean "write more";
//   - nothing is deleted: the archive is the only exit, and every row carries
//     the reason it left;
//   - the depth the person chose is enforced here, so "Tidy the wording" cannot
//     archive anything whatever the model answers.
//
// Nothing here talks to a model, a route or the disk: the prompt is a string,
// the parser is a reader, the applier works on a document value. The run owns
// the call, the retry, the budget pass and the write.

import {
	applyUserEdit,
	cloneDocument,
	entryTokens,
	findEntryLocation,
	findStructuralLine,
	memoryAreaId,
	MEMORY_SECTIONS,
	nextVersionedEntryId,
	renderMemoryDocument,
	type ArchiveReason,
	type EntryKind,
	type MemoryDocument,
	type MemoryEntry,
	type MemorySection,
	type MemoryTopic,
} from "./memory-entries.js";
import { nearDuplicateTopicTitle } from "./absorb-ops.js";
import { reviewGuidanceIsEmpty, type ReviewGuidance } from "./review-guidance.js";
import { estimateTokens } from "./token-estimate.js";

export const REVIEW_TIDY_WORKER_TYPE = "review-tidy-worker" as const;
export const REVIEW_TIDY_MODE = "note_review" as const;

/** The worker's whole user turn: the prompt carries the notes, this asks for the tidy. */
export const REVIEW_TRIGGER_PROMPT = "Tidy these notes now.";

// --- Depth -------------------------------------------------------------------

/**
 * What the person chose on the first read. "wording" says the same things in
 * fewer words; "tidy" may also move what is finished or stale to the archive.
 * The difference is enforced by the validator, never by asking the model nicely.
 */
export type ReviewDepth = "wording" | "tidy";

export const REVIEW_DEPTHS: readonly ReviewDepth[] = ["wording", "tidy"];

// --- Bounds ------------------------------------------------------------------

/** The reply's hard shape: a tidy is a handful of operations over one group, never a rewrite. */
export const REVIEW_MAX_OPS = 24;
/** The longest a note may be after a tidy — the same ceiling a person's own edit has. */
export const REVIEW_MAX_TEXT_CHARS = 2000;
/**
 * How much longer than what it replaces an operation's text may be, in
 * characters. Review exists to make memory smaller; a "tidy" that returns a
 * longer note has misunderstood the job. The slack is a fixed handful of
 * characters rather than a share of the source, so a genuinely equal rewording
 * is never refused over a comma or an article, and growth always is.
 */
export const REVIEW_GROWTH_SLACK_CHARS = 12;
export const REVIEW_TOPIC_TITLE_MIN_CHARS = 2;
export const REVIEW_TOPIC_TITLE_MAX_CHARS = 60;

// --- Grammar -----------------------------------------------------------------

export const REVIEW_OP_KINDS = ["update", "merge", "archive", "close", "pin", "move", "merge_topics"] as const;
export type ReviewOpKind = (typeof REVIEW_OP_KINDS)[number];

/** Why a note is leaving memory, in the words the model is given. */
export const REVIEW_ARCHIVE_WHYS = ["stale", "finished", "duplicate"] as const;
export type ReviewArchiveWhy = (typeof REVIEW_ARCHIVE_WHYS)[number];

/** The archive's own reasons, which is what the row on disk carries. */
const ARCHIVE_REASON_OF: Readonly<Record<ReviewArchiveWhy, ArchiveReason>> = {
	stale: "stale",
	duplicate: "duplicate",
	finished: "done",
};

/** The ops each depth allows. "wording" changes words and places; "tidy" may also archive and fold a topic into another. */
const DEPTH_OPS: Readonly<Record<ReviewDepth, readonly ReviewOpKind[]>> = {
	wording: ["update", "merge", "pin", "move"],
	tidy: REVIEW_OP_KINDS,
};

/** The ops a pinned note refuses: a tidy may word it better and nothing else. */
const PIN_PROTECTED_OPS = ["archive", "close"] as const;

/**
 * Keys the grammar does not define, kept by the parser so the validator can
 * refuse them by name: an op carrying a foreign key is an op whose author was
 * writing a different grammar, and the fields it did fill cannot be trusted.
 */
interface ReviewOpExtras {
	foreignKeys?: string[];
}

export type ReviewOp = ReviewOpExtras & (
	| { op: "update"; id: string; text: string }
	| { op: "merge"; ids: string[]; text: string }
	| { op: "archive"; id: string; why: ReviewArchiveWhy }
	| { op: "close"; id: string }
	| { op: "pin"; id: string; because?: string }
	| { op: "move"; id: string; topic: string }
	| { op: "merge_topics"; from: string; into: string }
);

const OP_FIELDS: Readonly<Record<ReviewOpKind, readonly string[]>> = {
	update: ["op", "id", "text"],
	merge: ["op", "ids", "text"],
	archive: ["op", "id", "why"],
	close: ["op", "id"],
	pin: ["op", "id", "because"],
	move: ["op", "id", "topic"],
	merge_topics: ["op", "from", "into"],
};

// --- The group ---------------------------------------------------------------

/** One note as the group hands it to the validator: its address, its size and its words. */
export interface ReviewNote {
	id: string;
	section: MemorySection;
	topic: string;
	kind: EntryKind;
	pinned: boolean;
	status?: "open" | "done";
	tokens: number;
	text: string;
}

/** One topic of a group: its notes, and the address every refusal names it by. */
export interface ReviewGroupTopic {
	section: MemorySection;
	title: string;
	notes: ReviewNote[];
	tokens: number;
	/** The paragraph the topic opens with before its first note, when it has one: a topic with one is not folded. */
	intro: string;
}

/** The notes of one topic, as the run reads them off the document. */
export function reviewGroupTopic(topic: MemoryTopic): ReviewGroupTopic {
	const notes = topic.entries.map((entry) => reviewNote(entry, topic));
	return { section: topic.section, title: topic.title, notes, tokens: notes.reduce((sum, note) => sum + note.tokens, 0), intro: topic.intro };
}

export function reviewNote(entry: MemoryEntry, topic: { section: MemorySection; title: string }): ReviewNote {
	return {
		id: entry.id,
		section: topic.section,
		topic: topic.title,
		kind: entry.kind,
		pinned: entry.pinned,
		...(entry.status ? { status: entry.status } : {}),
		tokens: entryTokens(entry),
		text: entry.text,
	};
}

export function reviewGroupNotes(group: readonly ReviewGroupTopic[]): ReviewNote[] {
	return group.flatMap((topic) => topic.notes);
}

export function reviewGroupTokens(group: readonly ReviewGroupTopic[]): number {
	return group.reduce((sum, topic) => sum + topic.tokens, 0);
}

/** How a group is named to a person: its first topic, and how many others ride with it. */
export function reviewGroupLabel(group: readonly ReviewGroupTopic[]): string {
	if (group.length === 0) return "";
	const first = group[0].title;
	const others = group.length - 1;
	return others === 0 ? first : `${first} and ${others} more ${others === 1 ? "topic" : "topics"}`;
}

/**
 * The share of the model's output cap a group's note text may take, and the
 * floor below which a room would be sliced into single topics. The same
 * arithmetic the previous Review used, on notes rather than areas: the reply
 * scales with what may be rewritten, not with the memory that is read.
 */
export const REVIEW_REPLY_SOURCE_SHARE = 0.35;
export const REVIEW_REPLY_SOURCE_FLOOR_TOKENS = 3_000;
/** The cap assumed when the model's window is unknown: the default for a gateway row with no published cap. */
export const REVIEW_DEFAULT_MAX_OUTPUT_TOKENS = 16_384;

export function reviewReplySourceBudget(maxOutputTokens?: number): number {
	const cap = typeof maxOutputTokens === "number" && Number.isFinite(maxOutputTokens) && maxOutputTokens > 0 ? maxOutputTokens : REVIEW_DEFAULT_MAX_OUTPUT_TOKENS;
	return Math.max(REVIEW_REPLY_SOURCE_FLOOR_TOKENS, Math.floor(cap * REVIEW_REPLY_SOURCE_SHARE));
}

/** A pair of topic titles that must be tidied in one call: the two halves of a duplicate, or two headings that look like one topic. */
export type ReviewTopicBond = readonly [string, string];

function sameTitle(a: string, b: string): boolean {
	return a.trim().toLowerCase() === b.trim().toLowerCase();
}

/**
 * The topics as units the partitioner packs: a topic on its own, or every
 * topic a chain of bonds ties together, in document order. A bond naming a
 * title that is not here, or two titles of different sections, ties nothing;
 * the section rule is the partitioner's and a unit never crosses it.
 */
function bondedUnits(topics: readonly ReviewGroupTopic[], bonds: readonly ReviewTopicBond[]): ReviewGroupTopic[][] {
	const parent = topics.map((_, index) => index);
	const root = (index: number): number => {
		while (parent[index] !== index) { parent[index] = parent[parent[index]]; index = parent[index]; }
		return index;
	};
	for (const [a, b] of bonds) {
		const i = topics.findIndex((topic) => sameTitle(topic.title, a));
		const j = topics.findIndex((topic) => sameTitle(topic.title, b));
		if (i < 0 || j < 0 || i === j || topics[i].section !== topics[j].section) continue;
		parent[root(i)] = root(j);
	}
	const members = new Map<number, ReviewGroupTopic[]>();
	topics.forEach((topic, index) => {
		const key = root(index);
		const unit = members.get(key);
		if (unit) unit.push(topic);
		else members.set(key, [topic]);
	});
	const emitted = new Set<number>();
	const units: ReviewGroupTopic[][] = [];
	topics.forEach((_, index) => {
		const key = root(index);
		if (emitted.has(key)) return;
		emitted.add(key);
		units.push(members.get(key)!);
	});
	return units;
}

/**
 * One group when every topic fits the budget together — the single call.
 * Otherwise consecutive topics of one section whose notes sum to the budget or
 * less; a topic larger than the budget is a group of its own. Document order is
 * kept, so a group's topics are neighbours and a merge inside it stays
 * meaningful. Bonded titles travel as one unit and are never split across two
 * groups: a duplicate pair or two look-alike topics always reach one call,
 * and a unit larger than the budget is one oversize group, as an oversize
 * topic is.
 */
export function partitionReviewTopics(topics: readonly ReviewGroupTopic[], budgetTokens: number, bonds: readonly ReviewTopicBond[] = []): ReviewGroupTopic[][] {
	if (topics.length === 0) return [];
	if (reviewGroupTokens(topics) <= budgetTokens) return [[...topics]];
	const groups: ReviewGroupTopic[][] = [];
	let current: ReviewGroupTopic[] = [];
	let size = 0;
	for (const unit of bondedUnits(topics, bonds)) {
		const tokens = reviewGroupTokens(unit);
		const fits = current.length > 0 && current[0].section === unit[0].section && size + tokens <= budgetTokens;
		if (!fits && current.length > 0) { groups.push(current); current = []; size = 0; }
		current.push(...unit);
		size += tokens;
	}
	if (current.length > 0) groups.push(current);
	return groups;
}

// --- Small shared readers ----------------------------------------------------

const LINE_TERMINATORS_G = /\r\n?|[\u2028\u2029]/g;

function toLf(text: string): string {
	return text.replace(LINE_TERMINATORS_G, "\n");
}

function toLines(text: string): string[] {
	return toLf(text).split("\n");
}

function normalizeLine(value: string): string {
	return value.replace(/\s+/g, " ").trim();
}

function truncate(value: string, max = 80): string {
	const one = normalizeLine(value);
	return one.length <= max ? one : `${one.slice(0, max - 1)}…`;
}

/** A bullet the way the memory writes one: "- ", "* " or "+ " at the start of the line. */
const BULLET_START = /^\s*[-*+]\s+\S/;

function firstLineOf(text: string): string {
	return toLines(text).find((line) => line.trim()) ?? "";
}

// --- The tidy prompt ---------------------------------------------------------

export interface ReviewGroupPromptInput {
	agentId: string;
	model: { provider: string; model: string };
	/** The group's topics as the room reads them, every note carrying its id in its first line. */
	topics: string;
	/** The notes the group holds — what the validator judges the reply against. */
	notes: ReviewNote[];
	depth: ReviewDepth;
	guidance: ReviewGuidance;
	groupIndex: number;
	groupCount: number;
	/** Pairs of notes in THIS group that say one thing, by id, as the machine found them. */
	duplicateNotes?: readonly { ids: readonly [string, string] }[];
	/** Pairs of topics in THIS group that look like one topic, as the machine found them. */
	lookAlikeTopics?: readonly { a: string; b: string }[];
	/** Reasons a previous reply was refused, repeated as a Retry Notice. */
	retryFeedback?: string[];
	now?: Date;
}

export interface ReviewPromptAssembly {
	prompt: string;
	telemetry: { promptChars: number; promptEstimatedTokens: number; noteCount: number };
}

/**
 * The tidy constitution — the fold constitution's voice and its governing
 * principle, must-keep rule and pinned-entry rule, restated for a worker that
 * shortens notes that are already in memory instead of folding new ones in.
 */
export function reviewConstitution(): string {
	return `# exxperts Review Constitution

You are a platform-owned review worker inside exxperts.

You are not the persistent agent. You are not participating in ordinary chat. You are an ephemeral hidden maintenance process invoked to tidy notes that are already in the room's memory.

This operation must not write memory, archive files, mutate core memory, update Chronos, or create sidecar event records. You emit operations. The system validates them, applies them to a working copy, and puts the result to the user for approval.

## Governing Principle

Say the same things in fewer, sharper words. A review adds nothing and discovers nothing: every note you are given is already something this room knows, and your job is to make it cost less to read. A note that comes back longer than it went in is a failure of this job, and the system refuses it.

## Scope

- Read the notes below. Every note opens with its own id in square brackets, which is the only way you address it; the brackets are the system's, never part of a note's words.
- Word a note better when it says one point at length: keep the point, the names, the numbers and the dates exactly, and drop the padding around them.
- Merge notes that say one thing between them, so the room reads one note instead of three.
- Leave a note alone when it is already as short as it can be. A review that touches everything is a rewrite.
- Never invent, never generalise, never combine two different points into one vaguer one, and never drop a name, a number, a date or a commitment.

## The User's Words

These notes are read by a business user, not by an engineer. Write them the way the room writes them: plain sentences about the work, no jargon of the system, no talk of entries, ids, sections, tokens or budgets.

## Must-Keep And Pinned Notes

A note whose words carry the **must-keep** marker is the user's own explicit request: carry the marker with it and keep its commitments, numbers, names and dates exact. A pinned note says so in its address — it reads \`[m-0032 · pinned]\`. A pinned note may be worded better and nothing else: it is never moved to the archive and never closed, and an operation that tries is refused.

## Boundaries

- Do not include or request L1a.
- Do not roleplay as the persistent room agent.
- Do not claim memory has been saved.
- Do not touch a note you do not name: everything you do not address is copied through unchanged.
- Do not address a note that is not in the group below.
`;
}

/** The address legend: how a note is named, and nothing more. */
function renderNoteLegend(notes: readonly ReviewNote[]): string {
	return [
		`Every note above opens with its own id in square brackets: \`- [m-0031] The Nordwind contract renews annually…\` is the note \`m-0031\`. A note written as \`- [m-0032 · pinned] …\` is pinned — it is the user's own, and may only be worded better.`,
		`The brackets are the address, not part of the note's words. Copy an id exactly as it stands there, address only the ${notes.length} note${notes.length === 1 ? "" : "s"} listed above, and never write a bracketed id into the text of an operation.`,
	].join("\n\n");
}

/** The guidance the user signed off, rendered as instructions the tidy must honour. */
export function renderReviewGuidance(guidance: ReviewGuidance): string {
	if (reviewGuidanceIsEmpty(guidance)) return "The user signed off without further instructions. Follow the first read.";
	const parts: string[] = [];
	const list = (lines: string[]) => lines.map((line) => `- ${line}`).join("\n");
	if (guidance.keepAsIs.length > 0) parts.push(`The user asked for these to be left exactly as they are. Do not name them in any operation:\n${list(guidance.keepAsIs)}`);
	if (guidance.shorten.length > 0) parts.push(`The user asked for these to be made shorter:\n${list(guidance.shorten)}`);
	if (guidance.remove.length > 0) parts.push(`The user asked for these to go to the archive, with the reason given:\n${list(guidance.remove)}`);
	if (guidance.answers.length > 0) parts.push(`The user answered the questions the first read asked. These answers are newer than the notes, so where they conflict the answer wins:\n${list(guidance.answers)}`);
	if (guidance.instructions.length > 0) parts.push(`Standing instructions for this tidy:\n${list(guidance.instructions)}`);
	return parts.join("\n\n");
}

function reviewOpShapes(depth: ReviewDepth): string[] {
	const shapes: string[] = [
		`- \`{"op":"update","id":"<note id>","text":"- <the note, in fewer words>"}\` — the same point, said better. The note keeps its id, its date and its pin, and the words it replaces are kept as its previous version, so nothing is lost. The new text must be SHORTER than the one it replaces.`,
		`- \`{"op":"merge","ids":["<note id>","<note id>"],"text":"- <the one note>"}\` — two or more notes that say one thing become one. The first id survives with the new text; the others are kept as its previous versions. The new text must be shorter than the notes it replaces, taken together.`,
		`- \`{"op":"pin","id":"<note id>","because":"<why this must never be tidied away>"}\` — a note the user should own from here on. Use it sparingly.`,
		`- \`{"op":"move","id":"<note id>","topic":"<topic title>"}\` — the note is filed under the wrong subject. "topic" is a topic title of the memory, or a new one of ${REVIEW_TOPIC_TITLE_MIN_CHARS}–${REVIEW_TOPIC_TITLE_MAX_CHARS} characters without "#" heading marks.`,
	];
	if (DEPTH_OPS[depth].includes("archive")) {
		shapes.push(`- \`{"op":"archive","id":"<note id>","why":"stale"}\` — the note leaves memory for the archive, where it stays findable. "why" is "stale" when it no longer holds, "duplicate" when another note already carries the point, "finished" when the work it describes is done.`);
		shapes.push(`- \`{"op":"close","id":"<note id>"}\` — an open item the work has finished. Close it rather than rewriting it as done.`);
	}
	if (DEPTH_OPS[depth].includes("merge_topics")) {
		shapes.push(`- \`{"op":"merge_topics","from":"<topic title>","into":"<topic title>"}\` — two topics that are one subject become one: every note of "from" moves to the end of "into" unchanged, and the "from" heading goes. Both titles are copied exactly as they are listed; "from" is a topic of this group, "into" any topic of the memory. Open items are never folded, and a topic that opens with a paragraph of its own is not folded either — move its notes one by one instead.`);
	}
	return shapes;
}

/**
 * The machine's findings for this group, one section each: the pairs of
 * notes that say one thing, and the pairs of topics that look like one. Each
 * line says what to do about the pair; at depth wording the archive is not
 * open, so the line offers the merge alone.
 */
function groupFindingsSections(input: ReviewGroupPromptInput): string[] {
	const sections: string[] = [];
	if (input.duplicateNotes?.length) {
		const remedy = DEPTH_OPS[input.depth].includes("archive") ? "merge them into one note, or archive one of them as duplicate" : "merge them into one note";
		sections.push(`## Material: Notes That Say The Same Twice\n\n${input.duplicateNotes.map((pair) => `- ${pair.ids[0]} and ${pair.ids[1]} say the same thing: ${remedy}.`).join("\n")}`);
	}
	if (input.lookAlikeTopics?.length && DEPTH_OPS[input.depth].includes("merge_topics")) {
		sections.push(`## Material: Topics That Look The Same\n\n${input.lookAlikeTopics.map((pair) => `- "${pair.a}" and "${pair.b}" look like one topic: fold the one with fewer notes into the other with merge_topics, unless they are two subjects after all.`).join("\n")}`);
	}
	return sections;
}

function reviewTaskSection(input: ReviewGroupPromptInput): string {
	const depthLine = input.depth === "wording"
		? `The user chose to tidy the WORDING only. Nothing leaves memory in this pass: there is no archive and no close operation, and an operation that tries to remove a note is refused.`
		: `The user chose to tidy the wording AND move what is finished or stale to the archive. Nothing is deleted: the archive keeps everything that leaves, with the reason it left.`;
	const duplicatesLine = input.duplicateNotes?.length
		? DEPTH_OPS[input.depth].includes("archive")
			? `Every pair listed under "Notes That Say The Same Twice" is dealt with: merge them, or archive one as duplicate, or say in the narrative why both stay.`
			: `Every pair listed under "Notes That Say The Same Twice" is dealt with: merge them, or say in the narrative why both stay.`
		: "";
	return [
		"## Task: Tidy These Notes (operations)",
		`You do not rewrite the memory. You emit operations against the notes above, each named by the id in its first line; the system applies them and puts the result to the user. A note you do not name is copied through unchanged — its words, its date and its pin survive without any effort on your part, so name only what you are actually improving.`,
		depthLine,
		`Operation shapes (copy a note id exactly as it stands in its brackets, without them):\n\n${reviewOpShapes(input.depth).join("\n")}`,
		`Rules: at most ${REVIEW_MAX_OPS} operations for this group; each "text" is at most ${REVIEW_MAX_TEXT_CHARS} characters, is written the way its topic is written (a bullet starting "- " unless the topic's notes are paragraphs), and carries no bracketed id of its own; one operation per note; every id is one of the notes above; a pinned note takes no archive and no close. An operation that breaks a rule is refused with its reason and this group is asked for again, so prefer fewer, exact operations.${duplicatesLine ? ` ${duplicatesLine}` : ""}`,
		`Answer with the narrative and then the operations: at most three lines saying what you tidied and why, then exactly one \`\`\`json fence holding \`{"ops": [ ... ]}\`. Nothing follows the fence. An empty list is a valid answer when these notes are already as short as they can be — say so in the narrative and return \`{"ops": []}\`. Do not claim anything has been saved.`,
	].join("\n\n");
}

/** The Retry Notice, the shape every maintenance worker's retry takes. */
function retryNotice(reasons: string[]): string {
	return `## Retry Notice\n\nYour previous operations were refused:\n\n${reasons.map((reason) => `- ${reason}`).join("\n")}\n\nAnswer again with the narrative and exactly one \`\`\`json fence holding \`{"ops": [ ... ]}\`, resolving every reason above. Copy note ids exactly as they are listed, and name only the notes you are actually improving.`;
}

/**
 * The tidy prompt: constitution, the group's topics as the room reads them with
 * every note's address in its own first line, the legend that reads those
 * addresses, the signed-off guidance, and the task at the chosen depth.
 */
export function buildReviewGroupPrompt(input: ReviewGroupPromptInput): ReviewPromptAssembly {
	const now = input.now ?? new Date();
	const sections = [
		reviewConstitution().trim(),
		`## Process Metadata\n\n- Agent id: ${input.agentId}\n- Process type: ${REVIEW_TIDY_WORKER_TYPE}\n- Mode: ${REVIEW_TIDY_MODE}\n- Trigger time: ${now.toISOString()}\n- System-selected model: ${input.model.provider}/${input.model.model}\n- Writes memory: false\n- Depth: ${input.depth}\n- Group: ${input.groupIndex} of ${input.groupCount}\n- Notes in this group: ${input.notes.length}`,
		`## Material: The Notes To Tidy\n\nThese are the notes of this group as the room reads them. Note metadata is stripped; each note carries its own address in its first line, which is how you name it.\n\n${input.topics.trim()}`,
		`## Material: How To Address A Note\n\n${renderNoteLegend(input.notes)}`,
		...groupFindingsSections(input),
		`## Material: The User's Instructions From The Discussion\n\n${renderReviewGuidance(input.guidance)}`,
		reviewTaskSection(input),
	];
	if (input.retryFeedback?.length) sections.push(retryNotice(input.retryFeedback));
	const prompt = sections.join("\n\n---\n\n") + "\n";
	return {
		prompt,
		telemetry: { promptChars: prompt.length, promptEstimatedTokens: estimateTokens(prompt), noteCount: input.notes.length },
	};
}

/**
 * The same Retry Notice appended to a prompt that was already assembled — the
 * run's path on a refused reply, so the model sees the material it was given
 * once and the reasons after it, never a second notice stacked on the first.
 */
export function buildReviewRetryPrompt(prompt: string, reasons: string[]): string {
	return `${prompt.trimEnd()}\n\n---\n\n${retryNotice(reasons)}\n`;
}

/**
 * The group's topics as the room reads them, every note carrying its id in its
 * first line — the same render the fold prompt's core context uses, on the
 * topics of this group alone.
 */
export function renderReviewGroupContext(group: readonly ReviewGroupTopic[], doc: MemoryDocument): string {
	const wanted = new Set(group.map((topic) => memoryAreaId(topic.section, topic.title)));
	const partial: MemoryDocument = {
		...cloneDocument(doc),
		topics: doc.topics.filter((topic) => wanted.has(memoryAreaId(topic.section, topic.title))).map((topic) => ({ ...topic, entries: topic.entries.map((entry) => ({ ...entry })) })),
	};
	return renderMemoryDocument(partial, "context", { entryIds: true, sections: MEMORY_SECTIONS }).trim();
}

// --- Reading the reply -------------------------------------------------------

/**
 * An unreadable fence, returned rather than thrown: a tidy call that came back
 * cut is an ordinary outcome of the loop (that group is left as it was and the
 * run carries on), never an exception the route has to catch to stay alive.
 */
export class ReviewOpsJsonProblem {
	constructor(readonly problem: string) {}
}

export function isReviewOpsJsonProblem(value: unknown): value is ReviewOpsJsonProblem {
	return value instanceof ReviewOpsJsonProblem;
}

interface Fence {
	label: string;
	body: string;
	start: number;
}

function completeFences(raw: string): Fence[] {
	const fences: Fence[] = [];
	const fenceRe = /^[ \t]*```([^\s`]*)[^\n]*\r?\n([\s\S]*?)\r?\n[ \t]*```/gm;
	for (let m = fenceRe.exec(raw); m; m = fenceRe.exec(raw)) {
		fences.push({ label: m[1].toLowerCase(), body: m[2], start: m.index });
	}
	return fences;
}

/** Fence markers are counted at line starts only: a ``` inside a JSON string is mid-line and never a fence. */
function fenceMarkerCount(raw: string): number {
	return (toLf(raw).match(/^[ \t]*```/gm) ?? []).length;
}

function chooseFence(fences: Fence[]): Fence | undefined {
	const labelled = fences.filter((fence) => fence.label === "json" || fence.label === "");
	const pool = labelled.length > 0 ? labelled : fences;
	return pool[pool.length - 1];
}

/**
 * The operations JSON of a tidy reply: the LAST fence, labelled json or not,
 * whatever prose surrounds it. Returns the parsed value, or a problem naming
 * why the reply carries no readable fence. Never throws.
 */
export function extractReviewOpsJson(reply: string): unknown {
	const raw = toLf(reply);
	const fences = completeFences(raw);
	if (fenceMarkerCount(raw) % 2 === 1) {
		return new ReviewOpsJsonProblem(fences.length > 0
			? "the reply was cut off inside a ```json fence; the operations after the last complete fence are unreadable"
			: "the reply was cut off inside its ```json fence and holds no complete operations block");
	}
	const fence = chooseFence(fences);
	if (!fence) return new ReviewOpsJsonProblem('the reply has no ```json fence; end the answer with exactly one fence holding {"ops": [ ... ]}');
	if (!fence.body.trim()) return new ReviewOpsJsonProblem('the reply\'s ```json fence is empty; it must hold {"ops": [ ... ]}');
	try {
		return JSON.parse(fence.body);
	} catch (error) {
		return new ReviewOpsJsonProblem(`the reply's \`\`\`json fence is not valid JSON (${(error as Error).message})`);
	}
}

export interface ParsedReviewOps {
	ops: ReviewOp[];
	/** Named reasons the reply is not an op list; empty means it parsed. Written for the model's retry. */
	problems: string[];
	/** What the model said before the fence — kept for the record and the diagnostics, shown to nobody as truth. */
	narrative: string;
}

const NARRATIVE_TRAILING_LABEL = /(?:^|\n)[ \t]*#{1,6}[ \t]*[^\n]*$/;

function narrativeBefore(raw: string, fenceStart: number | undefined): string {
	const before = (fenceStart === undefined ? raw : raw.slice(0, fenceStart)).trim();
	const withoutLabel = before.replace(NARRATIVE_TRAILING_LABEL, "").trim();
	return withoutLabel || before;
}

const isString = (value: unknown): value is string => typeof value === "string";

function foreignKeysOf(item: Record<string, unknown>, kind: ReviewOpKind): string[] {
	const known = new Set(OP_FIELDS[kind]);
	return Object.keys(item).filter((key) => !known.has(key));
}

/** The parsed ops of a tidy reply plus the narrative that preceded them. Never throws. */
export function parseReviewOps(reply: string): ParsedReviewOps {
	const raw = toLf(reply);
	const fence = chooseFence(completeFences(raw));
	const narrative = narrativeBefore(raw, fence?.start);
	const parsed = extractReviewOpsJson(reply);
	if (isReviewOpsJsonProblem(parsed)) return { ops: [], problems: [parsed.problem], narrative };
	const list = Array.isArray(parsed) ? parsed : (parsed as { ops?: unknown })?.ops;
	if (!Array.isArray(list)) return { ops: [], problems: ['the JSON must be an object with an "ops" array'], narrative };
	const ops: ReviewOp[] = [];
	const problems: string[] = [];
	list.forEach((value: unknown, index: number) => {
		const label = `op ${index + 1}`;
		const item = (value && typeof value === "object" ? value : {}) as Record<string, unknown>;
		const kind = item.op;
		if (!isString(kind) || !(REVIEW_OP_KINDS as readonly string[]).includes(kind)) {
			problems.push(`${label}: "op" must be one of ${REVIEW_OP_KINDS.join(", ")}`);
			return;
		}
		const opKind = kind as ReviewOpKind;
		const foreign = foreignKeysOf(item, opKind);
		const extras: ReviewOpExtras = foreign.length > 0 ? { foreignKeys: foreign } : {};
		const id = isString(item.id) ? item.id.trim() : "";
		const text = isString(item.text) ? item.text : "";
		switch (opKind) {
			case "update": {
				if (!id) return problems.push(`${label} (update): "id" is required — copy a note id exactly as it is listed`);
				if (!text.trim()) return problems.push(`${label} (update): "text" must be the note as it should now read`);
				return void ops.push({ ...extras, op: "update", id, text });
			}
			case "merge": {
				const ids = (Array.isArray(item.ids) ? item.ids : []).filter(isString).map((value) => value.trim()).filter(Boolean);
				if (ids.length < 2) return problems.push(`${label} (merge): "ids" must list at least two note ids, copied exactly as they are listed`);
				if (!text.trim()) return problems.push(`${label} (merge): "text" must be the one note the merged notes become`);
				return void ops.push({ ...extras, op: "merge", ids, text });
			}
			case "archive": {
				if (!id) return problems.push(`${label} (archive): "id" is required — copy a note id exactly as it is listed`);
				if (!isString(item.why) || !(REVIEW_ARCHIVE_WHYS as readonly string[]).includes(item.why)) {
					return problems.push(`${label} (archive): "why" must be one of ${REVIEW_ARCHIVE_WHYS.join(", ")}`);
				}
				return void ops.push({ ...extras, op: "archive", id, why: item.why as ReviewArchiveWhy });
			}
			case "close": {
				if (!id) return problems.push(`${label} (close): "id" is required — copy a note id exactly as it is listed`);
				return void ops.push({ ...extras, op: "close", id });
			}
			case "pin": {
				if (!id) return problems.push(`${label} (pin): "id" is required — copy a note id exactly as it is listed`);
				const because = isString(item.because) ? item.because : undefined;
				return void ops.push({ ...extras, op: "pin", id, ...(because === undefined ? {} : { because }) });
			}
			case "move": {
				if (!id) return problems.push(`${label} (move): "id" is required — copy a note id exactly as it is listed`);
				const topic = isString(item.topic) ? item.topic.trim() : "";
				if (!topic) return problems.push(`${label} (move): "topic" is required — the topic title this note belongs under`);
				return void ops.push({ ...extras, op: "move", id, topic });
			}
			case "merge_topics": {
				const from = isString(item.from) ? item.from.trim() : "";
				const into = isString(item.into) ? item.into.trim() : "";
				if (!from) return problems.push(`${label} (merge_topics): "from" is required — the title of the topic to fold, copied exactly as it is listed`);
				if (!into) return problems.push(`${label} (merge_topics): "into" is required — the title of the topic that stays, copied exactly as it is listed`);
				return void ops.push({ ...extras, op: "merge_topics", from, into });
			}
		}
	});
	return { ops, problems, narrative };
}

// --- Validation --------------------------------------------------------------

function nearestNoteId(id: string, notes: readonly ReviewNote[]): string | undefined {
	const wanted = id.toLowerCase().replace(/[^a-z0-9]/g, "");
	if (!wanted) return undefined;
	for (const note of notes) if (note.id.toLowerCase().replace(/[^a-z0-9]/g, "") === wanted) return note.id;
	return undefined;
}

function sameTopic(a: string, b: string): boolean {
	return a.trim().toLowerCase() === b.trim().toLowerCase();
}

/** True when a topic writes its notes as bullets; a topic nobody has yet starts as bullets. */
function topicWantsBullets(topic: string, notes: readonly ReviewNote[]): boolean {
	const rows = notes.filter((note) => sameTopic(note.topic, topic));
	if (rows.length === 0) return true;
	return rows.some((row) => BULLET_START.test(firstLineOf(row.text)));
}

function refuseTopicTitle(title: string, label: string, refusals: string[]): void {
	if (/^#{1,6}\s/.test(title) || /^#{1,6}$/.test(title)) {
		refusals.push(`${label}: give the topic title without "#" heading marks`);
		return;
	}
	if (title.length < REVIEW_TOPIC_TITLE_MIN_CHARS || title.length > REVIEW_TOPIC_TITLE_MAX_CHARS) {
		refusals.push(`${label}: a topic title is ${REVIEW_TOPIC_TITLE_MIN_CHARS}–${REVIEW_TOPIC_TITLE_MAX_CHARS} characters; "${truncate(title)}" is ${title.length}`);
		return;
	}
	if (/^[\s:]*$/.test(title)) refusals.push(`${label}: "${truncate(title)}" is punctuation, not a topic title`);
}

/**
 * The one sentence the whole feature turns on: Review makes notes shorter. The
 * measure is characters, because that is what the room pays for and what the
 * estimator counts; the rule is source plus `REVIEW_GROWTH_SLACK_CHARS`, so a
 * genuine rewording is never refused over punctuation and nothing longer than
 * that ever passes. A merge is measured against its members taken together.
 */
export const REVIEW_GROWTH_REFUSAL = "Review makes notes shorter";

function refuseGrowth(text: string, sourceChars: number, label: string, refusals: string[]): void {
	const limit = sourceChars + REVIEW_GROWTH_SLACK_CHARS;
	if (text.length > limit) {
		refusals.push(`${label}: ${REVIEW_GROWTH_REFUSAL} — the new text is ${text.length} characters against ${sourceChars} it replaces, and may be at most ${REVIEW_GROWTH_SLACK_CHARS} characters longer than that; say the same point in fewer words`);
	}
}

function refuseTextShape(text: string, topic: string, notes: readonly ReviewNote[], label: string, refusals: string[]): void {
	if (text.length > REVIEW_MAX_TEXT_CHARS) {
		refusals.push(`${label}: the text is ${text.length} characters; a note is at most ${REVIEW_MAX_TEXT_CHARS}`);
	}
	if (topicWantsBullets(topic, notes) && !BULLET_START.test(firstLineOf(text))) {
		refusals.push(`${label}: the notes of "${topic}" are bullets, so the text must start with "- "`);
	}
	if (/\[[A-Za-z][\w-]*\]/.test(firstLineOf(text))) {
		refusals.push(`${label}: the text carries a bracketed id; the brackets are the system's address for a note, never part of its words`);
	}
	// A heading line or a comment line inside a note is not a note: written
	// into the file it would open a topic or forge a metadata line, so the
	// same rule the hand-edit route applies holds for a tidy's text.
	const structural = findStructuralLine(text);
	if (structural !== null) {
		refusals.push(`${label}: the text carries a heading or a comment line (${JSON.stringify(structural.trim())}); a note is plain text`);
	}
}

/** A topic of the memory as a fold is judged against it: its title, its section, and whether it opens with a paragraph. */
export interface ReviewMemoryTopic {
	section: MemorySection;
	title: string;
	intro?: string;
}

/**
 * What the validator knows about the memory beyond the group's notes, for
 * folding one topic into another: the group's own topics (a fold takes only
 * one of them) and every topic of the memory with its section (a fold lands
 * in any of them, but never across sections). Left out, the group's topics
 * are read off the notes and the memory's off `topics`, without sections.
 */
export interface ReviewValidationContext {
	group?: readonly ReviewGroupTopic[];
	memoryTopics?: readonly ReviewMemoryTopic[];
}

/** The group's topics as the notes name them, when the caller gave no richer view. */
function groupTopicsOf(notes: readonly ReviewNote[]): ReviewMemoryTopic[] {
	const seen = new Map<string, ReviewMemoryTopic>();
	for (const note of notes) if (!seen.has(note.topic)) seen.set(note.topic, { section: note.section, title: note.topic });
	return [...seen.values()];
}

/**
 * Refusals, each a named reason the model can act on, one line per problem,
 * naming the op's position and the note it addressed. An empty list means the
 * ops can be applied. `topics` is every topic title the memory holds — a move
 * may file under a topic outside this group, and a new title is judged
 * against all of them, not only the group's own; left out, the group's titles
 * stand in.
 */
export function validateReviewOps(ops: readonly ReviewOp[], notes: readonly ReviewNote[], depth: ReviewDepth, topics: readonly string[] = [...new Set(notes.map((note) => note.topic))], context: ReviewValidationContext = {}): string[] {
	const refusals: string[] = [];
	if (ops.length > REVIEW_MAX_OPS) {
		refusals.push(`${ops.length} operations for one group: at most ${REVIEW_MAX_OPS} are applied — tidy what is genuinely too long, not every note`);
	}
	const byId = new Map(notes.map((note) => [note.id, note]));
	const allowed = DEPTH_OPS[depth];
	const claimed = new Map<string, number>();
	const groupTopics: readonly ReviewMemoryTopic[] = context.group ?? groupTopicsOf(notes);
	const memoryTopics: readonly ReviewMemoryTopic[] = context.memoryTopics ?? groupTopics;
	const memoryTitles = [...topics, ...memoryTopics.map((topic) => topic.title)];
	/** The topics already folded away by an earlier op of this reply, by the op that did it. */
	const folded = new Map<string, number>();

	const claim = (id: string, label: string): ReviewNote | undefined => {
		const seen = (claimed.get(id) ?? 0) + 1;
		claimed.set(id, seen);
		if (seen === 2) refusals.push(`${label}: "${id}" is named by more than one operation; one note takes one operation per review`);
		const note = byId.get(id);
		if (!note) {
			const nearest = nearestNoteId(id, notes);
			refusals.push(`${label}: "${id}" is not a note of this group${nearest ? ` — did you mean "${nearest}"? Copy ids exactly as they are listed` : "; copy ids exactly as they are listed"}`);
		}
		return note;
	};

	ops.forEach((op, index) => {
		const label = `op ${index + 1} (${op.op})`;
		if (op.foreignKeys?.length) {
			refusals.push(`${label}: the key${op.foreignKeys.length === 1 ? "" : "s"} ${op.foreignKeys.map((key) => `"${key}"`).join(", ")} ${op.foreignKeys.length === 1 ? "is" : "are"} not part of this operation; write it with exactly ${OP_FIELDS[op.op].map((field) => `"${field}"`).join(", ")}`);
		}
		if (!allowed.includes(op.op)) {
			refusals.push(op.op === "merge_topics"
				? `${label}: this review is tidying the wording only; topics are folded in a tidy that may also move notes`
				: `${label}: this review is tidying the wording only, so nothing leaves memory in it; word the note better with update or merge, or leave it as it is`);
			return;
		}
		if (op.op === "merge_topics") {
			// A fold names topics, not notes: the notes of "from" are not claimed,
			// so an update on one of them in the same reply still applies — after
			// the fold it resolves by id, wherever the note now sits.
			const from = groupTopics.find((topic) => sameTopic(topic.title, op.from));
			if (!from) {
				refusals.push(`${label}: "${truncate(op.from, 40)}" is not a topic of this group; fold only a topic listed above`);
				return;
			}
			const intoTitle = memoryTitles.find((title) => sameTopic(title, op.into));
			if (intoTitle === undefined) {
				refusals.push(`${label}: "${truncate(op.into, 40)}" is not a topic of this memory; copy the title exactly as it is listed`);
				return;
			}
			if (sameTopic(op.from, op.into)) {
				refusals.push(`${label}: "${from.title}" cannot be folded into itself`);
				return;
			}
			const into = memoryTopics.find((topic) => sameTopic(topic.title, op.into));
			if (from.section === "Active Items" || into?.section === "Active Items") {
				refusals.push(`${label}: open items are not folded; move them one by one instead`);
				return;
			}
			if (into && into.section !== from.section) {
				refusals.push(`${label}: "${from.title}" and "${into.title}" are not in the same part of memory`);
				return;
			}
			if (from.intro?.trim()) {
				refusals.push(`${label}: "${from.title}" opens with a paragraph of its own; move its notes one by one instead`);
				return;
			}
			const foldedBy = folded.get(from.title.toLowerCase());
			if (foldedBy !== undefined) {
				refusals.push(`${label}: "${from.title}" is folded by more than one operation`);
				return;
			}
			const intoFoldedBy = folded.get(intoTitle.toLowerCase());
			if (intoFoldedBy !== undefined) {
				refusals.push(`${label}: "${intoTitle}" is folded away by op ${intoFoldedBy + 1}; fold into the topic that stays`);
				return;
			}
			folded.set(from.title.toLowerCase(), index);
			return;
		}
		if (op.op === "merge") {
			const unique = new Set(op.ids);
			if (unique.size !== op.ids.length) refusals.push(`${label}: the same note is listed twice in "ids"; a merge names each note once`);
			const members = op.ids.map((id) => claim(id, label));
			if (members.some((member) => !member)) return;
			const rows = members as ReviewNote[];
			const sections = new Set(rows.map((row) => row.section));
			if (sections.size > 1) refusals.push(`${label}: a merge joins notes of one section; these are in ${[...sections].join(" and ")}`);
			refuseTextShape(op.text, rows[0].topic, notes, label, refusals);
			refuseGrowth(op.text, rows.reduce((sum, row) => sum + row.text.length, 0), label, refusals);
			return;
		}
		const note = claim(op.id, label);
		if (!note) return;
		if (note.pinned && (PIN_PROTECTED_OPS as readonly string[]).includes(op.op)) {
			refusals.push(`${label}: "${op.id}" is pinned — a pinned note is the user's own and stays in memory; word it better with update, or leave it as it is`);
			return;
		}
		switch (op.op) {
			case "update":
				refuseTextShape(op.text, note.topic, notes, label, refusals);
				refuseGrowth(op.text, note.text.length, label, refusals);
				return;
			case "close":
				if (note.section !== "Active Items" || note.kind !== "item") {
					refusals.push(`${label}: "${op.id}" is a ${note.kind} under "${note.topic}", not an open item; only an open item is closed — archive it as stale if it no longer holds`);
				}
				return;
			case "archive":
				return;
			case "pin": {
				if (!normalizeLine(op.because ?? "")) {
					refusals.push(`${label}: pin carries "because" — one line saying why this note must never be tidied away`);
				}
				return;
			}
			case "move": {
				refuseTopicTitle(op.topic, `${label} "${truncate(op.topic, 40)}"`, refusals);
				if (sameTopic(op.topic, note.topic)) {
					refusals.push(`${label}: "${op.id}" is already under "${note.topic}"`);
					return;
				}
				// A title that is an existing topic in other words would open a
				// second heading for one subject; the refusal names the heading
				// that already holds it. An exact title (case aside) is that topic
				// and files under it.
				const twin = nearDuplicateTopicTitle(op.topic, topics);
				if (twin) refusals.push(`${label}: "${truncate(op.topic, 40)}" is the topic "${twin}"; write "topic":"${twin}"`);
				return;
			}
		}
	});
	return refusals;
}

// --- Application -------------------------------------------------------------

export type ReviewChangeKind = "shortened" | "merged" | "archived" | "closed" | "moved" | "pinned" | "topic_folded";

/** One thing a tidy did to one note, as the card reads it. */
export interface ReviewChange {
	id: string;
	section: MemorySection;
	topic: string;
	kind: ReviewChangeKind;
	/** The note's words before, or — for a move — the topic it came from, or — for a fold — the topic that was folded. */
	before?: string;
	/** The note's words after, or — for a move or a fold — the topic the notes now sit under. */
	after?: string;
	/** archived: the reason the row carries. */
	why?: ArchiveReason;
	/** merged: the notes that became this one, this note's own id first. */
	mergedFrom?: string[];
	/** topic_folded: how many notes moved with the fold. */
	notesMoved?: number;
}

/** One note on its way out of the core, with the address a restore needs. */
export interface ReviewArchiveRow {
	entry: MemoryEntry;
	why: ArchiveReason;
	topic: string;
	section: MemorySection;
}

export interface AppliedReview {
	doc: MemoryDocument;
	changes: ReviewChange[];
	/** Superseded older texts, archived notes and closed items, in the order they left. */
	archive: ReviewArchiveRow[];
}

export interface ReviewApplyContext {
	/** YYYY-MM-DD — the approval date the whole run is stamped with. */
	savedDate: string;
	/** Ids the archive already holds — on disk from earlier saves and in this run so far — so a second version of one note is `-v2`, never a second `-v1`. */
	takenArchiveIds?: readonly string[];
}

/**
 * Applies validated ops to a copy of the document. A note the tidy did not name
 * is the document's own object copied through, so nothing it did not address
 * can change. Ops that were not validated throw rather than half-apply — an
 * unknown id here means the caller skipped the validator.
 */
export function applyReviewOps(doc: MemoryDocument, ops: readonly ReviewOp[], ctx: ReviewApplyContext): AppliedReview {
	let next = cloneDocument(doc);
	const changes: ReviewChange[] = [];
	const archive: ReviewArchiveRow[] = [];
	const taken = [...(ctx.takenArchiveIds ?? [])];

	const locate = (id: string) => {
		const found = findEntryLocation(next, id);
		if (!found) throw new Error(`ops were not validated: unknown note "${id}"`);
		return found;
	};
	/**
	 * The words a note is losing, kept as that note's previous version. The note
	 * itself is NOT stamped `updated`: a tidy's rewording is not new information,
	 * and the budget pass archives the least recently touched note first — a
	 * stamp here would let a tidy push the notes it left alone out of memory
	 * ahead of the ones it rewrote. Memorize stamps, because a fold's update
	 * carries something the room learned; the archived `-vN` row, dated the day
	 * it left, is the record of the tidy.
	 */
	const supersede = (entry: MemoryEntry, topic: MemoryTopic, text: string) => {
		const id = nextVersionedEntryId(entry.id, taken);
		taken.push(id);
		archive.push({
			entry: { id, kind: entry.kind, saved: entry.saved, pinned: false, text, ...(entry.from ? { from: entry.from } : {}) },
			why: "superseded",
			topic: topic.title,
			section: topic.section,
		});
	};
	const takeOut = (entry: MemoryEntry, topic: MemoryTopic, why: ArchiveReason) => {
		topic.entries.splice(topic.entries.indexOf(entry), 1);
		archive.push({ entry: { ...entry }, why, topic: topic.title, section: topic.section });
	};

	for (const op of ops) {
		switch (op.op) {
			case "update": {
				const { entry, topic } = locate(op.id);
				const before = entry.text;
				supersede(entry, topic, before);
				entry.text = op.text;
				changes.push({ id: entry.id, section: topic.section, topic: topic.title, kind: "shortened", before, after: op.text });
				break;
			}
			case "merge": {
				// The first id survives, so its own replaced words are kept as its
				// previous version; the other members LEAVE memory and go to the
				// archive under their own ids, where a restore can still find them.
				const [survivorId, ...others] = op.ids;
				const survivor = locate(survivorId);
				const before = survivor.entry.text;
				const pinned = survivor.entry.pinned || others.some((id) => locate(id).entry.pinned);
				supersede(survivor.entry, survivor.topic, before);
				for (const id of others) {
					const member = locate(id);
					takeOut(member.entry, member.topic, "superseded");
				}
				survivor.entry.text = op.text;
				survivor.entry.pinned = pinned;
				changes.push({ id: survivorId, section: survivor.topic.section, topic: survivor.topic.title, kind: "merged", before, after: op.text, mergedFrom: [...op.ids] });
				break;
			}
			case "archive": {
				const { entry, topic } = locate(op.id);
				const why = ARCHIVE_REASON_OF[op.why];
				takeOut(entry, topic, why);
				changes.push({ id: entry.id, section: topic.section, topic: topic.title, kind: "archived", before: entry.text, why });
				break;
			}
			case "close": {
				// The existing done semantics: a finished item leaves the core for
				// the archive with why=done, exactly as a Memorize closes one.
				const { entry, topic } = locate(op.id);
				const closed: MemoryEntry = { ...entry, status: "done", updated: ctx.savedDate };
				topic.entries.splice(topic.entries.indexOf(entry), 1, closed);
				takeOut(closed, topic, "done");
				changes.push({ id: entry.id, section: topic.section, topic: topic.title, kind: "closed", before: entry.text, why: "done" });
				break;
			}
			case "pin": {
				const { entry, topic } = locate(op.id);
				entry.pinned = true;
				changes.push({ id: entry.id, section: topic.section, topic: topic.title, kind: "pinned", after: entry.text });
				break;
			}
			case "move": {
				const from = locate(op.id).topic.title;
				next = applyUserEdit(next, { op: "move", id: op.id, topic: op.topic }).doc;
				const moved = locate(op.id);
				changes.push({ id: op.id, section: moved.topic.section, topic: moved.topic.title, kind: "moved", before: from, after: moved.topic.title });
				break;
			}
			case "merge_topics": {
				// Every note of "from" goes to the end of "into" as it is — pins,
				// dates, kinds and refs untouched, nothing stamped — and the "from"
				// heading leaves the document, so no empty heading is rendered.
				// Archived rows that carry the old title keep it: the archive is
				// history.
				const from = topicByTitle(next, op.from);
				const into = topicByTitle(next, op.into);
				if (!from) throw new Error(`ops were not validated: unknown topic "${op.from}"`);
				if (!into || into === from) throw new Error(`ops were not validated: unknown topic "${op.into}"`);
				const moved = from.entries.splice(0, from.entries.length);
				into.entries.push(...moved);
				next.topics.splice(next.topics.indexOf(from), 1);
				changes.push({ id: moved[0]?.id ?? "", section: into.section, topic: into.title, kind: "topic_folded", before: from.title, after: into.title, notesMoved: moved.length });
				break;
			}
		}
	}
	return { doc: next, changes, archive };
}

/** The topic of that title: the exact title first, then the same title in other case. */
function topicByTitle(doc: MemoryDocument, title: string): MemoryTopic | undefined {
	return doc.topics.find((topic) => topic.title === title) ?? doc.topics.find((topic) => sameTopic(topic.title, title));
}
