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
// approval write. What does not: the prompt, the grammar, the decision and
// the applier (absorb-ops.ts), the entry model (memory-entries.ts), the files
// (memory-entries-store.ts), and the worker itself (the route injects it).

import {
	applyFoldOps,
	buildFoldPrompt,
	buildFoldUnreadableRetryPrompt,
	decideFoldOps,
	EMPTY_FOLD_GUIDANCE,
	FIRST_READ_NONE,
	foldGuidanceFromWire,
	foldGuidanceToWire,
	parseFoldGuidance,
	parseFoldOps,
	summarizeFold,
	type FoldBesideTag,
	type FoldGuidance,
	type FoldGuidanceWire,
	type FoldOp,
	type FoldRecord,
} from "./absorb-ops.js";
import { pageFailureKey, readPageFailures, writePageFailures } from "./absorb-page-failures.js";
import { connectionDropped, foldPages, prunePageFailureState, type PageDeps, type PageEnding, type PageFailureCode, type PageRead, type PageRetryAsk, type PageTrace, type PagesOutcome } from "./absorb-run-pages.js";
import { rereadModelKey, rereadPage, rereadTriedOn, selectRereads, withTried, type RereadPage } from "./absorb-reread.js";
import { fileSessionAsSummary } from "./absorb-summary.js";
import { ABSORB_EMPTY_RECENT_CONTEXT_PLACEHOLDER, extractRecentContextForAbsorb, parseRecentContextBlocks, recentContextSessions, recentContextWithout, type AbsorbModelLock, type AbsorbRecentContextSession } from "./absorb-consolidation.js";
import {
	cloneDocument,
	demoteToBudget,
	entryTokens,
	listAreas,
	MEMORY_SECTIONS,
	memoryTopicAddress,
	memoryTopicAddressKey,
	hasMustKeepMarker,
	nextVersionedEntryId,
	parseMemoryDocument,
	renderMemoryDocument,
	withoutMustKeepMarkers,
	restoreEntries,
	reviewTargetTokens,
	type MemoryDocument,
	type MemoryEntry,
	type MemorySection,
} from "./memory-entries.js";
import {
	loadMemoryDocument,
	readArchive,
	settleMemoryBudget,
	writeMemoryDocument,
	type MemoryArchiveAppend,
} from "./memory-entries-store.js";
import { textDisagreesWith } from "./memory-duplicates.js";
import { emptyMemoryUse, readMemoryUse, recordMemoryUse, type MemoryUse } from "./memory-use.js";
import { recordMaintenanceWorkerCalls, writeMemorizePageRecord } from "./maintenance-diagnostics.js";
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
/**
 * How a conversation of the run ended. `summarized`: the fold gave nothing
 * usable, so the approved page itself was filed as notes (absorb-summary.ts);
 * it leaves Recent Context on approve like `folded`. `failed`: it waits for
 * next time, which after this slice only a probe-confirmed first failure does.
 */
export type AbsorbRunSessionOutcome = "pending" | "folding" | "folded" | "dropped" | "summarized" | "failed" | "skipped";
/** `history`: an older page's text that disagreed with a newer note, kept in the archive; memory is unchanged, and `after` is the older text. */
export type AbsorbRunChangeKind = "added" | "updated" | "superseded" | "closed" | "pinned" | "history";

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
	/** An add next to a note the person pinned, or one that may disagree with a note: the card tags it and the automatic save waits. Absent otherwise. */
	beside?: FoldBesideTag;
	/** A tagged add: the id of the note it is beside or may disagree with. Never shown. */
	besideOf?: string;
	/** A tagged add: that note's first line as the memory holds it now (a later page may have rewritten it), for the line under the row. */
	besideLine?: string;
	/** A tagged add: the day that note's text was learned, and this note's own, when known, so the person sees which is newer. */
	besideLearned?: string;
	learned?: string;
	/** A tagged add whose other note, or itself, is going to the archive ("leaving"), whose other note this update closes ("closed") or is no longer in memory ("gone"), or that this update closes later itself ("self-closed"): no Replace is offered. */
	besideState?: "leaving" | "gone" | "closed" | "self-closed";
	/** A tagged add the person chose to put in place of the other note: the save gives that note this text. Absent means Keep both. */
	choice?: "replace";
	/** With `choice`: the other note's text when the person chose, which it must still read at the save. */
	choiceText?: string;
	/** superseded: which value replaced which and why, when the old and the new text disagree on a date, a number or a negation. */
	reason?: string;
	/** history: the note the older value yielded to, and its first line as the memory holds it now (absent once it is gone). */
	of?: string;
	ofLine?: string;
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
	/** The person kept it, by id or by topic, for this save only: a keep never pins a note. */
	kept: boolean;
	/** It entered the list after the run was ready — because of a keep, an edit or a limit change — and is leaving in the place of something kept. Cleared when it stops leaving. */
	instead: boolean;
	phase: AbsorbRunArchivePhase;
	/** Position in the demotion order, 0 leaving first. Rows within a topic are sorted by it. */
	rank: number;
	/** Why the ranking put it here, in a person's words: "not touched since 2 Mar, never recalled, 280 tokens". */
	reason: string;
}

export interface AbsorbRunDemotion {
	/** Every note this run ever proposed for the archive, grouped by topic in document order, rank ascending inside; never shortened while the run lives. */
	entries: AbsorbRunArchiveRow[];
	keepIds: string[];
	/** Topics the person protected for this run, as "Section/Title": no note of these leaves. Matched case-insensitively, trimmed. */
	keepTopics: string[];
	overageTokens: number;
	/** Open items the pass left in place while the limit was still not met: they are protected outright, and this is what the protection cost. 0 when the limit was met. */
	protectedOpenItems: number;
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
	/**
	 * The summary notes this run re-reads after its conversations, each row
	 * keyed by the NOTE's id. They are not conversations: nothing that reads the
	 * sessions (the count, Recent Context, the record's sessions) reads these.
	 */
	rereads: AbsorbRunSessionView[];
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
	/**
	 * The run stopped before every conversation was read because the Memory
	 * model was not answering (the probe failed, or the provider named a rate
	 * limit). What finished is on the card; the rest wait, and the card offers
	 * to try again (resume) or to choose another model. Absent otherwise.
	 */
	stop?: { kind: "outage"; model: { provider: string; model: string }; cause: AbsorbRunStopCause };
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
	/** How many of those are a note's old text that a newer one took the place of (a fold's rewrite or a Replace), so the saved screen says them apart. */
	replacedEntries: number;
	/** Older values kept as history: in the archive, but never a note that left memory, so not among `archivedEntries`. */
	historyKept: number;
	/** Summary notes a re-read sorted into topics: archived whole, counted apart, since their words are in memory. */
	sortedNotes: number;
	/** The limit the card raised, written to the room's settings by this save. Absent when the save was made against the saved limit. */
	budgetRaisedTo?: number;
	/**
	 * Conversations remembered while this update was open, in the order they
	 * were saved: the save kept them waiting rather than refusing. Empty when
	 * the file was as the update left it. The saved screen says "N conversations
	 * remembered meanwhile stay waiting" from this; `recentContextEntryCount`
	 * counts them too.
	 */
	rebasedOnto: string[];
}

/** Why an outage stopped the run: the probe went unanswered, or the provider named a rate limit, a quota or an overload. */
export type AbsorbRunStopCause = "not-answering" | "busy";

// --- Bounds and sentences ------------------------------------------------------

/** One fold call's hard ceiling — the same eight minutes every maintenance worker gets. */
export const ABSORB_FOLD_TIMEOUT_MS = 8 * 60 * 1000;
/** A finished run stays readable this long, so a client that polls late still sees how it ended. */
export const ABSORB_RUN_RETENTION_MS = 60 * 60 * 1000;
/** The assessment's own cap, the same one the assessment screen accepts: a longer one runs without a first read. */
export const ABSORB_RUN_ASSESSMENT_MAX_CHARS = 20_000;
/**
 * The wait before a call that never came back is asked again.
 *
 * Long enough for the blip that killed the first one to pass, short enough to
 * be nothing beside the eight minutes that call was allowed to take.
 */
export const ABSORB_FOLD_RETRY_PAUSE_MS = 2_000;

/**
 * One fold call's output cap. A fold is a handful of operations; the cap stops
 * a runaway reply, and the reader salvages its last complete fence. It is
 * inert on the ChatGPT subscription, whose request carries no output field.
 */
export const ABSORB_FOLD_MAX_OUTPUT_TOKENS = 16_000;
/** The probe's own ceiling: a two-word answer, so far short of the fold's eight minutes. */
export const ABSORB_PROBE_TIMEOUT_MS = 45_000;
/** The probe's one fixed prompt, so its diagnostics records compare across runs. */
export const ABSORB_PROBE_PROMPT = "Reply with OK";

