// The message box's greyed hint: what Enter does in each state, from one
// ordered list where the first row whose state holds gives the words, in the
// Mac, Windows and touch forms. composer-hint-smoke.ts reads every row.

/** What the message box's greyed hint is chosen from. */
export interface ComposerHintState {
	/** The room's name as the topbar shows it. */
	room: string;
	/** The room stopped on its model (signed out, no longer offered) or a full save closed the conversation: the notice carries the ways on. */
	asToday: boolean;
	connected: boolean;
	reconnect: "idle" | "reconnecting" | "failed";
	/** The connection came back and the answer it dropped is still being caught up. */
	reconnectingTurn: boolean;
	/** Another window has the room. */
	elsewhere: boolean;
	/** A model switch still settling, by the model's name. */
	switchingTo: string | null;
	stopping: boolean;
	/** A step of the answer waits for the person's OK. */
	stepAsks: boolean;
	/** The room writes, thinks or runs a step. */
	answering: boolean;
	/** How this computer writes the keys: no chord on a touch screen. */
	keys: "mac" | "windows" | "touch";
}

/**
 * The box's greyed hint says what Enter does in each state. One ordered
 * list: the first row whose state holds gives the words.
 */
const COMPOSER_HINTS: ReadonlyArray<{ when: (state: ComposerHintState) => boolean; words: (state: ComposerHintState) => string }> = [
	{ when: (state) => state.asToday, words: (state) => `Ask ${state.room}…` },
	{ when: (state) => !state.connected && state.reconnect === "failed", words: () => "Not connected, press Reconnect" },
	{ when: (state) => !state.connected, words: () => "Waiting for the connection…" },
	{ when: (state) => state.reconnectingTurn, words: () => "Reconnecting…" },
	{ when: (state) => state.elsewhere, words: (state) => `Ask ${state.room}…` },
	{ when: (state) => state.switchingTo !== null, words: (state) => `Switching to ${state.switchingTo}…` },
	{ when: (state) => state.stopping, words: () => "Stopping current response…" },
	{ when: (state) => state.stepAsks, words: (state) => (state.keys === "touch" ? "Sending denies the step above" : "Sending a message denies the step above") },
	{ when: (state) => state.answering, words: (state) => (state.keys === "mac" ? "Queue a message, ⌘↵ sends now" : state.keys === "windows" ? "Queue a message, Ctrl+Enter sends now" : "Queue a message") },
	{ when: () => true, words: (state) => `Ask ${state.room}…` },
];

export function composerHint(state: ComposerHintState): string {
	return COMPOSER_HINTS.find((row) => row.when(state))!.words(state);
}
