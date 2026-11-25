import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { PlaceRefused, placeRefused, refusedShape, type WalkedPlace, walkPlace } from "./path-shapes.js";
import type { PersistentRoomCapabilityPolicy } from "./persistent-room-workspace-policy.js";
import { hashPersistentRoomPath, PERSISTENT_ROOM_APP_SIBLING_GLOBS, PERSISTENT_ROOM_APP_STATE_SEGMENTS, PERSISTENT_ROOM_DEFAULT_DENY_CREDENTIAL_PATHS, PERSISTENT_ROOM_DEFAULT_DENY_FILENAME_GLOBS, PERSISTENT_ROOM_DEFAULT_DENY_SEGMENTS, PERSISTENT_ROOM_HOME_CLOSED_PATHS, PERSISTENT_ROOM_READ_ONLY_PATHS, PERSISTENT_ROOM_SECRET_FILENAME_TEMPLATES, PERSISTENT_ROOM_ZIP_OPENS_FILENAME_GLOBS } from "./persistent-room-workspace-policy.js";
import { persistentRoomWorkspaceToolNamesForPolicy } from "./persistent-room-tool-policy.js";
import { PersistentRoomShelfError, persistentRoomShelfDirPath, validateShelfFilename } from "./persistent-room-shelf.js";
import { readAlsoAllowed } from "./room-box/also-allowed.js";
import { appDataPlaces, isInside } from "./room-box/box-closed.js";
import { CLOSED_TO_WRITES_ASKING_NOTHING, closedAtTop, GIT_CLOSED, NEVER_WRITABLE_FILES, NEVER_WRITABLE_FOLDERS, NEVER_WRITABLE_GLOBS } from "./room-box/box-rules.js";
import { ASK_FOR_FOLDER_TOOL_NAME } from "./room-box/card-text.js";
import { type JudgedAgainst, roomFolderGrantable, soundFolders } from "./room-box/folder-offer.js";
import type { AnswerFolders } from "./room-box/folder-question.js";
import { isSharedServer } from "./server-hooks.js";

/**
 * The fence every room's file tools stop at: the room's folder, the folders on
 * its Also allowed list and those the running answer was given, and its
 * approved skills' folders for reading. Read
 * fresh at each call, so a change to the list reaches the next one. Inside it,
 * secrets, keys and the app's data stay closed (a room that asks nothing opens
 * the person's keys), and the names other programs run from can be read but
 * never changed (a room that asks nothing changes them, but `.mcp.json`).
 */

export type FenceAccess = "read" | "write";

/** A place the fence opens, by its real path. */
export interface FenceRoot {
	path: string;
	access: FenceAccess;
	/** The room's own folder: paths there show relative to it. */
	room?: true;
	/** A place the room reads beside its folders, as a skill's folder: read only, and judged by every key's name. */
	inData?: true;
	/** Of those, a shared-folder skill's real folder, which can lie anywhere: judged by its whole real path. The others are the app's own, judged by the names below them. */
	shared?: true;
	/** No folder of the room's covers it: a room that asks nothing opens it, from its disk's top. */
	beyond?: true;
}

/**
 * A path a room that asks nothing would open beyond its folders, met before the
 * call holds it (`RoomFence.beyond.held`): the call holds it too and starts again.
 */
export class BeyondNotHeld extends Error {
	constructor(readonly real: string) {
		super("A file call must hold this path before it opens it.");
	}
}

export class RoomFilesError extends Error {
	readonly code: string;

	constructor(code: string, message: string) {
		super(message);
		this.name = "PersistentRoomWorkspaceToolError";
		this.code = code;
	}
}

