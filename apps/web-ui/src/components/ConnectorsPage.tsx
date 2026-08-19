import { useCallback, useEffect, useRef, useState } from "react";
import {
	addMcpServer,
	cancelMcpServerLogin,
	fetchMcpConnectorsStatus,
	fetchMcpServerLoginState,
	logoutMcpServer,
	removeMcpServer,
	startMcpServerLogin,
	testMcpServer,
	type McpConnectorStatus,
	type McpConnectorsStatusResponse,
} from "../mcp-api";
import { CONNECTOR_CATALOG, type ConnectorCatalogEntry } from "../connector-catalog";
import { CONNECTOR_ICONS } from "../connector-icons";
import { useRemoteClientContext } from "../remote-client-context";

const APPLY_NOTE = "Config change saved. Rooms pick it up the next time you enter or resume them.";

/**
 * Auth is auto-detected for URL servers, so "no stored login" is ambiguous:
 * the server may be public or may prompt on first use. A cached tool list
 * with no stored tokens means a connection already succeeded without login,
 * which settles it.
 */
function authView(server: McpConnectorStatus, knownOpen: boolean): { label: string; state: "ready" | "missing" | "off" | "idle"; note?: string } {
	const { auth } = server;
	if (auth.mode === "bearer") return { label: "Bearer token", state: "ready" };
	if (auth.mode === "oauth") {
		if (auth.hasStoredTokens && auth.tokenExpired && !auth.hasRefreshToken) {
			return { label: "Login expired", state: "missing", note: "Log in again below, or let the room re-auth on next use." };
		}
		if (auth.hasStoredTokens) return { label: "Logged in", state: "ready" };
		// An explicitly configured OAuth client expects a login even when the
		// server lists tools unauthenticated (Gmail, HubSpot expose their
		// catalogs publicly — calls still need the token).
		if (auth.explicit) return { label: "Login required", state: "missing", note: "Log in below to finish connecting this account." };
		if (server.tools) return { label: "No login needed", state: "ready" };
		// The directory knows some servers are public — no point offering a
		// login or flagging them red before the first connection.
		if (knownOpen) return { label: "No login needed", state: "idle" };
		return { label: "Not connected", state: "off" };
	}
	return { label: "Local process", state: "ready" };
}

function cachedToolsLine(server: McpConnectorStatus): string {
	if (!server.tools) return "";
	const when = new Date(server.tools.cachedAt).toLocaleString();
	const names = server.tools.names.slice(0, 6).join(", ");
	const more = server.tools.count > 6 ? `, +${server.tools.count - 6} more` : "";
	return `${server.tools.count} tool${server.tools.count === 1 ? "" : "s"}: ${names}${more} · listed ${when}`;
}

/** Table type cell: how you connect, from the same catalog metadata the Add
 *  cards use; local commands and bearer-token customs are recognizable without
 *  a catalog entry, anything else stays blank. */
const ROW_TYPE_LABELS: Record<ConnectorCatalogEntry["kind"], string> = {
	open: "no login needed",
	oauth: "one-click login",
	token: "API token",
	"oauth-client": "OAuth app",
	guided: "guided setup",
};

interface RowOutcome {
	text: string;
	tone: "ok" | "error" | "progress";
}

