// What changed, the memory as of a moment, and the conversations a room has
// kept — on real rooms in a temp HOME, then over the real routes (memory v2).
//
// Four promises are read off the files here, never off the code. First, the
// snapshot chain knows every recorded write: a hand edit between two saves is
// a state of its own, so the diff of the save before it stops at the edit and
// the memory as of a moment after it shows the edit. Second, "What changed" is
// served for every history row — the save, the hand edit, the undo — note by
// note: added, updated, archived, and the conversations that left or came
// back. Third, the conversations list names every checkpoint the room kept,
// says which still wait, and stops offering a transcript whose file is gone.
// Fourth, the first save of a room that still carries "(saved …)" stamps and
// no entry ids reads as the one note it added, not as every line rewritten.
// Fifth, a note the budget pass archived says why in the ranking's own words,
// the same words the save's record carries, and no other archived row does.
//
// The writers are the real ones: the checkpoint gate, a scripted Memorize run,
// the entries store, the undo. The first half runs in-process; the second
// spawns the web server and reads the same room over HTTP.

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { AbsorbRunGenerate } from "../src/absorb-run.js";
import { authedFetch, SMOKE_SERVER_AUTH_ENV, SMOKE_SERVER_SPAWN_TREE_OPTIONS, stopSmokeServer } from "./smoke-server-process.js";

const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "memory-history-diff-smoke-home-"));
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const webServerDir = path.resolve(scriptDir, "..");
const repoRoot = path.resolve(webServerDir, "..", "..");
const port = 24000 + Math.floor(Math.random() * 10000);
const baseUrl = `http://127.0.0.1:${port}`;
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

const { approveAbsorbRun, getAbsorbRun, startAbsorbRun } = await import("../src/absorb-run.js");
const {
	buildPersistentAgentCheckpointTranscriptSource,
	createPersistentAgentFromScaffoldInput,
	createPersistentAgentInstance,
	parseCheckpointApprovalRequest,
	writeApprovedCheckpoint,
	writePersistentAgentThread,
} = await import("../src/persistent-agents.js");
const { MEMORY_BUDGET_MIN_TOKENS, writePersistentRoomMaintenanceSettings } = await import("../src/persistent-room-maintenance-settings.js");
const { applyUserEdit } = await import("../src/memory-entries.js");
const { loadMemoryDocument, writeMemoryDocument } = await import("../src/memory-entries-store.js");
const { buildRoomMemoryHistory, diffNotesOf, listMemoryConversations, readMemoryEventDiff, readMemoryNotesView, readMemorySnapshotAt } = await import("../src/memory-api.js");
const { undoMemorySave } = await import("../src/memory-undo.js");

const MODEL = { provider: "openai-compatible", model: "gpt-5.5", label: "GPT-5.5" };
const RUN_DAY = "2026-09-13";
const RUN_CLOCK = () => new Date(`${RUN_DAY}T08:00:00.000Z`);
const at = (clock: string) => new Date(`${RUN_DAY}T${clock}:00.000Z`);
// The six writes, in order, each a minute or more apart.
const CP1_AT = at("09:00");
const SAVE1_AT = at("09:05");
const EDIT_AT = at("09:10");
const CP2_AT = at("09:12");
const SAVE2_AT = at("09:15");
const UNDO_AT = at("09:20");
// The second room's two writes.
const CP3_AT = at("10:00");
const SAVE3_AT = at("10:05");
// The third room's two writes.
const CP4_AT = at("11:00");
const SAVE4_AT = at("11:05");

const TITLE_1 = "Addendum signed";
const TITLE_2 = "Reporting rhythm agreed";
const TITLE_3 = "Invoice day settled";
const TITLE_4 = "Warehouse lease renewed";
const ORIGINAL_STYLE_TEXT = "- Commercial summaries go out as one page, numbers first.";
const EDITED_TEXT = "- Commercial summaries go out as one page, numbers first and no preamble.";
const SAVE1_NOTE = "- The signed addendum of 2026-09-11 is what the delivery window now follows, and the vendor has it on file.";
const SAVE1_SUPERSEDED_TEXT = "- The delivery window is four weeks from the day the order is signed, as the signed addendum sets it out.";
const SAVE2_NOTE = "- The reporting pack goes out on the first working day of the month, one page, numbers first.";
const SAVE3_NOTE = "- Invoices go out on the first working day of the month, finance confirmed it.";
const SAVE4_NOTE = "- The warehouse lease runs another three years from October at the rent already in the plan.";

const ASSESSMENT = ["## What these sessions leave behind", "", "- One commercial fact changed and one item was finished."].join("\n");

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

// --- Fixtures -----------------------------------------------------------------

function entryLine(id: string, kind: string, saved: string, text: string, extra = ""): string {
	return `<!-- e: id=${id} kind=${kind} saved=${saved}${extra ? ` ${extra}` : ""} refs=0 -->\n${text}\n`;
}

