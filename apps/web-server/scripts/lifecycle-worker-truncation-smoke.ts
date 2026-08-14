import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// A lifecycle worker response cut at the provider's output-token ceiling must
// be refused with an honest size error BEFORE parsing/validation. Otherwise
// the candidate validator blames the document structure ("missing Recent
// Context") for what is a model output limit, and every "Draft again" retry
// re-rolls the same dice. This smoke pins the refusal for Memorize, Review,
// checkpoint, and consult, and pins that complete outputs and the
// validator backstop are untouched.

const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "exxeta-worker-truncation-home-"));
process.env.HOME = tempHome;
process.env.USERPROFILE = tempHome;
const smokeAppDir = path.join(tempHome, ".exxperts", "app");
fs.mkdirSync(smokeAppDir, { recursive: true });
fs.writeFileSync(
	path.join(smokeAppDir, "openai-compatible-ai-profile.json"),
	JSON.stringify({ profileId: "openai-compatible", providerId: "openai-compatible", label: "Synthetic Gateway", roomModels: [{ modelId: "gpt-5.5" }], maintenanceModel: "gpt-5.5" }, null, 2),
);
fs.writeFileSync(path.join(smokeAppDir, "persistent-agent-ai-profile.json"), JSON.stringify({ profileId: "openai-compatible" }, null, 2));
const root = fs.mkdtempSync(path.join(os.tmpdir(), "exxeta-worker-truncation-"));
process.env.EXXETA_PERSISTENT_AGENTS_ROOT = root;

const {
	createPersistentAgentFromScaffoldInput,
	buildAbsorbAssessment,
	buildAbsorbProposal,
	buildStructuralReviewProposal,
	buildCheckpointProposal,
	buildConsultAnswer,
	writePersistentAgentThread,
} = await import("../src/persistent-agents.js");
const { ABSORB_EMPTY_RECENT_CONTEXT_PLACEHOLDER } = await import("../src/absorb-consolidation.js");
const { getAbsorbModelLock, getStructuralReviewModelLock } = await import("../src/persistent-agent-ai-profiles.js");

const agentId = "worker-truncation-smoke-room";
const ABSORB_MODEL = getAbsorbModelLock("openai-compatible");
const STRUCTURAL_REVIEW_MODEL = getStructuralReviewModelLock("openai-compatible");
const CHECKPOINT_MODEL = { provider: "openai-compatible", model: "gpt-5.5", label: "GPT-5.5" };

const agentRoot = path.join(root, agentId);
const l1bPath = path.join(agentRoot, "L1b", "current.md");

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

async function expectRejects(fn: () => Promise<unknown>, expected: RegExp, label: string): Promise<Error> {
	try {
		await fn();
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		assert(expected.test(message), `${label}: expected ${expected}, got ${message}`);
		return error as Error;
	}
	throw new Error(`${label}: expected rejection`);
}

function rcEntry(index: number): string {
	return `### RC-${String(index).padStart(4, "0")} | OPEN | 2026-05-18 | Truncation smoke ${index}\n\n**Session arc:** Smoke session ${index} produced durable signal.\n\n**Body:**\n- Durable understanding ${index} should be considered for Deep Memory.\n\n**Parked:**\nNone\n`;
}

function setRecentContextEntries(count: number): void {
	const base = fs.readFileSync(l1bPath, "utf-8");
	const match = /^##\s+Recent Context\s*$/m.exec(base);
	assert(match?.index != null, "scaffold L1b should include Recent Context");
	const start = match.index + match[0].length;
	const entries = Array.from({ length: count }, (_, i) => rcEntry(i + 1)).join("\n");
	fs.writeFileSync(l1bPath, `${base.slice(0, start)}\n\n${entries || ABSORB_EMPTY_RECENT_CONTEXT_PLACEHOLDER}\n`, "utf-8");
}

const assessmentFixture = `## Absorb assessment\n\nI found 5 Recent Context entries. Here is the proposed direction.\n\n### What to remember\n- Durable truncation-guard decisions.\n\n### What to forget\n- Smoke chatter.\n\n### What changes in stable memory\n- Deep Memory: sharpen the guard rationale.\n- Active Items: track the guard slice.\n- Recent Context: all entries are expected to be cleared after approval.\n\n### Needs your judgment\n- None\n`;

// A draft that was cut mid-document: proposal head present, Candidate L1b gone.
const cutAbsorbDraft = `## Memory Absorption Proposal\n\n### Mode\nRC_CONSOLIDATION\n\n### Primacy Map\nThe RC chain captures truncation-guard work.\n\n### Section-Level Change Log\n| Section | Prior Words | Candidate Words | Action | Rationale |\n|---|---:|---:|---|---|\n| Deep Memory | 20 | 28 | sharpen | Preserve durable direction. |\n\n### Entry-Level`;

const truncatedResult = (text: string) => ({
	text,
	usage: { input: 100, output: 42666, totalTokens: 42766, cost: 0 },
	truncated: true,
	modelMaxOutputTokens: 42666,
});

