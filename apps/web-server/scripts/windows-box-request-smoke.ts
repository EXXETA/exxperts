// The Windows box's request, built with path.win32 from given folders, so it
// runs on any computer. Given the folders of the PC that ran the test kit's
// round 4, a command's request is that kit's policy (c), field for field, with
// one more listable folder the kit's own shortcut left out (section 1): the
// room written, Windows' folders and the kit's tools read, the person's own
// folders shut, every folder above a grant listable. Then the rule's other
// cases: the room in Documents, Documents shut above its room refused, each
// subfolder of AppData\Local\Programs and never a drive, the personal folders
// read from Windows' answer, the paths no request may carry, a file call's
// request against a command's, the environment, the command line and the
// wrapper's proxy line, and its callers.
import { isDeepStrictEqual } from "node:util";
import fs from "node:fs";
import path from "node:path";

import { atOrInside, COMMAND_VARIABLE, commandRequest, fileRequest, TEMP_VARIABLE, type RequestResult, type WindowsBoxRequest, type WindowsRoomRules } from "../src/room-box/windows/box-request.js";
import { COMMAND_WRAPPER, encodedCommand, joinCommandLine } from "../src/room-box/windows/command-line.js";
import { FOLDERS_SCRIPT, readPersonalFolders, type ResolveFolder } from "../src/room-box/windows/personal-folders.js";

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

const show = (value: unknown) => JSON.stringify(value, null, 1);
/** Whether `inner` is `outer` or below it, by the names alone, ignoring case. */
const inside = (inner: string, outer: string) => {
	const [a, b] = [inner.toLowerCase(), outer.toLowerCase()];
	return a === b || a.startsWith(b.endsWith("\\") ? b : `${b}\\`);
};
function built(result: RequestResult, label: string): WindowsBoxRequest {
	assert(result.ok, `${label}: no request was built: ${show(result)}`);
	// In every request this smoke builds: no shut place at or above a granted one, and nothing listable inside a grant.
	const { readwritePaths, readonlyPaths, deniedPaths } = result.request.filesystem;
	const grants = [...readwritePaths, ...readonlyPaths];
	for (const closed of deniedPaths) assert(!grants.some((grant) => inside(grant, closed)), `${label}: ${closed} is shut above a grant`);
	for (const listed of result.request.containment.config.filesystem.enumeratePaths) assert(!grants.some((grant) => inside(listed, grant)), `${label}: ${listed} is listed inside a grant`);
	return result.request;
}
function refused(result: RequestResult, code: string, label: string, place?: string) {
	assert(!result.ok, `${label}: a request was built, though it must be refused: ${show(result)}`);
	assert(result.refused.code === code, `${label}: refused as ${result.refused.code}, not ${code}`);
	if (place !== undefined) assert("path" in result.refused && result.refused.path === place, `${label}: refused for ${show(result.refused)}, not ${place}`);
}
const lower = (paths: readonly string[]) => paths.map((place) => place.toLowerCase());
const has = (paths: readonly string[], place: string) => lower(paths).includes(place.toLowerCase());

// ---- The folders of round 4's PC ---------------------------------------------
// The kit's work folder sat in the person's temp, its rooms below it, and the
// Node it fetched one level further down. Git, Python and PowerShell 7 were not
// on that PC, so their folders were not read. .ssh was not there either.
const PROFILE = String.raw`C:\Users\Ana Lopez`;
const TEMP = String.raw`C:\Users\Ana Lopez\AppData\Local\Temp`;
const WORK = String.raw`C:\Users\Ana Lopez\AppData\Local\Temp\mxc-test-50661046`;
// curl's settings folder in the box root, which every command reads.
const BOX_CURL = String.raw`C:\Users\Ana Lopez\.exxperts.box\curl`;
const ROOM_C = String.raw`C:\Users\Ana Lopez\AppData\Local\Temp\mxc-test-50661046\rooms\policy-c`;
const NODE_DIR = String.raw`C:\Users\Ana Lopez\AppData\Local\Temp\mxc-test-50661046\node\node-v24.22.1-win-x64`;
const DOC_ROOM = String.raw`C:\Users\Ana Lopez\Documents\mxc-test-room-50661046`;
const DOCUMENTS = String.raw`C:\Users\Ana Lopez\Documents`;
const PROGRAMS = String.raw`C:\Users\Ana Lopez\AppData\Local\Programs`;

const SERVER_ENVIRONMENT: Record<string, string> = {
	ALLUSERSPROFILE: String.raw`C:\ProgramData`,
	APPDATA: String.raw`C:\Users\Ana Lopez\AppData\Roaming`,
	CommonProgramFiles: String.raw`C:\Program Files\Common Files`,
	"CommonProgramFiles(x86)": String.raw`C:\Program Files (x86)\Common Files`,
	CommonProgramW6432: String.raw`C:\Program Files\Common Files`,
	COMPUTERNAME: "DESKTOP-AB12CD",
	ComSpec: String.raw`C:\Windows\system32\cmd.exe`,
	HOMEDRIVE: "C:",
	HOMEPATH: String.raw`\Users\Ana Lopez`,
	LOCALAPPDATA: String.raw`C:\Users\Ana Lopez\AppData\Local`,
	NUMBER_OF_PROCESSORS: "8",
	OS: "Windows_NT",
	PATHEXT: ".COM;.EXE;.BAT;.CMD;.VBS;.VBE;.JS;.JSE;.WSF;.WSH;.MSC",
	PROCESSOR_ARCHITECTURE: "AMD64",
	PROCESSOR_IDENTIFIER: "Intel64 Family 6 Model 140 Stepping 1, GenuineIntel",
	PROCESSOR_LEVEL: "6",
	PROCESSOR_REVISION: "8c01",
	ProgramData: String.raw`C:\ProgramData`,
	ProgramFiles: String.raw`C:\Program Files`,
	"ProgramFiles(x86)": String.raw`C:\Program Files (x86)`,
	ProgramW6432: String.raw`C:\Program Files`,
	PUBLIC: String.raw`C:\Users\Public`,
	SystemDrive: "C:",
	// Spelled as Windows spells it in some shells: names ignore case there.
	SYSTEMROOT: String.raw`C:\Windows`,
	TEMP,
	TMP: TEMP,
	USERDOMAIN: "DESKTOP-AB12CD",
	USERNAME: "Ana Lopez",
	USERPROFILE: PROFILE,
	windir: String.raw`C:\Windows`,
	Path: String.raw`C:\Windows\system32;C:\Windows;C:\Users\Ana Lopez\AppData\Roaming\npm`,
	// What a server's own environment holds that no command may see.
	EXXPERTS_TOKEN: "token-value",
	ANTHROPIC_API_KEY: "key-value",
	OPENAI_API_KEY: "key-value",
	GITHUB_TOKEN: "token-value",
	MXC_DIAG_CONSOLE: "1",
	EXXETA_PERSISTENT_AGENTS_ROOT: String.raw`C:\Users\Ana Lopez\.exxperts\app\personalized-agents`,
};

