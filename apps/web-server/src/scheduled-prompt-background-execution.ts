import * as crypto from "node:crypto";
import * as os from "node:os";
import * as path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import {
	claimBackgroundRunLease,
	extendBackgroundRunLease,
	generateBackgroundRunLeaseToken,
	listClaimableScheduledPromptBackgroundRuns,
	recoverExpiredBackgroundRunLeases,
	reviveTransientlyBlockedBackgroundRuns,
	readBackgroundRun,
	updateClaimedBackgroundRunStatus,
	type BackgroundRunArtifacts,
	type BackgroundRunRecord,
	type BackgroundRunStatus,
	type BackgroundRunTarget,
} from "./background-runs.js";
import { executePersistentRoomBackgroundPrompt } from "./persistent-room-background-execution.js";
import { recordPersistentAgentUnseenLandedAnswer } from "./persistent-agents.js";
import { appendUsageOnce, resolveUsageAuthType } from "./usage-log.js";
import {
	inspectScheduledPromptBackgroundRunIdempotency,
	mergeScheduledPromptBackgroundRunArtifacts,
	scheduledPromptBackgroundRunArtifactPaths,
	scheduledPromptBackgroundRunHasInputArtifact,
	scheduledPromptBackgroundRunHasOutputArtifact,
	writeScheduledPromptBackgroundRunInputArtifact,
	writeScheduledPromptBackgroundRunOutputArtifact,
} from "./scheduled-prompt-background-artifacts.js";
import { checkScheduledPromptBackgroundRunExecutionReadiness } from "./scheduled-prompt-background-readiness.js";
import {
	readPersistentRoomScheduleStore,
	validatePersistentRoomScheduleRoomId,
	type PersistentRoomScheduleJob,
} from "../../../pi-package/extensions/schedule-prompt/index.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = process.env.EXXETA_HOME ? path.resolve(process.env.EXXETA_HOME) : path.resolve(__dirname, "..", "..", "..");
const roomLock = createRequire(import.meta.url)(path.join(REPO_ROOT, "bin", "lib", "room-lock.cjs")) as {
	tryAcquire: (agentId: string, owner: Record<string, unknown>) => { ok: boolean; heldBy?: { surface?: string; acquiredAt?: number } };
	heartbeat: (agentId: string, owner: Record<string, unknown>) => void;
	release: (agentId: string, owner: Record<string, unknown>) => void;
};

export interface ScheduledPromptBackgroundExecutionTransitionSummary {
	runId: string;
	previousStatus: BackgroundRunStatus;
	finalStatus: BackgroundRunStatus;
	reason: string;
	threadId?: string;
}

export interface ScheduledPromptBackgroundExecutionRecoverySummary {
	runId: string;
	finalStatus: BackgroundRunStatus;
	reason: string;
}

export interface ScheduledPromptBackgroundExecutionSummary {
	workerId: string;
	recovered: ScheduledPromptBackgroundExecutionRecoverySummary[];
	processed: ScheduledPromptBackgroundExecutionTransitionSummary[];
	skipped: Array<{ runId: string; reason: string }>;
	counts: {
		recovered: number;
		claimed: number;
		processed: number;
		skipped: number;
		succeeded: number;
		failed: number;
		deferred: number;
		blocked: number;
		cancelled: number;
	};
}

export interface ProcessScheduledPromptBackgroundRunExecutionOnceInput {
	workerId?: string;
	now?: Date;
	limit?: number;
	leaseMs?: number;
	heartbeatMs?: number;
	executePrompt?: typeof executePersistentRoomBackgroundPrompt;
}

const DEFAULT_EXECUTION_LIMIT = 1;
const DEFAULT_EXECUTION_LEASE_MS = 5 * 60 * 1000;
const DEFAULT_EXECUTION_HEARTBEAT_MS = 30 * 1000;
const PROCESS_RANDOM = crypto.randomBytes(8).toString("hex");

export function createScheduledPromptBackgroundExecutionWorkerId(): string {
	const host = os.hostname().replace(/[^a-zA-Z0-9_.:-]+/g, "_").slice(0, 80) || "unknown-host";
	return `scheduler-execution:${host}:${process.pid}:${PROCESS_RANDOM}`;
}

function normalizeNow(now: Date | undefined): Date {
	const date = now ? new Date(now) : new Date();
	if (Number.isNaN(date.getTime())) throw new Error("invalid scheduled prompt background execution reference time");
	return date;
}

