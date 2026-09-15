// Taking back the latest memory save (memory v2).
//
// Memorize and Review both end in one approved write, and both archive the file
// they replaced first. That archived copy is the whole feature: undo is not a
// reverse edit derived from what a save did, it is the previous file put back
// byte for byte, plus the archive rows that save appended taken back out. What
// a person gets is the memory they had a minute ago, not a reconstruction of it.
//
// The one thing undo must never do is guess. It is offered only while the save
// is still the LATEST change to this room's memory, and that is not a matter of
// opinion: every save's event record carries the fingerprint of the file it
// wrote, measured on the room's own context render, so the check is "is the file
// on disk still the file this save wrote". Anything else that has touched the
// memory since — a Remember, a hand edit in Room settings, another Memorize, an
// earlier undo — changes that answer, and the offer is withdrawn with a sentence
// that says so. The record check beside it catches the changes the render
// deliberately cannot see (pinning an entry lives in a metadata comment the
// render strips), because a write nobody can see is still a write.
//
// Chronos is not rewritten here. The restored file carries the Chronos lines of
// before the save, which is exactly what the room is being put back to.

import fs from "node:fs";
import path from "node:path";

import { hasActiveAbsorbRun } from "./absorb-run.js";
import { parseMemoryDocument, renderMemoryContext } from "./memory-entries.js";
import { assertMemoryWriteAllowed, memoryBudgetState, restoreMemoryFile, type MemoryEditEventRecord } from "./memory-entries-store.js";
import { createPersistentAgentInstance, l1bStateMetrics, type AbsorbEventRecord, type PersistentAgentInstance, type ReviewEventRecord, type StructuralReviewEventRecord } from "./persistent-agents.js";
import { overMemoryBudget, readPersistentRoomMaintenanceSettings, writePersistentRoomMaintenanceSettings } from "./persistent-room-maintenance-settings.js";
import { hasActiveReviewRun } from "./review-run.js";
import { countRecentContextEntries } from "./recent-context-entries.js";

/** Which of the two approved saves an undo took back — the word the history row speaks. */
export type UndoneSaveKind = "memorize" | "review";

export interface MemoryUndoResponse {
	agentId: string;
	undoId: string;
	undone: { saveId: string; kind: UndoneSaveKind; approvedAt: string };
	/** The same budget block the two approvals return, measured after the restore — and after the limit went back down, when it did. */
	memoryBudget: { budgetTokens: number; reviewTargetEstimatedTokens: number; overBudget: boolean };
	/** How many conversations are back in Recent Context now the save is taken back. */
	recentContextCount: number;
	/** Present when the undone save had raised the room's limit and this undo put it back: the limit the room has again. */
	limitLoweredTo?: number;
}

// --- product sentences -------------------------------------------------------

export const MEMORY_UNDO_UNKNOWN_SENTENCE = "That save is not in this room's memory history.";
export const MEMORY_UNDO_KIND_SENTENCE = "Only a Memorize or Review save can be undone.";
export const MEMORY_UNDO_STALE_SENTENCE = "The memory has changed since this save, so it can no longer be undone.";
export const MEMORY_UNDO_SNAPSHOT_MISSING_SENTENCE = "The copy of the memory from before this save is missing, so it cannot be undone.";
export const MEMORY_UNDO_RUN_ACTIVE_SENTENCE = "This room is updating its memory right now. Wait for that update to finish, then undo.";

function productError(message: string, code: string, statusCode = 400): Error {
	const error = new Error(message);
	(error as any).statusCode = statusCode;
	(error as any).code = code;
	return error;
}

function unknownSaveError(): Error {
	return productError(MEMORY_UNDO_UNKNOWN_SENTENCE, "memory_undo_unknown", 404);
}

function staleError(): Error {
	return productError(MEMORY_UNDO_STALE_SENTENCE, "memory_undo_stale", 409);
}

// --- the save being undone ---------------------------------------------------

