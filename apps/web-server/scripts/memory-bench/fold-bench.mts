// Fold quality bench — the run and the scores (memory v2, stream F).
//
// The size bench next door asks whether a Memorize run FITS. This one asks
// whether a fold is RIGHT. It folds a fixture's sessions into a fixture's core
// memory one at a time, through the product's own fold layer — buildFoldPrompt,
// parseFoldOps, validateFoldOps, applyFoldOps — and scores the memory that
// comes out against the answer key the fixture planted.
//
// Two modes, one loop:
//   - offline, against a scripted model (prompt in, reply out). This is the
//     default and needs no provider. The `exact` variant must score every
//     category perfectly: a scorer that cannot say "all right" about a right
//     run cannot be trusted to say "wrong" about a wrong one.
//   - a real model, when FOLD_BENCH_MODEL=<provider/model> is set and that
//     provider is connected. The call goes through the same worker the product
//     uses (runIsolatedPersistentAgentWorker), so the judgment numbers are
//     measured on the real path, not on an imitation of it. The sessions are
//     rendered PLAIN for a real model: the markers stay, the fixture's answers
//     do not.
//
// Judgment is never an exit code. The process exits non-zero only on a
// MECHANICAL failure — the parser, the validator or the applier throwing, or a
// fixture the entry model cannot read. A model that folds badly is a table with
// low numbers in it, which is the whole point of having the table.
//
// Run it from apps/web-server:
//   npx tsx scripts/memory-bench/fold-bench.mts
//   npx tsx scripts/memory-bench/fold-bench.mts --variant lazy
//   FOLD_BENCH_MODEL=anthropic/claude-sonnet-4-5 npx tsx scripts/memory-bench/fold-bench.mts

import {
	applyFoldOps,
	buildFoldPrompt,
	EMPTY_FOLD_GUIDANCE,
	FOLD_TRIGGER_PROMPT,
	parseFoldOps,
	summarizeFold,
	validateFoldOps,
	type FoldOp,
	type FoldRecord,
} from "../../src/absorb-ops.js";
import {
	listAreas,
	MEMORY_SECTIONS,
	migrateMemoryDocument,
	parseMemoryDocument,
	renderMemoryDocument,
	reviewTargetTokens,
	type MemoryDocument,
} from "../../src/memory-entries.js";
import { estimateTokens } from "../../src/token-estimate.js";
import { buildFoldFixture, type FoldFixture, type Plant } from "./fold-fixtures.mjs";
import { refusingThenExactFoldModel, SCRIPTED_FOLD_MODELS, SCRIPTED_FOLD_VARIANTS, type ScriptedFoldVariant } from "./fold-models.mjs";

// --- The run's fixed points --------------------------------------------------

/** The approval date the whole run is stamped with; fixed, so two runs compare. */
const RUN_DATE = "2026-09-12";
const RUN_NOW = new Date(`${RUN_DATE}T09:00:00.000Z`);
const AGENT_ID = "fold-bench-room";

/** The assessment the fold prompt carries: the user's first approval point, fixed here. */
const ASSESSMENT = `## Absorb assessment

Eight sessions are waiting. Most carry one or two durable points; two are working noise.

### What to remember
- Commercial commitments, product decisions and anything the user asked to keep exactly.

### What to forget
- Tool trouble, small talk, and sessions that only repeat what memory already holds.

### What changes in stable memory
- Deep Memory: the newer state replaces the entry that carries the older one.
- Active Items: what the sessions finished is closed.
- Recent Context: every folded session leaves it.

### Needs your judgment
- None
`;

// --- Arguments ---------------------------------------------------------------

interface BenchArgs {
	seed?: number;
	variants: ScriptedFoldVariant[];
	plain: boolean;
	showPrompt: boolean;
}

