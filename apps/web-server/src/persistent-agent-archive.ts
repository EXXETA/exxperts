import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { readShelfFilesWithOrigin } from "./persistent-room-shelf.js";
import { migrateMemoryDocument, parseMemoryDocument } from "./memory-entries.js";
import { listTaskLedgerRecords } from "./persistent-room-task-ledger.js";
import { backgroundRunsDirectoryPath, isValidBackgroundRunId } from "./background-runs.js";
import { artifactRoot } from "../../../pi-package/extensions/artifacts/index.js";
import { abortAllSpecialistTasks, runningSpecialistCount } from "./persistent-room-specialist-registry.js";
import { readPersistentRoomScheduleStore, parsePersistentRoomSchedule, computePersistentRoomScheduleDueOccurrence, writePersistentRoomScheduleStore } from "../../../pi-package/extensions/schedule-prompt/index.js";
import { productAppStatePath } from "../../../pi-package/product-state-paths.js";
import type { PersistentAgentId } from "./persistent-agent-types.js";
import { activePersistentRoomLock, type AgentJson, createPersistentAgentInstance, ensureDir, isPersistentAgentArchived, isValidPersistentAgentId, PERSISTENT_AGENTS_ROOT, persistentAgentActiveTurns, persistentRoomLock, writeFileAtomic } from "./persistent-agent-store.js";
import { writePersistentAgentRuntimeState } from "./persistent-agent-threads.js";
import { clearPersistentAgentUnseenLandedAnswer, hasPersistentAgentTurnInFlight } from "./persistent-agent-turns.js";
import { assertPersistentAgentDisplayNameAvailable, collapseHumanWhitespace } from "./persistent-agent-create.js";

export interface PersistentAgentArchiveOptions {
	confirmation: string;
	reason?: string;
	archivedBy?: string;
	/** In-process signal from the web server: a detached turn is still cooking for this room. */
	detachedCooking?: boolean;
}

export interface PersistentAgentArchiveResult {
	agentId: PersistentAgentId;
	archivedAt: number;
	status: "archived";
}

export function archivePersistentAgent(agentIdRaw: string, options: PersistentAgentArchiveOptions): PersistentAgentArchiveResult {
	const instance = createPersistentAgentInstance(agentIdRaw);
	const expectedConfirmation = `DELETE ${instance.agentId}`;
	if (String(options.confirmation ?? "") !== expectedConfirmation) {
		const error = new Error(`confirmation must exactly match: ${expectedConfirmation}`);
		(error as any).statusCode = 400;
		throw error;
	}
	if (!fs.existsSync(instance.rootDir)) {
		const error = new Error(`persistent agent not found: ${instance.agentId}`);
		(error as any).statusCode = 404;
		throw error;
	}
	const agentJsonPath = instance.agentJsonPath();
	const meta = instance.readAgentJson();
	if (!meta) {
		const error = new Error("agent.json is missing or invalid JSON");
		(error as any).statusCode = 409;
		throw error;
	}
	if (meta.id && meta.id !== instance.agentId) {
		const error = new Error(`agent.json id mismatch: ${meta.id}`);
		(error as any).statusCode = 409;
		throw error;
	}
	if (isPersistentAgentArchived(meta)) {
		const error = new Error(`persistent agent is already archived: ${instance.agentId}`);
		(error as any).statusCode = 409;
		throw error;
	}
	// Same busy guards as purge: an archive mid-answer would rip the room out
	// from under a running turn (or another surface holding it) exactly like a
	// purge would, just recoverably — refuse with the same honest reasons.
	const lock = activePersistentRoomLock(instance.agentId);
	if (lock) {
		const where = lock.surface === "web"
			? "is still open in a browser session; leave the room (or close the other session) and try again"
			: `is open or busy in another surface (${lock.surface ?? "unknown"}); close it there before deleting`;
		throw purgeBusyError(`persistent room ${where}: ${instance.agentId}`, "room_lock");
	}
	if (hasPersistentAgentTurnInFlight(instance.agentId)) {
		throw purgeBusyError(`persistent room has a response in flight; stop it or wait for it to finish before deleting: ${instance.agentId}`, "turn_in_flight");
	}
	if (options.detachedCooking) {
		throw purgeBusyError(`persistent room is still finishing a background answer; wait for it to land before deleting: ${instance.agentId}`, "detached_cooking");
	}
	// Option 4 lets specialist workers outlive their connection; an archived
	// room has no panel, run view, or task_abort left to stop them from, so
	// the archive itself is the last stop surface.
	abortAllSpecialistTasks(instance.agentId);
	const archivedAt = Date.now();
	const archivedReason = typeof options.reason === "string" ? collapseHumanWhitespace(options.reason).slice(0, 500) : "";
	const updatedMeta: AgentJson = {
		...(meta as AgentJson),
		status: "archived",
		archivedAt,
		archivedBy: typeof options.archivedBy === "string" && options.archivedBy.trim() ? options.archivedBy.trim().slice(0, 80) : "local-user",
		...(archivedReason ? { archivedReason } : {}),
		updatedAt: archivedAt,
	};
	ensureDir(path.dirname(instance.runtimeStatePath()));
	writePersistentAgentRuntimeState(instance.agentId, { state: "idle" });
	clearPersistentAgentUnseenLandedAnswer(instance.agentId);
	writeFileAtomic(agentJsonPath, JSON.stringify(updatedMeta, null, 2) + "\n");
	return { agentId: instance.agentId, archivedAt, status: "archived" };
}

