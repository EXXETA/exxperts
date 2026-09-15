// The memory entries STORE, on a real room in a temp HOME (memory v2, D2).
//
// What it pins, in the order the code has to get right:
//  1. the room boot is a NO-OP for a file nobody has migrated — the L1b layer
//     is the file's own bytes, so shipping the context render changes no
//     existing room's prompt;
//  2. migration is a WRITE, exactly once: the first load snapshots the previous
//     file and records one event, the second load writes nothing at all;
//  3. what a migrated file renders back to is what it is — parse → storage
//     render is byte-identical, so no read can drift the file;
//  4. the context render strips every metadata line and carries the archive
//     pointer lines, which is the whole reason storage and context split;
//  5. Chronos keeps the maintenance workflows' fields and gains only the edit
//     stamp;
//  6. every write refuses while the room has a turn in flight, with the
//     product sentence;
//  7. archive append, read and restore round-trip.
//
// Offline: no model, no network, no port.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "memory-entries-store-home-"));
const root = path.join(tempHome, ".exxperts", "app", "personalized-agents");
const tempCwd = fs.mkdtempSync(path.join(os.tmpdir(), "memory-entries-store-cwd-"));
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
	beginPersistentAgentTurn,
	buildPersistentAgentBootContext,
	createPersistentAgentFromScaffoldInput,
	createPersistentAgentPiSessionJsonlThreadRuntime,
	finishPersistentAgentTurn,
	writePersistentAgentThread,
} = await import("../src/persistent-agents.js");
const { writePersistentAgentAiProfileState } = await import("../src/persistent-agent-ai-profile-state.js");
writePersistentAgentAiProfileState("openai-compatible");

const {
	appendArchive,
	contextRender,
	loadMemoryDocument,
	readArchive,
	writeMemoryDocument,
	MEMORY_ROOM_BUSY_SENTENCE,
} = await import("../src/memory-entries-store.js");
const { findEntryLocation, parseMemoryDocument, renderMemoryDocument, restoreEntry, applyUserEdit } = await import("../src/memory-entries.js");

const agentId = "memory-entries-store-smoke-room";
const model = { provider: "openai-compatible", model: "gpt-5.5", label: "GPT-5.5" };
const l1bPath = path.join(root, agentId, "L1b", "current.md");
const archiveDir = path.join(root, agentId, "L1b", "archive");
const eventDir = path.join(root, agentId, "events", "memory-edit");

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

function expectThrows(fn: () => unknown, expected: RegExp, label: string): void {
	try {
		fn();
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		assert(expected.test(message), `${label}: expected ${expected}, got ${message}`);
		assert((error as any)?.statusCode === 400, `${label}: expected a 400, got ${(error as any)?.statusCode}`);
		return;
	}
	throw new Error(`${label}: expected a refusal`);
}

// The pre-write snapshots only: `entries.md` shares the directory and is not one.
function snapshots(): string[] {
	return fs.readdirSync(archiveDir).filter((name) => name.endsWith(".md") && name.includes("-before-")).sort();
}

// Oldest first, by the time the write happened — never by file name.
function events(): any[] {
	if (!fs.existsSync(eventDir)) return [];
	return fs.readdirSync(eventDir)
		.filter((name) => name.endsWith(".json"))
		.map((name) => JSON.parse(fs.readFileSync(path.join(eventDir, name), "utf-8")))
		.sort((a, b) => Date.parse(a.approvedAt) - Date.parse(b.approvedAt));
}

function bootL1bLayer(conversationId: string): string {
	const boot = buildPersistentAgentBootContext({ agentId, conversationId, sessionId: null, model });
	const layer = boot.layers.find((l) => l.id === "l1b");
	assert(layer, "boot context should carry an L1b layer");
	return layer!.content;
}

// A room as it exists today: topics and bullets, no ids anywhere, one
// **must-keep** marker, and a Chronos that dates the last checkpoint.
const V1_L1B = `<!-- exxeta:l1b schema_version=1 -->

## Chronos

- Persistent agent id: ${agentId}
- Lifecycle state: ready
- Last checkpoint: cp_20260830_0001
- Last checkpoint at: 2026-08-30T09:00:00.000Z
- Last consolidation: none

## Deep Memory

### Commercial terms

- The Nordwind contract renews annually; legal signs before June. (saved 2026-08-20)
- Invoices go out on the first working day of the month. **must-keep**

### Working style

- Send commercial summaries as one page, numbers first.

## Active Items

- Chase the vendor for the signed addendum.

## Recent Context

No checkpointed sessions yet.
`;

