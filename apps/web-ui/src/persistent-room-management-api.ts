import { redirectToSignInOn401 } from "./api";
import type { ArchivedPersistentAgentSummary, PersistentAgentArchiveRequest, PersistentAgentArchiveResponse, PersistentAgentId, PersistentAgentLifecycleCounts, PersistentAgentPurgeBusyReason, PersistentAgentPurgeResponse, PersistentAgentRenameResponse, PersistentAgentRestoreResponse } from "./types";
import type { SkillDetail } from "./skills-api";
import type { SkillReference } from "./skills-repo-api";
import { createDisplayCache, invalidateDisplayCaches } from "./display-cache";

const PURGE_BUSY_REASONS: readonly PersistentAgentPurgeBusyReason[] = ["room_lock", "turn_in_flight", "detached_cooking", "specialist_running"];

/** Error thrown by purgePersistentRoom, carrying the server's machine-readable busy reason when it sent one. */
export interface PersistentRoomPurgeError extends Error {
	reason?: PersistentAgentPurgeBusyReason;
}

function parsePersistentRoomManagementError(payload: unknown, fallback = "Room management request failed."): string {
	if (payload && typeof payload === "object") {
		const error = (payload as { error?: unknown }).error;
		if (typeof error === "string" && error.trim()) return error.trim();
		const message = (payload as { message?: unknown }).message;
		if (typeof message === "string" && message.trim()) return message.trim();
	}
	if (typeof payload === "string" && payload.trim()) return payload.trim();
	return fallback;
}

async function readJsonOrText(response: Response): Promise<unknown> {
	const text = await response.text();
	if (!text.trim()) return null;
	try {
		return JSON.parse(text);
	} catch {
		return text;
	}
}

async function fetchJson<T>(input: RequestInfo | URL, init?: RequestInit, fallbackError?: string): Promise<T> {
	const response = await fetch(input, init);
	redirectToSignInOn401(response);
	const payload = await readJsonOrText(response);
	if (!response.ok) throw new Error(parsePersistentRoomManagementError(payload, fallbackError));
	if (init?.method === "PUT" && String(input).endsWith("/skill-settings")) window.dispatchEvent(new window.Event("skill-libraries-changed"));
	return payload as T;
}

// Not fetchJson: like purge, the archive error carries a machine-readable busy
// reason — the caller retries briefly on its own just-released room lock.
export async function archivePersistentRoom(agentId: PersistentAgentId, request: PersistentAgentArchiveRequest): Promise<PersistentAgentArchiveResponse> {
	const response = await fetch(`/api/persistent-agents/${encodeURIComponent(agentId)}/archive`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(request),
	});
	redirectToSignInOn401(response);
	const payload = await readJsonOrText(response);
	if (!response.ok) {
		const error: PersistentRoomPurgeError = new Error(parsePersistentRoomManagementError(payload, "Failed to delete room."));
		const reason = payload && typeof payload === "object" ? (payload as { reason?: unknown }).reason : undefined;
		if (typeof reason === "string" && (PURGE_BUSY_REASONS as readonly string[]).includes(reason)) error.reason = reason as PersistentAgentPurgeBusyReason;
		throw error;
	}
	return payload as PersistentAgentArchiveResponse;
}

export function restorePersistentRoom(agentId: PersistentAgentId): Promise<PersistentAgentRestoreResponse> {
	return fetchJson<PersistentAgentRestoreResponse>(
		`/api/persistent-agents/${encodeURIComponent(agentId)}/restore`,
		{ method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({}) },
		"Failed to restore room."
	);
}

// Not fetchJson: the purge error carries a machine-readable busy reason the
// caller needs — its own just-released lock is worth a short retry, a room
// genuinely busy elsewhere is not.
export async function purgePersistentRoom(agentId: PersistentAgentId, confirmation: string): Promise<PersistentAgentPurgeResponse> {
	const response = await fetch(`/api/persistent-agents/${encodeURIComponent(agentId)}/purge`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ confirmation }),
	});
	redirectToSignInOn401(response);
	const payload = await readJsonOrText(response);
	if (!response.ok) {
		const error: PersistentRoomPurgeError = new Error(parsePersistentRoomManagementError(payload, "Failed to delete room."));
		const reason = payload && typeof payload === "object" ? (payload as { reason?: unknown }).reason : undefined;
		if (typeof reason === "string" && (PURGE_BUSY_REASONS as readonly string[]).includes(reason)) error.reason = reason as PersistentAgentPurgeBusyReason;
		throw error;
	}
	return payload as PersistentAgentPurgeResponse;
}

export function fetchArchivedPersistentRooms(): Promise<ArchivedPersistentAgentSummary[]> {
	return fetchJson<ArchivedPersistentAgentSummary[]>("/api/persistent-agents/archived", undefined, "Failed to load archived rooms.");
}

export function fetchPersistentRoomLifecycleCounts(agentId: PersistentAgentId): Promise<{ agentId: PersistentAgentId; counts: PersistentAgentLifecycleCounts }> {
	return fetchJson<{ agentId: PersistentAgentId; counts: PersistentAgentLifecycleCounts }>(
		`/api/persistent-agents/${encodeURIComponent(agentId)}/lifecycle-counts`,
		undefined,
		"Failed to load room contents."
	);
}