// What a room amounts to on this machine, in the user's vocabulary: the danger
// zone and the archived-rooms list must state real numbers, not adjectives.
// Conversations = thread files, memories = the notes the room's Memory view
// lists (conversations waiting for Memorize are not memories yet), scheduled
// tasks = the room's schedule store, files = the shelf, documents = the shelf
// files the room itself produced.
export interface PersistentAgentLifecycleCounts {
	conversations: number;
	memories: number;
	scheduledTasks: number;
	files: number;
	documents: number;
}

// A part that is not there at all is truly empty and counts 0. A part there
// but unreadable leaves the counts incomplete: its 0 stands in for what Delete
// still removes, so the danger zone must not state it as a number.
function isMissing(error: unknown): boolean {
	return (error as NodeJS.ErrnoException)?.code === "ENOENT";
}

export function getPersistentAgentLifecycleCounts(agentIdRaw: string): { counts: PersistentAgentLifecycleCounts; complete: boolean } {
	const instance = createPersistentAgentInstance(agentIdRaw);
	if (!fs.existsSync(instance.rootDir)) {
		const error = new Error(`persistent agent not found: ${instance.agentId}`);
		(error as any).statusCode = 404;
		throw error;
	}
	let complete = true;
	let conversations = 0;
	try {
		conversations = fs.readdirSync(instance.runtimeThreadsDir()).filter((name) => name.endsWith(".json")).length;
	} catch (error) {
		// no threads dir yet — a fresh or hand-pruned room simply has none
		if (!isMissing(error)) complete = false;
	}
	let memories = 0;
	try {
		// The notes the Memory view lists: the file migrated in memory, which drops
		// the scaffold's template paragraph. Pure on purpose: the view's loader also
		// settles the memory budget, a write an archived room must never get.
		const doc = migrateMemoryDocument(parseMemoryDocument(instance.readL1b()), { fallbackSaved: "" }).doc;
		memories = doc.topics.reduce((sum, topic) => sum + topic.entries.length, 0);
	} catch (error) {
		if (!isMissing(error)) complete = false;
	}
	let scheduledTasks = 0;
	try {
		scheduledTasks = readPersistentRoomScheduleStore(instance.agentId).jobs.length;
	} catch {
		// The reader answers a missing store with no jobs, so a throw is an unreadable one.
		complete = false;
	}
	let files = 0;
	let documents = 0;
	try {
		const shelf = readShelfFilesWithOrigin(instance.agentId);
		files = shelf.entries.length;
		documents = shelf.entries.filter((entry) => entry.origin === "room").length;
		if (!shelf.complete) complete = false;
	} catch {
		complete = false;
	}
	return { counts: { conversations, memories, scheduledTasks, files, documents }, complete };
}

