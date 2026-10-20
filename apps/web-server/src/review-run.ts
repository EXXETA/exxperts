// Review v2 — the run.
//
// Review stops being one request that asks a model to rewrite a room's whole
// stable memory and hands back a draft. It becomes a RUN, the same shape
// Memorize took: the server tidies the room's topics a group at a time, keeps
// every note's id, date and pin while doing it, enforces the budget
// deterministically, and builds the candidate the user approves. The client
// starts the run, polls it, adjusts what it keeps, and approves.
//
// The promises the design signed, as they live here:
//   - no reply is large: one group of topics in, a handful of operations out;
//   - a failure costs ONE group: the topics of a group whose call fails are
//     left exactly as they were and named on the card, and the run carries on;
//   - three groups are in flight at once, and the step that changes the working
//     document is serialized, so the order groups come back in cannot change
//     what is written;
//   - the budget is the server's job, by rank, disclosed and reversible — never
//     a deletion, always an archive row with a why;
//   - nothing is written until approve, and approve is ONE write (snapshot,
//     archive, core, event record) through the entry store.
//
// What lives here: the state machine, the loop, the budget pass and the
// approval write. What does not: the prompt, the grammar, the validator and the
// applier (review-ops.ts), the entry model (memory-entries.ts), the files
// (memory-entries-store.ts), and the worker itself (the route injects it).

import path from "node:path";

import { MEMORY_CARD_NOTE_MAX_CHARS, memoryTextHasWords, memoryTypedText } from "./memory-typed-text.js";
import { ModelUnreachableError, patienceSpent, WaitLine, type PatienceWait } from "./model-call-causes.js";
import type { CredentialKey } from "./model-not-offered.js";
import { recordMemoryUse } from "./memory-use.js";
import { codeSorter, isUnsorted } from "./memory-placement.js";
import { hasActiveAbsorbRun, memoryUseForRanking, savedRunRecord, dropRunJournal, readRunJournal, writeRunJournal, parseRunKeepRequest, rebaseOntoDisk, type AbsorbRunArchiveRow, type AbsorbRunBudget, type AbsorbRunDemotion, type AbsorbRunEntryCard, type RankedArchiveAppend } from "./absorb-run.js";
import { recordMaintenanceWorkerCalls } from "./maintenance-diagnostics.js";
import {
	applyUserEdit,
	cloneDocument,
	demoteToBudget,
	entryTokens,
	MEMORY_ACTIVE_ITEMS_TOPIC,
	memoryTopicAddress,
	memoryTopicAddressKey,
	renderMemoryDocument,
	restoreEntry,
	reviewTargetTokens,
	type MemoryDocument,
	type MemoryEntry,
	type MemorySection,
	type MemoryTopic,
} from "./memory-entries.js";
import {
	assertMemoryWriteAllowed,
	loadMemoryDocument,
	memoryRoomBusy,
	settleMemoryBudget,
	writeMemoryDocument,
} from "./memory-entries-store.js";
import { conflictPromptLine, findLookAlikeTopics, findNotePairs, type DuplicateNotePair } from "./memory-duplicates.js";
import {
	assertAbsorbSourceFingerprintCurrent,
	createPersistentAgentInstance,
	fingerprintL1bSource,
	refuseOversizedMaintenancePrompt,
	updateChronosForReview,
	buildReviewRunEventRecord,
	type AbsorbGenerateResult,
	type CheckpointModelWindow,
	type L1bSourceFingerprint,
	type PersistentAgentModelLock,
	type ReviewEventRecord,
} from "./persistent-agents.js";
import { MEMORY_BUDGET_MAX_TOKENS, MEMORY_BUDGET_MIN_TOKENS, formatTokenLimit, overMemoryBudget, readPersistentRoomMaintenanceSettings } from "./persistent-room-maintenance-settings.js";
import { emptyReviewGuidance, reviewGuidanceIsEmpty, reviewRemovalsNotDone, type ReviewGuidance } from "./review-guidance.js";
import {
	applyReviewOps,
	buildReviewGroupPrompt,
	buildReviewRetryPrompt,
	parseReviewOps,
	partitionReviewTopics,
	renderReviewGroupContext,
	reviewGroupLabel,
	reviewGroupNotes,
	reviewGroupTopic,
	reviewReplySourceBudget,
	keepValidReviewOps,
	type ReviewArchiveRow,
	type ReviewChange,
	type ReviewChangeKind,
	type ReviewConflictPair,
	type ReviewDepth,
	type ReviewGroupTopic,
	type ReviewOp,
	type ReviewTopicBond,
} from "./review-ops.js";
import { estimateTokens } from "./token-estimate.js";
import { clearKeptDiscussion } from "./memorize-discussion-keep.js";

// --- The wire shapes (the API contract, field for field) ----------------------

export type ReviewRunState = "prepass" | "tidying" | "budget" | "ready" | "approving" | "saved" | "cancelled" | "failed";

export type ReviewRunEntryCard = AbsorbRunEntryCard;
/** The archive list's row, the same shape the Memorize card reads; every Review row has phase "after", there being no conversation read before it. */
export type ReviewRunArchiveRow = AbsorbRunArchiveRow;

/** One thing the tidy did to one note, as the card's rows read it. */
export interface ReviewRunChange {
	id: string;
	section: MemorySection;
	topic: string;
	kind: ReviewChangeKind;
	/** The note's words before, or — for a move — the topic it came from, or — for a fold — the topic that was folded. */
	before?: string;
	/** The note's words after, or — for a move or a fold — the topic the notes now sit under. */
	after?: string;
	/** archived and closed: the reason the archive row carries. */
	why?: string;
	/** merged: the notes that became this one, the surviving id first. */
	mergedFrom?: string[];
	/** topic_folded: how many notes moved with the fold. */
	notesMoved?: number;
	/** archived as duplicate: the note that already says it, as the machine paired them at the start of the run. */
	duplicateOf?: { id: string; topic: string };
	/** merged, when the merge resolved a pair the machine found disagreeing: which value replaced which and why. */
	reason?: string;
	/** merged, for the same rows: the member of the pair that left, and the topic it sat under. */
	conflictWith?: { id: string; topic: string };
}

/** A group whose call never produced something the memory could accept. */
export interface ReviewRunLeftAsIs {
	topics: string[];
	reason: string;
}

export interface ReviewRun {
	runId: string;
	agentId: string;
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
	budget: AbsorbRunBudget;
	demotion: AbsorbRunDemotion;
	candidate: { sourceFingerprint: L1bSourceFingerprint; estimatedTokens: number } | null;
	/** What the person agreed in the discussion, echoed back so the card can list it; null when nothing was asked for. */
	guidance: ReviewGuidance | null;
	/** The guidance's "move to the archive" lines whose note this save would still keep: the card says they were not done. */
	removeNotDone?: string[];
	/**
	 * A room whose memory had no note ids: the run gave them in memory and the
	 * approval write is the first and only write. Null on a room that already had
	 * them. A NOTE, not a warning.
	 */
	migration: { pending: boolean; entriesAssigned: number } | null;
	warnings: string[];
	usage?: { input?: number; output?: number; totalTokens?: number; cost?: number };
	error?: string;
	/**
	 * The run stopped before every group was tidied because the Memory model
	 * cannot be reached: the card shows the one notice (Try again, Choose
	 * another model, Sign in when that is the cause). What finished can be saved.
	 */
	/** `key`: a signed-out key connection's key is missing, or saved and refused. */
	stop?: { kind: "outage" | "restart"; model: { provider: string; model: string }; cause: "not-answering" | "busy" | "signed-out" | "quota" | "not-offered" | "not-on-account" | "restarted"; key?: CredentialKey };
	/** A busy Memory model being waited out: the card says when the next try is. */
	wait?: PatienceWait;
}

export interface ReviewRunApprovalResponse {
	agentId: string;
	writesMemory: true;
	reviewId: string;
	/** This save under the name the undo route takes — the same value as `reviewId`. */
	saveId: string;
	/** A Save sent again for a review that already saved: nothing was written this time. */
	alreadySaved?: true;
	eventRelPath: string;
	memoryBudget: { budgetTokens: number; reviewTargetEstimatedTokens: number; overBudget: boolean };
	/** What the saved screen says: how many notes were tidied, and how many left for the archive. */
	topicsTidied: number;
	notesChanged: number;
	archivedEntries: number;
	archivedForBudget: number;
	/** The limit the card raised, written to the room's settings by this save. Absent when the save was made against the saved limit. */
	budgetRaisedTo?: number;
	/** Conversations remembered while the run was open: the save was rebased onto the file with them, and they stay waiting. Empty when none. */
	rebasedOnto: string[];
	warnings: string[];
}

