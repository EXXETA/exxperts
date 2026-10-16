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
export interface SkillExecuteApproval {
	/** `filesSha256` of the skill's whole on-disk content, pinned at approval time
	 *  (see `computeSkillFilesDigest`). Any file change voids the approval. */
	filesSha256: string;
	approvedAt: string;
}

export interface EnabledSkill {
	/** Library skill name (strict-id, matching the `/api/skills` rules). */
	name: string;
	/** `sha256` of the skill body pinned at enable time. */
	sha256: string;
	/** Reviewed repository package, including selected references and their mapping. */
	packageSha256?: string;
	/** Present when the user approved running this skill's bundled scripts in
	 *  this room, pinned to the exact file set reviewed. Absent = never. */
	executeApproval?: SkillExecuteApproval;
}

export interface PersistentRoomSkillSettings {
	schemaVersion: 1;
	enabledSkills: EnabledSkill[];
	/** Source-owned consent is separate from independently enabled skills. */
	enabledSources?: EnabledSkillSource[];
	updatedAt: string;
}

export interface EnabledSkillSource {
	libraryId: string;
	materialsSha256: string;
	skills: Array<{ name: string; sha256: string; packageSha256: string }>;
	excludedSkills: string[];
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

/** Execution-approval state per enabled skill, for the settings panel.
 *  `none` = never approved; `approved` = approval matches the files on disk;
 *  `drifted` = files changed (or vanished) since approval — void until re-approved. */
export type SkillExecutionState = "none" | "approved" | "drifted";

export interface EnabledSkillStatus {
	name: string;
	/** The hash pinned at enable time. */
	sha256: string;
	/** The library body's current hash, or `null` when the skill is missing. */
	currentSha256: string | null;
	packageSha256?: string;
	currentPackageSha256?: string | null;
	status: SkillMismatchStatus;
	/** Present when a files-digest resolver was supplied (rooms wiring). */
	executeState?: SkillExecutionState;
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
		const skill: EnabledSkill = { name, sha256: hash };
		// A damaged package pin must not degrade to a legacy manifest-only approval.
		if ((item as any).packageSha256 !== undefined) {
			if (typeof (item as any).packageSha256 !== "string" || !SHA256_RE.test((item as any).packageSha256)) continue;
			skill.packageSha256 = (item as any).packageSha256;
		}
		// The approval survives a read/write cycle only when well-formed; a
		// hand-mangled one degrades to "never approved", the safe direction.
		const approval = (item as any).executeApproval;
		if (
			approval &&
			typeof approval === "object" &&
			typeof approval.filesSha256 === "string" &&
			SHA256_RE.test(approval.filesSha256) &&
			typeof approval.approvedAt === "string"
		) {
			skill.executeApproval = { filesSha256: approval.filesSha256, approvedAt: approval.approvedAt };
		}
		byName.set(name, skill);
	}
	return sortByName([...byName.values()]);
}

function sanitizeEnabledSources(raw: unknown): EnabledSkillSource[] {
	if (!Array.isArray(raw)) return [];
	const sources = new Map<string, EnabledSkillSource>();
	for (const source of raw) {
		if (!source || typeof source !== "object" || typeof source.libraryId !== "string" || !/^[a-zA-Z0-9-]{1,80}$/.test(source.libraryId) || typeof source.materialsSha256 !== "string" || !SHA256_RE.test(source.materialsSha256) || !Array.isArray(source.skills) || !Array.isArray(source.excludedSkills)) continue;
		const skills = sanitizeEnabledSkills(source.skills);
		if (skills.length !== source.skills.length || skills.some((skill) => !skill.packageSha256 || skill.executeApproval) || source.excludedSkills.some((name: unknown) => !isValidSkillName(name) || !skills.some((skill) => skill.name === name))) continue;
		sources.set(source.libraryId, { libraryId: source.libraryId, materialsSha256: source.materialsSha256, skills: skills.map((skill) => ({ name: skill.name, sha256: skill.sha256, packageSha256: skill.packageSha256! })), excludedSkills: [...new Set<string>(source.excludedSkills)].sort() });
	}
	return [...sources.values()].sort((a, b) => a.libraryId.localeCompare(b.libraryId));
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
			...(Array.isArray(raw.enabledSources) ? { enabledSources: sanitizeEnabledSources(raw.enabledSources) } : {}),
			updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : "",
		};
	} catch {
		return { ...DEFAULT_SETTINGS, enabledSkills: [] };
	}
}

