import fs from "node:fs";
import path from "node:path";

import { realPlace, type WalkOptions } from "../path-shapes.js";
import type { AlsoAllowedFolder } from "./also-allowed.js";
import { appDataPlaces, closedForReading, foldedName, homeFolders, isInside, neverOpened, realPathOf } from "./box-closed.js";
import { NEVER_WRITABLE_FILES, NEVER_WRITABLE_FOLDERS } from "./box-rules.js";
import { type FolderRefusal, pathHoldsHidden } from "./card-text.js";
import { keptWindowsAnswer, windowsAnswer, windowsPlaces, windowsRefuses, withRealPaths, type WindowsPlaces } from "./windows/windows-places.js";

type Access = AlsoAllowedFolder["access"];

/**
 * How a folder is judged where nothing may be followed or started for it. Both
 * off by default. `links: "refuse"`: a link on the way refuses the folder, and a
 * link inside it counts as there without being followed. `beforeClick`: no
 * program starts, so on Windows any folder before Windows' answer was read is
 * refused; and a folder in a home's Library is only ever chosen in the window.
 */
export interface GrantOptions extends WalkOptions {
	beforeClick?: boolean;
}

// A yes for writing here would hand a command what other tools run, whichever folder it sits in: the box's own patterns only reach below a root.
const NEVER_OFFERED_FOR_WRITING = [...NEVER_WRITABLE_FILES, ...NEVER_WRITABLE_FOLDERS, ".git", ".config/git"].map(foldedName);

function namesClosedPlace(target: string): boolean {
	const folded = `${foldedName(target)}/`;
	return NEVER_OFFERED_FOR_WRITING.some((name) => folded.includes(`/${name}/`));
}

// Each home's own settings and folders other tools run, as a closed name names them.
export const HOME_TOOL_PLACES = [...NEVER_WRITABLE_FILES, ...NEVER_WRITABLE_FOLDERS, ".config/git"];

/**
 * Places whose files other programs run, by their real paths: the search path,
 * the places apps are launched from, and each home's tool settings and folders,
 * wherever a link takes them, as `~/.cursor` kept in a folder of Documents.
 */
function programFolders(): string[] {
	const fromPath = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
	const standard = ["/bin", "/sbin", "/usr/bin", "/usr/sbin", "/usr/local/bin", "/usr/local/sbin", "/opt/homebrew/bin", "/opt/homebrew/sbin"];
	const perUser = homeFolders().flatMap((home) => [".local/bin", "bin", "go/bin", ".cargo/bin", ".bun/bin", ".deno/bin", "Applications", ...HOME_TOOL_PLACES].map((name) => path.join(home, name)));
	const apps = ["/Applications", "/System/Applications"];
	return [...new Set([...fromPath, ...standard, ...perUser, ...apps].map(realPathOf))];
}

/**
 * Whether a name is there. A link is followed only as the fence's walk follows
 * it (`realPlace`): its text is checked first, so a link a command left, say
 * to a share, is never followed, and counts as there. A name that isn't a link
 * is read where it is, so a room's own folder on a share keeps its names.
 * Where links are refused, a link is there and never followed.
 */
function there(place: string, options: GrantOptions): boolean {
	try {
		if (!fs.lstatSync(place).isSymbolicLink()) return true;
	} catch {
		return false;
	}
	if (options.links === "refuse") return true;
	const real = realPlace(place);
	if (real === null) return true;
	try {
		fs.statSync(real);
		return true;
	} catch {
		return false;
	}
}

/** A folder git reads as a repository: a bare repository's root, by the layout git detects. */
function looksLikeGitDir(folder: string, options: GrantOptions = {}): boolean {
	try {
		return ["HEAD", "objects", "refs"].every((name) => there(path.join(folder, name), options));
	} catch {
		return false;
	}
}

const PROGRAMS: FolderRefusal = { reason: "programs" };
const OTHER: FolderRefusal = { reason: "other" };

/**
 * Whether a yes here would hand a command a place whose files other programs
 * run: the search path and the app folders, a bare repository's root, a git
 * hooks folder, or a closed name (git settings, an editor's folder), or a
 * folder that holds one of the first two, by its name from the folder. This
 * holds for reading and for changing, since a yes for reading can be widened
 * to one for changing, and reading such a place is no reach a card should grant.
 */
