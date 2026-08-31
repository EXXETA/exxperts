import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "exxeta-structural-review-write-home-"));
process.env.HOME = tempHome;
process.env.USERPROFILE = tempHome;
const root = fs.mkdtempSync(path.join(os.tmpdir(), "exxeta-structural-review-write-"));
process.env.EXXETA_PERSISTENT_AGENTS_ROOT = root;

const {
	createPersistentAgentFromScaffoldInput,
	fingerprintL1bSource,
	parseStructuralReviewApprovalRequest,
	reviewTargetEstimatedTokensFromL1b,
	writeApprovedStructuralReview,
} = await import("../src/persistent-agents.js");
const { overMemoryBudget, readPersistentRoomMaintenanceSettings } = await import("../src/persistent-room-maintenance-settings.js");

const agentId = "structural-review-write-smoke-room";
const { extractStructuralReviewSourceParts, STRUCTURAL_REVIEW_MODE, STRUCTURAL_REVIEW_SHELF_POINTER_HEADING, STRUCTURAL_REVIEW_WORKER_TYPE, structuralReviewMetrics, structuralReviewShelfPointerLine } = await import("../src/structural-review.js");

const SOURCE_REVIEW_TARGET_SENTINEL = "RAW_SOURCE_REVIEW_TARGET_SENTINEL_STRUCTURAL_SMOKE";
const CANDIDATE_REVIEW_TARGET_SENTINEL = "RAW_CANDIDATE_REVIEW_TARGET_SENTINEL_STRUCTURAL_SMOKE";
const PROPOSAL_TEXT_SENTINEL = "RAW_PROPOSAL_TEXT_SENTINEL_STRUCTURAL_SMOKE";

const agentRoot = path.join(root, agentId);
const agentJsonPath = path.join(agentRoot, "agent.json");
const l1bPath = path.join(agentRoot, "L1b", "current.md");
const archiveDir = path.join(agentRoot, "L1b", "archive");
const structuralReviewEventDir = path.join(agentRoot, "events", "structural-review");

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

function readL1b(): string {
	return fs.readFileSync(l1bPath, "utf-8");
}

function readAgentJson(): any {
	return JSON.parse(fs.readFileSync(agentJsonPath, "utf-8"));
}

function archiveCount(): number {
	return fs.existsSync(archiveDir) ? fs.readdirSync(archiveDir).filter((name) => name.endsWith(".md")).length : 0;
}

function structuralReviewEventCount(): number {
	return fs.existsSync(structuralReviewEventDir) ? fs.readdirSync(structuralReviewEventDir).filter((name) => name.endsWith(".json")).length : 0;
}

function isRelativePath(value: unknown): value is string {
	return typeof value === "string" && value.length > 0 && !path.isAbsolute(value) && !value.split(/[\\/]+/).includes("..");
}

function sourceL1b(): string {
	return `<!-- exxeta:l1b schema_version=1 -->

## Chronos

- Current scaffold timestamp: 2026-05-21T10:00:00.000Z
- Persistent agent id: structural-review-write-smoke-room
- UNIQUE_CHRONOS_SENTINEL_MUST_BE_PRESERVED

## Deep Memory

### Collaboration and Workflow

- The synthetic user prefers scoped GitLab MRs with explicit cleanup steps.
- The synthetic user is learning collaborative Git/GitLab workflows.

### Product Direction

- Persistent-agent memory maintenance should feel calm, lean, and signal-first.
- Duplicate product-direction wording repeats calm, lean, and signal-first memory maintenance.
- Source-only redaction marker: RAW_SOURCE_REVIEW_TARGET_SENTINEL_STRUCTURAL_SMOKE.
- UNIQUE_DEEP_MEMORY_SIGNAL_CAN_CHANGE_ONLY_IN_REVIEW_TARGET

## Active Items

### Current Focus

- Implement MR24 approval-gated Prune memory write semantics.
- Preserve exact split and graft invariants for Chronos and Recent Context.

### Parked

- Revisit shared Maintain workspace polish after Absorb and Prune memory both exist.

## Recent Context

### RC-0001 | OPEN | 2026-05-21 | Smoke context

**Session arc:** This RC entry must survive Prune memory approval exactly.

**Body:**
- UNIQUE_RECENT_CONTEXT_SENTINEL_MUST_BE_PRESERVED

**Parked:**
None.
`;
}

const candidateReviewTarget = `## Deep Memory

### Collaboration and Workflow

- The synthetic user prefers scoped GitLab MRs with explicit cleanup steps and is learning collaborative Git/GitLab workflows.

### Product Direction

- Persistent-agent memory maintenance should feel calm, lean, and signal-first.
- Candidate-only redaction marker: RAW_CANDIDATE_REVIEW_TARGET_SENTINEL_STRUCTURAL_SMOKE.
- UNIQUE_DEEP_MEMORY_SIGNAL_CAN_CHANGE_ONLY_IN_REVIEW_TARGET

## Active Items

### Current Focus

- Implement MR24 approval-gated Prune memory write semantics while preserving exact split/graft invariants.

### Parked

- Revisit shared Maintain workspace polish after Absorb and Prune memory both exist.
`;

