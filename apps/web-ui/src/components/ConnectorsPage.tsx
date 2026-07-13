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
	if (!server.tools) return "Tools not listed yet. Test the connection below, or just use it in a room.";
	const when = new Date(server.tools.cachedAt).toLocaleString();
	const names = server.tools.names.slice(0, 6).join(", ");
	const more = server.tools.count > 6 ? `, +${server.tools.count - 6} more` : "";
	return `${server.tools.count} tool${server.tools.count === 1 ? "" : "s"}: ${names}${more} · listed ${when}`;
}

interface RowOutcome {
	text: string;
	tone: "ok" | "error" | "progress";
}

function ConnectorRow({ server, onChanged, onNotice }: { server: McpConnectorStatus; onChanged: () => Promise<void>; onNotice: (text: string) => void }) {
	const [busy, setBusy] = useState<"test" | "login" | "logout" | "remove" | null>(null);
	const [confirmRemove, setConfirmRemove] = useState(false);
	// One outcome line per row: each action replaces the previous result.
	const [outcome, setOutcome] = useState<RowOutcome | null>(null);
	const [needsAuthSeen, setNeedsAuthSeen] = useState(false);
	const loginPollRef = useRef<number | null>(null);

	useEffect(() => () => {
		if (loginPollRef.current !== null) window.clearTimeout(loginPollRef.current);
	}, []);

	const knownOpen = CONNECTOR_CATALOG.some((entry) => entry.kind === "open" && entry.url === server.target);
	const auth = authView(server, knownOpen);
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
	const toolsSummary = server.tools ? `${server.tools.count} tool${server.tools.count === 1 ? "" : "s"}` : "Tools not listed yet. Test the connection, or just use it in a room.";
	// The default config file is the same for every row and the page footnote
	// already explains it — only surface the source when it is the odd one out.
	const defaultSource = server.source?.path.includes(".exxperts") && !server.source.importKind;
	const sourceSummary = server.source && !defaultSource ? `from ${server.source.path}${server.source.importKind ? ` (imported from ${server.source.importKind})` : ""}` : "";

	return (
		<div className="connector-row">
			<ConnectorAvatar id={server.name} name={server.name} size={32} />
			<div className="connector-row-main">
				<div className="connector-row-title">
					<strong>{server.name}</strong>
					<span className="connector-row-target">{server.transport === "http" ? server.target : `local: ${server.target}`}</span>
				</div>
				{/* Exactly one meta line per row; transient states replace it. */}
				{busy === "login" ? (
					<span className="connector-row-meta">Waiting for the login to finish in your browser…</span>
				) : outcome ? (
					<span className={`connector-row-meta${outcome.tone === "error" ? " connector-outcome-error" : ""}`}>{outcome.text}</span>
				) : auth.note ? (
					<span className="connector-row-meta">{auth.note}</span>
				) : (
					<span className="connector-row-meta" title={server.tools ? cachedToolsLine(server) : undefined}>
						{toolsSummary}{sourceSummary ? ` · ${sourceSummary}` : ""}
					</span>
				)}
			</div>
			<em className={auth.state}>{auth.label}</em>
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
								setOutcome({ text: `Connection OK · ${result.toolCount} tool${result.toolCount === 1 ? "" : "s"} available.`, tone: "ok" });
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
								{busy === "remove" ? "Removing…" : `Remove ${server.name}`}
							</button>
							<button className="inline-action connector-action-quiet" disabled={busy !== null} onClick={() => setConfirmRemove(false)}>Keep</button>
						</>
					) : (
						<button className="inline-action connector-action-quiet" disabled={busy !== null} onClick={() => setConfirmRemove(true)}>Remove</button>
					)}
			</div>
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

	return (
		<article className="connector-dir-card">
			<div className="connector-dir-head">
				<ConnectorAvatar id={entry.id} name={entry.name} />
				<div>
					<strong>{entry.name}</strong>
					<span className="connector-dir-kind">{KIND_LABELS[entry.kind]}</span>
				</div>
			</div>
			<p className="connector-dir-desc">{entry.description}</p>
			{entry.shortNote && <p className="connector-dir-note">{entry.shortNote}</p>}
			{error && <p className="connector-dir-note connector-outcome-error">{error}</p>}
			<div className="connector-dir-actions">
				{installed ? (
					<span className="connector-dir-added">✓ Added</span>
				) : entry.kind === "guided" ? (
					entry.docsUrl && <a className="inline-action" href={entry.docsUrl} target="_blank" rel="noreferrer">Setup guide ↗</a>
				) : entry.kind === "oauth-client" ? (
					<>
						<button
							className="inline-action"
							onClick={() => onOpenCustom({ name: entry.id, url: entry.url, note: entry.guideNote, openOAuthClient: true })}
						>
							Add with OAuth app
						</button>
						{entry.docsUrl && (
							<a className="connector-dir-token-guide" href={entry.docsUrl} target="_blank" rel="noreferrer">
								Where do I create one? ↗
							</a>
						)}
					</>
				) : entry.kind === "token" ? (
					tokenOpen ? (
						<>
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
						</>
					) : (
						<button className="inline-action" onClick={() => setTokenOpen(true)}>Add with token</button>
					)
				) : (
					<button className="inline-action" disabled={adding} onClick={() => void add()}>
						{adding ? "Adding…" : "Add"}
					</button>
				)}
			</div>
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
			<div className="ai-setup-section-heading">
				<div>
					<h2>Add connectors</h2>
				</div>
			</div>
			<p className="ai-setup-copy">Verified servers, one click to add.</p>
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
					<div className="connector-dir-head">
						<span className="connector-avatar" style={{ width: 34, height: 34 }}>+</span>
						<div>
							<strong>Custom connector</strong>
							<span className="connector-dir-kind">URL, command, or API token</span>
						</div>
					</div>
					<p className="connector-dir-desc">Add any MCP server that isn't in the list.</p>
					<div className="connector-dir-actions">
						<button className="inline-action" onClick={() => onOpenCustom()} disabled={customOpen}>
							{customOpen ? "Fill in the form above" : "Add custom"}
						</button>
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
	const [addPrefill, setAddPrefill] = useState<AddConnectorPrefill | undefined>(undefined);
	const [notice, setNotice] = useState<string | null>(null);

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
	// Reachable = a connection has already succeeded (tools listed) or a login
	// is stored; merely-configured servers still need a test or login.
	const reachable = servers.filter((server) => server.tools || server.auth.hasStoredTokens).length;
	const countLabel = loading && !status ? "checking" : servers.length === 0 ? "none yet" : `${reachable} of ${servers.length} reachable in rooms`;
	const exxSource = status?.configSources.find((source) => source.path.includes(".exxperts"));
	const sharedSource = status?.configSources.find((source) => !source.path.includes(".exxperts"));

	return (
		<>
			<section className="landing-hero ai-setup-hero">
				<h1>Connectors.</h1>
				<p>External MCP servers your rooms can use. Same list on the web and in the CLI.</p>
			</section>
			<section className="ai-setup-section" aria-label="MCP connectors">
				<div className="connector-section-head">
					<h2>Active connections</h2>
					<div className={`ai-setup-status-pill ${reachable > 0 ? "ready" : ""}`}>{countLabel}</div>
				</div>
				{notice && <p className="cli-note" role="status">{notice}</p>}
				{error && <div className="checkpoint-proposal-error">{error}</div>}
				{!error && loading && !status && <p className="ai-setup-copy">Loading connectors…</p>}
				{!error && servers.length > 0 && (
					<div className="connector-rows" aria-label="Configured MCP servers">
						{servers.map((server) => (
							<ConnectorRow key={server.name} server={server} onChanged={refresh} onNotice={setNotice} />
						))}
					</div>
				)}
				{!error && !loading && servers.length === 0 && (
					<p className="ai-setup-copy">No connectors yet. Add one from the directory below.</p>
				)}
			</section>
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
			{status && (
				<section className="ai-setup-section connector-config-note" aria-label="Where connectors are stored">
					<p className="cli-note">
						Connectors you add here are saved to <code>{exxSource?.path ?? "~/.exxperts/agent/mcp.json"}</code>.
						{sharedSource && (
							<> The shared <code>{sharedSource.path}</code>, used by Cursor, Claude, and other MCP tools, works here too.</>
						)}
					</p>
					<p className="cli-note">
						The CLI uses the same list: <code>/mcp</code> shows it with live connection state, and project folders can add
						their own connectors via a local <code>.mcp.json</code>. Full reference: <code>docs/mcp.md</code>.
					</p>
					<p className="cli-note">All product names and logos are trademarks of their respective owners, used for identification only.</p>
				</section>
			)}
		</>
	);
}
