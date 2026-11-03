/**
 * Assistant text streaming as one explicit state machine.
 *
 * Every piece of assistant text that reaches the transcript flows through
 * this reducer — websocket deltas, end-of-message reconciliation, non-streamed
 * fallback answers, interrupts, provider auto-retries. It replaces the old
 * choreography of half a dozen refs (delta buffer, streaming id, pending
 * finalize, last-finalized guard, live-playback intervals) that all wrote to
 * shared state and produced the duplicated-answer bugs.
 *
 * The reducer is pure: (state, action) → { state, effects }. Time comes in
 * through the actions (`now`), randomness doesn't exist (item ids are
 * sequential), and the host applies the effects (one setItems per dispatch,
 * scheduling, console warnings). That makes the whole machine testable and
 * fuzzable in plain node — apps/web-server/scripts/assistant-stream-reducer-smoke.ts
 * asserts the core invariant over arbitrary event sequences (and
 * scripts/replay-stream-trace.ts feeds recorded real traces through it):
 *
 *   INVARIANT — exactly-once: for any sequence of events, including
 *   duplicated, reordered or replayed ones, each assistant message renders in
 *   exactly one transcript item, and once an answer is finalized no leftover
 *   or replayed fragment of it can ever open another item.
 *
 * Message boundaries: the agent loop guarantees message_start(assistant)
 * before the first delta and message_end after the last one (agent-loop.ts).
 * Deltas that arrive outside an open message are therefore replays or
 * emitter bugs — they are quarantined against recently finalized answers and
 * dropped with a warning instead of opening a bubble (defense in depth while
 * EXXETA_STREAM_TRACE captures the real emitter).
 *
 * Provider auto-retry: a mid-stream provider failure surfaces as message_end
 * with stopReason "error" carrying the partial content, then auto_retry_start,
 * then a full re-generation as a fresh message (agent-session.ts). Rendering
 * both attempts is the duplicated-answer bug. The reducer reserves the errored
 * item on auto_retry_start and streams the retried message into the same
 * bubble from scratch — one logical answer, one item.
 *
 * Pacing: deltas arrive in provider/proxy bursts; revealing them whole reads
 * as stutter-then-jump. The reveal follows how fast the model writes
 * (characters received in the last second), keeps a cushion of text in hand
 * that learns the stream's own pauses, and changes speed only in ramps, under
 * a ceiling that rises only while far behind. It shows whole words and counts
 * only the characters a reader sees (reveal-cut.ts). Time-based, so 60Hz and
 * 120Hz displays behave identically, with a jank cap so one slow frame cannot
 * burst. When generation finishes ahead of the reveal, the tail keeps the
 * speed it had and the authoritative-text reconciliation waits for the buffer
 * to empty ("draining" phase), so there is no end-of-message dump. The turn's
 * buttons follow the server's turn, not this tail: sending flushes it first.
 *
 * Shared ids: in a turn the page sent with an id, the server names every
 * answer part (thread-items-by-id.ts) on the frame that opens it, and the
 * part takes that id instead of one made here. The server then also decides
 * which message repeats an earlier part (`echoOf`), so such a turn's
 * messages skip the page's own echo test.
 */

import { cutWords, LONG_WORD, NOTHING_OPEN, openAfterLines, type OpenAtLine } from "./reveal-cut";

/** The reveal's pace: it follows how fast the model writes, keeping a small cushion of text in hand. */
export interface RevealPacing {
	/** Never slower than this while something waits. */
	floorCharsPerSec: number;
	/** The ceiling while the screen keeps up. */
	capCharsPerSec: number;
	/** The ceiling rises toward this while far behind: after a burst, a web search or a drop. */
	catchUpCapCharsPerSec: number;
	/** Waiting characters where the rise starts and where it reaches the catch-up ceiling. */
	catchUpFromChars: number;
	catchUpToChars: number;
	/** Seconds of text kept in hand, so uneven pieces come out even: the stream's longest pause of the last 10 s (times 1.1), between these two. */
	cushionMinS: number;
	cushionMaxS: number;
	/** How quickly the waiting text is brought back to the cushion. */
	correctS: number;
	/** Once the model is done, the rest is shown within about this long, the ceiling allowing. */
	finishS: number;
	/** Speed changes are ramps: at most this much faster or slower per second. */
	rampUpPerSec: number;
	rampDownPerSec: number;
	/** Jank guard: one slow frame must not reveal a burst. */
	maxTickDtMs: number;
}

// The model's own speed, evened out: the cushion learns the stream's pauses
// (0.3-1 s), and the ceiling rises from 600 toward 1,000 a second only while
// more than 900 characters wait. A 400-character paragraph takes about 0.7 s;
// never more than about one line appears in a tenth of a second. The product's
// one pace, with no setting.
export const REVEAL_PACING: RevealPacing = {
	floorCharsPerSec: 60,
	capCharsPerSec: 600,
	catchUpCapCharsPerSec: 1000,
	catchUpFromChars: 900,
	catchUpToChars: 2400,
	cushionMinS: 0.3,
	cushionMaxS: 1,
	correctS: 0.5,
	finishS: 1,
	rampUpPerSec: 1500,
	rampDownPerSec: 1000,
	maxTickDtMs: 250,
};

