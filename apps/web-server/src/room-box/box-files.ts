import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { closedRefusal, type FencedPath, type FenceRoot, linkRefused, RoomFilesError, type RoomFence } from "../room-files.js";
import { realPathOf } from "./box-closed.js";
import { BoxFault, FILE_WORKER } from "./box-process.js";
import { fileRules } from "./box-rules.js";
import type { RoomBox } from "./box-session.js";

/**
 * File tools in the box: each call's actual reading, writing, listing and
 * search run as one file program inside the room's box, so the Mac decides at
 * every open, on the real path. The server's fence (room-files.ts) runs first
 * and gives the plain lines; it is never the guard here.
 */

/** The one line a person and the model read when file tools stop because the box didn't start after a command ran. */
export const FILES_STOPPED_LINE = "Commands and files can't be used because this room's protection didn't start. Restart your computer to bring them back.";

// The largest file a call takes: past the shelf's 25 MiB for documents, and what one answer may hold in memory.
const READ_LIMIT_BYTES = 64 * 1024 * 1024;
const LISTING_LIMIT_BYTES = 64 * 1024 * 1024;
const CALL_LIMIT_MS = 30_000;
// After a search's own budget, for the program to answer with what it found.
const SEARCH_ANSWER_MS = 5_000;
const DECK_SUFFIXES = [".key"];

/** One file program's call: what it may reach, and its request. */
export interface FileProgramCall {
	rules: { filesystem: Record<string, unknown>; profileRules: string };
	/** The program's own command line: our paths only, never a path or text from the model. */
	command: string;
	cwd: string;
	request: string;
	signal?: AbortSignal;
	limitMs: number;
	maxOutputBytes: number;
	/** A write, which changes a file in place: once started only its limit ends it, so Stop and the turn's end never leave it cut short. */
	whole?: boolean;
}

/** What one file program did: what it printed, how it ended, and the start of its error output, which only the operator's log ever gets. */
export interface ProgramRun {
	output: Buffer;
	/** `exit code <n>`, or `signal <name>`. */
	ended: string;
	errorOutput: Buffer;
}

/** Why a file program ended before it answered. `run` is what it did, once it has gone. */
export class ProgramEnded extends Error {
	run: ProgramRun | null = null;

	constructor(readonly why: "stopped" | "time" | "size" | "turn") {
		super(`the file program ended: ${why}`);
	}
}

/** A login's home, where the record of commands lives for every data profile: one Mac, one record. */
function recordFile(): string {
	return path.join(process.env.EXXPERTS_REAL_HOME?.trim() || os.homedir(), ".exxperts.box-commands");
}

let bootSeconds: number | null = null;

/** When this computer last started, in seconds, from the kernel. Unknown is null: then no record matches it. */
function computerStarted(): number | null {
	if (bootSeconds !== null) return bootSeconds;
	try {
		const match = /\bsec = (\d+)/.exec(execFileSync("/usr/sbin/sysctl", ["-n", "kern.boottime"], { encoding: "utf8", env: { PATH: "/usr/bin:/bin" } }));
		bootSeconds = match ? Number(match[1]) : null;
	} catch {
		bootSeconds = null;
	}
	return bootSeconds;
}

/** What the record says: no record, the start it names, or a record that can't be read, which counts as a command that ran. */
type Recorded = { kind: "none" } | { kind: "start"; seconds: number } | { kind: "unreadable" };

function recorded(): Recorded {
	let text: string;
	try {
		text = fs.readFileSync(recordFile(), "utf8");
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "ENOENT" ? { kind: "none" } : { kind: "unreadable" };
	}
	try {
		const value = JSON.parse(text)?.computerStarted;
		return typeof value === "number" ? { kind: "start", seconds: value } : { kind: "unreadable" };
	} catch {
		return { kind: "unreadable" };
	}
}

/**
 * Notes that a boxed command is about to run: a job it leaves may live until the
 * computer restarts. Written once per start of the computer, by a temporary file
 * and a rename, so two writers or a cut leave one whole record. A record that
 * can't be written throws BoxFault, so the command doesn't run.
 */
