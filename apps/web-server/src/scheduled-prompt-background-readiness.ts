import * as fs from "node:fs";
import * as path from "node:path";
import { AuthStorage, getAgentDir, ModelRegistry } from "@exxeta/exxperts-runtime";
import type { AuthStorageBackend } from "@exxeta/exxperts-runtime";
import type {
	BackgroundRunModelLock,
	BackgroundRunReadiness,
	BackgroundRunReadinessChecks,
	BackgroundRunRecord,
	BackgroundRunStatus,
	BackgroundRunTarget,
} from "./background-runs.js";
import {
	SCHEDULED_ROOM_MODEL_POLICY_KEY,
} from "./persistent-agent-ai-profiles.js";
import { readPersistentAgentAiProfileState } from "./persistent-agent-ai-profile-state.js";
import { resolveScheduledRoomModel, RoomModelUnavailableError } from "./room-models.js";
import { classifyPersistentRoomBackgroundRunTarget } from "./persistent-agents.js";
import {
	readPersistentRoomScheduleStore,
	validatePersistentRoomScheduleRoomId,
} from "../../../pi-package/extensions/schedule-prompt/index.js";

export interface ScheduledPromptBackgroundRunExecutionReadinessDecision {
	status: Extract<BackgroundRunStatus, "queued" | "deferred" | "blocked" | "cancelled" | "failed">;
	reason: string;
	message?: string;
	target?: BackgroundRunTarget;
	readiness: BackgroundRunReadiness;
}

export interface CheckScheduledPromptBackgroundRunExecutionReadinessInput {
	run: BackgroundRunRecord;
	now?: Date;
	workerId?: string;
	registry?: ModelRegistry;
	expectedSchedulerLockId?: string;
}

function normalizeNow(now: Date | undefined): Date {
	const date = now ? new Date(now) : new Date();
	if (Number.isNaN(date.getTime())) throw new Error("invalid scheduled prompt readiness reference time");
	return date;
}

function optionalWorkerId(value: unknown): string | undefined {
	const normalized = String(value ?? "").trim();
	return normalized || undefined;
}

function safeErrorMessage(error: unknown): string {
	const message = (error as Error)?.message ? String((error as Error).message) : String(error);
	return message.trim() || "unknown error";
}

function createReadOnlyRuntimeAuthStorage(): AuthStorage {
	const authPath = path.join(getAgentDir(), "auth.json");
	const storage: AuthStorageBackend = {
		withLock<T>(fn: (current: string | undefined) => { result: T; next?: string }): T {
			const current = fs.existsSync(authPath) ? fs.readFileSync(authPath, "utf-8") : undefined;
			return fn(current).result;
		},
		async withLockAsync<T>(fn: (current: string | undefined) => Promise<{ result: T; next?: string }>): Promise<T> {
			const current = fs.existsSync(authPath) ? fs.readFileSync(authPath, "utf-8") : undefined;
			return (await fn(current)).result;
		},
	};
	return AuthStorage.fromStorage(storage);
}

function runtimeModelRegistry(registry: ModelRegistry | undefined): ModelRegistry {
	return registry ?? ModelRegistry.create(createReadOnlyRuntimeAuthStorage());
}

function readinessMetadata(input: {
	checkedAt: string;
	result: BackgroundRunReadiness["result"];
	reason: string;
	message?: string;
	workerId?: string;
	target?: BackgroundRunTarget;
	model?: BackgroundRunModelLock;
	checks: BackgroundRunReadinessChecks;
}): BackgroundRunReadiness {
	return {
		checkedAt: input.checkedAt,
		result: input.result,
		reason: input.reason,
		...(input.message ? { message: input.message } : {}),
		...(input.workerId ? { workerId: input.workerId } : {}),
		...(input.target ? { target: input.target } : {}),
		...(input.model ? { model: input.model } : {}),
		checks: input.checks,
	};
}

