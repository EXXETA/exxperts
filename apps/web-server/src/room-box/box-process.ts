import { type ChildProcess, fork } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BOX_FAULT_SENTENCE } from "./card-text.js";

/** Thrown instead of running a command: the box isn't proven, so nothing runs. */
export class BoxFault extends Error {
	constructor(readonly detail: string) {
		super(BOX_FAULT_SENTENCE);
	}
}

/** What the model reads when a command's folder is no longer the one the person chose: the file fence's line, for commands. */
export const COMMAND_FOLDER_MOVED = "This room's folder was moved or replaced, so commands can't run until the person chooses its folder again in Room settings, Folder.";

/** Thrown instead of running a command whose folder is no longer the room's chosen one, so nothing in what is there now is read or written. */
export class FolderMoved extends Error {
	constructor() {
		super(COMMAND_FOLDER_MOVED);
	}
}

// The box's two programs sit beside this file, in the tree and beside the bundle alike.
const PROGRAMS_FOLDER = fileURLToPath(new URL(".", import.meta.url));
/** The program a file tool's call runs in the box. */
export const FILE_WORKER = path.join(PROGRAMS_FOLDER, "file-worker.mjs");

const START_LIMIT_MS = 20_000;
const REQUEST_LIMIT_MS = 20_000;
const STOP_LIMIT_MS = 3_000;

export type SiteAsk = { host: string; port: number };
/**
 * How a connection asks on Windows: `signal` aborts when nobody waits for the
 * answer any more; `certificateCheck`, when it says it is Windows checking a
 * certificate, which never raises a question and is never a reason to allow.
 */
export type SiteAskHow = { signal?: AbortSignal; certificateCheck?: boolean };
/** `publicOnly`: the name may lead to public addresses alone, as in a room on Auto; Windows' proxy enforces it on the address it dials. */
export type SiteAnswer = { allow: true; publicOnly?: true } | { allow: false; reason: string };
/** A site the library refused at the dial, by the classes of address its name led to. */
export type DialRefusal = { host: string; port: number; classes: string[] };

type Reply = { ok: true; value: any } | { ok: false; error: string };

function killById(pid: number): void {
	try {
		process.kill(pid, "SIGKILL");
	} catch {
		// Already gone.
	}
}

/**
 * One turn's small process: the library's proxy on a fresh port with a fresh
 * token. A command never runs in here; the server spawns what `wrap` hands
 * back, so Stop and timeouts stay the runtime's own.
 */
export class BoxProcess {
	private nextRequest = 1;
	private readonly waiting = new Map<number, (reply: Reply) => void>();
	private exited = false;

	private constructor(private readonly child: ChildProcess, onAsk: (ask: SiteAsk) => Promise<SiteAnswer>, onDialRefused: (refusal: DialRefusal) => void) {
		child.on("message", (message: any) => {
			if (message?.type === "refused") {
				onDialRefused({ host: String(message.host), port: Number(message.port), classes: Array.isArray(message.classes) ? message.classes.map(String) : [] });
			} else if (message?.type === "reply") {
				this.waiting.get(message.id)?.(message.ok ? { ok: true, value: message.value } : { ok: false, error: String(message.error) });
				this.waiting.delete(message.id);
			} else if (message?.type === "ask") {
				// The library holds the command until this answer; a failure of ours refuses.
				onAsk({ host: String(message.host), port: Number(message.port) })
					.catch((): SiteAnswer => ({ allow: false, reason: "the room could not check this site" }))
					.then((answer) => this.send({ op: "answer", id: message.id, ...answer }));
			}
		});
		child.on("exit", () => {
			this.exited = true;
			for (const settle of this.waiting.values()) settle({ ok: false, error: "the box process ended" });
			this.waiting.clear();
		});
	}

	get alive(): boolean {
		return !this.exited;
	}

	private send(message: Record<string, unknown>): void {
		if (this.alive && this.child.connected) this.child.send(message);
	}

	/**
	 * Starts a box whose commands use `temp`, whose names may not lead to
	 * `deniedResolvedAddresses` beyond the library's own set. Rejects when it
	 * can't start; the caller treats that as a box that failed.
	 */
	static async start(temp: string, deniedResolvedAddresses: readonly string[], onAsk: (ask: SiteAsk) => Promise<SiteAnswer>, onDialRefused: (refusal: DialRefusal) => void): Promise<BoxProcess> {
		// A short environment of its own: this process holds no secret, and the library reads a few names from it.
		const env = { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", HOME: os.homedir(), TMPDIR: os.tmpdir() };
		const child = fork(path.join(PROGRAMS_FOLDER, "box-worker.mjs"), [], { env, execArgv: [], stdio: ["ignore", "ignore", "ignore", "ipc"] });
		const box = new BoxProcess(child, onAsk, onDialRefused);
		const booted = new Promise<void>((resolve, reject) => {
			child.once("error", reject);
			child.once("exit", (code) => reject(new Error(`the box process ended at start, code ${code}`)));
			const onBoot = (message: any) => {
				if (message?.type !== "booted") return;
				child.off("message", onBoot);
				resolve();
			};
			child.on("message", onBoot);
		});
		const limit = new Promise<never>((_resolve, reject) => {
			setTimeout(() => reject(new Error("the box process did not start in time")), START_LIMIT_MS).unref();
		});
		try {
			await Promise.race([booted, limit]);
			await box.request("start", { temp, deniedResolvedAddresses });
			return box;
		} catch (error) {
			killById(child.pid ?? 0);
			throw error;
		}
	}

	/** One request to the box. Rejects when the box has gone or doesn't answer in time. */
	request<T>(op: string, payload: Record<string, unknown>): Promise<T> {
		if (!this.alive) return Promise.reject(new Error("the box process has ended"));
		return new Promise<T>((resolve, reject) => {
			const id = this.nextRequest++;
			const timer = setTimeout(() => {
				this.waiting.delete(id);
				reject(new Error(`the box process did not answer ${op}`));
			}, REQUEST_LIMIT_MS);
			this.waiting.set(id, (reply) => {
				clearTimeout(timer);
				if (reply.ok) resolve(reply.value as T);
				else reject(new Error(reply.error));
			});
			this.send({ op, id, ...payload });
		});
	}

	/** Ends the proxy: every command this box started loses the network from here on. */
	async stop(): Promise<void> {
		if (!this.alive) return;
		const ended = new Promise<void>((resolve) => this.child.once("exit", () => resolve()));
		this.send({ op: "stop" });
		const limit = new Promise<void>((resolve) => setTimeout(resolve, STOP_LIMIT_MS).unref());
		await Promise.race([ended, limit]);
		if (this.alive) killById(this.child.pid ?? 0);
	}
}
