import { randomBytes } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";

import type { BashOperations } from "@exxeta/exxperts-runtime";

import { persistentAgentRootPath, resolvePersistentRoomCapabilityPolicy } from "../../persistent-room-workspace-policy.js";
import { ROOM_FOLDER_REFUSED, roomFence } from "../../room-files.js";
import { type AlsoAllowedFolder, readAlsoAllowed, saveAlsoAllowedFolders } from "../also-allowed.js";
import { BoxFault, FolderMoved, type SiteAnswer, type SiteAsk } from "../box-process.js";
import { boxRefusedLine } from "../card-text.js";
import { appDataPlaces } from "../box-closed.js";
import { soundFolders, unsoundForEveryone } from "../folder-offer.js";
import type { AnswerFolders } from "../folder-question.js";
import { gitIdentity, makeTurnPlaces, removePlace, sweepOldTemps, type TurnPlaces } from "./box-root.js";
import { COMMAND_WRAPPER } from "./command-line.js";
import { folderWait } from "./folder-wait.js";
import { atOrInside, commandRequest, localPath, type RequestResult, type WindowsBoxRequest, type WindowsRoomRules } from "./box-request.js";
import { type CommandEnd, machineRules, type StartAnswer, type WindowsBox, windowsStartAnswer, WindowsWorker, type WorkerSites } from "./start-check.js";

/**
 * The Windows box for one room's commands: the engine a turn uses, as RoomBox
 * (../box-session.ts) is the Mac's. Each turn forks its own box process on its
 * first command; the turn's end ends it, and every command with it. A command
 * runs in Windows PowerShell 5.1 under a request built at that command from the
 * room's folder, its Also allowed list and the running answer's own folders.
 * Its one way out is the turn's proxy in the box's process (box-proxy.ts),
 * which asks `sites` about each site.
 */

/** The room's folders at one command: its own by its real path, and the others it may use now. */
export interface RoomFolders {
	folder: string;
	alsoAllowed: AlsoAllowedFolder[];
}

export interface WindowsRoomBoxOptions {
	roomId: string;
	conversationId: () => string;
	/** What the room allows right now, its skills' folders included (`roomSkillFolders`); read at each command. */
	rights: () => { canChangeFiles: boolean; skillFolders: readonly string[] };
	/** The running answer's own folders, read at each command beside the room's list. */
	answer?: () => AnswerFolders;
	warn: (detail: Record<string, unknown>, message: string) => void;
	/** Where the room's folders come from at each command; the room's stored folder through the fence by default. */
	folders?: () => RoomFolders;
	/** The room's data folder, which names its folder in the box root; the room's own by default. */
	roomData?: string;
	/** The start check's answer; the one this server goes by (windowsStartAnswer) by default. */
	startAnswer?: () => Promise<StartAnswer>;
	/**
	 * The room's site decision (site-decision.ts), and every refusal of the proxy's with its reason. Without it every site is refused.
	 * `startCommand`: called as a command starts, it gives that command's end, with the lines to follow it; `endTurn`: called at the turn's end.
	 */
	sites?: WorkerSites & { startCommand?: () => (failed: boolean) => string[]; endTurn?: () => void };
	/** Whether the room's folder ask is offered with someone there to answer it, read after each command that may have been refused. Not offered by default. */
	asks?: () => boolean;
}

/** A room's folder no room may use: the command never runs, as for a folder that moved. */
class FolderRefused extends FolderMoved {
	constructor() {
		super();
		this.message = ROOM_FOLDER_REFUSED;
	}
}

/**
 * The room's folders as the Mac's box reads them (`chosenFolder` and
 * `commandRules` in ../box-session.ts): its folder through the file fence, so
 * one moved, replaced or refused by the folder judge runs nothing, and its
 * list judged against it. An entry no conversation can use leaves the list.
 */