// Windows' answer to the folder script on that PC, and what is on its disk.
const V4_ANSWER = JSON.stringify({
	profile: PROFILE,
	documents: DOCUMENTS,
	desktop: String.raw`C:\Users\Ana Lopez\Desktop`,
	downloads: String.raw`C:\Users\Ana Lopez\Downloads`,
	pictures: String.raw`C:\Users\Ana Lopez\Pictures`,
	music: String.raw`C:\Users\Ana Lopez\Music`,
	videos: String.raw`C:\Users\Ana Lopez\Videos`,
	favorites: String.raw`C:\Users\Ana Lopez\Favorites`,
	roaming: String.raw`C:\Users\Ana Lopez\AppData\Roaming`,
	onedrive: [String.raw`C:\Users\Ana Lopez\OneDrive`],
});
const V4_DISK = [
	PROFILE, DOCUMENTS, ...["Desktop", "Downloads", "Pictures", "Music", "Videos", "Favorites", String.raw`AppData\Roaming`, "OneDrive"].map((name) => path.win32.join(PROFILE, name)),
];

/** A stand-in for the box's answer: the real spelling of each folder on the disk, every call recorded. */
function disk(folders: readonly string[], aliases: Record<string, string> = {}, files: readonly string[] = []) {
	const asked: string[] = [];
	const resolve: ResolveFolder = (place) => {
		asked.push(place);
		const real = aliases[place.toLowerCase()] ?? place;
		const folder = folders.find((known) => known.toLowerCase() === real.toLowerCase());
		if (folder !== undefined) return { real: folder, folder: true };
		const file = files.find((known) => known.toLowerCase() === real.toLowerCase());
		return file === undefined ? undefined : { real: file, folder: false };
	};
	return { resolve, asked };
}

function personalOf(answer: string, resolve: ResolveFolder): string[] {
	const read = readPersonalFolders(answer, resolve);
	assert(read.ok, `the folder answer was not read: ${show(read)}`);
	return read.folders.found.map((folder) => folder.path);
}

const V4_PERSONAL = personalOf(V4_ANSWER, disk(V4_DISK).resolve);

function v4Rules(room: string, more: Partial<WindowsRoomRules> = {}): WindowsRoomRules {
	return {
		room: { folder: room, canChangeFiles: true },
		alsoAllowed: [],
		skillFolders: [],
		// The kit's TEMP and npm cache sat in its room for the jobs that used them.
		places: { temp: path.win32.join(room, "temp"), caches: path.win32.join(room, ".npm-cache"), curlHome: BOX_CURL },
		profile: PROFILE,
		personal: V4_PERSONAL,
		denied: [],
		closedNames: { readOnly: [], denied: [] },
		environment: SERVER_ENVIRONMENT,
		tools: [NODE_DIR, `${WORK}\\tools`, `${WORK}\\jobs`, `${WORK}\\remote.git`, `${WORK}\\fakehome`],
		pathFolders: [NODE_DIR, String.raw`C:\Windows\System32`, String.raw`C:\Windows`, String.raw`C:\Windows\System32\Wbem`, String.raw`C:\Windows\System32\WindowsPowerShell\v1.0`],
		programs: { folder: PROGRAMS, names: [] },
		...more,
	};
}

const WRAPPER = "Write-Output BOX-ALIVE";
const call = (more: Partial<Parameters<typeof commandRequest>[1]> = {}) => ({ wrapper: WRAPPER, text: "Get-ChildItem", timeoutMs: 60000, ...more });

// ---- 1. Round 4's policy (c), field for field, plus one listable folder and curl's settings --
// The kit's request for one job in (c)'s room, written out from its
// definePolicies and boxRequest for that PC's folders, with curl's settings
// folder read and the box root above it listed. Its environment carries
// the kit's own test names, so the environment is checked by its kept names below.
const POLICY_C: Omit<WindowsBoxRequest, "environment"> = {
	command: String.raw`C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -OutputFormat Text -EncodedCommand VwByAGkAdABlAC0ATwB1AHQAcAB1AHQAIABCAE8AWAAtAEEATABJAFYARQA=`,
	workingDirectory: ROOM_C,
	filesystem: {
		readwritePaths: [ROOM_C],
		readonlyPaths: [
			BOX_CURL,
			String.raw`C:\Windows`, String.raw`C:\Program Files`, String.raw`C:\Program Files (x86)`, String.raw`C:\ProgramData`,
			NODE_DIR, `${WORK}\\tools`, `${WORK}\\jobs`, `${WORK}\\remote.git`, `${WORK}\\fakehome`,
		],
		deniedPaths: [
			DOCUMENTS, `${PROFILE}\\Desktop`, `${PROFILE}\\Downloads`, `${PROFILE}\\Pictures`, `${PROFILE}\\Music`,
			`${PROFILE}\\Videos`, `${PROFILE}\\Favorites`, `${PROFILE}\\AppData\\Roaming`, `${PROFILE}\\OneDrive`,
		],
	},
	containment: {
		type: "processcontainer",
		config: {
			filesystem: {
				enumeratePaths: [
					`${WORK}\\rooms`, WORK, TEMP, String.raw`C:\Users\Ana Lopez\AppData\Local`, String.raw`C:\Users\Ana Lopez\AppData`, PROFILE, String.raw`C:\Users`, "C:\\",
					path.win32.dirname(BOX_CURL),
					// The one folder the kit's shortcut skipped (toolEnumerate: a Node inside the work folder was taken as covered).
					// The design's rule lists every folder above a granted path, and the kit's Node sits one below this one.
					`${WORK}\\node`,
				],
			},
		},
	},
	network: { egress: { default: "deny" }, ingress: { default: "deny", hostLoopback: "deny" } },
	ui: { disable: false, clipboard: "none", allowInputInjection: false },
	inheritDefaultEnvironment: false,
	timeoutMs: 60000,
};
const SITES = { egress: { default: "deny" }, ingress: { default: "allow", hostLoopback: "allow" }, runtimeConfig: { networkProxy: "http://127.0.0.1:49152" } };

