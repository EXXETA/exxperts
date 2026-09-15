export {};

// The corpus validators are what decide whether a model batch is corpus-grade;
// this smoke imports the real rules (never a copy) and pins the behaviours the
// generator relies on: template-shaped entries are rejected, stamps and
// must-keep markers stay builder-owned, refs resolve to positional ids, and a
// thin batch names why it was refused.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const {
	benchRoomRefusal,
	CORPUS_BATCH_MIN_FILL,
	countPlantedLineOccurrences,
	CORPUS_ENTRY_WORDS,
	CORPUS_SECTION_THEMES,
	corpusEntryId,
	entrySkeleton,
	extractJsonObject,
	FIXTURE_MARKER_FILENAME,
	isSpecificEntry,
	scorePlantedDuplicatePairs,
	validateCorpus,
	validateCorpusBatch,
	WORLD,
} = await import("./synthetic-room-content.js");

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

const words = (n: number, prefix = "w") => Array.from({ length: n }, (_, i) => `${prefix}${i}`).join(" ");
// Ten genuinely different sentence shapes (the corpus rule is "no two entries
// from one template"), each padded past the word floor.
const SHAPES = [
	(p: string, pr: string, t: string) => `${p} agreed on **40 rows** as the sample size for the ${pr} after the ${t} check`,
	(p: string, pr: string, t: string) => `The ${pr} cut line moved to **Fri 17 Jul** because ${t} alerts kept paging; ${p} owns the retro`,
	(p: string, pr: string, t: string) => `Open question from ${p}: does ${t} stay the system of record once the ${pr} lands`,
	(p: string, pr: string, t: string) => `Incident on 2026-07-03: ${t} dropped **12%** of events for the ${pr}; root cause was a stale schema, ${p} shipped the fix`,
	(p: string, pr: string, t: string) => `${p} prefers written proposals before any ${pr} meeting and reads ${t} dashboards on Mondays`,
	(p: string, pr: string, t: string) => `Authority for the ${pr} definitions is the runbook ${p} maintains next to the ${t} config`,
	(p: string, pr: string, t: string) => `Renewal for ${t} was signed at **€18k** for twelve months; ${p} negotiated the ${pr} clause`,
	(p: string, pr: string, t: string) => `Reversal: the ${pr} will not adopt ${t} this quarter; ${p} withdrew the proposal on 2026-08-02`,
	(p: string, pr: string, t: string) => `Two overrides in the ${t} defaults are documented for the ${pr}; ${p} revisits them **next quarter**`,
	(p: string, pr: string, t: string) => `Working agreement with ${p}: ${pr} changes land behind a review, and ${t} pages the on-call only`,
];
const good = (i: number, kind = "fact") => ({
	id: `e${i}`,
	kind,
	text: `${SHAPES[i % SHAPES.length](WORLD.people[i % WORLD.people.length], WORLD.projects[i % WORLD.projects.length], WORLD.tools[i % WORLD.tools.length])} ${words(12, `pad${i}`)}.`,
	refs: i > 0 ? [`e${i - 1}`] : [],
});
const batchOf = (n: number) => ({ entries: Array.from({ length: n }, (_, i) => good(i, ["fact", "decision", "incident"][i % 3])) });
const ctx = (sectionIndex = 0) => ({ sectionIndex, expectedCount: 10, existingSkeletons: new Set<string>(), existingIds: new Set<string>() });

// 1. Skeletons: same template with swapped names/numbers collapses to one skeleton; different shapes do not.
assert(entrySkeleton("Mara agreed to move the Billing to Kafka on 12 June") === entrySkeleton("Jonas agreed to move the Billing to Postgres on 30 July"), "swapped names and numbers must share a skeleton");
assert(entrySkeleton("Mara agreed to move the Billing to Kafka") !== entrySkeleton("The Billing move to Kafka was agreed by Mara"), "a different sentence shape is a different skeleton");

// 2. Specificity: a number or a world name anchors; a generic sentence does not.
assert(isSpecificEntry("Priya prefers written proposals before meetings"), "a world name anchors an entry");
assert(isSpecificEntry("The rollout finished in 3 weeks"), "a number anchors an entry");
assert(!isSpecificEntry("People generally prefer written proposals before meetings"), "no anchor is not specific");

