import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { PlaceRefused, placeRefused, refusedShape, type WalkedPlace, walkPlace } from "./path-shapes.js";
import type { PersistentRoomCapabilityPolicy } from "./persistent-room-workspace-policy.js";
import { hashPersistentRoomPath, PERSISTENT_ROOM_APP_SIBLING_GLOBS, PERSISTENT_ROOM_APP_STATE_SEGMENTS, PERSISTENT_ROOM_DEFAULT_DENY_CREDENTIAL_PATHS, PERSISTENT_ROOM_DEFAULT_DENY_FILENAME_GLOBS, PERSISTENT_ROOM_DEFAULT_DENY_SEGMENTS, PERSISTENT_ROOM_HOME_CLOSED_PATHS, PERSISTENT_ROOM_READ_ONLY_PATHS, PERSISTENT_ROOM_SECRET_FILENAME_TEMPLATES, PERSISTENT_ROOM_ZIP_OPENS_FILENAME_GLOBS } from "./persistent-room-workspace-policy.js";
import { persistentRoomWorkspaceToolNamesForPolicy } from "./persistent-room-tool-policy.js";
import { readAlsoAllowed } from "./room-box/also-allowed.js";
import { closedAtTop, GIT_CLOSED, NEVER_WRITABLE_FILES, NEVER_WRITABLE_FOLDERS, NEVER_WRITABLE_GLOBS } from "./room-box/box-rules.js";
import { roomFolderGrantable, soundFolders } from "./room-box/folder-offer.js";
import type { AnswerFolders } from "./room-box/folder-question.js";

/**
 * The fence every room's file tools stop at: the room's folder, the folders on
 * its Also allowed list and those the running answer was given, and its
 * approved skills' folders for reading. Read
 * fresh at each call, so a change to the list reaches the next one. Inside it,
 * secrets, keys and the app's data stay closed, and the names other programs
 * run from can be read but never changed.
 */

export type FenceAccess = "read" | "write";

/** A place the fence opens, by its real path. */
export interface FenceRoot {
	path: string;
	access: FenceAccess;
	/** The room's own folder: paths there show relative to it. */
	room?: true;
	/** A place in the app's own data the room may read, as an approved skill's folder: only what is inside it is checked by name. */
	inData?: true;
}

export class RoomFilesError extends Error {
	readonly code: string;

	constructor(code: string, message: string) {
		super(message);
		this.name = "PersistentRoomWorkspaceToolError";
		this.code = code;
	}
}

// What the model reads when the fence refuses. None offers a command: no refusal hands the person a step they can't take.
export const ROOM_FOLDER_MOVED = "This room's folder was moved or replaced, so the room can't open files until the person chooses its folder again in Room settings, Folder.";
/** A stored room on a folder no room may use: home, a folder other programs run from, a closed place. Its file tools and its commands stop with this. */
export const ROOM_FOLDER_REFUSED = "This room's folder is one no room may use, such as a home folder or one other programs run from, so the room can't open files or run commands until the person chooses another folder in Room settings, Folder.";
export const outsideFence = (shown: string): string => `${shown} is outside this room's folder and the folders allowed for it, so this room can't open it. Tell the person.`;
/** The write and edit tools add what the model does next (readOnlyNextLine in room-box/card-text.ts), since that depends on who can answer. */
export const readOnlyFolder = (shown: string): string => `${shown} is in a folder this room can only read, so it can't change it.`;
export const linkRefused = (shown: string): string => `${shown} goes through a link, and this room doesn't follow links. Tell the person.`;
export const closedRefusal = (shown: string): string => `${shown} looks like a secret file or the app's own data, so rooms don't open it. Tell the person; they can open it themselves.`;
export const neverChanged = (shown: string): string => `${shown} can be read but not changed by rooms, because changing it can run code later. Tell the person.`;

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
export const SECRET_FILENAME_GLOBS = PERSISTENT_ROOM_DEFAULT_DENY_FILENAME_GLOBS.filter((glob) => !(PERSISTENT_ROOM_READ_ONLY_PATHS as readonly string[]).includes(glob));
const APP_STATE_SEGMENTS: ReadonlySet<string> = new Set(PERSISTENT_ROOM_APP_STATE_SEGMENTS);

