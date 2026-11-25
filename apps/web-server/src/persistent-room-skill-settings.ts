import fs from "node:fs";
import path from "node:path";
import { DEFAULT_PERSISTENT_ROOM_AGENTS_ROOT, persistentAgentRootPath } from "./persistent-room-workspace-policy.js";
import { SKILL_IDENTITY_RE } from "./skills-store.js";

/**
 * Per-room skill enablement (skills MR-2, spec §4/§7 must 2). Clones the
 * `persistent-room-maintenance-settings.ts` shape: a per-room JSON file with a
 * schemaVersion, per-field merge/sanitize on read, 0o600 perms, and a
 * fallback-to-empty on a corrupt/foreign file.
 *
 * A room switches a library skill on by storing `{ name, identity }`, the identity
 * read server-side from the library at that moment through the injected resolver,
 * so the module stays library-agnostic (the room wiring passes the real library).
 * Whether an entry is on in its room is decided in ONE place, `roomSkillState`: a
 * SKILL.md or record that can't be read ⇒ `unreadable`; no skill of that name, or
 * one added again under it (another identity) ⇒ `gone`, which has left the room:
 * no row, not used, its stored entry kept as it is. A skill whose files changed
 * stays on, as it now is. Only `ok` is served as enabled downstream:
 * `effectiveEnabledSkills` (the accessor the room reads) returns only those.
 *
 * Entries written before carry a `sha256` and maybe an `executeApproval`: both
 * are ignored on read and drop out at the room's next write.
 *
 * NB: no room-session wiring lives here (MR-2 is data + API only). Server-side.
 */
export interface EnabledSkill {
	/** Library skill name (strict-id, matching the `/api/skills` rules). */
	name: string;
	/** The skill's identity copied at enable time (see `SkillProvenance.identity`);
	 *  absent = none, as for every entry made before identities. */
	identity?: string;
}

export interface PersistentRoomSkillSettings {
	schemaVersion: 1;
	enabledSkills: EnabledSkill[];
	updatedAt: string;
}

export interface PersistentRoomSkillSettingsStorageOptions {
	persistentAgentsRoot?: string;
}

/**
 * What the library holds under a skill's name right now: the skill (the identity
 * it was added with, absent or null for none), a read that failed (never taken
 * for "no skill"), or null when no skill has that name.
 */
export type LibrarySkillRead = { identity?: string | null } | { unreadable: true } | null;

/**
 * A lens over the canonical library by name. A plain string is a skill's SKILL.md
 * with no identity: a built-in, shared or project skill, or one added before
 * identities. Injected so the storage module never reaches into the library
 * itself; the API layer passes the real one (`readLibrarySkill`), the smoke a fake.
 */
export type SkillBodyResolver = (name: string) => string | LibrarySkillRead;

/** Whether a room's entry is on: the one answer every reader of a room's skills asks for. */
export type RoomSkillState = "ok" | "unreadable" | "gone";

/** Per-enabled-skill state the Skills pane renders: a gone entry has no row. */
export type SkillStatus = Exclude<RoomSkillState, "gone">;

export interface EnabledSkillStatus {
	name: string;
	status: SkillStatus;
}

export type SkillMutationReason = "invalid-name" | "unknown-skill";

export type SkillMutationResult =
	| { ok: true; settings: PersistentRoomSkillSettings }
	| { ok: false; reason: SkillMutationReason };

const DEFAULT_SETTINGS: PersistentRoomSkillSettings = {
	schemaVersion: 1,
	enabledSkills: [],
	updatedAt: "",
};

/** Strict-id rule, identical to the one the `/api/skills` write path enforces. */
const SKILL_NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** True when `name` is a valid library skill name (strict-id). */
export function isValidSkillName(name: unknown): name is string {
	return typeof name === "string" && SKILL_NAME_RE.test(name);
}

function safeSettingsAgentId(raw: string): string {
	const id = String(raw ?? "").trim();
	if (!/^[a-zA-Z0-9_-]{1,160}$/.test(id)) throw new Error("invalid persistent-room agent id");
	return id;
}