// What the model reads when the fence refuses. None hands the person a command, a step they can't take; only the own-temp line names the model's own.
export const ROOM_FOLDER_MOVED = "This room's folder was moved or replaced, so the room can't open files until the person chooses its folder again in Room settings, Folder.";
/** A stored room on a folder no room may use: home, a folder other programs run from, a closed place. Its file tools and its commands stop with this. */
export const ROOM_FOLDER_REFUSED = "This room's folder is one no room may use, such as a home folder or one other programs run from, so the room can't open files or run commands until the person chooses another folder in Room settings, Folder.";
export const outsideFence = (shown: string): string => `${shown} is outside this room's folder and the folders allowed for it, so this room can't open it. Tell the person.`;
/** The write and edit tools add what the model does next (readOnlyNextLine in room-box/card-text.ts), since that depends on who can answer. */
export const readOnlyFolder = (shown: string): string => `${shown} is in a folder this room can only read, so it can't change it.`;
export const linkRefused = (shown: string): string => `${shown} goes through a link, and this room doesn't follow links. Tell the person.`;
export const closedRefusal = (shown: string): string => `${shown} looks like a secret file or the app's own data, so rooms don't open it. Tell the person; they can open it themselves.`;
/** A path in the running answer's own temp for commands (`RoomFence.ownTemp`): the person has nothing there to open, and no folder they pick opens it. */
export const ownTempRefusal = (shown: string): string => `${shown} is in this answer's temporary folder, which only commands can open. Open it with a command, or write the file into the room's folder instead; never call ${ASK_FOR_FOLDER_TOOL_NAME} for it.`;
/** A path in the app's skills folder no folder of a skill that is on opens for this access: no room changes a skill's folder, and each reads only its own skills'. */
export const skillsFolderRefusal = (shown: string): string => `${shown} is in the app's skills folder. A room can't change a skill's folder, and reads only the folders of the skills that are on in it, which read_skill gives; write into the room's folder instead.`;
export const neverChanged = (shown: string): string => `${shown} can be read but not changed by rooms, because changing it can run code later. Tell the person.`;
// The room's own files on a shared server (roomFilesFence): what the model reads when a path isn't one plain name there.
export const FILES_PATHS_RELATIVE = "Paths are relative to this room's files; absolute paths and ~ don't open here. Use the file's name, for example notes-plan.md.";
export const FILES_NO_FOLDERS = "This room's files have no folders yet: use a plain name, for example notes-plan.md.";
export const filesDotName = (shown: string): string => `${shown} starts with a dot: names like that are the app's own in this room's files, so rooms don't open them.`;
export const FILES_UNAVAILABLE = "This room's files can't be opened right now. Tell the person.";

export function normalizeSlashes(value: string): string {
	return value.replace(/\\/g, "/");
}

export function splitParts(value: string): string[] {
	return normalizeSlashes(value).split("/").filter((segment) => segment.length > 0 && segment !== ".");
}

