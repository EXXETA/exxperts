import { ALSO_ALLOWED_LOAD_FAILED } from "../../web-server/src/room-box/card-text";
import { apiFetch } from "./api";
import type {
	PersistentRoomProtection,
	PersistentRoomWorkspaceDefaultInput,
	PersistentRoomWorkspaceDefaultResponse,
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

export async function fetchPersistentRoomWorkspaceDefault(agentId: string): Promise<PersistentRoomWorkspaceDefaultResponse> {
	return fetchJson<PersistentRoomWorkspaceDefaultResponse>(workspaceDefaultUrl(agentId), undefined, "Couldn't load this room's folder.");
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
		"Couldn't save the folder. Try again."
	);
}

export async function clearPersistentRoomWorkspaceDefault(agentId: string): Promise<PersistentRoomWorkspaceDefaultResponse> {
	return fetchJson<PersistentRoomWorkspaceDefaultResponse>(
		workspaceDefaultUrl(agentId),
		{ method: "DELETE" },
		"Couldn't clear the folder. Try again."
	);
}

/** What the folder is for; the server turns it into the line the native dialog shows. */
export type SystemChooseFolderPurpose = "workspace" | "data-folder" | "save-to";

/** The route's codes for a computer with no folder window: the path is typed instead. */
export const NO_FOLDER_WINDOW_CODES: ReadonlySet<string> = new Set(["unsupported_platform", "folder_chooser_unavailable"]);

/** Waits as long as the window is open; `signal` closes it. */
export async function chooseSystemFolder(purpose: SystemChooseFolderPurpose = "workspace", signal?: AbortSignal): Promise<SystemChooseFolderResponse> {
	return fetchJson<SystemChooseFolderResponse>(
		"/api/system/choose-folder",
		{
			method: "POST",
			...(signal ? { signal } : {}),
			headers: {
				"Content-Type": "application/json",
				"X-Exxperts-Local-Action": "choose-folder",
			},
			body: JSON.stringify({ purpose }),
		},
		"Folder chooser failed. Enter the path manually."
	);
}

/** One folder on a room's Also allowed list. A page away from the computer gets no path. */
export interface AlsoAllowedFolderView {
	name: string;
	access: "read" | "write";
	path?: string;
	/** Whether Allow changes can widen this Can read folder. */
	canAllowChanges: boolean;
}
export interface AlsoAllowedList {
	folders: AlsoAllowedFolderView[];
	sites: { host: string; port: number }[];
}
/** What Add a folder… came to: a refused pick carries the line to show. */
export type AlsoAllowedAddResponse = { list: AlsoAllowedList } & ({ state: "added"; name: string } | { state: "already" | "refused"; line: string } | { state: "unchanged" });
/** What the cross took off, for its line and Undo; `stillReadThrough` names the row that still lets the room read it. */
export type AlsoAllowedRemoveResponse = { list: AlsoAllowedList; stillReadThrough?: string; removed: { kind: "folder"; name: string; path: string; access: "read" | "write" } | { kind: "site"; host: string; port: number } };
/** A list entry by what the server knows it by: a folder's path, or a site's host and port. */
export type AlsoAllowedEntryName = { path: string } | { host: string; port: number };

function alsoAllowedUrl(agentId: string, tail = ""): string {
	return `/api/persistent-agents/${encodeURIComponent(agentId)}/also-allowed${tail}`;
}

const postJson = (body: unknown): RequestInit => ({ method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

export async function fetchAlsoAllowed(agentId: string): Promise<AlsoAllowedList> {
	return fetchJson<AlsoAllowedList>(alsoAllowedUrl(agentId), undefined, ALSO_ALLOWED_LOAD_FAILED);
}

/** Add a folder…: the server opens the computer's own folder window; the page sends no path. */
export async function addAlsoAllowedFolder(agentId: string): Promise<AlsoAllowedAddResponse> {
	const asked = postJson({});
	// The server opens its window only for the app's own page.
	return fetchJson<AlsoAllowedAddResponse>(alsoAllowedUrl(agentId, "/folders"), { ...asked, headers: { ...(asked.headers as Record<string, string>), "X-Exxperts-Local-Action": "choose-folder" } });
}

export async function setAlsoAllowedAccess(agentId: string, path: string, access: "read" | "write"): Promise<{ list: AlsoAllowedList }> {
	return fetchJson<{ list: AlsoAllowedList }>(alsoAllowedUrl(agentId, "/access"), postJson({ path, access }));
}

export async function removeAlsoAllowed(agentId: string, entry: AlsoAllowedEntryName): Promise<AlsoAllowedRemoveResponse> {
	return fetchJson<AlsoAllowedRemoveResponse>(alsoAllowedUrl(agentId, "/remove"), postJson(entry));
}

/** Undo after the cross: the server puts back what it kept. */
export async function restoreAlsoAllowed(agentId: string, entry: AlsoAllowedEntryName): Promise<{ list: AlsoAllowedList }> {
	return fetchJson<{ list: AlsoAllowedList }>(alsoAllowedUrl(agentId, "/restore"), postJson(entry));
}

/** Turn off (after its confirm) or Turn on, from the Folder pane at the computer. The answer is the room's protection now. */
export async function setPersistentRoomProtection(agentId: string, state: "on" | "off"): Promise<{ agentId: string; protection?: PersistentRoomProtection }> {
	return fetchJson<{ agentId: string; protection?: PersistentRoomProtection }>(`/api/persistent-agents/${encodeURIComponent(agentId)}/protection`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ state }) });
}