function parseArgs(argv: string[]): BenchArgs {
	const args: BenchArgs = { variants: ["exact", "lazy", "decorated"], plain: false, showPrompt: false };
	for (let i = 0; i < argv.length; i++) {
		const flag = argv[i];
		const next = () => {
			const value = argv[++i];
			if (value === undefined) throw new Error(`${flag} needs a value`);
			return value;
		};
		if (flag === "--seed") args.seed = Number(next());
		else if (flag === "--variant") {
			const value = next();
			if (value === "all") args.variants = [...SCRIPTED_FOLD_VARIANTS];
			else {
				if (!(SCRIPTED_FOLD_VARIANTS as readonly string[]).includes(value)) throw new Error(`--variant must be one of ${SCRIPTED_FOLD_VARIANTS.join(", ")}, or all`);
				args.variants = [value as ScriptedFoldVariant];
			}
		} else if (flag === "--plain") args.plain = true;
		else if (flag === "--show-prompt") args.showPrompt = true;
		else throw new Error(`Unknown flag: ${flag}`);
	}
	return args;
}

// --- The fold loop -----------------------------------------------------------

/** What a model is, to this bench: a prompt in, a reply out. */
type FoldGenerator = (prompt: string) => Promise<{ text: string; usage?: { input?: number; output?: number; cost?: number }; truncated?: boolean }>;

interface SessionRun {
	sessionId: string;
	attempts: number;
	/** Refusals that still stood after the one retry; a refused session changes nothing. */
	refusals: string[];
	/** Refusals the first attempt drew, whether or not the retry cleared them. */
	firstRefusals: string[];
	record?: FoldRecord;
	opCount: number;
	promptTokens: number[];
	replyTokens: number[];
	usage: { input: number; output: number; cost: number };
}

interface RunResult {
	doc: MemoryDocument;
	runs: SessionRun[];
	mechanical: string[];
	tokensBefore: number;
	tokensAfter: number;
	entriesBefore: number;
	entriesAfter: number;
}

/** What a fold reads, the way the run builds it: the two sections a fold changes, every entry carrying its id. */
function coreContextOf(doc: MemoryDocument): string {
	return renderMemoryDocument(doc, "context", { entryIds: true, sections: MEMORY_SECTIONS }).trim();
}

/**
 * The Retry Notice, built the way the maintenance workers build theirs: the
 * original prompt, then the reasons as they were named, then the ask again.
 * One retry per session, and never two notices stacked on one prompt.
 */
function buildFoldRetryPrompt(prompt: string, reasons: string[]): string {
	return `${prompt.trimEnd()}\n\n---\n\n## Retry Notice\n\nYour previous operations were refused:\n\n${reasons.map((reason) => `- ${reason}`).join("\n")}\n\nAnswer again with the narrative and exactly one \`\`\`json fence holding \`{"ops": [ ... ]}\`, resolving every reason above. Copy entry ids exactly as they are listed, and name only what this session changes.\n`;
}

function countEntries(doc: MemoryDocument): number {
	return doc.topics.reduce((total, topic) => total + topic.entries.length, 0);
}

