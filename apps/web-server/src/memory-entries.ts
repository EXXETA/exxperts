// The memory entry model: `L1b/current.md` into addressable entries and back, pure (no model, route or filesystem).
// Lines split at the terminators the splitters in memory-shape.ts break on; a document this module rendered round-trips byte for byte.

import type { MemoryUse } from "./memory-use.js";
import { estimateTokens, estimateTokensFromChars } from "./token-estimate.js";

export type EntryKind = "event" | "fact" | "practice" | "item";
export type ItemStatus = "open" | "done";
export type MemorySection = "Deep Memory" | "Active Items";

export const ENTRY_KINDS: readonly EntryKind[] = ["event", "fact", "practice", "item"];
export const MEMORY_SECTIONS: readonly MemorySection[] = ["Deep Memory", "Active Items"];
/** The title of the implicit Deep Memory topic: prose that sits under no `### heading`. */
export const MEMORY_GENERAL_TOPIC = "General";
/** The title of the implicit Active Items topic: the section's own bullet list. */
export const MEMORY_ACTIVE_ITEMS_TOPIC = "Active Items";

export interface MemoryEntry {
	/** "m-0031"; unique within the room. Empty until migration assigns one. */
	id: string;
	kind: EntryKind;
	/** YYYY-MM-DD, the day the material was saved into memory. */
	saved: string;
	/** Originating Recent Context id, e.g. "RC-0007". */
	from?: string;
	pinned: boolean;
	status?: ItemStatus;
	/** YYYY-MM-DD the note was last touched: a fold's update, supersede or close, a Replace, a hand edit, or a Review close. */
	updated?: string;
	/** YYYY-MM-DD the room learned what the text says: the day of the conversation that wrote it (from its page's heading) or of a hand edit, the newest of the notes' days after a Replace or a Review merge; never guessed. */
	learned?: string;
	/** Comma-separated ids of notes the person kept beside this one though they may disagree: only a Memorize save writes it, on both; a fold's rewrite keeps the ids it still disagrees with, and any other rewrite of the text, or a restore, drops it. */
	disagrees?: string;
	/** Times a fold's update, supersede or close touched it, or a Replace confirmed it; a ranking input. Recalls are counted apart, in memory-use.ts. */
	refs?: number;
	/** The note is a conversation's approved summary, filed whole because the fold gave nothing usable; stored as `summary=true`. */
	summary?: true;
	/** Memory models that already re-read this summary note (as rereadModelKey writes them), stored as `tried=`; a listed model never re-reads it. */
	tried?: string[];
	/** Metadata keys this version does not write itself, in file order: carried through every rewrite, so a field it does not know is never lost. */
	extra?: Record<string, string>;
	/** The entry's markdown lines exactly, without its metadata comment. */
	text: string;
}

export interface MemoryTopic {
	section: MemorySection;
	/** "General" for Deep Memory prose under no heading; the Active Items list is one topic titled "Active Items". */
	title: string;
	/** The exact "### Title" line, null for implicit topics. */
	heading: string | null;
	/** Always empty from the parser, which reads prose before the first entry as notes without an id. */
	intro: string;
	entries: MemoryEntry[];
}

export interface MemoryOtherSection {
	title: string;
	/** The whole section, verbatim, heading line included. */
	text: string;
	/** Its position among the source's top-level sections, so render puts it back in place. */
	index: number;
}

export interface MemoryDocument {
	/** Everything before the first top-level section (the schema comment line), verbatim. */
	preamble: string;
	/** The whole "## Chronos" section, verbatim. */
	chronos: string;
	/** Deep Memory topics in order, then the Active Items topics. */
	topics: MemoryTopic[];
	/** The whole "## Recent Context" section, verbatim, untouched by this module. */
	recentContext: string;
	otherSections: MemoryOtherSection[];
	/** The id counter, stored in the file as `<!-- entries: next=32 -->` under the Deep Memory heading. */
	nextEntryNumber: number;
}

/**
 * Why an entry left the core: "budget" demotion, "superseded" by its newer version, a "done" item, a "user"
 * deletion, Review's "stale" and "duplicate", "history" an older value kept (never restored), "sorted" a summary note a re-read sorted.
 */
export const ARCHIVE_REASONS = ["budget", "superseded", "done", "user", "stale", "duplicate", "history", "sorted"] as const;

export type ArchiveReason = (typeof ARCHIVE_REASONS)[number];

export interface ArchivedEntry extends MemoryEntry {
	/** YYYY-MM-DD the entry left the core. */
	archived: string;
	why: ArchiveReason;
	/** YYYY-MM-DD the text stopped holding: the day a newer text that replaced it was learned. Archive rows only; a restore never brings it back. */
	until?: string;
	/** The topic it was taken from, so a restore knows where it belongs. */
	topic: string;
	section: MemorySection;
}

export interface ArchiveTopicIndexRow {
	section: MemorySection;
	topic: string;
	count: number;
	/** YYYY-MM of the oldest archived entry of this topic. */
	earliest: string;
	/** YYYY-MM of the newest. */
	latest: string;
}

/** Per-topic archive counts, keyed by the "Section / Topic" address. */
export type ArchiveIndex = Record<string, ArchiveTopicIndexRow>;

export function memoryAreaId(section: MemorySection, topic: string): string {
	return `${section} / ${topic}`;
}

/** The topic address the run cards send back when a person protects a topic; both engines and the browser use this shape. */
export function memoryTopicAddress(section: MemorySection, topic: string): string {
	return `${section}/${topic}`;
}

export function memoryTopicAddressKey(address: string): string {
	return address.trim().toLowerCase();
}

const LINE_TERMINATOR = /\r\n|[\n\r\u2028\u2029]/;
const LINE_TERMINATORS_G = /\r\n|[\n\r\u2028\u2029]/g;

function splitLines(text: string): string[] {
	return text.split(LINE_TERMINATORS_G);
}

function firstEol(text: string): string | null {
	return LINE_TERMINATOR.exec(text)?.[0] ?? null;
}

function isBlank(line: string): boolean {
	return !line.trim();
}

function stripBlankEdges(lines: string[]): string[] {
	const out = [...lines];
	while (out.length > 0 && isBlank(out[0])) out.shift();
	while (out.length > 0 && isBlank(out[out.length - 1])) out.pop();
	return out;
}

/** The document's one line ending: the first in its own text, verbatim regions first (those bytes are not ours); "\n" if none. */
export function memoryDocumentEol(doc: MemoryDocument): string {
	const sources = [doc.preamble, doc.chronos, doc.recentContext, ...doc.otherSections.map((s) => s.text)];
	for (const topic of doc.topics) {
		sources.push(topic.heading ?? "", topic.intro);
		for (const entry of topic.entries) sources.push(entry.text);
	}
	for (const source of sources) {
		const eol = firstEol(source);
		if (eol) return eol;
	}
	return "\n";
}

const MUST_KEEP_MARKER = /\*\*must-keep\b/i;
/** A code span, whose words are quoted, never a marker: `x` and ``x``. */
const CODE_SPAN = /(`+)[^`\r\n]*?\1/g;

/** Whether the text carries the must-keep marker outside a code span. */
export function hasMustKeepMarker(text: string): boolean {
	return MUST_KEEP_MARKER.test(text.replace(CODE_SPAN, ""));
}

