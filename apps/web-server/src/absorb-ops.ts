// Memorize — the fold operation layer (memory v2, stream C), the pure layer.
//
// Memorize stops rewriting the whole memory. One remembered session at a time
// is folded into the core by a worker that emits a short list of operations
// against addressable entries; the server applies them, fills in provenance and
// records what changed. Everything a promise depends on lives here as a
// predicate, not as prompt text:
//   - an entry the fold does not NAME is never touched, so stamps, provenance
//     and pinned entries survive by construction;
//   - pinned entries are the user's: a fold may add beside them and nothing
//     else, and a change aimed at one is added beside it;
//   - a pin carries the line of the session that asked for it, and the server
//     checks that the line is really there;
//   - "this session held nothing durable" is an operation (drop) with a reason,
//     not silence, and it stands only when nothing else changed;
//   - each op is decided alone: no rule costs the reply, and content is never
//     dropped, only redirected or left out when memory already says it.
//
// Nothing here talks to a model, a route or the disk: the prompt is a string,
// the parser is a reader, the applier works on a document value. The route owns
// the call, the retry, the Recent Context removal and the write.
//
// The input shapes (MemoryEntry, MemoryTopic, MemoryDocument, AreaRow) are
// declared here structurally: the entry model module owns their canonical
// definitions, and TypeScript's structural typing makes the two compatible
// without this module importing it. Sizes go through the ONE estimator.

import { classifyNotePair, conflictReason, dropsNoteValue, negationDiffers, noteValueTokens, noteWordsWithin, textDisagreesWith } from "./memory-duplicates.js";
import { findStructuralLine, hasMustKeepMarker, ISO_DAY, saysMoreThanMustKeep, withoutMustKeepMarkers } from "./memory-entries.js";
import { estimateTokens } from "./token-estimate.js";

export const ABSORB_FOLD_WORKER_TYPE = "absorb-fold-worker" as const;
export const ABSORB_FOLD_MODE = "rc_fold" as const;

/** The worker's whole user turn: the prompt carries the material, this asks for the fold. */
export const FOLD_TRIGGER_PROMPT = "Fold this session into memory now.";

// --- Input shapes (owned by the entry model; declared structurally here) -----

export type EntryKind = "event" | "fact" | "practice" | "item";

export interface MemoryEntry {
	id: string;
	kind: EntryKind;
	saved: string;
	from?: string;
	pinned: boolean;
	status?: "open" | "done";
	updated?: string;
	/** YYYY-MM-DD of the conversation that last wrote the text. */
	learned?: string;
	/** The notes the person kept beside this one though they may disagree; a rewrite clears it. */
	disagrees?: string;
	refs?: number;
	summary?: true;
	extra?: Record<string, string>;
	text: string;
}

export interface MemoryTopic {
	section: "Deep Memory" | "Active Items";
	title: string;
	heading: string | null;
	intro: string;
	entries: MemoryEntry[];
}

export interface MemoryDocument {
	preamble: string;
	chronos: string;
	topics: MemoryTopic[];
	recentContext: string;
	otherSections: { title: string; text: string; index: number }[];
	nextEntryNumber: number;
}

export interface AreaRow {
	id: string;
	topic: string;
	section: string;
	kind: EntryKind;
	pinned: boolean;
	saved: string;
	/**
	 * YYYY-MM-DD of the conversation that last wrote the text. Without it the
	 * note came through the upgrade or before dates were kept: the prompt writes
	 * "saved" for one a fold wrote, and "in memory since" for one nothing wrote,
	 * whose saved date is only the day it was given its id.
	 */
	learned?: string;
	/** Read only without `learned`: the conversation that wrote the note, and the run day a later fold rewrote it. A note a fold wrote is as new as the later of `saved` and `updated`; one nothing wrote only as new as `updated`. */
	from?: string;
	updated?: string;
	tokens: number;
	firstLine: string;
	/** The whole note, so an add that repeats it or may disagree with it is known. Nothing else reads it. */
	text: string;
}

// --- Bounds ------------------------------------------------------------------

/** The reply's hard shape: a fold is a handful of operations, never a rewrite. */
export const FOLD_MAX_OPS = 12;
/** One entry is one thought; past this it is a section, and the fold is rewriting. */
export const FOLD_MAX_TEXT_WORDS = 120;
export const FOLD_TOPIC_TITLE_MIN_CHARS = 2;
export const FOLD_TOPIC_TITLE_MAX_CHARS = 60;
/** The one topic title that addresses the Active Items section. */
export const FOLD_ACTIVE_ITEMS_TOPIC = "Active Items";

// --- Grammar -----------------------------------------------------------------

export const FOLD_OP_KINDS = ["add", "update", "supersede", "close", "pin", "drop"] as const;
export type FoldOpKind = (typeof FOLD_OP_KINDS)[number];

/** The kinds an `add` may mint: an event is what a session IS, never what a fold writes. */
export const FOLD_ADD_KINDS = ["fact", "practice", "item"] as const;
export type FoldAddKind = (typeof FOLD_ADD_KINDS)[number];

/** The tag a new note carries on the card: it sits beside a note the person pinned, or it may disagree with a note. Either holds the automatic save. */
export type FoldBesideTag = "pinned" | "may-disagree";

export type FoldOp =
	| { op: "add"; topic: string; kind: FoldAddKind; text: string; beside?: FoldBesideTag; besideOf?: string }
	| { op: "update"; id: string; text: string }
	| { op: "supersede"; id: string; text: string }
	| { op: "close"; id: string }
	| { op: "pin"; id: string; because?: string }
	| { op: "drop"; reason: string }
	/** Never written by a model: an older page's text that disagrees with a newer note goes to the archive as history, `until` the day the note `of` was learned. */
	| { op: "history"; of: string; until: string; text: string };


// --- Discussion guidance -----------------------------------------------------

export interface FoldGuidanceDrop {
	/** The Recent Context id the discussion asked to drop, e.g. "RC-0007". */
	session: string;
	reason: string;
}

export type FoldGuidanceTopicChange =
	| { action: "create"; title: string }
	| { action: "merge"; sources: string[]; title: string };

export interface FoldGuidance {
	/** Entry ids the user asked to pin. */
	pin: string[];
	drop: FoldGuidanceDrop[];
	corrections: string[];
	topics: FoldGuidanceTopicChange[];
	instructions: string[];
}

export const EMPTY_FOLD_GUIDANCE: Readonly<FoldGuidance> = { pin: [], drop: [], corrections: [], topics: [], instructions: [] };

/**
 * Guidance as it travels over the API. The one difference from the internal
 * shape is the topic change: on the wire a change is the thing asked for
 * (`{ create }` or `{ merge, into }`), which is what a client renders; inside
 * it carries a discriminating `action`, which is what a switch reads. The two
 * converters below are the only place the two shapes meet.
 */
export type FoldGuidanceTopicChangeWire = { create: string } | { merge: string[]; into: string };

export interface FoldGuidanceWire {
	pin: string[];
	drop: FoldGuidanceDrop[];
	corrections: string[];
	topics: FoldGuidanceTopicChangeWire[];
	instructions: string[];
}

export function foldGuidanceToWire(guidance: FoldGuidance): FoldGuidanceWire {
	return {
		pin: [...guidance.pin],
		drop: guidance.drop.map((drop) => ({ ...drop })),
		corrections: [...guidance.corrections],
		topics: guidance.topics.map((topic) => (topic.action === "create" ? { create: topic.title } : { merge: [...topic.sources], into: topic.title })),
		instructions: [...guidance.instructions],
	};
}

const stringList = (value: unknown, max: number): string[] =>
	(Array.isArray(value) ? value : [])
		.filter((item): item is string => typeof item === "string")
		.map((item) => item.trim())
		.filter(Boolean)
		.slice(0, max);

/**
 * Guidance off the wire. It is client input bound for a worker prompt, so every
 * field is bounded here rather than trusted: a list that arrives as junk reads
 * as nothing asked for, never as an error the user cannot act on.
 */
export function foldGuidanceFromWire(raw: unknown): FoldGuidance {
	const wire = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
	const guidance: FoldGuidance = {
		pin: stringList(wire.pin, 50),
		drop: (Array.isArray(wire.drop) ? wire.drop : [])
			.map((item: any) => ({ session: String(item?.session ?? "").trim().toUpperCase(), reason: String(item?.reason ?? "").trim() }))
			.filter((drop) => drop.session)
			.slice(0, 50),
		corrections: stringList(wire.corrections, 30).map((line) => line.slice(0, 600)),
		topics: [],
		instructions: stringList(wire.instructions, 30).map((line) => line.slice(0, 600)),
	};
	for (const item of (Array.isArray(wire.topics) ? wire.topics : []).slice(0, 20)) {
		const create = typeof (item as any)?.create === "string" ? (item as any).create.trim() : "";
		if (create) { guidance.topics.push({ action: "create", title: create }); continue; }
		const into = typeof (item as any)?.into === "string" ? (item as any).into.trim() : "";
		const sources = stringList((item as any)?.merge, 10);
		if (into && sources.length >= 2) guidance.topics.push({ action: "merge", sources, title: into });
	}
	return guidance;
}

export function foldGuidanceIsEmpty(guidance: FoldGuidance): boolean {
	return guidance.pin.length === 0 && guidance.drop.length === 0 && guidance.corrections.length === 0 && guidance.topics.length === 0 && guidance.instructions.length === 0;
}

// --- Small shared readers ----------------------------------------------------

/** The ECMAScript line terminators, so a reply's line model is the same wherever it is read. */
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

/** A bullet the way the memory writes one: "- ", "* " or "+ " at the start of the line. */
const BULLET_START = /^\s*[-*+]\s+\S/;

export function countWords(text: string): number {
	const trimmed = text.trim();
	return trimmed ? trimmed.split(/\s+/).length : 0;
}

function firstLineOf(text: string): string {
	return toLines(text).find((line) => line.trim()) ?? "";
}

function truncate(value: string, max = 80): string {
	const one = normalizeLine(value);
	return one.length <= max ? one : `${one.slice(0, max - 1)}…`;
}

// --- The fold prompt ---------------------------------------------------------

export interface FoldPromptInput {
	agentId: string;
	model: { provider: string; model: string };
	/** The room's context render of core memory, metadata comments already stripped. */
	coreContext: string;
	areas: AreaRow[];
	assessmentMarkdown: string;
	guidance?: FoldGuidance;
	/** The one session, with the day it was remembered (its heading's date) when the caller knows it: the prompt states it so the fold can weigh the session against the entries' own dates. */
	session: { id: string; text: string; date?: string };
	sessionIndex: number;
	sessionCount: number;
	now?: Date;
}

export interface FoldPromptTelemetry {
	promptChars: number;
	promptEstimatedTokens: number;
	areaCount: number;
}

export interface FoldPromptAssembly {
	prompt: string;
	telemetry: FoldPromptTelemetry;
}

/**
 * The fold constitution — the absorb consolidation constitution's voice and its
 * governing principle, date-stamp rule, must-keep rule, sensitive-material
 * restraint and supersession rule, restated for a worker that emits operations
 * against named entries instead of rewriting a document.
 */
