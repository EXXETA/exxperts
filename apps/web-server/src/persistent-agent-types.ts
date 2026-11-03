import crypto from "node:crypto";
import type { PersistentRoomScheduleSummary } from "../../../pi-package/extensions/schedule-prompt/index.js";
import type { L1bSourceFingerprint } from "./persistent-agent-memory-types.js";
import type { PersistentAgentInstance } from "./persistent-agent-store.js";

const REQUIRED_L1B_SECTIONS = ["Chronos", "Deep Memory", "Active Items", "Recent Context"] as const;

const STABLE_DURABLE_L1B_SECTIONS = ["Deep Memory", "Active Items"] as const;

export type PersistentAgentId = string;

export type PersistentAgentStatusValue = "missing" | "ready" | "needs_absorb" | "error";

export type PersistentAgentRuntimeStateValue = "idle" | "active" | "standby";

export type PersistentAgentThreadStateValue = "active" | "standby" | "closed";

export type PersistentAgentThreadOrigin = "launcher" | "home" | "sidequest" | "checkpoint" | "memento" | "unknown";

export type PersistentAgentThreadClosedReason = "checkpoint" | "memento";

export type PersistentAgentRuntimeBoundaryReason = "checkpoint" | "memento";

export type PersistentAgentThreadRuntimeKind = "transcript-recap-v1" | "pi-session-jsonl";

export type PersistentAgentActiveTurnStateValue = "idle" | "running" | "cancelling";

export type PersistentAgentActiveTurnTerminalReason = "completed" | "cancelled" | "failed" | "disconnect_cancelled";

export type L1bSourceFingerprintAlgorithm = "sha256";

export type PersistentAgentPromptLayerId = "l0" | "l1a" | "instructions" | "l1b" | "l2";

export type PersistentAgentPromptBudgetState = "healthy" | "warning" | "pressure" | "hard";

export type PersistentAgentMemoryStatusLevel = "empty" | "ok" | "approaching_soft_cap" | "at_soft_cap" | "hard_cap";

export type CheckpointDensity = "compact" | "standard" | "rich";

export type StableDurableL1bSection = typeof STABLE_DURABLE_L1B_SECTIONS[number];

export function fingerprintL1bSource(l1b: string): L1bSourceFingerprint {
	return {
		algorithm: "sha256",
		value: crypto.createHash("sha256").update(l1b, "utf-8").digest("hex"),
	};
}

export interface PersistentAgentModelLock {
	provider: string;
	model: string;
	label?: string;
}

export interface CheckpointTranscriptItem {
	kind: string;
	id?: string;
	text?: string;
	name?: string;
	status?: string;
}

export type CheckpointTranscriptRuntimeKind = PersistentAgentThreadRuntimeKind;

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

export interface CheckpointTranscriptSourceResult {
	items: CheckpointTranscriptItem[];
	source: CheckpointTranscriptSourceMetadata;
}

export interface PersistentAgentWorkspaceCapabilitySummary {
	workspaceAccessMode?: "bounded" | "localFiles";
	workspaceLabel: string;
	rootCount: number;
	pathAccess?: "workspace-only" | "local-files";
	availableToolNames: string[];
	writeEnabled: boolean;
	bashEnabled: boolean;
	nativePiFilesystemToolsEnabled?: boolean;
}

export interface PersistentAgentBootContract {
	/** Durable persistent-agent object id. */
	agentId: PersistentAgentId;
	/** Local browser transcript id before an approval checkpoint creates a formal session id. */
	conversationId: string;
	/** No formal session id exists in this boot-only slice. */
	sessionId: null;
	/** Selected on entry and locked for this run; does not mutate global web-chat defaults. */
	model: PersistentAgentModelLock;
	/** Redacted current-room workspace capability summary; omitted when no workspace tools are active. */
	workspaceCapability?: PersistentAgentWorkspaceCapabilitySummary;
	/** Pre-rendered enabled-skills index section for the L2 envelope (skills MR-5,
	 *  spec §5), or ""/omitted when the room has no effective enabled skills.
	 *  Computed by the caller from the room's skill settings — this module stays
	 *  library-agnostic. */
	enabledSkillsIndex?: string;
}

export interface PersistentAgentPromptLayer {
	id: PersistentAgentPromptLayerId;
	title: string;
	content: string;
	estimatedTokens: number;
}

export interface PersistentAgentPromptBudget {
	l0EstimatedTokens: number;
	l1aEstimatedTokens: number;
	l1bEstimatedTokens: number;
	l2EstimatedTokens: number;
	bootEstimatedTokens: number;
	state: PersistentAgentPromptBudgetState;
	thresholds: {
		warning: number;
		pressure: number;
		hard: number;
	};
}

export interface PersistentAgentRuntimeState {
	schemaVersion: 1;
	agentId: PersistentAgentId;
	state: PersistentAgentRuntimeStateValue;
	activeThreadId: string | null;
	model: PersistentAgentModelLock | null;
	updatedAt: number;
}

export interface PersistentAgentTranscriptRecapThreadRuntime {
	kind: "transcript-recap-v1";
}

