// The memory budget binds on the review target (Deep Memory + Active Items),
// not the whole L1b (decision 2026-08-26): Recent Context tokens are transient
// intake that Memorize clears, so counting them nudges the wrong process. The
// server computes the ONE over-budget predicate; every meter, badge, and bar
// renders it and never re-derives the comparison. This smoke pins the status
// block, the push-back case (fat RC + slim review target = under budget), and
// the per-prompt budget phrasing for both maintenance workers.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "exxeta-memory-budget-home-"));
process.env.HOME = tempHome;
process.env.USERPROFILE = tempHome;
const smokeAppDir = path.join(tempHome, ".exxperts", "app");
fs.mkdirSync(smokeAppDir, { recursive: true });
fs.writeFileSync(
	path.join(smokeAppDir, "openai-compatible-ai-profile.json"),
	JSON.stringify({ profileId: "openai-compatible", providerId: "openai-compatible", label: "Synthetic Gateway", roomModels: [{ modelId: "gpt-5.5" }], maintenanceModel: "gpt-5.5" }, null, 2),
);
fs.writeFileSync(path.join(smokeAppDir, "persistent-agent-ai-profile.json"), JSON.stringify({ profileId: "openai-compatible" }, null, 2));
const root = fs.mkdtempSync(path.join(os.tmpdir(), "exxeta-memory-budget-"));
process.env.EXXETA_PERSISTENT_AGENTS_ROOT = root;

const { buildMemoryBudgetImpact, createPersistentAgentFromScaffoldInput, getPersistentAgentStatus, readPersistentAgentReviewTargetEstimatedTokens, reviewTargetEstimatedTokensFromL1b } = await import("../src/persistent-agents.js");
const { overMemoryBudget, persistentRoomMaintenanceSettingsPath, readPersistentRoomMaintenanceSettings, writePersistentRoomMaintenanceSettings, MEMORY_BUDGET_MAX_TOKENS, MEMORY_BUDGET_MIN_TOKENS } = await import("../src/persistent-room-maintenance-settings.js");
const { buildAbsorbProposalPrompt, buildSectionPurposeMap } = await import("../src/absorb-consolidation.js");
const { getAbsorbModelLock } = await import("../src/persistent-agent-ai-profiles.js");
const { estimateTokens } = await import("../src/token-estimate.js");

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

const agentId = "memory-budget-smoke-room";
const l1bPath = path.join(root, agentId, "L1b", "current.md");

function rcEntry(index: number, bodyWords: number): string {
	return `### RC-${String(index).padStart(4, "0")} | OPEN | 2026-08-20 | Session ${index}\n\n**Session arc:** Session ${index}.\n\n**Body:**\n- ${"durable signal ".repeat(bodyWords)}\n`;
}

function writeL1b(deepChars: number, recentEntries: number, recentBodyWords: number): string {
	const deepFiller = `- ${"deep memory content ".repeat(Math.ceil(deepChars / 20))}`;
	const l1b = `<!-- exxeta:l1b schema_version=1 -->

## Chronos

- Lifecycle state: ready
- Last checkpoint: none
- Last consolidation: none

## Deep Memory

${deepFiller}

## Active Items

- One live thread.

## Recent Context

${Array.from({ length: recentEntries }, (_, i) => rcEntry(i + 1, recentBodyWords)).join("\n")}
`;
	fs.writeFileSync(l1bPath, l1b, "utf-8");
	return l1b;
}

