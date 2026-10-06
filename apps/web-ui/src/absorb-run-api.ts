// The Memorize v2 run routes. Propose no longer answers with a finished
// draft: it starts a run the client polls, and keep/budget adjust that run
// before approval writes it. Every adjustment answers with the whole run, so
// the screen re-renders from the server's numbers and never recomputes one.

import { apiFetch, fetchJson } from "./api";
import type { AbsorbApprovalResponse, AbsorbDiscussionSignoffResponse, AbsorbProposalSourceMetadata, AbsorbRun, AbsorbRunStart, FoldGuidance, PersistentAgentId } from "./types";

function absorbBase(agentId: PersistentAgentId): string {
	return `/api/persistent-agents/${encodeURIComponent(agentId)}/absorb`;
}

/**
 * A room already updating its memory refuses a second update, and names the
 * run doing it. That id is the whole remedy: without it a person can only wait
 * out a run nobody is watching, so it is carried out of the error and not
 * flattened into a message.
 */
export class AbsorbRunActiveError extends Error {
	readonly runId: string | null;
	constructor(message: string, runId: string | null) {
		super(message);
		this.name = "AbsorbRunActiveError";
		this.runId = runId;
	}
}

export async function startAbsorbRun(agentId: PersistentAgentId, assessmentMarkdown: string, options?: { assessmentHandoff?: AbsorbDiscussionSignoffResponse["assessmentHandoff"]; source?: AbsorbProposalSourceMetadata; guidance?: FoldGuidance; limitRaisedFrom?: number }): Promise<AbsorbRunStart> {
	const res = await apiFetch(`${absorbBase(agentId)}/propose`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			assessmentMarkdown,
			...(options?.assessmentHandoff ? { assessmentHandoff: options.assessmentHandoff } : {}),
			...(options?.source ? { source: options.source } : {}),
			...(options?.guidance ? { guidance: options.guidance } : {}),
			// The limit the first read raised from, so the save records it and an undo takes it back.
			...(options?.limitRaisedFrom === undefined ? {} : { limitRaisedFrom: options.limitRaisedFrom }),
		}),
	});
	if (res.ok) return await res.json() as AbsorbRunStart;
	let message = `Request failed (${res.status})`;
	type ErrorBody = { error?: unknown; message?: unknown; code?: unknown; runId?: unknown; details?: { runId?: unknown } };
	let body: ErrorBody | null = null;
	try { body = await res.json() as ErrorBody; } catch {}
	if (body?.error) message = String(body.error);
	else if (body?.message) message = String(body.message);
	if (res.status === 409 && body?.code === "absorb_run_active") {
		const activeRunId = typeof body.details?.runId === "string" && body.details.runId ? body.details.runId : typeof body.runId === "string" && body.runId ? body.runId : null;
		throw new AbsorbRunActiveError(message, activeRunId);
	}
	throw new Error(message);
}

export function fetchAbsorbRun(agentId: PersistentAgentId, runId: string): Promise<AbsorbRun> {
	return fetchJson<AbsorbRun>(`${absorbBase(agentId)}/runs/${encodeURIComponent(runId)}`);
}

/** What a keep request changes: either set, or both. A field left out leaves that set as it is on the run. */
export interface RunKeepRequest {
	keepIds?: string[];
	/** Topics protected for this run, as "section/title". */
	keepTopics?: string[];
}

/** Keep the notes and topics the person chose; the server re-ranks and answers with the run. */
export function keepAbsorbRunEntries(agentId: PersistentAgentId, runId: string, keep: RunKeepRequest): Promise<AbsorbRun> {
	return fetchJson<AbsorbRun>(`${absorbBase(agentId)}/runs/${encodeURIComponent(runId)}/keep`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			...(keep.keepIds ? { keepIds: keep.keepIds } : {}),
			...(keep.keepTopics ? { keepTopics: keep.keepTopics } : {}),
		}),
	});
}

/** Replace the words of a note this update adds or rewrites; the server re-runs the budget pass and answers with the run. */
export function editAbsorbRunEntry(agentId: PersistentAgentId, runId: string, entryId: string, text: string): Promise<AbsorbRun> {
	return fetchJson<AbsorbRun>(`${absorbBase(agentId)}/runs/${encodeURIComponent(runId)}/edit`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ entryId, text }),
	});
}

/** Keep both, or put a new note shown beside another in that note's place at the save; the server answers with the run. */
export function chooseAbsorbRunBeside(agentId: PersistentAgentId, runId: string, entryId: string, choice: "replace" | "keep-both"): Promise<AbsorbRun> {
	return fetchJson<AbsorbRun>(`${absorbBase(agentId)}/runs/${encodeURIComponent(runId)}/beside-choice`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ entryId, choice }),
	});
}

/** Compute this run against a higher limit. The room's setting is written on Save, with the memory, and not before. */
export function setAbsorbRunBudget(agentId: PersistentAgentId, runId: string, budgetTokens: number): Promise<AbsorbRun> {
	return fetchJson<AbsorbRun>(`${absorbBase(agentId)}/runs/${encodeURIComponent(runId)}/budget`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ budgetTokens }),
	});
}

/** Stops a run, aborting the session it is reading. Nothing is written. */
export function cancelAbsorbRun(agentId: PersistentAgentId, runId: string): Promise<AbsorbRun> {
	return fetchJson<AbsorbRun>(`${absorbBase(agentId)}/runs/${encodeURIComponent(runId)}/cancel`, { method: "POST" });
}

/** Try again, after the run stopped because its model was not answering: the same run reads the conversations still waiting. */
export function resumeAbsorbRun(agentId: PersistentAgentId, runId: string): Promise<AbsorbRun> {
	return fetchJson<AbsorbRun>(`${absorbBase(agentId)}/runs/${encodeURIComponent(runId)}/resume`, { method: "POST" });
}

export function approveAbsorbRun(agentId: PersistentAgentId, runId: string): Promise<AbsorbApprovalResponse> {
	return fetchJson<AbsorbApprovalResponse>(`${absorbBase(agentId)}/approve`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ runId }),
	});
}
