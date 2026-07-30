import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "exxeta-structural-review-home-"));
process.env.HOME = tempHome;
process.env.USERPROFILE = tempHome;
const smokeAppDir = path.join(tempHome, ".exxperts", "app");
fs.mkdirSync(smokeAppDir, { recursive: true });
fs.writeFileSync(
	path.join(smokeAppDir, "openai-compatible-ai-profile.json"),
	JSON.stringify({ profileId: "openai-compatible", providerId: "openai-compatible", label: "Synthetic Gateway", roomModels: [{ modelId: "gpt-5.5" }, { modelId: "claude-opus-4.6" }], maintenanceModel: "claude-opus-4.6" }, null, 2),
);
fs.writeFileSync(path.join(smokeAppDir, "persistent-agent-ai-profile.json"), JSON.stringify({ profileId: "openai-compatible" }, null, 2));
const root = fs.mkdtempSync(path.join(os.tmpdir(), "exxeta-structural-review-"));
process.env.EXXETA_PERSISTENT_AGENTS_ROOT = root;

const {
	createPersistentAgentFromScaffoldInput,
	buildStructuralReviewAssessment,
	buildStructuralReviewProposal,
	fingerprintL1bSource,
	getStructuralReviewAvailability,
} = await import("../src/persistent-agents.js");

const agentId = "structural-review-smoke-room";
const {
	STRUCTURAL_REVIEW_MODE,
	STRUCTURAL_REVIEW_WORKER_TYPE,
	buildStructuralReviewAssessmentPrompt,
	buildStructuralReviewMemoryMap,
	buildStructuralReviewProposalPrompt,
	extractStructuralReviewSourceParts,
	parseStructuralReviewAssessment,
	parseStructuralReviewProposal,
	structuralReviewMetrics,
	validateStructuralReviewCandidateReviewTarget,
} = await import("../src/structural-review.js");
const { getStructuralReviewModelLock } = await import("../src/persistent-agent-ai-profiles.js");
const STRUCTURAL_REVIEW_MODEL = getStructuralReviewModelLock("openai-compatible");

const agentRoot = path.join(root, agentId);
const l1bPath = path.join(agentRoot, "L1b", "current.md");
const CHATGPT_CODEX_STRUCTURAL_REVIEW_MODEL = getStructuralReviewModelLock("chatgpt-codex");

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

function readL1b(): string {
	return fs.readFileSync(l1bPath, "utf-8");
}

function sourceL1b(): string {
	return `<!-- exxeta:l1b schema_version=1 -->

## Chronos

- Current scaffold timestamp: 2026-05-21T10:00:00.000Z
- Persistent agent id: structural-review-smoke-room
- UNIQUE_CHRONOS_SENTINEL_SHOULD_NOT_REACH_OPERATOR

## Deep Memory

### Identity and Preferences

- The synthetic user prefers scoped GitLab MRs with explicit cleanup steps.
- The synthetic user is learning collaborative Git/GitLab workflows.

### Product Direction

- Persistent-agent memory maintenance should feel calm and lean.
- UNIQUE_DEEP_MEMORY_SIGNAL_SHOULD_REACH_OPERATOR

#### Deeper Note

- This deeper heading should be counted inside Product Direction, not as a separate memory-map row.

## Active Items

### High Priority

- Implement Prune memory backend foundation as MR23.
- Preserve strict Chronos and Recent Context exclusion invariants.

### Parked

- Revisit shared Maintain workspace polish after both workflows exist.

## Recent Context

### RC-0001 | OPEN | 2026-05-21 | Smoke context

**Session arc:** This RC entry must never enter Prune memory prompts.

**Body:**
- UNIQUE_RECENT_CONTEXT_SENTINEL_SHOULD_NOT_REACH_OPERATOR

**Parked:**
None.
`;
}

