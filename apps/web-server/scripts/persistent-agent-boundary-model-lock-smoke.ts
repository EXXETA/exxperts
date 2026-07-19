import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { PersistentAgentPiSessionJsonlThreadRuntime } from "../src/persistent-agents.js";

const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "exxperts-boundary-model-lock-home-"));
const root = path.join(tempHome, ".exxperts", "app", "personalized-agents");
const tempCwd = fs.mkdtempSync(path.join(os.tmpdir(), "exxperts-boundary-model-lock-cwd-"));
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
	beginPersistentAgentTurn,
	buildCheckpointProposal,
	createPersistentAgentFromScaffoldInput,
	createPersistentAgentInstance,
	createPersistentAgentPiSessionJsonlThreadRuntime,
	discardEmptyPreparedBoundaryThread,
	deletePersistentAgentThread,
	finishPersistentAgentTurn,
	getPersistentAgentRuntimeState,
	getPersistentAgentThread,
	markPersistentAgentTurnCancelling,
	openPersistentAgentPiSessionManager,
	parseCheckpointApprovalRequest,
	writeApprovedCheckpoint,
	writePersistentAgentMementoBoundary,
	writePersistentAgentRuntimeState,
	writePersistentAgentThread,
} = await import("../src/persistent-agents.js");

const agentId = "boundary-model-lock-smoke-room";
const modelA = { provider: "openai-compatible", model: "gpt-5.5", label: "GPT-5.5" };
const modelB = { provider: "openai-compatible", model: "claude-opus-4.6", label: "Claude Opus 4.6" };

type ThreadRecord = NonNullable<ReturnType<typeof getPersistentAgentThread>>;

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

function expectThrows(fn: () => unknown, expected: RegExp, label: string, expectedStatusCode = 409): void {
	try {
		fn();
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		const statusCode = (error as any)?.statusCode;
		assert(expected.test(message), `${label}: expected ${expected}, got ${message}`);
		assert(statusCode === expectedStatusCode || statusCode == null, `${label}: expected optional ${expectedStatusCode} status, got ${statusCode}`);
		return;
	}
	throw new Error(`${label}: expected error`);
}

function sha256(text: string): string {
	return crypto.createHash("sha256").update(text, "utf-8").digest("hex");
}

function l1bPath(): string {
	const instance = createPersistentAgentInstance(agentId);
	const meta = instance.readAgentJson();
	return instance.l1bCurrentPath(meta);
}

function readL1b(): string {
	return fs.readFileSync(l1bPath(), "utf-8");
}

function runtimeSessionRelPath(thread: ThreadRecord): string {
	assert(thread.runtime.kind === "pi-session-jsonl", `${thread.threadId} should be Pi-backed`);
	return thread.runtime.sessionFileRelPath;
}

function writePiThread(threadId: string, state: "active" | "standby", origin: "launcher" | "home" | "checkpoint" | "memento" | "unknown", model = modelA, items: unknown[] = []) {
	return writePersistentAgentThread(agentId, threadId, { state, origin, model, items }, {
		createRuntime: ({ model }) => createPersistentAgentPiSessionJsonlThreadRuntime({ agentId, threadId, model, cwd: tempCwd }),
	});
}

function approvedRecentContext(title: string): string {
	return `### RC-DRAFT | CLOSED | 2026-06-27 | ${title}\n\n**Session arc:** Synthetic boundary model-lock smoke crossed a checkpoint boundary.\n\n**Body:**\n- Boundary model-lock regression smoke validated no-turn Home retirement.\n\n**Parked:**\nNone\n`;
}