try {
	createPersistentAgentFromScaffoldInput({ displayName: "Memory Budget Smoke Room", userName: "Synthetic User", preferredUserAddress: "Synthetic User" });
	const budget = MEMORY_BUDGET_MIN_TOKENS;
	writePersistentRoomMaintenanceSettings(agentId, { memoryBudgetTokens: budget });

	// --- Push-back case: fat RC + slim review target reads UNDER budget ---
	writeL1b(2_000, 8, 700);
	const under = getPersistentAgentStatus(agentId);
	assert(under.promptBudget && estimateTokens(fs.readFileSync(l1bPath, "utf-8")) === under.promptBudget.l1bEstimatedTokens, "whole-L1b estimate should ride the status prompt budget");
	assert(under.promptBudget!.l1bEstimatedTokens > budget, `fixture should put the WHOLE L1b over budget (got ${under.promptBudget?.l1bEstimatedTokens} vs ${budget})`);
	assert(under.memoryBudget, "status should carry the memoryBudget block");
	assert(under.memoryBudget!.budgetTokens === budget, "memoryBudget should carry the room's budget");
	assert(under.memoryBudget!.reviewTargetEstimatedTokens < under.promptBudget!.l1bEstimatedTokens, "review target must exclude Recent Context and Chronos");
	assert(under.memoryBudget!.overBudget === false, `a fat-RC room with a slim review target is UNDER budget (review target ${under.memoryBudget?.reviewTargetEstimatedTokens} vs ${budget})`);

	// --- One numerator everywhere, even on malformed topology ---
	// A hand-added extra section must not split the surfaces: the memory-page
	// reader (readPersistentAgentReviewTargetEstimatedTokens) and the status
	// block must agree to the token, and an extra section is not Deep Memory.
	fs.writeFileSync(l1bPath, fs.readFileSync(l1bPath, "utf-8") + "\n## Notes\n\n- hand-added section\n", "utf-8");
	const malformed = getPersistentAgentStatus(agentId);
	assert(malformed.memoryBudget!.overBudget === false, "an extra hand-added section must not flip the room over budget");
	assert(readPersistentAgentReviewTargetEstimatedTokens(agentId) === malformed.memoryBudget!.reviewTargetEstimatedTokens, "the memory-page numerator and the status block are the same function");

	// --- A fat review target reads OVER budget ---
	writeL1b(48_000, 2, 40);
	const over = getPersistentAgentStatus(agentId);
	assert(over.memoryBudget!.reviewTargetEstimatedTokens > budget, "fixture should put the review target over budget");
	assert(over.memoryBudget!.overBudget === true, "a fat review target is over budget");

	// --- Approval-card impact: the one builder, wired to the one numerator ---
	// (slice 3): both proposal builders attach buildMemoryBudgetImpact computed
	// from reviewTargetEstimatedTokensFromL1b on the source and the candidate;
	// this pins the builder's verdicts to the shared predicate on both crossing
	// directions so the card can never disagree with the meters.
	const overTokens = over.memoryBudget!.reviewTargetEstimatedTokens;
	const slimCandidate = "## Deep Memory\n\n- One durable fact.\n\n## Active Items\n\n- One thread.\n";
	const slimTokens = reviewTargetEstimatedTokensFromL1b(slimCandidate);
	assert(slimTokens > 0 && slimTokens < budget, "slim candidate fixture should sit under the budget");
	const shrink = buildMemoryBudgetImpact(overTokens, slimTokens, budget);
	assert(shrink.overBudgetBefore === true && shrink.overBudgetAfter === false, "a slim candidate brings an over-budget room back under");
	assert(shrink.reviewTargetEstimatedTokensBefore === overTokens && shrink.reviewTargetEstimatedTokensAfter === slimTokens && shrink.budgetTokens === budget, "impact carries the numerator's numbers verbatim");
	const cross = buildMemoryBudgetImpact(slimTokens, overTokens, budget);
	assert(cross.overBudgetBefore === false && cross.overBudgetAfter === true, "a fat candidate crosses the ceiling");
	assert(cross.overBudgetAfter === overMemoryBudget(overTokens, budget) && cross.overBudgetBefore === overMemoryBudget(slimTokens, budget), "impact verdicts are the one predicate, not a re-derivation");

	// --- The Memorize prompt hears the denominator it can act on --------------
	// Review no longer hears a budget at all: the run enforces it deterministically
	// after the tidy, by rank, and review-run-smoke pins that. Memorize still
	// rewrites a whole document, so its prompt must name the denominator it can
	// act on.
	const sectionPurposeMap = buildSectionPurposeMap(JSON.parse(fs.readFileSync(path.join(root, agentId, "section_registry.json"), "utf-8")));
	const absorbPrompt = buildAbsorbProposalPrompt({
		agentId,
		l1b: fs.readFileSync(l1bPath, "utf-8"),
		model: getAbsorbModelLock("openai-compatible"),
		sectionPurposeMap,
		assessmentMarkdown: "## Absorb assessment\n\nAssessment fixture.",
		memoryBudgetTokens: budget,
	}).prompt;
	assert(absorbPrompt.includes("## Memory Budget"), "absorb proposal prompt should carry a budget section when a budget is set");
	assert(!/whole L1b/i.test(absorbPrompt), "absorb budget line should name where the budget binds instead of a whole-L1b ceiling");
	assert(/binds on Deep Memory \+ Active Items/.test(absorbPrompt), "absorb budget line should name the binding denominator");
	assert(/Recent Context does not count toward it/.test(absorbPrompt), "absorb budget line should say RC clears rather than counting");
	assert(absorbPrompt.includes("ceiling, not a goal"), "absorb budget line keeps the ceiling-not-target constitution");

	// --- The setting's range: the ceiling is 80k, and it is enforced ---------
	// Raised from 50k with memory v2, because the server now enforces the budget
	// exactly on every maintenance write: a large room must be able to keep what
	// it has. A number outside the range is REFUSED, never quietly clamped —
	// storing a budget nobody asked for would silently decide what a room forgets.
	assert(MEMORY_BUDGET_MAX_TOKENS === 80_000, `the memory budget ceiling should be 80000, got ${MEMORY_BUDGET_MAX_TOKENS}`);
	assert(writePersistentRoomMaintenanceSettings(agentId, { memoryBudgetTokens: MEMORY_BUDGET_MAX_TOKENS }).memoryBudgetTokens === 80_000, "the ceiling itself must be settable");
	for (const refused of [MEMORY_BUDGET_MAX_TOKENS + 1, MEMORY_BUDGET_MIN_TOKENS - 1]) {
		let threw = "";
		try {
			writePersistentRoomMaintenanceSettings(agentId, { memoryBudgetTokens: refused });
		} catch (error) {
			threw = (error as Error).message;
		}
		assert(/must be between 10000 and 80000 tokens/.test(threw), `${refused} must be refused with a sentence, got ${JSON.stringify(threw)}`);
	}
	assert(readPersistentRoomMaintenanceSettings(agentId).memoryBudgetTokens === 80_000, "a refused budget must not have been stored");
	// A hand-edited or older file still READS as a usable budget: clamping is the
	// read path's job, refusing is the write path's.
	const settingsPath = persistentRoomMaintenanceSettingsPath(agentId);
	fs.writeFileSync(settingsPath, JSON.stringify({ ...JSON.parse(fs.readFileSync(settingsPath, "utf-8")), memoryBudgetTokens: 250_000 }, null, 2));
	assert(readPersistentRoomMaintenanceSettings(agentId).memoryBudgetTokens === 80_000, "an out-of-range budget on disk reads as the ceiling");

	fs.rmSync(root, { recursive: true, force: true });
	console.log("memory budget smoke passed");
} catch (error) {
	console.error(error instanceof Error ? error.stack || error.message : error);
	console.error(`temp root preserved for inspection: ${root}`);
	process.exitCode = 1;
}