/**
 * The failure reasons a session that WAITS carries. Each is ONE cause
 * sentence, ending in a full stop; the consequence ("It stays for next time.")
 * belongs to the screen, which appends it to every failure reason alike, so
 * the two halves are never written twice or in two voices.
 */
/** The turn was stopped: its own eight-minute ceiling, or a stall the ceiling caught. */
export const ABSORB_FOLD_TIMED_OUT = "The model did not answer within the time limit, so this session waits for the next update.";
/** The connection dropped mid-turn ("terminated", a reset socket, a failed fetch). */
export const ABSORB_FOLD_CONNECTION_LOST = "The connection to the model dropped while this session was being added, so it waits for the next update.";
/** Anything else the call threw: a provider error such as a content filter or a refused request. A person is told what it means for their memory, not what the stack said. */
export const ABSORB_FOLD_WORKER_FAILED = "The model could not add this session this time, so it waits for the next update.";

/**
 * The two causes that are asked again, when the second call failed the same
 * way as the first.
 *
 * A call that never came back is asked again, so the sentence a person reads
 * has to say which of the two happened. "Twice" is the whole difference: it
 * says the thing was tried again rather than given up on, and it says a second
 * ask will not be what fixes it. These end on the cause alone, so the screen
 * adds "It stays for next time." to them as it does to every other cause. A
 * timeout has no twice wording: a call that ran the whole eight minutes is not
 * asked for another eight, so its one-off sentence is the only one.
 */
export const ABSORB_FOLD_CONNECTION_LOST_TWICE = "The connection dropped twice while memorizing this conversation.";
export const ABSORB_FOLD_WORKER_FAILED_TWICE = "The model could not add this conversation, twice.";

