// LongMemEval through our own room (memory v2, stream 41.4).
//
// The recall bench next door measures a room built from OUR fixture, whose
// answer key we wrote ourselves. This adapter runs the SAME room against
// somebody else's benchmark: LongMemEval hands out 500 instances, each a
// question and a haystack of chat sessions one of which holds the answer, and
// publishes a judge script that scores a hypothesis file. One instance becomes
// one room here — its sessions Remembered and Memorized through the product's
// own pipeline, in date order — and then the room is asked the question in a
// fresh conversation. What comes out is a hypothesis file in the shape
// `evaluate_qa.py` reads, line for line, so our number is computed by their
// script and not by ours.
//
// Nothing about the pipeline is special-cased for the benchmark. The Remember
// is the checkpoint worker, the Memorize is a real absorb run and its approval,
// the budget is the room's own setting, the ask is the real WebSocket turn with
// the room's own `memory_recall` tool. What changes is only where the
// conversations come from.
//
// The data is downloaded by hand into `data/` and never committed; see the
// README. `--oracle` reads the small oracle file, whose haystack is the
// evidence sessions only — the pipeline check, not a score. The default is the
// S file, 500 instances of about fifty sessions and 120k tokens each, which is
// the benchmark proper.
//
// Offline, no provider, end to end:
//   npx tsx scripts/memory-bench/longmemeval-adapter.mts --oracle --sample 5 --seed 1 --scripted
// Against a real model:
//   RECALL_BENCH_MODEL=anthropic/claude-sonnet-5 npx tsx scripts/memory-bench/longmemeval-adapter.mts --sample 50 --seed 1
// What it would cost first, always:
//   RECALL_BENCH_MODEL=anthropic/claude-sonnet-5 npx tsx scripts/memory-bench/longmemeval-adapter.mts --sample 50 --seed 1 --dry-run

import fs from "node:fs";
import path from "node:path";

import {
	answerTokens,
	askRoom,
	claimsFailed,
	claimsLine,
	createBenchRoom,
	createMaintenanceWorker,
	createRealIngest,
	DEFAULT_MEMORY_BUDGET_TOKENS,
	ingestSessions,
	pad,
	prepareBenchHome,
	ProviderGaveUpError,
	resultsDir,
	roomSizes,
	setBenchModel,
	startBenchServer,
	startProviderRetryUnit,
	startScriptedRoomGateway,
	useRealProviderRecords,
	withProviderRetry,
	writeScriptedProviderRecords,
	type BenchServer,
	type ClaimAudit,
	type MaintenanceWorker,
	type RealIngest,
	type ScriptedGatewayFailure,
} from "./recall-engine.mjs";
import {
	judgeHypotheses,
	LONGMEMEVAL_QUESTION_TYPES,
	renderJudgeTable,
	type JudgeHypothesisLine,
	type JudgeReference,
} from "./longmemeval-judge.mjs";
// The pure half, in a module of its own so that a smoke can import `mapInstance`
// or `stratifiedSample` without running the command below it.
import {
	benchQuestion,
	hypothesisLine,
	mapInstance,
	stratifiedSample,
	type LongMemEvalInstance,
	type MappedInstance,
} from "./longmemeval-map.mjs";

// --- The data ----------------------------------------------------------------

const dataDir = path.join(new URL(".", import.meta.url).pathname, "data");
const ORACLE_FILE = "longmemeval_oracle.json";
const S_FILE = "longmemeval_s_cleaned.json";

function readInstances(file: string): LongMemEvalInstance[] {
	if (!fs.existsSync(file)) {
		throw new Error(`${file} is not there. The LongMemEval data is downloaded by hand and never committed; see "The LongMemEval adapter" in scripts/memory-bench/README.md`);
	}
	const parsed = JSON.parse(fs.readFileSync(file, "utf-8"));
	if (!Array.isArray(parsed)) throw new Error(`${file} does not hold a list of instances`);
	return parsed as LongMemEvalInstance[];
}

/** The ask, the way the bench asks: the date the room is asked on, then the question. */
function askText(mapped: MappedInstance): string {
	return `Today is ${mapped.askDate}. ${mapped.question}`;
}

/**
 * A conversation id for one instance; long enough for the thread rule, and its
 * own. A second attempt at the ask gets a fresh conversation (`_r2`, `_r3`),
 * because the first one may hold a half-written turn the room would otherwise
 * carry into the answer.
 */
function askConversation(mapped: MappedInstance, label: string, attempt = 1): string {
	return `c_lme_${label}_${mapped.questionId.toLowerCase().replace(/[^a-z0-9]+/g, "_")}${attempt > 1 ? `_r${attempt}` : ""}`;
}

// --- Arguments ---------------------------------------------------------------

interface AdapterArgs {
	data?: string;
	oracle: boolean;
	ids?: string[];
	type?: string;
	sample?: number;
	seed: number;
	baseline?: "none" | "transcript";
	judge?: string;
	dryRun: boolean;
	scripted: boolean;
	out?: string;
	keepHome: boolean;
	/** Carry on into an existing hypothesis file: its instances are skipped, the rest appended. */
	resume: boolean;
}

