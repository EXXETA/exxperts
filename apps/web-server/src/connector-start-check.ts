/**
 * A local connector program starts outside the room box, so one that a room
 * could have changed would run that room's changes unboxed. Before each start
 * (the warm-up, the Connectors page's Test, a room's first use and every later
 * reconnect) the adapter asks this check, by real path, whether its program,
 * its package or its working folder sits where any room can change files:
 * - a room's folder, when the room can change files;
 * - each Also allowed folder with change access, in such a room;
 * - the box's own private places (its temp and caches), in every room.
 * The adapter calls the check right before it starts the program
 * (scripts/patch-mcp-adapter.mjs, patch 13); installConnectorStartCheck puts it
 * where the adapter finds it.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
	DEFAULT_PERSISTENT_ROOM_AGENTS_ROOT,
	readPersistentRoomDefaultCapabilityPolicy,
	type PersistentRoomCapabilityPolicy,
} from "./persistent-room-workspace-policy.js";
import { roomFence, under } from "./room-files.js";
import { realPathOf } from "./room-box/box-closed.js";
import { judgedAgainst } from "./room-box/folder-offer.js";
import { connectorSearchPath } from "./connector-search-path.js";
import { shownRoomName } from "./room-name.js";

/** What a connector start runs, as the adapter is about to start it. */
export interface ConnectorStart {
	/** The program, after the adapter's npx lookup (then `node`, with the package's file first in args). */
	command: string;
	/** As configured; a hand-edited entry may hold an argument that is no text. */
	args: readonly unknown[];
	/** The working folder; none means the server's own. */
	cwd?: string;
	/** The command as configured, before the npx lookup. */
	configuredCommand?: string;
	/** The variables the connector's entry sets, read over the ones it takes from the server's own. */
	environment?: Record<string, string>;
}

// The names this check reads that a connector takes from the server's own environment, as
// CONNECTOR_ENVIRONMENT in scripts/patch-mcp-adapter.mjs passes them: change the two together.
// uv's own names aren't passed, so only an entry's own setting moves uv's folders.
const INHERITED = new Set(["PATH", "HOME", "USERPROFILE", "LOCALAPPDATA", "APPDATA", "npm_config_cache", "NPM_CONFIG_CACHE"]);

/** A variable as the connector program gets it. */
type Variable = (name: string) => string | undefined;

/** The server's own value of an inherited name; PATH as the start widens it (connector-search-path.ts). */
const inherited = (name: string): string | undefined => (name === "PATH" ? (connectorSearchPath() ?? process.env.PATH) : INHERITED.has(name) ? process.env[name] : undefined);

const variablesOf =
	(start: ConnectorStart): Variable =>
	(name) =>
		start.environment?.[name] || inherited(name) || undefined;

/** The home the connector's npm and uv read, by its own HOME (USERPROFILE on Windows). */
const homeOf = (variable: Variable): string => variable(process.platform === "win32" ? "USERPROFILE" : "HOME") || os.homedir();

/** The room that can change files where the connector runs from. */
export interface ConnectorStartRefusal {
	roomId: string;
	roomName: string;
}

/** A place a room can change files in, by real path. */
interface WritePlace {
	path: string;
	room: ConnectorStartRefusal;
}

export const CONNECTOR_START_REFUSED = "connector_start_refused";

/** Thrown into the adapter's connect, so every caller sees a failed start with this code. */
export class ConnectorStartRefused extends Error {
	readonly code = CONNECTOR_START_REFUSED;
	constructor(
		readonly connector: string,
		readonly refusal: ConnectorStartRefusal,
	) {
		super(`Connector "${connector}" did not start: the room "${refusal.roomName}" can change files where it runs from.`);
		this.name = "ConnectorStartRefused";
	}
}

const ROOM_ID = /^[a-zA-Z0-9_-]{1,160}$/;

/** The policy the room's folder access comes from: the room's own. One that can't be read gives the room no folder, as it gives its box and its file tools none. */
function roomPolicy(roomId: string): PersistentRoomCapabilityPolicy | null {
	try {
		return readPersistentRoomDefaultCapabilityPolicy(roomId);
	} catch {
		return null;
	}
}

async function roomOf(roomsRoot: string, roomId: string): Promise<ConnectorStartRefusal | null> {
	try {
		const agent = JSON.parse(await fs.promises.readFile(path.join(roomsRoot, roomId, "agent.json"), "utf-8"));
		if (Number(agent?.archivedAt ?? 0) > 0) return null;
		return { roomId, roomName: shownRoomName(typeof agent?.displayName === "string" ? agent.displayName : "") || roomId };
	} catch {
		// A room whose file can't be read still has its folders.
		return { roomId, roomName: roomId };
	}
}

/**
 * The places every room can change files in now, read from the rooms' own
 * files at each call. What every room's folder is judged against is read once
 * for the call and dropped at its end. A rooms folder that can't be read is no proof that no
 * room can change anything, so that read fails the start.
 */
