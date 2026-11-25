// A protected room on Windows runs the Python that python.org's installer or
// its install manager put on the computer (installed-python.ts), on any
// computer: the made-up PC's drive Q: lies in a temp folder, and every disk
// call under Q:\ is led there, so the product's own calls read real files,
// folders and links. Rows: which Python counts and which wins; where it goes on
// PATH and when PATH stays as it is; the check's own reading of the PC
// (readMachine); and a command's request, with its folder read and on PATH,
// never the folder above, and dropped where a room shuts what holds it.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { commandRequest, type WindowsRoomRules } from "../src/room-box/windows/box-request.js";
import { withInstalledPython } from "../src/room-box/windows/installed-python.js";
import { readMachine } from "../src/room-box/windows/start-check.js";

let failed = 0;
async function row(name: string, body: () => Promise<void> | void): Promise<void> {
	freshPc();
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
const same = (got: readonly string[], expected: readonly string[], what: string) => assert(JSON.stringify(got) === JSON.stringify(expected), `${what}: ${JSON.stringify(got)}, not ${JSON.stringify(expected)}`);

// ---- The made-up PC -----------------------------------------------------------
const work = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "windows-installed-python-")));
const drive = path.join(work, "drive-q");
const onDisk = (place: string) => path.join(drive, ...place.slice(3).split(/[\\/]/).filter(Boolean));
const ledToDrive = <T extends unknown[], R>(real: (place: string, ...more: T) => R) => (place: string, ...more: T): R => real(typeof place === "string" && /^Q:[\\/]/i.test(place) ? onDisk(place) : place, ...more);
const own = { lstat: fs.lstatSync, stat: fs.statSync, readdir: fs.readdirSync, native: fs.realpathSync.native };
Object.assign(fs, { lstatSync: ledToDrive(own.lstat as never), statSync: ledToDrive(own.stat as never), readdirSync: ledToDrive(own.readdir as never) });
Object.assign(fs.realpathSync, { native: (place: string) => (/^Q:[\\/]/i.test(place) ? (fs.statSync(place), place) : own.native(place)) });

const PROFILE = String.raw`Q:\Users\Ana Müller`;
const LOCAL = `${PROFILE}\\AppData\\Local`;
const MANAGER = `${LOCAL}\\Python`;
const OLDER = `${LOCAL}\\Programs\\Python`;
const PROGRAM_FILES = String.raw`Q:\Program Files`;
const STORE = `${LOCAL}\\Microsoft\\WindowsApps`;
const ALIASES = `${MANAGER}\\bin`;
const SYSTEM = String.raw`Q:\Windows\system32`;
const NPM = `${PROFILE}\\AppData\\Roaming\\npm`;
const ENVIRONMENT = { SystemRoot: String.raw`Q:\Windows`, LOCALAPPDATA: LOCAL, ProgramFiles: PROGRAM_FILES };

const folder = (place: string) => fs.mkdirSync(onDisk(place), { recursive: true });
const file = (place: string, text = "MZ") => {
	folder(path.win32.dirname(place));
	fs.writeFileSync(onDisk(place), text);
};
/** A Python in its folder, as an installer leaves it. */
const python = (place: string, scripts = false) => {
	file(`${place}\\python.exe`);
	if (scripts) folder(`${place}\\Scripts`);
	return place;
};
/** The Store's stand-in and the manager's commands, which every row has. */
function freshPc() {
	fs.rmSync(drive, { recursive: true, force: true });
	file(`${STORE}\\python.exe`, "");
	file(`${ALIASES}\\python3.exe`);
	folder(SYSTEM);
	folder(NPM);
}
const got = (pathFolders: readonly string[], environment: Record<string, string | undefined> = ENVIRONMENT) => withInstalledPython(pathFolders, environment);
const PATH = [SYSTEM, STORE, NPM];

