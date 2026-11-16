// Advisory lock so a persistent room can't be actively driven from two places
// at once (e.g. a browser window and a scheduled run), which would clobber the
// shared thread file. It is intentionally best-effort: if the owning side is
// gone, the lock is treated as free so a user can never get permanently locked
// out of a room.
//
// A lock counts while its owner heartbeats `lastSeen` (HOLDER_TTL_MS) and the
// process that holds it lives, so a stop or a kill frees the room for the next
// server at once. Owners differ by surface:
//   - "web": a live connection inside the web-server process, known by its
//            connectionId. It can die with the server still running, so the
//            heartbeat decides then.
//   - "scheduler": background work inside the web-server process, known by a
//            scheduler lockId instead of pid so same-process scheduler jobs
//            cannot overwrite each other's room locks.
// Any other surface (the removed terminal app wrote "cli") is free.

const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { productAppStatePath } = require("./product-state-paths.cjs");

// Resolved per call, not at require time: a process can point its state home
// at the active data profile AFTER requiring this module, and every holder
// must agree on where a room's lock lives.
function lockDir() {
	return productAppStatePath(".room-locks");
}
const HOLDER_TTL_MS = 90_000;
// Tells this process from an earlier one with the same pid, which a container's
// server has after every restart.
const THIS_LIFE = crypto.randomUUID();

function lockPath(agentId) {
	const safe = String(agentId).replace(/[^a-zA-Z0-9_-]+/g, "_");
	return path.join(lockDir(), `${safe}.json`);
}

function readRecord(file) {
	try {
		return JSON.parse(fs.readFileSync(file, "utf8"));
	} catch {
		return null;
	}
}

function readLock(agentId) {
	return readRecord(lockPath(agentId));
}

