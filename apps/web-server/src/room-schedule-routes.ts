import { validatePersistentAgentId, getPersistentAgentStatus, isPersistentAgentArchived } from "./persistent-agents.js";
import { browserSafeDiagnosticText } from "./status-diagnostics.js";
import { type BackgroundRunStatus, listBackgroundRuns } from "./background-runs.js";
import { buildPersistentRoomBackgroundRunsResponse } from "./persistent-room-background-run-history.js";
import { type AddPersistentRoomScheduleJobInput, type UpdatePersistentRoomScheduleJobInput, type PersistentRoomScheduleJob, type PersistentRoomScheduleSummary, type PersistentRoomScheduleType, SCHEDULE_PATTERN_CANNOT_RUN_CODE, listPersistentRoomScheduleJobs, summarizePersistentRoomScheduleJobs, addPersistentRoomScheduleJob, updatePersistentRoomScheduleJob, removePersistentRoomScheduleJob } from "../../../pi-package/extensions/schedule-prompt/index.js";
import { app } from "./server-app.js";
import { roomModelsPayload } from "./ai-models.js";

const PERSISTENT_ROOM_SCHEDULE_MANAGEMENT_PROMPT_MAX_LENGTH = 20_000;

const PERSISTENT_ROOM_SCHEDULE_MANAGEMENT_NOTICE = "Enabled schedules can run as background room work when due while the web server is running. The room must be idle and safe; otherwise the run is deferred or blocked.";

const PERSISTENT_ROOM_SCHEDULE_JOB_ID_PATTERN = /^sched_[a-f0-9]{32}$/;

const PERSISTENT_ROOM_SCHEDULE_CREATE_FIELDS = new Set(["name", "type", "schedule", "prompt", "enabled"]);

const PERSISTENT_ROOM_SCHEDULE_PATCH_FIELDS = new Set(["name", "type", "schedule", "prompt", "enabled"]);

const PERSISTENT_ROOM_BACKGROUND_RUN_HISTORY_DEFAULT_LIMIT = 50;

const PERSISTENT_ROOM_BACKGROUND_RUN_HISTORY_MAX_LIMIT = 200;

const PERSISTENT_ROOM_BACKGROUND_RUN_HISTORY_SCHEDULE_ID_MAX_LENGTH = 120;

const BACKGROUND_RUN_STATUSES: readonly BackgroundRunStatus[] = ["queued", "running", "deferred", "blocked", "succeeded", "failed", "cancelled"];

type PersistentRoomScheduleCreateRequest = Pick<AddPersistentRoomScheduleJobInput, "name" | "type" | "schedule" | "prompt" | "enabled">;

type PersistentRoomSchedulePatchRequest = Pick<UpdatePersistentRoomScheduleJobInput, "name" | "type" | "schedule" | "prompt" | "enabled">;

type PersistentRoomScheduleManagementResponse = {
	roomId: string;
	executionEnabled: false;
	managementOnly: true;
	notice: string;
	job?: PersistentRoomScheduleJob;
	removed?: PersistentRoomScheduleJob;
	jobs: PersistentRoomScheduleJob[];
	summary: PersistentRoomScheduleSummary;
	timeZone: string;
};

