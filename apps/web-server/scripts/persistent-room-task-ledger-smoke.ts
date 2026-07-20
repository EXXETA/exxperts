import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "exxeta-task-ledger-"));
process.env.EXXETA_PERSISTENT_AGENTS_ROOT = root;

const {
	appendTaskLedgerExport,
	createTaskLedgerRecord,
	finalizeTaskLedgerRecord,
	listTaskLedgerRecords,
	clearTaskLedgerRecordRemoved,
	markTaskLedgerRecordRemoved,
	markTaskLedgerRecordsAwayNoticed,
	selectTaskLedgerAwayNotices,
	selectTaskLedgerReseedRows,
	sweepOrphanedTaskLedgerRecords,
	taskLedgerRecordPath,
	TASK_LEDGER_SUMMARY_MAX_CHARS,
} = await import("../src/persistent-room-task-ledger.js");

const roomId = "task-ledger-smoke-room";

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

try {
	// Absent room/dir lists empty, and listing never creates anything.
	assert(listTaskLedgerRecords(roomId).length === 0, "absent ledger dir must list empty");
	assert(!fs.existsSync(path.join(root, roomId)), "listing must not create the room dir");

	// Create: running row, no endedAt, file mode 0600.
	const created = createTaskLedgerRecord(
		{ taskId: "tsk-aaa111", roomId, conversationId: "conv-1", templateId: "deck", templateVersion: 3, title: "Q3 deck" },
		{},
		new Date("2026-07-18T10:00:00.000Z"),
	);
	assert(created.outcome === "running", "created row must be running");
	assert(created.startedAt === "2026-07-18T10:00:00.000Z", "created row must stamp startedAt");
	assert(created.endedAt === undefined, "created row must not have endedAt");
	const recordFile = taskLedgerRecordPath(roomId, "tsk-aaa111");
	assert(fs.existsSync(recordFile), "create must write the record file");
	if (process.platform !== "win32") {
		// POSIX only: Windows has no file-mode bits.
		const mode = fs.statSync(recordFile).mode & 0o777;
		assert(mode === 0o600, `record file should be 0600, got ${mode.toString(8)}`);
	}

	// Finalize ok: summary capped, artifacts + usage round-trip, endedAt stamped.
	const longSummary = "x".repeat(TASK_LEDGER_SUMMARY_MAX_CHARS + 500);
	const finalized = finalizeTaskLedgerRecord(
		roomId,
		"tsk-aaa111",
		{
			outcome: "ok",
			summary: longSummary,
			artifacts: [{ relativePath: "tasks/tsk-aaa111/deck.html", bytes: 1234, extension: "html" }],
			usage: { input: 10, output: 20, cost: 0.05 },
		},
		{},
		new Date("2026-07-18T10:05:00.000Z"),
	);
	assert(finalized !== null, "finalize must find the created row");
	assert(finalized.outcome === "ok", "finalized outcome must persist");
	assert(finalized.endedAt === "2026-07-18T10:05:00.000Z", "finalize must stamp endedAt");
	assert((finalized.summary ?? "").length === TASK_LEDGER_SUMMARY_MAX_CHARS, "summary must be capped");
	assert(finalized.artifacts?.length === 1 && finalized.artifacts[0].relativePath === "tasks/tsk-aaa111/deck.html", "artifacts must round-trip");
	assert(finalized.usage?.cost === 0.05, "usage must round-trip");
	const rereadOk = listTaskLedgerRecords(roomId);
	assert(rereadOk.length === 1 && rereadOk[0].outcome === "ok", "reread must see the finalized row");

	// Finalize on a missing row returns null, never throws.
	assert(finalizeTaskLedgerRecord(roomId, "tsk-missing", { outcome: "error" }) === null, "finalizing a missing row must return null");

	// Second row: other conversation, later start, with an iterate parent.
	createTaskLedgerRecord(
		{ taskId: "tsk-bbb222", roomId, conversationId: "conv-2", templateId: "diagram", templateVersion: 1, title: "Flow", iterateParentTaskId: "tsk-aaa111" },
		{},
		new Date("2026-07-18T11:00:00.000Z"),
	);
	const all = listTaskLedgerRecords(roomId);
	assert(all.length === 2, "both rows must list");
	assert(all[0].taskId === "tsk-bbb222" && all[1].taskId === "tsk-aaa111", "listing must be newest-first by startedAt");
	assert(all[0].iterateParentTaskId === "tsk-aaa111", "iterateParentTaskId must round-trip");
	const filtered = listTaskLedgerRecords(roomId, { conversationId: "conv-1" });
	assert(filtered.length === 1 && filtered[0].taskId === "tsk-aaa111", "conversationId filter must apply");

	// Corrupt and foreign files are skipped, valid rows still list.
	fs.writeFileSync(taskLedgerRecordPath(roomId, "tsk-corrupt"), "not json", "utf-8");
	fs.writeFileSync(path.join(path.dirname(recordFile), "notes.txt"), "not a record", "utf-8");
	assert(listTaskLedgerRecords(roomId).length === 2, "corrupt and non-json files must be skipped");

	// Boot sweep: only running rows flip, across rooms; settled rows untouched.
	const otherRoom = "task-ledger-smoke-room-2";
	createTaskLedgerRecord({ taskId: "tsk-ccc333", roomId: otherRoom, conversationId: "conv-9", templateId: "deck", templateVersion: 3, title: "Interrupted" }, {}, new Date("2026-07-18T12:00:00.000Z"));
	const swept = sweepOrphanedTaskLedgerRecords({}, new Date("2026-07-18T13:00:00.000Z"));
	assert(swept === 2, `sweep must flip exactly the two running rows, got ${swept}`);
	const sweptRow = listTaskLedgerRecords(otherRoom)[0];
	assert(sweptRow.outcome === "orphaned" && sweptRow.endedAt === "2026-07-18T13:00:00.000Z", "swept row must be orphaned with endedAt");
	assert(listTaskLedgerRecords(roomId).find((r) => r.taskId === "tsk-aaa111")?.outcome === "ok", "settled rows must survive the sweep untouched");
	assert(sweepOrphanedTaskLedgerRecords() === 0, "second sweep must find nothing");

	// Export appends (slice D): entries accumulate on the row; a missing row is
	// a null no-op, never a throw.
	const withFirstExport = appendTaskLedgerExport(roomId, "tsk-aaa111", { relativePath: "tasks/tsk-aaa111/deck.html", savedTo: "/ws/deck.html", at: "2026-07-18T13:30:00.000Z" });
	assert(withFirstExport?.exports?.length === 1 && withFirstExport.exports[0].savedTo === "/ws/deck.html", "export append must land on the row");
	const withSecondExport = appendTaskLedgerExport(roomId, "tsk-aaa111", { relativePath: "tasks/tsk-aaa111/deck.html", savedTo: "/ws/deck-2.html", at: "2026-07-18T13:31:00.000Z" });
	assert(withSecondExport?.exports?.length === 2 && withSecondExport.exports[1].savedTo === "/ws/deck-2.html", "export appends must accumulate");
	assert(appendTaskLedgerExport(roomId, "tsk-missing", { relativePath: "x", savedTo: "y", at: "z" }) === null, "export append on a missing row must return null");

	// exports[] written by a future slice is tolerated and round-trips on read.
	const withExports = JSON.parse(fs.readFileSync(recordFile, "utf-8"));
	withExports.exports = [{ relativePath: "tasks/tsk-aaa111/deck.html", savedTo: "/ws/deck.html", at: "2026-07-18T14:00:00.000Z" }];
	fs.writeFileSync(recordFile, JSON.stringify(withExports, null, 2) + "\n", "utf-8");
	assert(listTaskLedgerRecords(roomId).find((r) => r.taskId === "tsk-aaa111")?.exports?.[0]?.savedTo === "/ws/deck.html", "exports must round-trip on read");

	// Away-notice lifecycle (rung 2): finalize with noticed stamps awayNoticedAt;
	// unnoticed terminal rows select for the notice; marking clears the debt.
	const noticeRoom = "task-ledger-smoke-room-3";
	createTaskLedgerRecord({ taskId: "tsk-n1", roomId: noticeRoom, conversationId: "conv-n", templateId: "deck", templateVersion: 1, title: "Seen live" }, {}, new Date("2026-07-18T15:00:00.000Z"));
	const noticedLive = finalizeTaskLedgerRecord(noticeRoom, "tsk-n1", { outcome: "ok", noticed: true }, {}, new Date("2026-07-18T15:05:00.000Z"));
	assert(noticedLive?.awayNoticedAt === "2026-07-18T15:05:00.000Z", "noticed finalize must stamp awayNoticedAt");
	createTaskLedgerRecord({ taskId: "tsk-n2", roomId: noticeRoom, conversationId: "conv-n", templateId: "deck", templateVersion: 1, title: "Died unseen" }, {}, new Date("2026-07-18T15:10:00.000Z"));
	finalizeTaskLedgerRecord(noticeRoom, "tsk-n2", { outcome: "aborted" }, {}, new Date("2026-07-18T15:11:00.000Z"));
	createTaskLedgerRecord({ taskId: "tsk-n3", roomId: noticeRoom, conversationId: "conv-n", templateId: "deck", templateVersion: 1, title: "Still running" }, {}, new Date("2026-07-18T15:12:00.000Z"));
	const awaySelection = selectTaskLedgerAwayNotices(listTaskLedgerRecords(noticeRoom), 5);
	assert(awaySelection.allTaskIds.length === 1 && awaySelection.notices[0]?.taskId === "tsk-n2", "only unnoticed terminal rows owe a notice (not live-noticed, not running)");
	assert(awaySelection.moreCount === 0, "moreCount must be zero under the cap");
	assert(markTaskLedgerRecordsAwayNoticed(noticeRoom, awaySelection.allTaskIds, {}, new Date("2026-07-18T16:00:00.000Z")) === 1, "marking must stamp the unnoticed row");
	assert(selectTaskLedgerAwayNotices(listTaskLedgerRecords(noticeRoom), 5).allTaskIds.length === 0, "marked rows must not re-notice");
	assert(markTaskLedgerRecordsAwayNoticed(noticeRoom, ["tsk-n2"]) === 0, "already-marked rows must not re-stamp");

	// Away-notice cap: newest capped, the rest counted, ALL ids returned.
	for (let i = 0; i < 7; i += 1) {
		const id = `tsk-cap${i}`;
		createTaskLedgerRecord({ taskId: id, roomId: noticeRoom, conversationId: "conv-cap", templateId: "deck", templateVersion: 1, title: `Cap ${i}` }, {}, new Date(`2026-07-18T17:0${i}:00.000Z`));
		finalizeTaskLedgerRecord(noticeRoom, id, { outcome: "error" }, {}, new Date(`2026-07-18T17:0${i}:30.000Z`));
	}
	const capped = selectTaskLedgerAwayNotices(listTaskLedgerRecords(noticeRoom, { conversationId: "conv-cap" }), 5);
	assert(capped.notices.length === 5 && capped.moreCount === 2 && capped.allTaskIds.length === 7, "cap must window notices but return every unnoticed id");
	assert(capped.notices[0].taskId === "tsk-cap6", "notices must be newest-first");

	// Reseed selection: ok rows only, newest capped, returned oldest-first.
	const reseedRows = [
		...["tsk-r1", "tsk-r2", "tsk-r3"].map((id, i) => ({ taskId: id, outcome: "ok", startedAt: `2026-07-18T18:0${i}:00.000Z` })),
		{ taskId: "tsk-r4", outcome: "error", startedAt: "2026-07-18T18:09:00.000Z" },
	] as Parameters<typeof selectTaskLedgerReseedRows>[0];
	const reseed = selectTaskLedgerReseedRows(reseedRows, 2);
	assert(reseed.length === 2 && reseed[0].taskId === "tsk-r2" && reseed[1].taskId === "tsk-r3", "reseed must keep the newest ok rows, oldest-first for insertion order");

	// Remove from list (user control, 2026-07-20): removedAt is a LIST stamp,
	// separate from deletedAt (files gone). Listings keep returning removed
	// rows — only the panel endpoint filters — and Undo clears the stamp.
	const removeRoom = "task-ledger-smoke-remove";
	createTaskLedgerRecord({ taskId: "tsk-rm1", roomId: removeRoom, conversationId: "conv-rm", templateId: "diagram-svg", templateVersion: 1, title: "Removable" }, {}, new Date("2026-07-18T19:00:00.000Z"));
	finalizeTaskLedgerRecord(removeRoom, "tsk-rm1", { outcome: "ok" }, {}, new Date("2026-07-18T19:01:00.000Z"));
	const removed = markTaskLedgerRecordRemoved(removeRoom, "tsk-rm1", {}, new Date("2026-07-18T19:05:00.000Z"));
	assert(removed?.removedAt === "2026-07-18T19:05:00.000Z", "remove must stamp removedAt");
	assert(removed?.awayNoticedAt === "2026-07-18T19:05:00.000Z", "removing an unnoticed row must also stamp awayNoticedAt (a dismissed task must not be announced later)");
	assert(markTaskLedgerRecordRemoved(removeRoom, "tsk-rm1", {}, new Date("2026-07-18T19:09:00.000Z"))?.removedAt === "2026-07-18T19:05:00.000Z", "re-removing must keep the first stamp");
	assert(listTaskLedgerRecords(removeRoom).length === 1, "default listings must still return removed rows (reseed/provenance readers)");
	assert(selectTaskLedgerAwayNotices(listTaskLedgerRecords(removeRoom), 5).notices.length === 0, "a removed row must never surface as an away notice");
	const restored = clearTaskLedgerRecordRemoved(removeRoom, "tsk-rm1");
	assert(restored !== null && restored.removedAt === undefined, "undo must clear removedAt");
	assert(JSON.parse(fs.readFileSync(taskLedgerRecordPath(removeRoom, "tsk-rm1"), "utf8")).removedAt === undefined, "undo must clear the stamp on disk, not just in the return value");
	assert(markTaskLedgerRecordRemoved(removeRoom, "tsk-missing") === null && clearTaskLedgerRecordRemoved(removeRoom, "tsk-missing") === null, "missing rows must return null for both stamps");

	// Path-escaping ids are rejected before any filesystem access.
	for (const bad of [() => listTaskLedgerRecords("../escape"), () => createTaskLedgerRecord({ taskId: "../escape", roomId, conversationId: "c", templateId: "t", templateVersion: 1, title: "x" }), () => taskLedgerRecordPath(roomId, "a/b")]) {
		let threw = false;
		try {
			bad();
		} catch (error) {
			threw = /invalid/.test((error as Error).message);
		}
		assert(threw, "path-escaping ids must be rejected");
	}

	fs.rmSync(root, { recursive: true, force: true });
	console.log("persistent-room task ledger smoke passed");
} catch (error) {
	console.error(error instanceof Error ? error.stack || error.message : error);
	console.error(`temp root preserved for inspection: ${root}`);
	process.exitCode = 1;
}