/** One cause, in its one-off wording and in its twice wording. */
const FOLD_FAILURE_TWICE = new Map<string, string>([
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
 * meant to be read by whoever is fixing it. The worker tells only "error" from
 * "aborted", so a dropped connection is told apart by its words; any other
 * provider error (a content filter, a refused request) is not a connection.
 */
function foldFailureSentence(error: unknown): string {
	if (error instanceof IsolatedPersistentAgentWorkerTurnError) {
		if (error.stopReason === "aborted") return ABSORB_FOLD_TIMED_OUT;
		return connectionDropped(error.providerMessage ?? "") ? ABSORB_FOLD_CONNECTION_LOST : ABSORB_FOLD_WORKER_FAILED;
	}
	return ABSORB_FOLD_WORKER_FAILED;
}


/**
 * Whether a failed call is worth asking again. A dropped connection, an
 * expired sign-in or a provider error said nothing about the session, and
 * asking again usually lands. A turn the eight-minute ceiling stopped is the
 * opposite: the model had the whole ceiling and did not finish, so a second ask
 * is another eight minutes spent the same way, and the run would take a quarter
 * of an hour on one session before it moved on. That session waits for next
 * time after one call.
 */
function foldFailureRetryable(error: unknown): boolean {
	return !(error instanceof IsolatedPersistentAgentWorkerTurnError && error.stopReason === "aborted");
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

/** The long pause (a rate limit's or a blip's) as a smoke sets it: null waits the real one (20 to 60 seconds). */
let rateLimitPauseOverrideMs: number | null = null;

/** Test seam: the wait before a rate-limited fold call, or one that hit a blip, is asked again, in milliseconds, or null for the real one. */
export function setAbsorbFoldRateLimitPauseForTests(ms: number | null): void {
	rateLimitPauseOverrideMs = ms === null ? null : Math.max(0, ms);
}

/** Waits out a retry pause (the short one, or `longMs` for a rate limit or a blip), and gives it up the moment the run is cancelled. */
function foldRetryPause(signal: AbortSignal, longMs?: number): Promise<void> {
	const pauseMs = longMs === undefined ? foldRetryPauseMs : rateLimitPauseOverrideMs ?? longMs;
	if (pauseMs <= 0 || signal.aborted) return Promise.resolve();
	return new Promise<void>((resolve) => {
		const done = () => {
			clearTimeout(timer);
			signal.removeEventListener("abort", done);
			resolve();
		};
		const timer = setTimeout(done, pauseMs);
		signal.addEventListener("abort", done);
	});
}

/** What a failed call's error says about the page's record: its own ceiling, the provider, or anything else. */
function foldFailureCode(error: unknown): PageFailureCode {
	if (error instanceof IsolatedPersistentAgentWorkerTurnError) return error.stopReason === "aborted" ? "timed-out" : "provider-error";
	return "worker-failed";
}

export { connectionDropped };

/** The provider's own words for a failure, which the outage rule reads. Never shown to a person. */
function foldFailureMessage(error: unknown): string {
	if (error instanceof IsolatedPersistentAgentWorkerTurnError) return error.providerMessage ?? error.message;
	return (error as Error)?.message ?? String(error);
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

// --- The ranking's inputs and outputs ---------------------------------------------

/** An archive append that came out of the ranking carries the reason the ranking gave; a superseded text carries one when the old and the new text disagree on a value, and a closed item carries none. */
export type RankedArchiveAppend = MemoryArchiveAppend & { reason?: string };

/** The room's recall counter, as the budget pass ranks by it. A counter that cannot be read must not stop a save: it reads as no use. */
export function memoryUseForRanking(agentId: string): MemoryUse {
	try {
		return readMemoryUse(agentId);
	} catch {
		return emptyMemoryUse();
	}
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

// --- The run's private state ----------------------------------------------------

export type AbsorbRunGenerate = (
	prompt: string,
	model: AbsorbModelLock,
	/** The fold is a single-shot transform: it asks for low reasoning, so reasoning tokens do not starve the reply under its output cap. */
	options: { signal: AbortSignal; timeoutMs: number; thinkingLevel: "low"; maxTokens: number },
) => Promise<AbsorbGenerateResult>;

/** The probe's call: the fixed question on the same model, with its own short ceiling, at low reasoning so a reasoning model does not think its way to that ceiling. */
export type AbsorbRunProbe = (prompt: string, model: AbsorbModelLock, options: { signal: AbortSignal; timeoutMs: number; thinkingLevel: "low" }) => Promise<AbsorbGenerateResult>;

export interface AbsorbRunStartInput {
	agentId: string;
	assessmentMarkdown: string;
	guidance?: FoldGuidance;
	model: AbsorbModelLock;
	generate: AbsorbRunGenerate;
	/**
	 * Asks the Memory model the tiny fixed question when a fold call failed, to
	 * tell a page's failure from an outage. Absent (a smoke that scripts no
	 * probe), the model reads as answering.
	 */
	probe?: AbsorbRunProbe;
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
	/** The file as it stood when the run read it — what approve compares the file on disk against, section by section, when the fingerprint no longer matches. */
	sourceL1b: string;
	/** The ids the room's archive already held when the run started, so a version id this run mints is unique across runs and not only within this one. */
	archiveIds: string[];
	/** The limit before the first read raised it; the save records it as where the raise came from. */
	limitRaisedFrom: number | undefined;
	sessionsById: Map<string, AbsorbRecentContextSession>;
	/** The document as it stands after the folds and after closed items left — what keep/budget recompute from. */
	postFoldDoc: MemoryDocument | null;
	/** The document as it will be written: post-fold, post-demotion, the kept notes back in. */
	candidateDoc: MemoryDocument | null;
	/** What the prepass took, so the folds read a memory under its limit. Every recompute puts these back and ranks them again; what still leaves is in `demotionArchive`. */
	prepassArchive: RankedArchiveAppend[];
	/** The texts the folds replaced; a row whose old and new text disagree on a value carries the reason the new one won. */
	supersededArchive: RankedArchiveAppend[];
	/** The older values the folds kept as history: an older page's text that disagreed with a newer note. */
	historyArchive: MemoryArchiveAppend[];
	/** The summary notes a re-read sorted, each archived whole: its row is the only full copy of the page. */
	sortedArchive: MemoryArchiveAppend[];
	/** The Memory models, by note id, whose re-read of a summary note ended with an answer: the save writes them into `tried`. */
	rereadTried: Map<string, Set<string>>;
	/** How many re-read pages this run has started: the prompt's "N of M" for them. */
	rereadsStarted: number;
	closedArchive: MemoryArchiveAppend[];
	demotionArchive: RankedArchiveAppend[];
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
	/** What the run was started with: a resume folds the waiting pages with the same model, first read and guidance. */
	input: AbsorbRunStartInput;
	guidance: FoldGuidance;
	/** The working document while pages fold, and its id counter. */
	workingDoc: MemoryDocument | null;
	nextEntryNumber: number;
	/** The kept notes a resume pinned for its folds only: a change to one is added beside it, untagged, since the person kept it and did not pin it. */
	keptForFolds?: Set<string>;
	/** How many pages this run has started, across a resume: the prompt's "session N of M". */
	pagesStarted: number;
	usage: { input: number; output: number; totalTokens: number; cost: number };
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

/** Ends the run. A run that ended has nothing left to try again, so an outage stop goes with it. */
function finish(slot: RunSlot, state: AbsorbRunState, now: Date, error?: string): void {
	slot.run.state = state;
	delete slot.run.stop;
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
		rereads: [],
		prepass: { demoted: [] },
		budget: { before: 0, after: 0, budgetTokens: savedBudgetTokens, savedBudgetTokens, overBudgetAfter: false, ceilingTokens: MEMORY_BUDGET_MAX_TOKENS },
		demotion: { entries: [], keepIds: [], keepTopics: [], overageTokens: 0, protectedOpenItems: 0, counts: { leaving: 0, kept: 0, instead: 0, staying: 0 } },
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
		sourceL1b: "",
		archiveIds: [],
		limitRaisedFrom: input.limitRaisedFrom !== undefined && input.limitRaisedFrom < savedBudgetTokens ? input.limitRaisedFrom : undefined,
		sessionsById: new Map(),
		postFoldDoc: null,
		candidateDoc: null,
		prepassArchive: [],
		supersededArchive: [],
		historyArchive: [],
		sortedArchive: [],
		rereadTried: new Map(),
		rereadsStarted: 0,
		closedArchive: [],
		demotionArchive: [],
		archiveRows: new Map(),
		idleSince: null,
		work: null,
		input,
		guidance: input.guidance ?? { ...EMPTY_FOLD_GUIDANCE, pin: [], drop: [], corrections: [], topics: [], instructions: [] },
		workingDoc: null,
		nextEntryNumber: 0,
		pagesStarted: 0,
		usage: { input: 0, output: 0, totalTokens: 0, cost: 0 },
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
	const guidance = slot.guidance;

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
	slot.sourceL1b = currentL1b;
	// The archive's ids are read once, here: an entry rewritten in an earlier
	// run already has its `-v1` row there, and the row this run archives for the
	// same entry must be `-v2`, not a second `-v1` that a restore could not tell
	// from the first.
	slot.archiveIds = readArchive(agentId).map((entry) => entry.id);
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

	// The pins the person asked for in the discussion are applied to the
	// working document first, so the prepass demotion below can never take one:
	// a pin is the person's own.
	const pinIds = new Set(guidance.pin);
	if (pinIds.size > 0) {
		doc = cloneDocument(doc);
		for (const topic of doc.topics) for (const entry of topic.entries) if (pinIds.has(entry.id)) entry.pinned = true;
	}

	const budgetTokens = run.budget.budgetTokens;
	run.budget.before = reviewTargetTokens(doc);
	if (run.budget.before > budgetTokens) {
		const where = addressBook(doc);
		const demoted = demoteToBudget(doc, budgetTokens, { today: slot.savedDate, use: memoryUseForRanking(agentId) });
		run.prepass.demoted = demoted.demoted.map((entry) => entryCard(entry, where.get(entry.id)?.section ?? "Deep Memory", where.get(entry.id)?.topic ?? "General"));
		slot.prepassArchive = demoted.demoted.map((entry) => ({ entry, why: "budget" as const, topic: where.get(entry.id)?.topic ?? "General", section: where.get(entry.id)?.section ?? "Deep Memory", archived: slot.savedDate, reason: entry.reason }));
		run.demotion.protectedOpenItems = demoted.protectedOpenItems;
		// These rows open the archive list, and they open it before a single
		// fold runs: the card can show what the room's own size costs while the
		// conversations are still being read. Their rank is their place in this
		// order for now; the pass after the folds ranks them again with the rest.
		demoted.demoted.forEach((entry, rank) => slot.archiveRows.set(entry.id, { ...run.prepass.demoted[rank], leaving: true, kept: false, instead: false, phase: "before", rank, reason: entry.reason }));
		publishArchiveList(slot, doc);
		doc = demoted.doc;
	}
	// The summary notes this run re-reads are chosen now, from the memory the
	// folds start from: a note the prepass sent to the archive is not read, as
	// the budget pass would bring it back whole, and a conversation this run
	// files as its summary waits for a later run. They ride only on a run that
	// has a conversation to read.
	if (run.progress.total > 0) {
		run.rereads = selectRereads(doc, input.model).flatMap((note) => {
			const page = rereadPage(doc, note.id);
			return page ? [{ id: page.id, title: page.title, date: page.date, outcome: "pending" as const, attempts: 0 }] : [];
		});
	}
	touch(slot, nowFn());

	// --- folding ----------------------------------------------------------------
	run.state = "folding";
	touch(slot, nowFn());
	slot.workingDoc = doc;
	slot.nextEntryNumber = doc.nextEntryNumber;
	await foldWaitingPages(slot, nowFn);
	if (slot.controller.signal.aborted) {
		finish(slot, "cancelled", nowFn());
		return;
	}
	settleRun(slot, nowFn);
}

/**
 * The budget pass after the folds, and the run is ready: items the folds
 * closed leave the core, the demotion is derived, and the card waits on a
 * person.
 */
function settleRun(slot: RunSlot, nowFn: () => Date): void {
	const run = slot.run;
	run.state = "budget";
	touch(slot, nowFn());
	// Items the folds closed leave the core in the same run that closed them —
	// "done items leave the core on the next Memorize", and this IS that
	// Memorize. They go before the demotion so the budget numbers the card shows
	// are the numbers the write produces.
	const doc = removeClosedItems(slot, slot.workingDoc!);
	doc.nextEntryNumber = slot.nextEntryNumber;
	slot.postFoldDoc = doc;
	slot.workingDoc = null;
	recomputeDemotion(slot);
	run.state = "ready";
	// A ready run is waiting on a person, and a person can close the tab. Its
	// retention clock starts here, so an abandoned card is reaped like any other
	// finished run instead of holding the room for the life of the process.
	slot.idleSince = Date.now();
	touch(slot, nowFn());
}

/** The applier the run calls; a smoke swaps it to prove an apply that throws costs one page, not the run. */
let applyFold: typeof applyFoldOps = applyFoldOps;

/** Test seam: the fold applier, or null for the real one. */
export function setAbsorbFoldApplyForTests(apply: typeof applyFoldOps | null): void {
	applyFold = apply ?? applyFoldOps;
}

/** The sentence a waiting page carries: its failure, said "twice" when the retried call failed the same way. */
function waitingSentence(sentences: string[]): string {
	if (sentences.length === 0) return ABSORB_FOLD_WORKER_FAILED;
	if (sentences.length === 1) return sentences[0];
	return foldFailureSentenceAfterRetry(sentences[0], sentences[sentences.length - 1]);
}

interface RunPage {
	view: AbsorbRunSessionView;
	/** A re-read's session is its note's: the note id, its text and its learned day, never a Recent Context entry. */
	session: AbsorbRecentContextSession;
	/** Set on a summary note's re-read: the note, and the memory without it that its fold reads and applies to. */
	reread?: RereadPage;
}

/** The records a re-read page never carries: it is not a conversation, so it holds no failure record and no throttle note. */
const NO_PAGE_RECORDS = { records: new Map(), throttled: new Map() };

/** The key a page's record is written under; a re-read's can never be a conversation's. */
function runPageKey(page: RunPage): string {
	return page.reread ? `reread:${page.view.id}` : pageFailureKey(page.session);
}

/**
 * Folds every page still waiting on the card through the page core
 * (absorb-run-pages.ts), which decides how each one ends. This function owns
 * what the core does not: the prompts, the working document, the card rows,
 * the diagnostics and the records file. A resume calls it again on the pages
 * an outage left waiting.
 */
async function foldWaitingPages(slot: RunSlot, nowFn: () => Date): Promise<PagesOutcome> {
	const run = slot.run;
	const input = slot.input;
	const agentId = run.agentId;
	const instance = createPersistentAgentInstance(agentId);
	const signal = slot.controller.signal;
	const pages: RunPage[] = run.sessions.filter((view) => view.outcome === "pending").map((view) => ({ view, session: slot.sessionsById.get(view.id)! }));
	const records = prunePageFailureState(readPageFailures(instance.runtimeDir()), [...slot.sessionsById.values()].map(pageFailureKey));
	// A window that cannot be looked up is unknown, never a reason on the card.
	let window: CheckpointModelWindow | undefined;
	try {
		window = input.resolveModelWindow?.(input.model);
	} catch {
		window = undefined;
	}
	let current: { page: RunPage; areas: ReturnType<typeof listAreas>; prompt: string; promptEstimatedTokens: number; diagnostics: ReturnType<typeof recordMaintenanceWorkerCalls<AbsorbModelLock, AbsorbGenerateResult>>; throwSentences: string[] } | null = null;
	const at = () => current!;

	/** Runs one change to the working copy, and puts the copy back as it was when the change throws. */
	const changeWorkingCopy = <T>(page: RunPage, change: () => T): T => {
		const before = { doc: slot.workingDoc, next: slot.nextEntryNumber, superseded: slot.supersededArchive.length, history: slot.historyArchive.length, sorted: slot.sortedArchive.length };
		try {
			return change();
		} catch (error) {
			slot.workingDoc = before.doc;
			slot.nextEntryNumber = before.next;
			slot.supersededArchive.length = before.superseded;
			slot.historyArchive.length = before.history;
			slot.sortedArchive.length = before.sorted;
			delete page.view.summary;
			delete page.view.changes;
			delete page.view.reason;
			throw error;
		}
	};
	/** A page's changes, counted from what was APPLIED, never from the model's prose. */
	const commit = (page: RunPage, applied: { doc: MemoryDocument; record: FoldRecord; nextEntryNumber: number }) => {
		const where = addressBook(applied.doc);
		const counted = summarizeFold(applied.record);
		page.view.summary = { added: counted.added, updated: counted.updated, superseded: counted.superseded, closed: counted.closed };
		page.view.changes = foldChanges(applied.record, where);
		collectSupersededArchive(slot, applied.record, applied.doc, where);
		for (const row of applied.record.history) slot.historyArchive.push({ entry: { id: row.id, kind: row.kind, saved: slot.savedDate, from: applied.record.sessionId, pinned: false, text: row.text, ...(row.learned ? { learned: row.learned } : {}) }, why: "history", until: row.until, topic: row.topic, section: row.section, archived: slot.savedDate });
		slot.workingDoc = applied.doc;
		slot.nextEntryNumber = applied.nextEntryNumber;
	};

	const rereadKey = rereadModelKey(input.model);
	const deps: PageDeps<RunPage> = {
		key: runPageKey,
		model: input.model,
		now: nowFn,
		cancelled: () => signal.aborted,
		onPageStart: (page) => {
			if (page.reread) slot.rereadsStarted += 1;
			else slot.pagesStarted += 1;
			page.view.outcome = "folding";
			run.progress.current = { id: page.view.id, title: page.view.title };
			// A re-read reads memory without its own note, so what it gives back is never the same as the note.
			const doc = page.reread?.doc ?? slot.workingDoc!;
			const areas = listAreas(doc);
			const assembly = buildFoldPrompt({
				agentId,
				model: input.model,
				coreContext: coreContextOf(doc),
				areas,
				assessmentMarkdown: input.assessmentMarkdown,
				guidance: slot.guidance,
				session: { id: page.session.id, text: page.session.text, date: page.session.date },
				// A re-read counts among the re-reads, never among the conversations.
				sessionIndex: page.reread ? slot.rereadsStarted : slot.pagesStarted,
				sessionCount: page.reread ? run.rereads.length : run.progress.total,
				now: nowFn(),
			});
			const diagnostics = recordMaintenanceWorkerCalls<AbsorbModelLock, AbsorbGenerateResult>(
				{ roomRootDir: instance.rootDir, agentId, process: "memorize-fold", roomText: page.session.text },
				(prompt, model) => input.generate(prompt, model, { signal, timeoutMs: ABSORB_FOLD_TIMEOUT_MS, thinkingLevel: "low", maxTokens: ABSORB_FOLD_MAX_OUTPUT_TOKENS }),
			);
			current = { page, areas, prompt: assembly.prompt, promptEstimatedTokens: assembly.telemetry.promptEstimatedTokens, diagnostics, throwSentences: [] };
			touch(slot, nowFn());
		},
		onAttempt: (page, attempt) => {
			page.view.attempts = attempt;
			touch(slot, nowFn());
		},
		oversize: () => {
			try {
				refuseOversizedMaintenancePrompt({ agentId, processLabel: "Memorize fold", model: input.model, promptEstimatedTokens: at().promptEstimatedTokens, window, guidance: "" });
				return false;
			} catch {
				return true;
			}
		},
		call: async (_page, retry: PageRetryAsk | null) => {
			const base = at().prompt;
			const prompt = retry === null ? base : buildFoldUnreadableRetryPrompt(base, retry.cutOff);
			let generated: AbsorbGenerateResult;
			try {
				generated = await at().diagnostics.generate(prompt, input.model);
			} catch (error) {
				at().throwSentences.push(foldFailureSentence(error));
				throw error;
			}
			slot.usage.input += generated.usage?.input ?? 0;
			slot.usage.output += generated.usage?.output ?? 0;
			slot.usage.totalTokens += generated.usage?.totalTokens ?? 0;
			slot.usage.cost += generated.usage?.cost ?? 0;
			run.usage = { ...slot.usage };
			return { text: generated.text, ...(generated.truncated ? { truncated: true } : {}) };
		},
		read: (page, reply): PageRead => {
			const parsed = parseFoldOps(reply.text, { truncated: reply.truncated });
			if (parsed.unreadable) {
				at().diagnostics.annotate({ outcome: "refused", validatorErrors: parsed.problems });
				return { usable: false, unreadable: parsed.unreadable };
			}
			const decided = decideFoldOps(parsed.items, at().areas, page.session, slot.keptForFolds ? { keptForFolds: slot.keptForFolds } : {});
			at().diagnostics.annotate({ outcome: decided.landed ? "accepted" : "refused", fold: { ops: decided.decisions.map(({ index, op, fate, codes }) => ({ i: index, op, fate, ...(codes.length > 0 ? { codes } : {}) })), pairs: decided.pairs } });
			const earlier = parsed.earlierFence ? { earlierFence: true as const } : {};
			return decided.landed ? { usable: true, ops: decided.ops, ...earlier } : { usable: false, nothingLands: true, ...earlier };
		},
		apply: (page, ops) => changeWorkingCopy(page, () => {
			const reread = page.reread;
			if (reread) {
				// Its notes say they came from the note's conversation, and carry its day.
				const applied = applyFold(reread.doc, ops as FoldOp[], { sessionId: reread.from ?? "", savedDate: slot.savedDate, nextEntryNumber: slot.nextEntryNumber, ...(reread.date ? { sessionDate: reread.date } : {}) });
				// A lone drop sorts nothing: the note stays where it was.
				if (applied.record.dropped) {
					page.view.reason = endsAsSentence(applied.record.dropped.reason);
					return "dropped";
				}
				// Sorted: memory is the fold's, without the note, and the save
				// archives the note whole, so what the reply did not give back
				// stays restorable.
				commit(page, applied);
				const { disagrees: _pair, ...note } = reread.note;
				slot.sortedArchive.push({ entry: note, why: "sorted", topic: reread.topic, section: reread.section, archived: slot.savedDate });
				// A note it was kept beside no longer names it: the pair is the
				// point it gave back, which the save marks again when it is kept.
				for (const topic of slot.workingDoc!.topics) {
					for (const entry of topic.entries) {
						if (!entry.disagrees) continue;
						const others = entry.disagrees.split(",").filter((id) => id !== reread.id);
						if (others.length > 0) entry.disagrees = others.join(",");
						else delete entry.disagrees;
					}
				}
				return "folded";
			}
			const session = page.session;
			const applied = applyFold(slot.workingDoc!, ops as FoldOp[], { sessionId: session.id, savedDate: slot.savedDate, nextEntryNumber: slot.nextEntryNumber, ...(session.date ? { sessionDate: session.date } : {}) });
			commit(page, applied);
			if (!applied.record.dropped) return "folded";
			page.view.reason = endsAsSentence(applied.record.dropped.reason);
			return "dropped";
		}),
		fileSummary: (page) => changeWorkingCopy(page, () => {
			// A summary is never filed as a summary of itself: the note stays.
			if (page.reread) return;
			const session = page.session;
			commit(page, fileSessionAsSummary(slot.workingDoc!, { id: session.id, title: session.title, text: session.text }, { savedDate: slot.savedDate, nextEntryNumber: slot.nextEntryNumber, ...(session.date ? { sessionDate: session.date } : {}) }));
		}),
		probe: async () => {
			const probe = input.probe;
			if (!probe) return true;
			const diagnostics = recordMaintenanceWorkerCalls<AbsorbModelLock, AbsorbGenerateResult>(
				{ roomRootDir: instance.rootDir, agentId, process: "memorize-probe" },
				(prompt, model) => probe(prompt, model, { signal, timeoutMs: ABSORB_PROBE_TIMEOUT_MS, thinkingLevel: "low" }),
			);
			try {
				await diagnostics.generate(ABSORB_PROBE_PROMPT, input.model);
				return true;
			} catch {
				return false;
			}
		},
		retryable: foldFailureRetryable,
		failureMessage: foldFailureMessage,
		failureCode: foldFailureCode,
		pause: async (longMs) => {
			// The call that never came back is recorded as retried once the retry
			// is actually going to happen; the provider's own words stay on it.
			at().diagnostics.annotate({ outcome: "retried" });
			await foldRetryPause(signal, longMs);
		},
		onPageEnd: (page, ending: PageEnding, trace: PageTrace) => {
			const view = page.view;
			switch (ending.kind) {
				case "folded":
				case "dropped":
				case "summarized":
					view.outcome = ending.kind;
					if (ending.kind !== "dropped") delete view.reason;
					if (!page.reread) run.progress.folded += 1;
					break;
				case "waiting":
					view.outcome = "failed";
					view.reason = ending.reason === "first-failure" ? waitingSentence(at().throwSentences) : ABSORB_FOLD_WORKER_FAILED;
					break;
				case "outage":
				case "cancelled":
					// Neither is the page's doing: it goes back to waiting, untouched.
					view.outcome = "pending";
					delete view.reason;
					break;
			}
			// The model answered for this note, or its size is too large for it: the
			// save records that it tried. An outage or a cancel tried nothing.
			if (page.reread && rereadTriedOn(ending)) {
				const models = slot.rereadTried.get(view.id) ?? new Set<string>();
				models.add(rereadKey);
				slot.rereadTried.set(view.id, models);
			}
			writeMemorizePageRecord({
				roomRootDir: instance.rootDir,
				agentId,
				model: input.model,
				at: nowFn(),
				page: {
					key: runPageKey(page),
					outcome: ending.kind === "outage" ? "outage-stop" : ending.kind,
					...("reason" in ending ? { reason: ending.reason } : {}),
					...(trace.unreadable ? { unreadable: trace.unreadable } : {}),
					...(trace.unusable ? { unusable: trace.unusable } : {}),
					...(trace.reader ? { reader: trace.reader } : {}),
					attempts: trace.attempts,
					...(trace.probe ? { probe: trace.probe } : {}),
					...(trace.outageClass ? { outageClass: trace.outageClass } : {}),
					...(trace.failureCode ? { failureCode: trace.failureCode } : {}),
				},
			});
			touch(slot, nowFn());
		},
		flush: (held) => {
			// A record file that cannot be written costs the next run its hint,
			// never this run.
			try {
				writePageFailures(instance.runtimeDir(), held);
			} catch {}
		},
	};
	let outcome = await foldPages<RunPage>(pages, records, deps);
	// The summary notes to re-read come after every conversation, in a pass of
	// their own with no records, so a re-read never takes a conversation's place
	// or leaves a record. Each page is made from memory as it stands when its
	// turn comes: a note an earlier page superseded or closed is not read, and
	// one this model tried already (a resume on another model) is not read again.
	if (!outcome.stoppedForOutage && !outcome.cancelled) {
		for (const view of run.rereads.filter((row) => row.outcome === "pending")) {
			if (signal.aborted) break;
			const reread = rereadPage(slot.workingDoc!, view.id);
			if (!reread || (reread.note.tried ?? []).includes(rereadKey)) {
				run.rereads = run.rereads.filter((row) => row !== view);
				continue;
			}
			const session: AbsorbRecentContextSession = { id: reread.id, title: reread.title, date: reread.date, text: reread.text, tokens: estimateTokens(reread.text) };
			outcome = await foldPages<RunPage>([{ view, session, reread }], NO_PAGE_RECORDS, { ...deps, flush: () => {} });
			if (outcome.stoppedForOutage || outcome.cancelled) break;
		}
	}
	run.progress.current = undefined;
	if (outcome.stoppedForOutage) run.stop = { kind: "outage", model: { provider: input.model.provider, model: input.model.model }, cause: outcome.outageClass ? "busy" : "not-answering" };
	return outcome;
}

function foldChanges(record: FoldRecord, where: Map<string, { section: MemorySection; topic: string }>): AbsorbRunChange[] {
	const topicOf = (id: string) => where.get(id)?.topic ?? "";
	// The add that opened a topic is the one tagged: the applier names each
	// topic it created once, and the first add filed under it is what did it.
	const opened = new Set(record.newTopics);
	return [
		...record.added.map((added) => {
			const newTopic = opened.delete(added.topic);
			return { kind: "added" as const, id: added.id, topic: added.topic, after: added.text, ...(newTopic ? { newTopic: true as const } : {}), ...(added.beside ? { beside: added.beside, ...(added.besideOf ? { besideOf: added.besideOf } : {}) } : {}) };
		}),
		...record.updated.map((change) => ({ kind: "updated" as const, id: change.id, topic: topicOf(change.id), before: change.before, after: change.after })),
		...record.superseded.map((change) => ({ kind: "superseded" as const, id: change.id, topic: topicOf(change.id), before: change.before, after: change.after, ...(change.reason ? { reason: change.reason } : {}) })),
		...record.closed.map((closed) => ({ kind: "closed" as const, id: closed.id, topic: topicOf(closed.id), before: closed.text })),
		...record.pinned.map((id) => ({ kind: "pinned" as const, id, topic: topicOf(id) })),
		...record.history.map((row) => ({ kind: "history" as const, id: row.id, topic: row.topic, after: row.text, of: row.of })),
	];
}

/**
 * The text an `update` or a `supersede` replaced, on its way to the archive.
 *
 * THE ID RULE: the archived copy keeps the entry's own id with a version suffix
 * — `m-0031-v1`, then `-v2` — because the archive is addressable (a restore
 * looks an entry up by id) and two rows claiming one address would make a
 * restore a coin toss. The suffix reads as what it is: an older version of that
 * entry, kept, findable, and restorable beside the one that replaced it. The
 * taken ids are the archive's as it stood when the run started PLUS this run's
 * own rows: an entry rewritten in two runs gets `-v1` in the first and `-v2` in
 * the second, never `-v1` twice.
 */
function collectSupersededArchive(slot: RunSlot, record: FoldRecord, doc: MemoryDocument, where: Map<string, { section: MemorySection; topic: string }>): void {
	const entryById = new Map(doc.topics.flatMap((topic) => topic.entries.map((entry) => [entry.id, entry] as const)));
	// An update's row never carries a reason; a supersede's does when the two texts disagree on a value.
	const replaced: FoldRecord["superseded"] = [...record.updated, ...record.superseded];
	for (const change of replaced) {
		const address = where.get(change.id);
		const current = entryById.get(change.id);
		slot.supersededArchive.push({
			entry: {
				id: nextVersionedEntryId(change.id, [...slot.archiveIds, ...slot.supersededArchive.map((append) => append.entry.id)]),
				kind: current?.kind ?? "fact",
				saved: current?.saved ?? slot.savedDate,
				pinned: false,
				text: change.before,
				...(current?.from ? { from: current.from } : {}),
				...(change.learnedBefore ? { learned: change.learnedBefore } : {}),
			},
			why: "superseded",
			...(current?.learned ? { until: current.learned } : {}),
			topic: address?.topic ?? "General",
			section: address?.section ?? "Deep Memory",
			archived: slot.savedDate,
			...(change.reason ? { reason: change.reason } : {}),
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
	// The pre-pass entries come BACK first, every one of them: they left so the
	// folds could read a memory under its limit, not because anything was
	// decided about them. The one budget pass below ranks them with everything
	// else against the limit and the keeps as they stand NOW — so a kept one
	// stays, a raised limit keeps the ones that fit, and the rest leave again
	// exactly as the prepass took them, being the least recently touched.
	const doc = restoreEntries(slot.postFoldDoc, slot.prepassArchive.map((append) => ({ ...append.entry, archived: append.archived ?? slot.savedDate, why: append.why, topic: append.topic, section: append.section })));
	const where = addressBook(doc);
	const demoted = demoteToBudget(doc, budgetTokens, { keepIds, keepTopics, today: slot.savedDate, use: memoryUseForRanking(run.agentId) });
	// A keep protects the note in this save only, by id or by topic: the pass
	// above left it in, and it is never pinned. The save records a use for each
	// kept note, so a later run's pass ranks it higher without making it immortal.
	const candidate = cloneDocument(demoted.doc);
	slot.candidateDoc = candidate;
	slot.demotionArchive = demoted.demoted.map((entry) => ({ entry, why: "budget" as const, topic: where.get(entry.id)?.topic ?? "General", section: where.get(entry.id)?.section ?? "Deep Memory", archived: slot.savedDate, reason: entry.reason }));
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
	settleBesideChoices(slot);
}

// --- Reading and adjusting a run -------------------------------------------------

function snapshotRun(slot: RunSlot): AbsorbRun {
	const run = JSON.parse(JSON.stringify(slot.run)) as AbsorbRun;
	// The note a tagged row stands beside is named as the memory holds it now.
	const doc = slot.postFoldDoc ?? slot.workingDoc;
	if (doc) {
		const leaving = leavingIds(slot);
		for (const change of changeRows(run)) {
			if (change.of) {
				const text = besideTextOf(doc, change.of);
				if (text !== undefined) change.ofLine = text.split("\n")[0];
			}
			if (!change.besideOf) continue;
			const text = besideTextOf(doc, change.besideOf);
			if (text !== undefined) change.besideLine = text.split("\n")[0];
			const besideLearned = learnedOf(doc, change.besideOf);
			const learned = learnedOf(doc, change.id);
			if (besideLearned) change.besideLearned = besideLearned;
			if (learned) change.learned = learned;
			if (besideTextOf(doc, change.id) === undefined && closedByRun(slot, doc, change.id)) change.besideState = "self-closed";
			else if (text === undefined) {
				// A note this update closes is named by the text it had, so the card can say which.
				const closed = closedTextOf(slot, doc, change.besideOf);
				change.besideState = closed === undefined ? "gone" : "closed";
				if (closed !== undefined) change.besideLine = closed.split("\n")[0];
			}
			else if (leaving.has(change.id) || leaving.has(change.besideOf)) change.besideState = "leaving";
		}
	}
	return run;
}

/** Every row that carries changes: the conversations', then the re-read notes'. */
function pageRows(run: AbsorbRun): AbsorbRunSessionView[] {
	return [...run.sessions, ...run.rereads];
}

function changeRows(run: AbsorbRun): AbsorbRunChange[] {
	return pageRows(run).flatMap((session) => session.changes ?? []);
}

/** The ids the current budget pass sends to the archive. */
function leavingIds(slot: RunSlot): Set<string> {
	return new Set([...slot.archiveRows.values()].filter((row) => row.leaving).map((row) => row.id));
}

/** A note's text as memory will hold it, or undefined when it is not there or is a finished item on its way out. */
function learnedOf(doc: MemoryDocument, id: string): string | undefined {
	for (const topic of doc.topics) for (const entry of topic.entries) if (entry.id === id) return entry.learned;
	return undefined;
}

function besideTextOf(doc: MemoryDocument, id: string): string | undefined {
	for (const topic of doc.topics) for (const entry of topic.entries) if (entry.id === id) return entry.status === "done" ? undefined : entry.text;
	return undefined;
}

/** Whether this update closes the note: a finished item in the working document, or one that already left the core as done. */
function closedByRun(slot: RunSlot, doc: MemoryDocument, id: string): boolean {
	return closedTextOf(slot, doc, id) !== undefined;
}

/** The text of a note this update closes, or undefined when it does not close it. */
function closedTextOf(slot: RunSlot, doc: MemoryDocument, id: string): string | undefined {
	const archived = slot.closedArchive.find((append) => append.entry.id === id);
	if (archived) return archived.entry.text;
	for (const topic of doc.topics) for (const entry of topic.entries) if (entry.id === id && entry.status === "done") return entry.text;
	return undefined;
}

/**
 * A Replace stands only while what the person chose still holds: both notes
 * stay, and the other note reads as it did when they chose (an edit of it on
 * the card, a keep elsewhere, a lowered limit can each change that). Any other
 * Replace goes back to Keep both, and the card shows it.
 */
function settleBesideChoices(slot: RunSlot): void {
	const doc = slot.postFoldDoc;
	if (!doc) return;
	const leaving = leavingIds(slot);
	for (const change of changeRows(slot.run)) {
		if (!change.choice) continue;
		if (!change.besideOf || leaving.has(change.id) || leaving.has(change.besideOf) || besideTextOf(doc, change.id) === undefined || besideTextOf(doc, change.besideOf) !== change.choiceText) {
			delete change.choice;
			delete change.choiceText;
		}
	}
}

/**
 * The card's "Keep both" or "Replace": for a new note shown beside a pinned
 * note or one it may disagree with. One Replace per note: choosing it on one
 * row takes it from any other row aimed at the same note. Nothing is written;
 * the save applies it.
 */
export function chooseAbsorbRunBeside(agentIdRaw: string, runId: string, entryIdRaw: unknown, choiceRaw: unknown, now = new Date()): AbsorbRun {
	const slot = slotFor(createPersistentAgentInstance(agentIdRaw).agentId, runId);
	requireReady(slot);
	if (!slot.postFoldDoc) throw productError("This memory update has nothing to change yet.", "absorb_run_not_ready", 409);
	const entryId = typeof entryIdRaw === "string" ? entryIdRaw.trim() : "";
	if (!entryId || (choiceRaw !== "replace" && choiceRaw !== "keep-both")) throw productError("entryId and a choice of replace or keep-both are required.", "absorb_run_bad_choice");
	const rows = changeRows(slot.run);
	const row = rows.find((change) => change.kind === "added" && change.id === entryId && change.besideOf);
	if (!row?.besideOf) throw productError("Only a new note shown beside another one can replace it.", "absorb_run_bad_choice", 404);
	if (choiceRaw === "keep-both") {
		delete row.choice;
		delete row.choiceText;
	} else {
		if (besideTextOf(slot.postFoldDoc, row.id) === undefined) throw productError("This new note is closed later in this update, so it cannot replace another note.", "absorb_run_bad_choice", 409);
		const text = besideTextOf(slot.postFoldDoc, row.besideOf);
		if (text === undefined) throw productError("That note is no longer in memory, so there is nothing to replace.", "absorb_run_bad_choice", 409);
		const leaving = leavingIds(slot);
		if (leaving.has(row.id) || leaving.has(row.besideOf)) throw productError("That note is going to the archive, so nothing can replace it here. Keep it first.", "absorb_run_bad_choice", 409);
		for (const other of rows) if (other !== row && other.besideOf === row.besideOf) {
			delete other.choice;
			delete other.choiceText;
		}
		row.choice = "replace";
		row.choiceText = text;
	}
	slot.idleSince = Date.now();
	touch(slot, now);
	return snapshotRun(slot);
}

/**
 * The person's Replace choices, applied to the document the save writes. The
 * other note takes the new note's text and keeps its id, kind, place and
 * status; a pinned one stays pinned, and a must-keep marker in the new text
 * pins the other note (the marker itself is not kept, as on any pin). The new
 * note goes, and its topic with it when nothing else is left there. The old
 * text goes to the archive as a superseded version, so an undo brings it back.
 * A choice whose notes are gone, or whose other note no longer reads as it did
 * when the person chose, keeps both, and the record says so.
 */
/**
 * A new note kept beside one it may disagree with, or beside a pinned note it
 * disagrees with: at the save both notes name each other, so the room's own
 * read shows the day each was learned. A Replace leaves one note, and a note
 * that is gone or closed makes no pair.
 */
function markKeptPairs(slot: RunSlot, doc: MemoryDocument, choices: Array<{ id: string; applied: boolean }>): void {
	const replaced = new Set(choices.filter((choice) => choice.applied).map((choice) => choice.id));
	const byId = new Map(doc.topics.flatMap((topic) => topic.entries).map((entry) => [entry.id, entry]));
	const name = (entry: MemoryEntry, other: string) => {
		const ids = entry.disagrees ? entry.disagrees.split(",") : [];
		if (!ids.includes(other)) entry.disagrees = [...ids, other].join(",");
	};
	for (const change of changeRows(slot.run)) {
		if (change.kind !== "added" || (change.beside !== "may-disagree" && change.beside !== "pinned") || !change.besideOf || replaced.has(change.id)) continue;
		const note = byId.get(change.id);
		const other = byId.get(change.besideOf);
		if (!note || !other || note.status === "done" || other.status === "done") continue;
		if (change.beside === "pinned" && !textDisagreesWith(note.text, other.text)) continue;
		name(note, other.id);
		name(other, note.id);
	}
}

function applyBesideChoices(slot: RunSlot, doc: MemoryDocument): { archive: RankedArchiveAppend[]; choices: Array<{ id: string; other: string; choice: "replace"; applied: boolean }>; removedTopics: Set<string>; pinnedBefore: Set<string> } {
	const archive: RankedArchiveAppend[] = [];
	const choices: Array<{ id: string; other: string; choice: "replace"; applied: boolean }> = [];
	const removedTopics = new Set<string>();
	/** The replacing notes whose other note was pinned already. */
	const pinnedBefore = new Set<string>();
	const taken = [...slot.archiveIds, ...slot.supersededArchive.map((append) => append.entry.id)];
	const at = (id: string) => {
		for (const topic of doc.topics) for (const entry of topic.entries) if (entry.id === id) return { topic, entry };
		return undefined;
	};
	// A chain (the newest note replaces a new note that replaces a note in
	// memory) applies from its newest end, so each note takes the words that
	// replaced it before its own words move on. A row is tagged only against a
	// note that existed before it, so a chain has no cycle.
	const replacing = changeRows(slot.run).filter((change) => change.choice === "replace" && change.besideOf);
	const replacedBy = new Map(replacing.map((change) => [change.besideOf!, change]));
	const depth = (change: AbsorbRunChange): number => {
		let n = 0;
		for (let next = replacedBy.get(change.id); next && n < replacing.length; next = replacedBy.get(next.id)) n++;
		return n;
	};
	for (const change of [...replacing].sort((x, y) => depth(x) - depth(y))) {
		if (!change.besideOf) continue;
		const target = at(change.besideOf);
		const added = at(change.id);
		const applied = !!target && !!added && target.entry.status !== "done" && target.entry.text === change.choiceText;
		choices.push({ id: change.id, other: change.besideOf, choice: "replace", applied });
		if (!applied) continue;
		const id = nextVersionedEntryId(target.entry.id, taken);
		taken.push(id);
		// The note keeps the newer of the two days: the person chose the words,
		// and the day a note was learned never goes back.
		const newer = [target.entry.learned, added.entry.learned].filter((day): day is string => !!day).sort().at(-1);
		archive.push({ entry: { id, kind: target.entry.kind, saved: target.entry.saved, pinned: false, text: target.entry.text, ...(target.entry.from ? { from: target.entry.from } : {}), ...(target.entry.learned ? { learned: target.entry.learned } : {}) }, why: "superseded", ...(newer ? { until: newer } : {}), topic: target.topic.title, section: target.topic.section, archived: slot.savedDate });
		if (newer) target.entry.learned = newer;
		const text = added.entry.text;
		if (target.entry.pinned) pinnedBefore.add(change.id);
		target.entry.text = withoutMustKeepMarkers(text);
		delete target.entry.disagrees;
		// The person confirmed it: touched like a fold's rewrite, so the ranker reads it as used.
		target.entry.updated = slot.savedDate;
		target.entry.refs = (target.entry.refs ?? 0) + 1;
		if (added.entry.pinned || hasMustKeepMarker(text)) target.entry.pinned = true;
		added.topic.entries = added.topic.entries.filter((entry) => entry !== added.entry);
		if (added.topic.entries.length === 0 && !added.topic.intro.trim()) {
			doc.topics = doc.topics.filter((topic) => topic !== added.topic);
			removedTopics.add(change.id);
		}
	}
	return { archive, choices, removedTopics, pinnedBefore };
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

/** The card's keep toggles: the kept notes and the protected topics stay in this save, and the demotion is derived again. */
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
	const editable = pageRows(slot.run).some((session) => (session.changes ?? []).some((change) => change.id === entryId && (change.kind === "added" || change.kind === "updated" || change.kind === "superseded")));
	if (!editable) throw productError("Only a note this update adds or rewrites can be edited here.", "absorb_run_bad_edit", 404);
	let entry: MemoryEntry | undefined;
	for (const topic of slot.postFoldDoc.topics) for (const candidate of topic.entries) if (candidate.id === entryId) entry = candidate;
	if (!entry) throw productError("That note is not in this update any more.", "absorb_run_bad_edit", 404);
	// A topic written as bullets stays bullets: the person edits the words, not the markup.
	const next = /^[-*]\s/.test(entry.text) && !/^[-*]\s/.test(text) ? `- ${text}` : text;
	entry.text = next;
	delete entry.disagrees;
	for (const session of pageRows(slot.run)) for (const change of session.changes ?? []) if (change.id === entryId) change.after = next;
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

/**
 * Try again, after an outage stopped the run: the same run folds the pages
 * still waiting, with the same first read and guidance, on top of what already
 * finished. It is not a restart: the finished pages stay on the card as they
 * are, and a keep, an edit or a raised limit made meanwhile stands.
 *
 * The model is the room's Memory model as it is now, which the person may have
 * changed from the notice. It replaces the run's lock, so the prompts, the
 * probe, the window, the records and the save all read the model the rest is
 * read with; the pages read before the stop keep their model on their own
 * diagnostics.
 */
export function resumeAbsorbRun(agentIdRaw: string, runId: string, model: AbsorbModelLock, now = new Date()): AbsorbRun {
	const slot = slotFor(createPersistentAgentInstance(agentIdRaw).agentId, runId);
	requireReady(slot);
	if (!slot.run.stop || !slot.postFoldDoc) throw productError("This memory update has nothing left to read.", "absorb_run_nothing_waiting", 409);
	const run = slot.run;
	const nowFn = slot.input.now ?? (() => new Date());
	slot.input = { ...slot.input, model };
	slot.model = model;
	delete run.stop;
	run.state = "folding";
	slot.idleSince = null;
	// The resumed folds start from the card as the person left it. Their edits
	// are in the document already, so a fold reads their words and an update
	// builds on them, its before being their text. A note they kept reads as
	// pinned, so a fold may add beside it and never rewrite what they chose to
	// keep. That pin is the folds' only: a keep never pins a note, and a keep
	// taken back after this must leave the note as it was.
	slot.workingDoc = cloneDocument(slot.postFoldDoc);
	// A note the person chose to replace is held the same way, so the resumed
	// folds cannot change what they chose to put in its place.
	const keep = new Set([...run.demotion.keepIds, ...changeRows(run).filter((change) => change.choice === "replace" && change.besideOf).map((change) => change.besideOf!)]);
	const pinnedForFolds = new Set<string>();
	slot.keptForFolds = pinnedForFolds;
	for (const topic of slot.workingDoc.topics) {
		for (const entry of topic.entries) {
			if (!keep.has(entry.id) || entry.pinned) continue;
			entry.pinned = true;
			pinnedForFolds.add(entry.id);
		}
	}
	slot.nextEntryNumber = slot.postFoldDoc.nextEntryNumber;
	slot.postFoldDoc = null;
	touch(slot, now);
	slot.work = (async () => {
		await foldWaitingPages(slot, nowFn);
		delete slot.keptForFolds;
		// A fold that pinned a kept note itself, because the conversation asked
		// for it, made a change the card shows: that pin stays. The folds before
		// the stop are read too, which is harmless: a note they pinned was pinned
		// on the card already, so it was never pinned for the folds.
		for (const session of pageRows(run)) for (const change of session.changes ?? []) if (change.kind === "pinned") pinnedForFolds.delete(change.id);
		for (const topic of slot.workingDoc?.topics ?? []) for (const entry of topic.entries) if (pinnedForFolds.has(entry.id)) entry.pinned = false;
		if (slot.controller.signal.aborted) {
			finish(slot, "cancelled", nowFn());
			return;
		}
		settleRun(slot, nowFn);
	})().catch((error) => {
		if (isActive(slot.run.state)) finish(slot, "failed", nowFn(), endsAsSentence((error as Error).message));
	});
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

/** The file on disk read as the run's source plus what Remember appended meanwhile. */
export interface ApproveRebase {
	/** The document on disk: the write takes its Recent Context and its Chronos. */
	disk: MemoryDocument;
	/** The conversations remembered since the run read its source, in the order they were saved. */
	newSessionIds: string[];
}

/** The two sections a fold changes, as the file stores them — metadata comments and the id counter included, so a pin or a hand edit counts as a change. */
function coreSectionsAsStored(doc: MemoryDocument): string {
	return renderMemoryDocument(doc, "storage", { sections: MEMORY_SECTIONS });
}

/** The prose above the first Recent Context block, with the empty-section placeholder taken out: a Remember removes that line when it appends the first block. */
function recentContextHead(recentContext: string): string {
	return parseRecentContextBlocks(recentContext).head.split(/\r?\n/).filter((line) => line.trim() !== ABSORB_EMPTY_RECENT_CONTEXT_PLACEHOLDER).join("\n").trim();
}

/**
 * Whether the file on disk is the run's source plus conversations remembered
 * meanwhile, and nothing else.
 *
 * Remember stays allowed while a memory update is open — a room with a backlog
 * of conversations must never be locked out of saving the one it is in — and a
 * Remember touches the file in exactly two places: it appends one block to the
 * end of Recent Context and it stamps its own Chronos lines. So the file is
 * accepted when Deep Memory and Active Items are byte for byte the run's
 * source, the preamble and every other section are unchanged, every block the
 * source had is still there in its place, and what follows them is one or more
 * new blocks with ids the run never saw. Chronos is not compared: it is
 * bookkeeping, and the write takes the disk's. Any other difference — an edit
 * in Room settings, another update's save, an undo — is null, and the caller
 * refuses with the honest "stale".
 */
export function rebaseOntoDisk(sourceL1b: string, diskL1b: string): ApproveRebase | null {
	const source = parseMemoryDocument(sourceL1b);
	const disk = parseMemoryDocument(diskL1b);
	if (coreSectionsAsStored(source) !== coreSectionsAsStored(disk)) return null;
	if (source.preamble !== disk.preamble) return null;
	if (JSON.stringify(source.otherSections) !== JSON.stringify(disk.otherSections)) return null;
	if (recentContextHead(source.recentContext) !== recentContextHead(disk.recentContext)) return null;
	const before = parseRecentContextBlocks(source.recentContext).blocks;
	const after = parseRecentContextBlocks(disk.recentContext).blocks;
	if (after.length <= before.length) return null;
	for (let i = 0; i < before.length; i++) if (before[i].id !== after[i].id || before[i].text !== after[i].text) return null;
	const known = new Set(before.map((block) => block.id));
	const appended = after.slice(before.length);
	if (appended.some((block) => block.stub || known.has(block.id))) return null;
	return { disk, newSessionIds: appended.map((block) => block.id) };
}

/**
 * ONE write: the candidate document (post-fold, post-demotion, the kept notes back in),
 * Recent Context with the folded, dropped and skipped sessions taken out and
 * the failed and pending ones kept, everything that left the core appended to
 * the archive with its reason, Chronos stamped, and the run's own account in
 * the absorb event record.
 *
 * A file that changed since the run started is read again before anything is
 * refused: when the only change is conversations remembered meanwhile, the
 * write is rebased onto the file as it stands — the disk's Recent Context less
 * what this run folded, the disk's Chronos, the run's own Deep Memory and
 * Active Items — and the new conversations stay waiting for next time. Any
 * other change makes the run stale, and nothing is written.
 */
export function approveAbsorbRun(agentIdRaw: string, runId: string, now = new Date()): AbsorbRunApprovalResponse {
	const agentId = createPersistentAgentInstance(agentIdRaw).agentId;
	const slot = slotFor(agentId, runId);
	const run = slot.run;
	// The staleness check comes first, and it is what refuses a second approve:
	// the first one wrote the file, so the source this run was built on is no
	// longer the source on disk, and saying "stale" is the truth rather than a
	// special case about runs that were already saved. The one change that is
	// not staleness is a Remember in the meantime, which the write absorbs.
	const diskL1b = createPersistentAgentInstance(agentId).readL1b();
	let rebase: ApproveRebase | null = null;
	if (fingerprintL1bSource(diskL1b).value !== slot.sourceFingerprint.value) {
		rebase = rebaseOntoDisk(slot.sourceL1b, diskL1b);
		if (!rebase) assertAbsorbSourceFingerprintCurrent(slot.sourceFingerprint, diskL1b, "proposal");
	}
	requireReady(slot);
	const candidate = slot.candidateDoc;
	if (!candidate) throw productError("This memory update has nothing to save.", "absorb_run_empty");

	const removed = new Set(run.sessions.filter((session) => session.outcome === "folded" || session.outcome === "dropped" || session.outcome === "summarized" || session.outcome === "skipped").map((session) => session.id));
	const doc = cloneDocument(candidate);
	doc.recentContext = recentContextWithout(rebase ? rebase.disk.recentContext : candidate.recentContext, removed);
	// The Remember stamped its own Chronos lines; the write stamps the
	// consolidation lines on top of those, not on top of the source's.
	if (rebase) doc.chronos = rebase.disk.chronos;
	const rebasedOnto = rebase?.newSessionIds ?? [];

	// What leaves the core, each with the reason it left. The budget rows are
	// the last pass's, pre-pass entries included: one the user kept, by id or
	// by topic, or one a raised limit made room for, is back in the candidate
	// instead and is not among them.
	const beside = applyBesideChoices(slot, doc);
	markKeptPairs(slot, doc, beside.choices);
	// A Replace takes a note out after the last budget pass: the numbers the
	// record and the saved screen show are the written document's.
	const replaced = beside.choices.some((choice) => choice.applied);
	const budgetAfter = replaced ? reviewTargetTokens(doc) : run.budget.after;
	const overBudgetAfter = replaced ? overMemoryBudget(budgetAfter, run.budget.budgetTokens) : run.budget.overBudgetAfter;
	// Each summary note a re-read tried says so, in memory or in its archive
	// row, only in this write: an undo takes it back, and an unsaved run leaves
	// nothing.
	const withRereadTried = (entry: MemoryEntry): MemoryEntry => [...(slot.rereadTried.get(entry.id) ?? [])].reduce(withTried, entry);
	for (const topic of doc.topics) topic.entries = topic.entries.map(withRereadTried);
	const archiveAppend: RankedArchiveAppend[] = [
		...slot.demotionArchive,
		...slot.supersededArchive,
		...slot.historyArchive,
		...slot.closedArchive,
		...beside.archive,
		...slot.sortedArchive,
	].map((append) => (slot.rereadTried.has(append.entry.id) ? { ...append, entry: withRereadTried(append.entry) } : append));
	// A conversation kept as its summary is memorized too: its notes are in this save.
	const foldedSessions = run.sessions.filter((session) => session.outcome === "folded" || session.outcome === "dropped" || session.outcome === "summarized").map((session) => session.id);
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
					// The record names the conversation each entry was, from the names
					// the checkpoint gate stamped into the entry: a Recent Context id is
					// handed back to a later conversation once this save empties the
					// section, and the search index reads these two instead of guessing
					// from timestamps which conversation a folded entry was.
					sessions: run.sessions.map((session) => {
						const remembered = slot.sessionsById.get(session.id);
						return {
							id: session.id,
							outcome: session.outcome,
							attempts: session.attempts,
							...(session.reason ? { reason: session.reason } : {}),
							...(session.summary ? { summary: session.summary } : {}),
							...(remembered?.conversationId ? { conversationId: remembered.conversationId } : {}),
							...(remembered?.checkpointId ? { checkpointId: remembered.checkpointId } : {}),
						};
					}),
					foldedSessions,
					remainingSessions,
					archived: archiveAppend.map((append) => ({ id: append.entry.id, why: append.why, topic: append.topic, section: append.section, ...(append.reason ? { reason: append.reason } : {}) })),
					budget: { before: run.budget.before, after: budgetAfter, budgetTokens: run.budget.budgetTokens, overBudgetAfter, ...(recordsRaise ? { raisedFrom } : {}) },
					...(run.migration?.pending ? { migration: { entriesAssigned: run.migration.entriesAssigned } } : {}),
					...(beside.choices.length > 0 ? { besideChoices: beside.choices } : {}),
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
	// A keep is a use: each kept note that was written counts one, so the next
	// run's budget pass ranks it higher. A kept new note that replaced another
	// note lives on under that note's id, so the use goes there. Use is use, so
	// an undo of this save leaves it.
	const replacedInto = new Map(beside.choices.filter((choice) => choice.applied).map((choice) => [choice.id, choice.other]));
	const savedIds = new Set(doc.topics.flatMap((topic) => topic.entries).map((entry) => entry.id));
	const keptUsed = [...new Set(run.demotion.keepIds.map((id) => replacedInto.get(id) ?? id))].filter((id) => savedIds.has(id));
	if (keptUsed.length > 0) recordMemoryUse(agentId, keptUsed.map((id) => ({ id, source: "note" as const })), { now });
	if (replaced) {
		run.budget = { ...run.budget, after: budgetAfter, overBudgetAfter };
		if (run.candidate) run.candidate = { ...run.candidate, estimatedTokens: estimateTokens(renderMemoryDocument(doc, "context")) };
	}
	// A replaced note's rows say where its words went: a pin its marker made is
	// the other note's now (and says nothing when that note was pinned already),
	// and a topic it opened and left empty is not new.
	for (const choice of beside.choices) {
		if (!choice.applied) continue;
		for (const session of pageRows(run)) {
			if (beside.pinnedBefore.has(choice.id)) session.changes = session.changes?.filter((change) => !(change.kind === "pinned" && change.id === choice.id));
			for (const change of session.changes ?? []) {
				if (change.kind === "pinned" && change.id === choice.id) change.id = choice.other;
				if (change.id === choice.id && beside.removedTopics.has(choice.id)) delete change.newTopic;
			}
		}
	}
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
		// What the file holds now: the run's failed and pending sessions, plus any
		// remembered while it was open.
		recentContextEntryCount: recentContextSessions(doc.recentContext).length,
		memoryBudget: {
			budgetTokens: written.budget.budgetTokens,
			reviewTargetEstimatedTokens: written.budget.reviewTargetTokens,
			overBudget: written.budget.overBudget,
		},
		postAbsorb: { returnToLauncher: true },
		warnings: run.warnings,
		foldedSessions,
		remainingSessions,
		archivedEntries: archiveAppend.filter((append) => append.why !== "history" && append.why !== "sorted").length,
		archivedForBudget: archiveAppend.filter((append) => append.why === "budget").length,
		replacedEntries: archiveAppend.filter((append) => append.why === "superseded").length,
		historyKept: slot.historyArchive.length,
		sortedNotes: slot.sortedArchive.length,
		...(budgetRaisedTo === undefined ? {} : { budgetRaisedTo }),
		rebasedOnto,
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
	// The first read never blocks the run: a missing one, or one too long to
	// carry, folds with none, as a failed first read does.
	const sent = String(raw?.assessmentMarkdown ?? "").trim();
	const assessmentMarkdown = sent && sent.length <= ABSORB_RUN_ASSESSMENT_MAX_CHARS ? sent : FIRST_READ_NONE;
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