export function storedRoomFolders(roomId: string, conversationId: string, answer?: AnswerFolders): RoomFolders {
	const { policy } = resolvePersistentRoomCapabilityPolicy(roomId, conversationId);
	const fence = policy ? roomFence(policy, () => []) : null;
	if (fence?.refused) throw new FolderRefused();
	if (!fence?.room) throw new FolderMoved();
	const listed = readAlsoAllowed(roomId).folders;
	const unsound = unsoundForEveryone(listed);
	const kept = unsound.length > 0 ? listed.filter((entry) => !unsound.includes(entry)) : listed;
	if (unsound.length > 0) saveAlsoAllowedFolders(roomId, kept);
	return { folder: fence.room.path, alsoAllowed: soundFolders(answer?.over(kept) ?? kept, fence.room.path) };
}

/**
 * The folder a conversation's commands run in, as `storedRoomFolders` gets it:
 * through the fence, by its real path. One the fence can't open is its stored
 * text, so a share still reads as one; null where the room has no folder. A
 * room's protection judges this one (persistent-room-protection.ts).
 */
export function conversationFolder(roomId: string, conversationId: string): string | null {
	const { policy } = resolvePersistentRoomCapabilityPolicy(roomId, conversationId);
	if (!policy) return null;
	return roomFence(policy, () => []).room?.path ?? policy.roots[0]?.path ?? null;
}

/** Whether a folder's tree holds a link or a junction, or can't be read through. */
function holdsLink(folder: string): boolean {
	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(folder, { withFileTypes: true });
	} catch {
		return true;
	}
	return entries.some((entry) => entry.isSymbolicLink() || (entry.isDirectory() && holdsLink(path.join(folder, entry.name))));
}

/**
 * A skill's folder as the protection may be given it, read and run, by
 * its real path: only a plain folder, never a link, that is a full local path as
 * the box names it, and whose tree holds no link or junction, since what a link
 * inside a read-only place lets a command read is unknown on Windows. Undefined
 * for any other: its files are then read, never run.
 */
export function windowsSkillFolder(skillDir: string, requestPath: (place: string) => string = (place) => place): string | undefined {
	try {
		if (!fs.lstatSync(skillDir).isDirectory()) return undefined;
		const real = fs.realpathSync.native(skillDir);
		return localPath(requestPath(real)) === undefined || holdsLink(real) ? undefined : real;
	} catch {
		return undefined;
	}
}

type Run = { box: WindowsBox; worker: WindowsWorker; places: TurnPlaces; proxyPort: number };

const NO_SITES: SiteAnswer = { allow: false, reason: "no site can be reached from this room's commands" };

/** The bash tool's own limit when the model gives none. */
const DEFAULT_TIMEOUT_SECONDS = 600;
const PROOF_LIMIT_MS = 60_000;

// What Windows prints for a refused place, and for many an ordinary failure too: its own words, .NET's, which name the path between theirs,
// a script runtime's (Python's and git's "Permission denied", Node's "operation not permitted"), in any case, and the names in PowerShell's
// error record, which stay English where the message is translated: its category and the exception's .NET type.
const ACCESS_DENIED = /Access is denied|Access to the path .* is denied|Permission denied|operation not permitted|PermissionDenied|UnauthorizedAccessException/i;
// How much of a line without its end is kept to read with the next chunk: room for a long path.
const LINE_KEPT = 4_096;

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** A PowerShell string that holds `value` as it is. PowerShell takes the typographic single quotes as quotes too. */
export const powerShellString = (value: string): string => `'${value.replace(/['‘’‚‛]/g, "$&$&")}'`;

/** What `work` gives, or `aborted` as soon as Stop comes: a start cut short this way goes on for the turn's next command. */
function untilStopped<T>(work: Promise<T>, signal?: AbortSignal): Promise<T> {
	if (!signal) return work;
	work.catch(() => {});
	return new Promise((resolve, reject) => {
		const stop = () => reject(new Error("aborted"));
		if (signal.aborted) return stop();
		signal.addEventListener("abort", stop, { once: true });
		work.then(resolve, reject).finally(() => signal.removeEventListener("abort", stop));
	});
}