/** A room's memory as it stands before anything happens: entry ids in place, nothing waiting. */
function memoryFixture(agentId: string): string {
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
		"<!-- entries: next=300 -->",
		"",
		"### Commercial terms",
		"",
		entryLine("m-0001", "fact", "2026-09-01", "- The pricing arrangement follows the volume schedule agreed in September."),
		entryLine("m-0002", "fact", "2026-09-01", "- The delivery window is six weeks from the day the order is signed."),
		"### Working style",
		"",
		entryLine("m-0003", "practice", "2026-09-02", ORIGINAL_STYLE_TEXT),
		"## Active Items",
		"",
		entryLine("m-0201", "item", "2026-09-01", "- Chase the vendor for the signed addendum.", "status=open"),
		entryLine("m-0202", "item", "2026-09-02", "- Confirm the invoicing day with finance before the quarter closes.", "status=open"),
		"## Recent Context",
		"",
		"No checkpointed sessions yet.",
		"",
	].join("\n");
}

/** A room's memory the way 0.11.2 left it: no entry ids, "(saved …)" stamps, the scaffold's opening paragraph still in place. */
function legacyMemoryFixture(agentId: string): string {
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
		"Durable understanding is still forming. What is known so far comes from the scaffolded identity.",
		"",
		"### Commercial terms",
		"",
		"- The pricing arrangement follows the volume schedule agreed in March. (saved 2026-03-10)",
		"- The delivery window is six weeks from the day the order is signed. (saved 2026-03-10)",
		"",
		"### Working style",
		"",
		"- Commercial summaries go out as one page, numbers first. (saved 2026-03-12)",
		"",
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

/** How many supplier notes the full room carries; each is a few hundred characters, so the review target sits well over the budget floor. */
const FULL_ROOM_NOTES = 170;

/** A room's memory over the budget floor: many unpinned fact notes, none of them ever recalled, all saved months before the run. */
function fullMemoryFixture(agentId: string): string {
	const cities = ["Hamburg", "Lyon", "Porto", "Gdansk", "Turin", "Ghent", "Malmo"];
	const notes: string[] = [];
	for (let n = 1; n <= FULL_ROOM_NOTES; n += 1) {
		const id = `m-${String(n).padStart(4, "0")}`;
		const saved = `2026-0${2 + (n % 3)}-${String(1 + (n % 27)).padStart(2, "0")}`;
		const city = cities[n % cities.length];
		notes.push(entryLine(id, "fact", saved, `- Supplier ${n} ships from ${city} on a ${n % 2 ? "weekly" : "fortnightly"} cadence, invoices net ${30 + (n % 4) * 15} days, and the contact of record is the account lead named in the onboarding pack; the volume schedule for supplier ${n} was agreed in the spring review and holds until the next renewal, with a ${5 + (n % 6)} percent rebate once the quarterly volume clears the threshold in the schedule.`));
	}
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
		"<!-- entries: next=300 -->",
		"",
		"### Suppliers",
		"",
		...notes,
		"## Active Items",
		"",
		entryLine("m-0201", "item", "2026-09-01", "- Confirm the lease renewal terms with the landlord's agent.", "status=open"),
		"## Recent Context",
		"",
		"No checkpointed sessions yet.",
		"",
	].join("\n");
}

