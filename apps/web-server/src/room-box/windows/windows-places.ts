import { spawnSync } from "node:child_process";
import path from "node:path";

import { atOrInside, localPath } from "./box-request.js";
import { encodedCommand, windowsPowerShell } from "./command-line.js";
import { FOLDERS_SCRIPT } from "./personal-folders.js";

const win = path.win32;

/** The places on Windows no yes may open, as Windows named them. Every path is a full path. */
export interface WindowsPlaces {
	/** Her profile folder, as Windows names it and as the server runs under it. Each is refused as the holder of its AppData, never the folders inside it for that. */
	profiles: string[];
	/** AppData, Roaming, Local and LocalLow: refused with all they hold, but for a OneDrive folder in them and a profile that sits in them. */
	appData: string[];
	/** Each OneDrive folder Windows names. */
	oneDrives: string[];
	/** Refused with all they hold, and every folder that holds one: Startup, the programs installed for her alone, PATH, Program Files, Windows, ProgramData, the app's own data, other tools' folders. */
	closed: string[];
}

/** What the caller knows beside Windows' answers: the server's other homes, such as a moved data folder, the app's data and the names of other tools' folders in a home. */
export interface PlacesGiven {
	homes: readonly string[];
	appData: readonly string[];
	toolNames: readonly string[];
}

/** A full path a place may be named by: a drive's (`C:\...`) or a share's (`\\host\share\...`), never a device or relative one. Without a closing backslash but at a root. */
function fullPath(value: string): string | undefined {
	const given = value.trim().replace(/^"(.*)"$/, "$1");
	if (!/^([A-Za-z]:[\\/]|[\\/]{2}[^\\/?.])/.test(given) || given.includes("\0")) return undefined;
	const normal = win.normalize(given);
	return win.parse(normal).root === normal ? normal : normal.replace(/\\+$/, "");
}

/** A name's value, whatever its case: Windows names ignore case. */
function variable(environment: Readonly<Record<string, string | undefined>>, name: string): string {
	const found = Object.keys(environment).find((key) => key.toLowerCase() === name.toLowerCase());
	return found === undefined ? "" : (environment[found] ?? "");
}

function answerFields(answer: string): Record<string, unknown> {
	try {
		const parsed: unknown = JSON.parse(answer);
		return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
	} catch {
		return {};
	}
}

const places = (values: readonly unknown[]): string[] => {
	const seen = new Set<string>();
	return values.flatMap((value) => {
		const place = typeof value === "string" ? fullPath(value) : undefined;
		if (place === undefined || seen.has(place.toLowerCase())) return [];
		seen.add(place.toLowerCase());
		return [place];
	});
};

/**
 * The places from Windows' answer to `FOLDERS_SCRIPT`, its environment and
 * PATH: the environment's name beside the known folder's where both exist, and
 * AppData and other tools' folders by their usual places in each home. A
 * profile may sit in AppData, as each smoke's home does in the temp folder; a
 * data folder moved there is no profile, and opens nothing. An answer that can't be
 * read leaves the environment's names and AppData's usual place; Startup and
 * her own programs then count as in AppData, where Windows puts them, and no
 * OneDrive in AppData is opened.
 */
export function windowsPlaces(answer: string, environment: Readonly<Record<string, string | undefined>>, given: PlacesGiven): WindowsPlaces {
	const told = answerFields(answer);
	const env = (name: string) => variable(environment, name);
	const profiles = places([told.profile, env("USERPROFILE")]);
	const homes = places([...profiles, ...given.homes]);
	const oneDrives = places(([] as unknown[]).concat(told.onedrive ?? []));
	const appData = places([
		...homes.map((home) => win.join(home, "AppData")),
		told.roaming, env("APPDATA"), told.local, env("LOCALAPPDATA"), told.locallow,
	]);
	const closed = places([
		told.startup,
		told.programs,
		...env("Path").split(";"),
		told.programfiles, told.programfilesx86, env("ProgramFiles"), env("ProgramFiles(x86)"), env("ProgramW6432"),
		told.programdata, env("ProgramData"),
		told.windows, env("SystemRoot"),
		...given.appData,
		...homes.flatMap((home) => given.toolNames.map((name) => win.join(home, name))),
	]);
	return { profiles, appData, oneDrives, closed };
}

