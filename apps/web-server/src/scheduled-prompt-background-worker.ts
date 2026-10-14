import * as crypto from "node:crypto";
import * as os from "node:os";
import {
	claimBackgroundRunLease,
	generateBackgroundRunLeaseToken,
	listClaimableScheduledPromptBackgroundRuns,
	recoverExpiredBackgroundRunLeases,
	reviveTransientlyBlockedBackgroundRuns,
	updateClaimedBackgroundRunStatus,
} from "./background-runs.js";
import type { BackgroundRunRecord, BackgroundRunStatus } from "./background-runs.js";
import { checkScheduledPromptBackgroundRunExecutionReadiness, scheduledRunMetCurrentConversation } from "./scheduled-prompt-background-readiness.js";

export interface ScheduledPromptBackgroundWorkerTransitionSummary {
	runId: string;
	previousStatus: BackgroundRunStatus;
	finalStatus: BackgroundRunStatus;
	reason: string;
}

export interface ScheduledPromptBackgroundWorkerRecoverySummary {
	runId: string;
	finalStatus: BackgroundRunStatus;
	reason: string;
}

export interface ScheduledPromptBackgroundWorkerReadinessSummary {
	workerId: string;
	recovered: ScheduledPromptBackgroundWorkerRecoverySummary[];
	processed: ScheduledPromptBackgroundWorkerTransitionSummary[];
	skipped: Array<{ runId: string; reason: string }>;
	counts: {
		recovered: number;
		claimed: number;
		processed: number;
		skipped: number;
		failed: number;
	};
}

export interface ProcessScheduledPromptBackgroundRunReadinessOnceInput {
	workerId?: string;
	now?: Date;
	limit?: number;
	leaseMs?: number;
}

const DEFAULT_WORKER_LIMIT = 10;
const DEFAULT_READINESS_LEASE_MS = 5 * 60 * 1000;
const PROCESS_RANDOM = crypto.randomBytes(8).toString("hex");

export function createScheduledPromptBackgroundWorkerId(): string {
	const host = os.hostname().replace(/[^a-zA-Z0-9_.:-]+/g, "_").slice(0, 80) || "unknown-host";
	return `scheduler-readiness:${host}:${process.pid}:${PROCESS_RANDOM}`;
}

function normalizeNow(now: Date | undefined): Date {
	const date = now ? new Date(now) : new Date();
	if (Number.isNaN(date.getTime())) throw new Error("invalid scheduled prompt background worker reference time");
	return date;
}

function normalizeLimit(value: unknown): number {
	if (value === undefined || value === null) return DEFAULT_WORKER_LIMIT;
	const limit = Number(value);
	if (!Number.isSafeInteger(limit) || limit <= 0) throw new Error("invalid scheduled prompt background worker limit");
	return Math.min(limit, 100);
}

function normalizeLeaseMs(value: unknown): number {
	if (value === undefined || value === null) return DEFAULT_READINESS_LEASE_MS;
	const leaseMs = Number(value);
	if (!Number.isSafeInteger(leaseMs) || leaseMs <= 0) throw new Error("invalid scheduled prompt background worker lease duration");
	return leaseMs;
}

function roomIdForRun(run: BackgroundRunRecord): string | null {
	return run.scope.kind === "persistent-room" ? run.scope.roomId : null;
}

function safeErrorMessage(error: unknown): string {
	const message = (error as Error)?.message ? String((error as Error).message) : String(error);
	return message.trim() || "unknown error";
}

export function processScheduledPromptBackgroundRunReadinessOnce(
	input: ProcessScheduledPromptBackgroundRunReadinessOnceInput = {},
): ScheduledPromptBackgroundWorkerReadinessSummary {
	const workerId = String(input.workerId ?? createScheduledPromptBackgroundWorkerId()).trim();
	if (!workerId) throw new Error("scheduled prompt background worker id is required");
	const now = normalizeNow(input.now);
	const limit = normalizeLimit(input.limit);
	const leaseMs = normalizeLeaseMs(input.leaseMs);

	const recoveredRecords = recoverExpiredBackgroundRunLeases({ kind: "scheduled-prompt", now, limit });
	reviveTransientlyBlockedBackgroundRuns({ kind: "scheduled-prompt", now, limit, metCurrentConversation: scheduledRunMetCurrentConversation });
	const recovered = recoveredRecords.map((record) => ({
		runId: record.runId,
		finalStatus: record.status,
		reason: record.reason ?? "lease_expired",
	}));

	const processed: ScheduledPromptBackgroundWorkerTransitionSummary[] = [];
	const skipped: Array<{ runId: string; reason: string }> = [];
	let claimedCount = 0;
	let failedCount = 0;
	const processedRooms = new Set<string>();
	const claimable = listClaimableScheduledPromptBackgroundRuns({ now, limit });

	for (const candidate of claimable) {
		if (processed.length >= limit) break;
		const roomId = roomIdForRun(candidate);
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
		if (roomId) processedRooms.add(roomId);
		try {
			const readiness = checkScheduledPromptBackgroundRunExecutionReadiness({ run: claimed, now, workerId });
			const updated = updateClaimedBackgroundRunStatus({
				runId: claimed.runId,
				token,
				status: readiness.status,
				reason: readiness.reason,
				message: readiness.message,
				target: readiness.target ?? null,
				readiness: readiness.readiness,
				now,
			});
			processed.push({
				runId: updated.runId,
				previousStatus: candidate.status,
				finalStatus: updated.status,
				reason: updated.reason ?? readiness.reason,
			});
		} catch (error) {
			failedCount += 1;
			const message = `Scheduled prompt background readiness check failed: ${safeErrorMessage(error)}`;
			const updated = updateClaimedBackgroundRunStatus({
				runId: claimed.runId,
				token,
				status: "failed",
				reason: "readiness_check_failed",
				message,
				readiness: {
					checkedAt: now.toISOString(),
					result: "failed",
					reason: "readiness_check_failed",
					message,
					workerId,
				},
				now,
			});
			processed.push({
				runId: updated.runId,
				previousStatus: candidate.status,
				finalStatus: updated.status,
				reason: updated.reason ?? "readiness_check_failed",
			});
		}
	}

	return {
		workerId,
		recovered,
		processed,
		skipped,
		counts: {
			recovered: recovered.length,
			claimed: claimedCount,
			processed: processed.length,
			skipped: skipped.length,
			failed: failedCount,
		},
	};
}
