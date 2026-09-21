// The document layer of a room's memory search, on a real room in a temp HOME.
//
// What this pins is the thing that cannot be read off the code: WHICH of a
// room's words are searchable, and where each one actually comes from. So the
// room is built the way a room is built — a memory file, real Remembers that
// write real checkpoint events over real transcripts, and one Memorize that
// folds two of those conversations, drops a third, supersedes a note and lets
// the budget take another — and then the corpus is read and asked to account
// for every document in it.
//
// The sharpest assertion here is a single invented word. Each conversation's
// transcript carries a word that its Recent Context entry does not, so a
// corpus that read conversations off the Recent Context text instead of the
// closed transcript would come back without it, and the search would answer
// questions about a conversation with the summary of it rather than what was
// said. The second sharpest is a Recent Context id used twice: a Memorize
// empties Recent Context, so the conversation after it is numbered RC-0001
// again, and a corpus that matched a fold to a transcript by id alone would
// hand the first conversation's document the last conversation's words.
//
// The second room reuses its ids across THREE Memorizes and pins how a fold is
// matched to its conversation: by the names the Memorize wrote into its record
// (which Remember, which conversation), even where the timestamps would say
// otherwise; by the oldest unclaimed Remember when a record written before the
// names were kept has to be matched in time; every memorized conversation
// indexed, dropped ones included and saying so; a folded entry whose Remember
// record is gone reported in `skipped`; and a conversation that was written in
// the room but never Remembered in no document and no skipped row, before and
// after a Memorize.
//
// Offline: no server, no provider, no network, no port.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { AbsorbRun, AbsorbRunGenerate } from "../src/absorb-run.js";
import type { AbsorbGenerateResult } from "../src/persistent-agents.js";
import type { SearchDocument } from "../src/memory-search-index.js";

const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "memory-search-sources-home-"));
const root = path.join(tempHome, ".exxperts", "app", "personalized-agents");
process.env.HOME = tempHome;
process.env.USERPROFILE = tempHome;
const smokeAppDir = path.join(tempHome, ".exxperts", "app");
fs.mkdirSync(smokeAppDir, { recursive: true });
fs.writeFileSync(
	path.join(smokeAppDir, "openai-compatible-ai-profile.json"),
	JSON.stringify({ profileId: "openai-compatible", providerId: "openai-compatible", label: "Synthetic Gateway", roomModels: [{ modelId: "gpt-5.5" }], maintenanceModel: "gpt-5.5" }, null, 2),
);
fs.writeFileSync(path.join(smokeAppDir, "persistent-agent-ai-profile.json"), JSON.stringify({ profileId: "openai-compatible" }, null, 2));
process.env.EXXPERTS_CODING_AGENT_DIR = path.join(tempHome, ".exxperts", "agent");
process.env.EXXETA_PERSISTENT_AGENTS_ROOT = root;

const { approveAbsorbRun, getAbsorbRun, resetAbsorbRunsForTests, setAbsorbFoldRetryPauseForTests, startAbsorbRun } = await import("../src/absorb-run.js");
setAbsorbFoldRetryPauseForTests(0);
const {
	buildPersistentAgentCheckpointTranscriptSource,
	createPersistentAgentFromScaffoldInput,
	createPersistentAgentPiSessionJsonlThreadRuntime,
	getPersistentAgentThread,
	openPersistentAgentPiSessionManager,
	parseCheckpointApprovalRequest,
	writeApprovedCheckpoint,
	writePersistentAgentThread,
} = await import("../src/persistent-agents.js");
const { appendArchive, readArchive } = await import("../src/memory-entries-store.js");
const { writePersistentRoomMaintenanceSettings } = await import("../src/persistent-room-maintenance-settings.js");
const { CONVERSATION_CHUNK_CHARS, collectRoomDocuments, invalidateRoomCorpus, loadRoomCorpus } = await import("../src/memory-search-sources.js");

const MODEL = { provider: "openai-compatible", model: "gpt-5.5", label: "GPT-5.5" };
/** The day every conversation is remembered on. */
const REMEMBER_DAY = "2026-09-14";
/** The day the Memorize runs, one day later, so a note's date and a conversation's date can never be confused. */
const RUN_DAY = "2026-09-15";
const RUN_CLOCK = () => new Date(`${RUN_DAY}T09:00:00.000Z`);
const APPROVED_AT = new Date(`${RUN_DAY}T09:05:00.000Z`);
/** The floor a room's budget can be set to, so a fixture note can genuinely break it. */
const BUDGET_TOKENS = 10_000;

// The words that exist ONLY inside a transcript. None of them is written into
// the Recent Context entry the Remember approves, so a document carrying one
// can only have come from the closed conversation itself.
const PLANT_FOLDED_SHORT = "ZEPHYRQUILL";
const PLANT_FOLDED_LONG = "MARZIPANHELIX";
const PLANT_DROPPED = "OBSIDIANFERRET";
const PLANT_AFTER_THE_SAVE = "CINNABARWIDGET";

// The markers the fixture's notes carry, so the scripted fold finds them the
// way a fold finds them: by the words in the memory it was handed.
const SUPERSEDE_TARGET = "SEARCH-SOURCE-SUPERSEDE";
const KEPT_NOTE = "SEARCH-SOURCE-KEPT";
const DEMOTED_NOTE = "SEARCH-SOURCE-DEMOTED";
const SUPERSEDED_TEXT = "SEARCH-SOURCE-SUPERSEDED-TEXT";
const ADDED_TEXT = "SEARCH-SOURCE-ADDED-TEXT";

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function pass(label: string): void {
	console.log(`  ok  ${label}`);
}

// --- The room's memory file ----------------------------------------------------

interface FixtureEntry {
	id: string;
	kind: "fact" | "practice" | "item";
	saved: string;
	updated?: string;
	refs?: number;
	from?: string;
	text: string;
}

function renderFixtureEntry(entry: FixtureEntry): string {
	const fields = [`id=${entry.id}`, `kind=${entry.kind}`, `saved=${entry.saved}`];
	if (entry.from) fields.push(`from=${entry.from}`);
	if (entry.updated) fields.push(`updated=${entry.updated}`);
	if (entry.refs !== undefined) fields.push(`refs=${entry.refs}`);
	return `<!-- e: ${fields.join(" ")} -->\n${entry.text}\n`;
}

/**
 * The note the budget takes first: a fact, the oldest of them all, never
 * referenced, and long enough on its own to put the room over the floor its
 * budget can be set to. Every other note is a recently referenced practice, so
 * the demotion order has exactly one answer.
 */
function demotedNote(): FixtureEntry {
	const detail = "Detail of an arrangement nobody has needed since it was written, kept at the length a working room's notes actually reach, so the room's budget has something real to weigh. ";
	return { id: "m-0004", kind: "fact", saved: "2020-01-01", refs: 0, text: `- ${DEMOTED_NOTE} ${detail.repeat(420)}`.trimEnd() };
}

function memoryFixture(agentId: string): string {
	const commercial: FixtureEntry[] = [
		{ id: "m-0001", kind: "practice", saved: "2026-09-01", updated: "2026-09-11", refs: 6, from: "RC-0900", text: `- ${SUPERSEDE_TARGET} The delivery window is six weeks from the day the order is signed.` },
		{ id: "m-0002", kind: "practice", saved: "2026-09-02", refs: 5, text: `- ${KEPT_NOTE} Commercial summaries go out as one page, numbers first.` },
	];
	const delivery: FixtureEntry[] = [demotedNote()];
	return [
		"<!-- exxeta:l1b schema_version=1 -->",
		"",
		"## Chronos",
		"",
		`- Persistent agent id: ${agentId}`,
		"- Lifecycle state: ready",
		"- Last checkpoint: cp_20260913_0001",
		"- Last checkpoint at: 2026-09-13T09:00:00.000Z",
		"- Last consolidation: none",
		"",
		"## Deep Memory",
		"",
		"<!-- entries: next=300 -->",
		"",
		"### Commercial terms",
		"",
		commercial.map(renderFixtureEntry).join("\n"),
		"### Delivery",
		"",
		delivery.map(renderFixtureEntry).join("\n"),
		"## Active Items",
		"",
		"## Recent Context",
		"",
	].join("\n");
}

