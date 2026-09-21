// Recall bench — the seeded question set (memory v2, stream F).
//
// The fold bench next door asks whether ONE remembered session lands in core
// memory as the right operations. This one asks a longer question: after a
// room has lived through thirty conversations, can the memory still answer
// what was said in them? The fixture here is the corpus and the answer key of
// that run: a month or two of a working room, one topic per sitting, with
// facts planted on purpose and questions whose answers are known.
//
// Nothing here talks to a model, a route or the disk. It builds, per language:
//   - SESSIONS in the shape the product holds them: the conversation as turns,
//     and the Recent Context entry a scripted Remember writes for it (the
//     `rememberMeanwhile` shape of absorb-run-smoke: the `### RC-DRAFT | OPEN`
//     header, the session arc, the Body bullets, the Parked line). The RC id is
//     left as RC-DRAFT because the product assigns the real one when it writes
//     the entry;
//   - QUESTIONS over those sessions, five abilities' worth: one fact from one
//     session, two halves from two sessions, the order of and distance between
//     dated sittings, a value that was restated later, and a question about
//     something the room was never told.
//
// MARKERS. Every planted fact carries a reference code — `REC-E07` in the
// English fixture, `REC-D07` in the German one — written INSIDE the sentence,
// the way a room's memory carries ticket references. A marker is unique across
// the fixture, so the bench can say which planted thing an answer or an entry
// came from, and a supersede's new line carries a new marker of its own.
//
// DIRECTIVES. The Body bullet of every plant is preceded, in the RC entry, by a
// `<!-- plant: ... -->` comment in the fold-fixtures grammar, so `fold-models`'
// scripted `exact` fold turns the remembered session into the operations the
// fixture intends: `add` for a new fact, `supersede @OLDMARKER` for a value
// that replaces an older entry, `update @OLDMARKER` for one that is rewritten
// in place. Dropping the directive lines leaves a plain, valid RC entry — the
// same move fold-bench's `--plain` render makes before it gives a session to a
// real model — which is what `stripRecallDirectives` does.
//
// LANGUAGES. The German and the English halves are different rooms: their own
// company, own people, own numbers, not translations of each other. The German
// text is written as German is: umlauts, capitalised umlauts, the sharp s
// inside words the questions quote, and dates in both of the forms a room uses
// (`11.07.2026` and `11. Juli 2026`). A German `variant` query therefore asks
// for the same words spelled ae/oe/ue/ss, or — where the literal quotes a date
// — for the same day written the other way. The English variants differ in
// date, quarter and number form instead.
//
// Seeded: the same seed is the same fixture, byte for byte. The seed moves the
// session dates, the small talk each sitting carries and the ask date; what is
// planted, and what the answer key says, never changes.

import { mulberry32 } from "./fold-fixtures.mjs";

// --- The contract the bench reads -------------------------------------------

export type RecallLanguage = "de" | "en";

export type RecallAbility = "extraction" | "multi-session" | "temporal" | "knowledge-update" | "abstention";

/**
 * The five shapes of "two notes that say one thing, or nearly": planted as a
 * PAIR of sentences in two conversations, so a run can watch what the memory
 * makes of the second one. A `duplicate` is the same sentence twice. The three
 * conflict shapes are one point with two values: the long shape shares eight of
 * nine words with its partner and the twin test calls the pair alike, the
 * short shape is under the twin test's six-word floor and only the words
 * around the value say it is one point, and the moved event is a dated event
 * whose date moved. The `decoy` is two events that only look like a moved
 * one: a different number AND a different date, which is two points.
 */
export type ConflictShape = "duplicate" | "conflict-long" | "conflict-short" | "moved-event" | "decoy";
export const CONFLICT_SHAPES: readonly ConflictShape[] = ["duplicate", "conflict-long", "conflict-short", "moved-event", "decoy"];

export interface RecallTurn {
	role: "user" | "assistant";
	text: string;
}

export interface RecallPlant {
	/** The reference code the sentence carries, e.g. `REC-E07`. Unique in the fixture. */
	marker: string;
	/** The planted sentence, marker included, as it stands in the conversation. */
	line: string;
	/** The core-memory topic the fact belongs under; the `add` directive names it. */
	topic: string;
	/** Marker of the older entry this one replaces (knowledge-update, supersede path). */
	supersedes?: string;
	/** Marker of the older entry this one rewrites in place (knowledge-update, update path). */
	updates?: string;
	/**
	 * Whether the Remember wrote this fact down. The default is true. A plant
	 * with `noted: false` is SAID and never NOTED: it stands in a sentence of
	 * the conversation, marker and all, but the RC entry carries no bullet and
	 * no directive for it, so no fold ever turns it into a note. It is the
	 * evidence a room can only reach by searching the conversation it kept.
	 */
	noted?: boolean;
	/**
	 * The kind the fold saves the note as. The default is a fact. `item` is an
	 * open item: the scripted fold adds it with status open, and the room's
	 * budget never moves an open item out, so it is the evidence a run counts to
	 * see that protection hold.
	 */
	kind?: "item";
	/**
	 * One member of a planted pair of the shape named: the older member is a
	 * plain add, the newer member of a conflict shape supersedes the older, the
	 * newer member of the duplicate and of the decoy is a plain add again.
	 */
	shape?: ConflictShape;
	/**
	 * The evidence of a no-hint question: said in passing in a sitting the fold
	 * takes notes from, never noted itself, and numbered after every other class.
	 */
	noHint?: true;
}

export interface RecallSession {
	/** "S01".."S30". */
	id: string;
	/** YYYY-MM-DD, strictly increasing, one sitting every 2-6 days. */
	date: string;
	title: string;
	/** The conversation as a room would hold it; every plant sits in a sentence with its marker. */
	turns: RecallTurn[];
	/** The RC entry a scripted Remember writes, directives included. */
	recentContextEntry: string;
	plants: RecallPlant[];
}

export interface RecallQuestion {
	/** "Q-en-01", "Q-de-01"… */
	id: string;
	ability: RecallAbility;
	language: RecallLanguage;
	question: string;
	/** Accepted answers, short, several spellings; empty for an abstention question. */
	gold: string[];
	/**
	 * Values that make an answer wrong. On a knowledge-update question it is the
	 * OLD value the fixture replaced: an answer with a trap and no gold scores
	 * 0. On an abstention question it is a list of INVENTED specifics — names,
	 * numbers and addresses the room was never told — so an answer that offers
	 * one instead of saying it does not know is caught by its own words.
	 */
	trap?: string[];
	/**
	 * Abstention questions whose invention cannot be listed: a regular
	 * expression source matching the SHAPE of a made-up specific, e.g.
	 * `\\d{3,}` for a phone number. The scorer applies it after exempting the
	 * facts the fixture does plant, so a match is something the answer invented.
	 */
	trapPattern?: string;
	/**
	 * Temporal ORDER questions only: the spellings of the OTHER option, named
	 * the way `gold` names the right one. A question that asks which of two
	 * things came first is answered by naming one of them, so an answer that
	 * names both contains the gold without choosing: the answer counts as
	 * right only when a gold spelling occurs and either no distractor occurs or
	 * the first gold occurrence comes before the first distractor one.
	 */
	distractor?: string[];
	evidence: { sessionId: string; marker: string }[];
	/**
	 * knowledge-update only: where the OLD value was said. It is deliberately
	 * not `evidence` — the old note is archived by the fold that supersedes it,
	 * and filing the question under the archive would say a recall came from
	 * there when the answer sits in core. For the in-place update path it names
	 * the entry that was rewritten.
	 */
	trapEvidence?: { sessionId: string; marker: string }[];
	/**
	 * Three ways of asking for the same evidence. `literal` quotes the words as
	 * planted. `paraphrase` is how a person would type the search instead: it
	 * keeps at least two content words of the evidence, so a word search can
	 * reach it, but no run of the corpus, so a substring search cannot.
	 * `variant` is the literal respelled — umlauts as ae/oe/ue in German, a
	 * different date, quarter or number form in English.
	 */
	queries: { literal: string; paraphrase: string; variant: string };
	/** YYYY-MM-DD, after the last session. */
	askDate: string;
	/**
	 * The evidence was planted as an OPEN ITEM rather than a fact: per language
	 * the two lowest-numbered extraction questions whose plant nothing later
	 * replaces or rewrites. The room's budget never moves an open item out, so
	 * these are the questions a run counts to see that hold.
	 */
	openItem?: true;
	/**
	 * The question of one planted pair: a knowledge-update question on the
	 * newer member of a conflict shape, an extraction question on the first
	 * member of the duplicate and on the second member of the decoy. Counted in
	 * the run's conflicts block and in no ability table.
	 */
	shape?: ConflictShape;
	/**
	 * A question WITHOUT A HINT: its answer was said in passing in a folded
	 * conversation and never noted, and it is asked in everyday words that share
	 * no content word with the planted sentence beyond the thing it is about.
	 * Scored like extraction, counted in a column of its own and in no ability
	 * table.
	 */
	noHint?: true;
	/** No-hint questions only: the person or thing the question and the planted sentence both name. */
	entity?: string;
}

export interface RecallFixture {
	language: RecallLanguage;
	seed: number;
	sessions: RecallSession[];
	questions: RecallQuestion[];
}

export interface RecallFixtureOptions {
	language: RecallLanguage;
	seed?: number;
	sessions?: number;
	questionsPerAbility?: number;
	/**
	 * How many questions are answered from a fact the room was told and never
	 * wrote down. They are extraction and multi-session questions like any
	 * other and are counted on their own, so asking for them leaves the five
	 * abilities' counts where they were. Left out, it follows
	 * `questionsPerAbility`: ten at the default size, one at the small one.
	 */
	conversationQuestions?: number;
}

export const RECALL_FIXTURE_DEFAULTS: { seed: number; sessions: 30; questionsPerAbility: 10; conversationQuestions: 10 } = {
	seed: 20260915,
	sessions: 30,
	questionsPerAbility: 10,
	conversationQuestions: 10,
};

/** The abilities in the order the answer key lists them. */
export const RECALL_ABILITIES: readonly RecallAbility[] = ["extraction", "multi-session", "temporal", "knowledge-update", "abstention"];
/** How many extraction questions per language are planted as open items rather than facts. */
export const OPEN_ITEM_QUESTIONS_PER_LANGUAGE = 2;
/** How many no-hint questions each language holds at the full size. */
export const NO_HINT_QUESTIONS_PER_LANGUAGE = 6;

// --- Directives --------------------------------------------------------------

