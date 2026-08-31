import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "exxeta-agent-mr10b-home-"));
const tempAgentsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "exxeta-agent-mr10b-root-"));
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

const {
	buildCheckpointProposal,
	createPersistentAgentFromScaffoldInput,
	parseCheckpointApprovalRequest,
	writeApprovedCheckpoint,
	writePersistentAgentThread,
} = await import("../src/persistent-agents.js");
const {
	createPersistentRoomCapabilityPolicy,
	deletePersistentRoomCapabilityPolicy,
	persistentRoomCapabilityPolicyView,
	persistentRoomWorkspacePolicyPath,
	readPersistentRoomCapabilityPolicy,
	writePersistentRoomCapabilityPolicy,
} = await import("../src/persistent-room-workspace-policy.js");

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

function readText(file: string): string {
	return fs.readFileSync(file, "utf-8");
}

function readJson(file: string): any {
	return JSON.parse(readText(file));
}

function fileCount(dir: string, predicate: (name: string) => boolean): number {
	return fs.existsSync(dir) ? fs.readdirSync(dir).filter(predicate).length : 0;
}

function checkpointArchiveCount(agentRoot: string): number {
	return fileCount(path.join(agentRoot, "L1b", "archive"), (name) => /before-cp_.*\.md$/.test(name));
}

function checkpointEventCount(agentRoot: string): number {
	return fileCount(path.join(agentRoot, "events", "checkpoint"), (name) => name.endsWith(".json"));
}

function workspacePolicyCount(agentRoot: string): number {
	return fileCount(path.join(agentRoot, "runtime", "workspace-policies"), (name) => name.endsWith(".json"));
}

function expectThrows(fn: () => unknown, expected: RegExp, label: string): void {
	try {
		fn();
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		assert(expected.test(message), `${label}: expected ${expected}, got ${message}`);
		return;
	}
	throw new Error(`${label}: expected error`);
}