export function noteBoxedCommand(): void {
	const started = computerStarted();
	const now = recorded();
	if (started === null || (now.kind === "start" && now.seconds === started)) return;
	const file = recordFile();
	const temporary = `${file}.${process.pid}.${Date.now()}`;
	try {
		fs.writeFileSync(temporary, JSON.stringify({ computerStarted: started }), { mode: 0o600, flag: "wx" });
		fs.renameSync(temporary, file);
	} catch (error) {
		fs.rmSync(temporary, { force: true });
		throw new BoxFault(`the record of a boxed command was not written: ${(error as Error).message}`);
	}
}

/**
 * Whether a boxed command may have left a job running: one ran since this
 * computer started, or that can't be told. Only then do file tools stop with
 * the box; otherwise no job can be alive, and they go on with the server's fence.
 */
export function boxedCommandSinceStart(): boolean {
	const started = computerStarted();
	const now = recorded();
	return started === null || now.kind === "unreadable" || (now.kind === "start" && now.seconds === started);
}

/** One entry of a folder, as the program saw it. `deck` is set for a file with a deck's name: whether it holds a deck. */
export interface ListedEntry {
	name: string;
	kind: "file" | "dir" | "link" | "other";
	deck?: boolean;
}

export interface WalkedEntry {
	/** Below the folder walked, with `/` between parts. */
	rel: string;
	kind: "file" | "dir";
	deck?: boolean;
}

export interface WalkAnswer {
	entries: WalkedEntry[];
	folderLimit: boolean;
	skipped: boolean;
	entryLimit: boolean;
}

export interface SearchRequest {
	pattern: string;
	ignoreCase: boolean;
	literal: boolean;
	/** The files to search, as a regular expression over the path below the folder, or over the name when it has no slash. */
	glob: { source: string; slash: boolean } | null;
	context: number;
	limit: number;
	deadline: number;
	skips: string[];
	maxFolders: number;
	maxFileBytes: number;
	maxScanLineChars: number;
	maxLineChars: number;
}

export interface SearchMatch {
	rel: string;
	line: number;
	text: string;
	/** The lines around the match, from line `start`, when context was asked for. */
	around?: { start: number; lines: string[] };
}

export interface SearchAnswer {
	matches: SearchMatch[];
	/** Files it couldn't open: closed by the box, or a deck's name without a deck. */
	unreadable: string[];
	/** The folder's own entries, for counting what the fence leaves out. */
	top: ListedEntry[];
	matchLimit: boolean;
	folderLimit: boolean;
	timeLimit: boolean;
	largeFiles: number;
	longLines: boolean;
	skipped: boolean;
}

/** A path only the shell that starts the program reads: ours, never the model's, quoted whole. */
const shellWord = (word: string): string => `'${word.replaceAll("'", "'\\''")}'`;

/**
 * The file program's whole environment, and the listing Node's, so both start
 * alike. Node reads OpenSSL's settings file at every start and ends when it can't
 * open one that is there, as Homebrew's Node can't open its own under the box.
 * /dev/null, which the program's rules open already, stands in for it. A boxed
 * command's environment never gets it.
 */
export const FILE_PROGRAM_ENV: Readonly<Record<string, string>> = { PATH: "/usr/bin:/bin", OPENSSL_CONF: "/dev/null" };

// Node's own list of the libraries a process loaded, printed by a fresh Node.
const LISTING = "process.stdout.write(JSON.stringify(process.report.getReport().sharedObjects))";
const LISTING_LIMIT_MS = 10_000;
// The program's start reads cover these (PROGRAM_START_READS in box-rules.ts).
const SYSTEM_LIBRARIES = ["/usr/lib/", "/System/"];

let nodeLibraries: string[] | null = null;

/**
 * The libraries this Node loads from outside the system's, by real path, since
 * the box matches the real file and not a link to it: none for nodejs.org's Node,
 * a single binary; libnode and its kin for Homebrew's. Asked once per server
 * process, of a fresh Node with the program's own environment and no options, so
 * neither the server's add-ons nor a `NODE_OPTIONS` preload add one. A listing
 * that fails adds none.
 */
