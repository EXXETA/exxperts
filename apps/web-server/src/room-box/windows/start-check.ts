import { type ChildProcess, execFile, fork } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { SiteAnswer, SiteAsk, SiteAskHow } from "../box-process.js";
import type { CheckAnswer, ServerMessage, WorkerMessage } from "./box-worker-windows.js";
import { type BoxRoot, openBoxRoot, defaultBoxRoot, sweepGoneRooms } from "./box-root.js";
import { COMMAND_WRAPPER, encodedCommand, windowsPowerShell } from "./command-line.js";
import { commandRequest, localPath, type WindowsBoxRequest, type WindowsRoomRules } from "./box-request.js";
import { withInstalledPython } from "./installed-python.js";
import { FOLDERS_SCRIPT, readPersonalFolders } from "./personal-folders.js";
import { productAppStatePath } from "../../../../../pi-package/product-state-paths.js";
import { actedWindowsBoxState, START_WAIT_MS } from "../box-available.js";

/**
 * The Windows box's check at server start, by its rows in order. Off only where
 * Windows itself can't run the box: not Windows 11 x64 at the kit's build line,
 * or a Windows Server. Every other failure is broken: the person's folders
 * unreadable, the box's process not starting or crashing, the kit not the
 * pinned version and contract, the kit's platform answer without its process
 * container, or its probe of a real request not the base container with every
 * ability the request uses. The answer holds for the server's life.
 *
 * SDK 1.0.1 has no answer of its own for Microsoft's staged rollout (on Windows
 * `getPlatformSupport` is always supported). A PC the rollout hasn't reached may
 * answer the probe with another tier or missing abilities, so that answer reads
 * off on a PC that never passed the check, and broken on one that did.
 */
export type StartAnswer = { state: "on"; box: WindowsBox } | { state: "off"; reason: string } | { state: "broken"; reason: string };

/** What a ready PC gives the engine. */
export interface WindowsBox {
	root: BoxRoot;
	machine: Machine;
	worker: WorkerSpec;
	/** A path on this computer as a request names it: the same string on Windows. */
	requestPath: (place: string) => string;
}

/** What Windows says about itself, read before the kit loads. */
export interface WindowsSystem {
	platform: string;
	arch: string;
	/** `os.release()`: `10.0.<build>`. */
	release: string;
	/** `os.version()`: Windows' product name, which names a server edition. */
	product: string;
}

/** The PC's side of every request, read once at the check. */
export interface Machine {
	/** The build's revision; undefined when Windows didn't say. */
	revision: number | undefined;
	profile: string;
	personal: string[];
	environment: Record<string, string | undefined>;
	pathFolders: string[];
	programs: { folder: string; names: string[] };
}

/** The box's process: its file, and what Node runs it with. */
export interface WorkerSpec {
	file: string;
	execArgv: string[];
}

export const PINNED_SDK = { version: "1.0.1", contract: "1.0.0" } as const;
/** The probe's abilities a request needs: its denied and listable paths, and the loopback network the proxy will use. */
const NEEDED_ABILITIES = ["baseContainerSupportsDenyPaths", "baseContainerSupportsEnumeratePaths", "baseContainerSupportsIngressHostLoopbackAllow", "baseContainerSupportsIdentitylessLoopbackProxy"] as const;
const WINDOWS_11 = 22_000;
/** The kit's build line: 26100, or 26200 from revision 9278. */
const BUILD_LINE = 26_100;
const LATER_BUILD = { build: 26_200, revision: 9_278 } as const;

/** Why this PC is off, by Windows' own facts; null when it is at the line. */
export function windowsLineMiss(system: WindowsSystem, revision?: number): string | null {
	if (system.platform !== "win32") return "not Windows";
	if (system.arch !== "x64") return `not x64 but ${system.arch}`;
	const build = Number(/^10\.0\.(\d+)$/.exec(system.release)?.[1]);
	if (!Number.isInteger(build) || build < WINDOWS_11) return `not Windows 11 (release ${system.release})`;
	if (/\bserver\b/i.test(system.product)) return "a Windows Server";
	if (build < BUILD_LINE) return `Windows 11 build ${build}, below ${BUILD_LINE}`;
	if (build === LATER_BUILD.build && revision !== undefined && revision < LATER_BUILD.revision) return `Windows 11 build ${build}.${revision}, below ${build}.${LATER_BUILD.revision}`;
	return null;
}

