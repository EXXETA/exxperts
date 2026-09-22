// Synthetic corpus generator — dev fixture tool, NOT a smoke (never picked up
// by the battery glob). Asks a model, once, for distinct memory entries per
// Deep Memory theme and freezes them as a corpus file the room builder reads
// forever after. The generation is the only paid step; every build from the
// frozen file is deterministic and free.
//
// The model is reached through the product's own isolated worker runtime with
// a registry built from the runtime's auth storage — no server needed, same
// credentials, same usage accounting shape.
//
// Usage (repo root):
//   npx tsx apps/web-server/scripts/synthetic-corpus-generate.ts
//     [--out apps/web-server/scripts/fixtures/synthetic-room-corpus.json]
//     [--model anthropic/claude-opus-5-5] [--per-section 60] [--sections 12]
//     [--seed 1] [--label corpus-1] [--dry-run] [--force] [--resume]
//
// --dry-run prints the plan and the first section's full prompt and makes no
// model call — the walkthrough artifact before the paid run. --force allows
// overwriting an existing corpus file; without it an existing file refuses.
// Every raw reply is saved under scratch/synthetic-corpus-runs/<label>/ before
// validation, so a rejected batch is still readable afterwards — and --resume
// on the same --label reuses every saved reply that validates, so a run cut
// short (timeout, network, a killed shell) continues from where it stopped
// without paying for accepted sections again.

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { AuthStorage, getAgentDir, ModelRegistry } from "@exxeta/exxperts-runtime";

const { runIsolatedPersistentAgentWorker } = await import("../src/persistent-agent-worker-runtime.js");
const { stripProviderSearchFromModel } = await import("../../../pi-package/extensions/web-search/native-provider-search.js");
const {
	CORPUS_BATCH_MIN_FILL,
	CORPUS_ENTRY_KINDS,
	CORPUS_ENTRY_WORDS,
	CORPUS_MIN_SPECIFIC_SHARE,
	CORPUS_SECTION_THEMES,
	extractJsonObject,
	entrySkeleton,
	validateCorpus,
	validateCorpusBatch,
	WORLD,
} = await import("./synthetic-room-content.js");
type CorpusSection = import("./synthetic-room-content.js").CorpusSection;
type SyntheticRoomCorpus = import("./synthetic-room-content.js").SyntheticRoomCorpus;

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const DEFAULT_OUT = path.join("apps", "web-server", "scripts", "fixtures", "synthetic-room-corpus.json");

interface Args {
	out: string;
	model: { provider: string; model: string };
	perSection: number;
	sections: number;
	seed: number;
	label: string;
	dryRun: boolean;
	force: boolean;
	resume: boolean;
}

function parseArgs(argv: string[]): Args {
	const args: Args = {
		out: DEFAULT_OUT,
		model: { provider: "anthropic", model: "claude-opus-5-5" },
		perSection: 60,
		sections: CORPUS_SECTION_THEMES.length,
		seed: 1,
		label: "corpus-1",
		dryRun: false,
		force: false,
		resume: false,
	};
	for (let i = 0; i < argv.length; i++) {
		const flag = argv[i];
		const next = () => {
			const value = argv[++i];
			if (value === undefined) throw new Error(`${flag} needs a value`);
			return value;
		};
		if (flag === "--out") args.out = next();
		else if (flag === "--model") {
			const [provider, ...rest] = next().split("/");
			if (!provider || rest.length === 0) throw new Error("--model must be provider/model-id");
			args.model = { provider, model: rest.join("/") };
		} else if (flag === "--per-section") args.perSection = Number(next());
		else if (flag === "--sections") args.sections = Number(next());
		else if (flag === "--seed") args.seed = Number(next());
		else if (flag === "--label") args.label = next();
		else if (flag === "--dry-run") args.dryRun = true;
		else if (flag === "--force") args.force = true;
		else if (flag === "--resume") args.resume = true;
		else throw new Error(`unknown flag ${flag}`);
	}
	for (const [name, value, min, max] of [
		["--per-section", args.perSection, 10, 120],
		["--sections", args.sections, 1, CORPUS_SECTION_THEMES.length],
		["--seed", args.seed, 0, Number.MAX_SAFE_INTEGER],
	] as const) {
		if (!Number.isInteger(value) || value < min || value > max) throw new Error(`${name} must be an integer within [${min}, ${max}]`);
	}
	if (!/^[a-z0-9][a-z0-9._-]*$/i.test(args.label)) throw new Error("--label must be a single path segment");
	return args;
}