const withoutEnvironment = ({ environment: _environment, ...rest }: WindowsBoxRequest) => rest;
{
	const request = built(commandRequest(v4Rules(ROOM_C), call()), "(c)");
	assert(isDeepStrictEqual(withoutEnvironment(request), POLICY_C), `(c): the request differs from the kit's policy (c):\n${show(withoutEnvironment(request))}`);
	const sites = built(commandRequest(v4Rules(ROOM_C), call({ proxyPort: 49152 })), "(c) with sites");
	assert(isDeepStrictEqual(withoutEnvironment(sites), { ...POLICY_C, network: SITES }), `(c) with sites: the request differs from the kit's policy (c) with its proxy:\n${show(sites.network)}`);

	// Red when one field changes: every leaf of the request, and every list's length, changed one at a time.
	let changed = 0;
	const visit = (value: unknown, change: (next: unknown) => unknown) => {
		if (Array.isArray(value)) {
			const bigger = change([...value, "C:\\extra"]);
			assert(!isDeepStrictEqual(bigger, POLICY_C), "a list one longer still reads as (c)");
			value.forEach((item, index) => visit(item, (next) => change(value.map((other, at) => (at === index ? next : other)))));
		} else if (value !== null && typeof value === "object") {
			for (const [key, item] of Object.entries(value)) visit(item, (next) => change({ ...value, [key]: next }));
		} else {
			const next = change(typeof value === "number" ? value + 1 : typeof value === "boolean" ? !value : `${value}x`);
			assert(!isDeepStrictEqual(next, POLICY_C), `a changed field still reads as (c): ${show(next)}`);
			changed += 1;
		}
	};
	visit(withoutEnvironment(request), (next) => next);
	assert(changed > 30, `only ${changed} fields were changed`);

	// The kit's own environment, apart from the names the box sets itself to the room's places.
	const KIT_BASE = [
		"ALLUSERSPROFILE", "CommonProgramFiles", "CommonProgramFiles(x86)", "CommonProgramW6432", "COMPUTERNAME", "ComSpec", "HOMEDRIVE", "HOMEPATH",
		"NUMBER_OF_PROCESSORS", "OS", "PATHEXT", "PROCESSOR_ARCHITECTURE", "PROCESSOR_IDENTIFIER", "PROCESSOR_LEVEL", "PROCESSOR_REVISION",
		"ProgramData", "ProgramFiles", "ProgramFiles(x86)", "ProgramW6432", "PUBLIC", "SystemDrive", "SystemRoot", "USERDOMAIN", "USERNAME", "USERPROFILE", "windir",
	];
	for (const name of KIT_BASE) assert(request.environment[name] !== undefined, `(c): the environment lacks ${name}`);
	assert(request.environment.SystemRoot === String.raw`C:\Windows`, "(c): SystemRoot is not read whatever its case");
	assert(request.environment.TEMP === `${ROOM_C}\\temp` && request.environment.TMP === `${ROOM_C}\\temp`, "(c): TEMP and TMP are not the turn's temp");
	assert(request.environment.APPDATA === `${ROOM_C}\\.npm-cache\\AppData\\Roaming` && request.environment.LOCALAPPDATA === `${ROOM_C}\\.npm-cache\\AppData\\Local`, "(c): APPDATA and LOCALAPPDATA are not in the caches");
	console.log("ok: round 4's policy (c), field for field, plus the one listable folder above the kit's Node, and red when any one field changes");
}

// ---- 2. The room in Documents: (d1) and (d2) ------------------------------------------
{
	const request = built(commandRequest(v4Rules(DOC_ROOM), call()), "(d1)");
	assert(!has(request.filesystem.deniedPaths, DOCUMENTS), "(d1): Documents is shut above its room");
	assert(isDeepStrictEqual(request.filesystem.deniedPaths, POLICY_C.filesystem.deniedPaths.slice(1)), `(d1): the other folders are not all shut: ${show(request.filesystem.deniedPaths)}`);
	assert(has(request.containment.config.filesystem.enumeratePaths, DOCUMENTS), "(d1): Documents is not listable above its room");
	assert(isDeepStrictEqual(request.filesystem.readwritePaths, [DOC_ROOM]), "(d1): the room is not the one written place");
	// (d2): Documents shut, the room inside it. Every delete and rename failed that way.
	refused(commandRequest(v4Rules(DOC_ROOM, { denied: [DOCUMENTS] }), call()), "denied-over-grant", "(d2)", DOCUMENTS);
	// The same shut place beside the room, not above it, is fine.
	const beside = built(commandRequest(v4Rules(ROOM_C, { denied: [DOCUMENTS] }), call()), "Documents shut beside the room");
	assert(has(beside.filesystem.deniedPaths, DOCUMENTS), "a place shut beside the room is not shut");
	// A folder whose name starts with two dots is inside its parent like any other.
	const dotted = `${PROFILE}\\Projects\\..reports`;
	refused(commandRequest(v4Rules(dotted, { denied: [`${PROFILE}\\Projects`] }), call()), "denied-over-grant", "a room named ..reports under a shut place", `${PROFILE}\\Projects`);
	const dottedName = built(commandRequest(v4Rules(ROOM_C, { closedNames: { readOnly: ["..settings"], denied: [] } }), call()), "a closed name starting with two dots");
	assert(has(dottedName.filesystem.readonlyPaths, `${ROOM_C}\\..settings`), "a closed name starting with two dots is refused");
	console.log("ok: (d1) leaves Documents listable above its room, (d2)'s shape is refused");
}

// ---- 3. Programs installed just for her, and never a drive -----------------------------
{
	const install = `${PROGRAMS}\\exxperts`;
	const rules = v4Rules(ROOM_C, {
		programs: { folder: PROGRAMS, names: ["Python", "Microsoft VS Code", "Git", "exxperts", "..", "a\\b"] },
		denied: [install],
		pathFolders: ["C:\\", "D:\\", PROFILE, String.raw`C:\Users`, String.raw`C:\Tools\bin`, `${PROGRAMS}\\Python\\Scripts`],
		tools: ["E:\\", NODE_DIR],
	});
	const request = built(commandRequest(rules, call()), "Programs");
	const { readonlyPaths, readwritePaths } = request.filesystem;
	for (const name of ["Python", "Microsoft VS Code", "Git"]) assert(has(readonlyPaths, `${PROGRAMS}\\${name}`), `Programs: ${name} is not read`);
	assert(!readonlyPaths.some((place) => place.toLowerCase().startsWith(install.toLowerCase())), "Programs: the app's own install folder is read");
	assert(has(request.filesystem.deniedPaths, install), "Programs: the app's own install folder is not shut");
	assert(!has(readonlyPaths, PROGRAMS), "Programs: the Programs folder itself is read");
	assert(!readonlyPaths.some((place) => place.endsWith("\\..") || place.endsWith("\\b")), "Programs: a name that isn't a subfolder is read");
	assert(!has(readonlyPaths, `${PROGRAMS}\\Python\\Scripts`), "Programs: a PATH folder inside a subfolder already read is listed again");
	assert(has(request.environment.PATH.split(";"), `${PROGRAMS}\\Python\\Scripts`), "Programs: a PATH folder inside a subfolder is not on PATH");
	assert(has(readonlyPaths, String.raw`C:\Tools\bin`), "an ordinary PATH folder is not read");
	for (const place of [...readwritePaths, ...readonlyPaths]) assert(path.win32.parse(place).root !== place, `a whole drive is granted: ${place}`);
	for (const place of [PROFILE, String.raw`C:\Users`]) assert(!has(readonlyPaths, place), `a PATH folder at or above the profile is read: ${place}`);
	const listable = request.containment.config.filesystem.enumeratePaths;
	for (const place of [PROGRAMS, String.raw`C:\Users\Ana Lopez\AppData\Local`, String.raw`C:\Users\Ana Lopez\AppData`]) assert(has(listable, place), `Programs: ${place} is not listable`);
	// A PATH folder inside the written room, such as a venv's: on PATH, with no read grant of its own.
	const venv = `${ROOM_C}\\.venv\\Scripts`;
	const inRoom = built(commandRequest(v4Rules(ROOM_C, { pathFolders: [venv, String.raw`C:\Windows\System32`] }), call()), "a venv in the room");
	assert(has(inRoom.environment.PATH.split(";"), venv), `a venv in the room is not on PATH: ${inRoom.environment.PATH}`);
	assert(!has(inRoom.filesystem.readonlyPaths, venv), "a venv in the written room gets a read grant that narrows it");
	console.log("ok: each subfolder of AppData\\Local\\Programs is read but the app's own, and no drive root is granted");
}