/** Why the kit's answers hold no box. `lesser`: a well-formed probe that names another tier or missing abilities, as a PC Windows hasn't given the box to may answer. */
export type CheckRefusal = { reason: string; lesser: boolean };

/** Whether the kit's answers hold a box: null when they do, else why not. */
export function checkRefusal(answer: CheckAnswer): CheckRefusal | null {
	const broken = (reason: string): CheckRefusal => ({ reason, lesser: false });
	if (answer.version !== PINNED_SDK.version || answer.contract !== PINNED_SDK.contract) return broken(`the sandbox kit is ${answer.version} with contract ${answer.contract}, not ${PINNED_SDK.version} with ${PINNED_SDK.contract}`);
	if (!answer.platform.ok) return broken(`the kit's platform answer failed: ${answer.platform.error}`);
	const support = answer.platform.value;
	if (!support.isSupported) return broken(`the kit says this PC isn't supported: ${support.reason ?? "no reason given"}`);
	if (!support.availableMethods.includes("processcontainer")) return broken("the kit offers no process container here");
	if (!answer.probe) return broken("the kit's probe didn't run");
	if (!answer.probe.ok) return broken(`the kit's probe failed: ${answer.probe.error}`);
	const probed = answer.probe.value;
	if (probed.error) return broken(`the kit's probe failed: ${probed.error}`);
	if (probed.tier !== "base-container") return { reason: `the box here is ${probed.tier ?? "no tier"}, not the base container`, lesser: typeof probed.tier === "string" };
	if (probed.needsDaclAugmentation !== false) return broken("the request would need folder permissions changed");
	const missing = NEEDED_ABILITIES.filter((ability) => probed.probes?.[ability] !== true);
	return missing.length > 0 ? { reason: `the box here lacks ${missing.join(", ")}`, lesser: true } : null;
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

// ---- The box's process -------------------------------------------------------------------

const START_LIMIT_MS = 20_000;
// The kit's platform answer and probe start Windows' own programs, synchronously.
const CHECK_LIMIT_MS = 60_000;
const END_LIMIT_MS = 3_000;

// What the kit reads from the environment to find Windows' programs and its own state. Never a secret, a token or an MXC_ name.
const WORKER_NAMES = ["SystemRoot", "windir", "SystemDrive", "ComSpec", "PATH", "PATHEXT", "TEMP", "TMP", "USERPROFILE", "LOCALAPPDATA", "APPDATA", "ProgramData", "ProgramFiles", "ProgramFiles(x86)", "ProgramW6432", "CommonProgramFiles", "NUMBER_OF_PROCESSORS", "PROCESSOR_ARCHITECTURE", "OS", "USERNAME", "COMPUTERNAME"];

function workerEnvironment(): Record<string, string> {
	const wanted = new Set(WORKER_NAMES.map((name) => name.toLowerCase()));
	return Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => wanted.has(entry[0].toLowerCase()) && entry[1] !== undefined));
}

/** The box's process beside the server's bundle, where scripts/bundle-server.mjs puts it. */
export function defaultWorker(): WorkerSpec {
	return { file: path.join(path.dirname(fileURLToPath(import.meta.url)), "box-worker-windows.mjs"), execArgv: [] };
}

/** How a command ended, as the box's process reports it. */
export type CommandEnd = { exitCode: number; timedOut: boolean };

/** Where a turn's proxy sends its sites: the decision for each, and every refusal with its reason. */
export interface WorkerSites {
	ask: (site: SiteAsk, how?: SiteAskHow) => Promise<SiteAnswer>;
	refused: (site: SiteAsk, reason: string) => void;
}