export interface PersistentAgentPiSessionJsonlThreadRuntime {
	kind: "pi-session-jsonl";
	sessionId: string;
	sessionFileRelPath: string;
	bootPromptSnapshotRelPath: string;
	bootPromptSha256: string;
	l1bFingerprint: L1bSourceFingerprint;
	/**
	 * The fingerprint of the instructions layer this thread booted with
	 * (sha256 hex), null when it booted without one. Metadata, not prose: the
	 * per-turn "Current instructions" section compares the file against THIS,
	 * so nothing written into the memory or the instructions can imitate a
	 * boot marker. Absent on records created before the field existed; those
	 * fall back to reading the marker out of the frozen prompt.
	 */
	instructionsFingerprint?: string | null;
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
	model: PersistentAgentModelLock;
	/** The models this conversation ran on before a switch, oldest first, each with when it stopped. */
	modelHistory?: PersistentAgentThreadModelHistoryEntry[];
	/** Its model was picked for it (a switch, or Remember continuing on a model): while empty, it no longer follows the room's pick. */
	modelChosen?: true;
	runtime: PersistentAgentThreadRuntime;
	/**
	 * Frontend display cache. For `runtime.kind === "transcript-recap-v1"` only,
	 * this also remains the legacy bounded recap input. It is not future canonical
	 * runtime continuity truth.
	 */
	items: unknown[];
	/**
	 * Consult MR-5 pending-transfer queue (§2.3): handoff blocks that will ride
	 * the user's next prompt. Never a memory-write path — the block enters the
	 * session JSONL like any user text and is compressible only by a checkpoint.
	 * Omitted when empty.
	 */
	pendingHandoffs?: string[];
	/**
	 * The ids of items an edit of the last message replaced (the message and
	 * its answer). Every write of the conversation leaves them out, so a save
	 * built before the edit that arrives after it never brings them back.
	 * Omitted when empty.
	 */
	editedAway?: string[];
	createdAt: number;
	updatedAt: number;
}

export interface PersistentAgentThreadWriteInput {
	state: PersistentAgentThreadStateValue;
	origin?: PersistentAgentThreadOrigin;
	model?: PersistentAgentModelLock | null;
	/** Set on a new conversation whose model was picked for it; an existing one keeps its own mark. */
	modelChosen?: true;
	items?: unknown[];
	/**
	 * Consult MR-5 pending-transfer queue (§2.3). Preserve-if-absent: when
	 * undefined the stored queue is kept; when provided (incl. []) it replaces
	 * the stored queue. Validated (array of ≤20 strings, each within the block
	 * cap) — junk is rejected, not stored.
	 */
	pendingHandoffs?: string[];
}

export interface PersistentAgentThreadRuntimeCreateContext {
	instance: PersistentAgentInstance;
	threadId: string;
	model: PersistentAgentModelLock;
	now: number;
}

export interface PersistentAgentThreadWriteOptions {
	createRuntime?: (context: PersistentAgentThreadRuntimeCreateContext) => PersistentAgentThreadRuntime;
	/**
	 * Skip the active-AI-profile model approval gate. ONLY for
	 * runtime-boundary-only writes that never invoke a model (Memento): the
	 * fresh thread inherits the old thread's immutable model lock, which may
	 * belong to a profile that is no longer active. Prompting, checkpoints,
	 * scheduled runs and room entry keep full enforcement.
	 */
	allowInactiveProfileModel?: boolean;
	/**
	 * A standby write that parks a conversation which is no longer the room's
	 * current one leaves the runtime pointer alone: the thread file is written,
	 * the pointer stays on the newer conversation. Set by the server-side
	 * landing of a finished turn and by a standby save from the client, both
	 * of which can land after the person moved on to another conversation.
	 * An idle room still takes the pointer (the landing makes it resumable),
	 * and a write to the current conversation behaves as always.
	 */
	keepRuntimeIfMoved?: boolean;
}

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
	/** Still empty, so its first message runs on the room's conversation pick (emptyPersistentAgentThreadModelTarget's rule). */
	followsConversationPick: boolean;
	activeTurn: PersistentAgentActiveTurnState;
	inFlight: boolean;
	working: boolean;
	cancelling: boolean;
}

export type PersistentRoomBackgroundRunClassification =
	| { status: "queued"; reason: "resume_thread"; target: { kind: "resume-thread"; roomId: string; threadId: string; model?: PersistentAgentModelLock }; warnings: string[] }
	| { status: "queued"; reason: "fresh_thread"; target: { kind: "fresh-thread"; roomId: string; modelPolicyKey: "scheduledRoom" }; warnings: string[] }
	| { status: "deferred"; reason: "room_in_use" | "active_turn_in_flight"; target?: { kind: "none"; roomId: string }; message: string; warnings: string[] }
	| { status: "blocked"; reason: "prepared_runtime_boundary" | "room_missing" | "room_archived" | "room_error"; target?: { kind: "none"; roomId: string; threadId?: string }; message: string; warnings: string[] };