/** What a room says about Review before anything starts. */
export interface ReviewStatusResponse {
	agentId: string;
	available: boolean;
	/** Why not, in the product's own words; absent when it is available. */
	reason?: string;
	topics: number;
	notes: number;
	budget: { reviewTargetTokens: number; budgetTokens: number; overBudget: boolean };
	/** "tidy" when the memory is over its limit, else "wording". */
	recommendedDepth: ReviewDepth;
	writesMemory: false;
	/** A card waiting for Save or Discard, a restarted one included: the screen opens it. */
	waitingRunId?: string;
}

// --- Bounds and sentences ------------------------------------------------------

/** One tidy call's hard ceiling — the same eight minutes every maintenance worker gets. */
export const REVIEW_TIDY_TIMEOUT_MS = 8 * 60 * 1000;
/** How many groups are asked for at once. Three keeps a large room's run short without flooding a gateway. */
export const REVIEW_GROUPS_IN_FLIGHT = 3;
/** The wait before a call that never came back is asked again. */
export const REVIEW_TIDY_RETRY_PAUSE_MS = 2_000;
/** The longest a note edited by hand may be: generous, and still a note rather than a page. */
export const REVIEW_RUN_EDIT_MAX_CHARS = MEMORY_CARD_NOTE_MAX_CHARS;

/**
 * The reasons a group carries when it is left as it was. Each is ONE cause
 * sentence; the consequence ("These notes are unchanged.") belongs to the
 * screen, which appends it to every reason alike.
 */
export const REVIEW_TIDY_REFUSED_TWICE = "The tidy for these notes did not come back in a form the memory could accept.";
/** A call that failed while the model answers, whatever the cause: the tidy failed, not the memory. */
export const REVIEW_TIDY_WORKER_FAILED = "The model could not tidy these notes this time.";
/** A group the run did not reach because the Memory model could not be reached (draft). */
export const REVIEW_TIDY_NOT_REACHED = "The Memory model could not be reached, so these notes were not tidied.";
/** A group a restart caught before it finished (draft). */
export const REVIEW_TIDY_RESTARTED = "The app restarted before these notes were tidied.";

export const REVIEW_NOTHING_TO_TIDY_SENTENCE = "This room's memory has no notes to tidy yet.";
export const REVIEW_ABSORB_ACTIVE_SENTENCE = "This room is updating its memory right now. Wait for that update to finish, then review.";
/** The same fact the first read states when the room is mid-turn; status and the routes behind it must agree. */
export const REVIEW_ROOM_BUSY_SENTENCE = "This room is in the middle of a turn. Wait for it to finish, then review its notes.";

function truncatedTidySentence(generated: { usage?: { output?: number }; modelMaxOutputTokens?: number }): string {
	const produced = generated.usage?.output;
	const ceiling = generated.modelMaxOutputTokens;
	const numbers = produced ? ` (the model returned ${produced}${ceiling ? ` of a maximum ${ceiling}` : ""} output tokens)` : "";
	return `The tidy for these notes was cut off at the model's output limit${numbers}.`;
}

let tidyRetryPauseMs = REVIEW_TIDY_RETRY_PAUSE_MS;

/** Test seam: the wait before a retried tidy call, in milliseconds. */
export function setReviewTidyRetryPauseForTests(ms: number): void {
	tidyRetryPauseMs = Math.max(0, ms);
}

function tidyRetryPause(signal: AbortSignal): Promise<void> {
	if (tidyRetryPauseMs <= 0 || signal.aborted) return Promise.resolve();
	return new Promise<void>((resolve) => {
		const done = () => {
			clearTimeout(timer);
			signal.removeEventListener("abort", done);
			resolve();
		};
		const timer = setTimeout(done, tidyRetryPauseMs);
		signal.addEventListener("abort", done);
	});
}

function oneLine(value: string, max = 240): string {
	const line = value.replace(/\s+/g, " ").trim();
	return line.length <= max ? line : `${line.slice(0, max - 1)}…`;
}

function endsAsSentence(value: string): string {
	const line = oneLine(value);
	if (!line) return "";
	return /[.!?…]$/.test(line) ? line : `${line}.`;
}

function productError(message: string, code: string, statusCode = 400, details?: unknown): Error {
	const error = new Error(message);
	(error as any).statusCode = statusCode;
	(error as any).code = code;
	if (details !== undefined) (error as any).details = details;
	return error;
}

/** The refusal carries the run that is in the way, so the client can offer to cancel it. */
export function reviewRunActiveError(runId: string): Error {
	return productError("This room is already reviewing its memory. Wait for that review to finish, or cancel it.", "review_run_active", 409, { runId });
}

export function reviewRunUnknownError(): Error {
	return productError("That review is no longer open. Start Review again.", "review_run_unknown", 404);
}

// --- Cards ---------------------------------------------------------------------

function entryCard(entry: MemoryEntry, section: MemorySection, topic: string): ReviewRunEntryCard {
	return {
		id: entry.id,
		section,
		topic,
		kind: entry.kind,
		saved: entry.saved,
		...(entry.from ? { from: entry.from } : {}),
		pinned: entry.pinned,
		...(entry.status ? { status: entry.status } : {}),
		...(entry.updated ? { updated: entry.updated } : {}),
		...(entry.refs === undefined ? {} : { refs: entry.refs }),
		tokens: entryTokens(entry),
		text: entry.text,
	};
}

function addressBook(doc: MemoryDocument): Map<string, { section: MemorySection; topic: string }> {
	const map = new Map<string, { section: MemorySection; topic: string }>();
	for (const topic of doc.topics) for (const entry of topic.entries) map.set(entry.id, { section: topic.section, topic: topic.title });
	return map;
}

// --- The run's private state ----------------------------------------------------

export type ReviewRunGenerate = (
	prompt: string,
	model: PersistentAgentModelLock,
	/** The tidy is a single-shot transform: reasoning tokens would count against the output cap and starve the reply. */
	options: { signal: AbortSignal; timeoutMs: number; thinkingLevel: "low"; onWait?: (wait: PatienceWait | null) => void },
) => Promise<AbsorbGenerateResult>;

export interface ReviewRunStartInput {
	depth: ReviewDepth;
	/** The topics the first read flagged, matched by title. Empty means the guidance's topics, then every topic. */
	topics?: string[];
	guidance?: ReviewGuidance;
	model: PersistentAgentModelLock;
	generate: ReviewRunGenerate;
	/** The memory the first read and the discussion were built on: a run refuses to start on a memory that has changed underneath. */
	sourceFingerprint?: L1bSourceFingerprint;
	resolveModelWindow?: (model: PersistentAgentModelLock) => CheckpointModelWindow | undefined;
	now?: () => Date;
}

const tidyWaitLines = new WeakMap<RunSlot, WaitLine>();

/** The run's one wait line: each tidy group's call keeps its own wait on it, so one group ending never takes down another's. */
function tidyWaitLine(slot: RunSlot, now: () => Date): WaitLine {
	let line = tidyWaitLines.get(slot);
	if (!line) {
		line = new WaitLine((wait) => {
			if (wait) slot.run.wait = wait;
			else delete slot.run.wait;
			touch(slot, now());
		});
		tidyWaitLines.set(slot, line);
	}
	return line;
}

interface RunSlot {
	/** The answer the save gave, kept while the run is: a Save sent again answers it once more. */
	savedAnswer?: ReviewRunApprovalResponse;
	run: ReviewRun;
	controller: AbortController;
	model: PersistentAgentModelLock;
	savedDate: string;
	sourceFingerprint: L1bSourceFingerprint;
	/** The file the run read, so an approve can tell a Remember that landed meanwhile from any other change. */
	sourceL1b: string;
	/** The document as it stands after the groups landed — what keep/budget/edit recompute from. */
	postTidyDoc: MemoryDocument | null;
	/** The document as it will be written: post-tidy, post-demotion, the kept notes back in. */
	candidateDoc: MemoryDocument | null;
	/** Rows the tidy set aside; the member of a disagreeing pair a merge resolved carries the merged row's reason. */
	tidyArchive: RankedArchiveAppend[];
	demotionArchive: RankedArchiveAppend[];
	/** The archive list, by note id, for the life of the run: rows are added and re-flagged, never removed. */
	archiveRows: Map<string, ReviewRunArchiveRow>;
	work: Promise<void> | null;
	/** What the run was started with: a resume tidies the groups not done with the same depth and guidance. */
	input: ReviewRunStartInput;
	/** The ids the room's archive held when the run read the memory. */
	archiveIdsOnDisk: string[];
	/** The document while groups are tidied; it holds only the groups that finished. */
	workingDoc: MemoryDocument | null;
	/** The groups of the tidy in progress, and which of them finished: a restart leaves the rest as they were. */
	planned: PlannedGroup[];
	finished: Set<number>;
	/** A resumed tidy's notes the person kept or this run already changed: the groups never see them. */
	held?: string[];
	usage: { input: number; output: number; totalTokens: number; cost: number };
}

