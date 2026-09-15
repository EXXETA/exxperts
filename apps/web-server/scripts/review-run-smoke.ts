// Review's RUN, driven end to end on real rooms in a temp HOME (memory v2).
//
// The run is the promise that a review costs a group of topics at a time and
// keeps every note's id, date and pin while it tidies: the server asks for one
// group per call, a group whose call comes back refused twice or not at all
// costs that group and nothing else, three groups are in flight while the step
// that changes the working document is serialized, the budget is the server's
// own arithmetic rather than something a model is asked to respect, and nothing
// at all is written until the user approves. Those are exactly the things that
// cannot be read off the code, so this smoke drives the whole loop with a
// scripted worker that answers the prompt the way a model would — one
// narrative, one fenced list of operations — and then reads the file that was
// written: what each note kept, what went to the archive and with which reason,
// what Chronos now says, and what the run's own record in the room's events
// claims happened. It then takes the save back and proves the memory is the
// file it was before, byte for byte, with exactly this save's archive rows gone.
//
// Offline: no server, no provider, no network, no port.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { ReviewRun, ReviewRunGenerate } from "../src/review-run.js";
import type { AbsorbGenerateResult } from "../src/persistent-agents.js";

const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "review-run-smoke-home-"));
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
	approveReviewRun,
	cancelReviewRun,
	editReviewRunEntry,
	getReviewRun,
	hasActiveReviewRun,
	keepReviewRunEntries,
	resetReviewRunsForTests,
	REVIEW_RUN_RETENTION_MS,
	REVIEW_TIDY_CONNECTION_LOST_TWICE,
	REVIEW_TIDY_REFUSED_TWICE,
	reviewRunStatus,
	rewindReviewRunClockForTests,
	setReviewRunBudget,
	setReviewTidyRetryPauseForTests,
	startReviewRun,
} = await import("../src/review-run.js");
// A call that never came back is asked again after a pause. The pause is the one
// thing here that is real time rather than behaviour, so it is zeroed.
setReviewTidyRetryPauseForTests(0);
const { beginPersistentAgentTurn, createPersistentAgentFromScaffoldInput, createPersistentAgentPiSessionJsonlThreadRuntime, finishPersistentAgentTurn, writePersistentAgentThread } = await import("../src/persistent-agents.js");
const { IsolatedPersistentAgentWorkerTurnError } = await import("../src/persistent-agent-worker-runtime.js");
const { readArchive } = await import("../src/memory-entries-store.js");
const { readPersistentRoomMaintenanceSettings, writePersistentRoomMaintenanceSettings } = await import("../src/persistent-room-maintenance-settings.js");
const { undoMemorySave } = await import("../src/memory-undo.js");
const { buildRoomMemoryHistory } = await import("../src/memory-api.js");

const MODEL = { provider: "openai-compatible", model: "gpt-5.5", label: "GPT-5.5" };
const RUN_DAY = "2026-09-14";
const RUN_CLOCK = () => new Date(`${RUN_DAY}T09:00:00.000Z`);
const APPROVED_AT = new Date(`${RUN_DAY}T09:05:00.000Z`);
/** The budget floor, so a fixture the size of a real room is genuinely over it. */
const TIGHT_BUDGET = 10_000;
const RAISED_BUDGET = 60_000;
/** A window whose output cap decides how many topics ride in one call. */
const MODEL_WINDOW = { contextWindow: 400_000, maxOutputTokens: 16_384 };

const TOPICS = ["Commercial terms", "Working style", "Reporting rhythm", "Delivery practice"];
/** The topic whose every call throws: its notes must come out of the run unchanged. */
const DOOMED_TOPIC = "Reporting rhythm";
/** The topic whose first reply is refused and whose second is accepted. */
const REFUSED_TOPIC = "Commercial terms";
const NOTES_PER_TOPIC = 22;

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

// --- The fixture --------------------------------------------------------------

interface FixtureEntry {
	id: string;
	kind: "fact" | "practice" | "item";
	saved: string;
	pinned?: boolean;
	status?: "open" | "done";
	updated?: string;
	refs?: number;
	text: string;
}

function renderFixtureEntry(entry: FixtureEntry): string {
	const fields = [`id=${entry.id}`, `kind=${entry.kind}`, `saved=${entry.saved}`, "from=RC-0002"];
	if (entry.pinned) fields.push("pinned=true");
	if (entry.status) fields.push(`status=${entry.status}`);
	if (entry.updated) fields.push(`updated=${entry.updated}`);
	if (entry.refs !== undefined) fields.push(`refs=${entry.refs}`);
	return `<!-- e: ${fields.join(" ")} -->\n${entry.text}\n`;
}

function entryId(n: number): string {
	return `m-${String(n).padStart(4, "0")}`;
}

/**
 * A note of the length a real room's notes reach, so the budget has something
 * to weigh — with words of its own, so the machine does not read this room as
 * one point said eighty-eight times and bond every topic to every other.
 */
function fixtureNote(topic: string, n: number): FixtureEntry {
	const slug = topic.toLowerCase().replace(/[^a-z0-9]+/g, "");
	const detail = Array.from({ length: 30 }, (_, i) => `${slug}${n}x${i + 1}`).join(" ");
	return {
		id: entryId(n),
		kind: "fact",
		saved: `2024-${String((n % 12) + 1).padStart(2, "0")}-${String((n % 27) + 1).padStart(2, "0")}`,
		refs: 0,
		text: `- Note ${n} of the ${topic} arrangement, with the agreed rate, the renewal month, the signing route and the escalation path spelled out: ${detail}.`,
	};
}

/** The pinned note: the user's own, and the one the tidy may never take away. */
const PINNED_MARKER = "REVIEW-PINNED";
/** The open item the tidy finishes. */
const CLOSE_MARKER = "REVIEW-CLOSE";
/** The open item nothing happens to. */
const KEEP_ITEM_MARKER = "REVIEW-OPEN";

function memoryFixture(agentId: string): string {
	let n = 1;
	const topicBlocks = TOPICS.map((title) => {
		const notes: FixtureEntry[] = [];
		for (let i = 0; i < NOTES_PER_TOPIC; i++) notes.push(fixtureNote(title, n++));
		if (title === REFUSED_TOPIC) {
			notes.push({ id: entryId(n++), kind: "fact", saved: "2026-09-01", updated: "2026-09-11", refs: 6, pinned: true, text: `- **must-keep** ${PINNED_MARKER} The escalation route is the account owner, then the delivery lead, and nobody else.` });
		}
		return `### ${title}\n\n${notes.map(renderFixtureEntry).join("\n")}`;
	});
	const items: FixtureEntry[] = [
		{ id: entryId(900), kind: "item", status: "open", saved: "2026-09-01", updated: "2026-09-11", refs: 4, text: `- ${CLOSE_MARKER} Chase the vendor for the signed addendum.` },
		{ id: entryId(901), kind: "item", status: "open", saved: "2026-08-20", updated: "2026-09-10", refs: 1, text: `- ${KEEP_ITEM_MARKER} Confirm the invoicing day with finance before the quarter closes.` },
	];
	return [
		"<!-- exxeta:l1b schema_version=1 -->",
		"",
		"## Chronos",
		"",
		`- Persistent agent id: ${agentId}`,
		"- Lifecycle state: ready",
		"- Last checkpoint: cp_20260912_0001",
		"- Last checkpoint at: 2026-09-12T09:00:00.000Z",
		"- Last consolidation: none",
		"",
		"## Deep Memory",
		"",
		"<!-- entries: next=2000 -->",
		"",
		topicBlocks.join("\n"),
		"## Active Items",
		"",
		items.map(renderFixtureEntry).join("\n"),
		"## Recent Context",
		"",
		"No checkpointed sessions yet.",
		"",
	].join("\n");
}

