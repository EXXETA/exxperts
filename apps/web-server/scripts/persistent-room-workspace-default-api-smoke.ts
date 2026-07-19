import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { authedFetch, type AuthedFetchInit, SMOKE_SERVER_AUTH_ENV, SMOKE_SERVER_SPAWN_TREE_OPTIONS, stopSmokeServer } from "./smoke-server-process.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "exxeta-workspace-default-api-home-"));
const tempAgentsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "exxeta-workspace-default-api-agents-"));
process.env.HOME = tempHome;
process.env.USERPROFILE = tempHome;
const smokeAppDir = path.join(tempHome, ".exxperts", "app");
fs.mkdirSync(smokeAppDir, { recursive: true });
fs.writeFileSync(
	path.join(smokeAppDir, "openai-compatible-ai-profile.json"),
	JSON.stringify({ profileId: "openai-compatible", providerId: "openai-compatible", label: "Synthetic Gateway", roomModels: [{ modelId: "gpt-5.5" }, { modelId: "claude-opus-4.6" }], maintenanceModel: "claude-opus-4.6" }, null, 2),
);
fs.writeFileSync(path.join(smokeAppDir, "persistent-agent-ai-profile.json"), JSON.stringify({ profileId: "openai-compatible" }, null, 2));
process.env.EXXETA_PERSISTENT_AGENTS_ROOT = tempAgentsRoot;
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const webServerDir = path.resolve(scriptDir, "..");
const repoRoot = path.resolve(webServerDir, "..", "..");
const port = 23000 + Math.floor(Math.random() * 10000);
const baseUrl = `http://127.0.0.1:${port}`;

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

async function waitForServer(server: ChildProcessWithoutNullStreams): Promise<void> {
	const deadline = Date.now() + 15000;
	let lastError = "server did not respond";
	while (Date.now() < deadline) {
		if (server.exitCode != null) throw new Error(`server exited before startup with code ${server.exitCode}`);
		try {
			const response = await fetch(`${baseUrl}/healthz`);
			if (response.ok) return;
			lastError = `healthz returned ${response.status}`;
		} catch (error) {
			lastError = (error as Error).message;
		}
		await new Promise((resolve) => setTimeout(resolve, 150));
	}
	throw new Error(`server did not become ready: ${lastError}`);
}

async function requestJson(pathname: string, init: AuthedFetchInit = {}): Promise<{ status: number; body: any }> {
	const response = await authedFetch(`${baseUrl}${pathname}`, {
		...init,
		headers: {
			...(init.body ? { "content-type": "application/json" } : {}),
			...(init.headers ?? {}),
		},
	});
	const text = await response.text();
	return { status: response.status, body: text ? JSON.parse(text) : null };
}

function assertNoPathLeak(value: unknown, label: string, blockedPaths: string[]): void {
	const serialized = JSON.stringify(value);
	for (const blockedPath of blockedPaths) {
		assert(!serialized.includes(blockedPath), `${label}: response must not leak absolute path ${blockedPath}`);
	}
	assert(!serialized.includes("realpath"), `${label}: response must not expose realpath field`);
	assert(!serialized.includes('"path"'), `${label}: response must not expose raw path field`);
}

let server: ChildProcessWithoutNullStreams | null = null;
const serverOutput: string[] = [];