function writePersistentRoomSkillSettings(agentIdRaw: string, enabledSkills: EnabledSkill[], options: PersistentRoomSkillSettingsStorageOptions, now: Date, enabledSources = readPersistentRoomSkillSettings(agentIdRaw, options).enabledSources): PersistentRoomSkillSettings {
	const settingsPath = persistentRoomSkillSettingsPath(agentIdRaw, options);
	const settings: PersistentRoomSkillSettings = {
		schemaVersion: 1,
		enabledSkills: sortByName(enabledSkills),
		...(enabledSources ? { enabledSources } : {}),
		updatedAt: now.toISOString(),
	};
	fs.mkdirSync(path.dirname(settingsPath), { recursive: true, mode: 0o700 });
	const temporary = `${settingsPath}.${process.pid}.tmp`;
	try {
		fs.writeFileSync(temporary, JSON.stringify(settings, null, 2) + "\n", { mode: 0o600 });
		fs.renameSync(temporary, settingsPath);
	} finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
	return settings;
}

export type SourceMutationResult = { ok: true; settings: PersistentRoomSkillSettings } | { ok: false; reason: "invalid-source" | "source-not-enabled" | "unknown-skill" };

/** The API validates live library membership and reviewed hashes before this atomic write. */
export function enablePersistentRoomSource(agentIdRaw: string, source: EnabledSkillSource, options: PersistentRoomSkillSettingsStorageOptions = {}, now = new Date()): SourceMutationResult {
	const clean = sanitizeEnabledSources([source])[0];
	if (!clean) return { ok: false, reason: "invalid-source" };
	const current = readPersistentRoomSkillSettings(agentIdRaw, options);
	return { ok: true, settings: writePersistentRoomSkillSettings(agentIdRaw, current.enabledSkills, options, now, [...(current.enabledSources ?? []).filter((entry) => entry.libraryId !== clean.libraryId), clean]) };
}

/** One reviewed library update replaces both owners' pins in a single room write. */
export function updatePersistentRoomLibrary(agentIdRaw: string, libraryId: string, pins: EnabledSkillSource, expectedSettings: PersistentRoomSkillSettings, options: PersistentRoomSkillSettingsStorageOptions = {}): PersistentRoomSkillSettings {
	const current = readPersistentRoomSkillSettings(agentIdRaw, options);
	if (JSON.stringify(current) !== JSON.stringify(expectedSettings)) throw new Error("Room skills changed since this review. Review again.");
	const clean = sanitizeEnabledSources([pins])[0];
	if (!clean || clean.libraryId !== libraryId) throw new Error("Invalid reviewed source.");
	const previous = current.enabledSources?.find((source) => source.libraryId === libraryId);
	const sources = previous ? (current.enabledSources ?? []).map((source) => source.libraryId === libraryId ? { ...clean, excludedSkills: clean.skills.filter((skill) => !previous.skills.some((old) => old.name === skill.name) || previous.excludedSkills.includes(skill.name)).map((skill) => skill.name) } : source) : current.enabledSources;
	const skills = current.enabledSkills.map((skill) => {
		const next = clean.skills.find((pin) => pin.name === skill.name);
		return next ? { ...next } : skill;
	});
	return writePersistentRoomSkillSettings(agentIdRaw, skills, options, new Date(), sources);
}

export function disablePersistentRoomSource(agentIdRaw: string, libraryId: string, options: PersistentRoomSkillSettingsStorageOptions = {}, now = new Date()): SourceMutationResult {
	if (!/^[a-zA-Z0-9-]{1,80}$/.test(libraryId)) return { ok: false, reason: "invalid-source" };
	const current = readPersistentRoomSkillSettings(agentIdRaw, options);
	const sources = (current.enabledSources ?? []).filter((source) => source.libraryId !== libraryId);
	if (sources.length === (current.enabledSources ?? []).length) return { ok: true, settings: current };
	return { ok: true, settings: writePersistentRoomSkillSettings(agentIdRaw, current.enabledSkills, options, now, sources) };
}

