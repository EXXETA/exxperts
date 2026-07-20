import fs from "node:fs";
import path from "node:path";
import { DEFAULT_PERSISTENT_ROOM_AGENTS_ROOT, persistentAgentRootPath } from "./persistent-room-workspace-policy.js";

/**
 * Durable per-task ledger for specialist tasks (assets contract §2, rung 1).
 *
 * The launch closure writes a record when a task is announced and finalizes it
 * on every terminal path, so the outcome of a task survives the WebSocket that
 * started it — the task_* frames themselves are fire-and-forget and a dead
 * socket silently drops them. One JSON file per task under the owning room's
 * runtime dir; the ledger dies with the room folder on room delete.
 *
 * The ledger is a passive record: it is NEVER injected into any prompt or
 * boot context. The transfer gate stays the only door into the conversation.
 *
 * `running` rows whose process died before finalizing are marked `orphaned`
 * by the boot sweep. `exports` is appended by the export route (slice D).
 */

export type TaskLedgerOutcome = "running" | "ok" | "error" | "aborted" | "orphaned";

export interface TaskLedgerArtifact {
	relativePath: string;
	bytes: number;
	extension: string;
}

export interface TaskLedgerUsage {
	input?: number;
	output?: number;
	cacheRead?: number;
	cacheWrite?: number;
	totalTokens?: number;
	cost?: number;
}

export interface TaskLedgerExport {
	relativePath: string;
	savedTo: string;
	at: string;
}

export interface TaskLedgerRecord {
	schemaVersion: 1;
	taskId: string;
	roomId: string;
	conversationId: string;
	templateId: string;
	templateVersion: number;
	title: string;
	startedAt: string;
	endedAt?: string;
	outcome: TaskLedgerOutcome;
	summary?: string;
	artifacts?: TaskLedgerArtifact[];
	usage?: TaskLedgerUsage;
	iterateParentTaskId?: string;
	exports?: TaskLedgerExport[];
	/**
	 * Stamped once the client has been told how this task ended — either the
	 * terminal frame went out on a live socket, or an away-notice was delivered
	 * on a later connect. Terminal rows without it owe the user a notice.
	 */
	awayNoticedAt?: string;
	/**
	 * Stamped when the task's FILES were deleted (GC or the panel's per-task
	 * delete). The row itself stays — it is the measurement record — but
	 * default listings hide it so no surface offers files that are gone.
	 */
	deletedAt?: string;
	/**
	 * Stamped the first time the user opens this task's result (viewer, from
	 * any entry path) or acts on it (attach). Unset on a done row = the green
	 * unread dot in the Artifacts rail (status grammar, 2026-07-18) — green
	 * means "you haven't seen this yet", so it must decay exactly once.
	 */
	viewedAt?: string;
	/**
	 * Stamped when the user took this row off the Artifacts panel ("Remove from
	 * list"). A LIST operation only — files stay on disk and deletedAt keeps its
	 * meaning ("files are gone"). Only the panel listing hides removed rows;
	 * every other reader (reseed, GC measurement, iterate mapping) still sees
	 * them, so chat items and provenance keep working. Cleared by Undo.
	 */
	removedAt?: string;
}

export interface TaskLedgerStorageOptions {
	persistentAgentsRoot?: string;
}

export const TASK_LEDGER_SUMMARY_MAX_CHARS = 4_000;

function safeLedgerRoomId(raw: string): string {
	const id = String(raw ?? "").trim();
	if (!/^[a-zA-Z0-9_-]{1,160}$/.test(id)) throw new Error("invalid persistent-room agent id");
	return id;
}

function safeLedgerTaskId(raw: string): string {
	const id = String(raw ?? "").trim();
	if (!/^[a-zA-Z0-9_-]{1,80}$/.test(id)) throw new Error("invalid task id");
	return id;
}