function withoutMarkersIn(plain: string): string {
	return plain
		// "**must-keep - words**" keeps its words, bold.
		.replace(/\*\*must-keep[ \t]*[\u2014\u2013-][ \t]*(?=[^*\r\n]*\*\*)/gi, "**")
		// A label that ends the sentence takes the space before it along.
		.replace(/[ \t]*\*\*must-keep:?\*\*:?(?=[ \t]*(?:[.,;!?)]|$))/gi, "")
		// A label that opens the words goes with the space and any dash after it.
		.replace(/\*\*must-keep:?\*\*:?[ \t]*(?:[\u2014\u2013-][ \t]+)?/gi, "")
		.replace(/\*\*must-keep\b:?[ \t]*(?:[\u2014\u2013-][ \t]+)?/gi, "");
}

/**
 * The text without its must-keep labels, since the pin now keeps the note. Only lines that held a marker
 * change; a marker in a code span stays, and a text left with no words keeps its marker.
 */
export function withoutMustKeepMarkers(text: string): string {
	const stripped = stripMustKeepMarkers(text);
	return hasWords(stripped) ? stripped : text;
}

/** Whether a text says anything beyond its must-keep markers and list marks. */
export function saysMoreThanMustKeep(text: string): boolean {
	return hasWords(stripMustKeepMarkers(text));
}

function hasWords(text: string): boolean {
	return /[\p{L}\p{N}]/u.test(text.replace(/^\s*(?:[-*+]|\d+[.)])\s*/gm, ""));
}

function stripMustKeepMarkers(text: string): string {
	const parts = text.split(/(\r\n|\n|\r|\u2028|\u2029)/);
	for (let i = 0; i < parts.length; i += 2) {
		const line = parts[i];
		if (!hasMustKeepMarker(line)) continue;
		let out = "";
		let last = 0;
		for (const span of line.matchAll(CODE_SPAN)) {
			out += withoutMarkersIn(line.slice(last, span.index)) + span[0];
			last = span.index! + span[0].length;
		}
		parts[i] = (out + withoutMarkersIn(line.slice(last))).replace(/[ \t]+$/, "");
	}
	return parts.join("");
}
const BULLET_LINE = /^(\s*)(?:[-*+]|\d+[.)])\s/;
const TOP_LEVEL_HEADING = /^##\s+(.+?)\s*$/;
const SUBSECTION_HEADING = /^###\s+(.+?)\s*$/;
/** The boundary the splitters in memory-shape.ts cut at: two or three hashes at column 0. */
const SPLITTER_HEADING_LINE = /^#{2,3}(?:\s|$)/;
const ENTRY_META_LINE = /^[ \t]*<!--\s*e:\s*([\s\S]*?)\s*-->[ \t]*$/;
const ENTRY_COUNTER_LINE = /^[ \t]*<!--\s*entries:\s*next=(\d+)\s*-->[ \t]*$/;
const SAVED_STAMP = /\(saved ([^)]*)\)/g;
const ISO_DATE = /(?<!\d)\d{4}-\d{2}-\d{2}(?!\d)/g;

export function savedStampDatesIn(text: string): string[] {
	return Array.from(text.matchAll(SAVED_STAMP)).flatMap((m) => m[1].match(ISO_DATE) ?? []);
}

function indentOf(line: string): number {
	const bullet = BULLET_LINE.exec(line);
	return bullet ? bullet[1].length : line.length - line.trimStart().length;
}

/** A field starts the line or follows whitespace, so `learned-at=x` is one key, never `at`. */
const META_FIELD = /(?:^|\s)([A-Za-z_][A-Za-z0-9_.-]*)=(?:"((?:[^"\\]|\\.)*)"|(\S*))/g;

