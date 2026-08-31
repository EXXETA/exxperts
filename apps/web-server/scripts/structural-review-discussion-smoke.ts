import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "exxeta-structural-review-discussion-home-"));
process.env.HOME = tempHome;
process.env.USERPROFILE = tempHome;
const smokeAppDir = path.join(tempHome, ".exxperts", "app");
fs.mkdirSync(smokeAppDir, { recursive: true });
fs.writeFileSync(
	path.join(smokeAppDir, "openai-compatible-ai-profile.json"),
	JSON.stringify({ profileId: "openai-compatible", providerId: "openai-compatible", label: "Synthetic Gateway", roomModels: [{ modelId: "gpt-5.5" }, { modelId: "claude-opus-4.6" }], maintenanceModel: "claude-opus-4.6" }, null, 2),
);
fs.writeFileSync(path.join(smokeAppDir, "persistent-agent-ai-profile.json"), JSON.stringify({ profileId: "openai-compatible" }, null, 2));
const root = fs.mkdtempSync(path.join(os.tmpdir(), "exxeta-structural-review-discussion-"));
process.env.EXXETA_PERSISTENT_AGENTS_ROOT = root;

const {
	createPersistentAgentFromScaffoldInput,
	buildStructuralReviewDiscussionSignoff,
	buildStructuralReviewDiscussionTurn,
	buildStructuralReviewProposal,
	fingerprintL1bSource,
} = await import("../src/persistent-agents.js");
const { getStructuralReviewModelLock } = await import("../src/persistent-agent-ai-profiles.js");
const { DISCUSSION_HANDOFF_MAX_CHARS, DISCUSSION_HANDOFF_TRIM_MARKER, DISCUSSION_TRANSCRIPT_TRIM_MARKER } = await import("../src/discussion-handoff.js");
const STRUCTURAL_REVIEW_MODEL = getStructuralReviewModelLock("openai-compatible");

const agentId = "structural-review-discussion-smoke-room";
const {
	STRUCTURAL_REVIEW_DISCUSSION_WORKER_TYPE,
	buildStructuralReviewDiscussionPrompt,
	extractStructuralReviewSourceParts,
} = await import("../src/structural-review.js");

const agentRoot = path.join(root, agentId);
const l1bPath = path.join(agentRoot, "L1b", "current.md");

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

function readL1b(): string {
	return fs.readFileSync(l1bPath, "utf-8");
}

function sourceL1b(extraReviewTarget = ""): string {
	return `<!-- exxeta:l1b schema_version=1 -->

## Chronos

- Current scaffold timestamp: 2026-05-21T10:00:00.000Z
- Persistent agent id: structural-review-discussion-smoke-room
- UNIQUE_CHRONOS_SENTINEL_MUST_NOT_REACH_DISCUSSION_OPERATOR

## Deep Memory

### Collaboration and Workflow

- The synthetic user prefers scoped GitLab MRs with explicit cleanup steps.
- UNIQUE_DEEP_MEMORY_SENTINEL_SHOULD_REACH_DISCUSSION_OPERATOR
${extraReviewTarget}

## Active Items

### Current Focus

- Implement MR25 Prune memory discussion backend while preserving operator boundaries.

## Recent Context

### RC-0001 | OPEN | 2026-05-21 | Smoke context

**Session arc:** This Recent Context entry must not reach Prune memory discussion prompts.

**Body:**
- UNIQUE_RECENT_CONTEXT_SENTINEL_MUST_NOT_REACH_DISCUSSION_OPERATOR

**Parked:**
None.
`;
}

const assessmentMarkdown = `## Prune memory assessment

### Memory map
| Area | Words | Estimated tokens |
|---|---:|---:|
| Deep Memory | 20 | 40 |
| Active Items | 15 | 30 |

### Looks healthy
- The workflow preference is durable.

### Stale or drift-prone
- None detected.

### Could be denser
- Active Items can be tightened.

### Structure opportunities
- Keep current work focused.

### Proposed direction
- Tighten stable memory while preserving MR25 operator boundaries.
`;

const discussionReply = "The review target can preserve the MR25 operator-boundary signal while pruning repeated implementation detail.";

