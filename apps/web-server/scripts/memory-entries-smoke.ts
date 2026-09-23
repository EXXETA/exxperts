export {};

// The entry model's promises as predicates (memory v2, stream B). Everything is
// imported from the real module — never an inline copy. The two promises the
// rest of the memory work stands on are proved here on real material:
//   - a document in storage format survives parse and render byte for byte,
//     CRLF, trailing spaces and blank-line structure included;
//   - a pinned entry is never demoted, and neither is one the user kept.
// Offline, no network, no writes anywhere: the real rooms under ~/.exxperts are
// read and never touched, and the synthetic 66k memory comes from the bench
// generator's stdout.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const {
	applyUserEdit,
	appendToArchive,
	archiveIdsTaken,
	archiveIndex,
	demoteToBudget,
	entryBaseId,
	entryMetadataLine,
	entryTokens,
	findEntry,
	findEntryLocation,
	findEntryVersion,
	findStructuralLine,
	formatEntryId,
	highestEntryNumber,
	listAreas,
	memoryAreaId,
	memoryDocumentEol,
	memoryTopicAddress,
	MEMORY_SECTIONS,
	migrateMemoryDocument,
	nextVersionedEntryId,
	parseArchive,
	parseMemoryDocument,
	rankEntriesForDemotion,
	removeFromArchive,
	renderArchive,
	renderMemoryDocument,
	restoreEntries,
	restoreEntry,
	reviewTargetTokens,
	savedStampDatesIn, renderMemoryContext, stripRecentContextMetadata } = await import("../src/memory-entries.js");
const { estimateTokens } = await import("../src/token-estimate.js");

type Doc = ReturnType<typeof parseMemoryDocument>;

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

function firstDifference(a: string, b: string): string {
	for (let i = 0; i < Math.max(a.length, b.length); i++) {
		if (a[i] !== b[i]) return `at ${i}: ${JSON.stringify(a.slice(Math.max(0, i - 60), i + 60))} vs ${JSON.stringify(b.slice(Math.max(0, i - 60), i + 60))}`;
	}
	return "identical";
}

function entryCount(doc: Doc): number {
	return doc.topics.reduce((n, topic) => n + topic.entries.length, 0);
}

const here = path.dirname(fileURLToPath(import.meta.url));
const FALLBACK_SAVED = "2026-09-01";

// --- 1. A real room's shape: prose Deep Memory, `### RC-` entries -------------

// Faithful to what rooms hold today: the schema comment, a Chronos block with
// its blank runs, Deep Memory as plain prose under no subsection, Active Items
// as a bullet list, and Recent Context entries with their rc_metadata comments.
const PROSE_ROOM = `<!-- exxeta:l1b schema_version=1 -->

## Chronos




- Current scaffold timestamp: 2026-07-10T00:13:38.750Z
- Persistent agent id: probe
- Lifecycle state: ready

## Deep Memory

Durable understanding is still forming. What is known so far comes from the scaffolded identity.

The room is used for weekly planning and keeps its notes short. (saved 2026-08-14)

## Active Items

- Collect the current projects and priorities.
- **must-keep** Never move the Friday review. (saved 2026-06-03)

## Recent Context




### RC-0001 | OPEN | 2026-07-12 | A first session

<!-- rc_metadata: checkpoint_id=cp_1; session_id=s_1; density=standard; approved_at=2026-07-12T11:34:15.700Z -->

**Session arc:** Opened as an intro.

**Body:**
- Something durable happened.

### RC-0002 | OPEN | 2026-07-15 | A second session

<!-- rc_metadata: checkpoint_id=cp_2; session_id=s_2; density=standard; approved_at=2026-07-15T12:43:21.548Z -->

**Session arc:** Continued.
`;

{
	const doc = parseMemoryDocument(PROSE_ROOM);
	assert(doc.preamble === "<!-- exxeta:l1b schema_version=1 -->\n\n", "the preamble is everything before the first top-level section, verbatim");
	assert(doc.chronos.startsWith("## Chronos\n\n\n\n\n- Current scaffold"), "Chronos is carried verbatim, blank runs included");
	assert(doc.recentContext.startsWith("## Recent Context") && doc.recentContext.includes("rc_metadata") && doc.recentContext.endsWith("Continued.\n"), "Recent Context is carried verbatim and untouched");
	{
		const boot = stripRecentContextMetadata(renderMemoryContext(PROSE_ROOM));
		assert(!boot.includes("rc_metadata"), "the boot read carries no checkpoint provenance comment");
		assert(boot.includes("### RC-0001") && boot.includes("Continued."), "the boot read keeps every remembered conversation's heading and body");
		assert(boot.includes("### RC-0001 | OPEN | 2026-07-12 | A first session\n\n**Session arc:** Opened as an intro."), "the blank line the comment sat between is folded, so the heading stands one blank line above the body");
		assert(renderMemoryContext(PROSE_ROOM).includes("rc_metadata"), "the context render itself keeps the comment, because every save's fingerprint measures it");
		const crlf = stripRecentContextMetadata(PROSE_ROOM.replace(/\n/g, "\r\n"));
		assert(!crlf.includes("rc_metadata") && crlf.includes("### RC-0001 | OPEN | 2026-07-12 | A first session\r\n\r\n**Session arc:** Opened as an intro."), "a CRLF file strips the same way and keeps its line endings");
	}
	assert(doc.otherSections.length === 0 && doc.nextEntryNumber === 1, "an unmigrated file has no other sections and no counter yet");

	const deep = doc.topics.filter((t) => t.section === "Deep Memory");
	assert(deep.length === 1 && deep[0].heading === null && deep[0].title === "General", "prose Deep Memory parses as one implicit topic, General");
	assert(deep[0].entries.length === 2 && deep[0].entries.every((e) => e.id === ""), "each paragraph is an entry, with no id until migration");
	const active = doc.topics.filter((t) => t.section === "Active Items");
	assert(active.length === 1 && active[0].title === "Active Items" && active[0].heading === null && active[0].entries.length === 2, "Active Items is one implicit topic holding its bullets");

	const { doc: migrated, assigned } = migrateMemoryDocument(doc, { fallbackSaved: FALLBACK_SAVED });
	assert(assigned === 3 && migrated.nextEntryNumber === 4, `migration assigns an id to every entry that stays, and the scaffold's opening paragraph does not (${assigned})`);
	const general = migrated.topics.find((t) => t.section === "Deep Memory")!;
	assert(general.heading === "### General", "prose Deep Memory without subsections gains a ### General heading");
	assert(general.entries.length === 1 && !general.entries[0].text.startsWith("Durable understanding"), "the paragraph that opens with Durable understanding is dropped at migration");
	assert(general.entries[0].id === formatEntryId(1) && general.entries[0].kind === "fact", "Deep Memory entries default to kind fact");
	assert(general.entries[0].saved === "2026-08-14", "a (saved YYYY-MM-DD) stamp inside the entry wins over the fallback");
	assert(savedStampDatesIn(doc.topics[0].entries[1].text)[0] === "2026-08-14", "the stamp reader finds the date it used in the text as it was");
	assert(general.entries[0].text === "The room is used for weekly planning and keeps its notes short.", `once the date is taken the stamp leaves the text, got ${JSON.stringify(general.entries[0].text)}`);
	const items = migrated.topics.find((t) => t.section === "Active Items")!;
	assert(items.entries.every((e) => e.kind === "item" && e.status === "open"), "Active Items entries default to open items");
	assert(items.entries[0].saved === FALLBACK_SAVED, "an entry without a stamp takes the fallback saved-on date");
	assert(items.entries[0].pinned === false && items.entries[1].pinned === true, "a **must-keep** marker anywhere in the entry pins it");
	assert(items.entries[1].text === "- **must-keep** Never move the Friday review." && items.entries[1].saved === "2026-06-03", `a stamped item keeps its date and loses the stamp, got ${JSON.stringify(items.entries[1])}`);

	// Round trip, and the migration is a fixed point.
	const storage = renderMemoryDocument(migrated, "storage");
	const reparsed = parseMemoryDocument(storage);
	assert(renderMemoryDocument(reparsed, "storage") === storage, `the storage render round-trips byte for byte (${firstDifference(storage, renderMemoryDocument(reparsed, "storage"))})`);
	assert(migrateMemoryDocument(reparsed, { fallbackSaved: "2026-01-01" }).assigned === 0, "migrating a migrated document assigns nothing");
	assert(storage.includes("<!-- entries: next=4 -->"), "the id counter is stored under the Deep Memory heading");
	assert(storage.includes(doc.recentContext) && storage.startsWith(doc.preamble + doc.chronos), "the sections this module does not own come back unchanged");
	assert(reparsed.nextEntryNumber === 4 && entryCount(reparsed) === 3, "the counter and the entries survive the round trip");
	assert(!storage.includes("Durable understanding"), "the dropped paragraph is not in the file either");

	// The context render is what the room pays for.
	const context = renderMemoryDocument(migrated, "context");
	assert(!context.includes("<!-- e:") && !context.includes("<!-- entries:"), "the context render strips the metadata comments and the counter");
	assert(context.includes("Never move the Friday review."), "the entries themselves are untouched by the context render");
	assert(estimateTokens(context) < estimateTokens(storage), "stripping the metadata is what makes the context render the cheaper one");
	assert(reviewTargetTokens(migrated) === estimateTokens(context.slice(context.indexOf("## Deep Memory"), context.indexOf("## Recent Context"))), "reviewTargetTokens is exactly the context render of Deep Memory plus Active Items");
	assert(!context.includes("(saved "), "the room no longer pays for a date it carries in the metadata already");
}

