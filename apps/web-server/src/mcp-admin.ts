/**
 * MCP connector management for the web UI: add/remove servers, OAuth
 * login/logout, and one-off connection tests.
 *
 * Config writes go through the same files the adapter reads. Running room
 * sessions load MCP config at session start, so changes apply the next time
 * a room session is (re)entered — callers surface that in the UI.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { writeFileAtomic } from "@exxeta/exxperts-runtime";
import { stateHome } from "../../../pi-package/product-state-paths.js";
import { CONNECTOR_COMMAND_LINES, readConnectorCommand, SETTING_LINES, SETTING_NAME } from "./connector-command.js";
import { declareRoomAbilities } from "./connector-abilities.js";
import { closeConnectorConnections, closeConnectorEverywhere } from "./connector-close-all.js";
import { connectorSearchPath } from "./connector-search-path.js";
import { installConnectorStartCheck, programFile, programMissingOnWindows, startRefusalOf, type ConnectorStartRefusal } from "./connector-start-check.js";
import { CONNECTOR_FORM_LINES, CONNECTOR_REQUEST_LINES, MAX_CONNECTOR_NAME_LENGTH, connectorDisplayName, connectorFixedName, connectorShownName, importAppName, isPassingStatus, readConnectorAddress, sameConnectorSite } from "./connector-form.js";
import { connectorKeyOf, hasOwnSignInApp, isCredentialHeaderName, mcpServersKeyOf, movesToAnotherSite, programAnswerLimitMs, programBehindCmd, PYTHON_NAMES, pythonNameOf, runtimeOf, savedToolReadOnly, writeMcpConnectorCheck, type ConnectorReach, type ProgramStartFailure } from "./mcp-status.js";
import { forgetMcpConnectorToolsInAllRooms, forgetMcpConnectorToolYesesInAllRooms, type McpConnectorRevokeSweepResult, revokeMcpConnectorFromAllRooms } from "./persistent-room-mcp-settings.js";
import { connectorPin, type ConnectorToolChoices, forgetConnectorToolChoices, isConnectorToolChoice, isToolChoiceName, readConnectorToolChoices, setConnectorToolChoices, setUnreadableToolChoicesAside, type StoredToolChoice, toolChoicesShown, ToolChoicesUnreadableError } from "./connector-tool-choices.js";
import type { ConnectorToolChoice } from "./room-approval-titles.js";
import { rereadWindowsSearchPath } from "./room-box/windows/windows-search-path.js";
import { isSharedServer, serverHooks } from "./server-hooks.js";
import { connectorAddressGone, openedConnectorEntry, sealedConnectorEntry } from "./stored-values.js";
import { discoverOAuthServerInfo } from "@modelcontextprotocol/sdk/client/auth.js";

// Non-literal specifiers so tsc never resolves into the adapter's raw .ts
// sources (same pattern as mcp-status.ts).
const ADAPTER_CONFIG = "pi-mcp-adapter/config.ts" as string;
const ADAPTER_UTILS = "pi-mcp-adapter/utils.ts" as string;
const ADAPTER_AUTH_FLOW = "pi-mcp-adapter/mcp-auth-flow.ts" as string;
const ADAPTER_AUTH_STORE = "pi-mcp-adapter/mcp-auth.ts" as string;
const ADAPTER_CALLBACK = "pi-mcp-adapter/mcp-callback-server.ts" as string;
const ADAPTER_SERVER_MANAGER = "pi-mcp-adapter/server-manager.ts" as string;
const ADAPTER_CACHE = "pi-mcp-adapter/metadata-cache.ts" as string;

export class McpAdminError extends Error {
	constructor(
		message: string,
		readonly statusCode: number = 400,
	) {
		super(message);
	}
}

/** A removal that rooms stopped: nothing was removed, and each of these rooms says why. */
export class McpRoomsKeepConnectorError extends McpAdminError {
	constructor(readonly revokeFailures: McpConnectorRevokeSweepResult["failures"]) {
		super("Failed to remove the connector.", 500);
	}
}

/** A connector's entry by its name: an entry of its own, never a property every object has, such as `constructor`. */
function entryNamed<S extends Record<string, unknown>>(servers: S | null | undefined, name: string): S[string] | undefined {
	return servers && Object.hasOwn(servers, name) ? (servers[name] as S[string]) : undefined;
}

function ensureAgentDirEnv(): void {
	if (!process.env.PI_CODING_AGENT_DIR) {
		process.env.PI_CODING_AGENT_DIR = path.join(stateHome(), ".exxperts", "agent");
	}
}

export interface AddMcpServerOAuthInput {
	clientId?: string;
	clientSecret?: string;
	scope?: string;
}

export interface AddMcpServerInput {
	/** The name a person typed; the fixed name is made from it. */
	name: string;
	url?: string;
	/** A program and its arguments as one line, pasted as a terminal takes it; read by connector-command.ts. */
	commandLine?: string;
	/** A program as it is, with args beside it: the shape before commandLine. */
	command?: string;
	args?: string[];
	/** Settings a program needs, by name. */
	env?: Record<string, string>;
	bearerToken?: string;
	oauth?: AddMcpServerOAuthInput;
	/** Extra headers sent with every request, such as a key a server expects in its own header. */
	headers?: Record<string, string>;
}

interface ServerEntryShape {
	/** The name as typed, kept only when it differs from the fixed name. */
	displayName?: string;
	url?: string;
	command?: string;
	args?: string[];
	env?: Record<string, string>;
	auth?: "bearer" | "oauth" | false;
	bearerToken?: string;
	headers?: Record<string, string>;
	oauth?: { clientId: string; clientSecret?: string; scope?: string };
}

// Headers the connection itself sets, or that would let a value reshape the
// request; a custom header may not replace them.
const RESERVED_HEADERS = new Set(["host", "content-length", "content-type", "accept", "connection", "transfer-encoding", "upgrade", "te", "trailer", "keep-alive", "proxy-authorization", "proxy-connection", "cookie", "mcp-session-id", "mcp-protocol-version", "last-event-id"]);
const HEADER_NAME_PATTERN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,100}$/;
const MAX_HEADERS = 20;
const MAX_HEADER_VALUE_LENGTH = 4096;

/**
 * Custom headers for a remote connector, checked before they reach the
 * config file: valid names, no line break or other control character in a
 * value (it could add a header of its own), none of the headers the
 * connection sets, no name twice, and no Authorization next to the API token
 * or an OAuth client, which set it themselves.
 */
function validateHeaders(raw: unknown, authorizationSet: boolean): Record<string, string> | undefined {
	if (raw === undefined || raw === null) return undefined;
	if (typeof raw !== "object" || Array.isArray(raw)) throw new McpAdminError("Custom headers must be a list of names and values.");
	const entries = Object.entries(raw as Record<string, unknown>);
	if (entries.length === 0) return undefined;
	if (entries.length > MAX_HEADERS) throw new McpAdminError(CONNECTOR_FORM_LINES.tooManyHeaders(MAX_HEADERS));
	const headers: Record<string, string> = {};
	const seen = new Set<string>();
	for (const [rawName, rawValue] of entries) {
		const name = rawName.trim();
		if (!name) throw new McpAdminError(CONNECTOR_FORM_LINES.headerUnnamed);
		if (!HEADER_NAME_PATTERN.test(name)) throw new McpAdminError(`"${name.slice(0, 40)}" is not a valid header name: use letters, digits and dashes.`);
		if (typeof rawValue !== "string") throw new McpAdminError(`The ${name} header's value must be text.`);
		const value = rawValue.trim();
		const lower = name.toLowerCase();
		if (RESERVED_HEADERS.has(lower)) throw new McpAdminError(`The ${name} header is set by the connection itself and cannot be changed.`);
		if (lower === "authorization" && authorizationSet) throw new McpAdminError(CONNECTOR_FORM_LINES.keyAndAuthorizationHeader);
		if (seen.has(lower)) throw new McpAdminError(`The ${name} header is listed twice.`);
		if (!value) throw new McpAdminError(`The ${name} header needs a value.`);
		if (value.length > MAX_HEADER_VALUE_LENGTH) throw new McpAdminError(`The ${name} header's value is too long.`);
		if (/\p{Cc}/u.test(value)) throw new McpAdminError(CONNECTOR_FORM_LINES.headerHiddenCharacter(name));
		// A header carries only Latin-1; a dash or quote pasted from a document
		// would otherwise pass here and fail only when the connector connects.
		if (/[^\u0000-\u00ff]/u.test(value)) throw new McpAdminError(`The ${name} header's value contains a character a header cannot carry, such as a typographic dash or quote. Type it again by hand.`);
		seen.add(lower);
		headers[name] = value;
	}
	return headers;
}

