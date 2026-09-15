// Memorize's RUN, driven end to end on real rooms in a temp HOME (memory v2, D).
//
// The run is the promise that Memorize costs one session at a time: the server
// folds each remembered session into the room's memory with its own small call,
// a session whose call comes back cut, unreadable or not at all costs that one
// session and nothing else, the budget is the server's own arithmetic rather
// than something a model is asked to respect, and nothing at all is written
// until the user approves. Those are exactly the things that cannot be read off
// the code, so this smoke drives the whole loop with a scripted worker that
// answers the prompt the way a model would — one narrative, one fenced list of
// operations — and then reads the file that was written: what left Recent
// Context and what stayed, what went to the archive and with which reason, what
// Chronos now says, and what the run's own record in the room's events claims
// happened. It also proves the two refusals the design leans on: a memory the
// budget still binds after a fold, and a second approval of the same run, which
// is stale because the first one changed the file the run was built on. And it
// pins what a failed fold SAYS: each cause the worker can fail with reaches the
// card as one sentence about this session and what becomes of it, while the
// provider's own words stay in the room's diagnostics. The later rooms pin the
// 0.12.1 fixes: a conversation folded late is weighed by its date, a Remember
// while the update is open does not stale the save, and an archived version id
// is unique across runs.
//
// Offline: no server, no provider, no network, no port.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { AbsorbRun, AbsorbRunGenerate } from "../src/absorb-run.js";
import type { AbsorbGenerateResult } from "../src/persistent-agents.js";

const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "absorb-run-smoke-home-"));
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

const {
	ABSORB_FOLD_CONNECTION_LOST,
	ABSORB_FOLD_CONNECTION_LOST_TWICE,
	ABSORB_FOLD_REFUSED_TWICE,
	ABSORB_FOLD_RETRY_PAUSE_MS,
	ABSORB_FOLD_TIMED_OUT,
	ABSORB_FOLD_WORKER_FAILED_TWICE,
	ABSORB_RUN_RETENTION_MS,
	approveAbsorbRun,
	cancelAbsorbRun,
	getAbsorbRun,
	keepAbsorbRunEntries,
	editAbsorbRunEntry,
	parseAbsorbRunProposeRequest,
	resetAbsorbRunsForTests,
	rewindAbsorbRunClockForTests,
	setAbsorbFoldRetryPauseForTests,
	setAbsorbRunBudget,
	startAbsorbRun,
} = await import("../src/absorb-run.js");
// A call that never came back is asked again after a pause. The pause is the
// one thing here that is real time rather than behaviour, so it is zeroed.
setAbsorbFoldRetryPauseForTests(0);
const { beginPersistentAgentTurn, buildPersistentAgentCheckpointTranscriptSource, createPersistentAgentFromScaffoldInput, createPersistentAgentPiSessionJsonlThreadRuntime, finishPersistentAgentTurn, parseCheckpointApprovalRequest, reviewTargetEstimatedTokensFromL1b, writeApprovedCheckpoint, writePersistentAgentThread } = await import("../src/persistent-agents.js");
const { IsolatedPersistentAgentWorkerTurnError } = await import("../src/persistent-agent-worker-runtime.js");
const { appendArchive, readArchive } = await import("../src/memory-entries-store.js");
const { undoMemorySave } = await import("../src/memory-undo.js");
const { extractRecentContextForAbsorb, recentContextSessions } = await import("../src/absorb-consolidation.js");
const { readPersistentRoomMaintenanceSettings, writePersistentRoomMaintenanceSettings } = await import("../src/persistent-room-maintenance-settings.js");

const MODEL = { provider: "openai-compatible", model: "gpt-5.5", label: "GPT-5.5" };
const RUN_DAY = "2026-09-13";
const RUN_CLOCK = () => new Date(`${RUN_DAY}T09:00:00.000Z`);
const APPROVED_AT = new Date(`${RUN_DAY}T09:05:00.000Z`);
/** The budget floor, so a fixture the size of a real room is genuinely over it. */
const TIGHT_BUDGET = 10_000;

const ASSESSMENT = [
	"## What these sessions leave behind",
	"",
	"- The pricing arrangement changed and the delivery window with it.",
	"- One open item was finished and one was opened.",
].join("\n");

// The markers the scripted worker steers by: it never knows an entry id before
// the run, so it finds what it must address by the line the fixture planted,
// exactly as a model reads the prompt's entry list.
const UPDATE_TARGET = "FOLD-TARGET-UPDATE";
const SUPERSEDE_TARGET = "FOLD-TARGET-SUPERSEDE";
const CLOSE_TARGET = "FOLD-TARGET-CLOSE";
const ADDED_FACT = "FOLD-ADDED-FACT";
const ADDED_ITEM = "FOLD-ADDED-ITEM";
const UPDATED_TEXT = "FOLD-UPDATED-TEXT";
const SUPERSEDED_TEXT = "FOLD-SUPERSEDED-TEXT";
/** The lowest-ranked entry of the fixture: the one the prepass must take first. */
const DEMOTED_FIRST = "FOLD-DEMOTED-FIRST";

/** What the runtime's HTTP client says when a reply's connection drops: the field's own failure. */
const DROPPED_CONNECTION_DETAIL = "terminated";
/** What the runtime says when a turn runs past the eight-minute ceiling and is stopped. */
const WORKER_TIMEOUT_DETAIL = "it ran past its 480 second limit and was stopped";
/** A failure that is neither: the worker came back with nothing at all. */
const EMPTY_WORKER_SENTENCE = "the fold worker produced no text";
const CANCELLED_SENTENCE = "The memory update was cancelled before this session was folded.";

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

function expectThrows(fn: () => unknown, expected: RegExp, label: string): void {
	try {
		fn();
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		assert(expected.test(message), `${label}: expected a refusal matching ${expected}, got "${message}"`);
		return;
	}
	throw new Error(`${label}: expected a refusal matching ${expected}, but the call returned without one`);
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

// --- The fixtures -------------------------------------------------------------

interface FixtureEntry {
	id: string;
	kind: "fact" | "practice" | "item";
	saved: string;
	pinned?: boolean;
	status?: "open" | "done";
	updated?: string;
	refs?: number;
	/** The conversation that wrote it; a note without one reads "in memory since" its date in the fold prompt. */
	from?: string;
	text: string;
}

function renderFixtureEntry(entry: FixtureEntry): string {
	const fields = [`id=${entry.id}`, `kind=${entry.kind}`, `saved=${entry.saved}`];
	if (entry.from) fields.push(`from=${entry.from}`);
	if (entry.pinned) fields.push("pinned=true");
	if (entry.status) fields.push(`status=${entry.status}`);
	if (entry.updated) fields.push(`updated=${entry.updated}`);
	if (entry.refs !== undefined) fields.push(`refs=${entry.refs}`);
	return `<!-- e: ${fields.join(" ")} -->\n${entry.text}\n`;
}

function entryId(n: number): string {
	return `m-${String(n).padStart(4, "0")}`;
}

/** An entry the size a real room's entries reach, so the budget has something to weigh. */
function fillerEntry(n: number, subject: string): FixtureEntry {
	const detail = `Detail ${n} of the ${subject} arrangement, written out at the length a working room's memory actually reaches, so the room's budget has something real to weigh. `;
	return {
		id: entryId(n),
		kind: "fact",
		saved: `2024-${String((n % 12) + 1).padStart(2, "0")}-${String((n % 27) + 1).padStart(2, "0")}`,
		refs: 0,
		text: `- ${detail.repeat(6)}`.trimEnd(),
	};
}

function fixtureSession(id: string, date: string, title: string, arc: string, body: string[]): string {
	return [
		`### ${id} | OPEN | ${date} | ${title}`,
		"",
		`**Session arc:** ${arc}`,
		"",
		"**Body:**",
		...body.map((line) => `- ${line}`),
		"",
		"**Parked:**",
		"Nothing parked.",
		"",
	].join("\n");
}

/**
 * A room's memory as it stands before a run: already carrying entry ids, so the
 * run reads it without a migration write and the "nothing is written before
 * approve" checks below mean what they say.
 */
function memoryFixture(input: { agentId: string; fillerCount: number; markedEntries: boolean; sessions: string[] }): string {
	const commercial: FixtureEntry[] = [];
	const workingStyle: FixtureEntry[] = [];
	const activeItems: FixtureEntry[] = [];

	if (input.markedEntries) {
		commercial.push({
			id: entryId(1),
			kind: "fact",
			saved: "2020-01-01",
			refs: 0,
			text: `- ${DEMOTED_FIRST} The oldest arrangement of all, kept only until the budget needs the room, which is what makes it the first entry any budget pass takes.`,
		});
	}
	for (let n = 2; n <= input.fillerCount + 1; n++) {
		(n % 2 === 0 ? commercial : workingStyle).push(fillerEntry(n, n % 2 === 0 ? "commercial" : "working-style"));
	}
	if (input.markedEntries) {
		workingStyle.push(
			{ id: entryId(101), kind: "practice", saved: "2026-09-01", from: "RC-0001", updated: "2026-09-11", refs: 6, text: `- ${UPDATE_TARGET} Commercial summaries go out as one page, numbers first.` },
			{ id: entryId(102), kind: "practice", saved: "2026-09-01", from: "RC-0001", updated: "2026-09-11", refs: 6, text: `- ${SUPERSEDE_TARGET} The delivery window is six weeks from the day the order is signed.` },
		);
		activeItems.push({ id: entryId(201), kind: "item", status: "open", saved: "2026-09-01", from: "RC-0001", updated: "2026-09-11", refs: 4, text: `- ${CLOSE_TARGET} Chase the vendor for the signed addendum.` });
	}
	activeItems.push({ id: entryId(202), kind: "item", status: "open", saved: "2026-08-20", updated: "2026-09-10", refs: 1, text: "- Confirm the invoicing day with finance before the quarter closes." });

	return [
		"<!-- exxeta:l1b schema_version=1 -->",
		"",
		"## Chronos",
		"",
		`- Persistent agent id: ${input.agentId}`,
		"- Lifecycle state: ready",
		"- Last checkpoint: cp_20260912_0001",
		"- Last checkpoint at: 2026-09-12T09:00:00.000Z",
		"- Last consolidation: none",
		"",
		"## Deep Memory",
		"",
		"<!-- entries: next=300 -->",
		"",
		"### Commercial terms",
		"",
		commercial.map(renderFixtureEntry).join("\n"),
		"### Working style",
		"",
		workingStyle.map(renderFixtureEntry).join("\n"),
		"## Active Items",
		"",
		activeItems.map(renderFixtureEntry).join("\n"),
		"## Recent Context",
		"",
		input.sessions.join("\n"),
	].join("\n");
}

/**
 * A room's memory as it exists TODAY on a machine that has never run memory v2:
 * topics and bullets, not one entry id anywhere. A run has to give it ids to
 * fold anything into it, and the whole question this fixture exists to settle is
 * where that costs a write.
 */
function v1MemoryFixture(input: { agentId: string; sessions: string[] }): string {
	return [
		"<!-- exxeta:l1b schema_version=1 -->",
		"",
		"## Chronos",
		"",
		`- Persistent agent id: ${input.agentId}`,
		"- Lifecycle state: ready",
		"- Last checkpoint: cp_20260912_0001",
		"- Last checkpoint at: 2026-09-12T09:00:00.000Z",
		"- Last consolidation: none",
		"",
		"## Deep Memory",
		"",
		"### Commercial terms",
		"",
		"- The Nordwind contract renews annually; legal signs before June.",
		"- Invoices go out on the first working day of the month.",
		"",
		"### Working style",
		"",
		"- Send commercial summaries as one page, numbers first.",
		"",
		"## Active Items",
		"",
		"- Chase the vendor for the signed addendum.",
		"",
		"## Recent Context",
		"",
		input.sessions.join("\n"),
	].join("\n");
}

const V1_FIXTURE_BULLETS = 4;

function createRoom(displayName: string, fixture: (agentId: string) => string): { agentId: string; l1bPath: string } {
	const created = createPersistentAgentFromScaffoldInput({ displayName, userName: "Synthetic User", preferredUserAddress: "Synthetic User" });
	const agentId = created.agent.agentId;
	const l1bPath = path.join(root, agentId, "L1b", "current.md");
	fs.writeFileSync(l1bPath, fixture(agentId), { mode: 0o600 });
	return { agentId, l1bPath };
}

/** Where a fixture thread's Pi runtime keeps its session file; under the temp home, so it goes with it. */
const threadCwd = path.join(tempHome, "thread-cwd");
fs.mkdirSync(threadCwd, { recursive: true });

/**
 * A turn in flight on the room. Every memory write refuses while one runs,
 * which makes it the one seam that fails a save AFTER its raise without
 * touching the disk; `finish` ends the turn.
 */
/**
 * A Remember while an update is open, through the real checkpoint write and
 * not an imitation of it: a thread with one transcript item, a checkpoint
 * proposal built from the file as it stands, and the approved entry written
 * the way the product writes it — the next RC id, the rc_metadata line, the
 * Chronos checkpoint stamp.
 */
function rememberMeanwhile(agentId: string, marker: string, now: Date) {
	const conversationId = `c_${Math.random().toString(36).slice(2, 8)}`;
	const item = { kind: "user", id: "u1", text: `Synthetic transcript for ${conversationId}.` };
	writePersistentAgentThread(agentId, conversationId, { state: "active", origin: "home", model: MODEL, items: [item] });
	const l1b = fs.readFileSync(path.join(root, agentId, "L1b", "current.md"), "utf-8");
	const source = buildPersistentAgentCheckpointTranscriptSource({ agentId, conversationId, l1b, legacyItems: [item] }).source;
	const approvedRecentContext = `### RC-DRAFT | OPEN | ${now.toISOString().slice(0, 10)} | Remembered while the update was open\n\n**Session arc:** One conversation was remembered while a memory update was open.\n\n**Body:**\n- ${marker} The thing this conversation settled.\n\n**Parked:**\nNone\n`;
	const parsed = parseCheckpointApprovalRequest({ conversationId, model: MODEL, density: "compact", proposal: { agentId, conversationId, sessionId: null, writesMemory: false, source }, approvedRecentContext }, agentId);
	return writeApprovedCheckpoint(parsed.request, parsed.warnings, now, { runtimeCwd: threadCwd });
}

function beginTurn(agentId: string, threadId: string): { finish: () => void } {
	writePersistentAgentThread(agentId, threadId, {
		state: "active",
		origin: "home",
		model: MODEL,
		items: [{ kind: "user", id: "display-user", text: "Synthetic display item." }],
	}, {
		createRuntime: ({ model }) => createPersistentAgentPiSessionJsonlThreadRuntime({ agentId, threadId, model, cwd: threadCwd }),
	});
	const turnId = `turn_${threadId}`;
	beginPersistentAgentTurn(agentId, threadId, { turnId, connectionId: `ws_${threadId}` });
	return { finish: () => { finishPersistentAgentTurn(agentId, threadId, { turnId, terminalReason: "completed" }); } };
}

// --- The scripted worker -------------------------------------------------------

interface PromptArea {
	id: string;
	topic: string;
	pinned: boolean;
	/** The dates the address carries: the day the entry was saved, and the day a fold last rewrote it. */
	saved?: string;
	updated?: string;
	firstLine: string;
}

interface WorkerCall {
	sessionId: string;
	attempt: number;
	prompt: string;
}

interface ScriptContext {
	prompt: string;
	areas: PromptArea[];
	attempt: number;
}

type Script = (context: ScriptContext) => AbsorbGenerateResult;

const SECTION_SPLIT = /\n\n---\n\n/;

function promptSection(prompt: string, heading: string): string {
	const found = prompt.split(SECTION_SPLIT).find((part) => part.trimStart().startsWith(heading));
	assert(found, `the fold prompt carries no "${heading}" section, so the scripted worker cannot answer it`);
	return found!.slice(found!.indexOf("\n") + 1).trim();
}

/** Which session this prompt is asking about, read off the prompt's own material. */
function sessionIdFromPrompt(prompt: string): string {
	const material = promptSection(prompt, "## Material: The Session To Fold");
	const id = /^###\s+(RC-\d+)/m.exec(material)?.[1];
	assert(id, `the fold prompt's session material carries no "### RC-" heading, so the scripted worker cannot tell which session it was given: ${material.slice(0, 160)}`);
	return id!;
}

/**
 * The entries this prompt says may be addressed, read back the way a model
 * reads them: off the memory itself, where every entry opens with its own id
 * and its dates — `- [m-0031 · saved 2026-08-02] …`, `- [m-0032 · pinned ·
 * saved …] …` for a pinned one, and `· updated 2026-09-01` after the saved
 * date once a fold rewrote it.
 */
const ENTRY_ADDRESS = /^(?:\s*(?:[-*+]|\d+[.)])\s+)?\[([^\]\s·]+)((?:\s+·\s+[^\]·]+)*)\]\s*([\s\S]*)$/;