async function runFold(fixture: FoldFixture, generate: FoldGenerator, opts: { plain: boolean; showPrompt: boolean }): Promise<RunResult> {
	const parsed = parseMemoryDocument(fixture.memoryMarkdown);
	const migrated = migrateMemoryDocument(parsed, { fallbackSaved: RUN_DATE });
	const mechanical: string[] = [];
	if (migrated.assigned !== 0) mechanical.push(`the fixture memory needed ${migrated.assigned} id(s) assigned; it should already be in the v2 storage format`);
	if (countEntries(migrated.doc) !== fixture.coreEntries.length) {
		mechanical.push(`the entry model read ${countEntries(migrated.doc)} entries out of a fixture that planted ${fixture.coreEntries.length}`);
	}
	let doc = migrated.doc;
	const tokensBefore = reviewTargetTokens(doc);
	const entriesBefore = countEntries(doc);
	const runs: SessionRun[] = [];

	for (const [index, session] of fixture.sessions.entries()) {
		const text = opts.plain ? session.plainText : session.annotatedText;
		const run: SessionRun = { sessionId: session.id, attempts: 0, refusals: [], firstRefusals: [], opCount: 0, promptTokens: [], replyTokens: [], usage: { input: 0, output: 0, cost: 0 } };
		const areas = listAreas(doc);
		const assembly = buildFoldPrompt({
			agentId: AGENT_ID,
			model: { provider: "bench", model: "scripted" },
			coreContext: coreContextOf(doc),
			areas,
			assessmentMarkdown: ASSESSMENT,
			guidance: { ...EMPTY_FOLD_GUIDANCE, pin: [], drop: [], corrections: [], topics: [], instructions: [] },
			session: { id: session.id, text },
			sessionIndex: index + 1,
			sessionCount: fixture.sessions.length,
			now: RUN_NOW,
		});
		if (opts.showPrompt && index === 0) console.log(`\n--- the fold prompt of ${session.id} ---\n${assembly.prompt}\n--- end of prompt ---\n`);

		let prompt = assembly.prompt;
		let ops: FoldOp[] = [];
		let refusals: string[] = [];
		for (let attempt = 1; attempt <= 2; attempt++) {
			run.attempts = attempt;
			run.promptTokens.push(estimateTokens(prompt));
			let reply: Awaited<ReturnType<FoldGenerator>>;
			try {
				reply = await generate(prompt);
			} catch (error) {
				refusals = [`the fold call failed: ${(error as Error).message}`];
				run.replyTokens.push(0);
				break;
			}
			run.replyTokens.push(estimateTokens(reply.text));
			run.usage.input += reply.usage?.input ?? 0;
			run.usage.output += reply.usage?.output ?? 0;
			run.usage.cost += reply.usage?.cost ?? 0;
			const read = parseFoldOps(reply.text);
			ops = read.ops;
			refusals = read.problems.length > 0 ? read.problems : validateFoldOps(read.ops, areas, { id: session.id, text });
			if (reply.truncated) refusals = [...refusals, "the reply was cut at the model's output limit"];
			if (attempt === 1) run.firstRefusals = refusals;
			if (refusals.length === 0) break;
			if (attempt === 2) break;
			prompt = buildFoldRetryPrompt(assembly.prompt, refusals);
		}

		run.refusals = refusals;
		if (refusals.length === 0) {
			try {
				const applied = applyFoldOps(doc, ops, { sessionId: session.id, savedDate: RUN_DATE, nextEntryNumber: doc.nextEntryNumber });
				doc = applied.doc;
				run.record = applied.record;
				run.opCount = ops.length;
			} catch (error) {
				mechanical.push(`${session.id}: applying validated operations threw — ${(error as Error).message}`);
			}
		}
		runs.push(run);
	}

	// FOLD_BENCH_DUMP=<file>: the memory as the folds left it, for reading a
	// miss by eye — a fact the scorer calls missing may be there in other words.
	if (process.env.FOLD_BENCH_DUMP) {
		const { writeFileSync } = await import("node:fs");
		writeFileSync(process.env.FOLD_BENCH_DUMP, `${renderMemoryDocument(doc, "context", { entryIds: true, sections: MEMORY_SECTIONS })}\n\n---\n\n${runs.map((run) => `## ${run.sessionId} · ${run.opCount} ops · ${run.refusals.length ? `refused: ${run.refusals.join("; ")}` : "applied"}`).join("\n")}\n`);
	}

	return { doc, runs, mechanical, tokensBefore, tokensAfter: reviewTargetTokens(doc), entriesBefore, entriesAfter: countEntries(doc) };
}

// --- Scoring -----------------------------------------------------------------

interface ScoreLine {
	/** Which planted thing this line is about. */
	subject: string;
	passed: boolean;
	detail: string;
}

interface Category {
	name: string;
	lines: ScoreLine[];
}

interface FlatEntry {
	id: string;
	topic: string;
	section: string;
	pinned: boolean;
	status?: string;
	text: string;
}

function flatten(doc: MemoryDocument): FlatEntry[] {
	return doc.topics.flatMap((topic) => topic.entries.map((entry) => ({ id: entry.id, topic: topic.title, section: topic.section, pinned: entry.pinned, status: entry.status, text: entry.text })));
}

function normalize(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

// A planted line's own words, so a note the model wrote WITHOUT the reference
// code still counts: the code is scaffolding a careful model drops as noise,
// and the fact is what the room needed. A line matches when nearly all of its
// distinctive words appear in one note.
let wordingByMarker = new Map<string, string>();

function distinctiveWords(text: string): string[] {
	return normalize(text).toLowerCase().replace(/\(ref [^)]*\)/g, "").replace(/[^a-z0-9 ]+/g, " ").split(" ").filter((word) => word.length >= 4);
}

function carriesWording(entry: FlatEntry, line: string): boolean {
	const words = distinctiveWords(line);
	if (words.length === 0) return false;
	const haystack = ` ${distinctiveWords(entry.text).join(" ")} `;
	const present = words.filter((word) => haystack.includes(` ${word} `)).length;
	return present / words.length >= 0.8;
}

function carrying(entries: FlatEntry[], marker: string): FlatEntry[] {
	const line = wordingByMarker.get(marker);
	return entries.filter((entry) => entry.text.includes(marker) || (line !== undefined && carriesWording(entry, line)));
}

function score(fixture: FoldFixture, result: RunResult): Category[] {
	wordingByMarker = new Map([
		...fixture.coreEntries.map((entry) => [entry.marker, entry.text] as const),
		// A reversal or correction line opens with its framing ("That is now
		// reversed:", "Correction to what was said on …:"); the state it carries
		// is what the note has to hold.
		...fixture.answerKey.map((plant) => [plant.marker, plant.kind === "reversal" || plant.kind === "correction-new" ? plant.line.replace(/^[^:]*:\s*/, "") : plant.line] as const),
	]);
	const entries = flatten(result.doc);
	const runById = new Map(result.runs.map((run) => [run.sessionId, run]));
	const plantsOf = (kind: Plant["kind"]) => fixture.answerKey.filter((plant) => plant.kind === kind);
	const categories: Category[] = [];

	categories.push({
		name: "facts captured",
		lines: plantsOf("fact").map((plant) => {
			const found = carrying(entries, plant.marker);
			const right = found.filter((entry) => entry.topic === plant.expectedTopic);
			return {
				subject: `${plant.session} ${plant.marker}`,
				passed: right.length === 1,
				detail: right.length === 1 ? `under "${plant.expectedTopic}"` : found.length === 0 ? `missing (expected under "${plant.expectedTopic}")` : `in "${found.map((entry) => entry.topic).join('", "')}" instead of "${plant.expectedTopic}"`,
			};
		}),
	});

	categories.push({
		name: "reversals applied",
		lines: plantsOf("reversal").map((plant) => {
			const record = runById.get(plant.session)?.record;
			const touched = [...(record?.superseded ?? []), ...(record?.updated ?? [])].some((change) => change.id === plant.expectedTargetId);
			const newPresent = carrying(entries, plant.marker).length === 1;
			const oldGone = plant.supersedesMarker ? carrying(entries, plant.supersedesMarker).length === 0 : true;
			return {
				subject: `${plant.session} ${plant.marker}`,
				passed: newPresent && (oldGone || touched),
				detail: !newPresent ? "the newer state is not in memory" : oldGone ? `${plant.expectedTargetId} carries the newer state` : touched ? `${plant.expectedTargetId} was superseded but the older text is still in memory` : `added beside ${plant.expectedTargetId} instead of superseding it`,
			};
		}),
	});

	categories.push({
		name: "items closed",
		lines: plantsOf("completion").map((plant) => {
			const target = entries.find((entry) => entry.id === plant.expectedTargetId);
			return {
				subject: `${plant.session} ${plant.expectedTargetId}`,
				passed: target?.status === "done",
				detail: target ? (target.status === "done" ? "closed" : `still ${target.status ?? "open"}`) : "the item left memory without being closed",
			};
		}),
	});

	categories.push({
		name: "must-keep pinned and exact",
		lines: plantsOf("mustkeep").map((plant) => {
			const found = carrying(entries, plant.marker);
			const withoutCode = (text: string) => normalize(text.replace(/\s*\(ref [^)]*\)/g, ""));
			const exact = found.some((entry) => withoutCode(entry.text).includes(withoutCode(plant.exactText ?? "")));
			const pinned = found.some((entry) => entry.pinned);
			return {
				subject: `${plant.session} ${plant.marker}`,
				passed: found.length === 1 && exact && pinned,
				detail: found.length === 0 ? "missing" : !exact ? "in memory but reworded" : !pinned ? "in memory, exact, but not pinned" : found.length > 1 ? `in memory ${found.length} times` : `pinned and word for word, under "${found[0].topic}"`,
			};
		}),
	});

	categories.push({
		name: "chatter dropped with a reason",
		lines: plantsOf("chatter").map((plant) => {
			const record = runById.get(plant.session)?.record;
			const reason = record?.dropped?.reason?.trim() ?? "";
			const added = record?.added.length ?? 0;
			return {
				subject: plant.session,
				passed: Boolean(reason) && added === 0,
				detail: !record ? "the session was refused, not dropped" : reason ? (added === 0 ? `dropped: ${reason.slice(0, 48)}` : "dropped, but entries were added too") : `not dropped: ${added} entr${added === 1 ? "y" : "ies"} added`,
			};
		}),
	});

	categories.push({
		name: "corrections resolved to the later state",
		lines: plantsOf("correction-new").map((plant) => {
			const newFound = carrying(entries, plant.marker);
			const oldFound = plant.supersedesMarker ? carrying(entries, plant.supersedesMarker) : [];
			return {
				subject: `${plant.session} ${plant.marker}`,
				passed: newFound.length === 1 && oldFound.length === 0,
				detail: newFound.length === 0 ? "the corrected state never reached memory" : oldFound.length > 0 ? "memory holds both the corrected state and the one it replaced" : newFound.length > 1 ? `the corrected state is in memory ${newFound.length} times` : "the later state stands alone",
			};
		}),
	});

	categories.push({
		name: "pins honoured",
		lines: plantsOf("pin").map((plant) => {
			const target = entries.find((entry) => entry.id === plant.expectedTargetId);
			return {
				subject: `${plant.session} ${plant.expectedTargetId}`,
				passed: target?.pinned === true,
				detail: !target ? "the entry the user asked to pin left memory" : target.pinned ? "pinned" : "the user asked for it and it is not pinned",
			};
		}),
	});

	categories.push({
		name: "noise excluded",
		lines: plantsOf("noise").map((plant) => {
			const found = carrying(entries, plant.marker);
			return {
				subject: `${plant.session} ${plant.marker}`,
				passed: found.length === 0,
				detail: found.length === 0 ? "not in memory" : `became an entry under "${found[0].topic}"`,
			};
		}),
	});

	// One line per marker that two entries carry, and a single passing line when
	// none does — a category that is one row either way.
	const markers = [...new Set([...fixture.coreEntries.map((entry) => entry.marker), ...fixture.answerKey.map((plant) => plant.marker)])];
	const doubled = markers.map((marker) => ({ marker, found: carrying(entries, marker) })).filter((row) => row.found.length > 1);
	categories.push({
		name: "nothing duplicated",
		lines: doubled.length > 0
			? doubled.map((row) => ({ subject: row.marker, passed: false, detail: `${row.found.length} entries carry it` }))
			: [{ subject: "every marker", passed: true, detail: "no marker is carried by two entries" }],
	});

	return categories;
}

