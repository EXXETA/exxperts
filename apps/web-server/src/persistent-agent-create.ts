import crypto from "node:crypto";
import fs from "node:fs";
import { estimateTokens } from "./token-estimate.js";
import path from "node:path";
import { renameOver, syncFolder } from "@exxeta/exxperts-runtime";
import { MAINTENANCE_DIAGNOSTICS_DIRNAME } from "./maintenance-diagnostics.js";
import { trimHumanText } from "./room-name.js";
import { fingerprintL1bSource, type NormalizedPersistentAgentScaffoldInput, type PersistentAgentId, type PersistentAgentScaffoldInput, type PersistentAgentScaffoldResult, type ReservedPersistentAgentRoot } from "./persistent-agent-types.js";
import type { L1bSourceFingerprint } from "./persistent-agent-memory-types.js";
import { activePersistentRoomLock, type AgentJson, createPersistentAgentInstance, defaultPersistentAgentRuntimeState, ensureDir, ensurePersistentAgentCanonicalScaffoldDirs, getPersistentAgentRuntimeState, isPersistentAgentArchived, MAX_PERSISTENT_AGENT_ID_LENGTH, PERSISTENT_AGENTS_ROOT, type PersistentAgentInstance, readJson, shortRandomId, slugTimestamp, validatePersistentAgentId, writeFileAtomic } from "./persistent-agent-store.js";
import { hasPersistentAgentTurnInFlight } from "./persistent-agent-turns.js";
import { genericPersistentAgentJson } from "./persistent-agent-memory-files.js";
import { defaultSectionRegistry, genericL1a, genericL1b, isPersistentAgentL1aModeId, PERSISTENT_AGENT_L1A_DEFAULT_MODE_ID, PERSISTENT_AGENT_L1A_MODES, PERSISTENT_AGENT_L1A_TEMPLATE_VERSION } from "./persistent-agent-constitution.js";
import { getPersistentAgentStatus, type RoomViewer, roomIdsForViewer } from "./persistent-agent-status.js";
import { newRoomCommandFiles } from "./persistent-room-bash-settings.js";

function collapseHumanWhitespace(value: string): string {
	return trimHumanText(value);
}

function normalizeRequiredHumanName(value: unknown, requiredMessage: string): string {
	// NFC at intake: macOS paste can deliver NFD ("Café" as e + combining
	// accent), which would otherwise store as a byte-different twin of the
	// composed name and slip past the uniqueness check.
	const normalized = typeof value === "string" ? collapseHumanWhitespace(value).normalize("NFC") : "";
	if (!normalized) throw new Error(requiredMessage);
	return normalized;
}

/**
 * Room names are unique among ACTIVE rooms (case-insensitive): two cards
 * called "test" in one flat list are only distinguishable by a hover tooltip.
 * Archived rooms deliberately do not block the name — archiving a room and
 * starting a fresh one under the same name is a supported flow — so the
 * collision check runs again at restore time instead. The caller excludes the
 * room being renamed so a case-only rename still works.
 *
 * The rooms compared are the viewer's: on a shared server a person's own, so a
 * colleague's room name neither blocks nor shows. Without a viewer, every room.
 */
export function assertPersistentAgentDisplayNameAvailable(displayName: string, options: { excludeAgentId?: string; viewer?: RoomViewer } = {}): void {
	if (roomHoldingDisplayName(displayName, options)) throw displayNameTaken(displayName);
}

function displayNameTaken(displayName: string): Error {
	const error = new Error(`A room named ${collapseHumanWhitespace(displayName)} already exists. Choose a different name.`);
	(error as any).statusCode = 409;
	(error as any).code = "display_name_taken";
	return error;
}