const RUNS = new Map<string, RunSlot>();

function isActive(state: ReviewRunState): boolean {
	return state !== "saved" && state !== "cancelled" && state !== "failed";
}

/**
 * Which states hold the room. A run only stops a second Review while it is
 * DOING something. A run that is ready, saved, cancelled or failed is a card,
 * not a worker — the tab showing it may well be closed — so the next start
 * replaces it instead of being refused by it.
 */
function blocksNewRun(state: ReviewRunState): boolean {
	return state === "prepass" || state === "tidying" || state === "budget" || state === "approving";
}

function slotFor(agentId: string, runId: string): RunSlot {
	const slot = RUNS.get(agentId) ?? reviveRun(agentId);
	if (!slot || slot.run.runId !== runId) throw reviewRunUnknownError();
	return slot;
}

function touch(slot: RunSlot, now: Date): void {
	slot.run.updatedAt = now.toISOString();
	writeJournal(slot);
}

// --- The journal: a run survives a restart -------------------------------------
//
// `<room>/runtime/review-run.json` holds the run as it stands, written on every
// change and deleted when the run ends, the same as Memorize's journal.

function journalPath(agentId: string): string {
	return path.join(createPersistentAgentInstance(agentId).runtimeDir(), "review-run.json");
}

function writeJournal(slot: RunSlot): void {
	// A replaced run's late work never touches its successor's journal.
	if (RUNS.get(slot.run.agentId) !== slot) return;
	writeRunJournal(journalPath(slot.run.agentId), isActive(slot.run.state), () => {
		const { controller: _controller, work: _work, input: { generate: _generate, resolveModelWindow: _window, now: _now, ...input }, ...live } = slot;
		return { ...live, input };
	});
}

/**
 * The run a restart left behind: a card as it was, or a run stopped mid-tidy
 * as a card with the groups that finished and Continue for the rest.
 */
function reviveRun(agentId: string): RunSlot | undefined {
	const saved = readRunJournal(journalPath(agentId));
	if (!saved) return undefined;
	const slot: RunSlot = { ...saved, controller: new AbortController(), work: null };
	const run = slot.run;
	RUNS.set(agentId, slot);
	if (slot.workingDoc) {
		for (const group of slot.planned) if (!slot.finished.has(group.index)) run.leftAsIs.push({ topics: group.titles, reason: REVIEW_TIDY_RESTARTED });
		run.stop = { kind: "restart", model: { provider: slot.model.provider, model: slot.model.model }, cause: "restarted" };
		settleTidy(slot, () => new Date());
		return slot;
	}
	if (run.state !== "ready" && run.state !== "approving") {
		RUNS.delete(agentId);
		return dropRunJournal(journalPath(agentId));
	}
	run.state = "ready";
	writeJournal(slot);
	return slot;
}

function finish(slot: RunSlot, state: ReviewRunState, now: Date, error?: string): void {
	slot.run.state = state;
	if (error) slot.run.error = error;
	touch(slot, now);
}