// ---- 4. The personal folders, from Windows' answer --------------------------------------
{
	assert(isDeepStrictEqual(V4_PERSONAL, POLICY_C.filesystem.deniedPaths), `round 4's answer: ${show(V4_PERSONAL)}`);
	const v4 = readPersonalFolders(V4_ANSWER, disk(V4_DISK).resolve);
	assert(v4.ok && isDeepStrictEqual(v4.folders.leftOut, [{ key: "ssh", label: ".ssh", why: "missing" }]), `round 4: .ssh is not the one folder left out: ${show(v4)}`);

	// Documents redirected to a share: never resolved, never shut, never in a request.
	for (const share of [String.raw`\\fileserver\home$\ana\Documents`, String.raw`\\?\UNC\fileserver\home$\ana\Documents`, "//fileserver/home/ana/Documents"]) {
		const { resolve, asked } = disk(V4_DISK);
		const read = readPersonalFolders(JSON.stringify({ ...JSON.parse(V4_ANSWER), documents: share }), resolve);
		assert(read.ok, "a share: the answer was not read");
		assert(!asked.includes(share), `a share was resolved: ${share}`);
		assert(read.folders.leftOut.some((left) => left.key === "documents" && left.why === "on-the-network"), `a share is not left out as on the network: ${show(read.folders.leftOut)}`);
		assert(read.folders.found.length === 8 && !read.folders.found.some((folder) => folder.key === "documents"), "a share: the other folders are not all found");
		const request = built(commandRequest(v4Rules(ROOM_C, { personal: read.folders.found.map((folder) => folder.path) }), call()), "a share");
		assert(!JSON.stringify(request).includes("fileserver"), "a share reached the request");
	}

	// A missing folder, and .ssh where it is there.
	{
		const music = `${PROFILE}\\Music`;
		const read = readPersonalFolders(V4_ANSWER, disk([...V4_DISK.filter((place) => place !== music), `${PROFILE}\\.ssh`]).resolve);
		assert(read.ok && read.folders.leftOut.some((left) => left.key === "music" && left.why === "missing"), `a missing Music is not left out: ${show(read)}`);
		assert(read.ok && read.folders.found.some((folder) => folder.key === "ssh" && folder.path === `${PROFILE}\\.ssh`), "a .ssh that is there is not found");
	}

	// Documents in OneDrive: both shut, and neither when the room sits inside.
	{
		const oneDrive = `${PROFILE}\\OneDrive - Acme GmbH`;
		const docs = `${oneDrive}\\Documents`;
		const answer = JSON.stringify({ ...JSON.parse(V4_ANSWER), documents: docs, onedrive: [oneDrive, oneDrive.toUpperCase()] });
		const read = readPersonalFolders(answer, disk([...V4_DISK, oneDrive, docs]).resolve);
		assert(read.ok, "OneDrive: the answer was not read");
		const found = read.folders.found.map((folder) => folder.path);
		assert(has(found, docs) && has(found, oneDrive), `OneDrive: Documents in OneDrive or OneDrive itself is not found: ${show(found)}`);
		assert(read.folders.leftOut.some((left) => left.why === "same-as-another"), "OneDrive: the same folder named twice is not left out once");
		const away = built(commandRequest(v4Rules(ROOM_C, { personal: found }), call()), "OneDrive, room away");
		assert(has(away.filesystem.deniedPaths, docs) && has(away.filesystem.deniedPaths, oneDrive), "OneDrive: Documents in OneDrive is not shut");
		const room = `${docs}\\Reports`;
		const inside = built(commandRequest(v4Rules(room, { personal: found }), call()), "OneDrive, room inside");
		assert(!has(inside.filesystem.deniedPaths, docs) && !has(inside.filesystem.deniedPaths, oneDrive), "OneDrive: a folder above the room is shut");
		assert(has(inside.containment.config.filesystem.enumeratePaths, docs) && has(inside.containment.config.filesystem.enumeratePaths, oneDrive), "OneDrive: a folder above the room is not listable");
	}

	// Documents redirected to D:\Docs: still hers, so shut, unlike the kit, which left such folders out.
	{
		const read = readPersonalFolders(JSON.stringify({ ...JSON.parse(V4_ANSWER), documents: String.raw`D:\Docs` }), disk([...V4_DISK, String.raw`D:\Docs`]).resolve);
		assert(read.ok && read.folders.found.some((folder) => folder.key === "documents" && folder.path === String.raw`D:\Docs`), "D:\\Docs is not found");
		const found = read.ok ? read.folders.found.map((folder) => folder.path) : [];
		const away = built(commandRequest(v4Rules(ROOM_C, { personal: found }), call()), "D:\\Docs, room on C:");
		assert(has(away.filesystem.deniedPaths, String.raw`D:\Docs`), "D:\\Docs is not shut");
		// A room on D:\ itself: the person's choice, written; D:\Docs inside it still shut.
		const drive = built(commandRequest(v4Rules("D:\\", { personal: found, places: { temp: `${WORK}\\temp`, caches: `${WORK}\\caches`, curlHome: BOX_CURL } }), call()), "a room on D:\\");
		assert(has(drive.filesystem.readwritePaths, "D:\\"), "a room on D:\\ is not written");
		assert(has(drive.filesystem.deniedPaths, String.raw`D:\Docs`), "a room on D:\\: D:\\Docs inside it is not shut");
		assert(!has(drive.containment.config.filesystem.enumeratePaths, "D:\\"), "a room on D:\\: the room itself is listed as above a grant");
	}

	// Case and 8.3 spellings: the profile and Downloads as the box resolves them.
	{
		const short = String.raw`C:\Users\ANALOP~1`;
		const answer = JSON.stringify({ ...JSON.parse(V4_ANSWER), profile: short, downloads: String.raw`c:\users\ana lopez\DOWNLOADS` });
		const read = readPersonalFolders(answer, disk(V4_DISK, { [short.toLowerCase()]: PROFILE }).resolve);
		assert(read.ok && read.folders.profile === PROFILE, `8.3: the profile is not its real name: ${show(read)}`);
		assert(read.ok && read.folders.found.some((folder) => folder.key === "downloads" && folder.path === `${PROFILE}\\Downloads`), "case: Downloads is not its real spelling");
		const room = String.raw`c:\users\ana lopez\documents\Reports`;
		const request = built(commandRequest(v4Rules(room), call()), "case");
		assert(!has(request.filesystem.deniedPaths, DOCUMENTS), "case: Documents above a room spelled in other case is shut");
	}

	// The profile itself, a file, a folder Windows didn't name, and answers that can't be read.
	{
		const answer = JSON.stringify({ profile: PROFILE, documents: PROFILE, desktop: `${PROFILE}\\Desktop.lnk` });
		const read = readPersonalFolders(answer, disk(V4_DISK, {}, [`${PROFILE}\\Desktop.lnk`]).resolve);
		assert(read.ok, "the profile itself: the answer was not read");
		assert(read.folders.leftOut.some((left) => left.key === "documents" && left.why === "the-profile"), "a Documents at the profile itself is shut");
		assert(read.folders.leftOut.some((left) => left.key === "desktop" && left.why === "not-a-folder"), "a Desktop that is a file is shut");
		assert(read.folders.found.some((folder) => folder.key === "pictures" && folder.path === `${PROFILE}\\Pictures`), "a folder Windows didn't name is not looked for in its usual place");
		for (const bad of ["", "not json", "[]", "null", JSON.stringify({ profile: String.raw`\\server\profiles\ana` })]) {
			const unread = readPersonalFolders(bad, disk(V4_DISK).resolve);
			assert(!unread.ok, `an answer that can't be read gave folders: ${bad}`);
		}
		assert(FOLDERS_SCRIPT.includes("GetFolderPath('MyDocuments')") && FOLDERS_SCRIPT.includes("OneDrive\\Accounts"), "the folder script doesn't ask Windows");
	}
	console.log("ok: the personal folders from Windows' answer: a share, a missing folder, OneDrive, D:\\Docs, case and 8.3");
}

