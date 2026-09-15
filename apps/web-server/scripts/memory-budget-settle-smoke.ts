// The budget starts where the room is (memory v2).
//
// A room that comes to the entry model from 0.11.2 carrying 60k of memory
// meets the 20k default budget on its first Memorize, and the budget rule
// would offer two thirds of its notes to the archive on day one. So the first
// time a room's budget is read against its own file, a room that still has
// the default budget and a file nobody has migrated gets a budget of its size
// plus a quarter, and every other room keeps what it has. Five promises are
// read off the files here:
//   1. an unmigrated room at ~60k with the default budget settles at 75k, the
//      memory file untouched, and a second call writes nothing;
//   2. the same room with a budget set by hand in 0.11.2 keeps that budget;
//   3. a migrated room at 60k with the default budget keeps 20k;
//   4. an unmigrated room under 20k keeps 20k;
//   5. a Memorize on room 1 reads the room under its budget and its card lists
//      no note leaving for the budget.
//
// Offline, temp HOME, the real writers: the settings module, the checkpoint
// gate, a scripted Memorize run. No model, no network, no port.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { AbsorbRunGenerate } from "../src/absorb-run.js";

const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "memory-budget-settle-smoke-home-"));
const agentDir = path.join(tempHome, ".exxperts", "agent");
const smokeAppDir = path.join(tempHome, ".exxperts", "app");
const root = path.join(smokeAppDir, "personalized-agents");
process.env.HOME = tempHome;
process.env.USERPROFILE = tempHome;
fs.mkdirSync(smokeAppDir, { recursive: true });
fs.mkdirSync(agentDir, { recursive: true, mode: 0o700 });
fs.writeFileSync(
	path.join(smokeAppDir, "openai-compatible-ai-profile.json"),
	JSON.stringify({ profileId: "openai-compatible", providerId: "openai-compatible", label: "Synthetic Gateway", roomModels: [{ modelId: "gpt-5.5" }], maintenanceModel: "gpt-5.5" }, null, 2),
);
fs.writeFileSync(path.join(smokeAppDir, "persistent-agent-ai-profile.json"), JSON.stringify({ profileId: "openai-compatible" }, null, 2));
process.env.EXXPERTS_CODING_AGENT_DIR = agentDir;
process.env.EXXETA_PERSISTENT_AGENTS_ROOT = root;

const { getAbsorbRun, startAbsorbRun } = await import("../src/absorb-run.js");
const {
	buildPersistentAgentCheckpointTranscriptSource,
	createPersistentAgentFromScaffoldInput,
	getPersistentAgentStatus,
	parseCheckpointApprovalRequest,
	reviewTargetEstimatedTokensFromL1b,
	writeApprovedCheckpoint,
	writePersistentAgentThread,
} = await import("../src/persistent-agents.js");
const { settleMemoryBudget } = await import("../src/memory-entries-store.js");
const { isMigratedMemoryDocument } = await import("../src/memory-entries.js");
const { MEMORY_BUDGET_DEFAULT_TOKENS, persistentRoomMaintenanceSettingsPath, readPersistentRoomMaintenanceSettings } = await import("../src/persistent-room-maintenance-settings.js");

const MODEL = { provider: "openai-compatible", model: "gpt-5.5", label: "GPT-5.5" };
const RUN_DAY = "2026-09-14";
const RUN_CLOCK = () => new Date(`${RUN_DAY}T08:00:00.000Z`);
const REMEMBER_AT = new Date(`${RUN_DAY}T09:00:00.000Z`);

const TOPICS = ["Commercial terms", "Delivery practice", "Reporting rhythm", "Working style"];
const SETTLED_TOKENS = 75_000;
// The size that settles at 75k: ceil(size * 1.25 / 1000) * 1000 lands on 75k for a size in (59,200, 60,000].
const SIZE_FLOOR_TOKENS = 59_300;
const SIZE_CEILING_TOKENS = 60_000;
const SMALL_ROOM_NOTES = 12;

