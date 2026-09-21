// The search index's own smoke (memory v2, stream 41.1).
//
// The module under test is the one a room will find its own notes with, and
// every promise it makes is a promise about a spelling: that a question written
// one way reaches a note written another. A smoke for it therefore has to be
// made of the spellings themselves, not of round numbers — so each check below
// is a pair of texts that a person would consider the same thing and the index
// has to agree on.
//
// What this pins:
//   - the tokeniser in both languages: the three ways an umlaut word is written,
//     ß, the two stemmers and the floor that stops them chewing a word down to a
//     stump, the stopwords, the six date spellings, the four number spellings,
//     the quarters, the ordinals, and the two things that must never be stemmed;
//   - the ranking, on a corpus small enough to reason about by hand: repetition
//     beats a single mention, a rare word beats a common one, and the shorter of
//     two notes with the same count wins;
//   - prefix matching where it is allowed and where it is not;
//   - the topic bonus, both as the exact tenth it is and as an order it flips;
//   - the date tie-break, down to the id;
//   - every filter, including the empty query that is a request to read a topic
//     and the unreadable date that has to throw rather than search a range
//     nobody asked for;
//   - the size the whole thing has to stay fast at.
//
// Offline and portless: the module has no imports of its own, so there is
// nothing here to start, isolate or tear down. The one clock reading is the
// stopwatch in the last section.

import {
	buildIndex,
	guessLanguage,
	normalizeSearchText,
	parseSearchDate,
	search,
	tokenize,
	type SearchDocument,
	type SearchHit,
} from "../src/memory-search-index.js";

let passes = 0;

function pass(label: string): void {
	passes += 1;
	console.log(`  ok ${label}`);
}

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

function ids(hits: readonly SearchHit[]): string {
	return hits.map((hit) => hit.doc.id).join(",");
}

function scoreOf(hits: readonly SearchHit[], id: string): number {
	const hit = hits.find((candidate) => candidate.doc.id === id);
	assert(hit, `${id} is missing from the results (${ids(hits)})`);
	return hit.score;
}

function note(id: string, topic: string, date: string, text: string, source: SearchDocument["source"] = "note"): SearchDocument {
	return { id, source, topic, date, text };
}

