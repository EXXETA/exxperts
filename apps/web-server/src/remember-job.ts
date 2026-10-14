// Remember as a job on the server.
//
// A Remember used to live inside one long request: a closed tab or a dropped
// connection aborted it, and whatever it had read was lost. Now the request
// starts a job and the job runs to its end on its own (decision 26). Any tab
// sees it: a second start on the same conversation attaches to the running
// job, the progress route reads it, and Cancel stops it from wherever it is
// pressed.
//
// The job's proposal is kept at `<room>/runtime/remember/<conversationId>/
// proposal.json`, beside the parts cache (remember-parts-cache.ts), so a
// reopened dialog shows it after the page reloaded or the job ended with no
// one waiting. Both go at Save, Discard and Forget.
//
// In memory on purpose: a restart ends a running job (a job costs money, so
// nobody resumes it at boot). The parts it had read stay in the cache, and
// Generate again pays only for the missing ones.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { createPersistentAgentInstance } from "./persistent-agents.js";
import { clearRememberWork, rememberWorkDir, writeRememberFile } from "./remember-parts-cache.js";

export type RememberJobState = "reading" | "done" | "failed" | "cancelled";

/** Why a job was stopped: by Cancel (none), or because another window saved or forgot its conversation. */
export type RememberCancelReason = "saved" | "forgotten";

export interface RememberJobView {
	jobId: string;
	state: RememberJobState;
	proposal?: unknown;
	error?: unknown;
	reason?: RememberCancelReason;
}

interface RememberJob {
	jobId: string;
	state: RememberJobState;
	error?: unknown;
	reason?: RememberCancelReason;
	controller: AbortController;
	settled: Promise<void>;
}

/** A finished entry this computer would not store (draft). */
export const REMEMBER_NOT_STORED_SENTENCE = "Remember could not store the entry on this computer. Nothing was saved. Generate again.";

/** The reply for a stopped job: a save or a Forget from another window is an outcome, Cancel is "cancelled". */
export function rememberCancelledReply(view: Pick<RememberJobView, "reason">): { error: string; code: string } {
	if (view.reason === "saved") return { error: "This conversation was saved from another window.", code: "remember_saved_elsewhere" };
	if (view.reason === "forgotten") return { error: "This conversation was forgotten from another window.", code: "remember_forgotten_elsewhere" };
	return { error: "Remember was cancelled. Nothing was saved.", code: "remember_cancelled" };
}

const jobs = new Map<string, RememberJob>();

function roomDir(agentId: string): { agentId: string; rootDir: string } {
	const instance = createPersistentAgentInstance(agentId);
	return { agentId: instance.agentId, rootDir: instance.rootDir };
}

function jobKey(agentId: string, conversationId: string): string {
	return `${roomDir(agentId).agentId}\u0000${conversationId}`;
}

function proposalPath(agentId: string, conversationId: string): string {
	return path.join(rememberWorkDir(roomDir(agentId).rootDir, conversationId), "proposal.json");
}

/** Written while a job reads, removed when it ends: one left behind means a restart cut the job. */
function readingMarkerPath(agentId: string, conversationId: string): string {
	return path.join(rememberWorkDir(roomDir(agentId).rootDir, conversationId), "reading.json");
}

function readKeptProposal(agentId: string, conversationId: string): RememberJobView | null {
	try {
		const kept = JSON.parse(fs.readFileSync(proposalPath(agentId, conversationId), "utf-8")) as { jobId?: unknown; proposal?: unknown };
		if (typeof kept.jobId !== "string" || !kept.proposal) return null;
		return { jobId: kept.jobId, state: "done", proposal: kept.proposal };
	} catch {
		return null;
	}
}

/**
 * Starts a Remember on this conversation, or attaches to the one already
 * reading it. `run` gets the job's signal, which only Cancel aborts. A job
 * Cancel stopped is never attached to: the new one starts once it has ended.
 */