// --- 1b. Migration strips the "(saved …)" stamps and classifies practices ----

{
	// One topic already migrated (its entry keeps its stamp: migration never
	// touches an entry that has an id), the rest as a v1 room writes them: a
	// stamp at the end of a line, one in the middle, one on a line of its own,
	// one that is a whole entry, and a line whose trailing spaces carry no stamp
	// (interpolated, so no editor can trim them out of the fixture).
	const TRAILING_SPACES = "   ";
	const STAMPED = `## Deep Memory

<!-- entries: next=2 -->

### Old

<!-- e: id=m-0001 kind=fact saved=2026-01-01 -->
- Already migrated, stamp and all. (saved 2026-01-01)

### Working style

- Send summaries as one page. (saved 2026-05-01)
- The team meets on Mondays.

### Commercial terms

- Always sign before June. (saved 2026-04-02)
- Never invoice mid-month.
- The Nordwind contract renews annually (saved 2026-03-03) and legal signs it.
- Invoices go out on the first working day.${TRAILING_SPACES}
- Users must sign the NDA before access.
- Preferred vendor is Nordwind.
- The token is stored in Vault at \`secret/x\` (saved 2026-03-18).
- Ask before changing the schedule (saved 2026-03-19) with finance.
- Use one page.
  - and numbers first. (saved 2026-03-20)

The renewal is a paragraph note
(saved 2026-01-01)

(saved 2026-01-05)

## Active Items

- Keep the vendor informed. (saved 2026-02-02)
`;
	const { doc: migrated, assigned } = migrateMemoryDocument(parseMemoryDocument(STAMPED), { fallbackSaved: FALLBACK_SAVED });
	assert(assigned === 14, `every unmarked entry gets an id (${assigned})`);
	const old = migrated.topics.find((t) => t.title === "Old")!.entries[0];
	assert(old.id === "m-0001" && old.text === "- Already migrated, stamp and all. (saved 2026-01-01)", `an already-migrated entry is never touched, got ${JSON.stringify(old.text)}`);

	const style = migrated.topics.find((t) => t.title === "Working style")!.entries;
	assert(style[0].text === "- Send summaries as one page." && style[0].saved === "2026-05-01", `a stamp at the end of the line goes, its date stays, got ${JSON.stringify(style[0])}`);
	assert(style[0].kind === "practice" && style[1].kind === "practice", `every note under a topic titled like a way of working is a practice (title rule), got ${style.map((e) => e.kind).join(",")}`);
	assert(style[1].text === "- The team meets on Mondays." && style[1].saved === FALLBACK_SAVED, "a line without a stamp is left as it is");

	const terms = migrated.topics.find((t) => t.title === "Commercial terms")!.entries;
	assert(terms[0].text === "- Always sign before June." && terms[0].kind === "practice", `a note that opens like an instruction is a practice (text rule), got ${JSON.stringify(terms[0])}`);
	assert(terms[1].kind === "practice", `"Never …" is a practice by the text rule, got ${terms[1].kind}`);
	assert(terms[2].text === "- The Nordwind contract renews annually and legal signs it." && terms[2].saved === "2026-03-03", `a stamp in the middle of a line leaves one space behind, got ${JSON.stringify(terms[2].text)}`);
	assert(terms[2].kind === "fact" && terms[3].kind === "fact", `a plain statement under a plain topic stays a fact, got ${terms[2].kind},${terms[3].kind}`);
	assert(terms[3].text === `- Invoices go out on the first working day.${TRAILING_SPACES}`, `trailing spaces on a line that held no stamp are identity and stay, got ${JSON.stringify(terms[3].text)}`);
	// The text rule reads whole words: a note that merely starts with the letters of one is not an instruction.
	assert(terms[4].kind === "fact" && terms[5].kind === "fact", `"Users must …" and "Preferred vendor …" are facts, got ${terms[4].kind},${terms[5].kind}`);
	assert(terms[6].text === "- The token is stored in Vault at `secret/x`." && terms[6].saved === "2026-03-18", `a stamp before the full stop goes with the space before it, got ${JSON.stringify(terms[6].text)}`);
	assert(terms[7].text === "- Ask before changing the schedule with finance." && terms[7].kind === "practice", `a stamp mid-sentence leaves one space, and "Ask before …" is a practice, got ${JSON.stringify(terms[7])}`);
	assert(terms[8].text === "- Use one page.\n  - and numbers first." && terms[8].kind === "practice", `a stamped sub-bullet keeps its indentation, got ${JSON.stringify(terms[8].text)}`);
	assert(terms[9].text === "The renewal is a paragraph note" && terms[9].saved === "2026-01-01", `a line the removal leaves empty is dropped, got ${JSON.stringify(terms[9])}`);
	assert(terms[10].text === "(saved 2026-01-05)" && terms[10].saved === "2026-01-05", `a text the removal would leave empty is kept as it was: migration never deletes an entry, got ${JSON.stringify(terms[10])}`);

	const items = migrated.topics.find((t) => t.section === "Active Items")!.entries;
	assert(items[0].kind === "item" && items[0].text === "- Keep the vendor informed." && items[0].saved === "2026-02-02", `Active Items are items whatever they open with, and lose their stamps too, got ${JSON.stringify(items[0])}`);

	// The storage render carries the kinds, no stamp it removed, and is a fixed point.
	const storage = renderMemoryDocument(migrated, "storage");
	assert((storage.match(/kind=practice/g) ?? []).length === 6, `the storage render carries kind=practice for each practice, got ${(storage.match(/kind=practice/g) ?? []).length}`);
	assert(!storage.includes("(saved 2026-05-01)") && !storage.includes("(saved 2026-03-03)") && storage.includes("(saved 2026-01-05)"), "the stamps migration removed are gone from the file, the one it kept is still there");
	const again = migrateMemoryDocument(parseMemoryDocument(storage), { fallbackSaved: "2026-01-01" });
	assert(again.assigned === 0 && renderMemoryDocument(again.doc, "storage") === storage, "migrating the migrated file assigns nothing and changes no byte");
}

