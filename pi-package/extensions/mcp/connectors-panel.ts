/**
 * exxperts connectors panel — the CLI face of /mcp.
 *
 * Our own surface over pi-mcp-adapter used as a library (config, auth store,
 * metadata cache, server manager): the same building blocks and the same
 * status language as the web Connectors page. exxperts rooms always reach
 * connectors through the single `mcp` proxy tool, so this panel manages
 * servers, logins, and connection tests — there is no tool pinning.
 *
 * State is read from disk (like the web page), so what it shows is the
 * product truth: what rooms get the next time they are entered. When the
 * on-disk config differs from what this session loaded, the panel says so.
 */

import { matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { CONNECTOR_CATALOG, type ConnectorCatalogEntry } from "./connector-catalog";

// Non-literal specifiers keep tsc from resolving the adapter's raw .ts
// sources (same pattern as apps/web-server/src/mcp-*.ts and index.ts).
const ADAPTER_CONFIG = "pi-mcp-adapter/config.ts" as string;
const ADAPTER_AUTH_STORE = "pi-mcp-adapter/mcp-auth.ts" as string;
const ADAPTER_AUTH_FLOW = "pi-mcp-adapter/mcp-auth-flow.ts" as string;
const ADAPTER_CALLBACK = "pi-mcp-adapter/mcp-callback-server.ts" as string;
const ADAPTER_MANAGER = "pi-mcp-adapter/server-manager.ts" as string;
const ADAPTER_CACHE = "pi-mcp-adapter/metadata-cache.ts" as string;
const ADAPTER_PANEL_KEYS = "pi-mcp-adapter/panel-keys.ts" as string;

interface ToolInfo {
	name: string;
	/** Whitespace-collapsed, for one-line list rows. */
	description: string;
	/** Original description text, for the detail view. */
	fullDescription: string;
}

interface ConnectorRow {
	name: string;
	entry: Record<string, unknown> & { url?: string; command?: string; args?: string[] };
	transport: "http" | "stdio";
	target: string;
	mode: "bearer" | "oauth" | "none";
	hasTokens: boolean;
	tokenExpired: boolean;
	hasRefreshToken: boolean;
	tools: ToolInfo[] | null;
}

interface PanelTheme {
	fg(token: string, text: string): string;
	bold(text: string): string;
	italic?(text: string): string;
}

interface PanelTui {
	requestRender(): void;
}

/** Stable fingerprint of the connector list for drift detection. */
export function connectorConfigKey(config: { mcpServers?: Record<string, { url?: string; command?: string }> }): string {
	const servers = config.mcpServers ?? {};
	return JSON.stringify(
		Object.keys(servers)
			.sort()
			.map((name) => [name, servers[name]?.url ?? servers[name]?.command ?? ""]),
	);
}

async function loadRows(): Promise<{ rows: ConnectorRow[]; configKey: string }> {
	const [configMod, authMod, cacheMod] = await Promise.all([
		import(ADAPTER_CONFIG),
		import(ADAPTER_AUTH_STORE),
		import(ADAPTER_CACHE),
	]);
	const config = configMod.loadMcpConfig();
	const cache = cacheMod.loadMetadataCache();
	const rows: ConnectorRow[] = Object.entries(config.mcpServers ?? {}).map(([name, rawEntry]) => {
		const entry = rawEntry as ConnectorRow["entry"] & { auth?: "oauth" | "bearer" | false; bearerToken?: string; bearerTokenEnv?: string; oauth?: unknown };
		const mode: ConnectorRow["mode"] =
			entry.auth === "bearer" || entry.bearerToken || entry.bearerTokenEnv
				? "bearer"
				: entry.url && entry.auth !== false && entry.oauth !== false
					? "oauth"
					: "none";
		const cacheEntry = cache?.servers?.[name];
		const cacheValid = cacheEntry ? cacheMod.isServerCacheValid(cacheEntry, entry) : false;
		return {
			name,
			entry,
			transport: entry.url ? "http" : "stdio",
			target: entry.url ?? [entry.command ?? "", ...(entry.args ?? [])].join(" ").trim(),
			mode,
			hasTokens: mode === "oauth" ? Boolean(authMod.hasStoredTokens(name)) : false,
			tokenExpired: mode === "oauth" ? Boolean(authMod.isTokenExpired(name)) : false,
			hasRefreshToken: mode === "oauth" ? Boolean(authMod.getAuthEntry(name)?.tokens?.refreshToken) : false,
			tools: cacheValid
				? (cacheEntry.tools ?? []).map((tool: { name: string; description?: string }) => ({
						name: tool.name,
						description: (tool.description ?? "").replace(/\s+/g, " ").trim(),
						fullDescription: (tool.description ?? "").trim(),
					}))
				: null,
		};
	});
	return { rows, configKey: connectorConfigKey(config) };
}

/** Remove a server's cached tool list. The adapter's saveMetadataCache merges
 * with the on-disk file (deletions resurrect), so edit the file directly. */
async function dropCacheEntry(name: string): Promise<void> {
	const fs = await import("node:fs");
	const path = await import("node:path");
	const os = await import("node:os");
	const agentDir = process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".exxperts", "agent");
	const cachePath = path.join(agentDir, "mcp-cache.json");
	try {
		const cache = JSON.parse(fs.readFileSync(cachePath, "utf-8"));
		if (!cache?.servers?.[name]) return;
		delete cache.servers[name];
		const tmp = `${cachePath}.tmp`;
		fs.writeFileSync(tmp, JSON.stringify(cache, null, 2));
		fs.renameSync(tmp, cachePath);
	} catch {
		// no cache file or unreadable — nothing to drop
	}
}

