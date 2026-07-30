export const ABSORB_CONSOLIDATION_WORKER_TYPE = "absorb-consolidation-worker" as const;
export const ABSORB_DISCUSSION_WORKER_TYPE = "absorb-discussion-worker" as const;
export const ABSORB_CONSOLIDATION_MODE = "rc_consolidation" as const;
export const ABSORB_DISCUSSION_MODE = "rc_consolidation_discussion" as const;
export const MIN_ABSORB_RECENT_CONTEXT_ENTRIES = 5;
export const ABSORB_EMPTY_RECENT_CONTEXT_PLACEHOLDER = "No checkpointed sessions yet.";
export const ABSORB_DISCUSSION_TOKEN_BUDGET = {
	softWarning: 75000,
	hardStop: 100000,
} as const;

export interface AbsorbModelLock {
	provider: string;
	model: string;
	label?: string;
}

export interface AbsorbAvailability {
	available: boolean;
	reason: "available" | "not_ready" | "insufficient_recent_context" | "missing_recent_context" | "error";
	recentContextEntryCount: number;
	minimumRecentContextEntries: number;
	message: string;
}

export interface AbsorbRecentContextMetrics {
	l1bChars: number;
	stableL1bChars: number;
	recentContextChars: number;
	recentContextEntryCount: number;
	recentContextEntryIds: string[];
}

export interface AbsorbPromptTelemetry extends AbsorbRecentContextMetrics {
	promptChars: number;
	promptEstimatedTokens: number;
	sectionPurposeCount: number;
}

export type AbsorbDiscussionTokenBudgetState = "ok" | "soft_warning" | "hard_stop";

export interface AbsorbDiscussionTokenBudget {
	promptEstimatedTokens: number;
	softWarningTokens: number;
	hardStopTokens: number;
	state: AbsorbDiscussionTokenBudgetState;
	canContinue: boolean;
	canSignOff: boolean;
}

export interface AbsorbDiscussionPromptTelemetry extends AbsorbPromptTelemetry {
	discussionMessageCount: number;
	userMessageChars: number;
}

export interface AbsorbSectionPurpose {
	name: string;
	status?: string;
	owner?: string;
	description?: string;
}

export type AbsorbSectionPurposeMap = Record<string, AbsorbSectionPurpose>;

export interface AbsorbAssessmentFields {
	whatToRemember: string[];
	whatToForget: string[];
	stableMemoryChanges: {
		deepMemory: string[];
		activeItems: string[];
		recentContext: string;
	};
	needsJudgment: string[];
}

export interface AbsorbAssessmentHandoffInput {
	source: "direct_assessment" | "discussion_signoff";
	text: string;
}

export interface AbsorbSourceFingerprint {
	algorithm: "sha256";
	value: string;
}

export type AbsorbDiscussionRole = "user" | "assistant";

export interface AbsorbDiscussionMessage {
	role: AbsorbDiscussionRole;
	content: string;
}

export interface AbsorbAssessmentPromptInput {
	agentId: string;
	l1b: string;
	model: AbsorbModelLock;
	sectionPurposeMap?: AbsorbSectionPurposeMap;
	now?: Date;
}

export interface AbsorbProposalPromptInput extends AbsorbAssessmentPromptInput {
	assessmentMarkdown: string;
	assessmentHandoff?: AbsorbAssessmentHandoffInput;
	memoryBudgetTokens?: number;
	/**
	 * Validation reasons from a previous rejected draft ("Draft again").
	 * When present, the prompt closes with a Retry Notice so the worker
	 * corrects the named failures instead of re-rolling blind.
	 */
	retryFeedback?: string[];
}

export interface AbsorbDiscussionPromptInput extends AbsorbAssessmentPromptInput {
	assessmentMarkdown: string;
	messages: AbsorbDiscussionMessage[];
	userMessage?: string;
	sourceFingerprint: AbsorbSourceFingerprint;
	mode: "turn" | "signoff";
}

export interface AbsorbAssessmentPromptAssembly {
	prompt: string;
	metrics: AbsorbRecentContextMetrics;
	telemetry: AbsorbPromptTelemetry;
}

export interface AbsorbProposalPromptAssembly extends AbsorbAssessmentPromptAssembly {
	assessmentHandoff?: AbsorbAssessmentHandoffInput;
}

export interface AbsorbDiscussionPromptAssembly extends AbsorbAssessmentPromptAssembly {
	tokenBudget: AbsorbDiscussionTokenBudget;
	telemetry: AbsorbDiscussionPromptTelemetry;
}