// --- 1c. Migration drops the scaffold's opening paragraph, nothing else ------

// A 0.11.2 room after its first consolidation: the template paragraph, then
// real topics. The paragraph is the scaffold's, not the room's.
const CONSOLIDATED_ROOM = `<!-- exxeta:l1b schema_version=1 -->

## Deep Memory

Durable understanding consolidated across sessions since March 2026. Newer saved-on stamps win on conflict.

### Commercial terms

- Net 30 on every invoice.

## Active Items

- Send the renewal.

## Recent Context
`;

// A room whose opening prose is its own: it stays, under General.
const OWN_PROSE_ROOM = `<!-- exxeta:l1b schema_version=1 -->

## Deep Memory

The room plans the quarterly budget with the finance team.

Durable relationships with two suppliers matter more than price.

### Suppliers

- Ordering goes through the Munich office.

## Active Items

## Recent Context
`;

// The template paragraph under a heading of its own is a note somebody put
// there: the rule reads the heading-less first topic only.
const HEADED_TEMPLATE_ROOM = `<!-- exxeta:l1b schema_version=1 -->

## Deep Memory

### Notes on stamps

Durable understanding is what the saved-on stamp records.

## Active Items

## Recent Context
`;

{
	const { doc: migrated, assigned } = migrateMemoryDocument(parseMemoryDocument(CONSOLIDATED_ROOM), { fallbackSaved: FALLBACK_SAVED });
	const deep = migrated.topics.filter((t) => t.section === "Deep Memory");
	assert(deep.length === 1 && deep[0].title === "Commercial terms" && deep[0].heading === "### Commercial terms", `the template paragraph and the General topic it was the whole of are gone, got ${JSON.stringify(deep.map((t) => t.title))}`);
	assert(assigned === 2 && migrated.nextEntryNumber === 3, `the two real entries get the ids (${assigned})`);
	const storage = renderMemoryDocument(migrated, "storage");
	assert(!storage.includes("saved-on stamp") && storage.includes("### Commercial terms") && storage.includes("Net 30"), "the file keeps the room's notes and not the scaffold's paragraph");
	assert(storage.indexOf("<!-- entries: next=3 -->") < storage.indexOf("### Commercial terms"), "the counter sits under the Deep Memory heading with nothing before the first topic");
	assert(migrateMemoryDocument(parseMemoryDocument(storage), { fallbackSaved: FALLBACK_SAVED }).assigned === 0 && renderMemoryDocument(migrateMemoryDocument(parseMemoryDocument(storage), { fallbackSaved: FALLBACK_SAVED }).doc, "storage") === storage, "migrating the migrated file assigns nothing and changes no byte");

	const own = migrateMemoryDocument(parseMemoryDocument(OWN_PROSE_ROOM), { fallbackSaved: FALLBACK_SAVED });
	const general = own.doc.topics.find((t) => t.section === "Deep Memory")!;
	assert(general.title === "General" && general.entries.length === 2, `leading prose that is the room's own stays under General, got ${JSON.stringify(general.entries.map((e) => e.text))}`);
	assert(general.entries[1].text.startsWith("Durable relationships"), "the opening rule reads the words Durable understanding, not the word Durable");
	assert(own.assigned === 3, `every one of the room's own entries gets an id (${own.assigned})`);

	const headed = migrateMemoryDocument(parseMemoryDocument(HEADED_TEMPLATE_ROOM), { fallbackSaved: FALLBACK_SAVED });
	const stamps = headed.doc.topics.find((t) => t.title === "Notes on stamps")!;
	assert(stamps.entries.length === 1 && headed.assigned === 1, "the same words under a heading of their own are a note and stay");

	// An already-migrated file that still carries the words keeps them: the
	// rule runs on entries without ids only.
	const migratedBefore = `<!-- exxeta:l1b schema_version=1 -->

## Deep Memory

<!-- entries: next=2 -->

### General

<!-- e: id=m-0001 kind=fact saved=2026-01-01 -->
Durable understanding consolidated across sessions. Newer saved-on stamps win on conflict.

## Active Items

## Recent Context
`;
	const again = migrateMemoryDocument(parseMemoryDocument(migratedBefore), { fallbackSaved: FALLBACK_SAVED });
	assert(again.assigned === 0 && renderMemoryDocument(again.doc, "storage") === migratedBefore, "an already-migrated file is untouched, template words and all");
	console.log("  migration drops the scaffold's opening paragraph and nothing else");
}

// --- 2. Real rooms on this machine, read-only --------------------------------

{
	const roomsDir = path.join(os.homedir(), ".exxperts", "app", "personalized-agents");
	let read = 0;
	if (fs.existsSync(roomsDir)) {
		for (const room of fs.readdirSync(roomsDir)) {
			const file = path.join(roomsDir, room, "L1b", "current.md");
			if (!fs.existsSync(file)) continue;
			// Read only. Nothing under HOME is ever written by this smoke.
			const raw = fs.readFileSync(file, "utf8");
			// A room the app has already saved on 0.12 carries its ids: migration
			// assigns one to each entry that has none, less the scaffold's template
			// paragraph it drops, so the count is bounded by the unmarked entries.
			const parsed = parseMemoryDocument(raw);
			const unmarked = parsed.topics.reduce((sum, topic) => sum + topic.entries.filter((entry) => !entry.id).length, 0);
			const { doc: migrated, assigned } = migrateMemoryDocument(parsed, { fallbackSaved: FALLBACK_SAVED });
			const storage = renderMemoryDocument(migrated, "storage");
			const again = renderMemoryDocument(parseMemoryDocument(storage), "storage");
			assert(again === storage, `${room}: the migrated file round-trips byte for byte (${firstDifference(storage, again)})`);
			assert(migrateMemoryDocument(parseMemoryDocument(storage), { fallbackSaved: FALLBACK_SAVED }).assigned === 0, `${room}: migration is idempotent`);
			assert(assigned <= unmarked, `${room}: migration assigned no more ids than there were entries without one (${assigned} of ${unmarked})`);
			assert(migrated.topics.every((topic) => topic.entries.every((entry) => entry.id)), `${room}: every entry came out of migration with an id`);
			assert(migrated.recentContext === parseMemoryDocument(raw).recentContext, `${room}: Recent Context is byte-identical after migration`);
			read++;
		}
	}
	console.log(`  real rooms migrated read-only: ${read}`);
}

