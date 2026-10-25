import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { Type } from "typebox";
import type { ExtensionAPI } from "@exxeta/exxperts-runtime";
import { productAppStatePath } from "../../product-state-paths.js";

export type PersistentRoomScheduleType = "once" | "interval" | "cron";
export type PersistentRoomScheduleStatus = "never_run" | "success" | "error" | "blocked" | "missed";

export interface PersistentRoomScheduleJob {
	id: string;
	name: string;
	enabled: boolean;
	type: PersistentRoomScheduleType;
	schedule: string;
	prompt: string;
	createdAt: string;
	updatedAt: string;
	lastRunAt: string | null;
	lastStatus: PersistentRoomScheduleStatus | null;
	lastError: string | null;
	nextRunAt: string | null;
}

export interface PersistentRoomScheduleStore {
	version: 1;
	roomId: string;
	jobs: PersistentRoomScheduleJob[];
}

export interface PersistentRoomScheduleSummary {
	executionEnabled: false;
	totalCount: number;
	enabledCount: number;
	nextRunAt: string | null;
	lastRunAt: string | null;
	lastStatus: PersistentRoomScheduleStatus | null;
	lastError: string | null;
}

export interface ParsedPersistentRoomSchedule {
	type: PersistentRoomScheduleType;
	schedule: string;
	nextRunAt: string | null;
	intervalMs?: number;
}

export type PersistentRoomScheduleDueOccurrenceStrategy = "once_nextRunAt" | "interval_anchor" | "simple_daily_cron";
export type PersistentRoomScheduleDueOccurrenceSkipReason =
	| "disabled"
	| "not_due"
	| "missing_nextRunAt"
	| "invalid_nextRunAt"
	| "invalid_interval"
	| "unsupported_cron_due_calculation"
	| "invalid_daily_cron";

export type PersistentRoomScheduleDueOccurrenceResult =
	| { due: true; dueAt: string; strategy: PersistentRoomScheduleDueOccurrenceStrategy }
	| { due: false; reason: PersistentRoomScheduleDueOccurrenceSkipReason };

export interface AddPersistentRoomScheduleJobInput {
	name?: unknown;
	type?: PersistentRoomScheduleType;
	schedule: unknown;
	prompt: unknown;
	enabled?: unknown;
	now?: Date;
}

export interface PersistentRoomScheduleJobSelector {
	jobId?: unknown;
	name?: unknown;
}

export interface UpdatePersistentRoomScheduleJobInput {
	name?: unknown;
	type?: PersistentRoomScheduleType;
	schedule?: unknown;
	prompt?: unknown;
	enabled?: unknown;
	now?: Date;
}

export interface SchedulePromptExtensionOptions {
	/** Persistent room/agent id. Prefer this over model-supplied room ids when the extension is wired into a scoped runtime. */
	roomId?: string;
}

const STORE_VERSION = 1 as const;
const SCHEDULE_ROOT_DIRNAME = "persistent-room-schedules";
const ROOM_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,119}$/;
const JOB_ID_PATTERN = /^sched_[a-f0-9]{32}$/;
const MAX_NAME_LENGTH = 160;
const MAX_SCHEDULE_LENGTH = 240;
const MIN_INTERVAL_MS = 1_000;
const MAX_INTERVAL_MS = 366 * 24 * 60 * 60 * 1000;

function defaultStore(roomId: string): PersistentRoomScheduleStore {
	return { version: STORE_VERSION, roomId, jobs: [] };
}

function normalizeNow(now: Date | undefined): Date {
	const date = now ? new Date(now) : new Date();
	if (Number.isNaN(date.getTime())) throw new Error("invalid schedule reference time");
	return date;
}

function requireNonEmptyString(value: unknown, label: string, maxLength?: number): string {
	const normalized = String(value ?? "").trim();
	if (!normalized) throw new Error(`${label} is required`);
	if (maxLength && normalized.length > maxLength) throw new Error(`${label} must be ${maxLength} characters or less`);
	return normalized;
}

