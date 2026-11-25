import {
	processScheduledPromptBackgroundRunExecutionOnce,
	type ScheduledPromptBackgroundExecutionSummary,
} from "./scheduled-prompt-background-execution.js";

const DEFAULT_EXECUTION_LOOP_ENABLED = true;
const DEFAULT_EXECUTION_LOOP_INTERVAL_MS = 15_000;
const MIN_EXECUTION_LOOP_INTERVAL_MS = 1_000;
const MAX_EXECUTION_LOOP_INTERVAL_MS = 86_400_000;
const DEFAULT_EXECUTION_LOOP_RUN_ON_START = false;
const DEFAULT_EXECUTION_LOOP_LIMIT_PER_TICK = 1;
const MAX_EXECUTION_LOOP_LIMIT_PER_TICK = 10;
const DEFAULT_EXECUTION_LEASE_MS = 5 * 60 * 1000;
const MIN_EXECUTION_LEASE_MS = 1_000;
const MAX_EXECUTION_LEASE_MS = 24 * 60 * 60 * 1000;
const DEFAULT_EXECUTION_HEARTBEAT_MS = 30_000;
const MIN_EXECUTION_HEARTBEAT_MS = 500;
const MAX_EXECUTION_HEARTBEAT_MS = 5 * 60 * 1000;

const ENV_ENABLED = "EXXPERTS_SCHEDULER_EXECUTION_LOOP_ENABLED";
const ENV_INTERVAL_MS = "EXXPERTS_SCHEDULER_EXECUTION_LOOP_INTERVAL_MS";
const ENV_RUN_ON_START = "EXXPERTS_SCHEDULER_EXECUTION_LOOP_RUN_ON_START";
const ENV_LIMIT_PER_TICK = "EXXPERTS_SCHEDULER_EXECUTION_LOOP_LIMIT_PER_TICK";
const ENV_LEASE_MS = "EXXPERTS_SCHEDULER_EXECUTION_LEASE_MS";
const ENV_HEARTBEAT_MS = "EXXPERTS_SCHEDULER_EXECUTION_HEARTBEAT_MS";

export interface ScheduledPromptBackgroundExecutionLoopLogger {
	info?: (value: unknown, message?: string) => void;
	warn?: (value: unknown, message?: string) => void;
	error?: (value: unknown, message?: string) => void;
	debug?: (value: unknown, message?: string) => void;
}

export interface ScheduledPromptBackgroundExecutionLoopOptions {
	enabled?: boolean;
	intervalMs?: number;
	runOnStart?: boolean;
	limitPerTick?: number;
	leaseMs?: number;
	heartbeatMs?: number;
	now?: () => Date;
	logger?: ScheduledPromptBackgroundExecutionLoopLogger;
}

export interface ScheduledPromptBackgroundExecutionLoopHandle {
	stop(): void;
	runOnce(): Promise<ScheduledPromptBackgroundExecutionSummary>;
	isRunning(): boolean;
}

interface ResolvedScheduledPromptBackgroundExecutionLoopOptions {
	enabled: boolean;
	intervalMs: number;
	runOnStart: boolean;
	limitPerTick: number;
	leaseMs: number;
	heartbeatMs: number;
	now?: () => Date;
	logger?: ScheduledPromptBackgroundExecutionLoopLogger;
}

function safeErrorMessage(error: unknown): string {
	const message = (error as Error)?.message ? String((error as Error).message) : String(error);
	return message.trim() || "unknown error";
}

function warn(logger: ScheduledPromptBackgroundExecutionLoopLogger | undefined, message: string, details: Record<string, unknown>): void {
	logger?.warn?.(details, message);
}

function parseBooleanEnv(
	raw: string | undefined,
	defaultValue: boolean,
	name: string,
	logger?: ScheduledPromptBackgroundExecutionLoopLogger,
): boolean {
	if (raw === undefined || raw.trim() === "") return defaultValue;
	const value = raw.trim().toLowerCase();
	if (["1", "true", "on", "yes"].includes(value)) return true;
	if (["0", "false", "off", "no"].includes(value)) return false;
	warn(logger, "Invalid scheduler execution loop boolean env value; using default", { name, value: raw, defaultValue });
	return defaultValue;
}