// ---- 5. Also allowed inside Downloads, and closed names -------------------------------
{
	const invoices = `${PROFILE}\\Downloads\\Invoices`;
	const request = built(commandRequest(v4Rules(ROOM_C, { alsoAllowed: [{ path: invoices, access: "read" }] }), call()), "Also allowed in Downloads");
	assert(!has(request.filesystem.deniedPaths, `${PROFILE}\\Downloads`), "Downloads is shut above an Also allowed folder");
	assert(has(request.containment.config.filesystem.enumeratePaths, `${PROFILE}\\Downloads`), "Downloads is not listable above an Also allowed folder");
	assert(has(request.filesystem.readonlyPaths, invoices) && !has(request.filesystem.readwritePaths, invoices), "a Can read folder is not read only");
	assert(request.filesystem.deniedPaths.length === 8, "the other folders are not all shut");

	const closed = built(commandRequest(v4Rules(ROOM_C, { closedNames: { readOnly: [".git\\config"], denied: [".vscode"] } }), call()), "closed names");
	assert(has(closed.filesystem.readonlyPaths, `${ROOM_C}\\.git\\config`) && has(closed.filesystem.deniedPaths, `${ROOM_C}\\.vscode`), "closed names are not carried");
	assert(!has(closed.containment.config.filesystem.enumeratePaths, `${ROOM_C}\\.git`), "a folder inside the room is listed as above a grant");
	const none = built(commandRequest(v4Rules(ROOM_C), call()), "no closed names");
	assert(!JSON.stringify(none).includes(".vscode") && !JSON.stringify(none).includes(".git\\\\config"), "closed names are carried while the list is empty");
	// A room that can't change files changes no folder on its list, a Can change one included: it is read only, as on a Mac.
	const shared = `${PROFILE}\\Projects\\shared`;
	const readOnlyRoom = built(commandRequest(v4Rules(ROOM_C, { room: { folder: ROOM_C, canChangeFiles: false }, alsoAllowed: [{ path: shared, access: "write" }] }), call()), "a room that can't change files");
	assert(!has(readOnlyRoom.filesystem.readwritePaths, shared) && !has(readOnlyRoom.filesystem.readwritePaths, ROOM_C), `a room that can't change files writes: ${show(readOnlyRoom.filesystem.readwritePaths)}`);
	assert(has(readOnlyRoom.filesystem.readonlyPaths, shared) && has(readOnlyRoom.filesystem.readonlyPaths, ROOM_C), "a room that can't change files can't read its Can change folder or its own");
	const writingRoom = built(commandRequest(v4Rules(ROOM_C, { alsoAllowed: [{ path: shared, access: "write" }] }), call()), "a room that can change files");
	assert(has(writingRoom.filesystem.readwritePaths, shared) && !has(writingRoom.filesystem.readonlyPaths, shared), "a room that can change files can't change its Can change folder");
	console.log("ok: an Also allowed folder in Downloads leaves Downloads open and listable; closed names are inputs, empty by default");
}

// ---- 6. Paths no request may carry -----------------------------------------------------
{
	const SHAPES = [String.raw`\\host\share\elsewhere`, "//host/share/elsewhere", String.raw`\\?\UNC\host\share\elsewhere`, String.raw`\\.\pipe\elsewhere`, String.raw`\\?\C:\elsewhere`, "C:elsewhere", String.raw`\elsewhere`, "elsewhere"];
	for (const shape of SHAPES) {
		refused(commandRequest(v4Rules(shape, { places: { temp: `${WORK}\\temp`, caches: `${WORK}\\caches`, curlHome: BOX_CURL } }), call()), "path-shape", `a room at ${shape}`, shape);
		refused(commandRequest(v4Rules(ROOM_C, { alsoAllowed: [{ path: shape, access: "read" }] }), call()), "path-shape", `an Also allowed folder at ${shape}`, shape);
		refused(commandRequest(v4Rules(ROOM_C, { tools: [shape] }), call()), "path-shape", `a tool at ${shape}`, shape);
		refused(commandRequest(v4Rules(ROOM_C, { skillFolders: [shape] }), call()), "path-shape", `a skill folder at ${shape}`, shape);
		refused(commandRequest(v4Rules(ROOM_C, { denied: [shape] }), call()), "path-shape", `a shut place at ${shape}`, shape);
		refused(commandRequest(v4Rules(ROOM_C, { personal: [shape] }), call()), "path-shape", `a personal folder at ${shape}`, shape);
		refused(commandRequest(v4Rules(ROOM_C, { places: { temp: shape, caches: `${ROOM_C}\\c`, curlHome: BOX_CURL } }), call()), "path-shape", `a temp at ${shape}`, shape);
		refused(fileRequest(v4Rules(ROOM_C), { argv: ["node.exe"], program: [shape], writes: false, timeoutMs: 1000 }), "path-shape", `a program at ${shape}`, shape);
		// On PATH a share is left out, and its local neighbour kept.
		const onPath = built(commandRequest(v4Rules(ROOM_C, { pathFolders: [shape, String.raw`C:\Tools\bin`] }), call()), `PATH with ${shape}`);
		assert(!JSON.stringify(onPath).includes("elsewhere") && has(onPath.filesystem.readonlyPaths, String.raw`C:\Tools\bin`), `PATH: ${shape} reached the request, or its neighbour didn't`);
	}
	for (const name of ["..\\outside", "C:x", String.raw`C:\x`, String.raw`\\host\x`]) {
		refused(commandRequest(v4Rules(ROOM_C, { closedNames: { readOnly: [name], denied: [] } }), call()), "path-shape", `a closed name ${name}`, name);
	}
	// The allowed neighbours: forward slashes and a trailing slash on a local path.
	const slashes = built(commandRequest(v4Rules(ROOM_C.replaceAll("\\", "/") + "/"), call()), "forward slashes");
	assert(slashes.workingDirectory === ROOM_C, `forward slashes: ${slashes.workingDirectory}`);
	console.log("ok: network, device and drive-relative paths are never put into a request");
}

