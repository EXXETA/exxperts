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
//     else, and the refusal says so;
//   - a pin or unpin carries the line of the session that asked for it, and the
//     server checks that the line is really there;
//   - "this session held nothing durable" is an operation (drop) with a reason,
//     not silence, and it cannot travel with other operations;
//   - the reply is bounded by construction: at most twelve operations, each at
//     most 120 words, so no fold call can produce a twenty-five-minute reply.
//
// Nothing here talks to a model, a route or the disk: the prompt is a string,
// the parser is a reader, the applier works on a document value. The route owns
// the call, the retry, the Recent Context removal and the write.
//
// The input shapes (MemoryEntry, MemoryTopic, MemoryDocument, AreaRow) are
// declared here structurally: the entry model module owns their canonical
// definitions, and TypeScript's structural typing makes the two compatible
// without this module importing it. Sizes go through the ONE estimator.

import { noteTextsLookAlike } from "./memory-duplicates.js";
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
	refs?: number;
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
	tokens: number;
	firstLine: string;
	/** The whole note, so an add that repeats it can be refused. Nothing else reads it. */
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

export const FOLD_OP_KINDS = ["add", "update", "supersede", "close", "pin", "unpin", "drop"] as const;
export type FoldOpKind = (typeof FOLD_OP_KINDS)[number];

/** The kinds an `add` may mint: an event is what a session IS, never what a fold writes. */
export const FOLD_ADD_KINDS = ["fact", "practice", "item"] as const;
export type FoldAddKind = (typeof FOLD_ADD_KINDS)[number];

/**
 * Keys the grammar does not define, kept by the parser so the validator can
 * refuse them by name: an op carrying a foreign key is an op whose author was
 * writing a different grammar, and the fields it did fill cannot be trusted.
 */
interface FoldOpExtras {
	foreignKeys?: string[];
}

export type FoldOp = FoldOpExtras & (
	| { op: "add"; topic: string; kind: FoldAddKind; text: string }
	| { op: "update"; id: string; text: string }
	| { op: "supersede"; id: string; text: string }
	| { op: "close"; id: string }
	| { op: "pin"; id: string; because?: string }
	| { op: "unpin"; id: string; because?: string }
	| { op: "drop"; reason: string }
);

/** The ops a pinned entry refuses: the fold may add beside it and nothing else. */
const PIN_PROTECTED_OPS = ["update", "supersede", "close", "unpin"] as const;

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

/**
 * The must-keep marker as the memory writes it — "**must-keep**", and equally
 * "**must-keep:**" or "**must-keep —", which the product's own entries use. The
 * same predicate the review layer reads it with, so a marker that pins an entry
 * on migration pins it after a fold too.
 */
const MUST_KEEP_MARKER = /\*\*must-keep\b/i;

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
	session: { id: string; text: string };
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

Maximize durable signal density. A fold is not append-only memory growth. It folds one session into memory so the future persistent agent understands more with fewer, sharper tokens. Integration should make memory denser, not merely larger: prefer folding new understanding into the entry that already carries the point (update, supersede) over adding a parallel entry beside it. A point memory already holds is updated, never repeated: an add that says what an existing entry says is refused with that entry's id.

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

A session is a chronological compression of one working stretch: Session arc, then Body, then Parked. Read it in order and treat it as a trajectory, because later entries supersede earlier ones — a decision recorded early in the session and reversed later in it folds as the reversal, not as the original, and the reversal is a supersede of the entry that carries the old decision, never a second entry beside it. The same holds against memory: this session is newer than everything already in memory, so where it conflicts with an existing entry it wins, unless it explicitly defers to the older one.

## Date Stamps

The system stamps every entry it adds or changes with the approval date, so never write a saved-on stamp of your own and never invent a date. When the session names the day something was decided, agreed, or is due, keep that date inside the entry's own words, because it is part of the point. Never present a saved-on date as the day something happened. A later pass reads the stamps to judge staleness; the text carries the facts.

## Must-Keep Material

A session may carry content marked **must-keep** — explicit user remember-requests and operator-named content from checkpoint compression. Fold must-keep material into the appropriate entry and carry the **must-keep** marker with it in the operation's text, because the user's explicit request outlives the intake buffer. Never drop it, and keep its commitments, numbers, names, and dates exact. An entry whose text carries the marker is pinned by the system, so later folds may only add beside it; that is the point of carrying it. If two must-keep items conflict, keep the newer one and say in your narrative that it superseded the older.

## Pinned Entries

