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
 * as stutter-then-jump. Text reveals at a reading-speed band (chars/second,
 * time-based so 60Hz and 120Hz displays behave identically) with a small
 * backlog lean, fractional carry between ticks, and a jank cap so one slow
 * frame cannot burst. When generation finishes ahead of the reveal, the tail
 * keeps draining and the authoritative-text reconciliation waits for the
 * buffer to empty ("draining" phase) — no end-of-message dump.
 */

export interface RevealPacing {
	/** Reveal floor while the backlog is small. */
	minCharsPerSec: number;
	/** Reveal ceiling as the backlog grows. */
	maxCharsPerSec: number;
	/** +chars/s per buffered char, up to the ceiling. */
	backlogLean: number;
	/** Jank guard: one slow frame must not reveal a burst. */
	maxTickDtMs: number;
}

// Anchored just above reading speed (~25 chars/s) and calibrated by eye —
// treat these two numbers as the product knob, not as physics.
export const DEFAULT_REVEAL_PACING: RevealPacing = {
	minCharsPerSec: 74,
	maxCharsPerSec: 131,
	backlogLean: 0.05,
	maxTickDtMs: 250,
};

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
	/** Normalized texts of recently finalized answers (replay quarantine). */
	recentFinals: { norm: string; at: number }[];
	/** Errored item reserved for a provider auto-retry to stream into. */
	retryReservation: { itemId: string; at: number } | null;
	/** When a too-short orphan head started waiting for more text. */
	orphanHoldStartedAt: number | null;
	/** Monotonic counter for generated item ids. */
	counter: number;
}

export type AssistantStreamAction =
	| { type: "message_start"; now: number }
	| { type: "delta"; text: string; now: number }
	| { type: "text_end"; blockText: string; now: number }
	| { type: "message_end"; finalText: string; stopReason?: string; now: number }
	| { type: "auto_retry_start"; now: number }
	/** Paced reveal step; "drain" reveals everything at once (hidden tab, sync boundaries). */
	| { type: "tick"; now: number; mode: "paced" | "drain" }
	| { type: "interrupt"; now: number }
	/** Drain and finalize everything immediately without an interrupt note. */
	| { type: "flush"; now: number }
	/** User sent a new prompt: drop reservations, keep quarantine history. */
	| { type: "new_turn"; now: number }
	/** Connection/room teardown: forget everything. */
	| { type: "reset" };

export type AssistantStreamEffect =
	/** Create the item if missing, else replace its text/streaming flag. */
	| { kind: "upsert"; id: string; text: string; streaming: boolean }
	/** Ask the host to schedule the next tick (rAF / hidden-tab timer). */
	| { kind: "schedule_tick" }
	/** The interrupted item (null = nothing was streaming; host adds a system line). */
	| { kind: "interrupted"; id: string | null }
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
		recentFinals: [],
		retryReservation: null,
		orphanHoldStartedAt: null,
		counter: 0,
	};
}

export function normaliseAssistantText(v: string): string {
	return v.replace(/\s+/g, " ").trim();
}