/** The `<!-- plant: ... -->` line, written the way fold-fixtures writes it. */
function directive(fields: Record<string, string | undefined>): string {
	const parts = Object.entries(fields)
		.filter(([, value]) => value !== undefined && value !== "")
		.map(([key, value]) => (/[\s"]/.test(String(value)) ? `${key}="${String(value).replace(/"/g, "'")}"` : `${key}=${value}`));
	return `<!-- plant: ${parts.join(" ")} -->`;
}

const DIRECTIVE_LINE = /^\s*<!--\s*plant:\s*[\s\S]*?-->\s*$/;

/**
 * The RC entry without its directives: what a room's own entry looks like, and
 * what a real model is given. The same move fold-bench makes for a `--plain`
 * run — dropping the comment lines and nothing else.
 */
export function stripRecallDirectives(entry: string): string {
	return entry
		.split("\n")
		.filter((line) => !DIRECTIVE_LINE.test(line))
		.join("\n");
}

// --- The seeded draw ---------------------------------------------------------

function shuffled<T>(items: readonly T[], rand: () => number): T[] {
	const out = [...items];
	for (let i = out.length - 1; i > 0; i--) {
		const j = Math.floor(rand() * (i + 1));
		[out[i], out[j]] = [out[j], out[i]];
	}
	return out;
}

const DAY_MS = 86_400_000;

function addDays(date: string, days: number): string {
	return new Date(Date.parse(`${date}T00:00:00.000Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

function daysBetween(a: string, b: string): number {
	return Math.round(Math.abs(Date.parse(`${a}T00:00:00.000Z`) - Date.parse(`${b}T00:00:00.000Z`)) / DAY_MS);
}

function pad2(n: number): string {
	return String(n).padStart(2, "0");
}

/**
 * Function words of four letters or more, in both languages. Anything shorter
 * is dropped by the length rule already; these are the long ones that carry no
 * subject and must not count as a word two sentences have in common.
 */
const QUERY_STOPWORDS = new Set([
	"about", "after", "again", "against", "also", "another", "because", "been", "before", "being", "between", "both", "could", "does", "done", "during", "each", "either", "else", "even", "ever", "every", "from", "have", "here", "into", "just", "like", "many", "more", "most", "much", "must", "neither", "only", "other", "over", "same", "shall", "should", "some", "still", "such", "than", "that", "their", "them", "then", "there", "these", "they", "this", "those", "through", "thus", "under", "until", "upon", "very", "were", "what", "when", "where", "which", "while", "whose", "will", "with", "within", "without", "would", "your",
	"aber", "alle", "allen", "aller", "alles", "andere", "anderen", "auch", "beim", "bevor", "damit", "dann", "dass", "denen", "denn", "dessen", "dies", "diese", "diesem", "diesen", "dieser", "dieses", "doch", "dort", "durch", "eine", "einem", "einen", "einer", "eines", "etwa", "gegen", "haben", "hatte", "hatten", "hier", "ihre", "ihren", "ihrer", "immer", "jede", "jeden", "jeder", "kann", "koennen", "mehr", "muss", "muessen", "nach", "nicht", "noch", "oder", "ohne", "schon", "sehr", "sein", "seine", "seinem", "seinen", "seiner", "sind", "sowie", "ueber", "unter", "waehrend", "weil", "welche", "welchem", "welchen", "welcher", "welches", "wenn", "werden", "wird", "wurde", "wurden", "zwischen",
]);

/**
 * The words of a sentence a lexical retriever would actually index: four
 * letters or more, lowercased, umlauts folded, function words dropped.
 */
export function contentWords(text: string): Set<string> {
	const words = asciiFold(text.toLowerCase())
		.split(/[^a-z0-9]+/)
		.filter((word) => word.length >= 4 && !QUERY_STOPWORDS.has(word));
	return new Set(words);
}

const GERMAN_MONTHS = ["Januar", "Februar", "März", "April", "Mai", "Juni", "Juli", "August", "September", "Oktober", "November", "Dezember"] as const;
const GERMAN_DATE_NUMERIC = /(\d{1,2})\.(\d{1,2})\.(\d{4})/;
const GERMAN_DATE_LONG = new RegExp(`(\\d{1,2})\\.\\s+(${GERMAN_MONTHS.join("|")})\\s+(\\d{4})`);

/** A German date in a sentence: the day it means, and which of the two forms wrote it. */
function germanDate(text: string): { iso: string; form: "numeric" | "long" } | undefined {
	const numeric = GERMAN_DATE_NUMERIC.exec(text);
	if (numeric) return { iso: `${numeric[3]}-${pad2(Number(numeric[2]))}-${pad2(Number(numeric[1]))}`, form: "numeric" };
	const long = GERMAN_DATE_LONG.exec(text);
	if (long) return { iso: `${long[3]}-${pad2(GERMAN_MONTHS.indexOf(long[2] as (typeof GERMAN_MONTHS)[number]) + 1)}-${pad2(Number(long[1]))}`, form: "long" };
	return undefined;
}

/**
 * The same sentence with its date written the other way — `11.07.2026` becomes
 * `11. Juli 2026` and back. A room writes dates both ways, so a question about
 * a dated fact asks in the form the sentence did not use.
 */
function swapGermanDate(text: string): string | undefined {
	const numeric = GERMAN_DATE_NUMERIC.exec(text);
	if (numeric) return text.replace(numeric[0], `${Number(numeric[1])}. ${GERMAN_MONTHS[Number(numeric[2]) - 1]} ${numeric[3]}`);
	const long = GERMAN_DATE_LONG.exec(text);
	if (long) return text.replace(long[0], `${pad2(Number(long[1]))}.${pad2(GERMAN_MONTHS.indexOf(long[2] as (typeof GERMAN_MONTHS)[number]) + 1)}.${long[3]}`);
	return undefined;
}

/** ä/ö/ü/ß spelled out, which is how a German query reaches the same words without umlauts. */
function asciiFold(text: string): string {
	return text
		.replace(/ä/g, "ae")
		.replace(/ö/g, "oe")
		.replace(/ü/g, "ue")
		.replace(/Ä/g, "Ae")
		.replace(/Ö/g, "Oe")
		.replace(/Ü/g, "Ue")
		.replace(/ß/g, "ss");
}

/**
 * A planted sentence the way a query quotes it: the reference code and its
 * parentheses gone, the words left as the room said them.
 */
export function plantedWording(line: string): string {
	return line.replace(/\s*\(REC-[A-Z]+\d+\)/g, "").replace(/\s*\[REC-[A-Z]+\d+\]/g, "").replace(/\s+/g, " ").trim();
}

/**
 * A quoted sentence respelled the way the language's variant rule respells:
 * in German the date written the other way and the umlauts folded, in English
 * the sentence as it stands — the hand-written variant carries the respelling
 * under test, and the sentence appended to it is there to reach its note.
 */
export function variantWording(language: RecallLanguage, text: string): string {
	if (language !== "de") return text;
	return asciiFold(swapGermanDate(text) ?? text);
}

/**
 * Whether a sentence says what a query quotes: nearly all of the query's
 * distinctive words are in it, and every number. The same rule the engine
 * finds a note by, kept here so the fixture needs nothing from the engine.
 */
function saysQuoted(line: string, query: string): boolean {
	const words = (text: string) => text
		.toLowerCase()
		.replace(/[^\p{L}\p{N} ]+/gu, " ")
		.split(/\s+/)
		.filter((word) => word.length >= 4 || /^\d+$/.test(word));
	const wanted = words(query);
	if (wanted.length === 0) return false;
	const haystack = ` ${words(line).join(" ")} `;
	const has = (word: string) => haystack.includes(` ${word} `);
	if (wanted.filter((word) => /^\d+$/.test(word)).some((number) => !has(number))) return false;
	const plain = wanted.filter((word) => !/^\d+$/.test(word));
	if (plain.length === 0) return true;
	return plain.filter(has).length / plain.length >= 0.8;
}

// --- The authored world ------------------------------------------------------

interface PlantSeed {
	/** Key inside the world, e.g. "e01", "p03a", "u04new". */
	key: string;
	/** The user turn that leads to the plant. */
	ask: string;
	/** The assistant's sentence; `{m}` is where the marker goes. */
	line: string;
	/** Knowledge-update, supersede path: the key of the older plant this replaces. */
	supersedes?: string;
	/** Knowledge-update, update path: the key of the older plant this rewrites in place. */
	updates?: string;
	/** False for a fact the conversation says and the Remember never writes down. */
	noted?: boolean;
	/** One member of a planted pair; see `RecallPlant.shape`. */
	shape?: ConflictShape;
	/**
	 * The topic this plant lands under instead of the session's own. A planted
	 * pair is about its own subject, and the decoy's two events belong under
	 * one topic whichever sittings said them.
	 */
	topic?: string;
	/**
	 * The one plant said in a conversation the fold DROPS whole: never noted,
	 * and placed in the last sitting of a run only when that sitting carries no
	 * noted plant, so the scripted fold takes no notes from it and the
	 * transcript is all the room keeps. Numbered after every other class.
	 */
	dropped?: true;
	/** The plant of a no-hint question; see `NoHintSeed`. */
	noHint?: true;
}

/**
 * A question without a hint, written by hand in the world's own story. The
 * plant is one more exchange at the end of the sitting it names, said in
 * passing and never noted; the sitting notes other things, so the fold keeps
 * it and nothing in the room's notes points at the sentence. The question asks
 * in everyday words that share no content word with the exchange except the
 * `entity`, the person or thing both of them name. Appended like the dropped
 * conversation's seed: markers after every other class, question ids after
 * every other id, and nothing that was there before moves.
 */
interface NoHintSeed {
	/** The sitting the plant is said in, counted from 1; the question exists at every size that holds it. */
	session: number;
	/** The named person or thing, spelled as the question and the planted sentence both spell it. */
	entity: string;
	plant: PlantSeed;
	ask: AskSeed;
}

/**
 * The plant a world keeps for the dropped conversation, and the question that
 * asks for it. Both are appended and nothing else moves: every existing
 * session, marker and question stays byte for byte as it was at every size.
 */
interface DroppedSeed {
	plant: PlantSeed;
	ask: AskSeed;
}

interface SessionSeed {
	title: string;
	/** One topic per sitting; every plant of the session lands under it. */
	topic: string;
	arc: string;
	opening: string;
	openingReply: string;
	plants: PlantSeed[];
	closing: string;
	closingReply: string;
	/** A sitting without plants: the unmarked bullet its RC entry carries instead. */
	bullet?: string;
}

interface AskSeed {
	question: string;
	gold: string[];
	/** knowledge-update: the value that was replaced. */
	trap?: string[];
	/** Plant keys; the first one's sentence is the one the literal query quotes. */
	evidence: string[];
	literal: string;
	paraphrase: string;
	/** Left out in German, where the variant is the same words without umlauts. */
	variant?: string;
	/** The ability this question tests; only the said-not-noted list sets it. */
	ability?: RecallAbility;
}

/**
 * The question of one planted pair. The evidence keys follow the question's
 * ability: `[newer, older]` for a conflict shape, the way an update seed names
 * them; the first member for the duplicate; the second member for the decoy.
 * The question is asked only when the fixture holds BOTH members of the pair.
 */
interface ConflictAskSeed extends AskSeed {
	shape: ConflictShape;
}

interface TemporalSeed {
	form: "order" | "distance";
	/** Plant keys; `a` is the one the literal quotes. */
	a: string;
	b: string;
	question: string;
	/** order: the answer when `a` came first. */
	goldA?: string[];
	/** order: the answer when `b` came first. */
	goldB?: string[];
	literal: string;
	paraphrase: string;
	variant?: string;
}

interface AbstainSeed {
	question: string;
	/** Invented specifics of the kind this question invites; the room holds none of them. */
	trap: string[];
	/** The shape of an invented specific this question invites, where listing them is hopeless. */
	trapPattern?: string;
	literal: string;
	paraphrase: string;
	variant?: string;
}

interface RecallLabels {
	days: string;
	weeks: string;
	words: readonly string[];
}

interface RecallWorld {
	language: RecallLanguage;
	/** The letter of every marker in this fixture: `REC-E07`, `REC-D07`. */
	letter: string;
	/** The first sitting's date; the rest follow at 2-6 day intervals. */
	start: string;
	labels: RecallLabels;
	/** Small talk any sitting can carry: unmarked, so a fold has something to skip. */
	filler: ReadonlyArray<{ user: string; assistant: string }>;
	sessions: readonly SessionSeed[];
	extraction: readonly AskSeed[];
	/**
	 * Questions whose answer was SAID and never NOTED. They are ordinary
	 * extraction and multi-session questions — nothing on the question says
	 * where the answer lives; their evidence is a `noted: false` plant, and
	 * that is what tells the bench the room can only have it from the
	 * conversation it kept.
	 */
	conversation: readonly AskSeed[];
	multi: readonly AskSeed[];
	temporal: readonly TemporalSeed[];
	update: readonly AskSeed[];
	abstention: readonly AbstainSeed[];
	/** One question per planted pair, taken whole and never per ability. */
	conflicts: readonly ConflictAskSeed[];
	/**
	 * The fact said in the conversation the fold drops whole, and its question:
	 * placed in the run's last sitting when that sitting carries no noted plant,
	 * which at the full size is the quarter close.
	 */
	dropped: DroppedSeed;
	/** The questions without a hint, taken whole and never per ability. */
	noHint: readonly NoHintSeed[];
}

const EN_LABELS: RecallLabels = {
	days: "days",
	weeks: "weeks",
	words: ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen", "twenty"],
};

const DE_LABELS: RecallLabels = {
	days: "Tage",
	weeks: "Wochen",
	words: ["null", "ein", "zwei", "drei", "vier", "fünf", "sechs", "sieben", "acht", "neun", "zehn", "elf", "zwölf", "dreizehn", "vierzehn", "fünfzehn", "sechzehn", "siebzehn", "achtzehn", "neunzehn", "zwanzig"],
};

// --- The English room: a utility's data platform through an audit year -------

const EN_SESSIONS: readonly SessionSeed[] = [
	{
		title: "The auditors' export",
		topic: "Audit and evidence",
		arc: "Went through the auditors' checklist for the export and fixed the two numbers in it.",
		opening: "The auditors sent their checklist for the export. Can we go through it?",
		openingReply: "Yes. It is short, but the two numbers in it have to stand today.",
		plants: [
			{ key: "e01", ask: "Which port do they expect the export to be served on?", line: "The auditors' export runs on port 8443 ({m}), and that stays fixed for the whole audit." },
			{ key: "u01old", ask: "And how far back does it have to reach?", line: "The audit window covers 14 months of meter reads ({m}), counted back from the filing date." },
			{ key: "x01a", shape: "duplicate", topic: "Audit and evidence", ask: "And how does the bundle reach them?", line: "The auditors' evidence bundle is delivered as one signed archive file, never as loose exports [{m}]." },
		],
		closing: "Good. I will send the checklist back with those two lines in it.",
		closingReply: "Both are written down. Nothing else on the list needs a decision from us.",
	},
	{
		title: "Choosing who builds the export",
		topic: "Vendor contracts",
		arc: "Awarded the export build and settled how the invoices are paid.",
		opening: "We have to decide who actually builds the export. Two offers left.",
		openingReply: "Both can do it; the difference is how much of our own time they need.",
		plants: [
			{ key: "p01a", ask: "Then let us take the one that needs less of ours.", line: "The auditors' export is built by Fenwick Data ({m}), not by our own platform team." },
			{ key: "e02", ask: "And how do we pay them?", line: "Fenwick Data invoices monthly and is paid 30 days net ({m}), with no early-payment discount." },
			{ key: "c01", noted: false, ask: "And the bid we are turning down — what was in it?", line: "The other bid came from Kesterline Systems ({m}), about a fifth cheaper but with our own people doing the loading." },
		],
		closing: "I will tell the other bidder today.",
		closingReply: "Then the build starts with them next week.",
	},
	{
		title: "The audit window reopened",
		topic: "Audit and evidence",
		arc: "The auditors widened the window, and the sign-off on the bundle got a name.",
		opening: "The auditors say the window is not enough for the comparison year.",
		openingReply: "Then it has to grow, and the export gets rebuilt once.",
		plants: [
			{ key: "u01new", ask: "How far back do they want to go?", line: "The audit window now covers 26 months of meter reads ({m}); the earlier, shorter window no longer applies.", supersedes: "u01old" },
			{ key: "p02a", ask: "And who signs the bundle off before it goes out?", line: "The evidence bundle is signed off by Ruth Okafor ({m}) before anything reaches the auditors." },
			{ key: "x02a", shape: "conflict-long", topic: "Vendor contracts", ask: "While we are on dates: when does the Nordwind maintenance contract renew?", line: "The Nordwind maintenance contract renews automatically on 1 June [{m}]." },
		],
		closing: "Fine. I will warn the vendor about the rebuild.",
		closingReply: "The wider window is on record with the sign-off beside it.",
	},
	{
		title: "Contract paperwork for the export",
		topic: "Vendor contracts",
		arc: "Read the vendor contract back from legal: the renewal date and the ceiling it carries.",
		opening: "The contract came back from legal. Anything we have to remember?",
		openingReply: "Two things, and both are a date or money.",
		plants: [
			{ key: "p01b", ask: "When does it come up for renewal?", line: "The Fenwick Data contract renews on 2026-11-30 ({m}), with a 60-day notice window before that." },
			{ key: "u02old", ask: "And what is the ceiling on it?", line: "The Fenwick Data contract is capped at 40,000 EUR ({m}) for the whole audit year." },
			{ key: "x01b", shape: "duplicate", topic: "Audit and evidence", ask: "And the delivery format, does the contract fix it?", line: "The auditors' evidence bundle is delivered as one signed archive file, never as loose exports [{m}]." },
		],
		closing: "Then I will put the notice date in the calendar.",
		closingReply: "Renewal and ceiling are both noted.",
	},
	{
		title: "Who signs while people are away",
		topic: "People and roles",
		arc: "Walked the sign-off chain for the summer and found the one gap in it.",
		opening: "Holiday season. Does the bundle sign-off have cover?",
		openingReply: "One gap, and it is a long one.",
		plants: [
			{ key: "p02b", ask: "Which gap?", line: "Ruth Okafor is on parental leave from 2026-09-01 ({m}), so the sign-off needs a deputy from that date." },
			{ key: "c02", noted: false, ask: "And where does a sign-off actually arrive?", line: "The sign-off has gone through the shared mailbox evidence-signoff ({m}) since the first audit year." },
			{ key: "x03a", shape: "conflict-short", topic: "Audit and evidence", ask: "When do the auditors start their fieldwork?", line: "Auditor fieldwork starts 18 May [{m}]." },
		],
		closing: "I will ask the risk team for a deputy.",
		closingReply: "The leave date is written down against the sign-off.",
	},
	{
		title: "The budget revision",
		topic: "Commercial terms",
		arc: "Finance reopened the audit-year line and the ceiling on the export build moved.",
		opening: "Finance reopened the audit-year line. The ceiling does not hold.",
		openingReply: "Then it moves, once, and with a number we can defend.",
		plants: [
			{ key: "u02new", ask: "How high?", line: "The Fenwick Data contract is capped at 55,000 EUR ({m}) after the revision, and the earlier ceiling no longer applies.", supersedes: "u02old" },
			{ key: "c03", noted: false, ask: "What do they call this round in their own papers?", line: "Finance calls the reopening the Kestrel review ({m}), after the project code on the budget line." },
			{ key: "x02b", shape: "conflict-long", topic: "Vendor contracts", supersedes: "x02a", ask: "And the Nordwind maintenance contract, did the revision move its renewal?", line: "The Nordwind maintenance contract renews automatically on 1 July [{m}]." },
		],
		closing: "I will confirm it with the vendor.",
		closingReply: "The new ceiling is the one on record.",
	},
	{
		title: "The cutover weekend",
		topic: "Migration",
		arc: "Fixed the weekend the warehouse moves on and the freeze around it.",
		opening: "We need a date for the warehouse cutover before the audit work starts.",
		openingReply: "There is exactly one weekend that does not collide with a billing run.",
		plants: [
			{ key: "e03", ask: "Which one?", line: "The warehouse cutover runs on the weekend of 2026-07-11 ({m}), starting Friday evening." },
			{ key: "u03old", ask: "And how long is the freeze around it?", line: "The cutover freeze lasts 48 hours ({m}), so no schema change lands in that window." },
			{ key: "x04a", shape: "moved-event", topic: "Sprint calendar", ask: "And the sprint review, does it collide with the weekend?", line: "Sprint 12 review is on 20 May [{m}]." },
		],
		closing: "I will announce the weekend to the consumers.",
		closingReply: "Date and freeze are both on record.",
	},
	{
		title: "The dry run",
		topic: "Migration",
		arc: "Read the dry run's numbers and named who carries the migration.",
		opening: "The dry run finished overnight. How did it go?",
		openingReply: "Better than the estimate, and it tells us the real window.",
		plants: [
			{ key: "e04", ask: "What did it actually move?", line: "The migration dry run moved 41 million rows in 6 hours ({m}), with two retries on the meter tables." },
			{ key: "p03a", ask: "And who owns the cutover itself?", line: "The migration is led by Jonas Weber ({m}), end to end, including the cutover night." },
			{ key: "x03b", shape: "conflict-short", topic: "Audit and evidence", supersedes: "x03a", ask: "Does the dry run's result change when the auditors come?", line: "Auditor fieldwork starts 15 June [{m}]." },
		],
		closing: "Then the weekend is realistic.",
		closingReply: "Numbers and owner are written down.",
	},
	{
		title: "On-call after the cutover",
		topic: "Process agreements",
		arc: "Agreed the rotation the cutover leaves behind and how its owner is reached.",
		opening: "After the cutover somebody has to carry the pager.",
		openingReply: "A rotation, not a person, or it collapses in the second week.",
		plants: [
			{ key: "e05", ask: "What shape does it have?", line: "The on-call rotation runs 7 days and starts Wednesday at 09:00 ({m}), one platform engineer at a time." },
			{ key: "p03b", ask: "And the migration lead, how do we reach him out of hours?", line: "Jonas Weber is reachable on the platform-oncall channel ({m}) out of hours, never by phone." },
			{ key: "c04", noted: false, ask: "And the handset itself, where does it live?", line: "The on-call handset lives in the Lindholm office drawer ({m}), and whoever takes the week collects it." },
		],
		closing: "I will put the rotation in the calendar.",
		closingReply: "The rotation and the contact rule are on record.",
	},
	{
		title: "The freeze, shortened",
		topic: "Migration",
		arc: "Halved the cutover freeze and named who stands by through it.",
		opening: "The consumers pushed back on the freeze. Two days is too long for them.",
		openingReply: "It can be shorter if the reconciliation people stand by.",
		plants: [
			{ key: "u03new", ask: "How short?", line: "The cutover freeze lasts 24 hours ({m}) after the revision, and the earlier, longer freeze no longer applies.", updates: "u03old" },
			{ key: "p04a", ask: "Who stands by in that day?", line: "The reconciliation job is owned throughout by the billing squad ({m}), four people since the migration, and they are on standby for the freeze." },
			{ key: "x05a", shape: "decoy", topic: "Sprint calendar", ask: "And the next sprint review after the freeze?", line: "Sprint 14 review is on 3 July [{m}]." },
		],
		closing: "I will tell the consumers.",
		closingReply: "The shorter freeze and the standby are on record.",
	},
	{
		title: "When the reconciliation runs",
		topic: "Data and reporting",
		arc: "Set the reconciliation job's slot and the variance it may pass.",
		opening: "The reconciliation job needs a slot that never touches the billing run.",
		openingReply: "There is a quiet hour before the morning loads.",
		plants: [
			{ key: "e06", ask: "Which hour?", line: "The reconciliation job runs at 03:40 UTC ({m}) every day, once the nightly loads have settled." },
			{ key: "u04old", ask: "And what variance does it let through?", line: "The reconciliation tolerates a variance of 0.5 percent ({m}) before it raises a ticket." },
			{ key: "x04b", shape: "moved-event", topic: "Sprint calendar", supersedes: "x04a", ask: "The sprint 12 review moved, did it not?", line: "Sprint 12 review is on 10 June [{m}]." },
		],
		closing: "Good, then finance sees it before their morning.",
		closingReply: "Slot and tolerance are written down.",
	},
	{
		title: "The variance, tightened",
		topic: "Data and reporting",
		arc: "Tightened the reconciliation tolerance and wrote down who asked for it.",
		opening: "The first month let more through than finance can live with.",
		openingReply: "Then the tolerance moves; the job itself stays where it is.",
		plants: [
			{ key: "u04new", ask: "To what?", line: "The reconciliation tolerates a variance of 0.2 percent ({m}) from this month on, and the earlier, looser tolerance no longer applies.", supersedes: "u04old" },
			{ key: "p04b", ask: "Who asked for the tighter number?", line: "The billing squad reports to the finance lead ({m}), not to the platform lead, and the tighter number came from there." },
			{ key: "c05", noted: false, ask: "How did finance find the drift in the first place?", line: "Finance found it with a one-off check the billing squad calls the quiet-hour sweep ({m})." },
		],
		closing: "Then finance owns the consequence too.",
		closingReply: "The tighter tolerance and the reporting line are on record.",
	},
	{
		title: "Hiring for the platform team",
		topic: "Team and hiring",
		arc: "Opened the platform role and walked the interview loop as it stands.",
		opening: "We are allowed one hire. What are we opening?",
		openingReply: "The gap is the warehouse side, not the pipelines.",
		plants: [
			{ key: "e07", ask: "So what goes in the posting?", line: "The open role is a senior data engineer at grade P4 ({m}), warehouse side, starting in Q3." },
			{ key: "u05old", ask: "And the loop as it stands?", line: "The interview loop has five stages ({m}), including a take-home exercise." },
			{ key: "x05b", shape: "decoy", topic: "Sprint calendar", ask: "And the sprint review after that one?", line: "Sprint 15 review is on 17 July [{m}]." },
		],
		closing: "I will get the posting written.",
		closingReply: "Role and loop are written down.",
	},
	{
		title: "The loop, trimmed",
		topic: "Team and hiring",
		arc: "Cut a stage out of the interview loop and named who chairs it.",
		opening: "Candidates are dropping out in the middle of the loop.",
		openingReply: "It is too long for the market, and one stage carries little.",
		plants: [
			{ key: "u05new", ask: "Which one goes?", line: "The interview loop has four stages ({m}) from now on, the take-home is gone, and the earlier, longer loop no longer applies.", supersedes: "u05old" },
			{ key: "p05a", ask: "Who chairs it?", line: "The interview loop is chaired by Priya Raman ({m}), who joined the team two years ago and writes the final recommendation." },
			{ key: "c06", noted: false, ask: "Which exercise is it that goes?", line: "The take-home that goes is the Brannerud case study ({m}), which two candidates had already started." },
		],
		closing: "Then we can move the two candidates in flight.",
		closingReply: "The shorter loop and its chair are on record.",
	},
	{
		title: "The security review and its clearance",
		topic: "Compliance",
		arc: "Tracked the security review of the export and the one signature it waits for.",
		opening: "Security wants a review before the export leaves our network.",
		openingReply: "It is raised already; the question is who clears it.",
		plants: [
			{ key: "e08", ask: "Under which ticket?", line: "The security review of the export runs under ticket SEC-2291 and blocks the first delivery ({m})." },
			{ key: "p05b", ask: "And the clearance?", line: "Priya Raman works Tuesday to Friday ({m}), so the clearance never lands on a Monday." },
		],
		closing: "Then we plan the delivery for a Wednesday.",
		closingReply: "The ticket and the working days are written down.",
	},
	{
		title: "The access review",
		topic: "Compliance",
		arc: "The access review got an owner and a first count.",
		opening: "The access review is due. Who actually runs it this time?",
		openingReply: "Not us, and that is the whole point of it.",
		plants: [
			{ key: "p06a", ask: "Then who?", line: "The access review is run by the risk team ({m}), the third year in a row, with the platform team only supplying the exports." },
			{ key: "u06old", ask: "What did the first pass find?", line: "The access review found 12 dormant accounts ({m}) in the platform tooling." },
		],
		closing: "I will pass the list to the owners.",
		closingReply: "Owner and count are written down.",
	},
	{
		title: "The dormant accounts, recounted",
		topic: "Compliance",
		arc: "The dormant-account count did not survive a second pass.",
		opening: "Risk says the first pass missed the service accounts.",
		openingReply: "Then the number is wrong and the list has to go out again.",
		plants: [
			{ key: "u06new", ask: "What is it now?", line: "The access review found 19 dormant accounts ({m}) after the recount, and the earlier, lower count no longer applies.", supersedes: "u06old" },
			{ key: "c07", noted: false, ask: "How was the recount actually done?", line: "The recount was run with the script the risk team calls dormant-scan ({m}), not by hand." },
		],
		closing: "I will send the corrected list.",
		closingReply: "The corrected count is the one on record.",
	},
	{
		title: "The portal pilot",
		topic: "Product decisions",
		arc: "Picked the portal's first pilot account and the clearance it waits for.",
		opening: "The portal is ready for one account. Which one?",
		openingReply: "One that complains early and in writing.",
		plants: [
			{ key: "e09", ask: "Then who?", line: "The portal's first pilot account is Halvorsen Bau ({m}), on their own request." },
			{ key: "p06b", ask: "And the clearance before we switch them on?", line: "The risk team meets on the last Thursday of the month ({m}), and the pilot waits for that meeting." },
		],
		closing: "Then we aim for the Friday after.",
		closingReply: "The account and the clearance date are on record.",
	},
	{
		title: "The rollout order",
		topic: "Product decisions",
		arc: "Sized the portal's first wave and named who owns its design.",
		opening: "After the pilot, how many accounts go into the first wave?",
		openingReply: "Few enough that every ticket is answered by hand.",
		plants: [
			{ key: "u07old", ask: "How many is that?", line: "The portal opens to three accounts in the first wave ({m}), one per region." },
			{ key: "p07a", ask: "And who decides how it looks?", line: "The portal's design is owned by the customer success lead ({m}), with two reviewers and no design committee." },
		],
		closing: "I will draft the invitation mail.",
		closingReply: "Wave size and design owner are written down.",
	},
	{
		title: "The first wave, resized",
		topic: "Product decisions",
		arc: "The first wave grew as far as support could carry it.",
		opening: "Support says a wave that small is not worth the setup.",
		openingReply: "Then it grows, but only as far as support can answer.",
		plants: [
			{ key: "u07new", ask: "How far?", line: "The portal opens to six accounts in the first wave ({m}) after the revision, and the earlier, smaller wave no longer applies.", updates: "u07old" },
			{ key: "c08", noted: false, ask: "How did support work out what they can carry?", line: "Support worked the number out on a spreadsheet they call the wave calculator ({m})." },
		],
		closing: "Six it is.",
		closingReply: "The larger wave is the one on record.",
	},
	{
		title: "The freshness promise",
		topic: "Data and reporting",
		arc: "Fixed the freshness the portal promises and where the number is shown.",
		opening: "The portal has to say something about how fresh the data is.",
		openingReply: "Then it has to be a number we can hold every day.",
		plants: [
			{ key: "e10", ask: "What can we hold?", line: "The freshness SLA for the portal is 99.5 percent ({m}), measured over a calendar month." },
			{ key: "p07b", ask: "And where does the number go?", line: "The design owner wants the freshness number on the portal status page ({m}) rather than in the monthly deck." },
		],
		closing: "I will ask for a status page then.",
		closingReply: "The promise and its place are written down.",
	},
	{
		title: "Cost governance",
		topic: "Commercial terms",
		arc: "Read the platform's monthly spend and put it in front of the right meeting.",
		opening: "Finance wants a number for the platform every month.",
		openingReply: "They can have it, with the date it was measured on.",
		plants: [
			{ key: "u08old", ask: "What is it right now?", line: "The monthly platform spend is 9,400 EUR ({m}) as measured in June." },
			{ key: "p08a", ask: "And where is it reviewed?", line: "The platform spend is reviewed in the Q3 cost meeting ({m}), once per quarter and not in the monthly call." },
		],
		closing: "Then I will prepare one slide.",
		closingReply: "The number and the meeting are on record.",
	},
	{
		title: "Spend after the migration",
		topic: "Commercial terms",
		arc: "The migration changed the monthly spend, and the meeting that reads it got a chair.",
		opening: "The first bill after the cutover came in.",
		openingReply: "Lower, and it should stay lower once the old cluster is gone.",
		plants: [
			{ key: "u08new", ask: "How much lower?", line: "The monthly platform spend is 7,100 EUR ({m}) after the migration, and the earlier, higher figure no longer applies.", supersedes: "u08old" },
			{ key: "p08b", ask: "Who runs the quarterly meeting that reads this?", line: "The Q3 cost meeting is chaired by Dario Lenz ({m}), the division head, who wants the numbers a week ahead." },
		],
		closing: "Then the slide goes out next Monday.",
		closingReply: "The new figure and the chair are written down.",
	},
	{
		title: "The regulatory report",
		topic: "Compliance",
		arc: "Went through the regulatory report: when it is due and what it is built from.",
		opening: "The regulator's monthly report — do we still build it by hand?",
		openingReply: "Half of it. The due date is the part that hurts.",
		plants: [
			{ key: "u09old", ask: "When is it due?", line: "The regulatory report is due on the 10th of the month ({m}), for the month before." },
			{ key: "p09a", ask: "And what is it built from?", line: "The regulatory report is compiled from the meter-read mart ({m}), never from the raw loads." },
			{ key: "c09", noted: false, ask: "Which form does the regulator want it on?", line: "The regulator's own form is called RB-1402 ({m}) and has not changed in three years." },
		],
		closing: "Then the mart has to be right the day before.",
		closingReply: "Due date and source are written down.",
	},
	{
		title: "The deadline moved",
		topic: "Compliance",
		arc: "The regulator pulled the monthly deadline forward for everyone.",
		opening: "The regulator moved the deadline for everyone.",
		openingReply: "Forward, of course. It changes the rhythm of the whole month.",
		plants: [
			{ key: "u09new", ask: "To when?", line: "The regulatory report is due on the 5th of the month ({m}) from this quarter on, and the earlier, later date no longer applies.", updates: "u09old" },
		],
		closing: "I will move the internal checks with it.",
		closingReply: "The earlier deadline is the one on record.",
	},
	{
		title: "The meter-read mart",
		topic: "Data and reporting",
		arc: "Walked the mart the report is built from and how often it moves.",
		opening: "How current is the mart when the report is built?",
		openingReply: "Current enough, as long as nobody builds at noon.",
		plants: [
			{ key: "p09b", ask: "How often does it move?", line: "The meter-read mart refreshes every four hours ({m}), with the last run at 20:00 UTC." },
		],
		closing: "Then the report is built in the morning.",
		closingReply: "The refresh rhythm is written down.",
	},
	{
		title: "The failed load",
		topic: "Incident learnings",
		arc: "Went through the failed overnight load: how long it showed and what caused it.",
		opening: "The overnight load failed and the portal was stale this morning.",
		openingReply: "One cause, and it came from outside.",
		plants: [
			{ key: "u10old", ask: "How long was it stale?", line: "The failed load left the portal stale for 3 hours ({m}) before the rerun caught up." },
			{ key: "p10a", ask: "And the cause?", line: "The failed load was caused by the vendor's schema change ({m}), a third-party release nobody announced." },
		],
		closing: "Then we need notice from them.",
		closingReply: "Duration and cause are written down.",
	},
	{
		title: "The incident review",
		topic: "Incident learnings",
		arc: "The incident review put a longer number on the outage than the morning did.",
		opening: "The review went through the timestamps properly.",
		openingReply: "And the morning's number was the optimistic one.",
		plants: [
			{ key: "u10new", ask: "What is the real duration?", line: "The failed load left the portal stale for 5 hours ({m}) by the review's own timestamps, and the earlier, shorter figure no longer applies.", supersedes: "u10old" },
			{ key: "c10", noted: false, ask: "Who wrote the review up?", line: "The review was written up by the duty engineer, Oskar Feld ({m}), in a two-page note." },
		],
		closing: "Then the report says five.",
		closingReply: "The review's duration is the one on record.",
	},
	{
		title: "The vendor's notice rule",
		topic: "Vendor contracts",
		arc: "Got a notice rule out of the vendor after the incident.",
		opening: "Did the vendor accept anything after the incident?",
		openingReply: "One rule, in writing, and it is the one that matters.",
		plants: [
			{ key: "p10b", ask: "Which one?", line: "The vendor now announces schema changes 10 working days ahead ({m}), in writing to the platform team." },
		],
		closing: "Then we can plan around them.",
		closingReply: "The notice rule is written down.",
	},
	{
		title: "Quarter close",
		topic: "Planning",
		arc: "Read the quarter back: what landed, what moved, and what is left for the next one.",
		opening: "Last one before the quarter closes. Anything left open?",
		openingReply: "Nothing that needs a decision today; the open threads all have owners.",
		plants: [],
		bullet: "Read the quarter back and found nothing in it that needs a decision today.",
		closing: "Then we pick it up after the close.",
		closingReply: "Agreed. Nothing here outlives the sitting.",
	},
];

const EN_EXTRACTION: readonly AskSeed[] = [
	{
		question: "Which port does the auditors' export run on?",
		gold: ["8443", "port 8443"],
		evidence: ["e01"],
		literal: "export runs on port 8443",
		paraphrase: "port for the auditors export",
		variant: "export runs on port 8,443",
	},
	{
		question: "How long after invoicing is the export vendor paid?",
		gold: ["30 days net", "30 days", "net 30"],
		evidence: ["e02"],
		literal: "paid 30 days net",
		paraphrase: "Fenwick invoices payment terms",
		variant: "paid thirty days net",
	},
	{
		question: "Which weekend does the warehouse cutover run on?",
		gold: ["2026-07-11", "11 July 2026"],
		evidence: ["e03"],
		literal: "cutover runs on the weekend of 2026-07-11",
		paraphrase: "weekend chosen for warehouse cutover",
		variant: "cutover runs on the weekend of 11 July 2026",
	},
	{
		question: "How many rows did the migration dry run move?",
		gold: ["41 million", "41 million rows", "41,000,000"],
		evidence: ["e04"],
		literal: "moved 41 million rows in 6 hours",
		paraphrase: "rows moved by the migration rehearsal",
		variant: "moved 41,000,000 rows in six hours",
	},
	{
		question: "On which day does the on-call rotation change over?",
		gold: ["Wednesday", "Wednesday at 09:00"],
		evidence: ["e05"],
		literal: "starts Wednesday at 09:00",
		paraphrase: "rotation handover for the platform engineer",
		variant: "starts Wednesday at 9 a.m.",
	},
	{
		question: "At what time does the reconciliation job run?",
		gold: ["03:40 UTC", "03:40", "3:40"],
		evidence: ["e06"],
		literal: "reconciliation job runs at 03:40 UTC",
		paraphrase: "reconciliation run before the nightly loads",
		variant: "reconciliation job runs at 3:40 a.m. UTC",
	},
	{
		question: "What grade is the open platform role at?",
		gold: ["P4", "grade P4"],
		evidence: ["e07"],
		literal: "senior data engineer at grade P4",
		paraphrase: "grade of the senior engineer role",
		variant: "senior data engineer at level P4",
	},
	{
		question: "Under which ticket does the security review of the export run?",
		gold: ["SEC-2291", "SEC 2291"],
		evidence: ["e08"],
		literal: "ticket SEC-2291 and blocks the first delivery",
		paraphrase: "ticket for the security review",
		variant: "ticket SEC-2291 and blocks the 1st delivery",
	},
	{
		question: "Which account is the portal's first pilot?",
		gold: ["Halvorsen Bau", "Halvorsen"],
		evidence: ["e09"],
		literal: "first pilot account is Halvorsen Bau",
		paraphrase: "pilot account chosen for the portal",
		variant: "1st pilot account is Halvorsen Bau",
	},
	{
		question: "What freshness does the portal promise?",
		gold: ["99.5 percent", "99.5%", "99.5 per cent"],
		evidence: ["e10"],
		literal: "freshness SLA for the portal is 99.5 percent",
		paraphrase: "freshness percent promised by the portal",
		variant: "freshness SLA for the portal is 99.5 per cent",
	},
];

const EN_MULTI: readonly AskSeed[] = [
	{
		question: "When does the contract of the firm that builds the auditors' export come up for renewal?",
		gold: ["2026-11-30", "30 November 2026"],
		evidence: ["p01a", "p01b"],
		literal: "export is built by Fenwick Data",
		paraphrase: "renewal date of the Fenwick export build",
		variant: "extract is built by Fenwick Data",
	},
	{
		question: "From when is the person who signs off the evidence bundle away?",
		gold: ["2026-09-01", "1 September 2026"],
		evidence: ["p02a", "p02b"],
		literal: "evidence bundle is signed off by Ruth Okafor",
		paraphrase: "leave date for Okafor, evidence bundle",
		variant: "evidence pack is signed off by Ruth Okafor",
	},
	{
		question: "How is the person leading the migration reached outside working hours?",
		gold: ["the platform-oncall channel", "platform-oncall"],
		evidence: ["p03a", "p03b"],
		literal: "migration is led by Jonas Weber",
		paraphrase: "night contact for Weber, migration lead",
		variant: "migration is run by Jonas Weber",
	},
	{
		question: "Who does the owner of the reconciliation job report to?",
		gold: ["the finance lead", "finance lead"],
		evidence: ["p04a", "p04b"],
		literal: "reconciliation job is owned throughout by the billing squad",
		paraphrase: "reporting line above the billing squad",
		variant: "reconciliation task is owned throughout by the billing squad",
	},
	{
		question: "Which days of the week is the person chairing the interview loop at work?",
		gold: ["Tuesday to Friday", "Tuesday through Friday"],
		evidence: ["p05a", "p05b"],
		literal: "interview loop is chaired by Priya Raman",
		paraphrase: "working days of Raman, interview chair",
		variant: "interview round is chaired by Priya Raman",
	},
	{
		question: "When does the team that runs the access review meet?",
		gold: ["the last Thursday of the month", "last Thursday"],
		evidence: ["p06a", "p06b"],
		literal: "access review is run by the risk team",
		paraphrase: "meeting rhythm of the risk team",
		variant: "access audit is run by the risk team",
	},
	{
		question: "Where does the person who owns the portal's design want the freshness number shown?",
		gold: ["the portal status page", "status page"],
		evidence: ["p07a", "p07b"],
		literal: "design is owned by the customer success lead",
		paraphrase: "design choice by the customer success lead",
		variant: "design is owned by the customer success manager",
	},
	{
		question: "Who chairs the meeting where the platform spend is reviewed?",
		gold: ["Dario Lenz", "Lenz"],
		evidence: ["p08a", "p08b"],
		literal: "reviewed in the Q3 cost meeting",
		paraphrase: "chair of the quarterly cost meeting",
		variant: "reviewed in the third-quarter cost review",
	},
	{
		question: "How often does the source the regulatory report is compiled from refresh?",
		gold: ["every four hours", "every 4 hours"],
		evidence: ["p09a", "p09b"],
		literal: "compiled from the meter-read mart",
		paraphrase: "refresh rhythm of the meter-read mart",
		variant: "assembled from the meter-read mart",
	},
	{
		question: "How much notice does the party that caused the failed load now give before a schema change?",
		gold: ["10 working days", "ten working days"],
		evidence: ["p10a", "p10b"],
		literal: "caused by the vendor's schema change",
		paraphrase: "notice now given for schema change",
		variant: "caused by the supplier's schema change",
	},
];

const EN_TEMPORAL: readonly TemporalSeed[] = [
	{
		form: "distance",
		a: "e01",
		b: "p01b",
		question: "How much time passed between the conversation that fixed the export's port and the one that fixed the vendor contract's renewal date?",
		literal: "export runs on port 8443",
		paraphrase: "days between export port and renewal",
		variant: "export runs on port 8,443",
	},
	{
		form: "order",
		a: "u01new",
		b: "u02new",
		question: "Which was settled first: the wider audit window or the higher contract ceiling?",
		goldA: ["the wider audit window", "the audit window"],
		goldB: ["the higher contract ceiling", "the contract ceiling"],
		literal: "audit window now covers 26 months",
		paraphrase: "audit window before the contract ceiling",
		variant: "audit window now covers twenty-six months",
	},
	{
		form: "distance",
		a: "e03",
		b: "e04",
		question: "How much time passed between the conversation that fixed the cutover weekend and the one that read the dry run's numbers?",
		literal: "cutover runs on the weekend of 2026-07-11",
		paraphrase: "days between cutover weekend and dry run",
		variant: "cutover runs on the weekend of 11 July 2026",
	},
	{
		form: "order",
		a: "e06",
		b: "e07",
		question: "Which came first: the reconciliation job's slot or the grade of the open platform role?",
		goldA: ["the reconciliation job's slot", "the reconciliation slot"],
		goldB: ["the grade of the open role", "the role's grade"],
		literal: "reconciliation job runs at 03:40 UTC",
		paraphrase: "reconciliation nightly slot before the role grade",
		variant: "reconciliation job runs at 3:40 a.m. UTC",
	},
	{
		form: "distance",
		a: "e04",
		b: "e10",
		question: "How much time passed between the dry run's numbers and the portal's freshness promise?",
		literal: "moved 41 million rows in 6 hours",
		paraphrase: "time from rows moved to freshness",
		variant: "moved 41,000,000 rows in six hours",
	},
	{
		form: "order",
		a: "p06a",
		b: "p07a",
		question: "Which was named first: the owner of the access review or the owner of the portal's design?",
		goldA: ["the owner of the access review", "the risk team"],
		goldB: ["the owner of the portal's design", "the customer success lead"],
		literal: "access review is run by the risk team",
		paraphrase: "risk team named before design owner",
		variant: "access review is handled by the risk team",
	},
	{
		form: "distance",
		a: "u06old",
		b: "u06new",
		question: "How much time passed between the first dormant-account count and the recount?",
		literal: "found 12 dormant accounts",
		paraphrase: "gap between dormant accounts counts",
		variant: "found twelve dormant accounts",
	},
	{
		form: "order",
		a: "u08new",
		b: "u09new",
		question: "Which came first: the lower monthly spend or the earlier reporting deadline?",
		goldA: ["the lower monthly spend", "the monthly spend"],
		goldB: ["the earlier reporting deadline", "the reporting deadline"],
		literal: "monthly platform spend is 7,100 EUR",
		paraphrase: "platform spend before the filing deadline",
		variant: "monthly platform spend is 7100 EUR",
	},
	{
		form: "distance",
		a: "e01",
		b: "u10old",
		question: "How much time passed between the first conversation about the auditors' export and the one about the failed overnight load?",
		literal: "auditors' export runs on port 8443",
		paraphrase: "weeks from export port to outage",
		variant: "auditors' export runs on port 8,443",
	},
	{
		form: "order",
		a: "e09",
		b: "e10",
		question: "Which was decided first: the portal's first pilot account or its freshness promise?",
		goldA: ["the first pilot account", "Halvorsen Bau"],
		goldB: ["the freshness promise", "the freshness SLA"],
		literal: "first pilot account is Halvorsen Bau",
		paraphrase: "pilot account before the freshness promise",
		variant: "1st pilot account is Halvorsen Bau",
	},
];

const EN_UPDATE: readonly AskSeed[] = [
	{
		question: "How many months of meter reads does the audit window cover?",
		gold: ["26 months", "twenty-six months"],
		trap: ["14 months", "fourteen months"],
		evidence: ["u01new", "u01old"],
		literal: "audit window now covers 26 months",
		paraphrase: "months the audit window covers",
		variant: "audit window now covers twenty-six months",
	},
	{
		question: "What is the ceiling on the export vendor's contract?",
		gold: ["55,000 EUR", "55000 EUR"],
		trap: ["40,000 EUR", "40000 EUR"],
		evidence: ["u02new", "u02old"],
		literal: "contract is capped at 55,000 EUR",
		paraphrase: "cap on the Fenwick contract",
		variant: "contract is capped at 55000 EUR",
	},
	{
		question: "How long is the cutover freeze?",
		gold: ["24 hours", "twenty-four hours", "one day"],
		trap: ["48 hours", "forty-eight hours", "two days"],
		evidence: ["u03new", "u03old"],
		literal: "freeze lasts 24 hours",
		paraphrase: "length of the cutover freeze",
		variant: "freeze lasts twenty-four hours",
	},
	{
		question: "What variance does the reconciliation tolerate?",
		gold: ["0.2 percent", "0.2%"],
		trap: ["0.5 percent", "0.5%"],
		evidence: ["u04new", "u04old"],
		literal: "tolerates a variance of 0.2 percent",
		paraphrase: "variance the reconciliation lets through",
		variant: "tolerates a variance of 0.2 per cent",
	},
	{
		question: "How many stages does the interview loop have?",
		gold: ["four", "four stages"],
		trap: ["five", "five stages"],
		evidence: ["u05new", "u05old"],
		literal: "interview loop has four stages",
		paraphrase: "stages left in the interview loop",
		variant: "interview loop has 4 stages",
	},
	{
		question: "How many dormant accounts did the access review find?",
		gold: ["19", "19 dormant accounts", "nineteen"],
		trap: ["12", "12 dormant accounts", "twelve"],
		evidence: ["u06new", "u06old"],
		literal: "found 19 dormant accounts",
		paraphrase: "dormant accounts the review found",
		variant: "found nineteen dormant accounts",
	},
	{
		question: "How many accounts does the portal's first wave open to?",
		gold: ["six", "six accounts"],
		trap: ["three", "three accounts"],
		evidence: ["u07new", "u07old"],
		literal: "opens to six accounts in the first wave",
		paraphrase: "accounts in the portal first wave",
		variant: "opens to 6 accounts in the 1st wave",
	},
	{
		question: "What is the monthly platform spend?",
		gold: ["7,100 EUR", "7100 EUR"],
		trap: ["9,400 EUR", "9400 EUR"],
		evidence: ["u08new", "u08old"],
		literal: "monthly platform spend is 7,100 EUR",
		paraphrase: "monthly spend on the platform",
		variant: "monthly platform spend is 7100 EUR",
	},
	{
		question: "When is the regulatory report due?",
		gold: ["the 5th", "5th of the month", "the fifth"],
		trap: ["the 10th", "10th of the month", "the tenth"],
		evidence: ["u09new", "u09old"],
		literal: "regulatory report is due on the 5th of the month",
		paraphrase: "due day for the regulatory report",
		variant: "regulatory report is due on the fifth of the month",
	},
	{
		question: "How long was the portal stale after the failed load?",
		gold: ["5 hours", "five hours"],
		trap: ["3 hours", "three hours"],
		evidence: ["u10new", "u10old"],
		literal: "stale for 5 hours",
		paraphrase: "hours the portal stayed stale",
		variant: "stale for five hours",
	},
];

const EN_ABSTENTION: readonly AbstainSeed[] = [
	{
		question: "What is the CFO's mobile number?",
		trap: ["+44 7700 900412", "07700 900412", "0151 244 8890"],
		trapPattern: "\\d{3,}",
		literal: "the CFO's mobile number",
		paraphrase: "mobile number of the finance head",
		variant: "the CFOs mobile number",
	},
	{
		question: "Which hotel did the migration team stay in over the cutover weekend?",
		trap: ["Radisson", "Scandic", "Hotel Lindqvist", "Ibis Nordkai"],
		literal: "hotel over the cutover weekend",
		paraphrase: "hotel booked for the cutover weekend",
		variant: "hotel over the switch-over weekend",
	},
	{
		question: "Who is the deputy for the evidence-bundle sign-off?",
		trap: ["Marek Sobol", "Ines Vogt", "Tom Baird"],
		literal: "the deputy for the evidence bundle sign-off",
		paraphrase: "deputy named for the evidence bundle",
		variant: "the deputy for the evidence-bundle sign off",
	},
	{
		question: "What does the portal's status page cost to run?",
		trap: ["90 EUR a month", "1,800 EUR a year", "about 250 EUR"],
		trapPattern: "\\d+\\s*(EUR|euros?)",
		literal: "the portal status page cost",
		paraphrase: "running cost of the portal status page",
		variant: "the portal status-page cost",
	},
	{
		question: "What is Fenwick Data's registered office address?",
		trap: ["12 Harbour Road", "Unit 4, Brackley Park", "Kai 7, Hamburg"],
		trapPattern: "\\d{1,4}\\s+\\w+\\s+(Road|Street|Avenue|Lane)",
		literal: "Fenwick Data's registered office",
		paraphrase: "registered office address of Fenwick Data",
		variant: "Fenwick Datas registered office",
	},
	{
		question: "Which bank does the reconciliation job pull the statements from?",
		trap: ["Norrbank", "Meridian Trust", "Sparkasse Nord"],
		literal: "the bank the reconciliation job pulls from",
		paraphrase: "bank behind the reconciliation statements",
		variant: "the bank the reconciliation run pulls from",
	},
	{
		question: "What salary was offered for the senior data engineer role?",
		trap: ["78,000 EUR", "92k", "6,500 EUR a month"],
		trapPattern: "\\d{2,3}([,.]\\d{3}|k)\\b",
		literal: "the salary for the senior data engineer role",
		paraphrase: "salary offered for the engineer role",
		variant: "the pay for the senior data engineer role",
	},
	{
		question: "How many people sit on the risk team?",
		trap: ["nine people", "a dozen", "eleven members"],
		trapPattern: "\\b\\d{1,3}\\s+(people|members|engineers)\\b",
		literal: "how many people sit on the risk team",
		paraphrase: "headcount of the risk team",
		variant: "how many staff sit on the risk team",
	},
	{
		question: "What is the password policy for the platform-oncall channel?",
		trap: ["12 characters", "rotated every 90 days", "two-factor only"],
		trapPattern: "\\d+\\s*characters",
		literal: "the password policy for the platform-oncall channel",
		paraphrase: "password rules for the oncall channel",
		variant: "the password policy for the platform on-call channel",
	},
	{
		question: "Which airline was booked for the auditors' site visit?",
		trap: ["Lufthansa", "Norwegian Air", "SAS Scandinavian"],
		literal: "the airline for the auditors' site visit",
		paraphrase: "airline booked for the auditors visit",
		variant: "the airline for the auditors site visit",
	},
];

const EN_CONVERSATION: readonly AskSeed[] = [
	{
		ability: "extraction",
		question: "Which firm made the other bid for the export build?",
		gold: ["Kesterline Systems", "Kesterline"],
		evidence: ["c01"],
		literal: "The other bid came from Kesterline Systems",
		paraphrase: "the bid that came in cheaper",
		variant: "The other offer came from Kesterline Systems",
	},
	{
		ability: "extraction",
		question: "Which mailbox does the evidence sign-off go through?",
		gold: ["evidence-signoff", "the evidence-signoff mailbox"],
		evidence: ["c02"],
		literal: "the shared mailbox evidence-signoff",
		paraphrase: "shared mailbox for the sign-off",
		variant: "the shared mail box evidence-signoff",
	},
	{
		ability: "extraction",
		question: "What does finance call the reopening of the audit-year line?",
		gold: ["the Kestrel review", "Kestrel"],
		evidence: ["c03"],
		literal: "Finance calls the reopening the Kestrel review",
		paraphrase: "finance name for the reopening",
		variant: "Finance calls the re-opening the Kestrel review",
	},
	{
		ability: "extraction",
		question: "Where is the on-call handset kept?",
		gold: ["the Lindholm office drawer", "Lindholm"],
		evidence: ["c04"],
		literal: "The on-call handset lives in the Lindholm office drawer",
		paraphrase: "where the handset lives",
		variant: "The on call handset lives in the Lindholm office drawer",
	},
	{
		ability: "extraction",
		question: "What is the one-off check that found the drift called?",
		gold: ["the quiet-hour sweep", "quiet-hour sweep"],
		evidence: ["c05"],
		literal: "the billing squad calls the quiet-hour sweep",
		paraphrase: "one-off check by the billing squad",
		variant: "the billing squad calls the quiet hour sweep",
	},
	{
		ability: "extraction",
		question: "Which take-home exercise was dropped from the interview loop?",
		gold: ["the Brannerud case study", "Brannerud"],
		evidence: ["c06"],
		literal: "the Brannerud case study",
		paraphrase: "take-home case study dropped",
		variant: "the Brannerud case-study",
	},
	{
		ability: "multi-session",
		question: "Which script does the team that runs the access review use for a recount?",
		gold: ["dormant-scan"],
		evidence: ["c07", "p06a"],
		literal: "the script the risk team calls dormant-scan",
		paraphrase: "script used for the recount",
		variant: "the script the risk team calls dormant scan",
	},
	{
		ability: "multi-session",
		question: "What did support use to work out the size of the portal's first wave?",
		gold: ["the wave calculator", "wave calculator"],
		evidence: ["c08", "u07old"],
		literal: "a spreadsheet they call the wave calculator",
		paraphrase: "spreadsheet behind the wave number",
		variant: "a spread sheet they call the wave calculator",
	},
	{
		ability: "extraction",
		question: "Which form does the regulator's monthly report go on?",
		gold: ["RB-1402", "form RB-1402"],
		evidence: ["c09"],
		literal: "The regulator's own form is called RB-1402",
		paraphrase: "the regulator form number",
		variant: "The regulators own form is called RB-1402",
	},
	{
		ability: "multi-session",
		question: "Who wrote up the review of the load that left the portal stale?",
		gold: ["Oskar Feld", "Feld"],
		evidence: ["c10", "u10old"],
		literal: "written up by the duty engineer, Oskar Feld",
		paraphrase: "author of the two-page review note",
		variant: "written up by the duty engineer, O. Feld",
	},
];

const EN_CONFLICTS: readonly ConflictAskSeed[] = [
	{
		shape: "duplicate",
		question: "How is the auditors' evidence bundle delivered?",
		gold: ["one signed archive file", "signed archive file"],
		evidence: ["x01a"],
		literal: "delivered as one signed archive file",
		paraphrase: "evidence bundle delivery format",
		variant: "delivered as 1 signed archive file",
	},
	{
		shape: "conflict-long",
		question: "When does the Nordwind maintenance contract renew?",
		gold: ["1 July", "July 1", "1st of July"],
		trap: ["1 June", "June 1", "1st of June"],
		evidence: ["x02b", "x02a"],
		literal: "Nordwind maintenance contract renews automatically on 1 July",
		paraphrase: "renewal date of the Nordwind maintenance",
		variant: "Nordwind maintenance contract renews automatically on July 1",
	},
	{
		shape: "conflict-short",
		question: "When does the auditors' fieldwork start?",
		gold: ["15 June", "June 15", "15th of June"],
		trap: ["18 May", "May 18", "18th of May"],
		evidence: ["x03b", "x03a"],
		literal: "Auditor fieldwork starts 15 June",
		paraphrase: "start of the auditor fieldwork",
		variant: "Auditor fieldwork starts June 15",
	},
	{
		shape: "moved-event",
		question: "When is the sprint 12 review?",
		gold: ["10 June", "June 10", "10th of June"],
		trap: ["20 May", "May 20", "20th of May"],
		evidence: ["x04b", "x04a"],
		literal: "Sprint 12 review is on 10 June",
		paraphrase: "date of the sprint twelve review",
		variant: "Sprint 12 review is on June 10",
	},
	{
		shape: "decoy",
		question: "When is the sprint 15 review?",
		gold: ["17 July", "July 17", "17th of July"],
		evidence: ["x05b"],
		literal: "Sprint 15 review is on 17 July",
		paraphrase: "date of the sprint fifteen review",
		variant: "Sprint 15 review is on July 17",
	},
];

/**
 * Said in the quarter close and nowhere else. The sitting plants nothing the
 * Remember writes down, so the scripted fold drops it whole, and the transcript
 * is the only place in the room that names the binder.
 */
const EN_DROPPED: DroppedSeed = {
	plant: { key: "d01", noted: false, dropped: true, ask: "And where does the quarter's read-back go once it is written?", line: "The read-back goes into the planning binder finance calls the Tollgate file ({m}), beside the earlier quarters." },
	ask: {
		ability: "extraction",
		question: "Which file does finance keep the quarter's read-back in?",
		gold: ["the Tollgate file", "Tollgate"],
		evidence: ["d01"],
		literal: "the planning binder finance calls the Tollgate file",
		paraphrase: "binder for the quarter read-back",
		variant: "the planning folder finance calls the Tollgate file",
	},
};

/**
 * Six things said in passing and never written down, each in a sitting that
 * notes other things, and each asked about the way a person asks who does not
 * remember how it was put: no word of the question is a word of the exchange,
 * apart from the thing it is about.
 */
const EN_NO_HINT: readonly NoHintSeed[] = [
	{
		session: 7,
		entity: "cutover",
		plant: { key: "n01", noted: false, noHint: true, ask: "One aside: where does everybody sit on the cutover night?", line: "For the cutover the whole crew sits in the Marlow room on the second floor ({m}), because it has the only wall screen." },
		ask: {
			question: "If I want to join the people doing the cutover in person, which door do I knock on?",
			gold: ["the Marlow room", "Marlow"],
			evidence: ["n01"],
			literal: "the Marlow room on the second floor",
			paraphrase: "crew room on the cutover night",
			variant: "the Marlow room on the 2nd floor",
		},
	},
	{
		session: 8,
		entity: "dry run",
		plant: { key: "n02", noted: false, noHint: true, ask: "Where did you start it from, in the end?", line: "The dry run was started from the old jump host, the one called Pelican ({m}), because the new one had no route to the warehouse yet." },
		ask: {
			question: "Which machine did we kick the dry run off on?",
			gold: ["Pelican"],
			evidence: ["n02"],
			literal: "the old jump host, the one called Pelican",
			paraphrase: "jump host that started the rehearsal",
			variant: "the old jumphost, the one called Pelican",
		},
	},
	{
		session: 15,
		entity: "security review",
		plant: { key: "n03", noted: false, noHint: true, ask: "Is that our own people looking at it?", line: "The security review is being done by an outside firm, Garrow & Finch ({m}), because our own team wrote the export." },
		ask: {
			question: "Who is carrying out the security review for us?",
			gold: ["Garrow & Finch", "Garrow and Finch", "Garrow"],
			evidence: ["n03"],
			literal: "an outside firm, Garrow & Finch",
			paraphrase: "outside firm doing the security review",
			variant: "an outside firm, Garrow and Finch",
		},
	},
	{
		session: 18,
		entity: "Halvorsen Bau",
		plant: { key: "n04", noted: false, noHint: true, ask: "And who over there actually writes to us?", line: "At Halvorsen Bau the person who files the complaints is their office manager, Ingrid Solbakken ({m}), and she writes on Mondays." },
		ask: {
			question: "Who is our contact at Halvorsen Bau?",
			gold: ["Ingrid Solbakken", "Solbakken"],
			evidence: ["n04"],
			literal: "their office manager, Ingrid Solbakken",
			paraphrase: "office manager who files the complaints",
			variant: "their office manager, I. Solbakken",
		},
	},
	{
		session: 22,
		entity: "platform spend",
		plant: { key: "n05", noted: false, noHint: true, ask: "What is most of that, by the way?", line: "Most of the platform spend is the warehouse licence from Corvane ({m}); compute is the smaller part." },
		ask: {
			question: "Which supplier takes the biggest slice of the platform spend?",
			gold: ["Corvane"],
			evidence: ["n05"],
			literal: "the warehouse licence from Corvane",
			paraphrase: "warehouse licence share of the spend",
			variant: "the warehouse license from Corvane",
		},
	},
	{
		session: 26,
		entity: "failed load",
		plant: { key: "n06", noted: false, noHint: true, ask: "Who saw it first, by the way?", line: "The failed load was first spotted on the wallboard in the Dunmore control room ({m}), before any alarm reached the pager." },
		ask: {
			question: "Where did someone notice the failed load ahead of everyone else?",
			gold: ["the Dunmore control room", "Dunmore"],
			evidence: ["n06"],
			literal: "the wallboard in the Dunmore control room",
			paraphrase: "wallboard where the load was spotted",
			variant: "the wall board in the Dunmore control room",
		},
	},
];

const EN_FILLER: ReadonlyArray<{ user: string; assistant: string }> = [
	{ user: "Before that — did the old dashboard link ever get fixed?", assistant: "It resolves again. Nothing there is worth keeping." },
	{ user: "The line was terrible for the first few minutes.", assistant: "That was the office connection again; after we switched it was fine." },
	{ user: "I still cannot find the old deck from the spring.", assistant: "It is in the archive folder, but nothing in it is current any more." },
	{ user: "Quick aside: the printer on the third floor is out of paper.", assistant: "Noted, although that one is not ours to fix." },
	{ user: "Has the ticket bot stopped duplicating comments?", assistant: "Mostly. Once a week it repeats itself and then it behaves." },
	{ user: "I lost ten minutes to the network before this call.", assistant: "Same here. It is a known thing and nobody is chasing it." },
];

// --- The German room: another company, its own facts -------------------------

const DE_SESSIONS: readonly SessionSeed[] = [
	{
		title: "Der Prüfexport",
		topic: "Prüfung und Nachweise",
		arc: "Die Liste der Prüfstelle durchgegangen und die beiden Zahlen darin festgelegt.",
		opening: "Die Prüfstelle hat ihre Liste für den Export geschickt. Gehen wir sie durch?",
		openingReply: "Gern. Sie ist kurz, aber die beiden Zahlen darin müssen heute stehen.",
		plants: [
			{ key: "e01", ask: "Über welchen Port soll der Export laufen?", line: "Der Prüfexport läuft über Port 9443 ({m}) und bleibt dort für die ganze Prüfung." },
			{ key: "u01old", ask: "Und wie weit muss er zurückreichen?", line: "Der Prüfzeitraum umfasst 12 Monate Zählwerte ({m}), gerechnet ab dem Abgabetag." },
			{ key: "x01a", shape: "duplicate", topic: "Prüfung und Nachweise", ask: "Und wie kommt das Paket zur Prüfstelle?", line: "Das Nachweispaket geht als eine signierte Archivdatei an die Prüfstelle, nie als lose Exporte [{m}]." },
		],
		closing: "Gut, dann schicke ich die Liste mit diesen zwei Zeilen zurück.",
		closingReply: "Beides steht. Der Rest der Liste braucht keine Entscheidung von uns.",
	},
	{
		title: "Wer den Export baut",
		topic: "Lieferantenverträge",
		arc: "Der Auftrag für den Exportbau ist vergeben, und die Zahlungsfrist steht.",
		opening: "Wir müssen entscheiden, wer den Export wirklich baut. Zwei Angebote sind übrig.",
		openingReply: "Beide können es; der Unterschied ist, wie viel eigene Zeit sie brauchen.",
		plants: [
			{ key: "p01a", ask: "Dann nehmen wir das Angebot mit weniger eigener Zeit.", line: "Den Prüfexport baut die Zürcher Firma Keller Datentechnik ({m}), nicht unser eigenes Plattformteam." },
			{ key: "e02", ask: "Und wie zahlen wir?", line: "Keller Datentechnik stellt monatlich Rechnungen, die Überweisung ist fällig 21 Tage netto ({m}), ohne Skonto." },
			{ key: "c01", noted: false, ask: "Und das Angebot, das wir absagen — was stand darin?", line: "Das günstigere Angebot kam von der Firma Hegewald Systemtechnik ({m}), ein Fünftel billiger, aber mit unseren eigenen Leuten beim Laden." },
		],
		closing: "Ich sage dem anderen Anbieter heute ab.",
		closingReply: "Dann beginnt der Bau nächste Woche.",
	},
	{
		title: "Der Prüfzeitraum wird erweitert",
		topic: "Prüfung und Nachweise",
		arc: "Die Prüfstelle hat den Zeitraum gedehnt, und die Abzeichnung hat einen Namen bekommen.",
		opening: "Die Prüfstelle sagt, der Zeitraum reiche für das Vergleichsjahr nicht.",
		openingReply: "Dann muss er wachsen, und der Export wird einmal neu gebaut.",
		plants: [
			{ key: "u01new", ask: "Wie weit zurück wollen sie?", line: "Der Prüfzeitraum umfasst jetzt 24 Monate Zählwerte ({m}); der frühere, kürzere Zeitraum gilt nicht mehr.", supersedes: "u01old" },
			{ key: "p02a", ask: "Und wer zeichnet das Paket ab, bevor es hinausgeht?", line: "Das Nachweispaket zeichnet Frau Müller abschließend ab ({m}), bevor irgendetwas die Prüfstelle erreicht." },
			{ key: "x02a", shape: "conflict-long", topic: "Lieferantenverträge", ask: "Und wo wir bei Terminen sind: wann verlängert sich der Nordwind-Wartungsvertrag?", line: "Der Nordwind-Wartungsvertrag verlängert sich am 1. Juni 2026 [{m}]." },
		],
		closing: "Gut, ich warne die Firma wegen des Neubaus.",
		closingReply: "Der längere Zeitraum steht, mit der Abzeichnung daneben.",
	},
	{
		title: "Vertragsunterlagen zum Export",
		topic: "Lieferantenverträge",
		arc: "Den Vertrag aus der Rechtsabteilung gelesen: Verlängerung und Obergrenze.",
		opening: "Der Vertrag ist aus der Rechtsabteilung zurück. Etwas zu merken?",
		openingReply: "Zwei Dinge, und beide sind ein Datum oder Geld.",
		plants: [
			{ key: "p01b", ask: "Wann verlängert er sich?", line: "Der Vertrag mit Keller Datentechnik verlängert sich am 30. November 2026 ({m}), mit 60 Tagen Kündigungsfrist davor." },
			{ key: "u02old", ask: "Und die Obergrenze?", line: "Der Vertrag mit Keller Datentechnik ist für das Prüfjahr auf 40.000 EUR gedeckelt ({m})." },
			{ key: "x01b", shape: "duplicate", topic: "Prüfung und Nachweise", ask: "Und die Form der Lieferung, legt der Vertrag sie fest?", line: "Das Nachweispaket geht als eine signierte Archivdatei an die Prüfstelle, nie als lose Exporte [{m}]." },
		],
		closing: "Dann trage ich die Kündigungsfrist in den Kalender ein.",
		closingReply: "Verlängerung und Obergrenze sind notiert.",
	},
	{
		title: "Wer zeichnet, wenn jemand fehlt",
		topic: "Personen und Rollen",
		arc: "Die Vertretungskette für den Sommer durchgegangen und die eine Lücke darin gefunden.",
		opening: "Urlaubszeit. Hat die Abzeichnung eine Vertretung?",
		openingReply: "Eine Lücke, und zwar eine lange.",
		plants: [
			{ key: "p02b", ask: "Welche Lücke?", line: "Frau Müller ist ab dem 01.09.2026 in Elternzeit ({m}), die Abzeichnung braucht ab dann eine Vertretung." },
			{ key: "c02", noted: false, ask: "Und wo kommt eine Abzeichnung überhaupt an?", line: "Die Abzeichnung läuft seit dem ersten Prüfjahr über das Postfach nachweis-abzeichnung ({m})." },
			{ key: "x03a", shape: "conflict-short", topic: "Prüfung und Nachweise", ask: "Wann beginnt die Prüfung vor Ort?", line: "Der Prüfbeginn liegt im Mai [{m}]." },
		],
		closing: "Ich frage das Risikoteam nach einer Vertretung.",
		closingReply: "Das Datum steht neben der Abzeichnung.",
	},
	{
		title: "Die Budgetrunde",
		topic: "Kaufmännisches",
		arc: "Die Prüfjahr-Zeile wurde geöffnet, und die Obergrenze für den Exportbau ist gestiegen.",
		opening: "Die Finanzseite hat die Prüfjahr-Zeile wieder geöffnet. Die Obergrenze hält nicht.",
		openingReply: "Dann bewegt sie sich, einmal, und mit einer Zahl, die wir vertreten können.",
		plants: [
			{ key: "u02new", ask: "Wie hoch?", line: "Der Vertrag mit Keller Datentechnik ist nach der Änderung auf das Höchstmaß von 55.000 EUR gedeckelt ({m}); die frühere Grenze gilt nicht mehr.", supersedes: "u02old" },
			{ key: "c03", noted: false, ask: "Wie heißt diese Runde in ihren eigenen Papieren?", line: "Die Finanzseite nennt die Wiedereröffnung intern die Turmfalke-Runde ({m}), nach dem Kürzel auf der Budgetzeile." },
			{ key: "x02b", shape: "conflict-long", topic: "Lieferantenverträge", supersedes: "x02a", ask: "Und der Nordwind-Wartungsvertrag, hat die Runde seine Verlängerung verschoben?", line: "Der Nordwind-Wartungsvertrag verlängert sich am 1. Juli 2026 [{m}]." },
		],
		closing: "Ich bestätige das der Firma.",
		closingReply: "Die neue Grenze ist die, die gilt.",
	},
	{
		title: "Das Umstellungswochenende",
		topic: "Migration",
		arc: "Das Wochenende für die Umstellung des Datenlagers steht, samt Sperrfrist.",
		opening: "Wir brauchen ein Datum für die Umstellung des Datenlagers, bevor die Prüfarbeit beginnt.",
		openingReply: "Es gibt genau ein Wochenende, das nicht mit einem Abrechnungslauf kollidiert.",
		plants: [
			{ key: "e03", ask: "Welches?", line: "Die Umstellung des Datenlagers läuft am Wochenende des 11.07.2026 ({m}), ab Freitagabend." },
			{ key: "u03old", ask: "Und wie lang ist die Sperrfrist darum?", line: "Die Sperrfrist um die Umstellung dauert 48 Stunden ({m}), in dieser Zeit geht keine Schemaänderung live." },
			{ key: "x04a", shape: "moved-event", topic: "Sprintkalender", ask: "Und das Sprint-Review, kollidiert es mit dem Wochenende?", line: "Das Sprint-12-Review findet am 20.05.2026 statt [{m}]." },
		],
		closing: "Ich kündige das Wochenende bei den Abnehmern an.",
		closingReply: "Datum und Sperrfrist stehen.",
	},
	{
		title: "Der Probelauf",
		topic: "Migration",
		arc: "Die Zahlen des Probelaufs gelesen und die Leitung der Migration benannt.",
		opening: "Der Probelauf ist über Nacht durchgelaufen. Wie war er?",
		openingReply: "Besser als geschätzt, und er zeigt das echte Zeitfenster.",
		plants: [
			{ key: "e04", ask: "Was hat er bewegt?", line: "Der Probelauf vom 27. Juni 2026 hat über Nacht 41 Millionen Zeilen in 6 Stunden bewegt ({m}), mit zwei Wiederholungen auf den Zählwerttabellen." },
			{ key: "p03a", ask: "Und wer führt die Umstellung selbst?", line: "Die Migration führt seit dem 2. März 2026 Jörg Käser ({m}), von Anfang bis Ende, auch die Übergabe in der Umstellungsnacht." },
			{ key: "x03b", shape: "conflict-short", topic: "Prüfung und Nachweise", supersedes: "x03a", ask: "Ändert das Ergebnis des Probelaufs, wann die Prüfstelle kommt?", line: "Der Prüfbeginn liegt im Juni [{m}]." },
		],
		closing: "Dann ist das Wochenende realistisch.",
		closingReply: "Zahlen und Leitung sind notiert.",
	},
	{
		title: "Rufbereitschaft nach der Umstellung",
		topic: "Arbeitsabsprachen",
		arc: "Die Rufbereitschaft nach der Umstellung und die Erreichbarkeit ihrer Leitung.",
		opening: "Nach der Umstellung muss jemand den Rufdienst tragen.",
		openingReply: "Eine Reihenfolge, keine Person, sonst bricht es in der zweiten Woche.",
		plants: [
			{ key: "e05", ask: "Welche Form hat sie?", line: "Die Rufbereitschaft läuft 7 Tage am Stück und beginnt mittwochs um 09:00 ({m}), immer eine Person aus dem Plattformteam." },
			{ key: "p03b", ask: "Und die Migrationsleitung, wie erreichen wir sie außerhalb der Zeit?", line: "Jörg Käser ist außerhalb der Arbeitszeit nur über den Kanal plattform-rufdienst erreichbar ({m}), nie per Telefon." },
			{ key: "c04", noted: false, ask: "Und das Gerät selbst, wo liegt es?", line: "Das Rufdienst-Gerät liegt in der Schublade im Büro Weßling ({m}), wer die Woche übernimmt, holt es dort ab." },
		],
		closing: "Ich trage die Reihenfolge in den Kalender ein.",
		closingReply: "Reihenfolge und Erreichbarkeit stehen.",
	},
	{
		title: "Die Sperrfrist wird kürzer",
		topic: "Migration",
		arc: "Die Sperrfrist ist halbiert, und die Bereitschaft dafür ist benannt.",
		opening: "Die Abnehmer wehren sich gegen die Sperrfrist. Zwei Tage sind ihnen zu lang.",
		openingReply: "Kürzer geht, wenn die Abgleichleute bereitstehen.",
		plants: [
			{ key: "u03new", ask: "Wie kurz?", line: "Die Sperrfrist um die Umstellung dauert nach der Änderung 24 Stunden ({m}); die frühere, längere Sperrfrist gilt nicht mehr.", updates: "u03old" },
			{ key: "p04a", ask: "Wer steht in diesem Tag bereit?", line: "Den Abgleichlauf betreut durchgängig das Abrechnungsteam ({m}), seit der Umstellung vier Personen, und es steht während der Sperrfrist bereit." },
			{ key: "x05a", shape: "decoy", topic: "Sprintkalender", ask: "Und das nächste Sprint-Review nach der Sperrfrist?", line: "Das Sprint-14-Review findet am 3. Juli 2026 statt [{m}]." },
		],
		closing: "Ich sage es den Abnehmern.",
		closingReply: "Kürzere Sperrfrist und Bereitschaft stehen.",
	},
	{
		title: "Wann der Abgleich läuft",
		topic: "Daten und Berichte",
		arc: "Der Platz des Abgleichlaufs im Tag und die Abweichung, die er durchlässt.",
		opening: "Der Abgleichlauf braucht einen Platz, der den Abrechnungslauf nie berührt.",
		openingReply: "Es gibt eine stille Stunde vor den Morgenladungen.",
		plants: [
			{ key: "e06", ask: "Welche?", line: "Der Abgleichlauf läuft täglich um 03:40 UTC ({m}), nachdem die Nachtladungen durch sind." },
			{ key: "u04old", ask: "Und welche Abweichung lässt er durch?", line: "Der Abgleich duldet höchstens eine Abweichung von 0,5 Prozent ({m}), bevor er ein Ticket öffnet." },
			{ key: "x04b", shape: "moved-event", topic: "Sprintkalender", supersedes: "x04a", ask: "Das Sprint-12-Review ist verschoben, oder?", line: "Das Sprint-12-Review findet am 10.06.2026 statt [{m}]." },
		],
		closing: "Gut, dann sieht die Finanzseite es vor ihrem Morgen.",
		closingReply: "Platz und Toleranz sind notiert.",
	},
	{
		title: "Die Abweichung wird enger",
		topic: "Daten und Berichte",
		arc: "Die Toleranz des Abgleichs ist enger, und woher die Forderung kam, steht daneben.",
		opening: "Der erste Monat hat der Finanzseite zu viel durchgelassen.",
		openingReply: "Dann bewegt sich die Toleranz; der Lauf selbst bleibt, wo er ist.",
		plants: [
			{ key: "u04new", ask: "Auf wie viel?", line: "Der Abgleich duldet ab diesem Monat höchstens eine Abweichung von 0,2 Prozent ({m}); die frühere, weitere Toleranz gilt nicht mehr.", supersedes: "u04old" },
			{ key: "p04b", ask: "Wer hat die engere Zahl verlangt?", line: "Das Abrechnungsteam berichtet an die Finanzleitung ({m}), nicht an die Plattformleitung, und von dort kam die engere Zahl." },
			{ key: "c05", noted: false, ask: "Wie ist es der Finanzseite überhaupt aufgefallen?", line: "Gefunden hat es die Finanzseite mit einer einmaligen Prüfung, die das Abrechnungsteam den Stille-Stunde-Lauf nennt ({m})." },
		],
		closing: "Dann trägt die Finanzseite auch die Folge.",
		closingReply: "Engere Toleranz und Berichtsweg stehen.",
	},
	{
		title: "Einstellung im Plattformteam",
		topic: "Team und Einstellungen",
		arc: "Die offene Stelle ist beschrieben, und das Auswahlverfahren steht, wie es ist.",
		opening: "Wir dürfen eine Person einstellen. Was schreiben wir aus?",
		openingReply: "Die Lücke ist die Lagerseite, nicht die Strecken.",
		plants: [
			{ key: "e07", ask: "Also was steht in der Ausschreibung?", line: "Die offene Stelle ist eine Senior-Data-Engineer-Stelle der Stufe P4 ({m}), Lagerseite, Beginn im dritten Quartal." },
			{ key: "u05old", ask: "Und das Verfahren, wie es steht?", line: "Das Auswahlverfahren hat fünf Stufen ({m}), darunter eine Aufgabe für daheim." },
			{ key: "x05b", shape: "decoy", topic: "Sprintkalender", ask: "Und das Sprint-Review danach?", line: "Das Sprint-15-Review findet am 17. Juli 2026 statt [{m}]." },
		],
		closing: "Ich lasse die Ausschreibung schreiben.",
		closingReply: "Stelle und Verfahren sind notiert.",
	},
	{
		title: "Das Verfahren wird kürzer",
		topic: "Team und Einstellungen",
		arc: "Eine Stufe fällt aus dem Auswahlverfahren, und die Leitung ist benannt.",
		opening: "Bewerberinnen springen mitten im Verfahren ab.",
		openingReply: "Es ist zu lang für den Markt, und eine Stufe trägt wenig.",
		plants: [
			{ key: "u05new", ask: "Welche fällt?", line: "Das Auswahlverfahren hat künftig vier Stufen ({m}), die Aufgabe für daheim fällt weg, und das frühere, längere Verfahren gilt nicht mehr.", supersedes: "u05old" },
			{ key: "p05a", ask: "Wer leitet es?", line: "Das Auswahlverfahren leitet Beatrix Grünwald ({m}), seit dem 1. Februar 2026, und sie schreibt auch die Empfehlung." },
			{ key: "c06", noted: false, ask: "Welche Aufgabe ist es, die wegfällt?", line: "Weg fällt die Aufgabe für daheim, die Nordhavn-Fallstudie ({m}), die zwei Bewerbungen schon begonnen hatten." },
		],
		closing: "Dann können wir die zwei Bewerbungen im Lauf nachziehen.",
		closingReply: "Kürzeres Verfahren und Leitung stehen.",
	},
	{
		title: "Die Sicherheitsprüfung und ihre Freigabe",
		topic: "Regelwerk",
		arc: "Die Sicherheitsprüfung des Exports läuft, und sie wartet auf eine Unterschrift.",
		opening: "Die Sicherheitsseite will eine Prüfung, bevor der Export unser Netz verlässt.",
		openingReply: "Sie ist schon eröffnet; die Frage ist die Freigabe.",
		plants: [
			{ key: "e08", ask: "Unter welcher Nummer?", line: "Die Sicherheitsprüfung des Exports läuft gemäß Vorgabe unter dem Ticket SIP-4410 ({m}), eröffnet am 22.06.2026, und blockiert die erste Lieferung." },
			{ key: "p05b", ask: "Und die Freigabe?", line: "Beatrix Grünwald arbeitet dienstags bis freitags ({m}), die Freigabe fällt also nie auf einen Montag." },
		],
		closing: "Dann planen wir die Lieferung auf einen Mittwoch.",
		closingReply: "Ticket und Arbeitstage sind notiert.",
	},
	{
		title: "Die Zugriffsprüfung",
		topic: "Regelwerk",
		arc: "Die Zugriffsprüfung hat eine Führung und eine erste Zahl.",
		opening: "Die Zugriffsprüfung ist fällig. Wer führt sie diesmal?",
		openingReply: "Nicht wir, und genau das ist ihr Sinn.",
		plants: [
			{ key: "p06a", ask: "Dann wer?", line: "Die Zugriffsprüfung führt das Risikoteam ({m}), im dritten Jahr hintereinander, wir liefern nur die Auszüge." },
			{ key: "u06old", ask: "Was hat der erste Durchgang gefunden?", line: "Die Zugriffsprüfung hat 14 ruhende Konten zur Schließung gefunden ({m}), Stand 09.05.2026 im Plattformwerkzeug." },
		],
		closing: "Ich gebe die Liste an die Eigentümer weiter.",
		closingReply: "Führung und Zahl sind notiert.",
	},
	{
		title: "Die ruhenden Konten, nachgezählt",
		topic: "Regelwerk",
		arc: "Die Zahl der ruhenden Konten hat einen zweiten Durchgang nicht überlebt.",
		opening: "Das Risikoteam sagt, der erste Durchgang habe die Dienstkonten übersehen.",
		openingReply: "Dann ist die Zahl falsch, und die Liste muss neu hinaus.",
		plants: [
			{ key: "u06new", ask: "Wie viele sind es jetzt?", line: "Die Zugriffsprüfung hat nach dem Nachzählen 21 ruhende Konten zur Schließung gefunden ({m}); die frühere, kleinere Zahl gilt nicht mehr.", supersedes: "u06old" },
			{ key: "c07", noted: false, ask: "Wie wurde nachgezählt?", line: "Die Nachzählung lief mit dem Skript, das das Risikoteam ruhe-scan nennt ({m}), nicht von Hand." },
		],
		closing: "Ich schicke die berichtigte Liste.",
		closingReply: "Die berichtigte Zahl ist die, die gilt.",
	},
	{
		title: "Der Portal-Pilot",
		topic: "Produktentscheidungen",
		arc: "Das erste Pilotkonto des Portals und die Freigabe, auf die es wartet.",
		opening: "Das Portal ist für ein Konto bereit. Welches?",
		openingReply: "Eines, das früh und schriftlich klagt.",
		plants: [
			{ key: "e09", ask: "Also welches?", line: "Das erste Pilotkonto des Portals ist Großmann Bau ({m}), die Öffnung erfolgt auf eigenen Wunsch." },
			{ key: "p06b", ask: "Und die Freigabe, bevor wir es einschalten?", line: "Das Risikoteam trifft sich am letzten Donnerstag im Monat ({m}), der Pilot wartet auf diese Sitzung." },
		],
		closing: "Dann nehmen wir den Freitag danach.",
		closingReply: "Konto und Freigabetermin stehen.",
	},
	{
		title: "Die Reihenfolge der Freischaltung",
		topic: "Produktentscheidungen",
		arc: "Die erste Welle des Portals ist bemessen, und die Gestaltung hat eine Verantwortung.",
		opening: "Nach dem Piloten, wie viele Konten gehen in die erste Welle?",
		openingReply: "So wenige, dass jedes Ticket von Hand beantwortet wird.",
		plants: [
			{ key: "u07old", ask: "Wie viele sind das?", line: "Das Portal öffnet in der ersten Welle für drei Konten ({m}), eines je Region." },
			{ key: "p07a", ask: "Und wer entscheidet über das Aussehen?", line: "Die Gestaltung des Portals verantwortet Tobias Löwe aus der Kundenbetreuung ({m}), mit zwei Prüfenden und ohne Gestaltungsrunde." },
		],
		closing: "Ich entwerfe die Einladung.",
		closingReply: "Wellengröße und Verantwortung sind notiert.",
	},
	{
		title: "Die erste Welle neu bemessen",
		topic: "Produktentscheidungen",
		arc: "Die erste Welle ist gewachsen, soweit die Betreuung sie trägt.",
		opening: "Die Betreuung sagt, so wenige seien den Aufbau nicht wert.",
		openingReply: "Dann wächst die Welle, aber nur so weit, wie die Betreuung antwortet.",
		plants: [
			{ key: "u07new", ask: "Wie weit?", line: "Das Portal öffnet in der ersten Welle für sechs Konten ({m}); die frühere, kleinere Öffnung gilt nicht mehr.", updates: "u07old" },
			{ key: "c08", noted: false, ask: "Womit hat die Betreuung das ausgerechnet?", line: "Die Betreuung hat die Größe auf einer Tabelle ausgerechnet, die sie den Wellenrechner nennt ({m})." },
		],
		closing: "Dann sechs.",
		closingReply: "Die größere Welle ist die, die gilt.",
	},
	{
		title: "Das Frischeversprechen",
		topic: "Daten und Berichte",
		arc: "Die Frische, die das Portal verspricht, und der Ort, an dem die Zahl steht.",
		opening: "Das Portal muss etwas über die Frische der Daten sagen.",
		openingReply: "Dann muss es eine Zahl sein, die wir jeden Tag halten.",
		plants: [
			{ key: "e10", ask: "Was halten wir?", line: "Die Frische-Zusage des Portals liegt als Messgröße bei 99,5 Prozent ({m}), gemessen über einen Kalendermonat." },
			{ key: "p07b", ask: "Und wohin kommt die Zahl?", line: "Tobias Löwe will die Frischezahl auf der Statusseite des Portals sehen ({m}), nicht in der Monatsübersicht." },
		],
		closing: "Dann bitte ich um eine Statusseite.",
		closingReply: "Die Zusage und ihr Ort sind notiert.",
	},
	{
		title: "Kostensteuerung",
		topic: "Kaufmännisches",
		arc: "Die monatlichen Plattformkosten gelesen und in die richtige Runde gelegt.",
		opening: "Die Finanzseite will jeden Monat eine Zahl für die Plattform.",
		openingReply: "Sie bekommt sie, mit dem Tag, an dem gemessen wurde.",
		plants: [
			{ key: "u08old", ask: "Wie hoch ist sie jetzt?", line: "Die monatlichen Plattformkosten liegen bei 9.400 EUR ({m}), gemessen im Juni." },
			{ key: "p08a", ask: "Und wo wird sie geprüft?", line: "Die Plattformkosten werden als feste Maßnahme in der Quartalsrunde Q3 geprüft ({m}), einmal im Quartal und nicht im Monatsgespräch." },
		],
		closing: "Dann bereite ich eine Folie vor.",
		closingReply: "Zahl und Runde sind notiert.",
	},
	{
		title: "Kosten nach der Umstellung",
		topic: "Kaufmännisches",
		arc: "Die Umstellung hat die Monatskosten verändert, und die Runde hat eine Leitung.",
		opening: "Die erste Rechnung nach der Umstellung ist da.",
		openingReply: "Niedriger, und sie bleibt niedriger, sobald das alte Cluster weg ist.",
		plants: [
			{ key: "u08new", ask: "Wie viel niedriger?", line: "Die monatlichen Plattformkosten liegen nach der Umstellung bei 7.100 EUR ({m}); die frühere, höhere Zahl gilt nicht mehr.", supersedes: "u08old" },
			{ key: "p08b", ask: "Wer leitet die Quartalsrunde, die das liest?", line: "Die Quartalsrunde Q3 leitet Bereichsleiter Dario Löffler ({m}), der die Zahlen eine Woche vorher will." },
		],
		closing: "Dann geht die Folie am Montag hinaus.",
		closingReply: "Neue Zahl und Leitung sind notiert.",
	},
	{
		title: "Die Meldung an die Aufsicht",
		topic: "Regelwerk",
		arc: "Die Meldung an die Aufsicht: wann sie fällig ist und woraus sie entsteht.",
		opening: "Die monatliche Meldung an die Aufsicht — bauen wir die noch von Hand?",
		openingReply: "Die Hälfte davon. Die Frist ist der Teil, der wehtut.",
		plants: [
			{ key: "u09old", ask: "Wann ist sie fällig?", line: "Die Meldung an die Aufsicht ist am 10. des Monats fällig ({m}), für den Monat davor." },
			{ key: "p09a", ask: "Und woraus entsteht sie?", line: "Die Meldung an die Aufsicht entsteht aus dem Zählwerte-Datenbereich ({m}), nie aus den Rohladungen." },
			{ key: "c09", noted: false, ask: "Auf welchem Formular will die Aufsicht sie haben?", line: "Das eigene Formular der Aufsicht heißt RB-1402 ({m}) und hat sich seit dem 1. April 2024 nicht geändert." },
		],
		closing: "Dann muss der Bereich am Tag davor stimmen.",
		closingReply: "Frist und Quelle sind notiert.",
	},
	{
		title: "Die Frist wird vorgezogen",
		topic: "Regelwerk",
		arc: "Die Aufsicht hat die Frist für alle nach vorn gezogen.",
		opening: "Die Aufsicht hat die Frist für alle verschoben.",
		openingReply: "Nach vorn, natürlich. Das verändert den Rhythmus des ganzen Monats.",
		plants: [
			{ key: "u09new", ask: "Auf wann?", line: "Die Meldung an die Aufsicht ist ab diesem Quartal am 5. des Monats fällig ({m}); der frühere, spätere Termin gilt nicht mehr.", updates: "u09old" },
		],
		closing: "Ich ziehe die internen Kontrollen mit.",
		closingReply: "Die frühere Frist ist die, die gilt.",
	},
	{
		title: "Der Zählwerte-Datenbereich",
		topic: "Daten und Berichte",
		arc: "Den Bereich durchgegangen, aus dem die Meldung entsteht, und seinen Rhythmus.",
		opening: "Wie aktuell ist der Bereich, wenn die Meldung gebaut wird?",
		openingReply: "Aktuell genug, solange niemand mittags baut.",
		plants: [
			{ key: "p09b", ask: "Wie oft bewegt er sich?", line: "Der Zählwerte-Datenbereich wird alle vier Stunden aktualisiert ({m}), der letzte Lauf um 20:00 UTC." },
		],
		closing: "Dann wird die Meldung morgens gebaut.",
		closingReply: "Der Rhythmus ist notiert.",
	},
	{
		title: "Die gescheiterte Ladung",
		topic: "Störungen",
		arc: "Die gescheiterte Nachtladung: wie lange sie zu sehen war und woher sie kam.",
		opening: "Die Nachtladung ist gescheitert und das Portal war heute Morgen alt.",
		openingReply: "Eine Ursache, und sie kam von außen.",
		plants: [
			{ key: "u10old", ask: "Wie lange stand es alt?", line: "Die gescheiterte Ladung hat das Portal 3 Stunden alt stehen lassen ({m}), bis der Neulauf aufgeholt hatte." },
			{ key: "p10a", ask: "Und die Ursache?", line: "Die gescheiterte Ladung kam von einer Schemaänderung des Lieferanten ({m}), einer Fremdauslieferung ohne Ankündigung." },
		],
		closing: "Dann brauchen wir Vorlauf von ihnen.",
		closingReply: "Dauer und Ursache sind notiert.",
	},
	{
		title: "Die Nachbetrachtung",
		topic: "Störungen",
		arc: "Die Nachbetrachtung hat die Störung länger gemacht als der Morgen.",
		opening: "Die Nachbetrachtung ist die Zeitstempel richtig durchgegangen.",
		openingReply: "Und die Zahl vom Morgen war die freundliche.",
		plants: [
			{ key: "u10new", ask: "Wie lang war sie wirklich?", line: "Die gescheiterte Ladung hat das Portal laut Nachbetrachtung 5 Stunden alt stehen lassen ({m}); die frühere, kürzere Zahl gilt nicht mehr.", supersedes: "u10old" },
			{ key: "c10", noted: false, ask: "Wer hat sie aufgeschrieben?", line: "Die Nachbetrachtung hat der diensthabende Kollege Oskar Feldmann ({m}) auf zwei Seiten aufgeschrieben." },
		],
		closing: "Dann steht fünf im Bericht.",
		closingReply: "Die Dauer der Nachbetrachtung ist die, die gilt.",
	},
	{
		title: "Die Ankündigung des Lieferanten",
		topic: "Lieferantenverträge",
		arc: "Nach der Störung gibt der Lieferant einen Vorlauf für Ankündigungen zu.",
		opening: "Hat der Lieferant nach der Störung etwas zugesagt?",
		openingReply: "Eine Regel, schriftlich, und es ist die, die zählt.",
		plants: [
			{ key: "p10b", ask: "Welche?", line: "Der Lieferant kündigt Schemaänderungen künftig 10 Arbeitstage vorher an ({m}), schriftlich an das Plattformteam." },
		],
		closing: "Dann können wir um sie herum planen.",
		closingReply: "Die Regel ist notiert.",
	},
	{
		title: "Quartalsabschluss",
		topic: "Planung",
		arc: "Das Quartal zurückgelesen: was gelandet ist, was sich verschoben hat, was bleibt.",
		opening: "Das Letzte vor dem Quartalsabschluss. Ist etwas offen?",
		openingReply: "Nichts, das heute entschieden werden muss; die offenen Fäden haben Eigentümer.",
		plants: [],
		bullet: "Das Quartal zurückgelesen; nichts darin muss heute entschieden werden.",
		closing: "Dann nehmen wir es nach dem Abschluss wieder auf.",
		closingReply: "Einverstanden. Nichts hiervon überlebt die Sitzung.",
	},
];

const DE_EXTRACTION: readonly AskSeed[] = [
	{
		question: "Über welchen Port läuft der Prüfexport?",
		gold: ["9443", "Port 9443"],
		evidence: ["e01"],
		literal: "Der Prüfexport läuft über Port 9443",
		paraphrase: "Port für den Prüfexport",
	},
	{
		question: "Mit welcher Frist werden die Rechnungen der Firma bezahlt, die den Export baut?",
		gold: ["21 Tage netto", "21 Tage"],
		evidence: ["e02"],
		literal: "die Überweisung ist fällig 21 Tage netto",
		paraphrase: "Zahlungsfrist für die Rechnungen von Keller",
	},
	{
		question: "An welchem Wochenende läuft die Umstellung des Datenlagers?",
		gold: ["11.07.2026", "11. Juli 2026"],
		evidence: ["e03"],
		literal: "läuft am Wochenende des 11.07.2026",
		paraphrase: "Umstellung des Datenlagers, welches Wochenende",
	},
	{
		question: "Wie viele Zeilen hat der Probelauf bewegt?",
		gold: ["41 Millionen", "41 Millionen Zeilen"],
		evidence: ["e04"],
		literal: "über Nacht 41 Millionen Zeilen",
		paraphrase: "Zeilen die der Probelauf bewegt hat",
	},
	{
		question: "An welchem Tag beginnt die Rufbereitschaft?",
		gold: ["mittwochs", "Mittwoch", "mittwochs um 09:00"],
		evidence: ["e05"],
		literal: "läuft 7 Tage am Stück und beginnt mittwochs",
		paraphrase: "Wechseltag der Rufbereitschaft im Plattformteam",
	},
	{
		question: "Um welche Zeit läuft der Abgleichlauf?",
		gold: ["03:40 UTC", "03:40", "3:40"],
		evidence: ["e06"],
		literal: "läuft täglich um 03:40 UTC",
		paraphrase: "Uhrzeit vom Abgleichlauf nach den Nachtladungen",
	},
	{
		question: "Welche Stufe hat die offene Stelle im Plattformteam?",
		gold: ["P4", "Stufe P4"],
		evidence: ["e07"],
		literal: "eine Senior-Data-Engineer-Stelle der Stufe P4",
		paraphrase: "Stufe der offenen Stelle, Senior Engineer",
		variant: "eine Senior Data Engineer Stelle der Stufe P4",
	},
	{
		question: "Unter welchem Ticket läuft die Sicherheitsprüfung des Exports?",
		gold: ["SIP-4410", "SIP 4410"],
		evidence: ["e08"],
		literal: "läuft gemäß Vorgabe unter dem Ticket SIP-4410",
		paraphrase: "Ticket für die Sicherheitsprüfung des Exports",
	},
	{
		question: "Welches Konto ist das erste Pilotkonto des Portals?",
		gold: ["Großmann Bau", "Großmann"],
		evidence: ["e09"],
		literal: "erste Pilotkonto des Portals ist Großmann Bau",
		paraphrase: "Pilotkonto des Portals, erste Kundschaft",
	},
	{
		question: "Welche Frische verspricht das Portal?",
		gold: ["99,5 Prozent", "99,5 %"],
		evidence: ["e10"],
		literal: "liegt als Messgröße bei 99,5 Prozent",
		paraphrase: "Prozent der Frische-Zusage des Portals",
	},
];

const DE_MULTI: readonly AskSeed[] = [
	{
		question: "Wann verlängert sich der Vertrag der Firma, die den Prüfexport baut?",
		gold: ["30.11.2026", "30. November 2026"],
		evidence: ["p01a", "p01b"],
		literal: "Den Prüfexport baut die Zürcher Firma Keller Datentechnik",
		paraphrase: "Vertragsdatum der Firma Keller Datentechnik",
	},
	{
		question: "Ab wann ist die Person nicht da, die das Nachweispaket abzeichnet?",
		gold: ["01.09.2026", "1. September 2026"],
		evidence: ["p02a", "p02b"],
		literal: "Das Nachweispaket zeichnet Frau Müller abschließend ab",
		paraphrase: "Abwesenheit von Frau Müller, Nachweispaket",
	},
	{
		question: "Wie ist die Person außerhalb der Arbeitszeit erreichbar, die die Migration führt?",
		gold: ["über den Kanal plattform-rufdienst", "plattform-rufdienst"],
		evidence: ["p03a", "p03b"],
		literal: "Die Migration führt seit dem 2. März 2026 Jörg Käser",
		paraphrase: "Erreichbarkeit von Jörg Käser, Migration",
	},
	{
		question: "An wen berichtet die Stelle, die den Abgleichlauf betreut?",
		gold: ["an die Finanzleitung", "Finanzleitung"],
		evidence: ["p04a", "p04b"],
		literal: "Den Abgleichlauf betreut durchgängig das Abrechnungsteam",
		paraphrase: "Berichtsweg vom Abrechnungsteam beim Abgleichlauf",
	},
	{
		question: "An welchen Tagen arbeitet die Person, die das Auswahlverfahren leitet?",
		gold: ["dienstags bis freitags", "Dienstag bis Freitag"],
		evidence: ["p05a", "p05b"],
		literal: "Das Auswahlverfahren leitet Beatrix Grünwald",
		paraphrase: "Arbeitstage von Beatrix Grünwald, Auswahlverfahren",
	},
	{
		question: "Wann trifft sich das Team, das die Zugriffsprüfung führt?",
		gold: ["am letzten Donnerstag im Monat", "letzter Donnerstag im Monat"],
		evidence: ["p06a", "p06b"],
		literal: "Die Zugriffsprüfung führt das Risikoteam",
		paraphrase: "Sitzungsrhythmus vom Risikoteam bei der Zugriffsprüfung",
	},
	{
		question: "Wo will die Person die Frischezahl sehen, die die Gestaltung des Portals verantwortet?",
		gold: ["auf der Statusseite des Portals", "Statusseite"],
		evidence: ["p07a", "p07b"],
		literal: "Die Gestaltung des Portals verantwortet Tobias Löwe",
		paraphrase: "Wunsch von Tobias Löwe zur Gestaltung",
	},
	{
		question: "Wer leitet die Runde, in der die Plattformkosten geprüft werden?",
		gold: ["Dario Löffler", "Löffler"],
		evidence: ["p08a", "p08b"],
		literal: "als feste Maßnahme in der Quartalsrunde Q3 geprüft",
		paraphrase: "Leitung der Quartalsrunde für Plattformkosten",
	},
	{
		question: "Wie oft wird die Quelle aktualisiert, aus der die Meldung an die Aufsicht entsteht?",
		gold: ["alle vier Stunden", "alle 4 Stunden"],
		evidence: ["p09a", "p09b"],
		literal: "entsteht aus dem Zählwerte-Datenbereich",
		paraphrase: "Auffrischung im Zählwerte-Datenbereich für die Meldung",
	},
	{
		question: "Wie viel Vorlauf gibt die Seite vor einer Schemaänderung, von der die gescheiterte Ladung kam?",
		gold: ["10 Arbeitstage", "zehn Arbeitstage"],
		evidence: ["p10a", "p10b"],
		literal: "kam von einer Schemaänderung des Lieferanten",
		paraphrase: "Vorlauf beim Lieferanten nach der Schemaänderung",
	},
];

const DE_TEMPORAL: readonly TemporalSeed[] = [
	{
		form: "distance",
		a: "e01",
		b: "p01b",
		question: "Wie viel Zeit liegt zwischen dem Gespräch, das den Port des Prüfexports festgelegt hat, und dem, das das Verlängerungsdatum des Vertrags festgelegt hat?",
		literal: "Der Prüfexport läuft über Port 9443",
		paraphrase: "Tage zwischen Prüfexport Port und Vertrag",
	},
	{
		form: "order",
		a: "u01new",
		b: "u02new",
		question: "Was war zuerst entschieden: der längere Prüfzeitraum oder die höhere Obergrenze?",
		goldA: ["der längere Prüfzeitraum", "der Prüfzeitraum"],
		goldB: ["die höhere Obergrenze", "die Obergrenze"],
		literal: "Prüfzeitraum umfasst jetzt 24 Monate",
		paraphrase: "Prüfzeitraum und Zählwerte vor der Obergrenze",
	},
	{
		form: "distance",
		a: "e03",
		b: "e04",
		question: "Wie viel Zeit liegt zwischen dem Gespräch, das das Umstellungswochenende festgelegt hat, und dem, das die Zahlen des Probelaufs gelesen hat?",
		literal: "läuft am Wochenende des 11.07.2026",
		paraphrase: "Tage zwischen Wochenende der Umstellung und Probelauf",
	},
	{
		form: "order",
		a: "e06",
		b: "e07",
		question: "Was kam zuerst: der Platz des Abgleichlaufs im Tag oder die Stufe der offenen Stelle?",
		goldA: ["der Platz des Abgleichlaufs", "der Abgleichlauf"],
		goldB: ["die Stufe der offenen Stelle", "die Stufe"],
		literal: "läuft täglich um 03:40 UTC",
		paraphrase: "Abgleichlauf nach Nachtladungen oder Stufe zuerst",
	},
	{
		form: "distance",
		a: "e04",
		b: "e10",
		question: "Wie viel Zeit liegt zwischen den Zahlen des Probelaufs und dem Frischeversprechen des Portals?",
		literal: "über Nacht 41 Millionen Zeilen",
		paraphrase: "Abstand zwischen Probelauf Zeilen und Frischezusage",
	},
	{
		form: "order",
		a: "p06a",
		b: "p07a",
		question: "Was war zuerst benannt: die Führung der Zugriffsprüfung oder die Verantwortung für die Gestaltung des Portals?",
		goldA: ["die Führung der Zugriffsprüfung", "das Risikoteam"],
		goldB: ["die Verantwortung für die Gestaltung", "Tobias Löwe"],
		literal: "Die Zugriffsprüfung führt das Risikoteam",
		paraphrase: "Zugriffsprüfung Risikoteam vor der Gestaltung benannt",
	},
	{
		form: "distance",
		a: "u06old",
		b: "u06new",
		question: "Wie viel Zeit liegt zwischen der ersten Zählung der ruhenden Konten und dem Nachzählen?",
		literal: "hat 14 ruhende Konten zur Schließung gefunden",
		paraphrase: "ruhende Konten Zugriffsprüfung erster Durchgang",
	},
	{
		form: "order",
		a: "u08new",
		b: "u09new",
		question: "Was kam zuerst: die niedrigeren Monatskosten oder die vorgezogene Meldefrist?",
		goldA: ["die niedrigeren Monatskosten", "die Monatskosten"],
		goldB: ["die vorgezogene Meldefrist", "die Meldefrist"],
		literal: "Plattformkosten liegen nach der Umstellung bei 7.100 EUR",
		paraphrase: "Plattformkosten vor der Meldefrist, Umstellung",
		variant: "Plattformkosten liegen nach der Umstellung bei 7100 EUR",
	},
	{
		form: "distance",
		a: "e01",
		b: "u10old",
		question: "Wie viel Zeit liegt zwischen dem ersten Gespräch über den Prüfexport und dem über die gescheiterte Nachtladung?",
		literal: "läuft über Port 9443",
		paraphrase: "Wochen vom Prüfexport Port bis zur Störung",
	},
	{
		form: "order",
		a: "e09",
		b: "e10",
		question: "Was war zuerst entschieden: das erste Pilotkonto des Portals oder seine Frische-Zusage?",
		goldA: ["das erste Pilotkonto", "Großmann Bau"],
		goldB: ["die Frische-Zusage", "99,5 Prozent"],
		literal: "erste Pilotkonto des Portals ist Großmann Bau",
		paraphrase: "Pilotkonto des Portals vor der Zusage",
	},
];

const DE_UPDATE: readonly AskSeed[] = [
	{
		question: "Wie viele Monate Zählwerte umfasst der Prüfzeitraum?",
		gold: ["24 Monate", "vierundzwanzig Monate"],
		trap: ["12 Monate", "zwölf Monate"],
		evidence: ["u01new", "u01old"],
		literal: "Prüfzeitraum umfasst jetzt 24 Monate",
		paraphrase: "Monate im Prüfzeitraum für Zählwerte",
	},
	{
		question: "Auf welchen Betrag ist der Vertrag mit der Firma gedeckelt, die den Export baut?",
		gold: ["55.000 EUR", "55000 EUR"],
		trap: ["40.000 EUR", "40000 EUR"],
		evidence: ["u02new", "u02old"],
		literal: "nach der Änderung auf das Höchstmaß von 55.000 EUR",
		paraphrase: "Deckel im Vertrag mit Keller Datentechnik",
	},
	{
		question: "Wie lang ist die Sperrfrist um die Umstellung?",
		gold: ["24 Stunden", "vierundzwanzig Stunden", "ein Tag"],
		trap: ["48 Stunden", "achtundvierzig Stunden", "zwei Tage"],
		evidence: ["u03new", "u03old"],
		literal: "nach der Änderung 24 Stunden",
		paraphrase: "Dauer der Sperrfrist bei der Umstellung",
	},
	{
		question: "Welche Abweichung duldet der Abgleich?",
		gold: ["0,2 Prozent", "0,2 %"],
		trap: ["0,5 Prozent", "0,5 %"],
		evidence: ["u04new", "u04old"],
		literal: "höchstens eine Abweichung von 0,2 Prozent",
		paraphrase: "Abweichung die der Abgleich duldet",
	},
	{
		question: "Wie viele Stufen hat das Auswahlverfahren?",
		gold: ["vier", "vier Stufen"],
		trap: ["fünf", "fünf Stufen"],
		evidence: ["u05new", "u05old"],
		literal: "hat künftig vier Stufen",
		paraphrase: "Stufen im Auswahlverfahren nach der Kürzung",
	},
	{
		question: "Wie viele ruhende Konten hat die Zugriffsprüfung gefunden?",
		gold: ["21", "21 ruhende Konten", "einundzwanzig"],
		trap: ["14", "14 ruhende Konten", "vierzehn"],
		evidence: ["u06new", "u06old"],
		literal: "nach dem Nachzählen 21 ruhende Konten zur Schließung",
		paraphrase: "ruhende Konten nach dem Nachzählen",
	},
	{
		question: "Für wie viele Konten öffnet das Portal in der ersten Welle?",
		gold: ["sechs", "sechs Konten"],
		trap: ["drei", "drei Konten"],
		evidence: ["u07new", "u07old"],
		literal: "öffnet in der ersten Welle für sechs Konten",
		paraphrase: "Konten in der ersten Welle des Portals",
	},
	{
		question: "Wie hoch sind die monatlichen Plattformkosten?",
		gold: ["7.100 EUR", "7100 EUR"],
		trap: ["9.400 EUR", "9400 EUR"],
		evidence: ["u08new", "u08old"],
		literal: "Plattformkosten liegen nach der Umstellung bei 7.100 EUR",
		paraphrase: "Plattformkosten im Monat nach der Umstellung",
		variant: "Plattformkosten liegen nach der Umstellung bei 7100 EUR",
	},
	{
		question: "Wann ist die Meldung an die Aufsicht fällig?",
		gold: ["am 5.", "am 5. des Monats", "am Fünften"],
		trap: ["am 10.", "am 10. des Monats", "am Zehnten"],
		evidence: ["u09new", "u09old"],
		literal: "am 5. des Monats fällig",
		paraphrase: "Fälligkeit der Meldung an die Aufsicht",
	},
	{
		question: "Wie lange stand das Portal nach der gescheiterten Ladung alt?",
		gold: ["5 Stunden", "fünf Stunden"],
		trap: ["3 Stunden", "drei Stunden"],
		evidence: ["u10new", "u10old"],
		literal: "5 Stunden alt stehen lassen",
		paraphrase: "Stunden in denen das Portal alt stand",
		variant: "fünf Stunden alt stehen lassen",
	},
];

const DE_ABSTENTION: readonly AbstainSeed[] = [
	{
		question: "Wie lautet die Mobilnummer der Finanzleitung für Rückfragen?",
		trap: ["+49 151 2244 880", "0151 2244 880", "030 55512 44"],
		trapPattern: "\\d{3,}",
		literal: "die Mobilnummer der Finanzleitung für Rückfragen",
		paraphrase: "Rufnummer der Finanzleitung für Rückfragen",
	},
	{
		question: "In welchem Hotel hat das Migrationsteam am Umstellungswochenende übernachtet?",
		trap: ["Hotel Sonnenhof", "Steigenberger", "Gasthof Lindner"],
		literal: "das Hotel für die Übernachtung am Umstellungswochenende",
		paraphrase: "Hotel am Umstellungswochenende gebucht",
	},
	{
		question: "Wie heißt die Vertretung für die Abzeichnung des Nachweispakets?",
		trap: ["Katrin Bauer", "Markus Renz", "Frau Leitner"],
		literal: "die Vertretung für die Abzeichnung",
		paraphrase: "Vertretung bei der Abzeichnung benannt",
	},
	{
		question: "Was kostet die Statusseite des Portals im Betrieb?",
		trap: ["90 EUR im Monat", "1.200 EUR im Jahr", "rund 250 EUR"],
		trapPattern: "\\d+\\s*(EUR|Euro)",
		literal: "was die Statusseite des Portals für den Betrieb kostet",
		paraphrase: "Betrieb der Statusseite, Kosten",
	},
	{
		question: "Wie lautet die Handelsregisteradresse von Keller Datentechnik?",
		trap: ["Bahnhofstraße 12", "Seestrasse 4, Zug", "Postfach 1180"],
		trapPattern: "(Straße|Strasse|Weg|Platz)\\s*\\d{1,3}",
		literal: "die Handelsregisteradresse der Zürcher Firma Keller Datentechnik",
		paraphrase: "Anschrift der Firma Keller Datentechnik",
	},
	{
		question: "Von welcher Bank holt der Abgleichlauf die Auszüge?",
		trap: ["Nordbank", "Kantonalbank", "Sparkasse Rheintal"],
		literal: "von welcher Bank der Abgleichlauf die Auszüge holt",
		paraphrase: "Bank für die Auszüge beim Abgleichlauf",
	},
	{
		question: "Welches Gehalt wurde für die offene Stelle geboten?",
		trap: ["78.000 EUR", "92.000 EUR im Jahr", "6.500 EUR im Monat"],
		trapPattern: "\\d{2}\\.\\d{3}\\s*EUR",
		literal: "das Gehalt für die offene Stelle",
		paraphrase: "Gehalt zur offenen Stelle geboten",
	},
	{
		question: "Wie viele Personen sitzen im Risikoteam?",
		trap: ["neun Personen", "ein Dutzend", "elf Köpfe"],
		trapPattern: "\\b\\d{1,3}\\s+(Personen|Köpfe|Leute)\\b",
		literal: "wie viele Köpfe im Risikoteam sitzen",
		paraphrase: "Köpfe im Risikoteam zählen",
	},
	{
		question: "Welche Passwortregel gilt für den Kanal plattform-rufdienst?",
		trap: ["12 Zeichen", "alle 90 Tage wechseln", "nur mit zweitem Faktor"],
		trapPattern: "\\d+\\s*Zeichen",
		literal: "die Passwortregel für den Kanal plattform-rufdienst",
		paraphrase: "Passwortregel beim Kanal plattform-rufdienst",
	},
	{
		question: "Welche Fluggesellschaft war für den Besuch der Prüfstelle gebucht?",
		trap: ["Lufthansa", "Swiss International", "Austrian Airlines"],
		literal: "die Fluggesellschaft für den Besuch der Prüfstelle",
		paraphrase: "Fluggesellschaft beim Besuch der Prüfstelle",
	},
];

const DE_CONVERSATION: readonly AskSeed[] = [
	{
		ability: "extraction",
		question: "Von welcher Firma kam das andere Angebot für den Exportbau?",
		gold: ["Hegewald Systemtechnik", "Hegewald"],
		evidence: ["c01"],
		literal: "Das günstigere Angebot kam von der Firma Hegewald Systemtechnik",
		paraphrase: "das günstigere Angebot der anderen Firma",
	},
	{
		ability: "extraction",
		question: "Über welches Postfach läuft die Abzeichnung?",
		gold: ["nachweis-abzeichnung", "das Postfach nachweis-abzeichnung"],
		evidence: ["c02"],
		literal: "über das Postfach nachweis-abzeichnung",
		paraphrase: "Postfach für die Abzeichnung",
	},
	{
		ability: "extraction",
		question: "Wie nennt die Finanzseite die Wiedereröffnung der Prüfjahr-Zeile intern?",
		gold: ["die Turmfalke-Runde", "Turmfalke"],
		evidence: ["c03"],
		literal: "nennt die Wiedereröffnung intern die Turmfalke-Runde",
		paraphrase: "wie die Finanzseite die Wiedereröffnung nennt",
	},
	{
		ability: "extraction",
		question: "Wo liegt das Gerät für den Rufdienst?",
		gold: ["im Büro Weßling", "Büro Weßling", "Weßling"],
		evidence: ["c04"],
		literal: "liegt in der Schublade im Büro Weßling",
		paraphrase: "wo die Schublade mit dem Gerät steht",
	},
	{
		ability: "extraction",
		question: "Wie heißt die einmalige Prüfung, die die Abweichung gefunden hat?",
		gold: ["der Stille-Stunde-Lauf", "Stille-Stunde-Lauf"],
		evidence: ["c05"],
		literal: "mit einer einmaligen Prüfung, die das Abrechnungsteam den Stille-Stunde-Lauf nennt",
		paraphrase: "einmalige Prüfung beim Abrechnungsteam",
	},
	{
		ability: "extraction",
		question: "Welche Aufgabe für daheim fällt aus dem Auswahlverfahren?",
		gold: ["die Nordhavn-Fallstudie", "Nordhavn"],
		evidence: ["c06"],
		literal: "Weg fällt die Aufgabe für daheim, die Nordhavn-Fallstudie",
		paraphrase: "welche Aufgabe für daheim wegfällt",
	},
	{
		ability: "multi-session",
		question: "Mit welchem Skript hat das Team nachgezählt, das die Zugriffsprüfung führt?",
		gold: ["ruhe-scan"],
		evidence: ["c07", "p06a"],
		literal: "Die Nachzählung lief mit dem Skript, das das Risikoteam ruhe-scan nennt",
		paraphrase: "Skript für die Nachzählung",
	},
	{
		ability: "multi-session",
		question: "Womit hat die Betreuung die Größe der ersten Welle des Portals ausgerechnet?",
		gold: ["den Wellenrechner", "Wellenrechner"],
		evidence: ["c08", "u07old"],
		literal: "die Größe auf einer Tabelle ausgerechnet, die sie den Wellenrechner nennt",
		paraphrase: "Tabelle der Betreuung für die Größe",
	},
	{
		ability: "extraction",
		question: "Wie heißt das eigene Formular der Aufsicht?",
		gold: ["RB-1402", "Formular RB-1402"],
		evidence: ["c09"],
		literal: "Das eigene Formular der Aufsicht heißt RB-1402",
		paraphrase: "Formular der Aufsicht für die Meldung",
	},
	{
		ability: "multi-session",
		question: "Wer hat die Nachbetrachtung der gescheiterten Ladung aufgeschrieben?",
		gold: ["Oskar Feldmann", "Feldmann"],
		evidence: ["c10", "u10old"],
		literal: "der diensthabende Kollege Oskar Feldmann",
		paraphrase: "wer die Nachbetrachtung aufgeschrieben hat",
		variant: "der diensthabende Kollege O. Feldmann",
	},
];

const DE_CONFLICTS: readonly ConflictAskSeed[] = [
	{
		shape: "duplicate",
		question: "In welcher Form geht das Nachweispaket an die Prüfstelle?",
		gold: ["als eine signierte Archivdatei", "signierte Archivdatei"],
		evidence: ["x01a"],
		literal: "als eine signierte Archivdatei an die Prüfstelle",
		paraphrase: "Nachweispaket als Archivdatei geliefert",
	},
	{
		shape: "conflict-long",
		question: "Wann verlängert sich der Nordwind-Wartungsvertrag?",
		gold: ["1. Juli 2026", "01.07.2026"],
		trap: ["1. Juni 2026", "01.06.2026"],
		evidence: ["x02b", "x02a"],
		literal: "Nordwind-Wartungsvertrag verlängert sich am 1. Juli 2026",
		paraphrase: "wann der Nordwind Wartungsvertrag verlängert",
	},
	{
		shape: "conflict-short",
		question: "Wann liegt der Prüfbeginn?",
		gold: ["Juni", "im Juni"],
		trap: ["im Mai", "Mai 2026"],
		evidence: ["x03b", "x03a"],
		literal: "Der Prüfbeginn liegt im Juni",
		paraphrase: "Prüfbeginn liegt in welchem Monat",
	},
	{
		shape: "moved-event",
		question: "Wann findet das Sprint-12-Review statt?",
		gold: ["10.06.2026", "10. Juni 2026"],
		trap: ["20.05.2026", "20. Mai 2026"],
		evidence: ["x04b", "x04a"],
		literal: "Sprint-12-Review findet am 10.06.2026 statt",
		paraphrase: "Sprint 12 Review Termin verschoben",
	},
	{
		shape: "decoy",
		question: "Wann findet das Sprint-15-Review statt?",
		gold: ["17. Juli 2026", "17.07.2026"],
		evidence: ["x05b"],
		literal: "Sprint-15-Review findet am 17. Juli 2026 statt",
		paraphrase: "Sprint 15 Review Termin",
	},
];

/**
 * Im Quartalsabschluss gesagt und sonst nirgends. Die Sitzung pflanzt nichts,
 * das der Remember aufschreibt, also lässt der geskriptete Fold sie ganz
 * fallen, und das Transkript ist die einzige Stelle im Raum, die den Ordner
 * beim Namen nennt.
 */
const DE_DROPPED: DroppedSeed = {
	plant: { key: "d01", noted: false, dropped: true, ask: "Und wo landet der Rückblick, wenn er geschrieben ist?", line: "Der Rückblick kommt in den Planungsordner, den die Finanzseite die Schleusen-Akte nennt ({m}), neben die früheren Quartale." },
	ask: {
		ability: "extraction",
		question: "In welchem Ordner der Finanzseite landet der Quartalsrückblick?",
		gold: ["die Schleusen-Akte", "Schleusen-Akte"],
		evidence: ["d01"],
		literal: "Der Rückblick kommt in den Planungsordner, den die Finanzseite die Schleusen-Akte nennt",
		paraphrase: "Planungsordner der Finanzseite für den Rückblick",
	},
};

/**
 * Sechs Dinge, nebenbei gesagt und nie aufgeschrieben, jedes in einer Sitzung,
 * die anderes notiert. Gefragt wird, wie jemand fragt, der den Wortlaut nicht
 * mehr weiß: kein Wort der Frage ist ein Wort des Wortwechsels, außer der
 * Sache, um die es geht. Eigene Tatsachen, keine Übersetzung der englischen.
 */
const DE_NO_HINT: readonly NoHintSeed[] = [
	{
		session: 7,
		entity: "Umstellung",
		plant: { key: "n01", noted: false, noHint: true, ask: "Noch etwas Praktisches: Ist für die Verpflegung gesorgt?", line: "Für die Umstellung ist bei der Bäckerei Hollerbach ein Frühstück bestellt ({m}), geliefert wird am Samstag in aller Frühe." },
		ask: {
			question: "Wer versorgt uns bei der Umstellung mit Essen?",
			gold: ["Bäckerei Hollerbach", "Hollerbach"],
			evidence: ["n01"],
			literal: "bei der Bäckerei Hollerbach ein Frühstück bestellt",
			paraphrase: "bestelltes Frühstück der Bäckerei",
		},
	},
	{
		session: 8,
		entity: "Probelauf",
		plant: { key: "n02", noted: false, noHint: true, ask: "Und wo liegt das Protokoll davon?", line: "Das Protokoll vom Probelauf liegt auf dem Laufwerk der Migration im Ordner Kranich ({m}), falls die Prüfstelle danach fragt." },
		ask: {
			question: "Wo finde ich die Aufzeichnungen zum Probelauf?",
			gold: ["Ordner Kranich", "Kranich"],
			evidence: ["n02"],
			literal: "auf dem Laufwerk der Migration im Ordner Kranich",
			paraphrase: "Ordner mit dem Protokoll vom Lauf",
			variant: "auf dem Laufwerk der Migration im Kranich-Ordner",
		},
	},
	{
		session: 15,
		entity: "Sicherheitsprüfung",
		plant: { key: "n03", noted: false, noHint: true, ask: "Braucht der Gutachter dafür etwas von uns?", line: "Für die Sicherheitsprüfung braucht der Gutachter einen Gastzugang, und den richtet Herr Amrein vom Empfang ein ({m})." },
		ask: {
			question: "An wen wende ich mich, wenn jemand wegen der Sicherheitsprüfung ins System muss?",
			gold: ["Herr Amrein", "Amrein"],
			evidence: ["n03"],
			literal: "den richtet Herr Amrein vom Empfang ein",
			paraphrase: "Gastzugang für den Gutachter einrichten",
			variant: "den richtet Hr. Amrein vom Empfang ein",
		},
	},
	{
		session: 18,
		entity: "Großmann Bau",
		plant: { key: "n04", noted: false, noHint: true, ask: "Wo sitzen die eigentlich?", line: "Großmann Bau sitzt übrigens in Rapperswil, gleich neben dem Hafen ({m}), wir könnten den Start also vor Ort begleiten." },
		ask: {
			question: "Wohin müsste ich fahren, um Großmann Bau zu besuchen?",
			gold: ["Rapperswil"],
			evidence: ["n04"],
			literal: "sitzt übrigens in Rapperswil, gleich neben dem Hafen",
			paraphrase: "Sitz von Großmann neben dem Hafen",
		},
	},
	{
		session: 22,
		entity: "Plattformkosten",
		plant: { key: "n05", noted: false, noHint: true, ask: "Und wo werden die gebucht?", line: "Gebucht werden die Plattformkosten auf den Kostenträger mit dem Namen Leuchtfeuer ({m}), nicht auf die allgemeine IT." },
		ask: {
			question: "Unter welchem Stichwort führt das Rechnungswesen die Plattformkosten?",
			gold: ["Leuchtfeuer"],
			evidence: ["n05"],
			literal: "auf den Kostenträger mit dem Namen Leuchtfeuer",
			paraphrase: "Kostenträger für die Plattformkosten",
		},
	},
	{
		session: 26,
		entity: "gescheiterten Ladung",
		plant: { key: "n06", noted: false, noHint: true, ask: "Hat sich der Lieferant eigentlich gemeldet?", line: "Nach der gescheiterten Ladung hat der Lieferant zur Entschuldigung eine Kiste Weißwein vom Weingut Rebhalde geschickt ({m}), sie steht noch in der Teeküche." },
		ask: {
			question: "Was haben wir wegen der gescheiterten Ladung als Wiedergutmachung bekommen?",
			gold: ["Kiste Weißwein", "Weißwein", "Rebhalde"],
			evidence: ["n06"],
			literal: "eine Kiste Weißwein vom Weingut Rebhalde geschickt",
			paraphrase: "Entschuldigung des Lieferanten mit Weißwein",
		},
	},
];

const DE_FILLER: ReadonlyArray<{ user: string; assistant: string }> = [
	{ user: "Vorher noch — ist der alte Verweis auf die Übersicht inzwischen repariert?", assistant: "Er löst wieder auf. Nichts davon ist es wert, behalten zu werden." },
	{ user: "Die Leitung war die ersten Minuten grässlich.", assistant: "Das war wieder die Büroleitung; nach dem Wechsel war es gut." },
	{ user: "Ich finde die alte Präsentation vom Frühjahr immer noch nicht.", assistant: "Sie liegt im Archiv, aber nichts darin ist aktuell." },
	{ user: "Kurz daneben: im dritten Stock ist der Drucker leer.", assistant: "Notiert, auch wenn das nicht unsere Baustelle ist." },
	{ user: "Hat der Ticketdienst aufgehört, Kommentare zu verdoppeln?", assistant: "Meistens. Einmal pro Woche wiederholt er sich, dann benimmt er sich." },
	{ user: "Ich habe vor dem Gespräch zehn Minuten am Netzzugang verloren.", assistant: "Bei mir auch. Das ist bekannt, und niemand geht ihm nach." },
];

const WORLDS: Record<RecallLanguage, RecallWorld> = {
	en: {
		language: "en",
		letter: "E",
		start: "2026-04-06",
		labels: EN_LABELS,
		filler: EN_FILLER,
		sessions: EN_SESSIONS,
		extraction: EN_EXTRACTION,
		conversation: EN_CONVERSATION,
		multi: EN_MULTI,
		temporal: EN_TEMPORAL,
		update: EN_UPDATE,
		abstention: EN_ABSTENTION,
		conflicts: EN_CONFLICTS,
		dropped: EN_DROPPED,
		noHint: EN_NO_HINT,
	},
	de: {
		language: "de",
		letter: "D",
		start: "2026-04-07",
		labels: DE_LABELS,
		filler: DE_FILLER,
		sessions: DE_SESSIONS,
		extraction: DE_EXTRACTION,
		conversation: DE_CONVERSATION,
		multi: DE_MULTI,
		temporal: DE_TEMPORAL,
		update: DE_UPDATE,
		abstention: DE_ABSTENTION,
		conflicts: DE_CONFLICTS,
		dropped: DE_DROPPED,
		noHint: DE_NO_HINT,
	},
};

// --- Building the fixture ----------------------------------------------------

/** A planted fact with everything the questions and the checks need to find it. */
interface PlacedPlant {
	key: string;
	marker: string;
	/** The directive's short id, e.g. "E07". */
	id: string;
	line: string;
	topic: string;
	sessionId: string;
	sessionIndex: number;
	date: string;
	supersedes?: string;
	updates?: string;
	noted?: boolean;
	kind?: "item";
	shape?: ConflictShape;
	/** The plant of the conversation the fold drops whole; see `PlantSeed.dropped`. */
	dropped?: true;
	/** The plant of a no-hint question; see `NoHintSeed`. */
	noHint?: true;
}

function renderRecentContextEntry(seed: SessionSeed, date: string, placed: PlacedPlant[], byKey: Map<string, PlacedPlant>): string {
	const body: string[] = [];
	for (const plant of placed) {
		// Said, not noted: the conversation keeps it, the entry never sees it.
		if (plant.noted === false) continue;
		if (plant.supersedes) {
			const older = byKey.get(plant.supersedes);
			body.push(directive({ id: plant.id, op: "supersede", target: `@${older?.marker ?? ""}` }));
		} else if (plant.updates) {
			const older = byKey.get(plant.updates);
			body.push(directive({ id: plant.id, op: "update", target: `@${older?.marker ?? ""}` }));
		} else {
			// An item is an open loop and lives in Active Items; the memory refuses
			// one filed under a Deep Memory topic, so the directive names the
			// section the way the fold fixture does.
			body.push(plant.kind === "item" ? directive({ id: plant.id, op: "add", kind: "item", topic: "Active Items" }) : directive({ id: plant.id, op: "add", kind: "fact", topic: plant.topic }));
		}
		body.push(`- ${plant.line}`);
	}
	if (body.length === 0) body.push(`- ${seed.bullet ?? seed.arc}`);
	return [
		`### RC-DRAFT | OPEN | ${date} | ${seed.title}`,
		"",
		`**Session arc:** ${seed.arc}`,
		"",
		"**Body:**",
		...body,
		"",
		"**Parked:**",
		"None",
		"",
	].join("\n");
}

/**
 * How far apart two sittings are, in the spellings a person would use: the day
 * count always, and the week count only for a distance long enough to be told
 * in weeks and close enough to a whole number of them — so nine days is nine
 * days and never "a week".
 */
function distanceGold(days: number, labels: RecallLabels): string[] {
	const out = [`${days} ${labels.days}`];
	const word = labels.words[days];
	if (word) out.push(`${word} ${labels.days}`);
	const weeks = Math.round(days / 7);
	if (days >= 14 && Math.abs(days - weeks * 7) <= 2) {
		out.push(`${weeks} ${labels.weeks}`);
		const weekWord = labels.words[weeks];
		if (weekWord) out.push(`${weekWord} ${labels.weeks}`);
	}
	return [...new Set(out)];
}

function handQueriesOf(world: RecallWorld, literal: string, paraphrase: string, variant: string | undefined): { literal: string; paraphrase: string; variant: string } {
	if (variant) return { literal, paraphrase, variant };
	if (world.language === "de") {
		// A literal that quotes a date is varied by the date's other form; one
		// that quotes words is varied by writing ä/ö/ü/ß as ae/oe/ue/ss.
		const swapped = swapGermanDate(literal);
		if (swapped && swapped !== literal) return { literal, paraphrase, variant: swapped };
		const folded = asciiFold(literal);
		if (folded !== literal) return { literal, paraphrase, variant: folded };
	}
	throw new Error(`the ${world.language} question quoting "${literal}" needs a variant query: the literal carries nothing to respell`);
}

/**
 * The three queries of a question. A question resting on ONE sentence asks
 * with the hand-written queries as they stand. A question resting on SEVERAL —
 * a temporal one, a multi-session one — quotes every one of them: the
 * demotion ranking can leave one of its sentences in the core and put the
 * other in the archive, and a literal that quotes only the first can never
 * reach the second. So each sentence whose wording the hand-written literal
 * does not already carry — nearly all of its words, the way the engine reads
 * carrying — is appended to it, whole and without its reference code, and to
 * the variant respelled the way the language's variant rule respells. That
 * includes the sentence the hand-written literal quotes a fragment of: a query
 * holding one sentence whole and the other as a fragment hands back the whole
 * one's note and the transcript that said it before the fragment's note, so
 * the sentences are quoted alike or the bar is missed on the first. The
 * paraphrase is left alone: it asks in other words by design.
 */
function queriesOf(world: RecallWorld, literal: string, paraphrase: string, variant: string | undefined, evidenceLines: readonly string[] = []): { literal: string; paraphrase: string; variant: string } {
	const hand = handQueriesOf(world, literal, paraphrase, variant);
	if (evidenceLines.length < 2) return hand;
	const appended = evidenceLines.map(plantedWording).filter((wording) => !saysQuoted(literal, wording));
	if (appended.length === 0) return hand;
	return {
		literal: [hand.literal, ...appended].join(" "),
		paraphrase: hand.paraphrase,
		variant: [hand.variant, ...appended.map((wording) => variantWording(world.language, wording))].join(" "),
	};
}

export function buildRecallFixture(opts: RecallFixtureOptions): RecallFixture {
	const world = WORLDS[opts.language];
	if (!world) throw new Error(`unknown recall language "${opts.language}"`);
	const seed = opts.seed ?? RECALL_FIXTURE_DEFAULTS.seed;
	const sessionCount = opts.sessions ?? RECALL_FIXTURE_DEFAULTS.sessions;
	const perAbility = opts.questionsPerAbility ?? RECALL_FIXTURE_DEFAULTS.questionsPerAbility;
	const conversationCount = opts.conversationQuestions ?? perAbility;
	if (sessionCount < 1 || sessionCount > world.sessions.length) {
		throw new Error(`the ${world.language} recall fixture holds ${world.sessions.length} sessions; ${sessionCount} were asked for`);
	}
	if (perAbility < 1) throw new Error(`questionsPerAbility must be at least 1, got ${perAbility}`);
	if (conversationCount < 0) throw new Error(`conversationQuestions cannot be negative, got ${conversationCount}`);
	const rand = mulberry32(seed);

	// Dates: one sitting every 2-6 days, from the world's first day.
	const dates: string[] = [];
	for (let i = 0; i < sessionCount; i++) dates.push(i === 0 ? world.start : addDays(dates[i - 1], 2 + Math.floor(rand() * 5)));

	// Markers, in reading order: the first plant of the first session is 01.
	// The dropped conversation's plant goes into the LAST sitting of this run,
	// and only when that sitting carries no noted plant: the scripted fold drops
	// a sitting it has no directive for, and a noted plant would make it a
	// folded one. Every sitting before the last carries noted plants, so at
	// any smaller size nothing is appended and nothing else moves.
	const lastSeed = world.sessions[sessionCount - 1];
	const dropsLast = lastSeed.plants.every((plant) => plant.noted === false);
	// The no-hint plants are one more exchange at the end of the sitting each
	// names, after everything the sitting already said, at every size that holds
	// that sitting.
	const noHintSeeds = world.noHint.filter((item) => item.session <= sessionCount);
	const seeds: readonly SessionSeed[] = world.sessions.slice(0, sessionCount).map((seed, index) => {
		const appended = [...(index === sessionCount - 1 && dropsLast ? [world.dropped.plant] : []), ...noHintSeeds.filter((item) => item.session === index + 1).map((item) => item.plant)];
		return appended.length === 0 ? seed : { ...seed, plants: [...seed.plants, ...appended] };
	});
	const byKey = new Map<string, PlacedPlant>();
	const placedPerSession: PlacedPlant[][] = [];
	// Numbered in reading order, the noted facts first, the ones that stay in
	// the conversation after them, the members of the planted pairs after
	// those, and the dropped conversation's plant last, so a marker says at a
	// glance whether the room could have written it down and every marker of
	// the original fixture keeps its number.
	let markerNumber = 0;
	const allPlants = seeds.flatMap((seed) => seed.plants);
	const noted = allPlants.filter((plant) => plant.noted !== false && !plant.shape).length;
	let unnotedNumber = noted;
	let shapeNumber = noted + allPlants.filter((plant) => plant.noted === false && !plant.dropped && !plant.noHint).length;
	let droppedNumber = shapeNumber + allPlants.filter((plant) => plant.shape).length;
	// The no-hint plants come after every class that was there before them, the
	// dropped conversation's included, so no earlier marker changes its number.
	let noHintNumber = droppedNumber + allPlants.filter((plant) => plant.dropped).length;
	for (let i = 0; i < seeds.length; i++) {
		const placed: PlacedPlant[] = [];
		for (const plant of seeds[i].plants) {
			const number = plant.noHint ? (noHintNumber += 1) : plant.dropped ? (droppedNumber += 1) : plant.shape ? (shapeNumber += 1) : plant.noted === false ? (unnotedNumber += 1) : (markerNumber += 1);
			const id = `${world.letter}${pad2(number)}`;
			const marker = `REC-${id}`;
			const entry: PlacedPlant = {
				key: plant.key,
				marker,
				id,
				line: plant.line.replace("{m}", marker),
				topic: plant.topic ?? seeds[i].topic,
				sessionId: `S${pad2(i + 1)}`,
				sessionIndex: i,
				date: dates[i],
				...(plant.supersedes ? { supersedes: plant.supersedes } : {}),
				...(plant.updates ? { updates: plant.updates } : {}),
				...(plant.noted === false ? { noted: false } : {}),
				...(plant.shape ? { shape: plant.shape } : {}),
				...(plant.dropped ? { dropped: true as const } : {}),
				...(plant.noHint ? { noHint: true as const } : {}),
			};
			placed.push(entry);
			if (byKey.has(plant.key)) throw new Error(`the ${world.language} world plants the key "${plant.key}" twice`);
			byKey.set(plant.key, entry);
		}
		placedPerSession.push(placed);
	}

	// The open items: per language, the two lowest-numbered extraction questions
	// whose plant is a plain add — nothing later replaces or rewrites it, and it
	// replaces nothing itself — are planted as open items rather than facts. It
	// is decided here, before the RC entries are rendered, from the same pick the
	// extraction questions are made from below, so the choice is fixed by the
	// fixture and the same at every size that holds those questions.
	const replacedKeys = new Set([...byKey.values()].flatMap((plant) => [plant.supersedes, plant.updates]).filter((key): key is string => Boolean(key)));
	const openItemKeys = new Set<string>();
	let openItemQuestions = 0;
	for (const ask of world.extraction.filter((item) => item.evidence.every((key) => byKey.has(key))).slice(0, perAbility)) {
		if (openItemQuestions >= OPEN_ITEM_QUESTIONS_PER_LANGUAGE) break;
		const plain = ask.evidence.every((key) => {
			const plant = byKey.get(key)!;
			return plant.noted !== false && !plant.supersedes && !plant.updates && !replacedKeys.has(key);
		});
		if (!plain) continue;
		openItemQuestions += 1;
		for (const key of ask.evidence) {
			byKey.get(key)!.kind = "item";
			openItemKeys.add(key);
		}
	}

	// Small talk: one pool, drawn once, rotated so no two sittings open the same way.
	const fillerPool = shuffled(world.filler, rand);
	let fillerAt = 0;
	const nextFiller = () => fillerPool[fillerAt++ % fillerPool.length];

	const sessions: RecallSession[] = seeds.map((spec, i) => {
		const placed = placedPerSession[i];
		const turns: RecallTurn[] = [
			{ role: "user", text: spec.opening },
			{ role: "assistant", text: spec.openingReply },
		];
		// The small talk follows the sitting as it was: a no-hint exchange added
		// at the end does not change how many asides the sitting draws.
		const asides = placed.filter((plant) => !plant.noHint).length >= 2 ? [nextFiller()] : [nextFiller(), nextFiller()];
		const first = asides.shift();
		if (first) turns.push({ role: "user", text: first.user }, { role: "assistant", text: first.assistant });
		for (let p = 0; p < placed.length; p++) {
			turns.push({ role: "user", text: spec.plants[p].ask }, { role: "assistant", text: placed[p].line });
		}
		const second = asides.shift();
		if (second) turns.push({ role: "user", text: second.user }, { role: "assistant", text: second.assistant });
		turns.push({ role: "user", text: spec.closing }, { role: "assistant", text: spec.closingReply });
		return {
			id: `S${pad2(i + 1)}`,
			date: dates[i],
			title: spec.title,
			turns,
			recentContextEntry: renderRecentContextEntry(spec, dates[i], placed, byKey),
			plants: placed.map((plant) => ({
				marker: plant.marker,
				line: plant.line,
				topic: plant.topic,
				...(plant.supersedes ? { supersedes: byKey.get(plant.supersedes)?.marker ?? "" } : {}),
				...(plant.updates ? { updates: byKey.get(plant.updates)?.marker ?? "" } : {}),
				...(plant.noted === false ? { noted: false } : {}),
				...(plant.kind === "item" ? { kind: "item" as const } : {}),
				...(plant.shape ? { shape: plant.shape } : {}),
				...(plant.noHint ? { noHint: true as const } : {}),
			})),
		};
	});

	const askDate = addDays(dates[dates.length - 1], 3 + Math.floor(rand() * 5));
	const known = (keys: readonly string[]) => keys.every((key) => byKey.has(key));
	const evidenceOf = (keys: readonly string[]) => keys.map((key) => {
		const plant = byKey.get(key)!;
		return { sessionId: plant.sessionId, marker: plant.marker };
	});
	/** The planted sentences behind the same keys, for the queries to quote. */
	const linesOf = (keys: readonly string[]) => keys.map((key) => byKey.get(key)!.line);

	const questions: RecallQuestion[] = [];
	/** The ids of the temporal questions that ask which of two things came first. */
	const orderQuestions = new Set<string>();
	/** The ids of the questions whose answer the room only ever heard. */
	const saidNotNoted = new Set<string>();
	const nextId = () => `Q-${world.language}-${pad2(questions.length + 1)}`;
	const take = <T,>(items: readonly T[], eligible: (item: T) => boolean, what: string, count = perAbility): T[] => {
		const found = items.filter(eligible).slice(0, count);
		if (found.length < count) {
			throw new Error(`the ${world.language} fixture has ${found.length} ${what} questions inside ${sessionCount} sessions; ${count} were asked for`);
		}
		return found;
	};

	for (const ask of take(world.extraction, (item) => known(item.evidence), "extraction")) {
		questions.push({
			id: nextId(),
			ability: "extraction",
			language: world.language,
			question: ask.question,
			gold: [...ask.gold],
			evidence: evidenceOf(ask.evidence),
			queries: queriesOf(world, ask.literal, ask.paraphrase, ask.variant, linesOf(ask.evidence)),
			askDate,
			...(ask.evidence.every((key) => openItemKeys.has(key)) ? { openItem: true as const } : {}),
		});
	}

	for (const ask of take(world.multi, (item) => known(item.evidence), "multi-session")) {
		questions.push({
			id: nextId(),
			ability: "multi-session",
			language: world.language,
			question: ask.question,
			gold: [...ask.gold],
			evidence: evidenceOf(ask.evidence),
			queries: queriesOf(world, ask.literal, ask.paraphrase, ask.variant, linesOf(ask.evidence)),
			askDate,
		});
	}

	for (const ask of take(world.temporal, (item) => known([item.a, item.b]), "temporal")) {
		const a = byKey.get(ask.a)!;
		const b = byKey.get(ask.b)!;
		const earlier = a.sessionIndex <= b.sessionIndex ? "a" : "b";
		const gold = ask.form === "distance"
			? distanceGold(daysBetween(a.date, b.date), world.labels)
			: [...((earlier === "a" ? ask.goldA : ask.goldB) ?? [])];
		// The option the question offers and the dates rule out: an answer that
		// names it as well as the gold has not chosen between them.
		const distractor = ask.form === "order" ? [...((earlier === "a" ? ask.goldB : ask.goldA) ?? [])] : [];
		const id = nextId();
		if (ask.form === "order") orderQuestions.add(id);
		questions.push({
			id,
			ability: "temporal",
			language: world.language,
			question: ask.question,
			gold,
			...(distractor.length > 0 ? { distractor } : {}),
			evidence: evidenceOf([ask.a, ask.b]),
			queries: queriesOf(world, ask.literal, ask.paraphrase, ask.variant, linesOf([ask.a, ask.b])),
			askDate,
		});
	}

	for (const ask of take(world.update, (item) => known(item.evidence), "knowledge-update")) {
		questions.push({
			id: nextId(),
			ability: "knowledge-update",
			language: world.language,
			question: ask.question,
			gold: [...ask.gold],
			trap: [...(ask.trap ?? [])],
			// The newer sentence is the evidence; the older one is where the
			// value the answer must not give still stands, in core or in the
			// archive the fold put it in.
			evidence: evidenceOf(ask.evidence.slice(0, 1)),
			trapEvidence: evidenceOf(ask.evidence.slice(1)),
			queries: queriesOf(world, ask.literal, ask.paraphrase, ask.variant, linesOf(ask.evidence.slice(0, 1))),
			askDate,
		});
	}

	for (const ask of take(world.abstention, () => true, "abstention")) {
		questions.push({
			id: nextId(),
			ability: "abstention",
			language: world.language,
			question: ask.question,
			gold: [],
			trap: [...ask.trap],
			...(ask.trapPattern ? { trapPattern: ask.trapPattern } : {}),
			evidence: [],
			queries: queriesOf(world, ask.literal, ask.paraphrase, ask.variant),
			askDate,
		});
	}

	for (const ask of take(world.conversation, (item) => known(item.evidence), "said-not-noted", conversationCount)) {
		const id = nextId();
		saidNotNoted.add(id);
		questions.push({
			id,
			ability: ask.ability ?? "extraction",
			language: world.language,
			question: ask.question,
			gold: [...ask.gold],
			evidence: evidenceOf(ask.evidence),
			queries: queriesOf(world, ask.literal, ask.paraphrase, ask.variant, linesOf(ask.evidence)),
			askDate,
		});
	}

	// The planted pairs: one question per shape, taken whole rather than per
	// ability, and only when the fixture holds BOTH members of the pair. A
	// conflict shape is a knowledge-update question on its newer member; the
	// duplicate is an extraction question on its first member and the decoy
	// one on its second. They carry a `shape`, and the ability tables leave
	// them out: what they measure is what the memory made of the pair.
	const shapeMembers = (shape: ConflictShape) => [...byKey.values()].filter((plant) => plant.shape === shape);
	for (const ask of world.conflicts) {
		if (shapeMembers(ask.shape).length !== 2 || !known(ask.evidence)) continue;
		const update = ask.shape === "conflict-long" || ask.shape === "conflict-short" || ask.shape === "moved-event";
		questions.push({
			id: nextId(),
			ability: update ? "knowledge-update" : "extraction",
			language: world.language,
			question: ask.question,
			gold: [...ask.gold],
			...(update ? { trap: [...(ask.trap ?? [])] } : {}),
			evidence: evidenceOf(update ? ask.evidence.slice(0, 1) : ask.evidence),
			...(update ? { trapEvidence: evidenceOf(ask.evidence.slice(1)) } : {}),
			queries: queriesOf(world, ask.literal, ask.paraphrase, ask.variant, linesOf(update ? ask.evidence.slice(0, 1) : ask.evidence)),
			askDate,
			shape: ask.shape,
		});
	}

	// The dropped conversation's question, last of all so every earlier id
	// stands: an extraction question in the said-not-noted style, answered by
	// the one sentence the room heard in a sitting it took no notes from.
	if (dropsLast) {
		const ask = world.dropped.ask;
		const id = nextId();
		saidNotNoted.add(id);
		questions.push({
			id,
			ability: ask.ability ?? "extraction",
			language: world.language,
			question: ask.question,
			gold: [...ask.gold],
			evidence: evidenceOf(ask.evidence),
			queries: queriesOf(world, ask.literal, ask.paraphrase, ask.variant, linesOf(ask.evidence)),
			askDate,
		});
	}

	// The questions without a hint, after every other id: taken whole, never per
	// ability, at every size that holds the sitting the plant was said in. They
	// are checked as questions about the transcript like the said-not-noted ones.
	for (const item of noHintSeeds) {
		const ask = item.ask;
		const id = nextId();
		saidNotNoted.add(id);
		questions.push({
			id,
			ability: "extraction",
			language: world.language,
			question: ask.question,
			gold: [...ask.gold],
			evidence: evidenceOf(ask.evidence),
			queries: queriesOf(world, ask.literal, ask.paraphrase, ask.variant, linesOf(ask.evidence)),
			askDate,
			noHint: true,
			entity: item.entity,
		});
	}

	const fixture: RecallFixture = { language: world.language, seed, sessions, questions };
	checkFixture(fixture, byKey, orderQuestions, saidNotNoted);
	return fixture;
}

// --- The self-checks ---------------------------------------------------------

function fail(what: string): never {
	throw new Error(`recall fixture: ${what}`);
}

/**
 * The guarantees the bench is allowed to rely on. Every one of them is a thing
 * a hand-written question set gets wrong sooner or later: a marker used twice,
 * a literal query that quotes a sentence nobody planted, a gold answer that is
 * still the old value, an ask date inside the corpus.
 */
/**
 * The hand-written part of a question's literal and variant: what is left once
 * the sentences appended for a question resting on several are taken out
 * again. A question resting on one sentence has nothing appended.
 */
export function handWrittenQueries(fixture: RecallFixture, question: RecallQuestion): { literal: string; variant: string } {
	let literal = question.queries.literal;
	let variant = question.queries.variant;
	if (question.evidence.length < 2) return { literal, variant };
	for (const entry of question.evidence) {
		const line = fixture.sessions.find((session) => session.id === entry.sessionId)?.plants.find((plant) => plant.marker === entry.marker)?.line;
		if (line === undefined) continue;
		const wording = plantedWording(line);
		literal = literal.replace(` ${wording}`, "");
		variant = variant.replace(` ${variantWording(fixture.language, wording)}`, "");
	}
	return { literal, variant };
}

function checkFixture(fixture: RecallFixture, byKey: Map<string, PlacedPlant>, orderQuestions: ReadonlySet<string>, saidNotNoted: ReadonlySet<string>): void {
	const plants = fixture.sessions.flatMap((session) => session.plants.map((plant) => ({ session, plant })));
	const lineOf = new Map<string, string>();
	for (const { session, plant } of plants) {
		if (lineOf.has(plant.marker)) fail(`the marker ${plant.marker} is planted twice`);
		lineOf.set(plant.marker, plant.line);
		if (!plant.line.includes(plant.marker)) fail(`the sentence of ${plant.marker} does not carry its marker`);
		if (plant.noted === false) {
			if (session.recentContextEntry.includes(plant.marker)) fail(`${plant.marker} was never noted, yet the RC entry of ${session.id} carries it`);
		} else if (!session.recentContextEntry.includes(plant.marker)) {
			fail(`the RC entry of ${session.id} does not carry ${plant.marker}`);
		}
	}

	// A marker belongs to exactly one sentence in exactly one conversation.
	const spoken = fixture.sessions.map((session) => session.turns.map((turn) => turn.text).join("\n"));
	for (const marker of lineOf.keys()) {
		const count = spoken.reduce((sum, text) => sum + text.split(marker).length - 1, 0);
		if (count !== 1) fail(`the marker ${marker} appears ${count} times across the conversations, not once`);
	}

	// Dates: strictly increasing, one sitting every 2-6 days.
	for (let i = 1; i < fixture.sessions.length; i++) {
		const gap = daysBetween(fixture.sessions[i - 1].date, fixture.sessions[i].date);
		if (Date.parse(fixture.sessions[i].date) <= Date.parse(fixture.sessions[i - 1].date)) fail(`${fixture.sessions[i].id} is not after ${fixture.sessions[i - 1].id}`);
		if (gap < 2 || gap > 6) fail(`${fixture.sessions[i - 1].id} to ${fixture.sessions[i].id} is ${gap} days, outside the 2-6 day rhythm`);
	}

	// Sessions: a real conversation shape, and an RC entry that survives stripping.
	for (const session of fixture.sessions) {
		// A no-hint exchange is two turns on top of the sitting as it was.
		const mostTurns = 12 + 2 * session.plants.filter((plant) => plant.noHint).length;
		if (session.turns.length < 6 || session.turns.length > mostTurns) fail(`${session.id} holds ${session.turns.length} turns, outside 6-${mostTurns}`);
		session.turns.forEach((turn, index) => {
			const expected = index % 2 === 0 ? "user" : "assistant";
			if (turn.role !== expected) fail(`${session.id} turn ${index + 1} is a ${turn.role} turn where a ${expected} turn belongs`);
			if (!turn.text.trim()) fail(`${session.id} turn ${index + 1} is empty`);
		});
		if (!session.recentContextEntry.startsWith(`### RC-DRAFT | OPEN | ${session.date} | ${session.title}`)) fail(`the RC entry of ${session.id} does not open in the remembered-session shape`);
		const plain = stripRecallDirectives(session.recentContextEntry);
		if (plain.includes("<!-- plant")) fail(`the RC entry of ${session.id} keeps a directive after stripping`);
		for (const part of ["**Session arc:**", "**Body:**", "**Parked:**"]) {
			if (!plain.includes(part)) fail(`the stripped RC entry of ${session.id} lost its ${part} line`);
		}
		if (!/\n- \S/.test(plain)) fail(`the stripped RC entry of ${session.id} carries no body bullet`);
		for (const plant of session.plants) {
			if (plant.supersedes && plant.updates) fail(`${plant.marker} claims to supersede and to update at once`);
		}
	}

	const allText = fixture.sessions.map((session) => `${session.turns.map((turn) => turn.text).join("\n")}\n${session.recentContextEntry}`).join("\n").toLowerCase();
	/** Everything the room actually said, read the way a scorer reads it. */
	const roomSaid = asciiFold(`${allText}\n${fixture.questions.flatMap((question) => question.gold).join("\n")}`.toLowerCase());
	/** Every word the notes hold, which is where a transcript-only answer must not be. */
	const notedWords = contentWords(fixture.sessions.map((session) => session.recentContextEntry).join("\n"));
	/** The words of each planted sentence, by marker. */
	const plantWords = new Map(plants.map(({ plant }) => [plant.marker, contentWords(plant.line)] as const));
	/** The words each question itself puts in front of the model. */
	const questionWords = fixture.questions.map((question) => contentWords(`${question.question}\n${question.gold.join("\n")}\n${(question.trap ?? []).join("\n")}\n${question.queries.literal}\n${question.queries.paraphrase}\n${question.queries.variant}`));
	/** What each question says, so an invented specific can be kept out of all the others. */
	const asked = fixture.questions.map((question) => asciiFold(`${question.question}\n${question.queries.literal}\n${question.queries.paraphrase}\n${question.queries.variant}`.toLowerCase()));
	const ids = new Set<string>();
	const lastDate = fixture.sessions[fixture.sessions.length - 1].date;

	for (const question of fixture.questions) {
		if (ids.has(question.id)) fail(`the question id ${question.id} is used twice`);
		ids.add(question.id);
		if (question.language !== fixture.language) fail(`${question.id} carries the wrong language`);
		if (Date.parse(question.askDate) <= Date.parse(lastDate)) fail(`${question.id} is asked on ${question.askDate}, which is not after the last session (${lastDate})`);
		if (question.ability === "abstention") {
			if (question.gold.length > 0) fail(`${question.id} is an abstention question with gold answers`);
			if (question.evidence.length > 0) fail(`${question.id} is an abstention question with evidence`);
			// An invented specific is only invented if the room never said it,
			// and no other question puts it in the model's mouth either.
			const self = fixture.questions.indexOf(question);
			for (const invented of question.trap ?? []) {
				const needle = asciiFold(invented.toLowerCase());
				if (roomSaid.includes(needle)) fail(`the invented specific "${invented}" of ${question.id} is something the room was told; a trap is a fact the fixture never plants`);
				const other = asked.findIndex((text, index) => index !== self && text.includes(needle));
				if (other > -1) fail(`the invented specific "${invented}" of ${question.id} is written into ${fixture.questions[other].id}, which would put it in the answer`);
			}
		} else {
			if (question.gold.length === 0) fail(`${question.id} has no gold answer`);
			if (question.evidence.length === 0) fail(`${question.id} names no evidence`);
		}
		if (question.ability === "multi-session" && question.evidence.length < 2) fail(`${question.id} is a multi-session question with one piece of evidence`);
		if (question.ability === "multi-session" && new Set(question.evidence.map((e) => e.sessionId)).size < 2) fail(`${question.id} takes both halves from one session`);
		if (question.ability === "knowledge-update" && (!question.trap || question.trap.length === 0)) fail(`${question.id} is a knowledge-update question without its old value`);
		if (question.ability === "abstention" && (question.trap ?? []).length < 3) fail(`${question.id} is an abstention question with ${(question.trap ?? []).length} invented specifics; it needs at least 3`);
		if (question.ability !== "knowledge-update" && question.ability !== "abstention" && (question.trap ?? []).length > 0) {
			fail(`${question.id} carries a trap, which only a knowledge-update or an abstention question has`);
		}
		if (question.trapPattern !== undefined) {
			if (question.ability !== "abstention") fail(`${question.id} carries a trap pattern, which only an abstention question has`);
			let pattern: RegExp;
			try {
				pattern = new RegExp(question.trapPattern);
			} catch {
				fail(`the trap pattern of ${question.id} is not a regular expression: ${question.trapPattern}`);
			}
			if (pattern.test(question.question)) fail(`the trap pattern of ${question.id} matches the question itself, so asking it would read as inventing an answer`);
		}
		// The old value lives where it was said, not in the evidence: a
		// knowledge-update question is answered from the newer sentence alone.
		if (question.ability === "knowledge-update") {
			if (question.evidence.length !== 1) fail(`${question.id} names ${question.evidence.length} pieces of evidence; a knowledge-update question is answered from the newer sentence alone`);
			if ((question.trapEvidence ?? []).length !== 1) fail(`${question.id} names ${(question.trapEvidence ?? []).length} places for the old value; it has exactly one`);
			const older = (question.trapEvidence ?? [])[0];
			if (older) {
				const session = fixture.sessions.find((candidate) => candidate.id === older.sessionId);
				if (!session || !session.plants.some((plant) => plant.marker === older.marker)) {
					fail(`${question.id} says the old value stands at ${older.marker} in ${older.sessionId}, which plants nothing of the kind`);
				}
				const newer = fixture.sessions.find((candidate) => candidate.id === question.evidence[0].sessionId)!.plants.find((plant) => plant.marker === question.evidence[0].marker)!;
				if (newer.supersedes !== older.marker && newer.updates !== older.marker) {
					fail(`${question.id} names ${older.marker} as the old value, but ${newer.marker} replaces something else`);
				}
			}
		} else if ((question.trapEvidence ?? []).length > 0) {
			fail(`${question.id} names a place for an old value, which only a knowledge-update question has`);
		}
		if (orderQuestions.has(question.id)) {
			if (!question.distractor || question.distractor.length === 0) fail(`${question.id} asks which of two things came first without naming the other one`);
			for (const other of question.distractor ?? []) {
				for (const right of question.gold) {
					if (other.toLowerCase() === right.toLowerCase()) fail(`${question.id} names "${other}" as the right answer and as the other option`);
					if (other.toLowerCase().includes(right.toLowerCase()) || right.toLowerCase().includes(other.toLowerCase())) {
						fail(`${question.id} has the option "${other}" inside the answer "${right}", so naming one names the other`);
					}
				}
			}
		} else if (question.distractor && question.distractor.length > 0) {
			fail(`${question.id} names another option, which only a question about the order of two things has`);
		}
		for (const trap of question.trap ?? []) {
			if (question.gold.some((gold) => gold.toLowerCase() === trap.toLowerCase())) fail(`${question.id} accepts ${trap} as gold and as trap`);
		}
		for (const evidence of question.evidence) {
			const session = fixture.sessions.find((candidate) => candidate.id === evidence.sessionId);
			if (!session) fail(`${question.id} names the session ${evidence.sessionId}, which the fixture does not hold`);
			if (!session.plants.some((plant) => plant.marker === evidence.marker)) fail(`${question.id} names ${evidence.marker} in ${evidence.sessionId}, which plants nothing of the kind`);
		}
		const first = question.evidence[0];
		// The paraphrase asks in different words, but not in different subjects:
		// a lexical retriever has to be able to reach the evidence with it, or
		// the question is a riddle and the number can never move.
		const anchorText = first
			? fixture.sessions.find((session) => session.id === first.sessionId)!.plants.find((plant) => plant.marker === first.marker)!.line
			: question.queries.literal;
		const anchorName = first ? `the sentence of ${first.marker}` : "its literal query";
		const anchorWords = contentWords(anchorText);
		const shared = [...contentWords(question.queries.paraphrase)].filter((word) => anchorWords.has(word));
		if (shared.length < 2) {
			fail(`the paraphrase query of ${question.id} shares ${shared.length === 0 ? "no content word" : `only "${shared[0]}"`} with ${anchorName}; a paraphrase a word search can never reach is a riddle, not a paraphrase`);
		}
		const words = question.queries.paraphrase.trim().split(/\s+/).length;
		if (words < 3 || words > 8) fail(`the paraphrase query of ${question.id} is ${words} words long; it reads as a search, which is 3 to 8`);
		if (first) {
			const line = anchorText;
			const evidenceLines = question.evidence.map((entry) => fixture.sessions.find((session) => session.id === entry.sessionId)!.plants.find((plant) => plant.marker === entry.marker)!.line);
			if (evidenceLines.length < 2) {
				if (!line.toLowerCase().includes(question.queries.literal.toLowerCase())) {
					fail(`the literal query of ${question.id} does not occur in the sentence of ${first.marker}`);
				}
			} else {
				// A question resting on several sentences quotes every one of them:
				// the hand-written part sits inside the first, and each sentence whose
				// wording that part does not carry is appended whole, so every one is
				// either in the literal verbatim or carried by the hand-written part.
				const wordings = evidenceLines.map(plantedWording);
				const hand = handWrittenQueries(fixture, question).literal;
				if (hand.trim() === "" || !line.toLowerCase().includes(hand.toLowerCase())) {
					fail(`the literal query of ${question.id} does not begin inside the sentence of ${first.marker}`);
				}
				for (let at = 0; at < wordings.length; at++) {
					if (!question.queries.literal.includes(wordings[at]) && !saysQuoted(hand, wordings[at])) {
						fail(`the literal query of ${question.id} does not quote the sentence of ${question.evidence[at].marker}`);
					}
				}
			}
			if (question.ability === "knowledge-update") {
				for (const trap of question.trap ?? []) {
					if (line.toLowerCase().includes(trap.toLowerCase())) fail(`the newer sentence of ${first.marker} repeats the old value ${trap}`);
				}
			}
		}
		if (allText.includes(question.queries.paraphrase.toLowerCase())) fail(`the paraphrase query of ${question.id} occurs verbatim in the corpus`);
		// Said and never noted: the answer has to be reachable in the conversation
		// and nowhere else, or the question is not about the transcript at all.
		const unnoted = question.evidence.filter((entry) => !notedIn(fixture, entry));
		if (unnoted.length > 1) fail(`${question.id} rests on ${unnoted.length} facts the room never wrote down; one is the question`);
		if (saidNotNoted.has(question.id) && unnoted.length === 0) {
			fail(`${question.id} is asked about a fact the room only heard, but every sentence it rests on was written down too`);
		}
		if (unnoted.length === 1) {
			const entry = unnoted[0];
			const session = fixture.sessions.find((candidate) => candidate.id === entry.sessionId)!;
			const turns = session.turns.map((turn) => turn.text).join("\n");
			for (const other of fixture.sessions) {
				if (other.recentContextEntry.includes(entry.marker)) fail(`${question.id} rests on ${entry.marker}, which the RC entry of ${other.id} carries after all`);
			}
			if (!question.gold.some((value) => asciiFold(turns.toLowerCase()).includes(asciiFold(value.toLowerCase())))) {
				fail(`${question.id} is answered from ${entry.marker}, but no gold answer is said anywhere in ${entry.sessionId}`);
			}
			const heardWords = contentWords(turns);
			const elsewhere = (word: string) => notedWords.has(word)
				|| [...plantWords].some(([marker, said]) => marker !== entry.marker && said.has(word))
				|| questionWords.some((said, index) => index !== fixture.questions.indexOf(question) && said.has(word));
			const own = new Set(question.gold.flatMap((value) => [...contentWords(value)]));
			const only = [...own].filter((word) => heardWords.has(word) && !elsewhere(word));
			if (only.length === 0) {
				fail(`the answer to ${question.id} carries no word that is said only in ${entry.sessionId}; a question about the transcript must be answerable from nowhere else`);
			}
		}
		if (question.queries.variant === question.queries.literal) fail(`the variant query of ${question.id} is its literal query`);
		// A variant respells the literal: a different form of the same number,
		// date or word. One that merely adds words to it is the literal again.
		if (question.queries.variant.toLowerCase().includes(question.queries.literal.toLowerCase())) {
			fail(`the variant query of ${question.id} contains its literal query word for word; a variant respells the literal, it does not add to it`);
		}
		if (allText.includes(question.queries.variant.toLowerCase())) fail(`the variant query of ${question.id} occurs verbatim in the corpus`);
		const variantShared = [...contentWords(question.queries.variant)].filter((word) => anchorWords.has(word));
		if (variantShared.length < 2) {
			fail(`the variant query of ${question.id} shares ${variantShared.length === 0 ? "no content word" : `only "${variantShared[0]}"`} with ${anchorName}; a respelling keeps the words it respells`);
		}
		if (fixture.language === "de") {
			// A German date is written two ways; a question about a dated fact
			// asks in the form its sentence did not use, and both must mean the
			// same day or the variant is a different question.
			// Read off the hand-written part: a sentence appended for a question
			// resting on several carries its own date, respelled on the variant.
			const handWritten = handWrittenQueries(fixture, question);
			const asked = germanDate(handWritten.literal);
			if (asked) {
				const varied = germanDate(handWritten.variant);
				if (!varied) fail(`the variant query of ${question.id} drops the date its literal carries`);
				if (varied.iso !== asked.iso) fail(`the variant query of ${question.id} asks for ${varied.iso} where its literal asks for ${asked.iso}`);
				if (varied.form === asked.form) fail(`the variant query of ${question.id} writes the date the same way as its literal; the variant of a dated fact is the other form`);
			}
			for (const value of question.gold) {
				const dated = germanDate(value);
				if (!dated) continue;
				if (!question.gold.some((other) => { const seen = germanDate(other); return seen !== undefined && seen.iso === dated.iso && seen.form !== dated.form; })) {
					fail(`the gold of ${question.id} writes ${dated.iso} only as a ${dated.form} date; a dated answer is accepted in both forms`);
				}
			}
		}
		if (!question.queries.literal.trim() || !question.queries.paraphrase.trim() || !question.queries.variant.trim()) fail(`${question.id} leaves a query empty`);
	}

	// Both replacement paths are exercised once there are enough of them to ask
	// for. The planted pairs' questions all supersede and are not counted: they
	// are asked whole, not per ability.
	const updates = fixture.questions.filter((question) => question.ability === "knowledge-update" && !question.shape);
	if (updates.length >= 3) {
		const newer = updates.map((question) => {
			const first = question.evidence[0];
			return fixture.sessions.find((session) => session.id === first.sessionId)!.plants.find((plant) => plant.marker === first.marker)!;
		});
		if (!newer.some((plant) => plant.supersedes)) fail("no knowledge-update question replaces its older entry by supersede");
		if (!newer.some((plant) => plant.updates)) fail("no knowledge-update question rewrites its older entry in place");
	}

	// The German corpus writes German: the sharp s inside words the questions
	// quote, capital umlauts, and dates in both of the forms a room uses. Only a
	// full-size fixture carries the whole spread; a short one is a slice of it.
	if (fixture.language === "de" && fixture.sessions.length === WORLDS.de.sessions.length) {
		const asked = fixture.questions.flatMap((question) => [question.queries.literal, ...question.gold]).join("\n").toLowerCase();
		const sharp = plants.filter(({ plant }) => (plant.line.match(/[A-Za-zÄÖÜäöü]*ß[A-Za-zÄÖÜäöü]*/g) ?? []).some((word) => asked.includes(word.toLowerCase())));
		if (sharp.length < 6) fail(`only ${sharp.length} German sentences carry a sharp s in a word a question quotes; the fixture promises at least 6`);
		const capitals = plants.filter(({ plant }) => /[ÄÖÜ]/.test(plant.line));
		if (capitals.length < 4) fail(`only ${capitals.length} German sentences carry a capitalised umlaut; the fixture promises at least 4`);
		const forms = new Set(plants.map(({ plant }) => germanDate(plant.line)?.form).filter(Boolean));
		if (forms.size < 2) fail(`the German sentences write their dates in ${forms.size} form; the fixture promises both`);
	}

	// Every plant the world places is reachable by key, which is what the questions use.
	for (const { plant } of plants) {
		if (![...byKey.values()].some((placed) => placed.marker === plant.marker)) fail(`${plant.marker} is not in the fixture's own index`);
	}

	// The planted pairs. A shape the fixture holds whole is two plants in two
	// different sittings, the newer one later; a conflict shape's newer member
	// supersedes its older one and nothing else does; the duplicate's two
	// sentences are one sentence apart from their reference codes; the decoy's
	// two members are plain adds. Each whole shape is asked about exactly once,
	// and a shape the fixture holds only half of is not asked about at all.
	for (const shape of CONFLICT_SHAPES) {
		const members = plants.filter(({ plant }) => plant.shape === shape);
		const asked = fixture.questions.filter((question) => question.shape === shape);
		if (members.length > 2) fail(`the fixture plants ${members.length} members of the ${shape} pair; a pair is two`);
		if (members.length < 2) {
			if (asked.length > 0) fail(`${asked[0].id} asks about the ${shape} pair, of which the fixture holds ${members.length} member(s)`);
			continue;
		}
		if (asked.length !== 1) fail(`the fixture asks ${asked.length} questions about the ${shape} pair; it asks exactly one`);
		const [older, newer] = members;
		if (older.session.id === newer.session.id) fail(`both members of the ${shape} pair are planted in ${older.session.id}; they belong in two different sittings`);
		if (Date.parse(newer.session.date) <= Date.parse(older.session.date)) fail(`the newer member of the ${shape} pair (${newer.plant.marker}) is not in a later sitting than the older (${older.plant.marker})`);
		if (older.plant.supersedes || older.plant.updates) fail(`the older member of the ${shape} pair, ${older.plant.marker}, replaces something; the older member is a plain add`);
		const conflict = shape === "conflict-long" || shape === "conflict-short" || shape === "moved-event";
		if (conflict) {
			if (newer.plant.supersedes !== older.plant.marker) fail(`the newer member of the ${shape} pair, ${newer.plant.marker}, supersedes ${newer.plant.supersedes ?? "nothing"}; it supersedes ${older.plant.marker}`);
			if (asked[0].ability !== "knowledge-update") fail(`${asked[0].id} asks about the ${shape} pair as ${asked[0].ability}; a conflict is a knowledge-update question`);
			if (asked[0].evidence[0]?.marker !== newer.plant.marker) fail(`${asked[0].id} rests on ${asked[0].evidence[0]?.marker ?? "nothing"}; the ${shape} question rests on the newer member ${newer.plant.marker}`);
		} else {
			if (newer.plant.supersedes || newer.plant.updates) fail(`the newer member of the ${shape} pair, ${newer.plant.marker}, replaces something; the ${shape}'s second member is a plain add`);
			if (asked[0].ability !== "extraction") fail(`${asked[0].id} asks about the ${shape} pair as ${asked[0].ability}; it is an extraction question`);
			const wanted = shape === "duplicate" ? older : newer;
			if (asked[0].evidence[0]?.marker !== wanted.plant.marker) fail(`${asked[0].id} rests on ${asked[0].evidence[0]?.marker ?? "nothing"}; the ${shape} question rests on ${wanted.plant.marker}`);
		}
		if (shape === "duplicate" && plantedWording(older.plant.line) !== plantedWording(newer.plant.line)) {
			fail(`the two members of the duplicate pair differ beyond their reference codes: "${plantedWording(older.plant.line)}" against "${plantedWording(newer.plant.line)}"`);
		}
		if (shape !== "duplicate" && plantedWording(older.plant.line) === plantedWording(newer.plant.line)) {
			fail(`the two members of the ${shape} pair are one sentence; only the duplicate says the same thing twice`);
		}
	}
	const shaped = fixture.questions.filter((question) => question.shape);
	const wholeShapes = CONFLICT_SHAPES.filter((shape) => plants.filter(({ plant }) => plant.shape === shape).length === 2);
	if (shaped.length !== wholeShapes.length) fail(`${shaped.length} questions carry a shape and the fixture holds ${wholeShapes.length} whole pair(s)`);
	if (fixture.sessions.length === WORLDS[fixture.language].sessions.length && wholeShapes.length !== CONFLICT_SHAPES.length) {
		fail(`the full ${fixture.language} fixture holds ${wholeShapes.length} of the ${CONFLICT_SHAPES.length} planted pairs whole`);
	}

	// The dropped conversation: at most one plant, never noted, in the LAST
	// sitting, whose every plant is unnoted so the scripted fold drops it whole;
	// exactly one question rests on it, in the said-not-noted style, and it is
	// the last question of all. No other question rests on a sitting the fold
	// drops: that place is the new plant's alone, so every earlier row keeps
	// the location it had.
	const droppedPlants = [...byKey.values()].filter((placed) => placed.dropped);
	if (droppedPlants.length > 1) fail(`the fixture plants ${droppedPlants.length} facts in dropped conversations; it plants at most one`);
	const droppedAsked = droppedQuestions(fixture);
	if (droppedPlants.length === 0) {
		if (droppedAsked.length > 0) fail(`${droppedAsked[0].id} rests on a conversation the fold drops whole, and this size plants nothing of the kind`);
	} else {
		const placed = droppedPlants[0];
		const last = fixture.sessions[fixture.sessions.length - 1];
		if (placed.sessionId !== last.id) fail(`${placed.marker} is planted in ${placed.sessionId}; the dropped conversation is the last sitting, ${last.id}`);
		if (placed.noted !== false) fail(`${placed.marker} is planted as noted; the dropped conversation's plant is never noted`);
		if (!last.plants.every((plant) => plant.noted === false)) fail(`${last.id} carries a noted plant beside ${placed.marker}, so the fold would keep it rather than drop it`);
		if (/<!-- plant/.test(last.recentContextEntry)) fail(`the RC entry of ${last.id} carries a directive, so the fold would keep the conversation rather than drop it`);
		if (droppedAsked.length !== 1) fail(`${droppedAsked.length} questions rest on the dropped conversation; exactly one does`);
		const question = droppedAsked[0];
		const beforeNoHint = fixture.questions.filter((candidate) => !candidate.noHint);
		if (question.id !== beforeNoHint[beforeNoHint.length - 1].id) fail(`${question.id} rests on the dropped conversation and is not the last question before the no-hint ones, so an earlier id moved`);
		if (question.ability !== "extraction" || question.shape) fail(`${question.id} asks about the dropped conversation as ${question.ability}; it is a plain extraction question`);
		if (!saidNotNoted.has(question.id)) fail(`${question.id} rests on the dropped conversation and was not checked as a question about the transcript`);
		if (question.evidence.length !== 1 || question.evidence[0].marker !== placed.marker) fail(`${question.id} rests on ${question.evidence.map((entry) => entry.marker).join(", ")}; the dropped conversation's question rests on ${placed.marker} alone`);
		const highest = Math.max(...plants.filter(({ plant }) => !plant.noHint).map(({ plant }) => Number(plant.marker.replace(/^REC-[A-Z]+/, ""))));
		if (Number(placed.marker.replace(/^REC-[A-Z]+/, "")) !== highest) fail(`${placed.marker} is numbered before another plant; the dropped conversation's plant is numbered after every class but the no-hint one`);
	}

	// The questions without a hint. Each rests on ONE sentence, never noted, said
	// in a sitting that notes other things, so the fold keeps the conversation
	// and the sentence sits in a folded transcript and in no note. The question
	// names its entity, the exchange names it too, and beyond the entity's own
	// words the question shares no content word with the planted sentence or with
	// the turn that led to it. The plants are numbered after every other plant
	// and the questions come after every other question, six per language at the
	// full size.
	const noHintAsked = fixture.questions.filter((question) => question.noHint);
	const noHintPlants = plants.filter(({ plant }) => plant.noHint);
	if (noHintPlants.length !== noHintAsked.length) fail(`${noHintPlants.length} no-hint plants stand against ${noHintAsked.length} no-hint questions; each plant has exactly one`);
	if (fixture.sessions.length === WORLDS[fixture.language].sessions.length && noHintAsked.length !== NO_HINT_QUESTIONS_PER_LANGUAGE) {
		fail(`the full ${fixture.language} fixture asks ${noHintAsked.length} no-hint questions; it promises ${NO_HINT_QUESTIONS_PER_LANGUAGE}`);
	}
	const folded = (text: string) => asciiFold(text.toLowerCase());
	const otherNumbers = plants.filter(({ plant }) => !plant.noHint).map(({ plant }) => Number(plant.marker.replace(/^REC-[A-Z]+/, "")));
	for (const question of noHintAsked) {
		if (question.ability !== "extraction" || question.shape || question.openItem) fail(`${question.id} is a no-hint question and reads as ${question.shape ?? question.ability}; it is scored like a plain extraction question`);
		if (!saidNotNoted.has(question.id)) fail(`${question.id} is a no-hint question and was not checked as a question about the transcript`);
		if (fixture.questions.indexOf(question) < fixture.questions.length - noHintAsked.length) fail(`${question.id} is a no-hint question and another kind of question comes after it, so an earlier id moved`);
		if (question.evidence.length !== 1) fail(`${question.id} rests on ${question.evidence.length} sentences; a no-hint question rests on one`);
		const entry = question.evidence[0];
		const session = fixture.sessions.find((candidate) => candidate.id === entry.sessionId)!;
		const plant = session.plants.find((candidate) => candidate.marker === entry.marker)!;
		if (!plant.noHint) fail(`${question.id} rests on ${plant.marker}, which is not planted as a no-hint sentence`);
		if (plant.noted !== false) fail(`${plant.marker} is noted; a no-hint sentence is said and never written down`);
		if (!session.plants.some((candidate) => candidate.noted !== false)) fail(`${session.id} notes nothing, so the fold would drop it; the sitting of the no-hint sentence ${plant.marker} is one the fold keeps`);
		if (otherNumbers.some((number) => number > Number(plant.marker.replace(/^REC-[A-Z]+/, "")))) fail(`${plant.marker} is numbered before another plant; the no-hint plants are numbered after every other class`);
		const entity = question.entity ?? "";
		if (!entity.trim()) fail(`${question.id} is a no-hint question and names no entity`);
		if (!folded(question.question).includes(folded(entity))) fail(`${question.id} does not name its entity "${entity}"`);
		const at = session.turns.findIndex((turn) => turn.text === plant.line);
		const exchange = [session.turns[at - 1]?.text ?? "", plant.line];
		if (!folded(exchange.join("\n")).includes(folded(entity))) fail(`the exchange of ${plant.marker} does not name the entity "${entity}" of ${question.id}`);
		const allowed = contentWords(entity);
		for (const text of exchange) {
			const said = contentWords(text);
			const shared = [...contentWords(question.question)].filter((word) => said.has(word) && !allowed.has(word));
			if (shared.length > 0) fail(`${question.id} shares "${shared.join('", "')}" with the exchange of ${plant.marker}; a no-hint question shares no content word with it except the entity "${entity}"`);
		}
		if (at < 1 || session.turns[at].role !== "assistant") fail(`${plant.marker} is not said by the room in ${session.id}`);
		if (session.plants.slice(session.plants.indexOf(plant) + 1).some((later) => !later.noHint)) fail(`${plant.marker} is not said at the end of ${session.id}, after everything the sitting planted before`);
	}
	for (const question of fixture.questions) {
		if (!question.noHint && question.evidence.some((evidence) => noHintPlants.some(({ plant }) => plant.marker === evidence.marker))) fail(`${question.id} rests on a no-hint sentence and is not a no-hint question`);
		if (!question.noHint && question.entity !== undefined) fail(`${question.id} names an entity, which only a no-hint question does`);
	}

	// The open items: as many as promised once the fixture holds that many
	// extraction questions, each one's plant written as an item in its RC entry
	// and never replaced or rewritten later.
	const openItems = fixture.questions.filter((question) => question.openItem);
	const extraction = fixture.questions.filter((question) => question.ability === "extraction" && !saidNotNoted.has(question.id) && !question.shape);
	const promised = Math.min(OPEN_ITEM_QUESTIONS_PER_LANGUAGE, extraction.length);
	if (openItems.length !== promised) fail(`${openItems.length} extraction questions are planted as open items; the fixture promises ${promised}`);
	for (const question of openItems) {
		for (const evidence of question.evidence) {
			const session = fixture.sessions.find((candidate) => candidate.id === evidence.sessionId)!;
			const plant = session.plants.find((candidate) => candidate.marker === evidence.marker)!;
			if (plant.kind !== "item") fail(`${question.id} is an open-item question and ${evidence.marker} is planted as a ${plant.kind ?? "fact"}`);
			if (!session.recentContextEntry.includes(`kind=item`)) fail(`the RC entry of ${session.id} writes no item directive for ${evidence.marker}`);
			if (plants.some(({ plant: other }) => other.supersedes === evidence.marker || other.updates === evidence.marker)) fail(`${evidence.marker} is planted as an open item and a later conversation replaces it`);
		}
	}
}

// --- Standalone use ----------------------------------------------------------

function flagValue(flag: string): string | undefined {
	const at = process.argv.indexOf(flag);
	return at > -1 ? process.argv[at + 1] : undefined;
}

function renderSessions(fixture: RecallFixture, plain: boolean): string {
	const out: string[] = [];
	for (const session of fixture.sessions) {
		out.push(`=== ${session.id} | ${session.date} | ${session.title}`, "");
		for (const turn of session.turns) out.push(`${turn.role}: ${turn.text}`);
		out.push("", plain ? stripRecallDirectives(session.recentContextEntry) : session.recentContextEntry);
	}
	return out.join("\n");
}

/** Whether the fact behind a piece of evidence ever reached an entry. */
function notedIn(fixture: RecallFixture, evidence: { sessionId: string; marker: string }): boolean {
	const plant = fixture.sessions.find((session) => session.id === evidence.sessionId)?.plants.find((candidate) => candidate.marker === evidence.marker);
	return plant?.noted !== false;
}

/**
 * Whether the conversation behind a piece of evidence is one the scripted
 * fold DROPS whole: it plants something and none of it is noted, so the fold
 * has no directive for it and takes no notes. Read off the sessions rather
 * than off a flag, because it is the fold's rule that decides it.
 */
export function droppedIn(fixture: RecallFixture, evidence: { sessionId: string }): boolean {
	const session = fixture.sessions.find((candidate) => candidate.id === evidence.sessionId);
	return session !== undefined && session.plants.length > 0 && session.plants.every((plant) => plant.noted === false);
}

/** The questions without a hint, in the order they are asked: six at the full size, fewer at a size that holds fewer of their sittings. */
export function noHintQuestions(fixture: RecallFixture): RecallQuestion[] {
	return fixture.questions.filter((question) => question.noHint);
}

/** The questions answered from a conversation the fold drops whole: one at the full size, none at a smaller one. */
export function droppedQuestions(fixture: RecallFixture): RecallQuestion[] {
	return fixture.questions.filter((question) => question.evidence.some((evidence) => droppedIn(fixture, evidence)));
}

/** How a piece of evidence is annotated in the key: nothing for a noted fact, and the place a transcript-only one sits. */
function evidenceNote(fixture: RecallFixture, evidence: { sessionId: string; marker: string }): string {
	if (notedIn(fixture, evidence)) return "";
	return droppedIn(fixture, evidence) ? " (said, not noted, conversation dropped)" : " (said, not noted)";
}

function renderKey(fixture: RecallFixture): string {
	// The questions of the planted pairs are listed in a block of their own
	// after the abilities, so the ability blocks read exactly as they did
	// before the pairs were planted; the dropped conversation's question is a
	// block of its own after those, for the same reason.
	const dropped = droppedQuestions(fixture);
	const abilityQuestions = fixture.questions.filter((question) => !question.shape && !question.noHint && !dropped.includes(question));
	const out: string[] = [`=== answer key | ${fixture.language} | seed ${fixture.seed} | ${fixture.sessions.length} sessions | ${abilityQuestions.length} questions`];
	const blocks: Array<[string, RecallQuestion[]]> = RECALL_ABILITIES.map((ability) => [ability, abilityQuestions.filter((question) => question.ability === ability)]);
	blocks.push(["conflicts", fixture.questions.filter((question) => question.shape)]);
	blocks.push(["no notes taken", dropped]);
	// The questions without a hint come last, in a block of their own, for the
	// same reason: everything above reads exactly as it did before them.
	blocks.push(["no hint", noHintQuestions(fixture)]);
	for (const [block, rows] of blocks) {
		if ((block === "conflicts" || block === "no notes taken" || block === "no hint") && rows.length === 0) continue;
		out.push("", `--- ${block} (${rows.length})`);
		for (const question of rows) {
			out.push(
				"",
				`${question.id} | asked ${question.askDate}${question.shape ? ` | ${question.shape}` : ""}`,
				`  Q: ${question.question}`,
				...(question.entity ? [`  entity: ${question.entity}`] : []),
				`  gold: ${question.gold.length > 0 ? question.gold.join(" | ") : "(abstain)"}`,
				...(question.trap && question.trap.length > 0 ? [`  trap: ${question.trap.join(" | ")}`] : []),
				...(question.distractor && question.distractor.length > 0 ? [`  distractor: ${question.distractor.join(" | ")}`] : []),
				...(question.trapPattern ? [`  trap pattern: ${question.trapPattern}`] : []),
				...(question.trapEvidence && question.trapEvidence.length > 0 ? [`  trap evidence: ${question.trapEvidence.map((e) => `${e.sessionId}/${e.marker}`).join(", ")}`] : []),
				`  evidence: ${question.evidence.length > 0 ? question.evidence.map((e) => `${e.sessionId}/${e.marker}${evidenceNote(fixture, e)}`).join(", ") : "(none)"}`,
				`  literal: ${question.queries.literal}`,
				`  paraphrase: ${question.queries.paraphrase}`,
				`  variant: ${question.queries.variant}`,
			);
		}
	}
	return `${out.join("\n")}\n`;
}

if (import.meta.url === `file://${process.argv[1]}`) {
	const language = (flagValue("--language") ?? "en") as RecallLanguage;
	if (language !== "de" && language !== "en") throw new Error('--language takes "de" or "en"');
	const seedArg = flagValue("--seed");
	const sessionsArg = flagValue("--sessions");
	const perAbilityArg = flagValue("--per-ability");
	const conversationArg = flagValue("--said-not-noted");
	const fixture = buildRecallFixture({
		language,
		...(seedArg ? { seed: Number(seedArg) } : {}),
		...(sessionsArg ? { sessions: Number(sessionsArg) } : {}),
		...(perAbilityArg ? { questionsPerAbility: Number(perAbilityArg) } : {}),
		...(conversationArg ? { conversationQuestions: Number(conversationArg) } : {}),
	});
	const plain = process.argv.includes("--plain");
	if (process.argv.includes("--key")) process.stdout.write(renderKey(fixture));
	else if (process.argv.includes("--sessions-only") || plain) process.stdout.write(`${renderSessions(fixture, plain)}\n`);
	else process.stdout.write(`${renderSessions(fixture, false)}\n\n${renderKey(fixture)}`);
}
