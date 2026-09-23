// What memory says twice, or differently (memory v2) — the pure layer.
//
// Two readers of a memory need the same answer to "do these two notes say one
// thing?": the fold, which refuses an add that repeats a note memory already
// holds, and the Review's first read, which lists the pairs a tidy should deal
// with. Both read this module, so a note the fold refuses as a twin is a note
// the first read would have listed, and the other way round. The same holds
// for topics: two headings that name one subject are found here with the one
// title predicate the fold and a move are judged by.
//
// The question has a second answer since 0.13. Two notes that share their
// words can still disagree: "renews on 1 June" against "renews on 1 July" is
// not one point said twice, it is one point with two values, and the newer
// note should replace the older. A word-overlap test alone calls that pair a
// twin, and the room ends up believing June. So every pair is classified:
// a duplicate has the same words and the same values; a conflict has the same
// words and a different date, number or negation; everything else is
// different. The values a note carries are its words with a digit in them,
// its month and weekday names in German and English, and its negations; a
// run of value words that sit next to each other is one value group, so a
// date written as three words is one thing that changed, not three. Short
// notes, under the twin test's six-word floor, are still a conflict when
// everything but one value group is the same words in the same order: that
// is how "Sprint 12 review on 3 May" and the same sprint on 2 June are caught
// while two different sprints on two dates stay apart. A number at the head
// of a note is its name, not its value: "Ticket 4711 is about the login page"
// and the same words about ticket 4712 are two tickets, so a value group that
// stands first or second in a note, with no month, weekday or negation in it,
// never makes a conflict on its own. Leading zeros are not a difference
// ("1.6.2026" says what "01.06.2026" says); a date written as an ISO string
// against the same date written with a month name is a known false pair.
//
// Nothing here talks to a model, a route or the disk. A document goes in and
// pairs come out; the sentences a person reads are built here too, so the
// screen and the prompt cannot drift apart. A note is read into its words
// once, with each word's place in the note, so the value a person wrote can
// be quoted back in their own spelling ("55,000", "1.6.2026") while the
// comparison runs on the normalised words.
//
// The title predicate lives in absorb-ops.ts and this module's note predicate
// is read by absorb-ops.ts: the two modules import each other. Both export
// functions only and neither reads the other at load time, so the cycle is
// harmless; it is kept rather than broken by a third module because one
// predicate per question, in one place, is the point.

import { nearDuplicateTopicTitle } from "./absorb-ops.js";
import { dayWords, type MemoryDocument, type MemorySection } from "./memory-entries.js";

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

/** What two notes are to each other: one point said twice, one point with two values, or two points. */
export type NotePairClass = "duplicate" | "conflict" | "different";

/** One note as a conflict pair names it: a duplicate ref plus the day that decides, `updated ?? saved` as YYYY-MM-DD. */
export interface ConflictNoteRef extends DuplicateNoteRef {
	date: string;
}

/** `a` sits before `b` in the document; `newer` names the member with the later date, null when the dates are equal and nothing decides. */
export interface ConflictNotePair {
	a: ConflictNoteRef;
	b: ConflictNoteRef;
	newer: "a" | "b" | null;
}

/** At most this many pairs come back from one document; a memory that says more than this twice is a memory for a Review, not a list. */
export const DUPLICATE_NOTE_PAIRS_MAX = 30;
/** The same ceiling for the pairs that disagree. */
export const CONFLICT_NOTE_PAIRS_MAX = 30;
/** Notes shorter than this, in words, are alike only when they are equal: five words that share four are two different points more often than one. */
export const NOTE_LOOKALIKE_MIN_WORDS = 6;
/** Two long notes whose word sets overlap this much say one thing. */
export const NOTE_LOOKALIKE_JACCARD = 0.8;
/**
 * Two short notes disagree only when the words around their values, the
 * same words in the same order, are at least this many: "Sprint review on"
 * is enough context for a moved review, "Kickoff on" or "Due" alone is not.
 */
