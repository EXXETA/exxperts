import { useEffect, useRef, useState } from "react";
import { ASSET_PANEL_DEFAULT_VISIBLE, rowShelfFileName, windowAssetRows, type AssetRowView } from "../assets-panel";

interface Props {
	rows: AssetRowView[];
	selectedTaskId: string | null;
	onSelect: (row: AssetRowView) => void;
	/**
	 * Stop the LIVE running task (status grammar, 2026-07-18): the hover-reveal
	 * stop square on the running row — one of Stop's two homes, beside the run
	 * view's footer action. Only the genuinely live row ever offers it.
	 */
	onStopRunning?: () => void;
	/**
	 * Remove from list (user control, 2026-07-20): the hover-reveal ✕ on rows
	 * that are RUNS, not files (multi-file, legacy tasks/ paths). A list
	 * operation only — files are kept; the caller shows the Undo toast.
	 */
	onRemove?: (row: AssetRowView) => void;
	/**
	 * Real delete (files-management slice): the hover-reveal ✕ on FILE rows —
	 * one shelf file, one row, and Delete really deletes (bytes + reading
	 * cache) behind the caller's informed confirm + undo toast.
	 */
	onDeleteFile?: (row: AssetRowView, fileName: string) => void;
	/** Inline rename commit for file rows; the caller talks to the server and refreshes. */
	onRenameFile?: (row: AssetRowView, fileName: string, newName: string) => void;
}

/** Height-derived resting window: as many rows as the sidebar fits (8–10 typical) before "Show all". */
function visibleCountForViewport(innerHeight: number): number {
	return Math.max(4, Math.min(12, Math.floor((innerHeight - 560) / 33)));
}

/**
 * The in-room rail's Files section (files UI slice; formerly "Artifacts",
 * assets contract §2 rung 3, mockup v2; room-scoped 2026-07-18): ONE list
 * for everything the room made and everything the user gave it — compact
 * rows with type icon, title, and the subline as the single status channel;
 * resting rows read verb + moment in ONE grammar — "created · Jul 23" for
 * room-made, "attached · 17:14" for user-added, time today and date otherwise
 * for both. Room-wide, flat, newest-first — rows survive Memento
 * and checkpoint: the room is the ambient container. Collapsible; the count
 * survives collapse; the resting window fits the sidebar height, "Show all
 * (N)" expands. Rendered only when the room has rows at all.
 */
