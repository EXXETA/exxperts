import fs from "node:fs";
import path from "node:path";
import { DEFAULT_PERSISTENT_ROOM_AGENTS_ROOT, persistentAgentRootPath } from "./persistent-room-workspace-policy.js";
import { listTaskLedgerRecords, rewriteTaskLedgerRecord, type TaskLedgerArtifact, type TaskLedgerRecord } from "./persistent-room-task-ledger.js";
import {
	PERSISTENT_ROOM_SHELF_RELATIVE_PREFIX,
	allocateShelfFilename,
	isShelfRelativePath,
	persistentRoomShelfDirPath,
	shelfRelativePath,
} from "./persistent-room-shelf.js";

/**
 * One-time shelf migration (files core slice, design doc "Migration"):
 * task-store artifacts move in with their room.
 *
 * Boot pass, before the server accepts traffic. Per room, idempotent:
 * - skip when the room's migration marker exists (crash-and-restart safe);
 * - per ledger record, journal the intended shelf names, rename each listed
 *   artifact from the global store (~/.exxperts/app/artifacts/tasks/<taskId>/…)
 *   onto the room's shelf under the "report (2).html" collision rule, rewrite
 *   the record's paths, then clear the journal — so a crash ANYWHERE in that
 *   sequence heals on re-run (the journal names where a moved file went, and
 *   each record is independent);
 * - records without an artifacts list (orphaned/interrupted runs) migrate by
 *   scanning their task folder, so no output is left behind;
 * - exports[] paths follow their artifact so ingest-on-iterate keeps matching.
 *
 * Afterwards the sweep splits what remains in the store by whether a readable
 * ledger row anywhere names it. Referenced folders can only hold derivative
 * leftovers (staged inputs/, .thumbs previews) — their outputs were moved
 * above — so they are deleted, logged in a plain-text file next to the store.
 * UNreferenced folders are NOT proof of a deleted room: a pre-ledger task
 * (rows may simply never have existed — the ledger API tolerates that) and a
 * task whose row JSON no longer parses (parseTaskLedgerRecord returns null,
 * silently) look exactly the same, and both belong to LIVE rooms. A folder
 * the migration cannot positively classify is never deleted: it is moved
 * aside intact into tasks-unclassified/ next to the store and logged, so
 * nothing a user might still want is ever destroyed on a guess.
 */

export const SHELF_MIGRATION_MARKER_FILENAME = "shelf-migration.json";
export const SHELF_MIGRATION_LOG_FILENAME = "migration-removed.log";
export const SHELF_MIGRATION_UNCLASSIFIED_DIR_NAME = "tasks-unclassified";
const TASKS_STORE_DIR_NAME = "tasks";
const ROOM_ID_PATTERN = /^[a-zA-Z0-9_-]{1,160}$/;
const TASKS_PREFIX = `${TASKS_STORE_DIR_NAME}/`;

export interface ShelfMigrationOptions {
	persistentAgentsRoot?: string;
	/** The artifact store root (~/.exxperts/app/artifacts). Injectable for smokes. */
	artifactsRoot: string;
	log?: (message: string) => void;
}

export interface ShelfMigrationSummary {
	roomsMigrated: number;
	roomsSkipped: number;
	filesMoved: number;
	recordsRewritten: number;
	orphanEntriesDeleted: number;
	/** Store entries no readable row anywhere names — moved into tasks-unclassified/, never deleted. */
	entriesMovedAside: number;
	errors: string[];
}

function migrationMarkerPath(agentsRoot: string, roomId: string): string {
	return path.join(persistentAgentRootPath(roomId, agentsRoot), "runtime", SHELF_MIGRATION_MARKER_FILENAME);
}

/** `tasks/<taskId>/<rest>` → absolute store path, or null for anything that is not a safe store-relative task path. */
function taskStoreAbsolutePath(artifactsRoot: string, relativePath: string): string | null {
	if (!relativePath.startsWith(TASKS_PREFIX)) return null;
	const segments = relativePath.split("/");
	if (segments.length < 3) return null;
	if (segments.some((segment) => segment === "" || segment === "." || segment === ".." || segment.startsWith(".") || segment.includes("\\") || segment.includes("\0"))) return null;
	return path.join(artifactsRoot, ...segments);
}

function isTaskInputPath(relativePath: string): boolean {
	const segments = relativePath.split("/");
	return segments.length >= 4 && segments[2] === "inputs";
}

