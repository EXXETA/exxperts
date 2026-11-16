import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { realPlace, type WalkOptions } from "../path-shapes.js";
import type { AlsoAllowedFolder } from "./also-allowed.js";
import { appDataPlaces, closedForReading, foldedName, homeFolders, isInside, neverOpened, realPathOf } from "./box-closed.js";
import { NEVER_WRITABLE_FILES, NEVER_WRITABLE_FOLDERS } from "./box-rules.js";
import { pathHoldsHidden } from "./card-text.js";
import { keptWindowsAnswer, windowsAnswer, windowsPlaces, windowsRefuses, withRealPaths, type WindowsPlaces } from "./windows/windows-places.js";

type Access = AlsoAllowedFolder["access"];

/**
 * How a folder is judged where nothing may be followed or started for it. Both
 * off by default. `links: "refuse"`: a link on the way refuses the folder, and a
 * link inside it counts as there without being followed. `beforeClick`: no
 * program starts, so a folder in a home's Library and, on Windows, any folder
 * before Windows' answer was read, are refused.
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

/**
 * Whether a yes here would hand a command a place whose files other programs
 * run: the search path and the app folders, a bare repository's root, a git
 * hooks folder, or a closed name (git settings, an editor's folder). This holds
 * for reading and for changing, since a yes for reading can be widened to one
 * for changing, and reading such a place is no reach a card should grant.
 */
function runsOthersPrograms(folder: string, options: GrantOptions): boolean {
	if (namesClosedPlace(folder)) return true;
	const real = realPathOf(folder);
	// A program folder, a folder inside one, or a folder that holds one: a yes on the parent still lets a command plant a program in the search path.
	if (programFolders().some((place) => isInside(real, place) || isInside(place, real))) return true;
	if (looksLikeGitDir(real, options)) return true;
	return foldedName(path.basename(real)) === "hooks" && looksLikeGitDir(path.dirname(real), options);
}

// The computer this server runs on, read once: a smoke acting as Windows on another computer keeps that computer's rules.
const ON_WINDOWS = process.platform === "win32";

/** Windows' own places no yes may open, each by the name Windows gave it and by its real path. Asked only on Windows. */
function windowsPlacesHere(answer: string): WindowsPlaces {
	return withRealPaths(windowsPlaces(answer, process.env, { homes: homeFolders(), appData: appDataPlaces(), toolNames: HOME_TOOL_PLACES }), realPathOf);
}

/** Whether Windows' rules refuse the folder; before a click only by an answer already read, and none refuses. */
function windowsRefusesHere(folder: string, beforeClick: boolean): boolean {
	const answer = beforeClick ? keptWindowsAnswer() : windowsAnswer(process.env);
	return answer === undefined || windowsRefuses(folder, windowsPlacesHere(answer));
}

const XATTR = "/usr/bin/xattr";
const providerOf = new Map<string, string>();

/**
 * A folder's file provider, as the computer marks it. Only a mark that was read
 * is kept: a read that failed or timed out is tried again at the next judgement,
 * so one slow read never refuses a room until the app starts again.
 */
function fileProvider(folder: string): string | null {
	const known = providerOf.get(folder);
	if (known !== undefined) return known;
	const read = spawnSync(XATTR, ["-p", "com.apple.file-provider-domain-id", folder], { encoding: "utf8", timeout: 5_000 });
	const mark = read.status === 0 ? read.stdout.trim() : "";
	if (mark === "") return null;
	providerOf.set(folder, mark);
	return mark;
}

/**
 * The cloud drives a person keeps files in under ~/Library, which work as an
 * ordinary folder in the box, files kept only online included: iCloud Drive,
 * and each account under CloudStorage whose folder the computer marks with a
 * file provider, whichever provider it is. Never CloudStorage itself, or a
 * folder there without that mark.
 */
function inCloudDrive(folder: string, home: string): boolean {
	if (isInside(folder, path.join(home, "Library", "Mobile Documents", "com~apple~CloudDocs"))) return true;
	const storage = path.join(home, "Library", "CloudStorage");
	if (!isInside(folder, storage) || foldedName(folder) === foldedName(storage)) return false;
	const account = path.relative(storage, folder).split(path.sep)[0];
	return fileProvider(path.join(storage, account)) !== null;
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
 * settings and caches nobody asked for, but for iCloud Drive and a marked cloud drive, inside the computer's shared temp or
 * caches, where other apps stage their files, or inside a place a command can
 * write, where a command could swap it, or a folder above it, for a link. On
 * Windows, never one of Windows' own places either (`windows/windows-places.ts`).
 * A name that isn't the folder's real name has moved or never was it.
 */
export function folderGrantable(folder: string, access: Access, writable: readonly string[], room: string, options: GrantOptions = {}): boolean {
	if (realPlace(folder, options) === null || unshowable(folder)) return false;
	return placeGrantable(folder, writable, room, options);
}

/**
 * Whether a folder may be a room's own, by the list's rule: what a command
 * there could change is judged the same way. Its place on the network is the
 * person's choice, so a room on a share keeps working, as the file fence lets
 * it, and no card draws it, so a name a card can't show, as an emoji's, is fine.
 */
export function roomFolderGrantable(folder: string): boolean {
	return placeGrantable(folder, [], "");
}

function placeGrantable(folder: string, writable: readonly string[], room: string, options: GrantOptions = {}): boolean {
	if (realPathOf(folder) !== folder) return false;
	if (isInside(room, folder)) return false;
	if (ON_WINDOWS && windowsRefusesHere(folder, options.beforeClick === true)) return false;
	if (runsOthersPrograms(folder, options)) return false;
	// Before a click, telling a cloud drive needs xattr: a folder in Library waits for the window.
	if (homeFolders().some((home) => isInside(folder, path.join(home, "Library")) && (options.beforeClick === true || !inCloudDrive(folder, home)))) return false;
	const closed = neverOpened();
	const { broad, shared } = closedForReading();
	if ([...closed, ...broad].some((place) => isInside(place, folder))) return false;
	if (closed.some((place) => isInside(folder, place))) return false;
	// A home that sits in a shared folder is still the person's.
	if (shared.some((place) => isInside(folder, place)) && !homeFolders().some((home) => isInside(folder, home))) return false;
	if (writable.some((place) => place !== folder && isInside(folder, place))) return false;
	return true;
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
export function soundFolders(folders: readonly AlsoAllowedFolder[], room: string): AlsoAllowedFolder[] {
	const writable = [room, ...writeEntries(folders)];
	return folders.filter((entry) => folderGrantable(entry.path, entry.access, writable, room));
}
