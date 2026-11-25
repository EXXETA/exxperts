// The lock on auth.json and settings.json, which a killed holder cannot block.
//
// proper-lockfile tells a dead holder from a live one by the lock's age alone,
// so a lock a kill left refuses everyone for its stale time: ten seconds on the
// sync path, where each refusal reads as "no key" or "no settings". Here the lock
// names its holder, and a contender that can prove the holder dead clears it at
// once. proper-lockfile keeps the rest: the waits, the refresh of a held lock's
// time, and the stale rule, which still decides for any holder this computer
// cannot judge and for a live one that stopped refreshing. A holder that stays
// inside the rule keeps its lock, so one that holds it across a slow call has to
// refresh its time well inside the ten seconds.
//
// The lock is a file, not proper-lockfile's folder, so it is there with its owner
// in one step: the note is written first and hard-linked into place. A kill can
// then never leave a lock with no name on it. A kill can leave the note beside
// the lock, two names for one file, so the note is named as
// persistent-room-last-used.ts names its temporary files, the shape a start that
// checks the data folder takes for the server's own leftover: another name stops
// that start. Taking and giving back go through
// the `fs` handed to proper-lockfile, whose `mkdir` and `rmdir` are the only calls
// that make and remove the lock; stat and utimes work on a file as on a folder.

import { randomUUID } from "node:crypto";
import fs from "node:fs";
import { hostname } from "node:os";
import lockfile from "proper-lockfile";

const SYNC_TRIES = 10;
const SYNC_PAUSE_MS = 20;

/** This process, among any that reused its pid: a container's server has the same small pid after every restart. */
const RUN = randomUUID();

/** `note` is the lock's second name while it lands, so a clearer can remove what a kill left. */
type LockOwner = { pid: number; host: string; run: string; note: string };

/**
 * The note's name, built by `newNote` alone. It holds no separator and no dot,
 * so it names a file beside the lock and nowhere else. A writer outside this
 * shape fails safe, its dead locks waiting for the stale rule, and
 * restart-lock-rows-smoke.ts fails on that wait.
 */
const NOTE_SHAPE = /^tmp-\d+-\d+-[a-z0-9]{0,6}$/;

function newNote(): string {
	return `tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * The lock's owner, or nothing when it names none: a folder left by an older
 * version, a lock already gone, or a note `newNote` never makes, since a room
 * can carry a lock file someone else wrote. A lock with no owner waits for the
 * stale rule, which removes the lock alone.
 */
function readOwner(lockPath: string): LockOwner | undefined {
	try {
		const owner = JSON.parse(fs.readFileSync(lockPath, "utf-8")) as Partial<LockOwner>;
		return typeof owner.pid === "number" &&
			typeof owner.host === "string" &&
			typeof owner.run === "string" &&
			typeof owner.note === "string" &&
			NOTE_SHAPE.test(owner.note)
			? (owner as LockOwner)
			: undefined;
	} catch {
		return undefined;
	}
}

/** True only on proof. Another computer's pids mean nothing here, and a pid that answers may be a stranger's, so both stay with the stale rule. */
function ownerIsDead(owner: LockOwner): boolean {
	if (owner.host !== hostname()) return false;
	if (owner.pid === process.pid) return owner.run !== RUN;
	try {
		process.kill(owner.pid, 0);
		return false;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "ESRCH";
	}
}

function notePath(lockPath: string, note: string): string {
	return `${lockPath}.${note}`;
}

/**
 * Removes a dead owner's lock, and says whether it did. Two contenders can judge
 * the same dead lock, and the slower one must not remove what the faster one took
 * since, so clearing has a lock of its own and looks again under it: only a
 * clearer removes a dead owner's lock, so what it reads there stays until it does.
 */
function clearDeadOwner(lockPath: string): boolean {
	const owner = readOwner(lockPath);
	if (!owner || !ownerIsDead(owner)) return false;
	let release: () => void;
	try {
		release = lockfile.lockSync(lockPath, { realpath: false, fs: ownedLockFs });
	} catch {
		return false;
	}
	try {
		if (readOwner(lockPath)?.run !== owner.run) return false;
		// The note first: a kill between the two leaves the dead owner's lock for the next clearer, never a note nobody finds.
		fs.rmSync(notePath(lockPath, owner.note), { force: true });
		fs.rmSync(lockPath, { force: true });
		return true;
	} finally {
		release();
	}
}

function landLock(lockPath: string): void {
	const name = newNote();
	const note = notePath(lockPath, name);
	const owner: LockOwner = { pid: process.pid, host: hostname(), run: RUN, note: name };
	fs.writeFileSync(note, JSON.stringify(owner), { mode: 0o600 });
	try {
		fs.linkSync(note, lockPath);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "EEXIST") throw error;
		// A disk with no hard links: the plain folder, which names no owner.
		fs.mkdirSync(lockPath);
	} finally {
		fs.rmSync(note, { force: true });
	}
}

function takeLock(lockPath: string): void {
	try {
		landLock(lockPath);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST" || !clearDeadOwner(lockPath)) throw error;
		landLock(lockPath);
	}
}

function giveBackLock(lockPath: string): void {
	fs.rmSync(lockPath, { recursive: true, force: true });
}

function asCallback(work: (lockPath: string) => void) {
	return (lockPath: string, done: (error?: unknown) => void): void => {
		try {
			work(lockPath);
		} catch (error) {
			done(error);
			return;
		}
		done();
	};
}

/** What proper-lockfile takes as its `fs` option. */
export const ownedLockFs: Record<string, unknown> = {
	...fs,
	mkdir: asCallback(takeLock),
	mkdirSync: takeLock,
	rmdir: asCallback(giveBackLock),
	rmdirSync: giveBackLock,
};

/** The sync path: a short wait for a live holder, without changing callers to async. */
export function acquireLockSyncWithRetry(path: string): () => void {
	for (let attempt = 1; ; attempt++) {
		try {
			return lockfile.lockSync(path, { realpath: false, fs: ownedLockFs });
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ELOCKED" || attempt === SYNC_TRIES) throw error;
			Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, SYNC_PAUSE_MS);
		}
	}
}
