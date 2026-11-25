/**
 * Local usage ledger — one JSONL row per LLM turn, shared by every spend path
 * (room chat, memory upkeep workers, HiveMind, scheduled runs) so the Wallet
 * can account for all of them. Rows are append-only and never rewritten;
 * enrichment fields are optional because historical rows predate them.
 */

import type { MemoryCallKind } from "./memory-call-cache.js";
import fs from "node:fs";
import { AuthStorage } from "@exxeta/exxperts-runtime";
import { serverHooks } from "./server-hooks.js";
import { productAppStatePath, productAppStateRoot } from "../../../pi-package/product-state-paths.js";

export type UsageAuthType = "oauth" | "api_key";
export type UsageKind = "chat" | "upkeep" | "scheduled" | "hivemind" | "cli" | "consult" | "task";

export type UsageCall = Pick<UsageRow, "input" | "output" | "cacheRead">;

export interface UsageRow {
	ts: number;
	agent: string;
	persona: string;
	model?: string;
	modelLabel?: string;
	/** Provider id that served the turn (e.g. "openai-codex"). Absent on older rows. */
	provider?: string;
	/** How the provider was authenticated: subscription OAuth vs pay-per-token API key. */
	authType?: UsageAuthType;
	/** What ran the turn. Absent on rows written before kinds existed (all chat). */
	kind?: UsageKind;
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	/** How many of cacheWrite were one-hour writes, priced higher. Absent on older rows and when none were. */
	cacheWrite1h?: number;
	cost: number;
	tools?: string[];
	/** Background-run id for runs billed via appendUsageOnce. Absent on older rows. */
	runId?: string;
	/** Written without the duplicate check, which could not read the log: the run's rows may hold this one twice. Absent on every other row. */
	unchecked?: true;
	/** The model calls a scheduled row sums, each as its session message holds it, so the start-up import can match them. Absent on other rows and on older rows. */
	calls?: UsageCall[];
	/** Which Memory model call it was (memory-call-cache.ts), so cache settings can be compared. Absent on older rows. */
	callKind?: MemoryCallKind;
	/** On a shared server, who spent and their space, as opaque ids. Absent on the desktop and on older rows. */
	person?: string;
	space?: string;
}

const USAGE_DIR = productAppStateRoot();
const USAGE_FILE = productAppStatePath("usage.jsonl");
const NEWLINE = 0x0a;
// A read holds one chunk and one line at a time, however long the log grows.
const CHUNK_BYTES = 1024 * 1024;
// A row has no size limit when written (a scheduled row carries every call of its run), so a long line is
// read whole, never skipped; one past this is no row we write, and the read fails rather than guess.
const LONGEST_LINE_BYTES = 16 * 1024 * 1024;
// A run is billed again seconds after its first bill (a cut reported twice), or on the desktop when a run
// whose lease ran out gets its room back; about 92,000 rows of 364 bytes. A shared server never retries.
const DUPLICATE_CHECK_BYTES = 32 * 1024 * 1024;

/** The start's operator line when the log could not be read: the session files added nothing. */
export const USAGE_RECONCILE_SKIPPED = "usage reconcile skipped: the usage log could not be read";
/** The operator line for a scheduled run's row written without its duplicate check; the row carries `unchecked` and the run's id. */
export const USAGE_ROW_UNCHECKED = "a scheduled run's usage row was written unchecked: the usage log could not be read";

/** A call that moved no tokens and cost nothing. A failed or stopped one was no turn, so it writes no row. */
export function usageMovedNothing(usage: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; cost?: number }): boolean {
	return !usage.input && !usage.output && !usage.cacheRead && !usage.cacheWrite && !usage.cost;
}

type AssistantCall = { stopReason?: string; content?: unknown; usage?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; cost?: { total?: number } } };

/** A finished answer with nothing in it: no text, no tool call and no output tokens, such as a proxy's HTML page sent with status 200. */
export function emptyAnswer(message: AssistantCall): boolean {
	if (message.stopReason !== "stop" || message.usage?.output) return false;
	const parts = Array.isArray(message.content) ? message.content : [];
	return !parts.some((part: any) => part?.type === "toolCall" || (part?.type === "text" && String(part.text ?? "").trim()));
}

/** A call that brought no answer (failed, stopped or empty) and moved nothing: no row, live or when the start-up import reads the session files. */
export function answerlessCallMovedNothing(message: AssistantCall): boolean {
	const u = message.usage;
	return !!u && (message.stopReason === "error" || message.stopReason === "aborted" || emptyAnswer(message)) && usageMovedNothing({ input: u.input, output: u.output, cacheRead: u.cacheRead, cacheWrite: u.cacheWrite, cost: u.cost?.total });
}