/** The smallest memory a room can fold into: one topic with one note, and an empty Recent Context. */
function smallMemoryFixture(agentId: string): string {
	return [
		"<!-- exxeta:l1b schema_version=1 -->",
		"",
		"## Chronos",
		"",
		`- Persistent agent id: ${agentId}`,
		"- Lifecycle state: ready",
		"",
		"## Deep Memory",
		"",
		"<!-- entries: next=300 -->",
		"",
		"### Commercial terms",
		"",
		"<!-- e: id=m-0001 kind=practice saved=2026-09-02 refs=4 -->",
		"- A note this room already held before anything was remembered.",
		"",
		"## Active Items",
		"",
		"## Recent Context",
		"",
	].join("\n");
}

/**
 * Rewrites a room's absorb event records the way a version before this one
 * wrote them: without the names of the Remember and the conversation each
 * folded entry was. What is left is what the time rule has to work from.
 */
function stripNamesFromAbsorbRecords(agentId: string): void {
	const dir = path.join(root, agentId, "events", "absorb");
	for (const name of fs.readdirSync(dir)) {
		if (!name.endsWith(".json")) continue;
		const file = path.join(dir, name);
		const record = JSON.parse(fs.readFileSync(file, "utf-8"));
		for (const session of record.run?.sessions ?? []) {
			delete session.conversationId;
			delete session.checkpointId;
		}
		fs.writeFileSync(file, JSON.stringify(record, null, 2));
	}
}

// --- Remember: a real transcript, a real checkpoint -----------------------------

/** Where a conversation's session file lives; under the temp home, so it goes with it. */
const threadCwd = path.join(tempHome, "thread-cwd");
fs.mkdirSync(threadCwd, { recursive: true });

interface Turn {
	speaker: "user" | "assistant";
	text: string;
}

/**
 * One conversation held in the room the way the product holds one: a Pi-backed
 * thread with real turns in its session file, and nothing else. This is what a
 * conversation is before anyone presses Remember, and a conversation left in
 * this state is the one the corpus must never index.
 */
function converse(agentId: string, conversationId: string, turns: readonly Turn[]): void {
	const write = writePersistentAgentThread(agentId, conversationId, {
		state: "active",
		origin: "home",
		model: MODEL,
		items: [{ kind: "user", id: "display-user", text: "The display cache, which is not the transcript." }],
	}, {
		createRuntime: ({ model }) => createPersistentAgentPiSessionJsonlThreadRuntime({ agentId, threadId: conversationId, model, cwd: threadCwd }),
	});
	assert(write.thread.runtime.kind === "pi-session-jsonl", `${conversationId} should be backed by a session file`);
	const session = openPersistentAgentPiSessionManager(agentId, write.thread.runtime, threadCwd);
	for (const turn of turns) {
		if (turn.speaker === "user") {
			session.appendMessage({ role: "user", content: turn.text, timestamp: Date.now() } as any);
			continue;
		}
		session.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: turn.text }],
			api: "responses" as any,
			provider: MODEL.provider as any,
			model: MODEL.model,
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
			stopReason: "stop",
			timestamp: Date.now(),
		} as any);
	}
}

/**
 * One conversation, remembered the way the product remembers one: the thread
 * above, a checkpoint proposal built from its session file, and the approved
 * Recent Context entry written by the real write. The entry says what a
 * summary says; the transcript keeps the words. Returns the Recent Context id
 * the write minted, read back off the event record it left, which is the same
 * record the corpus reads, and the checkpoint id of that record.
 */
function remember(agentId: string, conversationId: string, title: string, summary: string, turns: readonly Turn[], now: Date): { rcId: string; checkpointId: string } {
	converse(agentId, conversationId, turns);
	const l1bPath = path.join(root, agentId, "L1b", "current.md");
	const source = buildPersistentAgentCheckpointTranscriptSource({ agentId, conversationId, l1b: fs.readFileSync(l1bPath, "utf-8"), runtimeCwd: threadCwd }).source;
	const approvedRecentContext = [
		`### RC-DRAFT | CLOSED | ${now.toISOString().slice(0, 10)} | ${title}`,
		"",
		`**Session arc:** ${summary}`,
		"",
		"**Body:**",
		`- ${summary}`,
		"",
		"**Parked:**",
		"None",
		"",
	].join("\n");
	const parsed = parseCheckpointApprovalRequest({
		conversationId,
		model: MODEL,
		density: "compact",
		proposal: { agentId, conversationId, sessionId: null, writesMemory: false, source },
		approvedRecentContext,
	}, agentId);
	const written = writeApprovedCheckpoint(parsed.request, parsed.warnings, now, { runtimeCwd: threadCwd });
	const record = JSON.parse(fs.readFileSync(path.join(root, agentId, "events", "checkpoint", `${written.checkpointId}.json`), "utf-8"));
	assert(typeof record.recentContextId === "string" && record.recentContextId.length > 0, `the checkpoint event for ${conversationId} should name the Recent Context entry it wrote`);
	assert(typeof record.runtimeBoundary?.oldSessionFileRelPath === "string", `the checkpoint event for ${conversationId} should name the session file of the conversation it closed`);
	return { rcId: record.recentContextId, checkpointId: written.checkpointId };
}

// --- Memorize: a scripted fold, the real run ------------------------------------

function fence(ops: unknown[]): string {
	return ["```json", JSON.stringify({ ops }, null, 2), "```"].join("\n");
}

function reply(narrative: string, ops: unknown[]): AbsorbGenerateResult {
	return { text: `${narrative}\n\n${fence(ops)}\n`, usage: { input: 1200, output: 180, totalTokens: 1380, cost: 0.0012 } };
}

/** Which session this prompt is asking about, read off the prompt's own material. */
function sessionIdFromPrompt(prompt: string): string {
	const id = /^###\s+(RC-\d+)/m.exec(prompt)?.[1];
	assert(id, `the fold prompt carries no "### RC-" session heading, so the scripted fold cannot tell which conversation it was given`);
	return id!;
}

/** The id of the note whose first line carries this marker, read off the memory the prompt shows. */
function addressOf(prompt: string, marker: string): string {
	for (const line of prompt.split("\n")) {
		if (!line.includes(marker)) continue;
		const id = /\[([a-z]-\d{4}[^\]\s·]*)(?:\s+·[^\]]*)?\]/.exec(line)?.[1];
		if (id) return id;
	}
	throw new Error(`the fold prompt no longer lists a note marked ${marker}, so the scripted fold has nothing to address`);
}

function scriptedGenerate(scripts: Record<string, (prompt: string) => AbsorbGenerateResult>): AbsorbRunGenerate {
	return async (prompt) => {
		const sessionId = sessionIdFromPrompt(prompt);
		const script = scripts[sessionId];
		assert(script, `the run asked to fold ${sessionId}, which this smoke scripted no reply for`);
		return script!(prompt);
	};
}

const WORKING_STATES = new Set(["prepass", "folding", "budget"]);

async function settle(agentId: string, runId: string): Promise<AbsorbRun> {
	const deadline = Date.now() + 60_000;
	let run = getAbsorbRun(agentId, runId);
	while (WORKING_STATES.has(run.state)) {
		assert(Date.now() < deadline, `the run was still in state "${run.state}" after 60 seconds, and a scripted fold answers in milliseconds`);
		await sleep(2);
		run = getAbsorbRun(agentId, runId);
	}
	return run;
}

// --- Reading the corpus --------------------------------------------------------

function ofSource(docs: readonly SearchDocument[], source: string): SearchDocument[] {
	return docs.filter((doc) => doc.source === source);
}

function withText(docs: readonly SearchDocument[], marker: string): SearchDocument {
	const found = docs.filter((doc) => doc.text.includes(marker));
	assert(found.length === 1, `exactly one document should carry ${marker}, got ${found.length}`);
	return found[0]!;
}

function documentsOf(docs: readonly SearchDocument[], rcId: string): SearchDocument[] {
	return docs.filter((doc) => doc.source === "conversation" && doc.meta?.rcId === rcId);
}