/** Exact, by the disk's own spelling: a case variant on a disk that tells case apart is another folder. */
export function under(candidate: string, folder: string): boolean {
	const relative = path.relative(folder, candidate);
	return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

/**
 * The one rule for whether a place covers a target: the target is the place or
 * inside it, and the place's access is at least the one asked. A place that can
 * be changed covers reading too. The Also allowed list, the fence and the saved
 * cards all judge coverage with this.
 */
export function coveringRoot<T extends { path: string; access: FenceAccess }>(target: string, access: FenceAccess, roots: readonly T[]): T | undefined {
	return roots.find((root) => under(target, root.path) && (root.access === "write" || access === "read"));
}

function safeRealpath(input: string): string | null {
	try {
		return fs.realpathSync.native(input);
	} catch {
		return null;
	}
}

function escapeRegex(value: string): string {
	return value.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
}

export function globToRegExp(glob: string): RegExp {
	const normalized = normalizeSlashes(glob.trim());
	let source = "";
	for (let i = 0; i < normalized.length; i += 1) {
		const char = normalized[i];
		if (char === "*") {
			const next = normalized[i + 1];
			const afterNext = normalized[i + 2];
			if (next === "*") {
				if (afterNext === "/") {
					source += "(?:.*/)?";
					i += 2;
				} else {
					source += ".*";
					i += 1;
				}
			} else {
				source += "[^/]*";
			}
		} else if (char === "?") {
			source += "[^/]";
		} else {
			source += escapeRegex(char);
		}
	}
	return new RegExp(`^${source}$`);
}

const globRegExps = new Map<string, RegExp>();

export function matchesGlob(value: string, glob: string): boolean {
	let regex = globRegExps.get(glob);
	if (!regex) {
		regex = globToRegExp(glob);
		globRegExps.set(glob, regex);
	}
	return regex.test(normalizeSlashes(value));
}

// Case-insensitive disks open `.ENV` as `.env` and `ſ` as `s`; casing up then
// down reaches both, plain lowercasing misses `ſ`. Windows also drops trailing
// dots and spaces and opens `name:stream`.
export function foldPart(segment: string): string {
	const folded = segment.toUpperCase().toLowerCase();
	return process.platform === "win32" ? folded.replace(/:.*$/, "").replace(/[. ]+$/, "") : folded;
}

const SECRET_FILENAME_TEMPLATES: ReadonlySet<string> = new Set(PERSISTENT_ROOM_SECRET_FILENAME_TEMPLATES);
// `.mcp.json` is on the read-only list: it opens for reading and never for changing.
const SECRET_FILENAME_GLOBS = PERSISTENT_ROOM_DEFAULT_DENY_FILENAME_GLOBS.filter((glob) => !(PERSISTENT_ROOM_READ_ONLY_PATHS as readonly string[]).includes(glob));
const APP_STATE_SEGMENTS: ReadonlySet<string> = new Set(PERSISTENT_ROOM_APP_STATE_SEGMENTS);

function isSecretFilename(name: string, globs: readonly string[]): boolean {
	const folded = foldPart(name);
	return !SECRET_FILENAME_TEMPLATES.has(folded) && globs.some((glob) => matchesGlob(folded, glob.toLowerCase()));
}

// An entry's `**` parts split it into runs of parts that must follow each other in the path.
function pathRuns(entry: string): string[][] {
	const runs: string[][] = [[]];
	for (const part of entry.split("/")) {
		if (part === "**") runs.push([]);
		else runs[runs.length - 1].push(foldPart(part));
	}
	return runs.filter((run) => run.length > 0);
}

function runAt(run: readonly string[], parts: readonly string[], at: number): boolean {
	for (let offset = 0; offset < run.length; offset += 1) if (parts[at + offset] !== run[offset]) return false;
	return true;
}

// The earliest place for each run leaves the most room for the next, so one
// pass decides, however many parts the path has.
function runsIn(runs: readonly (readonly string[])[], parts: readonly string[]): boolean {
	let at = 0;
	for (const run of runs) {
		while (at + run.length <= parts.length && !runAt(run, parts, at)) at += 1;
		if (at + run.length > parts.length) return false;
		at += run.length;
	}
	return true;
}

const READ_ONLY_RUNS = [...PERSISTENT_ROOM_READ_ONLY_PATHS, ...PERSISTENT_ROOM_HOME_CLOSED_PATHS].map(pathRuns);
// A room that asks nothing changes what its commands can, but these names: the
// list the Mac's box closes to its file program too. `.mcp.json` reads, as the
// connector settings it is; the app's own names are closed by the floor before
// this is asked.
const READ_ONLY_ASKING_NOTHING = CLOSED_TO_WRITES_ASKING_NOTHING.map(pathRuns);

/** The person's keys a fence keeps closed: secret files by name, and the places that hold logins, wherever they sit in a real path. */
export interface ClosedKeys {
	filenames: readonly string[];
	credentials: readonly string[];
	/** The credential paths as runs of parts. */
	runs: readonly (readonly string[])[][];
}

const closedKeys = (filenames: readonly string[], credentials: readonly string[]): ClosedKeys => ({ filenames, credentials, runs: credentials.map(pathRuns) });
const EVERY_KEY = closedKeys(SECRET_FILENAME_GLOBS, PERSISTENT_ROOM_DEFAULT_DENY_CREDENTIAL_PATHS);
// A room that asks nothing opens the person's keys, as its commands can. The
// connector settings stay closed as the app's own, and so do running programs'
// details, the server's among them.
const KEYS_ASKING_NOTHING = closedKeys([], [".config/mcp/mcp.json", "proc/**/environ", "proc/**/cmdline"] satisfies (typeof PERSISTENT_ROOM_DEFAULT_DENY_CREDENTIAL_PATHS)[number][]);
// A room's own files on a shared server close no key by name: what people add there opens, a key's name too, and only the files' own refusal decides.
const NO_KEYS = closedKeys([], []);

function credentialIn(parts: readonly string[], keys: ClosedKeys): boolean {
	return keys.runs.some((runs) => runsIn(runs, parts));
}

const deckNamesIn = (keys: ClosedKeys): boolean => PERSISTENT_ROOM_ZIP_OPENS_FILENAME_GLOBS.some((glob) => keys.filenames.includes(glob));

/** Whether a Keynote deck's name is a key's in this place: only then must a file of that name hold a deck to open. */
export function deckNamesClosed(fence: RoomFence, root: FenceRoot): boolean {
	return deckNamesIn(keysAt(fence.keys, root));
}

// The home folder's entries where the person sees them and where each really
// lives, so a dotfiles project linked into the home folder stays closed too.
function homeClosedPlaces(): string[][] {
	const home = os.homedir();
	const homeReal = safeRealpath(home) ?? home;
	return PERSISTENT_ROOM_HOME_CLOSED_PATHS.flatMap((entry) => [path.join(home, entry), path.join(homeReal, entry), safeRealpath(path.join(home, entry))])
		.filter((place): place is string => Boolean(place))
		.map((place) => splitParts(place).map(foldPart));
}

function homeClosed(real: string): boolean {
	const parts = splitParts(real).map(foldPart);
	return homeClosedPlaces().some((place) => place.length <= parts.length && place.every((part, index) => parts[index] === part));
}

const ZIP_LOCAL_HEADER = Buffer.from([0x50, 0x4b, 0x03, 0x04]);

// A Keynote deck is a folder, or a regular file that starts as a zip does. It
// opens only a regular file, reads at most four bytes, and any error keeps the
// file closed. On Windows a name with a stream or a trailing dot or space stays closed.
function keynoteDeck(realPath: string): boolean {
	if (process.platform === "win32" && /:|[. ]$/.test(path.basename(realPath))) return false;
	let fd: number | undefined;
	try {
		const stat = fs.statSync(realPath);
		if (stat.isDirectory()) return true;
		if (!stat.isFile()) return false;
		// The file can change between the two calls, so the open never waits or takes a terminal, and fstat checks again.
		fd = fs.openSync(realPath, fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK ?? 0) | (fs.constants.O_NOCTTY ?? 0));
		if (!fs.fstatSync(fd).isFile()) return false;
		const head = Buffer.alloc(ZIP_LOCAL_HEADER.length);
		return fs.readSync(fd, head, 0, head.length, 0) === head.length && head.equals(ZIP_LOCAL_HEADER);
	} catch {
		return false;
	} finally {
		if (fd !== undefined) {
			try {
				fs.closeSync(fd);
			} catch {}
		}
	}
}

