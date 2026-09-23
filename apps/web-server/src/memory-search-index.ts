// The text search a room's memory reads itself with (memory v2, stream 41.1).
//
// Until now recall was a case-insensitive substring test: the room found a note
// only when the question happened to carry the note's own spelling. A person
// asking about "die Überweisung" over a note that says "Ueberweisungen", or
// about "55k" over a note that says "55.000", got nothing back and read that as
// forgetting. This module is the other half of that sentence — a small ranked
// index over whatever documents the caller hands it, so the same question finds
// the note whichever way either side spelled it.
//
// What lives here and what does not:
//   - here: normalising, tokenising, the index, BM25 scoring, filters, dates;
//   - not here: anything that reads a file, a room, a clock or a model. Every
//     function below is pure: same input, same output, no imports at all. The
//     module that collects documents out of a room's files and the tool that
//     answers with them sit on top of this one and own all the I/O.
//
// THE MEETING RULE (the one rule the tokeniser exists for):
//   A word is indexed and queried in a folded form, so the two sides meet on
//   one token rather than on one spelling. Case, diacritics, thousands
//   separators, date spellings and quarter spellings are all folded; the plain
//   words survive alongside the folded token, so a note about "Juli" is still
//   findable by the word Juli and not only by 2026-07-11.
//
// Defaults (k1, b, the prefix length, the topic bonus, the stopword lists, the
// stemmer tables) are decisions, not accidents: they are named constants so the
// next person can move one and see what moved.

// --- The contract ------------------------------------------------------------

export type SearchSource = "note" | "archive" | "conversation";

export interface SearchDocument {
	id: string;
	source: SearchSource;
	/** The topic the document was filed under, when it has one. */
	topic?: string;
	/** YYYY-MM-DD. The day the document is dated; the tie-break and the range filters read it. */
	date: string;
	/** Where the document came from, e.g. an originating session id. Carried through, never searched. */
	origin?: string;
	text: string;
	meta?: Record<string, unknown>;
}

export interface SearchFilters {
	/** Exact topic, compared case- and diacritics-insensitively. */
	topic?: string;
	/** YYYY-MM-DD or YYYY-MM; a month means its first day. */
	since?: string;
	/** YYYY-MM-DD or YYYY-MM; a month means its last day. */
	until?: string;
	sources?: readonly SearchSource[];
}

export interface SearchHit {
	doc: SearchDocument;
	score: number;
	/** The query tokens that actually hit this document. */
	matched: string[];
}

/** Opaque on purpose: everything a caller needs from a built index is its size. */
export interface SearchIndex {
	readonly size: number;
}

export type SearchLanguage = "de" | "en";

// --- The decisions -----------------------------------------------------------

/** BM25's term-frequency saturation. */
export const SEARCH_K1 = 1.2;
/** BM25's length normalisation. */
export const SEARCH_B = 0.75;
/** A query token this long or longer also matches indexed tokens that start with it. */
export const SEARCH_PREFIX_MIN_CHARS = 5;
/** A hit whose topic the query names scores this much more. */
export const SEARCH_TOPIC_BONUS = 0.1;
/** Results returned when the caller does not say. */
export const SEARCH_DEFAULT_LIMIT = 10;
/** A stem shorter than this is not worth having, so the suffix stays on. */
export const SEARCH_MIN_STEM_CHARS = 4;
/**
 * What a single-letter German ending has to leave behind.
 *
 * -s and -n are letters German words end in anyway, so taking them off at four
 * characters costs more than it buys: "Preis" becomes "prei" and stops meeting
 * "Preise", "Daten" becomes "date" and walks into an English word. -e keeps the
 * ordinary floor, because raising it would break the pairs that DO meet on it —
 * "Kunde" and "Kunden" both land on "kund", "Woche" and "Wochen" on "woch".
 */
export const SEARCH_GERMAN_LONE_LETTER_MIN_STEM = 5;

// --- Folding -----------------------------------------------------------------

// The fast path: a word of plain ASCII needs none of the Unicode work below,
// and in a real archive most of them are. Building an index of ten thousand
// notes runs this test a few hundred thousand times, so it comes first.
const NON_ASCII = /[^\x00-\x7f]/;
const COMBINING_MARKS = /[̀-ͯ]/gu;
const UMLAUT_EXPANSION: Record<string, string> = { "ä": "ae", "ö": "oe", "ü": "ue" };

function stripDiacritics(word: string): string {
	return word.normalize("NFD").replace(COMBINING_MARKS, "");
}

/**
 * The forms a word is indexed and queried under.
 *
 * An umlaut word yields TWO: the expanded form and the stripped one, so
 * "Überweisung" is in the index as both `ueberweisung` and `uberweisung`. A word
 * without an umlaut yields one, itself folded. That is what makes the three
 * spellings meet: "Ueberweisung" is already `ueberweisung`, "uberweisung" is
 * already `uberweisung`, and the umlaut spelling — whichever side writes it —
 * carries both and so meets either. Two ASCII spellings of the same word never
 * meet each other directly, which is the price of not collapsing every `ue`
 * into `u` and breaking every ordinary word that owns one.
 *
 * `ß` folds to `ss` first, so "Straße" and "Strasse" are one token, and any
 * other accent is simply dropped.
 */
