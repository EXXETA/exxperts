import { useEffect, useRef, useState } from "react";
import { repositorySignInStatus, revokeRepositoryAccess, setRepositoryAccess, signInToRepository, type RepositoryAccessContext, type RepositoryAccessMode, type RepositorySignInStatus } from "../skills-repo-api";

export function RepositorySignIn({ source, libraryId, accessId, onRetry, onBusyChange, onChanged }: { source: string; libraryId?: string; accessId?: string; onRetry?: (accessId?: string) => Promise<void>; onBusyChange?: (busy: boolean) => void; onChanged?: () => void }) {
	const [status, setStatus] = useState<RepositorySignInStatus | null>(null);
	const [mode, setMode] = useState<RepositoryAccessMode>("anonymous");
	const [provider, setProvider] = useState<"github" | "gitlab" | undefined>();
	const [apiBaseUrl, setApiBaseUrl] = useState("");
	const [remember, setRemember] = useState(false);
	const [startup, setStartup] = useState(false);
	const [token, setToken] = useState("");
	const [allowStorage, setAllowStorage] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [notice, setNotice] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const [checking, setChecking] = useState(true);
	const login = useRef<AbortController | null>(null);
	const request = useRef(0);
	const context = (): RepositoryAccessContext => ({ libraryId, accessId: status?.accessId ?? accessId, provider, apiBaseUrl: apiBaseUrl.trim() || undefined });
	function adopt(value: RepositorySignInStatus) {
		setStatus(value); setMode(value.mode); setProvider(value.provider ?? undefined);
		setApiBaseUrl(value.apiBaseUrl ?? ""); setRemember(value.rememberLocalAccess); setStartup(value.checkOnStartup); setAllowStorage(false);
	}
	useEffect(() => {
		const controller = new AbortController();
		request.current += 1;
		login.current?.abort(); setBusy(false);
		setStatus(null); setToken(""); setError(null); setNotice(null); setChecking(true); setAllowStorage(false);
		void repositorySignInStatus(source, { libraryId, accessId }, controller.signal).then((value) => { if (!controller.signal.aborted) adopt(value); }).catch((value) => { if (!controller.signal.aborted) setError(value instanceof Error ? value.message : String(value)); }).finally(() => { if (!controller.signal.aborted) setChecking(false); });
		return () => { controller.abort(); request.current += 1; };
	}, [source, libraryId, accessId]);
	useEffect(() => () => login.current?.abort(), []);
	useEffect(() => { onBusyChange?.(busy); return () => onBusyChange?.(false); }, [busy, onBusyChange]);
	async function perform(work: () => Promise<void>) {
		if (busy) return;
		const attempt = request.current;
		setBusy(true); setError(null); setNotice(null);
		try { await work(); }
		catch (value) { if (attempt === request.current) setError(value instanceof Error ? value.message : String(value)); }
		finally { if (attempt === request.current) setBusy(false); }
	}
	async function save() {
		const submittedToken = token;
		setToken("");
		await perform(async () => {
			const value = await setRepositoryAccess(source, context(), { mode, rememberLocalAccess: mode === "local-git" && remember, checkOnStartup: Boolean(libraryId) && startup, provider, apiBaseUrl: apiBaseUrl.trim() || undefined, ...(mode === "session-token" && submittedToken ? { token: submittedToken } : {}) });
			adopt(value); onChanged?.(); setNotice("Repository access saved. Installed skills and room approvals stay available.");
			await onRetry?.(value.accessId);
		});
	}
	async function connect() {
		if (!status?.ready || !status.granted || status.mode !== "local-git" || !status.provider || provider !== status.provider || !allowStorage) return;
		const controller = new AbortController(); login.current = controller;
		await perform(async () => {
			try { await signInToRepository(source, status.provider!, controller.signal, { ...context(), allowCredentialStorage: true }); }
			catch (value) { if (controller.signal.aborted) throw new Error("Sign-in cancelled. Existing saved skills stay available."); throw value; }
			if (!controller.signal.aborted) { setNotice("Sign-in finished. The repository request will be retried; importing still needs your review."); await onRetry?.(status.accessId); }
		});
		login.current = null;
	}
	const customHost = status && !["github.com", "gitlab.com"].includes(status.host);
	const sameMode = status?.mode === mode;
	return <section className="repository-sign-in" aria-label="Repository access">
		<h4>Repository access{status ? ` · ${status.host}` : ""}</h4>
		<p className="cli-note repository-access-source">{source}</p>
		<p className="cli-note">Public repositories are read anonymously using local Git or a supported public repository API. Private access requires your permission. No sign-in starts automatically.</p>
		{checking && <p className="cli-note" role="status">Checking repository access…</p>}
		{status && <>
			<p className="cli-note" role="status">{!status.confirmed ? "Confirm repository access. Automatic startup checks are paused." : status.mode === "anonymous" ? "Anonymous access · no credentials used." : status.granted ? status.mode === "session-token" ? "Session token active until the EXXPERTS server stops, you remove it, or the provider revokes it." : `Local Git access allowed ${status.rememberLocalAccess ? "for this library" : "until the EXXPERTS server stops"}.` : "Access required. Private update checks are paused until you grant access again."}</p>
			{!status.gitAvailable && <p className="cli-note">Git is not installed or available. Supported public repositories can use their API. Private access needs Git; install it separately, then check again.</p>}
			<label className="skill-library-field"><span>Access method</span><select className="skill-import-url" aria-label="Access method" value={mode} disabled={busy} onChange={(event) => { setMode(event.target.value as RepositoryAccessMode); setAllowStorage(false); setToken(""); }}><option value="anonymous">Anonymous · public repositories</option><option value="local-git">Use local Git sign-in</option><option value="session-token">Token for this session only</option></select></label>
			{customHost && <label className="skill-library-field"><span>Repository provider</span><select className="skill-import-url" aria-label="Repository provider" disabled={busy} value={provider ?? ""} onChange={(event) => { setProvider(event.target.value as "github" | "gitlab" || undefined); setAllowStorage(false); }}><option value="">Other Git host</option><option value="github">GitHub Enterprise</option><option value="gitlab">GitLab</option></select></label>}
			{customHost && provider === "gitlab" && <label className="skill-library-field"><span>GitLab API base URL <span className="cli-note">including any installation subpath</span></span><input className="skill-import-url" aria-label="GitLab API base URL" disabled={busy} placeholder={`https://${status.host}/api/v4`} value={apiBaseUrl} onChange={(event) => setApiBaseUrl(event.target.value)} /></label>}
			{mode === "local-git" && <><p className="cli-note">EXXPERTS may read existing Git credential helpers and use saved accounts or SSH keys for this repository. Other Git applications may use the same accounts. Granting access does not start a browser login.</p>{libraryId && <label className="skill-library-check"><input className="workspaces-tool-switch" role="switch" type="checkbox" checked={remember} disabled={busy} onChange={(event) => setRemember(event.target.checked)} />Remember local Git access for this library</label>}</>}
			{mode === "session-token" && <><label className="skill-library-field"><span>Session token</span><input className="skill-import-url" type="password" aria-label="Session token" autoComplete="off" disabled={busy} value={token} placeholder={sameMode && status.granted ? "Token active · enter a new token to replace it" : "Personal access token with repository read access"} onChange={(event) => setToken(event.target.value)} /></label><p className="cli-note">Use the smallest repository read permission available. The token stays in the running EXXPERTS server's memory, never in browser storage, files or Git Credential Manager. It can be reused for updates during this session; after a server restart or profile switch, enter it again.</p></>}
			{libraryId && <label className="skill-library-check"><input className="workspaces-tool-switch" role="switch" type="checkbox" checked={startup} disabled={busy} onChange={(event) => setStartup(event.target.checked)} />Check for updates when EXXPERTS starts</label>}
			{libraryId && <p className="cli-note">Private startup checks need a valid access grant. Session-only access expires with the server; checks then show “Access required” until you grant access again.</p>}
			<div className="skill-library-actions"><button type="button" className="rs-btn rs-btn-primary" disabled={busy || (mode !== "anonymous" && !status.gitAvailable) || (mode === "session-token" && !token && !(sameMode && status.granted))} onClick={() => void save()}>{mode === "anonymous" ? `${status.confirmed ? "Save" : "Confirm"} anonymous access` : mode === "local-git" ? "Allow local Git access" : "Use token for this session"}{onRetry ? " and retry" : ""}</button><button type="button" className="rs-btn" disabled={busy} onClick={() => void perform(async () => { adopt(await repositorySignInStatus(source, context())); })}>Check setup again</button>{(status.confirmed || status.mode !== "anonymous" && status.granted) && <button type="button" className="rs-btn" disabled={busy} onClick={() => { setToken(""); void perform(async () => { adopt(await revokeRepositoryAccess(source, context())); onChanged?.(); setNotice("EXXPERTS access removed. Saved skills remain available. Shared system Git credentials have not been deleted."); }); }}>Remove access</button>}</div>
			{mode === "local-git" && sameMode && status.granted && <>
				{status.issues.map((issue) => <p className="cli-note" key={issue}>{issue}</p>)}
				{status.setupCommands.length > 0 && <div><h4>Setup on this computer</h4><p className="cli-note">Configure this outside EXXPERTS, then choose Check setup again. Replace the placeholders; never put a token in a repository URL.</p><pre>{status.setupCommands.join("\n")}</pre></div>}
				{status.provider === "gitlab" && <p className="cli-note">Git Credential Manager requests GitLab read_repository and write_repository OAuth scopes. EXXPERTS only reads repositories.</p>}
				{status.documentation && <a className="rs-text-btn" href={status.documentation} target="_blank" rel="noreferrer">Official sign-in setup documentation</a>}
				<label className="skill-library-check"><input type="checkbox" checked={allowStorage} disabled={busy} onChange={(event) => setAllowStorage(event.target.checked)} /><span>I agree that this browser login saves credentials in the protected system store. Other Git applications may use them.</span></label>
				<p className="cli-note">For access without saving a system account, choose Token for this session only above.</p>
				<div className="skill-library-actions"><button type="button" className="rs-btn" disabled={busy || !status.ready || provider !== status.provider || !allowStorage} onClick={() => void connect()}>Sign in in browser{onRetry ? " and retry" : ""}</button>{busy && login.current && <button type="button" className="rs-btn" onClick={() => login.current?.abort()}>Cancel sign-in</button>}</div>
			</>}
		</>}
		{busy && <p role="status" className="cli-note">{login.current ? "Complete sign-in in your default browser if prompted. The repository request will be retried afterwards." : "Updating repository access…"}</p>}
		{notice && <p role="status" className="cli-note">{notice}</p>}
		{error && <p className="checkpoint-proposal-error" role="alert">{error}</p>}
		{!status && error && <button type="button" className="rs-btn" disabled={busy} onClick={() => void perform(async () => { adopt(await repositorySignInStatus(source, { libraryId, accessId })); })}>Check setup again</button>}
	</section>;
}
