/**
 * Consult (delegation) client state machine as one explicit, pure reducer.
 *
 * "Consult" lets the user, from room A, ask room B a question; B's memory is
 * read (never modified) by an isolated server-side worker and the answer
 * streams back into room A's UI. The WS family lives on room A's existing
 * `/ws` socket (Consult MR-2). This reducer owns the *client* side of that
 * exchange: it turns the raw `consult_*` events into the DelegationCard's
 * render state and enforces the client discipline the spec (§3) requires:
 *
 *   - `consultId` is generated client-side and echoed on every server event.
 *     Any event whose consultId is not the active one is a stale replay and is
 *     dropped *inside the reducer* — the same stale-nonce discipline the
 *     assistant stream reducer applies to message fragments.
 *   - One consult at a time, client-side too: while one is active (streaming,
 *     or an undismissed done/stopped/failed card), a new `request` is rejected
 *     gracefully (an effect the host logs) and the current card is untouched.
 *   - `consult_end` is authoritative: its `text` replaces the accumulated
 *     deltas (which only ever fed the live view).
 *   - Stopped vs failed is decided by whether *this client* asked to abort, not
 *     by string-matching the server message: `abort_requested` arms a flag and
 *     the subsequent `error` lands in `stopped` (partial text kept, greyed by
 *     the card) rather than `failed`.
 *
 * The reducer is pure — (state, action) → { state, effects } — with no React
 * imports. WS side effects (send the `consult` frame, send `consult_abort`,
 * log a rejected second consult) are returned as effects and applied by the
 * host, mirroring the assistant-stream.ts house pattern. This makes the whole
 * machine testable in plain node: apps/web-server/scripts/consult-card-smoke.ts.
 */

export interface ConsultModel {
	provider: string;
	model: string;
	label?: string;
}

export interface L1bFingerprint {
	algorithm: string;
	value: string;
}

/**
 * One completed exchange in a stacked consult (§8.1). The stack is client-side
 * only — each entry is a fresh point-in-time read of B's memory, so it keeps its
 * own fingerprint + as-of (§8.5). Accumulated as the user follows up, and moved
 * as one unit at transfer (§8.7).
 */
export interface ConsultExchange {
	question: string;
	answer: string;
	l1bFingerprint: L1bFingerprint | null;
	generatedAt: string | null;
	/** The room's memory-write time captured at request (the "as of" label). */
	asOfCheckpointAt: string | null;
	/** The time the user asked this exchange (the handoff header's request range). */
	requestedAt: string | null;
}

/**
 * none      — no consult (initial, and after dismiss).
 * streaming — request sent / running; deltas fill the live view.
 * done       — consult_end arrived; `text` is authoritative, provenance known.
 * stopped   — the user stopped it; partial `text` kept (greyed by the card).
 * failed     — the server errored without a user stop; partial `text` kept.
 */
export type ConsultPhase = "none" | "streaming" | "done" | "stopped" | "failed";

export interface ConsultState {
	phase: ConsultPhase;
	/** Client-generated id, echoed on every server event; the stale-event key. */
	consultId: string | null;
	targetRoomId: string | null;
	/** Best-known display name for the consulted room (chip + sublines). */
	targetDisplayName: string | null;
	/** The question, kept for the card's question line and for MR-5 transfer. */
	question: string | null;
	/**
	 * ISO-8601 time the user made the request (set at `request`). The handoff
	 * block's "Requested … on" line uses this — the request time, not the answer
	 * time (§2.1). Distinct from `generatedAt` (when the answer was produced).
	 */
	requestedAt: string | null;
	/** The worker model, learned at `consult_started`. */
	model: ConsultModel | null;
	/** Accumulated deltas while streaming; replaced by the authoritative end text. */
	text: string;
	/** Folded to the pill (the consult runs identically either way). */
	minimized: boolean;
	/**
	 * The consulted room's last memory-write time, captured at request from the
	 * room status the client already holds. Drives the "as of <date>" recency
	 * labelling — distinct from `generatedAt` (the generation time).
	 */
	asOfCheckpointAt: string | null;
	/** Provenance, known at `consult_end`. */
	l1bFingerprint: L1bFingerprint | null;
	generatedAt: string | null;
	/** e.g. a "recent context awaiting Learn" lag warning for needs_absorb rooms. */
	warnings: string[];
	/** True once the user asked to stop — routes the next error to `stopped`. */
	stopRequested: boolean;
	/** The server's plain message for the stopped/failed subline. */
	errorMessage: string | null;
	/**
	 * Stacked consult (§8.1): the earlier COMPLETED exchanges, oldest-first. The
	 * current exchange (question/text/fingerprint above) is NOT in here until a
	 * follow-up supersedes it. A failed/stopped follow-up preserves this stack.
	 */
	exchanges: ConsultExchange[];
	/**
	 * §8.6: the last follow-up tripped the prompt-budget ceiling. The card disables
	 * the follow-up input and shows the "no longer fits" state; Dismiss/Transfer
	 * remain. Set from a `consult_error` carrying code "prompt_overflow".
	 */
	overflow: boolean;
}

