/**
 * Splits an answer into its top-level Markdown blocks (paragraphs, headings,
 * lists, tables, code blocks), so a streaming answer can draw each settled
 * block once and parse only the block still being written.
 *
 * It parses with the same micromark grammar react-markdown and remark-gfm use
 * (plus the answer's other block syntax, ANSWER_BLOCK_SYNTAX in Markdown.tsx),
 * so its edges are the ones the renderer draws. Each block starts at its
 * line start, keeping the indentation code and lists depend on, and runs to
 * the next block's line start, so the blocks joined are the text.
 *
 * Two things are document-wide and keep the answer whole from there on:
 * - a link definition or footnote definition: the whole answer is one block,
 *   or a reference would show as literal text;
 * - top-level HTML: the answer's HTML step pairs an opening tag with a later
 *   closer among the top-level blocks, so from the first HTML block on, the
 *   rest is one block.
 *
 * Incremental: when the new text extends the last one, every block before
 * the second-to-last is reused as the same string, and only the rest is
 * parsed again. One appended piece can only change how the last line reads,
 * and that line can only merge into the block just before it (a setext
 * underline, a lazy continuation line).
 */

import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmFromMarkdown } from "mdast-util-gfm";
import { gfm } from "micromark-extension-gfm";

type Extension = ReturnType<typeof gfm>;

export interface AnswerBlock {
	raw: string;
	/** Offset of the block in the answer. */
	start: number;
}

interface TopNode {
	type: string;
	position?: { start: { offset?: number }; end: { offset?: number } };
	children?: TopNode[];
}

function holdsDefinition(node: TopNode): boolean {
	return node.type === "definition" || node.type === "footnoteDefinition" || Boolean(node.children?.some(holdsDefinition));
}

// The start of the line when only blanks stand before `offset` on it, else
// `offset`. A line ends at LF, CR LF or a lone CR, as micromark reads it. It
// looks back over the blanks only, so finding every block's start stays linear.
function lineStartOf(text: string, offset: number): number {
	let at = offset;
	while (at > 0 && (text[at - 1] === " " || text[at - 1] === "\t")) at--;
	return at === 0 || text[at - 1] === "\n" || text[at - 1] === "\r" ? at : offset;
}

type MdastExtension = ReturnType<typeof gfmFromMarkdown>[number];

/** Blocks of `text` from `base` on, or null when the whole text must stay one block. */
function splitFrom(text: string, base: number, extensions: Extension[], mdastExtensions: MdastExtension[]): AnswerBlock[] | null {
	const tail = text.slice(base);
	const tree = fromMarkdown(tail, { extensions: [gfm({ singleTilde: false }), ...extensions], mdastExtensions: [gfmFromMarkdown(), ...mdastExtensions] }) as unknown as TopNode;
	const nodes = tree.children ?? [];
	if (nodes.some(holdsDefinition)) return null;
	const starts: number[] = [];
	for (const node of nodes) {
		const offset = node.position?.start.offset;
		if (offset === undefined) return null;
		const start = base + lineStartOf(tail, offset);
		// A block drawn alone would read a byte order mark at its start as the
		// document's own and skip it; inside the answer it is text, so no cut there.
		if (starts.length === 0) starts.push(base);
		else if (text[start] !== "\uFEFF") starts.push(start);
		if (node.type === "html") break;
	}
	if (starts.length === 0) return [{ raw: tail, start: base }];
	return starts.map((start, i) => ({ raw: text.slice(start, starts[i + 1] ?? text.length), start }));
}

/**
 * A splitter that remembers its last answer, for a text that grows.
 * `mdastExtensions` turn the extra block syntax into nodes, so each such
 * block is a block of its own.
 */
export function createAnswerSplitter(extensions: Extension[] = [], mdastExtensions: MdastExtension[] = []): (text: string) => AnswerBlock[] {
	let lastText = "";
	let lastBlocks: AnswerBlock[] = [];
	return (input) => {
		// Micromark skips a leading byte order mark, so its offsets count from after it.
		const text = input.replace(/^\uFEFF/, "");
		if (text === lastText) return lastBlocks;
		const extending = lastText !== "" && text.startsWith(lastText) && lastBlocks.length > 2;
		const keep = extending ? lastBlocks.slice(0, -2) : [];
		const base = keep.length ? lastBlocks[keep.length].start : 0;
		const rest = splitFrom(text, base, extensions, mdastExtensions);
		const blocks = rest ? [...keep, ...rest] : [{ raw: text, start: 0 }];
		// A text kept whole is one block, so the next text cannot reuse any of it.
		lastText = text;
		lastBlocks = blocks;
		return blocks;
	};
}
