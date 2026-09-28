import { createBackgroundRun } from "./background-runs.js";
import type { BackgroundRunRecord, BackgroundRunStatus, BackgroundRunTarget, BackgroundRunTrigger } from "./background-runs.js";
import {
	SCHEDULED_ROOM_MODEL_POLICY_KEY,
} from "./persistent-agent-ai-profiles.js";
import type { PersistentAgentAiProfileId } from "./persistent-agent-ai-profiles.js";
import { readPersistentAgentAiProfileState } from "./persistent-agent-ai-profile-state.js";
import { resolveScheduledRoomModel, RoomModelUnavailableError } from "./room-models.js";
import { classifyPersistentRoomBackgroundRunTarget } from "./persistent-agents.js";
import type { PersistentRoomBackgroundRunClassification } from "./persistent-agents.js";
import {
	readPersistentRoomScheduleStore,
	validatePersistentRoomScheduleRoomId,
} from "../../../pi-package/extensions/schedule-prompt/index.js";
import type { PersistentRoomScheduleJob } from "../../../pi-package/extensions/schedule-prompt/index.js";

export interface CreateScheduledPromptBackgroundRunPreflightInput {
	roomId: unknown;
	scheduleJobId: unknown;
	trigger?: "manual" | "schedule-due" | "system";
	dueAt?: unknown;
	now?: Date;
}

export interface ScheduledPromptBackgroundRunPreflightResult {
	run: BackgroundRunRecord;
	job: PersistentRoomScheduleJob | null;
	classification?: PersistentRoomBackgroundRunClassification;
	activeProfileId?: PersistentAgentAiProfileId;
}

interface ScheduledPromptBackgroundRunOutcome {
	status: BackgroundRunStatus;
	reason: string;
	message: string;
	target: BackgroundRunTarget;
	warnings?: string[];
	error?: { code: string; message: string };
}

function requireNonEmptyString(value: unknown, label: string, maxLength?: number): string {
	const normalized = String(value ?? "").trim();
	if (!normalized) throw new Error(`${label} is required`);
	if (maxLength && normalized.length > maxLength) throw new Error(`${label} must be ${maxLength} characters or less`);
	return normalized;
}

function normalizeTrigger(value: unknown): BackgroundRunTrigger {
	if (value === undefined || value === null) return "schedule-due";
	if (value !== "manual" && value !== "schedule-due" && value !== "system") throw new Error("invalid scheduled prompt background run trigger");
	return value;
}

function normalizeOptionalIsoDateString(value: unknown): string | undefined {
	if (value === undefined || value === null) return undefined;
	if (value instanceof Date) {
		if (Number.isNaN(value.getTime())) throw new Error("invalid scheduled prompt background run dueAt");
		return value.toISOString();
	}
	const text = String(value).trim();
	if (!text || !/^\d{4}-\d{2}-\d{2}T/.test(text) || Number.isNaN(new Date(text).getTime())) {
		throw new Error("invalid scheduled prompt background run dueAt");
	}
	return text;
}

function safeErrorMessage(error: unknown): string {
	const message = (error as Error)?.message ? String((error as Error).message) : String(error);
	return message.trim() || "unknown error";
}

function createScheduledPromptBackgroundRunRecord(
	roomId: string,
	scheduleJobId: string,
	trigger: BackgroundRunTrigger,
	dueAt: string | undefined,
	now: Date | undefined,
	outcome: ScheduledPromptBackgroundRunOutcome,
): BackgroundRunRecord {
	return createBackgroundRun({
		kind: "scheduled-prompt",
		scope: { kind: "persistent-room", roomId },
		source: {
			schedulerJobId: scheduleJobId,
			trigger,
			...(dueAt ? { dueAt } : {}),
		},
		status: outcome.status,
		reason: outcome.reason,
		message: outcome.message,
		target: outcome.target,
		warnings: outcome.warnings ?? [],
		...(outcome.error ? { error: outcome.error } : {}),
		...(now ? { now } : {}),
	});
}

function createBlockedResult(
	roomId: string,
	scheduleJobId: string,
	trigger: BackgroundRunTrigger,
	dueAt: string | undefined,
	now: Date | undefined,
	job: PersistentRoomScheduleJob | null,
	reason: string,
	message: string,
	options: {
		classification?: PersistentRoomBackgroundRunClassification;
		activeProfileId?: PersistentAgentAiProfileId;
		target?: BackgroundRunTarget;
		warnings?: string[];
	} = {},
): ScheduledPromptBackgroundRunPreflightResult {
	return {
		job,
		...(options.classification ? { classification: options.classification } : {}),
		...(options.activeProfileId ? { activeProfileId: options.activeProfileId } : {}),
		run: createScheduledPromptBackgroundRunRecord(roomId, scheduleJobId, trigger, dueAt, now, {
			status: "blocked",
			reason,
			message,
			target: options.target ?? { kind: "none", roomId },
			warnings: options.warnings,
			error: { code: reason, message },
		}),
	};
}

