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
	buildPersistentAgentCheckpointTranscriptSource,
	createPersistentAgentInstance,
	createPersistentAgentPiSessionJsonlThreadRuntime,
	fingerprintL1bSource,
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

	const newBootPath = instance.runtimeBootPromptSnapshotPath(newThread.threadId);
	const newBootSnapshot = fs.readFileSync(newBootPath, "utf-8");
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

	// A second approval of a conversation that was remembered answers with the
	// save that landed (a second tab, a retry after a lost reply), and never
	// writes a second page.
	const l1bAfterFirst = fs.readFileSync(instance.l1bCurrentPath(instance.readAgentJson()), "utf-8");
	const again = writeApprovedCheckpoint(parsed.request, parsed.warnings, new Date("2026-06-14T13:01:00.000Z"));
	assert(again.checkpointId === result.checkpointId && again.postCheckpoint.activeThreadId === result.postCheckpoint.activeThreadId, "a second approval answers with the save that landed");
	assert(fs.readFileSync(instance.l1bCurrentPath(instance.readAgentJson()), "utf-8") === l1bAfterFirst, "a second approval writes nothing");

	// A conversation closed by a checkpoint that left no record (the old
	// close-first order's crash state, which no save can produce now that the
	// memory file is the commit point) is refused as stale, and nothing is written.
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
	expectThrows(
		() => writeApprovedCheckpoint(healParsed.request, healParsed.warnings, new Date("2026-06-14T13:03:00.000Z")),
		/already closed|stale/i,
		"a conversation closed by a checkpoint with no record is refused",
	);
	assert(fs.readFileSync(healL1bPath, "utf-8") === healL1bBefore, "a refused approval writes no memory");

	// Remember reads a Pi-backed conversation from its session file, never the
	// display cache, refuses a missing file or a conversation that moved on, and
	// lands on a memory changed since the proposal.
	{
		const agentId = "checkpoint-smoke-room";
		const CANONICAL_SENTINEL = "CANONICAL_JSONL_CHECKPOINT_SOURCE_SENTINEL";
		const DISPLAY_CACHE_SENTINEL = "DISPLAY_CACHE_MUST_NOT_BE_CHECKPOINT_SOURCE";
		const LEGACY_CALLER_SENTINEL = "LEGACY_CALLER_DISPLAY_ITEMS_SENTINEL";
		const LEGACY_SAVED_SENTINEL = "LEGACY_SAVED_THREAD_ITEMS_NOT_USED_WHEN_CALLER_ITEMS_EXIST";

		function proposalText(title: string): string {
			return `TITLE:\n${title}\n\nSESSION_ARC:\nA synthetic checkpoint source smoke generated a proposal from the expected transcript source.\n\nBODY:\n- The checkpoint proposal used the intended synthetic source.\n\nPARKED:\nNone\n`;
		}

		function canonicalRecentContext(title: string): string {
			return `### RC-DRAFT | CLOSED | 2026-06-14 | ${title}\n\n**Session arc:** A synthetic checkpoint source smoke generated a proposal from the expected transcript source.\n\n**Body:**\n- The checkpoint proposal used the intended synthetic source.\n\n**Parked:**\nNone\n`;
		}

		async function buildProposalAndCapturePrompt(input: any): Promise<{ proposal: any; prompt: string }> {
			let capturedPrompt = "";
			const proposal = await buildCheckpointProposal(input, async (prompt, modelLock) => {
				capturedPrompt = prompt;
				return {
					text: proposalText(`Source smoke ${modelLock.model}`),
					usage: { input: 1, output: 1, totalTokens: 2, cost: 0 },
				};
			});
			return { proposal, prompt: capturedPrompt };
		}

		async function expectRejects(fn: () => Promise<unknown>, expected: RegExp, label: string): Promise<void> {
			try {
				await fn();
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				assert(expected.test(message), `${label}: expected ${expected}, got ${message}`);
				return;
			}
			throw new Error(`${label}: expected rejection`);
		}

		function createPiThreadWithMessage(threadId: string, text: string): any {
			const write = writePersistentAgentThread(agentId, threadId, {
				state: "active",
				origin: "home",
				model,
				items: [{ kind: "user", id: "display-user", text: DISPLAY_CACHE_SENTINEL }],
			}, {
				createRuntime: ({ model }) => createPersistentAgentPiSessionJsonlThreadRuntime({ agentId, threadId, model, cwd: tempCwd }),
			});
			assert(write.thread.runtime.kind === "pi-session-jsonl", `${threadId} should be Pi-backed`);
			const session = openPersistentAgentPiSessionManager(agentId, write.thread.runtime, tempCwd);
			session.appendMessage({ role: "user", content: text, timestamp: Date.now() });
			return write.thread;
		}

		function approveProposal(proposal: any, title: string): void {
			const parsed = parseCheckpointApprovalRequest({
				conversationId: proposal.conversationId,
				model,
				density: proposal.density,
				proposal,
				approvedRecentContext: canonicalRecentContext(title),
			}, agentId);
			writeApprovedCheckpoint(parsed.request, parsed.warnings, new Date("2026-06-14T12:00:00.000Z"));
		}

		createPersistentAgentFromScaffoldInput({
			displayName: "Checkpoint Smoke Room",
			userName: "Synthetic User",
			preferredUserAddress: "Synthetic User",
		});
		const instance = createPersistentAgentInstance(agentId);

		const piThreadId = "pi_ckpt_00000001";
		const piWrite = writePersistentAgentThread(agentId, piThreadId, {
			state: "active",
			origin: "home",
			model,
			items: [{ kind: "user", id: "display-user", text: DISPLAY_CACHE_SENTINEL }],
		}, {
			createRuntime: ({ model }) => createPersistentAgentPiSessionJsonlThreadRuntime({ agentId, threadId: piThreadId, model, cwd: tempCwd }),
		});
		assert(piWrite.thread.runtime.kind === "pi-session-jsonl", "Pi fixture should be pi-session-jsonl");
		const piSession = openPersistentAgentPiSessionManager(agentId, piWrite.thread.runtime, tempCwd);
		piSession.appendMessage({ role: "user", content: CANONICAL_SENTINEL, timestamp: Date.now() });
		piSession.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: `Assistant observed ${CANONICAL_SENTINEL}.` }],
			api: "responses" as any,
			provider: model.provider as any,
			model: model.model,
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
			stopReason: "stop",
			timestamp: Date.now(),
		});

		const piSource = buildPersistentAgentCheckpointTranscriptSource({
			agentId,
			conversationId: piThreadId,
			l1b: fs.readFileSync(instance.l1bCurrentPath(instance.readAgentJson()), "utf-8"),
			legacyItems: [{ kind: "user", text: DISPLAY_CACHE_SENTINEL }],
			runtimeCwd: tempCwd,
		});
		assert(piSource.source.runtimeKind === "pi-session-jsonl", "Pi helper source should identify pi-session-jsonl");
		assert(piSource.items.some((item) => String(item.text ?? "").includes(CANONICAL_SENTINEL)), "Pi helper should include JSONL canonical sentinel");
		assert(!piSource.items.some((item) => String(item.text ?? "").includes(DISPLAY_CACHE_SENTINEL)), "Pi helper should ignore display cache sentinel");
		const sourceJson = JSON.stringify(piSource.source);
		assert(!sourceJson.includes(CANONICAL_SENTINEL), "Pi source metadata should not include raw transcript text");
		assert(!sourceJson.includes(DISPLAY_CACHE_SENTINEL), "Pi source metadata should not include display cache text");
		assert(piSource.source.transcriptFingerprint?.algorithm === "sha256", "Pi source should include transcript fingerprint");
		assert(piSource.source.bootPromptSha256 === piWrite.thread.runtime.bootPromptSha256, "Pi source should include boot hash metadata");

		const piProposal = await buildProposalAndCapturePrompt({
			agentId,
			conversationId: piThreadId,
			model,
			density: "standard",
			rememberText: "Synthetic source smoke.",
			items: [{ kind: "user", id: "display-user", text: DISPLAY_CACHE_SENTINEL }],
			runtimeCwd: tempCwd,
		});
		assert(piProposal.proposal.agentId === agentId, "Pi proposal should target agent");
		assert(piProposal.proposal.source?.runtimeKind === "pi-session-jsonl", "Pi proposal should expose safe source runtime kind");
		assert(piProposal.proposal.source?.transcriptFingerprint?.algorithm === "sha256", "Pi proposal should expose safe transcript fingerprint");
		assert(!JSON.stringify(piProposal.proposal.source).includes(CANONICAL_SENTINEL), "Pi proposal source metadata should not include raw transcript text");
		assert(piProposal.prompt.includes(CANONICAL_SENTINEL), "Pi proposal prompt should include canonical JSONL sentinel");
		assert(!piProposal.prompt.includes(DISPLAY_CACHE_SENTINEL), "Pi proposal prompt should not include misleading display-cache sentinel");

		const legacyThreadId = "legacy_ckpt_0001";
		writePersistentAgentThread(agentId, legacyThreadId, {
			state: "active",
			origin: "home",
			model,
			items: [{ kind: "user", id: "saved-user", text: LEGACY_SAVED_SENTINEL }],
		});
		const legacyProposal = await buildProposalAndCapturePrompt({
			agentId,
			conversationId: legacyThreadId,
			model,
			density: "compact",
			items: [{ kind: "user", id: "caller-user", text: LEGACY_CALLER_SENTINEL }],
		});
		assert(legacyProposal.prompt.includes(LEGACY_CALLER_SENTINEL), "Legacy proposal should use caller display items");
		assert(!legacyProposal.prompt.includes(LEGACY_SAVED_SENTINEL), "Legacy proposal should preserve caller display-item behavior when items are supplied");

		const missingBootThreadId = "pi_missing_boot1";
		const missingBootWrite = writePersistentAgentThread(agentId, missingBootThreadId, {
			state: "active",
			origin: "home",
			model,
			items: [{ kind: "user", text: DISPLAY_CACHE_SENTINEL }],
		}, {
			createRuntime: ({ model }) => createPersistentAgentPiSessionJsonlThreadRuntime({ agentId, threadId: missingBootThreadId, model, cwd: tempCwd }),
		});
		assert(missingBootWrite.thread.runtime.kind === "pi-session-jsonl", "missing boot fixture should be Pi-backed");
		fs.rmSync(instance.runtimeBootPromptSnapshotPath(missingBootThreadId), { force: true });
		await expectRejects(
			() => buildCheckpointProposal({ agentId, conversationId: missingBootThreadId, model, density: "standard", items: [{ kind: "user", text: DISPLAY_CACHE_SENTINEL }], runtimeCwd: tempCwd }, async () => ({ text: proposalText("should not run") })),
			/boot prompt snapshot is missing/i,
			"missing Pi boot sidecar should fail clearly without display fallback",
		);

		const missingJsonlThreadId = "pi_missing_jsonl";
		const missingJsonlWrite = writePersistentAgentThread(agentId, missingJsonlThreadId, {
			state: "active",
			origin: "home",
			model,
			items: [{ kind: "user", text: DISPLAY_CACHE_SENTINEL }],
		}, {
			createRuntime: ({ model }) => createPersistentAgentPiSessionJsonlThreadRuntime({ agentId, threadId: missingJsonlThreadId, model, cwd: tempCwd }),
		});
		assert(missingJsonlWrite.thread.runtime.kind === "pi-session-jsonl", "missing JSONL fixture should be Pi-backed");
		fs.rmSync(instance.runtimePiSessionPath(missingJsonlThreadId), { force: true });
		await expectRejects(
			() => buildCheckpointProposal({ agentId, conversationId: missingJsonlThreadId, model, density: "standard", items: [{ kind: "user", text: DISPLAY_CACHE_SENTINEL }], runtimeCwd: tempCwd }, async () => ({ text: proposalText("should not run") })),
			/Pi session JSONL is missing/i,
			"missing Pi JSONL should fail clearly without display fallback",
		);

		const staleActiveThreadId = "pi_stale_active";
		createPiThreadWithMessage(staleActiveThreadId, "STALE_ACTIVE_SOURCE_SENTINEL");
		const staleActiveProposal = (await buildProposalAndCapturePrompt({ agentId, conversationId: staleActiveThreadId, model, density: "standard", runtimeCwd: tempCwd })).proposal;
		writePersistentAgentThread(agentId, "other_active_001", {
			state: "active",
			origin: "home",
			model,
			items: [{ kind: "user", text: "other active thread" }],
		});
		expectThrows(
			() => approveProposal(staleActiveProposal, "Stale active thread"),
			/current persistent-room activeThread|stale|activeThread/i,
			"approval should reject when activeThread changed after proposal",
		);

		const staleTranscriptId = "pi_stale_jsonl";
		const staleTranscriptThread = createPiThreadWithMessage(staleTranscriptId, "STALE_TRANSCRIPT_INITIAL_SENTINEL");
		const staleTranscriptProposal = (await buildProposalAndCapturePrompt({ agentId, conversationId: staleTranscriptId, model, density: "standard", runtimeCwd: tempCwd })).proposal;
		const staleTranscriptSession = openPersistentAgentPiSessionManager(agentId, staleTranscriptThread.runtime, tempCwd);
		staleTranscriptSession.appendMessage({ role: "user", content: "STALE_TRANSCRIPT_ADDED_AFTER_PROPOSAL", timestamp: Date.now() });
		expectThrows(
			() => approveProposal(staleTranscriptProposal, "Stale transcript"),
			/transcript|leaf|stale/i,
			"approval should reject when Pi JSONL changes after proposal",
		);

		const staleL1bId = "pi_stale_l1b01";
		createPiThreadWithMessage(staleL1bId, "STALE_L1B_SOURCE_SENTINEL");
		const staleL1bProposal = (await buildProposalAndCapturePrompt({ agentId, conversationId: staleL1bId, model, density: "standard", runtimeCwd: tempCwd })).proposal;
		const l1bPath = instance.l1bCurrentPath(instance.readAgentJson());
		// A memory change after the proposal (a Memorize, a Review, an edit) leaves
		// the proposal valid: the page is appended to the memory as it is now, and
		// both changes are kept. What the proposal summarized is the conversation.
		fs.appendFileSync(l1bPath, "\n<!-- l1b-change-after-proposal -->\n", "utf-8");
		approveProposal(staleL1bProposal, "Memory changed after proposal");
		const landedL1b = fs.readFileSync(l1bPath, "utf-8");
		assert(landedL1b.includes("Memory changed after proposal"), "approval should land its page after the memory changed");
		assert(landedL1b.includes("<!-- l1b-change-after-proposal -->"), "approval should keep the memory change it landed on");

		assert(getPersistentAgentThread(agentId, piThreadId)?.runtime.kind === "pi-session-jsonl", "source helper should not mutate Pi thread runtime");
	}

	// The checkpoint's event record: what it counts and points at, relative paths
	// and fingerprints only, none of the words; an invalid page writes no archive
	// and no record.
	{
		const agentId = "checkpoint-event-smoke-room";
		const { CHECKPOINT_COMPRESSION_WORKER_TYPE } = await import("../src/checkpoint-compression.js");

		const agentRoot = path.join(root, agentId);
		const l1bPath = path.join(agentRoot, "L1b", "current.md");
		const archiveDir = path.join(agentRoot, "L1b", "archive");
		const checkpointEventDir = path.join(agentRoot, "events", "checkpoint");

		const APPROVED_RC_SENTINEL = "UNIQUE_APPROVED_RC_BODY_SENTINEL_MUST_NOT_APPEAR_IN_EVENT";
		const PROPOSED_RC_SENTINEL = "UNIQUE_PROPOSED_RC_BODY_SENTINEL_MUST_NOT_APPEAR_IN_EVENT";
		const TRANSCRIPT_SENTINEL = "UNIQUE_TRANSCRIPT_SENTINEL_MUST_NOT_APPEAR_IN_EVENT";
		const L1B_BODY_SENTINEL = "UNIQUE_L1B_BODY_SENTINEL_MUST_NOT_APPEAR_IN_EVENT";

		function readL1b(): string {
			return fs.readFileSync(l1bPath, "utf-8");
		}

		function archiveCount(): number {
			return fs.existsSync(archiveDir) ? fs.readdirSync(archiveDir).filter((name) => name.endsWith(".md")).length : 0;
		}

		function checkpointEventCount(): number {
			return fs.existsSync(checkpointEventDir) ? fs.readdirSync(checkpointEventDir).filter((name) => name.endsWith(".json")).length : 0;
		}

		function sourceL1b(): string {
			return `<!-- exxeta:l1b schema_version=1 -->

## Chronos

- Current scaffold timestamp: 2026-05-27T10:00:00.000Z
- Persistent agent id: checkpoint-event-smoke-room
- Lifecycle state: ready
- Last checkpoint: none
- Last consolidation: none

## Deep Memory

- ${L1B_BODY_SENTINEL}
- Synthetic user is validating checkpoint lifecycle sidecar telemetry.

## Active Items

- Keep MR6a focused on checkpoint sidecar events only.

## Recent Context

No checkpointed sessions yet.
`;
		}

		function eventRecentContext(): string {
			return `### RC-DRAFT | CLOSED | 2026-05-27 | Checkpoint event smoke

**Session arc:** A short smoke session validates checkpoint sidecar event creation.

**Body:**
- ${APPROVED_RC_SENTINEL}
- Approved checkpoint event smoke signal should be durable in L1b but redacted from event JSON.

**Parked:**
None
`;
		}

		function proposedRecentContext(): string {
			return `### RC-DRAFT | OPEN | 2026-05-27 | Proposed checkpoint event smoke

**Session arc:** Proposed checkpoint sidecar event smoke draft.

**Body:**
- ${PROPOSED_RC_SENTINEL}

**Parked:**
Continue validating MR6a checkpoint telemetry.
`;
		}

		function checkpointSource(conversationId: string) {
			writePersistentAgentThread(agentId, conversationId, {
				state: "active",
				origin: "home",
				model,
				items: [{ kind: "user", id: "u1", text: TRANSCRIPT_SENTINEL }],
			});
			return buildPersistentAgentCheckpointTranscriptSource({
				agentId: agentId,
				conversationId,
				l1b: readL1b(),
				legacyItems: [{ kind: "user", id: "u1", text: TRANSCRIPT_SENTINEL }],
			}).source;
		}

		function acceptedRequest(conversationId: string) {
			return parseCheckpointApprovalRequest({
				conversationId,
				model,
				density: "standard",
				proposal: {
					agentId: agentId,
					conversationId,
					sessionId: null,
					writesMemory: false,
					density: "standard",
					source: checkpointSource(conversationId),
					proposedRecentContext: proposedRecentContext(),
					transcriptSentinel: TRANSCRIPT_SENTINEL,
				},
				approvedRecentContext: eventRecentContext(),
			}, agentId);
		}

		function invalidRequest(conversationId: string) {
			return parseCheckpointApprovalRequest({
				conversationId,
				model,
				density: "standard",
				proposal: {
					agentId: agentId,
					conversationId,
					sessionId: null,
					writesMemory: false,
					source: checkpointSource(conversationId),
				},
				// A part marker typed after the page's own: the one-string form cannot tell the parts apart.
				approvedRecentContext: `${eventRecentContext()}\n**Parked:**\nTyped again.\n`,
			}, agentId);
		}

		function isRelativePath(value: unknown): value is string {
			return typeof value === "string" && value.length > 0 && !path.isAbsolute(value) && !value.startsWith("..");
		}

		function assertFingerprint(raw: any, label: string): void {
			assert(raw?.algorithm === "sha256", `${label} should use sha256`);
			assert(/^[a-f0-9]{64}$/i.test(String(raw?.value ?? "")), `${label} should contain a sha256 value`);
		}

		createPersistentAgentFromScaffoldInput({
			displayName: "Checkpoint Event Smoke Room",
			userName: "Synthetic User",
			preferredUserAddress: "Synthetic User",
		});
		fs.writeFileSync(l1bPath, sourceL1b(), "utf-8");
		assert(fs.existsSync(l1bPath), "scaffold should create L1b/current.md");
		assert(archiveCount() === 0, "fresh scaffold should have no archives");
		assert(checkpointEventCount() === 0, "fresh scaffold should have no checkpoint event records");

		const conversationId = "c_checkpoint_event_smoke";
		const sourceBeforeApproval = readL1b();
		const parsed = acceptedRequest(conversationId);
		const result = writeApprovedCheckpoint(parsed.request, parsed.warnings, new Date("2026-05-27T20:00:00.000Z"));
		const updatedL1b = readL1b();

		assert(result.writesMemory === true, "checkpoint approval should report memory write");
		assert(typeof result.eventRecordPath === "string" && result.eventRecordPath.length > 0, "checkpoint approval should return eventRecordPath");
		assert(result.eventRelPath === `events/checkpoint/${result.checkpointId}.json`, "checkpoint approval should return canonical relative event path");
		assert(result.eventRecordPath === path.join(checkpointEventDir, `${result.checkpointId}.json`), "checkpoint approval should return canonical event path");
		assert(fs.existsSync(result.eventRecordPath), "checkpoint event record should exist");
		assert(fs.existsSync(path.join(agentRoot, result.eventRelPath)), "checkpoint event should exist at returned relative path");
		assert(archiveCount() === 1, "checkpoint approval should archive previous L1b");
		assert(checkpointEventCount() === 1, "checkpoint approval should create one event record");
		assert(fs.readFileSync(result.archivedL1bPath, "utf-8") === sourceBeforeApproval, "archive should contain pre-checkpoint L1b");

		const eventRecord = JSON.parse(fs.readFileSync(result.eventRecordPath, "utf-8"));
		assert(eventRecord.schemaVersion === 1, "event should use schema version 1");
		assert(eventRecord.operation === "checkpoint", "event should identify checkpoint operation");
		assert(eventRecord.mutation?.target === "l1b", "event mutation should target L1b");
		assert(eventRecord.mutation?.kind === "recent_context_append", "event mutation should identify Recent Context append");
		assert(Array.isArray(eventRecord.mutation.sectionsAffected), "event should include affected sections");
		assert(eventRecord.mutation.sectionsAffected.includes("Recent Context"), "event should mark Recent Context affected");
		assert(eventRecord.mutation.sectionsAffected.includes("Chronos"), "event should mark Chronos affected");
		assert(eventRecord.mutation.sectionsPreserved.includes("Deep Memory"), "event should mark Deep Memory preserved");
		assert(eventRecord.mutation.sectionsPreserved.includes("Active Items"), "event should mark Active Items preserved");
		assert(eventRecord.agentId === agentId, "event should include agent id");
		assert(eventRecord.conversationId === conversationId, "event should include conversation id");
		assert(eventRecord.sessionId === result.sessionId, "event should match response session id");
		assert(eventRecord.checkpointId === result.checkpointId, "event should match response checkpoint id");
		assert(eventRecord.recentContextId === "RC-0001", "event should include created Recent Context id");
		assert(eventRecord.approvedAt === "2026-05-27T20:00:00.000Z", "event should include approval timestamp");

		assert(eventRecord.process?.type === CHECKPOINT_COMPRESSION_WORKER_TYPE, "event should include checkpoint worker type");
		assert(eventRecord.process?.density === "standard", "event should include checkpoint density");
		assert(eventRecord.process?.model?.provider === "openai-compatible", "event should include process model provider");
		assert(eventRecord.process?.model?.model === "gpt-5.5", "event should include process model id");

		assert(isRelativePath(eventRecord.paths?.archivedL1bRelPath), "archive path in event should be relative");
		assert(isRelativePath(eventRecord.paths?.updatedL1bRelPath), "updated L1b path in event should be relative");
		assert(isRelativePath(eventRecord.paths?.eventRelPath), "event path in event should be relative");
		assert(eventRecord.paths.archivedL1bRelPath === path.relative(agentRoot, result.archivedL1bPath).split(path.sep).join("/"), "event archive path should be agent-root relative");
		assert(eventRecord.paths.updatedL1bRelPath === "L1b/current.md", "event updated L1b path should be agent-root relative");
		assert(eventRecord.paths.eventRelPath === result.eventRelPath, "event relative path should match response relative path");

		assertFingerprint(eventRecord.source?.l1bFingerprint, "source L1b fingerprint");
		assertFingerprint(eventRecord.result?.l1bFingerprint, "result L1b fingerprint");
		assert(eventRecord.source.l1bFingerprint.value === fingerprintL1bSource(sourceBeforeApproval.trimEnd() + "\n").value, "event should capture source L1b fingerprint");
		assert(eventRecord.result.l1bFingerprint.value === fingerprintL1bSource(updatedL1b.trimEnd() + "\n").value, "event should capture result L1b fingerprint");
		assert(eventRecord.source.bytes === Buffer.byteLength(sourceBeforeApproval.trimEnd() + "\n", "utf-8"), "event should capture source bytes");
		assert(eventRecord.result.bytes === Buffer.byteLength(updatedL1b.trimEnd() + "\n", "utf-8"), "event should capture result bytes");
		assert(eventRecord.source.estimatedTokens > 0, "event should capture source token estimate");
		assert(eventRecord.result.estimatedTokens > 0, "event should capture result token estimate");
		assert(eventRecord.source.recentContextEntryCount === 0, "event should capture source RC count");
		assert(eventRecord.result.recentContextEntryCount === 1, "event should capture result RC count");
		assert(eventRecord.source.sections?.recentContext?.entryCount === 0, "event should capture source RC section count");
		assert(eventRecord.result.sections?.recentContext?.entryCount === 1, "event should capture result RC section count");
		const sourceSectionTitles = eventRecord.source.sections.topLevel.map((section: { title: string }) => section.title);
		const resultSectionTitles = eventRecord.result.sections.topLevel.map((section: { title: string }) => section.title);
		assert(["Chronos", "Deep Memory", "Active Items", "Recent Context"].every((title) => sourceSectionTitles.includes(title)), "event should capture source top-level section metrics");
		assert(["Chronos", "Deep Memory", "Active Items", "Recent Context"].every((title) => resultSectionTitles.includes(title)), "event should capture result top-level section metrics");

		assert(eventRecord.checkpoint?.recentContextEntryCountBefore === 0, "event should capture checkpoint RC count before");
		assert(eventRecord.checkpoint?.recentContextEntryCountAfter === 1, "event should capture checkpoint RC count after");
		assert(eventRecord.checkpoint?.approvedEntry?.chars > 0, "event should capture approved entry chars");
		assert(eventRecord.checkpoint.approvedEntry.bytes > 0, "event should capture approved entry bytes");
		assert(eventRecord.checkpoint.approvedEntry.estimatedTokens > 0, "event should capture approved entry tokens");
		assert(eventRecord.checkpoint.approvedEntry.status === "CLOSED", "event should capture approved entry status");
		assertFingerprint(eventRecord.checkpoint.approvedEntry.hash, "approved entry hash");
		assert(eventRecord.checkpoint?.proposedEntry?.chars > 0, "event should capture proposed entry chars");
		assert(eventRecord.checkpoint.proposedEntry.bytes > 0, "event should capture proposed entry bytes");
		assert(eventRecord.checkpoint.proposedEntry.estimatedTokens > 0, "event should capture proposed entry tokens");
		assertFingerprint(eventRecord.checkpoint.proposedEntry.hash, "proposed entry hash");
		assert(eventRecord.validation?.valid === true, "event should capture validation success");
		assert(Array.isArray(eventRecord.validation?.warnings), "event should capture validation warnings");
		assert(Array.isArray(eventRecord.validation?.errors), "event should capture validation errors array");
		assert(Array.isArray(eventRecord.warnings), "event should include top-level warnings array");

		const serializedEvent = JSON.stringify(eventRecord);
		assert(!serializedEvent.includes(root), "event JSON should not include temp absolute root");
		assert(!serializedEvent.includes(agentRoot), "event JSON should not include temp absolute agent root");
		assert(!serializedEvent.includes(APPROVED_RC_SENTINEL), "event JSON should not include raw approved Recent Context sentinel");
		assert(!serializedEvent.includes(PROPOSED_RC_SENTINEL), "event JSON should not include raw proposed Recent Context sentinel");
		assert(!serializedEvent.includes(TRANSCRIPT_SENTINEL), "event JSON should not include raw transcript sentinel");
		assert(!serializedEvent.includes(L1B_BODY_SENTINEL), "event JSON should not include raw L1b body sentinel");

		const archiveCountBeforeInvalid = archiveCount();
		const eventCountBeforeInvalid = checkpointEventCount();
		expectThrows(
			() => invalidRequest("c_checkpoint_event_invalid"),
			/Reload the page, then save again/,
			"invalid approved Recent Context should reject before write",
		);
		assert(archiveCount() === archiveCountBeforeInvalid, "invalid checkpoint should not create archive");
		assert(checkpointEventCount() === eventCountBeforeInvalid, "invalid checkpoint should not create event record");
	}
	fs.rmSync(tempHome, { recursive: true, force: true });
	fs.rmSync(tempCwd, { recursive: true, force: true });
	console.log("checkpoint approval transaction smoke passed");
} catch (error) {
	console.error(error instanceof Error ? error.stack || error.message : error);
	console.error(`temp home preserved for inspection: ${tempHome}`);
	console.error(`temp cwd preserved for inspection: ${tempCwd}`);
	process.exitCode = 1;
}