/** The viewer's live room with this name, or null. */
function roomHoldingDisplayName(displayName: string, options: { excludeAgentId?: string; viewer?: RoomViewer } = {}): string | null {
	// NFC on BOTH sides of the comparison: stored names from before intake
	// normalization may still be NFD on disk.
	const wanted = collapseHumanWhitespace(displayName).normalize("NFC").toLowerCase();
	if (!wanted) return null;
	// An unscannable store gives no ids, so it never blocks creation; id
	// reservation still guarantees id uniqueness.
	for (const id of roomIdsForViewer(options.viewer ?? "every room")) {
		if (options.excludeAgentId && id === options.excludeAgentId) continue;
		let meta: Partial<AgentJson> | null = null;
		try {
			meta = createPersistentAgentInstance(id).readAgentJson();
		} catch {
			continue;
		}
		const existing = typeof meta?.displayName === "string" ? collapseHumanWhitespace(meta.displayName).normalize("NFC").toLowerCase() : "";
		if (existing !== wanted) continue;
		if (isPersistentAgentArchived(meta)) continue;
		return id;
	}
	return null;
}

function normalizeOptionalHumanText(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const normalized = collapseHumanWhitespace(value);
	return normalized || undefined;
}

function normalizeScaffoldRole(value: unknown): string {
	const role = typeof value === "string" ? value.trim() : "";
	const normalized = role || "personal-coordinator";
	if (!/^[a-z0-9][a-z0-9_-]{0,79}$/.test(normalized)) throw new Error("role must be a safe lowercase identifier");
	return normalized;
}

function normalizeScaffoldMode(value: unknown): string {
	const mode = typeof value === "string" ? value.trim().toLowerCase() : "";
	const normalized = mode || PERSISTENT_AGENT_L1A_DEFAULT_MODE_ID;
	if (!isPersistentAgentL1aModeId(normalized)) throw new Error(`mode must be one of: ${PERSISTENT_AGENT_L1A_MODES.map((candidate) => candidate.id).join(", ")}`);
	return normalized;
}

function defaultPreferredUserAddress(userDisplayName: string): string {
	return userDisplayName.split(/\s+/)[0] || userDisplayName;
}

export function normalizePersistentAgentDisplayName(value: unknown): string {
	return normalizeRequiredHumanName(value, "Room name is required.");
}

export function persistentAgentSlugFromDisplayName(displayNameRaw: unknown): string {
	const displayName = normalizePersistentAgentDisplayName(displayNameRaw);
	const withoutDiacritics = displayName.normalize("NFKD").replace(/[\u0300-\u036f]/g, "");
	const slug = withoutDiacritics
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/-+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, MAX_PERSISTENT_AGENT_ID_LENGTH)
		.replace(/-+$/g, "");
	return slug || "agent";
}

function persistentAgentIdCandidate(baseAgentId: string, attempt: number, idTail: (() => string) | undefined): PersistentAgentId {
	const suffix = idTail ? `-${idTail()}` : attempt <= 1 ? "" : `-${attempt}`;
	const maxBaseLength = MAX_PERSISTENT_AGENT_ID_LENGTH - suffix.length;
	const truncatedBase = baseAgentId.slice(0, Math.max(1, maxBaseLength)).replace(/-+$/g, "") || "agent";
	const candidate = `${truncatedBase}${suffix}`;
	return validatePersistentAgentId(candidate);
}

export function normalizePersistentAgentScaffoldInput(input: PersistentAgentScaffoldInput): NormalizedPersistentAgentScaffoldInput {
	const raw = input ?? {};
	const displayName = normalizePersistentAgentDisplayName(raw.displayName ?? raw.name);
	const userDisplayName = normalizeRequiredHumanName(raw.user?.displayName ?? raw.userName, "Your name is required.");
	const preferredAddress = normalizeOptionalHumanText(raw.user?.preferredAddress ?? raw.preferredAddress ?? raw.preferredUserAddress) ?? defaultPreferredUserAddress(userDisplayName);
	const role = normalizeScaffoldRole(raw.role ?? raw.templateId);
	const description = normalizeOptionalHumanText(raw.description);
	const mode = normalizeScaffoldMode(raw.mode);
	return {
		displayName,
		baseAgentId: persistentAgentSlugFromDisplayName(displayName),
		role,
		templateId: role,
		mode,
		...(description ? { description } : {}),
		user: {
			displayName: userDisplayName,
			preferredAddress,
		},
	};
}