type Busy = { name: string; kind: "login" | "test" | "logout" } | null;

/** Greedy word wrap that keeps original line breaks. */
function wrapText(text: string, width: number): string[] {
	const out: string[] = [];
	for (const paragraph of text.split("\n")) {
		const words = paragraph.split(/\s+/).filter(Boolean);
		if (words.length === 0) {
			out.push("");
			continue;
		}
		let line = "";
		for (const word of words) {
			const candidate = line ? `${line} ${word}` : word;
			if (visibleWidth(candidate) > width && line) {
				out.push(line);
				line = word;
			} else {
				line = candidate;
			}
		}
		if (line) out.push(line);
	}
	return out;
}

interface VisibleItem {
	type: "server" | "tool" | "gap";
	serverIndex: number;
	toolIndex?: number;
}

class ConnectorsPanel {
	private rows: ConnectorRow[];
	private cursor = 0;
	private expanded = new Set<string>();
	private busy: Busy = null;
	private detail: { title: string; subtitle: string; body: string } | null = null;
	private detailScroll = 0;
	private notice: { text: string; tone: "ok" | "warn" | "error" } | null = null;
	private loginUrl: string | null = null;
	private cancelledLogin: string | null = null;
	private restoreConsole: (() => void) | null = null;
	private view: "list" | "add" = "list";
	private addCursor = 0;
	private confirmRemove: string | null = null;
	private input: { label: string; value: string; mask: boolean; hint?: string; submit: (value: string) => void; cancel: () => void } | null = null;
	private configDrift: boolean;
	private visible: VisibleItem[] = [];
	private closed = false;
	private keys: { selectUp(d: string): boolean; selectDown(d: string): boolean; selectConfirm(d: string): boolean };

	constructor(
		rows: ConnectorRow[],
		configDrift: boolean,
		panelKeys: ConnectorsPanel["keys"],
		private tui: PanelTui,
		private theme: PanelTheme,
		private done: (result: "setup" | undefined) => void,
	) {
		this.rows = rows;
		this.configDrift = configDrift;
		this.keys = panelKeys;
		this.rebuildVisible();
		// The adapter logs to the console from several code paths (auth URL,
		// credential removal, token refresh). Raw stdout writes while the
		// overlay is open desync the renderer, so capture console output for
		// the panel's whole lifetime; dispose() restores it.
		this.hijackConsole();
	}

	private rebuildVisible(): void {
		this.visible = [];
		this.rows.forEach((row, serverIndex) => {
			this.visible.push({ type: "server", serverIndex });
			if (this.expanded.has(row.name) && row.tools) {
				row.tools.forEach((_tool, toolIndex) => {
					this.visible.push({ type: "tool", serverIndex, toolIndex });
				});
				// Breathing room between an expanded tool list and the next server.
				if (serverIndex < this.rows.length - 1) this.visible.push({ type: "gap", serverIndex });
			}
		});
		this.cursor = Math.min(this.cursor, Math.max(0, this.visible.length - 1));
		if (this.visible[this.cursor]?.type === "gap") this.cursor = Math.max(0, this.cursor - 1);
	}

	private moveCursor(delta: -1 | 1): void {
		const total = this.visible.length;
		if (total === 0) return;
		let next = this.cursor;
		do {
			next = (next + delta + total) % total;
		} while (this.visible[next]?.type === "gap" && next !== this.cursor);
		this.cursor = next;
		this.tui.requestRender();
	}

	private currentServer(): ConnectorRow | null {
		const item = this.visible[this.cursor];
		return item ? this.rows[item.serverIndex] : null;
	}

	private async refresh(): Promise<void> {
		try {
			const { rows } = await loadRows();
			this.rows = rows;
			this.rebuildVisible();
		} catch (e) {
			this.notice = { text: (e as Error).message, tone: "error" };
		}
		this.tui.requestRender();
	}

	private setNotice(text: string, tone: "ok" | "warn" | "error"): void {
		this.notice = { text, tone };
		this.tui.requestRender();
	}

