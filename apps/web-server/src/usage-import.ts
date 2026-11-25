/**
 * Boot-time reconciliation of turns that spent tokens without reaching the
 * usage ledger: CLI-attach turns (written by a separate process straight into
 * the room's pi-session files) and chat turns that raced a disconnect. The
 * per-thread session files keep each assistant message's usage on disk, so a
 * server start folds whatever the ledger missed back in.
 *
 * Double-count safety: usage.jsonl already has most of these turns (the live
 * websocket logged them, and earlier reconciliations imported the rest), so
 * every session message is first matched against the room's existing rows by
 * its exact (input, output, cacheRead) token triple, consuming one ledger row
 * per match. Only unmatched messages are appended — running this repeatedly
 * is a no-op by construction, and a failed run simply retries next boot.
 *
 * Only the files that changed are read. usage-reconciled.json keeps, for each
 * file reconciled, its size and time and the triples it accounts for; those
 * come off the room's rows, so a changed file matches only what is left, the
 * same answer as reading everything. The record is written last and whole: a
 * kill before it, or a torn or missing record, just means files are read again
 * and match the rows already there. A ledger short of what the record says (a
 * row that could not be written, rows lost) means the room's files are read.
 *
 * A ledger that cannot be read is not an empty one: matched against nothing,
 * every turn on disk would be appended again at every start. The run then
 * appends nothing, keeps the last record and says so.
 */

import fs from "node:fs";
import path from "node:path";
import { productAppStatePath } from "../../../pi-package/product-state-paths.js";
import { answerlessCallMovedNothing, appendUsage, closeTornUsageLine, forEachUsageRow, USAGE_RECONCILE_SKIPPED } from "./usage-log.js";
import type { UsageKind, UsageRow } from "./usage-log.js";

interface ImportSummary {
	rows: number;
	cost: number;
}

/** A session file as it was last reconciled. `triples` counts the ledger rows its messages account for. */
interface ReconciledFile {
	size: number;
	mtimeMs: number;
	triples: Record<string, number>;
}

const RECONCILED_FILE = productAppStatePath("usage-reconciled.json");

function threadKindFromFileName(fileName: string): UsageKind {
	// cli_* threads are CLI-attach turns; c_ / postmem_ / postcp_ are all the
	// room's chat thread (postmem/postcp are its post-memento/post-checkpoint
	// continuations).
	return fileName.startsWith("cli_") ? "cli" : "chat";
}

function matchKey(input: number, output: number, cacheRead: number): string {
	return `${input}|${output}|${cacheRead}`;
}

function isReconciledFile(value: any): value is ReconciledFile {
	return typeof value?.size === "number" && typeof value.mtimeMs === "number" && !!value.triples && typeof value.triples === "object"
		&& Object.values(value.triples).every((count) => Number.isSafeInteger(count) && (count as number) > 0);
}

/** A record that cannot be read is no record: its files are read again. */
function readReconciled(): Map<string, ReconciledFile> {
	try {
		const { files } = JSON.parse(fs.readFileSync(RECONCILED_FILE, "utf-8"));
		return new Map(Object.entries(files).filter((entry): entry is [string, ReconciledFile] => isReconciledFile(entry[1])));
	} catch {
		return new Map();
	}
}

function writeReconciled(files: Map<string, ReconciledFile>, warn: (message: string) => void): void {
	const temporary = `${RECONCILED_FILE}.tmp`;
	try {
		fs.mkdirSync(path.dirname(RECONCILED_FILE), { recursive: true, mode: 0o700 });
		fs.writeFileSync(temporary, JSON.stringify({ files: Object.fromEntries(files) }), { mode: 0o600 });
		fs.renameSync(temporary, RECONCILED_FILE);
	} catch (e) {
		warn(`failed to record the reconciled session files: ${(e as Error).message}`);
	}
}

/** Each room's rows as a multiset of token triples, folded as the log is read. A row that sums several calls counts as those calls, the way the session file holds them. Throws when the log cannot be read. */
function ledgerTriplesByRoom(): Map<string, Map<string, number>> {
	const rooms = new Map<string, Map<string, number>>();
	forEachUsageRow((row) => {
		const triples = rooms.get(row.agent) ?? new Map<string, number>();
		rooms.set(row.agent, triples);
		for (const call of Array.isArray(row.calls) ? row.calls : [row]) {
			const key = matchKey(call.input, call.output, call.cacheRead);
			triples.set(key, (triples.get(key) ?? 0) + 1);
		}
	});
	return rooms;
}