try {
	const repoRoot = path.join(tempHome, "repo");
	const workspaceRoot = path.join(tempHome, "workspace");
	const exxetaStateRoot = path.join(tempHome, ".exxeta");
	for (const dir of [repoRoot, workspaceRoot, exxetaStateRoot]) fs.mkdirSync(dir, { recursive: true });

	const control = createPersistentAgentFromScaffoldInput({
		displayName: "Checkpoint Workspace Control Room",
		userName: "Synthetic User",
		preferredUserAddress: "Synthetic User",
	});
	const controlAgentId = control.agent.agentId;
	const controlRoot = path.join(tempAgentsRoot, controlAgentId);
	const controlL1bPath = path.join(controlRoot, "L1b", "current.md");
	const controlL1bBefore = readText(controlL1bPath);
	const controlArchiveCountBefore = checkpointArchiveCount(controlRoot);
	const controlEventCountBefore = checkpointEventCount(controlRoot);
	const controlWorkspacePolicyCountBefore = workspacePolicyCount(controlRoot);

	const created = createPersistentAgentFromScaffoldInput({
		displayName: "Wolfgang MR10b Smoke",
		userName: "Synthetic User",
		preferredUserAddress: "Synthetic User",
	});
	const agentId = created.agent.agentId;
	assert(agentId !== controlAgentId, "selected room must be distinct from control room");
	assert(created.status.status === "ready", "selected room should be ready");
	const selectedRoot = path.join(tempAgentsRoot, agentId);
	const selectedL1bPath = path.join(selectedRoot, "L1b", "current.md");
	assert(fs.existsSync(selectedL1bPath), "selected room L1b/current.md should exist");
	const selectedL1bBefore = readText(selectedL1bPath);

	const conversationId = "mr10b_selected_room_thread";
	const policy = createPersistentRoomCapabilityPolicy({
		agentId,
		conversationId,
		repoRoot,
		persistentAgentsRoot: tempAgentsRoot,
		exxetaStateRoot,
		root: workspaceRoot,
		displayLabel: "Synthetic Workspace",
		source: "manual",
		now: new Date("2026-05-30T10:00:00.000Z"),
	});
	writePersistentRoomCapabilityPolicy(policy, { persistentAgentsRoot: tempAgentsRoot });
	const selectedPolicyPath = persistentRoomWorkspacePolicyPath(agentId, conversationId, { persistentAgentsRoot: tempAgentsRoot });
	const controlPolicyPath = persistentRoomWorkspacePolicyPath(controlAgentId, conversationId, { persistentAgentsRoot: tempAgentsRoot });
	assert(selectedPolicyPath === path.join(selectedRoot, "runtime", "workspace-policies", `${conversationId}.json`), "workspace policy should be under selected room root");
	assert(fs.existsSync(selectedPolicyPath), "selected workspace policy should be written");
	assert(!fs.existsSync(controlPolicyPath), "workspace policy must not be written under control room");
	assert(workspacePolicyCount(selectedRoot) === 1, "selected room should have one workspace policy");
	assert(workspacePolicyCount(controlRoot) === controlWorkspacePolicyCountBefore, "control room workspace policy count must remain unchanged");
	const restoredPolicy = readPersistentRoomCapabilityPolicy(agentId, conversationId, { persistentAgentsRoot: tempAgentsRoot });
	assert(restoredPolicy?.agentId === agentId, "read policy should belong to selected room");
	const policyViewJson = JSON.stringify(persistentRoomCapabilityPolicyView(restoredPolicy));
	assert(!policyViewJson.includes(workspaceRoot), "policy view should not expose raw workspace root");
	const deletedPolicy = deletePersistentRoomCapabilityPolicy(agentId, conversationId, { persistentAgentsRoot: tempAgentsRoot });
	assert(deletedPolicy.deleted === true, "delete should remove selected workspace policy");
	assert(!fs.existsSync(selectedPolicyPath), "selected workspace policy should be removed after delete");
	assert(workspacePolicyCount(controlRoot) === controlWorkspacePolicyCountBefore, "control room workspace policy count must remain unchanged after delete");
	expectThrows(
		() => createPersistentRoomCapabilityPolicy({
			agentId,
			conversationId: "mr10b_forbidden_selected_root",
			repoRoot,
			persistentAgentsRoot: tempAgentsRoot,
			exxetaStateRoot,
			root: selectedRoot,
		}),
		/blocked by policy|forbidden/i,
		"selected room root should be forbidden as a workspace",
	);

	const threadModel = { provider: "openai-compatible", model: "gpt-5.5", label: "GPT 5.5" };
	writePersistentAgentThread(agentId, conversationId, {
		state: "active",
		origin: "launcher",
		model: threadModel,
		items: [
			{ kind: "user", id: "u1", text: "Synthetic selected-room checkpoint request." },
			{ kind: "assistant", id: "a1", text: "Synthetic selected-room checkpoint plan accepted." },
		],
	});

	const proposal = await buildCheckpointProposal({
		agentId,
		conversationId,
		model: threadModel,
		density: "standard",
		rememberText: "Synthetic MR10b selected-room checkpoint smoke.",
		items: [
			{ kind: "user", id: "u1", text: "Synthetic selected-room checkpoint request." },
			{ kind: "assistant", id: "a1", text: "Synthetic selected-room checkpoint plan accepted." },
		],
	}, async (_prompt, modelLock) => ({
		text: `TITLE:\nSelected-room checkpoint smoke\n\nSESSION_ARC:\nA synthetic non-default room thread moved from checkpoint request to approved durable summary.\n\nBODY:\n- Selected-room workspace and checkpoint targeting were validated without provider calls.\n- Durable memory should change only under the selected room root.\n\nPARKED:\nNone\n`,
		usage: { input: 1, output: 1, totalTokens: 2, cost: 0 },
		model: modelLock,
	}));
	assert(proposal.agentId === agentId, "proposal should target selected room");
	assert(proposal.conversationId === conversationId, "proposal should target selected conversation");
	assert(proposal.writesMemory === false, "proposal should be non-mutating");

	expectThrows(
		() => parseCheckpointApprovalRequest({
			conversationId,
			model: threadModel,
			density: proposal.density,
			proposal: { ...proposal, agentId: controlAgentId },
			approvedRecentContext: proposal.proposedRecentContext,
		}, agentId),
		/proposal agentId does not match/i,
		"proposal/route agentId mismatch should reject",
	);
	assert(readText(selectedL1bPath) === selectedL1bBefore, "mismatch rejection must not mutate selected L1b");
	assert(readText(controlL1bPath) === controlL1bBefore, "mismatch rejection must not mutate control L1b");
	assert(checkpointArchiveCount(controlRoot) === controlArchiveCountBefore, "mismatch rejection must not archive control L1b");
	assert(checkpointEventCount(controlRoot) === controlEventCountBefore, "mismatch rejection must not write control checkpoint events");

	const parsed = parseCheckpointApprovalRequest({
		conversationId,
		model: threadModel,
		density: proposal.density,
		proposal,
		approvedRecentContext: proposal.proposedRecentContext,
	}, agentId);
	const result = writeApprovedCheckpoint(parsed.request, parsed.warnings, new Date("2026-05-30T11:00:00.000Z"));
	const selectedL1bAfter = readText(selectedL1bPath);
	assert(result.agentId === agentId, "approval response should identify selected room");
	assert(result.conversationId === conversationId, "approval response should identify selected conversation");
	assert(selectedL1bAfter !== selectedL1bBefore, "selected room L1b/current.md should change after checkpoint approval");
	assert(/^### RC-0001 \|/m.test(selectedL1bAfter), "selected room should contain first durable Recent Context entry");
	assert(checkpointArchiveCount(selectedRoot) === 1, "selected room should receive one checkpoint archive");
	assert(checkpointEventCount(selectedRoot) === 1, "selected room should receive one checkpoint event");
	assert(result.eventRecordPath === path.join(selectedRoot, result.eventRelPath), "approval event path should be selected-root relative");
	assert(fs.existsSync(result.eventRecordPath), "selected room checkpoint event should exist");
	const eventRecord = readJson(result.eventRecordPath);
	assert(eventRecord.agentId === agentId, "event should record selected room id");
	assert(eventRecord.conversationId === conversationId, "event should record selected conversation id");
	assert(eventRecord.paths?.updatedL1bRelPath === "L1b/current.md", "event updated L1b path should be selected-root relative");
	assert(typeof eventRecord.paths?.archivedL1bRelPath === "string" && !path.isAbsolute(eventRecord.paths.archivedL1bRelPath), "event archive path should be relative");
	assert(typeof eventRecord.paths?.eventRelPath === "string" && !path.isAbsolute(eventRecord.paths.eventRelPath), "event path should be relative");
	const serializedEvent = JSON.stringify(eventRecord);
	assert(!serializedEvent.includes(tempAgentsRoot), "event must not include temp persistent agents root");
	assert(!serializedEvent.includes(selectedRoot), "event must not include selected absolute room root");
	assert(!serializedEvent.includes(controlRoot), "event must not include control absolute room root");

	assert(readText(controlL1bPath) === controlL1bBefore, "selected checkpoint must not mutate control L1b/current.md");
	assert(checkpointArchiveCount(controlRoot) === controlArchiveCountBefore, "selected checkpoint must not archive control L1b");
	assert(checkpointEventCount(controlRoot) === controlEventCountBefore, "selected checkpoint must not write control checkpoint events");
	assert(workspacePolicyCount(controlRoot) === controlWorkspacePolicyCountBefore, "selected operations must not write control workspace policies");

	fs.rmSync(tempAgentsRoot, { recursive: true, force: true });
	fs.rmSync(tempHome, { recursive: true, force: true });
	console.log("persistent-agent non-default checkpoint/workspace smoke passed");
} catch (error) {
	console.error(error instanceof Error ? error.stack || error.message : error);
	console.error(`temp HOME preserved for inspection: ${tempHome}`);
	console.error(`temp agents root preserved for inspection: ${tempAgentsRoot}`);
	process.exitCode = 1;
}
