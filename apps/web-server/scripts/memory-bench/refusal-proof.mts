/**
 * The refusal proof (design section 6, "Prove"): the LongMemEval-S question
 * whose Remember the 0.14.2 gate saw refused, run through the product's three
 * layers on real models.
 *
 * 1. Find: each session of the question is remembered ALONE, as the bench
 *    remembers it, on the first model (Sonnet 5 by default), in a fresh room;
 *    a session any call of which the provider refused is the one.
 * 2. Prove: that session is remembered again on every model, through the
 *    product's own Remember (a refused single pass goes to parts, a refused
 *    part to halves with the high-level lines, down to quarters, then the
 *    safety-net line; a refused final call is asked again at a high level,
 *    then the page is built from the notes). Every call is reported: its kind,
 *    whether it carried the high-level lines, and whether it was refused.
 *
 * Pass: a page comes out on every model with at most one unread stretch and
 * no engine text in it. Prevent fails: two or more unread stretches on one
 * model. Design fails: the final call refused after its high-level retry (the
 * page was built by code). Engine text in the page (a line saying a stretch
 * could not be summarized or was not read, a "(Shortened" mark, or that the
 * entry was put together from the notes) fails it too, counted as engineLines.
 * The room is fresh, not the gate's room at that point (that room was not
 * kept), so its memory is the scaffold's.
 *
 * COSTS MONEY (about a dozen calls to prove, plus one or two per session to
 * find): run it only with the person's word. `--scripted` runs both phases on
 * a fake model and a synthetic question, offline, which is how the script
 * itself is proved (`--scripted-engine-line` makes the fake write engine text
 * into its entry, to prove that check). A real run names its sign-in as the bench does: the dir
 * RECALL_BENCH_AGENT_DIR names, or a read-only copy of ~/.exxperts/agent with
 * --sign-in-from-home; with neither it stops before any call.
 *
 *   npx tsx scripts/memory-bench/refusal-proof.mts --data scripts/memory-bench/data/longmemeval_s_cleaned.json
 *   npx tsx scripts/memory-bench/refusal-proof.mts --session <haystack session id>   (skip the find)
 *   npx tsx scripts/memory-bench/refusal-proof.mts --scripted
 *
 * Options: --question (default gpt4_2655b836); --models provider/model,...
 * (default anthropic/claude-sonnet-5,anthropic/claude-sonnet-5-5; the first
 * one finds); --out <file>.
 */

import fs from "node:fs";
import path from "node:path";

import { createMaintenanceWorker, localDay, prepareBenchHome, resultsDir, SIGN_IN_FROM_HOME_FLAG, useRealProviderRecords } from "./recall-engine.mjs";
import { mapInstance, type LongMemEvalInstance } from "./longmemeval-map.mjs";
import type { RecallSession } from "./recall-fixtures.mjs";

type ModelLock = { provider: string; model: string };
type Reply = { text: string; truncated?: boolean; usage?: { input?: number; output?: number; cost?: number } };
interface CallRow { kind: string; highLevel: boolean; refused: boolean; failed?: string }

const argv = process.argv.slice(2);
const option = (name: string) => { const at = argv.indexOf(`--${name}`); return at >= 0 ? argv[at + 1] : undefined; };
const scripted = argv.includes("--scripted");
const scriptedEngineLine = scripted && argv.includes("--scripted-engine-line");
const questionId = option("question") ?? "gpt4_2655b836";
const models: ModelLock[] = (option("models") ?? (scripted ? "openai-compatible/gpt-5.5" : "anthropic/claude-sonnet-5,anthropic/claude-sonnet-5-5")).split(",").map((spec) => ({ provider: spec.slice(0, spec.indexOf("/")), model: spec.slice(spec.indexOf("/") + 1) }));

const home = prepareBenchHome("refusal-proof");
const pa = await import("../../src/persistent-agents.js");
const { classifyModelFailure } = await import("../../src/model-call-causes.js");
const { listMaintenanceDiagnostics } = await import("../../src/maintenance-diagnostics.js");

// --- The question's sessions --------------------------------------------------------

/** The synthetic question the fake proves the script on: four sessions, the third carries what the fake refuses. */
const SCRIPTED_REFUSED = "SCRIPTED-REFUSED-STRETCH";
function scriptedSessions(): RecallSession[] {
	return [1, 2, 3, 4].map((n) => ({
		id: `S0${n}`,
		date: `2023-05-0${n}`,
		title: `Session ${n}`,
		turns: Array.from({ length: 12 }, (_, k) => ({ role: k % 2 ? "assistant" : "user", text: `Session ${n}, turn ${k}: ${n === 3 && k === 6 ? `${SCRIPTED_REFUSED} ` : ""}${"we talked about the trip, the budget and the dates. ".repeat(6)}` })),
	})) as unknown as RecallSession[];
}
function questionSessions(): RecallSession[] {
	if (scripted) return scriptedSessions();
	const file = option("data") ?? path.join(new URL(".", import.meta.url).pathname, "data", "longmemeval_s_cleaned.json");
	if (!fs.existsSync(file)) throw new Error(`${file} is not there. The LongMemEval data is downloaded by hand and never committed; see "The LongMemEval adapter" in scripts/memory-bench/README.md`);
	const instance = (JSON.parse(fs.readFileSync(file, "utf-8")) as LongMemEvalInstance[]).find((candidate) => candidate.question_id === questionId);
	if (!instance) throw new Error(`${questionId} is not in ${file}`);
	return mapInstance(instance).sessions;
}

