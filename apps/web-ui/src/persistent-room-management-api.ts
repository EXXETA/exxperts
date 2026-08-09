import { redirectToSignInOn401 } from "./api";
import type { ArchivedPersistentAgentSummary, PersistentAgentArchiveRequest, PersistentAgentArchiveResponse, PersistentAgentId, PersistentAgentLifecycleCounts, PersistentAgentPurgeBusyReason, PersistentAgentPurgeResponse, PersistentAgentRenameResponse, PersistentAgentRestoreResponse } from "./types";

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

// ── Skills MR-5: per-room skill enablement (spec §4/§5) ──────────────────────

export interface PersistentRoomEnabledSkillStatus {
	name: string;
	sha256: string;
	currentSha256: string | null;
	status: "ok" | "hash-mismatch" | "missing";
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

export function updatePersistentRoomSkillSetting(agentId: PersistentAgentId, action: "enable" | "disable", name: string): Promise<PersistentRoomSkillSettingsResponse> {
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
