// The server's graceful stop: the one place that decides what happens between
// a stop signal (SIGTERM or SIGINT) and the process's exit.
//
// Three phases:
// 1. At once: stop taking work. The scheduler's loops stop; every tracked live
//    connection gets one { type: "server_stopping" } frame and its running
//    turn's open questions declined; from here /healthz answers 503, the door
//    (stopRefuses) refuses requests that start work, and the live connection
//    refuses new prompts, consults and specialist tasks.
// 2. Wait for running work (turns, scheduler ticks, specialist tasks,
//    consults) to end by itself, up to the wait: the seconds the edition gives
//    (index.ts passes the registry's slot), two seconds without it. Remember,
//    Memorize and Review are not waited for: each has its own restart story.
// 3. End what is left: each live connection's running turn, each tracked
//    work, every specialist task; give those a short time to land; close each
//    live connection with 1001 (going away); race the server's close against a
//    ceiling; then process.exit(0), so Node's exit listeners run.
// With nothing running, phase 2 takes no time and phase 3 only closes.
//
// The signal listeners are installed once, with process.on, and never
// removed: once a listener of ours exists, signal-exit (through
// proper-lockfile) stands down instead of killing the process by the signal.
// A second signal within one second of the first is part of the same stop (a
// terminal's Ctrl-C reaches a launched server as SIGINT and as the launcher's
// SIGTERM; a process-group SIGTERM arrives beside a wrapper's relayed one); a
// signal one second or more after the first ends the process at once, still
// through process.exit(0). SIGHUP is left alone.
//
// This module imports Node's own modules and fastify's types only.
import fs from "node:fs";
import type { FastifyInstance, FastifyReply } from "fastify";

export const SERVER_STOPPING_CODE = "server_stopping";
export const SERVER_STOPPED_REASON = "server_stopped";

export const SERVER_STOPPING_SENTENCE = "exxperts is stopping, so this cannot start now.";
export const STOP_CUT_ANSWER_SENTENCE = "exxperts stopped before this answer finished. Send your message again if something is missing.";
export const STOP_SCHEDULED_RUN_SENTENCE = "exxperts stopped before this scheduled task finished.";
export const STOP_QUESTIONS_SENTENCE =
	"exxperts is stopping, so questions cannot be answered now. Finish without them; leave undone anything that needs approval, and say so in your answer.";

/** Work the stop waits for and then ends. */
export type RunningWorkKind = "consult" | "scheduled turn";

/** An open live connection, as the stop sees it. */
export type TrackedLiveConnection = {
	/** Sends the connection its one stop frame and declines its running turn's open questions. */
	notify: () => void;
	/** Ends the connection's running turn, if one runs, marked as ended by the stop. */
	endTurn: () => void;
	/** Closes the connection with 1001. */
	close: () => void;
};

export type ServerStopOptions = {
	app: FastifyInstance;
	/** A shared server gets the longer end ceilings. */
	sharedServer: boolean;
	/** The wait in seconds, asked when a stop begins; without it, or when it gives nothing, two seconds. */
	waitSeconds?: () => number | undefined;
	/** Turns in flight across all rooms (live and scheduled). */
	turnsRunning: () => number;
	/** Specialist tasks running across all rooms. */
	specialistTasksRunning: () => number;
	/** Aborts every specialist task, never as stopped by the person. */
	abortSpecialistTasks: () => void;
	/** Whether a scheduler tick is running. */
	schedulerTickRunning: () => boolean;
	/** Stops the scheduler's loops (and the other timers that start work). */
	stopLoops: () => void;
};

const DEFAULT_WAIT_SECONDS = 2;
const SAME_STOP_WINDOW_MS = 1_000;
const POLL_MS = 50;
const ENDINGS_CEILING_MS = { desktop: 1_000, shared: 3_000 } as const;
const CLOSE_CEILING_MS = { desktop: 500, shared: 2_000 } as const;

const REFUSED_WHILE_STOPPING: ReadonlySet<string> = new Set([
	"GET /ws",
	"POST /api/persistent-agents/:id/checkpoint/propose",
	"POST /api/persistent-agents/:id/absorb/propose",
	"POST /api/persistent-agents/:id/absorb/runs/:runId/resume",
	"POST /api/persistent-agents/:id/review/runs",
	"POST /api/persistent-agents/:id/review/runs/:runId/resume",
	"POST /api/persistent-agents/:id/files",
]);

