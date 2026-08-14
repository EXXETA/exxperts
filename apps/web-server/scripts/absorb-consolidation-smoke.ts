import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "exxeta-absorb-consolidation-home-"));
process.env.HOME = tempHome;
process.env.USERPROFILE = tempHome;
const smokeAppDir = path.join(tempHome, ".exxperts", "app");
fs.mkdirSync(smokeAppDir, { recursive: true });
fs.writeFileSync(
	path.join(smokeAppDir, "openai-compatible-ai-profile.json"),
	JSON.stringify({ profileId: "openai-compatible", providerId: "openai-compatible", label: "Synthetic Gateway", roomModels: [{ modelId: "gpt-5.5" }, { modelId: "claude-opus-4.6" }], maintenanceModel: "claude-opus-4.6" }, null, 2),
);
fs.writeFileSync(path.join(smokeAppDir, "persistent-agent-ai-profile.json"), JSON.stringify({ profileId: "openai-compatible" }, null, 2));
const root = fs.mkdtempSync(path.join(os.tmpdir(), "exxeta-absorb-consolidation-"));
process.env.EXXETA_PERSISTENT_AGENTS_ROOT = root;

const {
	createPersistentAgentFromScaffoldInput,
	buildAbsorbAssessment,
	buildAbsorbProposal,
	fingerprintL1bSource,
	getAbsorbAvailability,
} = await import("../src/persistent-agents.js");

const agentId = "absorb-consolidation-smoke-room";
const {
	ABSORB_EMPTY_RECENT_CONTEXT_PLACEHOLDER,
	buildAbsorbAssessmentPrompt,
	buildAbsorbProposalPrompt,
	buildAbsorbProposalReview,
	buildSectionPurposeMap,
	parseAbsorbAssessment,
	parseAbsorbProposal,
	validateAbsorbCandidateL1b,
} = await import("../src/absorb-consolidation.js");
const { getAbsorbModelLock } = await import("../src/persistent-agent-ai-profiles.js");
const ABSORB_MODEL = getAbsorbModelLock("openai-compatible");

const agentRoot = path.join(root, agentId);
const l1bPath = path.join(agentRoot, "L1b", "current.md");
const registryPath = path.join(agentRoot, "section_registry.json");
const CHATGPT_CODEX_ABSORB_MODEL = getAbsorbModelLock("chatgpt-codex");

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

function readL1b(): string {
	return fs.readFileSync(l1bPath, "utf-8");
}

