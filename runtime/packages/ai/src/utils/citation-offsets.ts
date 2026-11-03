import type { SourceLink, TextCitation, TextContent } from "../types.js";

/** How a provider counts the offsets it puts on a text. */
export type OffsetUnit = "utf16" | "codepoint" | "utf8";

/**
 * The UTF-16 index (a JavaScript string index) of a provider's offset into
 * `text`, clamped to the text. A code point or byte offset that falls inside
 * a character moves to the end of that character.
 */
export function toUtf16(text: string, index: number, unit: OffsetUnit): number {
	if (!(index > 0)) return 0;
	if (unit === "utf16") return Math.min(Math.floor(index), text.length);
	let counted = 0;
	let i = 0;
	while (i < text.length && counted < index) {
		const code = text.codePointAt(i)!;
		counted += unit === "codepoint" ? 1 : code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
		i += code > 0xffff ? 2 : 1;
	}
	return i;
}

// The marker characters, removed by the same rules as stripCitationMarkers in
// citation-markers.ts: the two change together.
const MARKER_START = 0xe200;
const MARKER_END = 0xe201;
const MARKER_SEP = 0xe202;

/**
 * Where position `i` of the raw text lands once stripCitationMarkers has
 * stripped the whole of it. A position inside a marker lands at its start.
 */
export function strippedIndex(raw: string, i: number): number {
	let kept = 0;
	let at = 0;
	while (at < i && at < raw.length) {
		const code = raw.charCodeAt(at);
		if (code === MARKER_START) {
			// A start with no close is a stray: only the character goes.
			const end = raw.indexOf(String.fromCharCode(MARKER_END), at + 1);
			at = end === -1 ? at + 1 : end + 1;
		} else {
			if (code !== MARKER_END && code !== MARKER_SEP) kept++;
			at++;
		}
	}
	return kept;
}

/** A link a person can open. The other kinds point into documents we never sent. */
export function webLink(url: unknown, title: unknown): SourceLink | undefined {
	if (typeof url !== "string") return undefined;
	try {
		const { protocol } = new URL(url);
		if (protocol !== "http:" && protocol !== "https:") return undefined;
	} catch {
		return undefined;
	}
	return typeof title === "string" && title.length > 0 ? { url, title } : { url };
}

function isOffset(value: unknown): value is number {
	return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

/** A citation as the provider sent it: offsets in its own unit, counted in one part of the raw text. */
export interface SentCitation {
	link: SourceLink;
	part: number;
	start?: unknown;
	end?: unknown;
}

/**
 * The places of a text block's citations, worked out on its raw parts as they
 * stand now (markers included), so a citation sent before its text, or a
 * stream cut short, still lands right. `text` is the block's text and bounds
 * every place. A citation without a usable end, or for a part that never
 * came, is a source of the whole answer. Each page is kept once per end, and
 * each source once.
 */
export function placeCitations(sent: SentCitation[], rawParts: string[], text: string, unit: OffsetUnit): { citations: TextCitation[]; sources: SourceLink[] } {
	const raw = rawParts.join("");
	const citations: TextCitation[] = [];
	const sources: SourceLink[] = [];
	for (const { link, part, start, end } of sent) {
		const partText = rawParts[part];
		if (partText === undefined || !isOffset(end)) {
			if (!sources.some((known) => known.url === link.url)) sources.push(link);
			continue;
		}
		const base = rawParts.slice(0, part).join("").length;
		const at = (index: number) => Math.min(text.length, strippedIndex(raw, base + toUtf16(partText, index, unit)));
		const citation: TextCitation = { ...link, ...(isOffset(start) ? { start: at(start) } : {}), end: at(end) };
		if (!citations.some((known) => known.url === citation.url && known.end === citation.end)) citations.push(citation);
	}
	return { citations, sources };
}

/** Adds a citation unless the block already has the same page ending at the same place. */
export function addCitation(block: TextContent, citation: TextCitation): void {
	const citations = (block.citations ??= []);
	if (!citations.some((known) => known.url === citation.url && known.end === citation.end)) citations.push(citation);
}