/** How long a word still being written waits for its end before it shows anyway. */
const LAST_WORD_WAIT_MS = 250;

/** How long a finalized answer quarantines replayed fragments of itself. */
const RECENT_FINAL_FRAGMENT_WINDOW_MS = 10_000;
/** How long an identical non-streamed answer counts as a duplicate delivery. */
const RECENT_FINAL_EXACT_WINDOW_MS = 30_000;
const RECENT_FINAL_MAX = 8;
/** How long an errored item stays reserved for an auto-retry to reclaim. */
const RETRY_RESERVATION_WINDOW_MS = 60_000;
/** How much of a quarantined head is compared against recent finals. */
const QUARANTINE_PROBE_CHARS = 160;
/**
 * Below this many buffered chars an orphan head carries too little signal to
 * tell a replayed fragment from a genuine answer ("The " is a substring of
 * everything) — the reveal holds off painting until enough arrives.
 */
const QUARANTINE_MIN_PROBE_CHARS = 24;
/** How long a too-short orphan head may wait for more text before deciding. */
const ORPHAN_HOLD_MAX_MS = 500;

/**
 * Output-limit honesty.
 *
 * A model with withheld reasoning can spend its ENTIRE output allowance on
 * thinking and get cut before it writes a single answer character: the
 * assistant message arrives with stopReason "length", usage output at the full
 * max_tokens, and content that is empty or thinking-only. The reducer has
 * nothing to render for it (message_end with no final text returns early), so
 * the room used to go completely silent — no bubble, no error, composer back to
 * idle — and the user was left to guess.
 *
 * The sibling case is the ordinary truncation: stopReason "length" WITH text.
 * The answer is real but may stop mid-thought, and that is worth one line too.
 *
 * Pure on purpose, like the rest of this module: the host decides where the
 * line goes, this decides whether there is one.
 */
export const OUTPUT_LIMIT_STARVED_NOTICE =
	"The model used its entire reply allowance on internal reasoning and never reached an answer. Lower the reasoning effort and try again.";
export const OUTPUT_LIMIT_TRUNCATED_NOTICE = "The reply hit this model's output limit and may be cut off.";

/** Anything the transcript actually shows: answer text or a tool chip. Thinking is not it. */
export function hasUserVisibleAssistantContent(content: unknown): boolean {
	if (typeof content === "string") return content.trim().length > 0;
	if (!Array.isArray(content)) return false;
	return content.some((part: any) => {
		if (part?.type === "text") return typeof part.text === "string" && part.text.trim().length > 0;
		if (part?.type === "toolCall") return true;
		return false;
	});
}

/**
 * The notice this finished assistant message earns, or null for the normal
 * case. Only stopReason "length" says anything here: every other stop reason
 * either produced a real answer or already has its own line (provider errors,
 * Stop).
 */
export function outputLimitNoticeFor(message: { stopReason?: unknown; content?: unknown } | null | undefined): string | null {
	if (!message || String(message.stopReason ?? "") !== "length") return null;
	return hasUserVisibleAssistantContent(message.content) ? OUTPUT_LIMIT_TRUNCATED_NOTICE : OUTPUT_LIMIT_STARVED_NOTICE;
}

export interface OutputLimitNoticeTurnInput {
	message: { stopReason?: unknown; content?: unknown } | null | undefined;
	/** Persistent rooms only: the surface where a silent turn is a durable transcript hole. */
	persistentRoom: boolean;
	/** The Stop path writes its own interrupted note; two lines for one act is noise. */
	turnCancelling: boolean;
	/** This turn already said it (reattach replays the whole turn's frames). */
	alreadyShown: boolean;
}

/** The whole decision, guards included, so the host is one call and one setItems. */
export function outputLimitNoticeForTurn(input: OutputLimitNoticeTurnInput): string | null {
	if (!input.persistentRoom || input.turnCancelling || input.alreadyShown) return null;
	return outputLimitNoticeFor(input.message);
}

export type AssistantStreamPhase = "idle" | "streaming" | "draining";

/** The pace's memory for the open message. */
export interface RevealPaceState {
	/** Current reveal speed, chars/s. */
	rate: number;
	/** [time, chars] of each piece received in the last second. */
	arrivals: [number, number][];
	firstArrivalAt: number | null;
	/** [time, ms since the previous piece] over the last 10 s. */
	gaps: [number, number][];
	lastPieceAt: number | null;
	/** Since when the last, unfinished word has been waiting. */
	heldSince: number | null;
	/** What the revealed text leaves open (a code block, inline code), read up to its last line's start, openScannedTo. */
	open: OpenAtLine;
	openScannedTo: number;
}

function createRevealPaceState(): RevealPaceState {
	return { rate: 0, arrivals: [], firstArrivalAt: null, gaps: [], lastPieceAt: null, heldSince: null, open: NOTHING_OPEN, openScannedTo: 0 };
}

/** How much of the turn was on screen: what a reconnect replay draws at once. */
export interface ReplaySeen {
	/** Characters over all the turn's parts, in the order they showed. */
	chars: number;
}