function shortRunId(): string {
	return `reviewrun_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/** Whether a run currently holds this room. */
export function hasActiveReviewRun(agentIdRaw: string): boolean {
	const agentId = createPersistentAgentInstance(agentIdRaw).agentId;
	const slot = RUNS.get(agentId) ?? reviveRun(agentId);
	return Boolean(slot && blocksNewRun(slot.run.state));
}

// --- Choosing what to tidy --------------------------------------------------------

function sameTitle(a: string, b: string): boolean {
	return a.trim().toLowerCase() === b.trim().toLowerCase();
}

/**
 * The topics this run covers: the ones the first read named, else the ones the
 * discussion named, else every topic that holds a note. A title nobody matches
 * is simply not in the set — a first read naming a topic that has since been
 * merged away must not cost the run.
 */
export function chooseReviewTopics(doc: MemoryDocument, asked: readonly string[], guidanceTopics: readonly string[]): MemoryTopic[] {
	const withNotes = doc.topics.filter((topic) => topic.entries.some((entry) => entry.id));
	// Unsorted is always read when it holds a note, whatever was asked.
	const unsorted = withNotes.filter((topic) => topic.section === "Deep Memory" && isUnsorted(topic.title));
	for (const wanted of [asked, guidanceTopics]) {
		if (wanted.length === 0) continue;
		const matched = withNotes.filter((topic) => wanted.some((title) => sameTitle(title, topic.title)));
		if (matched.length > 0) return [...matched, ...unsorted.filter((topic) => !matched.includes(topic))];
	}
	return withNotes;
}

// --- Starting a run ---------------------------------------------------------------

/**
 * Starts the run and returns it immediately in its `prepass` state; the work
 * runs on afterwards and the run is updated after every group, which is what
 * the client polls. One memory job per room: a Memorize in flight, a Review in
 * flight, or a turn the room is in the middle of all refuse a start.
 */
export function startReviewRun(agentIdRaw: string, input: ReviewRunStartInput): ReviewRun {
	const agentId = createPersistentAgentInstance(agentIdRaw).agentId;
	const nowFn = input.now ?? (() => new Date());
	const now = nowFn();
	const existing = RUNS.get(agentId) ?? reviveRun(agentId);
	if (existing && blocksNewRun(existing.run.state)) throw reviewRunActiveError(existing.run.runId);
	if (hasActiveAbsorbRun(agentId)) throw productError(REVIEW_ABSORB_ACTIVE_SENTENCE, "review_absorb_active", 409);
	// Memory is what a running turn is reading; tidying it underneath that turn
	// is how a room answers from a memory nobody has any more.
	assertMemoryWriteAllowed(agentId);
	if (input.sourceFingerprint) assertAbsorbSourceFingerprintCurrent(input.sourceFingerprint, createPersistentAgentInstance(agentId).readL1b(), "first read source");

	const guidance = input.guidance ?? emptyReviewGuidance();
	settleMemoryBudget(agentId);
	const savedBudgetTokens = readPersistentRoomMaintenanceSettings(agentId).memoryBudgetTokens;
	const run: ReviewRun = {
		runId: shortRunId(),
		agentId,
		state: "prepass",
		depth: input.depth,
		startedAt: now.toISOString(),
		updatedAt: now.toISOString(),
		progress: { group: 0, groups: 0 },
		topics: [],
		changes: [],
		leftAsIs: [],
		budget: { before: 0, after: 0, budgetTokens: savedBudgetTokens, savedBudgetTokens, overBudgetAfter: false, ceilingTokens: MEMORY_BUDGET_MAX_TOKENS },
		demotion: { entries: [], keepIds: [], keepTopics: [], overageTokens: 0, protectedOpenItems: 0, counts: { leaving: 0, kept: 0, instead: 0, staying: 0 } },
		candidate: null,
		guidance: reviewGuidanceIsEmpty(guidance) ? null : guidance,
		migration: null,
		warnings: [],
	};
	const slot: RunSlot = {
		run,
		controller: new AbortController(),
		model: input.model,
		savedDate: now.toISOString().slice(0, 10),
		sourceFingerprint: { algorithm: "sha256", value: "" },
		sourceL1b: "",
		postTidyDoc: null,
		candidateDoc: null,
		tidyArchive: [],
		demotionArchive: [],
		archiveRows: new Map(),
		work: null,
		input,
		archiveIdsOnDisk: [],
		workingDoc: null,
		planned: [],
		finished: new Set(),
		usage: { input: 0, output: 0, totalTokens: 0, cost: 0 },
	};
	RUNS.set(agentId, slot);
	// The work starts on the next tick: the caller gets the run back in its
	// prepass state, as the screens expect, before a single step has run.
	slot.work = Promise.resolve().then(() => performRun(slot, nowFn)).catch((error) => {
		// The loop already turns every expected failure into an outcome; this is
		// the backstop for the unexpected one, so a run never hangs in "tidying".
		if (isActive(slot.run.state)) finish(slot, "failed", nowFn(), endsAsSentence((error as Error).message));
	});
	return snapshotRun(slot);
}

interface PlannedGroup {
	index: number;
	topics: ReviewGroupTopic[];
	titles: string[];
	label: string;
}

async function performRun(slot: RunSlot, nowFn: () => Date): Promise<void> {
	const run = slot.run;
	const agentId = run.agentId;
	const guidance = slot.input.guidance ?? emptyReviewGuidance();

	// --- prepass ---------------------------------------------------------------
	// A file that has never carried note ids is migrated IN MEMORY and nothing is
	// written: the screens promise that nothing is saved until the user approves.
	// The migration rides on the run as a note and is performed by the approval
	// write, which is the run's one write either way.
	const loaded = loadMemoryDocument(agentId, { migrate: "in-memory", now: nowFn() });
	if (loaded.pendingMigration) run.migration = { pending: true, entriesAssigned: loaded.pendingMigration.entriesAssigned };
	slot.workingDoc = loaded.doc;
	// The ids the room's archive already holds, read once with the memory: a
	// note tidied in an earlier save has its `-v1` row there, and this run's
	// version of it must be `-v2`, or two rows would claim one address.
	slot.archiveIdsOnDisk = loaded.archive.map((row) => row.id);
	slot.sourceL1b = createPersistentAgentInstance(agentId).readL1b();
	slot.sourceFingerprint = fingerprintL1bSource(slot.sourceL1b);

	const chosen = chooseReviewTopics(loaded.doc, slot.input.topics ?? [], guidance.topics);
	run.topics = chosen.map((topic) => topic.title);
	run.budget.before = reviewTargetTokens(loaded.doc);
	run.state = "tidying";
	await tidyGroups(slot, run.topics, nowFn);
	if (slot.controller.signal.aborted) return finish(slot, "cancelled", nowFn());
	settleTidy(slot, nowFn);
}

/**
 * Tidies the given topics of the working document, three groups at a time.
 * Only a group's whole apply changes the document, and the group is marked
 * finished in that same step, so the journal never holds half a group.
 */
async function tidyGroups(slot: RunSlot, titles: readonly string[], nowFn: () => Date): Promise<void> {
	const run = slot.run;
	const agentId = run.agentId;
	const guidance = slot.input.guidance ?? emptyReviewGuidance();
	const doc0 = slot.workingDoc!;
	const chosen = doc0.topics.filter((topic) => topic.entries.some((entry) => entry.id) && titles.some((title) => sameTitle(title, topic.title)));

	// What the machine finds on its own, computed here on the working document
	// and never taken from the client: the pairs of notes that say one thing,
	// the pairs that disagree, and the pairs of topics that look like one. The
	// two topics of every pair are BONDED for the planning below, so a pair
	// always reaches one call; each group is then handed the pairs it holds.
	const { duplicates: duplicatePairs, conflicts: conflictPairs } = findNotePairs(doc0);
	const lookAlikePairs = findLookAlikeTopics(doc0);
	const bonds: ReviewTopicBond[] = [
		...duplicatePairs.filter((pair) => pair.a.section === pair.b.section && pair.a.topic !== pair.b.topic).map((pair): ReviewTopicBond => [pair.a.topic, pair.b.topic]),
		...conflictPairs.filter((pair) => pair.a.topic !== pair.b.topic).map((pair): ReviewTopicBond => [pair.a.topic, pair.b.topic]),
		...lookAlikePairs.map((pair): ReviewTopicBond => [pair.a, pair.b]),
	];

	const replyBudget = reviewReplySourceBudget(slot.input.resolveModelWindow?.(slot.model)?.maxOutputTokens);
	const planned: PlannedGroup[] = partitionReviewTopics(chosen.map(reviewGroupTopic), replyBudget, bonds).map((topics, index) => ({
		index: index + 1,
		topics,
		titles: topics.map((topic) => topic.title),
		label: reviewGroupLabel(topics),
	}));
	const finished = new Set<number>();
	slot.planned = planned;
	slot.finished = finished;
	run.progress = { group: 0, groups: planned.length, ...(planned[0] ? { label: planned[0].label } : {}) };
	touch(slot, nowFn());
	// From here a restart brings the run back as a card, so the discussion it came from goes.
	clearKeptDiscussion(createPersistentAgentInstance(agentId).rootDir, "review");

	// The apply step is the one place two groups could collide, so it is
	// serialized on this chain: whatever order the three in flight come back in,
	// their operations land on the working document one after another.
	let applyChain: Promise<void> = Promise.resolve();
	const serialize = <T>(fn: () => T): Promise<T> => {
		const next = applyChain.then(fn);
		applyChain = next.then(() => undefined, () => undefined);
		return next;
	};
	// The Memory model cannot be reached: no further group starts, and the card
	// shows the one notice. Set by the first group that learns it.
	let unreachable: ModelUnreachableError | null = null;
	// The groups' calls stop with the run, and at once when one learns the model cannot be reached.
	const groupsStop = new AbortController();
	slot.controller.signal.addEventListener("abort", () => groupsStop.abort(), { once: true });
	const markFinished = (group: PlannedGroup) => {
		finished.add(group.index);
		run.progress.group = finished.size;
		const pending = planned.find((candidate) => !finished.has(candidate.index));
		run.progress.label = pending?.label;
		touch(slot, nowFn());
	};

	/**
	 * A group that failed while the model answers is read again in two halves,
	 * down to one topic: only a one-topic group that fails is left as it was.
	 */
	const leftOrSplit = (group: PlannedGroup, reason: string) => {
		if (group.topics.length > 1 && !unreachable) {
			const half = Math.ceil(group.topics.length / 2);
			for (const topics of [group.topics.slice(0, half), group.topics.slice(half)]) {
				planned.push({ index: planned.length + 1, topics, titles: topics.map((topic) => topic.title), label: reviewGroupLabel(topics) });
			}
			run.progress.groups = planned.length;
		} else {
			run.leftAsIs.push({ topics: group.titles, reason });
		}
		markFinished(group);
	};

	const runGroup = async (group: PlannedGroup): Promise<void> => {
		if (slot.controller.signal.aborted || unreachable) return;
		// The group's notes as they stand NOW: earlier groups may have moved a
		// note into one of these topics, and the model must address what is there.
		const readNotes = await serialize(() => {
			const doc = slot.workingDoc!;
			const titles = new Set(group.titles);
			const held = new Set(slot.held);
			const view = held.size ? { ...doc, topics: doc.topics.map((topic) => ({ ...topic, entries: topic.entries.filter((entry) => !held.has(entry.id)) })) } : doc;
			const topics = view.topics.filter((topic) => titles.has(topic.title)).map(reviewGroupTopic);
			// Every title the memory holds rides along: a move may file under a
			// topic outside this group, and a new title is judged against them all;
			// a fold lands in any of them, so their sections ride along too.
			return {
				topics,
				context: renderReviewGroupContext(topics, view),
				allTitles: doc.topics.map((topic) => topic.title),
				memoryTopics: doc.topics.map((topic) => ({ section: topic.section, title: topic.title, intro: topic.intro })),
				unsortedSummaries: doc.topics.filter((topic) => titles.has(topic.title) && topic.section === "Deep Memory" && isUnsorted(topic.title)).flatMap((topic) => topic.entries.map((entry) => entry.id)),
			};
		});
		const notes = reviewGroupNotes(readNotes.topics);
		if (notes.length === 0) { markFinished(group); return; }
		// The pairs this group holds, as the notes stand now: an earlier group may
		// have archived one half, and a pair is only a pair while both are here.
		const noteIds = new Set(notes.map((note) => note.id));
		const groupTitles = new Set(readNotes.topics.map((topic) => topic.title));
		const duplicateNotes = duplicatePairs.filter((pair) => noteIds.has(pair.a.id) && noteIds.has(pair.b.id)).map((pair): { ids: [string, string] } => ({ ids: [pair.a.id, pair.b.id] }));
		// A disagreeing pair reaches the prompt as one line with both dates and
		// both first lines, and the validator and the applier as the pair itself;
		// the run's own day is the day every date in those words is written against.
		const conflictsHere = conflictPairs.filter((pair) => noteIds.has(pair.a.id) && noteIds.has(pair.b.id));
		const conflictNotes = conflictsHere.map((pair): { ids: [string, string]; line: string } => ({ ids: [pair.a.id, pair.b.id], line: conflictPromptLine(pair, slot.savedDate) }));
		const conflictContext: ReviewConflictPair[] = conflictsHere.map((pair) => ({ ids: [pair.a.id, pair.b.id], newer: pair.newer, texts: [pair.a.text, pair.b.text], dates: [pair.a.date, pair.b.date] }));
		const lookAlikeTopics = lookAlikePairs.filter((pair) => groupTitles.has(pair.a) && groupTitles.has(pair.b));

		const assembly = buildReviewGroupPrompt({
			agentId,
			model: slot.model,
			topics: readNotes.context,
			notes,
			depth: run.depth,
			guidance,
			groupIndex: group.index,
			groupCount: planned.length,
			duplicateNotes,
			conflictNotes,
			lookAlikeTopics,
			unsortedSummaries: readNotes.unsortedSummaries,
			now: nowFn(),
		});
		try {
			refuseOversizedMaintenancePrompt({
				agentId,
				processLabel: "Review tidy",
				model: slot.model,
				promptEstimatedTokens: assembly.telemetry.promptEstimatedTokens,
				window: slot.input.resolveModelWindow?.(slot.model),
				guidance: "Choose a Memory model that can read more at once in Room settings, Model, then review again.",
			});
		} catch (error) {
			leftOrSplit(group, endsAsSentence((error as Error).message));
			return;
		}

		const diagnostics = recordMaintenanceWorkerCalls<PersistentAgentModelLock, AbsorbGenerateResult>(
			{ roomRootDir: createPersistentAgentInstance(agentId).rootDir, agentId, process: "review-tidy" },
			(prompt, model) => slot.input.generate(prompt, model, {
				signal: groupsStop.signal,
				timeoutMs: REVIEW_TIDY_TIMEOUT_MS,
				thinkingLevel: "low",
				// A busy model being waited out: the card says when the next try is.
				onWait: tidyWaitLine(slot, nowFn).call(),
			}),
		);

		let prompt = assembly.prompt;
		let ops: ReviewOp[] = [];
		let refusals: string[] = [];
		let failed: string | null = null;
		// THE RULE, for one group: two calls — the first, and one retry of a reply
		// the memory refused. A call that never came back at all buys ONE call on
		// top of that, once per group, after a short pause, with the same prompt.
		// So a group costs at most three calls, and never more than one retry of
		// either kind.
		let maxAttempts = 2;
		let retriedAfterThrow = false;
		for (let attempt = 1; attempt <= maxAttempts; attempt++) {
			let generated: AbsorbGenerateResult;
			try {
				generated = await diagnostics.generate(prompt, slot.model);
			} catch (error) {
				if (error instanceof ModelUnreachableError) {
					unreachable ??= error;
					groupsStop.abort();
				}
				if (unreachable) {
					failed = REVIEW_TIDY_NOT_REACHED;
					break;
				}
				failed = REVIEW_TIDY_WORKER_FAILED;
				if (slot.controller.signal.aborted) break;
				// A failure the shared patience already waited out gets no second wait here.
				if (!retriedAfterThrow && !patienceSpent(error)) {
					retriedAfterThrow = true;
					maxAttempts = 3;
					failed = null;
					await tidyRetryPause(slot.controller.signal);
					if (slot.controller.signal.aborted) break;
					diagnostics.annotate({ outcome: "retried" });
					continue;
				}
				break;
			}
			slot.usage.input += generated.usage?.input ?? 0;
			slot.usage.output += generated.usage?.output ?? 0;
			slot.usage.totalTokens += generated.usage?.totalTokens ?? 0;
			slot.usage.cost += generated.usage?.cost ?? 0;
			run.usage = { ...slot.usage };
			if (generated.truncated) {
				failed = truncatedTidySentence(generated);
				diagnostics.annotate({ outcome: "refused" });
				break;
			}
			const parsed = parseReviewOps(generated.text);
			// Each op is judged alone: the valid ones apply, a refused one is
			// dropped with a trace. Only a reply of which nothing is valid is asked again.
			const judged = parsed.problems.length > 0 ? { ops: [], dropped: parsed.problems } : keepValidReviewOps(parsed.ops, notes, run.depth, readNotes.allTitles, { group: readNotes.topics, memoryTopics: readNotes.memoryTopics, conflictNotes: conflictContext, today: slot.savedDate });
			ops = judged.ops;
			refusals = parsed.problems.length === 0 && (ops.length > 0 || parsed.ops.length === 0) ? [] : judged.dropped;
			if (refusals.length === 0) {
				diagnostics.annotate({ outcome: "accepted", ...(judged.dropped.length > 0 ? { validatorErrors: judged.dropped } : {}) });
				break;
			}
			diagnostics.annotate({ outcome: "refused", validatorErrors: refusals });
			if (attempt >= maxAttempts) break;
			prompt = buildReviewRetryPrompt(assembly.prompt, refusals);
		}

		if (slot.controller.signal.aborted) return;
		if (failed || refusals.length > 0) {
			leftOrSplit(group, failed ?? REVIEW_TIDY_REFUSED_TWICE);
			return;
		}
		await serialize(() => {
			const applied = applyReviewOps(slot.workingDoc!, ops, { savedDate: slot.savedDate, takenArchiveIds: [...slot.archiveIdsOnDisk, ...slot.tidyArchive.map((append) => append.entry.id)], conflictNotes: conflictContext });
			slot.workingDoc = applied.doc;
			for (const row of applied.archive) slot.tidyArchive.push({ ...row, archived: slot.savedDate });
			run.changes.push(...applied.changes.map((change) => withDuplicatePartner(runChange(change), duplicatePairs)));
			markFinished(group);
		});
	};

	// Three groups at a time: the queue is walked by that many workers, each
	// taking the next group as it finishes the one it had.
	let nextGroup = 0;
	const worker = async (): Promise<void> => {
		for (;;) {
			if (slot.controller.signal.aborted) return;
			if (unreachable) return;
			const group = planned[nextGroup++];
			if (!group) return;
			await runGroup(group);
		}
	};
	await Promise.all(Array.from({ length: Math.min(REVIEW_GROUPS_IN_FLIGHT, Math.max(planned.length, 1)) }, worker));
	await applyChain;

	if (unreachable && !slot.controller.signal.aborted) {
		// What finished stays and can be saved; the groups not reached are left
		// as they were, with the reason, and the card shows the one notice.
		const stopped: ModelUnreachableError = unreachable;
		for (const group of planned) {
			if (!finished.has(group.index)) run.leftAsIs.push({ topics: group.titles, reason: REVIEW_TIDY_NOT_REACHED });
		}
		const detail = stopped.details.detail;
		run.stop = {
			kind: "outage",
			model: { provider: slot.model.provider, model: slot.model.model },
			cause: detail === "signed-out" || detail === "quota" || detail === "not-offered" || detail === "not-on-account" ? detail : detail === "still-busy" ? "busy" : "not-answering",
			...(stopped.details.key ? { key: stopped.details.key } : {}),
		};
	}
}

/** The tidy's tail: what is left in Unsorted placed, the budget pass, and the card. */
function settleTidy(slot: RunSlot, nowFn: () => Date): void {
	const run = slot.run;
	run.progress.label = undefined;
	delete run.wait;
	run.state = "budget";
	let doc = slot.workingDoc!;
	// Nothing is left in Unsorted while the model answers: a note the tidy did
	// not file is placed by code as Memorize's sort places it. A stopped run
	// leaves them waiting for its Try again.
	const placeRest = codeSorter();
	for (const waiting of run.stop ? [] : doc.topics.filter((topic) => topic.section === "Deep Memory" && isUnsorted(topic.title))) {
		for (const entry of [...waiting.entries]) {
			const topic = placeRest(doc, entry.text);
			doc = applyUserEdit(doc, { op: "move", id: entry.id, topic }).doc;
			run.changes.push({ id: entry.id, section: "Deep Memory", topic, kind: "moved", before: waiting.title, after: topic });
		}
		doc = { ...doc, topics: doc.topics.filter((topic) => topic.title !== waiting.title || topic.entries.length > 0) };
	}
	slot.postTidyDoc = doc;
	slot.workingDoc = null;
	slot.planned = [];
	slot.finished = new Set();
	delete slot.held;
	recomputeDemotion(slot);
	run.state = "ready";
	touch(slot, nowFn());
}

function runChange(change: ReviewChange): ReviewRunChange {
	return {
		id: change.id,
		section: change.section,
		topic: change.topic,
		kind: change.kind,
		...(change.before === undefined ? {} : { before: change.before }),
		...(change.after === undefined ? {} : { after: change.after }),
		...(change.why ? { why: change.why } : {}),
		...(change.mergedFrom ? { mergedFrom: [...change.mergedFrom] } : {}),
		...(change.notesMoved === undefined ? {} : { notesMoved: change.notesMoved }),
		...(change.reason ? { reason: change.reason } : {}),
		...(change.conflictWith ? { conflictWith: { ...change.conflictWith } } : {}),
	};
}

/**
 * A note archived as a duplicate names where it is already said: the other
 * member of the first machine-found pair holding it. A duplicate the model
 * found on its own has no pair, and the row says nothing more.
 */
function withDuplicatePartner(change: ReviewRunChange, pairs: readonly DuplicateNotePair[]): ReviewRunChange {
	if (change.kind !== "archived" || change.why !== "duplicate") return change;
	const pair = pairs.find((candidate) => candidate.a.id === change.id || candidate.b.id === change.id);
	if (!pair) return change;
	const partner = pair.a.id === change.id ? pair.b : pair.a;
	return { ...change, duplicateOf: { id: partner.id, topic: partner.topic } };
}

/** A row's topic as the keep route names it, and as `keepTopics` protects it. */
function rowTopicKey(row: { section: MemorySection; topic: string }): string {
	return memoryTopicAddressKey(memoryTopicAddress(row.section, row.topic));
}

/**
 * The archive list as the card reads it, from the rows the run holds: the kept
 * flag and the counts are set here, and the rows are grouped by topic in the
 * document's order with the ones leaving first inside each topic.
 */
function publishArchiveList(slot: RunSlot, doc: MemoryDocument): void {
	const run = slot.run;
	const keep = new Set(run.demotion.keepIds);
	const keptTopics = new Set(run.demotion.keepTopics.map(memoryTopicAddressKey));
	const groups = new Map<string, ReviewRunArchiveRow[]>();
	for (const topic of doc.topics) groups.set(rowTopicKey({ section: topic.section, topic: topic.title }), []);
	for (const row of slot.archiveRows.values()) {
		row.kept = keep.has(row.id) || keptTopics.has(rowTopicKey(row));
		const key = rowTopicKey(row);
		const group = groups.get(key);
		if (group) group.push(row);
		else groups.set(key, [row]);
	}
	const entries: ReviewRunArchiveRow[] = [];
	for (const group of groups.values()) entries.push(...group.sort((a, b) => a.rank - b.rank).map((row) => ({ ...row })));
	run.demotion.entries = entries;
	run.demotion.counts = {
		leaving: entries.filter((row) => row.leaving).length,
		kept: entries.filter((row) => row.kept).length,
		instead: entries.filter((row) => row.leaving && row.instead).length,
		// The notes that stay: the candidate after the demotion holds exactly them;
		// before a candidate exists (the pre-pass), the source less what leaves.
		staying: slot.candidateDoc ? countNotes(slot.candidateDoc) : countNotes(doc) - entries.filter((row) => row.leaving).length,
	};
}

function countNotes(doc: MemoryDocument): number {
	return doc.topics.reduce((sum, topic) => sum + topic.entries.filter((entry) => entry.id).length, 0);
}

/**
 * The budget pass, run again after every keep, every edit and every limit
 * change: the demotion is derived, never accumulated, so a keep the user takes
 * back costs nothing and the numbers on the card are always the numbers the
 * write makes. The LIST, though, is stable: a row is added the first time a
 * pass takes its note and only ever re-flagged after that, so the card never
 * loses a row a person is looking at.
 */
function recomputeDemotion(slot: RunSlot): void {
	const run = slot.run;
	if (!slot.postTidyDoc) return;
	const budgetTokens = run.budget.budgetTokens;
	const keepIds = [...run.demotion.keepIds];
	const keepTopics = [...run.demotion.keepTopics];
	const keep = new Set(keepIds);
	// A note the tidy archived that the user keeps comes BACK: it left because
	// the model judged it stale or finished, and keeping it means keeping it. A
	// protected topic does not reach these: it protects the archive list, which
	// is the budget's, and a note the tidy set aside has its own Keep.
	const restored = slot.tidyArchive.filter((append) => append.why !== "superseded" && keep.has(append.entry.id));
	let doc = slot.postTidyDoc;
	for (const append of restored) {
		doc = restoreEntry(doc, { ...append.entry, archived: append.archived ?? slot.savedDate, why: append.why, topic: append.topic, section: append.section });
	}
	const where = addressBook(doc);
	const demoted = demoteToBudget(doc, budgetTokens, { keepIds, keepTopics, today: slot.savedDate, use: memoryUseForRanking(run.agentId) });
	// A keep protects the note in this save only, by id or by topic: the pass
	// above left it in, and it is never pinned. The save records a use for each
	// kept note, so a later run's pass ranks it higher without making it immortal.
	const candidate = cloneDocument(demoted.doc);
	slot.candidateDoc = candidate;
	if (run.guidance && run.guidance.remove.length > 0) {
		const named = [...slot.postTidyDoc.topics.flatMap((topic) => topic.entries), ...slot.tidyArchive.map((append) => append.entry)];
		const after = candidate.topics.flatMap((topic) => topic.entries.map((entry) => ({ id: entry.id, open: topic.section !== "Active Items" || entry.status !== "done" })));
		run.removeNotDone = reviewRemovalsNotDone(run.guidance.remove, named, after);
	}
	slot.demotionArchive = demoted.demoted.map((entry) => ({ entry, why: "budget" as const, topic: where.get(entry.id)?.topic ?? MEMORY_ACTIVE_ITEMS_TOPIC, section: where.get(entry.id)?.section ?? "Deep Memory", archived: slot.savedDate, reason: entry.reason }));
	const after = reviewTargetTokens(candidate);

	// The stable list. A row entering after the run was ready is leaving in the
	// place of something a person kept, edited or made room for; a row entering
	// in the run's own budget pass is simply what the memory's size costs.
	const instead = run.state === "ready";
	const leaving = new Set<string>();
	demoted.demoted.forEach((entry, rank) => {
		leaving.add(entry.id);
		const card = entryCard(entry, where.get(entry.id)?.section ?? "Deep Memory", where.get(entry.id)?.topic ?? MEMORY_ACTIVE_ITEMS_TOPIC);
		const row = slot.archiveRows.get(entry.id);
		// The card fields are refreshed too: a note the run rewrote can be edited
		// on the card, and the row must read as the note now stands.
		if (row) {
			// A row that stayed in the last pass and leaves again now is leaving in
			// the place of something kept, exactly as a new row would be — unless it
			// stayed because it was kept itself, and its keep was taken back: that row
			// simply leaves again. `kept` still says what the last pass decided.
			const reentering = !row.leaving && !row.kept;
			Object.assign(row, card, { rank, reason: entry.reason });
			if (reentering && instead) row.instead = true;
		} else slot.archiveRows.set(entry.id, { ...card, leaving: true, kept: false, instead, phase: "after", rank, reason: entry.reason });
	});
	for (const row of slot.archiveRows.values()) {
		if (leaving.has(row.id)) {
			row.leaving = true;
		} else {
			row.leaving = false;
			row.instead = false;
		}
	}

	run.demotion.keepIds = keepIds;
	run.demotion.keepTopics = keepTopics;
	run.demotion.overageTokens = demoted.overageTokens;
	run.demotion.protectedOpenItems = demoted.protectedOpenItems;
	publishArchiveList(slot, doc);
	run.budget = { ...run.budget, after, budgetTokens, overBudgetAfter: overMemoryBudget(after, budgetTokens), ceilingTokens: MEMORY_BUDGET_MAX_TOKENS };
	run.candidate = { sourceFingerprint: slot.sourceFingerprint, estimatedTokens: estimateTokens(renderMemoryDocument(candidate, "context")) };
}

// --- Reading and adjusting a run -------------------------------------------------

function snapshotRun(slot: RunSlot): ReviewRun {
	return JSON.parse(JSON.stringify(slot.run)) as ReviewRun;
}

export function getReviewRun(agentIdRaw: string, runId: string): ReviewRun {
	return snapshotRun(slotFor(createPersistentAgentInstance(agentIdRaw).agentId, runId));
}

function requireReady(slot: RunSlot): void {
	if (slot.run.state !== "ready") throw productError("This review is not ready to change yet.", "review_run_not_ready", 409);
}

/** The card's keep toggles: the kept notes and the protected topics stay in this save, and the demotion is derived again. */
export function keepReviewRunEntries(agentIdRaw: string, runId: string, keepRaw: unknown, now = new Date()): ReviewRun {
	const slot = slotFor(createPersistentAgentInstance(agentIdRaw).agentId, runId);
	requireReady(slot);
	// Either list's notes can be kept: what the tidy sent to the archive and what
	// the budget would send there are both this run's disclosure of what leaves.
	// Only the budget's rows carry a topic a person can protect.
	const request = parseRunKeepRequest(
		keepRaw,
		[
			...slot.archiveRows.values(),
			...slot.tidyArchive.filter((append) => append.why !== "superseded").map((append) => ({ id: append.entry.id, section: append.section, topic: append.topic })),
		],
		slot.run.demotion,
		"review_run_bad_keep",
	);
	slot.run.demotion.keepIds = request.keepIds;
	slot.run.demotion.keepTopics = request.keepTopics.filter((topic) => [...slot.archiveRows.values()].some((row) => rowTopicKey(row) === memoryTopicAddressKey(topic)));
	recomputeDemotion(slot);
	touch(slot, now);
	return snapshotRun(slot);
}

/**
 * The card's Edit on a note this review rewrote: the person's words replace the
 * model's before anything is saved. Only a note this run updated or merged is
 * editable here; every other note is edited in Room settings after saving.
 */
export function editReviewRunEntry(agentIdRaw: string, runId: string, entryIdRaw: unknown, textRaw: unknown, now = new Date()): ReviewRun {
	const slot = slotFor(createPersistentAgentInstance(agentIdRaw).agentId, runId);
	requireReady(slot);
	if (!slot.postTidyDoc) throw productError("This review has nothing to edit yet.", "review_run_not_ready", 409);
	const entryId = typeof entryIdRaw === "string" ? entryIdRaw.trim() : "";
	// The person's words under the one rule: nothing typed becomes the file's structure.
	const text = typeof textRaw === "string" ? memoryTypedText(textRaw).trim() : "";
	if (!entryId) throw productError("entryId is required.", "review_run_bad_edit");
	if (!memoryTextHasWords(text)) throw productError("A note cannot be empty. If it should go, move it to the archive instead.", "review_run_bad_edit");
	if (text.length > REVIEW_RUN_EDIT_MAX_CHARS) throw productError(`A note is at most ${REVIEW_RUN_EDIT_MAX_CHARS} characters.`, "review_run_bad_edit");
	const editable = slot.run.changes.some((change) => change.id === entryId && (change.kind === "shortened" || change.kind === "merged"));
	if (!editable) throw productError("Only a note this review rewrote can be edited here.", "review_run_bad_edit", 404);
	let entry: MemoryEntry | undefined;
	for (const topic of slot.postTidyDoc.topics) for (const candidate of topic.entries) if (candidate.id === entryId) entry = candidate;
	if (!entry) throw productError("That note is not in this review any more.", "review_run_bad_edit", 404);
	// A topic written as bullets stays bullets: the person edits the words, not the markup.
	const next = /^[-*]\s/.test(entry.text) && !/^[-*]\s/.test(text) ? `- ${text}` : text;
	entry.text = next;
	for (const change of slot.run.changes) if (change.id === entryId) change.after = next;
	recomputeDemotion(slot);
	touch(slot, now);
	return snapshotRun(slot);
}

/**
 * The card's "Raise the limit to N": the run is computed against the new limit
 * and nothing is written — the room's setting follows on Save, and a cancelled
 * run leaves it as it was. Until then `budget.savedBudgetTokens` says what the
 * room still has.
 */
export function setReviewRunBudget(agentIdRaw: string, runId: string, budgetTokensRaw: unknown, now = new Date()): ReviewRun {
	const slot = slotFor(createPersistentAgentInstance(agentIdRaw).agentId, runId);
	requireReady(slot);
	const budgetTokens = Number(budgetTokensRaw);
	if (!Number.isFinite(budgetTokens) || !Number.isInteger(budgetTokens) || budgetTokens < MEMORY_BUDGET_MIN_TOKENS || budgetTokens > MEMORY_BUDGET_MAX_TOKENS) {
		throw productError(`A room's memory budget is between ${MEMORY_BUDGET_MIN_TOKENS} and ${MEMORY_BUDGET_MAX_TOKENS} tokens.`, "review_run_bad_budget");
	}
	slot.run.budget.budgetTokens = budgetTokens;
	recomputeDemotion(slot);
	touch(slot, now);
	return snapshotRun(slot);
}