A pinned entry is the user's own, and says so in its address: it reads \`[m-0032 · pinned]\`. A fold never updates, supersedes, closes or unpins one; where the session changes what a pinned entry says, add the newer point beside it and say so in your narrative, and the user decides. Pinning and unpinning are things only the user asks for: emit pin or unpin only when the session itself records that request, and quote the line that records it.

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
		`Every entry of the memory above opens with its own id in square brackets: \`- [m-0031] The Nordwind contract renews annually…\` is the entry \`m-0031\`. An entry written as \`- [m-0032 · pinned] …\` is pinned — it is the user's own, and a fold may only add beside it.`,
		`The brackets are the address, not part of the entry's words. Copy an id exactly as it stands there, address only the ids that memory carries (there are ${areas.length}), and never write a bracketed id into the text of an operation.`,
	].join("\n\n");
}

/** The guidance the user signed off, rendered as instructions the fold must honour. */
export function renderFoldGuidance(guidance: FoldGuidance): string {
	if (foldGuidanceIsEmpty(guidance)) return "The user signed off without further instructions. Follow the assessment.";
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
		`- \`{"op":"pin","id":"<entry id>","because":"<the line of the session that asks for it>"}\` and \`{"op":"unpin","id":"<entry id>","because":"<the line>"}\` — only when the session records the user asking for it. "because" quotes that line as it appears in the session; an operation whose quote is not in the session is refused.`,
		`- \`{"op":"drop","reason":"<why nothing here is durable>"}\` — the session is chatter, a repeat of what memory already holds, or work whose result is already an entry. The session is consolidated and memory does not change; the reason is disclosed to the user, so write it for them in one sentence: call this a conversation, never a session or an RC number, and never name "Deep Memory" or "Active Items". A drop travels alone: it cannot appear beside any other operation.`,
	];
	return [
		"## Task: Fold This Session Into Memory (operations)",
		`You do not rewrite memory. You emit operations against the entries of the memory above, each named by the id in its first line; the system applies them and builds the candidate. An entry you do not name is copied through unchanged — its text, its provenance and its saved-on date survive without any effort on your part, so name only what this session changes.`,
		`Operation shapes (copy an entry id exactly as it stands in its brackets, without them):\n\n${shapes.join("\n")}`,
		`Rules: at most ${FOLD_MAX_OPS} operations for this session — a fold is a handful of decisions, and a session that seems to need more is a session whose durable core you have not found yet; each "text" is at most ${FOLD_MAX_TEXT_WORDS} words and is written the way its topic is written (a bullet starting "- " unless the topic's entries are paragraphs), carrying no bracketed id of its own; one operation per entry id; every id is one the memory above carries; pinned entries take no update, supersede, close or unpin. An operation that breaks a rule is refused with its reason and this session is asked for again, so prefer fewer, exact operations.`,
		`Answer with the narrative and then the operations: at most three lines saying what this session leaves behind and what you chose to do with it, then exactly one \`\`\`json fence holding \`{"ops": [ ... ]}\`. Nothing follows the fence. An empty list is not an answer — choose add, update, supersede, close, pin or unpin, or say the session holds nothing durable with drop. Do not claim anything has been saved.`,
	].join("\n\n");
}

/**
 * The fold prompt: constitution, the memory as the room reads it with every
 * entry's address in its own first line, the legend that reads those addresses,
 * the assessment, the signed-off guidance, and the ONE session. Sections are
 * joined the way the other maintenance prompts join them.
 *
 * `areas` is the map the validator judges the reply against; the prompt itself
 * only counts it, because the addresses are in the memory render.
 */