export function isValidPersistentRoomScheduleRoomId(value: unknown): boolean {
	const roomId = String(value ?? "").trim();
	return roomId !== "." && roomId !== ".." && ROOM_ID_PATTERN.test(roomId);
}

export function validatePersistentRoomScheduleRoomId(value: unknown): string {
	const roomId = String(value ?? "").trim();
	if (!isValidPersistentRoomScheduleRoomId(roomId)) throw new Error(`invalid persistent room schedule room id: ${roomId || "(empty)"}`);
	return roomId;
}

export function persistentRoomScheduleRootPath(): string {
	return productAppStatePath(SCHEDULE_ROOT_DIRNAME);
}

export function persistentRoomScheduleStorePath(roomIdRaw: unknown): string {
	const roomId = validatePersistentRoomScheduleRoomId(roomIdRaw);
	const root = path.resolve(persistentRoomScheduleRootPath());
	const file = path.resolve(root, roomId, "schedules.json");
	if (file !== root && !file.startsWith(root + path.sep)) throw new Error("persistent room schedule store path escaped schedule root");
	return file;
}

function readJsonFile(file: string): unknown {
	try {
		return JSON.parse(fs.readFileSync(file, "utf-8"));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw new Error(`failed to read persistent room schedule store: ${(error as Error).message}`);
	}
}

