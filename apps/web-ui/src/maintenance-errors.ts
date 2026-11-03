import { anthropicKeyNeedsWorkspace, credentialGoneWords, signInFailed } from "../../web-server/src/model-not-offered";
import { sharedServerRole, knownRemoteClientContext } from "./remote-client-context";
import { isStaleMaintenanceMessage } from "./maintenance-warnings";
import { isPlainProductSentence, isPlainRememberSentence, rememberDamagedSentence, rememberFailureSentence, RECENT_SESSIONS_BLOCK_CAP } from "./remember-read";
import type { AbsorbAvailability } from "./types";

// A credential the Memory model cannot use, in the frame of the step's other
// sentences. Read only from a worker failure's own detail, never from
// arbitrary messages, with the server's matchers (model-not-offered.ts).
function maintenanceCredentialLine(detail: string): string | null {
	// On a shared server a member cannot change the AI setup, and nobody signs in there.
	const role = sharedServerRole(knownRemoteClientContext());
	const memberWayOn = "Choose another Memory model in Room settings, Model, or tell your admin.";
	// A workspace 400 is always a key.
	if (anthropicKeyNeedsWorkspace(detail)) {
		const gone = credentialGoneWords("key-no-workspace");
		return `The Memory model ${gone.state}. No memory was updated. ${role === "member" ? memberWayOn : `${gone.again} in Settings, AI setup, then run this step again.`}`;
	}
	// A missing or refused key, or an ended sign-in: the runtime says "No API
	// key found" for a signed-out sign-in too, and the page cannot tell a key
	// from a sign-in here.
	if (/^No API key found for/i.test(detail) || signInFailed(detail)) {
		if (role === "member") return `The Memory model's key is missing or was not accepted. No memory was updated. ${memberWayOn}`;
		return `The Memory model's key ${role === "admin" ? "" : "or sign-in "}is missing or was not accepted. No memory was updated. Check it in Settings, AI setup, then run this step again.`;
	}
	return null;
}

// First line only, capped: a provider error can be a whole JSON body.
function shortenWorkerFailureDetail(detail: string): string {
	const line = detail.split("\n")[0].trim();
	return line.length > 160 ? `${line.slice(0, 157)}…` : line;
}

