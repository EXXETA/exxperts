import { DISPLAY_MATHS_LINE } from "./maths-syntax";

/**
 * Repairs the last block of an answer while it is still being written, so a
 * half-written mark already looks the way it will once finished: `**Summary
 * firs` shows bold, `` `npm ru `` shows as code, `[the docs](https://exa`
 * shows as the words "the docs", and a lone `#` or `-` waits for its first
 * word instead of drawing an empty heading or bullet.
 *
 * Pure. The renderer calls it only for the last block of an answer that is
 * still streaming, and only to draw it: the result is never stored, saved or
 * copied. A repair that guesses wrong lasts only until the block moves on.
 *
 * Our own rules rather than a package's: a single tilde is a Windows short
 * name (PROGRA~1), never strikethrough, and a backslash escapes a mark only
 * where the renderer itself reads it as an escape (the `backslash` option), so
 * nothing here inserts a backslash. Underscores are never closed: snake_case
 * and __init__.py are far more common in answers than _emphasis_.
 *
 * Rules, each anchored at the end of the text:
 * - an open code fence: only its closing line being typed (1 or 2 of its
 *   characters) is dropped, so it never shows as a line of code;
 * - a table shows once its header and separator lines are complete, so its
 *   header is never a line of pipes; its rows then show as they are written;
 *   a line whose cells are padded both ways ("|x| is the size") is prose;
 * - a last line holding only a list, heading or quote marker, or only `-`,
 *   `*`, `_` or `=` (a rule or a heading underline being typed) is dropped;
 * - a link whose address is open shows its words; an image waits for its `)`;
 * - a known HTML tag still being typed is dropped;
 * - a web address still being typed at the very end is not made a link yet;
 * - an open code span is closed, then open `**`, `*` and `~~` in reverse
 *   order; `**x*` gets its last `*`; a formula's insides are not marks;
 * - an inline formula whose closer has not arrived (`\(`, `$$`, or `\[`
 *   starting the last line) holds the rest of its line back; a single
 *   dollar never does, as it may be a price; and a display formula
 *   still open is left as it is: the maths keeps its last good picture.
 *
 * Code is never repaired: no rule acts inside a code block or a code span the
 * parser found (the `code` rule), and an escaped mark opens nothing.
 */

/** The renderer's own reading of the text, so a repair agrees with how the text is parsed. */
export interface RepairRules {
	/**
	 * The renderer's own backslash rule for this text: shown as written
	 * (true or false) or an escape (undefined), by offset.
	 */
	backslash?: (text: string) => (at: number) => boolean | undefined;
	/** The renderer's own maths rule for this text: the length of the formula starting at an offset (0: none). */
	formula?: (text: string) => (at: number) => number;
	/** Where an inline formula on the text's last line starts whose closer has not arrived, or -1; `code` is where the text holds code. */
	arrivingFormula?: (text: string, code: CodeRange[]) => number;
	/** Where the parser finds code in this text, in order: blocks and spans, delimiters included. */
	code?: (text: string) => CodeRange[];
}

/** A piece of code as [start, end) offsets: a block (fenced or indented) or a span. */
export interface CodeRange {
	start: number;
	end: number;
	block: boolean;
}

/** The text being repaired and where its code sits, kept in step as the text is cut or changed. */
interface Draft {
	text: string;
	code: CodeRange[];
}

/**
 * The draft with `removed` characters at `at` replaced by `inserted`: the
 * one way any repair changes the text. It refuses (returns the draft as it
 * was) when the change would cut into code or insert into it, or remove a
 * code block. An insert at a code block's edge lands on its line, and a
 * backtick at a span's edge joins its delimiter run: both are inserts into
 * code. A whole span may go with the line it sits on, such as a table header
 * held back.
 */