export function AssetsPanel({ rows, selectedTaskId, onSelect, onStopRunning, onRemove, onDeleteFile, onRenameFile }: Props) {
	const [collapsed, setCollapsed] = useState(false);
	const [showAll, setShowAll] = useState(false);
	const [visibleCount, setVisibleCount] = useState<number>(() => (typeof window === "undefined" ? ASSET_PANEL_DEFAULT_VISIBLE : visibleCountForViewport(window.innerHeight)));
	const [renaming, setRenaming] = useState<{ taskId: string; draft: string } | null>(null);
	const renameInputRef = useRef<HTMLInputElement | null>(null);
	useEffect(() => {
		const onResize = () => setVisibleCount(visibleCountForViewport(window.innerHeight));
		window.addEventListener("resize", onResize);
		return () => window.removeEventListener("resize", onResize);
	}, []);
	useEffect(() => {
		if (renaming) renameInputRef.current?.select();
	}, [renaming?.taskId]);
	if (rows.length === 0) return null;
	const { visible, hiddenCount } = windowAssetRows(rows, showAll, visibleCount);
	const commitRename = (row: AssetRowView, fileName: string) => {
		const draft = renaming?.draft.trim() ?? "";
		setRenaming(null);
		if (draft && draft !== fileName && onRenameFile) onRenameFile(row, fileName, draft);
	};
	return (
		<div className="sidebar-assets" aria-label="Files in this room">
			<button className="assets-head" aria-expanded={!collapsed} title="Show or hide the files this room has made and received" onClick={() => setCollapsed((v) => !v)}>
				<span className="assets-caret">{collapsed ? "▸" : "▾"}</span>
				<span className="assets-head-label">Files</span>
				<span className="assets-count">{rows.length}</span>
			</button>
			{!collapsed && (
				<div className="assets-rows">
					{visible.map((row) => {
						// The live running row opens the run view (stream + Stop); done
						// rows need files to open. Everything else stays inert.
						const clickable = row.artifacts.length > 0 || row.running;
						const fileName = rowShelfFileName(row);
						const isRenaming = renaming?.taskId === row.taskId && fileName !== null;
						return (
							<span key={row.taskId} className={`assets-row-wrap${row.running ? " running" : ""}`}>
								<button
									className={`assets-row${row.orphan ? " orphan" : ""}${row.taskId === selectedTaskId ? " sel" : ""}`}
									disabled={!clickable}
									title={clickable ? (row.running ? `${row.title} — follow the run` : row.title) : `${row.title} — no files to open`}
									onClick={() => !isRenaming && clickable && onSelect(row)}
								>
									<span className={`assets-icon${row.orphan ? " orphan" : ""}`} aria-hidden="true">
										{row.running ? <span className="assets-pulse" /> : row.iconLabel}
									</span>
									<span className="assets-meta">
										{isRenaming ? (
											<input
												ref={renameInputRef}
												className="assets-rename-input"
												value={renaming.draft}
												aria-label={`New name for ${fileName}`}
												onClick={(e) => e.stopPropagation()}
												onChange={(e) => setRenaming({ taskId: row.taskId, draft: e.target.value })}
												onKeyDown={(e) => {
													if (e.key === "Enter") { e.preventDefault(); commitRename(row, fileName); }
													else if (e.key === "Escape") { e.preventDefault(); setRenaming(null); }
												}}
												onBlur={() => commitRename(row, fileName)}
											/>
										) : (
											<span className="assets-row-title">{row.title}</span>
										)}
										<span className="assets-row-sub">
											{row.unread && <span className="assets-dot assets-dot-ready" aria-hidden="true" />}
											{row.failed && <span className="assets-dot assets-dot-failed" aria-hidden="true" />}
											{row.subline}
										</span>
									</span>
								</button>
								{row.running && onStopRunning && (
									<button
										type="button"
										className="assets-row-stop"
										onClick={(e) => { e.stopPropagation(); onStopRunning(); }}
										title="Stop this task. Files it already wrote are kept."
										aria-label={`Stop ${row.title}`}
									/>
								)}
								{/* File rows (one shelf file = one row) get the file verbs:
								    inline rename and the real Delete. Run rows (multi-file,
								    legacy tasks/ paths) keep remove-from-list — a list
								    operation that keeps files. */}
								{!row.running && fileName !== null && !isRenaming && onRenameFile && (
									<button
										type="button"
										className="assets-row-rename"
										onClick={(e) => { e.stopPropagation(); setRenaming({ taskId: row.taskId, draft: fileName }); }}
										title="Rename this file."
										aria-label={`Rename ${fileName}`}
									>
										✎
									</button>
								)}
								{!row.running && fileName !== null && onDeleteFile && (
									<button
										type="button"
										className="assets-row-remove"
										onClick={(e) => { e.stopPropagation(); onDeleteFile(row, fileName); }}
										title="Delete this file. Bytes are removed; Undo is offered briefly."
										aria-label={`Delete ${fileName}`}
									>
										×
									</button>
								)}
								{!row.running && fileName === null && !row.userFileName && onRemove && (
									<button
										type="button"
										className="assets-row-remove"
										onClick={(e) => { e.stopPropagation(); onRemove(row); }}
										title="Remove from the list. Its files are kept."
										aria-label={`Remove ${row.title} from the list`}
									>
										×
									</button>
								)}
							</span>
						);
					})}
					{hiddenCount > 0 && (
						<button className="assets-showall" onClick={() => setShowAll(true)}>Show all ({rows.length})</button>
					)}
					{showAll && rows.length > visibleCount && (
						<button className="assets-showall" onClick={() => setShowAll(false)}>Show fewer</button>
					)}
				</div>
			)}
		</div>
	);
}