export interface AssistantStreamState {
	phase: AssistantStreamPhase;
	/** Transcript item currently owned by the machine (null = none yet). */
	itemId: string | null;
	/** Text already revealed into the item. */
	displayed: string;
	/** Received but not yet revealed. */
	buffer: string;
	/** Authoritative full text, known once message_end arrived (draining). */
	finalText: string | null;
	/** True when the open message was opened by an explicit message_start. */
	openedByMessageStart: boolean;
	/** Timestamp of the previous paced tick. */
	lastTickAt: number | null;
	/** Fractional reveal budget carried between ticks. */
	carry: number;
	pace: RevealPaceState;
	/** Characters the turn's closed parts showed (since the turn began or the page reattached): with the open part's, the turn's one reveal position. */
	turnShown: number;
	/** While a reconnect replays the turn: draw only this much of it at once, pace the rest. */
	replaySeen: ReplaySeen | null;
	/** Normalized texts of recently finalized answers (replay quarantine). */
	recentFinals: { norm: string; at: number }[];
	/** Errored item reserved for a provider auto-retry to stream into; `partIds`: every part the errored message opened. */
	retryReservation: { itemId: string; at: number; partIds: string[] } | null;
	/** When a too-short orphan head started waiting for more text. */
	orphanHoldStartedAt: number | null;
	/** Monotonic counter for generated item ids. */
	counter: number;
	/** The open message's text already closed into items of its own, before a step that came inside it. */
	shownBefore: string;
	/** The server's id for the part the open message writes next (a keyed turn); null: one is made here. */
	partId: string | null;
	/** The open message was opened with a server id: the server decides its echoes. */
	messageKeyed: boolean;
	/** The part the last message_end closed, until the next message or turn: a Stop right after it notes that part. */
	endedPartId: string | null;
	/** The parts the current message opened, so an echo or a retry can take them back. */
	messageParts: string[];
	/** A retried attempt's parts the retry does not write again: they go at the retry's first paint. */
	retiredParts: string[];
}

export type AssistantStreamAction =
	/** `itemId`: the server's id for the message's first part. */
	| { type: "message_start"; now: number; itemId?: string }
	/** The server names the next part of the open message (a keyed turn's text after a step). */
	| { type: "part_id"; itemId: string }
	| { type: "delta"; text: string; now: number }
	| { type: "text_end"; blockText: string; now: number }
	/** `echoOf`: the server found this message repeats that part and wrote none. */
	| { type: "message_end"; finalText: string; stopReason?: string; now: number; echoOf?: string }
	| { type: "auto_retry_start"; now: number }
	/** A step starts inside the open message (a tool call, a thinking block, the provider's own web search): the text so far closes, and the rest opens below the step. */
	| { type: "break"; now: number }
	/** Paced reveal step; "drain" reveals everything at once (hidden tab, sync boundaries). */
	| { type: "tick"; now: number; mode: "paced" | "drain" }
	| { type: "interrupt"; now: number }
	/** A reconnect replay starts (seen) or ends (null): see ReplaySeen. */
	| { type: "replay_seen"; seen: ReplaySeen | null }
	/** Drain and finalize everything immediately without an interrupt note. */
	| { type: "flush"; now: number }
	/** User sent a new prompt: drop reservations, keep quarantine history. */
	| { type: "new_turn"; now: number }
	/** Connection/room teardown: forget everything. */
	| { type: "reset" };

export type AssistantStreamEffect =
	/** Create the item if missing, else replace its text/streaming flag. */
	| { kind: "upsert"; id: string; text: string; streaming: boolean }
	/**
	 * Take this item off the list: a part of an answer the server keeps none of. `echo`: a message that repeated an
	 * earlier part, whose id the server never gives again. `retried`: an attempt the runtime asked again, whose ids
	 * the retry may write under again, so the page's saves must not name them as removed.
	 */
	| { kind: "drop"; id: string; why: "echo" | "retried" }
	/** Ask the host to schedule the next tick (rAF / hidden-tab timer). */
	| { kind: "schedule_tick" }
	/** The interrupted item (null = nothing was streaming; host adds a system line); `ended`: nothing was open, and this part's message had just ended. */
	| { kind: "interrupted"; id: string | null; ended?: true }
	/** Illegal or suspicious transition — surfaced so real traces name the emitter. */
	| { kind: "warn"; message: string; detail?: Record<string, unknown> };

export interface AssistantStreamResult {
	state: AssistantStreamState;
	effects: AssistantStreamEffect[];
}

export function createAssistantStreamState(): AssistantStreamState {
	return {
		phase: "idle",
		itemId: null,
		displayed: "",
		buffer: "",
		finalText: null,
		openedByMessageStart: false,
		lastTickAt: null,
		carry: 0,
		pace: createRevealPaceState(),
		turnShown: 0,
		replaySeen: null,
		recentFinals: [],
		retryReservation: null,
		orphanHoldStartedAt: null,
		counter: 0,
		shownBefore: "",
		partId: null,
		messageKeyed: false,
		endedPartId: null,
		messageParts: [],
		retiredParts: [],
	};
}

export function normaliseAssistantText(v: string): string {
	return v.replace(/\s+/g, " ").trim();
}

