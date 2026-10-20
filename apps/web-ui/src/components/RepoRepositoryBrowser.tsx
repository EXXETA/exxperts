import { useMemo, useState, type ReactNode } from "react";
import type { RepoFile, RepoFoundSkill, RepoScanResponse, SkillFilePreviewData } from "../skills-repo-api";
import { RsInfo } from "./rs-info";
import { SkillFileButton } from "./SkillFileButton";

/** Browse committed names without reading or adopting any repository content. */
export function RepoRepositoryBrowser({ scan, onOpenSkill, busy = false, renderLocalFile, onPreview, contentVersion }: { scan: Pick<RepoScanResponse, "files" | "skills">; onOpenSkill: (skill: RepoFoundSkill) => void; busy?: boolean; contentVersion?: string; renderLocalFile?: (file: RepoFile) => ReactNode; onPreview?: (path: string) => Promise<SkillFilePreviewData> }) {
	const [folder, setFolder] = useState("");
	const [query, setQuery] = useState("");
	const [filePath, setFilePath] = useState<string | null>(null);
	const [limit, setLimit] = useState(200);
	const referencePaths = useMemo(() => scan.files.filter((entry) => entry.allowed || scan.skills.some((skill) => entry.path === (skill.path ? `${skill.path}/SKILL.md` : "SKILL.md"))).map((entry) => entry.path), [scan.files, scan.skills]);
	const file = scan.files.find((entry) => entry.path === filePath);
	const prefix = folder ? `${folder}/` : "";
	const matches = scan.files.filter((entry) => query ? entry.path.toLowerCase().includes(query.toLowerCase()) : entry.path.startsWith(prefix));
	const rows = new Map<string, { path: string; name: string; directory: boolean; count: number }>();
	for (const entry of matches) {
		const relative = query ? entry.path : entry.path.slice(prefix.length);
		const slash = query ? -1 : relative.indexOf("/");
		const directory = slash >= 0;
		const name = directory ? relative.slice(0, slash) : relative;
		const rowPath = directory ? prefix + name : entry.path;
		const previous = rows.get(rowPath);
		rows.set(rowPath, { path: rowPath, name, directory, count: (previous?.count ?? 0) + 1 });
	}
	const sorted = [...rows.values()].sort((a, b) => Number(b.directory) - Number(a.directory) || a.name.localeCompare(b.name));
	const fileByPath = new Map(scan.files.map((entry) => [entry.path, entry]));
	const skillByManifest = new Map(scan.skills.map((skill) => [skill.path ? `${skill.path}/SKILL.md` : "SKILL.md", skill]));
	const referencedBy = scan.skills.filter((skill) => skill.referencePaths?.includes(filePath ?? ""));
	const missing = [...new Set(scan.skills.flatMap((skill) => skill.referencePaths ?? []))].filter((ref) => !fileByPath.has(ref));
	function navigate(path: string) { setFolder(path); setQuery(""); setFilePath(null); setLimit(200); }
	return <section className="repo-repository-browser" aria-label={renderLocalFile ? "Local repository files" : "Complete repository structure"}>
		<div className="repo-browser-heading"><div className="repo-browser-title"><h3>{renderLocalFile ? "Saved local files" : "Source repository files"}</h3><RsInfo text={renderLocalFile ? "Reviewed skills and selected materials are stored locally under their original paths. Different saved copies remain identifiable. Add materials opens a shared selection and review; browsing here needs no Git connection." : "These are repository paths. Contents become local only after selection and review. Public repositories use anonymous access; local Git accounts require your permission. Programs, symlinks and submodules cannot be imported as materials."} /></div><span className="cli-note">{scan.files.length} {renderLocalFile ? "saved files" : "source paths"} · {scan.skills.length} skills</span></div>
		<input className="skill-import-url" aria-label={renderLocalFile ? "Search local repository files" : "Search all repository files"} placeholder={renderLocalFile ? "Search saved repository paths…" : "Search the whole repository…"} value={query} onChange={(event) => { setQuery(event.target.value); setFilePath(null); setLimit(200); }} />
		<nav className="repo-browser-breadcrumbs" aria-label="Repository folders"><button className="rs-text-btn" aria-current={!folder && !query ? "location" : undefined} onClick={() => navigate("")}>Repository root</button>{query ? <span> / Search results</span> : folder.split("/").filter(Boolean).map((part, index, parts) => <span key={index}> / <button className="rs-text-btn" aria-current={index === parts.length - 1 ? "location" : undefined} onClick={() => navigate(parts.slice(0, index + 1).join("/"))}>{part}</button></span>)}</nav>
		<div className="repo-browser-list" key={contentVersion} aria-label={query ? "Repository search results" : "Folder contents"}>
			{sorted.slice(0, limit).map((row) => {
				const metadata = fileByPath.get(row.path);
				const skill = skillByManifest.get(row.path);
				if (!row.directory && renderLocalFile) return <div className="repo-browser-local-row" key={row.path}>{renderLocalFile(metadata!)}</div>;
				return <button className="repo-browser-row" key={row.path} aria-label={row.directory ? `Open folder ${row.path}` : `Inspect file ${row.path}`} aria-current={!row.directory && filePath === row.path ? "true" : undefined} onClick={() => row.directory ? navigate(row.path) : setFilePath(row.path)}>
					<span className="skill-reference-path">{row.directory ? "▸ " : ""}{row.name}{row.directory ? "/" : ""}</span><span className="cli-note">{row.directory ? `${row.count} files` : skill ? "Skill instructions" : metadata?.allowed ? `${metadata.kind} · permitted` : `Excluded · ${metadata?.reason}`}</span>
				</button>;
			})}
		</div>
		{sorted.length === 0 && <p className="cli-note">No files found.</p>}
		{sorted.length > limit && <button className="rs-btn" onClick={() => setLimit(limit + 200)}>Show more ({sorted.length - limit} remaining)</button>}
		{file && <section className="repo-browser-file" aria-label="Repository file details">
			<h4 className="skill-reference-path">{file.path}</h4>
			{onPreview && <SkillFileButton key={file.path} path={file.path} label="Show source file" referencePaths={referencePaths} load={onPreview} disabled={busy || (!file.allowed && !skillByManifest.has(file.path))} />}
			<p className="cli-note">{skillByManifest.has(file.path) ? "Skill instructions — review this skill to import it." : file.allowed ? `Permitted ${file.kind} format and library location. A skill can import it from its own folder or an approved shared directory, with explicit selection.` : `Excluded: ${file.reason}`}</p>
			{skillByManifest.has(file.path) && <button className="rs-btn" disabled={busy} onClick={() => onOpenSkill(skillByManifest.get(file.path)!)}>Open skill</button>}
			<h4>Referenced by</h4>
			{referencedBy.length === 0 ? <p className="cli-note">No direct link found in the scanned SKILL.md files. The file may still be selected if its folder and format are permitted.</p> : <div className="skill-library-actions">{referencedBy.map((skill) => <button className="rs-btn" disabled={busy} key={skill.path} onClick={() => onOpenSkill(skill)}>{skill.name}</button>)}</div>}
		</section>}
		{missing.length > 0 && <details className="repo-browser-file"><summary>{missing.length} direct reference paths are missing from this snapshot</summary>{missing.slice(0, 200).map((ref) => <p className="cli-note skill-reference-path" key={ref}>{ref}</p>)}{missing.length > 200 && <p className="cli-note">First 200 paths shown. Open the individual skills for their remaining references.</p>}</details>}
	</section>;
}