function parseMetaFields(raw: string): Record<string, string> {
	const out: Record<string, string> = {};
	for (const m of raw.matchAll(META_FIELD)) {
		out[m[1]] = m[2] !== undefined ? m[2].replace(/\\(["\\])/g, "$1") : (m[3] ?? "");
	}
	return out;
}

function metaValue(value: string): string {
	// A value never carries a comment closer: "-- >" keeps the metadata comment well-formed.
	const safe = value.replace(/-->/g, "-- >");
	return /[\s"\\]/.test(safe) ? `"${safe.replace(/(["\\])/g, "\\$1")}"` : safe;
}

function entryMetaFields(entry: MemoryEntry): string[] {
	const fields = [`id=${entry.id}`, `kind=${entry.kind}`, `saved=${entry.saved}`];
	if (entry.from) fields.push(`from=${entry.from}`);
	if (entry.pinned) fields.push("pinned=true");
	if (entry.status) fields.push(`status=${entry.status}`);
	if (entry.updated) fields.push(`updated=${entry.updated}`);
	if (entry.learned) fields.push(`learned=${entry.learned}`);
	if (entry.disagrees) fields.push(`disagrees=${entry.disagrees}`);
	if (entry.refs !== undefined) fields.push(`refs=${entry.refs}`);
	// Known keys first, then unknown ones in read order: parsing is order-free, so a newer version's key is moved, never lost.
	if (entry.summary) fields.push("summary=true");
	if (entry.tried && entry.tried.length > 0) fields.push(`tried=${metaValue(entry.tried.join(","))}`);
	// An untrusted value kept as written gives way to a real one, so no key is written twice.
	const written = (key: string) => (key === "learned" && entry.learned) || (key === "disagrees" && entry.disagrees) || (key === "until" && (entry as Partial<ArchivedEntry>).until);
	for (const [key, value] of Object.entries(entry.extra ?? {})) if (!written(key)) fields.push(`${key}=${metaValue(value)}`);
	return fields;
}

/** The storage metadata line of an entry, or null for an entry that has no id yet. */
export function entryMetadataLine(entry: MemoryEntry): string | null {
	if (!entry.id) return null;
	return `<!-- e: ${entryMetaFields(entry).join(" ")} -->`;
}

function archivedMetadataLine(entry: ArchivedEntry): string {
	const fields = [...entryMetaFields(entry), `archived=${entry.archived}`, `why=${entry.why}`, ...(entry.until ? [`until=${entry.until}`] : []), `topic=${metaValue(entry.topic)}`, `section=${metaValue(entry.section)}`];
	return `<!-- e: ${fields.join(" ")} -->`;
}

/** The keys an entry's or an archive row's metadata line is written with here; every other key is the entry's `extra`. */
const OWN_META_KEYS = new Set(["id", "kind", "saved", "from", "pinned", "status", "updated", "learned", "disagrees", "refs", "summary", "tried", "archived", "why", "until", "topic", "section"]);

export const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

/** The ids a `disagrees` key holds: entry ids, comma-separated; anything else is kept as written and trusted by nothing. */
const PAIR_IDS = /^[A-Za-z][\w-]*(?:,[A-Za-z][\w-]*)*$/;

function entryFromMeta(fields: Record<string, string>, text: string): MemoryEntry {
	const kind = (ENTRY_KINDS as readonly string[]).includes(fields.kind) ? (fields.kind as EntryKind) : "fact";
	const refs = Number(fields.refs);
	const entry: MemoryEntry = { id: fields.id ?? "", kind, saved: fields.saved ?? "", pinned: fields.pinned === "true", text };
	if (fields.from) entry.from = fields.from;
	if (fields.status === "open" || fields.status === "done") entry.status = fields.status;
	if (fields.updated) entry.updated = fields.updated;
	if (fields.learned && ISO_DAY.test(fields.learned)) entry.learned = fields.learned;
	if (fields.disagrees && PAIR_IDS.test(fields.disagrees)) entry.disagrees = fields.disagrees;
	if (fields.refs !== undefined && Number.isFinite(refs)) entry.refs = refs;
	if (fields.summary === "true") entry.summary = true;
	const tried = (fields.tried ?? "").split(",").map((model) => model.trim()).filter(Boolean);
	if (tried.length > 0) entry.tried = tried;
	// A learned that is no day is kept as written, and trusted by nothing. An
	// until belongs to archive rows, which read it themselves.
	const extra = Object.entries(fields).filter(([key]) => !OWN_META_KEYS.has(key) || (key === "learned" && !entry.learned) || (key === "disagrees" && !entry.disagrees));
	if (extra.length > 0) entry.extra = Object.fromEntries(extra);
	return entry;
}

interface RawSection {
	title: string;
	/** The whole section, verbatim, heading line included. */
	text: string;
	index: number;
}

function splitTopLevelSections(l1b: string): { preamble: string; sections: RawSection[] } {
	const matches = Array.from(l1b.matchAll(/^##\s+(.+?)\s*$/gm));
	if (matches.length === 0) return { preamble: l1b, sections: [] };
	const preamble = l1b.slice(0, matches[0].index ?? 0);
	const sections = matches.map((match, i) => {
		const start = match.index ?? 0;
		const end = i + 1 < matches.length ? (matches[i + 1].index ?? l1b.length) : l1b.length;
		return { title: match[1].trim(), text: l1b.slice(start, end), index: i };
	});
	return { preamble, sections };
}

function splitUnmarkedBlocks(lines: string[]): string[][] {
	const blocks: string[][] = [];
	let i = 0;
	while (i < lines.length) {
		if (isBlank(lines[i])) { i++; continue; }
		const start = i;
		const bullet = BULLET_LINE.exec(lines[i]);
		if (bullet) {
			const indent = bullet[1].length;
			i++;
			while (i < lines.length) {
				const line = lines[i];
				if (SPLITTER_HEADING_LINE.test(line)) break;
				if (isBlank(line)) {
					const next = lines.slice(i + 1).find((l) => !isBlank(l));
					if (next === undefined || SPLITTER_HEADING_LINE.test(next) || indentOf(next) <= indent) break;
					i++;
					continue;
				}
				const own = BULLET_LINE.exec(line);
				if (own && own[1].length <= indent) break;
				i++;
			}
		} else {
			i++;
			while (i < lines.length && !isBlank(lines[i]) && !BULLET_LINE.test(lines[i]) && !SPLITTER_HEADING_LINE.test(lines[i])) i++;
		}
		blocks.push(stripBlankEdges(lines.slice(start, i)));
	}
	return blocks.filter((block) => block.length > 0);
}

function parseTopicBody(bodyLines: string[], eol: string): { intro: string; entries: MemoryEntry[] } {
	const metaIndexes: number[] = [];
	for (let i = 0; i < bodyLines.length; i++) if (ENTRY_META_LINE.test(bodyLines[i])) metaIndexes.push(i);
	if (metaIndexes.length === 0) {
		return {
			intro: "",
			entries: splitUnmarkedBlocks(stripBlankEdges(bodyLines)).map((block) => ({ id: "", kind: "fact" as EntryKind, saved: "", pinned: false, text: block.join(eol) })),
		};
	}
	// Lines above the first marker are notes without an id, since the room reads them; the next write gives them one.
	const unmarked = splitUnmarkedBlocks(stripBlankEdges(bodyLines.slice(0, metaIndexes[0]))).map((block) => ({ id: "", kind: "fact" as EntryKind, saved: "", pinned: false, text: block.join(eol) }));
	const entries = metaIndexes.map((at, n) => {
		const end = n + 1 < metaIndexes.length ? metaIndexes[n + 1] : bodyLines.length;
		const fields = parseMetaFields(ENTRY_META_LINE.exec(bodyLines[at])![1]);
		return entryFromMeta(fields, stripBlankEdges(bodyLines.slice(at + 1, end)).join(eol));
	});
	return { intro: "", entries: [...unmarked, ...entries] };
}

function parseSectionTopics(sectionText: string, section: MemorySection, eol: string): { topics: MemoryTopic[]; nextEntryNumber: number | null } {
	const lines = splitLines(sectionText);
	const body = lines.slice(1);
	let nextEntryNumber: number | null = null;
	const kept: string[] = [];
	for (const line of body) {
		const counter = ENTRY_COUNTER_LINE.exec(line);
		if (counter && nextEntryNumber === null) { nextEntryNumber = Number(counter[1]); continue; }
		kept.push(line);
	}
	const headingIndexes: number[] = [];
	for (let i = 0; i < kept.length; i++) if (SUBSECTION_HEADING.test(kept[i])) headingIndexes.push(i);
	const topics: MemoryTopic[] = [];
	const leading = kept.slice(0, headingIndexes.length > 0 ? headingIndexes[0] : kept.length);
	const implicitTitle = section === "Active Items" ? MEMORY_ACTIVE_ITEMS_TOPIC : MEMORY_GENERAL_TOPIC;
	const leadingBody = parseTopicBody(leading, eol);
	// Active Items always keeps its implicit topic (it is where an item goes);
	// Deep Memory only gets one when prose actually sits above the first heading.
	if (section === "Active Items" || leadingBody.intro || leadingBody.entries.length > 0) {
		topics.push({ section, title: implicitTitle, heading: null, intro: leadingBody.intro, entries: leadingBody.entries });
	}
	headingIndexes.forEach((at, n) => {
		const end = n + 1 < headingIndexes.length ? headingIndexes[n + 1] : kept.length;
		const title = SUBSECTION_HEADING.exec(kept[at])![1];
		const body = parseTopicBody(kept.slice(at + 1, end), eol);
		topics.push({ section, title, heading: `### ${title}`, intro: body.intro, entries: body.entries });
	});
	return { topics, nextEntryNumber };
}

/**
 * Reads `L1b/current.md` into the entry model; a never-migrated file parses with empty ids. Without its counter
 * line, the counter is one past the highest id, so an add never mints an id the file already has.
 */
export function parseMemoryDocument(l1b: string): MemoryDocument {
	const eol = firstEol(l1b) ?? "\n";
	const { preamble, sections } = splitTopLevelSections(l1b);
	let chronos = "";
	let recentContext = "";
	let deep: RawSection | null = null;
	let active: RawSection | null = null;
	const otherSections: MemoryOtherSection[] = [];
	for (const section of sections) {
		if (section.title === "Chronos" && !chronos) { chronos = section.text; continue; }
		if (section.title === "Recent Context" && !recentContext) { recentContext = section.text; continue; }
		if (section.title === "Deep Memory" && !deep) { deep = section; continue; }
		if (section.title === "Active Items" && !active) { active = section; continue; }
		otherSections.push({ title: section.title, text: section.text, index: section.index });
	}
	const deepParsed = deep ? parseSectionTopics(deep.text, "Deep Memory", eol) : { topics: [], nextEntryNumber: null };
	const activeParsed = active ? parseSectionTopics(active.text, "Active Items", eol) : { topics: [], nextEntryNumber: null };
	const topics = [...deepParsed.topics, ...activeParsed.topics];
	return {
		preamble,
		chronos,
		topics,
		recentContext,
		otherSections,
		nextEntryNumber: deepParsed.nextEntryNumber ?? highestEntryNumber(topics.flatMap((topic) => topic.entries.map((entry) => entry.id))) + 1,
	};
}

/** The first Deep Memory section's entries, text left empty, read without building the document: the room status reads this on every refresh. */
export function scanDeepMemoryEntries(l1b: string): Array<{ topic: string; entry: MemoryEntry }> {
	const out: Array<{ topic: string; entry: MemoryEntry }> = [];
	let seen = false;
	let inDeep = false;
	let topic = MEMORY_GENERAL_TOPIC;
	for (const line of splitLines(l1b)) {
		const top = TOP_LEVEL_HEADING.exec(line);
		if (top) { inDeep = !seen && top[1].trim() === "Deep Memory"; seen ||= inDeep; topic = MEMORY_GENERAL_TOPIC; continue; }
		if (!inDeep) continue;
		const sub = SUBSECTION_HEADING.exec(line);
		if (sub) { topic = sub[1]; continue; }
		const meta = ENTRY_META_LINE.exec(line);
		if (meta) out.push({ topic, entry: entryFromMeta(parseMetaFields(meta[1]), "") });
	}
	return out;
}

function entryNumber(id: string): number | null {
	const m = /^m-(\d+)$/.exec(id);
	return m ? Number(m[1]) : null;
}

export function formatEntryId(n: number): string {
	return `m-${String(n).padStart(4, "0")}`;
}

/** The version suffix an archived older text carries: `m-0031-v1`, then `-v2`. */
const VERSIONED_ENTRY_ID = /^(.*)-v(\d+)$/;

/** The entry an id names: `m-0031-v1` is an older text of `m-0031`; an id without a version suffix is its own base. */
export function entryBaseId(id: string): string {
	return VERSIONED_ENTRY_ID.exec(id)?.[1] ?? id;
}

/** The highest entry number among these ids, versions counted under their base (`m-0031-v2` is 31); 0 if none. */
export function highestEntryNumber(ids: Iterable<string>): number {
	let highest = 0;
	for (const id of ids) {
		const n = entryNumber(entryBaseId(id));
		if (n !== null && n > highest) highest = n;
	}
	return highest;
}

/**
 * The archive id for an entry's older text: its own id plus the next `-vN` free in `taken`, since a restore looks
 * rows up by id. Memorize and Review both mint it this way.
 */
export function nextVersionedEntryId(id: string, taken: Iterable<string>): string {
	let highest = 0;
	for (const existing of taken) {
		const match = VERSIONED_ENTRY_ID.exec(existing);
		if (match && match[1] === id) highest = Math.max(highest, Number(match[2]));
	}
	return `${id}-v${highest + 1}`;
}

/**
 * At migration only, a Deep Memory note is a practice when its topic title or its first line matches these
 * (English and German). Word edges are Unicode lookarounds, because `\b` knows only ASCII letters and breaks on umlauts.
 */
export const MIGRATION_PRACTICE_TITLE_RULE = /(?<![\p{L}\p{N}])(working style|working-style|preferences?|practices?|conventions?|guidelines?|rules?|how (we|i|to) work|style guide|ways of working|arbeitsweise|vorgehen|regeln|präferenzen|konventionen|richtlinien|zusammenarbeit|gewohnheiten|so arbeiten wir)(?![\p{L}\p{N}])/iu;
export const MIGRATION_PRACTICE_TEXT_RULE = /^(always|never|prefer|avoid|do not|don't|use|ask before|keep|immer|nie|niemals|bitte stets|bitte immer|wir halten es so|grundsätzlich|stets|vermeide|verwende|nutze|frage? vorher|keine)(?![\p{L}\p{N}])|^(when|whenever|before|after) /iu;

function migratedDeepMemoryKind(topicTitle: string, text: string): EntryKind {
	if (MIGRATION_PRACTICE_TITLE_RULE.test(topicTitle)) return "practice";
	const first = splitLines(text).find((line) => !isBlank(line)) ?? "";
	return MIGRATION_PRACTICE_TEXT_RULE.test(first.replace(BULLET_PREFIX, "").trimStart()) ? "practice" : "fact";
}

/**
 * At migration only, an unmarked note in the heading-less first Deep Memory topic that matches these is the
 * scaffold's template paragraph, not the room's words, and is dropped. A note with an id is never touched.
 */
export const MIGRATION_TEMPLATE_OPENING_RULE = /^\s*Durable understanding/;
export const MIGRATION_TEMPLATE_TEXT_RULE = /saved-on stamp/i;

function isMigrationTemplateParagraph(text: string): boolean {
	return MIGRATION_TEMPLATE_OPENING_RULE.test(text) || MIGRATION_TEMPLATE_TEXT_RULE.test(text);
}

/** A "(saved …)" stamp with the space before it, when there is one: "x (saved …)." reads "x." afterwards, not "x .". */
const SAVED_STAMP_WITH_LEADING_SPACE = / ?\(saved [^)]*\)/g;
/** `SAVED_STAMP` without the global flag: a `test` that never carries a lastIndex between calls. */
const HAS_SAVED_STAMP = /\(saved [^)]*\)/;

/**
 * The text without its "(saved …)" stamps, once migration has moved the date into metadata. Only lines that held
 * a stamp change; a text the removal would empty comes back as it was, so this step never deletes an entry.
 */
function withoutSavedStamps(text: string, eol: string): string {
	if (!HAS_SAVED_STAMP.test(text)) return text;
	const lines = splitLines(text).flatMap((line) => {
		if (!HAS_SAVED_STAMP.test(line)) return [line];
		const indent = /^[ \t]*/.exec(line)![0];
		const body = line.slice(indent.length).replace(SAVED_STAMP_WITH_LEADING_SPACE, "").replace(/ {2,}/g, " ").replace(/[ \t]+$/, "");
		return body ? [indent + body] : [];
	});
	return lines.length > 0 ? lines.join(eol) : text;
}

/**
 * Gives every entry without an id an id, a kind, a saved-on date (its stamp, else `fallbackSaved`) and a pin when
 * marked must-keep, and drops the scaffold's template paragraph. Idempotent: an entry with an id is never touched.
 */
export function migrateMemoryDocument(doc: MemoryDocument, opts: { fallbackSaved: string }): { doc: MemoryDocument; assigned: number } {
	const next = cloneDocument(doc);
	const eol = memoryDocumentEol(next);
	const leading = next.topics.find((t) => t.section === "Deep Memory");
	if (leading && leading.heading === null) {
		leading.entries = leading.entries.filter((entry) => entry.id || !isMigrationTemplateParagraph(entry.text));
		if (leading.entries.length === 0 && isBlank(leading.intro)) next.topics.splice(next.topics.indexOf(leading), 1);
	}
	const deepTopics = next.topics.filter((t) => t.section === "Deep Memory");
	if (deepTopics.length === 1 && deepTopics[0].heading === null) deepTopics[0].heading = `### ${deepTopics[0].title}`;
	let counter = next.nextEntryNumber;
	for (const topic of next.topics) for (const entry of topic.entries) {
		const n = entryNumber(entry.id);
		if (n !== null && n >= counter) counter = n + 1;
	}
	let assigned = 0;
	for (const topic of next.topics) {
		for (const entry of topic.entries) {
			if (entry.id) continue;
			entry.id = formatEntryId(counter++);
			assigned++;
			// The date first, the stamp second: the stamp is the date's only source.
			if (!entry.saved) entry.saved = savedStampDatesIn(entry.text)[0] ?? opts.fallbackSaved;
			entry.text = withoutSavedStamps(entry.text, eol);
			if (topic.section === "Active Items") {
				entry.kind = "item";
				if (!entry.status) entry.status = "open";
			} else {
				entry.kind = migratedDeepMemoryKind(topic.title, entry.text);
			}
			if (MUST_KEEP_MARKER.test(entry.text)) entry.pinned = true;
		}
	}
	next.nextEntryNumber = counter;
	return { doc: next, assigned };
}

export type MemoryRenderMode = "storage" | "context";

export interface MemoryRenderOptions {
	/** Per-topic archive counts, rendered as one pointer line per topic that has them. */
	archiveIndex?: ArchiveIndex;
	/** Context render only: each entry's id in its first line, `- [m-0031] …` or `- [m-0032 · pinned] …`. */
	entryIds?: boolean;
	/** Room read only: a note of a mutual disagree pair ends its first line with "(learned YYYY-MM-DD)" when the day is known. */
	pairDays?: boolean;
	/** Only these sections, in canonical order, and nothing else: Memorize, Review and the notes view read a memory this way. */
	sections?: readonly MemorySection[];
}

/** The bullet a line opens with, marker and its spacing included — where an inline id goes. */
const BULLET_PREFIX = /^\s*(?:[-*+]|\d+[.)])\s+/;

// The id travels on the entry's first line, not in a list beside it: a list of 800 rows costs more than the memory.
function withInlineEntryId(entry: MemoryEntry, eol: string): string {
	if (!entry.id) return entry.text;
	const lines = splitLines(entry.text);
	const at = lines.findIndex((line) => !isBlank(line));
	if (at < 0) return entry.text;
	const prefix = BULLET_PREFIX.exec(lines[at])?.[0] ?? /^\s*/.exec(lines[at])![0];
	lines[at] = `${prefix}[${entry.id}${entry.pinned ? " · pinned" : ""}] ${lines[at].slice(prefix.length)}`;
	return lines.join(eol);
}

const ARCHIVE_MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;

function archiveMonthLabel(month: string): string {
	const parts = /^(\d{4})-(\d{2})$/.exec(String(month ?? "").slice(0, 7));
	if (!parts) return "";
	const name = ARCHIVE_MONTH_NAMES[Number(parts[2]) - 1];
	return name ? `${name} ${parts[1]}` : "";
}

/** "May 2026", "Mar to Jul 2026", or both years across new year; an unreadable stamp drops the clause. */
function archiveMonthRange(earliest: string, latest: string): string {
	const from = archiveMonthLabel(earliest);
	const to = archiveMonthLabel(latest);
	if (!from || !to) return from || to;
	if (from === to) return from;
	const sameYear = from.slice(-4) === to.slice(-4);
	return sameYear ? `${from.slice(0, 3)} to ${to}` : `${from} to ${to}`;
}

/** The line every demoted topic carries in context, naming memory_recall, so demotion is disclosure, not forgetting. */
function archivePointerLine(row: ArchiveTopicIndexRow): string {
	const months = archiveMonthRange(row.earliest, row.latest);
	const noun = `${row.count} older ${row.count === 1 ? "note" : "notes"}`;
	return `_Archived: ${noun}${months ? ` from ${months}` : ""}; use memory_recall to read them._`;
}

/** The day a kept pair's note shows in the room's read, or none: both notes still there and naming each other, and this one's day known. */
function pairDayOf(entry: MemoryEntry, byId: Map<string, MemoryEntry>): string | undefined {
	if (!entry.disagrees || !entry.learned) return undefined;
	const mutual = entry.disagrees.split(",").some((id) => byId.get(id)?.disagrees?.split(",").includes(entry.id));
	return mutual ? entry.learned : undefined;
}

function withPairDay(text: string, day: string, eol: string): string {
	const lines = splitLines(text);
	const at = lines.findIndex((line) => !isBlank(line));
	if (at < 0) return text;
	lines[at] = `${lines[at].replace(/\s+$/, "")} (learned ${day})`;
	return lines.join(eol);
}

function renderSection(doc: MemoryDocument, section: MemorySection, mode: MemoryRenderMode, eol: string, opts?: MemoryRenderOptions): string {
	const inlineIds = mode === "context" && opts?.entryIds === true;
	const byId = mode === "context" && opts?.pairDays ? new Map(doc.topics.flatMap((topic) => topic.entries).map((entry) => [entry.id, entry])) : undefined;
	const out: string[] = [`## ${section}`, ""];
	if (section === "Deep Memory" && mode === "storage") out.push(`<!-- entries: next=${doc.nextEntryNumber} -->`, "");
	for (const topic of doc.topics) {
		if (topic.section !== section) continue;
		if (topic.heading) out.push(topic.heading, "");
		if (topic.intro) out.push(...splitLines(topic.intro), "");
		for (const entry of topic.entries) {
			if (mode === "storage") {
				const meta = entryMetadataLine(entry);
				if (meta) out.push(meta);
			}
			const day = byId ? pairDayOf(entry, byId) : undefined;
			const shown = day ? { ...entry, text: withPairDay(entry.text, day, eol) } : entry;
			out.push(...splitLines(inlineIds ? withInlineEntryId(shown, eol) : shown.text), "");
		}
		const row = opts?.archiveIndex?.[memoryAreaId(section, topic.title)];
		if (mode === "context" && row && row.count > 0) out.push(archivePointerLine(row), "");
	}
	return out.join(eol) + eol;
}

/**
 * `storage` is the file on disk; `context` is what the room reads every turn, without metadata and with archive
 * pointer lines. Sections this module does not own go back byte for byte at their recorded position.
 */
export function renderMemoryDocument(doc: MemoryDocument, mode: MemoryRenderMode, opts?: MemoryRenderOptions): string {
	const eol = memoryDocumentEol(doc);
	if (opts?.sections) {
		const wanted = new Set(opts.sections);
		return MEMORY_SECTIONS.filter((section) => wanted.has(section)).map((section) => renderSection(doc, section, mode, eol, opts)).join("");
	}
	const parts: string[] = [];
	if (doc.chronos) parts.push(doc.chronos);
	parts.push(renderSection(doc, "Deep Memory", mode, eol, opts));
	parts.push(renderSection(doc, "Active Items", mode, eol, opts));
	if (doc.recentContext) parts.push(doc.recentContext);
	for (const other of [...doc.otherSections].sort((a, b) => a.index - b.index)) {
		parts.splice(Math.min(Math.max(other.index, 0), parts.length), 0, other.text);
	}
	return doc.preamble + parts.join("");
}

const RC_METADATA_LINE = /^[ \t]*<!--\s*rc_metadata:[\s\S]*?-->[ \t]*$/;

/**
 * The room's boot read without its `rc_metadata` lines. Only the boot strips them: the context render is what
 * every save's fingerprint measures, so changing it would make every earlier save read as stale to undo.
 */
export function stripRecentContextMetadata(text: string): string {
	const eol = text.includes("\r\n") ? "\r\n" : "\n";
	const lines = text.split(/\r?\n/);
	const out: string[] = [];
	for (let i = 0; i < lines.length; i++) {
		if (!RC_METADATA_LINE.test(lines[i])) { out.push(lines[i]); continue; }
		if (isBlank(out[out.length - 1] ?? "x") && isBlank(lines[i + 1] ?? "x")) i++;
	}
	return out.join(eol);
}

/** True once the file carries the id counter or an entry metadata line, which only the storage render writes. */
export function isMigratedMemoryDocument(l1b: string): boolean {
	return splitLines(l1b).some((line) => ENTRY_COUNTER_LINE.test(line) || ENTRY_META_LINE.test(line));
}

/**
 * The room's context render, bytes to bytes. A never-migrated file comes back verbatim: re-layout belongs to the
 * recorded migration write, never to a read.
 */
export function renderMemoryContext(l1b: string, archiveText?: string, opts: { pairDays?: boolean } = {}): string {
	if (!isMigratedMemoryDocument(l1b)) return l1b;
	const index = archiveText && archiveText.trim() ? archiveIndex(parseArchive(archiveText)) : undefined;
	return renderMemoryDocument(parseMemoryDocument(l1b), "context", { ...(index ? { archiveIndex: index } : {}), ...(opts.pairDays ? { pairDays: true } : {}) });
}

/** The context render's tokens for Deep Memory and Active Items, headings included: the one number the budget meter and the budget pass share. */
export function reviewTargetTokens(doc: MemoryDocument): number {
	const eol = memoryDocumentEol(doc);
	return estimateTokens(renderSection(doc, "Deep Memory", "context", eol) + renderSection(doc, "Active Items", "context", eol));
}

export function entryTokens(entry: MemoryEntry): number {
	return estimateTokens(entry.text);
}

export interface MemoryAreaRow {
	id: string;
	topic: string;
	section: string;
	kind: EntryKind;
	pinned: boolean;
	saved: string;
	tokens: number;
	/** The entry's first line, trimmed: the first read's material and the fold's bullet check read it. */
	firstLine: string;
	/** The whole entry, so the fold knows an add that repeats it or may disagree with it. */
	text: string;
	/** YYYY-MM-DD the room learned what the text says (a conversation's day or a hand edit's, the newest one after a Replace or a Review merge), when known: the day the fold weighs a page against. */
	learned?: string;
	/** Without `learned`, what dates the note instead: the conversation that wrote it, and the day it was last touched. */
	from?: string;
	updated?: string;
}

/** Every entry as one row, in document order: what the fold and the first read judge against. */
export function listAreas(doc: MemoryDocument): MemoryAreaRow[] {
	const rows: MemoryAreaRow[] = [];
	for (const topic of doc.topics) {
		for (const entry of topic.entries) {
			rows.push({
				id: entry.id,
				topic: topic.title,
				section: topic.section,
				kind: entry.kind,
				pinned: entry.pinned,
				saved: entry.saved,
				tokens: entryTokens(entry),
				firstLine: (splitLines(entry.text).find((line) => !isBlank(line)) ?? "").trim(),
				text: entry.text,
				...(entry.learned ? { learned: entry.learned } : {}),
				...(entry.from ? { from: entry.from } : {}),
				...(entry.updated ? { updated: entry.updated } : {}),
			});
		}
	}
	return rows;
}

export function findEntry(doc: MemoryDocument, id: string): MemoryEntry | undefined {
	return findEntryLocation(doc, id)?.entry;
}

export function findEntryLocation(doc: MemoryDocument, id: string): { entry: MemoryEntry; topic: MemoryTopic } | undefined {
	if (!id) return undefined;
	for (const topic of doc.topics) {
		const entry = topic.entries.find((e) => e.id === id);
		if (entry) return { entry, topic };
	}
	return undefined;
}

/**
 * Every constant of the demotion order, in one place so the bench prints them. A note's score is kind + use
 * (log2(1 + uses), capped) + recency (to nothing at the horizon) - size (tokens over the divisor, capped).
 */
export const DEMOTION_SCORE = {
	practiceWeight: 3,
	factWeight: 1,
	eventWeight: 0,
	doneItemWeight: 0,
	useCap: 3,
	recencyWeight: 2,
	recencyHorizonDays: 365,
	sizeDivisor: 50,
	sizeCap: 4,
} as const;

export interface RankedEntry extends MemoryEntry {
	/** Higher keeps; the order leaves the lowest first. */
	score: number;
	/** The deciding terms in a person's words, e.g. "not touched since 2 Mar, never recalled, 280 tokens". Never empty. */
	reason: string;
}

/** Today as the local YYYY-MM-DD: the day a person reading the card is in. */
function localDay(date = new Date()): string {
	return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function dayNumber(day: string): number {
	const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
	if (!match) return Number.NaN;
	return Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])) / 86_400_000;
}

const MONTH_WORDS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "2 Mar", with the year only when it is not today's: "2 Mar 2025". */
export function dayWords(day: string, today: string): string {
	const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
	if (!match) return day;
	const year = match[1] === today.slice(0, 4) ? "" : ` ${match[1]}`;
	return `${Number(match[3])} ${MONTH_WORDS[Number(match[2]) - 1] ?? match[2]}${year}`;
}

/** "May", with the year only when it is not today's: "May 2025". */
function monthWords(day: string, today: string): string {
	const match = /^(\d{4})-(\d{2})/.exec(day);
	if (!match) return day;
	const year = match[1] === today.slice(0, 4) ? "" : ` ${match[1]}`;
	return `${MONTH_WORDS[Number(match[2]) - 1] ?? match[2]}${year}`;
}

function useWords(count: number): string {
	if (count <= 0) return "never recalled";
	if (count === 1) return "recalled once";
	if (count === 2) return "recalled twice";
	return `recalled ${count} times`;
}

function kindWeight(entry: MemoryEntry): number {
	switch (entry.kind) {
		case "practice": return DEMOTION_SCORE.practiceWeight;
		case "fact": return DEMOTION_SCORE.factWeight;
		case "event": return DEMOTION_SCORE.eventWeight;
		default: return DEMOTION_SCORE.doneItemWeight;
	}
}

/** The deciding terms: the date first, then the use, then the size when worth naming; never a bare "never recalled". */
function demotionReason(entry: MemoryEntry, input: { useCount: number; days: number; today: string; tokens: number; oldestOfKind: boolean }): string {
	const parts: string[] = [];
	const touched = entry.updated ?? entry.saved;
	if (entry.kind === "item") parts.push(`done item from ${monthWords(entry.saved, input.today)}`);
	else if (entry.kind === "event") parts.push(`event from ${dayWords(entry.saved, input.today)}`);
	// The kind's phrase already names the day when the note was never touched
	// after it was saved; the same date twice would read as two reasons.
	const dateNamed = parts.length > 0 && touched === entry.saved;
	if (!dateNamed) {
		if (Number.isNaN(input.days)) parts.push("date unknown");
		else if (input.days > 30) parts.push(`not touched since ${dayWords(touched, input.today)}`);
		else if (input.days <= 0) parts.push("touched today");
		else if (input.days === 1) parts.push("touched yesterday");
		else parts.push(`touched ${input.days} days ago`);
	}
	parts.push(input.useCount > 0 && input.oldestOfKind ? `${useWords(input.useCount)} but the oldest of its kind` : useWords(input.useCount));
	if (input.tokens >= 100) parts.push(`${input.tokens} tokens`);
	return parts.join(", ");
}

/**
 * The demotion order, lowest score first, deterministic and total. Pinned entries and open items are left out;
 * a tie goes to the larger entry, then the older saved-on, then the id.
 */
export function rankEntriesForDemotion(doc: MemoryDocument, opts: { use?: MemoryUse; today?: string } = {}): RankedEntry[] {
	const today = opts.today ?? localDay();
	const todayNumber = dayNumber(today);
	const entries = doc.topics.flatMap((t) => t.entries).filter((e) => !e.pinned && !(e.kind === "item" && e.status === "open"));
	const scored = entries.map((entry) => {
		const useCount = (entry.refs ?? 0) + (opts.use?.notes[entry.id]?.hits ?? 0);
		const touched = dayNumber(entry.updated ?? entry.saved);
		const days = Number.isNaN(touched) ? Number.NaN : Math.max(0, Math.round(todayNumber - touched));
		const tokens = entryTokens(entry);
		const use = Math.min(DEMOTION_SCORE.useCap, Math.log2(1 + useCount));
		const recency = Number.isNaN(days) ? 0 : DEMOTION_SCORE.recencyWeight * Math.max(0, 1 - days / DEMOTION_SCORE.recencyHorizonDays);
		const size = Math.min(DEMOTION_SCORE.sizeCap, tokens / DEMOTION_SCORE.sizeDivisor);
		return { entry, useCount, days, tokens, score: kindWeight(entry) + use + recency - size };
	});
	scored.sort((a, b) => a.score - b.score || b.tokens - a.tokens || a.entry.saved.localeCompare(b.entry.saved) || a.entry.id.localeCompare(b.entry.id));
	// "The oldest of its kind": a used note that leaves only because none of its kind was touched longer ago.
	const firstOfKind = new Set<EntryKind>();
	return scored.map((row) => {
		const first = !firstOfKind.has(row.entry.kind);
		firstOfKind.add(row.entry.kind);
		const oldestOfKind = first && row.days > 30 && scored.every((other) => other.entry.kind !== row.entry.kind || !(other.days > row.days));
		return { ...row.entry, score: row.score, reason: demotionReason(row.entry, { useCount: row.useCount, days: row.days, today, tokens: row.tokens, oldestOfKind }) };
	});
}

export interface DemotionResult {
	doc: MemoryDocument;
	demoted: RankedEntry[];
	/** Estimated tokens still over budget when nothing demotable is left; 0 when the budget was reached. */
	overageTokens: number;
	/** Open items the pass left in place while the budget was still not met — what the protection cost; 0 when the budget was reached. */
	protectedOpenItems: number;
}

/** What one entry adds to the context render (its lines, the last terminator and the blank after), so the budget pass subtracts instead of re-rendering. */
function contextEntryChars(entry: MemoryEntry, eol: string): number {
	return entry.text.length + 2 * eol.length;
}

/**
 * Brings Deep Memory and Active Items under budget from the bottom of the ranking. Pinned entries, `keepIds`, `keepTopics`
 * and open items stay; entries saved `today` go last, and leave only when nothing else is left.
 */
export function demoteToBudget(doc: MemoryDocument, budgetTokens: number, opts: { keepIds?: string[]; keepTopics?: string[]; today: string; use?: MemoryUse }): DemotionResult {
	const next = cloneDocument(doc);
	const eol = memoryDocumentEol(next);
	const keep = new Set(opts.keepIds ?? []);
	const keptTopics = new Set((opts.keepTopics ?? []).map(memoryTopicAddressKey));
	if (keptTopics.size > 0) {
		for (const topic of next.topics) {
			if (keptTopics.has(memoryTopicAddressKey(memoryTopicAddress(topic.section, topic.title)))) for (const entry of topic.entries) keep.add(entry.id);
		}
	}
	const ranked = rankEntriesForDemotion(next, { today: opts.today, use: opts.use }).filter((e) => !keep.has(e.id));
	const order = [...ranked.filter((e) => e.saved !== opts.today), ...ranked.filter((e) => e.saved === opts.today)];
	const demoted: RankedEntry[] = [];
	let chars = renderSection(next, "Deep Memory", "context", eol).length + renderSection(next, "Active Items", "context", eol).length;
	for (const entry of order) {
		if (estimateTokensFromChars(chars) <= budgetTokens) break;
		for (const topic of next.topics) {
			const at = topic.entries.findIndex((e) => e.id === entry.id);
			if (at >= 0) { topic.entries.splice(at, 1); break; }
		}
		chars -= contextEntryChars(entry, eol);
		demoted.push(entry);
	}
	const overageTokens = Math.max(0, estimateTokensFromChars(chars) - budgetTokens);
	const protectedOpenItems = overageTokens > 0
		? next.topics.flatMap((t) => t.entries).filter((e) => e.kind === "item" && e.status === "open" && !e.pinned && !keep.has(e.id)).length
		: 0;
	return { doc: next, demoted, overageTokens, protectedOpenItems };
}

/** The archive's file name, inside the room's existing `L1b/archive` directory. */
export const MEMORY_ARCHIVE_ENTRIES_FILE = "entries.md";
export const MEMORY_ARCHIVE_HEADER = "<!-- exxeta:l1b-archive schema_version=1 -->";
export const MEMORY_ARCHIVE_HEADING = "## Archived entries";

function archivePreamble(eol: string): string {
	return `${MEMORY_ARCHIVE_HEADER}${eol}${eol}${MEMORY_ARCHIVE_HEADING}${eol}${eol}`;
}

export function parseArchive(text: string): ArchivedEntry[] {
	const eol = firstEol(text) ?? "\n";
	const lines = splitLines(text);
	const metaIndexes: number[] = [];
	for (let i = 0; i < lines.length; i++) if (ENTRY_META_LINE.test(lines[i])) metaIndexes.push(i);
	return metaIndexes.map((at, n) => {
		const end = n + 1 < metaIndexes.length ? metaIndexes[n + 1] : lines.length;
		const fields = parseMetaFields(ENTRY_META_LINE.exec(lines[at])![1]);
		const entry = entryFromMeta(fields, stripBlankEdges(lines.slice(at + 1, end)).join(eol));
		const section: MemorySection = fields.section === "Active Items" ? "Active Items" : "Deep Memory";
		const why = ARCHIVE_REASONS.find((w) => w === fields.why) ?? "budget";
		if (fields.until && !ISO_DAY.test(fields.until)) entry.extra = { ...entry.extra, until: fields.until };
		return { ...entry, archived: fields.archived ?? "", why, ...(fields.until && ISO_DAY.test(fields.until) ? { until: fields.until } : {}), topic: fields.topic ?? (section === "Active Items" ? MEMORY_ACTIVE_ITEMS_TOPIC : MEMORY_GENERAL_TOPIC), section };
	});
}

function archiveBlocks(entries: ArchivedEntry[], eol: string): string {
	return entries.map((entry) => `${archivedMetadataLine(entry)}${eol}${entry.text}${eol}${eol}`).join("");
}

export function renderArchive(entries: ArchivedEntry[], eol = "\n"): string {
	return archivePreamble(eol) + archiveBlocks(entries, eol);
}

/** Appends rows, whatever their reason; an empty file gets the header first. */
export function appendToArchive(text: string, entries: MemoryEntry[], meta: Array<{ archived: string; why: ArchiveReason; until?: string; topic: string; section: MemorySection }>): string {
	const eol = firstEol(text) ?? "\n";
	if (meta.length !== entries.length) throw new Error("appendToArchive needs one metadata record per entry");
	const archived: ArchivedEntry[] = entries.map((entry, i) => ({ ...cloneEntry(entry), ...meta[i] }));
	const head = text.trim() ? text.replace(/(\r\n|[\n\r\u2028\u2029])+$/, "") + eol + eol : archivePreamble(eol);
	return head + archiveBlocks(archived, eol);
}

/** Every id the archive holds: union it with the run's own rows before `nextVersionedEntryId`, or a second run mints the same `-v1`. */
export function archiveIdsTaken(text: string): string[] {
	return parseArchive(text).map((entry) => entry.id);
}

/**
 * Takes one entry out of the archive. When two rows share the id, the newest (last) goes: an undo takes back the
 * latest save's rows, and a restore wants the text most recently in memory.
 */
export function removeFromArchive(text: string, id: string): { text: string; entry?: ArchivedEntry } {
	const eol = firstEol(text) ?? "\n";
	const entries = parseArchive(text);
	let at = -1;
	for (let i = entries.length - 1; i >= 0; i--) if (entries[i].id === id) { at = i; break; }
	if (at < 0) return { text };
	const entry = entries[at];
	const firstMeta = splitLines(text).findIndex((line) => ENTRY_META_LINE.test(line));
	const head = firstMeta > 0 ? splitLines(text).slice(0, firstMeta).join(eol) + eol : archivePreamble(eol);
	return { text: head + archiveBlocks(entries.filter((_, i) => i !== at), eol), entry };
}

/** Per-topic counts and archived-month range: what the context render's pointer lines are built from. */
export function archiveIndex(entries: ArchivedEntry[]): ArchiveIndex {
	const index: ArchiveIndex = {};
	for (const entry of entries) {
		const key = memoryAreaId(entry.section, entry.topic);
		const month = entry.archived.slice(0, 7);
		const row = index[key];
		if (!row) { index[key] = { section: entry.section, topic: entry.topic, count: 1, earliest: month, latest: month }; continue; }
		row.count++;
		if (month && (!row.earliest || month < row.earliest)) row.earliest = month;
		if (month && (!row.latest || month > row.latest)) row.latest = month;
	}
	return index;
}

/**
 * The core entry sharing this id's base, if any. A restore refuses when there is one: a note is in the core once or
 * not at all, since two rows with one address would make every later edit a coin toss.
 */
export function findEntryVersion(doc: MemoryDocument, id: string): { entry: MemoryEntry; topic: MemoryTopic } | undefined {
	const base = entryBaseId(id);
	if (!base) return undefined;
	for (const topic of doc.topics) {
		const entry = topic.entries.find((e) => entryBaseId(e.id) === base);
		if (entry) return { entry, topic };
	}
	return undefined;
}

function restoreInto(next: MemoryDocument, archived: ArchivedEntry): void {
	if (archived.why === "history") throw new Error(`a restore was not checked: "${archived.id}" is an older value kept as history`);
	if (findEntryVersion(next, archived.id)) throw new Error(`a restore was not checked: "${archived.id}" is already in memory`);
	const topic = topicFor(next, archived.section, archived.topic);
	const entry: MemoryEntry = { id: archived.id, kind: archived.kind, saved: archived.saved, pinned: archived.pinned, text: archived.text };
	if (archived.from) entry.from = archived.from;
	if (archived.status) entry.status = archived.status;
	if (archived.updated) entry.updated = archived.updated;
	if (archived.learned) entry.learned = archived.learned;
	if (archived.refs !== undefined) entry.refs = archived.refs;
	if (archived.summary) entry.summary = true;
	if (archived.tried) entry.tried = [...archived.tried];
	const { until: _until, ...extra } = archived.extra ?? {};
	if (Object.keys(extra).length > 0) entry.extra = extra;
	topic.entries.push(entry);
	const n = entryNumber(entryBaseId(entry.id));
	if (n !== null && n >= next.nextEntryNumber) next.nextEntryNumber = n + 1;
}

/** Puts an archived entry back at the end of its topic, created if gone. Throws for a history row or when a version is in the core (`findEntryVersion`); the restore route checks both first. */
export function restoreEntry(doc: MemoryDocument, archived: ArchivedEntry): MemoryDocument {
	const next = cloneDocument(doc);
	restoreInto(next, archived);
	return next;
}

/** `restoreEntry` for many rows with one copy of the document, each row checked against the rows before it. */
export function restoreEntries(doc: MemoryDocument, archived: readonly ArchivedEntry[]): MemoryDocument {
	const next = cloneDocument(doc);
	for (const row of archived) restoreInto(next, row);
	return next;
}

export type MemoryUserEdit =
	| { op: "edit"; id: string; text: string; today?: string }
	| { op: "delete"; id: string }
	| { op: "pin"; id: string }
	| { op: "unpin"; id: string }
	| { op: "move"; id: string; topic: string }
	| { op: "status"; id: string; status: ItemStatus; today?: string }
	| { op: "add"; topic: string; kind: EntryKind; text: string; saved: string };

/** A heading or a comment opener, even indented: in a note it would mint a topic and cut the note, or claim another note's id. */
const STRUCTURAL_LINE = /^\s*(?:#+(?:\s|$)|<!--)/;

export function findStructuralLine(text: string): string | null {
	return splitLines(text).find((line) => STRUCTURAL_LINE.test(line)) ?? null;
}

/**
 * One Memory pane edit, applied to a copy; a delete hands the entry back for the archive. A structural line throws,
 * as the backstop behind the route's own rewrite (memoryTypedText).
 */
export function applyUserEdit(doc: MemoryDocument, edit: MemoryUserEdit): { doc: MemoryDocument; archived?: MemoryEntry } {
	if (edit.op === "add" || edit.op === "edit") {
		const structural = findStructuralLine(edit.text);
		if (structural !== null) throw new Error(`a note's text was not checked: it carries a structural line ${JSON.stringify(structural)}`);
	}
	const next = cloneDocument(doc);
	if (edit.op === "add") {
		const topic = topicFor(next, edit.kind === "item" ? "Active Items" : "Deep Memory", edit.topic);
		// A must-keep marker pins the note and leaves its words, as a fold's does.
		const marked = hasMustKeepMarker(edit.text);
		// The person's own words are learned the day they are typed.
		const entry: MemoryEntry = { id: formatEntryId(next.nextEntryNumber), kind: edit.kind, saved: edit.saved, pinned: marked, text: marked ? withoutMustKeepMarkers(edit.text) : edit.text, ...(ISO_DAY.test(edit.saved) ? { learned: edit.saved } : {}) };
		if (edit.kind === "item") entry.status = "open";
		next.nextEntryNumber++;
		topic.entries.push(entry);
		return { doc: next };
	}
	const found = findEntryLocation(next, edit.id);
	if (!found) return { doc: next };
	const { entry, topic } = found;
	switch (edit.op) {
		case "edit":
			if (hasMustKeepMarker(edit.text)) {
				entry.text = withoutMustKeepMarkers(edit.text);
				entry.pinned = true;
			} else {
				entry.text = edit.text;
			}
			if (edit.today) entry.updated = edit.today;
			// A correction is as new as the day it was made, so no older
			// conversation folded later can overwrite it.
			if (edit.today && ISO_DAY.test(edit.today)) entry.learned = edit.today;
			delete entry.disagrees;
			return { doc: next };
		case "delete":
			topic.entries.splice(topic.entries.indexOf(entry), 1);
			return { doc: next, archived: cloneEntry(entry) };
		case "pin":
			entry.pinned = true;
			return { doc: next };
		case "unpin":
			entry.pinned = false;
			return { doc: next };
		case "status":
			// Only an item has a status; closing one leaves it in the core until
			// the next Memorize takes it, which is where "done items leave" lives.
			entry.status = edit.status;
			if (edit.today) entry.updated = edit.today;
			return { doc: next };
		case "move": {
			const target = topicFor(next, entry.kind === "item" ? "Active Items" : "Deep Memory", edit.topic);
			if (target === topic) return { doc: next };
			topic.entries.splice(topic.entries.indexOf(entry), 1);
			target.entries.push(entry);
			return { doc: next };
		}
	}
}

/** The topic of that title, the intended section first, else a new one at the end of its section. */
function topicFor(doc: MemoryDocument, intendedSection: MemorySection, title: string): MemoryTopic {
	const existing = doc.topics.find((t) => t.section === intendedSection && t.title === title) ?? doc.topics.find((t) => t.title === title);
	if (existing) return existing;
	const section: MemorySection = title === MEMORY_ACTIVE_ITEMS_TOPIC ? "Active Items" : intendedSection;
	const topic: MemoryTopic = { section, title, heading: `### ${title}`, intro: "", entries: [] };
	let last = -1;
	doc.topics.forEach((t, i) => { if (t.section === section) last = i; });
	doc.topics.splice(last >= 0 ? last + 1 : section === "Deep Memory" ? 0 : doc.topics.length, 0, topic);
	return topic;
}

function cloneEntry(entry: MemoryEntry): MemoryEntry {
	const copy = entry.extra ? { ...entry, extra: { ...entry.extra } } : { ...entry };
	if (entry.tried) copy.tried = [...entry.tried];
	return copy;
}

export function cloneDocument(doc: MemoryDocument): MemoryDocument {
	return {
		preamble: doc.preamble,
		chronos: doc.chronos,
		topics: doc.topics.map((t) => ({ ...t, entries: t.entries.map(cloneEntry) })),
		recentContext: doc.recentContext,
		otherSections: doc.otherSections.map((s) => ({ ...s })),
		nextEntryNumber: doc.nextEntryNumber,
	};
}
