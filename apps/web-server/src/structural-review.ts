import { extractAssessmentSection } from "./assessment-parsing.js";
import { estimateTokens } from "./token-estimate.js";
import { ASSESSMENT_MAX_CHARS, ASSESSMENT_TARGET_CHARS, ASSESSMENT_TARGET_WORDS, DISCUSSION_HANDOFF_MAX_CHARS, DISCUSSION_HANDOFF_TARGET_CHARS, DISCUSSION_HANDOFF_TARGET_WORDS } from "./discussion-handoff.js";
import { overMemoryBudget, type ReviewHardnessLevel } from "./persistent-room-maintenance-settings.js";

export const STRUCTURAL_REVIEW_WORKER_TYPE = "structural-review-worker" as const;
export const STRUCTURAL_REVIEW_DISCUSSION_WORKER_TYPE = "structural-review-discussion-worker" as const;
export const STRUCTURAL_REVIEW_MODE = "stc_diagnostic" as const;
export const STRUCTURAL_REVIEW_DISCUSSION_MODE = "stc_diagnostic_discussion" as const;
export const STRUCTURAL_REVIEW_DISCUSSION_TOKEN_BUDGET = {
	softWarning: 75000,
	hardStop: 100000,
} as const;

export interface StructuralReviewModelLock {
	provider: string;
	model: string;
	label?: string;
}

export interface StructuralReviewFingerprint {
	algorithm: "sha256";
	value: string;
}

export interface StructuralReviewSourceParts {
	preservedChronos: string;
	sourceReviewTargetL1b: string;
	preservedRecentContext: string;
	topLevelSections: string[];
}

export interface StructuralReviewMemoryMapRow {
	area: string;
	words: number;
	estimatedTokens: number;
}

export interface StructuralReviewMetrics {
	chars: number;
	bytes: number;
	words: number;
	estimatedTokens: number;
	memoryMap: StructuralReviewMemoryMapRow[];
}

export interface StructuralReviewPromptTelemetry extends StructuralReviewMetrics {
	promptChars: number;
	promptEstimatedTokens: number;
	sectionDescriptionCount: number;
}

export type StructuralReviewDiscussionTokenBudgetState = "ok" | "soft_warning" | "hard_stop";

export interface StructuralReviewDiscussionTokenBudget {
	promptEstimatedTokens: number;
	softWarningTokens: number;
	hardStopTokens: number;
	state: StructuralReviewDiscussionTokenBudgetState;
	canContinue: boolean;
	canSignOff: boolean;
}

export interface StructuralReviewDiscussionPromptTelemetry extends StructuralReviewPromptTelemetry {
	discussionMessageCount: number;
	userMessageChars: number;
}

export type StructuralReviewDiscussionRole = "user" | "assistant";

export interface StructuralReviewDiscussionMessage {
	role: StructuralReviewDiscussionRole;
	content: string;
}

export interface StructuralReviewAssessmentHandoffInput {
	source: "direct_assessment" | "discussion_signoff";
	text: string;
}

export interface StructuralReviewAssessmentFields {
	looksHealthy: string[];
	staleOrDriftProne: string[];
	couldBeDenser: string[];
	structureOpportunities: string[];
	proposedDirection: string;
}

export interface StructuralReviewProposalFields {
	mode: string;
	summary: string;
	sectionLevelChangeLog: string;
	subsectionEntryDetail: string;
	stalenessFlags: string;
	proposedMemoryMap: string;
	reviewTargetMetrics: string;
	warnings: string;
	droppedMaterial: string;
	candidateReviewTargetL1b: string;
}

export interface StructuralReviewCandidateValidationResult {
	valid: boolean;
	warnings: string[];
	errors: string[];
	sourceTopLevelSections: string[];
	candidateTopLevelSections: string[];
}

export interface StructuralReviewAssessmentPromptInput {
	agentId: string;
	sourceReviewTargetL1b: string;
	model: StructuralReviewModelLock;
	sectionDescriptions?: StructuralReviewSectionDescriptions;
	now?: Date;
	/** "Reassess" carries the previous assessment's parse warnings so the worker corrects them. */
	retryFeedback?: string[];
}

export interface StructuralReviewProposalPromptInput extends StructuralReviewAssessmentPromptInput {
	assessmentMarkdown: string;
	assessmentHandoff?: StructuralReviewAssessmentHandoffInput;
	memoryBudgetTokens?: number;
	/**
	 * The pruning depth this run drafts at (derived server-side, per-run
	 * overridable). Absent means the pre-enforcement advisory budget wording —
	 * kept so the prompt builder stays callable without a depth.
	 */
	hardness?: ReviewHardnessLevel;
	/**
	 * The current review-target size through the product's ONE numerator, so
	 * the budget section's over/under statement can never disagree with the
	 * meters or the enforcement predicate. Falls back to the metrics-family
	 * estimate (at most a token off) when not supplied.
	 */
	reviewTargetEstimatedTokens?: number;
	/**
	 * Validation reasons from a previous rejected draft ("Draft again").
	 * When present, the prompt closes with a Retry Notice so the worker
	 * corrects the named failures instead of re-rolling blind.
	 */
	retryFeedback?: string[];
}

export interface StructuralReviewDiscussionPromptInput extends StructuralReviewAssessmentPromptInput {
	assessmentMarkdown: string;
	messages: StructuralReviewDiscussionMessage[];
	userMessage?: string;
	sourceFingerprint: StructuralReviewFingerprint;
	sourceReviewTargetFingerprint: StructuralReviewFingerprint;
	mode: "turn" | "signoff";
}

export interface StructuralReviewAssessmentPromptAssembly {
	prompt: string;
	metrics: StructuralReviewMetrics;
	telemetry: StructuralReviewPromptTelemetry;
}

export interface StructuralReviewProposalPromptAssembly extends StructuralReviewAssessmentPromptAssembly {
	assessmentHandoff?: StructuralReviewAssessmentHandoffInput;
}

export interface StructuralReviewDiscussionPromptAssembly extends StructuralReviewAssessmentPromptAssembly {
	tokenBudget: StructuralReviewDiscussionTokenBudget;
	telemetry: StructuralReviewDiscussionPromptTelemetry;
}

export type StructuralReviewSectionDescriptions = Record<string, string>;

const REQUIRED_TOPOLOGY = ["Chronos", "Deep Memory", "Active Items", "Recent Context"] as const;
const REVIEW_TARGET_TOPOLOGY = ["Deep Memory", "Active Items"] as const;

export const STRUCTURAL_REVIEW_SECTION_DESCRIPTIONS: StructuralReviewSectionDescriptions = {
	Chronos: "System-managed temporal continuity metadata. Preserved exactly and not read by Prune memory for MVP.",
	"Deep Memory": "Durable user context and long-lived operating understanding.",
	"Active Items": "Current priorities, commitments, and open threads that need operational continuity.",
	"Recent Context": "Checkpoint intake buffer owned by Absorb Recent Context. Preserved exactly and not read by Prune memory.",
};