interface UndoableSave {
	kind: UndoneSaveKind;
	saveId: string;
	approvedAt: string;
	/** The room-relative path of the file this save replaced: what goes back. */
	archivedRelPath: string;
	/** The fingerprint of the file this save WROTE, as the save itself measured it. */
	resultFingerprint: string;
	/** The archive rows this save appended, so the undo takes back out exactly those. */
	archiveRowIds: string[];
	/** The limit this save raised, when it did: from the room's old setting to the one the save wrote. Null for a save made against the saved limit. */
	limitRaise: { from: number; to: number } | null;
}

/** The raise a Memorize or Review record carries, or null when that save raised nothing (or is too old to say). */
function limitRaiseOf(budget: { budgetTokens?: number; raisedFrom?: number } | undefined): UndoableSave["limitRaise"] {
	if (!budget || typeof budget.raisedFrom !== "number" || typeof budget.budgetTokens !== "number") return null;
	return { from: budget.raisedFrom, to: budget.budgetTokens };
}

function readRecord<T>(file: string): T | null {
	try {
		return JSON.parse(fs.readFileSync(file, "utf-8")) as T;
	} catch {
		return null; // absent, unreadable or partial — indistinguishable from the caller's side
	}
}

/**
 * An id the room has no record of at all, versus one whose record is a kind undo
 * does not serve. The difference is the whole refusal: a person who clicks Undo
 * on a Remember is told what can be undone, not that their save vanished.
 */
function findSave(instance: PersistentAgentInstance, saveId: string): UndoableSave {
	let absorbPath: string;
	let reviewRunPath: string;
	let reviewPath: string;
	try {
		absorbPath = instance.absorbEventRecordPath(saveId);
		reviewRunPath = instance.reviewEventRecordPath(saveId);
		reviewPath = instance.structuralReviewEventRecordPath(saveId);
	} catch {
		throw unknownSaveError(); // an id no event record could ever be named after
	}

	const absorb = readRecord<AbsorbEventRecord>(absorbPath);
	if (absorb) {
		return {
			kind: "memorize",
			saveId,
			approvedAt: String(absorb.approvedAt ?? ""),
			archivedRelPath: String(absorb.paths?.archivedL1bRelPath ?? ""),
			resultFingerprint: String(absorb.result?.l1bFingerprint?.value ?? ""),
			// Memorize is the only save that appends to the archive: the entries
			// it demoted, superseded and closed, each named in its own record.
			archiveRowIds: (absorb.run?.archived ?? []).map((row) => String(row.id)).filter(Boolean),
			limitRaise: limitRaiseOf(absorb.run?.budget),
		};
	}
	const reviewRun = readRecord<ReviewEventRecord>(reviewRunPath);
	if (reviewRun) {
		return {
			kind: "review",
			saveId,
			approvedAt: String(reviewRun.approvedAt ?? ""),
			archivedRelPath: String(reviewRun.paths?.archivedL1bRelPath ?? ""),
			resultFingerprint: String(reviewRun.result?.l1bFingerprint?.value ?? ""),
			// Review v2 archives what it tidied away: the notes it superseded,
			// the ones it moved to the archive, and the ones the budget took.
			archiveRowIds: (reviewRun.run?.archived ?? []).map((row) => String(row.id)).filter(Boolean),
			limitRaise: limitRaiseOf(reviewRun.run?.budget),
		};
	}
	// The whole-rewrite Review this one replaces. Its saves are still on disk in
	// rooms that ran it, and they are still undoable.
	const review = readRecord<StructuralReviewEventRecord>(reviewPath);
	if (review) {
		return {
			kind: "review",
			saveId,
			approvedAt: String(review.approvedAt ?? ""),
			archivedRelPath: String(review.paths?.archivedL1bRelPath ?? ""),
			resultFingerprint: String(review.result?.l1bFingerprint?.value ?? ""),
			archiveRowIds: [], // the whole-rewrite Review never touched the archive file
			limitRaise: null, // and it had no card to raise the limit from
		};
	}
	// A save of a kind undo does not serve: a Remember (checkpoint) or a hand
	// edit, migration or earlier undo (memory-edit).
	for (const file of [instance.checkpointEventRecordPath(saveId), instance.memoryEditEventRecordPath(saveId)]) {
		if (fs.existsSync(file)) throw productError(MEMORY_UNDO_KIND_SENTENCE, "memory_undo_kind");
	}
	throw unknownSaveError();
}

