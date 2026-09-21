export {};

// Duplicates told apart from conflicts, proved on the pairs the spec names.
// Pure: no room, no HOME, no network, no writes anywhere. Everything is
// imported from the real module, never an inline copy.
//
// What is pinned down:
//   - the classification table: equal text, the nine-word pair at Jaccard
//     0.80, the short shape under the twin test's floor, one value group
//     against two, a three-word date as one group, German months and their
//     abbreviations, a negation in both languages, a digit inside a word, a
//     moved event, an open item whose deadline moved, and the decoy;
//   - the value words as one printed list, and the value tokens of a German
//     and an English sentence;
//   - the changed values in the person's own spelling, a missing group as "";
//   - the reason and the two sentences, decided and undecided, one topic and
//     two, in both languages;
//   - the document walk: same section only, every kind, document order, the
//     newer member by updated then saved, equal days undecided, thirty at most;
//   - what memory says twice no longer lists a conflict pair.
//
// Red first, against the tip before this work: the very first check fails
// there because `findDuplicateNotePairs` returns the nine-word conflict pair
// under "says twice", and the export checks right after it fail because the
// module has none of `classifyNotePair`, `noteValueTokens`, `NOTE_VALUE_WORDS`,
// `findConflictingNotePairs`, `conflictValuePairs`, `conflictReason`,
// `conflictNoteSentence` and `conflictPromptLine`; the smoke stops after the
// export checks so the red run still ends with its count line.

import type { MemoryDocument, MemoryEntry } from "../src/memory-entries.js";
import type { ConflictNotePair } from "../src/memory-duplicates.js";

const { parseMemoryDocument } = await import("../src/memory-entries.js");
const duplicates = await import("../src/memory-duplicates.js");
const { findDuplicateNotePairs } = duplicates;

let passed = 0;
let failed = 0;
function check(name: string, condition: unknown): void {
	if (condition) {
		passed++;
	} else {
		failed++;
		console.error(`FAIL: ${name}`);
	}
}

function finish(): never {
	console.log(`memory-duplicates-smoke: ${passed}/${passed + failed} checks passed`);
	process.exit(failed > 0 ? 1 : 0);
}

const TODAY = "2026-09-16";

interface Note {
	id: string;
	kind?: MemoryEntry["kind"];
	saved?: string;
	updated?: string;
	status?: "open" | "done";
	text: string;
}

interface Topic {
	title: string;
	notes: Note[];
}

function meta(note: Note): string {
	const fields = [`id=${note.id}`, `kind=${note.kind ?? "fact"}`, `saved=${note.saved ?? "2026-01-01"}`];
	if (note.status) fields.push(`status=${note.status}`);
	if (note.updated) fields.push(`updated=${note.updated}`);
	return `<!-- e: ${fields.join(" ")} -->`;
}

/** A storage-format document: the Deep Memory topics in order, the items under Active Items. */
function docOf(topics: Topic[], items: Note[] = []): MemoryDocument {
	const block = (note: Note) => `${meta(note)}\n${note.text}\n`;
	const text = [
		"<!-- exxeta:l1b schema_version=1 -->",
		"",
		"## Chronos",
		"",
		"- Persistent agent id: duplicates-smoke",
		"",
		"## Deep Memory",
		"",
		"<!-- entries: next=1000 -->",
		"",
		...topics.flatMap((topic) => [`### ${topic.title}`, "", topic.notes.map(block).join("\n")]),
		"## Active Items",
		"",
		items.map(block).join("\n"),
		"## Recent Context",
		"",
		"### RC-0001 | OPEN | 2026-01-01 | Nothing to see",
		"",
	].join("\n");
	return parseMemoryDocument(text);
}

const NINE_JUNE = "- The Nordwind maintenance contract renews automatically on 1 June.";
const NINE_JULY = "- The Nordwind maintenance contract renews automatically on 1 July.";
const NOTICE = "- The renewal notice must go out six weeks ahead of the date.";

// --- 1. What memory says twice lists duplicates only (red first) --------------