function librariesOf(node: string): string[] {
	if (nodeLibraries) return nodeLibraries;
	let listed: unknown;
	try {
		listed = JSON.parse(execFileSync(process.execPath, ["-e", LISTING], { encoding: "utf8", env: { ...FILE_PROGRAM_ENV }, timeout: LISTING_LIMIT_MS, stdio: ["ignore", "pipe", "ignore"] }));
	} catch {
		listed = [];
	}
	const real = (Array.isArray(listed) ? listed : []).filter((entry): entry is string => typeof entry === "string" && path.isAbsolute(entry)).map(realPathOf);
	nodeLibraries = [...new Set(real)].filter((library) => library !== node && !SYSTEM_LIBRARIES.some((folder) => library.startsWith(folder)));
	return nodeLibraries;
}

/** The Node that runs the file program, the program, and the libraries that Node loads, by their real paths, which its rules reopen one by one; and the command that starts it. */
export function fileProgram(): { files: string[]; command: string } {
	const started = [realPathOf(process.execPath), realPathOf(FILE_WORKER)];
	return { files: [...started, ...librariesOf(started[0])], command: started.map(shellWord).join(" ") };
}

export const notEnoughSpace = (shown: string): string => `${shown} wasn't changed: there isn't enough free space on the disk.`;

/** The model's line for what the program refused, by its code. */
function refusal(code: string, target: FencedPath, raw: string): RoomFilesError {
	switch (code) {
		case "ENOENT":
		case "ENOTDIR":
			return new RoomFilesError("path_not_found", `Path not found: ${raw}`);
		case "ENOTZIP":
			return new RoomFilesError("blocked_by_policy", closedRefusal(target.shown));
		case "ELOOP":
			return new RoomFilesError("link", linkRefused(target.shown));
		case "EEXIST":
			return new RoomFilesError("file_exists", `File already exists in selected workspace. Set overwrite=true to replace ${target.shown}.`);
		case "ENOTFILE":
		case "EISDIR":
			return new RoomFilesError("not_file", `${target.shown} is not a file.`);
		case "ENOROOM":
			return new RoomFilesError("no_space", notEnoughSpace(target.shown));
		case "ETOOBIG":
			return new RoomFilesError("file_too_large", `${target.shown} is too large for this tool.`);
		case "EPATTERN":
			return new RoomFilesError("invalid_pattern", "Grep pattern is not a valid JavaScript regular expression.");
		case "EPERM":
			// A locked file gives the same answer as the box's refusal, so the line holds for both.
			return new RoomFilesError("box_refused", `${target.shown} can't be opened: this room's protection refused it, or another program has it locked. Tell the person.`);
		case "EACCES":
			return new RoomFilesError("not_permitted", `${target.shown} can't be opened: the person's own rights on this computer don't allow it. Tell the person.`);
		default:
			return new RoomFilesError("not_readable", `${target.shown} can't be opened right now.`);
	}
}

const ENDED_LINES: Record<ProgramEnded["why"], { code: string; line: (shown: string) => string }> = {
	stopped: { code: "aborted", line: () => "Stopped before the file tool finished." },
	time: { code: "timeout", line: (shown) => `${shown} took too long to open. Try again, or ask for a smaller part.` },
	size: { code: "file_too_large", line: (shown) => `${shown} gave more than this tool can take. Refine the path or pattern.` },
	turn: { code: "aborted", line: () => "The turn ended before the file tool finished." },
};

/** The room's box, as one call's file tools use it. Built per call, with the fence as it stands at that call. */
export class BoxFiles {
	constructor(
		private readonly box: RoomBox,
		private readonly fence: RoomFence,
	) {}

	/** What the program may reach on this call: the fence's places and its reads in the app's data, this run's long output among them. */
	private roots(): FenceRoot[] {
		return [...this.fence.roots(), ...this.fence.dataReads()];
	}

