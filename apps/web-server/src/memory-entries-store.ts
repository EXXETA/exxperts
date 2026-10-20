// The store between the pure entry model (memory-entries.ts) and the room's files. Every memory write refuses during a turn, which
// reads this memory, and a notes-file write also snapshots the old file and records an event. Reads write only one migration and the budget's settle.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
	appendToArchive,
	cloneDocument,
	highestEntryNumber,
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
	type ArchiveReason,
	type MemoryDocument,
	type MemoryEntry,
	type MemorySection,
} from "./memory-entries.js";
import { createPersistentAgentInstance, getPersistentAgentStatus, reviewTargetEstimatedTokensFromL1b, updateChronosForMemoryEdit, type PersistentAgentInstance } from "./persistent-agents.js";
import { clearCommitIntent, readCommitIntent, registerCommitSettler, writeCommitIntent } from "./memory-commit.js";
import { MEMORY_BUDGET_DEFAULT_TOKENS, MEMORY_BUDGET_MAX_TOKENS, MEMORY_BUDGET_MIN_TOKENS, readPersistentRoomMaintenanceSettings, writePersistentRoomMaintenanceSettings } from "./persistent-room-maintenance-settings.js";

export { MEMORY_ARCHIVE_ENTRIES_FILE };

/** What every entries response discloses about the room's budget. */
export interface BudgetState {
	reviewTargetTokens: number;
	budgetTokens: number;
	overBudget: boolean;
}

/** "absorb" and "review" go through this one write but record under their own folders (the `eventRecord` option); "undo" puts an earlier file back byte for byte (restoreMemoryFile). */
export type MemoryEditKind = "migrate" | "user_edit" | "absorb" | "review" | "undo";

/** The operation a `user_edit` record carries; "archive_delete" alone never touches the notes file (deleteArchivedEntry). */
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

/** One archive row a write appends, with the address a restore needs. */
export interface MemoryArchiveAppend {
	entry: MemoryEntry;
	why: ArchiveReason;
	topic: string;
	section: MemorySection;
	/** YYYY-MM-DD; defaults to the write's own day. */
	archived?: string;
	/** YYYY-MM-DD the text stopped holding: the day the text that replaced it was learned. */
	until?: string;
}

export interface MemoryWriteOptions {
	why: MemoryEditKind;
	/** The `<event>` half of the snapshot name and the event id's prefix ("migrate", "edit", …). */
	snapshotLabel: string;
	archiveAppend?: MemoryArchiveAppend[];
	/** Entries coming back out of the archive in this same write (a restore). */
	archiveRemoveIds?: string[];
	/** The entry this write was about, and what was done to it — the history row's detail. */
	entryId?: string;
	operation?: MemoryEditOperation;
	/** The page's id for this request: an add sent again after its answer was lost finds it here and adds nothing. */
	requestId?: string;
	entriesAssigned?: number;
	/** How the write stamps Chronos: the memory-edit stamp by default; Memorize and Review pass their own. */
	stampChronos?: (l1b: string, now: Date, writeId: string) => string;
	/** Builds the event record instead of the default memory-edit one. It only builds: the write keeps it in its intent and writes it after the core, so it lands with the memory or not at all. */
	eventRecord?: (input: {
		agentId: string;
		writeId: string;
		now: Date;
		currentL1b: string;
		writtenL1b: string;
		archivedL1bPath: string;
		updatedL1bPath: string;
		budgetBefore: BudgetState;
		budgetAfter: BudgetState;
	}) => MemoryEventRecordPlan;
	/** The room's memory limit this write sets (a limit the card raised): it lands with the core file or not at all, and the budget after is measured against it. */
	limitTo?: number;
	now?: Date;
}

/** An event record a write will put down after its core file, and where. */
export interface MemoryEventRecordPlan {
	eventRecordPath: string;
	record: unknown;
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
	/** The page's id for the request that made this edit (an add), kept so a second send adds nothing. */
	requestId?: string;
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
	migration?: MemoryWriteResult;
	/** Set when the load migrated in memory only: the caller holds ids the file does not have yet, and owes that write (or none). */
	pendingMigration?: { entriesAssigned: number };
}

export interface LoadMemoryDocumentOptions {
	/**
	 * What a load may do to a file without entry ids: `true` (default) migrates and writes, as a pane edit does before its own
	 * write; `false` leaves it alone, for readers that never write; `"in-memory"` migrates and writes nothing (pendingMigration), as the pane's reads do.
	 */
	migrate?: boolean | "in-memory";
	now?: Date;
}