function areasFromPrompt(prompt: string): PromptArea[] {
	const rows: PromptArea[] = [];
	let topic = "";
	for (const line of promptSection(prompt, "## Material: Core Memory As The Room Reads It").split("\n")) {
		const section = /^##\s+(.+?)\s*$/.exec(line);
		if (section) { topic = section[1] === "Active Items" ? "Active Items" : "General"; continue; }
		const heading = /^###\s+(.+?)\s*$/.exec(line);
		if (heading) { topic = heading[1]; continue; }
		const row = ENTRY_ADDRESS.exec(line.trim());
		if (!row) continue;
		// A note no conversation wrote reads "in memory since" its date instead of "saved".
		const saved = /·\s+(?:saved|in memory since)\s+(\d{4}-\d{2}-\d{2})/.exec(row[2])?.[1];
		const updated = /·\s+updated\s+(\d{4}-\d{2}-\d{2})/.exec(row[2])?.[1];
		rows.push({ id: row[1], topic, pinned: /·\s+pinned\b/.test(row[2]), ...(saved ? { saved } : {}), ...(updated ? { updated } : {}), firstLine: row[3] });
	}
	return rows;
}

function addressOf(areas: PromptArea[], marker: string): string {
	const row = areas.find((area) => area.firstLine.includes(marker));
	assert(row, `the fold prompt no longer lists the entry marked ${marker}, so the scripted worker has nothing to address`);
	return row!.id;
}

/** An entry text of the length a fold writes: well inside the grammar's word ceiling. */
/**
 * A note of the length a real room's notes reach, whose words are its own: two
 * markers never share a body, so the fold's twin check reads two adds as two
 * points and not as one point said twice.
 */
function foldText(marker: string): string {
	const slug = marker.toLowerCase().replace(/[^a-z0-9]+/g, "");
	return `- ${marker} ${Array.from({ length: 60 }, (_, i) => `${slug}${i + 1}`).join(" ")}`;
}

function fence(ops: unknown[]): string {
	return ["```json", JSON.stringify({ ops }, null, 2), "```"].join("\n");
}

function reply(narrative: string, ops: unknown[]): AbsorbGenerateResult {
	return { text: `${narrative}\n\n${fence(ops)}\n`, usage: { input: 2400, output: 260, totalTokens: 2660, cost: 0.0031 } };
}

function scriptedGenerate(scripts: Record<string, Script>, calls: WorkerCall[]): AbsorbRunGenerate {
	return async (prompt, _model, options) => {
		// The fold is a single-shot transform: every call asks for reasoning off, with its own ceiling and cancel hook.
		assert(options.thinkingLevel === "low" && options.signal instanceof AbortSignal && options.timeoutMs > 0, `a fold call carries reasoning off, a signal and a ceiling (got ${JSON.stringify({ ...options, signal: String(options.signal) })})`);
		const sessionId = sessionIdFromPrompt(prompt);
		const attempt = calls.filter((call) => call.sessionId === sessionId).length + 1;
		calls.push({ sessionId, attempt, prompt });
		const script = scripts[sessionId];
		assert(script, `the run asked to fold ${sessionId}, which this smoke scripted no reply for`);
		return script!({ prompt, areas: areasFromPrompt(prompt), attempt });
	};
}

function callsFor(calls: WorkerCall[], sessionId: string): WorkerCall[] {
	return calls.filter((call) => call.sessionId === sessionId);
}

// --- Polling -------------------------------------------------------------------

const WORKING_STATES = new Set(["prepass", "folding", "budget"]);

/** Polls the run the way the client does, until it leaves the states that are still working. */
async function settle(agentId: string, runId: string, label: string): Promise<AbsorbRun> {
	const deadline = Date.now() + 60_000;
	let run = getAbsorbRun(agentId, runId);
	while (WORKING_STATES.has(run.state)) {
		assert(Date.now() < deadline, `${label}: the run was still in state "${run.state}" after 60 seconds, and a scripted fold answers in milliseconds`);
		await sleep(2);
		run = getAbsorbRun(agentId, runId);
	}
	return run;
}

async function waitUntil(predicate: () => boolean, label: string): Promise<void> {
	const deadline = Date.now() + 60_000;
	while (!predicate()) {
		assert(Date.now() < deadline, `${label}: the condition never came true within 60 seconds`);
		await sleep(2);
	}
}

function sessionView(run: AbsorbRun, id: string) {
	const view = run.sessions.find((session) => session.id === id);
	assert(view, `the run should carry a row for ${id}, and its rows are ${run.sessions.map((session) => session.id).join(", ") || "(none)"}`);
	return view!;
}