/** Windows makes a link to a file only for an admin or in developer mode, so there such a row may have none to read. */
function fileLink(target: string, at: string): boolean {
	folder(path.win32.dirname(at));
	try {
		fs.symlinkSync(onDisk(target), onDisk(at), "file");
		return true;
	} catch (error) {
		assert(process.platform === "win32" && (error as NodeJS.ErrnoException).code === "EPERM", `no link could be made: ${error}`);
		console.log("note: this Windows makes no link to a file");
		return false;
	}
}

try {
	// ---- 1. Which Python, and where on PATH -------------------------------------
	await row("the install manager's runtime goes before the Store's stand-in, with no Scripts of its own", () => {
		const manager = python(`${MANAGER}\\pythoncore-3.15-64`);
		same(got(PATH), [SYSTEM, manager, STORE, NPM], "the manager's alone");
	});
	await row("the older installer's goes there too, its Scripts last", () => {
		const older = python(`${OLDER}\\Python314`, true);
		same(got(PATH), [SYSTEM, older, STORE, NPM, `${older}\\Scripts`], "the older installer's alone");
	});
	await row("one installed for everyone counts", () => {
		const everyone = python(`${PROGRAM_FILES}\\Python313`, true);
		same(got(PATH), [SYSTEM, everyone, STORE, NPM, `${everyone}\\Scripts`], "Program Files");
	});
	await row("of the manager's and the older installer's the newer wins, each way", () => {
		python(`${OLDER}\\Python314`, true);
		const manager = python(`${MANAGER}\\pythoncore-3.15-64`);
		same(got(PATH), [SYSTEM, manager, STORE, NPM], "the manager's newer");
		const older = python(`${OLDER}\\Python316`);
		same(got(PATH), [SYSTEM, older, STORE, NPM], "the older installer's newer");
	});
	await row("at a tie: the older installer's, then the manager's, then Program Files'", () => {
		const everyone = python(`${PROGRAM_FILES}\\Python315`);
		same(got(PATH), [SYSTEM, everyone, STORE, NPM], "Program Files alone");
		const manager = python(`${MANAGER}\\pythoncore-3.15-64`);
		same(got(PATH), [SYSTEM, manager, STORE, NPM], "the manager's before Program Files'");
		const older = python(`${OLDER}\\Python315`);
		same(got(PATH), [SYSTEM, older, STORE, NPM], "the older installer's first");
	});
	await row("versions compare as numbers: 3.15 is newer than 3.9", () => {
		python(`${OLDER}\\Python39`);
		const newer = python(`${OLDER}\\Python315`);
		same(got(PATH), [SYSTEM, newer, STORE, NPM], "3.9 and 3.15 of the older installer");
		fs.rmSync(onDisk(OLDER), { recursive: true });
		python(`${MANAGER}\\pythoncore-3.9-64`);
		const manager = python(`${MANAGER}\\pythoncore-3.15-64`);
		same(got(PATH), [SYSTEM, manager, STORE, NPM], "3.9 and 3.15 of the manager");
	});
	await row("a PATH that leads to a Python stays as it is, letter for letter", () => {
		python(`${MANAGER}\\pythoncore-3.15-64`);
		const hers = python(String.raw`Q:\Tools\Python311`);
		for (const listed of [[SYSTEM, hers, STORE], [`${hers}\\`, STORE, NPM], [SYSTEM, hers], [hers.replaceAll("\\", "/"), STORE]]) same(got(listed), listed, "hers before the stand-ins");
	});
	await row("a Python after the stand-ins never runs, so the installed one goes before them", () => {
		const manager = python(`${MANAGER}\\pythoncore-3.15-64`);
		const hers = python(String.raw`Q:\Tools\Python311`);
		same(got([SYSTEM, STORE, hers]), [SYSTEM, manager, STORE, hers], "after the Store's");
		same(got([SYSTEM, ALIASES, hers, STORE]), [SYSTEM, manager, ALIASES, hers, STORE], "after the manager's commands");
	});
	await row("the stand-in folders are known in other letters and with a closing backslash", () => {
		const manager = python(`${MANAGER}\\pythoncore-3.15-64`);
		for (const standIn of [`${STORE}\\`, STORE.toUpperCase(), `${ALIASES.toLowerCase()}\\`, STORE.replaceAll("\\", "/")]) same(got([SYSTEM, standIn, NPM]), [SYSTEM, manager, standIn, NPM], standIn);
		const beside = `${STORE}2`;
		same(got([SYSTEM, beside]), [SYSTEM, beside, manager], "a folder that only starts like one");
	});
	await row("with no stand-in folder on PATH it goes at the end", () => {
		const older = python(`${OLDER}\\Python314`, true);
		same(got([SYSTEM, NPM]), [SYSTEM, NPM, older, `${older}\\Scripts`], "no stand-in folder");
		same(got([]), [older, `${older}\\Scripts`], "an empty PATH");
	});
	await row("a folder counts only with a real python.exe", () => {
		const real = python(String.raw`Q:\Elsewhere\Python`);
		folder(`${OLDER}\\Python317`);
		same(got(PATH), PATH, "no python.exe");
		file(`${OLDER}\\Python317\\python.exe`, "");
		same(got(PATH), PATH, "an empty python.exe");
		folder(`${OLDER}\\Python318\\python.exe`);
		same(got(PATH), PATH, "a folder named python.exe");
		if (fileLink(`${real}\\python.exe`, `${OLDER}\\Python319\\python.exe`)) same(got(PATH), PATH, "a link");
		const older = python(`${OLDER}\\Python310`);
		same(got(PATH), [SYSTEM, older, STORE, NPM], "a real one beside them");
	});
	await row("a PATH folder whose python.exe is a link leads to no Python", () => {
		const manager = python(`${MANAGER}\\pythoncore-3.15-64`);
		const links = String.raw`Q:\Links`;
		if (fileLink(`${manager}\\python.exe`, `${links}\\python.exe`)) same(got([links, STORE]), [links, manager, STORE], "a linked python.exe on PATH");
	});
	await row("a runtime's folder that is a link to another place doesn't count", () => {
		const hers = python(`${PROFILE}\\Documents\\python`);
		folder(MANAGER);
		fs.symlinkSync(onDisk(hers), onDisk(`${MANAGER}\\pythoncore-3.15-64`), "junction");
		same(got(PATH), PATH, "a linked folder");
	});
	await row("free-threaded, 32-bit, ARM and other folders don't count", () => {
		for (const name of ["pythoncore-3.15t-64", "pythoncore-3.15-32", "pythoncore-3.15-arm64", "pythoncore-3.15", "pythoncore-3.15-64-old", "pythoncore-2.7-64", "bin"]) python(`${MANAGER}\\${name}`);
		for (const name of ["Python315t", "Python315-32", "Python315-arm64", "Python27", "Python3", "Launcher"]) python(`${OLDER}\\${name}`);
		for (const name of ["Python315-32", "Python 3.15", "Python315t"]) python(`${PROGRAM_FILES}\\${name}`);
		same(got(PATH), PATH, "none of them");
		const manager = python(`${MANAGER}\\pythoncore-3.12-64`);
		same(got(PATH), [SYSTEM, manager, STORE, NPM], "an older one that counts");
	});
	await row("no variable set, one that names no full local path, or nothing installed: PATH stays as it is", () => {
		same(got(PATH), PATH, "nothing installed");
		python(`${MANAGER}\\pythoncore-3.15-64`);
		python(`${PROGRAM_FILES}\\Python313`);
		for (const environment of [{}, { LOCALAPPDATA: "", ProgramFiles: "" }, { LOCALAPPDATA: String.raw`\\fs01\profiles\Ana\AppData\Local`, ProgramFiles: "Program Files" }]) same(got(PATH, environment), PATH, JSON.stringify(environment));
		same(got(PATH, { localappdata: LOCAL }), [SYSTEM, `${MANAGER}\\pythoncore-3.15-64`, STORE, NPM], "a variable in other letters");
	});
	await row("a PATH folder no room is given (quotes, relative, a share) is never read, and leads to no Python", () => {
		const manager = python(`${MANAGER}\\pythoncore-3.15-64`);
		const hers = python(String.raw`Q:\Tools\Python311`);
		const asked: string[] = [];
		const lstat = fs.lstatSync;
		Object.assign(fs, { lstatSync: (place: string, ...more: []) => (asked.push(place), lstat(place, ...more)) });
		try {
			const listed = [`"${hers}"`, "tools", String.raw`\\fs01\tools`, STORE];
			same(got(listed), [...listed.slice(0, 3), manager, STORE], "not full local paths");
		} finally {
			Object.assign(fs, { lstatSync: lstat });
		}
		assert(asked.every((place) => /^Q:\\/.test(place)), `read: ${JSON.stringify(asked)}`);
	});

	await row("a PATH folder on another drive than Windows' own is never read, so one that doesn't answer holds nothing up; a Python there still comes first", () => {
		const manager = python(`${MANAGER}\\pythoncore-3.15-64`);
		const asked: string[] = [];
		const { lstatSync, statSync, readdirSync } = fs;
		const watched = <T extends (place: string, ...more: never[]) => unknown>(real: T) => (place: string, ...more: never[]) => {
			asked.push(String(place));
			// A real python.exe in every folder of Z:, the mapped drive.
			return /^z:/i.test(String(place)) ? { isFile: () => true, isDirectory: () => false, size: 2 } : real(place, ...more);
		};
		Object.assign(fs, { lstatSync: watched(lstatSync as never), statSync: watched(statSync as never), readdirSync: watched(readdirSync as never) });
		try {
			const mapped = String.raw`Z:\Tools\Python311`;
			const { SystemRoot: _named, ...rest } = ENVIRONMENT;
			for (const environment of [ENVIRONMENT, { ...rest, SYSTEMROOT: String.raw`q:\windows` }]) same(got([SYSTEM, mapped, mapped.toLowerCase(), STORE, NPM], environment), [SYSTEM, mapped, mapped.toLowerCase(), manager, STORE, NPM], "another drive's before the stand-ins");
			assert(!asked.some((place) => /^z:/i.test(place)), `read: ${JSON.stringify(asked)}`);
			const own = python(String.raw`Q:\Tools\Python311`);
			for (const spelled of [own, own.replace("Q:", "q:")]) same(got([mapped, spelled, STORE]), [mapped, spelled, STORE], "one on Windows' own drive, in either letter, is still seen");
			asked.length = 0;
			same(got([SYSTEM, own, STORE], { ...ENVIRONMENT, SystemRoot: undefined }), [SYSTEM, own, manager, STORE], "no Windows folder named");
			assert(!asked.includes(`${own}\\python.exe`), "a PATH folder was read with no Windows folder named");
		} finally {
			Object.assign(fs, { lstatSync, statSync, readdirSync });
		}
	});
	await row("the three places are read on whichever drive they lie", () => {
		const manager = python(`${MANAGER}\\pythoncore-3.15-64`);
		const windowsElsewhere = { ...ENVIRONMENT, SystemRoot: String.raw`C:\Windows` };
		same(got([STORE], windowsElsewhere), [manager, STORE], "a profile on another drive");
	});

	// ---- 2. The check's reading of the PC -----------------------------------------
	await row("the check hands a room the installed Python, and the rest of PATH as it was", async () => {
		const environment: Record<string, string | undefined> = { ...process.env, SystemRoot: process.env.SystemRoot, LOCALAPPDATA: LOCAL, ProgramFiles: PROGRAM_FILES, PATH: PATH.join(";"), Path: PATH.join(";") };
		const manager = python(`${MANAGER}\\pythoncore-3.15-64`);
		const searchPath = process.env.PATH;
		if (process.platform !== "win32") {
			// PowerShell by its Windows path is here one file name, in a folder on PATH.
			const bin = fs.mkdtempSync(path.join(work, "bin-"));
			const answer = path.join(bin, "answer.json");
			fs.writeFileSync(answer, `${JSON.stringify({ profile: PROFILE })}\nrevision=9300\n`);
			fs.writeFileSync(path.join(bin, String.raw`Q:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe`), `#!/bin/sh\ncat ${JSON.stringify(answer)}\n`, { mode: 0o755 });
			environment.SystemRoot = String.raw`Q:\Windows`;
			process.env.PATH = `${bin}${path.delimiter}${searchPath}`;
		}
		try {
			const machine = await readMachine(environment);
			same(machine.pathFolders, [SYSTEM, manager, STORE, NPM], "the PC as the check reads it");
		} finally {
			process.env.PATH = searchPath;
		}
	});

	// ---- 3. A command's request ------------------------------------------------------
	const ROOM = `${PROFILE}\\Documents\\room`;
	const rules = (pathFolders: readonly string[], denied: readonly string[] = []): WindowsRoomRules => ({
		room: { folder: ROOM, canChangeFiles: true },
		alsoAllowed: [],
		skillFolders: [],
		places: { temp: `${PROFILE}\\.exxperts.box\\r\\temp-1`, caches: `${PROFILE}\\.exxperts.box\\r\\caches` },
		profile: PROFILE,
		personal: [`${PROFILE}\\Desktop`],
		denied,
		closedNames: { readOnly: [], denied: [] },
		environment: { SystemRoot: String.raw`Q:\Windows`, ProgramFiles: PROGRAM_FILES },
		tools: [],
		pathFolders,
		programs: { folder: `${LOCAL}\\Programs`, names: ["Python"] },
	});
	const request = (denied: readonly string[] = []) => {
		const built = commandRequest(rules(got(PATH), denied), { wrapper: "Write-Output ok", text: "python --version", timeoutMs: 1_000 });
		assert(built.ok, `no request was built: ${JSON.stringify(built)}`);
		return { path: built.request.environment.PATH.split(";"), files: built.request.filesystem };
	};
	await row("the request reads the manager's runtime and has it on PATH, never the folder above it, and writes neither", () => {
		const manager = python(`${MANAGER}\\pythoncore-3.15-64`);
		const { path: searchPath, files } = request();
		same(searchPath, [SYSTEM, manager, STORE, NPM], "PATH");
		const read = files.readonlyPaths.filter((place) => place.toLowerCase().startsWith(MANAGER.toLowerCase()));
		same(read, [manager], "read in AppData\\Local\\Python");
		assert(!files.readonlyPaths.some((place) => MANAGER.toLowerCase().startsWith(place.toLowerCase())), `a folder that holds it is read: ${JSON.stringify(files.readonlyPaths)}`);
		assert(!files.readwritePaths.some((place) => place.toLowerCase().startsWith(LOCAL.toLowerCase())), `written: ${JSON.stringify(files.readwritePaths)}`);
	});
	await row("a room whose shut folder holds the runtime drops it, and only it", () => {
		const manager = python(`${MANAGER}\\pythoncore-3.15-64`);
		const { path: searchPath, files } = request([MANAGER]);
		same(searchPath, [SYSTEM, STORE, NPM], "PATH");
		assert(!files.readonlyPaths.includes(manager), `still read: ${JSON.stringify(files.readonlyPaths)}`);
		assert(files.deniedPaths.includes(MANAGER), `not shut: ${JSON.stringify(files.deniedPaths)}`);
	});
} finally {
	Object.assign(fs, { lstatSync: own.lstat, statSync: own.stat, readdirSync: own.readdir });
	Object.assign(fs.realpathSync, { native: own.native });
	fs.rmSync(work, { recursive: true, force: true });
}

if (failed > 0) {
	console.error(`windows-installed-python-smoke: ${failed} failed`);
	process.exit(1);
}
console.log("windows-installed-python-smoke: ok");
