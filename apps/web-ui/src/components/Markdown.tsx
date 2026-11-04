import { Component, createContext, lazy, memo, Suspense, useContext, useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown, { defaultUrlTransform } from "react-markdown";
import type { Components, ExtraProps } from "react-markdown";
import remarkGfm from "remark-gfm";
import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmFromMarkdown } from "mdast-util-gfm";
import { gfm } from "micromark-extension-gfm";
import { createAnswerSplitter } from "./answer-blocks";
import { readChart } from "./chart-block";
import { CodeBlock } from "./CodeBlock";
import { CopyTableTool, FigureStrip, FigureTools } from "./figure-tools";
import { ImageActions } from "./ImageActions";
import { Maths } from "./Maths";
import { DISPLAY_MATHS_LINE, dollarFormulaAt, displayMathsSyntax, inlineMathsConstruct, MATHS_SIGN, mathsFromMarkdown } from "./maths-syntax";
import { MermaidDiagram } from "./MermaidDiagram";
import { repairTail, type CodeRange } from "./stream-repair";

type HastNode = NonNullable<ExtraProps["node"]>;

/**
 * How far a fenced block has been written: "opening" while its first line
 * (the language) is not complete, "open" while its closing line has not
 * arrived. A closed fence and indented code carry none.
 */
export type FenceState = "opening" | "open";

// The raw text and language of a fenced block, read from the syntax tree
// rather than from the rendered children: the tree still holds the plain
// text after the `code` component has wrapped it, and a fence with no info
// string simply has no language class.
function fencedCode(pre: HastNode | undefined): { text: string; language: string | undefined; fence: FenceState | undefined } | null {
	const code = pre?.children.find((child) => child.type === "element" && child.tagName === "code");
	if (!code || code.type !== "element") return null;
	const classes = Array.isArray(code.properties?.className) ? code.properties.className : [];
	const language = classes.map(String).find((name) => name.startsWith("language-"))?.slice("language-".length);
	const text = code.children.map((child) => (child.type === "text" ? child.value : "")).join("").replace(/\n$/, "");
	const fence = code.properties?.dataFence;
	return { text, language: language || undefined, fence: fence === "opening" || fence === "open" ? fence : undefined };
}

// Only ~~text~~ crosses out: a single tilde is a Windows short name
// (ENV~1), a range (5~10 min) or a home path, never strikethrough.
const GFM: [typeof remarkGfm, { singleTilde: boolean }] = [remarkGfm, { singleTilde: false }];

type MdastNode = { type: string; value?: string; children?: MdastNode[]; data?: Record<string, unknown> };

function splitSoftBreaks(node: MdastNode): void {
	if (!node.children) return;
	node.children = node.children.flatMap((child): MdastNode[] => {
		if (child.type !== "text" || !child.value?.includes("\n")) {
			splitSoftBreaks(child);
			return [child];
		}
		return child.value.split("\n").flatMap((part, index): MdastNode[] => (index === 0 ? [{ type: "text", value: part }] : [{ type: "break" }, { type: "text", value: part }]));
	});
}

/** An answer keeps the single line breaks it was written with, as the person's own messages do; standard Markdown joins them. */
function remarkKeepLineBreaks() {
	return (tree: MdastNode) => splitSoftBreaks(tree);
}

// HTML is never rendered as HTML. These few tags show as the element they
// mean; layout tags, comments and empty anchors leave only their text.
const HTML_ELEMENTS: Record<string, string> = { b: "strong", strong: "strong", i: "em", em: "em", kbd: "kbd", sup: "sup", sub: "sub" };
const HTML_TEXT_TAG = /^<\/?(?:details|summary|div|p|span|u|small|mark|center)(?:\s[^>]*)?>$/i;
const HTML_KNOWN_TAG = /<!--[\s\S]*?-->|<\/?(?:b|strong|i|em|kbd|sup|sub|br|a|details|summary|div|p|span|u|small|mark|center)(?:\s[^>]*)?\/?>/gi;

function plainHtml(node: MdastNode): void {
	if (!node.children) return;
	const out: MdastNode[] = [];
	const open: Array<{ tag: string; at: number }> = [];
	let emptyAnchors = 0;
	for (const child of node.children) {
		if (child.type !== "html") {
			plainHtml(child);
			out.push(child);
			continue;
		}
		const value = (child.value ?? "").trim();
		const tag = /^<(\/?)([a-z]+)(?:\s[^>]*)?\/?>$/i.exec(value);
		const name = tag?.[2].toLowerCase();
		if (/^<br\s*\/?>$/i.test(value)) out.push({ type: "break" });
		else if (/^<!--[\s\S]*-->$/.test(value)) continue;
		else if (name === "a" && !tag![1] && !/\bhref\s*=/i.test(value)) emptyAnchors++;
		else if (name === "a" && tag![1] && emptyAnchors > 0) emptyAnchors--;
		else if (name && HTML_ELEMENTS[name] && !tag![1]) {
			open.push({ tag: name, at: out.length });
			out.push({ type: "text", value: "" });
		} else if (name && HTML_ELEMENTS[name]) {
			const opened = open.map((entry) => entry.tag).lastIndexOf(name);
			if (opened < 0) continue;
			const [{ at }] = open.splice(opened);
			out.splice(at, out.length - at, { type: "emphasis", children: out.slice(at + 1), data: { hName: HTML_ELEMENTS[name] } });
		} else if (HTML_TEXT_TAG.test(value)) continue;
		else if (!tag && value.replace(HTML_KNOWN_TAG, "").length < value.length && !/<[a-z/!]/i.test(value.replace(HTML_KNOWN_TAG, ""))) {
			// A block of known tags (a <details> box, an anchor line): its text, one line per block tag.
			const text = value.replace(/<br\s*\/?>|<\/(?:summary|div|p)>/gi, "\n").replace(HTML_KNOWN_TAG, "").trim();
			if (text) out.push({ type: "paragraph", children: [{ type: "text", value: text }] });
		} else out.push(child);
	}
	node.children = out;
}

