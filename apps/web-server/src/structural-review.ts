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
}

export interface StructuralReviewProposalPromptInput extends StructuralReviewAssessmentPromptInput {
	assessmentMarkdown: string;
	assessmentHandoff?: StructuralReviewAssessmentHandoffInput;
	memoryBudgetTokens?: number;
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

function estimateTokens(text: string): number {
	return Math.ceil(text.length / 4);
}

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

## Must-Keep Material

Entries marked **must-keep** record explicit user remember-requests. Keep them in the candidate, exact in commitments, numbers, names, and dates. Remove or rewrite a must-keep entry only when the user explicitly directed it in this Prune discussion, or when a newer must-keep entry clearly supersedes it — and in either case name the removal under Warnings, because must-keep material is exactly what the user must not lose without noticing.

## Candidate boundary

When asked for a candidate, output only the rewritten review target containing ## Deep Memory and ## Active Items in that order. Do not output ## Chronos, ## Recent Context, or any other top-level section.`;
}

export function buildStructuralReviewAssessmentPrompt(input: StructuralReviewAssessmentPromptInput): StructuralReviewAssessmentPromptAssembly {
	const now = input.now ?? new Date();
	const reviewTarget = normalizeText(input.sourceReviewTargetL1b);
	const metrics = structuralReviewMetrics(reviewTarget);
	const prompt = [
		structuralReviewConstitution().trim(),
		`## Process Metadata\n\n- Agent id: ${input.agentId}\n- Process type: ${STRUCTURAL_REVIEW_WORKER_TYPE}\n- Operation: structural_review\n- Mode: ${STRUCTURAL_REVIEW_MODE}\n- currentTime: ${now.toISOString()}\n- System-selected model: ${input.model.provider}/${input.model.model}\n- Writes memory: false`,
		`## Section Descriptions\n\n${formatSectionDescriptions(input.sectionDescriptions)}`,
		`## Current Review-Target Memory Map\n\n${formatMemoryMap(metrics.memoryMap)}`,
		`## Material: Source Review Target L1b\n\nThe following is the complete source review target. It intentionally contains only Deep Memory and Active Items. Chronos and Recent Context are not provided to you.\n\n${reviewTarget.trim()}`,
		`## Task: Prune memory assessment\n\nProduce a concise initial assessment. The memory map must be the first user-visible section after the title. Do not produce a candidate rewrite.\n\nUse exactly this markdown structure:\n\n## Prune memory assessment\n\n### Memory map\n${formatMemoryMap(metrics.memoryMap)}\n\n### Looks healthy\n- 2-4 bullets on stable areas that appear coherent and worth preserving.\n\n### Stale or drift-prone\n- 0-5 bullets citing memory that may now be obsolete, duplicated, or misleading.\n\n### Could be denser\n- 2-5 bullets on high-token / low-signal areas that can be tightened.\n\n### Structure opportunities\n- 1-4 bullets on Deep Memory or Active Items subsection changes that would improve coherence.\n\n### Proposed direction\n- concise summary of likely pruning/reorganization direction.\n\nReturn only the assessment markdown. Do not include candidate L1b. Do not claim anything has been saved.`,
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

Return only the signoff handoff markdown. Do not generate the Prune Memory Proposal. Do not generate Candidate review target L1b. Do not claim memory has been saved.`;
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

export function buildStructuralReviewProposalPrompt(input: StructuralReviewProposalPromptInput): StructuralReviewProposalPromptAssembly {
	const now = input.now ?? new Date();
	const reviewTarget = normalizeText(input.sourceReviewTargetL1b);
	const metrics = structuralReviewMetrics(reviewTarget);
	const handoff = input.assessmentHandoff?.text.trim()
		? `## Optional Signed-Off Assessment Handoff\n\nSource: ${input.assessmentHandoff.source}\n\n${input.assessmentHandoff.text.trim()}`
		: `## Optional Signed-Off Assessment Handoff\n\nNone. The proposal should follow the direct initial assessment.`;
	const budgetSection = typeof input.memoryBudgetTokens === "number"
		? `## Memory Budget\n\n- Advisory memory budget: the whole L1b file should stay under ~${input.memoryBudgetTokens} estimated tokens; the review target (Deep Memory + Active Items) is the main lever.\n- The budget is a ceiling, not a goal. Never add, expand, or pad content because headroom remains — at any size, the densest faithful memory wins.\n- This is advisory. Never remove must-keep entries without explicit user direction, and never violate the constitution to satisfy it.`
		: null;
	const retrySection = input.retryFeedback?.length
		? `## Retry Notice\n\nA previous draft of this proposal was rejected by validation for these reasons:\n\n${input.retryFeedback.map((reason) => `- ${reason}`).join("\n")}\n\nProduce a complete, corrected proposal that resolves every reason above while following the Task structure exactly.`
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
		`## Task: Prune memory proposal\n\nProduce a parseable Prune memory proposal plus complete candidate review target L1b.\n\nThe candidate review target must contain exactly these top-level sections in this order:\n\n## Deep Memory\n## Active Items\n\nDo not output ## Chronos, ## Recent Context, or any other top-level section. The backend will graft preserved Chronos and Recent Context back exactly.\n\nUse exactly this markdown structure:\n\n## Prune Memory Proposal\n\n### Mode\nSTC_DIAGNOSTIC\n\n### Summary\n[Concise summary of the stable-memory pruning direction.]\n\n### Section-Level Change Log\n| Section | Prior Tokens | Candidate Tokens | Disposition | Rationale |\n|---|---:|---:|---|---|\n\n### Subsection / Entry Detail\n| Area | Operation | Rationale |\n|---|---|---|\n\n### Staleness Flags\n[Specific stale or contradictory claims, or "None detected."]\n\n### Proposed Memory Map\n| Area | Words | Estimated tokens |\n|---|---:|---:|\n\n### Review Target Metrics\n- Review target words before: ${metrics.words}\n- Review target words after: [n]\n- Review target estimated tokens before: ${metrics.estimatedTokens}\n- Review target estimated tokens after: [n]\n- Estimated token delta: [+/- n]\n\n### Warnings\nNone, or concise uncertainty flags.\n\n### Candidate review target L1b\n[Complete rewritten Deep Memory and Active Items content only.]\n\nReturn only the proposal markdown. Do not claim anything has been saved.`,
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
		looksHealthy: extractBullets(extractMarkdownSection(raw, "Looks healthy")),
		staleOrDriftProne: extractBullets(extractMarkdownSection(raw, "Stale or drift-prone")),
		couldBeDenser: extractBullets(extractMarkdownSection(raw, "Could be denser")),
		structureOpportunities: extractBullets(extractMarkdownSection(raw, "Structure opportunities")),
		proposedDirection: extractBullets(extractMarkdownSection(raw, "Proposed direction"))[0] ?? extractMarkdownSection(raw, "Proposed direction"),
	};
	const warnings: string[] = [];
	if (!extractMarkdownSection(raw, "Memory map")) warnings.push("assessment missing Memory map");
	if (fields.looksHealthy.length === 0) warnings.push("assessment missing Looks healthy bullets");
	if (fields.couldBeDenser.length === 0) warnings.push("assessment missing Could be denser bullets");
	if (fields.structureOpportunities.length === 0) warnings.push("assessment missing Structure opportunities bullets");
	if (!fields.proposedDirection) warnings.push("assessment missing Proposed direction");
	return { fields, warnings };
}