export function absorbFoldConstitution(): string {
	return `# exxperts Memorize Fold Constitution

You are a platform-owned memorize fold worker inside exxperts.

You are not the persistent agent. You are not participating in ordinary chat. You are an ephemeral hidden maintenance process invoked to fold one remembered session into the room's core memory.

This operation must not write memory, archive files, mutate core memory, update Chronos, or create sidecar event records. You emit operations. The system validates them, applies them to a working copy, fills in provenance, and puts the result to the user for approval.

## Governing Principle

Maximize durable signal density. A fold is not append-only memory growth. It folds one session into memory so the future persistent agent understands more with fewer, sharper tokens. Integration should make memory denser, not merely larger: prefer folding new understanding into the entry that already carries the point (update, supersede) over adding a parallel entry beside it. A point memory already holds is updated, never repeated.

## Scope

- Read the core memory as it stands and the one session below. Every entry of that memory opens with its own id in square brackets, which is the only way you address it; the brackets are the system's, never part of an entry's words.
- Treat the session as an intake buffer: only what outlives it belongs in memory.
- Route durable understanding to Deep Memory — what is true is a fact, what works is a practice.
- A preference the user states about how work should be done or presented (how a summary is written, what a number must carry, when to ask before acting) is a practice under the room's working-style topic, never chatter, even when it is said in passing.
- Route unresolved live state to Active Items as an item.
- Close the Active Items the session finished.
- Drop noise, completed implementation chatter, redundant detail, and material better suited to files or telemetry. A session that holds nothing durable is dropped with its reason, not folded thinly.
- Apply sensitive-material restraint: health, conflicts with named people, finances, religious or political identity, and third parties' private details become permanent only when load-bearing for future work or explicitly requested by the user.

## Reading the Session in Order

A session is a chronological compression of one working stretch: Session arc, then Body, then Parked. Read it in order and treat it as a trajectory, because later entries supersede earlier ones — a decision recorded early in the session and reversed later in it folds as the reversal, not as the original, and the reversal is a supersede of the entry that carries the old decision, never a second entry beside it.

## Dates Decide What Is Newer

Against memory, dates decide, not the order of folding: a session can reach you after a later one has already been folded. Every entry's address carries the day it was learned, the day of the conversation that last wrote its text; the task below names the day this session is from. This session is newer than every entry learned BEFORE its date, so where it conflicts with such an entry it wins, unless it explicitly defers to the older one. An entry learned AFTER this session's date already knows more than this session does: never supersede or update it with this session's older information. An entry a fold wrote before days were learned reads "saved" a day instead, and "rewritten" a day when a later fold rewrote it: an entry saved or rewritten AFTER this session's date also knows more than this session does, so never supersede or update it either. An entry that reads "in memory since" a day carries no saved date at all, only the day it was given its id: it is older than this session unless it also carries a rewritten date after the session's, and this session wins against it as against any older entry. Where the older point still matters beside the newer one, add it as its own entry and say in your narrative that it is the earlier state; otherwise leave the newer entry alone.

## Date Stamps

The system stamps every entry it adds or changes, so never write a saved-on stamp of your own and never invent a date. When the session names the day something was decided, agreed, or is due, keep that date inside the entry's own words, because it is part of the point. Never present a saved-on date as the day something happened. A later pass reads the stamps to judge staleness; the text carries the facts.

## Must-Keep Material

A session may carry content marked **must-keep** — explicit user remember-requests and operator-named content from checkpoint compression. Fold must-keep material into the appropriate entry and carry the **must-keep** marker with it in the operation's text, because the user's explicit request outlives the intake buffer. Never drop it, and keep its commitments, numbers, names, and dates exact. An entry whose text carries the marker is pinned by the system, so later folds may only add beside it; that is the point of carrying it. If two must-keep items conflict, keep the newer one and say in your narrative that it superseded the older.

## Pinned Entries

A pinned entry is the user's own, and says so in its address: it reads \`[m-0032 · pinned · saved …]\`. A fold never updates, supersedes or closes one; where the session changes what a pinned entry says, add the newer point beside it and say so in your narrative, and the user decides. Pinning is something only the user asks for: emit pin only when the session itself records that request, and quote the line that records it.

## Boundaries

- Do not include or request L1a.
- Do not roleplay as the persistent room agent.
- Do not claim memory has been saved.
- Do not touch an entry you do not name: everything you do not address is copied through unchanged.
- Do not restructure memory for elegance. Reorganising topics is not a fold's job.
- Do not fold any session other than the one below.
`;
}

/**
 * How to address an entry, and nothing more.
 *
 * The entries used to be listed again here, one row each, beside the memory
 * that already showed them: on a room at its 20k budget that list was 26k
 * tokens of the fold prompt — more than the memory itself — to say what the
 * memory now says inline. The addresses ride in the entries' own first lines
 * (`- [m-0031] …`, and `- [m-0032 · pinned] …` for a pinned one), so this
 * section is the legend that reads them.
 */
function renderAddressLegend(areas: AreaRow[]): string {
	if (areas.length === 0) return "Core memory holds no entries yet. Every operation is an add.";
	return [
		`Every entry of the memory above opens with its own id in square brackets, followed by its date: \`- [m-0031 · learned 2026-08-02] The Nordwind contract renews annually…\` is the entry \`m-0031\`, whose text a conversation of 2026-08-02 wrote, so the entry is as new as that day. \`[m-0034 · saved 2026-08-02 · rewritten 2026-09-01]\` is an entry a fold wrote before days were learned: saved into memory on 2026-08-02 and rewritten by a later fold on 2026-09-01, so it is as new as the later day. \`[m-0033 · in memory since 2026-09-12]\` says the entry was in memory by that day and no conversation wrote it: it came with the room or was typed by hand, and may be far older than that day; read it as older than the session unless a rewritten date says otherwise. An entry written as \`- [m-0032 · pinned · learned …] …\` is pinned: it is the user's own, and a fold may only add beside it.`,
		`The brackets are the address, not part of the entry's words. Copy the id alone — \`m-0031\`, never the dates or the pin marker — exactly as it stands there, address only the ids that memory carries (there are ${areas.length}), and never write a bracketed id into the text of an operation.`,
	].join("\n\n");
}

/**
 * The address as the memory render writes it at the start of an entry's first
 * line — `[m-0031]`, or `[m-0031 · pinned]` — anchored to the line so a bracket
 * inside an entry's own words is never mistaken for one.
 */
function entryAddressPattern(id: string): RegExp {
	const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	return new RegExp(`^(\\s*(?:[-*+]|\\d+[.)])?\\s*)\\[${escaped}( · pinned)?\\]`, "m");
}

function entryDatesLabel(area: AreaRow): string {
	if (area.learned) return `learned ${area.learned}`;
	if (!area.saved) return "";
	// Without a learned day: a note a fold wrote has a saved day of its own, one
	// nothing wrote only the day it was given its id; a rewrite is newer than both.
	const rewritten = area.updated ? ` · rewritten ${area.updated}` : "";
	return `${area.from ? "saved" : "in memory since"} ${area.saved}${rewritten}`;
}

/**
 * The memory render with each entry's dates written into its address:
 * `[m-0031 · saved 2026-08-02]`, `[m-0031 · saved 2026-08-02 · updated
 * 2026-09-01]`, and `[m-0032 · pinned · saved …]` for a pinned one.
 *
 * The fold is the one reader that has to weigh an entry's age against a
 * session's, because a session that failed in one run is folded in a later one
 * after sessions newer than it have already landed. The render itself is the
 * entry model's, shared by every other reader of the addresses (Review, the
 * room's own boot), so the dates are dressed onto the addresses HERE, from the
 * same area map the decision judges the reply against, and the decision goes
 * on reading bare ids. Each address is replaced once, at the line it opens; an
 * entry the map has no date for keeps its address as it was.
 */
function withEntryDates(coreContext: string, areas: AreaRow[]): string {
	let out = coreContext;
	for (const area of areas) {
		const dates = area.id ? entryDatesLabel(area) : "";
		if (!dates) continue;
		out = out.replace(entryAddressPattern(area.id), (_match, prefix: string, pinned: string | undefined) => `${prefix}[${area.id}${pinned ?? ""} · ${dates}]`);
	}
	return out;
}

/**
 * What a run folds with when there is no first read: the assessment failed,
 * was refused, came back too long or was never sent. The fold's prompt shows
 * it as the signed-off assessment, as it shows an empty one.
 */
export const FIRST_READ_NONE = "None.";

/** Whether an assessment is a real first read, not a missing one. */
export function hasFirstRead(assessmentMarkdown: string): boolean {
	const text = assessmentMarkdown.trim();
	return text !== "" && text !== FIRST_READ_NONE;
}

/** The guidance the user signed off, rendered as instructions the fold must honour. Without a first read there is no assessment to follow. */
export function renderFoldGuidance(guidance: FoldGuidance, firstRead = true): string {
	if (foldGuidanceIsEmpty(guidance)) return firstRead ? "The user signed off without further instructions. Follow the assessment." : "The user signed off without further instructions.";
	const parts: string[] = [];
	if (guidance.pin.length > 0) {
		parts.push(`The user asked to pin these entries: ${guidance.pin.join(", ")}. The system pins them; do not emit pin operations for them, and do not update, supersede or close them.`);
	}
	if (guidance.drop.length > 0) {
		parts.push(`The user asked to drop these sessions:\n${guidance.drop.map((drop) => `- ${drop.session} — ${drop.reason}`).join("\n")}\nIf the session below is one of them, answer with a single drop operation carrying that reason.`);
	}
	if (guidance.corrections.length > 0) {
		parts.push(`Corrections the user made. They are newer than memory and newer than the session; fold the corrected version, and supersede the entry that carries the old version where one exists:\n${guidance.corrections.map((line) => `- ${line}`).join("\n")}`);
	}
	if (guidance.topics.length > 0) {
		const lines = guidance.topics.map((topic) => (topic.action === "create" ? `- Create the topic "${topic.title}" and file material that belongs there under it.` : `- The topics ${topic.sources.map((s) => `"${s}"`).join(" and ")} are to become "${topic.title}"; file new material under "${topic.title}".`));
		parts.push(`Topics the user asked for:\n${lines.join("\n")}`);
	}
	if (guidance.instructions.length > 0) {
		parts.push(`Standing instructions for this run:\n${guidance.instructions.map((line) => `- ${line}`).join("\n")}`);
	}
	return parts.join("\n\n");
}

