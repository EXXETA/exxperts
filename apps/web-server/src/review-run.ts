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

import { hasActiveAbsorbRun, memoryUseForRanking, parseRunKeepRequest, rebaseOntoDisk, type AbsorbRunArchiveRow, type AbsorbRunBudget, type AbsorbRunDemotion, type AbsorbRunEntryCard, type RankedArchiveAppend } from "./absorb-run.js";
import { recordMaintenanceWorkerCalls } from "./maintenance-diagnostics.js";
import {
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
import { IsolatedPersistentAgentWorkerTurnError } from "./persistent-agent-worker-runtime.js";
import {
	assertAbsorbSourceFingerprintCurrent,
	createPersistentAgentInstance,
	fingerprintL1bSource,
	refuseOversizedMaintenancePrompt,
	updateChronosForReview,
	writeReviewRunEventRecord,
	type AbsorbGenerateResult,
	type CheckpointModelWindow,
	type L1bSourceFingerprint,
	type PersistentAgentModelLock,
} from "./persistent-agents.js";
import { MEMORY_BUDGET_MAX_TOKENS, MEMORY_BUDGET_MIN_TOKENS, formatTokenLimit, overMemoryBudget, readPersistentRoomMaintenanceSettings, writePersistentRoomMaintenanceSettings } from "./persistent-room-maintenance-settings.js";
import { emptyReviewGuidance, reviewGuidanceIsEmpty, type ReviewGuidance } from "./review-guidance.js";
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
	validateReviewOps,
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
	/**
	 * A room whose memory had no note ids: the run gave them in memory and the
	 * approval write is the first and only write. Null on a room that already had
	 * them. A NOTE, not a warning.
	 */
	migration: { pending: boolean; entriesAssigned: number } | null;
	warnings: string[];
	usage?: { input?: number; output?: number; totalTokens?: number; cost?: number };
	error?: string;
}

export interface ReviewRunApprovalResponse {
	agentId: string;
	writesMemory: true;
	reviewId: string;
	/** This save under the name the undo route takes — the same value as `reviewId`. */
	saveId: string;
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
}

// --- Bounds and sentences ------------------------------------------------------

/** One tidy call's hard ceiling — the same eight minutes every maintenance worker gets. */
export const REVIEW_TIDY_TIMEOUT_MS = 8 * 60 * 1000;
/** A finished run stays readable this long, so a client that polls late still sees how it ended. */
export const REVIEW_RUN_RETENTION_MS = 60 * 60 * 1000;
/** How many groups are asked for at once. Three keeps a large room's run short without flooding a gateway. */
export const REVIEW_GROUPS_IN_FLIGHT = 3;
/** The wait before a call that never came back is asked again. */
export const REVIEW_TIDY_RETRY_PAUSE_MS = 2_000;
/** The longest a note edited by hand may be: generous, and still a note rather than a page. */
export const REVIEW_RUN_EDIT_MAX_CHARS = 2000;

/**
 * The reasons a group carries when it is left as it was. Each is ONE cause
 * sentence; the consequence ("These notes are unchanged.") belongs to the
 * screen, which appends it to every reason alike.
 */
export const REVIEW_TIDY_REFUSED_TWICE = "The tidy for these notes did not come back in a form the memory could accept.";
export const REVIEW_TIDY_TIMED_OUT = "The model did not answer within the time limit.";
export const REVIEW_TIDY_CONNECTION_LOST = "The connection to the model dropped while these notes were being tidied.";
export const REVIEW_TIDY_WORKER_FAILED = "The model could not tidy these notes this time.";
export const REVIEW_TIDY_TIMED_OUT_TWICE = "The model did not answer within the time limit, twice.";
export const REVIEW_TIDY_CONNECTION_LOST_TWICE = "The connection dropped twice while these notes were being tidied.";
export const REVIEW_TIDY_WORKER_FAILED_TWICE = "The model could not tidy these notes, twice.";

const TIDY_FAILURE_TWICE = new Map<string, string>([
	[REVIEW_TIDY_TIMED_OUT, REVIEW_TIDY_TIMED_OUT_TWICE],
	[REVIEW_TIDY_CONNECTION_LOST, REVIEW_TIDY_CONNECTION_LOST_TWICE],
	[REVIEW_TIDY_WORKER_FAILED, REVIEW_TIDY_WORKER_FAILED_TWICE],
]);

