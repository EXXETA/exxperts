// Review v2 over HTTP: the first read, the discussion about it, and the run
// that tidies the notes one by one.
//
// The shape mirrors absorb-run-api.ts on purpose — starting a review answers
// with a run id in milliseconds, the screen polls it, and every adjustment
// (keep, budget, edit) answers with the whole run so the card re-renders from
// the server's numbers and never recomputes one of its own.

import { apiFetch, fetchJson } from "./api";
import type { RunKeepRequest } from "./absorb-run-api";
import type {
	PersistentAgentId,
	ReviewAssessmentResponse,
	ReviewDepth,
	ReviewDiscussionSignoffResponse,
	ReviewDiscussionTurnResponse,
	ReviewGuidance,
	ReviewRun,
	ReviewRunStart,
	ReviewRunApprovalResponse,
	ReviewStatusResponse,
} from "./types";

/** One line of the Review discussion, in the two roles the server accepts. */
export interface ReviewDiscussionMessage {
	role: "user" | "assistant";
	content: string;
}

function reviewBase(agentId: PersistentAgentId): string {
	return `/api/persistent-agents/${encodeURIComponent(agentId)}/review`;
}

function runBase(agentId: PersistentAgentId, runId: string): string {
	return `${reviewBase(agentId)}/runs/${encodeURIComponent(runId)}`;
}

/**
 * A room already tidying its notes refuses a second review, and names the run
 * doing it. That id is the whole remedy: without it a person can only wait out
 * a run nobody is watching, so it is carried out of the error and not
 * flattened into a message.
 */
export class ReviewRunActiveError extends Error {
	readonly runId: string | null;
	constructor(message: string, runId: string | null) {
		super(message);
		this.name = "ReviewRunActiveError";
		this.runId = runId;
	}
}

/** What the room says before anything starts: how much there is, and which depth to offer first. */
export function fetchReviewStatus(agentId: PersistentAgentId): Promise<ReviewStatusResponse> {
	return fetchJson<ReviewStatusResponse>(`${reviewBase(agentId)}/status`);
}

/** The first read. `retryFeedback` asks the same read again, naming what the last one left out. */
export function requestReviewAssessment(agentId: PersistentAgentId, options?: { retryFeedback?: string[] }): Promise<ReviewAssessmentResponse> {
	return fetchJson<ReviewAssessmentResponse>(`${reviewBase(agentId)}/assess`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(options?.retryFeedback?.length ? { retryFeedback: options.retryFeedback } : {}),
	});
}

/** One turn of the discussion. The transcript carries the person's latest line as its last message. */
export function requestReviewDiscussionTurn(agentId: PersistentAgentId, request: { assessmentMarkdown: string; messages: ReviewDiscussionMessage[] }): Promise<ReviewDiscussionTurnResponse> {
	return fetchJson<ReviewDiscussionTurnResponse>(`${reviewBase(agentId)}/discuss`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ assessmentMarkdown: request.assessmentMarkdown, messages: request.messages }),
	});
}

/** The discussion read back as fields the tidy honours. */
export function requestReviewDiscussionSignoff(agentId: PersistentAgentId, request: { assessmentMarkdown: string; messages: ReviewDiscussionMessage[] }): Promise<ReviewDiscussionSignoffResponse> {
	return fetchJson<ReviewDiscussionSignoffResponse>(`${reviewBase(agentId)}/discuss/signoff`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ assessmentMarkdown: request.assessmentMarkdown, messages: request.messages }),
	});
}

/** Starts the tidy. Answers in milliseconds with the run to poll; the work goes on afterwards. */
export async function startReviewRun(agentId: PersistentAgentId, input: { depth: ReviewDepth; topics?: string[]; guidance?: ReviewGuidance }): Promise<ReviewRunStart> {
	const res = await apiFetch(`${reviewBase(agentId)}/runs`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			depth: input.depth,
			...(input.topics?.length ? { topics: input.topics } : {}),
			...(input.guidance ? { guidance: input.guidance } : {}),
		}),
	});
	if (res.ok) return await res.json() as ReviewRunStart;
	let message = `Request failed (${res.status})`;
	type ErrorBody = { error?: unknown; message?: unknown; code?: unknown; runId?: unknown; details?: { runId?: unknown } };
	let body: ErrorBody | null = null;
	try { body = await res.json() as ErrorBody; } catch {}
	if (body?.error) message = String(body.error);
	else if (body?.message) message = String(body.message);
	if (res.status === 409 && body?.code === "review_run_active") {
		const activeRunId = typeof body.details?.runId === "string" && body.details.runId ? body.details.runId : typeof body.runId === "string" && body.runId ? body.runId : null;
		throw new ReviewRunActiveError(message, activeRunId);
	}
	throw new Error(message);
}

export function fetchReviewRun(agentId: PersistentAgentId, runId: string): Promise<ReviewRun> {
	return fetchJson<ReviewRun>(runBase(agentId, runId));
}

/** Keep the notes and topics the person chose; the archive list is derived again. A field left out leaves that set as it is. */
export function keepReviewRunEntries(agentId: PersistentAgentId, runId: string, keep: RunKeepRequest): Promise<ReviewRun> {
	return fetchJson<ReviewRun>(`${runBase(agentId, runId)}/keep`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			...(keep.keepIds ? { keepIds: keep.keepIds } : {}),
			...(keep.keepTopics ? { keepTopics: keep.keepTopics } : {}),
		}),
	});
}

/** Compute this tidy against a higher limit. The room's setting is written on Save, with the memory, and not before. */
export function setReviewRunBudget(agentId: PersistentAgentId, runId: string, budgetTokens: number): Promise<ReviewRun> {
	return fetchJson<ReviewRun>(`${runBase(agentId, runId)}/budget`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ budgetTokens }),
	});
}

/** Replace the words of a note this tidy rewrote; the server checks the limit again and answers with the run. */
export function editReviewRunEntry(agentId: PersistentAgentId, runId: string, entryId: string, text: string): Promise<ReviewRun> {
	return fetchJson<ReviewRun>(`${runBase(agentId, runId)}/edit`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ entryId, text }),
	});
}

/** Stops a run, aborting the reading it is doing. Nothing is written. */
export function cancelReviewRun(agentId: PersistentAgentId, runId: string): Promise<ReviewRun> {
	return fetchJson<ReviewRun>(`${runBase(agentId, runId)}/cancel`, { method: "POST" });
}

/** The run's one write. */
export function approveReviewRun(agentId: PersistentAgentId, runId: string): Promise<ReviewRunApprovalResponse> {
	return fetchJson<ReviewRunApprovalResponse>(`${runBase(agentId, runId)}/approve`, { method: "POST" });
}