{
	const doc = docOf([
		{ title: "The Nordwind contract", notes: [{ id: "m-0101", saved: "2026-06-02", text: NINE_JUNE }, { id: "m-0102", saved: "2026-06-02", text: NOTICE }] },
		{ title: "Renewals", notes: [{ id: "m-0301", saved: "2026-09-14", text: NINE_JULY }, { id: "m-0302", saved: "2026-09-14", text: NOTICE }] },
	]);
	const pairs = findDuplicateNotePairs(doc);
	check(`the nine-word conflict pair "${NINE_JUNE}" / "${NINE_JULY}" is not under says-twice while the true twin pair still is, got ${pairs.map((p) => `${p.a.id}+${p.b.id}`).join(" ")}`, pairs.length === 1 && pairs[0].a.id === "m-0102" && pairs[0].b.id === "m-0302");
}

// --- 2. The exports exist (red first) -------------------------------------------

{
	const names = ["classifyNotePair", "noteValueTokens", "findConflictingNotePairs", "conflictValuePairs", "conflictReason", "conflictNoteSentence", "conflictPromptLine"] as const;
	let missing = false;
	for (const name of names) {
		const present = typeof (duplicates as Record<string, unknown>)[name] === "function";
		check(`${name} is exported`, present);
		if (!present) missing = true;
	}
	const listed = Array.isArray(duplicates.NOTE_VALUE_WORDS) && duplicates.NOTE_VALUE_WORDS.length > 0;
	check("NOTE_VALUE_WORDS is exported as a list", listed);
	check("CONFLICT_NOTE_PAIRS_MAX is thirty", duplicates.CONFLICT_NOTE_PAIRS_MAX === 30);
	if (missing || !listed) finish();
}

const { NOTE_VALUE_WORDS, classifyNotePair, conflictNoteSentence, conflictPromptLine, conflictReason, conflictValuePairs, findConflictingNotePairs, findNotePairs, noteValueTokens } = duplicates;

// --- 3. The classification table ------------------------------------------------

function classified(a: string, b: string, expected: "duplicate" | "conflict" | "different", why: string): void {
	const got = classifyNotePair(a, b);
	check(`"${a}" / "${b}" is ${expected} (${why}), got ${got}`, got === expected);
	const back = classifyNotePair(b, a);
	check(`"${b}" / "${a}" is ${expected} the other way round, got ${back}`, back === expected);
}