const MAX_SETTINGS = 50;
const MAX_SETTING_VALUE_LENGTH = 32_768;

/**
 * A program's settings, from the form and from in front of a pasted command,
 * checked before they reach the config file: names as a terminal takes them,
 * none twice, a value each with no control character (a NUL would stop the
 * program from starting at all).
 */
function validateSettings(raw: unknown, fromLine: Record<string, string>): Record<string, string> | undefined {
	if (raw !== undefined && raw !== null && (typeof raw !== "object" || Array.isArray(raw))) throw new McpAdminError("Settings must be a list of names and values.");
	const entries = [...Object.entries(fromLine), ...Object.entries((raw ?? {}) as Record<string, unknown>)];
	if (entries.length === 0) return undefined;
	if (entries.length > MAX_SETTINGS) throw new McpAdminError(`A connector can have at most ${MAX_SETTINGS} settings.`);
	const settings: Array<[string, string]> = [];
	const seen = new Set<string>();
	for (const [rawName, rawValue] of entries) {
		const name = rawName.trim();
		if (!name) throw new McpAdminError(SETTING_LINES.unnamed);
		if (!SETTING_NAME.test(name) || name.length > 200) throw new McpAdminError(`"${name.slice(0, 40)}" can't be a setting's name: use letters, digits and _, not starting with a digit.`);
		if (typeof rawValue !== "string") throw new McpAdminError(`The ${name} setting's value must be text.`);
		if (seen.has(name)) throw new McpAdminError(SETTING_LINES.twice(name));
		if (!rawValue) throw new McpAdminError(SETTING_LINES.noValue(name));
		if (rawValue.length > MAX_SETTING_VALUE_LENGTH) throw new McpAdminError(`The ${name} setting's value is too long.`);
		if (/\p{Cc}/u.test(rawValue)) throw new McpAdminError(`The ${name} setting's value contains a hidden character, such as a line break. Type it again by hand.`);
		seen.add(name);
		settings.push([name, rawValue]);
	}
	// Built from pairs, so a name such as __proto__ is a setting like any other.
	return Object.fromEntries(settings);
}

/** A program entry from the pasted line, or from command and args as they were sent before. */
function programEntry(input: AddMcpServerInput): ServerEntryShape | null {
	const line = String(input.commandLine ?? "");
	if (line.trim()) {
		if (String(input.command ?? "").trim()) throw new McpAdminError("Send the command as one line or as a program and its arguments, not both.");
		const read = readConnectorCommand(line, process.platform, os.homedir());
		if ("error" in read) throw new McpAdminError(read.error);
		const env = validateSettings(input.env, read.env);
		return { command: read.command, ...(read.args.length > 0 ? { args: read.args } : {}), ...(env ? { env } : {}) };
	}
	const command = String(input.command ?? "").trim();
	if (!command) return null;
	const args = Array.isArray(input.args) ? input.args.map((a) => String(a)).filter((a) => a.trim() !== "") : [];
	const env = validateSettings(input.env, {});
	return { command, ...(args.length > 0 ? { args } : {}), ...(env ? { env } : {}) };
}

function validateAddInput(input: AddMcpServerInput): { name: string; entry: ServerEntryShape } {
	const name = connectorDisplayName(String(input.name ?? ""));
	if (!name) throw new McpAdminError(CONNECTOR_FORM_LINES.nameMissing);
	if (name.length > MAX_CONNECTOR_NAME_LENGTH) throw new McpAdminError(CONNECTOR_FORM_LINES.nameTooLong);
	const typedUrl = String(input.url ?? "").trim();
	const command = String(input.command ?? "").trim() || String(input.commandLine ?? "").trim();
	if (typedUrl && command) throw new McpAdminError("Provide either a URL or a command, not both.");
	if (typedUrl) {
		if (input.env && Object.keys(input.env).length > 0) throw new McpAdminError("Settings only apply to a program on this computer.");
		const address = readConnectorAddress(typedUrl);
		if ("error" in address) throw new McpAdminError(address.error);
		const url = address.url;
		const bearerToken = String(input.bearerToken ?? "").trim();
		const clientId = String(input.oauth?.clientId ?? "").trim();
		const clientSecret = String(input.oauth?.clientSecret ?? "").trim();
		const scope = String(input.oauth?.scope ?? "").trim();
		if ((clientSecret || scope) && !clientId) throw new McpAdminError(CONNECTOR_FORM_LINES.clientIdMissing);
		if (bearerToken && clientId) throw new McpAdminError(CONNECTOR_FORM_LINES.keyAndSignInApp);
		const headers = validateHeaders(input.headers, Boolean(bearerToken || clientId));
		const withHeaders = headers ? { headers } : {};
		if (bearerToken) return { name, entry: { url, auth: "bearer", bearerToken, ...withHeaders } };
		if (clientId) {
			// Pre-registered client: the adapter's OAuth provider uses it directly
			// and skips dynamic client registration, which providers like HubSpot
			// do not support.
			return {
				name,
				entry: { url, auth: "oauth", oauth: { clientId, ...(clientSecret ? { clientSecret } : {}), ...(scope ? { scope } : {}) }, ...withHeaders },
			};
		}
		// A key in its own header is the sign-in: OAuth auto-detect is switched
		// off, as for one written into the file by hand, or the adapter would
		// ask for a login the server does not offer. Other headers (a tenant, a
		// version) leave auto-detect on.
		if (headers && Object.keys(headers).some(isCredentialHeaderName)) return { name, entry: { url, auth: false, headers } };
		return { name, entry: { url, ...withHeaders } };
	}
	if (input.bearerToken) throw new McpAdminError("API tokens only apply to remote (URL) connectors.");
	if (input.headers && Object.keys(input.headers).length > 0) throw new McpAdminError("Custom headers only apply to remote (URL) connectors.");
	if (input.oauth?.clientId) throw new McpAdminError("Custom OAuth clients only apply to remote (URL) connectors.");
	const entry = programEntry(input);
	if (entry) return { name, entry };
	if (input.commandLine !== undefined) throw new McpAdminError(CONNECTOR_COMMAND_LINES.missing);
	throw new McpAdminError("Provide a server URL (remote) or a command (local).");
}

/**
 * Add a connector. The person's name may hold any text; the fixed name made
 * from it is the connector's key everywhere (room access, the saved sign-in,
 * the tool names), and the typed name is kept beside it only where the two
 * differ, so an entry named as before reads exactly as before.
 */
export async function addMcpServer(input: AddMcpServerInput): Promise<{ name: string; path: string }> {
	ensureAgentDirEnv();
	const configMod = await import(ADAPTER_CONFIG);
	const { name: displayName, entry } = validateAddInput(input);
	const servers: Record<string, { displayName?: unknown }> = configMod.loadMcpConfig().mcpServers ?? {};
	const name = connectorFixedName(displayName, new Set(Object.keys(servers)));
	// Unique as people see them: the new one's shown name may be the directory's, not the typed one.
	// The line names the connector the person already has, as they see it.
	const shown = connectorShownName(name, displayName).toLowerCase();
	const holder = Object.entries(servers)
		.map(([existing, existingEntry]) => connectorShownName(existing, typeof existingEntry?.displayName === "string" ? existingEntry.displayName : undefined))
		.find((existingShown) => existingShown.toLowerCase() === shown);
	if (holder !== undefined) throw new McpAdminError(CONNECTOR_FORM_LINES.nameTaken(holder), 409);
	const refusal = serverHooks().connectorEntryRefusal?.(entry, name);
	if (refusal) throw new McpAdminError(refusal);
	// A new one starts with no last check: a removal that couldn't forget the
	// old one's leaves it, and one that can't be forgotten now stops the add.
	writeMcpConnectorCheck(name, null);
	const target: string = configMod.getPiGlobalConfigPath();
	writeOwnConnectorEntry(target, name, sealedConnectorEntry(name, name === displayName ? entry : { displayName, ...entry }));
	return { name, path: target };
}

