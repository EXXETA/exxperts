// How often a room's memory rows were actually used, kept OUTSIDE the memory
// file.
//
// A recall that returned a note is the one observable sign that the note is
// worth keeping. That count lives in a per-room sidecar, never in
// `L1b/current.md`: every write to the memory file is snapshotted, fingerprinted
// by undo and rebased by a Memorize, and a chat turn must not write memory. Use
// is use: an undo of a Memorize does not roll it back.
//
// The write is cheap on purpose and never in the way of a turn. A recall
// records what it showed into a per-room buffer; the first record starts a
// short timer, later ones within it merge, and the timer writes once. The
// buffer is merged into whatever the file holds — hits add up, the later day
// wins — and the file is cut to a cap from its least recently used end. A file
// that cannot be read reads as no use and a write that fails is dropped: a
// counter is the one thing in this room that is allowed to be lost.

import fs from "node:fs";
import path from "node:path";
import { DEFAULT_PERSISTENT_ROOM_AGENTS_ROOT, persistentAgentRootPath } from "./persistent-room-workspace-policy.js";

export interface MemoryUseRow {
	/** How many recalls returned this row. */
	hits: number;
	/** YYYY-MM-DD of the last recall that returned it. */
	last: string;
}

export interface MemoryUse {
	/** By note id, e.g. "m-0031". */
	notes: Record<string, MemoryUseRow>;
	/** By archive row id, e.g. "m-0012-v1" or "m-0012". */
	archive: Record<string, MemoryUseRow>;
}

export interface MemoryUseStorageOptions {
	persistentAgentsRoot?: string;
}

/** The sidecar's file name under the room's `runtime/` directory. */
export const MEMORY_USE_FILE = "memory-use.json";
/** At most this many ids are kept; beyond it the least recently used go first on write. */
export const MEMORY_USE_MAX_IDS = 5_000;

export function emptyMemoryUse(): MemoryUse {
	return { notes: {}, archive: {} };
}

/** How long a room's records are held for before one write takes them all. */
const MEMORY_USE_WRITE_DELAY_MS = 200;
const MEMORY_USE_SCHEMA_VERSION = 1;

type MemoryUseSource = "note" | "archive";
const MEMORY_USE_SOURCES: readonly MemoryUseSource[] = ["note", "archive"];

/** The file as it is on disk: the two maps under a version and a stamp. */
interface MemoryUseFile extends MemoryUse {
	schemaVersion: typeof MEMORY_USE_SCHEMA_VERSION;
	updatedAt: string;
}

/** The records a room has not written yet, and the timer that will write them. */
interface PendingMemoryUse {
	agentId: string;
	persistentAgentsRoot: string | undefined;
	rows: MemoryUse;
	timer: ReturnType<typeof setTimeout> | null;
}

const PENDING = new Map<string, PendingMemoryUse>();
let exitFlushRegistered = false;

// The same id rule the room's other runtime sidecars apply, so an id that
// cannot name a directory can never name a file outside the room either.
function safeMemoryUseAgentId(raw: string): string {
	const id = String(raw ?? "").trim();
	if (!/^[a-zA-Z0-9_-]{1,160}$/.test(id)) throw new Error("invalid persistent-room agent id");
	return id;
}

export function memoryUsePath(agentIdRaw: string, options: MemoryUseStorageOptions = {}): string {
	const agentId = safeMemoryUseAgentId(agentIdRaw);
	return path.join(persistentAgentRootPath(agentId, options.persistentAgentsRoot ?? DEFAULT_PERSISTENT_ROOM_AGENTS_ROOT), "runtime", MEMORY_USE_FILE);
}

// The day a recall is counted on, in the spelling every saved date in the
// memory file uses (`toISOString().slice(0, 10)`, the store's own isoDay), so
// a row's `last` and its `saved` sit on one calendar.
function dayOf(date: Date): string {
	return date.toISOString().slice(0, 10);
}

