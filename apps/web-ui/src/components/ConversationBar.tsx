import type { ConversationState, ConversationStatus } from "../voice/conversation";

/**
 * The bar that takes the text field's place while a conversation is on: a
 * ring that says what the room is doing, the words it hears you say, and End.
 * The transcript above keeps filling with your messages and the answers; the
 * bar itself never writes anything.
 */

const STATUS_WORD: Record<ConversationStatus, string> = {
	starting: "Starting",
	listening: "Listening",
	working: "Working",
	speaking: "Speaking",
};

/** The tail of a long utterance is what matters while it is still being said. */
function tail(text: string, max = 160): string {
	return text.length > max ? `…${text.slice(text.length - max)}` : text;
}

export function ConversationBar({ state, onEnd }: { state: ConversationState; onEnd: () => void }) {
	const word = state.status === "working" && state.detail ? state.detail : STATUS_WORD[state.status];
	return (
		<div className={`composer-box conversation-bar ${state.status}`} role="status" aria-live="polite" aria-label="Conversation">
			<span className="conversation-ring" aria-hidden="true" />
			<span className="conversation-status">{word}</span>
			<span className="conversation-partial">
				{state.status === "starting"
					? <span className="conversation-hint">Opening the microphone…</span>
					: state.status === "listening"
						? (state.partial ? tail(state.partial) : <span className="conversation-hint">Say something. It is sent when you pause.</span>)
						: null}
			</span>
			<button
				className="icon-btn icon-btn-square conversation-end"
				type="button"
				aria-label="End the conversation"
				title="End the conversation. Escape does the same. Your questions and the answers stay in the room."
				onClick={onEnd}
			>✕</button>
		</div>
	);
}
