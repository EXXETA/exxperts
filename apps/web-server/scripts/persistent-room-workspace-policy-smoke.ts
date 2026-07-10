import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const {
	createPersistentRoomCapabilityPolicy,
	createPersistentRoomDefaultCapabilityPolicy,
	deletePersistentRoomCapabilityPolicy,
	deletePersistentRoomDefaultCapabilityPolicy,
	persistentRoomCapabilityPolicyView,
	PersistentRoomWorkspacePolicyError,
	PERSISTENT_ROOM_WORKSPACE_DEFAULT_CONVERSATION_ID,
	persistentRoomWorkspaceDefaultPath,
	persistentRoomWorkspacePolicyPath,
	readPersistentRoomCapabilityPolicy,
	readPersistentRoomDefaultCapabilityPolicy,
	resolvePersistentRoomCapabilityPolicy,
	writePersistentRoomCapabilityPolicy,
	writePersistentRoomDefaultCapabilityPolicy,
} = await import("../src/persistent-room-workspace-policy.js");

const agentId = "workspace-policy-smoke-room";

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

function expectPolicyError(fn: () => unknown, code: string, label: string): void {
	try {
		fn();
	} catch (error) {
		assert(error instanceof PersistentRoomWorkspacePolicyError, `${label}: expected PersistentRoomWorkspacePolicyError`);
		assert(error.code === code, `${label}: expected ${code}, got ${error.code}`);
		assert(!error.message.includes(tmp), `${label}: error message must not leak temp absolute path`);
		return;
	}
	throw new Error(`${label}: expected ${code}`);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "exxperts-workspace-policy-"));