function ConnectorRow({ server, expanded, onToggle, onChanged, onNotice, readOnly }: { server: McpConnectorStatus; expanded: boolean; onToggle: () => void; onChanged: () => Promise<void>; onNotice: (text: string) => void; readOnly: boolean }) {
	const [busy, setBusy] = useState<"test" | "login" | "logout" | "remove" | null>(null);
	const [confirmRemove, setConfirmRemove] = useState(false);
	// One outcome line per row: each action replaces the previous result.
	const [outcome, setOutcome] = useState<RowOutcome | null>(null);
	const [needsAuthSeen, setNeedsAuthSeen] = useState(false);
	// Tool chips render capped at 8; this opens the full set for this row.
	const [showAllTools, setShowAllTools] = useState(false);
	const loginPollRef = useRef<number | null>(null);

	useEffect(() => () => {
		if (loginPollRef.current !== null) window.clearTimeout(loginPollRef.current);
	}, []);

	const knownOpen = CONNECTOR_CATALOG.some((entry) => entry.kind === "open" && entry.url === server.target);
	const auth = authView(server, knownOpen);
	const catalogEntry = CONNECTOR_CATALOG.find((entry) => entry.id === server.name || (entry.url !== undefined && entry.url === server.target));
	const typeLabel = server.transport !== "http" ? "local process" : catalogEntry ? ROW_TYPE_LABELS[catalogEntry.kind] : server.auth.mode === "bearer" ? "API token" : "";
	const rowStatus = auth.state === "missing" ? "not connected" : server.tools || server.auth.hasStoredTokens ? "connected" : "not tested";
	// Offer login only when it can plausibly matter: never for servers a
	// connection already succeeded against without tokens or that the
	// directory knows are public, always after a test reported "needs
	// authentication".
	const canLogin = server.auth.mode === "oauth" && server.transport === "http";
	const showLogin = canLogin && !server.auth.hasStoredTokens && (server.auth.explicit === true || needsAuthSeen || (!server.tools && !knownOpen));

	async function run(action: "test" | "login" | "logout" | "remove", fn: () => Promise<void>) {
		setBusy(action);
		setOutcome(null);
		try {
			await fn();
		} catch (e) {
			setOutcome({ text: (e as Error).message, tone: "error" });
			setBusy(null);
		}
	}

	function pollLogin(deadline: number) {
		loginPollRef.current = window.setTimeout(async () => {
			try {
				const state = await fetchMcpServerLoginState(server.name);
				if (state.pending && Date.now() < deadline) {
					pollLogin(deadline);
					return;
				}
				setBusy(null);
				if (state.error) setOutcome({ text: state.error, tone: "error" });
				else if (state.pending) setOutcome({ text: "The login timed out. Try again.", tone: "error" });
				else {
					setOutcome(null);
					onNotice(`Logged in to ${server.name}.`);
				}
				await onChanged();
			} catch (e) {
				setBusy(null);
				setOutcome({ text: (e as Error).message, tone: "error" });
			}
		}, 2000);
	}

	// "not connected yet" next to a "Logged in" badge reads as a contradiction —
	// the missing piece is only the tool list, so say that.
	const toolsSummary = server.tools ? `${server.tools.count} tool${server.tools.count === 1 ? "" : "s"}` : "";
	// The default config file is the same for every row and the page footnote
	// already explains it — only surface the source when it is the odd one out.
	const defaultSource = server.source?.path.includes(".exxperts") && !server.source.importKind;
	const sourceSummary = server.source && !defaultSource ? `from ${server.source.path}${server.source.importKind ? ` (imported from ${server.source.importKind})` : ""}` : "";

	// Inline expansion: pure presentation of the already-fetched status row
	// plus the static catalog blurb. The chip names come from the same cached
	// tool list the "N tools" hint counts.
	// The raw URL/command is the identity only for custom servers; catalog
	// connectors are identified by their card, and timestamps stay out.
	const expansionMeta = [
		catalogEntry ? "" : server.transport === "http" ? server.target : `local: ${server.target}`,
		sourceSummary,
	]
		.filter(Boolean)
		.join(" · ");

	return (
		<div className="connector-row">
			<ConnectorAvatar id={server.name} name={server.name} size={24} />
			<button type="button" className="connector-row-main connector-row-toggle" aria-expanded={expanded} onClick={onToggle}>
				<div className="connector-row-title">
					<strong title={server.transport === "http" ? server.target : `local: ${server.target}`}>{server.name}</strong>
				</div>
				{/* Exactly one meta line per row; action outcomes get their own
				    full-width line below instead. */}
				{busy === "login" ? (
					<span className="connector-row-meta">Waiting for the login to finish in your browser…</span>
				) : toolsSummary || sourceSummary ? (
					<span className="connector-row-meta" title={server.tools ? cachedToolsLine(server) : undefined}>
						{toolsSummary}{toolsSummary && sourceSummary ? " · " : ""}{sourceSummary}
					</span>
				) : null}
			</button>
			{/* One wrapper around the two fact cells: on desktop it dissolves
			    into the table grid (display: contents); the phone layout folds
			    it into a single dot-separated hint line under the name. */}
			<span className="connector-table-facts">
				<span className="connector-table-type">{typeLabel}</span>
				<span className="connector-table-status">{rowStatus}</span>
			</span>
			{!readOnly && (
				<div className="connector-row-actions">
						<button
							className="inline-action"
							disabled={busy !== null}
							onClick={() => void run("test", async () => {
								const result = await testMcpServer(server.name);
								setBusy(null);
								if (result.ok && server.auth.explicit && !server.auth.hasStoredTokens) {
									setOutcome({ text: "Reachable, but not logged in yet. Use Log in below.", tone: "error" });
									await onChanged();
								} else if (result.ok) {
									setOutcome({ text: "Connection OK", tone: "ok" });
									setNeedsAuthSeen(false);
									await onChanged();
								} else if (result.needsAuth) {
									setNeedsAuthSeen(true);
									setOutcome({ text: "This connector needs a login. Use Log in below.", tone: "error" });
									await onChanged();
								} else {
									setOutcome({ text: `Connection failed: ${result.error}`, tone: "error" });
								}
							})}
						>
							{busy === "test" ? "Testing…" : "Test"}
						</button>
						{showLogin && busy !== "login" && (
							<button
								className="inline-action connector-action-primary"
								disabled={busy !== null}
								onClick={() => void run("login", async () => {
									await startMcpServerLogin(server.name);
									pollLogin(Date.now() + 3 * 60_000);
								})}
							>
								Log in
							</button>
						)}
						{busy === "login" && (
							<button
								className="inline-action"
								onClick={() => void (async () => {
									if (loginPollRef.current !== null) window.clearTimeout(loginPollRef.current);
									try {
										await cancelMcpServerLogin(server.name);
									} catch {
										// the attempt also dies on its own timeout
									}
									setBusy(null);
									setOutcome({ text: "Login cancelled.", tone: "ok" });
								})()}
							>
								Cancel login
							</button>
						)}
						{canLogin && server.auth.hasStoredTokens && (
							<button
								className="inline-action"
								disabled={busy !== null}
								onClick={() => void run("logout", async () => {
									await logoutMcpServer(server.name);
									setBusy(null);
									onNotice(`Cleared the stored login for ${server.name}.`);
									await onChanged();
								})}
							>
								{busy === "logout" ? "Clearing…" : "Log out"}
							</button>
						)}
						{confirmRemove ? (
							<>
								<button
									className="inline-action connector-action-danger"
									disabled={busy !== null}
									onClick={() => void run("remove", async () => {
										await removeMcpServer(server.name);
										setBusy(null);
										onNotice(`Removed ${server.name}. Rooms pick it up the next time you enter or resume them.`);
										await onChanged();
									})}
								>
									{busy === "remove" ? "Removing…" : "Remove"}
								</button>
								<button className="inline-action connector-action-quiet" disabled={busy !== null} onClick={() => setConfirmRemove(false)}>Keep</button>
							</>
						) : (
							<button className="inline-action connector-action-quiet" disabled={busy !== null} onClick={() => setConfirmRemove(true)}>Remove</button>
						)}
				</div>
			)}
			{outcome && (
				<span className={`connector-row-outcome${outcome.tone === "error" ? " connector-outcome-error" : ""}`}>{outcome.text}</span>
			)}
			{expanded && (
				<div className="connector-row-expansion">
					{catalogEntry?.description && <p className="connector-expansion-desc">{catalogEntry.description}</p>}
					{server.tools &&
						(server.tools.names.length > 0 ? (
							<div className="connector-tool-chips" aria-label={`${server.tools.count} tools`}>
								{(showAllTools ? server.tools.names : server.tools.names.slice(0, 8)).map((toolName, i) => (
									<span key={`${toolName}-${i}`} className="connector-tool-chip">{toolName}</span>
								))}
								{server.tools.names.length > 8 && (
									<button type="button" className="connector-tool-chip connector-tool-chip-more" onClick={() => setShowAllTools((value) => !value)}>
										{showAllTools ? "show fewer" : `and ${server.tools.names.length - 8} more`}
									</button>
								)}
							</div>
						) : (
							<p className="connector-expansion-desc">{server.tools.count} tool{server.tools.count === 1 ? "" : "s"}</p>
						))}
					{expansionMeta && <p className="connector-expansion-meta">{expansionMeta}</p>}
				</div>
			)}
		</div>
	);
}

