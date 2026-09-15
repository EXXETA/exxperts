// The memory entries STORE (memory v2, stream D2) — the layer between the pure
// entry model (memory-entries.ts) and the room's files on disk.
//
// Everything a caller needs to read or change a room's memory entry by entry is
// here, and every write obeys the same three rules the maintenance writes obey:
//
//   1. The previous file is archived first, byte for byte, as
//      `L1b/archive/<stamp>-before-<id>.md` — the convention writeApprovedAbsorb
//      and writeApprovedCheckpoint already follow, so one room has one snapshot
//      shape whatever wrote it.
//   2. An immutable event record lands in `events/memory-edit/<id>.json`, so a
//      user edit is provable in the room's history exactly like a Memorize.
//   3. A write refuses while the room has a turn in flight. Memory is the one
//      thing a running turn is reading; changing it underneath is how a room
//      answers from a memory nobody has any more.
//
// Reads are reads. The ONE exception is the migration of a file that has never
// carried entry ids: the first load of such a file performs a normal write
// (snapshot, event record, storage render) and every load after it writes
// nothing. That is deliberate — migration is a change to the room's memory and
// is recorded as one — and it is pinned by a smoke, because a read that writes
// on every call would rewrite a room's memory on every page load.

import fs from "node:fs";
import path from "node:path";
import {
	appendToArchive,
	archiveIndex,
	cloneDocument,
	isMigratedMemoryDocument,
	MEMORY_ARCHIVE_ENTRIES_FILE,
	migrateMemoryDocument,
	parseArchive,
	parseMemoryDocument,
	removeFromArchive,
	renderMemoryContext,
	renderMemoryDocument,
	reviewTargetTokens,
	type ArchivedEntry,
	type ArchiveIndex,
	type ArchiveReason,
	type MemoryDocument,
	type MemoryEntry,
	type MemorySection,
} from "./memory-entries.js";
import { createPersistentAgentInstance, getPersistentAgentStatus, reviewTargetEstimatedTokensFromL1b, updateChronosForMemoryEdit, type PersistentAgentInstance } from "./persistent-agents.js";
import { MEMORY_BUDGET_DEFAULT_TOKENS, MEMORY_BUDGET_MAX_TOKENS, MEMORY_BUDGET_MIN_TOKENS, readPersistentRoomMaintenanceSettings, writePersistentRoomMaintenanceSettings } from "./persistent-room-maintenance-settings.js";

export { MEMORY_ARCHIVE_ENTRIES_FILE };

/** What every entries response discloses about the room's budget. */
export interface BudgetState {
	reviewTargetTokens: number;
	budgetTokens: number;
	overBudget: boolean;
}

/**
 * What a write records about itself: the event record's kind and the history
 * row's. "absorb" is the Memorize v2 run and "review" the Review v2 run: both
 * go through this one write like every other change to a room's memory, but
 * record themselves under `events/absorb` and `events/review` (see
 * `writeEventRecord` below), because one write is one row in the room's history
 * and each of the two already has a row shape of its own.
 *
 * "undo" is the one write that puts an earlier file back byte for byte (see
 * `restoreMemoryFile`): it records itself here like every other change, because
 * putting a memory back is a change to it, not the absence of one.
 */
export type MemoryEditKind = "migrate" | "user_edit" | "absorb" | "review" | "undo";

/**
 * The user-facing operation a `user_edit` record carries, for the history row.
 * "archive_delete" is the one operation that never touches the notes file: it
 * takes a row out of the archive for good (see `deleteArchivedEntry`).
 */
export type MemoryEditOperation = "add" | "edit" | "pin" | "unpin" | "move" | "status" | "delete" | "restore" | "archive_delete";

/** What an archive delete keeps of the note it removed, so the history can say what went. */
export interface MemoryArchiveDeleteEdit {
	op: "archive_delete";
	id: string;
	topic: string;
	section: MemorySection;
	/** The note's first 200 characters. */
	text?: string;
}