function approvedEntry(title: string, body: string[]): string {
	return [
		`### RC-DRAFT | CLOSED | 2026-09-11 | ${title}`,
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
}

const created = createPersistentAgentFromScaffoldInput({ displayName: "Memory History Diff Smoke Room", userName: "Synthetic User", preferredUserAddress: "Synthetic User" });
const agentId = created.agent.agentId;
const l1bPath = path.join(root, agentId, "L1b", "current.md");
fs.writeFileSync(l1bPath, memoryFixture(agentId), { mode: 0o600 });

const l1bPathOf = (room: string) => path.join(root, room, "L1b", "current.md");
const readL1b = (room: string = agentId) => fs.readFileSync(l1bPathOf(room), "utf-8");

// --- The checkpoint gate: a Remember, the way the app writes one ---------------

function remember(title: string, body: string[], now: Date, room: string = agentId): { checkpointId: string; conversationId: string } {
	const conversationId = `c_${Math.random().toString(36).slice(2, 8)}`;
	const transcriptItem = { kind: "user", id: "u1", text: `Synthetic transcript for ${conversationId}.` };
	writePersistentAgentThread(room, conversationId, { state: "active", origin: "home", model: MODEL, items: [transcriptItem] });
	const source = buildPersistentAgentCheckpointTranscriptSource({ agentId: room, conversationId, l1b: readL1b(room), legacyItems: [transcriptItem] }).source;
	const parsed = parseCheckpointApprovalRequest({
		conversationId,
		model: MODEL,
		density: "compact",
		proposal: { agentId: room, conversationId, sessionId: null, writesMemory: false, source },
		approvedRecentContext: approvedEntry(title, body),
	}, room);
	const written = writeApprovedCheckpoint(parsed.request, parsed.warnings, now);
	return { checkpointId: written.checkpointId, conversationId };
}

// --- The scripted Memorize -------------------------------------------------------

function foldReply(ops: unknown[]): { text: string; usage: { input: number; output: number; totalTokens: number } } {
	return {
		text: ["Folded into memory.", "", "```json", JSON.stringify({ ops }, null, 2), "```", ""].join("\n"),
		usage: { input: 2400, output: 240, totalTokens: 2640 },
	};
}

/** The first save: one add, one superseded entry, one finished item. The second: one add only. The second room's save: one add into a topic that has no ids yet. */
const FOLD_OPS_1 = [
	{ op: "add", topic: "Commercial terms", kind: "fact", text: SAVE1_NOTE },
	{ op: "supersede", id: "m-0002", text: SAVE1_SUPERSEDED_TEXT },
	{ op: "close", id: "m-0201" },
];
const FOLD_OPS_2 = [{ op: "add", topic: "Commercial terms", kind: "fact", text: SAVE2_NOTE }];
const FOLD_OPS_3 = [{ op: "add", topic: "Commercial terms", kind: "fact", text: SAVE3_NOTE }];
/** The full room's save: one add; the budget pass does the rest. */
const FOLD_OPS_4 = [{ op: "add", topic: "Suppliers", kind: "fact", text: SAVE4_NOTE }];

const scriptedGenerate: AbsorbRunGenerate = async (prompt) => {
	if (prompt.includes(TITLE_1)) return foldReply(FOLD_OPS_1);
	if (prompt.includes(TITLE_2)) return foldReply(FOLD_OPS_2);
	if (prompt.includes(TITLE_3)) return foldReply(FOLD_OPS_3);
	if (prompt.includes(TITLE_4)) return foldReply(FOLD_OPS_4);
	return { text: "I have folded that discussion into memory for you.", usage: { input: 2400, output: 40, totalTokens: 2440 } };
};

const WORKING_STATES = new Set(["prepass", "folding", "budget"]);

async function memorize(now: Date, room: string = agentId): Promise<string> {
	const started = startAbsorbRun({ agentId: room, assessmentMarkdown: ASSESSMENT, model: MODEL, generate: scriptedGenerate, now: RUN_CLOCK });
	const deadline = Date.now() + 60_000;
	let run = getAbsorbRun(room, started.runId);
	while (WORKING_STATES.has(run.state)) {
		assert(Date.now() < deadline, `the Memorize run was still in state "${run.state}" after 60 seconds`);
		await sleep(2);
		run = getAbsorbRun(room, started.runId);
	}
	assert(run.state === "ready", `a scripted Memorize run ends ready for approval, got "${run.state}"${run.error ? ` with "${run.error}"` : ""}`);
	return approveAbsorbRun(room, started.runId, now).saveId;
}

/** Every row of a diff, topic name beside each, in the order the diff gives them. */
function rowsOf(diff: { topics: ReadonlyArray<{ section: string; changes: ReadonlyArray<object> }> }): Array<Record<string, unknown> & { section: string }> {
	return diff.topics.flatMap((topic) => topic.changes.map((change) => ({ ...change, section: topic.section })));
}

// --- The server half ----------------------------------------------------------------

function smokeEnv(): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = { ...process.env };
	for (const key of ["ANTHROPIC_API_KEY", "ANTHROPIC_OAUTH_TOKEN", "OPENAI_API_KEY", "AZURE_OPENAI_API_KEY", "EXXETA_AI_API_KEY", "COPILOT_GITHUB_TOKEN", "GH_TOKEN", "GITHUB_TOKEN", "GEMINI_API_KEY", "GOOGLE_CLOUD_API_KEY", "OPENROUTER_API_KEY"]) {
		delete env[key];
	}
	env.PORT = String(port);
	Object.assign(env, SMOKE_SERVER_AUTH_ENV);
	env.EXXETA_HOME = repoRoot;
	return env;
}

async function waitForServer(server: ChildProcessWithoutNullStreams): Promise<void> {
	const deadline = Date.now() + 30_000;
	let lastError = "server did not respond";
	while (Date.now() < deadline) {
		if (server.exitCode != null) throw new Error(`server exited before startup with code ${server.exitCode}`);
		try {
			const response = await fetch(`${baseUrl}/healthz`);
			if (response.ok) return;
			lastError = `healthz returned ${response.status}`;
		} catch (error) {
			lastError = (error as Error).message;
		}
		await sleep(150);
	}
	throw new Error(`server did not become ready: ${lastError}`);
}

async function requestJson(pathname: string): Promise<{ status: number; body: any }> {
	const response = await authedFetch(`${baseUrl}${pathname}`);
	const text = await response.text();
	return { status: response.status, body: text ? JSON.parse(text) : null };
}

// --- The smoke ------------------------------------------------------------------------

let server: ChildProcessWithoutNullStreams | null = null;
const serverOutput: string[] = [];

