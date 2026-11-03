// Where a message the person sends while the room answers goes. The server
// decides from its own state, never from the page's items, which lag behind
// the paced reveal: a page that thinks the model only writes could otherwise
// cut a file write in half.

/** The steer frame as the page sends it, read once where it enters. */
export interface SteerRequest {
	id: string;
	text: string;
	/** How many characters of the answer being written the page had shown when the person pressed Enter. */
	shown?: number;
	/** The question that waits was open before the person started typing: their message declines it. */
	declines: boolean;
	/** Cmd/Ctrl+Enter: now, even through a step or through text being written. */
	now: boolean;
}

/** A frame's `shown`: how many characters of the answer the page had shown, or undefined for anything that is no count. */
export function readShownChars(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : undefined;
}

export function readSteerRequest(msg: Record<string, unknown>): SteerRequest {
	const shown = readShownChars(msg.shown);
	return {
		id: String(msg.id ?? ""),
		text: String(msg.text ?? ""),
		...(shown !== undefined ? { shown } : {}),
		declines: msg.declines === true,
		now: msg.now === true,
	};
}

/**
 * What the running answer does right now.
 * - question: a step waits for the person's OK.
 * - step: a tool runs, or the model is writing a tool call, or one waits to run, or the runtime waits to ask again.
 * - text: the model writes text or thinks.
 * - asking: the model has been asked and nothing came back yet.
 * - ending: the model finished its last message and the run winds down.
 */
export type AnswerPhase = "question" | "step" | "text" | "asking" | "ending";

interface MessageLike { role?: string; content?: unknown; stopReason?: string }

const hasToolCall = (message: MessageLike | undefined): boolean => Array.isArray(message?.content) && message!.content.some((part: any) => part?.type === "toolCall");

/** `providerTools`: tools the provider runs inside the message being written (its own web search), started and not yet ended. */
export function answerPhase(state: { questionOpen: boolean; pendingToolCalls: number; retrying: boolean; providerTools?: number; streaming?: MessageLike; last?: MessageLike }): AnswerPhase {
	if (state.questionOpen) return "question";
	if (state.pendingToolCalls > 0 || state.retrying || (state.providerTools ?? 0) > 0) return "step";
	if (state.streaming?.role === "assistant") return hasToolCall(state.streaming) ? "step" : "text";
	const last = state.last;
	// Calls cut by the length limit still get results: the runtime fails them and asks the model again.
	if (last?.role === "assistant") return hasToolCall(last) && (last.stopReason === "toolUse" || last.stopReason === "length") ? "step" : "ending";
	return "asking";
}

/**
 * - steer: the runtime takes it at its next check (after the step, or right after the answer ends: Enter never cuts an answer, not even one that only thinks).
 * - steer-then-decline: it goes in first, then the waiting question is declined once.
 * - cut: the answer stops at the words on screen; the message goes next with the note.
 * - cut-quiet: Cmd/Ctrl+Enter with nothing shown yet (asked and nothing back, or only thinking); the answer stops and the message joins the question, with no note and no line.
 */
export type SteerWay = "steer" | "steer-then-decline" | "cut" | "cut-quiet";

/**
 * What the server answers a steer frame with.
 * - steer_waiting: the runtime holds it for its next check; steer_taken says when it went in. `afterText`: the model already finished its text, so it goes in right after it.
 * - steer_cut: the answer stops for it and the page sends it as the next message; `quiet` when nothing was shown yet.
 * - steer_refused: no answer runs to take it; the page sends it as its own message.
 */
export type SteerRouted =
	| { type: "steer_waiting"; id: string; afterText?: true }
	| { type: "steer_cut"; id: string; quiet: boolean }
	| { type: "steer_refused"; id: string };

/** The bubble a message sent while the room answers shows as, on the page and in a landing that took it. */
export function bubbleIdOf(id: string): string {
	return `out-${id}`;
}

export function steerWay(phase: AnswerPhase, request: Pick<SteerRequest, "shown" | "declines" | "now">): SteerWay {
	if (phase === "question") return request.now ? "cut" : request.declines ? "steer-then-decline" : "steer";
	if (phase === "step") return request.now ? "cut" : "steer";
	if (phase === "ending") return "steer";
	// Asked, thinking or text on screen: Enter lets it finish and the message
	// goes in at the next step or right after the answer, as other agent tools
	// do; only Cmd/Ctrl+Enter stops it, on every model. With nothing shown yet
	// (asked, or only thinking) that stop needs no note.
	if (!request.now) return "steer";
	return phase === "asking" || (request.shown ?? 0) === 0 ? "cut-quiet" : "cut";
}
