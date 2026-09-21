export {};

// The demotion order as a score with a reason, proved on hand-built documents.
// Pure: no room, no HOME, no network, no writes anywhere. Everything is
// imported from the real module, never an inline copy. The use counter is
// built by hand here, because the order must be provable without a sidecar.
//
// What is pinned down:
//   - an open item is never in the order and never leaves; a done item ranks
//     with the facts;
//   - a practice outranks a fact of the same age, use and size;
//   - use (recalls and refs alike) keeps a note; recency stops counting past
//     a year; on a tie the larger note leaves first, so a migrated room with
//     every note saved on one day drains by size, not by file position;
//   - every ranked note carries a reason a person can read, and the order is
//     deterministic;
//   - migration reads German titles and openings as practices.

import type { MemoryDocument, MemoryEntry } from "../src/memory-entries.js";
import type { MemoryUse } from "../src/memory-use.js";

const { DEMOTION_SCORE, MIGRATION_PRACTICE_TITLE_RULE, MIGRATION_PRACTICE_TEXT_RULE, demoteToBudget, entryTokens, migrateMemoryDocument, parseMemoryDocument, rankEntriesForDemotion } = await import("../src/memory-entries.js");

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

const TODAY = "2026-09-16";

interface Note {
	id: string;
	kind?: MemoryEntry["kind"];
	saved?: string;
	updated?: string;
	refs?: number;
	status?: "open" | "done";
	pinned?: boolean;
	text: string;
}

/** A text of exactly `chars` characters, so a note's size is a chosen number. */
function words(chars: number): string {
	const unit = "word ";
	let out = "- ";
	while (out.length < chars) out += unit;
	return out.slice(0, chars).trimEnd().padEnd(chars, "x");
}

function meta(note: Note): string {
	const fields = [`id=${note.id}`, `kind=${note.kind ?? "fact"}`, `saved=${note.saved ?? "2026-01-01"}`];
	if (note.pinned) fields.push("pinned=true");
	if (note.status) fields.push(`status=${note.status}`);
	if (note.updated) fields.push(`updated=${note.updated}`);
	if (note.refs !== undefined) fields.push(`refs=${note.refs}`);
	return `<!-- e: ${fields.join(" ")} -->`;
}