const CONVERSATION_TITLE = "Quarter close agreed";
const FOLDED_NOTE = "- The quarter closes on the last working day of March, finance and the account team both signed off on it.";
const ASSESSMENT = ["## What these sessions leave behind", "", "- One commercial fact to keep."].join("\n");

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

// --- Fixtures -----------------------------------------------------------------

function noteText(topic: string, n: number): string {
	return `- ${topic}, account ${n}: the agreed rate, the renewal month, the signing route and the escalation path are kept here together with the reporting rhythm the account team settled on, so a later conversation does not have to rediscover any of it.`;
}

/** A room's memory the way 0.11.2 left it: no entry ids, "(saved …)" stamps. */
function legacyFixture(agentId: string, notesPerTopic: number): string {
	const topics = TOPICS.map((topic) => {
		const notes = Array.from({ length: notesPerTopic }, (_, i) => `${noteText(topic, i + 1)} (saved 2026-03-1${i % 9})`);
		return `### ${topic}\n\n${notes.join("\n")}\n`;
	});
	return [
		"<!-- exxeta:l1b schema_version=1 -->",
		"",
		"## Chronos",
		"",
		`- Persistent agent id: ${agentId}`,
		"- Lifecycle state: ready",
		"- Last checkpoint: none",
		"- Last consolidation: none",
		"",
		"## Deep Memory",
		"",
		...topics,
		"## Active Items",
		"",
		"- Confirm the invoicing day with finance before the quarter closes. (saved 2026-03-10)",
		"",
		"## Recent Context",
		"",
		"No checkpointed sessions yet.",
		"",
	].join("\n");
}

/** The same memory already on the entry model: an id counter and one metadata line per note. */
function migratedFixture(agentId: string, notesPerTopic: number): string {
	let next = 1;
	const topics = TOPICS.map((topic) => {
		const notes = Array.from({ length: notesPerTopic }, (_, i) => `<!-- e: id=m-${String(next++).padStart(4, "0")} kind=fact saved=2026-03-1${i % 9} refs=0 -->\n${noteText(topic, i + 1)}\n`);
		return `### ${topic}\n\n${notes.join("")}`;
	});
	return [
		"<!-- exxeta:l1b schema_version=1 -->",
		"",
		"## Chronos",
		"",
		`- Persistent agent id: ${agentId}`,
		"- Lifecycle state: ready",
		"- Last checkpoint: none",
		"- Last consolidation: none",
		"",
		"## Deep Memory",
		"",
		`<!-- entries: next=${TOPICS.length * notesPerTopic + 1} -->`,
		"",
		...topics,
		"## Active Items",
		"",
		`<!-- e: id=m-${String(next).padStart(4, "0")} kind=item saved=2026-03-10 status=open refs=0 -->`,
		"- Confirm the invoicing day with finance before the quarter closes.",
		"",
		"## Recent Context",
		"",
		"No checkpointed sessions yet.",
		"",
	].join("\n");
}

/** The largest notes-per-topic count whose legacy fixture measures at most the ceiling; one note is ~50 tokens, so it lands inside the window. */
function notesPerTopicFor(agentId: string): number {
	let low = 1;
	let high = 2_000;
	while (low < high) {
		const mid = Math.ceil((low + high) / 2);
		if (reviewTargetEstimatedTokensFromL1b(legacyFixture(agentId, mid)) <= SIZE_CEILING_TOKENS) low = mid;
		else high = mid - 1;
	}
	return low;
}

const l1bPathOf = (room: string) => path.join(root, room, "L1b", "current.md");
const readL1b = (room: string) => fs.readFileSync(l1bPathOf(room), "utf-8");
const readSettingsFile = (room: string) => fs.readFileSync(persistentRoomMaintenanceSettingsPath(room), "utf-8");
/** What the room's history holds: archived copies of the memory file and memory-edit records. */
const recordedWrites = (room: string): string => {
	const list = (dir: string) => (fs.existsSync(dir) ? fs.readdirSync(dir).sort() : []);
	return JSON.stringify({ archive: list(path.join(root, room, "L1b", "archive")), edits: list(path.join(root, room, "events", "memory-edit")) });
};

