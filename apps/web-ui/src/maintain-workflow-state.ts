import type { ModelNotice } from "./components/model-notice";
import type { ReviewUndoState } from "./components/review-screen";
import type { ReviewDiscussionMessage } from "./review-api";
import type { AbsorbAvailability, AbsorbAssessmentResponse, AbsorbApprovalResponse, AbsorbDiscussionMessage, AbsorbDiscussionTokenBudget, AbsorbDiscussionSignoffResponse, AbsorbRun, ReviewAvailability, ReviewAssessmentResponse, ReviewDepth, ReviewGuidance, ReviewDiscussionTokenBudget, ReviewRun, ReviewRunApprovalResponse, PersistentAgentId, ReviewStatusResponse } from "./types";
import type { MaintainTarget } from "./room-thread-items";

type CheckpointDensity = "compact" | "standard" | "rich";
// "running", "run_card" and "run_failed" are the Memorize v2 steps: propose
// starts a run the client polls instead of returning a finished draft.
type AbsorbWorkflowStep = "closed" | "checking" | "assessing" | "assessment" | "discussing" | "signing_off" | "proposing" | "running" | "run_card" | "run_failed" | "approving" | "saved" | "unavailable" | "error";
type ReviewWorkflowStep = "closed" | "checking" | "assessing" | "assessment" | "discussing" | "signing_off" | "running" | "run_card" | "run_failed" | "approving" | "saved" | "unavailable" | "error";
type AbsorbWorkflowState = {
	step: AbsorbWorkflowStep;
	target: MaintainTarget | null;
	availability: AbsorbAvailability | null;
	/** The conversations waiting, from the status read at the start; the card shell lists them before the run reports. */
	conversations?: { id: string; title: string; date: string }[];
	assessment: AbsorbAssessmentResponse | null;
	// The Memory model could not answer the first read, the discussion or the sign-off.
	notice?: ModelNotice | null;
	approvalResult: AbsorbApprovalResponse | null;
	discussionMessages?: AbsorbDiscussionMessage[];
	discussionTokenBudget?: AbsorbDiscussionTokenBudget | null;
	discussionSending?: boolean;
	// Non-fatal server notes from a successful turn; rendered amber, never red.
	discussionWarnings?: string | null;
	// Disclosures from the signoff that produced the current draft (a trimmed
	// summary, a shortened transcript): rendered on the proposal screen, never dropped.
	signoffWarnings?: string[];
	assessmentHandoff?: AbsorbDiscussionSignoffResponse["assessmentHandoff"] | null;
	// Room setting known up front so automation is disclosed BEFORE the write,
	// not after (the flow otherwise promises "nothing is saved yet").
	fastPathEnabled?: boolean;
	fastPathApplied?: boolean;
	fastPathBlockedReasons?: string[];
	// Memorize v2: the run this flow is watching. runId is known from the 202
	// answer, the run itself from the first poll that lands.
	runId?: string | null;
	run?: AbsorbRun | null;
	// A keep toggle, a budget change or an approval is in flight: the card's
	// actions are disarmed so two requests never race over one run.
	runBusy?: boolean;
	// Set once the poll retries ran out; the run may well still be going.
	runPollError?: string | null;
	// A previous run this room never finished, which is refusing the next one.
	// Its id is the only thing that can stop it from here.
	activeRunConflictId?: string | null;
	// The first read's raise-the-limit action is writing the room setting and
	// reading the status back.
	limitRaising?: boolean;
	// The limit the room had before the first read raised it: sent with the
	// run so its save records the raise and an undo takes the limit back. The
	// original value survives a second raise; a new Memorize starts without it.
	limitRaisedFrom?: number;
	undo?: ReviewUndoState;
	// The run was opened because it was waiting, so no first read was asked for.
	openedWaiting?: boolean;
	error: string | null;
};

const CLOSED_ABSORB_WORKFLOW: AbsorbWorkflowState = {
	step: "closed",
	target: null,
	availability: null,
	assessment: null,
	approvalResult: null,
	error: null,
};

type ReviewWorkflowState = {
	step: ReviewWorkflowStep;
	target: MaintainTarget | null;
	// The run was opened because it was waiting, so no first read was asked for.
	openedWaiting?: boolean;
	// What the room says about its notes, from the first read that landed.
	availability: ReviewAvailability | null;
	// Why Review cannot start, in the server's own words.
	unavailableReason?: string | null;
	assessment: ReviewAssessmentResponse | null;
	// The Memory model could not answer the first read, the discussion or the sign-off: the notice and its ways out.
	notice?: ModelNotice | null;
	// How far this tidy goes. Null follows the room's own recommendation, and
	// the request then carries whatever the picker is showing.
	depth?: ReviewDepth | null;
	// What the person agreed in the discussion, carried into the tidy.
	guidance?: ReviewGuidance | null;
	discussionMessages?: ReviewDiscussionMessage[];
	discussionTokenBudget?: ReviewDiscussionTokenBudget | null;
	discussionSending?: boolean;
	// Non-fatal server notes from a successful turn; rendered amber, never red.
	discussionWarnings?: string | null;
	// Room setting known up front so automation is disclosed BEFORE the write,
	// not after (the flow otherwise promises "nothing is saved yet").
	fastPathEnabled?: boolean;
	fastPathApplied?: boolean;
	fastPathBlockedReasons?: string[];
	// The tidy this flow is watching. runId is known from the answer that starts
	// it, the run itself from the first poll that lands.
	runId?: string | null;
	run?: ReviewRun | null;
	// A keep toggle, a limit change or an approval is in flight: the card's
	// actions are disarmed so two requests never race over one tidy.
	runBusy?: boolean;
	// Set once the poll retries ran out; the tidy may well still be going.
	runPollError?: string | null;
	// A previous tidy this room never finished, which is refusing the next one.
	// Its id is the only thing that can stop it from here.
	activeRunConflictId?: string | null;
	approvalResult: ReviewRunApprovalResponse | null;
	// Undo of the save this screen reports: in flight, done, or refused with a reason.
	undo?: ReviewUndoState;
	error: string | null;
};

