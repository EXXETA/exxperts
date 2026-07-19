import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const agentsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "exxeta-gc-agents-"));
const artifactsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "exxeta-gc-artifacts-"));
process.env.EXXETA_PERSISTENT_AGENTS_ROOT = agentsRoot;

const { createTaskLedgerRecord, finalizeTaskLedgerRecord, listTaskLedgerRecords } = await import("../src/persistent-room-task-ledger.js");
const { assessTaskStoreGc, collectProtectedTaskIds, executeTaskStoreGc } = await import("../src/specialist-task-store-gc.js");

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

const NOW = new Date("2026-07-18T15:00:00.000Z");
const opts = { persistentAgentsRoot: agentsRoot, artifactsRoot, now: NOW };
const roomId = "gc-smoke-room";

function seedTaskDir(taskId: string, bytes: number): void {
	const dir = path.join(artifactsRoot, "tasks", taskId);
	fs.mkdirSync(path.join(dir, ".thumbs"), { recursive: true });
	fs.writeFileSync(path.join(dir, "artifact.html"), Buffer.alloc(bytes));
	fs.writeFileSync(path.join(dir, ".thumbs", "preview.png"), Buffer.alloc(64));
}

function seedLedgerRow(taskId: string, startedAt: string, extras: { iterateParentTaskId?: string; running?: boolean } = {}): void {
	createTaskLedgerRecord(
		{ taskId, roomId, conversationId: "conv-gc", templateId: "deck", templateVersion: 1, title: `Task ${taskId}`, ...(extras.iterateParentTaskId ? { iterateParentTaskId: extras.iterateParentTaskId } : {}) },
		{ persistentAgentsRoot: agentsRoot },
		new Date(startedAt),
	);
	if (!extras.running) finalizeTaskLedgerRecord(roomId, taskId, { outcome: "ok" }, { persistentAgentsRoot: agentsRoot }, new Date(startedAt));
}

