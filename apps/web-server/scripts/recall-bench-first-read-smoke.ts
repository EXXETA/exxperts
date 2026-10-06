// The bench's first-read switch, offline, against the scripted gateway.
//
// Every bench Memorize folds with a first read, and `--first-read` chooses
// which: `fixed`, the bench's own text and the default every earlier number
// was measured with; `none`, the "None." the fast Start hands a run; `real`,
// the room's own first read, one call per Memorize run. This smoke pins, with
// no provider at all:
//   - the engine: what each fold prompt carried as its first read, and how
//     many first-read calls were made, in each mode; a first read the provider
//     never answers, and one too long to carry, each continue with "None." and
//     are counted apart;
//   - the adapter: the flag, the dry run's estimate line, the totals line, the
//     mode in the meta and on its rows, and a resume that would mix two modes.

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import * as engine from "./memory-bench/recall-engine.mjs";
import { buildRecallFixture } from "./memory-bench/recall-fixtures.mjs";

const webServerDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}
const pass = (message: string) => console.log(`ok ${message}`);

// Read off the module as a whole: a tree without the switch fails on the first
// assertion that needs it, not on a loader error.
const createRealIngest = engine.createRealIngest as unknown as (input: { roomModel: { provider: string; model: string }; firstRead?: string }) => Promise<engine.RealIngest & { firstReads?: () => { mode: string; model: string; runs: number; calls: number; missing: number; tooLong: number } }>;
const SCRIPTED_FIRST_READ_LINE = "The scripted first read asks to keep every date and number.";
const FIXED_LINE = "Every waiting conversation is to be folded.";

const { home } = engine.prepareBenchHome("recall-bench-first-read-smoke");
process.env.RECALL_BENCH_RETRY_SCHEDULE_MS = "10,10,10,10,10";
const sessions = buildRecallFixture({ language: "en", sessions: 4, questionsPerAbility: 1, conversationQuestions: 1 }).sessions.slice(0, 4);

/** Four conversations, a Memorize after every two: two runs, each through the real run on the scripted gateway. */
async function ingest(mode: string | undefined, gatewayOptions: { fail?: engine.ScriptedGatewayFailure; longFirstRead?: boolean } = {}, records: { reasoning?: boolean } = {}) {
	const gateway = await engine.startScriptedRoomGateway({ questions: [], plants: [], ...gatewayOptions } as Parameters<typeof engine.startScriptedRoomGateway>[0]);
	try {
		const lock = (engine.writeScriptedProviderRecords as (input: { gatewayPort: number; reasoning?: boolean }) => { provider: string; model: string })({ gatewayPort: gateway.port, ...records });
		engine.setBenchModel(lock);
		const pair = await createRealIngest({ roomModel: lock, ...(mode ? { firstRead: mode } : {}) });
		const room = await engine.createBenchRoom({ home, name: `First Read ${mode ?? "default"} ${Math.random().toString(36).slice(2, 6)}` });
		engine.startProviderRetryUnit();
		const report = await engine.ingestSessions({ roomId: room.roomId, sessions, remember: pair.remember, memorize: pair.memorize, foldEvery: 2 });
		const assessments = ((gateway as { assessments?: string[] }).assessments ?? []).map((text) => text.trim());
		return { report, assessments, firstReadCalls: (gateway as { firstReads?: number }).firstReads ?? -1, tally: pair.firstReads?.(), efforts: (gateway as { reasoningEfforts?: { firstRead: Array<string | null>; fold: Array<string | null> } }).reasoningEfforts };
	} finally {
		engine.startProviderRetryUnit();
		await gateway.close();
	}
}

