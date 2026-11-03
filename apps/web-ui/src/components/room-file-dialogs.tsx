import { useState } from "react";
import { useEscapeKey } from "./use-escape-key";

// Export collision (assets contract §5): the three-button flow. Replace is the
// destructive choice; Keep both auto-suffixes server-side; no filename typing.
type ExportCollision = { fileName: string; place?: string; onReplace: () => void; onKeepBoth: () => void };

function ExportCollisionDialog({ collision, onClose }: { collision: ExportCollision; onClose: () => void }) {
	useEscapeKey(onClose, true);
	return (
		<div className="checkpoint-preview-backdrop maintain-confirm-backdrop" role="dialog" aria-modal="true" aria-label="File already exists">
			<section className="checkpoint-input-card maintain-confirm-card">
				<h2>File already exists</h2>
				<p>A file called “{collision.fileName}” is already in {collision.place ?? "the chosen folder"}.</p>
				<div className="checkpoint-preview-actions">
					<button className="rs-btn" autoFocus onClick={onClose}>Cancel</button>
					<button className="rs-btn" onClick={() => { onClose(); collision.onKeepBoth(); }} title="Save with a new name; the existing file stays">Keep both</button>
					<button className="rs-btn rs-btn-danger" onClick={() => { onClose(); collision.onReplace(); }} title="Overwrite the existing file">Replace</button>
				</div>
			</section>
		</div>
	);
}

// Per-task delete confirm (assets contract §4): destructive-styled, names the
// task, cancel is the safe default.
function AssetDeleteDialog({ title, onDelete, onCancel }: { title: string; onDelete: () => void; onCancel: () => void }) {
	useEscapeKey(onCancel, true);
	return (
		<div className="checkpoint-preview-backdrop maintain-confirm-backdrop" role="dialog" aria-modal="true" aria-label="Delete task files">
			<section className="checkpoint-input-card maintain-confirm-card">
				<h2>Delete “{title}”?</h2>
				<p>This removes its files for good. Snapshots you downloaded or saved to a folder stay.</p>
				<div className="checkpoint-preview-actions">
					<button className="rs-btn" autoFocus onClick={onCancel}>Cancel</button>
					<button className="rs-btn rs-btn-danger" onClick={onDelete}>Delete</button>
				</div>
			</section>
		</div>
	);
}

// Unified delete (files-management slice): the informed confirm for files
// whose loss costs more than a re-upload — room-made files (the room's work)
// and files the room already read this session. Cancel is the safe default.
function FileDeleteDialog({ fileName, reason, onDelete, onCancel }: { fileName: string; reason: string; onDelete: () => void; onCancel: () => void }) {
	useEscapeKey(onCancel, true);
	return (
		<div className="checkpoint-preview-backdrop maintain-confirm-backdrop" role="dialog" aria-modal="true" aria-label="Delete file">
			<section className="checkpoint-input-card maintain-confirm-card">
				<h2>Delete “{fileName}”?</h2>
				<p>{reason} Snapshots you downloaded or saved to a folder stay.</p>
				<div className="checkpoint-preview-actions">
					<button className="rs-btn" autoFocus onClick={onCancel}>Cancel</button>
					<button className="rs-btn rs-btn-danger" onClick={onDelete}>Delete</button>
				</div>
			</section>
		</div>
	);
}

// 💾 Save… filename step (files-management slice): pre-filled with the shelf
// name, editable before the folder picker opens; the export and its collision
// flow key off the chosen name.
function SaveAsDialog({ shelfName, onSave, onCancel }: { shelfName: string; onSave: (name: string) => void; onCancel: () => void }) {
	const [draft, setDraft] = useState(shelfName);
	useEscapeKey(onCancel, true);
	const commit = () => {
		const name = draft.trim();
		if (name) onSave(name);
	};
	return (
		<div className="checkpoint-preview-backdrop maintain-confirm-backdrop" role="dialog" aria-modal="true" aria-label="Save file as">
			<section className="checkpoint-input-card maintain-confirm-card">
				<h2>Save a snapshot</h2>
				<p>Pick the file name; you choose the folder next.</p>
				<input
					className="save-as-input"
					value={draft}
					autoFocus
					aria-label="File name"
					onFocus={(e) => {
						const dot = draft.lastIndexOf(".");
						e.currentTarget.setSelectionRange(0, dot > 0 ? dot : draft.length);
					}}
					onChange={(e) => setDraft(e.target.value)}
					onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); commit(); } }}
				/>
				<div className="checkpoint-preview-actions">
					<button className="rs-btn" onClick={onCancel}>Cancel</button>
					<button className="rs-btn rs-btn-primary" disabled={!draft.trim()} onClick={commit}>Choose folder…</button>
				</div>
			</section>
		</div>
	);
}

export { AssetDeleteDialog, ExportCollisionDialog, FileDeleteDialog, SaveAsDialog };
export type { ExportCollision };