function parseArgs(argv: string[]): AdapterArgs {
	const args: AdapterArgs = { oracle: false, seed: 1, dryRun: false, scripted: false, keepHome: false, resume: false };
	for (let i = 0; i < argv.length; i++) {
		const flag = argv[i];
		const next = () => {
			const value = argv[++i];
			if (value === undefined) throw new Error(`${flag} needs a value`);
			return value;
		};
		if (flag === "--oracle") args.oracle = true;
		else if (flag === "--data") args.data = next();
		else if (flag === "--ids") args.ids = next().split(",").map((id) => id.trim()).filter(Boolean);
		else if (flag === "--type") args.type = next();
		else if (flag === "--sample") args.sample = Number(next());
		else if (flag === "--seed") args.seed = Number(next());
		else if (flag === "--baseline") {
			const value = next();
			if (value !== "none" && value !== "transcript") throw new Error("--baseline must be none or transcript");
			args.baseline = value;
		} else if (flag === "--judge") args.judge = next();
		else if (flag === "--dry-run") args.dryRun = true;
		else if (flag === "--scripted") args.scripted = true;
		else if (flag === "--out") args.out = next();
		else if (flag === "--keep-home") args.keepHome = true;
		else if (flag === "--resume") {
			// `--resume` alone carries on into the --out file or the default path;
			// `--resume <file>` names the file and stands in for --out.
			args.resume = true;
			const file = argv[i + 1];
			if (file !== undefined && !file.startsWith("--")) {
				if (args.out !== undefined && args.out !== file) throw new Error(`--resume ${file} and --out ${args.out} name two different files; pass one of them`);
				args.out = file;
				i += 1;
			}
		} else throw new Error(`Unknown flag: ${flag}`);
	}
	if (args.oracle && args.data) throw new Error("--oracle and --data name two different files; pass one of them");
	return args;
}

/** RECALL_BENCH_SCRIPTED_FAIL, `<marker>:<times|all>`: the scripted gateway's failure on cue, read in --scripted mode only. */
function parseScriptedFail(raw: string | undefined, scripted: boolean): ScriptedGatewayFailure | undefined {
	const value = raw?.trim();
	if (!value) return undefined;
	if (!scripted) throw new Error("RECALL_BENCH_SCRIPTED_FAIL makes the scripted gateway fail on cue and is read in --scripted mode only");
	// "<marker>:<times|all>" answers with a 500; "<marker>:<times|all>:hang" never answers.
	const hang = value.endsWith(":hang");
	const spec = hang ? value.slice(0, -":hang".length) : value;
	const colon = spec.lastIndexOf(":");
	const marker = colon > 0 ? spec.slice(0, colon) : "";
	const times = colon > 0 ? spec.slice(colon + 1) : "";
	if (!marker || (times !== "all" && !(Number.isInteger(Number(times)) && Number(times) > 0))) throw new Error(`RECALL_BENCH_SCRIPTED_FAIL reads "<marker>:<times|all>" or "<marker>:<times|all>:hang", e.g. "ZYGOMORPHIC:1", and it reads "${value}"`);
	return { marker, times: times === "all" ? "all" : Number(times), ...(hang ? { hang: true } : {}) };
}

// --- The estimate ------------------------------------------------------------
//
// The numbers a spend is decided on, in the estimates the recall bench already
// speaks in: a fold prompt is the room's memory plus about 1.5k of instructions,
// a checkpoint prompt is the memory plus about 800 — and, unlike the fixture's
// short sittings, a LongMemEval session is a real transcript, so its own size is
// measured off the data rather than guessed.

const FOLD_PROMPT_OVERHEAD = 1_500;
const CHECKPOINT_PROMPT_OVERHEAD = 800;
/** What a Recent Context draft adds to the fold prompt that carries it. */
const RECENT_CONTEXT_DRAFT_TOKENS = 400;
/** The ask: one recall leg and one answer leg, each carrying the room's memory and its system prompt. */
const ASK_PROMPT_OVERHEAD = 2_000;
const ASK_CALLS_PER_QUESTION = 2;

interface Estimate {
	instances: number;
	sessions: number;
	memorizeRuns: number;
	checkpointTokens: number;
	foldTokens: number;
	askTokens: number;
	transcriptTokens: number;
	promptTokens: number;
}

function estimate(mapped: readonly MappedInstance[], foldEvery: number, baseline: AdapterArgs["baseline"]): Estimate {
	const sessions = mapped.reduce((total, instance) => total + instance.sessions.length, 0);
	const memorizeRuns = mapped.reduce((total, instance) => total + Math.max(1, Math.ceil(instance.sessions.length / foldEvery)), 0);
	const transcriptTokens = mapped.reduce((total, instance) => total + instance.sessions.reduce((sum, session) => sum + answerTokens(session.turns.map((turn) => turn.text).join("\n")), 0), 0);
	const checkpointTokens = sessions * (DEFAULT_MEMORY_BUDGET_TOKENS + CHECKPOINT_PROMPT_OVERHEAD) + transcriptTokens;
	const foldTokens = sessions * (DEFAULT_MEMORY_BUDGET_TOKENS + FOLD_PROMPT_OVERHEAD + RECENT_CONTEXT_DRAFT_TOKENS);
	const askTokens = mapped.length * ASK_CALLS_PER_QUESTION * (DEFAULT_MEMORY_BUDGET_TOKENS + ASK_PROMPT_OVERHEAD);
	const promptTokens = baseline === "transcript"
		? transcriptTokens + mapped.length * ASK_PROMPT_OVERHEAD
		: baseline === "none"
			? askTokens
			: checkpointTokens + foldTokens + askTokens;
	return { instances: mapped.length, sessions, memorizeRuns, checkpointTokens, foldTokens, askTokens, transcriptTokens, promptTokens };
}