export function isAssistantStreamActive(state: AssistantStreamState): boolean {
	return state.phase !== "idle" || state.buffer.length > 0;
}

/** What of the turn's answer is on screen now, before its first words and between its parts too: what a reconnect draws at once. */
export function seenOfOpenAnswer(state: AssistantStreamState): ReplaySeen {
	return { chars: state.turnShown + state.displayed.length };
}

/** The part a reconnect's replay drew words into at once, whose blocks then skip their fade-in; null when it drew none. */
export function partDrawnAtOnce(state: AssistantStreamState): string | null {
	return state.displayed ? state.itemId : null;
}

function pruneRecentFinals(recentFinals: AssistantStreamState["recentFinals"], now: number): AssistantStreamState["recentFinals"] {
	return recentFinals.filter((f) => now - f.at < RECENT_FINAL_EXACT_WINDOW_MS).slice(-RECENT_FINAL_MAX);
}

function rememberFinal(state: AssistantStreamState, text: string, now: number): void {
	const norm = normaliseAssistantText(text);
	if (!norm) return;
	state.recentFinals = [...pruneRecentFinals(state.recentFinals, now), { norm, at: now }];
}

/** Identical to a recently finalized answer (duplicate delivery). */
function isExactRecentFinal(state: AssistantStreamState, text: string, now: number): boolean {
	const norm = normaliseAssistantText(text);
	if (!norm) return false;
	return state.recentFinals.some((f) => now - f.at < RECENT_FINAL_EXACT_WINDOW_MS && f.norm === norm);
}

/**
 * Fragment of a recently finalized answer (replayed tail). Substring matching
 * needs a meaningful probe — short heads fall back to exact equality so a
 * genuine tiny answer is never shredded by the gate.
 */
function isReplayOfRecentFinal(state: AssistantStreamState, text: string, now: number): boolean {
	const probe = normaliseAssistantText(text.slice(0, QUARANTINE_PROBE_CHARS));
	if (!probe) return false;
	// Erring toward dropping is safe for genuine text: a dropped head is
	// repaired when message_end reconciles the authoritative full answer into
	// the item. A rendered fragment, by contrast, is unrepairable — replayed
	// tails have no message_end of their own. Short probes therefore still
	// use substring matching; reveal() first holds short orphan heads briefly
	// so most genuine text accumulates a distinctive probe before deciding.
	return isExactRecentFinal(state, text, now)
		|| state.recentFinals.some((f) => now - f.at < RECENT_FINAL_FRAGMENT_WINDOW_MS && f.norm.includes(probe));
}

/** The id for the item about to open: the server's when it named the part, else one made here. */
function openItemId(state: AssistantStreamState, now: number): string {
	const named = state.partId;
	state.partId = null;
	let id = named;
	if (!id) {
		state.counter += 1;
		id = `stream_${state.counter}_${now.toString(36)}`;
	}
	state.messageParts = [...state.messageParts, id];
	return id;
}

/** Writes the open part's words; the first words a retry shows also take its attempt's other parts away. */
function upsertOpenPart(state: AssistantStreamState, effects: AssistantStreamEffect[], text: string, streaming: boolean): void {
	for (const id of state.retiredParts) effects.push({ kind: "drop", id, why: "retried" });
	state.retiredParts = [];
	effects.push({ kind: "upsert", id: state.itemId!, text, streaming });
}

/** Back to idle with nothing written: the message's words belong to no part. */
function closeWithoutPart(state: AssistantStreamState): void {
	state.phase = "idle";
	state.itemId = null;
	state.displayed = "";
	state.buffer = "";
	state.finalText = null;
	state.openedByMessageStart = false;
	state.lastTickAt = null;
	state.carry = 0;
	state.shownBefore = "";
	state.partId = null;
	state.messageKeyed = false;
	state.messageParts = [];
}

/**
 * Close the currently open item with the best text available and return to
 * idle. `authoritative` (when known) wins over displayed+buffer unless it
 * would visibly shrink already-revealed text.
 */
function finalizeNow(state: AssistantStreamState, effects: AssistantStreamEffect[], now: number, authoritative?: string | null): string | null {
	const revealed = state.displayed + state.buffer;
	const finalText = authoritative ?? state.finalText;
	const text = finalText && finalText.length >= revealed.trim().length ? finalText : revealed;
	if (!state.itemId && text.trim()) {
		// Finalized before the first paint (message_end chasing message_start,
		// or an instant hard-finish): the item still has to exist — through the
		// same quarantine gate as any other first paint.
		if (!state.openedByMessageStart && isReplayOfRecentFinal(state, text, now)) {
			effects.push({ kind: "warn", message: "[stream] dropped replayed fragment at finalize", detail: { chars: text.length } });
		} else {
			state.itemId = openItemId(state, now);
		}
	}
	if (state.itemId && (state.displayed || text)) {
		upsertOpenPart(state, effects, text || state.displayed, false);
		state.turnShown += (text || state.displayed).length;
	}
	if (text) rememberFinal(state, text, now);
	const closedItemId = state.itemId;
	// The message has ended once its authoritative text is known: draining, or handed in by message_end.
	if (state.phase === "draining" || authoritative !== undefined) state.endedPartId = closedItemId;
	state.phase = "idle";
	state.itemId = null;
	state.displayed = "";
	state.buffer = "";
	state.finalText = null;
	state.openedByMessageStart = false;
	state.lastTickAt = null;
	state.carry = 0;
	state.pace = createRevealPaceState();
	state.shownBefore = "";
	state.partId = null;
	state.messageKeyed = false;
	return closedItemId;
}

