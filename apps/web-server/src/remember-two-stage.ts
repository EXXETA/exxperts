// Remember for a conversation too long to read in one pass.
//
// The single pass stays what it always was: the whole transcript in one prompt
// next to the room's memory. When that prompt does not fit the memory model's
// budget, Remember reads the conversation in two stages instead of refusing:
//
//   Stage A: the conversation before its end is cut into parts at user-turn
//   boundaries, never between a tool call and its result, and each part is
//   read on its own by a short extraction prompt (the constitution's
//   priorities without its process text, plus the person's steering). The
//   part notes carry must-keep requests verbatim with their content, decisions
//   and corrections with the old and the new position, what was produced, open
//   threads with their reason, a two-line arc, and what was open when the part
//   ended. At most three parts are read at once. A part ends on its own: a
//   refused part is read again in halves at a high level, and a stretch
//   refused even in quarters gets a placeholder and the page one plain line
//   (the safety net), so one part never fails the others.
//
//   Stage B: one call with the constitution, the room's memory, every part's
//   notes in order, and the end of the conversation verbatim (up to 30 percent
//   of the budget and never more than a part, less when the notes need the
//   room). It writes the same four fields the single pass writes.
//
// Each fact is compressed at most twice, the arc and the corrections are judged
// with the whole conversation in view, and the end state (the decisions, the
// parked threads) is never summarized before the final call reads it.
//
// This module only plans and renders; the caller runs the calls.

import {
	baseDensityTarget,
	CHECKPOINT_COMPRESSION_WORKER_TYPE,
	CHECKPOINT_PAGE_MAX_CHARS,
	checkpointCompressionConstitution,
	checkpointCompressionMemoryMetrics,
	checkpointHumanSteeringSection,
	densityDescription,
	renderCheckpointTranscriptStretch,
	rememberSentenceModelName as modelName,
	type CheckpointCompressionDensity,
	type CheckpointCompressionPromptTelemetry,
	type CheckpointCompressionTranscriptItem,
} from "./checkpoint-compression.js";
import { parseMemoryDocument } from "./memory-entries.js";
import { estimateTokens } from "./token-estimate.js";

/** Stage B's prompt version; the single-pass prompt keeps its own (unversioned) text. */
export const REMEMBER_TWO_STAGE_PROMPT_VERSION = "remember-two-stage-v1";
/** The largest share of the budget the verbatim end of the conversation may take. */
export const REMEMBER_TAIL_SHARE = 0.3;
/** The share of the budget kept free under stage B, for the estimator's error. */
export const REMEMBER_MARGIN_SHARE = 0.1;
/** What one part's notes are asked to stay under, and what the plan reserves for them in stage B. */
export const REMEMBER_PART_NOTE_CEILING_TOKENS = 1_500;
/** Parts read at the same time. */
export const REMEMBER_PART_PARALLELISM = 3;
/** Tokens the entry's ceiling grows by for every part beyond the first. */
export const REMEMBER_CEILING_STEP_TOKENS = 250;
/** How many times a refused stretch is halved: quarters at most. */
export const REMEMBER_SPLIT_DEPTH = 2;

/** What a refused stretch is read with the second time, and the final call too (drafts). */
export const REMEMBER_HIGH_LEVEL_LINES = [
	"Write these notes at a high level. Say what was discussed, decided and left open, in general terms.",
	"Leave out sensitive specifics: no quotes of harmful or explicit content, no personal data beyond first names, no step-by-step detail of anything dangerous.",
	"Keep every decision, correction, open thread and must-keep request, phrased generally.",
] as const;
/** Messages of the conversation (1-based, inclusive) that no read could note. */
export interface RememberUnreadRange {
	first: number;
	last: number;
}

/** What the final call is told, once, about the stretches no read could note. */
function unreadSentence(ranges: RememberUnreadRange[]): string {
	const spans = ranges.map((range) => (range.first === range.last ? `${range.first}` : `${range.first} to ${range.last}`));
	const one = ranges.length === 1 && ranges[0]!.first === ranges[0]!.last;
	const list = spans.length > 1 ? `${spans.slice(0, -1).join(", ")} and ${spans.at(-1)}` : spans[0];
	return `${one ? "Message" : "Messages"} ${list} ${one ? "was" : "were"} not read. Write nothing about ${one ? "it" : "them"}.`;
}

/** A prompt with the high-level lines added at its end. */
export function withHighLevelLines(prompt: string): string {
	return `${prompt.trimEnd()}\n\n---\n\n## Read at a High Level\n\n${REMEMBER_HIGH_LEVEL_LINES.map((line) => `- ${line}`).join("\n")}\n`;
}