/** Runs one built request to its end. Stop kills it and rejects with `aborted`; the time limit rejects with `timeout:<seconds>`. */
async function runRequest(run: Run, request: WindowsBoxRequest, onData: (chunk: Buffer) => void, signal?: AbortSignal): Promise<{ exitCode: number }> {
	if (signal?.aborted) throw new Error("aborted");
	const id = randomBytes(16).toString("hex");
	const stop = () => run.worker.kill(id);
	signal?.addEventListener("abort", stop, { once: true });
	let end: CommandEnd;
	try {
		end = await run.worker.run(id, request, onData);
	} catch (error) {
		if (signal?.aborted) throw new Error("aborted");
		// The kit couldn't start it, or the box's process went: the box failed partway.
		throw new BoxFault(message(error));
	} finally {
		signal?.removeEventListener("abort", stop);
	}
	if (signal?.aborted) throw new Error("aborted");
	if (end.timedOut) throw new Error(`timeout:${Math.round(request.timeoutMs / 1000)}`);
	return { exitCode: end.exitCode };
}

// What the proof plants outside the room, so a read that got through shows.
const PROOF_MARK = "EXXPERTS-PROOF-OUTSIDE";

// Windows' own curl.exe, which reads the proxy from the environment as a command's programs do.
const CURL = `"$env:SystemRoot\\System32\\curl.exe"`;

/** A listener on 127.0.0.1 that notes whether anything reached it. */
async function proofListener(): Promise<{ port: number; reached: () => boolean; close: () => void }> {
	const listener = net.createServer();
	let reached = false;
	listener.on("connection", (socket) => {
		reached = true;
		socket.destroy();
	});
	await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve));
	return { port: (listener.address() as net.AddressInfo).port, reached: () => reached, close: () => listener.close() };
}

// A box update or a Windows change can leave the box starting and not holding.
// Checked once per server start, as the Mac's proof (../box-probe.ts): what
// these rows prove changes only with a new release or a Windows update.
let proved = false;

/**
 * Proves the box holds, with real commands in a real box: a write and a delete
 * in the room work; a read and a write of a folder outside it are refused; a
 * local site asked for through the proxy is refused there, and a direct
 * connection that skips the proxy is refused by the box. Judged by what is on
 * disk, what reached each listener and what the proxy refused, never by an
 * exit code. `proxyRefused` is what the proxy has refused on its own so far.
 */
async function prove(run: Run, proxyRefused: () => readonly SiteAsk[]): Promise<void> {
	if (proved) return;
	const room = path.join(run.places.temp, "proof");
	// Beside this turn's temp, in the room's own folder in the box root, which no request grants.
	const outside = path.join(path.dirname(run.places.temp), `temp-${randomBytes(8).toString("hex")}`);
	fs.mkdirSync(room);
	fs.mkdirSync(outside);
	fs.writeFileSync(path.join(room, "deleted.txt"), "");
	const closed = path.join(outside, "closed.txt");
	const planted = path.join(outside, "planted.txt");
	fs.writeFileSync(closed, PROOF_MARK);
	const [throughProxy, direct] = await Promise.all([proofListener(), proofListener()]);
	try {
		const { requestPath } = run.box;
		const rules = machineRules(run.box, { folder: room, canChangeFiles: true }, [], run.places);
		const proofRun = async (text: string) => {
			const built = commandRequest(rules, { wrapper: COMMAND_WRAPPER, text, timeoutMs: PROOF_LIMIT_MS, proxyPort: run.proxyPort });
			if (!built.ok) throw new Error(`the proof's request was refused: ${JSON.stringify(built.refused)}`);
			let output = "";
			await runRequest(run, built.request, (chunk) => { output += chunk.toString("utf8"); });
			return output;
		};
		const [, , read] = await Promise.all([
			proofRun("Set-Content -LiteralPath 'written.txt' -Value 'ok'"),
			proofRun("Remove-Item -LiteralPath 'deleted.txt'"),
			proofRun(`Get-Content -LiteralPath ${powerShellString(requestPath(closed))}`),
			proofRun(`Set-Content -LiteralPath ${powerShellString(requestPath(planted))} -Value 'x'`),
			proofRun(`& ${CURL} -sS --max-time 10 'http://localhost:${throughProxy.port}/'`),
			proofRun(`& ${CURL} -sS --max-time 10 --noproxy '*' 'http://127.0.0.1:${direct.port}/'`),
		]);
		const proxySawIt = proxyRefused().some((site) => site.host === "localhost" && site.port === throughProxy.port);
		const written = fs.existsSync(path.join(room, "written.txt")) ? fs.readFileSync(path.join(room, "written.txt"), "utf8") : "";
		const failed = [
			written.trim() === "ok" ? "" : "a write in the room",
			fs.existsSync(path.join(room, "deleted.txt")) ? "a delete in the room" : "",
			read.includes(PROOF_MARK) ? "a read outside" : "",
			fs.existsSync(planted) ? "a write outside" : "",
			throughProxy.reached() || !proxySawIt ? "a site the room refuses" : "",
			direct.reached() ? "a direct connection" : "",
		].filter(Boolean);
		if (failed.length > 0) throw new Error(`the box did not hold: ${failed.join(", ")}`);
		proved = true;
	} finally {
		throughProxy.close();
		direct.close();
		await Promise.all([removePlace(room), removePlace(outside)]);
	}
}

