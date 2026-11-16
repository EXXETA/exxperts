import type { BackgroundRunKind, BackgroundRunRecord, BackgroundRunStatus, BackgroundRunTrigger } from "./background-runs.js";

export type PersistentRoomBackgroundRunStatus = BackgroundRunStatus;
export type PersistentRoomBackgroundRunKind = BackgroundRunKind;

export interface PersistentRoomBackgroundRunModelView {
	provider: string;
	model: string;
	label?: string;
}

export interface PersistentRoomBackgroundRunTargetView {
	kind: "resume-thread" | "fresh-thread" | "no-room-mutation" | "none";
	roomId?: string;
	threadId?: string;
	model?: PersistentRoomBackgroundRunModelView;
	modelPolicyKey?: string;
}

export interface PersistentRoomBackgroundRunSourceView {
	scheduleId?: string;
	trigger: BackgroundRunTrigger;
	dueAt?: string;
}

export interface PersistentRoomBackgroundRunArtifactSummaryView {
	hasInput: boolean;
	hasOutput: boolean;
	hasEvents: boolean;
}

export interface PersistentRoomBackgroundRunLeaseSummaryView {
	claimedAt: string;
	expiresAt: string;
	heartbeatAt?: string;
	active: boolean;
}

export interface PersistentRoomBackgroundRunReadinessSummaryView {
	checkedAt: string;
	expiresAt?: string;
	result: "ready" | "deferred" | "blocked" | "cancelled" | "failed";
	reason: string;
	message?: string;
}

export interface PersistentRoomBackgroundRunView {
	runId: string;
	kind: PersistentRoomBackgroundRunKind;
	roomId: string;
	source: PersistentRoomBackgroundRunSourceView;
	status: PersistentRoomBackgroundRunStatus;
	reason?: string;
	message?: string;
	createdAt: string;
	updatedAt: string;
	queuedAt?: string;
	startedAt?: string;
	finishedAt?: string;
	attempts: number;
	lease?: PersistentRoomBackgroundRunLeaseSummaryView;
	readiness?: PersistentRoomBackgroundRunReadinessSummaryView;
	target?: PersistentRoomBackgroundRunTargetView;
	artifacts?: PersistentRoomBackgroundRunArtifactSummaryView;
	warnings: string[];
	error?: { code: string; message: string };
}

export interface PersistentRoomBackgroundRunHistorySummary {
	totalReturned: number;
	latestCreatedAt: string | null;
	latestUpdatedAt: string | null;
	byStatus: Partial<Record<PersistentRoomBackgroundRunStatus, number>>;
}

export interface PersistentRoomBackgroundRunsResponse {
	roomId: string;
	filters: {
		scheduleId?: string;
		status?: PersistentRoomBackgroundRunStatus;
		limit: number;
	};
	ordering: "createdAt_desc";
	runs: PersistentRoomBackgroundRunView[];
	/** Each task's newest run, however many newer runs push it out of runs. */
	latestRuns: PersistentRoomBackgroundRunView[];
	summary: PersistentRoomBackgroundRunHistorySummary;
}

export function buildPersistentRoomBackgroundRunsResponse(
	roomId: string,
	records: BackgroundRunRecord[],
	filters: { scheduleId?: string; status?: PersistentRoomBackgroundRunStatus; limit: number },
	newestPerSchedule: BackgroundRunRecord[] = [],
): PersistentRoomBackgroundRunsResponse {
	const project = (list: BackgroundRunRecord[]) => list
		.filter((record) => record.scope.kind === "persistent-room" && record.scope.roomId === roomId)
		.map((record) => projectPersistentRoomBackgroundRun(roomId, record));
	const runs = project(records);
	return {
		roomId,
		filters,
		ordering: "createdAt_desc",
		runs,
		latestRuns: project(newestPerSchedule),
		summary: summarizePersistentRoomBackgroundRuns(runs),
	};
}

