import { Fragment, useEffect, useRef, useState } from "react";
import { SKILL_FILE_KIND_NAMES, type SkillFileKind } from "../skill-source-copy";
import type { SkillFile } from "../skills-api";
import { useSettingsLookNext } from "../settings-look";
import { ChevronDownIcon } from "./icons";

/**
 * A list of files grouped by folder: one entry per folder, its path in normal
 * ink followed by its file names in muted ink, root files first. Every file is
 * listed; a name never breaks inside itself, lines wrap only between names.
 * Used by a skill's files by kind, on its page and in the review.
 */
export interface FileGroup {
	/** Folder path with a trailing slash, or "" for the root. */
	folder: string;
	names: string[];
}

/** Groups posix-style relative paths by folder, root first, then folders in order. */
export function groupFilesByFolder(files: string[]): FileGroup[] {
	const byFolder = new Map<string, string[]>();
	for (const file of files) {
		const cut = file.lastIndexOf("/");
		const folder = cut === -1 ? "" : file.slice(0, cut + 1);
		const names = byFolder.get(folder) ?? [];
		names.push(file.slice(cut + 1));
		byFolder.set(folder, names);
	}
	return [...byFolder.entries()]
		.sort(([a], [b]) => (a === "" ? -1 : b === "" ? 1 : a.localeCompare(b)))
		.map(([folder, names]) => ({ folder, names }));
}

export function FileGroupList({ groups, className }: { groups: FileGroup[]; className?: string }) {
	return (
		<ul className={`file-groups${className ? ` ${className}` : ""}`}>
			{groups.map((group) => (
				<li key={group.folder}>
					{group.folder && (
						<span className="file-groups-folder" title={group.folder}>
							{/* Each segment keeps its slash; a long path wraps only after one. */}
							{group.folder.split(/(?<=\/)/).map((segment, i) => (
								<Fragment key={i}>
									{i > 0 && <wbr />}
									<span className="file-groups-token">{segment}</span>
								</Fragment>
							))}
						</span>
					)}
					{group.folder && " "}
					{group.names.map((name, i) => (
						<span key={name}>
							<span className="file-groups-token file-groups-name" title={name}>{name}{i < group.names.length - 1 ? "," : ""}</span>
							{i < group.names.length - 1 ? " " : ""}
						</span>
					))}
				</li>
			))}
		</ul>
	);
}

/** The kinds a skill's files are listed by, in order, its instructions first, so the lines add up to the Files row. */
const LISTED_KINDS: readonly SkillFileKind[] = ["instructions", "documents", "templates", "scripts", "other"];

function kindsOf(files: SkillFile[]) {
	return LISTED_KINDS.map((kind) => ({ kind, paths: files.filter((file) => file.kind === kind).map((file) => file.path) })).filter((group) => group.paths.length > 0);
}

/** Whether `SkillFilesByKind` lists anything: a skill that is its instructions alone lists no kinds, as its Files row and its Instructions section say it all. */
export function listsFileKinds(files: SkillFile[]): boolean {
	return !kindsOf(files).every((group) => group.kind === "instructions");
}

/**
 * A skill's files by kind, on its page and in the review: one line per kind
 * with its count, each opening its files on a click, Scripts open at the start.
 * `scriptsLine` is the one explanation, on the Scripts line, of where they run.
 * Each new `revealScripts` opens Scripts, brings its line to the top of the
 * pane and gives it the keyboard (the review's Show scripts).
 */
export function SkillFilesByKind({ files, scriptsLine, revealScripts = 0 }: { files: SkillFile[]; scriptsLine: string | null; revealScripts?: number }) {
	const lookNext = useSettingsLookNext();
	const [open, setOpen] = useState<ReadonlySet<SkillFileKind>>(() => new Set(["scripts"]));
	const scriptsHead = useRef<HTMLButtonElement | null>(null);
	useEffect(() => {
		if (revealScripts === 0) return;
		setOpen((now) => new Set([...now, "scripts"]));
		scriptsHead.current?.scrollIntoView({ block: "start" });
		scriptsHead.current?.focus({ preventScroll: true });
	}, [revealScripts]);
	const kinds = kindsOf(files);
	if (!listsFileKinds(files)) return null;
	const flip = (kind: SkillFileKind) => setOpen((now) => {
		const next = new Set(now);
		if (next.has(kind)) next.delete(kind);
		else next.add(kind);
		return next;
	});
	return (
		<div className="skill-file-kinds">
			{kinds.map(({ kind, paths }) => (
				<div key={kind} className="skill-file-kind">
					<button ref={kind === "scripts" ? scriptsHead : undefined} type="button" className="rs-text-btn skill-file-kind-head" aria-expanded={open.has(kind)} onClick={() => flip(kind)}>
						{lookNext ? (
							// The new look: a chevron that turns, the kind, and its count at the line's end.
							<>
								<span className="skill-file-kind-mark" aria-hidden="true"><ChevronDownIcon size={16} /></span>
								<span className="skill-file-kind-name">{SKILL_FILE_KIND_NAMES[kind]}</span>
								<span className="skill-file-kind-count">{paths.length}</span>
							</>
						) : (
							<>
								<span className="skill-file-kind-mark" aria-hidden="true">{open.has(kind) ? "▾" : "▸"}</span>
								{SKILL_FILE_KIND_NAMES[kind]} ({paths.length})
							</>
						)}
					</button>
					{kind === "scripts" && scriptsLine && <p className="skill-file-kind-line">{scriptsLine}</p>}
					{open.has(kind) && <FileGroupList groups={groupFilesByFolder(paths)} className="skill-file-kind-files" />}
				</div>
			))}
		</div>
	);
}
