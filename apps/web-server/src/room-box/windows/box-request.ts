import path from "node:path";

import { joinCommandLine, powerShellLine } from "./command-line.js";

const win = path.win32;

/** The request contract 1.0.0 shape the box takes, as far as this builder fills it. */
export interface WindowsBoxRequest {
	command: string;
	workingDirectory: string;
	filesystem: { readwritePaths: string[]; readonlyPaths: string[]; deniedPaths: string[] };
	containment: { type: "processcontainer"; config: { filesystem: { enumeratePaths: string[] } } };
	network: BoxNetwork;
	ui: { disable: false; clipboard: "none"; allowInputInjection: false };
	environment: Record<string, string>;
	inheritDefaultEnvironment: false;
	timeoutMs: number;
}

export type BoxNetwork =
	| { egress: { default: "deny" }; ingress: { default: "deny"; hostLoopback: "deny" } }
	| { egress: { default: "deny" }; ingress: { default: "allow"; hostLoopback: "allow" }; runtimeConfig: { networkProxy: string } };

/** What one room's commands and file calls may reach right now. Every path is a real local path, as Windows or the box gave it. */
export interface WindowsRoomRules {
	room: { folder: string; canChangeFiles: boolean };
	alsoAllowed: readonly { path: string; access: "read" | "write" }[];
	/** The folders of the skills on in the room that `windowsSkillFolder` passed: read and run, never written. */
	skillFolders: readonly string[];
	/** The turn's own temp and the room's caches, both written, and curl's settings folder, read, when the turn has it. */
	places: {
		temp: string;
		caches: string;
		curlHome?: string;
		/** The file with the person's git name and e-mail, its folder read, when the turn has it. */
		gitConfig?: string;
	};
	/** The person's profile folder. Nothing at or above it is granted from the system's lists. */
	profile: string;
	/** The person's own folders, asked of Windows. Each is shut unless it is at or above a granted path. */
	personal: readonly string[];
	/** Places shut whatever the room: the app's own places, credential places and any other. Empty unless the caller names some. */
	denied: readonly string[];
	/** Names inside each writable root, such as `.git\config`, made read-only or shut. Empty unless the caller names some. */
	closedNames: { readOnly: readonly string[]; denied: readonly string[] };
	/** The server's environment. Only the names Windows programs expect are read from it, and Windows' own folders. */
	environment: Readonly<Record<string, string | undefined>>;
	/** The folders the person's commands use to run tools: each is read, never written. */
	tools: readonly string[];
	/** The folders on the person's PATH. */
	pathFolders: readonly string[];
	/** `AppData\Local\Programs` and the names of its subfolders, as the box listed them. */
	programs: { folder: string; names: readonly string[] };
}

export interface CommandCall {
	/** Our fixed PowerShell wrapper, the only text on the command line. */
	wrapper: string;
	/** The model's command, handed over in the environment. */
	text: string;
	timeoutMs: number;
	/** This turn's proxy on 127.0.0.1. Without one the command has no network. */
	proxyPort?: number;
}

export interface FileCall {
	/** The program and its arguments. */
	argv: readonly string[];
	/** The program's own files: read, never written. */
	program: readonly string[];
	writes: boolean;
	timeoutMs: number;
}

/**
 * Why no request was built:
 * - `path-shape`: a path that is not a full local path (a network, device or drive-relative path), never put in a request;
 * - `denied-over-grant`: a place that must stay shut is at or above a granted one, where a deny breaks every delete and rename in the room;
 * - `too-long`: the model's command is longer than Windows lets one environment variable be;
 * - `no-system-root`: the environment names no Windows folder to start PowerShell from.
 */
export type RequestRefusal = { code: "path-shape" | "denied-over-grant"; path: string } | { code: "too-long" | "no-system-root" };

export type RequestResult = { ok: true; request: WindowsBoxRequest } | { ok: false; refused: RequestRefusal };

/** Where the model's command travels. Its own variable, so no quoting layer touches it. */
export const COMMAND_VARIABLE = "EXXPERTS_COMMAND";

/** Where the turn's temp travels to the wrapper, which sets TEMP and TMP from it: the box puts its own folder in those two. */
export const TEMP_VARIABLE = "EXXPERTS_TEMP";

// Windows caps one environment variable at 32,767 characters. Counted with its
// name, so the command fits whichever way a reader measures it.
const VARIABLE_LIMIT = 32_767;

const UI = { disable: false, clipboard: "none", allowInputInjection: false } as const;
const NO_NETWORK = { egress: { default: "deny" }, ingress: { default: "deny", hostLoopback: "deny" } } as const;

