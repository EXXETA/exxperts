import fs from "node:fs";
import { createPersistentAgentInstance, isPersistentAgentArchived } from "./persistent-agent-store.js";
import { listPersistentAgentIds } from "./persistent-agent-status.js";
import { scanPersistentRoomScheduleDueRuns } from "./persistent-room-schedule-due-scan.js";
import type {
	PersistentRoomScheduleDueScanResult,
	PersistentRoomScheduleDueScanSummary,
} from "./persistent-room-schedule-due-scan.js";

const DEFAULT_PREFLIGHT_LOOP_ENABLED = true;
const DEFAULT_PREFLIGHT_LOOP_INTERVAL_MS = 60_000;
const MIN_PREFLIGHT_LOOP_INTERVAL_MS = 1_000;
const MAX_PREFLIGHT_LOOP_INTERVAL_MS = 86_400_000;
const DEFAULT_PREFLIGHT_LOOP_RUN_ON_START = false;
const DEFAULT_PREFLIGHT_LOOP_LIMIT_PER_ROOM = 25;
const MAX_PREFLIGHT_LOOP_LIMIT_PER_ROOM = 100;

const ENV_ENABLED = "EXXPERTS_SCHEDULER_PREFLIGHT_LOOP_ENABLED";
const ENV_INTERVAL_MS = "EXXPERTS_SCHEDULER_PREFLIGHT_LOOP_INTERVAL_MS";
const ENV_RUN_ON_START = "EXXPERTS_SCHEDULER_PREFLIGHT_LOOP_RUN_ON_START";
const ENV_LIMIT_PER_ROOM = "EXXPERTS_SCHEDULER_PREFLIGHT_LOOP_LIMIT_PER_ROOM";

export interface PersistentRoomSchedulePreflightLoopLogger {
	info?: (value: unknown, message?: string) => void;
	warn?: (value: unknown, message?: string) => void;
	error?: (value: unknown, message?: string) => void;
	debug?: (value: unknown, message?: string) => void;
}

export interface PersistentRoomSchedulePreflightLoopOptions {
	enabled?: boolean;
	intervalMs?: number;
	runOnStart?: boolean;
	limitPerRoom?: number;
	now?: () => Date;
	logger?: PersistentRoomSchedulePreflightLoopLogger;
}

export interface PersistentRoomSchedulePreflightLoopRunOnceOptions {
	limitPerRoom?: number;
	now?: () => Date;
	logger?: PersistentRoomSchedulePreflightLoopLogger;
	/** Asked between rooms: true ends the scan there, so a server stop makes no more runs. */
	shouldStop?: () => boolean;
}

export interface PersistentRoomSchedulePreflightLoopRoomResult {
	roomId: string;
	result?: PersistentRoomScheduleDueScanResult;
	error?: string;
}

export interface PersistentRoomSchedulePreflightLoopScanResult {
	startedAt: string;
	finishedAt: string;
	durationMs: number;
	roomCount: number;
	scannedRoomCount: number;
	skippedRoomCount: number;
	totals: PersistentRoomScheduleDueScanSummary;
	rooms: PersistentRoomSchedulePreflightLoopRoomResult[];
}

export interface PersistentRoomSchedulePreflightLoopHandle {
	stop(): void;
	runOnce(): Promise<PersistentRoomSchedulePreflightLoopScanResult>;
	isRunning(): boolean;
}

interface ResolvedPersistentRoomSchedulePreflightLoopOptions {
	enabled: boolean;
	intervalMs: number;
	runOnStart: boolean;
	limitPerRoom: number;
	now?: () => Date;
	logger?: PersistentRoomSchedulePreflightLoopLogger;
}

function emptyDueScanSummary(): PersistentRoomScheduleDueScanSummary {
	return {
		scanned: 0,
		enabled: 0,
		due: 0,
		created: 0,
		duplicates: 0,
		skipped: 0,
		notDue: 0,
		unsupported: 0,
		errors: 0,
		queued: 0,
		deferred: 0,
		blocked: 0,
	};
}

function addDueScanSummary(target: PersistentRoomScheduleDueScanSummary, source: PersistentRoomScheduleDueScanSummary): void {
	target.scanned += source.scanned;
	target.enabled += source.enabled;
	target.due += source.due;
	target.created += source.created;
	target.duplicates += source.duplicates;
	target.skipped += source.skipped;
	target.notDue += source.notDue;
	target.unsupported += source.unsupported;
	target.errors += source.errors;
	target.queued += source.queued;
	target.deferred += source.deferred;
	target.blocked += source.blocked;
}

function safeErrorMessage(error: unknown): string {
	const message = (error as Error)?.message ? String((error as Error).message) : String(error);
	return message.trim() || "unknown error";
}

function warn(logger: PersistentRoomSchedulePreflightLoopLogger | undefined, message: string, details: Record<string, unknown>): void {
	logger?.warn?.(details, message);
}

