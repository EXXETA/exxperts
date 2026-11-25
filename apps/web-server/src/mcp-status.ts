/**
 * Read-only MCP connector status for the web UI.
 *
 * Reuses pi-mcp-adapter's own config/auth/cache readers so the web UI reports
 * exactly what room sessions will see: the merged server list across the four
 * config locations, which file each server came from, OAuth credential state,
 * and cached tool metadata. Live connection state lives inside running agent
 * sessions and is intentionally not reported here.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { stateHome } from "../../../pi-package/product-state-paths.js";
import { commandLineOf } from "./connector-command.js";
import type { ConnectorStartRefusal, StartRefusalLookup } from "./connector-start-check.js";
import { mcpConnectorRoomUse, type McpConnectorRoomUse } from "./persistent-room-mcp-settings.js";
import { isSharedServer } from "./server-hooks.js";
import { connectorAddressGone, openedConnectorEntry } from "./stored-values.js";
import type { ConnectorKey } from "./connector-form.js";
import { marksReadOnly, toolOwnTitle, type MarkedTool } from "../../../pi-package/extensions/mcp/tool-marks.js";
import { connectorChoicesIn, connectorPin, readConnectorToolChoices, toolChoicesShown, type ToolChoicesUnreadable } from "./connector-tool-choices.js";
import type { ConnectorToolChoice } from "./room-approval-titles.js";

/** A tool in the adapter's saved list: `readOnly` is the mark a check kept before the list kept the connector's own marks. */
type SavedTool = NonNullable<MarkedTool> & { name: string; readOnly?: unknown };

/** Whether the saved list marks a tool read-only, by the gate's rule, or a check marked it so before the list kept marks. */
export function savedToolReadOnly(tool: SavedTool): boolean {
	return marksReadOnly(tool) || tool.readOnly === true;
}

// Non-literal specifiers so tsc never resolves into the adapter's raw .ts
// sources (same pattern as pi-package/extensions/mcp/index.ts).
const ADAPTER_CONFIG = "pi-mcp-adapter/config.ts" as string;
const ADAPTER_AUTH = "pi-mcp-adapter/mcp-auth.ts" as string;
const ADAPTER_CACHE = "pi-mcp-adapter/metadata-cache.ts" as string;
const ADAPTER_UTILS = "pi-mcp-adapter/utils.ts" as string;
const ADAPTER_TYPES = "pi-mcp-adapter/types.ts" as string;

export interface McpConnectorAuthStatus {
	mode: "oauth" | "bearer" | "none";
	// True when the entry explicitly configures OAuth (auth: "oauth" or a
	// custom client), as opposed to the URL-server auto-detect. Explicitly
	// configured OAuth means a login IS expected — even if the server lists
	// tools without one (Gmail and HubSpot expose their catalogs
	// unauthenticated, which otherwise looks like "no login needed").
	explicit: boolean;
	hasStoredTokens: boolean;
	tokenExpired: boolean | null;
	// An expired access token with a refresh token is not a problem — the
	// adapter renews it automatically on the next connection.
	hasRefreshToken: boolean;
}

export interface McpConnectorToolsStatus {
	/** Its tools a room offers the model: those its entry switches off by hand aren't counted. */
	count: number;
	/** Its documents a room offers the model, each as a tool that reads it; none when its documents are off. */
	documents: number;
	names: string[];
	/** A tool's own title, by its name, when the connector gave one. */
	titles: Record<string, string>;
	/** The line a tool's connector gives it, by its name, as the connector gave it; none on a shared server. */
	descriptions: Record<string, string>;
	/** The tools the saved list marks read-only, by the gate's rule, or a check marked so before the list kept marks; a list with no marks has none. */
	readOnly: string[];
	/** What a room can call to read each of its resources, by the adapter's own name; not on a shared server. */
	resources?: string[];
	/** The tools its entry switches off by hand (`excludeTools`); not on a shared server. */
	excluded?: string[];
	cachedAt: number;
}