function edit(draft: Draft, at: number, removed: number, inserted = ""): Draft {
	const end = at + removed;
	const joins = (range: CodeRange) => range.block || (at === range.end ? inserted[0] : inserted.at(-1)) === "`";
	const touches = (range: CodeRange) => (removed ? range.start < end && range.end > at && (range.block || range.start < at || range.end > end) : (range.start < at && at < range.end) || ((at === range.start || at === range.end) && joins(range)));
	if (draft.code.some(touches)) return draft;
	const by = inserted.length - removed;
	return {
		text: draft.text.slice(0, at) + inserted + draft.text.slice(end),
		code: draft.code.flatMap((range) => (range.end <= at ? [range] : range.start >= end ? [{ ...range, start: range.start + by, end: range.end + by }] : [])),
	};
}

/** Whether an offset is in the draft's code; its ranges are in order and never overlap. */
function inCode(draft: Draft, at: number): boolean {
	let low = 0;
	let high = draft.code.length;
	while (low < high) {
		const middle = (low + high) >> 1;
		if (draft.code[middle].end <= at) low = middle + 1;
		else high = middle;
	}
	return low < draft.code.length && draft.code[low].start <= at;
}

const FENCE = /^[ \t]*(`{3,}|~{3,})(.*)$/;
const LONE_MARKER = /^[ \t]*(?:>[ \t]*)*(?:#{1,6}|[-*+]|\d{1,9}[.)])?[ \t]*$/;
const RULE_BEING_TYPED = /^[ \t]*(?:>[ \t]*)*[-*_=][-*_= \t]*$/;
const BLOCK_START = /^[ \t]*(?:>|[-*+][ \t]|\d{1,9}[.)][ \t]|#{1,6}[ \t]|\|)/;
const TABLE_LINE = /^ {0,3}\|/;
const TABLE_BLOCK = /^(?: {0,3}\|[^\r\n]*(?:\r\n|\r|\n|$))+$/;
const DELIMITER_CHARACTERS = /^[| \t]*[-:][-:| \t]*[\r\n]*$/;
const DELIMITER_CELL = /^[ \t]*:?-+:?[ \t]*$/;
const DELIMITER_CELL_SO_FAR = /^[ \t]*(?::|:?-+:?[ \t]*)$/;
const OPEN_LINK = /(!?)\[([^[\]\n]*)\]\([^)\n]*$/;
const KNOWN_TAG = ["b", "strong", "i", "em", "kbd", "sup", "sub", "br", "a", "details", "summary", "div", "p", "span", "u", "small", "mark", "center"];
const TAG_BEING_TYPED = /<\/?([a-zA-Z]*)((?:\s[^<>\n]*)?)$/;
const ADDRESS_BEING_TYPED = /(^|[\s(*~])(?:https?:\/\/|www\.)[^\s<]*$/;
const SPACE = /\s/;
const PUNCTUATION = /[\p{P}\p{S}]/u;
const LETTER_OR_DIGIT = /[\p{L}\p{N}]/u;

export function repairTail(text: string, rules: RepairRules = {}): string {
	const fence = openFence(text);
	if (fence) return withoutPartialCloser(text, fence);
	if (inOpenDisplayFormula(text)) return text;
	// Code is read from the whole block before anything is cut, so no step changes it.
	let draft: Draft = { text, code: codeOf(text, rules) };
	draft = withoutLoneMarker(withHeldTableHeader(draft));
	const from = regionStart(draft.text);
	const open = () => openCodeSpan(draft, from, escapes(draft.text, rules));
	draft = withoutArrivingFormula(draft, open(), rules.arrivingFormula?.(draft.text, draft.code) ?? -1, from);
	draft = withOpenLinkAsWords(draft, open(), escapes(draft.text, rules));
	draft = withoutTagBeingTyped(draft, open(), escapes(draft.text, rules));
	draft = withAddressNotYetALink(draft, open());
	return withClosedMarks(draft, from, open(), rules.backslash?.(draft.text), rules.formula?.(draft.text));
}

/** Where the block holds code. A table's cells hold no code across its lines, so only its last row is parsed. */
function codeOf(text: string, rules: RepairRules): CodeRange[] {
	if (!rules.code) return [];
	const base = TABLE_BLOCK.test(text) ? Math.max(text.lastIndexOf("\r"), text.lastIndexOf("\n")) + 1 : 0;
	return rules.code(text.slice(base)).map((range) => ({ ...range, start: range.start + base, end: range.end + base }));
}

/**
 * Whether the character at an offset is escaped: an odd run of backslashes
 * stands before it, and the renderer reads the last one as an escape, not as
 * a path's separator shown as written.
 */
function escapes(text: string, rules: RepairRules): (at: number) => boolean {
	const backslash = rules.backslash?.(text);
	return (at) => {
		let run = 0;
		while (text[at - 1 - run] === "\\") run++;
		return run % 2 === 1 && (!backslash || backslash(at - 1) === undefined);
	};
}

/** Whether the text ends inside a `$$` or `\[` display formula, outside code fences. */
function inOpenDisplayFormula(text: string): boolean {
	let fence: string | null = null;
	let maths: string | null = null;
	for (const line of text.split("\n")) {
		const run = FENCE.exec(line)?.[1];
		if (!maths && run && (!fence || (run[0] === fence[0] && run.length >= fence.length))) {
			fence = fence ? null : run;
			continue;
		}
		if (fence) continue;
		const sequence = DISPLAY_MATHS_LINE.exec(line)?.[1];
		if (!sequence) continue;
		if (!maths) maths = sequence === "\\]" ? null : sequence;
		else if (maths === "\\[" ? sequence === "\\]" : sequence[0] === "$" && sequence.length >= maths.length) maths = null;
	}
	return maths !== null;
}

function withoutArrivingFormula(draft: Draft, code: OpenSpan | null, at: number, from: number): Draft {
	if (at < from || (code && code.at < at)) return draft;
	return edit(draft, at, draft.text.length - at);
}

/** The open fence the text ends in: its character and length. */
function openFence(text: string): { char: string; length: number } | null {
	let open: { char: string; length: number } | null = null;
	for (const line of text.split("\n")) {
		const match = FENCE.exec(line);
		if (!match) continue;
		const run = match[1];
		if (!open) {
			// A backtick fence's info string holds no backtick.
			if (run[0] === "`" && match[2].includes("`")) continue;
			open = { char: run[0], length: run.length };
		} else if (run[0] === open.char && run.length >= open.length && !match[2].trim()) open = null;
	}
	return open;
}

function withoutPartialCloser(text: string, fence: { char: string; length: number }): string {
	const lineStart = text.lastIndexOf("\n") + 1;
	const line = text.slice(lineStart).trim();
	return line && line.length < fence.length && [...line].every((c) => c === fence.char) ? text.slice(0, lineStart) : text;
}

/**
 * The text without the lines of a table whose header or separator line is
 * not complete yet. A header is a line with a pipe outside code, outer pipes
 * optional as in GFM, that is not a row of a table already under way: it
 * waits while it is the last line, or while the start of a delimiter row with
 * no more cells than it has is being typed under it.
 */
function withHeldTableHeader(draft: Draft): Draft {
	const text = draft.text;
	// Each line with its ending (LF, CR LF or a lone CR, as the parser reads them), so a table hides no more than its own lines.
	const lines = text.match(/[^\r\n]*(?:\r\n|\r|\n)|[^\r\n]+$/g) ?? [];
	let offset = 0;
	const starts = lines.map((line) => (offset += line.length) - line.length);
	const cells = (i: number) => rowCells(draft, starts[i], lines[i]);
	// A line of only dashes, colons and pipes is a delimiter row gone wrong, not a header.
	const headerLike = (i: number) => cells(i) > 0 && (TABLE_LINE.test(lines[i]) || !BLOCK_START.test(lines[i])) && !DELIMITER_CHARACTERS.test(lines[i]) && !mixedPadding(draft, starts[i], lines[i]);
	// A table is under way when a complete delimiter row stands under a header with as many cells above, with no
	// blank line or new list item, quote or heading since. That header may start a list item or be made of marks.
	const inTable = (i: number) => {
		for (let j = i - 1; j > 0 && lines[j].trim(); j--) {
			if (delimiterRow(lines[j], false) && cells(j) === cells(j - 1)) return true;
			if (BLOCK_START.test(lines[j]) && !TABLE_LINE.test(lines[j])) return false;
		}
		return false;
	};
	const header = (i: number) => i >= 0 && headerLike(i) && !inTable(i);
	const last = lines.length - 1;
	// Once the separator's line ends, the rows show as they are written; a second line that cannot become a separator is text.
	const separating = last > 0 && !/[\r\n]$/.test(text) && delimiterRow(lines[last], true) && cells(last) <= cells(last - 1) && header(last - 1);
	const first = separating ? last - 1 : header(last) ? last : -1;
	return first < 0 ? draft : edit(draft, starts[first], text.length - starts[first]);
}

/** Whether a line is a GFM delimiter row (`--- | :-:`), or, while it is being typed, the start of one. */
function delimiterRow(line: string, typing: boolean): boolean {
	// The last cell keeps its trailing blanks: a lone ":" followed by one can never become a cell.
	const cells = line.replace(/^[ \t]+|[\r\n]+$/g, "").replace(/^\|/, "").split("|");
	const last = cells.length - 1;
	// A closing pipe leaves an empty last cell; while typing, the last cell may be empty or half typed.
	return cells.every((cell, i) => (i < last ? DELIMITER_CELL.test(cell) : !cell.trim() ? typing || i > 0 : (typing ? DELIMITER_CELL_SO_FAR : DELIMITER_CELL).test(cell)));
}

/**
 * How many cells a line has as a table row, as GFM splits it (an escaped pipe
 * splits nothing, a pipe in code does), or 0 when no pipe stands outside code.
 */
function rowCells(draft: Draft, start: number, line: string): number {
	let pipes = 0;
	let outside = false;
	for (let i = 0; i < line.length; i++) {
		if (line[i] === "\\") i++;
		else if (line[i] === "|") {
			pipes++;
			outside ||= !inCode(draft, start + i);
		}
	}
	if (!outside) return 0;
	const row = line.trim();
	return pipes + 1 - (row.startsWith("|") ? 1 : 0) - (row.length > 1 && row.endsWith("|") && !row.endsWith("\\|") ? 1 : 0);
}

/**
 * Whether a line pads its cells both ways: a blank after some of its pipes
 * outside code and none after others ("|x| is the size"). A table row is
 * written "| a | b |" or "|a|b|"; a pipe ending the line pads nothing, and a
 * line that ends with one is a row, however unevenly padded ("| Name|Path |").
 */
function mixedPadding(draft: Draft, start: number, line: string): boolean {
	const row = line.trimEnd();
	if (row.endsWith("|") && !row.endsWith("\\|")) return false;
	let padded = false;
	let bare = false;
	for (let i = 0; i < line.length; i++) {
		if (line[i] === "\\") i++;
		else if (line[i] === "|" && !inCode(draft, start + i) && i + 1 < line.length && !/[\r\n]/.test(line[i + 1])) {
			if (/[ \t]/.test(line[i + 1])) padded = true;
			else bare = true;
		}
	}
	return padded && bare;
}

function withoutLoneMarker(draft: Draft): Draft {
	const lineStart = draft.text.lastIndexOf("\n") + 1;
	const line = draft.text.slice(lineStart);
	return line.trim() && (LONE_MARKER.test(line) || RULE_BEING_TYPED.test(line)) ? edit(draft, lineStart, line.length) : draft;
}

/** Where the paragraph, list item, heading, quote or table row being written starts. */
function regionStart(text: string): number {
	let end = text.length;
	for (;;) {
		const start = text.lastIndexOf("\n", end - 1) + 1;
		const line = text.slice(start, end);
		if (!line.trim() && end < text.length) return end + 1;
		if (start === 0 || BLOCK_START.test(line)) return start;
		end = start - 1;
	}
}

type OpenSpan = { at: number; length: number };

/** The offset and length of the code span left open at the end, if any: outside the parser's code, not escaped. */
function openCodeSpan(draft: Draft, from: number, escaped: (at: number) => boolean): OpenSpan | null {
	const text = draft.text;
	for (let i = text.indexOf("`", from); i >= 0; ) {
		const length = runLength(text, i, "`");
		if (inCode(draft, i) || escaped(i)) {
			i = text.indexOf("`", i + (escaped(i) ? 1 : length));
			continue;
		}
		const close = closingRun(text, i + length, length);
		if (close < 0) return { at: i, length };
		i = text.indexOf("`", close + length);
	}
	return null;
}