function createClassifiedResult(
	roomId: string,
	scheduleJobId: string,
	trigger: BackgroundRunTrigger,
	dueAt: string | undefined,
	now: Date | undefined,
	job: PersistentRoomScheduleJob,
	classification: PersistentRoomBackgroundRunClassification,
): ScheduledPromptBackgroundRunPreflightResult {
	if (classification.status === "deferred") {
		return {
			job,
			classification,
			run: createScheduledPromptBackgroundRunRecord(roomId, scheduleJobId, trigger, dueAt, now, {
				status: "deferred",
				reason: classification.reason,
				message: classification.message,
				target: classification.target ?? { kind: "none", roomId },
				warnings: classification.warnings,
			}),
		};
	}

	if (classification.status === "blocked") {
		return createBlockedResult(roomId, scheduleJobId, trigger, dueAt, now, job, classification.reason, classification.message, {
			classification,
			target: classification.target ?? { kind: "none", roomId },
			warnings: classification.warnings,
		});
	}

	if (classification.reason === "resume_thread") {
		if (!classification.target.model) {
			const message = "Persistent room resume thread is missing an immutable model lock.";
			return createBlockedResult(roomId, scheduleJobId, trigger, dueAt, now, job, "room_error", message, {
				classification,
				warnings: classification.warnings,
			});
		}
		return {
			job,
			classification,
			run: createScheduledPromptBackgroundRunRecord(roomId, scheduleJobId, trigger, dueAt, now, {
				status: "queued",
				reason: "resume_thread",
				message: "Scheduled prompt preflight queued to resume the current persistent-room thread.",
				target: {
					kind: "resume-thread",
					roomId,
					threadId: classification.target.threadId,
					model: classification.target.model,
				},
				warnings: classification.warnings,
			}),
		};
	}

	const activeProfileState = readPersistentAgentAiProfileState();
	const activeProfileId = activeProfileState.profileId;
	const warnings = [
		...classification.warnings,
		...(activeProfileState.message ? [activeProfileState.message] : []),
	];
	try {
		const model = resolveScheduledRoomModel(roomId);
		return {
			job,
			classification,
			activeProfileId,
			run: createScheduledPromptBackgroundRunRecord(roomId, scheduleJobId, trigger, dueAt, now, {
				status: "queued",
				reason: "fresh_thread",
				message: "Scheduled prompt preflight queued for a fresh persistent-room background thread.",
				target: {
					kind: "fresh-thread",
					roomId,
					modelPolicyKey: SCHEDULED_ROOM_MODEL_POLICY_KEY,
					model,
				},
				warnings,
			}),
		};
	} catch (error) {
		const message = error instanceof RoomModelUnavailableError ? error.message : `Scheduled-room model policy is unavailable for active profile ${activeProfileId}: ${safeErrorMessage(error)}`;
		return createBlockedResult(roomId, scheduleJobId, trigger, dueAt, now, job, "model_policy_unavailable", message, {
			classification,
			activeProfileId,
			target: { kind: "fresh-thread", roomId, modelPolicyKey: SCHEDULED_ROOM_MODEL_POLICY_KEY },
			warnings,
		});
	}
}

export function createScheduledPromptBackgroundRunPreflight(
	input: CreateScheduledPromptBackgroundRunPreflightInput,
): ScheduledPromptBackgroundRunPreflightResult {
	const roomId = validatePersistentRoomScheduleRoomId(input.roomId);
	const scheduleJobId = requireNonEmptyString(input.scheduleJobId, "schedule job id", 120);
	const trigger = normalizeTrigger(input.trigger);
	const dueAt = normalizeOptionalIsoDateString(input.dueAt);

	let jobs: PersistentRoomScheduleJob[];
	try {
		jobs = readPersistentRoomScheduleStore(roomId).jobs;
	} catch (error) {
		const message = `Scheduled prompt store cannot be read safely: ${safeErrorMessage(error)}`;
		return createBlockedResult(roomId, scheduleJobId, trigger, dueAt, input.now, null, "schedule_store_unreadable", message);
	}

	const job = jobs.find((candidate) => candidate.id === scheduleJobId) ?? null;
	if (!job) {
		const message = `Scheduled prompt not found: ${scheduleJobId}.`;
		return createBlockedResult(roomId, scheduleJobId, trigger, dueAt, input.now, null, "schedule_missing", message);
	}
	if (!job.enabled) {
		const message = `Scheduled prompt is disabled: ${job.name} (${job.id}).`;
		return createBlockedResult(roomId, scheduleJobId, trigger, dueAt, input.now, job, "schedule_disabled", message);
	}

	const classification = classifyPersistentRoomBackgroundRunTarget(roomId);
	return createClassifiedResult(roomId, scheduleJobId, trigger, dueAt, input.now, job, classification);
}