function isDay(value: unknown): value is string {
	return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function isHits(value: unknown): value is number {
	return typeof value === "number" && Number.isInteger(value) && value >= 1;
}

/** One map off the disk, keeping only the rows that are rows. */
function readRows(value: unknown): Record<string, MemoryUseRow> {
	const rows: Record<string, MemoryUseRow> = {};
	if (!value || typeof value !== "object" || Array.isArray(value)) return rows;
	for (const [id, row] of Object.entries(value as Record<string, unknown>)) {
		if (!row || typeof row !== "object") continue;
		const { hits, last } = row as { hits?: unknown; last?: unknown };
		if (!isHits(hits) || !isDay(last)) continue;
		rows[id] = { hits, last };
	}
	return rows;
}

function parseMemoryUse(raw: string): MemoryUse {
	const parsed = JSON.parse(raw) as { schemaVersion?: unknown; notes?: unknown; archive?: unknown } | null;
	if (!parsed || typeof parsed !== "object" || parsed.schemaVersion !== MEMORY_USE_SCHEMA_VERSION) return emptyMemoryUse();
	return { notes: readRows(parsed.notes), archive: readRows(parsed.archive) };
}

/** Never throws: an absent, unreadable or malformed sidecar reads as no use. */
export function readMemoryUse(agentIdRaw: string, options: MemoryUseStorageOptions = {}): MemoryUse {
	try {
		return readMemoryUseFile(memoryUsePath(agentIdRaw, options));
	} catch {
		return emptyMemoryUse();
	}
}

function readMemoryUseFile(file: string): MemoryUse {
	try {
		if (!fs.existsSync(file)) return emptyMemoryUse();
		return parseMemoryUse(fs.readFileSync(file, "utf-8"));
	} catch {
		return emptyMemoryUse();
	}
}

function mapOf(use: MemoryUse, source: MemoryUseSource): Record<string, MemoryUseRow> {
	return source === "note" ? use.notes : use.archive;
}

/** One more hit for an id, on the later of its day and this one. */
function countInto(rows: Record<string, MemoryUseRow>, id: string, hits: number, day: string): void {
	const current = rows[id];
	rows[id] = current ? { hits: current.hits + hits, last: current.last > day ? current.last : day } : { hits, last: day };
}

/**
 * Records that a recall returned these rows. Coalesced: several calls for one
 * room in quick succession produce one write. Never throws.
 */
export function recordMemoryUse(
	agentIdRaw: string,
	rows: ReadonlyArray<{ id: string; source: "note" | "archive" }>,
	options: MemoryUseStorageOptions & { now?: Date } = {},
): void {
	try {
		const agentId = safeMemoryUseAgentId(agentIdRaw);
		const day = dayOf(options.now ?? new Date());
		// A conversation row, or anything else that is not a note or an archive
		// row, is not counted: the caller filters, and this is the second lock.
		const counted = rows.filter((row) => MEMORY_USE_SOURCES.includes(row.source) && typeof row.id === "string" && row.id.trim().length > 0);
		if (counted.length === 0) return;
		const key = pendingKey(agentId, options.persistentAgentsRoot);
		let pending = PENDING.get(key);
		if (!pending) {
			pending = { agentId, persistentAgentsRoot: options.persistentAgentsRoot, rows: emptyMemoryUse(), timer: null };
			PENDING.set(key, pending);
		}
		for (const row of counted) countInto(mapOf(pending.rows, row.source), row.id.trim(), 1, day);
		if (!pending.timer) {
			const timer = setTimeout(() => writePending(key), MEMORY_USE_WRITE_DELAY_MS);
			// The write is a courtesy to the next ranking, never a reason to keep
			// the process alive.
			timer.unref?.();
			pending.timer = timer;
		}
		registerExitFlush();
	} catch {
		// A counter that could not be recorded is a counter that stays where it was.
	}
}

function pendingKey(agentId: string, persistentAgentsRoot: string | undefined): string {
	return `${persistentAgentsRoot ?? ""}\n${agentId}`;
}

function registerExitFlush(): void {
	if (exitFlushRegistered) return;
	exitFlushRegistered = true;
	process.once("exit", () => {
		flushMemoryUse();
	});
}

/** Writes whatever is pending for the room (or for every room) now. For shutdown and tests. */
export function flushMemoryUse(agentIdRaw?: string): void {
	try {
		if (agentIdRaw === undefined) {
			for (const key of [...PENDING.keys()]) writePending(key);
			return;
		}
		const agentId = safeMemoryUseAgentId(agentIdRaw);
		for (const [key, pending] of [...PENDING.entries()]) {
			if (pending.agentId === agentId) writePending(key);
		}
	} catch {
		// Nothing pending for an id that is not one; nothing to write.
	}
}

/** Takes a room's buffer out of the map and writes it. Never throws. */
function writePending(key: string): void {
	const pending = PENDING.get(key);
	if (!pending) return;
	PENDING.delete(key);
	if (pending.timer) clearTimeout(pending.timer);
	try {
		const file = memoryUsePath(pending.agentId, { persistentAgentsRoot: pending.persistentAgentsRoot });
		const merged = readMemoryUseFile(file);
		for (const source of MEMORY_USE_SOURCES) {
			const target = mapOf(merged, source);
			for (const [id, row] of Object.entries(mapOf(pending.rows, source))) countInto(target, id, row.hits, row.last);
		}
		trimToCap(merged);
		writeMemoryUseFile(file, { schemaVersion: MEMORY_USE_SCHEMA_VERSION, updatedAt: new Date().toISOString(), notes: merged.notes, archive: merged.archive });
	} catch {
		// A chat turn must never fail because a counter could not be written;
		// the records in this buffer are lost, and the next recall counts again.
	}
}

/**
 * Cuts the file to the cap from its least recently used end: the oldest day
 * first, and among one day the fewest hits. An id that was recorded always has
 * at least one hit, so "zero-hit" is not a class of its own here — the least
 * used of the least recent is simply the first to go.
 */
function trimToCap(use: MemoryUse): void {
	const total = Object.keys(use.notes).length + Object.keys(use.archive).length;
	if (total <= MEMORY_USE_MAX_IDS) return;
	const ranked: { source: MemoryUseSource; id: string; row: MemoryUseRow }[] = [];
	for (const source of MEMORY_USE_SOURCES) {
		for (const [id, row] of Object.entries(mapOf(use, source))) ranked.push({ source, id, row });
	}
	ranked.sort((a, b) => (a.row.last < b.row.last ? -1 : a.row.last > b.row.last ? 1 : a.row.hits - b.row.hits));
	for (const dropped of ranked.slice(0, total - MEMORY_USE_MAX_IDS)) delete mapOf(use, dropped.source)[dropped.id];
}

/** The house pattern: a temp file beside the target, then one rename. */
function writeMemoryUseFile(file: string, content: MemoryUseFile): void {
	fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
	const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
	try {
		fs.writeFileSync(tmp, JSON.stringify(content, null, 2) + "\n", { mode: 0o600 });
		fs.renameSync(tmp, file);
	} catch (error) {
		// A half-written temp file is not left beside the sidecar.
		try {
			fs.rmSync(tmp, { force: true });
		} catch {
			// The directory was the problem; there is nothing to remove.
		}
		throw error;
	}
}