try {
	createPersistentAgentFromScaffoldInput({
		displayName: "Worker Truncation Smoke Room",
		userName: "Synthetic User",
		preferredUserAddress: "Synthetic User",
	});
	assert(fs.existsSync(l1bPath), "scaffold should create L1b/current.md");
	setRecentContextEntries(5);

	// 1. Memorize proposal: truncated draft refuses with the size truth, before the validator.
	const learnError = await expectRejects(
		() => buildAbsorbProposal({ agentId, assessmentMarkdown: assessmentFixture }, ABSORB_MODEL, async () => truncatedResult(cutAbsorbDraft)),
		/too large to rewrite in one response/,
		"truncated Memorize proposal",
	);
	assert(/the Memorize draft was cut off/.test(learnError.message), "Memorize refusal should name the process");
	assert(/42666/.test(learnError.message), "Memorize refusal should carry the real token numbers");
	assert(/No memory has been written/.test(learnError.message), "Memorize refusal should state that memory is untouched");
	assert(!/topology|missing Recent Context/.test(learnError.message), "Memorize refusal must not surface validator structure errors");

	// 2. Same cut draft WITHOUT the truncated flag: the validator backstop still
	// catches it exactly as before (the guard fires only on the provider signal).
	const untaggedCut = await buildAbsorbProposal({ agentId, assessmentMarkdown: assessmentFixture }, ABSORB_MODEL, async () => ({ text: cutAbsorbDraft }));
	assert(untaggedCut.candidateValidation.valid === false, "validator backstop should still reject an untagged cut draft");
	assert(untaggedCut.candidateValidation.errors.some((error: string) => /Candidate L1b is empty/.test(error)), "validator backstop errors should be unchanged");

	// 3. Memorize assessment: generic refusal (small outputs, still honest).
	await expectRejects(
		() => buildAbsorbAssessment(agentId, ABSORB_MODEL, async () => truncatedResult("## Absorb assessment\n\nI found")),
		/Memorize assessment response was cut off at the model's output limit/,
		"truncated Memorize assessment",
	);

	// 4. Review proposal: same whole-document-rewrite lead as Memorize.
	const reviewError = await expectRejects(
		() => buildStructuralReviewProposal({ agentId, assessmentMarkdown: "## Prune memory assessment\n\nSynthetic." }, STRUCTURAL_REVIEW_MODEL, async () => truncatedResult("## Structural Review Proposal\n\n### Summary\ncut")),
		/too large to rewrite in one response/,
		"truncated Review proposal",
	);
	assert(/the Review draft was cut off/.test(reviewError.message), "Review refusal should name the process");

	// 5. Checkpoint: a truncated first attempt refuses immediately — the
	// missing-fields retry must NOT run (it would re-roll the same dice).
	const conversationId = "c_truncation_smoke";
	const items = [{ kind: "user" as const, id: "u1", text: "Synthetic session message for the truncation smoke." }];
	writePersistentAgentThread(agentId, conversationId, { state: "active", origin: "home", model: CHECKPOINT_MODEL, items });
	let checkpointCalls = 0;
	await expectRejects(
		() =>
			buildCheckpointProposal({ agentId, conversationId, model: CHECKPOINT_MODEL, density: "standard", items }, async () => {
				checkpointCalls += 1;
				return truncatedResult("TITLE:\nCut checkpoint\n\nSESSION_ARC:\ncut");
			}),
		/Remember response was cut off at the model's output limit/,
		"truncated Remember",
	);
	assert(checkpointCalls === 1, `truncated checkpoint must not trigger the missing-fields retry (got ${checkpointCalls} calls)`);

	// 6. Checkpoint retry path: complete-but-incomplete-fields first attempt
	// (not truncated) still retries; a truncated retry then refuses.
	checkpointCalls = 0;
	await expectRejects(
		() =>
			buildCheckpointProposal({ agentId, conversationId, model: CHECKPOINT_MODEL, density: "standard", items }, async () => {
				checkpointCalls += 1;
				if (checkpointCalls === 1) return { text: "TITLE:\nRetry smoke\n\nSESSION_ARC:\nComplete first attempt missing BODY.\n\nPARKED:\nNone\n" };
				return truncatedResult("TITLE:\nRetry cut");
			}),
		/Remember response was cut off at the model's output limit/,
		"truncated Remember retry",
	);
	assert(checkpointCalls === 2, `missing-fields retry should still run when the first attempt is complete (got ${checkpointCalls} calls)`);

	// 7. Consult: truncated answer refuses honestly instead of returning a cut answer.
	await expectRejects(
		() => buildConsultAnswer({ targetAgentId: agentId, question: "What do you know?" }, { provider: ABSORB_MODEL.provider, model: ABSORB_MODEL.model }, async () => truncatedResult("From my memory: the answer begins")),
		/consult response was cut off at the model's output limit/,
		"truncated consult",
	);

	// 8. A truncated result without usage numbers still refuses, without inventing numbers.
	const bareError = await expectRejects(
		() => buildAbsorbProposal({ agentId, assessmentMarkdown: assessmentFixture }, ABSORB_MODEL, async () => ({ text: cutAbsorbDraft, truncated: true })),
		/too large to rewrite in one response/,
		"truncated Memorize proposal without usage",
	);
	assert(!/undefined|NaN/.test(bareError.message), "refusal without usage must not render placeholder numbers");

	console.log("lifecycle-worker-truncation-smoke: PASS");
} finally {
	fs.rmSync(root, { recursive: true, force: true });
	fs.rmSync(tempHome, { recursive: true, force: true });
}
