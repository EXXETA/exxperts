// The heavy room: every action against a room shaped like months of use.
//
// One room holds a 5 MB conversation of 1,500 items whose session file is
// 30 MB, a memory at its 20k-token budget, 19 waiting pages (20 after the
// Remember), and an archive of 10,000 rows. Against it: Home, entering the
// conversation and a chat save through the real server; then, with a
// scripted Memory model, Remember in parts, Memorize with a restart, Review,
// the search build, Forget and Home again. Nothing may fail, nothing may end
// in Unsorted, and each action and the process's memory stay under fixed
// bounds. It is the net for a size nobody tested.
//
// Offline: a scripted model, a local server, no provider.

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { AbsorbRun, AbsorbRunGenerate } from "../src/absorb-run.js";
import type { ReviewRun, ReviewRunGenerate } from "../src/review-run.js";
import type { AbsorbGenerateResult, PersistentAgentPiSessionJsonlThreadRuntime } from "../src/persistent-agents.js";
import { authedFetch, SMOKE_SERVER_AUTH_ENV, SMOKE_SERVER_SPAWN_TREE_OPTIONS, stopSmokeServer, freePort } from "./smoke-server-process.js";

const webServerDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "heavy-room-home-"));
const tempCwd = fs.mkdtempSync(path.join(os.tmpdir(), "heavy-room-cwd-"));
const appDir = path.join(tempHome, ".exxperts", "app");
const root = path.join(appDir, "personalized-agents");
process.env.HOME = tempHome;
process.env.USERPROFILE = tempHome;
fs.mkdirSync(appDir, { recursive: true });
fs.writeFileSync(path.join(appDir, "openai-compatible-ai-profile.json"), JSON.stringify({ profileId: "openai-compatible", providerId: "openai-compatible", label: "Synthetic Gateway", roomModels: [{ modelId: "gpt-5.5" }], maintenanceModel: "gpt-5.5" }, null, 2));
fs.writeFileSync(path.join(appDir, "persistent-agent-ai-profile.json"), JSON.stringify({ profileId: "openai-compatible" }, null, 2));
process.env.EXXPERTS_CODING_AGENT_DIR = path.join(tempHome, ".exxperts", "agent");
process.env.EXXETA_PERSISTENT_AGENTS_ROOT = root;

const pa = await import("../src/persistent-agents.js");
const absorb = await import("../src/absorb-run.js");
const review = await import("../src/review-run.js");
const store = await import("../src/memory-entries-store.js");
const { loadRoomCorpus } = await import("../src/memory-search-sources.js");
const { REMEMBER_PART_TRIGGER } = await import("../src/remember-two-stage.js");
const { parseMemoryDocument } = await import("../src/memory-entries.js");
const { estimateTokens } = await import("../src/token-estimate.js");
absorb.setAbsorbFoldRetryPauseForTests(0);
review.setReviewTidyRetryPauseForTests(0);

const MODEL = { provider: "openai-compatible", model: "gpt-5.5", label: "GPT-5.5" };
const WINDOW = { contextWindow: 400_000, maxOutputTokens: 16_000 };
const CONVERSATION_ITEMS = 1_500;
const ITEM_CHARS = 3_400; // 1,500 items of 3,400 characters: about 5 MB
const SESSION_MESSAGE_CHARS = 20_000; // 1,500 session messages of 20,000 characters: about 30 MB
const WAITING_PAGES = 19;
const ARCHIVE_ROWS = 10_000;
const MEMORY_BUDGET = 20_000;
const SEARCH_WORD = "OBSIDIANFERRY";
const FORGET_WORD = "SAFFRONLATTICE";

/**
 * The bounds. Each action's limit is about ten times what it took on the
 * laptop the smoke was written on (2026-10: Home 40 ms, entering 50 ms, the
 * chat save 110 ms, Remember 0.6 s, Memorize 0.9 s, Review 0.2 s, the search
 * build 1.4 s, Forget 0.1 s), with a floor of two seconds, so a regression of
 * that order fails it and a slower machine does not. The heap peaked near
 * 650 MB, most of it the search index of the 30 MB transcript.
 */