/** One pattern of parts, `*` within a part and `**` for any run, matched at `at` with anything below the match covered too. */
function patternAt(pattern: readonly string[], parts: readonly string[], at: number): boolean {
	if (pattern.length === 0) return true;
	const [first, ...rest] = pattern;
	if (first === "**") {
		for (let next = at; next <= parts.length; next += 1) if (patternAt(rest, parts, next)) return true;
		return false;
	}
	return at < parts.length && matchesGlob(parts[at], foldPart(first)) && patternAt(rest, parts, at + 1);
}

/**
 * The names the box never lets a command change: anywhere below a place that
 * can be changed, from its arrays, and git's names at the top of `root`, read
 * from the disk at each call by `closedAtTop`, as the box closes them there.
 */
function neverWritableBelow(below: readonly string[], root: string): boolean {
	const anyDepth = [...NEVER_WRITABLE_FILES, ...NEVER_WRITABLE_FOLDERS, ...NEVER_WRITABLE_GLOBS, ...GIT_CLOSED].map((name) => name.split("/"));
	if (anyDepth.some((pattern) => below.some((_part, at) => patternAt(pattern, below, at)))) return true;
	return below.length > 0 && closedAtTop(root).some((name) => below[0] === foldPart(name));
}

/**
 * Whether a write would make or replace a `.git` entry, as the box refuses a
 * command: a file named `.git` says which folder git takes its settings and
 * hooks from, and a new `.git` folder makes a repository git runs from. What
 * is inside an existing `.git` stays the other checks' to decide.
 */
function makesGitEntry(real: string, root: FenceRoot, below: readonly string[]): boolean {
	const parts = splitParts(path.relative(root.path, real));
	return below.some((part, index) => part === ".git" && (index === below.length - 1 || !fs.statSync(path.join(root.path, ...parts.slice(0, index + 1)), { throwIfNoEntry: false })?.isDirectory()));
}

/** The stored policy's own extra closed names. Its copies of the defaults are the fence's to decide, so a policy that still lists `.git` reads it. */
function storedExtras(policy: PersistentRoomCapabilityPolicy): { segments: Set<string>; globs: string[] } {
	const defaultSegments = new Set<string>(PERSISTENT_ROOM_DEFAULT_DENY_SEGMENTS);
	const defaultGlobs = new Set<string>(PERSISTENT_ROOM_DEFAULT_DENY_FILENAME_GLOBS);
	return {
		segments: new Set(policy.denySegments.filter((segment) => !defaultSegments.has(segment)).map(foldPart)),
		globs: policy.denyFilenameGlobs.filter((glob) => !defaultGlobs.has(glob)),
	};
}

export type FenceRefusal = "closed" | "never-changed";

/** The keys closed in a place: what is inside a place in the app's data keeps every key closed, as the app's own. */
function keysAt(keys: ClosedKeys, root: FenceRoot): ClosedKeys {
	return root.inData ? EVERY_KEY : keys;
}