export function buildFoldPrompt(input: FoldPromptInput): FoldPromptAssembly {
	const now = input.now ?? new Date();
	const guidance = input.guidance ?? { pin: [], drop: [], corrections: [], topics: [], instructions: [] };
	const prompt = [
		absorbFoldConstitution().trim(),
		`## Process Metadata\n\n- Agent id: ${input.agentId}\n- Process type: ${ABSORB_FOLD_WORKER_TYPE}\n- Mode: ${ABSORB_FOLD_MODE}\n- Trigger time: ${now.toISOString()}\n- System-selected model: ${input.model.provider}/${input.model.model}\n- Writes memory: false\n- Session being folded: ${input.session.id} (${input.sessionIndex} of ${input.sessionCount})\n- Entries in core memory: ${input.areas.length}`,
		`## Material: Core Memory As The Room Reads It\n\nThis is the memory as it stands after every earlier fold in this run — Deep Memory and Active Items, the two sections a fold changes. Entry metadata is stripped; each entry carries its own address in its first line, which is how you name a piece of it.\n\n${input.coreContext.trim()}`,
		`## Material: Entries You Can Address\n\n${renderAddressLegend(input.areas)}`,
		`## Material: Signed-Off Assessment\n\n${input.assessmentMarkdown.trim() || "None."}`,
		`## Material: The User's Instructions From The Discussion\n\n${renderFoldGuidance(guidance)}`,
		`## Material: The Session To Fold (${input.sessionIndex} of ${input.sessionCount})\n\nThis is the only session you fold. Earlier sessions of this run are already in the memory above; later ones are folded after you.\n\n${input.session.text.trim()}`,
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

// --- Reading the reply -------------------------------------------------------

/**
 * An unreadable fence, returned rather than thrown: a fold call that came back
 * cut is an ordinary outcome of the loop (that session stays in Recent Context
 * with this reason and the run continues), never an exception the route has to
 * catch to stay alive.
 */
export class FoldOpsJsonProblem {
	constructor(readonly problem: string) {}
}

export function isFoldOpsJsonProblem(value: unknown): value is FoldOpsJsonProblem {
	return value instanceof FoldOpsJsonProblem;
}

/** A complete fenced block: the label, the body, and where the fence started. */
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
 * The operations JSON of a fold reply: the LAST fence, labelled json or not,
 * whatever prose or `###`-decorated narrative surrounds it. Returns the parsed
 * value, or a FoldOpsJsonProblem naming why the reply carries no readable
 * fence. Never throws.
 */
export function extractFoldOpsJson(reply: string): unknown {
	const raw = toLf(reply);
	const fences = completeFences(raw);
	if (fenceMarkerCount(raw) % 2 === 1) {
		return new FoldOpsJsonProblem(fences.length > 0
			? "the reply was cut off inside a ```json fence; the operations after the last complete fence are unreadable"
			: "the reply was cut off inside its ```json fence and holds no complete operations block");
	}
	const fence = chooseFence(fences);
	if (!fence) return new FoldOpsJsonProblem('the reply has no ```json fence; end the answer with exactly one fence holding {"ops": [ ... ]}');
	if (!fence.body.trim()) return new FoldOpsJsonProblem('the reply\'s ```json fence is empty; it must hold {"ops": [ ... ]}');
	try {
		return JSON.parse(fence.body);
	} catch (error) {
		return new FoldOpsJsonProblem(`the reply's \`\`\`json fence is not valid JSON (${(error as Error).message})`);
	}
}

export interface ParsedFoldOps {
	ops: FoldOp[];
	/** Named reasons the reply is not an op list; empty means it parsed. Written for the model's retry. */
	problems: string[];
	/** What the model said before the fence — shown to nobody as truth, kept for the record and the diagnostics. */
	narrative: string;
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
	unpin: ["op", "id", "because"],
	drop: ["op", "reason"],
};

function foreignKeysOf(item: Record<string, unknown>, kind: FoldOpKind): string[] {
	const known = new Set(OP_FIELDS[kind]);
	return Object.keys(item).filter((key) => !known.has(key));
}

/** The parsed ops of a fold reply plus the narrative that preceded them. Never throws. */
export function parseFoldOps(reply: string): ParsedFoldOps {
	const raw = toLf(reply);
	const fence = chooseFence(completeFences(raw));
	const narrative = narrativeBefore(raw, fence?.start);
	const parsed = extractFoldOpsJson(reply);
	if (isFoldOpsJsonProblem(parsed)) return { ops: [], problems: [parsed.problem], narrative };
	const list = Array.isArray(parsed) ? parsed : (parsed as { ops?: unknown })?.ops;
	if (!Array.isArray(list)) return { ops: [], problems: ['the JSON must be an object with an "ops" array'], narrative };
	const ops: FoldOp[] = [];
	const problems: string[] = [];
	list.forEach((value: unknown, index: number) => {
		const label = `op ${index + 1}`;
		const item = (value && typeof value === "object" ? value : {}) as Record<string, unknown>;
		const kind = item.op;
		if (!isString(kind) || !(FOLD_OP_KINDS as readonly string[]).includes(kind)) {
			problems.push(`${label}: "op" must be one of ${FOLD_OP_KINDS.join(", ")}`);
			return;
		}
		const opKind = kind as FoldOpKind;
		const foreign = foreignKeysOf(item, opKind);
		const extras: FoldOpExtras = foreign.length > 0 ? { foreignKeys: foreign } : {};
		const id = isString(item.id) ? item.id.trim() : "";
		const text = isString(item.text) ? item.text : "";
		switch (opKind) {
			case "add": {
				const topic = isString(item.topic) ? item.topic.trim() : "";
				if (!topic) return problems.push(`${label} (add): "topic" is required — a topic title from the list, or a new one`);
				if (!isString(item.kind) || !(FOLD_ADD_KINDS as readonly string[]).includes(item.kind)) return problems.push(`${label} (add): "kind" must be one of ${FOLD_ADD_KINDS.join(", ")}`);
				if (!text.trim()) return problems.push(`${label} (add): "text" must be the entry as it should read in memory`);
				return void ops.push({ ...extras, op: "add", topic, kind: item.kind as FoldAddKind, text });
			}
			case "update":
			case "supersede": {
				if (!id) return problems.push(`${label} (${opKind}): "id" is required — copy an entry id exactly as it is listed`);
				if (!text.trim()) return problems.push(`${label} (${opKind}): "text" must be the entry as it should now read`);
				return void ops.push({ ...extras, op: opKind, id, text });
			}
			case "close": {
				if (!id) return problems.push(`${label} (close): "id" is required — copy an entry id exactly as it is listed`);
				return void ops.push({ ...extras, op: "close", id });
			}
			case "pin":
			case "unpin": {
				if (!id) return problems.push(`${label} (${opKind}): "id" is required — copy an entry id exactly as it is listed`);
				const because = isString(item.because) ? item.because : undefined;
				return void ops.push({ ...extras, op: opKind, id, ...(because === undefined ? {} : { because }) });
			}
			case "drop": {
				if (!isString(item.reason)) return problems.push(`${label} (drop): "reason" must say why this session holds nothing durable`);
				return void ops.push({ ...extras, op: "drop", reason: item.reason });
			}
		}
	});
	return { ops, problems, narrative };
}

// --- Validation --------------------------------------------------------------

function nearestEntryId(id: string, areas: AreaRow[]): string | undefined {
	const wanted = id.toLowerCase().replace(/[^a-z0-9]/g, "");
	if (!wanted) return undefined;
	for (const area of areas) if (area.id.toLowerCase().replace(/[^a-z0-9]/g, "") === wanted) return area.id;
	return undefined;
}

/**
 * The ONE topic match, shared by the validator and the applier: trimmed and
 * case-insensitive. They must agree — a validator that read "commercial terms"
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

function refuseTextShape(text: string, topic: string, areas: AreaRow[], label: string, refusals: string[]): void {
	const words = countWords(text);
	if (words > FOLD_MAX_TEXT_WORDS) {
		refusals.push(`${label}: the text is ${words} words; an entry is at most ${FOLD_MAX_TEXT_WORDS} — say the durable point, or split it across two entries`);
	}
	if (topicWantsBullets(topic, areas) && !BULLET_START.test(firstLineOf(text))) {
		refusals.push(`${label}: the entries of "${topic}" are bullets, so the text must start with "- "`);
	}
}

function refuseTopicTitle(title: string, label: string, refusals: string[]): void {
	if (/^#{1,6}\s/.test(title) || /^#{1,6}$/.test(title)) {
		refusals.push(`${label}: give the topic title without "#" heading marks`);
		return;
	}
	if (title.length < FOLD_TOPIC_TITLE_MIN_CHARS || title.length > FOLD_TOPIC_TITLE_MAX_CHARS) {
		refusals.push(`${label}: a new topic title is ${FOLD_TOPIC_TITLE_MIN_CHARS}–${FOLD_TOPIC_TITLE_MAX_CHARS} characters; "${truncate(title)}" is ${title.length}`);
		return;
	}
	if (/^[\s:]*$/.test(title) || /^:+$/.test(title.replace(/\s+/g, ""))) {
		refusals.push(`${label}: "${truncate(title)}" is punctuation, not a topic title`);
	}
}

/** The session text as a quote is checked against it: one line, one space run, case kept. */
function sessionQuoteHaystack(session: { text: string }): string {
	return normalizeLine(session.text);
}

/**
 * Refusals, each a named reason the model can act on, one line per problem,
 * naming the op's position and the entry it addressed. An empty list means the
 * ops can be applied.
 */
export function validateFoldOps(ops: FoldOp[], areas: AreaRow[], session: { id: string; text: string }): string[] {
	const refusals: string[] = [];
	if (ops.length === 0) {
		return [`no operations: a fold answers with what it changes, or with a single drop saying why ${session.id} holds nothing durable`];
	}
	if (ops.length > FOLD_MAX_OPS) {
		refusals.push(`${ops.length} operations for one session: at most ${FOLD_MAX_OPS} are applied — fold the session's durable core, not every line of it`);
	}
	const drops = ops.filter((op) => op.op === "drop");
	if (drops.length > 0 && ops.length > 1) {
		refusals.push(`a drop says this session changes nothing, so it travels alone; this list holds a drop and ${ops.length - 1} other operation${ops.length - 1 === 1 ? "" : "s"} — choose one or the other`);
	}
	if (drops.length > 1) {
		refusals.push(`${drops.length} drop operations: one session is dropped once, with one reason`);
	}
	const byId = new Map(areas.map((area) => [area.id, area]));
	const claimed = new Map<string, number>();
	const haystack = sessionQuoteHaystack(session);
	/** The adds already judged, so a second add that repeats one is refused against it. */
	const addsSoFar: { index: number; text: string }[] = [];

	ops.forEach((op, index) => {
		const label = `op ${index + 1} (${op.op})`;
		if (op.foreignKeys?.length) {
			refusals.push(`${label}: the key${op.foreignKeys.length === 1 ? "" : "s"} ${op.foreignKeys.map((key) => `"${key}"`).join(", ")} ${op.foreignKeys.length === 1 ? "is" : "are"} not part of this operation; write it with exactly ${OP_FIELDS[op.op].map((field) => `"${field}"`).join(", ")}`);
		}
		if (op.op === "drop") {
			if (!op.reason.trim()) refusals.push(`${label}: a drop carries the reason the user is shown; say why ${session.id} holds nothing durable`);
			return;
		}
		if (op.op === "add") {
			const existing = areas.find((area) => sameTopic(area.topic, op.topic));
			if (!existing) {
				refuseTopicTitle(op.topic, `${label} "${truncate(op.topic, 40)}"`, refusals);
				// A title that is an existing topic in other words would open a
				// second heading for one subject; the refusal names the heading
				// that already holds it.
				const twin = nearDuplicateTopicTitle(op.topic, new Set(areas.map((area) => area.topic)));
				if (twin) refusals.push(`${label}: "${truncate(op.topic, 40)}" is the topic "${twin}"; write "topic":"${twin}"`);
			}
			const wantsActiveItems = op.kind === "item";
			const isActiveItems = sameTopic(op.topic, FOLD_ACTIVE_ITEMS_TOPIC) || existing?.section === "Active Items";
			if (wantsActiveItems && !isActiveItems) {
				refusals.push(`${label}: an item is an open loop and lives in ${FOLD_ACTIVE_ITEMS_TOPIC}; write "topic":"${FOLD_ACTIVE_ITEMS_TOPIC}", or make this a fact or a practice under "${truncate(op.topic, 40)}"`);
			}
			if (!wantsActiveItems && isActiveItems) {
				refusals.push(`${label}: ${FOLD_ACTIVE_ITEMS_TOPIC} holds open loops only; a ${op.kind} belongs under a Deep Memory topic`);
			}
			refuseTextShape(op.text, op.topic, areas, label, refusals);
			// A point memory already holds is updated, never repeated. The areas are
			// read off the run's WORKING COPY before every fold, so a note added by
			// conversation 3 is among the areas conversation 7 is judged against
			// without any further work: the twin check sees this run's own adds.
			const twin = areas.find((area) => area.id && noteTextsLookAlike(op.text, area.text));
			if (twin) refusals.push(`${label}: this says what note "${twin.id}" under "${twin.topic}" already says — update "${twin.id}" if the point changed, or leave it out`);
			const earlier = addsSoFar.find((add) => noteTextsLookAlike(op.text, add.text));
			if (earlier) refusals.push(`${label}: this says what op ${earlier.index + 1} (add) already says — keep one of them`);
			addsSoFar.push({ index, text: op.text });
			return;
		}
		// Every remaining op names an entry by id.
		const area = byId.get(op.id);
		const seen = (claimed.get(op.id) ?? 0) + 1;
		claimed.set(op.id, seen);
		if (seen === 2) refusals.push(`${label}: "${op.id}" is named by more than one operation; one entry takes one operation per fold`);
		if (!area) {
			const nearest = nearestEntryId(op.id, areas);
			refusals.push(`${label}: "${op.id}" is not an entry of this memory${nearest ? ` — did you mean "${nearest}"? Copy ids exactly as they are listed` : "; copy ids exactly as they are listed"}`);
			return;
		}
		if (area.pinned && (PIN_PROTECTED_OPS as readonly string[]).includes(op.op)) {
			refusals.push(`${label}: "${op.id}" is pinned — a pinned entry is the user's own, and a fold may only add an entry beside it; add the newer point as its own entry and say so in the narrative`);
			return;
		}
		switch (op.op) {
			case "update":
			case "supersede":
				refuseTextShape(op.text, area.topic, areas, label, refusals);
				return;
			case "close":
				if (area.section !== "Active Items" || area.kind !== "item") {
					refusals.push(`${label}: "${op.id}" is a ${area.kind} under "${area.topic}", not an open item; only ${FOLD_ACTIVE_ITEMS_TOPIC} entries are closed — supersede it if the point changed`);
				}
				return;
			case "pin":
			case "unpin": {
				const quote = normalizeLine(op.because ?? "");
				if (!quote) {
					refusals.push(`${label}: ${op.op} carries "because" — the line of ${session.id} in which the user asks for it, quoted as it appears there`);
					return;
				}
				if (!haystack.includes(quote)) {
					refusals.push(`${label}: the quoted line "${truncate(quote)}" is not in ${session.id}; ${op.op} only ever follows the user asking for it, quoted from the session`);
				}
				return;
			}
		}
	});
	return refusals;
}

// --- Application -------------------------------------------------------------

export interface FoldRecord {
	sessionId: string;
	dropped?: { reason: string };
	added: { id: string; topic: string; kind: EntryKind; text: string }[];
	updated: { id: string; before: string; after: string }[];
	superseded: { id: string; before: string; after: string }[];
	closed: { id: string; text: string }[];
	pinned: string[];
	unpinned: string[];
	newTopics: string[];
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
	nextEntryNumber: number;
}

export function foldEntryId(n: number): string {
	return `m-${String(n).padStart(4, "0")}`;
}

function cloneDocument(doc: MemoryDocument): MemoryDocument {
	return {
		...doc,
		topics: doc.topics.map((topic) => ({ ...topic, entries: topic.entries.map((entry) => ({ ...entry })) })),
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
 * Applies validated ops to a copy of the document. Unnamed entries are the
 * document's own objects copied through, so nothing a fold did not address can
 * change. Recent Context is left exactly as it is: removing the folded entry is
 * the route's job, after the write is approved.
 *
 * Ops that were not validated throw rather than half-apply — an unknown id here
 * means the caller skipped the validator.
 */
export function applyFoldOps(doc: MemoryDocument, ops: FoldOp[], ctx: FoldApplyContext): AppliedFold {
	const next = cloneDocument(doc);
	const record: FoldRecord = { sessionId: ctx.sessionId, added: [], updated: [], superseded: [], closed: [], pinned: [], unpinned: [], newTopics: [] };
	let counter = ctx.nextEntryNumber;
	const entryAt = (id: string) => {
		const found = findEntry(next, id);
		if (!found) throw new Error(`ops were not validated: unknown entry "${id}"`);
		return found;
	};
	const touch = (entry: MemoryEntry) => {
		entry.updated = ctx.savedDate;
		entry.refs = (entry.refs ?? 0) + 1;
	};
	// A must-keep marker in the text is the user's own remember-request travelling
	// with the words, and migration reads the same marker as a pin — so an entry a
	// fold writes carrying one is pinned here too, and the next fold may only add
	// beside it. It needs no "because": the request is the text, not a judgement
	// the model made about the user.
	const pinIfMustKeep = (entry: MemoryEntry) => {
		if (!MUST_KEEP_MARKER.test(entry.text) || entry.pinned) return;
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
				};
				topic.entries.push(entry);
				pinIfMustKeep(entry);
				record.added.push({ id, topic: topic.title, kind: op.kind, text: op.text });
				break;
			}
			case "update": {
				const { entry } = entryAt(op.id);
				const before = entry.text;
				entry.text = op.text;
				touch(entry);
				pinIfMustKeep(entry);
				record.updated.push({ id: op.id, before, after: op.text });
				break;
			}
			case "supersede": {
				const { entry } = entryAt(op.id);
				const before = entry.text;
				entry.text = op.text;
				touch(entry);
				pinIfMustKeep(entry);
				record.superseded.push({ id: op.id, before, after: op.text });
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
			case "unpin": {
				const { entry } = entryAt(op.id);
				entry.pinned = false;
				record.unpinned.push(op.id);
				break;
			}
		}
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