export function taskLedgerDirPath(roomIdRaw: string, options: TaskLedgerStorageOptions = {}): string {
	const roomId = safeLedgerRoomId(roomIdRaw);
	return path.join(persistentAgentRootPath(roomId, options.persistentAgentsRoot ?? DEFAULT_PERSISTENT_ROOM_AGENTS_ROOT), "runtime", "task-ledger");
}

export function taskLedgerRecordPath(roomIdRaw: string, taskIdRaw: string, options: TaskLedgerStorageOptions = {}): string {
	return path.join(taskLedgerDirPath(roomIdRaw, options), `${safeLedgerTaskId(taskIdRaw)}.json`);
}

function clampSummary(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const summary = value.trim();
	if (!summary) return undefined;
	return summary.length > TASK_LEDGER_SUMMARY_MAX_CHARS ? `${summary.slice(0, TASK_LEDGER_SUMMARY_MAX_CHARS - 1)}…` : summary;
}

// Atomic write, background-runs pattern: temp file + rename so a crash can
// leave a stale temp file but never a torn record.
function writeTaskLedgerRecordFile(file: string, record: TaskLedgerRecord): void {
	fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
	const tempFile = `${file}.tmp-${process.pid}`;
	try {
		fs.writeFileSync(tempFile, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
		fs.renameSync(tempFile, file);
	} finally {
		try { fs.rmSync(tempFile, { force: true }); } catch {}
	}
}

function parseTaskLedgerRecord(file: string): TaskLedgerRecord | null {
	try {
		const raw = JSON.parse(fs.readFileSync(file, "utf-8"));
		if (!raw || typeof raw !== "object" || raw.schemaVersion !== 1) return null;
		if (typeof raw.taskId !== "string" || typeof raw.roomId !== "string" || typeof raw.conversationId !== "string") return null;
		if (typeof raw.startedAt !== "string" || typeof raw.outcome !== "string") return null;
		return raw as TaskLedgerRecord;
	} catch {
		return null;
	}
}

export interface CreateTaskLedgerRecordInput {
	taskId: string;
	roomId: string;
	conversationId: string;
	templateId: string;
	templateVersion: number;
	title: string;
	iterateParentTaskId?: string;
}

export function createTaskLedgerRecord(input: CreateTaskLedgerRecordInput, options: TaskLedgerStorageOptions = {}, now = new Date()): TaskLedgerRecord {
	const record: TaskLedgerRecord = {
		schemaVersion: 1,
		taskId: safeLedgerTaskId(input.taskId),
		roomId: safeLedgerRoomId(input.roomId),
		conversationId: String(input.conversationId ?? "").trim(),
		templateId: String(input.templateId ?? "").trim(),
		templateVersion: typeof input.templateVersion === "number" && Number.isFinite(input.templateVersion) ? input.templateVersion : 0,
		title: String(input.title ?? "").trim(),
		startedAt: now.toISOString(),
		outcome: "running",
		...(input.iterateParentTaskId ? { iterateParentTaskId: safeLedgerTaskId(input.iterateParentTaskId) } : {}),
	};
	writeTaskLedgerRecordFile(taskLedgerRecordPath(record.roomId, record.taskId, options), record);
	return record;
}

export interface FinalizeTaskLedgerRecordInput {
	outcome: Exclude<TaskLedgerOutcome, "running">;
	summary?: string;
	artifacts?: TaskLedgerArtifact[];
	usage?: TaskLedgerUsage;
	/** True when the terminal frame was sent on a live socket — the client already knows. */
	noticed?: boolean;
}

/** Finalize a task's row. Returns null (no throw) when the row is missing or unreadable — the ledger must never break a task. */
export function finalizeTaskLedgerRecord(roomIdRaw: string, taskIdRaw: string, input: FinalizeTaskLedgerRecordInput, options: TaskLedgerStorageOptions = {}, now = new Date()): TaskLedgerRecord | null {
	const file = taskLedgerRecordPath(roomIdRaw, taskIdRaw, options);
	const current = parseTaskLedgerRecord(file);
	if (!current) return null;
	const summary = clampSummary(input.summary);
	const record: TaskLedgerRecord = {
		...current,
		outcome: input.outcome,
		endedAt: now.toISOString(),
		...(summary ? { summary } : {}),
		...(input.artifacts && input.artifacts.length > 0
			? { artifacts: input.artifacts.map((a) => ({ relativePath: String(a.relativePath), bytes: Number(a.bytes) || 0, extension: String(a.extension ?? "") })) }
			: {}),
		...(input.usage ? { usage: { ...input.usage } } : {}),
		...(input.noticed ? { awayNoticedAt: now.toISOString() } : {}),
	};
	writeTaskLedgerRecordFile(file, record);
	return record;
}

export interface ExportedInputIngestPlanEntry {
	/** The source task's store-relative artifact path the iterate builds on. */
	sourceRelativePath: string;
	/** Absolute workspace path of the CURRENT file (latest export's savedTo). */
	savedTo: string;
	/** Store-relative destination inside the new task: tasks/<id>/inputs/<name>. */
	ingestedRelativePath: string;
}

/**
 * Ingest-on-iterate planning (G2-B, pure): map each input artifact that was
 * exported (per the ledger row's exports[] — latest entry per artifact wins)
 * to an ingest copy under the NEW task's inputs/ dir. Inputs never exported
 * produce no entry — the iterate reads their store originals as before.
 * Basename collisions between different source dirs get -2/-3 suffixes.
 */
export function planExportedInputIngest(row: TaskLedgerRecord | null, inputArtifacts: string[], newTaskFolder: string): ExportedInputIngestPlanEntry[] {
	if (!row || !row.exports || row.exports.length === 0) return [];
	const entries: ExportedInputIngestPlanEntry[] = [];
	const usedNames = new Set<string>();
	for (const sourceRelativePath of inputArtifacts) {
		// Latest export of this artifact wins — it names the file the user has
		// been living with in the workspace.
		const exportEntry = [...row.exports].reverse().find((candidate) => candidate.relativePath === sourceRelativePath);
		if (!exportEntry) continue;
		const rawName = exportEntry.savedTo.split(/[\\/]/).pop() ?? "";
		if (!rawName) continue;
		const dot = rawName.lastIndexOf(".");
		const stem = dot > 0 ? rawName.slice(0, dot) : rawName;
		const extension = dot > 0 ? rawName.slice(dot) : "";
		let name = rawName;
		for (let suffix = 2; usedNames.has(name); suffix += 1) name = `${stem}-${suffix}${extension}`;
		usedNames.add(name);
		entries.push({ sourceRelativePath, savedTo: exportEntry.savedTo, ingestedRelativePath: `${newTaskFolder}/inputs/${name}` });
	}
	return entries;
}

/**
 * Iterate-source fallback (rung 3): when a panel row is older than the
 * connection's reseeded iterate memory, derive the same server-owned facts
 * from the ledger — ok rows with artifacts only, so the D7 shape (template
 * and read scope come from the server's own record) is preserved exactly.
 */
export function resolveIterateSourceFromLedger(records: TaskLedgerRecord[], taskIdRaw: string): { templateId: string; artifacts: string[] } | null {
	const taskId = String(taskIdRaw ?? "").trim();
	if (!taskId) return null;
	const row = records.find((record) => record.taskId === taskId);
	if (!row || row.outcome !== "ok") return null;
	const artifacts = (row.artifacts ?? []).map((artifact) => artifact.relativePath);
	if (artifacts.length === 0) return null;
	return { templateId: row.templateId, artifacts };
}

/** Append a workspace export to a task's row (slice D; the mapping ingest-on-iterate consumes). Returns null (no throw) when the row is missing — pre-ledger tasks export fine without a record. */
export function appendTaskLedgerExport(roomIdRaw: string, taskIdRaw: string, exportEntry: TaskLedgerExport, options: TaskLedgerStorageOptions = {}): TaskLedgerRecord | null {
	const file = taskLedgerRecordPath(roomIdRaw, taskIdRaw, options);
	const current = parseTaskLedgerRecord(file);
	if (!current) return null;
	const record: TaskLedgerRecord = {
		...current,
		exports: [...(current.exports ?? []), { relativePath: String(exportEntry.relativePath), savedTo: String(exportEntry.savedTo), at: String(exportEntry.at) }],
	};
	writeTaskLedgerRecordFile(file, record);
	return record;
}

/** Stamp deletedAt after the task's files were removed (GC / panel delete). The row stays as the measurement record; default listings hide it. Returns null when the row is missing. */
export function markTaskLedgerRecordDeleted(roomIdRaw: string, taskIdRaw: string, options: TaskLedgerStorageOptions = {}, now = new Date()): TaskLedgerRecord | null {
	const file = taskLedgerRecordPath(roomIdRaw, taskIdRaw, options);
	const current = parseTaskLedgerRecord(file);
	if (!current) return null;
	writeTaskLedgerRecordFile(file, { ...current, deletedAt: now.toISOString() });
	return { ...current, deletedAt: now.toISOString() };
}

/**
 * Stamp removedAt: the user took this row off the Artifacts panel. Also stamps
 * awayNoticedAt when unset — removing a row is acting on it, so a later connect
 * must not announce a task the user already dismissed. Idempotent; returns the
 * updated row, or null when the row is missing.
 */
export function markTaskLedgerRecordRemoved(roomIdRaw: string, taskIdRaw: string, options: TaskLedgerStorageOptions = {}, now = new Date()): TaskLedgerRecord | null {
	const file = taskLedgerRecordPath(roomIdRaw, taskIdRaw, options);
	const current = parseTaskLedgerRecord(file);
	if (!current) return null;
	if (current.removedAt) return current;
	const record: TaskLedgerRecord = { ...current, removedAt: now.toISOString(), awayNoticedAt: current.awayNoticedAt ?? now.toISOString() };
	writeTaskLedgerRecordFile(file, record);
	return record;
}

/** Clear removedAt (the toast's Undo). Idempotent; returns the updated row, or null when the row is missing. */
export function clearTaskLedgerRecordRemoved(roomIdRaw: string, taskIdRaw: string, options: TaskLedgerStorageOptions = {}): TaskLedgerRecord | null {
	const file = taskLedgerRecordPath(roomIdRaw, taskIdRaw, options);
	const current = parseTaskLedgerRecord(file);
	if (!current) return null;
	if (!current.removedAt) return current;
	const { removedAt: _removed, ...rest } = current;
	writeTaskLedgerRecordFile(file, rest);
	return rest;
}

/** Stamp viewedAt on first open/act (idempotent — the first stamp wins; green decays once). Returns the updated row, or null when the row is missing. */
export function markTaskLedgerRecordViewed(roomIdRaw: string, taskIdRaw: string, options: TaskLedgerStorageOptions = {}, now = new Date()): TaskLedgerRecord | null {
	const file = taskLedgerRecordPath(roomIdRaw, taskIdRaw, options);
	const current = parseTaskLedgerRecord(file);
	if (!current) return null;
	if (current.viewedAt) return current;
	writeTaskLedgerRecordFile(file, { ...current, viewedAt: now.toISOString() });
	return { ...current, viewedAt: now.toISOString() };
}

/** Stamp awayNoticedAt on the given rows (after delivering their away-notice). Returns how many rows were stamped. */
export function markTaskLedgerRecordsAwayNoticed(roomIdRaw: string, taskIds: string[], options: TaskLedgerStorageOptions = {}, now = new Date()): number {
	let marked = 0;
	for (const taskId of taskIds) {
		const file = taskLedgerRecordPath(roomIdRaw, taskId, options);
		const current = parseTaskLedgerRecord(file);
		if (!current || current.awayNoticedAt) continue;
		try {
			writeTaskLedgerRecordFile(file, { ...current, awayNoticedAt: now.toISOString() });
			marked += 1;
		} catch {
			// A single unwritable row must not stop the marking pass.
		}
	}
	return marked;
}

/**
 * Reseed selection for a fresh connection: the newest `cap` ok rows, returned
 * OLDEST-FIRST so inserting them in order into the completedWebTasks map keeps
 * the newest under the map's insertion-order eviction.
 */
export function selectTaskLedgerReseedRows(records: TaskLedgerRecord[], cap: number): TaskLedgerRecord[] {
	return records
		.filter((record) => record.outcome === "ok")
		.sort((a, b) => (a.startedAt < b.startedAt ? 1 : a.startedAt > b.startedAt ? -1 : 0))
		.slice(0, Math.max(0, cap))
		.reverse();
}

export interface TaskLedgerAwayNoticeSelection {
	/** Newest ≤cap terminal rows the client was never told about. */
	notices: TaskLedgerRecord[];
	/** Unnoticed terminal rows beyond the cap (silently marked, disclosed as a count). */
	moreCount: number;
	/** Every unnoticed row's taskId — ALL get marked once the notice frame is delivered. */
	allTaskIds: string[];
}

/** Away-notice selection for a fresh connection: terminal rows without awayNoticedAt, newest-first. */
export function selectTaskLedgerAwayNotices(records: TaskLedgerRecord[], cap: number): TaskLedgerAwayNoticeSelection {
	const unnoticed = records
		.filter((record) => record.outcome !== "running" && !record.awayNoticedAt)
		.sort((a, b) => (a.startedAt < b.startedAt ? 1 : a.startedAt > b.startedAt ? -1 : 0));
	const notices = unnoticed.slice(0, Math.max(0, cap));
	return {
		notices,
		moreCount: unnoticed.length - notices.length,
		allTaskIds: unnoticed.map((record) => record.taskId),
	};
}

export interface ListTaskLedgerRecordsOptions extends TaskLedgerStorageOptions {
	conversationId?: string;
	/** Include rows whose files were deleted (measurement/audit readers only). */
	includeDeleted?: boolean;
}

/** All readable rows for a room, newest-first by startedAt. Corrupt or foreign files are skipped, never thrown. */
export function listTaskLedgerRecords(roomIdRaw: string, options: ListTaskLedgerRecordsOptions = {}): TaskLedgerRecord[] {
	const dir = taskLedgerDirPath(roomIdRaw, options);
	let names: string[];
	try {
		names = fs.readdirSync(dir);
	} catch {
		return [];
	}
	const records: TaskLedgerRecord[] = [];
	for (const name of names) {
		if (!name.endsWith(".json")) continue;
		const record = parseTaskLedgerRecord(path.join(dir, name));
		if (!record) continue;
		if (record.deletedAt && !options.includeDeleted) continue;
		if (options.conversationId && record.conversationId !== options.conversationId) continue;
		records.push(record);
	}
	return records.sort((a, b) => (a.startedAt < b.startedAt ? 1 : a.startedAt > b.startedAt ? -1 : 0));
}

/**
 * Boot sweep: mark every `running` row in every room `orphaned` — a row can
 * only still be `running` at boot if the process died before finalizing it.
 * Returns the number of rows swept.
 */
export function sweepOrphanedTaskLedgerRecords(options: TaskLedgerStorageOptions = {}, now = new Date()): number {
	const root = options.persistentAgentsRoot ?? DEFAULT_PERSISTENT_ROOM_AGENTS_ROOT;
	let roomIds: string[];
	try {
		roomIds = fs.readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
	} catch {
		return 0;
	}
	let swept = 0;
	for (const roomId of roomIds) {
		if (!/^[a-zA-Z0-9_-]{1,160}$/.test(roomId)) continue;
		for (const record of listTaskLedgerRecords(roomId, options)) {
			if (record.outcome !== "running") continue;
			const orphaned: TaskLedgerRecord = { ...record, outcome: "orphaned", endedAt: now.toISOString() };
			try {
				writeTaskLedgerRecordFile(taskLedgerRecordPath(roomId, record.taskId, options), orphaned);
				swept += 1;
			} catch {
				// A single unwritable row must not stop the sweep.
			}
		}
	}
	return swept;
}
