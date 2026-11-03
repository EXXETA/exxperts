import type { MemoryMapRow } from "./memory-shape.js";
import type { ABSORB_CONSOLIDATION_WORKER_TYPE, AbsorbModelLock, AbsorbAvailability, AbsorbAssessmentFields, AbsorbPromptTelemetry, ABSORB_DISCUSSION_WORKER_TYPE, AbsorbDiscussionMessage, AbsorbDiscussionPromptTelemetry, AbsorbDiscussionTokenBudget, AbsorbAssessmentHandoffInput } from "./absorb-consolidation.js";
import type { CHECKPOINT_COMPRESSION_WORKER_TYPE, CheckpointCompressionFields, CheckpointProposalPreview, CheckpointCompressionPromptTelemetry } from "./checkpoint-compression.js";
import type { FoldGuidanceWire } from "./absorb-ops.js";
import type { PatienceOptions } from "./model-call-causes.js";
import type { CheckpointDensity, CheckpointTranscriptSourceMetadata, L1bSourceFingerprintAlgorithm, PersistentAgentId, PersistentAgentMemoryBudget, PersistentAgentModelLock, PersistentAgentPiSessionJsonlThreadRuntime, PersistentAgentThreadRuntime, PersistentAgentThreadRuntimeKind, StableDurableL1bSection } from "./persistent-agent-types.js";

export interface CheckpointProposalResponse {
	agentId: PersistentAgentId;
	conversationId: string;
	sessionId: null;
	writesMemory: false;
	process: {
		type: typeof CHECKPOINT_COMPRESSION_WORKER_TYPE;
		parentConversationId: string;
		model: PersistentAgentModelLock;
	};
	density: CheckpointDensity;
	targetTokens: { min?: number; max: number };
	fields: CheckpointCompressionFields;
	preview: CheckpointProposalPreview;
	proposedRecentContext: string;
	estimatedTokens: number;
	compressionTelemetry: CheckpointCompressionPromptTelemetry;
	compressionUsage?: CheckpointCompressionGenerateResult["usage"];
	compressionAttempts: number;
	rememberRead: CheckpointRememberRead;
	source: CheckpointTranscriptSourceMetadata;
	warnings: string[];
}

export interface CheckpointModelWindow {
	contextWindow: number;
	maxOutputTokens: number;
}

export interface CheckpointProposalOptions {
	resolveModelWindow?: (model: PersistentAgentModelLock) => CheckpointModelWindow;
	/** How far the reading has come: `read` of `of` reads done (one for a single pass, the parts plus the end otherwise). */
	onProgress?: (progress: { read: number; of: number }) => void;
	/** Cancels the Remember: no further part is started, and the caller's worker calls take the same signal. */
	signal?: AbortSignal;
	/**
	 * The model that reads the conversation: the room's memory row, resolved by
	 * the caller (the HTTP route). A model named in the request body is used
	 * only when this is absent, by direct callers such as the smokes.
	 */
	model?: PersistentAgentModelLock;
	/**
	 * The shared patience every call gets (model-call-causes.ts): the line
	 * that shows each wait, the probe asked when a failure outlasts it, and,
	 * for the smokes, the clock and the sleep.
	 */
	patience?: Omit<PatienceOptions, "model" | "signal">;
}

/** How Remember read the conversation, for the approval screen. */
export interface CheckpointRememberRead {
	mode: "one-pass" | "parts";
	/** 1 for a single pass; the parts plus the verbatim end otherwise. */
	reads: number;
	/** The model that read the conversation. */
	model: PersistentAgentModelLock;
	/** Tool outputs longer than `toolOutputCapChars`, shortened before reading. */
	trimmedToolOutputs: number;
	toolOutputCapChars: number;
	/** On the multi-part path: must-keep items in the part notes against must-keep markers in BODY (a floor, never a proof). */
	mustKeep?: { partNotes: number; body: number };
	/** Every part was refused and the page holds only the date (decision 40): the save says so, once. */
	refusedWhole?: true;
}

