import { useEffect, useMemo, useRef, useState } from "react";
import type { PersistentAgentStatus } from "../types";
import { fetchPersistentRoomSkillSettings, peekPersistentRoomSkillSettings, fetchPersistentRoomSourceReview, updatePersistentRoomSourceSetting, updatePersistentRoomSkillSetting, type PersistentRoomEnabledSkillStatus, type PersistentRoomEnabledSourceStatus, type PersistentRoomSkillSettingsResponse, type PersistentRoomSourceGrant, type PersistentRoomSourceReview } from "../persistent-room-management-api";
import { fetchSkill, fetchSkills, peekSkillSummaries, type SkillDetail, type SkillListItem } from "../skills-api";
import { pausedSkills } from "../paused-skills";
import { FileGroupList, groupFilesByFolder } from "./file-groups";
import { SkillInstructions } from "./skill-instructions";
import { SkillReferences } from "./SkillReferences";
import { fetchLibraryMaterials, fetchSkillLibraries, previewInstalledReference, previewLibraryMaterial, type SkillLibrary, type SkillReference } from "../skills-repo-api";
import { RsInfo } from "./rs-info";
import { PaneHeader } from "./pane-header";
import { fetchRemoteClientContext, showsComputerOnlyControls, useRemoteClientContext } from "../remote-client-context";
import { useSkillUpdateNotices } from "../skill-update-notices";

/** A skill's problem in plain words, under its description; null when it works. */
function skillProblemLine(state: PersistentRoomEnabledSkillStatus): string | null {
	if (state.status === "hash-mismatch") return "Changed since you enabled it. The room stopped using it until you review the new version.";
	if (state.status === "missing") return "Removed from your library, so the room no longer uses it. Remove it here, or import it again.";
	if (state.manualOnly) return "Its author marked it for manual use only. Rooms cannot start a skill by hand yet, so the room does not use it.";
	return null;
}

/** The files line's state: allowed, off, or allowed before and changed since. */
function runFilesLine(executeState: PersistentRoomEnabledSkillStatus["executeState"], count: number): string {
	const one = count === 1;
	if (executeState === "approved") return one ? "Allowed: the room may run its file as it is now." : `Allowed: the room may run its ${count} files as they are now.`;
	if (executeState === "drifted") {
		return one
			? "Its file changed since you allowed it, so it does not run. Turn this on to allow it as it is now."
			: "Its files changed since you allowed them, so they do not run. Turn this on to allow them as they are now.";
	}
	return one ? "Off: the room follows its instructions but does not run its file." : `Off: the room follows its instructions but does not run its ${count} files.`;
}

function RoomSourceReferences({ grant, onManage }: { grant: PersistentRoomSourceGrant; onManage?: () => void }) {
	const [references, setReferences] = useState<SkillReference[] | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [attempt, setAttempt] = useState(0);
	useEffect(() => {
		let cancelled = false;
		setReferences(null); setError(null);
		void fetchLibraryMaterials(grant.libraryId, grant.materialsSha256).then(({ manifest }) => {
			if (!manifest || manifest.materialsSha256 !== grant.materialsSha256) throw new Error("This room's approved references are unavailable.");
			if (!cancelled) setReferences(manifest.files.map((file) => ({ ...file, localPath: file.path })));
		}).catch((value) => { if (!cancelled) setError(value instanceof Error ? value.message : String(value)); });
		return () => { cancelled = true; };
	}, [grant.libraryId, grant.materialsSha256, attempt]);
	return <div className="room-skill-references">
		{onManage && <button className="rs-text-btn" onClick={onManage}>Manage references</button>}
		<RsInfo text="Skills are instructions; references are separate files, counted once even when several skills use them. The room can read every reference approved here. Add more in the source library, then Review changes in this room. Saved copies stay unchanged; the agent creates and edits its outputs in the room workspace." />
		{error ? <div className="checkpoint-proposal-error" role="alert">{error} <button className="rs-text-btn" onClick={() => setAttempt((value) => value + 1)}>Retry</button></div> : references ? <SkillReferences references={references} stored onPreview={(reference) => previewLibraryMaterial(grant.libraryId, grant.materialsSha256, reference)} /> : <p className="cli-note" role="status">Loading local references…</p>}
	</div>;
}

