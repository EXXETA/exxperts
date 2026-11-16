import type { BigIntStats } from "node:fs";
import fsPromises from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { refusedShape } from "../path-shapes.js";
import { foldedName, homeFolders } from "./box-closed.js";
import { pathAsShown, pathHoldsHidden } from "./card-text.js";
import { localPath } from "./windows/box-request.js";
import { keptWindowsAnswer, personalFolders } from "./windows/windows-places.js";

/**
 * The judge of a folder the room suggests on its folder question. The panel
 * names a suggestion only by what this gives: the disk's own spelling of a
 * folder strictly inside the person's home, reached with no link, on the
 * home's disk, that the room's rules would let a pick have. The text is judged
 * first with no call at all. Then, off the server's own thread and within a
 * limit, only `lstat` and `realpath` touch the path, so no folder is listed,
 * no file opened and no program started for a guess before the person acts.
 * It never throws: anything unexpected is no suggestion.
 */

/** How long the judge before the card may take; every folder question waits exactly this long, with or without a suggestion. */
export const SUGGESTION_JUDGE_MS = 300;
/** How long the recheck at a press may take before that press gives nothing. */
export const CLICK_CHECK_LIMIT_MS = 2_000;
/** Whether the judge runs before the card and the panel names the folder; false keeps the plain card and judges at the press only. */
export const SHOW_SUGGESTION_BEFORE_CLICK = true;

const TEXT_LIMIT = 400;
const PARTS_BELOW_HOME = 8;

/** A folder the panel shows before it is given. Held on the server only, never taken back from the page. `from`: the room's suggestion, or the person's pick in the window. `once`: whether Allow this time is offered. `dev` and `ino` as last seen, as decimal strings. */
export type HeldFolder = { real: string; name: string; shown: string; from: "room" | "window"; once: boolean; dev: string; ino: string };

export type JudgeMoment = "before-click" | "click";

/** The file calls the judge makes, replaceable so a smoke can record them or hold one. */
export interface SuggestionFiles {
	lstat(place: string, options: { bigint: true }): Promise<BigIntStats>;
	realpath(place: string): Promise<string>;
	statfs(place: string): Promise<{ type: number | bigint }>;
}

/** The room as the judge needs it, read at each judge. The rest describes the computer, and only a smoke sets it. */
export interface SuggestionView {
	/** The room's own folder by its real path. */
	roomFolder: string;
	/** Where the room's commands can write, as stored: the room's folder and every change entry of its list and of this answer. */
	writable: readonly string[];
	/** The room's own rules for a pick, on the folder's real path (step 15): before the click they touch no saved entry and start no program. */
	roomRules: (real: string, at: JudgeMoment) => boolean;
	files?: SuggestionFiles;
	/** The person's home; the login home when it is also the server's. */
	home?: string;
	rules?: path.PlatformPath;
	/** Windows' answer to its folders, only if already read. */
	keptAnswer?: () => string | undefined;
	/** Every home the server names, the app's data folder among them. */
	homes?: readonly string[];
}