try {
	// 1. A Remember: the conversation waits, with a transcript to open.
	const cp1 = remember(TITLE_1, ["The vendor returned the signed addendum, so that chase is finished.", "The delivery window is now four weeks from the day the order is signed."], CP1_AT);
	let conversations = listMemoryConversations(agentId);
	assert(conversations.length === 1 && conversations[0].checkpointId === cp1.checkpointId, `one kept conversation after one Remember, got ${JSON.stringify(conversations)}`);
	assert(conversations[0].waiting === true && conversations[0].conversation === true && conversations[0].title === TITLE_1 && conversations[0].approvedAt === CP1_AT.toISOString(), `the row waits, can be opened and carries the entry's title, got ${JSON.stringify(conversations[0])}`);

	// 2. Memorize: the conversation is memorized, so it waits no more.
	const save1 = await memorize(SAVE1_AT);
	const afterSave1 = readL1b();
	assert(afterSave1.includes(SAVE1_NOTE) && !afterSave1.includes(TITLE_1), "the save folds the waiting conversation into the notes");
	conversations = listMemoryConversations(agentId);
	assert(conversations.length === 1 && conversations[0].waiting === false && conversations[0].conversation === true, `after Memorize the row no longer waits and can still be opened, got ${JSON.stringify(conversations[0])}`);

	// 3. A hand edit through the entries store, then a second Remember, a second
	//    Memorize and its undo — six recorded writes in all.
	const load = loadMemoryDocument(agentId);
	const edited = applyUserEdit(load.doc, { op: "edit", id: "m-0003", text: EDITED_TEXT, today: RUN_DAY }).doc;
	const edit = writeMemoryDocument(agentId, edited, { why: "user_edit", snapshotLabel: "edit", operation: "edit", entryId: "m-0003", now: EDIT_AT });
	assert(readL1b().includes("no preamble"), "the hand edit is in the file");
	const cp2 = remember(TITLE_2, ["The reporting pack goes out on the first working day of the month."], CP2_AT);
	const save2 = await memorize(SAVE2_AT);
	assert(readL1b().includes(SAVE2_NOTE), "the second save adds its note");
	const undone = undoMemorySave(agentId, save2, UNDO_AT);
	const today = readL1b();
	assert(!today.includes(SAVE2_NOTE) && today.includes("no preamble") && today.includes(TITLE_2), "the undo puts the second conversation back and keeps the hand edit");

	// 4. The chain has a link per write: the moment just before each write
	//    resolves to that write's own archived copy.
	const writes: Array<[string, Date]> = [["the first Remember", CP1_AT], ["the first Memorize", SAVE1_AT], ["the hand edit", EDIT_AT], ["the second Remember", CP2_AT], ["the second Memorize", SAVE2_AT], ["the undo", UNDO_AT]];
	for (const [label, when] of writes) {
		const snapshot = readMemorySnapshotAt(agentId, when.getTime() - 1_000);
		assert(snapshot && snapshot.basis === "archive" && snapshot.boundaryTs === when.getTime(), `${label} is a link of the chain, got ${JSON.stringify(snapshot && { basis: snapshot.basis, boundaryTs: snapshot.boundaryTs })} against ${when.getTime()}`);
	}

	// 5. What the first save changed, note by note: the added note under its
	//    topic with the id the save minted, the superseded note as one updated
	//    row, the finished item archived with its reason, the folded
	//    conversation gone from the waiting list — and nothing of the hand edit.
	const history = buildRoomMemoryHistory(agentId);
	const save1Row = history.find((row) => row.id === save1);
	const editRow = history.find((row) => row.id === edit.memoryEditId);
	const undoRow = history.find((row) => row.kind === "undo");
	assert(save1Row?.diffable === true && editRow?.kind === "user_edit" && editRow.diffable === true && undoRow?.id === undone.undoId && undoRow.diffable === true, `the save, the hand edit and the undo are diffable rows, got ${JSON.stringify({ save1Row, editRow, undoRow })}`);
	const save1Diff = readMemoryEventDiff(agentId, "learn", save1);
	assert(save1Diff && save1Diff.eventId === save1 && save1Diff.kind === "learn", "the first save's diff resolves");
	assert(save1Diff.afterBasis === "next-archive" && save1Diff.afterVerified === true, `its after side is the hand edit's archived copy, verified, got ${JSON.stringify({ afterBasis: save1Diff.afterBasis, afterVerified: save1Diff.afterVerified })}`);
	assert(save1Diff.notes === true && !("sections" in save1Diff), `both sides parse into notes, so the diff speaks in notes and carries no line view, got ${JSON.stringify({ notes: save1Diff.notes, sections: save1Diff.sections })}`);
	const names = save1Diff.topics.map((topic) => topic.section);
	assert(names.join(",") === "Commercial terms,Active Items", `the changed topics, in the after side's document order, got ${JSON.stringify(names)}`);
	const save1Rows = rowsOf(save1Diff);
	assert(save1Rows.length === 3, `three rows: one added, one updated, one archived, got ${JSON.stringify(save1Rows)}`);
	const added1 = save1Rows.filter((row) => row.change === "added");
	assert(added1.length === 1 && added1[0].section === "Commercial terms" && added1[0].id === "m-0300" && added1[0].after === SAVE1_NOTE && added1[0].before === undefined, `the added note carries the id the save minted and its text, got ${JSON.stringify(added1)}`);
	const superseded = save1Rows.find((row) => row.id === "m-0002");
	assert(superseded && superseded.change === "updated" && superseded.section === "Commercial terms" && superseded.before === "- The delivery window is six weeks from the day the order is signed." && superseded.after === SAVE1_SUPERSEDED_TEXT && superseded.from === undefined, `the superseded note is one updated row with its old and new text, got ${JSON.stringify(superseded)}`);
	const closed = save1Rows.find((row) => row.id === "m-0201");
	assert(closed && closed.change === "archived" && closed.section === "Active Items" && closed.why === "done" && closed.before === "- Chase the vendor for the signed addendum." && closed.after === undefined, `the finished item is archived with the reason the record carries, got ${JSON.stringify(closed)}`);
	assert(closed.reason === undefined, `a note that did not leave by budget carries no ranking words, got ${JSON.stringify(closed)}`);
	assert(JSON.stringify(save1Diff.conversations) === JSON.stringify({ left: [TITLE_1], joined: [] }), `the folded conversation left the waiting list, got ${JSON.stringify(save1Diff.conversations)}`);
	assert(save1Rows.every((row) => !String(row.before ?? "").includes("no preamble") && !String(row.after ?? "").includes("no preamble")), "the first save's diff does not contain the hand edit");
	assert(save1Rows.every((row) => !String(row.before ?? "").includes("<!--") && !String(row.after ?? "").includes("<!--")), "no row carries a metadata comment");

	// 6. What the hand edit changed: one updated row, old and new text. What the
	//    undo put back mirrors the second save: the ids that save reported added
	//    are the ids the undo archives, the conversations it folded come back.
	const editDiff = readMemoryEventDiff(agentId, "user_edit", edit.memoryEditId);
	assert(editDiff && editDiff.kind === "user_edit" && editDiff.eventId === edit.memoryEditId && editDiff.afterVerified === null && editDiff.afterBasis === "next-archive", `the hand edit's diff resolves against the next recorded state, got ${JSON.stringify(editDiff && { kind: editDiff.kind, afterBasis: editDiff.afterBasis, afterVerified: editDiff.afterVerified })}`);
	assert(editDiff.notes === true && !("sections" in editDiff), "the hand edit's diff speaks in notes");
	const editRows = rowsOf(editDiff);
	assert(editRows.length === 1 && JSON.stringify(editRows[0]) === JSON.stringify({ id: "m-0003", change: "updated", before: ORIGINAL_STYLE_TEXT, after: EDITED_TEXT, section: "Working style" }), `the hand edit is one updated row under its topic, old text and new, got ${JSON.stringify(editRows)}`);
	assert(editDiff.conversations.left.length === 0 && editDiff.conversations.joined.length === 0, `a hand edit moves no conversation, got ${JSON.stringify(editDiff.conversations)}`);
	const save2Diff = readMemoryEventDiff(agentId, "learn", save2);
	assert(save2Diff && save2Diff.notes === true && save2Diff.afterBasis === "next-archive", `the undone save's diff still resolves, against the undo's archived copy, got ${JSON.stringify(save2Diff && { notes: save2Diff.notes, afterBasis: save2Diff.afterBasis })}`);
	const save2Added = rowsOf(save2Diff).filter((row) => row.change === "added").map((row) => row.id);
	assert(save2Added.length === 1 && rowsOf(save2Diff).length === 1 && JSON.stringify(save2Diff.conversations) === JSON.stringify({ left: [TITLE_2], joined: [] }), `the second save added one note and folded one conversation, got ${JSON.stringify({ rows: rowsOf(save2Diff), conversations: save2Diff.conversations })}`);
	const undoDiff = readMemoryEventDiff(agentId, "undo", undone.undoId);
	assert(undoDiff && undoDiff.kind === "undo" && undoDiff.eventId === undone.undoId && undoDiff.afterBasis === "current", `the undo's diff exists and reads against today's file, got ${JSON.stringify(undoDiff && { kind: undoDiff.kind, afterBasis: undoDiff.afterBasis })}`);
	assert(undoDiff.notes === true && !("sections" in undoDiff), "the undo's diff speaks in notes");
	const undoRows = rowsOf(undoDiff);
	const undoArchived = undoRows.filter((row) => row.change === "archived");
	assert(undoRows.length === 1 && undoArchived.length === 1 && JSON.stringify(undoArchived.map((row) => row.id)) === JSON.stringify(save2Added), `the ids the second save added are the ids the undo archives, got ${JSON.stringify({ undoRows, save2Added })}`);
	assert(undoArchived[0].section === "Commercial terms" && undoArchived[0].before === SAVE2_NOTE && undoArchived[0].why === undefined, `the undo's archived row carries the note's text and no reason, got ${JSON.stringify(undoArchived[0])}`);
	assert(JSON.stringify(undoDiff.conversations) === JSON.stringify({ left: [], joined: save2Diff.conversations.left }), `the conversations the second save folded came back to the waiting list, got ${JSON.stringify(undoDiff.conversations)}`);
	assert(readMemoryEventDiff(agentId, "review", edit.memoryEditId) === null, "a memory-edit id asked for under another kind resolves to nothing");

	// 6b. A room that comes from 0.11.2: its first save migrates the file, and
	//     the diff of that save is the one note it added — the before-copy's
	//     stamps and missing ids do not read as every note rewritten.
	const legacyRoom = createPersistentAgentFromScaffoldInput({ displayName: "Memory History Diff Smoke Legacy Room", userName: "Synthetic User", preferredUserAddress: "Synthetic User" }).agent.agentId;
	fs.writeFileSync(l1bPathOf(legacyRoom), legacyMemoryFixture(legacyRoom), { mode: 0o600 });
	remember(TITLE_3, ["Finance confirmed invoices go out on the first working day of the month."], CP3_AT, legacyRoom);
	const legacyBefore = readL1b(legacyRoom);
	assert(legacyBefore.includes("(saved 2026-03-10)") && !legacyBefore.includes("<!-- e:"), "the legacy room still carries stamps and no ids before its first save");
	const save3 = await memorize(SAVE3_AT, legacyRoom);
	const legacyAfter = readL1b(legacyRoom);
	assert(legacyAfter.includes(SAVE3_NOTE) && legacyAfter.includes("<!-- e:") && !legacyAfter.includes("(saved 2026-03-10)"), "the first save migrated the file and added its note");
	const save3Diff = readMemoryEventDiff(legacyRoom, "learn", save3);
	assert(save3Diff && save3Diff.notes === true && !("sections" in save3Diff) && save3Diff.afterBasis === "current", `the migrating save's diff speaks in notes, got ${JSON.stringify(save3Diff && { notes: save3Diff.notes, afterBasis: save3Diff.afterBasis, sections: save3Diff.sections })}`);
	const save3Rows = rowsOf(save3Diff);
	assert(save3Rows.length === 1 && save3Rows[0].change === "added" && save3Rows[0].section === "Commercial terms" && save3Rows[0].after === SAVE3_NOTE, `exactly one added row and no updated rows, got ${JSON.stringify(save3Rows)}`);
	assert(JSON.stringify(save3Diff.conversations) === JSON.stringify({ left: [TITLE_3], joined: [] }), `the folded conversation left, got ${JSON.stringify(save3Diff.conversations)}`);

	// 6c. A room over its budget: the save's budget pass moves notes to the
	//     archive, and each of those rows in the diff says why in the words the
	//     ranking used — the same words the save's record carries on disk.
	const fullRoom = createPersistentAgentFromScaffoldInput({ displayName: "Memory History Diff Smoke Full Room", userName: "Synthetic User", preferredUserAddress: "Synthetic User" }).agent.agentId;
	fs.writeFileSync(l1bPathOf(fullRoom), fullMemoryFixture(fullRoom), { mode: 0o600 });
	writePersistentRoomMaintenanceSettings(fullRoom, { memoryBudgetTokens: MEMORY_BUDGET_MIN_TOKENS });
	remember(TITLE_4, ["The landlord's agent confirmed the warehouse lease runs another three years from October."], CP4_AT, fullRoom);
	const save4 = await memorize(SAVE4_AT, fullRoom);
	assert(readL1b(fullRoom).includes(SAVE4_NOTE), "the full room's save adds its note");
	const save4Diff = readMemoryEventDiff(fullRoom, "learn", save4);
	assert(save4Diff && save4Diff.notes === true && save4Diff.afterBasis === "current", `the full room's diff speaks in notes, got ${JSON.stringify(save4Diff && { notes: save4Diff.notes, afterBasis: save4Diff.afterBasis })}`);
	const budgetRows = rowsOf(save4Diff).filter((row) => row.change === "archived" && row.why === "budget");
	assert(budgetRows.length >= 1, `the budget pass archived at least one note, got ${JSON.stringify(rowsOf(save4Diff).filter((row) => row.change === "archived").slice(0, 3))}`);
	assert(budgetRows.every((row) => typeof row.reason === "string" && row.reason.trim().length > 0 && row.reason.includes("never recalled")), `every budget row carries the ranking's reason, and no seeded note was ever recalled, got ${JSON.stringify(budgetRows.slice(0, 3))}`);
	const save4Record = JSON.parse(fs.readFileSync(createPersistentAgentInstance(fullRoom).absorbEventRecordPath(save4), "utf-8"));
	const recordedReasons = new Map<string, string>((save4Record.run.archived as Array<{ id: string; reason?: string }>).map((row) => [row.id, row.reason ?? ""]));
	assert(budgetRows.every((row) => recordedReasons.get(String(row.id)) === row.reason), `the diff's reason is the record's, word for word, got ${JSON.stringify(budgetRows.slice(0, 3).map((row) => ({ id: row.id, diff: row.reason, record: recordedReasons.get(String(row.id)) })))}`);

	// 7. The notes view of a past moment.
	const betweenEditAndNext = readMemoryNotesView(agentId, EDIT_AT.getTime() + 60_000);
	assert(betweenEditAndNext && betweenEditAndNext.basis === "archive" && betweenEditAndNext.boundaryTs === CP2_AT.getTime(), `a moment after the hand edit reads the next write's archived copy, got ${JSON.stringify(betweenEditAndNext && { basis: betweenEditAndNext.basis, boundaryTs: betweenEditAndNext.boundaryTs })}`);
	assert(betweenEditAndNext.content.includes("no preamble") && betweenEditAndNext.content.includes("## Notes") && betweenEditAndNext.content.includes("## Open items") && !betweenEditAndNext.content.includes("<!--"), "that moment's notes view carries the edited text in the words a person reads");
	const styleThen = betweenEditAndNext.topics.find((topic) => topic.topic === "Working style");
	assert(styleThen && styleThen.section === "Deep Memory" && styleThen.notes === 1 && styleThen.content.includes("no preamble"), `that moment's topics carry the edited topic with its text, got ${JSON.stringify(betweenEditAndNext.topics)}`);
	assert(betweenEditAndNext.topics.map((topic) => topic.topic).join(",") === "Commercial terms,Working style,Active Items", `topics come in document order, got ${JSON.stringify(betweenEditAndNext.topics.map((topic) => topic.topic))}`);
	const beforeEdit = readMemoryNotesView(agentId, SAVE1_AT.getTime() + 60_000);
	assert(beforeEdit && beforeEdit.basis === "archive" && beforeEdit.boundaryTs === EDIT_AT.getTime() && !beforeEdit.content.includes("no preamble") && beforeEdit.content.includes(SAVE1_NOTE), "a moment before the hand edit reads the copy the edit archived, without the edit");
	const afterSave2 = readMemoryNotesView(agentId, SAVE2_AT.getTime() + 60_000);
	assert(afterSave2 && afterSave2.boundaryTs === UNDO_AT.getTime() && afterSave2.content.includes(SAVE2_NOTE), "a moment between the second save and the undo still shows the second save's note");
	const todayView = readMemoryNotesView(agentId);
	assert(todayView && todayView.basis === "current" && todayView.boundaryTs === null && Number.isFinite(todayView.at) && !todayView.content.includes(SAVE2_NOTE) && todayView.content.includes("no preamble"), "today's notes view is the file as it stands");
	assert(todayView.topics.length === 3 && todayView.topics.every((topic) => typeof topic.content === "string" && topic.content.length > 0), `today's view carries every topic's text, got ${JSON.stringify(todayView.topics)}`);

	// 8. The conversations: newest first, the undone one waiting again, a
	//    deleted transcript no longer offered.
	conversations = listMemoryConversations(agentId);
	assert(conversations.length === 2 && conversations[0].checkpointId === cp2.checkpointId && conversations[1].checkpointId === cp1.checkpointId, `two kept conversations, newest first, got ${JSON.stringify(conversations)}`);
	assert(conversations[0].waiting === true && conversations[0].title === TITLE_2 && conversations[1].waiting === false && conversations[1].title === TITLE_1, `the undone save's conversation waits again and each row keeps its title, got ${JSON.stringify(conversations)}`);
	fs.rmSync(path.join(root, agentId, "runtime", "threads", `${cp1.conversationId}.json`));
	conversations = listMemoryConversations(agentId);
	assert(conversations[1].conversation === false && conversations[0].conversation === true, `a deleted transcript is no longer offered, got ${JSON.stringify(conversations)}`);

	// 9. The same room over the real routes.
	server = spawn("npx", ["tsx", "src/index.ts"], { shell: process.platform === "win32", ...SMOKE_SERVER_SPAWN_TREE_OPTIONS, cwd: webServerDir, env: smokeEnv() });
	server.stdout.on("data", (chunk) => serverOutput.push(String(chunk)));
	server.stderr.on("data", (chunk) => serverOutput.push(String(chunk)));
	await waitForServer(server);
	const room = `/api/memory/rooms/${agentId}`;

	const listed = await requestJson(`${room}/conversations`);
	assert(listed.status === 200 && Array.isArray(listed.body?.conversations) && listed.body.conversations.length === 2, `GET conversations answers the rows, got ${listed.status}: ${JSON.stringify(listed.body)}`);
	assert(listed.body.conversations[0].checkpointId === cp2.checkpointId && listed.body.conversations[0].waiting === true && listed.body.conversations[1].conversation === false, `the route says what the reader says, got ${JSON.stringify(listed.body.conversations)}`);
	const unknownRoom = await requestJson("/api/memory/rooms/no-such-room-here/conversations");
	assert(unknownRoom.status === 404, `an unknown room is 404, got ${unknownRoom.status}`);

	const editOverHttp = await requestJson(`${room}/event-diff?kind=user_edit&event=${encodeURIComponent(edit.memoryEditId)}`);
	assert(editOverHttp.status === 200 && editOverHttp.body?.kind === "user_edit" && editOverHttp.body.notes === true && !("sections" in editOverHttp.body), `the hand edit's diff is served in notes, got ${editOverHttp.status}: ${JSON.stringify(editOverHttp.body)}`);
	assert(JSON.stringify(editOverHttp.body.topics) === JSON.stringify([{ section: "Working style", changes: [{ id: "m-0003", change: "updated", before: ORIGINAL_STYLE_TEXT, after: EDITED_TEXT }] }]) && JSON.stringify(editOverHttp.body.conversations) === JSON.stringify({ left: [], joined: [] }), `the route says what the reader says, got ${JSON.stringify({ topics: editOverHttp.body.topics, conversations: editOverHttp.body.conversations })}`);
	const undoOverHttp = await requestJson(`${room}/event-diff?kind=undo&event=${encodeURIComponent(undone.undoId)}`);
	assert(undoOverHttp.status === 200 && undoOverHttp.body?.kind === "undo" && undoOverHttp.body.eventId === undone.undoId && undoOverHttp.body.notes === true && undoOverHttp.body.conversations.joined.length === 1, `the undo's diff is served, got ${undoOverHttp.status}: ${JSON.stringify(undoOverHttp.body)}`);
	const badKind = await requestJson(`${room}/event-diff?kind=remember&event=${encodeURIComponent(edit.memoryEditId)}`);
	assert(badKind.status === 400, `a kind the diff does not serve is 400, got ${badKind.status}`);

	const notesThen = await requestJson(`${room}/snapshot?view=notes&at=${EDIT_AT.getTime() + 60_000}`);
	assert(notesThen.status === 200 && notesThen.body?.basis === "archive" && notesThen.body.boundaryTs === CP2_AT.getTime() && notesThen.body.at === EDIT_AT.getTime() + 60_000, `the notes view of a moment is served, got ${notesThen.status}: ${JSON.stringify(notesThen.body && { basis: notesThen.body.basis, boundaryTs: notesThen.body.boundaryTs, at: notesThen.body.at })}`);
	assert(String(notesThen.body.content).includes("no preamble") && notesThen.body.topics.some((topic: any) => topic.topic === "Working style" && String(topic.content).includes("no preamble")), "and it carries the edited text and topics");
	const notesNow = await requestJson(`${room}/snapshot?view=notes`);
	assert(notesNow.status === 200 && notesNow.body?.basis === "current" && notesNow.body.boundaryTs === null && Array.isArray(notesNow.body.topics) && typeof notesNow.body.content === "string", `today's notes view keeps its shape and gains topics, got ${notesNow.status}: ${JSON.stringify(notesNow.body && { basis: notesNow.body.basis, boundaryTs: notesNow.body.boundaryTs })}`);
	const badMoment = await requestJson(`${room}/snapshot?view=notes&at=then`);
	assert(badMoment.status === 400, `a moment that is not a number is 400, got ${badMoment.status}`);

	// 10. An updated row takes its reason from the version row the save
	//     archived: the highest `-vN` of that note among the record's archived
	//     rows, and nothing when no versioned row carries one.
	const pairedDoc = (window: string) => [
		"<!-- exxeta:l1b schema_version=1 -->",
		"",
		"## Chronos",
		"",
		"- Lifecycle state: ready",
		"",
		"## Deep Memory",
		"",
		"<!-- entries: next=300 -->",
		"",
		"### Commercial terms",
		"",
		entryLine("m-0002", "fact", "2026-09-01", `- The delivery window is ${window} weeks from the day the order is signed.`),
		"## Active Items",
		"",
		"## Recent Context",
		"",
		"",
	].join("\n");
	const WINDOW_REASON = "8 (saved 13 Sep) replaces 6 (saved 1 Sep); the newer date decides";
	const versioned = diffNotesOf(pairedDoc("6"), pairedDoc("8"), { fallbackSaved: RUN_DAY, archivedReason: new Map([["m-0002-v1", "an older version's words"], ["m-0002-v2", WINDOW_REASON], ["m-0002-v10", "not a higher version: v10 is read as ten, so it wins"]]) });
	const versionedRow = versioned && rowsOf(versioned).find((row) => row.id === "m-0002");
	assert(versionedRow?.change === "updated" && versionedRow.reason === "not a higher version: v10 is read as ten, so it wins", `an updated row takes the reason of the note's highest version row, by number and not by text, got ${JSON.stringify(versionedRow)}`);
	const twoVersions = diffNotesOf(pairedDoc("6"), pairedDoc("8"), { fallbackSaved: RUN_DAY, archivedReason: new Map([["m-0002-v1", "an older version's words"], ["m-0002-v2", WINDOW_REASON]]) });
	const twoVersionsRow = twoVersions && rowsOf(twoVersions).find((row) => row.id === "m-0002");
	assert(twoVersionsRow?.change === "updated" && twoVersionsRow.reason === WINDOW_REASON, `with -v1 and -v2 the updated row carries the -v2 reason, got ${JSON.stringify(twoVersionsRow)}`);
	const unversioned = diffNotesOf(pairedDoc("6"), pairedDoc("8"), { fallbackSaved: RUN_DAY, archivedReason: new Map([["m-0002", "the ranking's words for a row the budget took"], ["m-0003-v1", WINDOW_REASON]]) });
	const unversionedRow = unversioned && rowsOf(unversioned).find((row) => row.id === "m-0002");
	assert(unversionedRow?.change === "updated" && !("reason" in unversionedRow), `without a versioned row of its own the updated row carries no reason, whatever other rows say, got ${JSON.stringify(unversionedRow)}`);

	console.log("memory-history-diff smoke: PASS");
} catch (error) {
	if (serverOutput.length) console.error(serverOutput.join("").slice(-4000));
	throw error;
} finally {
	await stopSmokeServer(server);
	fs.rmSync(tempHome, { recursive: true, force: true });
}
