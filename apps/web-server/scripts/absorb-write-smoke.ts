import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "exxeta-absorb-write-home-"));
process.env.HOME = tempHome;
process.env.USERPROFILE = tempHome;
const smokeAppDir = path.join(tempHome, ".exxperts", "app");
fs.mkdirSync(smokeAppDir, { recursive: true });
fs.writeFileSync(
	path.join(smokeAppDir, "openai-compatible-ai-profile.json"),
	JSON.stringify({ profileId: "openai-compatible", providerId: "openai-compatible", label: "Synthetic Gateway", roomModels: [{ modelId: "gpt-5.5" }, { modelId: "claude-opus-4.6" }], maintenanceModel: "claude-opus-4.6" }, null, 2),
);
fs.writeFileSync(path.join(smokeAppDir, "persistent-agent-ai-profile.json"), JSON.stringify({ profileId: "openai-compatible" }, null, 2));
const root = fs.mkdtempSync(path.join(os.tmpdir(), "exxeta-absorb-write-"));
process.env.EXXETA_PERSISTENT_AGENTS_ROOT = root;

const {
	buildPersistentAgentCheckpointTranscriptSource,
	createPersistentAgentFromScaffoldInput,
	fingerprintL1bSource,
	getPersistentAgentStatus,
	parseAbsorbApprovalRequest,
	parseCheckpointApprovalRequest,
	reviewTargetEstimatedTokensFromL1b,
	writeApprovedAbsorb,
	writeApprovedCheckpoint,
	writePersistentAgentThread,
} = await import("../src/persistent-agents.js");
const { overMemoryBudget } = await import("../src/persistent-room-maintenance-settings.js");

const agentId = "absorb-write-smoke-room";
const { ABSORB_CONSOLIDATION_WORKER_TYPE, ABSORB_EMPTY_RECENT_CONTEXT_PLACEHOLDER, extractTopLevelSectionBody } = await import("../src/absorb-consolidation.js");

const SOURCE_L1B_SENTINEL = "RAW_SOURCE_L1B_SENTINEL_ABSORB_SMOKE";
const CANDIDATE_L1B_SENTINEL = "RAW_CANDIDATE_L1B_SENTINEL_ABSORB_SMOKE";
const PROPOSAL_TEXT_SENTINEL = "RAW_PROPOSAL_TEXT_SENTINEL_ABSORB_SMOKE";

const agentRoot = path.join(root, agentId);
const l1bPath = path.join(agentRoot, "L1b", "current.md");
const archiveDir = path.join(agentRoot, "L1b", "archive");
const absorbEventDir = path.join(agentRoot, "events", "absorb");

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

function readL1b(): string {
	return fs.readFileSync(l1bPath, "utf-8");
}

function archiveCount(): number {
	return fs.readdirSync(archiveDir).filter((name) => name.endsWith(".md")).length;
}

function absorbEventCount(): number {
	return fs.readdirSync(absorbEventDir).filter((name) => name.endsWith(".json")).length;
}

function isRelativePath(value: unknown): value is string {
	return typeof value === "string" && value.length > 0 && !path.isAbsolute(value) && !value.split(/[\\/]+/).includes("..");
}

function rcEntry(index: number): string {
	return `### RC-${String(index).padStart(4, "0")} | OPEN | 2026-05-18 | Absorb write smoke ${index}\n\n**Session arc:** Smoke session ${index} produced durable absorb-write signal.\n\n**Body:**\n- Durable understanding ${index} should move into Deep Memory.\n- Active follow-up ${index} should move into Active Items.\n- Source-only redaction marker: ${SOURCE_L1B_SENTINEL}-${index}.\n\n**Parked:**\nFollow-up ${index} remains open.\n`;
}

function setRecentContextEntries(count: number): void {
	const base = readL1b();
	const match = /^##\s+Recent Context\s*$/m.exec(base);
	assert(match?.index != null, "scaffold L1b should include Recent Context");
	const start = match.index + match[0].length;
	const entries = Array.from({ length: count }, (_, i) => rcEntry(i + 1)).join("\n");
	const updated = `${base.slice(0, start)}\n\n${entries || ABSORB_EMPTY_RECENT_CONTEXT_PLACEHOLDER}\n`;
	fs.writeFileSync(l1bPath, updated, "utf-8");
}

