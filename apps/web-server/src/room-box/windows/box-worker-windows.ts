// The Windows box's own process. The server forks it, so a crash in
// Microsoft's sandbox kit (@microsoft/mxc-sdk) takes only this process.
// scripts/bundle-server.mjs builds it into box-worker-windows.mjs beside
// server.mjs, with the kit its only outside package. The server forks it with
// advanced serialization, so output travels as bytes.
//
// It runs what the server built and decides nothing: the start check
// (start-check.ts) reads its answers, and the engine (windows-engine.ts) builds
// every request. It turns PowerShell's own errors into plain text
// (error-text.ts) on each command's error stream, before that joins the
// output, so what a command prints never reads as part of an error. It never asks for the kit's telemetry, so `spawn` takes the
// request alone. A turn's process also holds the turn's proxy (box-proxy.ts),
// which asks the server about each site; it closes when the process ends.
import { finished } from "node:stream/promises";
import { StringDecoder } from "node:string_decoder";

import pkg from "@microsoft/mxc-sdk/package.json" with { type: "json" };
import { type ContainerRequest, getPlatformSupport, type MxcProcess, type PlatformSupport, probe, type ProbeOutput, SDK_CONTRACT_VERSION, spawn } from "@microsoft/mxc-sdk/v1";

import type { SiteAnswer, SiteAsk, SiteAskHow } from "../box-process.js";
import { type BoxProxy, openBoxProxy } from "./box-proxy.js";
import { ErrorTextTurner } from "./error-text.js";

/** One of the kit's answers, or why it gave none. */
export type Attempt<T> = { ok: true; value: T } | { ok: false; error: string };

export interface CheckAnswer {
	version: string;
	contract: string;
	platform: Attempt<PlatformSupport>;
	/** The kit's probe of the request the check was given; absent without one. */
	probe?: Attempt<ProbeOutput>;
}

/** What the worker sends: replies by request id, each command's output and end by command id, the proxy's port, and each site's ask by ask id, with `gone` once its client has gone. */
export type WorkerMessage =
	| { type: "booted" }
	| { type: "proxy"; port: number }
	| { type: "proxy"; error: string }
	| ({ type: "ask"; id: number; check?: true } & SiteAsk)
	| { type: "gone"; id: number }
	| ({ type: "refused"; reason: string } & SiteAsk)
	| { type: "reply"; id: unknown; ok: true; value: CheckAnswer }
	| { type: "reply"; id: unknown; ok: false; error: string }
	| { type: "data"; id: string; chunk: Uint8Array }
	| { type: "exit"; id: string; exitCode: number; timedOut: boolean }
	| { type: "exit"; id: string; error: string };

/** What the server sends. */
export type ServerMessage =
	| { op: "check"; id: unknown; request?: ContainerRequest }
	| { op: "run"; id: string; request: ContainerRequest }
	| { op: "kill"; id: string }
	| { op: "proxy" }
	| ({ op: "answer"; id: number } & SiteAnswer)
	| { op: "end" };

const DRAIN_LIMIT_MS = 5_000;
// Under the server's END_LIMIT_MS (start-check.ts), after which it kills this process.
const END_WAIT_MS = 2_000;

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

function attempt<T>(read: () => T): Attempt<T> {
	try {
		return { ok: true, value: read() };
	} catch (error) {
		return { ok: false, error: message(error) };
	}
}

function check(request: ContainerRequest | undefined): CheckAnswer {
	return {
		version: pkg.version,
		contract: SDK_CONTRACT_VERSION,
		platform: attempt(getPlatformSupport),
		...(request === undefined ? {} : { probe: attempt(() => probe(request)) }),
	};
}

/** Sends one message; a server that went away ends this process through `disconnect`. */
function tell(out: WorkerMessage): void {
	if (process.connected) process.send?.(out);
}

/** The commands running now, by command id. A kill that lands while one is starting is kept until it has started. */
const running = new Map<string, MxcProcess | "starting" | "killed">();
/** Each command's run, settled once its end has been told. */
const runs = new Set<Promise<void>>();
/** Set once the end has begun: a command asked for after it never starts. */
let ending = false;

/** Stops a command; the kit may refuse a command that ended just now, and its own end then reports it. */
function stopCommand(command: MxcProcess): void {
	try {
		command.kill();
	} catch {
		// wait() still reports how the command ended.
	}
}

function kill(id: string): void {
	const command = running.get(id);
	if (command === "starting") running.set(id, "killed");
	else if (command && command !== "killed") stopCommand(command);
}

