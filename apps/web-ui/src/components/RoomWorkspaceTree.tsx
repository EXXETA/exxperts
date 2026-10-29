/*
 * Adapted from Omnigent's FolderTree and FilesPanel tree row model, sorting and
 * lazy directory expansion at commit da7555532be25cd127a3cdee8bf8bb32071932fb:
 * https://github.com/omnigent-ai/omnigent/blob/da7555532be25cd127a3cdee8bf8bb32071932fb/web/src/shell/FolderTree.tsx
 * https://github.com/omnigent-ai/omnigent/blob/da7555532be25cd127a3cdee8bf8bb32071932fb/web/src/shell/FilesPanel.tsx
 * Copyright (2026) Databricks, Inc. Licensed under Apache-2.0; see LICENSE and NOTICE.
 * Changes: adapted to Exxperts' room-scoped workspace API, sidebar slot, and
 * insertion of relative paths into the chat composer.
 */
import { useCallback, useEffect, useId, useRef, useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import { fetchPersistentRoomWorkspaceTree } from "../persistent-room-workspace-api";
import type { PersistentRoomWorkspaceTreeEntry, PersistentRoomWorkspaceTreeResponse } from "../types";

export const WORKSPACE_PATH_DRAG_TYPE = "application/x-exxperts-workspace-path";

interface DirectoryView {
	entries: PersistentRoomWorkspaceTreeEntry[];
	nextCursor: string | null;
	truncated: boolean;
	omitted: PersistentRoomWorkspaceTreeResponse["omitted"];
}

interface Props {
	agentId: string;
	conversationId: string;
	onInsertPath: (relativePath: string) => void;
}

export function RoomWorkspaceTree({ agentId, conversationId, onInsertPath }: Props) {
	const [directories, setDirectories] = useState<Record<string, DirectoryView>>({});
	const directoriesRef = useRef(directories);
	directoriesRef.current = directories;
	const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
	const [loading, setLoading] = useState<Record<string, boolean>>({});
	const [errors, setErrors] = useState<Record<string, string>>({});
	const [root, setRoot] = useState<PersistentRoomWorkspaceTreeResponse | null>(null);
	const [showHidden, setShowHidden] = useState(false);
	const [treeOpen, setTreeOpen] = useState(true);
	const treeBodyId = useId();
	const requestKeys = useRef(new Set<string>());
	const epoch = useRef(0);
	const mounted = useRef(false);

	const loadDirectory = useCallback(async (path: string, cursor?: string, force = false) => {
		if (!cursor && !force && directoriesRef.current[path]) return;
		const requestEpoch = epoch.current;
		const requestKey = `${requestEpoch}\0${path}\0${cursor ?? ""}`;
		if (requestKeys.current.has(requestKey)) return;
		requestKeys.current.add(requestKey);
		setLoading((current) => ({ ...current, [path]: true }));
		setErrors((current) => ({ ...current, [path]: "" }));
		try {
			const page = await fetchPersistentRoomWorkspaceTree(agentId, conversationId, path, cursor);
			if (!mounted.current || requestEpoch !== epoch.current) return;
			setRoot(page);
			if (!page.available) {
				setDirectories({});
				return;
			}
			setDirectories((current) => {
				const prior = cursor ? current[path]?.entries ?? [] : [];
				const entriesByPath = new Map(prior.map((entry) => [entry.relativePath, entry]));
				for (const entry of page.entries) entriesByPath.set(entry.relativePath, entry);
				return {
					...current,
					[path]: {
						entries: [...entriesByPath.values()],
						nextCursor: page.nextCursor,
						truncated: page.truncated,
						omitted: page.omitted,
					},
				};
			});
		} catch (error) {
			if (!mounted.current || requestEpoch !== epoch.current) return;
			setErrors((current) => ({
				...current,
				[path]: error instanceof Error ? error.message : "Das Verzeichnis konnte nicht geladen werden.",
			}));
		} finally {
			requestKeys.current.delete(requestKey);
			if (mounted.current && requestEpoch === epoch.current) {
				setLoading((current) => ({ ...current, [path]: false }));
			}
		}
	}, [agentId, conversationId]);

	useEffect(() => {
		mounted.current = true;
		void loadDirectory(".");
		return () => {
			mounted.current = false;
			epoch.current++;
		};
	}, [loadDirectory]);

	const refresh = () => {
		epoch.current++;
		setRoot(null);
		setDirectories({});
		setLoading({});
		setErrors({});
		setExpanded(new Set());
		void loadDirectory(".", undefined, true);
	};

	const toggleDirectory = (relativePath: string) => {
		const isExpanded = expanded.has(relativePath);
		setExpanded((current) => {
			const next = new Set(current);
			if (isExpanded) next.delete(relativePath);
			else next.add(relativePath);
			return next;
		});
		if (!isExpanded && !directoriesRef.current[relativePath]) void loadDirectory(relativePath);
	};

	const renderDirectory = (path: string, depth: number): ReactNode => {
		const directory = directories[path];
		const isLoading = Boolean(loading[path]);
		const error = errors[path];
		if (!directory) {
			if (isLoading) return <p className="room-workspace-tree-note" role="status">Wird geladen…</p>;
			if (error) return <div className="room-workspace-tree-error" role="alert"><span>{error}</span><button type="button" onClick={() => void loadDirectory(path, undefined, true)}>Erneut laden</button></div>;
			return null;
		}
		const visible = showHidden ? directory.entries : directory.entries.filter((entry) => !entry.name.startsWith("."));
		const hiddenOnly = directory.entries.length > 0 && visible.length === 0;
		return <>
			{visible.length > 0 && <ul className="room-workspace-tree-list" aria-busy={isLoading || undefined}>
				{visible.map((entry) => {
					const rowStyle = { "--tree-depth": depth } as CSSProperties;
					if (entry.kind === "directory") {
						const open = expanded.has(entry.relativePath);
						return <li className="room-workspace-tree-row" key={entry.relativePath} style={rowStyle}>
							<button className="room-workspace-tree-folder" type="button" aria-label={`Ordner ${entry.relativePath}`} aria-expanded={open} onClick={() => toggleDirectory(entry.relativePath)} title={entry.relativePath}>
								<span aria-hidden="true">{open ? "▾" : "▸"}</span><span aria-hidden="true">📁</span><span>{entry.name}</span>
							</button>
							{open && renderDirectory(entry.relativePath, depth + 1)}
						</li>;
					}
					if (entry.kind === "file") return <li className="room-workspace-tree-row" key={entry.relativePath} style={rowStyle}>
						<button
							className="room-workspace-tree-file"
							type="button"
							draggable
							title={`${entry.relativePath} — in den Chat ziehen oder zum Einfügen aktivieren`}
							aria-label={`Relativen Pfad ${entry.relativePath} in den Chat einfügen`}
							onClick={() => onInsertPath(entry.relativePath)}
							onDragStart={(event) => {
								event.dataTransfer.setData(WORKSPACE_PATH_DRAG_TYPE, entry.relativePath);
								event.dataTransfer.setData("text/plain", entry.relativePath);
								event.dataTransfer.effectAllowed = "copy";
							}}
						>
							<span aria-hidden="true">📄</span><span>{entry.name}</span>
						</button>
					</li>;
					return <li className="room-workspace-tree-row room-workspace-tree-symlink" key={entry.relativePath} style={rowStyle} title="Verknüpfung wird angezeigt, aber nicht verfolgt">
						<span aria-hidden="true">↗</span><span>{entry.name}</span>
					</li>;
				})}
			</ul>}
			{hiddenOnly && <p className="room-workspace-tree-note" role="status">In diesem Ordner gibt es nur ausgeblendete Dateien. Aktiviere „Versteckte Dateien anzeigen“, um sie einzublenden.</p>}
			{directory.entries.length === 0 && !isLoading && <p className="room-workspace-tree-note" role="status">Dieser Ordner ist leer.</p>}
			{error && <div className="room-workspace-tree-error" role="alert"><span>{error}</span><button type="button" onClick={() => void loadDirectory(path, directory.nextCursor ?? undefined, true)}>Erneut laden</button></div>}
			{(directory.omitted.denied + directory.omitted.unreadable + directory.omitted.special > 0) && <p className="room-workspace-tree-note">Einige Einträge wurden aus Sicherheitsgründen oder wegen Lesefehlern ausgelassen.</p>}
			{directory.truncated && <p className="room-workspace-tree-note">Dieser Ordner überschreitet das Limit von 10.000 Einträgen; weitere Einträge werden nicht angezeigt.</p>}
			{directory.nextCursor && <button className="room-workspace-tree-more" type="button" disabled={isLoading} onClick={() => void loadDirectory(path, directory.nextCursor ?? undefined, true)}>Weitere Einträge laden</button>}
			{isLoading && directory.entries.length > 0 && <p className="room-workspace-tree-note" role="status">Weitere Einträge werden geladen…</p>}
		</>;
	};

	return <section className="sidebar-section room-workspace-tree" aria-label="Arbeitsordner">
		<div className="room-workspace-tree-heading">
			<button
				className="room-workspace-tree-toggle"
				type="button"
				aria-expanded={treeOpen}
				aria-controls={treeBodyId}
				onClick={() => setTreeOpen((open) => !open)}
			>
				<span className="sidebar-title">Arbeitsordner</span>
				{root?.available && root.rootLabel && <span className="room-workspace-tree-root-label" title={root.rootLabel}>{root.rootLabel}</span>}
			</button>
			<div className="room-workspace-tree-actions">
				<button type="button" title="Versteckte Dateien ein- oder ausblenden" aria-pressed={showHidden} onClick={() => setShowHidden((value) => !value)}>{showHidden ? "Versteckte Dateien ausblenden" : "Versteckte Dateien anzeigen"}</button>
				<button type="button" title="Arbeitsordner aktualisieren" onClick={refresh}>Aktualisieren</button>
			</div>
		</div>
		<div id={treeBodyId} className="room-workspace-tree-body" hidden={!treeOpen} aria-busy={Boolean(loading["."]) || undefined}>
			{root?.available && renderDirectory(".", 0)}
			{root && !root.available && <p className="room-workspace-tree-note" role="status">{root.reason === "workspace_missing" ? "Der ausgewählte Arbeitsordner ist nicht mehr verfügbar." : "Für diesen Raum ist kein lesbarer Arbeitsordner eingerichtet. Lege ihn in den Raumeinstellungen fest."}</p>}
			{!root && loading["."] && <p className="room-workspace-tree-note" role="status">Arbeitsordner wird geladen…</p>}
			{!root && errors["."] && <div className="room-workspace-tree-error" role="alert"><span>{errors["."]}</span><button type="button" onClick={() => void loadDirectory(".", undefined, true)}>Erneut laden</button></div>}
		</div>
	</section>;
}