function candidateL1b(recentContextBody = ABSORB_EMPTY_RECENT_CONTEXT_PLACEHOLDER): string {
	// Chronos is system-managed: a faithful candidate carries the source's
	// Chronos through unchanged, so the fixture splices it from the live L1b.
	const chronos = extractTopLevelSectionBody(readL1b(), "Chronos");
	if (chronos == null) throw new Error("source L1b should have a Chronos section");
	return `<!-- exxeta:l1b schema_version=1 -->\n\n## Chronos\n\n${chronos.trim()}\n\n## Deep Memory\n\n- Synthetic user is validating persistence-native personalized agents inside exxperts.\n- Absorb write smoke durable understanding has been consolidated into stable memory.\n- Candidate-only redaction marker: ${CANDIDATE_L1B_SENTINEL}.\n\n## Active Items\n\n### High Priority\n\n- Continue absorb approval-gated write implementation.\n\n### Medium Priority\n\n- Keep checkpoint and absorb mutation boundaries separate.\n\n### Low Priority\n\n- Revisit sidecar event records after proposal/write flow is stable.\n\n## Recent Context\n\n${recentContextBody}\n`;
}

function proposal(candidate = candidateL1b(), sourceL1b = readL1b()) {
	return {
		agentId: agentId,
		writesMemory: false,
		process: {
			type: ABSORB_CONSOLIDATION_WORKER_TYPE,
			model: { provider: "openai-codex", model: "gpt-5.5", label: "GPT-5.5" },
		},
		availability: { recentContextEntryCount: 5 },
		source: {
			l1bFingerprint: fingerprintL1bSource(sourceL1b),
			generatedAt: "2026-05-18T20:00:00.000Z",
		},
		fields: { candidateL1b: candidate },
		review: {
			keyMetrics: {
				recentContextEntriesBefore: 5,
				recentContextEntriesAfter: 0,
				stableMemoryDeltaBytes: 123,
				stableMemoryDeltaTokens: 31,
			},
		},
		absorbTelemetry: {
			l1bChars: sourceL1b.length,
			stableL1bChars: 456,
			recentContextChars: 789,
			recentContextEntryCount: 5,
			recentContextEntryIds: ["RC-0001", "RC-0002"],
			promptChars: 3210,
			promptEstimatedTokens: 803,
			sectionPurposeCount: 4,
			diagnosticHash: fingerprintL1bSource("absorb telemetry hash fixture"),
			rawPromptPreview: PROPOSAL_TEXT_SENTINEL,
		},
		absorbUsage: {
			input: 111,
			output: 222,
			cacheRead: 33,
			cacheWrite: 44,
			totalTokens: 333,
			cost: 0.0123,
			rawProviderPayload: PROPOSAL_TEXT_SENTINEL,
		},
		rawProposalMarkdown: `Proposal body must not leak: ${PROPOSAL_TEXT_SENTINEL}`,
	};
}

function absorbRequest(candidate = candidateL1b()) {
	return parseAbsorbApprovalRequest({ proposal: proposal(candidate) }, agentId);
}

function approvedEntry(title: string): string {
	return `### RC-DRAFT | CLOSED | 2026-05-18 | ${title}\n\n**Session arc:** A short post-absorb test session produced one checkpointable state delta.\n\n**Body:**\nKey durable signal was preserved after absorb.\n\n**Parked:**\nNone\n`;
}