const isWindows = (rules: path.PlatformPath): boolean => rules === path.win32;
const folded = (text: string, rules: path.PlatformPath): string => foldedName(isWindows(rules) ? text.replace(/\//g, "\\") : text);

/** Whether `inner` is `outer` or below it, by folded text, under the given rules. */
function within(inner: string, outer: string, rules: path.PlatformPath): boolean {
	const [a, b] = [folded(inner, rules), folded(outer, rules).replace(/[\\/]+$/, "")];
	return a === b || a.startsWith(`${b}${rules.sep}`);
}

/** The login home, used only when the server runs under it too. */
function loginHome(rules: path.PlatformPath): string | null {
	try {
		const login = os.userInfo().homedir;
		if (!login || folded(login, rules) !== folded(os.homedir(), rules)) return null;
		if (isWindows(rules) && (!/^[A-Za-z]:\\/.test(login) || refusedShape(login, [], rules))) return null;
		return login;
	} catch {
		return null;
	}
}

const WINDOWS_PART_REFUSED = /[*?"<>|:]|~\d|[. ]$/;

/** The text rules on one spelling: the folder's parts below `home`, or null. Touches nothing. */
function partsBelow(text: string, home: string, view: SuggestionView, rules: path.PlatformPath): string[] | null {
	const windows = isWindows(rules);
	if (text.length === 0 || text.length > TEXT_LIMIT || pathHoldsHidden(text)) return null;
	if (text.includes("://") || /^file:/i.test(text)) return null;
	let spelled = windows ? text.replace(/\//g, "\\") : text;
	if (refusedShape(spelled, [], rules)) return null;
	if (spelled === "~" || spelled.startsWith(`~${rules.sep}`)) spelled = `${home.replace(/[\\/]+$/, "")}${spelled.slice(1)}`;
	if (windows ? !/^[A-Za-z]:\\/.test(spelled) : !spelled.startsWith("/")) return null;
	if (spelled.length > 1 && spelled.endsWith(rules.sep)) spelled = spelled.slice(0, -1);
	const homeParts = home.replace(/[\\/]+$/, "").split(rules.sep);
	const parts = spelled.split(rules.sep);
	// One leading empty part is the root on a Mac; any other `.`, `..` or empty part is refused.
	if (parts.some((part, at) => part === "." || part === ".." || (part === "" && !(at === 0 && !windows)))) return null;
	if (parts.length <= homeParts.length || !within(spelled, home, rules)) return null;
	const below = parts.slice(homeParts.length);
	if (below.length > PARTS_BELOW_HOME || below.some((part) => part.startsWith("."))) return null;
	if (foldedName(below[0]) === foldedName(windows ? "AppData" : "Library")) return null;
	if (windows && below.some((part) => WINDOWS_PART_REFUSED.test(part))) return null;
	const place = [...homeParts, ...below].join(rules.sep);
	// The app's own data, under any other home the server names.
	const homes = view.homes ?? homeFolders();
	if (homes.some((other) => !within(home, other, rules) && within(place, other, rules))) return null;
	if (view.writable.some((entry) => within(place, entry, rules))) return null;
	if (within(view.roomFolder, place, rules)) return null;
	return below;
}

/** The text rules alone: the place a suggestion names, by its text, or null. No disk call and no program. */
export function suggestionPlace(text: unknown, view: SuggestionView): string | null {
	const rules = view.rules ?? (process.platform === "win32" ? path.win32 : path.posix);
	const home = view.home ?? loginHome(rules);
	if (typeof text !== "string" || home === null) return null;
	const below = partsBelow(text, home, view, rules);
	return below === null ? null : rules.join(home, ...below);
}

interface HomeFacts {
	real: string;
	dev: bigint;
	/** Desktop, Documents and Downloads by their real paths, outside Windows. */
	once: string[];
}

// Kept per set of file calls and home, and only once read: a failed read is tried again at the next judge.
const homesRead = new WeakMap<SuggestionFiles, Map<string, HomeFacts>>();

async function readHome(home: string, files: SuggestionFiles, rules: path.PlatformPath): Promise<HomeFacts | null> {
	const known = homesRead.get(files)?.get(home);
	if (known) return known;
	const real = await files.realpath(home);
	const { dev } = await files.lstat(real, { bigint: true });
	// Windows says 0 where it can't name the volume: nothing then tells another disk.
	if (dev === 0n) return null;
	// A home on a network disk gets no suggestions; Windows has no such type to compare.
	if (!isWindows(rules) && BigInt((await files.statfs(real)).type) !== BigInt((await files.statfs("/")).type)) return null;
	const once: string[] = [];
	if (!isWindows(rules)) {
		for (const name of ["Desktop", "Documents", "Downloads"]) {
			const place = rules.join(real, name);
			try {
				// Only a folder, not a link, on the home's disk: a link to a broader folder would make all of it one click.
				if (isPlainFolder(await files.lstat(place, { bigint: true }), dev)) once.push(place);
			} catch {
				// Not there: nothing inside it gets one click.
			}
		}
	}
	const facts = { real, dev, once };
	if (!homesRead.has(files)) homesRead.set(files, new Map());
	homesRead.get(files)?.set(home, facts);
	return facts;
}

/**
 * On Windows, Desktop, Documents and Downloads by real path, and the OneDrive
 * folders, from Windows' kept answer. Only a place inside the profile is
 * resolved: one outside it, a share or a mapped drive among them, would dial
 * the network at each judgement and can hold no folder inside the home, so it
 * gives no one click, and a OneDrive folder there counts by its name. One that
 * is the profile or holds it gives none either, as the Folder pane leaves it out.
 */
async function windowsOnce(answer: string, files: SuggestionFiles, profile: string, rules: path.PlatformPath): Promise<{ once: string[]; oneDrives: string[] }> {
	const told = personalFolders(answer);
	const real = async (place: string | undefined) => {
		if (place === undefined || localPath(place) === undefined || !within(place, profile, rules)) return [];
		try {
			const resolved = await files.realpath(place);
			return localPath(resolved) === undefined ? [] : [resolved];
		} catch {
			return [];
		}
	};
	const once = (await Promise.all([told.desktop, told.documents, told.downloads].map(real))).flat().filter((place) => !within(profile, place, rules));
	const oneDrives = (await Promise.all(told.oneDrives.map(real))).flat();
	return { once, oneDrives: [...new Set([...told.oneDrives, ...oneDrives])] };
}

/**
 * Whether Allow this time is offered: strictly inside Desktop, Documents or
 * Downloads. On Windows never inside a OneDrive folder or holding one, and
 * never inside the folder that holds a OneDrive folder, unless that is the
 * profile: synced team libraries sit beside OneDrive, and can't be told apart.
 */
function oneClick(real: string, once: readonly string[], oneDrives: readonly string[], profile: string, rules: path.PlatformPath): boolean {
	// A OneDrive folder Windows' answer missed still carries its name; the profile's own name doesn't count.
	const parts = within(real, profile, rules) ? rules.relative(profile, real) : real;
	if (isWindows(rules) && parts.split(rules.sep).some((part) => part.toLowerCase().startsWith("onedrive"))) return false;
	if (!once.some((place) => within(real, place, rules) && folded(real, rules) !== folded(place, rules))) return false;
	if (oneDrives.some((drive) => within(real, drive, rules) || within(drive, real, rules))) return false;
	return !oneDrives.some((drive) => {
		const holder = rules.dirname(drive);
		return folded(holder, rules) !== folded(profile, rules) && within(real, holder, rules);
	});
}

const isPlainFolder = (seen: BigIntStats, dev: bigint): boolean => seen.isDirectory() && !seen.isSymbolicLink() && seen.dev === dev;

async function judged(text: unknown, view: SuggestionView, at: JudgeMoment): Promise<HeldFolder | null> {
	const rules = view.rules ?? (process.platform === "win32" ? path.win32 : path.posix);
	const files = view.files ?? fsPromises;
	const home = view.home ?? loginHome(rules);
	if (typeof text !== "string" || home === null) return null;
	// A home reached through a link: the folder shown carries the home's real path, and the press judges it there.
	const knownReal = homesRead.get(files)?.get(home)?.real;
	const below = partsBelow(text, home, view, rules) ?? (knownReal !== undefined && knownReal !== home ? partsBelow(text, knownReal, view, rules) : null);
	if (below === null) return null;
	// On Windows, only an answer already read: asking would start a program for a guess.
	const answer = isWindows(rules) ? (view.keptAnswer ?? keptWindowsAnswer)() : undefined;
	if (isWindows(rules) && answer === undefined) return null;
	const facts = await readHome(home, files, rules);
	if (facts === null) return null;
	// Down from the home a part at a time: a folder, not a link, on the home's disk, or no suggestion.
	let place = facts.real;
	let seen: BigIntStats | null = null;
	for (const part of below) {
		place = rules.join(place, part);
		seen = await files.lstat(place, { bigint: true });
		if (!isPlainFolder(seen, facts.dev)) return null;
	}
	if (seen === null) return null;
	const real = await files.realpath(place);
	if (folded(real, rules) !== folded(place, rules) || !within(real, facts.real, rules)) return null;
	// The disk's own spelling passes the same rules.
	if (partsBelow(real, facts.real, view, rules) === null) return null;
	if (!view.roomRules(real, at)) return null;
	const windowsPlaces = answer === undefined ? { once: facts.once, oneDrives: [] } : await windowsOnce(answer, files, facts.real, rules);
	return {
		real,
		name: rules.basename(real),
		shown: pathAsShown(real, facts.real, isWindows(rules)),
		from: "room",
		once: oneClick(real, windowsPlaces.once, windowsPlaces.oneDrives, facts.real, rules),
		dev: String(seen.dev),
		ino: String(seen.ino),
	};
}

// Judges whose calls ran past their limit and haven't settled: while any has, a judge before a card gives none, in every room.
let overran = 0;

/**
 * A folder the room suggested, judged before the card (`before-click`) or at
 * a press (`click`), each within its own limit. A judge past its limit gives
 * nothing and is counted until its calls settle; meanwhile the judge before a
 * card gives nothing at once, and the recheck at a press still runs.
 */
export async function judgeSuggestion(text: unknown, view: SuggestionView, at: JudgeMoment): Promise<HeldFolder | null> {
	if (at === "before-click" && overran > 0) return null;
	const running = judged(text, view, at).catch(() => null);
	let timer: NodeJS.Timeout | undefined;
	const late = Symbol("late");
	const limit = new Promise<typeof late>((resolve) => {
		timer = setTimeout(() => resolve(late), at === "click" ? CLICK_CHECK_LIMIT_MS : SUGGESTION_JUDGE_MS);
	});
	const first = await Promise.race([running, limit]);
	clearTimeout(timer);
	if (first !== late) return first;
	overran += 1;
	void running.finally(() => {
		overran -= 1;
	});
	return null;
}

/** The judge before the card, or none at all when the panel names no folder before the press. */
export function suggestionBeforeCard(text: unknown, view: SuggestionView, show = SHOW_SUGGESTION_BEFORE_CLICK): Promise<HeldFolder | null> {
	return show ? judgeSuggestion(text, view, "before-click") : Promise.resolve(null);
}
