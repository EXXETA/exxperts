/**
 * Maths in an answer, read by the Markdown parser itself so code spans, link
 * addresses and Windows paths are decided first and never turn into maths.
 *
 * - Display maths: a `$$` or `\[` line, the formula, a `$$` or `\]` line
 *   (`displayMathsSyntax`, a block construct like a code fence, so it also
 *   runs to the end of an answer still being written).
 * - Inline maths: `\( \)`, `\[ \]` and `$$ $$` on one line, and single
 *   dollars behind a price guard (`dollarFormulaAt`). The parser asks at each
 *   `$` and at each backslash the path rule leaves alone, and gets back how
 *   long the formula there is.
 *
 * Both become `exx-maths` elements carrying the TeX, which the component map
 * draws (Maths.tsx). Not remark-math: its single-dollar rule has no price
 * guard, and its constructs would run before our path rule.
 */

type Code = number | null;
type State = (code: Code) => State | undefined;
interface Token { type: string }
interface Effects {
	enter(type: string): Token;
	consume(code: Code): void;
	exit(type: string): Token;
	attempt(construct: unknown, ok: State, nok: State): State;
	check(construct: unknown, ok: State, nok: State): State;
}
interface TokenizeContext {
	events: Array<[string, Token & { start?: unknown }, { sliceSerialize(token: unknown, expandTabs?: boolean): string }]>;
	interrupt?: boolean;
	parser: { lazy: Record<number, boolean> };
	now(): { line: number; offset: number };
}

const EOF = null;
const DOLLAR = 36;
const BACKSLASH = 92;
const OPEN_BRACKET = 91;
const CLOSE_BRACKET = 93;
const isLineEnding = (code: Code) => code !== EOF && code < -2;
const isSpace = (code: Code) => code === -2 || code === -1 || code === 32;

/** Spaces and tabs, at most `max` of them, under one token. */
function spaces(effects: Effects, next: State, type: string, max = Infinity): State {
	let size = 0;
	const inside: State = (code) => {
		if (isSpace(code) && size++ < max) {
			effects.consume(code);
			return inside;
		}
		effects.exit(type);
		return next(code);
	};
	return (code) => {
		if (!isSpace(code) || max < 1) return next(code);
		effects.enter(type);
		return inside(code);
	};
}

/** The next line, unless it is a lazy line that only continues a paragraph outside. */
const nonLazyContinuation = {
	partial: true,
	tokenize(this: TokenizeContext, effects: Effects, ok: State, nok: State): State {
		const self = this;
		const lineStart: State = (code) => (self.parser.lazy[self.now().line] ? nok(code) : ok(code));
		return (code) => {
			if (code === EOF) return nok(code);
			effects.enter("lineEnding");
			effects.consume(code);
			effects.exit("lineEnding");
			return lineStart;
		};
	},
};

/**
 * A display formula between fence lines: `$$` (two or more) closed by as many
 * dollars, or `\[` closed by `\]`, each alone on its line. Written like
 * micromark's own code fence, so containers (lists, quotes) and an unclosed
 * formula at the end behave as a fence does.
 */