	private async call(op: string, payload: Record<string, unknown>, target: FencedPath, raw: string, options: { writes: boolean; signal?: AbortSignal; limitMs?: number; maxOutputBytes?: number }): Promise<{ header: Record<string, any>; bytes: Buffer }> {
		const roots = this.roots();
		const program = fileProgram();
		let ran: ProgramRun;
		try {
			ran = await this.box.runFileProgram({
				rules: fileRules({ roots, writes: options.writes, closedBelow: this.fence.closedBelow(), program: program.files }),
				command: program.command,
				cwd: this.fence.room?.path ?? path.dirname(target.real),
				request: JSON.stringify({ op, ...payload }),
				signal: options.signal,
				limitMs: options.limitMs ?? CALL_LIMIT_MS,
				maxOutputBytes: options.maxOutputBytes ?? LISTING_LIMIT_BYTES,
				whole: options.writes,
			});
		} catch (error) {
			if (error instanceof ProgramEnded) throw new RoomFilesError(ENDED_LINES[error.why].code, ENDED_LINES[error.why].line(target.shown));
			throw error;
		}
		const { output } = ran;
		const lineEnd = output.indexOf(0x0a);
		let header: Record<string, any> | null = null;
		try {
			header = lineEnd < 0 ? null : JSON.parse(output.subarray(0, lineEnd).toString("utf8"));
		} catch {
			header = null;
		}
		// No answer at all is a program that didn't start or didn't hold: the box failed.
		if (!header || typeof header.ok !== "boolean") {
			this.box.noteNoAnswer(ran);
			throw new BoxFault("the file program gave no answer");
		}
		if (!header.ok) throw refusal(String(header.code), target, raw);
		return { header, bytes: output.subarray(lineEnd + 1) };
	}

	/** A regular file's bytes. A deck's name opens only a deck. */
	async read(target: FencedPath, raw: string, signal?: AbortSignal): Promise<Buffer> {
		const { header, bytes } = await this.call("read", { path: target.real, maxBytes: READ_LIMIT_BYTES, requireZip: target.needsDeck }, target, raw, { writes: false, signal, maxOutputBytes: READ_LIMIT_BYTES + 4096 });
		if (bytes.length !== header.size) throw new BoxFault("the file program's answer was cut short");
		return bytes;
	}

	async list(target: FencedPath, raw: string, signal?: AbortSignal): Promise<ListedEntry[]> {
		return (await this.call("list", { path: target.real, decks: DECK_SUFFIXES }, target, raw, { writes: false, signal })).header.entries;
	}

	async walk(target: FencedPath, raw: string, walk: { skips: string[]; maxFolders: number }, signal?: AbortSignal): Promise<WalkAnswer> {
		return (await this.call("walk", { path: target.real, ...walk, decks: DECK_SUFFIXES }, target, raw, { writes: false, signal })).header as WalkAnswer;
	}

	async search(target: FencedPath & { isFile: boolean }, raw: string, request: SearchRequest, signal?: AbortSignal): Promise<SearchAnswer> {
		const limitMs = Math.max(0, request.deadline - Date.now()) + SEARCH_ANSWER_MS;
		return (await this.call("search", { path: target.real, isFile: target.isFile, ...request, decks: DECK_SUFFIXES }, target, raw, { writes: false, signal, limitMs })).header as SearchAnswer;
	}

	/** Writes a file, making its folders, under a command's never-writable names. */
	async write(target: FencedPath, raw: string, content: string, overwrite: boolean, signal?: AbortSignal): Promise<{ existed: boolean }> {
		try {
			return (await this.call("write", { path: target.real, content, overwrite, requireZip: target.needsDeck }, target, raw, { writes: true, signal })).header as { existed: boolean };
		} catch (error) {
			// A deck's name with nothing there is a new file of a key's name: closed, as the fence closes it.
			if (target.needsDeck && error instanceof RoomFilesError && error.code === "path_not_found") throw refusal("ENOTZIP", target, raw);
			throw error;
		}
	}
}