try {
	const productAppStateRoot = path.join(tempHome, ".exxperts", "app");
	const workspaceRoot = path.join(tempHome, "workspace-default-api");
	fs.mkdirSync(productAppStateRoot, { recursive: true });
	fs.mkdirSync(workspaceRoot, { recursive: true });

	server = spawn("npx", ["tsx", "src/index.ts"], {
		shell: process.platform === "win32",
		...SMOKE_SERVER_SPAWN_TREE_OPTIONS,
		cwd: webServerDir,
		env: {
			...process.env,
			HOME: tempHome, USERPROFILE: tempHome,
			PORT: String(port),
			...SMOKE_SERVER_AUTH_ENV,
			EXXETA_HOME: repoRoot,
			EXXETA_PERSISTENT_AGENTS_ROOT: tempAgentsRoot,
		},
	});
	server.stdout.on("data", (chunk) => serverOutput.push(String(chunk)));
	server.stderr.on("data", (chunk) => serverOutput.push(String(chunk)));
	await waitForServer(server);
	assert(fs.existsSync(path.join(productAppStateRoot, "agents")), "web-server startup should create product app agents dir");
	assert(fs.existsSync(path.join(productAppStateRoot, "skills")), "web-server startup should create product app skills dir");
	const { writePersistentAgentThread } = await import("../src/persistent-agents.js");
	const { persistentRoomWorkspacePolicyPath } = await import("../src/persistent-room-workspace-policy.js");
	const model = { provider: "openai-compatible", model: "gpt-5.5", label: "GPT 5.5" };

	const created = await requestJson("/api/persistent-agents", {
		method: "POST",
		body: JSON.stringify({
			displayName: "Workspace Default API Smoke",
			userName: "Synthetic User",
			preferredUserAddress: "Synthetic User",
		}),
	});
	assert(created.status === 201, `create room should succeed without workspace default, got ${created.status}: ${JSON.stringify(created.body)}`);
	const agentId = String(created.body?.agent?.agentId ?? "");
	assert(agentId, "created room should return agentId");
	const encodedAgentId = encodeURIComponent(agentId);
	const agentRoot = path.join(tempAgentsRoot, agentId);
	const defaultPath = path.join(agentRoot, "runtime", "workspace-default.json");
	const sentinelSidecarPath = path.join(agentRoot, "runtime", "workspace-policies", "room_default.json");

	let getDefault = await requestJson(`/api/persistent-agents/${encodedAgentId}/workspace-default`);
	assert(getDefault.status === 200, `initial default GET should succeed, got ${getDefault.status}`);
	assert(getDefault.body?.policy === null, "missing room default should return null");
	assert(!fs.existsSync(defaultPath), "missing room default should not create default sidecar");
	assert(!fs.existsSync(sentinelSidecarPath), "missing room default must not create room_default thread sidecar");

	const putDefault = await requestJson(`/api/persistent-agents/${encodedAgentId}/workspace-default`, {
		method: "PUT",
		body: JSON.stringify({ root: workspaceRoot, displayLabel: "Smoke Workspace", mode: "read-only" }),
	});
	assert(putDefault.status === 200, `PUT default should succeed, got ${putDefault.status}: ${JSON.stringify(putDefault.body)}`);
	assert(putDefault.body?.storage?.kind === "persistent-agent-runtime-default", "PUT should report room-default storage kind");
	assert(putDefault.body?.policy?.rootCount === 1, "PUT should return one redacted root");
	assert(putDefault.body?.policy?.roots?.[0]?.displayLabel === "Smoke Workspace", "PUT should preserve safe display label");
	assert(putDefault.body?.policy?.workspaceAccessMode === "localFiles", "PUT without explicit mode should default new room workspace to Local files");
	assert(putDefault.body?.policy?.pathAccess === "local-files", "Local files default should expose local-files path access");
	assert(putDefault.body?.policy?.nativePiFilesystemToolsEnabled === true, "Local files default should expose native Pi filesystem tools");
	assert(putDefault.body?.policy?.bashEnabled === false, "Local files default should keep bash disabled");
	assert(putDefault.body?.policy?.allowedToolNames?.join(",") === "read,ls,find,grep,write,edit,read_spreadsheet", "Local files default should expose fixed W5 tool set");
	assertNoPathLeak(putDefault.body, "PUT default", [tempHome, tempAgentsRoot, repoRoot, workspaceRoot, agentRoot]);
	assert(fs.existsSync(defaultPath), "PUT should write runtime/workspace-default.json");
	assert(!fs.existsSync(sentinelSidecarPath), "PUT default must not create workspace-policies/room_default.json");

	getDefault = await requestJson(`/api/persistent-agents/${encodedAgentId}/workspace-default`);
	assert(getDefault.status === 200, `saved default GET should succeed, got ${getDefault.status}`);
	assert(getDefault.body?.policy?.rootCount === 1, "saved default GET should return redacted policy view");
	assertNoPathLeak(getDefault.body, "GET saved default", [tempHome, tempAgentsRoot, repoRoot, workspaceRoot, agentRoot]);
	assert(Array.isArray(getDefault.body?.warnings) && getDefault.body.warnings.length === 0, "saved default GET with existing folder should return no warnings");

	// Migrated/renamed workspace: the granted folder no longer exists on this machine.
	fs.rmSync(workspaceRoot, { recursive: true, force: true });
	const getMissingRoot = await requestJson(`/api/persistent-agents/${encodedAgentId}/workspace-default`);
	assert(getMissingRoot.status === 200, `missing-folder GET should still succeed, got ${getMissingRoot.status}`);
	assert(getMissingRoot.body?.policy?.rootCount === 1, "missing-folder GET should keep the saved policy");
	const missingWarnings: string[] = getMissingRoot.body?.warnings ?? [];
	assert(missingWarnings.some((warning) => warning.includes("was not found on this machine")), `missing-folder GET should warn, got ${JSON.stringify(missingWarnings)}`);
	assert(missingWarnings.some((warning) => warning.includes("Smoke Workspace")), "missing-folder warning should name the workspace by its safe label");
	assertNoPathLeak(getMissingRoot.body, "GET missing-folder default", [tempHome, tempAgentsRoot, repoRoot, workspaceRoot, agentRoot]);
	fs.mkdirSync(workspaceRoot, { recursive: true });
	const getRestoredRoot = await requestJson(`/api/persistent-agents/${encodedAgentId}/workspace-default`);
	assert((getRestoredRoot.body?.warnings ?? []).length === 0, "restored-folder GET should clear the warning");

	const noRootUpdate = await requestJson(`/api/persistent-agents/${encodedAgentId}/workspace-default`, {
		method: "PUT",
		body: JSON.stringify({ mode: "read-only" }),
	});
	assert(noRootUpdate.status === 200, `PUT no-root default update should succeed, got ${noRootUpdate.status}: ${JSON.stringify(noRootUpdate.body)}`);
	assert(noRootUpdate.body?.policy?.workspaceAccessMode === "localFiles", "no-root default update should preserve existing workspace access mode when omitted");
	assert(noRootUpdate.body?.policy?.allowedToolNames?.join(",") === "read,ls,find,grep,write,edit,read_spreadsheet", "no-root Local files update should keep fixed W5 tools");
	assertNoPathLeak(noRootUpdate.body, "PUT no-root default update", [tempHome, tempAgentsRoot, repoRoot, workspaceRoot, agentRoot]);

	const enableBashNoRoot = await requestJson(`/api/persistent-agents/${encodedAgentId}/workspace-default`, {
		method: "PUT",
		body: JSON.stringify({ workspaceAccessMode: "localFiles", mode: "read-only", toolSelection: { kind: "custom", allowedToolNames: [] }, bashEnabled: true }),
	});
	assert(enableBashNoRoot.status === 200, `PUT no-root bash enable should succeed, got ${enableBashNoRoot.status}: ${JSON.stringify(enableBashNoRoot.body)}`);
	assert(enableBashNoRoot.body?.policy?.workspaceAccessMode === "localFiles", "bash enable update should preserve Local files mode");
	assert(enableBashNoRoot.body?.policy?.allowedToolNames?.length === 0, "bash enable update should allow ordinary Local files tools to be all off");
	assert(enableBashNoRoot.body?.policy?.bashEnabled === true, "bash enable update should expose explicit bash enabled");
	assertNoPathLeak(enableBashNoRoot.body, "PUT no-root bash enable", [tempHome, tempAgentsRoot, repoRoot, workspaceRoot, agentRoot]);

	const invalidLocalFilesToolSelection = await requestJson(`/api/persistent-agents/${encodedAgentId}/workspace-default`, {
		method: "PUT",
		body: JSON.stringify({ workspaceAccessMode: "localFiles", mode: "read-only", toolSelection: { kind: "custom", allowedToolNames: ["read", "bash"] } }),
	});
	assert(invalidLocalFilesToolSelection.status === 400, `Local files bash tool selection should reject, got ${invalidLocalFilesToolSelection.status}: ${JSON.stringify(invalidLocalFilesToolSelection.body)}`);
	assertNoPathLeak(invalidLocalFilesToolSelection.body, "invalid Local files bash tool selection", [tempHome, tempAgentsRoot, repoRoot, workspaceRoot, agentRoot]);
	const invalidLocalFilesBoundedToolSelection = await requestJson(`/api/persistent-agents/${encodedAgentId}/workspace-default`, {
		method: "PUT",
		body: JSON.stringify({ workspaceAccessMode: "localFiles", mode: "read-only", toolSelection: { kind: "custom", allowedToolNames: ["read", "write_markdown_file"] } }),
	});
	assert(invalidLocalFilesBoundedToolSelection.status === 400, `Local files bounded-only tool selection should reject, got ${invalidLocalFilesBoundedToolSelection.status}: ${JSON.stringify(invalidLocalFilesBoundedToolSelection.body)}`);
	assertNoPathLeak(invalidLocalFilesBoundedToolSelection.body, "invalid Local files bounded-only tool selection", [tempHome, tempAgentsRoot, repoRoot, workspaceRoot, agentRoot]);
	const invalidBoundedToolSelection = await requestJson(`/api/persistent-agents/${encodedAgentId}/workspace-default`, {
		method: "PUT",
		body: JSON.stringify({ workspaceAccessMode: "bounded", mode: "read-only", toolSelection: { kind: "custom", allowedToolNames: ["read", "grep"] } }),
	});
	assert(invalidBoundedToolSelection.status === 400, `bounded grep tool selection should reject, got ${invalidBoundedToolSelection.status}: ${JSON.stringify(invalidBoundedToolSelection.body)}`);
	assertNoPathLeak(invalidBoundedToolSelection.body, "invalid bounded grep tool selection", [tempHome, tempAgentsRoot, repoRoot, workspaceRoot, agentRoot]);

	const legacyThreadId = "legacy_active_workspace_default";
	writePersistentAgentThread(agentId, legacyThreadId, {
		state: "standby",
		origin: "home",
		model,
		items: [{ kind: "user", text: "legacy visible turn before workspace snapshots existed" }],
	});
	const legacySidecarPath = persistentRoomWorkspacePolicyPath(agentId, legacyThreadId, { persistentAgentsRoot: tempAgentsRoot });
	assert(!fs.existsSync(legacySidecarPath), "legacy active thread fixture should start without a workspace sidecar");
	const changedWorkspaceRoot = path.join(tempHome, "workspace-default-api-changed");
	fs.mkdirSync(changedWorkspaceRoot, { recursive: true });
	const changedDefault = await requestJson(`/api/persistent-agents/${encodedAgentId}/workspace-default`, {
		method: "PUT",
		body: JSON.stringify({ root: changedWorkspaceRoot, displayLabel: "Changed Workspace", workspaceAccessMode: "bounded", mode: "read-only", bashEnabled: true }),
	});
	assert(changedDefault.status === 200, `PUT changed default should preserve legacy active thread and succeed, got ${changedDefault.status}: ${JSON.stringify(changedDefault.body)}`);
	assert(changedDefault.body?.policy?.workspaceAccessMode === "bounded", "explicit changed default should save bounded workspace mode");
	assert(changedDefault.body?.policy?.pathAccess === "workspace-only", "explicit bounded default should expose workspace-only path access");
	assert(changedDefault.body?.policy?.bashEnabled === false, "explicit bounded default should force bash disabled even when requested");
	assert(changedDefault.body?.policy?.writeEnabled === true, "bounded default should enable bounded Markdown workspace write");
	assert(Array.isArray(changedDefault.body?.warnings) && changedDefault.body.warnings.length === 1, "changed default should report preservation warning");
	assert(fs.existsSync(legacySidecarPath), "changing default should snapshot current default into legacy active thread sidecar before mutation");
	const legacySidecarJson = fs.readFileSync(legacySidecarPath, "utf-8");
	assert(legacySidecarJson.includes(JSON.stringify(workspaceRoot).slice(1, -1)), "legacy active thread sidecar should preserve original default root");
	assert(legacySidecarJson.includes('"bashEnabled": true'), "legacy active thread sidecar should preserve original default bash setting before mutation");
	assert(!legacySidecarJson.includes(JSON.stringify(changedWorkspaceRoot).slice(1, -1)), "legacy active thread sidecar must not be rewritten to changed default root");
	const changedDefaultJson = fs.readFileSync(defaultPath, "utf-8");
	assert(changedDefaultJson.includes(JSON.stringify(changedWorkspaceRoot).slice(1, -1)), "room default should be updated to changed workspace root");
	assertNoPathLeak(changedDefault.body, "PUT changed default", [tempHome, tempAgentsRoot, repoRoot, workspaceRoot, changedWorkspaceRoot, agentRoot]);

	const invalidRepo = await requestJson(`/api/persistent-agents/${encodedAgentId}/workspace-default`, {
		method: "PUT",
		body: JSON.stringify({ root: repoRoot, mode: "read-only" }),
	});
	assert(invalidRepo.status === 400, `repo root should reject, got ${invalidRepo.status}`);
	assert(invalidRepo.body?.code === "forbidden_root", `repo root should reject as forbidden_root, got ${JSON.stringify(invalidRepo.body)}`);
	assertNoPathLeak(invalidRepo.body, "invalid repo root", [tempHome, tempAgentsRoot, repoRoot, workspaceRoot, agentRoot]);

	const invalidProductAppRoot = await requestJson(`/api/persistent-agents/${encodedAgentId}/workspace-default`, {
		method: "PUT",
		body: JSON.stringify({ root: productAppStateRoot, mode: "read-only" }),
	});
	assert(invalidProductAppRoot.status === 400, `~/.exxperts/app root should reject, got ${invalidProductAppRoot.status}`);
	assert(invalidProductAppRoot.body?.code === "forbidden_root", `~/.exxperts/app should reject as forbidden_root, got ${JSON.stringify(invalidProductAppRoot.body)}`);
	assertNoPathLeak(invalidProductAppRoot.body, "invalid product app root", [tempHome, tempAgentsRoot, repoRoot, workspaceRoot, agentRoot]);

	const invalidRoomRoot = await requestJson(`/api/persistent-agents/${encodedAgentId}/workspace-default`, {
		method: "PUT",
		body: JSON.stringify({ root: agentRoot, mode: "read-only" }),
	});
	assert(invalidRoomRoot.status === 400, `room root should reject, got ${invalidRoomRoot.status}`);
	assert(invalidRoomRoot.body?.code === "forbidden_root", `room root should reject as forbidden_root, got ${JSON.stringify(invalidRoomRoot.body)}`);
	assertNoPathLeak(invalidRoomRoot.body, "invalid room root", [tempHome, tempAgentsRoot, repoRoot, workspaceRoot, agentRoot]);

	const deleted = await requestJson(`/api/persistent-agents/${encodedAgentId}/workspace-default`, { method: "DELETE" });
	assert(deleted.status === 200, `DELETE default should succeed, got ${deleted.status}`);
	assert(deleted.body?.deleted === true, "DELETE should report existing default deleted");
	assert(deleted.body?.policy === null, "DELETE should return null policy");
	assert(!fs.existsSync(defaultPath), "DELETE should remove runtime/workspace-default.json");
	assert(!fs.existsSync(sentinelSidecarPath), "DELETE must not create room_default thread sidecar");

	const noDefaultThreadId = "legacy_no_default_thread";
	writePersistentAgentThread(agentId, noDefaultThreadId, {
		state: "standby",
		origin: "home",
		model,
		items: [{ kind: "user", text: "legacy visible turn with no workspace default" }],
	});
	const noDefaultSidecarPath = persistentRoomWorkspacePolicyPath(agentId, noDefaultThreadId, { persistentAgentsRoot: tempAgentsRoot });
	assert(!fs.existsSync(noDefaultSidecarPath), "no-default active thread fixture should not have a workspace sidecar");
	const blockedNoDefaultSet = await requestJson(`/api/persistent-agents/${encodedAgentId}/workspace-default`, {
		method: "PUT",
		body: JSON.stringify({ root: workspaceRoot, displayLabel: "Blocked Workspace", workspaceAccessMode: "localFiles", mode: "read-only" }),
	});
	assert(blockedNoDefaultSet.status === 409, `setting default from none with message-bearing active thread should block, got ${blockedNoDefaultSet.status}: ${JSON.stringify(blockedNoDefaultSet.body)}`);
	assert(blockedNoDefaultSet.body?.code === "active_thread_requires_workspace_boundary", `blocked no-default set should return boundary code, got ${JSON.stringify(blockedNoDefaultSet.body)}`);
	assert(!fs.existsSync(noDefaultSidecarPath), "blocked no-default set should not create a sidecar");
	assertNoPathLeak(blockedNoDefaultSet.body, "blocked no-default set", [tempHome, tempAgentsRoot, repoRoot, workspaceRoot, changedWorkspaceRoot, agentRoot]);

	const deletedAgain = await requestJson(`/api/persistent-agents/${encodedAgentId}/workspace-default`, { method: "DELETE" });
	assert(deletedAgain.status === 200, `second DELETE default should succeed, got ${deletedAgain.status}`);
	assert(deletedAgain.body?.deleted === false, "second DELETE should be idempotent no-op");
	getDefault = await requestJson(`/api/persistent-agents/${encodedAgentId}/workspace-default`);
	assert(getDefault.status === 200 && getDefault.body?.policy === null, "GET after delete should return null policy");

	console.log("persistent-room workspace default API smoke passed");
} catch (error) {
	const output = serverOutput.join("").trim();
	if (output) console.error(output.split("\n").slice(-60).join("\n"));
	console.error(error instanceof Error ? error.stack || error.message : error);
	console.error(`temp HOME preserved for inspection: ${tempHome}`);
	console.error(`temp agents root preserved for inspection: ${tempAgentsRoot}`);
	process.exitCode = 1;
} finally {
	await stopSmokeServer(server);
	if (process.exitCode == null || process.exitCode === 0) {
		fs.rmSync(tempHome, { recursive: true, force: true });
		fs.rmSync(tempAgentsRoot, { recursive: true, force: true });
	}
}
