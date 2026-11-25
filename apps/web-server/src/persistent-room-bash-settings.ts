import fs from "node:fs";
import path from "node:path";
import { DEFAULT_PERSISTENT_ROOM_AGENTS_ROOT, PERSISTENT_ROOM_COMMANDS_START_ON_FILE, persistentAgentRootPath, readPersistentRoomDefaultCapabilityPolicy, resolvePersistentRoomEffectiveWorkspacePolicy, storeRoomInOwnFields } from "./persistent-room-workspace-policy.js";
import { parsePersistentRoomProtection, type PersistentRoomProtection, persistentRoomProtected, persistentRoomProtection, type PersistentRoomUnprotectedBy, sameProtection, unprotectedBy } from "./persistent-room-protection.js";
import { roomBoxAvailable } from "./room-box/box-available.js";
import { CHANGE_SAVE_FAILED } from "./room-box/card-text.js";
import { isSharedServer } from "./server-hooks.js";

/**
 * Per-room bash approval preference.
 *
 * `autoApprove`, as read, lets a Full-access room run bash commands without the
 * per-command approval card in the chat. Default off: every command asks
 * until the room explicitly opts out. One deliberate exception, applied once
 * at upgrade: a room that already had bash enabled BEFORE the approval card
 * existed ran commands without asking, so the startup migration grants it
 * autoApprove to preserve its behavior — an explicit write, never a
 * permissive default; a missing or malformed file always reads as ask. The live session guard reads this file on EVERY
 * bash call, so flipping it takes effect on the next command with no rebind;
 * nothing here widens the tool surface itself — whether bash exists at all
 * stays with the workspace policy.
 *
 * A yes holds only in the protection state it was given in
 * (persistent-room-protection.ts): the one given with the room protected comes
 * back whenever it is, and one given without protection is kept with whose it
 * was and dropped the first time the room is seen in another state.
 */
export interface PersistentRoomBashSettings {
	schemaVersion: 1;
	autoApprove: boolean;
	/** Run without asking came by itself, from a new room's default or a commands card's yes: it holds only where the room's protection runs. Never set on a person's own choice. */
	automatic?: true;
	/** The person's own choice that the room's commands and its web reader reach public websites without asking too: the chip's Auto in a protected room. Only while the room is protected. */
	free?: true;
	updatedAt: string;
}

export interface PersistentRoomBashSettingsStorageOptions {
	persistentAgentsRoot?: string;
}

function safeSettingsAgentId(raw: string): string {
	const id = String(raw ?? "").trim();
	if (!/^[a-zA-Z0-9_-]{1,160}$/.test(id)) throw new Error("invalid persistent-room agent id");
	return id;
}

export function persistentRoomBashSettingsPath(agentIdRaw: string, options: PersistentRoomBashSettingsStorageOptions = {}): string {
	const agentId = safeSettingsAgentId(agentIdRaw);
	return path.join(persistentAgentRootPath(agentId, options.persistentAgentsRoot ?? DEFAULT_PERSISTENT_ROOM_AGENTS_ROOT), "runtime", "bash-settings.json");
}

/**
 * Run without asking as stored. `protectedChoice`, kept in `runWithoutAsking`:
 * `yes` is the person's own, `automatic` came by itself (both Semi on the
 * chip), `free` is the person's own with public websites reached without asking
 * too (Auto); each holds only while the room is protected. An app without
 * `free` reads it as `no`, and asks. `unprotectedYes`: a yes given without
 * protection, and whose it was. This version stores `autoApprove` false, the one field an older
 * app reads, so there every command asks. An older app writes `autoApprove` and
 * drops the rest, so its yes is read here, every time, as one from before
 * protection was kept per room (`perProtection` false), and converts at the
 * room's first known state.
 */
type PersistentRoomRunWithoutAsking = "no" | "yes" | "automatic" | "free";

const RUN_WITHOUT_ASKING_VALUES: readonly PersistentRoomRunWithoutAsking[] = ["no", "yes", "automatic", "free"];

interface StoredRunWithoutAsking {
	protectedChoice: PersistentRoomRunWithoutAsking;
	unprotectedYes?: PersistentRoomUnprotectedBy;
	perProtection: boolean;
	updatedAt: string;
	olderApp?: true;
}

const UNPROTECTED_BY: readonly PersistentRoomUnprotectedBy[] = ["person", "computer", "folder"];

