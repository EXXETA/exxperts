// On Windows, the folder judge refuses the places no yes may open: her profile
// and what holds it, AppData but for a OneDrive Windows names, Startup, her own
// programs, PATH, Program Files, Windows, ProgramData, a drive's or a share's
// root, the app's data and other tools' folders, each with every folder that
// holds it. The rule runs with path.win32 on any computer, from given answers:
// (1) her PC, as Windows answers there; (2) each source of a place alone, so a
// row goes red when that source is taken out; (3) a profile on another drive
// with a non-ASCII name; (4) the judge's entry: the rule runs on Windows only,
// and on Windows it reads Windows' own answers.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { folderGrantable, HOME_TOOL_PLACES, roomFolderGrantable } from "../src/room-box/folder-offer.js";
import { FOLDERS_SCRIPT } from "../src/room-box/windows/personal-folders.js";
import { windowsAnswer, windowsPlaces, windowsRefuses, withRealPaths, type PlacesGiven, type WindowsPlaces } from "../src/room-box/windows/windows-places.js";

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

type Row = [folder: string, expected: "refused" | "grantable", why: string];

function judge(places: WindowsPlaces, rows: readonly Row[], label: string) {
	for (const [folder, expected, why] of rows) {
		const got = windowsRefuses(folder, places) ? "refused" : "grantable";
		assert(got === expected, `${label}: ${JSON.stringify(folder)} is ${got}, not ${expected} (${why})`);
	}
	console.log(`ok: ${label} (${rows.length} rows)`);
}

const join = path.win32.join;
const P = String.raw`C:\Users\Ana Lopez`;
const ROAMING = join(P, "AppData", "Roaming");
const LOCAL = join(P, "AppData", "Local");
const LOCAL_LOW = join(P, "AppData", "LocalLow");
const STARTUP = join(ROAMING, "Microsoft", "Windows", "Start Menu", "Programs", "Startup");
const PROGRAMS = join(LOCAL, "Programs");
const GIVEN: PlacesGiven = { homes: [P], appData: [join(P, ".exxperts"), join(P, ".exxperts", "app")], toolNames: HOME_TOOL_PLACES };

// ---- 1. Her PC --------------------------------------------------------------------------------
const ANSWER = {
	profile: P,
	documents: join(P, "Documents"),
	desktop: join(P, "Desktop"),
	downloads: join(P, "Downloads"),
	roaming: ROAMING,
	local: LOCAL,
	locallow: LOCAL_LOW,
	startup: STARTUP,
	programs: PROGRAMS,
	programfiles: String.raw`C:\Program Files`,
	programfilesx86: String.raw`C:\Program Files (x86)`,
	programdata: String.raw`C:\ProgramData`,
	windows: String.raw`C:\Windows`,
	onedrive: [join(P, "OneDrive"), join(P, "OneDrive - Muster Logistik AG")],
};
const ENVIRONMENT: Record<string, string> = {
	USERPROFILE: P,
	APPDATA: ROAMING,
	LOCALAPPDATA: LOCAL,
	ProgramFiles: String.raw`C:\Program Files`,
	"ProgramFiles(x86)": String.raw`C:\Program Files (x86)`,
	ProgramW6432: String.raw`C:\Program Files`,
	ProgramData: String.raw`C:\ProgramData`,
	// Spelled as some shells spell them: names ignore case on Windows.
	SYSTEMROOT: String.raw`C:\Windows`,
	PATH: [
		String.raw`C:\Windows\system32`, String.raw`C:\Windows`, String.raw`C:\Program Files\Git\cmd`, String.raw`C:\Tools\bin`,
		String.raw`"C:\Quoted Tools\bin"`, join(ROAMING, "npm"), "%SystemRoot%\\x", String.raw`relative\bin`, "",
	].join(";"),
};
const PC = windowsPlaces(JSON.stringify(ANSWER), ENVIRONMENT, GIVEN);

