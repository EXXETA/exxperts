// The shape of a room's stable memory, read and measured.
//
// A room's L1b is four top-level sections in a fixed order: Chronos, Deep
// Memory, Active Items, Recent Context. Two of them — Deep Memory and Active
// Items — are the part maintenance may change; the other two are carried
// through untouched. This module is the one place that split is made, and the
// one place the size of a piece of memory is counted.
//
// Nothing here talks to a model, a route or the disk. It reads markdown and
// returns numbers, which is why the Memory tab, the budget bar and the event
// records can all quote the same figure without agreeing on anything else.

import { estimateTokens } from "./token-estimate.js";

const REQUIRED_TOPOLOGY = ["Chronos", "Deep Memory", "Active Items", "Recent Context"] as const;
const REVIEW_TARGET_TOPOLOGY = ["Deep Memory", "Active Items"] as const;

export interface MemorySourceParts {
	preservedChronos: string;
	sourceReviewTargetL1b: string;
	preservedRecentContext: string;
	topLevelSections: string[];
}

export interface MemoryMapRow {
	area: string;
	words: number;
	estimatedTokens: number;
}

export interface MemoryMetrics {
	chars: number;
	bytes: number;
	words: number;
	estimatedTokens: number;
	memoryMap: MemoryMapRow[];
}

function wordCount(text: string): number {
	const matches = text.trim().match(/[\p{L}\p{N}][\p{L}\p{N}'’_-]*/gu);
	return matches?.length ?? 0;
}

function normalizeText(text: string): string {
	return text.trimEnd() + "\n";
}

/**
 * The ONE section-end rule: a block loses its trailing BLANK lines and nothing
 * else — never a trailing space on a real content line. Both splitters cut
 * this way, and the graft that puts Chronos and Recent Context back reads the
 * same rule; a second rule there would fail the byte-equality check on memory
 * the splitter faithfully kept.
 *
 * Written as two scans rather than the regex it used to be
 * (`/(\r?\n\s*)+$/`): that pattern's nested quantifiers made a run of blank
 * lines followed by content cost time exponential in the run's length — a
 * room whose Chronos carried thirty blank lines, as every stamp before 0.12.0
 * left one, took seconds per read and the Memory tab minutes. The rule is the
 * same to the byte: the trailing whitespace run is found from the end, and the
 * cut sits at its first line break (`\n`, or `\r\n` as one), so a trailing
 * space on a content line stays, a lone trailing `\r` stays, and whitespace
 * before that first break is content too. `\s` is the same class the regex
 * read, so every character JavaScript calls whitespace counts.
 */
export function trimSectionTrailingBlankLines(text: string): string {
	let start = text.length;
	while (start > 0 && isWhitespaceCharacter(text[start - 1])) start -= 1;
	for (let at = start; at < text.length; at += 1) {
		if (text[at] === "\n" || (text[at] === "\r" && text[at + 1] === "\n")) return text.slice(0, at);
	}
	return text;
}

/** Whether one character is in the class `\s` names: the regex's own reading of whitespace. */
function isWhitespaceCharacter(character: string): boolean {
	return /\s/.test(character);
}

export function extractTopLevelSectionBlocks(markdown: string): Array<{ title: string; body: string }> {
	const matches = Array.from(markdown.matchAll(/^##\s+(.+?)\s*$/gm));
	return matches.map((match, index) => {
		const start = match.index ?? 0;
		const end = index + 1 < matches.length ? matches[index + 1].index ?? markdown.length : markdown.length;
		return { title: match[1].trim(), body: trimSectionTrailingBlankLines(markdown.slice(start, end)) + "\n" };
	});
}

export function extractMemorySourceParts(l1b: string): MemorySourceParts {
	const normalized = normalizeText(l1b);
	const blocks = extractTopLevelSectionBlocks(normalized);
	const topLevelSections = blocks.map((block) => block.title);
	if (topLevelSections.join("\n") !== REQUIRED_TOPOLOGY.join("\n")) {
		throw new Error(`L1b topology must be exactly: ${REQUIRED_TOPOLOGY.join(" -> ")}`);
	}
	const byTitle = new Map(blocks.map((block) => [block.title, block.body]));
	const preservedChronos = byTitle.get("Chronos") ?? "";
	const deepMemory = byTitle.get("Deep Memory") ?? "";
	const activeItems = byTitle.get("Active Items") ?? "";
	const preservedRecentContext = byTitle.get("Recent Context") ?? "";
	if (!preservedChronos || !deepMemory || !activeItems || !preservedRecentContext) throw new Error("L1b missing mandatory section content");
	return {
		preservedChronos,
		sourceReviewTargetL1b: `${deepMemory.trimEnd()}\n\n${activeItems.trimEnd()}\n`,
		preservedRecentContext,
		topLevelSections,
	};
}

export function sectionWithoutHeading(section: string, heading: string): string {
	return section.replace(new RegExp(`^##\\s+${heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\r?\\n?`, "i"), "");
}

export function immediateSubsectionBlocks(section: string): Array<{ title: string; body: string }> {
	const matches = Array.from(section.matchAll(/^###\s+(.+?)\s*$/gm));
	return matches.map((match, index) => {
		const start = match.index ?? 0;
		const end = index + 1 < matches.length ? matches[index + 1].index ?? section.length : section.length;
		return { title: match[1].trim(), body: trimSectionTrailingBlankLines(section.slice(start, end)) + "\n" };
	});
}

function memoryMapRow(area: string, text: string): MemoryMapRow {
	return { area, words: wordCount(text), estimatedTokens: estimateTokens(text) };
}

/** One row per changeable topic: the two sections, then each of their subsections. */
export function buildMemoryMap(reviewTargetL1b: string): MemoryMapRow[] {
	const blocks = extractTopLevelSectionBlocks(reviewTargetL1b);
	const rows: MemoryMapRow[] = [];
	for (const block of blocks) {
		if (!REVIEW_TARGET_TOPOLOGY.includes(block.title as (typeof REVIEW_TARGET_TOPOLOGY)[number])) continue;
		rows.push(memoryMapRow(block.title, sectionWithoutHeading(block.body, block.title)));
		for (const subsection of immediateSubsectionBlocks(block.body)) {
			rows.push(memoryMapRow(`${block.title} / ${subsection.title}`, subsection.body));
		}
	}
	return rows;
}

export function memoryMetrics(text: string): MemoryMetrics {
	const normalized = normalizeText(text);
	return {
		chars: normalized.length,
		bytes: Buffer.byteLength(normalized, "utf-8"),
		words: wordCount(normalized),
		estimatedTokens: estimateTokens(normalized),
		memoryMap: buildMemoryMap(normalized),
	};
}
