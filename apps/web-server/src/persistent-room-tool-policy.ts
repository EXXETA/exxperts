export interface PersistentRoomToolPolicy {
	agentId: string;
	allowedToolNames: string[];
	blockedToolNames: string[];
	policySource: string;
}

const PERSISTENT_ROOM_POLICY_SOURCE = "web-server-static-room-web-research";
const PERSISTENT_ROOM_WORKSPACE_POLICY_SOURCE = "persistent-room-capability-policy-workspace";

export const PERSISTENT_ROOM_READONLY_WORKSPACE_TOOL_NAMES = ["ls", "find", "read"] as const;
export const PERSISTENT_ROOM_MARKDOWN_WRITE_TOOL_NAME = "write_markdown_file" as const;
export const PERSISTENT_ROOM_SPREADSHEET_READ_TOOL_NAME = "read_spreadsheet" as const;
export const PERSISTENT_ROOM_LOCAL_FILES_NATIVE_TOOL_NAMES = ["read", "ls", "find", "grep", "write", "edit"] as const;
export const PERSISTENT_ROOM_BASH_TOOL_NAME = "bash" as const;
const PERSISTENT_ROOM_LEGACY_STANDARD_WORKSPACE_TOOL_NAMES = [
	...PERSISTENT_ROOM_READONLY_WORKSPACE_TOOL_NAMES,
	PERSISTENT_ROOM_MARKDOWN_WRITE_TOOL_NAME,
] as const;
export const PERSISTENT_ROOM_WORKSPACE_TOOL_NAMES = [
	...PERSISTENT_ROOM_LEGACY_STANDARD_WORKSPACE_TOOL_NAMES,
	PERSISTENT_ROOM_SPREADSHEET_READ_TOOL_NAME,
] as const;
export const PERSISTENT_ROOM_LOCAL_FILES_TOOL_NAMES = [
	...PERSISTENT_ROOM_LOCAL_FILES_NATIVE_TOOL_NAMES,
	PERSISTENT_ROOM_SPREADSHEET_READ_TOOL_NAME,
] as const;
export const PERSISTENT_ROOM_WEB_RESEARCH_TOOL_NAMES = ["web_search", "fetch_url"] as const;
// The room's eyes on its own shelf (files core slice): read-only, fenced to
// personalized-agents/<roomId>/files/, default-on for every room — a dropped
// or room-made file is vouched-for content, the fetch_url trust class.
export const PERSISTENT_ROOM_SHELF_TOOL_NAMES = ["read_file", "search_file"] as const;
// Single proxy tool from pi-mcp-adapter; which servers it can reach is
// governed by the user's mcp.json config, not by tool names.
export const PERSISTENT_ROOM_MCP_TOOL_NAMES = ["mcp"] as const;

export type PersistentRoomWorkspaceAccessModeLike = "bounded" | "localFiles";
export type PersistentRoomWorkspaceToolName = typeof PERSISTENT_ROOM_WORKSPACE_TOOL_NAMES[number];
export type PersistentRoomLocalFilesToolName = typeof PERSISTENT_ROOM_LOCAL_FILES_TOOL_NAMES[number];
export type PersistentRoomWorkspaceToolSelection =
	| { kind: "standard" }
	| { kind: "custom"; allowedToolNames: string[] };

const PERSISTENT_ROOM_WORKSPACE_TOOL_NAME_SET = new Set<string>(PERSISTENT_ROOM_WORKSPACE_TOOL_NAMES);
const PERSISTENT_ROOM_LOCAL_FILES_TOOL_NAME_SET = new Set<string>(PERSISTENT_ROOM_LOCAL_FILES_TOOL_NAMES);

const PERSISTENT_ROOM_BLOCKED_TOOL_NAMES = [
	"read",
	"bash",
	"edit",
	"write",
	"write_markdown_file",
	"read_spreadsheet",
	"grep",
	"find",
	"ls",
	"delegate",
	"start_handoff",
	"return_handoff",
	"kb_*",
	"artifact_*",
	"mcp_*",
	"memory_*",
];

