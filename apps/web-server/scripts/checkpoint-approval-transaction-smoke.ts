import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { PersistentAgentPiSessionJsonlThreadRuntime } from "../src/persistent-agents.js";

const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "checkpoint-approval-transaction-home-"));
const root = path.join(tempHome, ".exxperts", "app", "personalized-agents");
const tempCwd = fs.mkdtempSync(path.join(os.tmpdir(), "checkpoint-approval-transaction-cwd-"));
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
	buildCheckpointProposal,
	closePersistentAgentThreadForCheckpoint,
	buildPersistentAgentBootContext,
	createPersistentAgentInstance,
	createPersistentAgentPiSessionJsonlThreadRuntime,
	fingerprintPersistentAgentBootContextL1b,
	getPersistentAgentRuntimeState,
	getPersistentAgentStatus,
	getPersistentAgentThread,
	openPersistentAgentPiSessionManager,
	parseCheckpointApprovalRequest,
	writeApprovedCheckpoint,
	writePersistentAgentThread,
} = await import("../src/persistent-agents.js");

const { writePersistentAgentAiProfileState } = await import("../src/persistent-agent-ai-profile-state.js");
writePersistentAgentAiProfileState("openai-compatible");

const agentId = "checkpoint-transaction-smoke-room";
const model = { provider: "openai-compatible", model: "gpt-5.5", label: "GPT-5.5" };
const TRANSCRIPT_SENTINEL = "CHECKPOINT_TRANSACTION_TRANSCRIPT_SENTINEL";
const APPROVED_SENTINEL = "CHECKPOINT_TRANSACTION_APPROVED_SENTINEL_SHOULD_NOT_APPEAR_IN_EVENT";

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

function approvedRecentContext(): string {
	return `### RC-DRAFT | CLOSED | 2026-06-14 | Transaction smoke\n\n**Session arc:** A synthetic Pi-backed thread crossed a checkpoint transaction boundary.\n\n**Body:**\n- ${APPROVED_SENTINEL}\n- The old runtime should be closed and a fresh Pi-backed runtime should be prepared from mutated L1b.\n\n**Parked:**\nNone\n`;
}