/**
 * Try again, after an outage or a restart stopped the run: the same run tidies
 * the groups not done, on top of the card as the person left it, with the
 * room's Memory model as it is now.
 */
export function resumeReviewRun(agentIdRaw: string, runId: string, model: PersistentAgentModelLock, now = new Date(), calls: Partial<Pick<ReviewRunStartInput, "generate" | "resolveModelWindow">> = {}): ReviewRun {
	const agentId = createPersistentAgentInstance(agentIdRaw).agentId;
	const slot = slotFor(agentId, runId);
	requireReady(slot);
	const run = slot.run;
	const waiting = run.leftAsIs.filter((row) => row.reason === REVIEW_TIDY_NOT_REACHED || row.reason === REVIEW_TIDY_RESTARTED);
	if (!run.stop || !slot.postTidyDoc) throw productError("This review has nothing left to tidy.", "review_run_nothing_waiting", 409);
	if (hasActiveAbsorbRun(agentId)) throw productError(REVIEW_ABSORB_ACTIVE_SENTENCE, "review_absorb_active", 409);
	assertMemoryWriteAllowed(agentId);
	// Save's staleness check, before any call.
	const diskL1b = createPersistentAgentInstance(agentId).readL1b();
	if (fingerprintL1bSource(diskL1b).value !== slot.sourceFingerprint.value && !rebaseOntoDisk(slot.sourceL1b, diskL1b)) assertAbsorbSourceFingerprintCurrent(slot.sourceFingerprint, diskL1b, "review");
	const nowFn = slot.input.now ?? (() => new Date());
	// A run a restart left behind has no calls of its own: the route hands them in.
	slot.input = { ...slot.input, ...calls, model };
	slot.model = model;
	run.leftAsIs = run.leftAsIs.filter((row) => !waiting.includes(row));
	delete run.stop;
	run.state = "tidying";
	slot.workingDoc = cloneDocument(slot.postTidyDoc);
	slot.postTidyDoc = null;
	// What the person kept or edited on the card, and what this run changed already, stays as it is.
	slot.held = [...run.demotion.keepIds, ...run.changes.map((change) => change.id)];
	touch(slot, now);
	slot.work = (async () => {
		await tidyGroups(slot, waiting.flatMap((row) => row.topics), nowFn);
		if (slot.controller.signal.aborted) return finish(slot, "cancelled", nowFn());
		settleTidy(slot, nowFn);
	})().catch((error) => {
		if (isActive(slot.run.state)) finish(slot, "failed", nowFn(), endsAsSentence((error as Error).message));
	});
	return snapshotRun(slot);
}