// --- Printing ----------------------------------------------------------------

function pad(value: string | number, width: number, right = false): string {
	const text = String(value);
	return right ? text.padStart(width) : text.padEnd(width);
}

function printSessionTable(result: RunResult): void {
	console.log(`${pad("session", 9)}${pad("ops", 4, true)}${pad("add", 5, true)}${pad("upd", 5, true)}${pad("sup", 5, true)}${pad("close", 6, true)}${pad("pin", 5, true)}${pad("drop", 6, true)}${pad("calls", 7, true)}${pad("prompt", 8, true)}${pad("reply", 7, true)}  outcome`);
	for (const run of result.runs) {
		const summary = run.record ? summarizeFold(run.record) : undefined;
		const pinned = run.record?.pinned.length ?? 0;
		const outcome = run.refusals.length > 0 ? `REFUSED: ${run.refusals[0].slice(0, 60)}` : run.firstRefusals.length > 0 ? `applied after one retry (${run.firstRefusals.length} refusal${run.firstRefusals.length === 1 ? "" : "s"})` : "applied";
		console.log(
			pad(run.sessionId, 9) +
				pad(run.opCount, 4, true) +
				pad(summary?.added ?? 0, 5, true) +
				pad(summary?.updated ?? 0, 5, true) +
				pad(summary?.superseded ?? 0, 5, true) +
				pad(summary?.closed ?? 0, 6, true) +
				pad(pinned, 5, true) +
				pad(summary?.dropped ? "yes" : "no", 6, true) +
				pad(run.attempts, 7, true) +
				pad(Math.max(...run.promptTokens), 8, true) +
				pad(Math.max(0, ...run.replyTokens), 7, true) +
				`  ${outcome}`,
		);
	}
}

