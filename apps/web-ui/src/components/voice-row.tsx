import type { ConversationState } from "../voice/conversation";

/**
 * One line above the text field while the room listens or talks: a ring, a
 * status word and the words being heard. Nothing is shown while the
 * microphone is idle, so the composer looks as it always did until the talk
 * key goes down. The transcript above keeps filling with your messages and
 * the answers; the row itself never writes anything.
 */

/** The tail of a long utterance is what matters while it is still being said. */
function tail(text: string, max = 160): string {
	return text.length > max ? `…${text.slice(text.length - max)}` : text;
}

export function VoiceRow({ state, talkKeyLabel }: { state: ConversationState; talkKeyLabel: string }) {
	if (state.status === "idle") return null;
	const word = state.status === "working" ? (state.detail ?? "Working") : state.status === "starting" ? "Starting" : state.status === "listening" ? "Listening" : "Speaking";
	return (
		<div className={`voice-row ${state.status}`} role="status" aria-live="polite" aria-label="Voice">
			<span className="voice-ring" aria-hidden="true" />
			<span className="voice-status">{word}</span>
			<span className="voice-partial">
				{state.status === "starting"
					? <span className="voice-hint">Opening the microphone…</span>
					: state.status === "listening"
						? (state.partial ? tail(state.partial) : <span className="voice-hint">Release {talkKeyLabel} to send.</span>)
						: state.status === "speaking"
							? <span className="voice-hint">Hold {talkKeyLabel} or press Escape to stop.</span>
							: null}
			</span>
		</div>
	);
}
