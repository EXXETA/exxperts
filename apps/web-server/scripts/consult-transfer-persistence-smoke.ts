// Server-side smoke for the Consult MR-5 pending-transfer queue persistence
// (spec §2.3). Covers: thread write/GET round-trip of `pendingHandoffs`,
// preserve-if-absent vs explicit clear, validation rejecting junk, and the two
// boundary behaviours — the checkpoint boundary CARRIES the queue onto the fresh
// thread (client re-queue, since the checkpoint memory-write path itself is
// off-limits and creates the fresh thread empty), while the Memento boundary
// does NOT. Builds on checkpoint-approval-transaction-smoke / memento-runtime-
// boundary-smoke to drive the real boundaries.
//
// Run: npm run smokes -- consult-transfer-persistence   (or tsx this file)

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { PersistentAgentPiSessionJsonlThreadRuntime, PersistentAgentThreadWriteOptions } from "../src/persistent-agents.js";

const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "consult-transfer-persistence-home-"));
const root = path.join(tempHome, ".exxperts", "app", "personalized-agents");
const tempCwd = fs.mkdtempSync(path.join(os.tmpdir(), "consult-transfer-persistence-cwd-"));
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
	clearPersistentAgentThreadPendingHandoffs,
	createPersistentAgentInstance,
	createPersistentAgentPiSessionJsonlThreadRuntime,
	getPersistentAgentThread,
	openPersistentAgentPiSessionManager,
	parseCheckpointApprovalRequest,
	writeApprovedCheckpoint,
	writePersistentAgentMementoBoundary,
	writePersistentAgentThread,
} = await import("../src/persistent-agents.js");

const { CONSULT_HANDOFF_BLOCK_MAX_CHARS, CONSULT_HANDOFF_MAX_PENDING, buildConsultHandoffBlock } = await import("../src/consult-handoff.js");
const { writePersistentAgentAiProfileState } = await import("../src/persistent-agent-ai-profile-state.js");
writePersistentAgentAiProfileState("openai-compatible");

const model = { provider: "openai-compatible", model: "gpt-5.5", label: "GPT-5.5" };

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

function block(slug: string, answer: string): string {
	return buildConsultHandoffBlock({
		slug, displayName: slug, agentId: slug, requestedAt: "2026-07-10T14:32:00.000Z",
		question: "What did we decide?", fingerprint: { algorithm: "sha256", value: "deadbeefcafe" }, answerMarkdown: answer,
	});
}

function approvedRecentContext(): string {
	return "### RC-DRAFT | CLOSED | 2026-06-14 | Consult transfer smoke\n\n**Session arc:** A synthetic thread carried a pending consult across a checkpoint.\n\n**Body:**\n- The pending-transfer queue must ride onto the fresh thread.\n\n**Parked:**\nNone\n";
}