export function foldWordVariants(word: string): string[] {
	const lower = word.toLowerCase();
	if (!NON_ASCII.test(lower)) return [lower];
	const composed = lower.normalize("NFC").replace(/ß/gu, "ss");
	const expanded = stripDiacritics(composed.replace(/[äöü]/gu, (letter) => UMLAUT_EXPANSION[letter] ?? letter));
	const stripped = stripDiacritics(composed);
	return expanded === stripped ? [expanded] : [expanded, stripped];
}

/** The folded forms of a whole phrase, used to compare one topic against another. */
function foldPhraseKeys(phrase: string): string[] {
	const words = String(phrase ?? "").trim().split(/\s+/u).filter((word) => word.length > 0);
	const expanded: string[] = [];
	const stripped: string[] = [];
	for (const word of words) {
		const variants = foldWordVariants(word);
		expanded.push(variants[0]);
		stripped.push(variants[variants.length - 1]);
	}
	const first = expanded.join(" ");
	const second = stripped.join(" ");
	return first === second ? [first] : [first, second];
}

// --- Stopwords ---------------------------------------------------------------

// About sixty a side: the words that say nothing about what a note is about.
// They are folded through the same rule as everything else, so the list may be
// written the way the language writes it.
const GERMAN_STOPWORDS_SOURCE = [
	"aber", "alle", "als", "also", "am", "an", "auch", "auf", "aus", "bei", "bin", "bis", "da", "damit", "dann",
	"das", "dass", "dem", "den", "der", "des", "die", "dies", "diese", "doch", "dort", "du", "ein", "eine", "einem",
	"einen", "einer", "eines", "er", "es", "für", "hat", "hatte", "hier", "ich", "ihr", "im", "in", "ist", "kann",
	"kein", "mehr", "mit", "nach", "nicht", "noch", "nur", "oder", "ohne", "schon", "sehr", "sein", "sie", "sind",
	"so", "über", "um", "und", "uns", "vom", "von", "war", "waren", "was", "wenn", "werden", "wie", "wir", "wird",
	"wo", "zu", "zum", "zur",
];
const ENGLISH_STOPWORDS_SOURCE = [
	"a", "about", "after", "all", "also", "an", "and", "any", "are", "as", "at", "be", "been", "but", "by",
	"can", "could", "did", "do", "does", "for", "from", "had", "has", "have", "he", "her", "here", "him", "his",
	"how", "i", "if", "in", "into", "is", "it", "its", "just", "may", "me", "more", "most", "my", "no",
	"not", "of", "on", "only", "or", "other", "our", "out", "over", "she", "should", "so", "some", "such", "than",
	"that", "the", "their", "them", "then", "there", "these", "they", "this", "those", "to", "up", "very", "was", "we",
	"were", "what", "when", "which", "who", "why", "will", "with", "would", "you", "your",
];

function toStopwordSet(source: readonly string[]): Set<string> {
	const set = new Set<string>();
	for (const word of source) for (const variant of foldWordVariants(word)) set.add(variant);
	return set;
}

const STOPWORDS: Record<SearchLanguage, Set<string>> = {
	de: toStopwordSet(GERMAN_STOPWORDS_SOURCE),
	en: toStopwordSet(ENGLISH_STOPWORDS_SOURCE),
};

// --- Months, quarters, numbers ----------------------------------------------

// Both languages, long and short, folded the way foldWordVariants folds them so
// "März", "Maerz" and "marz" all find the third month.
const MONTH_NUMBERS: Record<string, number> = (() => {
	const names: Array<[number, string[]]> = [
		[1, ["january", "jan", "januar"]],
		[2, ["february", "feb", "februar"]],
		[3, ["march", "mar", "märz", "mrz"]],
		[4, ["april", "apr"]],
		[5, ["may", "mai"]],
		[6, ["june", "jun", "juni"]],
		[7, ["july", "jul", "juli"]],
		[8, ["august", "aug"]],
		[9, ["september", "sep", "sept"]],
		[10, ["october", "oct", "oktober", "okt"]],
		[11, ["november", "nov"]],
		[12, ["december", "dec", "dezember", "dez"]],
	];
	const map: Record<string, number> = {};
	for (const [month, spellings] of names) for (const spelling of spellings) for (const variant of foldWordVariants(spelling)) map[variant] = month;
	return map;
})();

const QUARTER_WORDS: Record<string, number> = (() => {
	const names: Array<[number, string[]]> = [
		[1, ["first", "erste", "erstes", "ersten", "erster"]],
		[2, ["second", "zweite", "zweites", "zweiten", "zweiter"]],
		[3, ["third", "dritte", "drittes", "dritten", "dritter"]],
		[4, ["fourth", "vierte", "viertes", "vierten", "vierter"]],
	];
	const map: Record<string, number> = {};
	for (const [quarter, spellings] of names) for (const spelling of spellings) for (const variant of foldWordVariants(spelling)) map[variant] = quarter;
	return map;
})();