/** A room is built under this name and renamed into place whole, so no listing ever meets half a room. An id cannot start with a dot, so nothing reads it as a room. */
const ROOM_BEING_BUILT_PREFIX = ".being-built-";

/** A build takes a moment, so a folder this old is one a kill left, never one another server on this data folder is still writing. */
const ROOM_BUILD_ABANDONED_MS = 60 * 60 * 1000;

/** Picks a free id and makes the folder the room is built in, under a name of its own, and drops what a kill left long ago. */
export function reserveUniquePersistentAgentRoot(baseAgentIdRaw: string, idTail?: () => string): ReservedPersistentAgentRoot {
	const baseAgentId = persistentAgentSlugFromDisplayName(baseAgentIdRaw);
	ensureDir(PERSISTENT_AGENTS_ROOT);
	for (const name of fs.readdirSync(PERSISTENT_AGENTS_ROOT)) {
		if (!name.startsWith(ROOM_BEING_BUILT_PREFIX)) continue;
		const folder = path.join(PERSISTENT_AGENTS_ROOT, name);
		const age = Date.now() - (fs.statSync(folder, { throwIfNoEntry: false })?.mtimeMs ?? Date.now());
		if (age > ROOM_BUILD_ABANDONED_MS) fs.rmSync(folder, { recursive: true, force: true });
	}
	for (let attempt = 1; attempt <= 9999; attempt += 1) {
		const agentId = persistentAgentIdCandidate(baseAgentId, attempt, idTail);
		const rootDir = path.join(PERSISTENT_AGENTS_ROOT, agentId);
		if (fs.existsSync(rootDir)) continue;
		const buildDir = path.join(PERSISTENT_AGENTS_ROOT, `${ROOM_BEING_BUILT_PREFIX}${agentId}-${crypto.randomUUID()}`);
		fs.mkdirSync(buildDir, { mode: 0o700 });
		return { agentId, rootDir, buildDir, baseAgentId, attempts: attempt };
	}
	throw new Error(`could not allocate unique persistent agent id for ${baseAgentId}`);
}

/** Flushes every folder under a built room, so the room's own entries reach the disk before its rename does. */
function syncFolderTree(folder: string): void {
	for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
		if (entry.isDirectory()) syncFolderTree(path.join(folder, entry.name));
	}
	syncFolder(folder);
}

function unansweredCreatePath(rootDir: string): string {
	return path.join(rootDir, "runtime", "create-unanswered.json");
}

function scaffoldInputKey(normalized: NormalizedPersistentAgentScaffoldInput): string {
	return crypto.createHash("sha256").update(JSON.stringify(normalized)).digest("hex");
}

/** A room's create was answered: the same input sent again from now on is a second room's name clash, not a retry. */
export function markPersistentAgentCreateAnswered(agentId: string): void {
	try {
		fs.rmSync(unansweredCreatePath(createPersistentAgentInstance(agentId).rootDir), { force: true });
	} catch (error) {
		// This runs after the answer: thrown here it would end the server for everyone, and left behind it costs a stale mark.
		console.error(`[create] the mark of a room that was answered could not be removed: ${(error as NodeJS.ErrnoException)?.code ?? "Error"}`);
	}
}

function scaffoldResult(agentId: PersistentAgentId, normalized: NormalizedPersistentAgentScaffoldInput, created: string[]): PersistentAgentScaffoldResult {
	const status = getPersistentAgentStatus(agentId);
	return {
		agent: {
			id: agentId,
			agentId,
			displayName: normalized.displayName,
			...(normalized.description ? { description: normalized.description } : {}),
			role: normalized.role,
			templateId: normalized.templateId,
			root: createPersistentAgentInstance(agentId).rootDir,
			status: status.status,
		},
		status,
		created,
		warnings: [],
	};
}

