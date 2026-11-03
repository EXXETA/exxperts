// Why a turn ended before its answer did, as the server says it on the frame
// that ends the turn (`endedBy`), and the words both sides use for it. Pure,
// so the page can import it and pick the cut answer's line from this field,
// never from its own memory of what happened.

/** Stop in this window, the person's message cutting it ("next": Cmd/Ctrl+Enter or Send now), the app stopping, the person leaving, or the server ending the turn as failed (a turn left running past its time). A model call that failed is told by its own `failure`, not here. */
export type TurnEndedBy = "stop" | "next" | "server-stop" | "left" | "failed";

export function readTurnEndedBy(value: unknown): TurnEndedBy | null {
	return value === "stop" || value === "next" || value === "server-stop" || value === "left" || value === "failed" ? value : null;
}

export const STOP_CUT_ANSWER_SENTENCE = "exxperts stopped before this answer finished. Send your message again if something is missing.";

/** What the model is told about a question the person's Stop closed: it starts every such step's result. */
export const STOPPED_BEFORE_ANSWER_SENTENCE = "The person pressed Stop before answering, so this was not done.";
