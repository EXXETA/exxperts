// Windows' search path, read again after a connector's check found no program
// (windows-search-path.ts), with path.win32 on any computer: what is added, in
// which order, and which folders count; what is left out, by its name and by
// its real path; the question itself, through a stand-in for Windows PowerShell
// (elsewhere than on Windows) or the real one (on Windows); and the pin: every
// place a folder may be added from is closed to every room, in it, at it and
// above it, before and after it is added.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { appDataPlaces, homeFolders, realPathOf } from "../src/room-box/box-closed.js";
import { folderGrantable, HOME_TOOL_PLACES, roomFolderGrantable, soundFolders } from "../src/room-box/folder-offer.js";
import { defaultBoxRoot } from "../src/room-box/windows/box-root.js";
import { windowsAnswer, windowsPlaces, windowsRefuses, withRealPaths } from "../src/room-box/windows/windows-places.js";
import { installerPlaces, newFolders, openInAppData, rereadWindowsSearchPath, thisPc, type SearchPathPc } from "../src/room-box/windows/windows-search-path.js";

let failed = 0;
async function row(name: string, body: () => Promise<void> | void): Promise<void> {
	try {
		await body();
		console.log(`ok: ${name}`);
	} catch (error) {
		failed += 1;
		console.error(`FAIL: ${name}\n${(error as Error).stack}`);
	}
}
function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}
const show = (value: unknown) => JSON.stringify(value);
const same = (got: unknown, expected: unknown, what: string) => assert(show(got) === show(expected), `${what}: ${show(got)}, not ${show(expected)}`);

// ---- A person's PC ------------------------------------------------------------
const HOME = String.raw`C:\Users\Ana Müller`;
const LOCAL = `${HOME}\\AppData\\Local`;
const ROAMING = `${HOME}\\AppData\\Roaming`;
const PROGRAMS = `${LOCAL}\\Programs`;
const BOX_ROOT = `${HOME}\\.exxperts.box`;
const APP_DATA = `${HOME}\\.exxperts`;
const SYSTEM = String.raw`C:\Windows\system32`;
const NODE = String.raw`C:\Program Files\nodejs`;
const NAMES = { ProgramFiles: String.raw`C:\Program Files`, "ProgramFiles(x86)": String.raw`C:\Program Files (x86)`, ProgramW6432: String.raw`C:\Program Files`, LOCALAPPDATA: LOCAL, APPDATA: ROAMING, ProgramData: String.raw`C:\ProgramData`, SystemRoot: String.raw`C:\Windows` };

/** The PC, with `links`: the real path of a place, for it and all it holds. */
function pc(more: Partial<SearchPathPc> = {}, links: Record<string, string> = {}): SearchPathPc {
	const real = (place: string) => {
		const link = Object.keys(links).find((from) => place.toLowerCase() === from.toLowerCase() || place.toLowerCase().startsWith(`${from.toLowerCase()}\\`));
		return link === undefined ? place : links[link] + place.slice(link.length);
	};
	return { environment: { ...NAMES }, homes: [HOME], own: [BOX_ROOT, APP_DATA], open: [], real, limitMs: 10_000, ...more };
}
const added = (told: readonly string[], known = SYSTEM, at = pc()) => newFolders(known, told, at);
const counts = (folder: string, at = pc()) => added([folder], SYSTEM, at).length === 1;

await row("new folders are added in their order, the computer's before the person's", () => {
	same(added([`${SYSTEM};${NODE};C:\\Program Files\\Git\\cmd`, `${ROAMING}\\npm;${HOME}\\.local\\bin`]), [NODE, String.raw`C:\Program Files\Git\cmd`, `${ROAMING}\\npm`, `${HOME}\\.local\\bin`], "the order");
});
await row("a folder PATH has in other letters, with a closing backslash, with slashes or in quotes isn't added, nor one twice", () => {
	for (const known of [NODE.toUpperCase(), `${NODE}\\`, `"${NODE}"`, `"${NODE}\\"`, NODE.replaceAll("\\", "/"), `  ${NODE} `]) same(added([NODE, ""], `${SYSTEM};${known}`), [], known);
	for (const told of [NODE.toUpperCase(), `${NODE}\\`, `"${NODE}"`]) same(added([told, ""], `${SYSTEM};${NODE}`), [], `told as ${told}`);
	same(added([NODE, `${NODE}\;${NODE.toLowerCase()}`]), [NODE], "told three times");
});
await row("a folder told with a closing backslash or in quotes is added as a plain path, and an umlaut stays", () => {
	same(added([`${NODE}\;"${PROGRAMS}\\Müller Werkzeuge\\bin"`, ""]), [NODE, `${PROGRAMS}\\Müller Werkzeuge\\bin`], "plain paths");
});
await row("a relative, drive-relative, device, network or unread name is never added", () => {
	for (const folder of ["tools", ".", String.raw`Program Files\nodejs`, String.raw`\Program Files\nodejs`, String.raw`C:Program Files\nodejs`, String.raw`\\?\C:\Program Files\nodejs`, String.raw`\\.\C:\Program Files\nodejs`, String.raw`\\fs01\Program Files\nodejs`, String.raw`%ProgramFiles%\nodejs`, ""]) same(added([folder, ""]), [], folder);
});