/** A full local path, `C:\...`: never a network path (`\\host\share`, `\\?\UNC\...`), a device path (`\\.\...`) or a drive-relative one (`C:x`, `\x`). */
export function localPath(value: string): string | undefined {
	if (!/^[A-Za-z]:[\\/]/.test(value) || value.includes("\0")) return undefined;
	const normal = win.normalize(value);
	return normal.length > 3 ? normal.replace(/\\+$/, "") : normal;
}

/** Whether a relative path leaves its folder. A name such as `..reports` stays inside. */
const climbs = (relative: string) => relative === ".." || relative.startsWith("..\\");

/** Whether `inner` is `outer` or inside it. Windows names ignore case. */
export function atOrInside(inner: string, outer: string): boolean {
	const relative = win.relative(outer.toLowerCase(), inner.toLowerCase());
	return relative === "" || (!climbs(relative) && !win.isAbsolute(relative));
}

const isDriveRoot = (place: string) => win.parse(place).root === place;

/** Each path once, in order, whatever its case. */
function unique(paths: readonly string[]): string[] {
	const seen = new Set<string>();
	return paths.filter((place) => {
		const key = place.toLowerCase();
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	});
}

/** Drops each path inside another one of the same list: it adds nothing. */
function outermost(paths: readonly string[]): string[] {
	const once = unique(paths);
	return once.filter((place, index) => !once.some((other, otherIndex) => otherIndex !== index && atOrInside(place, other) && !atOrInside(other, place)));
}

/** Every folder above a granted path that no grant already covers. */
function enumerable(grants: readonly string[]): string[] {
	const above: string[] = [];
	for (const grant of grants) {
		for (let folder = win.dirname(grant); ; folder = win.dirname(folder)) {
			if (!grants.some((other) => atOrInside(folder, other))) above.push(folder);
			if (isDriveRoot(folder)) break;
		}
	}
	return unique(above);
}

// What Windows programs expect to find. Nothing else of the server's
// environment reaches a command: it holds the app's token and any key.
const KEPT_NAMES = [
	"ALLUSERSPROFILE", "CommonProgramFiles", "CommonProgramFiles(Arm)", "CommonProgramFiles(x86)", "CommonProgramW6432",
	"COMPUTERNAME", "ComSpec", "HOMEDRIVE", "HOMEPATH", "NUMBER_OF_PROCESSORS", "OS", "PATHEXT",
	"PROCESSOR_ARCHITECTURE", "PROCESSOR_IDENTIFIER", "PROCESSOR_LEVEL", "PROCESSOR_REVISION",
	"ProgramData", "ProgramFiles", "ProgramFiles(Arm)", "ProgramFiles(x86)", "ProgramW6432", "PUBLIC", "SystemDrive",
	"SystemRoot", "USERDOMAIN", "USERNAME", "USERPROFILE", "windir",
] as const;

/** A name's value, whatever its case: Windows names ignore case. */
export function variable(environment: WindowsRoomRules["environment"], name: string): string | undefined {
	const lower = name.toLowerCase();
	const found = Object.keys(environment).find((key) => key.toLowerCase() === lower);
	return found === undefined ? undefined : environment[found];
}

function keptEnvironment(environment: WindowsRoomRules["environment"]): Record<string, string> {
	return Object.fromEntries(KEPT_NAMES.flatMap((name) => {
		const value = variable(environment, name);
		return value === undefined ? [] : [[name, value]];
	}));
}

/** Windows' own folders: read by every command, since Windows programs load from them. */
function windowsFolders(environment: WindowsRoomRules["environment"]): string[] {
	return ["SystemRoot", "ProgramFiles", "ProgramFiles(x86)", "ProgramData"].flatMap((name) => {
		const value = variable(environment, name);
		const place = value === undefined ? undefined : localPath(value);
		return place === undefined || isDriveRoot(place) ? [] : [place];
	});
}

type Rule = { readwrite: string[]; readonly: string[]; denied: string[]; path: string[] };

class Refused extends Error {
	constructor(readonly refusal: RequestRefusal) {
		super(refusal.code);
	}
}

function local(value: string): string {
	const place = localPath(value);
	if (place === undefined) throw new Refused({ code: "path-shape", path: value });
	return place;
}

function writableRoots(rules: WindowsRoomRules): string[] {
	// As on a Mac: a room that can't change files changes no folder on its list either.
	return (rules.room.canChangeFiles ? [rules.room.folder, ...rules.alsoAllowed.filter((entry) => entry.access === "write").map((entry) => entry.path)] : []).map(local);
}

function closedName(root: string, name: string): string {
	const inner = win.normalize(name);
	if (win.isAbsolute(inner) || climbs(inner) || /^[A-Za-z]:/.test(inner)) throw new Refused({ code: "path-shape", path: name });
	return win.join(root, inner);
}