/** The room is mid-turn: the model is reading this memory right now, which is why the edit waits. */
export const MEMORY_ROOM_BUSY_SENTENCE = "This room is in the middle of a turn. Wait for it to finish, then change the memory.";
export const MEMORY_ENTRY_UNKNOWN_SENTENCE = "That entry is not in this room's memory any more.";
export const MEMORY_ARCHIVED_ENTRY_UNKNOWN_SENTENCE = "That entry is not in this room's archive any more.";
/** A restore of a note the core already holds, in this or another version: nothing is put in beside it. */
export const MEMORY_ENTRY_ALREADY_IN_CORE_SENTENCE = "This note is already in memory.";
/** A restore of an older value a newer conversation replaced: it stays in the archive as history. */
export const MEMORY_ENTRY_HISTORY_SENTENCE = "This is an older value kept as history, so it cannot be restored as current.";

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

/** A conflict, not a bad request: the row is real, and a newer value holds its place. */
export function memoryEntryHistoryError(): Error {
	return productError(MEMORY_ENTRY_HISTORY_SENTENCE, "memory_entry_history", 409);
}

/** A conflict, not a bad request: the archive row is real, the core just holds the note already. */
export function memoryEntryAlreadyInCoreError(): Error {
	return productError(MEMORY_ENTRY_ALREADY_IN_CORE_SENTENCE, "memory_entry_already_in_core", 409);
}

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
		return "";
	}
}

/** The guard every write passes: activeThread.inFlight, as the background-run classifier reads it, never the room lock, which the open pane holds. */
export function memoryRoomBusy(agentIdRaw: string): boolean {
	try {
		return getPersistentAgentStatus(agentIdRaw).activeThread?.inFlight === true;
	} catch {
		return false; // an unreadable room fails on its own file reads, with its own sentence
	}
}

/** A Maintain save that meets a turn waits up to two minutes for it to end, then refuses as before; the caller holds the save lock and writes with no await after this. */
export async function waitForMemoryRoomTurn(agentIdRaw: string, limitMs = 120_000): Promise<void> {
	for (const until = Date.now() + limitMs; memoryRoomBusy(agentIdRaw) && Date.now() < until; ) await new Promise((resolve) => setTimeout(resolve, 250));
}

export function assertMemoryWriteAllowed(agentIdRaw: string): void {
	if (memoryRoomBusy(agentIdRaw)) throw memoryRoomBusyError();
}

/** The budget line: Deep Memory and Active Items in their context render against the owner's budget; the shared numerator in persistent-agents.ts measures the same render. */
export function memoryBudgetState(agentIdRaw: string, doc: MemoryDocument, limitTo?: number): BudgetState {
	settleMemoryBudget(agentIdRaw);
	const budgetTokens = limitTo ?? readPersistentRoomMaintenanceSettings(agentIdRaw).memoryBudgetTokens;
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
 * The first read of a room without entry ids on the default budget sets the budget to the room's size plus a quarter (at least the default, at most the ceiling), so its first Memorize does not archive most notes.
 * Call it before reading a room's budget, as getPersistentAgentStatus does; it writes the settings once per room, never the memory file, and callers refuse archived rooms.
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

export function readArchive(agentIdRaw: string): ArchivedEntry[] {
	return parseArchive(readArchiveText(roomFiles(agentIdRaw)));
}

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
	const meta = appends.map((append) => ({ archived: append.archived ?? day, why: append.why, ...(append.until ? { until: append.until } : {}), topic: append.topic, section: append.section }));
	if (entries.length > 0) text = appendToArchive(text, entries, meta);
	const archived: ArchivedEntry[] = entries.map((entry, i) => ({ ...entry, ...meta[i] }));
	return { text, archived, restored };
}

export interface MemoryArchiveDeleteResult {
	agentId: string;
	memoryEditId: string;
	deleted: ArchivedEntry;
	archive: ArchivedEntry[];
	eventRecordPath: string;
	eventRelPath: string;
}

const ARCHIVE_DELETE_TEXT_KEEP_CHARS = 200;

/** Deletes one archived note for good, the only write here that destroys anything. The notes file is untouched, so no snapshot; the record keeps the note's topic for the history, and its first characters. */
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

/** The context render with archive pointers and pair days; a never-migrated file comes back verbatim. Never writes or migrates. */
export function contextRender(agentIdRaw: string): string {
	const files = roomFiles(agentIdRaw);
	return renderMemoryContext(readL1bOrThrow(files), readArchiveText(files), { pairDays: true });
}