try {
	const repoRoot = path.join(tmp, "repo");
	const homeRoot = path.join(tmp, "home");
	const exxetaStateRoot = path.join(homeRoot, ".exxperts", "app");
	const persistentAgentsRoot = path.join(exxetaStateRoot, "personalized-agents");
	const agentRoot = path.join(persistentAgentsRoot, agentId);
	const workspaceRoot = path.join(tmp, "workspace");
	const defaultWorkspaceRoot = path.join(tmp, "default-workspace");
	const repoChild = path.join(repoRoot, "docs");
	for (const dir of [repoRoot, homeRoot, exxetaStateRoot, persistentAgentsRoot, agentRoot, workspaceRoot, defaultWorkspaceRoot, repoChild]) {
		fs.mkdirSync(dir, { recursive: true });
	}

	const baseInput = {
		agentId: agentId,
		conversationId: "c_workspace_policy_smoke",
		repoRoot,
		persistentAgentsRoot,
		exxetaStateRoot,
		now: new Date("2026-05-26T00:00:00.000Z"),
	} as const;

	const policy = createPersistentRoomCapabilityPolicy({ ...baseInput, root: workspaceRoot, workspaceAccessMode: "bounded", source: "manual", mode: "read" });
	assert(policy.schemaVersion === 1, "policy should use schema version 1");
	assert(policy.workspaceAccessMode === "bounded", "explicit bounded policy should persist workspace access mode");
	assert(policy.roots.length === 1, "policy should contain one root grant");
	assert(policy.roots[0]?.path === workspaceRoot, "server policy should retain canonical path");
	assert(policy.roots[0]?.realpath === fs.realpathSync.native(workspaceRoot), "server policy should retain realpath");
	assert(policy.modes.read === true, "read mode should be enabled in policy model");
	assert(policy.modes.write === true, "bounded Markdown write should be enabled for active workspace policies");
	assert(policy.allowedToolNames.join(",") === "ls,find,read,write_markdown_file,read_spreadsheet", "workspace policy should allow the standard bounded workspace bundle");
	assert(policy.bashEnabled === false, "bounded workspace policy should keep bash disabled by default");
	const boundedBashRequest = createPersistentRoomCapabilityPolicy({ ...baseInput, conversationId: "c_bounded_bash_request", root: workspaceRoot, workspaceAccessMode: "bounded", source: "manual", mode: "read", bashEnabled: true });
	assert(boundedBashRequest.bashEnabled === false, "bounded workspace policy must resolve bash disabled even when requested");
	assert(policy.deniedRoots.some((root) => root.kind === "repo-root"), "policy should record redacted repo-root deny metadata");
	assert(policy.deniedRoots.some((root) => root.kind === "exxeta-state-root"), "policy should record redacted exxeta-state-root deny metadata");
	assert(policy.denySegments.includes(".git") && policy.denySegments.includes(".exxeta") && policy.denySegments.includes(".exxperts") && policy.denySegments.includes("node_modules"), "default deny segments should be present");
	assert(policy.denyFilenameGlobs.includes(".env") && policy.denyFilenameGlobs.includes("*.pem") && policy.denyFilenameGlobs.includes("id_ed25519"), "default sensitive filename globs should be present");

	const view = persistentRoomCapabilityPolicyView(policy);
	const viewJson = JSON.stringify(view);
	assert(view.workspaceAccessMode === "bounded", "view should expose bounded workspace access mode");
	assert(view.rootCount === 1, "view should expose root count");
	assert(view.roots[0]?.basename === "workspace", "view should expose basename only");
	assert(view.pathAccess === "workspace-only", "view should state workspace-only path access");
	assert(view.writeEnabled === true, "view should show bounded Markdown write enabled");
	assert(view.markdownWriteEnabled === true, "view should state Markdown write is enabled");
	assert(view.bashEnabled === false, "view should state bash is disabled");
	assert(view.nativePiFilesystemToolsEnabled === false, "view should state native Pi filesystem tools are disabled");
	assert(!viewJson.includes(JSON.stringify(workspaceRoot).slice(1, -1)), "view must not expose raw workspace path");
	assert(!viewJson.includes(JSON.stringify(repoRoot).slice(1, -1)), "view must not expose raw repo path");
	assert(!viewJson.includes(JSON.stringify(exxetaStateRoot).slice(1, -1)), "view must not expose raw exxeta path");

	writePersistentRoomCapabilityPolicy(policy, { persistentAgentsRoot });
	const policyPath = persistentRoomWorkspacePolicyPath(agentId, "c_workspace_policy_smoke", { persistentAgentsRoot });
	assert(policyPath === path.join(agentRoot, "runtime", "workspace-policies", "c_workspace_policy_smoke.json"), "policy should be stored as persistent-agent runtime sidecar");
	assert(fs.existsSync(policyPath), "policy sidecar should be written");
	const storedPolicyJson = fs.readFileSync(policyPath, "utf-8");
	assert(storedPolicyJson.includes(JSON.stringify(workspaceRoot).slice(1, -1)), "server-side sidecar should retain raw workspace path for enforcement");
	const restoredPolicy = readPersistentRoomCapabilityPolicy(agentId, "c_workspace_policy_smoke", { persistentAgentsRoot });
	assert(restoredPolicy?.roots[0]?.realpath === fs.realpathSync.native(workspaceRoot), "stored policy should round-trip root realpath");
	assert(restoredPolicy?.workspaceAccessMode === "bounded", "stored policy should round-trip workspace access mode");
	assert(!JSON.stringify(persistentRoomCapabilityPolicyView(restoredPolicy)).includes(workspaceRoot), "stored policy view must stay redacted");
	const legacyPolicyRecord = JSON.parse(storedPolicyJson);
	delete legacyPolicyRecord.workspaceAccessMode;
	fs.writeFileSync(policyPath, JSON.stringify(legacyPolicyRecord, null, 2) + "\n");
	const legacyPolicy = readPersistentRoomCapabilityPolicy(agentId, "c_workspace_policy_smoke", { persistentAgentsRoot });
	assert(legacyPolicy?.workspaceAccessMode === "bounded", "stored legacy policy with missing workspaceAccessMode should default safely to bounded");
	assert(legacyPolicy?.bashEnabled === false, "stored legacy policy with missing bashEnabled should default safely to false");
	assert(persistentRoomCapabilityPolicyView(legacyPolicy).pathAccess === "workspace-only", "legacy policy view should remain workspace-only");
	fs.writeFileSync(policyPath, JSON.stringify({ ...legacyPolicyRecord, workspaceAccessMode: "unsafe" }, null, 2) + "\n");
	assert(readPersistentRoomCapabilityPolicy(agentId, "c_workspace_policy_smoke", { persistentAgentsRoot }) === null, "stored invalid workspaceAccessMode should fail closed");
	writePersistentRoomCapabilityPolicy(policy, { persistentAgentsRoot });

	const deletedPolicy = deletePersistentRoomCapabilityPolicy(agentId, "c_workspace_policy_smoke", { persistentAgentsRoot });
	assert(deletedPolicy.deleted === true, "delete should remove an existing policy sidecar");
	assert(!fs.existsSync(policyPath), "policy sidecar should be gone after delete");
	assert(readPersistentRoomCapabilityPolicy(agentId, "c_workspace_policy_smoke", { persistentAgentsRoot }) === null, "read should return null after delete");
	const deletedAgain = deletePersistentRoomCapabilityPolicy(agentId, "c_workspace_policy_smoke", { persistentAgentsRoot });
	assert(deletedAgain.deleted === false, "second delete should be safe no-op");

	const defaultPolicyPath = persistentRoomWorkspaceDefaultPath(agentId, { persistentAgentsRoot });
	const defaultSentinelSidecarPath = persistentRoomWorkspacePolicyPath(agentId, PERSISTENT_ROOM_WORKSPACE_DEFAULT_CONVERSATION_ID, { persistentAgentsRoot });
	assert(readPersistentRoomDefaultCapabilityPolicy(agentId, { persistentAgentsRoot }) === null, "missing room-default policy should read as null");
	assert(resolvePersistentRoomCapabilityPolicy(agentId, "c_workspace_policy_smoke", { persistentAgentsRoot }).source === "none", "resolver without thread/default policy should return none");
	const localFilesDefaultPolicy = createPersistentRoomCapabilityPolicy({ ...baseInput, conversationId: "c_local_files_default", root: workspaceRoot, source: "manual", mode: "read" });
	const localFilesDefaultView = persistentRoomCapabilityPolicyView(localFilesDefaultPolicy);
	assert(localFilesDefaultPolicy.workspaceAccessMode === "localFiles", "new policies should default to Local files mode");
	assert(localFilesDefaultView.pathAccess === "local-files", "new default Local files policy view should expose local-files path access");
	assert(localFilesDefaultView.nativePiFilesystemToolsEnabled === true, "new default Local files policy view should expose native Pi filesystem capability");
	assert(localFilesDefaultView.writeEnabled === true, "new default Local files policy view should expose native write/edit capability");
	assert(localFilesDefaultView.markdownWriteEnabled === false, "new default Local files policy view should not claim bounded Markdown-only write");
	assert(localFilesDefaultView.allowedToolNames.join(",") === "read,ls,find,grep,write,edit,read_spreadsheet", "new default Local files policy should expose fixed W5 local-files tools");
	assert(localFilesDefaultView.bashEnabled === false, "new default Local files policy must keep bash disabled");
	const localFilesBashPolicy = createPersistentRoomCapabilityPolicy({ ...baseInput, conversationId: "c_local_files_bash", root: workspaceRoot, workspaceAccessMode: "localFiles", source: "manual", mode: "read", bashEnabled: true });
	const localFilesBashView = persistentRoomCapabilityPolicyView(localFilesBashPolicy);
	assert(localFilesBashPolicy.bashEnabled === true, "Local files policy should persist explicit bash enabled");
	assert(localFilesBashView.bashEnabled === true, "Local files policy view should expose explicit bash enabled");
	const bashOnlyPolicy = createPersistentRoomCapabilityPolicy({ ...baseInput, conversationId: "c_local_files_bash_only", root: workspaceRoot, workspaceAccessMode: "localFiles", source: "manual", mode: "read", toolSelection: { kind: "custom", allowedToolNames: [] }, bashEnabled: true });
	assert(bashOnlyPolicy.allowedToolNames.length === 0 && persistentRoomCapabilityPolicyView(bashOnlyPolicy).bashEnabled === true, "Local files bash can be enabled independently of ordinary file tools");

	const defaultPolicy = createPersistentRoomDefaultCapabilityPolicy({
		...baseInput,
		root: defaultWorkspaceRoot,
		workspaceAccessMode: "bounded",
		displayLabel: "Default Workspace",
		source: "manual",
		mode: "read",
	});
	assert(defaultPolicy.conversationId === PERSISTENT_ROOM_WORKSPACE_DEFAULT_CONVERSATION_ID, "room-default policy should use only the internal default sentinel");
	writePersistentRoomDefaultCapabilityPolicy(defaultPolicy, { persistentAgentsRoot });
	assert(defaultPolicyPath === path.join(agentRoot, "runtime", "workspace-default.json"), "room-default policy should be stored as explicit room runtime default");
	assert(fs.existsSync(defaultPolicyPath), "room-default policy should be written");
	assert(!fs.existsSync(defaultSentinelSidecarPath), "room-default policy must not create a workspace-policies/room_default.json sidecar");
	const storedDefaultPolicyJson = fs.readFileSync(defaultPolicyPath, "utf-8");
	assert(storedDefaultPolicyJson.includes(JSON.stringify(defaultWorkspaceRoot).slice(1, -1)), "server-side room-default policy should retain raw workspace path for enforcement");
	const defaultViewJson = JSON.stringify(persistentRoomCapabilityPolicyView(defaultPolicy));
	assert(!defaultViewJson.includes(JSON.stringify(defaultWorkspaceRoot).slice(1, -1)), "room-default policy view must not expose raw workspace path");
	const resolvedDefault = resolvePersistentRoomCapabilityPolicy(agentId, "c_workspace_policy_smoke", { persistentAgentsRoot });
	assert(resolvedDefault.source === "room-default", "resolver should fall back to room-default policy when thread policy is missing");
	assert(resolvedDefault.policy?.roots[0]?.realpath === fs.realpathSync.native(defaultWorkspaceRoot), "resolver default fallback should return room-default root");
	writePersistentRoomCapabilityPolicy(policy, { persistentAgentsRoot });
	const resolvedThread = resolvePersistentRoomCapabilityPolicy(agentId, "c_workspace_policy_smoke", { persistentAgentsRoot });
	assert(resolvedThread.source === "thread", "resolver should prefer thread policy over room default");
	assert(resolvedThread.policy?.roots[0]?.realpath === fs.realpathSync.native(workspaceRoot), "resolver thread precedence should return thread root");
	deletePersistentRoomCapabilityPolicy(agentId, "c_workspace_policy_smoke", { persistentAgentsRoot });
	const deletedDefault = deletePersistentRoomDefaultCapabilityPolicy(agentId, { persistentAgentsRoot });
	assert(deletedDefault.deleted === true, "delete should remove room-default policy");
	assert(!fs.existsSync(defaultPolicyPath), "room-default policy should be gone after delete");
	assert(readPersistentRoomDefaultCapabilityPolicy(agentId, { persistentAgentsRoot }) === null, "default read should return null after delete");
	const deletedDefaultAgain = deletePersistentRoomDefaultCapabilityPolicy(agentId, { persistentAgentsRoot });
	assert(deletedDefaultAgain.deleted === false, "second room-default delete should be safe no-op");
	assert(resolvePersistentRoomCapabilityPolicy(agentId, "c_workspace_policy_smoke", { persistentAgentsRoot }).source === "none", "resolver should return none after thread/default policies are removed");

	expectPolicyError(() => createPersistentRoomCapabilityPolicy({ ...baseInput, root: "" }), "missing_root", "missing root");
	expectPolicyError(() => createPersistentRoomCapabilityPolicy({ ...baseInput, root: path.join(tmp, "missing") }), "root_not_found", "missing directory");
	const fileRoot = path.join(tmp, "file.txt");
	fs.writeFileSync(fileRoot, "not a directory");
	expectPolicyError(() => createPersistentRoomCapabilityPolicy({ ...baseInput, root: fileRoot }), "root_not_directory", "file path");
	expectPolicyError(() => createPersistentRoomCapabilityPolicy({ ...baseInput, root: repoRoot }), "forbidden_root", "repo root");
	expectPolicyError(() => createPersistentRoomCapabilityPolicy({ ...baseInput, root: repoChild }), "under_forbidden_root", "repo child");
	expectPolicyError(() => createPersistentRoomCapabilityPolicy({ ...baseInput, root: tmp }), "ancestor_of_forbidden_root", "ancestor containing repo and state roots");
	expectPolicyError(() => createPersistentRoomCapabilityPolicy({ ...baseInput, root: persistentAgentsRoot }), "forbidden_root", "persistent agents root");
	expectPolicyError(() => createPersistentRoomCapabilityPolicy({ ...baseInput, root: agentRoot }), "forbidden_root", "agent root");
	expectPolicyError(() => createPersistentRoomCapabilityPolicy({ ...baseInput, root: exxetaStateRoot }), "forbidden_root", "exxeta state root");

	const symlinkToRepo = path.join(tmp, "repo-link");
	try {
		fs.symlinkSync(repoRoot, symlinkToRepo, "dir");
		expectPolicyError(() => createPersistentRoomCapabilityPolicy({ ...baseInput, root: symlinkToRepo }), "forbidden_root", "symlink to repo root");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EPERM" && (error as NodeJS.ErrnoException).code !== "EACCES") throw error;
	}

	const safeTarget = path.join(tmp, "safe-target");
	const linkInsideState = path.join(exxetaStateRoot, "safe-link");
	fs.mkdirSync(safeTarget, { recursive: true });
	try {
		fs.symlinkSync(safeTarget, linkInsideState, "dir");
		expectPolicyError(() => createPersistentRoomCapabilityPolicy({ ...baseInput, root: linkInsideState }), "under_forbidden_root", "lexical path under exxeta symlinked out");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EPERM" && (error as NodeJS.ErrnoException).code !== "EACCES") throw error;
	}

	console.log("persistent-room workspace policy smoke passed");
} finally {
	fs.rmSync(tmp, { recursive: true, force: true });
}