/** One call's fence: built at the call, never kept. */
export interface RoomFence {
	/** A folder the person chose, with the desktop's rules; or the room's own files on a shared server: one plain name each, no folders. */
	kind: "folder" | "files";
	/** The room's folder, or null when it was moved or replaced since it was chosen, or is refused. */
	room: FenceRoot | null;
	/** The room's folder is there, but it is one no room may use, by the Also allowed list's own rule. */
	refused: boolean;
	/** The room's folder, its Also allowed folders and the running answer's own, in that order. */
	roots(): FenceRoot[];
	/** Places the room may read beside its folders, as its skills' folders: worked out only when asked for. */
	dataReads(): FenceRoot[];
	/** The app's skills folder, by its real path, when the caller gave it: a closed path in it says so (`closedLine`). */
	skillsFolder?: string;
	/** The running answer's temp for its commands, by its real path, when the caller gave it: a closed path in it says so (`closedLine`). */
	ownTemp?: string;
	/**
	 * What the fence keeps closed at this real path, inside `root`. `deck` says
	 * whether a Keynote deck's name holds a deck, when the box has looked; without
	 * it the file's first bytes are read here.
	 */
	refusal(real: string, root: FenceRoot, access: FenceAccess, deck?: boolean): FenceRefusal | null;
	/** The names closed for reading below a place, as runs of parts with `*` and `**`: what the box closes at the open. */
	closedBelow(): string[];
	/**
	 * In a room that asks nothing (Auto with protection off): what a path none of
	 * its folders covers opens for, the room's own folder's access; null
	 * elsewhere. With `held`, only a path the call holds opens.
	 */
	beyond: { access: FenceAccess; held?: (real: string) => boolean } | null;
	/** A room that asks nothing (Auto with protection off), never on a shared server: its file tools change what its commands can, but CLOSED_TO_WRITES_ASKING_NOTHING. The Mac's box takes its rules from this. */
	asksNothing: boolean;
	/** The person's keys this call keeps closed: in a room that asks nothing, only the connector settings and running programs' details. */
	keys: ClosedKeys;
}

/** The room's folder as it was chosen: its real path now must still hash to the one the person picked, and a room may use it, judged at each call, since the rule can be newer than the room. */
function roomFolder(policy: PersistentRoomCapabilityPolicy, against?: JudgedAgainst): string | "moved" | "refused" {
	const root = policy.roots[0];
	if (!root) return "moved";
	const real = safeRealpath(root.realpath) ?? safeRealpath(root.path);
	if (!real) return "moved";
	try {
		if (!fs.statSync(real).isDirectory()) return "moved";
	} catch {
		return "moved";
	}
	const hash = hashPersistentRoomPath(real);
	if (hash.algorithm !== root.pathHash.algorithm || hash.value !== root.pathHash.value) return "moved";
	return roomFolderGrantable(real, against) ? real : "refused";
}

/** A place `dataReads` gives, by its real path: `shared` for a shared-folder skill's folder. */
export interface DataRead {
	path: string;
	shared?: true;
}

/**
 * `dataReads` gives the real paths of what the room may read beside its
 * folders: its skills' folders, and the turn's long output. It is the caller's,
 * so this module stays out of the skills library's imports, which reach the
 * server's start-up. `answer` is the running answer's own folders, judged as
 * the list's are. `against` is for a pass over many rooms (`judgedAgainst`);
 * without it each judgement reads the disk itself.
 */
