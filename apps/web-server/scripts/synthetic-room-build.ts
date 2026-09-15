// Synthetic room builder — dev fixture tool, NOT a smoke (never picked up by the
// battery glob). Fabricates a complete, valid room in the live personalized-agents
// root with a Deep Memory of a chosen token size, so memory-lifecycle work can be
// reproduced and measured at real scale (e.g. 54k deep memory vs a 21k budget)
// without months of organic usage.
//
// Everything that matters goes through the product's own code paths: the room is
// created by the real scaffold, sizes come from the ONE estimator and the ONE
// budget numerator, and the budget is written by the real settings writer. Only
// the Deep Memory / Active Items content itself is synthetic.
//
// Usage (repo root):
//   npx tsx apps/web-server/scripts/synthetic-room-build.ts [--name "Big Memory Fixture"]
//     [--deep-tokens 54000] [--active-tokens 4000] [--budget 21000]
//     [--must-keep 6] [--seed 1] [--force]
//     [--content template|corpus] [--corpus apps/web-server/scripts/fixtures/synthetic-room-corpus.json]
//
// --content template (default) is the original pool-generated content: same
// seed + args = same bytes, so the F-series rooms still reproduce. --content
// corpus draws distinct entries from a frozen corpus (see
// synthetic-corpus-generate.ts) and plants a recorded amount of legitimately
// prunable material — exact duplicates, superseded originals, stale
// revisit-by items — so the room behaves like a real one (F8) and the bench
// can compare what a Review removed against what was removable. The marker
// records the mode, the corpus hash and every planted line.
//
// --force deletes ONLY a previous room created by this script (verified by its
// synthetic-fixture.json marker) with the same display name. Real rooms are
// never touched.

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const { createPersistentAgentFromScaffoldInput, PERSISTENT_AGENTS_ROOT, reviewTargetEstimatedTokensFromL1b } = await import(
	"../src/persistent-agents.js"
);
const { MEMORY_BUDGET_MAX_TOKENS, MEMORY_BUDGET_MIN_TOKENS, overMemoryBudget, writePersistentRoomMaintenanceSettings } = await import(
	"../src/persistent-room-maintenance-settings.js"
);
const { estimateTokens } = await import("../src/token-estimate.js");
const { buildCorpusActiveItems, buildCorpusDeepMemory, buildTemplateActiveItems, buildTemplateDeepMemory, FIXTURE_MARKER_FILENAME, mulberry32, PLANT_RATES, validateCorpus } = await import(
	"./synthetic-room-content.js"
);
type FixtureContentMode = import("./synthetic-room-content.js").FixtureContentMode;
type SyntheticRoomCorpus = import("./synthetic-room-content.js").SyntheticRoomCorpus;

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const DEFAULT_CORPUS = path.join("apps", "web-server", "scripts", "fixtures", "synthetic-room-corpus.json");


// Mirrors the creation guard's name normalization (whitespace collapse + NFC +
// lowercase) so --force reclaims exactly what creation would collide with.
function normalizedDisplayName(value: unknown): string {
	return String(value ?? "").replace(/\s+/g, " ").trim().normalize("NFC").toLowerCase();
}

interface BuilderArgs {
	name: string;
	deepTokens: number;
	activeTokens: number;
	budget: number;
	mustKeep: number;
	seed: number;
	force: boolean;
	content: FixtureContentMode;
	corpus: string;
}

function parseArgs(argv: string[]): BuilderArgs {
	const args: BuilderArgs = {
		name: "Big Memory Fixture",
		deepTokens: 54_000,
		activeTokens: 4_000,
		budget: 21_000,
		mustKeep: 6,
		seed: 1,
		force: false,
		content: "template",
		corpus: DEFAULT_CORPUS,
	};
	for (let i = 0; i < argv.length; i++) {
		const flag = argv[i];
		const next = () => {
			const value = argv[++i];
			if (value === undefined) throw new Error(`${flag} needs a value`);
			return value;
		};
		if (flag === "--name") args.name = next();
		else if (flag === "--deep-tokens") args.deepTokens = Number(next());
		else if (flag === "--active-tokens") args.activeTokens = Number(next());
		else if (flag === "--budget") args.budget = Number(next());
		else if (flag === "--must-keep") args.mustKeep = Number(next());
		else if (flag === "--seed") args.seed = Number(next());
		else if (flag === "--force") args.force = true;
		else if (flag === "--content") {
			const value = next();
			if (value !== "template" && value !== "corpus") throw new Error("--content must be template or corpus");
			args.content = value;
		} else if (flag === "--corpus") args.corpus = next();
		else throw new Error(`Unknown flag: ${flag}`);
	}
	for (const [label, value] of [
		["--deep-tokens", args.deepTokens],
		["--active-tokens", args.activeTokens],
		["--budget", args.budget],
		["--must-keep", args.mustKeep],
		["--seed", args.seed],
	] as const) {
		if (!Number.isFinite(value) || value < 0) throw new Error(`${label} must be a non-negative number`);
	}
	for (const [label, value] of [
		["--must-keep", args.mustKeep],
		["--seed", args.seed],
	] as const) {
		if (!Number.isInteger(value)) throw new Error(`${label} must be an integer`);
	}
	if (args.budget < MEMORY_BUDGET_MIN_TOKENS || args.budget > MEMORY_BUDGET_MAX_TOKENS) {
		throw new Error(`--budget must be within [${MEMORY_BUDGET_MIN_TOKENS}, ${MEMORY_BUDGET_MAX_TOKENS}] (product bounds)`);
	}
	return args;
}