export function isAssistantStreamActive(state: AssistantStreamState): boolean {
	return state.phase !== "idle" || state.buffer.length > 0;
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
			state.counter += 1;
			state.itemId = `stream_${state.counter}_${now.toString(36)}`;
		}
	}
	if (state.itemId && (state.displayed || text)) {
		effects.push({ kind: "upsert", id: state.itemId, text: text || state.displayed, streaming: false });
	}
	if (text) rememberFinal(state, text, now);
	const closedItemId = state.itemId;
	state.phase = "idle";
	state.itemId = null;
	state.displayed = "";
	state.buffer = "";
	state.finalText = null;
	state.openedByMessageStart = false;
	state.lastTickAt = null;
	state.carry = 0;
	return closedItemId;
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
		const dtMs = state.lastTickAt === null ? 17 : Math.min(pacing.maxTickDtMs, Math.max(0, now - state.lastTickAt));
		state.lastTickAt = now;
		const rate = Math.min(pacing.maxCharsPerSec, pacing.minCharsPerSec + state.buffer.length * pacing.backlogLean);
		const budget = (rate * dtMs) / 1000 + state.carry;
		revealCount = Math.min(state.buffer.length, Math.floor(budget));
		state.carry = budget - revealCount;
		if (revealCount <= 0) {
			effects.push({ kind: "schedule_tick" });
			return;
		}
	} else {
		state.lastTickAt = null;
		state.carry = 0;
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

	if (!state.itemId) {
		state.counter += 1;
		state.itemId = `stream_${state.counter}_${now.toString(36)}`;
	}
	state.displayed += state.buffer.slice(0, revealCount);
	state.buffer = state.buffer.slice(revealCount);

	if (state.buffer) {
		effects.push({ kind: "upsert", id: state.itemId, text: state.displayed, streaming: true });
		effects.push({ kind: "schedule_tick" });
	} else if (state.phase === "draining") {
		// Buffer just emptied with the authoritative text known: reconcile in
		// the same paint instead of one frame later.
		finalizeNow(state, effects, now);
	} else {
		effects.push({ kind: "upsert", id: state.itemId, text: state.displayed, streaming: true });
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
	pacing: RevealPacing = DEFAULT_REVEAL_PACING,
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
			return { state, effects };
		}

		case "message_start": {
			if (state.phase === "draining" || state.phase === "streaming") {
				// Next message began while the previous tail was still revealing
				// (agent loops): hard-finish the old item so texts never merge.
				finalizeNow(state, effects, action.now);
			}
			if (state.retryReservation && action.now - state.retryReservation.at < RETRY_RESERVATION_WINDOW_MS) {
				// The retried attempt replaces the errored one: same bubble,
				// text rebuilt from scratch — one logical answer, one item. The
				// errored partial stays visible until the retry's first paint
				// replaces it, so a retry that dies producing nothing leaves
				// the partial (and its error line) intact.
				state.itemId = state.retryReservation.itemId;
			}
			state.retryReservation = null;
			state.phase = "streaming";
			state.displayed = "";
			state.buffer = "";
			state.finalText = null;
			state.openedByMessageStart = true;
			state.lastTickAt = null;
			state.carry = 0;
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
			if (state.buffer) effects.push({ kind: "schedule_tick" });
			return { state, effects };
		}

		case "text_end": {
			// Reconciliation for a finished text block, only when the reveal has
			// caught up — otherwise the tail keeps flowing and message_end
			// reconciles. Guards against shrinking multi-block messages: the
			// block text replaces the display only when it is at least as long.
			if (state.phase === "streaming" && !state.buffer && action.blockText) {
				if (!state.itemId) {
					if (!state.openedByMessageStart && isReplayOfRecentFinal(state, action.blockText, action.now)) {
						effects.push({ kind: "warn", message: "[stream] dropped replayed text_end of a finalized answer", detail: { chars: action.blockText.length } });
						state.phase = "idle";
						state.openedByMessageStart = false;
						return { state, effects };
					}
					// No deltas ever displayed (e.g. non-streaming provider):
					// reveal the block at the paced rhythm instead of dumping it.
					state.buffer = action.blockText;
					effects.push({ kind: "schedule_tick" });
					return { state, effects };
				}
				if (action.blockText.length >= state.displayed.length) {
					state.displayed = action.blockText;
					// Cursor off between blocks / during a tool phase.
					effects.push({ kind: "upsert", id: state.itemId, text: state.displayed, streaming: false });
				}
			}
			return { state, effects };
		}

		case "message_end": {
			if (action.stopReason === "error") {
				// Mid-stream provider failure: show what arrived, then reserve
				// the bubble — an auto-retry regenerates the whole answer and
				// must not become a second item. No paced tail for a doomed
				// partial; the host renders the red error line.
				const revealed = (state.displayed + state.buffer).trim();
				const partial = action.finalText && action.finalText.length >= revealed.length ? action.finalText : state.displayed + state.buffer;
				const erroredItemId = finalizeNow(state, effects, action.now, partial);
				state.retryReservation = erroredItemId ? { itemId: erroredItemId, at: action.now } : null;
				return { state, effects };
			}

			if (state.phase === "draining") {
				// A second message_end while the previous answer is still
				// draining means the message boundary was lost — finalize the
				// old answer instead of silently swapping its authoritative
				// text (which would merge two answers into one bubble).
				effects.push({ kind: "warn", message: "[stream] message_end while previous message was draining", detail: { chars: action.finalText.length } });
				finalizeNow(state, effects, action.now);
			}

			if (state.buffer) {
				// Generation finished ahead of the reveal: keep the tail flowing
				// at the paced rate; reveal() reconciles with this authoritative
				// text once the buffer empties.
				state.phase = "draining";
				state.finalText = action.finalText;
				effects.push({ kind: "schedule_tick" });
				return { state, effects };
			}

			if (state.itemId) {
				finalizeNow(state, effects, action.now, action.finalText);
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
			if (!action.finalText) return { state, effects };
			if (isExactRecentFinal(state, action.finalText, action.now) || (!wasOpenedByMessageStart && isReplayOfRecentFinal(state, action.finalText, action.now))) {
				effects.push({ kind: "warn", message: "[stream] dropped duplicate message_end replay", detail: { chars: action.finalText.length } });
				return { state, effects };
			}
			state.phase = "draining";
			// Carry the boundary through the reveal: reveal() re-checks the
			// quarantine at first paint and must not drop a legitimate answer.
			state.openedByMessageStart = wasOpenedByMessageStart;
			state.finalText = action.finalText;
			state.buffer = action.finalText;
			effects.push({ kind: "schedule_tick" });
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

		case "interrupt": {
			state.retryReservation = null;
			const interruptedId = drainAllAndFinalize(state, effects, action.now);
			effects.push({ kind: "interrupted", id: interruptedId });
			return { state, effects };
		}
	}
}