/** The command's own name, as a start looks it up: without its folder, and without Windows' .cmd or .exe. */
const programName = (program: string) => path.basename(program).toLowerCase().replace(/\.(cmd|exe)$/, "");

/**
 * The runtimes a connector program can need, each with the program whose
 * absence shows it is missing: npx, npm and node come with Node.js, uvx and uv
 * with uv.
 */
export type ConnectorRuntime = "node" | "uv";
const RUNTIMES: Record<ConnectorRuntime, { programs: readonly string[]; shownBy: string }> = {
	node: { programs: ["node", "npx", "npm"], shownBy: "node" },
	uv: { programs: ["uv", "uvx"], shownBy: "uv" },
};

/** The runtime a program comes with, by its command's own name; null for any other. */
export function runtimeOf(program: string): { runtime: ConnectorRuntime; shownBy: string } | null {
	const name = programName(program);
	const found = (Object.keys(RUNTIMES) as ConnectorRuntime[]).find((runtime) => RUNTIMES[runtime].programs.includes(name));
	return found ? { runtime: found, shownBy: RUNTIMES[found].shownBy } : null;
}

/**
 * Python's two names: a command that says one by its bare name, on a computer
 * that has only the other, names the other. One named with its folder (a
 * virtual environment's) needs that Python, whose packages the other lacks.
 */
export const PYTHON_NAMES = ["python", "python3"] as const;
export type PythonName = (typeof PYTHON_NAMES)[number];
export const pythonNameOf = (program: string): PythonName | null => (path.basename(program) === program ? PYTHON_NAMES.find((name) => name === programName(program)) ?? null : null);

/** cmd.exe's own commands: no file has their name, and none is a program that is missing. */
const CMD_OWN_COMMANDS = new Set("assoc break call cd chdir cls color copy date del dir echo endlocal erase exit for ftype goto if md mkdir mklink move path pause popd prompt pushd rd rem ren rename rmdir set setlocal shift start time title type ver verify vol".split(" "));

/** A program's plain name or path, and a full path with spaces that ends in one program's ending, which no line of several words does. */
const PLAIN_PROGRAM = /^[\p{L}\p{N}_.:\\/+-]+$/u;
const SPACED_PROGRAM_PATH = /^(?!.*\.(?:exe|com|bat|cmd) )[\p{L}\p{N}_.:\\/+() -]+\.(?:exe|com|bat|cmd)$/iu;

/**
 * The program `cmd /c` is handed, as many Windows instructions write a
 * connector; null for any other command, and for anything after /c but one
 * program, which cmd.exe reads by rules of its own.
 */
export function programBehindCmd(command: string, args: readonly unknown[]): string | null {
	if (programName(command) !== "cmd") return null;
	const words = args.map(String);
	const flag = words.findIndex((word) => !word.startsWith("/") || word.toLowerCase() === "/c");
	const program = words[flag]?.toLowerCase() === "/c" ? (words[flag + 1] ?? "") : "";
	const one = PLAIN_PROGRAM.test(program) ? !CMD_OWN_COMMANDS.has(program.toLowerCase()) : path.isAbsolute(program) && SPACED_PROGRAM_PATH.test(program);
	return one ? program : null;
}

/**
 * How long a connector program has to give its check its first answer. One
 * started by a program that fetches what it runs at its first start (by the
 * command's own name) has the 5 minutes an npx download already has; every
 * other program has 30 s. These decide how long a check lets a program run
 * before it gives up; they start nothing.
 */
const DOWNLOADS_AT_FIRST_START = new Set(["npx", "uvx", "uv", "pipx", "docker", "podman"]);
export const downloadsAtFirstStart = (command: string) => DOWNLOADS_AT_FIRST_START.has(programName(command));
export const programAnswerLimitMs = (command: string) => (downloadsAtFirstStart(command) ? 5 * 60_000 : 30_000);