function removeRoomBeingBuiltOnFailure(buildDir: string): void {
	try {
		fs.rmSync(buildDir, { recursive: true, force: true });
	} catch {
		// Preserve the original scaffold error. The next create drops what is left.
	}
}

/**
 * Builds a room in a hidden folder and renames it into place: a kill leaves no
 * room or a whole one. `untilAnswered` is for a caller that answers someone
 * over a connection a kill can cut: the room keeps a mark until that caller says
 * the answer went out, and the same input sent while it stands gets the room
 * back, since the person never heard it was made. The mark names no person, so
 * a server with several people must not ask for it: anyone sending the same
 * details would get the room.
 */
export function createPersistentAgentFromScaffoldInput(input: PersistentAgentScaffoldInput, options: { idTail?: () => string; untilAnswered?: boolean; viewer?: RoomViewer } = {}): PersistentAgentScaffoldResult {
	const normalized = normalizePersistentAgentScaffoldInput(input);
	const key = scaffoldInputKey(normalized);
	const holder = roomHoldingDisplayName(normalized.displayName, { viewer: options.viewer });
	if (holder) {
		if (options.untilAnswered && readJson(unansweredCreatePath(createPersistentAgentInstance(holder).rootDir))?.key === key) return scaffoldResult(holder, normalized, []);
		throw displayNameTaken(normalized.displayName);
	}
	const reserved = reserveUniquePersistentAgentRoot(normalized.baseAgentId, options.idTail);
	const now = Date.now();
	const created: string[] = [];
	try {
		ensureDir(path.join(reserved.buildDir, "L1b/archive"));
		created.push("L1b/archive/");
		ensurePersistentAgentCanonicalScaffoldDirs(reserved.buildDir);
		for (const rel of ["runtime/threads", "runtime/workspace-policies", "events/checkpoint", "events/absorb", "events/review", `events/${MAINTENANCE_DIAGNOSTICS_DIRNAME}`]) {
			created.push(`${rel}/`);
		}
		const files: Array<[string, string]> = [
			["agent.json", JSON.stringify(genericPersistentAgentJson(reserved.agentId, normalized, now), null, 2) + "\n"],
			["L1a.md", genericL1a(reserved.agentId, normalized)],
			["L1b/current.md", genericL1b(reserved.agentId, normalized, new Date(now))],
			["section_registry.json", defaultSectionRegistry(now)],
			["runtime/state.json", JSON.stringify(defaultPersistentAgentRuntimeState(reserved.agentId), null, 2) + "\n"],
			// Per-room MCP: NEW rooms start with an explicit empty grant list -
			// the room's settings control which connectors this room can use, and
			// none are granted until the user grants them. (Existing rooms get the
			// full list once, via the update-day migration.)
			["runtime/mcp-settings.json", JSON.stringify({ schemaVersion: 1, grantedConnectors: [], updatedAt: new Date(now).toISOString() }, null, 2) + "\n"],
			// New rooms where commands stay inside the room start with them on; rooms made before keep what they have.
			...newRoomCommandFiles(new Date(now)),
		];
		for (const [rel, body] of files) {
			const file = path.join(reserved.buildDir, rel);
			ensureDir(path.dirname(file));
			writeFileAtomic(file, body);
			created.push(rel);
		}
		if (options.untilAnswered) writeFileAtomic(unansweredCreatePath(reserved.buildDir), JSON.stringify({ key }) + "\n");
		syncFolderTree(reserved.buildDir);
		renameOver(reserved.buildDir, reserved.rootDir);
		syncFolder(PERSISTENT_AGENTS_ROOT);
	} catch (error) {
		removeRoomBeingBuiltOnFailure(reserved.buildDir);
		throw error;
	}
	return scaffoldResult(reserved.agentId, normalized, created);
}