classified(NINE_JUNE, NINE_JUNE, "duplicate", "equal text");
classified(NINE_JUNE, "The Nordwind maintenance contract renews automatically on 1 June (saved 2026-06-02)", "duplicate", "equal once the marks are gone");
classified(NINE_JUNE, NINE_JULY, "conflict", "nine words, eight shared, Jaccard exactly 0.80, the date differs");
classified("The Nordwind maintenance contract renews automatically on 1 June", "The Nordwind maintenance contract automatically renews on 1 June", "duplicate", "alike, same values in another order");
classified("Nordwind contract renews on 1 June", "Nordwind contract renews on 1 July", "conflict", "the short shape under the twin test");
classified("Sprint 12 review on 3 May", "Sprint 12 review on 2 June", "conflict", "one value group, the date, differs");
classified("Sprint 14 review on 3 May", "Sprint 15 review on 17 May", "different", "two groups differ, the sprint and the date");
classified("Sprint 12 review on 3 May", "Sprint 13 review on 3 May", "different", "the sprint number opens the note and is its name, so two sprints on one day are two things");
classified("Ticket 4711 is about the login page of the customer portal", "Ticket 4712 is about the login page of the customer portal", "different", "a ticket number is a name, even on a long pair the twin test calls alike");
classified("Rechnung 2026-117 an Nordwind ist bezahlt", "Rechnung 2026-118 an Nordwind ist bezahlt", "different", "an invoice number of two digit runs is one name group");
classified("4711: login page of the customer portal is slow", "4712: login page of the customer portal is slow", "different", "a number that opens the note is its name");
classified("Budget for the pilot is 55,000 EUR", "Budget for the pilot is 60,000 EUR", "conflict", "a number deep in the note is a value");
classified("3 May: kickoff with Nordwind", "4 June: kickoff with Nordwind", "conflict", "a date that opens the note is a value because it carries a month");
classified("12 dormant accounts were found", "19 dormant accounts were found", "different", "a count that opens a note reads as a name: the price of the name rule");
classified("Der Vertrag verlängert sich am 1.6.2026", "Der Vertrag verlängert sich am 01.06.2026", "duplicate", "leading zeros are not a difference");
classified("The review is on 01 June", "The review is on 1 June", "duplicate", "a zero-padded day is the same day");
classified("Der Vertrag verlängert sich am 1. Juni 2026", "Der Vertrag verlängert sich am 2026-06-01", "conflict", "an ISO date against a month name is the known false pair");
classified("Sprint kickoff on 3 May 2026", "Sprint kickoff on 4 June 2026", "conflict", "a three-token date is one group");
classified("Sprint Kickoff am 3. Mai 2026", "Sprint Kickoff am 4. Juni 2026", "conflict", "a three-token German date is one group");
classified("Kickoff on 3 May 2026", "Kickoff on 4 June 2026", "different", "two plain words around the date are under the floor of three");
classified("Invoices may go out monthly", "Invoices go out monthly", "different", "the verb may is not the month");
classified("The payment is due in May", "The payment is due in June", "conflict", "may at the end of a note is the month");
classified("Sprint review on 3 May", "Sprint review on 3 June", "conflict", "may beside a day is the month");
classified("Die Wartung läuft im März aus", "Die Wartung läuft im Juli aus", "conflict", "German month names carry a value");
classified("Die Wartung läuft im Mär aus", "Die Wartung läuft im Sept aus", "conflict", "German abbreviations carry a value");
classified("The contract is renewed", "The contract is not renewed", "conflict", "a negation is a value group of its own");
classified("Der Vertrag wird verlängert", "Der Vertrag wird nicht verlängert", "conflict", "a German negation is a value group of its own");
classified("Revenue target holds for Q3", "Revenue target holds for Q4", "conflict", "a digit inside a word is a value");
classified("The gateway context limit is 16k", "The gateway context limit is 32k", "conflict", "a number with a unit letter is a value");
classified("Sprint 12 review with the client on 3 May", "Sprint 12 review with the client on 2 June", "conflict", "a moved event is text only");
classified("Send the Nordwind offer by 3 May", "Send the Nordwind offer by 10 May", "conflict", "an open item whose deadline moved is text only");
classified("Due 3 May", "Due 4 May", "different", "the plain words around the value are too few");
classified("Invoices go out monthly", "Invoices go out weekly", "different", "no value differs, two points");
classified("Budget is 55.000 for the year", "Budget is 55,000 for the year", "duplicate", "one number in two spellings normalises alike");
classified("", "", "different", "two empty notes say nothing");
classified("", "Nordwind contract renews on 1 June", "different", "an empty note says nothing");
classified("Budget is 45,000 and renews on 1 June", "Budget is 55,000 and renews on 1 July", "different", "two groups differ under the twin test");
classified("Meeting Monday", "Meeting Friday", "different", "the plain words around the weekday are too few");
classified("Team meeting on Monday", "Team meeting on Friday", "conflict", "three plain words around the weekday are enough");
classified("The weekly meeting is on Monday", "The weekly meeting is on Friday", "conflict", "weekday names carry a value");
classified("Das Treffen findet montags nicht statt", "Das Treffen findet montags statt", "conflict", "a German negation removed is one group missing");

// --- 4. The value words, printed once, and the value tokens of a sentence -------