/**
 * What a model call says about whose it is: the person its usage row names, as
 * our own id, from the same lookup appendUsage stamps the row with (or the `who`
 * a call that names no room passes for its row). Nothing when no person is known,
 * as on the desktop.
 */
export function modelCallMetadata(roomId: string, kind: UsageKind, who?: { person: string }): { user_id: string } | undefined {
	const person = who ? who.person : serverHooks().usageOwner?.(roomId, kind)?.person;
	return person ? { user_id: person } : undefined;
}

export function appendUsage(row: UsageRow, warn?: (message: string) => void): void {
	const stamped = row.person ? row : { ...row, ...serverHooks().usageOwner?.(row.agent, row.kind) };
	try {
		fs.mkdirSync(USAGE_DIR, { recursive: true, mode: 0o700 });
		fs.appendFileSync(USAGE_FILE, JSON.stringify(stamped) + "\n", { mode: 0o600 });
	} catch (e) {
		warn?.(`failed to append usage row: ${(e as Error).message}`);
	}
}

/** A kill mid-append leaves a line with no end, and the next row would join it and be lost with it. Runs at the start, before any row is written. */
export function closeTornUsageLine(warn?: (message: string) => void): void {
	try {
		const { size } = fs.statSync(USAGE_FILE);
		if (size === 0) return;
		const fd = fs.openSync(USAGE_FILE, "r");
		const last = Buffer.alloc(1);
		try {
			fs.readSync(fd, last, 0, 1, size - 1);
		} finally {
			fs.closeSync(fd);
		}
		if (last[0] !== NEWLINE) fs.appendFileSync(USAGE_FILE, "\n");
	} catch (e) {
		if ((e as NodeJS.ErrnoException).code !== "ENOENT") warn?.(`failed to close a torn usage line: ${(e as Error).message}`);
	}
}

/**
 * Appends a usage row at most once per (kind, runId): lease recovery can re-execute a background
 * run that crashed after billing, and the retry must never bill the same run's tokens twice. The
 * check reads the log's last DUPLICATE_CHECK_BYTES. When it cannot read them the row is written all
 * the same, marked `unchecked`, and the read's failure is returned for the caller to log.
 */
export function appendUsageOnce(row: UsageRow & { runId: string }, warn?: (message: string) => void): unknown {
	let recorded = false;
	try {
		forEachUsageLine((line) => {
			if (recorded || !line.includes(row.runId)) return;
			try {
				const existing = JSON.parse(line) as UsageRow;
				recorded = existing?.runId === row.runId && existing.kind === row.kind;
			} catch {
				// a damaged line is no row
			}
		}, DUPLICATE_CHECK_BYTES);
	} catch (error) {
		appendUsage({ ...row, unchecked: true }, warn);
		return error;
	}
	if (recorded) {
		warn?.(`usage row already recorded for ${row.kind ?? "unknown"} run ${row.runId}; skipped duplicate append`);
		return undefined;
	}
	appendUsage(row, warn);
	return undefined;
}

/** Cuts the log's bytes into lines, holding one line at a time. With `cut`, drops up to the first line end. */
class UsageLineSplitter {
	private pieces: Buffer[] = [];
	private pieceBytes = 0;
	private cut: boolean;
	private readonly visit: (line: string) => void;
	constructor(cut: boolean, visit: (line: string) => void) {
		this.cut = cut;
		this.visit = visit;
	}

	push(bytes: Buffer): void {
		let start = 0;
		for (let end = bytes.indexOf(NEWLINE); end !== -1; start = end + 1, end = bytes.indexOf(NEWLINE, start)) {
			if (this.cut) this.cut = false;
			else {
				const line = this.pieces.length === 0 ? bytes.toString("utf8", start, end) : Buffer.concat([...this.pieces, bytes.subarray(start, end)]).toString("utf8");
				if (line) this.visit(line);
			}
			this.pieces = [];
			this.pieceBytes = 0;
		}
		if (this.cut || start === bytes.length) return;
		this.pieceBytes += bytes.length - start;
		if (this.pieceBytes > LONGEST_LINE_BYTES) throw Object.assign(new Error(`a usage log line is longer than ${LONGEST_LINE_BYTES} bytes`), { code: "usage_line_too_long" });
		// The chunk is read into again, so the line's piece is copied out.
		this.pieces.push(Buffer.from(bytes.subarray(start)));
	}

	/** The last line, with no line end: a row being appended or a torn one, which fails to parse. */
	end(): void {
		if (!this.cut && this.pieces.length > 0) this.visit(Buffer.concat(this.pieces).toString("utf8"));
	}
}