try {
	createPersistentAgentFromScaffoldInput({
		displayName: "Boundary Model Lock Smoke Room",
		userName: "Synthetic User",
		preferredUserAddress: "Synthetic User",
	});
	const instance = createPersistentAgentInstance(agentId);

	// A. Message-bearing standby remains locked and cannot be rewritten to another model.
	const standbyThreadId = "standby_locked_a";
	const standbyWrite = writePiThread(standbyThreadId, "standby", "home", modelA, [{ kind: "user", id: "standby-user", text: "Synthetic standby turn." }]);
	const standbySessionPath = runtimeSessionRelPath(standbyWrite.thread);
	assert(standbyWrite.runtime.state === "standby", "message-bearing fixture should be standby");
	expectThrows(
		() => writePersistentAgentThread(agentId, standbyThreadId, { state: "standby", origin: "home", model: modelB, items: standbyWrite.thread.items }),
		/model lock is immutable|fresh runtime boundary/i,
		"message-bearing standby model rewrite should reject",
	);
	const standbyAfter = getPersistentAgentThread(agentId, standbyThreadId);
	assert(standbyAfter?.model.model === modelA.model, "message-bearing standby should keep model A after rejected rewrite");
	assert(runtimeSessionRelPath(standbyAfter) === standbySessionPath, "message-bearing standby runtime sidecar should not change after rejected rewrite");
	assert(getPersistentAgentRuntimeState(agentId).activeThreadId === standbyThreadId, "message-bearing standby activeThread should remain locked");

	// B. Memento empty-boundary no-turn Home retirement returns the room to idle; next Enter uses selected model B.
	const mementoOldThreadId = "mem_boundary_old_a";
	const mementoOldWrite = writePiThread(mementoOldThreadId, "active", "home", modelA, [{ kind: "user", id: "mem-user", text: "Synthetic Memento source turn." }]);
	const mementoOldSessionPath = runtimeSessionRelPath(mementoOldWrite.thread);
	const l1bBeforeMemento = readL1b();
	const memento = writePersistentAgentMementoBoundary(agentId, mementoOldThreadId, new Date("2026-06-27T10:00:00.000Z"), { runtimeCwd: tempCwd });
	const postMementoThread = getPersistentAgentThread(agentId, memento.postMemento.activeThreadId);
	assert(postMementoThread?.threadId.startsWith("postmem_"), "Memento should create postmem_ thread");
	assert(postMementoThread!.origin === "memento", "Memento fresh thread should start with memento origin");
	const postMementoSessionPath = runtimeSessionRelPath(postMementoThread!);
	writePersistentAgentThread(agentId, postMementoThread!.threadId, { state: "active", origin: "unknown", model: modelA, items: [] });
	const l1bBeforeMementoRetirementHash = sha256(readL1b());
	const mementoRetirement = discardEmptyPreparedBoundaryThread(agentId, postMementoThread!.threadId);
	assert(mementoRetirement.boundary === "memento", "origin-clobbered postmem_ should retire as Memento boundary");
	assert(mementoRetirement.runtime.state === "idle", "Memento empty-boundary retirement should set runtime idle");
	assert(mementoRetirement.runtime.activeThreadId === null, "Memento empty-boundary retirement should clear activeThreadId");
	assert(getPersistentAgentThread(agentId, postMementoThread!.threadId) === null, "Memento empty-boundary thread should be deleted/retired");
	assert(sha256(readL1b()) === l1bBeforeMementoRetirementHash, "Memento empty-boundary retirement must not mutate L1b");
	assert(sha256(readL1b()) === sha256(l1bBeforeMemento), "Memento flow should not mutate L1b");
	const mementoFreshEnterId = "c_memento_model_b";
	const mementoFreshEnter = writePiThread(mementoFreshEnterId, "active", "launcher", modelB, []);
	assert(mementoFreshEnter.thread.model.model === modelB.model, "fresh Enter after Memento retirement should use selected model B");
	assert(runtimeSessionRelPath(mementoFreshEnter.thread) !== postMementoSessionPath, "fresh Enter after Memento retirement should not reuse postmem_ session path");
	const mementoOldAfter = getPersistentAgentThread(agentId, mementoOldThreadId);
	assert(mementoOldAfter?.state === "closed", "old Memento source thread should remain closed");
	assert(mementoOldAfter.model.model === modelA.model, "old Memento source model lock should not mutate");
	assert(runtimeSessionRelPath(mementoOldAfter) === mementoOldSessionPath, "old Memento source runtime should not mutate");

	// C. Checkpoint empty-boundary retirement is equivalent and retirement itself does not mutate L1b.
	const checkpointOldThreadId = "cp_boundary_old_a";
	const checkpointOldWrite = writePiThread(checkpointOldThreadId, "active", "home", modelA, [{ kind: "user", id: "cp-display", text: "Synthetic checkpoint source turn." }]);
	const checkpointOldSessionPath = runtimeSessionRelPath(checkpointOldWrite.thread);
	const checkpointSession = openPersistentAgentPiSessionManager(agentId, checkpointOldWrite.thread.runtime as PersistentAgentPiSessionJsonlThreadRuntime, tempCwd);
	checkpointSession.appendMessage({ role: "user", content: "Synthetic checkpointable source turn.", timestamp: Date.now() });
	const proposal = await buildCheckpointProposal({
		agentId,
		conversationId: checkpointOldThreadId,
		model: modelA,
		density: "standard",
		items: [{ kind: "user", text: "Synthetic checkpoint source turn." }],
		runtimeCwd: tempCwd,
	}, async () => ({
		text: "TITLE:\nBoundary model lock checkpoint\n\nSESSION_ARC:\nSynthetic checkpoint boundary smoke.\n\nBODY:\n- Validated empty boundary retirement.\n\nPARKED:\nNone\n",
		usage: { input: 1, output: 1, totalTokens: 2, cost: 0 },
	}));
	const parsed = parseCheckpointApprovalRequest({
		conversationId: checkpointOldThreadId,
		model: modelA,
		density: proposal.density,
		proposal,
		approvedRecentContext: approvedRecentContext("Boundary model lock checkpoint"),
	}, agentId);
	const checkpoint = writeApprovedCheckpoint(parsed.request, parsed.warnings, new Date("2026-06-27T10:05:00.000Z"), { runtimeCwd: tempCwd });
	const postCheckpointThread = getPersistentAgentThread(agentId, checkpoint.postCheckpoint.activeThreadId);
	assert(postCheckpointThread?.threadId.startsWith("postcp_"), "checkpoint should create postcp_ thread");
	assert(postCheckpointThread!.origin === "checkpoint", "checkpoint fresh thread should start with checkpoint origin");
	assert(postCheckpointThread!.items.length === 0, "checkpoint fresh thread should have no user-visible turns before retirement");
	assert(getPersistentAgentRuntimeState(agentId).activeThreadId === postCheckpointThread!.threadId, "checkpoint fresh thread should be the active runtime before retirement");
	const postCheckpointSessionPath = runtimeSessionRelPath(postCheckpointThread!);
	const l1bBeforeCheckpointRetirementHash = sha256(readL1b());
	const checkpointRetirement = discardEmptyPreparedBoundaryThread(agentId, postCheckpointThread!.threadId);
	assert(checkpointRetirement.boundary === "checkpoint", "origin-preserved postcp_ should retire as checkpoint boundary");
	assert(checkpointRetirement.runtime.state === "idle", "checkpoint empty-boundary retirement should set runtime idle");
	assert(checkpointRetirement.runtime.activeThreadId === null, "checkpoint empty-boundary retirement should clear activeThreadId");
	assert(getPersistentAgentThread(agentId, postCheckpointThread!.threadId) === null, "checkpoint empty-boundary thread should be deleted/retired");
	assert(sha256(readL1b()) === l1bBeforeCheckpointRetirementHash, "checkpoint empty-boundary retirement must not mutate L1b further");
	const checkpointFreshEnterId = "c_checkpoint_model_b";
	const checkpointFreshEnter = writePiThread(checkpointFreshEnterId, "active", "launcher", modelB, []);
	assert(checkpointFreshEnter.thread.model.model === modelB.model, "fresh Enter after checkpoint retirement should use selected model B");
	assert(runtimeSessionRelPath(checkpointFreshEnter.thread) !== postCheckpointSessionPath, "fresh Enter after checkpoint retirement should not reuse postcp_ session path");
	const checkpointOldAfter = getPersistentAgentThread(agentId, checkpointOldThreadId);
	assert(checkpointOldAfter?.state === "closed", "old checkpoint source thread should remain closed");
	assert(checkpointOldAfter.model.model === modelA.model, "old checkpoint source model lock should not mutate");
	assert(runtimeSessionRelPath(checkpointOldAfter) === checkpointOldSessionPath, "old checkpoint source runtime should not mutate");

	// Scheduled runs must land their paid answer even when the active profile loses the thread's
	// model mid-generation: the final assistant write is boundary-exempt via
	// allowInactiveProfileModel while ungated writes stay fully enforced.
	const { writePersistentAgentAiProfileState } = await import("../src/persistent-agent-ai-profile-state.js");
	const profileSwitchThreadId = "sched_profile_switch_0001";
	writePiThread(profileSwitchThreadId, "standby", "home", modelA, [{ kind: "user", id: "sched-user", text: "scheduled prompt" }]);
	const fullProfileJson = fs.readFileSync(path.join(smokeAppDir, "openai-compatible-ai-profile.json"), "utf-8");
	fs.writeFileSync(
		path.join(smokeAppDir, "openai-compatible-ai-profile.json"),
		JSON.stringify({ profileId: "openai-compatible", providerId: "openai-compatible", label: "Synthetic Gateway", roomModels: [{ modelId: "claude-opus-4.6" }], maintenanceModel: "claude-opus-4.6" }, null, 2),
	);
	writePersistentAgentAiProfileState("openai-compatible");
	const finalWriteItems = [
		{ kind: "user", id: "sched-user", text: "scheduled prompt" },
		{ kind: "assistant", id: "sched-assistant", text: "paid scheduled answer", streaming: false },
	];
	expectThrows(
		() => writePersistentAgentThread(agentId, profileSwitchThreadId, { state: "standby", origin: "home", model: modelA, items: finalWriteItems }),
		/profile|model/i,
		"ungated thread write should still hit the active-profile model gate",
	);
	const landed = writePersistentAgentThread(agentId, profileSwitchThreadId, { state: "standby", origin: "home", model: modelA, items: finalWriteItems }, { allowInactiveProfileModel: true });
	assert(landed.thread.items.some((item: any) => item.id === "sched-assistant"), "paid scheduled answer should land despite the profile switch");
	fs.writeFileSync(path.join(smokeAppDir, "openai-compatible-ai-profile.json"), fullProfileJson);
	writePersistentAgentAiProfileState("openai-compatible");

	// D. Runtime/thread consistency guard rejects runtime model B for activeThread model A.
	const runtimeGuardThreadId = "runtime_guard_a";
	writePiThread(runtimeGuardThreadId, "active", "home", modelA, [{ kind: "user", id: "runtime-guard", text: "Synthetic runtime guard turn." }]);
	expectThrows(
		() => writePersistentAgentRuntimeState(agentId, { state: "active", activeThreadId: runtimeGuardThreadId, model: modelB }),
		/runtime model .*does not match activeThread model/i,
		"runtime state model/thread model divergence should reject",
	);
	assert(getPersistentAgentRuntimeState(agentId).model?.model === modelA.model, "runtime model should remain A after rejected divergence");

	// E. In-flight guard blocks destructive/runtime-boundary direct writes.
	const running = beginPersistentAgentTurn(agentId, runtimeGuardThreadId, { turnId: "turn_boundary_lock_running", connectionId: "ws_boundary_lock" });
	expectThrows(
		() => writePersistentAgentRuntimeState(agentId, { state: "idle" }),
		/still running|cancelling|activeThread/i,
		"runtime idle direct write should reject while running",
	);
	expectThrows(
		() => deletePersistentAgentThread(agentId, runtimeGuardThreadId),
		/still running|cancelling|activeThread/i,
		"delete current activeThread should reject while running",
	);
	finishPersistentAgentTurn(agentId, runtimeGuardThreadId, { turnId: running.turnId, terminalReason: "completed" });

	const inFlightBoundaryThreadId = "postmem_inflight_unknown";
	writePiThread(inFlightBoundaryThreadId, "active", "unknown", modelA, []);
	beginPersistentAgentTurn(agentId, inFlightBoundaryThreadId, { turnId: "turn_boundary_lock_cancelling", connectionId: "ws_boundary_lock" });
	markPersistentAgentTurnCancelling(agentId, inFlightBoundaryThreadId, "cancelled");
	expectThrows(
		() => discardEmptyPreparedBoundaryThread(agentId, inFlightBoundaryThreadId),
		/still running|cancelling|activeThread/i,
		"empty boundary retirement should reject while cancelling",
	);
	assert(getPersistentAgentThread(agentId, inFlightBoundaryThreadId)?.state === "active", "in-flight empty boundary should remain after rejected retirement");

	fs.rmSync(tempHome, { recursive: true, force: true });
	fs.rmSync(tempCwd, { recursive: true, force: true });
	console.log("persistent agent boundary model-lock smoke passed");
} catch (error) {
	console.error(error instanceof Error ? error.stack || error.message : error);
	console.error(`temp home preserved for inspection: ${tempHome}`);
	console.error(`temp cwd preserved for inspection: ${tempCwd}`);
	process.exitCode = 1;
}
