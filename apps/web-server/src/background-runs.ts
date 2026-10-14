import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { productAppStatePath } from "../../../pi-package/product-state-paths.js";

export type BackgroundRunKind = "scheduled-prompt" | "room-consult" | "global-memory-refresh";
export type BackgroundRunStatus = "queued" | "running" | "deferred" | "blocked" | "succeeded" | "failed" | "cancelled";
export type BackgroundRunTrigger = "manual" | "schedule-due" | "system";

export type BackgroundRunScope =
	| { kind: "persistent-room"; roomId: string }
	| { kind: "room-consult"; sourceRoomId: string; targetRoomId: string }
	| { kind: "global-memory" };

export interface BackgroundRunModelLock {
	provider: string;
	model: string;
	label?: string;
}

export interface BackgroundRunLease {
	workerId: string;
	token: string;
	claimedAt: string;
	expiresAt: string;
	heartbeatAt?: string;
}

export type BackgroundRunReadinessResult = "ready" | "deferred" | "blocked" | "cancelled" | "failed";

export interface BackgroundRunReadinessChecks {
	schedule?: "enabled" | "missing" | "disabled" | "unreadable";
	room?: "ready" | "deferred" | "blocked";
	modelPolicy?: "ready" | "blocked" | "not_applicable";
	runtimeModel?: "ready" | "model_not_found" | "provider_not_connected" | "not_checked";
}

export interface BackgroundRunReadiness {
	checkedAt: string;
	expiresAt?: string;
	result: BackgroundRunReadinessResult;
	reason: string;
	message?: string;
	workerId?: string;
	target?: BackgroundRunTarget;
	model?: BackgroundRunModelLock;
	checks?: BackgroundRunReadinessChecks;
}

export interface BackgroundRunTarget {
	kind: "resume-thread" | "fresh-thread" | "no-room-mutation" | "none";
	roomId?: string;
	threadId?: string;
	model?: BackgroundRunModelLock;
	modelPolicyKey?: "scheduledRoom" | string;
}

export interface BackgroundRunArtifacts {
	inputRelPath?: string;
	outputRelPath?: string;
	eventRelPath?: string;
}

export interface BackgroundRunRecord {
	version: 1;
	runId: string;
	kind: BackgroundRunKind;
	scope: BackgroundRunScope;
	source: {
		schedulerJobId?: string;
		trigger: BackgroundRunTrigger;
		dueAt?: string;
	};
	status: BackgroundRunStatus;
	reason?: string;
	message?: string;
	createdAt: string;
	updatedAt: string;
	queuedAt?: string;
	startedAt?: string;
	finishedAt?: string;
	attempts: number;
	revision?: number;
	lease?: BackgroundRunLease;
	readiness?: BackgroundRunReadiness;
	target?: BackgroundRunTarget;
	artifacts?: BackgroundRunArtifacts;
	warnings: string[];
	error?: { code: string; message: string };
}

export interface CreateBackgroundRunInput {
	runId?: unknown;
	kind: BackgroundRunKind;
	scope: BackgroundRunScope;
	source: {
		schedulerJobId?: unknown;
		trigger: BackgroundRunTrigger;
		dueAt?: unknown;
	};
	status?: BackgroundRunStatus;
	reason?: unknown;
	message?: unknown;
	target?: BackgroundRunTarget;
	artifacts?: BackgroundRunArtifacts;
	warnings?: unknown[];
	error?: { code: unknown; message: unknown };
	now?: Date;
}

export interface UpdateBackgroundRunInput {
	status?: BackgroundRunStatus;
	reason?: unknown;
	message?: unknown;
	startedAt?: unknown;
	finishedAt?: unknown;
	attempts?: unknown;
	target?: BackgroundRunTarget | null;
	artifacts?: BackgroundRunArtifacts | null;
	warnings?: unknown[];
	error?: { code: unknown; message: unknown } | null;
	now?: Date;
}

export interface ListBackgroundRunsOptions {
	kind?: BackgroundRunKind;
	scope?: BackgroundRunScope;
	status?: BackgroundRunStatus;
	schedulerJobId?: string;
	limit?: number;
}

export interface FindBackgroundRunByScheduledOccurrenceInput {
	roomId: unknown;
	schedulerJobId: unknown;
	dueAt: unknown;
}

export interface ClaimBackgroundRunLeaseInput {
	runId: unknown;
	workerId: unknown;
	token?: unknown;
	now?: Date;
	leaseMs?: unknown;
}

export interface ExtendBackgroundRunLeaseInput {
	runId: unknown;
	token: unknown;
	now?: Date;
	leaseMs?: unknown;
}

export interface UpdateClaimedBackgroundRunStatusInput {
	runId: unknown;
	token: unknown;
	status: BackgroundRunStatus;
	reason?: unknown;
	message?: unknown;
	startedAt?: unknown;
	finishedAt?: unknown;
	target?: BackgroundRunTarget | null;
	artifacts?: BackgroundRunArtifacts | null;
	warnings?: unknown[];
	error?: { code: unknown; message: unknown } | null;
	readiness?: BackgroundRunReadiness | null;
	now?: Date;
	clearLease?: boolean;
}

export interface RecoverExpiredBackgroundRunLeasesInput {
	now?: Date;
	limit?: unknown;
	kind?: BackgroundRunKind;
	scope?: BackgroundRunScope;
}

export interface ListClaimableScheduledPromptBackgroundRunsOptions {
	now?: Date;
	limit?: unknown;
	scope?: BackgroundRunScope;
	schedulerJobId?: string;
}