function othersProgramsRefusal(folder: string, options: GrantOptions, against: JudgedAgainst): FolderRefusal | null {
	if (namesClosedPlace(folder)) return PROGRAMS;
	const real = realPathOf(folder);
	if (against.programs().some((place) => isInside(real, place))) return PROGRAMS;
	if (looksLikeGitDir(real, options)) return PROGRAMS;
	if (foldedName(path.basename(real)) === "hooks" && looksLikeGitDir(path.dirname(real), options)) return PROGRAMS;
	// A folder that holds a program folder: a yes on it still lets a command plant a program in the search path.
	const held = against.programs().find((place) => isInside(place, real));
	return held ? { reason: "holds-programs", inner: path.relative(real, held) } : null;
}

// The computer this server runs on, read once: a smoke acting as Windows on another computer keeps that computer's rules.
const ON_WINDOWS = process.platform === "win32";

/** Windows' own places no yes may open, each by the name Windows gave it and by its real path. Asked only on Windows. */
function windowsPlacesHere(answer: string): WindowsPlaces {
	return withRealPaths(windowsPlaces(answer, process.env, { homes: homeFolders(), appData: appDataPlaces(), toolNames: HOME_TOOL_PLACES }), realPathOf);
}

/** What a folder is judged against, the same whichever room asks: each read from the disk when a judgement first needs it, then kept. */
export interface JudgedAgainst {
	homes(): string[];
	programs(): string[];
	closed(): { never: string[]; broad: string[]; shared: string[] };
	windows(answer: string): WindowsPlaces;
}

/**
 * For one judgement, or for one pass over many rooms, which hands it down to
 * each and drops it at its end. Never kept longer: what is closed, and where a
 * link of it leads, can change at any time, and the next pass reads it again.
 */
export function judgedAgainst(): JudgedAgainst {
	let homes: string[] | undefined;
	let programs: string[] | undefined;
	let closed: ReturnType<JudgedAgainst["closed"]> | undefined;
	let windows: { answer: string; places: WindowsPlaces } | undefined;
	return {
		homes: () => (homes ??= homeFolders()),
		programs: () => (programs ??= programFolders()),
		closed: () => {
			if (closed) return closed;
			const read = closedForReading();
			return (closed = { never: neverOpened(read), broad: read.broad, shared: read.shared });
		},
		// By the answer too: one that couldn't be read yet can be, later in the pass.
		windows: (answer) => (windows?.answer === answer ? windows : (windows = { answer, places: windowsPlacesHere(answer) })).places,
	};
}

/** Whether Windows' rules refuse the folder; before a click only by an answer already read, and none refuses. */
function windowsRefusesHere(folder: string, beforeClick: boolean, against: JudgedAgainst): boolean {
	const answer = beforeClick ? keptWindowsAnswer() : windowsAnswer(process.env);
	return answer === undefined || windowsRefuses(folder, against.windows(answer));
}

/**
 * The cloud drives a person keeps files in under ~/Library, which work as an
 * ordinary folder in the box, files kept only online included: iCloud Drive,
 * and each account folder under CloudStorage, whichever provider keeps it, by
 * its path alone, as the other tools take it. Never CloudStorage itself.
 */
function inCloudDrive(folder: string, home: string): boolean {
	if (isInside(folder, path.join(home, "Library", "Mobile Documents", "com~apple~CloudDocs"))) return true;
	// A Mac's place: on Windows a folder of that name stays as Library's rule has it.
	const storage = path.join(home, "Library", "CloudStorage");
	return !ON_WINDOWS && isInside(folder, storage) && foldedName(folder) !== foldedName(storage);
}

/** A path no card can draw honestly: a device, or a name a command chose to read as something else. */
function unshowable(target: string): boolean {
	return pathHoldsHidden(target) || isInside(realPathOf(target), "/dev");
}

/**
 * Whether a folder may be on a room's list, by its real name. Never a folder
 * that holds the room, or whose files other programs run (the search path, an
 * app folder, a bare repository or its hooks, a closed name), for reading or
 * changing. Never a parent of anything closed, which covers home and the disk's
 * root, a closed place, inside ~/Library, where everyday programs read and write
 * settings and caches nobody asked for, but for iCloud Drive and the cloud drives in CloudStorage, inside the computer's shared temp or
 * caches, where other apps stage their files, or inside a place a command can
 * write, where a command could swap it, or a folder above it, for a link. On
 * Windows, never one of Windows' own places either (`windows/windows-places.ts`).
 * A name that isn't the folder's real name has moved or never was it.
 */
