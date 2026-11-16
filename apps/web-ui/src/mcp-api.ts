import { apiFetch } from "./api";
import { CONNECTOR_REQUEST_LINES } from "../../web-server/src/connector-form";
import type { ConnectorKey } from "../../web-server/src/connector-form";
export interface McpConnectorAuthStatus {
	mode: "oauth" | "bearer" | "none";
	// Entry explicitly configures OAuth (custom client) — a login is expected
	// even when the server lists tools unauthenticated.
	explicit?: boolean;
	hasStoredTokens: boolean;
	tokenExpired: boolean | null;
	hasRefreshToken: boolean;
}

export interface McpConnectorToolsStatus {
	count: number;
	names: string[];
	/** A tool's own title, by its name, when the connector gave one. */
	titles: Record<string, string>;
	cachedAt: number;
}

/** What the last connection check found. */
export interface McpConnectorCheck {
	at: number;
	ok: boolean;
	needsAuth?: boolean;
	httpStatus?: number;
	/** The server's own words, for Technical details. */
	error?: string;
	/** A Test on this page found the program can't start; the server keeps no check of it. */
	startRefused?: ConnectorStartRefusal;
}

/** The room that can change files where a connector program runs from, so the program doesn't start. */
export interface ConnectorStartRefusal {
	roomId: string;
	roomName: string;
}

/** A room that may use a connector. */
export interface McpConnectorRoomUse {
	id: string;
	name: string;
}

export interface McpConnectorStatus {
	name: string;
	transport: "http" | "stdio";
	target: string;
	/** importFile: the other tool's own file an imported connector is read from; Remove cannot remove it here. */
	source: { path: string; kind: string; importKind?: string; importFile?: string } | null;
	auth: McpConnectorAuthStatus;
	tools: McpConnectorToolsStatus | null;
	/** The name the person typed, when it differs from the fixed name. */
	displayName?: string;
	/** A web connector added here, whose address can be changed here. */
	editable: boolean;
	/** Where its key is, as Change key sees it. */
	key: ConnectorKey;
	/** Whether a new address on another site leaves it whole. */
	movesToAnotherSite: boolean;
	/** Named in a file other apps read too; Remove deletes it there as well. */
	inSharedFile?: true;
	/** The rooms that may use it; null where the server does not say. */
	usedIn: McpConnectorRoomUse[] | null;
	lastCheck: McpConnectorCheck | null;
	/** A program that would not start now, because this room can change files where it runs from. */
	startRefused?: ConnectorStartRefusal;
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

/** A connector request the server refused, with its status: 404 says the connector no longer exists. */
export class McpRequestError extends Error {
	constructor(
		message: string,
		readonly status: number,
	) {
		super(message);
	}
}

async function fetchJson<T>(input: string, init: RequestInit | undefined, fallbackError: string): Promise<T> {
	const response = await apiFetch(input, init);
	let payload: unknown = null;
	try {
		payload = await response.json();
	} catch {
		// non-JSON body — fall through to the fallback error
	}
	if (!response.ok) {
		const error = (payload as { error?: unknown } | null)?.error;
		throw new McpRequestError(typeof error === "string" && error.trim() ? error.trim() : fallbackError, response.status);
	}
	return payload as T;
}

export function fetchMcpConnectorsStatus(): Promise<McpConnectorsStatusResponse> {
	return fetchJson("/api/mcp/status", undefined, CONNECTOR_REQUEST_LINES.loadFailed);
}

export interface AddMcpServerRequest {
	name: string;
	url?: string;
	command?: string;
	args?: string[];
	bearerToken?: string;
	oauth?: { clientId: string; clientSecret?: string; scope?: string };
	/** Extra headers sent with every request, such as a key in a header of its own. */
	headers?: Record<string, string>;
}

export function addMcpServer(request: AddMcpServerRequest): Promise<{ name: string; path: string }> {
	return fetchJson("/api/mcp/servers", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(request),
	}, "Failed to add the connector.");
}

export function removeMcpServer(name: string): Promise<{ name: string; removedFrom: string[] }> {
	return fetchJson(`/api/mcp/servers/${encodeURIComponent(name)}`, { method: "DELETE" }, "Failed to remove the connector.");
}

export function changeMcpServerAddress(name: string, request: { url: string; key?: string }): Promise<{ name: string; sameSite: boolean }> {
	return fetchJson(`/api/mcp/servers/${encodeURIComponent(name)}/address`, {
		method: "PUT",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(request),
	}, CONNECTOR_REQUEST_LINES.saveFailed);
}

export function startMcpServerLogin(name: string): Promise<{ started: boolean; pending?: boolean }> {
	return fetchJson(`/api/mcp/servers/${encodeURIComponent(name)}/login`, { method: "POST" }, CONNECTOR_REQUEST_LINES.signInStartFailed);
}

/** Why a sign-in failed: only "busy", "too-slow" and "other" may get past it on a second try. */
export type McpLoginFailure = "needs-own-app" | "refused" | "busy" | "no-sign-in" | "too-slow" | "other";

export function fetchMcpServerLoginState(name: string): Promise<{ pending: boolean; cause?: McpLoginFailure; detail?: string }> {
	return fetchJson(`/api/mcp/servers/${encodeURIComponent(name)}/login`, undefined, CONNECTOR_REQUEST_LINES.signInCheckFailed);
}

export function cancelMcpServerLogin(name: string): Promise<{ cancelled: boolean }> {
	return fetchJson(`/api/mcp/servers/${encodeURIComponent(name)}/login`, { method: "DELETE" }, "Failed to cancel the login.");
}

export function logoutMcpServer(name: string): Promise<{ ok: boolean }> {
	return fetchJson(`/api/mcp/servers/${encodeURIComponent(name)}/logout`, { method: "POST" }, CONNECTOR_REQUEST_LINES.disconnectFailed);
}

export interface McpServerTestResult {
	ok: boolean;
	toolCount?: number;
	toolNames?: string[];
	needsAuth?: boolean;
	error?: string;
	/** The status the address answered with, when the test learned it. */
	httpStatus?: number;
	/** The connector changed while it was checked: the result is not about it any more. */
	superseded?: true;
	/** The program did not start, because this room can change files where it runs from. */
	startRefused?: ConnectorStartRefusal;
}

export function testMcpServer(name: string): Promise<McpServerTestResult> {
	return fetchJson(`/api/mcp/servers/${encodeURIComponent(name)}/test`, { method: "POST" }, "Failed to test the connector.");
}