/**
 * The mode exxperts' own connector file is written with: it can hold a key as
 * typed, so only its owner reads it (600), or tighter where it already is. A
 * file written before at 644 becomes 600 at its next write. Windows keeps no
 * such mode, so nothing changes there.
 */
function ownConnectorFileMode(filePath: string): number {
	try {
		return fs.statSync(filePath).mode & 0o600;
	} catch {
		return 0o600;
	}
}

/**
 * Writes one connector's entry into exxperts' own connector file, whole,
 * as the adapter's own write would (its other entries and keys kept, the old
 * "mcp-servers" key moved to "mcpServers"), but private: the adapter's write
 * leaves the file readable to every account on the computer.
 */
const isPlainObject = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);

function writeOwnConnectorEntry(filePath: string, name: string, entry: object): void {
	// Only a file that isn't there yet starts afresh: one that can't be read as connectors keeps them, and its keys, untouched.
	let text: string | null = null;
	try {
		text = fs.readFileSync(filePath, "utf-8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new McpAdminError(CONNECTOR_REQUEST_LINES.loadFailed, 409);
	}
	let raw: Record<string, unknown> = {};
	if (text !== null) {
		let parsed: unknown;
		try {
			parsed = JSON.parse(text);
		} catch {
			throw new McpAdminError(CONNECTOR_REQUEST_LINES.loadFailed, 409);
		}
		if (!isPlainObject(parsed)) throw new McpAdminError(CONNECTOR_REQUEST_LINES.loadFailed, 409);
		raw = parsed;
	}
	const existing = raw.mcpServers ?? raw["mcp-servers"];
	if (existing !== undefined && !isPlainObject(existing)) throw new McpAdminError(CONNECTOR_REQUEST_LINES.loadFailed, 409);
	const servers = existing ?? {};
	delete raw["mcp-servers"];
	raw.mcpServers = { ...servers, [name]: entry };
	fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
	writeFileAtomic(filePath, `${JSON.stringify(raw, null, 2)}\n`, { mode: ownConnectorFileMode(filePath) });
}

/** A config file's connectors, parsed, when the file defines `name` itself. */
function fileDefining(filePath: string, name: string): { parsed: Record<string, unknown>; servers: Record<string, unknown> } | null {
	let parsed: Record<string, unknown>;
	try {
		parsed = JSON.parse(fs.readFileSync(filePath, "utf-8"));
	} catch {
		return null;
	}
	const key = mcpServersKeyOf(parsed);
	const servers = key ? (parsed[key] as Record<string, unknown>) : null;
	return servers && Object.hasOwn(servers, name) ? { parsed, servers } : null;
}

/** After a failed write: whether the file still defines `name`, gone counting as no; null when it cannot be read, so nobody can say. */
function definesAfterFailure(filePath: string, name: string): boolean | null {
	let parsed: Record<string, unknown>;
	try {
		parsed = JSON.parse(fs.readFileSync(filePath, "utf-8"));
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "ENOENT" ? false : null;
	}
	const key = mcpServersKeyOf(parsed);
	return Boolean(key && Object.hasOwn(parsed[key] as Record<string, unknown>, name));
}

/** `own`: exxperts' own connector file, kept private; any other can be another app's too, so it keeps the permissions it had. */
function removeEntryFromFile(filePath: string, name: string, own: boolean): boolean {
	const file = fileDefining(filePath, name);
	if (!file) return false;
	delete file.servers[name];
	writeFileAtomic(filePath, `${JSON.stringify(file.parsed, null, 2)}\n`, { mode: own ? ownConnectorFileMode(filePath) : fs.statSync(filePath).mode & 0o777 });
	return true;
}

/**
 * Remove a connector from exxperts and from every room (grant identity rule:
 * one added later by the same name starts with no grant and no yes anywhere).
 * All or nothing: a connector that isn't here (404) or that only another
 * app's file defines (409) is refused before any room is touched. The rooms
 * go first, then each file that defines it; when a room stops it, or a file
 * can't be written and still defines it, every room gets its file back and the
 * connector stays; one that can't be read after that fails the delete with
 * the grants gone.
 * A process stopped midway leaves grants gone and the connector kept, never
 * a grant left for a namesake. Once its files are written it is removed, and
 * the answer says so: a clean-up that fails after that is only logged.
 */
export async function removeMcpServer(name: string): Promise<{ name: string; removedFrom: string[]; revokedFromRooms: string[] }> {
	ensureAgentDirEnv();
	const configMod = await import(ADAPTER_CONFIG);
	if (!entryNamed(configMod.loadMcpConfig().mcpServers, name)) {
		throw new McpAdminError(CONNECTOR_REQUEST_LINES.noLongerExists, 404);
	}
	// Delete from every config file that literally defines the name. Provenance
	// can't drive this: entries in the shared global file report the exxperts
	// file as their write path, so deleting there would silently leave the
	// server configured.
	const files = (configMod.getConfigDiscoveryPaths() as Array<{ path: string; exists: boolean }>).filter((source) => source.exists && fileDefining(source.path, name)).map((source) => source.path);
	if (files.length === 0) {
		throw new McpAdminError(CONNECTOR_REQUEST_LINES.notRemovable(importAppName(configMod.getServerProvenance().get(name)?.importKind)), 409);
	}
	// Its choices go with it, so they must be readable: when they aren't, nothing is touched, and the answer says what to do first.
	const choicesRead = readConnectorToolChoices();
	if (!choicesRead.readable) throw new McpAdminError(CONNECTOR_REQUEST_LINES.removeChoicesUnreadable[choicesRead.why], 409);
	const revoke = revokeMcpConnectorFromAllRooms(name);
	if (revoke.failures.length > 0) throw new McpRoomsKeepConnectorError(revoke.failures);
	const giveRoomsBack = () => {
		for (const failure of revoke.undo()) console.warn(`connector delete: giving the room back its grant failed in ${failure.agentId}: ${failure.error}`);
	};
	// Its tool choices go in the same step, so one added later by the name starts clean; when they can't, nothing is removed.
	let choices: { undo: () => void };
	try {
		choices = forgetConnectorToolChoices(name, "all");
	} catch (error) {
		console.warn(`connector delete: forgetting its tool choices failed, so nothing was removed: ${(error as Error).message}`);
		giveRoomsBack();
		if (error instanceof ToolChoicesUnreadableError) throw new McpAdminError(CONNECTOR_REQUEST_LINES.removeChoicesUnreadable[error.why], 409);
		throw new McpAdminError("Failed to remove the connector.", 500);
	}
	const removedFrom: string[] = [];
	const ownFile = path.resolve(configMod.getPiGlobalConfigPath());
	try {
		for (const file of files) {
			if (removeEntryFromFile(file, name, path.resolve(file) === ownFile)) removedFrom.push(file);
		}
	} catch (error) {
		// A write can fail after its file landed (its folder's flush), so the disk says whether the connector stays.
		const defines = files.map((file) => definesAfterFailure(file, name));
		if (defines.includes(true)) {
			// A file still defines it, so the connector stays: so do its grants and its choices.
			giveRoomsBack();
			try {
				choices.undo();
			} catch (undoError) {
				console.warn(`connector delete: giving back its tool choices failed: ${(undoError as Error).message}`);
			}
			throw error;
		}
		// A file nobody can read may still define it: the delete fails, and its grants stay gone, as after a stop midway.
		if (defines.includes(null)) throw error;
		console.warn(`connector delete: ${name} is removed, but saving its file failed after it landed: ${(error as Error).message}`);
		removedFrom.splice(0, removedFrom.length, ...files);
	}
	// Another delete took it meanwhile, its grants with it.
	if (removedFrom.length === 0) throw new McpAdminError(CONNECTOR_REQUEST_LINES.noLongerExists, 404);
	// From here it is removed, so the answer says so: what follows only tidies
	// up, and a step that fails is logged, never answered.
	const tidy = async (what: string, step: () => unknown) => {
		try {
			await step();
		} catch (error) {
			console.warn(`connector delete: ${name} is removed, but ${what} failed: ${(error as Error).message}`);
		}
	};
	// Its questions, calls and programs end in every conversation, so no room uses it any more.
	await tidy("ending its calls and programs", () => closeConnectorEverywhere(name));
	// A sign-in still waiting for the browser ends with it, so it saves nothing
	// for a connector that is gone, and one added again by the name starts afresh.
	await tidy("ending its sign-in", () => cancelMcpServerLogin(name));
	pendingLogins.delete(name);
	await tidy("dropping its stored sign-in", async () => (await import(ADAPTER_AUTH_FLOW)).removeAuth(name));
	// Drop the cached tool list too: if the server is re-added later under the
	// same name, a surviving cache entry with no stored tokens would make the
	// UI claim "no login needed" until a test disproves it.
	await dropMetadataCacheEntry(name);
	// One added later by the name forgets it too (addMcpServer), should this fail.
	await tidy("forgetting its last check", () => writeMcpConnectorCheck(name, null));
	return { name, removedFrom, revokedFromRooms: revoke.revokedFrom };
}

// One login may be in flight per server; the UI polls /api/mcp/status for the
// resulting tokens rather than holding the HTTP request open.
/** Why a sign-in failed, so the page offers Try again only where trying again can work; "declined" is the person's own No on the service's page. */
export type McpLoginFailure = "needs-own-app" | "refused" | "declined" | "busy" | "no-sign-in" | "too-slow" | "other";

/**
 * A refusal the service sent back to the sign-in, by the standard's code
 * (OAuth 2.0, RFC 6749 4.1.2.1, and resource indicators, RFC 8707): the
 * person said no; the service is busy for now; or it won't let this sign-in
 * through, which trying again can't change.
 */
const SIGN_IN_REFUSALS: Record<string, McpLoginFailure> = {
	access_denied: "declined",
	server_error: "busy",
	temporarily_unavailable: "busy",
	invalid_target: "refused",
	invalid_scope: "refused",
	invalid_request: "refused",
	unauthorized_client: "refused",
	unsupported_response_type: "refused",
};

const pendingLogins = new Map<string, { startedAt: number; cause?: McpLoginFailure; detail?: string; done: boolean }>();

// OAuth is auto-detected for URL servers, so "log in" against a public server
// fails at endpoint discovery with SDK internals (404s, JSON parse noise).
// Translate that into what it actually means.
/**
 * Transport errors can embed the entire HTTP response body (the MCP SDK's
 * "Error POSTing to endpoint: <body>" includes full tool catalogs — observed
 * live with Google's Gmail MCP returning 403 with the complete tools list as
 * the body). Cap what reaches the UI; the point of the message is the first
 * line, not the payload.
 */
function trimTransportError(message: string, max = 280): string {
	const trimmed = message.trim();
	if (trimmed.length <= max) return trimmed;
	return `${trimmed.slice(0, max)}…`;
}

/**
 * The adapter's sign-in error, read once: why it failed and, for Technical
 * details, the service's own words. The page words the line from the cause,
 * as only it knows where the connector was added.
 */
export function loginFailureOf(error: unknown): { cause: McpLoginFailure; detail: string } {
	const e = error as { message?: unknown; signInRefusal?: unknown } | null;
	const message = typeof e?.message === "string" ? e.message : String(error);
	// The service's own refusal, by its code (scripts/patch-mcp-adapter.mjs, patch 1).
	const refusal = typeof e?.signInRefusal === "string" && Object.hasOwn(SIGN_IN_REFUSALS, e.signInRefusal) ? SIGN_IN_REFUSALS[e.signInRefusal] : null;
	return { cause: refusal ?? loginCauseOf(message), detail: trimTransportError(message) };
}

function loginCauseOf(message: string): McpLoginFailure {
	if (/does not support dynamic client registration/i.test(message)) return "needs-own-app";
	// A 403 mid-flow is a refusal, not a missing login: providers like Figma
	// answer registration with a bare 403 for any app not on their partner
	// allowlist (observed live: "HTTP 403: Invalid OAuth error response: …
	// Raw body: Forbidden").
	if (/HTTP 403/i.test(message)) return "refused";
	// A status the next attempt may get past, even while it looks for its sign-in.
	const status = /HTTP (\d{3})\b/.exec(message);
	if (status && isPassingStatus(Number(status[1]))) return "busy";
	// Only OAuth *discovery* coming up empty means the server has no login.
	// (Matching any "404"/"not found" here mislabeled every downstream OAuth
	// failure — including bodies that merely contain those words.)
	if (/does not implement OAuth|trying to load well-known OAuth|no authorization server/i.test(message)) return "no-sign-in";
	// Its sign-in's discovery address answered with an ordinary web page, where the sign-in's details belong.
	if (/<!DOCTYPE|<html/i.test(message)) return "no-sign-in";
	if (/timed? ?out/i.test(message)) return "too-slow";
	return "other";
}

/**
 * Reject a login attempt stuck waiting for the browser callback (typically
 * because the user closed the window). Rejecting the pending callback makes
 * the in-flight authenticate() clean up and settle, freeing the server for a
 * fresh attempt.
 */
async function cancelPendingLoginAttempt(name: string, record: { done: boolean }): Promise<void> {
	try {
		const [authStore, callbackMod] = await Promise.all([import(ADAPTER_AUTH_STORE), import(ADAPTER_CALLBACK)]);
		const oauthState = authStore.getOAuthState(name);
		if (oauthState) callbackMod.cancelPendingCallback(oauthState);
	} catch {
		// best effort — the attempt also dies on its own 5-minute timeout
	}
	const waitUntil = Date.now() + 3000;
	while (!record.done && Date.now() < waitUntil) {
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
}

export async function cancelMcpServerLogin(name: string): Promise<{ cancelled: boolean }> {
	ensureAgentDirEnv();
	const record = pendingLogins.get(name);
	if (!record || record.done) return { cancelled: false };
	await cancelPendingLoginAttempt(name, record);
	pendingLogins.delete(name);
	return { cancelled: true };
}

export async function startMcpServerLogin(name: string): Promise<{ started: boolean; pending?: boolean }> {
	ensureAgentDirEnv();
	const [configMod, authFlow] = await Promise.all([import(ADAPTER_CONFIG), import(ADAPTER_AUTH_FLOW)]);
	const entry = entryNamed(configMod.loadMcpConfig().mcpServers, name);
	if (!entry) throw new McpAdminError(CONNECTOR_REQUEST_LINES.noLongerExists, 404);
	if (!entry.url) throw new McpAdminError("Only remote (URL) connectors use OAuth login.");
	if (!authFlow.supportsOAuth(entry)) throw new McpAdminError("This connector has authentication disabled in its config.");

	const pending = pendingLogins.get(name);
	if (pending && !pending.done) {
		// A previous attempt is stuck (e.g. the browser window was closed):
		// cancel it and start fresh instead of locking the user out.
		await cancelPendingLoginAttempt(name, pending);
		if (!pending.done) {
			throw new McpAdminError(CONNECTOR_REQUEST_LINES.signInStillClosing, 409);
		}
	}
	const record: { startedAt: number; done: boolean; cause?: McpLoginFailure; detail?: string } = { startedAt: Date.now(), done: false };
	pendingLogins.set(name, record);
	// Runs the adapter's real flow: prints + opens the authorization URL in the
	// local browser and completes via the loopback callback server.
	void authFlow
		.authenticate(name, entry.url, entry)
		.then(() => {
			record.done = true;
			// What the last check said about signing in is out of date now.
			writeMcpConnectorCheck(name, null);
		})
		.catch(async (e: Error) => {
			const failure = loginFailureOf(e);
			// Where a service publishes no sign-in, the flow guesses its addresses and fails as any
			// other; asked directly, the service says it has none, which a key may stand in for.
			const cause = failure.cause === "other" && (await publishesNoSignIn(entry.url)) ? "no-sign-in" : failure.cause;
			record.cause = cause;
			record.detail = failure.detail;
			record.done = true;
		});
	return { started: true };
}

/** How long the read that asks a service whether it offers a sign-in may take, so a service that never answers can't hold the sign-in's end. */
const SIGN_IN_DISCOVERY_LIMIT_MS = 5_000;

/**
 * True only when the service answered that it publishes no sign-in: neither
 * its own sign-in details (RFC 9728) nor a sign-in server's (RFC 8414), read
 * by the SDK's discovery, with every address it asked answering. A read
 * that failed or ran out of time is not that answer.
 */
async function publishesNoSignIn(url: string): Promise<boolean> {
	// The SDK reads a request nothing answered (offline, a closed port) as a miss and moves on, so each one is noted here.
	let unanswered = false;
	const signal = AbortSignal.timeout(SIGN_IN_DISCOVERY_LIMIT_MS);
	const fetchFn = async (input: string | URL, init?: RequestInit): Promise<Response> => {
		try {
			return await fetch(input, { ...init, signal });
		} catch (error) {
			unanswered = true;
			throw error;
		}
	};
	try {
		const found = await discoverOAuthServerInfo(url, { fetchFn });
		return !unanswered && !found.resourceMetadata && !found.authorizationServerMetadata;
	} catch {
		return false;
	}
}

export function getMcpServerLoginState(name: string): { pending: boolean; cause?: McpLoginFailure; detail?: string } {
	const record = pendingLogins.get(name);
	if (!record) return { pending: false };
	return { pending: !record.done, cause: record.cause, detail: record.detail };
}

/**
 * Remove a server's entry from the metadata cache file. Must edit the file
 * directly: the adapter's saveMetadataCache() merges with what is on disk, so
 * saving a cache object with a key deleted silently resurrects the entry.
 */
async function dropMetadataCacheEntry(name: string): Promise<void> {
	try {
		const cacheMod = await import(ADAPTER_CACHE);
		const cachePath: string = cacheMod.getMetadataCachePath();
		const parsed = JSON.parse(fs.readFileSync(cachePath, "utf-8"));
		if (!entryNamed(parsed?.servers, name)) return;
		delete parsed.servers[name];
		const tmp = `${cachePath}.${process.pid}.tmp`;
		fs.writeFileSync(tmp, JSON.stringify(parsed, null, 2));
		fs.renameSync(tmp, cachePath);
	} catch {
		// cache cleanup is advisory
	}
}

export async function logoutMcpServer(name: string): Promise<void> {
	ensureAgentDirEnv();
	const authFlow = await import(ADAPTER_AUTH_FLOW);
	await authFlow.removeAuth(name);
	// A connection signed in before closes, so its conversation's end saves no entry again.
	await closeConnectorConnections(name);
	// Drop the cached tool list too: a cache entry with no stored tokens is how
	// the UI concludes "connects without a login", which would now be stale.
	await dropMetadataCacheEntry(name);
	writeMcpConnectorCheck(name, null);
}

/** Node's codes for a certificate this computer doesn't trust: self-signed, from an issuer it doesn't know, expired, or for another name. */
const UNTRUSTED_CERTIFICATE_CODES = new Set(["DEPTH_ZERO_SELF_SIGNED_CERT", "SELF_SIGNED_CERT_IN_CHAIN", "UNABLE_TO_VERIFY_LEAF_SIGNATURE", "UNABLE_TO_GET_ISSUER_CERT_LOCALLY", "CERT_HAS_EXPIRED", "ERR_TLS_CERT_ALTNAME_INVALID"]);

/**
 * One direct streamable-HTTP initialize POST to the entry's own address,
 * with its static credentials attached, following no redirect and waiting
 * 5 s at most, to recover the server's real verdict after a failed check
 * whose error carries none. Without an answer, why nothing answered when the
 * request's error code tells: nothing there, no such name, or a certificate
 * this computer doesn't trust; with an ordinary web page, that. Returns null
 * when the probe can't improve on the original error (no answer in time, or
 * the POST succeeds and the failure lies elsewhere).
 */
async function explainSseFallback(entry: {
	url?: string;
	headers?: Record<string, string>;
	auth?: "bearer" | "oauth" | false;
	bearerToken?: string;
	bearerTokenEnv?: string;
}): Promise<{ message: string; needsAuth: boolean; httpStatus: number } | { reach: ConnectorReach } | null> {
	const headers: Record<string, string> = { ...(entry.headers ?? {}) };
	// A shared server sends no variable's value as a token; a connector that names
	// one still counts as carrying a key, so a refusal keeps its own words.
	const sharedServer = process.env.EXXPERTS_SHARED_SERVER === "1";
	const tokenFromEnv = entry.bearerTokenEnv && !sharedServer ? process.env[entry.bearerTokenEnv] : undefined;
	const token = entry.auth === "bearer" ? (entry.bearerToken ?? tokenFromEnv) : undefined;
	if (token) headers.Authorization = `Bearer ${token}`;
	const hasStaticCredentials = Boolean(token) || (sharedServer && Boolean(entry.bearerTokenEnv)) || Object.keys(entry.headers ?? {}).length > 0;
	let response: Response;
	try {
		response = await fetch(String(entry.url), {
			method: "POST",
			redirect: "manual",
			headers: {
				"Content-Type": "application/json",
				Accept: "application/json, text/event-stream",
				...headers,
			},
			body: JSON.stringify({
				jsonrpc: "2.0",
				id: 0,
				method: "initialize",
				params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "exxperts-connection-test", version: "1.0" } },
			}),
			signal: AbortSignal.timeout(5000),
		});
	} catch (error) {
		// Node's fetch puts the connection's error under cause; a name with several addresses gathers one per address.
		const cause = (error as { cause?: { code?: unknown; errors?: Array<{ code?: unknown }> } } | null)?.cause;
		const code = cause?.code ?? cause?.errors?.[0]?.code;
		if (code === "ECONNREFUSED" || code === "ECONNRESET") return { reach: "nothing-there" };
		if (code === "ENOTFOUND" || code === "EAI_AGAIN") return { reach: "name-not-found" };
		if (typeof code === "string" && UNTRUSTED_CERTIFICATE_CODES.has(code)) return { reach: "untrusted-certificate" };
		return null;
	}
	try {
		const body = (await response.text()).trim();
		// For Technical details: the status and the service's own words, true for a refusal and a busy service alike.
		const answered = `HTTP ${response.status}${body ? `: ${body}` : ""}`;
		if (response.status === 401 || response.status === 403) {
			return hasStaticCredentials
				? { message: answered, needsAuth: false, httpStatus: response.status }
				: { message: `This server requires authentication (${answered}).`, needsAuth: true, httpStatus: response.status };
		}
		if (!response.ok) return { message: answered, needsAuth: false, httpStatus: response.status };
		// An ordinary web page where a connector should answer: the address leads somewhere else.
		if (/^text\/html\b/i.test(response.headers.get("content-type") ?? "")) return { reach: "web-page" };
		return null;
	} catch {
		return null;
	}
}