const PROXY_LIMIT_MS = 10_000;

/** One forked box process: the check's, or one turn's. A crash ends every command it holds with an error, never a result. */
export class WindowsWorker {
	private nextReply = 1;
	private readonly replies = new Map<unknown, (reply: { ok: true; value: CheckAnswer } | { ok: false; error: string }) => void>();
	private readonly commands = new Map<string, { onData: (chunk: Buffer) => void; settle: (end: CommandEnd | Error) => void }>();
	private sites: WorkerSites | null = null;
	/** Each ask the proxy holds a connection for, by ask id: aborted when its client goes, or the process. */
	private readonly asking = new Map<number, AbortController>();
	private proxyTold: ((told: { port: number } | { error: string }) => void) | null = null;
	private exited = false;

	private constructor(private readonly child: ChildProcess) {
		child.on("message", (received: WorkerMessage) => {
			if (received?.type === "reply") {
				this.replies.get(received.id)?.(received);
				this.replies.delete(received.id);
			} else if (received?.type === "data") {
				this.commands.get(received.id)?.onData(Buffer.from(received.chunk));
			} else if (received?.type === "exit") {
				const command = this.commands.get(received.id);
				this.commands.delete(received.id);
				command?.settle("error" in received ? new Error(received.error) : { exitCode: received.exitCode, timedOut: received.timedOut });
			} else if (received?.type === "proxy") {
				this.proxyTold?.(received);
			} else if (received?.type === "ask") {
				const site = { host: String(received.host), port: Number(received.port) };
				const gone = new AbortController();
				this.asking.set(received.id, gone);
				// The proxy holds the connection until this answer; a failure of ours refuses.
				(this.sites ? this.sites.ask(site, { signal: gone.signal, certificateCheck: received.check === true }) : Promise.reject(new Error("no proxy was opened")))
					.catch((): SiteAnswer => ({ allow: false, reason: "the room could not check this site" }))
					.then((answer) => {
						this.asking.delete(received.id);
						this.send({ op: "answer", id: received.id, ...answer });
					});
			} else if (received?.type === "gone") {
				this.asking.get(received.id)?.abort();
			} else if (received?.type === "refused") {
				this.sites?.refused({ host: String(received.host), port: Number(received.port) }, String(received.reason));
			}
		});
		child.on("exit", () => {
			this.exited = true;
			for (const gone of this.asking.values()) gone.abort();
			this.asking.clear();
			for (const settle of this.replies.values()) settle({ ok: false, error: "the box's process ended" });
			this.replies.clear();
			for (const command of this.commands.values()) command.settle(new Error("the box's process ended"));
			this.commands.clear();
			this.proxyTold?.({ error: "the box's process ended" });
		});
	}

	get alive(): boolean {
		return !this.exited;
	}

	private send(out: ServerMessage): void {
		if (this.alive && this.child.connected) this.child.send(out);
	}

	/** Forks the process and waits for it to say it is up. Rejects when it ends first or takes too long. */
	static async start(spec: WorkerSpec): Promise<WindowsWorker> {
		const child = fork(spec.file, [], { execArgv: spec.execArgv, env: workerEnvironment(), serialization: "advanced", stdio: ["ignore", "ignore", "ignore", "ipc"] });
		const worker = new WindowsWorker(child);
		let timer: NodeJS.Timeout | undefined;
		try {
			await new Promise<void>((resolve, reject) => {
				child.once("error", reject);
				child.once("exit", (code) => reject(new Error(`the box's process ended at start, code ${code}`)));
				child.on("message", function booted(received: WorkerMessage) {
					if (received?.type !== "booted") return;
					child.off("message", booted);
					resolve();
				});
				timer = setTimeout(() => reject(new Error("the box's process did not start in time")), START_LIMIT_MS);
			});
			return worker;
		} catch (error) {
			child.kill("SIGKILL");
			throw error;
		} finally {
			clearTimeout(timer);
		}
	}

