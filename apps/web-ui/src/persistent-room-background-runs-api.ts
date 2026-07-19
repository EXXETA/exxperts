import { redirectToSignInOn401 } from "./api";
import { parsePersistentRoomSchedulesError } from "./persistent-room-schedules-api";
import type {
	PersistentAgentId,
	PersistentRoomBackgroundRunsResponse,
	PersistentRoomBackgroundRunStatus,
} from "./types";

export interface PersistentRoomBackgroundRunsQuery {
	limit?: number;
	scheduleId?: string;
	status?: PersistentRoomBackgroundRunStatus;
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

function persistentRoomBackgroundRunsUrl(agentId: PersistentAgentId, query: PersistentRoomBackgroundRunsQuery = {}): string {
	const params = new URLSearchParams();
	if (typeof query.limit === "number") params.set("limit", String(query.limit));
	if (query.scheduleId?.trim()) params.set("scheduleId", query.scheduleId.trim());
	if (query.status) params.set("status", query.status);
	const suffix = params.toString();
	return `/api/persistent-agents/${encodeURIComponent(agentId)}/background-runs${suffix ? `?${suffix}` : ""}`;
}

export async function fetchPersistentRoomBackgroundRuns(
	agentId: PersistentAgentId,
	query: PersistentRoomBackgroundRunsQuery = {},
): Promise<PersistentRoomBackgroundRunsResponse> {
	return fetchJson<PersistentRoomBackgroundRunsResponse>(
		persistentRoomBackgroundRunsUrl(agentId, query),
		undefined,
		"Failed to load recent scheduled runs.",
	);
}