/**
 * The one setting for the part ceiling: the most transcript one read (the
 * single pass or one part) may hold, whatever the window. Not decided yet:
 * it is chosen on quality and cost, relative to the model, by measurement.
 * Until then there is none (null), so a conversation is read in parts only
 * when the single pass does not fit, each part up to the budget. The real
 * run sets EXXPERTS_REMEMBER_PART_CAP_TOKENS to try 32k, 64k and none.
 */
export function rememberPartCeilingTokens(): number | null {
	const raw = Number(process.env.EXXPERTS_REMEMBER_PART_CAP_TOKENS);
	return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : null;
}

/** The part size: the model's reading budget, or the ceiling when it is lower. */
export function rememberPartCapTokens(budget: number): number {
	const ceiling = rememberPartCeilingTokens();
	return ceiling == null ? budget : Math.min(budget, ceiling);
}

export interface RememberPromptContext {
	agentId: string;
	conversationId: string;
	model: { provider: string; model: string; label?: string };
	density: CheckpointCompressionDensity;
	rememberText?: string;
	l1b: string;
	now?: Date;
}

/** One stretch of the conversation, with its place in the whole (0-based index of its first item). */
export interface RememberStretch {
	items: CheckpointCompressionTranscriptItem[];
	firstIndex: number;
}

export interface RememberPartsPlan {
	parts: RememberStretch[];
	tail: RememberStretch;
	/** Parts read by stage A, plus one for the verbatim end when it holds anything. */
	readCount: number;
	budget: number;
	partContentTokens: number;
	tailTokens: number;
}

export class RememberTooLargeError extends Error {
	readonly statusCode = 413;
	constructor(message: string) {
		super(message);
		this.name = "RememberTooLargeError";
	}
}

/** The sentence a Remember gets when the memory model's window cannot hold even the notes. */
export function rememberWindowTooSmallMessage(model: { provider: string; model: string; label?: string }): string {
	return `This conversation is too long for ${modelName(model)} to remember next to this room's memory, even read in parts. Choose a Memory model that can read more at once in Room settings, Model, then Generate again. Nothing was saved.`;
}

/** The sentence a Remember gets when the model's reply to part of the conversation is cut before its first line at every size: the same model would meet it again. */
export function rememberNoLineMessage(model: { provider: string; model: string; label?: string }): string {
	return `${modelName(model)} could not write notes for part of this conversation. Choose another Memory model in Room settings, Model, then Generate again. Nothing was saved.`;
}

// --- Cutting the conversation --------------------------------------------------

/** The rendered size of one item, the way the prompts render it. */
function itemTokens(item: CheckpointCompressionTranscriptItem): number {
	return estimateTokens(renderCheckpointTranscriptStretch([item], 0).transcript) + 2;
}