console.log(`value words (${NOTE_VALUE_WORDS.length}): ${NOTE_VALUE_WORDS.join(" ")}`);
check("the value words hold the German months and abbreviations", ["januar", "märz", "dezember", "mär", "mrz", "sept", "dez", "okt"].every((w) => NOTE_VALUE_WORDS.includes(w)));
check("the value words hold the English months and abbreviations", ["january", "march", "may", "december", "mar", "sept", "dec", "oct"].every((w) => NOTE_VALUE_WORDS.includes(w)));
check("the value words hold the weekdays in both languages", ["montag", "sonnabend", "sonntag", "monday", "sunday"].every((w) => NOTE_VALUE_WORDS.includes(w)));
check("the value words hold the negations in both languages", ["nicht", "kein", "keine", "keinen", "keiner", "nie", "niemals", "not", "no", "never", "none", "without", "ohne"].every((w) => NOTE_VALUE_WORDS.includes(w)));
check("the value words are lowercase and listed once each", NOTE_VALUE_WORDS.every((w) => w === w.toLowerCase()) && new Set(NOTE_VALUE_WORDS).size === NOTE_VALUE_WORDS.length);
check("a digit is a rule, not a list entry", !NOTE_VALUE_WORDS.some((w) => /\d/.test(w)));

{
	const german = noteValueTokens("- Am Montag, 1.6.2026, kostet die Wartung 55.000 Euro, nicht 45.000, und läuft im Sept aus.");
	check(`German value tokens in note order, got ${german.join(" ")}`, german.join(" ") === "montag 1 6 2026 55 000 nicht 45 000 sept");
	const english = noteValueTokens("- On Monday 3 May 2026 the budget is 55,000 and not 16k; Q3 stays without a review.");
	check(`English value tokens in note order, got ${english.join(" ")}`, english.join(" ") === "monday 3 may 2026 55 000 not 16k q3 without");
	check("a note without a value has no tokens", noteValueTokens("Invoices go out monthly").length === 0);
	check("the marks are stripped before the tokens are read", noteValueTokens("- **must-keep** Renews on 1 June (saved 2026-06-02) [m-0031]").join(" ") === "1 june");
}

// --- 5. The changed values in the person's own spelling ------------------------

{
	const pairs = conflictValuePairs("- The budget is 45.000 for 1.6.2026.", "- The budget is 55,000 for 3 May 2026.");
	check(`the spelling is the note's own, got ${JSON.stringify(pairs)}`, JSON.stringify(pairs) === JSON.stringify([{ older: "45.000", newer: "55,000" }, { older: "1.6.2026", newer: "3 May 2026" }]));
	check("a missing group reads as empty on its side", JSON.stringify(conflictValuePairs("The contract is renewed", "The contract is not renewed")) === JSON.stringify([{ older: "", newer: "not" }]));
	check("a group that left reads as empty on the newer side", JSON.stringify(conflictValuePairs("Der Vertrag wird nicht verlängert", "Der Vertrag wird verlängert")) === JSON.stringify([{ older: "nicht", newer: "" }]));
	check("a note that ends in a value is quoted without its full stop", JSON.stringify(conflictValuePairs(NINE_JUNE, NINE_JULY)) === JSON.stringify([{ older: "1 June", newer: "1 July" }]));
	check("a negation next to a date is its own group and quoted with it", JSON.stringify(conflictValuePairs("Renews on 1 June", "Renews not on 1 June")) === JSON.stringify([{ older: "", newer: "not" }]));
	check("equal notes have no changed value", conflictValuePairs(NINE_JUNE, NINE_JUNE).length === 0);
	const many = conflictValuePairs("Values 1 and 2 and 3 and 4 and 5", "Values 6 and 7 and 8 and 9 and 10");
	check(`at most three pairs, got ${many.length}`, many.length === 3 && many[0].older === "1" && many[2].newer === "8");
	const shifted = conflictValuePairs("The Nordwind maintenance contract renews automatically on 1 June", "The Nordwind maintenance contract now renews automatically on 1 July");
	check(`a long pair whose plain words differ aligns its values by order, got ${JSON.stringify(shifted)}`, JSON.stringify(shifted) === JSON.stringify([{ older: "1 June", newer: "1 July" }]));
	check("a German date keeps its dots", conflictValuePairs("Sprint Kickoff am 3. Mai 2026", "Sprint Kickoff am 4. Juni 2026")[0].newer === "4. Juni 2026");
}