function runLength(text: string, at: number, char: string): number {
	let end = at;
	while (text[end] === char) end++;
	return end - at;
}

function closingRun(text: string, from: number, length: number): number {
	for (let i = text.indexOf("`", from); i >= 0; ) {
		const run = runLength(text, i, "`");
		if (run === length) return i;
		i = text.indexOf("`", i + run);
	}
	return -1;
}

function withOpenLinkAsWords(draft: Draft, code: OpenSpan | null, escaped: (at: number) => boolean): Draft {
	const match = OPEN_LINK.exec(draft.text);
	const at = match ? match.index + match[1].length : -1;
	if (!match || escaped(at) || (code && code.at < match.index)) return draft;
	// An escaped "!" is text, and the link after it shows its words like any other.
	if (match[1] && !escaped(match.index)) return edit(draft, match.index, draft.text.length - match.index);
	const wordsEnd = at + 1 + match[2].length;
	return edit(edit(draft, wordsEnd, draft.text.length - wordsEnd), at, 1);
}

function withoutTagBeingTyped(draft: Draft, code: OpenSpan | null, escaped: (at: number) => boolean): Draft {
	const match = TAG_BEING_TYPED.exec(draft.text);
	if (!match || escaped(match.index) || (code && code.at < match.index)) return draft;
	const name = match[1].toLowerCase();
	// With attributes, only a known tag with an "=" already typed: "if a <b then c" is prose.
	const typing = match[2] ? KNOWN_TAG.includes(name) && match[2].includes("=") : KNOWN_TAG.some((tag) => tag.startsWith(name));
	return typing ? edit(draft, match.index, draft.text.length - match.index) : draft;
}