export interface ArchivedPersistentAgentSummary {
	id: PersistentAgentId;
	displayName?: string;
	archivedAt: number;
	archivedReason?: string;
	counts: PersistentAgentLifecycleCounts;
}

// The archived shadow of listPersistentAgents: everything that listing hides.
// Rows carry the counts the Home section states, newest archive first.
export function listArchivedPersistentAgents(): ArchivedPersistentAgentSummary[] {
	const rows: ArchivedPersistentAgentSummary[] = [];
	try {
		if (!fs.existsSync(PERSISTENT_AGENTS_ROOT)) return rows;
		for (const entry of fs.readdirSync(PERSISTENT_AGENTS_ROOT, { withFileTypes: true })) {
			if (!entry.isDirectory() || !isValidPersistentAgentId(entry.name)) continue;
			try {
				const instance = createPersistentAgentInstance(entry.name);
				const meta = instance.readAgentJson();
				if (!meta || !isPersistentAgentArchived(meta)) continue;
				rows.push({
					id: instance.agentId,
					...(typeof meta.displayName === "string" && meta.displayName ? { displayName: meta.displayName } : {}),
					archivedAt: Number(meta.archivedAt),
					...(typeof meta.archivedReason === "string" && meta.archivedReason ? { archivedReason: meta.archivedReason } : {}),
					counts: getPersistentAgentLifecycleCounts(instance.agentId).counts,
				});
			} catch {
				// one unreadable room must not hide the rest of the archive
			}
		}
	} catch {
		// an unscannable root lists as empty, matching listPersistentAgents
	}
	return rows.sort((a, b) => b.archivedAt - a.archivedAt);
}

export interface PersistentAgentRestoreResult {
	agentId: PersistentAgentId;
	restoredAt: number;
	status: "ready";
	/** Enabled schedule jobs that resume with the room — at their next natural time, never immediately. */
	enabledSchedules: number;
	/** One-shot jobs whose time passed while the room was archived: disabled and marked missed, they need a new time. */
	missedOnceSchedules: number;
	/** Set when the schedule store could not be re-anchored — overdue jobs may still fire, and the user deserves to hear it. */
	scheduleNotice?: string;
}

