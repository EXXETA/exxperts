import { createHmac, randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { variable, type WindowsRoomRules } from "./box-request.js";
import { gitIdentityText, readGitIdentity } from "./git-identity.js";

/**
 * Where the Windows box keeps its own places: one fixed folder in the login
 * home, `.exxperts.box`, never under the state home. Every folder above a
 * granted place becomes listable to a command, so a temp under the rooms' data
 * would show the names of her other rooms, and one under a moved home would
 * show the folder it moved to. It holds:
 * - `key`: a random value no request grants, for the room folders' names;
 * - per room, a folder named by a keyed hash of the room's data folder, so a
 *   listed name can't be turned back into a room's name. It holds `owner.json`
 *   (the room's data folder, for the sweep), `caches`, and one `temp-<random>`
 *   per turn;
 * - `curl`, holding `_curlrc`: curl's settings for every room's commands, which
 *   they only read;
 * - `git`, holding `config`: the person's git name and e-mail and nothing else
 *   of their settings, for every room's commands, which they only read.
 * Only the server writes here, but a command writes its own turn's temp and its
 * room's caches.
 */
export const BOX_ROOT_NAME = ".exxperts.box";

/**
 * In the login home, EXXPERTS_LOGIN_HOME, which every starter that can move
 * the data names: a moved home or a data profile never changes it. A start
 * that names none (the desktop's scratch runs, a smoke's own server) keeps it
 * in the data's home it names, else in its own HOME. Never the home in the
 * account's record (os.userInfo), which stateProfileLoginHome
 * (../../server-install-root.ts) falls back to: a test that sets its own HOME
 * would make it in the real one.
 */
export function defaultBoxRoot(): string {
	return path.join(process.env.EXXPERTS_LOGIN_HOME?.trim() || process.env.EXXPERTS_REAL_HOME?.trim() || os.homedir(), BOX_ROOT_NAME);
}

const KEY_BYTES = 32;
const CURL_FOLDER = "curl";
const CURL_SETTINGS = "_curlrc";
// The room's protection refuses Windows' certificate checks, which Windows' curl stops at unless told to go on.
const CURL_SETTINGS_TEXT = "ssl-revoke-best-effort\n";
const OWNER = "owner.json";
const CACHES = "caches";
const TEMP_PREFIX = "temp-";

/** The box root by its real path, with its key: made once, by whichever server comes first. */
export interface BoxRoot {
	path: string;
	key: Buffer;
}

const notThere = (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT";

/** Our own names, made from real paths: Windows matches them without case. */
const samePlace = (a: string, b: string) => (process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b);

/**
 * Why `place` is not itself a plain folder or file, as `kind` says, or null
 * when it is. Node on Windows reads a symlink and a junction to a drive letter
 * as a link, but a junction to a volume and other reparse points as a plain
 * folder: only the real path shows those. The reason names no path.
 */
function notOwn(place: string, kind: "folder" | "file", what: string): string | null {
	const stat = fs.lstatSync(place);
	if (stat.isSymbolicLink()) return `${what} is a link`;
	if (kind === "folder" ? !stat.isDirectory() : !stat.isFile()) return `${what} is not a ${kind}`;
	if (!samePlace(fs.realpathSync.native(place), place)) return `${what} leads elsewhere`;
	return null;
}

function mustBeOwn(place: string, kind: "folder" | "file", what: string): void {
	const why = notOwn(place, kind, what);
	if (why) throw new Error(why);
}

/** Makes a folder of the box if it is missing; anything but a plain folder there throws, never followed. */
function ownFolder(place: string, what: string): void {
	try {
		fs.mkdirSync(place);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
	}
	mustBeOwn(place, "folder", what);
}

/** The key, or null when there is none or it isn't a key; anything but a plain file there throws. */
function readKey(file: string): Buffer | null {
	try {
		mustBeOwn(file, "file", "the box root's key");
	} catch (error) {
		if (notThere(error)) return null;
		throw error;
	}
	try {
		const key = fs.readFileSync(file);
		return key.length === KEY_BYTES ? key : null;
	} catch {
		return null;
	}
}

/**
 * Makes the box root and its key if they aren't there. The home above it is
 * taken by its real path, so a home reached through a link still works, but
 * the root itself must be a plain folder: a link there would move the key and
 * every room's places to where it leads. The key is written aside and linked
 * into place, which fails when another server got there first: then that
 * one's key is read, so two servers never disagree on it.
 */
export function openBoxRoot(root: string): BoxRoot {
	const home = path.dirname(root);
	fs.mkdirSync(home, { recursive: true });
	const real = path.join(fs.realpathSync.native(home), path.basename(root));
	ownFolder(real, "the box root");
	const file = path.join(real, "key");
	let key = readKey(file);
	if (!key) {
		const aside = path.join(real, `key-${randomBytes(6).toString("hex")}`);
		fs.writeFileSync(aside, randomBytes(KEY_BYTES), { flag: "wx" });
		try {
			fs.linkSync(aside, file);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		} finally {
			fs.rmSync(aside, { force: true });
		}
		key = readKey(file);
		if (!key) throw new Error("the box root's key can't be read");
	}
	return { path: real, key };
}

/** The room's own folder in the box root, from its data folder. */
export function roomPlace(root: BoxRoot, roomData: string): string {
	return path.join(root.path, createHmac("sha256", root.key).update(roomData).digest("hex").slice(0, 32));
}

/** One turn's places: a fresh temp, made so that it fails if anything is already there, the room's caches, curl's settings folder when it could be written, and the file with the person's git name and e-mail when there is one (`gitConfig`). */
export interface TurnPlaces {
	temp: string;
	caches: string;
	curlHome?: string;
	gitConfig?: string;
}

/**
 * curl's settings folder, which a command names in CURL_HOME: made, and its
 * `_curlrc` written again by a file aside and a rename when it is missing or
 * differs. A link or a reparse point at the folder or the file throws, never
 * followed, written through or removed, as anything else that fails does.
 */
export function curlHome(root: BoxRoot): string {
	const folder = path.join(root.path, CURL_FOLDER);
	ownFolder(folder, "curl's settings folder in the box root");
	const file = path.join(folder, CURL_SETTINGS);
	let text: string | null = null;
	try {
		const fileStat = fs.lstatSync(file);
		if (fileStat.isSymbolicLink()) throw new Error("curl's settings in the box root are a link");
		if (!fileStat.isFile()) throw new Error("curl's settings in the box root are not a file");
		text = fs.readFileSync(file, "utf8");
	} catch (error) {
		if (!notThere(error)) throw error;
	}
	if (text !== CURL_SETTINGS_TEXT) {
		const aside = path.join(folder, `${CURL_SETTINGS}.${randomBytes(6).toString("hex")}`);
		fs.writeFileSync(aside, CURL_SETTINGS_TEXT, { flag: "wx" });
		try {
			fs.renameSync(aside, file);
		} finally {
			fs.rmSync(aside, { force: true });
		}
	}
	return folder;
}

/**
 * The room's caches, which its commands write, so a command could turn the
 * folder itself into a link: what is there instead of a plain folder at its
 * own real path, or whose real path can't be read, is removed as itself,
 * never what it leads to, and a fresh folder made, told to `replaced`.
 * Refusing would let a command stop its own room for good.
 */
function ownCaches(caches: string, replaced: () => void): void {
	try {
		fs.mkdirSync(caches);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
	}
	let foreign: boolean;
	try {
		foreign = notOwn(caches, "folder", "the room's caches") !== null;
	} catch {
		foreign = true;
	}
	if (foreign) {
		// rmdir takes a link or junction on Windows; unlink takes a link elsewhere, and a file.
		try {
			fs.rmdirSync(caches);
		} catch {
			fs.unlinkSync(caches);
		}
		fs.mkdirSync(caches);
		replaced();
	}
	mustBeOwn(caches, "folder", "the room's caches");
}

/**
 * Makes the room's folder with its owner, its caches and a fresh temp for this
 * turn, and curl's settings. A link or anything else at the box root, the
 * room's folder or its owner throws, so none of the turn's commands run. curl's settings are a
 * convenience: any failure there, a link included, leaves them out of this
 * turn, so its commands get neither CURL_HOME nor the grant, told to
 * `curlFailed` by the system's error code, or else by our own reason, which
 * names no path, and the next turn tries again.
 */
export function makeTurnPlaces(root: BoxRoot, roomData: string, curlFailed: (why: string) => void = () => {}, cachesReplaced: () => void = () => {}): TurnPlaces {
	// Made again if it went after the start check; a link there refuses before anything is made where it leads.
	ownFolder(root.path, "the box root");
	// First: a refusal there leaves no temp behind.
	let curl: string | undefined;
	try {
		curl = curlHome(root);
	} catch (error) {
		curlFailed((error as NodeJS.ErrnoException).code ?? (error as Error).message);
	}
	const room = roomPlace(root, roomData);
	ownFolder(room, "the room's folder in the box root");
	const owner = path.join(room, OWNER);
	try {
		mustBeOwn(owner, "file", "the room's owner in the box root");
	} catch (error) {
		if (!notThere(error)) throw error;
		const aside = `${owner}.${randomBytes(6).toString("hex")}`;
		fs.writeFileSync(aside, JSON.stringify({ room: roomData }), { flag: "wx" });
		fs.renameSync(aside, owner);
	}
	const caches = path.join(room, CACHES);
	ownCaches(caches, cachesReplaced);
	const temp = path.join(room, `${TEMP_PREFIX}${randomBytes(8).toString("hex")}`);
	fs.mkdirSync(temp);
	return { temp, caches, ...(curl === undefined ? {} : { curlHome: curl }) };
}

/** Removes a folder, a link in it as a link: never what it leads to. Asynchronous, so a large temp never stalls the server. */
export function removePlace(place: string): Promise<void> {
	return fs.promises.rm(place, { recursive: true, force: true, maxRetries: 3 });
}

/** A turn cut off before its end leaves its temp: the room's next turn removes every temp but its own. */
export async function sweepOldTemps(places: TurnPlaces): Promise<void> {
	const room = path.dirname(places.temp);
	const left = (await fs.promises.readdir(room)).filter((name) => name.startsWith(TEMP_PREFIX) && path.join(room, name) !== places.temp);
	await Promise.all(left.map((name) => removePlace(path.join(room, name))));
}

/**
 * The folders of rooms that are gone: each room folder whose owner's data
 * folder no longer exists. An entry that is a link (a Dirent reads every
 * reparse point as one) is left, and so is a room whose owner is anything but
 * a plain readable file, so what a link leads to never decides a removal.
 */
export async function sweepGoneRooms(root: BoxRoot): Promise<void> {
	for (const entry of await fs.promises.readdir(root.path, { withFileTypes: true })) {
		if (!entry.isDirectory()) continue;
		const file = path.join(root.path, entry.name, OWNER);
		let owner: unknown;
		try {
			if (!(await fs.promises.lstat(file)).isFile()) continue;
			owner = JSON.parse(await fs.promises.readFile(file, "utf8"));
		} catch {
			continue;
		}
		const room = (owner as { room?: unknown } | null)?.room;
		if (typeof room === "string" && path.isAbsolute(room) && !fs.existsSync(room)) await removePlace(path.join(root.path, entry.name));
	}
}

const GIT_FOLDER = "git";
const GIT_SETTINGS = "config";

/** One of the person's git settings files, or undefined when there is none. Text that isn't UTF-8 throws: what git would make of it can't be told here. */
function personSettings(file: string): string | undefined {
	let bytes: Buffer;
	try {
		bytes = fs.readFileSync(file);
	} catch (error) {
		if (notThere(error)) return undefined;
		throw error;
	}
	try {
		return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
	} catch {
		throw new Error("the person's git settings are not UTF-8");
	}
}

/**
 * The file with the person's git name and e-mail for this turn's commands,
 * which name it in GIT_CONFIG_GLOBAL. Both are read from the git settings in
 * the home a command's USERPROFILE names (git-identity.ts), and only there: a
 * home git takes from HOME, or from HOMEDRIVE and HOMEPATH, is not looked in.
 * They are written to `git\config` in the box root by a file aside and a
 * rename when it is missing or differs. Undefined when neither is found, and on
 * any failure, told to `failed` as curl's are (`makeTurnPlaces`): a link or a
 * reparse point at the folder or the file is never followed, written through
 * or removed. With neither found an earlier turn's file stays, named and
 * granted to no command. A link the person keeps at their own settings is
 * followed: only the server reads through it.
 */
export function gitIdentity(root: BoxRoot, environment: WindowsRoomRules["environment"], failed: (why: string) => void): string | undefined {
	try {
		const profile = variable(environment, "USERPROFILE");
		if (profile === undefined || !path.isAbsolute(profile)) return undefined;
		// In the order git reads them: the later one wins.
		const text = gitIdentityText(readGitIdentity([personSettings(path.join(profile, ".config", "git", "config")), personSettings(path.join(profile, ".gitconfig"))]));
		if (text === undefined) return undefined;
		const folder = path.join(root.path, GIT_FOLDER);
		try {
			fs.mkdirSync(folder);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		}
		const folderStat = fs.lstatSync(folder);
		if (folderStat.isSymbolicLink()) throw new Error("git's settings folder in the box root is a link");
		if (!folderStat.isDirectory()) throw new Error("git's settings folder in the box root is not a folder");
		const file = path.join(folder, GIT_SETTINGS);
		let kept: string | null = null;
		try {
			const fileStat = fs.lstatSync(file);
			if (fileStat.isSymbolicLink()) throw new Error("git's settings in the box root are a link");
			if (!fileStat.isFile()) throw new Error("git's settings in the box root are not a file");
			kept = fs.readFileSync(file, "utf8");
		} catch (error) {
			if (!notThere(error)) throw error;
		}
		if (kept !== text) {
			const aside = path.join(folder, `${GIT_SETTINGS}.${randomBytes(6).toString("hex")}`);
			fs.writeFileSync(aside, text, { flag: "wx" });
			try {
				fs.renameSync(aside, file);
			} finally {
				fs.rmSync(aside, { force: true });
			}
		}
		return file;
	} catch (error) {
		failed((error as NodeJS.ErrnoException).code ?? (error as Error).message);
		return undefined;
	}
}
