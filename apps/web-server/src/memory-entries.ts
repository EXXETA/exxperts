// The memory entry model (memory v2, stream B) — the pure layer that turns
// `L1b/current.md` into addressable pieces and back.
//
// Today a memory is one string: storage and the room's context render are the
// same bytes, and the only address anything has is a subsection title. This
// module splits the two apart and gives every bullet and paragraph an id, a
// kind, a saved-on date and its originating session, so maintenance can emit
// small checkable operations against pieces instead of rewriting the file.
//
// What lives here and what does not:
//   - here: parsing, migration, the two renders, the area map, the
//     deterministic ranker, budget demotion, the archive file, user edits;
//   - not here: anything that talks to a model, a route, or the filesystem.
//     Every function is pure and returns a new document.
//
// Conventions shared with the Review operations layer (review-ops.ts):
//   - an area address is "Section / Subsection" (memoryAreaId);
//   - must-keep is a marker anywhere in an entry, and a marked entry is pinned;
//   - sizes go through the ONE estimator (token-estimate.ts), never re-derived.
//
// THE LINE MODEL (the one rule everything below obeys):
//   A line ends at "\r\n", "\n", "\r", U+2028 or U+2029 — the same terminators
//   the memory-map splitters' multiline anchors break on. A line is stored
//   WITHOUT its terminator and with every other byte intact (indentation and
//   trailing spaces are identity, never trimmed). Rebuilt regions are written
//   back with ONE terminator for the whole document, `memoryDocumentEol(doc)`:
//   the first terminator found in the document's own verbatim text. Regions
//   this module does not own (the preamble, Chronos, Recent Context and any
//   other top-level section) are carried as verbatim slices and never touched,
//   so their bytes survive whatever they are.
//   THE EDGE RULE: a block loses its leading and trailing BLANK lines and
//   nothing else (a "blank" line is one whose trim() is empty, so a line of
//   spaces at an edge is a separator and goes; inside a block it stays).
//   Consequence: a document in storage format — one this module rendered —
//   round-trips byte for byte through parse and render, CRLF, trailing spaces
//   and blank-line structure included. A hand-written file with, say, three
//   blank lines between two bullets is parsed happily and rendered in the
//   canonical layout; that first render is the migration write, and every
//   render after it is a fixed point.

import { estimateTokens, estimateTokensFromChars } from "./token-estimate.js";

// --- The model ---------------------------------------------------------------

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
	/** Items only. */
	status?: ItemStatus;
	/** YYYY-MM-DD of the last update or supersede. */
	updated?: string;
	/** Times referenced (recall or update); a ranking input. */
	refs?: number;
	/** The entry's markdown lines exactly, without its metadata comment. */
	text: string;
}

export interface MemoryTopic {
	section: MemorySection;
	/** "General" for Deep Memory prose under no heading; the Active Items list is one topic titled "Active Items". */
	title: string;
	/** The exact "### Title" line, null for implicit topics. */
	heading: string | null;
	/** Prose before the first entry, verbatim (usually empty). */
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
 * Why an entry left the core. "budget" is the ranked demotion, "superseded" an
 * older version of an entry that is still in memory, "done" a finished item,
 * "user" a person deleting one by hand. Review adds the two reasons a tidy
 * gives: "stale" (the note no longer holds) and "duplicate" (another note
 * already carries the point).
 */
export const ARCHIVE_REASONS = ["budget", "superseded", "done", "user", "stale", "duplicate"] as const;

export type ArchiveReason = (typeof ARCHIVE_REASONS)[number];

export interface ArchivedEntry extends MemoryEntry {
	/** YYYY-MM-DD the entry left the core. */
	archived: string;
	why: ArchiveReason;
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

/** The ONE address of a topic, the Review layer's convention: "Section / Subsection". */
export function memoryAreaId(section: MemorySection, topic: string): string {
	return `${section} / ${topic}`;
}

/**
 * A topic as the run cards name it when a person protects one: "Deep
 * Memory/Nordwind integration". The card sends this string back, so it is the
 * one shape both engines and the browser agree on.
 */
export function memoryTopicAddress(section: MemorySection, topic: string): string {
	return `${section}/${topic}`;
}

/** Two topic addresses are the same topic when they agree case-insensitively, trimmed. */
export function memoryTopicAddressKey(address: string): string {
	return address.trim().toLowerCase();
}

// --- The line model ----------------------------------------------------------

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

/** The ONE edge rule: leading and trailing BLANK lines go, nothing else. */
function stripBlankEdges(lines: string[]): string[] {
	const out = [...lines];
	while (out.length > 0 && isBlank(out[0])) out.shift();
	while (out.length > 0 && isBlank(out[out.length - 1])) out.pop();
	return out;
}

/**
 * The document's ONE terminator: the first one in its own text, verbatim
 * regions first (they are the bytes we did not write). "\n" when the document
 * holds no terminator at all.
 */
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

// --- Markers, headings and stamps --------------------------------------------

/** The Review layer's marker, same predicate: a marked entry is pinned. */
const MUST_KEEP_MARKER = /\*\*must-keep\b/i;
const BULLET_LINE = /^(\s*)(?:[-*+]|\d+[.)])\s/;
const TOP_LEVEL_HEADING = /^##\s+(.+?)\s*$/;
const SUBSECTION_HEADING = /^###\s+(.+?)\s*$/;
/** What the memory-map splitters read as a boundary: two or three hashes at column 0. */
const SPLITTER_HEADING_LINE = /^#{2,3}(?:\s|$)/;
const ENTRY_META_LINE = /^[ \t]*<!--\s*e:\s*([\s\S]*?)\s*-->[ \t]*$/;
const ENTRY_COUNTER_LINE = /^[ \t]*<!--\s*entries:\s*next=(\d+)\s*-->[ \t]*$/;
const SAVED_STAMP = /\(saved ([^)]*)\)/g;
const ISO_DATE = /(?<!\d)\d{4}-\d{2}-\d{2}(?!\d)/g;