function remarkPlainHtml() {
	return (tree: MdastNode) => plainHtml(tree);
}

const WINDOWS_PATH = /(^|[^\w\\])((?:[A-Za-z]:\\|\\\\(?=[\w.$-]))[^\s`<>"|)\]]*)/g;
// A word that is a path although no drive starts it: a backslash before a
// letter or digit separates folders, and relative or variable roots start one.
const PATH_WORD = /\\[\p{L}\p{N}]|^[("'*_]*(?:\.{1,2}\\|%\w+%\\|\$env:\w+\\|\\\\[?.]\\)/u;

/**
 * The \( \) and \[ \] formulas on one line, each opener's offset mapped to
 * its closer's. A span runs from an opener to its first closer with no line
 * break; between \( \) anything but blanks is maths (`\(n\)`), between \[ \]
 * only text with a maths sign, so escaped brackets around a word stay
 * brackets. The closer's own backslash never counts as a sign and the scan
 * stays linear.
 */
function mathsDelimiters(line: string): Map<number, number> {
	const found = new Map<number, number>();
	const opener = /(?<!\\)\\[([]/g;
	const lineBreak = /[\r\u2028\u2029]/g;
	// The next closer of each kind and the next line break, kept while they lie ahead: -1 once none is left.
	const next: Record<string, number> = {};
	const ahead = (key: string, from: number, find: () => number) => (next[key] === undefined || (next[key] >= 0 && next[key] < from) ? (next[key] = find()) : next[key]);
	for (let match; (match = opener.exec(line)); ) {
		const from = match.index + 2;
		const kind = match[0][1];
		const closer = ahead(kind, from, () => line.indexOf(kind === "(" ? "\\)" : "\\]", from));
		const lineEnd = ahead("break", from, () => ((lineBreak.lastIndex = from), lineBreak.exec(line)?.index ?? -1));
		const body = line.slice(from, closer);
		if (closer < 0 || (lineEnd >= 0 && lineEnd < closer) || !(kind === "(" ? /\S/.test(body) : MATHS_SIGN.test(body))) continue;
		found.set(match.index, closer);
		opener.lastIndex = closer + 2;
	}
	return found;
}

/**
 * The backslashes of one line that show as written, each mapped to whether
 * it also sits right before a bracket in a link's address. Markdown would
 * read each as an escape or a line break, but in a Windows path it is a
 * separator, so C:\exxtest\.env keeps its "\." and a folder's last backslash
 * at a line end is not a break. A pair still shows as one, since a model that
 * knows the escape rule writes C:\\exxtest\\notes.md, except a network or
 * device path's leading pair, which is the path. A \( or \[ that is not part
 * of a rooted path and opens a formula on this line is in `formulas`, with
 * the formula's length, even in a word that reads as a path (`\(\alpha\)`):
 * the parser reads it as maths (maths-syntax.ts). Where it cannot (a link's
 * address), its delimiters show as written. `arriving` holds the openers
 * on the last line whose closer has not arrived yet, in order. The
 * line is read once for all its backslashes, so a long line costs one pass.
 */
function shownInLine(line: string, last: boolean): { shown: Map<number, boolean>; formulas: Map<number, number>; arriving: number[] } {
	const shown = new Map<number, boolean>();
	const formulas = new Map<number, number>();
	const arriving: number[] = [];
	const paths = [...line.matchAll(WINDOWS_PATH)];
	const words = [...line.matchAll(/\S+/g)];
	let path = 0;
	let word = -1;
	let wordStart = 0;
	let pathWord = false;
	let device: number | undefined;
	let address = -1;
	let nextAddress = line.indexOf("](");
	let maths: Map<number, number> | undefined;
	let closers: Set<number> | undefined;
	let lastCloser: Record<string, number> | undefined;
	for (let index = line.indexOf("\\"); index >= 0; index = line.indexOf("\\", index + 1)) {
		const next = line[index + 1] ?? "";
		// A table cell's \| is its pipe.
		if (next === "|") continue;
		while (word < 0 || words[word].index + words[word][0].length <= index) {
			const found = words[++word];
			wordStart = found.index;
			pathWord = PATH_WORD.test(found[0]);
			device = /^[("'*_]*(?=\\\\[?.]\\)/.exec(found[0])?.[0].length;
		}
		// Micromark reads a backslash before a bracket in a link's address as an escape, before these rules run.
		while (nextAddress >= 0 && nextAddress + 2 <= index) {
			address = nextAddress;
			nextAddress = line.indexOf("](", address + 1);
		}
		const separator = (next === "(" || next === ")") && line[index - 1] !== "\\" && address >= wordStart;
		while (path < paths.length && paths[path].index + paths[path][0].length <= index) path++;
		const from = path < paths.length ? paths[path].index + paths[path][1].length : Infinity;
		if (index >= from) {
			if (next !== "\\" || (index === from && paths[path][2].startsWith("\\\\"))) shown.set(index, separator);
			continue;
		}
		if (next === "(" || next === "[") {
			maths ??= mathsDelimiters(line);
			const closer = maths.get(index);
			if (closer !== undefined) {
				formulas.set(index, closer + 2 - index);
				shown.set(index, false);
				continue;
			}
			// While an answer streams, its maths may not have reached the closing delimiter yet.
			if (last && (lastCloser ??= { "(": line.lastIndexOf("\\)"), "[": line.lastIndexOf("\\]") })[next] < index + 2 && (next === "(" ? /\S/ : MATHS_SIGN).test(line.slice(index + 2))) {
				shown.set(index, false);
				// Only what can be nothing but maths waits: a \[ that starts its line, with no plain bracket closing it
				// after (\[field_name] is prose), and a \( with no plain parenthesis closing it.
				const plainCloser = line.indexOf(next === "(" ? ")" : "]", index + 2) >= 0;
				if (!plainCloser && (next === "(" || !line.slice(0, index).trim())) arriving.push(index);
				continue;
			}
		}
		if (pathWord) {
			if (next !== "\\" || device === index - wordStart) shown.set(index, separator);
			continue;
		}
		if (!/[()[\]]/.test(next)) continue;
		maths ??= mathsDelimiters(line);
		closers ??= new Set(maths.values());
		if (DISPLAY_MATHS_LINE.exec(line)?.[1][0] === "\\" || closers.has(index)) shown.set(index, false);
	}
	return { shown, formulas, arriving };
}

/** The rules of the line holding an offset, worked out once per line: callers ask in order through the text. */
function lineRules(source: string): (at: number) => { start: number; text: string } & ReturnType<typeof shownInLine> {
	let start = 0;
	let end = -1;
	let text = "";
	let rules: ReturnType<typeof shownInLine> = { shown: new Map(), formulas: new Map(), arriving: [] };
	return (at) => {
		if (at < start || at > end) {
			start = source.lastIndexOf("\n", at - 1) + 1;
			end = source.indexOf("\n", at);
			text = source.slice(start, end < 0 ? undefined : end);
			rules = shownInLine(text, end < 0);
			if (end < 0) end = source.length;
		}
		return { start, text, ...rules };
	};
}

/**
 * Whether the backslash at an offset shows as written (false or true; true
 * when it sits before a bracket in a link's address) or is an escape
 * (undefined).
 */
function backslashRule(source: string): (at: number) => boolean | undefined {
	const line = lineRules(source);
	return (at) => {
		const { start, shown } = line(at);
		return shown.get(at - start);
	};
}

/** The length of the inline formula starting at an offset (`\( \)`, `\[ \]`, `$$ $$` or `$ $`), delimiters included; 0 when none does. */
function formulaRule(source: string): (at: number) => number {
	const line = lineRules(source);
	return (at) => {
		const { start, text, formulas } = line(at);
		return source[at] === "$" ? dollarFormulaAt(text, at - start) : (formulas.get(at - start) ?? 0);
	};
}

/**
 * Where an inline formula on the text's last line starts whose closer has not
 * arrived (a \( or \[ that can be nothing but maths, or a `$$`), or -1. A
 * single dollar is never held: until its closer comes it may be a price. A
 * `$$` alone on its line opens or closes a display formula, not this. The
 * dollars are read as the parser reads them: one in code is passed over, and
 * a finished formula is read whole, so a `$$` inside one opens nothing.
 */
function arrivingFormula(source: string, code: CodeRange[]): number {
	const start = source.lastIndexOf("\n") + 1;
	const line = source.slice(start);
	if (DISPLAY_MATHS_LINE.test(line)) return -1;
	const codeAt = (at: number) => code.find((range) => range.start <= start + at && start + at < range.end);
	const found = [shownInLine(line, true).arriving.find((at) => !codeAt(at)) ?? -1];
	for (let at = line.indexOf("$"); at >= 0; ) {
		const inCode = codeAt(at);
		const length = inCode ? inCode.end - start - at : dollarFormulaAt(line, at);
		if (!length && line[at + 1] === "$" && line[at - 1] !== "\\") {
			found.push(at);
			break;
		}
		at = line.indexOf("$", at + Math.max(1, length));
	}
	const first = Math.min(...found.filter((at) => at >= 0));
	return Number.isFinite(first) ? start + first : -1;
}

/** Where the text holds code as the parser reads it, in order: fenced, indented and inline, delimiters included. */
function codeRanges(text: string): CodeRange[] {
	const ranges: CodeRange[] = [];
	const visit = (node: MdastNode & { position?: { start: { offset?: number }; end: { offset?: number } } }): void => {
		const { start, end } = node.position ?? { start: {}, end: {} };
		if ((node.type === "code" || node.type === "inlineCode") && start.offset !== undefined && end.offset !== undefined) ranges.push({ start: start.offset, end: end.offset, block: node.type === "code" });
		else node.children?.forEach(visit);
	};
	visit(fromMarkdown(text, { extensions: [gfm({ singleTilde: false })], mdastExtensions: [gfmFromMarkdown()] }) as never);
	return ranges;
}

/** The last block of an answer still being written, as it is drawn: repaired with the renderer's own rules (stream-repair.ts). */
export function repairAnswerTail(raw: string): string {
	return repairTail(raw, { backslash: backslashRule, formula: formulaRule, arrivingFormula, code: codeRanges });
}

type Code = number | null;
type State = (code: Code) => State | undefined;
type Effects = { enter(type: string): void; consume(code: Code): void; exit(type: string): void };

/**
 * Characters the parser keeps as written: each rule returns how many
 * characters from that point are plain text (0: none). Only prose and link
 * addresses reach these, so code and HTML are never touched.
 */
function plainCharacters(length: (at: number) => number) {
	return {
		tokenize(this: { now(): { offset: number } }, effects: Effects, ok: State, nok: State): State {
			let left = length(this.now().offset);
			const take: State = (code) => {
				effects.consume(code);
				if (--left) return take;
				effects.exit("data");
				return ok;
			};
			if (!left) return nok;
			effects.enter("data");
			return take;
		},
	};
}

const DUNDER_NAME = /__[\p{L}\p{N}]+__(?=\.[\p{L}\p{N}])/uy;

type Parse = (doc: string, file: never) => unknown;

type CodeNode = { type: string; position?: { start: { offset?: number }; end: { offset?: number } }; data?: { hProperties?: Record<string, unknown> }; children?: CodeNode[] };

/**
 * Marks each fenced code block that is not finished with its FenceState
 * (`data-fence` on the code element), from the text that was actually parsed:
 * the parser does not record whether a fence was closed, and an unclosed one
 * simply runs to the end. A fence its list item or quote ended before the
 * end of the text is finished: nothing more will be written into it.
 */
function markOpenFences(node: CodeNode, source: string): void {
	for (const child of node.children ?? []) {
		if (child.type !== "code") {
			markOpenFences(child, source);
			continue;
		}
		const end = child.position?.end.offset ?? 0;
		const slice = source.slice(child.position?.start.offset ?? 0, end);
		const opener = /^[ \t]*(`{3,}|~{3,})/.exec(slice);
		if (!opener) continue;
		// The parser's own line ends: LF, CRLF or a lone CR.
		const lines = slice.split(/\r\n|\r|\n/);
		const closer = lines.length > 1 ? /^[ \t>]*(`{3,}|~{3,})[ \t]*$/.exec(lines[lines.length - 1]) : null;
		const closed = closer !== null && closer[1][0] === opener[1][0] && closer[1].length >= opener[1].length;
		if (closed || source.slice(end).trim() !== "") continue;
		child.data = { ...child.data, hProperties: { ...child.data?.hProperties, dataFence: lines.length > 1 ? "open" : "opening" } };
	}
}

/**
 * Paths, Python's __init__.py and a product like 2*3*4 read as written,
 * formulas read as maths (maths-syntax.ts), and an unfinished fence is marked
 * (markOpenFences).
 */
function remarkAsWritten(this: { data(): object; parser?: Parse }) {
	let source = "";
	let shown = backslashRule(source);
	let formulaAt = formulaRule(source);
	// The offsets of path backslashes right before a bracket in a link's address.
	const inAddress = new Set<number>();
	const backslash = plainCharacters((at) => {
		const decision = shown(at);
		if (decision) inAddress.add(at);
		return decision === undefined ? 0 : 1;
	});
	const formula = inlineMathsConstruct((at) => formulaAt(at));
	const star = plainCharacters((at) => (/[\p{L}\p{N}]/u.test(source[at - 1] ?? "") && /[\p{L}\p{N}]/u.test(source[at + 1] ?? "") ? 1 : 0));
	const dunder = plainCharacters((at) => {
		if (at > 0 && !/(?:[^\w\\]|\\\\)$/.test(source.slice(Math.max(0, at - 2), at))) return 0;
		DUNDER_NAME.lastIndex = at;
		return DUNDER_NAME.exec(source)?.[0].length ?? 0;
	});
	const data = this.data() as { micromarkExtensions?: unknown[]; fromMarkdownExtensions?: unknown[] };
	(data.micromarkExtensions ??= []).push({ text: { 36: formula, 42: star, 92: [formula, backslash], 95: dunder }, string: { 92: backslash } }, displayMathsSyntax);
	(data.fromMarkdownExtensions ??= []).push(mathsFromMarkdown);
	const parse = this.parser!;
	this.parser = (doc, file) => {
		// Micromark skips a leading byte order mark, so its offsets count from after it.
		source = doc.replace(/^\uFEFF/, "");
		shown = backslashRule(source);
		formulaAt = formulaRule(source);
		inAddress.clear();
		let tree = parse(source, file);
		if (inAddress.size) {
			// Micromark reads such a backslash as an escape of the bracket, so the
			// address runs on; doubled, it ends at the bracket and still shows once.
			let at = 0;
			source = [...inAddress].sort((a, b) => a - b).map((offset) => source.slice(at, (at = offset))).join("\\") + "\\" + source.slice(at);
			shown = backslashRule(source);
			formulaAt = formulaRule(source);
			tree = parse(source, file);
		}
		markOpenFences(tree as CodeNode, source);
		return tree;
	};
}

const MARKDOWN_PLUGINS = [GFM, remarkPlainHtml, remarkAsWritten];
const ANSWER_PLUGINS = [GFM, remarkPlainHtml, remarkKeepLineBreaks, remarkAsWritten];

type HastChild = { type: string; tagName?: string; value?: string; properties?: Record<string, unknown>; children?: HastChild[] };

/**
 * Inline code in a table cell wraps only where the cell's own text would, and
 * a path gets a break chance after each backslash and slash, so a narrow
 * column of a finished table reads `C:\Users\<username>\` over
 * `AppData\Roaming` and keeps `%LOCALAPPDATA%` whole instead of cutting them
 * every few letters; a table that cannot fit then scrolls in its frame. While
 * the answer streams, its equal columns still break a word wider than them.
 * The text itself is unchanged.
 */
function cellPathBreaks(node: HastChild, inCell: boolean): void {
	for (const child of node.children ?? []) {
		if (child.type !== "element") continue;
		if (inCell && child.tagName === "code") {
			child.children = (child.children ?? []).flatMap((part): HastChild[] => {
				if (part.type !== "text") return [part];
				return (part.value ?? "").split(/(?<=[\\/])(?=.)/).flatMap((piece, i): HastChild[] => (i === 0 ? [{ type: "text", value: piece }] : [{ type: "element", tagName: "wbr", properties: {}, children: [] }, { type: "text", value: piece }]));
			});
			child.properties = { ...child.properties, className: ["md-cell-code"] };
		} else cellPathBreaks(child, inCell || child.tagName === "td" || child.tagName === "th");
	}
}

function rehypeCellPathBreaks() {
	return (tree: HastChild) => cellPathBreaks(tree, false);
}

const ANSWER_REHYPE_PLUGINS = [rehypeCellPathBreaks];

/**
 * Block-level syntax the answer's renderer adds beyond GFM, as micromark
 * extensions and the mdast extensions that turn them into nodes: display
 * formulas (maths-syntax.ts). The answer splitter must know such syntax, or
 * it would cut one of its blocks in two. Syntax added here joins
 * remarkAsWritten's parser at the same time.
 */
const ANSWER_BLOCK_SYNTAX: Parameters<typeof createAnswerSplitter>[0] = [displayMathsSyntax as never];
const ANSWER_BLOCK_NODES: Parameters<typeof createAnswerSplitter>[1] = [mathsFromMarkdown as never];

/**
 * Heuristic: if it has any markdown-y characters, render through
 * ReactMarkdown; otherwise callers may choose preformatted text.
 */
function looksLikeMarkdown(s: string): boolean {
	return /(^|\n)(#{1,6} |\* |- |\d+\. |```|>)|\*\*|`[^`]+`|\[[^\]]+]\([^)]+\)/.test(s);
}

/** Whether a link's address leads anywhere outside the app, in a new tab here and from a mail once copied. */
export const opensOutside = (address: string): boolean => /^(?:https?:|mailto:)/i.test(address);

/**
 * Sub-agents sometimes wrap their entire output in a single fenced code
 * block (```markdown ... ``` or ```md ... ```), which makes the rendered
 * result look like a wall of monospaced text instead of formatted
 * Markdown. If the WHOLE string is one such fence, peel it.
 */
export function unwrapOuterMarkdownFence(s: string): string {
	const trimmed = s.trim();
	const m = trimmed.match(/^```(?:markdown|md)?\s*\n([\s\S]*?)\n```$/);
	if (!m) return s;
	const inner = m[1];
	if (!looksLikeMarkdown(inner)) return s;
	return inner;
}

// A mermaid fence rendered as a diagram is not phrasing content, so the
// default <pre> wrapper (and the code-block chrome) must be dropped for it.
// Decided from the fence's language in the syntax tree: the rendered child
// is the custom `code` component, not the diagram element itself, so it
// cannot be recognised by inspecting React children.
function isMermaidLanguage(language: string | undefined): boolean {
	return language === "mermaid" || language === "mmd";
}

// An image is rendered only when fetching it cannot reach the network:
// data: URIs and same-origin/relative paths. Anything with a scheme or a
// protocol-relative host is a remote fetch the model can use as a read
// beacon, so it must stay a click away.
function isSafeImageSrc(src: string): boolean {
	if (/^data:image\//i.test(src)) return true;
	return !/^[a-z][a-z0-9+.-]*:|^\/\//i.test(src);
}

// The room files route (roomFileUrl in room-files-api.ts), any room id: a
// picture a reply shows from a room's shelf is the shelf file itself, so
// clicking it opens that file in the viewer like an attached thumbnail does.
// Only the encoded name is taken from the URL; the room id is not trusted —
// the callback resolves the name against THIS room's shelf and a name not on
// it is a no-op.
const ROOM_FILE_ROUTE = /^\/api\/persistent-agents\/[^/?#]+\/files\/([^/?#]+)(?:[?#]|$)/;
function roomFileNameFromSrc(src: string): string | null {
	const encoded = ROOM_FILE_ROUTE.exec(src)?.[1];
	if (!encoded) return null;
	try {
		return decodeURIComponent(encoded);
	} catch {
		return null; // a malformed escape: not a name the shelf could hold
	}
}

/** The address as the model wrote it: the parser percent-encodes a backslash or a space. */
function readableAddress(address: string): string {
	try {
		return decodeURIComponent(address);
	} catch {
		return address;
	}
}

/**
 * What a "#" link names inside its own answer: a footnote by its id, or a
 * heading by its words ("#details" for "## Details", "#details-1" for the
 * second such heading). Headings carry no id, so answers never share one.
 */
export function anchorTarget(root: ParentNode, id: string): Element | null {
	for (const name of [id, `user-content-${id}`]) {
		const found = root.querySelector(`[id="${CSS.escape(name)}"]`);
		if (found) return found;
	}
	const numbered = /^(.*)-(\d+)$/.exec(id);
	const named = (anchor: string) => [...root.querySelectorAll(`[data-anchor="${CSS.escape(anchor)}"]`)];
	return named(id)[0] ?? (numbered ? named(numbered[1])[Number(numbered[2])] : undefined) ?? null;
}

function scrollToAnchor(link: HTMLElement, id: string): void {
	anchorTarget(link.closest(".md") ?? document, id)?.scrollIntoView({ behavior: "smooth", block: "center" });
}

/** A heading's anchor as GitHub writes it: lower case, words joined by hyphens. */
function headingAnchor(node: HastNode | undefined): string {
	const text = (n: any): string => (n?.type === "text" ? n.value : (n?.children ?? []).map(text).join(""));
	return text(node).trim().toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, "").replace(/\s+/g, "-");
}

/** Marks the sides of a table frame whose scroller hides columns, so its band shows there. */
export function markTableFrame(frame: HTMLElement): void {
	const scroller = frame.firstElementChild;
	if (!scroller) return;
	frame.toggleAttribute("data-more-left", scroller.scrollLeft > 1);
	frame.toggleAttribute("data-more-right", scroller.scrollLeft + scroller.clientWidth < scroller.scrollWidth - 1);
}

// The band sits on the frame, outside the scroller, so it stays at the edge and paints above the table.
function TableFrame({ copy, children }: { copy: boolean; children: React.ReactNode }) {
	const frame = useRef<HTMLDivElement>(null);
	useEffect(() => {
		const element = frame.current;
		const scroller = element?.firstElementChild;
		if (!element || !scroller) return;
		const mark = () => markTableFrame(element);
		mark();
		scroller.addEventListener("scroll", mark, { passive: true });
		const resized = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(mark);
		resized?.observe(scroller);
		if (scroller.firstElementChild) resized?.observe(scroller.firstElementChild);
		return () => {
			scroller.removeEventListener("scroll", mark);
			resized?.disconnect();
		};
	}, []);
	const framed = <div ref={frame} className="md-table-frame"><div className="md-table-scroll">{children}</div></div>;
	if (!copy) return framed;
	return (
		<div className="figure-table">
			<FigureStrip className="figure-strip-plain"><FigureTools copy={<CopyTableTool table={() => frame.current?.querySelector("table")} />} /></FigureStrip>
			{framed}
		</div>
	);
}

/**
 * Whether the answer is still being written. A context, not an argument to
 * the component map: when an answer ends only its readers draw again, so a
 * drawn diagram (its open viewer included) keeps its element.
 */
const AnswerStreaming = createContext(false);
/** Whether a formula stands in a table, whose own Copy takes it along. */
const InTable = createContext(false);

/** A diagram still being written: a quiet box the size of a small diagram, its code behind a toggle. */
function DiagramBeingDrawn({ children }: { children: React.ReactNode }) {
	const [codeShown, setCodeShown] = useState(false);
	return (
		<figure className="mermaid-diagram mermaid-diagram-loading mermaid-diagram-writing figure-card" aria-label="Drawing diagram">
			<div className="mermaid-diagram-loading-text figure-sweep">Drawing diagram…</div>
			<button type="button" className="mermaid-diagram-code-toggle" aria-expanded={codeShown} onClick={() => setCodeShown((shown) => !shown)}>{codeShown ? "Hide code" : "Show code"}</button>
			{codeShown && <pre className="mermaid-diagram-writing-code">{children}</pre>}
		</figure>
	);
}

/** A chart still being written, or its drawing code still loading: a quiet box the chart's size. */
function ChartBeingDrawn() {
	return (
		<figure className="figure-card answer-chart-card answer-chart-writing" aria-label="Drawing chart">
			<div className="figure-sweep">Drawing chart…</div>
		</figure>
	);
}

// The chart's drawing code comes with the first chart.
const ChartBlock = lazy(() => import("./ChartBlock"));

/** A chart whose drawing code cannot load or draw shows as its code, never as the app's error screen. */
class ChartOrCode extends Component<{ code: React.ReactNode; children: React.ReactNode }, { failed: boolean }> {
	state = { failed: false };

	static getDerivedStateFromError(): { failed: boolean } {
		return { failed: true };
	}

	render(): React.ReactNode {
		return this.state.failed ? this.props.code : this.props.children;
	}
}

// Intercept ```mermaid / ```mmd and ```chart fences. A diagram or a chart is
// drawn once its fence is closed, while the answer below it may still be
// arriving, so it is drawn once and never from half its code; until then it
// is a quiet box, and an answer that ended inside its fence keeps it as code.
// A ```math fence is a display formula, and a formula the parser found
// (maths-syntax.ts) is an `exx-maths` element.
function markdownComponents(onOpenRoomFile?: (name: string) => void, codeTokens = false, answer = false): Components {
	const heading = (Tag: "h1" | "h2" | "h3" | "h4" | "h5" | "h6") => ({ node, children, ...props }: React.ComponentProps<typeof Tag> & ExtraProps) => <Tag {...props} data-anchor={headingAnchor(node)}>{children}</Tag>;
	return {
		h1: heading("h1"),
		h2: heading("h2"),
		h3: heading("h3"),
		h4: heading("h4"),
		h5: heading("h5"),
		h6: heading("h6"),
		// While the answer is written its tables keep equal, fixed columns, so
		// a growing row never re-balances them; they take their own widths once, at the end.
		table({ node: _node, children, ...props }) {
			const streaming = useContext(AnswerStreaming);
			return <TableFrame copy={answer}><InTable.Provider value={true}><table {...props} data-streaming={streaming || undefined}>{children}</table></InTable.Provider></TableFrame>;
		},
		a({ href, children, node: _node, ...props }) {
			const address = typeof href === "string" ? href : "";
			// A footnote or "#details" stays in this answer: a new tab would open the app again.
			if (address.startsWith("#")) return <a href={address} {...props} onClick={(event) => { event.preventDefault(); scrollToAnchor(event.currentTarget, address.slice(1)); }}>{children}</a>;
			// A file, a relative or any other address opens nothing here: it shows as text the person can copy.
			if (!opensOutside(address)) {
				const written = readableAddress(address);
				return written && String(children) !== written ? <span>{children} <code>{written}</code></span> : written ? <code>{written}</code> : <span>{children}</span>;
			}
			return (
				<a href={address} target="_blank" rel="noopener noreferrer" {...props}>
					{children}
				</a>
			);
		},
		img({ src, alt }) {
			const url = typeof src === "string" ? src : "";
			if (url && isSafeImageSrc(url)) {
				const image = <img src={url} alt={alt ?? ""} loading="lazy" />;
				const roomFile = onOpenRoomFile ? roomFileNameFromSrc(url) : null;
				if (roomFile === null) return image;
				// A shelf picture also carries the copy/download cluster on its
				// corner; a picture from anywhere else is not the room's to save.
				return (
					<ImageActions src={url} name={roomFile}>
						<button type="button" className="md-image-button" title={`${roomFile} — open`} onClick={() => onOpenRoomFile!(roomFile)}>{image}</button>
					</ImageActions>
				);
			}
			if (!url) return <span>{alt ?? ""}</span>;
			return (
				<a href={url} target="_blank" rel="noopener noreferrer">
					{alt ? `${alt} (image: ${url})` : `image: ${url}`}
				</a>
			);
		},
		code({ className, children, node: _node, "data-fence": _fence, ...props }: React.ComponentProps<"code"> & ExtraProps & { "data-fence"?: string }) {
			// codeTokens: inline code keeps each space-separated token in its own
			// span, so a stylesheet can let it wrap only between tokens (a table
			// cell on a skill's page). The text itself is unchanged.
			if (codeTokens && !className && typeof children === "string" && !children.includes("\n")) {
				return <code {...props}>{children.split(/(\s+)/).map((part, i) => (/^\s*$/.test(part) ? part : <span key={i} className="md-code-token">{part}</span>))}</code>;
			}
			return <code className={className} {...props}>{children}</code>;
		},
		pre({ children, node, ...props }) {
			const streaming = useContext(AnswerStreaming);
			const fenced = fencedCode(node);
			if (!fenced) return <pre {...props}>{children}</pre>;
			const language = fenced.language?.toLowerCase();
			if (isMermaidLanguage(language)) {
				if (!fenced.fence) return <MermaidDiagram chart={fenced.text} />;
				if (streaming) return <DiagramBeingDrawn>{children}</DiagramBeingDrawn>;
			}
			// A language still being typed that may become a diagram's, a
			// chart's or a formula's is its box already, so it never flashes as code first.
			if (fenced.fence === "opening" && streaming && language) {
				if (["mermaid", "mmd"].some((name) => name.startsWith(language))) return <DiagramBeingDrawn>{children}</DiagramBeingDrawn>;
				if ("chart".startsWith(language)) return <ChartBeingDrawn />;
				if ("math".startsWith(language)) return <Maths tex="" display written="" writing />;
			}
			const asCode = <CodeBlock code={fenced.text} language={fenced.language} fence={fenced.fence} streaming={streaming} preProps={props}>{children}</CodeBlock>;
			// A block that is not a chart, or an answer that ended inside one, shows as its code.
			if (language === "chart") {
				if (fenced.fence && streaming) return <ChartBeingDrawn />;
				const read = fenced.fence ? null : readChart(fenced.text);
				// Keyed by its text: other numbers start with no value hovered.
				if (read?.ok) return <ChartOrCode key={fenced.text} code={asCode}><Suspense fallback={<ChartBeingDrawn />}><ChartBlock chart={read.chart} /></Suspense></ChartOrCode>;
			}
			if (language === "math" && fenced.fence !== "opening") return <Maths tex={fenced.text} display written={fenced.text} writing={streaming && fenced.fence === "open"} copy={answer} />;
			return asCode;
		},
		...({
			"exx-maths": ({ "data-tex": tex, "data-display": display, "data-written": written, "data-open": open }: { "data-tex"?: string; "data-display"?: string; "data-written"?: string; "data-open"?: string }) => {
				const streaming = useContext(AnswerStreaming);
				const inTable = useContext(InTable);
				return <Maths tex={tex ?? ""} display={display === "true"} written={written ?? tex ?? ""} writing={streaming && open === "true"} copy={answer && !inTable} />;
			},
		} as Components),
	};
}

