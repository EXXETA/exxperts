// Synthetic room content — the pure half of the fixture tooling (no I/O, no
// model): the shared world the fixtures live in, the corpus shape the
// generator freezes, and the validators that decide whether a model batch is
// corpus-grade. Imported by synthetic-corpus-generate.ts and by its smoke, so
// the tests exercise the real rules rather than a copy of them.
//
// Why a corpus at all: the template builder's content is "five sentence
// templates instantiated with rotating names" (the model's own words, F8),
// and a Review collapses it in one pass. Real rooms are hard to prune because
// nearly every entry carries a distinct claim a careful model wants to keep.
// A corpus of such entries, generated once and frozen, is what makes a
// fixture behave like a real room — and stay byte-identical across builds.

export const WORLD = {
	people: ["Mara", "Jonas", "Priya", "Tomás", "Ingrid", "Sam", "Ulrike", "Dario", "Keiko", "Lennart"],
	projects: [
		"Lakehouse migration",
		"Billing reconciliation",
		"Customer 360",
		"Observability rollout",
		"Vendor consolidation",
		"Data-quality program",
		"Self-serve analytics",
		"Cost governance",
		"Identity re-platforming",
		"Regulatory reporting",
	],
	tools: ["Grafana", "Airflow", "dbt", "Terraform", "Postgres", "Kafka", "Snowflake", "GitLab CI", "Metabase", "ArgoCD"],
	/** The room's owner as the model should address them; matches the builder's scaffold user. */
	user: "Synthetic User",
	/** Stamp window the builder spreads saved-on dates over; entries may name dates inside it. */
	window: { start: "2026-06-01", end: "2026-08-30" },
} as const;

/** One theme per Deep Memory section; names match the template builder's SECTION_TOPICS one to one. */
export const CORPUS_SECTION_THEMES: ReadonlyArray<{ topic: string; brief: string }> = [
	{ topic: "Collaboration & Working Style", brief: "How the user and each named colleague actually work together: review habits, meeting rhythms, communication preferences, friction points and what resolved them." },
	{ topic: "Project Notes", brief: "Concrete state of the named projects: milestones hit or slipped, scope calls, blockers, who owns what next, numbers that matter (rows, latencies, costs, dates)." },
	{ topic: "Infrastructure Decisions", brief: "Architecture and platform decisions with their rationale and the alternatives rejected: storage, orchestration, CI, deployment, networking, retention." },
	{ topic: "Stakeholder Context", brief: "What each stakeholder cares about, has asked for, has been promised, and how they react to delays, cost, and risk; escalation paths." },
	{ topic: "Data & Reporting", brief: "Datasets, models, dashboards and reports: definitions agreed, discrepancies found and their root causes, SLAs, refresh cadences, owners." },
	{ topic: "Vendor & Procurement", brief: "Contracts, renewals, pricing tiers, negotiation outcomes, vendor commitments and misses, procurement process constraints." },
	{ topic: "Team & Hiring", brief: "Open roles, interview loops, onboarding plans, skills gaps, individual growth conversations, staffing changes and their effects." },
	{ topic: "Process Agreements", brief: "Working agreements and their exceptions: on-call, code review, change windows, incident comms, documentation duties, how agreements were amended." },
	{ topic: "Incident Learnings", brief: "Specific incidents: what broke, impact in numbers, root cause, the fix, the follow-ups and whether they were done." },
	{ topic: "Planning & Roadmap", brief: "Quarterly goals, sequencing decisions, cut lines, dependencies between the named projects, dates committed to whom." },
	{ topic: "Customer Feedback", brief: "What named customer accounts or internal consumers reported, asked for, or praised; what was promised back and what happened." },
	{ topic: "Compliance Notes", brief: "Regulatory and policy constraints that shape the work: data residency, retention, audit asks, access reviews, evidence produced." },
];

export const CORPUS_ENTRY_KINDS = ["decision", "fact", "preference", "incident", "open_question", "pointer"] as const;
export type CorpusEntryKind = (typeof CORPUS_ENTRY_KINDS)[number];