function printEstimate(numbers: Estimate, args: AdapterArgs, foldEvery: number): void {
	const k = (tokens: number) => `${Math.round(tokens / 1000)}k`;
	console.log(`estimate: ${numbers.instances} instance(s) · ${numbers.sessions} conversation(s) · ${numbers.memorizeRuns} Memorize run(s) at --fold-every ${foldEvery}`);
	if (args.baseline === "transcript") {
		console.log(`estimate: baseline transcript ≈ ${numbers.instances} call(s) carrying ${k(numbers.transcriptTokens)} of transcript in total ≈ ${k(numbers.promptTokens)} prompt tokens`);
	} else if (args.baseline === "none") {
		console.log(`estimate: baseline none ≈ ${numbers.instances} question(s) × ${ASK_CALLS_PER_QUESTION} call(s) ≈ ${k(numbers.askTokens)} prompt tokens, and nothing is ingested`);
	} else {
		console.log(`estimate: ingest ≈ ${numbers.sessions} checkpoint call(s) ≈ ${k(numbers.checkpointTokens)} (the room's ${DEFAULT_MEMORY_BUDGET_TOKENS}-token memory, ~${CHECKPOINT_PROMPT_OVERHEAD} of instructions, and ${k(numbers.transcriptTokens)} of transcript)`);
		console.log(`estimate: ingest ≈ ${numbers.sessions} fold call(s) ≈ ${k(numbers.foldTokens)} prompt tokens`);
		console.log(`estimate: asking ≈ ${numbers.instances} question(s) × ${ASK_CALLS_PER_QUESTION} call(s) ≈ ${k(numbers.askTokens)} prompt tokens`);
	}
	console.log(`estimate: ${k(numbers.promptTokens)} prompt tokens in total, ≈ ${k(numbers.promptTokens / Math.max(1, numbers.instances))} per instance`);
	console.log("estimate: output tokens are a fraction of that and are not estimated; the real totals are printed after a run");
}

// --- The run -----------------------------------------------------------------

interface InstanceResult {
	question_id: string;
	question_type: string;
	abstention: boolean;
	/** null when the instance failed: the provider gave up on its ingest or its ask, and `failure` says which. */
	hypothesis: string | null;
	/** One sentence, only on a failed instance: which step, which worker, what the provider said. */
	failure?: string;
	sessions: number;
	notesInCore: number;
	archiveRows: number;
	memoryTokens: number;
	recallCalls: number;
	answerTokens: number;
	usage: { input: number; output: number; total: number; cost: number } | null;
	ingestMs: number;
	askMs: number;
	roomId: string | null;
	/**
	 * The ingest's claim audit: how many conversations the room memorized, how
	 * many of them its search index lacks, and how many it files under another
	 * conversation's name. Absent on a row that never ingested (a baseline, a
	 * failed ingest). A non-zero count does not fail the instance, whose answer
	 * is still measured; it fails the RUN, at the end.
	 */
	claims?: ClaimAudit;
}

/** The whole past in one prompt: the ceiling a room's memory is measured against, and what it costs. */
function transcriptPrompt(mapped: MappedInstance): string {
	const transcript = mapped.sessions
		.map((session) => [`## ${session.title}`, "", ...session.turns.map((turn) => `${turn.role === "user" ? "User" : "Assistant"}: ${turn.text}`)].join("\n"))
		.join("\n\n");
	return `Here is every conversation so far, in order.\n\n${transcript}\n\n---\n\n${askText(mapped)}`;
}

/** Where a finished instance goes the moment it is finished: written down before the next one starts. */
type RecordRow = (row: InstanceResult) => void;

/**
 * The row of an instance the provider gave up on. A `ProviderGaveUpError` is
 * the one error a run carries on past: the waiting has already been done, the
 * instance is marked and named, and the next one is worth as much as this one
 * was. Anything else is returned as null and breaks the pipeline in the caller.
 */
function failedRow(instance: MappedInstance, step: string, error: unknown): InstanceResult | null {
	if (!(error instanceof ProviderGaveUpError)) return null;
	const failure = `The ${step} of ${instance.questionId} failed: ${error.label} gave up after ${error.attempts} attempt${error.attempts === 1 ? "" : "s"}, and the provider's last word was "${error.lastMessage}".`;
	console.log(`  FAILED: ${failure}`);
	return { question_id: instance.questionId, question_type: instance.questionType, abstention: instance.abstention, hypothesis: null, failure, sessions: instance.sessions.length, notesInCore: 0, archiveRows: 0, memoryTokens: 0, recallCalls: 0, answerTokens: 0, usage: null, ingestMs: 0, askMs: 0, roomId: null };
}