/** Cancel: the groups in flight are aborted and nothing is written. */
export function cancelReviewRun(agentIdRaw: string, runId: string, now = new Date()): ReviewRun {
	const slot = slotFor(createPersistentAgentInstance(agentIdRaw).agentId, runId);
	if (isActive(slot.run.state)) {
		slot.controller.abort();
		finish(slot, "cancelled", now);
	}
	return snapshotRun(slot);
}

// --- Approval --------------------------------------------------------------------

/** A Review save already made, told again: from the run while it is kept, from the room's history once it is gone. Null: this run never saved. */
function savedReviewAnswer(agentId: string, runId: string): ReviewRunApprovalResponse | null {
	const live = RUNS.get(agentId);
	if (live?.run.runId === runId) return live.run.state === "saved" && live.savedAnswer ? { ...live.savedAnswer, alreadySaved: true } : null;
	const record = savedRunRecord<ReviewEventRecord>(createPersistentAgentInstance(agentId).reviewEventDir(), runId);
	if (!record?.run) return null;
	const archived = record.run.archived;
	return {
		agentId,
		writesMemory: true,
		reviewId: record.reviewId,
		saveId: record.reviewId,
		alreadySaved: true,
		eventRelPath: record.paths.eventRelPath,
		memoryBudget: { budgetTokens: record.run.budget.budgetTokens, reviewTargetEstimatedTokens: record.run.budget.after, overBudget: record.run.budget.overBudgetAfter },
		topicsTidied: record.review.topicsTidied,
		notesChanged: record.review.notesChanged,
		archivedEntries: archived.length,
		archivedForBudget: archived.filter((row) => row.why === "budget").length,
		rebasedOnto: [],
		warnings: [],
	};
}

