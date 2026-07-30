import { useEffect, useState } from "react";
import { resolveRouteUrl, type ArtifactRef } from "./ArtifactViewer";

interface Props {
	taskId: string;
	artifact: ArtifactRef;
	/** Set for user-added rows (files UI slice): the shelf filename, routing downloads through the room-files endpoint. */
	userFileName?: string;
	/** The room — needed to compose room-files URLs for user-added rows. */
	roomId?: string;
	canIterate: boolean;
	/** The specialist's summary — the done-card's "Details" disclosure, relocated
	 * here when the card was retired (status grammar, 2026-07-18). */
	summary?: string;
	onIterate: (brief: string) => boolean;
	iteratePending: boolean;
	/** Server-side refusal for the last change request — rendered inline here. */
	iterateNotice?: string | null;
	/** 💾 Save… — export a snapshot to a folder the user picks. Absent = not saveable (legacy store rows). */
	onSaveTo?: () => void;
	/** Orphan rows only (contract §4): manual per-task delete of the files. */
	onDelete?: () => void;
}

/**
 * The viewer's action footer, split by weight (files UI slice, mockup):
 * on the LEFT the one primary verb — Ask for changes, room-made files only
 * (a user's own file is reference material; derivation happens in chat);
 * on the RIGHT the quiet take-away actions — ⬇ Download and 💾 Save… are
 * SNAPSHOTS (the Google-Docs export rule: nothing syncs back), then Details.
 * Add to conversation and Save to workspace are gone: the room has eyes on
 * its shelf now (manifest + read tools), and snapshots replaced the
 * workspace copy. View chrome (open in new tab, maximize) lives in the
 * header, where chrome belongs.
 */
export function AssetViewerFooter({ taskId, artifact, userFileName, roomId, canIterate, summary, onIterate, iteratePending, iterateNotice, onSaveTo, onDelete }: Props) {
	const [iterateOpen, setIterateOpen] = useState(false);
	const [brief, setBrief] = useState("");
	const [detailsOpen, setDetailsOpen] = useState(false);
	const [localNotice, setLocalNotice] = useState<string | null>(null);
	const [sendInFlight, setSendInFlight] = useState(false);
	const resolved = resolveRouteUrl(taskId, artifact.relativePath, roomId);
	const routeUrl = "url" in resolved ? resolved.url : null;
	const downloadUrl = routeUrl ? `${routeUrl}${routeUrl.includes("?") ? "&" : "?"}download=1` : null;
	const showIterate = canIterate && !userFileName;

	// Never clear the draft at send time: a decline resolves AFTER the frame
	// goes out and must not eat the user's typed brief (the retired done-card's
	// invariant, kept). The draft clears only once the server accepted — the
	// pending flag dropping with no refusal notice.
	useEffect(() => {
		if (iteratePending) return;
		if (!sendInFlight) return;
		setSendInFlight(false);
		if (!iterateNotice) {
			setBrief("");
			setIterateOpen(false);
		}
	}, [iteratePending, iterateNotice, sendInFlight]);

	function submitIterate() {
		const text = brief.trim();
		if (!text) return;
		if (onIterate(text)) {
			setLocalNotice(null);
			setSendInFlight(true);
		} else {
			setLocalNotice("Not connected right now — try again in a moment.");
		}
	}

	function downloadSnapshot() {
		if (!downloadUrl) return;
		const anchor = document.createElement("a");
		anchor.href = downloadUrl;
		anchor.rel = "noopener";
		document.body.appendChild(anchor);
		anchor.click();
		anchor.remove();
	}

	const notice = localNotice ?? iterateNotice ?? null;

	return (
		<div className="asset-viewer-footer">
			<div className="asset-viewer-footer-row">
				{showIterate && (
					<button type="button" className="artifact-viewer-action artifact-viewer-action-primary" aria-expanded={iterateOpen} onClick={() => setIterateOpen((v) => !v)} title="Ask the room to change this file — it revises this same file">
						Ask for changes
					</button>
				)}
				<span className="asset-viewer-footer-spacer" aria-hidden="true" />
				<button type="button" className="artifact-viewer-quiet" disabled={!downloadUrl} onClick={downloadSnapshot} title="Download a snapshot of this file to your Downloads folder">
					⬇ Download
				</button>
				{onSaveTo && (
					<button type="button" className="artifact-viewer-quiet" onClick={onSaveTo} title="Save a snapshot of this file into a folder you pick">
						💾 Save…
					</button>
				)}
				{onDelete && (
					<button type="button" className="artifact-viewer-quiet asset-viewer-delete" onClick={onDelete} title="Delete this task's files from the store">
						Delete
					</button>
				)}
				{summary && (
					<button type="button" className="artifact-viewer-quiet asset-viewer-details" aria-expanded={detailsOpen} onClick={() => setDetailsOpen((v) => !v)} title="What the specialist said it made">
						{detailsOpen ? "Hide details" : "Details"}
					</button>
				)}
			</div>
			{detailsOpen && summary && <div className="asset-viewer-summary">{summary}</div>}
			{iterateOpen && showIterate && (
				<div className="asset-viewer-iterate">
					<input
						className="asset-viewer-iterate-input"
						value={brief}
						placeholder="What should change?"
						disabled={iteratePending}
						autoFocus
						onChange={(e) => setBrief(e.target.value)}
						onKeyDown={(e) => {
							if (e.key === "Enter") submitIterate();
							if (e.key === "Escape") {
								// This Escape means "close the brief input", nothing more —
								// the pane's document-level Escape must not also fire.
								e.stopPropagation();
								setIterateOpen(false);
							}
						}}
					/>
					<button type="button" className="artifact-viewer-action" disabled={iteratePending || !brief.trim()} onClick={submitIterate}>
						{iteratePending ? "Starting…" : "Go"}
					</button>
				</div>
			)}
			{iterateOpen && showIterate && notice && !iteratePending && <div className="asset-viewer-iterate-notice">{notice}</div>}
		</div>
	);
}