	/** Capture console output (the auth URL is surfaced inside the panel). */
	private hijackConsole(): void {
		if (this.restoreConsole) return;
		const original = { log: console.log, warn: console.warn, error: console.error };
		const capture = (...args: unknown[]) => {
			const text = args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ");
			const match = text.match(/https?:\/\/\S+/);
			if (match && /auth/i.test(text)) {
				this.loginUrl = match[0];
				this.tui.requestRender();
			}
		};
		console.log = capture as typeof console.log;
		console.warn = capture as typeof console.warn;
		console.error = capture as typeof console.error;
		this.restoreConsole = () => {
			console.log = original.log;
			console.warn = original.warn;
			console.error = original.error;
			this.restoreConsole = null;
		};
	}

	private login(row: ConnectorRow): void {
		if (this.busy || row.mode !== "oauth" || row.hasTokens || !row.entry.url) return;
		this.busy = { name: row.name, kind: "login" };
		this.cancelledLogin = null;
		this.loginUrl = null;
		this.setNotice(`Complete the ${row.name} login in your browser… (esc cancels)`, "warn");
		void (async () => {
			try {
				const authFlow = await import(ADAPTER_AUTH_FLOW);
				if (!authFlow.supportsOAuth(row.entry)) {
					throw new Error("This connector has authentication disabled in its config.");
				}
				await authFlow.authenticate(row.name, row.entry.url, row.entry);
				if (this.closed) return;
				this.busy = null;
				this.loginUrl = null;
				this.setNotice(`Logged in to ${row.name}.`, "ok");
				await this.refresh();
			} catch (e) {
				if (this.closed) return;
				this.busy = null;
				this.loginUrl = null;
				// A deliberate cancel already set its own notice; the rejected
				// authenticate() promise should not overwrite it.
				if (this.cancelledLogin === row.name) return;
				const message = (e as Error).message ?? String(e);
				const friendly = /404|not found/i.test(message)
					? "This connector doesn't offer a login. It likely works without one."
					: message;
				this.setNotice(friendly, "error");
			}
		})();
	}

	private cancelLogin(): void {
		const busy = this.busy;
		if (!busy || busy.kind !== "login") return;
		this.cancelledLogin = busy.name;
		void (async () => {
			try {
				const [authStore, callbackMod] = await Promise.all([import(ADAPTER_AUTH_STORE), import(ADAPTER_CALLBACK)]);
				const state = authStore.getOAuthState(busy.name);
				if (state) callbackMod.cancelPendingCallback(state);
			} catch {
				// the attempt also dies on its own timeout
			}
			this.busy = null;
			this.loginUrl = null;
			this.setNotice("Login cancelled.", "ok");
		})();
	}

	private logout(row: ConnectorRow): void {
		if (this.busy || !row.hasTokens) return;
		this.busy = { name: row.name, kind: "logout" };
		this.tui.requestRender();
		void (async () => {
			try {
				const authFlow = await import(ADAPTER_AUTH_FLOW);
				await authFlow.removeAuth(row.name);
				await dropCacheEntry(row.name);
				this.busy = null;
				this.setNotice(`Cleared the stored login for ${row.name}.`, "ok");
				await this.refresh();
			} catch (e) {
				this.busy = null;
				this.setNotice((e as Error).message, "error");
			}
		})();
	}

	private test(row: ConnectorRow): void {
		if (this.busy) return;
		this.busy = { name: row.name, kind: "test" };
		this.setNotice(`Testing ${row.name}…`, "warn");
		void (async () => {
			const [managerMod, cacheMod] = await Promise.all([import(ADAPTER_MANAGER), import(ADAPTER_CACHE)]);
			const manager = new managerMod.McpServerManager();
			try {
				const connection = await Promise.race([
					manager.connect(row.name, row.entry),
					new Promise<never>((_, reject) => setTimeout(() => reject(new Error("Connection timed out after 20s.")), 20_000)),
				]);
				const count = (connection.tools ?? []).length;
				try {
					const cache = cacheMod.loadMetadataCache() ?? { version: 1, servers: {} };
					cache.servers[row.name] = {
						configHash: cacheMod.computeServerHash(row.entry),
						tools: cacheMod.serializeTools(connection.tools ?? []),
						resources: cacheMod.serializeResources(connection.resources ?? []),
						cachedAt: Date.now(),
					};
					cacheMod.saveMetadataCache(cache);
				} catch {
					// cache refresh is best-effort
				}
				this.busy = null;
				const oauthConf = row.entry.oauth;
				const explicitOAuth = row.entry.auth === "oauth" || (typeof oauthConf === "object" && oauthConf !== null && "clientId" in oauthConf);
				if (explicitOAuth && !row.hasTokens) {
					this.setNotice(`${row.name}: reachable, but not logged in yet. Press l to log in.`, "warn");
				} else {
					this.setNotice(`${row.name}: connection OK · ${count} tool${count === 1 ? "" : "s"} available.`, "ok");
				}
				await this.refresh();
			} catch (e) {
				const message = (e as Error).message ?? String(e);
				const needsAuth = /unauthorized|401|needs-auth|oauth|authentication required/i.test(message);
				if (needsAuth) await dropCacheEntry(row.name);
				this.busy = null;
				this.setNotice(
					needsAuth ? `${row.name} needs a login. Press l.` : `${row.name}: connection failed · ${message}`,
					"error",
				);
				await this.refresh();
			} finally {
				try {
					await manager.closeAll();
				} catch {
					// already closed / never opened
				}
			}
		})();
	}