/** One entry on its way out of the core, with the address a restore needs. */
export interface MemoryArchiveAppend {
	entry: MemoryEntry;
	why: ArchiveReason;
	topic: string;
	section: MemorySection;
	/** YYYY-MM-DD; defaults to the write's own day. */
	archived?: string;
}

export interface MemoryWriteOptions {
	/** The event record's kind: what happened to the memory. */
	why: MemoryEditKind;
	/** The `<event>` half of the snapshot name and the event id's prefix ("migrate", "edit", …). */
	snapshotLabel: string;
	/** Entries leaving the core in this same write. */
	archiveAppend?: MemoryArchiveAppend[];
	/** Entries coming back out of the archive in this same write (a restore). */
	archiveRemoveIds?: string[];
	/** The entry this write was about, and what was done to it — the history row's detail. */
	entryId?: string;
	operation?: MemoryEditOperation;
	/** How many entries the migration gave an id to. */
	entriesAssigned?: number;
	/**
	 * How the write stamps the room's system-managed Chronos. Defaults to the
	 * memory-edit stamp; Memorize passes its consolidation stamp, so one write
	 * dates itself in the field its own workflow owns.
	 */
	stampChronos?: (l1b: string, now: Date, writeId: string) => string;
	/**
	 * Writes the event record instead of the default `events/memory-edit` one,
	 * and says where it landed. The write still owns the snapshot, the archive,
	 * the core file and the budget numbers — only the record moves.
	 */
	writeEventRecord?: (input: {
		agentId: string;
		writeId: string;
		now: Date;
		currentL1b: string;
		writtenL1b: string;
		archivedL1bPath: string;
		updatedL1bPath: string;
		budgetBefore: BudgetState;
		budgetAfter: BudgetState;
	}) => { eventRecordPath: string; eventRelPath: string };
	now?: Date;
}

export interface MemoryEditEventRecord {
	schemaVersion: 1;
	operation: "memory_edit";
	kind: MemoryEditKind;
	agentId: string;
	memoryEditId: string;
	/** ISO. Named `approvedAt` because every event reader in the product sorts on that field. */
	approvedAt: string;
	entryId?: string;
	entryOperation?: MemoryEditOperation;
	entriesAssigned?: number;
	archived?: Array<{ id: string; why: ArchiveReason; topic: string; section: MemorySection }>;
	restored?: string[];
	/** entryOperation "archive_delete": the archived note that was deleted for good. */
	edit?: MemoryArchiveDeleteEdit;
	/** kind "undo": the save this write put back, named so the history can show that save as undone. */
	undoneSaveId?: string;
	undoneKind?: "memorize" | "review";
	/** The undone save's own `approvedAt`, so the row can say which save was taken back without reading its record. */
	undoneAt?: string;
	/** kind "undo": the undone save had raised the room's limit, and this undo put it back to this value. */
	limitLoweredTo?: number;
	paths: {
		/** Absent on an archive delete: the notes file did not change, so there is nothing to snapshot. */
		archivedL1bRelPath?: string;
		updatedL1bRelPath: string;
		eventRelPath: string;
	};
	budget: {
		budgetTokens: number;
		reviewTargetTokensBefore: number;
		reviewTargetTokensAfter: number;
		overBudgetBefore: boolean;
		overBudgetAfter: boolean;
	};
}

export interface MemoryWriteResult {
	agentId: string;
	memoryEditId: string;
	archivedL1bPath: string;
	updatedL1bPath: string;
	eventRecordPath: string;
	eventRelPath: string;
	budget: BudgetState;
	archived: ArchivedEntry[];
	restored: ArchivedEntry[];
}

export interface MemoryDocumentLoad {
	doc: MemoryDocument;
	archive: ArchivedEntry[];
	budget: BudgetState;
	/** True only on the one load that migrated a v1 file AND wrote it. */
	migrated: boolean;
	/** The migration's write, when this load performed one. */
	migration?: MemoryWriteResult;
	/**
	 * Set when the load migrated the parsed document IN MEMORY and wrote nothing:
	 * the caller holds a document with ids the file does not have yet, and owes
	 * the user that write (or no write at all).
	 */
	pendingMigration?: { entriesAssigned: number };
}