// --- The model --------------------------------------------------------------------------

type Generate = (prompt: string, call?: { callKind?: string; trigger?: string; signal?: AbortSignal }) => Promise<Reply>;
async function makeModel(lock: ModelLock): Promise<{ generate: Generate; window: { contextWindow: number; maxOutputTokens: number } }> {
	if (scripted) return { generate: scriptedGenerate, window: { contextWindow: 200_000, maxOutputTokens: 16_000 } };
	useRealProviderRecords({ spec: `${lock.provider}/${lock.model}`, signInFromHome: argv.includes(SIGN_IN_FROM_HOME_FLAG) });
	const worker = await createMaintenanceWorker();
	// The window the product's Remember reads, from the same registry.
	return {
		window: worker.modelWindow(lock),
		generate: (prompt, call) => worker.call({
			prompt,
			modelLock: lock,
			label: `refusal proof ${call?.callKind ?? "remember-single"}`,
			triggerPrompt: call?.trigger ?? "Produce the checkpoint compression fields now.",
			emptyTextError: "checkpoint compression worker produced no text",
			maxOutputTokens: pa.REMEMBER_WORKER_MAX_OUTPUT_TOKENS,
			...(call?.signal ? { signal: call.signal } : {}),
		}) as Promise<Reply>,
	};
}

