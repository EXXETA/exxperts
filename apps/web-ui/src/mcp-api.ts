import { redirectToSignInOn401 } from "./api";
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
	cachedAt: number;
}

export interface McpConnectorStatus {
	name: string;
	transport: "http" | "stdio";
	target: string;
	source: { path: string; kind: string; importKind?: string } | null;
	auth: McpConnectorAuthStatus;
	tools: McpConnectorToolsStatus | null;
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

async function fetchJson<T>(input: string, init: RequestInit | undefined, fallbackError: string): Promise<T> {
	const response = await fetch(input, init);
	redirectToSignInOn401(response);
	let payload: unknown = null;
	try {
		payload = await response.json();
	} catch {
		// non-JSON body — fall through to the fallback error
	}
	if (!response.ok) {
		const error = (payload as { error?: unknown } | null)?.error;
		throw new Error(typeof error === "string" && error.trim() ? error.trim() : fallbackError);
	}
	return payload as T;
}

export function fetchMcpConnectorsStatus(): Promise<McpConnectorsStatusResponse> {
	return fetchJson("/api/mcp/status", undefined, "Failed to load connector status.");
}

export interface AddMcpServerRequest {
	name: string;
	url?: string;
	command?: string;
	args?: string[];
	bearerToken?: string;
	oauth?: { clientId: string; clientSecret?: string; scope?: string };
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

export function startMcpServerLogin(name: string): Promise<{ started: boolean; pending?: boolean }> {
	return fetchJson(`/api/mcp/servers/${encodeURIComponent(name)}/login`, { method: "POST" }, "Failed to start the login.");
}

export function fetchMcpServerLoginState(name: string): Promise<{ pending: boolean; error?: string }> {
	return fetchJson(`/api/mcp/servers/${encodeURIComponent(name)}/login`, undefined, "Failed to check the login.");
}

export function cancelMcpServerLogin(name: string): Promise<{ cancelled: boolean }> {
	return fetchJson(`/api/mcp/servers/${encodeURIComponent(name)}/login`, { method: "DELETE" }, "Failed to cancel the login.");
}

export function logoutMcpServer(name: string): Promise<{ ok: boolean }> {
	return fetchJson(`/api/mcp/servers/${encodeURIComponent(name)}/logout`, { method: "POST" }, "Failed to clear the login.");
}

export interface McpServerTestResult {
	ok: boolean;
	toolCount?: number;
	toolNames?: string[];
	needsAuth?: boolean;
	error?: string;
}

export function testMcpServer(name: string): Promise<McpServerTestResult> {
	return fetchJson(`/api/mcp/servers/${encodeURIComponent(name)}/test`, { method: "POST" }, "Failed to test the connector.");
}