// ---- 7. A file call's request against a command's -------------------------------------
{
	const write = `${PROFILE}\\Projects\\shared`;
	const read = `${PROFILE}\\Projects\\specs`;
	const program = [`${PROGRAMS}\\exxperts\\resources\\node.exe`, `${PROGRAMS}\\exxperts\\resources\\file-worker.mjs`];
	const rules = v4Rules(ROOM_C, {
		alsoAllowed: [{ path: write, access: "write" }, { path: read, access: "read" }],
		skillFolders: [`${WORK}\\skills\\report`],
		programs: { folder: PROGRAMS, names: ["Python"] },
		pathFolders: [...v4Rules(ROOM_C).pathFolders, String.raw`C:\Tools\bin`],
	});
	const command = built(commandRequest(rules, call({ proxyPort: 49152 })), "command beside a file call");
	const fileCall = { argv: [program[0], program[1]], program, timeoutMs: 30000 };
	const reading = built(fileRequest(rules, { ...fileCall, writes: false }), "a read");
	const writing = built(fileRequest(rules, { ...fileCall, writes: true }), "a write");

	// The same: the shut places, the working folder, the window rules.
	for (const file of [reading, writing]) {
		assert(isDeepStrictEqual(file.filesystem.deniedPaths, command.filesystem.deniedPaths), "a file call shuts other places than the command");
		assert(file.workingDirectory === command.workingDirectory && isDeepStrictEqual(file.ui, command.ui) && file.inheritDefaultEnvironment === false, "a file call differs in folder or window rules");
	}
	// Difference 1: no network.
	assert(isDeepStrictEqual(reading.network, POLICY_C.network) && isDeepStrictEqual(writing.network, POLICY_C.network), "a file call has a network");
	// Difference 2: a read writes nothing; the room and the Can change folder are read.
	assert(reading.filesystem.readwritePaths.length === 0, `a read writes: ${show(reading.filesystem.readwritePaths)}`);
	for (const place of [ROOM_C, write, read]) assert(has(reading.filesystem.readonlyPaths, place), `a read doesn't read ${place}`);
	// Difference 3: a write writes the writable places only, never the temp or caches.
	assert(isDeepStrictEqual(writing.filesystem.readwritePaths, [ROOM_C, write]), `a write writes other places: ${show(writing.filesystem.readwritePaths)}`);
	// Difference 4: the program's files are read, and nothing the command can't reach besides.
	for (const file of program) assert(has(reading.filesystem.readonlyPaths, file) && !has(command.filesystem.readonlyPaths, file), `the program file ${file} is not read, or the command reads it too`);
	const commandGrants = [...command.filesystem.readwritePaths, ...command.filesystem.readonlyPaths];
	for (const file of [reading, writing]) {
		for (const grant of file.filesystem.readwritePaths) assert(command.filesystem.readwritePaths.some((root) => inside(grant, root)), `a file call writes what a command can't: ${grant}`);
		for (const grant of file.filesystem.readonlyPaths) {
			if (has(program, grant)) continue;
			assert(commandGrants.some((root) => inside(grant, root)), `a file call reads what a command can't: ${grant}`);
		}
	}
	// Difference 5: no tools, PATH, programs, temp or caches.
	for (const place of [NODE_DIR, `${PROGRAMS}\\Python`, String.raw`C:\Tools\bin`]) assert(!has(reading.filesystem.readonlyPaths, place), `a file call reads ${place}`);
	assert(has(command.filesystem.readonlyPaths, String.raw`C:\Tools\bin`) && has(command.environment.PATH.split(";"), String.raw`C:\Tools\bin`), "a command doesn't read its PATH folder, so the line above proves nothing");
	const commandOnly = built(commandRequest(v4Rules(`${PROFILE}\\Projects\\room`), call()), "a room away from its temp");
	const fileOnly = built(fileRequest(v4Rules(`${PROFILE}\\Projects\\room`), { ...fileCall, writes: true }), "a write away from its temp");
	assert(!JSON.stringify(fileOnly.filesystem).includes("\\\\temp") && !JSON.stringify(fileOnly.filesystem).includes(".npm-cache"), "a file call writes the temp or caches");
	assert(commandOnly.filesystem.readwritePaths.length === 1, "a room's temp and caches inside it are listed again");
	// Difference 6: the environment holds Windows' own names only: no PATH, temp, proxy or command.
	for (const name of ["PATH", "TEMP", TEMP_VARIABLE, "HTTP_PROXY", COMMAND_VARIABLE, "APPDATA"]) assert(reading.environment[name] === undefined, `a file call's environment has ${name}`);
	assert(reading.environment.SystemRoot === String.raw`C:\Windows`, "a file call's environment lacks SystemRoot");
	// Difference 7: the line is the program's own, joined by the C runtime's rules.
	assert(reading.command === String.raw`"C:\Users\Ana Lopez\AppData\Local\Programs\exxperts\resources\node.exe" "C:\Users\Ana Lopez\AppData\Local\Programs\exxperts\resources\file-worker.mjs"`, `a file call's line: ${reading.command}`);
	assert(reading.timeoutMs === 30000, "a file call's limit is not its own");
	console.log("ok: a file call's request differs from a command's in its network, its writes, its program, its places, its environment and its line");
}