/**
 * The whole message's text, less what a break already closed into items of
 * their own. A text that does not start with it is the block alone, kept as
 * it is, unless `strict`: then it is dropped and the revealed text stands.
 */
function afterShown(state: AssistantStreamState, text: string, strict: boolean): string {
	const shown = state.shownBefore.trim();
	if (!shown) return text;
	const whole = text.trimStart();
	if (whole.startsWith(shown)) return whole.slice(shown.length).trimStart();
	return strict ? "" : text;
}

/**
 * Reserve the transcript item for a message that finishes before its first
 * paint. The host appends the message's tool chips right after dispatching
 * message_end, and an item that only comes into being at the next tick lands
 * AFTER them — the sentence the model wrote before calling a tool showed up
 * below the tool chip, depending on whether a frame had painted in between.
 * Emitting the (still empty) item here pins its slot above the chips; the
 * reveal then fills it in place at the usual pace, so timing is unchanged.
 * Orphan-opened messages keep their quarantine: the authoritative text
 * decides, exactly as the non-streamed path decides before it buffers — a
 * replayed answer reserves nothing and reveal()'s gate drops it as before.
 */
function reserveItemBeforeDrain(state: AssistantStreamState, effects: AssistantStreamEffect[], now: number, finalText: string): void {
	if (state.itemId) return;
	if (!state.openedByMessageStart && isReplayOfRecentFinal(state, finalText, now)) return;
	state.itemId = openItemId(state, now);
	effects.push({ kind: "upsert", id: state.itemId, text: state.displayed, streaming: true });
}

const clamp = (value: number, low: number, high: number) => Math.max(low, Math.min(high, value));

/** Notes a received piece for the pace: its size, and the pause before it. */
function notePiece(pace: RevealPaceState, chars: number, now: number): RevealPaceState {
	const arrivals = pace.arrivals.filter(([at]) => at > now - 1000);
	arrivals.push([now, chars]);
	const gaps = pace.gaps.filter(([at]) => at > now - 10_000);
	if (pace.lastPieceAt !== null) gaps.push([now, now - pace.lastPieceAt]);
	return { ...pace, arrivals, gaps, lastPieceAt: now, firstArrivalAt: pace.firstArrivalAt ?? now };
}

/** The reveal speed for this tick, chars/s. */
function paceRate(state: AssistantStreamState, pacing: RevealPacing, now: number, dtMs: number): number {
	const waiting = state.buffer.length;
	const pace = state.pace;
	const recent = pace.arrivals.filter(([at]) => at > now - 1000);
	const span = clamp(now - (pace.firstArrivalAt ?? now), 250, 1000);
	const arrival = (recent.reduce((sum, [, chars]) => sum + chars, 0) * 1000) / span;
	const longestPause = pace.gaps.reduce((longest, [at, gap]) => (at > now - 10_000 ? Math.max(longest, gap) : longest), 0);
	const cushion = clamp((longestPause * 1.1) / 1000, pacing.cushionMinS, pacing.cushionMaxS);
	const behind = clamp((waiting - pacing.catchUpFromChars) / Math.max(1, pacing.catchUpToChars - pacing.catchUpFromChars), 0, 1);
	const cap = pacing.capCharsPerSec + Math.max(0, pacing.catchUpCapCharsPerSec - pacing.capCharsPerSec) * behind;
	// While the model writes: as fast as text arrives, plus a correction toward
	// the cushion. Once it is done: no slower than now, finishing in about finishS.
	const wanted = clamp(state.phase === "draining" ? Math.max(pace.rate, waiting / pacing.finishS) : arrival + (waiting - arrival * cushion) / pacing.correctS, pacing.floorCharsPerSec, cap);
	const previous = pace.rate || pacing.floorCharsPerSec;
	pace.rate = clamp(wanted, previous - (pacing.rampDownPerSec * dtMs) / 1000, previous + (pacing.rampUpPerSec * dtMs) / 1000);
	return pace.rate;
}

/** How many buffered characters this paced tick shows, or 0 to wait. */
function pacedCount(state: AssistantStreamState, pacing: RevealPacing, now: number): number {
	const dtMs = state.lastTickAt === null ? 17 : Math.min(pacing.maxTickDtMs, Math.max(0, now - state.lastTickAt));
	state.lastTickAt = now;
	state.pace = { ...state.pace };
	const rate = paceRate(state, pacing, now, dtMs);
	const budget = (rate * dtMs) / 1000 + state.carry;
	const lines = openAfterLines(state.displayed, state.pace.openScannedTo, state.pace.open);
	state.pace.open = lines.open;
	state.pace.openScannedTo = lines.scannedTo;
	const cut = cutWords({
		shown: state.displayed,
		waiting: state.buffer,
		budget,
		complete: state.phase === "draining",
		releaseLastWord: state.pace.heldSince !== null && now - state.pace.heldSince >= LAST_WORD_WAIT_MS,
		open: lines.open,
	});
	state.pace.heldSince = cut.heldLastWord ? (state.pace.heldSince ?? now) : null;
	// Bounded, so a word held for a while cannot release a burst.
	state.carry = Math.min(budget - cut.cost, LONG_WORD + 4 + rate * 0.05);
	return cut.chars;
}

