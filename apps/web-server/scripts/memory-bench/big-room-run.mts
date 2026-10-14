/**
 * The big-room run (decision 19): Remember never fails and nothing ends in
 * Unsorted, on real models, in rooms shaped like a heavy month.
 *
 * Each room holds a memory at its 20k-token budget, 19 waiting pages of about
 * 8,000 characters and one conversation of about 150k tokens. The run
 * Remembers the conversation (the 20th page), then Memorizes with a real first
 * read, then Reviews (the tidy), and saves each. A room passes with every
 * page folded or dropped, nothing in Unsorted, no notice (no run stopped on an
 * unreachable model) and no safety-net line.
 *
 * It reports what the ladder and the split cost, from the calls themselves:
 * per page, the calls by rung (1 the whole page, 2 the stricter ask, 3-4 the
 * pieces and what is left, 5 the placement; the ladder's worst case is 8 calls
 * plus the probe, 13 with refusals) and the probes; per Review group, the
 * calls of its split (worst case 9 for 2 topics, 45 for 8).
 *
 * COSTS MONEY: every call is a real model call on the person's sign-in. Run
 * it only with the person's word. `--scripted` runs the same flow on a fake
 * model, offline, which is how the script itself is proved.
 *
 *   npx tsx scripts/memory-bench/big-room-run.mts --models anthropic/claude-sonnet-5-5:3,anthropic/claude-sonnet-5:1
 *   npx tsx scripts/memory-bench/big-room-run.mts --scripted
 *
 * Options: --models provider/model:rooms,... (default as above); --out <file>
 * (default results/big-room-<day>.json beside the bench's results); --scripted.
 * A real run reads the person's sign-ins as the bench does: from the dir
 * RECALL_BENCH_AGENT_DIR names, or a read-only copy of ~/.exxperts/agent with
 * --sign-in-from-home; with neither it stops before any call.
 */

import fs from "node:fs";
import path from "node:path";

import { createMaintenanceWorker, localDay, prepareBenchHome, resultsDir, SIGN_IN_FROM_HOME_FLAG, useRealProviderRecords } from "./recall-engine.mjs";

type ModelLock = { provider: string; model: string };
type Reply = { text: string; truncated?: boolean; usage?: { input?: number; output?: number; cost?: number } };
type CallKind = "remember-part" | "remember-final" | "first-read" | "fold" | "placement" | "probe" | "review";
interface CallRecord { room: string; kind: CallKind; page?: string; rung?: string; highLevel: boolean; topics?: string[]; failed?: string; cost: number }

const argv = process.argv.slice(2);
const flag = (name: string) => argv.includes(`--${name}`);
const option = (name: string) => { const at = argv.indexOf(`--${name}`); return at >= 0 ? argv[at + 1] : undefined; };
const scripted = flag("scripted");
const plan = (option("models") ?? (scripted ? "openai-compatible/gpt-5.5:2" : "anthropic/claude-sonnet-5-5:3,anthropic/claude-sonnet-5:1")).split(",").map((part) => {
	const [spec, count] = part.split(":");
	const slash = spec.indexOf("/");
	return { lock: { provider: spec.slice(0, slash), model: spec.slice(slash + 1) }, rooms: Math.max(1, Number(count ?? "1") || 1) };
});

const home = prepareBenchHome("big-room");
const pa = await import("../../src/persistent-agents.js");
const absorb = await import("../../src/absorb-run.js");
const review = await import("../../src/review-run.js");
const { FOLD_TRIGGER_PROMPT } = await import("../../src/absorb-ops.js");
const { FOLD_STRICT_ASK_LINE } = await import("../../src/absorb-ops.js");
const { estimateTokens } = await import("../../src/token-estimate.js");

// --- The rooms: synthetic, seeded, the same on every run ---------------------------