judge(PC, [
	[P, "refused", "her profile"],
	[String.raw`C:\Users`, "refused", "holds her profile"],
	[join(P, "AppData"), "refused", "AppData"],
	[ROAMING, "refused", "Roaming"],
	[LOCAL, "refused", "Local"],
	[LOCAL_LOW, "refused", "LocalLow"],
	[join(LOCAL, "Temp", "report"), "refused", "in Local"],
	[join(LOCAL, "Microsoft", "OneDrive"), "refused", "OneDrive's program, in Local"],
	[STARTUP, "refused", "Startup"],
	[PROGRAMS, "refused", "her own programs"],
	[join(PROGRAMS, "Microsoft VS Code"), "refused", "in her own programs"],
	[join(ROAMING, "npm"), "refused", "on PATH"],
	[String.raw`C:\Tools\bin`, "refused", "on PATH"],
	[String.raw`C:\Tools`, "refused", "holds a PATH folder"],
	[String.raw`C:\Tools\bin\old`, "refused", "in a PATH folder"],
	[String.raw`C:\Quoted Tools\bin`, "refused", "on PATH in quotes"],
	[String.raw`C:\Program Files`, "refused", "Program Files"],
	[String.raw`C:\Program Files\Git`, "refused", "in Program Files"],
	[String.raw`C:\Program Files (x86)`, "refused", "Program Files (x86)"],
	[String.raw`C:\Windows`, "refused", "Windows"],
	[String.raw`C:\Windows\System32`, "refused", "in Windows"],
	[String.raw`C:\ProgramData`, "refused", "ProgramData"],
	[String.raw`C:\ProgramData\chocolatey`, "refused", "in ProgramData"],
	[join(P, ".exxperts"), "refused", "the app's data"],
	[join(P, ".exxperts", "app", "rooms"), "refused", "in the app's data"],
	[join(P, ".cursor"), "refused", "another tool's folder"],
	[join(P, ".claude"), "refused", "another tool's folder"],
	[join(P, ".claude", "skills"), "refused", "in another tool's folder"],
	[join(P, ".codex"), "refused", "another tool's folder"],
	[join(P, ".config", "git"), "refused", "git's settings"],
	[join(P, ".config"), "refused", "holds git's settings"],
	[String.raw`C:\ `.trim(), "refused", "a drive's root"],
	[String.raw`D:\ `.trim(), "refused", "a drive's root"],
	[String.raw`Z:\ `.trim(), "refused", "a mapped drive's root"],
	[String.raw`\\fs01\team`, "refused", "a share's root"],
	[String.raw`\\?\C:\Users\Ana Lopez\Documents`, "refused", "a device path"],
	["Documents", "refused", "not a full path"],
	[String.raw`c:\USERS\ana lopez\appdata\ROAMING`, "refused", "Roaming in other letters"],
	[String.raw`C:\PROGRAM FILES\git`, "refused", "Program Files in other letters"],
	[join(P, "Documents"), "grantable", "Documents"],
	[join(P, "Desktop"), "grantable", "Desktop"],
	[join(P, "Downloads"), "grantable", "Downloads"],
	[join(P, "Documents", "Projects"), "grantable", "in Documents"],
	[String.raw`c:\users\ana lopez\documents`, "grantable", "Documents in other letters"],
	[join(P, "OneDrive"), "grantable", "OneDrive"],
	[join(P, "OneDrive", "Reports"), "grantable", "in OneDrive"],
	[join(P, "OneDrive - Muster Logistik AG", "Team"), "grantable", "in a work OneDrive"],
	[join(P, "source", "repos", "app"), "grantable", "a project in her profile"],
	[String.raw`D:\Projects`, "grantable", "a folder on another drive"],
	[String.raw`Z:\Team`, "grantable", "a folder on a mapped drive"],
	[String.raw`\\fs01\team\Projects`, "grantable", "a mapped drive's folder by its share"],
	[String.raw`C:\Users\Public\Documents`, "grantable", "the shared Documents"],
], "her PC");