/** The fake: refuses a stretch with the marker unless it is asked at a high level, as a provider's safety check might. */
const scriptedGenerate: Generate = async (prompt, call) => {
	if (prompt.includes(SCRIPTED_REFUSED) && !/## Read at a High Level/.test(prompt)) throw Object.assign(new Error("checkpoint compression worker failed: the model refused to answer this request"), { providerMessage: "the model refused to answer this request" });
	return call?.callKind === "remember-part"
		? { text: "DECISIONS:\n- The trip moves to June.\n\nOPEN:\nNone\n\nMUST_KEEP:\nNone\n" }
		: { text: `TITLE:\nThe trip\n\nSESSION_ARC:\nWe planned the trip.\n\nBODY:\n- The trip moves to June.${scriptedEngineLine ? "\n- Messages 3 to 5 were not read." : ""}\n\nPARKED:\nNone\n` };
};

/** Engine text a saved page must never hold: how the entry was made is the diagnostics', never the memory's. */
const ENGINE_TEXT = /could not be summarized|were not read|was not read|\(Shortened|put together from the notes/i;

let rooms = 0;
/** One Remember of `session` alone, in a fresh room, through the product's Remember; every call recorded. */
async function rememberAlone(session: RecallSession, lock: ModelLock, { generate, window }: Awaited<ReturnType<typeof makeModel>>) {
	rooms += 1;
	const agentId = pa.createPersistentAgentFromScaffoldInput({ displayName: `Refusal Proof ${rooms}`, userName: "Synthetic User", preferredUserAddress: "Synthetic User" }).agent.agentId;
	const threadId = `c_proof_${rooms}`;
	const written = pa.writePersistentAgentThread(agentId, threadId, { state: "active", origin: "home", model: lock, items: [] }, { createRuntime: ({ model }) => pa.createPersistentAgentPiSessionJsonlThreadRuntime({ agentId, threadId, model, cwd: home.threadCwd }) });
	const manager = pa.openPersistentAgentPiSessionManager(agentId, written.thread.runtime as any, home.threadCwd);
	session.turns.forEach((turn, index) => {
		const timestamp = Date.parse(`${session.date}T10:00:00.000Z`) + index;
		if (turn.role === "user") manager.appendMessage({ role: "user", content: turn.text, timestamp } as any);
		else manager.appendMessage({ role: "assistant", content: [{ type: "text", text: turn.text }], api: "responses", provider: lock.provider, model: lock.model, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp } as any);
	});
	const calls: CallRow[] = [];
	let page = "";
	let error: string | undefined;
	try {
		const proposal: any = await pa.buildCheckpointProposal({ agentId, conversationId: threadId, model: lock, density: "standard", runtimeCwd: home.threadCwd }, (async (prompt: string, _model: ModelLock, call?: { callKind?: string; trigger?: string; signal?: AbortSignal }) => {
			const row: CallRow = { kind: call?.callKind ?? "remember-single", highLevel: /## Read at a High Level/.test(prompt), refused: false };
			calls.push(row);
			try {
				return await generate(prompt, call);
			} catch (failure) {
				row.refused = classifyModelFailure(failure).cause === "refused";
				if (!row.refused) row.failed = failure instanceof Error ? failure.message.slice(0, 200) : String(failure);
				throw failure;
			}
		}) as any, { resolveModelWindow: () => window } as any);
		page = String(proposal.proposedRecentContext ?? "");
	} catch (failure) {
		error = failure instanceof Error ? failure.message.slice(0, 300) : String(failure);
	}
	const finals = calls.filter((call) => call.kind !== "remember-part");
	return {
		session: session.id,
		model: `${lock.provider}/${lock.model}`,
		calls,
		refusedCalls: calls.filter((call) => call.refused).length,
		pageCameOut: Boolean(page) && !error,
		// Lines of the saved page that say how it was made.
		engineLines: page.split(/\r?\n/).filter((line) => ENGINE_TEXT.test(line)).length,
		// Stretches no read could note (the safety net): the page says nothing of them, the diagnostics do.
		unreadStretches: listMaintenanceDiagnostics(pa.createPersistentAgentInstance(agentId).rootDir, 500).filter((record) => record.process === "remember-part" && record.validatorWarnings?.includes("refused-net")).length,
		// The final call refused after its high-level retry: the page was built from the notes by code.
		builtByCode: finals.length >= 2 && finals.slice(-2).every((call) => call.refused),
		...(error ? { error } : {}),
	};
}

// --- The run ------------------------------------------------------------------------------

// The temp home goes on every way out, a throw included: a real run's copy of the sign-in is in it.
let passed = false;
try {
	const sessions = questionSessions();
	const finder = models[0];
	const findModel = await makeModel(finder);
	let suspects = option("session") ? sessions.filter((session) => session.id === option("session")) : [];
	const found: Array<Awaited<ReturnType<typeof rememberAlone>>> = [];
	if (suspects.length === 0) {
		console.log(`find: ${sessions.length} sessions of ${scripted ? "the scripted question" : questionId}, each remembered alone on ${finder.provider}/${finder.model}`);
		for (const session of sessions) {
			const row = await rememberAlone(session, finder, findModel);
			found.push(row);
			if (row.refusedCalls > 0) console.log(`  ${session.id}: ${row.refusedCalls} refused call(s)`);
		}
		suspects = sessions.filter((session) => found.some((row) => row.session === session.id && row.refusedCalls > 0));
		console.log(suspects.length ? `found: ${suspects.map((session) => session.id).join(", ")}` : "found: no session refused on its own; the gate's refusal needs the room's memory as it was, which this script cannot rebuild");
	}

	const proofs: Array<Awaited<ReturnType<typeof rememberAlone>>> = [];
	for (const lock of models) {
		const model = lock === finder ? findModel : await makeModel(lock);
		for (const session of suspects) {
			const row = await rememberAlone(session, lock, model);
			proofs.push(row);
			console.log(`prove ${session.id} on ${row.model}: ${row.calls.map((call) => `${call.kind}${call.highLevel ? "+high-level" : ""}${call.refused ? ":REFUSED" : call.failed ? ":FAILED" : ":ok"}`).join(" ")} · page ${row.pageCameOut ? "came out" : "DID NOT come out"} · ${row.unreadStretches} unread stretch(es) · ${row.engineLines} engine line(s)${row.builtByCode ? " · page built by code" : ""}`);
		}
	}

	const verdict = suspects.length === 0 ? "nothing to prove" : proofs.some((row) => !row.pageCameOut || row.builtByCode) ? "design fails" : proofs.some((row) => row.engineLines > 0) ? "engine text in the page" : proofs.some((row) => row.unreadStretches >= 2) ? "prevent fails" : proofs.every((row) => row.unreadStretches <= 1) ? "pass" : "design fails";
	const summary = { day: localDay(), scripted, question: scripted ? "scripted" : questionId, finder: `${finder.provider}/${finder.model}`, found: found.map(({ session, refusedCalls }) => ({ session, refusedCalls })), suspects: suspects.map((session) => session.id), proofs, verdict };
	const out = option("out") ?? path.join(resultsDir(), `refusal-proof-${summary.day}${scripted ? "-scripted" : ""}.json`);
	fs.mkdirSync(path.dirname(out), { recursive: true });
	fs.writeFileSync(out, `${JSON.stringify(summary, null, 2)}\n`);
	console.log(`verdict: ${verdict}`);
	console.log(`report: ${out}`);
	passed = verdict === "pass";
} finally {
	fs.rmSync(home.home, { recursive: true, force: true });
}
process.exitCode = passed ? 0 : 1;