function extractCandidateReviewTargetL1b(raw: string): string {
	const start = raw.search(/^###\s+Candidate review target L1b\s*$/im);
	if (start < 0) return "";
	return raw.slice(start).replace(/^###\s+Candidate review target L1b\s*\r?\n?/i, "").trim();
}

export function parseStructuralReviewProposal(raw: string): { fields: StructuralReviewProposalFields; warnings: string[] } {
	const fields: StructuralReviewProposalFields = {
		mode: extractMarkdownSection(raw, "Mode"),
		summary: extractMarkdownSection(raw, "Summary"),
		sectionLevelChangeLog: extractMarkdownSection(raw, "Section-Level Change Log"),
		subsectionEntryDetail: extractMarkdownSection(raw, "Subsection / Entry Detail"),
		stalenessFlags: extractMarkdownSection(raw, "Staleness Flags"),
		proposedMemoryMap: extractMarkdownSection(raw, "Proposed Memory Map"),
		reviewTargetMetrics: extractMarkdownSection(raw, "Review Target Metrics"),
		warnings: extractMarkdownSection(raw, "Warnings"),
		candidateReviewTargetL1b: extractCandidateReviewTargetL1b(raw),
	};
	const warnings: string[] = [];
	if (!/STC_DIAGNOSTIC/i.test(fields.mode)) warnings.push("proposal mode is not STC_DIAGNOSTIC");
	if (!fields.summary) warnings.push("proposal missing Summary");
	if (!fields.sectionLevelChangeLog) warnings.push("proposal missing Section-Level Change Log");
	if (!fields.subsectionEntryDetail) warnings.push("proposal missing Subsection / Entry Detail");
	if (!fields.proposedMemoryMap) warnings.push("proposal missing Proposed Memory Map");
	if (!fields.reviewTargetMetrics) warnings.push("proposal missing Review Target Metrics");
	if (!fields.candidateReviewTargetL1b) warnings.push("proposal missing Candidate review target L1b");
	return { fields, warnings };
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
	if (/structural review constitution|section descriptions|source review target l1b/i.test(candidateReviewTargetL1b)) errors.push("Candidate review target appears to contain prompt scaffolding");
	const sourceTokens = structuralReviewMetrics(sourceReviewTargetL1b).estimatedTokens;
	const candidateTokens = structuralReviewMetrics(candidateReviewTargetL1b).estimatedTokens;
	if (candidateTokens > sourceTokens) warnings.push("Candidate review target is larger than source review target");
	return { valid: errors.length === 0, warnings, errors, sourceTopLevelSections, candidateTopLevelSections };
}