export type ConsultAction =
	/** The composer resolved a leading mention and handed off (Consult MR-3). */
	| {
			type: "request";
			consultId: string;
			targetRoomId: string;
			question: string;
			requestedAt: string;
			targetDisplayName?: string | null;
			asOfCheckpointAt?: string | null;
	  }
	| { type: "started"; consultId: string; targetRoomId: string; targetDisplayName: string; model: ConsultModel }
	| { type: "delta"; consultId: string; delta: string }
	| { type: "end"; consultId: string; text: string; l1bFingerprint: L1bFingerprint; generatedAt: string; warnings?: string[] }
	/** `code` distinguishes machine reasons (e.g. "prompt_overflow", §8.6) from plain failures. */
	| { type: "error"; consultId: string; message: string; code?: string }
	/**
	 * Stacked consult (§8.1): ask the SAME room a follow-up. Legal only from `done`,
	 * or as a RETRY from a failed/stopped follow-up that still has a completed stack
	 * (a failed follow-up preserves the stack). Re-enters `streaming` with a fresh id.
	 */
	| {
			type: "followUp";
			consultId: string;
			question: string;
			requestedAt: string;
			asOfCheckpointAt?: string | null;
	  }
	/** The user pressed Stop; the host sends `consult_abort` (effect). */
	| { type: "abort_requested" }
	/** Fold to the pill; the consult keeps running. */
	| { type: "minimize" }
	/** Re-open the expanded card from the pill. */
	| { type: "open" }
	/** Remove the card/pill entirely. */
	| { type: "dismiss" }
	/** Connection/room teardown: forget everything. */
	| { type: "reset" };

export type ConsultEffect =
	/**
	 * Send the consult WS frame to start the worker. `priorExchanges` is present on
	 * a follow-up (§8.1) — B's own earlier Q/A, re-fed so it can build on them.
	 */
	| { kind: "send_consult"; consultId: string; targetRoomId: string; question: string; priorExchanges?: { question: string; answerMarkdown: string }[] }
	/** Send the abort WS frame. */
	| { kind: "send_abort"; consultId: string }
	/** A second consult was requested while one is active — host logs it. */
	| { kind: "rejected"; reason: string }
	/** A stale or out-of-phase event was dropped — host may log for tracing. */
	| { kind: "dropped"; reason: string; consultId: string | null };

export interface ConsultResult {
	state: ConsultState;
	effects: ConsultEffect[];
}

export function createConsultState(): ConsultState {
	return {
		phase: "none",
		consultId: null,
		targetRoomId: null,
		targetDisplayName: null,
		question: null,
		requestedAt: null,
		model: null,
		text: "",
		minimized: false,
		asOfCheckpointAt: null,
		l1bFingerprint: null,
		generatedAt: null,
		warnings: [],
		stopRequested: false,
		errorMessage: null,
		exchanges: [],
		overflow: false,
	};
}

/** Active = there is a card or pill on screen (streaming, or an undismissed result). */
export function isConsultActive(state: ConsultState): boolean {
	return state.phase !== "none";
}

/** The current exchange, snapshotted from the top-level fields (§8.7 transfer). */
function currentExchange(state: ConsultState): ConsultExchange {
	return {
		question: state.question ?? "",
		answer: state.text,
		l1bFingerprint: state.l1bFingerprint,
		generatedAt: state.generatedAt,
		asOfCheckpointAt: state.asOfCheckpointAt,
		requestedAt: state.requestedAt,
	};
}

