import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "exxeta-agent-instance-home-"));
const tempAgentsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "exxeta-agent-instance-root-"));
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
	createPersistentAgentFromScaffoldInput,
	buildPersistentAgentBootContext,
	assertPersistentAgentBootPromptFitsWindow,
	createPersistentAgentInstance,
	createPersistentAgentPiSessionJsonlThreadRuntime,
	getPersistentAgentRuntimeState,
	getPersistentAgentStatus,
	getPersistentAgentThread,
	listPersistentAgents,
	openPersistentAgentPiSessionManager,
	readPersistentAgentBootPromptSnapshot,
	writePersistentAgentThread,
} = await import("../src/persistent-agents.js");

const agentId = "instance-smoke-room";

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

function assertIncludes(haystack: string, needle: string, label: string): void {
	assert(haystack.includes(needle), `${label}: expected to include ${needle}`);
}

function readIfExists(file: string): string | null {
	return fs.existsSync(file) ? fs.readFileSync(file, "utf-8") : null;
}

function assertThrows(fn: () => unknown, expectedMessage: string, label: string): void {
	try {
		fn();
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		assert(message.includes(expectedMessage), `${label}: expected error to include ${expectedMessage}, got ${message}`);
		return;
	}
	throw new Error(`${label}: expected error`);
}

const alphaAgentId = "agent-smoke-alpha";
const controlRoot = path.join(tempAgentsRoot, agentId);
const alphaRoot = path.join(tempAgentsRoot, alphaAgentId);

function l1b(agentId: string, sentinel: string): string {
	return `<!-- exxeta:l1b schema_version=1 -->\n\n## Chronos\n\n- Persistent agent id: ${agentId}\n- Last checkpoint: none\n\n## Deep Memory\n\n${sentinel} deep memory.\n\n## Active Items\n\n${sentinel} active item.\n\n## Recent Context\n\nNo checkpointed sessions yet.\n`;
}