/**
 * Why a connector program didn't start: "not-found" its program isn't on this
 * computer (named as the start looked for it); "runtime-missing" the program
 * comes with a runtime (Node.js, uv) and no such runtime is where it looked;
 * "python-is-python3" its command names Python by one name and this computer
 * has it only by the other, `found`; "stopped" it ended before it answered;
 * "too-slow" it didn't answer in time; "not-a-connector" it wrote something
 * that isn't the connector protocol.
 */
export type ProgramStartFailure =
	| { cause: "not-found"; program: string }
	| { cause: "runtime-missing"; runtime: ConnectorRuntime }
	| { cause: "python-is-python3"; found: PythonName }
	| { cause: "stopped" | "too-slow" | "not-a-connector" };

const PROGRAM_CAUSES = new Set(["stopped", "too-slow", "not-a-connector"]);

/** A kept failure as written, or undefined for one this version doesn't know. A kept "node-missing", from before uv had its own line, is Node.js's. */
function programFailureRead(raw: unknown): ProgramStartFailure | undefined {
	const failure = raw as { cause?: unknown; program?: unknown; runtime?: unknown; found?: unknown } | null | undefined;
	if (failure?.cause === "not-found" && typeof failure.program === "string" && failure.program) return { cause: "not-found", program: failure.program };
	if (failure?.cause === "node-missing") return { cause: "runtime-missing", runtime: "node" };
	if (failure?.cause === "runtime-missing" && typeof failure.runtime === "string" && Object.hasOwn(RUNTIMES, failure.runtime)) return { cause: "runtime-missing", runtime: failure.runtime as ConnectorRuntime };
	if (failure?.cause === "python-is-python3" && PYTHON_NAMES.includes(failure.found as PythonName)) return { cause: "python-is-python3", found: failure.found as PythonName };
	return typeof failure?.cause === "string" && PROGRAM_CAUSES.has(failure.cause) ? { cause: failure.cause as "stopped" | "too-slow" | "not-a-connector" } : undefined;
}

/**
 * Why nothing a connector could use answered a web connector's check: nothing
 * is listening at its address; its name isn't found; an ordinary web page
 * answered; or its certificate isn't one this computer trusts.
 */
export type ConnectorReach = "nothing-there" | "name-not-found" | "web-page" | "untrusted-certificate";

const REACHES = new Set(["nothing-there", "name-not-found", "web-page", "untrusted-certificate"]);

/** What the last connection check found, kept so the page shows it at once on its next open. */
export interface McpConnectorCheck {
	at: number;
	ok: boolean;
	needsAuth?: boolean;
	/** The status the address answered with, when the check learned it. */
	httpStatus?: number;
	/** Why nothing answered, when the check could tell. */
	reach?: ConnectorReach;
	/** The server's own words, for Technical details; a shared server's status leaves them out. */
	error?: string;
	/** Why a program didn't start, when the check could tell. */
	programFailure?: ProgramStartFailure;
}

export interface McpConnectorStatus {
	name: string;
	transport: "http" | "stdio";
	/** On a shared server a web address leaves out its user part, query and fragment, where a key can sit. */
	target: string;
	/** On a shared server only: the address held a part the target leaves out. */
	addressKey?: true;
	/** On a shared server only: a lost storage key emptied its address and key, so both are given again. */
	addressNeeded?: true;
	/** importFile: the other tool's own file an imported entry is read from (Cursor's ~/.cursor/mcp.json); Remove cannot remove such an entry, so a change is made there. */
	source: { path: string; kind: string; importKind?: string; importFile?: string } | null;
	auth: McpConnectorAuthStatus;
	tools: McpConnectorToolsStatus | null;
	/** The name the person typed, when it differs from the fixed name. */
	displayName?: string;
	/** True for a web connector added here, whose address can be changed here. */
	editable: boolean;
	/** Where its key is, as Change key sees it. */
	key: ConnectorKey;
	/** Whether a new address on another site leaves it whole: only its name, its rooms and a key typed again go along. */
	movesToAnotherSite: boolean;
	/** Named in a file other apps read too (the shared MCP file or a project's .mcp.json), which Remove deletes it from as well. */
	inSharedFile?: true;
	/** The rooms that may use it; null where this server does not say (a shared server, whose rooms are other people's). */
	usedIn: McpConnectorRoomUse[] | null;
	lastCheck: McpConnectorCheck | null;
	/** A program that would not start now, because this room can change files where it runs from. */
	startRefused?: ConnectorStartRefusal;
	/** A program that fetches what it runs at its first start, so its first check can take minutes. */
	downloadsAtFirstStart?: true;
	/** Where it is, hashed (connector-tool-choices.ts): a save of Always allow names the connector it was made for by this. Not on a shared server. */
	identity?: string;
	/** What the person chose for its tools, by each tool's own name; a tool with nothing chosen isn't here. Not on a shared server. */
	choices?: Record<string, ConnectorToolChoice>;
	/** The choices file is there and can't be read, so every tool asks first, and why; `choices` is then left out. */
	choicesUnreadable?: ToolChoicesUnreadable;
}