/** Reveal a slice of the buffer according to pacing (or all of it). */
function reveal(state: AssistantStreamState, effects: AssistantStreamEffect[], now: number, mode: "paced" | "drain", pacing: RevealPacing): void {
	if (!state.buffer) {
		state.lastTickAt = null;
		state.carry = 0;
		if (state.phase === "draining") finalizeNow(state, effects, now);
		return;
	}

	// An orphan head that is still too short to classify (replayed fragment
	// vs genuine answer) is not painted yet — more deltas, the message_end,
	// or a bounded wait will decide. Drain mode always decides now.
	if (
		mode === "paced" &&
		!state.itemId &&
		!state.openedByMessageStart &&
		state.phase !== "draining" &&
		state.buffer.length < QUARANTINE_MIN_PROBE_CHARS
	) {
		if (state.orphanHoldStartedAt === null) state.orphanHoldStartedAt = now;
		if (now - state.orphanHoldStartedAt < ORPHAN_HOLD_MAX_MS) {
			effects.push({ kind: "schedule_tick" });
			return;
		}
	}
	state.orphanHoldStartedAt = null;

	let revealCount = state.buffer.length;
	if (mode === "paced") {
		revealCount = pacedCount(state, pacing, now);
		if (revealCount <= 0) {
			effects.push({ kind: "schedule_tick" });
			return;
		}
	} else {
		state.lastTickAt = null;
		state.carry = 0;
		// A reconnect replay draws at once only what was on screen before the
		// drop, counted over the whole turn; the rest stays waiting and is
		// paced once the replay is done.
		const seen = state.replaySeen;
		if (seen) {
			revealCount = clamp(seen.chars - state.turnShown - state.displayed.length, 0, state.buffer.length);
			if (revealCount <= 0) return;
		}
	}

	// First paint of a new bubble: quarantine gate. A buffered remainder or
	// replay of a just-finalized answer must never open a new item. Only
	// orphan-opened messages are suspect — an explicit message_start is the
	// agent loop's own boundary and always renders.
	if (!state.itemId && !state.openedByMessageStart && isReplayOfRecentFinal(state, state.buffer, now)) {
		effects.push({
			kind: "warn",
			message: "[stream] dropped replayed fragment of a finalized answer",
			detail: { chars: state.buffer.length },
		});
		state.buffer = "";
		if (state.phase === "draining") finalizeNow(state, effects, now);
		else state.phase = "idle";
		return;
	}

	if (!state.itemId) state.itemId = openItemId(state, now);
	state.displayed += state.buffer.slice(0, revealCount);
	state.buffer = state.buffer.slice(revealCount);

	if (state.buffer) {
		upsertOpenPart(state, effects, state.displayed, true);
		effects.push({ kind: "schedule_tick" });
	} else if (state.phase === "draining") {
		// Buffer just emptied with the authoritative text known: reconcile in
		// the same paint instead of one frame later.
		finalizeNow(state, effects, now);
	} else {
		upsertOpenPart(state, effects, state.displayed, true);
	}
}

/**
 * Reveal everything received immediately (same quarantine as any first
 * paint), reconcile with the authoritative text if it is already known, and
 * close the item. Returns the closed item id (null if nothing was showing).
 */
function drainAllAndFinalize(state: AssistantStreamState, effects: AssistantStreamEffect[], now: number): string | null {
	if (state.phase === "idle" && !state.buffer) return null;
	if (state.buffer && !state.itemId && !state.openedByMessageStart && isReplayOfRecentFinal(state, state.buffer, now)) {
		effects.push({ kind: "warn", message: "[stream] dropped replayed fragment at flush", detail: { chars: state.buffer.length } });
		state.buffer = "";
	}
	state.displayed += state.buffer;
	state.buffer = "";
	return finalizeNow(state, effects, now);
}