	/** The kit's answers, with its probe of `request`. */
	check(request?: WindowsBoxRequest): Promise<CheckAnswer> {
		if (!this.alive) return Promise.reject(new Error("the box's process has ended"));
		return new Promise((resolve, reject) => {
			const id = this.nextReply++;
			const timer = setTimeout(() => {
				this.replies.delete(id);
				reject(new Error("the box's process did not answer its check"));
			}, CHECK_LIMIT_MS);
			this.replies.set(id, (reply) => {
				clearTimeout(timer);
				if (reply.ok) resolve(reply.value);
				else reject(new Error(reply.error));
			});
			this.send({ op: "check", id, request });
		});
	}

	/** Runs one built request; its output reaches `onData` as it comes. Rejects when the kit couldn't start it or the process ended. */
	run(id: string, request: WindowsBoxRequest, onData: (chunk: Buffer) => void): Promise<CommandEnd> {
		if (!this.alive) return Promise.reject(new Error("the box's process has ended"));
		return new Promise((resolve, reject) => {
			this.commands.set(id, { onData, settle: (end) => (end instanceof Error ? reject(end) : resolve(end)) });
			this.send({ op: "run", id, request });
		});
	}

	kill(id: string): void {
		this.send({ op: "kill", id });
	}

	/** Opens the process's proxy on a fresh port, sending its sites to `sites`. Its port closes when the process ends. */
	openProxy(sites: WorkerSites): Promise<number> {
		if (!this.alive) return Promise.reject(new Error("the box's process has ended"));
		this.sites = sites;
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.proxyTold = null;
				reject(new Error("the box's process did not open its proxy"));
			}, PROXY_LIMIT_MS);
			this.proxyTold = (told) => {
				clearTimeout(timer);
				this.proxyTold = null;
				if ("port" in told) resolve(told.port);
				else reject(new Error(`the box's proxy did not open: ${told.error}`));
			};
			this.send({ op: "proxy" });
		});
	}

	/** Ends the process, and every command it still runs; killed if it won't go. */
	async end(): Promise<void> {
		if (!this.alive) return;
		const ended = new Promise<void>((resolve) => this.child.once("exit", () => resolve()));
		this.send({ op: "end" });
		await Promise.race([ended, new Promise<void>((resolve) => setTimeout(resolve, END_LIMIT_MS).unref())]);
		if (this.alive) this.child.kill("SIGKILL");
	}
}

// ---- The PC's side, read outside the box -----------------------------------------------------------

/** The folders asked of Windows, then the build's revision on a line of its own. */
const MACHINE_SCRIPT = `${FOLDERS_SCRIPT}
'revision=' + [string](Get-ItemProperty -LiteralPath 'HKLM:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion').UBR
`;

const MACHINE_LIMIT_MS = 20_000;