const assessmentFixture = `## Prune memory assessment

### Memory map
| Area | Words | Estimated tokens |
|---|---:|---:|
| Deep Memory | 35 | 60 |
| Deep Memory / Identity and Preferences | 12 | 20 |
| Deep Memory / Product Direction | 20 | 30 |
| Active Items | 20 | 35 |
| Active Items / High Priority | 12 | 20 |
| Active Items / Parked | 8 | 15 |

### Looks healthy
- The GitLab workflow preference is durable and useful.
- The memory-maintenance product direction is coherent.

### Stale or drift-prone
- None detected.

### Could be denser
- Active Items can be tightened around the current MR23 thread.
- Product direction can be expressed with fewer tokens.

### Structure opportunities
- Keep Product Direction as one durable subsection.
- Keep Active Items focused on live work.

### Proposed direction
- Tighten repeated implementation detail while preserving workflow preferences and live MR23 state.
`;

const candidateReviewTarget = `## Deep Memory

### Collaboration and Workflow

- The synthetic user prefers scoped GitLab MRs with explicit cleanup steps and is learning collaborative Git/GitLab workflows.

### Product Direction

- Persistent-agent memory maintenance should feel calm, lean, and signal-first.
- UNIQUE_DEEP_MEMORY_SIGNAL_SHOULD_REACH_OPERATOR

## Active Items

### Current Focus

- Implement MR23 Prune memory backend foundation while preserving Chronos and Recent Context exclusion invariants.

### Parked

- Revisit shared Maintain workspace polish after Absorb and Prune memory both exist.
`;

const proposalFixture = `## Prune Memory Proposal

### Mode
STC_DIAGNOSTIC

### Summary
Tighten stable memory around durable workflow preferences and the current MR23 implementation focus.

### Section-Level Change Log
| Section | Prior Tokens | Candidate Tokens | Disposition | Rationale |
|---|---:|---:|---|---|
| Deep Memory | 75 | 55 | tighten | Merge overlapping durable workflow/product direction signal. |
| Active Items | 55 | 42 | reorganize | Keep only live MR23 and parked workspace polish threads. |

### Subsection / Entry Detail
| Area | Operation | Rationale |
|---|---|---|
| Deep Memory / Identity and Preferences | merge | Combine with workflow preference. |
| Active Items / High Priority | tighten | Preserve live task with less implementation chatter. |

### Staleness Flags
None detected.

### Proposed Memory Map
| Area | Words | Estimated tokens |
|---|---:|---:|
| Deep Memory | 24 | 55 |
| Deep Memory / Collaboration and Workflow | 12 | 24 |
| Deep Memory / Product Direction | 10 | 22 |
| Active Items | 20 | 42 |
| Active Items / Current Focus | 12 | 25 |
| Active Items / Parked | 8 | 17 |

### Review Target Metrics
- Review target words before: 58
- Review target words after: 44
- Review target estimated tokens before: 130
- Review target estimated tokens after: 97
- Estimated token delta: -33

### Warnings
None

### Candidate review target L1b
${candidateReviewTarget}`;