try {
	// =====================================================================
	// Room one: the loop, its five endings, the prepass, and the write.
	// =====================================================================
	const sessionsA = [
		fixtureSession("RC-0001", "2026-09-09", "Pricing review with the supplier", "A price change was agreed and one thread was left open.", [
			"The pricing arrangement moved to the volume schedule agreed on 2026-09-09.",
			"Someone has to send the revised schedule to the supplier's finance contact.",
		]),
		fixtureSession("RC-0002", "2026-09-09", "Second pricing chat", "The same ground as the pricing review, walked again.", [
			"Nothing here that the pricing review does not already carry.",
		]),
		fixtureSession("RC-0003", "2026-09-10", "Delivery planning", "The delivery window was reconsidered at length.", [
			"The delivery window and everything hanging off it was walked through end to end.",
		]),
		fixtureSession("RC-0004", "2026-09-11", "Addendum signed", "The addendum came back signed and the window changed with it.", [
			"The vendor returned the signed addendum, so that chase is finished.",
			"The delivery window is now four weeks from the day the order is signed.",
		]),
		fixtureSession("RC-0005", "2026-09-11", "Invoicing questions", "A long back and forth about invoicing days.", [
			"Invoicing days were discussed without landing anywhere in particular.",
		]),
		fixtureSession("RC-0006", "2026-09-12", "Quarter close", "The quarter close was planned out.", [
			"The quarter close needs the revised schedule in place first.",
		]),
	];
	const roomA = createRoom("Absorb Run Smoke Room", (agentId) => memoryFixture({ agentId, fillerCount: 68, markedEntries: true, sessions: sessionsA }));
	writePersistentRoomMaintenanceSettings(roomA.agentId, { memoryBudgetTokens: TIGHT_BUDGET });

	const callsA: WorkerCall[] = [];
	const scriptsA: Record<string, Script> = {
		// Folded: two adds, and the entry this session sharpens.
		"RC-0001": ({ areas }) => reply(
			"This session leaves a price change behind and one thread that is still open.",
			[
				{ op: "add", topic: "Commercial terms", kind: "fact", text: foldText(ADDED_FACT) },
				{ op: "add", topic: "Active Items", kind: "item", text: foldText(ADDED_ITEM) },
				{ op: "update", id: addressOf(areas, UPDATE_TARGET), text: foldText(UPDATED_TEXT) },
			],
		),
		// RC-0002 is dropped by the user's own guidance and is never called for.
		// Cut at the model's output ceiling, mid-fence.
		"RC-0003": () => ({
			text: 'The delivery window moved, and the entry that carries it has to move with it.\n\n```json\n{\n  "ops": [\n    { "op": "supersede",',
			truncated: true,
			usage: { input: 2400, output: 8192, totalTokens: 10_592 },
			modelMaxOutputTokens: 8192,
		}),
		// The same operations as a plain reply, under a decorated heading.
		"RC-0004": ({ areas }) => ({
			text: [
				"The addendum came back signed, so the chase is finished and the delivery window is not what it was.",
				"",
				"### Operations",
				"",
				fence([
					{ op: "supersede", id: addressOf(areas, SUPERSEDE_TARGET), text: foldText(SUPERSEDED_TEXT) },
					{ op: "close", id: addressOf(areas, CLOSE_TARGET) },
				]),
				"",
			].join("\n"),
			usage: { input: 2400, output: 240, totalTokens: 2640, cost: 0.0029 },
		}),
		// Unreadable, twice: the one retry runs and the session still fails.
		"RC-0005": () => ({ text: "I have folded the invoicing discussion into memory and saved it for you.", usage: { input: 2400, output: 40, totalTokens: 2440 } }),
		// The worker itself fails, the way it failed in the field: the connection
		// to the provider dropped mid-reply and the runtime said "terminated".
		// It drops on the retry too, so this session is the one that spends all
		// the calls a dropped connection is allowed.
		"RC-0006": () => { throw new IsolatedPersistentAgentWorkerTurnError("memorize fold worker", "error", DROPPED_CONNECTION_DETAIL); },
	};

	const l1bBeforeA = fs.readFileSync(roomA.l1bPath, "utf-8");
	const startedA = startAbsorbRun({
		agentId: roomA.agentId,
		assessmentMarkdown: ASSESSMENT,
		guidance: { pin: [], drop: [{ session: "RC-0002", reason: "This one was a repeat of the pricing review." }], corrections: [], topics: [], instructions: [] },
		model: MODEL,
		generate: scriptedGenerate(scriptsA, callsA),
		now: RUN_CLOCK,
	});
	assert(WORKING_STATES.has(startedA.state), `a run is handed back while it is still working, got "${startedA.state}"`);
	assert(startedA.runId.startsWith("absorbrun_"), `a run is handed back with the id the client polls, got "${startedA.runId}"`);
	const runA = await settle(roomA.agentId, startedA.runId, "the first room's run");
	assert(runA.state === "ready", `a run whose folds are all answered ends ready for approval, got "${runA.state}"${runA.error ? ` with "${runA.error}"` : ""}`);

	// --- 1. The happy path: folded, counted, and the changes carry the texts ----
	const rc1 = sessionView(runA, "RC-0001");
	assert(rc1.outcome === "folded", `RC-0001 was answered with three valid operations and should read as folded, got "${rc1.outcome}"${rc1.reason ? ` because "${rc1.reason}"` : ""}`);
	assert(rc1.attempts === 1, `RC-0001 was accepted first time and should record one attempt, got ${rc1.attempts}`);
	assert(rc1.summary?.added === 2 && rc1.summary?.updated === 1 && rc1.summary?.superseded === 0 && rc1.summary?.closed === 0, `RC-0001 added two entries and updated one, so its summary should read 2/1/0/0, got ${JSON.stringify(rc1.summary)}`);
	const addedChanges = (rc1.changes ?? []).filter((change) => change.kind === "added");
	assert(addedChanges.length === 2 && addedChanges.some((change) => change.after?.includes(ADDED_FACT)) && addedChanges.some((change) => change.after?.includes(ADDED_ITEM)), `RC-0001's changes should carry both added entries by their text, got ${JSON.stringify(addedChanges.map((change) => change.after?.slice(0, 40)))}`);
	const updatedChange = (rc1.changes ?? []).find((change) => change.kind === "updated");
	assert(updatedChange, "RC-0001 updated an entry, so its changes should carry an updated row");
	assert(updatedChange!.before?.includes(UPDATE_TARGET), `an updated change shows what the entry said before, and RC-0001's does not carry ${UPDATE_TARGET}: ${JSON.stringify(updatedChange!.before?.slice(0, 60))}`);
	assert(updatedChange!.after?.includes(UPDATED_TEXT), `an updated change shows what the entry says now, and RC-0001's does not carry ${UPDATED_TEXT}: ${JSON.stringify(updatedChange!.after?.slice(0, 60))}`);
	assert(updatedChange!.topic === "Working style", `an updated change names the topic the entry lives under, got "${updatedChange!.topic}"`);

	// --- 2. A reply cut at the model's output limit costs one session ------------
	const rc3 = sessionView(runA, "RC-0003");
	assert(rc3.outcome === "failed", `a fold cut off at the model's output limit fails that session, got "${rc3.outcome}"`);
	assert(/output limit/.test(rc3.reason ?? ""), `a cut-off fold's reason names the model's output limit, got "${rc3.reason}"`);
	assert((rc3.reason ?? "").includes("8192"), `a cut-off fold's reason carries the numbers the model reported, got "${rc3.reason}"`);
	assert(callsFor(callsA, "RC-0004").length > 0, "a session cut off at the output limit costs one session, and the run must have carried on to the next one");

	// --- 3. A decorated reply still parses ----------------------------------------
	const rc4 = sessionView(runA, "RC-0004");
	assert(rc4.outcome === "folded", `a reply whose fence sits under an "### Operations" heading is still an answer, got "${rc4.outcome}"${rc4.reason ? ` because "${rc4.reason}"` : ""}`);
	assert(rc4.summary?.superseded === 1 && rc4.summary?.closed === 1, `RC-0004 superseded one entry and closed one item, so its summary should read 0/0/1/1, got ${JSON.stringify(rc4.summary)}`);
	const supersededChange = (rc4.changes ?? []).find((change) => change.kind === "superseded");
	assert(supersededChange?.before?.includes(SUPERSEDE_TARGET) && supersededChange?.after?.includes(SUPERSEDED_TEXT), `a superseded change carries the entry before and after, got ${JSON.stringify({ before: supersededChange?.before?.slice(0, 50), after: supersededChange?.after?.slice(0, 50) })}`);
	const closedChange = (rc4.changes ?? []).find((change) => change.kind === "closed");
	assert(closedChange?.before?.includes(CLOSE_TARGET), `a closed change carries the item that was finished, got ${JSON.stringify(closedChange?.before?.slice(0, 50))}`);

	// --- 4. Unreadable twice: the one retry runs, and it is disclosed as a retry ---
	const rc5 = sessionView(runA, "RC-0005");
	assert(rc5.outcome === "failed", `a reply with no operations block, twice, fails that session, got "${rc5.outcome}"`);
	assert(rc5.reason === ABSORB_FOLD_REFUSED_TWICE, `a twice-refused fold carries the product's own sentence, got "${rc5.reason}"`);
	assert(rc5.attempts === 2, `a twice-refused fold records both attempts, got ${rc5.attempts}`);
	const rc5Calls = callsFor(callsA, "RC-0005");
	assert(rc5Calls.length === 2, `a refused fold is asked exactly once more, so the worker should have been called twice for RC-0005, got ${rc5Calls.length}`);
	assert(!rc5Calls[0].prompt.includes("## Retry Notice"), "the first fold call carries no Retry Notice");
	assert(rc5Calls[1].prompt.includes("## Retry Notice"), "the retry call carries the Retry Notice naming what was refused, and this one does not");
	assert(rc5Calls[1].prompt.includes("no ```json fence"), `the Retry Notice repeats the reason the first reply was refused, got: ${rc5Calls[1].prompt.slice(-400)}`);
	assert((rc5Calls[1].prompt.match(/## Retry Notice/g) ?? []).length === 1, "a retry prompt never stacks two Retry Notices");

	// --- 5. A worker that fails outright is asked again, then costs one session ----
	const rc6 = sessionView(runA, "RC-0006");
	assert(rc6.outcome === "failed", `a fold whose worker threw twice fails that session, got "${rc6.outcome}"`);
	assert(rc6.reason === ABSORB_FOLD_CONNECTION_LOST_TWICE, `a connection that dropped on both calls says so, got "${rc6.reason}"`);
	assert(callsFor(callsA, "RC-0006").length === 2, `a call that never came back is asked once more, got ${callsFor(callsA, "RC-0006").length} call(s) for RC-0006`);
	assert(rc6.attempts === 2, `both of those calls are counted, got ${rc6.attempts}`);
	assert(!JSON.stringify(runA).includes(DROPPED_CONNECTION_DETAIL), `the provider's own word for it belongs in the diagnostics, not anywhere in the run the client reads: ${JSON.stringify(rc6.reason)}`);
	assert(runA.state === "ready", "a worker failure on the last session still leaves the run ready for approval");

	// --- 5b. The run echoes the instructions it was started with -------------------
	// The card lists "Your instructions" from this field, and marks a drop applied
	// when its session reads as skipped — so the run has to carry the sign-off, not
	// just act on it.
	assert(runA.guidance, `a run started with a sign-off echoes it, got ${JSON.stringify(runA.guidance)}`);
	assert(JSON.stringify(runA.guidance) === JSON.stringify({ pin: [], drop: [{ session: "RC-0002", reason: "This one was a repeat of the pricing review." }], corrections: [], topics: [], instructions: [] }), `the echo is the sign-off field for field, got ${JSON.stringify(runA.guidance)}`);

	// --- 6. A session the user asked to drop is skipped, and never called for ------
	const rc2 = sessionView(runA, "RC-0002");
	assert(rc2.outcome === "skipped", `a session the user asked to drop is skipped, got "${rc2.outcome}"`);
	assert(rc2.reason === "This one was a repeat of the pricing review.", `a skipped session carries the user's own reason, got "${rc2.reason}"`);
	assert(callsFor(callsA, "RC-0002").length === 0, `a session the user dropped costs no model call, and the worker was asked about RC-0002 ${callsFor(callsA, "RC-0002").length} time(s)`);
	assert(runA.progress.total === 5 && runA.progress.folded === 2, `five sessions were to be folded and two of them landed, got ${runA.progress.folded} of ${runA.progress.total}`);

	// --- 7. The prepass brings an over-budget room under its budget first ----------
	assert(runA.budget.budgetTokens === TIGHT_BUDGET, `the run reads the room's own budget, got ${runA.budget.budgetTokens}`);
	assert(runA.budget.before > TIGHT_BUDGET, `this fixture is meant to start over budget, and it measured ${runA.budget.before} tokens against ${TIGHT_BUDGET}`);
	assert(runA.prepass.demoted.length > 0, "a room that starts over budget has entries taken before the first fold, and this run demoted none");
	assert(runA.prepass.demoted.some((entry) => entry.text.includes(DEMOTED_FIRST)), `the oldest entry of the fixture ranks lowest and must be the prepass's first demotion, and ${DEMOTED_FIRST} is not among ${runA.prepass.demoted.length} demoted entries`);
	assert(runA.prepass.demoted.every((entry) => entry.section && entry.topic && entry.tokens > 0), `every demoted entry is disclosed with its address and its size, got ${JSON.stringify(runA.prepass.demoted[0])}`);
	// The archive list holds the prepass rows as "before" rows and what the folds
	// cost as "after" rows, every one leaving, none kept, none in anyone's stead.
	const beforeRows = runA.demotion.entries.filter((row) => row.phase === "before");
	assert(beforeRows.length === runA.prepass.demoted.length && runA.prepass.demoted.every((card) => beforeRows.some((row) => row.id === card.id)), `every prepass demotion is a "before" row of the archive list, got ${beforeRows.length} of ${runA.prepass.demoted.length}`);
	assert(runA.demotion.entries.some((row) => row.phase === "after" && row.leaving), "the folds put this room over its budget again, so the list carries \"after\" rows too");
	assert(runA.demotion.entries.every((row) => row.leaving && !row.kept && !row.instead && typeof row.rank === "number"), `before anyone keeps anything every row simply leaves, got ${JSON.stringify(runA.demotion.entries.find((row) => !row.leaving || row.kept || row.instead))}`);
	assert(runA.demotion.counts.leaving === runA.demotion.entries.length && runA.demotion.counts.kept === 0 && runA.demotion.counts.instead === 0, `the counts are the server's, got ${JSON.stringify(runA.demotion.counts)}`);
	assert(runA.budget.savedBudgetTokens === TIGHT_BUDGET && runA.demotion.keepTopics.length === 0, `a run starts on the room's saved limit with no topic protected, got ${JSON.stringify(runA.budget)}`);
	for (let i = 1; i < runA.demotion.entries.length; i++) {
		const previous = runA.demotion.entries[i - 1];
		const row = runA.demotion.entries[i];
		if (previous.section === row.section && previous.topic === row.topic) assert(previous.rank < row.rank, `rows of one topic are in rank order, and ${previous.id} (${previous.rank}) sits before ${row.id} (${row.rank})`);
	}
	const firstFoldPrompt = callsA[0]?.prompt ?? "";
	assert(callsA[0]?.sessionId === "RC-0001", `the first model call of the run is the first session it folds, got ${callsA[0]?.sessionId}`);
	assert(!firstFoldPrompt.includes(DEMOTED_FIRST), "an entry the prepass demoted is out of the memory before the first fold reads it, and the first prompt still carries it");
	assert(firstFoldPrompt.includes(UPDATE_TARGET), `the first fold prompt carries the memory that survived the prepass, and ${UPDATE_TARGET} is missing from it`);

	// --- The write is still nothing at all ----------------------------------------
	assert(fs.readFileSync(roomA.l1bPath, "utf-8") === l1bBeforeA, "a run that has folded everything has still written nothing: the memory changes on approval only");

	// --- 10. The archive list is stable: a kept row stays, a replacement is marked ---
	// The largest prepass row is kept: the post-fold pass leaves only a sliver of
	// room under the limit, and a note that fits in that sliver would rightly
	// push nothing out.
	const firstBefore = [...runA.prepass.demoted].sort((a, b) => b.tokens - a.tokens)[0];
	assert(firstBefore.tokens > runA.budget.budgetTokens - runA.budget.after, `the kept note must not fit in the room left under the limit, or nothing has to leave instead: ${firstBefore.tokens} tokens against ${runA.budget.budgetTokens - runA.budget.after} free`);
	const listedBefore = runA.demotion.entries.map((row) => row.id);
	const keptA = keepAbsorbRunEntries(roomA.agentId, startedA.runId, { keepIds: [firstBefore.id] });
	const keptRow = keptA.demotion.entries.find((row) => row.id === firstBefore.id);
	assert(keptRow?.kept === true && keptRow.leaving === false && keptRow.phase === "before", `a kept prepass row stays on the list, kept and no longer leaving, got ${JSON.stringify(keptRow)}`);
	assert(listedBefore.every((id) => keptA.demotion.entries.some((row) => row.id === id)), "no row ever leaves the list once it was on it");
	const replacements = keptA.demotion.entries.filter((row) => row.instead);
	assert(replacements.length > 0 && replacements.every((row) => row.leaving && row.phase === "after" && !listedBefore.includes(row.id)), `keeping a note makes the next least recently touched note leave instead, marked as such, got ${JSON.stringify(replacements.map((row) => row.id))}`);
	assert(keptA.demotion.counts.kept === 1 && keptA.demotion.counts.instead === replacements.length && keptA.demotion.counts.leaving === keptA.demotion.entries.filter((row) => row.leaving).length, `the counts follow the rows, got ${JSON.stringify(keptA.demotion.counts)}`);
	// Taking the keep back: the replacement stays listed as a row that stays.
	const unkept = keepAbsorbRunEntries(roomA.agentId, startedA.runId, { keepIds: [] });
	for (const replacement of replacements) {
		const row = unkept.demotion.entries.find((candidate) => candidate.id === replacement.id);
		assert(row && !row.leaving && !row.instead && !row.kept, `a replacement whose keep was taken back stays on the list as a row that stays, got ${JSON.stringify(row)}`);
	}
	assert(unkept.demotion.entries.find((row) => row.id === firstBefore.id)?.leaving === true && unkept.demotion.counts.kept === 0 && unkept.demotion.counts.instead === 0, "the prepass row leaves again once its keep is taken back");
	assert(unkept.demotion.entries.length === keptA.demotion.entries.length, "the list has the same rows before and after: it only ever grows");
	// A protected topic: every row under it is kept, whatever it was; keepIds is left alone by a body without it.
	const protectedRow = keptA.demotion.entries.find((row) => row.leaving && row.phase === "after")!;
	const topicAddress = `${protectedRow.section}/${protectedRow.topic}`;
	const byTopic = keepAbsorbRunEntries(roomA.agentId, startedA.runId, { keepIds: [firstBefore.id], keepTopics: [`  ${topicAddress.toUpperCase()}  `] });
	assert(JSON.stringify(byTopic.demotion.keepTopics) === JSON.stringify([topicAddress]), `a protected topic is echoed as the row spells it, got ${JSON.stringify(byTopic.demotion.keepTopics)}`);
	const underTopic = byTopic.demotion.entries.filter((row) => row.section === protectedRow.section && row.topic === protectedRow.topic);
	assert(underTopic.length > 0 && underTopic.every((row) => row.kept && !row.leaving), `no note of a protected topic leaves, got ${JSON.stringify(underTopic.map((row) => [row.id, row.kept, row.leaving]))}`);
	assert(byTopic.demotion.counts.kept === byTopic.demotion.entries.filter((row) => row.kept).length && byTopic.demotion.counts.kept > 1, `kept counts the rows kept by id and by topic alike, got ${JSON.stringify(byTopic.demotion.counts)}`);
	const topicsCleared = keepAbsorbRunEntries(roomA.agentId, startedA.runId, { keepTopics: [] });
	assert(JSON.stringify(topicsCleared.demotion.keepIds) === JSON.stringify([firstBefore.id]) && topicsCleared.demotion.keepTopics.length === 0, `a keep body without keepIds leaves the kept ids as they were, got ${JSON.stringify(topicsCleared.demotion.keepIds)}`);
	assert(keepAbsorbRunEntries(roomA.agentId, startedA.runId, { keepTopics: ["Deep Memory/No such topic"] }).demotion.keepTopics.length === 0, "a topic no listed row is under is dropped");
	expectThrows(() => keepAbsorbRunEntries(roomA.agentId, startedA.runId, {}), /keepIds or keepTopics is required/, "a keep body naming neither list");
	const runAFinal = getAbsorbRun(roomA.agentId, startedA.runId);
	assert(runAFinal.demotion.entries.find((row) => row.id === firstBefore.id)?.kept === true, "the prepass row is kept going into the approval");

	// --- 11. Approve: one write, and everything it promised ------------------------
	const demotedOnApproval = runAFinal.demotion.entries.filter((row) => row.leaving).map((row) => row.id);
	assert(demotedOnApproval.length > 0, "the folds put this room back over its budget, so the run must name what it would archive before the user approves, and it named nothing");
	const approval = approveAbsorbRun(roomA.agentId, startedA.runId, APPROVED_AT);
	const writtenA = fs.readFileSync(roomA.l1bPath, "utf-8");
	assert(approval.budgetRaisedTo === undefined, `a save against the saved limit raises nothing, got ${JSON.stringify(approval.budgetRaisedTo)}`);
	const keptMeta = writtenA.slice(writtenA.indexOf(`id=${firstBefore.id} `), writtenA.indexOf(`id=${firstBefore.id} `) + 160);
	assert(writtenA.includes(`id=${firstBefore.id} `) && /pinned=true/.test(keptMeta), `a prepass row the person kept is back in the written memory, pinned as the person's own, got ${JSON.stringify(keptMeta)}`);

	assert(!/^###\s+RC-0001\s*\|/m.test(writtenA), "a folded session leaves Recent Context, and RC-0001 is still there");
	assert(!/^###\s+RC-0004\s*\|/m.test(writtenA), "a folded session leaves Recent Context, and RC-0004 is still there");
	assert(!/^###\s+RC-0002\s*\|/m.test(writtenA), "a session the user dropped leaves Recent Context, and RC-0002 is still there");
	assert(/^###\s+RC-0003\s*\|/m.test(writtenA), "a session whose fold failed stays in Recent Context for next time, and RC-0003 is gone");
	assert(/^###\s+RC-0005\s*\|/m.test(writtenA), "a session whose fold failed stays in Recent Context for next time, and RC-0005 is gone");
	assert(/^###\s+RC-0006\s*\|/m.test(writtenA), "a session whose fold failed stays in Recent Context for next time, and RC-0006 is gone");
	assert(writtenA.includes(ADDED_FACT) && writtenA.includes(ADDED_ITEM), "what the folds added is in the written memory");
	assert(writtenA.includes(UPDATED_TEXT) && !writtenA.includes(UPDATE_TARGET), "an updated entry reads as its new text and no longer as its old one");
	assert(writtenA.includes(SUPERSEDED_TEXT) && !writtenA.includes(SUPERSEDE_TARGET), "a superseded entry reads as its new text and no longer as its old one");
	assert(!writtenA.includes(CLOSE_TARGET), "an item a fold closed leaves the core in the same run that closed it, and it is still there");

	assert(reviewTargetEstimatedTokensFromL1b(writtenA) <= TIGHT_BUDGET, `the budget binds on what is written: the approved memory measures ${reviewTargetEstimatedTokensFromL1b(writtenA)} tokens against a budget of ${TIGHT_BUDGET}`);
	for (const id of demotedOnApproval) {
		assert(!writtenA.includes(`id=${id}`), `${id} was named as demoted by the budget pass, so the approved memory must not still hold it`);
	}

	const archiveA = readArchive(roomA.agentId);
	const archivedById = new Map(archiveA.map((entry) => [entry.id, entry]));
	for (const card of runA.prepass.demoted) {
		if (card.id === firstBefore.id) continue;
		assert(archivedById.get(card.id)?.why === "budget", `an entry the budget took is archived with why=budget, and ${card.id} reads ${JSON.stringify(archivedById.get(card.id)?.why)}`);
	}
	assert(!archivedById.has(firstBefore.id), "the prepass row the person kept did not go to the archive");
	for (const id of demotedOnApproval) {
		assert(archivedById.get(id)?.why === "budget", `an entry the budget took is archived with why=budget, and ${id} reads ${JSON.stringify(archivedById.get(id)?.why)}`);
	}
	const supersededRows = archiveA.filter((entry) => entry.why === "superseded");
	assert(supersededRows.some((entry) => entry.text.includes(UPDATE_TARGET)), `the text an update replaced is kept as a superseded row, and none of the ${supersededRows.length} superseded rows carries ${UPDATE_TARGET}`);
	assert(supersededRows.some((entry) => entry.text.includes(SUPERSEDE_TARGET)), `the text a supersede replaced is kept as a superseded row, and none of the ${supersededRows.length} superseded rows carries ${SUPERSEDE_TARGET}`);
	assert(supersededRows.every((entry) => /-v\d+$/.test(entry.id)), `a superseded row keeps its entry's id with a version suffix, got ${JSON.stringify(supersededRows.map((entry) => entry.id))}`);
	assert(archiveA.some((entry) => entry.why === "done" && entry.text.includes(CLOSE_TARGET)), "an item a fold closed is archived with why=done");
	assert(archiveA.every((entry) => entry.archived === RUN_DAY), `every archived row is stamped with the run's own day, got ${JSON.stringify([...new Set(archiveA.map((entry) => entry.archived))])}`);

	assert(new RegExp(`^- Last consolidation: ${approval.absorbId}$`, "m").test(writtenA), `Chronos carries the consolidation this write was, and the file's line does not name ${approval.absorbId}`);
	assert(new RegExp(`^- Last consolidation at: ${APPROVED_AT.toISOString()}$`, "m").test(writtenA), `Chronos carries the time this consolidation was approved, and the file's line does not name ${APPROVED_AT.toISOString()}`);
	assert(/^- Last checkpoint: cp_20260912_0001$/m.test(writtenA), "a consolidation never moves the checkpoint fields Chronos keeps for the other workflow");

	const eventPath = path.join(root, roomA.agentId, "events", "absorb", `${approval.absorbId}.json`);
	assert(fs.existsSync(eventPath), `an approved run records itself under events/absorb, and ${path.basename(eventPath)} is not there`);
	const record = JSON.parse(fs.readFileSync(eventPath, "utf-8"));
	assert(record.run?.runId === startedA.runId, `the event record names the run it came from, got ${JSON.stringify(record.run?.runId)}`);
	assert(Array.isArray(record.run?.sessions) && record.run.sessions.length === 6, `the event record accounts for every session the run saw, got ${record.run?.sessions?.length}`);
	const recordedOutcomes = Object.fromEntries((record.run.sessions as Array<{ id: string; outcome: string }>).map((session) => [session.id, session.outcome]));
	assert(JSON.stringify(recordedOutcomes) === JSON.stringify({ "RC-0001": "folded", "RC-0002": "skipped", "RC-0003": "failed", "RC-0004": "folded", "RC-0005": "failed", "RC-0006": "failed" }), `the event record carries each session's outcome as the run ended it, got ${JSON.stringify(recordedOutcomes)}`);
	assert(record.run.sessions.find((session: any) => session.id === "RC-0005")?.attempts === 2, "the event record keeps the attempt count of a session that was asked twice");
	assert(Array.isArray(record.run?.archived) && record.run.archived.length === archiveA.length, `the event record lists every entry this write archived, got ${record.run?.archived?.length} against ${archiveA.length} archive rows`);
	assert(record.run.archived.every((row: any) => ["budget", "superseded", "done"].includes(row.why)), `every archived entry is recorded with the reason it left, got ${JSON.stringify([...new Set(record.run.archived.map((row: any) => row.why))])}`);
	assert(record.run.budget?.budgetTokens === TIGHT_BUDGET && record.run.budget?.overBudgetAfter === false, `the event record discloses the budget this write was held to, got ${JSON.stringify(record.run.budget)}`);

	assert(JSON.stringify(approval.foldedSessions) === JSON.stringify(["RC-0001", "RC-0004"]), `the approval reports what was folded, got ${JSON.stringify(approval.foldedSessions)}`);
	assert(JSON.stringify(approval.remainingSessions) === JSON.stringify(["RC-0003", "RC-0005", "RC-0006"]), `the approval reports what stays for next time, got ${JSON.stringify(approval.remainingSessions)}`);
	assert(approval.archivedEntries === archiveA.length, `the approval reports how much was archived, got ${approval.archivedEntries} against ${archiveA.length} archive rows`);
	const budgetRows = archiveA.filter((entry) => entry.why === "budget").length;
	assert(budgetRows > 0 && approval.archivedForBudget === budgetRows, `the saved screen can say how many entries the BUDGET took, apart from superseded texts and finished items, got ${approval.archivedForBudget} against ${budgetRows} budget rows of ${archiveA.length}`);
	assert(approval.archivedForBudget < approval.archivedEntries, `the budget count is its own number, not a copy of the total, and both read ${approval.archivedForBudget}`);
	assert(approval.recentContextEntryCount === 3, `the approval reports how many sessions the room still holds, got ${approval.recentContextEntryCount}`);
	assert(JSON.stringify(approval.rebasedOnto) === "[]", `nothing was remembered while this update was open, and the approval says so with an empty list, got ${JSON.stringify(approval.rebasedOnto)}`);
	assert(approval.memoryBudget.overBudget === false, "an approved write that the budget pass held to the room's budget is not over it");
	assert(getAbsorbRun(roomA.agentId, startedA.runId).state === "saved", "an approved run reads as saved");

	// --- 12. A second approval of the same run is stale ---------------------------
	expectThrows(() => approveAbsorbRun(roomA.agentId, startedA.runId, APPROVED_AT), /stale/i, "approving the same run twice");
	const afterSecondApproval = fs.readFileSync(roomA.l1bPath, "utf-8");
	assert(afterSecondApproval === writtenA, "a refused second approval writes nothing at all");

	// The registry is process-local; the next room starts from a clean one.
	resetAbsorbRunsForTests();

	// =====================================================================
	// Room two: the budget card — keeping past the budget, and raising it.
	// =====================================================================
	const sessionsB = [
		fixtureSession("RC-0001", "2026-09-10", "Schedule agreed", "One durable decision and nothing else.", [
			"The revised schedule was agreed and is the one that now holds.",
		]),
	];
	const roomB = createRoom("Absorb Run Budget Smoke Room", (agentId) => memoryFixture({ agentId, fillerCount: 60, markedEntries: false, sessions: sessionsB }));
	writePersistentRoomMaintenanceSettings(roomB.agentId, { memoryBudgetTokens: TIGHT_BUDGET });

	const callsB: WorkerCall[] = [];
	const scriptsB: Record<string, Script> = {
		"RC-0001": () => reply("This session leaves one arrangement behind, said four ways it will be read.", [
			{ op: "add", topic: "Commercial terms", kind: "fact", text: foldText("FOLD-BUDGET-ONE") },
			{ op: "add", topic: "Commercial terms", kind: "fact", text: foldText("FOLD-BUDGET-TWO") },
			{ op: "add", topic: "Working style", kind: "practice", text: foldText("FOLD-BUDGET-THREE") },
			{ op: "add", topic: "Working style", kind: "practice", text: foldText("FOLD-BUDGET-FOUR") },
		]),
	};
	const startedB = startAbsorbRun({ agentId: roomB.agentId, assessmentMarkdown: ASSESSMENT, model: MODEL, generate: scriptedGenerate(scriptsB, callsB), now: RUN_CLOCK });
	let runB = await settle(roomB.agentId, startedB.runId, "the second room's run");
	assert(runB.state === "ready", `the second room's run should end ready, got "${runB.state}"${runB.error ? ` with "${runB.error}"` : ""}`);
	assert(runB.demotion.entries.length > 0, "the folds put this room over its budget, so the budget pass must name what it would archive, and it named nothing");
	assert(runB.demotion.overageTokens === 0, `while entries can still be taken the budget is reachable, so there is no overage yet, got ${runB.demotion.overageTokens}`);
	assert(runB.guidance === null, `a run nobody gave instructions to says so with null, so the card leaves the section out, got ${JSON.stringify(runB.guidance)}`);

	// --- 8. Keeping past what the budget allows is disclosed as an overage ---------
	let kept: string[] = [];
	for (let round = 0; round < 200 && runB.demotion.overageTokens === 0; round++) {
		assert(runB.demotion.entries.length > 0, `keeping everything the budget pass offers must end in an overage, and round ${round} left nothing to keep and no overage`);
		kept = [...new Set([...kept, ...runB.demotion.entries.map((entry) => entry.id)])];
		runB = keepAbsorbRunEntries(roomB.agentId, startedB.runId, kept);
	}
	assert(runB.demotion.overageTokens > 0, `keeping every entry the budget pass offered leaves the memory over its budget, and the run reports an overage of ${runB.demotion.overageTokens} tokens`);
	assert(runB.demotion.keepIds.length === kept.length, `the run holds on to every entry the user kept, got ${runB.demotion.keepIds.length} of ${kept.length}`);
	for (const id of kept) {
		const row = runB.demotion.entries.find((entry) => entry.id === id);
		assert(row?.kept === true && row.leaving === false, `an entry the user kept stays on the list, kept and no longer leaving, and ${id} reads ${JSON.stringify(row)}`);
	}
	// The last keep pushed what was left out in the kept notes' stead, and the
	// kept notes alone are over the limit: that is the overage, and the counts
	// say exactly that.
	assert(runB.demotion.counts.kept === kept.length && runB.demotion.counts.leaving === runB.demotion.entries.filter((row) => row.leaving).length && runB.demotion.counts.instead === runB.demotion.entries.filter((row) => row.leaving && row.instead).length, `the counts follow the rows, got ${JSON.stringify(runB.demotion.counts)}`);
	assert(runB.demotion.entries.filter((row) => row.leaving).every((row) => row.instead), "with everything the run offered kept, whatever still leaves does so in a kept note's stead");
	assert(runB.budget.overBudgetAfter === true, "a memory kept past its budget is disclosed as over it");

	// --- 8b. Editing a note the update added replaces the model's words before saving ---
	const addedChange = runB.sessions.flatMap((session) => session.changes ?? []).find((change) => change.kind === "added");
	assert(addedChange !== undefined, "the run added at least one note the card can offer to edit");
	const editedText = "Edited by hand on the card: the person's words win.";
	runB = editAbsorbRunEntry(roomB.agentId, startedB.runId, addedChange!.id, editedText);
	const editedChange = runB.sessions.flatMap((session) => session.changes ?? []).find((change) => change.id === addedChange!.id);
	assert(editedChange?.after === `- ${editedText}`, `the edited note keeps its bullet and carries the new words on the card, got ${JSON.stringify(editedChange?.after)}`);
	let threw = "";
	try { editAbsorbRunEntry(roomB.agentId, startedB.runId, "m-does-not-exist", "x"); } catch (e) { threw = (e as Error).message; }
	assert(/Only a note this update adds or rewrites/.test(threw), `a note this update did not write cannot be edited here, got ${JSON.stringify(threw)}`);
	threw = "";
	try { editAbsorbRunEntry(roomB.agentId, startedB.runId, addedChange!.id, "   "); } catch (e) { threw = (e as Error).message; }
	assert(/cannot be empty/.test(threw), `an empty edit is refused with the way out named, got ${JSON.stringify(threw)}`);

	// --- 9. Raising the limit recomputes the demotion on the run alone --------------
	const RAISED_BUDGET = 20_000;
	const listedBeforeRaise = runB.demotion.entries.length;
	runB = setAbsorbRunBudget(roomB.agentId, startedB.runId, RAISED_BUDGET);
	assert(runB.budget.budgetTokens === RAISED_BUDGET, `a raised budget is the budget the run works to, got ${runB.budget.budgetTokens}`);
	assert(runB.demotion.entries.length >= listedBeforeRaise && runB.demotion.counts.leaving === 0, `a raised limit the memory fits inside leaves nothing, and the rows stay listed, got ${JSON.stringify(runB.demotion.counts)} over ${runB.demotion.entries.length} rows`);
	assert(runB.demotion.overageTokens === 0, `a raised budget the memory fits inside leaves no overage, got ${runB.demotion.overageTokens}`);
	assert(runB.budget.overBudgetAfter === false, "a memory that fits inside the raised budget is not disclosed as over it");
	assert(runB.budget.savedBudgetTokens === TIGHT_BUDGET, `the room's saved limit rides on the run until Save, got ${JSON.stringify(runB.budget)}`);
	const settingsPath = path.join(root, roomB.agentId, "runtime", "maintenance-settings.json");
	assert(JSON.parse(fs.readFileSync(settingsPath, "utf-8")).memoryBudgetTokens === TIGHT_BUDGET && readPersistentRoomMaintenanceSettings(roomB.agentId).memoryBudgetTokens === TIGHT_BUDGET, "raising the limit on the card writes nothing to the room's settings before Save");

	// --- 9b. A save that fails after the raise puts the limit back ------------------
	const l1bBeforeFailedSave = fs.readFileSync(roomB.l1bPath, "utf-8");
	const turnB = beginTurn(roomB.agentId, "absorb_run_smoke_turn_b");
	let failed: any = null;
	try { approveAbsorbRun(roomB.agentId, startedB.runId, new Date(`${RUN_DAY}T09:02:30.000Z`)); } catch (error) { failed = error; }
	assert(failed instanceof Error, "a save during a turn in flight is refused");
	assert(failed.message.endsWith(" The budget stays at 10k."), `the refusal ends by saying where the budget is, got ${JSON.stringify(failed.message)}`);
	const busyRefusal = failed as Error & { code?: string; statusCode?: number };
	assert(busyRefusal.code === "memory_room_busy" && busyRefusal.statusCode === 400, `the refusal keeps its own code and status, got ${JSON.stringify({ code: busyRefusal.code, statusCode: busyRefusal.statusCode })}`);
	assert(readPersistentRoomMaintenanceSettings(roomB.agentId).memoryBudgetTokens === TIGHT_BUDGET, `a save that failed after the raise leaves the room the limit it had, got ${readPersistentRoomMaintenanceSettings(roomB.agentId).memoryBudgetTokens}`);
	runB = getAbsorbRun(roomB.agentId, startedB.runId);
	assert(runB.state === "ready" && runB.budget.savedBudgetTokens === TIGHT_BUDGET && runB.budget.budgetTokens === RAISED_BUDGET, `the run is ready again, still computed against the raised limit, with the room's limit back where it was, got ${JSON.stringify({ state: runB.state, budget: runB.budget })}`);
	assert(fs.readFileSync(roomB.l1bPath, "utf-8") === l1bBeforeFailedSave, "a save that failed wrote nothing");
	turnB.finish();
	// Cancelling the run leaves the room's limit as it was.
	const cancelledB = cancelAbsorbRun(roomB.agentId, startedB.runId, new Date(`${RUN_DAY}T09:03:00.000Z`));
	assert(cancelledB.state === "cancelled" && readPersistentRoomMaintenanceSettings(roomB.agentId).memoryBudgetTokens === TIGHT_BUDGET, `a cancelled run never writes the limit it was raised to, got ${JSON.stringify({ state: cancelledB.state, budget: readPersistentRoomMaintenanceSettings(roomB.agentId).memoryBudgetTokens })}`);

	resetAbsorbRunsForTests();

	// =====================================================================
	// Room three: cancelling a run in flight writes nothing.
	// =====================================================================
	const sessionsC = [
		fixtureSession("RC-0001", "2026-09-11", "A session that is still being folded", "The fold call for this one never comes back.", ["Something durable was said here."]),
		fixtureSession("RC-0002", "2026-09-12", "The session after it", "The one the run never reaches.", ["And something durable here too."]),
	];
	const roomC = createRoom("Absorb Run Cancel Smoke Room", (agentId) => memoryFixture({ agentId, fillerCount: 6, markedEntries: false, sessions: sessionsC }));
	const l1bBeforeC = fs.readFileSync(roomC.l1bPath, "utf-8");

	// --- 10. Cancel: the fold in flight is aborted and nothing is written ----------
	const callsC: WorkerCall[] = [];
	const blockingGenerate: AbsorbRunGenerate = (prompt, _model, options) => {
		callsC.push({ sessionId: sessionIdFromPrompt(prompt), attempt: 1, prompt });
		return new Promise<AbsorbGenerateResult>((_resolve, reject) => {
			options.signal.addEventListener("abort", () => reject(new Error(CANCELLED_SENTENCE)), { once: true });
		});
	};
	const startedC = startAbsorbRun({ agentId: roomC.agentId, assessmentMarkdown: ASSESSMENT, model: MODEL, generate: blockingGenerate, now: RUN_CLOCK });
	await waitUntil(() => callsC.length > 0, "the third room's run should reach its first fold call");
	const inFlight = getAbsorbRun(roomC.agentId, startedC.runId);
	assert(inFlight.state === "folding", `a run waiting on a fold call reads as folding, got "${inFlight.state}"`);
	assert(inFlight.progress.current?.id === "RC-0001", `a run discloses the session it is folding, got ${JSON.stringify(inFlight.progress.current)}`);

	const cancelled = cancelAbsorbRun(roomC.agentId, startedC.runId, new Date(`${RUN_DAY}T09:02:00.000Z`));
	assert(cancelled.state === "cancelled", `a cancelled run reads as cancelled straight away, got "${cancelled.state}"`);
	const settledC = await settle(roomC.agentId, startedC.runId, "the third room's cancelled run");
	assert(settledC.state === "cancelled", `a cancelled run stays cancelled once its fold call unwinds, got "${settledC.state}"`);
	assert(callsC.length === 1, `a cancelled run does not go on to the next session, and the worker was called ${callsC.length} times`);
	assert(settledC.candidate === null, "a cancelled run has no candidate to approve");
	assert(fs.readFileSync(roomC.l1bPath, "utf-8") === l1bBeforeC, "a cancelled run leaves the room's memory byte for byte as it was");
	assert(fs.readdirSync(path.join(root, roomC.agentId, "events", "absorb")).length === 0, "a cancelled run records no absorb event");
	assert(fs.readdirSync(path.join(root, roomC.agentId, "L1b", "archive")).filter((name) => name.endsWith(".md")).length === 0, "a cancelled run archives nothing");

	resetAbsorbRunsForTests();

	// =====================================================================
	// Room four: what a failed fold says on the card.
	// =====================================================================
	// A worker failure is the runtime's story, written for a log: a dropped
	// connection reads "memorize fold worker failed: terminated", which is what
	// reached a user's card in the field and told them nothing about their
	// memory. Each cause maps to one sentence about this session and what
	// becomes of it, and the provider's own words stay in the diagnostics. Every
	// one of these fails on both of its calls, so this room also pins what the
	// retry looks like from the outside when asking again does not help.
	const sessionsD = [
		fixtureSession("RC-0001", "2026-09-11", "The call that ran too long", "The fold call never came back inside its ceiling.", ["Something durable was said here."]),
		fixtureSession("RC-0002", "2026-09-11", "The call that dropped", "The connection to the provider went away mid-reply.", ["And something durable here too."]),
		fixtureSession("RC-0003", "2026-09-12", "The call that failed some other way", "The worker came back with nothing at all.", ["A third durable thing."]),
	];
	const roomD = createRoom("Absorb Run Failure Smoke Room", (agentId) => memoryFixture({ agentId, fillerCount: 6, markedEntries: false, sessions: sessionsD }));
	const l1bBeforeD = fs.readFileSync(roomD.l1bPath, "utf-8");
	const callsD: WorkerCall[] = [];
	const scriptsD: Record<string, Script> = {
		// The ceiling stops the turn: the runtime raises an aborted turn error.
		"RC-0001": () => { throw new IsolatedPersistentAgentWorkerTurnError("memorize fold worker", "aborted", WORKER_TIMEOUT_DETAIL); },
		// The provider's stream died: an error turn carrying the HTTP client's word.
		"RC-0002": () => { throw new IsolatedPersistentAgentWorkerTurnError("memorize fold worker", "error", DROPPED_CONNECTION_DETAIL); },
		// Anything else the call can throw.
		"RC-0003": () => { throw new Error(EMPTY_WORKER_SENTENCE); },
	};
	const startedD = startAbsorbRun({ agentId: roomD.agentId, assessmentMarkdown: ASSESSMENT, model: MODEL, generate: scriptedGenerate(scriptsD, callsD), now: RUN_CLOCK });
	const runD = await settle(roomD.agentId, startedD.runId, "the fourth room's run");
	assert(runD.state === "ready", `a run whose every fold failed still ends ready for approval, got "${runD.state}"${runD.error ? ` with "${runD.error}"` : ""}`);
	assert(runD.sessions.every((session) => session.outcome === "failed"), `all three folds failed, got ${JSON.stringify(runD.sessions.map((session) => session.outcome))}`);

	// --- 13. Each cause, its own sentence ------------------------------------------
	// A dropped connection and any other failure are asked again, and each of
	// those fails the same way on both calls, so it reads as the pair it was:
	// the cause, and that asking again did not help. A turn stopped at its
	// eight-minute ceiling is NOT asked again — the second ask would be another
	// eight minutes spent the same way — so it reads as the one call it cost.
	assert(sessionView(runD, "RC-0001").reason === ABSORB_FOLD_TIMED_OUT, `a turn stopped at its ceiling reads as the time limit, once, got "${sessionView(runD, "RC-0001").reason}"`);
	assert(sessionView(runD, "RC-0001").attempts === 1 && callsFor(callsD, "RC-0001").length === 1, `a turn stopped at its ceiling costs one call and is not asked again, got ${callsFor(callsD, "RC-0001").length} call(s) and ${sessionView(runD, "RC-0001").attempts} attempt(s)`);
	assert(callsFor(callsD, "RC-0002").length > 0, "and the run moves on to the next session");
	assert(sessionView(runD, "RC-0002").reason === ABSORB_FOLD_CONNECTION_LOST_TWICE, `a connection that dropped twice reads as the connection, got "${sessionView(runD, "RC-0002").reason}"`);
	assert(sessionView(runD, "RC-0003").reason === ABSORB_FOLD_WORKER_FAILED_TWICE, `any other failure still says what became of the session, got "${sessionView(runD, "RC-0003").reason}"`);
	assert(runD.sessions.filter((session) => session.id !== "RC-0001").every((session) => session.attempts === 2), `the other two were asked twice, got ${JSON.stringify(runD.sessions.map((session) => session.attempts))}`);
	const reasonsD = runD.sessions.map((session) => session.reason ?? "");
	assert(reasonsD.every((reason) => /^[A-Z]/.test(reason) && /\.$/.test(reason) && !/worker|terminated|abort|480|stack/i.test(reason)), `every reason is a sentence about the memory, not the runtime's own: ${JSON.stringify(reasonsD)}`);
	assert(new Set(reasonsD).size === 3, `three causes read as three sentences, got ${JSON.stringify(reasonsD)}`);
	for (const detail of [DROPPED_CONNECTION_DETAIL, WORKER_TIMEOUT_DETAIL, EMPTY_WORKER_SENTENCE]) {
		assert(!JSON.stringify(runD).includes(detail), `the raw failure "${detail}" reaches nothing the client reads`);
	}
	assert(fs.readFileSync(roomD.l1bPath, "utf-8") === l1bBeforeD, "a run whose every fold failed writes nothing");

	// --- 14. The raw message survives where it is meant to: the diagnostics ---------
	const diagnosticsDir = path.join(root, roomD.agentId, "events", "maintenance-diagnostics");
	const records = fs.readdirSync(diagnosticsDir).filter((name) => name.endsWith(".json")).map((name) => JSON.parse(fs.readFileSync(path.join(diagnosticsDir, name), "utf-8")));
	assert(records.length === 5, `each failed fold call writes its own diagnostics record: one for the timeout and two each for the two sessions asked twice, got ${records.length}`);
	assert(records.filter((record) => record.outcome === "retried").length === 2, `the call that was asked again is marked as retried, and the timeout is not, got ${JSON.stringify(records.map((record) => record.outcome))}`);
	assert(records.filter((record) => record.outcome === "error").length === 3, `the call that ended it keeps the failure outcome, got ${JSON.stringify(records.map((record) => record.outcome))}`);
	assert(records.filter((record) => record.attempt === 2).length === 2, `a retried call is recorded as the second attempt, got ${JSON.stringify(records.map((record) => record.attempt))}`);
	assert(records.filter((record) => record.errorClass === "IsolatedPersistentAgentWorkerTurnError").length === 3, `a typed turn failure is recorded as what it was, got ${JSON.stringify(records.map((record) => record.errorClass))}`);
	assert(records.some((record) => String(record.errorSentence ?? "").includes(DROPPED_CONNECTION_DETAIL)), `the provider's own words are kept for the report, and no record carries "${DROPPED_CONNECTION_DETAIL}": ${JSON.stringify(records.map((record) => record.errorSentence))}`);
	assert(records.some((record) => String(record.errorSentence ?? "").includes(WORKER_TIMEOUT_DETAIL)), `the ceiling's own words are kept too, got ${JSON.stringify(records.map((record) => record.errorSentence))}`);
	assert(records.every((record) => !JSON.stringify(record).includes("FOLD-")), "a diagnostics record still carries nothing of the room's own memory");

	resetAbsorbRunsForTests();

	// =====================================================================
	// Room five: an abandoned run must never hold the room.
	// =====================================================================
	// The field failure this pins: a user closes the tab on a ready card, comes
	// back and asks to Memorize again, and the room answers "already updating its
	// memory" — forever, because the run nobody is going to approve was still
	// counted as active and nothing ever reaped it. A run holds the room only
	// while it is DOING something; a run waiting on a person is replaced by the
	// next propose, and an untouched one is reaped on the retention window.
	const sessionsE = [
		fixtureSession("RC-0001", "2026-09-11", "One session to fold", "One durable thing was said.", ["Something durable was said here."]),
	];
	const roomE = createRoom("Absorb Run Replace Smoke Room", (agentId) => memoryFixture({ agentId, fillerCount: 6, markedEntries: false, sessions: sessionsE }));
	const scriptsE: Record<string, Script> = {
		"RC-0001": () => reply("One durable line comes out of this session.", [
			{ op: "add", topic: "Commercial terms", kind: "fact", text: foldText("FOLD-REPLACE-ONE") },
		]),
	};

	// --- 15. A ready run is replaced by the next propose, not defended by it ------
	const firstE = startAbsorbRun({ agentId: roomE.agentId, assessmentMarkdown: ASSESSMENT, model: MODEL, generate: scriptedGenerate(scriptsE, []), now: RUN_CLOCK });
	const readyE = await settle(roomE.agentId, firstE.runId, "the fifth room's first run");
	assert(readyE.state === "ready", `the fifth room's first run should end ready, got "${readyE.state}"${readyE.error ? ` with "${readyE.error}"` : ""}`);
	const secondE = startAbsorbRun({ agentId: roomE.agentId, assessmentMarkdown: ASSESSMENT, model: MODEL, generate: scriptedGenerate(scriptsE, []), now: RUN_CLOCK });
	assert(secondE.runId !== firstE.runId, "a second Memorize over a ready run starts a run of its own, and it reused the first one's id");
	expectThrows(() => getAbsorbRun(roomE.agentId, firstE.runId), /no longer open/i, "reading the run the new propose replaced");
	const readySecondE = await settle(roomE.agentId, secondE.runId, "the fifth room's second run");
	assert(readySecondE.state === "ready", `the replacing run runs like any other, got "${readySecondE.state}"${readySecondE.error ? ` with "${readySecondE.error}"` : ""}`);

	// --- 16. An untouched ready run is reaped on the retention window -------------
	rewindAbsorbRunClockForTests(roomE.agentId, ABSORB_RUN_RETENTION_MS + 60_000);
	expectThrows(() => getAbsorbRun(roomE.agentId, secondE.runId), /no longer open/i, "reading a ready run nobody touched for longer than the retention window");
	const afterExpiryE = startAbsorbRun({ agentId: roomE.agentId, assessmentMarkdown: ASSESSMENT, model: MODEL, generate: scriptedGenerate(scriptsE, []), now: RUN_CLOCK });
	assert(WORKING_STATES.has(afterExpiryE.state), `a room whose ready run expired can Memorize again, got "${afterExpiryE.state}"`);
	await settle(roomE.agentId, afterExpiryE.runId, "the fifth room's third run");

	resetAbsorbRunsForTests();

	// =====================================================================
	// Room six: a run that IS working still holds the room, and says which.
	// =====================================================================
	const roomF = createRoom("Absorb Run Busy Smoke Room", (agentId) => memoryFixture({ agentId, fillerCount: 6, markedEntries: false, sessions: sessionsE }));
	const callsF: WorkerCall[] = [];
	const blockingGenerateF: AbsorbRunGenerate = (prompt, _model, options) => {
		callsF.push({ sessionId: sessionIdFromPrompt(prompt), attempt: 1, prompt });
		return new Promise<AbsorbGenerateResult>((_resolve, reject) => {
			options.signal.addEventListener("abort", () => reject(new Error(CANCELLED_SENTENCE)), { once: true });
		});
	};
	const foldingF = startAbsorbRun({ agentId: roomF.agentId, assessmentMarkdown: ASSESSMENT, model: MODEL, generate: blockingGenerateF, now: RUN_CLOCK });
	await waitUntil(() => callsF.length > 0, "the sixth room's run should reach its first fold call");

	// --- 17. The refusal names the run in the way, so the client can offer to cancel it ---
	let refusal: any = null;
	try {
		startAbsorbRun({ agentId: roomF.agentId, assessmentMarkdown: ASSESSMENT, model: MODEL, generate: blockingGenerateF, now: RUN_CLOCK });
	} catch (error) {
		refusal = error;
	}
	assert(refusal, "a second Memorize while a fold is in flight is refused, and this one was not");
	assert(refusal.statusCode === 409 && refusal.code === "absorb_run_active", `the refusal is the 409 the client branches on, got ${JSON.stringify({ statusCode: refusal.statusCode, code: refusal.code })}`);
	assert(refusal.details?.runId === foldingF.runId, `the refusal names the run that is in the way, got ${JSON.stringify(refusal.details)}`);
	assert(callsF.length === 1, `a refused propose starts nothing, and the worker was called ${callsF.length} times`);

	// --- 18. Cancelling it hands the room straight back ---------------------------
	cancelAbsorbRun(roomF.agentId, foldingF.runId, new Date(`${RUN_DAY}T09:02:00.000Z`));
	await settle(roomF.agentId, foldingF.runId, "the sixth room's cancelled run");
	const afterCancelF = startAbsorbRun({ agentId: roomF.agentId, assessmentMarkdown: ASSESSMENT, model: MODEL, generate: scriptedGenerate(scriptsE, []), now: RUN_CLOCK });
	assert(afterCancelF.runId !== foldingF.runId, "a cancelled run is replaced by the next propose, and it reused the cancelled run's id");
	const readyF = await settle(roomF.agentId, afterCancelF.runId, "the sixth room's replacing run");
	assert(readyF.state === "ready", `the run that replaced a cancelled one runs like any other, got "${readyF.state}"${readyF.error ? ` with "${readyF.error}"` : ""}`);

	resetAbsorbRunsForTests();

	// =====================================================================
	// Room seven: a room that has never had entry ids. Propose writes NOTHING.
	// =====================================================================
	// The field failure this pins: on a room whose memory had no entry ids,
	// starting a proposal migrated the file on the spot — two thousand metadata
	// comments and a fresh "Last edit at" line — while every screen in the flow
	// promised "Nothing is saved". Cancelling then left a rewritten memory
	// behind. The migration now rides on the run and is performed by the approval
	// write, which is the run's one write either way.
	const sessionsG = [
		fixtureSession("RC-0001", "2026-09-11", "One session on an unmigrated room", "One durable thing was said.", ["Something durable was said here."]),
	];
	const roomG = createRoom("Absorb Run Migration Smoke Room", (agentId) => v1MemoryFixture({ agentId, sessions: sessionsG }));
	const l1bBeforeG = fs.readFileSync(roomG.l1bPath, "utf-8");
	const archiveDirG = path.join(root, roomG.agentId, "L1b", "archive");
	const absorbEventsDirG = path.join(root, roomG.agentId, "events", "absorb");
	const editEventsDirG = path.join(root, roomG.agentId, "events", "memory-edit");
	const snapshotsG = (): string[] => (fs.existsSync(archiveDirG) ? fs.readdirSync(archiveDirG).filter((name) => name.endsWith(".md") && name.includes("-before-")) : []);
	const eventsInG = (dir: string): string[] => (fs.existsSync(dir) ? fs.readdirSync(dir).filter((name) => name.endsWith(".json")) : []);
	const scriptsG: Record<string, Script> = {
		"RC-0001": () => reply("One durable line comes out of this session.", [
			{ op: "add", topic: "Commercial terms", kind: "fact", text: foldText("FOLD-MIGRATED-ADD") },
		]),
	};

	// --- 19. Propose migrates in memory only, and says so as a note ---------------
	const cancelledG = startAbsorbRun({ agentId: roomG.agentId, assessmentMarkdown: ASSESSMENT, model: MODEL, generate: scriptedGenerate(scriptsG, []), now: RUN_CLOCK });
	const readyG = await settle(roomG.agentId, cancelledG.runId, "the seventh room's first run");
	assert(readyG.state === "ready", `the seventh room's run should end ready, got "${readyG.state}"${readyG.error ? ` with "${readyG.error}"` : ""}`);
	assert(readyG.migration?.pending === true, `a run on a room with no entry ids carries the migration it owes, got ${JSON.stringify(readyG.migration)}`);
	assert(readyG.migration?.entriesAssigned === V1_FIXTURE_BULLETS, `the note says how many entries the migration would give an id, got ${JSON.stringify(readyG.migration)}`);
	assert(!readyG.warnings.some((warning) => /entry ids/i.test(warning)), `the migration is a note, not a warning that would block the automatic path, got ${JSON.stringify(readyG.warnings)}`);
	assert(fs.readFileSync(roomG.l1bPath, "utf-8") === l1bBeforeG, "a proposal on an unmigrated room writes nothing at all: the memory file must be byte for byte as it was");
	assert(snapshotsG().length === 0 && eventsInG(editEventsDirG).length === 0, `a proposal takes no snapshot and records no edit, got ${JSON.stringify({ snapshots: snapshotsG(), edits: eventsInG(editEventsDirG) })}`);

	// --- 20. And cancelling leaves that file untouched -----------------------------
	const cancelG = cancelAbsorbRun(roomG.agentId, cancelledG.runId, new Date(`${RUN_DAY}T09:02:00.000Z`));
	assert(cancelG.state === "cancelled", `the seventh room's run should cancel, got "${cancelG.state}"`);
	assert(fs.readFileSync(roomG.l1bPath, "utf-8") === l1bBeforeG, "a cancelled proposal leaves an unmigrated memory byte for byte as it was");
	assert(snapshotsG().length === 0 && eventsInG(editEventsDirG).length === 0 && eventsInG(absorbEventsDirG).length === 0, "a cancelled proposal leaves no snapshot and no record behind");

	// --- 21. Approve performs the migration and the fold in ONE write --------------
	const approveG = startAbsorbRun({ agentId: roomG.agentId, assessmentMarkdown: ASSESSMENT, model: MODEL, generate: scriptedGenerate(scriptsG, []), now: RUN_CLOCK });
	const readyApproveG = await settle(roomG.agentId, approveG.runId, "the seventh room's second run");
	assert(readyApproveG.migration?.pending === true, `the replacing run owes the same migration, got ${JSON.stringify(readyApproveG.migration)}`);
	const approvalG = approveAbsorbRun(roomG.agentId, approveG.runId, APPROVED_AT);
	const writtenG = fs.readFileSync(roomG.l1bPath, "utf-8");
	assert(writtenG.includes("<!-- entries: next="), "the approval write is the migration: the written memory carries the id counter");
	assert((writtenG.match(/<!-- e: id=m-\d{4}/g) ?? []).length === V1_FIXTURE_BULLETS + 1, `every entry that existed plus the one this fold added carries an id, got ${JSON.stringify(writtenG.match(/<!-- e: id=m-\d{4}/g))}`);
	assert(writtenG.includes("FOLD-MIGRATED-ADD"), "the same write carries what the fold added");
	assert(!/^###\s+RC-0001\s*\|/m.test(writtenG), "the folded session left Recent Context in that same write");
	assert(snapshotsG().length === 1, `the migration and the fold are ONE write, so there is one snapshot, got ${JSON.stringify(snapshotsG())}`);
	assert(fs.readFileSync(path.join(archiveDirG, snapshotsG()[0]), "utf-8") === l1bBeforeG, "the snapshot is the file as it was BEFORE the migration, which is what a rollback needs");
	assert(eventsInG(absorbEventsDirG).length === 1 && eventsInG(editEventsDirG).length === 0, `one write is one record, and it is the run's own, got ${JSON.stringify({ absorb: eventsInG(absorbEventsDirG), edits: eventsInG(editEventsDirG) })}`);
	const recordG = JSON.parse(fs.readFileSync(path.join(absorbEventsDirG, `${approvalG.absorbId}.json`), "utf-8"));
	assert(recordG.run?.migration?.entriesAssigned === V1_FIXTURE_BULLETS, `the record says the write also gave the memory its ids, got ${JSON.stringify(recordG.run?.migration)}`);
	assert(getAbsorbRun(roomG.agentId, approveG.runId).migration?.pending === false, "once the write has landed the migration is no longer owed");

	resetAbsorbRunsForTests();

	// =====================================================================
	// Room eight: a call that never came back is asked once more.
	// =====================================================================
	// A fold call that throws has said nothing about the conversation it was
	// given: the line was bad, a sign-in had expired, the provider had a
	// moment. Spending that conversation's one chance on it — which is what
	// the field saw — is the failure this room pins shut. THE RULE: two calls
	// per conversation, the first and one retry of a reply the memory refused;
	// a call that never came back buys ONE more on top of that, once per
	// conversation, with the same prompt, after a pause. Three calls in all,
	// and never more. The one exception is a turn stopped at its eight-minute
	// ceiling: it is not asked again, because the second ask would be another
	// eight minutes, and the conversation waits for next time after one call.
	const sessionsH = [
		fixtureSession("RC-0001", "2026-09-11", "The call that dropped once", "The first call never came back; the second one did.", ["Something durable was said here."]),
		fixtureSession("RC-0002", "2026-09-11", "The call that was stopped", "The call ran past its ceiling, and there is no second one.", ["A second durable thing."]),
		fixtureSession("RC-0003", "2026-09-11", "The call that failed both times", "Neither call came back.", ["A third durable thing."]),
		fixtureSession("RC-0004", "2026-09-11", "The reply that was cut", "The reply did come back, cut at the output limit.", ["A fourth durable thing."]),
		fixtureSession("RC-0005", "2026-09-12", "Refused, then dropped, then answered", "It took every call it is allowed.", ["A fifth durable thing."]),
		fixtureSession("RC-0006", "2026-09-12", "Dropped, then refused twice", "Every call it is allowed, and still nothing to fold.", ["A sixth durable thing."]),
		fixtureSession("RC-0007", "2026-09-12", "Stopped, with a dropped call scripted after it", "The ceiling stops it, and the second call is never made.", ["A seventh durable thing."]),
	];
	const roomH = createRoom("Absorb Run Retry Smoke Room", (agentId) => memoryFixture({ agentId, fillerCount: 6, markedEntries: false, sessions: sessionsH }));
	const callsH: WorkerCall[] = [];
	const answer = (marker: string): AbsorbGenerateResult => reply("One durable line comes out of this conversation.", [
		{ op: "add", topic: "Commercial terms", kind: "fact", text: foldText(marker) },
	]);
	/** A complete reply with no operations block at all: the memory refuses it. */
	const unreadable = (): AbsorbGenerateResult => ({ text: "I have folded this conversation into memory and saved it for you.", usage: { input: 2400, output: 40, totalTokens: 2440 } });
	const dropped = () => { throw new IsolatedPersistentAgentWorkerTurnError("memorize fold worker", "error", DROPPED_CONNECTION_DETAIL); };
	const stopped = () => { throw new IsolatedPersistentAgentWorkerTurnError("memorize fold worker", "aborted", WORKER_TIMEOUT_DETAIL); };
	const scriptsH: Record<string, Script> = {
		"RC-0001": ({ attempt }) => (attempt === 1 ? dropped() : answer("FOLD-RETRY-DROPPED")),
		"RC-0002": ({ attempt }) => (attempt === 1 ? stopped() : answer("FOLD-RETRY-STOPPED")),
		"RC-0003": () => { throw new Error(EMPTY_WORKER_SENTENCE); },
		"RC-0004": () => ({
			text: 'This conversation leaves one durable line behind.\n\n```json\n{\n  "ops": [\n    { "op": "add",',
			truncated: true,
			usage: { input: 2400, output: 8192, totalTokens: 10_592 },
			modelMaxOutputTokens: 8192,
		}),
		"RC-0005": ({ attempt }) => (attempt === 1 ? unreadable() : attempt === 2 ? dropped() : answer("FOLD-RETRY-THIRD-CALL")),
		"RC-0006": ({ attempt }) => (attempt === 1 ? dropped() : unreadable()),
		"RC-0007": ({ attempt }) => (attempt === 1 ? stopped() : dropped()),
	};
	const startedH = startAbsorbRun({ agentId: roomH.agentId, assessmentMarkdown: ASSESSMENT, model: MODEL, generate: scriptedGenerate(scriptsH, callsH), now: RUN_CLOCK });
	const runH = await settle(roomH.agentId, startedH.runId, "the eighth room's run");
	assert(runH.state === "ready", `a run that retried half its folds still ends ready for approval, got "${runH.state}"${runH.error ? ` with "${runH.error}"` : ""}`);

	// --- 22. A call that never came back is asked again, with the same prompt -----
	const rh1 = sessionView(runH, "RC-0001");
	assert(rh1.outcome === "folded", `a dropped call that lands on the second ask costs the conversation nothing, got "${rh1.outcome}"${rh1.reason ? ` because "${rh1.reason}"` : ""}`);
	assert(rh1.attempts === 2, `both calls are counted, got ${rh1.attempts}`);
	const rh1Calls = callsFor(callsH, "RC-0001");
	assert(rh1Calls.length === 2, `a dropped call is asked exactly once more, got ${rh1Calls.length} call(s)`);
	assert(rh1Calls[0].prompt === rh1Calls[1].prompt, "a call that never came back is asked AGAIN, not asked differently: the retry carries the same prompt");
	assert(!rh1Calls[1].prompt.includes("## Retry Notice"), "there is nothing to put in a Retry Notice when the first call never answered, and this retry carries one");
	assert(rh1.summary?.added === 1, `the second call's operations are the ones that land, got ${JSON.stringify(rh1.summary)}`);

	// --- 23. A turn stopped at its ceiling is NOT asked again ---------------------
	const rh2 = sessionView(runH, "RC-0002");
	assert(rh2.outcome === "failed" && rh2.reason === ABSORB_FOLD_TIMED_OUT && rh2.attempts === 1, `a turn stopped at its ceiling waits for next time after one call, got "${rh2.outcome}" / "${rh2.reason}" after ${rh2.attempts} attempt(s)`);
	assert(callsFor(callsH, "RC-0002").length === 1, `and is not asked again, got ${callsFor(callsH, "RC-0002").length} call(s)`);
	assert(callsFor(callsH, "RC-0003").length > 0, "and the run moves on to the next conversation");

	// --- 24. Both calls failing reads as both calls failing -----------------------
	const rh3 = sessionView(runH, "RC-0003");
	assert(rh3.outcome === "failed" && rh3.reason === ABSORB_FOLD_WORKER_FAILED_TWICE, `a conversation whose two calls both failed says so once, got "${rh3.outcome}" / "${rh3.reason}"`);
	assert(callsFor(callsH, "RC-0003").length === 2, `and stops at two, got ${callsFor(callsH, "RC-0003").length} call(s)`);
	const rh7 = sessionView(runH, "RC-0007");
	assert(rh7.reason === ABSORB_FOLD_TIMED_OUT && callsFor(callsH, "RC-0007").length === 1, `a turn stopped at its ceiling is not asked again whatever would have followed, got "${rh7.reason}" after ${callsFor(callsH, "RC-0007").length} call(s)`);

	// --- 25. A reply that came back cut is not asked again ------------------------
	// The model answered; it answered too much. Asking the same question again
	// would cut it in the same place, so it costs one call and one conversation.
	const rh4 = sessionView(runH, "RC-0004");
	assert(rh4.outcome === "failed" && /output limit/.test(rh4.reason ?? ""), `a cut reply still reads as the output limit, got "${rh4.outcome}" / "${rh4.reason}"`);
	assert(rh4.attempts === 1 && callsFor(callsH, "RC-0004").length === 1, `a cut reply is not asked again, got ${callsFor(callsH, "RC-0004").length} call(s)`);

	// --- 26. Three calls is the ceiling, whichever order the failures come in -----
	const rh5 = sessionView(runH, "RC-0005");
	assert(rh5.outcome === "folded" && rh5.attempts === 3, `refused, then dropped, then answered: the third call is allowed and it lands, got "${rh5.outcome}" after ${rh5.attempts} attempt(s)`);
	const rh5Calls = callsFor(callsH, "RC-0005");
	assert(rh5Calls.length === 3, `and it costs exactly three calls, got ${rh5Calls.length}`);
	assert(!rh5Calls[0].prompt.includes("## Retry Notice") && rh5Calls[1].prompt.includes("## Retry Notice"), "the call after a refusal carries the Retry Notice");
	assert(rh5Calls[2].prompt === rh5Calls[1].prompt, "the call after a dropped one repeats that same prompt, Retry Notice and all");
	assert((rh5Calls[2].prompt.match(/## Retry Notice/g) ?? []).length === 1, "and never stacks two Retry Notices");
	const rh6 = sessionView(runH, "RC-0006");
	assert(rh6.outcome === "failed" && rh6.reason === ABSORB_FOLD_REFUSED_TWICE, `dropped once and refused twice ends on what the memory could not accept, got "${rh6.outcome}" / "${rh6.reason}"`);
	assert(rh6.attempts === 3 && callsFor(callsH, "RC-0006").length === 3, `and stops at three calls, got ${callsFor(callsH, "RC-0006").length}`);
	assert(callsH.every((call) => callsFor(callsH, call.sessionId).length <= 3), `no conversation is ever asked more than three times, got ${JSON.stringify(runH.sessions.map((session) => [session.id, callsFor(callsH, session.id).length]))}`);

	// --- 27. The record of the call that was retried says so ----------------------
	const diagnosticsH = path.join(root, roomH.agentId, "events", "maintenance-diagnostics");
	const recordsH = fs.readdirSync(diagnosticsH).filter((name) => name.endsWith(".json")).map((name) => JSON.parse(fs.readFileSync(path.join(diagnosticsH, name), "utf-8")));
	assert(recordsH.length === callsH.length, `one record per call made, got ${recordsH.length} records for ${callsH.length} calls`);
	const outcomesH = recordsH.map((record) => record.outcome).sort();
	assert(outcomesH.filter((outcome) => outcome === "retried").length === 4, `each of the four calls that never came back and was asked again is annotated as retried, and the two timeouts are not, got ${JSON.stringify(outcomesH)}`);
	assert(outcomesH.filter((outcome) => outcome === "error").length === 3, `the call that ended a conversation keeps the failure outcome, the two timeouts among them, got ${JSON.stringify(outcomesH)}`);
	assert(recordsH.filter((record) => record.outcome === "retried").every((record) => record.errorClass), `a retried record still carries the class of the failure that caused it, got ${JSON.stringify(recordsH.filter((record) => record.outcome === "retried").map((record) => record.errorClass))}`);
	assert(recordsH.every((record) => !JSON.stringify(record).includes("FOLD-")), "a diagnostics record still carries nothing of the room's own memory");

	resetAbsorbRunsForTests();

	// =====================================================================
	// Room nine: cancelling between the two calls stops at the first.
	// =====================================================================
	// The retry waits before it asks again. A person who cancels in that gap
	// must not be made to wait it out, and must not be charged a second call:
	// the conversation goes back to waiting, exactly as it does when a fold in
	// flight is cancelled.
	setAbsorbFoldRetryPauseForTests(ABSORB_FOLD_RETRY_PAUSE_MS);
	const roomI = createRoom("Absorb Run Retry Cancel Smoke Room", (agentId) => memoryFixture({ agentId, fillerCount: 6, markedEntries: false, sessions: sessionsE }));
	const l1bBeforeI = fs.readFileSync(roomI.l1bPath, "utf-8");
	const callsI: WorkerCall[] = [];
	const startedI = startAbsorbRun({
		agentId: roomI.agentId,
		assessmentMarkdown: ASSESSMENT,
		model: MODEL,
		generate: scriptedGenerate({ "RC-0001": () => dropped() }, callsI),
		now: RUN_CLOCK,
	});
	await waitUntil(() => callsI.length > 0, "the ninth room's run should reach its first fold call");

	// --- 28. Cancelled in the gap: no second call, and the conversation waits -----
	const cancelledI = cancelAbsorbRun(roomI.agentId, startedI.runId, new Date(`${RUN_DAY}T09:02:00.000Z`));
	assert(cancelledI.state === "cancelled", `a run cancelled while it waits to ask again cancels at once, got "${cancelledI.state}"`);
	const settledI = await settle(roomI.agentId, startedI.runId, "the ninth room's cancelled run");
	assert(settledI.state === "cancelled", `and stays cancelled, got "${settledI.state}"`);
	// The cancel lands at once; the fold that was waiting to ask again gives the
	// wait up rather than sitting it out, which is what this waits to see.
	await waitUntil(() => sessionView(getAbsorbRun(roomI.agentId, startedI.runId), "RC-0001").outcome !== "folding", "the ninth room's fold should give up its wait as soon as the run is cancelled");
	const unwoundI = getAbsorbRun(roomI.agentId, startedI.runId);
	assert(callsI.length === 1, `a cancelled run never makes the retry call, and the worker was called ${callsI.length} times`);
	assert(sessionView(unwoundI, "RC-0001").outcome === "pending", `a conversation whose retry was cancelled goes back to waiting, not to failed, got "${sessionView(unwoundI, "RC-0001").outcome}"`);
	assert(!sessionView(unwoundI, "RC-0001").reason, `and carries no failure reason, got "${sessionView(unwoundI, "RC-0001").reason}"`);
	assert(fs.readFileSync(roomI.l1bPath, "utf-8") === l1bBeforeI, "a run cancelled between two calls leaves the room's memory byte for byte as it was");
	setAbsorbFoldRetryPauseForTests(0);

	// =====================================================================
	// Room ten: a conversation folded late is weighed by its date.
	// =====================================================================
	// The field failure this pins: a conversation from the 3rd fails its fold,
	// a conversation from the 8th folds and rewrites the price, and the next
	// update folds the 3rd — which used to be told it was "newer than
	// everything already in memory" and could roll the 8th's price back. What
	// the model does with that cannot be asserted here; the material can: the
	// late fold's prompt names the day the conversation is from, and every
	// entry's address carries the day it was saved and the day a fold last
	// rewrote it, so the 45k note reads as newer than the conversation.
	const PRICE_45K = "FOLD-PRICE-45K";
	const sessionsJ = [
		fixtureSession("RC-0007", "2026-09-03", "The older pricing chat", "The price was discussed at the old number.", ["The volume price is 40k, as it has been."]),
		fixtureSession("RC-0009", "2026-09-08", "The newer pricing chat", "The price moved.", ["The volume price is now 45k."]),
	];
	const roomJ = createRoom("Absorb Run Dates Smoke Room", (agentId) => memoryFixture({ agentId, fillerCount: 6, markedEntries: true, sessions: sessionsJ }));
	const callsJ1: WorkerCall[] = [];
	const scriptsJ1: Record<string, Script> = {
		"RC-0007": () => { throw new Error(EMPTY_WORKER_SENTENCE); },
		"RC-0009": ({ areas }) => reply("The price moved to 45k.", [{ op: "supersede", id: addressOf(areas, SUPERSEDE_TARGET), text: foldText(PRICE_45K) }]),
	};
	const startedJ1 = startAbsorbRun({ agentId: roomJ.agentId, assessmentMarkdown: ASSESSMENT, model: MODEL, generate: scriptedGenerate(scriptsJ1, callsJ1), now: RUN_CLOCK });
	const runJ1 = await settle(roomJ.agentId, startedJ1.runId, "the tenth room's first run");
	assert(runJ1.state === "ready" && sessionView(runJ1, "RC-0007").outcome === "failed" && sessionView(runJ1, "RC-0009").outcome === "folded", `the older conversation fails and the newer one folds, got ${JSON.stringify(runJ1.sessions.map((session) => [session.id, session.outcome]))}`);

	// --- 29. Every fold prompt carries the conversation's date and the entries' dates ---
	const firstJ = callsFor(callsJ1, "RC-0007")[0].prompt;
	assert(firstJ.includes("This conversation is from 2026-09-03: it is newer than every entry saved or updated before that day, and older than every entry saved or updated after it."), "the task names the day the conversation is from, read off its own heading");
	assert(callsFor(callsJ1, "RC-0009")[0].prompt.includes("This conversation is from 2026-09-08:"), "each conversation's prompt names that conversation's day");
	const priceIdJ = addressOf(areasFromPrompt(firstJ), SUPERSEDE_TARGET);
	assert(firstJ.includes(`[${priceIdJ} · saved 2026-09-01 · updated 2026-09-11] ${SUPERSEDE_TARGET}`), `an entry's address carries the saved and updated dates the file holds, and the prompt reads ${JSON.stringify(/\[m-0102[^\]]*\]/.exec(firstJ)?.[0])}`);
	assert(areasFromPrompt(firstJ).every((row) => row.saved), "every entry of the memory carries a saved date in its address");
	assert(!firstJ.includes("this session is newer than everything already in memory"), "the rule that the session is newer than everything is gone from the constitution");
	approveAbsorbRun(roomJ.agentId, startedJ1.runId, APPROVED_AT);
	const writtenJ1 = fs.readFileSync(roomJ.l1bPath, "utf-8");
	assert(/^###\s+RC-0007\s*\|/m.test(writtenJ1) && !/^###\s+RC-0009\s*\|/m.test(writtenJ1) && writtenJ1.includes(PRICE_45K), "the older conversation waits for next time, and the newer one's price is in memory");
	resetAbsorbRunsForTests();

	// --- 30. The next update folds the older conversation against the dated memory ---
	const callsJ2: WorkerCall[] = [];
	const scriptsJ2: Record<string, Script> = {
		"RC-0007": () => reply("Memory already holds a newer price than this conversation names.", [{ op: "drop", reason: "The price this conversation names was replaced by a later one that memory already holds." }]),
	};
	const startedJ2 = startAbsorbRun({ agentId: roomJ.agentId, assessmentMarkdown: ASSESSMENT, model: MODEL, generate: scriptedGenerate(scriptsJ2, callsJ2), now: RUN_CLOCK });
	const runJ2 = await settle(roomJ.agentId, startedJ2.runId, "the tenth room's second run");
	assert(runJ2.state === "ready" && sessionView(runJ2, "RC-0007").outcome === "dropped", `the late fold is the only one, got ${JSON.stringify(runJ2.sessions.map((session) => [session.id, session.outcome]))}`);
	const lateJ = callsFor(callsJ2, "RC-0007")[0].prompt;
	assert(lateJ.includes("This conversation is from 2026-09-03:"), "the late fold's prompt names the day the conversation is from");
	const priceRowJ = areasFromPrompt(lateJ).find((row) => row.firstLine.includes(PRICE_45K));
	assert(priceRowJ?.id === priceIdJ && priceRowJ.saved === "2026-09-01" && priceRowJ.updated === RUN_DAY, `the 45k note keeps its id and its saved date and carries the day the newer conversation's fold rewrote it, got ${JSON.stringify(priceRowJ)}`);
	assert(lateJ.includes(`[${priceIdJ} · saved 2026-09-01 · updated ${RUN_DAY}] ${PRICE_45K}`), `the address reads as one line, got ${JSON.stringify(/\[m-0102[^\]]*\]/.exec(lateJ)?.[0])}`);
	assert(!lateJ.includes(SUPERSEDE_TARGET), "the older text is gone from the memory the late fold reads");
	assert(lateJ.includes("An entry saved or updated AFTER this session's date already knows more than this session does: never supersede or update it with this session's older information."), "the constitution tells the late fold not to roll a newer entry back");
	resetAbsorbRunsForTests();

	// =====================================================================
	// Room eleven: a Remember while the update is open does not stale the save.
	// =====================================================================
	// Remember stays allowed while an update is open, so a room with a backlog
	// is never locked out of saving the conversation it is in — and the save
	// used to refuse "stale" for exactly that, because the file was no longer
	// the one the run read. The save is rebased instead: the run's Deep Memory
	// and Active Items, the file's Recent Context less what the run folded,
	// the file's Chronos. The Remember here is the product's own checkpoint
	// write, so the block it appends is the real shape.
	const MEANWHILE = "FOLD-REMEMBERED-MEANWHILE";
	const roomK = createRoom("Absorb Run Rebase Smoke Room", (agentId) => memoryFixture({ agentId, fillerCount: 6, markedEntries: false, sessions: sessionsE }));
	const scriptsK: Record<string, Script> = {
		"RC-0001": () => reply("One durable line.", [{ op: "add", topic: "Commercial terms", kind: "fact", text: foldText("FOLD-REBASE-ADD") }]),
		"RC-0002": () => reply("One more.", [{ op: "add", topic: "Commercial terms", kind: "fact", text: foldText("FOLD-REBASE-SECOND") }]),
		"RC-0003": () => reply("And another.", [{ op: "add", topic: "Commercial terms", kind: "fact", text: foldText("FOLD-REBASE-THIRD") }]),
	};
	const startedK = startAbsorbRun({ agentId: roomK.agentId, assessmentMarkdown: ASSESSMENT, model: MODEL, generate: scriptedGenerate(scriptsK, []), now: RUN_CLOCK });
	const readyK = await settle(roomK.agentId, startedK.runId, "the eleventh room's run");
	assert(readyK.state === "ready", `the eleventh room's run should end ready, got "${readyK.state}"${readyK.error ? ` with "${readyK.error}"` : ""}`);
	const rememberedK = rememberMeanwhile(roomK.agentId, MEANWHILE, new Date(`${RUN_DAY}T09:03:00.000Z`));
	const l1bAfterRememberK = fs.readFileSync(roomK.l1bPath, "utf-8");
	assert(/^###\s+RC-0002\s*\|/m.test(l1bAfterRememberK) && l1bAfterRememberK.includes(MEANWHILE) && rememberedK.recentContextEntryCount === 2, "the Remember appended a second conversation to the file while the update was open");

	// --- 31. The save lands, rebased onto the file as it stands -----------------
	const approvalK = approveAbsorbRun(roomK.agentId, startedK.runId, APPROVED_AT);
	assert(JSON.stringify(approvalK.rebasedOnto) === JSON.stringify(["RC-0002"]), `the approval names the conversation remembered meanwhile, got ${JSON.stringify(approvalK.rebasedOnto)}`);
	assert(JSON.stringify(approvalK.foldedSessions) === JSON.stringify(["RC-0001"]) && JSON.stringify(approvalK.remainingSessions) === "[]" && approvalK.recentContextEntryCount === 1, `the run's own account is unchanged and the file's count includes what was remembered meanwhile, got ${JSON.stringify({ folded: approvalK.foldedSessions, remaining: approvalK.remainingSessions, count: approvalK.recentContextEntryCount })}`);
	const writtenK = fs.readFileSync(roomK.l1bPath, "utf-8");
	assert(!/^###\s+RC-0001\s*\|/m.test(writtenK), "the folded conversation left Recent Context");
	const keptK = recentContextSessions(extractRecentContextForAbsorb(writtenK).recentContext);
	const rememberedBlockK = recentContextSessions(extractRecentContextForAbsorb(l1bAfterRememberK).recentContext).find((session) => session.id === "RC-0002");
	assert(keptK.length === 1 && keptK[0].id === "RC-0002" && keptK[0].text === rememberedBlockK?.text, `the remembered conversation is in the written file exactly as the Remember wrote it, got ${JSON.stringify(keptK.map((session) => session.id))}`);
	assert(writtenK.includes("FOLD-REBASE-ADD"), "what the fold added is in the written memory");
	assert(new RegExp(`^- Last checkpoint: ${rememberedK.checkpointId}$`, "m").test(writtenK) && new RegExp(`^- Last consolidation: ${approvalK.absorbId}$`, "m").test(writtenK), "Chronos keeps the Remember's stamp and takes the save's beside it");
	assert(getAbsorbRun(roomK.agentId, startedK.runId).state === "saved", "the rebased run reads as saved");

	// --- 32. Undo puts back the file the save replaced, byte for byte -------------
	const undoneK = undoMemorySave(roomK.agentId, approvalK.saveId, new Date(`${RUN_DAY}T09:06:00.000Z`));
	assert(fs.readFileSync(roomK.l1bPath, "utf-8") === l1bAfterRememberK, "undo restores the file as it stood after the Remember and before the save, byte for byte");
	assert(undoneK.recentContextCount === 2, `both conversations are back, got ${undoneK.recentContextCount}`);
	resetAbsorbRunsForTests();

	// --- 33. Any other change keeps the honest refusal ---------------------------
	const startedK2 = startAbsorbRun({ agentId: roomK.agentId, assessmentMarkdown: ASSESSMENT, model: MODEL, generate: scriptedGenerate(scriptsK, []), now: RUN_CLOCK });
	const readyK2 = await settle(roomK.agentId, startedK2.runId, "the eleventh room's second run");
	assert(readyK2.state === "ready" && readyK2.sessions.length === 2, `the second run folds both conversations, got "${readyK2.state}" over ${readyK2.sessions.length} session(s)`);
	const editedK = fs.readFileSync(roomK.l1bPath, "utf-8").replace("Confirm the invoicing day with finance", "Confirm the invoicing day with legal");
	assert(editedK !== fs.readFileSync(roomK.l1bPath, "utf-8"), "the hand edit changes an entry");
	fs.writeFileSync(roomK.l1bPath, editedK);
	expectThrows(() => approveAbsorbRun(roomK.agentId, startedK2.runId, APPROVED_AT), /stale/i, "approving over an entry edited by hand");
	rememberMeanwhile(roomK.agentId, "FOLD-REMEMBERED-AGAIN", new Date(`${RUN_DAY}T09:07:00.000Z`));
	expectThrows(() => approveAbsorbRun(roomK.agentId, startedK2.runId, APPROVED_AT), /stale/i, "approving over an entry edited by hand, with a Remember on top");
	assert(getAbsorbRun(roomK.agentId, startedK2.runId).state === "ready" && fs.readdirSync(path.join(root, roomK.agentId, "events", "absorb")).length === 1, "a refused approval writes nothing and leaves the run ready");
	cancelAbsorbRun(roomK.agentId, startedK2.runId, new Date(`${RUN_DAY}T09:08:00.000Z`));
	resetAbsorbRunsForTests();

	// =====================================================================
	// Room twelve: an archived version id is unique across runs.
	// =====================================================================
	// The archive is addressable: a restore looks a row up by id. A run used
	// to mint version ids against its own rows only, so an entry rewritten in
	// two runs got `-v1` twice, and an undo of the second save could take the
	// first run's row instead of its own.
	const OLDER_VERSION = "FOLD-OLDER-VERSION";
	const roomL = createRoom("Absorb Run Version Id Smoke Room", (agentId) => memoryFixture({ agentId, fillerCount: 6, markedEntries: true, sessions: sessionsE }));
	appendArchive(roomL.agentId, [{ entry: { id: `${entryId(102)}-v1`, kind: "practice", saved: "2026-09-01", pinned: false, text: `- ${OLDER_VERSION} The delivery window is eight weeks from the day the order is signed.` }, why: "superseded", topic: "Working style", section: "Deep Memory", archived: "2026-09-11" }], new Date(`${RUN_DAY}T08:00:00.000Z`));
	assert(readArchive(roomL.agentId).map((entry) => entry.id).join() === `${entryId(102)}-v1`, "the archive already holds the first version of the entry from an earlier run");
	const scriptsL: Record<string, Script> = {
		"RC-0001": ({ areas }) => reply("The window moved again.", [{ op: "update", id: addressOf(areas, SUPERSEDE_TARGET), text: foldText("FOLD-NEWER-VERSION") }]),
	};
	const startedL = startAbsorbRun({ agentId: roomL.agentId, assessmentMarkdown: ASSESSMENT, model: MODEL, generate: scriptedGenerate(scriptsL, []), now: RUN_CLOCK });
	const readyL = await settle(roomL.agentId, startedL.runId, "the twelfth room's run");
	assert(readyL.state === "ready" && sessionView(readyL, "RC-0001").outcome === "folded", `the twelfth room's fold should land, got "${readyL.state}" / "${sessionView(readyL, "RC-0001").outcome}"`);

	// --- 34. The second rewrite is -v2, and undo takes back exactly that row ------
	const approvalL = approveAbsorbRun(roomL.agentId, startedL.runId, APPROVED_AT);
	const archiveL = readArchive(roomL.agentId);
	assert(JSON.stringify(archiveL.map((entry) => entry.id)) === JSON.stringify([`${entryId(102)}-v1`, `${entryId(102)}-v2`]), `the text this run replaced is archived as the entry's second version, got ${JSON.stringify(archiveL.map((entry) => entry.id))}`);
	assert(archiveL[1].why === "superseded" && archiveL[1].text.includes(SUPERSEDE_TARGET), `the -v2 row carries the text the update replaced, got ${JSON.stringify(archiveL[1])}`);
	const recordL = JSON.parse(fs.readFileSync(path.join(root, roomL.agentId, "events", "absorb", `${approvalL.absorbId}.json`), "utf-8"));
	assert(JSON.stringify(recordL.run.archived.map((row: any) => row.id)) === JSON.stringify([`${entryId(102)}-v2`]), `the record names the row this save appended, got ${JSON.stringify(recordL.run.archived)}`);
	undoMemorySave(roomL.agentId, approvalL.saveId, new Date(`${RUN_DAY}T09:06:00.000Z`));
	const archiveAfterUndoL = readArchive(roomL.agentId);
	assert(archiveAfterUndoL.length === 1 && archiveAfterUndoL[0].id === `${entryId(102)}-v1` && archiveAfterUndoL[0].text.includes(OLDER_VERSION), `undo takes back exactly the row this save appended and leaves the earlier run's, got ${JSON.stringify(archiveAfterUndoL.map((entry) => entry.id))}`);
	resetAbsorbRunsForTests();

	// --- 35. The propose body's limitRaisedFrom: a whole number a room may hold, or nothing ---
	assert(parseAbsorbRunProposeRequest({ assessmentMarkdown: ASSESSMENT, limitRaisedFrom: 20_000 }).limitRaisedFrom === 20_000, "a propose body carrying the limit the first read raised from keeps it");
	assert(!("limitRaisedFrom" in parseAbsorbRunProposeRequest({ assessmentMarkdown: ASSESSMENT })), "a body without it says nothing");
	for (const bogus of ["20000", 20_000.5, 9_000, 90_000, NaN, null, { tokens: 20_000 }]) {
		assert(!("limitRaisedFrom" in parseAbsorbRunProposeRequest({ assessmentMarkdown: ASSESSMENT, limitRaisedFrom: bogus })), `a limitRaisedFrom of ${JSON.stringify(bogus)} is ignored`);
	}

	resetAbsorbRunsForTests();
	console.log("absorb-run-smoke: OK");
} catch (error) {
	console.error(error instanceof Error ? error.stack || error.message : error);
	console.error(`temp home preserved for inspection: ${tempHome}`);
	process.exitCode = 1;
} finally {
	if (process.exitCode !== 1) fs.rmSync(tempHome, { recursive: true, force: true });
}
