import { useCallback, useEffect, useState } from "react";
import { checkSkillLibrary, defaultRepoPolicy, deleteSkillLibrary, fetchFeaturedCatalog, fetchSkillLibraries, peekSkillLibraries, saveSkillLibrary, type SkillLibrary, type SkillLibraryInput } from "../skills-repo-api";
import { fetchSkills, peekSkillSummaries, type SkillListItem } from "../skills-api";
import { confirmDialog } from "./confirm-dialog";
import { GuidedLibraryImport } from "./GuidedLibraryImport";
import { SkillSourceBrowser } from "./SkillSourceBrowser";
import { SkillPreviewActive } from "./SkillFileButton";
import { RsInfo } from "./rs-info";
import { useEscapeKey } from "./use-escape-key";
import { useSkillUpdateNotices } from "../skill-update-notices";
import { LibraryRoomUpdates } from "./LibraryRoomUpdates";
import { SkillRepoPolicy } from "./SkillRepoPolicy";
import { skillBelongsToLibrary } from "../skill-source-copy";
import { SkillLibraryPath, type SkillPathItem } from "./SkillLibraryPath";
import { RepositorySignIn } from "./RepositorySignIn";
import { isRepositorySignInRequired } from "../skills-repo-api";
import { ApiRequestError } from "../api";

const emptyLibrary = (): SkillLibraryInput => ({ name: "", source: "", ref: "", ...defaultRepoPolicy, allowedTypes: [...defaultRepoPolicy.allowedTypes], referenceRoots: [...defaultRepoPolicy.referenceRoots] });
const inputFrom = (library: SkillLibrary): SkillLibraryInput => ({ name: library.name, source: library.source, ref: library.ref, designRepo: library.designRepo, allowedTypes: [...library.allowedTypes], skillRoot: library.skillRoot, referenceRoots: [...library.referenceRoots] });
const origin = (source: string) => { try { return new URL(source).hostname; } catch { return source; } };

function LibrarySettings({ library, onSaved, onBack, onBusyChange }: { library: SkillLibrary; onSaved: () => void; onBack: () => void; onBusyChange: (busy: boolean) => void }) {
	const [input, setInput] = useState(() => inputFrom(library));
	const [saved, setSaved] = useState(input);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	useEffect(() => { onBusyChange(busy); return () => onBusyChange(false); }, [busy, onBusyChange]);
	useEscapeKey(() => { if (!busy) onBack(); });
	async function save(next: SkillLibraryInput) {
		if (JSON.stringify(next) === JSON.stringify(saved)) return;
		setInput(next); setBusy(true); setError(null);
		try { const result = await saveSkillLibrary(next, library.id); const value = inputFrom(result.library); setInput(value); setSaved(value); onSaved(); }
		catch (err) { setInput(saved); setError(err instanceof Error ? err.message : String(err)); }
		finally { setBusy(false); }
	}
	return <section className="skill-library-form" aria-label="Source settings">
		{([ ["name", "Name"], ["source", "Repository URL"], ["ref", "Branch or tag"] ] as const).map(([key, label]) => <label className="skill-library-field" key={key}><span>{label}</span><input className="skill-import-url" value={input[key] ?? ""} disabled={busy} placeholder={key === "ref" ? "Default branch" : undefined} onChange={(event) => setInput({ ...input, [key]: event.target.value })} onBlur={() => void save(input)} onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); }} /></label>)}
		<SkillRepoPolicy value={input} disabled={busy} onChange={(policy, commit) => { const next = { ...input, ...policy }; if (commit) void save(next); else setInput(next); }} />
		<RepositorySignIn source={saved.source} libraryId={library.id} onChanged={onSaved} onBusyChange={setBusy} />
		{error && <div className="checkpoint-proposal-error" role="alert">{error}</div>}
	</section>;
}