// --- "still the latest save" -------------------------------------------------

/**
 * The file on disk, measured the way every event record measures what it wrote:
 * the CONTEXT render (entry metadata stripped), without archive pointer lines,
 * through the one metrics function the records use. Two arithmetics would make
 * this comparison a guess; there is one.
 */
function currentResultFingerprint(instance: PersistentAgentInstance): string {
	const l1b = instance.readL1b();
	return l1bStateMetrics(renderMemoryContext(l1b)).l1bFingerprint.value;
}

/**
 * Whether any memory write landed after this save. The fingerprint above catches
 * every change the room can READ; this catches the rest — pinning an entry, for
 * one, lives in a metadata comment the context render strips, and undoing over
 * it would silently take the pin back too.
 */
function writtenAfter(instance: PersistentAgentInstance, save: UndoableSave): boolean {
	const savedAt = Date.parse(save.approvedAt);
	if (!Number.isFinite(savedAt)) return true; // a record that cannot date itself cannot be proven latest
	const dirs = [instance.checkpointEventDir(), instance.absorbEventDir(), instance.reviewEventDir(), instance.structuralReviewEventDir(), instance.memoryEditEventDir()];
	for (const dir of dirs) {
		let files: string[];
		try {
			files = fs.readdirSync(dir);
		} catch {
			continue; // no events of this kind yet
		}
		for (const file of files) {
			if (!file.endsWith(".json")) continue;
			const record = readRecord<{ approvedAt?: string }>(path.join(dir, file));
			const at = Date.parse(String(record?.approvedAt ?? ""));
			if (Number.isFinite(at) && at > savedAt) return true;
		}
	}
	return false;
}

// --- the undo ----------------------------------------------------------------

/**
 * Takes back the room's latest memory save. Every refusal is a product sentence
 * with a stable code; nothing is written unless all of them pass.
 *
 * The room-usable check and the room lock belong to the route (they are the
 * server's doors, and the lock lives there), exactly as they do for the entry
 * routes and Memento.
 */