function normalizeLimit(value: unknown): number {
	if (value === undefined || value === null) return DEFAULT_EXECUTION_LIMIT;
	const limit = Number(value);
	if (!Number.isSafeInteger(limit) || limit <= 0) throw new Error("invalid scheduled prompt background execution limit");
	return Math.min(limit, 10);
}

function normalizeLeaseMs(value: unknown): number {
	if (value === undefined || value === null) return DEFAULT_EXECUTION_LEASE_MS;
	const leaseMs = Number(value);
	if (!Number.isSafeInteger(leaseMs) || leaseMs <= 0) throw new Error("invalid scheduled prompt background execution lease duration");
	return leaseMs;
}

function normalizeHeartbeatMs(value: unknown, leaseMs: number): number {
	if (value === undefined || value === null) return Math.min(DEFAULT_EXECUTION_HEARTBEAT_MS, Math.max(1_000, Math.floor(leaseMs / 2)));
	const heartbeatMs = Number(value);
	if (!Number.isSafeInteger(heartbeatMs) || heartbeatMs <= 0) throw new Error("invalid scheduled prompt background execution heartbeat interval");
	return Math.min(heartbeatMs, Math.max(1_000, Math.floor(leaseMs / 2)));
}

function roomScope(run: BackgroundRunRecord): { roomId: string; schedulerJobId: string } {
	if (run.kind !== "scheduled-prompt") throw new Error("background run is not a scheduled prompt run");
	if (run.scope.kind !== "persistent-room") throw new Error("scheduled prompt run is not scoped to a persistent room");
	const roomId = validatePersistentRoomScheduleRoomId(run.scope.roomId);
	const schedulerJobId = String(run.source.schedulerJobId ?? "").trim();
	if (!schedulerJobId) throw new Error("scheduled prompt run is missing scheduler job id");
	return { roomId, schedulerJobId };
}

function safeErrorMessage(error: unknown): string {
	const message = (error as Error)?.message ? String((error as Error).message) : String(error);
	return message.trim().slice(0, 1000) || "unknown error";
}

function safeErrorCode(error: unknown): string {
	const code = String((error as any)?.code ?? "").trim();
	return code && /^[a-zA-Z0-9_.:-]+$/.test(code) ? code.slice(0, 120) : "execution_failed";
}

function readEnabledSchedulePrompt(run: BackgroundRunRecord): { job: PersistentRoomScheduleJob; prompt: string } | { status: "cancelled"; reason: string; message: string } | { status: "blocked"; reason: string; message: string } {
	const { roomId, schedulerJobId } = roomScope(run);
	try {
		const job = readPersistentRoomScheduleStore(roomId).jobs.find((candidate) => candidate.id === schedulerJobId) ?? null;
		if (!job) return { status: "cancelled", reason: "schedule_missing", message: `Scheduled prompt no longer exists: ${schedulerJobId}.` };
		if (!job.enabled) return { status: "cancelled", reason: "schedule_disabled", message: `Scheduled prompt is disabled: ${job.name} (${job.id}).` };
		return { job, prompt: job.prompt };
	} catch (error) {
		return { status: "blocked", reason: "schedule_store_unreadable", message: `Scheduled prompt store cannot be read safely: ${safeErrorMessage(error)}` };
	}
}

function statusCountKey(status: BackgroundRunStatus): "succeeded" | "failed" | "deferred" | "blocked" | "cancelled" | null {
	if (status === "succeeded" || status === "failed" || status === "deferred" || status === "blocked" || status === "cancelled") return status;
	return null;
}

function schedulerLockOwner(input: { runId: string; token: string; lockId: string }): Record<string, unknown> {
	return {
		surface: "scheduler",
		pid: process.pid,
		lockId: input.lockId,
		runId: input.runId,
		label: `scheduled background run ${input.runId}`,
	};
}

function updateRunningReason(input: { run: BackgroundRunRecord; token: string; now: Date; target?: BackgroundRunTarget; artifacts?: BackgroundRunArtifacts }): BackgroundRunRecord {
	return updateClaimedBackgroundRunStatus({
		runId: input.run.runId,
		token: input.token,
		status: "running",
		reason: "claimed_for_execution",
		message: null,
		...(input.target ? { target: input.target } : {}),
		...(input.artifacts ? { artifacts: input.artifacts } : {}),
		now: input.now,
		clearLease: false,
	});
}