function sortByName(skills: EnabledSkill[]): EnabledSkill[] {
	return skills.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Merge/sanitize a raw `enabledSkills` value read off disk: keep only entries
 * with a strict-id name, dedupe by name (last wins), and sort, so a hand-edited
 * or partly-corrupt file degrades to its valid entries instead of throwing.
 */
function sanitizeEnabledSkills(raw: unknown): EnabledSkill[] {
	if (!Array.isArray(raw)) return [];
	const byName = new Map<string, EnabledSkill>();
	for (const item of raw) {
		if (!item || typeof item !== "object") continue;
		const name = (item as any).name;
		if (!isValidSkillName(name)) continue;
		const skill: EnabledSkill = { name };
		// A damaged identity reads as none, which never matches a skill that has one.
		const identity = (item as any).identity;
		if (typeof identity === "string" && SKILL_IDENTITY_RE.test(identity)) skill.identity = identity;
		byName.set(name, skill);
	}
	return sortByName([...byName.values()]);
}

export function persistentRoomSkillSettingsPath(agentIdRaw: string, options: PersistentRoomSkillSettingsStorageOptions = {}): string {
	const agentId = safeSettingsAgentId(agentIdRaw);
	return path.join(persistentAgentRootPath(agentId, options.persistentAgentsRoot ?? DEFAULT_PERSISTENT_ROOM_AGENTS_ROOT), "runtime", "skill-settings.json");
}

export function readPersistentRoomSkillSettings(agentIdRaw: string, options: PersistentRoomSkillSettingsStorageOptions = {}): PersistentRoomSkillSettings {
	const settingsPath = persistentRoomSkillSettingsPath(agentIdRaw, options);
	try {
		if (!fs.existsSync(settingsPath)) return { ...DEFAULT_SETTINGS, enabledSkills: [] };
		const raw = JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
		if (!raw || typeof raw !== "object" || raw.schemaVersion !== 1) return { ...DEFAULT_SETTINGS, enabledSkills: [] };
		return {
			schemaVersion: 1,
			enabledSkills: sanitizeEnabledSkills(raw.enabledSkills),
			updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : "",
		};
	} catch {
		return { ...DEFAULT_SETTINGS, enabledSkills: [] };
	}
}

function writePersistentRoomSkillSettings(agentIdRaw: string, enabledSkills: EnabledSkill[], options: PersistentRoomSkillSettingsStorageOptions, now: Date): PersistentRoomSkillSettings {
	const settingsPath = persistentRoomSkillSettingsPath(agentIdRaw, options);
	const settings: PersistentRoomSkillSettings = {
		schemaVersion: 1,
		enabledSkills: sortByName(enabledSkills),
		updatedAt: now.toISOString(),
	};
	fs.mkdirSync(path.dirname(settingsPath), { recursive: true, mode: 0o700 });
	fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n", { mode: 0o600 });
	return settings;
}

function libraryRead(resolve: SkillBodyResolver, name: string): LibrarySkillRead {
	const read = resolve(name);
	return typeof read === "string" ? { identity: null } : read;
}

/** The entry was made for this added skill: same identity, and none matches none. */
function sameSkill(entry: EnabledSkill, identity: string | null | undefined): boolean {
	return (entry.identity ?? null) === (identity ?? null);
}

/**
 * Whether a room's entry is on, from what the library holds under its name. A
 * failed read is unreadable, never gone; a skill of another identity (deleted and
 * added again under the name) is gone, however alike its text and files.
 */
export function roomSkillState(entry: EnabledSkill, read: LibrarySkillRead): RoomSkillState {
	if (read === null) return "gone";
	if ("unreadable" in read) return "unreadable";
	return sameSkill(entry, read.identity) ? "ok" : "gone";
}

/**
 * Switch a skill on for a room. Validates the name against the strict-id rules
 * and reads the library server-side: an unknown skill (`resolveBody` returns
 * null) is rejected. Upsert semantics: an already-enabled skill is written again
 * in place, never duplicated; an entry of another identity under the name is
 * replaced.
 */
export function enablePersistentRoomSkill(
	agentIdRaw: string,
	name: string,
	resolveBody: SkillBodyResolver,
	options: PersistentRoomSkillSettingsStorageOptions = {},
	now = new Date(),
): SkillMutationResult {
	if (!isValidSkillName(name)) return { ok: false, reason: "invalid-name" };
	const read = libraryRead(resolveBody, name);
	if (read === null || "unreadable" in read) return { ok: false, reason: "unknown-skill" };
	const identity = read.identity ?? null;
	const current = readPersistentRoomSkillSettings(agentIdRaw, options);
	const entry: EnabledSkill = { name, ...(identity ? { identity } : {}) };
	const next = [...current.enabledSkills.filter((skill) => skill.name !== name), entry];
	return { ok: true, settings: writePersistentRoomSkillSettings(agentIdRaw, next, options, now) };
}

/**
 * Disable a skill for a room. Validates the name (bad format is rejected) but is
 * otherwise idempotent — disabling a skill that is not enabled is a no-op that
 * still returns the current settings.
 */
export function disablePersistentRoomSkill(
	agentIdRaw: string,
	name: string,
	options: PersistentRoomSkillSettingsStorageOptions = {},
	now = new Date(),
): SkillMutationResult {
	if (!isValidSkillName(name)) return { ok: false, reason: "invalid-name" };
	const current = readPersistentRoomSkillSettings(agentIdRaw, options);
	if (!current.enabledSkills.some((skill) => skill.name === name)) return { ok: true, settings: current };
	const next = current.enabledSkills.filter((skill) => skill.name !== name);
	return { ok: true, settings: writePersistentRoomSkillSettings(agentIdRaw, next, options, now) };
}

/**
 * Compute the per-skill view: each enabled skill's `roomSkillState`, leaving out
 * the gone ones, which have left the room. This is what the settings panel renders.
 */
export function computeSkillStatuses(enabledSkills: readonly EnabledSkill[], resolveBody: SkillBodyResolver): EnabledSkillStatus[] {
	return enabledSkills.flatMap((skill) => {
		const status = roomSkillState(skill, libraryRead(resolveBody, skill.name));
		return status === "gone" ? [] : [{ name: skill.name, status }];
	});
}

/**
 * The room's EFFECTIVE enabled set: only the skills that are on (`ok`).
 * Unreadable and gone skills are excluded, so nothing downstream (the room
 * wiring) ever injects a skill the room doesn't have.
 */
export function effectiveEnabledSkills(enabledSkills: readonly EnabledSkill[], resolveBody: SkillBodyResolver): EnabledSkill[] {
	const enabledByName = new Map(enabledSkills.map((skill) => [skill.name, skill] as const));
	return computeSkillStatuses(enabledSkills, resolveBody)
		.filter((status) => status.status === "ok")
		.map((status) => enabledByName.get(status.name)!)
		.filter((skill): skill is EnabledSkill => Boolean(skill));
}