async function run(id: string, request: ContainerRequest): Promise<void> {
	running.set(id, "starting");
	let command: MxcProcess;
	try {
		command = await spawn(request);
	} catch (error) {
		running.delete(id);
		tell({ type: "exit", id, error: message(error) });
		return;
	}
	const killedWhileStarting = running.get(id) === "killed";
	running.set(id, command);
	const send = (chunk: Uint8Array) => {
		if (chunk.length > 0) tell({ type: "data", id, chunk });
	};
	const decoder = new StringDecoder("utf8");
	const errors = new ErrorTextTurner();
	// What the error stream still holds, sent before the command's end.
	const sendHeld = () => send(Buffer.from(errors.push(decoder.end()) + errors.end(), "utf8"));
	// Taken before wait(), which would drain them.
	command.standardOutput?.on("data", send);
	command.standardError?.on("data", (chunk: Buffer) => send(Buffer.from(errors.push(decoder.write(chunk)), "utf8")));
	const streams = [command.standardOutput, command.standardError].filter((stream) => stream !== null);
	// The end can come before the last output has been read: the end waits for it, a while at most.
	const drained = Promise.all(streams.map((stream) => finished(stream).catch(() => {})));
	if (killedWhileStarting) stopCommand(command);
	try {
		const { exitCode, timedOut } = await command.wait();
		await Promise.race([drained, new Promise((resolve) => setTimeout(resolve, DRAIN_LIMIT_MS))]);
		sendHeld();
		tell({ type: "exit", id, exitCode, timedOut });
	} catch (error) {
		sendHeld();
		tell({ type: "exit", id, error: message(error) });
	} finally {
		running.delete(id);
		command.dispose();
	}
}

/** Site asks waiting for the server's answer, by ask id. */
const asks = new Map<number, (answer: SiteAnswer) => void>();
let nextAsk = 1;
let proxy: Promise<BoxProxy> | null = null;

/** One ask of the server. Its answer still comes after its client has gone: the server says then why it was refused. */
function askServer(site: SiteAsk, { signal, certificateCheck }: SiteAskHow): Promise<SiteAnswer> {
	return new Promise((resolve) => {
		const id = nextAsk++;
		asks.set(id, resolve);
		tell({ type: "ask", id, ...site, ...(certificateCheck ? { check: true } : {}) });
		signal?.addEventListener("abort", () => {
			if (asks.has(id)) tell({ type: "gone", id });
		}, { once: true });
	});
}

/** Opens the turn's proxy once, and tells its port. */
function openProxy(): void {
	proxy ??= openBoxProxy({ ask: askServer, refused: (site, reason) => tell({ type: "refused", ...site, reason }) });
	proxy.then(({ port }) => tell({ type: "proxy", port }), (error: unknown) => tell({ type: "proxy", error: message(error) }));
}

/**
 * Kills every command and waits, a while at most, for each to end and its end
 * to be told, so the server learns a command is over only once the box says so;
 * then ends. The proxy's port closes with the process.
 */
async function end(): Promise<void> {
	ending = true;
	for (const id of running.keys()) kill(id);
	await Promise.race([Promise.allSettled(runs), new Promise((resolve) => setTimeout(resolve, END_WAIT_MS))]);
	process.exit(0);
}

process.on("message", (received: ServerMessage) => {
	switch (received?.op) {
		case "check": {
			const answer = attempt(() => check(received.request));
			tell(answer.ok ? { type: "reply", id: received.id, ok: true, value: answer.value } : { type: "reply", id: received.id, ok: false, error: answer.error });
			return;
		}
		case "run": {
			if (ending) {
				tell({ type: "exit", id: received.id, error: "the box's process is ending" });
				return;
			}
			const ran = run(received.id, received.request);
			runs.add(ran);
			void ran.finally(() => runs.delete(ran));
			return;
		}
		case "kill":
			kill(received.id);
			return;
		case "proxy":
			openProxy();
			return;
		case "answer":
			asks.get(received.id)?.(received.allow ? { allow: true, ...(received.publicOnly === true ? { publicOnly: true } : {}) } : { allow: false, reason: String(received.reason) });
			asks.delete(received.id);
			return;
		case "end":
			void end();
			return;
		default:
			tell({ type: "reply", id: (received as { id?: unknown })?.id, ok: false, error: `unknown message ${JSON.stringify((received as { op?: unknown })?.op)}` });
	}
});

process.on("disconnect", () => void end());

tell({ type: "booted" });