try {
	// --- 1. The umlaut, three ways ------------------------------------------
	{
		const words = buildIndex([
			note("u-umlaut", "Zahlungen", "2026-07-01", "Die Überweisung ist angekommen."),
			note("u-expanded", "Zahlungen", "2026-07-02", "Die Ueberweisung ist angekommen."),
			note("u-stripped", "Zahlungen", "2026-07-03", "Die uberweisung ist angekommen."),
		]);
		assert(tokenize("Überweisung", "de").join(",") === "ueberweisung,uberweisung", `an umlaut word is indexed under both folded forms (${tokenize("Überweisung", "de").join(",")})`);
		assert(tokenize("Ueberweisung", "de").join(",") === "ueberweisung", "the expanded spelling is indexed as itself");
		assert(tokenize("uberweisung", "de").join(",") === "uberweisung", "the stripped spelling is indexed as itself");
		const asked = search(words, "Überweisung");
		assert(asked.length === 3, `the umlaut spelling of the question reaches all three spellings of the note (${ids(asked)})`);
		const expanded = search(words, "Ueberweisung").map((hit) => hit.doc.id).sort().join(",");
		assert(expanded === "u-expanded,u-umlaut", `the expanded spelling reaches the umlaut note and its own (${expanded})`);
		const stripped = search(words, "uberweisung").map((hit) => hit.doc.id).sort().join(",");
		assert(stripped === "u-stripped,u-umlaut", `the stripped spelling reaches the umlaut note and its own (${stripped})`);
		pass("the three spellings of an umlaut word meet through the umlaut form, which carries both");
	}

	// --- 2. ß, and the two stemmers -----------------------------------------
	{
		assert(tokenize("Straße", "de").join(",") === "strass" && tokenize("Strasse", "de").join(",") === "strass", `ß and ss are one token (${tokenize("Straße", "de").join(",")} / ${tokenize("Strasse", "de").join(",")})`);

		assert(tokenize("Wochen", "de").join(",") === "woch" && tokenize("Woche", "de").join(",") === "woch", "German -en and -e come off and the two forms meet");
		assert(tokenize("Kindern", "de").join(",") === "kind", `German -ern comes off before -n (${tokenize("Kindern", "de").join(",")})`);
		assert(tokenize("Rechner", "de").join(",") === "rechn", "German -er comes off");
		assert(tokenize("Eier", "de").join(",") === "eier", `a German word whose stem would be two letters keeps its ending (${tokenize("Eier", "de").join(",")})`);

		assert(tokenize("notes", "en").join(",") === "note" && tokenize("note", "en").join(",") === "note", "English -s comes off and the two forms meet");
		assert(tokenize("stories", "en").join(",") === "story", `English -ies becomes y (${tokenize("stories", "en").join(",")})`);
		assert(tokenize("shipped", "en").join(",") === "shipp" && tokenize("running", "en").join(",") === "runn", "English -ed and -ing come off");
		assert(tokenize("goes", "en").join(",") === "goes", `an English word whose stem would fall under four characters is kept whole (${tokenize("goes", "en").join(",")})`);
		pass("ß folds to ss, and both stemmers strip only while four characters are left");
	}

	// --- 3. Stopwords, and the language guess -------------------------------
	{
		const german = tokenize("Der Vertrag mit dem Kunden ist nicht mehr offen", "de");
		assert(!german.includes("der") && !german.includes("mit") && !german.includes("nicht") && german.includes("vertrag"), `the German small change is dropped and the words are kept (${german.join(",")})`);
		const english = tokenize("The contract with the customer is not open any more", "en");
		assert(!english.includes("the") && !english.includes("with") && !english.includes("not") && english.includes("contract"), `the English small change is dropped and the words are kept (${english.join(",")})`);
		assert(guessLanguage("Der Vertrag mit dem Kunden ist nicht mehr offen") === "de", "a German sentence is read as German");
		assert(guessLanguage("The contract with the customer is not open any more") === "en", "an English sentence is read as English");
		assert(guessLanguage("Nordwind 55000") === "en", "a text with none of either language's small change falls to English");
		pass("about sixty stopwords a side come out, and the language is read off what is left");
	}

	// --- 4. The six date spellings ------------------------------------------
	{
		const spellings = ["11.07.2026", "11. Juli 2026", "11 July 2026", "July 11, 2026", "11th July 2026", "2026-07-11"];
		for (const spelling of spellings) {
			const tokens = tokenize(`Die Zahlung war am ${spelling} fällig`, "de");
			assert(tokens.includes("2026-07-11"), `"${spelling}" folds to the one day token (${tokens.join(",")})`);
		}
		assert(tokenize("11. Juli 2026", "de").includes("juli"), "the month word survives the fold, because a person who searches for Juli means it");
		assert(tokenize("2026-07-11", "de").join(",") === "2026-07-11,2026-07,2026", `a day stays one token, is never cut into its numbers, and carries its month and its year (${tokenize("2026-07-11", "de").join(",")})`);
		assert(normalizeSearchText("32.07.2026").includes("32.07.2026") && !/2026-07-32/u.test(normalizeSearchText("32.07.2026")), "a day that does not exist is left exactly as it was written");
		const dated = buildIndex([note("d-de", "Zahlungen", "2026-07-11", "Die Zahlung war am 11. Juli 2026 fällig.")]);
		assert(ids(search(dated, "11.07.2026")) === "d-de", "a question written the numeric way finds a note written the long way");
		pass("all six date spellings fold to one day token, and an impossible day is left alone");
	}

	// --- 5. Numbers, quarters, ordinals -------------------------------------
	{
		for (const spelling of ["55.000", "55,000", "55 000", "55k"]) {
			const tokens = tokenize(`Die Rechnung über ${spelling} Euro`, "de");
			assert(tokens.includes("55000"), `"${spelling}" folds to the plain number (${tokens.join(",")})`);
		}
		assert(tokenize("1.5k Euro", "de").includes("1500"), `a decimal thousand folds to its number (${tokenize("1.5k Euro", "de").join(",")})`);
		for (const spelling of ["Q3", "third quarter", "drittes Quartal", "dritten Quartal", "3. Quartal", "3rd quarter"]) {
			const tokens = tokenize(`Der Umsatz im ${spelling}`, "de");
			assert(tokens.includes("q3"), `"${spelling}" folds to the quarter token (${tokens.join(",")})`);
		}
		assert(tokenize("drittes Quartal", "de").includes("quartal"), "the quarter word survives the fold alongside the quarter token");
		assert(tokenize("the 11th of the month", "en").includes("11"), `an ordinal loses its suffix (${tokenize("the 11th of the month", "en").join(",")})`);
		assert(tokenize("55000", "en").join(",") === "55000", "a number is never stemmed");
		assert(tokenize("A1000s", "en").join(",") === "a1000s", `a token carrying digits keeps its ending where a word would lose it (${tokenize("A1000s", "en").join(",")})`);
		const money = buildIndex([note("m-de", "Zahlungen", "2026-07-01", "Die Rechnung über 55.000 Euro kam im dritten Quartal.")]);
		assert(ids(search(money, "55k")) === "m-de", "a question written 55k finds a note written 55.000");
		assert(ids(search(money, "Q3")) === "m-de", "a question written Q3 finds a note written drittes Quartal");
		pass("the four number spellings, the quarters and the ordinals fold, and digits are never stemmed");
	}

	// --- 6. The ranking, on ten documents -----------------------------------
	//
	// The corpus is written so each comparison below has exactly one difference
	// in it. "invoice" is the common word (three notes), "indemnity" the rare
	// one (a single note).
	const corpus: SearchDocument[] = [
		note("d01", "Payments", "2026-07-01", "The invoice was disputed. The invoice was corrected and the invoice was paid."),
		note("d02", "Payments", "2026-07-02", "An invoice arrived from the landlord together with the notes about the kitchen, the parking spaces, the new chairs, the printer contract and the cleaning schedule that nobody ever reads."),
		note("d03", "Office", "2026-07-03", "The invoice for the chairs."),
		note("d04", "Office", "2026-07-04", "The chairs and the desks were delivered on a rainy morning."),
		note("d05", "Hiring", "2026-07-05", "The panel agreed on the shortlist for the engineering role."),
		note("d06", "Hiring", "2026-07-06", "A second conversation was scheduled with the candidate who wrote the migration plan."),
		note("d07", "Legal", "2026-07-07", "The lease with the landlord renews in autumn and the notice period is three months.", "archive"),
		note("d08", "Legal", "2026-07-08", "The indemnity clause was rewritten before both sides signed.", "archive"),
		note("d09", "Travel", "2026-07-09", "The flight to the customer was booked and the hotel was confirmed.", "conversation"),
		note("d10", "Travel", "2026-07-10", "The trip was moved to the following week because of the rail strike.", "conversation"),
	];
	const index = buildIndex(corpus);
	{
		assert(index.size === 10, `the index knows its size (${index.size})`);
		const invoices = search(index, "invoice");
		assert(ids(invoices) === "d01,d03,d02", `three mentions beat one, and the short note beats the long one that also mentions it once (${ids(invoices)})`);
		assert(scoreOf(invoices, "d01") > scoreOf(invoices, "d03"), "repetition is what puts the first note first");
		assert(scoreOf(invoices, "d03") > scoreOf(invoices, "d02"), "between two notes that mention it once, the shorter one wins");

		const mixed = search(index, "invoice indemnity");
		const rare = scoreOf(mixed, "d08");
		assert(rare > scoreOf(mixed, "d03") && rare > scoreOf(mixed, "d02"), `the note carrying the rare word outranks the notes carrying the common one (${mixed.map((hit) => `${hit.doc.id}:${hit.score.toFixed(3)}`).join(" ")})`);
		assert(mixed[0].doc.id === "d08", `a rare word is worth more than a common one (${ids(mixed)})`);
		assert(search(index, "invoice")[0].matched.join(",") === "invoic", `a hit says which query token reached it (${search(index, "invoice")[0].matched.join(",")})`);
		assert(search(index, "invoice", { limit: 2 }).length === 2 && search(index, "invoice", { limit: undefined }).length <= 10, "the limit is honoured and defaults to ten");
		pass("BM25 ranks by repetition, by rarity and by length, in that order of visibility");
	}

	// --- 7. Prefix matching, where it is allowed ----------------------------
	{
		assert(ids(search(index, "indem")) === "d08", `a query token of five characters reaches the word it starts (${ids(search(index, "indem"))})`);
		assert(search(index, "inde").length === 0, `four characters is too little to drag a word in (${ids(search(index, "inde"))})`);
		assert(search(index, "migra")[0].doc.id === "d06", "a five-character stub reaches migration");
		assert(search(index, "migr").length === 0, "a four-character stub does not");
		pass("prefix matching starts at five characters and not at four");
	}

	// --- 8. The topic bonus --------------------------------------------------
	//
	// Two notes carrying the same words the same number of times, the same
	// length, and differing in exactly two things: one is a day newer, and the
	// other's topic is a word the question can name. Without the topic in the
	// question they score identically and the newer one leads; with it, the
	// older one is worth a tenth more and takes the lead — which is the only way
	// to see that the bonus does anything at all.
	{
		const pair = buildIndex([
			note("t-newer", "Notes", "2026-07-02", "the renewal of the lease agreed"),
			note("t-older", "Renewal", "2026-07-01", "the lease agreed with the office"),
		]);
		const plain = search(pair, "lease");
		assert(plain[0].score === plain[1].score, `the two notes score identically on the word they share (${plain.map((hit) => hit.score).join(" / ")})`);
		assert(ids(plain) === "t-newer,t-older", `with no topic named, the newer note leads (${ids(plain)})`);
		const named = search(pair, "renewal lease");
		assert(ids(named) === "t-older,t-newer", `naming the topic flips that order (${ids(named)})`);
		assert(Math.abs(scoreOf(named, "t-older") - scoreOf(named, "t-newer") * 1.1) < 1e-9, `the bonus is exactly a tenth (${scoreOf(named, "t-older")} against ${scoreOf(named, "t-newer")})`);
		pass("the topic bonus is a tenth, and a tenth is enough to flip an order");
	}

	// --- 9. The date tie-break ----------------------------------------------
	{
		const twins = buildIndex([
			note("w-b", "Twins", "2026-07-02", "the same sentence about the same thing"),
			note("w-a", "Twins", "2026-07-02", "the same sentence about the same thing"),
			note("w-old", "Twins", "2026-07-01", "the same sentence about the same thing"),
		]);
		const hits = search(twins, "sentence");
		assert(hits[0].score === hits[1].score && hits[1].score === hits[2].score, "the three notes score identically, so only the tie-break is left");
		assert(ids(hits) === "w-a,w-b,w-old", `the newer date comes first and the id settles the rest (${ids(hits)})`);
		pass("equal scores are broken by the newer date, then by the id");
	}

	// --- 10. The filters -----------------------------------------------------
	{
		assert(ids(search(index, "landlord", { filters: { sources: ["archive"] } })) === "d07", `a source filter keeps only that source (${ids(search(index, "landlord", { filters: { sources: ["archive"] } }))})`);
		assert(ids(search(index, "landlord", { filters: { sources: ["note", "archive"] } })) === "d07,d02", `two sources keep both (${ids(search(index, "landlord", { filters: { sources: ["note", "archive"] } }))})`);
		assert(search(index, "landlord", { filters: { sources: ["conversation"] } }).length === 0, "a source nothing matches returns nothing rather than everything");

		assert(ids(search(index, "invoice", { filters: { since: "2026-07-03" } })) === "d03", `since keeps the day it names (${ids(search(index, "invoice", { filters: { since: "2026-07-03" } }))})`);
		assert(ids(search(index, "invoice", { filters: { until: "2026-07-02" } })) === "d01,d02", `until keeps the day it names (${ids(search(index, "invoice", { filters: { until: "2026-07-02" } }))})`);
		assert(ids(search(index, "invoice", { filters: { since: "2026-07", until: "2026-07" } })) === "d01,d03,d02", "a month means its first and its last day, so all of July survives");
		assert(search(index, "invoice", { filters: { since: "2026-08" } }).length === 0, "a month after everything keeps nothing");

		assert(ids(search(index, "chairs", { filters: { topic: "office" } })) === "d03,d04", `a topic filter is exact and case-insensitive (${ids(search(index, "chairs", { filters: { topic: "office" } }))})`);
		assert(search(index, "chairs", { filters: { topic: "Offices" } }).length === 0, "a topic filter is exact, not a prefix");

		for (const bad of ["yesterday", "2026-13", "2026-02-30", "07/2026"]) {
			let threw = false;
			try {
				search(index, "invoice", { filters: { since: bad } });
			} catch (error) {
				threw = error instanceof Error && !!error.message;
			}
			assert(threw, `"${bad}" is not a date and has to throw rather than search a range nobody asked for`);
		}
		pass("sources, since, until and topic filter as written, and an unreadable date throws");
	}

	// --- 11. The empty query -------------------------------------------------
	{
		const listed = search(index, "", { filters: { topic: "Travel" } });
		assert(ids(listed) === "d10,d09", `an empty query with a topic reads that topic newest first (${ids(listed)})`);
		assert(listed.every((hit) => hit.score === 0 && hit.matched.length === 0), "a listing is not a ranking, so nothing is scored");
		assert(search(index, "   ", { filters: { topic: "Travel" } }).length === 2, "a query of nothing but spaces is an empty query");
		assert(search(index, "", { filters: { topic: "Travel" }, limit: 1 }).length === 1, "the listing takes the limit like any other result");
		assert(search(index, "").length === 0, "an empty query with no topic asks for nothing and gets nothing");
		assert(search(index, "the and with", { filters: { topic: "Travel" } }).length === 2, "a query of nothing but stopwords is an empty query too");
		pass("an empty query with a topic is a request to read that topic, newest first");
	}

	// --- 12. Dates, as the filters read them --------------------------------
	{
		assert(JSON.stringify(parseSearchDate("2026-07")) === JSON.stringify({ from: "2026-07-01", to: "2026-07-31" }), "a month is the span from its first day to its last");
		assert(JSON.stringify(parseSearchDate("2026-02")) === JSON.stringify({ from: "2026-02-01", to: "2026-02-28" }), "February knows how long it is");
		assert(JSON.stringify(parseSearchDate("2028-02")) === JSON.stringify({ from: "2028-02-01", to: "2028-02-29" }), "and how long it is in a leap year");
		assert(JSON.stringify(parseSearchDate("2026-07-11")) === JSON.stringify({ from: "2026-07-11", to: "2026-07-11" }), "a day is a span of one");
		assert(JSON.stringify(parseSearchDate("11. Juli 2026")) === JSON.stringify({ from: "2026-07-11", to: "2026-07-11" }), "a spelling the notes are searched with is a spelling a filter may use");
		for (const bad of ["", "yesterday", "2026-13", "2026-00", "2026-02-30", "last month"]) assert(parseSearchDate(bad) === null, `"${bad}" is not a date`);
		pass("a filter date is the span it names, and nothing else is a date");
	}

	// --- 13. German words that end in a letter the stemmer wants ------------
	//
	// The German endings are letters ordinary words end in anyway. A stemmer
	// that takes them off wherever it finds them turns "Preis" into "prei" and
	// "Daten" into "date" — the first stops meeting its own plural, the second
	// walks straight into an English word. So a single-letter ending has to
	// leave more behind than a longer one does, and the -s comes off only after
	// the consonants a German -s actually follows.
	{
		assert(tokenize("Preis", "de").join(",") === "preis" && tokenize("Preise", "de").join(",") === "preis", `Preis and Preise meet (${tokenize("Preis", "de").join(",")} / ${tokenize("Preise", "de").join(",")})`);
		assert(tokenize("Preisen", "de").join(",") === "preis", `and so does the dative plural (${tokenize("Preisen", "de").join(",")})`);
		const prices = buildIndex([note("g-preise", "Angebote", "2026-07-01", "Die Preise wurden im Juni angepasst.")]);
		assert(ids(search(prices, "Preis")) === "g-preise", "a question about the Preis reaches a note about the Preise");

		assert(tokenize("Status", "de").join(",") === "status", `Status keeps the s that belongs to it (${tokenize("Status", "de").join(",")})`);
		assert(tokenize("Bus", "de").join(",") === "bus" && tokenize("Kurs", "de").join(",") === "kurs", `and so do Bus and Kurs (${tokenize("Bus", "de").join(",")} / ${tokenize("Kurs", "de").join(",")})`);
		assert(tokenize("Ergebnis", "de").join(",") === "ergebnis", `Ergebnis keeps its s too (${tokenize("Ergebnis", "de").join(",")})`);
		const results = buildIndex([note("g-erg", "Projekt", "2026-07-01", "Die Ergebnisse der Messung liegen vor.")]);
		assert(ids(search(results, "Ergebnis")) === "g-erg", "a question about the Ergebnis reaches a note about the Ergebnisse, through the prefix if not through the stem");

		assert(tokenize("Termin", "de").join(",") === "termin" && tokenize("Termine", "de").join(",") === "termin", `Termin and Termine meet, because that n is part of the word (${tokenize("Termin", "de").join(",")} / ${tokenize("Termine", "de").join(",")})`);
		assert(tokenize("Aktion", "de").join(",") === "aktion" && tokenize("Aktionen", "de").join(",") === "aktion", `and so do Aktion and Aktionen (${tokenize("Aktion", "de").join(",")} / ${tokenize("Aktionen", "de").join(",")})`);

		assert(tokenize("Daten", "de").join(",") === "daten", `Daten stays Daten (${tokenize("Daten", "de").join(",")})`);
		assert(tokenize("Daten", "de")[0] !== tokenize("dates", "en")[0], `and so never lands on the English date (${tokenize("Daten", "de")[0]} against ${tokenize("dates", "en")[0]})`);
		// What that costs, stated rather than hidden: "Ideen" has the shape of
		// "Daten" and nothing in the spelling tells them apart, so the rule that
		// stops Daten becoming the English date also stops Ideen reaching Idee.
		// A wrong match across two languages is the worse of the two failures.
		assert(tokenize("Ideen", "de").join(",") === "ideen" && tokenize("Idee", "de").join(",") === "idee", `the price of that rule: Ideen and Idee do not meet (${tokenize("Ideen", "de").join(",")} / ${tokenize("Idee", "de").join(",")})`);

		// The pairs the reviewer held: a longer ending still comes off at four.
		assert(tokenize("Kunde", "de").join(",") === "kund" && tokenize("Kunden", "de").join(",") === "kund", `Kunde and Kunden still meet (${tokenize("Kunde", "de").join(",")} / ${tokenize("Kunden", "de").join(",")})`);
		assert(tokenize("Woche", "de").join(",") === "woch" && tokenize("Wochen", "de").join(",") === "woch", "Woche and Wochen still meet");
		assert(tokenize("Rechnung", "de").join(",") === "rechnung" && tokenize("Rechnungen", "de").join(",") === "rechnung", "Rechnung and Rechnungen still meet");
		assert(tokenize("Haus", "de").join(",") === "haus" && tokenize("Hauses", "de").join(",") === "haus" && tokenize("Häuser", "de").join(",") === "haeus,haus", `Haus, Hauses and Häuser still meet (${tokenize("Häuser", "de").join(",")})`);
		assert(tokenize("Vertrag", "de").join(",") === "vertrag" && tokenize("Vertrags", "de").join(",") === "vertrag", `a genitive s after a consonant that takes one still comes off (${tokenize("Vertrags", "de").join(",")})`);
		assert(tokenize("Überweisung", "de").join(",") === "ueberweisung,uberweisung" && tokenize("Überweisungen", "de").join(",") === "ueberweisung,uberweisung", "the umlaut pair still meets across singular and plural");
		pass("a single-letter German ending leaves five characters behind, and -s and -n only come off where a German -s and -n go");
	}

	// --- 14. A date is also its month and its year --------------------------
	//
	// A note dated the eleventh of July answers a question about July, and a
	// question about 2026. Every spelling therefore folds to three tokens, not
	// one: the day, the month it is in, and the year. A month name standing next
	// to a year is the same month token without a day, so "Juli 2026" and
	// "July 2026" are the same question asked twice — and "Juli" on its own is
	// still just a word.
	{
		const days = buildIndex([
			note("s-dotted", "Zahlungen", "2026-07-11", "Die Zahlung ging am 11.07.2026 raus."),
			note("s-iso", "Zahlungen", "2026-07-11", "Die Zahlung ging am 2026-07-11 raus."),
			note("s-de", "Zahlungen", "2026-07-11", "Die Zahlung ging am 11. Juli 2026 raus."),
			note("s-en", "Payments", "2026-07-11", "The payment went out on July 11, 2026."),
		]);
		for (const question of ["2026-07", "Juli 2026", "July 2026", "2026"]) {
			const found = search(days, question).map((hit) => hit.doc.id).sort().join(",");
			assert(found === "s-de,s-dotted,s-en,s-iso", `"${question}" reaches all four spellings of the same day (${found})`);
		}
		assert(tokenize("11.07.2026", "de").join(",") === "2026-07-11,2026-07,2026", `a numeric day carries its month and its year (${tokenize("11.07.2026", "de").join(",")})`);
		assert(tokenize("11. Juli 2026", "de").join(",") === "2026-07-11,2026-07,2026,juli", `a worded day carries them and keeps its month word (${tokenize("11. Juli 2026", "de").join(",")})`);
		assert(tokenize("Juli 2026", "de").join(",") === "2026-07,2026,juli", `a month beside a year is the month token without a day (${tokenize("Juli 2026", "de").join(",")})`);
		assert(tokenize("Juli", "de").join(",") === "juli", `a month name on its own is still just a word (${tokenize("Juli", "de").join(",")})`);
		assert(ids(search(days, "Juli")) !== "", "and a question that is only that word still reaches the notes that carry it");
		assert(tokenize("2026-07", "de").join(",") === "2026-07,2026", `a month written the short way carries its year (${tokenize("2026-07", "de").join(",")})`);
		assert(JSON.stringify(parseSearchDate("2026-07")) === JSON.stringify({ from: "2026-07-01", to: "2026-07-31" }) && parseSearchDate("Juli 2026") === null, "reading a date for a filter is unchanged: a month is a span, and a month without a day is not a date");
		pass("every date spelling folds to its day, its month and its year, and a month beside a year is a month");
	}

	// --- 15. The note nobody dated ------------------------------------------
	//
	// A note that predates the day being written down has no date at all. A
	// range filter cannot honestly say it falls outside a range it has no
	// position in, so only the notes that are provably outside are dropped. It
	// sorts last among equals, because "unknown" is not "newest".
	{
		const undated = buildIndex([
			note("n-dated", "Notes", "2026-07-02", "the same sentence about the same thing"),
			note("n-none", "Notes", "", "the same sentence about the same thing"),
		]);
		assert(ids(search(undated, "sentence", { filters: { since: "2026-07-01" } })) === "n-dated,n-none", `an undated note survives a since filter (${ids(search(undated, "sentence", { filters: { since: "2026-07-01" } }))})`);
		assert(ids(search(undated, "sentence", { filters: { until: "2026-07-31" } })) === "n-dated,n-none", "and an until filter");
		assert(ids(search(undated, "sentence", { filters: { since: "2026-08-01" } })) === "n-none", "the dated note outside the range goes, the undated one stays");
		const hits = search(undated, "sentence");
		assert(hits[0].score === hits[1].score, "the two notes score identically, so only the tie-break is left");
		assert(ids(hits) === "n-dated,n-none", `a note with no date sorts after one that has a date (${ids(hits)})`);
		assert(ids(search(undated, "", { filters: { topic: "Notes" } })) === "n-dated,n-none", "and it sorts last in a topic listing too");
		pass("a note with no date is included by a range it cannot be outside of, and sorts last among equals");
	}

	// --- 16. The size it has to stay fast at --------------------------------
	//
	// Ten thousand notes of about forty words, built from a seeded pool so the
	// corpus is the same one every time this runs. The targets are a few hundred
	// milliseconds to build and 20 ms to answer; the ceilings asserted here are
	// looser, because a smoke that fails when another process took the core is a
	// smoke people learn to ignore. The measured numbers are printed either way.
	{
		let seed = 20260916;
		const random = (): number => {
			seed = (seed * 1103515245 + 12345) % 2147483648;
			return seed / 2147483648;
		};
		const syllables = ["ba", "ko", "ru", "mel", "tan", "sil", "dor", "fen", "gri", "hum", "lav", "nep", "qua", "ros", "tup", "vin", "wex", "zal"];
		const pool: string[] = [];
		while (pool.length < 900) {
			let word = "";
			const parts = 2 + Math.floor(random() * 2);
			for (let part = 0; part < parts; part += 1) word += syllables[Math.floor(random() * syllables.length)];
			if (!pool.includes(word)) pool.push(word);
		}
		// Every note carries a date, a thousands number and a quarter, because a
		// note that carries none of them never pays for the folding and would
		// measure a normaliser this product does not have.
		const many: SearchDocument[] = [];
		for (let position = 0; position < 10_000; position += 1) {
			const words: string[] = [];
			for (let word = 0; word < 40; word += 1) words.push(pool[Math.floor(random() * pool.length)]);
			words[5] = "11.07.2026";
			words[20] = "55.000";
			words[30] = "im dritten Quartal";
			many.push(note(`p${position}`, `topic${position % 50}`, "2026-07-01", words.join(" ")));
		}

		const buildStarted = performance.now();
		const big = buildIndex(many);
		const buildMs = performance.now() - buildStarted;
		const queryStarted = performance.now();
		const hits = search(big, `${pool[3]} ${pool[400]} ${pool[800]}`);
		const queryMs = performance.now() - queryStarted;
		const filteredStarted = performance.now();
		const filtered = search(big, `${pool[3]} ${pool[400]}`, { filters: { topic: "topic7", since: "2026-07" } });
		const filteredMs = performance.now() - filteredStarted;

		assert(big.size === 10_000, `the big index holds every document (${big.size})`);
		assert(hits.length === 10, `a query over ten thousand notes still answers with a page of results (${hits.length})`);
		assert(filtered.every((hit) => hit.doc.topic === "topic7"), "the filters hold at that size too");
		assert(buildMs < 1000, `building ten thousand notes took ${buildMs.toFixed(0)} ms, which is far past the few hundred milliseconds this is built for`);
		assert(queryMs < 100 && filteredMs < 100, `a query took ${queryMs.toFixed(1)} ms and a filtered one ${filteredMs.toFixed(1)} ms, far past the 20 ms this is built for`);
		pass(`ten thousand notes of forty words: ${buildMs.toFixed(0)} ms to build, ${queryMs.toFixed(1)} ms to answer, ${filteredMs.toFixed(1)} ms filtered`);
	}

	console.log(`memory-search-index-smoke: ${passes} checks passed`);
} catch (error) {
	console.error(error instanceof Error ? error.stack || error.message : error);
	process.exitCode = 1;
}