function storedRunWithoutAsking(settingsPath: string): StoredRunWithoutAsking {
	const asks: StoredRunWithoutAsking = { protectedChoice: "no", perProtection: true, updatedAt: "" };
	try {
		if (!fs.existsSync(settingsPath)) return asks;
		const raw = JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
		if (!raw || typeof raw !== "object" || raw.schemaVersion !== 1) return asks;
		const updatedAt = typeof raw.updatedAt === "string" ? raw.updatedAt : "";
		// Anything but an explicit yes asks per command: a malformed value must never read as consent to stop asking.
		if (raw.autoApprove === true) return { protectedChoice: raw.automatic === true ? "automatic" : "yes", perProtection: false, updatedAt, olderApp: true };
		const protectedChoice: PersistentRoomRunWithoutAsking = RUN_WITHOUT_ASKING_VALUES.includes(raw.runWithoutAsking) ? raw.runWithoutAsking : "no";
		// An older app's yes written again while the room's state wasn't known keeps its mark, so it still moves once known.
		if (raw.perProtection !== true) return { protectedChoice, perProtection: false, updatedAt, ...(raw.olderApp === true && protectedChoice === "yes" ? { olderApp: true as const } : {}) };
		return { protectedChoice, ...(UNPROTECTED_BY.includes(raw.unprotectedYes) ? { unprotectedYes: raw.unprotectedYes } : {}), perProtection: true, updatedAt };
	} catch {
		return asks;
	}
}

/**
 * What is kept in this state: a yes from before converts (an older app's own
 * yes where the box runs, or that she turned off since, is `free`, since it
 * never asked about a site, but only where the room's commands are on: a room
 * whose commands were off never ran without asking, so its yes is `yes`; where
 * the computer or the folder is why, an unprotected one of that cause), and an
 * unprotected yes of another state is dropped. A state not known yet changes
 * nothing.
 */
function settledFor(stored: StoredRunWithoutAsking, protection: PersistentRoomProtection, commandsOn: () => boolean): StoredRunWithoutAsking {
	if (protection.state === "off" && protection.cause === "unknown") return stored;
	const by = unprotectedBy(protection);
	const { olderApp: _olderApp, unprotectedYes, ...rest } = stored;
	if (!stored.perProtection) {
		if (stored.protectedChoice === "yes" && by !== null && by !== "person") return { ...rest, protectedChoice: "no", unprotectedYes: by, perProtection: true };
		if (stored.protectedChoice === "yes" && stored.olderApp && commandsOn()) return { ...rest, protectedChoice: "free", perProtection: true };
		return { ...rest, perProtection: true };
	}
	return unprotectedYes !== undefined && unprotectedYes === by ? { ...rest, unprotectedYes } : rest;
}

/** Whether the room's commands are on, read only when a yes from before is about to move. */
const commandsOnOf = (agentIdRaw: string, options: PersistentRoomBashSettingsStorageOptions) => () => readPersistentRoomDefaultCapabilityPolicy(agentIdRaw, options)?.bashEnabled === true;

function autoApprovedIn(stored: StoredRunWithoutAsking, protection: PersistentRoomProtection): boolean {
	if (!stored.perProtection) return false;
	if (protection.state === "on") return stored.protectedChoice !== "no";
	return stored.unprotectedYes !== undefined && stored.unprotectedYes === unprotectedBy(protection);
}

function settingsBody(stored: StoredRunWithoutAsking, now: Date): string {
	const kept = stored.perProtection ? { perProtection: true, ...(stored.unprotectedYes ? { unprotectedYes: stored.unprotectedYes } : {}) } : stored.olderApp ? { olderApp: true } : {};
	return JSON.stringify({ schemaVersion: 1, autoApprove: false, runWithoutAsking: stored.protectedChoice, ...kept, updatedAt: now.toISOString() }, null, 2) + "\n";
}

function writeSettingsFile(settingsPath: string, body: string): void {
	fs.mkdirSync(path.dirname(settingsPath), { recursive: true, mode: 0o700 });
	const temporary = `${settingsPath}.${process.pid}.tmp`;
	fs.writeFileSync(temporary, body, { mode: 0o600 });
	fs.renameSync(temporary, settingsPath);
}

const sameStored = (a: StoredRunWithoutAsking, b: StoredRunWithoutAsking) => a.protectedChoice === b.protectedChoice && a.unprotectedYes === b.unprotectedYes && a.perProtection === b.perProtection && a.olderApp === b.olderApp;