function createRoom(displayName: string, fixture: (agentId: string) => string = memoryFixture): { agentId: string; l1bPath: string } {
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

// --- The fixture for what memory says twice -------------------------------------

/** The two notes that say one thing, under two topics with a large topic between them. */
const TWIN_A = "- The Nordwind contract renews annually and legal signs it before June, with the account owner as the escalation route.";
const TWIN_B = "- The Nordwind contract renews annually and legal signs it before June, with the account owner as the usual escalation route.";
/** The two headings that look like one topic, and the one note the smaller carries. */
const FOLD_INTO = "Nordwind integration";
const FOLD_FROM = "Nordwind integrations";
const FOLD_FROM_NOTE = "m-0501";
const FOLD_FROM_TEXT = "- The feed's checksum is verified against the manifest before any order is accepted, and a mismatch stops the run.";
/** The topic between the twins, larger than the reply budget of room four, so the twins cannot share a call unless they are bonded. */
const WALL_TOPIC = "Reporting rhythm";

function memoryFixtureD(agentId: string): string {
	const note = (id: string, text: string, extra: Partial<FixtureEntry> = {}): FixtureEntry => ({ id, kind: "fact", saved: "2026-06-01", refs: 0, text, ...extra });
	const wall = Array.from({ length: NOTES_PER_TOPIC }, (_, i) => fixtureNote(WALL_TOPIC, 201 + i));
	const blocks = [
		`### Commercial terms\n\n${[note("m-0101", TWIN_A), note("m-0102", "- Invoices go out on the first working day of the month.")].map(renderFixtureEntry).join("\n")}`,
		`### ${WALL_TOPIC}\n\n${wall.map(renderFixtureEntry).join("\n")}`,
		`### Delivery practice\n\n${[note("m-0301", TWIN_B), note("m-0302", "- Deliveries are confirmed in writing the same day they land.")].map(renderFixtureEntry).join("\n")}`,
		`### ${FOLD_INTO}\n\n${[note("m-0401", "- Nordwind's orders arrive over the nightly feed at two in the morning."), note("m-0402", "- Retries are attempted three times, ten minutes apart, before the feed is declared down.")].map(renderFixtureEntry).join("\n")}`,
		`### ${FOLD_FROM}\n\n${[note(FOLD_FROM_NOTE, FOLD_FROM_TEXT, { pinned: true })].map(renderFixtureEntry).join("\n")}`,
	];
	const items: FixtureEntry[] = [{ id: entryId(901), kind: "item", status: "open", saved: "2026-08-20", refs: 1, text: `- ${KEEP_ITEM_MARKER} Confirm the invoicing day with finance before the quarter closes.` }];
	return [
		"<!-- exxeta:l1b schema_version=1 -->",
		"",
		"## Chronos",
		"",
		`- Persistent agent id: ${agentId}`,
		"- Lifecycle state: ready",
		"- Last checkpoint: cp_20260912_0001",
		"- Last checkpoint at: 2026-09-12T09:00:00.000Z",
		"- Last consolidation: none",
		"",
		"## Deep Memory",
		"",
		"<!-- entries: next=2000 -->",
		"",
		blocks.join("\n"),
		"## Active Items",
		"",
		items.map(renderFixtureEntry).join("\n"),
		"## Recent Context",
		"",
		"No checkpointed sessions yet.",
		"",
	].join("\n");
}

// --- The scripted worker -------------------------------------------------------

interface PromptNote {
	id: string;
	topic: string;
	pinned: boolean;
	firstLine: string;
}

interface WorkerCall {
	key: string;
	topics: string[];
	attempt: number;
	prompt: string;
}

const SECTION_SPLIT = /\n\n---\n\n/;

function promptSection(prompt: string, heading: string): string {
	const found = prompt.split(SECTION_SPLIT).find((part) => part.trimStart().startsWith(heading));
	assert(found, `the tidy prompt carries no "${heading}" section, so the scripted worker cannot answer it`);
	return found!.slice(found!.indexOf("\n") + 1).trim();
}

const NOTE_ADDRESS = /^(?:\s*(?:[-*+]|\d+[.)])\s+)?\[([^\]\s·]+)(\s+·\s+pinned)?\]\s*([\s\S]*)$/;

/** The notes this prompt says may be addressed, read back the way a model reads them. */
function notesFromPrompt(prompt: string): PromptNote[] {
	const rows: PromptNote[] = [];
	let topic = "";
	for (const line of promptSection(prompt, "## Material: The Notes To Tidy").split("\n")) {
		const section = /^##\s+(.+?)\s*$/.exec(line);
		if (section) { topic = section[1]; continue; }
		const heading = /^###\s+(.+?)\s*$/.exec(line);
		if (heading) { topic = heading[1]; continue; }
		const row = NOTE_ADDRESS.exec(line.trim());
		if (row) rows.push({ id: row[1], topic, pinned: Boolean(row[2]), firstLine: row[3] });
	}
	return rows;
}

function fence(ops: unknown[]): string {
	return ["```json", JSON.stringify({ ops }, null, 2), "```"].join("\n");
}

function reply(narrative: string, ops: unknown[]): AbsorbGenerateResult {
	return { text: `${narrative}\n\n${fence(ops)}\n`, usage: { input: 2400, output: 260, totalTokens: 2660, cost: 0.0031 } };
}

/** A tidied note: the same point, said in a fraction of the words. */
function tidied(note: PromptNote): string {
	return `- ${note.firstLine.split(",")[0].slice(0, 90).trim()}.`;
}

const calls: WorkerCall[] = [];

function callsForTopic(title: string): WorkerCall[] {
	return calls.filter((call) => call.topics.includes(title));
}

/**
 * The scripted worker. It steers by the topics the prompt actually carries, so
 * it answers whatever grouping the run chose: the doomed topic's calls never
 * come back, the refused topic's first reply grows a note and tries to archive
 * the user's pinned one (both of which the memory refuses) while its second says
 * the same point in fewer words, and every other group shortens one note and —
 * in Active Items — closes the item the work has finished.
 */
