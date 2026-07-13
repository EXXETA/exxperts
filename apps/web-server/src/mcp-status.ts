/**
 * Read-only MCP connector status for the web UI.
 *
 * Reuses pi-mcp-adapter's own config/auth/cache readers so the web UI reports
 * exactly what room sessions will see: the merged server list across the four
 * config locations, which file each server came from, OAuth credential state,
 * and cached tool metadata. Live connection state lives inside running agent
 * sessions and is intentionally not reported here.
 */

import os from "node:os";
import path from "node:path";

// Non-literal specifiers so tsc never resolves into the adapter's raw .ts
// sources (same pattern as pi-package/extensions/mcp/index.ts).
const ADAPTER_CONFIG = "pi-mcp-adapter/config.ts" as string;
const ADAPTER_AUTH = "pi-mcp-adapter/mcp-auth.ts" as string;
const ADAPTER_CACHE = "pi-mcp-adapter/metadata-cache.ts" as string;

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

function ensureAgentDirEnv(): void {
	// The adapter resolves its agent-global config dir from PI_CODING_AGENT_DIR
	// (defaulting to ~/.pi/agent); point it at the exxperts agent dir, matching
	// what the mcp extension does inside room sessions.
	if (!process.env.PI_CODING_AGENT_DIR) {
		process.env.PI_CODING_AGENT_DIR = path.join(os.homedir(), ".exxperts", "agent");
	}
}

function tildePath(p: string): string {
	const home = os.homedir();
	return p.startsWith(home) ? `~${p.slice(home.length)}` : p;
}

function authModeFor(entry: {
	url?: string;
	auth?: "oauth" | "bearer" | false;
	bearerToken?: string;
	bearerTokenEnv?: string;
	oauth?: unknown;
}): McpConnectorAuthStatus["mode"] {
	if (entry.auth === "bearer" || entry.bearerToken || entry.bearerTokenEnv) return "bearer";
	// Mirrors the adapter's supportsOAuth: HTTP servers auto-detect OAuth
	// unless auth/oauth is explicitly disabled.
	if (entry.url && entry.auth !== false && entry.oauth !== false) return "oauth";
	return "none";
}

export async function getMcpConnectorsStatus(): Promise<McpConnectorsStatusResponse> {
	ensureAgentDirEnv();
	const [configMod, authMod, cacheMod] = await Promise.all([
		import(ADAPTER_CONFIG),
		import(ADAPTER_AUTH),
		import(ADAPTER_CACHE),
	]);

	const summary = configMod.getMcpDiscoverySummary();
	const config = configMod.loadMcpConfig();
	const provenance: Map<string, { path: string; kind: string; importKind?: string }> = configMod.getServerProvenance();
	const cache = cacheMod.loadMetadataCache();

	const servers: McpConnectorStatus[] = Object.entries(config.mcpServers ?? {}).map(([name, rawEntry]) => {
		const entry = rawEntry as {
			url?: string;
			command?: string;
			args?: string[];
			auth?: "oauth" | "bearer" | false;
			bearerToken?: string;
			bearerTokenEnv?: string;
			oauth?: unknown;
		};
		const mode = authModeFor(entry);
		const source = provenance.get(name);
		const cacheEntry = cache?.servers?.[name];
		const cacheValid = cacheEntry ? cacheMod.isServerCacheValid(cacheEntry, entry) : false;
		return {
			name,
			transport: entry.url ? "http" : "stdio",
			target: entry.url ?? [entry.command ?? "", ...(entry.args ?? [])].join(" ").trim(),
			source: source ? { path: tildePath(source.path), kind: source.kind, importKind: source.importKind } : null,
			auth: {
				mode,
				explicit: mode === "oauth" && (entry.auth === "oauth" || (typeof entry.oauth === "object" && entry.oauth !== null)),
				hasStoredTokens: mode === "oauth" ? Boolean(authMod.hasStoredTokens(name)) : false,
				tokenExpired: mode === "oauth" ? (authMod.isTokenExpired(name) as boolean | null) : null,
				hasRefreshToken: mode === "oauth" ? Boolean(authMod.getAuthEntry(name)?.tokens?.refreshToken) : false,
			},
			tools: cacheValid
				? {
						count: cacheEntry.tools?.length ?? 0,
						names: (cacheEntry.tools ?? []).map((tool: { name: string }) => tool.name),
						cachedAt: cacheEntry.cachedAt,
					}
				: null,
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