const CONFLICT_MIN_REST_WORDS = 3;
/** A reason or a sentence names at most this many changed values. */
const CONFLICT_VALUE_PAIRS_MAX = 3;
/** The sentence a person reads quotes at most this much of a note. */
const SENTENCE_LINE_MAX_CHARS = 120;

const GERMAN_MONTHS = ["januar", "februar", "märz", "april", "mai", "juni", "juli", "august", "september", "oktober", "november", "dezember"];
const GERMAN_MONTH_ABBREVIATIONS = ["jan", "feb", "mär", "mrz", "apr", "mai", "jun", "jul", "aug", "sep", "sept", "okt", "nov", "dez"];
const ENGLISH_MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
const ENGLISH_MONTH_ABBREVIATIONS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "sept", "oct", "nov", "dec"];
const GERMAN_WEEKDAYS = ["montag", "dienstag", "mittwoch", "donnerstag", "freitag", "samstag", "sonnabend", "sonntag"];
const ENGLISH_WEEKDAYS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];
/** A negation is a value of its own: "renewed" against "not renewed" is the other common contradiction. */
const NEGATIONS = ["nicht", "kein", "keine", "keinen", "keiner", "nie", "niemals", "not", "no", "never", "none", "without", "ohne"];

/**
 * Month names and their abbreviations, weekday names and negations, German
 * and English, as the normalised text spells them. A word with a digit in it
 * is a value by rule, not by this list.
 */
export const NOTE_VALUE_WORDS: readonly string[] = Object.freeze([
	...new Set([...GERMAN_MONTHS, ...GERMAN_MONTH_ABBREVIATIONS, ...ENGLISH_MONTHS, ...ENGLISH_MONTH_ABBREVIATIONS, ...GERMAN_WEEKDAYS, ...ENGLISH_WEEKDAYS, ...NEGATIONS]),
]);

const VALUE_WORD_SET = new Set(NOTE_VALUE_WORDS);
const NEGATION_SET = new Set(NEGATIONS);
const HAS_DIGIT = /\p{N}/u;
const WORD_RUNS = /[\p{L}\p{N}]+/gu;
const NOT_WORD = /[^\p{L}\p{N}]+/u;

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

// --- A note read once: its words, its values and where they sit -------------

/** A run of value words that stand next to each other in the note: one date, one number with its thousands, or one negation on its own. */
interface ValueGroup {
	/** How many words that are not values come before the group; the place two notes are aligned by. */
	anchor: number;
	tokens: string[];
	/** The group's first and last character in the note's marks-stripped text, so its spelling can be quoted. */
	start: number;
	end: number;
}

interface AnalyzedNote {
	/** The note with the system's marks gone, casing and punctuation kept: the text a value is quoted from. */
	stripped: string;
	/** The same words `normalizeNoteText` gives, joined by one space. */
	normalized: string;
	words: string[];
	/** The distinct words, for the twin test's overlap. */
	wordSet: Set<string>;
	/** The value words in note order. */
	values: string[];
	/** The words that are not values, in note order. */
	rest: string[];
	groups: ValueGroup[];
}

function isValueWord(word: string): boolean {
	return VALUE_WORD_SET.has(word) || HAS_DIGIT.test(word);
}

/**
 * "may" is the one month that is also an everyday verb. It is read as the
 * month when a day or a year stands beside it or when it ends the note
 * ("on 3 May", "May 2026", "due in May"), and as the verb when an ordinary
 * word follows it ("invoices may go out"); "in May the contract renews" is
 * read as the verb too, the price of not calling every "may" a date.
 */
function isMonthOfMay(words: readonly string[], at: number): boolean {
	if (words[at] !== "may") return true;
	const next = words[at + 1];
	if (next === undefined) return true;
	const previous = words[at - 1];
	return HAS_DIGIT.test(next) || (previous !== undefined && HAS_DIGIT.test(previous));
}

/**
 * The note read once. Each run of letters and digits in the stripped text is
 * a word, lowercased; a word that lowercases into more than one run (rare,
 * a dotted capital I) becomes those runs, so the words are exactly the ones
 * `normalizeNoteText` yields. Values that follow each other form one group,
 * except a negation, which is always a group of its own; the group remembers
 * its place in the stripped text and how many plain words came before it.
 */