function printCategories(categories: Category[]): void {
	console.log(`${pad("category", 38)}${pad("score", 8, true)}  verdict`);
	for (const category of categories) {
		const passed = category.lines.filter((line) => line.passed).length;
		const total = category.lines.length;
		const misses = category.lines.filter((line) => !line.passed);
		const verdict = total === 0 ? "nothing planted" : misses.length === 0 ? "all right" : misses.map((line) => `${line.subject}: ${line.detail}`).join("; ");
		console.log(`${pad(category.name, 38)}${pad(`${passed}/${total}`, 8, true)}  ${verdict}`);
	}
}

function printSizeStory(result: RunResult): void {
	const prompts = result.runs.flatMap((run) => run.promptTokens);
	const replies = result.runs.flatMap((run) => run.replyTokens);
	const added = result.runs.reduce((total, run) => total + (run.record?.added.length ?? 0), 0);
	const usage = result.runs.reduce((total, run) => ({ input: total.input + run.usage.input, output: total.output + run.usage.output, cost: total.cost + run.usage.cost }), { input: 0, output: 0, cost: 0 });
	console.log(
		[
			`entries ${result.entriesBefore} -> ${result.entriesAfter} (${added} added by folds)`,
			`memory ${result.tokensBefore} -> ${result.tokensAfter} tokens`,
			`prompt per call ${Math.min(...prompts)}-${Math.max(...prompts)} tokens`,
			`largest reply ${Math.max(...replies)} tokens`,
			`calls ${prompts.length} for ${result.runs.length} sessions`,
		].join(" · "),
	);
	if (usage.input || usage.output || usage.cost) {
		console.log(`provider usage: in ${usage.input} tok · out ${usage.output} tok · $${usage.cost.toFixed(4)}`);
	}
}