export function renamePersistentRoom(agentId: PersistentAgentId, displayName: string, options: { dryRun?: boolean } = {}): Promise<PersistentAgentRenameResponse> {
	return fetchJson<PersistentAgentRenameResponse>(
		`/api/persistent-agents/${encodeURIComponent(agentId)}/rename`,
		{
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ displayName, ...(options.dryRun ? { dryRun: true } : {}) }),
		},
		"Failed to rename room."
	);
}

export interface PersistentRoomMaintenanceSettings {
	schemaVersion: 1;
	fastPathSecondApproval: boolean;
	quickCheckpointAutoApply: boolean;
	memoryBudgetTokens: number;
	/** the budget has met the room's own memory once: a room from 0.11.2 with the default budget started at its size, every other room kept what it had */
	memoryBudgetSettled?: boolean;
	/** the budget the settle chose when it resized this room's budget on coming to 0.12; absent otherwise */
	memoryBudgetSettledTo?: number;
	updatedAt: string;
}

export interface PersistentRoomMaintenanceSettingsResponse {
	agentId: PersistentAgentId;
	settings: PersistentRoomMaintenanceSettings;
}

export function fetchPersistentRoomMaintenanceSettings(agentId: PersistentAgentId): Promise<PersistentRoomMaintenanceSettingsResponse> {
	return fetchJson<PersistentRoomMaintenanceSettingsResponse>(
		`/api/persistent-agents/${encodeURIComponent(agentId)}/maintenance-settings`,
		undefined,
		"Failed to load memory maintenance settings."
	);
}

export function updatePersistentRoomMaintenanceSettings(agentId: PersistentAgentId, update: { fastPathSecondApproval?: boolean; quickCheckpointAutoApply?: boolean; memoryBudgetTokens?: number }): Promise<PersistentRoomMaintenanceSettingsResponse> {
	return fetchJson<PersistentRoomMaintenanceSettingsResponse>(
		`/api/persistent-agents/${encodeURIComponent(agentId)}/maintenance-settings`,
		{
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(update),
		},
		"Failed to save memory maintenance settings."
	);
}

/** The refusal saving this memory budget would get with the room's Memory model as it is now, or null when it would save; nothing is saved. */
export async function checkPersistentRoomMemoryBudget(agentId: PersistentAgentId, memoryBudgetTokens: number): Promise<string | null> {
	const response = await fetchJson<PersistentRoomMaintenanceSettingsResponse & { budgetRefusal?: string | null }>(
		`/api/persistent-agents/${encodeURIComponent(agentId)}/maintenance-settings`,
		{
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ memoryBudgetTokens, dryRun: true }),
		},
		"Failed to check the memory budget."
	);
	return response.budgetRefusal ?? null;
}

export interface PersistentRoomBashSettings {
	schemaVersion: 1;
	autoApprove: boolean;
	updatedAt: string;
}

export interface PersistentRoomBashSettingsResponse {
	agentId: PersistentAgentId;
	settings: PersistentRoomBashSettings;
}

export function fetchPersistentRoomBashSettings(agentId: PersistentAgentId): Promise<PersistentRoomBashSettingsResponse> {
	return fetchJson<PersistentRoomBashSettingsResponse>(
		`/api/persistent-agents/${encodeURIComponent(agentId)}/bash-settings`,
		undefined,
		"Failed to load bash approval settings."
	);
}

export function updatePersistentRoomBashSettings(agentId: PersistentAgentId, update: { autoApprove?: boolean }): Promise<PersistentRoomBashSettingsResponse> {
	return fetchJson<PersistentRoomBashSettingsResponse>(
		`/api/persistent-agents/${encodeURIComponent(agentId)}/bash-settings`,
		{
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(update),
		},
		"Failed to save bash approval settings."
	);
}

// ── Skills MR-5: per-room skill enablement (spec §4/§5) ──────────────────────

export interface PersistentRoomEnabledSkillStatus {
	name: string;
	/** The name the Skills pane shows, when the library still holds the skill. */
	displayName?: string;
	sha256: string;
	currentSha256: string | null;
	packageSha256?: string;
	currentPackageSha256?: string | null;
	status: "ok" | "hash-mismatch" | "missing";
	/** Execution approval in this room, pinned to the skill's whole-content digest:
	 *  "none" (never approved), "approved" (this exact version may run its files),
	 *  "drifted" (approved once, but the files changed since). */
	executeState: "none" | "approved" | "drifted";
	/** GET view only: whether this skill can be approved for execution at all. */
	executable?: boolean;
	/** GET view only: the files bundled next to SKILL.md (SKILL.md excluded). */
	bundledFiles?: string[];
	/** GET view only: the author marked this skill for manual invocation only, so
	 *  the model never auto-runs it. Rooms have no manual trigger yet, so it is
	 *  inert once enabled; the UI says so. */
	manualOnly?: boolean;
}