function checkpointRequest(approvedRecentContext: string) {
	const conversationId = `c_${Math.random().toString(36).slice(2, 8)}`;
	const model = { provider: "openai-compatible", model: "gpt-5.5", label: "GPT-5.5" };
	const transcriptItem = { kind: "user", id: "u1", text: `Synthetic post-absorb checkpoint transcript for ${conversationId}.` };
	writePersistentAgentThread(agentId, conversationId, { state: "active", origin: "home", model, items: [transcriptItem] });
	const source = buildPersistentAgentCheckpointTranscriptSource({ agentId, conversationId, l1b: readL1b(), legacyItems: [transcriptItem] }).source;
	return parseCheckpointApprovalRequest({
		conversationId,
		model,
		density: "compact",
		proposal: {
			agentId: agentId,
			conversationId,
			sessionId: null,
			writesMemory: false,
			source,
		},
		approvedRecentContext,
	}, agentId);
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

try {
	createPersistentAgentFromScaffoldInput({
		displayName: "Absorb Write Smoke Room",
		userName: "Synthetic User",
		preferredUserAddress: "Synthetic User",
	});
	assert(fs.existsSync(l1bPath), "scaffold should create L1b/current.md");
	assert(fs.existsSync(absorbEventDir), "scaffold should create absorb event directory");
	assert(archiveCount() === 0, "fresh scaffold should have no archives");
	assert(absorbEventCount() === 0, "fresh scaffold should have no absorb event records");

	setRecentContextEntries(5);
	const sourceL1b = readL1b();
	// Budget-staleness guard (slice 3): a proposal echoing a budget that no
	// longer matches the room's settings must stale before anything is written.
	// The default budget is 20k, so any other echoed number trips it; proposals
	// that don't echo the impact block (this smoke's other cases) skip the guard.
	expectThrows(
		() => writeApprovedAbsorb(parseAbsorbApprovalRequest({ proposal: { ...proposal(), memoryBudgetImpact: { budgetTokens: 12_345, reviewTargetEstimatedTokensBefore: 1, reviewTargetEstimatedTokensAfter: 1, overBudgetBefore: false, overBudgetAfter: false } } }, agentId).request, [], new Date("2026-05-18T19:59:00.000Z")),
		// The full prefix is load-bearing: the client's stale flow keys on
		// "proposal is stale" and its cause copy on "memory budget changed".
		/proposal is stale: memory budget changed/,
		"a budget edited between propose and approve should stale the proposal",
	);
	const parsed = absorbRequest();
	const result = writeApprovedAbsorb(parsed.request, parsed.warnings, new Date("2026-05-18T20:00:00.000Z"));
	const absorbedL1b = readL1b();
	assert(result.writesMemory === true, "absorb approval should report memory write");
	assert(result.recentContextEntryCount === 0, "absorb approval should report zero RC entries");
	// Slice-3 budget state: the saved screen's numbers must read the WRITTEN
	// L1b through the shared numerator and the one predicate — not a cached
	// pre-write value, not a re-derived comparison.
	assert(result.memoryBudget && result.memoryBudget.reviewTargetEstimatedTokens === reviewTargetEstimatedTokensFromL1b(absorbedL1b), "approval budget state should measure the written L1b via the shared numerator");
	assert(result.memoryBudget.overBudget === overMemoryBudget(result.memoryBudget.reviewTargetEstimatedTokens, result.memoryBudget.budgetTokens), "approval budget verdict should be the one predicate");
	assert(result.memoryBudget.budgetTokens > 0, "approval budget state should carry the room's budget");
	assert(/^## Chronos\n[\s\S]*^## Deep Memory\n[\s\S]*^## Active Items\n[\s\S]*^## Recent Context/m.test(absorbedL1b), "absorbed L1b should preserve top-level topology/order");
	assert(!/^###\s+RC-/m.test(absorbedL1b), "absorbed L1b should clear all RC entries");
	assert(absorbedL1b.includes(`## Recent Context\n\n${ABSORB_EMPTY_RECENT_CONTEXT_PLACEHOLDER}`), "absorbed L1b should keep checkpoint-safe Recent Context placeholder");
	assert(archiveCount() === 1, "absorb approval should archive previous L1b");
	assert(fs.readFileSync(result.archivedL1bPath, "utf-8") === sourceL1b, "archive should contain pre-absorb L1b");
	assert(absorbEventCount() === 1, "absorb approval should create one absorb event record");
	assert(result.eventRecordPath === path.join(absorbEventDir, `${result.absorbId}.json`), "absorb approval should return canonical event record path");
	assert(fs.existsSync(result.eventRecordPath), "absorb event record should exist");
	const eventRecord = JSON.parse(fs.readFileSync(result.eventRecordPath, "utf-8"));
	assert(eventRecord.schemaVersion === 1, "absorb event record should use schema version 1");
	assert(eventRecord.operation === "absorb", "absorb event record should identify operation");
	assert(eventRecord.mode === "rc_consolidation", "absorb event record should identify mode");
	assert(eventRecord.agentId === agentId, "absorb event record should include agent id");
	assert(eventRecord.absorbId === result.absorbId, "absorb event record should match response absorb id");
	assert(eventRecord.approvedAt === "2026-05-18T20:00:00.000Z", "absorb event record should include approval timestamp");
	assert(eventRecord.archivedL1bPath == null, "new absorb event record should not persist top-level archive path");
	assert(eventRecord.updatedL1bPath == null, "new absorb event record should not persist top-level updated L1b path");
	assert(result.eventRelPath === `events/absorb/${result.absorbId}.json`, "absorb approval should return canonical relative event path");
	assert(eventRecord.mutation?.target === "l1b", "absorb event mutation should target L1b");
	assert(eventRecord.mutation?.kind === "recent_context_consolidation", "absorb event mutation should identify RC consolidation");
	assert(Array.isArray(eventRecord.mutation.sectionsAffected), "absorb event mutation should include affected sections");
	assert(eventRecord.mutation.sectionsAffected.includes("Recent Context"), "absorb event mutation should mark Recent Context affected");
	assert(isRelativePath(eventRecord.paths?.archivedL1bRelPath), "absorb archive path in event should be relative");
	assert(isRelativePath(eventRecord.paths?.updatedL1bRelPath), "absorb updated L1b path in event should be relative");
	assert(isRelativePath(eventRecord.paths?.eventRelPath), "absorb event path in event should be relative");
	assert(eventRecord.paths.archivedL1bRelPath === path.relative(agentRoot, result.archivedL1bPath).split(path.sep).join("/"), "absorb event archive path should be agent-root relative");
	assert(eventRecord.paths.updatedL1bRelPath === "L1b/current.md", "absorb event updated L1b path should be agent-root relative");
	assert(eventRecord.paths.eventRelPath === result.eventRelPath, "absorb event relative path should match response relative path");
	assert(eventRecord.process?.type === ABSORB_CONSOLIDATION_WORKER_TYPE, "absorb event should include proposal-time worker type");
	assert(eventRecord.process?.mode === "rc_consolidation", "absorb event should include process mode");
	assert(eventRecord.process?.source === "proposal_time", "absorb event process should identify proposal-time source");
	assert(eventRecord.process?.model?.provider === "openai-codex", "absorb event should copy proposal model provider");
	assert(eventRecord.process?.model?.model === "gpt-5.5", "absorb event should copy proposal model id");
	assert(eventRecord.process?.model?.label === "GPT-5.5", "absorb event should copy proposal model label");
	assert(eventRecord.proposal?.generatedAt === "2026-05-18T20:00:00.000Z", "absorb event should copy proposal generation timestamp");
	assert(eventRecord.proposal?.sourceL1bFingerprint?.value === fingerprintL1bSource(sourceL1b).value, "absorb event should copy source fingerprint metadata");
	assert(eventRecord.proposal?.telemetry?.promptChars === 3210, "absorb event should copy numeric proposal telemetry");
	assert(eventRecord.proposal?.telemetry?.promptEstimatedTokens === 803, "absorb event should copy numeric token telemetry");
	assert(eventRecord.proposal?.telemetry?.diagnosticHash?.algorithm === "sha256", "absorb event should copy hash-shaped telemetry");
	assert(eventRecord.proposal?.telemetry?.recentContextEntryIds == null, "absorb event should omit non-numeric telemetry arrays");
	assert(eventRecord.proposal?.telemetry?.rawPromptPreview == null, "absorb event should omit raw telemetry text");
	assert(eventRecord.proposal?.usage?.input === 111, "absorb event should copy numeric usage input");
	assert(eventRecord.proposal?.usage?.output === 222, "absorb event should copy numeric usage output");
	assert(eventRecord.proposal?.usage?.cacheRead === 33, "absorb event should copy numeric usage cacheRead");
	assert(eventRecord.proposal?.usage?.cacheWrite === 44, "absorb event should copy numeric usage cacheWrite");
	assert(eventRecord.proposal?.usage?.totalTokens === 333, "absorb event should copy numeric usage totalTokens");
	assert(eventRecord.proposal?.usage?.cost === 0.0123, "absorb event should copy numeric usage cost");
	assert(eventRecord.proposal?.usage?.rawProviderPayload == null, "absorb event should omit raw usage payloads");
	assert(eventRecord.source.recentContextEntryCount === 5, "absorb event record should capture source RC count");
	assert(eventRecord.result.recentContextEntryCount === 0, "absorb event record should capture result RC count");
	assert(eventRecord.source.l1bFingerprint.value === fingerprintL1bSource(sourceL1b.trimEnd() + "\n").value, "absorb event record should capture source fingerprint");
	assert(eventRecord.result.l1bFingerprint.value === fingerprintL1bSource(absorbedL1b.trimEnd() + "\n").value, "absorb event record should capture result fingerprint");
	assert(eventRecord.source.bytes === Buffer.byteLength(sourceL1b.trimEnd() + "\n", "utf-8"), "absorb event record should capture source bytes");
	assert(eventRecord.result.bytes === Buffer.byteLength(absorbedL1b.trimEnd() + "\n", "utf-8"), "absorb event record should capture result bytes");
	const sourceSectionTitles = eventRecord.source.sections.topLevel.map((section: { title: string }) => section.title);
	const resultSectionTitles = eventRecord.result.sections.topLevel.map((section: { title: string }) => section.title);
	assert(["Chronos", "Deep Memory", "Active Items", "Recent Context"].every((title) => sourceSectionTitles.includes(title)), "absorb event record should capture source top-level sections");
	assert(["Chronos", "Deep Memory", "Active Items", "Recent Context"].every((title) => resultSectionTitles.includes(title)), "absorb event record should capture result top-level sections");
	assert(eventRecord.source.sections.recentContext.entryCount === 5, "absorb event record should capture source RC section entry count");
	assert(eventRecord.result.sections.recentContext.entryCount === 0, "absorb event record should capture result RC section entry count");
	assert(eventRecord.source.sections.recentContext.bytes > eventRecord.result.sections.recentContext.bytes, "absorb event record should support RC size compression metrics");
	assert(eventRecord.source.sections.nonRecentContext.bytes > 0, "absorb event record should capture source non-RC size");
	assert(eventRecord.result.sections.nonRecentContext.bytes > 0, "absorb event record should capture result non-RC size");
	assert(eventRecord.absorb?.recentContextEntryCountBefore === eventRecord.source.recentContextEntryCount, "absorb summary should mirror source RC count");
	assert(eventRecord.absorb?.recentContextEntryCountAfter === eventRecord.result.recentContextEntryCount, "absorb summary should mirror result RC count");
	assert(eventRecord.absorb?.recentContextBytesBefore === eventRecord.source.sections.recentContext.bytes, "absorb summary should mirror source RC bytes");
	assert(eventRecord.absorb?.recentContextBytesAfter === eventRecord.result.sections.recentContext.bytes, "absorb summary should mirror result RC bytes");
	assert(typeof eventRecord.absorb?.stableMemoryBytesBefore === "number", "absorb summary should include stable memory bytes before");
	assert(typeof eventRecord.absorb?.stableMemoryBytesAfter === "number", "absorb summary should include stable memory bytes after");
	assert(typeof eventRecord.absorb?.stableMemoryDeltaBytes === "number", "absorb summary should include stable memory byte delta");
	assert(typeof eventRecord.absorb?.stableMemoryEstimatedTokensBefore === "number", "absorb summary should include stable memory tokens before");
	assert(typeof eventRecord.absorb?.stableMemoryEstimatedTokensAfter === "number", "absorb summary should include stable memory tokens after");
	assert(typeof eventRecord.absorb?.stableMemoryEstimatedTokenDelta === "number", "absorb summary should include stable memory token delta");
	assert(eventRecord.absorb.stableMemoryDeltaBytes === eventRecord.absorb.stableMemoryBytesAfter - eventRecord.absorb.stableMemoryBytesBefore, "absorb summary stable byte delta should be derived");
	assert(eventRecord.absorb.stableMemoryEstimatedTokenDelta === eventRecord.absorb.stableMemoryEstimatedTokensAfter - eventRecord.absorb.stableMemoryEstimatedTokensBefore, "absorb summary stable token delta should be derived");
	assert(eventRecord.validation.valid === true, "absorb event record should capture validation success");
	assert(Array.isArray(eventRecord.validation.warnings), "absorb event record should capture validation warnings");
	assert(Array.isArray(eventRecord.warnings), "absorb event record should capture warnings");
	const serializedEvent = JSON.stringify(eventRecord);
	assert(!serializedEvent.includes(root), "absorb event JSON should not include temp persistent-agents root");
	assert(!serializedEvent.includes(agentRoot), "absorb event JSON should not include default agent absolute root");
	assert(!serializedEvent.includes(SOURCE_L1B_SENTINEL), "absorb event JSON should not include raw source L1b sentinel");
	assert(!serializedEvent.includes(CANDIDATE_L1B_SENTINEL), "absorb event JSON should not include raw candidate L1b sentinel");
	assert(!serializedEvent.includes(PROPOSAL_TEXT_SENTINEL), "absorb event JSON should not include raw proposal text sentinel");
	assert(getPersistentAgentStatus(agentId).memoryStatus.recentContextCount === 0, "status should refresh to zero RC entries after absorb");

	const postAbsorbCheckpoint = checkpointRequest(approvedEntry("Post-absorb checkpoint"));
	const checkpointResult = writeApprovedCheckpoint(postAbsorbCheckpoint.request, postAbsorbCheckpoint.warnings, new Date("2026-05-18T20:01:00.000Z"));
	const checkpointedL1b = readL1b();
	assert(checkpointResult.recentContextEntryCount === 1, "post-absorb checkpoint should append one RC entry");
	assert(/^### RC-0001 \|/m.test(checkpointedL1b), "post-absorb checkpoint should create RC-0001");
	assert(!/No checkpointed sessions yet\.[\s\S]*### RC-0001/.test(checkpointedL1b), "checkpoint append should remove absorb placeholder before appending");
	assert(archiveCount() === 2, "post-absorb checkpoint should create second archive");

	setRecentContextEntries(5);
	const beforeInvalidArchiveCount = archiveCount();
	const staleParsed = absorbRequest();
	setRecentContextEntries(5);
	const sameCountChangedL1b = readL1b().replace("Durable understanding 3", "Durable understanding 3 changed after proposal");
	fs.writeFileSync(l1bPath, sameCountChangedL1b, "utf-8");
	expectThrows(
		() => writeApprovedAbsorb(staleParsed.request, staleParsed.warnings, new Date("2026-05-18T20:02:00.000Z")),
		/source L1b fingerprint changed/,
		"same-count changed source should be rejected before archive/write",
	);
	assert(archiveCount() === beforeInvalidArchiveCount, "stale same-count proposal should not archive or write");
	assert(absorbEventCount() === 1, "stale same-count proposal should not create an event record");

	expectThrows(
		() => writeApprovedAbsorb(absorbRequest(candidateL1b(rcEntry(99))).request, [], new Date("2026-05-18T20:03:00.000Z")),
		/clear all Recent Context entries/,
		"candidate with remaining RC entry should be rejected before archive/write",
	);
	assert(archiveCount() === beforeInvalidArchiveCount, "invalid RC candidate should not archive or write");
	assert(absorbEventCount() === 1, "invalid RC candidate should not create an event record");

	const reorderedCandidate = candidateL1b()
		.replace("## Deep Memory", "## __TMP_SECTION__")
		.replace("## Active Items", "## Deep Memory")
		.replace("## __TMP_SECTION__", "## Active Items");
	expectThrows(
		() => writeApprovedAbsorb(absorbRequest(reorderedCandidate).request, [], new Date("2026-05-18T20:04:00.000Z")),
		/top-level section topology\/order differs/,
		"reordered candidate should be rejected before archive/write",
	);
	assert(archiveCount() === beforeInvalidArchiveCount, "reordered candidate should not archive or write");
	assert(absorbEventCount() === 1, "reordered candidate should not create an event record");

	expectThrows(
		() => writeApprovedAbsorb(absorbRequest(candidateL1b().replace(/^## Recent Context[\s\S]*$/m, "")).request, [], new Date("2026-05-18T20:05:00.000Z")),
		/missing mandatory section: Recent Context|top-level section topology\/order differs/,
		"candidate missing Recent Context should be rejected before archive/write",
	);
	assert(archiveCount() === beforeInvalidArchiveCount, "missing section candidate should not archive or write");
	assert(absorbEventCount() === 1, "missing section candidate should not create an event record");

	expectThrows(
		() => writeApprovedAbsorb(absorbRequest(candidateL1b("Memory Absorption Proposal")).request, [], new Date("2026-05-18T20:06:00.000Z")),
		/prompt\/proposal scaffolding/,
		"candidate with proposal scaffolding in Recent Context should be rejected before archive/write",
	);
	assert(archiveCount() === beforeInvalidArchiveCount, "scaffolding candidate should not archive or write");
	assert(absorbEventCount() === 1, "scaffolding candidate should not create an event record");

	fs.rmSync(root, { recursive: true, force: true });
	console.log("absorb write smoke passed");
} catch (error) {
	console.error(error instanceof Error ? error.stack || error.message : error);
	console.error(`temp root preserved for inspection: ${root}`);
	process.exitCode = 1;
}