const generate: ReviewRunGenerate = async (prompt, _model, options) => {
	assert(options.thinkingLevel === "low" && options.signal instanceof AbortSignal && options.timeoutMs > 0, `a tidy call carries reasoning off, a signal and a ceiling (got ${JSON.stringify({ thinkingLevel: options.thinkingLevel, timeoutMs: options.timeoutMs })})`);
	const notes = notesFromPrompt(prompt);
	const topics = [...new Set(notes.map((note) => note.topic))];
	const key = topics.join("|");
	const attempt = calls.filter((call) => call.key === key).length + 1;
	calls.push({ key, topics, attempt, prompt });

	if (topics.includes(DOOMED_TOPIC)) throw new IsolatedPersistentAgentWorkerTurnError("review tidy worker", "error", "terminated");

	if (topics.includes("Active Items")) {
		const closing = notes.find((note) => note.firstLine.includes(CLOSE_MARKER));
		assert(closing, "the Active Items prompt should list the item this smoke closes");
		return reply("The addendum came back signed, so that item is finished.", [{ op: "close", id: closing!.id }]);
	}

	const plain = notes.filter((note) => !note.pinned);
	assert(plain.length >= 3, `the prompt for ${key} lists too few notes for this smoke to script`);
	if (topics.includes(REFUSED_TOPIC)) {
		const pinned = notes.find((note) => note.pinned);
		assert(pinned, `the ${REFUSED_TOPIC} prompt should carry the room's pinned note, and it did not`);
		if (attempt === 1) {
			// A "tidy" that writes more than it replaces, which is the one thing
			// Review refuses outright — and beside it an attempt to take the
			// user's own pinned note away.
			return reply("Here is a fuller version of these notes.", [
				{ op: "update", id: plain[0].id, text: `- ${plain[0].firstLine.repeat(3)}` },
				{ op: "archive", id: pinned!.id, why: "stale" },
			]);
		}
		return reply("Said again in fewer words, and two that said one thing are now one.", [
			{ op: "update", id: plain[0].id, text: tidied(plain[0]) },
			{ op: "merge", ids: [plain[1].id, plain[2].id], text: tidied(plain[1]) },
		]);
	}
	return reply("One note said at length, and one that no longer holds.", [
		{ op: "update", id: plain[0].id, text: tidied(plain[0]) },
		{ op: "archive", id: plain[1].id, why: "stale" },
	]);
};

// --- Polling -------------------------------------------------------------------

const WORKING_STATES = new Set(["prepass", "tidying", "budget"]);

