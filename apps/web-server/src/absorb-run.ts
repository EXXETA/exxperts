// Memorize v2 — the run (memory v2, stream D).
//
// Memorize stops being one request that asks a model to rewrite a room's whole
// memory and hands back a draft. It becomes a RUN: the server folds the room's
// remembered sessions into its memory one at a time, enforces the budget
// deterministically, and builds the candidate the user approves. The client
// starts the run, polls it, adjusts what it keeps, and approves.
//
// The promises the design signed, as they live here:
//   - no reply is large: one session in, a handful of operations out, so every
//     call is a one-to-two-minute affair with a hard eight-minute ceiling;
//   - a failure costs ONE step: a session whose call fails stays in Recent
//     Context with a reason, and the loop carries on with the next one;
//   - the budget is the server's job, on every write, by rank, disclosed and
//     reversible — never a deletion, always an archive row with a why;
//   - nothing is written until approve, and approve is ONE write (snapshot,
//     archive, core, event record) through the entry store.
//
// What lives here: the state machine, the loop, the budget pass and the
// approval write. What does not: the prompt, the grammar, the validator and
// the applier (absorb-ops.ts), the entry model (memory-entries.ts), the files
// (memory-entries-store.ts), and the worker itself (the route injects it).

import {
	applyFoldOps,
	buildFoldPrompt,
	EMPTY_FOLD_GUIDANCE,
	foldGuidanceFromWire,
	foldGuidanceToWire,
	parseFoldGuidance,
	parseFoldOps,
	summarizeFold,
	validateFoldOps,
	type FoldGuidance,
	type FoldGuidanceWire,
	type FoldOp,
	type FoldRecord,
} from "./absorb-ops.js";
import { extractRecentContextForAbsorb, recentContextSessions, recentContextWithout, type AbsorbModelLock, type AbsorbRecentContextSession } from "./absorb-consolidation.js";
import {
	cloneDocument,
	demoteToBudget,
	entryTokens,
	listAreas,
	MEMORY_SECTIONS,
	memoryTopicAddress,
	memoryTopicAddressKey,
	nextVersionedEntryId,
	renderMemoryDocument,
	restoreEntries,
	reviewTargetTokens,
	type MemoryDocument,
	type MemoryEntry,
	type MemorySection,
} from "./memory-entries.js";
import {
	loadMemoryDocument,
	settleMemoryBudget,
	writeMemoryDocument,
	type MemoryArchiveAppend,
} from "./memory-entries-store.js";
import { recordMaintenanceWorkerCalls } from "./maintenance-diagnostics.js";
import { IsolatedPersistentAgentWorkerTurnError } from "./persistent-agent-worker-runtime.js";
import {
	assertAbsorbSourceFingerprintCurrent,
	createPersistentAgentInstance,
	fingerprintL1bSource,
	refuseOversizedMaintenancePrompt,
	updateChronosForAbsorb,
	writeAbsorbRunEventRecord,
	type AbsorbApprovalResponse,
	type AbsorbGenerateResult,
	type CheckpointModelWindow,
	type L1bSourceFingerprint,
} from "./persistent-agents.js";
import { MEMORY_BUDGET_MAX_TOKENS, formatTokenLimit, overMemoryBudget, readPersistentRoomMaintenanceSettings, writePersistentRoomMaintenanceSettings, MEMORY_BUDGET_MIN_TOKENS } from "./persistent-room-maintenance-settings.js";
import { estimateTokens } from "./token-estimate.js";

// --- The wire shapes (the API contract, field for field) ----------------------

export type AbsorbRunState = "prepass" | "folding" | "budget" | "ready" | "approving" | "saved" | "cancelled" | "failed";
export type AbsorbRunSessionOutcome = "pending" | "folding" | "folded" | "dropped" | "failed" | "skipped";
export type AbsorbRunChangeKind = "added" | "updated" | "superseded" | "closed" | "pinned";

export interface AbsorbRunEntryCard {
	id: string;
	section: MemorySection;
	topic: string;
	kind: MemoryEntry["kind"];
	saved: string;
	from?: string;
	pinned: boolean;
	status?: "open" | "done";
	updated?: string;
	refs?: number;
	tokens: number;
	text: string;
}

export interface AbsorbRunChange {
	kind: AbsorbRunChangeKind;
	id: string;
	topic: string;
	before?: string;
	after?: string;
	/** The add that opened a topic the memory did not have: the card tags it "new topic". Absent otherwise. */
	newTopic?: true;
}

/** Which pass sent a note to the archive: before any conversation was read (the room was already over), or to make room for what was read. Diagnostics and the smokes read it; the card does not. */
export type AbsorbRunArchivePhase = "before" | "after";

/**
 * One note on the archive list, for the life of the run. The list is STABLE:
 * a note that once appeared on it stays on it, and these flags say what the
 * current computation makes of it — so a kept row keeps its place instead of
 * vanishing, and the note that leaves in its stead is marked as such.
 */
export interface AbsorbRunArchiveRow extends AbsorbRunEntryCard {
	/** The current computation moves it to the archive. */
	leaving: boolean;
	/** The person kept it, by id or by topic; a keep by id is pinned on save. */
	kept: boolean;
	/** It entered the list after the run was ready — because of a keep, an edit or a limit change — and is leaving in the place of something kept. Cleared when it stops leaving. */
	instead: boolean;
	phase: AbsorbRunArchivePhase;
	/** Position in the demotion order, 0 leaving first. Rows within a topic are sorted by it. */
	rank: number;
}

export interface AbsorbRunDemotion {
	/** Every note this run ever proposed for the archive, grouped by topic in document order, rank ascending inside; never shortened while the run lives. */
	entries: AbsorbRunArchiveRow[];
	keepIds: string[];
	/** Topics the person protected for this run, as "Section/Title": no note of these leaves. Matched case-insensitively, trimmed. */
	keepTopics: string[];
	overageTokens: number;
	/** The numbers the card shows; computed here, never in the browser. */
	counts: { leaving: number; kept: number; instead: number; staying: number };
}

export interface AbsorbRunBudget {
	before: number;
	after: number;
	/** The limit this run is computed against: the room's setting, or the value chosen on the card. */
	budgetTokens: number;
	/** The room's saved setting; differs from budgetTokens while the card has raised it and Save has not happened. */
	savedBudgetTokens: number;
	overBudgetAfter: boolean;
	ceilingTokens: number;
}

export interface AbsorbRunSessionView {
	id: string;
	title: string;
	date: string;
	outcome: AbsorbRunSessionOutcome;
	/** dropped: the model's reason; failed: the product sentence; skipped: the user's own instruction. */
	reason?: string;
	summary?: { added: number; updated: number; superseded: number; closed: number };
	changes?: AbsorbRunChange[];
	/** Model calls this session actually cost: one, or two or three when a call was retried. */
	attempts: number;
}

export interface AbsorbRun {
	runId: string;
	agentId: string;
	state: AbsorbRunState;
	startedAt: string;
	updatedAt: string;
	progress: { folded: number; total: number; current?: { id: string; title: string } };
	sessions: AbsorbRunSessionView[];
	/** What the prepass took, as it took it. Diagnostics and older smokes read it; the card reads `demotion.entries`, which carries these rows too. */
	prepass: { demoted: AbsorbRunEntryCard[] };
	budget: AbsorbRunBudget;
	demotion: AbsorbRunDemotion;
	candidate: { sourceFingerprint: L1bSourceFingerprint; estimatedTokens: number } | null;
	/**
	 * What the user asked for when they signed off the discussion, echoed back so
	 * the card can list it and show which of it was applied — the drops are
	 * visible as `skipped` sessions, the pins as entries no budget pass took. Null
	 * when nothing was asked for, which is what the card reads to leave the
	 * section out entirely.
	 */
	guidance: FoldGuidanceWire | null;
	/**
	 * A room whose memory had no entry ids: the run gave them in memory and the
	 * approval write is the first and only write. Null on a room that already had
	 * them. It is a NOTE, not a warning — the screens promise "Nothing is saved"
	 * until approve, and this field is how the card says what approving will also
	 * do, without pretending something went wrong.
	 */
	migration: { pending: boolean; entriesAssigned: number } | null;
	warnings: string[];
	usage?: { input?: number; output?: number; totalTokens?: number; cost?: number };
	error?: string;
}