/** The key an MCP config file keeps its connectors under, or null when it has none. */
export function mcpServersKeyOf(parsed: Record<string, unknown>): string | null {
	if (parsed.mcpServers && typeof parsed.mcpServers === "object") return "mcpServers";
	if (parsed["mcp-servers"] && typeof parsed["mcp-servers"] === "object") return "mcp-servers";
	return null;
}

/** The connector names a config file defines; none when it can't be read, as Remove then leaves it alone too. */
function namesInConfigFile(filePath: string): string[] {
	try {
		const parsed = JSON.parse(fs.readFileSync(filePath, "utf-8"));
		const key = mcpServersKeyOf(parsed);
		return key ? Object.keys(parsed[key] as Record<string, unknown>) : [];
	} catch {
		return [];
	}
}

export interface McpConfigSourceStatus {
	label: string;
	path: string;
	exists: boolean;
	scope: "global" | "project";
	serverCount: number;
}

export interface McpConnectorsStatusResponse {
	servers: McpConnectorStatus[];
	configSources: McpConfigSourceStatus[];
	totalServers: number;
}

function ensureAgentDirEnv(): void {
	// The adapter resolves its agent-global config dir from PI_CODING_AGENT_DIR
	// (defaulting to ~/.pi/agent); point it at the exxperts agent dir, matching
	// what the mcp extension does inside room sessions.
	if (!process.env.PI_CODING_AGENT_DIR) {
		process.env.PI_CODING_AGENT_DIR = path.join(stateHome(), ".exxperts", "agent");
	}
}

function connectorChecksPath(): string {
	ensureAgentDirEnv();
	return path.join(String(process.env.PI_CODING_AGENT_DIR), "mcp-connector-checks.json");
}

/** Every connector's last check; a missing or unreadable file reads as none known. */
export function readMcpConnectorChecks(): Record<string, McpConnectorCheck> {
	try {
		const parsed = JSON.parse(fs.readFileSync(connectorChecksPath(), "utf-8"));
		const checks = parsed?.schemaVersion === 1 && parsed.checks && typeof parsed.checks === "object" ? parsed.checks : {};
		const kept: Record<string, McpConnectorCheck> = {};
		for (const [name, raw] of Object.entries(checks as Record<string, Partial<McpConnectorCheck>>)) {
			if (!raw || typeof raw.at !== "number" || typeof raw.ok !== "boolean") continue;
			const programFailure = programFailureRead(raw.programFailure);
			kept[name] = {
				at: raw.at,
				ok: raw.ok,
				...(raw.needsAuth === true ? { needsAuth: true } : {}),
				...(typeof raw.httpStatus === "number" ? { httpStatus: raw.httpStatus } : {}),
				...(typeof raw.reach === "string" && REACHES.has(raw.reach) ? { reach: raw.reach } : {}),
				...(typeof raw.error === "string" ? { error: raw.error } : {}),
				...(programFailure ? { programFailure } : {}),
			};
		}
		return kept;
	} catch {
		return {};
	}
}

