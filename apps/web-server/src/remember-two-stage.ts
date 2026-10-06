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
//   ended. At most three parts are read at once; a failed part is read once
//   more, then the whole Remember fails and nothing is written.
//
//   Stage B: one call with the constitution, the room's memory, every part's
//   notes in order, and the end of the conversation verbatim (up to 30 percent
//   of the budget, less when the notes need the room). It writes the same four
//   fields the single pass writes.
//
// Each fact is compressed at most twice, the arc and the corrections are judged
// with the whole conversation in view, and the end state (the decisions, the
// parked threads) is never summarized before the final call reads it.
//
// This module only plans and renders; the caller runs the calls.

import {
	baseDensityTarget,
	CHECKPOINT_COMPRESSION_WORKER_TYPE,
	CHECKPOINT_PROMPT_TOOL_RESULT_TEXT_CAP,
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

/**
 * The quality cap on how much transcript one read (the single pass or one
 * part) may hold. Until the long-session evaluation sets it, it equals the
 * budget, so it changes nothing; the evaluation sets it through the
 * environment to measure where recall starts to drop.
 */
export function rememberPartCapTokens(budget: number): number {
	const raw = Number(process.env.EXXPERTS_REMEMBER_PART_CAP_TOKENS);
	return Number.isFinite(raw) && raw > 0 ? Math.min(budget, Math.floor(raw)) : budget;
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
export function rememberWindowTooSmallMessage(model: { provider: string; model: string; label?: string }, contextWindow: number | undefined): string {
	const window = contextWindow ? ` (a window of ${contextWindow.toLocaleString("en-US")} tokens)` : "";
	return `This conversation is too long for ${modelName(model)}${window} to remember next to this room's memory, even read in parts. Choose a memory model with a larger window in Room settings, Model, then generate again. No memory has been written.`;
}

/** The sentence when every part was read but their notes came out too long for the final call. */
export function rememberNotesTooLongMessage(model: { provider: string; model: string; label?: string }, contextWindow: number | undefined, partCount: number): string {
	const window = contextWindow ? ` (a window of ${contextWindow.toLocaleString("en-US")} tokens)` : "";
	return `All ${partCount} parts of this conversation were read, but their notes came out too long for ${modelName(model)}${window} to read next to this room's memory. Generate again, or choose a memory model with a larger window in Room settings, Model. No memory has been written.`;
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

/** Stage A: one part of the conversation, read for notes. */
export function buildRememberPartPrompt(context: RememberPromptContext, part: RememberStretch, partNumber: number, partCount: number): string {
	const transcript = renderCheckpointTranscriptStretch(part.items, part.firstIndex).transcript;
	return [
		`# exxperts Remember: reading one part of a long conversation

You are a platform-owned worker inside exxperts. The conversation below was too long to read in one pass, so it is read in parts, in order; you read part ${partNumber} of ${partCount}. A later step reads the notes on every part together with the room's memory and writes the memory entry. You write notes, not the entry. You are not the room, you do not address the user, and nothing you write is saved as it is.

## What to note, in this order

1. **Must-keep.** Every place where the user asked to remember, keep or not forget something, in any phrasing and any language. Quote the request word for word and carry the content it points at in full: names, numbers, dates and commitments exactly as said. Content the operator steering below names is must-keep too.
2. **Decisions and corrections.** What was decided, adopted, reversed or corrected. For a correction, give the old position and the new one.
3. **What was produced.** Documents, plans, code, designs and other deliverables, and where a finding came from (the file, the tool, the source).
4. **Open threads.** What was left unresolved, and why.
5. **The arc.** Where this part started and where it ended, in two lines.

Shed greetings, dead ends that taught nothing, mechanical steps and restated tool output. Invent nothing, and note nothing that is not in this part.

## Output

Return exactly these labelled sections, in this order, and nothing else. Write None under a section with nothing in it. Stay under about ${REMEMBER_PART_NOTE_CEILING_TOKENS} tokens; must-keep content is never shortened to get there.

MUST-KEEP:
- "<the request, word for word>": <the content it points at, exact>

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
export function buildRememberFinalPrompt(context: RememberPromptContext, input: { notes: string[]; parts: RememberStretch[]; tail: RememberStretch; readCount: number }): { prompt: string; targetTokens: { min?: number; max: number }; tailTranscript: string; tailElidedItemCount: number } {
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
		`## Material: Notes on the Earlier Parts of the Conversation\n\nThe conversation was too long to read in one pass. A reader went through its earlier parts in order and wrote the notes below. Treat them as the transcript of those parts: a MUST-KEEP item in them is must-keep for this entry, a correction in them replaced the earlier position, and an open thread in them stays open unless the end of the conversation closed it.\n\n${notes.join("\n\n")}`,
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
export function planRememberParts(context: RememberPromptContext, items: CheckpointCompressionTranscriptItem[], budget: number, contextWindow?: number): RememberPartsPlan {
	const units = unitsOf(items);
	const emptyStretch: RememberStretch = { items: [], firstIndex: 0 };
	const finalOverhead = estimateTokens(buildRememberFinalPrompt(context, { notes: [], parts: [], tail: emptyStretch, readCount: 2 }).prompt);
	const noteFrame = 40;
	const partOverhead = estimateTokens(buildRememberPartPrompt(context, emptyStretch, 1, 1)) + REMEMBER_PART_NOTE_CEILING_TOKENS;
	const partContentTokens = rememberPartCapTokens(budget) - partOverhead;
	if (partContentTokens < 1_000) throw new RememberTooLargeError(rememberWindowTooSmallMessage(context.model, contextWindow));
	const margin = Math.floor(budget * REMEMBER_MARGIN_SHARE);
	let tailBudget = Math.floor(budget * REMEMBER_TAIL_SHARE);
	for (let round = 0; round < 8; round++) {
		const tailStart = pickTail(units, Math.max(0, tailBudget));
		const parts = packParts(units.slice(0, tailStart), partContentTokens);
		const left = budget - finalOverhead - margin - parts.length * (REMEMBER_PART_NOTE_CEILING_TOKENS + noteFrame);
		if (left < 0 || parts.length === 0) throw new RememberTooLargeError(rememberWindowTooSmallMessage(context.model, contextWindow));
		const allowed = Math.min(Math.floor(budget * REMEMBER_TAIL_SHARE), left);
		const tailUnits = units.slice(tailStart);
		const tailTokens = tailUnits.reduce((sum, unit) => sum + unit.tokens, 0);
		if (tailTokens <= allowed) {
			const tail: RememberStretch = { items: tailUnits.flatMap((unit) => unit.items), firstIndex: tailUnits[0]?.firstIndex ?? items.length };
			return { parts, tail, readCount: parts.length + (tail.items.length > 0 ? 1 : 0), budget, partContentTokens, tailTokens };
		}
		tailBudget = allowed;
	}
	throw new RememberTooLargeError(rememberWindowTooSmallMessage(context.model, contextWindow));
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
		reductionStage: "standard",
		elidedItemCount: input.elidedItemCount,
		elidedChars: 0,
	};
}

/** How many tool outputs the reads shortened, in the plain words the approval screen uses (the CLI's proposal detail). */
export function toolOutputTrimSentence(count: number, capChars: number = CHECKPOINT_PROMPT_TOOL_RESULT_TEXT_CAP): string | null {
	if (count <= 0) return null;
	return `${count === 1 ? "One tool output" : `${count} tool outputs`} over ${capChars.toLocaleString("en-US")} characters ${count === 1 ? "was" : "were"} shortened before reading.`;
}