function decision(input: {
	status: ScheduledPromptBackgroundRunExecutionReadinessDecision["status"];
	result: BackgroundRunReadiness["result"];
	reason: string;
	message?: string;
	checkedAt: string;
	workerId?: string;
	target?: BackgroundRunTarget;
	model?: BackgroundRunModelLock;
	checks: BackgroundRunReadinessChecks;
}): ScheduledPromptBackgroundRunExecutionReadinessDecision {
	return {
		status: input.status,
		reason: input.reason,
		...(input.message ? { message: input.message } : {}),
		...(input.target ? { target: input.target } : {}),
		readiness: readinessMetadata({
			checkedAt: input.checkedAt,
			result: input.result,
			reason: input.reason,
			message: input.message,
			workerId: input.workerId,
			target: input.target,
			model: input.model,
			checks: input.checks,
		}),
	};
}

function persistentRoomRunScope(run: BackgroundRunRecord): { roomId: string; schedulerJobId: string } {
	if (run.kind !== "scheduled-prompt") throw new Error("background run is not a scheduled prompt run");
	if (run.scope.kind !== "persistent-room") throw new Error("scheduled prompt run is not scoped to a persistent room");
	const roomId = validatePersistentRoomScheduleRoomId(run.scope.roomId);
	const schedulerJobId = String(run.source.schedulerJobId ?? "").trim();
	if (!schedulerJobId) throw new Error("scheduled prompt run is missing scheduler job id");
	return { roomId, schedulerJobId };
}

function checkRuntimeModelReadiness(modelLock: BackgroundRunModelLock, registry: ModelRegistry): { ok: true; model: BackgroundRunModelLock } | { ok: false; reason: "model_not_found" | "provider_not_connected"; message: string; model?: BackgroundRunModelLock } {
	const model = registry.find(modelLock.provider, modelLock.model);
	if (!model) {
		return {
			ok: false,
			reason: "model_not_found",
			message: `Scheduled prompt background model is not available in the runtime registry: ${modelLock.provider}/${modelLock.model}.`,
			model: modelLock,
		};
	}
	const resolvedModel = { provider: modelLock.provider, model: modelLock.model, ...(model.name ? { label: model.name } : modelLock.label ? { label: modelLock.label } : {}) };
	if (!registry.hasConfiguredAuth(model)) {
		return {
			ok: false,
			reason: "provider_not_connected",
			message: `Scheduled prompt background model provider is not connected: ${modelLock.provider}.`,
			model: resolvedModel,
		};
	}
	return { ok: true, model: resolvedModel };
}

