import { useState } from "react";
import { resolveRouteUrl, type ArtifactRef } from "./ArtifactViewer";
import { showsComputerOnlyControls, useRemoteClientContext } from "../remote-client-context";
import { DownloadIcon, SaveIcon } from "./icons";

interface Props {
	taskId: string;
	artifact: ArtifactRef;
	/** The room — needed to compose room-files URLs for user-added rows. */
	roomId?: string;
	/** The specialist's summary — the done-card's "Details" disclosure, relocated
	 * here when the card was retired. */
	summary?: string;
	/** Save…: export a snapshot to a folder the user picks. Absent = not saveable (legacy store rows). */
	onSaveTo?: () => void;
	/** Orphan rows only (contract §4): manual per-task delete of the files. */
	onDelete?: () => void;
}

/** A file route's download form. */
export function fileDownloadUrl(routeUrl: string): string {
	return `${routeUrl}${routeUrl.includes("?") ? "&" : "?"}download=1`;
}

/**
 * The viewer's action footer: the quiet take-away actions, right-aligned.
 * Download and Save… are SNAPSHOTS (the Google-Docs export rule: nothing
 * syncs back), then Details. Changes to a file are asked for in the chat:
 * specialists, which once revised a file from here, are switched off.
 * Add to conversation and Save to workspace are gone: the room has eyes on
 * its shelf now (manifest + read tools), and snapshots replaced the
 * workspace copy. View chrome (open in new tab, maximize) lives in the
 * header, where chrome belongs.
 */
export function AssetViewerFooter({ taskId, artifact, roomId, summary, onSaveTo, onDelete }: Props) {
	// Save… opens a native folder dialog on the computer; hidden for remote
	// devices (Download remains the take-away there).
	const remoteClient = useRemoteClientContext();
	const [detailsOpen, setDetailsOpen] = useState(false);
	const resolved = resolveRouteUrl(taskId, artifact.relativePath, roomId);
	const routeUrl = "url" in resolved ? resolved.url : null;
	const downloadUrl = routeUrl ? fileDownloadUrl(routeUrl) : null;

	function downloadSnapshot() {
		if (!downloadUrl) return;
		const anchor = document.createElement("a");
		anchor.href = downloadUrl;
		anchor.rel = "noopener";
		document.body.appendChild(anchor);
		anchor.click();
		anchor.remove();
	}

	return (
		<div className="asset-viewer-footer">
			<div className="asset-viewer-footer-row">
				<span className="asset-viewer-footer-spacer" aria-hidden="true" />
				<button type="button" className="artifact-viewer-quiet" disabled={!downloadUrl} onClick={downloadSnapshot} title="Download a snapshot of this file to your Downloads folder">
					<DownloadIcon size={14} /> Download
				</button>
				{onSaveTo && showsComputerOnlyControls(remoteClient) && (
					<button type="button" className="artifact-viewer-quiet" onClick={onSaveTo} title="Save a snapshot of this file into a folder you pick">
						<SaveIcon size={14} /> Save…
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
		</div>
	);
}