const signoffMarkdown = `## Prune memory discussion signoff

### User guidance
- Preserve the Prune memory discussion/proposal operator separation.

### Preserve
- Keep durable collaboration workflow preferences.

### Prune or tighten
- Remove repeated implementation-detail chatter.

### Reorganize
- Keep Active Items focused on current MR25 work.

### Needs judgment
- None

### Transcript summary
The discussion confirmed that signoff should hand off guidance to a separate proposal operator.
`;

const candidateReviewTarget = `## Deep Memory

### Collaboration and Workflow

- The synthetic user prefers scoped GitLab MRs with explicit cleanup steps.
- UNIQUE_DEEP_MEMORY_SENTINEL_SHOULD_REACH_DISCUSSION_OPERATOR

## Active Items

### Current Focus

- Implement MR25 Prune memory discussion backend while preserving separate discussion and proposal operators.
`;

function proposalFixture(candidate = candidateReviewTarget): string {
	return `## Prune Memory Proposal

### Mode
STC_DIAGNOSTIC

### Summary
Tighten stable memory around MR25 operator boundaries.

### Section-Level Change Log
| Section | Prior Tokens | Candidate Tokens | Disposition | Rationale |
|---|---:|---:|---|---|
| Deep Memory | 40 | 35 | tighten | Preserve durable signal. |
| Active Items | 30 | 25 | tighten | Keep live work concise. |

### Subsection / Entry Detail
| Area | Operation | Rationale |
|---|---|---|
| Active Items / Current Focus | tighten | Preserve current work with less chatter. |

### Staleness Flags
None detected.

### Proposed Memory Map
| Area | Words | Estimated tokens |
|---|---:|---:|
| Deep Memory | 16 | 35 |
| Active Items | 12 | 25 |

### Review Target Metrics
- Review target words before: 35
- Review target words after: 28
- Review target estimated tokens before: 70
- Review target estimated tokens after: 60
- Estimated token delta: -10

### Warnings
None

### Dropped material
None.

### Candidate review target L1b
${candidate}`;
}

function sourceMetadata(l1b = readL1b()) {
	const parts = extractStructuralReviewSourceParts(l1b);
	return {
		l1bFingerprint: fingerprintL1bSource(l1b),
		reviewTargetFingerprint: fingerprintL1bSource(parts.sourceReviewTargetL1b),
		chronosFingerprint: fingerprintL1bSource(parts.preservedChronos),
		recentContextFingerprint: fingerprintL1bSource(parts.preservedRecentContext),
		generatedAt: "2026-05-21T21:00:00.000Z",
	};
}

async function expectThrowsAsync(fn: () => Promise<unknown>, expected: RegExp, label: string): Promise<void> {
	try {
		await fn();
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		assert(expected.test(message), `${label}: expected ${expected}, got ${message}`);
		return;
	}
	throw new Error(`${label}: expected error`);
}

