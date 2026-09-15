/**
 * Display label for an agent id in usage/history views. Rooms are labelled by
 * their id; the fixed entries cover ids from retired agents that can still
 * appear in historical usage data.
 */
export function agentLabel(id: string): string {
	const RETIRED: Record<string, string> = {
		coordinator: "Coordinator",
		exxcode: "exxperts CLI Agent",
		"knowledge-weaver": "Knowledge Weaver",
		"content-producer": "Content Producer",
		researcher: "Researcher",
	};
	return RETIRED[id] ?? id;
}

export interface SkillInfo {
	name: string;
	displayName?: string;
	description: string;
	body: string;
	source: string;
	protected: boolean;
	usedByAgents: string[];
}

export interface ConversationMeta {
	id: string;
	title: string;
	createdAt: number;
	updatedAt: number;
	agent: string;
	persona: string;
	activeOwner: string;
	messageCount: number;
}

export interface PersistedConversation extends Omit<ConversationMeta, "messageCount"> {
	items: ChatItem[];
}

export interface AuthProviderStatus {
	id: string;
	name: string;
	configured: boolean;
	source?: "stored" | "runtime" | "environment" | "fallback" | "models_json_key" | "models_json_command";
	label?: string;
	oauth: boolean;
}

export interface AuthStatusResponse {
	anyConfigured: boolean;
	authDir: string;
	providers: AuthProviderStatus[];
}

export interface WebChatModelOption {
	provider: string;
	model: string;
	label: string;
	recommended?: boolean;
	contextWindow?: number;
}

export type ContextHealthZone = "green" | "yellow" | "red" | "unknown";

export interface ContextHealthStatus {
	tokens: number | null;
	contextWindow: number | null;
	checkpointTokens: number;
	checkpointPercent: number | null;
	zone: ContextHealthZone;
	source: "runtime-context-usage" | "unknown";
}

export interface PersistentRoomModelSelectionState {
	path: string;
	compatibility: "legacy-web-chat-model-selection";
}

export interface WebChatModelStatus {
	ready: boolean;
	selected: WebChatModelOption | null;
	recommended: WebChatModelOption | null;
	models: WebChatModelOption[];
	activeProfileId?: string;
	activeProfileLabel?: string;
	roomRecommended?: WebChatModelOption | null;
	roomModels?: WebChatModelOption[];
	selectionState?: PersistentRoomModelSelectionState;
	message: string | null;
}

export type PersistentRoomModelOption = WebChatModelOption;
export type PersistentRoomModelStatus = WebChatModelStatus;

export interface PersistentRoomPathHashView {
	algorithm: "sha256";
	value: string;
}

export type PersistentRoomWorkspaceRootSource = "manual" | "query-param" | "runtime-state" | "admin-dev" | string;

export interface PersistentRoomWorkspaceRootView {
	id: string;
	displayLabel: string;
	basename: string;
	pathHash: PersistentRoomPathHashView;
	source: PersistentRoomWorkspaceRootSource;
}

export type PersistentRoomWorkspaceAccessMode = "bounded" | "localFiles";

export type PersistentRoomWorkspaceToolSelectionView =
	| { kind: "standard"; allowedToolNames: string[] }
	| { kind: "custom"; allowedToolNames: string[] };

export interface PersistentRoomCapabilityPolicyView {
	schemaVersion: 1;
	policyId: string;
	agentId: string;
	conversationId: string;
	workspaceAccessMode: PersistentRoomWorkspaceAccessMode;
	rootCount: number;
	roots: PersistentRoomWorkspaceRootView[];
	modes: { read: boolean; write: boolean };
	allowedToolNames: string[];
	toolSelection?: PersistentRoomWorkspaceToolSelectionView;
	denySegments: string[];
	pathAccess?: "workspace-only" | "local-files";
	writeEnabled: boolean;
	bashEnabled?: boolean;
	nativePiFilesystemToolsEnabled?: boolean;
}

export interface PersistentRoomWorkspacePolicyResponse {
	agentId: string;
	conversationId: string;
	storage: { kind: string };
	policy: PersistentRoomCapabilityPolicyView | null;
}

export interface PersistentRoomWorkspaceValidateResponse extends PersistentRoomWorkspacePolicyResponse {
	policy: PersistentRoomCapabilityPolicyView;
	warnings: string[];
}

export interface PersistentRoomWorkspaceClearResponse extends PersistentRoomWorkspacePolicyResponse {
	policy: null;
	deleted: boolean;
}

export interface PersistentRoomWorkspaceDefaultInput {
	root?: string;
	displayLabel?: string;
	workspaceAccessMode?: PersistentRoomWorkspaceAccessMode;
	toolSelection?: PersistentRoomWorkspaceToolSelectionView;
	bashEnabled?: boolean;
}

export interface PersistentRoomWorkspaceDefaultResponse {
	agentId: string;
	storage: { kind: string };
	policy: PersistentRoomCapabilityPolicyView | null;
	warnings?: string[];
	deleted?: boolean;
}

export type SystemChooseFolderResponse =
	| { supported: true; cancelled: false; path: string }
	| { supported: true; cancelled: true; path: null };

export interface PersistentAgentAiProfileStatus {
	id: string;
	label: string;
	kind: "builtin" | "gateway" | "custom";
	overridden?: boolean;
	active: boolean;
	ready: boolean;
	message: string | null;
	issues?: string[];
	provider: {
		id: string;
		configured: boolean;
		source?: AuthProviderStatus["source"];
		label?: string;
	};
	requiredModels: Array<{
		provider: string;
		model: string;
		label?: string;
		purpose?: string;
		present: boolean;
		authConfigured: boolean;
	}>;
	processes?: {
		persistentRoom: {
			ready: boolean;
			models: Array<{
				provider: string;
				model: string;
				label?: string;
				present: boolean;
				authConfigured: boolean;
			}>;
		};
	};
}

export interface PersistentAgentAiProfileSelectionStatus {
	activeProfileId: string;
	activeProfile: PersistentAgentAiProfileStatus;
	profiles: PersistentAgentAiProfileStatus[];
	state: {
		path: string;
		source: "file" | "auto" | "default" | "invalid";
		message: string | null;
	};
	customProfiles?: {
		path: string;
		errors: string[];
	};
}