/** Scan a task folder for outputs the record never listed (interrupted runs) — same exclusions as the specialist artifact listing (dotfiles, inputs/). */
function scanTaskFolderArtifacts(artifactsRoot: string, taskId: string): TaskLedgerArtifact[] {
	const taskDir = path.join(artifactsRoot, TASKS_STORE_DIR_NAME, taskId);
	const artifacts: TaskLedgerArtifact[] = [];
	const walk = (dir: string, relPrefix: string) => {
		let entries: fs.Dirent[];
		try {
			entries = fs.readdirSync(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
			if (entry.name.startsWith(".")) continue;
			// Only the inputs DIRECTORY is the exports staging area; a regular
			// file that happens to be named "inputs" is a survivor like any other.
			if (relPrefix === "" && entry.name === "inputs" && entry.isDirectory()) continue;
			const rel = relPrefix ? `${relPrefix}/${entry.name}` : entry.name;
			const file = path.join(dir, entry.name);
			let lstat: fs.Stats;
			try {
				lstat = fs.lstatSync(file);
			} catch {
				continue;
			}
			if (lstat.isDirectory()) walk(file, rel);
			else if (lstat.isFile()) artifacts.push({ relativePath: `${TASKS_STORE_DIR_NAME}/${taskId}/${rel}`, bytes: lstat.size, extension: path.extname(entry.name).toLowerCase() });
		}
	};
	walk(taskDir, "");
	return artifacts;
}

interface RecordMigrationResult {
	artifacts: TaskLedgerArtifact[];
	moved: number;
	changed: boolean;
	movedByOldPath: Map<string, string>;
}

interface RecordMigrationJournal {
	schemaVersion: 1;
	taskId: string;
	/** Old store-relative path → the shelf filename it moves to. */
	plannedNames: Record<string, string>;
}

function journalPath(agentsRoot: string, roomId: string, taskId: string): string {
	return path.join(persistentAgentRootPath(roomId, agentsRoot), "runtime", "shelf-migration-journal", `${taskId}.json`);
}

function readJournal(file: string): RecordMigrationJournal | null {
	try {
		const raw = JSON.parse(fs.readFileSync(file, "utf-8"));
		if (!raw || raw.schemaVersion !== 1 || typeof raw.plannedNames !== "object") return null;
		return raw as RecordMigrationJournal;
	} catch {
		return null;
	}
}

/**
 * Per-record migration, journaled so it truly heals (review follow-up on the
 * !348 crash-window): the intended shelf name of every file is written to a
 * journal BEFORE any rename. A crash between rename and ledger rewrite then
 * leaves the journal behind, and the re-run finishes the rewrite from it —
 * source gone + journaled shelf name present = the move happened, record the
 * shelf path. The journal is deleted only after the ledger rewrite landed.
 */
function migrateRecordArtifacts(record: TaskLedgerRecord, roomId: string, options: ShelfMigrationOptions, storage: { persistentAgentsRoot: string }): RecordMigrationResult {
	const listed = record.artifacts ?? [];
	const source = listed.length > 0 ? listed : scanTaskFolderArtifacts(options.artifactsRoot, record.taskId);
	const movable = source.filter((artifact) => !isTaskInputPath(artifact.relativePath));
	const journalFile = journalPath(storage.persistentAgentsRoot, roomId, record.taskId);
	const previous = readJournal(journalFile);
	const shelfDir = persistentRoomShelfDirPath(roomId, storage);

	// Plan every target name first (honoring a prior crash's journal), then
	// persist the plan, then move. Planned names count as taken among
	// themselves so two same-named artifacts in one record cannot collide.
	const plannedNames: Record<string, string> = {};
	const claimed = new Set<string>();
	for (const artifact of movable) {
		if (isShelfRelativePath(artifact.relativePath)) continue;
		const journaled = previous?.plannedNames[artifact.relativePath];
		const absolute = taskStoreAbsolutePath(options.artifactsRoot, artifact.relativePath);
		const sourceExists = Boolean(absolute && fs.existsSync(absolute));
		if (journaled && !sourceExists && fs.existsSync(path.join(shelfDir, journaled))) {
			// The crashed run already moved this file; finish with its name.
			plannedNames[artifact.relativePath] = journaled;
			claimed.add(journaled);
			continue;
		}
		if (!sourceExists) continue; // gone pre-migration; keep the honest record
		const name = journaled && !fs.existsSync(path.join(shelfDir, journaled)) && !claimed.has(journaled)
			? journaled
			: allocateShelfFilename(path.posix.basename(artifact.relativePath), (candidate) => claimed.has(candidate) || fs.existsSync(path.join(shelfDir, candidate)));
		plannedNames[artifact.relativePath] = name;
		claimed.add(name);
	}
	if (Object.keys(plannedNames).length > 0) {
		fs.mkdirSync(path.dirname(journalFile), { recursive: true, mode: 0o700 });
		const journal: RecordMigrationJournal = { schemaVersion: 1, taskId: record.taskId, plannedNames };
		fs.writeFileSync(journalFile, `${JSON.stringify(journal, null, 2)}\n`, { mode: 0o600 });
	}

	const movedByOldPath = new Map<string, string>();
	let moved = 0;
	let changed = listed.length === 0 && source.length > 0;
	const artifacts = movable.map((artifact) => {
		if (isShelfRelativePath(artifact.relativePath)) return artifact; // already migrated
		const name = plannedNames[artifact.relativePath];
		if (!name) return artifact; // gone pre-migration; keep the honest record
		const absolute = taskStoreAbsolutePath(options.artifactsRoot, artifact.relativePath);
		if (absolute && fs.existsSync(absolute)) {
			fs.mkdirSync(shelfDir, { recursive: true, mode: 0o700 });
			const destination = path.join(shelfDir, name);
			try {
				fs.renameSync(absolute, destination);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error;
				fs.copyFileSync(absolute, destination, fs.constants.COPYFILE_EXCL);
				fs.rmSync(absolute, { force: true });
			}
			moved += 1;
		}
		// Source gone with a journaled name = the crashed run moved it; either
		// way the record now points at the shelf.
		const newPath = shelfRelativePath(name);
		movedByOldPath.set(artifact.relativePath, newPath);
		changed = true;
		return { ...artifact, relativePath: newPath };
	});
	return { artifacts, moved, changed, movedByOldPath };
}

/** Delete a record's journal — called only AFTER its ledger rewrite landed. */
function clearRecordJournal(agentsRoot: string, roomId: string, taskId: string): void {
	try {
		fs.rmSync(journalPath(agentsRoot, roomId, taskId), { force: true });
	} catch {
		// A surviving journal is harmless: the next run replays it into a no-op.
	}
}

function appendRemovalLog(artifactsRoot: string, lines: string[]): void {
	if (lines.length === 0) return;
	try {
		fs.mkdirSync(artifactsRoot, { recursive: true });
		fs.appendFileSync(path.join(artifactsRoot, SHELF_MIGRATION_LOG_FILENAME), `${lines.join("\n")}\n`, "utf-8");
	} catch {
		// The log is best-effort; a failed append never blocks the migration.
	}
}

function listStoreTaskEntries(artifactsRoot: string): string[] {
	try {
		return fs.readdirSync(path.join(artifactsRoot, TASKS_STORE_DIR_NAME));
	} catch {
		return [];
	}
}

function collectFilePaths(root: string, prefix: string): string[] {
	const files: string[] = [];
	const walk = (dir: string, rel: string) => {
		let entries: fs.Dirent[];
		try {
			entries = fs.readdirSync(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			const entryRel = rel ? `${rel}/${entry.name}` : entry.name;
			if (entry.isDirectory()) walk(path.join(dir, entry.name), entryRel);
			else files.push(`${prefix}/${entryRel}`);
		}
	};
	walk(root, "");
	return files;
}

export function migrateTaskArtifactsToShelves(options: ShelfMigrationOptions): ShelfMigrationSummary {
	const log = options.log ?? (() => {});
	const agentsRoot = options.persistentAgentsRoot ?? DEFAULT_PERSISTENT_ROOM_AGENTS_ROOT;
	const storage = { persistentAgentsRoot: agentsRoot };
	const summary: ShelfMigrationSummary = { roomsMigrated: 0, roomsSkipped: 0, filesMoved: 0, recordsRewritten: 0, orphanEntriesDeleted: 0, entriesMovedAside: 0, errors: [] };

	let roomIds: string[] = [];
	try {
		roomIds = fs.readdirSync(agentsRoot, { withFileTypes: true })
			.filter((entry) => entry.isDirectory())
			.map((entry) => entry.name)
			.filter((name) => ROOM_ID_PATTERN.test(name));
	} catch {
		// No rooms root yet — nothing to migrate; the store sweep below still runs.
	}

	const migratedTaskIds = new Set<string>();
	// Task folders a LIVE record still points into via a tasks/ path. The sweep
	// must never touch these: they exist only when something kept a store path
	// (a marker-skipped room's unabsorbed outputs, a failed rename) and deleting
	// them would destroy referenced files instead of leftovers.
	const storeReferencedTaskIds = new Set<string>();
	let anyRoomFailed = false;

	for (const roomId of roomIds) {
		const markerPath = migrationMarkerPath(agentsRoot, roomId);
		// Records are read even for migrated rooms: their task ids must stay
		// protected from the orphan sweep on every boot.
		let records: TaskLedgerRecord[];
		try {
			records = listTaskLedgerRecords(roomId, { persistentAgentsRoot: agentsRoot, includeDeleted: true });
		} catch (error) {
			anyRoomFailed = true;
			summary.errors.push(`room ${roomId}: ledger unreadable (${(error as Error).message})`);
			continue;
		}
		for (const record of records) migratedTaskIds.add(record.taskId);
		if (fs.existsSync(markerPath)) {
			summary.roomsSkipped += 1;
			continue;
		}
		let roomMoved = 0;
		let roomFailed = false;
		// The ledger lists newest-first; migrate OLDEST-first so the earliest run
		// that produced a name keeps the plain name and later runs take " (2)" —
		// the collision rule telling the true creation order.
		for (const record of [...records].reverse()) {
			if (record.deletedAt) continue; // files already deleted; the row is a measurement record
			try {
				const result = migrateRecordArtifacts(record, roomId, options, storage);
				if (!result.changed) {
					// Nothing to rewrite: any surviving journal is fully replayed — drop it.
					clearRecordJournal(agentsRoot, roomId, record.taskId);
					continue;
				}
				rewriteTaskLedgerRecord(roomId, record.taskId, (current) => ({
					...current,
					...(result.artifacts.length > 0 ? { artifacts: result.artifacts } : {}),
					...(current.exports && current.exports.length > 0
						? { exports: current.exports.map((entry) => ({ ...entry, relativePath: result.movedByOldPath.get(entry.relativePath) ?? entry.relativePath })) }
						: {}),
				}), { persistentAgentsRoot: agentsRoot });
				clearRecordJournal(agentsRoot, roomId, record.taskId);
				summary.recordsRewritten += 1;
				roomMoved += result.moved;
			} catch (error) {
				roomFailed = true;
				anyRoomFailed = true;
				summary.errors.push(`room ${roomId} task ${record.taskId}: ${(error as Error).message}`);
			}
		}
		if (roomFailed) continue; // no marker: the failed records retry next boot
		try {
			fs.mkdirSync(path.dirname(markerPath), { recursive: true, mode: 0o700 });
			fs.writeFileSync(markerPath, `${JSON.stringify({ schemaVersion: 1, migratedAt: new Date().toISOString(), filesMoved: roomMoved }, null, 2)}\n`, { mode: 0o600 });
		} catch (error) {
			anyRoomFailed = true;
			summary.errors.push(`room ${roomId}: marker write failed (${(error as Error).message})`);
			continue;
		}
		summary.roomsMigrated += 1;
		summary.filesMoved += roomMoved;
		if (roomMoved > 0) log(`shelf migration: ${roomId} took ${roomMoved} file(s) onto its shelf`);
	}

	// The orphan sweep runs only when every room migrated cleanly — a failed
	// room's store files must survive for the retry.
	if (anyRoomFailed) {
		summary.errors.push("orphan sweep skipped: at least one room did not migrate cleanly");
		return summary;
	}
	// Second pass over the FINAL record state (post-rewrite): any live row still
	// pointing a tasks/ path protects that task folder from the sweep.
	for (const roomId of roomIds) {
		let finalRecords: TaskLedgerRecord[];
		try {
			finalRecords = listTaskLedgerRecords(roomId, { persistentAgentsRoot: agentsRoot });
		} catch {
			continue;
		}
		for (const record of finalRecords) {
			// Both path carriers count: artifacts AND exports (an export can
			// outlive its artifact's rewrite). Protect the folder the path
			// itself names, not just the row's own task id.
			for (const relativePath of [
				...(record.artifacts ?? []).map((artifact) => artifact.relativePath),
				...(record.exports ?? []).map((entry) => entry.relativePath),
			]) {
				if (!relativePath.startsWith(TASKS_PREFIX)) continue;
				storeReferencedTaskIds.add(record.taskId);
				const pathTaskId = relativePath.split("/")[1];
				if (pathTaskId) storeReferencedTaskIds.add(pathTaskId);
			}
		}
	}
	const removalLines: string[] = [];
	const stamp = new Date().toISOString();
	// Move one store entry aside intact (never delete) — with the same EXDEV
	// fallback the record migration has, so a cross-mount store cannot leave
	// the entry stuck in tasks/ re-erroring every boot.
	const moveEntryAside = (entryName: string, entryPath: string, files: string[], reason: string): void => {
		const holdingDir = path.join(options.artifactsRoot, SHELF_MIGRATION_UNCLASSIFIED_DIR_NAME);
		try {
			fs.mkdirSync(holdingDir, { recursive: true, mode: 0o700 });
			let destination = path.join(holdingDir, entryName);
			for (let suffix = 2; fs.existsSync(destination); suffix += 1) destination = path.join(holdingDir, `${entryName} (${suffix})`);
			try {
				fs.renameSync(entryPath, destination);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error;
				fs.cpSync(entryPath, destination, { recursive: true, errorOnExist: true });
				fs.rmSync(entryPath, { recursive: true, force: true });
			}
			summary.entriesMovedAside += 1;
			removalLines.push(`${stamp} moved aside (NOT deleted) to ${SHELF_MIGRATION_UNCLASSIFIED_DIR_NAME}/${path.basename(destination)} — ${reason}:`);
			for (const file of files) removalLines.push(`${stamp}   ${file}`);
		} catch (error) {
			summary.errors.push(`orphan sweep: could not move aside ${entryName} (${(error as Error).message})`);
		}
	};
	for (const entryName of listStoreTaskEntries(options.artifactsRoot)) {
		const entryPath = path.join(options.artifactsRoot, TASKS_STORE_DIR_NAME, entryName);
		let lstat: fs.Stats;
		try {
			lstat = fs.lstatSync(entryPath);
		} catch {
			continue;
		}
		if (storeReferencedTaskIds.has(entryName)) {
			log(`shelf migration: leaving ${TASKS_STORE_DIR_NAME}/${entryName} in place (a room record still references it)`);
			continue;
		}
		const referenced = migratedTaskIds.has(entryName);
		const files = lstat.isDirectory() ? collectFilePaths(entryPath, `${TASKS_STORE_DIR_NAME}/${entryName}`) : [`${TASKS_STORE_DIR_NAME}/${entryName}`];
		if (!referenced) {
			// Not one readable row anywhere names this task — and that is NOT
			// proof of a deleted room. A pre-ledger task and a task whose row
			// JSON no longer parses look identical from here, and both belong to
			// LIVE rooms. Unclassifiable folders move aside intact, never delete.
			moveEntryAside(entryName, entryPath, files, "no readable ledger row in any room names this task (a deleted room's leftover, a pre-ledger task, and a corrupt row look identical)");
			continue;
		}
		// A referenced folder SHOULD hold only derivative leftovers here — the
		// migration moved every listed output above. But an artifacts list can
		// be incomplete (the unlisted-output scan runs only for EMPTY lists), so
		// re-scan before deleting: any real file still inside — non-dotfile,
		// outside inputs/ — is work the migration did not positively move, and
		// deleting it on an assumption of completeness is exactly the guess this
		// sweep must never make. Such folders move aside intact instead.
		const survivors = lstat.isDirectory() ? scanTaskFolderArtifacts(options.artifactsRoot, entryName) : [];
		if (survivors.length > 0) {
			moveEntryAside(entryName, entryPath, files, `a row references this task but ${survivors.length} file(s) inside were never migrated (an incomplete artifacts list)`);
			continue;
		}
		try {
			fs.rmSync(entryPath, { recursive: true, force: true });
		} catch (error) {
			summary.errors.push(`orphan sweep: could not remove ${entryName} (${(error as Error).message})`);
			continue;
		}
		summary.orphanEntriesDeleted += 1;
		removalLines.push(`${stamp} removed leftovers of a migrated task (staged inputs / previews):`);
		for (const file of files) removalLines.push(`${stamp}   ${file}`);
	}
	appendRemovalLog(options.artifactsRoot, removalLines);
	if (summary.orphanEntriesDeleted > 0) log(`shelf migration: removed ${summary.orphanEntriesDeleted} store entr${summary.orphanEntriesDeleted === 1 ? "y" : "ies"} (logged in ${SHELF_MIGRATION_LOG_FILENAME})`);
	if (summary.entriesMovedAside > 0) log(`shelf migration: moved ${summary.entriesMovedAside} unclassifiable store entr${summary.entriesMovedAside === 1 ? "y" : "ies"} aside into ${SHELF_MIGRATION_UNCLASSIFIED_DIR_NAME}/ (logged in ${SHELF_MIGRATION_LOG_FILENAME}; nothing deleted)`);
	return summary;
}