try {
	// Store: five 1000-byte tasks (plus 64B thumbs each), oldest → newest.
	seedTaskDir("tsk-g1", 1000); // oldest, unreferenced → first candidate
	seedTaskDir("tsk-g2", 1000); // referenced by an OPEN thread item → protected
	seedTaskDir("tsk-g3", 1000); // iterate-parent of a recent row → protected
	seedTaskDir("tsk-g4", 1000); // running → protected
	seedTaskDir("tsk-g5", 1000); // newest, unreferenced
	seedLedgerRow("tsk-g1", "2026-07-01T10:00:00.000Z");
	seedLedgerRow("tsk-g2", "2026-07-02T10:00:00.000Z");
	seedLedgerRow("tsk-g3", "2026-07-03T10:00:00.000Z");
	seedLedgerRow("tsk-g4", "2026-07-04T10:00:00.000Z", { running: true });
	seedLedgerRow("tsk-g5", "2026-07-05T10:00:00.000Z");
	seedLedgerRow("tsk-child", "2026-07-17T10:00:00.000Z", { iterateParentTaskId: "tsk-g3" });

	// Threads: an open thread referencing g2, a CLOSED one referencing g5.
	const threadsDir = path.join(agentsRoot, roomId, "runtime", "threads");
	fs.mkdirSync(threadsDir, { recursive: true });
	fs.writeFileSync(path.join(threadsDir, "t-open.json"), JSON.stringify({ state: "standby", items: [{ kind: "task", taskId: "tsk-g2" }] }));
	fs.writeFileSync(path.join(threadsDir, "t-closed.json"), JSON.stringify({ state: "closed", items: [{ kind: "task", taskId: "tsk-g5" }] }));

	// Protection set: exactly g2 (open thread), g3 (recent iterate parent), g4 (running).
	const protectedIds = collectProtectedTaskIds(opts);
	assert(protectedIds.has("tsk-g2") && protectedIds.has("tsk-g3") && protectedIds.has("tsk-g4"), `protected set incomplete: ${[...protectedIds].join(",")}`);
	assert(!protectedIds.has("tsk-g1") && !protectedIds.has("tsk-g5"), "closed-thread references and plain old tasks are not protected");

	// Below threshold: the valve stays shut.
	const shut = assessTaskStoreGc({ ...opts, thresholdBytes: 1_000_000 });
	assert(shut.proposal === null && shut.totalBytes > 0, "below threshold there is no proposal");

	// Above threshold: oldest unreferenced first, protected never proposed.
	const open = assessTaskStoreGc({ ...opts, thresholdBytes: 2000 });
	assert(open.proposal !== null, "above threshold there is a proposal");
	const proposedIds = open.proposal!.candidates.map((candidate) => candidate.taskId);
	assert(proposedIds[0] === "tsk-g1", `oldest unreferenced first, got ${proposedIds.join(",")}`);
	assert(!proposedIds.includes("tsk-g2") && !proposedIds.includes("tsk-g3") && !proposedIds.includes("tsk-g4"), "protected tasks are never proposed");
	assert(open.proposal!.candidates[0].title === "Task tsk-g1", "candidates carry the ledger title");
	assert(open.proposal!.reclaimBytes > 0, "proposal reports reclaimable bytes");

	// Execution: deletes exactly the approved ids, re-verifying protection; the
	// ledger row survives with a deletedAt stamp and default listings hide it.
	const result = executeTaskStoreGc(["tsk-g1", "tsk-g2", "../evil", "tsk-none"], opts);
	assert(result.deleted.length === 1 && result.deleted[0] === "tsk-g1", `only the unprotected id deletes, got ${JSON.stringify(result)}`);
	assert(result.skipped.find((s) => s.taskId === "tsk-g2")?.reason === "protected", "protected ids skip at execute time too");
	assert(result.skipped.find((s) => s.taskId === "../evil")?.reason === "invalid", "invalid ids are rejected");
	assert(result.skipped.find((s) => s.taskId === "tsk-none")?.reason === "missing", "missing dirs are reported");
	assert(!fs.existsSync(path.join(artifactsRoot, "tasks", "tsk-g1")), "the task folder (thumbs included) is gone");
	assert(fs.existsSync(path.join(artifactsRoot, "tasks", "tsk-g2")), "protected folders are untouched");
	assert(result.reclaimedBytes >= 1000, "reclaimed bytes are counted");
	const visible = listTaskLedgerRecords(roomId, { persistentAgentsRoot: agentsRoot });
	assert(!visible.find((row) => row.taskId === "tsk-g1"), "deleted rows are hidden from default listings");
	const audit = listTaskLedgerRecords(roomId, { persistentAgentsRoot: agentsRoot, includeDeleted: true });
	const stamped = audit.find((row) => row.taskId === "tsk-g1");
	assert(stamped?.deletedAt === NOW.toISOString() && stamped.outcome === "ok", "the row survives with a deletedAt stamp, outcome preserved");

	// One undeletable folder must not abort the batch: g5 is made undeletable
	// (a read-only subdir blocks unlinking its contents), tsk-g6 after it in
	// the SAME batch still deletes, and the failure is reported by id.
	// POSIX-only: Windows chmod cannot make a directory undeletable (it no-ops
	// on dirs, and Node's rm force-clears read-only files via its EPERM retry),
	// so a locked folder cannot be staged on a Windows CI runner. The per-item
	// try/catch under test is platform-independent and stays covered by the
	// macOS/Linux CI legs.
	if (process.platform !== "win32") {
		seedTaskDir("tsk-g6", 1000);
		seedLedgerRow("tsk-g6", "2026-07-06T10:00:00.000Z");
		const lockedDir = path.join(artifactsRoot, "tasks", "tsk-g5", "locked");
		fs.mkdirSync(lockedDir);
		fs.writeFileSync(path.join(lockedDir, "pin.html"), "x");
		fs.chmodSync(lockedDir, 0o500);
		try {
			const partial = executeTaskStoreGc(["tsk-g5", "tsk-g6"], opts);
			assert(partial.failed.length === 1 && partial.failed[0].taskId === "tsk-g5" && partial.failed[0].reason.length > 0, `the locked folder is reported failed, got ${JSON.stringify(partial)}`);
			assert(partial.deleted.length === 1 && partial.deleted[0] === "tsk-g6", "the batch continues past the failure");
			assert(!fs.existsSync(path.join(artifactsRoot, "tasks", "tsk-g6")), "the later folder is really gone");
			assert(fs.existsSync(lockedDir), "the locked folder survives");
			const auditAfter = listTaskLedgerRecords(roomId, { persistentAgentsRoot: agentsRoot, includeDeleted: true });
			assert(!auditAfter.find((row) => row.taskId === "tsk-g5")?.deletedAt, "a failed delete is never stamped deletedAt");
		} finally {
			// Guarded so a failing assertion above is never masked by cleanup
			// throwing ENOENT (exactly what hid the real failure on Windows CI).
			if (fs.existsSync(lockedDir)) fs.chmodSync(lockedDir, 0o700);
		}
	}

	fs.rmSync(agentsRoot, { recursive: true, force: true });
	fs.rmSync(artifactsRoot, { recursive: true, force: true });
	console.log("task store GC smoke passed");
} catch (error) {
	console.error(error instanceof Error ? error.stack || error.message : error);
	console.error(`temp roots preserved for inspection: ${agentsRoot} ${artifactsRoot}`);
	process.exitCode = 1;
}
