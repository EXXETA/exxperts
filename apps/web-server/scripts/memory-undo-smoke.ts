// Taking back the latest memory save, on real rooms in a temp HOME (memory v2).
//
// Undo makes one promise: the memory a person had before their last Memorize or
// Review is the memory they get back — the same bytes, the same conversations in
// Recent Context, the same archive, minus exactly the rows that save added. And
// it makes one refusal: the moment anything else has touched the memory, the
// offer is gone, because an undo over a later change would take that change back
// too without ever saying so.
//
// Neither of those can be read off the code, so this smoke drives the real
// writers — a scripted Memorize run and an approved Review — and then reads the
// files: current.md byte for byte, the archive rows one by one, the room's own
// event records, and the memory history the Memory tab renders. It also walks
// every refusal: the same save twice, a hand edit in between, a Remember's id, an
// id the room has never heard of, and a Memorize run in flight.
//
// Offline: no server, no provider, no network, no port.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { AbsorbRunGenerate } from "../src/absorb-run.js";

const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "memory-undo-smoke-home-"));
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

const { approveAbsorbRun, cancelAbsorbRun, getAbsorbRun, setAbsorbRunBudget, startAbsorbRun } = await import("../src/absorb-run.js");
const { createPersistentAgentFromScaffoldInput, createPersistentAgentInstance, fingerprintL1bSource, l1bStateMetrics } = await import("../src/persistent-agents.js");
const { MEMORY_BUDGET_DEFAULT_TOKENS, readPersistentRoomMaintenanceSettings, writePersistentRoomMaintenanceSettings } = await import("../src/persistent-room-maintenance-settings.js");
const { renderMemoryContext } = await import("../src/memory-entries.js");
const { appendArchive, deleteArchivedEntry, loadMemoryDocument, readArchive, writeMemoryDocument } = await import("../src/memory-entries-store.js");
const { applyUserEdit } = await import("../src/memory-entries.js");
const { buildRoomMemoryHistory } = await import("../src/memory-api.js");
const { undoMemorySave } = await import("../src/memory-undo.js");

const MODEL = { provider: "openai-compatible", model: "gpt-5.5", label: "GPT-5.5" };
const RUN_DAY = "2026-09-13";
const RUN_CLOCK = () => new Date(`${RUN_DAY}T09:00:00.000Z`);
const SAVED_AT = new Date(`${RUN_DAY}T09:05:00.000Z`);
const UNDONE_AT = new Date(`${RUN_DAY}T09:07:00.000Z`);

const ASSESSMENT = [
	"## What these sessions leave behind",
	"",
	"- The delivery window changed and one open item was finished.",
].join("\n");

/** The archive row this room already had: an undo must leave it exactly where it is. */
const OLD_ARCHIVE_ID = "m-0009";

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** A refusal is a product sentence AND a stable code; both are the contract. */
function expectRefusal(fn: () => unknown, code: string, sentence: RegExp, label: string): void {
	try {
		fn();
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		assert((error as any)?.code === code, `${label}: expected code "${code}", got "${(error as any)?.code}" with "${message}"`);
		assert(sentence.test(message), `${label}: expected a sentence matching ${sentence}, got "${message}"`);
		return;
	}
	throw new Error(`${label}: expected a refusal, but the call returned without one`);
}

// --- Fixtures -----------------------------------------------------------------

function entryLine(id: string, kind: string, saved: string, text: string, extra = ""): string {
	return `<!-- e: id=${id} kind=${kind} saved=${saved}${extra ? ` ${extra}` : ""} refs=0 -->\n${text}\n`;
}