const LIMIT_MS: Record<string, number> = {
	"home (server)": 2_000,
	"enter the conversation (server)": 2_000,
	"chat save (server)": 3_000,
	remember: 8_000,
	"memorize with a restart": 10_000,
	review: 5_000,
	"search build": 15_000,
	forget: 2_000,
	home: 2_000,
};
const MAX_HEAP_BYTES = 1_500 * 1024 * 1024;

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const took: Array<[string, number]> = [];
async function timed<T>(label: string, run: () => T | Promise<T>): Promise<T> {
	const started = Date.now();
	const result = await run();
	const ms = Date.now() - started;
	took.push([label, ms]);
	console.log(`  ${label}: ${ms} ms (limit ${LIMIT_MS[label]} ms), heap ${Math.round(process.memoryUsage().heapUsed / 1024 / 1024)} MB`);
	assert(ms <= LIMIT_MS[label], `${label} took ${ms} ms, over its ${LIMIT_MS[label]} ms`);
	assert(process.memoryUsage().heapUsed <= MAX_HEAP_BYTES, `${label} left the heap at ${process.memoryUsage().heapUsed} bytes`);
	return result;
}

const filler = (n: number, chars: number) => `Turn ${n}: we went over the harbour budget, the crate seals, the quarterly sign-off and who owns each open thread. `.repeat(Math.ceil(chars / 110)).slice(0, chars);

// --- The room ------------------------------------------------------------------

const agentId = pa.createPersistentAgentFromScaffoldInput({ displayName: "Heavy Room", userName: "Synthetic User", preferredUserAddress: "Synthetic User" }).agent.agentId;
const roomDir = path.join(root, agentId);
const l1bPath = path.join(roomDir, "L1b", "current.md");

/** Deep Memory up to the budget: topics of notes in the register a room's notes have. */
function deepMemory(): { lines: string[]; next: number } {
	const lines: string[] = [];
	let number = 1;
	for (let topic = 1; estimateTokens(lines.join("\n")) < MEMORY_BUDGET - 400; topic += 1) {
		lines.push(`### Topic ${topic}`, "");
		for (let note = 0; note < 40; note += 1, number += 1) lines.push(`<!-- e: id=m-${String(number).padStart(4, "0")} kind=fact saved=2026-06-${String(1 + (note % 28)).padStart(2, "0")} -->`, `- Topic ${topic} point ${note}: the crate seals are checked before each quarterly sign-off.`, "");
	}
	return { lines, next: number };
}
function waitingPage(n: number): string {
	const id = `RC-${String(n).padStart(4, "0")}`;
	return [`### ${id} | OPEN | 2026-09-${String(1 + (n % 28)).padStart(2, "0")} | Waiting page ${n}`, `<!-- rc_metadata: checkpoint_id=cp-heavy-${n}; session_id=s-${n}; conversation_id=c-heavy-${n}; density=normal; model=openai-compatible/gpt-5.5; approved_at=2026-09-10T10:00:00.000Z -->`, "", `**Session arc:** Page ${n} settled the harbour schedule.`, "", "**Body:**", ...Array.from({ length: 12 }, (_, k) => `- WAITING-${n}-${k} is a durable point about the harbour schedule and the crate seals.`), "", "**Parked:**", "None", ""].join("\n");
}
const deep = deepMemory();
fs.writeFileSync(l1bPath, [
	"<!-- exxeta:l1b schema_version=1 -->", "", "## Chronos", "", `- Persistent agent id: ${agentId}`, "- Lifecycle state: ready", "- Last checkpoint: cp_20260912_0001", "- Last checkpoint at: 2026-09-12T09:00:00.000Z", "- Last consolidation: none", "",
	"## Deep Memory", "", `<!-- entries: next=${deep.next} -->`, "", ...deep.lines,
	"## Active Items", "", "## Recent Context", "", ...Array.from({ length: WAITING_PAGES }, (_, n) => waitingPage(n + 1)),
].join("\n"), { mode: 0o600 });
store.appendArchive(agentId, Array.from({ length: ARCHIVE_ROWS }, (_, n) => ({
	entry: { id: `m-${String(20_000 + n)}`, kind: "fact" as const, saved: "2026-03-01", pinned: false, text: `- Archived point ${n}: an older figure for the harbour budget, replaced since.` },
	why: "superseded" as const,
	topic: `Archived topic ${n % 50}`,
	section: "Deep Memory" as const,
	archived: "2026-04-01",
})), new Date("2026-04-01T10:00:00.000Z"));

