// The one notice when the room's Memory model cannot be reached, or is too
// small for the room's memory, shared by Remember, Memorize and Review: one
// sentence in the product's words, and the
// real ways out (Try again, Choose another model, and Sign in when that is the
// cause). The provider's raw words never reach it; they go to the console.
// Also the calm line a busy model's wait shows, with the next try's time.

import { ApiRequestError } from "../api";

export type ModelNoticeDetail = "signed-out" | "quota" | "not-offered" | "not-on-account" | "not-answering" | "still-busy" | "too-small";

export interface ModelNotice {
	detail: ModelNoticeDetail;
	/** The sentence the notice leads with. */
	sentence: string;
	/** The provider to sign in to, when sign-in is the cause and it is known. */
	provider?: string;
}

/** The model's wait, as the server publishes it: busy, or not reached yet. */
export interface ModelWait {
	cause: "busy" | "unreached";
	detail: string;
	attempt: number;
	nextTryAt: string;
	/** An earlier wait already said the model is busy. */
	again?: boolean;
}

/** The notice for a failed request, when the failure is the Memory model not being reachable; null for every other failure. */
export function modelNoticeFromError(error: unknown): ModelNotice | null {
	if (!(error instanceof ApiRequestError)) return null;
	const details = (error.details ?? {}) as { detail?: string; provider?: string };
	if (error.code === "model_unreachable" && isNoticeDetail(details.detail)) {
		console.warn("[exxperts] the Memory model could not be reached:", details.detail);
		return { detail: details.detail, sentence: error.message, ...(details.provider ? { provider: details.provider } : {}) };
	}
	if (error.code === "provider_signed_out") return { detail: "signed-out", sentence: error.message, ...(details.provider ? { provider: details.provider } : {}) };
	if (error.code === "room_model_unavailable") return { detail: "not-offered", sentence: error.message };
	// The Memory model's window no longer holds the room's memory: the way out is another model.
	if (error.code === "memory_model_too_small") return { detail: "too-small", sentence: error.message };
	return null;
}

function isNoticeDetail(value: unknown): value is ModelNoticeDetail {
	return value === "signed-out" || value === "quota" || value === "not-offered" || value === "not-on-account" || value === "not-answering" || value === "still-busy";
}

/** The clock time a person reads, in their own locale: "16:24". */
function clockTime(iso: string): string {
	const at = new Date(iso);
	// The app's clock, as Memory says it: "17:27".
	return Number.isNaN(at.getTime()) ? "" : `${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}`;
}

/**
 * The line a model's wait shows (draft wording). It changes on every try:
 * a first call that could not connect says so, a dropped connection says so,
 * a busy model's first wait names the wait, every later one says it is still
 * busy, and each names the time of the next try.
 */
export function modelWaitLine(wait: ModelWait): string {
	const at = clockTime(wait.nextTryAt);
	if (wait.cause === "unreached") return `Can't reach the Memory model right now. Trying again at ${at}.`;
	if (wait.detail === "stalled" || wait.detail === "timed-out") return `The answer stopped coming. Asking again at ${at}.`;
	if (wait.detail === "connection") return `The connection to the Memory model dropped. Trying again at ${at}.`;
	if (!wait.again) return `The Memory model is busy. Trying again at ${at}.`;
	return `Still busy. Trying again at ${at}.`;
}

export function ModelNoticePanel({ notice, kept, onTryAgain, onChooseModel, onSignIn, onClose, busy }: {
	notice: ModelNotice;
	/** What is kept, in one short sentence, when there is something to say. */
	kept?: string | null;
	onTryAgain?: () => void;
	onChooseModel?: () => void;
	/** Shown only when sign-in is the cause. */
	onSignIn?: (provider: string | undefined) => void;
	/** Where the notice stands alone in a dialog, Close is one of its ways out. */
	onClose?: () => void;
	busy?: boolean;
}) {
	const signIn = notice.detail === "signed-out" && onSignIn;
	// A model too small for this memory meets the same refusal again: its way out is another model.
	const tryAgain = notice.detail === "too-small" ? undefined : onTryAgain;
	return (
		<div className="memory-action-note model-notice" role="status">
			<p>{notice.sentence}{kept ? ` ${kept}` : ""}</p>
			<div className="absorb-run-note-actions">
				{tryAgain && <button type="button" className="rs-btn" disabled={busy} onClick={tryAgain}>Try again</button>}
				{onChooseModel && <button type="button" className="rs-btn" disabled={busy} onClick={onChooseModel}>Choose another model</button>}
				{signIn && <button type="button" className="rs-btn rs-btn-primary" disabled={busy} onClick={() => onSignIn(notice.provider)}>Sign in</button>}
				{onClose && <button type="button" className="rs-btn" onClick={onClose}>Close</button>}
			</div>
		</div>
	);
}