/**
 * ONE write: the candidate document (post-tidy, post-demotion, the kept notes back in),
 * everything that left the core appended to the archive with its reason,
 * Chronos stamped, and the run's own account in the review event record.
 * Anything else that changed the file since the run started makes the run
 * stale, and nothing is written.
 */
export function approveReviewRun(agentIdRaw: string, runId: string, now = new Date()): ReviewRunApprovalResponse {
	const agentId = createPersistentAgentInstance(agentIdRaw).agentId;
	// A Save sent again after its answer was lost: it saved once, and says so.
	const already = savedReviewAnswer(agentId, runId);
	if (already) return already;
	const slot = slotFor(agentId, runId);
	const run = slot.run;
	// The staleness check comes first, and it is what refuses a second approve:
	// the first one wrote the file, so the source this run was built on is no
	// longer the source on disk. One change is absorbed rather than refused: a
	// conversation remembered while the card was open, which a tidy never
	// touches — the write then takes the disk's Recent Context and Chronos with
	// the run's own notes, the same rebase a Memorize save makes.
	const diskL1b = createPersistentAgentInstance(agentId).readL1b();
	let rebase = null as ReturnType<typeof rebaseOntoDisk>;
	if (fingerprintL1bSource(diskL1b).value !== slot.sourceFingerprint.value) {
		rebase = rebaseOntoDisk(slot.sourceL1b, diskL1b);
		if (!rebase) assertAbsorbSourceFingerprintCurrent(slot.sourceFingerprint, diskL1b, "review");
	}
	requireReady(slot);
	const candidateDoc = slot.candidateDoc;
	if (!candidateDoc) throw productError("This review has nothing to save.", "review_run_empty");
	const candidate = cloneDocument(candidateDoc);
	if (rebase) {
		candidate.recentContext = rebase.disk.recentContext;
		candidate.chronos = rebase.disk.chronos;
	}
	const rebasedOnto = rebase?.newSessionIds ?? [];

	// What leaves the core, each with the reason it left. A note the user kept is
	// not among them: it is back in the candidate instead.
	const kept = new Set(run.demotion.keepIds);
	const archiveAppend: RankedArchiveAppend[] = [
		...slot.tidyArchive.filter((append) => append.why === "superseded" || !kept.has(append.entry.id)),
		...slot.demotionArchive,
	];

	run.state = "approving";
	touch(slot, now);
	// A limit the card raised becomes the room's setting with the memory file,
	// in the save's one commit, so the memory that lands is measured against
	// the limit it was built to. A cancelled run never reaches this line.
	const raisedFrom = run.budget.savedBudgetTokens;
	const budgetRaisedTo = run.budget.budgetTokens !== run.budget.savedBudgetTokens ? run.budget.budgetTokens : undefined;
	let written;
	try {
		written = writeMemoryDocument(agentId, cloneDocument(candidate), {
			why: "review",
			snapshotLabel: "review",
			archiveAppend,
			...(budgetRaisedTo !== undefined ? { limitTo: budgetRaisedTo } : {}),
			now,
			stampChronos: (l1b, at, writeId) => updateChronosForReview(l1b, writeId, at),
			eventRecord: (recorded) => buildReviewRunEventRecord({
				agentId,
				reviewId: recorded.writeId,
				now: recorded.now,
				currentL1b: recorded.currentL1b,
				writtenL1b: recorded.writtenL1b,
				archivedL1bPath: recorded.archivedL1bPath,
				updatedL1bPath: recorded.updatedL1bPath,
				model: slot.model,
				usage: run.usage,
				run: {
					runId: run.runId,
					depth: run.depth,
					topics: [...run.topics],
					changes: run.changes.map((change) => ({ id: change.id, kind: change.kind, topic: change.topic, section: change.section, ...(change.why ? { why: change.why } : {}), ...(change.mergedFrom ? { mergedFrom: [...change.mergedFrom] } : {}), ...(change.reason ? { reason: change.reason } : {}), ...(change.conflictWith ? { conflictWith: { ...change.conflictWith } } : {}) })),
					leftAsIs: run.leftAsIs.map((left) => ({ topics: [...left.topics], reason: left.reason })),
					archived: archiveAppend.map((append) => ({ id: append.entry.id, why: append.why, topic: append.topic, section: append.section, ...(append.reason ? { reason: append.reason } : {}) })),
					budget: { before: run.budget.before, after: run.budget.after, budgetTokens: run.budget.budgetTokens, overBudgetAfter: run.budget.overBudgetAfter, ...(budgetRaisedTo === undefined ? {} : { raisedFrom }) },
					...(run.migration?.pending ? { migration: { entriesAssigned: run.migration.entriesAssigned } } : {}),
				},
				warnings: run.warnings,
			}),
		});
	} catch (error) {
		// A save that did not land leaves the room the limit it had, and the
		// failure says so. The error keeps its code and status.
		if (budgetRaisedTo !== undefined && error instanceof Error) error.message = `${error.message} The budget stays at ${formatTokenLimit(raisedFrom)}.`;
		run.state = "ready";
		touch(slot, now);
		throw error;
	}

	if (budgetRaisedTo !== undefined) run.budget.savedBudgetTokens = budgetRaisedTo;
	finish(slot, "saved", now);
	// A keep is a use: each kept note that was written counts one. Use is use,
	// so an undo of this save leaves it.
	const savedIds = new Set(candidate.topics.flatMap((topic) => topic.entries).map((entry) => entry.id));
	const keptUsed = run.demotion.keepIds.filter((id) => savedIds.has(id));
	if (keptUsed.length > 0) recordMemoryUse(agentId, keptUsed.map((id) => ({ id, source: "note" as const })), { now });
	if (run.migration?.pending) run.migration = { pending: false, entriesAssigned: run.migration.entriesAssigned };
	slot.savedAnswer = {
		agentId,
		writesMemory: true,
		reviewId: written.memoryEditId,
		saveId: written.memoryEditId,
		eventRelPath: written.eventRelPath,
		memoryBudget: {
			budgetTokens: written.budget.budgetTokens,
			reviewTargetEstimatedTokens: written.budget.reviewTargetTokens,
			overBudget: written.budget.overBudget,
		},
		topicsTidied: new Set(run.changes.map((change) => change.topic)).size,
		rebasedOnto,
		notesChanged: run.changes.length,
		archivedEntries: archiveAppend.length,
		archivedForBudget: archiveAppend.filter((append) => append.why === "budget").length,
		...(budgetRaisedTo === undefined ? {} : { budgetRaisedTo }),
		warnings: run.warnings,
	};
	return slot.savedAnswer;
}

