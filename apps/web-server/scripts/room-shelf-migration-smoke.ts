// Shelf migration smoke (files core slice): ledger-driven move onto the shelf
// with the collision rule, exports[] following their artifact, unlisted-output
// scan for interrupted rows, per-room marker idempotence, crash healing, the
// orphan sweep with its plain-text removal log, and the two runtime absorb
// paths (task completion, iterate shelf-input staging). Offline, isolated
// HOME + agents root — set BEFORE any src import reads the roots.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "exxeta-shelf-migration-home-"));
const tempAgentsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "exxeta-shelf-migration-root-"));
process.env.HOME = tempHome;
process.env.EXXETA_PERSISTENT_AGENTS_ROOT = tempAgentsRoot;

const { createTaskLedgerRecord, finalizeTaskLedgerRecord, appendTaskLedgerExport, listTaskLedgerRecords } = await import("../src/persistent-room-task-ledger.js");
const { migrateTaskArtifactsToShelves, SHELF_MIGRATION_LOG_FILENAME, SHELF_MIGRATION_MARKER_FILENAME, SHELF_MIGRATION_UNCLASSIFIED_DIR_NAME } = await import("../src/persistent-room-shelf-migration.js");
const { absorbTaskArtifactsIntoShelf, healShelfMaintenanceAtBoot, persistentRoomShelfDirPath } = await import("../src/persistent-room-shelf.js");
const crypto = await import("node:crypto");
const { ingestShelfInputs } = await import("../src/persistent-room-specialist-execution.js");
const { artifactRoot } = await import("../../../pi-package/extensions/artifacts/index.js");

const storeRoot = artifactRoot(); // under the isolated temp HOME
const roomId = "shelf-migration-room";

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

function writeStoreFile(relativePath: string, content: string): void {
	const file = path.join(storeRoot, ...relativePath.split("/"));
	fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
	fs.writeFileSync(file, content);
}

function record(taskId: string, startedAt: string) {
	return createTaskLedgerRecord({ taskId, roomId, conversationId: "conv-1", templateId: "deck", templateVersion: 1, title: taskId }, {}, new Date(startedAt));
}