try {
	createPersistentAgentFromScaffoldInput({
		displayName: "Consult Transfer Smoke Room",
		userName: "Synthetic User",
		preferredUserAddress: "Synthetic User",
	});
	const agentId = "consult-transfer-smoke-room";
	const instance = createPersistentAgentInstance(agentId);

	// ---- round-trip + preserve-if-absent + clear ---------------------------
	const rtThreadId = "pi_rt_0001";
	const q1 = block("euler", "Flat annual license plus per-seat add-on.");
	const q2 = block("eugene", "Two-week notice period, standard.");
	const rtWrite = writePersistentAgentThread(agentId, rtThreadId, {
		state: "active",
		origin: "home",
		model,
		items: [{ kind: "user", id: "u1", text: "hello" }],
		pendingHandoffs: [q1, q2],
	}, {
		createRuntime: ({ model }) => createPersistentAgentPiSessionJsonlThreadRuntime({ agentId, threadId: rtThreadId, model, cwd: tempCwd }),
	});
	assert(JSON.stringify(rtWrite.thread.pendingHandoffs) === JSON.stringify([q1, q2]), "write returns the stored queue");
	const rtGet = getPersistentAgentThread(agentId, rtThreadId);
	assert(JSON.stringify(rtGet?.pendingHandoffs) === JSON.stringify([q1, q2]), "GET round-trips the pending queue");

	// preserve-if-absent: an unrelated save (no pendingHandoffs) keeps the queue
	writePersistentAgentThread(agentId, rtThreadId, { state: "active", model, items: [{ kind: "user", id: "u1", text: "hello" }, { kind: "user", id: "u2", text: "more" }] });
	const rtPreserved = getPersistentAgentThread(agentId, rtThreadId);
	assert(JSON.stringify(rtPreserved?.pendingHandoffs) === JSON.stringify([q1, q2]), "omitted pendingHandoffs preserves the stored queue");
	assert((rtPreserved?.items.length ?? 0) === 2, "the unrelated save still updated the items");

	// explicit clear: [] wipes the stored queue and omits the field
	writePersistentAgentThread(agentId, rtThreadId, { state: "active", model, items: rtPreserved!.items as unknown[], pendingHandoffs: [] });
	const rtCleared = getPersistentAgentThread(agentId, rtThreadId);
	assert(rtCleared?.pendingHandoffs === undefined, "explicit [] clears the queue (field omitted when empty)");
	const rawCleared = JSON.parse(fs.readFileSync(instance.runtimeThreadPath(rtThreadId), "utf-8"));
	assert(rawCleared.pendingHandoffs === undefined, "cleared record does not persist an empty pendingHandoffs field");

	// ---- hardening: server clears the queue on prompt consume --------------
	// The client prepends queued blocks to the prompt text, so the moment the
	// server sees a prompt the queue is consumed. clearPersistentAgentThreadPending-
	// Handoffs makes consume+clear atomic server-side (no reliance on a later
	// client PUT), closing the crash/reorder double-injection window.
	const consumeThreadId = "pi_consume_0001";
	writePersistentAgentThread(agentId, consumeThreadId, {
		state: "active", origin: "home", model,
		items: [{ kind: "user", id: "c1", text: "hi" }, { kind: "consult", id: "ci1", targetRoomId: "euler", targetDisplayName: "euler", question: "q", answer: "a", l1bFingerprint: "sha256:deadbeefcafe", consultedAt: 1, transferred: true }],
		pendingHandoffs: [q1, q2],
	}, {
		createRuntime: ({ model }) => createPersistentAgentPiSessionJsonlThreadRuntime({ agentId, threadId: consumeThreadId, model, cwd: tempCwd }),
	});
	clearPersistentAgentThreadPendingHandoffs(agentId, consumeThreadId);
	const consumed = getPersistentAgentThread(agentId, consumeThreadId);
	assert(consumed?.pendingHandoffs === undefined, "server clear-on-consume wipes the queue");
	assert((consumed?.items.length ?? 0) === 2 && (consumed?.items[1] as any)?.kind === "consult", "server clear-on-consume preserves items (incl. the consult item) verbatim");
	assert(consumed?.state === "active" && JSON.stringify(consumed?.model) === JSON.stringify(model), "server clear-on-consume preserves state and model");
	const rawConsumed = JSON.parse(fs.readFileSync(instance.runtimeThreadPath(consumeThreadId), "utf-8"));
	assert(rawConsumed.pendingHandoffs === undefined, "cleared record persists no pendingHandoffs field");
	// Idempotent + safe when already empty / thread missing.
	clearPersistentAgentThreadPendingHandoffs(agentId, consumeThreadId);
	assert(getPersistentAgentThread(agentId, consumeThreadId)?.pendingHandoffs === undefined, "second clear is a no-op");
	clearPersistentAgentThreadPendingHandoffs(agentId, "pi_does_not_exist");

	// ---- validation rejects junk -------------------------------------------
	const junkThreadId = "pi_junk_0001";
	const runtimeOpt: PersistentAgentThreadWriteOptions = { createRuntime: ({ model }) => createPersistentAgentPiSessionJsonlThreadRuntime({ agentId, threadId: junkThreadId, model, cwd: tempCwd }) };
	expectThrows(() => writePersistentAgentThread(agentId, junkThreadId, { state: "active", origin: "home", model, items: [], pendingHandoffs: "nope" as unknown as string[] }, runtimeOpt), /must be an array/i, "non-array pendingHandoffs rejected");
	expectThrows(() => writePersistentAgentThread(agentId, junkThreadId, { state: "active", origin: "home", model, items: [], pendingHandoffs: [q1, 7 as unknown as string] }, runtimeOpt), /must be a string/i, "non-string entry rejected");
	expectThrows(() => writePersistentAgentThread(agentId, junkThreadId, { state: "active", origin: "home", model, items: [], pendingHandoffs: new Array(CONSULT_HANDOFF_MAX_PENDING + 1).fill(q1) }, runtimeOpt), /entry cap/i, "oversize count rejected");
	expectThrows(() => writePersistentAgentThread(agentId, junkThreadId, { state: "active", origin: "home", model, items: [], pendingHandoffs: ["z".repeat(CONSULT_HANDOFF_BLOCK_MAX_CHARS + 1)] }, runtimeOpt), /character cap/i, "oversize entry rejected");
	assert(getPersistentAgentThread(agentId, junkThreadId) === null, "a rejected write leaves no thread behind");

	// ---- checkpoint boundary CARRIES the queue -----------------------------
	const cpOldThreadId = "pi_cp_old_0001";
	const cpWrite = writePersistentAgentThread(agentId, cpOldThreadId, {
		state: "active",
		origin: "home",
		model,
		items: [{ kind: "user", id: "cp-src", text: "Source turn for the checkpoint." }],
		pendingHandoffs: [q1, q2],
	}, {
		createRuntime: ({ model }) => createPersistentAgentPiSessionJsonlThreadRuntime({ agentId, threadId: cpOldThreadId, model, cwd: tempCwd }),
	});
	openPersistentAgentPiSessionManager(agentId, cpWrite.thread.runtime as PersistentAgentPiSessionJsonlThreadRuntime, tempCwd).appendMessage({ role: "user", content: "Source turn for the checkpoint.", timestamp: Date.now() });
	const cpProposal = await buildCheckpointProposal({
		agentId,
		conversationId: cpOldThreadId,
		model,
		density: "standard",
		items: [{ kind: "user", text: "Source turn for the checkpoint." }],
		runtimeCwd: tempCwd,
	}, async () => ({ text: "TITLE:\nConsult transfer smoke\n\nSESSION_ARC:\nA synthetic thread carried a pending consult across a checkpoint.\n\nBODY:\n- The pending queue must survive onto the fresh thread.\n\nPARKED:\nNone\n", usage: { input: 1, output: 1, totalTokens: 2, cost: 0 } }));
	const cpParsed = parseCheckpointApprovalRequest({ conversationId: cpOldThreadId, model, density: cpProposal.density, proposal: cpProposal, approvedRecentContext: approvedRecentContext() }, agentId);
	const cpResult = writeApprovedCheckpoint(cpParsed.request, cpParsed.warnings, new Date("2026-06-14T13:00:00.000Z"));
	const cpFreshId = cpResult.postCheckpoint.activeThreadId;
	// The server-created fresh thread starts empty (the checkpoint write path never
	// copies the queue); the closed old thread still holds it — nothing was lost.
	const cpFreshRaw = getPersistentAgentThread(agentId, cpFreshId);
	assert(cpFreshRaw?.pendingHandoffs === undefined, "server-created post-checkpoint thread starts with no queue");
	assert(JSON.stringify(getPersistentAgentThread(agentId, cpOldThreadId)?.pendingHandoffs) === JSON.stringify([q1, q2]), "closed old thread retains its queue (not lost by the boundary)");
	// The client carry (bindToApprovedCheckpointRuntime): first save of the fresh
	// thread re-queues the pending blocks onto it.
	writePersistentAgentThread(agentId, cpFreshId, { state: "active", origin: "checkpoint", model, items: [], pendingHandoffs: [q1, q2] });
	assert(JSON.stringify(getPersistentAgentThread(agentId, cpFreshId)?.pendingHandoffs) === JSON.stringify([q1, q2]), "checkpoint carry: fresh thread re-queues the pending blocks");

	// ---- Memento boundary does NOT carry -----------------------------------
	const memOldThreadId = "pi_mem_old_0001";
	const memWrite = writePersistentAgentThread(agentId, memOldThreadId, {
		state: "active",
		origin: "home",
		model,
		items: [{ kind: "user", id: "mem-src", text: "Source turn for the Memento." }],
		pendingHandoffs: [q1, q2],
	}, {
		createRuntime: ({ model }) => createPersistentAgentPiSessionJsonlThreadRuntime({ agentId, threadId: memOldThreadId, model, cwd: tempCwd }),
	});
	openPersistentAgentPiSessionManager(agentId, memWrite.thread.runtime as PersistentAgentPiSessionJsonlThreadRuntime, tempCwd).appendMessage({ role: "user", content: "Source turn for the Memento.", timestamp: Date.now() });
	const memResult = writePersistentAgentMementoBoundary(agentId, memOldThreadId, new Date("2026-06-14T15:00:00.000Z"), { runtimeCwd: tempCwd });
	const memFreshId = memResult.postMemento.activeThreadId;
	const memFresh = getPersistentAgentThread(agentId, memFreshId);
	assert(memFresh?.pendingHandoffs === undefined, "post-Memento fresh thread has no queue");
	// The client (bindToMementoRuntime) saves the fresh thread WITHOUT the queue —
	// Memento forgets the conversation, so the transfer does not survive.
	writePersistentAgentThread(agentId, memFreshId, { state: "active", origin: "memento", model, items: [], pendingHandoffs: [] });
	assert(getPersistentAgentThread(agentId, memFreshId)?.pendingHandoffs === undefined, "Memento clear: fresh thread stays queue-free");

	fs.rmSync(tempHome, { recursive: true, force: true });
	fs.rmSync(tempCwd, { recursive: true, force: true });
	console.log("consult transfer persistence smoke passed");
} catch (error) {
	console.error(error instanceof Error ? error.stack || error.message : error);
	console.error(`temp home preserved for inspection: ${tempHome}`);
	console.error(`temp cwd preserved for inspection: ${tempCwd}`);
	process.exitCode = 1;
}