async function runTranscriptBaseline(mapped: readonly MappedInstance[], worker: MaintenanceWorker, lock: { provider: string; model: string }, record: RecordRow): Promise<void> {
	const window = worker.contextWindow(lock);
	for (const [index, instance] of mapped.entries()) {
		const prompt = transcriptPrompt(instance);
		const tokens = answerTokens(prompt);
		console.log(`  ${index + 1}/${mapped.length} ${instance.questionId} · ${instance.sessions.length} conversations · ${tokens} prompt tokens${window ? ` of a ${window}-token window` : ""}`);
		if (window !== null && tokens > window) {
			console.log(`  refused: ${tokens} tokens do not fit ${lock.provider}/${lock.model}, whose window the registry reports as ${window} — the whole past is what a room's memory exists instead of`);
			record({ question_id: instance.questionId, question_type: instance.questionType, abstention: instance.abstention, hypothesis: "", sessions: instance.sessions.length, notesInCore: 0, archiveRows: 0, memoryTokens: tokens, recallCalls: 0, answerTokens: 0, usage: null, ingestMs: 0, askMs: 0, roomId: null });
			continue;
		}
		const started = Date.now();
		let reply: Awaited<ReturnType<MaintenanceWorker["call"]>>;
		try {
			reply = await worker.call({
				prompt,
				modelLock: lock,
				label: "longmemeval transcript baseline",
				triggerPrompt: "Answer the question at the end of the conversations now.",
				emptyTextError: "the transcript baseline produced no text",
			});
		} catch (error) {
			const failed = failedRow(instance, "transcript baseline", error);
			if (!failed) throw error;
			record(failed);
			continue;
		}
		record({
			question_id: instance.questionId,
			question_type: instance.questionType,
			abstention: instance.abstention,
			hypothesis: reply.text.trim(),
			sessions: instance.sessions.length,
			notesInCore: 0,
			archiveRows: 0,
			memoryTokens: tokens,
			recallCalls: 0,
			answerTokens: answerTokens(reply.text),
			usage: { input: reply.usage?.input ?? 0, output: reply.usage?.output ?? 0, total: reply.usage?.totalTokens ?? 0, cost: reply.usage?.cost ?? 0 },
			ingestMs: 0,
			askMs: Date.now() - started,
			roomId: null,
		});
	}
}

async function runRooms(mapped: readonly MappedInstance[], args: AdapterArgs, home: string, server: BenchServer, ingestPair: RealIngest | null, record: RecordRow): Promise<void> {
	for (const [index, instance] of mapped.entries()) {
		console.log(`\n[${index + 1}/${mapped.length}] ${instance.questionId} · ${instance.questionType}${instance.abstention ? " · abstention" : ""} · ${instance.sessions.length} conversations`);
		// The waiting is budgeted per instance: whatever gave up in the last one, this one gets the whole schedule.
		startProviderRetryUnit();
		const room = await createBenchRoom({ home, name: `LongMemEval ${instance.questionId}`, backHistoryTokens: 0 });
		let ingestMs = 0;
		let claims: ClaimAudit | undefined;
		if (ingestPair) {
			const started = Date.now();
			// The ingest's own worker calls are waited out inside the engine; what
			// reaches here is a provider that kept failing through the whole
			// schedule, and that marks the instance rather than ending the run.
			let report: Awaited<ReturnType<typeof ingestSessions>>;
			try {
				report = await ingestSessions({ roomId: room.roomId, sessions: instance.sessions, remember: ingestPair.remember, memorize: ingestPair.memorize });
			} catch (error) {
				const failed = failedRow(instance, "ingest", error);
				if (!failed) throw error;
				record(failed);
				continue;
			}
			ingestMs = Date.now() - started;
			const refused = report.failures.length;
			const sizes = await roomSizes(room.roomId);
			console.log(`  ingested ${report.remembered} conversation(s) in ${report.steps.length} Memorize run(s), ${Math.round(ingestMs / 1000)}s${refused > 0 ? ` · ${refused} refused` : ""} · ${sizes.notesInCore} notes, ${sizes.memoryTokens}/${sizes.memoryBudgetTokens} tokens, ${sizes.archiveRows} archived`);
			for (const failure of report.failures.slice(0, 3)) console.log(`  refused ${failure.session}: ${failure.reason}`);
			claims = report.claims;
			console.log(`  ${claimsLine(claims)}`);
		}
		const startedAsk = Date.now();
		// The ask goes through the room's real turn, not the worker, so it is
		// waited out here: any error the turn ends in (an error frame, a turn that
		// did not end in time) is tried again on the same schedule, each attempt
		// in a conversation of its own.
		const label = args.baseline === "none" ? "base" : "room";
		let turn: Awaited<ReturnType<typeof askRoom>>;
		try {
			turn = await withProviderRetry(
				`the ask of ${instance.questionId}`,
				async (attempt) => {
					const asked = await askRoom({ server, roomId: room.roomId, conversationId: askConversation(instance, label, attempt), prompt: askText(instance) });
					// A turn the provider ended still ends like any other, with no text
					// in it: taken as an answer it would be an empty hypothesis scored
					// as the room's own. It is a failed attempt, and so is a turn that
					// came back with nothing to say at all.
					if (asked.providerError) throw new Error(`the room's turn was ended by the provider: ${asked.providerError}`);
					if (!asked.answer.trim()) throw new Error("the room's turn ended without an answer");
					return asked;
				},
				{ retryOn: () => true },
			);
		} catch (error) {
			const failed = failedRow(instance, "ask", error);
			if (!failed) throw error;
			record(failed);
			continue;
		}
		const askMs = Date.now() - startedAsk;
		const sizes = await roomSizes(room.roomId);
		console.log(`  answered in ${Math.round(askMs / 1000)}s · memory_recall ×${turn.recallCalls} · ${turn.answer.slice(0, 120).replace(/\s+/g, " ")}`);
		record({
			question_id: instance.questionId,
			question_type: instance.questionType,
			abstention: instance.abstention,
			hypothesis: turn.answer.trim(),
			sessions: instance.sessions.length,
			notesInCore: sizes.notesInCore,
			archiveRows: sizes.archiveRows,
			memoryTokens: sizes.memoryTokens,
			recallCalls: turn.recallCalls,
			answerTokens: answerTokens(turn.answer),
			usage: turn.usage,
			ingestMs,
			askMs,
			roomId: room.roomId,
			...(claims ? { claims } : {}),
		});
	}
}