export interface LoginProviderCatalogEntry {
	id: string;
	name: string;
	authTypes: Array<"oauth" | "api_key">;
	configured: boolean;
	profileId: string | null;
}

export interface ProviderModelCatalog {
	provider: string;
	providerLabel: string;
	suggested: string;
	note?: string;
	models: Array<{
		id: string;
		name: string;
		contextWindow?: number;
		maxTokens?: number;
		suggestedDefault: boolean;
	}>;
}

export interface MaintenanceWorkerModelStatus {
	provider: string;
	model: string;
	label?: string;
}

export interface MaintenanceWorkerProfileStatus {
	id: string;
	label: string;
	provider: {
		id: string;
		label: string;
	};
}

export type CheckpointDensity = "compact" | "standard" | "rich";

export type AbsorbAvailabilityReason = "available" | "not_ready" | "insufficient_recent_context" | "missing_recent_context" | "error";

export interface AbsorbAvailability {
	available: boolean;
	reason: AbsorbAvailabilityReason;
	recentContextEntryCount: number;
	minimumRecentContextEntries: number;
	message: string;
	model?: MaintenanceWorkerModelStatus | null;
	profile?: MaintenanceWorkerProfileStatus;
	writesMemory?: false;
	error?: string;
	/** Memorize v2 adds the session list, the budget and the pre-pass verdict; a v1 server sends none of them. */
	version?: 2;
	sessions?: { id: string; title: string; date: string; tokens: number }[];
	budget?: BudgetState;
	prepass?: { demotionRequired: boolean; entriesOverBudget: number };
}

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

export interface AbsorbPromptTelemetry {
	l1bChars: number;
	stableL1bChars: number;
	recentContextChars: number;
	recentContextEntryCount: number;
	recentContextEntryIds: string[];
	promptChars: number;
	promptEstimatedTokens: number;
	sectionPurposeCount: number;
}

export interface AbsorbUsage {
	input?: number;
	output?: number;
	cacheRead?: number;
	cacheWrite?: number;
	totalTokens?: number;
	cost?: number;
}