const L1A_MARKER_PATTERN = /<!--\s*exxeta:persistent-agent:l1a\s+schema_version=(\d+)(?:\s+template_version=(\d+))?(?:\s+mode=([a-z0-9_-]+))?\s*-->/;

export interface PersistentAgentL1aMarker {
	schemaVersion: number;
	templateVersion: number;
	mode: string;
}

// Pre-template_version constitutions carry only schema_version; they are all
// treated as template generation 1 for upgrade purposes.
export function parsePersistentAgentL1aMarker(l1a: string): PersistentAgentL1aMarker {
	const match = L1A_MARKER_PATTERN.exec(l1a);
	if (!match) return { schemaVersion: 1, templateVersion: 1, mode: PERSISTENT_AGENT_L1A_DEFAULT_MODE_ID };
	return {
		schemaVersion: Number(match[1]),
		templateVersion: match[2] ? Number(match[2]) : 1,
		mode: match[3] && isPersistentAgentL1aModeId(match[3]) ? match[3] : PERSISTENT_AGENT_L1A_DEFAULT_MODE_ID,
	};
}

export interface PersistentAgentConstitutionUpgradePlan {
	agentId: PersistentAgentId;
	action: "upgrade" | "up_to_date";
	fromTemplateVersion: number;
	toTemplateVersion: number;
	mode: string;
	currentL1aFingerprint: L1bSourceFingerprint;
	currentL1aEstimatedTokens: number;
	candidateL1aEstimatedTokens: number;
}

export interface PersistentAgentConstitutionUpgradeResult {
	plan: PersistentAgentConstitutionUpgradePlan;
	upgradeId: string | null;
	archivedL1aRelPath: string | null;
	eventRecordRelPath: string | null;
}

function constitutionUpgradeScaffoldInput(instance: PersistentAgentInstance, meta: Partial<AgentJson>): NormalizedPersistentAgentScaffoldInput {
	const userDisplayName = String(meta.user?.displayName ?? "").trim();
	if (!userDisplayName) throw new Error(`${instance.agentId}: agent.json has no user.displayName; cannot rebuild the constitution`);
	return normalizePersistentAgentScaffoldInput({
		displayName: String(meta.displayName ?? "").trim() || instance.agentId,
		user: {
			displayName: userDisplayName,
			...(String(meta.user?.preferredAddress ?? "").trim() ? { preferredAddress: String(meta.user?.preferredAddress ?? "").trim() } : {}),
		},
		...(String(meta.role ?? "").trim() ? { role: String(meta.role ?? "").trim() } : {}),
		...(String(meta.description ?? "").trim() ? { description: String(meta.description ?? "").trim() } : {}),
		mode: String(meta.mode ?? "").trim() || PERSISTENT_AGENT_L1A_DEFAULT_MODE_ID,
	});
}

/** Who may re-render a constitution, and how quiet the room has to be for it. */
export type PersistentAgentConstitutionUpgradeGate = "strict" | "on-open";

/**
 * "strict" is the operator runner's gate, and every other caller's: the room is
 * closed and settled, so the re-render cannot race a reader, and a room that is
 * merely selected is refused with a line telling the operator to close it.
 *
 * "on-open" is the room's own next open, which for most rooms is the only
 * moment they will ever get. It cannot ask for an idle runtime: the runtime
 * reads "active" or "standby" from the moment a thread is selected, and the web
 * UI saves the thread active before it opens the socket — so a room anyone has
 * ever used would be refused on every open and never catch up at all. What it
 * asks instead is narrower and actually true at that point in the open: no turn
 * is in flight on any of the room's threads, and no other surface is holding
 * the room, this connection not having taken the lock yet, so any live lock is
 * somebody else's. A room mid-turn is left as it is and catches up at a later
 * open; the room is never made to wait for its constitution either way.
 */