function analyzeNote(text: string): AnalyzedNote {
	const stripped = stripNoteMarks(text);
	const placed: Array<{ word: string; start: number; end: number }> = [];
	for (const match of stripped.matchAll(WORD_RUNS)) {
		const start = match.index ?? 0;
		const end = start + match[0].length;
		for (const word of match[0].toLowerCase().split(NOT_WORD)) if (word) placed.push({ word, start, end });
	}
	const words = placed.map((token) => token.word);
	const values: string[] = [];
	const rest: string[] = [];
	const groups: ValueGroup[] = [];
	let open: ValueGroup | null = null;
	placed.forEach(({ word, start, end }, at) => {
		if (!isValueWord(word) || !isMonthOfMay(words, at)) {
			rest.push(word);
			open = null;
			return;
		}
		values.push(word);
		const negation = NEGATION_SET.has(word);
		if (open && !negation) {
			open.tokens.push(word);
			open.end = end;
			return;
		}
		open = { anchor: rest.length, tokens: [word], start, end };
		groups.push(open);
		if (negation) open = null;
	});
	return { stripped, normalized: words.join(" "), words, wordSet: new Set(words), values, rest, groups };
}

/** The normalised words of a note that carry a value, in note order: any word with a digit, or a word in `NOTE_VALUE_WORDS`. */
export function noteValueTokens(text: string): string[] {
	return analyzeNote(text).values;
}

/** A value word as two notes compare it: a run of digits loses its leading zeros, so "01" and "1", "06" and "6" are one value; every other word is itself. */
function comparableToken(word: string): string {
	return /^\d+$/.test(word) ? word.replace(/^0+(?=\d)/, "") : word;
}

function sameMultiset(a: readonly string[], b: readonly string[]): boolean {
	if (a.length !== b.length) return false;
	const sortedA = a.map(comparableToken).sort();
	const sortedB = b.map(comparableToken).sort();
	return sortedA.every((word, i) => word === sortedB[i]);
}

/** The twin test on two analysed notes: the same rule as `normalizedLookAlike`, read off the words and sets the analysis already holds. */
function analyzedLookAlike(a: AnalyzedNote, b: AnalyzedNote): boolean {
	if (!a.normalized || !b.normalized) return false;
	if (a.normalized === b.normalized) return true;
	if (a.words.length < NOTE_LOOKALIKE_MIN_WORDS || b.words.length < NOTE_LOOKALIKE_MIN_WORDS) return false;
	if (` ${a.normalized} `.includes(` ${b.normalized} `) || ` ${b.normalized} `.includes(` ${a.normalized} `)) return true;
	let shared = 0;
	for (const word of a.wordSet) if (b.wordSet.has(word)) shared += 1;
	const union = a.wordSet.size + b.wordSet.size - shared;
	return union > 0 && shared / union >= NOTE_LOOKALIKE_JACCARD;
}

function sameSequence(a: readonly string[], b: readonly string[]): boolean {
	return a.length === b.length && a.every((word, i) => word === b[i]);
}

/** What the groups at one anchor say, as one comparable string; "" when there are none. */
function anchorKey(groups: readonly ValueGroup[]): string {
	return groups.map((group) => group.tokens.map(comparableToken).join(" ")).join(" | ");
}

function groupsAt(note: AnalyzedNote, anchor: number): ValueGroup[] {
	return note.groups.filter((group) => group.anchor === anchor);
}

/** The anchors, ascending, where the two notes' value groups do not say the same; a group present on one side only is a difference. */
function differingAnchors(a: AnalyzedNote, b: AnalyzedNote): number[] {
	const anchors = [...new Set([...a.groups, ...b.groups].map((group) => group.anchor))].sort((x, y) => x - y);
	return anchors.filter((anchor) => anchorKey(groupsAt(a, anchor)) !== anchorKey(groupsAt(b, anchor)));
}

/** How many plain words may stand before a value group that is a note's name rather than its value: "Ticket 4711 …", "Rechnung 2026-117 …", "4711: …". */
const NAME_ANCHOR_MAX = 1;