function tokenizeDisplayMaths(this: TokenizeContext, effects: Effects, ok: State, nok: State): State {
	const self = this;
	const tail = self.events[self.events.length - 1];
	const initialPrefix = tail && tail[1].type === "linePrefix" ? tail[2].sliceSerialize(tail[1], true).length : 0;
	let bracket = false;
	let sizeOpen = 0;

	const closeFence = {
		partial: true,
		tokenize(this: TokenizeContext, effects: Effects, ok: State, nok: State): State {
			let size = 0;
			const after: State = (code) => {
				if (code === EOF || isLineEnding(code)) {
					effects.exit("mathsFlowFence");
					return ok(code);
				}
				return nok(code);
			};
			const sequence: State = (code) => {
				if (bracket) {
					if (size === 0 && code === BACKSLASH) {
						size++;
						effects.consume(code);
						return sequence;
					}
					if (size === 1 && code === CLOSE_BRACKET) {
						size++;
						effects.consume(code);
						effects.exit("mathsFlowFenceSequence");
						return spaces(effects, after, "whitespace");
					}
					return nok(code);
				}
				if (code === DOLLAR) {
					size++;
					effects.consume(code);
					return sequence;
				}
				if (size < sizeOpen) return nok(code);
				effects.exit("mathsFlowFenceSequence");
				return spaces(effects, after, "whitespace")(code);
			};
			const start: State = (code) => {
				effects.enter("mathsFlowFence");
				return spaces(effects, (code) => {
					if (code !== (bracket ? BACKSLASH : DOLLAR)) return nok(code);
					effects.enter("mathsFlowFenceSequence");
					return sequence(code);
				}, "linePrefix", 3)(code);
			};
			return (code) => {
				effects.enter("lineEnding");
				effects.consume(code);
				effects.exit("lineEnding");
				return start;
			};
		},
	};

	const after: State = (code) => {
		effects.exit("mathsFlow");
		return ok(code);
	};
	const contentChunk: State = (code) => {
		if (code === EOF || isLineEnding(code)) {
			effects.exit("mathsFlowValue");
			return beforeContentChunk(code);
		}
		effects.consume(code);
		return contentChunk;
	};
	const beforeContentChunk: State = (code) => {
		if (code === EOF || isLineEnding(code)) return effects.check(nonLazyContinuation, atNonLazyBreak, after)(code);
		effects.enter("mathsFlowValue");
		return contentChunk(code);
	};
	const contentStart: State = (code) => spaces(effects, beforeContentChunk, "linePrefix", initialPrefix)(code);
	const contentBefore: State = (code) => {
		effects.enter("lineEnding");
		effects.consume(code);
		effects.exit("lineEnding");
		return contentStart;
	};
	const atNonLazyBreak: State = (code) => effects.attempt(closeFence, after, contentBefore)(code);
	const openEnd: State = (code) => {
		if (code !== EOF && !isLineEnding(code)) return nok(code);
		effects.exit("mathsFlowFence");
		return self.interrupt ? ok(code) : effects.check(nonLazyContinuation, atNonLazyBreak, after)(code);
	};
	const sequenceOpen: State = (code) => {
		if (bracket) {
			if (sizeOpen === 1 && code === OPEN_BRACKET) {
				sizeOpen++;
				effects.consume(code);
				effects.exit("mathsFlowFenceSequence");
				return spaces(effects, openEnd, "whitespace");
			}
			return nok(code);
		}
		if (code === DOLLAR) {
			sizeOpen++;
			effects.consume(code);
			return sequenceOpen;
		}
		if (sizeOpen < 2) return nok(code);
		effects.exit("mathsFlowFenceSequence");
		return spaces(effects, openEnd, "whitespace")(code);
	};
	return (code) => {
		bracket = code === BACKSLASH;
		effects.enter("mathsFlow");
		effects.enter("mathsFlowFence");
		effects.enter("mathsFlowFenceSequence");
		if (bracket) {
			sizeOpen = 1;
			effects.consume(code);
			return sequenceOpen;
		}
		return sequenceOpen(code);
	};
}

const displayMaths = { name: "mathsFlow", concrete: true, tokenize: tokenizeDisplayMaths };

/** The block syntax: for the renderer and for the answer splitter, so a formula is never cut in two. */
export const displayMathsSyntax = { flow: { [DOLLAR]: displayMaths, [BACKSLASH]: displayMaths } };

/**
 * A construct for one inline formula: `length(offset)` says how many
 * characters from there are the formula with its delimiters (0: none there).
 */
export function inlineMathsConstruct(length: (at: number) => number) {
	return {
		tokenize(this: TokenizeContext, effects: Effects, ok: State, nok: State): State {
			const self = this;
			const end = self.now().offset + length(self.now().offset);
			const take: State = (code) => {
				if (code === EOF) return nok(code);
				effects.consume(code);
				if (self.now().offset < end) return take;
				effects.exit("mathsText");
				return ok;
			};
			return (code) => {
				if (end <= self.now().offset) return nok(code);
				effects.enter("mathsText");
				return take(code);
			};
		},
	};
}

interface CompileContext {
	stack: Array<{ type: string; value?: string; data?: Record<string, unknown> }>;
	data: Record<string, unknown>;
	buffer(): void;
	resume(): string;
	enter(node: unknown, token: Token): void;
	exit(token: Token): void;
	sliceSerialize(token: Token): string;
	config: { enter: Record<string, (this: CompileContext, token: Token) => void>; exit: Record<string, (this: CompileContext, token: Token) => void> };
}

/**
 * The element a formula becomes: the component map draws `exx-maths` from its
 * TeX. `open`: a display formula whose closing line has not arrived.
 */
function mathsData(tex: string, display: boolean, written: string, open = false): Record<string, unknown> {
	return { hName: "exx-maths", hProperties: { dataTex: tex, dataDisplay: display ? "true" : undefined, dataWritten: written, dataOpen: open ? "true" : undefined } };
}

/** A line that is only a display formula's fence (`$$`, `\[` or `\]`), in a quote or not; the fence is its first group. */
export const DISPLAY_MATHS_LINE = /^[ \t>]*(\$\$+|\\\[|\\\])[ \t]*$/;