// A reader must never find the lock empty or half written: it would take that
// for a stale lock and take the room too. So a record is written beside the lock
// and lands in one step. A kill can leave the temporary file, even as a second
// name of the lock, so it is named as persistent-room-last-used.ts names its
// own: a start that checks the data folder takes that shape for the server's
// leftover, and another name stops that start. Nothing is flushed, since after a
// power cut every lock is stale and an empty file reads as stale. Every step is
// synchronous, so a lock is made or removed in one tick.
function landThroughTemporary(file, data, land) {
	const temporary = `${file}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
	try {
		fs.writeFileSync(temporary, data, { mode: 0o600 });
		land(temporary);
	} finally {
		// The clean-up must never replace the failure that matters.
		try { fs.rmSync(temporary, { force: true }); } catch {}
	}
}

// Throws EEXIST when the lock is there: a link, unlike a rename, never replaces.
function createLock(file, data) {
	landThroughTemporary(file, data, (temporary) => {
		try {
			fs.linkSync(temporary, file);
		} catch (e) {
			if (e && e.code === "EEXIST") throw e;
			// A disk with no hard links: the plain exclusive create, which a reader can still catch empty.
			const fd = fs.openSync(file, "wx", 0o600);
			try { fs.writeSync(fd, data); } finally { fs.closeSync(fd); }
		}
	});
}

function replaceLock(file, data) {
	landThroughTemporary(file, data, (temporary) => fs.renameSync(temporary, file));
}

// Takes over the lock judged stale and never one taken since: two racers can
// judge the same stale lock, and the slower must not replace what the faster
// took. So a takeover has a small lock of its own and looks again under it.
// Nothing is ever removed on an earlier judgement, since whatever was judged may
// be someone else's by then. A takeover's lock a kill left is passed, not
// removed: the next racer takes the next number, and only the one that took the
// room removes the numbers below its own, once the stale lock is gone and every
// slower racer's look must fail. A holder is passed when it cannot be at work: it
// is this process, whose calls here never overlap (a container's server has the
// same pid after every restart), or `isActive` calls it gone.
function takeStaleLock(file, judged, data) {
	const taking = (turn) => `${file}.taking-${turn}`;
	const holder = JSON.stringify({ surface: "scheduler", pid: process.pid, host: os.hostname(), lastSeen: Date.now() });
	let turn = 0;
	for (;; turn += 1) {
		try {
			createLock(taking(turn), holder);
			break;
		} catch (e) {
			if (!e || e.code !== "EEXIST") return false;
			const other = readRecord(taking(turn));
			if (other && other.pid !== process.pid && isActive(other)) return false;
		}
	}
	let taken = false;
	try {
		if (JSON.stringify(readRecord(file)) === JSON.stringify(judged)) {
			replaceLock(file, data);
			taken = true;
		}
	} catch {}
	for (let at = taken ? 0 : turn; at <= turn; at += 1) {
		try { fs.rmSync(taking(at), { force: true }); } catch {}
	}
	return taken;
}

function pidAlive(pid) {
	try {
		process.kill(pid, 0);
		return true;
	} catch (e) {
		return Boolean(e) && e.code === "EPERM"; // exists but not signalable
	}
}

function holderGone(lock) {
	// From another host, or with no pid, the heartbeat is the only safe signal we have.
	if (!lock.pid || (lock.host && lock.host !== os.hostname())) return false;
	// A record with no life was written before locks had one: its pid is all there is.
	if (lock.life && lock.pid === process.pid) return lock.life !== THIS_LIFE;
	return !pidAlive(lock.pid);
}

function isActive(lock) {
	if (!lock || (lock.surface !== "web" && lock.surface !== "scheduler")) return false;
	return (Date.now() - Number(lock.lastSeen || 0)) < HOLDER_TTL_MS && !holderGone(lock);
}

function sameOwner(a, b) {
	if (!a || !b || a.surface !== b.surface) return false;
	if (a.surface === "web") return a.connectionId === b.connectionId;
	if (a.surface === "scheduler") {
		const aLockId = typeof a.lockId === "string" ? a.lockId : "";
		const bLockId = typeof b.lockId === "string" ? b.lockId : "";
		return !!aLockId && aLockId === bLockId;
	}
	return false;
}

// Whether `owner` may take over an existing lock. Same owner = refresh. Two web
// connections share one local server process, and a reconnect (memento restart,
// navigation, network blip) gets a new connectionId while the old lock lingers —
// treating web-over-web as a takeover avoids a false "open in another browser
// session" block. A scheduled run against web, or another scheduled run, still
// blocks, since those can actually clobber the thread file.
function canTakeOver(existing, owner) {
	if (sameOwner(existing, owner)) return true;
	return existing.surface === "web" && owner.surface === "web";
}

// owner: { surface: "web" | "scheduler", pid?, connectionId?, lockId?, runId?, label? }
// Acquisition is atomic: the lock lands whole by an exclusive link, so if two
// sessions race only one create succeeds. The loser reads the winner's record and
// either refuses (held by another active owner) or, if the existing lock is ours
// or stale, takes it over.
function tryAcquire(agentId, owner) {
	fs.mkdirSync(lockDir(), { recursive: true, mode: 0o700 });
	const file = lockPath(agentId);
	const now = Date.now();
	const record = {
		surface: owner.surface,
		pid: owner.pid || process.pid,
		connectionId: owner.connectionId || null,
		lockId: owner.lockId ? String(owner.lockId) : null,
		runId: owner.runId ? String(owner.runId) : null,
		host: os.hostname(),
		life: THIS_LIFE,
		label: owner.label || null,
		acquiredAt: now,
		lastSeen: now,
	};
	const data = JSON.stringify(record);
	for (let attempt = 0; attempt < 3; attempt++) {
		try {
			createLock(file, data);
			return { ok: true, record };
		} catch (e) {
			if (!e || e.code !== "EEXIST") {
				return { ok: false, heldBy: readLock(agentId) }; // unexpected fs error: don't claim the lock
			}
			const existing = readLock(agentId);
			if (existing && canTakeOver(existing, owner)) {
				try {
					replaceLock(file, data); // refresh / web reconnect takeover
				} catch {
					// Our own whole lock is still ours; a takeover that landed nothing owns nothing.
					if (!sameOwner(existing, owner)) return { ok: false, heldBy: existing };
				}
				return { ok: true, record };
			}
			if (existing && isActive(existing)) {
				return { ok: false, heldBy: existing }; // genuinely held by someone else
			}
			if (takeStaleLock(file, existing, data)) return { ok: true, record }; // stale/unreadable
		}
	}
	return { ok: false, heldBy: readLock(agentId) };
}

function heartbeat(agentId, owner) {
	const existing = readLock(agentId);
	if (existing && sameOwner(existing, owner)) {
		existing.lastSeen = Date.now();
		try {
			replaceLock(lockPath(agentId), JSON.stringify(existing));
		} catch {}
	}
}

function release(agentId, owner) {
	const existing = readLock(agentId);
	if (existing && sameOwner(existing, owner)) {
		try {
			fs.unlinkSync(lockPath(agentId));
		} catch {}
	}
}

module.exports = { tryAcquire, heartbeat, release, readLock, isActive };