try {
	// =====================================================================
	// The room: a memory file, four remembered conversations, one Memorize.
	// =====================================================================
	const created = createPersistentAgentFromScaffoldInput({ displayName: "Memory Search Sources Smoke Room", userName: "Synthetic User", preferredUserAddress: "Synthetic User" });
	const agentId = created.agent.agentId;
	const l1bPath = path.join(root, agentId, "L1b", "current.md");
	fs.writeFileSync(l1bPath, memoryFixture(agentId), { mode: 0o600 });
	writePersistentRoomMaintenanceSettings(agentId, { memoryBudgetTokens: BUDGET_TOKENS, memoryBudgetSettled: true });

	const shortConversation = remember(agentId, "c_short_0001", "The signed addendum", "The addendum came back signed and the window changed with it.", [
		{ speaker: "user", text: `The addendum came back signed this morning, and the counterparty asked us to file it under ${PLANT_FOLDED_SHORT} so their archive can find it.` },
		{ speaker: "assistant", text: `Filed. The delivery window moves to four weeks from signature, and the ${PLANT_FOLDED_SHORT} reference is on the cover sheet.` },
	], new Date(`${REMEMBER_DAY}T08:00:00.000Z`));

	// Long enough that no single chunk can hold it: eight turns, each already
	// most of a chunk on its own, and one turn that is longer than a whole chunk
	// by itself — the one case where a message may be broken into.
	const OVERSIZED_TURN = 5;
	const oversizedMessage = Array.from({ length: 30 }, (_, n) => `Sentence ${n + 1} of the one turn that nobody could fit into a single chunk, said at the length people actually say things.`).join(" ");
	const longTurns: Turn[] = [];
	for (let n = 1; n <= 8; n++) {
		const filler = `Point ${n} of the delivery review, written out the way a real turn is written, with enough of it that the chunker has to decide where this conversation breaks. `;
		const text = n === OVERSIZED_TURN ? oversizedMessage : `${n === 3 ? `${PLANT_FOLDED_LONG} is the code name we gave the review. ` : ""}${filler.repeat(4)}`.trim();
		longTurns.push({ speaker: n % 2 === 1 ? "user" : "assistant", text });
	}
	assert(oversizedMessage.length > CONVERSATION_CHUNK_CHARS, "the oversized turn has to be longer than a whole chunk, or it proves nothing");
	const longConversation = remember(agentId, "c_long_0002", "The delivery review", "The delivery review was walked through end to end.", longTurns, new Date(`${REMEMBER_DAY}T09:00:00.000Z`));

	const droppedConversation = remember(agentId, "c_drop_0003", "Invoicing small talk", "Invoicing days were discussed without landing anywhere.", [
		{ speaker: "user", text: `Nothing much today — we went round the invoicing days again and someone called the whole thing ${PLANT_DROPPED}.` },
		{ speaker: "assistant", text: `Noted. Nothing here that memory does not already hold, ${PLANT_DROPPED} included.` },
	], new Date(`${REMEMBER_DAY}T10:00:00.000Z`));

	assert(new Set([shortConversation.rcId, longConversation.rcId, droppedConversation.rcId]).size === 3, "three Remembers should mint three different Recent Context ids");
	const l1bAfterRemembers = fs.readFileSync(l1bPath, "utf-8");
	for (const plant of [PLANT_FOLDED_SHORT, PLANT_FOLDED_LONG, PLANT_DROPPED]) {
		assert(!l1bAfterRemembers.includes(plant), `${plant} must exist only in a transcript, and the memory file now carries it, so the plant proves nothing`);
	}
	pass("a Remember writes a checkpoint event naming its Recent Context entry and the session file it closed, and the entry keeps none of the transcript's own words");

	const scripts: Record<string, (prompt: string) => AbsorbGenerateResult> = {
		[shortConversation.rcId]: (prompt) => reply(
			"The window this conversation settled is not the window the note carries.",
			[{ op: "supersede", id: addressOf(prompt, SUPERSEDE_TARGET), text: `- ${SUPERSEDED_TEXT} The delivery window is four weeks from the day the order is signed.` }],
		),
		[longConversation.rcId]: () => reply(
			"The review leaves one durable point behind.",
			[{ op: "add", topic: "Delivery", kind: "fact", text: `- ${ADDED_TEXT} The delivery review runs once a quarter and finishes before the quarter closes.` }],
		),
		[droppedConversation.rcId]: () => reply(
			"Memory already holds everything this conversation walked over.",
			[{ op: "drop", reason: "The invoicing days this conversation went round are already what memory says." }],
		),
	};

	const run = startAbsorbRun({
		agentId,
		assessmentMarkdown: "## What these sessions leave behind\n\n- The delivery window changed.\n- The review has a rhythm worth keeping.",
		model: MODEL,
		generate: scriptedGenerate(scripts),
		now: RUN_CLOCK,
	});
	const settled = await settle(agentId, run.runId);
	assert(settled.state === "ready", `the run should come to rest ready to save, got "${settled.state}"${settled.error ? `: ${settled.error}` : ""}`);
	const outcomes = Object.fromEntries(settled.sessions.map((session) => [session.id, session.outcome]));
	assert(outcomes[shortConversation.rcId] === "folded" && outcomes[longConversation.rcId] === "folded" && outcomes[droppedConversation.rcId] === "dropped", `two conversations should fold and one drop, got ${JSON.stringify(outcomes)}`);
	approveAbsorbRun(agentId, run.runId, APPROVED_AT);
	resetAbsorbRunsForTests();

	// A conversation remembered after the save. Recent Context is empty again,
	// so this Remember is numbered RC-0001 a second time — the id of the first
	// conversation of all.
	const afterTheSave = remember(agentId, "c_after_0004", "Remembered after the save", "One conversation was remembered after the memory update was saved.", [
		{ speaker: "user", text: `One more thing before you go: the vendor's new contact signs off as ${PLANT_AFTER_THE_SAVE}.` },
		{ speaker: "assistant", text: `Noted — ${PLANT_AFTER_THE_SAVE} is the name to use from now on.` },
	], new Date(`${RUN_DAY}T11:00:00.000Z`));
	assert(afterTheSave.rcId === shortConversation.rcId, `the save emptied Recent Context, so the next Remember should reuse ${shortConversation.rcId} and prove the corpus does not match by id alone, got ${afterTheSave.rcId}`);
	pass("a Memorize folds two conversations, drops a third, and the Remember after it reuses the first conversation's Recent Context id");

	// =====================================================================
	// 1. The notes.
	// =====================================================================
	const first = collectRoomDocuments(agentId, { runtimeCwd: threadCwd });
	assert(first.skipped.length === 0, `no folded conversation should be skipped, got ${JSON.stringify(first.skipped)}`);
	const notes = ofSource(first.docs, "note");
	assert(notes.length === 3, `the room should hold three live notes, got ${notes.length}: ${JSON.stringify(notes.map((note) => note.text.slice(0, 40)))}`);
	assert(new Set(notes.map((note) => note.topic)).size === 2, `the three notes should sit under two topics, got ${JSON.stringify(notes.map((note) => note.topic))}`);

	const superseded = withText(notes, SUPERSEDED_TEXT);
	assert(superseded.topic === "Commercial terms", `the superseded note keeps its topic, got ${superseded.topic}`);
	assert(superseded.date === RUN_DAY, `a note a fold rewrote is dated the day it was rewritten, got ${superseded.date}`);
	assert(superseded.origin === "in memory, saved 2026-09-01", `a note's origin says when it was first saved, got "${superseded.origin}"`);
	assert(superseded.meta?.kind === "practice" && superseded.meta?.pinned === false && superseded.meta?.from === "RC-0900", `a note carries its kind, its pin and the conversation that wrote it, got ${JSON.stringify(superseded.meta)}`);

	const kept = withText(notes, KEPT_NOTE);
	assert(kept.date === "2026-09-02" && kept.origin === "in memory, saved 2026-09-02", `a note no fold touched is dated the day it was saved, got ${kept.date} / "${kept.origin}"`);

	const added = withText(notes, ADDED_TEXT);
	assert(added.topic === "Delivery" && added.date === RUN_DAY && added.origin === `in memory, saved ${RUN_DAY}`, `a note this fold wrote is dated and filed by the save, got ${JSON.stringify({ topic: added.topic, date: added.date, origin: added.origin })}`);
	assert(added.meta?.from === longConversation.rcId, `a note a fold wrote names the conversation it came from, got ${JSON.stringify(added.meta)}`);

	assert(!first.docs.some((doc) => doc.source === "note" && doc.text.includes(DEMOTED_NOTE)), "the note the budget took is no longer a live note");
	assert(!JSON.stringify(first.docs).includes("**Session arc:**"), "Recent Context is still in the room's context, so none of it is a document");
	pass("every live note is a document with its topic, its dates and the day it was saved, and Recent Context is not");

	// =====================================================================
	// 2. The archive.
	// =====================================================================
	const archive = ofSource(first.docs, "archive");
	assert(archive.length === 2, `the room should hold two archived rows, got ${archive.length}`);
	const supersededRow = withText(archive, SUPERSEDE_TARGET);
	assert(supersededRow.id === "m-0001-v1", `the superseded row keeps its own version id, got ${supersededRow.id}`);
	assert(supersededRow.topic === "Commercial terms" && supersededRow.date === RUN_DAY, `the superseded row is filed under the topic it left, on the day it left, got ${JSON.stringify({ topic: supersededRow.topic, date: supersededRow.date })}`);
	assert(supersededRow.origin === `archived ${RUN_DAY}, replaced by a newer note`, `the row says why it left in the person's words, got "${supersededRow.origin}"`);
	assert(supersededRow.meta?.why === "superseded" && supersededRow.meta?.saved === "2026-09-01" && supersededRow.meta?.section === "Deep Memory", `the row carries its reason, its saved day and its section, got ${JSON.stringify(supersededRow.meta)}`);

	const demotedRow = withText(archive, DEMOTED_NOTE);
	assert(demotedRow.id === "m-0004" && demotedRow.topic === "Delivery", `the demoted row keeps its id and its topic, got ${JSON.stringify({ id: demotedRow.id, topic: demotedRow.topic })}`);
	assert(demotedRow.origin === `archived ${RUN_DAY}, moved to make room`, `a note the budget took says so, got "${demotedRow.origin}"`);
	assert(demotedRow.meta?.why === "budget", `the demoted row's reason is the budget, got ${JSON.stringify(demotedRow.meta)}`);
	// An origin is what the room reads and repeats, so no note and no archived
	// row may show an internal id in it.
	for (const doc of [...notes, ...archive]) assert(!/\b(?:RC|m)-\d/.test(String(doc.origin)), `a note's or an archived row's origin shows no RC- or m- id, got "${doc.origin}" on ${doc.id}`);
	pass("every archived row is a document that says when it left and why, in the words the recall tool uses");

	// =====================================================================
	// 3. The conversations.
	// =====================================================================
	const shortDocs = documentsOf(first.docs, shortConversation.rcId);
	const longDocs = documentsOf(first.docs, longConversation.rcId);
	const droppedDocs = documentsOf(first.docs, droppedConversation.rcId);
	assert(shortDocs.length === 1, `the short conversation fits one chunk, got ${shortDocs.length}`);
	assert(longDocs.length >= 2, `the long conversation needs more than one chunk, got ${longDocs.length}`);
	assert(droppedDocs.length === 1, `the dropped conversation is memorized too and fits one chunk, got ${droppedDocs.length}`);
	const conversationDocCount = shortDocs.length + longDocs.length + droppedDocs.length;
	assert(ofSource(first.docs, "conversation").length === conversationDocCount, `every memorized conversation is a document, folded or dropped, and nothing else is, got ${ofSource(first.docs, "conversation").length} against ${conversationDocCount}`);

	// The conversation itself is part of the address, because a Memorize hands a
	// Recent Context id back to the conversation after it: two chunks two saves
	// apart would otherwise share an id.
	assert(shortDocs[0]!.id === `${shortConversation.rcId}#1@c_short_0001`, `a chunk is addressed by its Recent Context entry, its number and the conversation it was said in, got ${shortDocs[0]!.id}`);
	assert(shortDocs[0]!.date === REMEMBER_DAY, `a conversation is dated the day it was remembered, not the day it was folded, got ${shortDocs[0]!.date}`);
	// Three conversations of this room were remembered on one day, so each says
	// its time (UTC, as the checkpoint stored it) and none says its id.
	assert(shortDocs[0]!.origin === `from a conversation on ${REMEMBER_DAY} at 08:00 UTC`, `a chunk says the day it was remembered, and the time because the day is shared, and never its id, got "${shortDocs[0]!.origin}"`);
	assert(longDocs.every((doc) => doc.origin === `from a conversation on ${REMEMBER_DAY} at 09:00 UTC`), `every chunk of one conversation carries the same origin, got ${JSON.stringify(longDocs.map((doc) => doc.origin))}`);
	assert(ofSource(first.docs, "conversation").every((doc) => !/\bRC-\d/.test(String(doc.origin))), `no conversation's origin shows a Recent Context id, got ${JSON.stringify(ofSource(first.docs, "conversation").map((doc) => doc.origin))}`);
	assert(shortDocs[0]!.meta?.rcId === shortConversation.rcId, `the Recent Context id stays in the meta for the tools, got ${JSON.stringify(shortDocs[0]!.meta)}`);
	assert(shortDocs[0]!.meta?.conversationId === "c_short_0001", `a chunk carries the conversation it was read from, got ${JSON.stringify(shortDocs[0]!.meta)}`);
	assert(shortDocs[0]!.text.includes(PLANT_FOLDED_SHORT), `the chunk must carry ${PLANT_FOLDED_SHORT}, which only the transcript ever held`);
	assert(longDocs.some((doc) => doc.text.includes(PLANT_FOLDED_LONG)), `the long conversation's chunks must carry ${PLANT_FOLDED_LONG}, which only the transcript ever held`);
	assert(shortDocs[0]!.text.startsWith("user: ") && shortDocs[0]!.text.includes("\nassistant: "), `each message is prefixed by who said it, got "${shortDocs[0]!.text.slice(0, 80)}"`);
	assert(JSON.stringify(shortDocs[0]!.meta?.speakers) === JSON.stringify(["user", "assistant"]), `a chunk names the speakers in it, got ${JSON.stringify(shortDocs[0]!.meta?.speakers)}`);
	assert(shortDocs[0]!.meta?.outcome === "folded" && longDocs.every((doc) => doc.meta?.outcome === "folded"), `a chunk of a conversation the fold took notes from says so, got ${JSON.stringify(shortDocs[0]!.meta)}`);

	// The dropped conversation: the fold took no notes from it, and that is what
	// its documents say, but its words are searchable like any other memorized
	// conversation's, because the fold judges what is worth carrying in front of
	// the room every turn and not what stays findable.
	assert(droppedDocs[0]!.text.includes(PLANT_DROPPED), `the dropped conversation's chunk must carry ${PLANT_DROPPED}, which only its transcript ever held`);
	assert(droppedDocs[0]!.origin === `from a conversation on ${REMEMBER_DAY} at 10:00 UTC (no notes taken)`, `a dropped conversation's origin says no notes were taken from it, after the day and the time, got "${droppedDocs[0]!.origin}"`);
	assert(droppedDocs[0]!.meta?.outcome === "dropped" && droppedDocs[0]!.meta?.conversationId === "c_drop_0003" && droppedDocs[0]!.id === `${droppedConversation.rcId}#1@c_drop_0003`, `a dropped conversation's chunk carries its outcome and is addressed like any other, got ${JSON.stringify({ id: droppedDocs[0]!.id, meta: droppedDocs[0]!.meta })}`);
	assert(droppedDocs[0]!.date === REMEMBER_DAY, `a dropped conversation is dated the day it was remembered too, got ${droppedDocs[0]!.date}`);

	const corpusText = JSON.stringify(first.docs);
	assert(!corpusText.includes(PLANT_AFTER_THE_SAVE), `a conversation remembered after the save is still in Recent Context and is not searchable, and ${PLANT_AFTER_THE_SAVE} came back, which is what matching a fold to a transcript by Recent Context id alone would do`);
	pass("every memorized conversation is chunked documents carrying words only its transcript held, the dropped one says no notes were taken, and the reused Recent Context id does not fetch the wrong transcript");

	// =====================================================================
	// 4. The chunking.
	// =====================================================================
	const spokenLines = longTurns.filter((_, index) => index + 1 !== OVERSIZED_TURN).map((turn) => `${turn.speaker}: ${turn.text}`);
	const oversizedPrefix = `${longTurns[OVERSIZED_TURN - 1]!.speaker}: `;
	const pieces: string[] = [];
	for (const doc of longDocs) {
		assert(doc.text.length <= CONVERSATION_CHUNK_CHARS, `a chunk is at most ${CONVERSATION_CHUNK_CHARS} characters, got ${doc.text.length}`);
		for (const line of doc.text.split("\n")) {
			if (spokenLines.includes(line)) continue;
			assert(line.startsWith(oversizedPrefix) && oversizedMessage.includes(line.slice(oversizedPrefix.length)), `a chunk breaks between messages, and only the one turn too long for a chunk may be broken into — this line is neither: "${line.slice(0, 60)}…"`);
			pieces.push(line.slice(oversizedPrefix.length));
		}
	}
	assert(longDocs.flatMap((doc) => doc.text.split("\n")).length === spokenLines.length + pieces.length, "every turn of the conversation is in exactly one chunk, and the one that did not fit is in as many as it needed");
	assert(pieces.length >= 2, `the turn longer than a whole chunk is broken into pieces, got ${pieces.length}`);
	for (const piece of pieces) assert(piece.endsWith("."), `a turn that has to be broken is broken at a sentence end, and this piece stops mid-sentence: "…${piece.slice(-50)}"`);
	assert(pieces.join(" ") === oversizedMessage, "the pieces of a broken turn put it back together whole, losing nothing");
	assert(pieces.every((piece) => piece.length + oversizedPrefix.length <= CONVERSATION_CHUNK_CHARS), "each piece still fits a chunk once the speaker is in front of it");
	longDocs.forEach((doc, index) => {
		assert(doc.id === `${longConversation.rcId}#${index + 1}@c_long_0002`, `chunks are numbered in order under their conversation, got ${doc.id} at ${index}`);
		assert(doc.meta?.chunk === index + 1 && doc.meta?.chunks === longDocs.length, `a chunk says which one of how many it is, got ${JSON.stringify(doc.meta)}`);
	});
	pass("a conversation is chunked at the character limit on message boundaries, and the one turn too long for a chunk is broken at its sentence ends and nowhere else");

	// =====================================================================
	// 5. The cache.
	// =====================================================================
	invalidateRoomCorpus();
	const built = loadRoomCorpus(agentId, { runtimeCwd: threadCwd });
	assert(loadRoomCorpus(agentId, { runtimeCwd: threadCwd }) === built, "a second read of an unchanged room is the same corpus, not a second build");
	assert(built.index.size === built.docs.length, `the index holds every document, got ${built.index.size} of ${built.docs.length}`);
	assert(built.counts.note === 3 && built.counts.archive === 2 && built.counts.conversation === conversationDocCount, `the corpus counts its sources, got ${JSON.stringify(built.counts)}`);
	assert(built.builtFrom.some((file) => file.path === l1bPath), "the memory file is one of the files the corpus was built from");
	assert(built.builtFrom.some((file) => file.path.includes(path.join("events", "checkpoint"))) && built.builtFrom.some((file) => file.path.includes(path.join("events", "absorb"))), `both event folders are watched, got ${JSON.stringify(built.builtFrom.map((file) => file.path))}`);

	appendArchive(agentId, [{
		entry: { id: "m-0500", kind: "fact", saved: "2026-08-01", pinned: false, text: "- A note filed straight into the archive by hand." },
		why: "user",
		topic: "Commercial terms",
		section: "Deep Memory",
		archived: RUN_DAY,
	}], APPROVED_AT);
	const afterArchive = loadRoomCorpus(agentId, { runtimeCwd: threadCwd });
	assert(afterArchive !== built, "a new archive row rebuilds the corpus");
	assert(afterArchive.counts.archive === 3 && readArchive(agentId).length === 3, `the rebuilt corpus holds the new row, got ${JSON.stringify(afterArchive.counts)}`);

	const touched = new Date(Date.now() + 5_000);
	fs.utimesSync(l1bPath, touched, touched);
	const afterTouch = loadRoomCorpus(agentId, { runtimeCwd: threadCwd });
	assert(afterTouch !== afterArchive, "a memory file whose mtime moved rebuilds the corpus");
	assert(loadRoomCorpus(agentId, { runtimeCwd: threadCwd }) === afterTouch, "and settles again once nothing is moving");

	invalidateRoomCorpus(agentId);
	assert(loadRoomCorpus(agentId, { runtimeCwd: threadCwd }) !== afterTouch, "invalidating a room drops its corpus");
	pass("the corpus is built once and handed back until a watched file moves, and dropping it is one call");

	// =====================================================================
	// 6. A clock that stepped back, with and without the names.
	//
	// The Remember is stamped AFTER the Memorize that folded it. The Memorize
	// wrote which Remember and which conversation it folded into its record, so
	// the clock is never consulted and the conversation is indexed. A record
	// written before the names were kept has only the clock to go by, and an
	// absorb event may only claim a checkpoint approved at or before it: the
	// folded conversation is matched to nothing. It cannot be indexed, and the
	// one thing that must not happen is for it to vanish quietly: a room whose
	// search is missing a memorized conversation has to be able to say which one.
	// =====================================================================
	const steppedRoom = createPersistentAgentFromScaffoldInput({ displayName: "Memory Search Clock Step Room", userName: "Synthetic User", preferredUserAddress: "Synthetic User" });
	const steppedId = steppedRoom.agent.agentId;
	fs.writeFileSync(path.join(root, steppedId, "L1b", "current.md"), smallMemoryFixture(steppedId), { mode: 0o600 });
	// The Remember is stamped five days AFTER the Memorize that folds it.
	const steppedConversation = remember(steppedId, "c_stepped_0001", "The conversation the clock lost", "A conversation was remembered on a clock that had stepped forward.", [
		{ speaker: "user", text: "The clock on this machine is five days out, and this conversation was closed on it." },
		{ speaker: "assistant", text: "Noted — the Remember carries the machine's day, not the day it really was." },
	], new Date("2026-09-20T09:00:00.000Z"));
	const steppedRun = startAbsorbRun({
		agentId: steppedId,
		assessmentMarkdown: "## What this session leaves behind\n\n- One durable point.",
		model: MODEL,
		generate: scriptedGenerate({
			[steppedConversation.rcId]: () => reply("One point is worth keeping.", [{ op: "add", topic: "Commercial terms", kind: "fact", text: "- The clock on the machine runs five days fast." }]),
		}),
		now: RUN_CLOCK,
	});
	const steppedSettled = await settle(steppedId, steppedRun.runId);
	assert(steppedSettled.state === "ready", `the clock-step run should come to rest ready to save, got "${steppedSettled.state}"${steppedSettled.error ? `: ${steppedSettled.error}` : ""}`);
	approveAbsorbRun(steppedId, steppedRun.runId, APPROVED_AT);
	resetAbsorbRunsForTests();

	const steppedNamed = collectRoomDocuments(steppedId, { runtimeCwd: threadCwd });
	const steppedNamedDocs = ofSource(steppedNamed.docs, "conversation");
	assert(steppedNamed.skipped.length === 0 && steppedNamedDocs.length === 1 && steppedNamedDocs[0]!.meta?.conversationId === "c_stepped_0001" && steppedNamedDocs[0]!.meta?.rcId === steppedConversation.rcId, `a Memorize that named what it folded is matched by the names and never by the clock, got ${steppedNamedDocs.length} conversation documents and skipped ${JSON.stringify(steppedNamed.skipped)}`);

	stripNamesFromAbsorbRecords(steppedId);
	const steppedDocs = collectRoomDocuments(steppedId, { runtimeCwd: threadCwd });
	assert(ofSource(steppedDocs.docs, "conversation").length === 0, `a fold that claims no Remember has no transcript to index, got ${ofSource(steppedDocs.docs, "conversation").length} conversation documents`);
	const steppedSkip = steppedDocs.skipped.find((entry) => entry.recentContextId === steppedConversation.rcId);
	assert(steppedSkip, `the folded conversation the corpus could not place must be reported, and skipped holds ${JSON.stringify(steppedDocs.skipped)}`);
	assert(/Remember/.test(steppedSkip!.why) && /folded/.test(steppedSkip!.why), `the reason says plainly what is missing, got "${steppedSkip!.why}"`);
	pass("a Memorize that named what it folded is matched by the names whatever the clock says, and an older record whose Remember cannot be claimed in time is reported as skipped with its reason, never dropped in silence");

	// =====================================================================
	// 7. A room that reuses its ids across three Memorizes.
	//
	// Every Memorize empties Recent Context, so RC-0001 and RC-0002 are used
	// three times each. The second pair of Remembers is stamped AFTER the first
	// pair and BEFORE the Memorize that folded the first pair, which is what a
	// day-stamped clock does to a conversation remembered after a fold on the
	// same day: read in time and taking the newest, the first Memorize would
	// take the second conversation's transcript. Between the second and third
	// Memorize a conversation is held in the room and never Remembered.
	// =====================================================================
	const reuseRoom = createPersistentAgentFromScaffoldInput({ displayName: "Memory Search Reused Ids Room", userName: "Synthetic User", preferredUserAddress: "Synthetic User" });
	const reuseId = reuseRoom.agent.agentId;
	fs.writeFileSync(path.join(root, reuseId, "L1b", "current.md"), smallMemoryFixture(reuseId), { mode: 0o600 });
	const reuseAbsorbDir = path.join(root, reuseId, "events", "absorb");
	const reuseCheckpointDir = path.join(root, reuseId, "events", "checkpoint");
	/** A clock on the Remember day, in seconds after nine. */
	const at = (seconds: number) => new Date(Date.parse(`${REMEMBER_DAY}T09:00:00.000Z`) + seconds * 1000);

	interface Memorized {
		conversationId: string;
		rcId: string;
		checkpointId: string;
		outcome: "folded" | "dropped";
		plant: string;
		/** The time its origin says: every pair here was remembered in one second, so the minute is shared and the seconds are printed. */
		time: string;
	}
	const memorizedHere: Memorized[] = [];
	const rememberHere = (conversationId: string, plant: string, now: Date): { rcId: string; checkpointId: string } =>
		remember(reuseId, conversationId, `The ${plant} conversation`, `A conversation about the ${conversationId} matter.`, [
			{ speaker: "user", text: `For the record, the reference for this one is ${plant}, and nobody else uses it.` },
			{ speaker: "assistant", text: `Noted: ${plant} it is.` },
		], now);
	const memorizeHere = async (pair: Array<{ conversationId: string; rcId: string; checkpointId: string; plant: string; outcome: "folded" | "dropped"; note?: string }>, now: Date, time: string): Promise<void> => {
		const scripts: Record<string, (prompt: string) => AbsorbGenerateResult> = {};
		for (const entry of pair) {
			scripts[entry.rcId] = entry.outcome === "folded"
				// Each fold adds a sentence of its own: two notes that share their
				// words and differ in one token read as a changed value and are
				// refused as a conflict, which is right and not what this room tests.
				? () => reply("One point is worth keeping.", [{ op: "add", topic: "Commercial terms", kind: "fact", text: `- ${entry.note}` }])
				: () => reply("Nothing here that memory does not hold.", [{ op: "drop", reason: "Memory already holds what this conversation went over." }]);
		}
		const started = startAbsorbRun({ agentId: reuseId, assessmentMarkdown: "## What these sessions leave behind\n\n- One point each, or nothing.", model: MODEL, generate: scriptedGenerate(scripts), now: () => now });
		const rested = await settle(reuseId, started.runId);
		assert(rested.state === "ready", `the reuse room's run should come to rest ready to save, got "${rested.state}"${rested.error ? `: ${rested.error}` : ""}`);
		for (const entry of pair) {
			const outcome = rested.sessions.find((session) => session.id === entry.rcId)?.outcome;
			assert(outcome === entry.outcome, `${entry.rcId} should be ${entry.outcome}, got ${outcome}: ${rested.sessions.find((session) => session.id === entry.rcId)?.reason}`);
		}
		approveAbsorbRun(reuseId, started.runId, now);
		resetAbsorbRunsForTests();
		memorizedHere.push(...pair.map((entry) => ({ conversationId: entry.conversationId, rcId: entry.rcId, checkpointId: entry.checkpointId, outcome: entry.outcome, plant: entry.plant, time })));
	};

	// First pair at 09:00, folded at 09:02. Second pair at 09:01, folded at 09:03.
	const a1 = rememberHere("c_reuse_a1", "AMBERLATTICE", at(0));
	const a2 = rememberHere("c_reuse_a2", "BASALTQUIVER", at(0));
	assert(a1.rcId === "RC-0001" && a2.rcId === "RC-0002", `the first pair should be RC-0001 and RC-0002, got ${a1.rcId} and ${a2.rcId}`);
	await memorizeHere([
		{ conversationId: "c_reuse_a1", ...a1, plant: "AMBERLATTICE", outcome: "folded", note: "The counterparty signs its addenda on Mondays." },
		{ conversationId: "c_reuse_a2", ...a2, plant: "BASALTQUIVER", outcome: "dropped" },
	], at(120), "09:00:00");
	const b1 = rememberHere("c_reuse_b1", "COBALTMARROW", at(60));
	const b2 = rememberHere("c_reuse_b2", "DAMSONPULLEY", at(60));
	assert(b1.rcId === "RC-0001" && b2.rcId === "RC-0002", `the second pair should reuse RC-0001 and RC-0002, got ${b1.rcId} and ${b2.rcId}`);
	await memorizeHere([
		{ conversationId: "c_reuse_b1", ...b1, plant: "COBALTMARROW", outcome: "folded", note: "Deliveries to the northern site go by rail." },
		{ conversationId: "c_reuse_b2", ...b2, plant: "DAMSONPULLEY", outcome: "folded", note: "Quarterly summaries reach the board a week before it meets." },
	], at(180), "09:01:00");

	// (a) The records name what they folded, and the index reads the names.
	const recordsHere = () => fs.readdirSync(reuseAbsorbDir).filter((name) => name.endsWith(".json")).map((name) => JSON.parse(fs.readFileSync(path.join(reuseAbsorbDir, name), "utf-8")));
	for (const record of recordsHere()) {
		for (const session of record.run.sessions as Array<{ id: string; outcome: string; conversationId?: string; checkpointId?: string }>) {
			const known = memorizedHere.find((entry) => entry.checkpointId === session.checkpointId);
			assert(known && known.rcId === session.id && known.conversationId === session.conversationId && known.outcome === session.outcome, `a Memorize's record names the Remember and the conversation of every entry it folded or dropped, got ${JSON.stringify(session)}`);
		}
	}
	const PLANT_NEVER_REMEMBERED = "ECHOGRANITE";
	const auditReuseRoom = (label: string): SearchDocument[] => {
		const corpus = collectRoomDocuments(reuseId, { runtimeCwd: threadCwd });
		assert(corpus.skipped.length === 0, `${label}: nothing memorized should be skipped, got ${JSON.stringify(corpus.skipped)}`);
		const conversations = ofSource(corpus.docs, "conversation");
		for (const entry of memorizedHere) {
			const own = conversations.filter((doc) => doc.meta?.conversationId === entry.conversationId);
			assert(own.length === 1, `${label}: ${entry.conversationId} should have exactly one document, got ${own.length}`);
			assert(own[0]!.meta?.rcId === entry.rcId && own[0]!.meta?.outcome === entry.outcome, `${label}: ${entry.conversationId}'s document is filed under its own Recent Context id and outcome, got ${JSON.stringify(own[0]!.meta)}`);
			assert(own[0]!.text.includes(entry.plant), `${label}: ${entry.conversationId}'s document carries its own transcript's word ${entry.plant}, got "${own[0]!.text.slice(0, 80)}"`);
			assert(own[0]!.origin === `from a conversation on ${REMEMBER_DAY} at ${entry.time} UTC${entry.outcome === "dropped" ? " (no notes taken)" : ""}`, `${label}: the origin says the day, the time to the second where the minute is shared, and whether notes were taken, got "${own[0]!.origin}"`);
		}
		const memorizedIds = new Set(memorizedHere.map((entry) => entry.conversationId));
		for (const doc of conversations) {
			assert(memorizedIds.has(String(doc.meta?.conversationId)), `${label}: a document points at a conversation that was never memorized: ${JSON.stringify({ id: doc.id, meta: doc.meta })}`);
		}
		assert(conversations.length === memorizedHere.length, `${label}: one document per memorized conversation, got ${conversations.length} for ${memorizedHere.length}`);
		assert(!JSON.stringify(corpus).includes(PLANT_NEVER_REMEMBERED), `${label}: a conversation nobody Remembered is in no document and no skipped row, and ${PLANT_NEVER_REMEMBERED} came back`);
		return corpus.docs;
	};
	auditReuseRoom("after two Memorizes");

	// (f) A conversation held in the room and never Remembered, before and
	// after a Memorize: no checkpoint event, no fold record, nothing to index.
	converse(reuseId, "c_reuse_never", [
		{ speaker: "user", text: `This one nobody will Remember, and its reference is ${PLANT_NEVER_REMEMBERED}.` },
		{ speaker: "assistant", text: `Then ${PLANT_NEVER_REMEMBERED} stays between us.` },
	]);
	assert(getPersistentAgentThread(reuseId, "c_reuse_never")?.runtime.kind === "pi-session-jsonl", "the never-remembered conversation is held in the room with a session file of its own");
	auditReuseRoom("with a conversation nobody Remembered, before the third Memorize");

	const c1 = rememberHere("c_reuse_c1", "FENNELCOMPASS", at(240));
	const c2 = rememberHere("c_reuse_c2", "GARNETSPINDLE", at(240));
	assert(c1.rcId === "RC-0001" && c2.rcId === "RC-0002", `the third pair should reuse RC-0001 and RC-0002 again, got ${c1.rcId} and ${c2.rcId}`);
	await memorizeHere([
		{ conversationId: "c_reuse_c1", ...c1, plant: "FENNELCOMPASS", outcome: "dropped" },
		{ conversationId: "c_reuse_c2", ...c2, plant: "GARNETSPINDLE", outcome: "folded", note: "Invoices are numbered by project and never by month." },
	], at(300), "09:04:00");
	assert(memorizedHere.length === 6 && new Set(memorizedHere.map((entry) => entry.rcId)).size === 2, "six conversations were memorized under two Recent Context ids");
	// (e) The audit: every memorized conversation under its own ids, no
	// document pointing anywhere else, and the never-remembered one nowhere.
	auditReuseRoom("after three Memorizes, with a conversation nobody Remembered");
	pass("a Memorize names the Remember and the conversation of every entry it folded or dropped, the index reads the names, every memorized conversation is filed under its own ids across three reuses, and a conversation nobody Remembered is in no document and no skipped row");

	// (b) The same records written before the names were kept: matched in
	// time, to the oldest unclaimed Remember of the id. The first Memorize
	// (09:02) may claim either RC-0001 Remember (09:00 and 09:01); the oldest
	// is the conversation it folded, the newest is the one remembered after it.
	const namedRecords = new Map(fs.readdirSync(reuseAbsorbDir).filter((name) => name.endsWith(".json")).map((name) => [name, fs.readFileSync(path.join(reuseAbsorbDir, name), "utf-8")] as const));
	stripNamesFromAbsorbRecords(reuseId);
	assert(recordsHere().every((record) => record.run.sessions.every((session: Record<string, unknown>) => !("conversationId" in session) && !("checkpointId" in session))), "the rewritten records carry no names, like a record written before this version");
	invalidateRoomCorpus(reuseId);
	const withoutNames = auditReuseRoom("matched in time, without the names");
	const firstFold = withoutNames.find((doc) => doc.source === "conversation" && doc.meta?.rcId === "RC-0001" && doc.text.includes("AMBERLATTICE"));
	assert(firstFold && firstFold.meta?.conversationId === "c_reuse_a1", `the first Memorize's RC-0001 is the conversation remembered first, not the one remembered after the fold and stamped before it, got ${JSON.stringify(firstFold?.meta)}`);
	for (const [name, text] of namedRecords) fs.writeFileSync(path.join(reuseAbsorbDir, name), text);
	pass("a record written before the names were kept is matched in time to the oldest unclaimed Remember of its id, which is the conversation the fold consumed");

	// (d) A folded entry whose Remember record is gone is still reported; a
	// dropped one whose record is gone is passed over, since no note stands
	// behind it that the room could act on.
	const goneFolded = memorizedHere.find((entry) => entry.conversationId === "c_reuse_c2")!;
	const goneDropped = memorizedHere.find((entry) => entry.conversationId === "c_reuse_a2")!;
	fs.rmSync(path.join(reuseCheckpointDir, `${goneFolded.checkpointId}.json`));
	fs.rmSync(path.join(reuseCheckpointDir, `${goneDropped.checkpointId}.json`));
	invalidateRoomCorpus(reuseId);
	const withGoneRecords = collectRoomDocuments(reuseId, { runtimeCwd: threadCwd });
	assert(withGoneRecords.skipped.length === 1 && withGoneRecords.skipped[0]!.recentContextId === goneFolded.rcId && withGoneRecords.skipped[0]!.checkpointId === goneFolded.checkpointId, `the folded conversation whose Remember record is gone is reported with its ids, and only it, got ${JSON.stringify(withGoneRecords.skipped)}`);
	assert(/Remember/.test(withGoneRecords.skipped[0]!.why) && /gone/.test(withGoneRecords.skipped[0]!.why), `the reason says the Remember's record is gone, got "${withGoneRecords.skipped[0]!.why}"`);
	const remainingConversations = ofSource(withGoneRecords.docs, "conversation");
	assert(remainingConversations.length === 4 && !remainingConversations.some((doc) => doc.text.includes(goneFolded.plant) || doc.text.includes(goneDropped.plant)), `the two conversations whose records are gone are not indexed, and the other four still are, got ${remainingConversations.length}`);
	// Only the conversations that are indexed count when a minute is shared:
	// c_reuse_a1 lost its neighbour of 09:00 and says the minute alone now.
	const widowed = remainingConversations.find((doc) => doc.meta?.conversationId === "c_reuse_a1");
	assert(widowed?.origin === `from a conversation on ${REMEMBER_DAY} at 09:00 UTC`, `a conversation whose same-minute neighbour is no longer indexed says hours and minutes only, got "${widowed?.origin}"`);
	assert(remainingConversations.filter((doc) => doc.meta?.rcId === "RC-0002").every((doc) => doc.meta?.conversationId === "c_reuse_b2"), `a gone record never hands its id's other conversations to the wrong fold, got ${JSON.stringify(remainingConversations.filter((doc) => doc.meta?.rcId === "RC-0002").map((doc) => doc.meta?.conversationId))}`);
	pass("a folded conversation whose Remember record is gone is reported as skipped with its ids, a dropped one is passed over, and neither takes another conversation's transcript");

	// =====================================================================
	// A conversation the person asked to be left out of a Memorize. It leaves
	// Recent Context with the save, is not memorized and becomes no document;
	// and on a record without names it still takes its Remember out of the
	// running, or the next use of its id would be handed its transcript.
	// =====================================================================
	const leftOutRoom = createPersistentAgentFromScaffoldInput({ displayName: "Memory Search Left Out Room", userName: "Synthetic User", preferredUserAddress: "Synthetic User" });
	const leftOutId = leftOutRoom.agent.agentId;
	fs.writeFileSync(path.join(root, leftOutId, "L1b", "current.md"), smallMemoryFixture(leftOutId), { mode: 0o600 });
	const rememberLeftOut = (conversationId: string, plant: string, now: Date): { rcId: string; checkpointId: string } =>
		remember(leftOutId, conversationId, `The ${plant} conversation`, `A conversation about the ${conversationId} matter.`, [
			{ speaker: "user", text: `For the record, the reference for this one is ${plant}, and nobody else uses it.` },
			{ speaker: "assistant", text: `Noted: ${plant} it is.` },
		], now);
	const foldLeftOutRoom = async (folds: Record<string, string>, drop: string[], now: Date): Promise<void> => {
		const scripts: Record<string, (prompt: string) => AbsorbGenerateResult> = {};
		for (const [rcId, note] of Object.entries(folds)) scripts[rcId] = () => reply("One point is worth keeping.", [{ op: "add", topic: "Commercial terms", kind: "fact", text: `- ${note}` }]);
		const started = startAbsorbRun({
			agentId: leftOutId,
			assessmentMarkdown: "## What these sessions leave behind\n\n- One point each, or nothing.",
			model: MODEL,
			generate: scriptedGenerate(scripts),
			guidance: { pin: [], drop: drop.map((session) => ({ session, reason: "This one was a private aside." })), corrections: [], topics: [], instructions: [] },
			now: () => now,
		});
		const rested = await settle(leftOutId, started.runId);
		assert(rested.state === "ready", `the left-out room's run should come to rest ready to save, got "${rested.state}"${rested.error ? `: ${rested.error}` : ""}`);
		for (const rcId of drop) assert(rested.sessions.find((session) => session.id === rcId)?.outcome === "skipped", `${rcId} should be left out of the run, got ${rested.sessions.find((session) => session.id === rcId)?.outcome}`);
		approveAbsorbRun(leftOutId, started.runId, now);
		resetAbsorbRunsForTests();
	};
	const asideRemember = rememberLeftOut("c_leftout_aside", "ELMWICKET", at(0));
	const keptRemember = rememberLeftOut("c_leftout_kept", "FERNGASKET", at(10));
	assert(asideRemember.rcId === "RC-0001" && keptRemember.rcId === "RC-0002", `the first two should be RC-0001 and RC-0002, got ${asideRemember.rcId} and ${keptRemember.rcId}`);
	await foldLeftOutRoom({ "RC-0002": "The auditors visit the southern depot in the first week of each quarter." }, ["RC-0001"], at(120));
	const laterRemember = rememberLeftOut("c_leftout_later", "GORSEHALYARD", at(240));
	assert(laterRemember.rcId === "RC-0001", `the later conversation should reuse RC-0001, got ${laterRemember.rcId}`);
	await foldLeftOutRoom({ "RC-0001": "Spare handsets are ordered through the facilities desk." }, [], at(300));
	const checkLeftOutRoom = (label: string): void => {
		invalidateRoomCorpus(leftOutId);
		const collected = collectRoomDocuments(leftOutId, { runtimeCwd: threadCwd });
		const conversations = ofSource(collected.docs, "conversation");
		assert(!conversations.some((doc) => doc.text.includes("ELMWICKET")), `${label}: the conversation that was left out is in no document`);
		const reused = conversations.filter((doc) => doc.meta?.rcId === "RC-0001");
		assert(reused.length > 0 && reused.every((doc) => doc.meta?.conversationId === "c_leftout_later" && doc.text.includes("GORSEHALYARD")), `${label}: the fold of the reused RC-0001 is the later conversation, not the one that was left out, got ${JSON.stringify(reused.map((doc) => doc.meta?.conversationId))}`);
		assert(conversations.some((doc) => doc.meta?.conversationId === "c_leftout_kept") && collected.skipped.length === 0, `${label}: the folded neighbour is indexed and nothing is reported as skipped, got ${JSON.stringify(collected.skipped)}`);
	};
	checkLeftOutRoom("with the names");
	stripNamesFromAbsorbRecords(leftOutId);
	checkLeftOutRoom("matched in time, without the names");
	pass("a conversation left out of a Memorize is never indexed and, on a record without names, still takes its Remember out of the running so the next use of its id gets its own transcript");

	// =====================================================================
	// The origin line. It is what the room reads and repeats, so it names the
	// day and never the Recent Context id. A conversation alone on its day says
	// no time; conversations that share a day each say HH:MM UTC; conversations
	// that share the minute too say HH:MM:SS UTC. Times are the checkpoint's
	// approvedAt as stored, which is UTC, and the origin says so.
	// =====================================================================
	const originRoom = createPersistentAgentFromScaffoldInput({ displayName: "Memory Search Origin Line Room", userName: "Synthetic User", preferredUserAddress: "Synthetic User" });
	const originId = originRoom.agent.agentId;
	fs.writeFileSync(path.join(root, originId, "L1b", "current.md"), smallMemoryFixture(originId), { mode: 0o600 });
	const originCases: Array<{ conversationId: string; plant: string; at: string; outcome: "folded" | "dropped"; note?: string; origin: string }> = [
		{ conversationId: "c_origin_alone", plant: "HAZELTRIVET", at: "2026-09-10T16:45:12.000Z", outcome: "folded", note: "The harbour office closes at noon on Fridays.", origin: "from a conversation on 2026-09-10" },
		{ conversationId: "c_origin_morning", plant: "IVORYSEXTANT", at: "2026-09-11T08:05:00.000Z", outcome: "folded", note: "Customs forms are countersigned by the shipping clerk.", origin: "from a conversation on 2026-09-11 at 08:05 UTC" },
		{ conversationId: "c_origin_evening", plant: "JUNIPERANVIL", at: "2026-09-11T19:40:30.000Z", outcome: "dropped", origin: "from a conversation on 2026-09-11 at 19:40 UTC (no notes taken)" },
		{ conversationId: "c_origin_minute_a", plant: "KESTRELBOBBIN", at: "2026-09-12T14:30:05.000Z", outcome: "dropped", origin: "from a conversation on 2026-09-12 at 14:30:05 UTC (no notes taken)" },
		{ conversationId: "c_origin_minute_b", plant: "LARCHTHIMBLE", at: "2026-09-12T14:30:50.000Z", outcome: "folded", note: "Pallet labels are printed in the warehouse and never at the gate.", origin: "from a conversation on 2026-09-12 at 14:30:50 UTC" },
	];
	const originScripts: Record<string, (prompt: string) => AbsorbGenerateResult> = {};
	for (const entry of originCases) {
		const remembered = remember(originId, entry.conversationId, `The ${entry.plant} conversation`, `A conversation about the ${entry.conversationId} matter.`, [
			{ speaker: "user", text: `For the record, the reference for this one is ${entry.plant}, and nobody else uses it.` },
			{ speaker: "assistant", text: `Noted: ${entry.plant} it is.` },
		], new Date(entry.at));
		originScripts[remembered.rcId] = entry.outcome === "folded"
			? () => reply("One point is worth keeping.", [{ op: "add", topic: "Commercial terms", kind: "fact", text: `- ${entry.note}` }])
			: () => reply("Nothing here that memory does not hold.", [{ op: "drop", reason: "Memory already holds what this conversation went over." }]);
	}
	const originRun = startAbsorbRun({ agentId: originId, assessmentMarkdown: "## What these sessions leave behind\n\n- One point each, or nothing.", model: MODEL, generate: scriptedGenerate(originScripts), now: () => new Date("2026-09-13T09:00:00.000Z") });
	const originRested = await settle(originId, originRun.runId);
	assert(originRested.state === "ready", `the origin room's run should come to rest ready to save, got "${originRested.state}"${originRested.error ? `: ${originRested.error}` : ""}`);
	approveAbsorbRun(originId, originRun.runId, new Date("2026-09-13T09:00:00.000Z"));
	resetAbsorbRunsForTests();
	const originCorpus = collectRoomDocuments(originId, { runtimeCwd: threadCwd });
	assert(originCorpus.skipped.length === 0, `nothing in the origin room should be skipped, got ${JSON.stringify(originCorpus.skipped)}`);
	const originOf = (conversationId: string): string => {
		const own = ofSource(originCorpus.docs, "conversation").filter((doc) => doc.meta?.conversationId === conversationId);
		assert(own.length === 1, `${conversationId} should have exactly one document, got ${own.length}`);
		return String(own[0]!.origin);
	};
	for (const entry of originCases) {
		assert(originOf(entry.conversationId) === entry.origin, `${entry.conversationId}, remembered at ${entry.at}, should read "${entry.origin}", got "${originOf(entry.conversationId)}"`);
	}
	assert(originOf("c_origin_morning") !== originOf("c_origin_evening"), "two conversations on one day carry different origins");
	assert(originOf("c_origin_minute_a").replace(" (no notes taken)", "") !== originOf("c_origin_minute_b"), "two conversations in one minute carry different origins");
	assert(!/ at /.test(originOf("c_origin_alone")), `a conversation alone on its day carries no time, got "${originOf("c_origin_alone")}"`);
	for (const doc of originCorpus.docs) assert(!/\b(?:RC|m)-\d/.test(String(doc.origin)), `no origin in the room shows an internal id, got "${doc.origin}" on ${doc.id}`);
	pass("a conversation's origin names the day and never its id: alone on its day it says no time, on a shared day it says the hour and minute, in a shared minute the second too, and a dropped one still says no notes were taken");

	console.log("memory-search-sources-smoke: OK");
} catch (error) {
	console.error(error instanceof Error ? error.stack || error.message : error);
	console.error(`temp home preserved for inspection: ${tempHome}`);
	process.exitCode = 1;
} finally {
	if (process.exitCode !== 1) fs.rmSync(tempHome, { recursive: true, force: true });
}