// ---- 2. Each source alone ---------------------------------------------------------------------
// Each group names a place by one source only, so taking that source out turns a row.
const only = (answer: object | string, environment: Record<string, string> = {}, given: Partial<PlacesGiven> = {}) =>
	windowsPlaces(typeof answer === "string" ? answer : JSON.stringify(answer), { USERPROFILE: P, ...environment }, { homes: [], appData: [], toolNames: [], ...given });
const HERS = { homes: [P] };

judge(only({ profile: String.raw`D:\Users\Ana` }, { USERPROFILE: "" }), [
	[String.raw`D:\Users\Ana`, "refused", "the profile Windows names"],
	[String.raw`D:\Users`, "refused", "holds it"],
	[String.raw`D:\Users\Ana\Documents`, "grantable", "inside it"],
], "the profile from Windows' answer alone");
judge(only("", {}), [
	[P, "refused", "her profile from USERPROFILE"],
	[join(P, "AppData", "Roaming", "Code"), "refused", "AppData in its usual place, with no answer and no other name"],
	[join(P, "Documents"), "grantable", "inside her profile"],
], "her profile from the environment alone, no answer");
judge(only("", { USERPROFILE: "" }, HERS), [[join(P, "Documents"), "refused", "no profile is known"]], "no profile");
const DATA = String.raw`D:\Data`;
judge(only("", {}, { homes: [DATA], toolNames: HOME_TOOL_PLACES }), [
	[join(DATA, "AppData", "Roaming", "x"), "refused", "another home's AppData"],
	[join(DATA, ".cursor"), "refused", "another tool's folder in another home"],
	[join(DATA, "Projects"), "grantable", "in another home"],
], "the server's other homes");
// A drive or her profile on PATH closes all it holds, as the Mac's PATH rule does at the same entry.
judge(only("", { Path: P }), [[join(P, "Documents"), "refused", "in a PATH folder"]], "her profile on PATH");
judge(only("not json", {}, HERS), [[join(P, "Documents"), "grantable", "an unreadable answer is no answer"]], "an unreadable answer");

