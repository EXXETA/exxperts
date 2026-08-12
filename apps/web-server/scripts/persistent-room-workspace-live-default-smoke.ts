import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "exxeta-workspace-live-home-"));
const tempAgentsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "exxeta-workspace-live-agents-"));
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
	buildPersistentRoomCurrentWorkspaceSection,
	createPersistentAgentInstance,
	createPersistentAgentPiSessionJsonlThreadRuntime,
	readPersistentAgentBootPromptSnapshot,
	writePersistentAgentThread,
} = await import("../src/persistent-agents.js");
const {
	assertPersistentRoomWorkspaceDefaultMutable,
	createPersistentRoomCapabilityPolicy,
	createPersistentRoomDefaultCapabilityPolicy,
	deletePersistentRoomDefaultCapabilityPolicy,
	persistentRoomRuntimeCwdForEffectiveWorkspacePolicy,
	persistentRoomWorkspaceDefaultPath,
	persistentRoomWorkspacePolicyPath,
	readPersistentRoomCapabilityPolicy,
	releasePersistentRoomThreadWorkspaceMirror,
	resolvePersistentRoomEffectiveWorkspacePolicy,
	writePersistentRoomCapabilityPolicy,
	writePersistentRoomDefaultCapabilityPolicy,
} = await import("../src/persistent-room-workspace-policy.js");

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

function expectMutationRefused(activeThread: { inFlight: boolean; cancelling: boolean }, expected: RegExp, label: string): void {
	try {
		assertPersistentRoomWorkspaceDefaultMutable(activeThread);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		assert(expected.test(message), `${label}: expected ${expected}, got ${message}`);
		assert((error as any).statusCode === 409, `${label}: expected 409, got ${(error as any).statusCode}`);
		assert((error as any).code === "active_turn_in_flight", `${label}: expected active_turn_in_flight code, got ${(error as any).code}`);
		return;
	}
	throw new Error(`${label}: expected refusal`);
}

function l1b(agentId: string): string {
	return `<!-- exxeta:l1b schema_version=1 -->\n\n## Chronos\n\n- Persistent agent id: ${agentId}\n- Last checkpoint: none\n\n## Deep Memory\n\nWorkspace live-default smoke deep memory.\n\n## Active Items\n\nWorkspace live-default smoke active item.\n\n## Recent Context\n\nNo checkpointed sessions yet.\n`;
}

function writeFixtureAgent(agentId: string): void {
	const root = path.join(tempAgentsRoot, agentId);
	fs.mkdirSync(path.join(root, "L1b", "archive"), { recursive: true, mode: 0o700 });
	fs.mkdirSync(path.join(root, "events", "checkpoint"), { recursive: true, mode: 0o700 });
	fs.mkdirSync(path.join(root, "events", "absorb"), { recursive: true, mode: 0o700 });
	fs.mkdirSync(path.join(root, "events", "structural-review"), { recursive: true, mode: 0o700 });
	const now = Date.now();
	fs.writeFileSync(path.join(root, "agent.json"), JSON.stringify({
		schemaVersion: 1,
		id: agentId,
		displayName: "Workspace Live Default Smoke Room",
		description: "Workspace live-default smoke fixture",
		role: "smoke-fixture",
		status: "ready",
		createdAt: now,
		updatedAt: now,
		l1aPath: "L1a.md",
		l1bCurrentPath: "L1b/current.md",
		l1bArchiveDir: "L1b/archive",
		sectionRegistryPath: "section_registry.json",
		currentSessionId: null,
		lastCheckpointId: null,
		recentContextSoftCap: 7,
		recentContextHardCap: 10,
		memoryTokenBudget: 12000,
	}, null, 2) + "\n", { mode: 0o600 });
	fs.writeFileSync(path.join(root, "L1a.md"), "# Workspace Live Default Smoke Constitution\n", { mode: 0o600 });
	fs.writeFileSync(path.join(root, "L1b", "current.md"), l1b(agentId), { mode: 0o600 });
	fs.writeFileSync(path.join(root, "section_registry.json"), JSON.stringify({
		schemaVersion: 1,
		sections: {
			Chronos: { status: "mandatory" },
			"Deep Memory": { status: "mandatory" },
			"Active Items": { status: "mandatory" },
			"Recent Context": { status: "mandatory" },
		},
		updatedAt: now,
	}, null, 2) + "\n", { mode: 0o600 });
}