type TrackedWork = { kind: RunningWorkKind; end: () => void };

let stopping = false;
let waitEndsAt = 0;
let installed = false;
const liveConnections = new Set<TrackedLiveConnection>();
const runningWork = new Set<TrackedWork>();

/** True from the first stop signal on. */
export function serverStopping(): boolean {
	return stopping;
}

/**
 * True for the requests a stopping server refuses because they start work:
 * the live connection's upgrade, Remember's, Memorize's and Review's starts,
 * Memorize's and Review's resumes and the room's file upload. routeUrl is the
 * matched route's url (req.routeOptions.url); a HEAD request carries its GET
 * route's url, and /ws has no HEAD route.
 */
export function stopRefuses(method: string, routeUrl: string | undefined): boolean {
	if (routeUrl === undefined) return false;
	return REFUSED_WHILE_STOPPING.has(`${method} ${routeUrl}`);
}

/** The door's answer: 503, Retry-After the seconds the wait has left (at least 1), and the code. */
export function refuseWhileStopping(reply: FastifyReply): FastifyReply {
	const left = Math.max(1, Math.ceil((waitEndsAt - Date.now()) / 1000));
	return reply.code(503).header("retry-after", String(left)).send({ error: SERVER_STOPPING_SENTENCE, code: SERVER_STOPPING_CODE });
}

/**
 * True when the conversation's last message is an answer that ended by itself
 * (not cut, not failed, not waiting on a tool). A stop that comes while the
 * runtime's post-turn work still runs leaves such an answer finished: ending
 * it as the stop's would call a whole answer cut. Its compaction runs after
 * `prompt()` has returned, so it never holds the turn open, and the exit ends
 * it before it writes anything.
 */
export function answerAlreadyEnded(messages: readonly unknown[] | undefined): boolean {
	const last = messages?.at(-1) as { role?: unknown; stopReason?: unknown } | undefined;
	return last?.role === "assistant" && (last.stopReason === "stop" || last.stopReason === "length");
}

/** Registers work the stop waits for and then ends with `end`; returns its release. */
export function trackRunningWork(kind: RunningWorkKind, end: () => void): () => void {
	const work: TrackedWork = { kind, end };
	runningWork.add(work);
	return () => {
		runningWork.delete(work);
	};
}

/** Registers an open live connection; returns its release. One tracked while a stop runs is told at once. */
export function trackLiveConnection(connection: TrackedLiveConnection): () => void {
	liveConnections.add(connection);
	if (stopping) safely(connection.notify);
	return () => {
		liveConnections.delete(connection);
	};
}

function safely(fn: () => void): void {
	try {
		fn();
	} catch {
		// One connection or task that cannot be told or ended never holds up the others.
	}
}

const noop = (): void => {};

// One line on stderr, written synchronously; the stop never waits on the
// write: a closed pipe or terminal loses the line, never the stop.
function logLine(text: string): void {
	try {
		fs.writeSync(2, `${text}\n`);
	} catch {
		// The line is lost; the stop goes on.
	}
}

type RunningCounts = { turns: number; scheduledTurns: number; specialistTasks: number; consults: number; schedulerTick: boolean };

function plural(count: number, one: string, many: string): string {
	return `${count} ${count === 1 ? one : many}`;
}

function describe(counts: RunningCounts): string {
	return [
		plural(Math.max(0, counts.turns - counts.scheduledTurns), "live turn", "live turns"),
		plural(counts.scheduledTurns, "scheduled turn", "scheduled turns"),
		plural(counts.specialistTasks, "specialist task", "specialist tasks"),
		plural(counts.consults, "consult", "consults"),
		counts.schedulerTick ? "a scheduler tick" : "no scheduler tick",
	].join(", ");
}

function anythingRunning(counts: RunningCounts): boolean {
	return counts.turns > 0 || counts.scheduledTurns > 0 || counts.specialistTasks > 0 || counts.consults > 0 || counts.schedulerTick;
}

function waitMs(options: ServerStopOptions): number {
	let seconds: number | undefined;
	try {
		seconds = options.waitSeconds?.();
	} catch {
		seconds = undefined;
	}
	const usable = typeof seconds === "number" && Number.isFinite(seconds) && seconds >= 0 ? seconds : DEFAULT_WAIT_SECONDS;
	return usable * 1000;
}

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Installs the stop: the SIGTERM and SIGINT listeners, for the process's
 * life. Called once, by index.ts, once the server listens.
 */