export interface CorpusEntry {
	id: string;
	kind: CorpusEntryKind;
	/** One memory bullet without its leading "- " and without a saved-on stamp; the builder adds both. */
	text: string;
	/** Ids of earlier entries this one builds on (same section or an earlier one). */
	refs: string[];
}

export interface CorpusSection {
	topic: string;
	entries: CorpusEntry[];
}

export interface SyntheticRoomCorpus {
	provenance: {
		generatedBy: "synthetic-corpus-generate.ts";
		generatedAt: string;
		model: { provider: string; model: string };
		seed: number;
		/** sha256 over the style rules and section briefs — a different prompt is a different corpus. */
		promptHash: string;
		perSection: number;
		usage: { input: number; output: number; cost: number };
	};
	sections: CorpusSection[];
}

/** Word bounds for one entry: real Deep Memory bullets run one to three dense sentences. */
export const CORPUS_ENTRY_WORDS = { min: 22, max: 95 } as const;
/** A batch is accepted when at least this share of the asked-for count came back valid. */
export const CORPUS_BATCH_MIN_FILL = 0.9;
/** At least this share of a batch must carry a concrete anchor (number, date, or a world name). */
export const CORPUS_MIN_SPECIFIC_SHARE = 0.75;

export function wordCount(text: string): number {
	return text.trim().split(/\s+/).filter(Boolean).length;
}

/**
 * Sentence skeleton for near-duplicate detection: lowercase, world names and
 * numbers collapsed to placeholders, first eight tokens. Two entries with the
 * same skeleton are the template pattern the corpus exists to avoid.
 */
export function entrySkeleton(text: string): string {
	// Multi-word world names ("GitLab CI", "Lakehouse migration") collapse as a
	// unit, so a template that rotates projects is as visible as one that
	// rotates people.
	let collapsed = text.toLowerCase().replace(/\*\*/g, "");
	for (const name of [...WORLD.people, ...WORLD.projects, ...WORLD.tools].map((n) => n.toLowerCase()).sort((a, b) => b.length - a.length)) {
		collapsed = collapsed.split(name).join(" <name> ");
	}
	const tokens = collapsed
		.replace(/<name>/g, "\u0000")
		.replace(/[^\p{L}\p{N}\s\u0000]/gu, " ")
		.split(/\s+/)
		.filter(Boolean)
		.map((t) => (t === "\u0000" ? "<name>" : /^\p{N}/u.test(t) ? "<num>" : t));
	return tokens.slice(0, 8).join(" ");
}

export function isSpecificEntry(text: string): boolean {
	if (/\p{N}/u.test(text)) return true;
	const lower = text.toLowerCase();
	return [...WORLD.people, ...WORLD.projects, ...WORLD.tools].some((n) => lower.includes(n.toLowerCase()));
}

/** The one JSON object in a model reply: a ```json fence when present, else the outermost braces. */
export function extractJsonObject(raw: string): unknown {
	const fenced = /```(?:json)?\s*\n([\s\S]*?)\n\s*```/i.exec(raw);
	const candidate = fenced ? fenced[1] : raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1);
	if (!candidate.trim()) throw new Error("no JSON object in the reply");
	return JSON.parse(candidate);
}

export interface CorpusBatchValidationInput {
	sectionIndex: number;
	expectedCount: number;
	/** Skeletons already in the corpus (earlier sections), for cross-section duplicate detection. */
	existingSkeletons: ReadonlySet<string>;
	/** Ids already in the corpus, which refs may point at. */
	existingIds: ReadonlySet<string>;
}

export interface CorpusBatchValidation {
	entries: CorpusEntry[];
	/** Named reasons the batch is not acceptable; empty means accepted. Each one is written for the model's Retry Notice. */
	problems: string[];
	/** Per-entry rejections that did not sink the batch on their own (dropped entries). */
	dropped: string[];
}

export function corpusEntryId(sectionIndex: number, entryIndex: number): string {
	return `s${sectionIndex + 1}-e${entryIndex + 1}`;
}