function session(id: string, date: string, title: string, body: string[]): string {
	return [
		`### ${id} | OPEN | ${date} | ${title}`,
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

/** A room's memory as it stands before a Memorize: entry ids already in place. */
function memoryFixture(agentId: string, sessions: string[]): string {
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
		"<!-- entries: next=300 -->",
		"",
		"### Commercial terms",
		"",
		entryLine("m-0001", "fact", "2026-09-01", "- The pricing arrangement follows the volume schedule agreed in September."),
		entryLine("m-0002", "fact", "2026-09-01", "- The delivery window is six weeks from the day the order is signed."),
		"### Working style",
		"",
		entryLine("m-0003", "practice", "2026-09-02", "- Commercial summaries go out as one page, numbers first."),
		"## Active Items",
		"",
		entryLine("m-0201", "item", "2026-09-01", "- Chase the vendor for the signed addendum.", "status=open"),
		entryLine("m-0202", "item", "2026-09-02", "- Confirm the invoicing day with finance before the quarter closes.", "status=open"),
		"## Recent Context",
		"",
		sessions.join("\n"),
	].join("\n");
}

const FOLDED_SESSION = session("RC-0001", "2026-09-11", "Addendum signed", [
	"The vendor returned the signed addendum, so that chase is finished.",
	"The delivery window is now four weeks from the day the order is signed.",
]);

/**
 * A session the scripted worker never answers readably: it fails its two
 * attempts and stays in Recent Context, which is what gives the room a session
 * left for the run that has to be caught mid-fold further down.
 */
const UNFOLDABLE_SESSION = session("RC-0002", "2026-09-11", "Invoicing questions", [
	"Invoicing days were discussed without landing anywhere in particular.",
]);

function createRoom(displayName: string, fixture: (agentId: string) => string): { agentId: string; l1bPath: string } {
	const created = createPersistentAgentFromScaffoldInput({ displayName, userName: "Synthetic User", preferredUserAddress: "Synthetic User" });
	const agentId = created.agent.agentId;
	const l1bPath = path.join(root, agentId, "L1b", "current.md");
	fs.writeFileSync(l1bPath, fixture(agentId), { mode: 0o600 });
	return { agentId, l1bPath };
}

// --- The scripted fold ----------------------------------------------------------

function foldReply(ops: unknown[]): { text: string; usage: { input: number; output: number; totalTokens: number } } {
	return {
		text: ["The addendum came back signed, so the chase is finished and the window is not what it was.", "", "```json", JSON.stringify({ ops }, null, 2), "```", ""].join("\n"),
		usage: { input: 2400, output: 240, totalTokens: 2640 },
	};
}

/** What the run folds: one add, one superseded entry, one finished item. */
const FOLD_OPS = [
	{ op: "add", topic: "Commercial terms", kind: "fact", text: "- The signed addendum of 2026-09-11 is what the delivery window now follows, and the vendor has it on file." },
	{ op: "supersede", id: "m-0002", text: "- The delivery window is four weeks from the day the order is signed, as the signed addendum sets it out." },
	{ op: "close", id: "m-0201" },
];

/** The one session this worker can fold; anything else comes back unreadable. */
const scriptedGenerate: AbsorbRunGenerate = async (prompt) => {
	if (/^### RC-0001 \|/m.test(prompt)) return foldReply(FOLD_OPS);
	return { text: "I have folded that discussion into memory for you.", usage: { input: 2400, output: 40, totalTokens: 2440 } };
};

const WORKING_STATES = new Set(["prepass", "folding", "budget"]);

async function settle(agentId: string, runId: string, label: string) {
	const deadline = Date.now() + 60_000;
	let run = getAbsorbRun(agentId, runId);
	while (WORKING_STATES.has(run.state)) {
		assert(Date.now() < deadline, `${label}: the run was still in state "${run.state}" after 60 seconds`);
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

/** The limit a card raises to in the rooms below; every room starts at the default. */
const RAISED_LIMIT = 30_000;

/** Runs Memorize the way the client does and approves it: one save, one saveId. `raiseTo` is the card's "Raise the limit" before Save; `limitRaisedFrom` is what the client sends after the first read's raise. */
async function memorize(agentId: string, now = SAVED_AT, raiseTo?: number, limitRaisedFrom?: number): Promise<{ saveId: string; archived: string[]; raisedFrom: number | undefined }> {
	const started = startAbsorbRun({ agentId, assessmentMarkdown: ASSESSMENT, model: MODEL, generate: scriptedGenerate, now: RUN_CLOCK, ...(limitRaisedFrom === undefined ? {} : { limitRaisedFrom }) });
	const run = await settle(agentId, started.runId, "the Memorize run");
	assert(run.state === "ready", `a scripted Memorize run ends ready for approval, got "${run.state}"${run.error ? ` with "${run.error}"` : ""}`);
	if (raiseTo !== undefined) setAbsorbRunBudget(agentId, started.runId, raiseTo);
	const approved = approveAbsorbRun(agentId, started.runId, now);
	assert(approved.saveId === approved.absorbId, `the Memorize approval answers with the save's own id under saveId, got ${approved.saveId} against ${approved.absorbId}`);
	assert(approved.budgetRaisedTo === raiseTo, `the approval says what it raised the limit to, got ${JSON.stringify(approved.budgetRaisedTo)} against ${JSON.stringify(raiseTo)}`);
	const record = JSON.parse(fs.readFileSync(path.join(root, agentId, "events", "absorb", `${approved.saveId}.json`), "utf-8"));
	return { saveId: approved.saveId, archived: (record.run?.archived ?? []).map((row: any) => String(row.id)), raisedFrom: record.run?.budget?.raisedFrom };
}

// --- The Review save ------------------------------------------------------------

function reviewSourceL1b(agentId: string): string {
	return [
		"<!-- exxeta:l1b schema_version=1 -->",
		"",
		"## Chronos",
		"",
		`- Persistent agent id: ${agentId}`,
		"- UNDO_CHRONOS_SENTINEL",
		"",
		"## Deep Memory",
		"",
		"### Collaboration",
		"",
		"- The synthetic user prefers scoped changes with explicit cleanup steps.",
		"- The synthetic user is learning collaborative review workflows.",
		"",
		"### Product Direction",
		"",
		"- Memory maintenance should feel calm, lean and signal-first.",
		"- Duplicate product-direction wording repeats calm, lean and signal-first maintenance.",
		"- UNDO_DEEP_MEMORY_SENTINEL",
		"",
		"## Active Items",
		"",
		"### Current Focus",
		"",
		"- Keep the split and graft invariants for Chronos and Recent Context.",
		"",
		"## Recent Context",
		"",
		"### RC-0001 | OPEN | 2026-09-11 | Review context",
		"",
		"**Session arc:** This entry must survive a Review and come back from an undo.",
		"",
		"**Body:**",
		"- UNDO_RECENT_CONTEXT_SENTINEL",
		"",
		"**Parked:**",
		"None.",
		"",
	].join("\n");
}

const REVIEW_CANDIDATE = [
	"## Deep Memory",
	"",
	"### Collaboration",
	"",
	"- The synthetic user prefers scoped changes with explicit cleanup steps and is learning collaborative review workflows.",
	"",
	"### Product Direction",
	"",
	"- Memory maintenance should feel calm, lean and signal-first.",
	"- UNDO_DEEP_MEMORY_SENTINEL",
	"",
	"## Active Items",
	"",
	"### Current Focus",
	"",
	"- Keep the split and graft invariants for Chronos and Recent Context.",
	"",
].join("\n");

/**
 * A save written by the Review that came BEFORE the run — the whole-rewrite one,
 * which is gone from the product but not from the rooms that ran it. Its event
 * record is laid down here by hand, exactly as that code wrote it: the memory it
 * replaced kept in the room's L1b archive, the memory it wrote measured through
 * the one metrics function, and the record under `events/structural-review`.
 * A room that saved this way must still show that save in its history and still
 * be able to take it back, and that is what this fixture is for.
 */
function legacyReviewSave(agentId: string, l1bPath: string, now: Date): string {
	const instance = createPersistentAgentInstance(agentId);
	const meta = instance.readAgentJson();
	const source = fs.readFileSync(l1bPath, "utf-8");
	const chronos = /^## Chronos\n[\s\S]*?(?=^## Deep Memory$)/m.exec(source);
	const recentContext = /^## Recent Context\n[\s\S]*$/m.exec(source);
	assert(chronos && recentContext, "the review fixture should carry Chronos and Recent Context to graft back");
	const written = `<!-- exxeta:l1b schema_version=1 -->\n\n${chronos![0].trimEnd()}\n\n${REVIEW_CANDIDATE.trimEnd()}\n\n${recentContext![0].trimEnd()}\n`;

	const stamp = now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
	const structuralReviewId = `stc_${stamp}_legacy`;
	const archiveDir = instance.l1bArchiveDir(meta);
	fs.mkdirSync(archiveDir, { recursive: true, mode: 0o700 });
	const archivedL1bPath = path.join(archiveDir, `${stamp}-before-${structuralReviewId}.md`);
	fs.writeFileSync(archivedL1bPath, source, { mode: 0o600 });
	fs.writeFileSync(l1bPath, written, { mode: 0o600 });

	const eventRecordPath = instance.structuralReviewEventRecordPath(structuralReviewId);
	fs.mkdirSync(path.dirname(eventRecordPath), { recursive: true, mode: 0o700 });
	fs.writeFileSync(eventRecordPath, `${JSON.stringify({
		schemaVersion: 1,
		operation: "structural_review",
		mode: "stc_diagnostic",
		agentId,
		structuralReviewId,
		approvedAt: now.toISOString(),
		process: { type: "structural-review-worker", mode: "stc_diagnostic", model: MODEL, source: "proposal_time" },
		paths: {
			archivedL1bRelPath: instance.rootRelativePath(archivedL1bPath),
			updatedL1bRelPath: instance.rootRelativePath(l1bPath),
			eventRelPath: instance.rootRelativePath(eventRecordPath),
		},
		source: { ...l1bStateMetrics(renderMemoryContext(source)), l1bFingerprint: fingerprintL1bSource(source) },
		result: l1bStateMetrics(renderMemoryContext(written)),
		validation: { valid: true, warnings: [], errors: [] },
		warnings: [],
	}, null, 2)}\n`, { mode: 0o600 });
	return structuralReviewId;
}

// --- The smoke ------------------------------------------------------------------

function historyFor(agentId: string) {
	return buildRoomMemoryHistory(agentId);
}

function archiveIds(agentId: string): string[] {
	return readArchive(agentId).map((entry) => entry.id);
}

try {
	// =====================================================================
	// A Memorize save, taken back.
	// =====================================================================
	const roomA = createRoom("Memory Undo Smoke Room", (agentId) => memoryFixture(agentId, [FOLDED_SESSION, UNFOLDABLE_SESSION]));
	// One archive row from before the save: it is not this save's, so the undo
	// must leave it exactly where it is.
	appendArchive(roomA.agentId, [{
		entry: { id: OLD_ARCHIVE_ID, kind: "fact", saved: "2024-01-01", pinned: false, text: "- An arrangement from before any of this, archived long ago." },
		why: "user",
		topic: "Commercial terms",
		section: "Deep Memory",
	}], new Date("2026-09-01T09:00:00.000Z"));

	const beforeSave = fs.readFileSync(roomA.l1bPath, "utf-8");
	const archiveBeforeSave = fs.readFileSync(path.join(root, roomA.agentId, "L1b", "archive", "entries.md"), "utf-8");
	const recentContextBefore = (beforeSave.match(/^### RC-\d+/gm) ?? []).length;
	assert(recentContextBefore === 2, `the fixture carries two conversations in Recent Context, got ${recentContextBefore}`);

	// The card raised the limit before Save: the save writes it, and records where it came from.
	const save = await memorize(roomA.agentId, SAVED_AT, RAISED_LIMIT);
	assert(readPersistentRoomMaintenanceSettings(roomA.agentId).memoryBudgetTokens === RAISED_LIMIT && save.raisedFrom === MEMORY_BUDGET_DEFAULT_TOKENS, `a save that raised the limit writes it and records the limit before it, got ${JSON.stringify({ setting: readPersistentRoomMaintenanceSettings(roomA.agentId).memoryBudgetTokens, raisedFrom: save.raisedFrom })}`);
	const afterSave = fs.readFileSync(roomA.l1bPath, "utf-8");
	assert(afterSave !== beforeSave, "a Memorize save changes the memory");
	assert(!/^### RC-0001 \|/m.test(afterSave), "the folded conversation leaves Recent Context when the save lands");
	assert(save.archived.length === 2, `this run archives the superseded text and the finished item, and its record names ${save.archived.length}`);
	assert(archiveIds(roomA.agentId).includes(OLD_ARCHIVE_ID), "the older archive row is still in the archive after the save");

	// --- Refusals that must not write anything --------------------------------
	expectRefusal(() => undoMemorySave(roomA.agentId, "absorb_20260101_000000Z_nosuch", UNDONE_AT), "memory_undo_unknown", /not in this room's memory history/, "an id the room has never recorded");
	// A Remember: a real record of the kind undo does not serve.
	const checkpointId = "cp_20260913_000001";
	const checkpointDir = path.join(root, roomA.agentId, "events", "checkpoint");
	fs.mkdirSync(checkpointDir, { recursive: true });
	fs.writeFileSync(path.join(checkpointDir, `${checkpointId}.json`), JSON.stringify({ schemaVersion: 1, operation: "checkpoint", agentId: roomA.agentId, checkpointId, approvedAt: "2026-09-12T09:00:00.000Z" }, null, 2));
	expectRefusal(() => undoMemorySave(roomA.agentId, checkpointId, UNDONE_AT), "memory_undo_kind", /Only a Memorize or Review save can be undone/, "a Remember's id");

	// A Memorize in flight holds the room: an undo underneath it would be undone
	// again by the write that run is about to make.
	let releaseFold = () => {};
	const blocked = new Promise<void>((resolve) => { releaseFold = resolve; });
	let foldCalls = 0;
	const blockingGenerate: AbsorbRunGenerate = async () => {
		foldCalls++;
		await blocked;
		return foldReply([]);
	};
	const inFlight = startAbsorbRun({ agentId: roomA.agentId, assessmentMarkdown: ASSESSMENT, model: MODEL, generate: blockingGenerate, now: RUN_CLOCK });
	await waitUntil(() => foldCalls > 0, "the blocking run should reach its first fold call");
	expectRefusal(() => undoMemorySave(roomA.agentId, save.saveId, UNDONE_AT), "memory_undo_run_active", /updating its memory right now/, "an undo while Memorize is running");
	cancelAbsorbRun(roomA.agentId, inFlight.runId, UNDONE_AT);
	releaseFold();
	await settle(roomA.agentId, inFlight.runId, "the cancelled run");
	assert(fs.readFileSync(roomA.l1bPath, "utf-8") === afterSave, "a refused undo writes nothing");

	// --- The undo itself -------------------------------------------------------
	const undone = undoMemorySave(roomA.agentId, save.saveId, UNDONE_AT);
	assert(fs.readFileSync(roomA.l1bPath, "utf-8") === beforeSave, "an undo puts the memory from before the save back byte for byte");
	assert(undone.undone.kind === "memorize" && undone.undone.saveId === save.saveId, `the undo names the save it took back, got ${JSON.stringify(undone.undone)}`);
	assert(undone.undoId.startsWith("undo_"), `the undo carries its own id in the room's history, got "${undone.undoId}"`);
	assert(undone.recentContextCount === recentContextBefore, `the conversations come back to Recent Context, got ${undone.recentContextCount} against ${recentContextBefore}`);
	assert(typeof undone.memoryBudget.budgetTokens === "number" && typeof undone.memoryBudget.reviewTargetEstimatedTokens === "number", "the undo answers with the budget block the approvals answer with");
	// The limit the save raised goes back down with it, and the answer says so.
	assert(undone.limitLoweredTo === MEMORY_BUDGET_DEFAULT_TOKENS && readPersistentRoomMaintenanceSettings(roomA.agentId).memoryBudgetTokens === MEMORY_BUDGET_DEFAULT_TOKENS, `undoing a save that raised the limit puts the limit back, got ${JSON.stringify({ limitLoweredTo: undone.limitLoweredTo, setting: readPersistentRoomMaintenanceSettings(roomA.agentId).memoryBudgetTokens })}`);
	assert(undone.memoryBudget.budgetTokens === MEMORY_BUDGET_DEFAULT_TOKENS, `the undo's budget block is measured after the limit went back down, got ${JSON.stringify(undone.memoryBudget)}`);

	// Exactly the rows that save appended, and not one more.
	const archiveAfterUndo = archiveIds(roomA.agentId);
	for (const id of save.archived) assert(!archiveAfterUndo.includes(id), `the undo takes the row this save appended (${id}) back out of the archive`);
	assert(archiveAfterUndo.includes(OLD_ARCHIVE_ID), "the undo leaves archive rows it did not write alone");
	assert(fs.readFileSync(path.join(root, roomA.agentId, "L1b", "archive", "entries.md"), "utf-8") === archiveBeforeSave, "the archive file is what it was before the save");

	// The record, and the history the Memory tab renders.
	const undoRecord = JSON.parse(fs.readFileSync(path.join(root, roomA.agentId, "events", "memory-edit", `${undone.undoId}.json`), "utf-8"));
	assert(undoRecord.kind === "undo" && undoRecord.undoneSaveId === save.saveId && undoRecord.undoneKind === "memorize", `the undo's record names the save it took back, got ${JSON.stringify({ kind: undoRecord.kind, undoneSaveId: undoRecord.undoneSaveId, undoneKind: undoRecord.undoneKind })}`);
	assert(typeof undoRecord.paths?.archivedL1bRelPath === "string" && typeof undoRecord.budget?.budgetTokens === "number", "the undo's record carries the usual paths and budget blocks");
	assert(undoRecord.limitLoweredTo === MEMORY_BUDGET_DEFAULT_TOKENS && undoRecord.budget.budgetTokens === MEMORY_BUDGET_DEFAULT_TOKENS, `the undo's record says the limit went back down, got ${JSON.stringify({ limitLoweredTo: undoRecord.limitLoweredTo, budget: undoRecord.budget })}`);
	assert(fs.existsSync(path.join(root, roomA.agentId, undoRecord.paths.archivedL1bRelPath)), "the undo archives the file it replaced, like every other memory write");
	const historyA = historyFor(roomA.agentId);
	const undoRow = historyA.find((event) => event.kind === "undo");
	assert(undoRow?.id === undone.undoId && undoRow?.undoneSaveId === save.saveId && undoRow?.undoneKind === "memorize", `the history carries the undo as its own row, got ${JSON.stringify(undoRow)}`);
	const saveRow = historyA.find((event) => event.id === save.saveId);
	assert(saveRow?.kind === "learn" && saveRow?.undone === true, `the history keeps the undone save and marks it undone, got ${JSON.stringify(saveRow)}`);

	// --- The same save twice ---------------------------------------------------
	expectRefusal(() => undoMemorySave(roomA.agentId, save.saveId, UNDONE_AT), "memory_undo_stale", /has changed since this save/, "undoing the same save twice");

	// =====================================================================
	// A hand edit after the save: the memory has moved on, so the offer is gone.
	// =====================================================================
	const roomC = createRoom("Memory Undo Edited Smoke Room", (agentId) => memoryFixture(agentId, [FOLDED_SESSION]));
	const editedSave = await memorize(roomC.agentId);
	const load = loadMemoryDocument(roomC.agentId);
	const edited = applyUserEdit(load.doc, { op: "edit", id: "m-0003", text: "- Commercial summaries go out as one page, numbers first and no preamble.", today: RUN_DAY }).doc;
	writeMemoryDocument(roomC.agentId, edited, { why: "user_edit", snapshotLabel: "edit", operation: "edit", entryId: "m-0003", now: new Date(`${RUN_DAY}T10:06:00.000Z`) });
	expectRefusal(() => undoMemorySave(roomC.agentId, editedSave.saveId, new Date(`${RUN_DAY}T10:07:00.000Z`)), "memory_undo_stale", /has changed since this save/, "an undo after a hand edit");

	// =====================================================================
	// An archived note deleted for good after the save: the notes file is as
	// the save left it, but the memory has changed, and the undo would put a
	// row back that a person chose to destroy. So the offer is gone.
	// =====================================================================
	const roomGone = createRoom("Memory Undo Archive Deleted Smoke Room", (agentId) => memoryFixture(agentId, [FOLDED_SESSION]));
	const goneSave = await memorize(roomGone.agentId);
	assert(goneSave.archived.length > 0, "this run archives at least one note the save could put back");
	const goneL1b = fs.readFileSync(roomGone.l1bPath, "utf-8");
	const gone = deleteArchivedEntry(roomGone.agentId, goneSave.archived[0], new Date(`${RUN_DAY}T10:06:00.000Z`));
	assert(gone.deleted.id === goneSave.archived[0] && !archiveIds(roomGone.agentId).includes(gone.deleted.id), "the row is out of the archive");
	assert(fs.readFileSync(roomGone.l1bPath, "utf-8") === goneL1b, "a delete for good leaves the notes file as the save left it");
	expectRefusal(() => undoMemorySave(roomGone.agentId, goneSave.saveId, new Date(`${RUN_DAY}T10:07:00.000Z`)), "memory_undo_stale", /has changed since this save/, "an undo after an archived note was deleted for good");
	assert(!archiveIds(roomGone.agentId).includes(gone.deleted.id) && fs.readFileSync(roomGone.l1bPath, "utf-8") === goneL1b, "the refused undo wrote nothing");
	const goneHistory = historyFor(roomGone.agentId);
	assert(goneHistory[0]?.kind === "user_edit" && goneHistory[0].operation === "archive_delete" && goneHistory[0].topic === gone.deleted.topic, `the history's newest row is the delete for good, naming the topic, got ${JSON.stringify(goneHistory[0])}`);

	// =====================================================================
	// The limit was changed by hand after the save: it is the person's now, and
	// the undo leaves it alone without a word.
	// =====================================================================
	const roomD = createRoom("Memory Undo Limit Changed Smoke Room", (agentId) => memoryFixture(agentId, [FOLDED_SESSION]));
	const changedSave = await memorize(roomD.agentId, SAVED_AT, RAISED_LIMIT);
	assert(changedSave.raisedFrom === MEMORY_BUDGET_DEFAULT_TOKENS, "the save recorded the raise");
	const HAND_SET_LIMIT = 40_000;
	writePersistentRoomMaintenanceSettings(roomD.agentId, { memoryBudgetTokens: HAND_SET_LIMIT });
	const undoneChanged = undoMemorySave(roomD.agentId, changedSave.saveId, UNDONE_AT);
	assert(undoneChanged.limitLoweredTo === undefined && readPersistentRoomMaintenanceSettings(roomD.agentId).memoryBudgetTokens === HAND_SET_LIMIT, `a limit the person changed since the save is left alone, got ${JSON.stringify({ limitLoweredTo: undoneChanged.limitLoweredTo, setting: readPersistentRoomMaintenanceSettings(roomD.agentId).memoryBudgetTokens })}`);
	assert(undoneChanged.memoryBudget.budgetTokens === HAND_SET_LIMIT, `the budget block carries the limit the person set, got ${JSON.stringify(undoneChanged.memoryBudget)}`);
	const changedRecord = JSON.parse(fs.readFileSync(path.join(root, roomD.agentId, "events", "memory-edit", `${undoneChanged.undoId}.json`), "utf-8"));
	assert(!("limitLoweredTo" in changedRecord), "and its record says nothing about the limit");

	// =====================================================================
	// A save made against the saved limit: nothing to lower, nothing said.
	// =====================================================================
	const roomE = createRoom("Memory Undo Unraised Smoke Room", (agentId) => memoryFixture(agentId, [FOLDED_SESSION]));
	const plainSave = await memorize(roomE.agentId);
	assert(plainSave.raisedFrom === undefined, `a save against the saved limit records no raise, got ${JSON.stringify(plainSave.raisedFrom)}`);
	const undonePlain = undoMemorySave(roomE.agentId, plainSave.saveId, UNDONE_AT);
	assert(undonePlain.limitLoweredTo === undefined && readPersistentRoomMaintenanceSettings(roomE.agentId).memoryBudgetTokens === MEMORY_BUDGET_DEFAULT_TOKENS && undonePlain.memoryBudget.budgetTokens === MEMORY_BUDGET_DEFAULT_TOKENS, `undoing a save that raised nothing leaves the limit as it is and says nothing, got ${JSON.stringify({ limitLoweredTo: undonePlain.limitLoweredTo, memoryBudget: undonePlain.memoryBudget })}`);

	// =====================================================================
	// The limit was raised on the first read, before any run: the setting was
	// written then, the run carries where it came from, the save records it
	// without calling it the card's raise, and the undo takes it back down.
	// =====================================================================
	const roomF = createRoom("Memory Undo First Read Raise Smoke Room", (agentId) => memoryFixture(agentId, [FOLDED_SESSION]));
	writePersistentRoomMaintenanceSettings(roomF.agentId, { memoryBudgetTokens: RAISED_LIMIT });
	const firstReadSave = await memorize(roomF.agentId, SAVED_AT, undefined, MEMORY_BUDGET_DEFAULT_TOKENS);
	assert(firstReadSave.raisedFrom === MEMORY_BUDGET_DEFAULT_TOKENS && readPersistentRoomMaintenanceSettings(roomF.agentId).memoryBudgetTokens === RAISED_LIMIT, `a save after a first-read raise records the limit before it and leaves the raised limit in place, got ${JSON.stringify({ raisedFrom: firstReadSave.raisedFrom, setting: readPersistentRoomMaintenanceSettings(roomF.agentId).memoryBudgetTokens })}`);
	const undoneFirstRead = undoMemorySave(roomF.agentId, firstReadSave.saveId, UNDONE_AT);
	assert(undoneFirstRead.limitLoweredTo === MEMORY_BUDGET_DEFAULT_TOKENS && readPersistentRoomMaintenanceSettings(roomF.agentId).memoryBudgetTokens === MEMORY_BUDGET_DEFAULT_TOKENS && undoneFirstRead.memoryBudget.budgetTokens === MEMORY_BUDGET_DEFAULT_TOKENS, `undoing that save lowers the limit to where the first read raised it from, got ${JSON.stringify({ limitLoweredTo: undoneFirstRead.limitLoweredTo, setting: readPersistentRoomMaintenanceSettings(roomF.agentId).memoryBudgetTokens, memoryBudget: undoneFirstRead.memoryBudget })}`);

	// A limitRaisedFrom that is not below the limit the room holds is not a
	// raise: the save records nothing and the undo lowers nothing.
	const roomG = createRoom("Memory Undo Bogus Raise Smoke Room", (agentId) => memoryFixture(agentId, [FOLDED_SESSION]));
	const bogusSave = await memorize(roomG.agentId, SAVED_AT, undefined, MEMORY_BUDGET_DEFAULT_TOKENS + 10_000);
	assert(bogusSave.raisedFrom === undefined, `a limitRaisedFrom above the room's limit is ignored, got ${JSON.stringify(bogusSave.raisedFrom)}`);
	const undoneBogus = undoMemorySave(roomG.agentId, bogusSave.saveId, UNDONE_AT);
	assert(undoneBogus.limitLoweredTo === undefined && readPersistentRoomMaintenanceSettings(roomG.agentId).memoryBudgetTokens === MEMORY_BUDGET_DEFAULT_TOKENS, `and its undo leaves the limit alone, got ${JSON.stringify({ limitLoweredTo: undoneBogus.limitLoweredTo, setting: readPersistentRoomMaintenanceSettings(roomG.agentId).memoryBudgetTokens })}`);

	// =====================================================================
	// A save written by the Review that came before the run, taken back.
	// =====================================================================
	const roomB = createRoom("Memory Undo Review Smoke Room", reviewSourceL1b);
	const beforeReview = fs.readFileSync(roomB.l1bPath, "utf-8");
	const reviewSaveId = legacyReviewSave(roomB.agentId, roomB.l1bPath, SAVED_AT);
	const afterReview = fs.readFileSync(roomB.l1bPath, "utf-8");
	assert(afterReview !== beforeReview, "the fixture should leave a memory the old Review rewrote");
	assert(historyFor(roomB.agentId).some((event) => event.id === reviewSaveId), "a room that saved with the old Review still shows that save in its history");

	const undoneReview = undoMemorySave(roomB.agentId, reviewSaveId, UNDONE_AT);
	assert(fs.readFileSync(roomB.l1bPath, "utf-8") === beforeReview, "an undo puts the memory from before a Review back byte for byte");
	assert(undoneReview.undone.kind === "review" && undoneReview.undone.saveId === reviewSaveId, `the undo names the Review it took back, got ${JSON.stringify(undoneReview.undone)}`);
	assert(undoneReview.undone.approvedAt === SAVED_AT.toISOString(), `the undo reports when the save it took back was approved, got "${undoneReview.undone.approvedAt}"`);
	const reviewHistory = historyFor(roomB.agentId);
	assert(reviewHistory.find((event) => event.id === reviewSaveId)?.undone === true, "the history marks the undone Review");
	assert(reviewHistory.find((event) => event.kind === "undo")?.undoneKind === "review", "the undo row says which kind of save it took back");
	assert(undoneReview.limitLoweredTo === undefined, "a save of the old Review had no card to raise the limit from, so there is nothing to lower");
	expectRefusal(() => undoMemorySave(roomB.agentId, reviewSaveId, UNDONE_AT), "memory_undo_stale", /has changed since this save/, "undoing the same Review twice");

	console.log("memory-undo smoke: PASS");
} finally {
	fs.rmSync(tempHome, { recursive: true, force: true });
}
