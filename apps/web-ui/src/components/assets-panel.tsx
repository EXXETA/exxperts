import { useState } from "react";
import { windowAssetRows, type AssetRowView } from "../assets-panel";

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
	 * Remove from list (user control, 2026-07-20): the hover-reveal ✕ on every
	 * settled row. A list operation only — files are kept; the caller shows the
	 * Undo toast. Running rows never offer it (they must settle first).
	 */
	onRemove?: (row: AssetRowView) => void;
}

/**
 * The in-room rail's Artifacts section (assets contract §2 rung 3, mockup v2;
 * room-scoped 2026-07-18): compact rows — type icon, title, status subline
 * (a status word alone, or the time on plain done rows) as the single
 * status channel. Room-wide, flat, newest-first — rows survive Memento and
 * checkpoint, so the header is just "Artifacts": the room is the ambient
 * container. Collapsible; the count survives collapse; 3 rows resting,
 * "Show all (N)" expands. Rendered only when the room has rows at all —
 * the rail below Home stays reserved space otherwise.
 */
export function AssetsPanel({ rows, selectedTaskId, onSelect, onStopRunning, onRemove }: Props) {
	const [collapsed, setCollapsed] = useState(false);
	const [showAll, setShowAll] = useState(false);
	if (rows.length === 0) return null;
	const { visible, hiddenCount } = windowAssetRows(rows, showAll);
	return (
		<div className="sidebar-assets" aria-label="Artifacts in this room">
			<button className="assets-head" aria-expanded={!collapsed} onClick={() => setCollapsed((v) => !v)}>
				<span className="assets-caret">{collapsed ? "▸" : "▾"}</span>
				<span className="assets-head-label">Artifacts</span>
				<span className="assets-count">{rows.length}</span>
			</button>
			{!collapsed && (
				<div className="assets-rows">
					{visible.map((row) => {
						// The live running row opens the run view (stream + Stop); done
						// rows need files to open. Everything else stays inert.
						const clickable = row.artifacts.length > 0 || row.running;
						return (
							<span key={row.taskId} className={`assets-row-wrap${row.running ? " running" : ""}`}>
								<button
									className={`assets-row${row.orphan ? " orphan" : ""}${row.taskId === selectedTaskId ? " sel" : ""}`}
									disabled={!clickable}
									title={clickable ? (row.running ? `${row.title} — follow the run` : row.title) : `${row.title} — no files to open`}
									onClick={() => clickable && onSelect(row)}
								>
									<span className={`assets-icon${row.orphan ? " orphan" : ""}`} aria-hidden="true">
										{row.running ? <span className="assets-pulse" /> : row.iconLabel}
									</span>
									<span className="assets-meta">
										<span className="assets-row-title">{row.title}</span>
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
								{!row.running && onRemove && (
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
					{showAll && rows.length > 3 && (
						<button className="assets-showall" onClick={() => setShowAll(false)}>Show fewer</button>
					)}
				</div>
			)}
		</div>
	);
}