function rcEntry(index: number): string {
	return `### RC-${String(index).padStart(4, "0")} | OPEN | 2026-05-18 | Absorb smoke ${index}\n\n**Session arc:** Smoke session ${index} produced durable absorb signal.\n\n**Body:**\n- Durable understanding ${index} should be considered for Deep Memory.\n- Active follow-up ${index} should be considered for Active Items.\n\n**Parked:**\nFollow-up ${index} remains open.\n`;
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

function candidateL1b(): string {
	return `<!-- exxeta:l1b schema_version=1 -->\n\n## Chronos\n\n- Current scaffold timestamp: 2026-05-18T00:00:00.000Z\n- Persistent agent id: absorb-consolidation-smoke-room\n- Lifecycle state: ready\n- Last checkpoint: cp_smoke\n- Last consolidation: none\n\n## Deep Memory\n\n- Synthetic user is validating persistence-native personalized agents inside exxperts.\n- Absorb smoke durable understanding has been consolidated into stable memory.\n\n## Active Items\n\n### High Priority\n\n- Continue absorb/consolidation backend implementation.\n\n### Medium Priority\n\n- Keep checkpoint and absorb mutation boundaries separate.\n\n### Low Priority\n\n- Revisit sidecar event records after proposal/write flow is stable.\n\n## Recent Context\n\n${ABSORB_EMPTY_RECENT_CONTEXT_PLACEHOLDER}\n`;
}

const assessmentFixture = `## Absorb assessment\n\nI found 5 Recent Context entries. Here is the proposed direction.\n\n### What to remember\n- Durable absorb architecture decisions should shape future memory work.\n- Backend absorb must remain non-mutating until approval.\n\n### What to forget\n- Repeated smoke-test chatter.\n- Completed mechanical checkpoint details.\n\n### What changes in stable memory\n- Deep Memory: sharpen the durable absorb/consolidation architecture.\n- Active Items: track backend proposal implementation as the current live thread.\n- Recent Context: all entries are expected to be cleared after approval.\n\n### Needs your judgment\n- None\n`;

function proposalFixture(candidate = candidateL1b()): string {
	return `## Memory Absorption Proposal\n\n### Mode\nRC_CONSOLIDATION\n\n### Primacy Map\nThe RC chain captures absorb/consolidation implementation progress and memory-boundary decisions.\n\n### Section-Level Change Log\n| Section | Prior Words | Candidate Words | Action | Rationale |\n|---|---:|---:|---|---|\n| Deep Memory | 20 | 28 | sharpen | Preserve durable architecture direction. |\n| Active Items | 20 | 26 | update | Preserve live implementation thread. |\n| Recent Context | 200 | 4 | clear | Strict absorb clears RC entries. |\n\n### Entry-Level Detail\n| Entry / Block | Operation | Target Section | Rationale |\n|---|---|---|---|\n| RC-0001..RC-0005 | consolidate | Deep Memory / Active Items | Durable signal survives outside RC. |\n\n### Compression Metrics\n- RC input words: 200\n- RC removed words: 200\n- RC removed percent: 100%\n- Stable memory words before: 80\n- Stable memory words after: 90\n- Stable memory delta: +10\n- Compression ratio: 2.2\n\n### Warnings\nNone\n\n### Candidate L1b\n${candidate}`;
}

try {
	createPersistentAgentFromScaffoldInput({
		displayName: "Absorb Consolidation Smoke Room",
		userName: "Synthetic User",
		preferredUserAddress: "Synthetic User",
	});
	assert(fs.existsSync(l1bPath), "scaffold should create L1b/current.md");

	setRecentContextEntries(4);
	const unavailable = getAbsorbAvailability(agentId);
	assert(!unavailable.available, "4 RC entries should keep absorb unavailable");
	assert(unavailable.reason === "insufficient_recent_context", "4 RC entries should fail the minimum gate");
	assert(unavailable.recentContextEntryCount === 4, "availability should report 4 RC entries");

	setRecentContextEntries(5);
	const available = getAbsorbAvailability(agentId);
	assert(available.available, "5 RC entries should make absorb available");
	assert(available.recentContextEntryCount === 5, "availability should report 5 RC entries");

	const l1b = readL1b();
	const registry = JSON.parse(fs.readFileSync(registryPath, "utf-8"));
	const sectionPurposeMap = buildSectionPurposeMap(registry);
	const assessmentPrompt = buildAbsorbAssessmentPrompt({ agentId: agentId, l1b, model: ABSORB_MODEL, sectionPurposeMap });
	assert(assessmentPrompt.prompt.includes("## Material: Current L1b Memory State"), "assessment prompt should include L1b material");
	assert(assessmentPrompt.prompt.includes("### RC-0005"), "assessment prompt should include Recent Context entries");
	assert(!assessmentPrompt.prompt.includes("# Absorb Consolidation Smoke Room Constitution"), "assessment prompt should not inject L1a constitution text");
	assert(assessmentPrompt.metrics.recentContextEntryCount === 5, "assessment telemetry should count RC entries");
	assert(assessmentPrompt.prompt.includes("## Reading Recent Context in Order"), "absorb constitution should carry the time-sequence reading rule");
	assert(assessmentPrompt.prompt.includes("## Must-Keep Material"), "absorb constitution should carry the must-keep rule");
	assert(assessmentPrompt.prompt.includes("sensitive-material restraint"), "absorb constitution should carry the sensitive-material restraint");
	assert(assessmentPrompt.prompt.includes("denser, not merely larger"), "absorb constitution should carry the denser-not-larger principle");

	const parsedAssessment = parseAbsorbAssessment(assessmentFixture);
	assert(parsedAssessment.fields.whatToRemember.length === 2, "assessment parser should extract remember bullets");
	assert(parsedAssessment.fields.stableMemoryChanges.deepMemory.length === 1, "assessment parser should extract Deep Memory changes");

	const assessmentResponse = await buildAbsorbAssessment(agentId, ABSORB_MODEL, async (prompt, model) => {
		assert(prompt.includes("absorb/consolidation worker"), "buildAbsorbAssessment should pass absorb prompt to generator");
		assert(model.provider === ABSORB_MODEL.provider && model.model === ABSORB_MODEL.model, "buildAbsorbAssessment should use system-selected absorb model");
		return { text: assessmentFixture, usage: { input: 10, output: 20, totalTokens: 30, cost: 0 } };
	});
	assert(assessmentResponse.writesMemory === false, "assessment response should be non-mutating");
	assert(assessmentResponse.process.type === "absorb-consolidation-worker", "assessment response should identify hidden worker type");
	assert(assessmentResponse.source.l1bFingerprint.value === fingerprintL1bSource(l1b).value, "assessment response should include source L1b fingerprint");
	assert(assessmentResponse.source.generatedAt, "assessment response should include source generation timestamp");

	const altAssessmentResponse = await buildAbsorbAssessment(agentId, CHATGPT_CODEX_ABSORB_MODEL, async (prompt, model) => {
		assert(prompt.includes("System-selected model: openai-codex/gpt-5.6-sol"), "ChatGPT Plus/Pro absorb prompt should use profile-mapped model metadata");
		assert(model.provider === "openai-codex" && model.model === "gpt-5.6-sol", "ChatGPT Plus/Pro absorb assessment should pass profile-mapped model to generator");
		return { text: assessmentFixture };
	});
	assert(altAssessmentResponse.process.model.provider === "openai-codex" && altAssessmentResponse.process.model.model === "gpt-5.6-sol", "ChatGPT Plus/Pro absorb response should report profile-mapped process model");

	const proposalPrompt = buildAbsorbProposalPrompt({ agentId: agentId, l1b, model: ABSORB_MODEL, sectionPurposeMap, assessmentMarkdown: assessmentFixture });
	assert(proposalPrompt.prompt.includes("no headings starting with `### RC-` may remain"), "proposal prompt should include strict RC-empty target");
	assert(proposalPrompt.prompt.includes("## Recent Context"), "proposal prompt should require preserving Recent Context section");
	assert(!proposalPrompt.prompt.includes("# Absorb Consolidation Smoke Room Constitution"), "proposal prompt should not inject L1a constitution text");

	const parsedProposal = parseAbsorbProposal(proposalFixture());
	assert(/RC_CONSOLIDATION/.test(parsedProposal.fields.mode), "proposal parser should extract mode");
	assert(parsedProposal.fields.candidateL1b.includes("## Recent Context"), "proposal parser should extract Candidate L1b");
	const proposalReview = buildAbsorbProposalReview(l1b, parsedProposal.fields);
	assert(proposalReview.summary.includes("absorb/consolidation implementation"), "proposal review should expose summary");
	assert(proposalReview.sectionChanges.length === 3, "proposal review should parse section-level changes");
	assert(proposalReview.sectionChanges.some((change) => change.section === "Recent Context" && change.action === "clear"), "proposal review should normalize clear section action");
	assert(proposalReview.entryChanges.length === 1, "proposal review should parse entry-level detail");
	assert(proposalReview.entryChanges[0].action === "merge", "proposal review should normalize consolidate entry action as merge");
	assert(proposalReview.keyMetrics.recentContextEntriesBefore === 5, "proposal review should derive source RC count");
	assert(proposalReview.keyMetrics.recentContextEntriesAfter === 0, "proposal review should derive candidate RC count");

	const goodValidation = validateAbsorbCandidateL1b(l1b, candidateL1b());
	assert(goodValidation.valid, `candidate without RC entries should validate: ${goodValidation.errors.join("; ")}`);
	assert(goodValidation.recentContextEntryCount === 0, "valid candidate should have zero RC entries");

	const badCandidate = candidateL1b().replace(ABSORB_EMPTY_RECENT_CONTEXT_PLACEHOLDER, rcEntry(99));
	const badValidation = validateAbsorbCandidateL1b(l1b, badCandidate);
	assert(!badValidation.valid, "candidate with remaining RC entry should be rejected");
	assert(badValidation.errors.some((error) => /clear all Recent Context entries/.test(error)), "remaining RC rejection should explain strict absorb target");

	const proposalResponse = await buildAbsorbProposal({ agentId, assessmentMarkdown: assessmentFixture }, ABSORB_MODEL, async (prompt, model) => {
		assert(prompt.includes("Memory Absorption Proposal"), "buildAbsorbProposal should pass proposal prompt to generator");
		assert(model.provider === ABSORB_MODEL.provider && model.model === ABSORB_MODEL.model, "buildAbsorbProposal should use system-selected absorb model");
		return { text: proposalFixture(), usage: { input: 50, output: 60, totalTokens: 110, cost: 0 } };
	});
	assert(proposalResponse.writesMemory === false, "proposal response should be non-mutating");
	assert(proposalResponse.review.keyMetrics.recentContextEntriesBefore === 5, "proposal response should include structured review metrics");
	assert(proposalResponse.candidateValidation.valid, "proposal response should include candidate validation");
	assert(readL1b() === l1b, "buildAbsorbProposal must not mutate L1b");

	// Draft again carries the previous validator reasons into the redraft
	// prompt as a Retry Notice; first drafts stay byte-free of it, and the
	// client input is capped and flattened.
	assert(!proposalPrompt.prompt.includes("## Retry Notice"), "proposal prompt without feedback must not carry a Retry Notice");
	const oversizedReason = `Candidate L1b top-level section topology/order differs from source L1b ${"x".repeat(400)}`;
	const manyReasons = [oversizedReason, "Candidate L1b is empty", ...Array.from({ length: 10 }, (_, i) => `filler reason ${i + 1}`)];
	let retryPrompt = "";
	await buildAbsorbProposal({ agentId, assessmentMarkdown: assessmentFixture, retryFeedback: manyReasons }, ABSORB_MODEL, async (prompt) => {
		retryPrompt = prompt;
		return { text: proposalFixture() };
	});
	assert(retryPrompt.includes("## Retry Notice"), "redraft prompt should carry the Retry Notice");
	assert(retryPrompt.includes("- Candidate L1b is empty"), "redraft prompt should list the validator reasons");
	assert(!retryPrompt.includes("filler reason 9"), "retry feedback should be capped at 8 reasons");
	assert(!retryPrompt.includes("x".repeat(301)), "oversized reasons should be truncated");
	assert(/## Retry Notice[\s\S]*following the Task structure exactly\./.test(retryPrompt.slice(retryPrompt.indexOf("## Retry Notice"))), "retry notice should close with the correction instruction");
	const junkFeedbackPrompt = await (async () => {
		let captured = "";
		await buildAbsorbProposal({ agentId, assessmentMarkdown: assessmentFixture, retryFeedback: [42, "", "   "] as unknown as string[] }, ABSORB_MODEL, async (prompt) => {
			captured = prompt;
			return { text: proposalFixture() };
		});
		return captured;
	})();
	assert(!junkFeedbackPrompt.includes("## Retry Notice"), "non-string/empty feedback must not produce a Retry Notice");

	// Input-side overflow guard: a window too small for the assembled prompt
	// refuses with 413 guidance BEFORE the worker runs; without window
	// metadata the worker runs unguarded (the pre-guard behavior).
	const tinyWindow = () => ({ contextWindow: 2000, maxOutputTokens: 1000 });
	let overflowWorkerRan = false;
	try {
		await buildAbsorbProposal({ agentId, assessmentMarkdown: assessmentFixture }, ABSORB_MODEL, async () => {
			overflowWorkerRan = true;
			return { text: proposalFixture() };
		}, { resolveModelWindow: tinyWindow });
		throw new Error("tiny window should refuse the absorb proposal prompt");
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		assert(/too large for the locked model/.test(message), `overflow refusal should name the size problem: ${message}`);
		assert(/run Review to shrink stable memory/.test(message) && /larger-context/.test(message), "overflow refusal should carry guidance");
		assert(/No memory has been written/.test(message), "overflow refusal should state memory is untouched");
		assert((error as any).statusCode === 413, "overflow refusal should carry HTTP 413");
	}
	assert(!overflowWorkerRan, "overflow refusal must fire before the worker runs");
	await buildAbsorbAssessment(agentId, ABSORB_MODEL, async () => ({ text: assessmentFixture }), { resolveModelWindow: () => ({ contextWindow: Number.NaN, maxOutputTokens: Number.NaN }) });
	// Non-finite window metadata → guard stays unarmed and the call succeeds.

	fs.rmSync(root, { recursive: true, force: true });
	console.log("absorb consolidation smoke passed");
} catch (error) {
	console.error(error instanceof Error ? error.stack || error.message : error);
	console.error(`temp root preserved for inspection: ${root}`);
	process.exitCode = 1;
}