// --- 6. The reason on the card ---------------------------------------------------

{
	check("the reason names the changed value with both days", conflictReason(NINE_JUNE, NINE_JULY, "2026-06-02", "2026-09-14", TODAY) === "1 July (saved 14 Sep) replaces 1 June (saved 2 Jun); the newer date decides");
	check("several changed values are joined by commas", conflictReason("Budget is 45,000 and renews on 1 June", "Budget is 55,000 and renews on 1 July", "2026-06-02", "2026-09-14", TODAY) === "55,000, 1 July (saved 14 Sep) replaces 45,000, 1 June (saved 2 Jun); the newer date decides");
	check("equal days say both saved", conflictReason(NINE_JUNE, NINE_JULY, "2026-09-14", "2026-09-14", TODAY) === "1 July replaces 1 June (both saved 14 Sep)");
check("a conversation older than the note it replaces says the fold order decided, not a date", conflictReason(NINE_JUNE, NINE_JULY, "2026-09-14", "2026-09-12", TODAY) === "1 July replaces 1 June (saved 14 Sep); the conversation of 12 Sep was folded after it");
	check("a day in another year names the year", conflictReason(NINE_JUNE, NINE_JULY, "2025-06-02", "2026-09-14", TODAY) === "1 July (saved 14 Sep) replaces 1 June (saved 2 Jun 2025); the newer date decides");
	check("a German reason keeps the German spelling", conflictReason("- Die Wartung läuft am 3. Mai 2026 aus.", "- Die Wartung läuft am 4. Juni 2026 aus.", "2026-06-02", "2026-09-14", TODAY) === "4. Juni 2026 (saved 14 Sep) replaces 3. Mai 2026 (saved 2 Jun); the newer date decides");
	check("a negation that arrived replaces nothing", conflictReason("Der Vertrag wird verlängert", "Der Vertrag wird nicht verlängert", "2026-06-02", "2026-09-14", TODAY) === "nicht (saved 14 Sep) replaces nothing (saved 2 Jun); the newer date decides");
	check("today defaults to the local day", typeof conflictReason(NINE_JUNE, NINE_JULY, "2026-06-02", "2026-09-14") === "string");
}

// --- 7. The sentences a person and the prompt read -------------------------------

function pairOf(a: Partial<ConflictNotePair["a"]>, b: Partial<ConflictNotePair["b"]>, newer: ConflictNotePair["newer"]): ConflictNotePair {
	return {
		a: { id: "m-0101", topic: "The Nordwind contract", section: "Deep Memory", text: NINE_JUNE, date: "2026-06-02", ...a },
		b: { id: "m-0301", topic: "The Nordwind contract", section: "Deep Memory", text: NINE_JULY, date: "2026-09-14", ...b },
		newer,
	};
}