function withAddressNotYetALink(draft: Draft, code: OpenSpan | null): Draft {
	const match = ADDRESS_BEING_TYPED.exec(draft.text);
	if (!match) return draft;
	const at = match.index + match[1].length;
	if (code && code.at < at) return draft;
	// A character reference for its first letter reads the same but is not a web address to the link finder.
	return edit(draft, at, 1, `&#${draft.text.charCodeAt(at)};`);
}

/** The offset just past a finished link's closing parenthesis, its address and title included, or null while it is still open. */
function linkEnd(text: string, from: number): number | null {
	// Blanks, and at most one line ending, may stand before the address.
	let at = from + (/^[ \t]*(?:\r\n|\r|\n)?[ \t]*/.exec(text.slice(from, from + 200))?.[0].length ?? 0);
	if (text[at] === "<") {
		// An address in angle brackets runs to its ">", spaces included, within its line.
		for (at++; text[at] !== ">"; at++) {
			if (at >= text.length || text[at] === "<" || text[at] === "\n" || text[at] === "\r") return null;
			if (text[at] === "\\") at++;
		}
		at++;
	} else {
		// Otherwise balanced or escaped parentheses, up to a blank or the closing parenthesis.
		let depth = 0;
		for (; at < text.length; at++) {
			const c = text[at];
			if (c === "\\") at++;
			else if (c === "(") depth++;
			else if (c === ")" && depth-- === 0) break;
			else if (SPACE.test(c)) break;
		}
	}
	// An optional title in quotes or parentheses.
	while (text[at] === " " || text[at] === "\t") at++;
	const quote = ({ '"': '"', "'": "'", "(": ")" } as Record<string, string>)[text[at] ?? ""];
	if (quote) {
		for (at++; at < text.length && text[at] !== quote; at++) if (text[at] === "\\") at++;
		for (at++; text[at] === " " || text[at] === "\t"; at++);
	}
	return text[at] === ")" ? at + 1 : null;
}