function isLeapYear(year: number): boolean {
	return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

function daysInMonth(year: number, month: number): number {
	if (month === 2) return isLeapYear(year) ? 29 : 28;
	return month === 4 || month === 6 || month === 9 || month === 11 ? 30 : 31;
}

function pad2(value: number): string {
	return value < 10 ? `0${value}` : String(value);
}

/** An ISO day, or null when those three numbers are not a day that exists. */
function isoDate(year: number, month: number, day: number): string | null {
	if (!Number.isInteger(year) || year < 1000 || year > 9999) return null;
	if (month < 1 || month > 12) return null;
	if (day < 1 || day > daysInMonth(year, month)) return null;
	return `${year}-${pad2(month)}-${pad2(day)}`;
}

/**
 * The folded token plus, when it carried words, the words themselves.
 *
 * A quarter written "drittes Quartal" becomes `q3 drittes Quartal`: the note is
 * findable by the canonical quarter AND still by the words, because a person
 * who searches for Quartal means it. A purely numeric spelling has no words to
 * keep, so it is simply replaced and leaves no half-tokens behind.
 */
function foldedWithWords(canonical: string, source: string): string {
	if (!/\p{L}/u.test(source)) return ` ${canonical} `;
	if (source.trim().toLowerCase() === canonical) return ` ${canonical} `;
	return ` ${canonical} ${source} `;
}

const LETTER_RUNS = /\p{L}+/gu;

/**
 * A date is three tokens, never one.
 *
 * A note dated the eleventh of July answers a question about that day, a
 * question about July, and a question about 2026, so every spelling folds to
 * the day, the month it falls in and the year. Only the words are kept from the
 * original — the digits are already in the tokens above them, and keeping them
 * as well would say 2026 twice and leave a stray 11 behind.
 *
 * The numbers come first and the words last on purpose: a month word that
 * survives the fold then has a YEAR in front of it rather than behind it, so
 * the month-and-year rule further down cannot read it a second time.
 */
function foldedDate(iso: string | null, year: number, month: number, source: string): string {
	const words = source.match(LETTER_RUNS);
	const day = iso ? `${iso} ` : "";
	// A day carries its month-and-day as a fourth token, so a question that
	// names the day without its year still meets the note that has one.
	const monthDay = iso ? ` ${iso.slice(5)}` : "";
	return ` ${day}${year}-${pad2(month)} ${year}${monthDay}${words ? ` ${words.join(" ")} ` : " "}`;
}

/**
 * A day written without its year is the month-and-day token alone, plus its
 * words: "12. März" becomes `03-12 März`. Only a day that exists in that
 * month in some year qualifies (a leap day passes).
 */
function foldedDayWithoutYear(month: number, day: number, source: string): string | null {
	if (month < 1 || month > 12 || day < 1 || day > daysInMonth(2000, month)) return null;
	const words = source.match(LETTER_RUNS);
	return ` ${pad2(month)}-${pad2(day)}${words ? ` ${words.join(" ")} ` : " "}`;
}

const ISO_MONTH_PATTERN = /(?<![\p{L}\d-])(\d{4})-(\d{1,2})(?![\p{L}\d-])/gu;
const ISO_DATE_PATTERN = /(?<![\p{L}\d-])(\d{4})-(\d{1,2})-(\d{1,2})(?![\p{L}\d-])/gu;
const DOTTED_DATE_PATTERN = /(?<![\p{L}\d.])(\d{1,2})\.\s?(\d{1,2})\.\s?(\d{4})(?![\p{L}\d-])/gu;
// Day, month, year, read the European way and no other: 03/12/2025 is the
// third of December. A two-digit year is not read.
const SLASH_DATE_PATTERN = /(?<![\p{L}\d/])(\d{1,2})\/(\d{1,2})\/(\d{4})(?![\p{L}\d/])/gu;
const DAY_MONTH_YEAR_PATTERN = /(?<![\p{L}\d])(\d{1,2})(?:\.|st|nd|rd|th)?\s+(?:of\s+)?(\p{L}+)\.?\s+(\d{4})(?![\p{L}\d-])/giu;
const MONTH_DAY_YEAR_PATTERN = /(?<![\p{L}\d])(\p{L}+)\.?\s+(\d{1,2})(?:\.|st|nd|rd|th)?\s*,?\s+(\d{4})(?![\p{L}\d-])/giu;
const MONTH_YEAR_PATTERN = /(?<![\p{L}\d])(\p{L}+)\.?\s+(\d{4})(?![\p{L}\d-])/giu;
// A day without its year. Each refuses a following four-digit number, so a
// day with a year that the rules above declined (an impossible day) is not
// half-read here. The lookbehinds refuse the hyphen and the digit-space the
// folds above leave in front of a month-and-day and its month word, so a
// date folded once is never read a second time from its own output.
const DAY_MONTHWORD_PATTERN = /(?<![\p{L}\d-])(\d{1,2})(?:\.|st|nd|rd|th)?\s+(?:of\s+)?(\p{L}+)(?![\p{L}\d])(?!\s*,?\s*\d{4})/giu;
const MONTHWORD_DAY_PATTERN = /(?<![\p{L}\d])(?<!\d\s)(\p{L}+)\s+(\d{1,2})(?:st|nd|rd|th)?(?![\p{L}\d])(?!\s*,?\s*\d{4})/giu;
const DOTTED_DAY_MONTH_PATTERN = /(?<![\p{L}\d.])(\d{1,2})\.(\d{1,2})\.(?!\s?\d)/gu;
const SHORT_QUARTER_PATTERN = /(?<![\p{L}\d])[qQ]([1-4])(?![\p{L}\d])/gu;
const NUMBERED_QUARTER_PATTERN = /(?<![\p{L}\d])([1-4])\.?\s*(quartals?|quarter)(?![\p{L}])/giu;
const WORDED_QUARTER_PATTERN = /(?<![\p{L}\d])(\p{L}+)\s+(quartals?|quarter)(?![\p{L}])/giu;
const ORDINAL_PATTERN = /(?<![\p{L}\d])(\d{1,4})(?:st|nd|rd|th)(?![\p{L}\d])/giu;
const THOUSANDS_SUFFIX_PATTERN = /(?<![\p{L}\d.,])(\d{1,3})(?:([.,])(\d{1,3}))?\s?[kK](?![\p{L}\d])/gu;
const THOUSANDS_GROUPED_PATTERN = /(?<![\p{L}\d.,])(\d{1,3}(?:[.,  ]\d{3})+)(?![\p{L}\d.,])/gu;

/**
 * Everything a person writes differently from the way a note wrote it, folded
 * to one spelling before the text is cut into tokens.
 *
 * Order matters and is the point: dates go first so a day is never mistaken for
 * a thousands group, quarters next so "3. Quartal" keeps its three, ordinals
 * after that, and plain numbers last.
 */
export function normalizeSearchText(text: string): string {
	let folded = String(text ?? "");

	// A month on its own goes first, so it never sees the months the day rules
	// below emit; a month-and-year in words goes last, for the same reason. Each
	// rule replaces what it read, so nothing is folded twice.
	folded = folded.replace(ISO_MONTH_PATTERN, (match, year: string, month: string) => {
		const number = Number(month);
		return number >= 1 && number <= 12 ? foldedDate(null, Number(year), number, "") : match;
	});
	folded = folded.replace(ISO_DATE_PATTERN, (match, year: string, month: string, day: string) => {
		const iso = isoDate(Number(year), Number(month), Number(day));
		return iso ? foldedDate(iso, Number(year), Number(month), match) : match;
	});
	folded = folded.replace(DOTTED_DATE_PATTERN, (match, day: string, month: string, year: string) => {
		const iso = isoDate(Number(year), Number(month), Number(day));
		return iso ? foldedDate(iso, Number(year), Number(month), match) : match;
	});
	folded = folded.replace(SLASH_DATE_PATTERN, (match, day: string, month: string, year: string) => {
		const iso = isoDate(Number(year), Number(month), Number(day));
		return iso ? foldedDate(iso, Number(year), Number(month), match) : match;
	});
	folded = folded.replace(DAY_MONTH_YEAR_PATTERN, (match, day: string, monthWord: string, year: string) => {
		const month = MONTH_NUMBERS[foldWordVariants(monthWord)[0]];
		if (month === undefined) return match;
		const iso = isoDate(Number(year), month, Number(day));
		return iso ? foldedDate(iso, Number(year), month, match) : match;
	});
	folded = folded.replace(MONTH_DAY_YEAR_PATTERN, (match, monthWord: string, day: string, year: string) => {
		const month = MONTH_NUMBERS[foldWordVariants(monthWord)[0]];
		if (month === undefined) return match;
		const iso = isoDate(Number(year), month, Number(day));
		return iso ? foldedDate(iso, Number(year), month, match) : match;
	});
	folded = folded.replace(MONTH_YEAR_PATTERN, (match, monthWord: string, year: string) => {
		const month = MONTH_NUMBERS[foldWordVariants(monthWord)[0]];
		if (month === undefined) return match;
		const number = Number(year);
		return number >= 1000 && number <= 9999 ? foldedDate(null, number, month, match) : match;
	});

	// A day without its year, after every rule that reads one with a year.
	folded = folded.replace(DAY_MONTHWORD_PATTERN, (match, day: string, monthWord: string) => {
		const month = MONTH_NUMBERS[foldWordVariants(monthWord)[0]];
		if (month === undefined) return match;
		return foldedDayWithoutYear(month, Number(day), match) ?? match;
	});
	folded = folded.replace(MONTHWORD_DAY_PATTERN, (match, monthWord: string, day: string) => {
		const month = MONTH_NUMBERS[foldWordVariants(monthWord)[0]];
		if (month === undefined) return match;
		return foldedDayWithoutYear(month, Number(day), match) ?? match;
	});
	folded = folded.replace(DOTTED_DAY_MONTH_PATTERN, (match, day: string, month: string) => foldedDayWithoutYear(Number(month), Number(day), match) ?? match);

	// Ordinals come off before the quarters read their number, so "3rd quarter"
	// and "3. Quartal" arrive at the quarter rule looking the same.
	folded = folded.replace(ORDINAL_PATTERN, (_match, digits: string) => ` ${digits} `);

	folded = folded.replace(SHORT_QUARTER_PATTERN, (match, quarter: string) => foldedWithWords(`q${quarter}`, match));
	folded = folded.replace(NUMBERED_QUARTER_PATTERN, (match, quarter: string) => foldedWithWords(`q${quarter}`, match));
	folded = folded.replace(WORDED_QUARTER_PATTERN, (match, ordinalWord: string) => {
		const quarter = QUARTER_WORDS[foldWordVariants(ordinalWord)[0]];
		return quarter === undefined ? match : foldedWithWords(`q${quarter}`, match);
	});

	folded = folded.replace(THOUSANDS_SUFFIX_PATTERN, (_match, whole: string, _separator: string | undefined, fraction: string | undefined) => {
		// A group of exactly three digits after the separator is a thousands
		// group ("55.000k"); anything shorter is a decimal ("1.5k").
		const thousands = fraction === undefined ? Number(whole) * 1000 : fraction.length === 3 ? Number(`${whole}${fraction}`) * 1000 : Number(`${whole}.${fraction}`) * 1000;
		return ` ${Math.round(thousands)} `;
	});
	folded = folded.replace(THOUSANDS_GROUPED_PATTERN, (match) => ` ${match.replace(/[.,  ]/gu, "")} `);

	return folded;
}

// --- Tokenising --------------------------------------------------------------

// A folded day, a folded month and a folded month-and-day each stay one token;
// everything else is a run of letters and digits. The alternation is ordered,
// so the scanner sees the day before the month, the month before the
// month-and-day, and all of them before the bare 2026. The month-and-day shape
// refuses digits on either side, so 07-2026 stays a 07 and a 2026.
const TOKEN_SCAN = /\d{4}-\d{2}-\d{2}|\d{4}-\d{2}|(?<!\d)\d{2}-\d{2}(?!\d)|[\p{L}\p{N}]+/gu;

/** A token that carries a digit is a date or a number and is never stemmed. */
const HAS_DIGIT = /\d/;

// Longest suffix first, and only one comes off. When the longest would leave a
// stump, the next one is tried rather than the word being left alone — "notes"
// would keep its s under a strict reading and then never meet "note".
const GERMAN_SUFFIXES: readonly string[] = ["ern", "en", "er", "es", "e", "s", "n"];
const ENGLISH_SUFFIXES: readonly string[] = ["ing", "ies", "ed", "es", "s"];

/** What each German ending has to leave standing before it may come off. */
const GERMAN_SUFFIX_FLOORS: Record<string, number> = {
	ern: SEARCH_MIN_STEM_CHARS,
	en: SEARCH_MIN_STEM_CHARS,
	er: SEARCH_MIN_STEM_CHARS,
	es: SEARCH_MIN_STEM_CHARS,
	e: SEARCH_MIN_STEM_CHARS,
	s: SEARCH_GERMAN_LONE_LETTER_MIN_STEM,
	n: SEARCH_GERMAN_LONE_LETTER_MIN_STEM,
};

/**
 * The letters a lone German ending actually follows.
 *
 * After anything else the letter belongs to the word rather than to the
 * grammar, and taking it off invents a word nobody wrote. It is the difference
 * between "Vertrags" (a genitive, and Vertrag is the word) and "Status",
 * "Preis", "Ergebnis", "Haus" and "Bus", where the s IS the word; and between
 * "Kunden" (the plural of Kunde) and "Termin" or "Aktion", where the n is.
 */
const GERMAN_LONE_ENDING_FOLLOWS: Record<string, string> = { s: "bdfghklmnrt", n: "e" };

function stemGerman(token: string): string {
	for (const suffix of GERMAN_SUFFIXES) {
		if (!token.endsWith(suffix)) continue;
		const stem = token.slice(0, token.length - suffix.length);
		if (stem.length < (GERMAN_SUFFIX_FLOORS[suffix] ?? SEARCH_MIN_STEM_CHARS)) continue;
		const follows = GERMAN_LONE_ENDING_FOLLOWS[suffix];
		if (follows && !follows.includes(stem[stem.length - 1])) continue;
		return stem;
	}
	return token;
}

function stemEnglish(token: string): string {
	for (const suffix of ENGLISH_SUFFIXES) {
		if (!token.endsWith(suffix)) continue;
		const stem = suffix === "ies" ? `${token.slice(0, token.length - 3)}y` : token.slice(0, token.length - suffix.length);
		if (stem.length >= SEARCH_MIN_STEM_CHARS) return stem;
	}
	return token;
}

function stem(token: string, lang: SearchLanguage): string {
	if (HAS_DIGIT.test(token)) return token;
	return lang === "de" ? stemGerman(token) : stemEnglish(token);
}

/** The raw words of a text, folded but neither stopped nor stemmed. */
function foldedWords(text: string): string[][] {
	const words: string[][] = [];
	const scan = normalizeSearchText(text);
	TOKEN_SCAN.lastIndex = 0;
	for (let match = TOKEN_SCAN.exec(scan); match !== null; match = TOKEN_SCAN.exec(scan)) words.push(foldWordVariants(match[0]));
	return words;
}

/**
 * Which language a text is in, read off how many of its words are that
 * language's small change. A text with none of either — a list of names, a
 * table of numbers — is called English, because a tie has to fall somewhere and
 * the English stemmer is the more cautious of the two.
 */
export function guessLanguage(text: string): SearchLanguage {
	return guessLanguageOf(foldedWords(text));
}

function guessLanguageOf(words: readonly string[][]): SearchLanguage {
	let german = 0;
	let english = 0;
	for (const variants of words) {
		if (variants.some((variant) => STOPWORDS.de.has(variant))) german += 1;
		if (variants.some((variant) => STOPWORDS.en.has(variant))) english += 1;
	}
	return german > english ? "de" : "en";
}

/**
 * The tokens a text is indexed or searched by.
 *
 * With a language named this is a document: that language's stopwords come out
 * and that language's stemmer runs. Without one it is a query: the language is
 * guessed for the stopwords, and BOTH stemmers run, so a question typed in
 * either language reaches a note written in either. A word the wrong language's
 * stopword list keeps is harmless — no document of the other language indexed
 * it, so it simply matches nothing.
 */
export function tokenize(text: string, lang?: SearchLanguage): string[] {
	const words = foldedWords(text);
	if (lang) return documentTokens(words, lang);
	return queryGroups(words).flatMap((group) => group.variants);
}

function documentTokens(words: readonly string[][], lang: SearchLanguage): string[] {
	const tokens: string[] = [];
	for (const variants of words) {
		if (variants.some((variant) => STOPWORDS[lang].has(variant))) continue;
		for (const variant of variants) tokens.push(stem(variant, lang));
	}
	return tokens;
}

/**
 * A query word and every token it may meet a document on: its umlaut variants,
 * each stemmed both ways. They are kept grouped rather than flattened because
 * scoring must count one word once — a word that reaches a document through two
 * of its own variants is not twice as relevant.
 */
interface QueryGroup {
	variants: string[];
}

function analyzeQuery(query: string): QueryGroup[] {
	return queryGroups(foldedWords(query));
}

function queryGroups(words: readonly string[][]): QueryGroup[] {
	const lang = guessLanguageOf(words);
	const groups: QueryGroup[] = [];
	const seen = new Set<string>();
	for (const variants of words) {
		if (variants.some((variant) => STOPWORDS[lang].has(variant))) continue;
		const tokens: string[] = [];
		for (const variant of variants) {
			for (const candidate of [stem(variant, "de"), stem(variant, "en")]) if (!tokens.includes(candidate)) tokens.push(candidate);
		}
		const key = tokens.join(" ");
		if (seen.has(key)) continue;
		seen.add(key);
		groups.push({ variants: tokens });
	}
	return groups;
}

// --- The index ---------------------------------------------------------------

interface Posting {
	doc: number;
	tf: number;
}

interface IndexedDocument {
	doc: SearchDocument;
	lang: SearchLanguage;
	/** Token count, BM25's document length. */
	length: number;
	/** The tokens of the document's topic, for the bonus. */
	topicTokens: Set<string>;
	topicKeys: string[];
}

interface BuiltIndex extends SearchIndex {
	readonly size: number;
	readonly docs: IndexedDocument[];
	readonly postings: Map<string, Posting[]>;
	/** Sorted once, so a prefix is a range rather than a scan of every term. */
	readonly terms: string[];
	readonly averageLength: number;
}

function asBuiltIndex(index: SearchIndex): BuiltIndex {
	const built = index as BuiltIndex;
	if (!built || !(built.postings instanceof Map) || !Array.isArray(built.docs)) throw new Error("search: this index did not come from buildIndex");
	return built;
}

/**
 * The index over a set of documents.
 *
 * A document's language is guessed from the document itself, not from the room
 * or the query: an archive holds notes in both languages side by side, and
 * stemming a German note with the English rules is how a note stops being
 * findable. The topic is indexed together with the text, because naming a topic
 * is one of the ways people ask for what is in it.
 */
export function buildIndex(docs: readonly SearchDocument[]): SearchIndex {
	const indexed: IndexedDocument[] = [];
	const postings = new Map<string, Posting[]>();
	let totalLength = 0;

	for (let position = 0; position < docs.length; position += 1) {
		const doc = docs[position];
		const topic = doc.topic ?? "";
		const body = topic ? `${topic}\n${doc.text ?? ""}` : String(doc.text ?? "");
		// Folded once and then read three ways — the guess, the tokens and the
		// length all come off the same pass, because ten thousand notes cannot
		// afford to be normalised twice.
		const words = foldedWords(body);
		const lang = guessLanguageOf(words);
		const tokens = documentTokens(words, lang);
		const frequencies = new Map<string, number>();
		for (const token of tokens) frequencies.set(token, (frequencies.get(token) ?? 0) + 1);
		for (const [token, tf] of frequencies) {
			const list = postings.get(token);
			if (list) list.push({ doc: position, tf });
			else postings.set(token, [{ doc: position, tf }]);
		}
		totalLength += tokens.length;
		indexed.push({
			doc,
			lang,
			length: tokens.length,
			topicTokens: new Set(topic ? tokenize(topic, lang) : []),
			topicKeys: topic ? foldPhraseKeys(topic) : [],
		});
	}

	const built: BuiltIndex = {
		size: indexed.length,
		docs: indexed,
		postings,
		// Sorted once here rather than at every query, so a prefix is a range.
		terms: [...postings.keys()].sort(),
		averageLength: indexed.length > 0 ? totalLength / indexed.length : 0,
	};
	return built;
}

// --- Dates -------------------------------------------------------------------

const ISO_MONTH = /^(\d{4})-(\d{1,2})$/u;
const ISO_DAY = /^(\d{4})-(\d{1,2})-(\d{1,2})$/u;

/**
 * A filter's date as the span it names: a day is a span of one, a month is the
 * span from its first to its last. Any spelling the normaliser already folds is
 * accepted too, so a filter typed "11. Juli 2026" means the same day the notes
 * are dated with. Anything else is null, and the caller decides what to say.
 */
export function parseSearchDate(value: string): { from: string; to: string } | null {
	const text = String(value ?? "").trim();
	if (!text) return null;

	const day = ISO_DAY.exec(text);
	if (day) {
		const iso = isoDate(Number(day[1]), Number(day[2]), Number(day[3]));
		return iso ? { from: iso, to: iso } : null;
	}

	const month = ISO_MONTH.exec(text);
	if (month) {
		const year = Number(month[1]);
		const number = Number(month[2]);
		if (number < 1 || number > 12 || year < 1000 || year > 9999) return null;
		return { from: `${year}-${pad2(number)}-01`, to: `${year}-${pad2(number)}-${pad2(daysInMonth(year, number))}` };
	}

	// One more chance through the normaliser: the spellings a person types are
	// the spellings the notes are searched with, so a filter may use them too.
	const folded = normalizeSearchText(text).match(/\d{4}-\d{2}-\d{2}/u);
	if (folded) return { from: folded[0], to: folded[0] };
	return null;
}

function rangeBound(value: string | undefined, edge: "from" | "to"): string | null {
	if (value === undefined) return null;
	const parsed = parseSearchDate(value);
	if (!parsed) throw new Error(`search: "${value}" is not a date this understands (use YYYY-MM-DD or YYYY-MM)`);
	return parsed[edge];
}

// --- Searching ---------------------------------------------------------------

function normalizeLimit(limit: number | undefined): number {
	if (limit === undefined || !Number.isFinite(limit)) return SEARCH_DEFAULT_LIMIT;
	return Math.max(0, Math.floor(limit));
}

/** Where the sorted terms first reach the prefix, so the expansion is a walk and not a scan. */
function lowerBound(terms: readonly string[], prefix: string): number {
	let low = 0;
	let high = terms.length;
	while (low < high) {
		const middle = (low + high) >> 1;
		if (terms[middle] < prefix) low = middle + 1;
		else high = middle;
	}
	return low;
}

/**
 * The indexed terms a query token may score against: itself, and — once the
 * token is long enough to mean something on its own — everything that starts
 * with it. Four characters is too little: "note" would drag in every notebook
 * and notice in the archive.
 */
function expandTerm(index: BuiltIndex, token: string): string[] {
	const expanded = index.postings.has(token) ? [token] : [];
	if (token.length < SEARCH_PREFIX_MIN_CHARS) return expanded;
	for (let position = lowerBound(index.terms, token); position < index.terms.length; position += 1) {
		const term = index.terms[position];
		if (!term.startsWith(token)) break;
		if (term !== token) expanded.push(term);
	}
	return expanded;
}

// Newer first, and a note with no date sorts last: unknown is not newest. The
// comparison is a plain one rather than a collation, because a collation is
// entitled to decide that an empty string and a date are the same thing.
function newestFirst(left: IndexedDocument, right: IndexedDocument): number {
	const leftDate = String(left.doc.date ?? "").trim();
	const rightDate = String(right.doc.date ?? "").trim();
	if (leftDate !== rightDate) return leftDate < rightDate ? 1 : -1;
	return String(left.doc.id ?? "").localeCompare(String(right.doc.id ?? ""));
}

/**
 * The documents that match, best first.
 *
 * BM25 does the ranking, a document whose topic the question names gets a tenth
 * more, and the date breaks ties — between two notes that answer equally well,
 * the later one is the one that still holds. An empty query is not an error: with
 * a topic filter it is a request to read that topic, newest first.
 *
 * A filter that is not a date throws, because silently searching a range nobody
 * asked for is worse than saying the date could not be read.
 */
export function search(index: SearchIndex, query: string, opts?: { filters?: SearchFilters; limit?: number }): SearchHit[] {
	const built = asBuiltIndex(index);
	const limit = normalizeLimit(opts?.limit);
	const filters = opts?.filters;
	const since = rangeBound(filters?.since, "from");
	const until = rangeBound(filters?.until, "to");
	const sources = filters?.sources ? new Set<SearchSource>(filters.sources) : null;
	const topicKeys = filters?.topic ? foldPhraseKeys(filters.topic) : null;

	const eligible: boolean[] = new Array(built.docs.length);
	let eligibleCount = 0;
	for (let position = 0; position < built.docs.length; position += 1) {
		const indexed = built.docs[position];
		// A note written before the day was written down has no date. A range
		// cannot prove it falls outside, so it stays: only the notes that are
		// provably outside are dropped. Dropping the undated ones would be a
		// silent claim about when they were written.
		const date = String(indexed.doc.date ?? "").trim();
		eligible[position] =
			(!sources || sources.has(indexed.doc.source)) &&
			(!since || !date || date >= since) &&
			(!until || !date || date <= until) &&
			(!topicKeys || indexed.topicKeys.some((key) => topicKeys.includes(key)));
		if (eligible[position]) eligibleCount += 1;
	}

	const filtering = eligibleCount !== built.docs.length;

	const groups = analyzeQuery(query);
	if (groups.length === 0) {
		if (!topicKeys) return [];
		return built.docs
			.filter((_indexed, position) => eligible[position])
			.sort(newestFirst)
			.slice(0, limit)
			.map((indexed) => ({ doc: indexed.doc, score: 0, matched: [] }));
	}

	const scores = new Map<number, number>();
	const matched = new Map<number, Set<string>>();
	const queryTokens = new Set<string>(groups.flatMap((group) => group.variants));

	for (const group of groups) {
		// One word, counted once: a word that reaches the same document through
		// two of its own spellings takes the better of the two, never the sum.
		const best = new Map<number, { score: number; token: string }>();
		for (const token of group.variants) {
			const perDoc = new Map<number, number>();
			for (const term of expandTerm(built, token)) {
				const postings = built.postings.get(term);
				if (!postings) continue;
				// Counting the survivors costs a pass over the postings, so an
				// unfiltered search — the common one — takes the length instead.
				let documentFrequency = postings.length;
				if (filtering) {
					documentFrequency = 0;
					for (const posting of postings) if (eligible[posting.doc]) documentFrequency += 1;
				}
				if (documentFrequency === 0) continue;
				// Rarity is rarity among the documents the filters left standing:
				// a term every surviving note carries says nothing, however rare
				// it may be in the ones the filters took away.
				const idf = Math.log(1 + (eligibleCount - documentFrequency + 0.5) / (documentFrequency + 0.5));
				for (const posting of postings) {
					if (!eligible[posting.doc]) continue;
					const length = built.docs[posting.doc].length;
					const normalized = built.averageLength > 0 ? length / built.averageLength : 1;
					const contribution = (idf * (posting.tf * (SEARCH_K1 + 1))) / (posting.tf + SEARCH_K1 * (1 - SEARCH_B + SEARCH_B * normalized));
					perDoc.set(posting.doc, (perDoc.get(posting.doc) ?? 0) + contribution);
				}
			}
			for (const [position, score] of perDoc) {
				const current = best.get(position);
				if (!current || score > current.score) best.set(position, { score, token });
			}
		}
		for (const [position, hit] of best) {
			scores.set(position, (scores.get(position) ?? 0) + hit.score);
			const tokens = matched.get(position);
			if (tokens) tokens.add(hit.token);
			else matched.set(position, new Set([hit.token]));
		}
	}

	const hits: Array<{ indexed: IndexedDocument; score: number; matched: string[] }> = [];
	for (const [position, score] of scores) {
		const indexed = built.docs[position];
		let namesTopic = topicKeys !== null;
		if (!namesTopic) for (const token of indexed.topicTokens) if (queryTokens.has(token)) { namesTopic = true; break; }
		hits.push({
			indexed,
			score: namesTopic ? score * (1 + SEARCH_TOPIC_BONUS) : score,
			matched: [...(matched.get(position) ?? [])].sort(),
		});
	}

	hits.sort((left, right) => (right.score !== left.score ? right.score - left.score : newestFirst(left.indexed, right.indexed)));
	return hits.slice(0, limit).map((hit) => ({ doc: hit.indexed.doc, score: hit.score, matched: hit.matched }));
}