/** A conversation of 1,500 items (about 5 MB) whose session file is about 30 MB; `word` sits in one turn in the middle. */
function bigConversation(threadId: string, word: string): void {
	const items = Array.from({ length: CONVERSATION_ITEMS }, (_, n) => ({ kind: n % 2 ? "assistant" : "user", id: `i${n}`, text: `${n === 750 ? `${word} ` : ""}${filler(n, ITEM_CHARS)}` }));
	const written = pa.writePersistentAgentThread(agentId, threadId, { state: "active", origin: "home", model: MODEL, items }, {
		createRuntime: ({ model }) => pa.createPersistentAgentPiSessionJsonlThreadRuntime({ agentId, threadId, model, cwd: tempCwd }),
	});
	const session = pa.openPersistentAgentPiSessionManager(agentId, written.thread.runtime as PersistentAgentPiSessionJsonlThreadRuntime, tempCwd);
	for (let n = 0; n < CONVERSATION_ITEMS; n += 1) {
		const text = `${n === 750 ? `${word} ` : ""}${filler(n, SESSION_MESSAGE_CHARS)}`;
		if (n % 2 === 0) session.appendMessage({ role: "user", content: text, timestamp: Date.now() + n } as any);
		else session.appendMessage({ role: "assistant", content: [{ type: "text", text }], api: "responses", provider: MODEL.provider, model: MODEL.model, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: Date.now() + n } as any);
	}
}
const threadId = "c_heavy_0001";
bigConversation(threadId, SEARCH_WORD);
const threadFile = path.join(roomDir, "runtime", "threads", `${threadId}.json`);
const sessionFile = path.join(roomDir, "runtime", "pi-sessions", `${threadId}.jsonl`);
console.log(`the room: thread record ${(fs.statSync(threadFile).size / 1e6).toFixed(1)} MB, session file ${(fs.statSync(sessionFile).size / 1e6).toFixed(1)} MB, Deep Memory ~${estimateTokens(deep.lines.join("\n"))} tokens, ${WAITING_PAGES} waiting pages, ${ARCHIVE_ROWS} archive rows`);
assert(fs.statSync(threadFile).size > 5e6 && fs.statSync(sessionFile).size > 30e6, "the conversation is heavy: 5 MB of items and a 30 MB session file");

const NOTES = "DECISIONS:\n- The harbour budget is signed off quarterly.\n\nOPEN:\nNone\n\nMUST_KEEP:\nNone\n";
const PAGE = "TITLE:\nThe harbour review\n\nSESSION_ARC:\nA long review of the harbour budget.\n\nBODY:\n- The harbour budget is signed off quarterly.\n\nPARKED:\nNone\n";
const fence = (ops: unknown[]): AbsorbGenerateResult => ({ text: `Done.\n\n\`\`\`json\n${JSON.stringify({ ops })}\n\`\`\`\n`, usage: { input: 100, output: 20 } });
const unsorted = () => /^### Unsorted$/m.test(fs.readFileSync(l1bPath, "utf-8"));

