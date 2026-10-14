import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "memento-runtime-boundary-home-"));
const root = path.join(tempHome, ".exxperts", "app", "personalized-agents");
const tempCwd = fs.mkdtempSync(path.join(os.tmpdir(), "memento-runtime-boundary-cwd-"));
process.env.HOME = tempHome;
process.env.USERPROFILE = tempHome;
const smokeAppDir = path.join(tempHome, ".exxperts", "app");
fs.mkdirSync(smokeAppDir, { recursive: true });
fs.writeFileSync(
	path.join(smokeAppDir, "openai-compatible-ai-profile.json"),
	JSON.stringify({ profileId: "openai-compatible", providerId: "openai-compatible", label: "Synthetic Gateway", roomModels: [{ modelId: "gpt-5.5" }, { modelId: "claude-opus-4.6" }], maintenanceModel: "claude-opus-4.6" }, null, 2),
);
fs.writeFileSync(path.join(smokeAppDir, "persistent-agent-ai-profile.json"), JSON.stringify({ profileId: "openai-compatible" }, null, 2));
process.env.EXXPERTS_CODING_AGENT_DIR = path.join(tempHome, ".exxperts", "agent");
process.env.EXXETA_PERSISTENT_AGENTS_ROOT = root;

const {
	createPersistentAgentFromScaffoldInput,
	createPersistentAgentInstance,
	createPersistentAgentPiSessionJsonlThreadRuntime,
	getPersistentAgentRuntimeState,
	getPersistentAgentStatus,
	getPersistentAgentThread,
	openPersistentAgentPiSessionManager,
	writePersistentAgentMementoBoundary,
	writePersistentAgentThread,
} = await import("../src/persistent-agents.js");

const { writePersistentAgentAiProfileState } = await import("../src/persistent-agent-ai-profile-state.js");
writePersistentAgentAiProfileState("openai-compatible");

const agentId = "memento-smoke-room";
const model = { provider: "openai-compatible", model: "gpt-5.5", label: "GPT-5.5" };
const DISPLAY_SENTINEL = "MEMENTO_OLD_DISPLAY_SENTINEL_SHOULD_NOT_COPY";
const JSONL_SENTINEL = "MEMENTO_OLD_JSONL_SENTINEL_SHOULD_NOT_COPY";
const L1B_SENTINEL = "MEMENTO_L1B_SENTINEL_HASH_ONLY_NOT_RAW";
const SECRET_SENTINEL = "sk-memento-secret-sentinel-not-for-event";

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
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

function sha256(text: string): string {
	return crypto.createHash("sha256").update(text, "utf-8").digest("hex");
}

function parseJsonl(file: string): any[] {
	return fs.readFileSync(file, "utf-8").trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
}

function assertFreshRuntimeMaterialized(thread: NonNullable<ReturnType<typeof getPersistentAgentThread>>, label: string): void {
	assert(thread.runtime.kind === "pi-session-jsonl", `${label}: fresh runtime should be Pi-backed`);
	const instance = createPersistentAgentInstance(thread.agentId);
	const jsonlPath = instance.runtimePiSessionPath(thread.threadId);
	const bootPath = instance.runtimeBootPromptSnapshotPath(thread.threadId);
	assert(fs.existsSync(jsonlPath), `${label}: fresh JSONL should exist`);
	assert(fs.existsSync(bootPath), `${label}: fresh boot snapshot should exist`);
	const jsonl = parseJsonl(jsonlPath);
	assert(jsonl[0]?.type === "session", `${label}: fresh JSONL should start with session header`);
	assert(jsonl[0]?.id === thread.runtime.sessionId, `${label}: fresh JSONL header id should match metadata`);
	const freshJsonlText = fs.readFileSync(jsonlPath, "utf-8");
	assert(!freshJsonlText.includes(DISPLAY_SENTINEL), `${label}: fresh JSONL should not contain old display sentinel`);
	assert(!freshJsonlText.includes(JSONL_SENTINEL), `${label}: fresh JSONL should not contain old runtime transcript sentinel`);
	assert(!freshJsonlText.includes(SECRET_SENTINEL), `${label}: fresh JSONL should not contain secret sentinel`);
	const bootSnapshot = fs.readFileSync(bootPath, "utf-8");
	assert(sha256(bootSnapshot) === thread.runtime.bootPromptSha256, `${label}: fresh boot hash should match metadata`);
}