{
	check("one topic disagrees with itself, older first", conflictNoteSentence(pairOf({}, {}, "b"), TODAY) === `"The Nordwind contract" disagrees with itself: 1 June (saved 2 Jun) or 1 July (saved 14 Sep)`);
	check("two topics disagree, the older topic first", conflictNoteSentence(pairOf({}, { topic: "Renewals" }, "b"), TODAY) === `"The Nordwind contract" and "Renewals" disagree: 1 June (saved 2 Jun) or 1 July (saved 14 Sep)`);
	check("when the first member is newer the older still comes first", conflictNoteSentence(pairOf({ text: NINE_JULY, date: "2026-09-14" }, { topic: "Renewals", text: NINE_JUNE, date: "2026-06-02" }, "a"), TODAY) === `"Renewals" and "The Nordwind contract" disagree: 1 June (saved 2 Jun) or 1 July (saved 14 Sep)`);
	check("an undecided pair says both saved, in document order", conflictNoteSentence(pairOf({ date: "2026-09-14" }, {}, null), TODAY) === `"The Nordwind contract" disagrees with itself: 1 June or 1 July, both saved 14 Sep`);
	check("a German pair reads its own spelling", conflictNoteSentence(pairOf({ text: "- Die Wartung läuft im März aus." }, { text: "- Die Wartung läuft im Juli aus." }, "b"), TODAY) === `"The Nordwind contract" disagrees with itself: März (saved 2 Jun) or Juli (saved 14 Sep)`);
	check("the prompt line quotes both notes with their days and the rule", conflictPromptLine(pairOf({}, {}, "b"), TODAY) === `m-0101 (saved 2 Jun) says "The Nordwind maintenance contract renews automatically on 1 June."; m-0301 (saved 14 Sep) says "The Nordwind maintenance contract renews automatically on 1 July.": the newer date decides; merge them keeping the newer text, or say in the narrative why both stay`);
	check("the prompt line puts the older note first whichever member it is", conflictPromptLine(pairOf({ id: "m-0301", text: NINE_JULY, date: "2026-09-14" }, { id: "m-0101", text: NINE_JUNE, date: "2026-06-02" }, "a"), TODAY).startsWith(`m-0101 (saved 2 Jun) says`));
	check("the undecided prompt line says both saved and leaves the choice to the conversation", conflictPromptLine(pairOf({ date: "2026-09-14" }, {}, null), TODAY) === `m-0101 says "The Nordwind maintenance contract renews automatically on 1 June."; m-0301 says "The Nordwind maintenance contract renews automatically on 1 July.": both saved 14 Sep; keep the one the conversation confirms, or both`);
	check("the prompt line strips the marks and cuts a long line", conflictPromptLine(pairOf({ text: `- **must-keep** ${"word ".repeat(40)}renews on 1 June` }, {}, "b"), TODAY).includes(`says "word word`) && !conflictPromptLine(pairOf({ text: `- **must-keep** ${"word ".repeat(40)}renews on 1 June` }, {}, "b"), TODAY).includes("must-keep"));
}

// --- 8. The document walk ---------------------------------------------------------