function assertConstitutionUpgradeAllowed(instance: PersistentAgentInstance, meta: Partial<AgentJson>, gate: PersistentAgentConstitutionUpgradeGate): void {
	if (isPersistentAgentArchived(meta)) throw new Error(`${instance.agentId}: room is archived; restore it before upgrading its constitution`);
	if (gate === "strict") {
		const runtime = getPersistentAgentRuntimeState(instance.agentId);
		if (runtime.state !== "idle") throw new Error(`${instance.agentId}: room runtime state is "${runtime.state}"; close the room and let it settle to idle before upgrading`);
	} else if (hasPersistentAgentTurnInFlight(instance.agentId)) {
		throw new Error(`${instance.agentId}: the room is mid-turn; its constitution catches up at a later open`);
	}
	const lock = activePersistentRoomLock(instance.agentId);
	if (lock) throw new Error(`${instance.agentId}: room is currently open on surface "${lock.surface ?? "unknown"}"; close it before upgrading`);
}

/**
 * The constitution an upgrade writes. A step that changes only a phrase is
 * made in place, so a room someone edited by hand keeps its own lines; from
 * any other version the template is rendered anew.
 */
const L1A_IN_PLACE_STEPS: Record<number, ReadonlyArray<{ from: string; to: string }>> = {
	3: [{ from: "the transcripts of memorized conversations", to: "the transcripts of remembered conversations" }],
	// Our own words for memory's steps, which the room repeated to people, give way to the Memory pane's.
	// The v4 line is matched as rooms store it, dash included.
	4: [
		{ from: "only through the product's approved memory workflows (checkpoint, absorb, prune) \u2014 never silently.", to: "only when the user approves it in Memory, never silently." },
		{ from: "when no approved workflow ran; ordinary chat becomes durable memory only through those workflows.", to: "when the user approved nothing; ordinary chat becomes durable memory only that way." },
		{ from: "a note comes back into memory only through a Memorize or a Review the user approves.", to: "a note comes back only when the user approves it with Memorize or Review in Memory." },
	],
};

function constitutionUpgradeCandidate(agentId: PersistentAgentId, currentL1a: string, fromTemplateVersion: number, normalized: NormalizedPersistentAgentScaffoldInput): { l1a: string; inPlace: boolean } {
	let l1a = currentL1a;
	let version = fromTemplateVersion;
	while (L1A_IN_PLACE_STEPS[version] && version < PERSISTENT_AGENT_L1A_TEMPLATE_VERSION) {
		const swaps = L1A_IN_PLACE_STEPS[version];
		version += 1;
		l1a = l1a.replace(L1A_MARKER_PATTERN, (marker) => marker.replace(/template_version=\d+/, `template_version=${version}`));
		for (const swap of swaps) l1a = l1a.replace(swap.from, swap.to);
	}
	if (version === PERSISTENT_AGENT_L1A_TEMPLATE_VERSION && version !== fromTemplateVersion) return { l1a, inPlace: true };
	return { l1a: genericL1a(agentId, normalized), inPlace: false };
}

export function planPersistentAgentConstitutionUpgrade(agentIdRaw: string): PersistentAgentConstitutionUpgradePlan {
	const instance = createPersistentAgentInstance(agentIdRaw);
	const meta = instance.readAgentJson();
	if (!meta) throw new Error(`${instance.agentId}: agent.json is missing or invalid JSON`);
	const currentL1a = instance.readL1a(meta);
	const marker = parsePersistentAgentL1aMarker(currentL1a);
	const normalized = constitutionUpgradeScaffoldInput(instance, meta);
	const candidateL1a = constitutionUpgradeCandidate(instance.agentId, currentL1a, marker.templateVersion, normalized).l1a;
	return {
		agentId: instance.agentId,
		action: marker.templateVersion >= PERSISTENT_AGENT_L1A_TEMPLATE_VERSION ? "up_to_date" : "upgrade",
		fromTemplateVersion: marker.templateVersion,
		toTemplateVersion: PERSISTENT_AGENT_L1A_TEMPLATE_VERSION,
		mode: normalized.mode,
		currentL1aFingerprint: fingerprintL1bSource(currentL1a),
		currentL1aEstimatedTokens: estimateTokens(currentL1a),
		candidateL1aEstimatedTokens: estimateTokens(candidateL1a),
	};
}

