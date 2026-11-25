import fs from "node:fs";
import path from "node:path";

import { foldedName } from "./room-box/box-closed.js";

/**
 * The paths a room may never hand the server, refused by their text before
 * anything touches the disk or the network for them. On Windows, resolving a
 * share's path dials that host and hands it the person's sign-in; a device path
 * opens a device; a drive-relative path lands wherever that drive last was. On a
 * Mac, the automounter's places mount another computer's share when looked up.
 */

/** What the AI reads when a path names one of these places: a yes couldn't help, so no card. */
export const placeRefused = (shown: string): string => `${shown} names a network or device place, which a room can't use.`;

// With or without an extension, and with the superscript digits Windows also reserves.
const WINDOWS_DEVICE = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])$/i;

function windowsDevicePart(part: string): boolean {
	return WINDOWS_DEVICE.test(part.split(".")[0].replace(/ +$/, ""));
}

function windowsRefused(text: string): boolean {
	const spelled = text.replace(/\//g, "\\");
	// A share (`\\host\share`), a device or long path (`\\?\`, `\\.\`), or the kernel's own spelling (`\??\`).
	if (spelled.startsWith("\\\\") || spelled.startsWith("\\??\\")) return true;
	const drive = /^[A-Za-z]:/.test(spelled);
	// A drive with no slash after it counts from that drive's last folder.
	if (drive && spelled[2] !== "\\") return true;
	const rest = drive ? spelled.slice(2) : spelled;
	// A colon past the drive opens a file's hidden stream.
	return rest.includes(":") || rest.split("\\").some(windowsDevicePart);
}

const MAC_AUTOMOUNTS = new Set(["net", "network"]);
// The same automounts under the data volume's own name, which `/net` and `/Network` stand for.
const MAC_DATA_VOLUME = ["system", "volumes", "data"];

/** An automount, under either of its names, or `/.vol`, which opens any file by its disk and file numbers, whatever folder holds it. */
function macRefused(text: string): boolean {
	if (!path.posix.isAbsolute(text)) return false;
	const parts = path.posix.normalize(text).split("/").filter((part) => part.length > 0).map(foldedName);
	if (parts[0] === ".vol") return true;
	const onData = MAC_DATA_VOLUME.every((part, at) => parts[at] === part);
	const first = onData ? parts[MAC_DATA_VOLUME.length] : parts[0];
	return first !== undefined && MAC_AUTOMOUNTS.has(first);
}

/** The path rules of the computer this runs on, read at each call. */
const platformRules = (): path.PlatformPath => (process.platform === "win32" ? path.win32 : path.posix);

function refusedText(text: string, rules: path.PlatformPath): boolean {
	return rules === path.win32 ? windowsRefused(text) : macRefused(text);
}

const climbs = (relative: string, rules: path.PlatformPath): boolean => relative === ".." || relative.startsWith(`..${rules.sep}`) || rules.isAbsolute(relative);

/**
 * Whether a path's text names a network, device or drive-relative place, by the
 * given computer's path rules. Touches nothing. `chosen` are folders the person
 * picked, as a room's own folder on a share: the folder and the folders above it
 * pass, and below it only the names past it are judged, so `NUL.txt` there is
 * still refused.
 */
export function refusedShape(text: string, chosen: readonly string[] = [], rules: path.PlatformPath = platformRules()): boolean {
	if (rules.isAbsolute(text)) {
		for (const folder of chosen) {
			const below = rules.relative(folder, text);
			if (below === "" || !climbs(rules.relative(text, folder), rules)) return false;
			if (!climbs(below, rules)) return refusedText(below, rules);
		}
	}
	return refusedText(text, rules);
}

/** Why a walk stopped: a refused shape, or a chain of more links than it follows (none, where links are refused), past which nothing was checked. */
export type Refusal = "shape" | "links";

/** Thrown before any call on a place whose shape is refused, or that lies past more links than the walk follows. */
export class PlaceRefused extends Error {
	constructor(readonly place: string, readonly why: Refusal = "shape") {
		super(why === "shape" ? placeRefused(place) : `${place} is past more links than are followed`);
	}
}

function refuse(place: string, chosen: readonly string[]): void {
	if (refusedShape(place, chosen)) throw new PlaceRefused(place);
}

const partsOf = (text: string): string[] => text.split(path.sep === "\\" ? /[\\/]/ : "/");

// The kernel gives up on a chain this long.
const LINK_HOPS_LIMIT = 40;

/**
 * `links: "refuse"`: a link anywhere on the way is refused before its text is
 * read, where the walk would follow it. `stopAt`: folders where the walk stops,
 * told by their identity on the disk, not their names (on a Mac
 * /System/Volumes/Data/Users is /Users): the first folder on the way that is
 * one of them ends the walk before anything inside it is looked at, so no link
 * there is read or followed.
 */
export interface WalkOptions {
	links?: "refuse";
	stopAt?: readonly string[];
}

/**
 * Where a path really is, and the real folders that held a link on the way.
 * `stoppedAt`: where the way entered a `stopAt` folder, spelled as the way led
 * there and never resolved; null when a `..` is left on the way past it, since
 * where that leads can't be told without looking inside. `real` is then the
 * same path, or the stop folder.
 */
export interface WalkedPlace {
	real: string;
	linkPlaces: string[];
	stoppedAt?: string | null;
}

/** A folder's identity on its disk, or undefined for anything but a folder. */
function folderIdentity(stat: fs.BigIntStats | undefined): string | undefined {
	return stat?.isDirectory() ? `${stat.dev}:${stat.ino}` : undefined;
}

/** The identities of the `stopAt` folders that can be read; one that can't stops nothing, as the walk can't look inside it either. */
function stopIdentities(folders: readonly string[]): Set<string> {
	return new Set(folders.flatMap((folder) => {
		try {
			return folderIdentity(fs.statSync(folder, { bigint: true, throwIfNoEntry: false })) ?? [];
		} catch {
			return [];
		}
	}));
}

/**
 * A path the walk has already followed every link of, as the disk spells it: on
 * a disk that ignores case or Unicode form, `SALES` opens `Sales`. This one system
 * resolve is for the spelling only: the path has no link left, so it follows
 * nothing the walk didn't check, and it lists no folder, which in the box only the
 * box's own program may do in a room. Its window is the one every later call by
 * name has: a job left running can swap a checked folder for a link before it.
 */
function diskSpelling(place: string): string {
	try {
		return fs.realpathSync.native(place);
	} catch {
		return place;
	}
}

/**
 * A path a room handed over, resolved here instead of by the system: from the
 * disk's root a part at a time, each part's shape checked before its `lstat`, and
 * each link's text checked, and joined to where the link sits, before it is
 * followed. So a link above the folders, as macOS's `/var`, still resolves, and
 * one to a network place is refused with no call on its target. A part not there
 * yet ends the walk, as a write may make it. `chosen` as for `refusedShape`.
 * Throws PlaceRefused.
 */
export function walkPlace(target: string, chosen: readonly string[] = [], options: WalkOptions = {}): WalkedPlace {
	refuse(target, chosen);
	const start = path.resolve(target);
	refuse(start, chosen);
	const parts = partsOf(start.slice(path.parse(start).root.length));
	const linkPlaces: string[] = [];
	const stops = options.stopAt && stopIdentities(options.stopAt);
	let at = path.parse(start).root;
	let hops = 0;
	while (parts.length > 0) {
		const part = parts.shift() as string;
		if (part === "" || part === ".") continue;
		if (part === "..") {
			at = path.dirname(at);
			continue;
		}
		const next = path.join(at, part);
		refuse(next, chosen);
		let link: string | null = null;
		let refusedLink = false;
		try {
			const stat = stops ? fs.lstatSync(next, { bigint: true }) : fs.lstatSync(next);
			if (stops?.has(folderIdentity(stat as fs.BigIntStats) ?? "")) {
				const stoppedAt = parts.includes("..") ? null : path.join(next, ...parts);
				refuse(stoppedAt ?? next, chosen);
				return { real: stoppedAt ?? next, linkPlaces, stoppedAt };
			}
			const isLink = stat.isSymbolicLink();
			refusedLink = isLink && options.links === "refuse";
			link = isLink && !refusedLink ? fs.readlinkSync(next) : null;
		} catch {
			// Not there, or not open to this person. A `..` past it is later taken by name, so the name it leaves is walked on: a link there still leads somewhere.
			if (parts.includes("..")) {
				const named = path.join(at, part, ...parts);
				at = path.parse(named).root;
				parts.splice(0, parts.length, ...partsOf(named.slice(at.length)));
				continue;
			}
			// The rest is named as given, as the system's own walk does.
			const real = path.join(diskSpelling(at), part, ...parts);
			refuse(real, chosen);
			return { real, linkPlaces };
		}
		if (refusedLink) throw new PlaceRefused(next, "links");
		if (link === null) {
			at = next;
			continue;
		}
		refuse(link, chosen);
		refuse(path.resolve(at, link), chosen);
		linkPlaces.push(diskSpelling(at));
		if ((hops += 1) > LINK_HOPS_LIMIT) throw new PlaceRefused(next, "links");
		if (path.isAbsolute(link)) at = path.parse(path.resolve(at, link)).root;
		parts.unshift(...partsOf(link.slice(path.parse(link).root.length)));
	}
	const real = diskSpelling(at);
	refuse(real, chosen);
	return { real, linkPlaces };
}

/** A path's real place by `walkPlace`, or null when the walk refused it. */
export function realPlace(target: string, options: WalkOptions = {}): string | null {
	try {
		return walkPlace(target, [], options).real;
	} catch (error) {
		if (error instanceof PlaceRefused) return null;
		throw error;
	}
}