export interface LoadMemoryDocumentOptions {
	/**
	 * What a load may do to a file that has never carried entry ids:
	 *  - `true` (the default): migrate it and WRITE the migration, snapshot and
	 *    event record included — what the entries pane's own reads do, because a
	 *    person opening the pane is asking for the ids;
	 *  - `false`: leave it alone and hand back the document as it parses — for
	 *    readers that must never write (diagnostics, the status block);
	 *  - `"in-memory"`: migrate the parsed document and write NOTHING, reporting
	 *    it as `pendingMigration`. This is what a memory update's proposal and a
	 *    read-only pane use: the cards carry ids, the file on disk is untouched,
	 *    and the write happens once, at approval, or never.
	 */
	migrate?: boolean | "in-memory";
	now?: Date;
}

// --- product sentences -------------------------------------------------------

/**
 * The room is mid-turn. One sentence, no jargon: the model is reading this
 * memory right now, which is exactly why the edit waits.
 */
export const MEMORY_ROOM_BUSY_SENTENCE = "This room is in the middle of a turn. Wait for it to finish, then change the memory.";
export const MEMORY_ENTRY_UNKNOWN_SENTENCE = "That entry is not in this room's memory any more.";
export const MEMORY_ARCHIVED_ENTRY_UNKNOWN_SENTENCE = "That entry is not in this room's archive any more.";

function productError(message: string, code: string, statusCode = 400): Error {
	const error = new Error(message);
	(error as any).statusCode = statusCode;
	(error as any).code = code;
	return error;
}

export function memoryRoomBusyError(): Error {
	return productError(MEMORY_ROOM_BUSY_SENTENCE, "memory_room_busy");
}

export function memoryEntryUnknownError(archived = false): Error {
	return productError(archived ? MEMORY_ARCHIVED_ENTRY_UNKNOWN_SENTENCE : MEMORY_ENTRY_UNKNOWN_SENTENCE, "memory_entry_unknown");
}

// --- disk primitives (the house pattern: one small atomic writer per module) --

function ensureDir(dir: string): void {
	fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
}

function writeFileAtomic(file: string, content: string): void {
	const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
	fs.writeFileSync(tmp, content, { mode: 0o600 });
	fs.renameSync(tmp, file);
}