export interface CheckpointApprovalProposalReference {
	agentId?: string;
	conversationId?: string;
	sessionId?: string | null;
	writesMemory?: boolean;
	density?: string;
	process?: {
		model?: PersistentAgentModelLock;
	};
	source?: CheckpointTranscriptSourceMetadata;
	proposedRecentContext?: string;
}

export interface CheckpointApprovalRequest {
	conversationId: string;
	model: PersistentAgentModelLock;
	density: CheckpointDensity;
	proposal: CheckpointApprovalProposalReference;
	approvedRecentContext: string;
}

export interface CheckpointApprovalAcceptedRequest extends CheckpointApprovalRequest {
	agentId: PersistentAgentId;
}

export interface PersistentAgentCheckpointRuntimeBoundary {
	closedThreadId: string;
	closedReason: "checkpoint";
	closedAt: number;
	closedByCheckpointId: string;
	oldRuntime: PersistentAgentThreadRuntime;
	newThreadId: string;
	newRuntime: PersistentAgentPiSessionJsonlThreadRuntime;
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
	eventRecordPath: string;
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

export interface CheckpointApprovalResponse {
	agentId: PersistentAgentId;
	conversationId: string;
	sessionId: string;
	checkpointId: string;
	writesMemory: true;
	archivedL1bPath: string;
	updatedL1bPath: string;
	eventRecordPath: string;
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
	/** The save had already landed (another window, or a Save after a crash): no window switches over again. */
	alreadySaved?: true;
}

export interface CheckpointCompressionGenerateResult {
	text: string;
	usage?: {
		input?: number;
		output?: number;
		cacheRead?: number;
		cacheWrite?: number;
		totalTokens?: number;
		cost?: number;
	};
	/** True when the provider cut the response at its output-token ceiling. */
	truncated?: boolean;
	/** The worker model's declared output-token ceiling, when known. */
	modelMaxOutputTokens?: number;
}

export interface AbsorbGenerateResult {
	text: string;
	usage?: {
		input?: number;
		output?: number;
		cacheRead?: number;
		cacheWrite?: number;
		totalTokens?: number;
		cost?: number;
	};
	/** True when the provider cut the response at its output-token ceiling. */
	truncated?: boolean;
	/** The worker model's declared output-token ceiling, when known. */
	modelMaxOutputTokens?: number;
}

export interface AbsorbAssessmentResponse {
	agentId: PersistentAgentId;
	writesMemory: false;
	process: {
		type: typeof ABSORB_CONSOLIDATION_WORKER_TYPE;
		model: AbsorbModelLock;
	};
	availability: AbsorbAvailability;
	source: AbsorbProposalSourceMetadata;
	assessmentMarkdown: string;
	fields: AbsorbAssessmentFields;
	absorbTelemetry: AbsorbPromptTelemetry;
	absorbUsage?: AbsorbGenerateResult["usage"];
	warnings: string[];
	/** Set when there is no first read, with the reason; the assessment is then "None.". */
	firstReadMissing?: AbsorbFirstReadMissing;
	/** With a missing first read: the conversations waiting, read from their Recent Context headings, so the screen still says what Memorize will read. */
	waitingConversations?: Array<{ title: string; date?: string }>;
}

export interface AbsorbDiscussionSourceMetadata {
	l1bFingerprint: L1bSourceFingerprint;
	checkedAt: string;
}

export interface AbsorbDiscussionTurnResponse {
	agentId: PersistentAgentId;
	writesMemory: false;
	process: {
		type: typeof ABSORB_DISCUSSION_WORKER_TYPE;
		model: AbsorbModelLock;
	};
	availability: AbsorbAvailability;
	source: AbsorbDiscussionSourceMetadata;
	message: AbsorbDiscussionMessage;
	absorbDiscussionTelemetry: AbsorbDiscussionPromptTelemetry;
	absorbDiscussionUsage?: AbsorbGenerateResult["usage"];
	tokenBudget: AbsorbDiscussionTokenBudget;
	warnings: string[];
}

export interface AbsorbDiscussionSignoffResponse {
	agentId: PersistentAgentId;
	writesMemory: false;
	process: {
		type: typeof ABSORB_DISCUSSION_WORKER_TYPE;
		model: AbsorbModelLock;
	};
	availability: AbsorbAvailability;
	source: AbsorbDiscussionSourceMetadata;
	assessmentHandoff: AbsorbAssessmentHandoffInput & { source: "discussion_signoff" };
	/** Memory v2: the same sign-off as the fields every fold call honours. */
	guidance: FoldGuidanceWire;
	absorbDiscussionTelemetry: AbsorbDiscussionPromptTelemetry;
	absorbDiscussionUsage?: AbsorbGenerateResult["usage"];
	tokenBudget: AbsorbDiscussionTokenBudget;
	warnings: string[];
}

export interface L1bSourceFingerprint {
	algorithm: L1bSourceFingerprintAlgorithm;
	value: string;
}

export interface AbsorbProposalSourceMetadata {
	l1bFingerprint: L1bSourceFingerprint;
	generatedAt: string;
}

/**
 * The shape of the save the Review that came before the run wrote. Nothing
 * writes one any more; the type stays so a room that ran that Review can still
 * read its own history and take those saves back.
 */
export interface StructuralReviewSourceMetadata {
	l1bFingerprint: L1bSourceFingerprint;
	reviewTargetFingerprint: L1bSourceFingerprint;
	chronosFingerprint: L1bSourceFingerprint;
	recentContextFingerprint: L1bSourceFingerprint;
	generatedAt: string;
}

export interface StructuralReviewReviewMetrics {
	reviewTargetWordsBefore: number;
	reviewTargetWordsAfter: number;
	reviewTargetEstimatedTokensBefore: number;
	reviewTargetEstimatedTokensAfter: number;
	reviewTargetEstimatedTokenDelta: number;
	sourceMemoryMap: MemoryMapRow[];
	candidateMemoryMap: MemoryMapRow[];
}

export interface AbsorbApprovalResponse {
	agentId: PersistentAgentId;
	writesMemory: true;
	absorbId: string;
	archivedL1bPath: string;
	updatedL1bPath: string;
	eventRecordPath: string;
	eventRelPath?: string;
	recentContextEntryCount: number;
	// After-write budget state (same shape and predicate as status.memoryBudget):
	// the saved screen tells the user when this Memorize took the room over its
	// budget, instead of leaving that for the next launcher visit.
	memoryBudget: PersistentAgentMemoryBudget;
	postAbsorb: {
		returnToLauncher: true;
	};
	warnings: string[];
}

export interface L1bEventSectionMetric {
	title: string;
	bytes: number;
	estimatedTokens: number;
	fingerprint: L1bSourceFingerprint;
}

export interface L1bEventSectionMetrics {
	topLevel: L1bEventSectionMetric[];
	recentContext: L1bEventSectionMetric & { entryCount: number };
	nonRecentContext: L1bEventSectionMetric;
}

export interface L1bEventStateMetrics {
	l1bFingerprint: L1bSourceFingerprint;
	recentContextEntryCount: number;
	estimatedTokens: number;
	bytes: number;
	sections: L1bEventSectionMetrics;
}

export interface L1bMutationSectionDelta {
	sectionsAffected: string[];
	sectionsPreserved: string[];
}

export interface L1bMutationEventPaths {
	archivedL1bRelPath: string;
	updatedL1bRelPath: string;
	eventRelPath: string;
}

export interface StableMemoryEventMetrics {
	sectionTitles: StableDurableL1bSection[];
	bytes: number;
	estimatedTokens: number;
	fingerprint: L1bSourceFingerprint;
}

export interface SanitizedUsageMetrics {
	input?: number;
	output?: number;
	cacheRead?: number;
	cacheWrite?: number;
	totalTokens?: number;
	cost?: number;
}

export type SanitizedNumericHashTelemetryValue = number | L1bSourceFingerprint | SanitizedNumericHashTelemetryValue[] | { [key: string]: SanitizedNumericHashTelemetryValue };

export type SanitizedNumericHashTelemetry = Record<string, SanitizedNumericHashTelemetryValue>;

export interface CheckpointEventRecord {
	schemaVersion: 1;
	operation: "checkpoint";
	mutation: {
		target: "l1b";
		kind: "recent_context_append";
		sectionsAffected: string[];
		sectionsPreserved: string[];
	};
	agentId: PersistentAgentId;
	conversationId: string;
	sessionId: string;
	checkpointId: string;
	recentContextId: string;
	approvedAt: string;
	paths: {
		archivedL1bRelPath: string;
		updatedL1bRelPath: string;
		eventRelPath: string;
	};
	process: {
		type: typeof CHECKPOINT_COMPRESSION_WORKER_TYPE;
		density: CheckpointDensity;
		model: PersistentAgentModelLock;
	};
	source: L1bEventStateMetrics;
	result: L1bEventStateMetrics;
	runtimeBoundary?: {
		closedThreadId: string;
		closedReason: "checkpoint";
		closedAt: number;
		closedByCheckpointId: string;
		oldRuntimeKind: PersistentAgentThreadRuntimeKind;
		oldRuntimeSessionId?: string;
		oldSessionFileRelPath?: string;
		oldBootPromptSha256?: string;
		newThreadId: string;
		newRuntimeKind: "pi-session-jsonl";
		newRuntimeSessionId: string;
		newSessionFileRelPath: string;
		newBootPromptSnapshotRelPath: string;
		newBootPromptSha256: string;
		newRuntimeL1bFingerprint: L1bSourceFingerprint;
	};
	checkpoint: {
		recentContextEntryCountBefore: number;
		recentContextEntryCountAfter: number;
		approvedEntry: {
			chars: number;
			bytes: number;
			estimatedTokens: number;
			hash: L1bSourceFingerprint;
			status: "OPEN" | "CLOSED" | "unknown";
			title?: string;
		};
		proposedEntry?: {
			chars: number;
			bytes: number;
			estimatedTokens: number;
			hash: L1bSourceFingerprint;
		};
	};
	validation: {
		valid: true;
		warnings: string[];
		errors: string[];
	};
	warnings: string[];
}

export interface MementoEventRecord {
	schemaVersion: 1;
	operation: "memento";
	mutation: {
		target: "none";
		kind: "runtime_boundary_only";
	};
	agentId: PersistentAgentId;
	conversationId: string;
	mementoId: string;
	appliedAt: string;
	paths: {
		eventRelPath: string;
	};
	runtimeBoundary: {
		closedThreadId: string;
		closedReason: "memento";
		closedAt: number;
		closedByMementoId: string;
		oldRuntimeKind: PersistentAgentThreadRuntimeKind;
		oldRuntimeSessionId?: string;
		oldSessionFileRelPath?: string;
		oldBootPromptSha256?: string;
		newThreadId: string;
		newRuntimeKind: "pi-session-jsonl";
		newRuntimeSessionId: string;
		newSessionFileRelPath: string;
		newBootPromptSnapshotRelPath: string;
		newBootPromptSha256: string;
		newRuntimeL1bFingerprint: L1bSourceFingerprint;
	};
	memory: {
		l1bMutated: false;
		l1bFingerprint: L1bSourceFingerprint;
	};
	warnings: string[];
}

export interface AbsorbEventRecord {
	schemaVersion: 1;
	operation: "absorb";
	mode: "rc_consolidation";
	mutation?: {
		target: "l1b";
		kind: "recent_context_consolidation";
		sectionsAffected: string[];
		sectionsPreserved: string[];
	};
	paths: L1bMutationEventPaths;
	process?: {
		type: typeof ABSORB_CONSOLIDATION_WORKER_TYPE;
		mode: "rc_consolidation";
		model: PersistentAgentModelLock;
		source: "proposal_time";
	};
	proposal?: {
		generatedAt?: string;
		sourceL1bFingerprint?: L1bSourceFingerprint;
		telemetry?: SanitizedNumericHashTelemetry;
		usage?: SanitizedUsageMetrics;
	};
	agentId: PersistentAgentId;
	absorbId: string;
	approvedAt: string;
	/** @deprecated Use paths.archivedL1bRelPath. Present only on older event records. */
	archivedL1bPath?: string;
	/** @deprecated Use paths.updatedL1bRelPath. Present only on older event records. */
	updatedL1bPath?: string;
	source: L1bEventStateMetrics;
	result: L1bEventStateMetrics;
	absorb?: {
		recentContextEntryCountBefore: number;
		recentContextEntryCountAfter: number;
		recentContextBytesBefore: number;
		recentContextBytesAfter: number;
		stableMemoryBytesBefore: number;
		stableMemoryBytesAfter: number;
		stableMemoryDeltaBytes: number;
		stableMemoryEstimatedTokensBefore: number;
		stableMemoryEstimatedTokensAfter: number;
		stableMemoryEstimatedTokenDelta: number;
	};
	/**
	 * Memorize v2: what the run actually did, session by session. The shapes are
	 * declared structurally here (absorb-run.ts owns their canonical names) so
	 * the event record stays a plain document with no import of its own.
	 */
	run?: {
		runId: string;
		sessions: Array<{
			id: string;
			outcome: string;
			attempts: number;
			reason?: string;
			summary?: { added: number; updated: number; superseded: number; closed: number };
			/** The conversation the Recent Context entry was made from; absent on an entry written by hand and on records older than the field. */
			conversationId?: string;
			/** The Remember (checkpoint event) that wrote the entry; absent on an entry written by hand and on records older than the field. */
			checkpointId?: string;
		}>;
		foldedSessions: string[];
		remainingSessions: string[];
		/** `reason` is the ranking's own words for a row the budget took, or which value replaced which for a superseded text whose old and new words disagree on a value; a reworded text or a closed item carries none. */
		archived: Array<{ id: string; why: string; topic: string; section: string; reason?: string }>;
		/** `raisedFrom` is present only when this save raised the room's limit: the limit before the raise, so an undo can put it back. */
		budget: { before: number; after: number; budgetTokens: number; overBudgetAfter: boolean; raisedFrom?: number };
		/**
		 * Present when this write also gave the room's memory its entry ids for the
		 * first time. The run carried the migration in memory and wrote nothing
		 * until here, so the snapshot beside this record is the pre-migration file
		 * and this is the row a rollback would be read from.
		 */
		migration?: { entriesAssigned: number };
		/** The new notes the person chose to put in place of the note they stood beside: `applied` is false when the save kept both, because that note had changed or gone. */
		besideChoices?: Array<{ id: string; other: string; choice: "replace"; applied: boolean }>;
	};
	validation: {
		valid: true;
		warnings: string[];
		errors: string[];
	};
	warnings: string[];
}

/**
 * Review v2's approved write, recorded. It carries the three things the undo
 * needs — when it was approved, the room-relative path of the file it replaced,
 * and the fingerprint of the file it wrote — plus every archive row it appended
 * by id, so taking the save back takes back exactly its own rows and nothing
 * else. The run block is what the room's history reads to say what a review
 * did.
 */
export interface ReviewEventRecord {
	schemaVersion: 1;
	operation: "review";
	mode: "note_review";
	mutation?: {
		target: "l1b";
		kind: "note_review";
		sectionsAffected: string[];
		sectionsPreserved: string[];
	};
	paths: L1bMutationEventPaths;
	process?: {
		type: "review-tidy-worker";
		mode: "note_review";
		model: PersistentAgentModelLock;
		source: "proposal_time";
	};
	proposal?: {
		sourceL1bFingerprint?: L1bSourceFingerprint;
		usage?: SanitizedUsageMetrics;
	};
	agentId: PersistentAgentId;
	reviewId: string;
	approvedAt: string;
	source: L1bEventStateMetrics;
	result: L1bEventStateMetrics;
	review: {
		reviewTargetEstimatedTokensBefore: number;
		reviewTargetEstimatedTokensAfter: number;
		reviewTargetEstimatedTokenDelta: number;
		topicsTidied: number;
		notesChanged: number;
	};
	/**
	 * What the run actually did, group by group. The shapes are declared
	 * structurally here (review-run.ts owns their canonical names) so the event
	 * record stays a plain document with no import of its own.
	 */
	run?: {
		runId: string;
		depth: string;
		topics: string[];
		/** `reason` and `conflictWith` are set on a merged row that resolved a pair of notes the machine found disagreeing: why the newer value stands, and the member that left. */
		changes: Array<{ id: string; kind: string; topic: string; section: string; why?: string; mergedFrom?: string[]; reason?: string; conflictWith?: { id: string; topic: string } }>;
		leftAsIs: Array<{ topics: string[]; reason: string }>;
		/** `reason` is the ranking's own words for a row the budget took, or the merged row's own for the member of a disagreeing pair that left; every other row the tidy set aside carries none. */
		archived: Array<{ id: string; why: string; topic: string; section: string; reason?: string }>;
		/** `raisedFrom` is present only when this save raised the room's limit: the limit before the raise, so an undo can put it back. */
		budget: { before: number; after: number; budgetTokens: number; overBudgetAfter: boolean; raisedFrom?: number };
		migration?: { entriesAssigned: number };
	};
	validation: {
		valid: true;
		warnings: string[];
		errors: string[];
	};
	warnings: string[];
}

/** A save the old whole-rewrite Review wrote: read only, never written again. */
export interface StructuralReviewEventRecord {
	schemaVersion: 1;
	operation: "structural_review";
	mode: "stc_diagnostic";
	mutation?: {
		target: "l1b";
		kind: "stable_memory_restructure_prune";
		sectionsAffected: string[];
		sectionsPreserved: string[];
	};
	paths: L1bMutationEventPaths;
	process?: {
		type: "structural-review-worker";
		mode: "stc_diagnostic";
		model: PersistentAgentModelLock;
		source: "proposal_time";
	};
	proposal?: {
		generatedAt?: string;
		sourceL1bFingerprint?: L1bSourceFingerprint;
		reviewTargetFingerprint?: L1bSourceFingerprint;
		telemetry?: SanitizedNumericHashTelemetry;
		usage?: SanitizedUsageMetrics;
	};
	agentId: PersistentAgentId;
	structuralReviewId: string;
	approvedAt: string;
	/** @deprecated Use paths.archivedL1bRelPath. Present only on older event records. */
	archivedL1bPath?: string;
	/** @deprecated Use paths.updatedL1bRelPath. Present only on older event records. */
	updatedL1bPath?: string;
	source: L1bEventStateMetrics & StructuralReviewSourceMetadata;
	result: L1bEventStateMetrics & {
		reviewTargetFingerprint: L1bSourceFingerprint;
		chronosFingerprint: L1bSourceFingerprint;
		recentContextFingerprint: L1bSourceFingerprint;
	};
	metrics: StructuralReviewReviewMetrics;
	structuralReview?: {
		reviewTargetWordsBefore: number;
		reviewTargetWordsAfter: number;
		reviewTargetEstimatedTokensBefore: number;
		reviewTargetEstimatedTokensAfter: number;
		reviewTargetEstimatedTokenDelta: number;
		stableMemoryBytesBefore: number;
		stableMemoryBytesAfter: number;
		stableMemoryDeltaBytes: number;
		chronosPreserved: boolean;
		recentContextPreserved: boolean;
		recentContextEntryCountBefore: number;
		recentContextEntryCountAfter: number;
	};
	/**
	 * The after-write budget verdict through the ONE numerator — the number the
	 * approval card and saved screen showed. The previous-partial escalation
	 * reads THIS, never the metrics-family estimates above (they can differ by
	 * a token). Absent on records written before slice 4.
	 */
	memoryBudget?: PersistentAgentMemoryBudget;
	/** The applied draft's Dropped material disclosure, as approved. Absent on records written before slice 7 and when the draft omitted the section. */
	droppedMaterial?: string;
	/** Present when the user chose forget-to-document at approval: the shelf file the dropped material was saved to. */
	forgetToDocument?: { shelfFileName: string };
	validation: {
		valid: true;
		warnings: string[];
		errors: string[];
	};
	warnings: string[];
}

/** Why a Memorize has no first read: its call failed, the reply was cut or too long, or the prompt could not fit the window. */
export type AbsorbFirstReadMissing = "failed" | "cut-off" | "too-long" | "too-large";
