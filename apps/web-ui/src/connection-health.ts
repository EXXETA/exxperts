// Honest connection health for the web UI.
//
// The raw socket boolean the room chat uses (`connected`) answers "is a socket
// open right this instant". That is the right question for gating a send and
// the wrong question for telling a user something is broken: it is false for
// the whole of app boot, false for the moment between closing one socket and
// opening its replacement (entering a room, leaving one, resuming, rebinding
// after a checkpoint), and false for a blink whenever a socket is swapped.
// Surfacing it directly produced the reported symptom: a corner that announces
// trouble constantly while nothing is wrong.
//
// This reducer answers the question worth surfacing instead: "has the app been
// unable to reach its engine long enough, and after enough real retries, that
// saying so is honest". Three gates have to pass together:
//
//   1. Nothing is open now.
//   2. At least MIN_FAILED_ATTEMPTS connection attempts have actually failed —
//      the drop itself plus at least one retry that also failed. A single blip
//      that the next attempt heals never counts.
//   3. The unhealthy run has lasted past a grace window. The window is longer
//      before the app has ever connected (first_connect), because that stretch
//      is boot, where slowness is normal and a warning would be a lie.
//
// Two things that look like recoveries are not, and the reducer refuses both:
//
//   * Reaching OPEN is not recovery. A server that accepts the upgrade and
//     drops it immediately can flap forever, and an `opened` that cleared the
//     run would restart the grace window on every cycle, so the app would stay
//     silent through an outage that never ends. Only an open that SURVIVES
//     (a `settled`, driven by the first inbound frame or a dwell timer,
//     whichever lands first) ends an unhealthy run.
//   * A deliberate swap is not recovery either. It stops the run growing,
//     because navigating is not a fault, but it does not erase a run already
//     under way: a user clicking between rooms against a dead server would
//     otherwise postpone the warning for as long as they keep clicking.
//
// Pure and host-free on purpose (like assistant-stream.ts) so the sequences
// that used to produce false alarms, and the ones that used to produce eternal
// silence, can both be replayed in a smoke.

/** A connect attempt has to fail this many times before a warning is honest. */
export const MIN_FAILED_ATTEMPTS = 2;

/** Grace before a warning, once the app has been connected at least once. */
export const RECONNECT_GRACE_MS = 12_000;

/**
 * Grace before the first-ever connection lands. Longer, because this window is
 * app boot: the engine may still be starting, and every honest outcome there is
 * "wait a moment", not "something is broken".
 */
export const FIRST_CONNECT_GRACE_MS = 30_000;

/**
 * How long an open socket has to last, absent any inbound frame, before the
 * connection counts as real. A healthy bind sends its first frame well inside
 * this, so recovery is normally instant; only a silent flap waits it out.
 */
export const OPEN_DWELL_MS = 2_000;

/**
 * How long a socket may sit in CONNECTING before the host gives up on it. A
 * socket wedged mid-handshake (a port that listens but never completes the
 * upgrade) produces no close event of its own, so without this deadline it
 * would never fail, never retry, and never warn.
 */
export const CONNECT_DEADLINE_MS = 10_000;

export interface ConnectionHealthState {
	/** A socket is open right now. */
	open: boolean;
	/** Latch: a socket has been open at least once since the page loaded. */
	everOpen: boolean;
	/** Connection attempts that failed since the last connection that survived. */
	failedAttempts: number;
	/** When the current unhealthy run began, or null when there is no run. */
	unhealthySince: number | null;
	/** What the UI may surface: a sustained, confirmed inability to connect. */
	warn: boolean;
}

export type ConnectionHealthAction =
	/** A socket reached OPEN. Not yet proof of anything: see `settled`. */
	| { type: "opened"; now: number }
	/**
	 * An open socket proved itself, by carrying a frame or by simply lasting
	 * OPEN_DWELL_MS. This, and only this, ends an unhealthy run.
	 */
	| { type: "settled"; now: number }
	/** A connect attempt failed, or a live socket died unexpectedly. */
	| { type: "attempt_failed"; now: number }
	/**
	 * A socket was closed on purpose because it is being replaced (room enter,
	 * room leave, resume, checkpoint rebind). Not a failure, and not a cure.
	 */
	| { type: "swapped"; now: number }
	/** Time passed; re-evaluate whether the grace window has elapsed. */
	| { type: "tick"; now: number };

export function createConnectionHealthState(): ConnectionHealthState {
	return { open: false, everOpen: false, failedAttempts: 0, unhealthySince: null, warn: false };
}

/** The grace window this state has to outlast before a warning is honest. */
export function graceForState(state: ConnectionHealthState): number {
	return state.everOpen ? RECONNECT_GRACE_MS : FIRST_CONNECT_GRACE_MS;
}

/**
 * Raises the warning when the three gates pass. It never LOWERS one: only a
 * connection that survived (`settled`) is allowed to say the trouble is over,
 * so a socket that flaps open for a moment cannot strobe the banner off and on.
 */
function withWarn(state: ConnectionHealthState, now: number): ConnectionHealthState {
	if (state.warn) return state;
	const warn =
		!state.open &&
		state.unhealthySince !== null &&
		state.failedAttempts >= MIN_FAILED_ATTEMPTS &&
		now - state.unhealthySince >= graceForState(state);
	return warn ? { ...state, warn } : state;
}

export function reduceConnectionHealth(state: ConnectionHealthState, action: ConnectionHealthAction): ConnectionHealthState {
	switch (action.type) {
		case "opened":
			// Reaching OPEN clears nothing. It also must not blink an existing
			// warning off: a flap would strobe the banner, and the honest read of
			// a connection that keeps dying the instant it opens is still "lost".
			return { ...state, open: true, everOpen: true };
		case "settled":
			// The one real recovery. Only reachable from an open socket, so a
			// stale timer that fires after a close cannot wipe a live run.
			if (!state.open) return state;
			return { open: true, everOpen: true, failedAttempts: 0, unhealthySince: null, warn: false };
		case "swapped":
			// Navigating is not a fault, so nothing is counted here. It is not a
			// recovery either: the run keeps its start time and its tally, or a
			// user moving between rooms against a dead server could hold the
			// warning off forever.
			return withWarn({ ...state, open: false }, action.now);
		case "attempt_failed":
			return withWarn(
				{
					...state,
					open: false,
					failedAttempts: state.failedAttempts + 1,
					unhealthySince: state.unhealthySince ?? action.now,
				},
				action.now,
			);
		case "tick":
			return withWarn(state, action.now);
	}
}

/**
 * Milliseconds until this state could first turn `warn` on, or null when no
 * amount of waiting alone would (already warning, healthy, or not enough failed
 * attempts yet — the next failure re-arms).
 */
export function msUntilWarn(state: ConnectionHealthState, now: number): number | null {
	if (state.warn || state.open || state.unhealthySince === null) return null;
	if (state.failedAttempts < MIN_FAILED_ATTEMPTS) return null;
	return Math.max(0, state.unhealthySince + graceForState(state) - now);
}