/** The room's Run without asking in its protection now, written back when it converted or dropped a yes. */
export function readPersistentRoomBashSettings(agentIdRaw: string, options: PersistentRoomBashSettingsStorageOptions = {}, now = new Date()): PersistentRoomBashSettings {
	return readPersistentRoomBashSettingsIn(agentIdRaw, persistentRoomProtection(agentIdRaw, options), options, now);
}

/**
 * The same read in a given protection, so a computer this one isn't can be
 * judged as the real one is. A shared server reads no stored setting, so there
 * every room answers as one with none, and the file is left as it was.
 */
export function readPersistentRoomBashSettingsIn(agentIdRaw: string, protection: PersistentRoomProtection, options: PersistentRoomBashSettingsStorageOptions = {}, now = new Date()): PersistentRoomBashSettings {
	if (isSharedServer()) return { schemaVersion: 1, autoApprove: false, updatedAt: "" };
	const settingsPath = persistentRoomBashSettingsPath(agentIdRaw, options);
	const stored = storedRunWithoutAsking(settingsPath);
	const kept = settledFor(stored, protection, commandsOnOf(agentIdRaw, options));
	const changed = !sameStored(stored, kept) && fs.existsSync(settingsPath);
	if (changed) writeSettingsFile(settingsPath, settingsBody(kept, now));
	return {
		schemaVersion: 1,
		autoApprove: autoApprovedIn(kept, protection),
		...(kept.protectedChoice === "automatic" ? { automatic: true as const } : {}),
		...(kept.protectedChoice === "free" && protection.state === "on" ? { free: true as const } : {}),
		updatedAt: changed ? now.toISOString() : stored.updatedAt,
	};
}

/**
 * Whether a command of a session bound in `bound` runs without asking: only
 * while the room is still in that state. A message bound just before a Turn
 * on runs its commands with no box, so the protected yes waits for the next.
 * `folder`: the session's conversation's folder, which its state was judged by (persistent-room-protection.ts).
 */
export function commandRunsWithoutAsking(agentIdRaw: string, bound: PersistentRoomProtection, options: PersistentRoomBashSettingsStorageOptions = {}, folder?: string | null): boolean {
	const now = persistentRoomProtection(agentIdRaw, { ...options, folder });
	return sameProtection(now, bound) && readPersistentRoomBashSettingsIn(agentIdRaw, now, options).autoApprove;
}

/**
 * Whether this room's commands and its web reader reach public websites
 * without asking now: `free` stored, the room protected (and still in `bound`,
 * the protection a live answer's session was bound in, where given), its
 * commands on with a folder: where the chip shows the mode. Never on a shared
 * server, which reads no stored mode.
 */
export function roomReachesFreely(agentIdRaw: string, conversationIdRaw: string, bound?: PersistentRoomProtection, folder?: string | null, options: PersistentRoomBashSettingsStorageOptions = {}): boolean {
	if (isSharedServer()) return false;
	const now = persistentRoomProtection(agentIdRaw, { ...options, folder });
	if (now.state !== "on" || (bound !== undefined && !sameProtection(now, bound))) return false;
	if (!resolvePersistentRoomEffectiveWorkspacePolicy(agentIdRaw, conversationIdRaw, options).bashEnabled) return false;
	return readPersistentRoomBashSettingsIn(agentIdRaw, now, options).free === true;
}

/**
 * Whether a room without protection is on Auto now: its commands run whether
 * or not anyone is in the room, and its web reader opens public websites
 * without asking, as before protection existed. Only where its protection is
 * off for a known cause (and still the one in `bound`, where given), its
 * commands are on with a folder and its unprotected yes is for that cause.
 * Never on a shared server. Read at each command and each page, so Ask applies
 * to the next one.
 */
export function unprotectedRoomOnAuto(agentIdRaw: string, conversationIdRaw: string, bound?: PersistentRoomProtection, folder?: string | null, options: PersistentRoomBashSettingsStorageOptions = {}): boolean {
	return unprotectedRoomOnAutoIn(agentIdRaw, conversationIdRaw, persistentRoomProtection(agentIdRaw, { ...options, folder }), bound, options);
}