export function projectPersistentRoomBackgroundRun(roomId: string, record: BackgroundRunRecord): PersistentRoomBackgroundRunView {
	if (record.scope.kind !== "persistent-room" || record.scope.roomId !== roomId) throw new Error("background run does not belong to persistent room");
	return {
		runId: record.runId,
		kind: record.kind,
		roomId,
		source: {
			...(record.source.schedulerJobId ? { scheduleId: record.source.schedulerJobId } : {}),
			trigger: record.source.trigger,
			...(record.source.dueAt ? { dueAt: record.source.dueAt } : {}),
		},
		status: record.status,
		...(record.reason ? { reason: record.reason } : {}),
		...(record.message ? { message: record.message } : {}),
		createdAt: record.createdAt,
		updatedAt: record.updatedAt,
		...(record.queuedAt ? { queuedAt: record.queuedAt } : {}),
		...(record.startedAt ? { startedAt: record.startedAt } : {}),
		...(record.finishedAt ? { finishedAt: record.finishedAt } : {}),
		attempts: record.attempts,
		...(record.lease ? { lease: projectLease(record.lease) } : {}),
		...(record.readiness ? { readiness: projectReadiness(record.readiness) } : {}),
		...(record.target ? { target: projectTarget(record.target) } : {}),
		...(record.artifacts ? { artifacts: projectArtifacts(record.artifacts) } : {}),
		warnings: [...record.warnings],
		...(record.error ? { error: { code: record.error.code, message: record.error.message } } : {}),
	};
}

export function summarizePersistentRoomBackgroundRuns(runs: PersistentRoomBackgroundRunView[]): PersistentRoomBackgroundRunHistorySummary {
	let latestCreatedAt: string | null = null;
	let latestUpdatedAt: string | null = null;
	const byStatus: Partial<Record<PersistentRoomBackgroundRunStatus, number>> = {};
	for (const run of runs) {
		if (latestCreatedAt === null || run.createdAt > latestCreatedAt) latestCreatedAt = run.createdAt;
		if (latestUpdatedAt === null || run.updatedAt > latestUpdatedAt) latestUpdatedAt = run.updatedAt;
		byStatus[run.status] = (byStatus[run.status] ?? 0) + 1;
	}
	return {
		totalReturned: runs.length,
		latestCreatedAt,
		latestUpdatedAt,
		byStatus,
	};
}

function projectLease(lease: NonNullable<BackgroundRunRecord["lease"]>): PersistentRoomBackgroundRunLeaseSummaryView {
	return {
		claimedAt: lease.claimedAt,
		expiresAt: lease.expiresAt,
		...(lease.heartbeatAt ? { heartbeatAt: lease.heartbeatAt } : {}),
		active: new Date(lease.expiresAt).getTime() > Date.now(),
	};
}

function projectReadiness(readiness: NonNullable<BackgroundRunRecord["readiness"]>): PersistentRoomBackgroundRunReadinessSummaryView {
	return {
		checkedAt: readiness.checkedAt,
		...(readiness.expiresAt ? { expiresAt: readiness.expiresAt } : {}),
		result: readiness.result,
		reason: readiness.reason,
		...(readiness.message ? { message: readiness.message } : {}),
	};
}

function projectTarget(target: NonNullable<BackgroundRunRecord["target"]>): PersistentRoomBackgroundRunTargetView {
	return {
		kind: target.kind,
		...(target.roomId ? { roomId: target.roomId } : {}),
		...(target.threadId ? { threadId: target.threadId } : {}),
		...(target.model
			? {
					model: {
						provider: target.model.provider,
						model: target.model.model,
						...(target.model.label ? { label: target.model.label } : {}),
					},
				}
			: {}),
		...(target.modelPolicyKey ? { modelPolicyKey: target.modelPolicyKey } : {}),
	};
}

function projectArtifacts(artifacts: NonNullable<BackgroundRunRecord["artifacts"]>): PersistentRoomBackgroundRunArtifactSummaryView {
	return {
		hasInput: Boolean(artifacts.inputRelPath),
		hasOutput: Boolean(artifacts.outputRelPath),
		hasEvents: Boolean(artifacts.eventRelPath),
	};
}