export interface McpServerTestResult {
	ok: boolean;
	toolCount?: number;
	toolNames?: string[];
	needsAuth?: boolean;
	error?: string;
	/** The status the address answered with, when the test learned it; the page words its next step from it. */
	httpStatus?: number;
	/** Why nothing answered, when the test could tell. */
	reach?: ConnectorReach;
	/** The connector changed while it was checked (a new address or key): this result is not about it any more, and nothing of it was kept. */
	superseded?: true;
	/** The program did not start, because this room can change files where it runs from. Kept as no check: the status says it while it holds. */
	startRefused?: ConnectorStartRefusal;
	/** Why a program didn't start, when the check could tell. */
	programFailure?: ProgramStartFailure;
	/** The person stopped the check: nothing of it was kept. */
	cancelled?: true;
}

const PROGRAM_DETAILS_LENGTH = 4000;

/** What the adapter's patched start puts on the error of a program that didn't start (scripts/patch-mcp-adapter.mjs, patch 14). */
interface ProgramWatch {
	output: string[];
	otherOutput: boolean;
}

/**
 * A program's failed start, read once: why, by the error's own code and what
 * the program wrote, and its last lines for Technical details. A runtime
 * (Node.js, uv) is said to be missing only when its own program isn't along
 * the PATH the program started with (its own setting as the start fills it in,
 * else the search path, with the server's PATH as it was then), read from its working folder; a Python named by one
 * name, only when the other is found there. Null for a failure that is none of
 * these. On Windows a program that isn't there is started through cmd.exe, which
 * starts and ends at once, so no error says it isn't there: a start that ended
 * asks for its program along that same path, `cmd /c`'s own program included.
 */