function terminalUpdate(input: {
	run: BackgroundRunRecord;
	token: string;
	status: BackgroundRunStatus;
	reason: string;
	message?: string;
	target?: BackgroundRunTarget | null;
	artifacts?: BackgroundRunArtifacts;
	error?: { code: string; message: string } | null;
	now?: Date;
}): BackgroundRunRecord {
	return updateClaimedBackgroundRunStatus({
		runId: input.run.runId,
		token: input.token,
		status: input.status,
		reason: input.reason,
		...(input.message !== undefined ? { message: input.message } : {}),
		...(input.target !== undefined ? { target: input.target } : {}),
		...(input.artifacts ? { artifacts: input.artifacts } : {}),
		...(input.error !== undefined ? { error: input.error } : {}),
		now: input.now,
	});
}

function startHeartbeat(input: { roomId: string; lockOwner: Record<string, unknown>; runId: string; token: string; leaseMs: number; heartbeatMs: number }): () => void {
	const timer = setInterval(() => {
		try { extendBackgroundRunLease({ runId: input.runId, token: input.token, leaseMs: input.leaseMs }); } catch {}
		try { roomLock.heartbeat(input.roomId, input.lockOwner); } catch {}
	}, input.heartbeatMs);
	return () => clearInterval(timer);
}

function completedArtifactsForEvidence(run: BackgroundRunRecord): BackgroundRunArtifacts {
	const paths = scheduledPromptBackgroundRunArtifactPaths(run.runId);
	return mergeScheduledPromptBackgroundRunArtifacts(run.artifacts, {
		...(run.artifacts?.inputRelPath || !scheduledPromptBackgroundRunHasInputArtifact(run) ? {} : { inputRelPath: paths.inputRelPath }),
		...(run.artifacts?.outputRelPath || !scheduledPromptBackgroundRunHasOutputArtifact(run) ? {} : { outputRelPath: paths.outputRelPath }),
	});
}

