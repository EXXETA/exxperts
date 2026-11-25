import fs from "node:fs";
import path from "node:path";

import { localPath, variable } from "./box-request.js";

const win = path.win32;

// Where Windows' own python.exe, which opens the Store, and the install manager's commands lie: no program a protected room can run.
const STAND_INS = /\\(?:Microsoft\\WindowsApps|Local\\Python\\bin)$/i;

const driveOf = (place: string): string | undefined => localPath(place)?.slice(0, 2).toLowerCase();

const isStandIn = (folder: string): boolean => STAND_INS.test(localPath(folder) ?? "");

/** A real program, not a link or a stand-in of no length. */
function isProgram(file: string): boolean {
	try {
		const stat = fs.lstatSync(file);
		return stat.isFile() && stat.size > 0;
	} catch {
		return false;
	}
}

/** The plain subfolders of a folder, links left out; none when it can't be read. */
function subfolders(folder: string): string[] {
	try {
		return fs.readdirSync(folder, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
	} catch {
		return [];
	}
}

/** The newest Python that python.org's installer or its install manager put in one of its three places: 64-bit, not free-threaded. */
function installedPython(environment: Readonly<Record<string, string | undefined>>): string | undefined {
	const place = (name: string, ...inside: string[]) => {
		const value = variable(environment, name);
		const root = value === undefined ? undefined : localPath(value);
		return root === undefined ? undefined : win.join(root, ...inside);
	};
	const places: [string | undefined, RegExp][] = [
		[place("LOCALAPPDATA", "Programs", "Python"), /^Python3(\d{1,2})$/i],
		[place("LOCALAPPDATA", "Python"), /^pythoncore-3\.(\d{1,2})-64$/i],
		[place("ProgramFiles"), /^Python3(\d{1,2})$/i],
	];
	const found = places.flatMap(([folder, name]) =>
		folder === undefined ? [] : subfolders(folder).flatMap((entry) => {
			const minor = name.exec(entry)?.[1];
			const python = win.join(folder, entry);
			return minor !== undefined && isProgram(win.join(python, "python.exe")) ? [{ python, minor: Number(minor) }] : [];
		}),
	);
	return found.sort((a, b) => b.minor - a.minor)[0]?.python;
}

/**
 * The person's PATH for a protected room, with an installed Python where `python`
 * would lead to a stand-in or to nothing: python.org's install manager puts its
 * runtime on no search path, and its older installer doesn't by its usual
 * answers. A PATH that leads to a Python stays as it is. Only PATH folders on
 * Windows' own drive are read for that: the read holds the server, and a mapped
 * drive that doesn't answer could hold it past the start's wait. A Python on
 * another drive leads nowhere then, and comes first all the same, since the
 * installed one goes behind the folders before the stand-ins.
 */
export function withInstalledPython(pathFolders: readonly string[], environment: Readonly<Record<string, string | undefined>>): string[] {
	const standIn = pathFolders.findIndex(isStandIn);
	const at = standIn === -1 ? pathFolders.length : standIn;
	const drive = driveOf(variable(environment, "SystemRoot") ?? "");
	const leadsToPython = pathFolders.slice(0, at).some((value) => {
		const folder = localPath(value);
		return folder !== undefined && driveOf(folder) === drive && isProgram(win.join(folder, "python.exe"));
	});
	const python = leadsToPython ? undefined : installedPython(environment);
	if (python === undefined) return [...pathFolders];
	const scripts = subfolders(python).filter((name) => name.toLowerCase() === "scripts").map((name) => win.join(python, name));
	return [...pathFolders.slice(0, at), python, ...pathFolders.slice(at), ...scripts];
}