/** The same read in a given protection, so a computer this one isn't can be judged as the real one is. */
export function unprotectedRoomOnAutoIn(agentIdRaw: string, conversationIdRaw: string, now: PersistentRoomProtection, bound?: PersistentRoomProtection, options: PersistentRoomBashSettingsStorageOptions = {}): boolean {
	if (isSharedServer()) return false;
	if (unprotectedBy(now) === null || (bound !== undefined && !sameProtection(now, bound))) return false;
	if (!resolvePersistentRoomEffectiveWorkspacePolicy(agentIdRaw, conversationIdRaw, options).bashEnabled) return false;
	return readPersistentRoomBashSettingsIn(agentIdRaw, now, options).autoApprove;
}

function protectionChanged(): Error {
	return Object.assign(new Error(CHANGE_SAVE_FAILED), { statusCode: 409, code: "protection_changed" });
}

/**
 * The chip's mode, given in the protection it last read: a write that names
 * none, or another, is refused and stores nothing, so a yes is never kept for
 * a state the person didn't see. `free` goes with `autoApprove` true, and only
 * where the room is protected.
 */
export function writePersistentRoomBashSettings(agentIdRaw: string, input: { autoApprove?: unknown; free?: unknown; protection?: unknown }, options: PersistentRoomBashSettingsStorageOptions = {}, now = new Date()): PersistentRoomBashSettings {
	if (input?.autoApprove !== undefined && typeof input.autoApprove !== "boolean") throw new Error("autoApprove must be a boolean");
	if (input?.free !== undefined && typeof input.free !== "boolean") throw new Error("free must be a boolean");
	if (input.free === true && input.autoApprove !== true) throw new Error("free needs autoApprove");
	const settingsPath = persistentRoomBashSettingsPath(agentIdRaw, options);
	const protection = persistentRoomProtection(agentIdRaw, options);
	const given = parsePersistentRoomProtection(input?.protection);
	if (given === null || !sameProtection(given, protection) || (protection.state === "off" && protection.cause === "unknown")) throw protectionChanged();
	const kept = settledFor(storedRunWithoutAsking(settingsPath), protection, commandsOnOf(agentIdRaw, options));
	const by = unprotectedBy(protection);
	if (input.free === true && by !== null) throw new Error("free needs the room's protection");
	const chosen: StoredRunWithoutAsking = input.autoApprove === undefined ? kept
		: by === null ? { ...kept, protectedChoice: input.free === true ? "free" : input.autoApprove ? "yes" : "no" }
		: { protectedChoice: kept.protectedChoice, ...(input.autoApprove ? { unprotectedYes: by } : {}), perProtection: true, updatedAt: kept.updatedAt };
	writeSettingsFile(settingsPath, settingsBody(chosen, now));
	storeRoomInOwnFields(agentIdRaw, options);
	return readPersistentRoomBashSettings(agentIdRaw, options, now);
}

/** An older app's Run without asking, written again in this version's fields, converted where the room's state is known, so there it asks. Part of `storeRoomInOwnFields`. */
export function storeRunWithoutAskingAsOwn(agentIdRaw: string, options: PersistentRoomBashSettingsStorageOptions = {}, now = new Date()): void {
	const settingsPath = persistentRoomBashSettingsPath(agentIdRaw, options);
	const stored = storedRunWithoutAsking(settingsPath);
	if (stored.olderApp) writeSettingsFile(settingsPath, settingsBody(settledFor(stored, persistentRoomProtection(agentIdRaw, options), commandsOnOf(agentIdRaw, options)), now));
}

const AUTOMATIC: StoredRunWithoutAsking = { protectedChoice: "automatic", perProtection: true, updatedAt: "" };

/**
 * A commands card's yes where the room is protected: Run without asking too,
 * where the room has no choice stored. A stored choice, either one, is kept.
 */
export function grantAutomaticRunWithoutAsking(agentIdRaw: string, options: PersistentRoomBashSettingsStorageOptions = {}, now = new Date()): void {
	if (!persistentRoomProtected(agentIdRaw, options)) return;
	const settingsPath = persistentRoomBashSettingsPath(agentIdRaw, options);
	if (fs.existsSync(settingsPath)) return;
	writeSettingsFile(settingsPath, settingsBody(AUTOMATIC, now));
}

/**
 * The files a new room is made with where its protection runs: its commands
 * start on with its first folder, in Run without asking, both automatic. Paths
 * are relative to the room's folder. Elsewhere a new room starts with commands off.
 */
