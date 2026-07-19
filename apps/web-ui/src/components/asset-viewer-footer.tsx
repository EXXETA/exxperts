import { useEffect, useState } from "react";
import { resolveRouteUrl, type ArtifactRef } from "./ArtifactViewer";

interface Props {
	taskId: string;
	artifact: ArtifactRef;
	/** True while the row's task is already a thread item — the transfer door was used. */
	inConversation: boolean;
	/** Orphan rows get the same transfer under its honest name. */
	orphan: boolean;
	canIterate: boolean;
	/** The specialist's summary — the done-card's "Details" disclosure, relocated
	 * here when the card was retired (status grammar, 2026-07-18). */
	summary?: string;
	onAddToConversation: () => void;
	onSaveToWorkspace: () => void;
	onIterate: (brief: string) => boolean;
	iteratePending: boolean;
	/** Server-side refusal for the last change request — rendered inline here. */
	iterateNotice?: string | null;
	/** Orphan rows only (contract §4): manual per-task delete of the files. */
	onDelete?: () => void;
}

/**
 * The reconstituted done-card's action footer (mockup v2 frame 2/3):
 * Add to conversation (or Re-attach to thread for orphans) · Save to
 * workspace · Ask for changes · Open in new tab. Ask for changes reveals an inline brief input —
 * the same user-authored one-click shape as the done card (D7).
 */
export function AssetViewerFooter({ taskId, artifact, inConversation, orphan, canIterate, summary, onAddToConversation, onSaveToWorkspace, onIterate, iteratePending, iterateNotice, onDelete }: Props) {
	const [iterateOpen, setIterateOpen] = useState(false);
	const [brief, setBrief] = useState("");
	const [detailsOpen, setDetailsOpen] = useState(false);
	const [localNotice, setLocalNotice] = useState<string | null>(null);
	const [sendInFlight, setSendInFlight] = useState(false);
	const resolved = resolveRouteUrl(taskId, artifact.relativePath);
	const routeUrl = "url" in resolved ? resolved.url : null;

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

	const notice = localNotice ?? iterateNotice ?? null;

	return (
		<div className="asset-viewer-footer">
			<div className="asset-viewer-footer-row">
				{!inConversation && (
					<button type="button" className="artifact-viewer-action artifact-viewer-action-primary" onClick={onAddToConversation} title="Add this result to the conversation — the room can reference it from then on">
						{orphan ? "Re-attach to thread" : "Add to conversation"}
					</button>
				)}
				<button type="button" className={inConversation ? "artifact-viewer-action artifact-viewer-action-primary" : "artifact-viewer-quiet"} onClick={onSaveToWorkspace} title="Save a copy into this room's workspace folder">
					Save to workspace
				</button>
				{canIterate && (
					<button type="button" className="artifact-viewer-quiet" aria-expanded={iterateOpen} onClick={() => setIterateOpen((v) => !v)} title="Ask the same specialist to change this result">
						Ask for changes
					</button>
				)}
				<button
					type="button"
					className="artifact-viewer-quiet"
					disabled={!routeUrl}
					onClick={() => routeUrl && window.open(routeUrl, "_blank", "noopener,noreferrer")}
					title="Open this artifact in a new browser tab"
				>
					Open in new tab
				</button>
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
			{iterateOpen && canIterate && (
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
			{iterateOpen && canIterate && notice && !iteratePending && <div className="asset-viewer-iterate-notice">{notice}</div>}
		</div>
	);
}