function programFailureOf(error: unknown, start: { command: string; args: readonly unknown[]; path: string | undefined; serverPath: string | undefined; cwd: string | undefined }, platform: NodeJS.Platform): { failure: ProgramStartFailure | null; details: string } {
	const e = error as { code?: unknown; syscall?: unknown; path?: unknown; message?: unknown; connectorProgram?: ProgramWatch } | null;
	const watch = e?.connectorProgram;
	const message = typeof e?.message === "string" ? e.message : String(error);
	const details = [message, ...(watch?.output ?? [])].join("\n");
	const shown = details.length > PROGRAM_DETAILS_LENGTH ? `…${details.slice(-PROGRAM_DETAILS_LENGTH)}` : details;
	const notFound = e?.code === "ENOENT" && typeof e.syscall === "string" && e.syscall.startsWith("spawn") && typeof e.path === "string";
	const startPath = start.path ?? connectorSearchPath(start.serverPath) ?? start.serverPath ?? "";
	// Windows takes a PATH folder in quotes without them.
	const searchPath = platform === "win32" ? startPath.replaceAll('"', "") : startPath;
	const cwd = start.cwd ?? process.cwd();
	const found = (program: string) => programFile(program, cwd, searchPath, platform) !== null;
	const gone = (program: string) => (platform === "win32" ? programMissingOnWindows(program, cwd, searchPath) : !found(program));
	// The SDK's codes: -32000 the connection closed, -32001 a request timed out.
	const endedOnWindows = platform === "win32" && e?.code === -32000 && !watch?.otherOutput;
	// cmd.exe may end a path at any of its spaces, so each such reading must be gone too.
	const readings = (program: string) => program.split(" ").map((_, at, words) => words.slice(0, at + 1).join(" "));
	const behindCmd = programBehindCmd(start.command, start.args);
	const goneOnWindows = () => (gone(start.command) ? start.command : behindCmd !== null && readings(behindCmd).every(gone) ? behindCmd : null);
	const missing = notFound ? String(e.path) : endedOnWindows ? goneOnWindows() : null;
	const runtime = missing === null ? null : runtimeOf(missing);
	const python = missing === null ? null : pythonNameOf(missing);
	const otherPython = PYTHON_NAMES.find((name) => name !== python);
	const failure: ProgramStartFailure | null = missing !== null
		? runtime && gone(runtime.shownBy)
			? { cause: "runtime-missing", runtime: runtime.runtime }
			: python && otherPython && found(otherPython)
				? { cause: "python-is-python3", found: otherPython }
				: { cause: "not-found", program: missing }
		: watch?.otherOutput
			? { cause: "not-a-connector" }
			: e?.code === -32001
				? { cause: "too-slow" }
				: e?.code === -32000
					? { cause: "stopped" }
					: null;
	return { failure, details: shown };
}

