import fs from "node:fs";
import path from "node:path";
import { artifactRoot } from "../../../pi-package/extensions/artifacts/index.js";
import { DEFAULT_PERSISTENT_ROOM_AGENTS_ROOT } from "./persistent-room-workspace-policy.js";
import { listTaskLedgerRecords, markTaskLedgerRecordDeleted, type TaskLedgerRecord } from "./persistent-room-task-ledger.js";

/**
 * Task-store safety-valve GC (assets contract §4 — G3).
 *
 * A safety valve, not cleanup: nothing happens below a real size threshold,
 * deletion is proposal + explicit approval only (the API executes exactly the
 * ids it is handed, after re-verifying each), and export NEVER deletes.
 * Protected, never proposed: tasks referenced by a kind:"task" item in any
 * live/standby thread of any room, iterate-parents of recent rows, and rows
 * still `running`. `.thumbs` dies with its task folder. Ledger rows are
 * STAMPED deleted, not removed — they are the measurement record.
 */

export const TASK_STORE_GC_THRESHOLD_BYTES = 500_000_000;
/** After a full proposed cleanup the store should sit at ~70% of the threshold. */
export const TASK_STORE_GC_TARGET_RATIO = 0.7;
/** Iterate-parents of rows started within this window stay protected. */
export const TASK_STORE_GC_ITERATE_PARENT_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

const TASK_ID_PATTERN = /^[a-zA-Z0-9_-]{1,80}$/;
const ROOM_ID_PATTERN = /^[a-zA-Z0-9_-]{1,160}$/;

export interface TaskStoreGcOptions {
	persistentAgentsRoot?: string;
	artifactsRoot?: string;
	thresholdBytes?: number;
	now?: Date;
}

export interface TaskStoreGcCandidate {
	taskId: string;
	roomId?: string;
	title?: string;
	startedAt?: string;
	bytes: number;
}

export interface TaskStoreGcAssessment {
	totalBytes: number;
	thresholdBytes: number;
	/** Null while the store is below the threshold — the valve stays shut. */
	proposal: { candidates: TaskStoreGcCandidate[]; reclaimBytes: number } | null;
}

function tasksRootPath(options: TaskStoreGcOptions): string {
	return path.join(options.artifactsRoot ?? artifactRoot(), "tasks");
}

function directoryBytes(dir: string): number {
	let total = 0;
	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return 0;
	}
	for (const entry of entries) {
		const file = path.join(dir, entry.name);
		try {
			if (entry.isDirectory()) total += directoryBytes(file);
			else if (entry.isFile()) total += fs.lstatSync(file).size;
		} catch {
			// unreadable entries count as zero
		}
	}
	return total;
}

function listRoomIds(agentsRoot: string): string[] {
	try {
		return fs
			.readdirSync(agentsRoot, { withFileTypes: true })
			.filter((entry) => entry.isDirectory() && ROOM_ID_PATTERN.test(entry.name))
			.map((entry) => entry.name);
	} catch {
		return [];
	}
}

/**
 * Every taskId that must never be deleted: referenced by a task item in a
 * non-closed thread, an iterate-parent of a recent row, or still running.
 * Fail-safe by construction — unreadable thread files protect nothing they
 * name, but a thread whose state is unknown is treated as open.
 */
export function collectProtectedTaskIds(options: TaskStoreGcOptions = {}): Set<string> {
	const agentsRoot = options.persistentAgentsRoot ?? DEFAULT_PERSISTENT_ROOM_AGENTS_ROOT;
	const now = options.now ?? new Date();
	const protectedIds = new Set<string>();
	for (const roomId of listRoomIds(agentsRoot)) {
		const threadsDir = path.join(agentsRoot, roomId, "runtime", "threads");
		let threadFiles: string[] = [];
		try {
			threadFiles = fs.readdirSync(threadsDir).filter((name) => name.endsWith(".json"));
		} catch {
			// no threads dir — nothing to protect here
		}
		for (const name of threadFiles) {
			try {
				const record = JSON.parse(fs.readFileSync(path.join(threadsDir, name), "utf-8"));
				if (record?.state === "closed") continue;
				for (const item of Array.isArray(record?.items) ? record.items : []) {
					if (item?.kind === "task" && typeof item.taskId === "string") protectedIds.add(item.taskId);
				}
			} catch {
				// unreadable thread file protects nothing it names
			}
		}
		for (const row of listTaskLedgerRecords(roomId, { persistentAgentsRoot: agentsRoot })) {
			if (row.outcome === "running") protectedIds.add(row.taskId);
			if (row.iterateParentTaskId && now.getTime() - new Date(row.startedAt).getTime() <= TASK_STORE_GC_ITERATE_PARENT_WINDOW_MS) {
				protectedIds.add(row.iterateParentTaskId);
			}
		}
	}
	return protectedIds;
}

function ledgerRowsByTaskId(options: TaskStoreGcOptions): Map<string, { roomId: string; row: TaskLedgerRecord }> {
	const agentsRoot = options.persistentAgentsRoot ?? DEFAULT_PERSISTENT_ROOM_AGENTS_ROOT;
	const map = new Map<string, { roomId: string; row: TaskLedgerRecord }>();
	for (const roomId of listRoomIds(agentsRoot)) {
		for (const row of listTaskLedgerRecords(roomId, { persistentAgentsRoot: agentsRoot, includeDeleted: true })) {
			map.set(row.taskId, { roomId, row });
		}
	}
	return map;
}