function parseIntegerEnv(
	raw: string | undefined,
	defaultValue: number,
	name: string,
	min: number,
	max: number,
	logger?: ScheduledPromptBackgroundExecutionLoopLogger,
): number {
	if (raw === undefined || raw.trim() === "") return defaultValue;
	const value = Number(raw.trim());
	if (!Number.isSafeInteger(value)) {
		warn(logger, "Invalid scheduler execution loop integer env value; using default", { name, value: raw, defaultValue, min, max });
		return defaultValue;
	}
	if (value < min) {
		warn(logger, "Scheduler execution loop env value below minimum; using minimum", { name, value, min, max });
		return min;
	}
	if (value > max) {
		warn(logger, "Scheduler execution loop env value above maximum; using maximum", { name, value, min, max });
		return max;
	}
	return value;
}

function normalizeLoopOptions(options: ScheduledPromptBackgroundExecutionLoopOptions = {}): ResolvedScheduledPromptBackgroundExecutionLoopOptions {
	const leaseMs = parseIntegerEnv(
		options.leaseMs === undefined ? undefined : String(options.leaseMs),
		DEFAULT_EXECUTION_LEASE_MS,
		"leaseMs",
		MIN_EXECUTION_LEASE_MS,
		MAX_EXECUTION_LEASE_MS,
		options.logger,
	);
	const heartbeatMs = parseIntegerEnv(
		options.heartbeatMs === undefined ? undefined : String(options.heartbeatMs),
		DEFAULT_EXECUTION_HEARTBEAT_MS,
		"heartbeatMs",
		MIN_EXECUTION_HEARTBEAT_MS,
		Math.min(MAX_EXECUTION_HEARTBEAT_MS, Math.max(MIN_EXECUTION_HEARTBEAT_MS, Math.floor(leaseMs / 2))),
		options.logger,
	);
	return {
		enabled: options.enabled ?? DEFAULT_EXECUTION_LOOP_ENABLED,
		intervalMs: parseIntegerEnv(
			options.intervalMs === undefined ? undefined : String(options.intervalMs),
			DEFAULT_EXECUTION_LOOP_INTERVAL_MS,
			"intervalMs",
			MIN_EXECUTION_LOOP_INTERVAL_MS,
			MAX_EXECUTION_LOOP_INTERVAL_MS,
			options.logger,
		),
		runOnStart: options.runOnStart ?? DEFAULT_EXECUTION_LOOP_RUN_ON_START,
		limitPerTick: parseIntegerEnv(
			options.limitPerTick === undefined ? undefined : String(options.limitPerTick),
			DEFAULT_EXECUTION_LOOP_LIMIT_PER_TICK,
			"limitPerTick",
			1,
			MAX_EXECUTION_LOOP_LIMIT_PER_TICK,
			options.logger,
		),
		leaseMs,
		heartbeatMs,
		now: options.now,
		logger: options.logger,
	};
}