/** The failures a program installed meanwhile ends: the start found no program, or Python only by its other name. */
const PROGRAM_NOT_THERE: ReadonlySet<ProgramStartFailure["cause"]> = new Set(["runtime-missing", "not-found", "python-is-python3"]);

/**
 * signal: the person stopped the check (the page closed its request); the program stops and nothing is kept. platform: how a failed start is read.
 * On Windows, and only there, a check that found no program asks for Windows' search path and tries once more when the one it would now start with
 * has changed, whichever check added to it.
 */
export async function testMcpServer(name: string, signal?: AbortSignal, platform: NodeJS.Platform = process.platform, rereadSearchPath: () => Promise<void> = rereadWindowsSearchPath): Promise<McpServerTestResult> {
	return checkMcpServer(name, signal, platform, platform === "win32" ? rereadSearchPath : null);
}

/** One try, or two where `rereadSearchPath` is given: the first keeps nothing when a second follows. */
async function checkMcpServer(name: string, signal: AbortSignal | undefined, platform: NodeJS.Platform, rereadSearchPath: (() => Promise<void>) | null): Promise<McpServerTestResult> {
	ensureAgentDirEnv();
	installConnectorStartCheck();
	const [configMod, managerMod, cacheMod, utilsMod] = await Promise.all([
		import(ADAPTER_CONFIG),
		import(ADAPTER_SERVER_MANAGER),
		import(ADAPTER_CACHE),
		import(ADAPTER_UTILS),
	]);
	const config = configMod.loadMcpConfig();
	const entry = entryNamed(config.mcpServers, name);
	if (!entry) throw new McpAdminError(CONNECTOR_REQUEST_LINES.noLongerExists, 404);
	// A check describes the entry it ran against. One the person changed meanwhile keeps nothing of it.
	const unchanged = () => JSON.stringify(entryNamed(configMod.loadMcpConfig().mcpServers, name)) === JSON.stringify(entry);

	const manager = new managerMod.McpServerManager();
	// A connector lists here what it lists to a room.
	declareRoomAbilities(manager, config.settings);
	const program = typeof entry.command === "string";
	const ownPath = (): string | undefined => {
		const own: unknown = utilsMod.interpolateEnvRecord(entry.env)?.PATH;
		return typeof own === "string" ? own : undefined;
	};
	// This try's own: another check may add to the server's PATH while it runs.
	const startedWith = { own: program ? ownPath() : undefined, server: process.env.PATH };
	let outOfTime = false;
	try {
		// A program's limits are the adapter's own (its first answer, an install before it), so a stop or a limit ends the program too.
		const connection = program
			? await manager.connect(name, entry, { timeout: programAnswerLimitMs(entry.command), signal })
			: await Promise.race([
					manager.connect(name, entry),
					new Promise<never>((_, reject) => setTimeout(() => {
						outOfTime = true;
						reject(new Error("Connection timed out after 20s."));
					}, 20_000)),
				]);
		// Stopped after it answered, while its tools were listed: nothing is kept either.
		if (signal?.aborted) return { ok: false, cancelled: true };
		const toolNames = (connection.tools ?? []).map((tool: { name: string }) => tool.name);
		if (!unchanged()) return { ok: true, toolCount: toolNames.length, toolNames, superseded: true };
		// Refresh the metadata cache so the Connectors page lists the tools, each with its title and marks.
		try {
			const cache = cacheMod.loadMetadataCache() ?? { version: 1, servers: {} };
			// The connector's own instructions, cut at 4,096 characters as Claude Code cuts them.
			const instructions = connection.client?.getInstructions?.();
			cache.servers[name] = {
				configHash: cacheMod.computeServerHash(entry),
				tools: cacheMod.serializeTools(connection.tools ?? []),
				resources: cacheMod.serializeResources(connection.resources ?? []),
				...(typeof instructions === "string" && instructions ? { instructions: instructions.slice(0, 4096) } : {}),
				cachedAt: Date.now(),
			};
			cacheMod.saveMetadataCache(cache);
		} catch {
			// cache refresh is best-effort
		}
		writeMcpConnectorCheck(name, { at: Date.now(), ok: true });
		return { ok: true, toolCount: toolNames.length, toolNames };
	} catch (e) {
		const startRefused = startRefusalOf(e);
		if (startRefused) return { ok: false, error: (e as Error).message, startRefused, ...(unchanged() ? {} : { superseded: true as const }) };
		if (signal?.aborted) return { ok: false, cancelled: true };
		if (program) {
			const { failure, details } = programFailureOf(e, { command: entry.command, args: entry.args ?? [], path: startedWith.own, serverPath: startedWith.server, cwd: utilsMod.resolveConfigPath(entry.cwd) }, platform);
			if (rereadSearchPath && failure && PROGRAM_NOT_THERE.has(failure.cause) && unchanged()) {
				const changed = () => (ownPath() ?? process.env.PATH) !== (startedWith.own ?? startedWith.server);
				if (!changed()) await rereadSearchPath();
				if (signal?.aborted) return { ok: false, cancelled: true };
				if (changed() && unchanged()) return await checkMcpServer(name, signal, platform, null);
			}
			const programFailure = failure ? { programFailure: failure } : {};
			if (!unchanged()) return { ok: false, error: details, ...programFailure, superseded: true };
			writeMcpConnectorCheck(name, { at: Date.now(), ok: false, error: details, ...programFailure });
			return { ok: false, error: details, ...programFailure };
		}
		let message = (e as Error).message ?? String(e);
		let needsAuth = /unauthorized|401|needs-auth|oauth|authentication required/i.test(message);
		let httpStatus: number | undefined;
		let reach: ConnectorReach | undefined;
		// The adapter's error seldom carries the server's answer: it probes
		// streamable HTTP first and, when that probe dies mid-OAuth (Figma
		// refusing client registration, for example), silently falls back to
		// legacy SSE, whose GET then fails with a status code that has nothing
		// to do with the real problem ("SSE error: Non-200 status code (405)"),
		// and a refused sign-in can end with no words at all. Ask the server
		// directly what it thinks of a plain streamable POST and report that
		// answer instead, unless it already had the whole 20 s to answer.
		if (!outOfTime && typeof entry.url === "string") {
			const explained = await explainSseFallback(openedConnectorEntry(name, entry));
			// The direct request carries no sign-in, so for a connector signed in, the connection's own answer wins
			// when it is one that isn't about the sign-in. A 405 is the older transport's, after a refused sign-in.
			const code = (e as { code?: unknown } | null)?.code;
			const signedAnswer = typeof code === "number" && code >= 400 && code < 600 && ![401, 403, 405].includes(code) ? code : undefined;
			const refusedUnsigned = explained && "httpStatus" in explained && (explained.httpStatus === 401 || explained.httpStatus === 403) && signedAnswer !== undefined && (await import(ADAPTER_AUTH_STORE)).hasStoredTokens(name);
			if (refusedUnsigned) httpStatus = signedAnswer;
			// Nothing answering at the address: no sign-in to make, whatever the error's words held.
			if (explained && "reach" in explained) {
				reach = explained.reach;
				needsAuth = false;
			} else if (explained && !refusedUnsigned) ({ message, needsAuth, httpStatus } = explained);
		}
		const error = trimTransportError(message);
		const answered = { ...(httpStatus === undefined ? {} : { httpStatus }), ...(reach ? { reach } : {}) };
		if (!unchanged()) return { ok: false, error, needsAuth, ...answered, superseded: true };
		if (needsAuth) {
			// A stale tool cache would keep the UI claiming "no login needed";
			// this connection attempt just proved otherwise.
			await dropMetadataCacheEntry(name);
		}
		writeMcpConnectorCheck(name, { at: Date.now(), ok: false, error, ...(needsAuth ? { needsAuth } : {}), ...answered });
		return { ok: false, error, needsAuth, ...answered };
	} finally {
		try {
			await manager.closeAll();
		} catch {
			// already closed / never opened
		}
	}
}