const SHARE_ROAMING = String.raw`\\fs01\profiles$\Ana Lopez\AppData\Roaming`;
judge(only({ roaming: SHARE_ROAMING }, {}, HERS), [
	[SHARE_ROAMING, "refused", "Roaming redirected to a share, from Windows' answer"],
	[join(SHARE_ROAMING, "Microsoft"), "refused", "in it"],
	[String.raw`\\fs01\profiles$\Ana Lopez\Documents`, "grantable", "beside it"],
], "Roaming from the answer alone");
judge(only("", { appdata: SHARE_ROAMING }, HERS), [[join(SHARE_ROAMING, "Microsoft"), "refused", "Roaming from APPDATA"]], "Roaming from the environment alone");
judge(only({ local: String.raw`E:\Local` }, {}, HERS), [[String.raw`E:\Local\Temp`, "refused", "Local from Windows' answer"], [String.raw`E:\Work`, "grantable", "beside it"]], "Local from the answer alone");
judge(only("", { LocalAppData: String.raw`E:\Local` }, HERS), [[String.raw`E:\Local\Temp`, "refused", "Local from LOCALAPPDATA"]], "Local from the environment alone");
judge(only({ locallow: String.raw`E:\LocalLow` }, {}, HERS), [[String.raw`E:\LocalLow\Sun`, "refused", "LocalLow from Windows' answer"]], "LocalLow from the answer");
judge(only({ startup: String.raw`D:\Autostart` }, {}, HERS), [
	[String.raw`D:\Autostart`, "refused", "Startup redirected"],
	[String.raw`D:\Autostart\x`, "refused", "in it"],
	[String.raw`D:\Projects`, "grantable", "beside it"],
], "Startup from the answer");
judge(only({ programs: String.raw`D:\Apps` }, {}, HERS), [[String.raw`D:\Apps\Tool`, "refused", "her own programs, redirected"], [String.raw`D:\Projects`, "grantable", "beside them"]], "her own programs from the answer");
judge(only("", { Path: String.raw`D:\Tools\bin` }, HERS), [[String.raw`D:\Tools\bin`, "refused", "on PATH"], [String.raw`D:\Tools`, "refused", "holds a PATH folder"], [String.raw`D:\Projects`, "grantable", "beside it"]], "PATH");
for (const [key, place] of [["programfiles", String.raw`E:\Program Files`], ["programfilesx86", String.raw`E:\Program Files (x86)`], ["programdata", String.raw`E:\ProgramData`], ["windows", String.raw`E:\Windows`]]) {
	judge(only({ [key]: place }, {}, HERS), [[join(place, "x"), "refused", `${key} from Windows' answer`], [String.raw`E:\Work`, "grantable", "beside it"]], `${key} from the answer alone`);
}
for (const [name, place] of [["ProgramFiles", String.raw`E:\Program Files`], ["ProgramFiles(x86)", String.raw`E:\Program Files (x86)`], ["ProgramData", String.raw`E:\ProgramData`], ["SystemRoot", String.raw`E:\Windows`]]) {
	judge(only("", { [name]: place }, HERS), [[join(place, "x"), "refused", `${name} from the environment`], [String.raw`E:\Work`, "grantable", "beside it"]], `${name} from the environment alone`);
}
// A 32-bit server's ProgramFiles names the (x86) folder; ProgramW6432 names the other.
judge(only("", { ProgramFiles: String.raw`E:\Program Files (x86)`, ProgramW6432: String.raw`E:\Program Files` }, HERS), [[String.raw`E:\Program Files\Git`, "refused", "ProgramW6432"]], "Program Files for a 32-bit server");
judge(only("", {}, { homes: [P], appData: [String.raw`D:\exxperts-data\.exxperts`] }), [
	[String.raw`D:\exxperts-data\.exxperts\app`, "refused", "the app's data, moved"],
	[String.raw`D:\exxperts-data`, "refused", "holds it"],
	[String.raw`D:\Projects`, "grantable", "beside it"],
], "the app's data");
judge(only("", {}, { homes: [P], toolNames: HOME_TOOL_PLACES }), [
	...HOME_TOOL_PLACES.map((name): Row => [join(P, name), "refused", "another tool's folder in her profile"]),
	[join(P, "Documents"), "grantable", "beside them"],
], "other tools' folders");

// OneDrive is opened in AppData only where Windows names it, and never over another closed place.
const ONEDRIVE_IN_LOCAL = join(LOCAL, "OneDrive Files");
judge(only({ onedrive: [ONEDRIVE_IN_LOCAL] }, { Path: join(ONEDRIVE_IN_LOCAL, "bin") }, HERS), [
	[ONEDRIVE_IN_LOCAL, "refused", "a OneDrive Windows names, in Local, holding a PATH folder"],
	[join(ONEDRIVE_IN_LOCAL, "Reports"), "grantable", "in it"],
	[join(ONEDRIVE_IN_LOCAL, "bin"), "refused", "a PATH folder in it"],
	[join(LOCAL, "Microsoft", "OneDrive"), "refused", "OneDrive's program beside it"],
	[LOCAL, "refused", "Local itself"],
], "a OneDrive in AppData");
judge(only({ onedrive: [ONEDRIVE_IN_LOCAL] }, {}, HERS), [[ONEDRIVE_IN_LOCAL, "grantable", "a OneDrive Windows names, in Local"]], "a OneDrive in AppData, holding nothing closed");
judge(only({}, {}, HERS), [[join(ONEDRIVE_IN_LOCAL, "Reports"), "refused", "the same folder with no OneDrive named"]], "no OneDrive named");