/** Reads the PC's side once: the person's folders and the build's revision, from Windows PowerShell outside the box, then PATH and the programs installed just for her. */
export async function readMachine(environment: NodeJS.ProcessEnv = process.env): Promise<Machine> {
	const systemRoot = localPath(environment.SystemRoot ?? "");
	if (systemRoot === undefined) throw new Error("no Windows folder to start PowerShell from");
	const told = await new Promise<string>((resolve, reject) => {
		execFile(windowsPowerShell(systemRoot), ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encodedCommand(MACHINE_SCRIPT)], { timeout: MACHINE_LIMIT_MS, windowsHide: true, encoding: "utf8" }, (error, stdout) => (error ? reject(error) : resolve(stdout)));
	});
	const lines = told.split(/\r?\n/).map((line) => line.trim());
	const folders = readPersonalFolders(lines.find((line) => line.startsWith("{")) ?? "", (place) => {
		try {
			const real = fs.realpathSync.native(place);
			return { real, folder: fs.statSync(real).isDirectory() };
		} catch {
			return undefined;
		}
	});
	if (!folders.ok) throw new Error(`the person's folders couldn't be read: ${folders.why}`);
	const revision = Number(lines.find((line) => line.startsWith("revision="))?.slice("revision=".length));
	const programsFolder = path.win32.join(environment.LOCALAPPDATA ?? path.win32.join(folders.folders.profile, "AppData", "Local"), "Programs");
	// The app's own install, when it sits there, has nothing for a command.
	const ownInstall = path.win32.dirname(process.execPath).toLowerCase();
	const programs = (() => {
		try {
			return fs.readdirSync(programsFolder, { withFileTypes: true }).filter((entry) => entry.isDirectory() && !ownInstall.startsWith(path.win32.join(programsFolder, entry.name).toLowerCase())).map((entry) => entry.name);
		} catch {
			return [];
		}
	})();
	return {
		revision: Number.isInteger(revision) && revision > 0 ? revision : undefined,
		profile: folders.folders.profile,
		personal: folders.folders.found.map((found) => found.path),
		environment: { ...environment },
		pathFolders: withInstalledPython((environment.PATH ?? environment.Path ?? "").split(";").filter(Boolean), environment),
		programs: { folder: programsFolder, names: programs },
	};
}

// ---- The check --------------------------------------------------------------------------------------

export interface StartCheckOptions {
	system: WindowsSystem;
	readMachine: () => Promise<Machine>;
	worker: WorkerSpec;
	/** The box root, by any spelling: it is resolved here once. */
	root: string;
	requestPath: (place: string) => string;
	/**
	 * Whether this PC has passed the check before, and the note that it has, made
	 * at its first on. Without it the PC counts as one that passed, so a lesser
	 * answer reads broken.
	 */
	passed?: { before: () => boolean; note: () => void };
}

/** The rules a request starts from: this PC's side, and the room's folders, its places and its skills' folders (`windowsSkillFolder`). */
export function machineRules(box: Pick<WindowsBox, "machine" | "requestPath">, room: WindowsRoomRules["room"], alsoAllowed: WindowsRoomRules["alsoAllowed"], places: WindowsRoomRules["places"], skillFolders: readonly string[] = []): WindowsRoomRules {
	const { machine, requestPath } = box;
	return {
		room: { ...room, folder: requestPath(room.folder) },
		alsoAllowed: alsoAllowed.map((entry) => ({ ...entry, path: requestPath(entry.path) })),
		skillFolders: skillFolders.map(requestPath),
		places: { temp: requestPath(places.temp), caches: requestPath(places.caches), ...(places.curlHome === undefined ? {} : { curlHome: requestPath(places.curlHome) }), ...(places.gitConfig === undefined ? {} : { gitConfig: requestPath(places.gitConfig) }) },
		profile: machine.profile,
		personal: machine.personal,
		denied: [],
		closedNames: { readOnly: [], denied: [] },
		environment: machine.environment,
		tools: [],
		pathFolders: machine.pathFolders,
		programs: machine.programs,
	};
}

