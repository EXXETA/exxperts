import { useEffect, useState } from "react";
import type { PersistentAgentArchiveResponse, PersistentAgentId, PersistentAgentLifecycleCounts, PersistentAgentPurgeResponse, PersistentAgentStatus } from "../types";
import { fetchPersistentRoomLifecycleCounts } from "../persistent-room-management-api";

function plural(count: number, noun: string, pluralNoun = `${noun}s`): string {
	return `${count} ${count === 1 ? noun : pluralNoun}`;
}

function lifecycleCountsLine(counts: PersistentAgentLifecycleCounts): string {
	return `${plural(counts.conversations, "conversation")}, ${plural(counts.memories, "memory", "memories")} and ${plural(counts.files, "file")}`;
}

// Deleting is the one action the room cannot come back from, so the pane
// states what is at stake in real numbers and the red button asks twice:
// the first click arms it and spells out the counts, the second executes.
// `visible` is the pane's own visibility (the modal keeps panes mounted):
// entering refetches the counts, and LEAVING disarms — an armed red button
// must never survive a trip through another pane.
export function RoomDangerZone({ status, visible, onArchive, onPurge }: {
	status: PersistentAgentStatus;
	visible: boolean;
	onArchive: (agentId: PersistentAgentId, confirmation: string) => Promise<PersistentAgentArchiveResponse>;
	onPurge: (agentId: PersistentAgentId, confirmation: string) => Promise<PersistentAgentPurgeResponse>;
}) {
	const [counts, setCounts] = useState<PersistentAgentLifecycleCounts | null>(null);
	const [countsFailed, setCountsFailed] = useState(false);
	const [armed, setArmed] = useState(false);
	const [submitting, setSubmitting] = useState<"purge" | "archive" | null>(null);
	const [error, setError] = useState<string | null>(null);
	const roomName = status.displayName || status.id;

	useEffect(() => {
		if (!visible) {
			setArmed(false);
			return;
		}
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
		setArmed(false);
		setCounts(null);
	}, [status.id]);

	async function submitPurge(): Promise<void> {
		if (!armed) {
			setArmed(true);
			setError(null);
			return;
		}
		setSubmitting("purge");
		setError(null);
		try {
			await onPurge(status.id, `DELETE ${status.id} FOREVER`);
		} catch (e) {
			setError((e as Error).message || "Failed to delete room.");
			setSubmitting(null);
			setArmed(false);
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
			<header className="rs-pane-head">
				<h3>Delete room</h3>
			</header>
			<p className="rs-pane-sub">
				{counts
					? `This room holds ${lifecycleCountsLine(counts)} on this machine.`
					: countsFailed
						? "The room's contents could not be counted right now. Deleting still removes everything on this machine."
						: "Checking what this room holds on this machine…"}
			</p>
			<div className="rs-row">
				<div className="rs-row-main">
					<span className="rs-row-label">Delete {roomName} permanently</span>
					<span className="rs-row-hint">Removes everything from this machine, including documents created in this room. This cannot be undone.</span>
					{armed && (
						<span className="rs-row-hint room-danger-armed" role="alert">
							Delete {roomName} forever?
							{counts ? ` Its ${plural(counts.files, "file")} include ${plural(counts.documents, "document")} the room created.` : ""}
							{" "}Everything is removed from this machine.
						</span>
					)}
				</div>
				<div className="rs-pane-actions">
					{armed && <button className="rs-quiet" type="button" disabled={submitting !== null} onClick={() => setArmed(false)}>Keep it</button>}
					<button className="rs-btn rs-btn-danger" disabled={submitting !== null} onClick={() => void submitPurge()}>
						{submitting === "purge" ? "Deleting…" : armed ? "Delete forever" : "Delete permanently"}
					</button>
				</div>
			</div>
			<div className="rs-row">
				<div className="rs-row-main">
					<span className="rs-row-label">Archive instead</span>
					<span className="rs-row-hint">The room leaves Home but everything stays on this machine. Restore it anytime from Archived rooms.</span>
				</div>
				<button className="rs-btn" disabled={submitting !== null} onClick={() => void submitArchive()}>
					{submitting === "archive" ? "Archiving…" : "Archive"}
				</button>
			</div>
			{error && <div className="workspaces-error">{error}</div>}
		</div>
	);
}