export function roomFence(policy: PersistentRoomCapabilityPolicy, dataReads: (roomId: string) => readonly DataRead[], answer?: AnswerFolders, asksNothing = false, skillsFolder?: string, against?: JudgedAgainst): RoomFence {
	const folder = roomFolder(policy, against);
	const names = persistentRoomWorkspaceToolNamesForPolicy(policy);
	const room: FenceRoot | null = folder !== "moved" && folder !== "refused" ? { path: folder, access: names.includes("write") || names.includes("edit") ? "write" : "read", room: true } : null;
	const extras = storedExtras(policy);
	let listed: FenceRoot[] | undefined;
	let inData: FenceRoot[] | undefined;
	// Read once per fence: a walk asks at each entry.
	let appData: string[] | undefined;
	// Never on a shared server, whoever asks: there a room's files stay inside its own folders, and keys stay closed.
	const free = asksNothing && room !== null && !isSharedServer();
	const keys = free ? KEYS_ASKING_NOTHING : EVERY_KEY;
	return {
		kind: "folder",
		room,
		refused: folder === "refused",
		...(skillsFolder ? { skillsFolder } : {}),
		beyond: free && room ? { access: room.access } : null,
		asksNothing: free,
		keys,
		roots: () => {
			if (!room) return [];
			// The list is the box's own, judged by the box's own check against this room's folder.
			const saved = readAlsoAllowed(policy.agentId).folders;
			listed ??= soundFolders(answer?.over(saved) ?? saved, room.path, against).map((entry) => ({ path: entry.path, access: entry.access }));
			return [room, ...listed];
		},
		dataReads: () => (inData ??= room ? dataReads(policy.agentId).map((place) => ({ path: place.path, access: "read" as const, inData: true as const, ...(place.shared ? { shared: true as const } : {}) })) : []),
		closedBelow: () => [
			...PERSISTENT_ROOM_APP_STATE_SEGMENTS, ...PERSISTENT_ROOM_APP_SIBLING_GLOBS, ...keys.credentials,
			// A Keynote deck shares its name with a key: the box's program checks a deck's bytes on what it opened.
			...keys.filenames.filter((glob) => !(PERSISTENT_ROOM_ZIP_OPENS_FILENAME_GLOBS as readonly string[]).includes(glob)),
			...extras.segments, ...extras.globs,
		],
		refusal: (real, root, access, knownDeck) => {
			const below = splitParts(path.relative(root.path, real)).map(foldPart);
			// The fixed floor judges the whole real path, so a folder chosen inside `.pi` doesn't open what it
			// holds, nor a shared-folder skill's folder inside `.ssh`. A place in the app's own data, as one of
			// the person's own skills' folders, is closed by its path, so only what is inside it is. A policy's
			// own extra names close only what is inside the place, as they did before.
			const parts = root.inData && !root.shared ? below : splitParts(real).map(foldPart);
			const closedHere = keysAt(keys, root);
			// What the room's commands can change opens, but what is inside a place in the app's data; the box's own rules still close it to writes there.
			const opensRunsLater = free && !root.inData;
			const last = parts.length - 1;
			const deck = deckNamesIn(closedHere) && PERSISTENT_ROOM_ZIP_OPENS_FILENAME_GLOBS.some((glob) => parts.length > 0 && matchesGlob(parts[last], glob)) && (knownDeck ?? keynoteDeck(real));
			const secretAt = (part: string, index: number) => isSecretFilename(part, closedHere.filenames) && !(PERSISTENT_ROOM_ZIP_OPENS_FILENAME_GLOBS.some((glob) => matchesGlob(part, glob)) && (index < last || deck));
			const closed = parts.some((part, index) => APP_STATE_SEGMENTS.has(part) || secretAt(part, index) || PERSISTENT_ROOM_APP_SIBLING_GLOBS.some((glob) => matchesGlob(part, foldPart(glob))))
				|| below.some((part) => extras.segments.has(part) || isSecretFilename(part, extras.globs))
				|| credentialIn(parts, closedHere)
				|| (!opensRunsLater && homeClosed(real))
				// The app's data the closed names above don't reach, as an agent folder a developer setting moved out of it. An approved skill's folder there is the room's to read.
				|| (!root.inData && (appData ??= appDataPlaces()).some((place) => isInside(real, place)));
			if (closed) return "closed";
			if (access === "read") return null;
			const full = splitParts(real).map(foldPart);
			if (opensRunsLater) return READ_ONLY_ASKING_NOTHING.some((runs) => runsIn(runs, full)) ? "never-changed" : null;
			return READ_ONLY_RUNS.some((runs) => runsIn(runs, full)) || neverWritableBelow(below, root.path) || makesGitEntry(real, root, below) ? "never-changed" : null;
		},
	};
}

/**
 * The room's own files on a shared server: the one place its file tools open,
 * found from the room, never from a stored setting. Made when missing, so a room
 * with no upload yet can list and write. Inside it every name is open but one
 * that starts with a dot: the shelf's own marks and temporary files. Null room
 * when the folder isn't a real folder (a link put in its place).
 */
export function roomFilesFence(roomId: string): RoomFence {
	let room: FenceRoot | null = null;
	try {
		const files = persistentRoomShelfDirPath(roomId);
		fs.mkdirSync(files, { recursive: true, mode: 0o700 });
		if (fs.lstatSync(files).isDirectory()) room = { path: fs.realpathSync.native(files), access: "write", room: true };
	} catch {
		room = null;
	}
	return {
		kind: "files",
		room,
		refused: false,
		roots: () => (room ? [room] : []),
		dataReads: () => [],
		closedBelow: () => [],
		refusal: (real, root) => (splitParts(path.relative(root.path, real)).some((part) => part.startsWith(".")) ? "closed" : null),
		// Nothing outside the room's files opens on a shared server, whatever the room's settings say.
		beyond: null,
		// A room on a shared server never asks nothing: roomFence keeps it false there too.
		asksNothing: false,
		keys: NO_KEYS,
	};
}