// The zone the due calculation reads daily and weekly times in: the server process's own.
function serverTimeZone(): string {
	return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

function persistentRoomScheduleManagementHttpError(message: string, statusCode: number, body?: Record<string, unknown>): Error {
	const error = new Error(message);
	(error as any).statusCode = statusCode;
	(error as any).body = { error: message, ...(body ?? {}) };
	return error;
}

function requirePersistentRoomScheduleManagementBody(body: unknown): Record<string, unknown> {
	if (!body || typeof body !== "object" || Array.isArray(body)) {
		throw persistentRoomScheduleManagementHttpError("request body must be an object", 400);
	}
	return body as Record<string, unknown>;
}

function rejectUnknownPersistentRoomScheduleFields(body: Record<string, unknown>, allowedFields: Set<string>): void {
	const unknownFields = Object.keys(body).filter((field) => !allowedFields.has(field));
	if (unknownFields.length > 0) {
		throw persistentRoomScheduleManagementHttpError(`unknown schedule request field${unknownFields.length === 1 ? "" : "s"}: ${unknownFields.join(", ")}`, 400);
	}
}

function hasPersistentRoomScheduleField(body: Record<string, unknown>, field: string): boolean {
	return Object.prototype.hasOwnProperty.call(body, field);
}

function parsePersistentRoomScheduleStringField(body: Record<string, unknown>, field: string, options: { required: boolean; maxLength?: number }): string | undefined {
	if (!hasPersistentRoomScheduleField(body, field)) {
		if (options.required) throw persistentRoomScheduleManagementHttpError(`${field} is required`, 400);
		return undefined;
	}
	const value = body[field];
	if (typeof value !== "string") throw persistentRoomScheduleManagementHttpError(`${field} must be a string`, 400);
	if (options.maxLength !== undefined && value.length > options.maxLength) {
		throw persistentRoomScheduleManagementHttpError(`${field} must be ${options.maxLength} characters or less`, 400);
	}
	return value;
}

function parsePersistentRoomScheduleTypeField(body: Record<string, unknown>): PersistentRoomScheduleType | undefined {
	if (!hasPersistentRoomScheduleField(body, "type")) return undefined;
	const value = body.type;
	if (value === "once" || value === "interval" || value === "cron") return value;
	throw persistentRoomScheduleManagementHttpError("type must be once, interval, or cron", 400);
}

function parsePersistentRoomScheduleEnabledField(body: Record<string, unknown>): boolean | undefined {
	if (!hasPersistentRoomScheduleField(body, "enabled")) return undefined;
	if (typeof body.enabled !== "boolean") throw persistentRoomScheduleManagementHttpError("enabled must be a boolean", 400);
	return body.enabled;
}

function parsePersistentRoomScheduleCreateBody(bodyRaw: unknown): PersistentRoomScheduleCreateRequest {
	const body = requirePersistentRoomScheduleManagementBody(bodyRaw);
	rejectUnknownPersistentRoomScheduleFields(body, PERSISTENT_ROOM_SCHEDULE_CREATE_FIELDS);
	return {
		name: parsePersistentRoomScheduleStringField(body, "name", { required: true }),
		type: parsePersistentRoomScheduleTypeField(body),
		schedule: parsePersistentRoomScheduleStringField(body, "schedule", { required: true }),
		prompt: parsePersistentRoomScheduleStringField(body, "prompt", { required: true, maxLength: PERSISTENT_ROOM_SCHEDULE_MANAGEMENT_PROMPT_MAX_LENGTH }),
		enabled: parsePersistentRoomScheduleEnabledField(body),
	};
}

function parsePersistentRoomSchedulePatchBody(bodyRaw: unknown): PersistentRoomSchedulePatchRequest {
	const body = requirePersistentRoomScheduleManagementBody(bodyRaw);
	rejectUnknownPersistentRoomScheduleFields(body, PERSISTENT_ROOM_SCHEDULE_PATCH_FIELDS);
	if (Object.keys(body).length === 0) throw persistentRoomScheduleManagementHttpError("schedule patch body must include at least one supported field", 400);
	const patch: PersistentRoomSchedulePatchRequest = {};
	const name = parsePersistentRoomScheduleStringField(body, "name", { required: false });
	if (name !== undefined) patch.name = name;
	const type = parsePersistentRoomScheduleTypeField(body);
	if (type !== undefined) patch.type = type;
	const schedule = parsePersistentRoomScheduleStringField(body, "schedule", { required: false });
	if (schedule !== undefined) patch.schedule = schedule;
	const prompt = parsePersistentRoomScheduleStringField(body, "prompt", { required: false, maxLength: PERSISTENT_ROOM_SCHEDULE_MANAGEMENT_PROMPT_MAX_LENGTH });
	if (prompt !== undefined) patch.prompt = prompt;
	const enabled = parsePersistentRoomScheduleEnabledField(body);
	if (enabled !== undefined) patch.enabled = enabled;
	return patch;
}

function parsePersistentRoomScheduleJobId(rawJobId: unknown): string {
	const jobId = String(rawJobId ?? "").trim();
	if (!PERSISTENT_ROOM_SCHEDULE_JOB_ID_PATTERN.test(jobId)) throw persistentRoomScheduleManagementHttpError(`invalid schedule job id: ${jobId || "(empty)"}`, 400);
	return jobId;
}

function getPersistentRoomScheduleManagementRoomId(idRaw: string): string {
	let id: string;
	try {
		id = validatePersistentAgentId(idRaw);
	} catch (error) {
		throw persistentRoomScheduleManagementHttpError((error as Error).message, 400);
	}
	const status = getPersistentAgentStatus(id);
	if (!status.exists) throw persistentRoomScheduleManagementHttpError(`persistent agent not found: ${id}`, 404);
	if (isPersistentAgentArchived(status)) {
		throw persistentRoomScheduleManagementHttpError(`persistent agent is archived: ${id}`, 410, { status: "archived", agentId: id, archivedAt: status.archivedAt });
	}
	return id;
}

function buildPersistentRoomScheduleManagementResponse(roomId: string, result: { job?: PersistentRoomScheduleJob; removed?: PersistentRoomScheduleJob } = {}): PersistentRoomScheduleManagementResponse {
	const jobs = listPersistentRoomScheduleJobs(roomId);
	return {
		roomId,
		executionEnabled: false,
		managementOnly: true,
		notice: PERSISTENT_ROOM_SCHEDULE_MANAGEMENT_NOTICE,
		...(result.job ? { job: result.job } : {}),
		...(result.removed ? { removed: result.removed } : {}),
		jobs,
		summary: summarizePersistentRoomScheduleJobs(jobs),
		timeZone: serverTimeZone(),
	};
}

function persistentRoomScheduleManagementErrorReply(reply: any, error: unknown) {
	const explicitBody = (error as any)?.body;
	const explicitStatus = (error as any)?.statusCode;
	if (explicitStatus && explicitBody) return reply.code(explicitStatus).send(explicitBody);
	const message = error instanceof Error ? error.message : String(error);
	if ((error as { code?: unknown } | null)?.code === SCHEDULE_PATTERN_CANNOT_RUN_CODE) return reply.code(400).send({ error: message });
	if (/Scheduled prompt not found/i.test(message)) return reply.code(404).send({ error: message });
	if (/failed to read persistent room schedule store|invalid persistent room schedule store|unsupported persistent room schedule store version|persistent room schedule store room id mismatch|invalid persistent room schedule job/i.test(message)) {
		return reply.code(500).send({ error: browserSafeDiagnosticText(message) });
	}
	if (/is required|must be|invalid schedule|Invalid .*schedule|Invalid interval|Invalid relative time|Invalid time|Cron expression|Invalid cron field|Scheduled time is in the past|could not allocate unique schedule job id/i.test(message)) {
		return reply.code(400).send({ error: message });
	}
	return reply.code(500).send({ error: browserSafeDiagnosticText(message) });
}

function parseOptionalPersistentRoomBackgroundRunScheduleId(value: unknown): string | undefined {
	if (value === undefined || value === null) return undefined;
	if (typeof value !== "string") throw persistentRoomScheduleManagementHttpError("scheduleId must be a string", 400);
	const scheduleId = value.trim();
	if (!scheduleId) throw persistentRoomScheduleManagementHttpError("scheduleId must be a non-empty string", 400);
	if (scheduleId.length > PERSISTENT_ROOM_BACKGROUND_RUN_HISTORY_SCHEDULE_ID_MAX_LENGTH) {
		throw persistentRoomScheduleManagementHttpError(`scheduleId must be ${PERSISTENT_ROOM_BACKGROUND_RUN_HISTORY_SCHEDULE_ID_MAX_LENGTH} characters or less`, 400);
	}
	return scheduleId;
}

function parseOptionalPersistentRoomBackgroundRunStatus(value: unknown): BackgroundRunStatus | undefined {
	if (value === undefined || value === null) return undefined;
	if (typeof value !== "string") throw persistentRoomScheduleManagementHttpError("status must be a string", 400);
	const status = value.trim();
	if (!BACKGROUND_RUN_STATUSES.includes(status as BackgroundRunStatus)) {
		throw persistentRoomScheduleManagementHttpError(`status must be one of: ${BACKGROUND_RUN_STATUSES.join(", ")}`, 400);
	}
	return status as BackgroundRunStatus;
}

function parsePersistentRoomBackgroundRunHistoryLimit(value: unknown): number {
	if (value === undefined || value === null) return PERSISTENT_ROOM_BACKGROUND_RUN_HISTORY_DEFAULT_LIMIT;
	if (typeof value !== "string") throw persistentRoomScheduleManagementHttpError("limit must be a positive integer", 400);
	const text = value.trim();
	if (!/^\d+$/.test(text)) throw persistentRoomScheduleManagementHttpError("limit must be a positive integer", 400);
	const limit = Number(text);
	if (!Number.isSafeInteger(limit) || limit <= 0) throw persistentRoomScheduleManagementHttpError("limit must be a positive integer", 400);
	if (limit > PERSISTENT_ROOM_BACKGROUND_RUN_HISTORY_MAX_LIMIT) {
		throw persistentRoomScheduleManagementHttpError(`limit must be ${PERSISTENT_ROOM_BACKGROUND_RUN_HISTORY_MAX_LIMIT} or less`, 400);
	}
	return limit;
}

function parsePersistentRoomBackgroundRunHistoryQuery(queryRaw: unknown): { scheduleId?: string; status?: BackgroundRunStatus; limit: number } {
	const query = (queryRaw ?? {}) as Record<string, unknown>;
	const scheduleId = parseOptionalPersistentRoomBackgroundRunScheduleId(query.scheduleId);
	const status = parseOptionalPersistentRoomBackgroundRunStatus(query.status);
	return {
		...(scheduleId ? { scheduleId } : {}),
		...(status ? { status } : {}),
		limit: parsePersistentRoomBackgroundRunHistoryLimit(query.limit),
	};
}

app.get("/api/persistent-agents/:id/status", async (req, reply) => {
	const rawId = String((req.params as any).id ?? "").trim();
	let id: string;
	try {
		id = validatePersistentAgentId(rawId);
	} catch (e) {
		return reply.code(400).send({ error: (e as Error).message });
	}
	const status = getPersistentAgentStatus(id);
	if (!status.exists) return reply.code(404).send({ error: `persistent agent not found: ${id}` });
	if (isPersistentAgentArchived(status)) return reply.code(410).send({ error: `persistent agent is archived: ${id}`, status: "archived", agentId: id, archivedAt: status.archivedAt });
	return { ...status, models: roomModelsPayload(id) };
});

app.get("/api/persistent-agents/:id/background-runs", async (req, reply) => {
	try {
		const id = getPersistentRoomScheduleManagementRoomId(String((req.params as any).id ?? "").trim());
		const filters = parsePersistentRoomBackgroundRunHistoryQuery(req.query);
		const records = listBackgroundRuns({
			scope: { kind: "persistent-room", roomId: id },
			...(filters.status ? { status: filters.status } : {}),
			...(filters.scheduleId ? { schedulerJobId: filters.scheduleId } : {}),
			limit: filters.limit,
		});
		return buildPersistentRoomBackgroundRunsResponse(id, records, filters);
	} catch (e) {
		const explicitBody = (e as any)?.body;
		const explicitStatus = (e as any)?.statusCode;
		if (explicitStatus && explicitBody) return reply.code(explicitStatus).send(explicitBody);
		return reply.code(500).send({ error: browserSafeDiagnosticText(e instanceof Error ? e.message : String(e)) });
	}
});

app.get("/api/persistent-agents/:id/schedules", async (req, reply) => {
	const rawId = String((req.params as any).id ?? "").trim();
	let id: string;
	try {
		id = validatePersistentAgentId(rawId);
	} catch (e) {
		return reply.code(400).send({ error: (e as Error).message });
	}
	const status = getPersistentAgentStatus(id);
	if (!status.exists) return reply.code(404).send({ error: `persistent agent not found: ${id}` });
	if (isPersistentAgentArchived(status)) return reply.code(410).send({ error: `persistent agent is archived: ${id}`, status: "archived", agentId: id, archivedAt: status.archivedAt });
	try {
		const jobs = listPersistentRoomScheduleJobs(id);
		return {
			roomId: id,
			executionEnabled: false,
			jobs,
			summary: summarizePersistentRoomScheduleJobs(jobs),
			timeZone: serverTimeZone(),
		};
	} catch (e) {
		return reply.code(500).send({ error: (e as Error).message });
	}
});

app.post("/api/persistent-agents/:id/schedules", async (req, reply) => {
	try {
		const id = getPersistentRoomScheduleManagementRoomId(String((req.params as any).id ?? "").trim());
		const input = parsePersistentRoomScheduleCreateBody(req.body);
		const job = addPersistentRoomScheduleJob(id, { ...input, refuseUnrunnable: true });
		return reply.code(201).send(buildPersistentRoomScheduleManagementResponse(id, { job }));
	} catch (e) {
		return persistentRoomScheduleManagementErrorReply(reply, e);
	}
});

app.patch("/api/persistent-agents/:id/schedules/:jobId", async (req, reply) => {
	try {
		const id = getPersistentRoomScheduleManagementRoomId(String((req.params as any).id ?? "").trim());
		const jobId = parsePersistentRoomScheduleJobId((req.params as any).jobId);
		const patch = parsePersistentRoomSchedulePatchBody(req.body);
		const job = updatePersistentRoomScheduleJob(id, { jobId }, { ...patch, refuseUnrunnable: true });
		return buildPersistentRoomScheduleManagementResponse(id, { job });
	} catch (e) {
		return persistentRoomScheduleManagementErrorReply(reply, e);
	}
});

app.delete("/api/persistent-agents/:id/schedules/:jobId", async (req, reply) => {
	try {
		const id = getPersistentRoomScheduleManagementRoomId(String((req.params as any).id ?? "").trim());
		const jobId = parsePersistentRoomScheduleJobId((req.params as any).jobId);
		const removed = removePersistentRoomScheduleJob(id, { jobId });
		return buildPersistentRoomScheduleManagementResponse(id, { removed });
	} catch (e) {
		return persistentRoomScheduleManagementErrorReply(reply, e);
	}
});