let seed = 20261008;
const random = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
const pick = <T,>(list: readonly T[]) => list[Math.floor(random() * list.length)];
const PEOPLE = ["Ana Ruiz", "Jonas Weber", "Mia Chen", "Lukas Brandt", "Sofia Rossi", "Tom Okafor", "Lea Novak", "Ravi Iyer"];
const PROJECTS = ["the harbour portal", "the billing migration", "the Atlas onboarding", "the Nordwind renewal", "the data residency audit", "mobile release 4.2", "the partner API", "the office move"];
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const BLOCKERS = ["legal sign-off", "a vendor contract", "the security review", "a missing test environment", "budget approval", "the data export"];
const fact = () => pick([
	() => `${pick(PEOPLE)} owns ${pick(PROJECTS)} from ${pick(MONTHS)} on.`,
	() => `${pick(PROJECTS)} moves to ${pick(MONTHS)} because of ${pick(BLOCKERS)}.`,
	() => `The budget for ${pick(PROJECTS)} is ${10 + Math.floor(random() * 190)}k EUR, agreed with ${pick(PEOPLE)}.`,
	() => `${pick(PROJECTS)} is blocked on ${pick(BLOCKERS)}; ${pick(PEOPLE)} follows up.`,
	() => `${pick(PEOPLE)} prefers written updates on ${pick(PROJECTS)} every ${pick(["Monday", "Wednesday", "Friday"])}.`,
	() => `We decided to drop the old reporting for ${pick(PROJECTS)} and keep one weekly table.`,
])();

function memoryDocument(agentId: string, pages: string[]): string {
	const deep: string[] = [];
	let number = 1;
	for (let topic = 0; estimateTokens(deep.join("\n")) < 19_600; topic += 1) {
		const title = topic < PROJECTS.length ? PROJECTS[topic].replace(/^the /, "").replace(/^./, (c) => c.toUpperCase()) : `Working notes ${topic}`;
		deep.push(`### ${title}`, "");
		for (let note = 0; note < 30; note += 1, number += 1) deep.push(`<!-- e: id=m-${String(number).padStart(4, "0")} kind=fact saved=2026-0${1 + Math.floor(random() * 8)}-${String(1 + Math.floor(random() * 28)).padStart(2, "0")} -->`, `- ${fact()}`, "");
	}
	return ["<!-- exxeta:l1b schema_version=1 -->", "", "## Chronos", "", `- Persistent agent id: ${agentId}`, "- Lifecycle state: ready", "- Last checkpoint: cp_20260901_0001", "- Last checkpoint at: 2026-09-01T09:00:00.000Z", "- Last consolidation: none", "", "## Deep Memory", "", `<!-- entries: next=${number} -->`, "", ...deep, "## Active Items", "", "## Recent Context", "", ...pages].join("\n");
}
function waitingPage(n: number): string {
	const body: string[] = [];
	while (body.join("\n").length < 7_200) body.push(`- ${fact()}`);
	return [`### RC-${String(n).padStart(4, "0")} | OPEN | 2026-09-${String(1 + n).padStart(2, "0")} | ${pick(PROJECTS).replace(/^./, (c) => c.toUpperCase())} check-in ${n}`, `<!-- rc_metadata: checkpoint_id=cp-big-${n}; session_id=s-${n}; conversation_id=c-big-${n}; density=normal; model=synthetic; approved_at=2026-09-${String(1 + n).padStart(2, "0")}T10:00:00.000Z -->`, "", `**Session arc:** A check-in that went through ${pick(PROJECTS)} and ${pick(PROJECTS)}.`, "", "**Body:**", ...body, "", "**Parked:**", `- ${fact()}`, ""].join("\n");
}
async function buildRoom(name: string, lock: ModelLock): Promise<{ agentId: string; threadId: string; l1bPath: string; roomDir: string }> {
	const agentId = pa.createPersistentAgentFromScaffoldInput({ displayName: name, userName: "Synthetic User", preferredUserAddress: "Synthetic User" }).agent.agentId;
	const roomDir = path.join(home.root, agentId);
	const l1bPath = path.join(roomDir, "L1b", "current.md");
	fs.writeFileSync(l1bPath, memoryDocument(agentId, Array.from({ length: 19 }, (_, n) => waitingPage(n + 1))), { mode: 0o600 });
	const threadId = `c_big_${agentId.replace(/[^a-z0-9]+/g, "_")}`;
	const written = pa.writePersistentAgentThread(agentId, threadId, { state: "active", origin: "home", model: lock, items: [] }, { createRuntime: ({ model }) => pa.createPersistentAgentPiSessionJsonlThreadRuntime({ agentId, threadId, model, cwd: home.threadCwd }) });
	const session = pa.openPersistentAgentPiSessionManager(agentId, written.thread.runtime as any, home.threadCwd);
	// About 150k tokens of a long working session: questions, answers, corrections.
	for (let turn = 0, chars = 0; chars < 600_000; turn += 1) {
		const text = turn % 2 === 0
			? `${pick(["Where are we with", "Remind me what we decided on", "Can you draft an update on", "What is still open on"])} ${pick(PROJECTS)}? ${fact()} ${turn % 14 === 0 ? `Correction: ${fact()}` : ""}`
			: Array.from({ length: 8 }, () => fact()).join(" ");
		chars += text.length;
		if (turn % 2 === 0) session.appendMessage({ role: "user", content: text, timestamp: Date.parse("2026-09-25T09:00:00.000Z") + turn * 1000 } as any);
		else session.appendMessage({ role: "assistant", content: [{ type: "text", text }], api: "responses", provider: lock.provider, model: lock.model, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: Date.parse("2026-09-25T09:00:00.000Z") + turn * 1000 } as any);
	}
	return { agentId, threadId, l1bPath, roomDir };
}