function AddConnectorForm({ onAdded, onCancel, prefill }: { onAdded: () => Promise<void>; onCancel: () => void; prefill?: AddConnectorPrefill }) {
	const [name, setName] = useState(prefill?.name ?? "");
	const [kind, setKind] = useState<"url" | "command">("url");
	const [url, setUrl] = useState(prefill?.url ?? "");
	const [bearerToken, setBearerToken] = useState("");
	const [command, setCommand] = useState("");
	const [showOAuthClient, setShowOAuthClient] = useState(prefill?.openOAuthClient ?? false);
	const [oauthClientId, setOauthClientId] = useState("");
	const [oauthClientSecret, setOauthClientSecret] = useState("");
	const [oauthScope, setOauthScope] = useState("");
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const blockRef = useRef<HTMLDivElement | null>(null);

	// The "Add custom" card that opens this form sits at the end of the grid,
	// below where the form appears — bring the form to the user.
	useEffect(() => {
		blockRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
	}, []);

	async function save() {
		setSaving(true);
		setError(null);
		try {
			if (kind === "url") {
				const clientId = oauthClientId.trim();
				await addMcpServer({
					name: name.trim(),
					url: url.trim(),
					bearerToken: bearerToken.trim() || undefined,
					oauth: clientId ? { clientId, clientSecret: oauthClientSecret.trim() || undefined, scope: oauthScope.trim() || undefined } : undefined,
				});
			} else {
				const parts = command.trim().split(/\s+/);
				await addMcpServer({ name: name.trim(), command: parts[0] ?? "", args: parts.slice(1) });
			}
			await onAdded();
		} catch (e) {
			setError((e as Error).message);
		} finally {
			setSaving(false);
		}
	}

	return (
		<div className="ai-setup-block" aria-label="Custom connector" ref={blockRef}>
			<h3>Custom connector</h3>
			{prefill?.note && <p className="cli-note">{prefill.note}</p>}
			<div className="connector-form">
				<label className="connector-form-field">
					<span>Name</span>
					<input type="text" value={name} placeholder="linear" onChange={(e) => setName(e.target.value)} />
				</label>
				<div className="connector-form-kind" role="radiogroup" aria-label="Connector type">
					<label><input type="radio" checked={kind === "url"} onChange={() => setKind("url")} /> Remote server (URL)</label>
					<label><input type="radio" checked={kind === "command"} onChange={() => setKind("command")} /> Local server (command)</label>
				</div>
				{kind === "url" ? (
					<>
						<label className="connector-form-field">
							<span>Server URL</span>
							<input type="text" value={url} placeholder="https://mcp.linear.app/mcp" onChange={(e) => setUrl(e.target.value)} />
						</label>
						<label className="connector-form-field">
							<span>API token (optional, for servers that use a bearer token instead of a login)</span>
							<input type="password" value={bearerToken} placeholder="leave empty for OAuth or public servers" onChange={(e) => setBearerToken(e.target.value)} />
						</label>
						<button type="button" className="connector-oauth-toggle" onClick={() => setShowOAuthClient((current) => !current)} aria-expanded={showOAuthClient}>
							{showOAuthClient ? "▾" : "▸"} Custom OAuth client (for providers without automatic registration, like HubSpot)
						</button>
						{showOAuthClient && (
							<div className="connector-oauth-fields">
								<p className="cli-note">Create an app in the provider's developer settings with the redirect URL <code>http://localhost:19876/callback</code>, then paste its credentials here. Login opens the provider's normal consent screen.</p>
								<label className="connector-form-field">
									<span>Client ID</span>
									<input type="text" value={oauthClientId} onChange={(e) => setOauthClientId(e.target.value)} />
								</label>
								<label className="connector-form-field">
									<span>Client secret (optional, for confidential clients)</span>
									<input type="password" value={oauthClientSecret} onChange={(e) => setOauthClientSecret(e.target.value)} />
								</label>
								<label className="connector-form-field">
									<span>Scopes (optional, space-separated)</span>
									<input type="text" value={oauthScope} placeholder="crm.objects.contacts.read" onChange={(e) => setOauthScope(e.target.value)} />
								</label>
							</div>
						)}
					</>
				) : (
					<label className="connector-form-field">
						<span>Command</span>
						<input type="text" value={command} placeholder="npx -y @modelcontextprotocol/server-filesystem /path/to/root" onChange={(e) => setCommand(e.target.value)} />
					</label>
				)}
				{error && <div className="checkpoint-proposal-error">{error}</div>}
				<div className="ai-setup-actions">
					<button className="landing-action" disabled={saving || !name.trim() || (kind === "url" ? !url.trim() : !command.trim())} onClick={() => void save()}>
						{saving ? "Saving…" : "Save connector"}
					</button>
					<button className="landing-action secondary" disabled={saving} onClick={onCancel}>Cancel</button>
				</div>
				<p className="cli-note">Saved to ~/.exxperts/agent/mcp.json. Test the connection afterwards. It will tell you if the server needs a login.</p>
			</div>
		</div>
	);
}