export interface AbsorbProposalFields {
	mode: string;
	primacyMap: string;
	sectionLevelChangeLog: string;
	entryLevelDetail: string;
	compressionMetrics: string;
	warnings: string;
	candidateL1b: string;
}

export type AbsorbReviewAction = "preserve" | "promote" | "update" | "merge" | "clear" | "drop" | "none" | "needs_judgment";

export interface AbsorbReviewSectionChange {
	section: string;
	action: AbsorbReviewAction;
	description: string;
}

export interface AbsorbReviewEntryChange {
	sourceEntry: string;
	action: AbsorbReviewAction;
	targetSection?: string;
	rationale: string;
}

export interface AbsorbReviewMetrics {
	recentContextEntriesBefore: number;
	recentContextEntriesAfter: number;
	sourceBytes: number;
	candidateBytes: number;
	stableMemoryDeltaBytes: number;
	sourceEstimatedTokens: number;
	candidateEstimatedTokens: number;
	stableMemoryDeltaTokens: number;
}

export interface AbsorbProposalReview {
	summary: string;
	sectionChanges: AbsorbReviewSectionChange[];
	entryChanges: AbsorbReviewEntryChange[];
	keyMetrics: AbsorbReviewMetrics;
}

export interface AbsorbCandidateValidationResult {
	valid: boolean;
	warnings: string[];
	errors: string[];
	sourceTopLevelSections: string[];
	candidateTopLevelSections: string[];
	recentContextEntryCount: number;
}

const MANDATORY_L1B_SECTIONS = ["Chronos", "Deep Memory", "Active Items", "Recent Context"] as const;

function estimateTokens(text: string): number {
	return Math.ceil(text.length / 4);
}

export function absorbDiscussionTokenBudget(promptEstimatedTokens: number): AbsorbDiscussionTokenBudget {
	const state: AbsorbDiscussionTokenBudgetState = promptEstimatedTokens >= ABSORB_DISCUSSION_TOKEN_BUDGET.hardStop
		? "hard_stop"
		: promptEstimatedTokens >= ABSORB_DISCUSSION_TOKEN_BUDGET.softWarning
			? "soft_warning"
			: "ok";
	return {
		promptEstimatedTokens,
		softWarningTokens: ABSORB_DISCUSSION_TOKEN_BUDGET.softWarning,
		hardStopTokens: ABSORB_DISCUSSION_TOKEN_BUDGET.hardStop,
		state,
		canContinue: state !== "hard_stop",
		canSignOff: true,
	};
}

function normalizeLine(value: string): string {
	return value.replace(/\s+/g, " ").trim();
}

function uniqueStrings(values: string[]): string[] {
	return [...new Set(values)];
}