async function settle(agentId: string, runId: string, label: string): Promise<ReviewRun> {
	const deadline = Date.now() + 60_000;
	let run = getReviewRun(agentId, runId);
	while (WORKING_STATES.has(run.state)) {
		assert(Date.now() < deadline, `${label}: the run was still in state "${run.state}" after 60 seconds, and a scripted tidy answers in milliseconds`);
		await sleep(2);
		run = getReviewRun(agentId, runId);
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

try {
	// =====================================================================
	// Room one: the loop, its three endings, the card and the write.
	// =====================================================================
	const roomA = createRoom("Review Run Smoke Room");
	writePersistentRoomMaintenanceSettings(roomA.agentId, { memoryBudgetTokens: TIGHT_BUDGET });
	const fixtureBytes = fs.readFileSync(roomA.l1bPath, "utf-8");

	// --- 1. What the room says before anything starts -------------------------
	const status = reviewRunStatus(roomA.agentId);
	assert(status.available === true && !status.reason, `a room with notes should be able to review, got ${JSON.stringify(status)}`);
	assert(status.topics === TOPICS.length + 1, `the status should count every topic that holds a note, got ${status.topics}`);
	assert(status.notes === TOPICS.length * NOTES_PER_TOPIC + 3, `the status should count every note, got ${status.notes}`);
	assert(status.budget.overBudget === true && status.budget.reviewTargetTokens > TIGHT_BUDGET, `this fixture is deliberately over its budget, got ${JSON.stringify(status.budget)}`);
	assert(status.recommendedDepth === "tidy", `a memory over its limit should be offered the deeper tidy first, got ${status.recommendedDepth}`);
	assert(status.writesMemory === false, "looking at a room's review never writes memory");

	// --- 2. The run ------------------------------------------------------------
	const started = startReviewRun(roomA.agentId, { depth: "tidy", model: MODEL, generate, resolveModelWindow: () => MODEL_WINDOW, now: RUN_CLOCK });
	assert(started.state === "prepass", `a run comes back immediately in its prepass state, got ${started.state}`);
	assert(started.depth === "tidy" && started.guidance === null, `the run carries the depth it was started with and no guidance, got ${JSON.stringify({ depth: started.depth, guidance: started.guidance })}`);
	expectThrows(() => startReviewRun(roomA.agentId, { depth: "tidy", model: MODEL, generate }), /already reviewing/, "a second review while one is working");
	assert(hasActiveReviewRun(roomA.agentId), "a working run holds the room");

	const run = await settle(roomA.agentId, started.runId, "room one");
	assert(run.state === "ready", `the run should end ready to approve, got state ${run.state}${run.error ? ` with error ${JSON.stringify(run.error)}` : ""}`);
	assert(!hasActiveReviewRun(roomA.agentId), "a ready run is a card, not a worker: it must not hold the room for the life of the process");
	assert(run.topics.length === TOPICS.length + 1, `the run should set out to tidy every topic, got ${JSON.stringify(run.topics)}`);
	assert(run.progress.groups >= 2 && run.progress.group === run.progress.groups, `every group should have finished, got ${JSON.stringify(run.progress)}`);
	assert(run.progress.label === undefined, "a finished run names no topic in flight");
	assert(fs.readFileSync(roomA.l1bPath, "utf-8") === fixtureBytes, "a run writes nothing: the memory must be byte for byte as it was until approve");
	assert(!callsForTopic(REFUSED_TOPIC).some((call) => call.topics.includes(DOOMED_TOPIC)), "this smoke needs the refused topic and the doomed one in different groups, and the grouping put them together");

	// The refused group: asked twice, accepted the second time.
	const refusedCalls = callsForTopic(REFUSED_TOPIC);
	assert(refusedCalls.length === 2, `a refused reply buys exactly one retry, got ${refusedCalls.length} calls for ${REFUSED_TOPIC}`);
	assert(/## Retry Notice/.test(refusedCalls[1].prompt), "the second ask carries the Retry Notice");
	assert(/Review makes notes shorter/.test(refusedCalls[1].prompt), "the retry names the reason the first reply was refused, in the words the memory refuses by");
	assert(/is pinned/.test(refusedCalls[1].prompt), "the retry also names the pinned note the first reply tried to take away");
	assert(!run.leftAsIs.some((entry) => entry.topics.includes(REFUSED_TOPIC)), `a group that was accepted on the retry is not left as it was, got ${JSON.stringify(run.leftAsIs)}`);
	assert(run.changes.some((change) => change.topic === REFUSED_TOPIC && change.kind === "shortened"), `the retried group's accepted reply should show on the card, got ${JSON.stringify(run.changes.map((c) => `${c.kind}:${c.topic}`))}`);

	// The doomed group: asked twice because the first call never came back, then left as it was.
	const doomedCalls = callsForTopic(DOOMED_TOPIC);
	assert(doomedCalls.length === 2, `a call that never comes back buys exactly one more, got ${doomedCalls.length} calls for ${DOOMED_TOPIC}`);
	const left = run.leftAsIs.find((entry) => entry.topics.includes(DOOMED_TOPIC));
	assert(left, `a group whose calls never came back should be named on the card, got ${JSON.stringify(run.leftAsIs)}`);
	assert(left!.reason === REVIEW_TIDY_CONNECTION_LOST_TWICE, `two calls that dropped the same way are said "twice", got ${JSON.stringify(left!.reason)}`);
	assert(!run.changes.some((change) => change.topic === DOOMED_TOPIC), `a group left as it was changes nothing, got ${JSON.stringify(run.changes.filter((c) => c.topic === DOOMED_TOPIC))}`);
	assert(REVIEW_TIDY_REFUSED_TWICE.length > 0, "the twice-refused sentence exists for the group whose replies the memory could not accept");

	// The finished item.
	const closed = run.changes.find((change) => change.kind === "closed");
	assert(closed && closed.why === "done", `the finished item should be closed with the archive's own reason, got ${JSON.stringify(closed)}`);

	// Every kind of change the design named reaches the card with its rows.
	const kinds = new Set(run.changes.map((change) => change.kind));
	for (const kind of ["shortened", "merged", "archived", "closed"]) {
		assert(kinds.has(kind as any), `the run should have produced a "${kind}" row, got ${JSON.stringify([...kinds])}`);
	}
	assert(run.changes.every((change) => change.id && change.topic && change.section), "every row on the card carries the note it is about and where it lives");
	const mergedRow = run.changes.find((change) => change.kind === "merged")!;
	assert((mergedRow.mergedFrom?.length ?? 0) >= 2, `a merged row names the notes that became it, got ${JSON.stringify(mergedRow.mergedFrom)}`);

	// --- 3. The card's controls -----------------------------------------------
	assert(run.demotion.entries.length > 0, `this room is over its budget after the tidy too, so the run should disclose what would leave, got ${JSON.stringify(run.demotion.keepIds)}`);
	assert(run.budget.budgetTokens === TIGHT_BUDGET && run.budget.savedBudgetTokens === TIGHT_BUDGET && run.budget.before > TIGHT_BUDGET, `the run measures this memory against the room's own budget, got ${JSON.stringify(run.budget)}`);
	assert(run.demotion.entries.every((row) => row.leaving && !row.kept && !row.instead && row.phase === "after" && typeof row.rank === "number"), `the run's own budget pass lists rows that simply leave, got ${JSON.stringify(run.demotion.entries[0])}`);
	assert(run.demotion.counts.leaving === run.demotion.entries.length && run.demotion.counts.kept === 0 && run.demotion.counts.instead === 0 && run.demotion.keepTopics.length === 0, `the counts are the server's, got ${JSON.stringify(run.demotion.counts)}`);
	for (let i = 1; i < run.demotion.entries.length; i++) {
		const previous = run.demotion.entries[i - 1];
		const row = run.demotion.entries[i];
		if (previous.section === row.section && previous.topic === row.topic) assert(previous.rank < row.rank, `rows of one topic are in rank order, and ${previous.id} (${previous.rank}) sits before ${row.id} (${row.rank})`);
	}
	assert(run.candidate?.sourceFingerprint.algorithm === "sha256" && /^[a-f0-9]{64}$/.test(run.candidate.sourceFingerprint.value), `a ready run carries the fingerprint of the memory it was built on, got ${JSON.stringify(run.candidate)}`);

	// Keep: a note the tidy sent to the archive comes back.
	const archivedByTidy = run.changes.find((change) => change.kind === "archived")!;
	const keptRun = keepReviewRunEntries(roomA.agentId, run.runId, [archivedByTidy.id]);
	assert(keptRun.demotion.keepIds.includes(archivedByTidy.id), `a kept note should be listed as kept, got ${JSON.stringify(keptRun.demotion.keepIds)}`);
	assert(!keptRun.demotion.entries.some((entry) => entry.id === archivedByTidy.id), "a note the tidy set aside has its own Keep and is not a row of the budget's list");

	// The archive list is stable: a kept budget row keeps its place, marked kept,
	// and what leaves in its stead is marked as leaving instead.
	const budgetRow = keptRun.demotion.entries.find((row) => row.leaving)!;
	const listed = keptRun.demotion.entries.map((row) => row.id);
	const keptTwo = keepReviewRunEntries(roomA.agentId, run.runId, { keepIds: [archivedByTidy.id, budgetRow.id] });
	const keptBudgetRow = keptTwo.demotion.entries.find((row) => row.id === budgetRow.id);
	assert(keptBudgetRow?.kept === true && keptBudgetRow.leaving === false && keptBudgetRow.instead === false, `a kept row stays on the list, kept and no longer leaving, got ${JSON.stringify(keptBudgetRow)}`);
	assert(listed.every((id) => keptTwo.demotion.entries.some((row) => row.id === id)), "no row ever leaves the list once it was on it");
	// Keeping the tidy's note already made one note leave instead; keeping the
	// budget row makes another, so the "instead" rows are those two.
	const replacements = keptTwo.demotion.entries.filter((row) => row.instead);
	assert(replacements.some((row) => !listed.includes(row.id)) && replacements.every((row) => row.leaving), `keeping a note makes the next least recently touched note leave instead, marked as such, got ${JSON.stringify(replacements.map((row) => row.id))}`);
	assert(keptTwo.demotion.counts.kept === 1 && keptTwo.demotion.counts.instead === replacements.length && keptTwo.demotion.counts.leaving === keptTwo.demotion.entries.filter((row) => row.leaving).length, `the counts follow the rows, got ${JSON.stringify(keptTwo.demotion.counts)}`);
	// A protected topic: every row under it is kept, and a keep body without keepIds leaves the kept ids alone.
	const topicAddress = `${budgetRow.section}/${budgetRow.topic}`;
	const byTopic = keepReviewRunEntries(roomA.agentId, run.runId, { keepTopics: [topicAddress.toUpperCase()] });
	assert(JSON.stringify(byTopic.demotion.keepTopics) === JSON.stringify([topicAddress]) && byTopic.demotion.keepIds.length === 2, `a protected topic is echoed as the row spells it and the kept ids are untouched, got ${JSON.stringify(byTopic.demotion)}`);
	const underTopic = byTopic.demotion.entries.filter((row) => row.section === budgetRow.section && row.topic === budgetRow.topic);
	assert(underTopic.length > 0 && underTopic.every((row) => row.kept && !row.leaving), `no note of a protected topic leaves, got ${JSON.stringify(underTopic.map((row) => [row.id, row.kept, row.leaving]))}`);
	assert(keepReviewRunEntries(roomA.agentId, run.runId, { keepTopics: ["Deep Memory/No such topic"] }).demotion.keepTopics.length === 0, "a topic no listed row is under is dropped");
	// Back to one keep: the rows that entered for the budget row's keep stay
	// listed as rows that stay; the one that entered for the tidy note's keep
	// still leaves in its stead, because that keep stands.
	const oneKeep = keepReviewRunEntries(roomA.agentId, run.runId, { keepIds: [archivedByTidy.id], keepTopics: [] });
	const enteredForBudgetRow = replacements.filter((row) => !listed.includes(row.id));
	assert(enteredForBudgetRow.length > 0, "keeping the budget row made at least one new row enter the list");
	for (const replacement of enteredForBudgetRow) {
		const row = oneKeep.demotion.entries.find((candidate) => candidate.id === replacement.id);
		assert(row && !row.leaving && !row.instead && !row.kept, `a replacement whose keep was taken back stays on the list as a row that stays, got ${JSON.stringify(row)}`);
	}
	assert(oneKeep.demotion.entries.find((row) => row.id === budgetRow.id)?.leaving === true && oneKeep.demotion.counts.kept === 0, "the row leaves again once its keep is taken back");
	assert(oneKeep.demotion.counts.instead === oneKeep.demotion.entries.filter((row) => row.leaving && row.instead).length && oneKeep.demotion.counts.instead === replacements.length - enteredForBudgetRow.length, `the rows leaving in the tidy note's stead are still counted, got ${JSON.stringify(oneKeep.demotion.counts)}`);

	// Edit: the person's words on a note the review rewrote.
	const shortened = run.changes.find((change) => change.kind === "shortened")!;
	const edited = editReviewRunEntry(roomA.agentId, run.runId, shortened.id, "The renewal month, the signing route and the escalation path, in one line.");
	const editedRow = edited.changes.find((change) => change.id === shortened.id)!;
	assert(editedRow.after === "- The renewal month, the signing route and the escalation path, in one line.", `an edit should show on the card, bullet kept, got ${JSON.stringify(editedRow.after)}`);
	expectThrows(() => editReviewRunEntry(roomA.agentId, run.runId, entryId(901), "not this one"), /only a note this review rewrote/i, "editing a note the review did not rewrite");
	expectThrows(() => editReviewRunEntry(roomA.agentId, run.runId, shortened.id, ""), /cannot be empty/, "emptying a note");

	// Budget: raising the limit on the run, and the floor that refuses. The
	// room's own setting follows on approve, not here.
	expectThrows(() => setReviewRunBudget(roomA.agentId, run.runId, 9_000), /between 10000 and 80000/, "a budget below the floor");
	const raised = setReviewRunBudget(roomA.agentId, run.runId, RAISED_BUDGET);
	assert(raised.budget.budgetTokens === RAISED_BUDGET && raised.demotion.counts.leaving === 0 && raised.demotion.overageTokens === 0, `at ${RAISED_BUDGET} tokens nothing has to leave this memory, got ${raised.demotion.counts.leaving} entries still leaving`);
	assert(raised.demotion.entries.length >= listed.length && raised.demotion.entries.every((row) => !row.leaving && !row.instead), "the rows stay listed after a raise, none of them leaving");
	assert(raised.budget.overBudgetAfter === false, `the raised budget leaves the candidate inside it, got ${JSON.stringify(raised.budget)}`);
	assert(raised.budget.savedBudgetTokens === TIGHT_BUDGET && readPersistentRoomMaintenanceSettings(roomA.agentId).memoryBudgetTokens === TIGHT_BUDGET, `raising the limit on the card writes nothing to the room until Save, got ${JSON.stringify(raised.budget)}`);
	assert(fs.readFileSync(roomA.l1bPath, "utf-8") === fixtureBytes, "keeping, editing and raising the budget still write nothing");

	// --- 3b. A save that fails after the raise puts the limit back --------------
	// The memory write refuses while the room has a turn in flight: the one seam
	// that makes a save fail AFTER its raise without touching the disk.
	const turnA = beginTurn(roomA.agentId, "review_run_smoke_turn_a");
	let failed: any = null;
	try { approveReviewRun(roomA.agentId, run.runId, new Date(`${RUN_DAY}T09:04:00.000Z`)); } catch (error) { failed = error; }
	assert(failed instanceof Error, "a save during a turn in flight is refused");
	assert(failed.message.endsWith(" The budget stays at 10k."), `the refusal ends by saying where the budget is, got ${JSON.stringify(failed.message)}`);
	const busyRefusal = failed as Error & { code?: string; statusCode?: number };
	assert(busyRefusal.code === "memory_room_busy" && busyRefusal.statusCode === 400, `the refusal keeps its own code and status, got ${JSON.stringify({ code: busyRefusal.code, statusCode: busyRefusal.statusCode })}`);
	assert(readPersistentRoomMaintenanceSettings(roomA.agentId).memoryBudgetTokens === TIGHT_BUDGET, `a save that failed after the raise leaves the room the limit it had, got ${readPersistentRoomMaintenanceSettings(roomA.agentId).memoryBudgetTokens}`);
	const readyAgain = getReviewRun(roomA.agentId, run.runId);
	assert(readyAgain.state === "ready" && readyAgain.budget.savedBudgetTokens === TIGHT_BUDGET && readyAgain.budget.budgetTokens === RAISED_BUDGET, `the run is ready again, still computed against the raised limit, with the room's limit back where it was, got ${JSON.stringify({ state: readyAgain.state, budget: readyAgain.budget })}`);
	assert(fs.readFileSync(roomA.l1bPath, "utf-8") === fixtureBytes, "a save that failed wrote nothing");
	turnA.finish();

	// --- 4. Approve: the one write ---------------------------------------------
	const beforeApproval = fs.readFileSync(roomA.l1bPath, "utf-8");
	const approved = approveReviewRun(roomA.agentId, run.runId, APPROVED_AT);
	assert(approved.writesMemory === true && approved.reviewId === approved.saveId, `an approval names the write it made under both names, got ${JSON.stringify({ reviewId: approved.reviewId, saveId: approved.saveId })}`);
	assert(approved.eventRelPath.startsWith("events/review/") && !path.isAbsolute(approved.eventRelPath), `the approval names its record by the room-relative path, got ${JSON.stringify(approved.eventRelPath)}`);
	assert(approved.notesChanged === run.changes.length && approved.topicsTidied > 0, `the saved screen counts what was tidied, got ${JSON.stringify({ notesChanged: approved.notesChanged, topicsTidied: approved.topicsTidied })}`);
	assert(approved.archivedEntries > 0 && approved.archivedForBudget === 0, `after the budget was raised nothing left for the budget alone, got ${JSON.stringify({ archivedEntries: approved.archivedEntries, archivedForBudget: approved.archivedForBudget })}`);
	assert(approved.memoryBudget.overBudget === false, `the written memory should be inside the budget it was measured against, got ${JSON.stringify(approved.memoryBudget)}`);
	assert(approved.budgetRaisedTo === RAISED_BUDGET && approved.memoryBudget.budgetTokens === RAISED_BUDGET && readPersistentRoomMaintenanceSettings(roomA.agentId).memoryBudgetTokens === RAISED_BUDGET, `the limit the card raised becomes the room's setting in the same save, got ${JSON.stringify({ budgetRaisedTo: approved.budgetRaisedTo, memoryBudget: approved.memoryBudget })}`);
	expectThrows(() => approveReviewRun(roomA.agentId, run.runId, APPROVED_AT), /stale/i, "a second approval of the same run");

	const written = fs.readFileSync(roomA.l1bPath, "utf-8");
	assert(written !== beforeApproval, "approve is the write");
	assert(/^- Last review: review_/m.test(written) && written.includes(`- Last review at: ${APPROVED_AT.toISOString()}`), `the write should stamp Chronos with this review, got ${JSON.stringify(written.slice(written.indexOf("## Chronos"), written.indexOf("## Deep Memory")))}`);
	assert(/- Last checkpoint: cp_20260912_0001/.test(written), "a review must not move the fields the other two workflows own");
	assert(written.includes(PINNED_MARKER) && /pinned=true/.test(written), "the user's own pinned note survives a review that tried to take it away");
	assert(!written.includes(CLOSE_MARKER), "the item the review finished has left the core");
	assert(written.includes(KEEP_ITEM_MARKER), "the item nothing happened to is still open");
	// Every note that stayed kept its metadata: the whole reason Review was rebuilt.
	assert(new RegExp(`id=${entryId(901)}\\b`).test(written), `the note ${entryId(901)} should still carry its id, and it does not`);
	assert(/from=RC-0002/.test(written), "the notes still say which conversation they came from");
	const shortenedMeta = written.slice(written.indexOf(`id=${shortened.id} `), written.indexOf(`id=${shortened.id} `) + 160);
	assert(new RegExp(`updated=${RUN_DAY}`).test(shortenedMeta), `a note the review reworded should be stamped with the day it was approved, and ${shortened.id} is not: ${JSON.stringify(shortenedMeta)}`);
	// The topic the doomed group held is untouched by the TIDY, note for note:
	// nothing of it was reworded, merged or judged stale. The limit rule still
	// applies to it like to every topic, so a note of it may leave for budget.
	const noteCountIn = (text: string, topic: string): number => {
		const heading = `### ${topic}`;
		const at = text.indexOf(heading);
		if (at < 0) return 0;
		const rest = text.slice(at + heading.length);
		const to = rest.search(/^#{2,3}\s/m);
		return (to < 0 ? rest : rest.slice(0, to)).split("<!-- e:").length - 1;
	};
	const doomedRows = readArchive(roomA.agentId).filter((row) => row.topic === DOOMED_TOPIC);
	assert(doomedRows.every((row) => row.why === "budget"), `a topic the tidy could not reach leaves notes only for budget, never as tidied, got ${JSON.stringify(doomedRows.map((row) => row.why))}`);
	assert(noteCountIn(written, DOOMED_TOPIC) + doomedRows.length === NOTES_PER_TOPIC, `every note of "${DOOMED_TOPIC}" is either still in memory or in the archive for budget, got ${noteCountIn(written, DOOMED_TOPIC)} + ${doomedRows.length}`);
	assert(!run.changes.some((change) => change.topic === DOOMED_TOPIC), "no change names the topic the tidy could not reach");

	// The archive rows, each with the reason it left.
	const archive = readArchive(roomA.agentId);
	assert(archive.length === approved.archivedEntries, `the archive should hold exactly what the approval counted, got ${archive.length} against ${approved.archivedEntries}`);
	assert(archive.some((row) => row.why === "superseded" && /-v1$/.test(row.id)), `the words a tidy replaced go to the archive under a versioned id, got ${JSON.stringify(archive.map((row) => `${row.id}:${row.why}`))}`);
	assert(archive.some((row) => row.why === "stale"), "a note the tidy judged stale leaves with that reason");
	assert(archive.some((row) => row.why === "done"), "the finished item leaves as done");
	assert(!archive.some((row) => row.id === archivedByTidy.id), "the note the person kept did not go to the archive");
	assert(archive.every((row) => row.topic && row.archived === RUN_DAY), "every archive row carries the address a restore needs and the day it left");

	// The run's own record.
	const recordPath = path.join(root, roomA.agentId, "events", "review", `${approved.reviewId}.json`);
	const record = JSON.parse(fs.readFileSync(recordPath, "utf-8"));
	assert(record.operation === "review" && record.reviewId === approved.reviewId, `the record should name itself, got ${JSON.stringify({ operation: record.operation, reviewId: record.reviewId })}`);
	assert(record.approvedAt === APPROVED_AT.toISOString(), "the record dates itself");
	assert(record.paths?.archivedL1bRelPath && record.result?.l1bFingerprint?.value, "the record carries what an undo needs: the file it replaced and the fingerprint of the file it wrote");
	assert(record.run?.depth === "tidy" && record.run.runId === run.runId, `the record carries the run it came from, got ${JSON.stringify({ depth: record.run?.depth, runId: record.run?.runId })}`);
	assert(record.run.archived.length === archive.length, "the record names every archive row this save appended");
	assert(record.run.leftAsIs.some((entry: any) => entry.topics.includes(DOOMED_TOPIC)), "the record says which topics were left as they were");
	assert(record.review.reviewTargetEstimatedTokenDelta < 0, `a review makes memory smaller, and this record says otherwise: ${JSON.stringify(record.review)}`);
	assert(record.run.budget.budgetTokens === RAISED_BUDGET && record.run.budget.raisedFrom === TIGHT_BUDGET, `a save that raised the limit records the limit it raised it from, got ${JSON.stringify(record.run.budget)}`);

	// --- 5. Undo ---------------------------------------------------------------
	const undone = undoMemorySave(roomA.agentId, approved.saveId, new Date(`${RUN_DAY}T09:10:00.000Z`));
	assert(undone.undone.saveId === approved.saveId && undone.undone.kind === "review", `the undo should say which save it took back, got ${JSON.stringify(undone.undone)}`);
	assert(fs.readFileSync(roomA.l1bPath, "utf-8") === beforeApproval, "undo puts the file back byte for byte — it is the previous file, not a reconstruction of it");
	assert(readArchive(roomA.agentId).length === 0, `the undo should take back exactly this save's archive rows, and ${readArchive(roomA.agentId).length} are left`);
	// The limit this save raised goes back down with it.
	assert(undone.limitLoweredTo === TIGHT_BUDGET && readPersistentRoomMaintenanceSettings(roomA.agentId).memoryBudgetTokens === TIGHT_BUDGET, `undoing a save that raised the limit lowers it again and says so, got ${JSON.stringify({ limitLoweredTo: undone.limitLoweredTo, setting: readPersistentRoomMaintenanceSettings(roomA.agentId).memoryBudgetTokens })}`);
	assert(undone.memoryBudget.budgetTokens === TIGHT_BUDGET && undone.memoryBudget.overBudget === true, `the undo's budget block is measured against the lowered limit, got ${JSON.stringify(undone.memoryBudget)}`);
	const undoRecord = JSON.parse(fs.readFileSync(path.join(root, roomA.agentId, "events", "memory-edit", `${undone.undoId}.json`), "utf-8"));
	assert(undoRecord.limitLoweredTo === TIGHT_BUDGET && undoRecord.budget.budgetTokens === TIGHT_BUDGET, `the undo's record says the limit went back down, got ${JSON.stringify({ limitLoweredTo: undoRecord.limitLoweredTo, budget: undoRecord.budget })}`);

	const history = buildRoomMemoryHistory(roomA.agentId);
	const reviewRow = history.find((event) => event.kind === "review" && event.id === approved.saveId);
	assert(reviewRow, `the room's history should carry the review, got ${JSON.stringify(history.map((event) => `${event.kind}:${event.id}`))}`);
	assert(reviewRow!.undone === true, "a save that was taken back stays in the history, marked");
	assert((reviewRow!.topicsTidied ?? 0) > 0 && (reviewRow!.notesChanged ?? 0) > 0, `the history row should say how much was tidied, got ${JSON.stringify(reviewRow)}`);
	assert(history.some((event) => event.kind === "undo" && event.undoneSaveId === approved.saveId), "the undo has a row of its own");

	// =====================================================================
	// Room two: cancel, while a group is still in flight.
	// =====================================================================
	const roomB = createRoom("Review Cancel Smoke Room");
	writePersistentRoomMaintenanceSettings(roomB.agentId, { memoryBudgetTokens: TIGHT_BUDGET });
	const roomBBytes = fs.readFileSync(roomB.l1bPath, "utf-8");
	let startedCalls = 0;
	const hanging: ReviewRunGenerate = async (_prompt, _model, options) => {
		startedCalls += 1;
		// The call never answers on its own: it ends when the run is cancelled,
		// which is exactly what a real turn in flight does.
		await new Promise<void>((resolve) => options.signal.addEventListener("abort", () => resolve()));
		throw new IsolatedPersistentAgentWorkerTurnError("review tidy worker", "aborted", undefined);
	};
	const runB = startReviewRun(roomB.agentId, { depth: "wording", model: MODEL, generate: hanging, resolveModelWindow: () => MODEL_WINDOW, now: RUN_CLOCK });
	await waitUntil(() => startedCalls > 0, "room two: the first tidy call");
	const cancelled = cancelReviewRun(roomB.agentId, runB.runId);
	assert(cancelled.state === "cancelled", `cancel should end the run, got ${cancelled.state}`);
	await settle(roomB.agentId, runB.runId, "room two");
	assert(getReviewRun(roomB.agentId, runB.runId).state === "cancelled", "a cancelled run stays cancelled");
	assert(fs.readFileSync(roomB.l1bPath, "utf-8") === roomBBytes, "a cancelled run writes nothing at all");
	expectThrows(() => approveReviewRun(roomB.agentId, runB.runId), /not ready/, "approving a cancelled run");
	assert(!hasActiveReviewRun(roomB.agentId), "a cancelled run releases the room");

	// A finished run is reaped once nobody has been near it for an hour.
	rewindReviewRunClockForTests(roomB.agentId, REVIEW_RUN_RETENTION_MS + 1000);
	expectThrows(() => getReviewRun(roomB.agentId, runB.runId), /no longer open/, "an abandoned run, an hour later");

	// A room with nothing to tidy says so rather than starting a run.
	// A fresh room's scaffold carries two placeholder lines; truly empty means
	// the sections are there and hold nothing.
	const roomCRoom = createRoom("Review Empty Smoke Room");
	const roomC = roomCRoom.agentId;
	fs.writeFileSync(roomCRoom.l1bPath, ["<!-- exxeta:l1b schema_version=1 -->", "", "## Chronos", "", `- Persistent agent id: ${roomC}`, "- Lifecycle state: ready", "", "## Deep Memory", "", "<!-- entries: next=1 -->", "", "## Active Items", "", "## Recent Context", "", "No checkpointed sessions yet.", ""].join("\n"), { mode: 0o600 });
	assert(reviewRunStatus(roomC).available === false && /no notes to tidy/.test(String(reviewRunStatus(roomC).reason)), `a room with no notes should say so, got ${JSON.stringify(reviewRunStatus(roomC))}`);

	// =====================================================================
	// Room four: what the machine finds on its own — two notes that say one
	// thing under two topics with a wall of notes between them, and two
	// headings that look like one topic — reaches the tidy in one call each,
	// and the fold of one topic into another lands in the file.
	// =====================================================================
	const roomD = createRoom("Review Duplicates Smoke Room", memoryFixtureD);
	writePersistentRoomMaintenanceSettings(roomD.agentId, { memoryBudgetTokens: RAISED_BUDGET });
	const callsD: WorkerCall[] = [];
	const DUPLICATE_LINE = /^- (m-\d+) and (m-\d+) say the same thing: merge them into one note, or archive one of them as duplicate\.$/m;
	const generateD: ReviewRunGenerate = async (prompt) => {
		const notes = notesFromPrompt(prompt);
		const topics = [...new Set(notes.map((note) => note.topic))];
		callsD.push({ key: topics.join("|"), topics, attempt: 1, prompt });
		const duplicate = DUPLICATE_LINE.exec(prompt);
		if (duplicate) return reply("Two notes say one thing; the later one goes to the archive as a duplicate.", [{ op: "archive", id: duplicate[2], why: "duplicate" }]);
		if (prompt.includes("## Material: Topics That Look The Same")) {
			// The fold first, then a note of the folded topic worded better: after
			// the fold the note resolves by id wherever it now sits.
			return reply("Two headings are one subject; the smaller folds into the larger, and its one note is shorter.", [
				{ op: "merge_topics", from: FOLD_FROM, into: FOLD_INTO },
				{ op: "update", id: FOLD_FROM_NOTE, text: "- The feed's checksum is verified against the manifest; a mismatch stops the run." },
			]);
		}
		return reply("These notes are already as short as they can be.", []);
	};
	// A reply budget the wall topic alone exceeds, so without bonds the two
	// twins would land in two different calls.
	const smallWindow = { contextWindow: 400_000, maxOutputTokens: 1_000 };
	const startedD = startReviewRun(roomD.agentId, { depth: "tidy", model: MODEL, generate: generateD, resolveModelWindow: () => smallWindow, now: RUN_CLOCK });
	const runD = await settle(roomD.agentId, startedD.runId, "room four");
	assert(runD.state === "ready" && runD.leftAsIs.length === 0, `room four's run should end ready with every group accepted, got ${runD.state} ${JSON.stringify(runD.leftAsIs)}${runD.error ? ` with error ${JSON.stringify(runD.error)}` : ""}`);
	assert(runD.progress.groups >= 3, `the wall topic should have split this room into several calls, got ${JSON.stringify(runD.progress)}`);

	// Bonding: the twins' topics are one call, with the wall topic in a call of its own.
	const twinCall = callsD.find((call) => call.topics.includes("Commercial terms") && call.topics.includes("Delivery practice"));
	assert(twinCall, `the two topics holding the twins should reach one call, got ${JSON.stringify(callsD.map((call) => call.key))}`);
	assert(!twinCall!.topics.includes(WALL_TOPIC), `the wall topic rides in a call of its own, got ${JSON.stringify(twinCall!.topics)}`);
	assert(callsD.some((call) => call.topics.length === 1 && call.topics[0] === WALL_TOPIC), `the wall topic is a group of its own, got ${JSON.stringify(callsD.map((call) => call.key))}`);
	assert(twinCall!.prompt.includes("## Material: Notes That Say The Same Twice\n\n- m-0101 and m-0301 say the same thing: merge them into one note, or archive one of them as duplicate."), "the twins' call carries the machine's finding, one line per pair, in the words the spec fixed");
	assert(twinCall!.prompt.includes(`Every pair listed under "Notes That Say The Same Twice" is dealt with: merge them, or archive one as duplicate, or say in the narrative why both stay.`), "the twins' call asks for every pair to be dealt with");
	assert(callsD.filter((call) => call.prompt.includes("## Material: Notes That Say The Same Twice")).length === 1, "only the call holding the pair carries the finding");

	// Look-alike topics: one call, with the finding and the operation that folds them.
	const foldCall = callsD.find((call) => call.topics.includes(FOLD_INTO) && call.topics.includes(FOLD_FROM));
	assert(foldCall, `the two headings that look like one topic should reach one call, got ${JSON.stringify(callsD.map((call) => call.key))}`);
	assert(foldCall!.prompt.includes(`## Material: Topics That Look The Same\n\n- "${FOLD_INTO}" and "${FOLD_FROM}" look like one topic: fold the one with fewer notes into the other with merge_topics, unless they are two subjects after all.`), "the look-alike call carries the machine's finding in the words the spec fixed");
	assert(foldCall!.prompt.includes('"op":"merge_topics"'), "the tidy offers the fold operation");

	// The card's rows.
	const duplicateRow = runD.changes.find((change) => change.kind === "archived" && change.id === "m-0301");
	assert(duplicateRow?.why === "duplicate", `the later twin leaves as a duplicate, got ${JSON.stringify(duplicateRow)}`);
	assert(JSON.stringify(duplicateRow?.duplicateOf) === JSON.stringify({ id: "m-0101", topic: "Commercial terms" }), `a note archived as a machine-found duplicate names the note that already says it and its topic, got ${JSON.stringify(duplicateRow?.duplicateOf)}`);
	assert(runD.changes.filter((change) => change.kind === "archived" && change.id !== "m-0301").every((change) => change.duplicateOf === undefined), "no other row names a duplicate partner");
	const foldedRow = runD.changes.find((change) => change.kind === "topic_folded");
	assert(foldedRow && foldedRow.id === FOLD_FROM_NOTE && foldedRow.section === "Deep Memory" && foldedRow.topic === FOLD_INTO && foldedRow.before === FOLD_FROM && foldedRow.after === FOLD_INTO && foldedRow.notesMoved === 1, `a fold is one row naming the first note moved, the topic folded and the topic it went into, got ${JSON.stringify(foldedRow)}`);
	const wordedRow = runD.changes.find((change) => change.kind === "shortened" && change.id === FOLD_FROM_NOTE);
	assert(wordedRow?.topic === FOLD_INTO, `a note of the folded topic worded better in the same reply still applies, under the topic it now sits in, got ${JSON.stringify(wordedRow)}`);

	// The write: no empty heading, the note moved with its pin, the twin in the archive.
	const approvedD = approveReviewRun(roomD.agentId, runD.runId, APPROVED_AT);
	assert(approvedD.topicsTidied === 2 && approvedD.notesChanged === 3, `the saved screen counts the folded-into topic once, got ${JSON.stringify({ topicsTidied: approvedD.topicsTidied, notesChanged: approvedD.notesChanged })}`);
	const writtenD = fs.readFileSync(roomD.l1bPath, "utf-8");
	assert(!writtenD.includes(`### ${FOLD_FROM}`), "the folded heading is gone from the file");
	const deepD = writtenD.slice(writtenD.indexOf("## Deep Memory"), writtenD.indexOf("## Active Items"));
	for (const block of deepD.split(/^### /m).slice(1)) assert(block.includes("<!-- e:"), `no heading is left empty by the fold, and "${block.split("\n")[0]}" is`);
	const intoBlock = deepD.slice(deepD.indexOf(`### ${FOLD_INTO}\n`));
	const intoOnly = intoBlock.slice(0, intoBlock.indexOf("\n### ") > 0 ? intoBlock.indexOf("\n### ") : intoBlock.length);
	assert(intoOnly.includes(`id=${FOLD_FROM_NOTE} `) && /pinned=true/.test(intoOnly.slice(intoOnly.indexOf(`id=${FOLD_FROM_NOTE} `))) && intoOnly.includes("a mismatch stops the run."), `the moved note sits under the topic it was folded into, pin and new words intact, got ${JSON.stringify(intoOnly.slice(-400))}`);
	assert(intoOnly.indexOf("id=m-0402 ") < intoOnly.indexOf(`id=${FOLD_FROM_NOTE} `), "the moved note is appended after the notes the topic already had");
	assert(!writtenD.includes("usual escalation route") && writtenD.includes(TWIN_A), "the later twin left the core and the earlier one stayed");
	assert(readArchive(roomD.agentId).some((row) => row.id === "m-0301" && row.why === "duplicate"), "the twin is in the archive as a duplicate");

	resetReviewRunsForTests();
	console.log(`review-run-smoke: OK (${calls.length + callsD.length} scripted model calls)`);
} catch (error) {
	console.error(error instanceof Error ? error.stack || error.message : error);
	console.error(`temp home preserved for inspection: ${tempHome}`);
	console.error(`scripted calls: ${JSON.stringify(calls.map((call) => ({ key: call.key, attempt: call.attempt })))}`);
	process.exitCode = 1;
} finally {
	if (process.exitCode !== 1) fs.rmSync(tempHome, { recursive: true, force: true });
}