// --- Graft into the scaffolded L1b ------------------------------------------

function graft(scaffolded: string, deepMemory: string, activeItems: string): string {
	const deepStart = scaffolded.indexOf("## Deep Memory");
	const activeStart = scaffolded.indexOf("## Active Items");
	const recentStart = scaffolded.indexOf("## Recent Context");
	if (deepStart === -1 || activeStart === -1 || recentStart === -1 || !(deepStart < activeStart && activeStart < recentStart)) {
		throw new Error("Scaffolded L1b does not have the expected section order (Deep Memory / Active Items / Recent Context)");
	}
	// Keep the scaffold's Chronos header block and Recent Context untouched —
	// they carry real ids and timestamps the engine owns.
	return `${scaffolded.slice(0, deepStart)}${deepMemory}\n${activeItems}\n${scaffolded.slice(recentStart)}`;
}

// --- Main --------------------------------------------------------------------

const args = parseArgs(process.argv.slice(2));

// Corpus mode reads and checks its input before any room is created or
// reclaimed, so a bad corpus path cannot leave a half-built room behind.
let corpus: SyntheticRoomCorpus | undefined;
let corpusSha256: string | undefined;
if (args.content === "corpus") {
	const corpusPath = path.resolve(REPO_ROOT, args.corpus);
	if (!fs.existsSync(corpusPath)) {
		throw new Error(`corpus file not found: ${path.relative(REPO_ROOT, corpusPath)} — generate it with synthetic-corpus-generate.ts, or pass --corpus <path>`);
	}
	const raw = fs.readFileSync(corpusPath, "utf-8");
	corpusSha256 = createHash("sha256").update(raw).digest("hex");
	corpus = JSON.parse(raw) as SyntheticRoomCorpus;
	const problems = validateCorpus(corpus);
	if (problems.length > 0) throw new Error(`corpus fails its invariants: ${problems.slice(0, 5).join("; ")}${problems.length > 5 ? ` (+${problems.length - 5} more)` : ""}`);
}

if (args.force) {
	const root: string = PERSISTENT_AGENTS_ROOT;
	if (fs.existsSync(root)) {
		for (const entry of fs.readdirSync(root)) {
			const roomDir = path.join(root, entry);
			const markerPath = path.join(roomDir, FIXTURE_MARKER_FILENAME);
			const agentJsonPath = path.join(roomDir, "agent.json");
			if (!fs.existsSync(markerPath) || !fs.existsSync(agentJsonPath)) continue;
			let displayName: unknown;
			try {
				displayName = JSON.parse(fs.readFileSync(agentJsonPath, "utf-8")).displayName;
			} catch {
				continue;
			}
			if (normalizedDisplayName(displayName) === normalizedDisplayName(args.name)) {
				fs.rmSync(roomDir, { recursive: true });
				console.log(`Removed previous synthetic fixture room at ${roomDir} (marker verified).`);
			}
		}
	}
}

let scaffold: ReturnType<typeof createPersistentAgentFromScaffoldInput>;
try {
	scaffold = createPersistentAgentFromScaffoldInput({
		displayName: args.name,
		userName: "Synthetic User",
		preferredUserAddress: "Synthetic User",
	});
} catch (error) {
	const message = error instanceof Error ? error.message : String(error);
	if ((error as any)?.code === "display_name_taken" || message.includes("already exists")) {
		// The remedy must match where the user stands: after --force the marker
		// check is what blocked reclamation, and passing --force again cannot help.
		const remedy = args.force
			? "The existing room carries no synthetic-fixture marker, so --force will not touch it; pick a different --name."
			: "If the name is held by a previous synthetic fixture, rerun with --force to reclaim it.";
		throw new Error(`${message} ${remedy}`);
	}
	throw error;
}
const agentId: string = scaffold.agent.agentId;
const roomDir: string = scaffold.agent.root;
const l1bPath = path.join(roomDir, "L1b", "current.md");

// Marker goes down first: if anything below throws, the half-built room is
// still recognizable as a fixture and reclaimable with --force.
const markerPath = path.join(roomDir, FIXTURE_MARKER_FILENAME);
const marker: Record<string, unknown> = { createdBy: "synthetic-room-build.ts", createdAt: new Date().toISOString(), args: { ...args } };
fs.writeFileSync(markerPath, JSON.stringify(marker, null, 2) + "\n", "utf-8");