/**
 * The request, with the app's data shut where a grant reaches it. The app's
 * data is shut by never being granted, but an agent folder a developer setting
 * moved into a folder the system's lists grant, as ProgramData or a PATH folder,
 * would be read through it: there it is shut by name, and a skill of its
 * library goes unopened, since nothing is granted inside a shut place. A PATH
 * folder that holds it leaves PATH, as for any shut place it holds.
 */
export function shutAppData(rules: WindowsRoomRules, request: (rules: WindowsRoomRules) => RequestResult, appData: readonly string[]): RequestResult {
	const first = request(rules);
	if (!first.ok) return first;
	const grants = [...first.request.filesystem.readwritePaths, ...first.request.filesystem.readonlyPaths];
	const reached = appData.filter((place) => grants.some((grant) => atOrInside(place, grant)));
	if (reached.length === 0) return first;
	return request({ ...rules, denied: [...rules.denied, ...reached], skillFolders: rules.skillFolders.filter((folder) => !reached.some((place) => atOrInside(folder, place))) });
}

/** One room's box for its commands: at most one run at a time, and a room runs one turn at a time. */
export class WindowsRoomBox {
	/** Its commands are Windows PowerShell 5.1 (../../room-command-tool.ts reads it). */
	readonly kind = "windows";
	private run: Run | null = null;
	private starting: Promise<Run> | null = null;
	private ending: Promise<void> = Promise.resolve();
	/** Counts the turns that have ended: a command or a start from an ended turn sees it moved. */
	private turn = 0;
	/** Aborted at the turn's end: a command of the turn still waiting for its folders stops waiting. */
	private turnEnded = new AbortController();

	constructor(private readonly options: WindowsRoomBoxOptions) {}

	private folders(): RoomFolders {
		return this.options.folders?.() ?? storedRoomFolders(this.options.roomId, this.options.conversationId(), this.options.answer?.());
	}