// Deterministic PRNG (mulberry32): the seed only decides which earlier entries
// the digest shows each section; the model's output itself is not
// deterministic, which is why the corpus is frozen to a file.
function mulberry32(seed: number): () => number {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

// Fisher–Yates on a copy: an unbiased, seed-driven order for the digest.
function shuffled<T>(items: readonly T[], rand: () => number): T[] {
	const copy = [...items];
	for (let i = copy.length - 1; i > 0; i--) {
		const j = Math.floor(rand() * (i + 1));
		[copy[i], copy[j]] = [copy[j], copy[i]];
	}
	return copy;
}

const STYLE_RULES = `You write the long-term memory of a persistent assistant. The memory belongs to ${WORLD.user}, a data-platform lead. Each entry is one Deep Memory bullet the assistant saved after a real working session, so every entry must be a distinct, specific claim the assistant would genuinely need later — never a generic observation and never a variation of another entry with the names swapped.

The world (use only these names):
- People: ${WORLD.people.join(", ")}
- Projects: ${WORLD.projects.join("; ")}
- Tools: ${WORLD.tools.join(", ")}
- Period: ${WORLD.window.start} to ${WORLD.window.end} (name concrete dates inside it when a date matters)

Style, learned from real memory files:
- One to three dense sentences, ${CORPUS_ENTRY_WORDS.min}–${CORPUS_ENTRY_WORDS.max} words. Bold the one fact a reader must not lose, like **Thu 30 Jul** or **12-week stay** or **5th working day**.
- Anchor at least ${Math.round(CORPUS_MIN_SPECIFIC_SHARE * 100)}% of entries in something concrete: a number, a date, an artifact name, a named person, project or tool.
- Vary the sentence shape from entry to entry. Two entries that could be produced by the same template with different names are a failure.
- Entries build on each other: later entries refine, reverse, or depend on earlier ones. Reference those by id in "refs".
- Mix kinds: ${CORPUS_ENTRY_KINDS.join(", ")}. A "pointer" names a document or place where the authority lives.
- Do NOT add "(saved …)" stamps, "must-keep" markers, or a leading "- ": the fixture builder adds those.

Output: exactly one JSON object in a \`\`\`json fence, shaped {"entries":[{"id":"e1","kind":"decision","text":"…","refs":["e0"]}, …]}. Nothing outside the fence. Ids are yours, sequential within this reply; refs may point at this reply's ids or at the digest ids given below.`;

function sectionPrompt(sectionIndex: number, perSection: number, digest: string[]): string {
	const theme = CORPUS_SECTION_THEMES[sectionIndex];
	return [
		STYLE_RULES,
		`## This section\n\nTopic: **${theme.topic}**\n\n${theme.brief}\n\nProduce ${perSection} entries for this topic (at least ${Math.ceil(perSection * CORPUS_BATCH_MIN_FILL)} must be usable).`,
		digest.length > 0 ? `## Digest of earlier entries (ids you may reference)\n\n${digest.map((d) => `- ${d}`).join("\n")}` : "",
	].filter(Boolean).join("\n\n");
}

function retryPrompt(prompt: string, reasons: string[]): string {
	return `${prompt.trimEnd()}\n\n---\n\n## Retry Notice\n\nYour previous reply was not accepted:\n\n${reasons.map((r) => `- ${r}`).join("\n")}\n\nProduce the complete set of entries again in the same JSON shape, fixing every point above.\n`;
}

const args = parseArgs(process.argv.slice(2));
const outPath = path.resolve(REPO_ROOT, args.out);
if (fs.existsSync(outPath) && !args.force && !args.dryRun) {
	throw new Error(`${path.relative(REPO_ROOT, outPath)} exists; a frozen corpus is not overwritten by accident. Pass --force to replace it, or --out for a different file.`);
}
const promptHash = createHash("sha256").update(STYLE_RULES).update(JSON.stringify(CORPUS_SECTION_THEMES)).digest("hex").slice(0, 16);
const runDir = path.join(REPO_ROOT, "scratch", "synthetic-corpus-runs", args.label);

console.log(`Plan: ${args.sections} section(s) × ${args.perSection} entries via ${args.model.provider}/${args.model.model} (prompt hash ${promptHash})`);
console.log(`Output: ${path.relative(REPO_ROOT, outPath)} · raw replies: ${path.relative(REPO_ROOT, runDir)}/`);

if (args.dryRun) {
	console.log("\n--- dry run: first section prompt ---\n");
	console.log(sectionPrompt(0, args.perSection, []));
	console.log("\n--- dry run: no model call made ---");
	process.exit(0);
}

const registry = ModelRegistry.create(AuthStorage.create());
const found = registry.find(args.model.provider, args.model.model);
if (!found) throw new Error(`model not found: ${args.model.provider}/${args.model.model}`);
if (!registry.hasConfiguredAuth(found)) throw new Error(`provider not connected: ${args.model.provider} — sign in first (AI setup), then rerun`);
const model = stripProviderSearchFromModel(found);

if (fs.existsSync(runDir) && !args.resume) throw new Error(`${path.relative(REPO_ROOT, runDir)} exists; pick another --label, or pass --resume to continue that run from its saved replies (a run never overwrites its evidence)`);
if (args.resume && !fs.existsSync(runDir)) throw new Error(`--resume: ${path.relative(REPO_ROOT, runDir)} does not exist; nothing to resume for --label ${args.label}`);
fs.mkdirSync(runDir, { recursive: true });

const rand = mulberry32(args.seed);
const sections: CorpusSection[] = [];
const skeletons = new Set<string>();
const ids = new Set<string>();
const usage = { input: 0, output: 0, cost: 0 };

// Saved replies are evidence: a resumed run writes next to them, never over them.
function freeTag(tag: string): string {
	if (!fs.existsSync(path.join(runDir, `${tag}.md`))) return tag;
	for (let n = 2; ; n++) if (!fs.existsSync(path.join(runDir, `${tag}-r${n}.md`))) return `${tag}-r${n}`;
}

// --resume: the newest saved reply for this section that validates, if any.
function savedAcceptedReply(sectionIndex: number): { text: string; file: string; validation: ReturnType<typeof tryValidate> } | undefined {
	if (!args.resume) return undefined;
	const prefix = `section-${sectionIndex + 1}-`;
	const candidates = fs.readdirSync(runDir)
		.filter((f) => f.startsWith(prefix) && f.endsWith(".md") && !f.includes("-prompt"))
		.map((f) => ({ f, mtime: fs.statSync(path.join(runDir, f)).mtimeMs }))
		.sort((a, b) => b.mtime - a.mtime);
	for (const { f } of candidates) {
		const text = fs.readFileSync(path.join(runDir, f), "utf-8");
		const validation = tryValidate(text, sectionIndex);
		if (validation.problems.length === 0) return { text, file: f, validation };
	}
	return undefined;
}

async function generate(prompt: string, tag: string): Promise<string> {
	const started = Date.now();
	const result = await runIsolatedPersistentAgentWorker({
		workerSystemPrompt: prompt,
		triggerPrompt: "Produce the entries now.",
		modelLock: args.model,
		resolveExpectedModel: () => model,
		workerLabel: "synthetic corpus generator",
		emptyTextError: "synthetic corpus generator produced no text",
		cwd: REPO_ROOT,
		agentDir: getAgentDir(),
		modelRegistry: registry,
	});
	fs.writeFileSync(path.join(runDir, `${freeTag(tag)}.md`), result.text, "utf-8");
	usage.input += result.usage?.input ?? 0;
	usage.output += result.usage?.output ?? 0;
	usage.cost += result.usage?.cost ?? 0;
	console.log(`  ${tag}: ${((Date.now() - started) / 1000).toFixed(1)}s · out ${result.usage?.output ?? "?"} tok · $${(result.usage?.cost ?? 0).toFixed(2)}${result.truncated ? " · TRUNCATED at the model's output limit" : ""}`);
	if (result.truncated) throw new Error(`${tag}: the reply was cut at the model's output limit (${result.modelMaxOutputTokens ?? "?"} tokens); lower --per-section and rerun`);
	return result.text;
}

for (let s = 0; s < args.sections; s++) {
	const theme = CORPUS_SECTION_THEMES[s];
	console.log(`Section ${s + 1}/${args.sections}: ${theme.topic}`);
	// Digest: up to 30 earlier entries, seed-chosen, so later sections can build on earlier ones.
	const pool = sections.flatMap((sec) => sec.entries);
	const digest = shuffled(pool, rand).slice(0, 30).map((e) => `${e.id}: ${e.text.split(/\s+/).slice(0, 14).join(" ")}…`);
	const prompt = sectionPrompt(s, args.perSection, digest);
	if (!fs.existsSync(path.join(runDir, `section-${s + 1}-prompt.md`))) fs.writeFileSync(path.join(runDir, `section-${s + 1}-prompt.md`), prompt, "utf-8");

	const saved = savedAcceptedReply(s);
	if (saved) {
		for (const e of saved.validation.entries) { skeletons.add(entrySkeleton(e.text)); ids.add(e.id); }
		sections.push({ topic: theme.topic, entries: saved.validation.entries });
		console.log(`  reused ${saved.file} (${saved.validation.entries.length} entries, no model call)`);
		continue;
	}
	let attempt = 1;
	let validation = tryValidate(await generate(prompt, `section-${s + 1}-reply`), s);
	if (validation.problems.length > 0) {
		console.log(`  not accepted: ${validation.problems.join(" | ")}`);
		attempt = 2;
		validation = tryValidate(await generate(retryPrompt(prompt, validation.problems), `section-${s + 1}-retry`), s);
		if (validation.problems.length > 0) {
			throw new Error(`section ${s + 1} (${theme.topic}) was not accepted after the retry: ${validation.problems.join(" | ")}. Nothing was written to ${path.relative(REPO_ROOT, outPath)}; raw replies are under ${path.relative(REPO_ROOT, runDir)}/.`);
		}
	}
	for (const e of validation.entries) { skeletons.add(entrySkeleton(e.text)); ids.add(e.id); }
	sections.push({ topic: theme.topic, entries: validation.entries });
	console.log(`  accepted ${validation.entries.length} entries (attempt ${attempt}, ${validation.dropped.length} dropped)`);
}

function tryValidate(text: string, sectionIndex: number) {
	let parsed: unknown;
	try {
		parsed = extractJsonObject(text);
	} catch (error) {
		return { entries: [], problems: [`the reply was not one JSON object in a \`\`\`json fence (${(error as Error).message})`], dropped: [] };
	}
	return validateCorpusBatch(parsed, { sectionIndex, expectedCount: args.perSection, existingSkeletons: skeletons, existingIds: ids });
}

const corpus: SyntheticRoomCorpus = {
	provenance: {
		generatedBy: "synthetic-corpus-generate.ts",
		generatedAt: new Date().toISOString(),
		model: args.model,
		seed: args.seed,
		promptHash,
		perSection: args.perSection,
		usage: { input: usage.input, output: usage.output, cost: Number(usage.cost.toFixed(4)) },
	},
	sections,
};
const problems = validateCorpus(corpus);
if (problems.length > 0) throw new Error(`corpus invariants failed; nothing written: ${problems.slice(0, 10).join("; ")}${problems.length > 10 ? ` (+${problems.length - 10} more)` : ""}`);

fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, JSON.stringify(corpus, null, 2) + "\n", "utf-8");
const total = sections.reduce((n, s) => n + s.entries.length, 0);
const words = sections.reduce((n, s) => n + s.entries.reduce((m, e) => m + e.text.split(/\s+/).length, 0), 0);
console.log(`\nFrozen ${total} entries (~${words} words, ~${Math.round(words * 1.35)} tokens of raw entry text) to ${path.relative(REPO_ROOT, outPath)}`);
console.log(`Usage: in ${usage.input} · out ${usage.output} · $${usage.cost.toFixed(2)}`);