export const REVIEW_NOTHING_TO_TIDY_SENTENCE = "This room's memory has no notes to tidy yet.";
export const REVIEW_ABSORB_ACTIVE_SENTENCE = "This room is updating its memory right now. Wait for that update to finish, then review.";
/** The same fact the first read states when the room is mid-turn; status and the routes behind it must agree. */
export const REVIEW_ROOM_BUSY_SENTENCE = "This room is in the middle of a turn. Wait for it to finish, then review its notes.";

function tidyFailureSentence(error: unknown): string {
	if (error instanceof IsolatedPersistentAgentWorkerTurnError) {
		return error.stopReason === "aborted" ? REVIEW_TIDY_TIMED_OUT : REVIEW_TIDY_CONNECTION_LOST;
	}
	return REVIEW_TIDY_WORKER_FAILED;
}

/** Only a pair that failed the SAME way is said "twice". */
function tidyFailureSentenceAfterRetry(first: string, second: string): string {
	return first === second ? TIDY_FAILURE_TWICE.get(second) ?? second : second;
}

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
	options: { signal: AbortSignal; timeoutMs: number; thinkingLevel: "low" },
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

interface RunSlot {
	run: ReviewRun;
	controller: AbortController;
	model: PersistentAgentModelLock;
	savedDate: string;
	sourceFingerprint: L1bSourceFingerprint;
	/** The file the run read, so an approve can tell a Remember that landed meanwhile from any other change. */
	sourceL1b: string;
	/** The document as it stands after the groups landed — what keep/budget/edit recompute from. */
	postTidyDoc: MemoryDocument | null;
	/** The document as it will be written: post-tidy, post-demotion, keeps pinned. */
	candidateDoc: MemoryDocument | null;
	/** Rows the tidy set aside; the member of a disagreeing pair a merge resolved carries the merged row's reason. */
	tidyArchive: RankedArchiveAppend[];
	demotionArchive: RankedArchiveAppend[];
	/** The archive list, by note id, for the life of the run: rows are added and re-flagged, never removed. */
	archiveRows: Map<string, ReviewRunArchiveRow>;
	idleSince: number | null;
	work: Promise<void> | null;
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

function forgetExpiredRun(agentId: string, at: number): void {
	const slot = RUNS.get(agentId);
	if (slot && slot.idleSince !== null && at - slot.idleSince > REVIEW_RUN_RETENTION_MS) RUNS.delete(agentId);
}

function slotFor(agentId: string, runId: string): RunSlot {
	forgetExpiredRun(agentId, Date.now());
	const slot = RUNS.get(agentId);
	if (!slot || slot.run.runId !== runId) throw reviewRunUnknownError();
	return slot;
}

function touch(slot: RunSlot, now: Date): void {
	slot.run.updatedAt = now.toISOString();
}

function finish(slot: RunSlot, state: ReviewRunState, now: Date, error?: string): void {
	slot.run.state = state;
	if (error) slot.run.error = error;
	slot.idleSince = Date.now();
	touch(slot, now);
}

function shortRunId(): string {
	return `reviewrun_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/** Whether a run currently holds this room. */
export function hasActiveReviewRun(agentIdRaw: string): boolean {
	const agentId = createPersistentAgentInstance(agentIdRaw).agentId;
	forgetExpiredRun(agentId, Date.now());
	const slot = RUNS.get(agentId);
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
	for (const wanted of [asked, guidanceTopics]) {
		if (wanted.length === 0) continue;
		const matched = withNotes.filter((topic) => wanted.some((title) => sameTitle(title, topic.title)));
		if (matched.length > 0) return matched;
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
	forgetExpiredRun(agentId, Date.now());
	const existing = RUNS.get(agentId);
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
		idleSince: null,
		work: null,
	};
	RUNS.set(agentId, slot);
	// The work starts on the next tick: the caller gets the run back in its
	// prepass state, as the screens expect, before a single step has run.
	slot.work = Promise.resolve().then(() => performRun(slot, input, nowFn)).catch((error) => {
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

async function performRun(slot: RunSlot, input: ReviewRunStartInput, nowFn: () => Date): Promise<void> {
	const run = slot.run;
	const agentId = run.agentId;
	const guidance = input.guidance ?? emptyReviewGuidance();

	// --- prepass ---------------------------------------------------------------
	// A file that has never carried note ids is migrated IN MEMORY and nothing is
	// written: the screens promise that nothing is saved until the user approves.
	// The migration rides on the run as a note and is performed by the approval
	// write, which is the run's one write either way.
	const loaded = loadMemoryDocument(agentId, { migrate: "in-memory", now: nowFn() });
	if (loaded.pendingMigration) run.migration = { pending: true, entriesAssigned: loaded.pendingMigration.entriesAssigned };
	let doc = loaded.doc;
	// The ids the room's archive already holds, read once with the memory: a
	// note tidied in an earlier save has its `-v1` row there, and this run's
	// version of it must be `-v2`, or two rows would claim one address.
	const archiveIdsOnDisk = loaded.archive.map((row) => row.id);
	slot.sourceL1b = createPersistentAgentInstance(agentId).readL1b();
	slot.sourceFingerprint = fingerprintL1bSource(slot.sourceL1b);

	const chosen = chooseReviewTopics(doc, input.topics ?? [], guidance.topics);
	run.topics = chosen.map((topic) => topic.title);
	run.budget.before = reviewTargetTokens(doc);

	// What the machine finds on its own, computed here on the migrated-in-memory
	// document and never taken from the client: the pairs of notes that say one
	// thing, the pairs that disagree, and the pairs of topics that look like
	// one. The two topics of every pair are BONDED for the planning below, so a
	// pair always reaches one call; each group is then handed the pairs it holds.
	const { duplicates: duplicatePairs, conflicts: conflictPairs } = findNotePairs(doc);
	const lookAlikePairs = findLookAlikeTopics(doc);
	const bonds: ReviewTopicBond[] = [
		...duplicatePairs.filter((pair) => pair.a.section === pair.b.section && pair.a.topic !== pair.b.topic).map((pair): ReviewTopicBond => [pair.a.topic, pair.b.topic]),
		...conflictPairs.filter((pair) => pair.a.topic !== pair.b.topic).map((pair): ReviewTopicBond => [pair.a.topic, pair.b.topic]),
		...lookAlikePairs.map((pair): ReviewTopicBond => [pair.a, pair.b]),
	];

	const replyBudget = reviewReplySourceBudget(input.resolveModelWindow?.(input.model)?.maxOutputTokens);
	const planned: PlannedGroup[] = partitionReviewTopics(chosen.map(reviewGroupTopic), replyBudget, bonds).map((topics, index) => ({
		index: index + 1,
		topics,
		titles: topics.map((topic) => topic.title),
		label: reviewGroupLabel(topics),
	}));
	run.progress = { group: 0, groups: planned.length, ...(planned[0] ? { label: planned[0].label } : {}) };
	touch(slot, nowFn());

	// --- tidying ----------------------------------------------------------------
	run.state = "tidying";
	touch(slot, nowFn());
	const usage = { input: 0, output: 0, totalTokens: 0, cost: 0 };
	const finished = new Set<number>();
	// The apply step is the one place two groups could collide, so it is
	// serialized on this chain: whatever order the three in flight come back in,
	// their operations land on the working document one after another.
	let applyChain: Promise<void> = Promise.resolve();
	const serialize = <T>(fn: () => T): Promise<T> => {
		const next = applyChain.then(fn);
		applyChain = next.then(() => undefined, () => undefined);
		return next;
	};
	const markFinished = (group: PlannedGroup) => {
		finished.add(group.index);
		run.progress.group = finished.size;
		const pending = planned.find((candidate) => !finished.has(candidate.index));
		run.progress.label = pending?.label;
		touch(slot, nowFn());
	};

	const runGroup = async (group: PlannedGroup): Promise<void> => {
		if (slot.controller.signal.aborted) return;
		// The group's notes as they stand NOW: earlier groups may have moved a
		// note into one of these topics, and the model must address what is there.
		const readNotes = await serialize(() => {
			const titles = new Set(group.titles);
			const topics = doc.topics.filter((topic) => titles.has(topic.title)).map(reviewGroupTopic);
			// Every title the memory holds rides along: a move may file under a
			// topic outside this group, and a new title is judged against them all;
			// a fold lands in any of them, so their sections ride along too.
			return {
				topics,
				context: renderReviewGroupContext(topics, doc),
				allTitles: doc.topics.map((topic) => topic.title),
				memoryTopics: doc.topics.map((topic) => ({ section: topic.section, title: topic.title, intro: topic.intro })),
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
			model: input.model,
			topics: readNotes.context,
			notes,
			depth: run.depth,
			guidance,
			groupIndex: group.index,
			groupCount: planned.length,
			duplicateNotes,
			conflictNotes,
			lookAlikeTopics,
			now: nowFn(),
		});
		try {
			refuseOversizedMaintenancePrompt({
				agentId,
				processLabel: "Review tidy",
				model: input.model,
				promptEstimatedTokens: assembly.telemetry.promptEstimatedTokens,
				window: input.resolveModelWindow?.(input.model),
				guidance: "Switch the maintenance profile to a larger-context model, then review again.",
			});
		} catch (error) {
			run.leftAsIs.push({ topics: group.titles, reason: endsAsSentence((error as Error).message) });
			markFinished(group);
			return;
		}

		const diagnostics = recordMaintenanceWorkerCalls<PersistentAgentModelLock, AbsorbGenerateResult>(
			{ roomRootDir: createPersistentAgentInstance(agentId).rootDir, agentId, process: "review-tidy" },
			(prompt, model) => input.generate(prompt, model, { signal: slot.controller.signal, timeoutMs: REVIEW_TIDY_TIMEOUT_MS, thinkingLevel: "low" }),
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
		let firstThrowSentence = "";
		for (let attempt = 1; attempt <= maxAttempts; attempt++) {
			let generated: AbsorbGenerateResult;
			try {
				generated = await diagnostics.generate(prompt, input.model);
			} catch (error) {
				const sentence = tidyFailureSentence(error);
				if (slot.controller.signal.aborted) { failed = sentence; break; }
				if (!retriedAfterThrow) {
					retriedAfterThrow = true;
					maxAttempts = 3;
					firstThrowSentence = sentence;
					await tidyRetryPause(slot.controller.signal);
					if (slot.controller.signal.aborted) { failed = sentence; break; }
					diagnostics.annotate({ outcome: "retried" });
					continue;
				}
				failed = tidyFailureSentenceAfterRetry(firstThrowSentence, sentence);
				break;
			}
			usage.input += generated.usage?.input ?? 0;
			usage.output += generated.usage?.output ?? 0;
			usage.totalTokens += generated.usage?.totalTokens ?? 0;
			usage.cost += generated.usage?.cost ?? 0;
			run.usage = { ...usage };
			if (generated.truncated) {
				failed = truncatedTidySentence(generated);
				diagnostics.annotate({ outcome: "refused" });
				break;
			}
			const parsed = parseReviewOps(generated.text);
			ops = parsed.ops;
			refusals = parsed.problems.length > 0 ? parsed.problems : validateReviewOps(parsed.ops, notes, run.depth, readNotes.allTitles, { group: readNotes.topics, memoryTopics: readNotes.memoryTopics, conflictNotes: conflictContext, today: slot.savedDate });
			if (refusals.length === 0) {
				diagnostics.annotate({ outcome: "accepted" });
				break;
			}
			diagnostics.annotate({ outcome: "refused", validatorErrors: refusals });
			if (attempt >= maxAttempts) break;
			prompt = buildReviewRetryPrompt(assembly.prompt, refusals);
		}

		if (slot.controller.signal.aborted) return;
		if (failed || refusals.length > 0) {
			run.leftAsIs.push({ topics: group.titles, reason: failed ?? REVIEW_TIDY_REFUSED_TWICE });
			markFinished(group);
			return;
		}
		await serialize(() => {
			const applied = applyReviewOps(doc, ops, { savedDate: slot.savedDate, takenArchiveIds: [...archiveIdsOnDisk, ...slot.tidyArchive.map((append) => append.entry.id)], conflictNotes: conflictContext });
			doc = applied.doc;
			for (const row of applied.archive) slot.tidyArchive.push({ ...row, archived: slot.savedDate });
			run.changes.push(...applied.changes.map((change) => withDuplicatePartner(runChange(change), duplicatePairs)));
		});
		markFinished(group);
	};

	// Three groups at a time: the queue is walked by that many workers, each
	// taking the next group as it finishes the one it had.
	let nextGroup = 0;
	const worker = async (): Promise<void> => {
		for (;;) {
			if (slot.controller.signal.aborted) return;
			const group = planned[nextGroup++];
			if (!group) return;
			await runGroup(group);
		}
	};
	await Promise.all(Array.from({ length: Math.min(REVIEW_GROUPS_IN_FLIGHT, Math.max(planned.length, 1)) }, worker));
	await applyChain;

	if (slot.controller.signal.aborted) {
		finish(slot, "cancelled", nowFn());
		return;
	}
	run.progress.label = undefined;

	// --- budget -------------------------------------------------------------------
	run.state = "budget";
	touch(slot, nowFn());
	slot.postTidyDoc = doc;
	recomputeDemotion(slot);
	run.state = "ready";
	// A ready run is waiting on a person, and a person can close the tab. Its
	// retention clock starts here.
	slot.idleSince = Date.now();
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
	const candidate = cloneDocument(demoted.doc);
	// Keeping by id IS pinning: the note the user kept is the user's own from
	// here on, and no later run's budget pass takes it either. A protected topic
	// is protected today only, so its notes are not pinned.
	for (const topic of candidate.topics) for (const entry of topic.entries) if (keep.has(entry.id)) entry.pinned = true;
	slot.candidateDoc = candidate;
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

/** The card's keep toggles: the kept notes are pinned, the protected topics are left whole, and the demotion is derived again. */
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
	slot.idleSince = Date.now();
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
	const text = typeof textRaw === "string" ? textRaw.trim() : "";
	if (!entryId) throw productError("entryId is required.", "review_run_bad_edit");
	if (!text) throw productError("A note cannot be empty. If it should go, move it to the archive instead.", "review_run_bad_edit");
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
	slot.idleSince = Date.now();
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
	slot.idleSince = Date.now();
	touch(slot, now);
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

/**
 * ONE write: the candidate document (post-tidy, post-demotion, keeps pinned),
 * everything that left the core appended to the archive with its reason,
 * Chronos stamped, and the run's own account in the review event record.
 * Anything else that changed the file since the run started makes the run
 * stale, and nothing is written.
 */
export function approveReviewRun(agentIdRaw: string, runId: string, now = new Date()): ReviewRunApprovalResponse {
	const agentId = createPersistentAgentInstance(agentIdRaw).agentId;
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
	slot.idleSince = null;
	touch(slot, now);
	// A limit the card raised becomes the room's setting in this same approval,
	// before the memory write, so the memory that lands is measured against the
	// limit it was built to. A cancelled run never reaches this line.
	const raisedFrom = run.budget.savedBudgetTokens;
	const budgetRaisedTo = run.budget.budgetTokens !== run.budget.savedBudgetTokens ? run.budget.budgetTokens : undefined;
	if (budgetRaisedTo !== undefined) {
		writePersistentRoomMaintenanceSettings(agentId, { memoryBudgetTokens: budgetRaisedTo });
		run.budget.savedBudgetTokens = budgetRaisedTo;
	}
	let written;
	try {
		written = writeMemoryDocument(agentId, cloneDocument(candidate), {
			why: "review",
			snapshotLabel: "review",
			archiveAppend,
			now,
			stampChronos: (l1b, at, writeId) => updateChronosForReview(l1b, writeId, at),
			writeEventRecord: (recorded) => writeReviewRunEventRecord({
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
		// The raise was this save's: a save that did not land leaves the room the
		// limit it had, and the failure says so, so the card is not left showing a
		// limit the room does not have. The error keeps its code and status.
		if (budgetRaisedTo !== undefined) {
			writePersistentRoomMaintenanceSettings(agentId, { memoryBudgetTokens: raisedFrom });
			run.budget.savedBudgetTokens = raisedFrom;
			if (error instanceof Error) error.message = `${error.message} The budget stays at ${formatTokenLimit(raisedFrom)}.`;
		}
		run.state = "ready";
		slot.idleSince = Date.now();
		touch(slot, now);
		throw error;
	}

	finish(slot, "saved", now);
	if (run.migration?.pending) run.migration = { pending: false, entriesAssigned: run.migration.entriesAssigned };
	return {
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

/** Test seam: moves a run's retention clock back, so a smoke can prove the reaping without an hour of waiting. */
export function rewindReviewRunClockForTests(agentIdRaw: string, ms: number): void {
	const slot = RUNS.get(createPersistentAgentInstance(agentIdRaw).agentId);
	if (slot && slot.idleSince !== null) slot.idleSince -= ms;
}