/** A room as an upgrade finds it: the memory file as written, and the settings file the way 0.11.2 wrote it, which never carried memoryBudgetSettled. */
function createRoom(displayName: string, fixture: (agentId: string) => string, budgetTokens = MEMORY_BUDGET_DEFAULT_TOKENS): string {
	const created = createPersistentAgentFromScaffoldInput({ displayName, userName: "Synthetic User", preferredUserAddress: "Synthetic User" });
	const agentId = created.agent.agentId;
	fs.writeFileSync(l1bPathOf(agentId), fixture(agentId), { mode: 0o600 });
	const settingsPath = persistentRoomMaintenanceSettingsPath(agentId);
	fs.mkdirSync(path.dirname(settingsPath), { recursive: true, mode: 0o700 });
	fs.writeFileSync(settingsPath, JSON.stringify({ schemaVersion: 1, fastPathSecondApproval: false, quickCheckpointAutoApply: false, memoryBudgetTokens: budgetTokens, updatedAt: "2026-09-01T00:00:00.000Z" }, null, 2) + "\n", { mode: 0o600 });
	const before = readPersistentRoomMaintenanceSettings(agentId);
	assert(before.memoryBudgetSettled === false && before.memoryBudgetTokens === budgetTokens, `a settings file without the field reads as not settled, got ${JSON.stringify(before)}`);
	return agentId;
}

// --- The checkpoint gate: a Remember, the way the app writes one ---------------

function remember(room: string, title: string, body: string[], now: Date): string {
	const conversationId = `c_${Math.random().toString(36).slice(2, 8)}`;
	const transcriptItem = { kind: "user", id: "u1", text: `Synthetic transcript for ${conversationId}.` };
	writePersistentAgentThread(room, conversationId, { state: "active", origin: "home", model: MODEL, items: [transcriptItem] });
	const source = buildPersistentAgentCheckpointTranscriptSource({ agentId: room, conversationId, l1b: readL1b(room), legacyItems: [transcriptItem] }).source;
	const approvedRecentContext = [
		`### RC-DRAFT | CLOSED | ${RUN_DAY} | ${title}`,
		"",
		`**Session arc:** ${title}.`,
		"",
		"**Body:**",
		...body.map((line) => `- ${line}`),
		"",
		"**Parked:**",
		"Nothing parked.",
		"",
	].join("\n");
	const parsed = parseCheckpointApprovalRequest({
		conversationId,
		model: MODEL,
		density: "compact",
		proposal: { agentId: room, conversationId, sessionId: null, writesMemory: false, source },
		approvedRecentContext,
	}, room);
	return writeApprovedCheckpoint(parsed.request, parsed.warnings, now).checkpointId;
}

// --- The scripted Memorize -------------------------------------------------------

const scriptedGenerate: AbsorbRunGenerate = async (prompt) => {
	if (prompt.includes(CONVERSATION_TITLE)) {
		return {
			text: ["Folded into memory.", "", "```json", JSON.stringify({ ops: [{ op: "add", topic: "Commercial terms", kind: "fact", text: FOLDED_NOTE }] }, null, 2), "```", ""].join("\n"),
			usage: { input: 2400, output: 240, totalTokens: 2640 },
		};
	}
	return { text: "I have folded that discussion into memory for you.", usage: { input: 2400, output: 40, totalTokens: 2440 } };
};

const WORKING_STATES = new Set(["prepass", "folding", "budget"]);

async function memorizeToReady(room: string) {
	const started = startAbsorbRun({ agentId: room, assessmentMarkdown: ASSESSMENT, model: MODEL, generate: scriptedGenerate, now: RUN_CLOCK });
	const deadline = Date.now() + 60_000;
	let run = getAbsorbRun(room, started.runId);
	while (WORKING_STATES.has(run.state)) {
		assert(Date.now() < deadline, `the Memorize run was still in state "${run.state}" after 60 seconds`);
		await sleep(2);
		run = getAbsorbRun(room, started.runId);
	}
	assert(run.state === "ready", `a scripted Memorize run ends ready for approval, got "${run.state}"${run.error ? ` with "${run.error}"` : ""}`);
	return run;
}