export interface AbsorbRunApprovalResponse extends AbsorbApprovalResponse {
	/**
	 * This save under the name the undo route takes. It is the absorb event
	 * record's own id — the same value as `absorbId` — under the one field name
	 * a Review save answers with too, so a screen offering "Undo" carries one
	 * id, not one per kind.
	 */
	saveId: string;
	foldedSessions: string[];
	remainingSessions: string[];
	archivedEntries: number;
	/**
	 * How many of those entries left for the budget alone — the pre-pass
	 * demotions plus the post-fold ones. The saved screen needs it to be able to
	 * say "N entries moved to the archive to keep the room under budget" on a run
	 * where no session folded at all and the rest of the archive count is
	 * superseded texts and finished items.
	 */
	archivedForBudget: number;
	/** The limit the card raised, written to the room's settings by this save. Absent when the save was made against the saved limit. */
	budgetRaisedTo?: number;
}

// --- Bounds and sentences ------------------------------------------------------

/** One fold call's hard ceiling — the same eight minutes every maintenance worker gets. */
export const ABSORB_FOLD_TIMEOUT_MS = 8 * 60 * 1000;
/** A finished run stays readable this long, so a client that polls late still sees how it ended. */
export const ABSORB_RUN_RETENTION_MS = 60 * 60 * 1000;
/** The assessment's own cap, the same one the assessment screen accepts. */
export const ABSORB_RUN_ASSESSMENT_MAX_CHARS = 20_000;
/**
 * The wait before a call that never came back is asked again.
 *
 * Long enough for the blip that killed the first one to pass, short enough to
 * be nothing beside the eight minutes that call was allowed to take.
 */
export const ABSORB_FOLD_RETRY_PAUSE_MS = 2_000;

/**
 * The failure reasons a session carries. Each is ONE cause sentence, ending in
 * a full stop; the consequence ("It stays for next time.") belongs to the
 * screen, which appends it to every failure reason alike, so the two halves are
 * never written twice or in two voices.
 */
export const ABSORB_FOLD_REFUSED_TWICE = "This session's update did not come back in a form the memory could accept.";
/** The turn was stopped: its own eight-minute ceiling, or a stall the ceiling caught. */
export const ABSORB_FOLD_TIMED_OUT = "The model did not answer within the time limit, so this session waits for the next update.";
/** The provider failed mid-turn: a dropped connection ("terminated"), an expired sign-in, an HTTP error. */
export const ABSORB_FOLD_CONNECTION_LOST = "The connection to the model dropped while this session was being added, so it waits for the next update.";
/** Anything else the call threw. A person is told what it means for their memory, not what the stack said. */
export const ABSORB_FOLD_WORKER_FAILED = "The model could not add this session this time, so it waits for the next update.";

/**
 * The same three causes when the second call failed the same way as the first.
 *
 * A call that never came back is asked again, so the sentence a person reads
 * has to say which of the two happened. "Twice" is the whole difference: it
 * says the thing was tried again rather than given up on, and it says a second
 * ask will not be what fixes it. These end on the cause alone, so the screen
 * adds "It stays for next time." to them as it does to every other cause.
 */
export const ABSORB_FOLD_TIMED_OUT_TWICE = "The model did not answer within the time limit, twice.";
export const ABSORB_FOLD_CONNECTION_LOST_TWICE = "The connection dropped twice while memorizing this conversation.";
export const ABSORB_FOLD_WORKER_FAILED_TWICE = "The model could not add this conversation, twice.";

/** One cause, in its one-off wording and in its twice wording. */
const FOLD_FAILURE_TWICE = new Map<string, string>([
	[ABSORB_FOLD_TIMED_OUT, ABSORB_FOLD_TIMED_OUT_TWICE],
	[ABSORB_FOLD_CONNECTION_LOST, ABSORB_FOLD_CONNECTION_LOST_TWICE],
	[ABSORB_FOLD_WORKER_FAILED, ABSORB_FOLD_WORKER_FAILED_TWICE],
]);

/**
 * A worker failure as the card says it.
 *
 * The runtime's own sentences are written for whoever is reading a log: a
 * connection dropped mid-reply reads "memorize fold worker failed: terminated",
 * which reached the field as a session's reason and told its user nothing about
 * their memory. What a person needs to know is what happened to this session
 * and what becomes of it, so the cause is mapped to one of three sentences and
 * the provider's own words go to the diagnostics record, which is redacted and
 * meant to be read by whoever is fixing it.
 */
function foldFailureSentence(error: unknown): string {
	if (error instanceof IsolatedPersistentAgentWorkerTurnError) {
		return error.stopReason === "aborted" ? ABSORB_FOLD_TIMED_OUT : ABSORB_FOLD_CONNECTION_LOST;
	}
	return ABSORB_FOLD_WORKER_FAILED;
}

/**
 * The sentence for a conversation whose retried call failed too.
 *
 * Only a pair that failed the SAME way is said "twice": a call that timed out
 * and then dropped is two different things going wrong, and the second one is
 * what a person should be told about, in its own words.
 */
function foldFailureSentenceAfterRetry(first: string, second: string): string {
	return first === second ? FOLD_FAILURE_TWICE.get(second) ?? second : second;
}

/**
 * The retry pause, as a module-level value a smoke can zero. Tests drive dozens
 * of folds through this loop and would otherwise spend their run waiting out a
 * pause whose only job is to let a provider's blip pass.
 */
let foldRetryPauseMs = ABSORB_FOLD_RETRY_PAUSE_MS;

/** Test seam: the wait before a retried fold call, in milliseconds. */
export function setAbsorbFoldRetryPauseForTests(ms: number): void {
	foldRetryPauseMs = Math.max(0, ms);
}

/** Waits out the retry pause, and gives it up the moment the run is cancelled. */
function foldRetryPause(signal: AbortSignal): Promise<void> {
	if (foldRetryPauseMs <= 0 || signal.aborted) return Promise.resolve();
	return new Promise<void>((resolve) => {
		const done = () => {
			clearTimeout(timer);
			signal.removeEventListener("abort", done);
			resolve();
		};
		const timer = setTimeout(done, foldRetryPauseMs);
		signal.addEventListener("abort", done);
	});
}