/**
 * Whether the one differing value group is the note's name: it stands first or
 * second in the note and none of its words, on either side, is a month, a
 * weekday or a negation. Two tickets, two invoices or two sprints that share
 * every other word are two things, not one thing with two values.
 */
function isNameAnchor(anchor: number, a: AnalyzedNote, b: AnalyzedNote): boolean {
	if (anchor > NAME_ANCHOR_MAX) return false;
	return [...groupsAt(a, anchor), ...groupsAt(b, anchor)].every((group) => group.tokens.every((token) => !VALUE_WORD_SET.has(token)));
}

function classifyAnalyzed(a: AnalyzedNote, b: AnalyzedNote): NotePairClass {
	if (!a.normalized || !b.normalized) return "different";
	if (a.normalized === b.normalized) return "duplicate";
	// The plain words the same, in the same order, and enough of them: the
	// values decide. None differs once leading zeros are read away: one thing
	// said twice. One differs and it is the note's name: two things.
	const restEqual = a.rest.length >= CONFLICT_MIN_REST_WORDS && sameSequence(a.rest, b.rest);
	const differing = restEqual ? differingAnchors(a, b) : null;
	if (differing && differing.length === 0) return "duplicate";
	if (differing && differing.length === 1 && isNameAnchor(differing[0], a, b)) return "different";
	if (analyzedLookAlike(a, b)) return sameMultiset(a.values, b.values) ? "duplicate" : "conflict";
	if (!differing) return "different";
	return differing.length === 1 ? "conflict" : "different";
}

/**
 * What two notes are to each other. Equal normalised text is a duplicate.
 * Notes that look alike by the twin test are a duplicate when they carry the
 * same values (as a multiset) and a conflict when they do not. Notes that do
 * not look alike are still a conflict when their plain words are the same
 * sequence, at least three of them, and exactly one value group differs at one
 * place: the moved date of an event, the changed number of a fact, a negation
 * added. A number that opens a note is its name, never its value, so two notes
 * that differ only there are different; and a digit that differs only by its
 * leading zeros is the same digit. Everything else is different. Only the text
 * is read, never the kind.
 */
export function classifyNotePair(a: string, b: string): NotePairClass {
	return classifyAnalyzed(analyzeNote(a), analyzeNote(b));
}

// --- The pairs of a document -------------------------------------------------

interface AnalyzedNoteRef extends ConflictNoteRef {
	analyzed: AnalyzedNote;
}

function analyzedNotesOf(doc: MemoryDocument): AnalyzedNoteRef[] {
	const notes: AnalyzedNoteRef[] = [];
	for (const topic of doc.topics) {
		for (const entry of topic.entries) {
			if (!entry.id) continue;
			notes.push({ id: entry.id, topic: topic.title, section: topic.section, text: entry.text, date: entry.updated ?? entry.saved, analyzed: analyzeNote(entry.text) });
		}
	}
	return notes;
}

export interface NotePairs {
	duplicates: DuplicateNotePair[];
	conflicts: ConflictNotePair[];
}

/**
 * Both lists of a document in ONE walk over its pairs, each pair classified
 * once: the notes that say one thing twice (both sections, every topic) and
 * the notes in one section that disagree. Each pair once, in the document
 * order of the pair's first member, at most thirty of either kind; the walk
 * ends when both lists are full. A reader that wants both lists reads this,
 * since on a large memory the walk is what a first read costs.
 */