function atomicWriteJson(file: string, value: unknown): void {
	fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
	const tempFile = path.join(path.dirname(file), `.schedules.${process.pid}.${crypto.randomBytes(8).toString("hex")}.tmp`);
	try {
		fs.writeFileSync(tempFile, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
		fs.renameSync(tempFile, file);
		try {
			fs.chmodSync(file, 0o600);
		} catch {
			// Best effort; the temp file was created with 0600.
		}
	} catch (error) {
		try {
			fs.rmSync(tempFile, { force: true });
		} catch {
			// Ignore cleanup failure and surface the original write error.
		}
		throw error;
	}
}

function normalizeStoredJob(value: unknown): PersistentRoomScheduleJob {
	if (!value || typeof value !== "object") throw new Error("invalid persistent room schedule job");
	const raw = value as Partial<PersistentRoomScheduleJob>;
	if (!JOB_ID_PATTERN.test(String(raw.id ?? ""))) throw new Error("invalid persistent room schedule job id");
	const type = raw.type;
	if (type !== "once" && type !== "interval" && type !== "cron") throw new Error("invalid persistent room schedule job type");
	const lastStatus = raw.lastStatus ?? null;
	if (lastStatus !== null && lastStatus !== "never_run" && lastStatus !== "success" && lastStatus !== "error" && lastStatus !== "blocked" && lastStatus !== "missed") {
		throw new Error("invalid persistent room schedule job status");
	}
	return {
		id: String(raw.id),
		name: requireNonEmptyString(raw.name, "job name", MAX_NAME_LENGTH),
		enabled: raw.enabled === true,
		type,
		schedule: requireNonEmptyString(raw.schedule, "schedule", MAX_SCHEDULE_LENGTH),
		prompt: requireNonEmptyString(raw.prompt, "prompt"),
		createdAt: requireIsoDateString(raw.createdAt, "createdAt"),
		updatedAt: requireIsoDateString(raw.updatedAt, "updatedAt"),
		lastRunAt: raw.lastRunAt === null || raw.lastRunAt === undefined ? null : requireIsoDateString(raw.lastRunAt, "lastRunAt"),
		lastStatus,
		lastError: raw.lastError === null || raw.lastError === undefined ? null : String(raw.lastError),
		nextRunAt: raw.nextRunAt === null || raw.nextRunAt === undefined ? null : requireIsoDateString(raw.nextRunAt, "nextRunAt"),
	};
}

function requireIsoDateString(value: unknown, label: string): string {
	const text = String(value ?? "").trim();
	if (!text || Number.isNaN(new Date(text).getTime())) throw new Error(`invalid persistent room schedule ${label}`);
	return text;
}

function normalizeStore(roomId: string, value: unknown): PersistentRoomScheduleStore {
	if (value === null) return defaultStore(roomId);
	if (!value || typeof value !== "object") throw new Error("invalid persistent room schedule store");
	const raw = value as Partial<PersistentRoomScheduleStore>;
	if (raw.version !== STORE_VERSION) throw new Error("unsupported persistent room schedule store version");
	if (raw.roomId !== undefined && raw.roomId !== roomId) throw new Error("persistent room schedule store room id mismatch");
	return {
		version: STORE_VERSION,
		roomId,
		jobs: Array.isArray(raw.jobs) ? raw.jobs.map(normalizeStoredJob) : [],
	};
}

export function readPersistentRoomScheduleStore(roomIdRaw: unknown): PersistentRoomScheduleStore {
	const roomId = validatePersistentRoomScheduleRoomId(roomIdRaw);
	return normalizeStore(roomId, readJsonFile(persistentRoomScheduleStorePath(roomId)));
}

export function writePersistentRoomScheduleStore(store: PersistentRoomScheduleStore): PersistentRoomScheduleStore {
	const roomId = validatePersistentRoomScheduleRoomId(store.roomId);
	const normalized: PersistentRoomScheduleStore = {
		version: STORE_VERSION,
		roomId,
		jobs: Array.isArray(store.jobs) ? store.jobs.map(normalizeStoredJob) : [],
	};
	atomicWriteJson(persistentRoomScheduleStorePath(roomId), normalized);
	return normalized;
}

export function listPersistentRoomScheduleJobs(roomId: unknown): PersistentRoomScheduleJob[] {
	return readPersistentRoomScheduleStore(roomId).jobs;
}

export function summarizePersistentRoomScheduleJobs(jobs: PersistentRoomScheduleJob[]): PersistentRoomScheduleSummary {
	const enabledJobs = jobs.filter((job) => job.enabled);
	const nextRunAt = enabledJobs
		.map((job) => job.nextRunAt)
		.filter((value): value is string => typeof value === "string" && value.length > 0)
		.sort()[0] ?? null;
	const jobsWithLastRun = jobs
		.filter((job) => job.lastRunAt)
		.sort((a, b) => String(b.lastRunAt).localeCompare(String(a.lastRunAt)));
	const lastJob = jobsWithLastRun[0] ?? jobs.find((job) => job.lastStatus !== null) ?? null;
	return {
		executionEnabled: false,
		totalCount: jobs.length,
		enabledCount: enabledJobs.length,
		nextRunAt,
		lastRunAt: lastJob?.lastRunAt ?? null,
		lastStatus: lastJob?.lastStatus ?? null,
		lastError: lastJob?.lastError ?? null,
	};
}

function parseDuration(value: string): number | null {
	const match = value.trim().toLowerCase().match(/^(\d+)\s*(s|sec|secs|second|seconds|m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days)$/);
	if (!match) return null;
	const count = Number(match[1]);
	if (!Number.isSafeInteger(count) || count <= 0) return null;
	const unit = match[2][0];
	const scale = unit === "s" ? 1000 : unit === "m" ? 60_000 : unit === "h" ? 3_600_000 : 86_400_000;
	const ms = count * scale;
	if (ms < MIN_INTERVAL_MS || ms > MAX_INTERVAL_MS) return null;
	return ms;
}

function parseIsoDate(value: unknown): Date | null {
	if (typeof value !== "string" || !value.trim()) return null;
	const date = new Date(value);
	if (Number.isNaN(date.getTime())) return null;
	return date;
}

function parseSimpleDailyCron(expression: string): { hour: number; minute: number } | null {
	const fields = expression.trim().replace(/\s+/g, " ").split(" ");
	if (fields.length !== 6) return null;
	const [second, minuteRaw, hourRaw, dayOfMonth, month, dayOfWeek] = fields;
	if (second !== "0" || dayOfMonth !== "*" || month !== "*" || dayOfWeek !== "*") return null;
	if (!validateCronNumber(minuteRaw, 0, 59) || !validateCronNumber(hourRaw, 0, 23)) return null;
	return { hour: Number(hourRaw), minute: Number(minuteRaw) };
}

function computeSimpleDailyCronDueAt(job: PersistentRoomScheduleJob, now: Date): PersistentRoomScheduleDueOccurrenceResult {
	const daily = parseSimpleDailyCron(job.schedule);
	if (!daily) {
		try {
			validateCronExpression(job.schedule);
			return { due: false, reason: "unsupported_cron_due_calculation" };
		} catch {
			return { due: false, reason: "invalid_daily_cron" };
		}
	}
	const createdAt = parseIsoDate(job.createdAt);
	if (!createdAt) return { due: false, reason: "invalid_daily_cron" };
	const candidate = new Date(now);
	candidate.setHours(daily.hour, daily.minute, 0, 0);
	if (candidate.getTime() > now.getTime()) candidate.setDate(candidate.getDate() - 1);
	if (candidate.getTime() < createdAt.getTime()) return { due: false, reason: "not_due" };
	return { due: true, dueAt: candidate.toISOString(), strategy: "simple_daily_cron" };
}

export function computePersistentRoomScheduleDueOccurrence(
	job: PersistentRoomScheduleJob,
	input: { now?: Date } = {},
): PersistentRoomScheduleDueOccurrenceResult {
	if (!job.enabled) return { due: false, reason: "disabled" };
	const now = normalizeNow(input.now);
	if (job.type === "once") {
		if (!job.nextRunAt) return { due: false, reason: "missing_nextRunAt" };
		const nextRunAt = parseIsoDate(job.nextRunAt);
		if (!nextRunAt) return { due: false, reason: "invalid_nextRunAt" };
		if (nextRunAt.getTime() > now.getTime()) return { due: false, reason: "not_due" };
		return { due: true, dueAt: nextRunAt.toISOString(), strategy: "once_nextRunAt" };
	}
	if (job.type === "interval") {
		if (!job.nextRunAt) return { due: false, reason: "missing_nextRunAt" };
		const anchor = parseIsoDate(job.nextRunAt);
		if (!anchor) return { due: false, reason: "invalid_nextRunAt" };
		const intervalMs = parseDuration(job.schedule);
		if (!intervalMs) return { due: false, reason: "invalid_interval" };
		if (now.getTime() < anchor.getTime()) return { due: false, reason: "not_due" };
		const occurrenceIndex = Math.floor((now.getTime() - anchor.getTime()) / intervalMs);
		const dueAt = new Date(anchor.getTime() + occurrenceIndex * intervalMs);
		return { due: true, dueAt: dueAt.toISOString(), strategy: "interval_anchor" };
	}
	if (job.type === "cron") return computeSimpleDailyCronDueAt(job, now);
	return { due: false, reason: "unsupported_cron_due_calculation" };
}

function canonicalDuration(value: string): string {
	const match = value.trim().toLowerCase().match(/^(\d+)\s*(s|sec|secs|second|seconds|m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days)$/);
	if (!match) throw new Error(`Invalid interval "${value}". Use examples like "1h", "30m", or "2 days".`);
	const unit = match[2][0];
	return `${Number(match[1])}${unit}`;
}

function parseClock(raw: string): { hour: number; minute: number } | null {
	const match = raw.trim().toLowerCase().match(/^(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)?$/);
	if (!match) return null;
	let hour = Number(match[1]);
	const minute = Number(match[2] ?? 0);
	if (!Number.isInteger(hour) || !Number.isInteger(minute) || minute < 0 || minute > 59) return null;
	const suffix = match[3]?.replace(/\./g, "");
	if (suffix === "pm" && hour < 12) hour += 12;
	if (suffix === "am" && hour === 12) hour = 0;
	if (hour < 0 || hour > 23) return null;
	return { hour, minute };
}

function resolveOnce(raw: string, now: Date): string {
	const lower = raw.toLowerCase().trim();
	const relative = lower.match(/^\+\s*(\d+)\s*(s|sec|secs|second|seconds|m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days)$/);
	if (relative) {
		const ms = parseDuration(`${relative[1]}${relative[2]}`);
		if (!ms) throw new Error(`Invalid relative time "${raw}".`);
		return new Date(now.getTime() + ms).toISOString();
	}
	const tomorrow = lower.match(/^tomorrow(?:\s+at)?\s+(.+)$/);
	if (tomorrow) {
		const clock = parseClock(tomorrow[1]);
		if (!clock) throw new Error(`Invalid time "${tomorrow[1]}".`);
		const date = new Date(now);
		date.setDate(date.getDate() + 1);
		date.setHours(clock.hour, clock.minute, 0, 0);
		return date.toISOString();
	}
	const date = new Date(raw);
	if (Number.isNaN(date.getTime())) throw new Error(`Invalid one-shot schedule "${raw}". Use ISO, "+30m", or "tomorrow at 7".`);
	if (date.getTime() <= now.getTime()) throw new Error(`Scheduled time is in the past: ${date.toISOString()}.`);
	return date.toISOString();
}

function validateCronNumber(value: string, min: number, max: number): boolean {
	if (!/^\d+$/.test(value)) return false;
	const n = Number(value);
	return Number.isInteger(n) && n >= min && n <= max;
}

function validateCronFieldPart(part: string, min: number, max: number): boolean {
	if (!part) return false;
	const [base, step, extra] = part.split("/");
	if (extra !== undefined) return false;
	if (step !== undefined && (!validateCronNumber(step, 1, max) || Number(step) <= 0)) return false;
	if (base === "*") return true;
	if (base.includes("-")) {
		const [start, end, rangeExtra] = base.split("-");
		if (rangeExtra !== undefined) return false;
		if (!validateCronNumber(start, min, max) || !validateCronNumber(end, min, max)) return false;
		return Number(start) <= Number(end);
	}
	return validateCronNumber(base, min, max);
}

function validateCronField(field: string, min: number, max: number): boolean {
	return field.split(",").every((part) => validateCronFieldPart(part, min, max));
}

function validateCronExpression(expression: string): string {
	const normalized = expression.trim().replace(/\s+/g, " ");
	const fields = normalized.split(" ");
	if (fields.length !== 6) throw new Error(`Cron expression must have 6 fields including seconds, got ${fields.length}. Example: "0 0 7 * * *".`);
	const bounds: Array<[number, number]> = [[0, 59], [0, 59], [0, 23], [1, 31], [1, 12], [0, 7]];
	for (let i = 0; i < fields.length; i += 1) {
		const [min, max] = bounds[i];
		if (!validateCronField(fields[i], min, max)) throw new Error(`Invalid cron field ${i + 1}: "${fields[i]}".`);
	}
	return normalized;
}

export function parsePersistentRoomSchedule(scheduleRaw: unknown, typeRaw?: PersistentRoomScheduleType, input: { now?: Date } = {}): ParsedPersistentRoomSchedule {
	const raw = requireNonEmptyString(scheduleRaw, "schedule", MAX_SCHEDULE_LENGTH);
	const now = normalizeNow(input.now);
	const lower = raw.toLowerCase();
	if (typeRaw !== undefined && typeRaw !== "once" && typeRaw !== "interval" && typeRaw !== "cron") throw new Error(`invalid schedule type: ${String(typeRaw)}`);

	if (typeRaw === "interval") {
		const intervalMs = parseDuration(raw);
		if (!intervalMs) throw new Error(`Invalid interval "${raw}". Use examples like "1h", "30m", or "2 days".`);
		return { type: "interval", schedule: canonicalDuration(raw), intervalMs, nextRunAt: new Date(now.getTime() + intervalMs).toISOString() };
	}
	if (typeRaw === "once") {
		const schedule = resolveOnce(raw, now);
		return { type: "once", schedule, nextRunAt: schedule };
	}
	if (typeRaw === "cron") return { type: "cron", schedule: validateCronExpression(raw), nextRunAt: null };

	if (/^\+\s*\d+/.test(lower)) {
		const schedule = resolveOnce(raw, now);
		return { type: "once", schedule, nextRunAt: schedule };
	}
	if (/^in\s+\d+/.test(lower)) {
		const schedule = resolveOnce(lower.replace(/^in\s+/, "+"), now);
		return { type: "once", schedule, nextRunAt: schedule };
	}
	const every = lower.match(/^every\s+(\d+\s*)?(second|seconds|minute|minutes|hour|hours|day|days)$/);
	if (every) return parsePersistentRoomSchedule(`${every[1]?.trim() || "1"}${every[2][0]}`, "interval", { now });
	if (lower === "hourly" || lower === "every hour") return parsePersistentRoomSchedule("1h", "interval", { now });
	if (lower === "daily" || lower === "every day") return parsePersistentRoomSchedule("0 0 0 * * *", "cron", { now });
	const daily = lower.match(/^(?:daily|every day|every morning)(?:\s+at)?\s+(.+)$/);
	if (daily) {
		const clock = parseClock(daily[1]);
		if (clock) return parsePersistentRoomSchedule(`0 ${clock.minute} ${clock.hour} * * *`, "cron", { now });
	}
	if (raw.trim().split(/\s+/).length === 6) return parsePersistentRoomSchedule(raw, "cron", { now });
	if (parseDuration(raw)) return parsePersistentRoomSchedule(raw, "interval", { now });
	const schedule = resolveOnce(raw, now);
	return { type: "once", schedule, nextRunAt: schedule };
}

function generateScheduleJobId(existingIds: Set<string>): string {
	for (let attempt = 0; attempt < 20; attempt += 1) {
		const id = `sched_${crypto.randomUUID().replace(/-/g, "")}`;
		if (!existingIds.has(id)) return id;
	}
	throw new Error("could not allocate unique schedule job id");
}

function findJobIndex(store: PersistentRoomScheduleStore, selector: PersistentRoomScheduleJobSelector): number {
	const jobId = String(selector.jobId ?? "").trim();
	if (jobId) {
		const index = store.jobs.findIndex((job) => job.id === jobId);
		if (index >= 0) return index;
		throw new Error(`Scheduled prompt not found: ${jobId}.`);
	}
	const name = String(selector.name ?? "").trim().toLowerCase();
	if (!name) throw new Error("jobId or name is required");
	const matches = store.jobs.map((job, index) => ({ job, index })).filter(({ job }) => job.name.toLowerCase() === name);
	if (matches.length === 1) return matches[0].index;
	if (matches.length > 1) throw new Error(`Multiple scheduled prompts are named "${selector.name}". List jobs and use the ID.`);
	throw new Error(`Scheduled prompt not found: ${selector.name}.`);
}

export function addPersistentRoomScheduleJob(roomIdRaw: unknown, input: AddPersistentRoomScheduleJobInput): PersistentRoomScheduleJob {
	const roomId = validatePersistentRoomScheduleRoomId(roomIdRaw);
	const store = readPersistentRoomScheduleStore(roomId);
	const now = normalizeNow(input.now);
	const parsed = parsePersistentRoomSchedule(input.schedule, input.type, { now });
	const createdAt = now.toISOString();
	const job: PersistentRoomScheduleJob = {
		id: generateScheduleJobId(new Set(store.jobs.map((existing) => existing.id))),
		name: input.name === undefined ? `scheduled-${store.jobs.length + 1}` : requireNonEmptyString(input.name, "job name", MAX_NAME_LENGTH),
		enabled: input.enabled === undefined ? true : input.enabled === true,
		type: parsed.type,
		schedule: parsed.schedule,
		prompt: requireNonEmptyString(input.prompt, "prompt"),
		createdAt,
		updatedAt: createdAt,
		lastRunAt: null,
		lastStatus: null,
		lastError: null,
		nextRunAt: parsed.nextRunAt,
	};
	store.jobs.push(job);
	writePersistentRoomScheduleStore(store);
	return job;
}

export function updatePersistentRoomScheduleJob(roomIdRaw: unknown, selector: PersistentRoomScheduleJobSelector, input: UpdatePersistentRoomScheduleJobInput): PersistentRoomScheduleJob {
	const roomId = validatePersistentRoomScheduleRoomId(roomIdRaw);
	const store = readPersistentRoomScheduleStore(roomId);
	const index = findJobIndex(store, selector);
	const current = store.jobs[index];
	const now = normalizeNow(input.now);
	const patch: Partial<PersistentRoomScheduleJob> = {};
	if (input.name !== undefined) patch.name = requireNonEmptyString(input.name, "job name", MAX_NAME_LENGTH);
	if (input.prompt !== undefined) patch.prompt = requireNonEmptyString(input.prompt, "prompt");
	if (input.enabled !== undefined) patch.enabled = input.enabled === true;
	if (input.schedule !== undefined || input.type !== undefined) {
		const parsed = parsePersistentRoomSchedule(input.schedule ?? current.schedule, input.type ?? current.type, { now });
		patch.type = parsed.type;
		patch.schedule = parsed.schedule;
		patch.nextRunAt = parsed.nextRunAt;
	}
	patch.updatedAt = now.toISOString();
	store.jobs[index] = { ...current, ...patch };
	writePersistentRoomScheduleStore(store);
	return store.jobs[index];
}

export function setPersistentRoomScheduleJobEnabled(roomId: unknown, selector: PersistentRoomScheduleJobSelector, enabled: boolean, input: { now?: Date } = {}): PersistentRoomScheduleJob {
	return updatePersistentRoomScheduleJob(roomId, selector, { enabled, now: input.now });
}

export function removePersistentRoomScheduleJob(roomIdRaw: unknown, selector: PersistentRoomScheduleJobSelector): PersistentRoomScheduleJob {
	const roomId = validatePersistentRoomScheduleRoomId(roomIdRaw);
	const store = readPersistentRoomScheduleStore(roomId);
	const index = findJobIndex(store, selector);
	const [removed] = store.jobs.splice(index, 1);
	writePersistentRoomScheduleStore(store);
	return removed;
}

function scheduleTypeFromInput(value: unknown): PersistentRoomScheduleType | undefined {
	if (value === undefined || value === null || value === "") return undefined;
	if (value === "once" || value === "interval" || value === "cron") return value;
	throw new Error(`invalid schedule type: ${String(value)}`);
}

function resolveToolRoomId(options: SchedulePromptExtensionOptions, params: { roomId?: unknown }): string {
	const configured = options.roomId ? validatePersistentRoomScheduleRoomId(options.roomId) : "";
	const requested = String(params.roomId ?? "").trim();
	if (configured && requested && requested !== configured) throw new Error("schedule_prompt is scoped to a different persistent room");
	if (configured) return configured;
	if (requested) return validatePersistentRoomScheduleRoomId(requested);
	const fromEnv = String(process.env.EXXETA_PERSISTENT_ROOM_AGENT ?? "").trim();
	if (fromEnv) return validatePersistentRoomScheduleRoomId(fromEnv);
	throw new Error("schedule_prompt requires a persistent room id");
}

function scheduleJobSummary(job: PersistentRoomScheduleJob): string {
	const state = job.enabled ? "enabled" : "disabled";
	const next = job.nextRunAt ? ` next=${job.nextRunAt}` : "";
	return `${state} ${job.name} (${job.id}) ${job.type} ${job.schedule}${next}`;
}

function managementOnlyNotice(): string {
	return "This is a registry-only schedule record; autonomous scheduled execution is not enabled in this build.";
}

function detailsFor(roomId: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
	return { roomId, executionEnabled: false, managementOnly: true, ...extra };
}

export default function schedulePromptExtension(pi: ExtensionAPI, options: SchedulePromptExtensionOptions = {}): void {
	pi.registerTool({
		name: "schedule_prompt",
		label: "Schedule prompt",
		description: "Manage persistent-room schedule records. Registry-only in this build: records do not run autonomously yet.",
		parameters: Type.Object({
			action: Type.Union([
				Type.Literal("add"),
				Type.Literal("list"),
				Type.Literal("remove"),
				Type.Literal("enable"),
				Type.Literal("disable"),
				Type.Literal("update"),
			]),
			roomId: Type.Optional(Type.String({ description: "Persistent room id. Normally supplied by extension options when scoped to a room." })),
			jobId: Type.Optional(Type.String({ description: "Schedule job id from list output." })),
			name: Type.Optional(Type.String({ description: "Job name to create, or to match for remove/enable/disable/update when jobId is not supplied." })),
			type: Type.Optional(Type.Union([Type.Literal("once"), Type.Literal("interval"), Type.Literal("cron")])),
			schedule: Type.Optional(Type.String({ description: "Examples: +30m, tomorrow at 7, 1h, every hour, every day at 7am, 0 0 7 * * *." })),
			prompt: Type.Optional(Type.String({ description: "Prompt text to store for the schedule record." })),
			enabled: Type.Optional(Type.Boolean({ description: "Enabled state for add/update." })),
		}),
		async execute(_toolCallId, params): Promise<any> {
			const roomId = resolveToolRoomId(options, params);
			const action = String(params.action);

			if (action === "list") {
				const jobs = listPersistentRoomScheduleJobs(roomId);
				const text = jobs.length === 0
					? `No schedule records for persistent room ${roomId}. ${managementOnlyNotice()}`
					: [`Schedule records for persistent room ${roomId}:`, ...jobs.map(scheduleJobSummary), managementOnlyNotice()].join("\n");
				return { content: [{ type: "text", text }], details: detailsFor(roomId, { jobs }) };
			}

			if (action === "add") {
				const job = addPersistentRoomScheduleJob(roomId, {
					name: params.name,
					type: scheduleTypeFromInput(params.type),
					schedule: params.schedule,
					prompt: params.prompt,
					enabled: params.enabled,
				});
				return {
					content: [{ type: "text", text: `Saved schedule record "${job.name}" (${job.id}) for persistent room ${roomId}. ${managementOnlyNotice()}` }],
					details: detailsFor(roomId, { job }),
				};
			}

			const selector = { jobId: params.jobId, name: params.name };
			if (action === "remove") {
				const job = removePersistentRoomScheduleJob(roomId, selector);
				return {
					content: [{ type: "text", text: `Removed schedule record "${job.name}" (${job.id}) from persistent room ${roomId}.` }],
					details: detailsFor(roomId, { removed: job }),
				};
			}
			if (action === "enable" || action === "disable") {
				const enabled = action === "enable";
				const job = setPersistentRoomScheduleJobEnabled(roomId, selector, enabled);
				return {
					content: [{ type: "text", text: `${enabled ? "Enabled" : "Disabled"} schedule record "${job.name}" (${job.id}) for persistent room ${roomId}. ${managementOnlyNotice()}` }],
					details: detailsFor(roomId, { job }),
				};
			}
			if (action === "update") {
				const job = updatePersistentRoomScheduleJob(roomId, selector, {
					name: params.name,
					type: scheduleTypeFromInput(params.type),
					schedule: params.schedule,
					prompt: params.prompt,
					enabled: params.enabled,
				});
				return {
					content: [{ type: "text", text: `Updated schedule record "${job.name}" (${job.id}) for persistent room ${roomId}. ${managementOnlyNotice()}` }],
					details: detailsFor(roomId, { job }),
				};
			}

			throw new Error(`Unknown schedule_prompt action: ${action}`);
		},
	});
}