const CLOSED_REVIEW_WORKFLOW: ReviewWorkflowState = {
	step: "closed",
	target: null,
	availability: null,
	assessment: null,
	approvalResult: null,
	error: null,
};

// The same for the Review first read, whose parser words a missing section its
// own way; the read's prompt only accepts those sentences back.
function reviewAssessmentRetryFeedback(assessment: { warnings: string[] } | null | undefined): string[] | undefined {
	const feedback = (assessment?.warnings ?? []).filter((warning) => /^the first read has no "/.test(warning));
	return feedback.length ? feedback : undefined;
}

// Reassess carries the parser's own findings on the current assessment (raw
// server vocabulary, which is what the worker prompt expects) so the regenerated
// assessment fixes the named sections instead of re-rolling blind.
/**
 * The first read the client stands in when the request for one failed without
 * the server saying why, or when a room that saves without the card started
 * Memorize without one: "None.", like the server's own missing first read,
 * with no source, so there is nothing to discuss and Continue goes on without.
 */
function missingFirstRead(agentId: PersistentAgentId, availability: AbsorbAvailability, why: "unreachable" | "skipped" = "unreachable"): AbsorbAssessmentResponse {
	return {
		agentId,
		writesMemory: false,
		process: { type: "absorb-consolidation-worker", model: availability.model ?? { provider: "", model: "" } },
		availability,
		assessmentMarkdown: "None.",
		fields: { whatToRemember: [], whatToForget: [], stableMemoryChanges: { deepMemory: [], activeItems: [], recentContext: "" }, needsJudgment: [] },
		warnings: [],
		firstReadMissing: why,
		// The conversations a first read would have covered, listed under the notice as the server lists them.
		waitingConversations: (availability.sessions ?? []).map(({ title, date }) => ({ title, date })),
	};
}

/** Review with no first read: the tidy reads every topic. */
function missingReviewFirstRead(agentId: PersistentAgentId, status: ReviewStatusResponse): ReviewAssessmentResponse {
	const availability: ReviewAvailability = { available: true, reason: "available", message: "", topics: status.topics, notes: status.notes, ...status.budget, recommendedDepth: status.recommendedDepth };
	return { agentId, writesMemory: false, availability, assessmentMarkdown: "None.", fields: { couldBeShorter: [], staleOrContradicts: [], needsYourCall: [], topics: [] }, warnings: [], source: { l1bFingerprint: { algorithm: "sha256", value: "" } }, firstReadMissing: true };
}

function assessmentRetryFeedback(assessment: { warnings: string[] } | null | undefined): string[] | undefined {
	const feedback = (assessment?.warnings ?? []).filter((warning) => warning.startsWith("assessment missing"));
	return feedback.length ? feedback : undefined;
}

const CHECKPOINT_REMEMBER_MAX_CHARS = 500;
const ABSORB_WAITING_MESSAGES = [
	"Absorbing wisdom…",
	"Meditating on recent conversations…",
	"Letting the lessons settle…",
	"Filing memories where they belong…",
	"Distilling what mattered…",
	"Choosing what to carry forward…",
	"Turning conversations into notes…",
	"Beepbopping memory…",
];
const REVIEW_WAITING_MESSAGES = [
	"Finding dense signal…",
	"Pruning the bonsai…",
	"Weighing every memory…",
	"Folding duplicates together…",
	"Tightening the threads…",
	"Checking what still rings true…",
	"Letting go of the stale bits…",
	"Polishing what stays…",
];
const REVIEW_LOADING_MESSAGES = [
	"Reading the notes…",
	"Sorting the topics…",
	"Walking the archive shelves…",
	"Looking for stale threads…",
	"Measuring density and drift…",
	"Listening for what still matters…",
];
const ABSORB_LOADING_MESSAGES = [
	"Connecting to the Matrix…",
	"Inferencing really hard…",
	"Listening for memory signal…",
	"Sorting signal from glitter…",
	"Compressing the universe gently…",
	"Asking the neurons to focus…",
	"Untangling recent conversations…",
	"Finding the good bits…",
	"Meditating on what happened…",
	"Rereading the recent chapters…",
	"Looking for lessons worth keeping…",
	"Dusting off the archive shelves…",
];
const CHECKPOINT_DENSITY_OPTIONS: Array<{ id: CheckpointDensity; label: string; budget: string }> = [
	{ id: "compact", label: "Compact", budget: "Just the essentials" },
	{ id: "standard", label: "Standard", budget: "The decisions and open points that matter" },
	{ id: "rich", label: "Rich", budget: "A fuller record of the session" },
];

export { ABSORB_LOADING_MESSAGES, ABSORB_WAITING_MESSAGES, CHECKPOINT_DENSITY_OPTIONS, CHECKPOINT_REMEMBER_MAX_CHARS, CLOSED_ABSORB_WORKFLOW, CLOSED_REVIEW_WORKFLOW, REVIEW_LOADING_MESSAGES, REVIEW_WAITING_MESSAGES, assessmentRetryFeedback, missingFirstRead, missingReviewFirstRead, reviewAssessmentRetryFeedback };
export type { AbsorbWorkflowState, CheckpointDensity, ReviewWorkflowState };
