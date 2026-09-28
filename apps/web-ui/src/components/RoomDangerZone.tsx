import { useEffect, useState } from "react";
import type { PersistentAgentArchiveResponse, PersistentAgentId, PersistentAgentLifecycleCounts, PersistentAgentPurgeResponse, PersistentAgentStatus } from "../types";
import { fetchPersistentRoomLifecycleCounts } from "../persistent-room-management-api";
import { confirmDialog } from "./confirm-dialog";
import { PaneHeader } from "./pane-header";

function plural(count: number, noun: string, pluralNoun = `${noun}s`): string {
	return `${count} ${count === 1 ? noun : pluralNoun}`;
}

/** What a forever-delete takes with it, said only when there is something:
 * nothing with no files, the file count alone when none is a document. */
export function roomFilesSentence(counts: { files: number; documents: number }): string {
	if (counts.files === 0) return "";
	if (counts.documents === 0) return `It holds ${plural(counts.files, "file")}. `;
	return `Its ${plural(counts.files, "file")} include ${plural(counts.documents, "document")} the room created. `;
}

function lifecycleCountsLine(counts: PersistentAgentLifecycleCounts): string {
	return `${plural(counts.conversations, "conversation")}, ${plural(counts.memories, "recent memory entry", "recent memory entries")} and ${plural(counts.files, "file")}`;
}

// Deleting is the one action the room cannot come back from, so the pane
// states what is at stake in real numbers and the red button asks first, in
// the app's own dialog, with the counts spelled out. `visible` is the pane's
// own visibility (the modal keeps panes mounted): entering refetches the counts.
export function RoomDangerZone({ status, visible, onArchive, onPurge }: {
	status: PersistentAgentStatus;
	visible: boolean;
	onArchive: (agentId: PersistentAgentId, confirmation: string) => Promise<PersistentAgentArchiveResponse>;
	onPurge: (agentId: PersistentAgentId, confirmation: string) => Promise<PersistentAgentPurgeResponse>;
}) {
	const [counts, setCounts] = useState<PersistentAgentLifecycleCounts | null>(null);
	const [countsFailed, setCountsFailed] = useState(false);
	const [submitting, setSubmitting] = useState<"purge" | "archive" | null>(null);
	const [error, setError] = useState<string | null>(null);
	const roomName = status.displayName || status.id;

	useEffect(() => {
		if (!visible) return;
		let cancelled = false;
		setCountsFailed(false);
		fetchPersistentRoomLifecycleCounts(status.id)
			.then((response) => { if (!cancelled) setCounts(response.counts); })
			.catch(() => {
				// The pane keeps working without numbers — but says so, instead
				// of an eternal "checking…".
				if (!cancelled) setCountsFailed(true);
			});
		return () => { cancelled = true; };
	}, [visible, status.id]);

	useEffect(() => {
		setCounts(null);
	}, [status.id]);

	async function submitPurge(): Promise<void> {
		setError(null);
		const ok = await confirmDialog({
			title: `Delete ${roomName} forever?`,
			body: `${counts ? roomFilesSentence(counts) : ""}Everything is removed from this machine. This cannot be undone.`,
			confirmLabel: "Delete forever",
			cancelLabel: "Keep it",
			danger: true,
		});
		if (!ok) return;
		setSubmitting("purge");
		try {
			await onPurge(status.id, `DELETE ${status.id} FOREVER`);
		} catch (e) {
			setError((e as Error).message || "Failed to delete room.");
			setSubmitting(null);
		}
	}

	async function submitArchive(): Promise<void> {
		setSubmitting("archive");
		setError(null);
		try {
			await onArchive(status.id, `DELETE ${status.id}`);
		} catch (e) {
			setError((e as Error).message || "Failed to archive room.");
			setSubmitting(null);
		}
	}

	return (
		<div className="room-danger-zone">
			<PaneHeader
				title="Delete room"
				line={counts
					? `This room holds ${lifecycleCountsLine(counts)} on this machine.`
					: countsFailed
						? "The room's contents could not be counted right now. Deleting still removes everything on this machine."
						: "Checking what this room holds on this machine…"}
			/>
			<div className="settings-rows">
				<div className="settings-row">
					<div className="settings-row-main">
						<span className="settings-row-label">Archive</span>
						<span className="settings-row-sub">The room leaves Home but everything stays on this machine. Restore it anytime from Archived rooms.</span>
					</div>
					<button className="rs-btn" disabled={submitting !== null} onClick={() => void submitArchive()}>
						{submitting === "archive" ? "Archiving…" : "Archive"}
					</button>
				</div>
				<div className="settings-row">
					<div className="settings-row-main">
						<span className="settings-row-label">Delete {roomName} permanently</span>
						<span className="settings-row-sub">Removes everything from this machine: the room's memory, its conversations, and any documents not saved outside the room. Files you saved to your own folders stay where they are. This cannot be undone.</span>
					</div>
					<button className="rs-btn rs-btn-danger" disabled={submitting !== null} onClick={() => void submitPurge()}>
						{submitting === "purge" ? "Deleting…" : "Delete permanently"}
					</button>
				</div>
			</div>
			{error && <div className="workspaces-error">{error}</div>}
		</div>
	);
}