export function startRememberJob(agentId: string, conversationId: string, run: (signal: AbortSignal) => Promise<unknown>): { jobId: string; attached: boolean } {
	const key = jobKey(agentId, conversationId);
	const running = jobs.get(key);
	if (running?.state === "reading" && !running.controller.signal.aborted) return { jobId: running.jobId, attached: true };
	const controller = new AbortController();
	const job: RememberJob = { jobId: `rj_${crypto.randomBytes(6).toString("hex")}`, state: "reading", controller, settled: Promise.resolve() };
	jobs.set(key, job);
	const marker = readingMarkerPath(agentId, conversationId);
	try {
		writeRememberFile(marker, { jobId: job.jobId, startedAt: new Date().toISOString() });
	} catch {
		// Only the restart line depends on it.
	}
	job.settled = (async () => {
		try {
			if (running?.state === "reading") await running.settled;
			const proposal = await run(controller.signal);
			if (controller.signal.aborted) {
				job.state = "cancelled";
				return;
			}
			try {
				writeRememberFile(proposalPath(agentId, conversationId), { jobId: job.jobId, savedAt: new Date().toISOString(), proposal });
			} catch (error) {
				// The dialog reads the page from disk: one this computer would not store (a full disk, a file another program holds) is said plainly.
				console.warn(`[remember] the finished entry could not be stored: ${error instanceof Error ? error.message : String(error)}`);
				throw new Error(REMEMBER_NOT_STORED_SENTENCE);
			}
			job.state = "done";
		} catch (error) {
			job.state = controller.signal.aborted ? "cancelled" : "failed";
			job.error = error;
		} finally {
			// A newer job on the same conversation keeps its own marker.
			if (jobs.get(key) === job) {
				try { fs.rmSync(marker, { force: true }); } catch {}
			}
		}
	})();
	return { jobId: job.jobId, attached: false };
}

/**
 * True while a Remember that was reading this conversation as the app stopped
 * is still unfinished: its marker is on disk and no job is reading now. Every
 * tab that opens the room says so, until Generate again starts a new read (its
 * own marker replaces this one) or Discard clears the work. Any proposal an
 * older Remember kept goes at once, since the cut read was newer.
 */
export function takeRestartedRemember(agentId: string, conversationId: string): boolean {
	if (jobs.has(jobKey(agentId, conversationId))) return false;
	if (!fs.existsSync(readingMarkerPath(agentId, conversationId))) return false;
	fs.rmSync(proposalPath(agentId, conversationId), { force: true });
	return true;
}

/** A restart, for smokes: the jobs in memory are gone, what is on disk stays. */
export function forgetRememberJobsForTests(): void {
	jobs.clear();
}

/**
 * The job on this conversation: the one in memory, else the proposal a
 * finished one kept on disk, else null. A read a restart cut is newer than any
 * kept proposal, so then it is null and the restart line is said.
 */
export function getRememberJob(agentId: string, conversationId: string): RememberJobView | null {
	const job = jobs.get(jobKey(agentId, conversationId));
	if (job && job.state !== "done") return { jobId: job.jobId, state: job.state, ...(job.error !== undefined ? { error: job.error } : {}), ...(job.reason ? { reason: job.reason } : {}) };
	if (!job && fs.existsSync(readingMarkerPath(agentId, conversationId))) return null;
	return readKeptProposal(agentId, conversationId);
}

/** Stops the running job on this conversation, saying why when a save or a Forget stopped it. False when none is reading. */
export function cancelRememberJob(agentId: string, conversationId: string, reason?: RememberCancelReason): boolean {
	const job = jobs.get(jobKey(agentId, conversationId));
	if (!job || job.state !== "reading") return false;
	if (reason) job.reason = reason;
	job.controller.abort();
	return true;
}

/** Resolves when the job on this conversation has ended (at once when there is none). */
export async function rememberJobSettled(agentId: string, conversationId: string): Promise<void> {
	await jobs.get(jobKey(agentId, conversationId))?.settled;
}

/**
 * Discard: stops a running job and deletes its kept proposal and notes. A
 * stopped job stays until its read has ended, so a Generate right after waits
 * for it instead of meeting its reading mark.
 */
export function discardRememberJob(agentId: string, conversationId: string): void {
	const key = jobKey(agentId, conversationId);
	const job = jobs.get(key);
	if (cancelRememberJob(agentId, conversationId)) void job!.settled.then(() => { if (jobs.get(key) === job) jobs.delete(key); });
	else jobs.delete(key);
	clearRememberWork(roomDir(agentId).rootDir, conversationId);
}

/** A kept proposal the conversation has moved past: it goes, the notes on the parts stay for the next Generate. */
export function dropKeptProposal(agentId: string, conversationId: string): void {
	jobs.delete(jobKey(agentId, conversationId));
	fs.rmSync(proposalPath(agentId, conversationId), { force: true });
}