try {
	createPersistentAgentFromScaffoldInput({
		displayName: "Memory Entries Store Smoke Room",
		userName: "Synthetic User",
		preferredUserAddress: "Synthetic User",
	});
	fs.writeFileSync(l1bPath, V1_L1B, { mode: 0o600 });

	// --- 1. The boot is a no-op on a file nobody has migrated -----------------
	assert(bootL1bLayer("boot_before_migration") === V1_L1B, "an unmigrated room's boot prompt must carry its L1b byte for byte");

	// --- 2. The first load migrates, and it is a normal recorded write --------
	// A fixed migration time keeps this run independent of the wall clock: the
	// later user edit below stamps a fixed 10:00, and the event list is ordered
	// by time, so the migration must land before it on any day.
	const first = loadMemoryDocument(agentId, { now: new Date("2026-08-30T09:00:00.000Z") });
	assert(first.migrated === true, "the first load of a v1 file must migrate it");
	assert(snapshots().length === 1 && /-before-migrate_/.test(snapshots()[0]), `migration must archive the previous file as <stamp>-before-migrate_<id>.md, got ${JSON.stringify(snapshots())}`);
	assert(fs.readFileSync(path.join(archiveDir, snapshots()[0]), "utf-8") === V1_L1B, "the snapshot must be the previous file byte for byte");
	assert(events().length === 1 && events()[0].kind === "migrate" && events()[0].operation === "memory_edit", `migration must write one event record of kind migrate, got ${JSON.stringify(events())}`);
	assert(events()[0].entriesAssigned === 4, `migration should have given four bullets an id, got ${events()[0].entriesAssigned}`);

	const migratedEntries = first.doc.topics.flatMap((t) => t.entries);
	assert(migratedEntries.length === 4, `migrated document should hold four entries, got ${migratedEntries.length}`);
	assert(migratedEntries.every((e) => /^m-\d{4}$/.test(e.id)), "every migrated entry must carry an id");
	const stampedEntry = migratedEntries.find((e) => e.text.includes("Nordwind"))!;
	assert(stampedEntry.saved === "2026-08-20" && stampedEntry.text === "- The Nordwind contract renews annually; legal signs before June.", `a stamped bullet keeps its own date and loses the stamp, got ${JSON.stringify({ saved: stampedEntry.saved, text: stampedEntry.text })}`);
	assert(migratedEntries.filter((e) => e !== stampedEntry).every((e) => e.saved === "2026-08-30"), `entries without a saved stamp take the file's last checkpoint day, got ${migratedEntries.map((e) => e.saved).join(",")}`);
	assert(migratedEntries.filter((e) => e.pinned).length === 1, "the must-keep bullet must come out pinned");
	assert(migratedEntries.find((e) => e.kind === "item")?.status === "open", "an Active Items bullet migrates to an open item");
	assert(migratedEntries.find((e) => e.text.includes("commercial summaries"))?.kind === "practice", "a note under a topic titled like a way of working migrates as a practice");
	assert(migratedEntries.filter((e) => e.kind === "fact").length === 2, `the plain statements under a plain topic stay facts, got ${migratedEntries.map((e) => e.kind).join(",")}`);

	// --- 3. A migrated file is a fixed point ---------------------------------
	const migratedBytes = fs.readFileSync(l1bPath, "utf-8");
	assert(migratedBytes.includes("<!-- entries: next=5 -->"), "the storage render must carry the id counter");
	assert(!migratedBytes.includes("(saved ") && /kind=practice/.test(migratedBytes), "the written file carries the kinds and none of the stamps");
	assert(renderMemoryDocument(parseMemoryDocument(migratedBytes), "storage") === migratedBytes, "parse → storage render must be byte-identical on a migrated file");

	// --- 4. The second load writes NOTHING -----------------------------------
	const second = loadMemoryDocument(agentId);
	assert(second.migrated === false, "a migrated file must not migrate again");
	assert(snapshots().length === 1, `a second read must not snapshot, got ${JSON.stringify(snapshots())}`);
	assert(events().length === 1, `a second read must not record an event, got ${events().length}`);
	assert(fs.readFileSync(l1bPath, "utf-8") === migratedBytes, "a second read must not touch a single byte of the file");
	// And again, because "reads that write" usually only show up on the third call.
	loadMemoryDocument(agentId);
	assert(snapshots().length === 1 && events().length === 1 && fs.readFileSync(l1bPath, "utf-8") === migratedBytes, "reads stay reads");

	// --- 5. Chronos: the edit stamp only ------------------------------------
	assert(/^- Last edit at: \d{4}-\d{2}-\d{2}T/m.test(migratedBytes), "a write stamps Chronos with its edit time");
	assert(/^- Last checkpoint: cp_20260830_0001$/m.test(migratedBytes), "a write must not move the checkpoint field");
	assert(/^- Last consolidation: none$/m.test(migratedBytes), "a write must not move the consolidation field");

	// --- 6. The context render is what the room reads -------------------------
	const context = contextRender(agentId);
	assert(!context.includes("<!-- e:"), "the context render must strip every entry metadata line");
	assert(!context.includes("entries: next="), "the context render must strip the id counter");
	assert(context.includes("The Nordwind contract renews annually"), "the context render keeps the memory itself");
	assert(bootL1bLayer("boot_after_migration") === context, "the room boot must read the context render");
	assert(bootL1bLayer("boot_after_migration") !== migratedBytes, "the room must not be paying for the metadata lines any more");

	// --- 7. A delete is a demotion to the archive, and it is disclosed --------
	const before = loadMemoryDocument(agentId);
	const nordwind = before.doc.topics.flatMap((t) => t.entries).find((e) => e.text.includes("Nordwind"));
	assert(nordwind, "fixture entry should be findable");
	const located = findEntryLocation(before.doc, nordwind!.id)!;
	const afterDelete = applyUserEdit(before.doc, { op: "delete", id: nordwind!.id });
	assert(afterDelete.archived, "a delete hands the entry back for the archive");
	const deleteWrite = writeMemoryDocument(agentId, afterDelete.doc, {
		why: "user_edit",
		snapshotLabel: "edit",
		operation: "delete",
		entryId: nordwind!.id,
		archiveAppend: [{ entry: afterDelete.archived!, why: "user", topic: located.topic.title, section: located.topic.section }],
		now: new Date("2026-09-13T10:00:00.000Z"),
	});
	assert(snapshots().length === 2 && events().length === 2, "a user edit is one more snapshot and one more event record");
	assert(events()[1].kind === "user_edit" && events()[1].entryOperation === "delete" && events()[1].entryId === nordwind!.id, `the record must name the entry and the operation, got ${JSON.stringify(events()[1])}`);
	assert(deleteWrite.archived.length === 1 && deleteWrite.archived[0].why === "user", "a deleted entry lands in the archive with why=user");

	const archived = readArchive(agentId);
	assert(archived.length === 1 && archived[0].id === nordwind!.id && archived[0].archived === "2026-09-13", `the archive file must hold the entry, got ${JSON.stringify(archived)}`);
	const contextWithArchive = contextRender(agentId);
	assert(/_Archived: 1 older note from Sep 2026; use memory_recall to read them\._/.test(contextWithArchive), `a demoted topic must carry its pointer line, got:\n${contextWithArchive}`);
	assert(!contextWithArchive.includes("Nordwind"), "a demoted entry is out of context");

	// --- 8. Restore brings it back and empties the archive row ---------------
	const beforeRestore = loadMemoryDocument(agentId);
	const restoredDoc = restoreEntry(beforeRestore.doc, archived[0]);
	writeMemoryDocument(agentId, restoredDoc, { why: "user_edit", snapshotLabel: "edit", operation: "restore", entryId: nordwind!.id, archiveRemoveIds: [nordwind!.id] });
	assert(readArchive(agentId).length === 0, "a restore takes the entry out of the archive");
	assert(contextRender(agentId).includes("Nordwind"), "a restored entry is back in context");
	assert(!/_Archived:/.test(contextRender(agentId)), "an empty archive leaves no pointer line");
	assert(loadMemoryDocument(agentId).migrated === false, "none of these writes un-migrates the file");

	// --- 9. appendArchive on its own ----------------------------------------
	const spare = loadMemoryDocument(agentId).doc.topics.flatMap((t) => t.entries)[0];
	const appended = appendArchive(agentId, [{ entry: spare, why: "budget", topic: "Commercial terms", section: "Deep Memory" }], new Date("2026-09-13T11:00:00.000Z"));
	assert(appended.length === 1 && readArchive(agentId).length === 1, "appendArchive writes the archive on its own");

	// --- 10. Every write refuses while a turn is in flight -------------------
	const threadId = "memory_entries_store_0001";
	const thread = writePersistentAgentThread(agentId, threadId, {
		state: "active",
		origin: "home",
		model,
		items: [{ kind: "user", id: "display-user", text: "Synthetic display item." }],
	}, {
		createRuntime: ({ model }) => createPersistentAgentPiSessionJsonlThreadRuntime({ agentId, threadId, model, cwd: tempCwd }),
	});
	assert(thread.thread.runtime.kind === "pi-session-jsonl", "fixture thread should be Pi-backed");
	const running = beginPersistentAgentTurn(agentId, threadId, { turnId: "turn_memory_entries_store", connectionId: "ws_memory_entries_store" });
	assert(running.state === "running", "begin should mark the turn running");

	const bytesBeforeRefusal = fs.readFileSync(l1bPath, "utf-8");
	const snapshotsBeforeRefusal = snapshots().length;
	const busy = new RegExp(MEMORY_ROOM_BUSY_SENTENCE.slice(0, 40).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
	expectThrows(() => writeMemoryDocument(agentId, loadMemoryDocument(agentId, { migrate: false }).doc, { why: "user_edit", snapshotLabel: "edit", operation: "edit" }), busy, "a write during an active turn");
	expectThrows(() => appendArchive(agentId, [{ entry: spare, why: "budget", topic: "Commercial terms", section: "Deep Memory" }]), busy, "an archive append during an active turn");
	assert(fs.readFileSync(l1bPath, "utf-8") === bytesBeforeRefusal, "a refused write must leave the memory untouched");
	assert(snapshots().length === snapshotsBeforeRefusal, "a refused write must leave no snapshot behind");

	finishPersistentAgentTurn(agentId, threadId, { turnId: "turn_memory_entries_store", terminalReason: "completed" });
	const afterTurn = loadMemoryDocument(agentId);
	const allowed = writeMemoryDocument(agentId, afterTurn.doc, { why: "user_edit", snapshotLabel: "edit", operation: "edit" });
	assert(allowed.memoryEditId.startsWith("edit_"), "the same write lands once the turn is over");
	assert(allowed.budget.budgetTokens === 20_000 && allowed.budget.reviewTargetTokens > 0, `the write must disclose the room's budget, got ${JSON.stringify(allowed.budget)}`);

	// A write stamps Chronos, and the stamp must be a FIXED POINT: it used to
	// leave one more blank line under the "## Chronos" heading every time, which
	// on a room that writes often (a migration, a Memorize, every hand edit)
	// grows the file and the room's prompt without end.
	const chronosGap = (text: string): number => /^##[ \t]+Chronos[ \t]*$\n(\n*)/m.exec(text)?.[1].length ?? -1;
	const gapAfterOneWrite = chronosGap(fs.readFileSync(l1bPath, "utf-8"));
	writeMemoryDocument(agentId, loadMemoryDocument(agentId).doc, { why: "user_edit", snapshotLabel: "edit", operation: "edit" });
	writeMemoryDocument(agentId, loadMemoryDocument(agentId).doc, { why: "user_edit", snapshotLabel: "edit", operation: "edit" });
	const gapAfterThree = chronosGap(fs.readFileSync(l1bPath, "utf-8"));
	assert(gapAfterOneWrite === 1 && gapAfterThree === 1, `the Chronos stamp must not add a blank line per write, got ${gapAfterOneWrite} then ${gapAfterThree}`);

	console.log("memory-entries-store-smoke: OK");
} catch (error) {
	console.error(error instanceof Error ? error.stack || error.message : error);
	console.error(`temp home preserved for inspection: ${tempHome}`);
	process.exitCode = 1;
} finally {
	if (process.exitCode !== 1) {
		fs.rmSync(tempHome, { recursive: true, force: true });
		fs.rmSync(tempCwd, { recursive: true, force: true });
	}
}