try {
	// --- The engine ---------------------------------------------------------
	const fixed = await ingest(undefined);
	assert(fixed.report.steps.length === 2 && fixed.report.failures.length === 0, `four conversations folded every two make two clean Memorize runs, got ${fixed.report.steps.length} and ${fixed.report.failures.length} failure(s)`);
	assert(fixed.assessments.length === 4 && fixed.assessments.every((text) => text.includes(FIXED_LINE)), `left out, the first read is the bench's fixed text in every fold, got ${JSON.stringify(fixed.assessments.map((text) => text.slice(0, 60)))}`);
	assert(fixed.firstReadCalls === 0 && fixed.tally?.mode === "fixed" && fixed.tally.calls === 0 && fixed.tally.runs === 2, `the fixed first read makes no call, got ${fixed.firstReadCalls} at the gateway and ${JSON.stringify(fixed.tally)}`);
	assert(engine.firstReadTallyLine(fixed.tally as Parameters<typeof engine.firstReadTallyLine>[0]) === "first reads (fixed): none asked; all 2 Memorize run(s) folded with the bench's fixed text", "the fixed totals line says no read was asked");
	pass("fixed, the default: every fold carries the bench's text, and no first-read call is made");

	const none = await ingest("none");
	assert(none.assessments.length === 4 && none.assessments.every((text) => text === "None."), `none: every fold carries "None.", got ${JSON.stringify(none.assessments.map((text) => text.slice(0, 60)))}`);
	assert(none.firstReadCalls === 0 && none.tally?.calls === 0, `none makes no first-read call, got ${none.firstReadCalls}`);
	assert(engine.firstReadTallyLine(none.tally as Parameters<typeof engine.firstReadTallyLine>[0]) === 'first reads (none): none asked; all 2 Memorize run(s) folded with "None."', "the none totals line says every run folded with None.");
	pass('none: every fold carries "None.", as the fast Start hands the run, and no first-read call is made');

	const real = await ingest("real");
	assert(real.firstReadCalls === 2 && real.tally?.calls === 2 && real.tally.runs === 2, `real: one first read per Memorize run, got ${real.firstReadCalls} at the gateway and ${JSON.stringify(real.tally)}`);
	assert(real.assessments.length === 4 && real.assessments.every((text) => text.includes(SCRIPTED_FIRST_READ_LINE)), `real: the room's first read reaches every fold of its run, got ${JSON.stringify(real.assessments.map((text) => text.slice(0, 80)))}`);
	assert(real.tally.missing === 0 && real.tally.tooLong === 0 && real.report.failures.length === 0, `real: nothing missing, got ${JSON.stringify(real.tally)}`);
	assert(/^first reads \(real, openai-compatible\/[^)]+\): 2 call\(s\) over 2 Memorize run\(s\)/.test(engine.firstReadTallyLine(real.tally as Parameters<typeof engine.firstReadTallyLine>[0])), `the totals line names the mode and the model, got ${engine.firstReadTallyLine(real.tally as Parameters<typeof engine.firstReadTallyLine>[0])}`);
	pass(`real: one first-read call per Memorize run, its words in every fold, and "${engine.firstReadTallyLine(real.tally as Parameters<typeof engine.firstReadTallyLine>[0]).split(" · ")[0]}"`);

	// The level each call asks for, read off the requests of a model that can
	// reason: the folds at "low", as every earlier number was measured; the first
	// read with no level of its own, as the product's route asks.
	const reasoned = await ingest("real", {}, { reasoning: true });
	assert(reasoned.efforts && reasoned.efforts.fold.length === 4 && reasoned.efforts.fold.every((effort) => effort === "low"), `every fold asks for low reasoning, got ${JSON.stringify(reasoned.efforts?.fold)}`);
	assert(reasoned.efforts.firstRead.length === 2 && reasoned.efforts.firstRead.every((effort) => effort !== "low"), `the first read runs at the model's default, never the bench's low, got ${JSON.stringify(reasoned.efforts.firstRead)}`);
	pass(`the folds ask for "low" and the first read for the model's default (${JSON.stringify(reasoned.efforts.firstRead[0])}), as the product's route does`);

	const down = await ingest("real", { fail: { marker: "## Task: Compact Initial Assessment", times: "all" } });
	assert(down.assessments.length === 4 && down.assessments.every((text) => text === "None."), `a first read the provider never answers: the runs fold with "None.", got ${JSON.stringify(down.assessments.map((text) => text.slice(0, 60)))}`);
	assert(down.tally?.missing === 2 && down.tally.tooLong === 0 && down.report.failures.length === 0 && down.report.steps.length === 2, `each run carries on and is counted missing, got ${JSON.stringify(down.tally)} and ${down.report.failures.length} failure(s)`);
	pass('a first read the provider never answers: each run folds with "None." and is counted missing');

	const long = await ingest("real", { longFirstRead: true });
	assert(long.assessments.length === 4 && long.assessments.every((text) => text === "None."), `a first read too long to carry: the runs fold with "None.", got ${JSON.stringify(long.assessments.map((text) => text.slice(0, 60)))}`);
	assert(long.tally?.tooLong === 2 && long.tally.missing === 0 && long.firstReadCalls === 4, `each run's read is asked once more, then counted too long, got ${long.firstReadCalls} call(s) and ${JSON.stringify(long.tally)}`);
	pass('a first read too long to carry: asked once more, then the run folds with "None." and is counted too long');

	// --- The adapter --------------------------------------------------------
	const data = path.join(home, "first-read-data.json");
	fs.writeFileSync(data, JSON.stringify([
		{ question_id: "fr_a", question_type: "multi-session", question: "Which port does the export run on?", answer: "8443", question_date: "2023/06/02 (Fri) 09:15", haystack_session_ids: ["a-1", "a-2"], haystack_dates: ["2023/04/10 (Mon) 23:07", "2023/04/12 (Wed) 08:30"], haystack_sessions: [[{ role: "user", content: "The export runs on port 8443 since the move." }, { role: "assistant", content: "Noted, port 8443." }], [{ role: "user", content: "The vendor contract ceiling is 55,000 EUR." }, { role: "assistant", content: "Noted." }]] },
	]));
	const adapter = (args: string[]) => {
		const run = spawnSync("npx", ["tsx", "scripts/memory-bench/longmemeval-adapter.mts", "--scripted", "--data", data, ...args], { cwd: webServerDir, shell: process.platform === "win32", encoding: "utf-8", env: { ...process.env }, maxBuffer: 64 * 1024 * 1024 });
		return { status: run.status, out: `${run.stdout ?? ""}${run.stderr ?? ""}` };
	};
	const bogus = adapter(["--first-read", "maybe", "--dry-run"]);
	assert(bogus.status !== 0 && bogus.out.includes("--first-read must be fixed, none, real"), `an unknown mode is refused, got ${bogus.status}: ${bogus.out.slice(-300)}`);
	const dryReal = adapter(["--first-read", "real", "--dry-run"]);
	assert(dryReal.status === 0 && /^estimate: first read ≈ 1 call\(s\), one per Memorize run ≈ \d+k prompt tokens/m.test(dryReal.out), `the dry run of real adds its first-read line, got:\n${dryReal.out.split("\n").filter((line) => line.startsWith("estimate")).join("\n")}`);
	const dryFixed = adapter(["--dry-run"]);
	assert(dryFixed.status === 0 && !/first read ≈/.test(dryFixed.out), "the default's dry run has no first-read line");
	pass("the adapter refuses an unknown mode, and the dry run of real adds one first-read call per Memorize run");

	const out = path.join(home, "first-read-real.jsonl");
	const ran = adapter(["--first-read", "real", "--out", out]);
	assert(ran.status === 0, `the scripted run with --first-read real exited ${ran.status}:\n${ran.out.slice(-1200)}`);
	assert(/^first reads \(real, [^)]+\): 1 call\(s\) over 1 Memorize run\(s\) · in \d+ tok · out \d+ tok · 0 missing and 0 too long/m.test(ran.out), `the totals print the first reads apart, got:\n${ran.out.split("\n").filter((line) => line.startsWith("first reads")).join("\n") || "(no first reads line)"}`);
	const meta = JSON.parse(fs.readFileSync(`${out}.meta.json`, "utf-8")) as { firstRead?: string; rows: Array<{ firstRead?: string }>; usage: { firstReads?: { calls: number } } };
	assert(meta.firstRead === "real" && meta.rows.length === 1 && meta.rows.every((row) => row.firstRead === "real") && meta.usage.firstReads?.calls === 1, `the meta and its rows name the mode, got ${JSON.stringify({ firstRead: meta.firstRead, rows: meta.rows.map((row) => row.firstRead), firstReads: meta.usage.firstReads })}`);
	const mixed = adapter(["--resume", out, "--first-read", "none"]);
	assert(mixed.status !== 0 && mixed.out.includes("was run with --first-read real, and this run asks for none"), `a resume with another mode is refused, got ${mixed.status}: ${mixed.out.slice(-300)}`);
	pass('the adapter prints "first reads (real, ...)", names the mode in the meta and on every row, and a resume refuses another mode');

	console.log("recall-bench-first-read smoke passed");
} finally {
	fs.rmSync(home, { recursive: true, force: true });
}