// Each smoke's home sits in the temp folder, in Local, and is the profile its server runs under.
const SMOKE_HOME = join(LOCAL, "Temp", "exxperts-smoke-home-1");
judge(only({ profile: P, local: LOCAL }, { USERPROFILE: SMOKE_HOME }), [
	[join(SMOKE_HOME, "rooms", "one"), "grantable", "in the profile the server runs under, in Local"],
	[SMOKE_HOME, "refused", "the home itself"],
	[join(LOCAL, "Temp", "other"), "refused", "beside the home, in Local"],
], "a home in AppData");

// A data folder moved into Local is no home of hers: Local stays shut around it.
judge(only({ profile: P, local: LOCAL }, {}, { homes: [P, LOCAL] }), [
	[join(LOCAL, "Microsoft", "OneDrive"), "refused", "OneDrive's program, with the app's data moved to Local"],
	[join(LOCAL, "Temp", "x"), "refused", "in Local, with the app's data moved there"],
], "the app's data moved into AppData");

// Real paths are asked only of this computer's own drives: a place named on a share is never dialled.
{
	const asked: string[] = [];
	const known = withRealPaths(only({ roaming: SHARE_ROAMING, local: LOCAL }), (place) => {
		asked.push(place);
		return place === LOCAL ? String.raw`E:\Moved\Local` : place;
	});
	assert(!asked.some((place) => place.startsWith("\\\\")), `a share was resolved: ${JSON.stringify(asked)}`);
	assert(asked.includes(LOCAL), "a local place was not resolved");
	judge(known, [[String.raw`E:\Moved\Local\Temp`, "refused", "Local by its real path"], [join(SHARE_ROAMING, "x"), "refused", "Roaming on a share by its name"]], "real paths");
}

// ---- 3. A profile on another drive, in other letters ------------------------------------------
const Z = String.raw`D:\Benutzer\Željko Šarić`;
const ZELJKO = windowsPlaces(JSON.stringify({ profile: Z, roaming: join(Z, "AppData", "Roaming"), local: join(Z, "AppData", "Local"), onedrive: [join(Z, "OneDrive")] }), { LOCALAPPDATA: join(Z, "AppData", "Local") }, { homes: [], appData: [join(Z, ".exxperts")], toolNames: HOME_TOOL_PLACES });
judge(ZELJKO, [
	[Z, "refused", "the profile"],
	[String.raw`d:\BENUTZER\ŽELJKO ŠARIĆ`, "refused", "the profile in other letters"],
	[String.raw`D:\Benutzer`, "refused", "holds it"],
	[String.raw`D:\ `.trim(), "refused", "its drive's root"],
	[join(Z, "AppData", "Roaming"), "refused", "Roaming"],
	[String.raw`d:\benutzer\željko šarić\appdata\LOCAL\temp`, "refused", "in Local, in other letters"],
	[join(Z, "AppData", "LocalLow"), "refused", "LocalLow in its usual place"],
	[join(Z, ".claude"), "refused", "another tool's folder"],
	[join(Z, ".exxperts"), "refused", "the app's data"],
	[join(Z, "Dokumente"), "grantable", "her documents"],
	[join(Z, "OneDrive", "Berichte"), "grantable", "in OneDrive"],
	[String.raw`C:\Users\Ana Lopez\Documents`, "grantable", "another drive's folder"],
], "a profile on D: with a non-ASCII name");

// ---- 4. The judge's entry ---------------------------------------------------------------------
// The script Windows answers holds every key the places are read from.
const asked = new Set([...FOLDERS_SCRIPT.matchAll(/^place '(\w+)'/gm)].map((match) => match[1]));
for (const key of ["profile", "roaming", "local", "locallow", "startup", "programs", "programfiles", "programfilesx86", "programdata", "windows"]) assert(asked.has(key), `the folder script doesn't ask Windows for ${key}`);
assert(FOLDERS_SCRIPT.includes("$f['onedrive']"), "the folder script doesn't ask for OneDrive");