export function isSecretFilename(name: string, globs: readonly string[] = SECRET_FILENAME_GLOBS): boolean {
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

const CREDENTIAL_RUNS = PERSISTENT_ROOM_DEFAULT_DENY_CREDENTIAL_PATHS.map(pathRuns);
const READ_ONLY_RUNS = [...PERSISTENT_ROOM_READ_ONLY_PATHS, ...PERSISTENT_ROOM_HOME_CLOSED_PATHS].map(pathRuns);

/** The person's keys and logins, wherever they sit in a real path. */
function credentialIn(parts: readonly string[]): boolean {
	return CREDENTIAL_RUNS.some((runs) => runsIn(runs, parts));
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

/** One call's fence: built at the call, never kept. */
export interface RoomFence {
	/** The room's folder, or null when it was moved or replaced since it was chosen, or is refused. */
	room: FenceRoot | null;
	/** The room's folder is there, but it is one no room may use, by the Also allowed list's own rule. */
	refused: boolean;
	/** The room's folder, its Also allowed folders and the running answer's own, in that order. */
	roots(): FenceRoot[];
	/** Places in the app's data the room may read, as approved skills' folders: worked out only when asked for. */
	dataReads(): FenceRoot[];
	/**
	 * What the fence keeps closed at this real path, inside `root`. `deck` says
	 * whether a Keynote deck's name holds a deck, when the box has looked; without
	 * it the file's first bytes are read here.
	 */
	refusal(real: string, root: FenceRoot, access: FenceAccess, deck?: boolean): FenceRefusal | null;
	/** The names closed for reading below a place, as runs of parts with `*` and `**`: what the box closes at the open. */
	closedBelow(): string[];
}

/** The room's folder as it was chosen: its real path now must still hash to the one the person picked, and a room may use it, judged at each call, since the rule can be newer than the room. */
function roomFolder(policy: PersistentRoomCapabilityPolicy): string | "moved" | "refused" {
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
	return roomFolderGrantable(real) ? real : "refused";
}

/**
 * `dataReads` gives the real paths of what the room may read in the app's data:
 * its approved skills' folders, and the turn's long output. It is the caller's,
 * so this module stays out of the skills library's imports, which reach the
 * server's start-up. `answer` is the running answer's own folders, judged as
 * the list's are.
 */
export function roomFence(policy: PersistentRoomCapabilityPolicy, dataReads: (roomId: string) => string[], answer?: AnswerFolders): RoomFence {
	const folder = roomFolder(policy);
	const names = persistentRoomWorkspaceToolNamesForPolicy(policy);
	const room: FenceRoot | null = folder !== "moved" && folder !== "refused" ? { path: folder, access: names.includes("write") || names.includes("edit") ? "write" : "read", room: true } : null;
	const extras = storedExtras(policy);
	let listed: FenceRoot[] | undefined;
	let inData: FenceRoot[] | undefined;
	return {
		room,
		refused: folder === "refused",
		roots: () => {
			if (!room) return [];
			// The list is the box's own, judged by the box's own check against this room's folder.
			const saved = readAlsoAllowed(policy.agentId).folders;
			listed ??= soundFolders(answer?.over(saved) ?? saved, room.path).map((entry) => ({ path: entry.path, access: entry.access }));
			return [room, ...listed];
		},
		dataReads: () => (inData ??= room ? dataReads(policy.agentId).map((place) => ({ path: place, access: "read" as const, inData: true as const })) : []),
		closedBelow: () => [
			...PERSISTENT_ROOM_APP_STATE_SEGMENTS, ...PERSISTENT_ROOM_APP_SIBLING_GLOBS, ...PERSISTENT_ROOM_DEFAULT_DENY_CREDENTIAL_PATHS,
			// A Keynote deck shares its name with a key: the box's program checks a deck's bytes on what it opened.
			...SECRET_FILENAME_GLOBS.filter((glob) => !(PERSISTENT_ROOM_ZIP_OPENS_FILENAME_GLOBS as readonly string[]).includes(glob)),
			...extras.segments, ...extras.globs,
		],
		refusal: (real, root, access, knownDeck) => {
			const below = splitParts(path.relative(root.path, real)).map(foldPart);
			// The fixed floor judges the whole real path, so a folder chosen inside `.pi` doesn't open what it
			// holds. A place in the app's own data, as an approved skill's folder, is closed by its path, so only
			// what is inside it is. A policy's own extra names close only what is inside the place, as they did before.
			const parts = root.inData ? below : splitParts(real).map(foldPart);
			const last = parts.length - 1;
			const deck = PERSISTENT_ROOM_ZIP_OPENS_FILENAME_GLOBS.some((glob) => parts.length > 0 && matchesGlob(parts[last], glob)) && (knownDeck ?? keynoteDeck(real));
			const secretAt = (part: string, index: number) => isSecretFilename(part) && !(PERSISTENT_ROOM_ZIP_OPENS_FILENAME_GLOBS.some((glob) => matchesGlob(part, glob)) && (index < last || deck));
			const closed = parts.some((part, index) => APP_STATE_SEGMENTS.has(part) || secretAt(part, index) || PERSISTENT_ROOM_APP_SIBLING_GLOBS.some((glob) => matchesGlob(part, foldPart(glob))))
				|| below.some((part) => extras.segments.has(part) || isSecretFilename(part, extras.globs))
				|| credentialIn(parts)
				|| homeClosed(real);
			if (closed) return "closed";
			if (access === "read") return null;
			const full = splitParts(real).map(foldPart);
			return READ_ONLY_RUNS.some((runs) => runsIn(runs, full)) || neverWritableBelow(below, root.path) || makesGitEntry(real, root, below) ? "never-changed" : null;
		},
	};
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
 * The one way a tool's path enters: made absolute, resolved to the disk's own
 * spelling, inside a place that opens it for this access, no link on the way,
 * and no closed name. Refuses with a line the model can pass on. In the box a
 * deck's bytes are the program's to check on what it opened, so `decksInBox`
 * opens nothing here.
 */
export function fencePath(fence: RoomFence, rawPath: string, access: FenceAccess, { decksInBox = false }: { decksInBox?: boolean } = {}): FencedPath {
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
	// Approved skills open for reading only, so they are looked up only for a read the rest doesn't cover.
	if (access === "read" && !coveringRoot(real, access, roots)) roots = [...roots, ...fence.dataReads()];
	// A link sitting in a place the fence opens could be turned elsewhere; one above it, as macOS's `/var`, only names the same folder.
	if (linkPlaces.some((place) => roots.some((root) => under(place, root.path)))) throw new RoomFilesError("link", linkRefused(shownRaw));
	const root = coveringRoot(real, access, roots);
	if (!root) {
		// A key or the app's data says it's closed wherever it is, so the model doesn't ask for the folder around it.
		if (fence.refusal(real, { path: path.parse(real).root, access: "read" }, "read") === "closed") throw new RoomFilesError("blocked_by_policy", closedRefusal(shownRaw));
		if (access === "write" && coveringRoot(real, "read", roots)) throw new RoomFilesError("read_only_folder", readOnlyFolder(shownRaw));
		throw new RoomFilesError("outside_workspace", outsideFence(shownRaw));
	}
	const deckName = PERSISTENT_ROOM_ZIP_OPENS_FILENAME_GLOBS.some((glob) => matchesGlob(foldPart(path.basename(real)), glob));
	let kind: fs.Stats | undefined;
	try {
		kind = fs.statSync(real, { throwIfNoEntry: false });
	} catch {
		// A folder on the way the person can't open: as good as not there, and the open says so plainly.
		kind = undefined;
	}
	// A deck saved as a folder is one by its kind; a file is one by its bytes, which only the box reads there.
	const needsDeck = decksInBox && deckName && !kind?.isDirectory();
	const refusal = fence.refusal(real, root, access, decksInBox && deckName ? true : undefined);
	if (refusal === "closed") throw new RoomFilesError("blocked_by_policy", closedRefusal(shownRaw));
	if (refusal === "never-changed") throw new RoomFilesError("blocked_by_policy", neverChanged(shownRaw));
	return { real, root, shown: showPath(real, root), exists: kind !== undefined, needsDeck };
}