export function assessTaskStoreGc(options: TaskStoreGcOptions = {}): TaskStoreGcAssessment {
	const thresholdBytes = options.thresholdBytes ?? TASK_STORE_GC_THRESHOLD_BYTES;
	const tasksRoot = tasksRootPath(options);
	let taskDirs: fs.Dirent[] = [];
	try {
		taskDirs = fs.readdirSync(tasksRoot, { withFileTypes: true }).filter((entry) => entry.isDirectory() && TASK_ID_PATTERN.test(entry.name));
	} catch {
		return { totalBytes: 0, thresholdBytes, proposal: null };
	}
	const sizes = new Map<string, number>();
	let totalBytes = 0;
	for (const entry of taskDirs) {
		const bytes = directoryBytes(path.join(tasksRoot, entry.name));
		sizes.set(entry.name, bytes);
		totalBytes += bytes;
	}
	if (totalBytes <= thresholdBytes) return { totalBytes, thresholdBytes, proposal: null };

	const protectedIds = collectProtectedTaskIds(options);
	const ledgerIndex = ledgerRowsByTaskId(options);
	const candidates: TaskStoreGcCandidate[] = [];
	for (const entry of taskDirs) {
		if (protectedIds.has(entry.name)) continue;
		const ledgered = ledgerIndex.get(entry.name);
		let startedAt = ledgered?.row.startedAt;
		if (!startedAt) {
			try {
				startedAt = fs.lstatSync(path.join(tasksRoot, entry.name)).mtime.toISOString();
			} catch {
				startedAt = undefined;
			}
		}
		candidates.push({
			taskId: entry.name,
			...(ledgered ? { roomId: ledgered.roomId, title: ledgered.row.title } : {}),
			...(startedAt ? { startedAt } : {}),
			bytes: sizes.get(entry.name) ?? 0,
		});
	}
	candidates.sort((a, b) => ((a.startedAt ?? "") < (b.startedAt ?? "") ? -1 : (a.startedAt ?? "") > (b.startedAt ?? "") ? 1 : 0));
	const targetBytes = thresholdBytes * TASK_STORE_GC_TARGET_RATIO;
	const proposed: TaskStoreGcCandidate[] = [];
	let reclaimBytes = 0;
	for (const candidate of candidates) {
		if (totalBytes - reclaimBytes <= targetBytes) break;
		proposed.push(candidate);
		reclaimBytes += candidate.bytes;
	}
	return { totalBytes, thresholdBytes, proposal: proposed.length > 0 ? { candidates: proposed, reclaimBytes } : null };
}

export interface TaskStoreGcExecutionResult {
	deleted: string[];
	skipped: { taskId: string; reason: "protected" | "invalid" | "missing" }[];
	/** Folders the OS refused to delete (locked/permission) — the batch continues past them. */
	failed: { taskId: string; reason: string }[];
	reclaimedBytes: number;
}

/**
 * Delete exactly the approved ids — each re-verified against a FRESH protected
 * set at execution time, so an approval can never outrun a new reference.
 */
export function executeTaskStoreGc(taskIdsRaw: string[], options: TaskStoreGcOptions = {}): TaskStoreGcExecutionResult {
	const tasksRoot = tasksRootPath(options);
	const protectedIds = collectProtectedTaskIds(options);
	const ledgerIndex = ledgerRowsByTaskId(options);
	const agentsRoot = options.persistentAgentsRoot ?? DEFAULT_PERSISTENT_ROOM_AGENTS_ROOT;
	const result: TaskStoreGcExecutionResult = { deleted: [], skipped: [], failed: [], reclaimedBytes: 0 };
	for (const raw of taskIdsRaw) {
		const taskId = String(raw ?? "").trim();
		if (!TASK_ID_PATTERN.test(taskId)) {
			result.skipped.push({ taskId, reason: "invalid" });
			continue;
		}
		if (protectedIds.has(taskId)) {
			result.skipped.push({ taskId, reason: "protected" });
			continue;
		}
		const dir = path.join(tasksRoot, taskId);
		let stat: fs.Stats;
		try {
			stat = fs.lstatSync(dir);
		} catch {
			result.skipped.push({ taskId, reason: "missing" });
			continue;
		}
		if (!stat.isDirectory()) {
			result.skipped.push({ taskId, reason: "invalid" });
			continue;
		}
		const bytes = directoryBytes(dir);
		// One undeletable folder (locked file, permissions) must not abort the
		// rest of an approved batch — record it and keep going. force:true only
		// papers over ENOENT, not EACCES/EBUSY/EPERM.
		try {
			fs.rmSync(dir, { recursive: true, force: true });
		} catch (error) {
			result.failed.push({ taskId, reason: (error as Error).message });
			continue;
		}
		result.deleted.push(taskId);
		result.reclaimedBytes += bytes;
		const ledgered = ledgerIndex.get(taskId);
		if (ledgered) markTaskLedgerRecordDeleted(ledgered.roomId, taskId, { persistentAgentsRoot: agentsRoot }, options.now ?? new Date());
	}
	return result;
}
