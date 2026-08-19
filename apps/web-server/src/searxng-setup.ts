import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

/**
 * Starting a local search engine from the app, for people who never open a
 * terminal.
 *
 * The work itself already exists as a shipped helper script: it finds a
 * container engine, writes the engine's settings file, and runs the pinned
 * image. This module is the part that was missing, which is a way to ask for it
 * from a screen and watch it happen. It runs the helper as a child process and
 * turns its human output back into a phase the UI can draw.
 *
 * Two rules shape everything here. Pulling the image takes minutes on a first
 * run, so the request that starts it must return immediately and the phase is
 * polled afterwards; a blocked request would look like a hung app. And asking
 * twice must be harmless: a run already in flight is reported, never duplicated,
 * and the helper itself treats an existing container as something to reuse
 * rather than something to fail on.
 */

export type SearxngSetupPhase =
	| "idle"
	| "checking-docker"
	| "docker-missing"
	| "docker-stopped"
	| "pulling-image"
	| "starting"
	| "ready"
	| "stopped"
	| "error";

export type SearxngSetupStatus = {
	phase: SearxngSetupPhase;
	/** The address the engine answers on, once it does. */
	baseUrl: string | null;
	/** Why it stopped, in the phases that stopped. Plain words, no commands. */
	message: string | null;
	/** True while a child process is running, so the UI knows to keep polling. */
	running: boolean;
};

/** Where the helper lives in a source checkout and in every shipped form. */
export function searxngScriptPath(repoRoot: string): string {
	// An override keeps this testable without a container engine, and leaves a
	// seam for any packaging that moves the file.
	const override = process.env.EXXPERTS_SEARXNG_SCRIPT?.trim();
	return override ? path.resolve(override) : path.join(repoRoot, "scripts", "searxng.mjs");
}

const DEFAULT_BASE_URL = `http://127.0.0.1:${process.env.SEARXNG_PORT || "8888"}`;

type Run = {
	child: ChildProcess;
	phase: SearxngSetupPhase;
	baseUrl: string | null;
	message: string | null;
	/** Kept whole so a failure nobody anticipated still says something true. */
	output: string[];
};

let current: Run | null = null;
let last: SearxngSetupStatus = { phase: "idle", baseUrl: null, message: null, running: false };

function snapshot(run: Run): SearxngSetupStatus {
	return {
		phase: run.phase,
		baseUrl: run.baseUrl,
		message: run.message,
		running: run.child.exitCode === null && !run.child.killed,
	};
}

/** A quick real question to the engine: a status shown as running must be one
 * somebody just checked, not one remembered from a run that finished well. */
export async function probeSearxng(baseUrl: string, timeoutMs = 1500): Promise<boolean> {
	try {
		const res = await fetch(`${baseUrl}/search?q=exxperts&format=json`, { signal: AbortSignal.timeout(timeoutMs) });
		return res.ok;
	} catch {
		return false;
	}
}

/** Only addresses on this machine are ours to vouch for from here. */
function isLoopback(baseUrl: string): boolean {
	try {
		const host = new URL(baseUrl).hostname;
		return host === "127.0.0.1" || host === "localhost" || host === "::1" || host === "[::1]";
	} catch {
		return false;
	}
}

type ContainerRuntimeState = "missing" | "stopped" | "up" | "unknown";

/**
 * Whether a container runtime exists and answers, asked through the helper so
 * the not-installed versus not-running split lives in exactly one place: its
 * resolveDocker knows the off-PATH install locations a bare which misses.
 * Only consulted after the engine probe has already failed, which is the one
 * moment the answer changes what the screen should say; the happy path stays
 * a single HTTP probe.
 */
function containerRuntimeState(repoRoot: string): Promise<ContainerRuntimeState> {
	const script = searxngScriptPath(repoRoot);
	if (!fs.existsSync(script)) return Promise.resolve("unknown");
	return new Promise((resolve) => {
		const child = spawn(process.execPath, [script, "runtime"], { stdio: ["ignore", "pipe", "ignore"] });
		let out = "";
		const timer = setTimeout(() => {
			child.kill();
			resolve("unknown");
		}, 6000);
		child.stdout?.on("data", (data) => { out += String(data); });
		child.on("error", () => {
			clearTimeout(timer);
			resolve("unknown");
		});
		child.on("close", () => {
			clearTimeout(timer);
			const word = out.trim();
			resolve(word === "missing" || word === "stopped" || word === "up" ? word : "unknown");
		});
	});
}

/**
 * The status the screen draws. While a run is in flight its phases speak for
 * themselves. Once nothing is running, "ready" is only ever said after the
 * engine just answered an actual search: a run that finished well an hour ago
 * proves nothing about a machine where Docker has since been quit. So the
 * claimed address, or failing that the saved local one, is probed on every
 * read, and when the engine is silent the runtime is asked about too, so the
 * guidance can say what is actually missing instead of hedging.
 */