export interface AbsorbAssessmentResponse {
	agentId: PersistentAgentId;
	writesMemory: false;
	process: {
		type: "absorb-consolidation-worker";
		model: { provider: string; model: string; label?: string };
	};
	availability: AbsorbAvailability;
	source: AbsorbProposalSourceMetadata;
	assessmentMarkdown: string;
	fields: AbsorbAssessmentFields;
	absorbTelemetry: AbsorbPromptTelemetry;
	absorbUsage?: AbsorbUsage;
	warnings: string[];
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

export interface AbsorbCandidateValidationResult {
	valid: boolean;
	warnings: string[];
	errors: string[];
	sourceTopLevelSections: string[];
	candidateTopLevelSections: string[];
	recentContextEntryCount: number;
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

export interface L1bSourceFingerprint {
	algorithm: "sha256";
	value: string;
}

export interface AbsorbProposalSourceMetadata {
	l1bFingerprint: L1bSourceFingerprint;
	generatedAt: string;
}

export interface AbsorbDiscussionSourceMetadata {
	l1bFingerprint: L1bSourceFingerprint;
	checkedAt: string;
}

export type AbsorbDiscussionRole = "user" | "assistant";

export interface AbsorbDiscussionMessage {
	role: AbsorbDiscussionRole;
	content: string;
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

export interface AbsorbDiscussionTurnResponse {
	agentId: PersistentAgentId;
	writesMemory: false;
	process: {
		type: "absorb-discussion-worker";
		model: { provider: string; model: string; label?: string };
	};
	availability: AbsorbAvailability;
	source: AbsorbDiscussionSourceMetadata;
	message: AbsorbDiscussionMessage;
	absorbDiscussionTelemetry: AbsorbDiscussionPromptTelemetry;
	absorbDiscussionUsage?: AbsorbUsage;
	tokenBudget: AbsorbDiscussionTokenBudget;
	warnings: string[];
}

export interface AbsorbDiscussionSignoffResponse {
	agentId: PersistentAgentId;
	writesMemory: false;
	process: {
		type: "absorb-discussion-worker";
		model: { provider: string; model: string; label?: string };
	};
	availability: AbsorbAvailability;
	source: AbsorbDiscussionSourceMetadata;
	assessmentHandoff: {
		source: "discussion_signoff";
		text: string;
	};
	/** The same sign-off as the fields every fold honours; absent on a server that still answers v1. */
	guidance?: FoldGuidance;
	absorbDiscussionTelemetry: AbsorbDiscussionPromptTelemetry;
	absorbDiscussionUsage?: AbsorbUsage;
	tokenBudget: AbsorbDiscussionTokenBudget;
	warnings: string[];
}

// Mirrors the server's MemoryBudgetImpact: before/after review-target tokens
// plus the server-computed verdicts. Cards render these fields verbatim and
// never re-derive the comparison. Optional on the responses so the UI stays
// honest against an older server that doesn't send it.
export interface MemoryBudgetImpact {
	budgetTokens: number;
	reviewTargetEstimatedTokensBefore: number;
	reviewTargetEstimatedTokensAfter: number;
	overBudgetBefore: boolean;
	overBudgetAfter: boolean;
}

export interface AbsorbProposalResponse {
	agentId: PersistentAgentId;
	writesMemory: false;
	process: {
		type: "absorb-consolidation-worker";
		model: { provider: string; model: string; label?: string };
	};
	availability: AbsorbAvailability;
	source: AbsorbProposalSourceMetadata;
	fields: AbsorbProposalFields;
	review?: AbsorbProposalReview;
	candidateValidation: AbsorbCandidateValidationResult;
	memoryBudgetImpact?: MemoryBudgetImpact;
	absorbTelemetry: AbsorbPromptTelemetry;
	absorbUsage?: AbsorbUsage;
	warnings: string[];
}

export interface AbsorbApprovalResponse {
	agentId: PersistentAgentId;
	writesMemory: true;
	absorbId: string;
	/** This save under the name the undo route takes; absent on older servers. */
	saveId?: string;
	eventRelPath: string;
	recentContextEntryCount: number;
	memoryBudget?: { budgetTokens: number; reviewTargetEstimatedTokens: number; overBudget: boolean };
	postAbsorb: {
		returnToLauncher: true;
	};
	warnings: string[];
	/** Memorize v2: which sessions were written into memory, which stay for the next update, and how many entries went to the archive. */
	foldedSessions?: string[];
	remainingSessions?: string[];
	archivedEntries?: number;
	/** How many of those left for the budget alone (pre-pass plus post-fold demotions), so the saved screen can say so even when nothing folded. */
	archivedForBudget?: number;
	/** The card raised the limit and this save wrote the room setting; the new value. */
	budgetRaisedTo?: number;
}

// ── Memory v2 (api contract 2026-09-13) ────────────────────────────────────
// One entry of the room's memory as every screen shows it. Estimated tokens
// are the product's chars/4, computed by the server; the client never
// re-derives a size or a budget verdict.

export type EntryKind = "event" | "fact" | "practice" | "item";

export interface EntryCard {
	id: string;
	section: "Deep Memory" | "Active Items";
	topic: string;
	kind: EntryKind;
	/** YYYY-MM-DD */
	saved: string;
	/** The session this entry came from, in the server's own id vocabulary; screens word it as a date. */
	from?: string;
	pinned: boolean;
	status?: "open" | "done";
	updated?: string;
	refs?: number;
	tokens: number;
	/** Full markdown text of the entry, without its metadata line. */
	text: string;
}

/**
 * One row of the archive list on the Memorize and Review cards. The list is
 * stable for the life of a run: a row that stops leaving stays on the list and
 * says so, instead of vanishing under the person's hand.
 */
export type ArchiveRow = EntryCard & {
	/** The current computation moves it to the archive. */
	leaving: boolean;
	/** The person kept it, by id or by topic; pinned on Save. */
	kept: boolean;
	/** It entered the list because of a keep, an edit or a limit change after the first computation: a replacement. Cleared when it stops leaving. */
	instead: boolean;
	/** "before": left before any conversation was read (the room was already over); "after": left to make room for what was read. Diagnostics only; the screens never show it. */
	phase: "before" | "after";
	/** Position in the demotion order, 0 leaves first. Rows within a topic come rank ascending; topics keep document order. */
	rank: number;
};

/** The archive list and the keep sets of a run, as both engines report them. */
export interface RunDemotion {
	/** Every note this run ever proposed for the archive, in a stable order: rows are never removed for the life of the run. */
	entries: ArchiveRow[];
	keepIds: string[];
	/** Topics the person protected for this run: no note of these topics leaves. "Deep Memory/Nordwind integration", section and title. */
	keepTopics: string[];
	overageTokens: number;
	/** The counts the card shows; computed by the server, never in the browser. */
	counts: { leaving: number; kept: number; instead: number; staying?: number };
}

/** Where a run leaves the memory limit. */
export interface RunBudget {
	before: number;
	after: number;
	/** The limit this run is computed against: the room's setting, or the value chosen on the card. */
	budgetTokens: number;
	/** The room's saved setting; differs from budgetTokens when the card raised it and Save has not happened yet. */
	savedBudgetTokens: number;
	overBudgetAfter: boolean;
	ceilingTokens: number;
}

export interface ArchivedEntryCard extends EntryCard {
	/** YYYY-MM-DD */
	archived: string;
	/** "stale" and "duplicate" are Review's own reasons; the other four are older than it. */
	why: "budget" | "superseded" | "done" | "user" | "stale" | "duplicate";
}

export interface BudgetState {
	reviewTargetTokens: number;
	budgetTokens: number;
	overBudget: boolean;
}

/** The structured sign-off of a memory discussion: what the user asked for, in fields the run honours. */
export interface FoldGuidance {
	pin: string[];
	drop: { session: string; reason: string }[];
	corrections: string[];
	topics: ({ create: string } | { merge: string[]; into: string })[];
	instructions: string[];
}

/** What a person agreed in the Review discussion, carried into the tidy as instructions. */
export interface ReviewGuidance {
	/** Notes or topics to leave exactly as they are. */
	keepAsIs: string[];
	/** Notes or topics to make shorter. */
	shorten: string[];
	/** Notes or topics to move to the archive, with the person's reason when given. */
	remove: string[];
	/** Answers the person gave to the first read's questions. */
	answers: string[];
	/** Any other instruction, one sentence each. */
	instructions: string[];
	/** Topic titles the tidy should cover; empty means every topic the first read flagged. */
	topics: string[];
}

/** How far the tidy goes: wording only, or wording plus what is finished or stale. */
export type ReviewDepth = "wording" | "tidy";

/** Why a review cannot start, when it cannot. */
export type ReviewAvailabilityReason = "available" | "room_busy" | "not_migrated" | "no_notes" | "run_active";

export interface ReviewAvailability {
	available: boolean;
	reason: ReviewAvailabilityReason;
	message: string;
	topics: number;
	notes: number;
	budgetTokens: number;
	reviewTargetTokens: number;
	overBudget: boolean;
	/** Which of the two tidies the screen offers first. */
	recommendedDepth: ReviewDepth;
}

/**
 * The first read, in fields. The three lists are what the screen shows;
 * `topics` is the machine-read list the tidy works from and is never shown.
 */
export interface ReviewAssessmentFields {
	couldBeShorter: string[];
	staleOrContradicts: string[];
	needsYourCall: string[];
	topics: string[];
	/** Notes that say the same thing twice, as sentences; the machine finds them, not the model. Absent on an older server. */
	saysTheSameTwice?: string[];
	/** The same pairs by id and topic, for the tidy; never shown. */
	duplicateNotes?: { ids: [string, string]; topics: [string, string] }[];
	/** Two topic titles that look like one topic, as sentences. Absent on an older server. */
	topicsThatLookTheSame?: string[];
	/** The same pairs by title, for the tidy; never shown. */
	lookAlikeTopics?: { a: string; b: string }[];
}

export interface ReviewAssessmentResponse {
	agentId: PersistentAgentId;
	writesMemory: false;
	availability: ReviewAvailability;
	assessmentMarkdown: string;
	fields: ReviewAssessmentFields;
	warnings: string[];
	source: { l1bFingerprint: L1bSourceFingerprint };
}

export type ReviewDiscussionTokenBudgetState = "ok" | "soft_warning" | "hard_stop";

export interface ReviewDiscussionTokenBudget {
	promptEstimatedTokens: number;
	softWarningTokens: number;
	hardStopTokens: number;
	state: ReviewDiscussionTokenBudgetState;
	canContinue: boolean;
	canSignOff: boolean;
}

export interface ReviewDiscussionTurnResponse {
	agentId: PersistentAgentId;
	writesMemory: false;
	message: { role: "assistant"; content: string };
	tokenBudget: ReviewDiscussionTokenBudget;
	warnings: string[];
}

export interface ReviewDiscussionSignoffResponse {
	agentId: PersistentAgentId;
	writesMemory: false;
	guidance: ReviewGuidance;
	signoffMarkdown: string;
	warnings: string[];
}

export type AbsorbRunState = "prepass" | "folding" | "budget" | "ready" | "approving" | "saved" | "cancelled" | "failed";

export type AbsorbRunSessionOutcome = "pending" | "folding" | "folded" | "dropped" | "failed" | "skipped";

export type AbsorbRunChangeKind = "added" | "updated" | "superseded" | "closed" | "pinned";

export interface AbsorbRunChange {
	kind: AbsorbRunChangeKind;
	id: string;
	topic: string;
	before?: string;
	after?: string;
	/** An add that created its topic in this run: the first note under a title the memory did not have. */
	newTopic?: true;
}

export interface AbsorbRunSession {
	id: string;
	title: string;
	date: string;
	outcome: AbsorbRunSessionOutcome;
	/** dropped: why nothing was kept; failed: the product sentence; skipped: the user's own instruction. */
	reason?: string;
	summary?: { added: number; updated: number; superseded: number; closed: number };
	changes?: AbsorbRunChange[];
	attempts: number;
}

export interface AbsorbRun {
	runId: string;
	agentId: PersistentAgentId;
	state: AbsorbRunState;
	startedAt: string;
	updatedAt: string;
	progress: { folded: number; total: number; current?: { id: string; title: string } };
	sessions: AbsorbRunSession[];
	/** Entries archived before any model call, because the room was already over its budget. Diagnostics and the older smokes; the card reads `demotion` alone. */
	prepass: { demoted: EntryCard[] };
	budget: RunBudget;
	/** The archive list, stable for the run, with the keep sets and the counts the card shows. */
	demotion: RunDemotion;
	candidate: { sourceFingerprint: L1bSourceFingerprint; estimatedTokens: number } | null;
	/** The sign-off this run was started with, echoed so the card can list it; null when nothing was asked for. */
	guidance: FoldGuidance | null;
	/**
	 * A room whose memory had no entry ids: the run gave them in memory and the
	 * approval write performs the migration. A note for the card, never a blocker
	 * — it must not keep an otherwise clean update off the automatic path.
	 */
	migration: { pending: boolean; entriesAssigned: number } | null;
	warnings: string[];
	usage?: { input?: number; output?: number; totalTokens?: number; cost?: number };
	/** failed: one product sentence. */
	error?: string;
}

/** The 202 answer to a v2 propose: the run to poll, not a finished draft. */
export interface AbsorbRunStart {
	runId: string;
}

/** Memorize v2 extras on absorb/status; absent on a server that still answers v1. */
export interface AbsorbStatusV2Fields {
	version?: 2;
	sessions?: { id: string; title: string; date: string; tokens: number }[];
	budget?: BudgetState;
	prepass?: { demotionRequired: boolean; entriesOverBudget: number };
}

// ── Review v2 ──────────────────────────────────────────────────────────────
// Review tidies notes that are already in memory: it says the same things in
// fewer words and, at the deeper setting, moves what is finished or stale to
// the archive. Every note keeps its id, its date and its pin.

export type ReviewRunState = "prepass" | "tidying" | "budget" | "ready" | "approving" | "saved" | "cancelled" | "failed";

export type ReviewRunChangeKind = "shortened" | "merged" | "archived" | "closed" | "moved" | "pinned" | "topic_folded";

export interface ReviewRunChange {
	id: string;
	section: "Deep Memory" | "Active Items";
	topic: string;
	kind: ReviewRunChangeKind;
	/** The note's words before, or — for a move — the topic it came from; for a fold, the topic folded away. */
	before?: string;
	/** The note's words after, or — for a move — the topic it now sits under; for a fold, the topic that took its notes. */
	after?: string;
	/** archived and closed: the reason the archive row carries. */
	why?: string;
	/** merged: the notes that became this one, the surviving id first. */
	mergedFrom?: string[];
	/** topic_folded: how many notes the fold moved; the row's id is the first of them. */
	notesMoved?: number;
	/** archived as duplicate: the note that already says it, and the topic it sits under. */
	duplicateOf?: { id: string; topic: string };
}

/** A group of topics whose tidy never came back in a form the memory could accept. */
export interface ReviewRunLeftAsIs {
	topics: string[];
	reason: string;
}

/** The structured sign-off of the Review discussion, echoed back on the run. */
export interface ReviewGuidance {
	keepAsIs: string[];
	shorten: string[];
	remove: string[];
	answers: string[];
	instructions: string[];
	topics: string[];
}

export interface ReviewRun {
	runId: string;
	agentId: PersistentAgentId;
	state: ReviewRunState;
	depth: ReviewDepth;
	startedAt: string;
	updatedAt: string;
	/** Groups finished of groups planned, and the topic the run is on now. */
	progress: { group: number; groups: number; label?: string };
	/** The topics this run set out to tidy, in document order. */
	topics: string[];
	changes: ReviewRunChange[];
	leftAsIs: ReviewRunLeftAsIs[];
	budget: RunBudget;
	/** The archive list, stable for the run, with the keep sets and the counts the card shows. */
	demotion: RunDemotion;
	candidate: { sourceFingerprint: L1bSourceFingerprint; estimatedTokens: number } | null;
	/** What the person agreed in the discussion; null when nothing was asked for. */
	guidance: ReviewGuidance | null;
	/**
	 * A room whose memory had no note ids: the run gave them in memory and the
	 * approval write performs the migration. A note for the card, never a blocker.
	 */
	migration: { pending: boolean; entriesAssigned: number } | null;
	warnings: string[];
	usage?: { input?: number; output?: number; totalTokens?: number; cost?: number };
	/** failed: one product sentence. */
	error?: string;
}

/** The 202 answer to starting a review: the run to poll. */
export interface ReviewRunStart {
	runId: string;
}

export interface ReviewRunApprovalResponse {
	agentId: PersistentAgentId;
	writesMemory: true;
	reviewId: string;
	/** This save under the name the undo route takes — the same value as `reviewId`. */
	saveId: string;
	eventRelPath: string;
	memoryBudget: { budgetTokens: number; reviewTargetEstimatedTokens: number; overBudget: boolean };
	topicsTidied: number;
	notesChanged: number;
	archivedEntries: number;
	/** How many of those left for the budget alone, so the saved screen can say so. */
	archivedForBudget: number;
	/** The card raised the limit and this save wrote the room setting; the new value. */
	budgetRaisedTo?: number;
	warnings: string[];
}

/** What a room says about Review before anything starts. */
export interface ReviewStatusResponse {
	agentId: PersistentAgentId;
	available: boolean;
	/** Why not, in the product's own words; absent when it is available. */
	reason?: string;
	topics: number;
	notes: number;
	budget: BudgetState;
	/** "tidy" when the memory is over its limit, else "wording". */
	recommendedDepth: ReviewDepth;
	writesMemory: false;
}

export interface MemoryEntriesTopicGroup {
	section: "Deep Memory" | "Active Items";
	title: string;
	entries: EntryCard[];
}

export interface MemoryEntriesResponse {
	budget: BudgetState;
	/** A room in a conversation reads its memory but cannot be written to; the reason is the server's own sentence. */
	readOnly?: boolean;
	reason?: string;
	topics: MemoryEntriesTopicGroup[];
	archive: { count: number; byTopic: { section: string; topic: string; count: number; earliest: string; latest: string }[] };
}

export interface MemoryArchiveResponse {
	entries: ArchivedEntryCard[];
	/** The archived stamp to pass back as `before` for the next page. */
	next?: string;
}

export interface MemoryEntryWriteResponse {
	entry: EntryCard;
	budget: BudgetState;
}

export interface MemoryEntryDeleteResponse {
	archived: ArchivedEntryCard;
	budget: BudgetState;
}

/** What the server answers when the room's latest Memorize or Review save is taken back. */
export interface MemoryUndoResponse {
	agentId: PersistentAgentId;
	/** The undo's own id in the room's memory history. */
	undoId: string;
	undone: { saveId: string; kind: "memorize" | "review"; approvedAt: string };
	memoryBudget: { budgetTokens: number; reviewTargetEstimatedTokens: number; overBudget: boolean };
	/** Conversations back in Recent Context now the save is taken back. */
	recentContextCount: number;
	/** The save had raised the limit and nobody changed it since: the undo put it back to this. */
	limitLoweredTo?: number;
}

export type CheckpointTranscriptRuntimeKind = "transcript-recap-v1" | "pi-session-jsonl";

export interface BaseCheckpointTranscriptSourceMetadata {
	activeThreadId: string;
	runtimeKind: CheckpointTranscriptRuntimeKind;
	l1bFingerprint: L1bSourceFingerprint;
	transcriptFingerprint: L1bSourceFingerprint;
	transcriptItemCount: number;
}

export interface PiSessionCheckpointTranscriptSourceMetadata extends BaseCheckpointTranscriptSourceMetadata {
	runtimeKind: "pi-session-jsonl";
	sessionId: string;
	sessionFileRelPath: string;
	bootPromptSnapshotRelPath: string;
	bootPromptSha256: string;
	leafId: string | null;
	runtimeL1bFingerprint: L1bSourceFingerprint;
}

export interface LegacyCheckpointTranscriptSourceMetadata extends BaseCheckpointTranscriptSourceMetadata {
	runtimeKind: "transcript-recap-v1";
}

export type CheckpointTranscriptSourceMetadata = PiSessionCheckpointTranscriptSourceMetadata | LegacyCheckpointTranscriptSourceMetadata;

export interface PersistentAgentCheckpointRuntimeBoundary {
	closedThreadId: string;
	closedReason: "checkpoint";
	closedAt: number;
	closedByCheckpointId: string;
	oldRuntime: PersistentAgentThreadRuntime;
	newThreadId: string;
	newRuntime: PersistentAgentPiSessionJsonlThreadRuntime;
}

export interface CheckpointApprovalResponse {
	agentId: PersistentAgentId;
	conversationId: string;
	sessionId: string;
	checkpointId: string;
	writesMemory: true;
	eventRelPath: string;
	recentContextEntryCount: number;
	runtimeBoundary: PersistentAgentCheckpointRuntimeBoundary;
	postCheckpoint: {
		canContinue: true;
		canRest: true;
		activeThreadId: string;
		runtime: PersistentAgentPiSessionJsonlThreadRuntime;
	};
	warnings: string[];
}

export interface PersistentAgentMementoRuntimeBoundary {
	closedThreadId: string;
	closedReason: "memento";
	closedAt: number;
	closedByMementoId: string;
	oldRuntime: PersistentAgentThreadRuntime;
	newThreadId: string;
	newRuntime: PersistentAgentPiSessionJsonlThreadRuntime;
}

export interface PersistentAgentMementoBoundaryResponse {
	agentId: PersistentAgentId;
	conversationId: string;
	mementoId: string;
	writesMemory: false;
	eventRelPath: string;
	runtimeBoundary: PersistentAgentMementoRuntimeBoundary;
	postMemento: {
		canContinue: true;
		canRest: true;
		activeThreadId: string;
		runtime: PersistentAgentPiSessionJsonlThreadRuntime;
	};
	memory: {
		l1bMutated: false;
		l1bFingerprint: L1bSourceFingerprint;
	};
	warnings: string[];
}

export interface CheckpointProposalResponse {
	agentId: PersistentAgentId;
	conversationId: string;
	sessionId: null;
	writesMemory: false;
	process: {
		type: "checkpoint-compression-worker";
		parentConversationId: string;
		model: WebChatModelOption;
	};
	density: CheckpointDensity;
	targetTokens: { min?: number; max: number };
	fields: {
		title: string;
		sessionArc: string;
		body: string;
		parked: string;
	};
	preview: {
		title: string;
		summary: string;
		keyPoints: string[];
		hasParkedItems: boolean;
	};
	proposedRecentContext: string;
	estimatedTokens: number;
	compressionTelemetry: {
		l1bChars: number;
		l1bWithoutRecentContextChars: number;
		recentContextChars: number;
		recentContextEntryCount: number;
		transcriptChars: number;
		promptChars: number;
		promptEstimatedTokens: number;
		shortSessionMode?: "none" | "short" | "very-short";
		effectiveTargetTokens?: { min?: number; max: number };
	};
	compressionUsage?: {
		input?: number;
		output?: number;
		cacheRead?: number;
		cacheWrite?: number;
		totalTokens?: number;
		cost?: number;
	};
	source: CheckpointTranscriptSourceMetadata;
	warnings: string[];
}

export type PersistentAgentRuntimeStateValue = "idle" | "active" | "standby";
export type PersistentAgentThreadStateValue = "active" | "standby" | "closed";
export type PersistentAgentThreadOrigin = "launcher" | "home" | "sidequest" | "checkpoint" | "memento" | "unknown";
export type PersistentAgentThreadClosedReason = "checkpoint" | "memento";
export type PersistentAgentRuntimeBoundaryReason = "checkpoint" | "memento";
export type PersistentAgentThreadRuntimeKind = "transcript-recap-v1" | "pi-session-jsonl";

export type PersistentAgentId = string;

export interface PersistentAgentRuntimeState {
	schemaVersion: 1;
	agentId: PersistentAgentId;
	state: PersistentAgentRuntimeStateValue;
	activeThreadId: string | null;
	model: { provider: string; model: string; label?: string } | null;
	updatedAt: number;
}

export interface PersistentAgentTranscriptRecapThreadRuntime {
	kind: "transcript-recap-v1";
}

export interface L1bSourceFingerprint {
	algorithm: "sha256";
	value: string;
}

export interface PersistentAgentPiSessionJsonlThreadRuntime {
	kind: "pi-session-jsonl";
	sessionId: string;
	sessionFileRelPath: string;
	bootPromptSnapshotRelPath: string;
	bootPromptSha256: string;
	l1bFingerprint: L1bSourceFingerprint;
	createdAt: number;
	leafId?: string;
}

export type PersistentAgentThreadRuntime = PersistentAgentTranscriptRecapThreadRuntime | PersistentAgentPiSessionJsonlThreadRuntime;

export interface PersistentAgentThreadRecord {
	schemaVersion: 1;
	threadId: string;
	agentId: PersistentAgentId;
	state: PersistentAgentThreadStateValue;
	closedReason?: PersistentAgentThreadClosedReason;
	closedAt?: number;
	closedByCheckpointId?: string;
	closedByMementoId?: string;
	origin: PersistentAgentThreadOrigin;
	model: { provider: string; model: string; label?: string };
	runtime: PersistentAgentThreadRuntime;
	/**
	 * Frontend display cache. For `runtime.kind === "transcript-recap-v1"` only,
	 * this also remains the legacy bounded recap input. It is not future canonical
	 * runtime continuity truth.
	 */
	items: unknown[];
	/** Consult MR-5 pending-transfer queue (§2.3); omitted when empty. */
	pendingHandoffs?: string[];
	createdAt: number;
	updatedAt: number;
}

export type PersistentAgentActiveTurnStateValue = "idle" | "running" | "cancelling";
export type PersistentAgentActiveTurnTerminalReason = "completed" | "cancelled" | "failed" | "disconnect_cancelled";

export interface PersistentAgentActiveTurnState {
	state: PersistentAgentActiveTurnStateValue;
	turnId?: string;
	startedAt?: number;
	connectionId?: string;
	lastTerminalReason?: PersistentAgentActiveTurnTerminalReason;
	updatedAt: number;
}

export interface PersistentAgentActiveThreadSummary {
	threadId: string;
	state: PersistentAgentThreadStateValue;
	origin: PersistentAgentThreadOrigin;
	runtime: PersistentAgentThreadRuntime;
	itemCount: number;
	hasUserVisibleTurns: boolean;
	preparedByBoundary: PersistentAgentRuntimeBoundaryReason | null;
	preparedByCheckpoint: boolean;
	activeTurn?: PersistentAgentActiveTurnState;
	inFlight?: boolean;
	working?: boolean;
	cancelling?: boolean;
}

export type PersistentRoomScheduleStatus = "never_run" | "success" | "error" | "blocked" | "missed";
export type PersistentRoomScheduleType = "once" | "interval" | "cron";

export interface PersistentRoomScheduleJob {
	id: string;
	name: string;
	enabled: boolean;
	type: PersistentRoomScheduleType;
	schedule: string;
	prompt: string;
	createdAt: string;
	updatedAt: string;
	lastRunAt: string | null;
	lastStatus: PersistentRoomScheduleStatus | null;
	lastError: string | null;
	nextRunAt: string | null;
}

export interface PersistentRoomScheduleSummary {
	executionEnabled: false;
	totalCount: number;
	enabledCount: number;
	nextRunAt: string | null;
	lastRunAt: string | null;
	lastStatus: PersistentRoomScheduleStatus | null;
	lastError: string | null;
}

export interface PersistentRoomSchedulesResponse {
	roomId: PersistentAgentId;
	executionEnabled: false;
	jobs: PersistentRoomScheduleJob[];
	summary: PersistentRoomScheduleSummary;
}

export type PersistentRoomBackgroundRunStatus = "queued" | "running" | "deferred" | "blocked" | "succeeded" | "failed" | "cancelled";
export type PersistentRoomBackgroundRunKind = "scheduled-prompt" | "room-consult" | "global-memory-refresh";
export type PersistentRoomBackgroundRunTrigger = "manual" | "schedule-due" | "system";

export interface PersistentRoomBackgroundRunModelView {
	provider: string;
	model: string;
	label?: string;
}

export interface PersistentRoomBackgroundRunTargetView {
	kind: "resume-thread" | "fresh-thread" | "no-room-mutation" | "none";
	roomId?: string;
	threadId?: string;
	model?: PersistentRoomBackgroundRunModelView;
	modelPolicyKey?: string;
}

export interface PersistentRoomBackgroundRunSourceView {
	scheduleId?: string;
	trigger: PersistentRoomBackgroundRunTrigger;
	dueAt?: string;
}

export interface PersistentRoomBackgroundRunArtifactSummaryView {
	hasInput: boolean;
	hasOutput: boolean;
	hasEvents: boolean;
}

export interface PersistentRoomBackgroundRunLeaseSummaryView {
	claimedAt: string;
	expiresAt: string;
	heartbeatAt?: string;
	active: boolean;
}

export interface PersistentRoomBackgroundRunReadinessSummaryView {
	checkedAt: string;
	expiresAt?: string;
	result: "ready" | "deferred" | "blocked" | "cancelled" | "failed";
	reason: string;
	message?: string;
}

export interface PersistentRoomBackgroundRunView {
	runId: string;
	kind: PersistentRoomBackgroundRunKind;
	roomId: PersistentAgentId;
	source: PersistentRoomBackgroundRunSourceView;
	status: PersistentRoomBackgroundRunStatus;
	reason?: string;
	message?: string;
	createdAt: string;
	updatedAt: string;
	queuedAt?: string;
	startedAt?: string;
	finishedAt?: string;
	attempts: number;
	lease?: PersistentRoomBackgroundRunLeaseSummaryView;
	readiness?: PersistentRoomBackgroundRunReadinessSummaryView;
	target?: PersistentRoomBackgroundRunTargetView;
	artifacts?: PersistentRoomBackgroundRunArtifactSummaryView;
	warnings: string[];
	error?: { code: string; message: string };
}

export interface PersistentRoomBackgroundRunHistorySummary {
	totalReturned: number;
	latestCreatedAt: string | null;
	latestUpdatedAt: string | null;
	byStatus: Partial<Record<PersistentRoomBackgroundRunStatus, number>>;
}

export interface PersistentRoomBackgroundRunsResponse {
	roomId: PersistentAgentId;
	filters: {
		scheduleId?: string;
		status?: PersistentRoomBackgroundRunStatus;
		limit: number;
	};
	ordering: "createdAt_desc";
	runs: PersistentRoomBackgroundRunView[];
	summary: PersistentRoomBackgroundRunHistorySummary;
}

export interface PersistentRoomScheduleCreateRequest {
	name: string;
	type?: PersistentRoomScheduleType;
	schedule: string;
	prompt: string;
	enabled?: boolean;
}

export interface PersistentRoomScheduleUpdateRequest {
	name?: string;
	type?: PersistentRoomScheduleType;
	schedule?: string;
	prompt?: string;
	enabled?: boolean;
}

export interface PersistentRoomScheduleManagementResponse extends PersistentRoomSchedulesResponse {
	managementOnly: true;
	notice: string;
	job?: PersistentRoomScheduleJob;
	removed?: PersistentRoomScheduleJob;
}

export interface PersistentAgentStatus {
	id: PersistentAgentId;
	exists: boolean;
	status: "missing" | "ready" | "needs_absorb" | "error";
	root: string;
	runtime: PersistentAgentRuntimeState;
	activeThread: PersistentAgentActiveThreadSummary | null;
	/** Community #14 slice 3: a detached turn landed its answer while no session was connected; the server clears it when a session next binds to the room. */
	unseenLandedAnswer?: { threadId: string; turnId: string; terminalReason: "completed" | "failed"; landedAt: number; origin?: "detached-turn" | "scheduled-run" };
	/** Set when this room is currently open or busy in another surface (CLI, browser, or scheduled background work). */
	activeLock?: { surface: "cli" | "web" | "scheduler" | string; acquiredAt: number } | null;
	/** Issue #33: the web lock is held by a detached turn still cooking with NO client attached, so stepping back in is offered; a room genuinely open in another window stays locked out. */
	answeringDetached?: boolean;
	displayName?: string;
	description?: string;
	role?: string;
	model?: { provider: string; model: string } | string;
	/** The model this room's picker last settled on: an empty room's memory across profile switches. Display/seeding only; execution always rides the active profile. */
	preferredModel?: { provider: string; model: string };
	l1a: { path: string; exists: boolean; bytes?: number };
	l1b: { path: string; exists: boolean; bytes?: number; sections: string[]; missingSections: string[] };
	sectionRegistry: { path: string; exists: boolean; missingSections: string[] };
	recentContext: { fullEntries: number; softCap: number; hardCap: number; blockCap?: number };
	memoryStatus: {
		recentContextCount: number;
		recentContextSoftCap: number;
		recentContextHardCap: number;
		recentContextLevel: "empty" | "ok" | "approaching_soft_cap" | "at_soft_cap" | "hard_cap";
		lastCheckpointId: string | null;
		lastCheckpointAt: string | null;
	};
	scheduleSummary: PersistentRoomScheduleSummary;
	promptBudget?: {
		l0EstimatedTokens: number;
		l1aEstimatedTokens: number;
		l1bEstimatedTokens: number;
		l2EstimatedTokens: number;
		bootEstimatedTokens: number;
		state: "healthy" | "warning" | "pressure" | "hard";
		thresholds: { warning: number; pressure: number; hard: number };
	};
	memoryBudgetTokens?: number;
	// Server-computed budget condition. The budget binds on the review target
	// (Deep Memory + Active Items); render this block, never re-derive the
	// comparison client-side.
	memoryBudget?: { budgetTokens: number; reviewTargetEstimatedTokens: number; overBudget: boolean };
	errors: string[];
	warnings: string[];
}

export interface PersistentAgentModeOption {
	id: string;
	label: string;
	description: string;
}

export interface PersistentAgentModesResponse {
	defaultModeId: string;
	modes: PersistentAgentModeOption[];
}

export interface PersistentAgentCreateRequest {
	displayName: string;
	userName: string;
	preferredUserAddress?: string;
	mode?: string;
}

export interface PersistentAgentCreateResponse {
	agent: {
		id: PersistentAgentId;
		agentId: PersistentAgentId;
		displayName: string;
		description?: string;
		role: string;
		templateId: string;
		root: string;
		status: PersistentAgentStatus["status"];
	};
	status: PersistentAgentStatus;
	created: string[];
	warnings: string[];
}

export interface PersistentAgentRenameMemoryMention {
	line: number;
	text: string;
}

export interface PersistentAgentRenameResponse {
	agentId: PersistentAgentId;
	displayName: string;
	previousDisplayName: string;
	updatedAt: number;
	dryRun: boolean;
	/** True only when both constitution anchors (heading + Identity line) matched the old name and were rewritten. */
	constitutionUpdated: boolean;
	constitutionAnchors: { heading: boolean; identity: boolean };
	/** Word-boundary exact mentions of the old name in the room's learned memory. */
	memoryMentions: { count: number; lines: PersistentAgentRenameMemoryMention[] };
	memoryUpdated: boolean;
	archivedL1b: string | null;
}

export interface PersistentAgentArchiveRequest {
	confirmation: string;
	reason?: string;
}

export interface PersistentAgentArchiveResponse {
	agentId: PersistentAgentId;
	archivedAt: number;
	status: "archived";
}

/** Real numbers for the danger zone and the archived-rooms list: conversations = threads, memories = Recent Context entries, files = the shelf, documents = shelf files the room itself produced. */
export interface PersistentAgentLifecycleCounts {
	conversations: number;
	memories: number;
	files: number;
	documents: number;
}

export interface ArchivedPersistentAgentSummary {
	id: PersistentAgentId;
	displayName?: string;
	archivedAt: number;
	archivedReason?: string;
	counts: PersistentAgentLifecycleCounts;
}

export interface PersistentAgentRestoreResponse {
	agentId: PersistentAgentId;
	restoredAt: number;
	status: "ready";
	/** Enabled schedule jobs that resume with the room — at their next natural time, never immediately. */
	enabledSchedules: number;
	/** One-shot jobs whose time passed while archived: disabled and marked missed, they need a new time. */
	missedOnceSchedules: number;
	/** Set when the schedule store could not be re-anchored — overdue jobs may still fire once. */
	scheduleNotice?: string;
}

/** Why a purge was refused with 409 — the wire contract for the danger flows' retry/decline logic. */
export type PersistentAgentPurgeBusyReason = "room_lock" | "turn_in_flight" | "detached_cooking" | "specialist_running";

export interface PersistentAgentPurgeResponse {
	agentId: PersistentAgentId;
	purgedAt: number;
	status: "purged";
	removedTaskFolders: number;
	removedBackgroundRuns: number;
	/** Targets the OS refused to remove after the room dir was gone; reasons are error codes, never paths. */
	failed: { target: string; reason: string }[];
}

export type ChatItem =
	// `ts` (epoch ms) is when the item was born; absent on items written before
	// the field existed, which then show no date/time on hover.
	| { kind: "user"; id: string; text: string; ts?: number; attachments?: { name: string; bytes: number; extension: string }[] }
	| { kind: "assistant"; id: string; text: string; ts?: number; streaming?: boolean }
	| {
			kind: "tool";
			id: string;
			name: string;
			args: any;
			/** "stopped" is a tool call that never finished because the turn was stopped: not a failure, and not a result. */
			status: "running" | "done" | "error" | "stopped";
			result?: string;
			/** Tool result `details` object, when the server sends one (e.g. fetch_url title/finalUrl). */
			details?: any;
	  }
	| {
			kind: "approval";
			id: string;            // chat item id
			requestId: string;     // server-side ui_request id
			uiKind: "confirm" | "select" | "input";
			title: string;
			message?: string;
			detail?: string;
			options?: string[];
			placeholder?: string;
			done?: string;         // set after user answers; we keep card visible
	  }
	| { kind: "system"; id: string; text: string; level?: "info" | "error" }
	| {
			// Consult MR-5 (§4.4): the permanent thread item left by a transfer.
			// `l1bFingerprint` is the `algorithm:value` string — machine provenance
			// that lives here and in the handoff block only; the UI never renders it.
			kind: "consult";
			id: string;
			targetRoomId: string;
			targetDisplayName: string;
			question: string;
			answer: string;
			l1bFingerprint: string;
			consultedAt: number;
			transferred: true;
			// Stacked consult (§8.4): the whole conversation, oldest-first, present
			// only for N≥2 transfers. The flat fields above mirror the LATEST exchange.
			// Legacy/N=1 items omit this and keep rendering from the flat fields.
			exchanges?: {
				question: string;
				answer: string;
				l1bFingerprint: string;
				consultedAt: number;
			}[];
	  }
	| {
			// Specialist MR "V6" (delegation contract spec §2.2): the permanent thread
			// item a specialist-task transfer leaves behind. `taskId` + `generatedAt`
			// are provenance kept here and in the handoff block (the durable record —
			// unlike the card face, the thread item may show the template id + date).
			// ONE representative thumbnail rides the item: the FIRST artifact's
			// write-time thumbnail (a `data:` URI) if the card had one; full
			// per-artifact thumbnails stay card-side.
			kind: "task";
			id: string;
			taskId: string;
			template: string;
			/**
			 * Registry template version, threaded from task_started for the §2.2
			 * block; optional because items persisted before the hardening pass
			 * predate the field (readers fall back to 1).
			 */
			templateVersion?: number;
			templateLabel: string;
			title: string;
			summary: string;
			artifacts: { relativePath: string; bytes: number; extension: string }[];
			thumbnailDataUri?: string;
			generatedAt: string;
			transferred: true;
	  };