function wordCount(text: string): number {
	const matches = text.trim().match(/[\p{L}\p{N}][\p{L}\p{N}'’_-]*/gu);
	return matches?.length ?? 0;
}

function normalizeText(text: string): string {
	return text.trimEnd() + "\n";
}

function extractTopLevelSectionBlocks(markdown: string): Array<{ title: string; body: string }> {
	const matches = Array.from(markdown.matchAll(/^##\s+(.+?)\s*$/gm));
	return matches.map((match, index) => {
		const start = match.index ?? 0;
		const end = index + 1 < matches.length ? matches[index + 1].index ?? markdown.length : markdown.length;
		return { title: match[1].trim(), body: markdown.slice(start, end).trimEnd() + "\n" };
	});
}

export function extractStructuralReviewSourceParts(l1b: string): StructuralReviewSourceParts {
	const normalized = normalizeText(l1b);
	const blocks = extractTopLevelSectionBlocks(normalized);
	const topLevelSections = blocks.map((block) => block.title);
	if (topLevelSections.join("\n") !== REQUIRED_TOPOLOGY.join("\n")) {
		throw new Error(`L1b topology must be exactly: ${REQUIRED_TOPOLOGY.join(" -> ")}`);
	}
	const byTitle = new Map(blocks.map((block) => [block.title, block.body]));
	const preservedChronos = byTitle.get("Chronos") ?? "";
	const deepMemory = byTitle.get("Deep Memory") ?? "";
	const activeItems = byTitle.get("Active Items") ?? "";
	const preservedRecentContext = byTitle.get("Recent Context") ?? "";
	if (!preservedChronos || !deepMemory || !activeItems || !preservedRecentContext) throw new Error("L1b missing mandatory section content");
	return {
		preservedChronos,
		sourceReviewTargetL1b: `${deepMemory.trimEnd()}\n\n${activeItems.trimEnd()}\n`,
		preservedRecentContext,
		topLevelSections,
	};
}

function sectionWithoutHeading(section: string, heading: string): string {
	return section.replace(new RegExp(`^##\\s+${heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\r?\\n?`, "i"), "");
}

function immediateSubsectionBlocks(section: string): Array<{ title: string; body: string }> {
	const matches = Array.from(section.matchAll(/^###\s+(.+?)\s*$/gm));
	return matches.map((match, index) => {
		const start = match.index ?? 0;
		const end = index + 1 < matches.length ? matches[index + 1].index ?? section.length : section.length;
		return { title: match[1].trim(), body: section.slice(start, end).trimEnd() + "\n" };
	});
}

function memoryMapRow(area: string, text: string): StructuralReviewMemoryMapRow {
	return { area, words: wordCount(text), estimatedTokens: estimateTokens(text) };
}

export function buildStructuralReviewMemoryMap(reviewTargetL1b: string): StructuralReviewMemoryMapRow[] {
	const blocks = extractTopLevelSectionBlocks(reviewTargetL1b);
	const rows: StructuralReviewMemoryMapRow[] = [];
	for (const block of blocks) {
		if (!REVIEW_TARGET_TOPOLOGY.includes(block.title as any)) continue;
		rows.push(memoryMapRow(block.title, sectionWithoutHeading(block.body, block.title)));
		for (const subsection of immediateSubsectionBlocks(block.body)) {
			rows.push(memoryMapRow(`${block.title} / ${subsection.title}`, subsection.body));
		}
	}
	return rows;
}

export function structuralReviewMetrics(reviewTargetL1b: string): StructuralReviewMetrics {
	const normalized = normalizeText(reviewTargetL1b);
	return {
		chars: normalized.length,
		bytes: Buffer.byteLength(normalized, "utf-8"),
		words: wordCount(normalized),
		estimatedTokens: estimateTokens(normalized),
		memoryMap: buildStructuralReviewMemoryMap(normalized),
	};
}

function formatMemoryMap(rows: StructuralReviewMemoryMapRow[]): string {
	return [
		"| Area | Words | Estimated tokens |",
		"|---|---:|---:|",
		...rows.map((row) => `| ${row.area} | ${row.words} | ${row.estimatedTokens} |`),
	].join("\n");
}

function formatSectionDescriptions(descriptions?: StructuralReviewSectionDescriptions): string {
	const source = { ...STRUCTURAL_REVIEW_SECTION_DESCRIPTIONS, ...(descriptions ?? {}) };
	return REQUIRED_TOPOLOGY.map((name) => `- ${name}: ${source[name] ?? "No description provided."}`).join("\n");
}

export function structuralReviewDiscussionTokenBudget(promptEstimatedTokens: number): StructuralReviewDiscussionTokenBudget {
	const state: StructuralReviewDiscussionTokenBudgetState = promptEstimatedTokens >= STRUCTURAL_REVIEW_DISCUSSION_TOKEN_BUDGET.hardStop
		? "hard_stop"
		: promptEstimatedTokens >= STRUCTURAL_REVIEW_DISCUSSION_TOKEN_BUDGET.softWarning
			? "soft_warning"
			: "ok";
	return {
		promptEstimatedTokens,
		softWarningTokens: STRUCTURAL_REVIEW_DISCUSSION_TOKEN_BUDGET.softWarning,
		hardStopTokens: STRUCTURAL_REVIEW_DISCUSSION_TOKEN_BUDGET.hardStop,
		state,
		canContinue: state !== "hard_stop",
		canSignOff: true,
	};
}

function structuralReviewConstitution(): string {
	return `# exxperts Prune memory / Structural Review Constitution

You are a platform-owned Structural Review worker inside exxperts.

User-facing workflow label: Prune memory.
Internal operation/event type: structural_review.
Internal cognitive mode: stc_diagnostic.
STC means Signal Token Coherence.

You are not the persistent agent. You are not ordinary chat. You are an ephemeral hidden maintenance process invoked to inspect stable memory as an artifact.

This operation must not write memory, archive files, mutate L1b, update Chronos, clear Recent Context, or create sidecar event records. You only produce assessment/proposal text for system validation and later human review.

## Source invariant

You may read and reason about only the review target provided to you:

- ## Deep Memory
- ## Active Items

You must not read, infer from, summarize, modify, request, or mention hidden content from Chronos or Recent Context. If temporal interpretation is needed, use deterministic process metadata such as currentTime.

## Goal

Improve signal/token ratio, signal coherence, or ideally both. This is pruning and coherence work, not stable-memory growth.

When tightening a claim that carries a source or provenance, keep the source attached, because a fact stripped of where it came from can no longer be trusted or re-verified.

## Temporal Steering

Entries may carry "(saved YYYY-MM-DD)" stamps. A stamp is the day that material was saved into memory — a "saved on" date, never the date the described events happened. Read age against currentTime from Process Metadata: the older a claim's saved-on date, the stronger the prior that it is stale, superseded, or solid enough to compress — older material is the first place to look for tightening. Age is a prior, not proof: it steers attention, it does not by itself make a claim wrong, and it never overrides must-keep or any pruning-depth rule set for this run. Material without a stamp has unknown age — never treat it as old on that basis, and never invent a stamp for it. Keep surviving stamps attached — a saved-on date is provenance — and when merging material saved on different dates, the merged entry keeps the newest saved-on date. When asked for a candidate and age is part of why you drop or compress something, say so where drops are named: the entry appears in the Dropped material section and the change log with its saved-on date and the age reason (for example "saved 2026-03-01, superseded by the 2026-08-01 entry").

## Must-Keep Material

Entries marked **must-keep** record explicit user remember-requests, and the system's own pointers under a "### Forgotten to document" subsection to files an earlier Prune saved in this room's Files. Keep them in the candidate, exact in commitments, numbers, names, dates, and file names. Keep the "Forgotten to document" subsection and every line under it as they are — its lines are the only way back to material a Prune removed, and dropping or rewording one orphans that file. Remove or rewrite a must-keep entry only when the user explicitly directed it in this Prune discussion, or when a newer must-keep entry clearly supersedes it — and in either case name the removal under Warnings, because must-keep material is exactly what the user must not lose without noticing.

## Candidate boundary

When asked for a candidate, output only the rewritten review target containing ## Deep Memory and ## Active Items in that order. Do not output ## Chronos, ## Recent Context, or any other top-level section.`;
}

export function buildStructuralReviewAssessmentPrompt(input: StructuralReviewAssessmentPromptInput): StructuralReviewAssessmentPromptAssembly {
	const now = input.now ?? new Date();
	const reviewTarget = normalizeText(input.sourceReviewTargetL1b);
	const metrics = structuralReviewMetrics(reviewTarget);
	const retrySection = input.retryFeedback?.length
		? `## Retry Notice\n\nThe user asked for this assessment again. The previous assessment had these problems:\n\n${input.retryFeedback.map((reason) => `- ${reason}`).join("\n")}\n\nProduce a complete, corrected assessment that resolves every point above while following the Task structure exactly.`
		: null;
	const prompt = [
		structuralReviewConstitution().trim(),
		`## Process Metadata\n\n- Agent id: ${input.agentId}\n- Process type: ${STRUCTURAL_REVIEW_WORKER_TYPE}\n- Operation: structural_review\n- Mode: ${STRUCTURAL_REVIEW_MODE}\n- currentTime: ${now.toISOString()}\n- System-selected model: ${input.model.provider}/${input.model.model}\n- Writes memory: false`,
		`## Section Descriptions\n\n${formatSectionDescriptions(input.sectionDescriptions)}`,
		`## Current Review-Target Memory Map\n\n${formatMemoryMap(metrics.memoryMap)}`,
		`## Material: Source Review Target L1b\n\nThe following is the complete source review target. It intentionally contains only Deep Memory and Active Items. Chronos and Recent Context are not provided to you.\n\n${reviewTarget.trim()}`,
		...(retrySection ? [retrySection] : []),
		`## Task: Prune memory assessment\n\nProduce a concise initial assessment. The memory map must be the first user-visible section after the title. Do not produce a candidate rewrite.\n\nUse exactly this markdown structure:\n\n## Prune memory assessment\n\n### Memory map\n${formatMemoryMap(metrics.memoryMap)}\n\n### Looks healthy\n- 2-4 bullets on stable areas that appear coherent and worth preserving.\n\n### Stale or drift-prone\n- 0-5 bullets citing memory that may now be obsolete, duplicated, or misleading.\n\n### Could be denser\n- 2-5 bullets on high-token / low-signal areas that can be tightened.\n\n### Structure opportunities\n- 1-4 bullets on Deep Memory or Active Items subsection changes that would improve coherence.\n\n### Proposed direction\n- concise summary of likely pruning/reorganization direction.\n\nKeep the whole assessment under about ${ASSESSMENT_TARGET_WORDS} words (~${ASSESSMENT_TARGET_CHARS} characters); the review screen accepts at most ${ASSESSMENT_MAX_CHARS} characters, and a longer assessment is regenerated rather than shown.\n\nReturn only the assessment markdown. Do not include candidate L1b. Do not claim anything has been saved.`,
	].join("\n\n---\n\n") + "\n";
	return {
		prompt,
		metrics,
		telemetry: { ...metrics, promptChars: prompt.length, promptEstimatedTokens: estimateTokens(prompt), sectionDescriptionCount: Object.keys(input.sectionDescriptions ?? STRUCTURAL_REVIEW_SECTION_DESCRIPTIONS).length },
	};
}

function formatStructuralReviewDiscussionTranscript(messages: StructuralReviewDiscussionMessage[]): string {
	if (messages.length === 0) return "No prior discussion messages.";
	return messages
		.map((message, index) => {
			const role = message.role === "assistant" ? "Assistant" : "User";
			return `### ${index + 1}. ${role}\n\n${message.content.trim() || "(empty)"}`;
		})
		.join("\n\n");
}

function structuralReviewDiscussionTask(mode: "turn" | "signoff"): string {
	if (mode === "signoff") {
		return `## Task: Prune Memory Discussion Signoff Handoff

The user has chosen to generate a Prune memory proposal from this discussion. Produce a bounded structured handoff for the separate proposal operator.

Use exactly this markdown structure:

## Prune memory discussion signoff

### User guidance
- Concise bullets capturing explicit user preferences, corrections, or priorities from the discussion.

### Preserve
- Stable-memory signal that should remain in Deep Memory or Active Items.

### Prune or tighten
- Low-signal, stale, redundant, or verbose material that should be removed or compressed.

### Reorganize
- Section or subsection moves, merges, splits, renames, or ordering changes to consider.

### Needs judgment
- None, or concise unresolved uncertainty flags.

### Transcript summary
Briefly summarize the discussion that led to this signoff.

Keep the whole handoff under about ${DISCUSSION_HANDOFF_TARGET_WORDS} words (~${DISCUSSION_HANDOFF_TARGET_CHARS} characters). It is passed to the proposal operator as written; past ${DISCUSSION_HANDOFF_MAX_CHARS} characters its Transcript summary is trimmed to fit, so keep that section short.\n\nReturn only the signoff handoff markdown. Do not generate the Prune Memory Proposal. Do not generate Candidate review target L1b. Do not claim memory has been saved.`;
	}
	return `## Task: Prune Memory Discussion Turn

Reply to the user's latest message as the Prune memory discussion operator. Help them inspect and refine what stable-memory signal should be preserved, pruned, tightened, reorganized, or flagged as stale before a separate proposal operator generates the official Prune Memory Proposal.

Keep the reply focused on stable-memory signal/token/coherence. Ask focused clarification questions only when useful. Do not generate the official Prune Memory Proposal. Do not generate Candidate review target L1b. Do not claim memory has been saved. Do not mention tools, sessions, checkpoints, or ordinary chat persistence.

Return only the assistant discussion message.`;
}

export function buildStructuralReviewDiscussionPrompt(input: StructuralReviewDiscussionPromptInput): StructuralReviewDiscussionPromptAssembly {
	const now = input.now ?? new Date();
	const reviewTarget = normalizeText(input.sourceReviewTargetL1b);
	const metrics = structuralReviewMetrics(reviewTarget);
	const promptParts = [
		structuralReviewConstitution().trim(),
		`## Prune Memory Discussion Operator Addendum

You are the Prune memory discussion operator. You are a platform-owned, ephemeral memory-maintenance worker. You are not the persistent agent and you are not ordinary chat.

Your job is to help the user reason about stable-memory pruning and coherence before a separate proposal operator generates the official Prune Memory Proposal.

Hard boundaries:

- No tools.
- No file writes.
- No memory writes.
- No checkpoint creation.
- No session id.
- No Prune Memory Proposal generation.
- No Candidate review target L1b generation as the official proposal.
- No claims that memory has been saved.
- No normal persistent-agent runtime envelope.
- No L1a injection.
- No Chronos body access.
- No Recent Context body access.`,
		`## Process Metadata

- Agent id: ${input.agentId}
- Process type: ${STRUCTURAL_REVIEW_DISCUSSION_WORKER_TYPE}
- Operation: structural_review
- Mode: ${STRUCTURAL_REVIEW_DISCUSSION_MODE}
- currentTime: ${now.toISOString()}
- System-selected model: ${input.model.provider}/${input.model.model}
- Writes memory: false
- Source L1b fingerprint: ${input.sourceFingerprint.algorithm}:${input.sourceFingerprint.value}
- Source review target fingerprint: ${input.sourceReviewTargetFingerprint.algorithm}:${input.sourceReviewTargetFingerprint.value}`,
		`## Section Descriptions

${formatSectionDescriptions(input.sectionDescriptions)}`,
		`## Current Review-Target Memory Map

${formatMemoryMap(metrics.memoryMap)}`,
		`## Material: Source Review Target L1b

The following is the complete source review target. It intentionally contains only Deep Memory and Active Items. Chronos and Recent Context are not provided to you.

${reviewTarget.trim()}`,
		`## Material: Initial Prune Memory Assessment

${input.assessmentMarkdown.trim()}`,
		`## Material: Discussion Transcript So Far

${formatStructuralReviewDiscussionTranscript(input.messages)}`,
		input.userMessage?.trim() ? `## Latest User Message

${input.userMessage.trim()}` : `## Latest User Message

None.`,
		structuralReviewDiscussionTask(input.mode),
	];
	const promptWithoutBudget = promptParts.join("\n\n---\n\n") + "\n";
	const budget = structuralReviewDiscussionTokenBudget(estimateTokens(promptWithoutBudget));
	const prompt = [
		...promptParts.slice(0, 3),
		`## Token Budget State

- Estimated prompt tokens: ${budget.promptEstimatedTokens}
- Soft warning threshold: ${budget.softWarningTokens}
- Hard stop threshold: ${budget.hardStopTokens}
- State: ${budget.state}
- Can continue discussion: ${budget.canContinue}
- Can sign off: ${budget.canSignOff}`,
		...promptParts.slice(3),
	].join("\n\n---\n\n") + "\n";
	const finalBudget = structuralReviewDiscussionTokenBudget(estimateTokens(prompt));
	return {
		prompt,
		metrics,
		tokenBudget: finalBudget,
		telemetry: {
			...metrics,
			promptChars: prompt.length,
			promptEstimatedTokens: finalBudget.promptEstimatedTokens,
			sectionDescriptionCount: Object.keys(input.sectionDescriptions ?? STRUCTURAL_REVIEW_SECTION_DESCRIPTIONS).length,
			discussionMessageCount: input.messages.length,
			userMessageChars: input.userMessage?.length ?? 0,
		},
	};
}

// The budget speaks in the worker's own quantity: the review target it holds,
// against the same estimated-token budget every meter shows. The over/under
// statement comes from the ONE predicate, never from the depth label — a
// per-run override can set light depth on an over-budget room, and the prompt
// must not claim it fits. The depth rules come from the agreed hardness shape
// (light = rephrase only, standard = drop stale/superseded/contradicted
// claims, deep = whole low-signal areas to one-line pointers). At every depth
// the constitution outranks the budget: must-keep stays, provenance stays
// attached, every drop is named. Without a depth the section keeps the
// pre-enforcement advisory wording.
function structuralReviewBudgetSection(budgetTokens: number, currentTokens: number, hardness?: ReviewHardnessLevel): string {
	const ceilingLine = "- The budget is a ceiling, not a goal. Never add, expand, or pad content because headroom remains, and never cut real signal just to buy headroom below the ceiling — at any size, the densest faithful memory wins.";
	const constitutionLine = "- Never remove must-keep entries without explicit user direction, and never violate the constitution to satisfy the budget.";
	if (!hardness) {
		return `## Memory Budget\n\n- Advisory memory budget: keep the review target (Deep Memory + Active Items — exactly the material you hold) under ~${budgetTokens} estimated tokens.\n- The budget is a ceiling, not a goal. Never add, expand, or pad content because headroom remains — at any size, the densest faithful memory wins.\n- This is advisory. Never remove must-keep entries without explicit user direction, and never violate the constitution to satisfy it.`;
	}
	const headLine = overMemoryBudget(currentTokens, budgetTokens)
		? `- Memory budget: the review target (Deep Memory + Active Items — exactly the material you hold) is ~${currentTokens} estimated tokens against a ~${budgetTokens}-token budget — over it. Bring the candidate under the budget where the depth rules allow.`
		: `- Memory budget: keep the review target (Deep Memory + Active Items — exactly the material you hold) under ~${budgetTokens} estimated tokens. At ~${currentTokens} estimated tokens it currently fits.`;
	const depthLine = hardness === "light"
		? "- Pruning depth: light. Rephrase for density where wording is loose; drop nothing. This run is coherence work, not forgetting."
		: hardness === "standard"
			? "- Pruning depth: standard. Beyond denser rephrasing, you may drop claims that are stale, superseded, or contradicted by newer material. Name every drop in the Dropped material section and the change log."
			: "- Pruning depth: deep. Beyond denser rephrasing and dropping stale, superseded, or contradicted claims, you may let go of whole low-signal areas, leaving a one-line pointer that names what was compressed away. Name every drop in the Dropped material section and the change log.";
	return `## Memory Budget\n\n${headLine}\n${depthLine}\n${ceilingLine}\n${constitutionLine}`;
}

export function buildStructuralReviewProposalPrompt(input: StructuralReviewProposalPromptInput): StructuralReviewProposalPromptAssembly {
	const now = input.now ?? new Date();
	const reviewTarget = normalizeText(input.sourceReviewTargetL1b);
	const metrics = structuralReviewMetrics(reviewTarget);
	const handoff = input.assessmentHandoff?.text.trim()
		? `## Optional Signed-Off Assessment Handoff\n\nSource: ${input.assessmentHandoff.source}\n\n${input.assessmentHandoff.text.trim()}`
		: `## Optional Signed-Off Assessment Handoff\n\nNone. The proposal should follow the direct initial assessment.`;
	const budgetSection = typeof input.memoryBudgetTokens === "number"
		? structuralReviewBudgetSection(input.memoryBudgetTokens, input.reviewTargetEstimatedTokens ?? metrics.estimatedTokens, input.hardness)
		: null;
	const retrySection = input.retryFeedback?.length
		? `## Retry Notice\n\nA previous draft of this proposal was not accepted for these reasons:\n\n${input.retryFeedback.map((reason) => `- ${reason}`).join("\n")}\n\nProduce a complete, corrected proposal that resolves every reason above while following the Task structure exactly.`
		: null;
	const prompt = [
		structuralReviewConstitution().trim(),
		`## Process Metadata\n\n- Agent id: ${input.agentId}\n- Process type: ${STRUCTURAL_REVIEW_WORKER_TYPE}\n- Operation: structural_review\n- Mode: ${STRUCTURAL_REVIEW_MODE}\n- currentTime: ${now.toISOString()}\n- System-selected model: ${input.model.provider}/${input.model.model}\n- Writes memory: false`,
		`## Section Descriptions\n\n${formatSectionDescriptions(input.sectionDescriptions)}`,
		`## Current Review-Target Memory Map\n\n${formatMemoryMap(metrics.memoryMap)}`,
		`## Material: Source Review Target L1b\n\nThe following is the complete source review target. It intentionally contains only Deep Memory and Active Items. Chronos and Recent Context are not provided to you.\n\n${reviewTarget.trim()}`,
		`## Material: Initial Prune Memory Assessment\n\n${input.assessmentMarkdown.trim()}`,
		handoff,
		...(budgetSection ? [budgetSection] : []),
		`## Task: Prune memory proposal\n\nProduce a parseable Prune memory proposal plus complete candidate review target L1b.\n\nThe candidate review target must contain exactly these top-level sections in this order:\n\n## Deep Memory\n## Active Items\n\nDo not output ## Chronos, ## Recent Context, or any other top-level section. The backend will graft preserved Chronos and Recent Context back exactly.\n\nName every drop in the Dropped material section, which comes BEFORE the Candidate review target L1b section. The candidate section is always the last section of the proposal — anything you place after it is read as candidate memory content, not as a proposal section.\n\nUse exactly this markdown structure:\n\n## Prune Memory Proposal\n\n### Mode\nSTC_DIAGNOSTIC\n\n### Summary\n[Concise summary of the stable-memory pruning direction.]\n\n### Section-Level Change Log\n| Section | Prior Tokens | Candidate Tokens | Disposition | Rationale |\n|---|---:|---:|---|---|\n\n### Subsection / Entry Detail\n| Area | Operation | Rationale |\n|---|---|---|\n\n### Staleness Flags\n[Specific stale or contradictory claims, or "None detected."]\n\n### Proposed Memory Map\n| Area | Words | Estimated tokens |\n|---|---:|---:|\n\n### Review Target Metrics\n- Review target words before: ${metrics.words}\n- Review target words after: [n]\n- Review target estimated tokens before: ${metrics.estimatedTokens}\n- Review target estimated tokens after: [n]\n- Estimated token delta: [+/- n]\n\n### Warnings\nNone, or concise uncertainty flags.\n\n### Dropped material\n[One bullet per claim, entry, or area this candidate removes or compresses away, each with a one-line reason. Write "None." when the candidate drops nothing. This section comes before the candidate — never after it.]\n\n### Candidate review target L1b\n[Complete rewritten Deep Memory and Active Items content only. This is the final section — nothing follows it.]\n\nReturn only the proposal markdown. Do not claim anything has been saved.`,
		...(retrySection ? [retrySection] : []),
	].join("\n\n---\n\n") + "\n";
	return {
		prompt,
		metrics,
		assessmentHandoff: input.assessmentHandoff,
		telemetry: { ...metrics, promptChars: prompt.length, promptEstimatedTokens: estimateTokens(prompt), sectionDescriptionCount: Object.keys(input.sectionDescriptions ?? STRUCTURAL_REVIEW_SECTION_DESCRIPTIONS).length },
	};
}

function extractMarkdownSection(raw: string, heading: string, nextLevel = "###"): string {
	const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const start = raw.search(new RegExp(`^${nextLevel}\\s+${escaped}\\s*$`, "im"));
	if (start < 0) return "";
	const afterHeading = raw.slice(start).replace(new RegExp(`^${nextLevel}\\s+${escaped}\\s*\\r?\\n?`, "i"), "");
	const next = afterHeading.search(new RegExp(`^${nextLevel}\\s+`, "m"));
	return (next >= 0 ? afterHeading.slice(0, next) : afterHeading).trim();
}

function extractBullets(section: string): string[] {
	const bullets = section
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter((line) => /^[-*•]\s+/.test(line))
		.map((line) => line.replace(/^[-*•]\s+/, "").trim())
		.filter(Boolean);
	if (bullets.length > 0) return bullets;
	const normalized = section.replace(/\s+/g, " ").trim();
	return normalized && !/^none\.?$/i.test(normalized) ? [normalized] : [];
}

export function parseStructuralReviewAssessment(raw: string): { fields: StructuralReviewAssessmentFields; warnings: string[] } {
	const fields: StructuralReviewAssessmentFields = {
		looksHealthy: extractBullets(extractAssessmentSection(raw, "Looks healthy")),
		staleOrDriftProne: extractBullets(extractAssessmentSection(raw, "Stale or drift-prone")),
		couldBeDenser: extractBullets(extractAssessmentSection(raw, "Could be denser")),
		structureOpportunities: extractBullets(extractAssessmentSection(raw, "Structure opportunities")),
		proposedDirection: extractBullets(extractAssessmentSection(raw, "Proposed direction"))[0] ?? extractAssessmentSection(raw, "Proposed direction"),
	};
	const warnings: string[] = [];
	if (!extractAssessmentSection(raw, "Memory map")) warnings.push("assessment missing Memory map");
	if (fields.looksHealthy.length === 0) warnings.push("assessment missing Looks healthy bullets");
	if (fields.couldBeDenser.length === 0) warnings.push("assessment missing Could be denser bullets");
	if (fields.structureOpportunities.length === 0) warnings.push("assessment missing Structure opportunities bullets");
	if (!fields.proposedDirection) warnings.push("assessment missing Proposed direction");
	return { fields, warnings };
}

// Same shape as the checkpoint missing-fields retry: the original prompt plus
// a notice carrying the validator's own reasons, asked once.
export function buildStructuralReviewAssessmentRetryPrompt(prompt: string, reasons: string[]): string {
	return `${prompt.trimEnd()}\n\n---\n\n## Retry Notice\n\nYour previous assessment was not accepted:\n\n${reasons.map((reason) => `- ${reason}`).join("\n")}\n\nProduce the complete assessment again using exactly the markdown structure from the Task: plain \`### \` headings named Memory map, Looks healthy, Stale or drift-prone, Could be denser, Structure opportunities and Proposed direction, each with plain bullets. Stay under ${ASSESSMENT_MAX_CHARS} characters (about ${ASSESSMENT_TARGET_WORDS} words). Return only the assessment markdown.\n`;
}

// Same shape as the assessment retry: the notice-free prompt plus a single
// merged Retry Notice, asked once. The budget enforcement loop builds its
// retry from the base prompt so a client "Draft again" notice never stacks
// with the server's own (the double-notice bug S1 fixed).
export function buildStructuralReviewProposalRetryPrompt(prompt: string, reasons: string[]): string {
	return `${prompt.trimEnd()}\n\n---\n\n## Retry Notice\n\nYour previous proposal was not accepted:\n\n${reasons.map((reason) => `- ${reason}`).join("\n")}\n\nProduce the complete proposal again using exactly the markdown structure from the Task, including the full Candidate review target L1b as the final section, with the Dropped material section before it. Resolve every reason above without violating the constitution: must-keep entries stay, provenance stays attached, every drop is named in the Dropped material section and the change log. Return only the proposal markdown.\n`;
}

// The disclosure is read with the same tolerance the candidate-side guard
// applies (level, indent, emphasis, trailing punctuation): the worker likely
// to bend the heading's shape is the worker whose drops most need showing —
// a strict match would render a false "Not stated by this draft" over a
// stated list.
function extractDroppedMaterialSection(beforeCandidate: string): string {
	const heading = /^[ \t]{0,3}#{1,6}[ \t]+[*_`~]*[ \t]*dropped[ \t]+material\b.*$/im;
	const match = heading.exec(beforeCandidate);
	if (!match) return "";
	const after = beforeCandidate.slice(match.index + match[0].length);
	const next = after.search(/^[ \t]{0,3}#{1,6}[ \t]+\S/m);
	return (next >= 0 ? after.slice(0, next) : after).trim();
}

function extractCandidateReviewTargetL1b(raw: string): string {
	const start = raw.search(/^###\s+Candidate review target L1b\s*$/im);
	if (start < 0) return "";
	return raw.slice(start).replace(/^###\s+Candidate review target L1b\s*\r?\n?/i, "").trim();
}

export function parseStructuralReviewProposal(raw: string): { fields: StructuralReviewProposalFields; warnings: string[] } {
	// Dropped material is read only from before the candidate heading: a copy
	// misplaced after it belongs to the candidate (and is rejected there by
	// validation), so parsing it from the whole document would render a
	// disclosure card from the very section the validator calls corrupt.
	const candidateStart = raw.search(/^###\s+Candidate review target L1b\s*$/im);
	const beforeCandidate = candidateStart >= 0 ? raw.slice(0, candidateStart) : raw;
	const fields: StructuralReviewProposalFields = {
		mode: extractMarkdownSection(raw, "Mode"),
		summary: extractMarkdownSection(raw, "Summary"),
		sectionLevelChangeLog: extractMarkdownSection(raw, "Section-Level Change Log"),
		subsectionEntryDetail: extractMarkdownSection(raw, "Subsection / Entry Detail"),
		stalenessFlags: extractMarkdownSection(raw, "Staleness Flags"),
		proposedMemoryMap: extractMarkdownSection(raw, "Proposed Memory Map"),
		reviewTargetMetrics: extractMarkdownSection(raw, "Review Target Metrics"),
		warnings: extractMarkdownSection(raw, "Warnings"),
		droppedMaterial: extractDroppedMaterialSection(beforeCandidate),
		candidateReviewTargetL1b: extractCandidateReviewTargetL1b(raw),
	};
	const warnings: string[] = [];
	if (!/STC_DIAGNOSTIC/i.test(fields.mode)) warnings.push("proposal mode is not STC_DIAGNOSTIC");
	if (!fields.summary) warnings.push("proposal missing Summary");
	if (!fields.sectionLevelChangeLog) warnings.push("proposal missing Section-Level Change Log");
	if (!fields.subsectionEntryDetail) warnings.push("proposal missing Subsection / Entry Detail");
	if (!fields.proposedMemoryMap) warnings.push("proposal missing Proposed Memory Map");
	if (!fields.reviewTargetMetrics) warnings.push("proposal missing Review Target Metrics");
	if (!fields.droppedMaterial) warnings.push("proposal missing Dropped material");
	if (!fields.candidateReviewTargetL1b) warnings.push("proposal missing Candidate review target L1b");
	return { fields, warnings };
}

// The disclosure is cross-checked against the one deterministic signal
// available: memory-map areas that exist in the source and are gone from the
// candidate. A none-like disclosure over vanished areas is a false claim; a
// substantive disclosure that never mentions a vanished area's own heading
// is an incomplete one — both warn, and a false positive merely forces
// manual review. Entry-level drops inside a surviving area are invisible
// here — this catches area-level omissions, not every one. The "proposal "
// prefix is load-bearing for the Draft-again feedback path (the client
// filters retry feedback on it); the fast-path blocker list takes every
// meaningful warning regardless of prefix. Emphasis and list markers are
// stripped before the none-test ("**None.**", "+ None.", "1. None." are all
// nones). An empty candidate is not judged here — the missing-candidate
// warning owns that failure, and every source area "vanishing" from nothing
// would stack a false conflict on top of the real one; an empty disclosure
// belongs to the missing-section warning the same way.
// Count-aware, like the forget-to-document extractor: two same-named
// subsections collapse to one memory-map name, and a membership check would
// see the survivor and call nothing vanished — a false "None." over a dropped
// twin would then pass the guard, auto-apply, and never offer the export.
export function structuralReviewVanishedMemoryMapAreas(sourceReviewTargetL1b: string, candidateReviewTargetL1b: string): string[] {
	const candidateCounts = new Map<string, number>();
	for (const row of buildStructuralReviewMemoryMap(candidateReviewTargetL1b)) candidateCounts.set(row.area, (candidateCounts.get(row.area) ?? 0) + 1);
	const sourceCounts = new Map<string, number>();
	for (const row of buildStructuralReviewMemoryMap(sourceReviewTargetL1b)) sourceCounts.set(row.area, (sourceCounts.get(row.area) ?? 0) + 1);
	return [...sourceCounts.entries()].filter(([area, count]) => count > (candidateCounts.get(area) ?? 0)).map(([area]) => area);
}

export interface StructuralReviewDroppedMaterialConflictDetail {
	/** "none": a none-like disclosure over vanished areas (a false claim); "unnamed": a substantive disclosure missing vanished areas (an incomplete one). */
	kind: "none" | "unnamed";
	areas: string[];
}

// The structured form: the warning string (proposal card, fast-path blockers,
// Draft-again feedback) and the export document's note both compose from it,
// each in its own surface's words, so one signal never reads two ways.
export function structuralReviewDroppedMaterialConflictDetail(droppedMaterial: string, sourceReviewTargetL1b: string, candidateReviewTargetL1b: string): StructuralReviewDroppedMaterialConflictDetail | undefined {
	if (!candidateReviewTargetL1b.trim() || !droppedMaterial.trim()) return undefined;
	const vanished = structuralReviewVanishedMemoryMapAreas(sourceReviewTargetL1b, candidateReviewTargetL1b);
	if (vanished.length === 0) return undefined;
	const normalized = droppedMaterial.replace(/[*_`~]/g, "").replace(/^[\s\-•+]+/, "").replace(/^\d+[.)]\s*/, "").replace(/[\s.]+$/, "").trim().toLowerCase();
	if (/^none( detected| noted)?$/.test(normalized)) return { kind: "none", areas: vanished };
	// Leaf headings, not full paths: a truthful bullet may name the dropped
	// subsection without repeating its parent section.
	const disclosureText = droppedMaterial.toLowerCase();
	const unnamed = vanished.filter((area) => !disclosureText.includes((area.split(" / ").pop() ?? area).toLowerCase()));
	if (unnamed.length === 0) return undefined;
	return { kind: "unnamed", areas: unnamed };
}

export function structuralReviewDroppedMaterialConflict(droppedMaterial: string, sourceReviewTargetL1b: string, candidateReviewTargetL1b: string): string | undefined {
	const detail = structuralReviewDroppedMaterialConflictDetail(droppedMaterial, sourceReviewTargetL1b, candidateReviewTargetL1b);
	if (!detail) return undefined;
	if (detail.kind === "none") {
		return `proposal Dropped material says none, but ${detail.areas.length === 1 ? "this area is" : "these areas are"} no longer in the candidate: ${detail.areas.join(", ")}`;
	}
	return `proposal Dropped material does not name ${detail.areas.length === 1 ? "this area that is" : "these areas that are"} no longer in the candidate: ${detail.areas.join(", ")}`;
}

// Forget-to-document captures what a Prune removed at the only moment it is
// still deterministically recoverable: approval time, before the write. Whole
// vanished areas are copied in full from the source — the ONE count-aware
// vanished-area computation the disclosure guard also reads; entry-level
// drops inside surviving areas exist only as the worker's disclosure, and the
// document says so rather than pretending completeness. When a same-named
// twin was dropped, every source section of that name is captured — which
// twin went is not determinable, and over-capture is the honest side.
export function structuralReviewVanishedAreaBlocks(sourceReviewTargetL1b: string, candidateReviewTargetL1b: string): Array<{ area: string; body: string }> {
	const vanished = new Set(structuralReviewVanishedMemoryMapAreas(sourceReviewTargetL1b, candidateReviewTargetL1b));
	const blocks: Array<{ area: string; body: string }> = [];
	for (const block of extractTopLevelSectionBlocks(normalizeText(sourceReviewTargetL1b))) {
		if (!REVIEW_TARGET_TOPOLOGY.includes(block.title as any)) continue;
		for (const subsection of immediateSubsectionBlocks(block.body)) {
			const area = `${block.title} / ${subsection.title}`;
			if (vanished.has(area)) blocks.push({ area, body: subsection.body.trimEnd() + "\n" });
		}
	}
	return blocks;
}

export interface ForgetToDocumentInput {
	structuralReviewId: string;
	approvedAt: Date;
	droppedMaterial: string;
	sectionLevelChangeLog: string;
	sourceReviewTargetL1b: string;
	candidateReviewTargetL1b: string;
}

export function forgetToDocumentShelfFilename(approvedAt: Date): string {
	return `Pruned memory ${approvedAt.toISOString().slice(0, 10)}.md`;
}

export function composeForgetToDocumentDocument(input: ForgetToDocumentInput): string {
	const savedOn = input.approvedAt.toISOString().slice(0, 10);
	const vanished = structuralReviewVanishedAreaBlocks(input.sourceReviewTargetL1b, input.candidateReviewTargetL1b);
	// Same-named twins: every copy is captured because the removed one cannot
	// be told apart — the document must say a survivor may be among them, or
	// its own heading ("no longer in memory") becomes a false claim.
	const candidateCounts = new Map<string, number>();
	for (const row of buildStructuralReviewMemoryMap(input.candidateReviewTargetL1b)) candidateCounts.set(row.area, (candidateCounts.get(row.area) ?? 0) + 1);
	const capturedCounts = new Map<string, number>();
	for (const block of vanished) capturedCounts.set(block.area, (capturedCounts.get(block.area) ?? 0) + 1);
	// The caveat applies only while a survivor exists: when every copy of a
	// name vanished there is nothing to tell apart, and the heading is simply true.
	const twinAreas = [...capturedCounts.entries()].filter(([area, count]) => count > 1 && (candidateCounts.get(area) ?? 0) > 0).map(([area]) => area);
	const vanishedSection = vanished.length > 0
		? vanished.map((block) => {
			const remaining = candidateCounts.get(block.area) ?? 0;
			const copies = capturedCounts.get(block.area) ?? 1;
			const label = copies > 1 && remaining > 0
				? `**${block.area}** — one of ${copies} same-named sections; ${remaining} of that name ${remaining === 1 ? "remains" : "remain"} in memory and cannot be told apart from the removed ${copies - remaining === 1 ? "one" : "ones"}, so every copy is saved here as it stood before this Prune:`
				: copies > 1
					? `**${block.area}** — one of ${copies} same-named sections, all removed by this Prune; copied exactly as it stood before:`
					: `**${block.area}** — copied exactly as it stood before this Prune:`;
			return `${label}\n\n${block.body.trimEnd()}`;
		}).join("\n\n")
		: "None — no whole section vanished; any drops disclosed above were entry-level.";
	const twinLimit = twinAreas.length > 0
		? ` Where a section name appears more than once above (${twinAreas.join(", ")}), one or more of those copies may still be in memory: same-named sections cannot be told apart, so every copy was saved.`
		: "";
	// The disclosure is quoted as the draft wrote it; when the approval-time
	// check found it false or incomplete, the file says so beside it rather
	// than presenting a contradicted "None." as the record of what was dropped.
	const conflict = structuralReviewDroppedMaterialConflictDetail(input.droppedMaterial, input.sourceReviewTargetL1b, input.candidateReviewTargetL1b);
	const disclosureNote = conflict
		? `\n\n${conflict.kind === "none"
			? `At approval this disclosure was found to be contradicted: it says nothing was dropped, but ${conflict.areas.length === 1 ? "this memory area is" : "these memory areas are"} gone from the applied draft: ${conflict.areas.join(", ")}.`
			: `At approval this disclosure was found incomplete: it does not mention ${conflict.areas.length === 1 ? "this memory area, which is" : "these memory areas, which are"} gone from the applied draft: ${conflict.areas.join(", ")}.`} The full text of every section that vanished is copied below; entry-level drops the draft did not state are not recoverable from this file.`
		: !input.droppedMaterial.trim() && vanished.length > 0
			? `\n\nThe draft did not state its drops. The full text of every section that vanished is copied below; entry-level drops are not recoverable from this file.`
			: "";
	return [
		`# Forgotten to document — saved ${savedOn}`,
		`This file records what a Prune memory approval removed or compressed from this room's long-term memory. Dates here mean when material was saved or pruned, never when the described events happened.`,
		`- Prune id: ${input.structuralReviewId}\n- Saved on: ${input.approvedAt.toISOString()} (approval time)`,
		`## What the applied draft disclosed as dropped\n\n${input.droppedMaterial.trim() || "Not stated by the applied draft."}${disclosureNote}`,
		`## Change log at approval\n\n${input.sectionLevelChangeLog.trim() || "Not stated by the applied draft."}`,
		`## Full text of sections no longer in memory\n\n${vanishedSection}`,
		`## Honest limit\n\nEntry-level drops inside surviving sections are recorded only as the disclosure above; their full original text is not captured here. The section copies above are byte-exact from the memory that was archived at this approval.${twinLimit}`,
	].join("\n\n") + "\n";
}

// The pointer's whole purpose is to stay discoverable, so it is protected
// twice. Its own leaf subsection makes it a memory-map area: a later Prune
// that drops it trips the count-aware vanished-area check — the disclosure
// guard, the Dropped material card, the fast-path refusal — like any other
// section. The **must-keep** marker is the prompt half: the constitution names
// this subsection as system-minted must-keep, so the worker is told not to
// drop or reword it in the first place. Either alone is not enough — a bare
// bullet outside any subsection was invisible to the area-level check and a
// light Prune could rephrase it away unannounced, orphaning the file the
// saved screen had just promised (S2 review M1).
export const STRUCTURAL_REVIEW_SHELF_POINTER_HEADING = "Forgotten to document";

export function structuralReviewShelfPointerLine(shelfFileName: string, approvedAt: Date): string {
	return `- **must-keep** (saved ${approvedAt.toISOString().slice(0, 10)}): material dropped by this Prune is in this room's Files as "${shelfFileName}".`;
}

function shelfPointerHeadingPattern(): RegExp {
	return new RegExp(`^###\\s+${STRUCTURAL_REVIEW_SHELF_POINTER_HEADING}\\s*$`, "m");
}

// The pointer lives under its own "### Forgotten to document" subsection at
// the end of Deep Memory — before the Active Items heading — so it stays with
// the durable-context section the drops came from. The first export creates
// the subsection; every later export appends its own line under the existing
// one (wherever a Prune has since placed it inside Deep Memory) so the area
// keeps one name and the count-aware vanish check never sees a twin.
// What an export actually adds to Deep Memory: the line alone when the
// subsection already exists, heading plus line on the first export. The
// pointer-cost disclosure estimates this text, never the bare line.
export function structuralReviewShelfPointerAdditionText(candidateReviewTargetL1b: string, pointerLine: string): string {
	const activeItems = /^##\s+Active Items\s*$/m.exec(normalizeText(candidateReviewTargetL1b));
	const deepMemory = normalizeText(candidateReviewTargetL1b).slice(0, activeItems?.index ?? undefined);
	return shelfPointerHeadingPattern().test(deepMemory) ? pointerLine.trim() : `### ${STRUCTURAL_REVIEW_SHELF_POINTER_HEADING}\n\n${pointerLine.trim()}`;
}

export function appendStructuralReviewShelfPointer(candidateReviewTargetL1b: string, pointerLine: string): string {
	const normalized = normalizeText(candidateReviewTargetL1b);
	const activeItems = /^##\s+Active Items\s*$/m.exec(normalized);
	if (!activeItems || activeItems.index == null) throw new Error("Candidate review target has no Active Items section to anchor the shelf pointer");
	const deepMemory = normalized.slice(0, activeItems.index);
	const existing = shelfPointerHeadingPattern().exec(deepMemory);
	if (existing && existing.index != null) {
		const afterHeading = existing.index + existing[0].length;
		const nextHeading = /^##{1,2}\s+\S/m.exec(deepMemory.slice(afterHeading));
		const sectionEnd = nextHeading && nextHeading.index != null ? afterHeading + nextHeading.index : deepMemory.length;
		return `${deepMemory.slice(0, sectionEnd).trimEnd()}\n${pointerLine.trim()}\n\n${normalized.slice(sectionEnd).trimStart()}`;
	}
	return `${deepMemory.trimEnd()}\n\n### ${STRUCTURAL_REVIEW_SHELF_POINTER_HEADING}\n\n${pointerLine.trim()}\n\n${normalized.slice(activeItems.index)}`;
}

export function validateStructuralReviewCandidateReviewTarget(sourceReviewTargetL1b: string, candidateReviewTargetL1b: string): StructuralReviewCandidateValidationResult {
	const sourceTopLevelSections = extractTopLevelSectionBlocks(sourceReviewTargetL1b).map((section) => section.title);
	const candidateTopLevelSections = extractTopLevelSectionBlocks(candidateReviewTargetL1b).map((section) => section.title);
	const errors: string[] = [];
	const warnings: string[] = [];
	if (!candidateReviewTargetL1b.trim()) errors.push("Candidate review target L1b is empty");
	if (sourceTopLevelSections.join("\n") !== REVIEW_TARGET_TOPOLOGY.join("\n")) errors.push("Source review target topology is invalid");
	if (candidateTopLevelSections.join("\n") !== REVIEW_TARGET_TOPOLOGY.join("\n")) errors.push("Candidate review target must contain exactly Deep Memory and Active Items in that order");
	if (candidateTopLevelSections.includes("Chronos")) errors.push("Candidate review target must not include Chronos");
	if (candidateTopLevelSections.includes("Recent Context")) errors.push("Candidate review target must not include Recent Context");
	if (/^###\s+RC-/m.test(candidateReviewTargetL1b)) errors.push("Candidate review target must not contain Recent Context entries");
	// The candidate extractor slices from its heading to end-of-document, and a
	// stray "Dropped material" heading is invisible to the topology check at
	// every level except 2 — without this error a drop list emitted after the
	// candidate would be approved INTO memory as candidate content, silently.
	// All heading levels, markdown's up-to-3-space indent, emphasis wrappers,
	// and loose inner spacing are matched: a worker that misplaces the section
	// is exactly the worker likely to bend its shape too. A source that
	// already carries such a heading as legitimate user memory is exempt —
	// erroring there would block every Review of that room (a dead end) and
	// coerce an undisclosed drop of the user's own content.
	const droppedMaterialHeading = /^[ \t]{0,3}#{1,6}[ \t]+[*_`~]*[ \t]*dropped[ \t]+material\b/im;
	if (droppedMaterialHeading.test(candidateReviewTargetL1b) && !droppedMaterialHeading.test(sourceReviewTargetL1b)) errors.push("Candidate review target must not contain a Dropped material section");
	if (/structural review constitution|section descriptions|source review target l1b/i.test(candidateReviewTargetL1b)) errors.push("Candidate review target appears to contain prompt scaffolding");
	const sourceTokens = structuralReviewMetrics(sourceReviewTargetL1b).estimatedTokens;
	const candidateTokens = structuralReviewMetrics(candidateReviewTargetL1b).estimatedTokens;
	if (candidateTokens > sourceTokens) warnings.push("Candidate review target is larger than source review target");
	return { valid: errors.length === 0, warnings, errors, sourceTopLevelSections, candidateTopLevelSections };
}