export function newRoomCommandFiles(now: Date): Array<[string, string]> {
	if (!roomBoxAvailable()) return [];
	return [
		[PERSISTENT_ROOM_COMMANDS_START_ON_FILE, JSON.stringify({ schemaVersion: 1, createdAt: now.toISOString() }, null, 2) + "\n"],
		["runtime/bash-settings.json", settingsBody(AUTOMATIC, now)],
	];
}

const BASH_AUTO_APPROVE_MIGRATION_MARKER = ".bash-auto-approve-defaults-v1";

/**
 * One-time upgrade grant: rooms with bash already enabled before the
 * per-command approval card shipped ran commands without asking, so they keep
 * that behavior via an explicit settings write. Runs once: the marker file is
 * written before any grant, so a failed grant or a stop halfway never runs the
 * step again, where it would grant a room that enabled bash after the upgrade
 * and has no settings file yet. After the grants, the marker is rewritten to
 * name the rooms granted and the rooms whose grant failed, for whoever reads
 * the folder later. A room whose grant fails is logged and keeps asking, the
 * safe direction. A room with a settings file already on disk made
 * an explicit choice and is never touched.
 */
export function migratePersistentRoomBashAutoApproveDefaults(
	agents: ReadonlyArray<{ id: string; bashEnabled: boolean }>,
	options: PersistentRoomBashSettingsStorageOptions = {},
	now = new Date(),
): { migrated: string[]; failed: string[] } {
	return claimPersistentRoomBashAutoApproveDefaults(agents, options, now)?.() ?? { migrated: [], failed: [] };
}

/**
 * The same step in two halves, for a start that must wait before it grants:
 * the rooms are picked and the marker written now, before any request can
 * turn a room's commands on, and the returned grant, given later, grants only
 * those rooms. Null where the step has run before.
 */
export function claimPersistentRoomBashAutoApproveDefaults(
	agents: ReadonlyArray<{ id: string; bashEnabled: boolean }>,
	options: PersistentRoomBashSettingsStorageOptions = {},
	now = new Date(),
): (() => { migrated: string[]; failed: string[] }) | null {
	const root = options.persistentAgentsRoot ?? DEFAULT_PERSISTENT_ROOM_AGENTS_ROOT;
	const markerPath = path.join(root, BASH_AUTO_APPROVE_MIGRATION_MARKER);
	if (fs.existsSync(markerPath)) return null;
	fs.mkdirSync(root, { recursive: true, mode: 0o700 });
	fs.writeFileSync(markerPath, JSON.stringify({ startedAt: now.toISOString() }, null, 2) + "\n", { mode: 0o600 });
	const picked = agents.filter((agent) => agent.bashEnabled === true).map((agent) => agent.id);
	return () => grantPicked(picked, markerPath, options, now);
}

function grantPicked(picked: readonly string[], markerPath: string, options: PersistentRoomBashSettingsStorageOptions, now: Date): { migrated: string[]; failed: string[] } {
	const migrated: string[] = [];
	const failed: string[] = [];
	for (const id of picked) {
		try {
			// A room deleted while the start waited stays deleted: its settings would make its folder again.
			if (!fs.existsSync(persistentAgentRootPath(id, options.persistentAgentsRoot ?? DEFAULT_PERSISTENT_ROOM_AGENTS_ROOT))) continue;
			if (fs.existsSync(persistentRoomBashSettingsPath(id, options))) continue;
			writePersistentRoomBashSettings(id, { autoApprove: true, protection: persistentRoomProtection(id, options) }, options, now);
			migrated.push(id);
		} catch (error) {
			failed.push(id);
			console.warn(`[bash-auto-approve-upgrade] agent=${JSON.stringify(String(id))}: the grant was not written, so the room asks per command: ${(error as Error)?.message ?? String(error)}`);
		}
	}
	// Best effort: the marker already exists, so a failed rewrite still keeps the step from running again.
	try {
		const tempPath = `${markerPath}.tmp`;
		fs.writeFileSync(tempPath, JSON.stringify({ startedAt: now.toISOString(), migrated, failed }, null, 2) + "\n", { mode: 0o600 });
		fs.renameSync(tempPath, markerPath);
	} catch (error) {
		console.warn(`[bash-auto-approve-upgrade] the marker was not updated with the rooms: ${(error as Error)?.message ?? String(error)}`);
	}
	return { migrated, failed };
}