export function reduceAssistantStream(
	previous: AssistantStreamState,
	action: AssistantStreamAction,
	pacing: RevealPacing = REVEAL_PACING,
): AssistantStreamResult {
	const state: AssistantStreamState = { ...previous };
	const effects: AssistantStreamEffect[] = [];

	switch (action.type) {
		case "reset":
			return { state: createAssistantStreamState(), effects };

		case "new_turn": {
			// The composer only sends while no turn is running, so an active
			// phase here is a hard error in the host wiring — recover visibly.
			if (state.phase !== "idle") {
				effects.push({ kind: "warn", message: "[stream] new turn while a message was still open", detail: { phase: state.phase } });
				finalizeNow(state, effects, action.now);
			}
			state.retryReservation = null;
			state.turnShown = 0;
			state.replaySeen = null;
			state.endedPartId = null;
			state.retiredParts = [];
			return { state, effects };
		}

		case "message_start": {
			if (state.phase === "draining" || state.phase === "streaming") {
				// Next message began while the previous tail was still revealing
				// (agent loops): hard-finish the old item so texts never merge.
				finalizeNow(state, effects, action.now);
			}
			state.pace = createRevealPaceState();
			state.messageParts = [];
			if (state.retryReservation && action.now - state.retryReservation.at < RETRY_RESERVATION_WINDOW_MS) {
				// The retried attempt replaces the errored one: same bubble,
				// text rebuilt from scratch — one logical answer, one item. The
				// errored partial stays visible until the retry's first paint
				// replaces it, so a retry that dies producing nothing leaves
				// the partial (and its error line) intact. In a keyed turn the
				// server keeps no part of the attempt and names the retry's
				// first part itself (its first part's id, also when a step
				// split the attempt): the retry writes there, and the attempt's
				// other parts go at its first paint.
				const reserved = state.retryReservation;
				state.itemId = action.itemId ?? reserved.itemId;
				state.retiredParts = action.itemId === undefined ? [] : reserved.partIds.filter((id) => id !== state.itemId);
				// The retry's first part is this message's, as if it had opened it: an echo takes it back too.
				state.messageParts = [state.itemId];
			}
			state.retryReservation = null;
			state.shownBefore = "";
			// A retry writes under the id it took above.
			state.partId = state.itemId ? null : action.itemId ?? null;
			state.messageKeyed = action.itemId !== undefined;
			state.endedPartId = null;
			state.phase = "streaming";
			state.displayed = "";
			state.buffer = "";
			state.finalText = null;
			state.openedByMessageStart = true;
			state.lastTickAt = null;
			state.carry = 0;
			return { state, effects };
		}

		case "part_id": {
			// Only a part not yet open takes it: an open one keeps the id it shows under.
			if (state.phase === "streaming" && !state.itemId) state.partId = action.itemId;
			else effects.push({ kind: "warn", message: "[stream] part id while a part was open", detail: { itemId: action.itemId } });
			return { state, effects };
		}

		case "delta": {
			if (state.phase === "draining") {
				// Deltas belong to a message_start-opened message; getting one
				// while the previous message drains means the boundary was lost.
				effects.push({ kind: "warn", message: "[stream] delta while previous message was draining", detail: { chars: action.text.length } });
				finalizeNow(state, effects, action.now);
			}
			if (state.phase === "idle") {
				// Orphan delta (no message_start): render, but through the
				// quarantine gate in reveal() — see module docs.
				state.phase = "streaming";
				state.openedByMessageStart = false;
			} else if (!state.itemId && !state.openedByMessageStart && state.buffer) {
				// A held orphan buffer must not be contaminated across a message
				// boundary: if the buffer alone reads as a replay of a recent
				// answer but buffer+delta stops matching, the replayed tail ends
				// exactly here — drop it so the new text opens clean. (Dropping
				// errs safe: a genuine head is repaired by message_end
				// reconciliation; a painted fragment never is.)
				if (
					isReplayOfRecentFinal(state, state.buffer, action.now) &&
					!isReplayOfRecentFinal(state, state.buffer + action.text, action.now)
				) {
					effects.push({ kind: "warn", message: "[stream] dropped replayed fragment at message boundary", detail: { chars: state.buffer.length } });
					state.buffer = "";
					state.orphanHoldStartedAt = null;
				}
			}
			state.buffer += action.text;
			if (action.text) state.pace = notePiece(state.pace, action.text.length, action.now);
			if (state.buffer) effects.push({ kind: "schedule_tick" });
			return { state, effects };
		}

		case "text_end": {
			const blockText = afterShown(state, action.blockText, false);
			// Reconciliation for a finished text block, only when the reveal has
			// caught up — otherwise the tail keeps flowing and message_end
			// reconciles. Guards against shrinking multi-block messages: the
			// block text replaces the display only when it is at least as long.
			if (state.phase === "streaming" && !state.buffer && blockText) {
				if (!state.itemId) {
					if (!state.openedByMessageStart && isReplayOfRecentFinal(state, blockText, action.now)) {
						effects.push({ kind: "warn", message: "[stream] dropped replayed text_end of a finalized answer", detail: { chars: blockText.length } });
						state.phase = "idle";
						state.openedByMessageStart = false;
						return { state, effects };
					}
					// No deltas ever displayed (e.g. non-streaming provider):
					// reveal the block at the paced rhythm instead of dumping it.
					state.buffer = blockText;
					effects.push({ kind: "schedule_tick" });
					return { state, effects };
				}
				if (blockText.length >= state.displayed.length) {
					state.displayed = blockText;
					// Cursor off between blocks / during a tool phase.
					upsertOpenPart(state, effects, state.displayed, false);
				}
			}
			return { state, effects };
		}

		case "message_end": {
			const finalText = afterShown(state, action.finalText, true);
			if (action.stopReason === "error") {
				// Mid-stream provider failure: show what arrived, then reserve
				// the bubble — an auto-retry regenerates the whole answer and
				// must not become a second item. No paced tail for a doomed
				// partial; the host renders the red error line.
				const revealed = (state.displayed + state.buffer).trim();
				const partial = finalText && finalText.length >= revealed.length ? finalText : state.displayed + state.buffer;
				const erroredItemId = finalizeNow(state, effects, action.now, partial);
				// A retry that died before its first paint hands its attempt's parts on to the next.
				const partIds = [...new Set([...state.retiredParts, ...state.messageParts, ...(erroredItemId ? [erroredItemId] : [])])];
				state.retiredParts = [];
				state.retryReservation = erroredItemId ? { itemId: erroredItemId, at: action.now, partIds } : null;
				return { state, effects };
			}

			if (action.echoOf !== undefined) {
				// The server wrote no part for it: what this message showed, from a text_end with no deltas too, goes.
				for (const id of state.messageParts) if (id !== action.echoOf) effects.push({ kind: "drop", id, why: "echo" });
				closeWithoutPart(state);
				effects.push({ kind: "warn", message: "[stream] dropped duplicate message_end replay", detail: { chars: finalText.length } });
				return { state, effects };
			}

			if (state.phase === "draining") {
				// A second message_end while the previous answer is still
				// draining means the message boundary was lost — finalize the
				// old answer instead of silently swapping its authoritative
				// text (which would merge two answers into one bubble).
				effects.push({ kind: "warn", message: "[stream] message_end while previous message was draining", detail: { chars: finalText.length } });
				finalizeNow(state, effects, action.now);
			}

			if (state.buffer) {
				// Generation finished ahead of the reveal: keep the tail flowing
				// at the paced rate; reveal() reconciles with this authoritative
				// text once the buffer empties.
				state.phase = "draining";
				state.finalText = finalText;
				reserveItemBeforeDrain(state, effects, action.now, finalText);
				effects.push({ kind: "schedule_tick" });
				return { state, effects };
			}

			if (state.itemId) {
				finalizeNow(state, effects, action.now, finalText);
				return { state, effects };
			}

			// Nothing was streamed (fallback/non-streaming path): the whole
			// answer arrives here. An answer identical to one finalized in the
			// last 30s is a duplicate delivery and is dropped even inside a
			// legitimate message_start boundary (internal re-prompts make models
			// repeat themselves; streamed answers are never deduped). Fragment
			// quarantine additionally applies to boundary-less arrivals.
			const wasOpenedByMessageStart = state.openedByMessageStart;
			state.phase = "idle";
			state.openedByMessageStart = false;
			if (!finalText) return { state, effects };
			// A keyed message is an echo only by the server's word (above), never by this test.
			const echo = !state.messageKeyed && (isExactRecentFinal(state, finalText, action.now) || (!wasOpenedByMessageStart && isReplayOfRecentFinal(state, finalText, action.now)));
			if (echo) {
				effects.push({ kind: "warn", message: "[stream] dropped duplicate message_end replay", detail: { chars: finalText.length } });
				return { state, effects };
			}
			state.phase = "draining";
			// Carry the boundary through the reveal: the reservation below and
			// reveal()'s first-paint gate must not drop a legitimate answer.
			state.openedByMessageStart = wasOpenedByMessageStart;
			state.finalText = finalText;
			state.buffer = finalText;
			reserveItemBeforeDrain(state, effects, action.now, finalText);
			effects.push({ kind: "schedule_tick" });
			return { state, effects };
		}

		case "break": {
			// Only an open message can be broken; a draining one already ended.
			if (state.phase !== "streaming") return { state, effects };
			const text = state.displayed + state.buffer;
			if (!text.trim()) return { state, effects };
			const shownBefore = state.shownBefore + text;
			const openedByMessageStart = state.openedByMessageStart;
			const messageKeyed = state.messageKeyed;
			// The words before the step show whole at once: the step goes right after them.
			state.displayed = text;
			state.buffer = "";
			finalizeNow(state, effects, action.now);
			state.phase = "streaming";
			state.openedByMessageStart = openedByMessageStart;
			state.messageKeyed = messageKeyed;
			state.shownBefore = shownBefore;
			return { state, effects };
		}

		case "auto_retry_start": {
			// The reservation was already taken at message_end(error); this
			// action just confirms it should be kept (the host swaps the red
			// error line for a retrying note).
			return { state, effects };
		}

		case "tick": {
			reveal(state, effects, action.now, action.mode, pacing);
			return { state, effects };
		}

		case "flush": {
			// Synchronous boundary (room exit, teardown, server error, page
			// hide): everything received must be in the transcript NOW.
			state.retryReservation = null;
			drainAllAndFinalize(state, effects, action.now);
			return { state, effects };
		}

		case "replay_seen": {
			state.replaySeen = action.seen;
			if (!action.seen && state.buffer) effects.push({ kind: "schedule_tick" });
			return { state, effects };
		}

		case "interrupt": {
			state.retryReservation = null;
			const interruptedId = drainAllAndFinalize(state, effects, action.now);
			if (interruptedId) effects.push({ kind: "interrupted", id: interruptedId });
			else if (state.endedPartId) effects.push({ kind: "interrupted", id: state.endedPartId, ended: true });
			else effects.push({ kind: "interrupted", id: null });
			return { state, effects };
		}
	}
}