/**
 * The full stack in order (§8.7): the completed earlier exchanges plus the
 * current one when it has completed (done). Used by the card (history/drift) and
 * by transfer to move the WHOLE conversation as one unit.
 */
export function consultStack(state: ConsultState): ConsultExchange[] {
	if (state.phase === "done") return [...state.exchanges, currentExchange(state)];
	return state.exchanges;
}

/**
 * Drift (§8.5): the consulted room's memory changed between questions — the
 * per-exchange fingerprints across the stack are not all identical. Only defined
 * fingerprints are compared; a single (or no) fingerprint is never drift.
 */
export function consultHasDrift(state: ConsultState): boolean {
	const values = consultStack(state)
		.map((exchange) => (exchange.l1bFingerprint ? `${exchange.l1bFingerprint.algorithm}:${exchange.l1bFingerprint.value}` : null))
		.filter((value): value is string => value != null);
	return new Set(values).size > 1;
}

/**
 * Whether the done/failed/stopped card should offer a follow-up input (§8.1):
 * from `done`, or as a retry from a failed/stopped follow-up that still has a
 * completed stack. Never while overflowed (§8.6) — the ceiling disables it.
 */
export function canFollowUp(state: ConsultState): boolean {
	if (state.overflow) return false;
	if (state.phase === "done") return true;
	return (state.phase === "failed" || state.phase === "stopped") && state.exchanges.length > 0;
}

/**
 * Whether the card can still transfer completed work (§8.7). `done` always can;
 * a failed/stopped follow-up can transfer the preserved stack (§8.1). Exchange 1
 * failing (empty stack) cannot — that is today's dismiss-only error footer.
 */
export function canTransferConsult(state: ConsultState): boolean {
	if (state.phase === "done") return true;
	return (state.phase === "failed" || state.phase === "stopped") && state.exchanges.length > 0;
}

/** A server event matches the live consult only when its id is the active one. */
function isForActiveConsult(state: ConsultState, consultId: string): boolean {
	return state.consultId !== null && state.consultId === consultId;
}