async function executeClaimedRun(input: {
	claimed: BackgroundRunRecord;
	token: string;
	workerId: string;
	now: Date;
	leaseMs: number;
	heartbeatMs: number;
	executePrompt: typeof executePersistentRoomBackgroundPrompt;
}): Promise<ScheduledPromptBackgroundExecutionTransitionSummary> {
	let run = updateRunningReason({ run: input.claimed, token: input.token, now: input.now });
	const previousStatus = input.claimed.status;
	const { roomId } = roomScope(run);
	const preReadiness = checkScheduledPromptBackgroundRunExecutionReadiness({ run, now: input.now, workerId: input.workerId });
	if (preReadiness.status !== "queued" || preReadiness.readiness.result !== "ready" || !preReadiness.target || preReadiness.target.kind === "none") {
		const updated = updateClaimedBackgroundRunStatus({
			runId: run.runId,
			token: input.token,
			status: preReadiness.status,
			reason: preReadiness.reason,
			message: preReadiness.message,
			target: preReadiness.target ?? null,
			readiness: preReadiness.readiness,
			now: input.now,
		});
		return { runId: updated.runId, previousStatus, finalStatus: updated.status, reason: updated.reason ?? preReadiness.reason };
	}

	const target = preReadiness.target;
	const lockId = `scheduler_${run.runId}_${crypto.randomBytes(8).toString("hex")}`;
	const owner = schedulerLockOwner({ runId: run.runId, token: input.token, lockId });
	const acquired = roomLock.tryAcquire(roomId, owner);
	if (!acquired.ok) {
		const updated = terminalUpdate({
			run,
			token: input.token,
			status: "deferred",
			reason: "room_in_use",
			message: "Persistent room is currently open or locked by another surface; scheduled background execution should retry later.",
			target,
			now: input.now,
		});
		return { runId: updated.runId, previousStatus, finalStatus: updated.status, reason: updated.reason ?? "room_in_use" };
	}

	let stopHeartbeat: (() => void) | null = null;
	try {
		const postReadiness = checkScheduledPromptBackgroundRunExecutionReadiness({ run, now: new Date(), workerId: input.workerId, expectedSchedulerLockId: lockId });
		if (postReadiness.status !== "queued" || postReadiness.readiness.result !== "ready" || !postReadiness.target || postReadiness.target.kind === "none") {
			const updated = updateClaimedBackgroundRunStatus({
				runId: run.runId,
				token: input.token,
				status: postReadiness.status,
				reason: postReadiness.reason,
				message: postReadiness.message,
				target: postReadiness.target ?? null,
				readiness: postReadiness.readiness,
				now: new Date(),
			});
			return { runId: updated.runId, previousStatus, finalStatus: updated.status, reason: updated.reason ?? postReadiness.reason };
		}
		const finalTarget = postReadiness.target;
		run = updateRunningReason({ run, token: input.token, now: new Date(), target: finalTarget });

		const schedule = readEnabledSchedulePrompt(run);
		if ("status" in schedule) {
			const updated = terminalUpdate({
				run,
				token: input.token,
				status: schedule.status,
				reason: schedule.reason,
				message: schedule.message,
				target: finalTarget,
				now: new Date(),
			});
			return { runId: updated.runId, previousStatus, finalStatus: updated.status, reason: updated.reason ?? schedule.reason };
		}

		const evidence = inspectScheduledPromptBackgroundRunIdempotency({ run, threadId: finalTarget.threadId });
		if (evidence.alreadyCompleted) {
			const updated = terminalUpdate({
				run,
				token: input.token,
				status: "succeeded",
				reason: "already_completed",
				message: "Scheduled prompt background run already has completed output evidence; no duplicate execution was performed.",
				target: finalTarget,
				artifacts: completedArtifactsForEvidence(run),
				now: new Date(),
			});
			return { runId: updated.runId, previousStatus, finalStatus: updated.status, reason: updated.reason ?? "already_completed", ...(evidence.threadId ? { threadId: evidence.threadId } : {}) };
		}

		const inputArtifacts = writeScheduledPromptBackgroundRunInputArtifact({ run, prompt: schedule.prompt, snapshottedAt: new Date() });
		run = updateRunningReason({ run, token: input.token, now: new Date(), target: finalTarget, artifacts: inputArtifacts });
		stopHeartbeat = startHeartbeat({ roomId, lockOwner: owner, runId: run.runId, token: input.token, leaseMs: input.leaseMs, heartbeatMs: input.heartbeatMs });
		const turnId = `scheduled_${run.runId}`;
		const result = await input.executePrompt({
			roomId,
			target: finalTarget,
			prompt: schedule.prompt,
			executionId: run.runId,
			turnId,
			connectionId: `scheduler:${run.runId}`,
		});
		// The output artifact is the idempotency evidence: it must land before the usage row so a
		// crash in between makes lease recovery short-circuit to already_completed instead of
		// generating (and billing) the same run a second time.
		const outputArtifacts = writeScheduledPromptBackgroundRunOutputArtifact({ run, assistantText: result.assistantText, completedAt: new Date() });
		if (result.usage) {
			// Scheduled turns spend tokens like chat turns; account them to the
			// room in the shared ledger. Provider auth just succeeded, so the
			// authType lookup can assume configured. Keyed on the run id so a
			// re-executed run can never bill the same occurrence twice.
			appendUsageOnce({
				ts: Date.now(),
				agent: roomId,
				persona: "business",
				model: result.model.model,
				provider: result.model.provider,
				authType: resolveUsageAuthType(result.model.provider, true),
				kind: "scheduled",
				input: result.usage.input ?? 0,
				output: result.usage.output ?? 0,
				cacheRead: result.usage.cacheRead ?? 0,
				cacheWrite: result.usage.cacheWrite ?? 0,
				cost: result.usage.cost ?? 0,
				runId: run.runId,
			}, (message) => console.warn(message));
		}
		// Nobody was in the room while this ran, so the answer would otherwise
		// only be found by opening the room. Record the same unseen-landed-answer
		// marker the detached-turn landing writes, so the room card badges it and
		// the badge survives a restart. Best-effort: a completed, paid run must
		// never fail on this bookkeeping.
		try {
			recordPersistentAgentUnseenLandedAnswer(roomId, {
				threadId: result.threadId,
				turnId,
				terminalReason: "completed",
				origin: "scheduled-run",
			});
		} catch (error) {
			console.warn(`failed to record unseen landed-answer marker for scheduled run ${run.runId}: ${safeErrorMessage(error)}`);
		}
		const declinedQuestions = Array.isArray(result.declinedQuestions) ? result.declinedQuestions : [];
		const succeededTarget: BackgroundRunTarget = {
			...finalTarget,
			threadId: result.threadId,
			model: result.model,
		};
		const updated = terminalUpdate({
			run,
			token: input.token,
			status: "succeeded",
			reason: "completed",
			// The question titles stay out of the run record (it is a public
			// projection); the conversation carries them.
			message: declinedQuestions.length === 0
				? "Scheduled prompt background run completed."
				: declinedQuestions.length === 1
					? "Scheduled prompt background run completed. A question came up during the run and was answered with a safe default; the conversation says which one."
					: "Scheduled prompt background run completed. Questions came up during the run and were answered with safe defaults; the conversation says which ones.",
			target: succeededTarget,
			artifacts: outputArtifacts,
			now: new Date(),
		});
		return { runId: updated.runId, previousStatus, finalStatus: updated.status, reason: updated.reason ?? "completed", threadId: result.threadId };
	} catch (error) {
		const message = `Scheduled prompt background execution failed: ${safeErrorMessage(error)}`;
		let updated: BackgroundRunRecord;
		try {
			updated = terminalUpdate({
				run,
				token: input.token,
				status: "failed",
				reason: safeErrorCode(error),
				message,
				target: run.target ?? target,
				...(run.artifacts ? { artifacts: run.artifacts } : {}),
				error: { code: safeErrorCode(error), message },
				now: new Date(),
			});
		} catch {
			throw error;
		}
		return { runId: updated.runId, previousStatus, finalStatus: updated.status, reason: updated.reason ?? "execution_failed", ...(updated.target?.threadId ? { threadId: updated.target.threadId } : {}) };
	} finally {
		if (stopHeartbeat) stopHeartbeat();
		try { roomLock.release(roomId, owner); } catch {}
	}
}