function totalScore(categories: Category[]): { passed: number; total: number } {
	return categories.reduce(
		(total, category) => ({ passed: total.passed + category.lines.filter((line) => line.passed).length, total: total.total + category.lines.length }),
		{ passed: 0, total: 0 },
	);
}

// --- The refusal rehearsal ---------------------------------------------------

/**
 * One session folded by a model that names an entry the memory does not hold,
 * so every offline run exercises the validator's refusal and the Retry Notice
 * rather than leaving that path to a real model's bad day.
 */
async function rehearseRefusal(fixture: FoldFixture): Promise<string> {
	const model = refusingThenExactFoldModel();
	const single: FoldFixture = { ...fixture, sessions: fixture.sessions.slice(0, 1) };
	const result = await runFold(single, async (prompt) => ({ text: model(prompt) }), { plain: false, showPrompt: false });
	const run = result.runs[0];
	if (result.mechanical.length > 0) return `MECHANICAL: ${result.mechanical.join("; ")}`;
	if (run.firstRefusals.length === 0) return "the first reply was not refused — the refusal rehearsal proved nothing";
	if (run.refusals.length > 0) return `the retry was refused too: ${run.refusals[0]}`;
	return `first reply refused (${run.firstRefusals[0].slice(0, 72)}), retry applied ${run.opCount} operations`;
}

// --- The real model ----------------------------------------------------------

/**
 * The real-model generator, through the same isolated worker the product's
 * maintenance calls use. No server is needed: the registry is built from the
 * signed-in providers on this machine exactly the way the server builds it.
 */