/**
 * The file rule, from given folders: what is written, what is read, what is shut.
 * The person's own folders are shut unless one is at or above a granted path;
 * a deny there breaks every delete, rename and script in the room. The places
 * that must stay shut refuse the request instead when a grant sits at or inside one.
 * The system's lists (Windows' folders, the tools, PATH) grant no whole drive,
 * nor the profile or anything above it, and no read grant inside a written
 * place, though such a PATH folder stays on PATH. PATH and the programs
 * installed just for the person also drop what a shut folder holds, and PATH
 * what sits above one.
 */
function fileRule(rules: WindowsRoomRules, extra: { readwrite: readonly string[]; readonly: readonly string[] }): Rule {
	const writable = writableRoots(rules);
	const roomReadOnly = rules.room.canChangeFiles ? [] : [local(rules.room.folder)];
	const readAlso = rules.alsoAllowed.filter((entry) => entry.access === "read" || !rules.room.canChangeFiles).map((entry) => local(entry.path));
	const profile = local(rules.profile);
	const fromSystem = (place: string) => !isDriveRoot(place) && !atOrInside(profile, place);
	const shut = [...rules.denied.map(local), ...writable.flatMap((root) => rules.closedNames.denied.map((name) => closedName(root, name)))];
	const programsFolder = local(rules.programs.folder);
	const programs = rules.programs.names.filter((name) => name !== "." && name !== ".." && !/[\\/:\0]/.test(name)).map((name) => win.join(programsFolder, name));
	const readwrite = [...extra.readwrite.map(local)];
	// Inside a written place, a read grant from the system's lists would only narrow it.
	const notWritten = (place: string) => !readwrite.some((root) => atOrInside(place, root));
	const readonly = [
		// A skill's folder in a written place keeps that place's writes; one holding it stays read-only around it.
		...roomReadOnly, ...readAlso, ...rules.skillFolders.map(local).filter(notWritten), ...extra.readonly.map(local),
		...[...windowsFolders(rules.environment), ...rules.tools.map(local)].filter((place) => fromSystem(place) && notWritten(place)),
		...programs.filter((place) => notWritten(place) && !shut.some((closed) => atOrInside(place, closed))),
		...writable.flatMap((root) => rules.closedNames.readOnly.map((name) => closedName(root, name))),
	];
	const granted = [...readwrite, ...readonly];
	const over = shut.find((closed) => granted.some((grant) => atOrInside(grant, closed)));
	if (over !== undefined) throw new Refused({ code: "denied-over-grant", path: over });
	const personal = rules.personal.map(local).filter((folder) => !granted.some((grant) => atOrInside(grant, folder)));
	const denied = unique([...personal, ...shut]);
	const pathFolders = unique(rules.pathFolders.flatMap((value) => {
		const place = localPath(value);
		return place === undefined || !fromSystem(place) || denied.some((closed) => atOrInside(place, closed) || atOrInside(closed, place)) ? [] : [place];
	}));
	return { readwrite: outermost(readwrite), readonly: outermost([...readonly, ...pathFolders.filter(notWritten)]), denied, path: pathFolders };
}

function built(rule: Rule, fields: Omit<WindowsBoxRequest, "filesystem" | "containment" | "ui" | "inheritDefaultEnvironment">): WindowsBoxRequest {
	return {
		...fields,
		filesystem: { readwritePaths: rule.readwrite, readonlyPaths: rule.readonly, deniedPaths: rule.denied },
		containment: { type: "processcontainer", config: { filesystem: { enumeratePaths: enumerable([...rule.readwrite, ...rule.readonly]) } } },
		ui: { ...UI },
		inheritDefaultEnvironment: false,
	};
}

function attempt(build: () => WindowsBoxRequest): RequestResult {
	try {
		return { ok: true, request: build() };
	} catch (error) {
		if (error instanceof Refused) return { ok: false, refused: error.refusal };
		throw error;
	}
}

/**
 * One command's request. The room's folder is written when the room can change
 * files, the turn's temp and caches always, curl's settings only read; the model's text travels in
 * `EXXPERTS_COMMAND`, read by the wrapper, never on the command line.
 */