function foldTaskSection(input: FoldPromptInput): string {
	const shapes = [
		`- \`{"op":"add","topic":"<topic title>","kind":"fact","text":"- <the entry>"}\` — a new entry. "topic" is one of the topic headings of the memory above, or a new title when the session opens a subject memory has no home for: ${FOLD_TOPIC_TITLE_MIN_CHARS}–${FOLD_TOPIC_TITLE_MAX_CHARS} characters, no "#" heading marks, and a real title rather than a label ending in a colon. "kind" is "fact" for what is true and "practice" for what works. For an open loop, write \`"topic":"${FOLD_ACTIVE_ITEMS_TOPIC}","kind":"item"\`; an item never sits in Deep Memory and a fact or a practice never sits in ${FOLD_ACTIVE_ITEMS_TOPIC}. The system fills in the id, the saved-on date and the session this came from.`,
		`- \`{"op":"update","id":"<entry id>","text":"- <the entry, rewritten>"}\` — the entry stays the same point and says it better, or absorbs a detail this session added. The previous text is kept as superseded by the same entry, so nothing is lost.`,
		`- \`{"op":"supersede","id":"<entry id>","text":"- <the entry, as it now stands>"}\` — the point itself changed: a reversal, a new decision, a commitment replaced. Use this rather than update whenever a reader would be misled by the old text, and rather than an add whenever the new point is the same subject as the old one.`,
		`- \`{"op":"close","id":"<entry id>"}\` — an ${FOLD_ACTIVE_ITEMS_TOPIC} entry the session finished. Close it rather than rewriting it as done.`,
		`- \`{"op":"pin","id":"<entry id>","because":"<the line of the session that asks for it>"}\`: only when the session records the user asking for it. "because" quotes that line as it appears in the session; an operation whose quote is not in the session is ignored.`,
		`- \`{"op":"drop","reason":"<why nothing here is durable>"}\` — the session is chatter, a repeat of what memory already holds, or work whose result is already an entry. The session is consolidated and memory does not change; the reason is disclosed to the user, so write it for them in one sentence: call this a conversation, never a session or an RC number, and never name "Deep Memory" or "Active Items". A drop travels alone: it cannot appear beside any other operation.`,
	];
	const dated = input.session.date ? `This conversation is from ${input.session.date}: it is newer than every entry learned, saved or rewritten before that day, and older than every entry learned, saved or rewritten after it. ` : "";
	return [
		"## Task: Fold This Session Into Memory (operations)",
		`${dated}You do not rewrite memory. You emit operations against the entries of the memory above, each named by the id in its first line; the system applies them and builds the candidate. An entry you do not name is copied through unchanged — its text, its provenance and its saved-on date survive without any effort on your part, so name only what this session changes.`,
		`Operation shapes (copy the id alone from an entry's brackets — without the brackets, the dates or the pin marker):\n\n${shapes.join("\n")}`,
		`Rules: at most ${FOLD_MAX_OPS} operations for this session: a fold is a handful of decisions, and a session that seems to need more is a session whose durable core you have not found yet; each "text" is at most ${FOLD_MAX_TEXT_WORDS} words and is written the way its topic is written (a bullet starting "- " unless the topic's entries are paragraphs), carrying no bracketed id of its own; one operation per entry id; every id is one the memory above carries; pinned entries take no update, supersede or close. An operation that breaks a rule is not applied as written, so prefer fewer, exact operations.`,
		`Answer with the narrative and then the operations: at most three lines saying what this session leaves behind and what you chose to do with it, then exactly one \`\`\`json fence holding \`{"ops": [ ... ]}\`. Nothing follows the fence. An empty list is not an answer: choose add, update, supersede, close or pin, or say the session holds nothing durable with drop. Do not claim anything has been saved.`,
	].join("\n\n");
}

/**
 * The fold prompt: constitution, the memory as the room reads it with every
 * entry's address and dates in its own first line, the legend that reads those
 * addresses, the assessment, the signed-off guidance, the process metadata, and
 * the ONE session. Sections are joined the way the other maintenance prompts
 * join them.
 *
 * The order is the prompt cache's: everything that is the same from one fold
 * of a run to the next — the constitution, the memory as it stood, the legend,
 * the assessment and the guidance — comes first, and the parts that change
 * with every call (the metadata's trigger time and session counter, the
 * session itself) come after them, so a provider that caches a prompt prefix
 * reuses the memory instead of re-reading it once per session.
 *
 * `areas` is the map the decision judges the reply against; the prompt reads
 * it for the dates it writes into the addresses and for the count.
 */
export function buildFoldPrompt(input: FoldPromptInput): FoldPromptAssembly {
	const now = input.now ?? new Date();
	const guidance = input.guidance ?? { pin: [], drop: [], corrections: [], topics: [], instructions: [] };
	const prompt = [
		absorbFoldConstitution().trim(),
		`## Material: Core Memory As The Room Reads It\n\nThis is the memory as it stands after every earlier fold in this run — Deep Memory and Active Items, the two sections a fold changes. Entry metadata is stripped; each entry carries its own address and its dates in its first line, which is how you name a piece of it and how you tell whether it is older or newer than the session.\n\n${withEntryDates(input.coreContext.trim(), input.areas)}`,
		`## Material: Entries You Can Address\n\n${renderAddressLegend(input.areas)}`,
		`## Material: Signed-Off Assessment\n\n${input.assessmentMarkdown.trim() || FIRST_READ_NONE}`,
		`## Material: The User's Instructions From The Discussion\n\n${renderFoldGuidance(guidance, hasFirstRead(input.assessmentMarkdown))}`,
		`## Process Metadata\n\n- Agent id: ${input.agentId}\n- Process type: ${ABSORB_FOLD_WORKER_TYPE}\n- Mode: ${ABSORB_FOLD_MODE}\n- Trigger time: ${now.toISOString()}\n- System-selected model: ${input.model.provider}/${input.model.model}\n- Writes memory: false\n- Session being folded: ${input.session.id} (${input.sessionIndex} of ${input.sessionCount})${input.session.date ? `\n- Session date: ${input.session.date}` : ""}\n- Entries in core memory: ${input.areas.length}`,
		`## Material: The Session To Fold (${input.sessionIndex} of ${input.sessionCount})\n\nThis is the only session you fold. Earlier sessions of this run are already in the memory above; later ones are folded after you.${input.session.date ? ` This session is from ${input.session.date}.` : ""}\n\n${input.session.text.trim()}`,
		foldTaskSection(input),
	].join("\n\n---\n\n") + "\n";
	return {
		prompt,
		telemetry: {
			promptChars: prompt.length,
			promptEstimatedTokens: estimateTokens(prompt),
			areaCount: input.areas.length,
		},
	};
}

/**
 * The second ask of a reply that held no readable operations: the same prompt
 * plus one line. A reply cut off at the output limit is told so.
 */
export function buildFoldUnreadableRetryPrompt(prompt: string, cutOff: boolean): string {
	const line = cutOff
		? "Your last answer ran to the output limit and had no readable operations. Answer with a short narrative and one json fence."
		: "Your last answer had no readable operations. Answer with the narrative and one json fence.";
	return `${prompt.trimEnd()}\n\n${line}\n`;
}

// --- Reading the reply -------------------------------------------------------

/**
 * Why a reply held no operations the run can use, as the diagnostics count it:
 * per provider, these classes are how the unreadable rate is measured.
 */
export type FoldUnreadableClass = "no-fence" | "invalid-json" | "not-a-list" | "empty-list" | "cut-off";

/** A fenced block: the label, the body, and where the fence started. */
interface Fence {
	label: string;
	body: string;
	start: number;
}

/** Fence markers sit at line starts only: a ``` inside a JSON string is mid-line and never a fence. */
const FENCE_MARKER_LINE = /^[ \t]*```([^\s`]*)[^\n]*$/;

interface FenceMarker {
	label: string;
	/** Offset of the marker line. */
	start: number;
	/** Offset just past the marker line's newline. */
	bodyStart: number;
}

function fenceMarkers(raw: string): FenceMarker[] {
	const markers: FenceMarker[] = [];
	let offset = 0;
	for (const line of raw.split("\n")) {
		const m = FENCE_MARKER_LINE.exec(line);
		if (m) markers.push({ label: m[1].toLowerCase(), start: offset, bodyStart: offset + line.length + 1 });
		offset += line.length + 1;
	}
	return markers;
}

/**
 * Every complete fence a reply could mean, in reply order. A ```json marker
 * always OPENS a fence and closes at the next marker, whatever the markers
 * before it did, so a stray ``` line in the narrative can neither swallow the
 * operations block nor make the reply read as cut off. The plain pairs (each
 * marker with the one after it) are candidates too, for a reply that fenced its
 * operations without the json label.
 */
function candidateFences(raw: string): { json: Fence[]; any: Fence[]; openJson?: { start: number; bodyStart: number } } {
	const markers = fenceMarkers(raw);
	const body = (open: FenceMarker, close: FenceMarker) => raw.slice(open.bodyStart, Math.max(open.bodyStart, close.start - 1));
	const json: Fence[] = [];
	const any: Fence[] = [];
	for (let i = 0; i < markers.length; i++) {
		const open = markers[i];
		const close = markers[i + 1];
		if (!close) continue;
		const fence = { label: open.label, body: body(open, close), start: open.start };
		if (open.label === "json") json.push(fence);
		any.push(fence);
	}
	// The reply ends inside a ```json fence it never closed: it was cut off, and
	// that fence's body is no candidate for anything.
	const last = markers[markers.length - 1];
	return { json, any, ...(last?.label === "json" ? { openJson: { start: last.start, bodyStart: last.bodyStart } } : {}) };
}

/** JSON with the one slip models make most, a comma before a closing bracket, forgiven. Strings are left alone. */
function parseJsonLenient(text: string): { ok: true; value: unknown } | { ok: false } {
	try {
		return { ok: true, value: JSON.parse(text) };
	} catch {
		// fall through to the forgiving pass
	}
	let out = "";
	let inString = false;
	for (let i = 0; i < text.length; i++) {
		const ch = text[i];
		if (inString) {
			out += ch;
			if (ch === "\\") { out += text[i + 1] ?? ""; i++; }
			else if (ch === "\"") inString = false;
			continue;
		}
		if (ch === "\"") { inString = true; out += ch; continue; }
		if (ch === ",") {
			let j = i + 1;
			while (j < text.length && /\s/.test(text[j])) j++;
			if (text[j] === "}" || text[j] === "]") continue;
		}
		out += ch;
	}
	try {
		return { ok: true, value: JSON.parse(out) };
	} catch {
		return { ok: false };
	}
}

/**
 * The JSON values a reply carries outside any fence, in ONE pass: each `{` or
 * `[` is pushed, each `}` or `]` pops the latest opener and records the pair,
 * and strings are respected while any opener is open. A raw newline ends a
 * string, since a JSON string never holds one: a quote in the narrative after
 * an unbalanced bracket swallows only the rest of its own line. Openers still
 * on the stack at the end never balanced (prose, or a value cut short). The
 * candidates are the maximal recorded pairs, those inside no other recorded
 * pair, so a value NESTED in an unbalanced one is a candidate too; that is why
 * only an op list of objects is ever taken from here. Linear in the reply.
 */
function balancedValues(raw: string): { text: string; start: number }[] {
	const stack: number[] = [];
	const pairs: Array<[number, number]> = [];
	let inString = false;
	for (let i = 0; i < raw.length; i++) {
		const c = raw[i];
		if (inString) {
			if (c === "\\") i++;
			else if (c === "\"" || c === "\n") inString = false;
			continue;
		}
		if (c === "\"" && stack.length > 0) inString = true;
		else if (c === "{" || c === "[") stack.push(i);
		else if ((c === "}" || c === "]") && stack.length > 0) pairs.push([stack.pop()!, i]);
	}
	pairs.sort((a, b) => a[0] - b[0] || b[1] - a[1]);
	const values: { text: string; start: number }[] = [];
	let coveredTo = -1;
	for (const [open, close] of pairs) {
		if (open <= coveredTo) continue;
		values.push({ text: raw.slice(open, close + 1), start: open });
		coveredTo = close;
	}
	return values;
}

/**
 * The one value that starts at `start`, with a string state of its own: the
 * text up to the bracket that closes it, or undefined when it never closes.
 * Linear from `start`.
 */
function balancedValueAt(raw: string, start: number): string | undefined {
	let depth = 0;
	let inString = false;
	for (let i = start; i < raw.length; i++) {
		const c = raw[i];
		if (inString) {
			if (c === "\\") i++;
			else if (c === "\"" || c === "\n") inString = false;
			continue;
		}
		if (c === "\"") inString = true;
		else if (c === "{" || c === "[") depth += 1;
		else if ((c === "}" || c === "]") && --depth === 0) return raw.slice(start, i + 1);
	}
	return undefined;
}

/**
 * The last usable op list among a text's balanced values; failing that, the
 * value that starts at the LAST `{"ops"` or the last `[{"op"`, read with a
 * string state of its own, so a quote in the prose on the same line before
 * them hides nothing. Two anchored starts keep it linear.
 */
