// Slice 4 of the memory-budget-enforcement branch: the budget stops being
// advisory in Review. This pins (a) the ONE hardness derivation (light /
// standard / deep, previous-partial escalation) and where it rides (Review
// availability + room status, same struct), (b) the enforcement loop in the
// propose step — retry only when the candidate lands over budget, truncation
// refused BEFORE any retry, one merged Retry Notice (never two), usage merged,
// retry kept only when not worse, and a still-over final draft returned as a
// DISCLOSED partial prune instead of a refusal — and (c) the per-run hardness
// override. Tests import the real constants and functions — never a copy.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "exxeta-review-enforcement-home-"));
process.env.HOME = tempHome;
process.env.USERPROFILE = tempHome;
const smokeAppDir = path.join(tempHome, ".exxperts", "app");
fs.mkdirSync(smokeAppDir, { recursive: true });
fs.writeFileSync(
	path.join(smokeAppDir, "openai-compatible-ai-profile.json"),
	JSON.stringify({ profileId: "openai-compatible", providerId: "openai-compatible", label: "Synthetic Gateway", roomModels: [{ modelId: "gpt-5.5" }], maintenanceModel: "gpt-5.5" }, null, 2),
);
fs.writeFileSync(path.join(smokeAppDir, "persistent-agent-ai-profile.json"), JSON.stringify({ profileId: "openai-compatible" }, null, 2));
const root = fs.mkdtempSync(path.join(os.tmpdir(), "exxeta-review-enforcement-"));
process.env.EXXETA_PERSISTENT_AGENTS_ROOT = root;

const { buildStructuralReviewProposal, createPersistentAgentFromScaffoldInput, getPersistentAgentStatus, getStructuralReviewAvailability, reviewTargetEstimatedTokensFromL1b } = await import("../src/persistent-agents.js");
const { deriveReviewHardness, overMemoryBudget, writePersistentRoomMaintenanceSettings, MEMORY_BUDGET_MIN_TOKENS, REVIEW_HARDNESS_DEEP_OVERAGE_RATIO } = await import("../src/persistent-room-maintenance-settings.js");
const { getStructuralReviewModelLock } = await import("../src/persistent-agent-ai-profiles.js");
const MODEL = getStructuralReviewModelLock("openai-compatible");

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

const agentId = "review-enforcement-smoke-room";
const agentRoot = path.join(root, agentId);
const l1bPath = path.join(agentRoot, "L1b", "current.md");
const reviewEventsDir = path.join(agentRoot, "events", "structural-review");
const absorbEventsDir = path.join(agentRoot, "events", "absorb");

function writeL1b(deepChars: number): string {
	const deepFiller = `- ${"deep memory content ".repeat(Math.ceil(Math.max(deepChars, 20) / 20))}`;
	const l1b = `<!-- exxeta:l1b schema_version=1 -->

## Chronos

- Lifecycle state: ready

## Deep Memory

${deepFiller}

## Active Items

- One live thread.

## Recent Context

### RC-0001 | OPEN | 2026-08-20 | Session 1

**Session arc:** Session 1.

**Body:**
- durable signal
`;
	fs.writeFileSync(l1bPath, l1b, "utf-8");
	return l1b;
}

const assessmentFixture = `## Prune memory assessment

### Memory map
| Area | Words | Estimated tokens |
|---|---:|---:|
| Deep Memory | 10 | 20 |

### Looks healthy
- Deep memory content is durable.
- Active item is live.

### Stale or drift-prone
- None detected.

### Could be denser
- Deep memory filler can be tightened.

### Structure opportunities
- Keep the single-thread shape.

### Proposed direction
- Tighten filler while preserving the live thread.
`;

function candidateDoc(padWords: number): string {
	const pad = padWords > 0 ? `\n- ${"pad ".repeat(padWords)}` : "";
	return `## Deep Memory

- One durable fact.${pad}

## Active Items

- One thread.
`;
}