function ConnectorAvatar({ id, name, size = 34 }: { id: string; name: string; size?: number }) {
	const icon = CONNECTOR_ICONS[id];
	const glyph = Math.round(size * 0.55);
	return (
		<span className="connector-avatar" style={{ width: size, height: size }}>
			{icon ? (
				<svg viewBox="0 0 24 24" width={glyph} height={glyph} aria-hidden="true"><path d={icon} fill="currentColor" /></svg>
			) : (
				name.slice(0, 1).toUpperCase()
			)}
		</span>
	);
}

const KIND_LABELS: Record<ConnectorCatalogEntry["kind"], string> = {
	open: "no login",
	oauth: "one-click login",
	token: "API token",
	"oauth-client": "OAuth app",
	guided: "needs setup",
};

/** Prefill for the custom form when a directory card routes into it. */
export interface AddConnectorPrefill {
	name?: string;
	url?: string;
	note?: string;
	openOAuthClient?: boolean;
}

function DirectoryCard({ entry, installed, onAdd, onOpenCustom }: { entry: ConnectorCatalogEntry; installed: boolean; onAdd: (entry: ConnectorCatalogEntry, token?: string) => Promise<void>; onOpenCustom: (prefill?: AddConnectorPrefill) => void }) {
	const [tokenOpen, setTokenOpen] = useState(false);
	const [token, setToken] = useState("");
	const [adding, setAdding] = useState(false);
	const [error, setError] = useState<string | null>(null);

	async function add(withToken?: string) {
		setAdding(true);
		setError(null);
		try {
			await onAdd(entry, withToken);
			setTokenOpen(false);
			setToken("");
		} catch (e) {
			setError((e as Error).message);
		} finally {
			setAdding(false);
		}
	}

	// One small square + carries what the old per-kind buttons did: open and
	// oauth entries add directly, token entries open the inline token row,
	// oauth-client entries open the prefilled custom form. Guided entries
	// link out to their setup guide. The kind label beside the name says
	// which flow the + opens.
	const addLabel =
		entry.kind === "token" ? `Add ${entry.name} with an API token` : entry.kind === "oauth-client" ? `Add ${entry.name} with an OAuth app` : `Add ${entry.name}`;

	return (
		<article className="connector-dir-card">
			<div className="connector-dir-card-row">
				<ConnectorAvatar id={entry.id} name={entry.name} size={40} />
				<div className="connector-dir-body">
					<div className="connector-dir-title">
						<strong>{entry.name}</strong>
						<span className="connector-dir-kind">{KIND_LABELS[entry.kind]}</span>
					</div>
					<p className="connector-dir-desc" title={entry.description}>{entry.description}</p>
				</div>
				{installed ? (
					<span className="connector-dir-add connector-dir-added" title="Added" aria-label={`${entry.name} is added`}>✓</span>
				) : entry.kind === "guided" ? (
					entry.docsUrl && (
						<a className="connector-dir-add" href={entry.docsUrl} target="_blank" rel="noreferrer" title="Setup guide" aria-label={`${entry.name} setup guide`}>↗</a>
					)
				) : (
					<button
						className="connector-dir-add"
						disabled={adding || (entry.kind === "token" && tokenOpen)}
						title={addLabel}
						aria-label={addLabel}
						aria-expanded={entry.kind === "token" ? tokenOpen : undefined}
						onClick={() => {
							if (entry.kind === "oauth-client") onOpenCustom({ name: entry.id, url: entry.url, note: entry.guideNote, openOAuthClient: true });
							else if (entry.kind === "token") setTokenOpen(true);
							else void add();
						}}
					>
						{adding ? "…" : "+"}
					</button>
				)}
			</div>
			{tokenOpen && !installed && (
				<div className="connector-dir-actions">
					<input
						type="password"
						className="connector-dir-token-input"
						placeholder={entry.tokenHint ?? "API token"}
						value={token}
						onChange={(e) => setToken(e.target.value)}
					/>
					<button className="inline-action" disabled={adding || !token.trim()} onClick={() => void add(token.trim())}>
						{adding ? "Adding…" : "Add"}
					</button>
					<button className="inline-action" disabled={adding} onClick={() => setTokenOpen(false)}>Cancel</button>
					{entry.docsUrl && (
						<a className="connector-dir-token-guide" href={entry.docsUrl} target="_blank" rel="noreferrer">
							Where do I get one? ↗
						</a>
					)}
				</div>
			)}
			{error && <p className="connector-dir-note connector-outcome-error">{error}</p>}
		</article>
	);
}