const LISTED = [
	String.raw`C:\Program Files`, String.raw`C:\Program Files (x86)`, PROGRAMS, `${LOCAL}\\Microsoft\\WinGet\\Links`, `${LOCAL}\\Python\\bin`, `${ROAMING}\\npm`, `${HOME}\\.local\\bin`, `${HOME}\\.cargo\\bin`,
];
await row("each place installers use counts, at it and in it, in other letters too, and no other is listed", () => {
	for (const place of LISTED) for (const folder of [place, `${place}\\tool\\bin`, place.toUpperCase(), `${place.toLowerCase()}\\tool`, `${place}\\..\\${path.win32.basename(place)}\\tool`]) assert(counts(folder), `left out: ${folder}`);
	same([...new Set(installerPlaces(pc()))].sort(), [...LISTED].sort(), "the list");
	assert(counts(String.raw`D:\Programme\nodejs`, pc({ environment: { ProgramW6432: String.raw`D:\Programme` } })), "ProgramW6432 alone");
	assert(counts(`${PROGRAMS}\\tool`, pc({ environment: { localappdata: LOCAL } })), "a variable in other letters");
	assert(counts(String.raw`D:\Home\.cargo\bin`, pc({ homes: [HOME, String.raw`D:\Home`] })), "another home's");
});
await row("every other place is left out: one that only holds a listed place, the person's own, another tool's, a system's", () => {
	for (const folder of [
		HOME, `${HOME}\\.local`, `${HOME}\\.cargo`, `${HOME}\\AppData`, LOCAL, ROAMING, `${LOCAL}\\Microsoft`, `${LOCAL}\\Microsoft\\WinGet`, `${LOCAL}\\Python`, "C:\\", String.raw`C:\Users`,
		String.raw`C:\tools`, `${HOME}\\bin`, `${HOME}\\Documents\\tools`, `${HOME}\\scoop\\shims`, String.raw`C:\ProgramData\chocolatey\bin`, String.raw`C:\ProgramData`, SYSTEM, String.raw`D:\Program Files\nodejs`,
		`${LOCAL}\\Python\\pythoncore-3.15-64`, `${LOCAL}\\Microsoft\\WindowsApps`, `${LOCAL}\\Microsoft\\WinGet\\Packages\\x`, `${LOCAL}\\Temp\\x`, `${LOCAL}\\npm`, `${ROAMING}\\npm-cache`, `${ROAMING}\\Python\\Scripts`,
		String.raw`C:\Program Files2\x`, `${PROGRAMS}2`, `${ROAMING}\\npm2`, `${HOME}\\.local\\bin2`, `${HOME}\\.local\\share`, String.raw`C:\Program Files\..\tools`,
	]) assert(!counts(folder), `added: ${folder}`);
});
await row("where a variable is missing or names a share, its place isn't listed", () => {
	const none = pc({ environment: {} });
	for (const folder of [NODE, `${PROGRAMS}\\x`, `${ROAMING}\\npm`]) assert(!counts(folder, none), `added: ${folder}`);
	assert(counts(`${HOME}\\.local\\bin`, none), "the home's, which no variable names");
	const share = String.raw`\\fs01\profiles\Ana\AppData\Roaming`;
	const asked: string[] = [];
	const onShare = pc({ environment: { ...NAMES, APPDATA: share } });
	const real = onShare.real;
	onShare.real = (place) => (asked.push(place), real(place));
	for (const folder of [`${share}\\npm`, `${ROAMING}\\npm`]) assert(!counts(folder, onShare), `added: ${folder}`);
	assert(!asked.some((place) => place.startsWith("\\\\")), `a share was dialled: ${show(asked)}`);
});
await row("the box's own root and the app's data are left out, at them, in them and above them", () => {
	const box = (root: string) => [root, `${root}\\0f3a\\caches`, `${root}\\0f3a\\caches\\npm\\bin`, `${root}\\0f3a\\temp-1`, root.toUpperCase()];
	for (const folder of [...box(BOX_ROOT), APP_DATA, `${APP_DATA}\\agent\\bin`]) assert(!counts(folder), `at the usual place: ${folder}`);
	// A portable copy's data folder inside AppData\Local\Programs, a listed place.
	const copy = `${PROGRAMS}\\exxperts`;
	const data = `${copy}\\data`;
	const portable = pc({ homes: [HOME, data], own: [`${data}\\.exxperts.box`, `${data}\\.exxperts`] });
	for (const folder of [...box(`${data}\\.exxperts.box`), `${data}\\.exxperts`, `${data}\\.exxperts\\app\\bin`, data, copy, PROGRAMS]) assert(!counts(folder, portable), `a portable copy's: ${folder}`);
	for (const folder of [`${PROGRAMS}\\Python\\Python314`, `${PROGRAMS}\\exxperts2`, `${data}\\.exxperts.boxes`, NODE]) assert(counts(folder, portable), `left out beside it: ${folder}`);
	// The same data by a link's name: the box's root is closed by its real path too.
	const linked = pc({ own: [String.raw`D:\data\.exxperts.box`] }, { "D:\\data": data });
	assert(!counts(`${data}\\.exxperts.box\\0f3a\\caches`, linked) && counts(`${PROGRAMS}\\tool`, linked), "the box's root by its real path");
	// A listed folder that leads into the app's data.
	assert(!counts(`${PROGRAMS}\\tool`, pc({}, { [`${PROGRAMS}\\tool`]: `${APP_DATA}\\agent` })), "a link into the app's data");
});
await row("a link: one inside a listed place that leads out, one at a listed place, and one outside that leads in are left out; a moved root counts", () => {
	assert(!counts(`${PROGRAMS}\\tool`, pc({}, { [`${PROGRAMS}\\tool`]: `${HOME}\\Documents\\tool` })), "leads out of it");
	assert(!counts(`${ROAMING}\\npm`, pc({}, { [`${ROAMING}\\npm`]: String.raw`D:\npm` })), "the listed place is a link");
	assert(!counts(`${HOME}\\Documents\\tool`, pc({}, { [`${HOME}\\Documents\\tool`]: `${PROGRAMS}\\tool` })), "leads in");
	assert(!counts(String.raw`C:\Program Files\tool`, pc({}, { "C:\\Program Files\\tool": String.raw`\\fs01\tool` })), "leads to a share");
	assert(counts(`${PROGRAMS}\\tool`, pc({}, { [`${PROGRAMS}\\tool`]: `${PROGRAMS}\\other` })), "leads to another folder in it");
	assert(counts(`${PROGRAMS}\\tool`, pc({}, { [LOCAL]: String.raw`E:\Moved\Local` })), "AppData\\Local itself moved to another drive");
	const asked: string[] = [];
	const watched = pc();
	newFolders(SYSTEM, [String.raw`Z:\tools;C:\tools`], { ...watched, real: (place) => (asked.push(place), place) });
	assert(!asked.some((place) => /tools/.test(place)), `the real path of a folder that doesn't count was asked: ${show(asked)}`);
});
await row("a read on this computer closes its box root and its app's data, for every home", () => {
	const here = thisPc();
	same(here.own, [defaultBoxRoot(), ...appDataPlaces()], "own places");
	same(here.homes, homeFolders(), "homes");
	assert(here.environment === process.env && here.real === realPathOf && here.limitMs === 10_000, "the server's own PATH, real paths and 10 s");
});