// A folder or a device in the log's place can open and give no bytes; it is not an empty log.
function notAFile(): Error {
	return Object.assign(new Error("the usage log is not a file"), { code: "usage_log_not_a_file" });
}

/**
 * Gives each line of the usage log, read in fixed chunks so a log of any length is read in bounded
 * memory. With `lastBytes`, only the log's end, less the line cut there. A missing log has no lines.
 * Any other failure throws, a log that is not a file and a line past LONGEST_LINE_BYTES included: a
 * log that cannot be read is never taken for an empty one.
 */
export function forEachUsageLine(visit: (line: string) => void, lastBytes?: number): void {
	let fd: number;
	try {
		fd = fs.openSync(USAGE_FILE, "r");
	} catch (e) {
		if ((e as NodeJS.ErrnoException).code === "ENOENT") return;
		throw e;
	}
	try {
		const stat = fs.fstatSync(fd);
		if (!stat.isFile()) throw notAFile();
		// Bytes appended while this reads are the next read's.
		const size = stat.size;
		let position = lastBytes === undefined ? 0 : Math.max(0, size - lastBytes);
		// From inside the log, start one byte early and drop up to the first line end: what comes before it is
		// the end of a line that starts earlier, or nothing when the byte is itself a line end.
		const cut = position > 0;
		if (cut) position -= 1;
		const splitter = new UsageLineSplitter(cut, visit);
		const chunk = Buffer.alloc(CHUNK_BYTES);
		while (position < size) {
			const read = fs.readSync(fd, chunk, 0, Math.min(CHUNK_BYTES, size - position), position);
			if (read === 0) break;
			position += read;
			splitter.push(chunk.subarray(0, read));
		}
		splitter.end();
	} finally {
		fs.closeSync(fd);
	}
}

/** A line as a row, or nothing for a damaged line (a crash mid-append), which costs that row, never the log. */
function usageRowOf(line: string): UsageRow | undefined {
	let row: UsageRow;
	try {
		row = JSON.parse(line) as UsageRow;
	} catch {
		return undefined;
	}
	return row && typeof row.ts === "number" ? row : undefined;
}

/** Each row of the usage log in file order. Throws as forEachUsageLine does. */
export function forEachUsageRow(visit: (row: UsageRow) => void): void {
	forEachUsageLine((line) => {
		const row = usageRowOf(line);
		if (row) visit(row);
	});
}

/** Every row, oldest first. Throws when the log cannot be read. */
export function loadUsage(): UsageRow[] {
	const rows: UsageRow[] = [];
	forEachUsageRow((row) => rows.push(row));
	// Reconciled historical rows are appended after newer live rows, so
	// consumers get chronological order restored here.
	return rows.sort((a, b) => a.ts - b.ts);
}

/**
 * Best-effort auth classification for a provider at the time a turn is
 * recorded. A stored credential knows its own type; anything else that still
 * works must be an API key from the environment. Never guesses for
 * unconfigured providers.
 */
export function resolveUsageAuthType(provider: string | undefined, providerConfigured: boolean): UsageAuthType | undefined {
	if (!provider) return undefined;
	try {
		const credential = AuthStorage.create().get(provider);
		if (credential?.type === "oauth") return "oauth";
		if (credential?.type === "api_key") return "api_key";
	} catch {
		// Fall through to the configured check below.
	}
	return providerConfigured ? "api_key" : undefined;
}

/**
 * Each row of the usage log in file order, read in chunks without holding the event loop: other
 * requests run between chunks. Throws as forEachUsageLine does; a missing log has no rows.
 */
export async function forEachUsageRowYielding(visit: (row: UsageRow) => void): Promise<void> {
	let file: fs.promises.FileHandle;
	try {
		file = await fs.promises.open(USAGE_FILE, "r");
	} catch (e) {
		if ((e as NodeJS.ErrnoException).code === "ENOENT") return;
		throw e;
	}
	try {
		const stat = await file.stat();
		if (!stat.isFile()) throw notAFile();
		const size = stat.size;
		const splitter = new UsageLineSplitter(false, (line) => {
			const row = usageRowOf(line);
			if (row) visit(row);
		});
		const chunk = Buffer.alloc(CHUNK_BYTES);
		let position = 0;
		while (position < size) {
			const { bytesRead } = await file.read(chunk, 0, Math.min(CHUNK_BYTES, size - position), position);
			if (bytesRead === 0) break;
			position += bytesRead;
			splitter.push(chunk.subarray(0, bytesRead));
		}
		splitter.end();
	} finally {
		await file.close();
	}
}