function ConnectorDirectory({ status, onChanged, onNotice, customOpen, onOpenCustom, customForm }: { status: McpConnectorsStatusResponse | null; onChanged: () => Promise<void>; onNotice: (text: string) => void; customOpen: boolean; onOpenCustom: (prefill?: AddConnectorPrefill) => void; customForm: React.ReactNode }) {
	const [query, setQuery] = useState("");

	const configured = status?.servers ?? [];
	const isInstalled = (entry: ConnectorCatalogEntry) =>
		configured.some((server) => server.name === entry.id || (entry.url && server.target === entry.url));

	const q = query.trim().toLowerCase();
	const entries = CONNECTOR_CATALOG.filter(
		(entry) => !q || entry.name.toLowerCase().includes(q) || entry.description.toLowerCase().includes(q),
	);

	async function add(entry: ConnectorCatalogEntry, token?: string) {
		await addMcpServer({ name: entry.id, url: entry.url, bearerToken: token });
		onNotice(
			entry.kind === "oauth"
				? `${entry.name} added. Use “Log in” on its row above to connect your account.`
				: `${entry.name} added. Rooms pick it up the next time you enter or resume them.`,
		);
		await onChanged();
	}

	return (
		<section className="ai-setup-section" aria-label="Connector directory">
			<h3 className="web-search-fallback-heading">Add</h3>
			<p className="ai-setup-copy web-search-fallback-copy">Verified servers, one click to add. Same list on the web and in the CLI.</p>
			<input
				type="search"
				className="connector-dir-search"
				placeholder="Search connectors…"
				value={query}
				onChange={(e) => setQuery(e.target.value)}
				aria-label="Search connectors"
			/>
			{customForm}
			<div className="connector-dir-grid">
				{entries.map((entry) => (
					<DirectoryCard key={entry.id} entry={entry} installed={isInstalled(entry)} onAdd={add} onOpenCustom={onOpenCustom} />
				))}
				{entries.length === 0 && <p className="cli-note">No matches. Use the custom connector card to add one.</p>}
				<article className="connector-dir-card connector-dir-custom">
					<div className="connector-dir-card-row">
						<span className="connector-avatar" style={{ width: 40, height: 40 }}>+</span>
						<div className="connector-dir-body">
							<div className="connector-dir-title">
								<strong>Custom connector</strong>
								<span className="connector-dir-kind">custom</span>
							</div>
							<p className="connector-dir-desc">Add any MCP server that isn't in the list.</p>
						</div>
						<button className="connector-dir-add" onClick={() => onOpenCustom()} disabled={customOpen} title={customOpen ? "Fill in the form above" : "Add a custom connector"} aria-label="Add a custom connector">+</button>
					</div>
				</article>
			</div>
		</section>
	);
}

