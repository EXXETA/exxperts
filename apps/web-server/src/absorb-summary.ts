// Memorize never gets stuck: the summary fallback.
//
// When a fold gives nothing usable for a conversation (its reply stayed
// unreadable after the one retry or nothing of it landed, its prompt did not
// fit the window, its apply threw, or its call failed in two runs while the
// model answered), the conversation is not left waiting forever. Its approved
// page, the summary the person saw when they chose Remember, is filed as notes by
// code, with no model call and no decision:
//   - the title, the session arc and the Body become ONE note in "Unsorted",
//     the title its one top-level bullet and the rest nested under it, so it
//     reads as one note, apart from the next, wherever memory is shown;
//   - each Body line marked **must-keep** leaves that note and is filed as its
//     own note, which the applier pins, so the summary note is never pinned;
//   - each Parked line becomes an open item, unless Parked says None;
//   - a block written by hand, without those fields, becomes one note.
// The ops are made here and go straight to the applier: the fold's rules are
// for a model's reply, and this note is long by design.

import { applyFoldOps, type AppliedFold, type FoldOp } from "./absorb-ops.js";
import { findStructuralLine, hasMustKeepMarker, withoutMustKeepMarkers, type MemoryDocument } from "./memory-entries.js";

/** The topic a summary note is filed under, until a later Memorize or Review sorts it. */
export const SUMMARY_TOPIC = "Unsorted";

const RC_HEADING = /^#{1,6}\s+RC-/;
const COMMENT_LINE = /^\s*<!--/;
/** A heading's hashes as the memory file reads them: a run of # followed by whitespace or the end of the line (the STRUCTURAL_LINE rule). */
const HEADING_HASHES = /^\s*#+(?:\s+|$)/;
/** A field label, with its colon inside the bold or just after it. */
const FIELD_LABEL = /^\s*\*\*(Session arc|Body|Parked)(?::\*\*|\*\*:)\s*(.*)$/i;
/** "None" as the page contract writes an empty Parked, and the short whole-line ways a hand edit says the same. */
const NOTHING_PARKED = /^(?:none(?: yet)?|nothing(?: parked| deferred| pending)?|no open threads|n\/a)\.?$/i;
const BULLET = /^(\s*)(?:[-*+]|\d+[.)])\s+/;

export interface SummaryPage {
	/** The conversation's Recent Context id: every note filed here says it came from it. */
	id: string;
	/** The page's one descriptive line, as the Recent Context heading names it. */
	title: string;
	/** The block as it stands in Recent Context, heading line included. */
	text: string;
}

interface PageFields {
	arc: string[];
	body: string[];
	parked: string[];
	/** False for a block written by hand without the fields: all of it is `body`. */
	structured: boolean;
}

/**
 * A line the memory file could read as structure, made plain by the same rule
 * every other write path refuses it by (memory-entries.ts STRUCTURAL_LINE): a
 * comment line goes, and a heading's hashes go, again and again while the rest
 * still reads as one, and a line of hashes alone goes. Null: nothing is left.
 */
function plainLine(line: string): string | null {
	if (COMMENT_LINE.test(line)) return null;
	let rest = line;
	while (HEADING_HASHES.test(rest)) rest = rest.replace(HEADING_HASHES, "");
	if (rest === line) return line;
	return rest.trim() ? rest : null;
}

function plainLines(lines: string[]): string[] {
	return lines.map(plainLine).filter((line): line is string => line !== null);
}

const indentOf = (line: string) => (BULLET.exec(line)?.[1] ?? line.match(/^\s*/)![0]).length;

/** Lines grouped the way a bullet takes the deeper-indented lines that continue it. */
function bulletGroups(lines: string[]): string[][] {
	const groups: string[][] = [];
	for (const line of lines) {
		const head = groups[groups.length - 1]?.[0];
		if (head !== undefined && indentOf(line) > indentOf(head)) groups[groups.length - 1].push(line);
		else groups.push([line]);
	}
	return groups;
}

function pageFields(text: string): PageFields {
	const lines = text.replace(/\r\n?/g, "\n").split("\n");
	const content = lines.filter((line, i) => !(i === 0 && RC_HEADING.test(line)));
	const fields: PageFields = { arc: [], body: [], parked: [], structured: false };
	let current: string[] | null = null;
	const loose: string[] = [];
	for (const line of content) {
		const label = FIELD_LABEL.exec(line);
		if (label) {
			fields.structured = true;
			const name = label[1].toLowerCase();
			current = name === "session arc" ? fields.arc : name === "body" ? fields.body : fields.parked;
			if (label[2].trim()) current.push(label[2]);
			continue;
		}
		(current ?? loose).push(line);
	}
	if (!fields.structured) fields.body = loose;
	return {
		arc: plainLines(fields.arc).filter((line) => line.trim()),
		body: plainLines(fields.body).filter((line) => line.trim()),
		parked: plainLines(fields.parked).filter((line) => line.trim()),
		structured: fields.structured,
	};
}

/**
 * The must-keep lines, each with the deeper-indented lines that continue it,
 * taken out of the lines they sat in. What is left is the summary note's. A
 * must-keep line nested under another carries that parent line along as its
 * context; the parent stays in the summary note too.
 */