// A link keeps its address so the link component can show a non-web one as
// text; it only ever becomes an href for http, https, mailto or "#".
function keepLinkAddress(url: string, key: string): string {
	return key === "href" ? url : defaultUrlTransform(url);
}

/** One block of an answer drawn in blocks: drawn again only when its own text or the component map changes. */
const AnswerBlock = memo(function AnswerBlock({ text, components }: { text: string; components: Components }) {
	return <ReactMarkdown remarkPlugins={ANSWER_PLUGINS} rehypePlugins={ANSWER_REHYPE_PLUGINS} components={components} urlTransform={keepLinkAddress}>{text}</ReactMarkdown>;
});

/**
 * `onOpenRoomFile` opens a shelf file in the viewer; when given, a picture
 * whose source is the room files route becomes a button that calls it with
 * the file name. Pass a stable identity: it is a dependency of the memoised
 * component map, so a fresh function each render re-parses the markdown.
 *
 * `streaming`: the message is still being written, so a diagram waits for
 * its fence to close (a quiet box until then). An answer that streams is drawn in its top-level blocks
 * (answer-blocks.ts), so each new piece parses only the block still being
 * written, and stays in blocks for as long as it is shown; one that opens
 * finished is drawn whole. While it streams, its last block is repaired
 * before it is drawn (stream-repair.ts), only for the drawing: the text
 * itself, stored, saved and copied, is never changed.
 */