export async function roomWritePlaces(): Promise<WritePlace[]> {
	const roomsRoot = DEFAULT_PERSISTENT_ROOM_AGENTS_ROOT;
	let entries: fs.Dirent[];
	try {
		entries = await fs.promises.readdir(roomsRoot, { withFileTypes: true });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	}
	const places: WritePlace[] = [];
	const against = judgedAgainst();
	for (const entry of entries) {
		if (!entry.isDirectory() || !ROOM_ID.test(entry.name)) continue;
		const room = await roomOf(roomsRoot, entry.name);
		if (!room) continue;
		const roomRoot = path.join(roomsRoot, entry.name);
		places.push({ path: realPathOf(path.join(roomRoot, "runtime", "box")), room });
		const policy = roomPolicy(entry.name);
		const fence = policy ? roomFence(policy, () => [], undefined, false, undefined, against) : null;
		if (fence?.room?.access === "write") for (const root of fence.roots()) if (root.access === "write") places.push({ path: realPathOf(root.path), room });
		// One room's files at a time, so a long list of rooms never holds up other requests.
		await new Promise((resolve) => setImmediate(resolve));
	}
	return places;
}

const executableSuffixes = (platform: NodeJS.Platform) => (platform === "win32" ? ["", ...(process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean)] : [""]);

/** The files a command can name, in the order they are looked up: by its path when it has one, else along PATH (on Windows the working folder comes first). */
function programCandidates(command: string, cwd: string, searchPath: string, platform: NodeJS.Platform): string[] {
	const folders = searchPath.split(path.delimiter).filter(Boolean);
	const places = /[\\/]/.test(command) ? [path.resolve(cwd, command)] : [...(platform === "win32" ? [cwd] : []), ...folders].map((folder) => path.resolve(cwd, folder, command));
	const suffixes = executableSuffixes(platform);
	return places.flatMap((place) => suffixes.map((suffix) => place + suffix));
}

/** A file the system would start: on Windows any file, elsewhere one that may be run. */
function runnable(target: string, platform: NodeJS.Platform): boolean {
	try {
		if (!fs.statSync(target).isFile()) return false;
		if (platform !== "win32") fs.accessSync(target, fs.constants.X_OK);
		return true;
	} catch {
		return false;
	}
}

/** The file a command names, looked up as the start looks it up: the first candidate that can run. */
export function programFile(command: string, cwd: string, searchPath: string, platform: NodeJS.Platform = process.platform): string | null {
	return programCandidates(command, cwd, searchPath, platform).find((candidate) => runnable(candidate, platform)) ?? null;
}

/**
 * Whether Windows has no file for a command anywhere it looks, as a failed
 * check asks. A file that can't be read counts as there, since Windows may
 * still start it (the Microsoft Store's python.exe is one).
 */