/**
 * Keep a connector's last check, or forget it (null) once it says nothing true
 * any more: after a sign-in or sign-out, a changed address, or a removal. Read,
 * change and write in one synchronous step through a temporary file, so two
 * checks finishing together in this process never lose one another.
 */
export function writeMcpConnectorCheck(name: string, check: McpConnectorCheck | null): void {
	const checks = readMcpConnectorChecks();
	if (check) checks[name] = check;
	else if (Object.hasOwn(checks, name)) delete checks[name];
	else return;
	// On a shared server no check keeps the service's words, one written before that rule included.
	for (const [known, kept] of Object.entries(checks)) checks[known] = lastCheckShown(kept) as McpConnectorCheck;
	const file = connectorChecksPath();
	fs.mkdirSync(path.dirname(file), { recursive: true });
	const tmp = `${file}.${process.pid}.tmp`;
	fs.writeFileSync(tmp, `${JSON.stringify({ schemaVersion: 1, checks }, null, 2)}\n`, { mode: 0o600 });
	fs.renameSync(tmp, file);
}

function tildePath(p: string): string {
	const home = os.homedir();
	return p.startsWith(home) ? `~${p.slice(home.length)}` : p;
}

/**
 * A header that carries a credential (an API key in its own header), by the
 * words in its name: Authorization, a token, a secret, or an API key
 * (X-Api-Key, Api-Key, ApiKey). Whole words, so Idempotency-Key or
 * Notion-Version are not taken for a sign-in.
 */
export function isCredentialHeaderName(name: string): boolean {
	const words = name.toLowerCase().split(/[-_.]/);
	return ["authorization", "token", "secret", "apikey"].some((word) => words.includes(word)) || (words.includes("api") && words.includes("key"));
}

/** A connector's entry as far as its key and sign-in go. */
interface ConnectorSignInEntry {
	auth?: "oauth" | "bearer" | false;
	bearerToken?: string;
	bearerTokenEnv?: string;
	headers?: Record<string, string>;
	oauth?: unknown;
}

export function connectorKeyOf(entry: ConnectorSignInEntry): ConnectorKey {
	const keyHeaders = Object.keys(entry.headers ?? {}).filter(isCredentialHeaderName).length;
	const token = Boolean(entry.bearerToken || entry.bearerTokenEnv || entry.auth === "bearer");
	if (!token) return keyHeaders === 0 ? "none" : keyHeaders === 1 ? "replaceable" : "fixed";
	return keyHeaders === 0 && !hasOwnSignInApp(entry) ? "replaceable" : "fixed";
}

/**
 * A web address as a shared server reads it back, opened: without the parts a
 * key can sit in. One that does not open or parse is left out whole.
 */
function sharedServerTarget(name: string, url: string): { target: string; addressKey?: true } {
	let parsed: URL;
	try {
		parsed = new URL(openedConnectorEntry(name, { url }).url);
	} catch {
		return { target: "", addressKey: true };
	}
	const held = parsed.username !== "" || parsed.password !== "" || parsed.search !== "" || parsed.hash !== "";
	return { target: `${parsed.origin}${parsed.pathname}`, ...(held ? { addressKey: true as const } : {}) };
}

/**
 * What a room offers the model from a connector's saved list, by the adapter's
 * own rule: its tools but those its entry switches off, and a tool for each
 * document unless its documents are off. The model's line counts the two
 * together (the adapter's buildProxyDescription), so the tools and documents a
 * person sees add up to what the model is told, on a shared server too, where
 * the lists leave documents and switched-off tools out.
 */
function toolsOfferedToModel(cacheMod: { reconstructToolMetadata: (...args: unknown[]) => unknown }, name: string, cacheEntry: unknown, prefixMode: unknown, entry: unknown): Array<{ originalName: string; description?: string; resourceUri?: string }> {
	return cacheMod.reconstructToolMetadata(name, cacheEntry, prefixMode, entry) as Array<{ originalName: string; description?: string; resourceUri?: string }>;
}

