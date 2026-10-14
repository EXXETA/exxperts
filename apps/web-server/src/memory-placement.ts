// Where a text with no home goes: the last rungs of Memorize's ladder.
//
// A page the model could not fold is placed under a topic, never in
// Unsorted: first by one tiny call (rung 5: the topic titles in, one title
// out), then by code, which cannot fail (rung 6): under the Deep Memory topic
// whose notes it matches best in the room's own BM25 index, when the match
// clears a floor; else under a topic named after the page. The note keeps its
// `summary` mark, so the next re-read refines it.
//
// The topic builder lives here too: the smaller memory a page's pieces are
// folded against (the ladder's rung 3); and the one-time sort's call, which
// names a topic for up to SORT_BATCH notes an older Memorize left in Unsorted.

import { FOLD_TOPIC_TITLE_MAX_CHARS, FOLD_UNSORTED_TOPIC } from "./absorb-ops.js";
import type { MemoryDocument } from "./memory-entries.js";
import { rememberTitleFromWords, topicTitleFromWords } from "./remember-two-stage.js";
import { buildIndex, normalizeSearchText, search } from "./memory-search-index.js";

/** How many distinct words a page must share with a topic's notes to be placed under it. */
export const PLACEMENT_MIN_MATCHED_WORDS = 3;
/** How many of the topics a text matches best the topic builder shows whole. */
export const TOPIC_VIEW_RELATED = 3;
/** How much of a note the placement call reads. */
const PLACEMENT_TEXT_CHARS = 1500;

/** Notes the one-time sort names topics for in one call. */
export const SORT_BATCH = 20;

const UNSORTED = normalizeSearchText(FOLD_UNSORTED_TOPIC);
/** The topic older files filed what had no home under. */
export const isUnsorted = (title: string) => normalizeSearchText(title) === UNSORTED;

/** The Deep Memory topics' own notes as search documents: a page placed earlier must not pull the next one in by shared wording. */
function topicNotes(doc: MemoryDocument) {
	return doc.topics
		.filter((topic) => topic.section === "Deep Memory" && !isUnsorted(topic.title))
		.flatMap((topic) => topic.entries.filter((entry) => !entry.summary).map((entry) => ({ id: entry.id, source: "note" as const, topic: topic.title, date: entry.saved ?? "", text: entry.text })));
}

/** The topics a text matches, best first, each above the floor. */
function matchingTopics(doc: MemoryDocument, text: string, limit: number, floor = PLACEMENT_MIN_MATCHED_WORDS): string[] {
	const notes = topicNotes(doc);
	if (notes.length === 0) return [];
	const titles: string[] = [];
	for (const hit of search(buildIndex(notes), text, { limit: 50 })) {
		if (hit.matched.length < floor || !hit.doc.topic || titles.includes(hit.doc.topic)) continue;
		titles.push(hit.doc.topic);
		if (titles.length === limit) break;
	}
	return titles;
}

/**
 * The one-time sort's code placement when no call named a topic: the topic
 * whose notes share the most with the note, at a floor of one real word (the
 * index drops stopwords; a word of two letters or fewer does not count either).
 * The higher score wins, and an equal score goes to the earlier topic. Null
 * when the note shares no word with any topic.
 */
export function sortByCode(doc: MemoryDocument, text: string): string | null {
	const notes = topicNotes(doc);
	if (notes.length === 0) return null;
	const order = doc.topics.map((topic) => topic.title);
	const best = new Map<string, number>();
	for (const hit of search(buildIndex(notes), text, { limit: 200 })) {
		if (!hit.doc.topic || !hit.matched.some((word) => word.length > 2)) continue;
		best.set(hit.doc.topic, Math.max(best.get(hit.doc.topic) ?? 0, hit.score));
	}
	return [...best].sort(([left, a], [right, b]) => b - a || order.indexOf(left) - order.indexOf(right))[0]?.[0] ?? null;
}

/**
 * Code's place for the notes no reply filed, Memorize's sort and Review's
 * tail alike: the topic that shares the most words with each; the notes that
 * share none open one topic together, named by the first one's own first
 * words, never one topic each.
 */
export function codeSorter(): (doc: MemoryDocument, text: string) => string {
	let unmatched: string | undefined;
	return (doc, text) => sortByCode(doc, text) ?? (unmatched ??= sharedTopicTitle(doc, text));
}

function sharedTopicTitle(doc: MemoryDocument, text: string): string {
	const title = topicTitleFromWords(text.split("\n")[0]);
	return /[\p{L}\p{N}]{2}/u.test(title) && !isUnsorted(title) ? title : placeByCode(doc, text, "");
}

/**
 * The topic for a page with no home: the best match above the floor, else the
 * page's own title, else the note's own first words; never a date and never a
 * name the app made up. A saved note always has words, so the room's first
 * topic is only there to keep the function total.
 */