export interface ChangeMcpServerAddressInput {
	url?: unknown;
	/** The key for the new address: needed on another site when the connector had one, or to replace it. */
	key?: unknown;
}

/**
 * The new key as the header it replaces carries it: an Authorization header's
 * scheme word ("Bearer ") stays in front, unless the typed key brings its own.
 * One a lost storage key emptied lost its scheme word with its value, so it
 * gets the usual one, Bearer. Any other header takes the key as typed.
 */
function keyAsHeaderValue(header: string, old: string, typed: string, emptied: boolean): string {
	if (header.toLowerCase() !== "authorization") return typed;
	const scheme = emptied ? "Bearer" : /^([A-Za-z][\w-]*)\s+\S/.exec(old)?.[1];
	return scheme && !/^[A-Za-z][\w-]*\s+\S/.test(typed) ? `${scheme} ${typed}` : typed;
}

/**
 * Change a web connector's address, its key, or both; one added without a
 * key can be given one, kept as Add keeps it. Its fixed name stays,
 * so every room keeps its access. On the same site (scheme, host and port) the
 * saved sign-in and key stay too. On another site they would go to whoever
 * answers there, so the sign-in and the key are dropped, and the key is asked
 * for again when there was one; a connector that would lose more (its own
 * sign-in app, a header that isn't its key) is refused instead. The cached
 * tools and the last check are dropped either way: they described the old
 * address. A new address takes back every room's yes to its tools: they were
 * given for the old one.
 */