/** A last check as a status answers it: on a shared server without the service's words, which can repeat a key. */
function lastCheckShown(check: McpConnectorCheck | undefined): McpConnectorCheck | null {
	if (!check) return null;
	if (!isSharedServer()) return check;
	const { error: _words, ...shown } = check;
	return shown;
}

/**
 * Each tool's line as a status answers it: on a shared server none, as a
 * description is the service's words and can repeat a key, as it is or
 * encoded, which no match on the key's value would catch.
 */
function toolDescriptionsShown(tools: Array<{ name: string; description?: unknown }>): Record<string, string> {
	if (isSharedServer()) return {};
	return Object.fromEntries(tools.flatMap((tool) => (typeof tool.description === "string" && tool.description.trim() ? [[tool.name, tool.description]] : [])));
}

export function hasOwnSignInApp(entry: ConnectorSignInEntry): boolean {
	return typeof entry.oauth === "object" && entry.oauth !== null;
}

/**
 * On another site a connector keeps only its name, its rooms and a key typed
 * again. One with its own sign-in app, a header that isn't its key, or a key
 * that can't be typed again in one field would lose it, with no way to put it
 * back without adding the connector again.
 */
export function movesToAnotherSite(entry: ConnectorSignInEntry): boolean {
	return !hasOwnSignInApp(entry) && Object.keys(entry.headers ?? {}).every(isCredentialHeaderName) && connectorKeyOf(entry) !== "fixed";
}

function authModeFor(entry: {
	url?: string;
	auth?: "oauth" | "bearer" | false;
	bearerToken?: string;
	bearerTokenEnv?: string;
	headers?: Record<string, string>;
	oauth?: unknown;
}): McpConnectorAuthStatus["mode"] {
	if (entry.auth === "bearer" || entry.bearerToken || entry.bearerTokenEnv) return "bearer";
	// Static credential headers (API keys in their own header) come with
	// auth: false to switch off OAuth auto-detect, but to the UI they are
	// token auth, not "no login needed".
	if (entry.auth === false && Object.keys(entry.headers ?? {}).some(isCredentialHeaderName)) return "bearer";
	// Mirrors the adapter's supportsOAuth: HTTP servers auto-detect OAuth
	// unless auth/oauth is explicitly disabled.
	if (entry.url && entry.auth !== false && entry.oauth !== false) return "oauth";
	return "none";
}

/**
 * The current globally configured connector names (merged across the config
 * files, exactly what a session's adapter would load). This is the universe
 * per-room grants are validated against and intersected with.
 */
export async function listConfiguredMcpConnectorNames(): Promise<string[]> {
	ensureAgentDirEnv();
	const configMod = await import(ADAPTER_CONFIG);
	const config = configMod.loadMcpConfig();
	return Object.keys(config.mcpServers ?? {}).sort((a, b) => a.localeCompare(b));
}

/**
 * Each configured connector's name as typed, where one was given: the only
 * part of an entry a room's own Connectors pane needs beyond its fixed name,
 * and nothing that could carry an address, a command or a key.
 */
export async function listConfiguredMcpConnectorDisplayNames(): Promise<Record<string, string>> {
	ensureAgentDirEnv();
	const configMod = await import(ADAPTER_CONFIG);
	const servers: Record<string, { displayName?: unknown }> = configMod.loadMcpConfig().mcpServers ?? {};
	return Object.fromEntries(Object.entries(servers).flatMap(([name, entry]) => (typeof entry?.displayName === "string" && entry.displayName ? [[name, entry.displayName]] : [])));
}

/**
 * startCheck says which program would not start; without it no row carries
 * `startRefused`. It comes in from the caller, so this file never imports the
 * room folders' modules: a program that takes only isCredentialHeaderName from
 * here is built into one file that must not carry them.
 */