/** A storage-format document: the Deep Memory notes under one topic, the items under Active Items. */
function docOf(deep: Note[], items: Note[] = [], topic = "Notes"): MemoryDocument {
	const block = (note: Note) => `${meta(note)}\n${note.text}\n`;
	const text = [
		"<!-- exxeta:l1b schema_version=1 -->",
		"",
		"## Chronos",
		"",
		"- Persistent agent id: ranking-smoke",
		"",
		"## Deep Memory",
		"",
		"<!-- entries: next=1000 -->",
		"",
		`### ${topic}`,
		"",
		deep.map(block).join("\n"),
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

function ids(entries: Array<{ id: string }>): string {
	return entries.map((e) => e.id).join(" ");
}

function useOf(notes: Record<string, number>): MemoryUse {
	const use: MemoryUse = { notes: {}, archive: {} };
	for (const [id, hits] of Object.entries(notes)) use.notes[id] = { hits, last: TODAY };
	return use;
}

// --- 1. An open item is protected outright; a done item ranks with the facts ----

{
	const doc = docOf(
		[
			{ id: "m-0001", text: words(60) },
			{ id: "m-0002", kind: "practice", text: words(60) },
		],
		[
			{ id: "m-0010", kind: "item", status: "open", text: words(60) },
			{ id: "m-0011", kind: "item", status: "done", text: words(60) },
		],
	);
	const ranked = rankEntriesForDemotion(doc, { today: TODAY });
	check("an open item is not in the demotion order", !ranked.some((e) => e.id === "m-0010"));
	check("a done item is in the demotion order", ranked.some((e) => e.id === "m-0011"));
	const drained = demoteToBudget(doc, 0, { today: TODAY });
	check("an open item never leaves, even when nothing else is left", !drained.demoted.some((e) => e.id === "m-0010") && drained.doc.topics.some((t) => t.entries.some((e) => e.id === "m-0010")));
	check("everything but the open item left", ids(drained.demoted).split(" ").sort().join(" ") === "m-0001 m-0002 m-0011");
	check("the open item kept while the budget was not met is counted", drained.protectedOpenItems === 1);
	check("a budget that is met counts no protected item", demoteToBudget(doc, 100_000, { today: TODAY }).protectedOpenItems === 0);
	const fact = ranked.find((e) => e.id === "m-0001")!;
	const done = ranked.find((e) => e.id === "m-0011")!;
	check("a done item scores like a fact less the fact's weight", Math.abs(fact.score - done.score - DEMOTION_SCORE.factWeight) < 1e-9);
	check("a done item leaves before a practice", ranked.indexOf(done) < ranked.findIndex((e) => e.id === "m-0002"));
}

// --- 2. A practice outranks a fact of the same age, use and size --------------

{
	const doc = docOf([
		{ id: "m-0001", kind: "practice", saved: "2026-03-01", text: words(80) },
		{ id: "m-0002", kind: "fact", saved: "2026-03-01", text: words(80) },
	]);
	const ranked = rankEntriesForDemotion(doc, { today: TODAY });
	check("the fact leaves first, the practice after it", ids(ranked) === "m-0002 m-0001");
	check("the practice scores higher by exactly the kind weights", Math.abs(ranked[1].score - ranked[0].score - (DEMOTION_SCORE.practiceWeight - DEMOTION_SCORE.factWeight)) < 1e-9);
}

// --- 3. Use keeps a note: recalls and refs count the same way -----------------

{
	const doc = docOf([
		{ id: "m-0001", saved: "2026-03-01", text: words(80) },
		{ id: "m-0002", saved: "2026-03-01", text: words(80) },
		{ id: "m-0003", saved: "2026-03-01", refs: 3, text: words(80) },
	]);
	const ranked = rankEntriesForDemotion(doc, { today: TODAY, use: useOf({ "m-0002": 3 }) });
	check("the never-recalled note leaves first", ranked[0].id === "m-0001");
	check("three recalls and three refs score the same", Math.abs(ranked.find((e) => e.id === "m-0002")!.score - ranked.find((e) => e.id === "m-0003")!.score) < 1e-9);
	check("the recalled note scores higher than the never-recalled one", ranked.find((e) => e.id === "m-0002")!.score > ranked[0].score);
	const heavy = rankEntriesForDemotion(doc, { today: TODAY, use: useOf({ "m-0002": 1_000 }) });
	check("use is capped, so a thousand recalls do not outweigh a practice", heavy.find((e) => e.id === "m-0002")!.score - heavy[0].score <= DEMOTION_SCORE.useCap + 1e-9);
}

// --- 4. On a tie of score, the larger note leaves first -------------------------

{
	// Both sizes sit past the size cap, so the two notes tie on score exactly.
	const doc = docOf([
		{ id: "m-0001", saved: "2026-03-01", text: words(900) },
		{ id: "m-0002", saved: "2026-03-01", text: words(1_400) },
	]);
	const ranked = rankEntriesForDemotion(doc, { today: TODAY });
	check("the two notes tie on score", ranked[0].score === ranked[1].score);
	check("the larger note leaves first", ranked[0].id === "m-0002");
}

// --- 5. A migrated room drains by size, never by id or file position ------------

{
	const sizes = [120, 400, 60, 700, 240, 30];
	const doc = docOf(sizes.map((chars, i) => ({ id: `m-${String(i + 1).padStart(4, "0")}`, saved: "2026-02-10", text: words(chars) })));
	const ranked = rankEntriesForDemotion(doc, { today: TODAY });
	const bySize = [...ranked].sort((a, b) => entryTokens(b) - entryTokens(a) || a.id.localeCompare(b.id));
	check("every note saved on one day with no use: the order is by size, larger first", ids(ranked) === ids(bySize));
	check("and that order is neither the id order nor its reverse", ids(ranked) !== "m-0001 m-0002 m-0003 m-0004 m-0005 m-0006" && ids(ranked) !== "m-0006 m-0005 m-0004 m-0003 m-0002 m-0001");
}

// --- 6. Recency stops counting after a year -------------------------------------

{
	const doc = docOf([
		{ id: "m-0001", saved: "2025-09-16", text: words(80) },
		{ id: "m-0002", saved: "2024-09-16", text: words(80) },
		{ id: "m-0003", saved: "2024-09-16", updated: "2026-09-06", text: words(80) },
	]);
	const ranked = rankEntriesForDemotion(doc, { today: TODAY });
	const score = (id: string) => ranked.find((e) => e.id === id)!.score;
	check("a note untouched a year scores the same as one untouched two years", score("m-0001") === score("m-0002"));
	check("a note touched ten days ago scores higher", score("m-0003") > score("m-0001"));
	check("and it leaves last", ranked[ranked.length - 1].id === "m-0003");
	check("the recency term is at most its weight", score("m-0003") - score("m-0001") <= DEMOTION_SCORE.recencyWeight + 1e-9);
}

// --- 7. Today's saves go last; keepIds and keepTopics still win ------------------

{
	const doc = docOf(
		[
			{ id: "m-0001", saved: "2025-01-01", text: words(80) },
			{ id: "m-0002", saved: "2025-01-01", text: words(80) },
			// Saved today and large: the lowest score of the lot, yet the last to go.
			{ id: "m-0003", saved: TODAY, text: words(1_200) },
		],
		[],
	);
	const drained = demoteToBudget(doc, 0, { today: TODAY });
	check("today's save is the last to leave", drained.demoted[drained.demoted.length - 1].id === "m-0003");
	check("today's save has the lowest score all the same", Math.min(...drained.demoted.map((e) => e.score)) === drained.demoted[drained.demoted.length - 1].score);
	const kept = demoteToBudget(doc, 0, { today: TODAY, keepIds: ["m-0001"] });
	check("a kept id never leaves", !kept.demoted.some((e) => e.id === "m-0001") && kept.demoted.length === 2);
	const topic = demoteToBudget(doc, 0, { today: TODAY, keepTopics: ["Deep Memory/Notes"] });
	check("a protected topic keeps every note", topic.demoted.length === 0 && topic.overageTokens > 0);
	check("the demoted rows are ranked entries with a reason", drained.demoted.every((e) => typeof e.score === "number" && typeof e.reason === "string" && e.reason.length > 0));
}

// --- 8. Every ranked note has a reason a person can read ------------------------

{
	// 1,120 characters is 280 estimated tokens exactly.
	const doc = docOf(
		[
			{ id: "m-0001", saved: "2026-03-02", text: words(1_120) },
			{ id: "m-0002", saved: "2026-03-02", refs: 2, text: words(80) },
			{ id: "m-0003", saved: TODAY, text: words(80) },
			{ id: "m-0004", kind: "event", saved: "2026-03-02", text: words(80) },
			{ id: "m-0005", saved: "2025-03-02", text: words(80) },
		],
		[{ id: "m-0010", kind: "item", status: "done", saved: "2026-05-04", text: words(80) }],
	);
	const ranked = rankEntriesForDemotion(doc, { today: TODAY, use: useOf({ "m-0002": 1 }) });
	const reason = (id: string) => ranked.find((e) => e.id === id)!.reason;
	const DECIDING = /recalled|touched|\bfrom\b/;
	check("every reason names at least two deciding terms, one of them the use or the date", ranked.every((e) => e.reason.split(", ").length >= 2 && DECIDING.test(e.reason)));
	check("a never-recalled 280-token note untouched since March says so", reason("m-0001").includes("not touched since 2 Mar") && reason("m-0001").includes("never recalled") && reason("m-0001").includes("280 tokens"));
	check("a small note does not name its size", !/tokens/.test(reason("m-0002")));
	check("a recalled note says how often", /recalled 3 times/.test(reason("m-0002")));
	check("a note touched today says so", /touched today/.test(reason("m-0003")));
	check("an event reads as an event from its day", reason("m-0004").includes("event from 2 Mar"));
	check("a done item reads as a done item from its month", reason("m-0010").includes("done item from May"));
	check("a date in another year carries the year", reason("m-0005").includes("2 Mar 2025"));
	check("a reason is short", ranked.every((e) => e.reason.length <= 120));
}

// --- 9. Determinism ------------------------------------------------------------

{
	const doc = docOf(
		[
			{ id: "m-0001", saved: "2026-03-02", text: words(300) },
			{ id: "m-0002", saved: "2026-03-02", refs: 2, text: words(300) },
			{ id: "m-0003", kind: "practice", saved: "2026-01-02", text: words(80) },
			{ id: "m-0004", saved: "2025-03-02", text: words(1_000) },
		],
		[{ id: "m-0010", kind: "item", status: "done", saved: "2026-05-04", text: words(80) }],
	);
	const use = useOf({ "m-0001": 4 });
	const a = rankEntriesForDemotion(doc, { today: TODAY, use });
	const b = rankEntriesForDemotion(doc, { today: TODAY, use });
	check("ranking twice gives the same order", ids(a) === ids(b));
	check("and the same reasons", a.map((e) => e.reason).join("|") === b.map((e) => e.reason).join("|"));
	check("and the same scores", a.map((e) => e.score).join("|") === b.map((e) => e.score).join("|"));
}

// --- 10. Migration reads German practices --------------------------------------

{
	const v1 = [
		"<!-- exxeta:l1b schema_version=1 -->",
		"",
		"## Chronos",
		"",
		"- Persistent agent id: ranking-smoke",
		"",
		"## Deep Memory",
		"",
		"### Arbeitsweise",
		"",
		"- Zusammenfassungen auf einer Seite, Zahlen zuerst.",
		"",
		"### Präferenzen",
		"",
		"- Der Kunde mag kurze Mails.",
		"",
		"### Unsere Präferenzen im Projekt",
		"",
		"- Freitags keine Deployments.",
		"",
		"### Working style",
		"",
		"- One page, numbers first.",
		"",
		"### Projekte",
		"",
		"- Immer zuerst fragen, bevor etwas gelöscht wird.",
		"- Nie ohne Rückfrage löschen.",
		"- Wir halten es so: Reviews vor dem Merge.",
		"- Always ask first.",
		"- Das Projekt Nordwind läuft bis Dezember.",
		"- Die Rechnung geht am ersten Werktag raus.",
		"",
		"## Active Items",
		"",
		"- Den Vertrag unterschreiben lassen.",
		"",
		"## Recent Context",
		"",
		"### RC-0001 | OPEN | 2026-01-01 | Nothing to see",
		"",
	].join("\n");
	const migrated = migrateMemoryDocument(parseMemoryDocument(v1), { fallbackSaved: "2026-09-01" }).doc;
	const kindOf = (topic: string, opening: string) => migrated.topics.find((t) => t.title === topic)?.entries.find((e) => e.text.includes(opening))?.kind;
	check("a note under Arbeitsweise is a practice", kindOf("Arbeitsweise", "Zusammenfassungen") === "practice");
	check("a note under Präferenzen is a practice", kindOf("Präferenzen", "kurze Mails") === "practice");
	check("Präferenzen inside a longer title is a practice too", kindOf("Unsere Präferenzen im Projekt", "Freitags") === "practice");
	check("a note under Working style is still a practice", kindOf("Working style", "One page") === "practice");
	check("Immer … opens a practice", kindOf("Projekte", "Immer zuerst") === "practice");
	check("Nie … opens a practice", kindOf("Projekte", "Nie ohne") === "practice");
	check("Wir halten es so … opens a practice", kindOf("Projekte", "Wir halten es so") === "practice");
	check("Always … still opens a practice", kindOf("Projekte", "Always ask") === "practice");
	check("plain German text is a fact", kindOf("Projekte", "Nordwind läuft") === "fact" && kindOf("Projekte", "Rechnung geht") === "fact");
	check("the title rule is word-boundary safe around umlauts", MIGRATION_PRACTICE_TITLE_RULE.test("Präferenzen") && MIGRATION_PRACTICE_TITLE_RULE.test("Meine Präferenzen, kurz") && !MIGRATION_PRACTICE_TITLE_RULE.test("Präferenzenliste"));
	check("the title rule reads the other German titles", ["Vorgehen", "Regeln", "Konventionen", "Richtlinien", "Zusammenarbeit", "Gewohnheiten", "So arbeiten wir"].every((title) => MIGRATION_PRACTICE_TITLE_RULE.test(title)));
	check("the title rule does not read a compound as a rule", !MIGRATION_PRACTICE_TITLE_RULE.test("Spielregeln") && !MIGRATION_PRACTICE_TITLE_RULE.test("Projekte"));
	check("the text rule reads the German openings", ["niemals löschen", "Bitte stets fragen", "bitte immer prüfen", "Grundsätzlich vorher fragen", "Stets die Nummern zuerst", "Vermeide lange Mails", "Verwende eine Seite", "Nutze das Template", "Frag vorher", "Frage vorher nach", "Keine Deployments freitags"].every((line) => MIGRATION_PRACTICE_TEXT_RULE.test(line)));
	check("the text rule does not read a look-alike word as an opening", !MIGRATION_PRACTICE_TEXT_RULE.test("Immerhin ist der Vertrag da") && !MIGRATION_PRACTICE_TEXT_RULE.test("Niederlassung Hamburg") && !MIGRATION_PRACTICE_TEXT_RULE.test("Keinerlei Rückmeldung"));
}

// --- The constants are one place, and the bench can print them ------------------

check("the score constants are declared together", [DEMOTION_SCORE.practiceWeight, DEMOTION_SCORE.factWeight, DEMOTION_SCORE.eventWeight, DEMOTION_SCORE.doneItemWeight, DEMOTION_SCORE.useCap, DEMOTION_SCORE.recencyWeight, DEMOTION_SCORE.recencyHorizonDays, DEMOTION_SCORE.sizeDivisor, DEMOTION_SCORE.sizeCap].every((n) => typeof n === "number"));

console.log(`memory-ranking-smoke: ${passed}/${passed + failed} checks passed`);
if (failed > 0) process.exit(1);
