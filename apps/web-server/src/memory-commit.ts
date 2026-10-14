// One save protocol for a room's memory and its conversations.
//
// A save writes several files: a Remember writes the archive copy, the memory
// file, the fresh conversation, the old one closed, agent.json and an event
// record; a memory write its snapshot, the archive, the memory file, a raised
// limit and a record; a Forget closes the conversation and opens a fresh one.
// A crash between two of them used to leave the room half saved. Now every
// save has ONE commit point and an intent written before anything else:
//
//   1. the intent, `<room>/runtime/commit/<kind>.json`: ids, times, counts and
//      the record the save will write, never a conversation's words;
//   2. the writes before the commit point;
//   3. the commit point itself (the memory file for Remember and a memory
//      write, the old conversation closed for Forget);
//   4. the rest, each step safe to run twice;
//   5. the intent deleted.
//
// `settleCommits` runs before anything reads or changes the room: an intent
// whose commit point landed is finished (rolled forward), one whose commit
// point did not is dropped, and "nothing was saved" is then true. Each kind's
// settler is registered by the module that owns the save, so this module
// imports none of them.
//
// Saves on one room also take turns in this process (`withRoomSaveLock`), so
// a save that waits for something never interleaves with another. Two
// processes cannot hold a room together: the room lock keeps the CLI and the
// web app apart.
//
// The settle takes no lock: it runs from any status read. That is safe only
// because every save is synchronous from writing its intent to clearing it,
// so no request can run in between. A save that ever awaits inside that span
// (a background job, an erase after the record) must take the save lock in
// the settle first, or a status read will finish or drop it mid-flight.

import fs from "node:fs";
import path from "node:path";

export type CommitKind = "remember" | "memory" | "forget";

/** The order a room's pending saves are finished in: memory first, since the others only add a page or close a conversation. */
const KINDS: readonly CommitKind[] = ["memory", "remember", "forget"];

function commitDir(roomDir: string): string {
	return path.join(roomDir, "runtime", "commit");
}

export function commitIntentPath(roomDir: string, kind: CommitKind): string {
	return path.join(commitDir(roomDir), `${kind}.json`);
}

/** Written whole or not at all: a torn intent would be worse than none. */
export function writeCommitIntent(roomDir: string, kind: CommitKind, intent: object): void {
	const file = commitIntentPath(roomDir, kind);
	fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
	const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
	fs.writeFileSync(tmp, JSON.stringify({ version: 1, ...intent }, null, 2) + "\n", { mode: 0o600 });
	fs.renameSync(tmp, file);
}

export function readCommitIntent<T>(roomDir: string, kind: CommitKind): T | null {
	const file = commitIntentPath(roomDir, kind);
	if (!fs.existsSync(file)) return null;
	try {
		const parsed = JSON.parse(fs.readFileSync(file, "utf-8"));
		return parsed && typeof parsed === "object" && parsed.version === 1 ? parsed as T : null;
	} catch {
		return null;
	}
}

export function clearCommitIntent(roomDir: string, kind: CommitKind): void {
	fs.rmSync(commitIntentPath(roomDir, kind), { force: true });
}

/** Finishes or drops one pending save. It must be safe to run twice, and it clears the intent when it is done. */
export type CommitSettler = (agentId: string, roomDir: string, intent: any) => void;

const settlers = new Map<CommitKind, CommitSettler>();

export function registerCommitSettler(kind: CommitKind, settle: CommitSettler): void {
	settlers.set(kind, settle);
}

const settling = new Set<string>();

/**
 * Finishes every save a crash left pending in this room. Cheap when there is
 * none (one existence check). A settler that fails leaves its intent for the
 * next request and logs one line without content; the room stays usable.
 * Re-entrant calls (a settler reading the room's status) return at once.
 */
export function settleCommits(agentId: string, roomDir: string): void {
	if (settling.has(agentId) || !fs.existsSync(commitDir(roomDir))) return;
	settling.add(agentId);
	try {
		for (const kind of KINDS) {
			const intent = readCommitIntent<unknown>(roomDir, kind);
			if (!intent) {
				clearCommitIntent(roomDir, kind);
				continue;
			}
			const settle = settlers.get(kind);
			if (!settle) continue;
			try {
				settle(agentId, roomDir, intent);
			} catch (error) {
				console.error(`[memory-commit] a pending ${kind} save in ${agentId} could not be finished yet: ${(error as Error)?.name ?? "Error"}`);
			}
		}
	} finally {
		settling.delete(agentId);
	}
}

const chains = new Map<string, Promise<unknown>>();

/**
 * Runs one save on a room after the room's previous save has ended, failed or
 * not. Other rooms never wait. The save re-reads the memory file itself, so
 * two saves that arrive together both land, one after the other. The key is
 * the room id trimmed, as validatePersistentAgentId reads it, so a route that
 * passes the raw request id and one that passes the validated id share a lock.
 */
export function withRoomSaveLock<T>(agentIdRaw: string, save: () => T | Promise<T>): Promise<T> {
	const agentId = String(agentIdRaw ?? "").trim();
	const previous = chains.get(agentId) ?? Promise.resolve();
	const run = previous.then(() => save());
	const tail = run.then(() => undefined, () => undefined);
	chains.set(agentId, tail);
	void tail.then(() => {
		if (chains.get(agentId) === tail) chains.delete(agentId);
	});
	return run;
}
