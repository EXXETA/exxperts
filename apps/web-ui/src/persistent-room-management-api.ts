import { apiFetch } from "./api";
import { McpRequestError } from "./mcp-api";
import type { ArchivedPersistentAgentSummary, PersistentAgentArchiveRequest, PersistentAgentArchiveResponse, PersistentAgentId, PersistentAgentLifecycleCounts, PersistentAgentPurgeBusyReason, PersistentAgentPurgeResponse, PersistentAgentRenameResponse, PersistentAgentRestoreResponse, PersistentRoomProtection } from "./types";

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
	const response = await apiFetch(input, init);
	const payload = await readJsonOrText(response);
	if (!response.ok) throw new Error(parsePersistentRoomManagementError(payload, fallbackError));
	return payload as T;
}

// Not fetchJson: like purge, the archive error carries a machine-readable busy
// reason — the caller retries briefly on its own just-released room lock.
export async function archivePersistentRoom(agentId: PersistentAgentId, request: PersistentAgentArchiveRequest): Promise<PersistentAgentArchiveResponse> {
	const response = await apiFetch(`/api/persistent-agents/${encodeURIComponent(agentId)}/archive`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(request),
	});
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
	const response = await apiFetch(`/api/persistent-agents/${encodeURIComponent(agentId)}/purge`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ confirmation }),
	});
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

/** `counts` is null when a part of the room could not be read: no number is better than a wrong 0. */
export function fetchPersistentRoomLifecycleCounts(agentId: PersistentAgentId): Promise<{ agentId: PersistentAgentId; counts: PersistentAgentLifecycleCounts | null }> {
	return fetchJson<{ agentId: PersistentAgentId; counts: PersistentAgentLifecycleCounts | null }>(
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
	/** Commands run without asking: Semi and Auto alike. */
	autoApprove: boolean;
	/** Auto in a protected room: public websites are reached without asking too. Only while the room is protected; absent from an older server. */
	free?: true;
	updatedAt: string;
}

export interface PersistentRoomBashSettingsResponse {
	agentId: PersistentAgentId;
	settings: PersistentRoomBashSettings;
	/** Absent on a shared server and on an older server. */
	protection?: PersistentRoomProtection;
}

export function fetchPersistentRoomBashSettings(agentId: PersistentAgentId): Promise<PersistentRoomBashSettingsResponse> {
	return fetchJson<PersistentRoomBashSettingsResponse>(
		`/api/persistent-agents/${encodeURIComponent(agentId)}/bash-settings`,
		undefined,
		"Failed to load bash approval settings."
	);
}

/** `protection` is the one the page last read: the server refuses a write for another, or with none. `free` goes with `autoApprove` true, in a protected room. */
export function updatePersistentRoomBashSettings(agentId: PersistentAgentId, update: { autoApprove?: boolean; free?: boolean; protection: PersistentRoomProtection | undefined }): Promise<PersistentRoomBashSettingsResponse> {
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
	settings: { schemaVersion: 1; enabledSkills: { name: string; sha256: string }[]; updatedAt: string };
	skills: PersistentRoomEnabledSkillStatus[];
}

export function fetchPersistentRoomSkillSettings(agentId: PersistentAgentId): Promise<PersistentRoomSkillSettingsResponse> {
	return fetchJson<PersistentRoomSkillSettingsResponse>(
		`/api/persistent-agents/${encodeURIComponent(agentId)}/skill-settings`,
		undefined,
		"Failed to load room skill settings."
	);
}

export function updatePersistentRoomSkillSetting(agentId: PersistentAgentId, action: "enable" | "disable" | "approve-execution" | "revoke-execution", name: string): Promise<PersistentRoomSkillSettingsResponse> {
	return fetchJson<PersistentRoomSkillSettingsResponse>(
		`/api/persistent-agents/${encodeURIComponent(agentId)}/skill-settings`,
		{
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ action, name }),
		},
		"Failed to update room skill settings."
	);
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
	/** Each connector's name as typed, where one was given (no address or command). */
	displayNames?: Record<string, string>;
	granted: PersistentRoomGrantedConnectorStatus[];
	/** The tools each enabled connector may use without asking, by their own name and as people read them; never on a shared server. */
	allowedTools?: Record<string, Array<{ tool: string; shown: string }>>;
}

/** A room's connectors; a refusal carries its status, which the pane words it by. */
async function roomConnectorsRequest(agentId: PersistentAgentId, init: RequestInit | undefined, fallbackError: string): Promise<PersistentRoomMcpConnectorsResponse> {
	const response = await apiFetch(`/api/persistent-agents/${encodeURIComponent(agentId)}/mcp-connectors`, init);
	const payload = await readJsonOrText(response);
	if (!response.ok) throw new McpRequestError(parsePersistentRoomManagementError(payload, fallbackError), response.status);
	return payload as PersistentRoomMcpConnectorsResponse;
}

export function fetchPersistentRoomMcpConnectors(agentId: PersistentAgentId): Promise<PersistentRoomMcpConnectorsResponse> {
	return roomConnectorsRequest(agentId, undefined, "Failed to load room connector settings.");
}

/** Turns a connector on or off for the room, or with `forget-tool` takes back the room's yes to its `tool`. */
export function updatePersistentRoomMcpConnector(agentId: PersistentAgentId, action: "grant" | "revoke" | "forget-tool", name: string, tool?: string): Promise<PersistentRoomMcpConnectorsResponse> {
	return roomConnectorsRequest(agentId, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action, name, ...(tool === undefined ? {} : { tool }) }) }, "Failed to update room connector settings.");
}