	private async startRun(): Promise<Run> {
		await this.ending;
		const answer = await (this.options.startAnswer ?? windowsStartAnswer)();
		// Never a command without the box: off is the caller's to route elsewhere.
		if (answer.state !== "on") throw new BoxFault(answer.reason);
		let places: TurnPlaces | undefined;
		let worker: WindowsWorker | undefined;
		try {
			places = makeTurnPlaces(answer.box.root, this.options.roomData ?? persistentAgentRootPath(this.options.roomId), (why) => this.options.warn({ why }, "curl's settings for the room's commands could not be written; this turn's commands run without them"), () => this.options.warn({ roomId: this.options.roomId }, "the room's caches were not a plain folder: what was there was removed, never what it led to, and a fresh folder made"));
			const turnPlaces = places;
			// Tidying only: a temp that won't go now goes at a later turn.
			await sweepOldTemps(places).catch((error) => this.options.warn({ err: message(error), temp: turnPlaces.temp }, "an old temp of the room was not removed"));
			const gitConfig = gitIdentity(answer.box.root, answer.box.machine.environment, (why) => this.options.warn({ why }, "the person's git name and e-mail could not be written for the room's commands; this turn's commands run without them"));
			if (gitConfig !== undefined) places = { ...places, gitConfig };
			worker = await WindowsWorker.start(answer.box.worker);
			// While the proof runs, its sites reach no person and no command's result.
			let proofRefused: SiteAsk[] | null = [];
			const proxyPort = await worker.openProxy({
				ask: (site, how) => (proofRefused || !this.options.sites ? Promise.resolve(NO_SITES) : this.options.sites.ask(site, how)),
				refused: (site, reason) => (proofRefused ? proofRefused.push(site) : this.options.sites?.refused(site, reason)),
			});
			const run: Run = { box: answer.box, worker, places, proxyPort };
			await prove(run, () => proofRefused ?? []);
			proofRefused = null;
			return run;
		} catch (error) {
			this.options.warn({ err: message(error), roomId: this.options.roomId }, "the room's box did not start");
			await worker?.end();
			if (places) await removePlace(places.temp).catch(() => {});
			throw error instanceof BoxFault ? error : new BoxFault(message(error));
		}
	}

	/** This turn's run, started on its first command. A box that won't start or hold throws BoxFault, and the command never runs. */
	private ensureRun(): Promise<Run> {
		if (this.run?.worker.alive) return Promise.resolve(this.run);
		if (!this.starting) {
			const turn = this.turn;
			const starting = this.startRun().then((run) => {
				// A start that outlived its turn is the turn's end to finish (endTurn).
				if (this.turn === turn) this.run = run;
				return run;
			});
			this.starting = starting;
			starting.catch(() => {}).finally(() => {
				if (this.starting === starting) this.starting = null;
			});
		}
		return this.starting;
	}

