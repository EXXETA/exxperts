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
	markdownWriteEnabled?: boolean;
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

export type PersistentRoomWorkspaceMode = "read-only" | "read" | "write";

export interface PersistentRoomWorkspaceDefaultInput {
	root?: string;
	displayLabel?: string;
	workspaceAccessMode?: PersistentRoomWorkspaceAccessMode;
	mode?: PersistentRoomWorkspaceMode;
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
	absorbDiscussionTelemetry: AbsorbDiscussionPromptTelemetry;
	absorbDiscussionUsage?: AbsorbUsage;
	tokenBudget: AbsorbDiscussionTokenBudget;
	warnings: string[];
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
	absorbTelemetry: AbsorbPromptTelemetry;
	absorbUsage?: AbsorbUsage;
	warnings: string[];
}

export interface AbsorbApprovalResponse {
	agentId: PersistentAgentId;
	writesMemory: true;
	absorbId: string;
	eventRelPath: string;
	recentContextEntryCount: number;
	postAbsorb: {
		returnToLauncher: true;
	};
	warnings: string[];
}

export type StructuralReviewAvailabilityReason = "available" | "not_ready" | "invalid_topology" | "error";

export interface StructuralReviewMemoryMapRow {
	area: string;
	words: number;
	estimatedTokens: number;
}

export interface StructuralReviewAvailability {
	available: boolean;
	reason: StructuralReviewAvailabilityReason;
	message: string;
	reviewTargetEstimatedTokens: number;
	reviewTargetWords: number;
	memoryMap: StructuralReviewMemoryMapRow[];
	model?: MaintenanceWorkerModelStatus | null;
	profile?: MaintenanceWorkerProfileStatus;
	writesMemory?: false;
	error?: string;
}

export interface StructuralReviewSourceMetadata {
	l1bFingerprint: L1bSourceFingerprint;
	reviewTargetFingerprint: L1bSourceFingerprint;
	chronosFingerprint: L1bSourceFingerprint;
	recentContextFingerprint: L1bSourceFingerprint;
	generatedAt: string;
}

export interface StructuralReviewAssessmentFields {
	looksHealthy: string[];
	staleOrDriftProne: string[];
	couldBeDenser: string[];
	structureOpportunities: string[];
	proposedDirection: string;
}

export interface StructuralReviewPromptTelemetry {
	chars: number;
	bytes: number;
	words: number;
	estimatedTokens: number;
	memoryMap: StructuralReviewMemoryMapRow[];
	promptChars: number;
	promptEstimatedTokens: number;
	sectionDescriptionCount: number;
}

export type StructuralReviewDiscussionRole = "user" | "assistant";

export interface StructuralReviewDiscussionMessage {
	role: StructuralReviewDiscussionRole;
	content: string;
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

export interface StructuralReviewAssessmentHandoff {
	source: "direct_assessment" | "discussion_signoff";
	text: string;
}

export interface StructuralReviewAssessmentResponse {
	agentId: PersistentAgentId;
	writesMemory: false;
	process: {
		type: "structural-review-worker";
		mode: "stc_diagnostic";
		model: { provider: string; model: string; label?: string };
	};
	availability: StructuralReviewAvailability;
	source: StructuralReviewSourceMetadata;
	assessmentMarkdown: string;
	fields: StructuralReviewAssessmentFields;
	structuralReviewTelemetry: StructuralReviewPromptTelemetry;
	structuralReviewUsage?: AbsorbUsage;
	warnings: string[];
}

export interface StructuralReviewDiscussionTurnResponse {
	agentId: PersistentAgentId;
	writesMemory: false;
	process: {
		type: "structural-review-discussion-worker";
		mode: "stc_diagnostic";
		model: { provider: string; model: string; label?: string };
	};
	availability: StructuralReviewAvailability;
	source: StructuralReviewSourceMetadata & { checkedAt: string };
	message: StructuralReviewDiscussionMessage;
	structuralReviewDiscussionTelemetry: StructuralReviewDiscussionPromptTelemetry;
	structuralReviewDiscussionUsage?: AbsorbUsage;
	tokenBudget: StructuralReviewDiscussionTokenBudget;
	warnings: string[];
}

export interface StructuralReviewDiscussionSignoffResponse {
	agentId: PersistentAgentId;
	writesMemory: false;
	process: {
		type: "structural-review-discussion-worker";
		mode: "stc_diagnostic";
		model: { provider: string; model: string; label?: string };
	};
	availability: StructuralReviewAvailability;
	source: StructuralReviewSourceMetadata & { checkedAt: string };
	assessmentHandoff: StructuralReviewAssessmentHandoff & { source: "discussion_signoff" };
	structuralReviewDiscussionTelemetry: StructuralReviewDiscussionPromptTelemetry;
	structuralReviewDiscussionUsage?: AbsorbUsage;
	tokenBudget: StructuralReviewDiscussionTokenBudget;
	warnings: string[];
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

export interface StructuralReviewReviewMetrics {
	reviewTargetWordsBefore: number;
	reviewTargetWordsAfter: number;
	reviewTargetEstimatedTokensBefore: number;
	reviewTargetEstimatedTokensAfter: number;
	reviewTargetEstimatedTokenDelta: number;
	sourceMemoryMap: StructuralReviewMemoryMapRow[];
	candidateMemoryMap: StructuralReviewMemoryMapRow[];
}

export interface StructuralReviewProposalReview {
	summary: string;
	metrics: StructuralReviewReviewMetrics;
}

export interface StructuralReviewProposalResponse {
	agentId: PersistentAgentId;
	writesMemory: false;
	process: {
		type: "structural-review-worker";
		mode: "stc_diagnostic";
		model: { provider: string; model: string; label?: string };
	};
	availability: StructuralReviewAvailability;
	source: StructuralReviewSourceMetadata;
	fields: StructuralReviewProposalFields;
	review: StructuralReviewProposalReview;
	candidateValidation: StructuralReviewCandidateValidationResult;
	structuralReviewTelemetry: StructuralReviewPromptTelemetry;
	structuralReviewUsage?: AbsorbUsage;
	warnings: string[];
}

export interface StructuralReviewApprovalResponse {
	agentId: PersistentAgentId;
	writesMemory: true;
	structuralReviewId: string;
	eventRelPath: string;
	postStructuralReview: {
		returnToLauncher: true;
	};
	warnings: string[];
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
	/** Set when this room is currently open or busy in another surface (CLI, browser, or scheduled background work). */
	activeLock?: { surface: "cli" | "web" | "scheduler" | string; acquiredAt: number } | null;
	displayName?: string;
	description?: string;
	role?: string;
	model?: { provider: string; model: string } | string;
	l1a: { path: string; exists: boolean; bytes?: number };
	l1b: { path: string; exists: boolean; bytes?: number; sections: string[]; missingSections: string[] };
	sectionRegistry: { path: string; exists: boolean; missingSections: string[] };
	recentContext: { fullEntries: number; softCap: number; hardCap: number };
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

export type ChatItem =
	| { kind: "user"; id: string; text: string }
	| { kind: "assistant"; id: string; text: string; streaming?: boolean }
	| {
			kind: "tool";
			id: string;
			name: string;
			args: any;
			status: "running" | "done" | "error";
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