// Restore must never fire a schedule the moment the user clicks it: the store
// kept stale nextRunAt anchors through the archive, and re-admitting the room
// to the schedule scan would make every overdue job immediately due. Each
// enabled job is re-anchored to its next natural FUTURE slot instead — an
// interval restarts from now, a one-shot whose time already passed is disabled
// and marked missed (visible, never silently dropped), and a daily cron gets
// its created-at fence moved up so occurrences from the archived stretch are
// skipped with a note rather than fired as catch-up.
function reanchorPersistentRoomSchedulesOnRestore(agentId: PersistentAgentId, restoredAt: number): { enabledSchedules: number; missedOnceSchedules: number; scheduleNotice?: string } {
	let enabledSchedules = 0;
	let missedOnceSchedules = 0;
	try {
		const store = readPersistentRoomScheduleStore(agentId);
		const now = new Date(restoredAt);
		const nowIso = now.toISOString();
		let dirty = false;
		for (const job of store.jobs) {
			if (!job.enabled) continue;
			if (job.type === "once") {
				const at = job.nextRunAt ? Date.parse(job.nextRunAt) : NaN;
				if (!Number.isFinite(at) || at <= restoredAt) {
					job.enabled = false;
					job.lastStatus = "missed";
					job.lastError = "Its scheduled time passed while the room was archived. Give it a new time to run it.";
					job.updatedAt = nowIso;
					dirty = true;
					missedOnceSchedules += 1;
					continue;
				}
				enabledSchedules += 1;
				continue;
			}
			if (job.type === "interval") {
				const anchor = job.nextRunAt ? Date.parse(job.nextRunAt) : NaN;
				if (!Number.isFinite(anchor) || anchor <= restoredAt) {
					try {
						job.nextRunAt = parsePersistentRoomSchedule(job.schedule, "interval", { now }).nextRunAt;
						job.updatedAt = nowIso;
						dirty = true;
					} catch {
						// an unparseable interval was never runnable; leave it as stored
					}
				}
				enabledSchedules += 1;
				continue;
			}
			// cron: due-ness is fenced by createdAt (no occurrences from before the
			// job existed) — moving that fence to the restore moment is exactly
			// "skip the archived stretch". The missed marker only lands on a job
			// with no real outcome yet: a genuinely completed or failed last run
			// stays on the record, the fence move alone is what stops the fire.
			try {
				if (computePersistentRoomScheduleDueOccurrence(job, { now }).due) {
					job.createdAt = nowIso;
					if (job.lastStatus === null || job.lastStatus === "never_run") {
						job.lastStatus = "missed";
						job.lastError = "Runs were skipped while the room was archived. The next run happens at its usual time.";
					}
					job.updatedAt = nowIso;
					dirty = true;
				}
			} catch {
				// a job the due calculation cannot read cannot fire either
			}
			enabledSchedules += 1;
		}
		if (dirty) writePersistentRoomScheduleStore(store);
	} catch {
		// The store exists but could not be read or rewritten: the scanner may
		// still act on its stale anchors, so the restore response says so
		// instead of silently hoping.
		return {
			enabledSchedules: 0,
			missedOnceSchedules: 0,
			scheduleNotice: "The room's schedule list could not be updated. Overdue scheduled tasks may still run once. Check Scheduled tasks in the room settings.",
		};
	}
	return { enabledSchedules, missedOnceSchedules };
}

export function restorePersistentAgent(agentIdRaw: string): PersistentAgentRestoreResult {
	const instance = createPersistentAgentInstance(agentIdRaw);
	if (!fs.existsSync(instance.rootDir)) {
		const error = new Error(`persistent agent not found: ${instance.agentId}`);
		(error as any).statusCode = 404;
		throw error;
	}
	const meta = instance.readAgentJson();
	if (!meta) {
		const error = new Error("agent.json is missing or invalid JSON");
		(error as any).statusCode = 409;
		throw error;
	}
	if (meta.id && meta.id !== instance.agentId) {
		const error = new Error(`agent.json id mismatch: ${meta.id}`);
		(error as any).statusCode = 409;
		throw error;
	}
	if (!isPersistentAgentArchived(meta)) {
		const error = new Error(`persistent agent is not archived: ${instance.agentId}`);
		(error as any).statusCode = 409;
		throw error;
	}
	// Creation only guards against ACTIVE names, so an archived room's name can
	// have been re-taken since — restoring then would put two identical names
	// on Home, exactly what the uniqueness rule exists to prevent.
	if (typeof meta.displayName === "string") {
		try {
			assertPersistentAgentDisplayNameAvailable(meta.displayName, { excludeAgentId: instance.agentId });
		} catch {
			const error = new Error(`An active room is already named ${collapseHumanWhitespace(meta.displayName)}. Rename that room first, then restore this one.`);
			(error as any).statusCode = 409;
			(error as any).code = "display_name_taken";
			throw error;
		}
	}
	const restoredAt = Date.now();
	// The agent.json write goes FIRST: mutating the schedule store and then
	// failing the restore would leave irreversible schedule changes on a room
	// that is still archived. The cost is a milliseconds-wide window in which
	// a scan tick could see stale anchors — chosen over the alternative,
	// where a failed restore silently rewires an archived room's schedules.
	const { archivedAt: _archivedAt, archivedBy: _archivedBy, archivedReason: _archivedReason, ...rest } = meta as AgentJson;
	const updatedMeta: AgentJson = { ...rest, status: "ready", updatedAt: restoredAt };
	writeFileAtomic(instance.agentJsonPath(), JSON.stringify(updatedMeta, null, 2) + "\n");
	const { enabledSchedules, missedOnceSchedules, scheduleNotice } = reanchorPersistentRoomSchedulesOnRestore(instance.agentId, restoredAt);
	return { agentId: instance.agentId, restoredAt, status: "ready", enabledSchedules, missedOnceSchedules, ...(scheduleNotice ? { scheduleNotice } : {}) };
}