const rand = mulberry32(args.seed);
let deepMemory: string;
let activeItems: string;
if (corpus) {
	const deep = buildCorpusDeepMemory(rand, corpus, args.deepTokens, args.mustKeep, estimateTokens, PLANT_RATES);
	const active = buildCorpusActiveItems(corpus, args.activeTokens, deep.usedIds, estimateTokens);
	const corpusEntries = corpus.sections.reduce((n, s) => n + s.entries.length, 0);
	if (deep.exhausted || active.exhausted) {
		fs.rmSync(roomDir, { recursive: true });
		throw new Error(
			`the corpus ran dry: ${corpusEntries} entries could not fill --deep-tokens ${args.deepTokens} + --active-tokens ${args.activeTokens} (reached ~${estimateTokens(deep.text)} Deep Memory tokens${deep.exhausted ? "" : ` and ~${estimateTokens(active.text)} Active Items tokens`} before running out). Lower the targets to what it reached, or generate a larger corpus (synthetic-corpus-generate.ts --per-section). The half-built room was removed.`,
		);
	}
	deepMemory = deep.text;
	activeItems = active.text;
	marker.content = {
		mode: "corpus",
		corpus: { path: args.corpus, sha256: corpusSha256, entries: corpusEntries, generatedAt: corpus.provenance?.generatedAt ?? null, model: corpus.provenance?.model ?? null },
		entriesUsed: { deepMemory: deep.usedIds.size, activeItems: active.usedIds.size },
		plantRates: PLANT_RATES,
		planted: {
			counts: { duplicatePairs: deep.planted.duplicatePairs.length, superseded: deep.planted.superseded.length, stale: deep.planted.stale.length, mustKeeps: deep.planted.mustKeeps.length },
			// Removable without loss: a superseded original, a stale revisit-by item. Each is gone or it is not.
			removable: { superseded: deep.planted.superseded, stale: deep.planted.stale },
			// Planted TWICE: the right outcome is one survivor each, so these are scored by survivor count, not by absence.
			duplicatePairs: deep.planted.duplicatePairs,
			// Must survive: the reversals (they carry the newer truth) and every must-keep.
			mustSurvive: { supersededBy: deep.planted.supersededBy, mustKeeps: deep.planted.mustKeeps },
		},
	};
} else {
	deepMemory = buildTemplateDeepMemory(rand, args.deepTokens, args.mustKeep, estimateTokens);
	activeItems = buildTemplateActiveItems(rand, args.activeTokens, estimateTokens);
	marker.content = { mode: "template" };
}
fs.writeFileSync(markerPath, JSON.stringify(marker, null, 2) + "\n", "utf-8");
const grafted = graft(fs.readFileSync(l1bPath, "utf-8"), deepMemory, activeItems);
fs.writeFileSync(l1bPath, grafted, "utf-8");

writePersistentRoomMaintenanceSettings(agentId, { memoryBudgetTokens: args.budget });

const written = fs.readFileSync(l1bPath, "utf-8");
const numeratorTokens = reviewTargetEstimatedTokensFromL1b(written);
const over = overMemoryBudget(numeratorTokens, args.budget);

// Print the name the scaffold actually stored (whitespace-collapsed, NFC) —
// it is what the rooms list shows and what review-bench's --room must match.
const storedDisplayName: string = scaffold.agent.displayName ?? args.name;
console.log(`Room created: "${storedDisplayName}" (id: ${agentId})`);
console.log(`  ${roomDir}`);
console.log(`Deep Memory: ~${estimateTokens(deepMemory)} tok · Active Items: ~${estimateTokens(activeItems)} tok`);
console.log(`Deep Memory + Active Items (the ONE budget numerator): ${numeratorTokens} estimated tokens`);
console.log(`Whole L1b: ${estimateTokens(written)} estimated tokens`);
console.log(`Budget: ${args.budget} tokens -> ${over ? "OVER" : "under"} budget (${Math.round((numeratorTokens / args.budget) * 100)}% of budget)`);
console.log(`Seed: ${args.seed} (same seed + args = same synthetic Deep Memory/Active Items; the scaffold's own timestamp line still differs per run)`);
if (corpus) {
	const content = marker.content as any;
	console.log(`Content: corpus mode from ${args.corpus} (sha256 ${String(corpusSha256).slice(0, 12)}…, ${content.corpus.entries} entries; used ${content.entriesUsed.deepMemory} in Deep Memory, ${content.entriesUsed.activeItems} in Active Items)`);
	console.log(`Planted: ${content.planted.counts.duplicatePairs} duplicate pairs (one survivor each is correct) · removable: ${content.planted.counts.superseded} superseded originals · ${content.planted.counts.stale} stale revisit-by items; must survive: ${content.planted.counts.mustKeeps} must-keeps + ${content.planted.mustSurvive.supersededBy.length} reversals (all recorded line by line in ${FIXTURE_MARKER_FILENAME})`);
} else {
	console.log("Content: template mode (pool-generated; the model reads it as template-shaped — use --content corpus for real-shaped content)");
}
console.log("");
console.log("The room is visible immediately to a server using this agents root — the rooms list scans disk per request, so a browser refresh is enough.");
console.log("Just make sure :8787 is answered by the repo's server, not the desktop app's:");
console.log("lsof -nP -iTCP:8787 -sTCP:LISTEN for the PID, then ps -p <PID> -o command= — the command line must run from this repo.");