export function placeByCode(doc: MemoryDocument, text: string, title: string): string {
	const best = matchingTopics(doc, text, 1)[0];
	if (best) return best;
	const usable = (candidate: string) => /[\p{L}\p{N}]{2}/u.test(candidate) && !isUnsorted(candidate) && !/^Conversation of \d{4}-\d{2}-\d{2}$/.test(candidate);
	const cut = (words: string) => (words.length > FOLD_TOPIC_TITLE_MAX_CHARS ? words.slice(0, FOLD_TOPIC_TITLE_MAX_CHARS + 1).replace(/\s+\S*$/, "").trim() : words);
	const own = cut(title.replace(/^#+\s*/, "").replace(/\s+/g, " ").trim());
	if (usable(own)) return own;
	const words = cut(rememberTitleFromWords(text));
	if (usable(words)) return words;
	return doc.topics.find((topic) => topic.section === "Deep Memory" && !isUnsorted(topic.title))?.title ?? (own || words || "Notes");
}

/**
 * The topic builder: the memory a piece of a page is folded against. Every
 * topic keeps its title (the topic map), every open item and every pinned
 * note stay, and the `related` topics the text matches best keep all their
 * notes; the rest of the notes are left out. `related` 0 is the map alone.
 */
export function topicView(doc: MemoryDocument, text: string, related = TOPIC_VIEW_RELATED): MemoryDocument {
	const whole = new Set(related > 0 ? matchingTopics(doc, text, related) : []);
	return {
		...doc,
		topics: doc.topics.map((topic) => ({
			...topic,
			entries: topic.section !== "Deep Memory" ? topic.entries.filter((entry) => entry.status !== "done") : whole.has(topic.title) ? topic.entries : topic.entries.filter((entry) => entry.pinned),
		})),
	};
}

/** Rung 5: the tiny question that names one topic for a note (draft). */
export function buildPlacementPrompt(doc: MemoryDocument, text: string): string {
	const titles = doc.topics.filter((topic) => topic.section === "Deep Memory" && !isUnsorted(topic.title)).map((topic) => `- ${topic.title}`);
	const note = text.length > PLACEMENT_TEXT_CHARS ? `${text.slice(0, PLACEMENT_TEXT_CHARS).trimEnd()}...` : text;
	return [
		"Here are the topic titles of a memory. Answer with the one title this note belongs under, or a new title of at most 4 words. Answer with the title only.",
		"",
		"Topics:",
		...(titles.length ? titles : ["(none yet)"]),
		"",
		"Note:",
		note.trim(),
	].join("\n");
}

/** The title a placement reply names: an existing topic as memory spells it, or a new one of at most 4 words; null when the reply names neither. */
export function readPlacement(doc: MemoryDocument, reply: string): string | null {
	const line = reply.split("\n").map((part) => part.replace(/^[\s>*#-]+|[\s*.:"'`]+$/g, "").replace(/^["'`]+/, "").trim()).find(Boolean);
	if (!line || isUnsorted(line)) return null;
	const existing = doc.topics.find((topic) => topic.section === "Deep Memory" && normalizeSearchText(topic.title) === normalizeSearchText(line));
	if (existing) return existing.title;
	return line.split(/\s+/).length <= 4 && line.length <= FOLD_TOPIC_TITLE_MAX_CHARS && /[\p{L}\p{N}]{2}/u.test(line) ? line : null;
}

/** The one-time sort's call: each note by its id, answered one line each as "<id>: <title>" (draft). */
export function buildSortPrompt(doc: MemoryDocument, notes: ReadonlyArray<{ id: string; text: string }>): string {
	const titles = doc.topics.filter((topic) => topic.section === "Deep Memory" && !isUnsorted(topic.title)).map((topic) => `- ${topic.title}`);
	const line = (text: string) => text.replace(/\s+/g, " ").trim().slice(0, 300);
	return [
		"Here are the topic titles of a memory, and notes that have no topic yet. For each note, answer one line: its id, a colon, and the one title it belongs under, or a new title of at most 4 words.",
		"",
		"Topics:",
		...(titles.length ? titles : ["(none yet)"]),
		"",
		"Notes:",
		...notes.map((note) => `- ${note.id}: ${line(note.text)}`),
	].join("\n");
}

/** The topic a named title means in the document as it now stands: one already there in another case or spacing, else the title itself. */
export function topicNamed(doc: MemoryDocument, title: string): string {
	const plain = title.replace(/\s+/g, " ").trim();
	const key = plain.toLocaleLowerCase();
	return doc.topics.find((topic) => topic.section === "Deep Memory" && topic.title.replace(/\s+/g, " ").trim().toLocaleLowerCase() === key)?.title ?? plain;
}

/** The titles a sort reply names, by note id; a line naming no usable title names none. */
export function readSort(doc: MemoryDocument, reply: string): Map<string, string> {
	const titles = new Map<string, string>();
	for (const line of reply.split("\n")) {
		// "m-0101: Title", also numbered ("1. m-0101: Title") or in bold ("**m-0101**: Title").
		const named = /^[\s>*-]*(?:\d+[.)]\s*)?\**([a-z]+-\d+)\**\s*:\s*\**\s*(.+)$/i.exec(line);
		const title = named ? readPlacement(doc, named[2]) : null;
		if (named && title) titles.set(named[1], title);
	}
	return titles;
}
