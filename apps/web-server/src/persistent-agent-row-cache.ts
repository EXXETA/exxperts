import fs from "node:fs";
import { persistentRoomScheduleStorePath } from "../../../pi-package/extensions/schedule-prompt/index.js";
import { createPersistentAgentInstance, getPersistentAgentActiveTurnState, getPersistentAgentRuntimeState, readJson, type PersistentAgentInstance } from "./persistent-agent-store.js";
import type { PersistentAgentListRow } from "./persistent-agent-status.js";
import { getPersistentAgentUnseenLandedAnswer } from "./persistent-agent-turns.js";
import { persistentRoomMaintenanceSettingsPath, readPersistentRoomMaintenanceSettings } from "./persistent-room-maintenance-settings.js";

/**
 * A room list's rows, kept per room and built again only when one of the files
 * a row was built from changed: read only by `listPersistentAgents`, after its
 * viewer filter and its settle. The one-room status and the entry gates never
 * read it. A restart empties it, and the next list reads every room's files
 * again; a second process on the same disk checks the same files.
 */

/** The parts of a row that move with no room file changing: the clock (an interval job's next time) and the last-used estimate another holder keeps. */
export type ListRowReadTimeParts = Pick<PersistentAgentListRow, "scheduleSummary" | "lastUsedAt">;

export const LIST_ROW_CACHE_LIMIT = 10_000;

/**
 * A path's file as a stat saw it, or "absent". The change time is in it so a
 * row built while a file could not be read (it then reads as defaults, such as
 * an idle room) stops matching once the file can be read again: fixing the
 * access changes it. A one-off read error with nothing changed (EMFILE, EIO)
 * is not seen.
 */
type Stamp = string;

type Entry = { row: PersistentAgentListRow; fingerprint: ReadonlyMap<string, Stamp> };

/** In the order they were stored, so the first is the oldest. */
const entries = new Map<string, Entry>();

function stampOf(file: string): Stamp {
	const stat = fs.statSync(file, { throwIfNoEntry: false });
	return stat ? `${stat.mtimeMs}:${stat.size}:${stat.ino}:${stat.ctimeMs}` : "absent";
}

/**
 * Every path a list row of this room is built from, each stamped before any of
 * them is read for the row, so old content never sits under a new stamp. The
 * derived paths come from the room's small files as they stand now: the
 * L1 files' from agent.json, the active conversation's record and transcript
 * from state.json, and a scheduled answer's own conversation from the
 * unseen-answer marker. What the last-used time is read from (the stamp, else
 * the conversations the estimate reads) is not here: that part is read again
 * on every hit. Null when a path cannot be worked out or stamped: no entry then.
 */
type Fingerprint = { stamps: Map<string, Stamp>; l1b: string; transcript: string | null };

function fingerprintOf(instance: PersistentAgentInstance): Fingerprint | null {
	const stamps = new Map<string, Stamp>();
	const stamp = (file: string): Stamp => {
		const value = stampOf(file);
		stamps.set(file, value);
		return value;
	};
	try {
		stamp(instance.rootDir);
		stamp(instance.agentJsonPath());
		stamp(instance.runtimeStatePath());
		const marker = stamp(instance.runtimeUnseenLandedAnswerPath());
		stamp(persistentRoomMaintenanceSettingsPath(instance.agentId));
		stamp(persistentRoomScheduleStorePath(instance.agentId));
		const meta = readJson(instance.agentJsonPath());
		const l1b = instance.l1bCurrentPath(meta);
		for (const file of [instance.l1aPath(meta), l1b, instance.sectionRegistryPath(meta)]) stamp(file);
		const activeThreadId = getPersistentAgentRuntimeState(instance.agentId).activeThreadId;
		let transcript: string | null = null;
		if (activeThreadId) {
			stamp(instance.runtimeThreadPath(activeThreadId));
			transcript = instance.runtimePiSessionPath(activeThreadId);
			stamp(transcript);
		}
		if (marker !== "absent") {
			const unseen = getPersistentAgentUnseenLandedAnswer(instance.agentId);
			if (unseen?.origin === "scheduled-run") stamp(instance.runtimeThreadPath(unseen.threadId));
		}
		return { stamps, l1b, transcript };
	} catch {
		return null;
	}
}

function fingerprintHolds(fingerprint: ReadonlyMap<string, Stamp>): boolean {
	try {
		for (const [file, stamp] of fingerprint) if (stampOf(file) !== stamp) return false;
		return true;
	} catch {
		return false;
	}
}

/** The running state the row's active conversation was described with is still the one in memory. */
function sameRunningState(agentId: string, row: PersistentAgentListRow): boolean {
	const thread = row.activeThread;
	return !thread || JSON.stringify(getPersistentAgentActiveTurnState(agentId, thread.threadId)) === JSON.stringify(thread.activeTurn);
}

/**
 * Whether a freshly described row may be kept. A describe repairs two things
 * as it reads, and both must be done: the unseen-answer marker absent or still
 * reachable (shown in the row), and the memory budget settled (or nothing to
 * settle: an archived room, or one without L1b).
 */
function mayKeep(instance: PersistentAgentInstance, row: PersistentAgentListRow, { stamps, l1b, transcript }: Fingerprint): boolean {
	if (stamps.get(instance.runtimeUnseenLandedAnswerPath()) !== "absent" && !row.unseenLandedAnswer) return false;
	if (!row.archivedAt && stamps.get(l1b) !== "absent" && !readPersistentRoomMaintenanceSettings(instance.agentId).memoryBudgetSettled) return false;
	const runtime = row.activeThread?.runtime;
	if (runtime?.kind === "pi-session-jsonl" && instance.resolveRootRelativePath(runtime.sessionFileRelPath) !== transcript) return false;
	return true;
}

/**
 * A room's list row: the kept one with its read-time parts worked out again
 * when every fingerprinted file and the running state are as it was built
 * with, else `describe`'s, kept when `mayKeep` allows.
 */
export function cachedListRow(agentIdRaw: string, build: { describe: () => PersistentAgentListRow; readTime: () => ListRowReadTimeParts }): PersistentAgentListRow {
	const instance = createPersistentAgentInstance(agentIdRaw);
	const id = instance.agentId;
	const kept = entries.get(id);
	if (kept && fingerprintHolds(kept.fingerprint) && sameRunningState(id, kept.row)) {
		let parts: ListRowReadTimeParts | null = null;
		try {
			parts = build.readTime();
		} catch {
			// A read-time part that fails is described again, warning included.
		}
		if (parts) return { ...kept.row, ...parts };
	}
	const before = fingerprintOf(instance);
	const row = build.describe();
	entries.delete(id);
	if (before && mayKeep(instance, row, before)) {
		entries.set(id, { row, fingerprint: before.stamps });
		for (const oldest of entries.keys()) {
			if (entries.size <= LIST_ROW_CACHE_LIMIT) break;
			entries.delete(oldest);
		}
	}
	return row;
}

/** The paths a room's kept row was fingerprinted on, or null when none is kept: for the smoke's path guard and bound. */
export function cachedListRowPaths(agentIdRaw: string): string[] | null {
	const entry = entries.get(createPersistentAgentInstance(agentIdRaw).agentId);
	return entry ? [...entry.fingerprint.keys()] : null;
}

/** How many rows are kept. */
export function cachedListRowCount(): number {
	return entries.size;
}