let server: ChildProcessWithoutNullStreams | null = null;
const serverOutput: string[] = [];
try {
	// --- Home, entering and a chat save, through the real server -------------------
	const port = await freePort();
	server = spawn("npx", ["tsx", "src/index.ts"], {
		shell: process.platform === "win32",
		...SMOKE_SERVER_SPAWN_TREE_OPTIONS,
		cwd: webServerDir,
		env: { ...process.env, HOME: tempHome, USERPROFILE: tempHome, PORT: String(port), ...SMOKE_SERVER_AUTH_ENV },
	});
	server.stdout.on("data", (chunk) => serverOutput.push(String(chunk)));
	server.stderr.on("data", (chunk) => serverOutput.push(String(chunk)));
	const base = `http://127.0.0.1:${port}`;
	const deadline = Date.now() + 60_000;
	for (;;) {
		assert(server.exitCode == null, `the server exited: ${serverOutput.join("").slice(-800)}`);
		try { if ((await authedFetch(`${base}/api/persistent-agents`)).ok) break; } catch {}
		assert(Date.now() < deadline, `the server never became ready: ${serverOutput.join("").slice(-800)}`);
		await sleep(200);
	}
	const home = await timed("home (server)", async () => (await authedFetch(`${base}/api/persistent-agents`)).json() as Promise<any>);
	assert(JSON.stringify(home).includes(agentId), "Home lists the heavy room");
	const threadUrl = `${base}/api/persistent-agents/${encodeURIComponent(agentId)}/threads/${encodeURIComponent(threadId)}`;
	const entered = await timed("enter the conversation (server)", async () => {
		const reply = await authedFetch(threadUrl);
		assert(reply.ok, `entering the conversation answers ${reply.status}`);
		return reply.json() as Promise<any>;
	});
	const items = entered.thread?.items ?? entered.items;
	assert(Array.isArray(items) && items.length === CONVERSATION_ITEMS, `the conversation opens with every item, got ${Array.isArray(items) ? items.length : typeof items}`);
	await timed("chat save (server)", async () => {
		const reply = await authedFetch(threadUrl, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ state: "active", items: [...items, { kind: "user", id: "i-new", text: "One more question about the crate seals." }] }) });
		assert(reply.ok, `a chat save of the whole conversation answers ${reply.status}: ${(await reply.text()).slice(0, 300)}`);
	});
	await stopSmokeServer(server);
	server = null;

	// --- Remember, in parts --------------------------------------------------------
	let partCalls = 0;
	const rememberGenerate = async (_prompt: string, _model: unknown, call?: { trigger?: string }) => {
		if (call?.trigger === REMEMBER_PART_TRIGGER) partCalls += 1;
		return { text: call?.trigger === REMEMBER_PART_TRIGGER ? NOTES : PAGE, truncated: false, usage: { input: 1, output: 1, totalTokens: 2, cost: 0 } };
	};
	await timed("remember", async () => {
		const proposal: any = await pa.buildCheckpointProposal({ agentId, conversationId: threadId, model: MODEL, density: "standard", runtimeCwd: tempCwd }, rememberGenerate as any, { resolveModelWindow: () => WINDOW } as any);
		assert(/signed off quarterly/.test(String(proposal.proposedRecentContext)), "the Remember gives a page");
		const parsed = pa.parseCheckpointApprovalRequest({ conversationId: threadId, model: MODEL, density: proposal.density, proposal, approvedRecentContext: proposal.proposedRecentContext }, agentId);
		pa.writeApprovedCheckpoint(parsed.request, parsed.warnings, new Date("2026-09-20T10:00:00.000Z"), { runtimeCwd: tempCwd });
	});
	assert(partCalls >= 2, `a 30 MB conversation is read in parts, got ${partCalls}`);
	const waiting = (fs.readFileSync(l1bPath, "utf-8").match(/^### RC-\d+ \|/gm) ?? []).length;
	assert(waiting === WAITING_PAGES + 1, `the room holds ${WAITING_PAGES + 1} waiting pages after the Remember, got ${waiting}`);

	// --- Memorize, with a restart after page 7 -------------------------------------
	const sessionOf = (prompt: string) => /Session being folded: (RC-\d+)/.exec(prompt)?.[1];
	const folds = (prompt: string): AbsorbGenerateResult => {
		const id = sessionOf(prompt);
		return id ? fence([{ op: "add", topic: "Topic 1", kind: "fact", text: `- ${id} left one durable point about the harbour.` }]) : { text: "Topic 1" };
	};
	// After seven folds every call hangs, as the calls of a process that went down do.
	let answered = 0;
	let hang = true;
	const hangsAfterSeven: AbsorbRunGenerate = async (prompt) => {
		if (hang && answered >= 7) return new Promise<AbsorbGenerateResult>(() => {});
		answered += 1;
		return folds(prompt);
	};
	const settleAbsorb = async (runId: string): Promise<AbsorbRun> => {
		const until = Date.now() + 60_000;
		let current = absorb.getAbsorbRun(agentId, runId);
		while (["prepass", "folding", "budget"].includes(current.state)) {
			assert(Date.now() < until, `the Memorize was still "${current.state}" after 60 seconds`);
			await sleep(5);
			current = absorb.getAbsorbRun(agentId, runId);
		}
		return current;
	};
	const memorize = (generate: AbsorbRunGenerate, at: string) => absorb.startAbsorbRun({ agentId, assessmentMarkdown: "## What these sessions leave behind\n\n- Durable points.", model: MODEL, generate, probe: async () => ({ text: "OK" }), resolveModelWindow: () => WINDOW, now: () => new Date(at) });
	await timed("memorize with a restart", async () => {
		const started = memorize(hangsAfterSeven, "2026-09-21T09:00:00.000Z");
		const until = Date.now() + 30_000;
		while (absorb.getAbsorbRun(agentId, started.runId).sessions.filter((session) => session.outcome === "folded").length < 7) { assert(Date.now() < until, "seven pages are folded"); await sleep(5); }
		await sleep(20);
		const inFlight = absorb.getAbsorbRun(agentId, started.runId).sessions.filter((session) => session.outcome === "folding").map((session) => session.id);
		absorb.resetAbsorbRunsForTests(); // the server restarts with folds in flight
		hang = false;
		const revived = absorb.getAbsorbRun(agentId, started.runId);
		assert(revived.stop?.kind === "restart" && revived.sessions.filter((session) => session.outcome === "folded").length === 7 && inFlight.length > 0 && inFlight.every((id) => revived.sessions.find((session) => session.id === id)?.outcome === "pending"), `the restart keeps the seven folds and puts the pages in flight back to waiting for Continue, got ${JSON.stringify(revived.stop)} ${JSON.stringify(revived.sessions.map((session) => session.outcome))}`);
		absorb.resumeAbsorbRun(agentId, started.runId, MODEL, new Date("2026-09-21T09:05:00.000Z"), { generate: hangsAfterSeven, probe: async () => ({ text: "OK" }), resolveModelWindow: () => WINDOW });
		const done = await settleAbsorb(started.runId);
		const left = done.sessions.filter((session) => !["folded", "dropped", "summarized"].includes(session.outcome)).map((session) => session.id);
		assert(done.state === "ready" && !done.stop && left.length === 0, `Continue folds every page, the ones in flight redone down the ladder, got ${done.state} ${JSON.stringify(done.stop)} ${JSON.stringify(left)}`);
		absorb.approveAbsorbRun(agentId, started.runId, new Date("2026-09-21T09:10:00.000Z"));
	});
	assert(!/^### RC-\d+ \|/m.test(fs.readFileSync(l1bPath, "utf-8")) && !unsorted(), "after Memorize no page waits and nothing is in Unsorted");

	// --- Review ---------------------------------------------------------------------
	const firstNote = (prompt: string) => /\[(m-\d+)\]/.exec(prompt.split(/\n\n---\n\n/).find((part) => part.trimStart().startsWith("## Material: The Notes To Tidy")) ?? "")?.[1];
	const tidies: ReviewRunGenerate = async (prompt) => {
		const id = firstNote(prompt);
		return fence(id ? [{ op: "update", id, text: "- The crate seals are checked before each sign-off." }] : []);
	};
	await timed("review", async () => {
		const { runId } = review.startReviewRun(agentId, { depth: "tidy", model: MODEL, generate: tidies, resolveModelWindow: () => WINDOW, now: () => new Date("2026-09-22T09:00:00.000Z") });
		const until = Date.now() + 60_000;
		let current: ReviewRun = review.getReviewRun(agentId, runId);
		while (["prepass", "tidying", "budget"].includes(current.state)) { assert(Date.now() < until, `the Review was still "${current.state}"`); await sleep(5); current = review.getReviewRun(agentId, runId); }
		assert(current.state === "ready" && !current.stop && current.leftAsIs.length === 0 && current.changes.length > 0, `the Review ends ready with every group tidied, got ${current.state} ${JSON.stringify(current.stop)} ${JSON.stringify(current.leftAsIs)}`);
		review.approveReviewRun(agentId, runId, new Date("2026-09-22T09:05:00.000Z"));
	});
	assert(!unsorted() && parseMemoryDocument(fs.readFileSync(l1bPath, "utf-8")).topics.length > 0, "after Review nothing is in Unsorted");

	// --- The search build -------------------------------------------------------------
	const corpus = await timed("search build", () => loadRoomCorpus(agentId, { runtimeCwd: tempCwd }));
	assert(corpus.docs.some((doc) => doc.source === "conversation" && doc.text.includes(SEARCH_WORD)), "the remembered 30 MB transcript is searchable");
	assert(corpus.counts.archive >= ARCHIVE_ROWS, `the archive is searchable, got ${corpus.counts.archive}`);

	// --- Forget a second heavy conversation --------------------------------------------
	const fresh = pa.getPersistentAgentRuntimeState(agentId).activeThreadId;
	assert(fresh && fresh !== threadId, "the Remember opened a fresh conversation");
	bigConversation(fresh, FORGET_WORD);
	await timed("forget", () => pa.writePersistentAgentMementoBoundary(agentId, fresh, new Date("2026-09-23T10:00:00.000Z"), { runtimeCwd: tempCwd }));
	const holding: string[] = [];
	const walk = (dir: string) => {
		for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
			const file = path.join(dir, entry.name);
			if (entry.isDirectory()) walk(file);
			// portability-ok: the list is only checked for being empty, so its slashes never matter
			else if (fs.readFileSync(file, "utf-8").includes(FORGET_WORD)) holding.push(path.relative(tempHome, file));
		}
	};
	walk(appDir);
	assert(holding.length === 0, `after Forget no file holds the forgotten conversation's words, got ${JSON.stringify(holding)}`);

	// --- Home again ---------------------------------------------------------------------
	await timed("home", () => {
		const rooms = pa.listPersistentAgents();
		assert(rooms.some((room) => room.id === agentId), "Home lists the heavy room");
		pa.getPersistentAgentStatus(agentId);
	});
	console.log(`heavy room smoke passed (${took.map(([label, ms]) => `${label} ${ms} ms`).join(", ")})`);
} catch (error) {
	console.error(error instanceof Error ? error.stack || error.message : error);
	if (serverOutput.length) console.error(serverOutput.join("").slice(-2000));
	process.exitCode = 1;
} finally {
	await stopSmokeServer(server);
	fs.rmSync(tempHome, { recursive: true, force: true });
	fs.rmSync(tempCwd, { recursive: true, force: true });
}