function splitMustKeep(lines: string[]): { rest: string[]; mustKeep: string[] } {
	const rest: string[] = [];
	const mustKeep: string[] = [];
	for (let i = 0; i < lines.length; i++) {
		if (!hasMustKeepMarker(lines[i])) { rest.push(lines[i]); continue; }
		const indent = indentOf(lines[i]);
		const parent = indent > 0 ? [...lines.slice(0, i)].reverse().find((line) => indentOf(line) < indent) : undefined;
		const block = [...(parent ? [parent.trim()] : []), parent ? lines[i] : lines[i].trim()];
		while (i + 1 < lines.length && indentOf(lines[i + 1]) > indent) block.push(lines[++i]);
		mustKeep.push(block.join("\n"));
	}
	return { rest, mustKeep };
}

/**
 * The summary note's text as one block: the head is its only top-level
 * bullet and every other line sits under it. A bullet moves in by one level
 * with the lines that continue it; any other line becomes a bullet of its own
 * there, so no line runs into the one before it when the note is rendered.
 */
function oneBlock(head: string, lines: string[]): string {
	const nested = lines.map((line) => {
		if (BULLET.test(line)) return `  ${line}`;
		if (indentOf(line) > 0) return `  ${line}`;
		return `  - ${line.trim()}`;
	});
	return [`- ${head}`, ...nested].join("\n");
}

/** The ops that file one page as its summary: made by code, never by a model. */
export function summaryFilingOps(page: SummaryPage): FoldOp[] {
	const fields = pageFields(page.text);
	const arc = splitMustKeep(fields.arc);
	const body = splitMustKeep(fields.body);
	// The title is made plain like every line, and never carries a must-keep
	// marker: that would pin the summary note.
	const rawTitle = page.title.replace(/\*\*must-keep\b[^*\n]*\*\*\s*[:\u2014-]?\s*/gi, "").replace(/\*\*must-keep\b/gi, "").trim();
	const title = rawTitle && rawTitle !== page.id ? (plainLine(rawTitle) ?? "").trim() : "";
	const content = [...arc.rest.map((line) => line.trim()), ...body.rest];
	// One item per Parked bullet, its continuation lines kept inside it.
	const parked = bulletGroups(fields.parked)
		.map((group) => [group[0].replace(BULLET, "").trim(), ...group.slice(1).map((line) => `  ${line.trim()}`)].join("\n"))
		.filter((item) => item && !NOTHING_PARKED.test(item));
	const mustKeep = [...arc.mustKeep, ...body.mustKeep];
	const ops: FoldOp[] = [];
	// The summary note holds the page's words; a page whose every line was
	// must-keep or parked still leaves its title as the note, unless it has none.
	if (content.length > 0 || (title && mustKeep.length === 0 && parked.length === 0)) {
		// A page with no title of its own is headed by its first line.
		const head = title || content[0].replace(BULLET, "").trim();
		ops.push({ op: "add", topic: SUMMARY_TOPIC, kind: "fact", text: oneBlock(head, title ? content : content.slice(1)) });
	}
	for (const line of [...arc.mustKeep, ...body.mustKeep]) ops.push({ op: "add", topic: SUMMARY_TOPIC, kind: "fact", text: line });
	for (const line of parked) ops.push({ op: "add", topic: SUMMARY_TOPIC, kind: "item", text: `- ${line}` });
	return ops;
}

/**
 * The line a page is known by when its heading names none: the head of the
 * note the filer would make of it, its title or else its first line of
 * content. Empty when the page holds nothing to name it by.
 */
export function summaryPageHead(page: SummaryPage): string {
	const first = summaryFilingOps(page)[0];
	return first && first.op === "add" ? withoutMustKeepMarkers(first.text.split("\n")[0].replace(BULLET, "").trim()) : "";
}

/**
 * Files one page as its summary into a copy of the working document. The
 * note that holds the page is marked `summary`, so a later re-read and the
 * Maintain hint can find it. Throws only when the applier throws; the caller
 * then leaves the page waiting.
 */
export function fileSessionAsSummary(doc: MemoryDocument, page: SummaryPage, ctx: { savedDate: string; nextEntryNumber: number; sessionDate?: string }): AppliedFold & { summaryNoteId?: string } {
	const ops = summaryFilingOps(page);
	// The backstop: a line the memory file would read as structure never
	// reaches the applier. The caller leaves the page waiting instead.
	for (const op of ops) if (op.op === "add" && findStructuralLine(op.text) !== null) throw new Error("a summary line would read as structure");
	const applied = applyFoldOps(doc, ops, { sessionId: page.id, savedDate: ctx.savedDate, nextEntryNumber: ctx.nextEntryNumber, ...(ctx.sessionDate ? { sessionDate: ctx.sessionDate } : {}) });
	const first = ops[0];
	const summaryNote = first && first.op === "add" && first.kind !== "item" && !hasMustKeepMarker(first.text) ? applied.record.added[0] : undefined;
	if (summaryNote) {
		for (const topic of applied.doc.topics) for (const entry of topic.entries) if (entry.id === summaryNote.id) entry.summary = true;
	}
	return { ...applied, ...(summaryNote ? { summaryNoteId: summaryNote.id } : {}) };
}