function MarkdownRendererImpl({ children, streaming = false, onOpenRoomFile, codeTokens = false, answer = false }: { children: string; streaming?: boolean; onOpenRoomFile?: (name: string) => void; codeTokens?: boolean; answer?: boolean }) {
	const components = useMemo(() => markdownComponents(onOpenRoomFile, codeTokens, answer), [onOpenRoomFile, codeTokens, answer]);
	const [streamed, setStreamed] = useState(streaming);
	if (streaming && !streamed) setStreamed(true);
	const [split] = useState(() => createAnswerSplitter(ANSWER_BLOCK_SYNTAX, ANSWER_BLOCK_NODES));
	if (answer && streamed) {
		const blocks = split(children);
		return <AnswerStreaming.Provider value={streaming}>{blocks.map((block, i) => <AnswerBlock key={i} text={streaming && i === blocks.length - 1 ? repairAnswerTail(block.raw) : block.raw} components={components} />)}</AnswerStreaming.Provider>;
	}
	return <AnswerStreaming.Provider value={streaming}><ReactMarkdown remarkPlugins={answer ? ANSWER_PLUGINS : MARKDOWN_PLUGINS} rehypePlugins={answer ? ANSWER_REHYPE_PLUGINS : undefined} components={components} urlTransform={keepLinkAddress}>{children}</ReactMarkdown></AnswerStreaming.Provider>;
}

export const MarkdownRenderer = memo(MarkdownRendererImpl);