const PURGE_TOMBSTONE_INFIX = ".purging-";

const PURGE_TOMBSTONE_PATTERN = /^[a-z0-9][a-z0-9_-]{0,119}\.purging-\d+$/;

/**
 * Remove tombstones a crashed or refused purge left behind. A tombstone is a
 * fully detached room dir renamed to <id>.purging-<ts>; its dot makes it
 * invisible to every id-validated reader, so the only cost of one surviving
 * is disk. Runs at boot next to the other maintenance sweeps.
 */
export function sweepPersistentAgentPurgeTombstones(): number {
	let swept = 0;
	try {
		if (!fs.existsSync(PERSISTENT_AGENTS_ROOT)) return 0;
		for (const entry of fs.readdirSync(PERSISTENT_AGENTS_ROOT, { withFileTypes: true })) {
			if (!entry.isDirectory() || !PURGE_TOMBSTONE_PATTERN.test(entry.name)) continue;
			try {
				fs.rmSync(path.join(PERSISTENT_AGENTS_ROOT, entry.name), { recursive: true, force: true });
				swept += 1;
			} catch {
				// still refusing — the next boot tries again
			}
		}
	} catch {
		// unscannable root — nothing to sweep
	}
	return swept;
}

export interface PersistentAgentPurgeOptions {
	confirmation: string;
	/** In-process signal from the web server: a detached turn is still cooking for this room. */
	detachedCooking?: boolean;
}

export interface PersistentAgentPurgeResult {
	agentId: PersistentAgentId;
	purgedAt: number;
	status: "purged";
	removedTaskFolders: number;
	removedBackgroundRuns: number;
	/**
	 * Targets the OS refused to remove after the room dir was already gone
	 * (locked file, permissions) — the purge continues past them and reports
	 * instead of pretending. Reasons are error codes, never paths.
	 */
	failed: { target: string; reason: string }[];
}

export type PersistentAgentPurgeBusyReason = "room_lock" | "turn_in_flight" | "detached_cooking" | "specialist_running";

function purgeBusyError(message: string, reason: PersistentAgentPurgeBusyReason): Error {
	const error = new Error(message);
	(error as any).statusCode = 409;
	(error as any).purgeBusyReason = reason;
	return error;
}

/**
 * Permanent delete. Removes the room directory and every per-room store that
 * lives outside it: the task folders its ledger names under artifacts/tasks/,
 * its room-lock file, its schedule store, its stream traces, and its
 * background-run records. Deletion targets are containment-checked against
 * their own store roots; workspace roots named in the room's workspace
 * policies are ordinary user folders elsewhere on disk and are never touched
 * (removing the room only removes the policy files that pointed at them),
 * and nothing under the agent-state side (~/.exxperts/agent) is involved.
 * Works on active rooms (after the busy guards) and archived rooms alike.
 */