/** A path in the room's own files: "." for the files themselves, or one plain name there, the shelf's own rule, no link. */
function filesPath(fence: RoomFence, rawPath: string): FencedPath {
	const room = fence.room;
	if (!room) throw new RoomFilesError("folder_moved", FILES_UNAVAILABLE);
	const raw = String(rawPath ?? "").trim();
	if (!raw) throw new RoomFilesError("missing_path", "A path is required.");
	if (raw.includes("\0")) throw new RoomFilesError("outside_workspace", FILES_PATHS_RELATIVE);
	if (raw.startsWith("~") || path.posix.isAbsolute(raw) || path.win32.isAbsolute(raw)) throw new RoomFilesError("outside_workspace", FILES_PATHS_RELATIVE);
	if (raw === "." || raw === "./") return { real: room.path, root: room, shown: ".", exists: true, needsDeck: false };
	if (/[\\/]/.test(raw)) throw new RoomFilesError("outside_workspace", FILES_NO_FOLDERS);
	if (raw.startsWith(".")) throw new RoomFilesError("blocked_by_policy", filesDotName(raw));
	let name: string;
	try {
		name = validateShelfFilename(raw);
	} catch (error) {
		if (error instanceof PersistentRoomShelfError) throw new RoomFilesError("invalid_name", error.message);
		throw error;
	}
	const real = path.join(room.path, name);
	let kind: fs.Stats | undefined;
	try {
		kind = fs.lstatSync(real, { throwIfNoEntry: false });
	} catch {
		kind = undefined;
	}
	if (kind?.isSymbolicLink()) throw new RoomFilesError("link", linkRefused(name));
	return { real, root: room, shown: name, exists: kind !== undefined, needsDeck: false };
}

/** A path as the model wrote it, made absolute: relative to the room's folder, `~` for the person's home. */
function absoluteInput(raw: string, roomPath: string): string {
	if (raw === "~" || raw.startsWith("~/") || raw.startsWith("~\\")) return path.join(os.homedir(), raw.slice(1));
	return path.resolve(roomPath, raw);
}

/** A path walked by the shapes module's own resolver, never the system's, so a network or device place is refused before anything touches it. */
function walkedPlace(lexical: string, chosen: readonly string[], shown: string): WalkedPlace {
	try {
		return walkPlace(lexical, chosen);
	} catch (error) {
		if (error instanceof PlaceRefused) throw error.why === "links" ? new RoomFilesError("link", linkRefused(shown)) : new RoomFilesError("network_place", placeRefused(shown));
		throw error;
	}
}

/** Windows' long paths, the longest of the three platforms. */
const LONGEST_PATH = 32_767;

/** A place the fence resolved: where it really is, which place opened it, and how the tools show it. */
export interface FencedPath {
	real: string;
	root: FenceRoot;
	/** Relative to the room's folder inside it; the real path elsewhere. */
	shown: string;
	/** Whether something is at this path now. */
	exists: boolean;
	/** A Keynote deck's name the box must find a deck at, when it opens the file. */
	needsDeck: boolean;
}

export function showPath(real: string, root: FenceRoot): string {
	if (!root.room) return real;
	const relative = normalizeSlashes(path.relative(root.path, real));
	return relative === "" ? "." : relative;
}

/**
 * A room that asks nothing opens a path none of its folders covers from its
 * disk's top, so the closed names judge the whole real path. Only what the
 * call holds opens, and Can change files off keeps it to reading.
 */
function beyondRoot(fence: RoomFence, real: string, access: FenceAccess): FenceRoot | undefined {
	const root = fence.beyond ? coveringRoot(real, access, [{ path: path.parse(real).root, access: fence.beyond.access, beyond: true as const }]) : undefined;
	if (root && fence.beyond?.held && !fence.beyond.held(real)) throw new BeyondNotHeld(real);
	return root;
}

/** Whether a room that asks nothing opens this real path for reading beyond its folders, its closed names judged there. */
function opensBeyond(fence: RoomFence, real: string): boolean {
	const root = fence.beyond ? coveringRoot(real, "read", [{ path: path.parse(real).root, access: fence.beyond.access, beyond: true as const }]) : undefined;
	return root !== undefined && fence.refusal(real, root, "read") !== "closed";
}

/**
 * What the model reads for a closed path: in the running answer's own temp,
 * the temp sentence; in the app's skills folder, outside what a skill that is
 * on opens for this access, the skills sentence, since the person has nothing
 * there to open; otherwise the secret-file one, so a key inside a skill that
 * is on keeps it. Only the words differ: all refuse.
 */
function closedLine(fence: RoomFence, real: string, access: FenceAccess, shown: string): string {
	if (fence.ownTemp !== undefined && under(real, fence.ownTemp)) return ownTempRefusal(shown);
	const inSkills = fence.skillsFolder !== undefined && under(real, fence.skillsFolder) && !coveringRoot(real, access, fence.dataReads());
	return inSkills ? skillsFolderRefusal(shown) : closedRefusal(shown);
}

