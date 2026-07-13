import type { PersistentAgentArchiveRequest, PersistentAgentArchiveResponse, PersistentAgentId, PersistentAgentRenameResponse } from "./types";

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
	const payload = await readJsonOrText(response);
	if (!response.ok) throw new Error(parsePersistentRoomManagementError(payload, fallbackError));
	return payload as T;
}

export function archivePersistentRoom(agentId: PersistentAgentId, request: PersistentAgentArchiveRequest): Promise<PersistentAgentArchiveResponse> {
	return fetchJson<PersistentAgentArchiveResponse>(
		`/api/persistent-agents/${encodeURIComponent(agentId)}/archive`,
		{
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(request),
		},
		"Failed to delete room."
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

export function updatePersistentRoomMaintenanceSettings(agentId: PersistentAgentId, update: { fastPathSecondApproval?: boolean; memoryBudgetTokens?: number }): Promise<PersistentRoomMaintenanceSettingsResponse> {
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
