import { fetchJson } from "./api";

export interface WorkspaceFileEntry {
	name: string;
	relativePath: string;
	kind: "file" | "directory";
	bytes: number | null;
	modifiedAt: string;
	extension: string;
}

export interface WorkspaceFileListing {
	root: { displayLabel: string; basename: string } | null;
	path: string;
	entries: WorkspaceFileEntry[];
}

export async function listWorkspaceFiles(agentId: string, conversationId: string, relativePath = ""): Promise<WorkspaceFileListing> {
	const params = new URLSearchParams({ conversationId });
	if (relativePath) params.set("path", relativePath);
	return fetchJson<WorkspaceFileListing>(`/api/persistent-agents/${encodeURIComponent(agentId)}/workspace-files?${params.toString()}`);
}