async function realModelGenerator(spec: string): Promise<{ generate: FoldGenerator; label: string }> {
	const slash = spec.indexOf("/");
	if (slash < 1) throw new Error(`FOLD_BENCH_MODEL must read provider/model, e.g. anthropic/claude-sonnet-4-5 — got "${spec}"`);
	const modelLock = { provider: spec.slice(0, slash), model: spec.slice(slash + 1) };
	const { AuthStorage, getAgentDir, ModelRegistry } = await import("@exxeta/exxperts-runtime");
	const { runIsolatedPersistentAgentWorker } = await import("../../src/persistent-agent-worker-runtime.js");
	const { stripProviderSearchFromModel } = await import("../../../../pi-package/extensions/web-search/native-provider-search.js");
	const registry = ModelRegistry.create(AuthStorage.create());
	const found = registry.find(modelLock.provider, modelLock.model);
	if (!found) throw new Error(`model not found: ${spec} — check the id, or sign the provider in first (AI setup)`);
	if (!registry.hasConfiguredAuth(found)) throw new Error(`provider not connected: ${modelLock.provider} — sign in first (AI setup), then rerun`);
	const model = stripProviderSearchFromModel(found);
	const repoRoot = new URL("../../../../", import.meta.url).pathname;
	const generate: FoldGenerator = async (prompt) => {
		const started = Date.now();
		const result = await runIsolatedPersistentAgentWorker({
			workerSystemPrompt: prompt,
			triggerPrompt: FOLD_TRIGGER_PROMPT,
			modelLock,
			resolveExpectedModel: () => model,
			workerLabel: "fold bench worker",
			emptyTextError: "the fold worker produced no text",
			cwd: repoRoot,
			agentDir: getAgentDir(),
			modelRegistry: registry,
		});
		console.log(`  call: ${((Date.now() - started) / 1000).toFixed(1)}s · out ${result.usage?.output ?? "?"} tok${result.truncated ? " · CUT at the output limit" : ""}`);
		return { text: result.text, usage: result.usage, truncated: result.truncated };
	};
	return { generate, label: `${modelLock.provider}/${modelLock.model}` };
}

// --- Main --------------------------------------------------------------------

const args = parseArgs(process.argv.slice(2));
const fixture = buildFoldFixture({ seed: args.seed });
const realSpec = process.env.FOLD_BENCH_MODEL?.trim();

console.log(`Fold quality bench · seed ${fixture.seed} · ${fixture.coreEntries.length} core entries in ${fixture.topics.length} topics · ${fixture.sessions.length} sessions · ${fixture.answerKey.length} planted things`);
console.log(`Answer key: ${["fact", "reversal", "completion", "mustkeep", "chatter", "correction-old", "correction-new", "pin", "noise"].map((kind) => `${kind} ${fixture.answerKey.filter((plant) => plant.kind === kind).length}`).join(" · ")}`);

let mechanicalFailures = 0;

if (realSpec) {
	const { generate, label } = await realModelGenerator(realSpec);
	console.log(`\n=== real model: ${label} (sessions rendered plain) ===`);
	const result = await runFold(fixture, generate, { plain: true, showPrompt: args.showPrompt });
	printSessionTable(result);
	console.log("");
	const categories = score(fixture, result);
	printCategories(categories);
	const total = totalScore(categories);
	console.log("");
	printSizeStory(result);
	console.log(`total: ${total.passed}/${total.total} checks passed`);
	for (const failure of result.mechanical) console.log(`MECHANICAL FAILURE: ${failure}`);
	mechanicalFailures += result.mechanical.length;
} else {
	console.log(`\nrefusal rehearsal: ${await rehearseRefusal(fixture)}`);
	for (const variant of args.variants) {
		const model = SCRIPTED_FOLD_MODELS[variant];
		console.log(`\n=== scripted model: ${variant} ===`);
		const result = await runFold(fixture, async (prompt) => ({ text: model(prompt) }), { plain: args.plain, showPrompt: args.showPrompt });
		printSessionTable(result);
		console.log("");
		const categories = score(fixture, result);
		printCategories(categories);
		const total = totalScore(categories);
		console.log("");
		printSizeStory(result);
		console.log(`total: ${total.passed}/${total.total} checks passed`);
		for (const failure of result.mechanical) console.log(`MECHANICAL FAILURE: ${failure}`);
		mechanicalFailures += result.mechanical.length;
		if (variant === "exact" && total.passed !== total.total) {
			console.log("NOTE: the exact variant answers with the planted operations, so anything below a perfect score here is a bug in the bench, not a fold failure.");
		}
	}
}

if (mechanicalFailures > 0) {
	console.log(`\n${mechanicalFailures} mechanical failure(s): the parser, the validator, the applier or the entry model did not hold. Judgment scores above are not the reason for this exit code.`);
	process.exit(1);
}