// --- Main --------------------------------------------------------------------

const args = parseArgs(process.argv.slice(2));
const realSpec = process.env.RECALL_BENCH_MODEL?.trim();
if (!args.scripted && !realSpec) {
	console.log("This adapter needs a model: set RECALL_BENCH_MODEL=provider/model for a real run, or pass --scripted to drive the whole pipeline against the engine's scripted gateway with no provider at all.");
	process.exit(1);
}
if (args.scripted && realSpec) console.log(`note: --scripted wins over RECALL_BENCH_MODEL=${realSpec}; nothing in this run reaches a provider`);

const dataFile = args.data ?? path.join(dataDir, args.oracle ? ORACLE_FILE : S_FILE);
const all = readInstances(dataFile);
let chosen = all;
if (args.type) {
	chosen = chosen.filter((instance) => instance.question_type === args.type);
	if (chosen.length === 0) throw new Error(`no instance of type "${args.type}" in ${path.basename(dataFile)}; the types are ${LONGMEMEVAL_QUESTION_TYPES.join(", ")}`);
}
if (args.ids) {
	const wanted = new Set(args.ids);
	chosen = chosen.filter((instance) => wanted.has(instance.question_id));
	const missing = args.ids.filter((id) => !chosen.some((instance) => instance.question_id === id));
	if (missing.length > 0) throw new Error(`${path.basename(dataFile)} holds no instance with id ${missing.join(", ")}`);
}
if (args.sample !== undefined) chosen = stratifiedSample(chosen, args.sample, args.seed);
if (chosen.length === 0) throw new Error("nothing to run: the selection came back empty");

const mapped = chosen.map(mapInstance);
const foldEvery = 7;
const modelLabel = args.scripted ? "scripted" : realSpec!.replace(/[^A-Za-z0-9._-]+/g, "-");
// The LOCAL date, not the UTC one: the name is read by the person who started
// the run, on the evening they started it, and a file stamped with yesterday
// because the run began after the UTC midnight is a file nobody can find.
const now = new Date();
const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
const outFile = args.out ?? path.join(resultsDir(), `longmemeval-${modelLabel}${args.baseline ? `-baseline-${args.baseline}` : ""}-${today}.jsonl`);
const metaFile = `${outFile}.meta.json`;
const scriptedFail = parseScriptedFail(process.env.RECALL_BENCH_SCRIPTED_FAIL, args.scripted);

// --- What the file already holds ---------------------------------------------
//
// A hypothesis file is appended one line per answered instance, so a run that
// died holds every answer it got. Carrying on into it is `--resume`: the ids
// its lines name are skipped and the rest are appended. Without it an existing
// file is refused, because a run that overwrote five hours of answers, or one
// that quietly skipped half its sample, would each be a file nobody can trust.

/** The question ids an existing hypothesis file answers, in the file's order. */
function answeredIn(file: string): string[] {
	return fs.readFileSync(file, "utf-8").split("\n").filter((line) => line.trim()).map((line, index) => {
		let parsed: { question_id?: unknown };
		try { parsed = JSON.parse(line) as { question_id?: unknown }; } catch { throw new Error(`${file} line ${index + 1} is not JSON, so this is not a hypothesis file this adapter wrote`); }
		if (typeof parsed.question_id !== "string") throw new Error(`${file} line ${index + 1} carries no question_id, so this is not a hypothesis file this adapter wrote`);
		return parsed.question_id;
	});
}

/** The earlier run's meta, on a resume: its usage and its answered rows are carried into the new one. */
function readPreviousMeta(): { usage?: unknown; rows?: InstanceResult[] } | null {
	if (!args.resume || !fs.existsSync(metaFile)) return null;
	try { return JSON.parse(fs.readFileSync(metaFile, "utf-8")) as { usage?: unknown; rows?: InstanceResult[] }; } catch { return null; }
}

const outExists = fs.existsSync(outFile);
if (outExists && !args.resume) {
	console.log(`${outFile} is already there: pass --resume to carry on into it, skipping the instances it answers and appending the rest, or --out to name another file.`);
	process.exit(1);
}
if (args.resume && !outExists) {
	console.log(`--resume: ${outFile} is not there, so there is nothing to carry on into; drop --resume to start it.`);
	process.exit(1);
}
const answeredBefore = args.resume ? answeredIn(outFile) : [];
const answeredSet = new Set(answeredBefore);
const previousMeta = readPreviousMeta();
/** The earlier run's rows this file still answers; a failed row is not one, its instance is tried again. */
const carried: InstanceResult[] = (previousMeta?.rows ?? []).filter((row) => typeof row.hypothesis === "string" && answeredSet.has(row.question_id));
/** The instances this run has to do: the selection, less what the file already answers. */
const todo = mapped.filter((instance) => !answeredSet.has(instance.questionId));