function proposalDoc(candidate: string): string {
	return `## Prune Memory Proposal

### Mode
STC_DIAGNOSTIC

### Summary
Tighten filler.

### Section-Level Change Log
| Section | Prior Tokens | Candidate Tokens | Disposition | Rationale |
|---|---:|---:|---|---|
| Deep Memory | 100 | 50 | tighten | Filler removed. |

### Subsection / Entry Detail
| Area | Operation | Rationale |
|---|---|---|
| Deep Memory | tighten | Filler removed. |

### Staleness Flags
None detected.

### Proposed Memory Map
| Area | Words | Estimated tokens |
|---|---:|---:|
| Deep Memory | 5 | 10 |

### Review Target Metrics
- Review target words before: 10
- Review target words after: 5
- Review target estimated tokens before: 20
- Review target estimated tokens after: 10
- Estimated token delta: -10

### Warnings
None

### Dropped material
- Deep Memory filler — repeated filler wording compressed to the one durable fact; no distinct claim removed.

### Candidate review target L1b
${candidate}`;
}

function eventRecord(afterTokens: number): string {
	return JSON.stringify({ schemaVersion: 1, operation: "structural_review", structuralReview: { reviewTargetEstimatedTokensAfter: afterTokens } }, null, 2);
}

try {
	createPersistentAgentFromScaffoldInput({ displayName: "Review Enforcement Smoke Room", userName: "Synthetic User", preferredUserAddress: "Synthetic User" });
	const budget = MEMORY_BUDGET_MIN_TOKENS;
	writePersistentRoomMaintenanceSettings(agentId, { memoryBudgetTokens: budget });

	// --- The ONE derivation: boundary pins on the real function ---
	const deepStep = Math.round(budget * REVIEW_HARDNESS_DEEP_OVERAGE_RATIO);
	assert(deriveReviewHardness(budget, budget, false) === "light", "at the budget is not over: light");
	assert(deriveReviewHardness(budget + 1, budget, false) === "standard", "one token over derives standard");
	assert(deriveReviewHardness(budget + deepStep, budget, false) === "standard", "exactly the deep ratio stays standard (strict >)");
	assert(deriveReviewHardness(budget + deepStep + 1, budget, false) === "deep", "past the deep ratio derives deep");
	assert(deriveReviewHardness(budget + 1, budget, true) === "deep", "a previous partial escalates an over-budget room to deep");
	assert(deriveReviewHardness(budget, budget, true) === "light", "an under-budget room never escalates, previous partial or not");

	// --- Derivation rides availability AND status, same struct, same numbers ---
	writeL1b(4 * (budget + 1_000)); // review target ~1k over: standard territory
	const availability = getStructuralReviewAvailability(agentId);
	assert(availability.available && availability.reviewHardness, "an available room should carry the hardness derivation");
	const derived = availability.reviewHardness!;
	assert(derived.level === "standard" && derived.budgetTokens === budget && derived.previousRunPartial === false, `modestly over should derive standard (got ${JSON.stringify(derived)})`);
	assert(derived.overBudgetTokens === derived.reviewTargetEstimatedTokens - budget && derived.overBudgetTokens > 0, "overBudgetTokens is the distance past the ceiling");
	assert(derived.level === deriveReviewHardness(derived.reviewTargetEstimatedTokens, derived.budgetTokens, derived.previousRunPartial), "the availability level IS the one derivation function");
	assert(derived.reviewTargetEstimatedTokens === reviewTargetEstimatedTokensFromL1b(fs.readFileSync(l1bPath, "utf-8")), "the derivation measures through the ONE numerator, never the metrics-family whole-string estimate");
	const status = getPersistentAgentStatus(agentId);
	assert(status.memoryBudget?.reviewHardness, "room status should carry the same derivation block");
	assert(JSON.stringify(status.memoryBudget!.reviewHardness) === JSON.stringify(derived), "status and Review availability must agree to the token — one derivation, two surfaces");

	writeL1b(4 * (budget + deepStep + 1_000)); // well past the deep ratio
	assert(getStructuralReviewAvailability(agentId).reviewHardness!.level === "deep", "far over budget derives deep");

	// --- previousRunPartial: latest Review event still-over escalates; a newer Memorize resets ---
	writeL1b(4 * (budget + 1_000)); // back to standard territory by distance
	fs.mkdirSync(reviewEventsDir, { recursive: true });
	fs.writeFileSync(path.join(reviewEventsDir, "structural_review_20260826T090000Z_aaaaaa.json"), eventRecord(budget + 500));
	let hardness = getStructuralReviewAvailability(agentId).reviewHardness!;
	assert(hardness.previousRunPartial === true && hardness.level === "deep", `a still-over Review event escalates to deep (got ${JSON.stringify(hardness)})`);
	fs.mkdirSync(absorbEventsDir, { recursive: true });
	fs.writeFileSync(path.join(absorbEventsDir, "absorb_20260826T100000Z_bbbbbb.json"), JSON.stringify({ operation: "absorb" }));
	hardness = getStructuralReviewAvailability(agentId).reviewHardness!;
	assert(hardness.previousRunPartial === false && hardness.level === "standard", "a Memorize after the partial Review resets the escalation");
	fs.writeFileSync(path.join(reviewEventsDir, "structural_review_20260826T110000Z_cccccc.json"), eventRecord(budget - 500));
	hardness = getStructuralReviewAvailability(agentId).reviewHardness!;
	assert(hardness.previousRunPartial === false, "a Review that ended under budget is not a partial");
	// A slice-4 record carries the one-numerator verdict; it outranks the
	// metrics-family after-count when both are present.
	fs.writeFileSync(
		path.join(reviewEventsDir, "structural_review_20260826T120000Z_dddddd.json"),
		JSON.stringify({ schemaVersion: 1, operation: "structural_review", structuralReview: { reviewTargetEstimatedTokensAfter: budget + 1 }, memoryBudget: { budgetTokens: budget, reviewTargetEstimatedTokens: budget, overBudget: false } }, null, 2),
	);
	hardness = getStructuralReviewAvailability(agentId).reviewHardness!;
	assert(hardness.previousRunPartial === false, "the record's one-numerator verdict outranks the metrics-family after-count");
	fs.rmSync(reviewEventsDir, { recursive: true, force: true });
	fs.rmSync(absorbEventsDir, { recursive: true, force: true });

	// --- The prompt's over/under statement comes from the predicate, not the depth label ---
	let overrideLightPrompt = "";
	await buildStructuralReviewProposal({ agentId, assessmentMarkdown: assessmentFixture, hardness: "light" }, MODEL, async (prompt) => {
		overrideLightPrompt = prompt;
		return { text: proposalDoc(candidateDoc(0)) };
	});
	assert(overrideLightPrompt.includes("Pruning depth: light") && overrideLightPrompt.includes("— over it") && !overrideLightPrompt.includes("currently fits"), "light overridden onto an over-budget room must not claim the room fits");
	let derivedOverPrompt = "";
	await buildStructuralReviewProposal({ agentId, assessmentMarkdown: assessmentFixture }, MODEL, async (prompt) => {
		derivedOverPrompt = prompt;
		return { text: proposalDoc(candidateDoc(0)) };
	});
	assert(derivedOverPrompt.includes("Pruning depth: standard") && derivedOverPrompt.includes("— over it"), "a derived-standard room states its over-budget position to the worker");

	// --- Enforcement loop: under-budget outcome = one attempt, zero change ---
	writeL1b(400); // small room: derives light
	const originalL1b = fs.readFileSync(l1bPath, "utf-8");
	const slimCandidate = candidateDoc(0);
	assert(!overMemoryBudget(reviewTargetEstimatedTokensFromL1b(slimCandidate), budget), "slim candidate fixture sits under the budget");
	const fatCandidate = candidateDoc(budget + 2_000); // "pad " ≈ 1 estimated token per repeat → comfortably over
	assert(overMemoryBudget(reviewTargetEstimatedTokensFromL1b(fatCandidate), budget), "fat candidate fixture lands over the budget");
	const fatterCandidate = candidateDoc(budget + 6_000);
	assert(reviewTargetEstimatedTokensFromL1b(fatterCandidate) > reviewTargetEstimatedTokensFromL1b(fatCandidate), "fatter candidate fixture is worse than fat");

	let cleanPrompts: string[] = [];
	const clean = await buildStructuralReviewProposal({ agentId, assessmentMarkdown: assessmentFixture }, MODEL, async (prompt) => {
		cleanPrompts.push(prompt);
		return { text: proposalDoc(slimCandidate), usage: { input: 50, output: 60, totalTokens: 110, cost: 0 } };
	});
	assert(cleanPrompts.length === 1, "an under-budget candidate is never retried");
	assert(cleanPrompts[0].includes("Pruning depth: light"), "an under-budget room drafts at light depth");
	assert(cleanPrompts[0].includes("currently fits"), "an actually-under room may hear that it fits");
	assert(cleanPrompts[0].includes("drop nothing"), "light depth tells the worker to drop nothing");
	assert(!cleanPrompts[0].includes("## Retry Notice"), "a first draft carries no Retry Notice");
	assert(clean.reviewHardness.applied === "light" && clean.reviewHardness.overridden === false && clean.reviewHardness.derived.level === "light", "the response reports the applied depth and its derivation");
	assert(!clean.warnings.some((warning) => /drafted again/.test(warning)), "no retry means no retry disclosure");
	assert(clean.structuralReviewUsage?.totalTokens === 110, "a single attempt reports its own usage");

	// --- Enforcement loop: over-budget candidate is retried once with the size reasons ---
	let retryPrompts: string[] = [];
	const enforced = await buildStructuralReviewProposal({ agentId, assessmentMarkdown: assessmentFixture }, MODEL, async (prompt) => {
		retryPrompts.push(prompt);
		return { text: proposalDoc(retryPrompts.length === 1 ? fatCandidate : slimCandidate), usage: { input: 50, output: 60, totalTokens: 110, cost: 0 } };
	});
	assert(retryPrompts.length === 2, "an over-budget candidate is drafted once more");
	assert((retryPrompts[1].match(/## Retry Notice/g) ?? []).length === 1, "the retry carries exactly one Retry Notice");
	assert(/estimated tokens, ~\d+ over the room's \d+-token memory budget/.test(retryPrompts[1]), "the Retry Notice carries the size reasons in tokens");
	assert(/never drop must-keep entries or provenance to fit/.test(retryPrompts[1]), "the size reason restates the constitution guard");
	assert(enforced.fields.candidateReviewTargetL1b.trim() === slimCandidate.trim(), "an under-budget retry replaces the over-budget first draft");
	assert(enforced.warnings.some((warning) => /^the proposal was drafted again once \(first draft: .*memory budget.*\)$/.test(warning)), "the disclosure carries the exact shape and the 'memory budget' words the client translation keys on");
	assert(enforced.memoryBudgetImpact.overBudgetAfter === false, "the accepted retry reads under budget on the card");
	assert(enforced.structuralReviewUsage?.totalTokens === 220, "both attempts' usage is merged");

	// --- Accept-only-if-better: a worse retry is discarded, first draft disclosed as partial ---
	let notBetterPrompts = 0;
	const notBetter = await buildStructuralReviewProposal({ agentId, assessmentMarkdown: assessmentFixture }, MODEL, async () => {
		notBetterPrompts += 1;
		return { text: proposalDoc(notBetterPrompts === 1 ? fatCandidate : fatterCandidate) };
	});
	assert(notBetterPrompts === 2, "the loop caps at two attempts");
	assert(notBetter.fields.candidateReviewTargetL1b.trim() === fatCandidate.trim(), "a worse retry never replaces the first draft");
	assert(notBetter.warnings.some((warning) => /was not better, so the first is shown/.test(warning)), "the discarded retry is disclosed");
	assert(notBetter.memoryBudgetImpact.overBudgetAfter === true, "a still-over final draft returns as a disclosed partial prune, not a refusal");
	assert(notBetter.candidateValidation.valid, "the partial prune stays approvable — the floor is a disclosed partial, never a dead end");

	// --- Truncation is refused BEFORE the budget retry ---
	let truncatedCalls = 0;
	let truncationRefused = "";
	try {
		await buildStructuralReviewProposal({ agentId, assessmentMarkdown: assessmentFixture }, MODEL, async () => {
			truncatedCalls += 1;
			return { text: proposalDoc(fatCandidate), truncated: true, usage: { output: 999 }, modelMaxOutputTokens: 1000 };
		});
		throw new Error("a truncated first draft should refuse");
	} catch (error) {
		truncationRefused = error instanceof Error ? error.message : String(error);
	}
	assert(truncatedCalls === 1, "a truncated draft is never retried toward the budget — refusal comes first");
	assert(/Review/.test(truncationRefused), `the truncation refusal names the process (got ${truncationRefused})`);

	// --- A failed retry never destroys the usable first draft ---
	let failedRetryCalls = 0;
	const failedRetry = await buildStructuralReviewProposal({ agentId, assessmentMarkdown: assessmentFixture }, MODEL, async () => {
		failedRetryCalls += 1;
		if (failedRetryCalls === 1) return { text: proposalDoc(fatCandidate) };
		return { text: proposalDoc(slimCandidate), truncated: true, usage: { output: 999 }, modelMaxOutputTokens: 1000 };
	});
	assert(failedRetryCalls === 2, "the failed retry was attempted");
	assert(failedRetry.fields.candidateReviewTargetL1b.trim() === fatCandidate.trim(), "the first draft survives a failed retry");
	assert(failedRetry.warnings.some((warning) => /^the proposal could not be drafted again \(/.test(warning) && /so the first draft is shown$/.test(warning) && !/No memory has been written/.test(warning)), "the failed retry is disclosed with the reason's standalone no-write tail stripped");
	assert(failedRetry.memoryBudgetImpact.overBudgetAfter === true, "the surviving draft still discloses its over-budget state");

	// --- One merged notice: client Draft-again reasons + budget reasons never stack ---
	let mergedPrompts: string[] = [];
	await buildStructuralReviewProposal({ agentId, assessmentMarkdown: assessmentFixture, retryFeedback: ["Candidate review target is empty"] }, MODEL, async (prompt) => {
		mergedPrompts.push(prompt);
		return { text: proposalDoc(mergedPrompts.length === 1 ? fatCandidate : slimCandidate) };
	});
	assert(mergedPrompts.length === 2 && (mergedPrompts[0].match(/## Retry Notice/g) ?? []).length === 1, "the Draft-again prompt carries one notice");
	assert((mergedPrompts[1].match(/## Retry Notice/g) ?? []).length === 1, "the server retry rebuilds from the base prompt — notices never stack");
	assert(mergedPrompts[1].includes("- Candidate review target is empty") && /memory budget/.test(mergedPrompts[1]), "the merged notice carries the user's reasons AND the size reasons");

	// --- Per-run override: honored, reported, and validated ---
	let overridePrompt = "";
	const overridden = await buildStructuralReviewProposal({ agentId, assessmentMarkdown: assessmentFixture, hardness: "deep" }, MODEL, async (prompt) => {
		overridePrompt = prompt;
		return { text: proposalDoc(slimCandidate) };
	});
	assert(overridePrompt.includes("Pruning depth: deep"), "the override reaches the worker prompt");
	assert(overridden.reviewHardness.applied === "deep" && overridden.reviewHardness.derived.level === "light" && overridden.reviewHardness.overridden === true, "the response reports the override against the derivation");
	const explicit = await buildStructuralReviewProposal({ agentId, assessmentMarkdown: assessmentFixture, hardness: "light" }, MODEL, async () => ({ text: proposalDoc(slimCandidate) }));
	assert(explicit.reviewHardness.overridden === false, "picking the derived level is not an override");
	let badHardness = "";
	try {
		await buildStructuralReviewProposal({ agentId, assessmentMarkdown: assessmentFixture, hardness: "harder" }, MODEL, async () => ({ text: proposalDoc(slimCandidate) }));
		throw new Error("an unknown hardness should refuse");
	} catch (error) {
		badHardness = error instanceof Error ? error.message : String(error);
	}
	assert(/hardness must be one of light, standard, deep/.test(badHardness), `unknown hardness should name the valid levels (got ${badHardness})`);

	assert(fs.readFileSync(l1bPath, "utf-8") === originalL1b, "no propose path may mutate L1b/current.md");

	fs.rmSync(root, { recursive: true, force: true });
	console.log("review enforcement smoke passed");
} catch (error) {
	console.error(error instanceof Error ? error.stack || error.message : error);
	console.error(`temp root preserved for inspection: ${root}`);
	process.exitCode = 1;
}
