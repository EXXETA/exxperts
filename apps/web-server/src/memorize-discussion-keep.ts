// The Memorize and the Review first read and their discussions, each kept
// with the room until its run starts.
//
// Both used to live only in the page: a reload lost the discussion and paid
// for a new first read, and two tabs opening Memorize at once paid for two.
// Now the first read is kept at `<room>/runtime/memorize-discussion.json` with
// the discussion's turns, so a reload or another tab comes back to them with
// no model call, and a first read already being made is joined, not repeated.
// What is kept holds only for the memory and the Memory model it was read
// from: a changed memory or another model reads again. The run's start
// clears it. Review keeps its own the same way, at
// `<room>/runtime/review-discussion.json`; neither serves the other.

import fs from "node:fs";
import path from "node:path";

interface KeptRead {
	assessmentMarkdown: string;
	source: { l1bFingerprint: { value: string } };
}

/** Which first read: Memorize's or Review's, each in its own file. */
export type KeptReadKind = "memorize" | "review";
type ModelRef = { provider: string; model: string };

export interface KeptDiscussion {
	messages: Array<{ role: string; content: string }>;
	tokenBudget: unknown;
}

const READING = new Map<string, Promise<unknown>>();

function filePath(roomDir: string, kind: KeptReadKind): string {
	return path.join(roomDir, "runtime", `${kind}-discussion.json`);
}

function readFile(roomDir: string, kind: KeptReadKind): { read: KeptRead; model?: ModelRef; discussion?: KeptDiscussion } | null {
	try {
		const kept = JSON.parse(fs.readFileSync(filePath(roomDir, kind), "utf-8"));
		return kept?.read?.source?.l1bFingerprint?.value ? kept : null;
	} catch {
		return null;
	}
}

function writeFile(roomDir: string, kind: KeptReadKind, value: unknown): void {
	try {
		const file = filePath(roomDir, kind);
		const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
		fs.writeFileSync(tmp, `${JSON.stringify(value)}\n`, { mode: 0o600 });
		fs.renameSync(tmp, file);
	} catch {
		// Keeping is a convenience: a failed write costs a new first read, nothing else.
	}
}

/**
 * The first read for this memory and model: the kept one (with its discussion)
 * when it still holds, the one already being made when another tab asked
 * first, else a new one from `read`, kept for the next ask. A Reassess
 * (`fresh`) always reads with its feedback; a later ask joins it, and an
 * older read that ends after it keeps nothing.
 */
export async function firstReadOnce<T extends KeptRead>(roomDir: string, model: ModelRef, fingerprint: string, read: () => Promise<T>, options: { fresh?: boolean; kind?: KeptReadKind } = {}): Promise<T & { keptDiscussion?: KeptDiscussion }> {
	const kind = options.kind ?? "memorize";
	const key = `${roomDir}\u0000${kind}`;
	const kept = options.fresh ? null : readFile(roomDir, kind);
	// The model it was read with: kept beside the read (a Review read names none of its own).
	const keptModel = kept?.model ?? (kept?.read as { process?: { model?: ModelRef } } | undefined)?.process?.model;
	if (kept && keptModel && kept.read.source.l1bFingerprint.value === fingerprint && keptModel.provider === model.provider && keptModel.model === model.model) {
		return { ...(kept.read as T), ...(kept.discussion?.messages.length ? { keptDiscussion: kept.discussion } : {}) };
	}
	const reading = options.fresh ? undefined : READING.get(key) as Promise<T> | undefined;
	if (reading) return reading;
	const fresh: Promise<T> = read().then((result) => {
		// A missing first read is never kept: the next ask tries again.
		if (READING.get(key) === fresh && !(result as { firstReadMissing?: unknown }).firstReadMissing) writeFile(roomDir, kind, { read: result, model: { provider: model.provider, model: model.model } });
		return result;
	});
	READING.set(key, fresh);
	try {
		return await fresh;
	} finally {
		if (READING.get(key) === fresh) READING.delete(key);
	}
}

/** The discussion as it stands after a turn, kept beside the first read it is about. */
export function keepDiscussionTurns(roomDir: string, fingerprint: string, messages: KeptDiscussion["messages"], tokenBudget: unknown, kind: KeptReadKind = "memorize"): void {
	const kept = readFile(roomDir, kind);
	if (!kept || kept.read.source.l1bFingerprint.value !== fingerprint) return;
	writeFile(roomDir, kind, { read: kept.read, ...(kept.model ? { model: kept.model } : {}), discussion: { messages, tokenBudget } });
}

/** The run started (or the person asked for a new first read): nothing is kept. */
export function clearKeptDiscussion(roomDir: string, kind: KeptReadKind = "memorize"): void {
	fs.rmSync(filePath(roomDir, kind), { force: true });
}