try {
	createPersistentAgentFromScaffoldInput({
		displayName: "Structural Review Smoke Room",
		userName: "Synthetic User",
		preferredUserAddress: "Synthetic User",
	});
	fs.writeFileSync(l1bPath, sourceL1b(), "utf-8");
	const originalL1b = readL1b();

	const availability = getStructuralReviewAvailability(agentId);
	assert(availability.available, `Prune memory should be available: ${availability.message}`);
	assert(availability.memoryMap.some((row) => row.area === "Deep Memory / Product Direction"), "availability should include Deep Memory subsection in memory map");
	assert(!availability.memoryMap.some((row) => /Deeper Note/.test(row.area)), "memory map should not include fourth-level headings as rows");

	const parts = extractStructuralReviewSourceParts(originalL1b);
	assert(parts.preservedChronos.includes("UNIQUE_CHRONOS_SENTINEL_SHOULD_NOT_REACH_OPERATOR"), "splitter should preserve Chronos exactly");
	assert(parts.preservedRecentContext.includes("UNIQUE_RECENT_CONTEXT_SENTINEL_SHOULD_NOT_REACH_OPERATOR"), "splitter should preserve Recent Context exactly");
	assert(parts.sourceReviewTargetL1b.includes("UNIQUE_DEEP_MEMORY_SIGNAL_SHOULD_REACH_OPERATOR"), "review target should include Deep Memory signal");
	assert(!parts.sourceReviewTargetL1b.includes("UNIQUE_CHRONOS_SENTINEL_SHOULD_NOT_REACH_OPERATOR"), "review target must exclude Chronos content");
	assert(!parts.sourceReviewTargetL1b.includes("UNIQUE_RECENT_CONTEXT_SENTINEL_SHOULD_NOT_REACH_OPERATOR"), "review target must exclude Recent Context content");

	const memoryMap = buildStructuralReviewMemoryMap(parts.sourceReviewTargetL1b);
	assert(memoryMap.some((row) => row.area === "Active Items / High Priority"), "memory map should include immediate Active Items subsection");
	assert(!memoryMap.some((row) => row.area.includes("Deeper Note")), "memory map should stop at immediate subsections");
	const metrics = structuralReviewMetrics(parts.sourceReviewTargetL1b);
	assert(metrics.words > 0 && metrics.estimatedTokens > 0, "metrics should include deterministic word/token counts");

	const assessmentPrompt = buildStructuralReviewAssessmentPrompt({ agentId: agentId, sourceReviewTargetL1b: parts.sourceReviewTargetL1b, model: STRUCTURAL_REVIEW_MODEL, now: new Date("2026-05-21T12:00:00.000Z") });
	assert(assessmentPrompt.prompt.includes("currentTime: 2026-05-21T12:00:00.000Z"), "assessment prompt should include deterministic currentTime metadata");
	assert(assessmentPrompt.prompt.includes("UNIQUE_DEEP_MEMORY_SIGNAL_SHOULD_REACH_OPERATOR"), "assessment prompt should include review target content");
	assert(!assessmentPrompt.prompt.includes("UNIQUE_CHRONOS_SENTINEL_SHOULD_NOT_REACH_OPERATOR"), "assessment prompt must not include Chronos body");
	assert(!assessmentPrompt.prompt.includes("UNIQUE_RECENT_CONTEXT_SENTINEL_SHOULD_NOT_REACH_OPERATOR"), "assessment prompt must not include Recent Context body");
	assert(!assessmentPrompt.prompt.includes("### RC-0001"), "assessment prompt must not include Recent Context entries");
	assert(assessmentPrompt.prompt.includes("## Must-Keep Material"), "prune constitution should carry the must-keep rule");
	assert(assessmentPrompt.prompt.includes("keep the source attached"), "prune constitution should carry the provenance rule");

	const parsedAssessment = parseStructuralReviewAssessment(assessmentFixture);
	assert(parsedAssessment.fields.looksHealthy.length === 2, "assessment parser should extract Looks healthy bullets");
	assert(parsedAssessment.fields.couldBeDenser.length === 2, "assessment parser should extract Could be denser bullets");

	const assessmentResponse = await buildStructuralReviewAssessment(agentId, STRUCTURAL_REVIEW_MODEL, async (prompt, model) => {
		assert(prompt.includes("Prune memory / Structural Review Constitution"), "assessment builder should pass structural review prompt to generator");
		assert(!prompt.includes("UNIQUE_CHRONOS_SENTINEL_SHOULD_NOT_REACH_OPERATOR"), "assessment builder must not pass Chronos content to generator");
		assert(!prompt.includes("UNIQUE_RECENT_CONTEXT_SENTINEL_SHOULD_NOT_REACH_OPERATOR"), "assessment builder must not pass Recent Context content to generator");
		assert(model.provider === STRUCTURAL_REVIEW_MODEL.provider && model.model === STRUCTURAL_REVIEW_MODEL.model, "assessment should use system-selected maintenance model");
		return { text: assessmentFixture, usage: { input: 10, output: 20, totalTokens: 30, cost: 0 } };
	});
	assert(assessmentResponse.writesMemory === false, "assessment response should be non-mutating");
	assert(assessmentResponse.process.type === STRUCTURAL_REVIEW_WORKER_TYPE, "assessment response should identify structural review worker type");
	assert(assessmentResponse.process.mode === STRUCTURAL_REVIEW_MODE, "assessment response should identify STC diagnostic mode");
	assert(assessmentResponse.source.l1bFingerprint.value === fingerprintL1bSource(originalL1b).value, "assessment source should include full L1b fingerprint");
	assert(assessmentResponse.source.reviewTargetFingerprint.value === fingerprintL1bSource(parts.sourceReviewTargetL1b).value, "assessment source should include review target fingerprint");
	assert(assessmentResponse.source.chronosFingerprint.value === fingerprintL1bSource(parts.preservedChronos).value, "assessment source should include Chronos fingerprint");
	assert(assessmentResponse.source.recentContextFingerprint.value === fingerprintL1bSource(parts.preservedRecentContext).value, "assessment source should include Recent Context fingerprint");

	const altAssessmentResponse = await buildStructuralReviewAssessment(agentId, CHATGPT_CODEX_STRUCTURAL_REVIEW_MODEL, async (prompt, model) => {
		assert(prompt.includes("System-selected model: openai-codex/gpt-5.6-sol"), "ChatGPT Plus/Pro structural-review prompt should use profile-mapped model metadata");
		assert(model.provider === "openai-codex" && model.model === "gpt-5.6-sol", "ChatGPT Plus/Pro structural-review assessment should pass profile-mapped model to generator");
		return { text: assessmentFixture };
	});
	assert(altAssessmentResponse.process.model.provider === "openai-codex" && altAssessmentResponse.process.model.model === "gpt-5.6-sol", "ChatGPT Plus/Pro structural-review response should report profile-mapped process model");

	const proposalPrompt = buildStructuralReviewProposalPrompt({ agentId: agentId, sourceReviewTargetL1b: parts.sourceReviewTargetL1b, model: STRUCTURAL_REVIEW_MODEL, assessmentMarkdown: assessmentFixture });
	assert(proposalPrompt.prompt.includes("Candidate review target L1b"), "proposal prompt should request candidate review target only");
	assert(!proposalPrompt.prompt.includes("UNIQUE_CHRONOS_SENTINEL_SHOULD_NOT_REACH_OPERATOR"), "proposal prompt must not include Chronos body");
	assert(!proposalPrompt.prompt.includes("UNIQUE_RECENT_CONTEXT_SENTINEL_SHOULD_NOT_REACH_OPERATOR"), "proposal prompt must not include Recent Context body");

	const parsedProposal = parseStructuralReviewProposal(proposalFixture);
	assert(/STC_DIAGNOSTIC/.test(parsedProposal.fields.mode), "proposal parser should extract STC mode");
	assert(parsedProposal.fields.candidateReviewTargetL1b.includes("## Deep Memory"), "proposal parser should extract candidate review target");
	const goodValidation = validateStructuralReviewCandidateReviewTarget(parts.sourceReviewTargetL1b, parsedProposal.fields.candidateReviewTargetL1b);
	assert(goodValidation.valid, `candidate review target should validate: ${goodValidation.errors.join("; ")}`);

	const badValidation = validateStructuralReviewCandidateReviewTarget(parts.sourceReviewTargetL1b, `${candidateReviewTarget}\n\n## Recent Context\n\nLeaked RC\n`);
	assert(!badValidation.valid, "candidate with Recent Context top-level section should be rejected");
	assert(badValidation.errors.some((error) => /exactly Deep Memory and Active Items/.test(error)), "bad candidate rejection should explain review-target topology");

	const proposalResponse = await buildStructuralReviewProposal({ agentId, assessmentMarkdown: assessmentFixture }, STRUCTURAL_REVIEW_MODEL, async (prompt, model) => {
		assert(prompt.includes("Prune memory proposal"), "proposal builder should pass structural review proposal prompt to generator");
		assert(!prompt.includes("UNIQUE_CHRONOS_SENTINEL_SHOULD_NOT_REACH_OPERATOR"), "proposal builder must not pass Chronos content to generator");
		assert(!prompt.includes("UNIQUE_RECENT_CONTEXT_SENTINEL_SHOULD_NOT_REACH_OPERATOR"), "proposal builder must not pass Recent Context content to generator");
		assert(model.provider === STRUCTURAL_REVIEW_MODEL.provider && model.model === STRUCTURAL_REVIEW_MODEL.model, "proposal should use system-selected maintenance model");
		return { text: proposalFixture, usage: { input: 50, output: 60, totalTokens: 110, cost: 0 } };
	});
	assert(proposalResponse.writesMemory === false, "proposal response should be non-mutating");
	assert(proposalResponse.candidateValidation.valid, "proposal response should include candidate validation");
	assert(proposalResponse.review.metrics.reviewTargetEstimatedTokenDelta <= 0, "proposal review should include token delta");
	assert(proposalResponse.review.metrics.candidateMemoryMap.some((row) => row.area === "Deep Memory / Collaboration and Workflow"), "proposal review should include candidate memory map");
	assert(readL1b() === originalL1b, "assessment/proposal must not mutate L1b/current.md");

	// Draft again carries the previous validator reasons into the redraft
	// prompt as a Retry Notice; first drafts stay byte-free of it.
	let retryPrompt = "";
	await buildStructuralReviewProposal({ agentId, assessmentMarkdown: assessmentFixture, retryFeedback: ["Candidate review target is empty"] }, STRUCTURAL_REVIEW_MODEL, async (prompt) => {
		retryPrompt = prompt;
		return { text: proposalFixture };
	});
	assert(retryPrompt.includes("## Retry Notice"), "redraft prompt should carry the Retry Notice");
	assert(retryPrompt.includes("- Candidate review target is empty"), "redraft prompt should list the validator reasons");
	let cleanPrompt = "";
	await buildStructuralReviewProposal({ agentId, assessmentMarkdown: assessmentFixture }, STRUCTURAL_REVIEW_MODEL, async (prompt) => {
		cleanPrompt = prompt;
		return { text: proposalFixture };
	});
	assert(!cleanPrompt.includes("## Retry Notice"), "proposal prompt without feedback must not carry a Retry Notice");

	// Input-side overflow guard: a window too small for the assembled prompt
	// refuses with 413 guidance BEFORE the worker runs.
	let overflowWorkerRan = false;
	try {
		await buildStructuralReviewProposal({ agentId, assessmentMarkdown: assessmentFixture }, STRUCTURAL_REVIEW_MODEL, async () => {
			overflowWorkerRan = true;
			return { text: proposalFixture };
		}, { resolveModelWindow: () => ({ contextWindow: 2000, maxOutputTokens: 1000 }) });
		throw new Error("tiny window should refuse the structural review proposal prompt");
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		assert(/too large for the locked model/.test(message), `overflow refusal should name the size problem: ${message}`);
		assert(/larger-context/.test(message), "overflow refusal should carry guidance");
		assert((error as any).statusCode === 413, "overflow refusal should carry HTTP 413");
	}
	assert(!overflowWorkerRan, "overflow refusal must fire before the worker runs");

	fs.rmSync(root, { recursive: true, force: true });
	console.log("structural review smoke passed");
} catch (error) {
	console.error(error instanceof Error ? error.stack || error.message : error);
	console.error(`temp root preserved for inspection: ${root}`);
	process.exitCode = 1;
}
