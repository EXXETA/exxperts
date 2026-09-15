// What memory says twice (memory v2) — the pure layer.
//
// Two readers of a memory need the same answer to "do these two notes say one
// thing?": the fold, which refuses an add that repeats a note memory already
// holds, and the Review's first read, which lists the pairs a tidy should deal
// with. Both read this module, so a note the fold refuses as a twin is a note
// the first read would have listed, and the other way round. The same holds
// for topics: two headings that name one subject are found here with the one
// title predicate the fold and a move are judged by.
//
// Nothing here talks to a model, a route or the disk. A document goes in and
// pairs come out; the sentences a person reads are built here too, so the
// screen and the prompt cannot drift apart.
//
// The title predicate lives in absorb-ops.ts and this module's note predicate
// is read by absorb-ops.ts: the two modules import each other. Both export
// functions only and neither reads the other at load time, so the cycle is
// harmless; it is kept rather than broken by a third module because one
// predicate per question, in one place, is the point.

import { nearDuplicateTopicTitle } from "./absorb-ops.js";
import type { MemoryDocument, MemorySection } from "./memory-entries.js";

/** One note as a duplicate pair names it: where it lives and what it says. */
export interface DuplicateNoteRef {
	id: string;
	topic: string;
	section: MemorySection;
	text: string;
}

export interface DuplicateNotePair {
	a: DuplicateNoteRef;
	b: DuplicateNoteRef;
}

export interface LookAlikeTopicPair {
	a: string;
	b: string;
}

/** At most this many pairs come back from one document; a memory that says more than this twice is a memory for a Review, not a list. */
export const DUPLICATE_NOTE_PAIRS_MAX = 30;
/** Notes shorter than this, in words, are alike only when they are equal: five words that share four are two different points more often than one. */
export const NOTE_LOOKALIKE_MIN_WORDS = 6;
/** Two long notes whose word sets overlap this much say one thing. */
export const NOTE_LOOKALIKE_JACCARD = 0.8;
/** The sentence a person reads quotes at most this much of a note. */
const SENTENCE_LINE_MAX_CHARS = 120;

const LEADING_BULLET = /^\s*[-*+]\s+/;
/** The must-keep marker as the memory writes it: `**must-keep**`, `**must-keep:**`, `**must-keep —`. */
const MUST_KEEP_MARKERS = /\*\*must-keep\b:?\*{0,2}/gi;
/** The `(saved YYYY-MM-DD)` stamp older memories carry inside a note's words. */
const SAVED_STAMPS = /\(saved [^)]*\)/gi;
/** The address the context render writes into a note's first line: `[m-0031]`, `[m-0031 · pinned]`. */
const BRACKETED_IDS = /\[[A-Za-z][\w-]*(?:\s*·\s*pinned)?\]/g;
const LINE_TERMINATORS_G = /\r\n?|[\u2028\u2029]/g;

/** A note's words without the system's own marks: no bullet, no marker, no stamp, no id. Casing and punctuation kept. */
function stripNoteMarks(text: string): string {
	return text
		.replace(LEADING_BULLET, "")
		.replace(MUST_KEEP_MARKERS, "")
		.replace(SAVED_STAMPS, "")
		.replace(BRACKETED_IDS, "");
}

/**
 * A note reduced to the words it says: marks stripped, lowercased, letters and
 * digits of any alphabet kept and everything else a space, one space between
 * words. Two notes that normalise alike say one thing whatever their bullets,
 * stamps and punctuation.
 */
export function normalizeNoteText(text: string): string {
	return stripNoteMarks(text)
		.toLowerCase()
		.replace(/[^\p{L}\p{N}]+/gu, " ")
		.trim();
}

function wordsOf(normalized: string): string[] {
	return normalized ? normalized.split(" ") : [];
}

function jaccard(a: readonly string[], b: readonly string[]): number {
	const setA = new Set(a);
	const setB = new Set(b);
	let shared = 0;
	for (const word of setA) if (setB.has(word)) shared += 1;
	const union = setA.size + setB.size - shared;
	return union === 0 ? 0 : shared / union;
}