export interface PersistentRoomWorkspaceToolPolicyLike {
	workspaceAccessMode?: PersistentRoomWorkspaceAccessModeLike;
	modes?: { read?: boolean; write?: boolean };
	allowedToolNames?: string[];
	toolSelection?: PersistentRoomWorkspaceToolSelection;
}

function hasExactToolBundle(actualRaw: readonly string[], expected: readonly string[]): boolean {
	const actual = actualRaw.map((toolName) => String(toolName).trim()).filter(Boolean);
	return actual.length === expected.length && expected.every((toolName) => actual.includes(toolName));
}

function setEquals(actual: Set<string>, expected: readonly string[]): boolean {
	return actual.size === expected.length && expected.every((toolName) => actual.has(toolName));
}

function persistentRoomDefaultWorkspaceToolNamesForMode(workspaceAccessMode: PersistentRoomWorkspaceAccessModeLike): readonly string[] {
	return workspaceAccessMode === "localFiles" ? PERSISTENT_ROOM_LOCAL_FILES_TOOL_NAMES : PERSISTENT_ROOM_WORKSPACE_TOOL_NAMES;
}

function persistentRoomWorkspaceToolNameSetForMode(workspaceAccessMode: PersistentRoomWorkspaceAccessModeLike): Set<string> {
	return workspaceAccessMode === "localFiles" ? PERSISTENT_ROOM_LOCAL_FILES_TOOL_NAME_SET : PERSISTENT_ROOM_WORKSPACE_TOOL_NAME_SET;
}

function persistentRoomWorkspaceToolSelectionLabel(workspaceAccessMode: PersistentRoomWorkspaceAccessModeLike): string {
	return workspaceAccessMode === "localFiles" ? "local files workspace tool selection" : "bounded workspace tool selection";
}

export function isPersistentRoomWorkspaceToolName(toolName: string): toolName is PersistentRoomWorkspaceToolName {
	return PERSISTENT_ROOM_WORKSPACE_TOOL_NAME_SET.has(toolName);
}

export function isPersistentRoomLocalFilesToolName(toolName: string): toolName is PersistentRoomLocalFilesToolName {
	return PERSISTENT_ROOM_LOCAL_FILES_TOOL_NAME_SET.has(toolName);
}

export function normalizePersistentRoomWorkspaceToolNameSubset(rawToolNames: unknown, label = "workspace tool selection"): string[] {
	return normalizePersistentRoomWorkspaceToolNameSubsetForMode(rawToolNames, "bounded", label);
}

export function normalizePersistentRoomWorkspaceToolNameSubsetForMode(rawToolNames: unknown, workspaceAccessMode: PersistentRoomWorkspaceAccessModeLike, label = persistentRoomWorkspaceToolSelectionLabel(workspaceAccessMode)): string[] {
	if (!Array.isArray(rawToolNames)) throw new Error(`${label} must be an array of ${workspaceAccessMode === "localFiles" ? "Full access" : "bounded workspace"} tool names`);
	const allowedToolNames = persistentRoomWorkspaceToolNameSetForMode(workspaceAccessMode);
	const seen = new Set<string>();
	for (const rawToolName of rawToolNames) {
		const toolName = String(rawToolName ?? "").trim();
		if (!toolName || !allowedToolNames.has(toolName)) throw new Error(`invalid ${workspaceAccessMode === "localFiles" ? "Full access" : "bounded workspace"} tool: ${toolName || "(empty)"}`);
		if (seen.has(toolName)) throw new Error(`duplicate ${workspaceAccessMode === "localFiles" ? "Full access" : "bounded workspace"} tool: ${toolName}`);
		seen.add(toolName);
	}
	return persistentRoomDefaultWorkspaceToolNamesForMode(workspaceAccessMode).filter((toolName) => seen.has(toolName));
}

export function normalizePersistentRoomWorkspaceToolSelectionInput(rawSelection: unknown, options: { defaultToStandard?: boolean; workspaceAccessMode?: PersistentRoomWorkspaceAccessModeLike } = {}): PersistentRoomWorkspaceToolSelection {
	const workspaceAccessMode = options.workspaceAccessMode ?? "bounded";
	if (rawSelection == null || rawSelection === "") {
		if (options.defaultToStandard === false) throw new Error("workspace tool selection is required");
		return { kind: "standard" };
	}
	if (!rawSelection || typeof rawSelection !== "object" || Array.isArray(rawSelection)) throw new Error("workspace tool selection must be an object");
	const kind = String((rawSelection as any).kind ?? "").trim();
	if (kind === "standard") return { kind: "standard" };
	if (kind === "custom") {
		return { kind: "custom", allowedToolNames: normalizePersistentRoomWorkspaceToolNameSubsetForMode((rawSelection as any).allowedToolNames, workspaceAccessMode) };
	}
	throw new Error("workspace tool selection kind must be standard or custom");
}