export async function searxngSetupStatus(repoRoot: string, configuredBaseUrl?: string | null): Promise<SearxngSetupStatus> {
	if (current) return snapshot(current);
	const claimed = last.phase === "ready" ? (last.baseUrl ?? DEFAULT_BASE_URL) : null;
	const candidate = claimed ?? (configuredBaseUrl && isLoopback(configuredBaseUrl) ? configuredBaseUrl : null);
	if (!candidate) return last;
	if (await probeSearxng(candidate)) {
		return { phase: "ready", baseUrl: candidate, message: null, running: false };
	}
	const runtime = await containerRuntimeState(repoRoot);
	if (runtime === "missing") {
		return {
			phase: "docker-missing",
			baseUrl: null,
			message: "This needs a container runtime. Install OrbStack (orbstack.dev) or Docker Desktop (docker.com), then press Start one on this computer.",
			running: false,
		};
	}
	if (runtime === "stopped") {
		return {
			phase: "docker-stopped",
			baseUrl: null,
			message: "Docker is installed but not running. Start Docker Desktop or OrbStack, then press Start one on this computer.",
			running: false,
		};
	}
	return {
		phase: "stopped",
		baseUrl: null,
		message: runtime === "up"
			? `The search engine at ${candidate} is not answering. Press Start one on this computer to bring it back.`
			: `The search engine at ${candidate} is not answering. If Docker Desktop or OrbStack is not running, start it. Then press Start one on this computer to bring the search engine back.`,
		running: false,
	};
}

/** The first address in a line, which is how the helper announces where it landed. */
function baseUrlFrom(line: string): string | null {
	return /(https?:\/\/[^\s]+)/.exec(line)?.[1]?.replace(/[.,]$/, "") ?? null;
}

/**
 * The helper speaks to a person, so this reads it the way a person would. Each
 * sentence it prints is one of a handful it can print, and each one means a
 * phase. Anything unrecognised leaves the phase alone rather than inventing one.
 */
function absorb(run: Run, chunk: string) {
	run.output.push(chunk);
	for (const line of chunk.split(/\r?\n/)) {
		const text = line.trim();
		if (!text) continue;
		if (/docker is not installed/i.test(text)) {
			run.phase = "docker-missing";
			run.message = "This needs Docker Desktop or OrbStack installed first.";
			continue;
		}
		if (/installed but not running/i.test(text)) {
			run.phase = "docker-stopped";
			run.message = "Docker is installed but not running. Start Docker Desktop or OrbStack, then try again.";
			continue;
		}
		// The engine prints these itself while it fetches the image, and this is
		// the slow part people are waiting through.
		if (/unable to find image|pulling from|downloading|extracting/i.test(text)) {
			if (run.phase === "checking-docker") run.phase = "pulling-image";
			continue;
		}
		if (/already running at|ready at/i.test(text)) {
			run.baseUrl = baseUrlFrom(text) ?? run.baseUrl ?? DEFAULT_BASE_URL;
			// Not ready until the child says so by exiting cleanly: the helper
			// still has its settings file to write after this line.
			if (run.phase !== "docker-missing" && run.phase !== "docker-stopped") run.phase = "starting";
			continue;
		}
		if (/did not become ready/i.test(text)) {
			run.phase = "error";
			run.message = "The search engine did not answer in time. Try again in a moment.";
			continue;
		}
	}
	if (run.phase === "checking-docker" && run.output.join("").length > 0) run.phase = "starting";
}

/**
 * Start the engine, or report the run already doing it. Never spawns a second
 * child, and never waits for the first one.
 */
export function startSearxngSetup(repoRoot: string): SearxngSetupStatus {
	if (current && current.child.exitCode === null && !current.child.killed) return snapshot(current);
	const script = searxngScriptPath(repoRoot);
	if (!fs.existsSync(script)) {
		last = {
			phase: "error",
			baseUrl: null,
			message: "This build cannot start a search engine for you. Enter the address of one you already run.",
			running: false,
		};
		current = null;
		return last;
	}
	// EXXPERTS_SETUP stays unset on purpose: it only changes which command name
	// the helper prints at people, and nothing here shows them a command.
	const env = { ...process.env };
	delete env.EXXPERTS_SETUP;
	const child = spawn(process.execPath, [script, "start"], {
		cwd: repoRoot,
		env,
		stdio: ["ignore", "pipe", "pipe"],
	});
	const run: Run = { child, phase: "checking-docker", baseUrl: null, message: null, output: [] };
	current = run;
	child.stdout?.on("data", (data) => absorb(run, String(data)));
	child.stderr?.on("data", (data) => absorb(run, String(data)));
	child.on("error", (e) => {
		run.phase = "error";
		run.message = (e as Error).message;
		last = snapshot(run);
	});
	child.on("close", (code) => {
		if (code === 0) {
			run.phase = "ready";
			run.baseUrl = run.baseUrl ?? DEFAULT_BASE_URL;
			run.message = null;
		} else if (run.phase !== "docker-missing" && run.phase !== "docker-stopped" && run.phase !== "error") {
			run.phase = "error";
			// The helper's own last words beat a generic failure line, but only
			// when it left any: an empty message is worse than a plain one.
			const tail = run.output.join("").trim().split(/\r?\n/).filter(Boolean).slice(-2).join(" ");
			run.message = tail || "The search engine could not be started.";
		}
		last = snapshot(run);
		current = null;
	});
	return snapshot(run);
}

/** Test seam: forget any finished run so a smoke can assert from a clean slate. */
export function resetSearxngSetupForTests() {
	current = null;
	last = { phase: "idle", baseUrl: null, message: null, running: false };
}
