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

/** One request waiting for a first read: the read, and the request's own end on Cancel. */
interface Waiter {
	entry: Reading;
	cancel: AbortController;
}
/** A first read in flight and the requests still waiting for it: only a Cancel, once none waits, aborts it. */
interface Reading {
	key: string;
	promise: Promise<unknown>;
	controller: AbortController;
	waiting: Set<Waiter>;
}
const READING = new Map<string, Reading>();
/** The requests of each ask, by room, kind and the page's id for it. A page whose request was cut asks again under the same id. */
const ASKS = new Map<string, Set<Waiter>>();
/**
 * Asks cancelled before they arrived, kept a minute so a late one starts no read. The ask and its Cancel travel
 * on two connections, so a network that delays the ask (a lost packet on a phone's link) can deliver it last.
 */
const CANCELLED_EARLY = new Map<string, number>();
const CANCELLED_EARLY_MS = 60_000;
let unnamedAsks = 0;

function askKey(roomDir: string, kind: KeptReadKind, ask: string): string {
	return `${roomDir}\u0000${kind}\u0000${ask}`;
}

function cancelledError(): Error {
	return Object.assign(new Error("The first read was cancelled."), { code: "first_read_cancelled" });
}

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
 * older read that ends after it keeps nothing. `ask` is the page's id for this
 * ask, which cancelFirstRead ends. An ask whose request closed (`signal`: a
 * reload, a dropped connection, a proxy's idle limit) stops waiting, but the
 * read goes on and is kept for the next ask.
 */
export async function firstReadOnce<T extends KeptRead>(roomDir: string, model: ModelRef, fingerprint: string, read: (signal: AbortSignal) => Promise<T>, options: { fresh?: boolean; kind?: KeptReadKind; ask?: string; signal?: AbortSignal } = {}): Promise<T & { keptDiscussion?: KeptDiscussion }> {
	const kind = options.kind ?? "memorize";
	const asked = askKey(roomDir, kind, options.ask ?? `unnamed-${++unnamedAsks}`);
	if (CANCELLED_EARLY.delete(asked)) throw cancelledError();
	const key = `${roomDir}\u0000${kind}\u0000${model.provider}\u0000${model.model}`;
	const kept = options.fresh ? null : readFile(roomDir, kind);
	// The model it was read with: kept beside the read (a Review read names none of its own).
	const keptModel = kept?.model ?? (kept?.read as { process?: { model?: ModelRef } } | undefined)?.process?.model;
	if (kept && keptModel && kept.read.source.l1bFingerprint.value === fingerprint && keptModel.provider === model.provider && keptModel.model === model.model) {
		return { ...(kept.read as T), ...(kept.discussion?.messages.length ? { keptDiscussion: kept.discussion } : {}) };
	}
	let reading = options.fresh ? undefined : READING.get(key);
	if (!reading) {
		const controller = new AbortController();
		const entry: Reading = { key, controller, waiting: new Set(), promise: Promise.resolve() };
		entry.promise = read(controller.signal).then((result) => {
			// A missing first read is never kept: the next ask tries again.
			if (READING.get(key) === entry && !(result as { firstReadMissing?: unknown }).firstReadMissing) writeFile(roomDir, kind, { read: result, model: { provider: model.provider, model: model.model } });
			return result;
		}).finally(() => {
			if (READING.get(key) === entry) READING.delete(key);
		});
		// The asks below handle the outcome; an aborted read nobody waits for still settles quietly.
		entry.promise.catch(() => {});
		READING.set(key, entry);
		reading = entry;
	}
	const entry = reading;
	const waiter: Waiter = { entry, cancel: new AbortController() };
	entry.waiting.add(waiter);
	const requests = ASKS.get(asked) ?? new Set<Waiter>();
	ASKS.set(asked, requests.add(waiter));
	const closed = () => { entry.waiting.delete(waiter); };
	if (options.signal?.aborted) closed();
	else options.signal?.addEventListener("abort", closed, { once: true });
	const cancelled = new Promise<never>((_resolve, reject) => waiter.cancel.signal.addEventListener("abort", () => reject(cancelledError()), { once: true }));
	cancelled.catch(() => {});
	try {
		return await Promise.race([entry.promise as Promise<T>, cancelled]);
	} finally {
		options.signal?.removeEventListener("abort", closed);
		entry.waiting.delete(waiter);
		requests.delete(waiter);
		if (requests.size === 0 && ASKS.get(asked) === requests) ASKS.delete(asked);
	}
}

/**
 * The page's Cancel for its ask: every request of that ask stops waiting at
 * once, and once no request waits, the read is aborted, so nothing more is
 * called for it. A Cancel that arrives before its ask is kept a minute.
 * Answers whether the ask waited.
 */
export function cancelFirstRead(roomDir: string, kind: KeptReadKind, ask: string | undefined): boolean {
	if (!ask) return false;
	const asked = askKey(roomDir, kind, ask);
	const requests = ASKS.get(asked);
	if (!requests) {
		const now = Date.now();
		for (const [early, at] of CANCELLED_EARLY) {
			if (now - at <= CANCELLED_EARLY_MS && CANCELLED_EARLY.size < 500) break;
			CANCELLED_EARLY.delete(early);
		}
		CANCELLED_EARLY.set(asked, now);
		return false;
	}
	ASKS.delete(asked);
	for (const waiter of requests) {
		waiter.entry.waiting.delete(waiter);
		waiter.cancel.abort();
		if (waiter.entry.waiting.size > 0) continue;
		waiter.entry.controller.abort();
		if (READING.get(waiter.entry.key) === waiter.entry) READING.delete(waiter.entry.key);
	}
	return true;
}

/** The page's id for one ask, from a request body: a short plain id, else none. */
export function firstReadAsk(body: unknown): string | undefined {
	const ask = (body as { ask?: unknown } | null | undefined)?.ask;
	return typeof ask === "string" && /^[A-Za-z0-9_-]{1,100}$/.test(ask) ? ask : undefined;
}

/** Aborts once the page's request closed before the answer went out: that ask stops waiting, and the read goes on. */
export function askerLeftSignal(response: { once(event: "close", listener: () => void): unknown; writableFinished: boolean }): AbortSignal {
	const controller = new AbortController();
	response.once("close", () => { if (!response.writableFinished) controller.abort(); });
	return controller.signal;
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