{
	const doc = docOf(
		[
			{
				title: "The Nordwind contract",
				notes: [
					{ id: "m-0101", saved: "2026-06-02", text: NINE_JUNE },
					{ id: "m-0102", kind: "event", saved: "2026-04-01", text: "- Sprint 12 review on 3 May." },
					{ id: "m-0103", saved: "2026-01-01", updated: "2026-09-14", text: "- Der Vertrag wird nicht verlängert." },
					{ id: "m-0104", saved: "2026-06-02", text: NOTICE },
				],
			},
			{
				title: "Renewals",
				notes: [
					{ id: "m-0301", saved: "2026-09-14", text: NINE_JULY },
					{ id: "m-0302", kind: "event", saved: "2026-05-20", text: "- Sprint 12 review on 2 June." },
					{ id: "m-0303", saved: "2026-06-02", text: "- Der Vertrag wird verlängert." },
					{ id: "m-0304", saved: "2026-06-02", text: NOTICE },
					{ id: "m-0305", kind: "event", saved: "2026-04-01", text: "- Sprint 14 review on 3 June." },
					{ id: "m-0306", kind: "event", saved: "2026-04-01", text: "- Sprint 15 review on 17 May." },
					{ id: "m-0307", saved: "2026-06-02", text: "- Send the Nordwind offer by 20 May." },
				],
			},
		],
		[
			{ id: "m-0501", kind: "item", status: "open", saved: "2026-04-01", text: "- Send the Nordwind offer by 3 May." },
			{ id: "m-0502", kind: "item", status: "open", saved: "2026-04-01", text: "- Send the Nordwind offer by 10 May." },
		],
	);
	const pairs = findConflictingNotePairs(doc);
	const listed = pairs.map((p) => `${p.a.id}+${p.b.id}:${p.newer ?? "-"}`).join(" ");
	check(`the pairs come in document order of the first member, got ${listed}`, listed === "m-0101+m-0301:b m-0102+m-0302:b m-0103+m-0303:a m-0501+m-0502:-");
	check("a fact pair names the newer by saved", pairs[0]?.newer === "b" && pairs[0].b.date === "2026-09-14" && pairs[0].a.date === "2026-06-02");
	check("an event pair is paired like a fact", pairs[1]?.a.id === "m-0102" && pairs[1].b.id === "m-0302");
	check("updated beats saved when naming the newer", pairs[2]?.newer === "a" && pairs[2].a.date === "2026-09-14");
	check("an open item pair is paired, and equal days are undecided", pairs[3]?.newer === null && pairs[3].a.section === "Active Items");
	check("a Deep Memory note and an Active Items note are never paired", !pairs.some((p) => p.a.id === "m-0307" || p.b.id === "m-0307"));
	check("the decoy of two sprints on two dates is not a pair", !pairs.some((p) => p.a.id === "m-0305" && p.b.id === "m-0306"));
	check("a true twin pair is not a conflict", !pairs.some((p) => p.a.id === "m-0104"));
	check("the pair carries topic, section and text", pairs[0]?.a.topic === "The Nordwind contract" && pairs[0].b.topic === "Renewals" && pairs[0].a.section === "Deep Memory" && pairs[0].a.text === NINE_JUNE);
	const twice = findDuplicateNotePairs(doc);
	check(`what memory says twice lists the twin pair only, got ${twice.map((p) => `${p.a.id}+${p.b.id}`).join(" ")}`, twice.length === 1 && twice[0].a.id === "m-0104" && twice[0].b.id === "m-0304");
	check("the sentences read the document's pairs", conflictNoteSentence(pairs[0], TODAY) === `"The Nordwind contract" and "Renewals" disagree: 1 June (saved 2 Jun) or 1 July (saved 14 Sep)` && conflictNoteSentence(pairs[3], TODAY) === `"Active Items" disagrees with itself: 3 May or 10 May, both saved 1 Apr`);
}

{
	const notes: Note[] = [];
	for (let day = 1; day <= 9; day++) notes.push({ id: `m-0${100 + day}`, kind: "event", saved: "2026-04-01", text: `- Sprint 12 review on ${day} May.` });
	const doc = docOf([{ title: "Sprints", notes }]);
	const pairs = findConflictingNotePairs(doc);
	check(`nine notes that pair every way stop at thirty, got ${pairs.length}`, pairs.length === 30);
	check("a note without an id is not walked", findConflictingNotePairs(docOf([{ title: "Sprints", notes: [] }])).length === 0);
	const both = findNotePairs(doc);
	check("one walk gives both lists, the same as the two searches", JSON.stringify(both.conflicts) === JSON.stringify(pairs) && JSON.stringify(both.duplicates) === JSON.stringify(findDuplicateNotePairs(doc)));
	// A list of tickets: thirty notes that differ only by the number at their head are thirty things, not thirty conflicts.
	const tickets: Note[] = [];
	for (let n = 0; n < 30; n++) tickets.push({ id: `m-0${200 + n}`, saved: "2026-04-01", text: `- Ticket ${4000 + n} is about the login page of the customer portal.` });
	const ticketPairs = findNotePairs(docOf([{ title: "Tickets", notes: tickets }]));
	check(`thirty tickets are no pair at all, got ${ticketPairs.conflicts.length} conflicts and ${ticketPairs.duplicates.length} duplicates`, ticketPairs.conflicts.length === 0 && ticketPairs.duplicates.length === 0);
	const invoices: Note[] = [];
	for (let n = 0; n < 30; n++) invoices.push({ id: `m-0${300 + n}`, saved: "2026-04-01", text: `- Rechnung 2026-${100 + n} an Nordwind ist bezahlt.` });
	check("thirty invoices are no pair either", findNotePairs(docOf([{ title: "Rechnungen", notes: invoices }])).conflicts.length === 0);
}

finish();