export function SkillLibraries({ onImported, startAdding = false, initialLibraryId, onBack, pathPrefix = [] }: { onImported: (name: string) => void; startAdding?: boolean; initialLibraryId?: string; onBack?: () => void; pathPrefix?: SkillPathItem[] }) {
	const [libraries, setLibraries] = useState<SkillLibrary[]>(() => peekSkillLibraries()?.libraries ?? []);
	const [installed, setInstalled] = useState<SkillListItem[]>(() => peekSkillSummaries() ?? []);
	const [loading, setLoading] = useState(!peekSkillLibraries());
	const [selectedId, setSelectedId] = useState<string | null>(initialLibraryId ?? null);
	const [showDetail, setShowDetail] = useState(Boolean(initialLibraryId));
	const [editingId, setEditingId] = useState<string | null>(null);
	const [adding, setAdding] = useState(startAdding);
	const [input, setInput] = useState(emptyLibrary);
	const [featured, setFeatured] = useState<Array<{ source: string; author: string }> | null>(null);
	const [importing, setImporting] = useState<SkillLibrary | null>(null);
	const [menu, setMenu] = useState<string | null>(null);
	const [busy, setBusy] = useState<string | null>(null);
	const [childBusy, setChildBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [signInLibrary, setSignInLibrary] = useState<SkillLibrary | null>(null);
	const [notice, setNotice] = useState<string | null>(null);
	const [roomUpdatesId, setRoomUpdatesId] = useState<string | null>(null);
	const updateNotices = useSkillUpdateNotices();
	const load = useCallback(async (refresh = false) => {
		try { const [sources, skills] = await Promise.all([fetchSkillLibraries({ refresh }), fetchSkills({ summary: true, refresh })]); setLibraries(sources.libraries); setInstalled(skills); setError(null); }
		catch (err) { setError(err instanceof Error ? err.message : String(err)); }
		finally { setLoading(false); }
	}, []);
	useEffect(() => { void load(true); }, [load]);
	useEffect(() => {
		if (!updateNotices.length) return;
		let cancelled = false;
		void fetchSkillLibraries({ refresh: true }).then((result) => { if (!cancelled) { setLibraries(result.libraries); setError(null); } }).catch(() => {});
		return () => { cancelled = true; };
	}, [updateNotices]);
	useEffect(() => {
		if (!menu) return;
		const close = (event: MouseEvent) => { if (!(event.target as Element)?.closest?.(".skill-add-menu-wrap")) setMenu(null); };
		document.addEventListener("mousedown", close);
		return () => document.removeEventListener("mousedown", close);
	}, [menu]);
	const checking = libraries.some((library) => library.status === "checking");
	useEffect(() => {
		if (!checking) return;
		let cancelled = false;
		const timer = setInterval(() => {
			void fetchSkillLibraries({ refresh: true }).then((response) => { if (!cancelled) setLibraries(response.libraries); }).catch((err) => { if (!cancelled) setError(err instanceof Error ? err.message : String(err)); });
		}, 2000);
		return () => { cancelled = true; clearInterval(timer); };
	}, [checking]);
	useEscapeKey(() => { if (busy || childBusy) return; if (menu) setMenu(null); else if (adding) setAdding(false); else if (featured) setFeatured(null); else if (showDetail) setShowDetail(false); else onBack?.(); }, !editingId && !roomUpdatesId && Boolean(menu || adding || featured || showDetail || onBack));
	const selected = libraries.find((library) => library.id === selectedId);
	const editing = libraries.find((library) => library.id === editingId);
	async function add(value: SkillLibraryInput) {
		setBusy("add"); setError(null);
		try {
			const existing = libraries.find((library) => library.source.replace(/\.git$/, "") === value.source.trim().replace(/\.git$/, "") && (library.ref ?? "") === (value.ref ?? ""));
			const library = existing ?? (await saveSkillLibrary(value)).library;
			if (!existing) setLibraries((current) => [...current, library]);
			setAdding(false); setFeatured(null); setImporting(library);
		} catch (err) { setError(err instanceof Error ? err.message : String(err)); }
		finally { setBusy(null); }
	}
	async function check(library: SkillLibrary) {
		setBusy(library.id); setError(null);
		try { const result = await checkSkillLibrary(library.id); if (result.library.status === "error") throw new ApiRequestError(result.library.error || "Repository check failed.", 400, result.library.errorCode); setSignInLibrary(null); const count = result.updates.filter((update) => update.status !== "unchanged" && update.status !== "new").length + (result.library.materialUpdates?.length ?? 0); const additions = result.updates.filter((update) => update.status === "new").length; setNotice(`${library.name}: ${count ? `${count} changes ready to review.` : "Saved contents are up to date."}${additions ? ` ${additions} other skills available to add.` : ""}`); await load(true); }
		catch (err) { setError(err instanceof Error ? err.message : String(err)); if (isRepositorySignInRequired(err)) setSignInLibrary(library); }
		finally { setBusy(null); }
	}
	async function remove(library: SkillLibrary) {
		setMenu(null);
		if (!await confirmDialog({ title: `Remove ${library.name}?`, body: "Removes this source and its update checks. Installed skills and confirmed room copies stay available.", confirmLabel: "Remove source", danger: true })) return;
		setBusy(library.id); setError(null);
		try { await deleteSkillLibrary(library.id); await load(true); }
		catch (err) { setError(err instanceof Error ? err.message : String(err)); }
		finally { setBusy(null); }
	}
	async function showFeatured() {
		setBusy("featured"); setError(null);
		try { setFeatured((await fetchFeaturedCatalog()).sources); }
		catch (err) { setError(err instanceof Error ? err.message : String(err)); }
		finally { setBusy(null); }
	}
	const changed = (name: string) => { onImported(name); void load(true); };
	const nested = Boolean(showDetail || editing || adding || featured || importing || roomUpdatesId);
	const overview = () => { if (busy) return; setShowDetail(false); setEditingId(null); setAdding(false); setFeatured(null); setImporting(null); setRoomUpdatesId(null); };
	const path: SkillPathItem[] = [...pathPrefix, { label: "Skills", onClick: onBack }, { label: "Repositories", ...(nested ? { onClick: overview } : {}) }];
	if (editing) path.push({ label: editing.name }, { label: "Settings" });
	else if (adding) path.push({ label: "Add repository" });
	else if (featured) path.push({ label: "Featured" });
	else if (importing) path.push({ label: importing.name }, { label: "Import" });
	else if (roomUpdatesId) path.push({ label: libraries.find((entry) => entry.id === roomUpdatesId)?.name ?? "Repository" }, { label: "Room updates" });
	else if (showDetail && selected) path.push({ label: selected.name });
	return <section className="skill-libraries" aria-label="Repository libraries">
		<SkillLibraryPath items={path} shared={pathPrefix.length > 0} disabled={Boolean(busy) || childBusy} />
		{error && <div className="checkpoint-proposal-error" role="alert">{error}</div>}
		{signInLibrary && <RepositorySignIn source={signInLibrary.source} libraryId={signInLibrary.id} onBusyChange={setChildBusy} onChanged={() => void load(true)} onRetry={() => check(signInLibrary)} />}
		<div hidden={Boolean(showDetail || editing || adding || featured || importing || roomUpdatesId)}>
			<div className="skill-library-buttons"><button className="rs-btn" disabled={Boolean(busy)} onClick={() => { setAdding(true); setInput(emptyLibrary()); setError(null); }}>Add custom</button><button className="rs-btn" disabled={Boolean(busy)} onClick={() => void showFeatured()}>Add featured</button></div>
			{notice && <p className="cli-note" role="status">{notice}</p>}{loading && !libraries.length && <p className="cli-note">Loading libraries…</p>}{!loading && !libraries.length && <p className="settings-empty">Add a source to keep its skills and materials together.</p>}
			<div className="skill-library-list">{libraries.map((library) => <div className="skill-library-source" key={library.id}>
				<div className="skill-library-source-content">
				<button className="skill-library-source-open" onClick={() => { setSelectedId(library.id); setShowDetail(true); setError(null); }}><strong>{library.name}</strong><span>{origin(library.source)} · {library.installedSkillCount ?? installed.filter((skill) => skillBelongsToLibrary(skill.provenance?.repo, library)).length} skills · {library.materialCount ?? 0} materials</span>{!library.repositoryAccess && <span className="cli-note">Confirm repository access in Settings · startup checks paused</span>}{library.status === "updates" && <span className="skill-library-update">Updates available</span>}{library.status === "checking" && <span className="cli-note">Checking for updates…</span>}{library.error && <span className="room-skill-problem">{library.error}</span>}</button>
				{updateNotices.find((entry) => entry.id === library.id)?.rooms.some((room) => room.reviewRequired) && <button className="rs-text-btn skill-update-notice skill-library-room-update" onClick={() => setRoomUpdatesId(library.id)}>Update rooms…</button>}
				</div><div className="skill-library-source-actions">
				<button className="icon-btn" aria-label={`Check ${library.name} for updates`} title={`Check for updates${library.lastSuccessfulCheckAt ? ` · Last checked ${new Date(library.lastSuccessfulCheckAt).toLocaleString()}` : ""}${library.revision ? ` · Commit ${library.revision.slice(0, 12)}` : ""}`} disabled={Boolean(busy)} onClick={() => void check(library)}>{busy === library.id ? "…" : "↻"}</button>
				<div className="skill-add-menu-wrap"><button className="icon-btn" aria-label={`Actions for ${library.name}`} aria-haspopup="menu" aria-expanded={menu === library.id} onClick={() => setMenu(menu === library.id ? null : library.id)}>⋯</button>{menu === library.id && <div className="skill-add-menu" role="menu"><button className="menu-item" role="menuitem" disabled={Boolean(busy)} onClick={() => { setEditingId(library.id); setMenu(null); setError(null); }}>Settings</button><button className="menu-item" role="menuitem" disabled={Boolean(busy)} onClick={() => void remove(library)}>Remove source</button></div>}</div>
			</div></div>)}</div>
		</div>
		{showDetail && !selected && !loading && <div><p className="settings-empty" role="status">This source is not in your saved libraries. Its approved room references remain available in Room settings.</p></div>}
		{selected && <div hidden={!showDetail || Boolean(editing || adding || featured || importing)}><SkillPreviewActive.Provider value={showDetail}><SkillSourceBrowser key={selected.id} active={showDetail} onBusyChange={setChildBusy} library={selected} initialView={selected.id === initialLibraryId ? "files" : "skills"} skills={installed.filter((skill) => skillBelongsToLibrary(skill.provenance?.repo, selected))} installed={installed} readOnly={false} onImported={changed} /></SkillPreviewActive.Provider></div>}
		{editing && <LibrarySettings key={editing.id} library={editing} onSaved={() => void load(true)} onBack={() => setEditingId(null)} onBusyChange={setChildBusy} />}
		{adding && <form className="skill-library-form" onSubmit={(event) => { event.preventDefault(); void add(input); }}>
			<label className="skill-library-field"><span>Repository URL</span><input className="skill-import-url" autoFocus required placeholder="https://github.com/user/repo" value={input.source} disabled={Boolean(busy)} onChange={(event) => setInput({ ...input, source: event.target.value })} /></label>
			<p className="cli-note">Public repositories are read anonymously using local Git or a supported public repository API. Private repositories ask for access separately. No local Git account or SSH key is used without your permission.</p>
			<details><summary>Advanced</summary>{([ ["name", "Name", "Repository name"], ["ref", "Branch or tag", "Default branch"] ] as const).map(([key,label,placeholder]) => <label className="skill-library-field" key={key}><span>{label}</span><input className="skill-import-url" disabled={Boolean(busy)} placeholder={placeholder} value={input[key] ?? ""} onChange={(event) => setInput({ ...input, [key]: event.target.value })} /></label>)}<SkillRepoPolicy value={input} disabled={Boolean(busy)} onChange={(policy) => setInput({ ...input, ...policy })} />
			</details>
			<div className="skill-review-actions"><button type="button" className="rs-btn" disabled={Boolean(busy)} onClick={() => setAdding(false)}>Cancel</button><button className="rs-btn rs-btn-primary" disabled={Boolean(busy) || !input.source.trim()}>{busy === "add" ? "Reading…" : "Continue"}</button></div>
		</form>}
		{featured && <section aria-label="Featured repositories">{featured.map((source) => <button className="skill-library-source-open skill-featured-source" key={source.source} disabled={Boolean(busy)} onClick={() => void add({ ...emptyLibrary(), source: source.source })}><strong>{source.author}</strong><span>{source.source}</span></button>)}</section>}
		{importing && <GuidedLibraryImport key={importing.id} onBusyChange={setChildBusy} library={importing} installed={installed} onImported={() => { setSelectedId(importing.id); setShowDetail(true); setImporting(null); changed(""); }} onCancel={() => { setImporting(null); void load(true); }} />}
		{roomUpdatesId && <LibraryRoomUpdates libraryId={roomUpdatesId} onBack={() => setRoomUpdatesId(null)} />}
	</section>;
}