function parseBooleanEnv(
	raw: string | undefined,
	defaultValue: boolean,
	name: string,
	logger?: PersistentRoomSchedulePreflightLoopLogger,
): boolean {
	if (raw === undefined || raw.trim() === "") return defaultValue;
	const value = raw.trim().toLowerCase();
	if (["1", "true", "on", "yes"].includes(value)) return true;
	if (["0", "false", "off", "no"].includes(value)) return false;
	warn(logger, "Invalid scheduler preflight loop boolean env value; using default", { name, value: raw, defaultValue });
	return defaultValue;
}

function parseIntegerEnv(
	raw: string | undefined,
	defaultValue: number,
	name: string,
	min: number,
	max: number,
	logger?: PersistentRoomSchedulePreflightLoopLogger,
): number {
	if (raw === undefined || raw.trim() === "") return defaultValue;
	const value = Number(raw.trim());
	if (!Number.isSafeInteger(value)) {
		warn(logger, "Invalid scheduler preflight loop integer env value; using default", { name, value: raw, defaultValue, min, max });
		return defaultValue;
	}
	if (value < min) {
		warn(logger, "Scheduler preflight loop env value below minimum; using minimum", { name, value, min, max });
		return min;
	}
	if (value > max) {
		warn(logger, "Scheduler preflight loop env value above maximum; using maximum", { name, value, min, max });
		return max;
	}
	return value;
}

function normalizeLimitPerRoom(value: number | undefined, logger?: PersistentRoomSchedulePreflightLoopLogger): number {
	if (value === undefined) return DEFAULT_PREFLIGHT_LOOP_LIMIT_PER_ROOM;
	if (!Number.isSafeInteger(value)) {
		warn(logger, "Invalid scheduler preflight loop limit per room; using default", {
			value,
			defaultValue: DEFAULT_PREFLIGHT_LOOP_LIMIT_PER_ROOM,
		});
		return DEFAULT_PREFLIGHT_LOOP_LIMIT_PER_ROOM;
	}
	if (value < 1) return 1;
	if (value > MAX_PREFLIGHT_LOOP_LIMIT_PER_ROOM) return MAX_PREFLIGHT_LOOP_LIMIT_PER_ROOM;
	return value;
}

function normalizeLoopOptions(options: PersistentRoomSchedulePreflightLoopOptions = {}): ResolvedPersistentRoomSchedulePreflightLoopOptions {
	return {
		enabled: options.enabled ?? DEFAULT_PREFLIGHT_LOOP_ENABLED,
		intervalMs: parseIntegerEnv(
			options.intervalMs === undefined ? undefined : String(options.intervalMs),
			DEFAULT_PREFLIGHT_LOOP_INTERVAL_MS,
			"intervalMs",
			MIN_PREFLIGHT_LOOP_INTERVAL_MS,
			MAX_PREFLIGHT_LOOP_INTERVAL_MS,
			options.logger,
		),
		runOnStart: options.runOnStart ?? DEFAULT_PREFLIGHT_LOOP_RUN_ON_START,
		limitPerRoom: normalizeLimitPerRoom(options.limitPerRoom, options.logger),
		now: options.now,
		logger: options.logger,
	};
}

export function resolvePersistentRoomSchedulePreflightLoopOptionsFromEnv(
	env: NodeJS.ProcessEnv = process.env,
	logger?: PersistentRoomSchedulePreflightLoopLogger,
): PersistentRoomSchedulePreflightLoopOptions {
	return {
		enabled: parseBooleanEnv(env[ENV_ENABLED], DEFAULT_PREFLIGHT_LOOP_ENABLED, ENV_ENABLED, logger),
		intervalMs: parseIntegerEnv(
			env[ENV_INTERVAL_MS],
			DEFAULT_PREFLIGHT_LOOP_INTERVAL_MS,
			ENV_INTERVAL_MS,
			MIN_PREFLIGHT_LOOP_INTERVAL_MS,
			MAX_PREFLIGHT_LOOP_INTERVAL_MS,
			logger,
		),
		runOnStart: parseBooleanEnv(env[ENV_RUN_ON_START], DEFAULT_PREFLIGHT_LOOP_RUN_ON_START, ENV_RUN_ON_START, logger),
		limitPerRoom: parseIntegerEnv(
			env[ENV_LIMIT_PER_ROOM],
			DEFAULT_PREFLIGHT_LOOP_LIMIT_PER_ROOM,
			ENV_LIMIT_PER_ROOM,
			1,
			MAX_PREFLIGHT_LOOP_LIMIT_PER_ROOM,
			logger,
		),
	};
}

function shouldLogScanResult(result: PersistentRoomSchedulePreflightLoopScanResult): boolean {
	return result.totals.created > 0 || result.totals.duplicates > 0 || result.totals.errors > 0;
}

function logScanResult(logger: PersistentRoomSchedulePreflightLoopLogger | undefined, result: PersistentRoomSchedulePreflightLoopScanResult): void {
	if (!shouldLogScanResult(result)) return;
	logger?.info?.(
		{
			startedAt: result.startedAt,
			finishedAt: result.finishedAt,
			durationMs: result.durationMs,
			roomCount: result.roomCount,
			scannedRoomCount: result.scannedRoomCount,
			skippedRoomCount: result.skippedRoomCount,
			totals: result.totals,
		},
		"Persistent room schedule preflight scan completed",
	);
}

