import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "exxeta-checkpoint-canonical-home-"));
process.env.HOME = tempHome;
process.env.USERPROFILE = tempHome;
const smokeAppDir = path.join(tempHome, ".exxperts", "app");
fs.mkdirSync(smokeAppDir, { recursive: true });
fs.writeFileSync(
	path.join(smokeAppDir, "openai-compatible-ai-profile.json"),
	JSON.stringify({ profileId: "openai-compatible", providerId: "openai-compatible", label: "Synthetic Gateway", roomModels: [{ modelId: "gpt-5.5" }, { modelId: "claude-opus-4.6" }], maintenanceModel: "claude-opus-4.6" }, null, 2),
);
fs.writeFileSync(path.join(smokeAppDir, "persistent-agent-ai-profile.json"), JSON.stringify({ profileId: "openai-compatible" }, null, 2));
const root = fs.mkdtempSync(path.join(os.tmpdir(), "exxeta-checkpoint-canonical-runtime-"));
const tempCwd = fs.mkdtempSync(path.join(os.tmpdir(), "exxeta-checkpoint-canonical-cwd-"));
process.env.EXXETA_PERSISTENT_AGENTS_ROOT = root;

const {
	createPersistentAgentFromScaffoldInput,
	buildCheckpointProposal,
	buildPersistentAgentCheckpointTranscriptSource,
	createPersistentAgentInstance,
	createPersistentAgentPiSessionJsonlThreadRuntime,
	getPersistentAgentThread,
	openPersistentAgentPiSessionManager,
	parseCheckpointApprovalRequest,
	writeApprovedCheckpoint,
	writePersistentAgentThread,
} = await import("../src/persistent-agents.js");

const agentId = "checkpoint-smoke-room";
const model = { provider: "openai-compatible", model: "gpt-5.5", label: "GPT-5.5" };
const CANONICAL_SENTINEL = "CANONICAL_JSONL_CHECKPOINT_SOURCE_SENTINEL";
const DISPLAY_CACHE_SENTINEL = "DISPLAY_CACHE_MUST_NOT_BE_CHECKPOINT_SOURCE";
const LEGACY_CALLER_SENTINEL = "LEGACY_CALLER_DISPLAY_ITEMS_SENTINEL";
const LEGACY_SAVED_SENTINEL = "LEGACY_SAVED_THREAD_ITEMS_NOT_USED_WHEN_CALLER_ITEMS_EXIST";

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

function proposalText(title: string): string {
	return `TITLE:\n${title}\n\nSESSION_ARC:\nA synthetic checkpoint source smoke generated a proposal from the expected transcript source.\n\nBODY:\n- The checkpoint proposal used the intended synthetic source.\n\nPARKED:\nNone\n`;
}

function approvedRecentContext(title: string): string {
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
		approvedRecentContext: approvedRecentContext(title),
	}, agentId);
	writeApprovedCheckpoint(parsed.request, parsed.warnings, new Date("2026-06-14T12:00:00.000Z"));
}

try {
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
	fs.rmSync(root, { recursive: true, force: true });
	fs.rmSync(tempCwd, { recursive: true, force: true });
	console.log("checkpoint canonical runtime smoke passed");
} catch (error) {
	console.error(error instanceof Error ? error.stack || error.message : error);
	console.error(`temp root preserved for inspection: ${root}`);
	console.error(`temp cwd preserved for inspection: ${tempCwd}`);
	process.exitCode = 1;
}
