import { redirectToSignInOn401 } from "./api";
import type {
	PersistentAgentId,
	PersistentRoomScheduleCreateRequest,
	PersistentRoomScheduleManagementResponse,
	PersistentRoomSchedulesResponse,
	PersistentRoomScheduleUpdateRequest,
} from "./types";

export function parsePersistentRoomSchedulesError(payload: unknown, fallback = "Failed to load scheduled tasks."): string {
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
	if (!response.ok) throw new Error(parsePersistentRoomSchedulesError(payload, fallbackError));
	return payload as T;
}

function persistentRoomSchedulesUrl(agentId: PersistentAgentId): string {
	return `/api/persistent-agents/${encodeURIComponent(agentId)}/schedules`;
}

function persistentRoomScheduleUrl(agentId: PersistentAgentId, jobId: string): string {
	return `${persistentRoomSchedulesUrl(agentId)}/${encodeURIComponent(jobId)}`;
}

export async function fetchPersistentRoomSchedules(agentId: PersistentAgentId): Promise<PersistentRoomSchedulesResponse> {
	return fetchJson<PersistentRoomSchedulesResponse>(persistentRoomSchedulesUrl(agentId), undefined, "Failed to load scheduled tasks.");
}

export async function createPersistentRoomSchedule(
	agentId: PersistentAgentId,
	input: PersistentRoomScheduleCreateRequest,
): Promise<PersistentRoomScheduleManagementResponse> {
	return fetchJson<PersistentRoomScheduleManagementResponse>(
		persistentRoomSchedulesUrl(agentId),
		{
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(input),
		},
		"Failed to save scheduled task.",
	);
}

export async function updatePersistentRoomSchedule(
	agentId: PersistentAgentId,
	jobId: string,
	patch: PersistentRoomScheduleUpdateRequest,
): Promise<PersistentRoomScheduleManagementResponse> {
	return fetchJson<PersistentRoomScheduleManagementResponse>(
		persistentRoomScheduleUrl(agentId, jobId),
		{
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(patch),
		},
		"Failed to update scheduled task.",
	);
}

export async function deletePersistentRoomSchedule(
	agentId: PersistentAgentId,
	jobId: string,
): Promise<PersistentRoomScheduleManagementResponse> {
	return fetchJson<PersistentRoomScheduleManagementResponse>(
		persistentRoomScheduleUrl(agentId, jobId),
		{ method: "DELETE" },
		"Failed to delete scheduled task.",
	);
}