function truncatedFoldSentence(generated: { usage?: { output?: number }; modelMaxOutputTokens?: number }): string {
	const produced = generated.usage?.output;
	const ceiling = generated.modelMaxOutputTokens;
	const numbers = produced ? ` (the model returned ${produced}${ceiling ? ` of a maximum ${ceiling}` : ""} output tokens)` : "";
	return `This session's update was cut off at the model's output limit${numbers}.`;
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

/**
 * The refusal carries the run that is in the way. Without it the client had a
 * 409 it could do nothing with: the tab that started the run is closed, the run
 * id is gone with it, and the only thing left on the screen is a room that says
 * it is busy forever. With the id, the offer is "cancel that one and start
 * again", which is what a person actually wants.
 */
export function absorbRunActiveError(runId: string): Error {
	return productError("This room is already updating its memory. Wait for that update to finish, or cancel it.", "absorb_run_active", 409, { runId });
}

export function absorbRunUnknownError(): Error {
	return productError("That memory update is no longer open. Start Memorize again.", "absorb_run_unknown", 404);
}

// --- Cards ---------------------------------------------------------------------

function entryCard(entry: MemoryEntry, section: MemorySection, topic: string): AbsorbRunEntryCard {
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

/** Where every entry of a document lives, so a demoted entry still knows its address. */
function addressBook(doc: MemoryDocument): Map<string, { section: MemorySection; topic: string }> {
	const map = new Map<string, { section: MemorySection; topic: string }>();
	for (const topic of doc.topics) for (const entry of topic.entries) map.set(entry.id, { section: topic.section, topic: topic.title });
	return map;
}

/**
 * What a fold reads: Deep Memory and Active Items, every entry carrying its own
 * id in its first line, and nothing else. The other sessions of this run are
 * not a fold's business (it folds ONE), Chronos is bookkeeping, and the ids in
 * the text are what a fold addresses — so the whole prompt is the core memory
 * plus a legend, not the core memory plus a second copy of it as a list.
 */
function coreContextOf(doc: MemoryDocument): string {
	return renderMemoryDocument(doc, "context", { entryIds: true, sections: MEMORY_SECTIONS }).trim();
}

/**
 * The Retry Notice, the same shape every maintenance worker's retry takes: the
 * original prompt, the reasons as they were named, then the ask again. One
 * refused reply per session earns one of these, and never two notices stacked
 * on one prompt — a call that never came back repeats the prompt it was given,
 * this one included, rather than adding a second notice to it.
 */
export function buildFoldRetryPrompt(prompt: string, reasons: string[]): string {
	return `${prompt.trimEnd()}\n\n---\n\n## Retry Notice\n\nYour previous operations were refused:\n\n${reasons.map((reason) => `- ${reason}`).join("\n")}\n\nAnswer again with the narrative and exactly one \`\`\`json fence holding \`{"ops": [ ... ]}\`, resolving every reason above. Copy entry ids exactly as they are listed, and name only what this session changes.\n`;
}

// --- The run's private state ----------------------------------------------------

export type AbsorbRunGenerate = (
	prompt: string,
	model: AbsorbModelLock,
	/** The fold is a single-shot transform: reasoning tokens would count against the output cap and starve the reply, so it asks for reasoning off. */
	options: { signal: AbortSignal; timeoutMs: number; thinkingLevel: "low" },
) => Promise<AbsorbGenerateResult>;

export interface AbsorbRunStartInput {
	agentId: string;
	assessmentMarkdown: string;
	guidance?: FoldGuidance;
	model: AbsorbModelLock;
	generate: AbsorbRunGenerate;
	/**
	 * The memory the assessment and the discussion were built on. When the client
	 * sends it, a run refuses to start on a memory that has changed underneath —
	 * the same staleness rule approve applies, one step earlier, so a run is
	 * never spent folding into a memory the user never saw.
	 */
	sourceFingerprint?: L1bSourceFingerprint;
	/**
	 * The limit the room had before the first read raised it. That raise wrote
	 * the setting at once; the save records it so an undo takes the limit back
	 * down. Kept only while it is below the limit the room holds now.
	 */
	limitRaisedFrom?: number;
	resolveModelWindow?: (model: AbsorbModelLock) => CheckpointModelWindow | undefined;
	now?: () => Date;
}

interface RunSlot {
	run: AbsorbRun;
	controller: AbortController;
	model: AbsorbModelLock;
	savedDate: string;
	sourceFingerprint: L1bSourceFingerprint;
	/** The limit before the first read raised it; the save records it as where the raise came from. */
	limitRaisedFrom: number | undefined;
	sessionsById: Map<string, AbsorbRecentContextSession>;
	/** The document as it stands after the folds and after closed items left — what keep/budget recompute from. */
	postFoldDoc: MemoryDocument | null;
	/** The document as it will be written: post-fold, post-demotion, keeps pinned. */
	candidateDoc: MemoryDocument | null;
	/** What the prepass took, so the folds read a memory under its limit. Every recompute puts these back and ranks them again; what still leaves is in `demotionArchive`. */
	prepassArchive: MemoryArchiveAppend[];
	supersededArchive: MemoryArchiveAppend[];
	closedArchive: MemoryArchiveAppend[];
	demotionArchive: MemoryArchiveAppend[];
	/** The archive list, by note id, for the life of the run: rows are added and re-flagged, never removed. */
	archiveRows: Map<string, AbsorbRunArchiveRow>;
	/**
	 * When this run's retention clock started: the moment it stopped doing work
	 * of its own. A finished run (saved, cancelled, failed) starts it once; a
	 * READY run starts it too, and restarts it on every keep and budget change,
	 * because a card a person is still working is not an abandoned run. Null only
	 * while the run is genuinely working.
	 */
	idleSince: number | null;
	work: Promise<void> | null;
}

const RUNS = new Map<string, RunSlot>();

function isActive(state: AbsorbRunState): boolean {
	return state !== "saved" && state !== "cancelled" && state !== "failed";
}

/**
 * Which states hold the room. A run only stops a second Memorize while it is
 * DOING something: the prepass, a fold, the budget pass, or the approval write.
 * A run that is ready, saved, cancelled or failed is a card, not a worker — the
 * tab showing it may well be closed — so the next propose replaces it instead
 * of being refused by it. That is the whole fix for a room that answered "already
 * updating its memory" forever because a ready run had nobody left to approve it.
 */
function blocksNewRun(state: AbsorbRunState): boolean {
	return state === "prepass" || state === "folding" || state === "budget" || state === "approving";
}

function forgetExpiredRun(agentId: string, at: number): void {
	const slot = RUNS.get(agentId);
	if (slot && slot.idleSince !== null && at - slot.idleSince > ABSORB_RUN_RETENTION_MS) RUNS.delete(agentId);
}

function slotFor(agentId: string, runId: string): RunSlot {
	forgetExpiredRun(agentId, Date.now());
	const slot = RUNS.get(agentId);
	if (!slot || slot.run.runId !== runId) throw absorbRunUnknownError();
	return slot;
}

function touch(slot: RunSlot, now: Date): void {
	slot.run.updatedAt = now.toISOString();
}

function finish(slot: RunSlot, state: AbsorbRunState, now: Date, error?: string): void {
	slot.run.state = state;
	if (error) slot.run.error = error;
	slot.idleSince = Date.now();
	touch(slot, now);
}

/** Whether a sign-off asked for anything at all. An empty one is "no instructions", not an instruction. */
function foldGuidanceAsked(guidance: FoldGuidance): boolean {
	return guidance.pin.length + guidance.drop.length + guidance.corrections.length + guidance.topics.length + guidance.instructions.length > 0;
}

function shortRunId(): string {
	return `absorbrun_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

// --- Starting a run ---------------------------------------------------------------

/**
 * Starts the run and returns it immediately in its `prepass` state; the work
 * runs on afterwards and the run is updated after every step, which is what the
 * client polls. One run per room: a run that is still working refuses a second
 * start and says which run it is, and a run that has stopped working — ready,
 * saved, cancelled or failed — is forgotten and replaced by this one.
 */
export function startAbsorbRun(input: AbsorbRunStartInput): AbsorbRun {
	const agentId = createPersistentAgentInstance(input.agentId).agentId;
	const nowFn = input.now ?? (() => new Date());
	const now = nowFn();
	forgetExpiredRun(agentId, Date.now());
	const existing = RUNS.get(agentId);
	if (existing && blocksNewRun(existing.run.state)) throw absorbRunActiveError(existing.run.runId);
	if (input.sourceFingerprint) assertAbsorbSourceFingerprintCurrent(input.sourceFingerprint, createPersistentAgentInstance(agentId).readL1b(), "assessment source");

	settleMemoryBudget(agentId);
	const savedBudgetTokens = readPersistentRoomMaintenanceSettings(agentId).memoryBudgetTokens;
	const run: AbsorbRun = {
		runId: shortRunId(),
		agentId,
		state: "prepass",
		startedAt: now.toISOString(),
		updatedAt: now.toISOString(),
		progress: { folded: 0, total: 0 },
		sessions: [],
		prepass: { demoted: [] },
		budget: { before: 0, after: 0, budgetTokens: savedBudgetTokens, savedBudgetTokens, overBudgetAfter: false, ceilingTokens: MEMORY_BUDGET_MAX_TOKENS },
		demotion: { entries: [], keepIds: [], keepTopics: [], overageTokens: 0, counts: { leaving: 0, kept: 0, instead: 0, staying: 0 } },
		candidate: null,
		guidance: input.guidance && foldGuidanceAsked(input.guidance) ? foldGuidanceToWire(input.guidance) : null,
		migration: null,
		warnings: [],
	};
	const slot: RunSlot = {
		run,
		controller: new AbortController(),
		model: input.model,
		savedDate: now.toISOString().slice(0, 10),
		sourceFingerprint: { algorithm: "sha256", value: "" },
		limitRaisedFrom: input.limitRaisedFrom !== undefined && input.limitRaisedFrom < savedBudgetTokens ? input.limitRaisedFrom : undefined,
		sessionsById: new Map(),
		postFoldDoc: null,
		candidateDoc: null,
		prepassArchive: [],
		supersededArchive: [],
		closedArchive: [],
		demotionArchive: [],
		archiveRows: new Map(),
		idleSince: null,
		work: null,
	};
	RUNS.set(agentId, slot);
	slot.work = performRun(slot, input, nowFn).catch((error) => {
		// The loop already turns every expected failure into an outcome; this is
		// the backstop for the unexpected one, so a run never hangs in "folding".
		if (isActive(slot.run.state)) finish(slot, "failed", nowFn(), endsAsSentence((error as Error).message));
	});
	return snapshotRun(slot);
}

async function performRun(slot: RunSlot, input: AbsorbRunStartInput, nowFn: () => Date): Promise<void> {
	const run = slot.run;
	const agentId = run.agentId;
	const guidance: FoldGuidance = input.guidance ?? { ...EMPTY_FOLD_GUIDANCE, pin: [], drop: [], corrections: [], topics: [], instructions: [] };

	// --- prepass ---------------------------------------------------------------
	// A file that has never carried entry ids is migrated IN MEMORY and nothing
	// is written: the screens promise that nothing is saved until the user
	// approves, and a propose that quietly rewrote the whole memory file — two
	// thousand metadata comments and a fresh Chronos stamp — broke that promise
	// for every room that had not been migrated yet, including on a cancel. The
	// migration rides on the run as a note and is performed by the approval
	// write, which is the run's one write either way.
	const loaded = loadMemoryDocument(agentId, { migrate: "in-memory", now: nowFn() });
	if (loaded.pendingMigration) run.migration = { pending: true, entriesAssigned: loaded.pendingMigration.entriesAssigned };
	let doc = loaded.doc;
	// The file AS IT STANDS ON DISK is the run's source: its fingerprint is what
	// approve checks — so an entries-pane migration underneath this run is caught
	// as the change it is — and its Recent Context is read through the shared
	// extractor, so the run and the availability check can never disagree about
	// which sessions are waiting.
	const currentL1b = createPersistentAgentInstance(agentId).readL1b();
	slot.sourceFingerprint = fingerprintL1bSource(currentL1b);
	const sessions = recentContextSessions(extractRecentContextForAbsorb(currentL1b).recentContext);
	for (const session of sessions) slot.sessionsById.set(session.id, session);
	const dropReasons = new Map(guidance.drop.map((drop) => [drop.session.toUpperCase(), drop.reason]));
	run.sessions = sessions.map((session) => {
		const skipped = dropReasons.get(session.id.toUpperCase());
		return skipped === undefined
			? { id: session.id, title: session.title, date: session.date, outcome: "pending" as const, attempts: 0 }
			: { id: session.id, title: session.title, date: session.date, outcome: "skipped" as const, reason: endsAsSentence(skipped) || "You asked for this session to be left out.", attempts: 0 };
	});
	run.progress.total = run.sessions.filter((session) => session.outcome === "pending").length;

	// The user's pins are applied to the working document first, so the prepass
	// demotion below can never take one: keeping is pinning, and a pin is the
	// user's own.
	const pinIds = new Set(guidance.pin);
	if (pinIds.size > 0) {
		doc = cloneDocument(doc);
		for (const topic of doc.topics) for (const entry of topic.entries) if (pinIds.has(entry.id)) entry.pinned = true;
	}

	const budgetTokens = run.budget.budgetTokens;
	run.budget.before = reviewTargetTokens(doc);
	if (run.budget.before > budgetTokens) {
		const where = addressBook(doc);
		const demoted = demoteToBudget(doc, budgetTokens, { today: slot.savedDate });
		run.prepass.demoted = demoted.demoted.map((entry) => entryCard(entry, where.get(entry.id)?.section ?? "Deep Memory", where.get(entry.id)?.topic ?? "General"));
		slot.prepassArchive = demoted.demoted.map((entry) => ({ entry, why: "budget" as const, topic: where.get(entry.id)?.topic ?? "General", section: where.get(entry.id)?.section ?? "Deep Memory", archived: slot.savedDate }));
		// These rows open the archive list, and they open it before a single
		// fold runs: the card can show what the room's own size costs while the
		// conversations are still being read. Their rank is their place in this
		// order for now; the pass after the folds ranks them again with the rest.
		run.prepass.demoted.forEach((card, rank) => slot.archiveRows.set(card.id, { ...card, leaving: true, kept: false, instead: false, phase: "before", rank }));
		publishArchiveList(slot, doc);
		doc = demoted.doc;
	}
	touch(slot, nowFn());

	// --- folding ----------------------------------------------------------------
	run.state = "folding";
	touch(slot, nowFn());
	const usage = { input: 0, output: 0, totalTokens: 0, cost: 0 };
	let nextEntryNumber = doc.nextEntryNumber;
	let index = 0;
	for (const view of run.sessions) {
		if (view.outcome !== "pending") continue;
		if (slot.controller.signal.aborted) break;
		const session = slot.sessionsById.get(view.id)!;
		index += 1;
		view.outcome = "folding";
		run.progress.current = { id: view.id, title: view.title };
		touch(slot, nowFn());

		const areas = listAreas(doc);
		const assembly = buildFoldPrompt({
			agentId,
			model: input.model,
			coreContext: coreContextOf(doc),
			areas,
			assessmentMarkdown: input.assessmentMarkdown,
			guidance,
			session: { id: session.id, text: session.text },
			sessionIndex: index,
			sessionCount: run.progress.total,
			now: nowFn(),
		});
		try {
			refuseOversizedMaintenancePrompt({
				agentId,
				processLabel: "Memorize fold",
				model: input.model,
				promptEstimatedTokens: assembly.telemetry.promptEstimatedTokens,
				window: input.resolveModelWindow?.(input.model),
				guidance: "Run Review to shrink stable memory, or switch the maintenance profile to a larger-context model, then Memorize again.",
			});
		} catch (error) {
			view.outcome = "failed";
			view.reason = endsAsSentence((error as Error).message);
			touch(slot, nowFn());
			continue;
		}

		const diagnostics = recordMaintenanceWorkerCalls<AbsorbModelLock, AbsorbGenerateResult>(
			{ roomRootDir: createPersistentAgentInstance(agentId).rootDir, agentId, process: "memorize-fold", roomText: session.text },
			(prompt, model) => input.generate(prompt, model, { signal: slot.controller.signal, timeoutMs: ABSORB_FOLD_TIMEOUT_MS, thinkingLevel: "low" }),
		);

		let prompt = assembly.prompt;
		let ops: FoldOp[] = [];
		let refusals: string[] = [];
		let failed: string | null = null;
		// THE RULE, for one session: two calls — the first, and one retry of a
		// reply the memory refused. A call that never came back at all (a dropped
		// connection, a sign-in that expired, a turn stopped at its ceiling) buys
		// ONE call on top of that, once per session, after a short pause, with the
		// same prompt — because a call that never came back said nothing about
		// this session, and asking again usually lands. So a session costs at most
		// three calls, and never more than one retry of either kind.
		let maxAttempts = 2;
		let retriedAfterThrow = false;
		let firstThrowSentence = "";
		for (let attempt = 1; attempt <= maxAttempts; attempt++) {
			view.attempts = attempt;
			touch(slot, nowFn());
			let generated: AbsorbGenerateResult;
			try {
				generated = await diagnostics.generate(prompt, input.model);
			} catch (error) {
				// A worker failure (timeout, provider error, an aborted turn) costs
				// this one session: its reason is what that failure means for the
				// memory, never the runtime's own sentence, and the loop carries on
				// with the next session.
				const sentence = foldFailureSentence(error);
				// A cancelled run is not a failure to retry: the session goes back to
				// waiting, untouched, and the loop stops below.
				if (slot.controller.signal.aborted) { failed = sentence; break; }
				if (!retriedAfterThrow) {
					retriedAfterThrow = true;
					maxAttempts = 3;
					firstThrowSentence = sentence;
					await foldRetryPause(slot.controller.signal);
					if (slot.controller.signal.aborted) { failed = sentence; break; }
					// The call that never came back is recorded as retried once the
					// retry is actually going to happen; the provider's own words stay
					// on that record either way.
					diagnostics.annotate({ outcome: "retried" });
					continue;
				}
				failed = foldFailureSentenceAfterRetry(firstThrowSentence, sentence);
				break;
			}
			usage.input += generated.usage?.input ?? 0;
			usage.output += generated.usage?.output ?? 0;
			usage.totalTokens += generated.usage?.totalTokens ?? 0;
			usage.cost += generated.usage?.cost ?? 0;
			run.usage = { ...usage };
			if (generated.truncated) {
				failed = truncatedFoldSentence(generated);
				diagnostics.annotate({ outcome: "refused" });
				break;
			}
			const parsed = parseFoldOps(generated.text);
			ops = parsed.ops;
			refusals = parsed.problems.length > 0 ? parsed.problems : validateFoldOps(parsed.ops, areas, { id: session.id, text: session.text });
			if (refusals.length === 0) {
				diagnostics.annotate({ outcome: "accepted" });
				break;
			}
			diagnostics.annotate({ outcome: "refused", validatorErrors: refusals });
			if (attempt >= maxAttempts) break;
			prompt = buildFoldRetryPrompt(assembly.prompt, refusals);
		}

		if (failed) {
			view.outcome = slot.controller.signal.aborted ? "pending" : "failed";
			if (view.outcome === "failed") view.reason = failed;
			touch(slot, nowFn());
			if (slot.controller.signal.aborted) break;
			continue;
		}
		if (refusals.length > 0) {
			view.outcome = "failed";
			view.reason = ABSORB_FOLD_REFUSED_TWICE;
			touch(slot, nowFn());
			continue;
		}

		const applied = applyFoldOps(doc, ops, { sessionId: session.id, savedDate: slot.savedDate, nextEntryNumber });
		doc = applied.doc;
		nextEntryNumber = applied.nextEntryNumber;
		const where = addressBook(doc);
		// The card's counts, from what was APPLIED, never from the model's prose.
		// Whether the session was dropped is the outcome below, not a count, so it
		// does not ride in the summary the card reads.
		const counted = summarizeFold(applied.record);
		view.summary = { added: counted.added, updated: counted.updated, superseded: counted.superseded, closed: counted.closed };
		view.changes = foldChanges(applied.record, where);
		if (applied.record.dropped) {
			view.outcome = "dropped";
			view.reason = endsAsSentence(applied.record.dropped.reason);
		} else {
			view.outcome = "folded";
		}

		collectSupersededArchive(slot, applied.record, doc, where);
		run.progress.folded += 1;
		touch(slot, nowFn());
	}
	run.progress.current = undefined;

	if (slot.controller.signal.aborted) {
		finish(slot, "cancelled", nowFn());
		return;
	}

	// --- budget -------------------------------------------------------------------
	run.state = "budget";
	touch(slot, nowFn());
	// Items the folds closed leave the core in the same run that closed them —
	// "done items leave the core on the next Memorize", and this IS that
	// Memorize. They go before the demotion so the budget numbers the card shows
	// are the numbers the write produces.
	doc = removeClosedItems(slot, doc);
	doc.nextEntryNumber = nextEntryNumber;
	slot.postFoldDoc = doc;
	recomputeDemotion(slot);
	run.state = "ready";
	// A ready run is waiting on a person, and a person can close the tab. Its
	// retention clock starts here, so an abandoned card is reaped like any other
	// finished run instead of holding the room for the life of the process.
	slot.idleSince = Date.now();
	touch(slot, nowFn());
}

function foldChanges(record: FoldRecord, where: Map<string, { section: MemorySection; topic: string }>): AbsorbRunChange[] {
	const topicOf = (id: string) => where.get(id)?.topic ?? "";
	// The add that opened a topic is the one tagged: the applier names each
	// topic it created once, and the first add filed under it is what did it.
	const opened = new Set(record.newTopics);
	return [
		...record.added.map((added) => {
			const newTopic = opened.delete(added.topic);
			return { kind: "added" as const, id: added.id, topic: added.topic, after: added.text, ...(newTopic ? { newTopic: true as const } : {}) };
		}),
		...record.updated.map((change) => ({ kind: "updated" as const, id: change.id, topic: topicOf(change.id), before: change.before, after: change.after })),
		...record.superseded.map((change) => ({ kind: "superseded" as const, id: change.id, topic: topicOf(change.id), before: change.before, after: change.after })),
		...record.closed.map((closed) => ({ kind: "closed" as const, id: closed.id, topic: topicOf(closed.id), before: closed.text })),
		...record.pinned.map((id) => ({ kind: "pinned" as const, id, topic: topicOf(id) })),
	];
}

/**
 * The text an `update` or a `supersede` replaced, on its way to the archive.
 *
 * THE ID RULE: the archived copy keeps the entry's own id with a version suffix
 * — `m-0031-v1`, then `-v2` — because the archive is addressable (a restore
 * looks an entry up by id) and two rows claiming one address would make a
 * restore a coin toss. The suffix reads as what it is: an older version of that
 * entry, kept, findable, and restorable beside the one that replaced it.
 */
function collectSupersededArchive(slot: RunSlot, record: FoldRecord, doc: MemoryDocument, where: Map<string, { section: MemorySection; topic: string }>): void {
	const entryById = new Map(doc.topics.flatMap((topic) => topic.entries.map((entry) => [entry.id, entry] as const)));
	for (const change of [...record.updated, ...record.superseded]) {
		const address = where.get(change.id);
		const current = entryById.get(change.id);
		slot.supersededArchive.push({
			entry: {
				id: nextVersionedEntryId(change.id, slot.supersededArchive.map((append) => append.entry.id)),
				kind: current?.kind ?? "fact",
				saved: current?.saved ?? slot.savedDate,
				pinned: false,
				text: change.before,
				...(current?.from ? { from: current.from } : {}),
			},
			why: "superseded",
			topic: address?.topic ?? "General",
			section: address?.section ?? "Deep Memory",
			archived: slot.savedDate,
		});
	}
}

function removeClosedItems(slot: RunSlot, doc: MemoryDocument): MemoryDocument {
	const next = cloneDocument(doc);
	for (const topic of next.topics) {
		const closed = topic.entries.filter((entry) => entry.status === "done");
		if (closed.length === 0) continue;
		topic.entries = topic.entries.filter((entry) => entry.status !== "done");
		for (const entry of closed) slot.closedArchive.push({ entry, why: "done", topic: topic.title, section: topic.section, archived: slot.savedDate });
	}
	return next;
}

/** A row's topic as the keep route names it, and as `keepTopics` protects it. */
function rowTopicKey(row: { section: MemorySection; topic: string }): string {
	return memoryTopicAddressKey(memoryTopicAddress(row.section, row.topic));
}

/**
 * The archive list as the card reads it, from the rows the run holds: the kept
 * flag and the counts are set here, and the rows are grouped by topic in the
 * document's order with the ones leaving first inside each topic. `doc` is the
 * document the rows were ranked against — it decides the topic order, and a
 * topic it no longer names (none, in practice) goes last.
 */
function publishArchiveList(slot: RunSlot, doc: MemoryDocument): void {
	const run = slot.run;
	const keep = new Set(run.demotion.keepIds);
	const keptTopics = new Set(run.demotion.keepTopics.map(memoryTopicAddressKey));
	const groups = new Map<string, AbsorbRunArchiveRow[]>();
	for (const topic of doc.topics) groups.set(rowTopicKey({ section: topic.section, topic: topic.title }), []);
	for (const row of slot.archiveRows.values()) {
		row.kept = keep.has(row.id) || keptTopics.has(rowTopicKey(row));
		const key = rowTopicKey(row);
		const group = groups.get(key);
		if (group) group.push(row);
		else groups.set(key, [row]);
	}
	const entries: AbsorbRunArchiveRow[] = [];
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
	if (!slot.postFoldDoc) return;
	const budgetTokens = run.budget.budgetTokens;
	const keepIds = [...run.demotion.keepIds];
	const keepTopics = [...run.demotion.keepTopics];
	const keep = new Set(keepIds);
	// The pre-pass entries come BACK first, every one of them: they left so the
	// folds could read a memory under its limit, not because anything was
	// decided about them. The one budget pass below ranks them with everything
	// else against the limit and the keeps as they stand NOW — so a kept one
	// stays, a raised limit keeps the ones that fit, and the rest leave again
	// exactly as the prepass took them, being the least recently touched.
	const doc = restoreEntries(slot.postFoldDoc, slot.prepassArchive.map((append) => ({ ...append.entry, archived: append.archived ?? slot.savedDate, why: append.why, topic: append.topic, section: append.section })));
	const where = addressBook(doc);
	const demoted = demoteToBudget(doc, budgetTokens, { keepIds, keepTopics, today: slot.savedDate });
	const candidate = cloneDocument(demoted.doc);
	// Keeping by id IS pinning: the entry the user kept is the user's own from
	// here on, and no later run's budget pass takes it either. A protected topic
	// is protected today only — the person kept the topic in this run, not
	// forever — so its entries are not pinned.
	for (const topic of candidate.topics) for (const entry of topic.entries) if (keep.has(entry.id)) entry.pinned = true;
	slot.candidateDoc = candidate;
	slot.demotionArchive = demoted.demoted.map((entry) => ({ entry, why: "budget" as const, topic: where.get(entry.id)?.topic ?? "General", section: where.get(entry.id)?.section ?? "Deep Memory", archived: slot.savedDate }));
	const after = reviewTargetTokens(candidate);

	// The stable list. A row entering after the run was ready is leaving in the
	// place of something a person kept, edited or made room for; a row entering
	// during the run's own passes is simply what the folds cost. A row's rank
	// is its place in this pass; a row the pass did not take keeps the last
	// rank it had, so it stays where the person saw it.
	const instead = run.state === "ready";
	const leaving = new Set<string>();
	demoted.demoted.forEach((entry, rank) => {
		leaving.add(entry.id);
		const card = entryCard(entry, where.get(entry.id)?.section ?? "Deep Memory", where.get(entry.id)?.topic ?? "General");
		const row = slot.archiveRows.get(entry.id);
		// The card fields are refreshed too: a note the run wrote can be edited
		// on the card, and the row must read as the note now stands.
		if (row) {
			// A row that stayed in the last pass and leaves again now is leaving in
			// the place of something kept, exactly as a new row would be — unless it
			// stayed because it was kept itself, and its keep was taken back: that row
			// simply leaves again. `kept` still says what the last pass decided.
			const reentering = !row.leaving && !row.kept;
			Object.assign(row, card, { rank });
			if (reentering && instead) row.instead = true;
		} else slot.archiveRows.set(entry.id, { ...card, leaving: true, kept: false, instead, phase: "after", rank });
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
	publishArchiveList(slot, doc);
	run.budget = { ...run.budget, after, budgetTokens, overBudgetAfter: overMemoryBudget(after, budgetTokens), ceilingTokens: MEMORY_BUDGET_MAX_TOKENS };
	run.candidate = { sourceFingerprint: slot.sourceFingerprint, estimatedTokens: estimateTokens(renderMemoryDocument(candidate, "context")) };
}

// --- Reading and adjusting a run -------------------------------------------------

function snapshotRun(slot: RunSlot): AbsorbRun {
	return JSON.parse(JSON.stringify(slot.run)) as AbsorbRun;
}

export function getAbsorbRun(agentIdRaw: string, runId: string): AbsorbRun {
	return snapshotRun(slotFor(createPersistentAgentInstance(agentIdRaw).agentId, runId));
}

/** Whether a run currently holds this room — the same test `propose` refuses on. */
export function hasActiveAbsorbRun(agentIdRaw: string): boolean {
	const agentId = createPersistentAgentInstance(agentIdRaw).agentId;
	forgetExpiredRun(agentId, Date.now());
	const slot = RUNS.get(agentId);
	return Boolean(slot && blocksNewRun(slot.run.state));
}

function requireReady(slot: RunSlot): void {
	if (slot.run.state !== "ready") throw productError("This memory update is not ready to change yet.", "absorb_run_not_ready", 409);
}

/**
 * The keep body as the routes read it: `{ keepIds?, keepTopics? }`, either or
 * both, a missing field leaving that set as it was. A bare list is the older
 * body and means keepIds. An id the list never named is dropped without a
 * word, as it always was; a topic is accepted only when a listed row is under
 * it, and comes back spelled as that row spells it.
 */
export interface AbsorbRunKeepRequest {
	keepIds?: string[];
	keepTopics?: string[];
}

export function parseRunKeepRequest(raw: unknown, rows: Iterable<{ id: string; section: MemorySection; topic: string }>, current: { keepIds: string[]; keepTopics: string[] }, code: string): { keepIds: string[]; keepTopics: string[] } {
	const body: { keepIds?: unknown; keepTopics?: unknown } = Array.isArray(raw) ? { keepIds: raw } : raw && typeof raw === "object" ? (raw as { keepIds?: unknown; keepTopics?: unknown }) : {};
	if (body.keepIds !== undefined && !Array.isArray(body.keepIds)) throw productError("keepIds must be a list of entry ids.", code);
	if (body.keepTopics !== undefined && !Array.isArray(body.keepTopics)) throw productError("keepTopics must be a list of topics.", code);
	if (body.keepIds === undefined && body.keepTopics === undefined) throw productError("keepIds or keepTopics is required.", code);
	const knownIds = new Set<string>(current.keepIds);
	const knownTopics = new Map<string, string>();
	for (const row of rows) {
		knownIds.add(row.id);
		const address = memoryTopicAddress(row.section, row.topic);
		knownTopics.set(memoryTopicAddressKey(address), address);
	}
	const strings = (list: unknown[]) => list.filter((value): value is string => typeof value === "string").map((value) => value.trim()).filter(Boolean);
	const keepIds = body.keepIds === undefined ? current.keepIds : [...new Set(strings(body.keepIds).filter((id) => knownIds.has(id)))];
	const keepTopics = body.keepTopics === undefined
		? current.keepTopics
		: [...new Set(strings(body.keepTopics).map((topic) => knownTopics.get(memoryTopicAddressKey(topic))).filter((topic): topic is string => Boolean(topic)))];
	return { keepIds, keepTopics };
}

/** The card's keep toggles: the kept entries are pinned, the protected topics are left whole, and the demotion is derived again. */
export function keepAbsorbRunEntries(agentIdRaw: string, runId: string, keepRaw: unknown, now = new Date()): AbsorbRun {
	const slot = slotFor(createPersistentAgentInstance(agentIdRaw).agentId, runId);
	requireReady(slot);
	// Every row the list ever held can be kept: the list is this run's whole
	// disclosure of what would leave the core.
	const request = parseRunKeepRequest(keepRaw, slot.archiveRows.values(), slot.run.demotion, "absorb_run_bad_keep");
	slot.run.demotion.keepIds = request.keepIds;
	slot.run.demotion.keepTopics = request.keepTopics;
	recomputeDemotion(slot);
	// Someone is working this card: the retention clock starts again.
	slot.idleSince = Date.now();
	touch(slot, now);
	return snapshotRun(slot);
}

/** The longest a note edited by hand may be: generous, and still a note rather than a page. */
export const ABSORB_RUN_EDIT_MAX_CHARS = 2000;

/**
 * The card's Edit on a note this update adds or rewrites: the person's words
 * replace the model's before anything is saved. Only a note this run wrote is
 * editable here; every other note is edited in Room settings after saving.
 * The budget pass runs again, because a longer or shorter note moves it.
 */
export function editAbsorbRunEntry(agentIdRaw: string, runId: string, entryIdRaw: unknown, textRaw: unknown, now = new Date()): AbsorbRun {
	const slot = slotFor(createPersistentAgentInstance(agentIdRaw).agentId, runId);
	requireReady(slot);
	if (!slot.postFoldDoc) throw productError("This memory update has nothing to edit yet.", "absorb_run_not_ready", 409);
	const entryId = typeof entryIdRaw === "string" ? entryIdRaw.trim() : "";
	const text = typeof textRaw === "string" ? textRaw.trim() : "";
	if (!entryId) throw productError("entryId is required.", "absorb_run_bad_edit");
	if (!text) throw productError("A note cannot be empty. If it should go, delete it from Room settings after saving.", "absorb_run_bad_edit");
	if (text.length > ABSORB_RUN_EDIT_MAX_CHARS) throw productError(`A note is at most ${ABSORB_RUN_EDIT_MAX_CHARS} characters.`, "absorb_run_bad_edit");
	const editable = slot.run.sessions.some((session) => (session.changes ?? []).some((change) => change.id === entryId && (change.kind === "added" || change.kind === "updated" || change.kind === "superseded")));
	if (!editable) throw productError("Only a note this update adds or rewrites can be edited here.", "absorb_run_bad_edit", 404);
	let entry: MemoryEntry | undefined;
	for (const topic of slot.postFoldDoc.topics) for (const candidate of topic.entries) if (candidate.id === entryId) entry = candidate;
	if (!entry) throw productError("That note is not in this update any more.", "absorb_run_bad_edit", 404);
	// A topic written as bullets stays bullets: the person edits the words, not the markup.
	const next = /^[-*]\s/.test(entry.text) && !/^[-*]\s/.test(text) ? `- ${text}` : text;
	entry.text = next;
	for (const session of slot.run.sessions) for (const change of session.changes ?? []) if (change.id === entryId) change.after = next;
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
export function setAbsorbRunBudget(agentIdRaw: string, runId: string, budgetTokensRaw: unknown, now = new Date()): AbsorbRun {
	const slot = slotFor(createPersistentAgentInstance(agentIdRaw).agentId, runId);
	requireReady(slot);
	const budgetTokens = Number(budgetTokensRaw);
	if (!Number.isFinite(budgetTokens) || !Number.isInteger(budgetTokens) || budgetTokens < MEMORY_BUDGET_MIN_TOKENS || budgetTokens > MEMORY_BUDGET_MAX_TOKENS) {
		throw productError(`A room's memory budget is between ${MEMORY_BUDGET_MIN_TOKENS} and ${MEMORY_BUDGET_MAX_TOKENS} tokens.`, "absorb_run_bad_budget");
	}
	slot.run.budget.budgetTokens = budgetTokens;
	recomputeDemotion(slot);
	slot.idleSince = Date.now();
	touch(slot, now);
	return snapshotRun(slot);
}

/** Cancel: the fold in flight is aborted and nothing is written. */
export function cancelAbsorbRun(agentIdRaw: string, runId: string, now = new Date()): AbsorbRun {
	const slot = slotFor(createPersistentAgentInstance(agentIdRaw).agentId, runId);
	if (isActive(slot.run.state)) {
		slot.controller.abort();
		finish(slot, "cancelled", now);
	}
	return snapshotRun(slot);
}

// --- Approval --------------------------------------------------------------------

/**
 * ONE write: the candidate document (post-fold, post-demotion, keeps pinned),
 * Recent Context with the folded, dropped and skipped sessions taken out and
 * the failed and pending ones kept, everything that left the core appended to
 * the archive with its reason, Chronos stamped, and the run's own account in
 * the absorb event record. Anything else that changed the file since the run
 * started makes the run stale, and nothing is written.
 */
export function approveAbsorbRun(agentIdRaw: string, runId: string, now = new Date()): AbsorbRunApprovalResponse {
	const agentId = createPersistentAgentInstance(agentIdRaw).agentId;
	const slot = slotFor(agentId, runId);
	const run = slot.run;
	// The staleness check comes first, and it is what refuses a second approve:
	// the first one wrote the file, so the source this run was built on is no
	// longer the source on disk, and saying "stale" is the truth rather than a
	// special case about runs that were already saved.
	assertAbsorbSourceFingerprintCurrent(slot.sourceFingerprint, createPersistentAgentInstance(agentId).readL1b(), "proposal");
	requireReady(slot);
	const candidate = slot.candidateDoc;
	if (!candidate) throw productError("This memory update has nothing to save.", "absorb_run_empty");

	const removed = new Set(run.sessions.filter((session) => session.outcome === "folded" || session.outcome === "dropped" || session.outcome === "skipped").map((session) => session.id));
	const doc = cloneDocument(candidate);
	doc.recentContext = recentContextWithout(candidate.recentContext, removed);

	// What leaves the core, each with the reason it left. The budget rows are
	// the last pass's, pre-pass entries included: one the user kept, by id or
	// by topic, or one a raised limit made room for, is back in the candidate
	// instead and is not among them.
	const archiveAppend: MemoryArchiveAppend[] = [
		...slot.demotionArchive,
		...slot.supersededArchive,
		...slot.closedArchive,
	];
	const foldedSessions = run.sessions.filter((session) => session.outcome === "folded" || session.outcome === "dropped").map((session) => session.id);
	const remainingSessions = run.sessions.filter((session) => session.outcome === "failed" || session.outcome === "pending").map((session) => session.id);

	run.state = "approving";
	// The write is work: the retention clock stops until it lands or fails.
	slot.idleSince = null;
	touch(slot, now);
	// A limit the card raised becomes the room's setting in this same approval,
	// before the memory write, so the memory that lands is measured against the
	// limit it was built to. A cancelled run never reaches this line.
	// The record says where the limit came from: the first read's raise, which
	// already wrote the setting, or the card's, written here — so an undo takes
	// either back. The setting before the card is what a failed save restores.
	const settingBeforeCard = run.budget.savedBudgetTokens;
	const raisedFrom = slot.limitRaisedFrom ?? settingBeforeCard;
	const budgetRaisedTo = run.budget.budgetTokens !== run.budget.savedBudgetTokens ? run.budget.budgetTokens : undefined;
	const recordsRaise = budgetRaisedTo !== undefined || slot.limitRaisedFrom !== undefined;
	if (budgetRaisedTo !== undefined) {
		writePersistentRoomMaintenanceSettings(agentId, { memoryBudgetTokens: budgetRaisedTo });
		run.budget.savedBudgetTokens = budgetRaisedTo;
	}
	let written;
	try {
		written = writeMemoryDocument(agentId, doc, {
			why: "absorb",
			snapshotLabel: "absorb",
			archiveAppend,
			now,
			stampChronos: (l1b, at, writeId) => updateChronosForAbsorb(l1b, writeId, at),
			writeEventRecord: (recorded) => writeAbsorbRunEventRecord({
				agentId,
				absorbId: recorded.writeId,
				now: recorded.now,
				currentL1b: recorded.currentL1b,
				writtenL1b: recorded.writtenL1b,
				archivedL1bPath: recorded.archivedL1bPath,
				updatedL1bPath: recorded.updatedL1bPath,
				model: slot.model,
				usage: run.usage,
				run: {
					runId: run.runId,
					sessions: run.sessions.map((session) => ({
						id: session.id,
						outcome: session.outcome,
						attempts: session.attempts,
						...(session.reason ? { reason: session.reason } : {}),
						...(session.summary ? { summary: session.summary } : {}),
					})),
					foldedSessions,
					remainingSessions,
					archived: archiveAppend.map((append) => ({ id: append.entry.id, why: append.why, topic: append.topic, section: append.section })),
					budget: { before: run.budget.before, after: run.budget.after, budgetTokens: run.budget.budgetTokens, overBudgetAfter: run.budget.overBudgetAfter, ...(recordsRaise ? { raisedFrom } : {}) },
					...(run.migration?.pending ? { migration: { entriesAssigned: run.migration.entriesAssigned } } : {}),
				},
				warnings: run.warnings,
			}),
		});
	} catch (error) {
		// The card's raise was this save's: a save that did not land leaves the
		// room the limit it had before the card, and the failure says so, so the
		// card is not left showing a limit the room does not have. A first read's
		// raise stays: it was written on purpose. The error keeps its code and status.
		if (budgetRaisedTo !== undefined) {
			writePersistentRoomMaintenanceSettings(agentId, { memoryBudgetTokens: settingBeforeCard });
			run.budget.savedBudgetTokens = settingBeforeCard;
			if (error instanceof Error) error.message = `${error.message} The budget stays at ${formatTokenLimit(settingBeforeCard)}.`;
		}
		run.state = "ready";
		slot.idleSince = Date.now();
		touch(slot, now);
		throw error;
	}

	finish(slot, "saved", now);
	// The write that just landed performed the migration, so the saved card reads
	// it as done rather than as something still owed.
	if (run.migration?.pending) run.migration = { pending: false, entriesAssigned: run.migration.entriesAssigned };
	return {
		agentId,
		writesMemory: true,
		absorbId: written.memoryEditId,
		saveId: written.memoryEditId,
		archivedL1bPath: written.archivedL1bPath,
		updatedL1bPath: written.updatedL1bPath,
		eventRecordPath: written.eventRecordPath,
		eventRelPath: written.eventRelPath,
		recentContextEntryCount: remainingSessions.length,
		memoryBudget: {
			budgetTokens: written.budget.budgetTokens,
			reviewTargetEstimatedTokens: written.budget.reviewTargetTokens,
			overBudget: written.budget.overBudget,
		},
		postAbsorb: { returnToLauncher: true },
		warnings: run.warnings,
		foldedSessions,
		remainingSessions,
		archivedEntries: archiveAppend.length,
		archivedForBudget: archiveAppend.filter((append) => append.why === "budget").length,
		...(budgetRaisedTo === undefined ? {} : { budgetRaisedTo }),
	};
}

/** The status block's v2 fields: what this room would fold and what it would archive first. */
export function absorbRunStatusFields(agentIdRaw: string): {
	version: 2;
	sessions: Array<{ id: string; title: string; date: string; tokens: number }>;
	budget: { reviewTargetTokens: number; budgetTokens: number; overBudget: boolean };
	prepass: { demotionRequired: boolean; entriesOverBudget: number };
} {
	const agentId = createPersistentAgentInstance(agentIdRaw).agentId;
	// A status read never migrates: a room's memory changes when a person asks
	// for it, not when a screen looks at it.
	const loaded = loadMemoryDocument(agentId, { migrate: false });
	const doc = loaded.doc;
	const sessions = recentContextSessions(doc.recentContext).map((session) => ({ id: session.id, title: session.title, date: session.date, tokens: session.tokens }));
	const budgetTokens = readPersistentRoomMaintenanceSettings(agentId).memoryBudgetTokens;
	const tokens = reviewTargetTokens(doc);
	const demotionRequired = overMemoryBudget(tokens, budgetTokens);
	const entriesOverBudget = demotionRequired ? demoteToBudget(doc, budgetTokens, { today: new Date().toISOString().slice(0, 10) }).demoted.length : 0;
	return {
		version: 2,
		sessions,
		budget: { reviewTargetTokens: tokens, budgetTokens, overBudget: demotionRequired },
		prepass: { demotionRequired, entriesOverBudget },
	};
}

/**
 * The propose body. The assessment is the user's first approval point and is
 * required; the discussion's handoff and its source fingerprint ride along as
 * they always have, and the guidance is the structured sign-off every fold call
 * honours. Junk in `guidance` reads as nothing asked for rather than as an
 * error, because a sign-off the parser could not read must not cost the user
 * the run.
 */
export function parseAbsorbRunProposeRequest(raw: any): { assessmentMarkdown: string; guidance: FoldGuidance; sourceFingerprint?: L1bSourceFingerprint; limitRaisedFrom?: number } {
	const assessmentMarkdown = String(raw?.assessmentMarkdown ?? "").trim();
	if (!assessmentMarkdown) throw productError("assessmentMarkdown is required", "absorb_run_no_assessment");
	if (assessmentMarkdown.length > ABSORB_RUN_ASSESSMENT_MAX_CHARS) throw productError("assessmentMarkdown is too large", "absorb_run_assessment_too_large");
	const fingerprint = raw?.source?.l1bFingerprint ?? raw?.source;
	const algorithm = String(fingerprint?.algorithm ?? "").trim();
	const value = String(fingerprint?.value ?? "").trim();
	// A client that sends the sign-off only as its handoff text — the field the
	// discussion has always carried — still gets its instructions honoured: the
	// handoff IS the structured sign-off, so it is read the same way. An explicit
	// `guidance` wins, because that is the one the client itself parsed.
	const handoffText = String(raw?.assessmentHandoff?.text ?? "").trim();
	const guidance = raw?.guidance ? foldGuidanceFromWire(raw.guidance) : handoffText ? parseFoldGuidance(handoffText) : { ...EMPTY_FOLD_GUIDANCE, pin: [], drop: [], corrections: [], topics: [], instructions: [] };
	// The limit the first read raised from: a whole number a room may hold, or
	// nothing. Whether it is below the limit the room holds now is the run's to
	// check, since the room is not known here.
	const limitRaisedFrom = typeof raw?.limitRaisedFrom === "number" && Number.isInteger(raw.limitRaisedFrom) && raw.limitRaisedFrom >= MEMORY_BUDGET_MIN_TOKENS && raw.limitRaisedFrom <= MEMORY_BUDGET_MAX_TOKENS ? raw.limitRaisedFrom : undefined;
	return {
		assessmentMarkdown,
		guidance,
		...(algorithm === "sha256" && /^[a-f0-9]{64}$/i.test(value) ? { sourceFingerprint: { algorithm: "sha256" as const, value: value.toLowerCase() } } : {}),
		...(limitRaisedFrom === undefined ? {} : { limitRaisedFrom }),
	};
}

/** Test seam: the registry is process-local state, and a smoke that drives two rooms must be able to clear it. */
export function resetAbsorbRunsForTests(): void {
	RUNS.clear();
}

/**
 * Test seam: moves a run's retention clock back, so a smoke can prove the
 * reaping an hour of real waiting would otherwise be needed to see. It never
 * deletes anything itself — the run is still there until the next read applies
 * `forgetExpiredRun` to it, which is exactly the path being tested.
 */
export function rewindAbsorbRunClockForTests(agentIdRaw: string, ms: number): void {
	const slot = RUNS.get(createPersistentAgentInstance(agentIdRaw).agentId);
	if (slot && slot.idleSince !== null) slot.idleSince -= ms;
}
