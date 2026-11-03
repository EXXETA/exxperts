/**
 * Where a paced reveal may stop, and what each character costs.
 *
 * The reveal shows whole words: a cut lands after a space, between two words
 * of a language written without spaces (found with Intl.Segmenter), or, inside
 * a run longer than LONG_WORD (an address, a long code token), between two
 * graphemes, so it never splits an emoji or an accented letter. An emoji the
 * received text ends on waits for what comes next, which may join it (a
 * family, a skin tone, a flag's second half). A line-start
 * marker (`- `, `## `, `1. `, `> `, a table's first pipe, a fence line) always
 * goes with the word after it, so an empty bullet or heading never shows.
 *
 * The budget counts visible characters: Markdown marks, a link's address
 * outside inline code, a table's dash row and a fence line cost nothing, so
 * an answer full of links or a table does not stall while invisible text
 * "types".
 *
 * Pure, no DOM: the reducer smoke runs it in plain node.
 */

/** A run without spaces longer than this is cut between graphemes. */
export const LONG_WORD = 20;

const SPACE = /\s/;
// Scripts written without spaces between words.
const UNSPACED = /[฀-๿຀-໿က-႟ក-៿぀-ヿ㐀-䶿一-鿿豈-﫿]/u;
const LINE_MARKER_ONLY = /(?:^|\n)[ \t]*(?:>[ \t]*)*(?:#{1,6}|[-*+]|\d{1,9}[.)]|>|\|)?[ \t]*$/;
const FENCE_LINE = /^[ \t]{0,3}(?:`{3,}|~{3,})/;
const FENCE_LINE_ONLY = /(?:^|\n)[ \t]{0,3}(?:`{2,}|~{2,})[^\n]*\n?$/;
const TABLE_RULE_LINE = /^[ \t]*\|?[ \t]*:?-[-:| \t]*$/;
const PARTIAL_TABLE_RULE = /^[ \t]*\|[-:| \t]*$/;
const MARK = new Set(["*", "`", "~", "|"]);
const EMOJI = /[\p{Extended_Pictographic}\p{Regional_Indicator}]/u;

type Segmenter = { segment(text: string): Iterable<{ segment: string; index: number }> };
let wordSegmenter: Segmenter | null | undefined;
let graphemeSegmenter: Segmenter | null | undefined;
function segmenter(granularity: "word" | "grapheme"): Segmenter | null {
	const make = () => {
		try {
			const Ctor = (Intl as unknown as { Segmenter?: new (locale?: string, options?: { granularity: string }) => Segmenter }).Segmenter;
			return Ctor ? new Ctor(undefined, { granularity }) : null;
		} catch {
			return null;
		}
	};
	if (granularity === "word") return wordSegmenter === undefined ? (wordSegmenter = make()) : wordSegmenter;
	return graphemeSegmenter === undefined ? (graphemeSegmenter = make()) : graphemeSegmenter;
}

/**
 * What the lines so far leave open where the next line starts: a fenced code
 * block, and the backtick run of an inline code span (0: none). A code span
 * may go on over a line break, not over a blank line or a fence.
 */
export interface OpenAtLine {
	fence: boolean;
	codeTicks: number;
}

export const NOTHING_OPEN: OpenAtLine = { fence: false, codeTicks: 0 };

/**
 * Reads the line from `lineStart` to `lineEnd` of `text`, moving `open` past
 * it, and when `costs` is given, writes each character's cost there: 0 for
 * what the reader never sees.
 */
function readLine(text: string, lineStart: number, lineEnd: number, open: OpenAtLine, costs?: Uint8Array): void {
	const line = text.slice(lineStart, lineEnd);
	if (!line.trim()) open.codeTicks = 0;
	if (FENCE_LINE.test(line) || (!open.fence && lineEnd === text.length && /^[ \t]{0,3}(?:`{1,2}|~{1,2})$/.test(line))) {
		costs?.fill(0, lineStart, lineEnd + 1);
		if (FENCE_LINE.test(line) && lineEnd < text.length) {
			open.fence = !open.fence;
			open.codeTicks = 0;
		}
	} else if (open.fence) {
		// Code shows every character as written.
	} else if (TABLE_RULE_LINE.test(line) && line.includes("-") || PARTIAL_TABLE_RULE.test(line)) {
		costs?.fill(0, lineStart, lineEnd + 1);
	} else {
		const marker = /^[ \t]*(?:>[ \t]*)*(?:#{1,6}[ \t]|[-*+][ \t]|\d{1,9}[.)][ \t])?/.exec(line)?.[0].length ?? 0;
		costs?.fill(0, lineStart, lineStart + marker);
		let address = -1;
		// Inside inline code every character shows, a link's address too.
		for (let i = lineStart + marker; i < lineEnd; i++) {
			const c = text[i];
			if (address >= 0) {
				if (costs) costs[i] = 0;
				if (c === ")") address = -1;
			} else if (c === "\\" && open.codeTicks === 0) {
				// Outside code a backslash makes the next character plain: an escaped backtick opens no code.
				i += 1;
			} else if (c === "`") {
				let run = 1;
				while (text[i + run] === "`") run++;
				if (open.codeTicks === 0 || run === open.codeTicks) {
					open.codeTicks = open.codeTicks === 0 ? run : 0;
					costs?.fill(0, i, i + run);
				}
				i += run - 1;
			} else if (open.codeTicks > 0) {
				// Code shows every character as written.
			} else if (c === "]" && text[i + 1] === "(") {
				if (costs) costs[i] = 0;
				address = i;
			} else if (costs && (MARK.has(c) || c === "[")) costs[i] = 0;
		}
	}
}

/**
 * What the whole lines of `text` from `from` leave open, starting from
 * `open`. The reducer keeps the result per revealed prefix, so each tick
 * reads only the lines it added.
 */
export function openAfterLines(text: string, from: number, open: OpenAtLine): { open: OpenAtLine; scannedTo: number } {
	const next = { ...open };
	let at = from;
	for (;;) {
		const end = text.indexOf("\n", at);
		if (end < 0) return { open: next, scannedTo: at };
		readLine(text, at, end, next);
		at = end + 1;
	}
}

/**
 * The cost of each character of `ahead`, 0 for what the reader never sees.
 * `lineHead` is the already-shown start of the line `ahead` continues, and
 * `open` what is open where that line starts.
 */
export function visibleCosts(lineHead: string, open: OpenAtLine, ahead: string): Uint8Array {
	const text = lineHead + ahead;
	const costs = new Uint8Array(text.length).fill(1);
	const state = { ...open };
	let lineStart = 0;
	while (lineStart <= text.length) {
		let lineEnd = text.indexOf("\n", lineStart);
		if (lineEnd < 0) lineEnd = text.length;
		readLine(text, lineStart, lineEnd, state, costs);
		costs[lineEnd] = 0;
		lineStart = lineEnd + 1;
	}
	return costs.subarray(lineHead.length, lineHead.length + ahead.length);
}

/** Whether `text` ends on an emoji that what comes next may still join. */
function endsOnEmoji(text: string): boolean {
	if (/[\u200d\ufe0f\ud800-\udbff]$/.test(text)) return true;
	const graphemes = segmenter("grapheme");
	let last = text.slice(-2);
	if (graphemes) for (const s of graphemes.segment(text.slice(-32))) last = s.segment;
	return EMOJI.test(last);
}

export interface CutInput {
	/** Everything already on screen. */
	shown: string;
	/** Received, not yet shown. */
	waiting: string;
	/** Visible characters this step may show (fractional). */
	budget: number;
	/** The whole answer has arrived, so the last word is complete. */
	complete: boolean;
	/** The last, possibly unfinished word has waited long enough to show anyway. */
	releaseLastWord: boolean;
	/** What `shown` leaves open where its last line starts. */
	open: OpenAtLine;
}

export interface Cut {
	/** Characters of `waiting` to show now (0: none yet). */
	chars: number;
	/** Visible characters those cost. */
	cost: number;
	/** The cut held back a last word that is still being written. */
	heldLastWord: boolean;
}

function markerOnlyBefore(shown: string, waiting: string, at: number): boolean {
	const tail = at >= 240 ? waiting.slice(at - 240, at) : shown.slice(-(240 - at)) + waiting.slice(0, at);
	return LINE_MARKER_ONLY.test(tail) || FENCE_LINE_ONLY.test(tail);
}

/** The furthest whole-word cut whose visible cost fits the budget. */
export function cutWords(input: CutInput): Cut {
	const { shown, waiting, budget, complete, releaseLastWord } = input;
	if (!waiting) return { chars: 0, cost: 0, heldLastWord: false };
	// Invisible text is free, so look further than the budget alone would reach.
	const windowEnd = Math.min(waiting.length, Math.ceil(budget) * 4 + 400);
	const ahead = waiting.slice(0, windowEnd);
	const lineHead = shown.slice(shown.lastIndexOf("\n") + 1);
	const costs = visibleCosts(lineHead, input.open, ahead);
	const unspaced = UNSPACED.test(ahead);
	const wordEnds = unspaced ? new Set<number>() : null;
	if (wordEnds) {
		const words = segmenter("word");
		if (words) for (const s of words.segment(ahead)) wordEnds.add(s.index + s.segment.length);
	}
	let best = { chars: 0, cost: 0 };
	let cost = 0;
	let runStart = /\S$/.test(shown) ? -1 : 0;
	if (runStart < 0) {
		// The shown text ends inside a run (a long word cut by graphemes): the run started before `waiting`.
		const m = /\S+$/.exec(shown);
		runStart = -(m ? m[0].length : 0);
	}
	let heldLastWord = false;
	for (let i = 1; i <= ahead.length; i++) {
		cost += costs[i - 1];
		if (cost > budget) break;
		const prev = ahead[i - 1];
		const next = ahead[i];
		if (SPACE.test(prev)) runStart = i;
		const atEnd = i === waiting.length;
		let cut = false;
		if (atEnd) {
			cut = complete || SPACE.test(prev) || (releaseLastWord && !endsOnEmoji(waiting));
			if (!cut) heldLastWord = true;
		} else if (SPACE.test(prev)) cut = true;
		else if (next !== undefined && SPACE.test(next)) cut = true;
		else if (wordEnds?.has(i) && UNSPACED.test(prev + next)) cut = true;
		else if (i - runStart > LONG_WORD) cut = true;
		if (cut && !atEnd && markerOnlyBefore(shown, waiting, i)) cut = false;
		if (cut) best = { chars: i, cost };
	}
	if (best.chars > 0 && best.chars < waiting.length && !/\s/.test(waiting[best.chars - 1]) && !/\s/.test(waiting[best.chars] ?? " ")) {
		// A cut inside a run: move it back to a grapheme boundary.
		const graphemes = segmenter("grapheme");
		if (graphemes) {
			const from = Math.max(0, best.chars - 16);
			let edge = from;
			for (const s of graphemes.segment(waiting.slice(from, best.chars + 16))) {
				const end = from + s.index + s.segment.length;
				if (end > best.chars) break;
				edge = end;
			}
			if (edge < best.chars) {
				let c = 0;
				for (let i = 0; i < edge; i++) c += costs[i] ?? 1;
				best = { chars: edge, cost: c };
			}
		} else if (/[\ud800-\udbff]/.test(waiting[best.chars - 1])) best = { chars: best.chars - 1, cost: Math.max(0, best.cost - 1) };
	}
	return { ...best, heldLastWord: heldLastWord && best.chars < waiting.length };
}