export function upgradePersistentAgentConstitution(agentIdRaw: string, options: { now?: Date; gate?: PersistentAgentConstitutionUpgradeGate } = {}): PersistentAgentConstitutionUpgradeResult {
	const instance = createPersistentAgentInstance(agentIdRaw);
	const meta = instance.readAgentJson();
	if (!meta) throw new Error(`${instance.agentId}: agent.json is missing or invalid JSON`);
	assertConstitutionUpgradeAllowed(instance, meta, options.gate ?? "strict");

	const now = options.now ?? new Date();
	const currentL1a = instance.readL1a(meta);
	const plan = planPersistentAgentConstitutionUpgrade(instance.agentId);
	if (plan.action === "up_to_date") return { plan, upgradeId: null, archivedL1aRelPath: null, eventRecordRelPath: null };

	const normalized = constitutionUpgradeScaffoldInput(instance, meta);
	const { l1a: candidateL1a, inPlace } = constitutionUpgradeCandidate(instance.agentId, currentL1a, plan.fromTemplateVersion, normalized);
	const candidateFingerprint = fingerprintL1bSource(candidateL1a);

	const stamp = slugTimestamp(now);
	const upgradeId = `constitution_upgrade_${stamp}_${shortRandomId()}`;
	const archiveDir = path.join(instance.rootDir, "L1a-archive");
	const archivedL1aPath = path.join(archiveDir, `${stamp}-before-${upgradeId}.md`);
	const eventRecordPath = path.join(instance.rootDir, "events/constitution-upgrade", `${upgradeId}.json`);
	const l1aPath = instance.l1aPath(meta);
	const agentJsonPath = instance.agentJsonPath();

	ensureDir(archiveDir);
	ensureDir(path.dirname(eventRecordPath));
	writeFileAtomic(archivedL1aPath, currentL1a);
	writeFileAtomic(l1aPath, candidateL1a);
	const updatedMeta: AgentJson = {
		...(meta as AgentJson),
		mode: normalized.mode,
		updatedAt: now.getTime(),
	};
	writeFileAtomic(agentJsonPath, JSON.stringify(updatedMeta, null, 2) + "\n");

	const eventRecord = {
		schemaVersion: 1,
		operation: "constitution_upgrade",
		mutation: { target: "l1a", kind: inPlace ? "template_phrase" : "template_rerender" },
		agentId: instance.agentId,
		upgradeId,
		upgradedAt: now.toISOString(),
		fromTemplateVersion: plan.fromTemplateVersion,
		toTemplateVersion: plan.toTemplateVersion,
		mode: normalized.mode,
		source: { l1aFingerprint: plan.currentL1aFingerprint, estimatedTokens: plan.currentL1aEstimatedTokens },
		result: { l1aFingerprint: candidateFingerprint, estimatedTokens: estimateTokens(candidateL1a) },
		paths: {
			archivedL1a: path.relative(instance.rootDir, archivedL1aPath),
			l1a: path.relative(instance.rootDir, l1aPath),
			eventRecord: path.relative(instance.rootDir, eventRecordPath),
		},
	};
	writeFileAtomic(eventRecordPath, JSON.stringify(eventRecord, null, 2) + "\n");

	return {
		plan: { ...plan },
		upgradeId,
		archivedL1aRelPath: eventRecord.paths.archivedL1a,
		eventRecordRelPath: eventRecord.paths.eventRecord,
	};
}

export { collapseHumanWhitespace };