export async function processScheduledPromptBackgroundRunExecutionOnce(
	input: ProcessScheduledPromptBackgroundRunExecutionOnceInput = {},
): Promise<ScheduledPromptBackgroundExecutionSummary> {
	const workerId = String(input.workerId ?? createScheduledPromptBackgroundExecutionWorkerId()).trim();
	if (!workerId) throw new Error("scheduled prompt background execution worker id is required");
	const now = normalizeNow(input.now);
	const limit = normalizeLimit(input.limit);
	const leaseMs = normalizeLeaseMs(input.leaseMs);
	const heartbeatMs = normalizeHeartbeatMs(input.heartbeatMs, leaseMs);
	const executePrompt = input.executePrompt ?? executePersistentRoomBackgroundPrompt;

	const recoveredRecords = recoverExpiredBackgroundRunLeases({ kind: "scheduled-prompt", now, limit });
	reviveTransientlyBlockedBackgroundRuns({ kind: "scheduled-prompt", now, limit });
	const recovered = recoveredRecords.map((record) => ({
		runId: record.runId,
		finalStatus: record.status,
		reason: record.reason ?? "lease_expired",
	}));

	const processed: ScheduledPromptBackgroundExecutionTransitionSummary[] = [];
	const skipped: Array<{ runId: string; reason: string }> = [];
	const processedRooms = new Set<string>();
	let claimedCount = 0;
	const counts = { recovered: recovered.length, claimed: 0, processed: 0, skipped: 0, succeeded: 0, failed: 0, deferred: 0, blocked: 0, cancelled: 0 };
	const claimable = listClaimableScheduledPromptBackgroundRuns({ now, limit: Math.max(limit * 5, limit) });

	for (const candidate of claimable) {
		if (processed.length >= limit) break;
		const roomId = candidate.scope.kind === "persistent-room" ? candidate.scope.roomId : null;
		if (roomId && processedRooms.has(roomId)) {
			skipped.push({ runId: candidate.runId, reason: "room_already_processed_this_tick" });
			continue;
		}

		const token = generateBackgroundRunLeaseToken();
		let claimed: BackgroundRunRecord | null = null;
		try {
			claimed = claimBackgroundRunLease({ runId: candidate.runId, workerId, token, now, leaseMs });
		} catch (error) {
			skipped.push({ runId: candidate.runId, reason: `claim_failed:${safeErrorMessage(error)}` });
			continue;
		}
		if (!claimed) {
			skipped.push({ runId: candidate.runId, reason: "not_claimable" });
			continue;
		}

		claimedCount += 1;
		counts.claimed = claimedCount;
		if (roomId) processedRooms.add(roomId);
		try {
			const transition = await executeClaimedRun({ claimed, token, workerId, now, leaseMs, heartbeatMs, executePrompt });
			processed.push(transition);
			const countKey = statusCountKey(transition.finalStatus);
			if (countKey) counts[countKey] += 1;
		} catch (error) {
			try {
				const latest = readBackgroundRun(claimed.runId);
				processed.push({ runId: latest.runId, previousStatus: candidate.status, finalStatus: latest.status, reason: latest.reason ?? "execution_failed", ...(latest.target?.threadId ? { threadId: latest.target.threadId } : {}) });
				const countKey = statusCountKey(latest.status);
				if (countKey) counts[countKey] += 1;
			} catch {
				skipped.push({ runId: claimed.runId, reason: `execution_failed:${safeErrorMessage(error)}` });
			}
		}
	}

	counts.processed = processed.length;
	counts.skipped = skipped.length;
	return {
		workerId,
		recovered,
		processed,
		skipped,
		counts,
	};
}