// Only what the scan needs: a full room status settles saves and budgets for
// every room, which held the server for seconds once rooms ran to thousands.
function roomScanState(roomId: string): "missing" | "archived" | "live" {
	const instance = createPersistentAgentInstance(roomId);
	if (!fs.existsSync(instance.rootDir)) return "missing";
	return isPersistentAgentArchived(instance.readAgentJson()) ? "archived" : "live";
}

export async function runPersistentRoomSchedulePreflightScanOnce(
	options: PersistentRoomSchedulePreflightLoopRunOnceOptions = {},
): Promise<PersistentRoomSchedulePreflightLoopScanResult> {
	const resolved = normalizeLoopOptions({ ...options, enabled: true, intervalMs: DEFAULT_PREFLIGHT_LOOP_INTERVAL_MS });
	const started = Date.now();
	const now = resolved.now?.() ?? new Date();
	const startedAt = now.toISOString();
	const totals = emptyDueScanSummary();
	const rooms: PersistentRoomSchedulePreflightLoopRoomResult[] = [];
	let scannedRoomCount = 0;
	let skippedRoomCount = 0;

	for (const roomId of listPersistentAgentIds()) {
		// One room per turn of the event loop, so pages, answers and sockets
		// are served while the scan runs.
		await new Promise<void>((resolve) => setImmediate(resolve));
		if (options.shouldStop?.()) break;
		const state = roomScanState(roomId);
		// Archived rooms are left out of the result altogether, as the room list leaves them out.
		if (state === "archived") continue;
		const roomEntry: PersistentRoomSchedulePreflightLoopRoomResult = { roomId };
		rooms.push(roomEntry);

		if (state === "missing") {
			skippedRoomCount += 1;
			continue;
		}

		scannedRoomCount += 1;
		try {
			const result = scanPersistentRoomScheduleDueRuns({ roomId, now, limit: resolved.limitPerRoom });
			roomEntry.result = result;
			addDueScanSummary(totals, result.summary);
		} catch (error) {
			const message = safeErrorMessage(error);
			roomEntry.error = message;
			totals.errors += 1;
			warn(resolved.logger, "Persistent room schedule preflight scan failed for room", { roomId, error: message });
		}
	}

	const finishedAt = new Date().toISOString();
	return {
		startedAt,
		finishedAt,
		durationMs: Math.max(0, Date.now() - started),
		roomCount: rooms.length,
		scannedRoomCount,
		skippedRoomCount,
		totals,
		rooms,
	};
}

export function startPersistentRoomSchedulePreflightLoop(
	options: PersistentRoomSchedulePreflightLoopOptions = {},
): PersistentRoomSchedulePreflightLoopHandle {
	const resolved = normalizeLoopOptions(options);
	let stopped = !resolved.enabled;
	let running = false;
	let timer: ReturnType<typeof setTimeout> | null = null;

	const clearTimer = (): void => {
		if (timer) {
			clearTimeout(timer);
			timer = null;
		}
	};

	const scheduleNext = (delayMs: number): void => {
		if (stopped) return;
		clearTimer();
		timer = setTimeout(() => {
			timer = null;
			void runTick();
		}, delayMs);
		timer.unref?.();
	};

	const runWithGuard = async (): Promise<PersistentRoomSchedulePreflightLoopScanResult> => {
		if (running) throw new Error("persistent room schedule preflight scan already running");
		running = true;
		try {
			const result = await runPersistentRoomSchedulePreflightScanOnce({
				limitPerRoom: resolved.limitPerRoom,
				now: resolved.now,
				logger: resolved.logger,
				// A disabled loop starts out stopped but has no timer to stop: its manual runs scan every room.
				shouldStop: () => resolved.enabled && stopped,
			});
			logScanResult(resolved.logger, result);
			return result;
		} finally {
			running = false;
		}
	};

	const runTick = async (): Promise<void> => {
		if (stopped) return;
		try {
			await runWithGuard();
		} catch (error) {
			resolved.logger?.error?.({ error: safeErrorMessage(error) }, "Persistent room schedule preflight loop tick failed");
		} finally {
			if (!stopped) scheduleNext(resolved.intervalMs);
		}
	};

	if (resolved.enabled) {
		resolved.logger?.info?.(
			{
				enabled: resolved.enabled,
				intervalMs: resolved.intervalMs,
				runOnStart: resolved.runOnStart,
				limitPerRoom: resolved.limitPerRoom,
			},
			"Persistent room schedule preflight loop started",
		);
		scheduleNext(resolved.runOnStart ? 0 : resolved.intervalMs);
	}

	return {
		stop(): void {
			if (stopped) return;
			stopped = true;
			clearTimer();
			resolved.logger?.info?.({ intervalMs: resolved.intervalMs }, "Persistent room schedule preflight loop stopped");
		},
		async runOnce(): Promise<PersistentRoomSchedulePreflightLoopScanResult> {
			return runWithGuard();
		},
		isRunning(): boolean {
			return running;
		},
	};
}