// --- The smoke ------------------------------------------------------------------------

try {
	const probeId = "probe";
	const notesPerTopic = notesPerTopicFor(probeId);
	const probeSize = reviewTargetEstimatedTokensFromL1b(legacyFixture(probeId, notesPerTopic));
	assert(probeSize > SIZE_FLOOR_TOKENS && probeSize <= SIZE_CEILING_TOKENS, `the fixture measures about 60k, got ${probeSize} with ${notesPerTopic} notes per topic`);
	assert(!isMigratedMemoryDocument(legacyFixture(probeId, notesPerTopic)) && isMigratedMemoryDocument(migratedFixture(probeId, notesPerTopic)), "the two fixtures sit on either side of the migration");

	// 1. An unmigrated room at ~60k with the default budget: the budget starts
	//    at the room's size plus a quarter, the memory file is not touched, and
	//    the question is asked once.
	const room1 = createRoom("Memory Budget Settle Smoke Room", (id) => legacyFixture(id, notesPerTopic));
	const bytes1 = readL1b(room1);
	const size1 = reviewTargetEstimatedTokensFromL1b(bytes1);
	const writesBefore = recordedWrites(room1);
	const first = settleMemoryBudget(room1);
	assert(first.settled === true && first.from === MEMORY_BUDGET_DEFAULT_TOKENS && first.to === SETTLED_TOKENS, `a 0.11.2 room of ${size1} tokens settles at 75k, got ${JSON.stringify(first)}`);
	const settings1 = readPersistentRoomMaintenanceSettings(room1);
	assert(settings1.memoryBudgetTokens === SETTLED_TOKENS && settings1.memoryBudgetSettled === true, `the settings carry the settled budget and the mark, got ${JSON.stringify(settings1)}`);
	assert(settings1.memoryBudgetSettledTo === SETTLED_TOKENS, `the settings remember what the settle chose, got ${JSON.stringify(settings1)}`);
	assert(readL1b(room1) === bytes1, "settling the budget leaves the memory file byte for byte as it was");
	assert(recordedWrites(room1) === writesBefore, `settling the budget records no memory edit and archives no copy, got ${recordedWrites(room1)} against ${writesBefore}`);
	const settingsBytes1 = readSettingsFile(room1);
	const second = settleMemoryBudget(room1);
	assert(second.settled === false && second.from === SETTLED_TOKENS && second.to === SETTLED_TOKENS, `the second call changes nothing, got ${JSON.stringify(second)}`);
	assert(readSettingsFile(room1) === settingsBytes1, "the second call writes nothing: one settings write per room, ever");
	const status1 = getPersistentAgentStatus(room1);
	assert(status1.memoryBudget?.budgetTokens === SETTLED_TOKENS && status1.memoryBudget.overBudget === false, `the room status reads the settled budget and the room under it, got ${JSON.stringify(status1.memoryBudget)}`);

	// 2. The same room with a budget the person set in 0.11.2: theirs, unchanged.
	const room2 = createRoom("Memory Budget Settle Hand-Set Smoke Room", (id) => legacyFixture(id, notesPerTopic), 30_000);
	const handSet = settleMemoryBudget(room2);
	assert(handSet.settled === false && handSet.from === 30_000 && handSet.to === 30_000, `a budget set by hand in 0.11.2 is kept, got ${JSON.stringify(handSet)}`);
	const settings2 = readPersistentRoomMaintenanceSettings(room2);
	assert(settings2.memoryBudgetTokens === 30_000 && settings2.memoryBudgetSettled === true, `the hand-set room is marked settled at its own budget, got ${JSON.stringify(settings2)}`);
	assert(settings2.memoryBudgetSettledTo === undefined, `a budget the settle left alone records no settled-to value, got ${JSON.stringify(settings2)}`);

	// 3. A migrated room at 60k with the default budget: already on 0.12, never resized.
	const room3 = createRoom("Memory Budget Settle Migrated Smoke Room", (id) => migratedFixture(id, notesPerTopic));
	const size3 = reviewTargetEstimatedTokensFromL1b(readL1b(room3));
	// The same notes without their stamps measure a little less; what matters is that the room is far past the default.
	assert(size3 > 2 * MEMORY_BUDGET_DEFAULT_TOKENS, `the migrated room measures far past the default too, got ${size3}`);
	const migrated = settleMemoryBudget(room3);
	assert(migrated.settled === false && migrated.from === MEMORY_BUDGET_DEFAULT_TOKENS && migrated.to === MEMORY_BUDGET_DEFAULT_TOKENS, `a room already on the entry model keeps the default, got ${JSON.stringify(migrated)}`);
	const settings3 = readPersistentRoomMaintenanceSettings(room3);
	assert(settings3.memoryBudgetTokens === MEMORY_BUDGET_DEFAULT_TOKENS && settings3.memoryBudgetSettled === true, `the migrated room is marked settled at the default, got ${JSON.stringify(settings3)}`);

	// 4. An unmigrated room under 20k: the default already holds it.
	const room4 = createRoom("Memory Budget Settle Small Smoke Room", (id) => legacyFixture(id, SMALL_ROOM_NOTES));
	const size4 = reviewTargetEstimatedTokensFromL1b(readL1b(room4));
	assert(size4 < MEMORY_BUDGET_DEFAULT_TOKENS, `the small room measures under the default, got ${size4}`);
	const small = settleMemoryBudget(room4);
	assert(small.settled === false && small.from === MEMORY_BUDGET_DEFAULT_TOKENS && small.to === MEMORY_BUDGET_DEFAULT_TOKENS, `a small 0.11.2 room keeps the default, got ${JSON.stringify(small)}`);
	const settings4 = readPersistentRoomMaintenanceSettings(room4);
	assert(settings4.memoryBudgetTokens === MEMORY_BUDGET_DEFAULT_TOKENS && settings4.memoryBudgetSettled === true, `the small room is marked settled at the default, got ${JSON.stringify(settings4)}`);

	// 5. A Memorize on room 1: the first read finds the room under its budget,
	//    and the card lists no note leaving for the budget.
	remember(room1, CONVERSATION_TITLE, ["The quarter closes on the last working day of March; finance and the account team signed off."], REMEMBER_AT);
	const statusBefore = getPersistentAgentStatus(room1);
	assert(statusBefore.memoryBudget?.overBudget === false && statusBefore.memoryBudget.budgetTokens === SETTLED_TOKENS, `the first read finds the room under its settled budget, got ${JSON.stringify(statusBefore.memoryBudget)}`);
	const run = await memorizeToReady(room1);
	assert(run.budget.budgetTokens === SETTLED_TOKENS && run.budget.savedBudgetTokens === SETTLED_TOKENS, `the run measures against the settled budget, got ${JSON.stringify(run.budget)}`);
	assert(run.budget.before <= SETTLED_TOKENS && run.budget.overBudgetAfter === false, `the room is inside its budget before and after the fold, got ${JSON.stringify(run.budget)}`);
	assert(run.prepass.demoted.length === 0, `nothing leaves before the fold, got ${run.prepass.demoted.length} rows`);
	assert(run.demotion.entries.length === 0 && run.demotion.counts.leaving === 0, `the card lists no budget archive rows, got ${JSON.stringify(run.demotion.counts)}`);
	assert(run.sessions.length === 1 && run.sessions[0].outcome === "folded", `the one waiting conversation folds, got ${JSON.stringify(run.sessions)}`);
	assert(readL1b(room1) !== bytes1 && readL1b(room1).includes(CONVERSATION_TITLE), "a run that has not been saved leaves the file with the Remember and nothing else");

	console.log(`memory budget settle smoke passed: a 0.11.2 room of ${size1} tokens starts at 75k, a hand-set budget and a migrated room keep theirs, a small room keeps the default, and the first Memorize archives nothing for the budget`);
} finally {
	fs.rmSync(tempHome, { recursive: true, force: true });
}
