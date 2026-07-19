import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const {
	createPersistentRoomCapabilityPolicy,
	createPersistentRoomDefaultCapabilityPolicy,
	ensurePersistentRoomThreadEffectiveWorkspacePolicySnapshot,
	persistentRoomCapabilityPolicyView,
	persistentRoomWorkspacePolicyPath,
	readPersistentRoomCapabilityPolicy,
	resolvePersistentRoomEffectiveWorkspacePolicy,
	writePersistentRoomDefaultCapabilityPolicy,
	writePersistentRoomCapabilityPolicy,
} = await import("../src/persistent-room-workspace-policy.js");
const {
	getPersistentRoomToolPolicy,
	normalizePersistentRoomWorkspaceToolSelectionInput,
	persistentRoomWorkspaceToolNamesForPolicy,
} = await import("../src/persistent-room-tool-policy.js");
const {
	createPersistentRoomWorkspaceTools,
	isPersistentRoomWorkspaceToolPolicyEnabled,
} = await import("../src/persistent-room-workspace-tools.js");

const agentId = "workspace-tool-selection-smoke-room";

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

function toolNames(policy: any): string {
	return persistentRoomWorkspaceToolNamesForPolicy(policy).join(",");
}

function registeredToolNames(policy: any): string {
	return createPersistentRoomWorkspaceTools(policy).map((tool: any) => String(tool.name)).sort().join(",");
}

function expectReject(fn: () => unknown, label: string): void {
	try {
		fn();
	} catch {
		return;
	}
	throw new Error(`${label}: expected rejection`);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "exxperts-workspace-tool-selection-"));