try {
	createPersistentAgentFromScaffoldInput({
		displayName: "Checkpoint Transaction Smoke Room",
		userName: "Synthetic User",
		preferredUserAddress: "Synthetic User",
	});
	const instance = createPersistentAgentInstance(agentId);
	const oldThreadId = "pi_txn_old_0001";
	const oldWrite = writePersistentAgentThread(agentId, oldThreadId, {
		state: "active",
		origin: "home",
		model,
		items: [{ kind: "user", id: "display", text: "DISPLAY_CACHE_SHOULD_NOT_DEFINE_TRANSACTION" }],
	}, {
		createRuntime: ({ model }) => createPersistentAgentPiSessionJsonlThreadRuntime({ agentId, threadId: oldThreadId, model, cwd: tempCwd }),
	});
	assert(oldWrite.thread.runtime.kind === "pi-session-jsonl", "old fixture thread should be Pi-backed");
	const oldJsonlPath = instance.runtimePiSessionPath(oldThreadId);
	const oldBootPath = instance.runtimeBootPromptSnapshotPath(oldThreadId);
	const oldSession = openPersistentAgentPiSessionManager(agentId, oldWrite.thread.runtime, tempCwd);
	oldSession.appendMessage({ role: "user", content: TRANSCRIPT_SENTINEL, timestamp: Date.now() });

	const proposal = await buildCheckpointProposal({
		agentId,
		conversationId: oldThreadId,
		model,
		density: "standard",
		items: [{ kind: "user", text: "DISPLAY_CACHE_SHOULD_NOT_DEFINE_TRANSACTION" }],
		runtimeCwd: tempCwd,
	}, async () => ({
		text: "TITLE:\nTransaction smoke\n\nSESSION_ARC:\nA synthetic Pi-backed thread crossed a checkpoint transaction boundary.\n\nBODY:\n- The transaction smoke validated runtime boundary metadata.\n\nPARKED:\nNone\n",
		usage: { input: 1, output: 1, totalTokens: 2, cost: 0 },
	}));
	assert(proposal.source.runtimeKind === "pi-session-jsonl", "proposal should capture Pi source metadata");

	const parsed = parseCheckpointApprovalRequest({
		conversationId: oldThreadId,
		model,
		density: proposal.density,
		proposal,
		approvedRecentContext: approvedRecentContext(),
	}, agentId);
	const result = writeApprovedCheckpoint(parsed.request, parsed.warnings, new Date("2026-06-14T13:00:00.000Z"));

	assert(result.writesMemory === true, "approval should write memory");
	assert(result.runtimeBoundary.closedThreadId === oldThreadId, "runtime boundary should identify closed old thread");
	assert(result.runtimeBoundary.closedReason === "checkpoint", "old thread close reason should be checkpoint");
	assert(result.runtimeBoundary.closedByCheckpointId === result.checkpointId, "old thread close metadata should reference checkpoint id");
	assert(result.runtimeBoundary.oldRuntime.kind === "pi-session-jsonl", "boundary should preserve old runtime metadata");
	assert(result.runtimeBoundary.newRuntime.kind === "pi-session-jsonl", "fresh runtime should be Pi-backed");
	assert(result.postCheckpoint.activeThreadId === result.runtimeBoundary.newThreadId, "postCheckpoint should point to fresh thread");

	const oldThread = getPersistentAgentThread(agentId, oldThreadId);
	assert(oldThread?.state === "closed", "old thread should be closed after approval");
	assert(oldThread.closedReason === "checkpoint", "old thread should record checkpoint close reason");
	assert(oldThread.closedByCheckpointId === result.checkpointId, "old thread should record closing checkpoint id");
	assert(fs.existsSync(oldJsonlPath), "old Pi JSONL artifact should be preserved");
	assert(fs.existsSync(oldBootPath), "old boot snapshot artifact should be preserved");

	const newThread = getPersistentAgentThread(agentId, result.runtimeBoundary.newThreadId);
	assert(newThread?.state === "standby", "fresh thread should be prepared as standby internally");
	assert(newThread.runtime.kind === "pi-session-jsonl", "fresh thread metadata should be Pi-backed");
	assert(newThread.items.length === 0, "fresh thread display cache should start empty");
	const runtime = getPersistentAgentRuntimeState(agentId);
	assert(runtime.activeThreadId === newThread.threadId, "runtime state should point at fresh thread");
	assert(runtime.state === "standby", "runtime state should be prepared standby after transaction");
	const statusAfterApproval = getPersistentAgentStatus(agentId);
	assert(statusAfterApproval.activeThread?.threadId === newThread.threadId, "status should expose fresh activeThread summary");
	assert(statusAfterApproval.activeThread.preparedByCheckpoint === true, "empty fresh checkpoint runtime should be marked prepared, not unfinished");
	assert(statusAfterApproval.activeThread.hasUserVisibleTurns === false, "empty fresh checkpoint runtime should report no user-visible turns");
	assert(statusAfterApproval.activeThread.itemCount === 0, "empty fresh checkpoint runtime should report zero display items");
	writePersistentAgentThread(agentId, newThread.threadId, {
		state: "standby",
		origin: "checkpoint",
		model,
		items: [{ kind: "user", id: "post-checkpoint-user", text: "Post-checkpoint user-visible turn." }],
	});
	const statusAfterPostCheckpointTurn = getPersistentAgentStatus(agentId);
	assert(statusAfterPostCheckpointTurn.activeThread?.threadId === newThread.threadId, "status should still expose fresh activeThread after post-checkpoint turn");
	assert(statusAfterPostCheckpointTurn.activeThread.preparedByCheckpoint === false, "post-checkpoint user turn should make runtime unfinished/resumable");
	assert(statusAfterPostCheckpointTurn.activeThread.hasUserVisibleTurns === true, "post-checkpoint user turn should be visible in status");
	assert(statusAfterPostCheckpointTurn.activeThread.itemCount === 1, "post-checkpoint user turn should update item count");

	const newJsonlPath = instance.runtimePiSessionPath(newThread.threadId);
	const newBootPath = instance.runtimeBootPromptSnapshotPath(newThread.threadId);
	assert(fs.existsSync(newJsonlPath), "fresh Pi JSONL should exist");
	assert(fs.existsSync(newBootPath), "fresh boot snapshot should exist");
	const header = fs.readFileSync(newJsonlPath, "utf-8").trim().split(/\r?\n/).map((line) => JSON.parse(line))[0];
	assert(header?.type === "session", "fresh JSONL should have session header");
	assert(header.id === newThread.runtime.sessionId, "fresh JSONL header id should match metadata");
	const newBootSnapshot = fs.readFileSync(newBootPath, "utf-8");
	assert(crypto.createHash("sha256").update(newBootSnapshot, "utf-8").digest("hex") === newThread.runtime.bootPromptSha256, "fresh boot hash should match metadata");
	const expectedBootContext = buildPersistentAgentBootContext({ agentId, conversationId: newThread.threadId, sessionId: null, model });
	assert(fingerprintPersistentAgentBootContextL1b(expectedBootContext).value === newThread.runtime.l1bFingerprint.value, "fresh runtime L1b fingerprint should match mutated L1b boot context");

	assert(fs.existsSync(result.archivedL1bPath), "old L1b archive should exist");
	assert(fs.existsSync(result.eventRecordPath), "checkpoint event record should exist");
	const eventRecord = JSON.parse(fs.readFileSync(result.eventRecordPath, "utf-8"));
	assert(eventRecord.runtimeBoundary?.closedThreadId === oldThreadId, "event should include closed thread id");
	assert(eventRecord.runtimeBoundary?.newThreadId === newThread.threadId, "event should include fresh thread id");
	assert(eventRecord.runtimeBoundary?.newRuntimeSessionId === newThread.runtime.sessionId, "event should include fresh runtime session id");
	assert(eventRecord.runtimeBoundary?.newRuntimeL1bFingerprint?.value === newThread.runtime.l1bFingerprint.value, "event should include fresh runtime L1b fingerprint");
	const serializedEvent = JSON.stringify(eventRecord);
	assert(!serializedEvent.includes(TRANSCRIPT_SENTINEL), "event JSON should not contain raw transcript");
	assert(!serializedEvent.includes(APPROVED_SENTINEL), "event JSON should not contain raw approved RC body");
	assert(!serializedEvent.includes(newBootSnapshot), "event JSON should not contain raw boot prompt");

	expectThrows(
		() => writeApprovedCheckpoint(parsed.request, parsed.warnings, new Date("2026-06-14T13:01:00.000Z")),
		/current persistent-room activeThread|stale|activeThread/i,
		"double approval should fail after activeThread switches",
	);

	// Half-applied boundary self-heal: a crash after the old thread closed but before the memory
	// write / fresh thread landed used to strand the room ("stale" on every retry). Approving the
	// same proposal again must complete the boundary instead of refusing.
	createPersistentAgentFromScaffoldInput({
		displayName: "Checkpoint Halfway Smoke Room",
		userName: "Synthetic User",
		preferredUserAddress: "Synthetic User",
	});
	const healAgentId = "checkpoint-halfway-smoke-room";
	const healInstance = createPersistentAgentInstance(healAgentId);
	const healOldThreadId = "pi_txn_half_0001";
	const healWrite = writePersistentAgentThread(healAgentId, healOldThreadId, {
		state: "active",
		origin: "home",
		model,
		items: [{ kind: "user", id: "heal-display", text: "Synthetic half-applied source turn." }],
	}, {
		createRuntime: ({ model }) => createPersistentAgentPiSessionJsonlThreadRuntime({ agentId: healAgentId, threadId: healOldThreadId, model, cwd: tempCwd }),
	});
	const healSession = openPersistentAgentPiSessionManager(healAgentId, healWrite.thread.runtime as PersistentAgentPiSessionJsonlThreadRuntime, tempCwd);
	healSession.appendMessage({ role: "user", content: "Synthetic half-applied transcript turn.", timestamp: Date.now() });
	const healProposal = await buildCheckpointProposal({
		agentId: healAgentId,
		conversationId: healOldThreadId,
		model,
		density: "standard",
		items: [{ kind: "user", text: "Synthetic half-applied source turn." }],
		runtimeCwd: tempCwd,
	}, async () => ({
		text: "TITLE:\nHalf-applied smoke\n\nSESSION_ARC:\nA synthetic thread simulated a crash-interrupted checkpoint approval.\n\nBODY:\n- The retry completed the half-applied boundary.\n\nPARKED:\nNone\n",
		usage: { input: 1, output: 1, totalTokens: 2, cost: 0 },
	}));
	const healParsed = parseCheckpointApprovalRequest({
		conversationId: healOldThreadId,
		model,
		density: healProposal.density,
		proposal: healProposal,
		approvedRecentContext: approvedRecentContext(),
	}, healAgentId);
	// Simulate the crash-leftover state the old close-first ordering could produce.
	closePersistentAgentThreadForCheckpoint(healAgentId, healOldThreadId, "cp_legacy_half_0001", new Date("2026-06-14T13:02:00.000Z").getTime());
	const healL1bPath = healInstance.l1bCurrentPath(healInstance.readAgentJson());
	const healL1bBefore = fs.readFileSync(healL1bPath, "utf-8");
	const healed = writeApprovedCheckpoint(healParsed.request, healParsed.warnings, new Date("2026-06-14T13:03:00.000Z"));
	assert(healed.runtimeBoundary.closedThreadId === healOldThreadId, "self-heal should reuse the already-closed old thread");
	assert(healed.runtimeBoundary.closedByCheckpointId === "cp_legacy_half_0001", "self-heal should preserve the original closing checkpoint id");
	assert(getPersistentAgentRuntimeState(healAgentId).activeThreadId === healed.postCheckpoint.activeThreadId, "self-heal should point the runtime at the fresh thread");
	const healL1bAfter = fs.readFileSync(healL1bPath, "utf-8");
	assert(healL1bAfter !== healL1bBefore && healL1bAfter.includes(healed.checkpointId), "self-heal should land the approved memory in L1b");

	fs.rmSync(tempHome, { recursive: true, force: true });
	fs.rmSync(tempCwd, { recursive: true, force: true });
	console.log("checkpoint approval transaction smoke passed");
} catch (error) {
	console.error(error instanceof Error ? error.stack || error.message : error);
	console.error(`temp home preserved for inspection: ${tempHome}`);
	console.error(`temp cwd preserved for inspection: ${tempCwd}`);
	process.exitCode = 1;
}
