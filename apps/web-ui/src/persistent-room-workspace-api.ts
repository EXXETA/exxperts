import { apiFetch } from "./api";
import type {
	PersistentRoomWorkspaceDefaultInput,
	PersistentRoomWorkspaceDefaultResponse,
	PersistentRoomWorkspaceTreeResponse,
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
	const response = await apiFetch(input, init);
	const payload = await readJsonOrText(response);
	if (!response.ok) {
		// The server's code travels with its words, so the pane can show a refusal by what it is about.
		const code = payload && typeof payload === "object" ? (payload as { code?: unknown }).code : undefined;
		throw Object.assign(new Error(parsePersistentRoomWorkspaceError(payload, fallbackError)), typeof code === "string" ? { code } : {});
	}
	return payload as T;
}

function workspaceDefaultUrl(agentId: string): string {
	return `/api/persistent-agents/${encodeURIComponent(agentId)}/workspace-default`;
}

export async function fetchPersistentRoomWorkspaceTree(
	agentId: string,
	conversationId: string,
	path = ".",
	cursor?: string,
): Promise<PersistentRoomWorkspaceTreeResponse> {
	const params = new URLSearchParams({ conversationId, path });
	if (cursor !== undefined) params.set("cursor", cursor);
	const url = `/api/persistent-agents/${encodeURIComponent(agentId)}/workspace-tree?${params.toString()}`;
	return fetchJson<PersistentRoomWorkspaceTreeResponse>(url, undefined, "Failed to load workspace files.");
}

export async function fetchPersistentRoomWorkspaceDefault(agentId: string): Promise<PersistentRoomWorkspaceDefaultResponse> {
	return fetchJson<PersistentRoomWorkspaceDefaultResponse>(workspaceDefaultUrl(agentId), undefined, "Couldn't load this room's workspace.");
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
				toolSelection: input.toolSelection,
				bashEnabled: input.bashEnabled,
			}),
		},
		"Couldn't save the workspace. Try again."
	);
}

export async function clearPersistentRoomWorkspaceDefault(agentId: string): Promise<PersistentRoomWorkspaceDefaultResponse> {
	return fetchJson<PersistentRoomWorkspaceDefaultResponse>(
		workspaceDefaultUrl(agentId),
		{ method: "DELETE" },
		"Couldn't clear the workspace. Try again."
	);
}

/** What the folder is for; the server turns it into the line the native dialog shows. */
export type SystemChooseFolderPurpose = "workspace" | "data-folder";

export async function chooseSystemFolder(purpose: SystemChooseFolderPurpose = "workspace"): Promise<SystemChooseFolderResponse> {
	return fetchJson<SystemChooseFolderResponse>(
		"/api/system/choose-folder",
		{
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"X-Exxperts-Local-Action": "choose-folder",
			},
			body: JSON.stringify({ purpose }),
		},
		"Folder chooser failed. Enter the path manually."
	);
}