export function programMissingOnWindows(command: string, cwd: string, searchPath: string): boolean {
	return programCandidates(command, cwd, searchPath, "win32").every((candidate) => {
		try {
			return !fs.statSync(candidate).isFile();
		} catch (error) {
			return ["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "");
		}
	});
}

const commandName = (command: string) => path.basename(command).toLowerCase().replace(/\.(cmd|exe|bat)$/, "");

/**
 * Programs that run code they are handed: a script, a package folder, or the
 * folder of a project they run. Which flags take a value differs from one to
 * the next, so their arguments are read the safe way round: every file or
 * folder counts, a flag's value included (`--require <file>`,
 * `uv --directory <folder>`), up to and including the first one that follows
 * no bare flag, which is the script. The arguments after it are the program's
 * own, often data such as a folder or a database, which a room may change
 * freely. Any other program is itself what runs, and all its arguments are
 * its data.
 */
const LAUNCHER = /^(node|nodejs|bun|deno|tsx|ts-node|python[0-9.]*|pythonw|py|uv|ruby|perl|php|java|bash|sh|zsh|dash|npm|pnpm|yarn)$/;

function launchedFiles(command: string, args: readonly unknown[], cwd: string): string[] {
	if (!LAUNCHER.test(commandName(command))) return [];
	const files: string[] = [];
	let afterBareFlag = false;
	for (const raw of args) {
		const arg = String(raw);
		const flag = arg.startsWith("-");
		const value = flag ? (arg.includes("=") ? arg.slice(arg.indexOf("=") + 1) : "") : arg;
		const target = value ? path.resolve(cwd, value) : "";
		if (target && fs.existsSync(target)) {
			files.push(target);
			if (!flag && !afterBareFlag) break;
		}
		afterBareFlag = flag && !arg.includes("=");
	}
	return files;
}

/** npm's own cache, where npx keeps the packages it runs. A relative setting counts from the connector's working folder, as npm reads it. */
function npmCacheFolder(variable: Variable, cwd: string): string {
	const configured = variable("npm_config_cache") || variable("NPM_CONFIG_CACHE");
	if (configured) return path.resolve(cwd, configured);
	const home = homeOf(variable);
	return process.platform === "win32" ? path.join(variable("LOCALAPPDATA") || path.join(home, "AppData", "Local"), "npm-cache") : path.join(home, ".npm");
}

/** The parts of npm's cache npx runs packages from: the installed packages, and the store it installs them from. */
const NPX_PACKAGE_FOLDERS = ["_npx", "_cacache"];

const runsThroughNpx = (command: string | undefined) => command !== undefined && ["npx", "npm"].includes(commandName(command));

/** The programs npx's lookup and first-run install start by name, along the connector's PATH: each is judged by its real file, as the program itself is. */
const NPX_LOOKUP_PROGRAMS = ["npm", "node"];

/**
 * Where uv keeps what uvx runs, by uv's own defaults: the cache it builds a
 * tool's environment in, and the folder of tools installed with `uv tool
 * install`, which uvx runs instead when one is there.
 */
function uvPackageFolders(variable: Variable, cwd: string): string[] {
	const home = homeOf(variable);
	const windows = process.platform === "win32";
	const cache = variable("UV_CACHE_DIR") || (windows ? path.join(variable("LOCALAPPDATA") || path.join(home, "AppData", "Local"), "uv", "cache") : path.join(variable("XDG_CACHE_HOME") || path.join(home, ".cache"), "uv"));
	const tools = variable("UV_TOOL_DIR") || (windows ? path.join(variable("APPDATA") || path.join(home, "AppData", "Roaming"), "uv", "data", "tools") : path.join(variable("XDG_DATA_HOME") || path.join(home, ".local", "share"), "uv", "tools"));
	// A relative setting counts from the connector's working folder, as uv reads it.
	return [cache, tools].map((folder) => path.resolve(cwd, folder));
}

const runsThroughUv = (command: string | undefined) => command !== undefined && ["uvx", "uv"].includes(commandName(command));

/**
 * The room that can change files where this start runs from, or null. The
 * program, what a launcher is handed to run and the working folder count when
 * they sit inside a room's place. For npx and uv, the folders they run packages
 * from count either way round: each runs a package together with everything
 * installed beside it. For npx, the programs its lookup starts by name count
 * by their real files (links followed), and every folder on the PATH counts
 * too: npm runs a package's install scripts through the shell, which finds
 * whatever they name there.
 */
export function connectorStartRefusal(start: ConnectorStart, places: readonly WritePlace[]): ConnectorStartRefusal | null {
	if (places.length === 0) return null;
	const cwd = realPathOf(start.cwd ?? process.cwd());
	const variable = variablesOf(start);
	// Asked once: working it out looks at folders, and an automounted one answers slowly.
	const searchPath = variable("PATH") ?? "";
	const program = programFile(start.command, cwd, searchPath);
	const configured = start.configuredCommand ?? start.command;
	const npx = runsThroughNpx(configured);
	const lookupPrograms = npx ? NPX_LOOKUP_PROGRAMS.flatMap((name) => programFile(name, cwd, searchPath) ?? []) : [];
	const pathFolders = npx ? searchPath.split(path.delimiter).filter(Boolean).map((folder) => path.resolve(cwd, folder)) : [];
	const inside = [cwd, ...(program ? [program] : []), ...launchedFiles(start.command, start.args, cwd), ...lookupPrograms, ...pathFolders].map(realPathOf);
	const packageFolders = [
		...(runsThroughNpx(configured) ? NPX_PACKAGE_FOLDERS.map((name) => path.join(npmCacheFolder(variable, cwd), name)) : []),
		...(runsThroughUv(configured) ? uvPackageFolders(variable, cwd) : []),
	].map(realPathOf);
	const place = places.find((candidate) => inside.some((target) => under(target, candidate.path)) || packageFolders.some((folder) => under(folder, candidate.path) || under(candidate.path, folder)));
	return place ? place.room : null;
}

/** What the Connectors page's status needs to say a start would be refused; the status route hands it to getMcpConnectorsStatus. */
export const startRefusalLookup = { roomWritePlaces, connectorStartRefusal };
export type StartRefusalLookup = typeof startRefusalLookup;

/** The check the adapter calls right before a connector program starts: throws when a room can change files where it runs from. */
async function checkConnectorStart(start: ConnectorStart & { name: string }): Promise<void> {
	const refusal = connectorStartRefusal(start, await roomWritePlaces());
	if (refusal) throw new ConnectorStartRefused(start.name, refusal);
}

declare global {
	/** Where the adapter's patched connect finds the start check (scripts/patch-mcp-adapter.mjs, patch 13 reads it by this name). */
	var exxpertsConnectorStartCheck: typeof checkConnectorStart | undefined;
	/** Where the adapter's patched start and npx lookup find a connector's PATH (scripts/patch-mcp-adapter.mjs, patch 14 reads it by this name). */
	var exxpertsConnectorSearchPath: typeof connectorSearchPath | undefined;
}

/** Puts the check, and the PATH it judges by, where the adapter's patched connect finds them, for every connector manager in this process. */
export function installConnectorStartCheck(): void {
	globalThis.exxpertsConnectorStartCheck = checkConnectorStart;
	globalThis.exxpertsConnectorSearchPath = connectorSearchPath;
}

/** The start refusal an adapter error carries, or null for any other failure. */
export function startRefusalOf(error: unknown): ConnectorStartRefusal | null {
	const refused = error as Partial<ConnectorStartRefused> | null;
	return refused?.code === CONNECTOR_START_REFUSED && refused.refusal ? refused.refusal : null;
}
