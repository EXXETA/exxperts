/**
 * Room permission gate.
 *
 * Every surface (web rooms and the rooms CLI) runs the business persona:
 *   allowed:    memory_*, kb_*, artifact_*, mcp_*, web_search, fetch_url,
 *               all `/` commands
 *   blocked:    bash, write, edit, read, ls, find, grep — users have NO
 *               direct filesystem access by default. Persistent-room
 *               sessions may expose a validated workspace bundle. Bounded
 *               rooms use Exxperts guarded tools
 *               (ls/find/read/write_markdown_file/read_spreadsheet);
 *               Full access rooms use native Pi filesystem tools
 *               (read/ls/find/grep/write/edit) plus Exxperts
 *               read_spreadsheet. Bash is available only when explicitly
 *               enabled for a manual Full access room session.
 *
 * Enforcement is a soft gate: if a blocked tool is used, we block with a
 * clear reason. Hard enforcement (binary refuses to even register the
 * tool) is phase 2.
 */

import type { ExtensionAPI } from "@exxeta/exxperts-runtime";

type PersistentRoomWorkspaceAccessMode = "bounded" | "localFiles";

const PERSISTENT_ROOM_BOUNDED_WORKSPACE_TOOLS = new Set(["ls", "find", "read", "write_markdown_file", "read_spreadsheet"]);
const PERSISTENT_ROOM_LOCAL_FILES_WORKSPACE_TOOLS = new Set(["read", "ls", "find", "grep", "write", "edit", "read_spreadsheet"]);
const PERSISTENT_ROOM_AGENT_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,119}$/;

function isPersistentRoomAgentEnvValue(value: string | undefined): boolean {
	const id = String(value || "").trim();
	return id !== "." && id !== ".." && PERSISTENT_ROOM_AGENT_ID_PATTERN.test(id);
}

function parsePersistentRoomWorkspaceAccessMode(value: string | undefined): PersistentRoomWorkspaceAccessMode | null {
	const mode = String(value || "bounded").trim() || "bounded";
	if (mode === "bounded" || mode === "localFiles") return mode;
	return null;
}

function persistentRoomAllowedWorkspaceToolSetForMode(mode: PersistentRoomWorkspaceAccessMode): Set<string> {
	return mode === "localFiles" ? PERSISTENT_ROOM_LOCAL_FILES_WORKSPACE_TOOLS : PERSISTENT_ROOM_BOUNDED_WORKSPACE_TOOLS;
}

function parsePersistentRoomAllowedWorkspaceTools(value: string | undefined, mode: PersistentRoomWorkspaceAccessMode | null): Set<string> {
	if (!mode) return new Set();
	const allowedTools = persistentRoomAllowedWorkspaceToolSetForMode(mode);
	const tools = String(value || "").split(",").map((tool) => tool.trim()).filter(Boolean);
	const unique = new Set<string>();
	for (const tool of tools) {
		if (!allowedTools.has(tool) || unique.has(tool)) return new Set();
		unique.add(tool);
	}
	return unique;
}

function parsePersistentRoomBashEnabled(value: string | undefined): boolean {
	return String(value || "").trim() === "1";
}

function parsePersistentRoomExecutionContext(value: string | undefined): "manual" | "background" | null {
	const context = String(value || "").trim();
	if (context === "manual" || context === "background") return context;
	return null;
}

// Room persona: NO raw filesystem access. Memory, KB, artifacts, MCP, and
// web research. Workspace tools are granted separately per room below.
// `mcp` is the pi-mcp-adapter proxy tool (single gate for all MCP servers);
// the `mcp_` prefix covers legacy per-tool registrations.
function allowTool(t: string): boolean {
	return (
		t.startsWith("memory_") ||
		t.startsWith("kb_") ||
		t.startsWith("artifact_") ||
		t.startsWith("mcp_") ||
		t === "mcp" ||
		t === "web_search" ||
		t === "fetch_url" ||
		// read_skill is registered only for rooms with enabled skills, is read-only,
		// and verifies the user-reviewed hash pin itself — safe at the policy baseline.
		t === "read_skill" ||
		// delegate_task never acts by itself: it validates against the static
		// template registry and requires per-delegation interactive user approval,
		// which doubles as the specialist's only write grant.
		t === "delegate_task"
	);
}

export default function (pi: ExtensionAPI) {
	const persistentRoomWorkspaceAccessMode = parsePersistentRoomWorkspaceAccessMode(process.env.EXXETA_PERSISTENT_ROOM_WORKSPACE_ACCESS_MODE);
	const persistentRoomSessionMarked = process.env.EXXETA_PERSISTENT_ROOM_SESSION === "1" && isPersistentRoomAgentEnvValue(process.env.EXXETA_PERSISTENT_ROOM_AGENT);
	const persistentRoomWorkspaceToolsAllowed = persistentRoomSessionMarked
		? parsePersistentRoomAllowedWorkspaceTools(process.env.EXXETA_PERSISTENT_ROOM_WORKSPACE_TOOLS, persistentRoomWorkspaceAccessMode)
		: new Set<string>();
	const persistentRoomBashAllowed = persistentRoomSessionMarked
		&& persistentRoomWorkspaceAccessMode === "localFiles"
		&& parsePersistentRoomBashEnabled(process.env.EXXETA_PERSISTENT_ROOM_BASH_ENABLED)
		&& parsePersistentRoomExecutionContext(process.env.EXXETA_PERSISTENT_ROOM_EXECUTION_CONTEXT) === "manual";
	const isPersistentRoomWorkspaceToolAllowed = (toolName: string): boolean => persistentRoomWorkspaceToolsAllowed.has(toolName) || (toolName === "bash" && persistentRoomBashAllowed);

	pi.on("tool_call", async (event) => {
		if (allowTool(event.toolName)) return;
		if (isPersistentRoomWorkspaceToolAllowed(event.toolName)) return;

		// Build a directive, retry-friendly block reason. The model should pick
		// the suggested alternative on the next turn without asking the user.
		const t = event.toolName;
		const fsTools = ["bash", "read", "ls", "find", "grep", "write", "write_markdown_file", "read_spreadsheet", "edit"];
		const hint = fsTools.includes(t)
			? "This room has NO filesystem access. Do NOT retry with another filesystem tool. Tell the user plainly that file access must be enabled for this room in its workspace settings, then offer help on drafting, summaries, or knowledge-base aspects."
			: "Answer directly with the tools available in this room.";
		return {
			block: true,
			reason: `Tool '${t}' is not available in this room. ${hint}`,
		};
	});
}