/** The room's triples less what unchanged files account for; null when the ledger no longer holds those, so their files must be read again. */
function triplesLeft(recorded: Map<string, number>, unchanged: ReconciledFile[]): Map<string, number> | null {
	const left = new Map(recorded);
	for (const file of unchanged) {
		for (const [key, count] of Object.entries(file.triples)) {
			const remaining = (left.get(key) ?? 0) - count;
			if (remaining < 0) return null;
			left.set(key, remaining);
		}
	}
	return left;
}

export function importHistoricalSessionUsage(agentsRoot: string, warn: (message: string) => void): ImportSummary | null {
	if (!fs.existsSync(agentsRoot)) return null;

	closeTornUsageLine(warn);
	let ledger: Map<string, Map<string, number>>;
	try {
		ledger = ledgerTriplesByRoom();
	} catch {
		warn(USAGE_RECONCILE_SKIPPED);
		return null;
	}
	const reconciled = readReconciled();
	const nextReconciled = new Map<string, ReconciledFile>();
	const candidates: UsageRow[] = [];

	for (const room of fs.readdirSync(agentsRoot)) {
		const sessionsDir = path.join(agentsRoot, room, "runtime", "pi-sessions");
		let files: string[];
		try {
			files = fs.readdirSync(sessionsDir).filter((f) => f.endsWith(".jsonl"));
		} catch {
			continue;
		}
		// Stat before reading: bytes added meanwhile make the file read as changed next time, never as reconciled.
		const stats = new Map<string, fs.Stats>();
		for (const file of files) {
			try {
				stats.set(file, fs.statSync(path.join(sessionsDir, file)));
			} catch {
				continue;
			}
		}
		const unchanged = new Map<string, ReconciledFile>();
		for (const [file, stat] of stats) {
			const known = reconciled.get(`${room}/${file}`);
			if (known?.size === stat.size && known.mtimeMs === stat.mtimeMs) unchanged.set(file, known);
		}
		const roomRows = ledger.get(room) ?? new Map<string, number>();
		// Multiset of the room's already-recorded token triples; each session
		// message that matches consumes one so repeats stay balanced.
		const left = triplesLeft(roomRows, [...unchanged.values()]);
		const recorded = left ?? roomRows;
		if (left) for (const [file, known] of unchanged) nextReconciled.set(`${room}/${file}`, known);

		for (const [file, stat] of stats) {
			if (left && unchanged.has(file)) continue;
			const kind = threadKindFromFileName(file);
			let lines: string[];
			try {
				lines = fs.readFileSync(path.join(sessionsDir, file), "utf-8").split("\n");
			} catch {
				continue;
			}
			const triples: Record<string, number> = {};
			let provider: string | undefined;
			let modelId: string | undefined;
			for (const line of lines) {
				if (!line) continue;
				let entry: any;
				try {
					entry = JSON.parse(line);
				} catch {
					continue;
				}
				if (entry?.type === "model_change") {
					provider = typeof entry.provider === "string" ? entry.provider : provider;
					modelId = typeof entry.modelId === "string" ? entry.modelId : modelId;
					continue;
				}
				const message = entry?.message;
				const usage = message?.usage;
				if (message?.role !== "assistant" || !usage || answerlessCallMovedNothing(message)) continue;
				const input = usage.input ?? 0;
				const output = usage.output ?? 0;
				const cacheRead = usage.cacheRead ?? 0;
				const key = matchKey(input, output, cacheRead);
				const already = recorded.get(key) ?? 0;
				if (already > 0) {
					recorded.set(key, already - 1);
					triples[key] = (triples[key] ?? 0) + 1;
					continue;
				}
				const ts = Date.parse(entry.timestamp ?? "") || Date.parse(message.timestamp ?? "") || 0;
				if (!ts) continue;
				triples[key] = (triples[key] ?? 0) + 1;
				candidates.push({
					ts,
					agent: room,
					persona: "business",
					model: modelId ?? message.model,
					provider,
					kind,
					input,
					output,
					cacheRead,
					cacheWrite: usage.cacheWrite ?? 0,
					...(usage.cacheWrite1h ? { cacheWrite1h: usage.cacheWrite1h } : {}),
					cost: usage.cost?.total ?? 0,
				});
			}
			nextReconciled.set(`${room}/${file}`, { size: stat.size, mtimeMs: stat.mtimeMs, triples });
		}
	}

	candidates.sort((a, b) => a.ts - b.ts);
	for (const row of candidates) appendUsage(row, warn);
	writeReconciled(nextReconciled, warn);

	return {
		rows: candidates.length,
		cost: candidates.reduce((sum, row) => sum + row.cost, 0),
	};
}