/**
 * Turns a parsed model reply into corpus entries, or names why it cannot.
 * Ids are assigned here (positional), so the model's own ids only need to be
 * consistent within the reply for refs to resolve.
 */
export function validateCorpusBatch(parsed: unknown, input: CorpusBatchValidationInput): CorpusBatchValidation {
	const problems: string[] = [];
	const dropped: string[] = [];
	const raw = (parsed as { entries?: unknown })?.entries;
	if (!Array.isArray(raw)) return { entries: [], problems: ["the reply has no `entries` array"], dropped };

	const idMap = new Map<string, string>(); // model id -> corpus id
	const seenSkeletons = new Set<string>();
	const kept: Array<{ entry: CorpusEntry; modelRefs: string[] }> = [];
	raw.forEach((item: any, i: number) => {
		const label = `entry ${i + 1}`;
		const text = typeof item?.text === "string" ? item.text.replace(/\s+/g, " ").trim() : "";
		if (!text) { dropped.push(`${label}: no text`); return; }
		if (/^\s*[-*]\s/.test(item.text)) { dropped.push(`${label}: starts with a bullet marker (the builder adds it)`); return; }
		if (/\(saved\s/i.test(text)) { dropped.push(`${label}: carries a saved-on stamp (the builder adds them)`); return; }
		if (/must-keep/i.test(text)) { dropped.push(`${label}: carries a must-keep marker (the builder places those)`); return; }
		const words = wordCount(text);
		if (words < CORPUS_ENTRY_WORDS.min || words > CORPUS_ENTRY_WORDS.max) { dropped.push(`${label}: ${words} words, outside ${CORPUS_ENTRY_WORDS.min}–${CORPUS_ENTRY_WORDS.max}`); return; }
		const kind = CORPUS_ENTRY_KINDS.includes(item?.kind) ? (item.kind as CorpusEntryKind) : undefined;
		if (!kind) { dropped.push(`${label}: kind must be one of ${CORPUS_ENTRY_KINDS.join(", ")}`); return; }
		const skeleton = entrySkeleton(text);
		if (seenSkeletons.has(skeleton) || input.existingSkeletons.has(skeleton)) { dropped.push(`${label}: same sentence skeleton as an earlier entry ("${skeleton}")`); return; }
		seenSkeletons.add(skeleton);
		const id = corpusEntryId(input.sectionIndex, kept.length);
		if (typeof item?.id === "string" && item.id.trim()) idMap.set(item.id.trim(), id);
		kept.push({ entry: { id, kind, text, refs: [] }, modelRefs: Array.isArray(item?.refs) ? item.refs.filter((r: unknown) => typeof r === "string") : [] });
	});

	// Refs resolve against this reply's ids or the corpus so far; unknown refs are dropped, not fatal.
	for (const { entry, modelRefs } of kept) {
		entry.refs = modelRefs
			.map((r) => idMap.get(r.trim()) ?? (input.existingIds.has(r.trim()) ? r.trim() : undefined))
			.filter((r): r is string => Boolean(r) && r !== entry.id);
	}

	const entries = kept.map((k) => k.entry);
	const minCount = Math.ceil(input.expectedCount * CORPUS_BATCH_MIN_FILL);
	if (entries.length < minCount) problems.push(`only ${entries.length} of ${input.expectedCount} entries were usable (need at least ${minCount}); dropped: ${summarizeDropped(dropped)}`);
	const specific = entries.filter((e) => isSpecificEntry(e.text)).length;
	if (entries.length > 0 && specific / entries.length < CORPUS_MIN_SPECIFIC_SHARE) problems.push(`only ${specific} of ${entries.length} entries carry a concrete anchor (a number, a date, or a named person/project/tool); at least ${Math.round(CORPUS_MIN_SPECIFIC_SHARE * 100)}% must`);
	const kinds = new Set(entries.map((e) => e.kind));
	if (entries.length >= 10 && kinds.size < 3) problems.push(`entries use only ${[...kinds].join(", ")}; mix at least three kinds`);
	return { entries, problems, dropped };
}

function summarizeDropped(dropped: string[]): string {
	if (dropped.length === 0) return "none";
	const reasons = new Map<string, number>();
	for (const d of dropped) {
		const reason = d.replace(/^entry \d+: /, "").replace(/\d+ words/, "N words").replace(/\(".*"\)$/, "");
		reasons.set(reason, (reasons.get(reason) ?? 0) + 1);
	}
	return [...reasons.entries()].map(([r, n]) => `${n}× ${r}`).join("; ");
}

/** Corpus-wide invariants the generator checks before freezing. */
export function validateCorpus(corpus: SyntheticRoomCorpus): string[] {
	const problems: string[] = [];
	const ids = new Set<string>();
	const skeletons = new Set<string>();
	for (const section of corpus.sections) {
		for (const entry of section.entries) {
			if (ids.has(entry.id)) problems.push(`duplicate id ${entry.id}`);
			ids.add(entry.id);
			const skeleton = entrySkeleton(entry.text);
			if (skeletons.has(skeleton)) problems.push(`${entry.id}: duplicate skeleton "${skeleton}"`);
			skeletons.add(skeleton);
		}
	}
	for (const section of corpus.sections) {
		for (const entry of section.entries) {
			for (const ref of entry.refs) if (!ids.has(ref)) problems.push(`${entry.id}: ref to unknown ${ref}`);
		}
	}
	return problems;
}

// =============================================================================
// Room assembly — the content the builder grafts into a scaffolded L1b.
// Two modes: "template" (the original pools, moved here verbatim so a seed
// still reproduces the F-series rooms byte for byte) and "corpus" (entries
// drawn from a frozen corpus, with a recorded amount of legitimately prunable
// material planted so a correct Review has something to do and the bench can
// compare what it removed against what was removable).
// =============================================================================

export type FixtureContentMode = "template" | "corpus";

// Deterministic PRNG (mulberry32) so the same seed always produces the same room.
export function mulberry32(seed: number): () => number {
	let a = seed >>> 0;
	return () => {
		a |= 0;
		a = (a + 0x6d2b79f5) | 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

export function pick<T>(rand: () => number, pool: readonly T[]): T {
	return pool[Math.floor(rand() * pool.length)];
}

// --- Template mode (verbatim from the original builder) ----------------------
// Domain-plausible working-life material. The project pool differs from
// WORLD.projects on purpose: it is frozen so old seeds keep reproducing.

const PEOPLE = ["Mara", "Jonas", "Priya", "Tomás", "Ingrid", "Sam", "Ulrike", "Dario", "Keiko", "Lennart"] as const;
const PROJECTS = [
	"Atlas data pipeline",
	"Meridian dashboard",
	"customer churn model",
	"invoice OCR service",
	"Kubernetes migration",
	"quarterly planning deck",
	"vendor risk audit",
	"Helios API gateway",
	"onboarding revamp",
	"data-quality scorecard",
] as const;
const TOOLS = ["Grafana", "Airflow", "dbt", "Terraform", "Postgres", "Kafka", "Snowflake", "GitLab CI", "Metabase", "ArgoCD"] as const;
const DECISION_VERBS = ["agreed to", "decided against", "postponed", "signed off on", "escalated", "descoped", "prioritized"] as const;
const PREFERENCE_LINES = [
	"prefers short written summaries over meetings when a decision is already made",
	"wants risks flagged in the first paragraph, never buried at the end",
	"likes estimates given as ranges with the assumption that widened them",
	"asks for one recommendation instead of a menu of options",
	"reads dashboards on Monday mornings and expects fresh data by then",
	"dislikes acronyms in customer-facing material",
] as const;
const OUTCOMES = [
	"the rollout finished two days early",
	"the fix held through the following load test",
	"the stakeholder review surfaced no blockers",
	"the migration was rolled back once and completed on the second attempt",
	"the numbers were accepted by controlling without adjustment",
	"the pilot group asked to keep the feature enabled",
] as const;
export const TEMPLATE_SECTION_TOPICS = [
	"Collaboration & Working Style",
	"Project Notes",
	"Infrastructure Decisions",
	"Stakeholder Context",
	"Data & Reporting",
	"Vendor & Procurement",
	"Team & Hiring",
	"Process Agreements",
	"Incident Learnings",
	"Planning & Roadmap",
	"Customer Feedback",
	"Compliance Notes",
] as const;

export function savedDate(rand: () => number, sectionIndex: number, sectionCount: number): string {
	// Older sections carry older stamps: spread saved-on dates across ~3 months
	// (June–August 2026) with per-bullet jitter, so temporal steering has a real
	// gradient to read.
	const start = Date.UTC(2026, 5, 1);
	const end = Date.UTC(2026, 7, 30);
	const sectionCenter = start + ((end - start) * sectionIndex) / Math.max(1, sectionCount - 1);
	const jitter = (rand() - 0.5) * 12 * 24 * 60 * 60 * 1000;
	const stamp = new Date(Math.min(end, Math.max(start, sectionCenter + jitter)));
	return stamp.toISOString().slice(0, 10);
}

function templateBullet(rand: () => number, date: string): string {
	const person = pick(rand, PEOPLE);
	const project = pick(rand, PROJECTS);
	const tool = pick(rand, TOOLS);
	const shapes = [
		() => `${person} ${pick(rand, DECISION_VERBS)} moving the ${project} to ${tool}; ${pick(rand, OUTCOMES)}. (saved ${date})`,
		() => `${person} ${PREFERENCE_LINES[Math.floor(rand() * PREFERENCE_LINES.length)]}. (saved ${date})`,
		() =>
			`On the ${project}, the open question is whether ${tool} stays the system of record; ${person} owns the follow-up. (saved ${date})`,
		() =>
			`The ${project} review with ${person} settled the ${tool} configuration: keep defaults, document the two overrides, revisit next quarter. (saved ${date})`,
		() =>
			`${person} walked through the ${project} numbers; the discrepancy traced back to a stale ${tool} export and ${pick(rand, OUTCOMES)}. (saved ${date})`,
		() =>
			`Working agreement with ${person}: changes to the ${project} land behind a review, and ${tool} alerts page the on-call, not the whole channel. (saved ${date})`,
	];
	return `- ${pick(rand, shapes)()}`;
}

/** Pools the must-keep shapes draw from; template mode keeps its frozen pools, corpus mode uses WORLD. */
interface NamePools {
	people: readonly string[];
	projects: readonly string[];
	tools: readonly string[];
}
const TEMPLATE_POOLS: NamePools = { people: PEOPLE, projects: PROJECTS, tools: TOOLS };
const WORLD_POOLS: NamePools = { people: WORLD.people, projects: WORLD.projects, tools: WORLD.tools };

function mustKeepBullet(rand: () => number, date: string, pools: NamePools = TEMPLATE_POOLS): string {
	const person = pick(rand, pools.people);
	const shapes = [
		() => `- **must-keep:** ${person} is the only approver for production deploys of the ${pick(rand, pools.projects)}. (saved ${date})`,
		() => `- **must-keep:** The contractual reporting deadline is the 5th working day of each month. (saved ${date})`,
		() => `- **must-keep:** Customer data never leaves the EU region; ${pick(rand, pools.tools)} is configured accordingly. (saved ${date})`,
		() => `- **must-keep:** ${person} ${pick(rand, PREFERENCE_LINES)}. (saved ${date})`,
	];
	return pick(rand, shapes)();
}

export function buildTemplateDeepMemory(rand: () => number, targetTokens: number, mustKeepCount: number, estimateTokens: (text: string) => number): string {
	const sections: string[][] = [];
	const sectionCount = Math.max(4, Math.min(TEMPLATE_SECTION_TOPICS.length, Math.round(targetTokens / 4500)));
	for (let i = 0; i < sectionCount; i++) {
		const suffix = i >= TEMPLATE_SECTION_TOPICS.length ? ` ${Math.floor(i / TEMPLATE_SECTION_TOPICS.length) + 1}` : "";
		sections.push([`### ${TEMPLATE_SECTION_TOPICS[i % TEMPLATE_SECTION_TOPICS.length]}${suffix}`, ""]);
	}
	let mustKeepLeft = mustKeepCount;
	const body = () => `## Deep Memory\n\n${sections.map((lines) => lines.join("\n")).join("\n\n")}\n`;
	let i = 0;
	while (estimateTokens(body()) < targetTokens) {
		const sectionIndex = i % sectionCount;
		const date = savedDate(rand, sectionIndex, sectionCount);
		const line =
			mustKeepLeft > 0 && rand() < 0.02 ? ((mustKeepLeft -= 1), mustKeepBullet(rand, date)) : templateBullet(rand, date);
		sections[sectionIndex].push(line);
		i++;
	}
	// Any must-keeps the 2% dice never placed go in explicitly — the count is a contract.
	while (mustKeepLeft > 0) {
		const sectionIndex = Math.floor(rand() * sectionCount);
		sections[sectionIndex].push(mustKeepBullet(rand, savedDate(rand, sectionIndex, sectionCount)));
		mustKeepLeft -= 1;
	}
	return body();
}

export function buildTemplateActiveItems(rand: () => number, targetTokens: number, estimateTokens: (text: string) => number): string {
	const focus: string[] = ["### Current Focus", ""];
	const parked: string[] = ["### Parked", ""];
	const body = () => `## Active Items\n\n${focus.join("\n")}\n\n${parked.join("\n")}\n`;
	let i = 0;
	while (estimateTokens(body()) < targetTokens) {
		const person = pick(rand, PEOPLE);
		const project = pick(rand, PROJECTS);
		const target = i % 3 === 0 ? parked : focus;
		target.push(
			i % 3 === 0
				? `- Revisit the ${project} follow-up with ${person} once the ${pick(rand, TOOLS)} upgrade lands.`
				: `- Close out the ${project} action from ${person}: ${pick(rand, DECISION_VERBS)} the ${pick(rand, TOOLS)} change, confirm ${pick(rand, OUTCOMES)}.`,
		);
		i++;
	}
	return body();
}

// --- Fixture marker and the tooling's room gate -------------------------------

/**
 * The file synthetic-room-build.ts drops into a room it fabricated. It is the
 * only thing that distinguishes a fixture from somebody's real memory, so
 * every tool that may write to a room reads it before acting.
 */
export const FIXTURE_MARKER_FILENAME = "synthetic-fixture.json";

/**
 * The bench's room gate. A bench run costs a paid Review and, unless
 * --no-approve is passed, writes the result into the room's memory. Naming a
 * room on the command line is too easy a way to do that to a real one, so a
 * room without the marker is refused until the caller says so in words — the
 * same stance as the builder's marker-gated --force.
 */
export function benchRoomRefusal(roomLabel: string, hasFixtureMarker: boolean, realRoom: boolean): string | null {
	if (hasFixtureMarker || realRoom) return null;
	return `"${roomLabel}" carries no ${FIXTURE_MARKER_FILENAME} marker, so it is not a room the fixture builder made. A bench run costs a paid Review and approves the result into that room's memory. Build a fixture room with synthetic-room-build.ts, or pass --real-room to bench this one on purpose (with --no-approve to leave its memory untouched).`;
}

// --- Corpus mode -------------------------------------------------------------

/** Share of drawn entries that get a planted prunable companion; bench-tunable, recorded in the marker. */
export const PLANT_RATES = { duplicate: 0.03, superseded: 0.03, stale: 0.04 } as const;
export type PlantRates = { duplicate: number; superseded: number; stale: number };

/**
 * What a correct Review may remove without losing anything, line by line, so
 * the bench can check each one against the after-room. `supersededBy` lines
 * are the reversals that must SURVIVE (the originals in `superseded` are the
 * removable half), and `duplicatePairs` are scored by survivor count rather
 * than by absence — see scorePlantedDuplicatePairs.
 */
export interface PlantedLines {
	/**
	 * One entry per planted PAIR: the room holds each of these lines twice, and
	 * the correct outcome of a Review is exactly one survivor — not none. The
	 * pair, never the single line, is the unit the bench scores.
	 */
	duplicatePairs: string[];
	superseded: string[];
	supersededBy: string[];
	stale: string[];
	mustKeeps: string[];
}

export interface PlantedDuplicateScore {
	/** Pairs planted. */
	planted: number;
	/** Pairs the Review left with exactly one copy — the right action. */
	prunedToOne: number;
	/** Pairs still doubled: the duplicate was not seen. */
	stillDoubled: number;
	/** Pairs the Review removed entirely: not a success, a loss of the entry. */
	bothGone: number;
}

/** Occurrences per trimmed non-blank line — the after-room read as a multiset, since a pair's two copies are one line. */
export function countPlantedLineOccurrences(text: string): Map<string, number> {
	const counts = new Map<string, number>();
	for (const raw of text.split("\n")) {
		const line = raw.trim();
		if (line) counts.set(line, (counts.get(line) ?? 0) + 1);
	}
	return counts;
}

/**
 * Scoring a planted duplicate: exactly one survivor is the outcome the fixture
 * asks for. Presence alone cannot say it — "gone from the after-room" scores
 * keeping one copy (the right action) as a miss and losing both as a success,
 * which is how the floors and the keep ratio would have been calibrated against
 * the wrong signal.
 */
export function scorePlantedDuplicatePairs(pairs: string[], afterLineCounts: Map<string, number>): PlantedDuplicateScore {
	const at = (line: string) => afterLineCounts.get(line.trim()) ?? 0;
	return {
		planted: pairs.length,
		prunedToOne: pairs.filter((line) => at(line) === 1).length,
		stillDoubled: pairs.filter((line) => at(line) >= 2).length,
		bothGone: pairs.filter((line) => at(line) === 0).length,
	};
}

export interface CorpusDeepMemoryResult {
	text: string;
	planted: PlantedLines;
	/** Corpus entry ids that were placed (so Active Items can avoid them). */
	usedIds: Set<string>;
	/** True when the corpus ran dry before the target size was reached. */
	exhausted: boolean;
}

function laterDate(rand: () => number, date: string, sectionCount: number): string {
	// A reversal is stamped after its original: draw from the newest section's
	// window and never earlier than the original.
	const candidate = savedDate(rand, sectionCount - 1, sectionCount);
	return candidate > date ? candidate : "2026-08-30";
}

function revisitDate(date: string): string {
	const d = new Date(`${date}T00:00:00Z`);
	d.setUTCDate(d.getUTCDate() + 14);
	return d.toISOString().slice(0, 10);
}

export function buildCorpusDeepMemory(
	rand: () => number,
	corpus: SyntheticRoomCorpus,
	targetTokens: number,
	mustKeepCount: number,
	estimateTokens: (text: string) => number,
	rates: PlantRates = PLANT_RATES,
): CorpusDeepMemoryResult {
	const sectionCount = corpus.sections.length;
	if (sectionCount === 0) throw new Error("the corpus has no sections");
	const sections: string[][] = corpus.sections.map((s) => [`### ${s.topic}`, ""]);
	const cursors = corpus.sections.map(() => 0);
	// Planted companions wait a few entries before landing in their section.
	const pending: Array<{ sectionIndex: number; after: number; line: string }> = [];
	const planted: PlantedLines = { duplicatePairs: [], superseded: [], supersededBy: [], stale: [], mustKeeps: [] };
	const usedIds = new Set<string>();
	let mustKeepLeft = mustKeepCount;
	const body = () => `## Deep Memory\n\n${sections.map((lines) => lines.join("\n")).join("\n\n")}\n`;
	let i = 0;
	let exhausted = false;
	while (estimateTokens(body()) < targetTokens) {
		const sectionIndex = i % sectionCount;
		i++;
		const due = pending.filter((p) => p.sectionIndex === sectionIndex && p.after <= i);
		for (const p of due) {
			sections[sectionIndex].push(p.line);
			pending.splice(pending.indexOf(p), 1);
		}
		const date = savedDate(rand, sectionIndex, sectionCount);
		if (mustKeepLeft > 0 && rand() < 0.02) {
			mustKeepLeft -= 1;
			const line = mustKeepBullet(rand, date, WORLD_POOLS);
			planted.mustKeeps.push(line);
			sections[sectionIndex].push(line);
			continue;
		}
		const entry = corpus.sections[sectionIndex].entries[cursors[sectionIndex]];
		if (!entry) {
			// This section is dry; if every section is, stop honestly.
			if (cursors.every((c, s) => c >= corpus.sections[s].entries.length)) { exhausted = true; break; }
			continue;
		}
		cursors[sectionIndex] += 1;
		usedIds.add(entry.id);
		const stale = rand() < rates.stale;
		const line = stale
			? `- Revisit by ${revisitDate("2026-06-" + String(1 + Math.floor(rand() * 10)).padStart(2, "0"))}: ${entry.text} (saved 2026-06-${String(1 + Math.floor(rand() * 10)).padStart(2, "0")})`
			: `- ${entry.text} (saved ${date})`;
		if (stale) planted.stale.push(line);
		sections[sectionIndex].push(line);
		if (rand() < rates.duplicate) {
			planted.duplicatePairs.push(line);
			pending.push({ sectionIndex, after: i + sectionCount * (2 + Math.floor(rand() * 5)), line });
		}
		if (!stale && rand() < rates.superseded) {
			const when = laterDate(rand, date, sectionCount);
			const head = entry.text.replace(/\*\*/g, "").split(/\s+/).slice(0, 10).join(" ");
			const reversal = `- ${pick(rand, WORLD.people)} reversed this on ${when}: the note that "${head}…" no longer holds and should not be relied on. (saved ${when})`;
			planted.superseded.push(line);
			planted.supersededBy.push(reversal);
			pending.push({ sectionIndex, after: i + sectionCount * (2 + Math.floor(rand() * 5)), line: reversal });
		}
	}
	// Companions still waiting land at the end of their section; must-keeps the dice never placed go in explicitly.
	for (const p of pending) sections[p.sectionIndex].push(p.line);
	while (mustKeepLeft > 0) {
		const sectionIndex = Math.floor(rand() * sectionCount);
		const line = mustKeepBullet(rand, savedDate(rand, sectionIndex, sectionCount), WORLD_POOLS);
		planted.mustKeeps.push(line);
		sections[sectionIndex].push(line);
		mustKeepLeft -= 1;
	}
	return { text: body(), planted, usedIds, exhausted };
}

export interface CorpusActiveItemsResult {
	text: string;
	usedIds: Set<string>;
	exhausted: boolean;
}

/**
 * Active Items from corpus entries not already in Deep Memory: open questions
 * become Current Focus, decisions and incidents become Parked follow-ups, and
 * any other unused entry fills whichever list is next when those run out.
 */
export function buildCorpusActiveItems(
	corpus: SyntheticRoomCorpus,
	targetTokens: number,
	excludeIds: ReadonlySet<string>,
	estimateTokens: (text: string) => number,
): CorpusActiveItemsResult {
	const unused = corpus.sections.flatMap((s) => s.entries).filter((e) => !excludeIds.has(e.id));
	const focusPool = unused.filter((e) => e.kind === "open_question");
	const parkedPool = unused.filter((e) => e.kind === "decision" || e.kind === "incident");
	const restPool = unused.filter((e) => !focusPool.includes(e) && !parkedPool.includes(e));
	const focus: string[] = ["### Current Focus", ""];
	const parked: string[] = ["### Parked", ""];
	const usedIds = new Set<string>();
	const body = () => `## Active Items\n\n${focus.join("\n")}\n\n${parked.join("\n")}\n`;
	let i = 0;
	let exhausted = false;
	while (estimateTokens(body()) < targetTokens) {
		const toParked = i % 3 === 0;
		const entry = (toParked ? parkedPool : focusPool).shift() ?? restPool.shift();
		if (!entry) { exhausted = true; break; }
		usedIds.add(entry.id);
		(toParked ? parked : focus).push(`- ${entry.text}`);
		i++;
	}
	return { text: body(), usedIds, exhausted };
}