export function findNotePairs(doc: MemoryDocument): NotePairs {
	const notes = analyzedNotesOf(doc);
	const duplicates: DuplicateNotePair[] = [];
	const conflicts: ConflictNotePair[] = [];
	const full = () => duplicates.length >= DUPLICATE_NOTE_PAIRS_MAX && conflicts.length >= CONFLICT_NOTE_PAIRS_MAX;
	for (let i = 0; i < notes.length && !full(); i++) {
		for (let j = i + 1; j < notes.length && !full(); j++) {
			const kind = classifyAnalyzed(notes[i].analyzed, notes[j].analyzed);
			if (kind === "duplicate" && duplicates.length < DUPLICATE_NOTE_PAIRS_MAX) {
				const { analyzed: _a, date: _da, ...a } = notes[i];
				const { analyzed: _b, date: _db, ...b } = notes[j];
				duplicates.push({ a, b });
			} else if (kind === "conflict" && conflicts.length < CONFLICT_NOTE_PAIRS_MAX && notes[i].section === notes[j].section) {
				const { analyzed: _a, ...a } = notes[i];
				const { analyzed: _b, ...b } = notes[j];
				const newer = a.date === b.date ? null : a.date > b.date ? "a" : "b";
				conflicts.push({ a, b, newer });
			}
		}
	}
	return { duplicates, conflicts };
}

/**
 * Every pair of notes in the document that say one thing twice, in both
 * sections and every topic, among notes that carry an id: each pair once, in
 * the document order of the pair's first member, at most thirty of them. Only
 * duplicates: a pair whose values differ is a conflict, listed by
 * `findConflictingNotePairs`, and never appears here. The walk is
 * `findNotePairs`'s; a reader that wants both lists reads that once.
 */
export function findDuplicateNotePairs(doc: MemoryDocument): DuplicateNotePair[] {
	return findNotePairs(doc).duplicates;
}

/**
 * Every pair of notes in one section that disagree, of every kind, topics
 * apart or not, each pair once, in the document order of the pair's first
 * member, at most thirty of them. The member with the later `updated ?? saved`
 * day is the newer; when the days are equal nothing decides and `newer` is
 * null. A Deep Memory note and an Active Items note are never paired. The walk
 * is `findNotePairs`'s; a reader that wants both lists reads that once.
 */
