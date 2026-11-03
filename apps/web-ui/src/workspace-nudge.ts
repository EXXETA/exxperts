import type { PersistentAgentId, PersistentRoomWorkspaceDefaultResponse } from "./types";

const WORKSPACE_NUDGE_STORAGE_PREFIX = "exxperts.workspaceNudgeDismissed.";
// The folder hint above a room's composer: the nudge for a room that never had
// a folder, until it is dismissed once, or the line for a saved folder that is
// gone from this computer, which has no dismiss and stays until it is found.
type WorkspaceHint = { roomId: PersistentAgentId; kind: "no-folder" } | { roomId: PersistentAgentId; kind: "folder-gone"; folderName: string };
function workspaceHintOf(roomId: PersistentAgentId, response: PersistentRoomWorkspaceDefaultResponse): WorkspaceHint | null {
	const root = response.policy?.roots[0];
	// The answer's only warnings are a saved folder that is missing.
	if (root && (response.warnings?.length ?? 0) > 0) return { roomId, kind: "folder-gone", folderName: root.displayLabel || root.basename };
	if (response.policy !== null) return null;
	let dismissed = false;
	try { dismissed = localStorage.getItem(WORKSPACE_NUDGE_STORAGE_PREFIX + roomId) !== null; } catch {}
	return dismissed ? null : { roomId, kind: "no-folder" };
}

export { WORKSPACE_NUDGE_STORAGE_PREFIX, workspaceHintOf };
export type { WorkspaceHint };