// --- The model: real, or a fake that answers the way a model does --------------------

/** The page a call is about: a fold names it; a placement carries the page's own heading. */
const pageOf = (prompt: string) => /Session being folded: (RC-\d+)/.exec(prompt)?.[1] ?? /^### (RC-\d+) \|/m.exec(prompt.split("\nNote:\n")[1] ?? "")?.[1];
const tidyTopics = (prompt: string) => [...(prompt.split(/\n\n---\n\n/).find((part) => part.trimStart().startsWith("## Material: The Notes To Tidy")) ?? "").matchAll(/^#{2,3} (?!Material)(.+?)\s*$/gm)].map((match) => match[1]);
/** Which rung a fold call is: the stricter ask names itself; a call on a piece of the page carries less than the whole page. */
function rungOf(prompt: string, page: string | undefined, pageText: Map<string, string>): string {
	if (prompt.includes(FOLD_STRICT_ASK_LINE)) return "2";
	// A piece holds only some of the page's body lines; the whole page (rung 1, or rung 4 on a page with no pieces) holds its first and its last.
	const body = (page ? pageText.get(page) ?? "" : "").split("\n").filter((line) => line.startsWith("- "));
	if (body.length && !(prompt.includes(body[0]) && prompt.includes(body[body.length - 1]))) return "3-4";
	return "1";
}

function fakeAnswer(kind: CallKind, prompt: string): Reply {
	const notes = "DECISIONS:\n- The harbour portal moves to May.\n\nOPEN:\nNone\n\nMUST_KEEP:\nNone\n";
	if (kind === "remember-part") return { text: notes };
	if (kind === "remember-final") return { text: "TITLE:\nA long working session\n\nSESSION_ARC:\nWe went through every project.\n\nBODY:\n- The harbour portal moves to May.\n\nPARKED:\nNone\n" };
	if (kind === "first-read") return { text: "## What these sessions leave behind\n\n- Dates moved on several projects." };
	if (kind === "probe") return { text: "OK" };
	if (kind === "placement") return { text: "Harbour portal" };
	const fence = (ops: unknown[]) => ({ text: `Done.\n\n\`\`\`json\n${JSON.stringify({ ops })}\n\`\`\`\n` });
	if (kind === "review") {
		const id = /\[(m-\d+)\]/.exec(prompt.split("## Material: The Notes To Tidy")[1] ?? "")?.[1];
		return fence(id ? [{ op: "update", id, text: "- The harbour portal moves to May." }] : []);
	}
	const page = pageOf(prompt);
	// The fake's two hard pages, so the ladder runs and its calls are counted:
	// RC-0003 is prose until its pieces, RC-0005 is prose at every fold and is placed.
	const rung = rungOf(prompt, page, PAGE_TEXT);
	if ((page === "RC-0003" && rung !== "3-4") || page === "RC-0005") return { text: "I read the session and it was mostly status." };
	return fence([{ op: "add", topic: "Harbour portal", kind: "fact", text: `- ${page ?? "A page"} left one durable point.` }]);
}

const PAGE_TEXT = new Map<string, string>();
const calls: CallRecord[] = [];
/** The window a run reads: the model's own, from the registry the product reads; the fake's is 200k. */
let modelWindow = { contextWindow: 200_000, maxOutputTokens: 16_000 };
async function makeAsk(lock: ModelLock) {
	if (scripted) return async (room: string, kind: CallKind, prompt: string): Promise<Reply> => record(room, kind, prompt, async () => fakeAnswer(kind, prompt));
	useRealProviderRecords({ spec: `${lock.provider}/${lock.model}`, signInFromHome: argv.includes(SIGN_IN_FROM_HOME_FLAG) });
	const worker = await createMaintenanceWorker();
	modelWindow = worker.modelWindow(lock);
	const triggers: Record<CallKind, string> = { "remember-part": "Write the notes on this part now.", "remember-final": "Produce the checkpoint compression fields now.", "first-read": "Produce the compact absorb assessment now.", fold: FOLD_TRIGGER_PROMPT, placement: "Answer with the title only.", probe: "Answer now.", review: "Tidy these notes now." };
	return (room: string, kind: CallKind, prompt: string, options: { maxTokens?: number; signal?: AbortSignal; timeoutMs?: number } = {}): Promise<Reply> => record(room, kind, prompt, async () => worker.call({
		prompt,
		modelLock: lock,
		label: `big-room ${kind}`,
		triggerPrompt: kind === "probe" || kind === "placement" ? prompt : triggers[kind],
		emptyTextError: `the ${kind} call produced no text`,
		...(kind === "first-read" ? { modelDefaultThinking: true } : {}),
		...(options.maxTokens ? { maxOutputTokens: options.maxTokens } : {}),
		...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
		...(options.signal ? { signal: options.signal } : {}),
	}) as Promise<Reply>);
}
async function record(room: string, kind: CallKind, prompt: string, run: () => Promise<Reply>): Promise<Reply> {
	const page = kind === "fold" || kind === "placement" ? pageOf(prompt) : undefined;
	// Only a page's first whole-page call is rung 1: a later one is rung 4 asking for what is left, which on a page no piece landed from is the whole page again.
	const firstAsk = !calls.some((call) => call.room === room && call.kind === "fold" && call.page === page);
	const foldRung = kind === "fold" ? rungOf(prompt, page, PAGE_TEXT) : undefined;
	const row: CallRecord = { room, kind, ...(page ? { page } : {}), ...(foldRung ? { rung: foldRung === "1" && !firstAsk ? "3-4" : foldRung } : kind === "placement" ? { rung: "5" } : {}), highLevel: /## Read at a High Level/.test(prompt), ...(kind === "review" ? { topics: tidyTopics(prompt) } : {}), cost: 0 };
	calls.push(row);
	try {
		const reply = await run();
		row.cost = reply.usage?.cost ?? 0;
		return reply;
	} catch (error) {
		row.failed = error instanceof Error ? error.message.slice(0, 200) : String(error);
		throw error;
	}
}

// --- One room -------------------------------------------------------------------------

async function settle<T extends { state: string }>(read: () => T, busy: readonly string[], label: string): Promise<T> {
	const until = Date.now() + 90 * 60_000;
	let current = read();
	while (busy.includes(current.state)) {
		if (Date.now() > until) throw new Error(`${label} was still "${current.state}" after 90 minutes`);
		await new Promise((resolve) => setTimeout(resolve, scripted ? 5 : 2_000));
		current = read();
	}
	return current;
}

async function runRoom(name: string, lock: ModelLock, ask: Awaited<ReturnType<typeof makeAsk>>) {
	const room = await buildRoom(name, lock);
	for (const block of fs.readFileSync(room.l1bPath, "utf-8").split(/^(?=### RC-)/m).slice(1)) PAGE_TEXT.set(block.slice(4, 11), block.split("\n\n**Parked:**")[0]);
	const window = modelWindow;
	const problems: string[] = [];
	const at = (minute: number) => new Date(Date.parse("2026-09-26T09:00:00.000Z") + minute * 60_000);

	// Remember.
	const proposal: any = await pa.buildCheckpointProposal({ agentId: room.agentId, conversationId: room.threadId, model: lock, density: "standard", runtimeCwd: home.threadCwd }, ((prompt: string, _model: ModelLock, call?: { callKind?: string; signal?: AbortSignal }) => ask(room.agentId, call?.callKind === "remember-part" ? "remember-part" : "remember-final", prompt, { maxTokens: pa.REMEMBER_WORKER_MAX_OUTPUT_TOKENS, signal: call?.signal })) as any, { resolveModelWindow: () => window } as any);
	const page = String(proposal.proposedRecentContext ?? "");
	if (/could not be summarized|were not read/i.test(page)) problems.push("the Remember page carries an engine line");
	const parsed = pa.parseCheckpointApprovalRequest({ conversationId: room.threadId, model: lock, density: proposal.density, proposal, approvedRecentContext: page }, room.agentId);
	pa.writeApprovedCheckpoint(parsed.request, parsed.warnings, at(0), { runtimeCwd: home.threadCwd });
	for (const block of fs.readFileSync(room.l1bPath, "utf-8").split(/^(?=### RC-)/m).slice(1)) PAGE_TEXT.set(block.slice(4, 11), block.split("\n\n**Parked:**")[0]);

	// Memorize, with a real first read.
	const read = await pa.buildAbsorbAssessment(room.agentId, lock, (prompt) => ask(room.agentId, "first-read", prompt) as any, { resolveModelWindow: () => window } as any);
	const started = absorb.startAbsorbRun({
		agentId: room.agentId,
		assessmentMarkdown: read.assessmentMarkdown,
		model: lock,
		generate: ((prompt: string, _model: ModelLock, options: { signal?: AbortSignal; timeoutMs?: number; maxTokens?: number }) => ask(room.agentId, prompt.startsWith("Here are the topic titles of a memory.") ? "placement" : "fold", prompt, options)) as any,
		probe: ((prompt: string, _model: ModelLock, options: { signal?: AbortSignal; timeoutMs?: number }) => ask(room.agentId, "probe", prompt, options)) as any,
		resolveModelWindow: () => window,
		now: () => at(10),
	});
	const memorized = await settle(() => absorb.getAbsorbRun(room.agentId, started.runId), ["prepass", "folding", "budget"], "the Memorize");
	if (memorized.stop) problems.push(`the Memorize stopped with the notice (${memorized.stop.cause})`);
	const notFolded = memorized.sessions.filter((session) => !["folded", "dropped"].includes(session.outcome));
	for (const session of notFolded) problems.push(`page ${session.id} ended "${session.outcome}"${session.reason ? `: ${session.reason}` : ""}`);
	if (memorized.state === "ready") absorb.approveAbsorbRun(room.agentId, started.runId, at(20));

	// Review: the tidy.
	const tidy = review.startReviewRun(room.agentId, { depth: "tidy", model: lock, generate: ((prompt: string, _model: ModelLock, options: { signal: AbortSignal; timeoutMs: number }) => ask(room.agentId, "review", prompt, options)) as any, resolveModelWindow: () => window, now: () => at(30) });
	const reviewed = await settle(() => review.getReviewRun(room.agentId, tidy.runId), ["prepass", "tidying", "budget"], "the Review");
	if (reviewed.stop) problems.push(`the Review stopped with the notice (${reviewed.stop.cause})`);
	for (const row of reviewed.leftAsIs) problems.push(`Review left ${row.topics.join(", ")} as it was: ${row.reason}`);
	if (reviewed.state === "ready") review.approveReviewRun(room.agentId, tidy.runId, at(40));

	const saved = fs.readFileSync(room.l1bPath, "utf-8");
	if (/^### Unsorted$/m.test(saved)) problems.push("a note is in Unsorted");
	if (/^### RC-\d+ \|/m.test(saved)) problems.push("a page still waits in Recent Context");
	return { room: room.agentId, model: `${lock.provider}/${lock.model}`, pages: memorized.sessions.length, outcomes: Object.fromEntries(memorized.sessions.map((session) => [session.id, session.outcome])), problems };
}

// --- The report ------------------------------------------------------------------------

function report(rooms: Array<Awaited<ReturnType<typeof runRoom>>>) {
	const perRoom = rooms.map((room) => {
		const mine = calls.filter((call) => call.room === room.room);
		const pages: Record<string, Record<string, number>> = {};
		for (const call of mine.filter((row) => row.page)) {
			const counts = (pages[call.page!] ??= {});
			const key = `rung ${call.rung}${call.highLevel ? " high-level" : ""}`;
			counts[key] = (counts[key] ?? 0) + 1;
		}
		const pageTotals = Object.values(pages).map((counts) => Object.values(counts).reduce((sum, n) => sum + n, 0));
		// Review: a group is a call whose topics are not inside an earlier call's; its split is every later call inside it.
		const tidies = mine.filter((call) => call.kind === "review" && call.topics?.length);
		const groups: Array<{ topics: string[]; calls: number }> = [];
		for (const call of tidies) {
			const home = groups.find((group) => call.topics!.every((topic) => group.topics.includes(topic)));
			if (home) home.calls += 1;
			else groups.push({ topics: call.topics!, calls: 1 });
		}
		return {
			...room,
			calls: mine.length,
			failedCalls: mine.filter((call) => call.failed).length,
			cost: Number(mine.reduce((sum, call) => sum + call.cost, 0).toFixed(4)),
			remember: { parts: mine.filter((call) => call.kind === "remember-part").length, final: mine.filter((call) => call.kind === "remember-final").length, highLevel: mine.filter((call) => call.kind.startsWith("remember") && call.highLevel).length },
			probes: mine.filter((call) => call.kind === "probe").length,
			callsByPage: pages,
			worstPage: pageTotals.length ? Math.max(...pageTotals) : 0,
			reviewGroups: groups.map((group) => ({ topics: group.topics.length, calls: group.calls })),
			worstReviewGroup: groups.length ? Math.max(...groups.map((group) => group.calls)) : 0,
			passed: room.problems.length === 0,
		};
	});
	return { day: localDay(), scripted, rooms: perRoom, passed: perRoom.every((room) => room.passed) };
}

// The temp home goes on every way out, a throw included: a real run's copy of the sign-in is in it.
let passed = false;
try {
	const results: Array<Awaited<ReturnType<typeof runRoom>>> = [];
	let index = 0;
	for (const { lock, rooms } of plan) {
		const ask = await makeAsk(lock);
		for (let n = 0; n < rooms; n += 1) {
			index += 1;
			console.log(`room ${index}: ${lock.provider}/${lock.model}`);
			results.push(await runRoom(`Big Room ${index}`, lock, ask));
			console.log(`  ${results.at(-1)!.problems.length ? `PROBLEMS: ${results.at(-1)!.problems.join("; ")}` : "every page folded or dropped, nothing in Unsorted, no notice, no safety-net line"}`);
		}
	}
	const summary = report(results);
	const out = option("out") ?? path.join(resultsDir(), `big-room-${summary.day}${scripted ? "-scripted" : ""}.json`);
	fs.mkdirSync(path.dirname(out), { recursive: true });
	fs.writeFileSync(out, `${JSON.stringify(summary, null, 2)}\n`);
	for (const room of summary.rooms) console.log(`${room.room} (${room.model}): ${room.passed ? "PASS" : "FAIL"} · ${room.calls} calls (${room.failedCalls} failed) · Remember ${room.remember.parts} parts + ${room.remember.final} final, ${room.remember.highLevel} high-level · worst page ${room.worstPage} calls · ${room.probes} probes · worst Review group ${room.worstReviewGroup} calls over ${room.reviewGroups.length} groups${room.cost ? ` · $${room.cost}` : ""}`);
	console.log(`report: ${out}`);
	console.log(summary.passed ? "big-room run passed" : "big-room run FAILED");
	passed = summary.passed;
} finally {
	fs.rmSync(home.home, { recursive: true, force: true });
}
process.exitCode = passed ? 0 : 1;
