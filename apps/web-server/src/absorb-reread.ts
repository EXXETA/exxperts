// Memorize re-reads a summary note: the rules for a note a fold filed whole.
//
// A conversation the fold could not read is filed as its summary, one note in
// "Unsorted" marked `summary`. A later Memorize reads that note again as if it
// were a page, after its waiting conversations, so the conversation's points
// can still reach their topics. This module holds the rules; the run
// (absorb-run.ts) folds the page through the same page core as any other and
// asks these helpers what to read, how, and what the ending means:
//   - which notes: summary notes in Unsorted, not pinned, that the run's Memory
//     model has not tried, oldest learned first and undated last, at most
//     REREAD_CAP a run;
//   - the page: the note's text without its must-keep lines, dated with the
//     note's learned day or with none. The note itself is left out of the
//     memory the fold reads and decides against: otherwise every point it gives
//     back is the same as the note, left out, and the note's archive would
//     take the words out of memory;
//   - the ending: a page that folded sorted the note, which the save archives
//     whole; any other ending leaves it. `tried` records each model that got an
//     answer from its page, so it is read once per model; an outage or a
//     cancel records nothing.
// The page is known by the NOTE's id everywhere. Its `from`, a Recent Context
// id that may belong to a new waiting conversation of the same run, is only
// what the notes it gives back say they came from.

import type { PageEnding } from "./absorb-run-pages.js";
import { SUMMARY_TOPIC } from "./absorb-summary.js";
import { cloneDocument, hasMustKeepMarker, scanDeepMemoryEntries, withoutMustKeepMarkers, type MemoryDocument, type MemoryEntry, type MemorySection } from "./memory-entries.js";

/** At most this many summary notes are re-read in one run. */
export const REREAD_CAP = 5;

/**
 * A Memory model as a note's `tried` names it: provider/model, with "%" and ","
 * written as %25 and %2C, since `tried` holds its models comma-separated and a
 * model id may carry a comma.
 */
export function rereadModelKey(model: { provider: string; model: string }): string {
	const encode = (part: string) => part.replace(/%/g, "%25").replace(/,/g, "%2C");
	return `${encode(model.provider)}/${encode(model.model)}`;
}

function inSummaryTopic(title: string): boolean {
	return title.trim().toLowerCase() === SUMMARY_TOPIC.toLowerCase();
}

/** A summary note filed in Unsorted: what Review's tidy is told to file under its topic. */
export function isUnsortedSummary(topic: string, entry: Pick<MemoryEntry, "summary">): boolean {
	return inSummaryTopic(topic) && entry.summary === true;
}

/** An Unsorted summary note a saved Memorize already read again: the Maintain hint and Review's first read count these. */
export function waitsUnsortedAfterReread(topic: string, entry: Pick<MemoryEntry, "summary" | "tried">): boolean {
	return isUnsortedSummary(topic, entry) && (entry.tried ?? []).length > 0;
}

/** How many notes wait unsorted after a re-read, by a line scan of the memory file: the Maintain hint's count. */
export function unsortedAfterRereadCount(l1b: string): number {
	return scanDeepMemoryEntries(l1b).filter(({ topic, entry }) => waitsUnsortedAfterReread(topic, entry)).length;
}

/** The same notes in a parsed memory, by the Deep Memory topic they wait in: Review's first read counts and tidies these. */
export function unsortedAfterRereadTopics(doc: MemoryDocument): Array<{ title: string; count: number }> {
	return doc.topics
		.filter((topic) => topic.section === "Deep Memory")
		.map((topic) => ({ title: topic.title, count: topic.entries.filter((entry) => waitsUnsortedAfterReread(topic.title, entry)).length }))
		.filter((topic) => topic.count > 0);
}

/**
 * The summary notes this run re-reads, in the order it reads them: oldest
 * learned first, then the undated, each group in memory order. A note with
 * nothing left once its must-keep lines are out has nothing to re-read, so it
 * never takes one of the run's places.
 */