/** Source groups stay compact; individual approvals and exceptions keep their own pins. */
export function RoomSkillsSection({ status, onOpenSkillsLibrary, onPausedCount, refreshKey = 0 }: { status: PersistentAgentStatus; onOpenSkillsLibrary?: (libraryId?: string) => void; refreshKey?: number; onPausedCount?: (count: number) => void }) {
	const remoteClient = useRemoteClientContext();
	const localReferences = showsComputerOnlyControls(remoteClient);
	const updateNotices = useSkillUpdateNotices();
	const [library, setLibrary] = useState<SkillListItem[] | null>(() => peekSkillSummaries() ?? null);
	const [enabled, setEnabled] = useState<PersistentRoomEnabledSkillStatus[] | null>(() => peekPersistentRoomSkillSettings(status.id)?.skills ?? null);
	const [repositories, setRepositories] = useState<SkillLibrary[]>([]);
	const [sources, setSources] = useState<PersistentRoomEnabledSourceStatus[]>([]);
	const [sourceGrants, setSourceGrants] = useState<PersistentRoomSourceGrant[]>([]);
	const [independentNames, setIndependentNames] = useState<ReadonlySet<string>>(new Set());
	const [sourceReview, setSourceReview] = useState<PersistentRoomSourceReview | null>(null);
	const [reviewExclusions, setReviewExclusions] = useState<ReadonlySet<string>>(new Set());
	const [sourceBusyId, setSourceBusyId] = useState<string | null>(null);
	const [sourcesShown, setSourcesShown] = useState<ReadonlySet<string>>(new Set());
	// The settings nav counts the paused skills; it hears each change here,
	// so a review clears the count at once.
	const onPausedCountRef = useRef(onPausedCount);
	onPausedCountRef.current = onPausedCount;
	useEffect(() => {
		if (enabled) onPausedCountRef.current?.(pausedSkills(enabled).length);
	}, [enabled]);
	const [busyName, setBusyName] = useState<string | null>(null);
	// Execution approval (executable skills): its own busy name so the enable/remove
	// buttons keep their own labels while an approval is in flight.
	const [execBusyName, setExecBusyName] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	// Re-review gate (skills MR-5 hardening): a drifted skill can only be
	// re-enabled after its CURRENT body is shown here — no sight-unseen re-adoption.
	const [reviewing, setReviewing] = useState<SkillDetail | null>(null);
	const [reviewLoadingName, setReviewLoadingName] = useState<string | null>(null);
	const [pickerOpen, setPickerOpen] = useState(false);
	// Skills whose file list is open under their files line.
	const [filesShown, setFilesShown] = useState<ReadonlySet<string>>(new Set());
	const [query, setQuery] = useState("");

	function applySettings(response: PersistentRoomSkillSettingsResponse) {
		setEnabled(response.skills);
		setSources(response.sources ?? []);
		setSourceGrants(response.settings.enabledSources ?? []);
		setIndependentNames(new Set(response.settings.enabledSkills.map((skill) => skill.name)));
	}

	useEffect(() => {
		let cancelled = false;
		setLibrary(peekSkillSummaries() ?? null);
		const cached = peekPersistentRoomSkillSettings(status.id);
		if (cached) applySettings(cached);
		else setEnabled(null);
		setError(null);
		setSourceReview(null);
		setSourcesShown(new Set());
		setFilesShown(new Set());
		Promise.all([fetchSkills({ summary: true }), fetchPersistentRoomSkillSettings(status.id)])
			.then(([skills, response]) => {
				if (cancelled) return;
				setLibrary(skills);
				applySettings(response);
			})
			.catch((e) => {
				if (!cancelled) setError((e as Error).message);
			});
		fetchRemoteClientContext().then((context) => showsComputerOnlyControls(context) ? fetchSkillLibraries() : null).then((response) => { if (!cancelled && response) setRepositories(response.libraries); }).catch((e) => { if (!cancelled) setError((e as Error).message); });
		return () => {
			cancelled = true;
		};
	}, [status.id, refreshKey]);

	async function toggle(name: string, action: "enable" | "disable") {
		setBusyName(name);
		setError(null);
		try {
			const reviewed = action === "enable" && reviewing?.name === name && reviewing.provenance?.repo ? { sha256: reviewing.sha256, packageSha256: reviewing.packageSha256 } : undefined;
			applySettings(await updatePersistentRoomSkillSetting(status.id, action, name, reviewed));
			if (action === "enable") setReviewing(null);
		} catch (e) {
			setError((e as Error).message);
		} finally {
			setBusyName(null);
		}
	}

	async function setExecution(name: string, action: "approve-execution" | "revoke-execution") {
		setExecBusyName(name);
		setError(null);
		try {
			applySettings(await updatePersistentRoomSkillSetting(status.id, action, name));
		} catch (e) {
			setError((e as Error).message);
		} finally {
			setExecBusyName(null);
		}
	}

	function toggleFilesShown(name: string) {
		setFilesShown((shown) => {
			const next = new Set(shown);
			if (!next.delete(name)) next.add(name);
			return next;
		});
	}

	async function openReview(name: string) {
		setReviewLoadingName(name);
		setError(null);
		try {
			setReviewing(await fetchSkill(name));
			setSourceReview(null);
		} catch (e) {
			setError((e as Error).message);
		} finally {
			setReviewLoadingName(null);
		}
	}

	async function openSourceReview(libraryId: string) {
		setSourceBusyId(libraryId);
		setError(null);
		try {
			const review = await fetchPersistentRoomSourceReview(status.id, libraryId);
			setReviewExclusions(new Set((sourceGrants.find((source) => source.libraryId === libraryId)?.excludedSkills ?? []).filter((name) => review.skills.some((skill) => skill.name === name))));
			setSourceReview(review);
			setReviewing(null);
		} catch (e) { setError((e as Error).message); }
		finally { setSourceBusyId(null); }
	}

	async function saveSourceReview() {
		if (!sourceReview) return;
		setSourceBusyId(sourceReview.libraryId);
		setError(null);
		try {
			const skills = sourceReview.skills.map((skill) => {
				if (!skill.sha256 || !skill.packageSha256) throw new Error("This source changed. Open its review again.");
				return { name: skill.name, sha256: skill.sha256, packageSha256: skill.packageSha256 };
			});
			applySettings(await updatePersistentRoomSourceSetting(status.id, { action: "enable-source", libraryId: sourceReview.libraryId, materialsSha256: sourceReview.materialsSha256, skills, excludedSkills: [...reviewExclusions].filter((name) => skills.some((skill) => skill.name === name)) }));
			setSourceReview(null);
		} catch (e) { setError((e as Error).message); }
		finally { setSourceBusyId(null); }
	}

	async function changeSource(mutation: Parameters<typeof updatePersistentRoomSourceSetting>[1]) {
		setSourceBusyId(mutation.libraryId);
		setError(null);
		try { applySettings(await updatePersistentRoomSourceSetting(status.id, mutation)); }
		catch (e) { setError((e as Error).message); }
		finally { setSourceBusyId(null); }
	}

	function toggleSourceShown(libraryId: string) {
		setSourcesShown((shown) => { const next = new Set(shown); if (!next.delete(libraryId)) next.add(libraryId); return next; });
	}

	const libraryByName = useMemo(() => new Map((library ?? []).map((skill) => [skill.name, skill] as const)), [library]);
	const enabledNames = useMemo(() => new Set((enabled ?? []).map((skill) => skill.name)), [enabled]);
	const available = useMemo(() => {
		const rest = (library ?? []).filter((skill) => !enabledNames.has(skill.name));
		const q = query.trim().toLowerCase();
		if (!q) return rest;
		return rest.filter((skill) => `${skill.displayName ?? ""} ${skill.name} ${skill.description}`.toLowerCase().includes(q));
	}, [library, enabledNames, query]);

	const okCount = (enabled ?? []).filter((skill) => skill.status === "ok").length;
	const loaded = library !== null && enabled !== null;
	const repositoryGroups = useMemo(() => {
		const groups = new Map(repositories.map((repository) => [repository.id, { id: repository.id, name: repository.name, source: repository.source }]));
		for (const source of sources) if (!groups.has(source.libraryId)) groups.set(source.libraryId, { id: source.libraryId, name: source.name, source: source.source });
		return [...groups.values()];
	}, [repositories, sources]);

	return (
		<div className="room-skills-section">
			<PaneHeader
				title="Skills"
				line={<>
					{okCount > 0 ? `${okCount} enabled.` : "Abilities this room can use in its turns."}
					<RsInfo text="Each enabled skill adds a ~100-token index entry to every turn of this room. Enabling or disabling takes effect right away, from the room's next reply on; a changed or removed skill stops being injected immediately. A skill's full instructions load only when the room reads it and are never memorized." />
				</>}
				actions={loaded ? <div className="skill-library-buttons">
					{onOpenSkillsLibrary && <button className="rs-btn" type="button" onClick={() => onOpenSkillsLibrary()}>Open skills</button>}
					{library.length > enabledNames.size && !pickerOpen && <button className="rs-btn" onClick={() => { setPickerOpen(true); setQuery(""); }}>Enable skills…</button>}
				</div> : null}
			/>
			{error && <div className="checkpoint-proposal-error">{error}</div>}
			{!loaded && error === null && <p className="ai-setup-copy">Loading skills…</p>}
			{loaded && library.length === 0 && enabled.length === 0 && repositoryGroups.length === 0 && (
				<p className="settings-empty">No skills in your library yet. Add them in Settings, Skills (the gear at the bottom of the sidebar). Every skill passes a review before it can be enabled here.</p>
			)}
			{loaded && (library.length > 0 || enabled.length > 0 || repositoryGroups.length > 0) && (
				<>
					{sourceReview && <div className="room-skills-review">
						<div className="room-skills-review-head"><strong>Review {sourceReview.name}</strong><button className="icon-btn" aria-label="Close source review" disabled={sourceBusyId !== null} onClick={() => setSourceReview(null)}>Close</button></div>
						<p className="settings-row-sub">{sourceReview.skills.length - reviewExclusions.size} skills · {sourceReview.materials.length} local references <RsInfo text="Enabling this source lets the room read all these reviewed local references, including files without a skill link. Choose individual skills below. New skills and reference versions need another grouped review; existing independently enabled skills keep their own approval." /></p>
						{sourceReview.skills.map((skill) => <details key={skill.name} className="room-skill">
							<summary className="settings-row"><span className="settings-row-main"><span className="settings-row-label">{skill.displayName || skill.name}</span>{skill.description && <span className="settings-row-sub settings-row-clamp">{skill.description}</span>}</span><input className="workspaces-tool-switch" type="checkbox" role="switch" checked={!reviewExclusions.has(skill.name)} aria-label={`Include ${skill.displayName || skill.name}`} disabled={sourceBusyId !== null} onClick={(event) => event.stopPropagation()} onChange={(event) => { const checked = event.target.checked; setReviewExclusions((excluded) => { const next = new Set(excluded); if (checked) next.delete(skill.name); else next.add(skill.name); return next; }); }} /></summary>
							{skill.scanFindings?.length > 0 && <p className="room-skills-warn">{skill.scanFindings.length} hidden or invisible characters found. Inspect before adopting.</p>}
							<div className="room-skills-review-body"><SkillInstructions body={skill.body} /></div>
							{skill.provenance?.repo && <SkillReferences references={skill.provenance.repo.references} stored onPreview={!localReferences ? undefined : (reference) => previewInstalledReference(skill.name, reference)} />}
						</details>)}
						{sourceReview.materials.length > 0 && <details><summary className="rs-text-btn">View local references ({sourceReview.materials.length})</summary><SkillReferences references={sourceReview.materials} stored onPreview={!localReferences ? undefined : (reference) => previewLibraryMaterial(sourceReview.libraryId, sourceReview.materialsSha256, reference)} /></details>}
						<div className="room-skills-row-actions"><button className="rs-btn" disabled={sourceBusyId !== null || !localReferences} onClick={() => void saveSourceReview()}>{sourceBusyId === sourceReview.libraryId ? "Enabling…" : "I reviewed this source: enable"}</button><button className="rs-btn" disabled={sourceBusyId !== null} onClick={() => setSourceReview(null)}>Cancel</button></div>
					</div>}
					{repositoryGroups.length > 0 && <div className="settings-rows room-skill-list" aria-label="Repository sources">
						{repositoryGroups.map((group) => {
							const source = sources.find((entry) => entry.libraryId === group.id);
							const grant = sourceGrants.find((entry) => entry.libraryId === group.id);
							const installed = library.filter((skill) => skill.provenance?.repo?.libraryId === group.id);
							return <div className="room-skill" key={group.id}>
								<div className="settings-row"><div className="settings-row-main"><span className="settings-row-label" title={group.source}>{group.name}</span><span className="settings-row-sub">{grant ? <>{grant.skills.length - grant.excludedSkills.length} skills · <button className="rs-text-btn" disabled={!localReferences} aria-label={`Show local references from ${group.name}`} aria-expanded={filesShown.has(`source:${group.id}`)} onClick={() => toggleFilesShown(`source:${group.id}`)}>{source?.materialCount ?? 0} local references</button></> : `${installed.length} saved skills`}{source?.status === "review-required" ? " · Changes ready to review" : source?.status === "missing" ? " · Reviewed files unavailable" : ""}</span></div><div className="room-skill-actions">{source?.status === "review-required" && <button className="rs-text-btn" disabled={sourceBusyId !== null || !localReferences} onClick={() => void openSourceReview(group.id)}>Review room changes</button>}<input className="workspaces-tool-switch" type="checkbox" role="switch" checked={Boolean(grant)} disabled={sourceBusyId !== null || !localReferences} aria-label={`Enable source ${group.name}`} onChange={(event) => event.target.checked ? void openSourceReview(group.id) : void changeSource({ action: "disable-source", libraryId: group.id })} /></div></div>
								{updateNotices.some((entry) => entry.id === group.id && entry.status === "updates") && onOpenSkillsLibrary && localReferences && <div className="room-source-update"><button className="rs-text-btn skill-update-notice" title="New repository contents are available. Review them in the shared library; this room keeps its approved version." onClick={() => onOpenSkillsLibrary(group.id)}>↻ Repository update</button><RsInfo text="The remote repository has changes compared with your local library. Import them in the shared library first, then review room changes to adopt them here." /></div>}
								{grant && filesShown.has(`source:${group.id}`) && localReferences && <RoomSourceReferences key={`${grant.libraryId}:${grant.materialsSha256}`} grant={grant} onManage={onOpenSkillsLibrary ? () => onOpenSkillsLibrary(group.id) : undefined} />}
								{grant && grant.skills.length > 0 && <><button className="rs-text-btn" aria-expanded={sourcesShown.has(group.id)} onClick={() => toggleSourceShown(group.id)}>{sourcesShown.has(group.id) ? "Hide skills" : "Choose skills"}</button>{sourcesShown.has(group.id) && <div className="room-skills-rows">{grant.skills.map((pin) => {
									const entry = libraryByName.get(pin.name);
									const current = enabled.find((skill) => skill.name === pin.name);
									return <div className="settings-row" key={pin.name}><div className="settings-row-main"><span className="settings-row-label">{entry?.displayName || pin.name}</span>{current && skillProblemLine(current) && <span className="settings-row-sub room-skill-problem">{skillProblemLine(current)}</span>}{independentNames.has(pin.name) && <span className="settings-row-sub">Also enabled individually</span>}</div><input className="workspaces-tool-switch" type="checkbox" role="switch" checked={!grant.excludedSkills.includes(pin.name)} disabled={sourceBusyId !== null || !localReferences} aria-label={`Use ${entry?.displayName || pin.name} from ${group.name}`} onChange={(event) => void changeSource({ action: "exclude-source-skill", libraryId: group.id, name: pin.name, excluded: !event.target.checked })} /></div>;
								})}</div>}</>}
							</div>;
						})}
					</div>}
					{reviewing && (
						<div className="room-skills-review">
							<div className="room-skills-review-head">
								<strong>Review “{reviewing.displayName || reviewing.name}” before enabling</strong>
								<button className="icon-btn" onClick={() => setReviewing(null)} aria-label="Close review">Close</button>
							</div>
							<p className="room-skills-warn">Review this version's instructions and selected references before allowing this room to use them. A change to any selected file requires another review.</p>
							{reviewing.provenance?.repo && <p className="cli-note">{reviewing.provenance.repo.source} · {reviewing.provenance.repo.skillPath || "Repository root"} · commit {reviewing.provenance.repo.revision.slice(0, 12)}</p>}
							{reviewing.scanFindings && reviewing.scanFindings.length > 0 && (
								<div className="checkpoint-proposal-error">
									{reviewing.scanFindings.length} hidden/invisible character(s) found in this skill. Inspect carefully before adopting.
								</div>
							)}
							<div className="room-skills-review-body">
								<SkillInstructions body={reviewing.body} />
							</div>
							{reviewing.provenance?.repo && <SkillReferences references={reviewing.provenance.repo.references} stored onPreview={!localReferences ? undefined : (reference) => previewInstalledReference(reviewing.name, reference)} />}
							<div className="room-skills-row-actions">
								<button className="rs-btn" disabled={busyName === reviewing.name} onClick={() => void toggle(reviewing.name, "enable")}>
									{busyName === reviewing.name ? "Enabling…" : "I reviewed this version: enable"}
								</button>
								<button className="rs-btn" onClick={() => setReviewing(null)}>Cancel</button>
							</div>
						</div>
					)}
					{enabled.length === 0 && library.length > 0 && sourceGrants.length === 0 && (
						<p className="ai-setup-copy room-skills-empty">No skills enabled for this room yet.</p>
					)}
					<div className="settings-rows room-skill-list">
						{enabled.filter((state) => independentNames.has(state.name)).map((state) => {
							const entry = libraryByName.get(state.name);
							const name = entry?.displayName || state.name;
							// The files line only exists for a skill that can be approved at
							// all and actually carries files.
							const bundledFiles = state.bundledFiles ?? [];
							const showExecution = !entry?.provenance?.repo && Boolean(state.executable) && bundledFiles.length > 0;
							const references = entry?.provenance?.repo?.references;
							const problem = skillProblemLine(state);
							return (
								<div key={state.name} className="room-skill">
									<div className="settings-row room-skill-row">
										<div className="settings-row-main">
											<span className="settings-row-label">{name}</span>
											{entry?.description && <span className="settings-row-sub settings-row-clamp" title={entry.description}>{entry.description}</span>}
											{problem && <span className="settings-row-sub room-skill-problem">{problem}</span>}
										</div>
										<div className="room-skill-actions">
											{state.status === "hash-mismatch" && (
												<button className="rs-btn" disabled={reviewLoadingName === state.name} onClick={() => void openReview(state.name)}>
													{reviewLoadingName === state.name ? "Loading…" : "Review changes"}
												</button>
											)}
											<button className="rs-btn" disabled={busyName === state.name} title="Disable for this room; the skill stays in your library" onClick={() => void toggle(state.name, "disable")}>
												{busyName === state.name ? "Removing…" : "Remove"}
											</button>
										</div>
									</div>
									{references && <div className="room-skill-references"><span className="settings-row-sub">{references.length} selected reference{references.length === 1 ? "" : "s"} · commit {entry?.provenance?.repo?.revision.slice(0, 12)} <button className="rs-text-btn" aria-expanded={filesShown.has(state.name)} onClick={() => toggleFilesShown(state.name)}>{filesShown.has(state.name) ? "Hide references" : "Show references"}</button></span>{filesShown.has(state.name) && <SkillReferences references={references} stored onPreview={!localReferences ? undefined : (reference) => previewInstalledReference(state.name, reference)} />}</div>}
									{showExecution && (
										<>
											<div className="settings-row room-skill-files-row">
												<div className="settings-row-main">
													<span className="room-skill-files-label">Run its files</span>
													<span className={`settings-row-sub${state.executeState === "drifted" ? " room-skill-problem" : ""}`}>
														{runFilesLine(state.executeState, bundledFiles.length)}{" "}
														<button
															type="button"
															className="rs-text-btn"
															aria-expanded={filesShown.has(state.name)}
															onClick={() => toggleFilesShown(state.name)}
														>
															{filesShown.has(state.name) ? "Hide files" : "Show files"}
														</button>
													</span>
												</div>
												<input
													className="workspaces-tool-switch"
													type="checkbox"
													role="switch"
													checked={state.executeState === "approved"}
													disabled={execBusyName === state.name}
													onChange={(e) => void setExecution(state.name, e.target.checked ? "approve-execution" : "revoke-execution")}
													aria-label={`Let ${name} run its files in this room`}
												/>
											</div>
											{filesShown.has(state.name) && <FileGroupList groups={groupFilesByFolder(bundledFiles)} className="room-skill-files" />}
										</>
									)}
								</div>
							);
						})}
					</div>
					{pickerOpen && (
						<div className="room-skills-picker">
							<div className="room-skills-picker-head">
								<input
									type="text"
									className="room-skills-picker-search"
									placeholder="Search your library…"
									value={query}
									autoFocus
									onChange={(e) => setQuery(e.target.value)}
								/>
								<button className="icon-btn" aria-label="Close skill picker" onClick={() => setPickerOpen(false)}>✕</button>
							</div>
							<div className="room-skills-picker-list">
								{available.length === 0 && <p className="ai-setup-copy">{query.trim() ? "No skills match." : "Everything in your library is already enabled."}</p>}
								{available.map((skill) => (
									<div key={skill.name} className="room-skills-row">
										<div className="room-skills-row-main">
											<span className="room-skills-name">{skill.displayName || skill.name}</span>
											{skill.description && <span className="room-skills-desc">{skill.description}</span>}
										</div>
										<div className="room-skills-row-actions">
											<button className="rs-btn" disabled={busyName === skill.name || reviewLoadingName === skill.name} title="Let this room use this skill" onClick={() => skill.provenance?.repo ? void openReview(skill.name) : void toggle(skill.name, "enable")}>
												{busyName === skill.name || reviewLoadingName === skill.name ? "Loading…" : skill.provenance?.repo ? "Review and enable" : "Enable"}
											</button>
										</div>
									</div>
								))}
							</div>
						</div>
					)}
				</>
			)}
		</div>
	);
}