function slugTimestamp(date: Date): string {
	return date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

function shortRandomId(): string {
	return Math.random().toString(36).slice(2, 8);
}

function isoDay(date: Date): string {
	return date.toISOString().slice(0, 10);
}

interface RoomFiles {
	instance: PersistentAgentInstance;
	agentId: string;
	l1bPath: string;
	archiveDir: string;
	archiveEntriesPath: string;
}

function roomFiles(agentIdRaw: string): RoomFiles {
	const instance = createPersistentAgentInstance(agentIdRaw);
	const meta = instance.readAgentJson();
	if (!meta) throw productError("This room's memory cannot be opened: its record is missing or unreadable.", "memory_room_unreadable");
	const archiveDir = instance.l1bArchiveDir(meta);
	return {
		instance,
		agentId: instance.agentId,
		l1bPath: instance.l1bCurrentPath(meta),
		archiveDir,
		archiveEntriesPath: path.join(archiveDir, MEMORY_ARCHIVE_ENTRIES_FILE),
	};
}

function readL1bOrThrow(files: RoomFiles): string {
	if (!fs.existsSync(files.l1bPath)) throw productError("This room has no memory file yet.", "memory_missing");
	return fs.readFileSync(files.l1bPath, "utf-8");
}

function readArchiveText(files: RoomFiles): string {
	try {
		return fs.readFileSync(files.archiveEntriesPath, "utf-8");
	} catch {
		return ""; // no archive yet — the common case
	}
}

// --- guards ------------------------------------------------------------------

/**
 * The one guard every write passes. It reads the SAME activeThread.inFlight the
 * background-run classifier reads (running or cancelling), and deliberately not
 * the room lock: a person editing entries in Room settings has the room open,
 * so a lock check would refuse every edit the pane exists to make.
 */
export function memoryRoomBusy(agentIdRaw: string): boolean {
	try {
		return getPersistentAgentStatus(agentIdRaw).activeThread?.inFlight === true;
	} catch {
		return false; // an unreadable room fails on its own file reads, with its own sentence
	}
}

export function assertMemoryWriteAllowed(agentIdRaw: string): void {
	if (memoryRoomBusy(agentIdRaw)) throw memoryRoomBusyError();
}

// --- budget ------------------------------------------------------------------

/**
 * The room's budget line: what Deep Memory + Active Items cost the room in its
 * CONTEXT render, against the budget its owner set. The shared numerator
 * (reviewTargetEstimatedTokensFromL1b in persistent-agents.ts) measures the
 * same render, so the status block, the settings meter, the room card, the
 * approval card and this module's enforcement pass all speak one number.
 */
export function memoryBudgetState(agentIdRaw: string, doc: MemoryDocument): BudgetState {
	settleMemoryBudget(agentIdRaw);
	const budgetTokens = readPersistentRoomMaintenanceSettings(agentIdRaw).memoryBudgetTokens;
	const tokens = reviewTargetTokens(doc);
	return { reviewTargetTokens: tokens, budgetTokens, overBudget: tokens > budgetTokens };
}

/** What settling the budget did: `settled` is true only when the budget moved; `from` and `to` are the budget before and after. */
export interface MemoryBudgetSettlement {
	settled: boolean;
	from: number;
	to: number;
}

/**
 * The budget starts where the room is. A room that comes to the entry model
 * from 0.11.2 with the default budget would meet the budget rule on its first
 * Memorize and watch two thirds of its notes go to the archive on day one; so
 * the first time its budget is read against its own file, the budget is set
 * to the room's size plus a quarter (at least the default, at most the
 * ceiling), and the person tightens it later with the slider. Every other
 * room keeps what it has: one already on the entry model is never resized,
 * and a budget the person set in 0.11.2 is theirs.
 *
 * The one place that decides the rule. Every reader of a room's budget calls
 * it first; once `memoryBudgetSettled` is on disk every later call is a
 * settings read and nothing more. Never touches the memory file; never runs
 * for an archived room (callers already refuse those); one settings write per
 * room, ever. A room whose file cannot be read is left for the next reader.
 */
export function settleMemoryBudget(agentIdRaw: string): MemoryBudgetSettlement {
	const settings = readPersistentRoomMaintenanceSettings(agentIdRaw);
	const from = settings.memoryBudgetTokens;
	const unchanged: MemoryBudgetSettlement = { settled: false, from, to: from };
	if (settings.memoryBudgetSettled) return unchanged;
	let files: RoomFiles;
	let raw: string;
	try {
		files = roomFiles(agentIdRaw);
		raw = readL1bOrThrow(files);
	} catch {
		return unchanged;
	}
	try {
		if (isMigratedMemoryDocument(raw) || from !== MEMORY_BUDGET_DEFAULT_TOKENS) {
			writePersistentRoomMaintenanceSettings(files.agentId, { memoryBudgetSettled: true });
			return unchanged;
		}
		const size = reviewTargetEstimatedTokensFromL1b(raw);
		const to = Math.min(MEMORY_BUDGET_MAX_TOKENS, Math.max(MEMORY_BUDGET_MIN_TOKENS, Math.max(MEMORY_BUDGET_DEFAULT_TOKENS, Math.ceil((size * 1.25) / 1000) * 1000)));
		writePersistentRoomMaintenanceSettings(files.agentId, { memoryBudgetTokens: to, memoryBudgetSettled: true, ...(to !== from ? { memoryBudgetSettledTo: to } : {}) });
		if (to !== from) console.info(`memory budget settled for ${files.agentId}: ${from} -> ${to}`);
		return { settled: to !== from, from, to };
	} catch {
		return unchanged; // a settings file that cannot be written leaves the question for the next reader
	}
}

// --- the archive file --------------------------------------------------------

export function readArchive(agentIdRaw: string): ArchivedEntry[] {
	return parseArchive(readArchiveText(roomFiles(agentIdRaw)));
}

export function readArchiveIndex(agentIdRaw: string): ArchiveIndex {
	return archiveIndex(readArchive(agentIdRaw));
}

/**
 * Appends entries to `L1b/archive/entries.md` on their own — what a demotion
 * pass uses when it is not writing the core in the same step. The archive never
 * enters a prompt and is append-only, so it carries no snapshot of its own; the
 * core file's snapshots are the room's history.
 */
export function appendArchive(agentIdRaw: string, appends: MemoryArchiveAppend[], now = new Date()): ArchivedEntry[] {
	const files = roomFiles(agentIdRaw);
	assertMemoryWriteAllowed(files.agentId);
	if (appends.length === 0) return [];
	const { text, archived } = archiveTextWith(readArchiveText(files), appends, [], now);
	ensureDir(files.archiveDir);
	writeFileAtomic(files.archiveEntriesPath, text);
	return archived;
}

function archiveTextWith(current: string, appends: MemoryArchiveAppend[], removeIds: string[], now: Date): { text: string; archived: ArchivedEntry[]; restored: ArchivedEntry[] } {
	let text = current;
	const restored: ArchivedEntry[] = [];
	for (const id of removeIds) {
		const removal = removeFromArchive(text, id);
		if (!removal.entry) throw memoryEntryUnknownError(true);
		text = removal.text;
		restored.push(removal.entry);
	}
	const day = isoDay(now);
	const entries = appends.map((append) => append.entry);
	const meta = appends.map((append) => ({ archived: append.archived ?? day, why: append.why, topic: append.topic, section: append.section }));
	if (entries.length > 0) text = appendToArchive(text, entries, meta);
	const archived: ArchivedEntry[] = entries.map((entry, i) => ({ ...entry, ...meta[i] }));
	return { text, archived, restored };
}

export interface MemoryArchiveDeleteResult {
	agentId: string;
	memoryEditId: string;
	/** The row that left the archive, as it was. */
	deleted: ArchivedEntry;
	/** What the archive holds now. */
	archive: ArchivedEntry[];
	eventRecordPath: string;
	eventRelPath: string;
}

const ARCHIVE_DELETE_TEXT_KEEP_CHARS = 200;

/**
 * Deletes one archived note for good: the only write in this module that
 * destroys anything. The archive is otherwise the way out of memory and the
 * way back; a person may decide a note has no way back, and this is that
 * decision. It refuses while the room is busy like every write, refuses an
 * unknown row with the archive's own sentence, and records itself under
 * `events/memory-edit` as a user edit — the room's history must show a note
 * leaving for good exactly as it shows one being restored. The notes file is
 * not touched, so there is no snapshot of it; the record keeps the note's
 * first lines so the history can still say what went.
 */
export function deleteArchivedEntry(agentIdRaw: string, entryId: string, now = new Date()): MemoryArchiveDeleteResult {
	const files = roomFiles(agentIdRaw);
	assertMemoryWriteAllowed(files.agentId);
	const removal = removeFromArchive(readArchiveText(files), entryId);
	if (!removal.entry) throw memoryEntryUnknownError(true);
	const deleted = removal.entry;

	const stamp = slugTimestamp(now);
	const memoryEditId = `edit_${stamp}_${shortRandomId()}`;
	const eventRecordPath = files.instance.memoryEditEventRecordPath(memoryEditId);
	const budget = memoryBudgetState(files.agentId, parseMemoryDocument(readL1bOrThrow(files)));

	ensureDir(files.archiveDir);
	writeFileAtomic(files.archiveEntriesPath, removal.text);

	const record: MemoryEditEventRecord = {
		schemaVersion: 1,
		operation: "memory_edit",
		kind: "user_edit",
		agentId: files.agentId,
		memoryEditId,
		approvedAt: now.toISOString(),
		entryId,
		entryOperation: "archive_delete",
		edit: {
			op: "archive_delete",
			id: deleted.id,
			topic: deleted.topic,
			section: deleted.section,
			...(deleted.text ? { text: deleted.text.slice(0, ARCHIVE_DELETE_TEXT_KEEP_CHARS) } : {}),
		},
		paths: {
			updatedL1bRelPath: files.instance.rootRelativePath(files.l1bPath),
			eventRelPath: files.instance.rootRelativePath(eventRecordPath),
		},
		budget: {
			budgetTokens: budget.budgetTokens,
			reviewTargetTokensBefore: budget.reviewTargetTokens,
			reviewTargetTokensAfter: budget.reviewTargetTokens,
			overBudgetBefore: budget.overBudget,
			overBudgetAfter: budget.overBudget,
		},
	};
	ensureDir(path.dirname(eventRecordPath));
	fs.writeFileSync(eventRecordPath, JSON.stringify(record, null, 2) + "\n", { mode: 0o600, flag: "wx" });

	return {
		agentId: files.agentId,
		memoryEditId,
		deleted,
		archive: parseArchive(removal.text),
		eventRecordPath,
		eventRelPath: record.paths.eventRelPath,
	};
}

// --- the room's context render ----------------------------------------------

/**
 * What the room reads every turn: the storage file with its metadata comments
 * stripped and one archive pointer line under every topic that has archived
 * entries. A file nobody has migrated comes back verbatim (see
 * renderMemoryContext), so switching the boot path to this function changes no
 * existing room's prompt by a single byte. Never writes, never migrates: a boot
 * is not the place to change a room's memory.
 */
export function contextRender(agentIdRaw: string): string {
	const files = roomFiles(agentIdRaw);
	return renderMemoryContext(readL1bOrThrow(files), readArchiveText(files));
}

// --- load --------------------------------------------------------------------

/**
 * The fallback saved-on date migration gives an entry that carries no "(saved
 * YYYY-MM-DD)" stamp: the file's own last checkpoint (or consolidation) day,
 * which is the last day this memory demonstrably changed. Today only when the
 * room has never had either.
 */
function fallbackSavedDate(doc: MemoryDocument, now: Date): string {
	for (const label of ["Last checkpoint at", "Last consolidation at"]) {
		const match = new RegExp(`^-\\s*${label}:\\s*(\\d{4}-\\d{2}-\\d{2})`, "m").exec(doc.chronos);
		if (match) return match[1];
	}
	return isoDay(now);
}

export function loadMemoryDocument(agentIdRaw: string, options: LoadMemoryDocumentOptions = {}): MemoryDocumentLoad {
	const files = roomFiles(agentIdRaw);
	const now = options.now ?? new Date();
	const raw = readL1bOrThrow(files);
	if (isMigratedMemoryDocument(raw) || options.migrate === false) {
		const doc = parseMemoryDocument(raw);
		return { doc, archive: parseArchive(readArchiveText(files)), budget: memoryBudgetState(files.agentId, doc), migrated: false };
	}
	const parsed = parseMemoryDocument(raw);
	const migrated = migrateMemoryDocument(parsed, { fallbackSaved: fallbackSavedDate(parsed, now) });
	if (options.migrate === "in-memory") {
		return {
			doc: migrated.doc,
			archive: parseArchive(readArchiveText(files)),
			budget: memoryBudgetState(files.agentId, migrated.doc),
			migrated: false,
			pendingMigration: { entriesAssigned: migrated.assigned },
		};
	}
	const migration = writeMemoryDocument(files.agentId, migrated.doc, {
		why: "migrate",
		snapshotLabel: "migrate",
		entriesAssigned: migrated.assigned,
		now,
	});
	// Re-read what actually landed: the document the caller holds must be the
	// document on disk, stamped Chronos line included, or its next write would
	// silently revert it.
	const doc = parseMemoryDocument(fs.readFileSync(files.l1bPath, "utf-8"));
	return { doc, archive: parseArchive(readArchiveText(files)), budget: migration.budget, migrated: true, migration };
}

// --- write -------------------------------------------------------------------

/**
 * The one write. Order is not an accident: the snapshot first (so the previous
 * file survives whatever follows), then the archive (so an entry is in the
 * archive before it is out of the core — a crash between the two costs a
 * duplicate, never a loss), then the core, then the event record.
 */
export function writeMemoryDocument(agentIdRaw: string, doc: MemoryDocument, options: MemoryWriteOptions): MemoryWriteResult {
	const files = roomFiles(agentIdRaw);
	assertMemoryWriteAllowed(files.agentId);
	const now = options.now ?? new Date();
	const currentL1b = readL1bOrThrow(files);
	const before = memoryBudgetState(files.agentId, parseMemoryDocument(currentL1b));

	const stamp = slugTimestamp(now);
	const memoryEditId = `${options.snapshotLabel}_${stamp}_${shortRandomId()}`;
	const archivedL1bPath = path.join(files.archiveDir, `${stamp}-before-${memoryEditId}.md`);
	const stampChronos = options.stampChronos ?? ((l1b: string, at: Date) => updateChronosForMemoryEdit(l1b, at));
	const nextL1b = stampChronos(renderMemoryDocument(cloneDocument(doc), "storage"), now, memoryEditId);
	const archiveUpdate = archiveTextWith(readArchiveText(files), options.archiveAppend ?? [], options.archiveRemoveIds ?? [], now);

	ensureDir(files.archiveDir);
	fs.writeFileSync(archivedL1bPath, currentL1b, { mode: 0o600, flag: "wx" });
	if ((options.archiveAppend?.length ?? 0) > 0 || (options.archiveRemoveIds?.length ?? 0) > 0) writeFileAtomic(files.archiveEntriesPath, archiveUpdate.text);
	writeFileAtomic(files.l1bPath, nextL1b);

	const after = memoryBudgetState(files.agentId, parseMemoryDocument(nextL1b));
	if (options.writeEventRecord) {
		const written = options.writeEventRecord({
			agentId: files.agentId,
			writeId: memoryEditId,
			now,
			currentL1b,
			writtenL1b: nextL1b,
			archivedL1bPath,
			updatedL1bPath: files.l1bPath,
			budgetBefore: before,
			budgetAfter: after,
		});
		return {
			agentId: files.agentId,
			memoryEditId,
			archivedL1bPath,
			updatedL1bPath: files.l1bPath,
			eventRecordPath: written.eventRecordPath,
			eventRelPath: written.eventRelPath,
			budget: after,
			archived: archiveUpdate.archived,
			restored: archiveUpdate.restored,
		};
	}
	const eventRecordPath = files.instance.memoryEditEventRecordPath(memoryEditId);
	const record: MemoryEditEventRecord = {
		schemaVersion: 1,
		operation: "memory_edit",
		kind: options.why,
		agentId: files.agentId,
		memoryEditId,
		approvedAt: now.toISOString(),
		...(options.entryId ? { entryId: options.entryId } : {}),
		...(options.operation ? { entryOperation: options.operation } : {}),
		...(options.entriesAssigned !== undefined ? { entriesAssigned: options.entriesAssigned } : {}),
		...(options.archiveAppend?.length ? { archived: options.archiveAppend.map((append) => ({ id: append.entry.id, why: append.why, topic: append.topic, section: append.section })) } : {}),
		...(options.archiveRemoveIds?.length ? { restored: [...options.archiveRemoveIds] } : {}),
		paths: {
			archivedL1bRelPath: files.instance.rootRelativePath(archivedL1bPath),
			updatedL1bRelPath: files.instance.rootRelativePath(files.l1bPath),
			eventRelPath: files.instance.rootRelativePath(eventRecordPath),
		},
		budget: {
			budgetTokens: after.budgetTokens,
			reviewTargetTokensBefore: before.reviewTargetTokens,
			reviewTargetTokensAfter: after.reviewTargetTokens,
			overBudgetBefore: before.overBudget,
			overBudgetAfter: after.overBudget,
		},
	};
	ensureDir(path.dirname(eventRecordPath));
	fs.writeFileSync(eventRecordPath, JSON.stringify(record, null, 2) + "\n", { mode: 0o600, flag: "wx" });

	return {
		agentId: files.agentId,
		memoryEditId,
		archivedL1bPath,
		updatedL1bPath: files.l1bPath,
		eventRecordPath,
		eventRelPath: record.paths.eventRelPath,
		budget: after,
		archived: archiveUpdate.archived,
		restored: archiveUpdate.restored,
	};
}

// --- restore -----------------------------------------------------------------

export interface MemoryRestoreOptions {
	/** The bytes to put back as `current.md` — an earlier snapshot of this room, verbatim. */
	restoredL1b: string;
	/** The `<event>` half of the snapshot name and the write id's prefix ("undo"). */
	snapshotLabel: string;
	/** Archive rows the restored file's own write had appended, taken back out with it. */
	archiveRemoveIds?: string[];
	/** Where this write's event record lands, and what it says. Same seam Memorize uses. */
	writeEventRecord(input: {
		agentId: string;
		writeId: string;
		now: Date;
		currentL1b: string;
		restoredL1b: string;
		archivedL1bPath: string;
		updatedL1bPath: string;
		budgetBefore: BudgetState;
		budgetAfter: BudgetState;
	}): { eventRecordPath: string; eventRelPath: string };
	now?: Date;
}

export interface MemoryRestoreResult {
	agentId: string;
	writeId: string;
	archivedL1bPath: string;
	updatedL1bPath: string;
	eventRecordPath: string;
	eventRelPath: string;
	budget: BudgetState;
	/** The ids actually taken out of the archive; a row already gone is not one of them. */
	removedArchiveIds: string[];
}

/**
 * The other write: an earlier file put back byte for byte. It is deliberately
 * NOT writeMemoryDocument with a parsed document — that re-renders, and a
 * restore that re-renders is a new file that merely resembles the old one. The
 * order is the same one every write here obeys: the file being replaced is
 * snapshotted first, then the archive, then the core, then the event record.
 *
 * Chronos is not stamped: the restored file already carries the Chronos lines
 * of the state it is being put back to, and writing today's date over them
 * would claim a change that is being taken back.
 */
export function restoreMemoryFile(agentIdRaw: string, options: MemoryRestoreOptions): MemoryRestoreResult {
	const files = roomFiles(agentIdRaw);
	assertMemoryWriteAllowed(files.agentId);
	const now = options.now ?? new Date();
	const currentL1b = readL1bOrThrow(files);
	const before = memoryBudgetState(files.agentId, parseMemoryDocument(currentL1b));

	const stamp = slugTimestamp(now);
	const writeId = `${options.snapshotLabel}_${stamp}_${shortRandomId()}`;
	const archivedL1bPath = path.join(files.archiveDir, `${stamp}-before-${writeId}.md`);

	// A row the archive no longer holds is left alone rather than refused: what
	// guarantees these rows are the restored write's own is the caller's
	// staleness check, and a memory that is already back should not be held
	// hostage to a row someone took out by hand.
	let archiveText = readArchiveText(files);
	const removedArchiveIds: string[] = [];
	for (const id of options.archiveRemoveIds ?? []) {
		const removal = removeFromArchive(archiveText, id);
		if (!removal.entry) continue;
		archiveText = removal.text;
		removedArchiveIds.push(id);
	}

	ensureDir(files.archiveDir);
	fs.writeFileSync(archivedL1bPath, currentL1b, { mode: 0o600, flag: "wx" });
	if (removedArchiveIds.length > 0) writeFileAtomic(files.archiveEntriesPath, archiveText);
	writeFileAtomic(files.l1bPath, options.restoredL1b);

	const after = memoryBudgetState(files.agentId, parseMemoryDocument(options.restoredL1b));
	const written = options.writeEventRecord({
		agentId: files.agentId,
		writeId,
		now,
		currentL1b,
		restoredL1b: options.restoredL1b,
		archivedL1bPath,
		updatedL1bPath: files.l1bPath,
		budgetBefore: before,
		budgetAfter: after,
	});
	return {
		agentId: files.agentId,
		writeId,
		archivedL1bPath,
		updatedL1bPath: files.l1bPath,
		eventRecordPath: written.eventRecordPath,
		eventRelPath: written.eventRelPath,
		budget: after,
		removedArchiveIds,
	};
}
