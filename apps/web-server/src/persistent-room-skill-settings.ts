import fs from "node:fs";
import path from "node:path";
import { DEFAULT_PERSISTENT_ROOM_AGENTS_ROOT, persistentAgentRootPath } from "./persistent-room-workspace-policy.js";
import { sha256 } from "./skills-store.js";

/**
 * Per-room skill enablement (skills MR-2, spec §4/§7 must 2). Clones the
 * `persistent-room-maintenance-settings.ts` shape: a per-room JSON file with a
 * schemaVersion, per-field merge/sanitize on read, 0o600 perms, and a
 * fallback-to-empty on a corrupt/foreign file.
 *
 * A room enables a library skill by pinning `{ name, sha256(currentBody) }`. The
 * hash is ALWAYS computed server-side from the canonical store at enable time —
 * never trusted from the client — via the injected body resolver, so the module
 * stays library-agnostic (the seam MR-5 wires the real library into). A changed
 * body ⇒ the pinned hash no longer matches ⇒ `hash-mismatch`; a deleted skill ⇒
 * `missing`. Neither is served as enabled downstream: `effectiveEnabledSkills`
 * (the accessor MR-5 consumes) returns only the `ok` skills. Re-enabling
 * re-pins the current hash — the only way to clear a mismatch (spec §2/§7 must 2).
 *
 * NB: no room-session wiring lives here (MR-2 is data + API only). Server-side.
 */
export interface EnabledSkill {
	/** Library skill name (strict-id, matching the `/api/skills` rules). */
	name: string;
	/** `sha256` of the skill body pinned at enable time. */
	sha256: string;
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
 * A lens over the canonical library: returns the CURRENT body of a skill by
 * name, or `null` when the skill no longer exists. Injected so the storage
 * module never reaches into the library itself; the API layer passes the real
 * one (backed by `listSkills`), the smoke passes a fake.
 */
export type SkillBodyResolver = (name: string) => string | null;

/** Per-enabled-skill mismatch state the UI (MR-5) renders. */
export type SkillMismatchStatus = "ok" | "hash-mismatch" | "missing";

export interface EnabledSkillStatus {
	name: string;
	/** The hash pinned at enable time. */
	sha256: string;
	/** The library body's current hash, or `null` when the skill is missing. */
	currentSha256: string | null;
	status: SkillMismatchStatus;
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
/** A well-formed sha256 hex digest (what `sha256()` produces). */
const SHA256_RE = /^[0-9a-f]{64}$/;

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
 * with a strict-id name and a well-formed pinned hash, dedupe by name (last
 * wins), and sort — so a hand-edited or partly-corrupt file degrades to its
 * valid entries instead of throwing.
 */
function sanitizeEnabledSkills(raw: unknown): EnabledSkill[] {
	if (!Array.isArray(raw)) return [];
	const byName = new Map<string, EnabledSkill>();
	for (const item of raw) {
		if (!item || typeof item !== "object") continue;
		const name = (item as any).name;
		const hash = (item as any).sha256;
		if (!isValidSkillName(name)) continue;
		if (typeof hash !== "string" || !SHA256_RE.test(hash)) continue;
		byName.set(name, { name, sha256: hash });
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

/**
 * Enable (or re-pin) a skill for a room. Validates the name against the
 * strict-id rules and resolves the CURRENT library body server-side — an
 * unknown skill (`resolveBody` returns null) is rejected. The pinned hash is
 * always `sha256(currentBody)`, so re-enabling a drifted skill re-pins the new
 * hash and clears its mismatch. Upsert semantics: an already-enabled skill is
 * re-pinned in place, never duplicated.
 */
export function enablePersistentRoomSkill(
	agentIdRaw: string,
	name: string,
	resolveBody: SkillBodyResolver,
	options: PersistentRoomSkillSettingsStorageOptions = {},
	now = new Date(),
): SkillMutationResult {
	if (!isValidSkillName(name)) return { ok: false, reason: "invalid-name" };
	const body = resolveBody(name);
	if (body == null) return { ok: false, reason: "unknown-skill" };
	const current = readPersistentRoomSkillSettings(agentIdRaw, options);
	const pinned: EnabledSkill = { name, sha256: sha256(body) };
	const next = [...current.enabledSkills.filter((skill) => skill.name !== name), pinned];
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
 * Compute the per-skill mismatch view: for each enabled skill, compare the
 * pinned hash to `sha256(currentBody)` — `missing` when the library no longer
 * has it, `hash-mismatch` when the body changed, `ok` otherwise. This is what
 * the settings panel renders.
 */
export function computeSkillStatuses(enabledSkills: readonly EnabledSkill[], resolveBody: SkillBodyResolver): EnabledSkillStatus[] {
	return enabledSkills.map((skill) => {
		const body = resolveBody(skill.name);
		if (body == null) return { name: skill.name, sha256: skill.sha256, currentSha256: null, status: "missing" as const };
		const currentSha256 = sha256(body);
		return {
			name: skill.name,
			sha256: skill.sha256,
			currentSha256,
			status: currentSha256 === skill.sha256 ? ("ok" as const) : ("hash-mismatch" as const),
		};
	});
}

/**
 * The room's EFFECTIVE enabled set — only the skills whose pinned hash still
 * matches the current library body. Mismatched and missing skills are excluded,
 * so nothing downstream (MR-5's room wiring) ever injects an unreviewed body.
 */
export function effectiveEnabledSkills(enabledSkills: readonly EnabledSkill[], resolveBody: SkillBodyResolver): EnabledSkill[] {
	const enabledByName = new Map(enabledSkills.map((skill) => [skill.name, skill] as const));
	return computeSkillStatuses(enabledSkills, resolveBody)
		.filter((status) => status.status === "ok")
		.map((status) => enabledByName.get(status.name)!)
		.filter((skill): skill is EnabledSkill => Boolean(skill));
}