export function reduceConsult(previous: ConsultState, action: ConsultAction): ConsultResult {
	const effects: ConsultEffect[] = [];

	switch (action.type) {
		case "reset":
			return { state: createConsultState(), effects };

		case "request": {
			// One consult at a time client-side: while one is active, keep the
			// current card and reject the new request (the host logs it — no toast).
			if (isConsultActive(previous)) {
				effects.push({ kind: "rejected", reason: "A consult is already active." });
				return { state: previous, effects };
			}
			const state: ConsultState = {
				...createConsultState(),
				// Expanded-on-send: the card opens expanded the moment the consult
				// starts (v1 default). Minimizing folds it to the pill.
				phase: "streaming",
				consultId: action.consultId,
				targetRoomId: action.targetRoomId,
				targetDisplayName: action.targetDisplayName ?? action.targetRoomId,
				question: action.question,
				requestedAt: action.requestedAt,
				asOfCheckpointAt: action.asOfCheckpointAt ?? null,
			};
			effects.push({ kind: "send_consult", consultId: action.consultId, targetRoomId: action.targetRoomId, question: action.question });
			return { state, effects };
		}

		case "started": {
			if (!isForActiveConsult(previous, action.consultId)) {
				effects.push({ kind: "dropped", reason: "started for a non-active consult", consultId: action.consultId });
				return { state: previous, effects };
			}
			// The server confirms the target and names the worker model. Keep the
			// phase (streaming) and any deltas that raced ahead of this event.
			return {
				state: { ...previous, targetRoomId: action.targetRoomId, targetDisplayName: action.targetDisplayName, model: action.model },
				effects,
			};
		}

		case "delta": {
			if (!isForActiveConsult(previous, action.consultId) || previous.phase !== "streaming") {
				effects.push({ kind: "dropped", reason: "delta outside the active stream", consultId: action.consultId });
				return { state: previous, effects };
			}
			return { state: { ...previous, text: previous.text + action.delta }, effects };
		}

		case "end": {
			if (!isForActiveConsult(previous, action.consultId) || previous.phase !== "streaming") {
				effects.push({ kind: "dropped", reason: "end outside the active stream", consultId: action.consultId });
				return { state: previous, effects };
			}
			// consult_end.text is authoritative — it replaces the live deltas.
			// stopRequested resets here: in an abort-vs-end race where the end wins,
			// the armed flag must not leak into `done` (hardening 2026-07-11 — benign
			// today, but no done-state should ever carry a live stop request).
			return {
				state: {
					...previous,
					phase: "done",
					text: action.text,
					l1bFingerprint: action.l1bFingerprint,
					generatedAt: action.generatedAt,
					warnings: action.warnings ?? [],
					stopRequested: false,
				},
				effects,
			};
		}

		case "error": {
			if (!isForActiveConsult(previous, action.consultId) || previous.phase !== "streaming") {
				effects.push({ kind: "dropped", reason: "error outside the active stream", consultId: action.consultId });
				return { state: previous, effects };
			}
			// Stopped vs failed is decided by whether this client asked to abort,
			// not by the server's wording. Partial text is kept either way. A failed/
			// stopped follow-up preserves the accumulated stack (§8.1) — we never
			// touch `exchanges` here. §8.6: an overflow error (machine code) flags the
			// card to show the "no longer fits" state and disable the follow-up input.
			return {
				state: { ...previous, phase: previous.stopRequested ? "stopped" : "failed", errorMessage: action.message, overflow: action.code === "prompt_overflow" },
				effects,
			};
		}

		case "followUp": {
			// Legal only from `done`, or as a retry from a failed/stopped follow-up
			// that still has a completed stack (§8.1). From `done` the current answer
			// becomes a completed exchange; from a failed/stopped retry the current
			// (incomplete) exchange is discarded and the prior stack is preserved.
			const fromDone = previous.phase === "done";
			const retryAfterFailure = (previous.phase === "failed" || previous.phase === "stopped") && previous.exchanges.length > 0;
			if (previous.overflow || (!fromDone && !retryAfterFailure)) {
				effects.push({ kind: "rejected", reason: "Follow-up is only available on a completed consult." });
				return { state: previous, effects };
			}
			const priorStack = fromDone ? [...previous.exchanges, currentExchange(previous)] : previous.exchanges;
			const state: ConsultState = {
				...previous,
				phase: "streaming",
				consultId: action.consultId,
				exchanges: priorStack,
				question: action.question,
				requestedAt: action.requestedAt,
				asOfCheckpointAt: action.asOfCheckpointAt ?? null,
				// Re-enter a fresh stream: clear the current-exchange fields, keep the
				// target + model. `minimized` is preserved (a follow-up from the pill
				// keeps looping folded; from the card it was already expanded).
				text: "",
				l1bFingerprint: null,
				generatedAt: null,
				warnings: [],
				stopRequested: false,
				errorMessage: null,
				overflow: false,
			};
			effects.push({
				kind: "send_consult",
				consultId: action.consultId,
				targetRoomId: previous.targetRoomId ?? "",
				question: action.question,
				priorExchanges: priorStack.map((exchange) => ({ question: exchange.question, answerMarkdown: exchange.answer })),
			});
			return { state, effects };
		}

		case "abort_requested": {
			// Only a running consult can be stopped; arm the flag and ask the
			// server to abort. The stop resolves when the server's error arrives.
			if (previous.phase !== "streaming" || !previous.consultId) return { state: previous, effects };
			effects.push({ kind: "send_abort", consultId: previous.consultId });
			return { state: { ...previous, stopRequested: true }, effects };
		}

		case "minimize": {
			if (previous.phase === "none") return { state: previous, effects };
			return { state: { ...previous, minimized: true }, effects };
		}

		case "open": {
			if (previous.phase === "none") return { state: previous, effects };
			return { state: { ...previous, minimized: false }, effects };
		}

		case "dismiss":
			// Remove the card/pill entirely, in any state.
			return { state: createConsultState(), effects };
	}
}

/** `sha256:ab12…9f4e` — the abbreviated fingerprint shown in the footer meta. */
export function abbreviateFingerprint(fingerprint: L1bFingerprint | null): string | null {
	if (!fingerprint) return null;
	const value = fingerprint.value.trim();
	if (!value) return null;
	const short = value.length > 9 ? `${value.slice(0, 4)}…${value.slice(-4)}` : value;
	return `${fingerprint.algorithm}:${short}`;
}