export async function getMcpConnectorsStatus(startCheck?: StartRefusalLookup): Promise<McpConnectorsStatusResponse> {
	ensureAgentDirEnv();
	const [configMod, authMod, cacheMod, utilsMod, typesMod] = await Promise.all([
		import(ADAPTER_CONFIG),
		import(ADAPTER_AUTH),
		import(ADAPTER_CACHE),
		import(ADAPTER_UTILS),
		import(ADAPTER_TYPES),
	]);

	const summary = configMod.getMcpDiscoverySummary();
	const config = configMod.loadMcpConfig();
	const provenance: Map<string, { path: string; kind: string; importKind?: string }> = configMod.getServerProvenance();
	const cache = cacheMod.loadMetadataCache();
	// The shared global file is no import kind, so its entries get no importFile: Remove works there.
	const importFiles = new Map<string, string>((configMod.findAvailableImportConfigs() as Array<{ kind: string; path: string }>).map((found) => [found.kind, found.path]));
	const checks = readMcpConnectorChecks();
	const inSharedFiles = new Set(
		((summary.sources ?? []) as Array<{ kind: string; path: string; exists: boolean }>)
			.filter((source) => source.kind === "shared" && source.exists)
			.flatMap((source) => namesInConfigFile(source.path)),
	);
	// A shared server's rooms belong to other people, so their names stay out of
	// the admin's answer; each room still shows its own connectors.
	const roomUse = isSharedServer() ? null : await mcpConnectorRoomUse();
	// The start check as a start would make it now, before the npx lookup, which can download.
	// The person's tool choices, and what a room can call beyond the saved tools: none on a shared server, which keeps no choice.
	const shared = isSharedServer();
	const choices = shared ? null : readConnectorToolChoices();
	const prefixMode = config.settings?.toolPrefix ?? "server";
	const writePlaces = startCheck && Object.values(config.mcpServers ?? {}).some((entry) => typeof (entry as { command?: unknown } | null)?.command === "string") ? await startCheck.roomWritePlaces() : [];

	const servers: McpConnectorStatus[] = Object.entries(config.mcpServers ?? {}).map(([name, rawEntry]) => {
		const entry = rawEntry as {
			url?: string;
			command?: string;
			args?: string[];
			cwd?: string;
			env?: Record<string, string>;
			auth?: "oauth" | "bearer" | false;
			bearerToken?: string;
			bearerTokenEnv?: string;
			headers?: Record<string, string>;
			oauth?: unknown;
			displayName?: unknown;
		};
		const mode = authModeFor(entry);
		const source = provenance.get(name);
		const cacheEntry = cache?.servers?.[name];
		const cacheValid = cacheEntry ? cacheMod.isServerCacheValid(cacheEntry, entry) : false;
		const addressNeeded = isSharedServer() && connectorAddressGone(entry);
		const offered = cacheValid ? toolsOfferedToModel(cacheMod, name, cacheEntry, prefixMode, entry) : [];
		const documents = offered.filter((tool) => tool.resourceUri);
		const resourceTools = shared ? [] : documents;
		// Looked up as the start looks it up: on the connector's own PATH when it declares one.
		const startRefused = startCheck && typeof entry.command === "string" ? startCheck.connectorStartRefusal({ command: entry.command, args: Array.isArray(entry.args) ? entry.args : [], cwd: utilsMod.resolveConfigPath(entry.cwd), environment: utilsMod.interpolateEnvRecord(entry.env) }, writePlaces) : null;
		return {
			name,
			transport: entry.url || addressNeeded ? "http" : "stdio",
			...(addressNeeded ? { addressNeeded: true as const } : {}),
			// A program as a line that, pasted back, adds the same program and arguments.
			...(entry.url && isSharedServer() ? sharedServerTarget(name, entry.url) : { target: entry.url ?? (typeof entry.command === "string" ? commandLineOf(entry.command, Array.isArray(entry.args) ? entry.args : [], process.platform) : "") }),
			source: source ? { path: tildePath(source.path), kind: source.kind, importKind: source.importKind, ...(source.importKind && importFiles.has(source.importKind) ? { importFile: tildePath(importFiles.get(source.importKind)!) } : {}) } : null,
			auth: {
				mode,
				explicit: mode === "oauth" && (entry.auth === "oauth" || (typeof entry.oauth === "object" && entry.oauth !== null)),
				hasStoredTokens: mode === "oauth" ? Boolean(authMod.hasStoredTokens(name)) : false,
				tokenExpired: mode === "oauth" ? (authMod.isTokenExpired(name) as boolean | null) : null,
				hasRefreshToken: mode === "oauth" ? Boolean(authMod.getAuthEntry(name)?.tokens?.refreshToken) : false,
			},
			tools: cacheValid
				? {
						count: offered.length - documents.length,
						documents: documents.length,
						names: (cacheEntry.tools ?? []).map((tool: { name: string }) => tool.name),
						titles: Object.fromEntries((cacheEntry.tools ?? []).flatMap((tool: SavedTool) => {
							const title = toolOwnTitle(tool);
							return title ? [[tool.name, title]] : [];
						})),
						descriptions: toolDescriptionsShown([...(cacheEntry.tools ?? []), ...resourceTools.map((tool) => ({ name: tool.originalName, description: tool.description }))]),
						readOnly: (cacheEntry.tools ?? []).filter(savedToolReadOnly).map((tool: SavedTool) => tool.name),
						...(shared ? {} : {
							resources: resourceTools.map((tool) => tool.originalName),
							excluded: (cacheEntry.tools ?? []).filter((tool: SavedTool) => typesMod.isToolExcluded(tool.name, name, prefixMode, (entry as { excludeTools?: unknown }).excludeTools)).map((tool: SavedTool) => tool.name),
						}),
						cachedAt: cacheEntry.cachedAt,
					}
				: null,
			...(typeof entry.displayName === "string" && entry.displayName.trim() ? { displayName: entry.displayName.trim() } : {}),
			// Only an entry in exxperts' own file, which the address route writes.
			editable: (Boolean(entry.url) || (addressNeeded && movesToAnotherSite(entry))) && source?.kind === "user" && !source.importKind,
			key: connectorKeyOf(entry),
			movesToAnotherSite: movesToAnotherSite(entry),
			...(inSharedFiles.has(name) ? { inSharedFile: true as const } : {}),
			usedIn: roomUse ? (roomUse.get(name) ?? []) : null,
			lastCheck: lastCheckShown(checks[name]),
			...(startRefused ? { startRefused } : {}),
			...(typeof entry.command === "string" && downloadsAtFirstStart(entry.command) ? { downloadsAtFirstStart: true as const } : {}),
			...(choices ? { identity: connectorPin(rawEntry as Record<string, unknown>), ...(choices.readable ? { choices: toolChoicesShown(connectorChoicesIn(choices, name)) } : { choicesUnreadable: choices.why }) } : {}),
		};
	});

	// The adapter labels sources in Pi terms ("Pi global override"); present
	// them in product terms instead.
	const SOURCE_LABELS: Record<string, string> = {
		"shared-global": "shared user config (Cursor/Claude compatible)",
		"pi-global": "exxperts user config",
		"shared-project": "project config",
		"pi-project": "project override",
	};
	// Project-scoped files resolve against this server process's cwd, which is
	// meaningless to a web user (project configs are a per-folder CLI concept)
	// — only report the global files here.
	const configSources: McpConfigSourceStatus[] = (summary.sources ?? [])
		.filter((source: { scope: string }) => source.scope === "global")
		.map(
			(source: { id: string; label: string; path: string; exists: boolean; scope: "global" | "project"; serverCount: number }) => ({
				label: SOURCE_LABELS[source.id] ?? source.label,
				path: tildePath(source.path),
				exists: source.exists,
				scope: source.scope,
				serverCount: source.serverCount,
			}),
		);

	return {
		servers: servers.sort((a, b) => a.name.localeCompare(b.name)),
		configSources,
		totalServers: servers.length,
	};
}