export function checkScheduledPromptBackgroundRunExecutionReadiness(
	input: CheckScheduledPromptBackgroundRunExecutionReadinessInput,
): ScheduledPromptBackgroundRunExecutionReadinessDecision {
	const now = normalizeNow(input.now);
	const checkedAt = now.toISOString();
	const workerId = optionalWorkerId(input.workerId);
	const { roomId, schedulerJobId } = persistentRoomRunScope(input.run);

	try {
		const job = readPersistentRoomScheduleStore(roomId).jobs.find((candidate) => candidate.id === schedulerJobId) ?? null;
		if (!job) {
			const message = `Scheduled prompt no longer exists: ${schedulerJobId}.`;
			return decision({
				status: "cancelled",
				result: "cancelled",
				reason: "schedule_missing",
				message,
				checkedAt,
				workerId,
				target: { kind: "none", roomId },
				checks: { schedule: "missing", room: "blocked", modelPolicy: "not_applicable", runtimeModel: "not_checked" },
			});
		}
		if (!job.enabled) {
			const message = `Scheduled prompt is disabled: ${job.name} (${job.id}).`;
			return decision({
				status: "cancelled",
				result: "cancelled",
				reason: "schedule_disabled",
				message,
				checkedAt,
				workerId,
				target: { kind: "none", roomId },
				checks: { schedule: "disabled", room: "blocked", modelPolicy: "not_applicable", runtimeModel: "not_checked" },
			});
		}
	} catch (error) {
		const message = `Scheduled prompt store cannot be read safely: ${safeErrorMessage(error)}`;
		return decision({
			status: "blocked",
			result: "blocked",
			reason: "schedule_store_unreadable",
			message,
			checkedAt,
			workerId,
			target: { kind: "none", roomId },
			checks: { schedule: "unreadable", room: "blocked", modelPolicy: "not_applicable", runtimeModel: "not_checked" },
		});
	}

	const classification = classifyPersistentRoomBackgroundRunTarget(roomId, { expectedSchedulerLockId: input.expectedSchedulerLockId });
	if (classification.status === "deferred") {
		return decision({
			status: "deferred",
			result: "deferred",
			reason: classification.reason,
			message: classification.message,
			checkedAt,
			workerId,
			target: classification.target ?? { kind: "none", roomId },
			checks: { schedule: "enabled", room: "deferred", modelPolicy: "not_applicable", runtimeModel: "not_checked" },
		});
	}
	if (classification.status === "blocked") {
		return decision({
			status: "blocked",
			result: "blocked",
			reason: classification.reason,
			message: classification.message,
			checkedAt,
			workerId,
			target: classification.target ?? { kind: "none", roomId },
			checks: { schedule: "enabled", room: "blocked", modelPolicy: "not_applicable", runtimeModel: "not_checked" },
		});
	}

	let target: BackgroundRunTarget;
	let modelLock: BackgroundRunModelLock;
	let modelPolicyCheck: BackgroundRunReadinessChecks["modelPolicy"] = "not_applicable";
	if (classification.reason === "resume_thread") {
		if (!classification.target.model) {
			const message = "Persistent room resume thread is missing an immutable model lock.";
			return decision({
				status: "blocked",
				result: "blocked",
				reason: "room_error",
				message,
				checkedAt,
				workerId,
				target: { kind: "none", roomId },
				checks: { schedule: "enabled", room: "blocked", modelPolicy: "not_applicable", runtimeModel: "not_checked" },
			});
		}
		modelLock = classification.target.model;
		target = { kind: "resume-thread", roomId, threadId: classification.target.threadId, model: modelLock };
	} else {
		const activeProfileState = readPersistentAgentAiProfileState();
		try {
			modelLock = resolveScheduledRoomModel(roomId);
			modelPolicyCheck = "ready";
			target = { kind: "fresh-thread", roomId, modelPolicyKey: SCHEDULED_ROOM_MODEL_POLICY_KEY, model: modelLock };
		} catch (error) {
			// The room's own refusal (its model no longer offered) reads as it is.
			const message = error instanceof RoomModelUnavailableError ? error.message : `Scheduled-room model is unavailable for this room: ${safeErrorMessage(error)}`;
			return decision({
				status: "blocked",
				result: "blocked",
				reason: "model_policy_unavailable",
				message,
				checkedAt,
				workerId,
				target: { kind: "fresh-thread", roomId, modelPolicyKey: SCHEDULED_ROOM_MODEL_POLICY_KEY },
				checks: { schedule: "enabled", room: "ready", modelPolicy: "blocked", runtimeModel: "not_checked" },
			});
		}
	}

	const runtimeCheck = checkRuntimeModelReadiness(modelLock, runtimeModelRegistry(input.registry));
	if (!runtimeCheck.ok) {
		return decision({
			status: "blocked",
			result: "blocked",
			reason: runtimeCheck.reason,
			message: runtimeCheck.message,
			checkedAt,
			workerId,
			target,
			model: runtimeCheck.model,
			checks: { schedule: "enabled", room: "ready", modelPolicy: modelPolicyCheck, runtimeModel: runtimeCheck.reason },
		});
	}

	const readyTarget = { ...target, model: runtimeCheck.model };
	return decision({
		status: "queued",
		result: "ready",
		reason: "ready_for_execution",
		message: "Scheduled prompt background run passed execution readiness checks.",
		checkedAt,
		workerId,
		target: readyTarget,
		model: runtimeCheck.model,
		checks: { schedule: "enabled", room: "ready", modelPolicy: modelPolicyCheck, runtimeModel: "ready" },
	});
}