/** Builds `math` and `inlineMath` nodes from the tokens above. */
export const mathsFromMarkdown = {
	canContainEols: ["math"],
	enter: {
		mathsFlow(this: CompileContext, token: Token) {
			this.enter({ type: "math", value: "", data: {} }, token);
		},
		mathsFlowValue(this: CompileContext, token: Token) {
			this.config.enter.data.call(this, token);
		},
		mathsText(this: CompileContext, token: Token) {
			this.enter({ type: "inlineMath", value: "", data: {} }, token);
		},
	},
	exit: {
		mathsFlowFence(this: CompileContext) {
			// The second fence is the closing one the tokenizer accepted: the formula is finished.
			if (this.data.mathsFlowInside) {
				this.data.mathsFlowClosed = true;
				return;
			}
			// The opening fence: what follows, up to the closing one, is the formula.
			this.buffer();
			this.data.mathsFlowInside = true;
		},
		mathsFlowValue(this: CompileContext, token: Token) {
			this.config.exit.data.call(this, token);
		},
		mathsFlow(this: CompileContext, token: Token) {
			const tex = this.resume().replace(/^(\r?\n|\r)|(\r?\n|\r)$/g, "");
			const node = this.stack[this.stack.length - 1];
			const written = this.sliceSerialize(token);
			this.exit(token);
			node.value = tex;
			node.data = mathsData(tex, true, written, !this.data.mathsFlowClosed);
			this.data.mathsFlowInside = undefined;
			this.data.mathsFlowClosed = undefined;
		},
		mathsText(this: CompileContext, token: Token) {
			const written = this.sliceSerialize(token);
			const delimiter = written.startsWith("$$") || written.startsWith("\\") ? 2 : 1;
			const tex = written.slice(delimiter, -delimiter).trim();
			const node = this.stack[this.stack.length - 1];
			this.exit(token);
			node.value = tex;
			node.data = mathsData(tex, written.startsWith("$$") || written.startsWith("\\["), written);
		},
	},
};

/** A maths sign: what a `\[ \]` formula, and a single-dollar one that starts with a digit (`$4\in A$`), must hold. */
export const MATHS_SIGN = /[\^_=+\-*/\\{}<>]/;
const LETTER_OR_DIGIT = /[\p{L}\p{N}]/u;

/** Whether the character at an offset is escaped: an odd run of backslashes stands before it. */
function escaped(line: string, at: number): boolean {
	let run = 0;
	while (line[at - 1 - run] === "\\") run++;
	return run % 2 === 1;
}

/** The next `delimiter` from an offset that is not escaped, or -1. */
function closerFrom(line: string, from: number, delimiter: string): number {
	let found = line.indexOf(delimiter, from);
	while (found >= 0 && escaped(line, found)) found = line.indexOf(delimiter, found + 1);
	return found;
}

/**
 * The length, both delimiters included, of the formula a dollar opens at an
 * offset of its line, or 0. The parser asks only where it reads prose, and
 * a formula holds no backtick, so its closer is in the same prose as its
 * opener: a dollar in code never pairs with one in the text, before it or
 * after it (`$VALUE with \`$HOME\``). `$$ $$` always; single dollars behind
 * the price guard, Pandoc's rule plus prices:
 * - the opener is not escaped, has no space after it and no letter, digit or
 *   dollar before it (`R$ 12`, `US$5`, `\$`);
 * - the closer is the next dollar that is not escaped (`$x+\$y$`), with no
 *   space before it and no digit or dollar after it (`$5 and $10`, `$5-$10`);
 * - a formula that starts with a digit needs a maths sign (`$4\in A$` is
 *   maths, `$5 to 8$` is not).
 * An ask reads on only to the next closer, so the parser's asks along a line
 * read it about once.
 */
export function dollarFormulaAt(line: string, at: number): number {
	if (line[at] !== "$" || escaped(line, at)) return 0;
	if (line[at + 1] === "$") {
		const close = closerFrom(line, at + 2, "$$");
		const body = line.slice(at + 2, close);
		return close > at + 2 && body.trim() && !body.includes("`") ? close + 2 - at : 0;
	}
	if (!opensFormula(line, at)) return 0;
	const close = closerFrom(line, at + 1, "$");
	if (close < 0 || !closesFormula(line, close)) return 0;
	const body = line.slice(at + 1, close);
	return !body.includes("`") && (!/^\d/.test(body) || MATHS_SIGN.test(body)) ? close + 1 - at : 0;
}

function opensFormula(line: string, at: number): boolean {
	const before = line[at - 1] ?? "";
	const after = line[at + 1] ?? "";
	return after !== "" && !/\s/.test(after) && before !== "$" && !LETTER_OR_DIGIT.test(before);
}

function closesFormula(line: string, at: number): boolean {
	const before = line[at - 1] ?? "";
	const after = line[at + 1] ?? "";
	return !/\s/.test(before) && !/[\d$]/.test(after);
}