function lastBalancedOpList(text: string): { list: unknown[]; start: number } | undefined {
	const values = balancedValues(text);
	for (let i = values.length - 1; i >= 0; i--) {
		const read = parseJsonLenient(values[i].text);
		const list = read.ok ? usableOpList(read.value) : undefined;
		if (list) return { list, start: values[i].start };
	}
	for (const anchor of [/\{\s*"ops"\s*:/g, /\[\s*\{\s*"op"\s*:/g]) {
		let start = -1;
		for (const m of text.matchAll(anchor)) start = m.index!;
		if (start < 0) continue;
		const value = balancedValueAt(text, start);
		const read = value === undefined ? undefined : parseJsonLenient(value);
		const list = read?.ok ? usableOpList(read.value) : undefined;
		if (list) return { list, start };
	}
	return undefined;
}

const isPlainObject = (value: unknown): boolean => typeof value === "object" && value !== null && !Array.isArray(value);

/** An item that is shaped like an op: an object that names its kind. */
const isOpShaped = (value: unknown): boolean => isPlainObject(value) && typeof (value as { op?: unknown }).op === "string";

/**
 * The op list inside a parsed value: `{"ops": [...]}` or a bare array, with at
 * least one op-shaped item among its items (an empty list is a list too). Each
 * item is read alone later, so a stray string beside real ops costs only
 * itself; an array with no op-shaped item (strings, numbers, other objects) is
 * never an op list, so a quoted array after the real list cannot replace it.
 * Undefined when the value has neither shape.
 */
function opListOf(value: unknown): unknown[] | undefined {
	const list = Array.isArray(value) ? value : (value as { ops?: unknown } | null)?.ops;
	return Array.isArray(list) && (list.length === 0 || list.some(isOpShaped)) ? list : undefined;
}

/** An op list with at least one op: the only thing the reader takes. */
function usableOpList(value: unknown): unknown[] | undefined {
	const list = opListOf(value);
	return list && list.length > 0 ? list : undefined;
}

/**
 * Where a reply's LAST complete ```json fence starts, when that fence holds an
 * empty op list and is the reply's last block: a tidy reply's final "nothing
 * to change", which outranks any draft list the model wrote before it and took
 * back. A fence of any label, an open json fence or an op list after it means
 * the empty list was quoted as an example, and is no answer; a stray ``` line
 * after it is ignored, as everywhere else.
 */
export function lastJsonFenceIsEmptyList(reply: string): number | undefined {
	const raw = toLf(reply);
	const { json, any, openJson } = candidateFences(raw);
	const last = json.at(-1);
	if (!last || openJson || any.filter((fence) => fence.body.trim()).at(-1)?.start !== last.start) return undefined;
	const read = parseJsonLenient(last.body);
	if (!read.ok || opListOf(read.value)?.length !== 0) return undefined;
	const close = fenceMarkers(raw).find((marker) => marker.start > last.start)!;
	return lastBalancedOpList(raw.slice(close.bodyStart)) ? undefined : last.start;
}

/** What the reader made of a reply: the op list it found, or why there is none. */
export interface FoldReplyRead {
	list?: unknown[];
	unreadable?: FoldUnreadableClass;
	/** Where the chosen block started, so the narrative is what came before it. */
	start?: number;
	/** The list came from before a last json fence holding an empty list: maybe a draft the model took back. Counted in the diagnostics only. */
	earlierFence?: true;
}

/**
 * THE READER. It finds the operations wherever a model put them:
 *   1. the last complete ```json fence, when its body parses;
 *   2. else the last complete fence of any label whose body parses;
 *   3. else the last balanced top-level JSON value in the reply, or the value
 *      at the last `{"ops"` or `[{"op"` (so an op list wrapped in another
 *      object, `{"result":{"ops":[...]}}`, is read too). The last value wins:
 *      an unfenced real list FOLLOWED by a quoted example takes the example,
 *      a known limit, rare because the prompt asks for the fenced list last.
 *      A reply ending in an unclosed json fence skips this pass.
 * In every pass the last list wins when its items name any kind, a fold kind
 * or not: a later [{"op":"note"}] replaces the real list, so that a reply of
 * only unknown kinds is still read and its words kept, not called unreadable.
 * The value may be `{"ops": [...]}` or a bare array, trailing commas are
 * forgiven, and stray ``` lines outside the chosen fence are ignored. An empty
 * list is never a drop: it is unusable, and the run treats it as unreadable;
 * when the last json fence holds an empty list, an earlier fence's usable op
 * list is taken instead (pass 2), since the empty one says nothing.
 * A reply that ends inside a ```json fence it never closed is read from that
 * fence's whole remaining body first: when it parses as an op list the reply
 * was complete but for the closing marker, and that open fence wins over any
 * complete fence before it, as the last list does everywhere. A reply that was
 * NOT cut by the cap may have closing prose after the list instead of a marker,
 * so its open body's balanced values are read next. Otherwise the reply was
 * cut off, and that body is left out of every other pass.
 * `truncated` says the reply ran to its output limit; the reader salvages the
 * last complete fence of such a reply like any other, and names the reply cut
 * off only when nothing was salvaged. Never throws.
 */
export function readFoldReply(reply: string, opts: { truncated?: boolean } = {}): FoldReplyRead {
	const raw = toLf(reply);
	const { json, any, openJson } = candidateFences(raw);
	// The first value found that parsed but holds no usable op list, in the
	// order the passes run: it names the class when no pass finds a usable one.
	let shapeOnly: { value: unknown; start: number } | undefined;
	let openParsed = false;
	if (openJson) {
		// A closing marker the cap cut short ("``") is no part of the body.
		const body = raw.slice(openJson.bodyStart).trim().replace(/\n[ \t]*`{1,2}$/, "").trim();
		const read = parseJsonLenient(body);
		const list = read.ok ? usableOpList(read.value) : undefined;
		if (list) return { list, start: openJson.start };
		if (read.ok && typeof read.value === "object" && read.value !== null) {
			// Complete, but no usable list (an empty one, say): not cut off.
			openParsed = true;
			shapeOnly = { value: read.value, start: openJson.start };
		} else if (opts.truncated !== true) {
			const found = lastBalancedOpList(body);
			if (found) return { list: found.list, start: openJson.start };
		}
	}
	const cutOff = opts.truncated === true || (openJson !== undefined && !openParsed);
	let sawBlock = false;
	const take = (value: unknown, start: number): FoldReplyRead | undefined => {
		const list = usableOpList(value);
		if (list) return { list, start };
		shapeOnly ??= { value, start };
		return undefined;
	};
	const lastJson = json[json.length - 1];
	// A block was seen only when a ```json fence had something in it: a reply
	// with a bash sample and no ops is "no-fence", not broken JSON.
	if (json.some((fence) => fence.body.trim())) sawBlock = true;
	let lastEmpty = false;
	if (lastJson) {
		const read = parseJsonLenient(lastJson.body);
		if (read.ok) {
			const found = take(read.value, lastJson.start);
			if (found) return found;
			lastEmpty = opListOf(read.value)?.length === 0;
		}
	}
	/** A list found before a last json fence that held an empty one is marked, for the diagnostics. */
	const marked = (found: FoldReplyRead): FoldReplyRead => (lastEmpty && found.start !== undefined && found.start < lastJson.start ? { ...found, earlierFence: true } : found);
	for (let i = any.length - 1; i >= 0; i--) {
		if (!any[i].body.trim()) continue;
		const read = parseJsonLenient(any[i].body);
		if (!read.ok || typeof read.value !== "object" || read.value === null) continue;
		const found = take(read.value, any[i].start);
		if (found) return marked(found);
	}
	// A reply that ends in a json fence it never closed put its list there: the
	// prose before it may quote an example list, which is never the answer.
	const found = openJson === undefined ? lastBalancedOpList(raw) : undefined;
	if (found) return marked(found);
	if (cutOff) return { unreadable: "cut-off", ...(shapeOnly ? { start: shapeOnly.start } : {}) };
	if (!shapeOnly) return { unreadable: sawBlock ? "invalid-json" : "no-fence" };
	const list = opListOf(shapeOnly.value);
	return { unreadable: list && list.length === 0 ? "empty-list" : "not-a-list", start: shapeOnly.start };
}

const UNREADABLE_PROBLEMS: Readonly<Record<FoldUnreadableClass, string>> = {
	"no-fence": 'the reply has no ```json fence; end the answer with exactly one fence holding {"ops": [ ... ]}',
	"invalid-json": "the reply's ```json fence is not valid JSON",
	"not-a-list": 'the JSON must be an object with an "ops" array, each item an object whose "op" names its kind',
	"empty-list": 'the "ops" list is empty; a session with nothing durable is one drop op with its reason',
	"cut-off": "the reply was cut off at the output limit and holds no complete operations block",
};

export interface ParsedFoldOps {
	/** Every op of the list, each read alone with its place in the reply. */
	items: ReadFoldOp[];
	/** Why the reply is not an op list, for the diagnostics; empty when it is one. */
	problems: string[];
	/** What the model said before the fence — shown to nobody as truth, kept for the record and the diagnostics. */
	narrative: string;
	/** Set when the reader found no usable op list at all: the class the diagnostics count. Per-op problems leave it unset. */
	unreadable?: FoldUnreadableClass;
	/** The list came from before a last json fence holding an empty list (see FoldReplyRead). */
	earlierFence?: true;
}

const NARRATIVE_TRAILING_LABEL = /(?:^|\n)[ \t]*#{1,6}[ \t]*[^\n]*$/;

function narrativeBefore(raw: string, fenceStart: number | undefined): string {
	const before = (fenceStart === undefined ? raw : raw.slice(0, fenceStart)).trim();
	// A trailing "### Operations" (bold or not) labels the fence, it is not narrative.
	const withoutLabel = before.replace(NARRATIVE_TRAILING_LABEL, "").trim();
	return withoutLabel || before;
}

const isString = (value: unknown): value is string => typeof value === "string";

const OP_FIELDS: Readonly<Record<FoldOpKind, readonly string[]>> = {
	add: ["op", "topic", "kind", "text"],
	update: ["op", "id", "text"],
	supersede: ["op", "id", "text"],
	close: ["op", "id"],
	pin: ["op", "id", "because"],
	drop: ["op", "reason"],
};

/**
 * One op as the reply wrote it, read ALONE, with its place in the reply's
 * list: its kind and every field it carries as text. Nothing is judged here:
 * a missing topic, an unknown kind or a stray key is settled per op later, so
 * one malformed op never costs the ops beside it. A list item that is a
 * string is words with no kind; any other item that is not an object is an op
 * with no kind and no words. A text given as a list of lines is those lines, a
 * number or a yes/no is its own spelling, and any other field that is not
 * text is absent.
 */
export interface ReadFoldOp {
	/** Its place in the reply's list, from 0. */
	index: number;
	/** The kind as written, trimmed and lowercased; "" when there is none. */
	op: string;
	topic?: string;
	kind?: string;
	text?: string;
	id?: string;
	because?: string;
	reason?: string;
	/** Keys the kind does not define; for an unknown kind, every key but "op". */
	foreignKeys?: string[];
	/** The op had a "text" that is no text at all (an object, say): traced with its code. */
	textNotText?: true;
}

const READ_FIELDS = ["topic", "kind", "text", "id", "because", "reason"] as const;

export function readFoldOp(value: unknown, index: number): ReadFoldOp {
	if (isString(value)) return { index, op: "", text: value };
	const item = (isPlainObject(value) ? value : {}) as Record<string, unknown>;
	const read: ReadFoldOp = { index, op: isString(item.op) ? item.op.trim().toLowerCase() : "" };
	for (const field of READ_FIELDS) {
		const found = item[field];
		if (isString(found)) read[field] = found;
	}
	if (isString(read.kind)) read.kind = read.kind.trim().toLowerCase();
	const text = item.text;
	if (Array.isArray(text) && text.every(isString)) read.text = text.join("\n");
	else if (typeof text === "number" || typeof text === "boolean") read.text = String(text);
	else if (text !== undefined && text !== null && !isString(text)) read.textNotText = true;
	const known = new Set(["op", ...((OP_FIELDS as Readonly<Record<string, readonly string[]>>)[read.op] ?? [])]);
	const foreign = Object.keys(item).filter((key) => !known.has(key));
	if (foreign.length > 0) read.foreignKeys = foreign;
	return read;
}

/** The parsed ops of a fold reply plus the narrative that preceded them. Never throws. */
export function parseFoldOps(reply: string, opts: { truncated?: boolean } = {}): ParsedFoldOps {
	const raw = toLf(reply);
	const read = readFoldReply(reply, opts);
	const narrative = narrativeBefore(raw, read.start);
	if (!read.list) {
		const unreadable = read.unreadable ?? "no-fence";
		return { items: [], problems: [UNREADABLE_PROBLEMS[unreadable]], narrative, unreadable };
	}
	return { items: read.list.map(readFoldOp), problems: [], narrative, ...(read.earlierFence ? { earlierFence: true as const } : {}) };
}

// --- Deciding each op ---------------------------------------------------------

function nearestEntryId(id: string, areas: AreaRow[]): string | undefined {
	// An id copied with its whole address — "m-0031 · saved 2026-08-02" — names
	// the entry before the first separator.
	const wanted = id.split("·")[0].toLowerCase().replace(/[^a-z0-9]/g, "");
	if (!wanted) return undefined;
	for (const area of areas) if (area.id.toLowerCase().replace(/[^a-z0-9]/g, "") === wanted) return area.id;
	return undefined;
}

/**
 * The ONE topic match, shared by the decision and the applier: trimmed and
 * case-insensitive. They must agree: a decision that read "commercial terms"
 * as a NEW topic while the applier filed it under the existing "Commercial
 * terms" would judge the op by rules that do not govern where it lands.
 */
function sameTopic(a: string, b: string): boolean {
	return a.trim().toLowerCase() === b.trim().toLowerCase();
}

/**
 * Words that carry no subject: "Team and roles" and "Team roles" are the one
 * topic, and a title that differs from an existing one by nothing but these
 * would split a subject across two headings.
 */
const TOPIC_TITLE_STOP_WORDS = new Set(["the", "a", "an", "and", "of", "for", "to", "in", "on", "with"]);

/**
 * A topic title reduced to the subject it names: lowercase, punctuation gone,
 * stop words dropped, a plural "s" trimmed from each word, one space between
 * words. Letters of any alphabet count as letters, so a German title keeps its
 * umlauts instead of splitting at them.
 */
export function normalizeTopicTitle(title: string): string {
	return title
		.toLowerCase()
		.replace(/[^\p{L}\p{N}]+/gu, " ")
		.split(" ")
		.filter((word) => word && !TOPIC_TITLE_STOP_WORDS.has(word))
		.map((word) => word.replace(/s$/, ""))
		.join(" ");
}

/**
 * The existing topic a new title is a near-duplicate of, if any: the two name
 * the same subject once normalised, or one names a subject the other narrows
 * ("Nordwind integration retries" inside "Nordwind integration") — provided
 * the narrower one is at least two words, because a one-word title inside a
 * longer one ("Nordwind" in "Nordwind integration") is a real new subject
 * more often than not. A title that matches an existing one exactly (case
 * aside) is not a near-duplicate; it is that topic, and the caller files
 * under it. Shared with Review's `move`, which faces the same choice.
 */
export function nearDuplicateTopicTitle(title: string, existing: Iterable<string>): string | undefined {
	const wanted = normalizeTopicTitle(title);
	if (!wanted) return undefined;
	const wantedWords = wanted.split(" ").length;
	for (const candidate of existing) {
		if (sameTopic(candidate, title)) continue;
		const have = normalizeTopicTitle(candidate);
		if (!have) continue;
		if (have === wanted) return candidate;
		if (Math.min(wantedWords, have.split(" ").length) < 2) continue;
		if (` ${have} `.includes(` ${wanted} `) || ` ${wanted} `.includes(` ${have} `)) return candidate;
	}
	return undefined;
}

/**
 * True when a topic writes its entries as bullets: a topic with no entries yet
 * starts as bullets (every topic the product writes does), and a topic whose
 * entries are all paragraphs accepts either shape.
 */
function topicWantsBullets(topic: string, areas: AreaRow[]): boolean {
	const rows = areas.filter((area) => sameTopic(area.topic, topic));
	if (rows.length === 0) return true;
	return rows.some((row) => BULLET_START.test(row.firstLine));
}

/** A copied entry metadata line or a conversation's rc_metadata line, whole on its own line: bookkeeping, never words of a note. */
const COPIED_COMMENT_LINE = /^\s*<!--\s*(?:e\s*:|rc_metadata\b).*-->\s*$/;

/** The topic a change goes to when the reply gives it no home of its own: the holding topic the next Memorize or Review sorts. */
export const FOLD_UNSORTED_TOPIC = "Unsorted";

/** How one op of a reply ended. `normalised` is applied after a fix by code. */
export type FoldOpFate = "applied" | "normalised" | "redirected" | "left-out" | "traced";

/** One op's ending with its codes, for the diagnostics. Codes only, never room text. */
export interface FoldOpDecision {
	index: number;
	/** The op's kind: one of the grammar's, "unpin", or "other". */
	op: string;
	fate: FoldOpFate;
	codes: string[];
}

/**
 * Pairs of a new text and a note it looks like, by what became of the new
 * text; the pairs within one reply are counted apart from those against memory.
 */
export interface FoldPairCounts {
	/** Left out: a note says the same, and the words of the new text are in it in the same order. A close's or a pin's text that only repeats its note counts here too. */
	subset: number;
	/** Left out: another text of the same reply says it the same way. */
	subsetInReply: number;
	/** Kept beside a note that says the same in fewer words. */
	beside: number;
	/** Kept and tagged: it may disagree with a note. */
	mayDisagree: number;
	/** Kept untagged: it may disagree with an earlier add of the same reply. */
	mayDisagreeInReply: number;
	/** Kept beside a note the person pinned, and tagged. */
	besidePinned: number;
}

export interface FoldDecisions {
	/** What the applier applies: every id names an area, and no text op names a pinned note. */
	ops: FoldOp[];
	decisions: FoldOpDecision[];
	pairs: FoldPairCounts;
	/** False when nothing of the reply landed: no op applied or redirected, none left out as already in memory, and no drop. */
	landed: boolean;
}

export interface FoldDecideContext {
	/** Notes pinned for this run's folds only (a resume's kept notes): a change to one is added beside it, but untagged, since the person did not pin it. */
	keptForFolds?: ReadonlySet<string>;
}

/** A new note on its way to the repeat rules. */
interface AddCandidate {
	index: number;
	/** It is not the op as written: its text was redirected here. */
	redirected: boolean;
	topic: string;
	kind: FoldAddKind;
	text: string;
	/** The note the text was aimed at, judged first. */
	target?: AreaRow;
	/** The op wanted to change a note the person pinned. */
	besidePinned?: boolean;
	/** The text rode on a close or a pin: when it says nothing new, it is traced rather than left out. */
	foreign?: boolean;
	/** An older rewrite judged to disagree with the note it was aimed at, however it is worded: tagged against that note. */
	disagrees?: boolean;
}

/** The kind a note keeps when its text is added beside it: an event is what a session IS, never what a fold writes. */
function besideKind(area: AreaRow): FoldAddKind {
	return area.kind === "event" ? "fact" : area.kind;
}

/** A quote and the page as a quote is found in them: typographic quotes and dashes folded, case and space runs ignored, outer quote marks dropped. */
function quoteKey(text: string): string {
	return text
		.replace(/[“”„‟″«»]/g, '"')
		.replace(/[‘’‚‛′]/g, "'")
		.replace(/[‐-―−]/g, "-")
		.toLowerCase()
		.replace(/\s+/g, " ")
		.trim()
		.replace(/^["']+|["']+$/g, "")
		.trim();
}

/**
 * An op's text as a note of `topic` is written: LF lines, blank lines at the
 * ends trimmed, a copied metadata line removed, a bullet on the first line
 * when the topic writes bullets, and any other line that could change the
 * memory file's structure (a heading, a comment) escaped with a backslash and
 * kept. Nothing a note says can open a topic or forge a metadata line.
 */
function noteTextOf(raw: string, bullets: boolean, codes: string[]): string {
	const lines = toLines(raw.replace(/\s+$/, "")).filter((line) => {
		if (!COPIED_COMMENT_LINE.test(line)) return true;
		codes.push("comment-removed");
		return false;
	});
	while (lines.length > 0 && !lines[0].trim()) lines.shift();
	while (lines.length > 0 && !lines[lines.length - 1].trim()) lines.pop();
	// A text of marks only ("###", "---"), or of the must-keep marker only, says
	// nothing, like a title of marks only: as an update it would empty a note.
	if (!saysMoreThanMustKeep(lines.join("\n"))) return "";
	if (bullets && !BULLET_START.test(lines[0])) {
		lines[0] = `- ${lines[0].trimStart()}`;
		codes.push("bullet");
	}
	return lines.map((line) => {
		// A heading or a comment line would open a topic or forge a metadata
		// line: the rule a hand edit meets too.
		if (!findStructuralLine(line)) return line;
		codes.push("escaped");
		return line.replace(/^(\s*)/, "$1\\");
	}).join("\n");
}

/** A new topic title made usable, or the holding topic when nothing of it names a subject. */
function addTopicOf(raw: string | undefined, rawKind: string | undefined, areas: AreaRow[], codes: string[]): string {
	let topic = (raw ?? "").trim();
	if (!topic) {
		codes.push("topic-missing");
		return FOLD_UNSORTED_TOPIC;
	}
	const stripped = topic.replace(/^#+\s*/, "").trim();
	if (stripped !== topic) codes.push("topic-marks");
	topic = stripped;
	if (!/[\p{L}\p{N}]/u.test(topic)) {
		codes.push("topic-empty");
		return FOLD_UNSORTED_TOPIC;
	}
	if (sameTopic(topic, FOLD_UNSORTED_TOPIC) || sameTopic(topic, FOLD_ACTIVE_ITEMS_TOPIC) || areas.some((area) => sameTopic(area.topic, topic))) return topic;
	if (topic.length > FOLD_TOPIC_TITLE_MAX_CHARS) {
		codes.push("topic-length");
		const cut = topic.slice(0, FOLD_TOPIC_TITLE_MAX_CHARS + 1).replace(/\s+\S*$/, "").trim();
		topic = cut || topic.slice(0, FOLD_TOPIC_TITLE_MAX_CHARS).trim();
	}
	if (topic.length < FOLD_TOPIC_TITLE_MIN_CHARS) {
		codes.push("topic-length");
		return FOLD_UNSORTED_TOPIC;
	}
	// A title that is an existing topic in other words files under it, except
	// that a fact or a practice keeps its own title rather than become an item.
	const twin = nearDuplicateTopicTitle(topic, new Set(areas.map((area) => area.topic)));
	const twinIsActiveItems = twin !== undefined && areas.some((area) => sameTopic(area.topic, twin) && area.section === "Active Items");
	if (twin && !(twinIsActiveItems && rawKind !== "item")) {
		codes.push("topic-twin");
		return twin;
	}
	return topic;
}

/** The kind an add gets under its topic: the topic wins, so an item only ever sits in Active Items and nothing else does. */
function addKindOf(rawKind: string | undefined, topic: string, areas: AreaRow[], codes: string[]): FoldAddKind {
	const activeItems = sameTopic(topic, FOLD_ACTIVE_ITEMS_TOPIC) || areas.some((area) => sameTopic(area.topic, topic) && area.section === "Active Items");
	const kind = (FOLD_ADD_KINDS as readonly string[]).includes(rawKind ?? "") ? (rawKind as FoldAddKind) : undefined;
	if (!kind) {
		codes.push("kind-fixed");
		return activeItems ? "item" : "fact";
	}
	if (kind === "item" && !activeItems) {
		codes.push("item-to-fact");
		return "fact";
	}
	if (kind !== "item" && activeItems) {
		codes.push("fact-to-item");
		return "item";
	}
	return kind;
}

/**
 * What the repeat rules make of a new text against the notes: the first note
 * it says again in fewer or the same words (so it is left out), else the first
 * it may disagree with, else the first it repeats with more words. The note it
 * was aimed at is read first. This is the default verdict a later adjudication
 * would replace. A text carrying the must-keep marker is never the same as a
 * note that is not pinned: its words are there, but the person's request to
 * keep them is not, and the add is what pins them.
 */
function repeatVerdictOf(text: string, notes: readonly AreaRow[]): { verdict: "same" | "disagree" | "beside" | "new"; note?: AreaRow } {
	let disagree: AreaRow | undefined;
	let beside: AreaRow | undefined;
	const mustKeep = hasMustKeepMarker(text);
	for (const note of notes) {
		if (!note.id) continue;
		const pair = classifyNotePair(text, note.text);
		if (pair === "duplicate") {
			if (noteWordsWithin(text, note.text) && (!mustKeep || note.pinned)) return { verdict: "same", note };
			beside ??= note;
		} else if (pair === "conflict") disagree ??= note;
	}
	if (disagree) return { verdict: "disagree", note: disagree };
	if (beside) return { verdict: "beside", note: beside };
	return { verdict: "new" };
}

/**
 * THE DECISION, one op at a time. No rule costs the reply: an op is applied,
 * fixed by code, redirected as a new note, left out because memory already
 * says every word of it in the same order, or, only when it carries no
 * content, traced. Content
 * is never dropped:
 *   - normalise first (topic, kind, bullet, structure, an id copied with its
 *     address), then the gates (an unknown id, a pinned or kept note, a close
 *     on what is not an open item, a pin with no quote from the page), then
 *     the repeat rules against memory and between the reply's own adds;
 *   - a change aimed at a pinned note is added beside it, tagged, and holds
 *     the automatic save; one aimed at a kept note is added beside it untagged;
 *   - a text that may disagree with a note is kept, tagged, and holds the save;
 *   - the same id named twice: the last text wins, an earlier text that says
 *     something the winner does not is added beside the note, and a close or
 *     a pin applies after the text;
 *   - a drop stands only when nothing else was applied or redirected;
 *   - dates decide an older page: when the page's day and a note's learned
 *     day are both known and the page is older, a text that may disagree with
 *     the note goes to the archive as history and the note is untouched, and
 *     any other text aimed at the note is added beside it, untagged (beside a
 *     pinned note it keeps its tag).
 */
export function decideFoldOps(items: readonly ReadFoldOp[], areas: AreaRow[], session: { text: string; date?: string }, ctx: FoldDecideContext = {}): FoldDecisions {
	const kept = ctx.keptForFolds ?? new Set<string>();
	const pageDay = session.date && ISO_DAY.test(session.date) ? session.date : undefined;
	/** The note was learned after this page's day: the page cannot rewrite it. */
	const newerThanPage = (area: AreaRow) => pageDay !== undefined && area.learned !== undefined && ISO_DAY.test(area.learned) && pageDay < area.learned;
	/** No learned day, but saved by a fold or rewritten after this page's day: the floor the prompt calls newer than the page. */
	const rewrittenAfterPage = (area: AreaRow) => {
		const floor = area.learned ? undefined : area.updated ?? (area.from ? area.saved : undefined);
		return pageDay !== undefined && floor !== undefined && ISO_DAY.test(floor) && pageDay < floor;
	};
	/** History is for an older value of the note's fact: a text with no value of its own is another fact, kept beside the note. */
	const olderValueOf = (text: string, area: AreaRow) => classifyNotePair(text, area.text) === "conflict" || negationDiffers(text, area.text) || (noteValueTokens(text).length > 0 && dropsNoteValue(text, area.text));
	const byId = new Map(areas.filter((area) => area.id).map((area) => [area.id, area]));
	const pairs: FoldPairCounts = { subset: 0, subsetInReply: 0, beside: 0, mayDisagree: 0, mayDisagreeInReply: 0, besidePinned: 0 };
	const codesOf = new Map<number, string[]>();
	const code = (item: ReadFoldOp, value: string) => {
		const codes = codesOf.get(item.index) ?? [];
		if (!codes.includes(value)) codes.push(value);
		codesOf.set(item.index, codes);
	};
	/** Each op's fate as it is decided, by reply index; an op with none is traced. */
	const fates = new Map<number, FoldOpFate>();
	/** The ops fixed by code: one that then applies is "normalised". */
	const fixed = new Set<number>();
	const fix = (item: ReadFoldOp, value: string) => {
		code(item, value);
		fixed.add(item.index);
	};
	const itemAt = new Map(items.map((item) => [item.index, item]));
	const adds: AddCandidate[] = [];
	const bulletsFor = (topic: string) => topicWantsBullets(topic, areas);
	const history: FoldOp[] = [];
	/** A text kept in the archive as an older value of `area`, which stays as it is. */
	const toHistory = (item: ReadFoldOp, area: AreaRow, text: string) => {
		code(item, "older-history");
		fates.set(item.index, "redirected");
		history.push({ op: "history", of: area.id, until: area.learned!, text });
	};

	/** The area an op names: exact, or the one its id was copied from with its address. */
	const areaOf = (item: ReadFoldOp): AreaRow | "no-id" | "unknown-id" => {
		const id = item.id?.trim() ?? "";
		if (!id) return "no-id";
		const exact = byId.get(id);
		if (exact) return exact;
		const nearest = nearestEntryId(id, areas);
		if (!nearest) return "unknown-id";
		fix(item, "id-repaired");
		return byId.get(nearest)!;
	};
	/** A text redirected as a new note: to the holding topic, or beside the note it was aimed at. */
	const redirect = (item: ReadFoldOp, raw: string, why: string, where: { beside?: AreaRow; target?: AreaRow; kind?: FoldAddKind; besidePinned?: boolean; foreign?: boolean; disagrees?: boolean } = {}) => {
		const topic = where.beside?.topic ?? FOLD_UNSORTED_TOPIC;
		const codes: string[] = [];
		const text = noteTextOf(raw, bulletsFor(topic), codes);
		if (!text) return code(item, "empty-text");
		code(item, why);
		for (const value of codes) fix(item, value);
		const candidate: AddCandidate = { index: item.index, redirected: true, topic, kind: where.kind ?? (where.beside ? besideKind(where.beside) : "fact"), text, ...(where.beside ?? where.target ? { target: where.beside ?? where.target } : {}), ...(where.besidePinned ? { besidePinned: true } : {}), ...(where.foreign ? { foreign: true } : {}), ...(where.disagrees ? { disagrees: true } : {}) };
		adds.push(candidate);
	};
	/** A text on a close or a pin: kept unless the note it rode on already says every word of it, in order. */
	const foreignText = (item: ReadFoldOp, area: AreaRow | undefined) => {
		if (!item.text?.trim()) return;
		if (item.op === "pin" && area) redirect(item, item.text, "pin-text", { beside: area, foreign: true });
		else redirect(item, item.text, "close-text", { kind: "fact", foreign: true, ...(area ? { target: area } : {}) });
	};

	const textOps: { item: ReadFoldOp; op: "update" | "supersede"; area: AreaRow; text: string }[] = [];
	const closes = new Map<string, ReadFoldOp>();
	const pins = new Map<string, { item: ReadFoldOp; because: string }>();
	const drops: ReadFoldOp[] = [];
	const haystack = normalizeLine(session.text);
	const haystackKey = quoteKey(session.text);

	for (const item of items) {
		const foreign = item.foreignKeys?.filter((key) => !(key === "id" && item.op === "add") && !(key === "text" && (item.op === "drop" || item.op === "close" || item.op === "pin"))) ?? [];
		if (foreign.length > 0 && (FOLD_OP_KINDS as readonly string[]).includes(item.op)) fix(item, "foreign-keys");
		if (item.textNotText) fix(item, "text-not-text");
		switch (item.op) {
			case "add": {
				const codes: string[] = [];
				const topic = addTopicOf(item.topic, item.kind, areas, codes);
				const kind = addKindOf(item.kind, topic, areas, codes);
				const text = noteTextOf(item.text ?? "", bulletsFor(topic), codes);
				for (const value of codes) fix(item, value);
				if (!text) {
					code(item, "empty-text");
					break;
				}
				// An add carrying an existing note's id is judged against THAT note
				// first; it is never turned into an update by look-alike.
				const named = item.id !== undefined ? areaOf(item) : undefined;
				adds.push({ index: item.index, redirected: false, topic, kind, text, ...(typeof named === "object" ? { target: named } : {}) });
				break;
			}
			case "update":
			case "supersede": {
				if (!item.text?.trim()) {
					code(item, "empty-text");
					break;
				}
				const area = areaOf(item);
				if (typeof area === "string") redirect(item, item.text, area);
				else if (newerThanPage(area) && olderValueOf(item.text, area)) {
					const codes: string[] = [];
					const text = noteTextOf(item.text, bulletsFor(area.topic), codes);
					for (const value of codes) fix(item, value);
					if (text) toHistory(item, area, text);
					else code(item, "empty-text");
				} else if (kept.has(area.id)) redirect(item, item.text, "beside-kept", { beside: area });
				// An older text that does not disagree keeps the tag beside a pinned note.
				else if (area.pinned) redirect(item, item.text, "beside-pinned", { beside: area, besidePinned: true });
				else if (newerThanPage(area)) redirect(item, item.text, "older-beside", { beside: area });
				// A note with no learned day rewritten after the page may be newer: a
				// text that disagrees with it is added beside it, tagged, never over it.
				else if (rewrittenAfterPage(area) && textDisagreesWith(item.text, area.text)) redirect(item, item.text, "older-than-floor", { beside: area, disagrees: true });
				else {
					const codes: string[] = [];
					const text = noteTextOf(item.text, bulletsFor(area.topic), codes);
					for (const value of codes) fix(item, value);
					if (!text) {
						code(item, "empty-text");
						break;
					}
					fates.set(item.index, "applied");
					textOps.push({ item, op: item.op, area, text });
				}
				break;
			}
			case "close": {
				const area = areaOf(item);
				if (typeof area === "string") code(item, area);
				else if (kept.has(area.id)) code(item, "close-kept");
				else if (area.pinned) code(item, "close-pinned");
				else if (area.section !== "Active Items" || area.kind !== "item") code(item, "close-not-item");
				else if (closes.has(area.id)) code(item, "same-id-again");
				else {
					closes.set(area.id, item);
					fates.set(item.index, "applied");
				}
				foreignText(item, typeof area === "object" ? area : undefined);
				break;
			}
			case "pin": {
				const area = areaOf(item);
				const quote = normalizeLine(item.because ?? "");
				if (typeof area === "string") code(item, area);
				else if (area.pinned && !kept.has(area.id)) code(item, "already-pinned");
				else if (!quote) code(item, "pin-no-quote");
				else if (!haystack.includes(quote) && !haystackKey.includes(quoteKey(quote))) code(item, "quote-missing");
				else if (pins.has(area.id)) code(item, "same-id-again");
				else {
					if (!haystack.includes(quote)) fix(item, "quote-normalised");
					pins.set(area.id, { item, because: item.because ?? "" });
					fates.set(item.index, "applied");
				}
				foreignText(item, typeof area === "object" ? area : undefined);
				break;
			}
			case "drop":
				drops.push(item);
				if (item.text?.trim()) redirect(item, item.text, "drop-text");
				break;
			default: {
				const why = item.op === "unpin" ? "unpin" : item.op === "" ? "no-kind" : "kind-unknown";
				if (!item.text?.trim()) {
					code(item, why);
					break;
				}
				const named = item.id !== undefined ? areaOf(item) : undefined;
				redirect(item, item.text, why, typeof named === "object" ? { target: named } : {});
			}
		}
	}

	// The same id named twice: the last text wins; an earlier text is added
	// beside the note, and left out below only when the winner says it all.
	const winners = new Map<string, (typeof textOps)[number]>();
	for (const textOp of textOps) winners.set(textOp.area.id, textOp);
	for (const textOp of textOps) {
		const winner = winners.get(textOp.area.id)!;
		if (winner === textOp) continue;
		fates.delete(textOp.item.index);
		redirect(textOp.item, textOp.text, "same-id-earlier", { beside: textOp.area });
	}

	// The repeat rules. First between the reply's own adds, each pair read
	// once: one that says what another says the same way is left out for it,
	// and a pair that may disagree is kept for the count below.
	adds.sort((a, b) => a.index - b.index);
	const alive = adds.map(() => true);
	/** Each tagged add's tag, and the note it is beside or may disagree with. */
	const tags = new Map<AddCandidate, { tag: FoldBesideTag; of: string }>();
	/** For each add, the earlier adds of the reply it may disagree with. */
	const disagreesWith = adds.map((): number[] => []);
	const leaveOut = (candidate: AddCandidate, why: string) => {
		if (why === "same-in-reply") pairs.subsetInReply += 1;
		else pairs.subset += 1;
		code(itemAt.get(candidate.index)!, why);
		if (!candidate.foreign) fates.set(candidate.index, "left-out");
	};
	/** The words of `inner` are in `outer` in the same order, and so is its must-keep marker if it carries one. */
	const saidBy = (inner: string, outer: string) => noteWordsWithin(inner, outer) && (!hasMustKeepMarker(inner) || hasMustKeepMarker(outer));
	for (let j = 0; j < adds.length; j++) {
		for (let i = 0; i < j && alive[j]; i++) {
			if (!alive[i]) continue;
			const pair = classifyNotePair(adds[j].text, adds[i].text);
			if (pair === "conflict") disagreesWith[j].push(i);
			if (pair !== "duplicate") continue;
			if (saidBy(adds[j].text, adds[i].text)) {
				alive[j] = false;
				leaveOut(adds[j], "same-in-reply");
			} else if (saidBy(adds[i].text, adds[j].text)) {
				alive[i] = false;
				leaveOut(adds[i], "same-in-reply");
			}
		}
	}
	// Then against memory, the note aimed at first. A note this reply rewrites
	// or closes is not what memory will say: a text is never left out for its
	// old words, and never tagged against them. The texts that rewrite notes
	// are read instead, as texts of the same reply: an add one of them says in
	// full is left out, and one that disagrees with one is counted, untagged.
	const changing = new Set([...winners.keys(), ...closes.keys()]);
	const lasting = areas.filter((area) => !changing.has(area.id));
	/** The adds that may disagree with another text of the reply. */
	const disagreeInReply = new Set<AddCandidate>();
	adds.forEach((candidate, n) => {
		if (!alive[n]) return;
		const item = itemAt.get(candidate.index)!;
		for (const winner of winners.values()) {
			const pair = classifyNotePair(candidate.text, winner.text);
			if (pair === "duplicate" && saidBy(candidate.text, winner.text)) {
				alive[n] = false;
				return leaveOut(candidate, "same-in-reply");
			}
			if (pair === "conflict") disagreeInReply.add(candidate);
		}
		// A close's or a pin's own text is still read against the note it rode on,
		// for the words it repeats; a note this reply closes or rewrites is never
		// what it is tagged against.
		if (candidate.foreign && candidate.target && changing.has(candidate.target.id) && repeatVerdictOf(candidate.text, [candidate.target]).verdict === "same") {
			alive[n] = false;
			return leaveOut(candidate, "foreign-text");
		}
		const target = candidate.target && !changing.has(candidate.target.id) ? candidate.target : undefined;
		const notes = target ? [target, ...lasting.filter((area) => area !== target)] : lasting;
		const { verdict, note } = repeatVerdictOf(candidate.text, notes);
		if (verdict === "same") {
			alive[n] = false;
			return leaveOut(candidate, candidate.foreign ? "foreign-text" : "subset");
		}
		// A text that may disagree with a note learned after its page is an older
		// value: history against the newest such note, pinned or not, with no tag.
		const newest = notes.filter((area) => area.id && newerThanPage(area) && classifyNotePair(candidate.text, area.text) === "conflict").reduce<AreaRow | undefined>((best, area) => (!best || area.learned! > best.learned! ? area : best), undefined);
		if (newest) {
			alive[n] = false;
			return toHistory(item, newest, candidate.text);
		}
		// An add naming a note learned after its page lands beside it, as an older rewrite does.
		if (!candidate.redirected && target && newerThanPage(target)) code(item, "older-beside");
		if (candidate.besidePinned || (verdict === "disagree" && note!.pinned && !kept.has(note!.id))) {
			tags.set(candidate, { tag: "pinned", of: candidate.besidePinned ? candidate.target!.id : note!.id });
			pairs.besidePinned += 1;
			// A redirect off a pinned note says so in its own code.
			if (!candidate.besidePinned) code(item, "tag-pinned");
		} else if (verdict === "disagree" || (candidate.disagrees && target)) {
			tags.set(candidate, { tag: "may-disagree", of: candidate.disagrees && target ? target.id : note!.id });
			pairs.mayDisagree += 1;
			code(item, "may-disagree");
		} else if (verdict === "beside") {
			pairs.beside += 1;
			code(item, "beside");
		}
	});

	const ops: FoldOp[] = [];
	adds.forEach((candidate, n) => {
		if (!alive[n]) return;
		// Two texts of one reply that may disagree (two adds, or an add and a text
		// that rewrites a note) are both kept, untagged: a reply that lists "step
		// 1", "step 2" is no disagreement with memory, so it holds no automatic
		// save. Each add is counted once.
		if (disagreeInReply.has(candidate) || disagreesWith[n].some((i) => alive[i])) {
			pairs.mayDisagreeInReply += 1;
			code(itemAt.get(candidate.index)!, "disagree-in-reply");
		}
		fates.set(candidate.index, candidate.redirected ? "redirected" : "applied");
		const tag = tags.get(candidate);
		ops.push({ op: "add", topic: candidate.topic, kind: candidate.kind, text: candidate.text, ...(tag ? { beside: tag.tag, besideOf: tag.of } : {}) });
	});
	ops.push(...history);
	for (const winner of winners.values()) {
		// A page with no day rewrites a dated note and takes its day away: counted, so real rooms show how often.
		if (!pageDay && winner.area.learned) code(winner.item, "undated-rewrite");
		ops.push({ op: winner.op, id: winner.area.id, text: winner.text });
	}
	for (const [id] of closes) ops.push({ op: "close", id });
	for (const [id, pin] of pins) ops.push({ op: "pin", id, because: pin.because });

	// A drop stands only when nothing else landed as a change; its reason is
	// the first one given, or none (the card has its own sentence).
	const changed = ops.length > 0;
	if (drops.length > 0) {
		if (changed) for (const drop of drops) code(drop, "drop-with-content");
		else {
			const reason = drops.map((drop) => drop.reason?.trim() ?? "").find(Boolean) ?? "";
			if (!reason) fix(drops[0], "reason-empty");
			fates.set(drops[0].index, "applied");
			for (const drop of drops.slice(1)) code(drop, "extra-drop");
			ops.push({ op: "drop", reason });
		}
	}

	const decisions = items.map((item): FoldOpDecision => {
		const fate = fates.get(item.index) ?? "traced";
		const op = FOLD_OP_KIND_NAMES.has(item.op) ? item.op : "other";
		return { index: item.index, op, fate: fate === "applied" && fixed.has(item.index) ? "normalised" : fate, codes: codesOf.get(item.index) ?? [] };
	});
	const landed = ops.length > 0 || decisions.some((decision) => decision.fate === "left-out");
	return { ops, decisions, pairs, landed };
}

/** The kinds the diagnostics name as they are; any other is "other". An unpin is named: the grammar dropped it, models still write it. */
const FOLD_OP_KIND_NAMES = new Set<string>([...FOLD_OP_KINDS, "unpin"]);

// --- Application -------------------------------------------------------------

export interface FoldRecord {
	sessionId: string;
	dropped?: { reason: string };
	/** `beside` is the tag the card shows: next to a note the person pinned, or it may disagree with a note. */
	added: { id: string; topic: string; kind: EntryKind; text: string; beside?: FoldBesideTag; besideOf?: string }[];
	/** `learnedBefore`: the day the old text was learned, for its archive row. */
	updated: { id: string; before: string; after: string; learnedBefore?: string }[];
	/** `reason` says which value replaced which and why, when the old and the new text disagree on a date, a number or a negation; a mere rewording carries none. */
	superseded: { id: string; before: string; after: string; reason?: string; learnedBefore?: string }[];
	closed: { id: string; text: string }[];
	pinned: string[];
	newTopics: string[];
	/** Older values kept as history: never a note, each an archive row of its own id, beside the note `of` that stays as it is. */
	history: { id: string; of: string; topic: string; section: MemoryTopic["section"]; kind: FoldAddKind; text: string; learned?: string; until: string }[];
}

export interface AppliedFold {
	doc: MemoryDocument;
	record: FoldRecord;
	nextEntryNumber: number;
}

export interface FoldApplyContext {
	sessionId: string;
	/** YYYY-MM-DD — the approval date the whole run is stamped with. */
	savedDate: string;
	/** YYYY-MM-DD: the day the session is from, as its heading names it and the fold prompt says "this session is from"; absent when the heading carries no date. Every text the session writes is learned on this day. */
	sessionDate?: string;
	nextEntryNumber: number;
}

export function foldEntryId(n: number): string {
	return `m-${String(n).padStart(4, "0")}`;
}

function cloneDocument(doc: MemoryDocument): MemoryDocument {
	return {
		...doc,
		topics: doc.topics.map((topic) => ({ ...topic, entries: topic.entries.map((entry) => ({ ...entry, ...(entry.extra ? { extra: { ...entry.extra } } : {}) })) })),
		otherSections: doc.otherSections.map((section) => ({ ...section })),
	};
}

function findEntry(doc: MemoryDocument, id: string): { topic: MemoryTopic; entry: MemoryEntry } | undefined {
	for (const topic of doc.topics) {
		const entry = topic.entries.find((candidate) => candidate.id === id);
		if (entry) return { topic, entry };
	}
	return undefined;
}

function resolveAddTopic(doc: MemoryDocument, title: string, kind: FoldAddKind, record: FoldRecord): MemoryTopic {
	if (kind === "item") {
		const active = doc.topics.find((topic) => topic.section === "Active Items");
		if (active) return active;
		const created: MemoryTopic = { section: "Active Items", title: FOLD_ACTIVE_ITEMS_TOPIC, heading: null, intro: "", entries: [] };
		doc.topics.push(created);
		return created;
	}
	const existing = doc.topics.find((topic) => topic.title === title) ?? doc.topics.find((topic) => sameTopic(topic.title, title));
	if (existing) return existing;
	const created: MemoryTopic = { section: "Deep Memory", title, heading: `### ${title}`, intro: "", entries: [] };
	// A new Deep Memory topic goes after the last Deep Memory topic, so Active
	// Items keeps the end of the document.
	const lastDeep = doc.topics.map((topic) => topic.section).lastIndexOf("Deep Memory");
	doc.topics.splice(lastDeep === -1 ? 0 : lastDeep + 1, 0, created);
	record.newTopics.push(title);
	return created;
}

/**
 * Applies decided ops (decideFoldOps) to a copy of the document. Unnamed entries are the
 * document's own objects copied through, so nothing a fold did not address can
 * change. Recent Context is left exactly as it is: removing the folded entry is
 * the route's job, after the write is approved.
 *
 * Ops that were not decided throw rather than half-apply: an unknown id here
 * means the caller skipped the decision.
 */
export function applyFoldOps(doc: MemoryDocument, ops: FoldOp[], ctx: FoldApplyContext): AppliedFold {
	const next = cloneDocument(doc);
	const record: FoldRecord = { sessionId: ctx.sessionId, added: [], updated: [], superseded: [], closed: [], pinned: [], newTopics: [], history: [] };
	let counter = ctx.nextEntryNumber;
	const entryAt = (id: string) => {
		const found = findEntry(next, id);
		if (!found) throw new Error(`ops were not decided: unknown entry "${id}"`);
		return found;
	};
	const touch = (entry: MemoryEntry) => {
		entry.updated = ctx.savedDate;
		entry.refs = (entry.refs ?? 0) + 1;
	};
	// A text is learned on its page's day; a page with no real day leaves none
	// on the text it writes, and never guesses one.
	const learned = ctx.sessionDate && ISO_DAY.test(ctx.sessionDate) ? ctx.sessionDate : undefined;
	// A rewrite is learned on its page's day; its pair mark is read again after the reply.
	const rewritten = new Set<MemoryEntry>();
	const learn = (entry: MemoryEntry) => {
		if (learned) entry.learned = learned;
		else delete entry.learned;
		rewritten.add(entry);
	};
	// A must-keep marker in the text is the user's own remember-request travelling
	// with the words, and migration reads the same marker as a pin — so an entry a
	// fold writes carrying one is pinned here too, and the next fold may only add
	// beside it. It needs no "because": the request is the text, not a judgement
	// the model made about the user. Once pinned, the marker leaves the text: the
	// pin keeps the note, and a pinned note reads as its words, not as a label.
	// The pin is recorded even on a note that reads as pinned already: a note
	// pinned only for a resume's folds is unpinned after them unless a record
	// says a fold pinned it.
	const pinIfMustKeep = (entry: MemoryEntry) => {
		if (!hasMustKeepMarker(entry.text)) return;
		entry.text = withoutMustKeepMarkers(entry.text);
		entry.pinned = true;
		if (!record.pinned.includes(entry.id)) record.pinned.push(entry.id);
	};

	for (const op of ops) {
		switch (op.op) {
			case "drop":
				record.dropped = { reason: op.reason };
				break;
			case "add": {
				const topic = resolveAddTopic(next, op.topic, op.kind, record);
				const id = foldEntryId(counter);
				counter += 1;
				const entry: MemoryEntry = {
					id,
					kind: op.kind,
					saved: ctx.savedDate,
					from: ctx.sessionId,
					pinned: false,
					text: op.text,
					...(op.kind === "item" ? { status: "open" as const } : {}),
					...(learned ? { learned } : {}),
				};
				topic.entries.push(entry);
				pinIfMustKeep(entry);
				record.added.push({ id, topic: topic.title, kind: op.kind, text: entry.text, ...(op.beside ? { beside: op.beside, ...(op.besideOf ? { besideOf: op.besideOf } : {}) } : {}) });
				break;
			}
			case "update": {
				const { entry } = entryAt(op.id);
				const before = entry.text;
				const learnedBefore = entry.learned;
				entry.text = op.text;
				touch(entry);
				learn(entry);
				pinIfMustKeep(entry);
				record.updated.push({ id: op.id, before, after: entry.text, ...(learnedBefore ? { learnedBefore } : {}) });
				break;
			}
			case "supersede": {
				const { entry } = entryAt(op.id);
				const before = entry.text;
				const learnedBefore = entry.learned;
				entry.text = op.text;
				touch(entry);
				learn(entry);
				pinIfMustKeep(entry);
				// Two texts that disagree on a value say why the newer one won: the
				// day each was learned, when both are known. A rewording says nothing.
				const reason = classifyNotePair(before, entry.text) === "conflict" ? conflictReason(before, entry.text, learnedBefore, entry.learned, ctx.savedDate) : undefined;
				record.superseded.push({ id: op.id, before, after: entry.text, ...(reason ? { reason } : {}), ...(learnedBefore ? { learnedBefore } : {}) });
				break;
			}
			case "close": {
				const { entry } = entryAt(op.id);
				entry.status = "done";
				// A closed item was referenced by this session; the ranker reads refs.
				touch(entry);
				record.closed.push({ id: op.id, text: entry.text });
				break;
			}
			case "pin": {
				const { entry } = entryAt(op.id);
				entry.pinned = true;
				record.pinned.push(op.id);
				break;
			}
			case "history": {
				// A fresh id, never a version of the note: a restore can never bring it back as the current text.
				const { topic, entry } = entryAt(op.of);
				record.history.push({ id: foldEntryId(counter), of: op.of, topic: topic.title, section: topic.section, kind: entry.kind === "event" ? "fact" : entry.kind, text: withoutMustKeepMarkers(op.text), ...(learned ? { learned } : {}), until: op.until });
				counter += 1;
				break;
			}
		}
	}
	// A rewritten note stays marked beside a note the person kept it with only
	// while that note is there and the two still disagree, read on the final texts.
	for (const entry of rewritten) {
		const kept = entry.disagrees?.split(",").filter((id) => {
			const other = findEntry(next, id)?.entry;
			return other !== undefined && textDisagreesWith(entry.text, other.text);
		});
		if (kept?.length) entry.disagrees = kept.join(",");
		else delete entry.disagrees;
	}
	next.nextEntryNumber = counter;
	return { doc: next, record, nextEntryNumber: counter };
}

export interface FoldSummary {
	added: number;
	updated: number;
	superseded: number;
	closed: number;
	dropped: boolean;
}

/** What the card says about one session, counted from what was applied — never from the model's prose. */
export function summarizeFold(record: FoldRecord): FoldSummary {
	return {
		added: record.added.length,
		updated: record.updated.length,
		superseded: record.superseded.length,
		closed: record.closed.length,
		dropped: Boolean(record.dropped),
	};
}

// --- The discussion sign-off -------------------------------------------------

const GUIDANCE_SECTIONS = ["Pin", "Drop", "Corrections", "Topics", "Instructions"] as const;

function guidanceSection(markdown: string, heading: string): string[] {
	const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const start = markdown.search(new RegExp(`^#{2,4}\\s+${escaped}\\s*$`, "im"));
	if (start < 0) return [];
	const afterHeading = markdown.slice(start).replace(new RegExp(`^#{2,4}\\s+${escaped}\\s*\\n?`, "i"), "");
	const nextHeading = afterHeading.search(/^#{2,4}\s+/m);
	const body = nextHeading >= 0 ? afterHeading.slice(0, nextHeading) : afterHeading;
	return toLines(body)
		.map((line) => line.replace(/^\s*[-*+]\s+/, "").trim())
		.filter(Boolean)
		.filter((line) => !/^none\.?$/i.test(line));
}

const GUIDANCE_ARROW = /\s*(?:→|->|=>)\s*/;

function parseGuidanceTopicLine(line: string): FoldGuidanceTopicChange | undefined {
	const create = /^create\s*:\s*(.+)$/i.exec(line);
	if (create) {
		const title = create[1].trim();
		return title ? { action: "create", title } : undefined;
	}
	const merge = /^merge\s*:\s*(.+)$/i.exec(line);
	if (!merge) return undefined;
	const [sourcesPart, titlePart] = merge[1].split(GUIDANCE_ARROW);
	if (!titlePart?.trim()) return undefined;
	const sources = sourcesPart.split(/\s+\+\s+/).map((source) => source.trim()).filter(Boolean);
	if (sources.length < 2) return undefined;
	return { action: "merge", sources, title: titlePart.trim() };
}

const GUIDANCE_DROP_LINE = /^(RC-\d+)\s*(?:—|--|–|-|:)\s*(.+)$/i;

/**
 * The structured sign-off of the discussion, read into guidance every fold call
 * carries. A section the user left empty, wrote "None." into, or never wrote at
 * all reads as nothing asked for; a line that does not fit its section's shape
 * is kept where it can be (a Topics line that is neither create nor merge and a
 * Drop line without an RC id become plain instructions, because the user still
 * said them) rather than discarded.
 */
export function parseFoldGuidance(signoffMarkdown: string): FoldGuidance {
	const markdown = toLf(signoffMarkdown);
	const guidance: FoldGuidance = { pin: [], drop: [], corrections: [], topics: [], instructions: [] };
	for (const line of guidanceSection(markdown, "Pin")) {
		const id = /^`?([A-Za-z][\w-]*)`?\b/.exec(line.trim())?.[1];
		if (id) guidance.pin.push(id);
	}
	for (const line of guidanceSection(markdown, "Drop")) {
		const match = GUIDANCE_DROP_LINE.exec(line);
		if (match) guidance.drop.push({ session: match[1].toUpperCase(), reason: match[2].trim() });
		else guidance.instructions.push(line);
	}
	guidance.corrections.push(...guidanceSection(markdown, "Corrections"));
	for (const line of guidanceSection(markdown, "Topics")) {
		const topic = parseGuidanceTopicLine(line);
		if (topic) guidance.topics.push(topic);
		else guidance.instructions.push(line);
	}
	guidance.instructions.push(...guidanceSection(markdown, "Instructions"));
	return guidance;
}

/**
 * The Task the discussion's sign-off worker answers: the structured handoff
 * that replaces the free-text one, because every fold call carries it and the
 * card lists which of its instructions were applied.
 */
export function buildFoldGuidanceSignoffTask(): string {
	return `## Task: Memorize Discussion Signoff

The user has chosen to fold the discussed sessions into memory. Produce the structured signoff the fold operator receives. It is read by the system, not by a person: every section is a list of lines in the shape given below, and a section with nothing in it holds the single word None.

Use exactly this markdown structure, with all five sections in this order:

## Memorize discussion signoff

### ${GUIDANCE_SECTIONS[0]}
One entry id per line, exactly as it is listed in the memory map, for entries the user asked to keep untouched. Nothing else on the line.

### ${GUIDANCE_SECTIONS[1]}
One session per line as \`RC-NNNN — reason\`: the sessions the user asked to forget, each with the short reason the user is shown when it is disclosed.

### ${GUIDANCE_SECTIONS[2]}
One correction per line: a point the user corrected in the discussion, written as the corrected version reads now. These are newer than memory and newer than the sessions.

### ${GUIDANCE_SECTIONS[3]}
One topic change per line, as \`create: Title\` or \`merge: A + B → C\`, for topics the user asked to create or merge.

### ${GUIDANCE_SECTIONS[4]}
One plain instruction per line: anything else the user asked the fold to honour.

Write only what the user actually asked for in the discussion. Do not invent entry ids, session ids or topics, do not restate the assessment, and do not add commentary around the sections. The corrections, the topic changes and the plain instructions are shown to the user on the card exactly as written: write them as the user would say them, name a conversation by its date and title (never by its RC id), and never mention entry ids, must-keep markers or saved stamps. Return only the signoff markdown. Do not claim anything has been saved.`;
}