export interface PersistentRoomSkillSettingsResponse {
	agentId: PersistentAgentId;
	settings: { schemaVersion: 1; enabledSkills: { name: string; sha256: string; packageSha256?: string }[]; enabledSources?: PersistentRoomSourceGrant[]; updatedAt: string };
	skills: PersistentRoomEnabledSkillStatus[];
	sources?: PersistentRoomEnabledSourceStatus[];
}

export interface PersistentRoomSourceGrant {
	libraryId: string;
	materialsSha256: string;
	skills: Array<{ name: string; sha256: string; packageSha256: string }>;
	excludedSkills: string[];
}

export interface PersistentRoomEnabledSourceStatus {
	libraryId: string;
	name: string;
	source: string;
	materialsSha256: string;
	currentMaterialsSha256: string | null;
	materialCount: number;
	skills: string[];
	excludedSkills: string[];
	status: "ok" | "review-required" | "missing";
}

export interface PersistentRoomSourceReview {
	libraryId: string;
	name: string;
	source: string;
	revision?: string;
	materialsSha256: string;
	materials: SkillReference[];
	skills: SkillDetail[];
}

export function fetchPersistentRoomSourceReview(agentId: PersistentAgentId, libraryId: string): Promise<PersistentRoomSourceReview> {
	return fetchJson(`/api/persistent-agents/${encodeURIComponent(agentId)}/skill-sources/${encodeURIComponent(libraryId)}/review`, undefined, "Failed to load source review.");
}

export async function updatePersistentRoomSourceSetting(agentId: PersistentAgentId, mutation: ({ action: "enable-source" } & PersistentRoomSourceGrant) | { action: "disable-source"; libraryId: string } | { action: "exclude-source-skill"; libraryId: string; name: string; excluded: boolean }): Promise<PersistentRoomSkillSettingsResponse> {
	const result = await fetchJson<PersistentRoomSkillSettingsResponse>(`/api/persistent-agents/${encodeURIComponent(agentId)}/skill-settings?view=summary`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(mutation) }, "Failed to update room source settings.");
	invalidateDisplayCaches();
	await roomSkillCache(agentId).load(() => Promise.resolve(result));
	return result;
}

const roomSkillCaches = new Map<string, ReturnType<typeof createDisplayCache<PersistentRoomSkillSettingsResponse>>>();
function roomSkillCache(agentId: string) {
	let cache = roomSkillCaches.get(agentId);
	if (!cache) { cache = createDisplayCache<PersistentRoomSkillSettingsResponse>(); roomSkillCaches.set(agentId, cache); }
	return cache;
}
export const peekPersistentRoomSkillSettings = (agentId: PersistentAgentId) => roomSkillCache(agentId).peek();

export function fetchPersistentRoomSkillSettings(agentId: PersistentAgentId): Promise<PersistentRoomSkillSettingsResponse> {
	return roomSkillCache(agentId).load(() => fetchJson<PersistentRoomSkillSettingsResponse>(
		`/api/persistent-agents/${encodeURIComponent(agentId)}/skill-settings?view=summary`,
		undefined,
		"Failed to load room skill settings."
	), true);
}

export async function updatePersistentRoomSkillSetting(agentId: PersistentAgentId, action: "enable" | "disable" | "approve-execution" | "revoke-execution", name: string, reviewed?: { sha256?: string; packageSha256?: string }): Promise<PersistentRoomSkillSettingsResponse> {
	const result = await fetchJson<PersistentRoomSkillSettingsResponse>(
		`/api/persistent-agents/${encodeURIComponent(agentId)}/skill-settings?view=summary`,
		{
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ action, name, ...reviewed }),
		},
		"Failed to update room skill settings."
	);
	invalidateDisplayCaches();
	await roomSkillCache(agentId).load(() => Promise.resolve(result));
	return result;
}

// ── Per-room MCP: connector grants ───────────────────────────────────────────

export interface PersistentRoomGrantedConnectorStatus {
	name: string;
	/** False when the connector is no longer globally configured. */
	configured: boolean;
}

export interface PersistentRoomMcpConnectorsResponse {
	agentId: PersistentAgentId;
	settings: { schemaVersion: 1; grantedConnectors: string[]; updatedAt: string };
	configuredConnectors: string[];
	granted: PersistentRoomGrantedConnectorStatus[];
}

export function fetchPersistentRoomMcpConnectors(agentId: PersistentAgentId): Promise<PersistentRoomMcpConnectorsResponse> {
	return fetchJson<PersistentRoomMcpConnectorsResponse>(
		`/api/persistent-agents/${encodeURIComponent(agentId)}/mcp-connectors`,
		undefined,
		"Failed to load room connector settings."
	);
}

export function updatePersistentRoomMcpConnector(agentId: PersistentAgentId, action: "grant" | "revoke", name: string): Promise<PersistentRoomMcpConnectorsResponse> {
	return fetchJson<PersistentRoomMcpConnectorsResponse>(
		`/api/persistent-agents/${encodeURIComponent(agentId)}/mcp-connectors`,
		{
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ action, name }),
		},
		"Failed to update room connector settings."
	);
}