const STORE_VERSION = 1 as const;
const BACKGROUND_RUNS_ROOT_DIRNAME = "background-runs";
const RUNS_DIRNAME = "runs";
const RUN_ID_PATTERN = /^bg_[a-f0-9]{32}$/;
const SAFE_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,119}$/;
// Conversation ids carry a time stamp with a capital T and Z (postcp_20261011T150343Z_ab12cd).
const THREAD_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,119}$/;
const MAX_REASON_LENGTH = 120;
const MAX_MESSAGE_LENGTH = 1000;
const MAX_WORKER_ID_LENGTH = 240;
const MAX_LEASE_TOKEN_LENGTH = 240;
const MAX_REL_PATH_LENGTH = 240;
const DEFAULT_LIST_LIMIT = 100;
const MAX_LIST_LIMIT = 1000;
const DEFAULT_LEASE_MS = 5 * 60 * 1000;
const MIN_LEASE_MS = 1;
const MAX_LEASE_MS = 24 * 60 * 60 * 1000;
const MUTATION_LOCK_DIRNAME = ".mutation-lock";
// Locks are held only across one read-modify-write of run.json (milliseconds); anything this old is a
// crash leftover (SIGKILL/power loss skips the release) and must be reclaimable or the run's mutations
// stall forever. Kept far above any plausible pause of a live holder.
const MUTATION_LOCK_STALE_MS = 30 * 60 * 1000;

export function backgroundRunsRootPath(): string {
	return productAppStatePath(BACKGROUND_RUNS_ROOT_DIRNAME);
}

export function backgroundRunsDirectoryPath(): string {
	return path.join(backgroundRunsRootPath(), RUNS_DIRNAME);
}

export function generateBackgroundRunId(): string {
	return `bg_${crypto.randomBytes(16).toString("hex")}`;
}

export function generateBackgroundRunLeaseToken(): string {
	return crypto.randomBytes(32).toString("base64url");
}

export function isValidBackgroundRunId(value: unknown): boolean {
	const runId = String(value ?? "").trim();
	return RUN_ID_PATTERN.test(runId);
}

export function validateBackgroundRunId(value: unknown): string {
	const runId = String(value ?? "").trim();
	if (!isValidBackgroundRunId(runId)) throw new Error(`invalid background run id: ${runId || "(empty)"}`);
	return runId;
}

export function backgroundRunRecordPath(runIdRaw: unknown): string {
	const runId = validateBackgroundRunId(runIdRaw);
	const root = path.resolve(backgroundRunsDirectoryPath());
	const file = path.resolve(root, runId, "run.json");
	if (file !== root && !file.startsWith(root + path.sep)) throw new Error("background run path escaped run root");
	return file;
}

function normalizeNow(now: Date | undefined): Date {
	const date = now ? new Date(now) : new Date();
	if (Number.isNaN(date.getTime())) throw new Error("invalid background run reference time");
	return date;
}

function readJsonFile(file: string): unknown {
	try {
		return JSON.parse(fs.readFileSync(file, "utf-8"));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw new Error(`failed to read background run record: ${(error as Error).message}`);
	}
}