// Request-level rejections and worker refusals used to reach the screen as
// the server's own words — field names ("assessmentHandoff.text is too
// large"), agent ids, token counts. Every one of them now has a sentence that
// says what happened, that memory is unchanged, and what to do from the
// screen the user is on. Returns null for messages the caller formats itself.
function formatMaintenanceRequestError(message: string): string | null {
	if (/assessmentHandoff\.text is too large/i.test(message)) return "The discussion summary handed to the drafting step was too long, so the draft was not generated. No memory was updated. Draft without the discussion, or go back to the assessment.";
	if (/assessmentMarkdown is too large/i.test(message)) return "The assessment is too long for the next step. No memory was updated. Get a shorter one: Reassess from the assessment screen, or open Maintain again.";
	if (/discussion (transcript|messages) (is|are) too large/i.test(message)) return "This discussion has reached its size limit. Generate the proposal from what you have, or go back to the assessment.";
	if (/(discussion message \d+ content|userMessage) is too large/i.test(message)) return "That message is too long (12,000 characters max). Shorten it and send again.";
	if (/userMessage is required/i.test(message)) return "Type a message first.";
	if (/prompt for .+ is too large for the locked model/i.test(message)) {
		// Memorize's guidance offers Review as the shrink path; Review's own
		// guidance cannot (Review is what overflowed), so it only offers a model.
		const remedy = /run Review to shrink/i.test(message)
			? "Run Review to tidy the notes, or choose a Memory model that can read more at once in Room settings, Model, then try again."
			: "Choose a Memory model that can read more at once in Room settings, Model, then run it again.";
		return `This room's memory is too large for the Memory model to read in one request. No memory was updated. ${remedy}`;
	}
	if (/Request failed \(413\)|FST_ERR_CTP_BODY_TOO_LARGE|body is too large|Payload Too Large/i.test(message)) return "The request was too large for the server to accept. No memory was updated. Try again with a shorter discussion, or draft from the assessment alone.";
	if (/Request failed \(\d+\)/.test(message)) return "The server could not complete this step. No memory was updated. Try again in a moment.";
	// A worker turn that ended in the session's own error (F1). The sign-in
	// class gets the one remedy that helps; anything else says the model did
	// not respond, its detail going to the console only.
	const workerFailed = /^.+? failed: ([\s\S]+)$/.exec(message);
	const noApiKey = /^No API key found for/i.test(message);
	if (workerFailed || noApiKey) {
		const credential = maintenanceCredentialLine(workerFailed?.[1] ?? message);
		if (credential) return credential;
		const detail = shortenWorkerFailureDetail(workerFailed?.[1] ?? message);
		console.info(`[maintenance] ${detail}`);
		return "The Memory model could not respond. No memory was updated. Try again; if it repeats, choose another model in Room settings, Model.";
	}
	if (/was aborted before it answered/i.test(message)) return "This step was stopped before the Memory model answered. No memory was updated. Run it again.";
	if (/produced no text/i.test(message)) return "The Memory model returned an empty reply. No memory was updated. Try again.";
	if (/model not found/i.test(message)) return "The Memory model is not available. No memory was updated. Choose another Memory model in Room settings, Model.";
	if (/was cut off at the model's output limit|came back at \d+ characters after \d+ attempt/i.test(message)) return message;
	// The Review ops refusal is written server-side as one product sentence with its remedy; wrapping it would state the non-mutation twice.
	if (/^The Review draft could not be built/.test(message)) return message;
	// Last line of defence: a bare field-name rejection never reaches the screen as-is.
	if (/^[A-Za-z][\w.]* (is|are) (required|too large|invalid)/.test(message) || /must be (user|one of)/.test(message)) {
		console.info(`[maintenance] ${message}`);
		return "The server could not take this request. No memory was updated. Open Maintain again.";
	}
	return null;
}

function formatAbsorbWorkflowError(message: string): string {
	if (isStaleMaintenanceMessage(message)) return "Memory changed while this was open. No memory was updated. Open Maintain again to work from the latest memory.";
	const request = formatMaintenanceRequestError(message);
	if (request) return request;
	if (/token budget exceeded|token limit|hard_stop/i.test(message)) return "This discussion has grown too long to carry on. Continue to the update with what you have agreed so far, or leave the discussion.";
	// The server's own sentences pass; anything else goes to the console.
	if (isPlainProductSentence(message)) return message;
	console.info(`[maintenance] ${message}`);
	return "The update stopped unexpectedly. No memory was updated. Try again.";
}

// The unavailable screens branch on the server's reason: the entry-count story
// is only true for missing context, and "this unlocks on its own" is false for
// profile or setup problems. The raw server message stays reachable in a
// collapsed technical-detail disclosure.
function absorbUnavailableCopy(availability: AbsorbAvailability): { heading: string; body: string; detail: string | null } {
	if (availability.reason === "insufficient_recent_context" || availability.reason === "missing_recent_context") {
		return {
			heading: "Nothing waiting to be memorized",
			body: availability.recentContextEntryCount === 0
				? "This room has no waiting conversations. Have a conversation and use Remember; Memorize unlocks on its own."
				: `Memorize needs at least ${availability.minimumRecentContextEntries} waiting ${availability.minimumRecentContextEntries === 1 ? "conversation" : "conversations"}. This room has ${availability.recentContextEntryCount}.`,
			detail: null,
		};
	}
	if (availability.reason === "not_ready") {
		return {
			heading: "Memorizing cannot start yet",
			body: "This room is not ready for maintenance right now. No memory was changed. Try again in a moment, or check the room on the launcher.",
			detail: availability.message || null,
		};
	}
	return {
		heading: "Memorizing cannot start yet",
		body: "Memorizing cannot run for this room right now. No memory was changed. If this persists, check the Memory model in Room settings, Model.",
		detail: availability.message || availability.error || null,
	};
}

// Remember runs inside the room, where Maintain is not reachable — so its
// failures must say what to do, not echo the engine's 409.
const REMEMBER_OTHER_CONVERSATION_OPEN = "Remember stopped because another conversation is open now. Open Remember again.";
/** A window still on a conversation the room moved on from (draft). */
const ROOM_MOVED_ON_SENTENCE = "This room went on in another window. Reload to continue there.";
function formatRememberError(message: string): string {
	// Remember's own refusals are already written for the person: pass them through.
	if (isPlainRememberSentence(message)) return message;
	if (isStaleMaintenanceMessage(message)) return "This conversation changed after Remember read it. Generate again.";
	return rememberDamagedSentence(message) ?? formatMaintenanceRequestError(message) ?? rememberFailureSentence(message);
}

/** A Maintain save waiting for a turn in the room to end (draft). */
const ROOM_TURN_WAIT_LINE = "Waiting for the reply in this room to finish…";

/** A save that brought the room to as many remembered conversations as it can hold. */
function roomFilledBy(approval: { recentContextEntryCount?: number | null } | null): boolean {
	return (approval?.recentContextEntryCount ?? 0) >= RECENT_SESSIONS_BLOCK_CAP;
}

// Draft failures land back on the assessment screen, so the copy reassures
// that the assessment survived and points at the Draft action on that screen.
function formatMaintenanceDraftError(message: string): string {
	if (isStaleMaintenanceMessage(message)) return "Memory changed while this was open. No memory was updated. Open Maintain again to work from the latest memory.";
	const request = formatMaintenanceRequestError(message);
	if (request) return request;
	console.info(`[maintenance] ${message}`);
	return "This step could not finish. No memory was updated. Try again.";
}

// Review's own failures, in the room's words: what happened, whether anything
// was saved, and the one thing to do next. The server's refusals are already
// product-worded and pass through; anything else is one plain sentence.
function formatReviewWorkflowError(message: string): string {
	if (isStaleMaintenanceMessage(message)) return "The memory changed while Review was open. Nothing was saved. Start Review again to read the notes as they are now.";
	const request = formatMaintenanceRequestError(message);
	if (request) return request;
	if (/token budget exceeded|token limit|hard_stop/i.test(message)) return "This discussion is as long as it can be. Continue from what you have said, or go back to the first read.";
	// The server's own sentences pass; anything else goes to the console.
	if (isPlainProductSentence(message)) return message;
	console.info(`[maintenance] ${message}`);
	return "Review stopped unexpectedly. Nothing was saved. Try again.";
}

// A save that failed lands back on the card, so the way out it names is the one
// that screen has: reading the notes again from the start.
function formatReviewApprovalError(message: string, code?: string): string {
	// Stopped in another window: this card is not the run any more.
	if (code === "review_run_unknown") return "This tidy is no longer open, so nothing was saved. Start Review again to read the notes as they are now.";
	// Tidied again or being saved in another window; a reload follows a tidy still at work here.
	if (code === "review_run_not_ready") return "This tidy is being worked on in another window, so nothing was saved here. Finish it there, or reload this page to follow it here.";
	if (isStaleMaintenanceMessage(message)) return "The memory changed while this tidy was open. Nothing was saved. Start Review again to read the notes as they are now.";
	const request = formatMaintenanceRequestError(message);
	if (request) return request;
	console.info(`[maintenance] ${message}`);
	return "These changes could not be saved. The memory is unchanged and this tidy is still here.";
}

export { REMEMBER_OTHER_CONVERSATION_OPEN, ROOM_MOVED_ON_SENTENCE, ROOM_TURN_WAIT_LINE, absorbUnavailableCopy, formatAbsorbWorkflowError, formatMaintenanceDraftError, formatRememberError, formatReviewApprovalError, formatReviewWorkflowError, roomFilledBy };