/** Every ISO date inside a "(saved …)" stamp, in order — the Review layer's reader, same shape. */
export function savedStampDatesIn(text: string): string[] {
	return Array.from(text.matchAll(SAVED_STAMP)).flatMap((m) => m[1].match(ISO_DATE) ?? []);
}

function indentOf(line: string): number {
	const bullet = BULLET_LINE.exec(line);
	return bullet ? bullet[1].length : line.length - line.trimStart().length;
}

// --- Metadata comments -------------------------------------------------------

const META_FIELD = /([A-Za-z_][A-Za-z0-9_]*)=(?:"((?:[^"\\]|\\.)*)"|(\S*))/g;

function parseMetaFields(raw: string): Record<string, string> {
	const out: Record<string, string> = {};
	for (const m of raw.matchAll(META_FIELD)) {
		out[m[1]] = m[2] !== undefined ? m[2].replace(/\\(["\\])/g, "$1") : (m[3] ?? "");
	}
	return out;
}

function metaValue(value: string): string {
	// A value can never carry a comment closer; "-- >" keeps the line readable
	// and the comment well-formed (a topic title is the only free-text field).
	const safe = value.replace(/-->/g, "-- >");
	return /[\s"\\]/.test(safe) ? `"${safe.replace(/(["\\])/g, "\\$1")}"` : safe;
}

function entryMetaFields(entry: MemoryEntry): string[] {
	const fields = [`id=${entry.id}`, `kind=${entry.kind}`, `saved=${entry.saved}`];
	if (entry.from) fields.push(`from=${entry.from}`);
	if (entry.pinned) fields.push("pinned=true");
	if (entry.status) fields.push(`status=${entry.status}`);
	if (entry.updated) fields.push(`updated=${entry.updated}`);
	if (entry.refs !== undefined) fields.push(`refs=${entry.refs}`);
	return fields;
}

/** The storage metadata line of an entry, or null for an entry that has no id yet. */
export function entryMetadataLine(entry: MemoryEntry): string | null {
	if (!entry.id) return null;
	return `<!-- e: ${entryMetaFields(entry).join(" ")} -->`;
}

function archivedMetadataLine(entry: ArchivedEntry): string {
	const fields = [...entryMetaFields(entry), `archived=${entry.archived}`, `why=${entry.why}`, `topic=${metaValue(entry.topic)}`, `section=${metaValue(entry.section)}`];
	return `<!-- e: ${fields.join(" ")} -->`;
}

function entryFromMeta(fields: Record<string, string>, text: string): MemoryEntry {
	const kind = (ENTRY_KINDS as readonly string[]).includes(fields.kind) ? (fields.kind as EntryKind) : "fact";
	const refs = Number(fields.refs);
	const entry: MemoryEntry = { id: fields.id ?? "", kind, saved: fields.saved ?? "", pinned: fields.pinned === "true", text };
	if (fields.from) entry.from = fields.from;
	if (fields.status === "open" || fields.status === "done") entry.status = fields.status;
	if (fields.updated) entry.updated = fields.updated;
	if (fields.refs !== undefined && Number.isFinite(refs)) entry.refs = refs;
	return entry;
}

// --- Parsing -----------------------------------------------------------------

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

/**
 * Blocks of unmarked material — what migration reads as entries. A bullet takes
 * its continuation with it (deeper-indented sub-bullets, wrapped lines, and the
 * loose-list blank whose next non-blank line is still deeper); a paragraph runs
 * to the next blank line or bullet. Mirrors the Review layer's must-keep block
 * walk, so the two agree on where a bullet ends.
 */
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
			// Nothing is marked yet: every bullet and paragraph is an entry without an id.
			entries: splitUnmarkedBlocks(stripBlankEdges(bodyLines)).map((block) => ({ id: "", kind: "fact" as EntryKind, saved: "", pinned: false, text: block.join(eol) })),
		};
	}
	const intro = stripBlankEdges(bodyLines.slice(0, metaIndexes[0])).join(eol);
	const entries = metaIndexes.map((at, n) => {
		const end = n + 1 < metaIndexes.length ? metaIndexes[n + 1] : bodyLines.length;
		const fields = parseMetaFields(ENTRY_META_LINE.exec(bodyLines[at])![1]);
		return entryFromMeta(fields, stripBlankEdges(bodyLines.slice(at + 1, end)).join(eol));
	});
	return { intro, entries };
}

function parseSectionTopics(sectionText: string, section: MemorySection, eol: string): { topics: MemoryTopic[]; nextEntryNumber: number | null } {
	const lines = splitLines(sectionText);
	// Drop the section's own heading line; keep everything else byte for byte.
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
 * Reads `L1b/current.md` into the entry model. Tolerant on purpose: a file that
 * has never been migrated parses fine, with every bullet and paragraph an entry
 * whose id is still empty. Sections this module does not own are carried
 * verbatim with their original position.
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
	return {
		preamble,
		chronos,
		topics: [...deepParsed.topics, ...activeParsed.topics],
		recentContext,
		otherSections,
		nextEntryNumber: deepParsed.nextEntryNumber ?? 1,
	};
}

// --- Migration ---------------------------------------------------------------

function entryNumber(id: string): number | null {
	const m = /^m-(\d+)$/.exec(id);
	return m ? Number(m[1]) : null;
}

export function formatEntryId(n: number): string {
	return `m-${String(n).padStart(4, "0")}`;
}

/** The version suffix an archived older text carries: `m-0031-v1`, then `-v2`. */
const VERSIONED_ENTRY_ID = /^(.*)-v(\d+)$/;

/**
 * THE ID RULE for an entry's older text on its way to the archive: it keeps the
 * entry's own id with a version suffix, because the archive is addressable (a
 * restore looks an entry up by id) and two rows claiming one address would make
 * a restore a coin toss. `taken` is every id the archive already holds for this
 * write, so two versions of one entry in a single run get `-v1` and `-v2`.
 * Memorize and Review both archive a replaced text, and they mint the same id.
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
 * THE PRACTICE RULES of migration. They decide ONE thing: the kind a Deep
 * Memory entry gets the day the file first receives its ids, and the kind
 * decides one thing in turn — the order entries leave in when the limit bites
 * (a practice outranks a fact in `rankEntriesForDemotion`); nothing else reads
 * it. A note is a practice when its topic title reads like a way of working
 * (the title rule) or its own text, bullet stripped, opens like an instruction
 * (the text rule); everything else is a fact. A person cannot change a kind by
 * hand yet, so a call these rules get wrong stands until a Memorize or Review
 * rewrites the note.
 */
export const MIGRATION_PRACTICE_TITLE_RULE = /\b(working style|working-style|preferences?|practices?|conventions?|guidelines?|rules?|how (we|i|to) work|style guide|ways of working)\b/i;
export const MIGRATION_PRACTICE_TEXT_RULE = /^(always|never|prefer|avoid|do not|don't|use|ask before|keep)\b|^(when|whenever|before|after) /i;

/** The kind migration gives a Deep Memory entry: the two rules above, in that order. */
function migratedDeepMemoryKind(topicTitle: string, text: string): EntryKind {
	if (MIGRATION_PRACTICE_TITLE_RULE.test(topicTitle)) return "practice";
	const first = splitLines(text).find((line) => !isBlank(line)) ?? "";
	return MIGRATION_PRACTICE_TEXT_RULE.test(first.replace(BULLET_PREFIX, "").trimStart()) ? "practice" : "fact";
}

/**
 * THE TEMPLATE RULE of migration. A v1 memory opened its Deep Memory with a
 * paragraph the scaffold wrote, not the room: "Durable understanding is still
 * forming. What is known so far comes from the scaffolded identity: …" on day
 * one, and after the first consolidation "Durable understanding consolidated
 * across sessions since March 2026. Newer saved-on stamps win on conflict."
 * Migrated as it stands, that paragraph became a note under "General" — one
 * nobody wrote and nobody wants to read. So, at migration only, an entry
 * without an id in the heading-less first Deep Memory topic is DROPPED when
 * its text opens with "Durable understanding" or mentions a "saved-on stamp"
 * (case-insensitive), and a heading-less topic left with nothing is removed.
 * Every other leading paragraph stays what it was: a note under "General".
 * An entry that has an id is never touched, template words or not.
 */
export const MIGRATION_TEMPLATE_OPENING_RULE = /^\s*Durable understanding/;
export const MIGRATION_TEMPLATE_TEXT_RULE = /saved-on stamp/i;

/** Is this leading Deep Memory paragraph the scaffold's own words? The two rules above. */
function isMigrationTemplateParagraph(text: string): boolean {
	return MIGRATION_TEMPLATE_OPENING_RULE.test(text) || MIGRATION_TEMPLATE_TEXT_RULE.test(text);
}

/** A "(saved …)" stamp with the space before it, when there is one: "x (saved …)." reads "x." afterwards, not "x .". */
const SAVED_STAMP_WITH_LEADING_SPACE = / ?\(saved [^)]*\)/g;
/** `SAVED_STAMP` without the global flag: a `test` that never carries a lastIndex between calls. */
const HAS_SAVED_STAMP = /\(saved [^)]*\)/;

/**
 * The entry's text with every "(saved …)" stamp taken out. The stamp was how a
 * v1 memory dated a bullet; after migration the date lives in the metadata
 * comment, and a note that still carries the stamp says its date twice, once
 * in the room's context. Only a line that held a stamp changes: the stamp goes
 * with the space before it, any run of spaces the removal leaves inside the
 * line collapses to one (its indentation is kept: a sub-bullet stays nested),
 * its trailing spaces go, and a line the removal leaves empty is dropped.
 * Every other line keeps its bytes — trailing spaces included, they are
 * identity under the line model. A text the removal would leave empty comes
 * back as it was: migration never deletes an entry.
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
 * Assigns an id to every entry that has none, and gives Deep Memory prose a
 * topic to live under. Kinds: an Active Items entry is an open item; a Deep
 * Memory entry is a practice or a fact by the two rules above. Saved-on comes
 * from a "(saved YYYY-MM-DD)" stamp inside the entry when there is one, else
 * from `fallbackSaved` — and once the date is taken the stamp itself leaves
 * the text (`withoutSavedStamps`). A must-keep marker anywhere in the entry
 * pins it. The scaffold's own opening paragraph is dropped (the template rule
 * above). Idempotent: an entry that has an id is never touched, so an
 * already-migrated document is returned unchanged with `assigned: 0`.
 */
export function migrateMemoryDocument(doc: MemoryDocument, opts: { fallbackSaved: string }): { doc: MemoryDocument; assigned: number } {
	const next = cloneDocument(doc);
	const eol = memoryDocumentEol(next);
	// The scaffold's own opening paragraph leaves first (the template rule), and
	// a heading-less topic it was the whole of leaves with it.
	const leading = next.topics.find((t) => t.section === "Deep Memory");
	if (leading && leading.heading === null) {
		leading.entries = leading.entries.filter((entry) => entry.id || !isMigrationTemplateParagraph(entry.text));
		if (leading.entries.length === 0 && isBlank(leading.intro)) next.topics.splice(next.topics.indexOf(leading), 1);
	}
	const deepTopics = next.topics.filter((t) => t.section === "Deep Memory");
	// Prose Deep Memory (no subsection at all) becomes one topic, "General".
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

// --- Rendering ---------------------------------------------------------------

export type MemoryRenderMode = "storage" | "context";

export interface MemoryRenderOptions {
	/** Per-topic archive counts, rendered as one pointer line per topic that has them. */
	archiveIndex?: ArchiveIndex;
	/**
	 * Write every entry's id into its own first line, as `- [m-0031] …` (a
	 * paragraph entry takes the same marker without a bullet) and a pinned one as
	 * `- [m-0032 · pinned] …`. The context render only: storage keeps its
	 * metadata comments, which carry the id already.
	 */
	entryIds?: boolean;
	/**
	 * Render ONLY these sections and nothing else — no preamble, no Chronos, no
	 * Recent Context, no other section. This is how the fold prompt reads a
	 * memory: the two sections a fold changes, in their canonical order.
	 */
	sections?: readonly MemorySection[];
}

/** The bullet a line opens with, marker and its spacing included — where an inline id goes. */
const BULLET_PREFIX = /^\s*(?:[-*+]|\d+[.)])\s+/;

/**
 * The entry's own lines with its address written into the first of them. The id
 * is the fold's handle on the entry, so it travels where the entry's words are
 * rather than in a list beside them: a list of 800 rows costs more than the
 * memory it points at.
 */
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

/** "2026-07" as a person says it: "Jul 2026". An unparseable stamp reads as nothing. */
function archiveMonthLabel(month: string): string {
	const parts = /^(\d{4})-(\d{2})$/.exec(String(month ?? "").slice(0, 7));
	if (!parts) return "";
	const name = ARCHIVE_MONTH_NAMES[Number(parts[2]) - 1];
	return name ? `${name} ${parts[1]}` : "";
}

/**
 * The months a topic's archived notes span, in the fewest words that stay true:
 * one month reads "May 2026", one year reads "Mar to Jul 2026", and a range
 * that crosses new year names both years. Stamps nobody wrote read as nothing,
 * and the pointer line drops the clause rather than promising a date it has not
 * got.
 */
function archiveMonthRange(earliest: string, latest: string): string {
	const from = archiveMonthLabel(earliest);
	const to = archiveMonthLabel(latest);
	if (!from || !to) return from || to;
	if (from === to) return from;
	const sameYear = from.slice(-4) === to.slice(-4);
	return sameYear ? `${from.slice(0, 3)} to ${to}` : `${from} to ${to}`;
}

/**
 * The pointer a demoted topic always carries in context, so demotion is
 * disclosure and not forgetting: the room can see there is more AND is told how
 * to read it, by name — a pointer the room cannot follow is just a regret. One
 * note reads "1 older note"; the only cost of getting the plural right is one
 * branch.
 */
function archivePointerLine(row: ArchiveTopicIndexRow): string {
	const months = archiveMonthRange(row.earliest, row.latest);
	const noun = `${row.count} older ${row.count === 1 ? "note" : "notes"}`;
	return `_Archived: ${noun}${months ? ` from ${months}` : ""}; use memory_recall to read them._`;
}

function renderSection(doc: MemoryDocument, section: MemorySection, mode: MemoryRenderMode, eol: string, opts?: MemoryRenderOptions): string {
	const inlineIds = mode === "context" && opts?.entryIds === true;
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
			out.push(...splitLines(inlineIds ? withInlineEntryId(entry, eol) : entry.text), "");
		}
		const row = opts?.archiveIndex?.[memoryAreaId(section, topic.title)];
		if (mode === "context" && row && row.count > 0) out.push(archivePointerLine(row), "");
	}
	return out.join(eol) + eol;
}

/**
 * The two renders. `storage` is the file on disk: metadata comments and the id
 * counter included. `context` is what the room reads every turn: both stripped
 * (about fifteen tokens an entry), plus one archive pointer line at the end of
 * every topic that has archived entries, when an index is given.
 *
 * Everything this module does not own — the preamble, Chronos, Recent Context
 * and any other top-level section — is written back byte for byte, each other
 * section at its recorded position. `sections` asks for a PARTIAL render
 * instead: those sections alone, which is how a maintenance prompt reads the
 * part of the memory it may change without paying for the rest.
 */
export function renderMemoryDocument(doc: MemoryDocument, mode: MemoryRenderMode, opts?: MemoryRenderOptions): string {
	const eol = memoryDocumentEol(doc);
	if (opts?.sections) {
		const wanted = new Set(opts.sections);
		// The canonical order, whatever order the caller asked in.
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

/**
 * Has this file been through migration? True as soon as it carries the id
 * counter or a single entry metadata line — the two things only the storage
 * render writes. The store reads this to decide whether a read must migrate,
 * and the room boot reads it to stay byte-for-byte out of the way of a file
 * nobody has migrated yet.
 */
export function isMigratedMemoryDocument(l1b: string): boolean {
	return splitLines(l1b).some((line) => ENTRY_COUNTER_LINE.test(line) || ENTRY_META_LINE.test(line));
}

/**
 * The room's context render, from bytes to bytes: metadata comments and the id
 * counter stripped, one archive pointer line per topic that has archived
 * entries. THE NO-OP RULE: a file that has never been migrated is returned
 * verbatim — there is no metadata to strip, and a room's boot prompt must not
 * change the day this code ships. Every re-layout a parse-and-render would do
 * belongs to the migration write, which is a deliberate, archived, recorded
 * event; never to a read.
 */
export function renderMemoryContext(l1b: string, archiveText?: string): string {
	if (!isMigratedMemoryDocument(l1b)) return l1b;
	const index = archiveText && archiveText.trim() ? archiveIndex(parseArchive(archiveText)) : undefined;
	return renderMemoryDocument(parseMemoryDocument(l1b), "context", index ? { archiveIndex: index } : undefined);
}

/**
 * One FRAGMENT of memory text as a person reads it: the storage render's
 * metadata comments and id counter dropped, every other byte kept. The context
 * render above does this for a whole document, through the parser; a surface
 * that quotes a single area's text — the Review changes, say — has no document
 * to parse and reads the same two patterns directly, so the two renderings can
 * never disagree about what metadata is.
 */
export function stripMemoryMetadataLines(text: string): string {
	const eol = firstEol(text) ?? "\n";
	return splitLines(text)
		.filter((line) => !ENTRY_META_LINE.test(line) && !ENTRY_COUNTER_LINE.test(line))
		.join(eol);
}

// --- Sizes -------------------------------------------------------------------

/**
 * What the room pays for its durable memory: the CONTEXT render of Deep Memory
 * and Active Items, section headings included — the same two sections the
 * Review target covers, so the budget meter and the ranker speak one number.
 */
export function reviewTargetTokens(doc: MemoryDocument): number {
	const eol = memoryDocumentEol(doc);
	return estimateTokens(renderSection(doc, "Deep Memory", "context", eol) + renderSection(doc, "Active Items", "context", eol));
}

export function entryTokens(entry: MemoryEntry): number {
	return estimateTokens(entry.text);
}

// --- The area map ------------------------------------------------------------

export interface MemoryAreaRow {
	/** The entry's id. */
	id: string;
	topic: string;
	section: string;
	kind: EntryKind;
	pinned: boolean;
	saved: string;
	tokens: number;
	/** The entry's first line, trimmed — what the fold prompt and the card show. */
	firstLine: string;
	/** The whole entry, so the fold can refuse an add that repeats it. */
	text: string;
}

/** Every entry as one row, in document order: the map the fold prompt and the Memory pane read. */
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
			});
		}
	}
	return rows;
}

export function findEntry(doc: MemoryDocument, id: string): MemoryEntry | undefined {
	return findEntryLocation(doc, id)?.entry;
}

/** The entry and the topic holding it — what every edit needs. */
export function findEntryLocation(doc: MemoryDocument, id: string): { entry: MemoryEntry; topic: MemoryTopic } | undefined {
	if (!id) return undefined;
	for (const topic of doc.topics) {
		const entry = topic.entries.find((e) => e.id === id);
		if (entry) return { entry, topic };
	}
	return undefined;
}

// --- Ranking and demotion ----------------------------------------------------

function kindRank(kind: EntryKind): number {
	// Practices are what works; they outrank facts and items when the budget bites.
	return kind === "practice" ? 1 : 0;
}

/**
 * The demotion order, lowest value first — deterministic and total.
 * Pinned entries are not in it at all. Then, in order: practices rank above
 * facts and items; the more recently touched (`updated`, falling back to
 * `saved`) ranks higher; more `refs` ranks higher; ties go to the oldest
 * saved-on; the last tie-break is the id.
 */
export function rankEntriesForDemotion(doc: MemoryDocument): MemoryEntry[] {
	const entries = doc.topics.flatMap((t) => t.entries).filter((e) => !e.pinned);
	return entries.sort((a, b) => {
		const kinds = kindRank(a.kind) - kindRank(b.kind);
		if (kinds !== 0) return kinds;
		const touched = (a.updated ?? a.saved).localeCompare(b.updated ?? b.saved);
		if (touched !== 0) return touched;
		const refs = (a.refs ?? 0) - (b.refs ?? 0);
		if (refs !== 0) return refs;
		const saved = a.saved.localeCompare(b.saved);
		if (saved !== 0) return saved;
		return a.id.localeCompare(b.id);
	});
}

export interface DemotionResult {
	doc: MemoryDocument;
	demoted: MemoryEntry[];
	/** Estimated tokens still over budget when nothing demotable is left; 0 when the budget was reached. */
	overageTokens: number;
}

/**
 * Exactly what one entry costs the context render: its own lines plus the
 * terminator of the last line and the blank line after it. Lets the budget pass
 * subtract instead of re-rendering the whole memory once per demoted entry —
 * the number is identical either way, which the smoke checks.
 */
function contextEntryChars(entry: MemoryEntry, eol: string): number {
	return entry.text.length + 2 * eol.length;
}

/**
 * Brings Deep Memory + Active Items under the room's budget by taking entries
 * off the bottom of the ranking. Pinned entries, `keepIds` and every entry of a
 * topic in `keepTopics` (addresses as `memoryTopicAddress` writes them) are
 * never taken. `today` is the run's date: what this run just saved goes last,
 * so a fold's own material is never archived by the same run's budget pass
 * unless nothing else is left. Pure — it returns a new document and the
 * entries that left; writing them to the archive is the caller's step.
 */
export function demoteToBudget(doc: MemoryDocument, budgetTokens: number, opts: { keepIds?: string[]; keepTopics?: string[]; today: string }): DemotionResult {
	const next = cloneDocument(doc);
	const eol = memoryDocumentEol(next);
	const keep = new Set(opts.keepIds ?? []);
	const keptTopics = new Set((opts.keepTopics ?? []).map(memoryTopicAddressKey));
	if (keptTopics.size > 0) {
		for (const topic of next.topics) {
			if (keptTopics.has(memoryTopicAddressKey(memoryTopicAddress(topic.section, topic.title)))) for (const entry of topic.entries) keep.add(entry.id);
		}
	}
	const ranked = rankEntriesForDemotion(next).filter((e) => !keep.has(e.id));
	const order = [...ranked.filter((e) => e.saved !== opts.today), ...ranked.filter((e) => e.saved === opts.today)];
	const demoted: MemoryEntry[] = [];
	let chars = renderSection(next, "Deep Memory", "context", eol).length + renderSection(next, "Active Items", "context", eol).length;
	for (const entry of order) {
		if (estimateTokensFromChars(chars) <= budgetTokens) break;
		for (const topic of next.topics) {
			const at = topic.entries.indexOf(entry);
			if (at >= 0) { topic.entries.splice(at, 1); break; }
		}
		chars -= contextEntryChars(entry, eol);
		demoted.push(entry);
	}
	return { doc: next, demoted, overageTokens: Math.max(0, estimateTokensFromChars(chars) - budgetTokens) };
}

// --- The archive file (`L1b/archive/entries.md`) ------------------------------

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
		return { ...entry, archived: fields.archived ?? "", why, topic: fields.topic ?? (section === "Active Items" ? MEMORY_ACTIVE_ITEMS_TOPIC : MEMORY_GENERAL_TOPIC), section };
	});
}

function archiveBlocks(entries: ArchivedEntry[], eol: string): string {
	return entries.map((entry) => `${archivedMetadataLine(entry)}${eol}${entry.text}${eol}${eol}`).join("");
}

export function renderArchive(entries: ArchivedEntry[], eol = "\n"): string {
	return archivePreamble(eol) + archiveBlocks(entries, eol);
}

/** Appends demoted, superseded, closed or deleted entries; an empty file gets the header first. */
export function appendToArchive(text: string, entries: MemoryEntry[], meta: Array<{ archived: string; why: ArchiveReason; topic: string; section: MemorySection }>): string {
	const eol = firstEol(text) ?? "\n";
	if (meta.length !== entries.length) throw new Error("appendToArchive needs one metadata record per entry");
	const archived: ArchivedEntry[] = entries.map((entry, i) => ({ ...cloneEntry(entry), ...meta[i] }));
	const head = text.trim() ? text.replace(/(\r\n|[\n\r\u2028\u2029])+$/, "") + eol + eol : archivePreamble(eol);
	return head + archiveBlocks(archived, eol);
}

/** Takes one entry back out — what a restore does before it re-inserts. Any text above the first entry is kept. */
export function removeFromArchive(text: string, id: string): { text: string; entry?: ArchivedEntry } {
	const eol = firstEol(text) ?? "\n";
	const entries = parseArchive(text);
	const entry = entries.find((e) => e.id === id);
	if (!entry) return { text };
	const firstMeta = splitLines(text).findIndex((line) => ENTRY_META_LINE.test(line));
	const head = firstMeta > 0 ? splitLines(text).slice(0, firstMeta).join(eol) + eol : archivePreamble(eol);
	return { text: head + archiveBlocks(entries.filter((e) => e !== entry), eol), entry };
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

/** Puts an archived entry back into its topic, at the end; a topic that is gone is created. */
export function restoreEntry(doc: MemoryDocument, archived: ArchivedEntry): MemoryDocument {
	const next = cloneDocument(doc);
	const topic = topicFor(next, archived.section, archived.topic);
	const entry: MemoryEntry = { id: archived.id, kind: archived.kind, saved: archived.saved, pinned: archived.pinned, text: archived.text };
	if (archived.from) entry.from = archived.from;
	if (archived.status) entry.status = archived.status;
	if (archived.updated) entry.updated = archived.updated;
	if (archived.refs !== undefined) entry.refs = archived.refs;
	topic.entries.push(entry);
	const n = entryNumber(entry.id);
	if (n !== null && n >= next.nextEntryNumber) next.nextEntryNumber = n + 1;
	return next;
}

/**
 * `restoreEntry` for many at once, with ONE copy of the document: a run that
 * puts hundreds of budget rows back before ranking them again would otherwise
 * copy a large memory once per row on every keep.
 */
export function restoreEntries(doc: MemoryDocument, archived: readonly ArchivedEntry[]): MemoryDocument {
	const next = cloneDocument(doc);
	for (const row of archived) {
		const topic = topicFor(next, row.section, row.topic);
		const entry: MemoryEntry = { id: row.id, kind: row.kind, saved: row.saved, pinned: row.pinned, text: row.text };
		if (row.from) entry.from = row.from;
		if (row.status) entry.status = row.status;
		if (row.updated) entry.updated = row.updated;
		if (row.refs !== undefined) entry.refs = row.refs;
		topic.entries.push(entry);
		const n = entryNumber(entry.id);
		if (n !== null && n >= next.nextEntryNumber) next.nextEntryNumber = n + 1;
	}
	return next;
}

// --- User edits --------------------------------------------------------------

export type MemoryUserEdit =
	| { op: "edit"; id: string; text: string; today?: string }
	| { op: "delete"; id: string }
	| { op: "pin"; id: string }
	| { op: "unpin"; id: string }
	| { op: "move"; id: string; topic: string }
	| { op: "status"; id: string; status: ItemStatus; today?: string }
	| { op: "add"; topic: string; kind: EntryKind; text: string; saved: string };

/**
 * One user edit from the Memory pane, applied to a copy. Nothing here involves
 * a model; the route turns the result into a normal write (snapshot, event
 * record, Chronos stamp). A delete hands the entry back so the caller can
 * archive it with why=user.
 */
export function applyUserEdit(doc: MemoryDocument, edit: MemoryUserEdit): { doc: MemoryDocument; archived?: MemoryEntry } {
	const next = cloneDocument(doc);
	if (edit.op === "add") {
		const topic = topicFor(next, edit.kind === "item" ? "Active Items" : "Deep Memory", edit.topic);
		const entry: MemoryEntry = { id: formatEntryId(next.nextEntryNumber), kind: edit.kind, saved: edit.saved, pinned: MUST_KEEP_MARKER.test(edit.text), text: edit.text };
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
			entry.text = edit.text;
			entry.pinned = entry.pinned || MUST_KEEP_MARKER.test(edit.text);
			if (edit.today) entry.updated = edit.today;
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

/**
 * The topic of that title, or a new one at the end of its section. The intended
 * section is looked at first, then the other one (a move to "Active Items"
 * finds the implicit list wherever the caller came from); `intendedSection` also
 * decides where a title nobody has yet is created.
 */
function topicFor(doc: MemoryDocument, intendedSection: MemorySection, title: string): MemoryTopic {
	const existing = doc.topics.find((t) => t.section === intendedSection && t.title === title) ?? doc.topics.find((t) => t.title === title);
	if (existing) return existing;
	const section: MemorySection = title === MEMORY_ACTIVE_ITEMS_TOPIC ? "Active Items" : intendedSection;
	const topic: MemoryTopic = { section, title, heading: `### ${title}`, intro: "", entries: [] };
	// New topics go at the end of their own section, never after another's:
	// Deep Memory renders before Active Items, so a first Deep Memory topic goes
	// to the front and a first Active Items topic to the back.
	let last = -1;
	doc.topics.forEach((t, i) => { if (t.section === section) last = i; });
	doc.topics.splice(last >= 0 ? last + 1 : section === "Deep Memory" ? 0 : doc.topics.length, 0, topic);
	return topic;
}

// --- Copies ------------------------------------------------------------------

function cloneEntry(entry: MemoryEntry): MemoryEntry {
	return { ...entry };
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