try {
	const repoRoot = path.join(tmp, "repo");
	const homeRoot = path.join(tmp, "home");
	const exxetaStateRoot = path.join(homeRoot, ".exxperts", "app");
	const persistentAgentsRoot = path.join(exxetaStateRoot, "personalized-agents");
	const workspaceRoot = path.join(tmp, "workspace");
	const workspaceB = path.join(tmp, "workspace-b");
	for (const dir of [repoRoot, exxetaStateRoot, persistentAgentsRoot, workspaceRoot, workspaceB]) fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(path.join(workspaceRoot, "README.md"), "# Workspace\n");

	const baseInput = {
		agentId,
		conversationId: "tool_selection_thread",
		repoRoot,
		persistentAgentsRoot,
		exxetaStateRoot,
		root: workspaceRoot,
		workspaceAccessMode: "bounded" as const,
		source: "manual" as const,
		mode: "read" as const,
		now: new Date("2026-07-01T00:00:00.000Z"),
	};

	const standard = createPersistentRoomCapabilityPolicy(baseInput);
	assert(standard.workspaceAccessMode === "bounded", "bounded policy should persist workspace access mode");
	assert(standard.toolSelection?.kind === "standard", "new default policy should persist explicit standard tool selection");
	assert(toolNames(standard) === "ls,find,read,write_markdown_file,read_spreadsheet", "standard selection should enable all current bounded workspace tools");
	assert(registeredToolNames(standard) === "find,ls,read,read_spreadsheet,write_markdown_file", "standard selection should register all bounded workspace tools");
	assert(persistentRoomCapabilityPolicyView(standard).toolSelection.kind === "standard", "view should expose standard tool selection");

	const legacyOldStandard = { ...standard, toolSelection: undefined, allowedToolNames: ["ls", "find", "read", "write_markdown_file"] };
	delete legacyOldStandard.toolSelection;
	assert(toolNames(legacyOldStandard) === "ls,find,read,write_markdown_file,read_spreadsheet", "legacy old-standard policy should upgrade to current all-on bundle including spreadsheet read");
	const legacyReadonly = { ...standard, toolSelection: undefined, allowedToolNames: ["ls", "find", "read"] };
	delete legacyReadonly.toolSelection;
	assert(toolNames(legacyReadonly) === "ls,find,read,write_markdown_file,read_spreadsheet", "legacy read-only policy should upgrade to current all-on bundle including spreadsheet read");
	const legacyEmpty = { ...standard, toolSelection: undefined, allowedToolNames: [] };
	delete legacyEmpty.toolSelection;
	assert(toolNames(legacyEmpty) === "", "legacy empty policy should remain disabled");
	assert(!isPersistentRoomWorkspaceToolPolicyEnabled(legacyEmpty), "legacy empty policy should not activate workspace tools");

	const customNoSpreadsheet = createPersistentRoomCapabilityPolicy({
		...baseInput,
		conversationId: "custom_no_spreadsheet",
		toolSelection: { kind: "custom", allowedToolNames: ["ls", "find", "read", "write_markdown_file"] },
	});
	assert(customNoSpreadsheet.toolSelection?.kind === "custom", "custom policy should persist explicit custom marker");
	assert(toolNames(customNoSpreadsheet) === "ls,find,read,write_markdown_file", "custom no-spreadsheet selection should be exact and not upgraded");
	assert(registeredToolNames(customNoSpreadsheet) === "find,ls,read,write_markdown_file", "custom no-spreadsheet selection should not register read_spreadsheet");

	const customNoMarkdown = createPersistentRoomCapabilityPolicy({
		...baseInput,
		conversationId: "custom_no_markdown",
		toolSelection: { kind: "custom", allowedToolNames: ["ls", "find", "read", "read_spreadsheet"] },
	});
	const noMarkdownView = persistentRoomCapabilityPolicyView(customNoMarkdown);
	assert(noMarkdownView.writeEnabled === false && noMarkdownView.markdownWriteEnabled === false, "custom without write_markdown_file should report Markdown write disabled");
	assert(registeredToolNames(customNoMarkdown) === "find,ls,read,read_spreadsheet", "custom no-markdown selection should not register write_markdown_file");

	const customAllOff = createPersistentRoomCapabilityPolicy({
		...baseInput,
		conversationId: "custom_all_off",
		toolSelection: { kind: "custom", allowedToolNames: [] },
	});
	assert(customAllOff.allowedToolNames.length === 0, "all-off custom policy should persist empty selected tools");
	assert(persistentRoomCapabilityPolicyView(customAllOff).allowedToolNames.length === 0, "all-off custom view should show no tools");
	assert(!isPersistentRoomWorkspaceToolPolicyEnabled(customAllOff), "all-off custom policy should not activate workspace tools");
	assert(registeredToolNames(customAllOff) === "", "all-off custom policy should register no workspace tools");

	for (const invalidTool of ["bash", "grep", "write", "edit", "unknown_tool"]) {
		expectReject(() => normalizePersistentRoomWorkspaceToolSelectionInput({ kind: "custom", allowedToolNames: ["ls", invalidTool] }, { workspaceAccessMode: "bounded" }), `invalid bounded tool ${invalidTool}`);
	}
	expectReject(() => normalizePersistentRoomWorkspaceToolSelectionInput({ kind: "custom", allowedToolNames: ["ls", "ls"] }, { workspaceAccessMode: "bounded" }), "duplicate bounded tool");
	expectReject(() => normalizePersistentRoomWorkspaceToolSelectionInput({ kind: "custom", allowedToolNames: "ls" }, { workspaceAccessMode: "bounded" }), "malformed custom tool selection");
	expectReject(() => normalizePersistentRoomWorkspaceToolSelectionInput({ kind: "other", allowedToolNames: [] }, { workspaceAccessMode: "bounded" }), "unknown tool selection kind");
	const validLocalFilesSelection = normalizePersistentRoomWorkspaceToolSelectionInput({ kind: "custom", allowedToolNames: ["read", "grep", "edit", "read_spreadsheet"] }, { workspaceAccessMode: "localFiles" });
	assert(validLocalFilesSelection.kind === "custom" && validLocalFilesSelection.allowedToolNames.join(",") === "read,grep,edit,read_spreadsheet", "Local files custom selection should accept non-bash native tools plus spreadsheet read");
	for (const invalidLocalFilesTool of ["bash", "write_markdown_file", "unknown_tool"]) {
		expectReject(() => normalizePersistentRoomWorkspaceToolSelectionInput({ kind: "custom", allowedToolNames: ["read", invalidLocalFilesTool] }, { workspaceAccessMode: "localFiles" }), `invalid Full access tool ${invalidLocalFilesTool}`);
	}
	expectReject(() => normalizePersistentRoomWorkspaceToolSelectionInput({ kind: "custom", allowedToolNames: ["read", "read"] }, { workspaceAccessMode: "localFiles" }), "duplicate Full access tool");

	const invalidStored = { ...standard, toolSelection: { kind: "custom" as const, allowedToolNames: ["bash"] } };
	writePersistentRoomCapabilityPolicy(invalidStored, { persistentAgentsRoot });
	assert(readPersistentRoomCapabilityPolicy(agentId, "tool_selection_thread", { persistentAgentsRoot }) === null, "invalid stored explicit custom selection should fail safe and not broaden tools");

	const defaultCustom = createPersistentRoomDefaultCapabilityPolicy({
		...baseInput,
		root: workspaceB,
		displayLabel: "Workspace B",
		toolSelection: { kind: "custom", allowedToolNames: ["ls", "read_spreadsheet"] },
	});
	writePersistentRoomDefaultCapabilityPolicy(defaultCustom, { persistentAgentsRoot });
	const snapshot = ensurePersistentRoomThreadEffectiveWorkspacePolicySnapshot(agentId, "snapshot_custom_tools", { persistentAgentsRoot });
	assert(snapshot.source === "thread-snapshot-from-room-default", "fresh thread should snapshot room default");
	assert(snapshot.workspaceAccessMode === "bounded", "snapshot effective policy should preserve bounded workspace access mode");
	assert(snapshot.allowedToolNames.join(",") === "ls,read_spreadsheet", "snapshot effective tools should preserve custom subset");
	const sidecarPath = persistentRoomWorkspacePolicyPath(agentId, "snapshot_custom_tools", { persistentAgentsRoot });
	const sidecar = JSON.parse(fs.readFileSync(sidecarPath, "utf-8"));
	assert(sidecar.workspaceAccessMode === "bounded", "thread sidecar should copy bounded workspace access mode");
	assert(sidecar.toolSelection?.kind === "custom", "thread sidecar should copy custom selection marker");
	assert(sidecar.toolSelection?.allowedToolNames?.join(",") === "ls,read_spreadsheet", "thread sidecar should copy exact custom selected tools");
	const readSidecar = readPersistentRoomCapabilityPolicy(agentId, "snapshot_custom_tools", { persistentAgentsRoot });
	assert(readSidecar?.toolSelection?.kind === "custom", "stored sidecar should round-trip custom marker");

	const effective = resolvePersistentRoomEffectiveWorkspacePolicy(agentId, "snapshot_custom_tools", { persistentAgentsRoot });
	const toolPolicy = getPersistentRoomToolPolicy(agentId, { workspaceToolsEnabled: effective.workspaceToolsEnabled, workspaceToolNames: effective.allowedToolNames });
	assert(toolPolicy.allowedToolNames.includes("web_search"), "persistent-room tool policy should retain web_search");
	assert(toolPolicy.allowedToolNames.includes("ls") && toolPolicy.allowedToolNames.includes("read_spreadsheet"), "persistent-room tool policy should include selected custom workspace tools");
	assert(!toolPolicy.allowedToolNames.includes("find") && !toolPolicy.allowedToolNames.includes("read") && !toolPolicy.allowedToolNames.includes("write_markdown_file"), "persistent-room tool policy should not broaden to unselected workspace tools");
	assert(toolPolicy.blockedToolNames.includes("bash") && toolPolicy.blockedToolNames.includes("grep") && toolPolicy.blockedToolNames.includes("write") && toolPolicy.blockedToolNames.includes("edit"), "persistent-room tool policy should keep broad filesystem tools blocked");

	const localFilesPolicy = createPersistentRoomCapabilityPolicy({
		...baseInput,
		conversationId: "local_files_standard_tools",
		workspaceAccessMode: "localFiles",
	});
	assert(toolNames(localFilesPolicy) === "read,ls,find,grep,write,edit,read_spreadsheet", "Local files standard policy should expose all non-bash local-files tools");
	assert(registeredToolNames(localFilesPolicy) === "read_spreadsheet", "Local files standard custom tool registration should avoid native tool collisions");
	assert(persistentRoomCapabilityPolicyView(localFilesPolicy).toolSelection.kind === "standard", "Local files standard view should expose standard selection");
	const localFilesToolPolicy = getPersistentRoomToolPolicy(agentId, { workspaceToolsEnabled: true, workspaceToolNames: persistentRoomWorkspaceToolNamesForPolicy(localFilesPolicy), workspaceAccessMode: "localFiles" });
	assert(localFilesToolPolicy.allowedToolNames.join(",") === "web_search,fetch_url,mcp,read,ls,find,grep,write,edit,read_spreadsheet", "Local files room tool policy should allow web_search plus selected native files and spreadsheet read");
	assert(!localFilesToolPolicy.allowedToolNames.includes("bash"), "Local files room tool policy must not allow bash by default");
	assert(localFilesToolPolicy.blockedToolNames.includes("bash"), "Local files room tool policy should keep bash blocked by default");
	const localFilesManualBashToolPolicy = getPersistentRoomToolPolicy(agentId, { workspaceToolsEnabled: true, workspaceToolNames: persistentRoomWorkspaceToolNamesForPolicy(localFilesPolicy), workspaceAccessMode: "localFiles", bashEnabled: true, bashRuntimeAllowed: true });
	assert(localFilesManualBashToolPolicy.allowedToolNames.join(",") === "web_search,fetch_url,mcp,read,ls,find,grep,write,edit,read_spreadsheet,bash", "manual Local files room tool policy should allow bash only when explicitly enabled");
	const localFilesBackgroundBashToolPolicy = getPersistentRoomToolPolicy(agentId, { workspaceToolsEnabled: true, workspaceToolNames: persistentRoomWorkspaceToolNamesForPolicy(localFilesPolicy), workspaceAccessMode: "localFiles", bashEnabled: true, bashRuntimeAllowed: false });
	assert(!localFilesBackgroundBashToolPolicy.allowedToolNames.includes("bash"), "background Local files room tool policy should not allow bash even when room default enables it");

	const localFilesCustomNoSpreadsheet = createPersistentRoomCapabilityPolicy({
		...baseInput,
		conversationId: "local_files_custom_no_spreadsheet",
		workspaceAccessMode: "localFiles",
		toolSelection: { kind: "custom", allowedToolNames: ["read", "ls", "grep", "write"] },
	});
	assert(toolNames(localFilesCustomNoSpreadsheet) === "read,ls,grep,write", "Local files custom selection should preserve exact selected native subset");
	assert(registeredToolNames(localFilesCustomNoSpreadsheet) === "", "Local files custom selection without spreadsheet read should register no custom tools");
	const localFilesCustomToolPolicy = getPersistentRoomToolPolicy(agentId, { workspaceToolsEnabled: true, workspaceToolNames: persistentRoomWorkspaceToolNamesForPolicy(localFilesCustomNoSpreadsheet), workspaceAccessMode: "localFiles" });
	assert(localFilesCustomToolPolicy.allowedToolNames.join(",") === "web_search,fetch_url,mcp,read,ls,grep,write", "Local files custom allowlist should omit disabled native tools");
	assert(localFilesCustomToolPolicy.blockedToolNames.includes("find") && localFilesCustomToolPolicy.blockedToolNames.includes("edit") && localFilesCustomToolPolicy.blockedToolNames.includes("read_spreadsheet"), "Local files disabled tools should be blocked by tool policy");

	const localFilesAllOff = createPersistentRoomCapabilityPolicy({
		...baseInput,
		conversationId: "local_files_custom_all_off",
		workspaceAccessMode: "localFiles",
		toolSelection: { kind: "custom", allowedToolNames: [] },
	});
	assert(toolNames(localFilesAllOff) === "", "Local files all-off custom selection should resolve to no tools");
	assert(!isPersistentRoomWorkspaceToolPolicyEnabled(localFilesAllOff), "Local files all-off custom policy should not activate ordinary workspace tools");
	assert(registeredToolNames(localFilesAllOff) === "", "Local files all-off custom policy should register no custom tools");
	const localFilesBashOnlyToolPolicy = getPersistentRoomToolPolicy(agentId, { workspaceToolsEnabled: true, workspaceToolNames: persistentRoomWorkspaceToolNamesForPolicy(localFilesAllOff), workspaceAccessMode: "localFiles", bashEnabled: true, bashRuntimeAllowed: true });
	assert(localFilesBashOnlyToolPolicy.allowedToolNames.join(",") === "web_search,fetch_url,mcp,bash", "manual Local files room can expose bash independently of ordinary file tools");

	const invalidLocalFilesToolPolicy = getPersistentRoomToolPolicy(agentId, { workspaceToolsEnabled: true, workspaceToolNames: ["read", "bash"], workspaceAccessMode: "localFiles" });
	assert(invalidLocalFilesToolPolicy.allowedToolNames.join(",") === "web_search,fetch_url,mcp", "invalid Local files workspace tool bundle should fail closed to web_search only");

	console.log("persistent-room workspace tool selection smoke passed");
} catch (error) {
	console.error(error instanceof Error ? error.stack || error.message : error);
	process.exitCode = 1;
} finally {
	fs.rmSync(tmp, { recursive: true, force: true });
}
