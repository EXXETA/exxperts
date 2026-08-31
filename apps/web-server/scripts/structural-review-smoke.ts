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
	appendStructuralReviewShelfPointer,
	buildStructuralReviewAssessmentPrompt,
	buildStructuralReviewMemoryMap,
	buildStructuralReviewProposalPrompt,
	composeForgetToDocumentDocument,
	extractStructuralReviewSourceParts,
	forgetToDocumentShelfFilename,
	parseStructuralReviewAssessment,
	parseStructuralReviewProposal,
	structuralReviewDroppedMaterialConflict,
	structuralReviewMetrics,
	structuralReviewShelfPointerAdditionText,
	structuralReviewShelfPointerLine,
	STRUCTURAL_REVIEW_SHELF_POINTER_HEADING,
	structuralReviewVanishedAreaBlocks,
	structuralReviewVanishedMemoryMapAreas,
	validateStructuralReviewCandidateReviewTarget,
} = await import("../src/structural-review.js");
const { getStructuralReviewModelLock } = await import("../src/persistent-agent-ai-profiles.js");
const { ASSESSMENT_MAX_CHARS } = await import("../src/discussion-handoff.js");
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

### Dropped material
- Deep Memory / Identity and Preferences — its two bullets merged into one Collaboration and Workflow entry; no claim removed.
- Deep Memory / Product Direction / Deeper Note — subsection removed with its counting note; no durable signal.
- Active Items / High Priority — its two bullets merged into one Current Focus entry; no claim removed.

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
	assert(assessmentPrompt.prompt.includes("Keep the whole assessment under about"), "assessment prompt should state an output budget");
	assert(assessmentPrompt.prompt.includes("## Temporal Steering"), "assessment prompt should carry the Temporal Steering constitution section");
	assert(assessmentPrompt.prompt.includes('a "saved on" date, never the date the described events happened'), "temporal steering should define stamps as saved-on dates, not event dates");
	assert(!/happened on/i.test(assessmentPrompt.prompt), "review prompts must never say 'happened on'");
	assert(!assessmentPrompt.prompt.includes("## Retry Notice"), "a first assessment prompt carries no Retry Notice");
	const reassessPrompt = buildStructuralReviewAssessmentPrompt({ agentId: agentId, sourceReviewTargetL1b: parts.sourceReviewTargetL1b, model: STRUCTURAL_REVIEW_MODEL, retryFeedback: ["assessment missing Looks healthy bullets"] });
	assert(reassessPrompt.prompt.includes("## Retry Notice") && reassessPrompt.prompt.includes("- assessment missing Looks healthy bullets") && reassessPrompt.prompt.indexOf("## Retry Notice") < reassessPrompt.prompt.indexOf("## Task: Prune memory assessment"), "Reassess feedback should appear as a Retry Notice ahead of the Task");
	let reassessBuilderPrompt = "";
	await buildStructuralReviewAssessment(agentId, STRUCTURAL_REVIEW_MODEL, async (prompt) => {
		reassessBuilderPrompt = prompt;
		return { text: assessmentFixture };
	}, { retryFeedback: ["assessment missing Could be denser bullets"] });
	assert(reassessBuilderPrompt.includes("- assessment missing Could be denser bullets") && !reassessBuilderPrompt.includes("UNIQUE_CHRONOS_SENTINEL_SHOULD_NOT_REACH_OPERATOR"), "the Review assessment builder should thread Reassess feedback and still exclude Chronos");
	assert(assessmentPrompt.prompt.includes("currentTime: 2026-05-21T12:00:00.000Z"), "assessment prompt should include deterministic currentTime metadata");
	assert(assessmentPrompt.prompt.includes("UNIQUE_DEEP_MEMORY_SIGNAL_SHOULD_REACH_OPERATOR"), "assessment prompt should include review target content");
	assert(!assessmentPrompt.prompt.includes("UNIQUE_CHRONOS_SENTINEL_SHOULD_NOT_REACH_OPERATOR"), "assessment prompt must not include Chronos body");
	assert(!assessmentPrompt.prompt.includes("UNIQUE_RECENT_CONTEXT_SENTINEL_SHOULD_NOT_REACH_OPERATOR"), "assessment prompt must not include Recent Context body");
	assert(!assessmentPrompt.prompt.includes("### RC-0001"), "assessment prompt must not include Recent Context entries");
	assert(assessmentPrompt.prompt.includes("## Must-Keep Material"), "prune constitution should carry the must-keep rule");
	assert(assessmentPrompt.prompt.includes(`"### ${STRUCTURAL_REVIEW_SHELF_POINTER_HEADING}" subsection`) && /dropping or rewording one orphans that file/.test(assessmentPrompt.prompt), "prune constitution should name the Forgotten to document pointers as must-keep and say why");
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


	// --- Assessment parser tolerance + regenerate-with-feedback (Review twin) ---
	const variantReviewAssessment = assessmentFixture.replace("### Looks healthy", "## **Looks healthy:**").replace("### Could be denser", "#### Could be denser");
	const variantReviewParsed = parseStructuralReviewAssessment(variantReviewAssessment);
	assert(variantReviewParsed.fields.looksHealthy.length === 2 && variantReviewParsed.fields.couldBeDenser.length === 2, `heading-level and bold variants should parse (got ${JSON.stringify(variantReviewParsed.warnings)})`);
	const oversizedReviewAssessment = `${assessmentFixture}\n- ${"open question ".repeat(Math.ceil(ASSESSMENT_MAX_CHARS / 13) + 20)}\n`;
	assert(oversizedReviewAssessment.length > ASSESSMENT_MAX_CHARS, "oversized Review assessment fixture should exceed the cap");
	const reviewPrompts: string[] = [];
	const regeneratedReview = await buildStructuralReviewAssessment(agentId, STRUCTURAL_REVIEW_MODEL, async (prompt) => {
		reviewPrompts.push(prompt);
		return reviewPrompts.length === 1 ? { text: oversizedReviewAssessment } : { text: assessmentFixture };
	});
	assert(reviewPrompts.length === 2 && /## Retry Notice/.test(reviewPrompts[1]) && /Memory map, Looks healthy/.test(reviewPrompts[1]), "oversized Review assessment should be regenerated once with the Review structure named");
	assert(!reviewPrompts[1].includes("UNIQUE_CHRONOS_SENTINEL_SHOULD_NOT_REACH_OPERATOR"), "retry prompt must still exclude Chronos body");
	assert(regeneratedReview.assessmentMarkdown === assessmentFixture.trim() && regeneratedReview.warnings.some((warning) => /regenerated once/.test(warning)), "accepted Review retry should replace the draft and be disclosed");
	let reviewStillOversized = 0;
	try {
		await buildStructuralReviewAssessment(agentId, STRUCTURAL_REVIEW_MODEL, async () => {
			reviewStillOversized += 1;
			return { text: oversizedReviewAssessment };
		});
		throw new Error("still-oversized Review assessment should refuse");
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		assert(/Review assessment came back at \d+ characters after 2 attempt\(s\)/.test(message) && reviewStillOversized === 2, `Review size refusal should name the process after two attempts (got ${message})`);
	}

	const altAssessmentResponse = await buildStructuralReviewAssessment(agentId, CHATGPT_CODEX_STRUCTURAL_REVIEW_MODEL, async (prompt, model) => {
		assert(prompt.includes("System-selected model: openai-codex/gpt-5.6-sol"), "ChatGPT Plus/Pro structural-review prompt should use profile-mapped model metadata");
		assert(model.provider === "openai-codex" && model.model === "gpt-5.6-sol", "ChatGPT Plus/Pro structural-review assessment should pass profile-mapped model to generator");
		return { text: assessmentFixture };
	});
	assert(altAssessmentResponse.process.model.provider === "openai-codex" && altAssessmentResponse.process.model.model === "gpt-5.6-sol", "ChatGPT Plus/Pro structural-review response should report profile-mapped process model");

	const proposalPrompt = buildStructuralReviewProposalPrompt({ agentId: agentId, sourceReviewTargetL1b: parts.sourceReviewTargetL1b, model: STRUCTURAL_REVIEW_MODEL, assessmentMarkdown: assessmentFixture });
	assert(proposalPrompt.prompt.includes("Candidate review target L1b"), "proposal prompt should request candidate review target only");
	// G2: the ordering is stated twice — once in the intro, once in the template
	// — because a Dropped material section emitted after the candidate would be
	// swallowed into it by the end-of-document extractor.
	assert(proposalPrompt.prompt.includes("comes BEFORE the Candidate review target L1b section"), "proposal prompt intro should state Dropped material comes before the candidate");
	assert(proposalPrompt.prompt.includes("This section comes before the candidate — never after it."), "proposal prompt template should restate the Dropped material ordering");
	assert(proposalPrompt.prompt.indexOf("### Dropped material") > 0 && proposalPrompt.prompt.indexOf("### Dropped material") < proposalPrompt.prompt.indexOf("### Candidate review target L1b"), "proposal prompt template should place Dropped material before the candidate section");
	assert(!proposalPrompt.prompt.includes("UNIQUE_CHRONOS_SENTINEL_SHOULD_NOT_REACH_OPERATOR"), "proposal prompt must not include Chronos body");
	assert(!proposalPrompt.prompt.includes("UNIQUE_RECENT_CONTEXT_SENTINEL_SHOULD_NOT_REACH_OPERATOR"), "proposal prompt must not include Recent Context body");
	assert(proposalPrompt.prompt.includes("## Temporal Steering"), "proposal prompt should carry the Temporal Steering constitution section");
	assert(proposalPrompt.prompt.includes("with its saved-on date and the age reason"), "temporal steering should require age-driven drops to be named with their saved-on date");
	assert(!/happened on/i.test(proposalPrompt.prompt), "proposal prompt must never say 'happened on'");
	// The age prior steers within the depth rules, never past them: a light-depth
	// prompt carries both the drop-nothing rule and the never-overrides sentence.
	const lightProposalPrompt = buildStructuralReviewProposalPrompt({ agentId: agentId, sourceReviewTargetL1b: parts.sourceReviewTargetL1b, model: STRUCTURAL_REVIEW_MODEL, assessmentMarkdown: assessmentFixture, memoryBudgetTokens: 12000, hardness: "light" });
	assert(lightProposalPrompt.prompt.includes("Rephrase for density where wording is loose; drop nothing."), "light-depth proposal prompt should keep the drop-nothing rule");
	assert(lightProposalPrompt.prompt.includes("never overrides must-keep or any pruning-depth rule set for this run"), "temporal steering should state the age prior never overrides depth rules");

	const parsedProposal = parseStructuralReviewProposal(proposalFixture);
	assert(/STC_DIAGNOSTIC/.test(parsedProposal.fields.mode), "proposal parser should extract STC mode");
	assert(parsedProposal.fields.candidateReviewTargetL1b.includes("## Deep Memory"), "proposal parser should extract candidate review target");
	assert(parsedProposal.fields.droppedMaterial.includes("Deeper Note"), "proposal parser should extract Dropped material");
	assert(!parsedProposal.fields.candidateReviewTargetL1b.includes("Dropped material"), "Dropped material must not leak into the extracted candidate");
	const withoutDroppedMaterial = parseStructuralReviewProposal(proposalFixture.replace(/### Dropped material[\s\S]*?(?=### Candidate review target L1b)/, ""));
	assert(withoutDroppedMaterial.warnings.includes("proposal missing Dropped material"), "a proposal without a Dropped material section should warn");
	// A section misplaced AFTER the candidate heading belongs to the candidate:
	// the parser must not render a disclosure from it (the missing warning
	// fires instead, and the candidate-side validator error blocks approval).
	const misplacedProposal = parseStructuralReviewProposal(`${proposalFixture.replace(/### Dropped material[\s\S]*?(?=### Candidate review target L1b)/, "")}\n\n### Dropped material\n- Misplaced drop list\n`);
	assert(misplacedProposal.fields.droppedMaterial === "", "a Dropped material section after the candidate must not populate the disclosure field");
	assert(misplacedProposal.warnings.includes("proposal missing Dropped material"), "a misplaced Dropped material section should still warn as missing");
	assert(misplacedProposal.fields.candidateReviewTargetL1b.includes("Misplaced drop list"), "the misplaced section is candidate content and must trip the candidate-side error");
	// A bent heading in the CORRECT position still parses — a strict match
	// would render a false "Not stated by this draft" over a stated list.
	for (const bentHeading of ["### Dropped material:", "### **Dropped material**", "#### Dropped material", "   ### Dropped material"]) {
		const bentParsed = parseStructuralReviewProposal(proposalFixture.replace("### Dropped material", bentHeading));
		assert(bentParsed.fields.droppedMaterial.includes("Deeper Note"), `a bent Dropped material heading before the candidate should still parse (${bentHeading})`);
		assert(!bentParsed.warnings.includes("proposal missing Dropped material"), `a bent heading in the correct position must not read as missing (${bentHeading})`);
	}
	const goodValidation = validateStructuralReviewCandidateReviewTarget(parts.sourceReviewTargetL1b, parsedProposal.fields.candidateReviewTargetL1b);
	assert(goodValidation.valid, `candidate review target should validate: ${goodValidation.errors.join("; ")}`);

	const badValidation = validateStructuralReviewCandidateReviewTarget(parts.sourceReviewTargetL1b, `${candidateReviewTarget}\n\n## Recent Context\n\nLeaked RC\n`);
	assert(!badValidation.valid, "candidate with Recent Context top-level section should be rejected");
	assert(badValidation.errors.some((error) => /exactly Deep Memory and Active Items/.test(error)), "bad candidate rejection should explain review-target topology");
	// A "### Dropped material" inside the candidate is a level-3 heading the
	// topology check never sees — without its own error the drop list would be
	// approved into memory as candidate content.
	const swallowedValidation = validateStructuralReviewCandidateReviewTarget(parts.sourceReviewTargetL1b, `${candidateReviewTarget}\n\n### Dropped material\n\n- Swallowed drop list\n`);
	assert(!swallowedValidation.valid && swallowedValidation.errors.some((error) => /must not contain a Dropped material section/.test(error)), "a Dropped material section swallowed into the candidate should be rejected");
	// The worker likely to misplace the section is the worker likely to bend
	// its shape too: every heading level, markdown's 3-space indent, emphasis
	// wrappers, loose spacing, and trailing punctuation must all trip.
	for (const bent of ["#### Dropped material:", "# Dropped material", "   ### Dropped material", "### **Dropped material**", "### Dropped  material"]) {
		const bentValidation = validateStructuralReviewCandidateReviewTarget(parts.sourceReviewTargetL1b, `${candidateReviewTarget}\n\n${bent}\n\n- Swallowed drop list\n`);
		assert(!bentValidation.valid && bentValidation.errors.some((error) => /must not contain a Dropped material section/.test(error)), `a bent-shape Dropped material heading inside the candidate should be rejected (${bent})`);
	}
	// A source that legitimately carries such a heading as user memory is
	// exempt — erroring there would block every Review of that room.
	const sourceWithHeading = `${parts.sourceReviewTargetL1b.trimEnd()}\n\n### Dropped material\n\n- Legitimate user subsection.\n`;
	const exemptValidation = validateStructuralReviewCandidateReviewTarget(sourceWithHeading, sourceWithHeading);
	assert(exemptValidation.errors.every((error) => !/must not contain a Dropped material section/.test(error)), "a Dropped material heading already present in the source must not be blamed on the draft");
	// A present-but-"None." disclosure is contradicted by the deterministic
	// map diff when whole areas vanish; a truthful disclosure is not.
	const noneConflict = structuralReviewDroppedMaterialConflict("None.", parts.sourceReviewTargetL1b, candidateReviewTarget);
	assert(typeof noneConflict === "string" && /Identity and Preferences/.test(noneConflict) && noneConflict.startsWith("proposal "), "a None. disclosure over vanished areas should be contradicted with a proposal-prefixed warning");
	assert(/these areas are/.test(noneConflict!), "a multi-area contradiction should speak in the plural");
	// A styled none is still a none: emphasis wrappers must not slip a false
	// claim past the check.
	for (const styledNone of ["**None.**", "_None._", "`None.`", "*None detected.*", "+ None.", "1. None."]) {
		assert(typeof structuralReviewDroppedMaterialConflict(styledNone, parts.sourceReviewTargetL1b, candidateReviewTarget) === "string", `a styled none should still be contradicted (${styledNone})`);
	}
	assert(structuralReviewDroppedMaterialConflict(parsedProposal.fields.droppedMaterial, parts.sourceReviewTargetL1b, candidateReviewTarget) === undefined, "a substantive disclosure should not be contradicted");
	assert(structuralReviewDroppedMaterialConflict("None.", parts.sourceReviewTargetL1b, parts.sourceReviewTargetL1b) === undefined, "None. over an unchanged review target should not warn");
	assert(structuralReviewDroppedMaterialConflict("None.", parts.sourceReviewTargetL1b, "") === undefined, "an empty candidate is owned by the missing-candidate warning, not a stacked false conflict");
	// Exactly one vanished area speaks in the singular — the client translation
	// keys on both grammatical forms.
	const singleAreaCandidate = parts.sourceReviewTargetL1b.replace(/### Identity and Preferences[\s\S]*?(?=### Product Direction)/, "");
	const singleConflict = structuralReviewDroppedMaterialConflict("None.", parts.sourceReviewTargetL1b, singleAreaCandidate);
	assert(typeof singleConflict === "string" && /this area is no longer/.test(singleConflict), "a single-area contradiction should speak in the singular");
	// A substantive disclosure that never mentions a vanished area's heading
	// is incomplete, not compliant — the deterministic check covers it too.
	const partialConflict = structuralReviewDroppedMaterialConflict("- Deep Memory / Identity and Preferences — merged into Collaboration and Workflow.", parts.sourceReviewTargetL1b, candidateReviewTarget);
	assert(typeof partialConflict === "string" && /does not name/.test(partialConflict) && /High Priority/.test(partialConflict) && !/Identity and Preferences/.test(partialConflict), "a disclosure naming only one of two vanished areas should be contradicted for the unnamed one");
	const leafOnlyDisclosure = structuralReviewDroppedMaterialConflict("- Identity and Preferences and High Priority — both merged onward.", parts.sourceReviewTargetL1b, candidateReviewTarget);
	assert(leafOnlyDisclosure === undefined, "naming vanished areas by their leaf headings alone should satisfy the check");

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
	// The proposal carries the server's own vanished-area list (the ONE count-
	// aware computation), so the client can offer forget-to-document even when
	// the disclosure is none-like or omitted.
	assert(Array.isArray(proposalResponse.vanishedAreas) && JSON.stringify(proposalResponse.vanishedAreas) === JSON.stringify(structuralReviewVanishedMemoryMapAreas(extractStructuralReviewSourceParts(readL1b()).sourceReviewTargetL1b, proposalResponse.fields.candidateReviewTargetL1b)), "proposal response should carry the count-aware vanished-area list");
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

	// Slice 7: forget-to-document pure pieces — vanished-area extraction, the
	// composed document, the pointer line and its anchor, the shelf filename.
	{
		const ftdSource = "## Deep Memory\n\nCore line.\n\n### Old roadmap\n\n- plan A (saved 2026-01-05)\n\n## Active Items\n\n- open item\n";
		const ftdCandidate = "## Deep Memory\n\nCore line.\n\n## Active Items\n\n- open item\n";
		const approvedAt = new Date("2026-08-27T10:00:00.000Z");
		const vanished = structuralReviewVanishedAreaBlocks(ftdSource, ftdCandidate);
		assert(vanished.length === 1 && vanished[0].area === "Deep Memory / Old roadmap" && vanished[0].body.includes("plan A"), "vanished-area extraction should return the dropped subsection with its full source text");
		assert(structuralReviewVanishedAreaBlocks(ftdSource, ftdSource).length === 0, "an unchanged candidate should have no vanished areas");
		const document = composeForgetToDocumentDocument({ structuralReviewId: "structural_review_smoke_1", approvedAt, droppedMaterial: "- Old roadmap (saved 2026-01-05) — superseded.", sectionLevelChangeLog: "| Section | Prior Tokens | Candidate Tokens | Disposition | Rationale |", sourceReviewTargetL1b: ftdSource, candidateReviewTargetL1b: ftdCandidate });
		assert(document.includes("# Forgotten to document — saved 2026-08-27"), "document title should carry the saved-on date");
		assert(document.includes("Prune id: structural_review_smoke_1"), "document should carry the Prune id");
		assert(document.includes("Deep Memory / Old roadmap") && document.includes("plan A"), "document should carry the vanished area's full text");
		assert(document.includes("Old roadmap (saved 2026-01-05) — superseded."), "document should carry the disclosure verbatim");
		assert(!/happened on/i.test(document), "document must never say 'happened on'");
		const sparseDocument = composeForgetToDocumentDocument({ structuralReviewId: "structural_review_smoke_2", approvedAt, droppedMaterial: "", sectionLevelChangeLog: "", sourceReviewTargetL1b: ftdSource, candidateReviewTargetL1b: ftdSource });
		assert(sparseDocument.includes("Not stated by the applied draft.") && sparseDocument.includes("None — no whole section vanished"), "document should state omissions instead of hiding them");
		assert(forgetToDocumentShelfFilename(approvedAt) === "Pruned memory 2026-08-27.md", "shelf filename should carry the saved-on date");
		const pointer = structuralReviewShelfPointerLine("Pruned memory 2026-08-27.md", approvedAt);
		assert(pointer.includes('"Pruned memory 2026-08-27.md"') && pointer.includes("saved 2026-08-27"), "pointer line should name the file and the saved-on date");
		assert(pointer.startsWith("- **must-keep**"), "pointer line should carry the must-keep marker the constitution protects");
		const pointered = appendStructuralReviewShelfPointer(ftdCandidate, pointer);
		assert(pointered.indexOf(pointer) > 0 && pointered.indexOf(pointer) < pointered.indexOf("## Active Items"), "pointer should land at the end of Deep Memory, before Active Items");
		const pointerHeading = `### ${STRUCTURAL_REVIEW_SHELF_POINTER_HEADING}`;
		assert(pointered.indexOf(pointerHeading) > 0 && pointered.indexOf(pointerHeading) < pointered.indexOf(pointer), "the first export should create the Forgotten to document subsection above the pointer");
		const pointeredValidation = validateStructuralReviewCandidateReviewTarget(ftdSource, pointered);
		assert(pointeredValidation.valid, `a pointered candidate should still pass validation: ${pointeredValidation.errors.join("; ")}`);
		assert(structuralReviewShelfPointerAdditionText(ftdCandidate, pointer) === `${pointerHeading}\n\n${pointer}`, "the first export's cost text should be heading plus line");
		// A second export appends under the existing subsection — one area name,
		// never a twin heading — and its cost text is the line alone.
		const secondPointer = structuralReviewShelfPointerLine("Pruned memory 2026-09-01.md", new Date("2026-09-01T10:00:00.000Z"));
		const twicePointered = appendStructuralReviewShelfPointer(pointered, secondPointer);
		assert(twicePointered.split(pointerHeading).length === 2, "a second export must not add a second Forgotten to document heading");
		assert(twicePointered.indexOf(secondPointer) > twicePointered.indexOf(pointer) && twicePointered.indexOf(secondPointer) < twicePointered.indexOf("## Active Items"), "a second pointer should follow the first under the same subsection");
		assert(structuralReviewShelfPointerAdditionText(pointered, secondPointer) === secondPointer, "a later export's cost text should be the line alone");
		assert(buildStructuralReviewMemoryMap(twicePointered).filter((row) => row.area === `Deep Memory / ${STRUCTURAL_REVIEW_SHELF_POINTER_HEADING}`).length === 1, "the pointer subsection should be exactly one memory-map area");
		// The subsection is appended to even when a Prune moved it away from the
		// end of Deep Memory, and the appended line stays inside it.
		const movedPointered = `## Deep Memory\n\n${pointerHeading}\n\n${pointer}\n\n### Later notes\n\n- kept\n\n## Active Items\n\n- open item\n`;
		const movedTwice = appendStructuralReviewShelfPointer(movedPointered, secondPointer);
		assert(movedTwice.indexOf(secondPointer) < movedTwice.indexOf("### Later notes") && movedTwice.split(pointerHeading).length === 2, "a later export should append inside the existing subsection wherever it sits in Deep Memory");
		assert(validateStructuralReviewCandidateReviewTarget(ftdSource, movedTwice).valid, "a moved, twice-pointered candidate should still validate");
		// M1 (S2 review): a SECOND Review over a pointer-carrying room. A
		// candidate that keeps the subsection is clean; one that drops the
		// pointer vanishes a memory-map area, so a "None." disclosure is a
		// conflict (fast path refused, Dropped material card names it) and a
		// truthful disclosure must name the subsection.
		const pointerKept = pointered.replace("Core line.", "Core line, tightened.");
		assert(structuralReviewVanishedMemoryMapAreas(pointered, pointerKept).length === 0 && structuralReviewDroppedMaterialConflict("None.", pointered, pointerKept) === undefined, "a second Review that keeps the pointer subsection should raise no vanished area");
		const pointerDropped = pointered.replace(`${pointerHeading}\n\n${pointer}\n\n`, "");
		assert(!pointerDropped.includes("Forgotten to document"), "smoke setup: the pointer subsection should be gone from the dropped candidate");
		const pointerVanished = structuralReviewVanishedMemoryMapAreas(pointered, pointerDropped);
		assert(pointerVanished.length === 1 && pointerVanished[0] === `Deep Memory / ${STRUCTURAL_REVIEW_SHELF_POINTER_HEADING}`, `dropping the pointer subsection should vanish exactly its area: ${pointerVanished.join(", ")}`);
		const pointerNoneConflict = structuralReviewDroppedMaterialConflict("None.", pointered, pointerDropped);
		assert(pointerNoneConflict !== undefined && /says none/.test(pointerNoneConflict) && pointerNoneConflict.includes(STRUCTURAL_REVIEW_SHELF_POINTER_HEADING), `a None. disclosure over a dropped pointer must warn: ${pointerNoneConflict}`);
		const pointerUnnamedConflict = structuralReviewDroppedMaterialConflict("- Old roadmap — superseded.", pointered, pointerDropped);
		assert(pointerUnnamedConflict !== undefined && /does not name/.test(pointerUnnamedConflict) && pointerUnnamedConflict.includes(STRUCTURAL_REVIEW_SHELF_POINTER_HEADING), `a disclosure silent on the dropped pointer must warn: ${pointerUnnamedConflict}`);
		assert(structuralReviewDroppedMaterialConflict("- Forgotten to document — pointer removed on user direction.", pointered, pointerDropped) === undefined, "a disclosure naming the pointer subsection passes the guard");
		assert(structuralReviewVanishedAreaBlocks(pointered, pointerDropped).some((block) => block.body.includes("Pruned memory 2026-08-27.md")), "a dropped pointer subsection is captured in full by the next export");
		// A REWORDED pointer under a surviving heading is below the area-level
		// check — that case is owned by the constitution's must-keep rule, and
		// the smoke records the limit rather than pretending coverage.
		const pointerReworded = pointered.replace(pointer, "- see Files");
		assert(structuralReviewVanishedMemoryMapAreas(pointered, pointerReworded).length === 0, "rewording inside the surviving subsection is below the area-level check (honest limit)");
		// Same-named twins collapse to one memory-map name: dropping one twin
		// must still capture (count-aware, every section of that name), never
		// claim "None vanished".
		const dupSource = "## Deep Memory\n\n### Notes\n\n- first twin\n\n### Notes\n\n- second twin\n\n## Active Items\n\n- open item\n";
		const dupCandidate = "## Deep Memory\n\n### Notes\n\n- first twin\n\n## Active Items\n\n- open item\n";
		const dupVanished = structuralReviewVanishedAreaBlocks(dupSource, dupCandidate);
		assert(dupVanished.length === 2 && dupVanished.every((block) => block.area === "Deep Memory / Notes"), "dropping a same-named twin should capture every source section of that name");
		const dupDocument = composeForgetToDocumentDocument({ structuralReviewId: "structural_review_smoke_3", approvedAt, droppedMaterial: "- One Notes section — merged into the other.", sectionLevelChangeLog: "", sourceReviewTargetL1b: dupSource, candidateReviewTargetL1b: dupCandidate });
		assert(dupDocument.includes("first twin") && dupDocument.includes("second twin") && !dupDocument.includes("None — no whole section vanished"), "the document must not claim nothing vanished when a same-named twin was dropped");
		// The survivor is among the copies: the document must say so, in the
		// block labels and in the Honest limit — never a bare "no longer in memory".
		assert(dupDocument.includes("one of 2 same-named sections; 1 of that name remains in memory"), "twin block labels should state that a copy may still be in memory");
		assert(dupDocument.includes("Where a section name appears more than once above (Deep Memory / Notes)"), "the Honest limit should name the twin areas whose survivor may be among the copies");
		assert(!document.includes("same-named") && !document.includes("Where a section name appears more than once"), "a document without twins should carry no twin caveat");
		// Every copy vanished: nothing to tell apart, so no survivor hedge.
		const allGoneCandidate = "## Deep Memory\n\nCore line.\n\n## Active Items\n\n- open item\n";
		const allGoneDocument = composeForgetToDocumentDocument({ structuralReviewId: "structural_review_smoke_4", approvedAt, droppedMaterial: "- Both Notes sections — obsolete.", sectionLevelChangeLog: "", sourceReviewTargetL1b: dupSource, candidateReviewTargetL1b: allGoneCandidate });
		assert(allGoneDocument.includes("one of 2 same-named sections, all removed by this Prune") && allGoneDocument.includes("first twin") && allGoneDocument.includes("second twin"), "when every twin vanished the label should say all were removed");
		assert(!allGoneDocument.includes("may still be in memory") && !allGoneDocument.includes("0 of that name remain"), "when every twin vanished the document must not hedge about a survivor");
		// A contradicted or omitted disclosure is flagged beside the quote, never
		// presented as the record of what was dropped.
		const noneDocument = composeForgetToDocumentDocument({ structuralReviewId: "structural_review_smoke_5", approvedAt, droppedMaterial: "None.", sectionLevelChangeLog: "", sourceReviewTargetL1b: ftdSource, candidateReviewTargetL1b: ftdCandidate });
		assert(noneDocument.includes("None.\n\nAt approval this disclosure was found to be contradicted: it says nothing was dropped, but this memory area is gone from the applied draft: Deep Memory / Old roadmap."), `a contradicted None. should be flagged beside the quote in product words: ${noneDocument}`);
		const partialDocument = composeForgetToDocumentDocument({ structuralReviewId: "structural_review_smoke_7", approvedAt, droppedMaterial: "- Something else — tightened.", sectionLevelChangeLog: "", sourceReviewTargetL1b: ftdSource, candidateReviewTargetL1b: ftdCandidate });
		assert(partialDocument.includes("At approval this disclosure was found incomplete: it does not mention this memory area, which is gone from the applied draft: Deep Memory / Old roadmap."), `an incomplete disclosure should be flagged in product words: ${partialDocument}`);
		assert(!/candidate/i.test(noneDocument) && !/candidate/i.test(partialDocument), "the document never speaks the internal 'candidate' vocabulary");
		const omittedDocument = composeForgetToDocumentDocument({ structuralReviewId: "structural_review_smoke_6", approvedAt, droppedMaterial: "", sectionLevelChangeLog: "", sourceReviewTargetL1b: ftdSource, candidateReviewTargetL1b: ftdCandidate });
		assert(omittedDocument.includes("Not stated by the applied draft.\n\nThe draft did not state its drops.") && omittedDocument.includes("plan A"), "an omitted disclosure over a vanished area should be flagged and the area still captured");
		assert(!document.includes("found incomplete") && !document.includes("did not state its drops"), "a truthful disclosure carries no contradiction note");
		// The disclosure guard reads the SAME count-aware computation: a false
		// "None." over a dropped twin must warn (it blocks fast path and keeps
		// the export choice reachable on the manual card).
		const dupConflict = structuralReviewDroppedMaterialConflict("None.", dupSource, dupCandidate);
		assert(dupConflict !== undefined && /says none/.test(dupConflict) && dupConflict.includes("Deep Memory / Notes"), `a false None. over a dropped same-named twin should warn: ${dupConflict}`);
		assert(structuralReviewDroppedMaterialConflict("- One Notes section — merged into the other.", dupSource, dupCandidate) === undefined, "a disclosure naming the twin's heading should pass the guard");
	}

	fs.rmSync(root, { recursive: true, force: true });
	console.log("structural review smoke passed");
} catch (error) {
	console.error(error instanceof Error ? error.stack || error.message : error);
	console.error(`temp root preserved for inspection: ${root}`);
	process.exitCode = 1;
}
