// Advisory lock so a persistent room can't be actively driven from two places
// at once (e.g. the web UI and the CLI), which would clobber the shared thread
// file. It is intentionally best-effort: if the owning side is gone, the lock
// is treated as free so a user can never get permanently locked out of a room.
//
// Staleness differs by surface, on purpose:
//   - "cli": the owner is a real process; the lock is valid while that pid is
//            alive on this host (the CLI launcher blocks on the room session,
//            so it cannot heartbeat).
//   - "web": the owner is the long-lived web-server process, so pid-liveness is
//            meaningless. The live connection heartbeats `lastSeen`; the lock
//            is valid only while that stays fresh (WEB_TTL_MS).
//   - "scheduler": the owner is background work inside the web-server process.
//            It must heartbeat like web, but owner identity is a scheduler lockId
//            instead of pid so same-process scheduler jobs cannot overwrite each
//            other's room locks.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { productAppStatePath } = require("./product-state-paths.cjs");

// Resolved per call, not at require time: the CLI launcher points HOME at
// the active data profile AFTER requiring this module, and web and CLI must
// agree on where a room's lock lives.
function lockDir() {
	return productAppStatePath(".room-locks");
}
const WEB_TTL_MS = 90_000;
const SCHEDULER_TTL_MS = 90_000;

function lockPath(agentId) {
	const safe = String(agentId).replace(/[^a-zA-Z0-9_-]+/g, "_");
	return path.join(lockDir(), `${safe}.json`);
}

function readLock(agentId) {
	try {
		return JSON.parse(fs.readFileSync(lockPath(agentId), "utf8"));
	} catch {
		return null;
	}
}

function pidAlive(pid, host) {
	if (host && host !== os.hostname()) return false; // can't verify another machine
	if (!pid) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (e) {
		return Boolean(e) && e.code === "EPERM"; // exists but not signalable
	}
}

function isActive(lock) {
	if (!lock) return false;
	if (lock.surface === "web") return (Date.now() - Number(lock.lastSeen || 0)) < WEB_TTL_MS;
	if (lock.surface === "scheduler") {
		if ((Date.now() - Number(lock.lastSeen || 0)) >= SCHEDULER_TTL_MS) return false;
		// If the lock came from another host, TTL is the only safe signal we have.
		if (lock.host && lock.host !== os.hostname()) return true;
		return !lock.pid || pidAlive(lock.pid, lock.host);
	}
	return pidAlive(lock.pid, lock.host);
}

function sameOwner(a, b) {
	if (!a || !b || a.surface !== b.surface) return false;
	if (a.surface === "web") return a.connectionId === b.connectionId;
	if (a.surface === "scheduler") {
		const aLockId = typeof a.lockId === "string" ? a.lockId : "";
		const bLockId = typeof b.lockId === "string" ? b.lockId : "";
		return !!aLockId && aLockId === bLockId;
	}
	return a.pid === b.pid;
}

// Whether `owner` may take over an existing lock. Same owner = refresh. Two web
// connections share one local server process, and a reconnect (memento restart,
// navigation, network blip) gets a new connectionId while the old lock lingers —
// treating web-over-web as a takeover avoids a false "open in another browser
// session" block. Cross-surface (CLI vs web) and CLI-vs-CLI still block, since
// those are separate processes that can actually clobber the thread file.
function canTakeOver(existing, owner) {
	if (sameOwner(existing, owner)) return true;
	return existing.surface === "web" && owner.surface === "web";
}

// owner: { surface: "cli" | "web" | "scheduler", pid?, connectionId?, lockId?, runId?, label? }
// Acquisition is atomic: the lock file is created with the exclusive "wx" flag,
// so if two sessions race only one create succeeds. The loser reads the winner's
// record and either refuses (held by another active owner) or, if the existing
// lock is ours or stale, takes it over.
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
		label: owner.label || null,
		acquiredAt: now,
		lastSeen: now,
	};
	const data = JSON.stringify(record);
	for (let attempt = 0; attempt < 3; attempt++) {
		try {
			const fd = fs.openSync(file, "wx", 0o600); // atomic create-if-absent
			try { fs.writeSync(fd, data); } finally { fs.closeSync(fd); }
			return { ok: true, record };
		} catch (e) {
			if (!e || e.code !== "EEXIST") {
				return { ok: false, heldBy: readLock(agentId) }; // unexpected fs error: don't claim the lock
			}
			const existing = readLock(agentId);
			if (existing && canTakeOver(existing, owner)) {
				try { fs.writeFileSync(file, data, { mode: 0o600 }); } catch {} // refresh / web reconnect takeover
				return { ok: true, record };
			}
			if (existing && isActive(existing)) {
				return { ok: false, heldBy: existing }; // genuinely held by someone else
			}
			try { fs.unlinkSync(file); } catch {} // stale/unreadable — drop it and retry the atomic create
		}
	}
	return { ok: false, heldBy: readLock(agentId) };
}

function heartbeat(agentId, owner) {
	const existing = readLock(agentId);
	if (existing && sameOwner(existing, owner)) {
		existing.lastSeen = Date.now();
		try {
			fs.writeFileSync(lockPath(agentId), JSON.stringify(existing), { mode: 0o600 });
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