export function extractTopLevelSections(markdown: string): string[] {
	const sections: string[] = [];
	for (const match of markdown.matchAll(/^##\s+(.+?)\s*$/gm)) sections.push(match[1].trim());
	return sections;
}

export function extractRecentContextForAbsorb(l1b: string): { before: string; recentContext: string; after: string; exists: boolean; entryIds: string[]; entryCount: number } {
	const match = /^##\s+Recent Context\s*$/m.exec(l1b);
	if (!match || match.index == null) return { before: l1b, recentContext: "", after: "", exists: false, entryIds: [], entryCount: 0 };
	const start = match.index;
	const rest = l1b.slice(start);
	const nextMatch = /^##\s+/m.exec(rest.slice(match[0].length));
	const end = nextMatch?.index == null ? l1b.length : start + match[0].length + nextMatch.index;
	const recentContext = l1b.slice(start, end);
	const entryIds = uniqueStrings(
		[...recentContext.matchAll(/^###\s+(RC-[^\s|]+).*$/gm)]
			.map((entry) => entry[1].trim())
			.filter((id) => !/stub/i.test(id)),
	);
	return {
		before: l1b.slice(0, start),
		recentContext,
		after: l1b.slice(end),
		exists: true,
		entryIds,
		entryCount: entryIds.length,
	};
}

export function absorbRecentContextMetrics(l1b: string): AbsorbRecentContextMetrics {
	const recent = extractRecentContextForAbsorb(l1b);
	return {
		l1bChars: l1b.length,
		stableL1bChars: recent.before.length + recent.after.length,
		recentContextChars: recent.recentContext.length,
		recentContextEntryCount: recent.entryCount,
		recentContextEntryIds: recent.entryIds,
	};
}

export function absorbAvailabilityFromL1b(l1b: string, scaffoldReady = true): AbsorbAvailability {
	if (!scaffoldReady) {
		return {
			available: false,
			reason: "not_ready",
			recentContextEntryCount: 0,
			minimumRecentContextEntries: MIN_ABSORB_RECENT_CONTEXT_ENTRIES,
			message: "Persistent agent scaffold is not ready.",
		};
	}
	const recent = extractRecentContextForAbsorb(l1b);
	if (!recent.exists) {
		return {
			available: false,
			reason: "missing_recent_context",
			recentContextEntryCount: 0,
			minimumRecentContextEntries: MIN_ABSORB_RECENT_CONTEXT_ENTRIES,
			message: "Recent Context section is missing.",
		};
	}
	if (recent.entryCount < MIN_ABSORB_RECENT_CONTEXT_ENTRIES) {
		return {
			available: false,
			reason: "insufficient_recent_context",
			recentContextEntryCount: recent.entryCount,
			minimumRecentContextEntries: MIN_ABSORB_RECENT_CONTEXT_ENTRIES,
			message: `Absorb requires at least ${MIN_ABSORB_RECENT_CONTEXT_ENTRIES} Recent Context entries. Current count: ${recent.entryCount}.`,
		};
	}
	return {
		available: true,
		reason: "available",
		recentContextEntryCount: recent.entryCount,
		minimumRecentContextEntries: MIN_ABSORB_RECENT_CONTEXT_ENTRIES,
		message: "Absorb is available.",
	};
}

export function buildSectionPurposeMap(registry: unknown): AbsorbSectionPurposeMap {
	const sections = (registry as any)?.sections;
	if (!sections || typeof sections !== "object") return {};
	const out: AbsorbSectionPurposeMap = {};
	for (const [name, raw] of Object.entries(sections)) {
		const section = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
		out[name] = {
			name,
			status: typeof section.status === "string" ? section.status : undefined,
			owner: typeof section.owner === "string" ? section.owner : undefined,
			description: typeof section.description === "string" ? section.description : undefined,
		};
	}
	return out;
}

function formatSectionPurposeMap(map?: AbsorbSectionPurposeMap): string {
	const entries = Object.values(map ?? {});
	if (entries.length === 0) {
		return MANDATORY_L1B_SECTIONS.map((name) => `- ${name}: mandatory L1b section.`).join("\n");
	}
	return entries
		.map((section) => {
			const attrs = [section.status, section.owner].filter(Boolean).join(", ");
			return `- ${section.name}${attrs ? ` (${attrs})` : ""}: ${section.description ?? "No description provided."}`;
		})
		.join("\n");
}

function absorbConsolidationConstitution(): string {
	return `# exxperts Absorb Consolidation Constitution

You are a platform-owned absorb/consolidation worker inside exxperts.

You are not the persistent agent. You are not participating in ordinary chat. You are an ephemeral hidden maintenance process invoked to analyze current L1b memory and accumulated Recent Context.

This operation must not write memory, archive files, mutate L1b, update Chronos, or create sidecar event records. You only produce assessment/proposal text for system validation and later human review.

## Governing Principle

Maximize durable signal density. Absorb is not append-only memory growth. It rewrites stable memory so the future persistent agent understands more with fewer, sharper tokens. Integration should make stable memory denser, not merely larger: prefer merging new understanding into existing entries over appending parallel blocks.

## Scope

- Read the current L1b, including Recent Context.
- Treat Recent Context as a chronological intake buffer.
- Integrate only the highest-signal durable material into stable sections.
- Route durable understanding primarily to Deep Memory.
- Route unresolved live state primarily to Active Items.
- Drop noise, completed implementation chatter, redundant detail, and material better suited to files or telemetry.
- Apply sensitive-material restraint when promoting to stable memory: health, conflicts with named people, finances, religious or political identity, and third parties' private details become permanent only when load-bearing for future work or explicitly requested by the user.

## Reading Recent Context in Order

Recent Context entries are chronologically ordered session compressions: the lowest RC number is oldest, the last entry is newest. Read them in order and treat the chain as a trajectory, because later entries supersede earlier ones — a decision recorded early and reversed later must consolidate as the reversal, not the original. When entries conflict, the newer entry wins unless it explicitly defers to the older one.

## Must-Keep Material

Recent Context may carry content marked **must-keep** — explicit user remember-requests and operator-named content from checkpoint compression. Integrate must-keep material into the appropriate stable section and carry the **must-keep** marker with it, because the user's explicit request outlives the intake buffer. Never drop it, and keep its commitments, numbers, names, and dates exact. If two must-keep items conflict, keep the newer one and note in the proposal that it superseded the older.

## Boundaries

- Do not include or request L1a.
- Do not roleplay as the persistent room agent.
- Do not claim memory has been saved.
- Do not add, remove, rename, or reorder top-level L1b sections.
- Preserve mandatory sections: Chronos, Deep Memory, Active Items, Recent Context.
- Candidate L1b for MVP strict absorb must leave zero Recent Context entries while preserving the Recent Context section.
- Keep Chronos concise and do not turn it into an operations ledger.
`;
}

export function buildAbsorbAssessmentPrompt(input: AbsorbAssessmentPromptInput): AbsorbAssessmentPromptAssembly {
	const now = input.now ?? new Date();
	const metrics = absorbRecentContextMetrics(input.l1b);
	const prompt = [
		absorbConsolidationConstitution().trim(),
		`## Process Metadata\n\n- Agent id: ${input.agentId}\n- Process type: ${ABSORB_CONSOLIDATION_WORKER_TYPE}\n- Mode: ${ABSORB_CONSOLIDATION_MODE}\n- Trigger time: ${now.toISOString()}\n- System-selected model: ${input.model.provider}/${input.model.model}\n- Writes memory: false\n- Recent Context entries: ${metrics.recentContextEntryCount}`,
		`## Section Purpose Map\n\n${formatSectionPurposeMap(input.sectionPurposeMap)}`,
		`## Material: Current L1b Memory State\n\nThe following is the complete current L1b. It includes stable sections and Recent Context. Do not expect or require L1a.\n\n${input.l1b.trim()}`,
		`## Task: Compact Initial Assessment\n\nProduce a compact absorb assessment. The assessment should help the user decide whether to generate a full Memory Absorption Proposal. Keep it scannable and non-intimidating.\n\nUse exactly this markdown structure:\n\n## Absorb assessment\n\nI found ${metrics.recentContextEntryCount} Recent Context entries. Here is the proposed direction.\n\n### What to remember\n- 3-5 bullets max.\n\n### What to forget\n- 2-4 bullets max.\n\n### What changes in stable memory\n- Deep Memory: 1-3 bullets.\n- Active Items: 1-3 bullets.\n- Recent Context: all entries are expected to be cleared after approval.\n\n### Needs your judgment\n- 0-3 short questions or uncertainty flags. If none, write: None\n\nReturn only the assessment markdown. Do not include Candidate L1b. Do not claim anything has been saved.`,
	].join("\n\n---\n\n") + "\n";
	return {
		prompt,
		metrics,
		telemetry: {
			...metrics,
			promptChars: prompt.length,
			promptEstimatedTokens: estimateTokens(prompt),
			sectionPurposeCount: Object.keys(input.sectionPurposeMap ?? {}).length,
		},
	};
}

function formatAbsorbDiscussionTranscript(messages: AbsorbDiscussionMessage[]): string {
	if (messages.length === 0) return "No prior discussion messages.";
	return messages
		.map((message, index) => {
			const role = message.role === "assistant" ? "Assistant" : "User";
			return `### ${index + 1}. ${role}\n\n${message.content.trim() || "(empty)"}`;
		})
		.join("\n\n");
}

function absorbDiscussionTask(mode: "turn" | "signoff"): string {
	if (mode === "signoff") {
		return `## Task: Absorb Discussion Signoff Handoff

The user has chosen to generate a memory proposal from this discussion. Produce a bounded structured handoff for the separate proposal operator.

Use exactly this markdown structure:

## Absorb discussion signoff

### User guidance
- Concise bullets capturing explicit user preferences, corrections, or priorities from the discussion.

### Learn / memorize
- Durable information that should be considered for Deep Memory.

### Clear / forget
- Recent Context material that can be cleared, forgotten, or treated as implementation chatter/noise.

### Update existing memory
- Existing stable-memory understanding that should be sharpened, corrected, or merged.

### Needs judgment
- None, or concise unresolved uncertainty flags.

### Transcript summary
Briefly summarize the discussion that led to this signoff.

Return only the signoff handoff markdown. Do not generate Candidate L1b. Do not claim memory has been saved.`;
	}
	return `## Task: Absorb Discussion Turn

Reply to the user's latest message as the absorb discussion operator. Help them inspect and refine what should be learned, memorized, updated, cleared, or forgotten.

Keep the reply focused on the memory-maintenance task. Ask focused clarification questions only when useful. Do not generate the official Candidate L1b. Do not claim memory has been saved. Do not mention tools, sessions, checkpoints, or ordinary chat persistence.

Return only the assistant discussion message.`;
}

export function buildAbsorbDiscussionPrompt(input: AbsorbDiscussionPromptInput): AbsorbDiscussionPromptAssembly {
	const now = input.now ?? new Date();
	const metrics = absorbRecentContextMetrics(input.l1b);
	const promptParts = [
		absorbConsolidationConstitution().trim(),
		`## Absorb Discussion Operator Addendum

You are the absorb discussion operator. You are a platform-owned, ephemeral memory-maintenance worker. You are not the persistent agent and you are not ordinary chat.

Your job is to help the user refine what should be learned, memorized, merged, preserved, cleared, or forgotten before a separate proposal operator generates the official Memory Absorption Proposal.

Hard boundaries:

- No tools.
- No file writes.
- No memory writes.
- No checkpoint creation.
- No session id.
- No Candidate L1b generation as the official proposal.
- No claims that memory has been saved.
- No normal persistent-agent runtime envelope.
- No L1a injection.`,
		`## Process Metadata

- Agent id: ${input.agentId}
- Process type: ${ABSORB_DISCUSSION_WORKER_TYPE}
- Mode: ${ABSORB_DISCUSSION_MODE}
- Trigger time: ${now.toISOString()}
- System-selected model: ${input.model.provider}/${input.model.model}
- Writes memory: false
- Source L1b fingerprint: ${input.sourceFingerprint.algorithm}:${input.sourceFingerprint.value}
- Recent Context entries: ${metrics.recentContextEntryCount}`,
		`## Section Purpose Map

${formatSectionPurposeMap(input.sectionPurposeMap)}`,
		`## Material: Current L1b Memory State

The following is the complete source L1b that this absorb discussion is reviewing. It includes stable sections and Recent Context. Do not expect or require L1a.

${input.l1b.trim()}`,
		`## Material: Initial Absorb Assessment

${input.assessmentMarkdown.trim()}`,
		`## Material: Discussion Transcript So Far

${formatAbsorbDiscussionTranscript(input.messages)}`,
		input.userMessage?.trim() ? `## Latest User Message

${input.userMessage.trim()}` : `## Latest User Message

None.`,
		absorbDiscussionTask(input.mode),
	];
	const promptWithoutBudget = promptParts.join("\n\n---\n\n") + "\n";
	const budget = absorbDiscussionTokenBudget(estimateTokens(promptWithoutBudget));
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
	const finalBudget = absorbDiscussionTokenBudget(estimateTokens(prompt));
	return {
		prompt,
		metrics,
		tokenBudget: finalBudget,
		telemetry: {
			...metrics,
			promptChars: prompt.length,
			promptEstimatedTokens: finalBudget.promptEstimatedTokens,
			sectionPurposeCount: Object.keys(input.sectionPurposeMap ?? {}).length,
			discussionMessageCount: input.messages.length,
			userMessageChars: input.userMessage?.length ?? 0,
		},
	};
}

export function buildAbsorbProposalPrompt(input: AbsorbProposalPromptInput): AbsorbProposalPromptAssembly {
	const now = input.now ?? new Date();
	const metrics = absorbRecentContextMetrics(input.l1b);
	const handoff = input.assessmentHandoff?.text.trim()
		? `## Optional Signed-Off Assessment Handoff\n\nSource: ${input.assessmentHandoff.source}\n\n${input.assessmentHandoff.text.trim()}`
		: `## Optional Signed-Off Assessment Handoff\n\nNone. The proposal should follow the direct initial assessment.`;
	const budgetSection = typeof input.memoryBudgetTokens === "number"
		? `## Memory Budget\n\n- Advisory memory budget: the whole L1b should stay under ~${input.memoryBudgetTokens} estimated tokens (~${input.memoryBudgetTokens * 4} characters).\n- The budget is a ceiling, not a goal. Never add, expand, or pad content because headroom remains — at any size, the densest faithful memory wins.\n- This is advisory. Never drop must-keep content or violate the constitution to satisfy it.`
		: null;
	const retrySection = input.retryFeedback?.length
		? `## Retry Notice\n\nA previous draft of this proposal was rejected by validation for these reasons:\n\n${input.retryFeedback.map((reason) => `- ${reason}`).join("\n")}\n\nProduce a complete, corrected proposal that resolves every reason above while following the Task structure exactly.`
		: null;
	const prompt = [
		absorbConsolidationConstitution().trim(),
		`## Process Metadata\n\n- Agent id: ${input.agentId}\n- Process type: ${ABSORB_CONSOLIDATION_WORKER_TYPE}\n- Mode: ${ABSORB_CONSOLIDATION_MODE}\n- Trigger time: ${now.toISOString()}\n- System-selected model: ${input.model.provider}/${input.model.model}\n- Writes memory: false\n- Recent Context entries: ${metrics.recentContextEntryCount}`,
		`## Section Purpose Map\n\n${formatSectionPurposeMap(input.sectionPurposeMap)}`,
		`## Material: Current L1b Memory State\n\nThe following is the complete current L1b. It includes stable sections and Recent Context. Do not expect or require L1a.\n\n${input.l1b.trim()}`,
		`## Material: Signed-Off Initial Assessment\n\n${input.assessmentMarkdown.trim()}`,
		handoff,
		...(budgetSection ? [budgetSection] : []),
		`## Task: Memory Absorption Proposal\n\nProduce a parseable Memory Absorption Proposal plus complete Candidate L1b.\n\nThe Candidate L1b must preserve the exact top-level section topology and order from the source L1b. It must include Chronos, Deep Memory, Active Items, and Recent Context. It must clear all Recent Context entries: no headings starting with \`### RC-\` may remain under Recent Context. Preserve the Recent Context section with this placeholder unless a future system prompt says otherwise:\n\n${ABSORB_EMPTY_RECENT_CONTEXT_PLACEHOLDER}\n\nUse exactly this markdown structure:\n\n## Memory Absorption Proposal\n\n### Mode\nRC_CONSOLIDATION\n\n### Primacy Map\n[Concise summary of what the RC chain represented as a whole.]\n\n### Section-Level Change Log\n| Section | Prior Words | Candidate Words | Action | Rationale |\n|---|---:|---:|---|---|\n\n### Entry-Level Detail\n| Entry / Block | Operation | Target Section | Rationale |\n|---|---|---|---|\n\n### Compression Metrics\n- RC input words: [n]\n- RC removed words: [n]\n- RC removed percent: [x]%\n- Stable memory words before: [n]\n- Stable memory words after: [n]\n- Stable memory delta: [+/- n]\n- Compression ratio: [ratio]\n\n### Warnings\nNone, or concise uncertainty flags.\n\n### Candidate L1b\n[Complete rewritten L1b.]\n\nReturn only the proposal markdown. Do not claim anything has been saved.`,
		...(retrySection ? [retrySection] : []),
	].join("\n\n---\n\n") + "\n";
	return {
		prompt,
		metrics,
		assessmentHandoff: input.assessmentHandoff,
		telemetry: {
			...metrics,
			promptChars: prompt.length,
			promptEstimatedTokens: estimateTokens(prompt),
			sectionPurposeCount: Object.keys(input.sectionPurposeMap ?? {}).length,
		},
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

function markdownByteLength(value: string): number {
	return Buffer.byteLength(value.trimEnd() + "\n", "utf-8");
}

function stableL1bText(l1b: string): string {
	const recent = extractRecentContextForAbsorb(l1b);
	return `${recent.before}${recent.after}`.trimEnd() + "\n";
}

function extractBullets(section: string): string[] {
	const bullets = section
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter((line) => /^[-*•]\s+/.test(line))
		.map((line) => line.replace(/^[-*•]\s+/, "").trim())
		.filter(Boolean);
	if (bullets.length > 0) return bullets;
	const normalized = normalizeLine(section);
	return normalized && !/^none\.?$/i.test(normalized) ? [normalized] : [];
}

function extractPrefixedBullets(section: string, prefix: string): string[] {
	const lines = section.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
	const prefixPattern = new RegExp(`^[-*•]\\s+${prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*:\\s*(.+)$`, "i");
	const direct = lines.map((line) => prefixPattern.exec(line)?.[1]?.trim()).filter((value): value is string => Boolean(value));
	if (direct.length > 0) return direct.flatMap((value) => value.split(/;\s*/)).map((value) => value.trim()).filter(Boolean);
	return [];
}

export function parseAbsorbAssessment(raw: string): { fields: AbsorbAssessmentFields; warnings: string[] } {
	const remember = extractMarkdownSection(raw, "What to remember");
	const forget = extractMarkdownSection(raw, "What to forget");
	const changes = extractMarkdownSection(raw, "What changes in stable memory");
	const judgment = extractMarkdownSection(raw, "Needs your judgment");
	const fields: AbsorbAssessmentFields = {
		whatToRemember: extractBullets(remember),
		whatToForget: extractBullets(forget),
		stableMemoryChanges: {
			deepMemory: extractPrefixedBullets(changes, "Deep Memory"),
			activeItems: extractPrefixedBullets(changes, "Active Items"),
			recentContext: extractPrefixedBullets(changes, "Recent Context")[0] ?? "All entries are expected to be cleared after approval.",
		},
		needsJudgment: extractBullets(judgment),
	};
	const warnings: string[] = [];
	if (fields.whatToRemember.length === 0) warnings.push("assessment missing What to remember bullets");
	if (fields.whatToForget.length === 0) warnings.push("assessment missing What to forget bullets");
	if (fields.stableMemoryChanges.deepMemory.length === 0) warnings.push("assessment missing Deep Memory change bullets");
	if (fields.stableMemoryChanges.activeItems.length === 0) warnings.push("assessment missing Active Items change bullets");
	return { fields, warnings };
}

function extractCandidateL1b(raw: string): string {
	const start = raw.search(/^###\s+Candidate L1b\s*$/im);
	if (start < 0) return "";
	return raw.slice(start).replace(/^###\s+Candidate L1b\s*\r?\n?/i, "").trim();
}

export function parseAbsorbProposal(raw: string): { fields: AbsorbProposalFields; warnings: string[] } {
	const fields: AbsorbProposalFields = {
		mode: extractMarkdownSection(raw, "Mode"),
		primacyMap: extractMarkdownSection(raw, "Primacy Map"),
		sectionLevelChangeLog: extractMarkdownSection(raw, "Section-Level Change Log"),
		entryLevelDetail: extractMarkdownSection(raw, "Entry-Level Detail"),
		compressionMetrics: extractMarkdownSection(raw, "Compression Metrics"),
		warnings: extractMarkdownSection(raw, "Warnings"),
		candidateL1b: extractCandidateL1b(raw),
	};
	const warnings: string[] = [];
	if (!/RC_CONSOLIDATION/i.test(fields.mode)) warnings.push("proposal mode is not RC_CONSOLIDATION");
	if (!fields.primacyMap) warnings.push("proposal missing Primacy Map");
	if (!fields.sectionLevelChangeLog) warnings.push("proposal missing Section-Level Change Log");
	if (!fields.entryLevelDetail) warnings.push("proposal missing Entry-Level Detail");
	if (!fields.compressionMetrics) warnings.push("proposal missing Compression Metrics");
	if (!fields.candidateL1b) warnings.push("proposal missing Candidate L1b");
	return { fields, warnings };
}

function parseMarkdownTableRows(markdown: string): Record<string, string>[] {
	const tableLines = markdown.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.startsWith("|") && line.endsWith("|"));
	if (tableLines.length < 3 || !/^\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?$/.test(tableLines[1])) return [];
	const parseRow = (line: string) => line.replace(/^\|/, "").replace(/\|$/, "").split("|").map((cell) => cell.trim());
	const headers = parseRow(tableLines[0]).map((header) => normalizeLine(header).toLowerCase());
	return tableLines.slice(2).map(parseRow).filter((row) => row.length === headers.length).map((row) => Object.fromEntries(row.map((cell, index) => [headers[index], cell])));
}

function normalizeAbsorbReviewAction(value: string): AbsorbReviewAction {
	const normalized = value.toLowerCase();
	if (/\b(needs? judgment|uncertain|review)\b/.test(normalized)) return "needs_judgment";
	if (/\b(drop|forget|discard|omit|shed)\b/.test(normalized)) return "drop";
	if (/\b(clear|remove|drain)\b/.test(normalized)) return "clear";
	if (/\b(merge|consolidate|combine|integrate)\b/.test(normalized)) return "merge";
	if (/\b(promote|memorize|learn|carry forward)\b/.test(normalized)) return "promote";
	if (/\b(update|revise|sharpen|rewrite|refresh)\b/.test(normalized)) return "update";
	if (/\b(preserve|keep|retain|unchanged|maintain)\b/.test(normalized)) return "preserve";
	if (/\b(none|no change|unchanged)\b/.test(normalized)) return "none";
	return value.trim() ? "update" : "none";
}

function firstTableCell(row: Record<string, string>, names: string[]): string {
	for (const name of names) {
		const found = row[name];
		if (found) return found;
	}
	return "";
}

function parseSectionReviewChanges(markdown: string): AbsorbReviewSectionChange[] {
	return parseMarkdownTableRows(markdown).map((row) => {
		const section = firstTableCell(row, ["section", "target section"]);
		const actionText = firstTableCell(row, ["action", "operation"]);
		const rationale = firstTableCell(row, ["rationale", "description"]);
		const prior = firstTableCell(row, ["prior words", "before", "prior"]);
		const candidate = firstTableCell(row, ["candidate words", "after", "candidate"]);
		const sizeText = prior || candidate ? `Prior: ${prior || "unknown"}; Candidate: ${candidate || "unknown"}. ` : "";
		return {
			section: section || "Unspecified section",
			action: normalizeAbsorbReviewAction(actionText || rationale),
			description: normalizeLine(`${sizeText}${rationale || actionText || "No rationale provided."}`),
		};
	});
}

function parseEntryReviewChanges(markdown: string): AbsorbReviewEntryChange[] {
	return parseMarkdownTableRows(markdown).map((row) => {
		const sourceEntry = firstTableCell(row, ["entry / block", "entry", "source entry", "block"]);
		const operation = firstTableCell(row, ["operation", "action"]);
		const targetSection = firstTableCell(row, ["target section", "section"]);
		const rationale = firstTableCell(row, ["rationale", "description"]);
		return {
			sourceEntry: sourceEntry || "Unspecified Recent Context",
			action: normalizeAbsorbReviewAction(operation || rationale),
			targetSection: targetSection || undefined,
			rationale: rationale || operation || "No rationale provided.",
		};
	});
}

export function buildAbsorbProposalReview(sourceL1b: string, fields: AbsorbProposalFields): AbsorbProposalReview {
	const sourceRecent = extractRecentContextForAbsorb(sourceL1b);
	const candidateRecent = extractRecentContextForAbsorb(fields.candidateL1b);
	const sourceStable = stableL1bText(sourceL1b);
	const candidateStable = stableL1bText(fields.candidateL1b);
	const stableMemoryDeltaBytes = markdownByteLength(candidateStable) - markdownByteLength(sourceStable);
	const stableMemoryDeltaTokens = estimateTokens(candidateStable) - estimateTokens(sourceStable);
	return {
		summary: fields.primacyMap || "No summary provided.",
		sectionChanges: parseSectionReviewChanges(fields.sectionLevelChangeLog),
		entryChanges: parseEntryReviewChanges(fields.entryLevelDetail),
		keyMetrics: {
			recentContextEntriesBefore: sourceRecent.entryCount,
			recentContextEntriesAfter: candidateRecent.entryCount,
			sourceBytes: markdownByteLength(sourceL1b),
			candidateBytes: markdownByteLength(fields.candidateL1b),
			stableMemoryDeltaBytes,
			sourceEstimatedTokens: estimateTokens(sourceL1b),
			candidateEstimatedTokens: estimateTokens(fields.candidateL1b),
			stableMemoryDeltaTokens,
		},
	};
}

export function validateAbsorbCandidateL1b(sourceL1b: string, candidateL1b: string): AbsorbCandidateValidationResult {
	const sourceTopLevelSections = extractTopLevelSections(sourceL1b);
	const candidateTopLevelSections = extractTopLevelSections(candidateL1b);
	const errors: string[] = [];
	const warnings: string[] = [];
	if (candidateL1b.trim().length === 0) errors.push("Candidate L1b is empty");
	for (const section of MANDATORY_L1B_SECTIONS) {
		if (!candidateTopLevelSections.includes(section)) errors.push(`Candidate L1b missing mandatory section: ${section}`);
	}
	if (sourceTopLevelSections.join("\n") !== candidateTopLevelSections.join("\n")) {
		errors.push("Candidate L1b top-level section topology/order differs from source L1b");
	}
	const candidateRecent = extractRecentContextForAbsorb(candidateL1b);
	if (!candidateRecent.exists) errors.push("Candidate L1b missing Recent Context section");
	if (candidateRecent.entryCount > 0) errors.push("Candidate L1b must clear all Recent Context entries for strict absorb");
	if (candidateRecent.exists) {
		const body = candidateRecent.recentContext.replace(/^##\s+Recent Context\s*$/m, "").trim();
		if (!body) warnings.push("Candidate Recent Context is empty; checkpoint append may expect a placeholder");
		if (/section purpose map|absorb consolidation constitution|memory absorption proposal/i.test(body)) errors.push("Candidate Recent Context appears to contain prompt/proposal scaffolding");
	}
	return {
		valid: errors.length === 0,
		warnings,
		errors,
		sourceTopLevelSections,
		candidateTopLevelSections,
		recentContextEntryCount: candidateRecent.entryCount,
	};
}