function writeFixtureAgent(root: string, agentId: string, displayName: string, sentinel: string): void {
	fs.mkdirSync(path.join(root, "L1b", "archive"), { recursive: true, mode: 0o700 });
	fs.mkdirSync(path.join(root, "events", "checkpoint"), { recursive: true, mode: 0o700 });
	fs.mkdirSync(path.join(root, "events", "absorb"), { recursive: true, mode: 0o700 });
	fs.mkdirSync(path.join(root, "events", "structural-review"), { recursive: true, mode: 0o700 });
	const now = Date.now();
	fs.writeFileSync(path.join(root, "agent.json"), JSON.stringify({
		schemaVersion: 1,
		id: agentId,
		displayName,
		description: `${displayName} fixture`,
		role: "smoke-fixture",
		// Legacy/status metadata only. Runtime/thread writes below use explicit model locks.
		model: { provider: "fixture-provider", model: "fixture-display-model" },
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
	fs.writeFileSync(path.join(root, "L1a.md"), `# ${displayName} Constitution\n\n${sentinel} L1A sentinel.\n`, { mode: 0o600 });
	fs.writeFileSync(path.join(root, "L1b", "current.md"), l1b(agentId, sentinel), { mode: 0o600 });
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

try {
	writeFixtureAgent(controlRoot, agentId, "Control Smoke Agent", "CONTROL_SENTINEL_DO_NOT_TOUCH");
	writeFixtureAgent(alphaRoot, alphaAgentId, "Alpha Smoke Agent", "ALPHA_SENTINEL");

	const controlRuntimePath = path.join(controlRoot, "runtime", "state.json");
	const controlThreadsDir = path.join(controlRoot, "runtime", "threads");
	const controlAgentBefore = readIfExists(path.join(controlRoot, "agent.json"));
	const controlL1bBefore = readIfExists(path.join(controlRoot, "L1b", "current.md"));

	const alpha = createPersistentAgentInstance(alphaAgentId);
	assert(alpha.agentId === alphaAgentId, "instance should expose validated alpha agent id");
	assert(alpha.rootDir === alphaRoot, "instance rootDir should point to alpha root");
	assert(alpha.agentJsonPath() === path.join(alphaRoot, "agent.json"), "agent.json path should be under alpha root");
	assert(alpha.l1aPath() === path.join(alphaRoot, "L1a.md"), "L1a path should be under alpha root");
	assert(alpha.l1bCurrentPath() === path.join(alphaRoot, "L1b", "current.md"), "L1b current path should be under alpha root");
	assert(alpha.l1bArchiveDir() === path.join(alphaRoot, "L1b", "archive"), "L1b archive dir should be under alpha root");
	assert(alpha.sectionRegistryPath() === path.join(alphaRoot, "section_registry.json"), "section registry path should be under alpha root");
	assert(alpha.runtimeStatePath() === path.join(alphaRoot, "runtime", "state.json"), "runtime state path should be under alpha root");
	assert(alpha.runtimeThreadPath("thread_alpha_001") === path.join(alphaRoot, "runtime", "threads", "thread_alpha_001.json"), "thread path should be under alpha root");

	assert(alpha.rootRelativePath(alpha.checkpointEventRecordPath("cp_alpha_001")) === "events/checkpoint/cp_alpha_001.json", "checkpoint event relative path should be alpha-relative");
	assert(alpha.rootRelativePath(alpha.absorbEventRecordPath("absorb_alpha_001")) === "events/absorb/absorb_alpha_001.json", "absorb event relative path should be alpha-relative");
	assert(alpha.rootRelativePath(alpha.structuralReviewEventRecordPath("structural_review_alpha_001")) === "events/structural-review/structural_review_alpha_001.json", "structural review event relative path should be alpha-relative");

	assertIncludes(alpha.readL1a(), "ALPHA_SENTINEL L1A", "alpha L1a read");
	assertIncludes(alpha.readL1b(), "ALPHA_SENTINEL deep memory", "alpha L1b read");
	assert(!alpha.readL1b().includes("CONTROL_SENTINEL_DO_NOT_TOUCH"), "alpha L1b read must not use control root");

	const status = getPersistentAgentStatus(alphaAgentId);
	assert(status.id === alphaAgentId, "status id should be alpha");
	assert(status.root === alphaRoot, "status root should be alpha root");
	assert(status.exists === true && status.status === "ready", "alpha status should be ready");
	assert(status.displayName === "Alpha Smoke Agent", "status should preserve displayName separately from agentId");
	assert(status.model && typeof status.model === "object" && (status.model as any).provider === "fixture-provider", "agent.json.model should remain status metadata");
	assert(status.runtime.agentId === alphaAgentId && status.runtime.state === "idle", "missing alpha runtime should normalize to alpha idle state");

	const boot = buildPersistentAgentBootContext({
		agentId: alphaAgentId,
		conversationId: "thread_alpha_001",
		sessionId: null,
		model: { provider: "openai-compatible", model: "gpt-5.5", label: "GPT 5.5" },
	});
	assert(boot.contract.agentId === alphaAgentId, "boot contract should preserve alpha id");
	assertIncludes(boot.systemPrompt, "ALPHA_SENTINEL L1A", "boot L1a source");
	assertIncludes(boot.systemPrompt, "ALPHA_SENTINEL deep memory", "boot L1b source");
	assert(!boot.systemPrompt.includes("CONTROL_SENTINEL_DO_NOT_TOUCH"), "boot context must not load control fixture");
	assert(boot.layers.some((layer: any) => layer.title === "Alpha Smoke Agent Constitution"), "boot layer title should use alpha displayName");

	// Deadlock guard: the boot prompt must fit the room model's usable window.
	const bootModel = { provider: "openai-compatible", model: "gpt-5.5", label: "GPT 5.5" };
	assertPersistentAgentBootPromptFitsWindow({ agentId: alphaAgentId, model: bootModel, systemPrompt: boot.systemPrompt, window: { contextWindow: 200000, maxOutputTokens: 8000 } });
	assertPersistentAgentBootPromptFitsWindow({ agentId: alphaAgentId, model: bootModel, systemPrompt: boot.systemPrompt });
	assertPersistentAgentBootPromptFitsWindow({ agentId: alphaAgentId, model: bootModel, systemPrompt: boot.systemPrompt, window: { contextWindow: Number.NaN, maxOutputTokens: Number.NaN } });
	let overflow: any = null;
	try {
		assertPersistentAgentBootPromptFitsWindow({ agentId: alphaAgentId, model: bootModel, systemPrompt: boot.systemPrompt, window: { contextWindow: 2000, maxOutputTokens: 1000 } });
	} catch (error) {
		overflow = error;
	}
	assert(overflow && overflow.code === "memory_overflow" && overflow.statusCode === 413, "an oversized boot prompt should refuse with the memory_overflow code and 413");
	assert(/do not fit the usable window of GPT 5.5/.test(overflow.message) && /choose Forget/.test(overflow.message) && /open Maintain and run (Memorize|Review)/.test(overflow.message) && /Memory is unchanged/.test(overflow.message), `overflow refusal should name the model, the reachable exit (Forget → Maintain), the layer-matched run, and that memory is untouched (got ${overflow.message})`);
	assert(overflow.bootEstimatedTokens > overflow.promptTokenBudget && overflow.promptTokenBudget === 1000, "overflow refusal should carry the real numbers (min budget floor applies)");

	const initialRuntime = getPersistentAgentRuntimeState(alphaAgentId);
	assert(initialRuntime.agentId === alphaAgentId && initialRuntime.state === "idle", "initial alpha runtime should be idle");

	const threadId = "thread_alpha_001";
	const threadModel = { provider: "openai-compatible", model: "gpt-5.5", label: "GPT 5.5" };
	const writeResult = writePersistentAgentThread(alphaAgentId, threadId, {
		state: "standby",
		origin: "launcher",
		model: threadModel,
		items: [{ kind: "user", text: "alpha user turn" }, { kind: "assistant", text: "alpha assistant turn" }],
	});
	assert(writeResult.thread.agentId === alphaAgentId, "thread write should record alpha agent id");
	assert(writeResult.thread.runtime.kind === "transcript-recap-v1", "new thread should expose transcript recap runtime continuity");
	assert(writeResult.runtime.agentId === alphaAgentId, "runtime write should record alpha agent id");
	assert(writeResult.runtime.activeThreadId === threadId, "runtime should point to alpha thread id");
	const alphaThreadPath = path.join(alphaRoot, "runtime", "threads", `${threadId}.json`);
	assert(fs.existsSync(path.join(alphaRoot, "runtime", "state.json")), "alpha runtime state file should be created");
	assert(fs.existsSync(alphaThreadPath), "alpha thread file should be created");
	assert(!fs.existsSync(controlRuntimePath), "alpha runtime write must not create control runtime state");
	assert(!fs.existsSync(controlThreadsDir), "alpha thread write must not create control threads dir");

	const runtimeAfterWrite = JSON.parse(fs.readFileSync(path.join(alphaRoot, "runtime", "state.json"), "utf-8"));
	assert(runtimeAfterWrite.agentId === alphaAgentId, "alpha runtime file should contain alpha id");
	assert(runtimeAfterWrite.model.provider === "openai-compatible", "runtime execution model should come from thread write input");
	assert(runtimeAfterWrite.model.provider !== "fixture-provider", "agent.json.model fixture metadata must not become runtime execution config");

	const threadAfterWrite = JSON.parse(fs.readFileSync(alphaThreadPath, "utf-8"));
	assert(threadAfterWrite.runtime?.kind === "transcript-recap-v1", "disk thread JSON should include transcript recap runtime continuity");

	const legacyThreadJson = { ...threadAfterWrite };
	delete legacyThreadJson.runtime;
	fs.writeFileSync(alphaThreadPath, JSON.stringify(legacyThreadJson, null, 2) + "\n", { mode: 0o600 });
	const legacyThread = getPersistentAgentThread(alphaAgentId, threadId);
	assert(legacyThread?.runtime.kind === "transcript-recap-v1", "old v1 thread without runtime should normalize to transcript recap runtime continuity");
	const statusWithActiveThread = getPersistentAgentStatus(alphaAgentId);
	assert(statusWithActiveThread.activeThread?.threadId === threadId, "status should include active thread summary thread id");
	assert(statusWithActiveThread.activeThread?.runtime.kind === "transcript-recap-v1", "status should include active thread runtime continuity");

	fs.unlinkSync(alphaThreadPath);
	const statusWithMissingActiveThread = getPersistentAgentStatus(alphaAgentId);
	assert(statusWithMissingActiveThread.activeThread === null, "status should not fail and should report null activeThread when active thread file is missing");
	const listedAlpha = listPersistentAgents().find((agent: any) => agent.id === alphaAgentId);
	assert(listedAlpha?.activeThread === null, "listing should not fail and should report null activeThread when active thread file is missing");

	const piThreadId = "thread_alpha_pi_001";
	const piWrite = writePersistentAgentThread(alphaAgentId, piThreadId, {
		state: "standby",
		origin: "launcher",
		model: threadModel,
		items: [{ kind: "user", text: "pi user turn" }],
	}, {
		createRuntime: ({ model }) => createPersistentAgentPiSessionJsonlThreadRuntime({
			agentId: alphaAgentId,
			threadId: piThreadId,
			model,
			cwd: tempAgentsRoot,
		}),
	});
	assert(piWrite.thread.runtime.kind === "pi-session-jsonl", "new web-style thread should create pi-session-jsonl runtime continuity");
	const piRuntime = piWrite.thread.runtime;
	const piSessionFile = alpha.runtimePiSessionPath(piThreadId);
	const piBootSnapshotFile = alpha.runtimeBootPromptSnapshotPath(piThreadId);
	assert(piRuntime.sessionFileRelPath === "runtime/pi-sessions/thread_alpha_pi_001.jsonl", "pi session path should be room-relative and deterministic");
	assert(piRuntime.bootPromptSnapshotRelPath === "runtime/pi-sessions/thread_alpha_pi_001.boot-prompt.txt", "boot snapshot path should be room-relative and deterministic");
	assert(fs.existsSync(piSessionFile), "pi JSONL session file should exist");
	assert(fs.existsSync(piBootSnapshotFile), "boot prompt snapshot should exist");
	const piSessionRecords = fs.readFileSync(piSessionFile, "utf-8").trim().split("\n").map((line) => JSON.parse(line));
	assert(piSessionRecords[0]?.type === "session", "pi JSONL first record should be a session header");
	assert(piSessionRecords[0]?.id === piRuntime.sessionId, "pi JSONL header session id should match runtime metadata");
	const bootSnapshot = fs.readFileSync(piBootSnapshotFile, "utf-8");
	const bootSnapshotHash = crypto.createHash("sha256").update(bootSnapshot, "utf-8").digest("hex");
	assert(bootSnapshotHash === piRuntime.bootPromptSha256, "boot prompt snapshot hash should match runtime metadata");
	assertIncludes(readPersistentAgentBootPromptSnapshot(alphaAgentId, piRuntime), "ALPHA_SENTINEL deep memory", "boot snapshot helper should read room boot prompt");
	const openedPiSession = openPersistentAgentPiSessionManager(alphaAgentId, piRuntime, tempAgentsRoot);
	assert(openedPiSession.getSessionId() === piRuntime.sessionId, "opened Pi session id should match runtime metadata");
	assert(openedPiSession.buildSessionContext().messages.length === 0, "newly persisted Pi session should have empty message context");

	const piAutosave = writePersistentAgentThread(alphaAgentId, piThreadId, {
		state: "active",
		origin: "launcher",
		model: threadModel,
		items: [{ kind: "user", text: "pi autosaved display cache" }],
	});
	assert(piAutosave.thread.runtime.kind === "pi-session-jsonl", "autosave should preserve pi-session-jsonl runtime kind");
	assert((piAutosave.thread.runtime as any).sessionId === piRuntime.sessionId, "autosave should preserve Pi session id");
	assert((piAutosave.thread.runtime as any).bootPromptSha256 === piRuntime.bootPromptSha256, "autosave should preserve boot prompt metadata");

	fs.writeFileSync(piBootSnapshotFile, `${bootSnapshot}\ncorrupt`, { mode: 0o600 });
	assertThrows(() => readPersistentAgentBootPromptSnapshot(alphaAgentId, piRuntime), "hash mismatch", "corrupt boot snapshot should fail clearly");
	fs.writeFileSync(piBootSnapshotFile, bootSnapshot, { mode: 0o600 });

	const piSessionBackup = fs.readFileSync(piSessionFile, "utf-8");
	fs.rmSync(piSessionFile, { force: true });
	assertThrows(() => openPersistentAgentPiSessionManager(alphaAgentId, piRuntime, tempAgentsRoot), "JSONL is missing", "missing Pi JSONL should fail clearly");
	fs.writeFileSync(piSessionFile, `${piSessionBackup}not json\n`, { mode: 0o600 });
	assertThrows(() => openPersistentAgentPiSessionManager(alphaAgentId, piRuntime, tempAgentsRoot), "invalid JSON", "bad Pi JSONL should fail clearly");
	fs.writeFileSync(piSessionFile, piSessionBackup, { mode: 0o600 });

	const piThreadJson = JSON.parse(fs.readFileSync(path.join(alphaRoot, "runtime", "threads", `${piThreadId}.json`), "utf-8"));
	piThreadJson.runtime = { kind: "pi-session-jsonl", sessionId: "broken" };
	fs.writeFileSync(path.join(alphaRoot, "runtime", "threads", `${piThreadId}.json`), JSON.stringify(piThreadJson, null, 2) + "\n", { mode: 0o600 });
	assertThrows(() => getPersistentAgentThread(alphaAgentId, piThreadId), "invalid persistent-agent pi-session-jsonl runtime metadata", "invalid explicit pi-session-jsonl metadata should fail clearly");
	const statusWithBrokenPiThread = getPersistentAgentStatus(alphaAgentId);
	assert(statusWithBrokenPiThread.activeThread === null, "status should stay resilient when explicit pi-session-jsonl metadata is invalid");

	assert(readIfExists(path.join(controlRoot, "agent.json")) === controlAgentBefore, "control agent.json should not be modified by alpha operations");
	assert(readIfExists(path.join(controlRoot, "L1b", "current.md")) === controlL1bBefore, "control L1b should not be modified by alpha operations");

	fs.rmSync(tempAgentsRoot, { recursive: true, force: true });
	fs.rmSync(tempHome, { recursive: true, force: true });
	console.log("persistent-agent instance smoke passed");
} catch (error) {
	console.error(error instanceof Error ? error.stack || error.message : error);
	console.error(`temp HOME preserved for inspection: ${tempHome}`);
	console.error(`temp agents root preserved for inspection: ${tempAgentsRoot}`);
	process.exitCode = 1;
}
