import { useEffect, useMemo, useRef, useState } from "react";
import type { RepoFile, SkillFilePreviewData } from "../skills-repo-api";
import { SkillFileButton } from "./SkillFileButton";

interface FolderNode { path: string; folders: Map<string, FolderNode>; files: RepoFile[]; from: number; to: number }
function Check({ checked, mixed, disabled, label, onChange }: { checked: boolean; mixed?: boolean; disabled: boolean; label: string; onChange: () => void }) {
	const input = useRef<HTMLInputElement>(null);
	useEffect(() => { if (input.current) input.current.indeterminate = !!mixed; }, [mixed]);
	return <input ref={input} type="checkbox" checked={checked} aria-checked={mixed ? "mixed" : checked} aria-label={label} disabled={disabled} onChange={onChange} />;
}

/** Folder selection uses the original inventory, independently of search and pagination. */
export function MaterialSelectionTree({ files, selected, onChange, onPreview, disabled = false, readOnly = false }: { files: RepoFile[]; selected: ReadonlySet<string>; onChange: (selected: Set<string>) => void; onPreview?: (path: string) => Promise<SkillFilePreviewData>; disabled?: boolean; readOnly?: boolean }) {
	const [query, setQuery] = useState("");
	const [pages, setPages] = useState<Record<string, number>>({});
	const [expanded, setExpanded] = useState<Set<string>>(new Set());
	const inventory = useMemo(() => {
		const entries = files.filter((file) => file.kind && file.path.split("/").at(-1)?.toLowerCase() !== "skill.md").sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
		const root: FolderNode = { path: "", folders: new Map(), files: [], from: 0, to: entries.length };
		entries.forEach((file, index) => {
			let folder = root;
			for (const segment of file.path.split("/").slice(0, -1)) {
				if (!folder.folders.has(segment)) folder.folders.set(segment, { path: folder.path ? `${folder.path}/${segment}` : segment, folders: new Map(), files: [], from: index, to: index + 1 });
				folder = folder.folders.get(segment)!;
				folder.to = index + 1;
			}
			folder.files.push(file);
		});
		return { root, entries, paths: files.map((file) => file.path) };
	}, [files]);
	const counts = useMemo(() => {
		const result = new Map<string, { allowed: number; selected: number }>();
		function visit(folder: FolderNode) {
			let allowed = 0, count = 0;
			for (const file of folder.files) if (file.allowed) { allowed++; if (selected.has(file.path)) count++; }
			for (const child of folder.folders.values()) { const nested = visit(child); allowed += nested.allowed; count += nested.selected; }
			const value = { allowed, selected: count }; result.set(folder.path, value); return value;
		}
		visit(inventory.root); return result;
	}, [inventory, selected]);
	const matchingFolders = useMemo(() => {
		const result = new Set<string>();
		if (query) for (const file of inventory.entries) if (file.path.toLowerCase().includes(query.toLowerCase())) {
			const parts = file.path.split("/");
			for (let depth = 0; depth < parts.length; depth++) result.add(parts.slice(0, depth).join("/"));
		}
		return result;
	}, [inventory, query]);
	function toggle(paths: string[]) {
		const next = new Set(selected);
		const remove = paths.every((original) => next.has(original));
		for (const original of paths) { if (remove) next.delete(original); else next.add(original); }
		onChange(next);
	}
	function renderFolder(folder: FolderNode) {
		if (query && !matchingFolders.has(folder.path)) return null;
		const count = counts.get(folder.path)!;
		const open = !folder.path || (query ? matchingFolders.has(folder.path) : expanded.has(folder.path));
		const limit = pages[folder.path] ?? 100;
		const visible = open ? folder.files.filter((file) => !query || file.path.toLowerCase().includes(query.toLowerCase())) : [];
		const heading = <><Check checked={count.allowed > 0 && count.selected === count.allowed} mixed={count.selected > 0 && count.selected < count.allowed} disabled={disabled || readOnly || !count.allowed} label={`Select folder ${folder.path || "Repository root"}`} onChange={() => toggle(inventory.entries.slice(folder.from, folder.to).filter((file) => file.allowed).map((file) => file.path))} /><span>{folder.path.split("/").at(-1) || "Repository files"}</span><span className="cli-note">{count.selected}/{count.allowed}</span></>;
		const content = open && <>
			{[...folder.folders.values()].sort((a, b) => a.path.localeCompare(b.path)).map(renderFolder)}
			{visible.slice(0, limit).map((file) => <div className="skill-library-check material-selection-file" key={file.path}>
				<Check checked={selected.has(file.path)} disabled={disabled || readOnly || !file.allowed} label={`Select file ${file.path}`} onChange={() => toggle([file.path])} />
				{onPreview ? <SkillFileButton path={file.path} label={file.path.split("/").at(-1)} load={onPreview} disabled={disabled || !file.allowed} referencePaths={inventory.paths} /> : <span title={file.path}>{file.path.split("/").at(-1)}</span>}
				{!file.allowed && <span className="cli-note" title={file.reason}>{file.reason || "Format not enabled"}</span>}
			</div>)}
			{visible.length > limit && <button type="button" className="rs-text-btn" onClick={() => setPages((previous) => ({ ...previous, [folder.path]: limit + 100 }))}>Show more files ({visible.length - limit})</button>}
		</>;
		return folder.path ? <details className="repo-browser-folder material-selection-folder" key={folder.path} open={open} onToggle={(event) => { if (event.target !== event.currentTarget || query) return; const isOpen = event.currentTarget.open; setExpanded((previous) => { if (previous.has(folder.path) === isOpen) return previous; const next = new Set(previous); if (isOpen) next.add(folder.path); else next.delete(folder.path); return next; }); }}><summary>{heading}</summary>{content}</details> : <div className="material-selection-root"><div className="skill-library-check">{heading}</div>{content}</div>;
	}
	return <section className="repo-browser material-selection-tree" aria-label="Choose source materials"><input className="skill-import-url" type="search" aria-label="Search source materials" placeholder="Search files and folders" value={query} onChange={(event) => setQuery(event.target.value)} disabled={disabled} />{renderFolder(inventory.root)}{query && !matchingFolders.size && <p className="cli-note">No matching files.</p>}</section>;
}