try {
	createPersistentAgentFromScaffoldInput({
		displayName: "Structural Review Discussion Smoke Room",
		userName: "Synthetic User",
		preferredUserAddress: "Synthetic User",
	});
	fs.writeFileSync(l1bPath, sourceL1b(), "utf-8");
	const originalL1b = readL1b();
	const parts = extractStructuralReviewSourceParts(originalL1b);
	const source = sourceMetadata(originalL1b);

	const promptAssembly = buildStructuralReviewDiscussionPrompt({
		agentId: agentId,
		sourceReviewTargetL1b: parts.sourceReviewTargetL1b,
		model: STRUCTURAL_REVIEW_MODEL,
		assessmentMarkdown,
		messages: [],
		userMessage: "Should we preserve the operator-boundary decision?",
		sourceFingerprint: source.l1bFingerprint,
		sourceReviewTargetFingerprint: source.reviewTargetFingerprint,
		mode: "turn",
		now: new Date("2026-05-21T21:00:00.000Z"),
	});
	assert(promptAssembly.prompt.includes("Prune memory discussion operator"), "discussion prompt should identify discussion operator");
	assert(promptAssembly.prompt.includes("UNIQUE_DEEP_MEMORY_SENTINEL_SHOULD_REACH_DISCUSSION_OPERATOR"), "discussion prompt should include review target content");
	assert(!promptAssembly.prompt.includes("UNIQUE_CHRONOS_SENTINEL_MUST_NOT_REACH_DISCUSSION_OPERATOR"), "discussion prompt must exclude Chronos body");
	assert(!promptAssembly.prompt.includes("UNIQUE_RECENT_CONTEXT_SENTINEL_MUST_NOT_REACH_DISCUSSION_OPERATOR"), "discussion prompt must exclude Recent Context body");
	assert(!promptAssembly.prompt.includes("### RC-0001"), "discussion prompt must exclude Recent Context entries");
	assert(promptAssembly.tokenBudget.state === "ok", "normal discussion prompt should be within budget");

	let turnGeneratorCalled = false;
	const turnResponse = await buildStructuralReviewDiscussionTurn({
		agentId,
		source,
		assessmentMarkdown,
		messages: [],
		userMessage: "Should we preserve the operator-boundary decision?",
	}, STRUCTURAL_REVIEW_MODEL, async (prompt, model) => {
		turnGeneratorCalled = true;
		assert(prompt.includes("## Task: Prune Memory Discussion Turn"), "turn builder should pass turn task to generator");
		assert(!prompt.includes("UNIQUE_CHRONOS_SENTINEL_MUST_NOT_REACH_DISCUSSION_OPERATOR"), "turn generator prompt must exclude Chronos body");
		assert(!prompt.includes("UNIQUE_RECENT_CONTEXT_SENTINEL_MUST_NOT_REACH_DISCUSSION_OPERATOR"), "turn generator prompt must exclude Recent Context body");
		assert(model.provider === STRUCTURAL_REVIEW_MODEL.provider && model.model === STRUCTURAL_REVIEW_MODEL.model, "discussion turn should use system-selected structural review model");
		return { text: discussionReply, usage: { input: 10, output: 5, totalTokens: 15, cost: 0 } };
	});
	assert(turnGeneratorCalled, "discussion turn should call generator");
	assert(turnResponse.writesMemory === false, "discussion turn should be non-mutating");
	assert(turnResponse.process.type === STRUCTURAL_REVIEW_DISCUSSION_WORKER_TYPE, "discussion turn should identify discussion worker");
	assert(turnResponse.message.role === "assistant", "discussion turn should return assistant message");
	assert(turnResponse.message.content === discussionReply, "discussion turn should return generated whole message");
	assert(readL1b() === originalL1b, "discussion turn must not mutate L1b");

	let signoffGeneratorCalled = false;
	const signoffResponse = await buildStructuralReviewDiscussionSignoff({
		agentId,
		source,
		assessmentMarkdown,
		messages: [
			{ role: "user", content: "Preserve the operator-boundary decision." },
			{ role: "assistant", content: discussionReply },
		],
	}, STRUCTURAL_REVIEW_MODEL, async (prompt, model) => {
		signoffGeneratorCalled = true;
		assert(prompt.includes("## Task: Prune Memory Discussion Signoff Handoff"), "signoff builder should pass signoff task to generator");
		assert(prompt.includes("Keep the whole handoff under about"), "signoff prompt should state an output budget");
		assert(!prompt.includes("UNIQUE_CHRONOS_SENTINEL_MUST_NOT_REACH_DISCUSSION_OPERATOR"), "signoff generator prompt must exclude Chronos body");
		assert(!prompt.includes("UNIQUE_RECENT_CONTEXT_SENTINEL_MUST_NOT_REACH_DISCUSSION_OPERATOR"), "signoff generator prompt must exclude Recent Context body");
		assert(model.provider === STRUCTURAL_REVIEW_MODEL.provider && model.model === STRUCTURAL_REVIEW_MODEL.model, "discussion signoff should use system-selected structural review model");
		return { text: signoffMarkdown, usage: { input: 20, output: 15, totalTokens: 35, cost: 0 } };
	});
	assert(signoffGeneratorCalled, "discussion signoff should call generator");
	assert(signoffResponse.writesMemory === false, "discussion signoff should be non-mutating");
	assert(signoffResponse.assessmentHandoff.source === "discussion_signoff", "signoff should return discussion_signoff handoff source");
	assert(signoffResponse.assessmentHandoff.text.includes("## Prune memory discussion signoff"), "signoff should return handoff markdown");
	assert(readL1b() === originalL1b, "discussion signoff must not mutate L1b");

	let proposalGeneratorCalled = false;
	const proposalResponse = await buildStructuralReviewProposal({
		agentId,
		assessmentMarkdown,
		assessmentHandoff: signoffResponse.assessmentHandoff,
		source,
	}, STRUCTURAL_REVIEW_MODEL, async (prompt, model) => {
		proposalGeneratorCalled = true;
		assert(prompt.includes("Source: discussion_signoff"), "proposal prompt should include discussion signoff handoff source");
		assert(prompt.includes("Preserve the Prune memory discussion/proposal operator separation"), "proposal prompt should include handoff text");
		assert(!prompt.includes("UNIQUE_CHRONOS_SENTINEL_MUST_NOT_REACH_DISCUSSION_OPERATOR"), "proposal prompt from signoff must exclude Chronos body");
		assert(!prompt.includes("UNIQUE_RECENT_CONTEXT_SENTINEL_MUST_NOT_REACH_DISCUSSION_OPERATOR"), "proposal prompt from signoff must exclude Recent Context body");
		assert(model.provider === STRUCTURAL_REVIEW_MODEL.provider && model.model === STRUCTURAL_REVIEW_MODEL.model, "proposal should use system-selected structural review model");
		return { text: proposalFixture(), usage: { input: 30, output: 40, totalTokens: 70, cost: 0 } };
	});
	assert(proposalGeneratorCalled, "proposal from discussion signoff should call generator");
	assert(proposalResponse.writesMemory === false, "proposal from discussion signoff should be non-mutating");
	assert(proposalResponse.candidateValidation.valid, "proposal from discussion signoff should validate candidate");
	assert(readL1b() === originalL1b, "proposal generation must not mutate L1b");

	// --- Trap family: the server never rejects its own signoff output ---------

	// 1. Oversized handoff: Transcript summary is shed first, Needs judgment
	// survives, the trim is disclosed, and /propose accepts the result.
	const oversizedSignoff = signoffMarkdown.replace(
		"The discussion confirmed that signoff should hand off guidance to a separate proposal operator.",
		`The discussion ran long. ${"Every turn restated the same operator-boundary point in new words. ".repeat(160)}`,
	).replace("### Needs judgment\n- None", "### Needs judgment\n- NEEDS_JUDGMENT_SENTINEL: keep or drop the MR25 follow-ups?");
	assert(oversizedSignoff.length > DISCUSSION_HANDOFF_MAX_CHARS, "oversized signoff fixture should exceed the handoff cap");
	const trimmedSignoff = await buildStructuralReviewDiscussionSignoff({
		agentId,
		source,
		assessmentMarkdown,
		messages: [{ role: "user", content: "Preserve the operator-boundary decision." }, { role: "assistant", content: discussionReply }],
	}, STRUCTURAL_REVIEW_MODEL, async () => ({ text: oversizedSignoff, usage: { input: 20, output: 15, totalTokens: 35, cost: 0 } }));
	assert(trimmedSignoff.assessmentHandoff.text.length <= DISCUSSION_HANDOFF_MAX_CHARS, "oversized handoff should be trimmed under the cap");
	assert(trimmedSignoff.assessmentHandoff.text.includes(`### Transcript summary\n\n${DISCUSSION_HANDOFF_TRIM_MARKER}`), "Transcript summary should be shed first with a disclosed marker");
	assert(trimmedSignoff.assessmentHandoff.text.includes("NEEDS_JUDGMENT_SENTINEL"), "Needs judgment must survive the trim");
	assert(trimmedSignoff.assessmentHandoff.text.includes("Preserve the Prune memory discussion/proposal operator separation"), "User guidance should survive when shedding the summary is enough");
	assert(trimmedSignoff.warnings.some((warning) => /discussion summary handed to the draft ran past its 8000-character limit/.test(warning) && /"Transcript summary"/.test(warning)), "trimmed handoff should be disclosed in warnings");
	let trimmedProposalPrompt = "";
	await buildStructuralReviewProposal({
		agentId,
		assessmentMarkdown,
		assessmentHandoff: trimmedSignoff.assessmentHandoff,
		source,
	}, STRUCTURAL_REVIEW_MODEL, async (prompt) => {
		trimmedProposalPrompt = prompt;
		return { text: proposalFixture(), usage: { input: 30, output: 40, totalTokens: 70, cost: 0 } };
	});
	assert(trimmedProposalPrompt.includes(DISCUSSION_HANDOFF_TRIM_MARKER), "proposal step should accept the trimmed handoff and see the marker");

	// 2. Signoff prompt ladder on a small-window model: older long messages are
	// shortened, the last 4 stay whole, and the trim is disclosed.
	const ladderMessages = Array.from({ length: 20 }, (_, index) => ({
		role: (index % 2 === 0 ? "user" : "assistant") as "user" | "assistant",
		content: index === 19 ? `LAST_MESSAGE_SENTINEL ${"closing point ".repeat(277).trim()}` : `Turn ${index + 1}: ${"long discussion turn ".repeat(185).trim()}`,
	}));
	let ladderPrompt = "";
	const ladderSignoff = await buildStructuralReviewDiscussionSignoff({
		agentId,
		source,
		assessmentMarkdown,
		messages: ladderMessages,
	}, STRUCTURAL_REVIEW_MODEL, async (prompt) => {
		ladderPrompt = prompt;
		return { text: signoffMarkdown, usage: { input: 20, output: 15, totalTokens: 35, cost: 0 } };
	}, { resolveModelWindow: () => ({ contextWindow: 24000, maxOutputTokens: 1000 }) });
	assert(ladderPrompt.includes(DISCUSSION_TRANSCRIPT_TRIM_MARKER), "ladder should trim long older messages in the signoff prompt");
	assert(ladderPrompt.includes(ladderMessages[19].content), "ladder must keep the latest messages whole");
	assert(!ladderPrompt.includes("UNIQUE_CHRONOS_SENTINEL_MUST_NOT_REACH_DISCUSSION_OPERATOR"), "laddered signoff prompt must still exclude Chronos body");
	assert(ladderSignoff.tokenBudget.promptEstimatedTokens <= 19400, `laddered signoff prompt should fit the window budget (got ${ladderSignoff.tokenBudget.promptEstimatedTokens})`);
	assert(ladderSignoff.warnings.some((warning) => /discussion was trimmed so the model could read it back/.test(warning) && /last 4 turns were kept in full/.test(warning)), `ladder should be disclosed in warnings (got ${JSON.stringify(ladderSignoff.warnings)})`);

	// 3. Below the tightest stage, signoff and turn refuse honestly (413, named
	// process) before the provider is called.
	let refusedSignoffGeneratorCalled = false;
	try {
		await buildStructuralReviewDiscussionSignoff({ agentId, source, assessmentMarkdown, messages: ladderMessages }, STRUCTURAL_REVIEW_MODEL, async () => {
			refusedSignoffGeneratorCalled = true;
			return { text: signoffMarkdown };
		}, { resolveModelWindow: () => ({ contextWindow: 2000, maxOutputTokens: 1000 }) });
		throw new Error("oversized signoff prompt should refuse");
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		assert(/the Review discussion summary prompt for .* is too large for the locked model/.test(message) && (error as any).statusCode === 413, `signoff overflow should refuse with 413 and the named process (got ${message})`);
	}
	assert(!refusedSignoffGeneratorCalled, "refused signoff must not call the provider");
	let refusedTurnGeneratorCalled = false;
	try {
		await buildStructuralReviewDiscussionTurn({ agentId, source, assessmentMarkdown, messages: [], userMessage: "Please continue." }, STRUCTURAL_REVIEW_MODEL, async () => {
			refusedTurnGeneratorCalled = true;
			return { text: "should not run" };
		}, { resolveModelWindow: () => ({ contextWindow: 2000, maxOutputTokens: 1000 }) });
		throw new Error("oversized discussion turn prompt should refuse");
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		assert(/the Review discussion prompt for .* is too large/.test(message) && (error as any).statusCode === 413, `turn overflow should refuse with 413 and the named process (got ${message})`);
	}
	assert(!refusedTurnGeneratorCalled, "refused discussion turn must not call the provider");
	assert(readL1b() === originalL1b, "trap-family checks must not mutate L1b");

	let missingSourceProposalGeneratorCalled = false;
	await expectThrowsAsync(
		() => buildStructuralReviewProposal({
			agentId,
			assessmentMarkdown,
			assessmentHandoff: signoffResponse.assessmentHandoff,
		}, STRUCTURAL_REVIEW_MODEL, async () => {
			missingSourceProposalGeneratorCalled = true;
			return { text: proposalFixture() };
		}),
		/discussion source is required/,
		"proposal from discussion signoff without source should reject before generator",
	);
	assert(!missingSourceProposalGeneratorCalled, "missing source proposal should not call generator");

	const staleSource = sourceMetadata(readL1b());
	fs.writeFileSync(l1bPath, readL1b().replace("MR25 Prune memory", "MR25 stale Prune memory"), "utf-8");
	let staleTurnGeneratorCalled = false;
	await expectThrowsAsync(
		() => buildStructuralReviewDiscussionTurn({
			agentId,
			source: staleSource,
			assessmentMarkdown,
			messages: [],
			userMessage: "Please continue.",
		}, STRUCTURAL_REVIEW_MODEL, async () => {
			staleTurnGeneratorCalled = true;
			return { text: "should not run" };
		}),
		/source L1b fingerprint changed/,
		"stale discussion source should reject before generator",
	);
	assert(!staleTurnGeneratorCalled, "stale discussion source should not call generator");

	fs.writeFileSync(l1bPath, originalL1b, "utf-8");
	const staleReviewTargetSource = sourceMetadata(readL1b());
	staleReviewTargetSource.reviewTargetFingerprint = fingerprintL1bSource("stale review target");
	let staleProposalGeneratorCalled = false;
	await expectThrowsAsync(
		() => buildStructuralReviewProposal({
			agentId,
			assessmentMarkdown,
			assessmentHandoff: signoffResponse.assessmentHandoff,
			source: staleReviewTargetSource,
		}, STRUCTURAL_REVIEW_MODEL, async () => {
			staleProposalGeneratorCalled = true;
			return { text: proposalFixture() };
		}),
		/source review target fingerprint changed/,
		"stale discussion signoff proposal source should reject before generator",
	);
	assert(!staleProposalGeneratorCalled, "stale discussion signoff proposal source should not call generator");

	const staleChronosSource = sourceMetadata(readL1b());
	staleChronosSource.chronosFingerprint = fingerprintL1bSource("stale chronos");
	let staleChronosGeneratorCalled = false;
	await expectThrowsAsync(
		() => buildStructuralReviewDiscussionSignoff({
			agentId,
			source: staleChronosSource,
			assessmentMarkdown,
			messages: [],
		}, STRUCTURAL_REVIEW_MODEL, async () => {
			staleChronosGeneratorCalled = true;
			return { text: signoffMarkdown };
		}),
		/source Chronos fingerprint changed/,
		"stale Chronos source should reject before generator",
	);
	assert(!staleChronosGeneratorCalled, "stale Chronos source should not call generator");

	const staleRecentContextSource = sourceMetadata(readL1b());
	staleRecentContextSource.recentContextFingerprint = fingerprintL1bSource("stale recent context");
	let staleRecentContextGeneratorCalled = false;
	await expectThrowsAsync(
		() => buildStructuralReviewDiscussionTurn({
			agentId,
			source: staleRecentContextSource,
			assessmentMarkdown,
			messages: [],
			userMessage: "Please continue.",
		}, STRUCTURAL_REVIEW_MODEL, async () => {
			staleRecentContextGeneratorCalled = true;
			return { text: "should not run" };
		}),
		/source Recent Context fingerprint changed/,
		"stale Recent Context source should reject before generator",
	);
	assert(!staleRecentContextGeneratorCalled, "stale Recent Context source should not call generator");

	const hugeReviewTarget = `- ${"budget pressure ".repeat(42000)}`;
	fs.writeFileSync(l1bPath, sourceL1b(hugeReviewTarget), "utf-8");
	const hugeSource = sourceMetadata(readL1b());
	let budgetGeneratorCalled = false;
	await expectThrowsAsync(
		() => buildStructuralReviewDiscussionTurn({
			agentId,
			source: hugeSource,
			assessmentMarkdown,
			messages: [],
			userMessage: "Please continue despite the large source.",
		}, STRUCTURAL_REVIEW_MODEL, async () => {
			budgetGeneratorCalled = true;
			return { text: "should not run" };
		}),
		/token budget exceeded/,
		"over-budget discussion turn should reject before generator",
	);
	assert(!budgetGeneratorCalled, "over-budget discussion turn should not call generator");

	fs.rmSync(root, { recursive: true, force: true });
	console.log("structural review discussion smoke passed");
} catch (error) {
	console.error(error instanceof Error ? error.stack || error.message : error);
	console.error(`temp root preserved for inspection: ${root}`);
	process.exitCode = 1;
}