console.log(`LongMemEval adapter · ${path.basename(dataFile)} · ${mapped.length} of ${all.length} instance(s) · ${args.scripted ? "scripted gateway, no provider" : realSpec} · ${args.baseline ? `baseline ${args.baseline}` : "the room's memory"}`);
const byType = new Map<string, number>();
for (const instance of mapped) byType.set(instance.questionType, (byType.get(instance.questionType) ?? 0) + 1);
console.log(`selection: ${[...byType].sort().map(([type, count]) => `${type} ${count}`).join(" · ")} · ${mapped.filter((instance) => instance.abstention).length} abstention(s)`);
// The ids in the order they will run, so a partial file can be read against
// the sample it was drawn from.
console.log(`sample: ${mapped.map((instance) => instance.questionId).join(", ")}`);
if (args.resume) {
	const strangers = answeredBefore.filter((id) => !mapped.some((instance) => instance.questionId === id));
	console.log(`resume: ${answeredBefore.length - strangers.length} of ${mapped.length} already answered in ${outFile}, ${todo.length} to go${strangers.length > 0 ? `; ${strangers.length} line(s) of the file answer instances outside this selection and are left as they are` : ""}`);
}

const numbers = estimate(todo, foldEvery, args.baseline);
printEstimate(numbers, args, foldEvery);
if (args.dryRun) {
	console.log("dry run: nothing was built, nothing was called, no home was made; drop --dry-run to run it");
	process.exit(0);
}

let gateway: Awaited<ReturnType<typeof startScriptedRoomGateway>> | null = null;
let server: BenchServer | null = null;
let ingestPair: RealIngest | null = null;
/** This run's rows, in the order they finished; the earlier run's are in `carried`. */
const results: InstanceResult[] = [];
let worker: MaintenanceWorker | null = null;
let lock: { provider: string; model: string } = { provider: "", model: "" };
// Empty until a run that will actually use one makes it, INSIDE the try, so
// that the sentence a dry run prints — nothing was built — is structurally true
// rather than true because of the order two statements happen to be in.
let home = "";
/** True once every instance of `todo` has been answered or marked failed; the meta says `partial` otherwise. */
let completed = false;

// --- The files, written as the run goes ---------------------------------------
//
// One line is appended to the hypothesis file the moment an instance is
// answered, and the meta is written on every way out: the normal end, an error
// that breaks the pipeline, an interrupt. A run of fifty instances that dies at
// the thirtieth has thirty answers on disk, not none.

const answered = () => results.filter((row) => row.hypothesis !== null);
/** The claim audit summed over every row that carries one, this run's and the carried ones. */
const totalClaims = (): ClaimAudit => [...carried, ...results].reduce<ClaimAudit>((total, row) => ({ memorized: total.memorized + (row.claims?.memorized ?? 0), unindexed: total.unindexed + (row.claims?.unindexed ?? 0), misassigned: total.misassigned + (row.claims?.misassigned ?? 0) }), { memorized: 0, unindexed: 0, misassigned: 0 });
const failed = () => results.filter((row) => row.hypothesis === null);

const record: RecordRow = (row) => {
	results.push(row);
	// The hypothesis file keeps upstream's line shape and nothing else, so a
	// failed instance has no line in it: the judge file holds answers only.
	if (row.hypothesis !== null) fs.appendFileSync(outFile, `${hypothesisLine({ questionId: row.question_id, hypothesis: row.hypothesis })}\n`);
};

const writeMeta = (partial: boolean): void => {
	const spentIngest = ingestPair?.usage() ?? { input: 0, output: 0, totalTokens: 0, cost: 0, calls: 0 };
	const askUsage = results.reduce((total, row) => ({ input: total.input + (row.usage?.input ?? 0), output: total.output + (row.usage?.output ?? 0), total: total.total + (row.usage?.total ?? 0), cost: total.cost + (row.usage?.cost ?? 0) }), { input: 0, output: 0, total: 0, cost: 0 });
	const meta = {
		bench: "longmemeval" as const,
		// 2: a row may carry `hypothesis: null` with a `failure` sentence, and the
		// file says whether it is partial and what it resumed from.
		schemaVersion: 2 as const,
		data: path.basename(dataFile),
		instances: mapped.length,
		model: `${lock.provider}/${lock.model}`,
		scripted: args.scripted,
		baseline: args.baseline ?? null,
		seed: args.seed,
		sample: args.sample ?? null,
		type: args.type ?? null,
		foldEvery,
		memoryBudgetTokens: DEFAULT_MEMORY_BUDGET_TOKENS,
		estimate: numbers,
		/** True when not every instance was reached: the pipeline broke or the run was interrupted. */
		partial,
		answered: carried.length + answered().length,
		/** The claim audit summed over the rows; both defect counts are zero on a sound pipeline. */
		claims: totalClaims(),
		failures: failed().map((row) => ({ question_id: row.question_id, failure: row.failure ?? "" })),
		/** The file this run carried on into, and what the earlier run spent; null on a fresh run. */
		resumedFrom: args.resume ? { file: outFile, answeredBefore: answeredBefore.length, usage: previousMeta?.usage ?? null } : null,
		/** This run's spend alone; an earlier run's is under resumedFrom. */
		usage: { ingest: spentIngest, ask: askUsage },
		rows: [...carried, ...results],
	};
	fs.mkdirSync(path.dirname(metaFile), { recursive: true });
	fs.writeFileSync(metaFile, `${JSON.stringify(meta, null, 2)}\n`);
};