type Opener = "*" | "**" | "~~";

function withClosedMarks(draft: Draft, from: number, code: OpenSpan | null, backslash?: (at: number) => boolean | undefined, formula?: (at: number) => number): string {
	let shaped = draft;
	let codeCloser = "";
	if (code) {
		const inside = draft.text.slice(code.at + code.length);
		// Part of the closing run may have arrived: only the rest of it is added.
		const arrived = /`+$/.exec(inside)?.[0].length ?? 0;
		if (inside.trim()) codeCloser = "`".repeat(arrived < code.length ? code.length - arrived : code.length);
		else shaped = edit(draft, code.at, code.length);
	}
	const body = shaped.text;
	const scanEnd = code ? code.at : body.length;
	const tableRow = TABLE_LINE.test(body.slice(from));
	// The parser's code holds no marks: the scan steps over each piece of it.
	const codeEnd = new Map(shaped.code.map((range) => [range.start, range.end]));
	const open: Opener[] = [];
	let halfClosed = false;
	let shownBackslashEnd = -1;
	let i = from;
	for (const range of shaped.code) if (from > range.start && from < range.end) i = range.end;
	while (i < scanEnd) {
		const c = body[i];
		const maths = (c === "\\" || c === "$") && formula ? formula(i) : 0;
		const skip = codeEnd.get(i);
		if (skip !== undefined) {
			i = skip;
		} else if (maths) {
			i += maths;
		} else if (c === "\\") {
			const decision = backslash?.(i);
			if (decision === undefined) {
				i += 2;
				continue;
			}
			shownBackslashEnd = i + 1;
			i++;
		} else if (c === "`") {
			const length = runLength(body, i, "`");
			const close = closingRun(body, i + length, length);
			i = close < 0 ? i + length : close + length;
		} else if (c === "]" && body[i + 1] === "(") {
			// A finished link's address and title hold no marks.
			i = linkEnd(body, i + 2) ?? i + 2;
		} else if (c === "|" && tableRow) {
			open.length = 0;
			i++;
		} else if (c === "*" || c === "~" || c === "_") {
			const length = runLength(body, i, c);
			const before = body[i - 1] ?? "\n";
			const after = i + length < body.length ? body[i + length] : "\n";
			const left = !SPACE.test(after) && (!PUNCTUATION.test(after) || SPACE.test(before) || PUNCTUATION.test(before));
			const right = !SPACE.test(before) && (!PUNCTUATION.test(before) || SPACE.test(after) || PUNCTUATION.test(after));
			// Literal: underscores, a single tilde, 2*3*4, and a star right after a path's backslash.
			const literal = c === "_" || (c === "~" && length !== 2) || (c === "*" && length === 1 && LETTER_OR_DIGIT.test(before) && LETTER_OR_DIGIT.test(after)) || i === shownBackslashEnd;
			if (!literal && c === "~") {
				if (right && open[open.length - 1] === "~~") open.pop();
				else if (left) open.push("~~");
			} else if (!literal) {
				let remaining = length;
				while (right && remaining > 0 && (open[open.length - 1] === "*" || open[open.length - 1] === "**")) {
					const need = open[open.length - 1].length;
					if (remaining >= need) {
						open.pop();
						remaining -= need;
					} else {
						// `**x*` at the very end: the second star is on its way.
						if (i + length === body.length) {
							open.pop();
							halfClosed = true;
							remaining = 0;
						}
						break;
					}
				}
				if (left && remaining > 0) {
					if (remaining !== 2) open.push("*");
					if (remaining >= 2) open.push("**");
				}
			}
			i += length;
		} else i++;
	}
	const closers = codeCloser + (halfClosed ? "*" : "") + open.reverse().join("");
	if (!closers) return body;
	// Closers go right after the last visible character: a closer after a space closes nothing.
	let at = body.length;
	while (at > 0 && SPACE.test(body[at - 1])) at--;
	const closed = edit(shaped, at, 0, closers);
	// A code closer refused at a finished span's edge leaves the marks still to close.
	return closed === shaped && codeCloser ? edit(shaped, at, 0, closers.slice(codeCloser.length)).text : closed.text;
}