function proposal(source = readL1b(), candidate = candidateReviewTarget) {
	const parts = extractStructuralReviewSourceParts(source);
	return {
		agentId: agentId,
		writesMemory: false,
		process: {
			type: STRUCTURAL_REVIEW_WORKER_TYPE,
			mode: STRUCTURAL_REVIEW_MODE,
			model: { provider: "openai-codex", model: "gpt-5.5", label: "GPT-5.5" },
		},
		source: {
			l1bFingerprint: fingerprintL1bSource(source),
			reviewTargetFingerprint: fingerprintL1bSource(parts.sourceReviewTargetL1b),
			chronosFingerprint: fingerprintL1bSource(parts.preservedChronos),
			recentContextFingerprint: fingerprintL1bSource(parts.preservedRecentContext),
			generatedAt: "2026-05-21T20:00:00.000Z",
		},
		fields: {
			summary: "Tighten durable workflow/product signal and current MR24 focus.",
			candidateReviewTargetL1b: candidate,
		},
		review: {
			metrics: {
				reviewTargetWordsBefore: 80,
				reviewTargetWordsAfter: 60,
				reviewTargetEstimatedTokensBefore: 120,
				reviewTargetEstimatedTokensAfter: 90,
				reviewTargetEstimatedTokenDelta: -30,
			},
		},
		structuralReviewTelemetry: {
			chars: parts.sourceReviewTargetL1b.length,
			bytes: Buffer.byteLength(parts.sourceReviewTargetL1b, "utf-8"),
			words: 80,
			estimatedTokens: 120,
			promptChars: 4000,
			promptEstimatedTokens: 1000,
			sectionDescriptionCount: 4,
			diagnosticHash: fingerprintL1bSource("structural telemetry hash fixture"),
			memoryMap: [{ area: "Deep Memory", words: 50, estimatedTokens: 75 }],
			rawPromptPreview: PROPOSAL_TEXT_SENTINEL,
		},
		structuralReviewUsage: {
			input: 444,
			output: 555,
			cacheRead: 66,
			cacheWrite: 77,
			totalTokens: 999,
			cost: 0.0456,
			rawProviderPayload: PROPOSAL_TEXT_SENTINEL,
		},
		rawProposalMarkdown: `Proposal body must not leak: ${PROPOSAL_TEXT_SENTINEL}`,
	};
}