// --- 3. The synthetic 66k memory ---------------------------------------------

const synthetic = execFileSync(process.execPath, [path.join(here, "memory-bench", "gen-memory.mjs"), "66000", "10"], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
let syntheticMigrated: Doc;
{
	assert(estimateTokens(synthetic) > 60000, `the bench generates a memory of the field's size (${estimateTokens(synthetic)} tokens)`);
	const doc = parseMemoryDocument(synthetic);
	const { doc: migrated, assigned } = migrateMemoryDocument(doc, { fallbackSaved: FALLBACK_SAVED });
	syntheticMigrated = migrated;
	assert(assigned > 1500, `every bullet and paragraph of a 66k memory becomes an entry (${assigned})`);
	assert(migrated.topics.filter((t) => t.section === "Deep Memory").length > 100, "the generator's ### subsections become topics");
	const storage = renderMemoryDocument(migrated, "storage");
	const again = renderMemoryDocument(parseMemoryDocument(storage), "storage");
	assert(again === storage, `the 66k file round-trips byte for byte (${firstDifference(storage, again)})`);
	assert(migrateMemoryDocument(parseMemoryDocument(storage), { fallbackSaved: FALLBACK_SAVED }).assigned === 0, "migrating the migrated 66k file assigns nothing");
	const areas = listAreas(migrated);
	assert(areas.length === assigned && areas.every((row) => row.id && row.firstLine && row.tokens > 0), "the area map carries one row per entry, each with an id, a first line and a size");
	assert(areas.every((row) => findEntry(migrated, row.id)?.id === row.id), "every row of the map addresses a real entry");
	const stamped = areas.filter((row) => row.saved !== FALLBACK_SAVED);
	assert(stamped.length > 200, `entries carrying a (saved …) stamp keep their own date (${stamped.length})`);
	console.log(`  synthetic 66k: ${assigned} entries, ${migrated.topics.length} topics, review target ${reviewTargetTokens(migrated)} tokens`);
}

// --- 4. Ranking ---------------------------------------------------------------

const RANKING_DOC = `<!-- exxeta:l1b schema_version=1 -->

## Chronos

- Persistent agent id: ranking

## Deep Memory

<!-- entries: next=9 -->

### Ranking

<!-- e: id=m-0001 kind=fact saved=2026-01-01 -->
- Never updated, never referenced.

<!-- e: id=m-0002 kind=fact saved=2026-01-01 refs=3 -->
- Never updated, referenced three times.

<!-- e: id=m-0003 kind=fact saved=2026-02-01 -->
- Saved a month later.

<!-- e: id=m-0004 kind=fact saved=2026-01-01 updated=2026-03-01 -->
- Updated in March, saved in January.

<!-- e: id=m-0008 kind=fact saved=2026-02-15 updated=2026-03-01 -->
- Updated in March, saved in February.

<!-- e: id=m-0005 kind=practice saved=2026-01-01 -->
- A practice: send summaries as one page, numbers first.

<!-- e: id=m-0006 kind=fact saved=2026-01-01 pinned=true -->
- **must-keep** The reporting deadline is the fifth working day.

## Active Items

<!-- e: id=m-0007 kind=item saved=2026-01-01 status=done -->
- A done item, ranked like a fact.

## Recent Context

### RC-0001 | OPEN | 2026-01-01 | Nothing to see
`;

{
	const doc = parseMemoryDocument(RANKING_DOC);
	assert(doc.nextEntryNumber === 9 && entryCount(doc) === 8, "a hand-written storage file parses with its counter and its eight entries");
	assert(renderMemoryDocument(doc, "storage") === RANKING_DOC, `a canonical hand-written file is already a fixed point (${firstDifference(RANKING_DOC, renderMemoryDocument(doc, "storage"))})`);

	// The order is a score (kind + use + recency − size, see DEMOTION_SCORE),
	// measured to a fixed day so the pin does not drift with the calendar.
	const rankedEntries = rankEntriesForDemotion(doc, { today: "2026-09-12" });
	const ranked = rankedEntries.map((e) => e.id);
	assert(!ranked.includes("m-0006"), "a pinned entry is not in the demotion order at all");
	assert(ranked.join(" ") === "m-0007 m-0001 m-0003 m-0004 m-0008 m-0005 m-0002", `the demotion order is lowest value first (${ranked.join(" ")})`);
	// Each rule, named on its own pair.
	for (const fact of ["m-0001", "m-0003", "m-0004", "m-0008"]) assert(ranked.indexOf(fact) < ranked.indexOf("m-0005"), `a practice ranks above a fact of the same use: ${fact} leaves before it`);
	assert(ranked.indexOf("m-0007") === 0, "a done item ranks like a fact less the fact's weight: it goes first");
	assert(ranked.indexOf("m-0003") < ranked.indexOf("m-0004"), "the more recently touched entry ranks higher");
	assert(ranked.indexOf("m-0001") < ranked.indexOf("m-0002"), "more refs ranks higher");
	assert(ranked.indexOf("m-0005") < ranked.indexOf("m-0002"), "enough use lifts a fact past a practice never recalled");
	assert(ranked.indexOf("m-0004") < ranked.indexOf("m-0008"), "on a tie of score and size, the oldest saved-on is demoted first");
	assert(rankedEntries.every((e) => typeof e.score === "number" && e.reason.length > 0), "every ranked entry carries its score and a reason");
	assert(rankEntriesForDemotion(doc, { today: "2026-09-12" }).map((e) => e.id).join(" ") === ranked.join(" "), "the order is deterministic");
	assert(entryTokens(findEntry(doc, "m-0001")!) === estimateTokens(findEntry(doc, "m-0001")!.text), "an entry's size goes through the ONE estimator");
}

// --- 4a. The render a fold reads: sections only, addresses inline --------------

// A fold addresses entries by id, and used to be handed the whole document plus
// a list of every entry as a row beside it. The addresses ride in the entries'
// own first lines instead, and the render carries the two sections a fold can
// change and nothing else — so what the fold pays for is the memory, once.
{
	const doc = parseMemoryDocument(RANKING_DOC);
	const fold = renderMemoryDocument(doc, "context", { entryIds: true, sections: MEMORY_SECTIONS });
	const plain = renderMemoryDocument(doc, "context");

	assert(fold.startsWith("## Deep Memory") && fold.includes("## Active Items"), "the fold render is the two sections a fold changes");
	for (const absent of ["## Chronos", "## Recent Context", "exxeta:l1b", "<!-- e:", "<!-- entries:"]) {
		assert(!fold.includes(absent), `the fold render carries no ${absent}`);
	}
	assert(fold.includes("- [m-0001] Never updated, never referenced."), "a bullet entry carries its id after the bullet");
	assert(fold.includes("- [m-0006 · pinned] **must-keep** The reporting deadline is the fifth working day."), "a pinned entry says so in its own address");
	assert(fold.includes("- [m-0007] A done item, ranked like a fact."), "an Active Items entry is addressed the same way");
	assert(listAreas(doc).every((row) => fold.split(`[${row.id}`).length === 2), "every entry is addressed exactly once");

	// Red-without: the room's own render is untouched — no addresses, and the
	// whole document — because the room reads its memory as words, not as a map,
	// and the budget counts those words.
	assert(!plain.includes("[m-0001]") && plain.includes("## Chronos") && plain.includes("## Recent Context"), "the room's context render gains no addresses and loses no section");
	assert(renderMemoryDocument(doc, "storage") === RANKING_DOC, "and the storage render is still the file it parsed");
	assert(!renderMemoryDocument(doc, "storage", { entryIds: true }).includes("[m-0001]"), "storage keeps its metadata comments and takes no inline address");

	// The addresses are the ONLY difference: strip them and the fold render is
	// the two sections as the room reads them.
	const stripped = fold.replace(/\[m-\d+(?: · pinned)?\] /g, "");
	const sectionsOnly = renderMemoryDocument(doc, "context", { sections: MEMORY_SECTIONS });
	assert(stripped === sectionsOnly, `an address costs its own characters and nothing else (${firstDifference(stripped, sectionsOnly)})`);

	// A paragraph entry takes the same marker, without a bullet to hang it on.
	const prose = parseMemoryDocument(`## Deep Memory\n\n<!-- entries: next=2 -->\n\n### Context\n\n<!-- e: id=m-0001 kind=fact saved=2026-01-01 -->\nThe room exists to keep the renewal cycle honest.\n`);
	assert(renderMemoryDocument(prose, "context", { entryIds: true, sections: MEMORY_SECTIONS }).includes("[m-0001] The room exists to keep the renewal cycle honest."), "a paragraph entry carries its address as a prefix");
	console.log("  fold render: two sections, every entry addressed once, the room's own render untouched");
}

// --- 5. Demotion to budget ----------------------------------------------------

{
	const pinnedIds = listAreas(syntheticMigrated).filter((_, i) => i % 400 === 0).map((row) => row.id);
	const withPins = pinnedIds.reduce<Doc>((doc, id) => applyUserEdit(doc, { op: "pin", id }).doc, syntheticMigrated);
	const keepIds = listAreas(withPins).filter((row) => !pinnedIds.includes(row.id)).slice(0, 5).map((row) => row.id);
	const before = reviewTargetTokens(withPins);
	assert(before > 50000, `the field case starts well over budget (${before})`);

	const result = demoteToBudget(withPins, 20000, { keepIds, today: "2026-09-12" });
	const after = reviewTargetTokens(result.doc);
	assert(after <= 20000 && result.overageTokens === 0, `demotion reaches the budget (${after} tokens, overage ${result.overageTokens})`);
	assert(after === estimateTokens(renderMemoryDocument(result.doc, "context").slice(renderMemoryDocument(result.doc, "context").indexOf("## Deep Memory"), renderMemoryDocument(result.doc, "context").indexOf("## Recent Context"))), "the budget pass's running size is the render's size, not an approximation");
	assert(result.demoted.length > 0 && entryCount(result.doc) + result.demoted.length === entryCount(withPins), "every entry that left the core is reported");
	for (const id of pinnedIds) assert(findEntry(result.doc, id), `pinned entry ${id} survives the budget pass`);
	for (const id of keepIds) assert(findEntry(result.doc, id), `kept entry ${id} survives the budget pass`);
	assert(!result.demoted.some((e) => e.pinned || keepIds.includes(e.id)), "nothing pinned or kept is ever in the demoted list");
	assert(withPins.topics.length === result.doc.topics.length, "demotion removes entries, never topics — the topic keeps its name and its archive pointer");
	assert(entryCount(syntheticMigrated) === entryCount(withPins), "demoteToBudget is pure: the source document is untouched");
	console.log(`  demotion: ${before} -> ${after} tokens, ${result.demoted.length} entries archived`);

	// A budget nothing can reach: everything demotable goes and the overage is stated.
	const impossible = demoteToBudget(withPins, 10, { keepIds, today: "2026-09-12" });
	assert(impossible.overageTokens > 0, "a budget the pins alone exceed is reported as an overage, not silently met");
	assert(reviewTargetTokens(impossible.doc) === 10 + impossible.overageTokens, "the overage is exactly what the room is still over by");
	const openItem = (e: { kind: string; status?: string }) => e.kind === "item" && e.status === "open";
	assert(impossible.doc.topics.every((t) => t.entries.every((e) => e.pinned || keepIds.includes(e.id) || openItem(e))), "what is left when the budget cannot be met is exactly the pinned, the kept and the open items");
	assert(impossible.protectedOpenItems === impossible.doc.topics.flatMap((t) => t.entries).filter((e) => openItem(e) && !e.pinned && !keepIds.includes(e.id)).length && impossible.protectedOpenItems > 0, `the open items the protection alone kept are counted (${impossible.protectedOpenItems})`);
	assert(result.protectedOpenItems === 0, "a budget that was reached counts no protected open item");

	// What this run saved today goes last, so a fold's own material is not archived by the same run.
	const today = "2026-09-12";
	const fresh = applyUserEdit(withPins, { op: "add", topic: "Company context", kind: "fact", text: "- Folded in by this very run.", saved: today }).doc;
	const freshId = listAreas(fresh).find((row) => row.firstLine === "- Folded in by this very run.")!.id;
	assert(findEntry(demoteToBudget(fresh, 20000, { today }).doc, freshId), "an entry saved today is demoted last");

	// A protected topic: no entry of it leaves, whatever its rank, and the
	// address is matched case-insensitively, trimmed.
	const takenFirst = result.demoted[0];
	const protectedTopic = findEntryLocation(withPins, takenFirst.id)!.topic;
	const address = memoryTopicAddress(protectedTopic.section, protectedTopic.title);
	assert(address === `${protectedTopic.section}/${protectedTopic.title}`, `a topic address is "Section/Title" (${address})`);
	const protectedRun = demoteToBudget(withPins, 20000, { keepIds, keepTopics: [`  ${address.toUpperCase()}  `], today });
	assert(reviewTargetTokens(protectedRun.doc) <= 20000, "the budget is still reached with a topic protected");
	assert(protectedTopic.entries.every((e) => findEntry(protectedRun.doc, e.id)), `every entry of a protected topic survives the budget pass, and ${takenFirst.id} was the first to leave without it`);
	assert(!protectedRun.demoted.some((e) => protectedTopic.entries.some((kept) => kept.id === e.id)), "no entry of a protected topic is in the demoted list");
	assert(protectedRun.demoted.length >= result.demoted.length, "protecting a topic takes other entries in its place, never fewer");
	console.log(`  keepTopics: "${protectedTopic.title}" protected, ${protectedTopic.entries.length} entries stay, ${protectedRun.demoted.length} leave instead of ${result.demoted.length}`);
}

// --- 6. The archive file, its index, and restore -------------------------------

{
	const doc = parseMemoryDocument(RANKING_DOC);
	const demoted = demoteToBudget(doc, 1, { keepIds: [], today: "2026-09-12" });
	assert(demoted.demoted.length === 7, `everything unpinned leaves when the budget is one token (${demoted.demoted.length})`);

	const meta = demoted.demoted.map((entry) => ({ archived: entry.id === "m-0005" ? "2026-09-12" : "2026-08-02", why: "budget" as const, topic: entry.kind === "item" ? "Active Items" : "Ranking", section: (entry.kind === "item" ? "Active Items" : "Deep Memory") as "Active Items" | "Deep Memory" }));
	const archive = appendToArchive("", demoted.demoted, meta);
	const parsed = parseArchive(archive);
	assert(parsed.length === 7 && parsed.every((e) => e.why === "budget" && e.topic && e.section), "every archived entry keeps its id, its topic and why it left");
	assert(parsed.map((e) => e.id).join(" ") === demoted.demoted.map((e) => e.id).join(" "), "the archive keeps the entries in the order they were appended");
	assert(parsed.find((e) => e.id === "m-0005")!.kind === "practice" && parsed.find((e) => e.id === "m-0005")!.text.includes("numbers first"), "an archived entry carries its kind and its text");
	assert(renderArchive(parsed) === renderArchive(parseArchive(renderArchive(parsed))), "the archive render round-trips through its own parser");

	// Appending to a file that already holds entries adds to it and keeps the rest.
	const grown = appendToArchive(archive, [findEntry(doc, "m-0006")!], [{ archived: "2026-09-12", why: "user", topic: "Ranking", section: "Deep Memory" }]);
	assert(parseArchive(grown).length === 8 && parseArchive(grown)[7].why === "user", "an append adds to what is already there");
	assert(parseArchive(grown).slice(0, 7).map((e) => e.id).join(" ") === parsed.map((e) => e.id).join(" "), "an append never disturbs the entries already in the file");

	const removed = removeFromArchive(grown, "m-0005");
	assert(removed.entry?.id === "m-0005" && parseArchive(removed.text).length === 7 && !parseArchive(removed.text).some((e) => e.id === "m-0005"), "removing takes exactly that entry out");
	assert(removeFromArchive(removed.text, "m-9999").text === removed.text, "removing an entry that is not there changes nothing");
	assert(renderArchive(parseArchive(removed.text)) === renderArchive(parseArchive(renderArchive(parseArchive(removed.text)))), "what remains after a removal is still a well-formed archive");

	// The index, and the pointer line the context render adds for it.
	const index = archiveIndex(parsed);
	const ranking = index[memoryAreaId("Deep Memory", "Ranking")];
	assert(ranking.count === 6 && ranking.earliest === "2026-08" && ranking.latest === "2026-09", `the index counts per topic with its archived-month range (${JSON.stringify(ranking)})`);
	assert(index[memoryAreaId("Active Items", "Active Items")].count === 1, "Active Items is indexed like any other topic");
	const context = renderMemoryDocument(demoted.doc, "context", { archiveIndex: index });
	assert(context.includes("_Archived: 6 older notes from Aug to Sep 2026; use memory_recall to read them._"), `the topic's pointer line is appended at the end of the topic (${context})`);
	assert(context.includes("_Archived: 1 older note from Aug 2026; use memory_recall to read them._"), "Active Items carries its own pointer line");
	assert(context.indexOf("_Archived: 6 older") < context.indexOf("## Active Items"), "a Deep Memory topic's pointer sits inside Deep Memory");
	assert(!renderMemoryDocument(demoted.doc, "context").includes("_Archived:"), "without an index there is no pointer line");
	assert(!renderMemoryDocument(demoted.doc, "storage", { archiveIndex: index }).includes("_Archived:"), "the pointer belongs to the context render, never to the file");

	// Restore puts an entry back, and recreates the topic when it is gone.
	const emptied = demoted.doc;
	assert(emptied.topics.find((t) => t.title === "Ranking")!.entries.map((e) => e.id).join() === "m-0006", "only the pinned entry is left in the Ranking topic");
	const withoutTopic: Doc = { ...emptied, topics: emptied.topics.filter((t) => t.title !== "Ranking") };
	const restored = restoreEntry(withoutTopic, parsed.find((e) => e.id === "m-0002")!);
	const recreated = restored.topics.find((t) => t.title === "Ranking");
	assert(recreated && recreated.section === "Deep Memory" && recreated.heading === "### Ranking", "a restore recreates the topic the entry came from");
	assert(recreated!.entries.length === 1 && recreated!.entries[0].id === "m-0002" && recreated!.entries[0].refs === 3, "the restored entry keeps its id and its provenance");
	assert(entryMetadataLine(recreated!.entries[0]) === "<!-- e: id=m-0002 kind=fact saved=2026-01-01 refs=3 -->", "and renders back into the file as the entry it was");
	assert(!withoutTopic.topics.some((t) => t.title === "Ranking"), "restoreEntry is pure: the source document is untouched");
	const backIntoLive = restoreEntry(emptied, parsed.find((e) => e.id === "m-0001")!);
	assert(backIntoLive.topics.find((t) => t.title === "Ranking")!.entries.map((e) => e.id).join() === "m-0006,m-0001", "a restore into a topic that still exists appends at its end");
}

// --- 7. User edits -------------------------------------------------------------

{
	const base = parseMemoryDocument(RANKING_DOC);

	const edited = applyUserEdit(base, { op: "edit", id: "m-0001", text: "- Reworded by hand.", today: "2026-09-12" });
	assert(findEntry(edited.doc, "m-0001")!.text === "- Reworded by hand." && findEntry(edited.doc, "m-0001")!.updated === "2026-09-12", "an edit replaces the text and stamps the update");
	assert(findEntry(base, "m-0001")!.text !== "- Reworded by hand.", "applyUserEdit is pure");
	assert(findEntry(applyUserEdit(base, { op: "edit", id: "m-0001", text: "- **must-keep** now." }).doc, "m-0001")!.pinned, "an edit that adds a must-keep marker pins the entry");

	const deleted = applyUserEdit(base, { op: "delete", id: "m-0003" });
	assert(!findEntry(deleted.doc, "m-0003") && deleted.archived?.id === "m-0003", "a delete hands the entry back so the caller can archive it with why=user");
	assert(parseArchive(appendToArchive("", [deleted.archived!], [{ archived: "2026-09-12", why: "user", topic: "Ranking", section: "Deep Memory" }]))[0].why === "user", "and it archives like any other entry");

	assert(findEntry(applyUserEdit(base, { op: "pin", id: "m-0002" }).doc, "m-0002")!.pinned, "pin pins");
	assert(!rankEntriesForDemotion(applyUserEdit(base, { op: "pin", id: "m-0002" }).doc).some((e) => e.id === "m-0002"), "a pinned entry leaves the demotion order");
	assert(!findEntry(applyUserEdit(base, { op: "unpin", id: "m-0006" }).doc, "m-0006")!.pinned, "unpin unpins");
	assert(rankEntriesForDemotion(applyUserEdit(base, { op: "unpin", id: "m-0006" }).doc).some((e) => e.id === "m-0006"), "and the entry rejoins the demotion order");

	const moved = applyUserEdit(base, { op: "move", id: "m-0002", topic: "Commercial terms" });
	const target = moved.doc.topics.find((t) => t.title === "Commercial terms");
	assert(target && target.section === "Deep Memory" && target.heading === "### Commercial terms" && target.entries.map((e) => e.id).join() === "m-0002", "a move to a topic that does not exist creates it");
	assert(!moved.doc.topics.find((t) => t.title === "Ranking")!.entries.some((e) => e.id === "m-0002"), "and takes the entry out of the old one");
	assert(moved.doc.topics.filter((t) => t.section === "Deep Memory").length === 2 && moved.doc.topics[moved.doc.topics.length - 1].section === "Active Items", "a new Deep Memory topic goes to the end of Deep Memory, never after Active Items");
	assert(findEntryLocation(moved.doc, "m-0002")!.topic.title === "Commercial terms", "and the entry is found in its new topic");

	const added = applyUserEdit(base, { op: "add", topic: "Ranking", kind: "practice", text: "- Added by hand. (saved 2026-09-12)", saved: "2026-09-12" });
	const addedId = formatEntryId(base.nextEntryNumber);
	assert(findEntry(added.doc, addedId)?.kind === "practice" && added.doc.nextEntryNumber === base.nextEntryNumber + 1, "an add takes the next id from the counter and advances it");
	assert(findEntryLocation(added.doc, addedId)!.topic.title === "Ranking", "and lands in the topic it was given");
	const addedItem = applyUserEdit(base, { op: "add", topic: "Active Items", kind: "item", text: "- A new open loop.", saved: "2026-09-12" });
	assert(findEntryLocation(addedItem.doc, addedId)!.topic.section === "Active Items" && findEntry(addedItem.doc, addedId)!.status === "open", "a new item joins Active Items and starts open");

	assert(applyUserEdit(base, { op: "delete", id: "m-9999" }).archived === undefined, "an edit against an id that is not there changes nothing");
	assert(renderMemoryDocument(applyUserEdit(base, { op: "delete", id: "m-9999" }).doc, "storage") === RANKING_DOC, "and leaves the file exactly as it stood");
	assert(findEntry(base, "") === undefined, "an empty id addresses nothing");
}

// --- 8. CRLF and trailing spaces ------------------------------------------------

{
	const withTrailing = PROSE_ROOM.replace("- Collect the current projects and priorities.", "- Collect the current projects and priorities.   ");
	const crlf = withTrailing.replace(/\n/g, "\r\n");
	const doc = parseMemoryDocument(crlf);
	assert(memoryDocumentEol(doc) === "\r\n", "the document's own terminator is the one the render writes back");
	const { doc: migrated } = migrateMemoryDocument(doc, { fallbackSaved: FALLBACK_SAVED });
	const storage = renderMemoryDocument(migrated, "storage");
	assert(!/(?<!\r)\n/.test(storage), "a CRLF file is written back as CRLF throughout, metadata lines included");
	assert(storage.includes("- Collect the current projects and priorities.   \r\n"), "a line's trailing spaces are identity and survive the render");
	const again = renderMemoryDocument(parseMemoryDocument(storage), "storage");
	assert(again === storage, `a CRLF storage file round-trips byte for byte (${firstDifference(storage, again)})`);
	assert(migrateMemoryDocument(parseMemoryDocument(storage), { fallbackSaved: FALLBACK_SAVED }).assigned === 0, "and migrating it again assigns nothing");

	// A multi-line entry: sub-bullets and a wrapped line stay with their bullet.
	const LOOSE = `## Deep Memory

### Shape

- A bullet with a wrapped line
  that continues here.
  - and a sub-bullet.

- A second bullet.

## Active Items

- One item.
`;
	const loose = migrateMemoryDocument(parseMemoryDocument(LOOSE), { fallbackSaved: FALLBACK_SAVED }).doc;
	const shape = loose.topics.find((t) => t.title === "Shape")!;
	assert(shape.entries.length === 2, `a bullet takes its continuation and sub-bullets with it (${shape.entries.length} entries)`);
	assert(shape.entries[0].text === "- A bullet with a wrapped line\n  that continues here.\n  - and a sub-bullet.", `the entry holds its lines exactly (${JSON.stringify(shape.entries[0].text)})`);
	const looseStorage = renderMemoryDocument(loose, "storage");
	assert(renderMemoryDocument(parseMemoryDocument(looseStorage), "storage") === looseStorage, "a multi-line entry round-trips byte for byte");
}

// --- 9. An archive id claimed twice: the newest row is the one that goes ------

// A run that minted its versioned ids against its own rows only wrote a second
// `m-0031-v1` under the first. Undo takes back the rows the latest save added,
// so a removal by id must take the LAST row appended, never the first — and a
// writer that unions the archive's ids with its own mints `-v2` instead.
{
	const older = { id: "m-0031-v1", kind: "fact" as const, saved: "2026-01-01", pinned: false, text: "- The first text this entry had." };
	const newer = { ...older, text: "- The text the latest save replaced." };
	const meta = { why: "superseded" as const, topic: "Ranking", section: "Deep Memory" as const };
	const first = appendToArchive("", [older], [{ ...meta, archived: "2026-08-01" }]);
	const twice = appendToArchive(first, [newer], [{ ...meta, archived: "2026-09-01" }]);
	assert(archiveIdsTaken(twice).join(" ") === "m-0031-v1 m-0031-v1", `every id the archive holds is reported, duplicates included (${archiveIdsTaken(twice).join(" ")})`);
	assert(nextVersionedEntryId("m-0031", archiveIdsTaken(twice)) === "m-0031-v2", "a writer that consults the archive mints the next version, not the one already taken");
	assert(nextVersionedEntryId("m-0031", [...archiveIdsTaken(twice), "m-0031-v2"]) === "m-0031-v3", "and its own run's rows count on top of the archive's");

	const removed = removeFromArchive(twice, "m-0031-v1");
	assert(removed.entry?.text === newer.text && removed.entry.archived === "2026-09-01", `removing a duplicated id takes the newest row, the last one appended (${JSON.stringify(removed.entry)})`);
	const left = parseArchive(removed.text);
	assert(left.length === 1 && left[0].text === older.text && left[0].archived === "2026-08-01", "the older row stays exactly where it was");
	assert(removed.text === first, "and the archive is byte for byte the file from before the second row landed");
	assert(removeFromArchive(removed.text, "m-0031-v1").entry?.text === older.text, "a second removal takes the row that is left");
	console.log("  archive: a duplicated id is removed newest first");
}

// --- 10. A file without its counter recovers it from the ids it carries -------

const COUNTERLESS_DOC = `<!-- exxeta:l1b schema_version=1 -->

## Deep Memory

### Ranking

<!-- e: id=m-0001 kind=fact saved=2026-01-01 -->
- The first note.

<!-- e: id=m-0003 kind=fact saved=2026-01-01 -->
- The third note; the second is in the archive.

## Active Items

<!-- e: id=m-0002 kind=item saved=2026-01-01 status=open -->
- An open item, numbered before the third note.
`;

{
	const doc = parseMemoryDocument(COUNTERLESS_DOC);
	assert(doc.nextEntryNumber === 4, `a file with ids and no counter recovers one past its highest id, got ${doc.nextEntryNumber}`);
	const added = applyUserEdit(doc, { op: "add", topic: "Ranking", kind: "fact", text: "- Added after the counter went missing.", saved: "2026-09-15" }).doc;
	assert(findEntry(added, "m-0004")?.text === "- Added after the counter went missing.", "the next add mints m-0004, not a second m-0001");
	assert(renderMemoryDocument(added, "storage").includes("<!-- entries: next=5 -->"), "and the render writes the counter back into the file");
	assert(parseMemoryDocument(PROSE_ROOM).nextEntryNumber === 1, "a file with no ids at all still starts at 1");
	assert(parseMemoryDocument(RANKING_DOC).nextEntryNumber === 9, "a file that has its counter keeps it, whatever its ids say");

	assert(entryBaseId("m-0031-v2") === "m-0031" && entryBaseId("m-0031") === "m-0031" && entryBaseId("") === "", "an id's base is the id without its version suffix");
	assert(highestEntryNumber(["m-0003", "m-0007-v1", "m-0002-v4", "RC-0009", ""]) === 7, "the highest number counts versions under their base and ignores what is not an entry id");
	assert(highestEntryNumber([]) === 0, "no ids, no number");
	console.log("  counter: recovered from the ids when the line is missing");
}

// --- 11. A note's text is words, never structure ----------------------------

{
	assert(findStructuralLine("## Heading") === "## Heading", "a heading line is structural");
	assert(findStructuralLine("- fine\n### Topic\n- also fine") === "### Topic", "a heading inside the text is found, and reported as the line it is");
	assert(findStructuralLine("- fine\r\n## Topic") === "## Topic", "under CRLF too");
	assert(findStructuralLine("   ## Indented") === "   ## Indented", "leading whitespace does not hide a heading");
	assert(findStructuralLine("# ") === "# ", "a lone hash and a space is a heading with no title");
	assert(findStructuralLine("#") === "#", "a lone hash at the end of its line is too");
	assert(findStructuralLine("<!-- e: id=m-0001 kind=fact saved=2026-01-01 -->\n- A pasted note.") === "<!-- e: id=m-0001 kind=fact saved=2026-01-01 -->", "a pasted metadata comment is structural: it would claim another note's id");
	assert(findStructuralLine("- fine\n  <!-- entries: next=1 -->") === "  <!-- entries: next=1 -->", "so is a counter line, indented or not");
	assert(findStructuralLine("- The launch is tagged #q4 and #launch.") === null, "a hashtag inside a line is a word");
	assert(findStructuralLine("#q4 opens the line and is still a word.") === null, "a hashtag at the start of a line is a word: no space follows the hash");
	assert(findStructuralLine("- ## not a heading: the bullet comes first") === null, "hashes after a bullet are words, as the file's own parser reads them");
	assert(findStructuralLine("- A bullet\n  that wraps\n  - and nests.") === null, "plain notes, wrapped and nested, have no structural line");
	assert(findStructuralLine("") === null, "nothing has none");

	const base = parseMemoryDocument(RANKING_DOC);
	for (const text of ["## Heading", "- ok\n### Topic", "<!-- e: id=m-0001 kind=fact saved=2026-01-01 -->", "  # indented"]) {
		let refused = false;
		try { applyUserEdit(base, { op: "add", topic: "Ranking", kind: "fact", text, saved: "2026-09-15" }); } catch { refused = true; }
		assert(refused, `an add with a structural line is refused at the model too (${JSON.stringify(text)})`);
		refused = false;
		try { applyUserEdit(base, { op: "edit", id: "m-0001", text }); } catch { refused = true; }
		assert(refused, `and so is an edit (${JSON.stringify(text)})`);
	}
	assert(findEntry(applyUserEdit(base, { op: "add", topic: "Ranking", kind: "fact", text: "- Tagged #q4.", saved: "2026-09-15" }).doc, "m-0009")?.text === "- Tagged #q4.", "a hashtag is still added");
	assert(findEntry(applyUserEdit(base, { op: "edit", id: "m-0001", text: "#q4 leads the line." }).doc, "m-0001")?.text === "#q4 leads the line.", "and still edited in");
	console.log("  text: headings and comments are refused, hashtags are words");
}

// --- 12. A restore puts a note in the core once, never beside itself ---------

{
	const doc = parseMemoryDocument(RANKING_DOC);
	const row = (id: string) => ({ id, kind: "fact" as const, saved: "2026-01-01", pinned: false, text: "- A copy that never left.", archived: "2026-09-01", why: "user" as const, topic: "Ranking", section: "Deep Memory" as const });
	const refuses = (fn: () => unknown, label: string) => {
		try { fn(); } catch { return; }
		throw new Error(`${label}: expected a refusal`);
	};
	assert(findEntryVersion(doc, "m-0001")?.entry.id === "m-0001", "the note itself is a version of its id");
	assert(findEntryVersion(doc, "m-0001-v1")?.entry.id === "m-0001", "an older text's id names the note in the core by its base");
	assert(findEntryVersion(doc, "m-9999") === undefined && findEntryVersion(doc, "") === undefined, "an id no note shares, or no id, names nothing");
	refuses(() => restoreEntry(doc, row("m-0001")), "restoring a row whose id is in the core");
	refuses(() => restoreEntry(doc, row("m-0001-v1")), "restoring an older text while the note is in the core");
	refuses(() => restoreEntries(doc, [row("m-0100"), row("m-0001")]), "a batch with one row already in the core");
	refuses(() => restoreEntries(doc, [row("m-0100"), row("m-0100-v1")]), "a batch that would put two versions of one note in");
	assert(!findEntry(doc, "m-0100"), "a refused batch leaves the source untouched");

	// The other way round: an older text that was restored while the note was
	// out of the core is the note's one place now, and the newer text waits.
	const withOlder = restoreEntry(applyUserEdit(doc, { op: "delete", id: "m-0001" }).doc, row("m-0001-v1"));
	assert(findEntry(withOlder, "m-0001-v1") && !findEntry(withOlder, "m-0001"), "an older text restores fine when the note is out of the core");
	refuses(() => restoreEntry(withOlder, row("m-0001")), "restoring the newer text beside the older one");
	assert(findEntry(restoreEntry(applyUserEdit(withOlder, { op: "delete", id: "m-0001-v1" }).doc, row("m-0001")), "m-0001"), "and it restores once the older one has left");
	assert(restoreEntry(doc, row("m-0100-v3")).nextEntryNumber === 101, "a restored version lifts the counter past its base");
	console.log("  restore: one note, one place");
}

console.log("memory-entries smoke passed");