export function setPersistentRoomSourceSkillExcluded(agentIdRaw: string, libraryId: string, name: string, excluded: boolean, options: PersistentRoomSkillSettingsStorageOptions = {}, now = new Date()): SourceMutationResult {
	const current = readPersistentRoomSkillSettings(agentIdRaw, options);
	const source = current.enabledSources?.find((entry) => entry.libraryId === libraryId);
	if (!source) return { ok: false, reason: "source-not-enabled" };
	if (!isValidSkillName(name) || !source.skills.some((skill) => skill.name === name)) return { ok: false, reason: "unknown-skill" };
	const exclusions = new Set(source.excludedSkills);
	if (excluded) exclusions.add(name); else exclusions.delete(name);
	return enablePersistentRoomSource(agentIdRaw, { ...source, excludedSkills: [...exclusions] }, options, now);
}

/** Keep both owners' pins until verification: a stale pin must not mask a valid one. */
export function configuredRoomSkillPins(settings: PersistentRoomSkillSettings): EnabledSkill[] {
	return [...settings.enabledSkills, ...(settings.enabledSources ?? []).flatMap((source) => source.skills.filter((skill) => !source.excludedSkills.includes(skill.name)))];
}

export function computeRoomSkillStatuses(settings: PersistentRoomSkillSettings, resolveBody: SkillBodyResolver, resolveFilesDigest?: SkillFilesDigestResolver, resolvePackageDigest?: SkillFilesDigestResolver): EnabledSkillStatus[] {
	const byName = new Map<string, EnabledSkillStatus>();
	for (const status of computeSkillStatuses(configuredRoomSkillPins(settings), resolveBody, resolveFilesDigest, resolvePackageDigest)) {
		if (!byName.has(status.name) || status.status === "ok") byName.set(status.name, status);
	}
	return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export function effectiveRoomEnabledSkills(settings: PersistentRoomSkillSettings, resolveBody: SkillBodyResolver, resolvePackageDigest?: SkillFilesDigestResolver): EnabledSkill[] {
	const effective = new Map<string, EnabledSkill>();
	for (const pin of configuredRoomSkillPins(settings)) {
		if (computeSkillStatuses([pin], resolveBody, undefined, resolvePackageDigest)[0].status === "ok") effective.set(pin.name, pin);
	}
	return sortByName([...effective.values()]);
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
	resolvePackageDigest?: SkillFilesDigestResolver,
): SkillMutationResult {
	if (!isValidSkillName(name)) return { ok: false, reason: "invalid-name" };
	const body = resolveBody(name);
	if (body == null) return { ok: false, reason: "unknown-skill" };
	const packageSha256 = resolvePackageDigest?.(name) ?? null;
	if (packageSha256 !== null && !SHA256_RE.test(packageSha256)) return { ok: false, reason: "unknown-skill" };
	const current = readPersistentRoomSkillSettings(agentIdRaw, options);
	// An existing execution approval rides along untouched: it is pinned to the
	// files digest, which is its own guard — if the files changed, the approval
	// is already void at call time regardless of what the manifest pin does.
	const existing = current.enabledSkills.find((skill) => skill.name === name);
	const pinned: EnabledSkill = { name, sha256: sha256(body), ...(packageSha256 ? { packageSha256 } : {}), ...(!packageSha256 && existing?.executeApproval ? { executeApproval: existing.executeApproval } : {}) };
	const next = [...current.enabledSkills.filter((skill) => skill.name !== name), pinned];
	return { ok: true, settings: writePersistentRoomSkillSettings(agentIdRaw, next, options, now) };
}

export type SkillExecutionMutationReason = SkillMutationReason | "not-enabled" | "no-files";

export type SkillExecutionMutationResult =
	| { ok: true; settings: PersistentRoomSkillSettings }
	| { ok: false; reason: SkillExecutionMutationReason };

/**
 * A lens returning the CURRENT whole-content digest of a skill's on-disk dir
 * (see `computeSkillFilesDigest`), or null when the skill is not an
 * execution-capable library entry (missing, or outside the user store). Injected
 * like `SkillBodyResolver` so this module never reaches into the library.
 */
export type SkillFilesDigestResolver = (name: string) => string | null;

/**
 * Approve running a skill's bundled scripts in this room, pinned to the exact
 * file set on disk right now. Server-computed digest only — the client never
 * supplies it. Requires the skill to already be enabled: consent to execute
 * builds on consent to instruct, never replaces it. Re-approving a drifted
 * skill re-pins the current digest — the only way to clear a drift.
 */
export function approvePersistentRoomSkillExecution(
	agentIdRaw: string,
	name: string,
	resolveFilesDigest: SkillFilesDigestResolver,
	options: PersistentRoomSkillSettingsStorageOptions = {},
	now = new Date(),
): SkillExecutionMutationResult {
	if (!isValidSkillName(name)) return { ok: false, reason: "invalid-name" };
	const current = readPersistentRoomSkillSettings(agentIdRaw, options);
	const enabled = current.enabledSkills.find((skill) => skill.name === name);
	if (!enabled) return { ok: false, reason: "not-enabled" };
	if (enabled.packageSha256) return { ok: false, reason: "no-files" };
	const filesSha256 = resolveFilesDigest(name);
	if (filesSha256 == null) return { ok: false, reason: "no-files" };
	const next = current.enabledSkills.map((skill) =>
		skill.name === name ? { ...skill, executeApproval: { filesSha256, approvedAt: now.toISOString() } } : skill,
	);
	return { ok: true, settings: writePersistentRoomSkillSettings(agentIdRaw, next, options, now) };
}

/** Withdraw a room's execution approval for a skill. Idempotent; the skill stays enabled. */
export function revokePersistentRoomSkillExecution(
	agentIdRaw: string,
	name: string,
	options: PersistentRoomSkillSettingsStorageOptions = {},
	now = new Date(),
): SkillExecutionMutationResult {
	if (!isValidSkillName(name)) return { ok: false, reason: "invalid-name" };
	const current = readPersistentRoomSkillSettings(agentIdRaw, options);
	const enabled = current.enabledSkills.find((skill) => skill.name === name);
	if (!enabled) return { ok: false, reason: "not-enabled" };
	if (!enabled.executeApproval) return { ok: true, settings: current };
	const next = current.enabledSkills.map((skill) => {
		if (skill.name !== name) return skill;
		const { executeApproval: _gone, ...rest } = skill;
		return rest;
	});
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
export function computeSkillStatuses(
	enabledSkills: readonly EnabledSkill[],
	resolveBody: SkillBodyResolver,
	resolveFilesDigest?: SkillFilesDigestResolver,
	resolvePackageDigest?: SkillFilesDigestResolver,
): EnabledSkillStatus[] {
	return enabledSkills.map((skill) => {
		const executeState = (): SkillExecutionState => {
			if (!skill.executeApproval) return "none";
			const current = resolveFilesDigest?.(skill.name) ?? null;
			return current !== null && current === skill.executeApproval.filesSha256 ? "approved" : "drifted";
		};
		const withExecute = resolveFilesDigest ? { executeState: executeState() } : {};
		const currentPackageSha256 = resolvePackageDigest?.(skill.name) ?? null;
		const withPackage = skill.packageSha256 !== undefined || currentPackageSha256 !== null
			? { packageSha256: skill.packageSha256, currentPackageSha256 }
			: {};
		const body = resolveBody(skill.name);
		if (body == null) return { name: skill.name, sha256: skill.sha256, currentSha256: null, status: "missing" as const, ...withExecute, ...withPackage };
		const currentSha256 = sha256(body);
		const packageMatches = (skill.packageSha256 ?? null) === currentPackageSha256;
		return {
			name: skill.name,
			sha256: skill.sha256,
			currentSha256,
			status: currentSha256 === skill.sha256 && packageMatches ? ("ok" as const) : ("hash-mismatch" as const),
			...withExecute,
			...withPackage,
		};
	});
}

/**
 * The room's EFFECTIVE enabled set — only the skills whose pinned hash still
 * matches the current library body. Mismatched and missing skills are excluded,
 * so nothing downstream (MR-5's room wiring) ever injects an unreviewed body.
 */
export function effectiveEnabledSkills(enabledSkills: readonly EnabledSkill[], resolveBody: SkillBodyResolver, resolvePackageDigest?: SkillFilesDigestResolver): EnabledSkill[] {
	const enabledByName = new Map(enabledSkills.map((skill) => [skill.name, skill] as const));
	return computeSkillStatuses(enabledSkills, resolveBody, undefined, resolvePackageDigest)
		.filter((status) => status.status === "ok")
		.map((status) => enabledByName.get(status.name)!)
		.filter((skill): skill is EnabledSkill => Boolean(skill));
}