/** Migration's fallback saved-on date: the file's last checkpoint day, else its last consolidation day, each a day this memory demonstrably changed; today when there is neither. */
function fallbackSavedDate(doc: MemoryDocument, now: Date): string {
	for (const label of ["Last checkpoint at", "Last consolidation at"]) {
		const match = new RegExp(`^-\\s*${label}:\\s*(\\d{4}-\\d{2}-\\d{2})`, "m").exec(doc.chronos);
		if (match) return match[1];
	}
	return isoDay(now);
}

/** The parsed document with its counter never below one past the archive's highest number: an id minted below it would duplicate an archived row the day it is restored. */
function parseWithCounterAboveArchive(l1b: string, archive: ArchivedEntry[]): MemoryDocument {
	const doc = parseMemoryDocument(l1b);
	doc.nextEntryNumber = Math.max(doc.nextEntryNumber, highestEntryNumber(archive.map((entry) => entry.id)) + 1);
	return doc;
}

export function loadMemoryDocument(agentIdRaw: string, options: LoadMemoryDocumentOptions = {}): MemoryDocumentLoad {
	const files = roomFiles(agentIdRaw);
	const now = options.now ?? new Date();
	const raw = readL1bOrThrow(files);
	const archive = parseArchive(readArchiveText(files));
	const parsed = parseWithCounterAboveArchive(raw, archive);
	// A marked file can still hold a note without its marker (the scaffold's
	// starter goal): it is marked like a file nobody has migrated yet.
	const unmarked = parsed.topics.some((topic) => topic.entries.some((entry) => !entry.id));
	if ((isMigratedMemoryDocument(raw) && !unmarked) || options.migrate === false) {
		return { doc: parsed, archive, budget: memoryBudgetState(files.agentId, parsed), migrated: false };
	}
	const migrated = migrateMemoryDocument(parsed, { fallbackSaved: fallbackSavedDate(parsed, now) });
	if (options.migrate === "in-memory") {
		return {
			doc: migrated.doc,
			archive,
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
	// Re-read what landed: the caller's document must be the one on disk, stamped Chronos included, or its next write would revert it.
	const doc = parseWithCounterAboveArchive(fs.readFileSync(files.l1bPath, "utf-8"), archive);
	return { doc, archive, budget: migration.budget, migrated: true, migration };
}

/** How many of a room's newest records a resent request reads: it comes minutes after the first, so a long history is never read whole. */
export const RECENT_RECORDS_READ = 500;

/** A folder's newest records, newest first: a name is its label then its write time, so the order is the time's, whatever the label. */
export function newestRecordFiles(dir: string): string[] {
	const time = (file: string) => file.slice(file.indexOf("_") + 1);
	return fs.readdirSync(dir).filter((file) => file.endsWith(".json")).sort((a, b) => time(b).localeCompare(time(a))).slice(0, RECENT_RECORDS_READ);
}

/** The newest of the room's recent edit records that matches, or null: what a request sent again finds out from. */
export function findMemoryEditRecord(agentIdRaw: string, matches: (record: MemoryEditEventRecord) => boolean): MemoryEditEventRecord | null {
	const dir = roomFiles(agentIdRaw).instance.memoryEditEventDir();
	let files: string[];
	try {
		files = newestRecordFiles(dir);
	} catch {
		return null;
	}
	for (const file of files) {
		try {
			const record = JSON.parse(fs.readFileSync(path.join(dir, file), "utf-8")) as MemoryEditEventRecord;
			if (matches(record)) return record;
		} catch { /* an unreadable record matches nothing */ }
	}
	return null;
}

/**
 * The one write, in this order: the intent (memory-commit.ts), the snapshot, the archive's new rows (a crash then costs a
 * duplicate, never a loss), the core as the commit point, then archive removals, the limit and the event record, which a crash leaves to the next request.
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
	const archiveBefore = readArchiveText(files);
	const archiveUpdate = archiveTextWith(archiveBefore, options.archiveAppend ?? [], options.archiveRemoveIds ?? [], now);

	const after = memoryBudgetState(files.agentId, parseMemoryDocument(nextL1b), options.limitTo);
	const plan = options.eventRecord
		? options.eventRecord({
			agentId: files.agentId,
			writeId: memoryEditId,
			now,
			currentL1b,
			writtenL1b: nextL1b,
			archivedL1bPath,
			updatedL1bPath: files.l1bPath,
			budgetBefore: before,
			budgetAfter: after,
		})
		: memoryEditRecordPlan(files, memoryEditId, now, archivedL1bPath, before, after, options);
	commitMemoryWrite(files, {
		writeId: memoryEditId,
		currentL1b,
		nextL1b,
		archivedL1bPath,
		...(options.archiveAppend?.length ? { archiveText: archiveTextWith(archiveBefore, options.archiveAppend, [], now).text } : {}),
		...(options.archiveRemoveIds?.length ? { archiveRemoveIds: [...options.archiveRemoveIds] } : {}),
		...(options.limitTo !== undefined ? { limitTo: options.limitTo } : {}),
		plan,
	});
	return {
		agentId: files.agentId,
		memoryEditId,
		archivedL1bPath,
		updatedL1bPath: files.l1bPath,
		eventRecordPath: plan.eventRecordPath,
		eventRelPath: files.instance.rootRelativePath(plan.eventRecordPath),
		budget: after,
		archived: archiveUpdate.archived,
		restored: archiveUpdate.restored,
	};
}

function memoryEditRecordPlan(files: RoomFiles, memoryEditId: string, now: Date, archivedL1bPath: string, before: BudgetState, after: BudgetState, options: MemoryWriteOptions): MemoryEventRecordPlan {
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
		...(options.requestId ? { requestId: options.requestId } : {}),
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
	return { eventRecordPath, record };
}

/** A memory write in flight (memory-commit.ts): ids, the hash of the core it writes, and what follows the core. */
interface MemoryCommitIntent {
	writeId: string;
	l1bSha256: string;
	archivedL1bRelPath: string;
	limitTo?: number;
	/** Archive rows that leave the archive after the core landed. */
	archiveRemoveIds?: string[];
	eventRecordRelPath: string;
	record: unknown;
	/** An earlier save whose rest could not be finished yet: finished first, never written over. */
	earlier?: MemoryCommitIntent;
}

function sha256(text: string): string {
	return crypto.createHash("sha256").update(text, "utf-8").digest("hex");
}

/**
 * The intent, the snapshot, the archive's new rows, the core (the commit point), then the rest. A failure after the core
 * keeps its intent for the next request to finish, so the caller hears that the save landed, which is true.
 */
function commitMemoryWrite(files: RoomFiles, input: { writeId: string; currentL1b: string; nextL1b: string; archivedL1bPath: string; archiveText?: string; archiveRemoveIds?: string[]; limitTo?: number; plan: MemoryEventRecordPlan }): void {
	const rootDir = files.instance.rootDir;
	const intent: MemoryCommitIntent = {
		writeId: input.writeId,
		l1bSha256: sha256(input.nextL1b),
		archivedL1bRelPath: files.instance.rootRelativePath(input.archivedL1bPath),
		...(input.limitTo !== undefined ? { limitTo: input.limitTo } : {}),
		...(input.archiveRemoveIds?.length ? { archiveRemoveIds: input.archiveRemoveIds } : {}),
		eventRecordRelPath: files.instance.rootRelativePath(input.plan.eventRecordPath),
		record: input.plan.record,
	};
	// A pending save rides along only when its core is the one on disk now; one
	// whose core never landed is settled here, so nothing of it is finished.
	const earlier = readCommitIntent<MemoryCommitIntent>(rootDir, "memory");
	if (earlier && earlier.l1bSha256 === sha256(input.currentL1b)) intent.earlier = earlier;
	else if (earlier) {
		try {
			settleMemoryIntent(files.agentId, rootDir, input.currentL1b, earlier);
		} catch (error) {
			console.error(`[memory-commit] a memory save in ${files.agentId} that never landed could not be cleared: ${(error as Error)?.name ?? "Error"}`);
		}
	}
	// Synchronous from the intent to its clear: the settle runs outside the save lock, so an await here would let a status request finish or drop this save mid-flight.
	writeCommitIntent(rootDir, "memory", intent);
	ensureDir(files.archiveDir);
	fs.writeFileSync(input.archivedL1bPath, input.currentL1b, { mode: 0o600, flag: "wx" });
	if (input.archiveText !== undefined) writeFileAtomic(files.archiveEntriesPath, input.archiveText);
	writeFileAtomic(files.l1bPath, input.nextL1b);
	try {
		finishMemoryCommit(files.agentId, rootDir, intent);
		clearCommitIntent(rootDir, "memory");
	} catch (error) {
		console.error(`[memory-commit] a memory save in ${files.agentId} landed; its record waits for the next request: ${(error as Error)?.name ?? "Error"}`);
	}
}

/** What follows the core file, each step safe to run twice. */
function finishMemoryCommit(agentId: string, rootDir: string, intent: MemoryCommitIntent): void {
	if (intent.earlier) finishMemoryCommit(agentId, rootDir, intent.earlier);
	if (intent.archiveRemoveIds?.length) {
		const files = roomFiles(agentId);
		let text = readArchiveText(files);
		let removed = false;
		for (const id of intent.archiveRemoveIds) {
			const removal = removeFromArchive(text, id);
			if (!removal.entry) continue; // already out: this step ran before
			text = removal.text;
			removed = true;
		}
		if (removed) writeFileAtomic(files.archiveEntriesPath, text);
	}
	if (intent.limitTo !== undefined && readPersistentRoomMaintenanceSettings(agentId).memoryBudgetTokens !== intent.limitTo) {
		writePersistentRoomMaintenanceSettings(agentId, { memoryBudgetTokens: intent.limitTo });
	}
	const eventRecordPath = path.join(rootDir, intent.eventRecordRelPath);
	if (!fs.existsSync(eventRecordPath)) {
		ensureDir(path.dirname(eventRecordPath));
		fs.writeFileSync(eventRecordPath, JSON.stringify(intent.record, null, 2) + "\n", { mode: 0o600, flag: "wx" });
	}
}

/** A memory write a crash left pending: its core landed, so it is finished; it did not, so nothing was saved and its snapshot goes. */
registerCommitSettler("memory", (agentId, rootDir, intent: MemoryCommitIntent) => {
	const files = roomFiles(agentId);
	const core = fs.existsSync(files.l1bPath) ? fs.readFileSync(files.l1bPath, "utf-8") : "";
	settleMemoryIntent(files.agentId, rootDir, core, intent);
	clearCommitIntent(rootDir, "memory");
});

/** The newest core that landed is finished with every earlier save it carries; one that did not land leaves its earlier saves to be settled on their own. */
function settleMemoryIntent(agentId: string, rootDir: string, core: string, intent: MemoryCommitIntent): void {
	if (sha256(core) === intent.l1bSha256) return finishMemoryCommit(agentId, rootDir, intent);
	fs.rmSync(path.join(rootDir, intent.archivedL1bRelPath), { force: true });
	if (intent.earlier) settleMemoryIntent(agentId, rootDir, core, intent.earlier);
}

export interface MemoryRestoreOptions {
	/** The bytes to put back as `current.md` — an earlier snapshot of this room, verbatim. */
	restoredL1b: string;
	/** The `<event>` half of the snapshot name and the write id's prefix ("undo"). */
	snapshotLabel: string;
	/** Archive rows the undone save appended, taken back out with it. */
	archiveRemoveIds?: string[];
	/** This write's event record and where it lands, built before the core is written. Same seam Memorize uses. */
	eventRecord(input: {
		agentId: string;
		writeId: string;
		now: Date;
		currentL1b: string;
		restoredL1b: string;
		archivedL1bPath: string;
		updatedL1bPath: string;
		budgetBefore: BudgetState;
		budgetAfter: BudgetState;
	}): MemoryEventRecordPlan;
	/** The room's memory limit this restore puts back with the file (an undo of a raise). */
	limitTo?: number;
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
 * The other write: an earlier file put back byte for byte, never re-rendered through writeMemoryDocument, in the same
 * order as every write here. Chronos is not stamped: the restored file carries the Chronos of the state it puts back.
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

	// A row the archive no longer holds is skipped, not refused: the caller's staleness check vouches for the rows, and a memory already back is never held hostage to a row taken out by hand.
	let archiveText = readArchiveText(files);
	const removedArchiveIds: string[] = [];
	for (const id of options.archiveRemoveIds ?? []) {
		const removal = removeFromArchive(archiveText, id);
		if (!removal.entry) continue;
		archiveText = removal.text;
		removedArchiveIds.push(id);
	}

	const after = memoryBudgetState(files.agentId, parseMemoryDocument(options.restoredL1b), options.limitTo);
	const plan = options.eventRecord({
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
	commitMemoryWrite(files, {
		writeId,
		currentL1b,
		nextL1b: options.restoredL1b,
		archivedL1bPath,
		...(removedArchiveIds.length > 0 ? { archiveRemoveIds: removedArchiveIds } : {}),
		...(options.limitTo !== undefined ? { limitTo: options.limitTo } : {}),
		plan,
	});
	return {
		agentId: files.agentId,
		writeId,
		archivedL1bPath,
		updatedL1bPath: files.l1bPath,
		eventRecordPath: plan.eventRecordPath,
		eventRelPath: files.instance.rootRelativePath(plan.eventRecordPath),
		budget: after,
		removedArchiveIds,
	};
}