export function selectRereads(doc: MemoryDocument, model: { provider: string; model: string }, cap = REREAD_CAP): MemoryEntry[] {
	const key = rereadModelKey(model);
	const notes = doc.topics
		.filter((topic) => inSummaryTopic(topic.title))
		.flatMap((topic) => topic.entries)
		.filter((entry) => entry.summary && !entry.pinned && !(entry.tried ?? []).includes(key) && withoutMustKeepLines(entry.text) !== "");
	const dated = notes.filter((entry) => entry.learned).sort((a, b) => (a.learned! < b.learned! ? -1 : a.learned! > b.learned! ? 1 : 0));
	return [...dated, ...notes.filter((entry) => !entry.learned)].slice(0, cap);
}

const BULLET = /^(\s*)(?:[-*+]|\d+[.)])\s+/;

function indentOf(line: string): number {
	return line.length - line.trimStart().length;
}

/** The note's lines without a must-keep line and the deeper lines that continue it: those are pinned notes of their own. */
function withoutMustKeepLines(text: string): string {
	const lines = text.split("\n");
	const kept: string[] = [];
	for (let i = 0; i < lines.length; i++) {
		if (!hasMustKeepMarker(lines[i])) { kept.push(lines[i]); continue; }
		const indent = indentOf(lines[i]);
		while (i + 1 < lines.length && lines[i + 1].trim() && indentOf(lines[i + 1]) > indent) i++;
	}
	return kept.join("\n").trim();
}

export interface RereadPage {
	/** The note's id: the page's key, its card row and its session id in the prompt. */
	id: string;
	/** The note's head line. */
	title: string;
	/** The note's learned day, or "" when it has none. */
	date: string;
	/** What the fold reads: the note's text without its must-keep lines. */
	text: string;
	/** What the notes it gives back say they came from: the note's own `from`, or none. */
	from?: string;
	/** Where the note stands, for its archive row. */
	section: MemorySection;
	topic: string;
	/** The note as it stood when its page began. */
	note: MemoryEntry;
	/** The memory the fold reads and applies to: the working document without the note. */
	doc: MemoryDocument;
}

/**
 * The page for one summary note of the working document, or null when there is
 * nothing to re-read: the note is gone or no longer a summary (an earlier page
 * of the run superseded or closed it), or nothing is left of it once its
 * must-keep lines are out.
 */
export function rereadPage(doc: MemoryDocument, noteId: string): RereadPage | null {
	const at = doc.topics.findIndex((topic) => topic.entries.some((entry) => entry.id === noteId));
	if (at < 0) return null;
	const topic = doc.topics[at];
	const note = topic.entries.find((entry) => entry.id === noteId)!;
	if (!note.summary) return null;
	const text = withoutMustKeepLines(note.text);
	if (!text) return null;
	const without = cloneDocument(doc);
	without.topics[at].entries = without.topics[at].entries.filter((entry) => entry.id !== noteId);
	const head = withoutMustKeepMarkers(text.split("\n")[0].replace(BULLET, "").trim());
	return {
		id: note.id,
		title: head || note.id,
		date: note.learned ?? "",
		text,
		...(note.from ? { from: note.from } : {}),
		section: topic.section,
		topic: topic.title,
		note: { ...note, ...(note.tried ? { tried: [...note.tried] } : {}) },
		doc: without,
	};
}

/** The page folded: the note is sorted, and the save archives it whole. */
export function rereadSorted(ending: PageEnding): boolean {
	return ending.kind === "folded";
}

/** The model answered for this page, or refused its size: it has tried the note. An outage or a cancel is not the page's doing. */
export function rereadTriedOn(ending: PageEnding): boolean {
	return ending.kind !== "outage" && ending.kind !== "cancelled";
}

/** The note with the model added to its `tried`, once. */
export function withTried(entry: MemoryEntry, key: string): MemoryEntry {
	const tried = entry.tried ?? [];
	return { ...entry, tried: tried.includes(key) ? [...tried] : [...tried, key] };
}