// --- Status ----------------------------------------------------------------------

/**
 * What a room says about Review before anything starts: how much there is to
 * tidy, what it costs now, and which depth to offer first. A read never
 * migrates: a room's memory changes when a person asks for it, not when a
 * screen looks at it.
 */
export function reviewRunStatus(agentIdRaw: string): ReviewStatusResponse {
	const agentId = createPersistentAgentInstance(agentIdRaw).agentId;
	const waiting = RUNS.get(agentId) ?? reviveRun(agentId);
	const doc = loadMemoryDocument(agentId, { migrate: false }).doc;
	const topics = doc.topics.filter((topic) => topic.entries.length > 0);
	const notes = topics.reduce((sum, topic) => sum + topic.entries.length, 0);
	const budgetTokens = readPersistentRoomMaintenanceSettings(agentId).memoryBudgetTokens;
	const tokens = reviewTargetTokens(doc);
	const overBudget = overMemoryBudget(tokens, budgetTokens);
	const blocked = memoryRoomBusy(agentId)
		? REVIEW_ROOM_BUSY_SENTENCE
		: hasActiveAbsorbRun(agentId)
		? REVIEW_ABSORB_ACTIVE_SENTENCE
		: notes === 0
			? REVIEW_NOTHING_TO_TIDY_SENTENCE
			: "";
	return {
		agentId,
		available: !blocked,
		...(blocked ? { reason: blocked } : {}),
		topics: topics.length,
		notes,
		budget: { reviewTargetTokens: tokens, budgetTokens, overBudget },
		recommendedDepth: overBudget ? "tidy" : "wording",
		writesMemory: false,
		...(waiting && isActive(waiting.run.state) ? { waitingRunId: waiting.run.runId } : {}),
	};
}

/** The start body: the depth the person chose, the topics the first read named, and the sign-off. */
export function parseReviewRunStartRequest(raw: any): { depth: ReviewDepth; topics: string[]; sourceFingerprint?: L1bSourceFingerprint } {
	const depthRaw = String(raw?.depth ?? "").trim();
	if (depthRaw !== "wording" && depthRaw !== "tidy") throw productError('depth is required: "wording" or "tidy".', "review_run_bad_depth");
	const topics = (Array.isArray(raw?.topics) ? raw.topics : [])
		.filter((value: unknown): value is string => typeof value === "string")
		.map((value: string) => value.trim())
		.filter(Boolean)
		.slice(0, 200);
	const fingerprint = raw?.source?.l1bFingerprint ?? raw?.source;
	const algorithm = String(fingerprint?.algorithm ?? "").trim();
	const value = String(fingerprint?.value ?? "").trim();
	return {
		depth: depthRaw,
		topics,
		...(algorithm === "sha256" && /^[a-f0-9]{64}$/i.test(value) ? { sourceFingerprint: { algorithm: "sha256" as const, value: value.toLowerCase() } } : {}),
	};
}

/** Test seam: the registry is process-local state, and a smoke that drives two rooms must be able to clear it. */
export function resetReviewRunsForTests(): void {
	RUNS.clear();
}