// ---- 8. The environment and the command line ------------------------------------------
{
	const npm = `${PROFILE}\\AppData\\Roaming\\npm`;
	const request = built(commandRequest(v4Rules(ROOM_C, { pathFolders: [...v4Rules(ROOM_C).pathFolders, npm, String.raw`C:\Tools\bin`] }), call({ proxyPort: 49152, text: "Get-Content .\\notes.txt" })), "environment");
	assert(has(request.filesystem.deniedPaths, `${PROFILE}\\AppData\\Roaming`), "AppData\\Roaming is not shut");
	assert(!has(request.environment.PATH.split(";"), npm) && !has(request.filesystem.readonlyPaths, npm), "a PATH folder inside a shut one is on PATH or read");
	assert(has(request.environment.PATH.split(";"), String.raw`C:\Tools\bin`), "an ordinary PATH folder beside it is not on PATH");
	const names = Object.keys(request.environment);
	for (const secret of ["EXXPERTS_TOKEN", "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GITHUB_TOKEN", "EXXETA_PERSISTENT_AGENTS_ROOT", "Path"]) assert(!names.includes(secret), `the environment carries ${secret}`);
	assert(!names.some((name) => name.toUpperCase().startsWith("MXC_")), "the environment carries an MXC_ name");
	assert(!Object.values(request.environment).some((value) => value === "token-value" || value === "key-value"), "the environment carries a secret's value");
	assert(request.environment[COMMAND_VARIABLE] === "Get-Content .\\notes.txt", "the model's text is not in its variable");
	assert(!request.command.includes("notes"), "the model's text is on the command line");
	assert(request.environment.PSModulePath === String.raw`C:\Windows\System32\WindowsPowerShell\v1.0\Modules;C:\Program Files\WindowsPowerShell\Modules`, `PSModulePath: ${request.environment.PSModulePath}`);
	const sharedProgramFiles = built(commandRequest(v4Rules(ROOM_C, { environment: { ...SERVER_ENVIRONMENT, ProgramFiles: String.raw`\\host\programs` } }), call()), "ProgramFiles on a share");
	assert(sharedProgramFiles.environment.PSModulePath === String.raw`C:\Windows\System32\WindowsPowerShell\v1.0\Modules`, `a ProgramFiles on a share reached PSModulePath: ${sharedProgramFiles.environment.PSModulePath}`);
	for (const name of ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy"]) assert(request.environment[name] === "http://127.0.0.1:49152", `${name} is not the turn's proxy`);
	assert(request.environment.NO_PROXY === "" && request.environment.NODE_USE_ENV_PROXY === "1", "NO_PROXY or NODE_USE_ENV_PROXY");
	assert(request.environment.POWERSHELL_TELEMETRY_OPTOUT === "1" && request.environment.GIT_TERMINAL_PROMPT === "0" && request.environment.GIT_CONFIG_VALUE_0 === "", "the quiet names");
	// Python prints UTF-8 when piped, so a skill's script that prints a character outside the code page doesn't stop.
	assert(request.environment.PYTHONUTF8 === "1", `PYTHONUTF8: ${request.environment.PYTHONUTF8}`);
	const plain = built(commandRequest(v4Rules(ROOM_C), call()), "no proxy");
	assert(plain.environment.HTTP_PROXY === undefined, "a command with no network gets proxy names");
	// curl's settings: named in CURL_HOME and only read, with or without a proxy; a share there builds nothing.
	for (const each of [request, plain]) {
		assert(each.environment.CURL_HOME === BOX_CURL, `CURL_HOME: ${each.environment.CURL_HOME}`);
		assert(has(each.filesystem.readonlyPaths, BOX_CURL) && !each.filesystem.readwritePaths.some((place) => atOrInside(BOX_CURL, place)), `curl's settings folder is not read-only: ${show(each.filesystem)}`);
	}
	refused(commandRequest(v4Rules(ROOM_C, { places: { ...v4Rules(ROOM_C).places, curlHome: String.raw`\\host\share\curl` } }), call()), "path-shape", "curl's settings on a share", String.raw`\\host\share\curl`);
	// The person's git name and e-mail: the file named in GIT_CONFIG_GLOBAL, its folder only read, with or without a proxy; without it neither; a share there builds nothing.
	const BOX_GIT = String.raw`C:\Users\Ana Lopez\.exxperts.box\git\config`;
	for (const proxyPort of [49152, undefined]) {
		const named = built(commandRequest(v4Rules(ROOM_C, { places: { ...v4Rules(ROOM_C).places, gitConfig: BOX_GIT } }), call({ proxyPort })), `git's file, proxy ${proxyPort}`);
		assert(named.environment.GIT_CONFIG_GLOBAL === BOX_GIT, `GIT_CONFIG_GLOBAL: ${named.environment.GIT_CONFIG_GLOBAL}`);
		assert(has(named.filesystem.readonlyPaths, path.win32.dirname(BOX_GIT)) && !named.filesystem.readwritePaths.some((place) => atOrInside(BOX_GIT, place)), `git's folder is not read-only: ${show(named.filesystem)}`);
		assert(named.environment.GIT_CONFIG_COUNT === "1" && named.environment.GIT_CONFIG_KEY_0 === "credential.helper" && named.environment.GIT_CONFIG_VALUE_0 === "", "credential.helper is no longer emptied beside it");
	}
	for (const each of [request, plain]) {
		assert(each.environment.GIT_CONFIG_GLOBAL === undefined && !JSON.stringify(each.filesystem).includes(".exxperts.box\\\\git"), `a turn without git's file: ${show({ env: each.environment.GIT_CONFIG_GLOBAL, filesystem: each.filesystem })}`);
	}
	refused(commandRequest(v4Rules(ROOM_C, { places: { ...v4Rules(ROOM_C).places, gitConfig: String.raw`\\host\share\git\config` } }), call()), "path-shape", "git's file on a share", String.raw`\\host\share\git\config`);

	// No request asks for telemetry, and the builder never names it.
	// PowerShell's own opt-out name is the one allowed mention: it keeps PowerShell from reporting its start.
	assert(!/telemetry/i.test(JSON.stringify([request, plain]).replaceAll("POWERSHELL_TELEMETRY_OPTOUT", "")), "a request names telemetry");
	for (const file of ["box-request.ts", "command-line.ts", "personal-folders.ts"]) {
		const source = fs.readFileSync(path.join(import.meta.dirname, "../src/room-box/windows", file), "utf8");
		assert(!/telemetry/i.test(source.replaceAll("POWERSHELL_TELEMETRY_OPTOUT", "")), `${file} names telemetry`);
	}

	// The model's text fits one variable, or no request is built.
	const limit = 32_767 - COMMAND_VARIABLE.length - 1;
	built(commandRequest(v4Rules(ROOM_C), call({ text: "x".repeat(limit) })), "the longest command");
	refused(commandRequest(v4Rules(ROOM_C), call({ text: "x".repeat(limit + 1) })), "too-long", "one character more");
	refused(commandRequest(v4Rules(ROOM_C, { environment: { ...SERVER_ENVIRONMENT, SYSTEMROOT: "" } }), call()), "no-system-root", "no Windows folder");

	// The wrapper decodes back to itself from the line.
	const words = request.command.split(" ");
	assert(words[words.length - 2] === "-EncodedCommand", `the line: ${request.command}`);
	assert(Buffer.from(words[words.length - 1], "base64").toString("utf16le") === WRAPPER, "the wrapper doesn't decode to itself");
	// The wrapper points PowerShell's own web commands at the proxy, inside try and before the model's text, from the variable only a request with a proxy sets.
	const PROXY_LINE = "try { if ($env:HTTPS_PROXY) { [Net.WebRequest]::DefaultWebProxy = New-Object Net.WebProxy($env:HTTPS_PROXY) } } catch { }";
	for (const proxyPort of [49152, undefined]) {
		const web = built(commandRequest(v4Rules(ROOM_C), { wrapper: COMMAND_WRAPPER, text: "Invoke-WebRequest -UseBasicParsing https://example.com", timeoutMs: 60000, proxyPort }), `the wrapper, proxy ${proxyPort}`);
		const lines = Buffer.from(web.command.split(" ").at(-1)!, "base64").toString("utf16le").split("\n");
		assert(lines.includes(PROXY_LINE) && lines.indexOf(PROXY_LINE) < lines.findIndex((line) => line.startsWith("Invoke-Expression")), `the wrapper's proxy line, proxy ${proxyPort}:\n${lines.join("\n")}`);
		assert(web.environment.HTTPS_PROXY === (proxyPort === undefined ? undefined : `http://127.0.0.1:${proxyPort}`), `HTTPS_PROXY with proxy ${proxyPort}: ${web.environment.HTTPS_PROXY}`);
		// The turn's temp travels in a name of its own, with a proxy or without: the box puts its own folder in TEMP and TMP.
		assert(web.environment[TEMP_VARIABLE] === `${ROOM_C}\\temp` && web.environment.TEMP === web.environment[TEMP_VARIABLE], `${TEMP_VARIABLE} with proxy ${proxyPort}: ${web.environment[TEMP_VARIABLE]}`);
	}
	// What the wrapper sets before the text runs, written out by hand: progress off first, then each line in try.
	const wrapperLines = COMMAND_WRAPPER.split("\n");
	const textAt = wrapperLines.findIndex((line) => line.startsWith("Invoke-Expression"));
	assert(wrapperLines[0] === "$ProgressPreference = 'SilentlyContinue'", `the wrapper's first line: ${wrapperLines[0]}`);
	for (const line of [
		"try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false; $OutputEncoding = [Console]::OutputEncoding } catch { }",
		"try { $PSDefaultParameterValues['*:Encoding'] = 'utf8' } catch { }",
		`try { if ($env:${TEMP_VARIABLE}) { $env:TEMP = $env:${TEMP_VARIABLE}; $env:TMP = $env:${TEMP_VARIABLE} } } catch { }`,
		PROXY_LINE,
	]) {
		const at = wrapperLines.indexOf(line);
		assert(at > 0 && at < textAt, `the wrapper lacks, or runs after the text: ${line}\n${COMMAND_WRAPPER}`);
	}
	// The text and the exit, written out by hand: what the text prints is printed before `exit` ends the script, or a table PowerShell sizes itself is lost.
	const textAndExit = [
		"Invoke-Expression ($exxpertsCommand + \"`n\" + '$exxpertsOk = $?') | Out-Default",
		"if ($exxpertsOk) { exit 0 }",
		"if ($LASTEXITCODE) { exit $LASTEXITCODE }",
		"exit 1",
		"",
	];
	assert(wrapperLines.slice(textAt).join("\n") === textAndExit.join("\n"), `the wrapper's text and exit:\n${wrapperLines.slice(textAt).join("\n")}`);
	// Output is asked for as text, whichever wrapper the line carries; PowerShell's own errors still come as CLIXML (windows-error-text-smoke.ts).
	assert(request.command.includes(" -OutputFormat Text -EncodedCommand "), `the line: ${request.command}`);
	const unicode = "Write-Output 'Grüße, 日本'";
	assert(Buffer.from(encodedCommand(unicode), "base64").toString("utf16le") === unicode, "a wrapper with other letters doesn't decode to itself");

	// The C runtime's quoting, the kit's cases, written out by hand.
	const LINES: [string[], string][] = [
		[[String.raw`C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe`, "-NoProfile", "-File", String.raw`C:\Users\A B\x y.ps1`], String.raw`C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe -NoProfile -File "C:\Users\A B\x y.ps1"`],
		[[String.raw`C:\Program Files\PowerShell\7\pwsh.exe`, "-Command", "Write-Output PWSH-ALIVE"], String.raw`"C:\Program Files\PowerShell\7\pwsh.exe" -Command "Write-Output PWSH-ALIVE"`],
		[["a.exe", "ends with slash\\", 'has "quotes"', 'slash quote\\"', ""], String.raw`a.exe "ends with slash\\" "has \"quotes\"" "slash quote\\\"" ""`],
		[["a.exe", "C:\\no\\space\\", "tab\there"], String.raw`a.exe C:\no\space\ "tab	here"`],
	];
	for (const [argv, line] of LINES) assert(joinCommandLine(argv) === line, `quoting: ${show(argv)} gave ${joinCommandLine(argv)}`);
	console.log("ok: the environment keeps no secret and no MXC_ name, the wrapper decodes and names the proxy only from a request's own, the C runtime's quoting holds");
}

// ---- 9. Its callers ----------------------------------------------------------------------
// The request is built only inside room-box/windows/, and the app reaches the box through these imports alone.
{
	const src = path.join(import.meta.dirname, "../src");
	const windows = path.join(src, "room-box", "windows");
	const callers: string[] = [];
	const valueImports: string[] = [];
	const VALUE_IMPORT = /^import\s+(?!type\b)[^;]*?from\s+["']([^"']*\/windows\/[^"']+)["']/gm;
	const walk = (folder: string) => {
		for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
			const place = path.join(folder, entry.name);
			if (entry.isDirectory()) {
				if (place !== windows) walk(place);
			} else if (/\.(ts|tsx|mjs|cjs|js)$/.test(entry.name)) {
				const source = fs.readFileSync(place, "utf8");
				if (/(room-box\/|\.\/)windows\/(box-request|personal-folders|command-line)|["']\.\.?\/(box-request|personal-folders|command-line)/.test(source)) callers.push(place);
				for (const [, specifier] of source.matchAll(VALUE_IMPORT)) valueImports.push(`${path.relative(src, place)}: ${specifier}`);
			}
		}
	};
	walk(src);
	walk(path.join(import.meta.dirname, "../../web-ui/src"));
	// A room's protection, and the judge of a folder a room suggests, read a folder's shape by `localPath` alone, importing nothing else of the request.
	const protection = path.join(src, "persistent-room-protection.ts");
	assert(callers.includes(protection) && /import \{ localPath \} from "\.\/room-box\/windows\/box-request\.js";/.test(fs.readFileSync(protection, "utf8")), "the protection module no longer judges a folder by localPath alone");
	const suggestion = path.join(src, "room-box", "folder-suggestion.ts");
	assert(callers.includes(suggestion) && /import \{ localPath \} from "\.\/windows\/box-request\.js";/.test(fs.readFileSync(suggestion, "utf8")), "the folder suggestion's judge no longer reads a folder's shape by localPath alone");
	const others = callers.filter((caller) => caller !== protection && caller !== suggestion);
	assert(others.length === 0, `the Windows request has a caller: ${others.join(", ")}`);
	const EXPECTED = [
		"index.ts: ./room-box/windows/start-check.js",
		"local-folder-picker.ts: ./room-box/windows/windows-places.js",
		"persistent-room-background-execution.ts: ./room-box/windows/folder-wait.js",
		"persistent-room-background-execution.ts: ./room-box/windows/windows-engine.js",
		"persistent-room-protection.ts: ./room-box/windows/box-request.js",
		"persistent-room-skill-tool.ts: ./room-box/windows/model-lines.js",
		"room-box/folder-offer.ts: ./windows/windows-places.js",
		"room-box/folder-suggestion.ts: ./windows/box-request.js",
		"room-box/folder-suggestion.ts: ./windows/windows-places.js",
		"room-box/outside-tool.ts: ./windows/model-lines.js",
		"room-command-tool.ts: ./room-box/windows/model-lines.js",
		"room-socket.ts: ./room-box/windows/folder-wait.js",
		"room-socket.ts: ./room-box/windows/model-lines.js",
		"room-socket.ts: ./room-box/windows/site-decision.js",
		"room-socket.ts: ./room-box/windows/windows-engine.js",
	];
	assert(isDeepStrictEqual([...valueImports].sort(), EXPECTED), `the Windows box's callers changed: ${show([...valueImports].sort())}`);

	// roomBoxAvailable() follows the check on Windows: not known while it runs, on for on and broken, off for off; a Mac has its box.
	const { roomBoxAvailable, roomBoxComputer, setRoomBoxForTests } = await import("../src/room-box/box-available.js");
	for (const [windowsState, available, computer] of [[null, false, "unknown"], ["on", true, "windows"], ["broken", true, "windows"], ["off", false, null]] as const) {
		setRoomBoxForTests({ platform: "win32", windows: windowsState });
		assert(roomBoxAvailable() === available && roomBoxComputer() === computer, `Windows ${windowsState}: ${roomBoxAvailable()} ${roomBoxComputer()}`);
	}
	setRoomBoxForTests({ platform: "darwin", windows: null });
	assert(roomBoxAvailable() === true && roomBoxComputer() === "mac", "roomBoxAvailable() is false on a Mac, so the rows above prove nothing");
	setRoomBoxForTests(null);
	console.log("ok: the request is built inside room-box/windows/ alone, the app's imports of the box are the ones named, and roomBoxAvailable() follows the check on Windows");
}

console.log("windows-box-request-smoke: ok");
