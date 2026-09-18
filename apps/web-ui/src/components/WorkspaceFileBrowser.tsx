import { Fragment, useEffect, useRef, useState, type ReactNode } from "react";
import { listWorkspaceFiles, type WorkspaceFileEntry } from "../workspace-files-api";

interface Props {
	agentId: string;
	conversationId: string;
	selectedPath?: string | null;
	onFileSelect?: (entry: WorkspaceFileEntry) => void;
}

const ROOT_PATH = "";

export function WorkspaceFileBrowser({ agentId, conversationId, selectedPath = null, onFileSelect }: Props) {
	const [root, setRoot] = useState<{ displayLabel: string; basename: string } | null>(null);
	const fileButtonRefs = useRef<Record<string, HTMLButtonElement | null>>({});
	const previousSelectedPathRef = useRef<string | null>(selectedPath);
	const [entriesByPath, setEntriesByPath] = useState<Record<string, WorkspaceFileEntry[]>>({});
	const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
	const [loadingPaths, setLoadingPaths] = useState<Set<string>>(() => new Set());
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);
	const generationRef = useRef(0);

	useEffect(() => {
		const generation = ++generationRef.current;
		setRoot(null);
		setEntriesByPath({});
		setExpanded(new Set());
		setLoadingPaths(new Set());
		setLoading(true);
		setError(null);
		void loadDirectory(ROOT_PATH, generation, true);
		return () => {
			generationRef.current += 1;
		};
	}, [agentId, conversationId]);

	useEffect(() => {
		const previousPath = previousSelectedPathRef.current;
		previousSelectedPathRef.current = selectedPath;
		if (!previousPath || selectedPath) return;
		const frame = window.requestAnimationFrame(() => fileButtonRefs.current[previousPath]?.focus());
		return () => window.cancelAnimationFrame(frame);
	}, [selectedPath]);

	async function loadDirectory(relativePath: string, generation = generationRef.current, isRoot = false): Promise<void> {
		setLoadingPaths((current) => new Set(current).add(relativePath));
		if (isRoot) setLoading(true);
		try {
			const listing = await listWorkspaceFiles(agentId, conversationId, relativePath);
			if (generation !== generationRef.current) return;
			setRoot(listing.root);
			setEntriesByPath((current) => ({ ...current, [listing.path]: listing.entries }));
			setError(null);
		} catch (cause) {
			if (generation === generationRef.current) setError((cause as Error).message || "Failed to load workspace files.");
		} finally {
			if (generation !== generationRef.current) return;
			setLoadingPaths((current) => {
				const next = new Set(current);
				next.delete(relativePath);
				return next;
			});
			if (isRoot) setLoading(false);
		}
	}

	function toggleDirectory(entry: WorkspaceFileEntry): void {
		setExpanded((current) => {
			const next = new Set(current);
			if (next.has(entry.relativePath)) {
				next.delete(entry.relativePath);
				return next;
			}
			next.add(entry.relativePath);
			return next;
		});
		if (!entriesByPath[entry.relativePath] && !loadingPaths.has(entry.relativePath)) void loadDirectory(entry.relativePath);
	}

	function renderEntries(relativePath: string, depth: number): ReactNode {
		return (entriesByPath[relativePath] ?? []).map((entry) => {
			const isDirectory = entry.kind === "directory";
			const isOpen = expanded.has(entry.relativePath);
			const isLoading = loadingPaths.has(entry.relativePath);
			const childEntries = entriesByPath[entry.relativePath];
			return (
				<Fragment key={entry.relativePath}>
					{isDirectory ? (
						<button
							type="button"
							className="workspace-file-browser-entry workspace-file-browser-directory"
							style={{ paddingLeft: `${10 + depth * 14}px` }}
							aria-expanded={isOpen}
							title={isOpen ? `Collapse ${entry.name}` : `Expand ${entry.name}`}
							onClick={() => toggleDirectory(entry)}
						>
							<span className="workspace-file-browser-caret" aria-hidden="true">{isOpen ? "▾" : "▸"}</span>
							<span className="workspace-file-browser-icon workspace-file-browser-folder" aria-hidden="true" />
							<span className="workspace-file-browser-name">{entry.name}</span>
							{isLoading && <span className="workspace-file-browser-loading" aria-label="Loading">…</span>}
						</button>
					) : (
						<button
							type="button"
							ref={(node) => { fileButtonRefs.current[entry.relativePath] = node; }}
							className={`workspace-file-browser-entry workspace-file-browser-file${selectedPath === entry.relativePath ? " selected" : ""}`}
							aria-current={selectedPath === entry.relativePath ? "true" : undefined}
							style={{ paddingLeft: `${24 + depth * 14}px` }}
							title={onFileSelect ? entry.relativePath : "File actions will be added later"}
							onClick={() => onFileSelect?.(entry)}
						>
							<span className="workspace-file-browser-icon workspace-file-browser-document" aria-hidden="true" />
							<span className="workspace-file-browser-name">{entry.name}</span>
						</button>
					)}
					{isDirectory && isOpen && (
						<div className="workspace-file-browser-children">
							{isLoading && !childEntries ? <p className="workspace-file-browser-status">Loading…</p> : childEntries?.length === 0 ? <p className="workspace-file-browser-status">Empty folder.</p> : renderEntries(entry.relativePath, depth + 1)}
						</div>
					)}
				</Fragment>
			);
		});
	}

	return (
		<section className="sidebar-workspace-files" aria-label="Workspace files">
			<header className="workspace-file-browser-head">
				<span className="workspace-file-browser-head-label">{root?.displayLabel || root?.basename || "Workspace"}</span>
				{root && <span className="workspace-file-browser-count">{entriesByPath[ROOT_PATH]?.length ?? 0}</span>}
			</header>
			{loading ? <p className="workspace-file-browser-status">Loading…</p> : error ? <p className="workspace-file-browser-status workspace-file-browser-error">{error}</p> : !root ? <p className="workspace-file-browser-status">No workspace folder connected.</p> : entriesByPath[ROOT_PATH]?.length === 0 ? <p className="workspace-file-browser-status">The workspace is empty.</p> : <div className="workspace-file-browser-tree">{renderEntries(ROOT_PATH, 0)}</div>}
		</section>
	);
}