export function normalizeStoredPersistentRoomWorkspaceToolSelection(rawSelection: unknown, workspaceAccessMode: PersistentRoomWorkspaceAccessModeLike = "bounded"): PersistentRoomWorkspaceToolSelection | undefined | null {
	if (rawSelection === undefined) return undefined;
	try {
		return normalizePersistentRoomWorkspaceToolSelectionInput(rawSelection, { defaultToStandard: false, workspaceAccessMode });
	} catch {
		return null;
	}
}

export function persistentRoomWorkspaceToolNamesForSelection(selection: PersistentRoomWorkspaceToolSelection, workspaceAccessMode: PersistentRoomWorkspaceAccessModeLike = "bounded"): string[] {
	if (selection.kind === "standard") return [...persistentRoomDefaultWorkspaceToolNamesForMode(workspaceAccessMode)];
	return normalizePersistentRoomWorkspaceToolNameSubsetForMode(selection.allowedToolNames, workspaceAccessMode);
}

function validSelectedWorkspaceToolNamesForModeOrEmpty(rawToolNames: readonly string[], workspaceAccessMode: PersistentRoomWorkspaceAccessModeLike): string[] {
	try {
		return normalizePersistentRoomWorkspaceToolNameSubsetForMode([...rawToolNames], workspaceAccessMode);
	} catch {
		return [];
	}
}

function validSelectedWorkspaceToolNamesOrEmpty(rawToolNames: readonly string[]): string[] {
	return validSelectedWorkspaceToolNamesForModeOrEmpty(rawToolNames, "bounded");
}

export function hasPersistentRoomReadonlyWorkspaceToolBundle(policy: PersistentRoomWorkspaceToolPolicyLike | null | undefined): boolean {
	return Boolean(policy?.modes?.read === true && hasExactToolBundle(policy.allowedToolNames ?? [], PERSISTENT_ROOM_READONLY_WORKSPACE_TOOL_NAMES));
}

export function hasPersistentRoomStandardWorkspaceToolBundle(policy: PersistentRoomWorkspaceToolPolicyLike | null | undefined): boolean {
	return Boolean(policy?.modes?.read === true && (
		hasExactToolBundle(policy.allowedToolNames ?? [], PERSISTENT_ROOM_WORKSPACE_TOOL_NAMES) ||
		hasExactToolBundle(policy.allowedToolNames ?? [], PERSISTENT_ROOM_LEGACY_STANDARD_WORKSPACE_TOOL_NAMES)
	));
}

function hasPersistentRoomStandardLocalFilesToolBundle(policy: PersistentRoomWorkspaceToolPolicyLike | null | undefined): boolean {
	return Boolean(policy?.modes?.read === true && hasExactToolBundle(policy.allowedToolNames ?? [], PERSISTENT_ROOM_LOCAL_FILES_TOOL_NAMES));
}

export function isPersistentRoomWorkspaceToolBundleEnabled(policy: PersistentRoomWorkspaceToolPolicyLike | null | undefined): boolean {
	return persistentRoomWorkspaceToolNamesForPolicy(policy).length > 0;
}