// An interrupt writes the meta with what was done, stops what was started and
// leaves with 130, the way a shell reports a run that was interrupted. The
// hypothesis file needs nothing: every answer is already in it.
let interrupted = false;
process.on("SIGINT", () => {
	if (interrupted) return;
	interrupted = true;
	console.log(`\ninterrupted: ${answered().length} answered and ${failed().length} failed of ${todo.length}; ${outFile} keeps every answer, and the meta says partial`);
	void (async () => {
		try { writeMeta(true); } catch (error) { console.log(`the meta could not be written: ${(error as Error).message}`); }
		try { if (server) await server.stop(); } catch { /* it is being left either way */ }
		try { if (gateway) await gateway.close(); } catch { /* likewise */ }
		if (home && !args.keepHome) fs.rmSync(home, { recursive: true, force: true });
		process.exit(130);
	})();
});

try {
	home = prepareBenchHome("longmemeval").home;
	fs.mkdirSync(path.dirname(outFile), { recursive: true });
	// A fresh run starts its file empty, so a run that answers nothing still
	// leaves the file its meta describes; a resumed file that was cut off
	// without its last newline would glue the next line onto its last one.
	if (!args.resume) fs.writeFileSync(outFile, "");
	else if (fs.statSync(outFile).size > 0 && !fs.readFileSync(outFile, "utf-8").endsWith("\n")) fs.appendFileSync(outFile, "\n");
	if (args.scripted) {
		gateway = await startScriptedRoomGateway({ questions: todo.map(benchQuestion), plants: [], ...(scriptedFail ? { fail: scriptedFail } : {}) });
		lock = writeScriptedProviderRecords({ gatewayPort: gateway.port });
		console.log("scripted: the gateway answers every leg of this run — a checkpoint, a fold and the room's own turn alike.");
		console.log("  It quotes back lines that carry the recall fixture's reference codes, and LongMemEval's conversations carry none,");
		console.log("  so the folds keep nothing and the room answers \"I don't know\" to everything. The hypotheses are JUNK on purpose:");
		console.log("  what this run proves is that the pipeline runs end to end and that the files come out in the shape the judge reads.");
		if (scriptedFail) console.log(`  And every completion whose request carries "${scriptedFail.marker}" is ${scriptedFail.hang ? "held open and never answered" : "answered with an HTTP 500"}, ${scriptedFail.times === "all" ? "every time" : `${scriptedFail.times} time(s)`}: what this run proves is the waiting.`);
	} else {
		lock = useRealProviderRecords({ spec: realSpec! });
	}
	setBenchModel(lock);
	worker = await createMaintenanceWorker();

	if (todo.length === 0) {
		console.log(`\nnothing to do: ${outFile} already answers every instance of this selection`);
	} else if (args.baseline === "transcript") {
		console.log(`\nbaseline transcript: the whole haystack in one prompt, through the isolated worker, on ${lock.provider}/${lock.model}`);
		await runTranscriptBaseline(todo, worker, lock, record);
	} else {
		if (args.baseline !== "none") ingestPair = await createRealIngest({ roomModel: lock });
		else console.log("\nbaseline none: every room is scaffolded and nothing is ever remembered into it, so whatever is scored is what the questions give away by themselves");
		server = await startBenchServer({ home, model: lock });
		console.log(`server: ${server.baseUrl} · model ${server.model.provider}/${server.model.model} · memory budget ${DEFAULT_MEMORY_BUDGET_TOKENS} tokens · fold every ${foldEvery}`);
		await runRooms(todo, args, home, server, ingestPair, record);
	}
	completed = true;

	// The hypothesis file was appended as the run went, one line per answered
	// instance in upstream's shape; it is handed to `evaluate_qa.py` unchanged,
	// and a third key in those lines would be a file only our own tools can read.
	const lines = answeredIn(outFile);
	console.log(`\nhypotheses: ${outFile} · ${lines.length} line(s)${args.resume ? `, ${answered().length} of them appended by this run` : ""}${failed().length > 0 ? ` · ${failed().length} failed instance(s) have no line` : ""}`);
	writeMeta(false);
	console.log(`meta: ${metaFile}`);

	console.log("");
	console.log(`${pad("question", 26)}${pad("type", 27)}${pad("sess", 6, true)}${pad("notes", 7, true)}${pad("memory", 8, true)}${pad("recall", 8, true)}${pad("ingest s", 10, true)}${pad("ask s", 7, true)}`);
	for (const row of answered()) {
		console.log(
			pad(row.question_id, 26) +
				pad(row.question_type + (row.abstention ? " (abs)" : ""), 27) +
				pad(row.sessions, 6, true) +
				pad(row.notesInCore, 7, true) +
				pad(row.memoryTokens, 8, true) +
				pad(row.recallCalls, 8, true) +
				pad(Math.round(row.ingestMs / 1000), 10, true) +
				pad(Math.round(row.askMs / 1000), 7, true),
		);
	}
	console.log("");
	// The instances the provider gave up on, each with its sentence, and the
	// count in the summary line so a log's last screen says how the run went.
	for (const row of failed()) console.log(`failed ${row.question_id}: ${row.failure}`);
	console.log(`summary: ${answered().length} answered, ${failed().length} failed${args.resume ? `, ${carried.length} carried from the earlier run` : ""}; ${lines.length} line(s) in the hypothesis file`);
	// The claim audit, summed over every row that ingested, an earlier run's
	// included. It is printed once, and a non-zero count is said in capitals
	// because it is a defect of the pipeline under every answer above.
	const audited = [...carried, ...results].filter((row) => row.claims);
	if (audited.length > 0) {
		const total = totalClaims();
		console.log(claimsLine(total));
		if (claimsFailed(total)) console.log(`CLAIM AUDIT FAILED: ${audited.filter((row) => claimsFailed(row.claims!)).map((row) => row.question_id).join(", ")}: a memorized conversation is missing from the search index or filed under another conversation's name`);
	}
	const spentIngest = ingestPair?.usage() ?? { input: 0, output: 0, totalTokens: 0, cost: 0, calls: 0 };
	const askUsage = results.reduce((total, row) => ({ input: total.input + (row.usage?.input ?? 0), output: total.output + (row.usage?.output ?? 0), total: total.total + (row.usage?.total ?? 0), cost: total.cost + (row.usage?.cost ?? 0) }), { input: 0, output: 0, total: 0, cost: 0 });
	if (spentIngest.calls > 0) console.log(`ingest cost: ${spentIngest.calls} worker call(s) · in ${spentIngest.input} tok · out ${spentIngest.output} tok${spentIngest.cost > 0 ? ` · $${spentIngest.cost.toFixed(4)}` : ""}`);
	console.log(`ask cost: in ${askUsage.input} tok · out ${askUsage.output} tok · ${askUsage.total} total${askUsage.cost > 0 ? ` · $${askUsage.cost.toFixed(4)}` : ""}`);

	// --- the judge -----------------------------------------------------------
	// Over the hypothesis file as it stands: every answered instance, an earlier
	// run's lines included, and none of the failed ones, which have no line.
	if (args.judge) {
		if (args.scripted) {
			console.log(`\njudge: ${args.judge} needs a real model and this run is --scripted; the hypotheses are written and nothing is judged`);
		} else {
			const judgeSlash = args.judge.indexOf("/");
			if (judgeSlash < 1) throw new Error(`--judge must read provider/model, e.g. anthropic/claude-sonnet-5 — got "${args.judge}"`);
			const judgeLock = { provider: args.judge.slice(0, judgeSlash), model: args.judge.slice(judgeSlash + 1) };
			console.log(`\njudge: ${args.judge}, on LongMemEval's own templates`);
			let judgePromptTokens = 0;
			const { judged, skipped, table } = await judgeHypotheses({
				lines: fs.readFileSync(outFile, "utf-8").split("\n").filter((line) => line.trim()).map((line) => JSON.parse(line) as JudgeHypothesisLine),
				references: chosen as unknown as JudgeReference[],
				model: args.judge,
				generate: async (prompt) => {
					judgePromptTokens += answerTokens(prompt);
					const reply = await worker!.call({
						prompt,
						modelLock: judgeLock,
						label: "longmemeval judge worker",
						triggerPrompt: "Answer yes or no now.",
						emptyTextError: "the judge produced no text",
					});
					return reply.text;
				},
				onVerdict: ({ index, total }) => {
					if (index % 10 === 0 || index === total) console.log(`  ${index}/${total}`);
				},
			});
			for (const id of skipped) console.log(`  skipped ${id}: the reference file holds no instance with that id`);
			fs.writeFileSync(`${outFile}.judged.jsonl`, `${judged.map((row) => JSON.stringify(row)).join("\n")}\n`);
			console.log(`judged: ${outFile}.judged.jsonl · ${judgePromptTokens} prompt tokens asked of the judge`);
			console.log("");
			for (const line of renderJudgeTable(table)) console.log(line);
		}
	}

	// The adapter's own worker, which the ingest's is not: a baseline's one big
	// prompt and every judge verdict go through this one, and the ingest keeps
	// its own counters, so the two lines never double-count a call.
	const workerSpent = worker.usage();
	if (workerSpent.calls > 0) console.log(`\nbaseline and judge cost: ${workerSpent.calls} worker call(s) · in ${workerSpent.input} tok · out ${workerSpent.output} tok${workerSpent.cost > 0 ? ` · $${workerSpent.cost.toFixed(4)}` : ""}`);
} finally {
	// The meta of a run that broke: what was done up to the break, marked
	// partial, written before the error goes on up. A meta that cannot be
	// written must not hide the error that is being reported.
	if (!completed && !interrupted) {
		try { writeMeta(true); console.log(`meta: ${metaFile} (partial)`); } catch (error) { console.log(`the meta could not be written: ${(error as Error).message}`); }
	}
	if (server) await server.stop();
	if (gateway) await gateway.close();
	// A run's home is a room's worth of files per instance; it goes with the run
	// unless the reader asked to keep it. A run that never got as far as making
	// one has nothing to remove.
	if (home && !args.keepHome) fs.rmSync(home, { recursive: true, force: true });
}

if (args.keepHome) console.log(`home kept: ${home}`);
if (gateway) console.log(`the scripted gateway answered ${gateway.calls} completions${gateway.failed > 0 ? `, ${gateway.failed} of them with the scripted failure` : ""}`);
// Answered by this run or by the one it carried on: a file with an answer in it
// is a run worth judging, and a run with none is not.
process.exitCode = answeredBefore.length + answered().length > 0 && !claimsFailed(totalClaims()) ? 0 : 1;
console.log("\nJudgment is never an exit code. This run exits non-zero only when the pipeline broke, the claim audit failed or no instance at all was answered; a room that answers badly is a table.");
