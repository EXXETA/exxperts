/**
 * Windows' search path, read again. A program installed while the server runs
 * is only on Windows' own search path, and the server has the one from its
 * start. A connector's check that found no program asks here once
 * (`testMcpServer` in ../../mcp-admin.ts); nothing else does.
 *
 * Only folders of the places installers use are added, and every one of those
 * is closed to every room as its own folder, on its list and for one yes
 * (`windowsRefuses` in windows-places.ts, `programFolders` in
 * ../folder-offer.ts; scripts/windows-search-path-smoke.ts pins it). So
 * adding one gives no room anything and closes nothing a room has, and no
 * connector start is refused for it. A place is listed here only while that
 * holds.
 */

import { execFile } from "node:child_process";
import path from "node:path";

import { appDataPlaces, homeFolders, realPathOf } from "../box-closed.js";
import { atOrInside, localPath, variable } from "./box-request.js";
import { defaultBoxRoot } from "./box-root.js";
import { encodedCommand, windowsPowerShell } from "./command-line.js";
import { keptWindowsAnswer, windowsPlaces, withRealPaths } from "./windows-places.js";

const win = path.win32;

/** Windows' own two search paths as they are now, as JSON in plain ASCII. */
const SCRIPT = `
$paths = @([Environment]::GetEnvironmentVariable('Path', 'Machine'), [Environment]::GetEnvironmentVariable('Path', 'User'))
$json = ConvertTo-Json -Compress -InputObject @($paths | ForEach-Object { [string]$_ })
$out = New-Object System.Text.StringBuilder
foreach ($ch in $json.ToCharArray()) {
  if ([int]$ch -gt 127) { [void]$out.Append('\\u' + ([int]$ch).ToString('x4')) } else { [void]$out.Append($ch) }
}
$out.ToString()
`;

const LIMIT_MS = 10_000;

/** The computer a read is for. */
export interface SearchPathPc {
	/** Holds PATH, which the new folders are added to, and the names of the installers' places. */
	environment: Record<string, string | undefined>;
	/** The homes whose `.local\bin` and `.cargo\bin` count. */
	homes: readonly string[];
	/** The box's own root and the app's data: no folder at, in or above one is added, since a command may write there. */
	own: readonly string[];
	/** The folders in AppData a room may be given: a place at, in or above one isn't listed. */
	open: readonly string[];
	real: (place: string) => string;
	limitMs: number;
}

/** The OneDrive folders and profiles that lie in AppData, which `windowsRefuses` keeps open, by Windows' answer as it was last read. */
export function openInAppData(answer: string, environment: SearchPathPc["environment"], homes: readonly string[], real: (place: string) => string): string[] {
	const known = withRealPaths(windowsPlaces(answer, environment, { homes, appData: [], toolNames: [] }), real);
	return [...known.oneDrives, ...known.profiles].filter((open) => known.appData.some((area) => atOrInside(open, area)));
}

/** This computer, as a read by the check sees it. Windows is asked nothing for it. */
export const thisPc = (): SearchPathPc => ({ environment: process.env, homes: homeFolders(), own: [defaultBoxRoot(), ...appDataPlaces()], open: openInAppData(keptWindowsAnswer() ?? "", process.env, homeFolders(), realPathOf), real: realPathOf, limitMs: LIMIT_MS });

/** Where Windows' installers put programs for the search path, and nothing else: each by its name, and by its root's real path, so a link at or inside one leads out of it. */
export function installerPlaces(pc: SearchPathPc): string[] {
	const at = (root: string | undefined, ...names: string[]) => {
		const place = root === undefined ? undefined : localPath(root);
		return place === undefined ? [] : [place, pc.real(place)].map((each) => win.join(each, ...names));
	};
	const named = (name: string) => variable(pc.environment, name);
	return [
		...["ProgramFiles", "ProgramFiles(x86)", "ProgramW6432"].flatMap((name) => at(named(name))),
		...at(named("LOCALAPPDATA"), "Programs"),
		...at(named("LOCALAPPDATA"), "Microsoft", "WinGet", "Links"),
		...at(named("LOCALAPPDATA"), "Python", "bin"),
		...at(named("APPDATA"), "npm"),
		...pc.homes.flatMap((home) => [...at(home, ".local", "bin"), ...at(home, ".cargo", "bin")]),
	].filter((place) => !pc.open.some((open) => atOrInside(place, open) || atOrInside(open, place)));
}

/** A search path's folders as full local paths, out of their quotes. */
const foldersOf = (searchPath: string): string[] => searchPath.split(";").flatMap((entry) => localPath(entry.trim().replace(/^"(.*)"$/, "$1")) ?? []);

/** The folders of Windows' search paths that `known` lacks and that count, in their order. */
export function newFolders(known: string, told: readonly string[], pc: SearchPathPc): string[] {
	const places = installerPlaces(pc);
	const own = pc.own.flatMap((place) => [place, pc.real(place)]);
	const counts = (place: string) => localPath(place) !== undefined && places.some((listed) => atOrInside(place, listed)) && !own.some((closed) => atOrInside(place, closed) || atOrInside(closed, place));
	const seen = new Set(foldersOf(known).map((folder) => folder.toLowerCase()));
	return told.flatMap(foldersOf).filter((folder) => {
		const key = folder.toLowerCase();
		if (seen.has(key)) return false;
		seen.add(key);
		// By its name first: the real path of a folder that doesn't count is never asked for.
		return counts(folder) && counts(pc.real(folder));
	});
}

/** Windows' search paths for the computer and for the person; none when they can't be read. */
async function askWindows(pc: SearchPathPc): Promise<string[]> {
	const systemRoot = localPath(variable(pc.environment, "SystemRoot") ?? "");
	if (systemRoot === undefined) return [];
	try {
		const told = await new Promise<string>((resolve, reject) => {
			execFile(windowsPowerShell(systemRoot), ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encodedCommand(SCRIPT)], { timeout: pc.limitMs, windowsHide: true, encoding: "utf8" }, (error, stdout) => (error ? reject(error) : resolve(stdout)));
		});
		const paths: unknown = JSON.parse(told.trim().split(/\r?\n/).at(-1) ?? "");
		return Array.isArray(paths) ? paths.filter((value): value is string => typeof value === "string") : [];
	} catch {
		return [];
	}
}

/** The read in flight. A restart ends it with the check that asked; the new process has Windows' search path from its start. */
let asking: Promise<void> | null = null;

/** Asks Windows for its search path and adds to PATH the folders that count and it lacks. Reads that overlap share one; a failed one changes nothing. */
export function rereadWindowsSearchPath(pc: SearchPathPc = thisPc()): Promise<void> {
	asking ??= askWindows(pc)
		.then((told) => {
			const known = variable(pc.environment, "PATH") ?? "";
			const added = newFolders(known, told, pc);
			if (added.length > 0) pc.environment.PATH = [known, ...added].filter(Boolean).join(";");
		})
		.finally(() => {
			asking = null;
		});
	return asking;
}