/**
 * Each place by its name and, on this computer's own drives, by its real path
 * too, as `real` gives it. A place named on a share is judged by its name only:
 * resolving it would dial the share at each judgement.
 */
export function withRealPaths(known: WindowsPlaces, real: (place: string) => string): WindowsPlaces {
	const both = (list: readonly string[]) => places(list.flatMap((place) => (localPath(place) === undefined ? [place] : [place, real(place)])));
	return { profiles: both(known.profiles), appData: both(known.appData), oneDrives: both(known.oneDrives), closed: both(known.closed) };
}

/**
 * Whether a yes on this folder, or this folder as a room's, would open a place
 * on Windows no yes may open: a drive's or a share's root, a folder in AppData
 * (but in a OneDrive or her profile there) or one that holds it, which covers
 * her profile and what holds it, since it holds its AppData, and a folder in a
 * closed place or one that holds it. A folder that isn't a full path, or a
 * computer with no profile, is refused.
 */
export function windowsRefuses(folder: string, known: WindowsPlaces): boolean {
	const place = fullPath(folder);
	if (place === undefined || known.profiles.length === 0) return true;
	if (win.parse(place).root === place) return true;
	const kept = (area: string) => [...known.oneDrives, ...known.profiles].some((open) => atOrInside(place, open) && atOrInside(open, area));
	if (known.appData.some((area) => atOrInside(area, place) || (atOrInside(place, area) && !kept(area)))) return true;
	return known.closed.some((closed) => atOrInside(closed, place) || atOrInside(place, closed));
}

/** Windows PowerShell by its full path under Windows' own folder, or nothing where the environment names no full one. */
export function systemPowerShell(environment: Readonly<Record<string, string | undefined>>): string | undefined {
	const systemRoot = fullPath(variable(environment, "SystemRoot"));
	return systemRoot === undefined ? undefined : windowsPowerShell(systemRoot);
}

/** Windows' answer to `FOLDERS_SCRIPT` from Windows PowerShell under its own folder, with no network, or nothing when none could be read. */
function askWindows(environment: Readonly<Record<string, string | undefined>>): string | undefined {
	const powerShell = systemPowerShell(environment);
	if (powerShell === undefined) return undefined;
	const asked = spawnSync(powerShell, ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encodedCommand(FOLDERS_SCRIPT)], { encoding: "utf8", timeout: 20_000, windowsHide: true });
	const answer = asked.status === 0 ? asked.stdout.trim() : "";
	return Object.keys(answerFields(answer)).length > 0 ? answer : undefined;
}

const ASK_AGAIN_AFTER_MS = 60_000;
let answered: string | undefined;
let failedAt = Number.NEGATIVE_INFINITY;

/**
 * Windows' answer to `FOLDERS_SCRIPT`, kept once it was read: Windows' places
 * don't move while the server runs. A failed read is asked again a minute
 * later, not at each judgement, and until then the answer is none: the
 * environment and AppData's usual place still refuse, and only a Startup,
 * LocalLow or her own programs folder that Windows redirected out of AppData
 * stays grantable until an answer is read. Refusing every folder instead would
 * stop every room where PowerShell is blocked.
 */
export function windowsAnswer(environment: Readonly<Record<string, string | undefined>>, ask = askWindows, now = Date.now()): string {
	if (answered !== undefined) return answered;
	if (now - failedAt < ASK_AGAIN_AFTER_MS) return "";
	const answer = ask(environment);
	if (answer === undefined) {
		failedAt = now;
		return "";
	}
	answered = answer;
	return answer;
}

/** Windows' answer only if it was already read: never asks, so nothing starts. */
export function keptWindowsAnswer(): string | undefined {
	return answered;
}

/** The person's Desktop, Documents and Downloads, and every OneDrive folder, as Windows' answer to `FOLDERS_SCRIPT` names them: full paths only. */
export function personalFolders(answer: string): { desktop?: string; documents?: string; downloads?: string; oneDrives: string[] } {
	const told = answerFields(answer);
	const one = (value: unknown) => places([value])[0];
	return { desktop: one(told.desktop), documents: one(told.documents), downloads: one(told.downloads), oneDrives: places(([] as unknown[]).concat(told.onedrive ?? [])) };
}