function atomicWriteJson(file: string, value: unknown): void {
	fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
	const tempFile = path.join(path.dirname(file), `.run.${process.pid}.${crypto.randomBytes(8).toString("hex")}.tmp`);
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

function requireNonEmptyString(value: unknown, label: string, maxLength?: number): string {
	const normalized = String(value ?? "").trim();
	if (!normalized) throw new Error(`${label} is required`);
	if (maxLength && normalized.length > maxLength) throw new Error(`${label} must be ${maxLength} characters or less`);
	return normalized;
}

function optionalString(value: unknown, label: string, maxLength?: number): string | undefined {
	if (value === undefined || value === null) return undefined;
	const normalized = String(value).trim();
	if (!normalized) return undefined;
	if (maxLength && normalized.length > maxLength) throw new Error(`${label} must be ${maxLength} characters or less`);
	return normalized;
}

function requireIsoDateString(value: unknown, label: string): string {
	const text = String(value ?? "").trim();
	if (!text || Number.isNaN(new Date(text).getTime())) throw new Error(`invalid background run ${label}`);
	return text;
}

function optionalIsoDateString(value: unknown, label: string): string | undefined {
	if (value === undefined || value === null) return undefined;
	return requireIsoDateString(value, label);
}

function normalizeIsoDateString(value: unknown, label: string): string {
	return new Date(requireIsoDateString(value, label)).toISOString();
}

function validateSafeId(value: unknown, label: string, pattern = SAFE_ID_PATTERN): string {
	const text = String(value ?? "").trim();
	if (!pattern.test(text)) throw new Error(`invalid background run ${label}: ${text || "(empty)"}`);
	return text;
}

function validateKind(value: unknown): BackgroundRunKind {
	if (value !== "scheduled-prompt" && value !== "room-consult" && value !== "global-memory-refresh") throw new Error("invalid background run kind");
	return value;
}

function validateStatus(value: unknown): BackgroundRunStatus {
	if (value !== "queued" && value !== "running" && value !== "deferred" && value !== "blocked" && value !== "succeeded" && value !== "failed" && value !== "cancelled") {
		throw new Error("invalid background run status");
	}
	return value;
}

function validateTrigger(value: unknown): BackgroundRunTrigger {
	if (value !== "manual" && value !== "schedule-due" && value !== "system") throw new Error("invalid background run trigger");
	return value;
}

function normalizeScope(value: unknown): BackgroundRunScope {
	if (!value || typeof value !== "object") throw new Error("invalid background run scope");
	const raw = value as Partial<BackgroundRunScope>;
	if (raw.kind === "persistent-room") return { kind: "persistent-room", roomId: validateSafeId((raw as { roomId?: unknown }).roomId, "room id") };
	if (raw.kind === "room-consult") {
		return {
			kind: "room-consult",
			sourceRoomId: validateSafeId((raw as { sourceRoomId?: unknown }).sourceRoomId, "source room id"),
			targetRoomId: validateSafeId((raw as { targetRoomId?: unknown }).targetRoomId, "target room id"),
		};
	}
	if (raw.kind === "global-memory") return { kind: "global-memory" };
	throw new Error("invalid background run scope kind");
}

function normalizeModel(value: unknown): BackgroundRunModelLock {
	if (!value || typeof value !== "object") throw new Error("invalid background run model lock");
	const raw = value as Partial<BackgroundRunModelLock>;
	return {
		provider: requireNonEmptyString(raw.provider, "model provider", 120),
		model: requireNonEmptyString(raw.model, "model", 240),
		...(optionalString(raw.label, "model label", 240) ? { label: optionalString(raw.label, "model label", 240) } : {}),
	};
}

function normalizeLease(value: unknown): BackgroundRunLease {
	if (!value || typeof value !== "object") throw new Error("invalid background run lease");
	const raw = value as Partial<BackgroundRunLease>;
	return {
		workerId: requireNonEmptyString(raw.workerId, "lease worker id", MAX_WORKER_ID_LENGTH),
		token: requireNonEmptyString(raw.token, "lease token", MAX_LEASE_TOKEN_LENGTH),
		claimedAt: requireIsoDateString(raw.claimedAt, "lease claimedAt"),
		expiresAt: requireIsoDateString(raw.expiresAt, "lease expiresAt"),
		...(optionalIsoDateString(raw.heartbeatAt, "lease heartbeatAt") ? { heartbeatAt: optionalIsoDateString(raw.heartbeatAt, "lease heartbeatAt") } : {}),
	};
}

function validateReadinessResult(value: unknown): BackgroundRunReadinessResult {
	if (value !== "ready" && value !== "deferred" && value !== "blocked" && value !== "cancelled" && value !== "failed") throw new Error("invalid background run readiness result");
	return value;
}

function normalizeReadinessChecks(value: unknown): BackgroundRunReadinessChecks {
	if (!value || typeof value !== "object") throw new Error("invalid background run readiness checks");
	const raw = value as BackgroundRunReadinessChecks;
	const checks: BackgroundRunReadinessChecks = {};
	if (raw.schedule !== undefined) {
		if (raw.schedule !== "enabled" && raw.schedule !== "missing" && raw.schedule !== "disabled" && raw.schedule !== "unreadable") throw new Error("invalid background run readiness schedule check");
		checks.schedule = raw.schedule;
	}
	if (raw.room !== undefined) {
		if (raw.room !== "ready" && raw.room !== "deferred" && raw.room !== "blocked") throw new Error("invalid background run readiness room check");
		checks.room = raw.room;
	}
	if (raw.modelPolicy !== undefined) {
		if (raw.modelPolicy !== "ready" && raw.modelPolicy !== "blocked" && raw.modelPolicy !== "not_applicable") throw new Error("invalid background run readiness model policy check");
		checks.modelPolicy = raw.modelPolicy;
	}
	if (raw.runtimeModel !== undefined) {
		if (raw.runtimeModel !== "ready" && raw.runtimeModel !== "model_not_found" && raw.runtimeModel !== "provider_not_connected" && raw.runtimeModel !== "not_checked") throw new Error("invalid background run readiness runtime model check");
		checks.runtimeModel = raw.runtimeModel;
	}
	return checks;
}

function normalizeReadiness(value: unknown): BackgroundRunReadiness {
	if (!value || typeof value !== "object") throw new Error("invalid background run readiness");
	const raw = value as Partial<BackgroundRunReadiness>;
	return {
		checkedAt: requireIsoDateString(raw.checkedAt, "readiness checkedAt"),
		...(optionalIsoDateString(raw.expiresAt, "readiness expiresAt") ? { expiresAt: optionalIsoDateString(raw.expiresAt, "readiness expiresAt") } : {}),
		result: validateReadinessResult(raw.result),
		reason: requireNonEmptyString(raw.reason, "readiness reason", MAX_REASON_LENGTH),
		...(optionalString(raw.message, "readiness message", MAX_MESSAGE_LENGTH) ? { message: optionalString(raw.message, "readiness message", MAX_MESSAGE_LENGTH) } : {}),
		...(optionalString(raw.workerId, "readiness worker id", MAX_WORKER_ID_LENGTH) ? { workerId: optionalString(raw.workerId, "readiness worker id", MAX_WORKER_ID_LENGTH) } : {}),
		...(raw.target !== undefined ? { target: normalizeTarget(raw.target) } : {}),
		...(raw.model !== undefined ? { model: normalizeModel(raw.model) } : {}),
		...(raw.checks !== undefined ? { checks: normalizeReadinessChecks(raw.checks) } : {}),
	};
}

function normalizeTarget(value: unknown): BackgroundRunTarget {
	if (!value || typeof value !== "object") throw new Error("invalid background run target");
	const raw = value as Partial<BackgroundRunTarget>;
	if (raw.kind !== "resume-thread" && raw.kind !== "fresh-thread" && raw.kind !== "no-room-mutation" && raw.kind !== "none") throw new Error("invalid background run target kind");
	const target: BackgroundRunTarget = { kind: raw.kind };
	if (raw.roomId !== undefined) target.roomId = validateSafeId(raw.roomId, "target room id");
	if (raw.threadId !== undefined) target.threadId = validateSafeId(raw.threadId, "target thread id", THREAD_ID_PATTERN);
	if (raw.model !== undefined) target.model = normalizeModel(raw.model);
	if (raw.modelPolicyKey !== undefined) target.modelPolicyKey = requireNonEmptyString(raw.modelPolicyKey, "model policy key", 120);
	return target;
}

function normalizeArtifacts(value: unknown): BackgroundRunArtifacts {
	if (!value || typeof value !== "object") throw new Error("invalid background run artifacts");
	const raw = value as Partial<BackgroundRunArtifacts>;
	const artifacts: BackgroundRunArtifacts = {};
	const inputRelPath = optionalRelPath(raw.inputRelPath, "input artifact path");
	const outputRelPath = optionalRelPath(raw.outputRelPath, "output artifact path");
	const eventRelPath = optionalRelPath(raw.eventRelPath, "event artifact path");
	if (inputRelPath) artifacts.inputRelPath = inputRelPath;
	if (outputRelPath) artifacts.outputRelPath = outputRelPath;
	if (eventRelPath) artifacts.eventRelPath = eventRelPath;
	return artifacts;
}

function optionalRelPath(value: unknown, label: string): string | undefined {
	const relPath = optionalString(value, label, MAX_REL_PATH_LENGTH);
	if (!relPath) return undefined;
	if (path.isAbsolute(relPath) || relPath.split(/[\\/]+/).includes("..")) throw new Error(`invalid background run ${label}`);
	return relPath;
}

function normalizeWarnings(value: unknown): string[] {
	if (value === undefined || value === null) return [];
	if (!Array.isArray(value)) throw new Error("invalid background run warnings");
	return value.map((warning) => requireNonEmptyString(warning, "warning", MAX_MESSAGE_LENGTH));
}

function normalizeError(value: unknown): { code: string; message: string } {
	if (!value || typeof value !== "object") throw new Error("invalid background run error");
	const raw = value as { code?: unknown; message?: unknown };
	return {
		code: requireNonEmptyString(raw.code, "error code", 120),
		message: requireNonEmptyString(raw.message, "error message", MAX_MESSAGE_LENGTH),
	};
}

function normalizeRecord(value: unknown): BackgroundRunRecord {
	if (!value || typeof value !== "object") throw new Error("invalid background run record");
	const raw = value as Partial<BackgroundRunRecord>;
	if (raw.version !== STORE_VERSION) throw new Error("unsupported background run record version");
	return {
		version: STORE_VERSION,
		runId: validateBackgroundRunId(raw.runId),
		kind: validateKind(raw.kind),
		scope: normalizeScope(raw.scope),
		source: normalizeSource(raw.source),
		status: validateStatus(raw.status),
		...(optionalString(raw.reason, "reason", MAX_REASON_LENGTH) ? { reason: optionalString(raw.reason, "reason", MAX_REASON_LENGTH) } : {}),
		...(optionalString(raw.message, "message", MAX_MESSAGE_LENGTH) ? { message: optionalString(raw.message, "message", MAX_MESSAGE_LENGTH) } : {}),
		createdAt: requireIsoDateString(raw.createdAt, "createdAt"),
		updatedAt: requireIsoDateString(raw.updatedAt, "updatedAt"),
		...(optionalIsoDateString(raw.queuedAt, "queuedAt") ? { queuedAt: optionalIsoDateString(raw.queuedAt, "queuedAt") } : {}),
		...(optionalIsoDateString(raw.startedAt, "startedAt") ? { startedAt: optionalIsoDateString(raw.startedAt, "startedAt") } : {}),
		...(optionalIsoDateString(raw.finishedAt, "finishedAt") ? { finishedAt: optionalIsoDateString(raw.finishedAt, "finishedAt") } : {}),
		attempts: normalizeAttempts(raw.attempts),
		...(raw.revision !== undefined ? { revision: normalizeRevision(raw.revision) } : {}),
		...(raw.lease !== undefined ? { lease: normalizeLease(raw.lease) } : {}),
		...(raw.readiness !== undefined ? { readiness: normalizeReadiness(raw.readiness) } : {}),
		...(raw.target !== undefined ? { target: normalizeTarget(raw.target) } : {}),
		...(raw.artifacts !== undefined ? { artifacts: normalizeArtifacts(raw.artifacts) } : {}),
		warnings: normalizeWarnings(raw.warnings),
		...(raw.error !== undefined ? { error: normalizeError(raw.error) } : {}),
	};
}

function normalizeSource(value: unknown): BackgroundRunRecord["source"] {
	if (!value || typeof value !== "object") throw new Error("invalid background run source");
	const raw = value as BackgroundRunRecord["source"];
	const schedulerJobId = normalizeSchedulerJobId(raw.schedulerJobId);
	return {
		...(schedulerJobId ? { schedulerJobId } : {}),
		trigger: validateTrigger(raw.trigger),
		...(optionalIsoDateString(raw.dueAt, "dueAt") ? { dueAt: optionalIsoDateString(raw.dueAt, "dueAt") } : {}),
	};
}

function normalizeSchedulerJobId(value: unknown): string | undefined {
	return optionalString(value, "scheduler job id", 120);
}

function normalizeAttempts(value: unknown): number {
	const attempts = Number(value ?? 0);
	if (!Number.isSafeInteger(attempts) || attempts < 0) throw new Error("invalid background run attempts");
	return attempts;
}

function normalizeRevision(value: unknown): number {
	const revision = Number(value ?? 0);
	if (!Number.isSafeInteger(revision) || revision < 0) throw new Error("invalid background run revision");
	return revision;
}

function nextRevision(record: BackgroundRunRecord): number {
	return normalizeRevision(record.revision) + 1;
}

function normalizeLeaseMs(value: unknown): number {
	if (value === undefined || value === null) return DEFAULT_LEASE_MS;
	const leaseMs = Number(value);
	if (!Number.isSafeInteger(leaseMs) || leaseMs < MIN_LEASE_MS || leaseMs > MAX_LEASE_MS) throw new Error("invalid background run lease duration");
	return leaseMs;
}

function normalizeLeaseToken(value: unknown): string {
	return requireNonEmptyString(value, "lease token", MAX_LEASE_TOKEN_LENGTH);
}

function normalizeWorkerId(value: unknown): string {
	return requireNonEmptyString(value, "lease worker id", MAX_WORKER_ID_LENGTH);
}

function createRecord(input: CreateBackgroundRunInput): BackgroundRunRecord {
	const now = normalizeNow(input.now).toISOString();
	const status = validateStatus(input.status ?? "queued");
	const record: BackgroundRunRecord = {
		version: STORE_VERSION,
		runId: input.runId === undefined ? generateBackgroundRunId() : validateBackgroundRunId(input.runId),
		kind: validateKind(input.kind),
		scope: normalizeScope(input.scope),
		source: normalizeSource(input.source),
		status,
		...(optionalString(input.reason, "reason", MAX_REASON_LENGTH) ? { reason: optionalString(input.reason, "reason", MAX_REASON_LENGTH) } : {}),
		...(optionalString(input.message, "message", MAX_MESSAGE_LENGTH) ? { message: optionalString(input.message, "message", MAX_MESSAGE_LENGTH) } : {}),
		createdAt: now,
		updatedAt: now,
		...(status === "queued" ? { queuedAt: now } : {}),
		attempts: 0,
		revision: 1,
		...(input.target !== undefined ? { target: normalizeTarget(input.target) } : {}),
		...(input.artifacts !== undefined ? { artifacts: normalizeArtifacts(input.artifacts) } : {}),
		warnings: normalizeWarnings(input.warnings),
		...(input.error !== undefined ? { error: normalizeError(input.error) } : {}),
	};
	return normalizeRecord(record);
}

export function createBackgroundRun(input: CreateBackgroundRunInput): BackgroundRunRecord {
	const record = createRecord(input);
	const file = backgroundRunRecordPath(record.runId);
	if (fs.existsSync(file)) throw new Error(`background run already exists: ${record.runId}`);
	atomicWriteJson(file, record);
	return record;
}

export function readBackgroundRun(runIdRaw: unknown): BackgroundRunRecord {
	const runId = validateBackgroundRunId(runIdRaw);
	const value = readJsonFile(backgroundRunRecordPath(runId));
	if (value === null) throw new Error(`background run not found: ${runId}`);
	const record = normalizeRecord(value);
	if (record.runId !== runId) throw new Error("background run id mismatch");
	return record;
}

export function updateBackgroundRun(runIdRaw: unknown, patch: UpdateBackgroundRunInput): BackgroundRunRecord {
	const existing = readBackgroundRun(runIdRaw);
	const updatedAt = normalizeNow(patch.now).toISOString();
	const updated: BackgroundRunRecord = {
		...existing,
		...(patch.status !== undefined ? { status: validateStatus(patch.status) } : {}),
		...(patch.reason !== undefined ? { reason: optionalString(patch.reason, "reason", MAX_REASON_LENGTH) } : {}),
		...(patch.message !== undefined ? { message: optionalString(patch.message, "message", MAX_MESSAGE_LENGTH) } : {}),
		...(patch.startedAt !== undefined ? { startedAt: optionalIsoDateString(patch.startedAt, "startedAt") } : {}),
		...(patch.finishedAt !== undefined ? { finishedAt: optionalIsoDateString(patch.finishedAt, "finishedAt") } : {}),
		...(patch.attempts !== undefined ? { attempts: normalizeAttempts(patch.attempts) } : {}),
		revision: nextRevision(existing),
		...(patch.target !== undefined ? { target: patch.target === null ? undefined : normalizeTarget(patch.target) } : {}),
		...(patch.artifacts !== undefined ? { artifacts: patch.artifacts === null ? undefined : normalizeArtifacts(patch.artifacts) } : {}),
		...(patch.warnings !== undefined ? { warnings: normalizeWarnings(patch.warnings) } : {}),
		...(patch.error !== undefined ? { error: patch.error === null ? undefined : normalizeError(patch.error) } : {}),
		updatedAt,
	};
	const normalized = normalizeRecord(removeUndefinedOptionalFields(updated));
	atomicWriteJson(backgroundRunRecordPath(normalized.runId), normalized);
	return normalized;
}

export function updateBackgroundRunStatus(runId: unknown, status: BackgroundRunStatus, patch: Omit<UpdateBackgroundRunInput, "status"> = {}): BackgroundRunRecord {
	return updateBackgroundRun(runId, { ...patch, status });
}

export function claimBackgroundRunLease(input: ClaimBackgroundRunLeaseInput): BackgroundRunRecord | null {
	const runId = validateBackgroundRunId(input.runId);
	const workerId = normalizeWorkerId(input.workerId);
	const token = input.token === undefined ? generateBackgroundRunLeaseToken() : normalizeLeaseToken(input.token);
	const now = normalizeNow(input.now);
	const nowIso = now.toISOString();
	const leaseMs = normalizeLeaseMs(input.leaseMs);
	return withBackgroundRunMutationLock(runId, () => {
		const existing = readBackgroundRun(runId);
		if (existing.status !== "queued" && existing.status !== "deferred") return null;
		if (existing.lease && isBackgroundRunLeaseActive(existing.lease, now)) return null;
		const updated = normalizeRecord(removeUndefinedOptionalFields({
			...existing,
			status: "running",
			reason: "claimed_for_readiness",
			message: undefined,
			updatedAt: nowIso,
			startedAt: nowIso,
			finishedAt: undefined,
			attempts: existing.attempts + 1,
			revision: nextRevision(existing),
			lease: {
				workerId,
				token,
				claimedAt: nowIso,
				expiresAt: new Date(now.getTime() + leaseMs).toISOString(),
			},
		}));
		atomicWriteJson(backgroundRunRecordPath(runId), updated);
		return updated;
	});
}

export function extendBackgroundRunLease(input: ExtendBackgroundRunLeaseInput): BackgroundRunRecord {
	const runId = validateBackgroundRunId(input.runId);
	const token = normalizeLeaseToken(input.token);
	const now = normalizeNow(input.now);
	const nowIso = now.toISOString();
	const leaseMs = normalizeLeaseMs(input.leaseMs);
	return withBackgroundRunMutationLock(runId, () => {
		const existing = readBackgroundRun(runId);
		assertMatchingLeaseToken(existing, token);
		const updated = normalizeRecord(removeUndefinedOptionalFields({
			...existing,
			updatedAt: nowIso,
			revision: nextRevision(existing),
			lease: {
				...existing.lease!,
				heartbeatAt: nowIso,
				expiresAt: new Date(now.getTime() + leaseMs).toISOString(),
			},
		}));
		atomicWriteJson(backgroundRunRecordPath(runId), updated);
		return updated;
	});
}

export function updateClaimedBackgroundRunStatus(input: UpdateClaimedBackgroundRunStatusInput): BackgroundRunRecord {
	const runId = validateBackgroundRunId(input.runId);
	const token = normalizeLeaseToken(input.token);
	const nowIso = normalizeNow(input.now).toISOString();
	return withBackgroundRunMutationLock(runId, () => {
		const existing = readBackgroundRun(runId);
		assertMatchingLeaseToken(existing, token);
		const status = validateStatus(input.status);
		const clearLease = input.clearLease !== false;
		const updated = normalizeRecord(removeUndefinedOptionalFields({
			...existing,
			status,
			...(input.reason !== undefined ? { reason: optionalString(input.reason, "reason", MAX_REASON_LENGTH) } : {}),
			...(input.message !== undefined ? { message: optionalString(input.message, "message", MAX_MESSAGE_LENGTH) } : {}),
			...(input.startedAt !== undefined ? { startedAt: optionalIsoDateString(input.startedAt, "startedAt") } : {}),
			...(input.finishedAt !== undefined ? { finishedAt: optionalIsoDateString(input.finishedAt, "finishedAt") } : {}),
			...(input.target !== undefined ? { target: input.target === null ? undefined : normalizeTarget(input.target) } : {}),
			...(input.artifacts !== undefined ? { artifacts: input.artifacts === null ? undefined : normalizeArtifacts(input.artifacts) } : {}),
			...(input.warnings !== undefined ? { warnings: normalizeWarnings(input.warnings) } : {}),
			...(input.error !== undefined ? { error: input.error === null ? undefined : normalizeError(input.error) } : {}),
			...(input.readiness !== undefined ? { readiness: input.readiness === null ? undefined : normalizeReadiness(input.readiness) } : {}),
			...(status === "queued" ? { queuedAt: nowIso } : {}),
			...(isTerminalBackgroundRunStatus(status) && input.finishedAt === undefined ? { finishedAt: nowIso } : {}),
			updatedAt: nowIso,
			revision: nextRevision(existing),
			lease: clearLease ? undefined : existing.lease,
		}));
		atomicWriteJson(backgroundRunRecordPath(runId), updated);
		return updated;
	});
}

export function recoverExpiredBackgroundRunLeases(input: RecoverExpiredBackgroundRunLeasesInput = {}): BackgroundRunRecord[] {
	const now = normalizeNow(input.now);
	const nowIso = now.toISOString();
	const limit = normalizeListLimit(input.limit);
	const scope = input.scope ? normalizeScope(input.scope) : undefined;
	const candidates = readBackgroundRunDirectoryEntries()
		.filter((entry) => entry.isDirectory() && isValidBackgroundRunId(entry.name))
		.map((entry) => readBackgroundRun(entry.name))
		.filter((record) => record.status === "running")
		.filter((record) => !!record.lease && !isBackgroundRunLeaseActive(record.lease, now))
		.filter((record) => !input.kind || record.kind === input.kind)
		.filter((record) => !scope || scopesEqual(record.scope, scope))
		.sort((a, b) => (a.lease?.expiresAt ?? a.updatedAt).localeCompare(b.lease?.expiresAt ?? b.updatedAt))
		.slice(0, limit);
	const recovered: BackgroundRunRecord[] = [];
	for (const candidate of candidates) {
		// One unrecoverable run must not abort the whole pass — this runs at the top of every
		// scheduler tick, so a throw here would silently halt scheduled prompts in ALL rooms.
		let updated: BackgroundRunRecord | null = null;
		try {
			updated = recoverExpiredBackgroundRunLease(candidate.runId, now, nowIso);
		} catch (error) {
			console.warn(`Failed to recover expired background run lease: ${candidate.runId}`, error);
		}
		if (updated) recovered.push(updated);
	}
	return recovered;
}

function recoverExpiredBackgroundRunLease(runId: string, now: Date, nowIso: string): BackgroundRunRecord | null {
	return withBackgroundRunMutationLock(runId, () => {
		const existing = readBackgroundRun(runId);
		if (existing.status !== "running" || !existing.lease || isBackgroundRunLeaseActive(existing.lease, now)) return null;
		const message = "Background run lease expired before completion; it will be rechecked before execution.";
		const record = normalizeRecord(removeUndefinedOptionalFields({
			...existing,
			status: "deferred",
			reason: "lease_expired",
			message,
			updatedAt: nowIso,
			revision: nextRevision(existing),
			lease: undefined,
			readiness: {
				checkedAt: nowIso,
				result: "deferred",
				reason: "lease_expired",
				message,
			},
		}));
		atomicWriteJson(backgroundRunRecordPath(runId), record);
		return record;
	});
}

// Blocked runs are otherwise terminal: the claimable listing skips them and the due scan sees the
// occurrence as already handled, so a transient condition (provider offline, model missing) would
// silently kill the occurrence, fatal for one-shot schedules. Reasons here are the ones expected
// to clear without touching the schedule; missing/archived rooms and missing/disabled schedules
// need a human and stay terminal. A run that met the empty conversation Remember or Forget
// prepared comes back only as the newest run of its task, and only while that conversation is
// still the room's (see reviveTransientlyBlockedBackgroundRuns).
const PREPARED_CONVERSATION_BLOCK = "prepared_runtime_boundary";
const TRANSIENTLY_BLOCKED_REASONS = new Set([
	"provider_not_connected",
	"model_not_found",
	"model_policy_unavailable",
	"schedule_store_unreadable",
	"room_error",
	// The empty conversation Remember or Forget prepared: the run goes, late, once the person has started it.
	PREPARED_CONVERSATION_BLOCK,
]);
// Floor between revive attempts so a run that immediately re-blocks is not readiness-checked on
// every tick, only about once per backoff window.
const TRANSIENT_BLOCK_REVIVE_BACKOFF_MS = 60 * 1000;

export interface ReviveTransientlyBlockedBackgroundRunsInput extends RecoverExpiredBackgroundRunLeasesInput {
	/** Whether a run blocked on a prepared conversation met the one its room has now (null: cannot tell yet); without it such a run stays blocked. */
	metCurrentConversation?: (record: BackgroundRunRecord) => boolean | null;
}

/**
 * A run blocked on a prepared conversation that will not come back: a later run of its task took its place, or
 * that conversation ended, or (a run blocked before the update) no conversation was recorded to wait for.
 */
export const SUPERSEDED_BY_LATER_RUN = "superseded_by_later_run";
export const PREPARED_CONVERSATION_ENDED = "prepared_conversation_ended";
export const PREPARED_CONVERSATION_NOT_RECORDED = "prepared_conversation_not_recorded";

/** The task a run belongs to: one schedule job in one place. */
function runTaskKey(record: BackgroundRunRecord): string {
	return JSON.stringify([record.kind, record.scope, record.source.schedulerJobId ?? record.runId]);
}

function runDueAt(record: BackgroundRunRecord): string {
	return record.source.dueAt ? normalizeIsoDateString(record.source.dueAt, "dueAt") : record.createdAt;
}

export function reviveTransientlyBlockedBackgroundRuns(input: ReviveTransientlyBlockedBackgroundRunsInput = {}): BackgroundRunRecord[] {
	const now = normalizeNow(input.now);
	const nowIso = now.toISOString();
	const limit = normalizeListLimit(input.limit);
	const scope = input.scope ? normalizeScope(input.scope) : undefined;
	const records = readBackgroundRunDirectoryEntries()
		.filter((entry) => entry.isDirectory() && isValidBackgroundRunId(entry.name))
		.map((entry) => readBackgroundRun(entry.name));
	// A run that met the prepared conversation comes back once per task: the newest run of its task, while that
	// conversation is still the room's. Older occurrences, and runs that met an earlier conversation, stay blocked.
	const newestDue = new Map<string, string>();
	for (const record of records) {
		const key = runTaskKey(record);
		const due = runDueAt(record);
		if (!newestDue.has(key) || due > newestDue.get(key)!) newestDue.set(key, due);
	}
	/** For a prepared-conversation block: null when it comes back, the final reason when it never will, "" when that cannot be told yet. */
	const endsAs = (record: BackgroundRunRecord): string | null => {
		if (record.reason !== PREPARED_CONVERSATION_BLOCK) return null;
		if (runDueAt(record) !== newestDue.get(runTaskKey(record))) return SUPERSEDED_BY_LATER_RUN;
		const met = input.metCurrentConversation?.(record) ?? null;
		if (met === null) return "";
		return met ? null : record.target?.threadId ? PREPARED_CONVERSATION_ENDED : PREPARED_CONVERSATION_NOT_RECORDED;
	};
	const candidates = records
		.filter((record) => record.status === "blocked")
		.filter((record) => !!record.reason && TRANSIENTLY_BLOCKED_REASONS.has(record.reason))
		.filter((record) => now.getTime() - new Date(record.updatedAt).getTime() >= TRANSIENT_BLOCK_REVIVE_BACKOFF_MS)
		.filter((record) => !record.lease || !isBackgroundRunLeaseActive(record.lease, now))
		.filter((record) => !input.kind || record.kind === input.kind)
		.filter((record) => !scope || scopesEqual(record.scope, scope))
		.sort((a, b) => a.updatedAt.localeCompare(b.updatedAt))
		.slice(0, limit);
	const revived: BackgroundRunRecord[] = [];
	for (const candidate of candidates) {
		const ending = endsAs(candidate);
		// Cannot tell yet: left as it is for a later pass.
		if (ending === "") continue;
		let updated: BackgroundRunRecord | null = null;
		try {
			updated = withBackgroundRunMutationLock(candidate.runId, () => {
				const existing = readBackgroundRun(candidate.runId);
				if (existing.status !== "blocked" || !existing.reason || !TRANSIENTLY_BLOCKED_REASONS.has(existing.reason)) return null;
				if (existing.lease && isBackgroundRunLeaseActive(existing.lease, now)) return null;
				if (ending) {
					const ended = normalizeRecord(removeUndefinedOptionalFields({
						...existing,
						reason: ending,
						updatedAt: nowIso,
						revision: nextRevision(existing),
						lease: undefined,
						readiness: { checkedAt: nowIso, result: "blocked", reason: ending, message: existing.message ?? ending },
					}));
					atomicWriteJson(backgroundRunRecordPath(candidate.runId), ended);
					return null;
				}
				const message = "Background run was blocked by a transient condition; it will be rechecked before execution.";
				const record = normalizeRecord(removeUndefinedOptionalFields({
					...existing,
					status: "deferred",
					reason: "transient_block_revived",
					message,
					updatedAt: nowIso,
					revision: nextRevision(existing),
					lease: undefined,
					// The condition being rechecked: the pane keeps saying what the run waits for.
					readiness: {
						checkedAt: nowIso,
						result: "deferred",
						reason: existing.reason,
						message,
					},
				}));
				atomicWriteJson(backgroundRunRecordPath(candidate.runId), record);
				return record;
			});
		} catch (error) {
			console.warn(`Failed to revive transiently blocked background run: ${candidate.runId}`, error);
		}
		if (updated) revived.push(updated);
	}
	return revived;
}

export function listClaimableScheduledPromptBackgroundRuns(options: ListClaimableScheduledPromptBackgroundRunsOptions = {}): BackgroundRunRecord[] {
	const now = normalizeNow(options.now);
	const limit = normalizeListLimit(options.limit);
	const scope = options.scope ? normalizeScope(options.scope) : undefined;
	const schedulerJobId = normalizeSchedulerJobId(options.schedulerJobId);
	const records = readBackgroundRunDirectoryEntries()
		.filter((entry) => entry.isDirectory() && isValidBackgroundRunId(entry.name))
		.map((entry) => readBackgroundRun(entry.name))
		.filter((record) => record.kind === "scheduled-prompt")
		.filter((record) => record.status === "queued" || record.status === "deferred")
		.filter((record) => !record.lease || !isBackgroundRunLeaseActive(record.lease, now))
		.filter((record) => !scope || scopesEqual(record.scope, scope))
		.filter((record) => !schedulerJobId || record.source.schedulerJobId === schedulerJobId)
		.sort(compareClaimableScheduledPromptRunsOldestFirst);
	return records.slice(0, limit);
}

export function listBackgroundRuns(options: ListBackgroundRunsOptions = {}): BackgroundRunRecord[] {
	const entries = readBackgroundRunDirectoryEntries();
	const limit = normalizeListLimit(options.limit);
	const scope = options.scope ? normalizeScope(options.scope) : undefined;
	const schedulerJobId = normalizeSchedulerJobId(options.schedulerJobId);
	const records = entries
		.filter((entry) => entry.isDirectory() && isValidBackgroundRunId(entry.name))
		.map((entry) => readBackgroundRun(entry.name))
		.filter((record) => !options.kind || record.kind === options.kind)
		.filter((record) => !options.status || record.status === options.status)
		.filter((record) => !scope || scopesEqual(record.scope, scope))
		.filter((record) => !schedulerJobId || record.source.schedulerJobId === schedulerJobId)
		.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
	return records.slice(0, limit);
}

export function findBackgroundRunByScheduledOccurrence(input: FindBackgroundRunByScheduledOccurrenceInput): BackgroundRunRecord | null {
	const scope = normalizeScope({ kind: "persistent-room", roomId: input.roomId });
	const schedulerJobId = normalizeSchedulerJobId(input.schedulerJobId);
	if (!schedulerJobId) throw new Error("scheduler job id is required");
	const dueAt = normalizeIsoDateString(input.dueAt, "dueAt");
	for (const entry of readBackgroundRunDirectoryEntries()) {
		if (!entry.isDirectory() || !isValidBackgroundRunId(entry.name)) continue;
		const record = readBackgroundRun(entry.name);
		if (record.kind !== "scheduled-prompt") continue;
		if (!scopesEqual(record.scope, scope)) continue;
		if (record.source.schedulerJobId !== schedulerJobId) continue;
		if (!record.source.dueAt) continue;
		if (normalizeIsoDateString(record.source.dueAt, "dueAt") === dueAt) return record;
	}
	return null;
}

function withBackgroundRunMutationLock<T>(runIdRaw: unknown, action: () => T): T {
	const runId = validateBackgroundRunId(runIdRaw);
	const recordFile = backgroundRunRecordPath(runId);
	const runDir = path.dirname(recordFile);
	if (!fs.existsSync(recordFile)) throw new Error(`background run not found: ${runId}`);
	const lockDir = path.join(runDir, MUTATION_LOCK_DIRNAME);
	let acquired = false;
	try {
		acquireBackgroundRunMutationLock(lockDir, runId);
		acquired = true;
		return action();
	} finally {
		if (acquired) {
			try {
				fs.rmSync(lockDir, { recursive: true, force: true });
			} catch {
				// A stale mutation lock is safer than deleting an unexpected path; surface no cleanup noise here.
			}
		}
	}
}

function acquireBackgroundRunMutationLock(lockDir: string, runId: string): void {
	try {
		fs.mkdirSync(lockDir, { mode: 0o700 });
		return;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
	}
	let lockMtimeMs: number | null = null;
	try {
		lockMtimeMs = fs.statSync(lockDir).mtimeMs;
	} catch {
		// The holder released between the failed mkdir and the stat; fall through to the retry.
	}
	if (lockMtimeMs !== null && Date.now() - lockMtimeMs <= MUTATION_LOCK_STALE_MS) {
		throw new Error(`background run mutation lock is already held: ${runId}`);
	}
	if (lockMtimeMs !== null) {
		try {
			fs.rmSync(lockDir, { recursive: true, force: true });
		} catch {
			// A failed reclaim surfaces as EEXIST on the retry below.
		}
	}
	try {
		fs.mkdirSync(lockDir, { mode: 0o700 });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error(`background run mutation lock is already held: ${runId}`);
		throw error;
	}
}

function assertMatchingLeaseToken(record: BackgroundRunRecord, token: string): void {
	if (!record.lease || record.lease.token !== token) throw new Error("background run lease token mismatch");
}

function isBackgroundRunLeaseActive(lease: BackgroundRunLease, now: Date): boolean {
	return new Date(lease.expiresAt).getTime() > now.getTime();
}

function isTerminalBackgroundRunStatus(status: BackgroundRunStatus): boolean {
	return status === "succeeded" || status === "failed" || status === "cancelled";
}

function compareClaimableScheduledPromptRunsOldestFirst(a: BackgroundRunRecord, b: BackgroundRunRecord): number {
	const dueA = a.source.dueAt ? normalizeIsoDateString(a.source.dueAt, "dueAt") : a.createdAt;
	const dueB = b.source.dueAt ? normalizeIsoDateString(b.source.dueAt, "dueAt") : b.createdAt;
	const dueComparison = dueA.localeCompare(dueB);
	if (dueComparison !== 0) return dueComparison;
	return a.createdAt.localeCompare(b.createdAt);
}

function readBackgroundRunDirectoryEntries(): fs.Dirent[] {
	const runsDir = backgroundRunsDirectoryPath();
	try {
		return fs.readdirSync(runsDir, { withFileTypes: true });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw new Error(`failed to list background runs: ${(error as Error).message}`);
	}
}

function normalizeListLimit(value: unknown): number {
	if (value === undefined || value === null) return DEFAULT_LIST_LIMIT;
	const limit = Number(value);
	if (!Number.isSafeInteger(limit) || limit <= 0) throw new Error("invalid background run list limit");
	return Math.min(limit, MAX_LIST_LIMIT);
}

function scopesEqual(a: BackgroundRunScope, b: BackgroundRunScope): boolean {
	if (a.kind !== b.kind) return false;
	if (a.kind === "persistent-room" && b.kind === "persistent-room") return a.roomId === b.roomId;
	if (a.kind === "room-consult" && b.kind === "room-consult") return a.sourceRoomId === b.sourceRoomId && a.targetRoomId === b.targetRoomId;
	return a.kind === "global-memory" && b.kind === "global-memory";
}

function removeUndefinedOptionalFields(record: BackgroundRunRecord): BackgroundRunRecord {
	return JSON.parse(JSON.stringify(record)) as BackgroundRunRecord;
}