	private isInstalled(entry: ConnectorCatalogEntry): boolean {
		return this.rows.some((row) => row.name === entry.id || (entry.url !== undefined && row.target === entry.url));
	}

	private async writeServer(name: string, entry: Record<string, unknown>): Promise<void> {
		if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(name)) {
			this.setNotice("Connector names use letters, digits, - and _ (max 64 chars).", "error");
			return;
		}
		if (this.rows.some((row) => row.name === name)) {
			this.setNotice(`A connector named "${name}" already exists.`, "error");
			return;
		}
		try {
			const configMod = await import(ADAPTER_CONFIG);
			configMod.writeSharedServerEntry(configMod.getPiGlobalConfigPath(), name, entry);
			this.view = "list";
			this.setNotice(`${name} added. Press t to test it.`, "ok");
			await this.refresh();
		} catch (e) {
			this.setNotice((e as Error).message, "error");
		}
	}

	private addCatalogEntry(entry: ConnectorCatalogEntry): void {
		if (this.isInstalled(entry)) {
			this.setNotice(`${entry.name} is already configured.`, "warn");
			return;
		}
		if (entry.kind === "token") {
			this.input = {
				label: `${entry.tokenHint ?? "API token"} for ${entry.name}`,
				value: "",
				mask: true,
				submit: (value) => {
					this.input = null;
					if (!value.trim()) {
						this.setNotice("Cancelled. No token entered.", "warn");
						return;
					}
					void this.writeServer(entry.id, { url: entry.url, auth: "bearer", bearerToken: value.trim() });
				},
				cancel: () => {
					this.input = null;
					this.tui.requestRender();
				},
			};
			this.tui.requestRender();
			return;
		}
		if (entry.kind === "oauth-client" && entry.url) {
			// Needs a pre-registered OAuth app (no dynamic client registration).
			const url = entry.url;
			const hint = [entry.guideNote, entry.docsUrl ? `Guide: ${entry.docsUrl}` : "", "The app's redirect URL must be http://localhost:19876/callback."]
				.filter(Boolean)
				.join("\n");
			this.input = {
				label: `OAuth client ID for ${entry.name}`,
				value: "",
				mask: false,
				hint,
				submit: (value) => {
					this.input = null;
					const clientId = value.trim();
					if (!clientId) {
						this.setNotice("Cancelled. No client ID entered.", "warn");
						return;
					}
					this.askOAuthClientDetails(entry.id, url, clientId);
				},
				cancel: () => {
					this.input = null;
					this.tui.requestRender();
				},
			};
			this.tui.requestRender();
			return;
		}
		if (entry.kind === "open" || entry.kind === "oauth") {
			void this.writeServer(entry.id, { url: entry.url });
			return;
		}
		// "guided" and any kind this build doesn't know: show the setup notes
		// instead of silently writing a bare URL entry.
		this.detail = {
			title: entry.name,
			subtitle: "needs setup",
			body: `${entry.guideNote ?? ""}\n\nGuide: ${entry.docsUrl ?? ""}`.trim(),
		};
		this.detailScroll = 0;
		this.tui.requestRender();
	}

	/** Client secret + scopes prompts, then write the explicit OAuth client
	 * entry — the same shape the web server writes for providers without
	 * dynamic client registration ({ url, auth: "oauth", oauth: {…} }). */
	private askOAuthClientDetails(name: string, url: string, clientId: string): void {
		const cancel = () => {
			this.input = null;
			this.tui.requestRender();
		};
		const askScope = (clientSecret: string) => {
			this.input = {
				label: "Scopes (optional, enter to skip)",
				value: "",
				mask: false,
				submit: (value) => {
					this.input = null;
					const scope = value.trim();
					void this.writeServer(name, {
						url,
						auth: "oauth",
						oauth: { clientId, ...(clientSecret ? { clientSecret } : {}), ...(scope ? { scope } : {}) },
					});
				},
				cancel,
			};
			this.tui.requestRender();
		};
		this.input = {
			label: "Client secret (optional, enter to skip)",
			value: "",
			mask: true,
			submit: (value) => {
				this.input = null;
				askScope(value.trim());
			},
			cancel,
		};
		this.tui.requestRender();
	}

	private startCustomAdd(): void {
		const askOAuthClientId = (name: string, url: string) => {
			this.input = {
				label: "OAuth client ID (optional, for providers without automatic registration)",
				value: "",
				mask: false,
				hint: "The app's redirect URL must be http://localhost:19876/callback.",
				submit: (value) => {
					this.input = null;
					const clientId = value.trim();
					if (!clientId) {
						void this.writeServer(name, { url });
						return;
					}
					this.askOAuthClientDetails(name, url, clientId);
				},
				cancel: () => {
					this.input = null;
					this.tui.requestRender();
				},
			};
			this.tui.requestRender();
		};
		const askToken = (name: string, url: string) => {
			this.input = {
				label: "API token (optional, enter to skip)",
				value: "",
				mask: true,
				submit: (token) => {
					this.input = null;
					if (token.trim()) {
						void this.writeServer(name, { url, auth: "bearer", bearerToken: token.trim() });
						return;
					}
					askOAuthClientId(name, url);
				},
				cancel: () => {
					this.input = null;
					this.tui.requestRender();
				},
			};
			this.tui.requestRender();
		};
		const askTarget = (name: string) => {
			this.input = {
				label: "Server URL, or a local command",
				value: "",
				mask: false,
				submit: (target) => {
					this.input = null;
					const trimmed = target.trim();
					if (!trimmed) {
						this.setNotice("Cancelled. No URL or command entered.", "warn");
						return;
					}
					if (/^https?:\/\//.test(trimmed)) {
						askToken(name, trimmed);
					} else {
						const parts = trimmed.split(/\s+/);
						void this.writeServer(name, { command: parts[0], ...(parts.length > 1 ? { args: parts.slice(1) } : {}) });
					}
				},
				cancel: () => {
					this.input = null;
					this.tui.requestRender();
				},
			};
			this.tui.requestRender();
		};
		this.input = {
			label: "Connector name (e.g. linear)",
			value: "",
			mask: false,
			submit: (name) => {
				this.input = null;
				const trimmed = name.trim();
				if (!trimmed) {
					this.setNotice("Cancelled. No name entered.", "warn");
					return;
				}
				askTarget(trimmed);
			},
			cancel: () => {
				this.input = null;
				this.tui.requestRender();
			},
		};
		this.tui.requestRender();
	}

	/** Remove from both user-global config files (the web does the same; the
	 * adapter's provenance writePath is unreliable for deletions). */
	private removeServer(name: string): void {
		if (this.busy) return;
		void (async () => {
			try {
				const configMod = await import(ADAPTER_CONFIG);
				const fs = await import("node:fs");
				let removed = false;
				for (const file of [configMod.getPiGlobalConfigPath(), configMod.getGenericGlobalConfigPath()]) {
					try {
						const parsed = JSON.parse(fs.readFileSync(file, "utf-8"));
						if (parsed?.mcpServers?.[name]) {
							delete parsed.mcpServers[name];
							const tmp = `${file}.tmp`;
							fs.writeFileSync(tmp, JSON.stringify(parsed, null, 2) + "\n");
							fs.renameSync(tmp, file);
							removed = true;
						}
					} catch {
						// file absent or unreadable — skip
					}
				}
				if (!removed) {
					this.setNotice(`${name} is defined in a project config (.mcp.json). Remove it there.`, "warn");
					return;
				}
				try {
					const authFlow = await import(ADAPTER_AUTH_FLOW);
					await authFlow.removeAuth(name);
				} catch {
					// no stored auth
				}
				await dropCacheEntry(name);
				this.expanded.delete(name);
				this.setNotice(`${name} removed. Open rooms keep it until re-entered.`, "ok");
				await this.refresh();
			} catch (e) {
				this.setNotice((e as Error).message, "error");
			}
		})();
	}

	private statusFor(row: ConnectorRow): { label: string; token: string } {
		if (this.busy?.name === row.name) {
			const label = this.busy.kind === "login" ? "logging in" : this.busy.kind === "test" ? "testing" : "clearing";
			return { label, token: "warning" };
		}
		if (row.mode === "bearer") return { label: "API token", token: "success" };
		if (row.mode === "oauth") {
			if (row.hasTokens && row.tokenExpired && !row.hasRefreshToken) return { label: "login expired", token: "warning" };
			if (row.hasTokens) return { label: "logged in", token: "success" };
			// Explicitly configured OAuth (auth: "oauth" or a custom client)
			// expects a login even when the server lists tools without one —
			// same semantics as the web Connectors page.
			const oauthConf = row.entry.oauth;
			const explicit = row.entry.auth === "oauth" || (typeof oauthConf === "object" && oauthConf !== null && "clientId" in oauthConf);
			if (explicit) return { label: "login required", token: "warning" };
			if (row.tools) return { label: "no login needed", token: "dim" };
			return { label: "not tested", token: "muted" };
		}
		return { label: "local", token: "dim" };
	}

	handleInput(data: string): void {
		if (matchesKey(data, "ctrl+c")) {
			this.close();
			return;
		}
		if (this.input) {
			if (matchesKey(data, "escape")) {
				this.input.cancel();
				return;
			}
			if (this.keys.selectConfirm(data)) {
				this.input.submit(this.input.value);
				return;
			}
			if (matchesKey(data, "backspace")) {
				this.input.value = this.input.value.slice(0, -1);
				this.tui.requestRender();
				return;
			}
			if (data.length === 1 && data.charCodeAt(0) >= 32) {
				this.input.value += data;
				this.tui.requestRender();
			} else if (data.length > 1 && !data.startsWith("\x1b")) {
				// pasted text
				this.input.value += data.replace(/[\r\n]/g, "");
				this.tui.requestRender();
			}
			return;
		}
		if (this.detail) {
			if (matchesKey(data, "escape") || this.keys.selectConfirm(data)) {
				this.detail = null;
				this.detailScroll = 0;
				this.tui.requestRender();
			} else if (this.keys.selectUp(data)) {
				this.detailScroll = Math.max(0, this.detailScroll - 1);
				this.tui.requestRender();
			} else if (this.keys.selectDown(data)) {
				this.detailScroll += 1;
				this.tui.requestRender();
			}
			return;
		}
		if (this.view === "add") {
			const totalEntries = CONNECTOR_CATALOG.length + 1;
			if (matchesKey(data, "escape")) {
				this.view = "list";
				this.tui.requestRender();
				return;
			}
			if (this.keys.selectUp(data)) {
				this.addCursor = (this.addCursor - 1 + totalEntries) % totalEntries;
				this.tui.requestRender();
				return;
			}
			if (this.keys.selectDown(data)) {
				this.addCursor = (this.addCursor + 1) % totalEntries;
				this.tui.requestRender();
				return;
			}
			if (this.keys.selectConfirm(data)) {
				if (this.addCursor === CONNECTOR_CATALOG.length) this.startCustomAdd();
				else this.addCatalogEntry(CONNECTOR_CATALOG[this.addCursor]);
				return;
			}
			return;
		}
		if (this.confirmRemove) {
			const name = this.confirmRemove;
			this.confirmRemove = null;
			if (data === "y" || data === "Y") {
				this.removeServer(name);
			} else {
				this.setNotice("Kept.", "ok");
			}
			return;
		}
		if (matchesKey(data, "escape")) {
			if (this.busy?.kind === "login") {
				this.cancelLogin();
				return;
			}
			this.close();
			return;
		}
		if (this.keys.selectUp(data)) {
			this.moveCursor(-1);
			return;
		}
		if (this.keys.selectDown(data)) {
			this.moveCursor(1);
			return;
		}
		if (data === "a") {
			this.view = "add";
			this.addCursor = 0;
			this.tui.requestRender();
			return;
		}
		const row = this.currentServer();
		if (!row) return;
		if (this.keys.selectConfirm(data)) {
			const item = this.visible[this.cursor];
			if (item?.type === "tool" && item.toolIndex !== undefined && row.tools) {
				const tool = row.tools[item.toolIndex];
				this.detail = { title: tool.name, subtitle: `from ${row.name}`, body: tool.fullDescription || "(no description)" };
				this.detailScroll = 0;
				this.tui.requestRender();
				return;
			}
			if (!row.tools || row.tools.length === 0) {
				this.setNotice(`${row.name}: no tools listed yet. Press t to test the connection.`, "warn");
				return;
			}
			if (this.expanded.has(row.name)) this.expanded.delete(row.name);
			else this.expanded.add(row.name);
			this.rebuildVisible();
			this.tui.requestRender();
			return;
		}
		if (data === "l") {
			if (row.mode === "oauth" && !row.hasTokens) this.login(row);
			else this.setNotice(row.hasTokens ? `${row.name} is already logged in.` : `${row.name} does not use OAuth login.`, "warn");
			return;
		}
		if (data === "o") {
			if (row.hasTokens) this.logout(row);
			else this.setNotice(`${row.name} has no stored login.`, "warn");
			return;
		}
		if (data === "t") {
			this.test(row);
			return;
		}
		if (data === "x") {
			this.confirmRemove = row.name;
			this.setNotice(`Remove ${row.name}? Press y to confirm, any other key to keep.`, "warn");
			return;
		}
		if (data === "s") {
			// Hand off to the adapter's setup/import flow (the wrapper runs it
			// after this panel resolves).
			if (this.closed) return;
			this.closed = true;
			this.restoreConsole?.();
			this.done("setup");
			return;
		}
	}

	private close(): void {
		if (this.closed) return;
		this.closed = true;
		this.restoreConsole?.();
		this.done(undefined);
	}

	render(width: number): string[] {
		const t = this.theme;
		const innerW = Math.max(40, width - 2);
		const border = (s: string) => t.fg("border", s);
		const pad = (s: string) => {
			const w = visibleWidth(s);
			return s + " ".repeat(Math.max(0, innerW - 2 - w));
		};
		const row = (s: string) => border("│") + " " + pad(truncateToWidth(s, innerW - 2, "…")) + " " + border("│");
		const blank = () => row("");

		const title = " Connectors ";
		const side = Math.max(0, Math.floor((innerW - visibleWidth(title)) / 2));
		const lines: string[] = [
			border("╭" + "─".repeat(side)) + t.fg("text", title) + border("─".repeat(Math.max(0, innerW - side - visibleWidth(title))) + "╮"),
		];
		lines.push(blank());

		if (this.configDrift) {
			lines.push(row(t.fg("warning", "Connector config changed since this room opened. Reopen the room to apply.")));
			lines.push(blank());
		}

		if (this.detail) {
			const wrapped = wrapText(this.detail.body, innerW - 6);
			const maxBody = Math.max(4, (process.stdout.rows ?? 24) - 12);
			this.detailScroll = Math.max(0, Math.min(this.detailScroll, Math.max(0, wrapped.length - maxBody)));
			lines.push(row(`${t.bold(t.fg("accent", this.detail.title))}  ${t.fg("dim", this.detail.subtitle)}`));
			lines.push(blank());
			for (const textLine of wrapped.slice(this.detailScroll, this.detailScroll + maxBody)) {
				lines.push(row(`  ${t.fg("text", textLine)}`));
			}
			if (wrapped.length > maxBody) {
				lines.push(blank());
				lines.push(row(t.fg("dim", `↑↓ scroll  ${this.detailScroll + 1}–${Math.min(this.detailScroll + maxBody, wrapped.length)}/${wrapped.length}`)));
			}
			lines.push(blank());
			lines.push(border("├" + "─".repeat(innerW) + "┤"));
			lines.push(blank());
			lines.push(row(t.fg("muted", "esc back to the connector list")));
			lines.push(border("╰" + "─".repeat(innerW) + "╯"));
			return lines;
		}

		if (this.view === "add") {
			const KIND_LABELS: Record<ConnectorCatalogEntry["kind"], string> = {
				open: "no login",
				oauth: "one-click login",
				token: "API token",
				"oauth-client": "OAuth app",
				guided: "needs setup",
			};
			lines.push(row(t.bold(t.fg("text", "Add a connector")) + "  " + t.fg("dim", "verified servers, plus custom")));
			lines.push(blank());
			const entries = CONNECTOR_CATALOG.length + 1;
			const nameW = Math.max(...CONNECTOR_CATALOG.map((e) => visibleWidth(e.name)), visibleWidth("Custom connector…"));
			const kindW = Math.max(...Object.values(KIND_LABELS).map((s) => visibleWidth(s)));
			const padTo = (s: string, w: number) => s + " ".repeat(Math.max(0, w - visibleWidth(s)));
			const maxVisible = Math.max(4, (process.stdout.rows ?? 24) - 14);
			const start = Math.max(0, Math.min(this.addCursor - Math.floor(maxVisible / 2), entries - maxVisible));
			const end = Math.min(start + maxVisible, entries);
			for (let i = start; i < end; i++) {
				const isCursor = i === this.addCursor;
				const caret = isCursor ? t.fg("accent", "▸") : " ";
				if (i === CONNECTOR_CATALOG.length) {
					const name = isCursor ? t.bold(t.fg("accent", padTo("Custom connector…", nameW))) : t.fg("text", padTo("Custom connector…", nameW));
					lines.push(row(`${caret} ${name}  ${t.fg("dim", padTo("URL or command", kindW))}`));
					if (isCursor) lines.push(row(`  ${t.fg("dim", "Add any MCP server that isn't in the list.")}`));
					continue;
				}
				const entry = CONNECTOR_CATALOG[i];
				const name = isCursor ? t.bold(t.fg("accent", padTo(entry.name, nameW))) : t.fg("text", padTo(entry.name, nameW));
				// A catalog kind this build doesn't know must not crash the paint.
				const kind = t.fg("dim", padTo(KIND_LABELS[entry.kind] ?? "custom setup", kindW));
				const added = this.isInstalled(entry) ? t.fg("success", "✓ added") : "";
				lines.push(row(`${caret} ${name}  ${kind}  ${added}`));
				// Full description on its own line for the cursor row only.
				if (isCursor) lines.push(row(`  ${t.fg("dim", truncateToWidth(entry.description, innerW - 4, "…"))}`));
			}
			if (entries > maxVisible) {
				lines.push(blank());
				lines.push(row(t.fg("dim", `${this.addCursor + 1}/${entries}`)));
			}
			lines.push(blank());
			if (this.input) {
				if (this.input.hint) {
					for (const hintLine of wrapText(this.input.hint, innerW - 4)) {
						lines.push(row(t.fg("dim", hintLine)));
					}
					lines.push(blank());
				}
				lines.push(row(`${t.fg("text", this.input.label)}: ${t.fg("accent", this.input.mask ? "•".repeat(this.input.value.length) : this.input.value)}${t.fg("accent", "▌")}`));
				lines.push(blank());
			} else if (this.notice) {
				const token = this.notice.tone === "ok" ? "success" : this.notice.tone === "warn" ? "warning" : "error";
				for (const noticeLine of wrapText(this.notice.text, innerW - 4)) {
					lines.push(row(t.fg(token, noticeLine)));
				}
				lines.push(blank());
			}
			lines.push(border("├" + "─".repeat(innerW) + "┤"));
			lines.push(blank());
			lines.push(row(t.fg("muted", this.input ? "⏎ confirm  esc cancel" : "↑↓ navigate  ⏎ add  esc back")));
			lines.push(border("╰" + "─".repeat(innerW) + "╯"));
			return lines;
		}

		if (this.rows.length === 0) {
			lines.push(row(t.fg("dim", "No connectors configured. Press a to add one.")));
		} else {
			// Aligned columns: caret+name | tool count | status.
			const nameW = Math.max(...this.rows.map((server) => visibleWidth(server.name)));
			const countTextFor = (server: ConnectorRow) => (server.tools ? `${server.tools.length} tools` : "not tested");
			const countW = Math.max(...this.rows.map((server) => visibleWidth(countTextFor(server))));
			const padTo = (s: string, w: number) => s + " ".repeat(Math.max(0, w - visibleWidth(s)));

			const maxVisible = Math.max(3, (process.stdout.rows ?? 24) - 15);
			const total = this.visible.length;
			const start = Math.max(0, Math.min(this.cursor - Math.floor(maxVisible / 2), total - maxVisible));
			const end = Math.min(start + maxVisible, total);
			for (let i = start; i < end; i++) {
				const item = this.visible[i];
				const server = this.rows[item.serverIndex];
				const isCursor = i === this.cursor;
				if (item.type === "gap") {
					lines.push(blank());
				} else if (item.type === "server") {
					const expandable = Boolean(server.tools && server.tools.length > 0);
					const glyph = expandable ? (this.expanded.has(server.name) ? "▾" : "▸") : "·";
					const caret = isCursor ? t.fg("accent", glyph) : t.fg("dim", glyph);
					const name = isCursor ? t.bold(t.fg("accent", padTo(server.name, nameW))) : t.fg("text", padTo(server.name, nameW));
					const count = t.fg("dim", padTo(countTextFor(server), countW));
					const status = this.statusFor(server);
					lines.push(row(`${caret} ${name}  ${count}  ${t.fg(status.token, status.label)}`));
					if (isCursor) {
						lines.push(row(`  ${t.fg("dim", truncateToWidth(server.target, innerW - 6, "…"))}`));
					}
				} else if (item.toolIndex !== undefined && server.tools) {
					// Names only — a truncated description is clutter; ⏎ opens the
					// full one in the detail view.
					const tool = server.tools[item.toolIndex];
					const name = isCursor ? t.fg("accent", tool.name) : t.fg("text", tool.name);
					lines.push(row(`    ${name}${isCursor ? t.fg("dim", "  ⏎ description") : ""}`));
				}
			}
			if (total > maxVisible) {
				lines.push(blank());
				lines.push(row(t.fg("dim", `${this.cursor + 1}/${total}`)));
			}
		}

		lines.push(blank());
		if (this.notice) {
			const token = this.notice.tone === "ok" ? "success" : this.notice.tone === "warn" ? "warning" : "error";
			for (const noticeLine of wrapText(this.notice.text, innerW - 4)) {
				lines.push(row(t.fg(token, noticeLine)));
			}
			if (this.loginUrl) {
				lines.push(row(t.fg("dim", "If the browser didn't open, use this URL:")));
				for (let i = 0; i < this.loginUrl.length; i += innerW - 6) {
					lines.push(row(`  ${t.fg("dim", this.loginUrl.slice(i, i + innerW - 6))}`));
				}
			}
			lines.push(blank());
		}
		lines.push(border("├" + "─".repeat(innerW) + "┤"));
		lines.push(blank());
		lines.push(row(t.fg("muted", "↑↓ navigate  ⏎ open  a add  x remove  s setup/import  esc close")));
		lines.push(row(t.fg("muted", "l log in  o log out  t test")));
		lines.push(row(t.fg("muted", "Rooms use connectors through the single mcp tool. No per-tool setup needed.")));
		lines.push(border("╰" + "─".repeat(innerW) + "╯"));
		return lines;
	}

	invalidate(): void {}

	dispose(): void {
		this.closed = true;
		this.restoreConsole?.();
	}
}

export async function openConnectorsPanel(
	ctx: {
		ui: {
			custom<T>(
				factory: (tui: PanelTui, theme: PanelTheme, keybindings: unknown, done: (result: T) => void) => unknown,
				options?: unknown,
			): Promise<T>;
		};
	},
	sessionConfigKey: string | null,
): Promise<"setup" | undefined> {
	const [{ rows, configKey }, panelKeysMod] = await Promise.all([loadRows(), import(ADAPTER_PANEL_KEYS)]);
	const configDrift = sessionConfigKey !== null && sessionConfigKey !== configKey;
	return await ctx.ui.custom<"setup" | undefined>(
		(tui, theme, keybindings, done) =>
			new ConnectorsPanel(rows, configDrift, panelKeysMod.createPanelKeys(keybindings), tui, theme, done),
		{ overlay: true, overlayOptions: { anchor: "center", width: 88, maxHeight: "90%" } },
	);
}