export function undoMemorySave(agentIdRaw: string, saveIdRaw: unknown, now = new Date()): MemoryUndoResponse {
	const instance = createPersistentAgentInstance(agentIdRaw);
	const agentId = instance.agentId;
	const saveId = String(saveIdRaw ?? "").trim();
	if (!saveId) throw unknownSaveError();

	// Memory is what a running turn is reading, and what a running Memorize is
	// about to write: an undo underneath either is how a room answers from a
	// memory nobody has any more.
	assertMemoryWriteAllowed(agentId);
	if (hasActiveAbsorbRun(agentId) || hasActiveReviewRun(agentId)) throw productError(MEMORY_UNDO_RUN_ACTIVE_SENTENCE, "memory_undo_run_active", 409);

	const save = findSave(instance, saveId);
	// A record that never said what it wrote cannot be shown to be the latest
	// save, and an undo that cannot prove that is a guess at someone's memory.
	if (!save.resultFingerprint) throw staleError();
	if (currentResultFingerprint(instance) !== save.resultFingerprint) throw staleError();
	if (writtenAfter(instance, save)) throw staleError();

	if (!save.archivedRelPath) throw productError(MEMORY_UNDO_SNAPSHOT_MISSING_SENTENCE, "memory_undo_snapshot_missing", 409);
	let snapshotPath: string;
	try {
		snapshotPath = instance.resolveRootRelativePath(save.archivedRelPath, "archived memory path");
	} catch {
		throw productError(MEMORY_UNDO_SNAPSHOT_MISSING_SENTENCE, "memory_undo_snapshot_missing", 409);
	}
	let restoredL1b: string;
	try {
		restoredL1b = fs.readFileSync(snapshotPath, "utf-8");
	} catch {
		throw productError(MEMORY_UNDO_SNAPSHOT_MISSING_SENTENCE, "memory_undo_snapshot_missing", 409);
	}

	// A limit the save raised goes back down with the save — but only while the
	// room still has the limit that save wrote. A limit the person has changed
	// since is theirs, and the undo leaves it alone without a word.
	const limitLoweredTo = save.limitRaise && readPersistentRoomMaintenanceSettings(agentId).memoryBudgetTokens === save.limitRaise.to ? save.limitRaise.from : undefined;

	const written = restoreMemoryFile(agentId, {
		restoredL1b,
		snapshotLabel: "undo",
		archiveRemoveIds: save.archiveRowIds,
		now,
		writeEventRecord: (recorded) => {
			// The file is back at this point; the limit follows it here, before the
			// record is written, so the record's budget block is measured against
			// the limit the room actually has once this undo is done.
			if (limitLoweredTo !== undefined) writePersistentRoomMaintenanceSettings(agentId, { memoryBudgetTokens: limitLoweredTo });
			const budgetTokens = limitLoweredTo ?? recorded.budgetAfter.budgetTokens;
			const eventRecordPath = instance.memoryEditEventRecordPath(recorded.writeId);
			const record: MemoryEditEventRecord = {
				schemaVersion: 1,
				operation: "memory_edit",
				kind: "undo",
				agentId,
				memoryEditId: recorded.writeId,
				approvedAt: recorded.now.toISOString(),
				undoneSaveId: save.saveId,
				undoneKind: save.kind,
				undoneAt: save.approvedAt,
				...(save.archiveRowIds.length ? { restored: [...save.archiveRowIds] } : {}),
				...(limitLoweredTo !== undefined ? { limitLoweredTo } : {}),
				paths: {
					archivedL1bRelPath: instance.rootRelativePath(recorded.archivedL1bPath),
					updatedL1bRelPath: instance.rootRelativePath(recorded.updatedL1bPath),
					eventRelPath: instance.rootRelativePath(eventRecordPath),
				},
				budget: {
					budgetTokens,
					reviewTargetTokensBefore: recorded.budgetBefore.reviewTargetTokens,
					reviewTargetTokensAfter: recorded.budgetAfter.reviewTargetTokens,
					overBudgetBefore: recorded.budgetBefore.overBudget,
					overBudgetAfter: overMemoryBudget(recorded.budgetAfter.reviewTargetTokens, budgetTokens),
				},
			};
			fs.mkdirSync(path.dirname(eventRecordPath), { recursive: true, mode: 0o700 });
			fs.writeFileSync(eventRecordPath, JSON.stringify(record, null, 2) + "\n", { mode: 0o600, flag: "wx" });
			return { eventRecordPath, eventRelPath: record.paths.eventRelPath };
		},
	});
	// Measured after the settings write, so the block says what the room has now.
	const budget = limitLoweredTo === undefined ? written.budget : memoryBudgetState(agentId, parseMemoryDocument(restoredL1b));

	return {
		agentId,
		undoId: written.writeId,
		undone: { saveId: save.saveId, kind: save.kind, approvedAt: save.approvedAt },
		memoryBudget: {
			budgetTokens: budget.budgetTokens,
			reviewTargetEstimatedTokens: budget.reviewTargetTokens,
			overBudget: budget.overBudget,
		},
		recentContextCount: countRecentContextEntries(restoredL1b),
		...(limitLoweredTo !== undefined ? { limitLoweredTo } : {}),
	};
}