try {
	createPersistentAgentFromScaffoldInput({
		displayName: "Memento Smoke Room",
		userName: "Synthetic User",
		preferredUserAddress: "Synthetic User",
	});
	const instance = createPersistentAgentInstance(agentId);
	const meta = instance.readAgentJson();
	const l1bPath = instance.l1bCurrentPath(meta);
	fs.appendFileSync(l1bPath, `\n<!-- ${L1B_SENTINEL} -->\n`, { mode: 0o600 });

	const oldThreadId = "mem_pi_old_0001";
	const oldWrite = writePersistentAgentThread(agentId, oldThreadId, {
		state: "active",
		origin: "home",
		model,
		items: [
			{ kind: "user", id: "old-display", text: DISPLAY_SENTINEL },
			{ kind: "system", id: "old-secret", text: SECRET_SENTINEL },
		],
	}, {
		createRuntime: ({ model }) => createPersistentAgentPiSessionJsonlThreadRuntime({ agentId, threadId: oldThreadId, model, cwd: tempCwd }),
	});
	assert(oldWrite.thread.runtime.kind === "pi-session-jsonl", "old Pi fixture should be Pi-backed");
	const oldJsonlPath = instance.runtimePiSessionPath(oldThreadId);
	const oldBootPath = instance.runtimeBootPromptSnapshotPath(oldThreadId);
	const oldSession = openPersistentAgentPiSessionManager(agentId, oldWrite.thread.runtime, tempCwd);
	oldSession.appendMessage({ role: "user", content: JSONL_SENTINEL, timestamp: Date.now() });
	const l1bBefore = fs.readFileSync(l1bPath, "utf-8");
	const l1bHashBefore = sha256(l1bBefore);

	const result = writePersistentAgentMementoBoundary(agentId, oldThreadId, new Date("2026-06-14T15:00:00.000Z"), { runtimeCwd: tempCwd });
	assert(result.writesMemory === false, "Memento should not write memory");
	assert(result.memory.l1bMutated === false, "Memento result should mark L1b unchanged");
	assert(result.runtimeBoundary.closedThreadId === oldThreadId, "boundary should identify old thread");
	assert(result.runtimeBoundary.closedReason === "memento", "boundary close reason should be memento");
	assert(result.runtimeBoundary.closedByMementoId === result.mementoId, "boundary should reference memento id");
	assert(result.runtimeBoundary.oldRuntime.kind === "pi-session-jsonl", "boundary should retain old runtime metadata");
	assert(result.runtimeBoundary.newRuntime.kind === "pi-session-jsonl", "boundary should include fresh Pi runtime metadata");
	assert(result.postMemento.activeThreadId === result.runtimeBoundary.newThreadId, "postMemento should point to fresh thread");

	const oldThread = getPersistentAgentThread(agentId, oldThreadId);
	assert(oldThread?.state === "closed", "old Pi thread should be closed");
	assert(oldThread.closedReason === "memento", "old Pi thread should record Memento close reason");
	assert(oldThread.closedByMementoId === result.mementoId, "old Pi thread should record closing Memento id");
	assert(fs.existsSync(instance.runtimeThreadPath(oldThreadId)) && oldThread.items.length === 0, "old Pi thread JSON should remain as a closed record with no words");
	assert(!fs.existsSync(oldJsonlPath), "Forget deletes the old Pi JSONL transcript");
	assert(!fs.existsSync(oldBootPath), "Forget deletes the old boot artifact");

	const freshThread = getPersistentAgentThread(agentId, result.postMemento.activeThreadId);
	assert(freshThread?.state === "standby", "fresh Memento thread should be standby");
	assert(freshThread.origin === "memento", "fresh Memento thread origin should be memento");
	assert(freshThread.items.length === 0, "fresh Memento display cache should be empty");
	assertFreshRuntimeMaterialized(freshThread, "Pi-backed Memento");
	const runtime = getPersistentAgentRuntimeState(agentId);
	assert(runtime.state === "standby", "runtime state should be standby after Memento");
	assert(runtime.activeThreadId === freshThread.threadId, "runtime state should point at fresh Memento thread");
	const statusAfterMemento = getPersistentAgentStatus(agentId);
	assert(statusAfterMemento.activeThread?.threadId === freshThread.threadId, "status should expose fresh Memento activeThread");
	assert(statusAfterMemento.activeThread.preparedByBoundary === "memento", "empty fresh Memento runtime should be prepared/READY");
	assert(statusAfterMemento.activeThread.preparedByCheckpoint === false, "fresh Memento runtime should not be checkpoint-prepared");
	assert(statusAfterMemento.activeThread.hasUserVisibleTurns === false, "empty fresh Memento runtime should have no user-visible turns");

	writePersistentAgentThread(agentId, freshThread.threadId, {
		state: "standby",
		origin: "memento",
		model,
		items: [{ kind: "user", id: "post-memento", text: "Post-Memento user-visible turn." }],
	});
	const statusAfterPostMementoTurn = getPersistentAgentStatus(agentId);
	assert(statusAfterPostMementoTurn.activeThread?.threadId === freshThread.threadId, "status should still expose fresh Memento thread after user turn");
	assert(statusAfterPostMementoTurn.activeThread.preparedByBoundary === null, "post-Memento user turn should clear prepared boundary flag");
	assert(statusAfterPostMementoTurn.activeThread.hasUserVisibleTurns === true, "post-Memento user turn should make thread resumable/standby-like");

	const l1bAfter = fs.readFileSync(l1bPath, "utf-8");
	assert(sha256(l1bAfter) === l1bHashBefore, "Memento should not mutate L1b");
	assert(result.runtimeBoundary.newRuntime.l1bFingerprint.value === result.memory.l1bFingerprint.value, "fresh runtime L1b fingerprint should match Memento memory fingerprint");

	assert(fs.existsSync(result.eventRecordPath), "Memento event record should exist");
	const eventRecord = JSON.parse(fs.readFileSync(result.eventRecordPath, "utf-8"));
	assert(eventRecord.operation === "memento", "event operation should be memento");
	assert(eventRecord.mutation?.target === "none", "event should be runtime-boundary only");
	assert(eventRecord.memory?.l1bMutated === false, "event should mark L1b unchanged");
	assert(eventRecord.runtimeBoundary?.closedThreadId === oldThreadId, "event should identify closed old thread");
	assert(eventRecord.runtimeBoundary?.newThreadId === freshThread.threadId, "event should identify fresh thread");
	const serializedEvent = JSON.stringify(eventRecord);
	const serializedResult = JSON.stringify(result);
	const freshBootSnapshot = fs.readFileSync(instance.runtimeBootPromptSnapshotPath(freshThread.threadId), "utf-8");
	for (const serialized of [serializedEvent, serializedResult]) {
		assert(!serialized.includes(DISPLAY_SENTINEL), "Memento metadata should not include raw display transcript");
		assert(!serialized.includes(JSONL_SENTINEL), "Memento metadata should not include raw JSONL transcript");
		assert(!serialized.includes(SECRET_SENTINEL), "Memento metadata should not include secret sentinel");
		assert(!serialized.includes(L1B_SENTINEL), "Memento metadata should not include raw L1b content");
		assert(!serialized.includes(freshBootSnapshot), "Memento metadata should not include raw boot prompt");
	}

	expectThrows(
		() => writePersistentAgentMementoBoundary(agentId, oldThreadId, new Date("2026-06-14T15:01:00.000Z"), { runtimeCwd: tempCwd }),
		/stale|current activeThread|already closed/i,
		"double Memento against old thread should fail",
	);

	const missingSidecarThreadId = "mem_missing_old";
	const missingSidecarWrite = writePersistentAgentThread(agentId, missingSidecarThreadId, {
		state: "active",
		origin: "home",
		model,
		items: [{ kind: "user", id: "missing-sidecar", text: "old sidecar missing" }],
	}, {
		createRuntime: ({ model }) => createPersistentAgentPiSessionJsonlThreadRuntime({ agentId, threadId: missingSidecarThreadId, model, cwd: tempCwd }),
	});
	assert(missingSidecarWrite.thread.runtime.kind === "pi-session-jsonl", "missing-sidecar fixture should be Pi-backed");
	fs.rmSync(instance.runtimePiSessionPath(missingSidecarThreadId), { force: true });
	const missingSidecarResult = writePersistentAgentMementoBoundary(agentId, missingSidecarThreadId, new Date("2026-06-14T15:02:00.000Z"), { runtimeCwd: tempCwd });
	const missingOldThread = getPersistentAgentThread(agentId, missingSidecarThreadId);
	assert(missingOldThread?.state === "closed", "Memento should close old thread even if old JSONL sidecar is missing");
	const missingFreshThread = getPersistentAgentThread(agentId, missingSidecarResult.postMemento.activeThreadId);
	assert(missingFreshThread?.origin === "memento", "missing-sidecar Memento should create fresh Memento thread");
	assertFreshRuntimeMaterialized(missingFreshThread, "missing old sidecar Memento");

	const legacyThreadId = "legacy_mem_old";
	writePersistentAgentThread(agentId, legacyThreadId, {
		state: "active",
		origin: "home",
		model,
		items: [{ kind: "user", id: "legacy-display", text: DISPLAY_SENTINEL }],
	});
	const legacyBefore = getPersistentAgentThread(agentId, legacyThreadId);
	assert(legacyBefore?.runtime.kind === "transcript-recap-v1", "legacy fixture should use transcript recap runtime");
	const legacyResult = writePersistentAgentMementoBoundary(agentId, legacyThreadId, new Date("2026-06-14T15:03:00.000Z"), { runtimeCwd: tempCwd });
	const legacyClosed = getPersistentAgentThread(agentId, legacyThreadId);
	assert(legacyClosed?.state === "closed", "legacy old thread should close");
	assert(legacyClosed.closedReason === "memento", "legacy old thread should record Memento close reason");
	assert(legacyResult.runtimeBoundary.oldRuntime.kind === "transcript-recap-v1", "legacy boundary should preserve old runtime kind");
	const legacyFresh = getPersistentAgentThread(agentId, legacyResult.postMemento.activeThreadId);
	assert(legacyFresh?.origin === "memento", "legacy Memento fresh thread should have Memento origin");
	assert(legacyFresh.items.length === 0, "legacy Memento fresh thread should not copy old display cache");
	assertFreshRuntimeMaterialized(legacyFresh, "legacy Memento");
	assert(getPersistentAgentStatus(agentId).activeThread?.preparedByBoundary === "memento", "legacy Memento fresh thread should report prepared/READY");

	fs.rmSync(tempHome, { recursive: true, force: true });
	fs.rmSync(tempCwd, { recursive: true, force: true });
	console.log("memento runtime boundary smoke passed");
} catch (error) {
	console.error(error instanceof Error ? error.stack || error.message : error);
	console.error(`temp home preserved for inspection: ${tempHome}`);
	console.error(`temp cwd preserved for inspection: ${tempCwd}`);
	process.exitCode = 1;
}