export function resolveScheduledPromptBackgroundExecutionLoopOptionsFromEnv(
	env: NodeJS.ProcessEnv = process.env,
	logger?: ScheduledPromptBackgroundExecutionLoopLogger,
): ScheduledPromptBackgroundExecutionLoopOptions {
	const leaseMs = parseIntegerEnv(env[ENV_LEASE_MS], DEFAULT_EXECUTION_LEASE_MS, ENV_LEASE_MS, MIN_EXECUTION_LEASE_MS, MAX_EXECUTION_LEASE_MS, logger);
	return {
		enabled: parseBooleanEnv(env[ENV_ENABLED], DEFAULT_EXECUTION_LOOP_ENABLED, ENV_ENABLED, logger),
		intervalMs: parseIntegerEnv(env[ENV_INTERVAL_MS], DEFAULT_EXECUTION_LOOP_INTERVAL_MS, ENV_INTERVAL_MS, MIN_EXECUTION_LOOP_INTERVAL_MS, MAX_EXECUTION_LOOP_INTERVAL_MS, logger),
		runOnStart: parseBooleanEnv(env[ENV_RUN_ON_START], DEFAULT_EXECUTION_LOOP_RUN_ON_START, ENV_RUN_ON_START, logger),
		limitPerTick: parseIntegerEnv(env[ENV_LIMIT_PER_TICK], DEFAULT_EXECUTION_LOOP_LIMIT_PER_TICK, ENV_LIMIT_PER_TICK, 1, MAX_EXECUTION_LOOP_LIMIT_PER_TICK, logger),
		leaseMs,
		heartbeatMs: parseIntegerEnv(
			env[ENV_HEARTBEAT_MS],
			DEFAULT_EXECUTION_HEARTBEAT_MS,
			ENV_HEARTBEAT_MS,
			MIN_EXECUTION_HEARTBEAT_MS,
			Math.min(MAX_EXECUTION_HEARTBEAT_MS, Math.max(MIN_EXECUTION_HEARTBEAT_MS, Math.floor(leaseMs / 2))),
			logger,
		),
	};
}

function shouldLogSummary(summary: ScheduledPromptBackgroundExecutionSummary): boolean {
	return summary.counts.processed > 0 || summary.counts.recovered > 0 || summary.counts.skipped > 0 || summary.counts.failed > 0;
}

function logSummary(logger: ScheduledPromptBackgroundExecutionLoopLogger | undefined, summary: ScheduledPromptBackgroundExecutionSummary): void {
	if (!shouldLogSummary(summary)) return;
	logger?.info?.(
		{
			workerId: summary.workerId,
			counts: summary.counts,
			processed: summary.processed.map((run) => ({ runId: run.runId, finalStatus: run.finalStatus, reason: run.reason, threadId: run.threadId })),
			recovered: summary.recovered,
			skippedCount: summary.skipped.length,
		},
		"Scheduled prompt background execution tick completed",
	);
}

export function startScheduledPromptBackgroundExecutionLoop(
	options: ScheduledPromptBackgroundExecutionLoopOptions = {},
): ScheduledPromptBackgroundExecutionLoopHandle {
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

	const runWithGuard = async (): Promise<ScheduledPromptBackgroundExecutionSummary> => {
		if (running) throw new Error("scheduled prompt background execution tick already running");
		running = true;
		try {
			const summary = await processScheduledPromptBackgroundRunExecutionOnce({
				now: resolved.now?.(),
				limit: resolved.limitPerTick,
				leaseMs: resolved.leaseMs,
				heartbeatMs: resolved.heartbeatMs,
				logger: resolved.logger,
			});
			logSummary(resolved.logger, summary);
			return summary;
		} finally {
			running = false;
		}
	};

	const runTick = async (): Promise<void> => {
		if (stopped) return;
		try {
			await runWithGuard();
		} catch (error) {
			resolved.logger?.error?.({ error: safeErrorMessage(error) }, "Scheduled prompt background execution loop tick failed");
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
				limitPerTick: resolved.limitPerTick,
				leaseMs: resolved.leaseMs,
				heartbeatMs: resolved.heartbeatMs,
			},
			"Scheduled prompt background execution loop started",
		);
		scheduleNext(resolved.runOnStart ? 0 : resolved.intervalMs);
	}

	return {
		stop(): void {
			if (stopped) return;
			stopped = true;
			clearTimer();
			resolved.logger?.info?.({ intervalMs: resolved.intervalMs }, "Scheduled prompt background execution loop stopped");
		},
		async runOnce(): Promise<ScheduledPromptBackgroundExecutionSummary> {
			return runWithGuard();
		},
		isRunning(): boolean {
			return running;
		},
	};
}