// ---- The question --------------------------------------------------------------
const work = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "windows-search-path-")));
const serverPath = process.env.PATH;
const SCRIPT = `
$paths = @([Environment]::GetEnvironmentVariable('Path', 'Machine'), [Environment]::GetEnvironmentVariable('Path', 'User'))
$json = ConvertTo-Json -Compress -InputObject @($paths | ForEach-Object { [string]$_ })
$out = New-Object System.Text.StringBuilder
foreach ($ch in $json.ToCharArray()) {
  if ([int]$ch -gt 127) { [void]$out.Append('\\u' + ([int]$ch).ToString('x4')) } else { [void]$out.Append($ch) }
}
$out.ToString()
`;
try {
	if (process.platform === "win32") {
		await row("the real Windows PowerShell tells this PC's search path, and what counts of it is added once", async () => {
			const here = { ...thisPc(), environment: { ...process.env } };
			for (const name of Object.keys(here.environment)) if (name.toLowerCase() === "path") delete here.environment[name];
			here.environment.PATH = SYSTEM;
			await rereadWindowsSearchPath(here);
			const folders = here.environment.PATH.split(";");
			const listed = installerPlaces(here);
			assert(folders[0] === SYSTEM && folders.length > 1, `nothing was added: ${show(folders)}`);
			for (const folder of folders.slice(1)) assert(listed.some((place) => folder.toLowerCase().startsWith(place.toLowerCase())), `added from no listed place: ${folder}`);
			const after = here.environment.PATH;
			await rereadWindowsSearchPath(here);
			same(here.environment.PATH, after, "asked again");
		});
	} else {
		// Windows PowerShell by its Windows path is here one file name, in a folder on PATH.
		const bin = path.join(work, "bin");
		fs.mkdirSync(bin);
		const starts = path.join(work, "starts.txt");
		const answer = path.join(work, "answer.txt");
		const standIn = path.join(bin, String.raw`C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe`);
		const install = (ends: string) => fs.writeFileSync(standIn, `#!/bin/sh\nfor each in "$@"; do printf '%s\\n' "$each"; done >> ${show(starts)}\necho . >> ${show(starts)}\n${ends}\n`, { mode: 0o755 });
		const answers = (text: string) => {
			fs.writeFileSync(answer, text);
			install(`cat ${show(answer)}`);
		};
		const started = () => (fs.existsSync(starts) ? fs.readFileSync(starts, "utf8").split("\n").filter((line) => line === ".").length : 0);
		const powerShell = (more: Partial<SearchPathPc> = {}) => pc({ environment: { ...NAMES, SystemRoot: String.raw`C:\Windows`, PATH: SYSTEM }, ...more });
		process.env.PATH = `${bin}${path.delimiter}${serverPath}`;

		await row("Windows PowerShell is started by its full path, hidden and with no profile, with the one script, and its answer's folders are appended", async () => {
			answers(`["C:\\\\Windows\\\\system32;C:\\\\Program Files\\\\nodejs\\\\","C:\\\\Users\\\\Ana M\\u00fcller\\\\.local\\\\bin;C:\\\\tools"]\r\n`);
			const at = powerShell();
			await rereadWindowsSearchPath(at);
			same(at.environment.PATH, `${SYSTEM};${NODE};${HOME}\\.local\\bin`, "PATH");
			const args = fs.readFileSync(starts, "utf8").split("\n").slice(0, -2);
			same(args.slice(0, -1), ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand"], "the arguments");
			same(Buffer.from(args.at(-1)!, "base64").toString("utf16le"), SCRIPT, "the script");
		});
		await row("the answer is the last line, whatever a policy prints above it, and an empty or lone search path is read", async () => {
			answers(`A notice from the company\n["","C:\\\\Program Files\\\\nodejs"]\n`);
			const at = powerShell();
			await rereadWindowsSearchPath(at);
			same(at.environment.PATH, `${SYSTEM};${NODE}`, "below a notice");
			const bare = powerShell({ environment: { ...NAMES, SystemRoot: String.raw`C:\Windows` } });
			await rereadWindowsSearchPath(bare);
			same(bare.environment.PATH, NODE, "a server with no PATH");
		});
		await row("an answer that can't be read, a PowerShell that fails, is too slow or isn't there: nothing changes", async () => {
			for (const junk of ["", "not json", "{}", `"C:\\\\Program Files\\\\nodejs"`, "[1,null,{}]", "[\"C:\\\\Program Files"]) {
				answers(junk);
				const at = powerShell();
				await rereadWindowsSearchPath(at);
				same(at.environment.PATH, SYSTEM, `junk ${show(junk)}`);
			}
			const good = `["C:\\\\Program Files\\\\nodejs",""]`;
			answers(good);
			install(`cat ${show(answer)}; exit 1`);
			const fails = powerShell();
			await rereadWindowsSearchPath(fails);
			same(fails.environment.PATH, SYSTEM, "one that fails after its answer");
			install(`cat ${show(answer)}; exec sleep 60`);
			const slow = powerShell({ limitMs: 300 });
			await rereadWindowsSearchPath(slow);
			same(slow.environment.PATH, SYSTEM, "a slow one");
			const before = started();
			for (const SystemRoot of [undefined, "", "Windows", String.raw`\\fs01\Windows`]) {
				const at = powerShell({ environment: { ...NAMES, SystemRoot, PATH: SYSTEM } });
				answers(good);
				await rereadWindowsSearchPath(at);
				same(at.environment.PATH, SYSTEM, `SystemRoot ${show(SystemRoot)}`);
			}
			assert(started() === before, "PowerShell started with no Windows folder named");
			fs.rmSync(standIn);
			const gone = powerShell();
			await rereadWindowsSearchPath(gone);
			same(gone.environment.PATH, SYSTEM, "none there");
			answers(good);
			await rereadWindowsSearchPath(gone);
			same(gone.environment.PATH, `${SYSTEM};${NODE}`, "and the next read works");
		});
		await row("reads that overlap share one PowerShell, and a later one asks again", async () => {
			answers(`["C:\\\\Program Files\\\\nodejs",""]`);
			const at = powerShell();
			const before = started();
			await Promise.all([rereadWindowsSearchPath(at), rereadWindowsSearchPath(at), rereadWindowsSearchPath(at)]);
			same([at.environment.PATH, started() - before], [`${SYSTEM};${NODE}`, 1], "three at once");
			await rereadWindowsSearchPath(at);
			same([at.environment.PATH, started() - before], [`${SYSTEM};${NODE}`, 2], "a later one");
		});
		process.env.PATH = serverPath;
	}

	// ---- The pin ------------------------------------------------------------------
	// By Windows' rule, from its answer and from the environment alone, as where Windows told nothing.
	const ANSWER = JSON.stringify({ profile: HOME, roaming: ROAMING, local: LOCAL, programs: PROGRAMS, programfiles: NAMES.ProgramFiles, programfilesx86: NAMES["ProgramFiles(x86)"], windows: String.raw`C:\Windows`, onedrive: [`${HOME}\\OneDrive`] });
	const HOME_PLACES = [`${HOME}\\.local\\bin`, `${HOME}\\.cargo\\bin`];
	await row("pin: by Windows' rule no room opens a listed place, in it or above it, before and after it is added", () => {
		const moved: Record<string, string>[] = [{}, { [LOCAL]: String.raw`E:\Moved\Local`, [ROAMING]: String.raw`E:\Moved\Roaming`, "C:\\Program Files": String.raw`E:\Programme` }];
		for (const answer of [ANSWER, ""]) for (const links of moved) {
			const at = pc({}, links);
			const places = (PATH: string) => withRealPaths(windowsPlaces(answer, { ...NAMES, USERPROFILE: HOME, PATH }, { homes: [HOME], appData: [APP_DATA], toolNames: HOME_TOOL_PLACES }), at.real);
			const byRule = installerPlaces(at).filter((place) => !HOME_PLACES.includes(place));
			assert(byRule.length >= 6, `listed: ${show(byRule)}`);
			for (const place of byRule) {
				const above = [];
				for (let folder = path.win32.dirname(place); ; folder = path.win32.dirname(folder)) {
					above.push(folder);
					if (path.win32.dirname(folder) === folder) break;
				}
				for (const PATH of [SYSTEM, `${SYSTEM};${place}`, `${SYSTEM};${place}\\tool\\bin`]) for (const folder of [place, `${place}\\tool`, `${place}\\tool\\bin\\x`, place.toUpperCase(), ...above]) {
					assert(windowsRefuses(folder, places(PATH)), `${folder} can be given to a room (${place} listed, PATH ${PATH}, Windows ${answer ? "answered" : "told nothing"})`);
				}
			}
			for (const allowed of [`${HOME}\\Documents\\room`, `${HOME}\\OneDrive\\room`, String.raw`D:\room`]) for (const PATH of [SYSTEM, `${SYSTEM};${byRule.join(";")}`]) assert(!windowsRefuses(allowed, places(PATH)), `${allowed} is refused`);
		}
	});
	await row("pin: a place a OneDrive in AppData opens to a room comes off the list, and no other does", () => {
		const onlyThose = (oneDrive: string, gone: readonly string[], links: Record<string, string> = {}) => {
			const answer = JSON.stringify({ ...JSON.parse(ANSWER), onedrive: [oneDrive] });
			const at = pc({}, links);
			const open = openInAppData(answer, { ...NAMES, USERPROFILE: HOME }, [HOME], at.real);
			same([...new Set(installerPlaces({ ...at, open }))].sort(), [...new Set(installerPlaces(at))].filter((place) => !gone.includes(place)).sort(), `a OneDrive at ${oneDrive}`);
			return withRealPaths(windowsPlaces(answer, { ...NAMES, USERPROFILE: HOME, PATH: SYSTEM }, { homes: [HOME], appData: [APP_DATA], toolNames: HOME_TOOL_PLACES }), at.real);
		};
		const bin = `${LOCAL}\\Python\\bin`;
		assert(!windowsRefuses(bin, onlyThose(`${LOCAL}\\Python`, [bin])), "the OneDrive there opens the place to a room, so the list must drop it");
		onlyThose(bin.toUpperCase(), [bin]);
		onlyThose(`${ROAMING}\\npm\\OneDrive`, [`${ROAMING}\\npm`]);
		onlyThose(`${PROGRAMS}\\OneDrive`, [PROGRAMS]);
		onlyThose(String.raw`D:\Cloud`, [bin], { "D:\\Cloud": bin });
		onlyThose(`${HOME}\\OneDrive`, []);
		onlyThose(`${LOCAL}\\OneDrive`, []);
		onlyThose(`${LOCAL}\\Python2`, []);
		same(openInAppData("", { ...NAMES, USERPROFILE: HOME }, [HOME], pc().real), [], "no answer read");
		same(openInAppData("", { ...NAMES, USERPROFILE: `${LOCAL}\\Temp\\home` }, [HOME], pc().real), [`${LOCAL}\\Temp\\home`], "a profile in AppData");
	});
	// By the judge itself, on this computer's own disk: the home's places anywhere, every place on Windows.
	await row("pin: the judge refuses a listed place, in it and above it, for reading, for changing and for one yes, before and after it is added", () => {
		const home = homeFolders()[0];
		const here = thisPc();
		const listed = process.platform === "win32" ? installerPlaces(here).map(realPathOf) : [path.join(home, ".local", "bin"), path.join(home, ".cargo", "bin")];
		const room = fs.realpathSync.native(fs.mkdtempSync(path.join(os.homedir(), "windows-search-path-room-")));
		const beside = path.join(room, "sub");
		fs.mkdirSync(beside);
		const judged = (folder: string) => [roomFolderGrantable(folder), folderGrantable(folder, "read", [], ""), folderGrantable(folder, "write", [], ""), soundFolders([{ path: folder, access: "write" }], room).length > 0, soundFolders([{ path: folder, access: "read" }], room).length > 0];
		try {
			for (const PATH of [serverPath, [serverPath, ...listed].join(path.delimiter)]) {
				process.env.PATH = PATH;
				for (const place of listed) for (const folder of [place, path.join(place, "tool"), path.dirname(place), home]) same(judged(folder), [false, false, false, false, false], folder);
				same([roomFolderGrantable(beside), folderGrantable(beside, "write", [], "")], [true, true], "a room in the home");
			}
		} finally {
			process.env.PATH = serverPath;
			fs.rmSync(room, { recursive: true, force: true });
		}
	});
	// Last, since the answer handed over here is kept; on Windows the pin above has Windows' own.
	if (process.platform !== "win32") await row("a read on this computer takes the OneDrive folders from the answer Windows gave before, and asks for none", () => {
		const local = process.env.LOCALAPPDATA;
		process.env.LOCALAPPDATA = LOCAL;
		try {
			same(thisPc().open, [], "before an answer");
			windowsAnswer({}, () => JSON.stringify({ ...JSON.parse(ANSWER), onedrive: [`${LOCAL}\\Python`] }));
			same(thisPc().open, [`${LOCAL}\\Python`], "after it");
		} finally {
			if (local === undefined) delete process.env.LOCALAPPDATA;
			else process.env.LOCALAPPDATA = local;
		}
	});
} finally {
	process.env.PATH = serverPath;
	fs.rmSync(work, { recursive: true, force: true });
}

if (failed > 0) {
	console.error(`windows-search-path-smoke: ${failed} failed`);
	process.exit(1);
}
console.log("windows-search-path-smoke: ok");