// 3. JSON extraction: fenced wins; bare object works; nothing → throws.
assert((extractJsonObject("text\n```json\n{\"entries\":[]}\n```\nmore") as any).entries.length === 0, "fenced JSON is extracted");
assert((extractJsonObject("prose {\"entries\":[{\"x\":1}]} trailing") as any).entries.length === 1, "bare JSON object is extracted");
let threw = false;
try { extractJsonObject("no json here"); } catch { threw = true; }
assert(threw, "no JSON must throw");

// 4. A clean batch is accepted, ids are positional, refs resolve to them.
const clean = validateCorpusBatch(batchOf(10), ctx());
assert(clean.problems.length === 0, `clean batch accepted, got: ${clean.problems.join(" | ")}`);
assert(clean.entries.length === 10 && clean.entries[0].id === corpusEntryId(0, 0) && clean.entries[9].id === "s1-e10", "ids are positional within the section");
assert(clean.entries[1].refs.length === 1 && clean.entries[1].refs[0] === "s1-e1", "refs resolve the model's ids to corpus ids");
assert(clean.entries[0].refs.length === 0, "an entry never refs itself or an unknown id");

// 5. Builder-owned decorations are dropped, and a thin batch is refused with the reasons summarized.
const decorated = batchOf(10);
decorated.entries[0].text = `- ${decorated.entries[0].text}`;
decorated.entries[1].text = `${decorated.entries[1].text} (saved 2026-07-01)`;
decorated.entries[2].text = `**must-keep:** ${decorated.entries[2].text}`;
decorated.entries[3].text = words(CORPUS_ENTRY_WORDS.min - 1);
decorated.entries[4].kind = "opinion";
const thin = validateCorpusBatch(decorated, ctx());
assert(thin.entries.length === 5 && thin.dropped.length === 5, `five decorated entries dropped, got ${thin.dropped.length} dropped / ${thin.entries.length} kept`);
assert(thin.problems.length >= 1 && /only 5 of 10 entries were usable/.test(thin.problems[0]), `thin batch refused with the count, got: ${thin.problems.join(" | ")}`);
assert(/bullet marker/.test(thin.problems[0]) && /saved-on stamp/.test(thin.problems[0]) && /must-keep/.test(thin.problems[0]), "the refusal names the dropped classes");
assert(Math.ceil(10 * CORPUS_BATCH_MIN_FILL) === 9, "the fill rule is the imported constant");

// 6. Template batches are refused: ten entries from one skeleton keep one and refuse the rest.
const templated = { entries: Array.from({ length: 10 }, (_, i) => ({ id: `e${i}`, kind: "fact", text: `${WORLD.people[i]} agreed to move the ${WORLD.projects[i]} to ${WORLD.tools[i]}; follow-up owned by ${WORLD.people[(i + 1) % 10]} after the review on 2026-07-0${(i % 9) + 1} with the usual two overrides documented in the runbook.`, refs: [] })) };
const t = validateCorpusBatch(templated, ctx());
assert(t.entries.length === 1 && /same sentence skeleton/.test(t.dropped[0]), "a template batch collapses to one entry");
assert(t.problems.some((p) => /usable/.test(p)), "and is refused for fill");

// 7. Cross-section duplicates and unknown refs: a skeleton already in the corpus is rejected; refs to corpus ids survive.
const prior = validateCorpusBatch(batchOf(10), ctx(0));
const later = validateCorpusBatch({ entries: [{ ...good(0), id: "e0", refs: ["s1-e3", "nope"] }, ...batchOf(10).entries.slice(1).map((e, i) => ({ ...e, id: `e${i + 1}`, text: `${e.text} extra`, refs: [] }))] }, { sectionIndex: 1, expectedCount: 10, existingSkeletons: new Set(prior.entries.map((e) => entrySkeleton(e.text))), existingIds: new Set(prior.entries.map((e) => e.id)) });
assert(later.dropped.length === 10 && later.entries.length === 0 && later.dropped.every((d) => /same sentence skeleton/.test(d)), `entries repeating an earlier section's skeletons are dropped, got kept=${later.entries.length} dropped=${later.dropped.length}`);
const refsOk = validateCorpusBatch({ entries: [{ id: "e0", kind: "pointer", text: `The authority for the ${WORLD.projects[0]} cut line is the roadmap page Keiko maintains ${words(16, "q")}.`, refs: ["s1-e3", "nope"] }] }, { sectionIndex: 1, expectedCount: 1, existingSkeletons: new Set(), existingIds: new Set(prior.entries.map((e) => e.id)) });
assert(refsOk.entries[0].refs.join(",") === "s1-e3", "refs to earlier-section ids survive, unknown ones are dropped silently");

