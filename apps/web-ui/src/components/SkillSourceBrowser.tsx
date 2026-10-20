import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { fetchSkill, type SkillDetail, type SkillListItem } from "../skills-api";
import { fetchLibraryMaterials, fetchSkillLibraries, peekSkillLibraries, previewInstalledReference, previewLibraryMaterial, saveSkillLibrary, type LibraryMaterialsManifest, type RepoFile, type RepoFoundSkill, type SkillLibrary, type SkillReference } from "../skills-repo-api";
import { GuidedLibraryImport } from "./GuidedLibraryImport";
import { RepoRepositoryBrowser } from "./RepoRepositoryBrowser";
import { SkillFileButton } from "./SkillFileButton";
import { SkillDetailPage } from "./skill-detail";
import { LibraryRoomUpdates } from "./LibraryRoomUpdates";
import { skillBelongsToLibrary, skillReferenceVersion } from "../skill-source-copy";
import { useSkillUpdateNotices } from "../skill-update-notices";

interface FileOwner { skill?: SkillListItem; reference?: SkillReference; material?: LibraryMaterialsManifest["files"][number] }

/** Source navigation reads saved metadata only; fetching Git is an explicit add/update action. */
export function SkillSourceBrowser({ skills, readOnly, onImported, library: suppliedLibrary, installed, active = true, initialView = "skills", showHeading = false, onBusyChange }: { skills: SkillListItem[]; readOnly: boolean; onImported: (name: string) => void; library?: SkillLibrary; installed?: SkillListItem[]; active?: boolean; initialView?: "skills" | "files"; showHeading?: boolean; onBusyChange?: (busy: boolean) => void }) {
	const origin = skills.find((skill) => skill.provenance?.repo)?.provenance?.repo;
	const [library, setLibrary] = useState<SkillLibrary | null>(() => suppliedLibrary ?? peekSkillLibraries()?.libraries.find((entry) => entry.id === origin?.libraryId) ?? null);
	const [materials, setMaterials] = useState<LibraryMaterialsManifest | null>(null);
	const [view, setView] = useState<"skills" | "files">(initialView);
	const [query, setQuery] = useState("");
	const [guided, setGuided] = useState(false);
	const [roomUpdates, setRoomUpdates] = useState(false);
	const notices = useSkillUpdateNotices();
	const roomsToUpdate = notices.find((entry) => entry.id === library?.id)?.rooms.filter((room) => room.reviewRequired).length ?? 0;
	const [importBusy, setImportBusy] = useState(false);
	useEffect(() => { onBusyChange?.(importBusy); return () => onBusyChange?.(false); }, [importBusy, onBusyChange]);
	const [detail, setDetail] = useState<SkillDetail | null>(null);
	const [opening, setOpening] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [attempt, setAttempt] = useState(0);
	const pane = useRef<HTMLElement>(null);
	const scrollPositions = useRef<Record<string, number>>({});
	useLayoutEffect(() => {
		if (!active) return;
		const scroller = pane.current?.closest<HTMLElement>(".settings-dialog-pane");
		if (!scroller) return;
		const key = guided ? "import" : detail ? `skill:${detail.name}` : view;
		scroller.scrollTop = scrollPositions.current[key] ?? 0;
		const save = () => { scrollPositions.current[key] = scroller.scrollTop; };
		scroller.addEventListener("scroll", save);
		return () => scroller.removeEventListener("scroll", save);
	}, [active, guided, detail?.name, view]);
	const sourceSkills = useMemo(() => suppliedLibrary ? (installed ?? skills).filter((skill) => skillBelongsToLibrary(skill.provenance?.repo, suppliedLibrary)) : skills, [suppliedLibrary, installed, skills]);

	useEffect(() => {
		if (readOnly) return;
		let cancelled = false;
		void (async () => {
			try {
				const saved = suppliedLibrary ?? (await fetchSkillLibraries()).libraries.find((entry) => origin && skillBelongsToLibrary(origin, entry)) ?? null;
				if (!cancelled) setLibrary(saved);
				const result = saved ? await fetchLibraryMaterials(saved.id) : { manifest: null };
				if (!cancelled) { setMaterials(result.manifest); setError(null); }
			} catch (value) { if (!cancelled) setError(value instanceof Error ? value.message : String(value)); }
		})();
		return () => { cancelled = true; };
	}, [readOnly, suppliedLibrary, origin?.libraryId, origin?.source, origin?.ref, attempt]);

	useEffect(() => {
		if (!active) return;
		const escape = (event: KeyboardEvent) => {
			if (roomUpdates) return;
			if (event.key !== "Escape" || [...(pane.current?.querySelectorAll('[role="tooltip"]') ?? [])].some((element) => !element.closest("[hidden]"))) return;
			const previews = [...(pane.current?.querySelectorAll(".skill-file-preview") ?? [])].filter((element) => !element.closest("[hidden]"));
			const preview = previews.at(-1);
			if (preview) {
				event.preventDefault(); event.stopPropagation();
				[...preview.querySelectorAll("button")].find((button) => button.textContent === "Close preview")?.click();
			} else if (guided || detail) {
				event.preventDefault(); event.stopPropagation();
				if (guided && !importBusy) setGuided(false);
				else if (detail) setDetail(null);
			}
		};
		document.addEventListener("keydown", escape, true);
		return () => document.removeEventListener("keydown", escape, true);
	}, [active, guided, detail, importBusy, roomUpdates]);

	const local = useMemo(() => {
		const files = new Map<string, RepoFile>();
		const owners = new Map<string, FileOwner[]>();
		const found: RepoFoundSkill[] = [];
		for (const material of materials?.files ?? []) { files.set(material.path, { ...material, allowed: true }); owners.set(material.path, [{ material }]); }
		for (const skill of sourceSkills) {
			const repo = skill.provenance?.repo;
			if (!repo) continue;
			const manifestPath = repo.skillPath ? `${repo.skillPath}/SKILL.md` : "SKILL.md";
			found.push({ name: skill.name, path: repo.skillPath, description: skill.description, license: skill.license, hasBundledScripts: false, referencePaths: repo.references.map((entry) => entry.path) });
			files.set(manifestPath, { path: manifestPath, kind: "markdown", allowed: true });
			owners.set(manifestPath, [...(owners.get(manifestPath) ?? []), { skill }]);
			for (const reference of repo.references) {
				files.set(reference.path, { path: reference.path, kind: reference.kind, allowed: true });
				const copies = owners.get(reference.path) ?? [];
				if (!copies.some((copy) => (copy.reference?.sha256 ?? copy.material?.sha256) === reference.sha256)) copies.push({ skill, reference });
				owners.set(reference.path, copies);
			}
		}
		return { files: [...files.values()], skills: found, owners };
	}, [sourceSkills, materials]);

	const contentVersion = useMemo(() => JSON.stringify([sourceSkills.map((skill) => [skill.name, skill.body, skillReferenceVersion(skill.provenance?.repo?.references ?? [])]), materials?.materialsSha256]), [sourceSkills, materials?.materialsSha256]);

	async function openSkill(name: string) {
		setOpening(name); setError(null);
		try { setDetail(await fetchSkill(name)); }
		catch (value) { setError(value instanceof Error ? value.message : String(value)); }
		finally { setOpening(null); }
	}
	async function addMaterials() {
		setError(null); setImportBusy(true);
		try {
			if (!library) {
				if (!origin) throw new Error("This source has no repository address.");
				const registered = (await fetchSkillLibraries({ refresh: true })).libraries.find((entry) => skillBelongsToLibrary(origin, entry));
				if (registered) setLibrary(registered);
				else {
					const saved = await saveSkillLibrary({ name: origin.source.split("/").at(-1)?.replace(/\.git$/, "") || "Repository", source: origin.source, ref: origin.ref, ...origin.policy });
					setLibrary(saved.library);
				}
			}
			setGuided(true);
		} catch (value) { setError(value instanceof Error ? value.message : String(value)); setImportBusy(false); }
	}
	return <section ref={pane} className="skill-library-browse skill-source-detail" aria-label="Repository source">
		{showHeading && !guided && !detail && !roomUpdates && <h3>{library?.name}</h3>}
		<div hidden={guided || !!detail || roomUpdates}>
			{library?.transport && <p className="cli-note">Last fetched using {library.transport === "api" ? "public repository API" : "Git"}. Browsing these saved files stays local.</p>}
			<div className="skill-repository-views" aria-label="Source view"><button className="rs-btn" aria-pressed={view === "skills"} onClick={() => setView("skills")}>Skills</button><button className="rs-btn" aria-pressed={view === "files"} onClick={() => setView("files")}>Files</button>{!readOnly && <button className="rs-btn rs-btn-primary" disabled={importBusy} onClick={() => void addMaterials()}>{library?.status === "updates" ? "Review updates" : "Add references"}</button>}</div>
			{!readOnly && roomsToUpdate > 0 && <button className="rs-text-btn skill-update-notice" onClick={() => setRoomUpdates(true)}>↻ Update {roomsToUpdate} {roomsToUpdate === 1 ? "room" : "rooms"}…</button>}
			{error && <div role="alert" className="checkpoint-proposal-error">{error}<button className="rs-text-btn" onClick={() => setAttempt((value) => value + 1)}>Retry saved metadata</button></div>}
			<div hidden={view !== "skills"} className="repo-repository-browser skill-source-skills"><div className="repo-browser-heading"><h3>Saved skills</h3><span className="cli-note">{sourceSkills.length} skills</span></div><input className="skill-import-url" aria-label="Search saved skills" placeholder="Search skills" value={query} onChange={(event) => setQuery(event.target.value)} /><div className="repo-browser-list">{sourceSkills.filter((skill) => `${skill.name} ${skill.displayName ?? ""} ${skill.description}`.toLowerCase().includes(query.toLowerCase())).map((skill) => <button key={skill.name} className="repo-browser-row source-skill-row" disabled={opening !== null} aria-label={`Open saved skill ${skill.name}`} onClick={() => void openSkill(skill.name)}><span>{skill.displayName || skill.name}</span><span className="cli-note">{opening === skill.name ? "Opening…" : skill.description}</span></button>)}</div>{sourceSkills.length === 0 && <p className="cli-note">No skills saved from this source yet.</p>}</div>
			<div hidden={view !== "files"}><RepoRepositoryBrowser contentVersion={contentVersion} scan={local} onOpenSkill={(skill) => void openSkill(skill.name)} renderLocalFile={(file) => {
				const copies = local.owners.get(file.path)!;
				return copies.map((copy, index) => <SkillFileButton key={`${file.path}:${index}`} path={file.path} label={`${file.path.split("/").at(-1)}${copies.length > 1 ? ` · ${copy.material ? "Source materials" : copy.skill!.name}` : ""}`} description={copy.reference?.description} disabled={readOnly && !!(copy.reference || copy.material)} referencePaths={[...(materials?.files.map((entry) => entry.path) ?? []), ...(copy.skill?.provenance?.repo?.references.map((entry) => entry.path) ?? [])]} load={async (target) => {
					if (target === file.path && copy.skill && !copy.reference) return { path: target, kind: "markdown", size: new TextEncoder().encode(copy.skill.body).length, text: copy.skill.body };
					if (readOnly) throw new Error("Reference previews are unavailable in this read-only view.");
					if (copy.skill?.provenance?.repo?.references.some((entry) => entry.path === target)) return previewInstalledReference(copy.skill.name, target);
					if (materials?.files.some((entry) => entry.path === target)) return previewLibraryMaterial(materials.libraryId, materials.materialsSha256, target);
					throw new Error("This file is not saved in the selected local copy.");
				}} />);
			}} /></div>
		</div>
		{detail && <SkillDetailPage skill={detail} readOnly={readOnly} onBack={() => setDetail(null)} onDeleted={() => { setDetail(null); onImported(detail.name); }} />}
		{guided && library && <GuidedLibraryImport library={library} installed={installed ?? skills} onBusyChange={setImportBusy} onCancel={() => { setGuided(false); setImportBusy(false); }} onImported={() => { setGuided(false); setImportBusy(false); setAttempt((value) => value + 1); onImported(""); }} />}
		{roomUpdates && library && <LibraryRoomUpdates libraryId={library.id} active={active} onBack={() => setRoomUpdates(false)} />}
	</section>;
}