try {
	// Room seed: an ok row with artifacts + an export, an iterate row producing
	// the SAME basename (collision), an interrupted row with unlisted outputs,
	// and a deleted row. Plus an unreferenced orphan folder from a deleted room.
	record("tsk-one", "2026-07-01T10:00:00.000Z");
	writeStoreFile("tasks/tsk-one/deck.html", "<p>v1 deck</p>");
	writeStoreFile("tasks/tsk-one/.thumbs/deck.png", "png-bytes");
	finalizeTaskLedgerRecord(roomId, "tsk-one", { outcome: "ok", summary: "v1", artifacts: [{ relativePath: "tasks/tsk-one/deck.html", bytes: 14, extension: ".html" }] }, {}, new Date("2026-07-01T10:05:00.000Z"));
	appendTaskLedgerExport(roomId, "tsk-one", { relativePath: "tasks/tsk-one/deck.html", savedTo: path.join(tempHome, "ws", "deck.html"), at: "2026-07-01T11:00:00.000Z" });

	record("tsk-two", "2026-07-02T10:00:00.000Z");
	writeStoreFile("tasks/tsk-two/deck.html", "<p>v2 deck</p>");
	writeStoreFile("tasks/tsk-two/inputs/deck.html", "<p>staged input copy</p>");
	finalizeTaskLedgerRecord(roomId, "tsk-two", { outcome: "ok", summary: "v2", artifacts: [{ relativePath: "tasks/tsk-two/deck.html", bytes: 14, extension: ".html" }] }, {}, new Date("2026-07-02T10:05:00.000Z"));

	record("tsk-orphaned", "2026-07-03T10:00:00.000Z");
	writeStoreFile("tasks/tsk-orphaned/half-report.md", "interrupted output");
	// A regular FILE named "inputs" (polish regression): only the inputs
	// DIRECTORY is the staging area the scan skips — a file that happens to
	// carry that name is an output like any other and must migrate, not vanish.
	writeStoreFile("tasks/tsk-orphaned/inputs", "a real file named inputs");
	finalizeTaskLedgerRecord(roomId, "tsk-orphaned", { outcome: "orphaned", summary: "boot-swept" }, {}, new Date("2026-07-03T10:05:00.000Z"));

	record("tsk-deleted", "2026-07-04T10:00:00.000Z");
	finalizeTaskLedgerRecord(roomId, "tsk-deleted", { outcome: "ok", summary: "later deleted", artifacts: [{ relativePath: "tasks/tsk-deleted/gone.md", bytes: 4, extension: ".md" }] }, {}, new Date("2026-07-04T10:05:00.000Z"));
	const { markTaskLedgerRecordDeleted } = await import("../src/persistent-room-task-ledger.js");
	markTaskLedgerRecordDeleted(roomId, "tsk-deleted");

	writeStoreFile("tasks/tsk-alien/stranded.html", "<p>room was deleted</p>");

	// Unclassifiable folders of a LIVE room (critical-fixes regression): a
	// pre-ledger task (no row was ever written) and a task whose row JSON no
	// longer parses. From the sweep's view both look exactly like tsk-alien —
	// so none of the three may be deleted; all move aside intact.
	writeStoreFile("tasks/tsk-preledger/ancient-report.md", "written before the ledger existed");
	writeStoreFile("tasks/tsk-corrupt/still-wanted.md", "row is corrupt, bytes are precious");
	const ledgerDir = path.join(tempAgentsRoot, roomId, "runtime", "task-ledger");
	fs.mkdirSync(ledgerDir, { recursive: true, mode: 0o700 });
	fs.writeFileSync(path.join(ledgerDir, "tsk-corrupt.json"), "{ this is not JSON");

	// An INCOMPLETE artifacts list (re-sweep regression): the row lists out1
	// only, but the folder also holds out2 — the unlisted-output scan runs only
	// for EMPTY lists, so out2 never migrates and the sweep must not delete it
	// as "leftovers" on the assumption the list was complete.
	record("tsk-partial", "2026-07-04T12:00:00.000Z");
	writeStoreFile("tasks/tsk-partial/out1.md", "the listed output");
	writeStoreFile("tasks/tsk-partial/out2.md", "the unlisted real output");
	finalizeTaskLedgerRecord(roomId, "tsk-partial", { outcome: "ok", summary: "list is incomplete", artifacts: [{ relativePath: "tasks/tsk-partial/out1.md", bytes: 17, extension: ".md" }] }, {}, new Date("2026-07-04T12:05:00.000Z"));

	// exports[] must protect its folder too (re-sweep regression): a live row
	// whose artifacts already sit on the shelf but whose export entry still
	// names a tasks/ path — the sweep must leave that folder in place.
	record("tsk-exp", "2026-07-04T13:00:00.000Z");
	finalizeTaskLedgerRecord(roomId, "tsk-exp", { outcome: "ok", summary: "exported", artifacts: [{ relativePath: "files/half-report.md", bytes: 18, extension: ".md" }] }, {}, new Date("2026-07-04T13:05:00.000Z"));
	appendTaskLedgerExport(roomId, "tsk-exp", { relativePath: "tasks/tsk-exp-store/exported.md", savedTo: path.join(tempHome, "ws", "exported.md"), at: "2026-07-04T14:00:00.000Z" });
	writeStoreFile("tasks/tsk-exp-store/exported.md", "an export's source bytes");

	// ---- First run -----------------------------------------------------------
	const first = migrateTaskArtifactsToShelves({ artifactsRoot: storeRoot, persistentAgentsRoot: tempAgentsRoot });
	assert(first.errors.length === 0, `first run must be clean (errors: ${first.errors.join(" | ")})`);
	assert(first.roomsMigrated === 1, "one room must migrate");

	const shelfDir = persistentRoomShelfDirPath(roomId, { persistentAgentsRoot: tempAgentsRoot });
	const shelfNames = fs.readdirSync(shelfDir).sort();
	assert(shelfNames.includes("deck.html") && shelfNames.includes("deck (2).html"), `collision rule must keep both decks (got: ${shelfNames.join(", ")})`);
	assert(shelfNames.includes("half-report.md"), "interrupted row's unlisted output must be scanned onto the shelf");
	assert(shelfNames.includes("inputs") && fs.readFileSync(path.join(shelfDir, "inputs"), "utf-8") === "a real file named inputs", "a regular FILE named 'inputs' is a real output and must migrate (only the inputs DIRECTORY is skipped)");
	assert(fs.readFileSync(path.join(shelfDir, "deck.html"), "utf-8") === "<p>v1 deck</p>", "older run keeps the plain name");

	const rows = listTaskLedgerRecords(roomId, { persistentAgentsRoot: tempAgentsRoot, includeDeleted: true });
	const rowOne = rows.find((row) => row.taskId === "tsk-one")!;
	assert(rowOne.artifacts?.[0]?.relativePath === "files/deck.html", "tsk-one artifact path must be rewritten to the shelf");
	assert(rowOne.exports?.[0]?.relativePath === "files/deck.html", "exports must follow their artifact onto the shelf");
	const rowTwo = rows.find((row) => row.taskId === "tsk-two")!;
	assert(rowTwo.artifacts?.[0]?.relativePath === "files/deck (2).html", "tsk-two must carry the collision name");
	const rowOrphaned = rows.find((row) => row.taskId === "tsk-orphaned")!;
	assert(rowOrphaned.artifacts?.[0]?.relativePath === "files/half-report.md", "scanned outputs must be recorded on the interrupted row");

	// Orphan sweep: referenced leftovers are deleted; anything no readable row
	// names is moved aside INTACT (critical-fixes regression — a pre-ledger
	// task and a corrupt-row task of a live room are indistinguishable from a
	// deleted room's folder, so none of them may be destroyed).
	assert(!fs.existsSync(path.join(storeRoot, "tasks", "tsk-one")), "migrated leftovers (.thumbs) must be cleaned");
	assert(!fs.existsSync(path.join(storeRoot, "tasks", "tsk-two")), "migrated leftovers (inputs/) must be cleaned");
	const unclassifiedDir = path.join(storeRoot, SHELF_MIGRATION_UNCLASSIFIED_DIR_NAME);
	for (const survivor of ["tsk-alien/stranded.html", "tsk-preledger/ancient-report.md", "tsk-corrupt/still-wanted.md"]) {
		assert(!fs.existsSync(path.join(storeRoot, "tasks", survivor.split("/")[0]!)), `${survivor.split("/")[0]} must leave the store`);
		assert(fs.existsSync(path.join(unclassifiedDir, ...survivor.split("/"))), `${survivor} must survive under ${SHELF_MIGRATION_UNCLASSIFIED_DIR_NAME}/, never be deleted`);
	}
	assert(fs.readFileSync(path.join(unclassifiedDir, "tsk-corrupt", "still-wanted.md"), "utf-8") === "row is corrupt, bytes are precious", "moved-aside bytes must be untouched");
	// The incomplete-list task: the LISTED output migrated, the unlisted one
	// survived the sweep — its folder moved aside instead of being deleted as
	// "leftovers" (re-sweep regression).
	assert(shelfNames.includes("out1.md") && fs.readFileSync(path.join(shelfDir, "out1.md"), "utf-8") === "the listed output", "the listed output must migrate onto the shelf");
	assert(fs.readFileSync(path.join(unclassifiedDir, "tsk-partial", "out2.md"), "utf-8") === "the unlisted real output", "an output the migration never moved must survive, moved aside — never deleted as leftovers");
	const rowPartial = rows.find((row) => row.taskId === "tsk-partial")!;
	assert(rowPartial.artifacts?.[0]?.relativePath === "files/out1.md", "the incomplete list's listed artifact must still be rewritten");
	// The exports[]-referenced folder stays exactly where it is (re-sweep
	// regression: the reference scan reads exports too, and protects the
	// folder the PATH names).
	assert(fs.readFileSync(path.join(storeRoot, "tasks", "tsk-exp-store", "exported.md"), "utf-8") === "an export's source bytes", "a folder an export still points into must be left in place");
	assert(first.entriesMovedAside === 4, `the three unclassifiable folders + the incomplete-list folder must be moved aside (got ${first.entriesMovedAside})`);
	const logText = fs.readFileSync(path.join(storeRoot, SHELF_MIGRATION_LOG_FILENAME), "utf-8");
	assert(logText.includes("tasks/tsk-alien/stranded.html"), "the removal log must name the moved-aside file");
	assert(logText.includes("moved aside (NOT deleted)"), "the removal log must say the folder was preserved");
	assert(logText.includes("never migrated"), "the incomplete-list move-aside must be logged with its reason");
	assert(!logText.includes("orphaned task of a deleted room"), "no unclassifiable folder may be logged as a deletion");
	const markerPath = path.join(tempAgentsRoot, roomId, "runtime", SHELF_MIGRATION_MARKER_FILENAME);
	assert(fs.existsSync(markerPath), "the room marker must exist");

	// ---- Second run: marker idempotence --------------------------------------
	const shelfSnapshot = fs.readdirSync(shelfDir).sort().join(",");
	const second = migrateTaskArtifactsToShelves({ artifactsRoot: storeRoot, persistentAgentsRoot: tempAgentsRoot });
	assert(second.roomsSkipped === 1 && second.filesMoved === 0, "second run must skip the migrated room");
	assert(fs.readdirSync(shelfDir).sort().join(",") === shelfSnapshot, "second run must not touch the shelf");

	// ---- Crash healing: record already rewritten, source already gone --------
	fs.rmSync(markerPath);
	const healed = migrateTaskArtifactsToShelves({ artifactsRoot: storeRoot, persistentAgentsRoot: tempAgentsRoot });
	assert(healed.errors.length === 0, `marker-less re-run must heal cleanly (errors: ${healed.errors.join(" | ")})`);
	assert(fs.readdirSync(shelfDir).sort().join(",") === shelfSnapshot, "healing run must not duplicate shelf files");
	assert(fs.existsSync(markerPath), "healing run must restore the marker");

	// ---- Journal heal: crash between rename and ledger rewrite ---------------
	// Simulate the exact !348 review-note window: the file already renamed onto
	// the shelf, the journal naming where it went, the record still pointing at
	// the dead tasks/ path. The re-run must finish the rewrite from the journal.
	record("tsk-crashed", "2026-07-05T10:00:00.000Z");
	finalizeTaskLedgerRecord(roomId, "tsk-crashed", { outcome: "ok", summary: "crashed mid-migration", artifacts: [{ relativePath: "tasks/tsk-crashed/deck.html", bytes: 12, extension: ".html" }] }, {}, new Date("2026-07-05T10:05:00.000Z"));
	fs.writeFileSync(path.join(shelfDir, "deck (3).html"), "<p>crashed</p>"); // the crashed run's rename landed here
	const journalDir = path.join(tempAgentsRoot, roomId, "runtime", "shelf-migration-journal");
	fs.mkdirSync(journalDir, { recursive: true, mode: 0o700 });
	fs.writeFileSync(path.join(journalDir, "tsk-crashed.json"), `${JSON.stringify({ schemaVersion: 1, taskId: "tsk-crashed", plannedNames: { "tasks/tsk-crashed/deck.html": "deck (3).html" } }, null, 2)}\n`);
	fs.rmSync(markerPath);
	const journalHeal = migrateTaskArtifactsToShelves({ artifactsRoot: storeRoot, persistentAgentsRoot: tempAgentsRoot });
	assert(journalHeal.errors.length === 0, `journal heal run must be clean (errors: ${journalHeal.errors.join(" | ")})`);
	const healedRow = listTaskLedgerRecords(roomId, { persistentAgentsRoot: tempAgentsRoot }).find((row) => row.taskId === "tsk-crashed")!;
	assert(healedRow.artifacts?.[0]?.relativePath === "files/deck (3).html", `crashed record must heal to the journaled shelf name (got ${healedRow.artifacts?.[0]?.relativePath})`);
	assert(!fs.existsSync(path.join(journalDir, "tsk-crashed.json")), "the journal must be cleared after the rewrite");
	assert(fs.readFileSync(path.join(shelfDir, "deck (3).html"), "utf-8") === "<p>crashed</p>", "the already-moved bytes must be untouched");

	// ---- Runtime absorb: task completion moves outputs onto the shelf --------
	writeStoreFile("tasks/tsk-live/summary.md", "fresh output");
	const absorbed = absorbTaskArtifactsIntoShelf(roomId, storeRoot, [{ relativePath: "tasks/tsk-live/summary.md", bytes: 12, extension: ".md" }], { persistentAgentsRoot: tempAgentsRoot });
	assert(absorbed[0]?.relativePath === "files/summary.md", "completion absorb must rewrite to the shelf path");
	assert(fs.existsSync(path.join(shelfDir, "summary.md")), "completion absorb must move the bytes");
	const untouched = absorbTaskArtifactsIntoShelf(roomId, storeRoot, [{ relativePath: "tasks/tsk-live/vanished.md", bytes: 1, extension: ".md" }], { persistentAgentsRoot: tempAgentsRoot });
	assert(untouched[0]?.relativePath === "tasks/tsk-live/vanished.md", "a missing source passes through unchanged, never throws");

	// ---- Iterate staging: shelf inputs are copied into the new task ----------
	const staged = ingestShelfInputs(["files/deck.html", "files/nope.bin"], "tasks/tsk-next", (name) => path.join(shelfDir, name));
	assert(staged.inputArtifacts.length === 1 && staged.inputArtifacts[0] === "tasks/tsk-next/inputs/deck.html", `shelf input must stage into inputs/ (got: ${staged.inputArtifacts.join(", ")})`);
	assert(staged.dropped.length === 1 && staged.dropped[0]!.sourceRelativePath === "files/nope.bin", "an unstageable input must be dropped and reported");
	assert(fs.readFileSync(path.join(storeRoot, "tasks", "tsk-next", "inputs", "deck.html"), "utf-8") === "<p>v1 deck</p>", "staged copy must carry the CURRENT shelf bytes");
	assert(fs.existsSync(path.join(shelfDir, "deck.html")), "staging copies; the shelf original stays");

	// ---- Move-aside across mounts: EXDEV falls back to copy+remove ----------
	// A cross-device store must not leave an unclassifiable folder stuck in
	// tasks/ re-erroring every boot. Simulated by making renameSync throw EXDEV
	// for tasks-unclassified destinations.
	writeStoreFile("tasks/tsk-exdev/across-mounts.md", "bytes on another device");
	const realRenameSync = fs.renameSync;
	(fs as { renameSync: typeof fs.renameSync }).renameSync = ((source: fs.PathLike, destination: fs.PathLike) => {
		if (String(destination).includes("tasks-unclassified")) {
			const error = new Error("EXDEV: cross-device link not permitted") as NodeJS.ErrnoException;
			error.code = "EXDEV";
			throw error;
		}
		return realRenameSync(source, destination);
	}) as typeof fs.renameSync;
	try {
		const exdevRun = migrateTaskArtifactsToShelves({ artifactsRoot: storeRoot, persistentAgentsRoot: tempAgentsRoot });
		assert(exdevRun.errors.length === 0, `the EXDEV run must be clean (errors: ${exdevRun.errors.join(" | ")})`);
		assert(fs.readFileSync(path.join(storeRoot, SHELF_MIGRATION_UNCLASSIFIED_DIR_NAME, "tsk-exdev", "across-mounts.md"), "utf-8") === "bytes on another device", "EXDEV must fall back to copy+remove, not strand the folder");
		assert(!fs.existsSync(path.join(storeRoot, "tasks", "tsk-exdev")), "the copied-aside source must be removed");
	} finally {
		(fs as { renameSync: typeof fs.renameSync }).renameSync = realRenameSync;
	}

	// ---- Boot ordering: rename-journal heal must run BEFORE migration -------
	// The crashed-rename window: report.html was already renamed to
	// renamed.html on the shelf, the journal names the mapping, the row still
	// points at the old name — and a store task waits to migrate an output
	// CALLED report.html. In boot order (heal, then migrate) the row heals to
	// renamed.html before the migration hands the freed name to the newcomer.
	// Reversed, the newcomer takes report.html first, the heal reads the name
	// as reclaimed and skips the rewrite, and the renamed file's row resolves
	// to the newcomer's bytes forever.
	fs.writeFileSync(path.join(shelfDir, "renamed.html"), "<p>the renamed bytes</p>");
	record("tsk-renamed", "2026-07-06T10:00:00.000Z");
	finalizeTaskLedgerRecord(roomId, "tsk-renamed", { outcome: "ok", summary: "renamed, rewrite crashed", artifacts: [{ relativePath: "files/report.html", bytes: 24, extension: ".html" }] }, {}, new Date("2026-07-06T10:05:00.000Z"));
	const renameJournalDir = path.join(tempAgentsRoot, roomId, "runtime", "shelf-rename-journal");
	fs.mkdirSync(renameJournalDir, { recursive: true, mode: 0o700 });
	fs.writeFileSync(path.join(renameJournalDir, `${crypto.createHash("sha256").update("report.html").digest("hex").slice(0, 16)}.json`), `${JSON.stringify({ schemaVersion: 1, oldName: "report.html", newName: "renamed.html" }, null, 2)}\n`);
	record("tsk-newcomer", "2026-07-06T11:00:00.000Z");
	writeStoreFile("tasks/tsk-newcomer/report.html", "<p>the newcomer bytes</p>");
	finalizeTaskLedgerRecord(roomId, "tsk-newcomer", { outcome: "ok", summary: "wants the freed name", artifacts: [{ relativePath: "tasks/tsk-newcomer/report.html", bytes: 24, extension: ".html" }] }, {}, new Date("2026-07-06T11:05:00.000Z"));
	fs.rmSync(markerPath);
	// The boot sequence under test (index.ts): heal FIRST, then migrate.
	healShelfMaintenanceAtBoot({ persistentAgentsRoot: tempAgentsRoot });
	const bootOrderRun = migrateTaskArtifactsToShelves({ artifactsRoot: storeRoot, persistentAgentsRoot: tempAgentsRoot });
	assert(bootOrderRun.errors.length === 0, `boot-order run must be clean (errors: ${bootOrderRun.errors.join(" | ")})`);
	const bootRows = listTaskLedgerRecords(roomId, { persistentAgentsRoot: tempAgentsRoot });
	assert(bootRows.find((row) => row.taskId === "tsk-renamed")!.artifacts?.[0]?.relativePath === "files/renamed.html", "the crashed rename's row must heal to the renamed name BEFORE migration can hand the freed name away");
	assert(fs.readFileSync(path.join(shelfDir, "renamed.html"), "utf-8") === "<p>the renamed bytes</p>", "the renamed file's bytes must be untouched");
	assert(bootRows.find((row) => row.taskId === "tsk-newcomer")!.artifacts?.[0]?.relativePath === "files/report.html", "the newcomer takes the freed plain name");
	assert(fs.readFileSync(path.join(shelfDir, "report.html"), "utf-8") === "<p>the newcomer bytes</p>", "the freed name holds the NEWCOMER's bytes — and only the newcomer's row points at it");

	console.log("room-shelf-migration smoke: PASS");
	fs.rmSync(tempHome, { recursive: true, force: true });
	fs.rmSync(tempAgentsRoot, { recursive: true, force: true });
} catch (error) {
	console.error("room-shelf-migration smoke: FAIL —", (error as Error).message);
	console.error(`  temp HOME kept for inspection: ${tempHome}`);
	console.error(`  temp agents root kept for inspection: ${tempAgentsRoot}`);
	process.exitCode = 1;
}