const room = fs.realpathSync.native(fs.mkdtempSync(path.join(os.homedir(), "windows-folder-offer-")));
try {
	if (process.platform !== "win32") {
		// A failed read of Windows' answer is asked again a minute later, never at each judgement; a read answer is kept.
		const count = { asks: 0 };
		const asks = () => count.asks;
		const failing = () => (count.asks++, undefined);
		const answering = () => (count.asks++, JSON.stringify(ANSWER));
		const t = 1_000_000;
		assert(windowsAnswer({}, failing, t) === "" && asks() === 1, "a failed read");
		assert(windowsAnswer({}, answering, t + 1_000) === "" && asks() === 1, "a failed read was asked again within the minute");
		assert(windowsAnswer({}, answering, t + 60_000) === JSON.stringify(ANSWER) && asks() === 2, "a failed read was not asked again after the minute");
		assert(windowsAnswer({}, failing, t + 120_000) === JSON.stringify(ANSWER) && asks() === 2, "a read answer was not kept");
		console.log("ok: a failed read of Windows' answer is asked again a minute later, and a read one is kept");
		const grants = () => [roomFolderGrantable(room), folderGrantable(room, "write", [], "")];
		assert(grants().every(Boolean), `a room's folder in the home is refused off Windows: ${room}`);
		// A smoke acting as Windows for one call (path-shapes-smoke.ts) keeps this computer's rules.
		const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
		Object.defineProperty(process, "platform", { ...platform, value: "win32" });
		try {
			assert(grants().every(Boolean), "the Windows rule ran for a smoke acting as Windows on this computer");
		} finally {
			Object.defineProperty(process, "platform", platform);
		}
		// A server that is Windows from its first line asks the rule at both entries, and this computer's path is no Windows path.
		const entry = pathToFileURL(path.join(import.meta.dirname, "../src/room-box/folder-offer.ts")).href;
		const asWindows = spawnSync(process.execPath, [
			"--import", "tsx", "--import", "data:text/javascript,Object.defineProperty(process,'platform',{value:'win32'})", "--input-type=module",
			"-e", `import { folderGrantable, roomFolderGrantable } from ${JSON.stringify(entry)}; const room = ${JSON.stringify(room)}; console.log(JSON.stringify([roomFolderGrantable(room), folderGrantable(room, "write", [], "")]));`,
		], { encoding: "utf8" });
		assert(asWindows.status === 0, `the server as Windows didn't run: ${asWindows.stderr}`);
		assert(asWindows.stdout.trim() === "[false,false]", `a server on Windows doesn't ask the Windows rule at both entries: ${asWindows.stdout}`);
		console.log("ok: off Windows the rule never runs, and on Windows both entries ask it");
	} else {
		// On Windows the places come from Windows itself.
		assert(roomFolderGrantable(room) && folderGrantable(room, "write", [], ""), `a room's folder in the home is refused: ${room}`);
		const named = ["ProgramFiles", "ProgramData", "SystemRoot", "LOCALAPPDATA", "APPDATA"].map((name) => process.env[name]).filter((place): place is string => !!place);
		assert(named.length === 5, "this Windows names none of its folders");
		// Windows itself answered the folder script.
		const told = JSON.parse(windowsAnswer(process.env) || "{}") as Record<string, unknown>;
		for (const key of ["profile", "local", "startup", "programfiles"]) assert(typeof told[key] === "string" && told[key] !== "", `Windows' answer names no ${key}: ${JSON.stringify(told)}`);
		for (const place of [...named, path.join(process.env.LOCALAPPDATA!, "Programs"), os.userInfo().homedir]) {
			const real = fs.existsSync(place) ? fs.realpathSync.native(place) : place;
			assert(!roomFolderGrantable(real) && !folderGrantable(real, "read", [], ""), `${real} is grantable on Windows`);
		}
		console.log("ok: on Windows, Windows' own places are refused and a room in the home is not");
	}
} finally {
	fs.rmSync(room, { recursive: true, force: true });
}

console.log("windows-folder-offer-smoke: ok");