/**
 * The one way a tool's path enters: made absolute, resolved to the disk's own
 * spelling, inside a place that opens it for this access, no link on the way
 * (in a room that asks nothing, but one that leads out of its folders),
 * and no closed name. Refuses with a line the model can pass on. In the box a
 * deck's bytes are the program's to check on what it opened, so `decksInBox`
 * opens nothing here.
 */
export function fencePath(fence: RoomFence, rawPath: string, access: FenceAccess, { decksInBox = false }: { decksInBox?: boolean } = {}): FencedPath {
	if (fence.kind === "files") return filesPath(fence, rawPath);
	if (fence.refused) throw new RoomFilesError("folder_refused", ROOM_FOLDER_REFUSED);
	if (!fence.room) throw new RoomFilesError("folder_moved", ROOM_FOLDER_MOVED);
	const raw = String(rawPath ?? "").trim();
	if (!raw) throw new RoomFilesError("missing_path", "A path is required.");
	const shownRaw = raw;
	if (raw.includes("\0") || /^~[^/\\]/.test(raw)) throw new RoomFilesError("outside_workspace", outsideFence(shownRaw));
	// The room's own folder is the person's choice, so a room on a share keeps working: only the names below it are judged.
	const chosen = [fence.room.path];
	if (refusedShape(raw, chosen)) throw new RoomFilesError("network_place", placeRefused(shownRaw));
	const lexical = absoluteInput(raw, fence.room.path);
	// Longer than any of our platforms lets a path be, so it names nothing; the walks below are
	// slower with each part, and they run on the server's one thread.
	if (lexical.length > LONGEST_PATH) throw new RoomFilesError("path_too_long", "That path is longer than any file's path can be.");
	const { real, linkPlaces } = walkedPlace(lexical, chosen, shownRaw);
	let roots = fence.roots();
	// Approved skills open for reading only, so they are looked up only for a read the rest doesn't cover. In a room
	// that asks nothing, a read the place beyond opens is taken there, key files included, as its commands read them:
	// the skills' folders serve only what it keeps closed, the app's own data.
	if (access === "read" && !coveringRoot(real, access, roots) && !opensBeyond(fence, real)) roots = [...roots, ...fence.dataReads()];
	// A folder the person set to Can read stays read-only for a room that asks nothing too.
	const root = coveringRoot(real, access, roots) ?? (access === "write" && coveringRoot(real, "read", roots) ? undefined : beyondRoot(fence, real, access));
	// A link sitting in a place the fence opens could be turned elsewhere; one above it, as macOS's `/var`, only names the same folder.
	// One that leads a room that asks nothing out of its folders is followed: the server opens the real path it found.
	if (!root?.beyond && linkPlaces.some((place) => roots.some((open) => under(place, open.path)))) throw new RoomFilesError("link", linkRefused(shownRaw));
	if (!root) {
		// A key or the app's data says it's closed wherever it is, so the model doesn't ask for the folder around it.
		if (fence.refusal(real, { path: path.parse(real).root, access: "read" }, "read") === "closed") throw new RoomFilesError("blocked_by_policy", closedLine(fence, real, access, shownRaw));
		if (access === "write" && coveringRoot(real, "read", roots)) throw new RoomFilesError("read_only_folder", readOnlyFolder(shownRaw));
		throw new RoomFilesError("outside_workspace", outsideFence(shownRaw));
	}
	const deckName = deckNamesClosed(fence, root) && PERSISTENT_ROOM_ZIP_OPENS_FILENAME_GLOBS.some((glob) => matchesGlob(foldPart(path.basename(real)), glob));
	let kind: fs.Stats | undefined;
	try {
		kind = fs.statSync(real, { throwIfNoEntry: false });
	} catch {
		// A folder on the way the person can't open: as good as not there, and the open says so plainly.
		kind = undefined;
	}
	// A deck saved as a folder is one by its kind; a file is one by its bytes, which only the box reads there. The server opens what is beyond the room's folders, so it reads them here.
	const inBox = decksInBox && !root.beyond;
	const needsDeck = inBox && deckName && !kind?.isDirectory();
	const refusal = fence.refusal(real, root, access, inBox && deckName ? true : undefined);
	if (refusal === "closed") throw new RoomFilesError("blocked_by_policy", closedLine(fence, real, access, shownRaw));
	if (refusal === "never-changed") throw new RoomFilesError("blocked_by_policy", neverChanged(shownRaw));
	return { real, root, shown: showPath(real, root), exists: kind !== undefined, needsDeck };
}
