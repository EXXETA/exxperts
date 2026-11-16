import { execFile, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

import { type BashOperations, createLocalBashOperations } from "@exxeta/exxperts-runtime";

import { persistentAgentRootPath, resolvePersistentRoomCapabilityPolicy } from "../persistent-room-workspace-policy.js";
import { ROOM_FOLDER_REFUSED, roomFence, under } from "../room-files.js";
import { addAlsoAllowedSite, AnswerSites, coversSite, readAlsoAllowed, sameSite, saveAlsoAllowedFolders } from "./also-allowed.js";
import { realPathOf } from "./box-closed.js";
import { ASK_AGAIN_FROM_COMPUTER, boxRefusedLine, FREE_PRIVATE_REFUSAL } from "./card-text.js";
import { runBoxProbe } from "./box-probe.js";
import { BoxFault, BoxProcess, type DialRefusal, FolderMoved, type SiteAnswer, type SiteAsk } from "./box-process.js";
import { FILE_PROGRAM_ENV, type FileProgramCall, noteBoxedCommand, ProgramEnded, type ProgramRun } from "./box-files.js";
import { boxEnvironment, type BoxPlaces, boxRules, MKTEMP_SHIM } from "./box-rules.js";
import { addressRefusal, FREE_DENIED_RANGES, LOCAL_REFUSAL, siteRefusal } from "./site-asks.js";
import { soundFolders, unsoundForEveryone } from "./folder-offer.js";
import { QuestionDeclined, type SiteApply } from "../web-ui-context.js";
import type { AnswerFolders } from "./folder-question.js";

export { roomBoxAvailable } from "./box-available.js";

/** Who can answer a card right now. */
export type BoxWatcher = "computer" | "phone" | "none";
export type SiteChoice = "once" | "room" | "decline";

/** The slice of the room's question bridge the box uses. */
export interface BoxQuestions {
	watcher(): BoxWatcher;
	/** `apply` stores a yes before the card says so; the answer still decides on its own whether the site is allowed. Aborting `signal` closes this card alone, unanswered. */
	askSite(card: { host: string; port: number; lasting: boolean }, apply: SiteApply, signal?: AbortSignal): Promise<{ choice: SiteChoice; answeredBy: BoxWatcher }>;
	/** Ends every site card still open: its command has gone with the turn. */
	closeSiteCards(sentence: string): void;
}

export interface RoomBoxOptions {
	roomId: string;
	conversationId: () => string;
	questions: BoxQuestions;
	/** What the room allows right now; read at each command, so a change reaches the next one. */
	rights: () => { canChangeFiles: boolean; skillFolders: string[] };
	/** The room's own folder ask. Where it's offered, a command that may have been refused sends the model to it. */
	folderAsk?: { offered: () => boolean };
	/** The running answer's own folders, read at each command beside the room's list. Only a live answer at the computer has any. */
	answer?: () => AnswerFolders;
	/** The sites the running answer was given, which its pages read too; without it, a run keeps its own. */
	sites?: () => AnswerSites;
	/** Whether the running answer reaches public websites without asking (`roomReachesFreely`): read when its box starts, and held for that box. */
	free?: () => boolean;
	warn: (detail: Record<string, unknown>, message: string) => void;
}

const TURN_ENDED = "the turn that started this has ended";
// The library's class for an address on `deniedResolvedAddresses`, which only the box of a room on Auto is given.
const LISTED_BY_FREE = "a listed address";
const SITE_DECLINED = "the person declined this site";
// What the box prints for a refusal, and what most programs print for one, read in lower case: Node and Go print it so. A refusal may print nothing at all.
const NOT_PERMITTED = "operation not permitted";
// What the operator's line keeps of a file program's error output: room for a loader's or a runtime's own words.
const ERROR_OUTPUT_KEPT_BYTES = 2_000;
// The distinct lines one server process writes for file programs that gave no answer: one per cause, not one per call.
const NO_ANSWER_LINES_KEPT = 100;
const noAnswerLines = new Set<string>();
// Distinct site cards one turn may raise, so a loop can't fill a room with them. The web reader's page cards have the same cap.
export const SITE_REQUESTS_PER_TURN = 8;

type Run = {
	process: BoxProcess;
	places: BoxPlaces;
	/** The box of a room on Auto: no site asks, and its library refuses a name that leads to the person's own network at the dial. */
	free: boolean;
	/** Sites a person allowed for this run only, where the answer's own aren't given. */
	sites: AnswerSites;
	/** Cards open now, so two connections to one site raise one card. */
	openCards: Map<string, Promise<SiteAnswer>>;
	/** Sites that raised a card this turn, as `host:port`: a loop can't fill the turn with site cards. */
	siteCards: Set<string>;
	/** Why sites were refused, for the result of the command that asked. */
	siteRefusals: Set<string>;
	/** Sites the person said no to: refused without a card until the running commands have ended, or a command starts after none ran. */
	declined: SiteAsk[];
	/** Commands running now. */
	running: number;
	/** Process groups of file programs still running: the turn's end stops them. */
	programs: Set<number>;
	/** Where each boxed command's process group and its keeper are noted as it starts, by the command's id, outside every place a command can write. */
	groups: string;
	/** The commands whose group has been stopped, by id. */
	stopped: Set<string>;
	/** This run's long outputs, by exact path: the file tools may read these and nothing else in its private temp. */
	spills: Set<string>;
	ended: boolean;
};

/** A room's folder no room may use: the command never runs, as for a folder that moved. */
class FolderRefused extends FolderMoved {
	constructor() {
		super();
		this.message = ROOM_FOLDER_REFUSED;
	}
}

// What each command's shell leaves sleeping in its group: longer than any answer, and ended with the group.
const KEEPER = "/bin/sleep 86400";

const alive = (pid: number): boolean => {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
};

function killGroup(pid: number): void {
	try {
		process.kill(-pid, "SIGKILL");
	} catch {
		// Already gone.
	}
}

/** A command's process group, and the keeper its shell left sleeping in it. */
type Noted = { group: number; keeper: number };

/** The process group each of this run's commands started, by command id, as their shells noted them. */
function notedGroups(file: string): Map<string, Noted> {
	let noted = "";
	try {
		noted = fs.readFileSync(file, "utf8");
	} catch {
		// No command ran this turn.
	}
	const groups = new Map<string, Noted>();
	for (const line of noted.split("\n")) {
		const match = /^([0-9a-f]+) ([1-9][0-9]*) ([1-9][0-9]*)$/.exec(line);
		if (match) groups.set(match[1], { group: Number(match[2]), keeper: Number(match[3]) });
	}
	return groups;
}

/** Whether the group holds nothing but its keeper. Unreadable counts as more. */
function onlyKeeper({ group, keeper }: Noted): Promise<boolean> {
	return new Promise((resolve) => {
		// pgrep exits 1 when it lists nobody.
		execFile("/usr/bin/pgrep", ["-g", String(group)], { timeout: 5_000 }, (error, stdout) => {
			const listed = error && (error as { code?: unknown }).code !== 1 ? null : String(stdout ?? "");
			resolve(listed !== null && listed.split("\n").filter(Boolean).every((pid) => Number(pid) === keeper));
		});
	});
}

/** Stops each command's group whose keeper still runs: a keeper a job ended leaves a number that may be someone else's by now. */
function stopGroups(run: Run): void {
	for (const [id, noted] of notedGroups(run.groups)) {
		if (run.stopped.has(id)) continue;
		run.stopped.add(id);
		if (alive(noted.keeper)) killGroup(noted.group);
	}
}

// The runs whose commands may have keepers sleeping: a server that exits stops their groups first, so no keeper outlives it.
const openRuns = new Set<Run>();
let stopsAtExit = false;

function keepOpen(run: Run): void {
	openRuns.add(run);
	if (stopsAtExit) return;
	stopsAtExit = true;
	process.once("exit", () => {
		for (const open of openRuns) stopGroups(open);
	});
}

/** One connection's boxes: at most one run at a time, and a room runs one turn at a time. */
export class RoomBox {
	private run: Run | null = null;
	private starting: Promise<Run> | null = null;
	private ending: Promise<void> = Promise.resolve();
	private filesHere = false;

	constructor(private readonly options: RoomBoxOptions) {}

	private boxFolder(): string {
		return path.join(persistentAgentRootPath(this.options.roomId), "runtime", "box");
	}

	private preparePlaces(): BoxPlaces {
		const box = this.boxFolder();
		const places: BoxPlaces = {
			temp: path.join(box, `temp-${randomBytes(6).toString("hex")}`),
			caches: path.join(box, "caches"),
			shim: path.join(box, "bin"),
			gitTemplate: path.join(box, "git-template"),
		};
		for (const folder of Object.values(places)) fs.mkdirSync(folder, { recursive: true, mode: 0o700 });
		const real = Object.fromEntries(Object.entries(places).map(([name, folder]) => [name, realPathOf(folder)])) as unknown as BoxPlaces;
		fs.writeFileSync(path.join(real.shim, "mktemp"), MKTEMP_SHIM, { mode: 0o755 });
		return real;
	}

	private async startRun(): Promise<Run> {
		await this.ending;
		const places = this.preparePlaces();
		const run: Run = {
			process: null as unknown as BoxProcess,
			places,
			free: this.options.free?.() === true,
			sites: new AnswerSites(),
			openCards: new Map(),
			siteCards: new Set(),
			siteRefusals: new Set(),
			declined: [],
			running: 0,
			programs: new Set(),
			groups: path.join(path.dirname(places.temp), `groups-${path.basename(places.temp)}`),
			stopped: new Set(),
			spills: new Set(),
			ended: false,
		};
		try {
			run.process = await BoxProcess.start(places.temp, run.free ? FREE_DENIED_RANGES : [], (ask) => this.answerSite(run, ask), (refusal) => this.dialRefused(run, refusal));
			await runBoxProbe(run.process, places);
			// The probe's refused site is no command's to report.
			run.siteRefusals.clear();
			void this.sweepOldTemps(run);
		} catch (error) {
			this.options.warn({ err: (error as Error).message, roomId: this.options.roomId }, "the room's box did not start");
			await run.process?.stop().catch(() => {});
			throw new BoxFault((error as Error).message);
		}
		return run;
	}

	/** This turn's run, started on its first command. A box that won't start throws BoxFault and the command never runs. */
	ensureRun(): Promise<Run> {
		if (this.run?.process.alive) return Promise.resolve(this.run);
		this.starting ??= this.startRun().then((run) => {
			this.run = run;
			keepOpen(run);
			return run;
		}).finally(() => {
			this.starting = null;
		});
		return this.starting;
	}

	private async answerSite(run: Run, ask: SiteAsk): Promise<SiteAnswer> {
		const answer = await this.decideSite(run, ask);
		// A refusal by an earlier no is named as the person declined it: one site, one line, its www name included.
		const declined = !answer.allow && answer.reason === SITE_DECLINED ? run.declined.find((each) => sameSite(each, ask)) : undefined;
		if (!answer.allow) run.siteRefusals.add(`The room's protection refused ${(declined ?? ask).host}: ${answer.reason}.`);
		return answer;
	}

	/** A site the library refused at the dial: on Auto, a name on the person's own network; else a name that led somewhere local after its yes. */
	private dialRefused(run: Run, { host, classes }: DialRefusal): void {
		const reason = classes.length > 0 && classes.every((each) => each === LISTED_BY_FREE) ? FREE_PRIVATE_REFUSAL : LOCAL_REFUSAL;
		run.siteRefusals.add(`The room's protection refused ${host}: ${reason}.`);
	}

	private async decideSite(run: Run, { host, port }: SiteAsk): Promise<SiteAnswer> {
		const refusal = siteRefusal(host);
		if (refusal) return { allow: false, reason: refusal };
		if (run.ended) return { allow: false, reason: TURN_ENDED };
		// No question and no lookup here: the library refuses, at the dial, an address that isn't public.
		if (run.free) return { allow: true };
		const answer = await this.permission(run, host, port);
		if (!answer.allow) return answer;
		const closed = await addressRefusal(host);
		return closed ? { allow: false, reason: closed } : answer;
	}

	/** This answer's sites, or this run's where the answer's aren't given. */
	private answerSites(run: Run): AnswerSites {
		return this.options.sites?.() ?? run.sites;
	}

	/** Whether this site may be reached: this answer's yes, the room's list, or a person's answer. */
	private permission(run: Run, host: string, port: number): Promise<SiteAnswer> {
		const key = `${host}:${port}`;
		if (this.answerSites(run).commandsReach({ host, port })) return Promise.resolve({ allow: true });
		// The room's own list, read now: a yes in the pane or on a card reaches the next connection.
		if (coversSite(readAlsoAllowed(this.options.roomId).sites, { host, port })) return Promise.resolve({ allow: true });
		if (coversSite(run.declined, { host, port })) return Promise.resolve({ allow: false, reason: SITE_DECLINED });
		const open = run.openCards.get(key);
		if (open) return open;
		const answer = this.askPerson(run, host, port).finally(() => run.openCards.delete(key));
		run.openCards.set(key, answer);
		return answer;
	}

	private async askPerson(run: Run, host: string, port: number): Promise<SiteAnswer> {
		const { questions } = this.options;
		const nobodyThere: SiteAnswer = { allow: false, reason: `nobody is here to allow this site; ${ASK_AGAIN_FROM_COMPUTER}` };
		const watcher = questions.watcher();
		if (watcher === "none") return nobodyThere;
		const key = `${host}:${port}`;
		if (!run.siteCards.has(key) && run.siteCards.size >= SITE_REQUESTS_PER_TURN) {
			return { allow: false, reason: "too many sites were asked for in this turn; the person can allow them, then run it again" };
		}
		run.siteCards.add(key);
		const declined = (): SiteAnswer => {
			run.declined.push({ host, port });
			return { allow: false, reason: SITE_DECLINED };
		};
		try {
			// Only the computer changes the list; a phone's yes lasts for this answer, and reaches its pages too.
			const apply: SiteApply = (choice, answeredBy) => {
				if (run.ended) return null;
				if (choice === "room" && answeredBy === "computer") {
					addAlsoAllowedSite(this.options.roomId, host, port);
					return "room";
				}
				return this.answerSites(run).give({ host, port }, "commands") ? "once" : null;
			};
			const { choice } = await questions.askSite({ host, port, lasting: watcher === "computer" }, apply);
			if (run.ended) return { allow: false, reason: TURN_ENDED };
			if (choice === "decline") return declined();
			return { allow: true };
		} catch (error) {
			if (run.ended) return { allow: false, reason: TURN_ENDED };
			// A message sent while the card waited is the person's no.
			if (error instanceof QuestionDeclined) return declined();
			// The person left, or stopped the turn.
			return questions.watcher() !== "none" ? { allow: false, reason: "the person stopped this" } : nobodyThere;
		}
	}

	/**
	 * A command's folder by its real path, which must be the room's folder as the
	 * person chose it, or inside it: the file fence's own check, that its real path
	 * now still hashes to the stored one. One moved away with a link put at its
	 * name gets no box, so nothing in what is there now is read or written.
	 */
	private chosenFolder(cwd: string): string {
		const folder = realPathOf(cwd);
		const { policy } = resolvePersistentRoomCapabilityPolicy(this.options.roomId, this.options.conversationId());
		const fence = policy ? roomFence(policy, () => []) : null;
		if (fence?.refused) throw new FolderRefused();
		if (!fence?.room || !under(folder, fence.room.path)) throw new FolderMoved();
		return folder;
	}

	/** The places the box reopens for reading and writing beyond the room, and the rules for one command. */
	private commandRules(run: Run, cwd: string) {
		const { canChangeFiles, skillFolders } = this.options.rights();
		const folder = this.chosenFolder(cwd);
		// Checked at each command too: the file can be edited by hand, the closed list can grow, and a folder can be swapped for a link.
		// An entry no conversation can use leaves the room's list. One unsound only against this conversation's folder is skipped here alone: the room's other conversations have other folders.
		const listed = readAlsoAllowed(this.options.roomId).folders;
		const unsound = unsoundForEveryone(listed);
		const kept = unsound.length > 0 ? listed.filter((entry) => !unsound.includes(entry)) : listed;
		if (unsound.length > 0) saveAlsoAllowedFolders(this.options.roomId, kept);
		// What the answer was given is judged as the list is, and never saved: one swapped for a link drops out here.
		const alsoAllowed = soundFolders(this.options.answer?.().over(kept) ?? kept, folder);
		return boxRules({ folder, canChangeFiles, alsoAllowed, skillFolders, places: run.places });
	}

	/** The one layer every boxed command runs through. Plain operations never reach this class. */
	operations(): BashOperations {
		// A fixed shell with no startup files, never the person's own.
		const local = createLocalBashOperations({ shellPath: "/bin/bash" });
		return {
			exec: async (command, cwd, options) => {
				const run = await this.ensureRun();
				let rules: ReturnType<RoomBox["commandRules"]>;
				try {
					rules = this.commandRules(run, cwd);
				} catch (error) {
					if (error instanceof FolderMoved) throw error;
					throw new BoxFault((error as Error).message);
				}
				const commandId = randomBytes(16).toString("hex");
				const { wrapped } = await run.process.request<{ wrapped: string }>("wrap", { command, filesystem: rules.filesystem, profileRules: rules.profileRules }).catch((error: Error) => {
					throw new BoxFault(error.message);
				});
				// Before it starts: from here a job of this command may outlive it, so file tools never fall back to the server's own reads until the computer restarts.
				noteBoxedCommand();
				const env = boxEnvironment(options.env ?? process.env, run.places);
				// Whether the command printed anything, and the refusal's words, read across chunks: the end of the last one is kept, long enough to hold them.
				let printed = false;
				let notPermitted = false;
				let tail = "";
				const onData = (chunk: Buffer) => {
					printed ||= chunk.length > 0;
					const text = tail + chunk.toString("utf8");
					notPermitted ||= text.toLowerCase().includes(NOT_PERMITTED);
					tail = text.slice(-NOT_PERMITTED.length);
					options.onData(chunk);
				};
				// The refusal's words, or a failure or timeout with nothing to say: a refused place looks like either. One that says why in its own words was not refused.
				const finish = (failed: boolean) => {
					const asks = this.options.folderAsk?.offered() === true && this.options.questions.watcher() !== "none";
					const notes = [...run.siteRefusals, ...(notPermitted || (failed && !printed) ? [boxRefusedLine(asks)] : [])];
					run.siteRefusals.clear();
					if (notes.length > 0) options.onData(Buffer.from(`\n${notes.join("\n")}\n`));
				};
				// The runtime starts each command as a process group of its own, which a job it leaves running stays in. The outer shell, outside the box,
				// first leaves a keeper sleeping there: while it lives, the system hands that group's number to no one else, so Stop and the turn's end can stop the whole group.
				const groups = run.groups.replaceAll("'", "'\\''");
				const noted = `${KEEPER} </dev/null >/dev/null 2>&1 & printf '%s %d %d\\n' '${commandId}' "$$" "$!" >> '${groups}' && ${wrapped}`;
				// Stop ends what this command leaves running at once, whatever else the answer still waits on.
				options.signal?.addEventListener("abort", () => stopGroups(run), { once: true });
				let failed = true;
				// A no lasts while commands run: one that starts after every other had ended asks again.
				if (run.running === 0) run.declined = [];
				run.running += 1;
				try {
					const result = await local.exec(noted, cwd, { ...options, onData, env });
					failed = result.exitCode !== 0;
					return result;
				} catch (error) {
					// Stop is the person's, not a refusal.
					if (options.signal?.aborted) failed = false;
					throw error;
				} finally {
					run.running -= 1;
					if (run.running === 0) run.declined = [];
					// The library's refusals at the dial reach this command's result.
					await run.process.request("settle", {}).catch(() => {});
					finish(failed);
					await this.dropKeeper(run, commandId);
				}
			},
		};
	}

	/** A command that returned with nothing left running needs no keeper. */
	private async dropKeeper(run: Run, commandId: string): Promise<void> {
		const noted = notedGroups(run.groups).get(commandId);
		if (!noted || run.stopped.has(commandId) || !(await onlyKeeper(noted)) || run.stopped.has(commandId)) return;
		run.stopped.add(commandId);
		killGroup(noted.group);
	}

	/** The run's private temp, where long output lands. */
	async privateTemp(): Promise<string> {
		return (await this.ensureRun()).places.temp;
	}

	/** The room's file tools read and write in this box: from then on they can read a long output too. */
	serveFiles(): void {
		this.filesHere = true;
	}

	/** Whether the file tools can read a long output: only those that read in this box. */
	readsSpills(): boolean {
		return this.filesHere;
	}

	/** Long output moved into this run's private temp: the file tools may read it, by this exact path, until the turn ends. */
	noteSpill(file: string): void {
		this.run?.spills.add(file);
	}

	/** This run's long outputs, by exact path. */
	spills(): string[] {
		return this.run ? [...this.run.spills] : [];
	}

	/**
	 * Runs one file program in this turn's box, as a command runs: its own group,
	 * a short environment, the room's folder. The request goes on stdin; the answer
	 * is what it prints. Stop, the call's limit and the turn's end each kill it,
	 * and an answer past its size is cut off, so nothing it does can hold the server.
	 * The start of its error output is kept for the operator's line, should it give no answer.
	 * A box that won't start throws BoxFault.
	 */
	async runFileProgram(call: FileProgramCall): Promise<ProgramRun> {
		const run = await this.ensureRun();
		if (call.signal?.aborted) throw new ProgramEnded("stopped");
		const { wrapped } = await run.process.request<{ wrapped: string }>("wrap", { command: call.command, ...call.rules }).catch((error: Error) => {
			throw new BoxFault(error.message);
		});
		// Stop, or the turn's end, while it was wrapped: nothing of it starts.
		if (call.signal?.aborted) throw new ProgramEnded("stopped");
		if (run.ended) throw new ProgramEnded("turn");
		return new Promise<ProgramRun>((resolve, reject) => {
			const child = spawn("/bin/bash", ["-c", wrapped], { cwd: call.cwd, detached: true, stdio: ["pipe", "pipe", "pipe"], env: { ...FILE_PROGRAM_ENV } });
			const pid = child.pid;
			const chunks: Buffer[] = [];
			let size = 0;
			const errors: Buffer[] = [];
			let errorSize = 0;
			let ended: ProgramEnded | null = null;
			const end = (why: ProgramEnded["why"]) => {
				ended ??= new ProgramEnded(why);
				if (pid) killGroup(pid);
			};
			const limit = setTimeout(() => end("time"), call.limitMs);
			const stop = () => end("stopped");
			// A write once started runs to its end, or to its limit: Stop and the turn's end never cut a file short.
			if (!call.whole) {
				call.signal?.addEventListener("abort", stop, { once: true });
				if (pid) run.programs.add(pid);
			}
			child.stdout.on("data", (chunk: Buffer) => {
				size += chunk.length;
				if (size > call.maxOutputBytes) end("size");
				else chunks.push(chunk);
			});
			// Read to its end, so a program that writes a lot there never waits on the pipe; only the start is kept.
			child.stderr.on("data", (chunk: Buffer) => {
				if (errorSize < ERROR_OUTPUT_KEPT_BYTES) errors.push(chunk.subarray(0, ERROR_OUTPUT_KEPT_BYTES - errorSize));
				errorSize += chunk.length;
			});
			child.stdin.on("error", () => {});
			child.stdin.end(call.request);
			const settle = (error: Error | null, how = "") => {
				clearTimeout(limit);
				call.signal?.removeEventListener("abort", stop);
				if (pid) run.programs.delete(pid);
				// The turn's end kills what is left: it answers as a turn that ended. A write that ran to its end says what it did.
				const why = ended ?? (run.ended && !call.whole ? new ProgramEnded("turn") : null);
				// Its time and size limits are the server's, not the person's: a program stopped at one gave no answer either.
				const atLimit = why?.why === "time" || why?.why === "size" ? why.why : null;
				const ran: ProgramRun = { output: Buffer.concat(chunks), ended: atLimit ? `stopped at its ${atLimit} limit, ${how}` : how, errorOutput: Buffer.concat(errors) };
				if (why) {
					why.run = ran;
					if (atLimit) this.noteNoAnswer(ran);
					reject(why);
				} else if (error) reject(error);
				else resolve(ran);
			};
			child.on("error", (error) => settle(error));
			child.on("close", (code, signal) => settle(null, signal ? `signal ${signal}` : `exit code ${code}`));
		});
	}

	/**
	 * Tells the operator that a file program gave no answer, or was stopped at its
	 * time or size limit before it gave one: how it ended and what
	 * it wrote to its error output, on one line. These words go to the log alone,
	 * never into the fault, so neither the model nor a person reads them. One line
	 * per server process for the same words, numbers aside, so a box that fails at
	 * every call doesn't write one per call, though the loader names each call's
	 * process. All of it is in the message, which every log keeps on one line; a
	 * scheduled run's log may spread a detail over several.
	 */
	noteNoAnswer(ran: ProgramRun): void {
		let errorOutput = ran.errorOutput.toString("utf8").replace(/[\u0000-\u001f\u007f-\u009f]/g, " ");
		// A character the cut split, or a byte that isn't text, reads back longer than it was.
		while (Buffer.byteLength(errorOutput) > ERROR_OUTPUT_KEPT_BYTES) errorOutput = errorOutput.slice(0, -1);
		const line = `the file program gave no answer (${ran.ended}); its error output: ${errorOutput || "none"}`;
		const same = line.replace(/\d+/g, "0");
		if (noAnswerLines.has(same) || noAnswerLines.size >= NO_ANSWER_LINES_KEPT) return;
		noAnswerLines.add(same);
		this.options.warn({}, line);
	}

	/**
	 * What empties a temp through the box, which can't follow a link a job left
	 * there, then removes the folder itself. Wrapped now, while the box answers, so
	 * running it later needs nothing from the box, its network least of all.
	 */
	private async emptying(process: BoxProcess, places: BoxPlaces, temp: string): Promise<() => Promise<void>> {
		// Not a person's folder, so none of the closed names apply: a repository a command made here goes too.
		const rules = boxRules({ folder: temp, canChangeFiles: false, alsoAllowed: [], skillFolders: [], places: { ...places, temp } });
		const { wrapped } = await process.request<{ wrapped: string }>("wrap", { command: "/usr/bin/find . -mindepth 1 -delete", filesystem: rules.filesystem, profileRules: rules.profileRules });
		return async () => {
			await new Promise<void>((resolve) => {
				const child = spawn("/bin/bash", ["-c", wrapped], { cwd: temp, detached: true, stdio: "ignore", env: { PATH: "/usr/bin:/bin" } });
				child.on("error", () => resolve());
				child.on("close", () => resolve());
			});
			await fsp.rmdir(temp).catch(() => {});
		};
	}

	/** A server that was cut off leaves its run's temp behind; this run's box clears them. */
	private async sweepOldTemps(run: Run): Promise<void> {
		const box = path.dirname(run.places.temp);
		const old = (await fsp.readdir(box).catch(() => [])).filter((name) => name.startsWith("temp-") && name !== path.basename(run.places.temp));
		for (const name of old) await this.emptying(run.process, run.places, path.join(box, name)).then((empty) => empty()).catch(() => {});
		// Their notes of process groups go too: after a cut, a number may name someone else's program by now.
		for (const name of old) await fsp.rm(path.join(box, `groups-${name}`), { force: true }).catch(() => {});
	}

	/** Ends the turn's box: its port closes, so a job left behind has no network and raises no site card. */
	endTurn(): Promise<void> {
		const run = this.run;
		this.run = null;
		if (!run) return this.ending;
		run.ended = true;
		run.sites.end();
		for (const pid of run.programs) killGroup(pid);
		// Every command's group: a job left running would keep the folders this answer was given, and their changes.
		stopGroups(run);
		openRuns.delete(run);
		fs.rmSync(run.groups, { force: true });
		this.options.questions.closeSiteCards(TURN_ENDED);
		this.ending = (async () => {
			// The network closes before the emptying runs: a connection a job holds open ends with the turn, however long a large temp takes.
			const empty = await this.emptying(run.process, run.places, run.places.temp).catch((error: Error) => {
				this.options.warn({ err: error.message }, "the room's private temp was not emptied");
				return null;
			});
			await run.process.request("closeNetwork", {}).catch(() => {});
			await empty?.();
		})();
		return this.ending.finally(() => run.process.stop());
	}
}
