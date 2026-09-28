import { Fragment } from "react";

/**
 * A list of files grouped by folder: one entry per folder, its path in normal
 * ink followed by its file names in muted ink, root files first. Every file is
 * listed; a name never breaks inside itself, lines wrap only between names.
 * Used by a skill's files in Room settings, on its page and in the review.
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
