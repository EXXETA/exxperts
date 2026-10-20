import { useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { SkillListItem } from "../skills-api";
import { acceptLibraryMaterials, applySkillLibraryUpdate, discoverRepoMaterials, fetchLibraryMaterials, fetchRepoCandidate, fetchSkillUpdateCandidate, importRepoSkill, isRepoSnapshotExpired, prepareLibraryMaterials, previewLibraryMaterial, previewRepoFile, reconcileSkillLibrary, saveSkillLibrary, scanSkillLibrary, withRepositoryProgress, type RepositoryProgress, type LibraryMaterialsCandidate, type LibraryMaterialsManifest, type ReferenceKind, type RepoDiscoveryProposal, type RepoScanResponse, type RepoSkillCandidate, type SkillLibrary, type SkillUpdateCandidate } from "../skills-repo-api";
import { MaterialSelectionTree } from "./MaterialSelectionTree";
import { RepoRepositoryBrowser } from "./RepoRepositoryBrowser";
import { skillBelongsToLibrary } from "../skill-source-copy";
import { SkillFileButton, SkillPreviewActive } from "./SkillFileButton";
import { SkillWarnings } from "./skill-facts";
import { RsInfo } from "./rs-info";
import { RepositorySignIn } from "./RepositorySignIn";
import { isRepositorySignInRequired } from "../skills-repo-api";

function RepoSnapshotRecovery({ busy, error, onRefresh, onCancel, cancelLabel = "Cancel" }: { busy: boolean; error: string | null; onRefresh: () => void; onCancel: () => void; cancelLabel?: string }) {
	return (
		<div className="skill-import-found" role="alert">
			<h3>Repository review needs a fresh scan</h3>
			<p className="ai-setup-copy">The temporary snapshot expired or the server restarted. Your file choices are kept. Scan again, then review the current instructions and references before accepting. Nothing is imported automatically.</p>
			{error && <div className="checkpoint-proposal-error">{error}</div>}
			<div className="skill-review-actions">
				<button className="rs-btn" disabled={busy} onClick={onCancel}>{cancelLabel}</button>
				<button className="rs-btn rs-btn-primary" disabled={busy} onClick={onRefresh}>{busy ? "Scanning…" : "Scan again and keep selection"}</button>
			</div>
		</div>
	);
}

function SkillUpdateReviewInfo({ candidate }: { candidate: SkillUpdateCandidate }) {
	return <>
		<p className="ai-setup-copy">{candidate.affectedRooms.length ? `These rooms will need a fresh review: ${candidate.affectedRooms.map((room) => room.name).join(", ")}. After saving, use Update rooms to confirm them together.` : "This skill is not enabled in a room yet."}</p>
		<div className="skill-update-changes">
			{candidate.changes.map((change) => <details key={change.path}><summary>{change.status}: {change.path}</summary>{change.before === undefined && change.after === undefined ? <p className="cli-note">Attachment changed. Review its metadata and download the new version below.</p> : <div className="skill-update-diff"><div><strong>Current</strong><pre className="skill-reference-preview">{change.before ?? "(File absent)"}</pre></div><div><strong>New</strong><pre className="skill-reference-preview">{change.after ?? "(File absent)"}</pre></div></div>}</details>)}
		</div>
	</>;
}

interface ReviewedSkill { path: string; candidate: RepoSkillCandidate | SkillUpdateCandidate; update: boolean }
interface ImportReview { skills: ReviewedSkill[]; materials: LibraryMaterialsCandidate }
const message = (error: unknown) => error instanceof Error ? error.message : String(error);
const formatLabels: Record<ReferenceKind, string> = { markdown: "Markdown", text: "Text / JSON", styles: "CSS / SCSS", html: "HTML", svg: "SVG", pdf: "PDF", word: "Word", excel: "Excel", images: "Images", fonts: "Fonts" };

function ImportProgress({ progress }: { progress: RepositoryProgress }) {
	const [seconds, setSeconds] = useState(0);
	useEffect(() => { const start = Date.now(); const timer = setInterval(() => setSeconds(Math.floor((Date.now() - start) / 1000)), 1000); return () => clearInterval(timer); }, []);
	return <div className="repo-import-progress" role="status"><span>{progress.message}{progress.completed !== undefined && <> · {progress.completed}{progress.total !== undefined ? ` / ${progress.total}` : ""}</>}</span><span className="cli-note" aria-hidden="true">{seconds}s elapsed</span><progress aria-label={progress.message} max={progress.total || 1} value={progress.total ? progress.completed : undefined} /></div>;
}

export function GuidedLibraryImport({ library: initialLibrary, initialScan, installed, onImported, onCancel, onBusyChange }: { library: SkillLibrary; initialScan?: RepoScanResponse; installed: SkillListItem[]; onImported: () => void; onCancel: () => void; onBusyChange?: (busy: boolean) => void }) {
	const previewActive = useContext(SkillPreviewActive);
	const [library, setLibrary] = useState(initialLibrary);
	const [scan, setScan] = useState<RepoScanResponse | null>(initialScan ?? null);
	const [view, setView] = useState<"skills" | "files">("skills");
	const [focusSkill, setFocusSkill] = useState<string | null>(null);
	const skillInputs = useRef(new Map<string, HTMLInputElement>());
	useEffect(() => { if (view === "skills" && focusSkill !== null) { const input = skillInputs.current.get(focusSkill); input?.focus(); input?.scrollIntoView?.({ block: "nearest" }); } }, [view, focusSkill]);
	const [discoveryKey, setDiscoveryKey] = useState<string | null>(null);
	const [discovery, setDiscovery] = useState<RepoDiscoveryProposal | null>(null);
	const [currentMaterials, setCurrentMaterials] = useState<LibraryMaterialsManifest | null>(null);
	const [selectedSkills, setSelectedSkills] = useState<Set<string>>(new Set(initialScan?.skills.map((skill) => skill.path) ?? []));
	const [selectedFiles, setSelectedFiles] = useState<Set<string>>(new Set());
	const [linked, setLinked] = useState(true);
	const [additional, setAdditional] = useState(false);
	const [working, setBusy] = useState(true);
	const [accessBusy, setAccessBusy] = useState(false);
	const busy = working || accessBusy;
	const [progress, setProgress] = useState<RepositoryProgress>({ message: "Reading repository structure" });
	const progressAbort = useRef(new AbortController());
	async function track<T>(message: string, work: (id: string) => Promise<T>, counts?: Pick<RepositoryProgress, "completed" | "total">): Promise<T> {
		setProgress({ message, ...counts });
		return withRepositoryProgress(work, setProgress, progressAbort.current.signal);
	}
	const [error, setError] = useState<string | null>(null);
	const [signInRequired, setSignInRequired] = useState(false);
	const [expired, setExpired] = useState(false);
	const [review, setReview] = useState<ImportReview | null>(null);
	const heading = useRef<HTMLHeadingElement>(null);
	const selectionScroll = useRef<number | null>(null);
	useLayoutEffect(() => {
		const pane = heading.current?.closest<HTMLElement>(".settings-dialog-pane");
		if (!pane) return;
		if (review) pane.scrollTop = 0;
		else if (selectionScroll.current !== null) { pane.scrollTop = selectionScroll.current; selectionScroll.current = null; }
	}, [review]);
	const [completed, setCompleted] = useState<Set<string>>(new Set());
	const [materialsDone, setMaterialsDone] = useState(false);
	const [failures, setFailures] = useState<Record<string, string>>({});
	useEffect(() => { onBusyChange?.(busy); }, [busy, onBusyChange]);
	const initialized = useRef(false);
	const selectionInitialized = useRef(!!initialScan);
	const discoveryAttempt = useRef(0);
	const previousReferences = useRef(new Set<string>());
	const selectedRef = useRef(selectedSkills);
	selectedRef.current = selectedSkills;
	const boundSkill = (skillPath: string) => installed.find((skill) => skillBelongsToLibrary(skill.provenance?.repo, library) && skill.provenance!.repo!.skillPath === skillPath);
	const proposalKey = (snapshot: RepoScanResponse, paths: Iterable<string>) => JSON.stringify([snapshot.token, [...paths].sort(), snapshot.policy]);
	const discoveryValid = !!scan && !!discovery && discoveryKey === proposalKey(scan, selectedSkills);
	function invalidateDiscovery() { setDiscovery(null); setDiscoveryKey(null); }

	function showError(value: unknown) {
		setError(message(value));
		setSignInRequired(isRepositorySignInRequired(value));
		if (isRepoSnapshotExpired(value) || /material review expired/i.test(message(value))) { setExpired(true); setReview(null); }
	}
	function adoptDiscovery(next: RepoDiscoveryProposal, saved: LibraryMaterialsManifest | null, first = false) {
		setDiscovery(next);
		const previouslyReferenced = previousReferences.current;
		setSelectedFiles((previous) => {
			const chosen = new Set(previous);
			if (first) for (const file of saved?.files ?? []) chosen.add(file.path);
			if (linked) for (const file of next.referenced) if (file.allowed && (first || !previouslyReferenced.has(file.path))) chosen.add(file.path);
			if (additional) for (const file of next.additional) if (file.allowed) chosen.add(file.path);
			return chosen;
		});
		previousReferences.current = new Set(next.referenced.filter((file) => file.allowed).map((file) => file.path));
	}
	async function load(forceRefresh = false) {
		setBusy(true); setError(null); setReview(null); invalidateDiscovery();
		const attempt = ++discoveryAttempt.current;
		try {
			const fresh = forceRefresh || !scan ? await track("Reading repository · anonymous Git or public API unless access is granted", (progressId) => scanSkillLibrary(library.id, { ...(forceRefresh ? { forceRefresh: true } : {}), progressId })) : scan;
			const paths = selectionInitialized.current ? [...selectedRef.current].filter((original) => fresh.skills.some((skill) => skill.path === original)) : fresh.skills.map((skill) => skill.path);
			setScan(fresh);
			if (!selectionInitialized.current) setSelectedSkills(new Set(paths));
			selectionInitialized.current = true;
			const [proposal, saved] = await Promise.all([track("Finding linked references", (id) => discoverRepoMaterials(fresh.token, paths, id)), fetchLibraryMaterials(library.id)]);
			if (attempt !== discoveryAttempt.current) return;
			setLibrary((previous) => ({ ...previous, source: fresh.source, ref: fresh.ref, ...fresh.policy })); setCurrentMaterials(saved.manifest);
			setDiscoveryKey(proposalKey(fresh, paths));
			adoptDiscovery(proposal, saved.manifest, !initialized.current);
			initialized.current = true;
			setExpired(false); setReview(null);
			setSignInRequired(false);
		} catch (value) { if (attempt === discoveryAttempt.current) showError(value); }
		finally { if (attempt === discoveryAttempt.current) setBusy(false); }
	}
	useEffect(() => { progressAbort.current = new AbortController(); void load(); return () => { discoveryAttempt.current++; progressAbort.current.abort(); }; }, []);

	async function chooseSkills(paths: Set<string>) {
		setSelectedSkills(paths); invalidateDiscovery();
		if (!scan) return;
		const attempt = ++discoveryAttempt.current;
		setBusy(true); setError(null);
		try {
			const proposal = await track("Updating linked references", (id) => discoverRepoMaterials(scan.token, [...paths], id));
			if (attempt === discoveryAttempt.current) { adoptDiscovery(proposal, currentMaterials); setDiscoveryKey(proposalKey(scan, paths)); }
		} catch (value) { if (attempt === discoveryAttempt.current) showError(value); }
		finally { if (attempt === discoveryAttempt.current) setBusy(false); }
	}
	async function changeFormats(allowedTypes: ReferenceKind[]) {
		if (!scan || !discovery) return;
		const previousLibrary = library;
		const next = { ...library, designRepo: library.designRepo || allowedTypes.some((kind) => kind !== "markdown"), allowedTypes };
		let savedLibrary: SkillLibrary | null = null;
		setBusy(true); setError(null); invalidateDiscovery();
		setProgress({ message: "Saving format selection" });
		setLibrary(next);
		try {
			const saved = await saveSkillLibrary(next, library.id);
			savedLibrary = saved.library;
			const fresh = await scanSkillLibrary(library.id, { token: scan.token });
			const proposal = await track("Checking references for selected formats", (id) => discoverRepoMaterials(fresh.token, [...selectedSkills], id));
			setLibrary(saved.library); setScan(fresh);
			adoptDiscovery(proposal, currentMaterials); setDiscoveryKey(proposalKey(fresh, selectedSkills));
			setSelectedFiles((previous) => new Set([...previous].filter((original) => {
				const kind = [...discovery.referenced, ...discovery.additional, ...(currentMaterials?.files ?? [])].find((file) => file.path === original)?.kind;
				return !kind || allowedTypes.includes(kind);
			})));
		} catch (value) {
			setLibrary(previousLibrary);
			if (savedLibrary) {
				let rollbackLibrary = savedLibrary;
				try {
					const restored = await saveSkillLibrary(previousLibrary, library.id);
					rollbackLibrary = restored.library;
					setLibrary(restored.library);
					setScan(await scanSkillLibrary(library.id, { token: scan.token }));
				} catch (rollbackError) { setLibrary(rollbackLibrary); showError(new Error(`${message(value)} Settings could not be restored: ${message(rollbackError)}`)); setBusy(false); return; }
			}
			showError(value);
		}
		finally { setBusy(false); }
	}
	function includeFormats() {
		if (discovery) void changeFormats([...new Set([...library.allowedTypes, ...discovery.formats.filter((format) => format.total > 0).map((format) => format.kind)])]);
	}
	function toggleMaterials(which: "linked" | "additional", enabled: boolean) {
		if (!discovery) return;
		if (which === "linked") setLinked(enabled); else setAdditional(enabled);
		setSelectedFiles((previous) => {
			const next = new Set(previous);
			for (const file of which === "linked" ? discovery.referenced : discovery.additional) if (file.allowed) { if (enabled) next.add(file.path); else next.delete(file.path); }
			return next;
		});
	}
	const files = useMemo(() => discovery ? [...discovery.referenced, ...discovery.additional] : [], [discovery]);
	const referencePaths = useMemo(() => files.map((file) => file.path), [files]);
	const unavailableFiles = discovery ? [...selectedFiles].filter((original) => !files.some((file) => file.path === original && file.allowed)) : [];
	const unavailableSkills = [...selectedSkills].filter((original) => !scan?.skills.some((skill) => skill.path === original));

	async function prepare() {
		if (!scan || !discovery || !discoveryValid) return;
		setBusy(true); setError(null); setFailures({});
		setProgress({ message: "Preparing import review" });
		try {
			if (unavailableFiles.length || unavailableSkills.length) throw new Error("Remove unavailable selections before reviewing.");
			if (discovery.incomplete) throw new Error("Material discovery reached its processing limit. Select fewer skills, then review again.");
			const fresh = scan;
			const skills: ReviewedSkill[] = [];
			const pendingSkills = fresh.skills.filter((item) => selectedSkills.has(item.path) && !completed.has(item.path));
			for (const skill of pendingSkills) {
				const existing = boundSkill(skill.path);
				const associated = discovery.referenced.filter((file) => file.skillPaths.includes(skill.path) && selectedFiles.has(file.path)).map((file) => file.path);
				const references = [...new Set([...associated, ...(existing?.provenance?.repo?.references.filter((file) => selectedFiles.has(file.path)).map((file) => file.path) ?? [])])];
				let candidate: RepoSkillCandidate | SkillUpdateCandidate;
				try { candidate = await track(`Preparing skill: ${skill.name}`, (id) => existing ? fetchSkillUpdateCandidate(library.id, existing.name, references, fresh.token, id) : fetchRepoCandidate(fresh.token, skill.path, references, id), { completed: skills.length, total: pendingSkills.length }); }
				catch (value) { if (isRepoSnapshotExpired(value) || isRepositorySignInRequired(value)) throw value; throw new Error(`Cannot review ${skill.name}: ${message(value)}`); }
				skills.push({ path: skill.path, candidate, update: !!existing });
			}
			const saved = await fetchLibraryMaterials(library.id);
			setCurrentMaterials(saved.manifest);
			const materials = await track("Preparing selected references", (id) => prepareLibraryMaterials(library.id, fresh.token, [...selectedFiles], saved.manifest?.materialsSha256 ?? null, id), { completed: 0, total: selectedFiles.size });
			selectionScroll.current = heading.current?.closest<HTMLElement>(".settings-dialog-pane")?.scrollTop ?? null;
			setReview({ skills, materials }); setMaterialsDone(saved.manifest?.materialsSha256 === materials.manifest.materialsSha256);
		} catch (value) { showError(value); }
		finally { setBusy(false); }
	}
	async function accept() {
		if (!review || !scan) return;
		setBusy(true); setError(null);
		const done = new Set(completed);
		const failed: Record<string, string> = {};
		let savedMaterials = materialsDone;
		for (const item of review.skills) {
			if (done.has(item.path)) continue;
			setProgress({ message: "Saving reviewed skills", completed: done.size, total: review.skills.length });
			try {
				if (item.update && "localPackageSha256" in item.candidate) await applySkillLibraryUpdate(library.id, item.candidate.name, item.candidate);
				else await importRepoSkill(scan.token, item.path, item.candidate.references.map((file) => file.path), item.candidate.reviewSha256);
				done.add(item.path); setCompleted(new Set(done));
			} catch (value) { failed[item.path] = message(value); if (isRepositorySignInRequired(value)) setSignInRequired(true); }
		}
		if (!savedMaterials) {
			try { await track("Saving reviewed references", (id) => acceptLibraryMaterials(library.id, review.materials.candidateSha256, id), { completed: 0, total: review.materials.manifest.files.length }); savedMaterials = true; setMaterialsDone(true); }
			catch (value) { failed.materials = message(value); if (isRepositorySignInRequired(value)) setSignInRequired(true); }
		}
		try { await track("Refreshing library status", () => reconcileSkillLibrary(library.id, scan.token)); }
		catch (value) { failed.status = `Contents saved; update status could not be refreshed: ${message(value)}`; if (isRepositorySignInRequired(value)) setSignInRequired(true); }
		setFailures(failed); setBusy(false);
		if (!Object.keys(failed).length && savedMaterials) onImported();
	}
	const reviewPane = review && <section className="skill-review guided-library-import" aria-label="Review library import">
		<div className="skill-review-scroll"><p className="cli-note">{review.skills.length} skills · {review.materials.manifest.files.length} source materials · commit {scan?.revision.slice(0, 12)}</p>
			{review.skills.map((item) => <details className="skill-library-form" key={item.path}><summary>{item.candidate.name}{completed.has(item.path) ? " · Saved" : item.update ? " · Update" : " · New"}</summary><p>{item.candidate.description}</p><SkillWarnings licenseKnown={!!item.candidate.license} findings={item.candidate.scanFindings.findings} />{"localPackageSha256" in item.candidate && <SkillUpdateReviewInfo candidate={item.candidate} />}<SkillFileButton path={item.path ? `${item.path}/SKILL.md` : "SKILL.md"} body={item.candidate.body} load={(original) => previewRepoFile(scan!.token, original)} referencePaths={referencePaths} /><p className="cli-note">{item.candidate.references.length} references in this skill package</p></details>)}
			<details className="skill-library-form"><summary>Source materials · {review.materials.manifest.files.length}{materialsDone ? " · Saved" : ""}</summary><p className="cli-note">{(review.materials.manifest.files.reduce((sum, file) => sum + file.size, 0) / 1024 / 1024).toFixed(1)} MiB · {review.materials.added.length} added or changed · {review.materials.removed.length} removed</p>{review.materials.removed.length > 0 && <details><summary>Removed from this selection</summary>{review.materials.removed.map((original) => <p key={original} className="cli-note">{original}</p>)}</details>}<MaterialSelectionTree files={review.materials.manifest.files.map((file) => ({ ...file, allowed: true }))} selected={new Set(review.materials.manifest.files.map((file) => file.path))} onChange={() => {}} readOnly disabled={busy} onPreview={(original) => materialsDone ? previewLibraryMaterial(library.id, review.materials.manifest.materialsSha256, original) : previewRepoFile(scan!.token, original)} /></details>
			{Object.keys(failures).length > 0 && <div role="alert" className="checkpoint-proposal-error"><strong>Partly saved. {completed.size} skills saved{materialsDone ? "; source materials saved" : "; source materials pending"}.</strong>{Object.entries(failures).map(([original, reason]) => <p key={original}>{original}: {reason}</p>)}</div>}
			{error && <p role="alert" className="checkpoint-proposal-error">{error}</p>}
		</div><div className="skill-review-actions"><button className="rs-btn" disabled={busy} onClick={onCancel}>{completed.size || materialsDone ? "Close" : "Cancel"}</button><button className="rs-btn" disabled={busy} onClick={() => { setReview(null); setError(null); }}>Change selection</button>{Object.values(failures).some((reason) => /snapshot expired|review expired/i.test(reason)) && <button className="rs-btn" disabled={busy} onClick={() => void load(true)}>Scan again and keep selection</button>}<button className="rs-btn rs-btn-primary" disabled={busy} onClick={() => void accept()}>{busy ? "Saving…" : Object.keys(failures).length ? "Retry failed items" : "Accept and save library"}</button></div>
	</section>;
	return <section className="guided-library-import" aria-label="Add library materials">
		<h3 ref={heading}>{review ? `Review ${library.name}` : library.name}</h3>
		{(!review || signInRequired) && <RepositorySignIn source={library.source} libraryId={library.id} onBusyChange={setAccessBusy} onRetry={() => load(true)} />}
		{review && !signInRequired && <p className="cli-note">Repository access and selected contents reviewed separately{scan?.transport ? ` · Loaded using ${scan.transport === "api" ? "public API" : "Git"}` : ""}.</p>}
		{working && <ImportProgress progress={progress} />}
		<SkillPreviewActive.Provider value={previewActive && !review && !expired}><div hidden={!!review || expired}>
		{scan && <p className="cli-note">{scan.files.length} repository entries · {scan.skills.length} skills found{scan.transport ? ` · Loaded using ${scan.transport === "api" ? "public API" : "Git"}` : ""}</p>}
		{scan && <><div className="skill-repository-views" aria-label="Repository view"><button className="rs-btn" aria-pressed={view === "skills"} onClick={() => setView("skills")}>Skills</button><button className="rs-btn" aria-pressed={view === "files"} onClick={() => setView("files")}>Repository files</button></div><div hidden={view !== "files"}><RepoRepositoryBrowser key={scan.revision} scan={scan} busy={busy} onPreview={(original) => previewRepoFile(scan.token, original)} onOpenSkill={(skill) => { setView("skills"); setFocusSkill(skill.path); }} /></div><div hidden={view !== "skills"}><div className="repo-browser"><h4>Skills · {selectedSkills.size}/{scan.skills.length}</h4><label className="skill-library-check"><input className="workspaces-tool-switch" role="switch" type="checkbox" disabled={busy} checked={scan.skills.length > 0 && scan.skills.every((skill) => selectedSkills.has(skill.path))} onChange={(event) => void chooseSkills(event.target.checked ? new Set(scan.skills.map((skill) => skill.path)) : new Set(completed))} />Select all skills</label>{scan.skills.map((skill) => <label className="skill-library-check" key={skill.path}><input ref={(node) => { if (node) skillInputs.current.set(skill.path, node); else skillInputs.current.delete(skill.path); }} type="checkbox" aria-label={`Select skill ${skill.name}`} disabled={busy || completed.has(skill.path)} checked={selectedSkills.has(skill.path)} onChange={() => { const next = new Set(selectedSkills); if (!next.delete(skill.path)) next.add(skill.path); void chooseSkills(next); }} /><span title={skill.description}>{skill.name}</span>{boundSkill(skill.path) && <span className="cli-note">Review update</span>}{completed.has(skill.path) && <span className="cli-note">Saved</span>}</label>)}</div>
		{discovery && <><div className="skill-library-controls"><label className="skill-library-check"><input className="workspaces-tool-switch" role="switch" type="checkbox" checked={linked} disabled={busy} onChange={(event) => toggleMaterials("linked", event.target.checked)} />Linked materials · {discovery.referenced.length}<RsInfo text="Detected file, folder and nested references are proposed for import. Original paths are preserved. Nothing is saved or made available to a room until review and confirmation." /></label><label className="skill-library-check"><input className="workspaces-tool-switch" role="switch" type="checkbox" checked={additional} disabled={busy} onChange={(event) => toggleMaterials("additional", event.target.checked)} />Select all additional materials · {discovery.additional.length}</label></div>
			{discovery.formats.some((format) => !format.enabled && format.total > 0) && <div className="skill-review-banner"><span>Other formats found: {discovery.formats.filter((format) => !format.enabled && format.total > 0).map((format) => `${format.kind} (${format.total})`).join(", ")}</span><button className="rs-btn" disabled={busy} onClick={() => void includeFormats()}>Include suggested formats</button></div>}
			<details className="skill-library-form"><summary>Formats · {discovery.formats.filter((format) => format.total > 0).length}</summary>{discovery.formats.filter((format) => format.total > 0).map((format) => <label className="skill-library-check" key={format.kind}><input className="workspaces-tool-switch" type="checkbox" role="switch" aria-label={`Include ${formatLabels[format.kind]} materials`} disabled={busy} checked={library.allowedTypes.includes(format.kind)} onChange={(event) => void changeFormats(event.target.checked ? [...library.allowedTypes, format.kind] : library.allowedTypes.filter((kind) => kind !== format.kind))} /><span>{formatLabels[format.kind]} · {format.total}</span></label>)}</details>
			<p className="cli-note">{selectedFiles.size} materials selected <RsInfo text={[...discovery.warnings, `${discovery.missing.length} references missing.`, ...Object.entries(discovery.excludedCounts).map(([reason, count]) => `${count}: ${reason}`)].join(" ")} /></p>
			<MaterialSelectionTree key={scan.revision} files={files} selected={selectedFiles} onChange={setSelectedFiles} disabled={busy} onPreview={(original) => previewRepoFile(scan.token, original)} />
		</>}
		</div></>}
		{unavailableFiles.length + unavailableSkills.length > 0 && <div role="alert" className="checkpoint-proposal-error">Unavailable selections: {[...unavailableFiles, ...unavailableSkills].join(", ")}<button className="rs-btn" disabled={busy} onClick={() => { setSelectedFiles(new Set([...selectedFiles].filter((original) => !unavailableFiles.includes(original)))); void chooseSkills(new Set([...selectedSkills].filter((original) => !unavailableSkills.includes(original)))); }}>Remove unavailable selections</button></div>}
		{discovery?.incomplete && <p role="alert" className="room-skills-warn">Discovery is incomplete. Select fewer skills before reviewing.</p>}
		{error && <div role="alert" className="checkpoint-proposal-error">{error}</div>}
		<div className="skill-review-actions"><button className="rs-btn" disabled={busy} onClick={onCancel}>Cancel</button>{(!scan || !discoveryValid) && !busy && <button className="rs-btn" onClick={() => void load()}>Retry</button>}<button className="rs-btn rs-btn-primary" disabled={busy || !discoveryValid || discovery?.incomplete || unavailableFiles.length > 0 || unavailableSkills.length > 0 || (!selectedSkills.size && !selectedFiles.size)} onClick={() => void prepare()}>Prepare review</button></div>
		</div></SkillPreviewActive.Provider>
		{expired ? <RepoSnapshotRecovery busy={busy} error={error} onRefresh={() => void load(true)} onCancel={onCancel} /> : reviewPane}
	</section>;
}