export interface PersistentAgentStatus {
	id: string;
	exists: boolean;
	status: PersistentAgentStatusValue;
	root: string;
	runtime: PersistentAgentRuntimeState;
	activeThread: PersistentAgentActiveThreadSummary | null;
	/** A detached turn landed while nobody was connected; cleared when a session next binds to the room. */
	unseenLandedAnswer?: PersistentAgentUnseenLandedAnswer;
	displayName?: string;
	description?: string;
	role?: string;
	model?: { provider: string; model: string } | string;
	archivedAt?: number;
	archivedBy?: string;
	archivedReason?: string;
	/** When a turn last started in this room, through any door (persistent-room-last-used.ts), or the estimate below; null when the room has neither (never used, or archived before it was given an estimate). The home screen's "Recently used" order reads this and nothing else. */
	lastUsedAt: string | null;
	/** True while `lastUsedAt` is an estimate rather than a turn's stamp: the newest change of any conversation somebody spoke in, given once to a room that was in use before stamps existed. The room's first turn replaces it. */
	lastUsedIsEstimate: boolean;
	l1a: { path: string; exists: boolean; bytes?: number };
	l1b: { path: string; exists: boolean; bytes?: number; sections: string[]; missingSections: string[] };
	sectionRegistry: { path: string; exists: boolean; missingSections: string[] };
	recentContext: { fullEntries: number; softCap: number; hardCap: number; blockCap: number };
	memoryStatus: {
		recentContextCount: number;
		recentContextSoftCap: number;
		recentContextHardCap: number;
		recentContextLevel: PersistentAgentMemoryStatusLevel;
		lastCheckpointId: string | null;
		lastCheckpointAt: string | null;
		/**
		 * The latest memory write of any kind (Remember, Memorize, Review, or a
		 * note added, edited, deleted, or restored), or null while the memory is
		 * still exactly what the room was created with.
		 */
		lastMemoryWriteAt: string | null;
		/** Notes Memorize has work for with no conversation waiting (notesToSortCount): Memorize stays open for them. */
		notesToSort: number;
	};
	scheduleSummary: PersistentRoomScheduleSummary;
	promptBudget?: PersistentAgentPromptBudget;
	memoryBudgetTokens?: number;
	memoryBudget?: PersistentAgentMemoryBudget;
	// The room saves a clean Memorize without the card; the Maintain chooser
	// starts such a room's Memorize without a first read.
	fastPathSecondApproval?: boolean;
	errors: string[];
	warnings: string[];
}

// The budget binds on the review target — Deep Memory + Active Items — not the
// whole L1b. The server computes the one predicate here;
// meters, badges, and bars render this block and never re-derive the comparison.
export interface PersistentAgentMemoryBudget {
	budgetTokens: number;
	reviewTargetEstimatedTokens: number;
	overBudget: boolean;
}

export interface PersistentAgentScaffoldUserInput {
	displayName?: string;
	preferredAddress?: string;
}

export interface PersistentAgentScaffoldInput {
	displayName?: string;
	name?: string;
	userName?: string;
	preferredUserAddress?: string;
	preferredAddress?: string;
	user?: PersistentAgentScaffoldUserInput;
	role?: string;
	templateId?: string;
	description?: string;
	mode?: string;
}

export interface NormalizedPersistentAgentScaffoldInput {
	displayName: string;
	baseAgentId: string;
	role: string;
	templateId: string;
	mode: string;
	description?: string;
	user: {
		displayName: string;
		preferredAddress: string;
	};
}

export interface ReservedPersistentAgentRoot {
	agentId: PersistentAgentId;
	rootDir: string;
	baseAgentId: string;
	attempts: number;
}

export interface PersistentAgentScaffoldResult {
	agent: {
		id: PersistentAgentId;
		agentId: PersistentAgentId;
		displayName: string;
		description?: string;
		role: string;
		templateId: string;
		root: string;
		status: PersistentAgentStatusValue;
	};
	status: PersistentAgentStatus;
	created: string[];
	warnings: string[];
}

// A detached turn landed its answer while no client was
// watching. Same shape as the specialist away-notice — an unnoticed ending
// recorded at landing time, surfaced on the room status, and cleared when a
// session next binds to the room (the user is about to see the landed answer
// in the transcript). File-backed so a fresh app load still badges the room.
// A scheduled run lands the same way but not into the same place: its answer
// may go into a conversation of its own rather than into the room's live one.
// The origin says which door landed the answer so the status read can pick the
// honest reachability test for each (see `unseenLandedAnswerStillReachable`).
// Marker files written before this field existed are detached turns.
export type PersistentAgentUnseenLandedAnswerOrigin = "detached-turn" | "scheduled-run";

export interface PersistentAgentUnseenLandedAnswer {
	threadId: string;
	turnId: string;
	terminalReason: "completed" | "failed";
	landedAt: number;
	origin: PersistentAgentUnseenLandedAnswerOrigin;
}

/** A lock a conversation ran on before a switch, and when it stopped. */
export interface PersistentAgentThreadModelHistoryEntry {
	provider: string;
	model: string;
	until: number;
}

export { REQUIRED_L1B_SECTIONS, STABLE_DURABLE_L1B_SECTIONS };