// 8. Corpus invariants catch duplicate ids, duplicate skeletons across sections, and dangling refs.
const corpus = { provenance: {} as any, sections: [{ topic: CORPUS_SECTION_THEMES[0].topic, entries: prior.entries }, { topic: CORPUS_SECTION_THEMES[1].topic, entries: [{ ...prior.entries[0], id: "s2-e1", refs: ["ghost"] }] }] };
const invariants = validateCorpus(corpus as any);
assert(invariants.some((p) => /duplicate skeleton/.test(p)) && invariants.some((p) => /unknown ghost/.test(p)), `invariants name the duplicate skeleton and the dangling ref, got: ${invariants.join(" | ")}`);
assert(validateCorpus({ provenance: {} as any, sections: [{ topic: "t", entries: prior.entries }] }).length === 0, "a clean corpus has no invariant problems");

console.log("synthetic-room-content smoke passed");

// --- Corpus-mode assembly -------------------------------------------------------
{
	const { buildCorpusActiveItems, buildCorpusDeepMemory, mulberry32, PLANT_RATES } = await import("./synthetic-room-content.js");
	const { estimateTokens } = await import("../src/token-estimate.js");
	const kinds = ["fact", "decision", "open_question", "incident", "pointer", "preference"] as const;
	const tiny = {
		provenance: {} as any,
		sections: CORPUS_SECTION_THEMES.slice(0, 3).map((theme, s) => ({
			topic: theme.topic,
			entries: Array.from({ length: 40 }, (_, i) => ({
				id: `s${s + 1}-e${i + 1}`,
				kind: kinds[i % kinds.length],
				text: `${SHAPES[i % SHAPES.length](WORLD.people[(i + s) % 10], WORLD.projects[(i * 3 + s) % 10], WORLD.tools[(i * 7 + s) % 10])} section ${s + 1} item ${i + 1} ${words(10, `c${s}i${i}`)}.`,
				refs: [],
			})),
		})),
	};

	// 9. Same seed → same bytes; a different seed → different bytes. Target size reached.
	const a = buildCorpusDeepMemory(mulberry32(3), tiny, 6_000, 4, estimateTokens);
	const b = buildCorpusDeepMemory(mulberry32(3), tiny, 6_000, 4, estimateTokens);
	const c = buildCorpusDeepMemory(mulberry32(4), tiny, 6_000, 4, estimateTokens);
	assert(a.text === b.text, "corpus Deep Memory is deterministic per seed");
	assert(a.text !== c.text, "a different seed lays the room out differently");
	assert(estimateTokens(a.text) >= 6_000 && !a.exhausted, `target size reached without exhausting the corpus (got ${estimateTokens(a.text)} tok, exhausted=${a.exhausted})`);
	assert(/^## Deep Memory\n\n### Collaboration & Working Style\n/.test(a.text), "sections carry the corpus topics in corpus order");

	// 10. Must-keeps are a contract; every planted line is in the text; nothing is emitted twice except planted duplicate pairs.
	const lines = a.text.split("\n").filter((l) => l.startsWith("- "));
	assert(lines.filter((l) => /\*\*must-keep:\*\*/.test(l)).length === 4 && a.planted.mustKeeps.length === 4, "exactly the asked-for must-keeps are placed and recorded");
	for (const group of [a.planted.duplicatePairs, a.planted.superseded, a.planted.supersededBy, a.planted.stale, a.planted.mustKeeps]) {
		for (const line of group) assert(lines.includes(line), `planted line present in the text: ${line.slice(0, 60)}`);
	}
	const counts = new Map<string, number>();
	for (const l of lines) counts.set(l, (counts.get(l) ?? 0) + 1);
	const repeated = [...counts.entries()].filter(([, n]) => n > 1);
	assert(repeated.length === a.planted.duplicatePairs.length && repeated.every(([l, n]) => n === 2 && a.planted.duplicatePairs.includes(l)), `only planted duplicates repeat, exactly twice (repeated=${repeated.length}, planted=${a.planted.duplicatePairs.length})`);
	assert(a.planted.superseded.length === a.planted.supersededBy.length, "every superseded original has its reversal");
	assert(a.planted.stale.every((l) => /^- Revisit by 2026-06-\d\d: .* \(saved 2026-06-\d\d\)$/.test(l)), "stale items name a June revisit-by date and carry a June stamp");
	assert(a.planted.superseded.every((l) => !a.planted.stale.includes(l)), "a stale line is never also a superseded original");
	assert(a.usedIds.size >= 60, `corpus ids used are tracked (${a.usedIds.size})`);

	// 11. Exhaustion is reported, not papered over.
	const dry = buildCorpusDeepMemory(mulberry32(1), tiny, 60_000, 0, estimateTokens);
	assert(dry.exhausted, "a target larger than the corpus reports exhaustion");

	// 12. Active Items draw only unused entries: open questions to focus, decisions/incidents to parked; ids never overlap Deep Memory's.
	const active = buildCorpusActiveItems(tiny, 700, a.usedIds, estimateTokens);
	assert(!active.exhausted && estimateTokens(active.text) >= 700, "Active Items reach their target from the leftovers");
	for (const id of active.usedIds) assert(!a.usedIds.has(id), `Active Items never reuse a Deep Memory entry (${id})`);
	const focusBlock = active.text.slice(active.text.indexOf("### Current Focus"), active.text.indexOf("### Parked"));
	assert(focusBlock.split("\n").filter((l) => l.startsWith("- ")).length >= 1, "Current Focus is populated");
	assert(PLANT_RATES.duplicate > 0 && PLANT_RATES.superseded > 0 && PLANT_RATES.stale > 0, "plant rates are the imported constants");
}

// 12b. The duplicate metric counts survivors, not absence: keeping one copy of
// a planted pair is the CORRECT action and must score as a hit, while losing
// both copies is a loss. The floors and the keep ratio are calibrated off this
// number, so it has to mean what it says before it calibrates anything.
{
	const pair = "- Mara signed the renewal at EUR 18k for twelve months. (saved 2026-06-02)";
	const other = "- Jonas reads dashboards on Monday mornings. (saved 2026-08-15)";
	const room = (...lines: string[]) => countPlantedLineOccurrences(["## Deep Memory", "", ...lines, ""].join("\n"));
	const kept = scorePlantedDuplicatePairs([pair], room(pair, other));
	assert(kept.planted === 1 && kept.prunedToOne === 1 && kept.stillDoubled === 0 && kept.bothGone === 0, `one surviving copy is the hit (got ${JSON.stringify(kept)})`);
	const untouched = scorePlantedDuplicatePairs([pair], room(pair, other, pair));
	assert(untouched.prunedToOne === 0 && untouched.stillDoubled === 1, `both copies still there is a miss (got ${JSON.stringify(untouched)})`);
	const lost = scorePlantedDuplicatePairs([pair], room(other));
	assert(lost.prunedToOne === 0 && lost.bothGone === 1, `both copies gone is a loss, never a hit (got ${JSON.stringify(lost)})`);
	assert(countPlantedLineOccurrences("- a\n  - a  \n\n- b\n").get("- a") === 2, "occurrences are counted on the trimmed line, blank lines ignored");
}

// 13. Tooling safety: the bench writes to rooms, so it only ever writes to the
// builder's own, and both tools' run folders stay out of the repo's history.
{
	assert(FIXTURE_MARKER_FILENAME === "synthetic-fixture.json", "the marker name is the ONE constant both tools read");
	assert(benchRoomRefusal("Big Memory Fixture", true, false) === null, "a room carrying the marker is benched without ceremony");
	const refusal = benchRoomRefusal("Personal Room", false, false);
	assert(refusal && refusal.includes("carries no synthetic-fixture.json marker"), `a room without the marker is refused by name (got ${String(refusal)})`);
	assert(refusal!.includes("--real-room") && refusal!.includes("--no-approve") && refusal!.includes("approves the result into that room's memory"), "the refusal says what the run would have cost and how to ask for it anyway");
	assert(benchRoomRefusal("Personal Room", false, true) === null, "--real-room is the way past the gate, and the only one");

	const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
	const gitignore = fs.readFileSync(path.join(repoRoot, ".gitignore"), "utf-8").split("\n").map((line) => line.trim());
	assert(gitignore.includes("scratch/"), "scratch/ is ignored — a bench run folder holds a full copy of the room it benched");
}

console.log("synthetic-room-content smoke passed (corpus assembly)");