export function purgePersistentAgent(agentIdRaw: string, options: PersistentAgentPurgeOptions): PersistentAgentPurgeResult {
	const instance = createPersistentAgentInstance(agentIdRaw);
	const expectedConfirmation = `DELETE ${instance.agentId} FOREVER`;
	if (String(options.confirmation ?? "") !== expectedConfirmation) {
		const error = new Error(`confirmation must exactly match: ${expectedConfirmation}`);
		(error as any).statusCode = 400;
		throw error;
	}
	if (!fs.existsSync(instance.rootDir)) {
		const error = new Error(`persistent agent not found: ${instance.agentId}`);
		(error as any).statusCode = 404;
		throw error;
	}
	const lock = activePersistentRoomLock(instance.agentId);
	if (lock) {
		// A web lock's owner may be the very session asking — the client leaves
		// the room before purging, so this wording has to cover both that race
		// and a genuinely different browser session honestly.
		const where = lock.surface === "web"
			? "is still open in a browser session; leave the room (or close the other session) and try again"
			: `is open or busy in another surface (${lock.surface ?? "unknown"}); close it there before deleting`;
		throw purgeBusyError(`persistent room ${where}: ${instance.agentId}`, "room_lock");
	}
	if (hasPersistentAgentTurnInFlight(instance.agentId)) {
		throw purgeBusyError(`persistent room has a response in flight; stop it or wait for it to finish before deleting: ${instance.agentId}`, "turn_in_flight");
	}
	if (options.detachedCooking) {
		throw purgeBusyError(`persistent room is still finishing a background answer; wait for it to land before deleting: ${instance.agentId}`, "detached_cooking");
	}
	// Specialist workers deliberately survive their connection (option 4), so
	// none of the guards above sees them — and a worker finishing AFTER the
	// purge would recreate the room dir as a ghost when it shelves its files.
	// A cooking task therefore refuses the purge outright; the abort below is
	// only the belt for anything that slips in between check and delete.
	if (runningSpecialistCount(instance.agentId) > 0) {
		throw purgeBusyError(`persistent room still has a task working in the background; stop it or wait for it to finish before deleting: ${instance.agentId}`, "specialist_running");
	}
	abortAllSpecialistTasks(instance.agentId);

	// The ledger is read BEFORE any deletion: it lives inside the room dir and
	// names the task folders outside it.
	const taskIds: string[] = [];
	try {
		for (const record of listTaskLedgerRecords(instance.agentId, { includeDeleted: true })) {
			const taskId = String(record.taskId ?? "").trim();
			if (/^[a-zA-Z0-9_-]{1,80}$/.test(taskId)) taskIds.push(taskId);
		}
	} catch {
		// an unreadable ledger leaves task folders to the store GC valve
	}

	// The guards above are advisory without a lock of our own: a scheduler tick
	// or a fresh connection could take the room between check and delete. The
	// purge therefore holds the room lock itself — scheduler surface with a
	// unique lockId, which no web takeover can steal — and a refused acquire
	// is the same honest room_lock refusal as an up-front held lock.
	const purgeLockOwner = { surface: "scheduler", lockId: `purge_${crypto.randomBytes(8).toString("hex")}`, label: "purge" };
	const acquiredLock = persistentRoomLock.tryAcquire(instance.agentId, purgeLockOwner);
	if (!acquiredLock.ok) {
		throw purgeBusyError(`persistent room was taken by another surface (${acquiredLock.heldBy?.surface ?? "unknown"}) just before deleting; try again: ${instance.agentId}`, "room_lock");
	}

	const failed: { target: string; reason: string }[] = [];
	const failureReason = (error: unknown): string => (error as NodeJS.ErrnoException)?.code ?? "unknown";

	// 1. The room directory FIRST — and via rename, because a recursive rmSync
	//    is not atomic: a refusal mid-walk would leave a half-eaten, unlisted
	//    shell. The same-volume rename detaches the WHOLE room in one step or
	//    fails with it fully intact; the tombstone name carries a dot no valid
	//    agent id can, so listings and scans never see it, and the boot sweep
	//    clears any tombstone a crash or a refusing OS leaves behind.
	//    Containment follows the scaffold-rollback rule; a violation or a
	//    refused rename is a hard error, never a silent skip.
	const relativePath = path.relative(PERSISTENT_AGENTS_ROOT, instance.rootDir);
	if (!relativePath || relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
		try { persistentRoomLock.release(instance.agentId, purgeLockOwner); } catch {}
		throw new Error("persistent agent root escaped the agents root; refusing to delete");
	}
	const tombstone = `${instance.rootDir}${PURGE_TOMBSTONE_INFIX}${Date.now()}`;
	try {
		fs.renameSync(instance.rootDir, tombstone);
	} catch (error) {
		try { persistentRoomLock.release(instance.agentId, purgeLockOwner); } catch {}
		throw new Error(`persistent room directory could not be detached for deletion (${failureReason(error)})`);
	}
	try {
		fs.rmSync(tombstone, { recursive: true, force: true });
	} catch (error) {
		// The room is already gone from every listing; what remains is invisible
		// disk usage the boot sweep reclaims — reported, not hidden.
		failed.push({ target: "room directory remainder", reason: failureReason(error) });
	}

	// 2. The room's task folders in the global artifact store.
	const tasksRoot = path.resolve(artifactRoot(), "tasks");
	let removedTaskFolders = 0;
	for (const taskId of taskIds) {
		const dir = path.resolve(tasksRoot, taskId);
		if (dir === tasksRoot || !dir.startsWith(tasksRoot + path.sep)) continue;
		if (!fs.existsSync(dir)) continue;
		try {
			fs.rmSync(dir, { recursive: true, force: true });
			removedTaskFolders++;
		} catch (error) {
			// One locked folder must not abort the rest — the store GC valve can
			// reclaim it later — but the response says so instead of pretending.
			failed.push({ target: `tasks/${taskId}`, reason: failureReason(error) });
		}
	}

	// 3. The per-room stores that live outside the room dir. Each path is built
	//    from the validated agent id and containment-checked against its store.
	const removeStoreDir = (storeRoot: string, label: string): void => {
		const resolvedRoot = path.resolve(storeRoot);
		const dir = path.resolve(resolvedRoot, instance.agentId);
		if (dir === resolvedRoot || !dir.startsWith(resolvedRoot + path.sep)) {
			// A path that escapes its store root cannot be deleted safely; that
			// is a refusal like any other, not a silent shrug.
			failed.push({ target: label, reason: "containment" });
			return;
		}
		try {
			fs.rmSync(dir, { recursive: true, force: true });
		} catch (error) {
			failed.push({ target: label, reason: failureReason(error) });
		}
	};
	// The purge's own lock comes off with the stores. release is owner-checked
	// in room-lock.cjs: a lock file some other owner wrote in the meantime is
	// never unlinked from here.
	try {
		persistentRoomLock.release(instance.agentId, purgeLockOwner);
	} catch (error) {
		failed.push({ target: "room lock", reason: failureReason(error) });
	}
	removeStoreDir(productAppStatePath("persistent-room-schedules"), "schedule store");
	removeStoreDir(productAppStatePath("stream-traces"), "stream traces");

	// 4. Background-run records scoped to this room. The store is global with the
	//    room only named inside each record, so this is a scan, not a dir drop.
	let removedBackgroundRuns = 0;
	try {
		const runsDir = backgroundRunsDirectoryPath();
		for (const entry of fs.readdirSync(runsDir, { withFileTypes: true })) {
			if (!entry.isDirectory() || !isValidBackgroundRunId(entry.name)) continue;
			try {
				const record = JSON.parse(fs.readFileSync(path.join(runsDir, entry.name, "run.json"), "utf-8"));
				const scope = record?.scope;
				const scoped =
					(scope?.kind === "persistent-room" && scope.roomId === instance.agentId) ||
					(scope?.kind === "room-consult" && (scope.sourceRoomId === instance.agentId || scope.targetRoomId === instance.agentId));
				if (!scoped) continue;
				try {
					fs.rmSync(path.join(runsDir, entry.name), { recursive: true, force: true });
					removedBackgroundRuns++;
				} catch (error) {
					failed.push({ target: `background run ${entry.name}`, reason: failureReason(error) });
				}
			} catch {
				// an unreadable record stays; it names nothing we can attribute to this room
			}
		}
	} catch {
		// no background-run store yet — nothing scoped to remove
	}

	// Drop the room's in-memory turn bookkeeping so a purged id cannot pin state.
	const turnKeyPrefix = `${instance.agentId}\u0000`;
	for (const key of [...persistentAgentActiveTurns.keys()]) {
		if (key.startsWith(turnKeyPrefix)) persistentAgentActiveTurns.delete(key);
	}

	return { agentId: instance.agentId, purgedAt: Date.now(), status: "purged", removedTaskFolders, removedBackgroundRuns, failed };
}