export function installServerStop(options: ServerStopOptions): void {
	if (installed) throw new Error("the server stop is already installed");
	installed = true;
	let firstSignalAt = 0;
	const counts = (): RunningCounts => {
		const work = [...runningWork];
		return {
			turns: safeCount(options.turnsRunning),
			scheduledTurns: work.filter((entry) => entry.kind === "scheduled turn").length,
			specialistTasks: safeCount(options.specialistTasksRunning),
			consults: work.filter((entry) => entry.kind === "consult").length,
			schedulerTick: safeFlag(options.schedulerTickRunning),
		};
	};
	const onSignal = (signal: NodeJS.Signals): void => {
		const now = Date.now();
		if (firstSignalAt === 0) {
			firstSignalAt = now;
			void runStop(options, signal, counts).catch(() => {
				logLine("server stop: the stop failed; exiting");
				process.exit(0);
			});
			return;
		}
		if (now - firstSignalAt < SAME_STOP_WINDOW_MS) return;
		logLine(`server stop: a second ${signal}; exiting now`);
		process.exit(0);
	};
	process.on("SIGTERM", onSignal);
	process.on("SIGINT", onSignal);
}

function safeCount(fn: () => number): number {
	try {
		const value = fn();
		return Number.isFinite(value) && value > 0 ? value : 0;
	} catch {
		return 0;
	}
}

function safeFlag(fn: () => boolean): boolean {
	try {
		return fn() === true;
	} catch {
		return false;
	}
}

async function runStop(options: ServerStopOptions, signal: NodeJS.Signals, counts: () => RunningCounts): Promise<void> {
	// A closed pipe or terminal must not end the process mid-stop through an
	// unhandled stream error.
	process.stdout.on("error", noop);
	process.stderr.on("error", noop);
	const edition = options.sharedServer ? "shared" : "desktop";
	const wait = waitMs(options);

	// Phase 1: stop taking work.
	stopping = true;
	waitEndsAt = Date.now() + wait;
	const atStart = counts();
	logLine(`server stop: started by ${signal}; running: ${describe(atStart)}; waiting up to ${wait / 1000} s`);
	safely(options.stopLoops);
	for (const connection of [...liveConnections]) safely(connection.notify);

	// Phase 2: the wait.
	while (anythingRunning(counts()) && Date.now() < waitEndsAt) await delay(POLL_MS);

	// Phase 3: end what is left.
	const left = counts();
	if (anythingRunning(left)) {
		for (const connection of [...liveConnections]) safely(connection.endTurn);
		for (const work of [...runningWork]) safely(work.end);
		safely(options.abortSpecialistTasks);
		const endingsEndAt = Date.now() + ENDINGS_CEILING_MS[edition];
		while (anythingRunning(counts()) && Date.now() < endingsEndAt) await delay(POLL_MS);
	}
	// Each live connection's close handler lands what its client never saved,
	// so the server's close waits for those handlers, within the same ceiling.
	const closeEndsAt = Date.now() + CLOSE_CEILING_MS[edition];
	for (const connection of [...liveConnections]) safely(connection.close);
	while (liveConnections.size > 0 && Date.now() < closeEndsAt) await delay(POLL_MS);
	await closeServer(options.app, Math.max(0, closeEndsAt - Date.now()));
	logLine(anythingRunning(left) ? `server stop: ended ${describe(left)}; exiting` : "server stop: nothing left running; exiting");
	process.exit(0);
}

// The server's close, raced against its ceiling; a socket still open after it is terminated.
async function closeServer(app: FastifyInstance, ceilingMs: number): Promise<void> {
	let timer: NodeJS.Timeout | undefined;
	await Promise.race([
		Promise.resolve()
			.then(() => app.close())
			.catch(noop),
		new Promise<void>((resolve) => {
			timer = setTimeout(resolve, ceilingMs);
		}),
	]);
	if (timer) clearTimeout(timer);
	try {
		const sockets = (app as unknown as { websocketServer?: { clients?: Iterable<{ terminate: () => void }> } }).websocketServer?.clients;
		for (const socket of sockets ?? []) safely(() => socket.terminate());
	} catch {
		// Nothing more to end.
	}
	try {
		app.server.closeAllConnections();
	} catch {
		// Nothing more to end.
	}
	// A terminated socket's close handler runs on a later tick.
	await delay(POLL_MS);
}
