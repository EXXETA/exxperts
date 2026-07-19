import { redirectToSignInOn401 } from "./api";
import type {
	PersistentRoomWorkspaceClearResponse,
	PersistentRoomWorkspaceDefaultInput,
	PersistentRoomWorkspaceDefaultResponse,
	PersistentRoomWorkspacePolicyResponse,
	PersistentRoomWorkspaceValidateResponse,
	SystemChooseFolderResponse,
} from "./types";

export function parsePersistentRoomWorkspaceError(payload: unknown, fallback = "Workspace request failed."): string {
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
	if (!response.ok) throw new Error(parsePersistentRoomWorkspaceError(payload, fallbackError));
	return payload as T;
}

function workspacePolicyUrl(agentId: string, conversationId: string): string {
	const params = new URLSearchParams({ conversationId });
	return `/api/persistent-agents/${encodeURIComponent(agentId)}/workspace-policy?${params.toString()}`;
}

function workspaceDefaultUrl(agentId: string): string {
	return `/api/persistent-agents/${encodeURIComponent(agentId)}/workspace-default`;
}

export async function fetchPersistentRoomWorkspacePolicy(agentId: string, conversationId: string): Promise<PersistentRoomWorkspacePolicyResponse> {
	return fetchJson<PersistentRoomWorkspacePolicyResponse>(workspacePolicyUrl(agentId, conversationId), undefined, "Failed to load workspace policy.");
}

export async function validatePersistentRoomWorkspace(input: {
	agentId: string;
	conversationId: string;
	root: string;
	displayLabel?: string;
	workspaceAccessMode?: "bounded" | "localFiles";
	bashEnabled?: boolean;
}): Promise<PersistentRoomWorkspaceValidateResponse> {
	return fetchJson<PersistentRoomWorkspaceValidateResponse>(
		`/api/persistent-agents/${encodeURIComponent(input.agentId)}/workspace/validate`,
		{
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				conversationId: input.conversationId,
				root: input.root,
				displayLabel: input.displayLabel,
				workspaceAccessMode: input.workspaceAccessMode,
				bashEnabled: input.bashEnabled,
				mode: "read",
				source: "manual",
			}),
		},
		"Failed to validate workspace."
	);
}

export async function clearPersistentRoomWorkspacePolicy(agentId: string, conversationId: string): Promise<PersistentRoomWorkspaceClearResponse> {
	return fetchJson<PersistentRoomWorkspaceClearResponse>(
		workspacePolicyUrl(agentId, conversationId),
		{ method: "DELETE" },
		"Failed to disconnect workspace."
	);
}

export async function fetchPersistentRoomWorkspaceDefault(agentId: string): Promise<PersistentRoomWorkspaceDefaultResponse> {
	return fetchJson<PersistentRoomWorkspaceDefaultResponse>(workspaceDefaultUrl(agentId), undefined, "Failed to load workspace default.");
}

export async function savePersistentRoomWorkspaceDefault(agentId: string, input: PersistentRoomWorkspaceDefaultInput): Promise<PersistentRoomWorkspaceDefaultResponse> {
	return fetchJson<PersistentRoomWorkspaceDefaultResponse>(
		workspaceDefaultUrl(agentId),
		{
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				root: input.root,
				displayLabel: input.displayLabel,
				workspaceAccessMode: input.workspaceAccessMode,
				mode: input.mode ?? "read",
				toolSelection: input.toolSelection,
				bashEnabled: input.bashEnabled,
			}),
		},
		"Failed to save workspace default."
	);
}

export async function clearPersistentRoomWorkspaceDefault(agentId: string): Promise<PersistentRoomWorkspaceDefaultResponse> {
	return fetchJson<PersistentRoomWorkspaceDefaultResponse>(
		workspaceDefaultUrl(agentId),
		{ method: "DELETE" },
		"Failed to clear workspace default."
	);
}

export async function chooseSystemFolder(): Promise<SystemChooseFolderResponse> {
	return fetchJson<SystemChooseFolderResponse>(
		"/api/system/choose-folder",
		{
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"X-Exxperts-Local-Action": "choose-folder",
			},
			body: "{}",
		},
		"Folder chooser failed. Enter the path manually."
	);
}