/** Runs every row, once. Never throws: a row that fails decides the answer. */
export async function runStartCheck(options: StartCheckOptions): Promise<StartAnswer> {
	const miss = windowsLineMiss(options.system);
	if (miss) return { state: "off", reason: miss };
	let machine: Machine;
	try {
		machine = await options.readMachine();
	} catch (error) {
		return { state: "broken", reason: message(error) };
	}
	const revisionMiss = windowsLineMiss(options.system, machine.revision);
	if (revisionMiss) return { state: "off", reason: revisionMiss };
	let root: BoxRoot;
	try {
		root = openBoxRoot(options.root);
	} catch (error) {
		return { state: "broken", reason: `the box's folder couldn't be made: ${message(error)}` };
	}
	// Tidying only: a folder that won't go now goes at a later check.
	await sweepGoneRooms(root).catch(() => {});
	const box: WindowsBox = { root, machine, worker: options.worker, requestPath: options.requestPath };
	// A real request, of a room in the box's own folder: the probe reads its shape, and nothing is made.
	const probeRoom = path.join(root.path, "probe");
	const built = commandRequest(machineRules(box, { folder: probeRoom, canChangeFiles: true }, [], { temp: path.join(probeRoom, "temp"), caches: path.join(probeRoom, "caches"), curlHome: path.join(probeRoom, "curl") }), { wrapper: COMMAND_WRAPPER, text: "Write-Output ok", timeoutMs: 10_000 });
	if (!built.ok) return { state: "broken", reason: `the probe's request was refused: ${JSON.stringify(built.refused)}` };
	let worker: WindowsWorker | undefined;
	try {
		worker = await WindowsWorker.start(options.worker);
		const refusal = checkRefusal(await worker.check(built.request));
		if (!refusal) {
			try {
				options.passed?.note();
			} catch (error) {
				return { state: "broken", reason: `the note that this PC passed couldn't be written: ${message(error)}` };
			}
			return { state: "on", box };
		}
		return refusal.lesser && options.passed?.before() === false ? { state: "off", reason: refusal.reason } : { state: "broken", reason: refusal.reason };
	} catch (error) {
		return { state: "broken", reason: message(error) };
	} finally {
		await worker?.end();
	}
}

/** The note that this PC once passed the check, in the app's data folder, which no room's command can reach. */
function passedFile(): string {
	return productAppStatePath("windows-box-passed.json");
}

/** Whether the note is there. One that can't be read counts as there, so a lesser answer reads broken. */
export function passedBefore(file = passedFile()): boolean {
	try {
		fs.statSync(file);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code !== "ENOENT";
	}
}

/** Writes the note once, by a temporary file and a rename, so two servers or a cut leave one whole note. */
export function notePassed(file = passedFile(), now = new Date()): void {
	if (passedBefore(file)) return;
	fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
	const temporary = `${file}.${process.pid}.${Date.now()}`;
	try {
		fs.writeFileSync(temporary, JSON.stringify({ schemaVersion: 1, passedAt: now.toISOString() }) + "\n", { mode: 0o600, flag: "wx" });
		fs.renameSync(temporary, file);
	} finally {
		fs.rmSync(temporary, { force: true });
	}
}

let checked: Promise<StartAnswer> | null = null;

/** This server's answer: checked on first ask, then kept until the server stops. */
export function windowsBoxAnswer(): Promise<StartAnswer> {
	checked ??= runStartCheck({
		system: { platform: process.platform, arch: process.arch, release: os.release(), product: os.version() },
		readMachine: () => readMachine(),
		worker: defaultWorker(),
		root: defaultBoxRoot(),
		requestPath: (place) => place,
		passed: { before: () => passedBefore(), note: () => notePassed() },
	});
	return checked;
}


/** The check's answer, or broken when it gives none within `limitMs`. Never throws. */
export async function withinStartWait(check: () => Promise<StartAnswer>, limitMs = START_WAIT_MS): Promise<StartAnswer> {
	let timer: NodeJS.Timeout | undefined;
	const late = new Promise<StartAnswer>((resolve) => {
		timer = setTimeout(() => resolve({ state: "broken", reason: `the check gave no answer within ${Math.round(limitMs / 1000)} s` }), limitMs);
	});
	try {
		return await Promise.race([check().catch((error): StartAnswer => ({ state: "broken", reason: message(error) })), late]);
	} finally {
		clearTimeout(timer);
	}
}

let started: Promise<StartAnswer> | null = null;

/**
 * The answer this server goes by, from its start to its end: what the engine
 * runs with and what index.ts notes for the rooms. A server acting as Windows
 * (EXXPERTS_TEST_WINDOWS_BOX) has no box, so every command there is refused.
 */
export function windowsStartAnswer(): Promise<StartAnswer> {
	started ??= actedWindowsBoxState() !== null ? Promise.resolve({ state: "broken", reason: "acting as Windows, with no box" }) : withinStartWait(windowsBoxAnswer);
	return started;
}