export function commandRequest(rules: WindowsRoomRules, call: CommandCall): RequestResult {
	return attempt(() => {
		const systemRoot = variable(rules.environment, "SystemRoot");
		const root = systemRoot === undefined ? undefined : localPath(systemRoot);
		if (root === undefined) throw new Refused({ code: "no-system-root" });
		if (COMMAND_VARIABLE.length + 1 + call.text.length > VARIABLE_LIMIT) throw new Refused({ code: "too-long" });
		const temp = local(rules.places.temp);
		const caches = local(rules.places.caches);
		const curlHome = rules.places.curlHome === undefined ? undefined : local(rules.places.curlHome);
		const gitConfig = rules.places.gitConfig === undefined ? undefined : local(rules.places.gitConfig);
		const rule = fileRule(rules, { readwrite: [...writableRoots(rules), temp, caches], readonly: [...(curlHome === undefined ? [] : [curlHome]), ...(gitConfig === undefined ? [] : [win.dirname(gitConfig)])] });
		const proxy = call.proxyPort === undefined ? undefined : `http://127.0.0.1:${call.proxyPort}`;
		const programFilesValue = variable(rules.environment, "ProgramFiles");
		const programFiles = programFilesValue === undefined ? undefined : localPath(programFilesValue);
		const cache = (name: string) => win.join(caches, name);
		const environment: Record<string, string> = {
			...keptEnvironment(rules.environment),
			TEMP: temp,
			TMP: temp,
			[TEMP_VARIABLE]: temp,
			// A program's own settings and caches land where it may write.
			APPDATA: win.join(caches, "AppData", "Roaming"),
			LOCALAPPDATA: win.join(caches, "AppData", "Local"),
			PATH: rule.path.join(";"),
			// Windows' own module folders only, so PowerShell never loads a module from Documents.
			PSModulePath: [win.join(root, "System32", "WindowsPowerShell", "v1.0", "Modules"), ...(programFiles === undefined ? [] : [win.join(programFiles, "WindowsPowerShell", "Modules")])].join(";"),
			...(proxy === undefined ? {} : { HTTP_PROXY: proxy, HTTPS_PROXY: proxy, http_proxy: proxy, https_proxy: proxy, NO_PROXY: "", no_proxy: "", NODE_USE_ENV_PROXY: "1" }),
			// The same cache names as a Mac command's (boxEnvironment in ../box-rules.ts).
			XDG_CACHE_HOME: cache("xdg"),
			npm_config_cache: cache("npm"),
			npm_config_store_dir: cache("pnpm"),
			YARN_CACHE_FOLDER: cache("yarn"),
			PIP_CACHE_DIR: cache("pip"),
			UV_CACHE_DIR: cache("uv"),
			GOCACHE: cache("go-build"),
			GOMODCACHE: cache("go-mod"),
			CARGO_HOME: cache("cargo"),
			// Its _curlrc tells Windows' curl to go on when the room refuses its certificate check.
			...(curlHome === undefined ? {} : { CURL_HOME: curlHome }),
			// The person's git name and e-mail alone, in place of their settings, which a command can't read.
			...(gitConfig === undefined ? {} : { GIT_CONFIG_GLOBAL: gitConfig }),
			GIT_TERMINAL_PROMPT: "0",
			GIT_CONFIG_COUNT: "1",
			GIT_CONFIG_KEY_0: "credential.helper",
			GIT_CONFIG_VALUE_0: "",
			POWERSHELL_TELEMETRY_OPTOUT: "1",
			POWERSHELL_UPDATECHECK: "Off",
			NO_COLOR: "1",
			// Python prints in the computer's own code page when its output is piped, and stops at a character outside it.
			PYTHONUTF8: "1",
			[COMMAND_VARIABLE]: call.text,
		};
		return built(rule, {
			command: powerShellLine(root, call.wrapper),
			workingDirectory: local(rules.room.folder),
			network: proxy === undefined ? structuredClone(NO_NETWORK) : { egress: { default: "deny" }, ingress: { default: "allow", hostLoopback: "allow" }, runtimeConfig: { networkProxy: proxy } },
			environment,
			timeoutMs: call.timeoutMs,
		});
	});
}

/**
 * One file call's request, from the same rules as the room's commands: the
 * room's places are read, and written only when the call writes; the program's
 * own files are read. No temp, caches, tools, PATH or programs, and no network,
 * so it reaches nothing the room's commands can't, apart from its program.
 */
export function fileRequest(rules: WindowsRoomRules, call: FileCall): RequestResult {
	return attempt(() => {
		const writable = writableRoots(rules);
		const forCall: WindowsRoomRules = { ...rules, tools: [], pathFolders: [], programs: { folder: rules.programs.folder, names: [] } };
		const rule = fileRule(forCall, call.writes ? { readwrite: writable, readonly: call.program } : { readwrite: [], readonly: [...writable, ...call.program] });
		return built(rule, {
			command: joinCommandLine(call.argv),
			workingDirectory: local(rules.room.folder),
			network: structuredClone(NO_NETWORK),
			environment: keptEnvironment(rules.environment),
			timeoutMs: call.timeoutMs,
		});
	});
}