export function folderGrantable(folder: string, access: Access, writable: readonly string[], room: string, options: GrantOptions = {}, against?: JudgedAgainst): boolean {
	return folderRefusal(folder, access, writable, room, options, against) === null;
}

/** Why `folderGrantable` refuses a folder, or null where it doesn't. */
export function folderRefusal(folder: string, access: Access, writable: readonly string[], room: string, options: GrantOptions = {}, against?: JudgedAgainst): FolderRefusal | null {
	if (realPlace(folder, options) === null || unshowable(folder)) return OTHER;
	return placeRefusal(folder, writable, room, options, against);
}

/**
 * Whether a folder may be a room's own, by the list's rule: what a command
 * there could change is judged the same way. Its place on the network is the
 * person's choice, so a room on a share keeps working, as the file fence lets
 * it, and no card draws it, so a name a card can't show, as an emoji's, is fine.
 */
export function roomFolderGrantable(folder: string, against?: JudgedAgainst): boolean {
	return roomFolderRefusal(folder, against) === null;
}

/** Why `roomFolderGrantable` refuses a folder, or null where it doesn't. */
export function roomFolderRefusal(folder: string, against?: JudgedAgainst): FolderRefusal | null {
	return placeRefusal(folder, [], "", {}, against);
}

/** Every check refuses the folder alike: their order only picks which reason a person reads, the closer one first. */
function placeRefusal(folder: string, writable: readonly string[], room: string, options: GrantOptions, against: JudgedAgainst = judgedAgainst()): FolderRefusal | null {
	if (realPathOf(folder) !== folder) return OTHER;
	if (isInside(room, folder)) return OTHER;
	if (ON_WINDOWS && windowsRefusesHere(folder, options.beforeClick === true, against)) return OTHER;
	const programs = othersProgramsRefusal(folder, options, against);
	// Before a click a folder in Library, a cloud drive's too, is only ever chosen in the window.
	if (against.homes().some((home) => isInside(folder, path.join(home, "Library")) && (options.beforeClick === true || !inCloudDrive(folder, home)))) return { reason: "library" };
	const { never, broad, shared } = against.closed();
	// Before a program folder: the app's own data has a name apps read settings from, and what is kept there is the reason.
	if (never.some((place) => isInside(folder, place))) return { reason: "private" };
	if (programs?.reason === "programs") return programs;
	// A home that sits in a shared folder is still the person's.
	if (shared.some((place) => isInside(folder, place)) && !against.homes().some((home) => isInside(folder, home))) return { reason: "shared" };
	// Before a program folder inside it: a home holds both, and is refused as a whole.
	if ([...never, ...broad].some((place) => isInside(place, folder))) return { reason: "holds-closed" };
	if (programs) return programs;
	if (writable.some((place) => place !== folder && isInside(folder, place))) return OTHER;
	return null;
}

/**
 * Whether a picked path passes through a link that sits in a place commands
 * can write. A command could have left it there, so that a pick in the
 * computer's window leads to a folder the person didn't choose.
 */
export function pickedThroughWritableLink(picked: string, writable: readonly string[]): boolean {
	let at = path.resolve(picked);
	for (;;) {
		const parent = path.dirname(at);
		if (parent === at) return false;
		if (fs.lstatSync(at, { throwIfNoEntry: false })?.isSymbolicLink() && writable.some((place) => isInside(realPathOf(parent), place))) return true;
		at = parent;
	}
}

export const writeEntries = (folders: readonly AlsoAllowedFolder[]): string[] => folders.filter((entry) => entry.access === "write").map((entry) => entry.path);

/** The entries no conversation can use: moved, closed, or below another entry open for changing. A conversation's own folder only ever skips more. */
export function unsoundForEveryone(folders: readonly AlsoAllowedFolder[]): AlsoAllowedFolder[] {
	const writable = writeEntries(folders);
	return folders.filter((entry) => !folderGrantable(entry.path, entry.access, writable, ""));
}

/** The entries a room's list may keep: each one judged against the room and the list's other writable folders. */
export function soundFolders(folders: readonly AlsoAllowedFolder[], room: string, against?: JudgedAgainst): AlsoAllowedFolder[] {
	const writable = [room, ...writeEntries(folders)];
	return folders.filter((entry) => folderGrantable(entry.path, entry.access, writable, room, {}, against));
}