export function findConflictingNotePairs(doc: MemoryDocument): ConflictNotePair[] {
	return findNotePairs(doc).conflicts;
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

// --- What changed between two notes, in the person's own spelling ----------

/** Today as the local YYYY-MM-DD: the day a person reading the card is in. */
function localDay(date = new Date()): string {
	return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

/** The groups as the note writes them, from the first group's first character to the last group's last; "" when there is no group. */
function spellingOf(note: AnalyzedNote, groups: readonly ValueGroup[]): string {
	if (groups.length === 0) return "";
	return note.stripped.slice(groups[0].start, groups[groups.length - 1].end).replace(/\s+/g, " ");
}

/**
 * The value groups that differ between the older and the newer note, in the
 * person's own spelling ("55,000", "1.6.2026", "3 May 2026"), at most three.
 * When the plain words of the two notes are the same sequence, the groups are
 * aligned by their place among those words, and a group present on one side
 * only reads as "" on the other. When the plain words differ too (a long pair
 * the twin test matched), the groups are aligned by their order instead: the
 * first value of one note against the first of the other.
 */
export function conflictValuePairs(older: string, newer: string): Array<{ older: string; newer: string }> {
	const a = analyzeNote(older);
	const b = analyzeNote(newer);
	const pairs: Array<{ older: string; newer: string }> = [];
	if (sameSequence(a.rest, b.rest)) {
		for (const anchor of differingAnchors(a, b)) pairs.push({ older: spellingOf(a, groupsAt(a, anchor)), newer: spellingOf(b, groupsAt(b, anchor)) });
	} else {
		const count = Math.max(a.groups.length, b.groups.length);
		for (let i = 0; i < count; i++) {
			const groupA = a.groups[i];
			const groupB = b.groups[i];
			if (groupA && groupB && anchorKey([groupA]) === anchorKey([groupB])) continue;
			pairs.push({ older: groupA ? spellingOf(a, [groupA]) : "", newer: groupB ? spellingOf(b, [groupB]) : "" });
		}
	}
	return pairs.slice(0, CONFLICT_VALUE_PAIRS_MAX);
}

/** One side of the changed values as a person reads it: the spellings joined by commas, "nothing" for a side that has no such value. */
function valuesSide(pairs: ReadonlyArray<{ older: string; newer: string }>, side: "older" | "newer"): string {
	return pairs.map((pair) => pair[side] || "nothing").join(", ");
}

/**
 * Why the newer note replaced the older, for the card and History:
 * `1 July (saved 14 Sep) replaces 1 June (saved 2 Jun); the newer date decides`,
 * several values joined by commas, and with equal days
 * `1 July replaces 1 June (both saved 14 Sep)`. When the newer text comes
 * from a day BEFORE the older one's (a conversation folded after a note it
 * predates), no date decides and the sentence says what did:
 * `1 July replaces 1 June (saved 23 Apr); the conversation of 21 Apr was
 * folded after it`. Only the values that differ are named, in the notes'
 * own spelling; the year is written only when it is not the year of `today`.
 */
export function conflictReason(before: string, after: string, olderDate: string, newerDate: string, today = localDay()): string {
	const pairs = conflictValuePairs(before, after);
	const was = pairs.length > 0 ? valuesSide(pairs, "older") : noteLine(before);
	const is = pairs.length > 0 ? valuesSide(pairs, "newer") : noteLine(after);
	if (olderDate === newerDate) return `${is} replaces ${was} (both saved ${dayWords(newerDate, today)})`;
	if (newerDate < olderDate) return `${is} replaces ${was} (saved ${dayWords(olderDate, today)}); the conversation of ${dayWords(newerDate, today)} was folded after it`;
	return `${is} (saved ${dayWords(newerDate, today)}) replaces ${was} (saved ${dayWords(olderDate, today)}); the newer date decides`;
}

/** The pair's members with the older first; document order when nothing decides. */
function orderedMembers(pair: ConflictNotePair): [ConflictNoteRef, ConflictNoteRef] {
	return pair.newer === "a" ? [pair.b, pair.a] : [pair.a, pair.b];
}

/**
 * `"Topic" disagrees with itself: 1 June (saved 2 Jun) or 1 July (saved 14 Sep)`
 * under one topic, `"A" and "B" disagree: …` across two, the older note's
 * value and topic first; with equal days `…: 1 June or 1 July, both saved 14 Sep`
 * in document order.
 */
export function conflictNoteSentence(pair: ConflictNotePair, today = localDay()): string {
	const [first, second] = orderedMembers(pair);
	const pairs = conflictValuePairs(first.text, second.text);
	const firstValues = pairs.length > 0 ? valuesSide(pairs, "older") : noteLine(first.text);
	const secondValues = pairs.length > 0 ? valuesSide(pairs, "newer") : noteLine(second.text);
	const sameTopic = pair.a.topic === pair.b.topic && pair.a.section === pair.b.section;
	const subject = sameTopic ? `"${pair.a.topic}" disagrees with itself` : `"${first.topic}" and "${second.topic}" disagree`;
	if (pair.newer === null) return `${subject}: ${firstValues} or ${secondValues}, both saved ${dayWords(first.date, today)}`;
	return `${subject}: ${firstValues} (saved ${dayWords(first.date, today)}) or ${secondValues} (saved ${dayWords(second.date, today)})`;
}

/**
 * The line the Review's prompt carries for one pair, quoting each note's
 * first line the way `duplicateNoteSentence` quotes one:
 * `m-0101 (saved 2 Jun) says "…"; m-0301 (saved 14 Sep) says "…": the newer
 * date decides; merge them keeping the newer text, or say in the narrative
 * why both stay`, and with equal days `m-0101 says "…"; m-0301 says "…": both
 * saved 14 Sep; keep the one the conversation confirms, or both`.
 */
export function conflictPromptLine(pair: ConflictNotePair, today = localDay()): string {
	const [first, second] = orderedMembers(pair);
	if (pair.newer === null) {
		return `${first.id} says "${noteLine(first.text)}"; ${second.id} says "${noteLine(second.text)}": both saved ${dayWords(first.date, today)}; keep the one the conversation confirms, or both`;
	}
	return `${first.id} (saved ${dayWords(first.date, today)}) says "${noteLine(first.text)}"; ${second.id} (saved ${dayWords(second.date, today)}) says "${noteLine(second.text)}": the newer date decides; merge them keeping the newer text, or say in the narrative why both stay`;
}