export function persistentRoomWorkspaceToolNamesForPolicy(policy: PersistentRoomWorkspaceToolPolicyLike | null | undefined): string[] {
	if (!policy || policy.modes?.read !== true) return [];
	const workspaceAccessMode = policy.workspaceAccessMode === "localFiles" ? "localFiles" : "bounded";
	if (policy.toolSelection) {
		return validSelectedWorkspaceToolNamesForModeOrEmpty(persistentRoomWorkspaceToolNamesForSelection(policy.toolSelection, workspaceAccessMode), workspaceAccessMode);
	}
	if (workspaceAccessMode === "localFiles") {
		// Backward-compatible activation for W5 local-files records that predate
		// configurable Full access tool selection. Empty or malformed legacy records
		// remain disabled rather than broadening unexpectedly.
		if (hasPersistentRoomStandardLocalFilesToolBundle(policy)) return [...PERSISTENT_ROOM_LOCAL_FILES_TOOL_NAMES];
		return [];
	}
	// Backward-compatible activation: old saved read-only/standard policies now
	// receive the current standard bounded workspace bundle. Empty or unknown
	// legacy records remain disabled.
	if (hasPersistentRoomReadonlyWorkspaceToolBundle(policy) || hasPersistentRoomStandardWorkspaceToolBundle(policy)) return [...PERSISTENT_ROOM_WORKSPACE_TOOL_NAMES];
	return [];
}

export function persistentRoomWorkspaceToolSelectionViewForPolicy(policy: PersistentRoomWorkspaceToolPolicyLike | null | undefined): { kind: "standard" | "custom"; allowedToolNames: string[] } {
	const workspaceAccessMode = policy?.workspaceAccessMode === "localFiles" ? "localFiles" : "bounded";
	if (policy?.toolSelection?.kind === "custom") return { kind: "custom", allowedToolNames: persistentRoomWorkspaceToolNamesForPolicy(policy) };
	const allowedToolNames = persistentRoomWorkspaceToolNamesForPolicy(policy);
	const defaultToolNames = persistentRoomDefaultWorkspaceToolNamesForMode(workspaceAccessMode);
	return allowedToolNames.length === defaultToolNames.length && setEquals(new Set(allowedToolNames), defaultToolNames)
		? { kind: "standard", allowedToolNames }
		: { kind: "custom", allowedToolNames };
}

/**
 * Persistent rooms start from a deliberately narrow tool surface.
 *
 * No tool should enter the persistent-room provider context unless it is
 * explicitly added here or through a validated capability policy. Web research
 * is allowed in every room; bounded workspace tools are reintroduced only when
 * a workspace capability policy is active. Broad mutation tools, shell,
 * routing, memory, KB, artifact, and MCP tools remain omitted unless a later
 * policy explicitly reintroduces them.
 */
export function getPersistentRoomToolPolicy(agentId: string, input: { workspaceToolsEnabled?: boolean; readOnlyWorkspaceToolsEnabled?: boolean; workspaceToolNames?: readonly string[]; workspaceAccessMode?: PersistentRoomWorkspaceAccessModeLike; bashEnabled?: boolean; bashRuntimeAllowed?: boolean } = {}): PersistentRoomToolPolicy {
	const workspaceToolsEnabled = input.workspaceToolsEnabled === true || input.readOnlyWorkspaceToolsEnabled === true;
	const workspaceAccessMode = input.workspaceAccessMode ?? "bounded";
	const workspaceToolNames = workspaceToolsEnabled
		? input.workspaceToolNames === undefined
			? [...persistentRoomDefaultWorkspaceToolNamesForMode(workspaceAccessMode)]
			: validSelectedWorkspaceToolNamesForModeOrEmpty(input.workspaceToolNames, workspaceAccessMode)
		: [];
	const bashToolNames = workspaceAccessMode === "localFiles" && input.bashEnabled === true && input.bashRuntimeAllowed === true ? [PERSISTENT_ROOM_BASH_TOOL_NAME] : [];
	const allowedToolNames = [
		...PERSISTENT_ROOM_WEB_RESEARCH_TOOL_NAMES,
		...PERSISTENT_ROOM_SHELF_TOOL_NAMES,
		...PERSISTENT_ROOM_MCP_TOOL_NAMES,
		...workspaceToolNames,
		...bashToolNames,
	];
	const allowedSet = new Set<string>(allowedToolNames);
	return {
		agentId,
		allowedToolNames,
		blockedToolNames: PERSISTENT_ROOM_BLOCKED_TOOL_NAMES.filter((toolName) => !allowedSet.has(toolName)),
		policySource: workspaceToolsEnabled ? PERSISTENT_ROOM_WORKSPACE_POLICY_SOURCE : PERSISTENT_ROOM_POLICY_SOURCE,
	};
}