	/** The one layer every boxed command runs through. */
	operations(): BashOperations {
		return {
			exec: async (command, _cwd, options) => {
				const turn = this.turn;
				const run = await untilStopped(this.ensureRun(), options.signal);
				// The turn ended while its box started: the command never runs.
				if (this.turn !== turn) throw new Error("aborted");
				const timeoutSeconds = options.timeout !== undefined && options.timeout > 0 ? options.timeout : DEFAULT_TIMEOUT_SECONDS;
				// Whether the command printed anything, and the refusal's words, read line by line across chunks: a line not yet ended is kept for the next one.
				let printed = false;
				let denied = false;
				let line = "";
				const onData = (chunk: Buffer) => {
					printed ||= chunk.length > 0;
					const text = line + chunk.toString("utf8");
					denied ||= ACCESS_DENIED.test(text);
					line = text.slice(text.lastIndexOf("\n") + 1).slice(-LINE_KEPT);
					options.onData(chunk);
				};
				// The command's request, built from the folders and rights as they are at that moment, or the reason it can't run.
				const request = (folders: RoomFolders): WindowsBoxRequest => {
					const rights = this.options.rights();
					const skillFolders = rights.skillFolders.flatMap((folder) => windowsSkillFolder(folder, run.box.requestPath) ?? []);
					const rules = machineRules(run.box, { folder: folders.folder, canChangeFiles: rights.canChangeFiles }, folders.alsoAllowed, run.places, skillFolders);
					const built = shutAppData(rules, (each) => commandRequest(each, { wrapper: COMMAND_WRAPPER, text: command, timeoutMs: timeoutSeconds * 1000, proxyPort: run.proxyPort }), appDataPlaces().map(run.box.requestPath));
					if (built.ok) return built.request;
					if (built.refused.code === "too-long") throw new Error("This command is longer than Windows lets one command be. Split it into shorter commands.");
					throw new BoxFault(`the request was refused: ${JSON.stringify(built.refused)}`);
				};
				const named = (folders: RoomFolders) => [folders.folder, ...folders.alsoAllowed.map((entry) => entry.path)];
				// Stop, or the turn's end while it waits for the folders: it never runs.
				const signal = options.signal ? AbortSignal.any([options.signal, this.turnEnded.signal]) : this.turnEnded.signal;
				// The refusal's words, or a failure or timeout with nothing to say: a refused place looks like either. Stop is the person's, and a box that failed partway has its own line.
				let ran = false;
				let endCommand: ((failed: boolean) => string[]) | undefined;
				let noted = true;
				let failed = true;
				try {
					// Read now, and again once its folders are held: a folder changed, refused or given meanwhile, or a room made read-only, reaches this command.
					let holding = named(this.folders());
					for (;;) {
						const held = holding;
						const step = await folderWait.hold("command", held, signal, async (): Promise<{ result: { exitCode: number } } | { more: string[] }> => {
							if (this.turn !== turn) throw new Error("aborted");
							const folders = this.folders();
							const now = named(folders);
							if (!now.every((folder) => held.some((each) => folderWait.inside(folder, each)))) return { more: now };
							const built = request(folders);
							ran = true;
							endCommand = this.options.sites?.startCommand?.();
							return { result: await runRequest(run, built, onData, options.signal) };
						});
						if ("result" in step) {
							failed = step.result.exitCode !== 0;
							return step.result;
						}
						holding = [...new Set([...held, ...step.more])];
					}
				} catch (error) {
					if (options.signal?.aborted || error instanceof BoxFault) noted = false;
					throw error;
				} finally {
					// The proxy's refusals during this command follow it once, beside the line on a refused place.
					const notes = ran ? [...(endCommand?.(noted && failed) ?? []), ...(noted && (denied || (failed && !printed)) ? [boxRefusedLine(this.options.asks?.() === true)] : [])] : [];
					if (notes.length > 0) options.onData(Buffer.from(`\n${notes.join("\n")}\n`));
				}
			},
		};
	}

	/**
	 * The turn's temp, where a command's long output lands: asking for it starts
	 * the turn's box, as a command does, and Stop or the turn's end while it
	 * starts ends the wait with `aborted`, so the command never runs.
	 */
	async privateTemp(signal?: AbortSignal): Promise<string> {
		const turn = this.turn;
		const run = await untilStopped(this.ensureRun(), signal);
		if (this.turn !== turn) throw new Error("aborted");
		return run.places.temp;
	}

	/** The running answer's temp for its commands, by its real path, while a run is open: the file tools say what it is when they refuse it. */
	ownTemp(): string | undefined {
		return this.run?.places.temp;
	}

	/** The file tools never read in the Windows box, so a long output is read with a command. */
	readsSpills(): boolean {
		return false;
	}

	/** No file tool reads a long output here, so there is nothing to note. */
	noteSpill(): void {}

	/** Ends the turn's box, a start still under way included: its process goes, and every command with it, then its temp. */
	endTurn(): Promise<void> {
		this.turn += 1;
		this.turnEnded.abort();
		this.turnEnded = new AbortController();
		this.options.sites?.endTurn?.();
		const { run, starting } = this;
		this.run = null;
		this.starting = null;
		if (!run && !starting) return this.ending;
		this.ending = (async () => {
			// Both, when a crashed run's replacement was starting: the replacement is never published once the turn moved.
			const ended = [run, await starting?.catch(() => null)].filter((each): each is Run => Boolean(each));
			await Promise.all(ended.map(async (each) => {
				await each.worker.end();
				await removePlace(each.places.temp);
			}));
		})().catch((error) => {
			this.options.warn({ err: message(error) }, "the room's private temp was not emptied");
		});
		return this.ending;
	}
}