function isToolCallRequest(item: CheckpointCompressionTranscriptItem): boolean {
	return item.kind === "assistant" && /\[tool call requested: /.test(String(item.text ?? ""));
}

function isToolOutput(item: CheckpointCompressionTranscriptItem): boolean {
	return item.kind === "toolResult" || item.kind === "tool";
}

/**
 * The smallest pieces a part boundary may fall between: one item, except that
 * an assistant message that asked for tools keeps the results that answered
 * it. Each unit knows the index of its first item in the whole conversation.
 */
interface Unit {
	items: CheckpointCompressionTranscriptItem[];
	firstIndex: number;
	tokens: number;
	startsTurn: boolean;
}

function unitsOf(items: CheckpointCompressionTranscriptItem[]): Unit[] {
	const units: Unit[] = [];
	items.forEach((item, index) => {
		const previous = units[units.length - 1];
		const joinsPrevious = previous && isToolOutput(item) && (isToolCallRequest(previous.items[0]!) || isToolOutput(previous.items[previous.items.length - 1]!));
		if (joinsPrevious) {
			previous.items.push(item);
			previous.tokens += itemTokens(item);
			return;
		}
		units.push({ items: [item], firstIndex: index, tokens: itemTokens(item), startsTurn: item.kind === "user" });
	});
	return units;
}

/**
 * A text split at paragraph ends into pieces of at most `maxChars`; a
 * paragraph longer than that on its own (minified JSON, a log) is cut where the
 * limit falls, because there is nothing smaller to cut at.
 */
export function splitTextAtParagraphs(text: string, maxChars: number): string[] {
	if (text.length <= maxChars) return [text];
	const pieces: string[] = [];
	let current = "";
	for (const paragraph of text.split(/\n\n+/)) {
		const candidate = current ? `${current}\n\n${paragraph}` : paragraph;
		if (candidate.length <= maxChars) {
			current = candidate;
			continue;
		}
		if (current) pieces.push(current);
		current = "";
		let rest = paragraph;
		while (rest.length > maxChars) {
			pieces.push(rest.slice(0, maxChars));
			rest = rest.slice(maxChars);
		}
		current = rest;
	}
	if (current) pieces.push(current);
	return pieces;
}

/** A unit too large for one part, as pieces that each fit; the pieces keep their order and their numbering. */
function splitUnit(unit: Unit, maxTokens: number): Unit[] {
	const pieces: Unit[] = [];
	unit.items.forEach((item, offset) => {
		const index = unit.firstIndex + offset;
		const tokens = itemTokens(item);
		if (tokens <= maxTokens || item.text == null) {
			// A tool result rides with the last piece of the message that asked for it.
			const last = pieces[pieces.length - 1];
			if (last && isToolOutput(item) && last.tokens + tokens <= maxTokens) {
				last.items.push(item);
				last.tokens += tokens;
			} else {
				pieces.push({ items: [item], firstIndex: index, tokens, startsTurn: offset === 0 && unit.startsTurn });
			}
			return;
		}
		// Room for the heading and the continuation line around each piece.
		const maxChars = Math.max(1_000, (maxTokens - 60) * 4);
		const texts = splitTextAtParagraphs(String(item.text), maxChars);
		texts.forEach((text, n) => {
			const piece = { ...item, text: `${text}\n\n[message continues: piece ${n + 1} of ${texts.length}]` };
			pieces.push({ items: [piece], firstIndex: index, tokens: itemTokens(piece), startsTurn: offset === 0 && n === 0 && unit.startsTurn });
		});
	});
	return pieces;
}

/** Units packed into parts of at most `maxTokens`, a new part starting at a user turn whenever the current one is full. */
function packParts(units: Unit[], maxTokens: number): RememberStretch[] {
	// Turns first: a user message and everything until the next one.
	const turns: Unit[][] = [];
	for (const unit of units) {
		if (unit.startsTurn || turns.length === 0) turns.push([unit]);
		else turns[turns.length - 1]!.push(unit);
	}
	const parts: RememberStretch[] = [];
	let current: Unit[] = [];
	let currentTokens = 0;
	const close = () => {
		if (current.length === 0) return;
		parts.push({ items: current.flatMap((unit) => unit.items), firstIndex: current[0]!.firstIndex });
		current = [];
		currentTokens = 0;
	};
	const add = (unit: Unit) => {
		if (currentTokens + unit.tokens > maxTokens) close();
		current.push(unit);
		currentTokens += unit.tokens;
	};
	for (const turn of turns) {
		const turnTokens = turn.reduce((sum, unit) => sum + unit.tokens, 0);
		if (currentTokens + turnTokens <= maxTokens) {
			for (const unit of turn) add(unit);
			continue;
		}
		close();
		if (turnTokens <= maxTokens) {
			for (const unit of turn) add(unit);
			continue;
		}
		// A turn larger than a part: its units, and a unit larger than a part
		// split into pieces, packed in order.
		for (const unit of turn) {
			for (const piece of unit.tokens <= maxTokens ? [unit] : splitUnit(unit, maxTokens)) add(piece);
		}
	}
	close();
	return parts;
}

/**
 * A stretch cut in two halves of about the same size, at a unit boundary when
 * it has more than one unit, else at a paragraph end. Null when it cannot be
 * cut (one short item).
 */
export function splitRememberStretch(stretch: RememberStretch): [RememberStretch, RememberStretch] | null {
	let units = unitsOf(stretch.items).map((unit) => ({ ...unit, firstIndex: unit.firstIndex + stretch.firstIndex }));
	const total = units.reduce((sum, unit) => sum + unit.tokens, 0);
	if (units.length === 1) units = splitUnit(units[0]!, Math.ceil(total / 2) + 60);
	if (units.length < 2) return null;
	let cut = 1;
	let tokens = units[0]!.tokens;
	while (cut < units.length - 1 && tokens + units[cut]!.tokens <= total / 2) {
		tokens += units[cut]!.tokens;
		cut += 1;
	}
	const half = (from: typeof units): RememberStretch => ({ items: from.flatMap((unit) => unit.items), firstIndex: from[0]!.firstIndex });
	return [half(units.slice(0, cut)), half(units.slice(cut))];
}

/** The newest units whose total stays under `maxTokens`, never splitting a unit. */
function pickTail(units: Unit[], maxTokens: number): number {
	let tokens = 0;
	let start = units.length;
	while (start > 0 && tokens + units[start - 1]!.tokens <= maxTokens) {
		start -= 1;
		tokens += units[start]!.tokens;
	}
	return start;
}

// --- The prompts ---------------------------------------------------------------

function stretchRange(stretch: RememberStretch): string {
	const last = stretch.firstIndex + stretch.items.length;
	return stretch.items.length === 0 ? "none" : `messages ${stretch.firstIndex + 1} to ${last}`;
}

/** The prompt a part's note is kept under: its number and count left out, so a replan that adds a part finds the notes of the stretches it did not change. */
export function rememberPartKeyPrompt(context: RememberPromptContext, part: RememberStretch, highLevel: boolean): string {
	const prompt = buildRememberPartPrompt(context, part, 0, 0);
	return highLevel ? withHighLevelLines(prompt) : prompt;
}

/** Stage A: one part of the conversation, read for notes. */
export function buildRememberPartPrompt(context: RememberPromptContext, part: RememberStretch, partNumber: number, partCount: number): string {
	const transcript = renderCheckpointTranscriptStretch(part.items, part.firstIndex).transcript;
	return [
		`# exxperts Remember: reading one part of a long conversation

You are a platform-owned worker inside exxperts. The conversation below was too long to read in one pass, so it is read in parts, in order; you read part ${partNumber} of ${partCount}. A later step reads the notes on every part together with the room's memory and writes the memory entry. You write notes, not the entry. You are not the room, you do not address the user, and nothing you write is saved as it is.

## What to note, in this order

1. **Must-keep.** Every place where the user asked to remember, keep or not forget something, in any phrasing and any language. Quote the request word for word and carry the content it points at in full: names, numbers, dates and commitments exactly as said. Content the operator steering below names is must-keep too.
2. **Facts.** Facts stated about the person, the work and the world that a later conversation may need, each once, exactly as said, with its number, name or date.
3. **Decisions and corrections.** What was decided, adopted, reversed or corrected. For a correction, give the old position and the new one.
4. **What was produced.** Documents, plans, code, designs and other deliverables, and where a finding came from (the file, the tool, the source).
5. **Open threads.** What was left unresolved, and why.
6. **The arc.** Where this part started and where it ended, in two lines.

Shed greetings, dead ends that taught nothing, mechanical steps and restated tool output; a line restated many times is noted once, not shed. Invent nothing, and note nothing that is not in this part.

## Output

Return exactly these labelled sections, in this order, and nothing else. Write None under a section with nothing in it. Stay under about ${REMEMBER_PART_NOTE_CEILING_TOKENS} tokens; must-keep content is never shortened to get there.

MUST-KEEP:
- "<the request, word for word>": <the content it points at, exact>

FACTS:
- <the fact, exactly as said>

DECISIONS AND CORRECTIONS:
- <decision, or old position -> new position>

PRODUCED:
- <what was produced, and where it came from>

OPEN THREADS:
- <thread>: <why it is open>

ARC:
<two lines>

OPEN AT THE END OF THIS PART:
<what was still in progress when this part ends, or None>`,
		checkpointHumanSteeringSection(context.rememberText),
		`## Material: Part ${partNumber} of ${partCount} of the Conversation (${stretchRange(part)})\n\n${transcript}`,
	].join("\n\n---\n\n") + "\n";
}

export const REMEMBER_PART_TRIGGER = "Write the notes on this part now.";

/** A part read once more because its notes came out far over their ceiling. */
export function buildRememberPartShortenPrompt(partPrompt: string, noteTokens: number): string {
	return `${partPrompt.trimEnd()}\n\n---\n\n## Retry Notice\n\nYour notes on this part came to about ${noteTokens.toLocaleString("en-US")} tokens. Write them again under ${REMEMBER_PART_NOTE_CEILING_TOKENS.toLocaleString("en-US")} tokens: shorten everything except must-keep content, which stays word for word.\n`;
}

/** The entry's size target on the multi-part path: the base target, 250 tokens more per read beyond the first, at most twice the base. */
export function rememberPartsTargetTokens(density: CheckpointCompressionDensity, readCount: number): { min?: number; max: number } {
	const base = baseDensityTarget(density);
	const max = Math.min(base.max * 2, base.max + REMEMBER_CEILING_STEP_TOKENS * Math.max(0, readCount - 1));
	return { ...(base.min != null ? { min: base.min } : {}), max };
}

/** Stage B: the constitution, the memory, every part's notes and the verbatim end, for the four fields. */
export function buildRememberFinalPrompt(context: RememberPromptContext, input: { notes: string[]; parts: RememberStretch[]; tail: RememberStretch; readCount: number; unread?: RememberUnreadRange[] }): { prompt: string; targetTokens: { min?: number; max: number }; tailTranscript: string; tailElidedItemCount: number } {
	const now = context.now ?? new Date();
	const targetTokens = rememberPartsTargetTokens(context.density, input.readCount);
	const tail = renderCheckpointTranscriptStretch(input.tail.items, input.tail.firstIndex);
	const partCount = input.parts.length;
	const notes = input.parts.map((part, index) => `### Notes on part ${index + 1} of ${partCount} (${stretchRange(part)})\n\n${String(input.notes[index] ?? "").trim() || "None"}`);
	const prompt = [
		checkpointCompressionConstitution().trim(),
		`## Compression Target\n\n${densityDescription(context.density, targetTokens, "none")}\n\nThis conversation was long and was read in ${input.readCount} parts, so the target is larger than for a single pass. Must-keep material from every part stays.`,
		`## Material: Runtime Metadata\n\n- Agent id: ${context.agentId}\n- Local active-thread conversation id: ${context.conversationId}\n- Formal session id: none yet; this proposal is pre-approval\n- Checkpoint trigger time: ${now.toISOString()}\n- Locked model for this compression worker: ${context.model.provider}/${context.model.model}${context.model.label ? ` (${context.model.label})` : ""}\n- Process type: ${CHECKPOINT_COMPRESSION_WORKER_TYPE}\n- Read: in ${input.readCount} parts (${REMEMBER_TWO_STAGE_PROMPT_VERSION})\n- Writes memory: false`,
		`## Material: Current L1b Memory State\n\nThe following is the current official L1b memory state. Use it to compress differentially and avoid duplicating stable memory.\n\n${context.l1b.trim()}`,
		`## Material: Notes on the Earlier Parts of the Conversation\n\nThe conversation was too long to read in one pass. A reader went through its earlier parts in order and wrote the notes below. Treat them as the transcript of those parts: a MUST-KEEP item in them is must-keep for this entry, a correction in them replaced the earlier position, and an open thread in them stays open unless the end of the conversation closed it.\n\n${notes.join("\n\n")}${input.unread?.length ? `\n\n${unreadSentence(input.unread)}` : ""}`,
		input.tail.items.length > 0
			? `## Material: The End of the Conversation, Verbatim (${stretchRange(input.tail)})\n\nThis is how the conversation ended, word for word. The live active thread remains resumable and is not mutated by this operation.\n\n${tail.transcript}`
			: `## Material: The End of the Conversation\n\nThe notes above cover the whole conversation, its end included.`,
		checkpointHumanSteeringSection(context.rememberText),
		`## Trigger\n\nProduce exactly the four fields required by the Output Contract: TITLE, SESSION_ARC, BODY, and PARKED. Do not produce final Recent Context markdown. Do not claim anything has been saved.`,
	].join("\n\n---\n\n") + "\n";
	return { prompt, targetTokens, tailTranscript: tail.transcript, tailElidedItemCount: tail.elidedItemCount };
}

// --- The plan ------------------------------------------------------------------

/**
 * Where the conversation is cut. The verbatim end takes at most 30 percent of
 * the budget and never more than what is left after the constitution, the
 * memory, the steering, a note per part and a 10 percent margin; the rest is
 * cut into parts no larger than the quality cap allows. Taking room from the
 * end can add a part, so the plan settles in a few rounds. Throws the plain
 * sentence when the notes alone do not fit.
 */
export function planRememberParts(context: RememberPromptContext, items: CheckpointCompressionTranscriptItem[], budget: number, options: { maxPartTokens?: number; maxTailTokens?: number } = {}): RememberPartsPlan {
	const units = unitsOf(items);
	const emptyStretch: RememberStretch = { items: [], firstIndex: 0 };
	const finalOverhead = estimateTokens(buildRememberFinalPrompt(context, { notes: [], parts: [], tail: emptyStretch, readCount: 2 }).prompt);
	const noteFrame = 40;
	const partOverhead = estimateTokens(buildRememberPartPrompt(context, emptyStretch, 1, 1)) + REMEMBER_PART_NOTE_CEILING_TOKENS;
	const capContentTokens = rememberPartCapTokens(budget) - partOverhead;
	if (capContentTokens < 1_000) throw new RememberTooLargeError(rememberWindowTooSmallMessage(context.model));
	// A refused or too-long single pass is read again in smaller parts (at most
	// half the transcript), however short it is, so the end cannot hold it all.
	// A part of the asked size that would hold the whole conversation as read
	// here (one under the floor, or tool output the prompt trims) is half of it.
	const readTokens = units.reduce((sum, unit) => sum + unit.tokens, 0);
	const askedPartTokens = Math.max(200, options.maxPartTokens ?? 0);
	const partContentTokens = options.maxPartTokens ? Math.min(capContentTokens, askedPartTokens < readTokens ? askedPartTokens : Math.ceil(readTokens / 2)) : capContentTokens;
	const margin = Math.floor(budget * REMEMBER_MARGIN_SHARE);
	// The verbatim end is never larger than a part: otherwise a conversation
	// just over a part would fit the end whole and leave no part to read.
	// A final call the provider counted too long is planned again with a smaller end.
	const tailCap = Math.min(Math.floor(budget * REMEMBER_TAIL_SHARE), partContentTokens, options.maxTailTokens ?? Number.POSITIVE_INFINITY);
	let tailBudget = tailCap;
	for (let round = 0; round < 8; round++) {
		const tailStart = pickTail(units, Math.max(0, tailBudget));
		const parts = packParts(units.slice(0, tailStart), partContentTokens);
		const left = budget - finalOverhead - margin - parts.length * (REMEMBER_PART_NOTE_CEILING_TOKENS + noteFrame);
		if (left < 0 || parts.length === 0) throw new RememberTooLargeError(rememberWindowTooSmallMessage(context.model));
		const allowed = Math.min(tailCap, left);
		const tailUnits = units.slice(tailStart);
		const tailTokens = tailUnits.reduce((sum, unit) => sum + unit.tokens, 0);
		if (tailTokens <= allowed) {
			const tail: RememberStretch = { items: tailUnits.flatMap((unit) => unit.items), firstIndex: tailUnits[0]?.firstIndex ?? items.length };
			return { parts, tail, readCount: parts.length + (tail.items.length > 0 ? 1 : 0), budget, partContentTokens, tailTokens };
		}
		tailBudget = allowed;
	}
	throw new RememberTooLargeError(rememberWindowTooSmallMessage(context.model));
}

// --- Reading the notes back ----------------------------------------------------

/** The must-keep items one part's notes hold: the bullets under MUST-KEEP, None counting as none. */
export function countPartNoteMustKeeps(note: string): number {
	const match = /^\s*MUST-KEEP\s*:\s*$([\s\S]*?)(?=^\s*[A-Z][A-Z ]+:\s*$|(?![\s\S]))/m.exec(note);
	if (!match) return 0;
	return match[1]!.split(/\r?\n/).filter((line) => /^\s*[-*•]\s+\S/.test(line) && !/^\s*[-*•]\s+none\.?\s*$/i.test(line)).length;
}

/** The must-keep markers the entry's BODY carries. */
export function countBodyMustKeeps(body: string): number {
	return (body.match(/must-keep/gi) ?? []).length;
}

/** Telemetry for a two-stage read, in the single pass's shape, measured on the final prompt. */
export function rememberPartsTelemetry(input: { l1b: string; prompt: string; tailTranscript: string; targetTokens: { min?: number; max: number }; budget: number; elidedItemCount: number }): CheckpointCompressionPromptTelemetry {
	const memoryMetrics = checkpointCompressionMemoryMetrics(input.l1b);
	return {
		...memoryMetrics,
		transcriptChars: input.tailTranscript.length,
		promptChars: input.prompt.length,
		promptEstimatedTokens: estimateTokens(input.prompt),
		shortSessionMode: "none",
		effectiveTargetTokens: input.targetTokens,
		promptTokenBudget: input.budget,
		elidedItemCount: input.elidedItemCount,
		elidedChars: 0,
	};
}

// --- The page built by code ------------------------------------------------------

/** The person's own day, YYYY-MM-DD, not the UTC one: half past midnight is already the next day. */
export function rememberLocalDay(now = new Date()): string {
	const pad = (value: number) => String(value).padStart(2, "0");
	return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/** The last resort for a title: the day. */
export function rememberDatedTitle(now = new Date()): string {
	return `Conversation of ${rememberLocalDay(now)}`;
}

/** Words a title does not end on when it can end two words earlier at most. */
const TITLE_LINKING_WORDS = new Set(["a", "an", "and", "as", "at", "but", "by", "for", "from", "in", "into", "of", "on", "or", "the", "to", "with", "aber", "als", "auf", "bei", "das", "dem", "den", "der", "des", "die", "ein", "eine", "einen", "einer", "für", "im", "mit", "oder", "und", "von", "zu", "zum", "zur"]);
const TITLE_TRAILING_PUNCTUATION = /[\s.,;:!?\u2026"'()\-\u2013\u2014]+$/u;

/**
 * A title from a line of the conversation's own words: its first eight to ten
 * words, cut at a word, with no trailing punctuation. Ten, or fewer when a
 * sentence ends at the eighth or ninth word, or when the tenth (or ninth) is a
 * word that only links to the next. A short line is taken whole, so an
 * abbreviation never ends it. Empty when the line holds no words.
 */
export function rememberTitleFromWords(text: string): string {
	const plain = text.replace(/^\s*[-*•]\s+/gm, "").replace(/\*\*/g, "").replace(/\s+/g, " ").trim();
	const words = plain.split(" ").filter(Boolean);
	let end = Math.min(words.length, 10);
	for (let at = 7; at < end - 1; at += 1) {
		if (/[.!?]["'\u201d)]*$/.test(words[at]!)) {
			end = at + 1;
			break;
		}
	}
	while (end > 8 && TITLE_LINKING_WORDS.has(words[end - 1]!.toLowerCase().replace(TITLE_TRAILING_PUNCTUATION, ""))) end -= 1;
	return words.slice(0, end).join(" ").replace(TITLE_TRAILING_PUNCTUATION, "").trim();
}

/** A topic title from a note's own words, the way a new title is asked of the model: at most four words, never ending on a linking word. */
export function topicTitleFromWords(text: string): string {
	const words = text.replace(/^\s*[-*•]\s+/gm, "").replace(/\*\*/g, "").replace(/\s+/g, " ").trim().split(" ").filter(Boolean).slice(0, 4);
	while (words.length > 1 && TITLE_LINKING_WORDS.has(words.at(-1)!.toLowerCase().replace(TITLE_TRAILING_PUNCTUATION, ""))) words.pop();
	return words.join(" ").replace(TITLE_TRAILING_PUNCTUATION, "").trim();
}

/**
 * The page when the final call cannot be had (refused twice, too long, or
 * answered with no BODY): no call, only the notes. TITLE is the first words of
 * the notes' first arc (else of their first point), SESSION_ARC the notes'
 * arcs (else the first point), BODY every point the notes hold under any
 * heading but the arc and the open ones (the arcs when there is none), PARKED
 * the open threads. Only when the notes hold nothing at all (every part
 * refused) is the page the day alone. The caller fits it to 8,000 characters.
 */
export function buildRememberPageFromNotes(notes: string[], now = new Date()): { title: string; sessionArc: string; body: string; parked: string } {
	const parts: string[][] = [];
	const open: string[] = [];
	const arcs: string[] = [];
	let firstPoint = "";
	// What was in progress at a part's end, the next part carried on: only the
	// last part read still has it open, and in a part read in halves, the second half's.
	const lastRead = notes.reduce((last, note, index) => (note.trim() ? index : last), -1);
	notes.forEach((note, index) => {
		const first: string[] = [];
		const rest: string[] = [];
		let atEnd: string[] = [];
		let heading = "";
		for (const raw of note.split(/\r?\n/)) {
			const label = /^([A-Z][A-Z _-]+):\s*(.*)$/.exec(raw.trim());
			if (label) heading = label[1]!;
			if (label && /OPEN AT THE END/.test(heading)) atEnd = [];
			const line = label ? label[2]!.trim() : raw.trim();
			if (!line || /^none\.?$/i.test(line)) continue;
			const point = /^[-*•]\s+/.test(line) ? line : `- ${line}`;
			if (heading === "ARC") arcs.push(line);
			else if (/OPEN AT THE END/.test(heading)) atEnd.push(point);
			else if (/OPEN/.test(heading)) open.push(point);
			else {
				firstPoint ||= point.replace(/^[-*•]\s+/, "");
				(/MUST|DECISION|CORRECTION/.test(heading) ? first : rest).push(point);
			}
		}
		if (index === lastRead) open.push(...atEnd);
		parts.push([...first, ...rest]);
	});
	const parked = open.length ? open.join("\n") : "None.";
	// Every part refused (decision 40): the day alone, as title, arc and the one
	// point. No app-written sentence, and none of the refused words, which would
	// otherwise ride along on every later turn of the room. Search keeps them.
	if (!arcs.length && !firstPoint) {
		const title = rememberDatedTitle(now);
		return { title, sessionArc: title, body: `- ${title}`, parked };
	}
	const sessionArc = arcs.length ? arcs.join(" ") : firstPoint;
	// Each part takes a line in turn, its decisions first, so a page too long
	// for all of them keeps the conversation's end as well as its start.
	const room = CHECKPOINT_PAGE_MAX_CHARS - Math.min(sessionArc.length, 2_000) - Math.min(parked.length, 2_000) - 400;
	const kept = parts.map((): string[] => []);
	let used = 0;
	for (let line = 0; parts.some((points) => line < points.length); line++) {
		parts.forEach((points, part) => {
			const point = points[line];
			if (point === undefined || used + point.length + 2 > room) return;
			kept[part]!.push(point);
			used += point.length + 2;
		});
	}
	const body = kept.filter((points) => points.length).map((points) => points.join("\n")).join("\n\n");
	return {
		title: rememberTitleFromWords(arcs[0] ?? firstPoint) || rememberTitleFromWords(firstPoint) || rememberDatedTitle(now),
		sessionArc,
		body: body || arcs.map((arc) => `- ${arc}`).join("\n"),
		parked,
	};
}

/** Words compared as the person would read them: one case, straight quotes, single spaces. */
function comparable(text: string): string {
	return text.toLowerCase().replace(/[\u2018\u2019]/g, "'").replace(/[\u201c\u201d]/g, "\"").replace(/\s+/g, " ");
}

/** A line as a whole, for comparing: no bullet, no must-keep mark, no closing punctuation. */
function comparableLine(text: string): string {
	return comparable(text.replace(/^\s*[-*•]\s+/, "").replace(/\*\*must-keep\*\*\s*/gi, "").trim()).replace(/[\s.,;:!?]+$/, "");
}

/** A content this long is held wherever BODY has it whole; a shorter one only as a line of its own. */
const KEEP_CONTENT_MIN_WORDS = 4;

/**
 * The keep-requests the notes quote (`- "<request word for word>": <content>`)
 * that the entry's BODY does not hold, as their note lines, each once. BODY
 * holds one when it has the request's own words, or the whole content: as a
 * line of its own, or inside a line when the content has a few words. A word
 * of the content somewhere else does not.
 */
export function missingKeepRequests(notes: string[], body: string): string[] {
	const held = comparable(body);
	const lines = new Set(body.split(/\r?\n/).map(comparableLine).filter(Boolean));
	const missing: string[] = [];
	const seen = new Set<string>();
	for (const note of notes) {
		for (const raw of note.split(/\r?\n/)) {
			const match = /^\s*[-*•]\s+["\u201c](.+?)["\u201d]\s*:\s*(\S.*)$/.exec(raw);
			if (!match) continue;
			const request = comparable(match[1]!.trim());
			const content = comparableLine(match[2]!);
			const contentHeld = lines.has(content) || (content.split(" ").length >= KEEP_CONTENT_MIN_WORDS && held.includes(content));
			if (!request || seen.has(request) || held.includes(request) || contentHeld) continue;
			seen.add(request);
			missing.push(raw.trim().replace(/^[*•]\s+/, "- ").replace(/<!--|-->/g, ""));
		}
	}
	return missing;
}

// --- The short memory view -------------------------------------------------------

/**
 * The room's memory as an outline: topic titles with their note counts, the
 * open items one line each (at most 40), and the Recent Context titles. The final call reads the
 * memory only to compress against it, so when the whole memory and the notes
 * do not fit the window together, the outline keeps the page correct; it can
 * at most repeat a fact the memory already holds.
 */
const SHORT_VIEW_LINE_CHARS = 120;
const SHORT_VIEW_MAX_ITEMS = 40;

export function rememberShortMemoryView(l1b: string): string {
	const doc = parseMemoryDocument(l1b);
	const lines = ["This room's memory is too large to show whole next to this conversation, so here is its outline. Do not repeat what these titles already cover; when unsure, keep the point."];
	const topics = doc.topics.filter((topic) => topic.section === "Deep Memory" && topic.entries.length > 0);
	if (topics.length) lines.push("", "Topics in memory:", ...topics.map((topic) => `- ${topic.title} (${topic.entries.length} note${topic.entries.length === 1 ? "" : "s"})`));
	const open = doc.topics.filter((topic) => topic.section === "Active Items").flatMap((topic) => topic.entries).filter((entry) => entry.status !== "done");
	const line = (text: string) => {
		const plain = text.replace(/^\s*[-*•]\s+/, "").replace(/\s+/g, " ").trim();
		return plain.length > SHORT_VIEW_LINE_CHARS ? `${plain.slice(0, SHORT_VIEW_LINE_CHARS - 3).trimEnd()}...` : plain;
	};
	if (open.length) {
		lines.push("", "Open items:", ...open.slice(0, SHORT_VIEW_MAX_ITEMS).map((entry) => `- ${line(entry.text)}`));
		if (open.length > SHORT_VIEW_MAX_ITEMS) lines.push(`- and ${open.length - SHORT_VIEW_MAX_ITEMS} more open items`);
	}
	const pages = [...doc.recentContext.matchAll(/^###\s+RC-[^|\n]*\|[^|\n]*\|[^|\n]*\|\s*(.+)$/gm)].map((match) => match[1]!.trim());
	if (pages.length) lines.push("", "Recent conversations:", ...pages.map((title) => `- ${line(title)}`));
	return lines.join("\n");
}