export function ConnectorsPage() {
	const [status, setStatus] = useState<McpConnectorsStatusResponse | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [loading, setLoading] = useState(true);
	const [addOpen, setAddOpen] = useState(false);
	const [expandedRow, setExpandedRow] = useState<string | null>(null);
	const [addPrefill, setAddPrefill] = useState<AddConnectorPrefill | undefined>(undefined);
	const [notice, setNotice] = useState<string | null>(null);
	// Remote devices may read connector status, but the server's remote route
	// policy keeps add, remove, login, logout, and test local-only, so the
	// whole section renders read-only over the tunnel.
	const remoteClient = useRemoteClientContext();

	const refresh = useCallback(async () => {
		setLoading(true);
		setError(null);
		try {
			setStatus(await fetchMcpConnectorsStatus());
		} catch (e) {
			setError((e as Error).message);
		} finally {
			setLoading(false);
		}
	}, []);

	useEffect(() => {
		void refresh();
	}, [refresh]);

	const servers = status?.servers ?? [];
	const exxSource = status?.configSources.find((source) => source.path.includes(".exxperts"));
	const sharedSource = status?.configSources.find((source) => !source.path.includes(".exxperts"));

	return (
		<>
			<section className="ai-setup-section" aria-label="MCP connectors">
				<h3 className="web-search-fallback-heading">Available</h3>
				{notice && <p className="cli-note" role="status">{notice}</p>}
				{error && <div className="checkpoint-proposal-error">{error}</div>}
				{!error && loading && !status && <p className="ai-setup-copy">Loading connectors…</p>}
				{!error && servers.length > 0 && (
					<>
						<div className="connector-rows connector-table" aria-label="Configured MCP servers">
							<div className="settings-table-head connector-table-head" aria-hidden="true">
								<span className="connector-table-head-name">Connector</span>
								<span>Type</span>
								<span>Status</span>
								<span />
							</div>
							{servers.map((server) => (
								<ConnectorRow
									key={server.name}
									server={server}
									expanded={expandedRow === server.name}
									onToggle={() => setExpandedRow((current) => (current === server.name ? null : server.name))}
									onChanged={refresh}
									onNotice={setNotice}
									readOnly={remoteClient.remote}
								/>
							))}
						</div>
						{remoteClient.remote ? (
							<p className="cli-note">Connectors are set up and signed in on the computer itself.</p>
						) : (
							<p className="cli-note">Rooms choose their connectors in room settings.</p>
						)}
					</>
				)}
				{!error && !loading && servers.length === 0 && (
					remoteClient.remote ? (
						<p className="cli-note">Connectors are set up and signed in on the computer itself.</p>
					) : (
						<p className="ai-setup-copy">No connectors yet. Add one from the directory below.</p>
					)
				)}
			</section>
			{!remoteClient.remote && (
				<ConnectorDirectory
					status={status}
					onChanged={refresh}
					onNotice={setNotice}
					customOpen={addOpen}
					onOpenCustom={(prefill) => {
						setAddPrefill(prefill);
						setAddOpen(true);
					}}
					customForm={
						addOpen ? (
							<AddConnectorForm
								key={addPrefill?.name ?? "blank"}
								prefill={addPrefill}
								onAdded={async () => {
									setAddOpen(false);
									setAddPrefill(undefined);
									setNotice(APPLY_NOTE);
									await refresh();
								}}
								onCancel={() => {
									setAddOpen(false);
									setAddPrefill(undefined);
								}}
							/>
						) : null
					}
				/>
			)}
			{status && (
				<section className="ai-setup-section connector-config-note" aria-label="Where connectors are stored">
					<details className="remote-fold">
						<summary>Where this list lives</summary>
						<p className="cli-note">
							Saved to <code>{exxSource?.path ?? "~/.exxperts/agent/mcp.json"}</code>.
							{sharedSource && (
								<> The shared <code>{sharedSource.path}</code>, used by Cursor, Claude, and other MCP tools, works here too.</>
							)}
						</p>
						<p className="cli-note">
							In the CLI, <code>/mcp</code> shows the same list with live connection state; project folders can add their
							own via a local <code>.mcp.json</code>. Full reference: <code>docs/mcp.md</code>.
						</p>
					</details>
					<p className="cli-note">All product names and logos are trademarks of their respective owners, used for identification only.</p>
				</section>
			)}
		</>
	);
}
