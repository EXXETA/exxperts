import { useEffect, useState } from "react";
import type { PersistentAgentArchiveResponse, PersistentAgentId, PersistentAgentLifecycleCounts, PersistentAgentPurgeResponse, PersistentAgentStatus } from "../types";
import { fetchPersistentRoomLifecycleCounts } from "../persistent-room-management-api";
import { fetchPersistentRoomWorkspaceDefault } from "../persistent-room-workspace-api";
import { confirmDialog } from "./confirm-dialog";
import { PaneHeader } from "./pane-header";
import { shownRoomName } from "../../../web-server/src/room-name";
import { showsComputerOnlyControls, useRemoteClientContext } from "../remote-client-context";

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

/** "6 memories, 3 conversations, 2 scheduled tasks and 4 files": what the room holds, and what a delete takes. */
function lifecycleCountsList(counts: PersistentAgentLifecycleCounts): string {
	return `${plural(counts.memories, "memory", "memories")}, ${plural(counts.conversations, "conversation")}, ${plural(counts.scheduledTasks, "scheduled task")} and ${plural(counts.files, "file")}`;
}

// A delete never follows the room's folder policies into the folder the person
// linked, so a room with one says so. Said only once a read shows one: while it
// is read, or when it failed, the folder goes unnamed rather than misnamed.
// On a shared server the person has no folder or machine of their own to name.
const LINKED_FOLDER_STAYS = "The folder you linked is not touched.";
const NO_UNDO = "This cannot be undone.";

/** What Delete takes and what it leaves, said the same in the pane and in its question. */
function deleteSentence(counts: PersistentAgentLifecycleCounts | null, onThisComputer: boolean, folderLinked: boolean): string {
	const goes = counts ? `${lifecycleCountsList(counts)} are deleted.` : `Everything the room holds${onThisComputer ? " on this machine" : ""} is deleted.`;
	return folderLinked ? `${goes} ${LINKED_FOLDER_STAYS} ${NO_UNDO}` : `${goes} ${NO_UNDO}`;
}

// Deleting is the one action the room cannot come back from, so the pane
// states what is at stake in real numbers and the red button asks first, in
// the app's own dialog, with the counts spelled out. `visible` is the pane's
// own visibility (the modal keeps panes mounted): entering refetches the counts.
export function RoomDangerZone({ status, visible, onArchive, onPurge }: {
	status: PersistentAgentStatus;
	visible: boolean;
	onArchive: (agentId: PersistentAgentId, confirmation: string) => Promise<PersistentAgentArchiveResponse | null>;
	onPurge: (agentId: PersistentAgentId, confirmation: string) => Promise<PersistentAgentPurgeResponse | null>;
}) {
	const [counts, setCounts] = useState<PersistentAgentLifecycleCounts | null>(null);
	const [countsFailed, setCountsFailed] = useState(false);
	const [folderLinked, setFolderLinked] = useState(false);
	const [submitting, setSubmitting] = useState<"purge" | "archive" | null>(null);
	const [error, setError] = useState<string | null>(null);
	const roomName = shownRoomName(status.displayName) || status.id;
	const onThisComputer = showsComputerOnlyControls(useRemoteClientContext());
	const onThisMachine = onThisComputer ? " on this machine" : "";

	useEffect(() => {
		if (!visible) return;
		let cancelled = false;
		// Counts from an earlier visit may be stale (a task added since): until
		// fresh ones arrive, Delete says "everything" rather than an old number.
		setCounts(null);
		setCountsFailed(false);
		fetchPersistentRoomLifecycleCounts(status.id)
			.then((response) => {
				if (cancelled) return;
				// No counts: a part of the room could not be read, and Delete still removes it.
				if (response.counts) setCounts(response.counts);
				else setCountsFailed(true);
			})
			.catch(() => {
				// The pane keeps working without numbers — but says so, instead
				// of an eternal "checking…".
				if (!cancelled) setCountsFailed(true);
			});
		return () => { cancelled = true; };
	}, [visible, status.id]);

	// Read again on each visit: the Folder pane may have linked or cleared one since.
	useEffect(() => {
		if (!visible || !onThisComputer) return;
		let cancelled = false;
		setFolderLinked(false);
		fetchPersistentRoomWorkspaceDefault(status.id)
			// A linked folder is the policy's root, as the Folder pane shows it.
			.then((response) => { if (!cancelled) setFolderLinked((response.policy?.roots.length ?? 0) > 0); })
			.catch(() => {});
		return () => { cancelled = true; };
	}, [visible, status.id, onThisComputer]);

	async function submitPurge(): Promise<void> {
		setError(null);
		const ok = await confirmDialog({
			title: `Delete ${roomName}?`,
			body: deleteSentence(counts, onThisComputer, folderLinked),
			confirmLabel: "Delete room",
			cancelLabel: "Cancel",
			danger: true,
		});
		if (!ok) return;
		setSubmitting("purge");
		try {
			const response = await onPurge(status.id, `DELETE ${status.id} FOREVER`);
			if (!response) setSubmitting(null);
		} catch (e) {
			setError((e as Error).message || "Failed to delete room.");
			setSubmitting(null);
		}
	}

	async function submitArchive(): Promise<void> {
		setSubmitting("archive");
		setError(null);
		try {
			const response = await onArchive(status.id, `DELETE ${status.id}`);
			if (!response) setSubmitting(null);
		} catch (e) {
			setError((e as Error).message || "Failed to archive room.");
			setSubmitting(null);
		}
	}

	return (
		<div className="room-danger-zone">
			<PaneHeader
				title="Archive or delete"
				line={counts
					? `This room holds ${lifecycleCountsList(counts)}${onThisMachine}.`
					: countsFailed
						? "The room's contents could not be counted right now."
						: `Checking what this room holds${onThisMachine}…`}
			/>
			<div className="settings-rows">
				<div className="settings-row">
					<div className="settings-row-main">
						<span className="settings-row-label">Archive</span>
						<span className="settings-row-sub">Archive hides the room from Home and pauses its scheduled tasks. Everything stays; restore it from Archived rooms.</span>
					</div>
					<button className="rs-btn" disabled={submitting !== null} onClick={() => void submitArchive()}>
						{submitting === "archive" ? "Archiving…" : "Archive"}
					</button>
				</div>
				<div className="settings-row">
					<div className="settings-row-main">
						<span className="settings-row-label">Delete</span>
						<span className="settings-row-sub">{deleteSentence(counts, onThisComputer, folderLinked)}</span>
					</div>
					<button className="rs-btn rs-btn-danger" disabled={submitting !== null} onClick={() => void submitPurge()}>
						{submitting === "purge" ? "Deleting…" : "Delete room"}
					</button>
				</div>
			</div>
			{error && <div className="workspaces-error">{error}</div>}
		</div>
	);
}