export async function changeMcpServerAddress(name: string, input: ChangeMcpServerAddressInput): Promise<{ name: string; sameSite: boolean }> {
	ensureAgentDirEnv();
	const configMod = await import(ADAPTER_CONFIG);
	if (!entryNamed(configMod.loadMcpConfig().mcpServers, name)) throw new McpAdminError(CONNECTOR_REQUEST_LINES.noLongerExists, 404);
	const file: string = configMod.getPiGlobalConfigPath();
	let raw: Record<string, unknown> = {};
	try {
		raw = JSON.parse(fs.readFileSync(file, "utf-8"));
	} catch {
		// no file of our own: the connector comes from another app's file
	}
	const key = mcpServersKeyOf(raw);
	const stored = key ? (entryNamed(raw[key] as Record<string, ServerEntryShape & { bearerTokenEnv?: string }>, name) ?? null) : null;
	if (!stored) throw new McpAdminError(CONNECTOR_FORM_LINES.addressNotChangeable, 409);
	const own = openedConnectorEntry(name, stored);
	// One whose address and key a lost storage key emptied moves to another site: its address and key are given again.
	const emptied = isSharedServer() && connectorAddressGone(own);
	if (typeof own.url !== "string" && !emptied) throw new McpAdminError("Only a connector with a web address can change its address here.");
	const address = readConnectorAddress(String(input.url ?? ""));
	if ("error" in address) throw new McpAdminError(address.error);
	const newKey = String(input.key ?? "").trim();
	const sameSite = typeof own.url === "string" && sameConnectorSite(own.url, address.url);
	const keyPlace = connectorKeyOf(own);
	const keyHeaders = Object.keys(own.headers ?? {}).filter(isCredentialHeaderName);
	const next: ServerEntryShape & { bearerTokenEnv?: string } = { ...own, url: address.url };
	if (!sameSite && !movesToAnotherSite(own)) throw new McpAdminError(CONNECTOR_FORM_LINES.cantMoveSite);
	// A first key, for one added without, as Add would take it: on this computer only, never beside its own sign-in app.
	// A shared server refuses one as before; what a first key means there for who may use it is not decided here.
	if (newKey && (keyPlace === "fixed" || (keyPlace === "none" && isSharedServer()))) throw new McpAdminError(CONNECTOR_FORM_LINES.keyNotChangeable);
	if (newKey && keyPlace === "none" && hasOwnSignInApp(own)) throw new McpAdminError(CONNECTOR_FORM_LINES.keyAndSignInApp);
	if (!sameSite) {
		if (keyPlace !== "none" && !newKey) throw new McpAdminError(CONNECTOR_FORM_LINES.anotherSiteKey);
		// Sign-in switched off on purpose stays off; switched off only because a key header was the sign-in, it goes with the key.
		if (!(own.auth === false && keyHeaders.length === 0)) delete next.auth;
		delete next.bearerToken;
		delete next.bearerTokenEnv;
		delete next.oauth;
		// Its only headers are its key, which comes back below with the new one.
		delete next.headers;
	}
	if (newKey) {
		// The key goes where the connector kept it: its one key header, else the bearer token, where Add puts a key.
		if (keyHeaders.length === 1) {
			const header = keyHeaders[0];
			next.headers = validateHeaders({ ...(next.headers ?? {}), [header]: keyAsHeaderValue(header, own.headers?.[header] ?? "", newKey, emptied) }, false);
			// A new key in the same header changes nothing else: the sign-in stays as the connector had it.
			if (own.auth === undefined) delete next.auth;
			else next.auth = own.auth;
		} else {
			next.auth = "bearer";
			next.bearerToken = newKey;
			delete next.bearerTokenEnv;
		}
	}
	const refusal = serverHooks().connectorEntryRefusal?.(next, address.url === own.url ? undefined : name);
	if (refusal) throw new McpAdminError(refusal);
	// Before the new address is written, so a failure between the two leaves rooms asking, never a yes for the new address;
	// and before the sign-in goes, so a rooms folder that can't be listed stops the change with nothing dropped.
	// A shared server keeps no yes, so it reads no room's file here.
	if (address.url !== own.url && !isSharedServer()) {
		for (const failure of forgetMcpConnectorToolsInAllRooms(name).failures) console.warn(`connector address change: taking back the room's yeses failed in ${failure.agentId}: ${failure.error}`);
		// Its Always allows were given for the old address; the gate stops honouring them there anyway, by their pin.
		try {
			forgetConnectorToolChoices(name, "allow");
		} catch (error) {
			console.warn(`connector address change: taking back its Always allows failed: ${(error as Error).message}`);
		}
	}
	if (!sameSite) {
		// The old site's sign-in goes before the new address is written, so a
		// failure here leaves the old address, never the old sign-in on the new
		// one. A sign-in still running would save its result for the old site.
		await cancelMcpServerLogin(name);
		const authFlow = await import(ADAPTER_AUTH_FLOW);
		await authFlow.removeAuth(name);
	}
	writeOwnConnectorEntry(file, name, sealedConnectorEntry(name, next, stored));
	if (sameSite) {
		// The adapter keeps a sign-in for the exact address it was made at and
		// ignores it once the address differs, so the kept sign-in moves along.
		const authStore = await import(ADAPTER_AUTH_STORE);
		const saved = authStore.getAuthEntry(name);
		if (saved?.serverUrl === own.url) authStore.saveAuthEntry(name, saved, address.url);
	}
	// A connection to the old address closes, so its conversation's end saves no entry for it.
	await closeConnectorConnections(name);
	await dropMetadataCacheEntry(name);
	writeMcpConnectorCheck(name, null);
	return { name, sameSite };
}

export interface SetMcpServerToolChoicesInput {
	/** Each tool's new choice by its own name, or null to clear it. */
	tools?: unknown;
	/** The connector as the page showed it (its status `identity`): needed to set Always allow. */
	identity?: unknown;
}

/** The tools a connector's saved list marks read-only now, by the gate's rule; none when it has no valid list. */
async function savedReadOnlyTools(name: string, entry: Record<string, unknown>): Promise<Set<string>> {
	const cacheMod = await import(ADAPTER_CACHE);
	const saved = cacheMod.loadMetadataCache()?.servers?.[name];
	if (!saved || !cacheMod.isServerCacheValid(saved, entry)) return new Set();
	return new Set((saved.tools ?? []).filter(savedToolReadOnly).map((tool: { name: string }) => tool.name));
}

/**
 * Sets or clears (null) the person's choice for some of a connector's tools,
 * from its page. Always allow is pinned to where the connector is, and is set
 * only for the connector the page showed: one that changed since is refused
 * (409), and the page reads it again. A pick takes back that tool's old room
 * yeses in every room; the gate ignores them once a choice is stored, so a
 * room that can't be written is only logged. Answers the connector's choices.
 */
export async function setMcpServerToolChoices(name: string, input: SetMcpServerToolChoicesInput): Promise<{ name: string; choices: Record<string, ConnectorToolChoice> }> {
	ensureAgentDirEnv();
	const configMod = await import(ADAPTER_CONFIG);
	const entry = entryNamed(configMod.loadMcpConfig().mcpServers as Record<string, Record<string, unknown>>, name);
	if (!entry) throw new McpAdminError(CONNECTOR_REQUEST_LINES.noLongerExists, 404);
	const raw = input.tools;
	const asked = raw && typeof raw === "object" && !Array.isArray(raw) ? Object.entries(raw as Record<string, unknown>) : [];
	if (asked.length === 0 || asked.some(([tool, choice]) => !isToolChoiceName(tool) || (choice !== null && !isConnectorToolChoice(choice)))) throw new McpAdminError(CONNECTOR_REQUEST_LINES.saveFailed);
	const pin = connectorPin(entry);
	if (asked.some(([, choice]) => choice === "allow") && input.identity !== pin) throw new McpAdminError(CONNECTOR_REQUEST_LINES.toolsChanged, 409);
	const readOnly = await savedReadOnlyTools(name, entry);
	const changes: Record<string, StoredToolChoice | null> = Object.fromEntries(asked.map(([tool, choice]) => [tool, isConnectorToolChoice(choice) ? { choice, ...(choice === "allow" ? { where: pin, ...(readOnly.has(tool) ? { readOnly: true as const } : {}) } : {}) } : null]));
	let after: ConnectorToolChoices;
	try {
		after = setConnectorToolChoices(name, changes);
	} catch (error) {
		console.warn(`connector tool choices: saving failed: ${(error as Error).message}`);
		throw new McpAdminError(CONNECTOR_REQUEST_LINES.saveFailed, 500);
	}
	const picked = asked.filter(([, choice]) => choice !== null).map(([tool]) => tool);
	if (picked.length > 0) {
		// The choice is saved: a rooms folder that can't be listed leaves the old yeses, which the gate ignores, and the answer says saved.
		try {
			for (const failure of forgetMcpConnectorToolYesesInAllRooms(name, picked).failures) console.warn(`connector tool choices: taking back the room's yeses failed in ${failure.agentId}: ${failure.error}`);
		} catch (error) {
			console.warn(`connector tool choices: taking back the room's yeses failed: ${(error as Error).message}`);
		}
	}
	return { name, choices: toolChoicesShown(after) };
}

/**
 * Reset choices, from the connector's page: a choices file that can't be read
 * is set aside beside itself under another name, never deleted, and every
 * tool of every connector goes back to its default. Refused when the file can
 * be read again, when a newer version wrote it (updating the app reads it),
 * and on a shared server, which keeps no choices.
 */
export function resetMcpToolChoices(): { reset: true } {
	if (isSharedServer()) throw new McpAdminError("Not found.", 404);
	let outcome: ReturnType<typeof setUnreadableToolChoicesAside>;
	try {
		outcome = setUnreadableToolChoicesAside();
	} catch (error) {
		console.warn(`connector tool choices: setting the unreadable file aside failed: ${(error as Error).message}`);
		throw new McpAdminError(CONNECTOR_REQUEST_LINES.choicesResetFailed, 500);
	}
	if (outcome === "readable") throw new McpAdminError(CONNECTOR_REQUEST_LINES.choicesReadableAgain, 409);
	if (outcome === "newer") throw new McpAdminError(CONNECTOR_REQUEST_LINES.choicesFromNewerVersion, 409);
	return { reset: true };
}