function normalizedLookAlike(a: string, b: string): boolean {
	// Two notes that say nothing do not say one thing.
	if (!a || !b) return false;
	if (a === b) return true;
	const wordsA = wordsOf(a);
	const wordsB = wordsOf(b);
	if (wordsA.length < NOTE_LOOKALIKE_MIN_WORDS || wordsB.length < NOTE_LOOKALIKE_MIN_WORDS) return false;
	if (` ${a} `.includes(` ${b} `) || ` ${b} `.includes(` ${a} `)) return true;
	return jaccard(wordsA, wordsB) >= NOTE_LOOKALIKE_JACCARD;
}

/**
 * Whether two notes say one thing: their normalised words are equal; or both
 * are at least six words and one contains the other as a phrase; or both are
 * at least six words and their word sets overlap by four fifths or more.
 */
export function noteTextsLookAlike(a: string, b: string): boolean {
	return normalizedLookAlike(normalizeNoteText(a), normalizeNoteText(b));
}

/**
 * Every pair of notes in the document that look alike — both sections, every
 * topic, notes that carry an id — each pair once, in the document order of
 * the pair's first member, at most thirty of them.
 */
export function findDuplicateNotePairs(doc: MemoryDocument): DuplicateNotePair[] {
	const notes: (DuplicateNoteRef & { normalized: string })[] = [];
	for (const topic of doc.topics) {
		for (const entry of topic.entries) {
			if (!entry.id) continue;
			notes.push({ id: entry.id, topic: topic.title, section: topic.section, text: entry.text, normalized: normalizeNoteText(entry.text) });
		}
	}
	const pairs: DuplicateNotePair[] = [];
	for (let i = 0; i < notes.length && pairs.length < DUPLICATE_NOTE_PAIRS_MAX; i++) {
		for (let j = i + 1; j < notes.length && pairs.length < DUPLICATE_NOTE_PAIRS_MAX; j++) {
			if (!normalizedLookAlike(notes[i].normalized, notes[j].normalized)) continue;
			const { normalized: _a, ...a } = notes[i];
			const { normalized: _b, ...b } = notes[j];
			pairs.push({ a, b });
		}
	}
	return pairs;
}

/**
 * Every pair of topic titles in one section that name one subject by the fold's
 * own title predicate, each pair once, in document order.
 */
export function findLookAlikeTopics(doc: MemoryDocument): LookAlikeTopicPair[] {
	const pairs: LookAlikeTopicPair[] = [];
	for (let i = 0; i < doc.topics.length; i++) {
		for (let j = i + 1; j < doc.topics.length; j++) {
			if (doc.topics[i].section !== doc.topics[j].section) continue;
			if (nearDuplicateTopicTitle(doc.topics[i].title, [doc.topics[j].title]) === undefined) continue;
			pairs.push({ a: doc.topics[i].title, b: doc.topics[j].title });
		}
	}
	return pairs;
}

/** The first line of a note as a person reads it: marks gone, casing and punctuation kept, cut at 120 characters. */
function noteLine(text: string): string {
	const first = stripNoteMarks(text).replace(LINE_TERMINATORS_G, "\n").split("\n").find((line) => line.trim()) ?? "";
	const one = first.replace(LEADING_BULLET, "").replace(/\s+/g, " ").trim();
	return one.length <= SENTENCE_LINE_MAX_CHARS ? one : `${one.slice(0, SENTENCE_LINE_MAX_CHARS - 1)}…`;
}

/** `"Topic A" and "Topic B" both say: <line>`, or `"Topic A" says twice: <line>` when the pair sits under one topic. The line is the shorter note's. */
export function duplicateNoteSentence(pair: DuplicateNotePair): string {
	const shorter = pair.a.text.length <= pair.b.text.length ? pair.a : pair.b;
	const line = noteLine(shorter.text);
	const sameTopic = pair.a.topic === pair.b.topic && pair.a.section === pair.b.section;
	return sameTopic ? `"${pair.a.topic}" says twice: ${line}` : `"${pair.a.topic}" and "${pair.b.topic}" both say: ${line}`;
}

/** `"A" and "B" look like one topic.` */
export function lookAlikeTopicSentence(pair: LookAlikeTopicPair): string {
	return `"${pair.a}" and "${pair.b}" look like one topic.`;
}