const agentId = "workspace-live-default-smoke";
const model = { provider: "openai-compatible", model: "gpt-5.5", label: "GPT 5.5" };
const repoRoot = path.join(tempHome, "repo");
const workspaceA = path.join(tempHome, "workspace-a");
const workspaceB = path.join(tempHome, "workspace-b");
const runtimeCwd = path.join(tempHome, "cwd");
const storage = { persistentAgentsRoot: tempAgentsRoot };

try {
	for (const dir of [repoRoot, workspaceA, workspaceB, runtimeCwd]) fs.mkdirSync(dir, { recursive: true });
	writeFixtureAgent(agentId);
	createPersistentAgentInstance(agentId);

	const defaultA = createPersistentRoomDefaultCapabilityPolicy({
		agentId,
		repoRoot,
		root: workspaceA,
		workspaceAccessMode: "bounded",
		displayLabel: "Workspace A",
		source: "manual",
		mode: "read",
	});
	writePersistentRoomDefaultCapabilityPolicy(defaultA, storage);
	assert(fs.existsSync(persistentRoomWorkspaceDefaultPath(agentId, storage)), "room default A should be written");

	// A running conversation resolves the LIVE room default: creating the thread
	// runtime writes no mirror sidecar, and the boot snapshot carries the
	// default's facts at creation time.
	const threadA = "live_a_0001";
	const writeA = writePersistentAgentThread(agentId, threadA, {
		state: "standby",
		origin: "home",
		model,
		items: [],
	}, {
		createRuntime: ({ model }) => createPersistentAgentPiSessionJsonlThreadRuntime({ agentId, threadId: threadA, model, cwd: runtimeCwd }),
	});
	assert(writeA.thread.runtime.kind === "pi-session-jsonl", "thread A should be Pi-backed");
	const sidecarAPath = persistentRoomWorkspacePolicyPath(agentId, threadA, storage);
	assert(!fs.existsSync(sidecarAPath), "thread runtime creation must not write a room-default mirror sidecar");
	const effectiveA = resolvePersistentRoomEffectiveWorkspacePolicy(agentId, threadA, storage);
	assert(effectiveA.source === "room-default", `thread A effective source should be room-default, got ${effectiveA.source}`);
	assert(effectiveA.workspaceAccessMode === "bounded", "thread A should follow bounded room default");
	assert(effectiveA.allowedToolNames.join(",") === "ls,find,read,write_markdown_file,read_spreadsheet", "thread A should expose exact bounded workspace bundle");
	assert(effectiveA.workspaceToolsEnabled === true, "workspace tools should be enabled from the live default");
	assert(effectiveA.bashEnabled === false, "bash must remain disabled under bounded default");
	assert(persistentRoomRuntimeCwdForEffectiveWorkspacePolicy(effectiveA, runtimeCwd) === runtimeCwd, "bounded effective policy should preserve fallback runtime cwd");
	const bootPromptA = readPersistentAgentBootPromptSnapshot(agentId, writeA.thread.runtime);
	assert(bootPromptA.includes("Workspace label: Workspace A"), "boot prompt should include workspace A label");
	assert(crypto.createHash("sha256").update(bootPromptA, "utf-8").digest("hex") === writeA.thread.runtime.bootPromptSha256, "boot prompt hash should match runtime metadata");
	const sectionA = buildPersistentRoomCurrentWorkspaceSection(effectiveA);
	assert(sectionA.includes("## Current workspace") && sectionA.includes("Workspace label: Workspace A"), "live workspace stanza should carry the current label");

	// Changing the room default mid-conversation applies to the SAME thread at
	// its next resolution — tools, bash, runtime cwd and the per-turn stanza all
	// follow the new default while the frozen boot snapshot stays untouched.
	const defaultB = createPersistentRoomDefaultCapabilityPolicy({
		agentId,
		repoRoot,
		root: workspaceB,
		workspaceAccessMode: "localFiles",
		displayLabel: "Workspace B",
		source: "manual",
		mode: "read",
		toolSelection: { kind: "custom", allowedToolNames: ["read", "ls", "read_spreadsheet"] },
		bashEnabled: true,
	});
	writePersistentRoomDefaultCapabilityPolicy(defaultB, storage);
	const effectiveAfterChange = resolvePersistentRoomEffectiveWorkspacePolicy(agentId, threadA, storage);
	assert(effectiveAfterChange.source === "room-default", "mid-conversation default change should keep resolving from the room default");
	assert(effectiveAfterChange.workspaceAccessMode === "localFiles", "thread A should pick up Local files mode from the changed default");
	assert(effectiveAfterChange.allowedToolNames.join(",") === "read,ls,read_spreadsheet", "thread A should pick up the changed default's tool subset");
	assert(effectiveAfterChange.bashEnabled === true, "thread A should pick up the changed default's bash setting");
	assert(effectiveAfterChange.policy?.roots[0]?.realpath === fs.realpathSync.native(workspaceB), "thread A should pick up workspace B root");
	assert(persistentRoomRuntimeCwdForEffectiveWorkspacePolicy(effectiveAfterChange, runtimeCwd) === fs.realpathSync.native(workspaceB), "local-files effective policy should use workspace B as runtime cwd");
	assert(effectiveAfterChange.fingerprint.value !== effectiveA.fingerprint.value, "changed default must change the effective-policy fingerprint (the live-session rebind trigger)");
	const sectionB = buildPersistentRoomCurrentWorkspaceSection(effectiveAfterChange);
	assert(sectionB.includes("Workspace label: Workspace B") && sectionB.includes("Bash/shell access: enabled"), "live workspace stanza should carry the changed default's facts");
	assert(readPersistentAgentBootPromptSnapshot(agentId, writeA.thread.runtime).includes("Workspace label: Workspace A"), "frozen boot snapshot stays untouched; the live stanza is the correction channel");

	// Clearing the default applies live too: the same thread resolves to none.
	deletePersistentRoomDefaultCapabilityPolicy(agentId, storage);
	const effectiveCleared = resolvePersistentRoomEffectiveWorkspacePolicy(agentId, threadA, storage);
	assert(effectiveCleared.source === "none" && effectiveCleared.workspaceToolsEnabled === false, "cleared default should resolve to no workspace for the running thread");
	const sectionCleared = buildPersistentRoomCurrentWorkspaceSection(effectiveCleared);
	assert(sectionCleared.includes("No workspace is configured"), "live workspace stanza should state that no workspace is configured");
	writePersistentRoomDefaultCapabilityPolicy(defaultB, storage);

	// A deliberate per-conversation override (the workspace/validate flow) still
	// wins over the room default, and mirror healing must not touch it.
	const overridePolicy = createPersistentRoomCapabilityPolicy({
		agentId,
		conversationId: threadA,
		repoRoot,
		root: workspaceA,
		workspaceAccessMode: "bounded",
		displayLabel: "Override A",
		source: "manual",
		mode: "read",
	});
	writePersistentRoomCapabilityPolicy(overridePolicy, storage);
	const effectiveOverride = resolvePersistentRoomEffectiveWorkspacePolicy(agentId, threadA, storage);
	assert(effectiveOverride.source === "thread", "thread override should win over the room default");
	assert(effectiveOverride.policy?.roots[0]?.realpath === fs.realpathSync.native(workspaceA), "thread override should keep its own root");
	assert(releasePersistentRoomThreadWorkspaceMirror(agentId, threadA, storage).released === false, "a deliberate override must not be released as a mirror");
	assert(fs.existsSync(sidecarAPath), "deliberate override sidecar should survive mirror healing");
	fs.rmSync(sidecarAPath, { force: true });

	// A legacy mirror (old snapshot regime: sidecar content-identical to the
	// default) IS released, so the thread follows the live default again.
	const mirrorRaw = JSON.parse(fs.readFileSync(persistentRoomWorkspaceDefaultPath(agentId, storage), "utf-8"));
	fs.mkdirSync(path.dirname(sidecarAPath), { recursive: true, mode: 0o700 });
	fs.writeFileSync(sidecarAPath, JSON.stringify({ ...mirrorRaw, policyId: "prcp_legacy_mirror_fixture", conversationId: threadA }, null, 2) + "\n", { mode: 0o600 });
	assert(readPersistentRoomCapabilityPolicy(agentId, threadA, storage)?.policyId === "prcp_legacy_mirror_fixture", "legacy mirror fixture should read back");
	assert(releasePersistentRoomThreadWorkspaceMirror(agentId, threadA, storage).released === true, "a sidecar mirroring the current default should be released");
	assert(!fs.existsSync(sidecarAPath), "released mirror sidecar should be deleted");
	assert(resolvePersistentRoomEffectiveWorkspacePolicy(agentId, threadA, storage).source === "room-default", "after mirror release the thread follows the live default");

	// The one boundary the live model keeps: a turn in flight refuses the
	// mutation and finishes under the rules it started with.
	expectMutationRefused({ inFlight: true, cancelling: false }, /active turn in flight/, "running turn should refuse workspace-default mutation");
	expectMutationRefused({ inFlight: true, cancelling: true }, /cancelling turn in flight/, "cancelling turn should refuse workspace-default mutation");
	assertPersistentRoomWorkspaceDefaultMutable({ inFlight: false, cancelling: false });
	assertPersistentRoomWorkspaceDefaultMutable(null);

	// A thread created AFTER the change boots with the new default's facts.
	const threadB = "live_b_0001";
	const writeB = writePersistentAgentThread(agentId, threadB, {
		state: "standby",
		origin: "home",
		model,
		items: [],
	}, {
		createRuntime: ({ model }) => createPersistentAgentPiSessionJsonlThreadRuntime({ agentId, threadId: threadB, model, cwd: runtimeCwd }),
	});
	assert(writeB.thread.runtime.kind === "pi-session-jsonl", "thread B should be Pi-backed");
	assert(!fs.existsSync(persistentRoomWorkspacePolicyPath(agentId, threadB, storage)), "thread B creation must not write a mirror sidecar");
	const bootPromptB = readPersistentAgentBootPromptSnapshot(agentId, writeB.thread.runtime);
	assert(bootPromptB.includes("Workspace label: Workspace B"), "new thread boot prompt should use the current room default");
	assert(bootPromptB.includes("Workspace tools: read, ls, read_spreadsheet"), "new thread boot prompt should list the current default's tools");
	assert(bootPromptB.includes("Bash/shell access: enabled"), "new thread boot prompt should reflect the current default's bash setting");

	console.log("persistent-room workspace live-default smoke passed");
} catch (error) {
	console.error(error instanceof Error ? error.stack || error.message : error);
	console.error(`temp HOME preserved for inspection: ${tempHome}`);
	console.error(`temp agents root preserved for inspection: ${tempAgentsRoot}`);
	process.exitCode = 1;
} finally {
	if (process.exitCode == null || process.exitCode === 0) {
		fs.rmSync(tempHome, { recursive: true, force: true });
		fs.rmSync(tempAgentsRoot, { recursive: true, force: true });
	}
}