function structuralReviewRequest(candidate = candidateReviewTarget, source = readL1b()) {
	return parseStructuralReviewApprovalRequest({ proposal: proposal(source, candidate) }, agentId);
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

function expectNoMutation(expectedL1b: string, expectedArchiveCount: number, expectedEventCount: number, label: string): void {
	assert(readL1b() === expectedL1b, `${label}: rejected approval must not rewrite L1b/current.md`);
	assert(archiveCount() === expectedArchiveCount, `${label}: rejected approval must not create archive`);
	assert(structuralReviewEventCount() === expectedEventCount, `${label}: rejected approval must not create event record`);
}

try {
	createPersistentAgentFromScaffoldInput({
		displayName: "Structural Review Write Smoke Room",
		userName: "Synthetic User",
		preferredUserAddress: "Synthetic User",
	});
	fs.writeFileSync(l1bPath, sourceL1b(), "utf-8");
	assert(fs.existsSync(l1bPath), "scaffold should create L1b/current.md");
	assert(archiveCount() === 0, "fresh scaffold should have no archives");
	assert(structuralReviewEventCount() === 0, "fresh scaffold should have no structural-review event records");

	const sourceBeforeApproval = readL1b();
	const partsBeforeApproval = extractStructuralReviewSourceParts(sourceBeforeApproval);
	const metaBeforeApproval = readAgentJson();
	// Budget-staleness guard (slice 3), same as the Memorize twin: an echoed
	// budget that no longer matches settings (default 20k) stales pre-write.
	expectThrows(
		() => writeApprovedStructuralReview(parseStructuralReviewApprovalRequest({ proposal: { ...proposal(readL1b(), candidateReviewTarget), memoryBudgetImpact: { budgetTokens: 12_345, reviewTargetEstimatedTokensBefore: 1, reviewTargetEstimatedTokensAfter: 1, overBudgetBefore: false, overBudgetAfter: false } } }, agentId).request, [], new Date("2026-05-21T19:59:00.000Z")),
		// The full prefix is load-bearing: the client's stale flow keys on
		// "proposal is stale" and its cause copy on "memory budget changed".
		/proposal is stale: memory budget changed/,
		"a budget edited between propose and approve should stale the proposal",
	);
	expectNoMutation(sourceBeforeApproval, 0, 0, "budget-stale rejection");
	const parsed = structuralReviewRequest();
	const result = writeApprovedStructuralReview(parsed.request, parsed.warnings, new Date("2026-05-21T20:00:00.000Z"));
	const approvedL1b = readL1b();
	const partsAfterApproval = extractStructuralReviewSourceParts(approvedL1b);
	const metaAfterApproval = readAgentJson();

	assert(result.writesMemory === true, "structural review approval should report memory write");
	assert(result.structuralReviewId.startsWith("structural_review_"), "structural review approval should return structuralReviewId");
	assert(result.eventRecordPath === path.join(structuralReviewEventDir, `${result.structuralReviewId}.json`), "approval should return canonical structural-review event path");
	assert(fs.existsSync(result.eventRecordPath), "structural-review event record should exist");
	assert(archiveCount() === 1, "structural review approval should archive previous L1b");
	assert(fs.readFileSync(result.archivedL1bPath, "utf-8") === sourceBeforeApproval, "archive should contain pre-approval L1b");
	assert(metaAfterApproval.updatedAt === new Date("2026-05-21T20:00:00.000Z").getTime(), "approval should update agent.json.updatedAt");
	assert(metaAfterApproval.updatedAt !== metaBeforeApproval.updatedAt, "approval should change updatedAt");
	assert(partsAfterApproval.preservedChronos === partsBeforeApproval.preservedChronos, "approval must preserve Chronos exactly");
	assert(partsAfterApproval.preservedRecentContext === partsBeforeApproval.preservedRecentContext, "approval must preserve Recent Context exactly");
	assert(partsAfterApproval.sourceReviewTargetL1b === candidateReviewTarget.trimEnd() + "\n", "approval should graft approved candidate review target");
	assert(approvedL1b.includes("UNIQUE_CHRONOS_SENTINEL_MUST_BE_PRESERVED"), "approved L1b should retain Chronos sentinel");
	assert(approvedL1b.includes("UNIQUE_RECENT_CONTEXT_SENTINEL_MUST_BE_PRESERVED"), "approved L1b should retain Recent Context sentinel");
	assert(/^## Chronos\n[\s\S]*^## Deep Memory\n[\s\S]*^## Active Items\n[\s\S]*^## Recent Context/m.test(approvedL1b), "approved L1b should preserve mandatory topology/order");

	const eventRecord = JSON.parse(fs.readFileSync(result.eventRecordPath, "utf-8"));
	assert(eventRecord.schemaVersion === 1, "structural-review event should use schema version 1");
	// Slice 4: the record carries the after-write budget verdict through the
	// ONE numerator, measured from the WRITTEN file — the previous-partial
	// escalation reads this, so it must equal what the saved screen showed.
	const recordBudget = readPersistentRoomMaintenanceSettings(agentId).memoryBudgetTokens;
	assert(eventRecord.memoryBudget?.budgetTokens === recordBudget, "structural-review event should record the budget in force at write time");
	assert(eventRecord.memoryBudget?.reviewTargetEstimatedTokens === reviewTargetEstimatedTokensFromL1b(fs.readFileSync(l1bPath, "utf-8")), "structural-review event budget tokens must come from the ONE numerator over the written L1b");
	assert(eventRecord.memoryBudget?.overBudget === overMemoryBudget(eventRecord.memoryBudget.reviewTargetEstimatedTokens, recordBudget), "structural-review event budget verdict must be the one predicate");
	assert(eventRecord.operation === "structural_review", "structural-review event should identify operation");
	assert(eventRecord.mode === "stc_diagnostic", "structural-review event should identify mode");
	assert(eventRecord.agentId === agentId, "structural-review event should include agent id");
	assert(eventRecord.structuralReviewId === result.structuralReviewId, "structural-review event should match response id");
	assert(eventRecord.approvedAt === "2026-05-21T20:00:00.000Z", "structural-review event should include approval timestamp");
	assert(eventRecord.archivedL1bPath == null, "new structural-review event should not persist top-level archive path");
	assert(eventRecord.updatedL1bPath == null, "new structural-review event should not persist top-level updated L1b path");
	assert(result.eventRelPath === `events/structural-review/${result.structuralReviewId}.json`, "structural review approval should return canonical relative event path");
	assert(eventRecord.mutation?.target === "l1b", "structural-review event mutation should target L1b");
	assert(eventRecord.mutation?.kind === "stable_memory_restructure_prune", "structural-review event mutation should identify stable-memory restructure/prune");
	assert(eventRecord.mutation.sectionsAffected.includes("Deep Memory"), "structural-review event should mark Deep Memory affected");
	assert(eventRecord.mutation.sectionsAffected.includes("Active Items"), "structural-review event should mark Active Items affected");
	assert(eventRecord.mutation.sectionsPreserved.includes("Chronos"), "structural-review event should mark Chronos preserved");
	assert(eventRecord.mutation.sectionsPreserved.includes("Recent Context"), "structural-review event should mark Recent Context preserved");
	assert(isRelativePath(eventRecord.paths?.archivedL1bRelPath), "structural-review archive path in event should be relative");
	assert(isRelativePath(eventRecord.paths?.updatedL1bRelPath), "structural-review updated L1b path in event should be relative");
	assert(isRelativePath(eventRecord.paths?.eventRelPath), "structural-review event path in event should be relative");
	assert(eventRecord.paths.archivedL1bRelPath === path.relative(agentRoot, result.archivedL1bPath).split(path.sep).join("/"), "structural-review event archive path should be agent-root relative");
	assert(eventRecord.paths.updatedL1bRelPath === "L1b/current.md", "structural-review event updated L1b path should be agent-root relative");
	assert(eventRecord.paths.eventRelPath === result.eventRelPath, "structural-review event relative path should match response relative path");
	assert(eventRecord.process?.type === STRUCTURAL_REVIEW_WORKER_TYPE, "structural-review event should include proposal-time worker type");
	assert(eventRecord.process?.mode === STRUCTURAL_REVIEW_MODE, "structural-review event should include process mode");
	assert(eventRecord.process?.source === "proposal_time", "structural-review event process should identify proposal-time source");
	assert(eventRecord.process?.model?.provider === "openai-codex", "structural-review event should copy proposal model provider");
	assert(eventRecord.process?.model?.model === "gpt-5.5", "structural-review event should copy proposal model id");
	assert(eventRecord.process?.model?.label === "GPT-5.5", "structural-review event should copy proposal model label");
	assert(eventRecord.proposal?.generatedAt === "2026-05-21T20:00:00.000Z", "structural-review event should copy proposal generation timestamp");
	assert(eventRecord.proposal?.sourceL1bFingerprint?.value === fingerprintL1bSource(sourceBeforeApproval).value, "structural-review event should copy source L1b fingerprint");
	assert(eventRecord.proposal?.reviewTargetFingerprint?.value === fingerprintL1bSource(partsBeforeApproval.sourceReviewTargetL1b).value, "structural-review event should copy review-target fingerprint");
	assert(eventRecord.proposal?.telemetry?.promptChars === 4000, "structural-review event should copy numeric proposal telemetry");
	assert(eventRecord.proposal?.telemetry?.promptEstimatedTokens === 1000, "structural-review event should copy numeric token telemetry");
	assert(eventRecord.proposal?.telemetry?.diagnosticHash?.algorithm === "sha256", "structural-review event should copy hash-shaped telemetry");
	assert(Array.isArray(eventRecord.proposal?.telemetry?.memoryMap), "structural-review event should preserve sanitized numeric telemetry arrays");
	assert(eventRecord.proposal.telemetry.memoryMap[0].words === 50, "structural-review event should keep numeric nested telemetry");
	assert(eventRecord.proposal.telemetry.memoryMap[0].area == null, "structural-review event should omit text nested telemetry");
	assert(eventRecord.proposal?.telemetry?.rawPromptPreview == null, "structural-review event should omit raw telemetry text");
	assert(eventRecord.proposal?.usage?.input === 444, "structural-review event should copy numeric usage input");
	assert(eventRecord.proposal?.usage?.output === 555, "structural-review event should copy numeric usage output");
	assert(eventRecord.proposal?.usage?.cacheRead === 66, "structural-review event should copy numeric usage cacheRead");
	assert(eventRecord.proposal?.usage?.cacheWrite === 77, "structural-review event should copy numeric usage cacheWrite");
	assert(eventRecord.proposal?.usage?.totalTokens === 999, "structural-review event should copy numeric usage totalTokens");
	assert(eventRecord.proposal?.usage?.cost === 0.0456, "structural-review event should copy numeric usage cost");
	assert(eventRecord.proposal?.usage?.rawProviderPayload == null, "structural-review event should omit raw usage payloads");
	assert(eventRecord.source.l1bFingerprint.value === fingerprintL1bSource(sourceBeforeApproval).value, "event should capture source full L1b fingerprint");
	assert(eventRecord.source.reviewTargetFingerprint.value === fingerprintL1bSource(partsBeforeApproval.sourceReviewTargetL1b).value, "event should capture source review target fingerprint");
	assert(eventRecord.source.chronosFingerprint.value === fingerprintL1bSource(partsBeforeApproval.preservedChronos).value, "event should capture source Chronos fingerprint");
	assert(eventRecord.source.recentContextFingerprint.value === fingerprintL1bSource(partsBeforeApproval.preservedRecentContext).value, "event should capture source Recent Context fingerprint");
	assert(eventRecord.result.l1bFingerprint.value === fingerprintL1bSource(approvedL1b).value, "event should capture result full L1b fingerprint");
	assert(eventRecord.result.reviewTargetFingerprint.value === fingerprintL1bSource(partsAfterApproval.sourceReviewTargetL1b).value, "event should capture result review target fingerprint");
	assert(eventRecord.result.chronosFingerprint.value === eventRecord.source.chronosFingerprint.value, "event should show Chronos fingerprint preserved");
	assert(eventRecord.result.recentContextFingerprint.value === eventRecord.source.recentContextFingerprint.value, "event should show Recent Context fingerprint preserved");
	assert(eventRecord.metrics.reviewTargetEstimatedTokensAfter <= eventRecord.metrics.reviewTargetEstimatedTokensBefore, "event metrics should capture pruning token delta");
	assert(eventRecord.structuralReview?.reviewTargetWordsBefore === eventRecord.metrics.reviewTargetWordsBefore, "structural-review summary should mirror review words before");
	assert(eventRecord.structuralReview?.reviewTargetWordsAfter === eventRecord.metrics.reviewTargetWordsAfter, "structural-review summary should mirror review words after");
	assert(eventRecord.structuralReview?.reviewTargetEstimatedTokensBefore === eventRecord.metrics.reviewTargetEstimatedTokensBefore, "structural-review summary should mirror tokens before");
	assert(eventRecord.structuralReview?.reviewTargetEstimatedTokensAfter === eventRecord.metrics.reviewTargetEstimatedTokensAfter, "structural-review summary should mirror tokens after");
	assert(eventRecord.structuralReview?.reviewTargetEstimatedTokenDelta === eventRecord.metrics.reviewTargetEstimatedTokenDelta, "structural-review summary should mirror token delta");
	assert(typeof eventRecord.structuralReview?.stableMemoryBytesBefore === "number", "structural-review summary should include stable memory bytes before");
	assert(typeof eventRecord.structuralReview?.stableMemoryBytesAfter === "number", "structural-review summary should include stable memory bytes after");
	assert(typeof eventRecord.structuralReview?.stableMemoryDeltaBytes === "number", "structural-review summary should include stable memory byte delta");
	assert(eventRecord.structuralReview.stableMemoryDeltaBytes === eventRecord.structuralReview.stableMemoryBytesAfter - eventRecord.structuralReview.stableMemoryBytesBefore, "structural-review stable byte delta should be derived");
	assert(eventRecord.structuralReview.chronosPreserved === true, "structural-review summary should mark Chronos preserved");
	assert(eventRecord.structuralReview.recentContextPreserved === true, "structural-review summary should mark Recent Context preserved");
	assert(eventRecord.structuralReview.recentContextEntryCountBefore === 1, "structural-review summary should capture RC count before");
	assert(eventRecord.structuralReview.recentContextEntryCountAfter === 1, "structural-review summary should capture unchanged RC count after");
	assert(eventRecord.validation.valid === true, "event should capture validation success");
	assert(Array.isArray(eventRecord.validation.warnings), "event should capture validation warnings");
	const serializedEvent = JSON.stringify(eventRecord);
	assert(!serializedEvent.includes(root), "structural-review event JSON should not include temp persistent-agents root");
	assert(!serializedEvent.includes(agentRoot), "structural-review event JSON should not include default agent absolute root");
	assert(!serializedEvent.includes(SOURCE_REVIEW_TARGET_SENTINEL), "structural-review event JSON should not include raw source review-target sentinel");
	assert(!serializedEvent.includes(CANDIDATE_REVIEW_TARGET_SENTINEL), "structural-review event JSON should not include raw candidate review-target sentinel");
	assert(!serializedEvent.includes(PROPOSAL_TEXT_SENTINEL), "structural-review event JSON should not include raw proposal text sentinel");
	assert(!serializedEvent.includes("UNIQUE_CHRONOS_SENTINEL_MUST_BE_PRESERVED"), "structural-review event JSON should not include raw Chronos sentinel");
	assert(!serializedEvent.includes("UNIQUE_RECENT_CONTEXT_SENTINEL_MUST_BE_PRESERVED"), "structural-review event JSON should not include raw Recent Context sentinel");

	fs.writeFileSync(l1bPath, sourceL1b(), "utf-8");
	const baselineL1b = readL1b();
	const baselineArchiveCount = archiveCount();
	const baselineEventCount = structuralReviewEventCount();

	const staleParsed = structuralReviewRequest();
	fs.writeFileSync(l1bPath, baselineL1b.replace("MR24 approval-gated", "MR24 stale-source approval-gated"), "utf-8");
	expectThrows(
		() => writeApprovedStructuralReview(staleParsed.request, staleParsed.warnings, new Date("2026-05-21T20:01:00.000Z")),
		/source L1b fingerprint changed/,
		"stale full L1b fingerprint should reject before archive/write",
	);
	expectNoMutation(readL1b(), baselineArchiveCount, baselineEventCount, "stale full L1b fingerprint");

	fs.writeFileSync(l1bPath, baselineL1b, "utf-8");
	const reviewTargetStale = structuralReviewRequest();
	reviewTargetStale.request.proposal.source!.reviewTargetFingerprint = fingerprintL1bSource("stale review target");
	expectThrows(
		() => writeApprovedStructuralReview(reviewTargetStale.request, reviewTargetStale.warnings, new Date("2026-05-21T20:02:00.000Z")),
		/source review target fingerprint changed/,
		"stale review target fingerprint should reject before archive/write",
	);
	expectNoMutation(baselineL1b, baselineArchiveCount, baselineEventCount, "stale review target fingerprint");

	const chronosStale = structuralReviewRequest();
	chronosStale.request.proposal.source!.chronosFingerprint = fingerprintL1bSource("stale chronos");
	expectThrows(
		() => writeApprovedStructuralReview(chronosStale.request, chronosStale.warnings, new Date("2026-05-21T20:03:00.000Z")),
		/source Chronos fingerprint changed/,
		"stale Chronos fingerprint should reject before archive/write",
	);
	expectNoMutation(baselineL1b, baselineArchiveCount, baselineEventCount, "stale Chronos fingerprint");

	const recentContextStale = structuralReviewRequest();
	recentContextStale.request.proposal.source!.recentContextFingerprint = fingerprintL1bSource("stale recent context");
	expectThrows(
		() => writeApprovedStructuralReview(recentContextStale.request, recentContextStale.warnings, new Date("2026-05-21T20:04:00.000Z")),
		/source Recent Context fingerprint changed/,
		"stale Recent Context fingerprint should reject before archive/write",
	);
	expectNoMutation(baselineL1b, baselineArchiveCount, baselineEventCount, "stale Recent Context fingerprint");

	expectThrows(
		() => writeApprovedStructuralReview(structuralReviewRequest(`${candidateReviewTarget}\n\n## Chronos\n\nTampered chronos\n`).request, [], new Date("2026-05-21T20:05:00.000Z")),
		/exactly Deep Memory and Active Items|must not include Chronos/,
		"candidate with Chronos top-level section should reject before archive/write",
	);
	expectNoMutation(baselineL1b, baselineArchiveCount, baselineEventCount, "candidate with Chronos");

	expectThrows(
		() => writeApprovedStructuralReview(structuralReviewRequest(`${candidateReviewTarget}\n\n## Recent Context\n\nTampered recent context\n`).request, [], new Date("2026-05-21T20:06:00.000Z")),
		/exactly Deep Memory and Active Items|must not include Recent Context/,
		"candidate with Recent Context top-level section should reject before archive/write",
	);
	expectNoMutation(baselineL1b, baselineArchiveCount, baselineEventCount, "candidate with Recent Context");

	expectThrows(
		() => writeApprovedStructuralReview(structuralReviewRequest(`${candidateReviewTarget}\n\n## Optional Memory\n\nExtra top-level section\n`).request, [], new Date("2026-05-21T20:07:00.000Z")),
		/exactly Deep Memory and Active Items/,
		"candidate with extra top-level section should reject before archive/write",
	);
	expectNoMutation(baselineL1b, baselineArchiveCount, baselineEventCount, "candidate with extra top-level section");

	// Slice 5 (G2): a Dropped material section emitted after the candidate is
	// swallowed into it by the extractor and must reject at approve — it would
	// otherwise be written into memory as candidate content.
	expectThrows(
		() => writeApprovedStructuralReview(structuralReviewRequest(`${candidateReviewTarget}\n\n### Dropped material\n\n- Swallowed drop list\n`).request, [], new Date("2026-05-21T20:09:00.000Z")),
		/must not contain a Dropped material section/,
		"candidate with a swallowed Dropped material section should reject before archive/write",
	);
	expectNoMutation(baselineL1b, baselineArchiveCount, baselineEventCount, "candidate with swallowed Dropped material section");

	const bloatedCandidate = `## Deep Memory\n\n### Bloated\n\n- ${"This candidate intentionally grows stable memory far beyond the source review target. ".repeat(120)}\n\n## Active Items\n\n### Current Focus\n\n- Keep MR24 focused.\n`;
	expectThrows(
		() => writeApprovedStructuralReview(structuralReviewRequest(bloatedCandidate).request, [], new Date("2026-05-21T20:08:00.000Z")),
		/token growth exceeds Structural Review hard limit/,
		"candidate above token growth hard limit should reject before archive/write",
	);
	expectNoMutation(baselineL1b, baselineArchiveCount, baselineEventCount, "candidate above token growth hard limit");

	// Slice 7: forget-to-document. An approval with the flag writes the dropped
	// material to the room's Files BEFORE memory mutates, appends a pointer line
	// at the end of Deep Memory, and records both in the event record.
	assert(result.forgetToDocument === undefined, "an approval without the flag should export nothing");
	assert(eventRecord.droppedMaterial === undefined, "an approval whose proposal omitted Dropped material should not fabricate one in the event record");
	const shelfDir = path.join(agentRoot, "files");
	const ftdCandidate = `## Deep Memory\n\n### Collaboration and Workflow\n\n- The synthetic user prefers scoped GitLab MRs with explicit cleanup steps and is learning collaborative Git/GitLab workflows.\n\n## Active Items\n\n### Current Focus\n\n- Implement MR24 approval-gated Prune memory write semantics.\n`;
	const ftdBase = proposal(readL1b(), ftdCandidate);
	const ftdProposal = { ...ftdBase, fields: { ...ftdBase.fields, droppedMaterial: "- Product Direction (whole area) — duplicated wording, superseded.\n- Parked — resolved.", sectionLevelChangeLog: "| Section | Prior Tokens | Candidate Tokens | Disposition | Rationale |\n|---|---:|---:|---|---|\n| Deep Memory / Product Direction | 40 | 0 | Dropped | superseded |" } };
	const ftdParsed = parseStructuralReviewApprovalRequest({ proposal: ftdProposal, forgetToDocument: true }, agentId);
	assert(ftdParsed.request.forgetToDocument === true, "approval parser should carry the forget-to-document flag");
	const ftdResult = writeApprovedStructuralReview(ftdParsed.request, ftdParsed.warnings, new Date("2026-08-27T12:00:00.000Z"));
	assert(ftdResult.forgetToDocument?.shelfFileName === "Pruned memory 2026-08-27.md", "approval should return the allocated shelf filename");
	const shelfDocPath = path.join(shelfDir, ftdResult.forgetToDocument!.shelfFileName);
	assert(fs.existsSync(shelfDocPath), "the dropped-material document should be in the room's Files");
	const shelfDoc = fs.readFileSync(shelfDocPath, "utf-8");
	assert(shelfDoc.includes(`Prune id: ${ftdResult.structuralReviewId}`), "the document should carry the Prune id");
	assert(shelfDoc.includes("Deep Memory / Product Direction") && shelfDoc.includes(SOURCE_REVIEW_TARGET_SENTINEL), "the document should carry the vanished area's full source text");
	assert(shelfDoc.includes("Active Items / Parked"), "the document should carry every vanished area");
	assert(shelfDoc.includes("Product Direction (whole area) — duplicated wording, superseded."), "the document should carry the approved disclosure verbatim");
	assert(!/happened on/i.test(shelfDoc), "the document must never say 'happened on'");
	const ftdL1b = readL1b();
	const pointerLine = structuralReviewShelfPointerLine("Pruned memory 2026-08-27.md", new Date("2026-08-27T12:00:00.000Z"));
	assert(pointerLine.includes("(saved 2026-08-27)") && pointerLine.includes('"Pruned memory 2026-08-27.md"'), "smoke setup: the real pointer line names the saved-on date and the file");
	assert(ftdL1b.includes(pointerLine), "memory should carry the pointer line naming the file");
	const pointerHeading = `### ${STRUCTURAL_REVIEW_SHELF_POINTER_HEADING}`;
	assert(ftdL1b.indexOf(pointerHeading) > 0 && ftdL1b.indexOf(pointerHeading) < ftdL1b.indexOf(pointerLine) && ftdL1b.indexOf(pointerLine) < ftdL1b.indexOf("## Active Items"), "the pointer line should sit under its own must-keep subsection at the end of Deep Memory (M1)");
	const ftdEvent = JSON.parse(fs.readFileSync(ftdResult.eventRecordPath, "utf-8"));
	assert(ftdEvent.forgetToDocument?.shelfFileName === "Pruned memory 2026-08-27.md", "the event record should name the shelf file");
	assert(typeof ftdEvent.droppedMaterial === "string" && ftdEvent.droppedMaterial.includes("Product Direction"), "the event record should persist the Dropped material disclosure");
	// The response's budget verdict is measured from the WRITTEN file — pointer
	// line included — through the ONE numerator, so the saved screen can never
	// disagree with the event record on over/under.
	assert(ftdResult.memoryBudget?.reviewTargetEstimatedTokens === reviewTargetEstimatedTokensFromL1b(readL1b()), "approval response budget tokens must come from the ONE numerator over the written L1b");
	assert(ftdResult.memoryBudget?.overBudget === overMemoryBudget(ftdResult.memoryBudget.reviewTargetEstimatedTokens, ftdResult.memoryBudget.budgetTokens), "approval response budget verdict must be the one predicate");
	assert(JSON.stringify(ftdResult.memoryBudget) === JSON.stringify(ftdEvent.memoryBudget), "response and event record must carry the same written-file budget verdict");
	// The written delta includes the pointer line: it must equal the event
	// record's (both from the pointered review) and exceed the pointer-free one.
	assert(ftdResult.reviewTargetEstimatedTokenDelta === ftdEvent.structuralReview?.reviewTargetEstimatedTokenDelta, "response delta must be the written (pointered) delta the event record carries");
	assert(ftdResult.reviewTargetEstimatedTokenDelta! > structuralReviewMetrics(ftdCandidate).estimatedTokens - structuralReviewMetrics(extractStructuralReviewSourceParts(sourceL1b()).sourceReviewTargetL1b).estimatedTokens, "the written delta must include the pointer line's tokens");
	// Growth warnings judge the draft, not the opt-in pointer: this candidate
	// shrinks memory, so no growth warning may blame it; the pointer's cost is
	// its own disclosed line, in the response and the event record.
	assert(!ftdResult.warnings.some((warning) => /grows review-target|larger than source/.test(warning)), `a shrinking draft must not be blamed for the pointer's growth: ${ftdResult.warnings.join(" | ")}`);
	const pointerNote = ftdResult.warnings.find((warning) => /added a pointer line of ~\d+ estimated tokens to Deep Memory/.test(warning));
	assert(pointerNote, `the pointer's token cost should be disclosed as its own line: ${ftdResult.warnings.join(" | ")}`);
	assert(!/~0 estimated/.test(pointerNote!), "the pointer's cost must be the line's own estimate, never ~0 for a line that is there");
	assert(ftdEvent.warnings.includes(pointerNote!), "the event record should carry the pointer-cost line too");
	assert(result.warnings.every((warning) => !/pointer line/.test(warning)), "an approval without the flag carries no pointer-cost line");

	// A failed shelf write fails the approval cleanly: no archive, no event
	// record, no memory mutation — and the error speaks product words.
	fs.writeFileSync(l1bPath, sourceL1b(), "utf-8");
	const preFailL1b = readL1b();
	const preFailArchive = archiveCount();
	const preFailEvents = structuralReviewEventCount();
	fs.rmSync(shelfDir, { recursive: true, force: true });
	fs.writeFileSync(shelfDir, "not a directory", "utf-8");
	expectThrows(
		() => writeApprovedStructuralReview(parseStructuralReviewApprovalRequest({ proposal: proposal(readL1b(), ftdCandidate), forgetToDocument: true }, agentId).request, [], new Date("2026-08-27T12:30:00.000Z")),
		/could not be saved to this room's Files[\s\S]*No memory was changed/,
		"a failed shelf write should fail the approval with product wording and a reachable action",
	);
	// The browser never sees the filesystem detail: no errno, no server path.
	try {
		writeApprovedStructuralReview(parseStructuralReviewApprovalRequest({ proposal: proposal(readL1b(), ftdCandidate), forgetToDocument: true }, agentId).request, [], new Date("2026-08-27T12:31:00.000Z"));
		throw new Error("shelf failure should throw");
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		assert(!/E[A-Z]{3,}|ENOTDIR|EACCES/.test(message) && !message.includes(root) && !message.includes(shelfDir), `shelf-failure copy must not leak errno or server paths: ${message}`);
	}
	expectNoMutation(preFailL1b, preFailArchive, preFailEvents, "failed forget-to-document shelf write");
	fs.rmSync(shelfDir, { force: true });

	// The pointer-tipped growth refusal: scanned against the REAL approval path
	// (no local copy of the 5% predicate) from clearly-over downward — the
	// window where the pointer line alone tips the limit must exist, carry the
	// load-bearing substring the client keys on, and leave nothing behind.
	fs.writeFileSync(l1bPath, sourceL1b(), "utf-8");
	const tippedBaseline = readL1b();
	const tippedArchive = archiveCount();
	const tippedEvents = structuralReviewEventCount();
	let sawPlainReject = false;
	let tippedMessage: string | null = null;
	for (let pad = 1600; pad >= 0 && tippedMessage == null; pad -= 16) {
		const cand = `## Deep Memory\n\n### Collaboration and Workflow\n\n- ${"x".repeat(400 + pad)}\n\n## Active Items\n\n### Current Focus\n\n- Keep MR24 focused.\n`;
		const candBase = proposal(readL1b(), cand);
		const candProposal = { ...candBase, fields: { ...candBase.fields, droppedMaterial: "- Product Direction — superseded." } };
		try {
			writeApprovedStructuralReview(parseStructuralReviewApprovalRequest({ proposal: candProposal, forgetToDocument: true }, agentId).request, [], new Date("2026-08-27T13:00:00.000Z"));
			break;
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			if (/Files pointer line tipped it over/.test(message)) { tippedMessage = message; break; }
			assert(/token growth exceeds/.test(message), `pad scan hit an unexpected error: ${message}`);
			sawPlainReject = true;
		}
	}
	assert(sawPlainReject && tippedMessage, "the pad scan should pass through plain growth rejects and reach the pointer-tipped window before any approval succeeds");
	assert(/Approve without saving dropped material to Files/.test(tippedMessage!), "the pointer-tipped refusal should name the real lever");
	expectNoMutation(tippedBaseline, tippedArchive, tippedEvents, "pointer-tipped growth refusal");
	assert(!fs.existsSync(shelfDir) || fs.readdirSync(shelfDir).length === 0, "the pointer-tipped refusal must remove the shelf document again");

	// A failure AFTER the memory write (audit record unwritable): the approval
	// SUCCEEDS — memory, archive and the export stay, consistent — and the
	// record failure is a disclosed warning, never a thrown "not applied".
	// The unwritable-directory fixture is POSIX-only: Windows' read-only bit
	// does not stop file creation inside a directory, so there the write just
	// succeeds and there is nothing to disclose — skip alongside the root case.
	if (process.platform !== "win32" && process.getuid?.() !== 0) {
		fs.writeFileSync(l1bPath, sourceL1b(), "utf-8");
		const postArchive = archiveCount();
		const postEvents = structuralReviewEventCount();
		fs.mkdirSync(structuralReviewEventDir, { recursive: true });
		fs.chmodSync(structuralReviewEventDir, 0o500);
		let postWriteResult;
		try {
			postWriteResult = writeApprovedStructuralReview(parseStructuralReviewApprovalRequest({ proposal: { ...proposal(readL1b(), ftdCandidate), fields: ftdProposal.fields }, forgetToDocument: true }, agentId).request, [], new Date("2026-08-27T14:00:00.000Z"));
		} finally {
			fs.chmodSync(structuralReviewEventDir, 0o700);
		}
		assert(postWriteResult.writesMemory === true && postWriteResult.forgetToDocument?.shelfFileName, "a post-write record failure must still report a successful approval with its export");
		const recordWarning = postWriteResult.warnings.find((warning) => /^Memory was updated and the previous memory archived first, but this Review's audit record could not be written/.test(warning));
		assert(recordWarning, `the audit-record failure should be a disclosed warning: ${postWriteResult.warnings.join(" | ")}`);
		assert(!postWriteResult.warnings.some((warning) => /room record/.test(warning)), "an audit-record failure must not also claim the room record failed");
		assert(postWriteResult.auditRecordWritten === false, "the response must flag the unwritten audit record structurally, not only in copy");
		assert(/memory history/.test(recordWarning!) && /archived snapshot/.test(recordWarning!), "the audit-record warning should name every surface that loses this Review");
		assert(ftdResult.auditRecordWritten === true && result.auditRecordWritten === true, "successful approvals flag the audit record as written");
		assert(structuralReviewEventCount() === postEvents, "the audit record is genuinely absent after the failure");
		assert(readL1b().includes(`### ${STRUCTURAL_REVIEW_SHELF_POINTER_HEADING}`) && readL1b().includes("(saved 2026-08-27)"), "after a post-write failure the written memory (with its pointer) stays");
		assert(archiveCount() === postArchive + 1, "after a post-write failure the archive stays");
		assert(fs.existsSync(path.join(shelfDir, postWriteResult.forgetToDocument!.shelfFileName)), "after a post-write failure the shelf document stays — file and pointer remain consistent");
		assert(readAgentJson().updatedAt === new Date("2026-08-27T14:00:00.000Z").getTime(), "the room record step still ran independently of the audit-record failure");
	}

	fs.rmSync(root, { recursive: true, force: true });
	console.log("structural review write smoke passed");
} catch (error) {
	console.error(error instanceof Error ? error.stack || error.message : error);
	console.error(`temp root preserved for inspection: ${root}`);
	process.exitCode = 1;
}
