import { useCallback, useRef, useState } from "react";
import type { PersistentAgentArchiveResponse, PersistentAgentId, PersistentAgentRenameMemoryMention, PersistentAgentRenameResponse, PersistentAgentStatus } from "../types";
import { renamePersistentRoom } from "../persistent-room-management-api";
import { RoomSessionSection } from "./RoomSessionSection";
import { RoomWorkspaceSection } from "./RoomWorkspaceSection";
import { RoomMaintenanceSection } from "./RoomMaintenanceSection";
import { RoomSkillsSection } from "./RoomSkillsSection";
import { RoomScheduledTasksSection } from "./RoomScheduledTasksSection";
import { RoomDangerZone } from "./RoomDangerZone";
import { useEscapeKey } from "./use-escape-key";

function roomStatusLabel(status: PersistentAgentStatus["status"]): string {
	return status === "needs_absorb" ? "ready to learn" : status;
}

export function RoomSettingsModal({ status, onClose, onArchive, onRefresh }: { status: PersistentAgentStatus; onClose: () => void; onArchive: (agentId: PersistentAgentId, confirmation: string) => Promise<PersistentAgentArchiveResponse>; onRefresh: () => void }) {
	const workspaceDirtyRef = useRef(false);
	const handleWorkspaceDirtyChange = useCallback((dirty: boolean) => { workspaceDirtyRef.current = dirty; }, []);
	const currentName = status.displayName || status.id;
	const [editingName, setEditingName] = useState(false);
	const [nameDraft, setNameDraft] = useState("");
	const [renaming, setRenaming] = useState(false);
	const [renameError, setRenameError] = useState<string | null>(null);
	const [renameNotes, setRenameNotes] = useState<string[]>([]);
	const [renamePreview, setRenamePreview] = useState<{ name: string; mentions: PersistentAgentRenameMemoryMention[] } | null>(null);
	const trimmedDraft = nameDraft.replace(/\s+/g, " ").trim();
	const canSaveName = trimmedDraft !== "" && trimmedDraft !== currentName && !renaming;
	function startNameEdit(): void {
		setNameDraft(currentName);
		setRenameError(null);
		setRenameNotes([]);
		setRenamePreview(null);
		setEditingName(true);
	}
	function cancelNameEdit(): void {
		setEditingName(false);
		setRenamePreview(null);
		setRenameError(null);
	}
	function cancelRenamePreview(): void {
		setRenamePreview(null);
		setRenameError(null);
	}
	function finishRename(response: PersistentAgentRenameResponse): void {
		setEditingName(false);
		setRenamePreview(null);
		const notes: string[] = [];
		if (response.memoryMentions.count === 0) notes.push("Memory does not mention the old name.");
		if (!response.constitutionUpdated) notes.push("The room's constitution was customized, so its self-description keeps the old name until you update memory.");
		setRenameNotes(notes);
		onRefresh();
	}
	async function submitRename(): Promise<void> {
		if (!canSaveName) return;
		setRenaming(true);
		setRenameError(null);
		setRenameNotes([]);
		try {
			// Preview first: show exactly which memory lines would change before touching anything.
			const preview = await renamePersistentRoom(status.id, trimmedDraft, { dryRun: true });
			if (preview.memoryMentions.count === 0) {
				finishRename(await renamePersistentRoom(status.id, trimmedDraft));
			} else {
				setRenamePreview({ name: trimmedDraft, mentions: preview.memoryMentions.lines });
			}
		} catch (e) {
			setRenameError((e as Error).message || "Failed to rename room.");
		} finally {
			setRenaming(false);
		}
	}
	async function applyRename(): Promise<void> {
		if (!renamePreview || renaming) return;
		setRenaming(true);
		setRenameError(null);
		try {
			finishRename(await renamePersistentRoom(status.id, renamePreview.name));
		} catch (e) {
			setRenameError((e as Error).message || "Failed to rename room.");
		} finally {
			setRenaming(false);
		}
	}
	function requestClose(): void {
		if (editingName) {
			if (renamePreview) cancelRenamePreview();
			else cancelNameEdit();
			return;
		}
		if (workspaceDirtyRef.current && !window.confirm("The workspace section has unsaved changes. Close without saving them?")) return;
		onClose();
	}
	useEscapeKey(requestClose);
	async function archiveAndClose(agentId: PersistentAgentId, confirmation: string): Promise<PersistentAgentArchiveResponse> {
		const response = await onArchive(agentId, confirmation);
		onRefresh();
		onClose();
		return response;
	}
	return (
		<div className="room-settings-overlay" role="dialog" aria-modal="true" aria-labelledby="room-settings-title" onClick={requestClose}>
			<div className="room-settings-modal" onClick={(e) => e.stopPropagation()}>
				<div className="room-settings-head">
					<div className="room-settings-title-block">
						<div className="agent-details-kicker">Room settings</div>
						{editingName ? (
							<>
								<form className="room-settings-rename-form" onSubmit={(e) => { e.preventDefault(); void submitRename(); }}>
									<input
										className="launcher-path-input create-room-input room-settings-rename-input"
										type="text"
										value={nameDraft}
										autoFocus
										aria-label="Room name"
										disabled={renaming || renamePreview !== null}
										onChange={(e) => setNameDraft(e.target.value)}
									/>
									{renamePreview === null && (
										<>
											<button className="inline-action" type="submit" disabled={!canSaveName}>{renaming ? "Checking…" : "Save"}</button>
											<button className="inline-action" type="button" disabled={renaming} onClick={cancelNameEdit}>Cancel</button>
										</>
									)}
								</form>
								{renamePreview !== null && (
									<div className="room-settings-rename-preview">
										<p className="room-settings-rename-preview-lead">
											This also updates {renamePreview.mentions.length} {renamePreview.mentions.length === 1 ? "mention" : "mentions"} in the room's memory:
										</p>
										<ul className="room-settings-rename-preview-lines">
											{renamePreview.mentions.map((mention, index) => (
												<li key={`${mention.line}-${index}`}>{mention.text}</li>
											))}
										</ul>
										<div className="room-settings-rename-preview-actions">
											<button className="inline-action" type="button" disabled={renaming} onClick={() => void applyRename()}>{renaming ? "Applying…" : "Apply"}</button>
											<button className="inline-action" type="button" disabled={renaming} onClick={cancelRenamePreview}>Cancel</button>
										</div>
									</div>
								)}
							</>
						) : (
							<div className="room-settings-title-row">
								<h2 id="room-settings-title">{currentName}</h2>
								<button className="inline-action room-settings-rename-btn" type="button" aria-label="Rename room" title="Rename this room" onClick={startNameEdit}>Rename</button>
								{status.status !== "ready" && (
									<span className={`room-settings-status ${status.status}`}>{roomStatusLabel(status.status)}</span>
								)}
							</div>
						)}
						{renameError && <div className="workspaces-error room-settings-rename-message">{renameError}</div>}
						{renameNotes.map((note) => (
							<p key={note} className="room-settings-meta room-settings-rename-message">{note}</p>
						))}
					</div>
					<button className="icon-btn" onClick={requestClose} aria-label="Close">Close</button>
				</div>
				<div className="room-settings-body">
					<section className="room-settings-section">
						<h3>Workspace</h3>
						<RoomWorkspaceSection status={status} onDirtyChange={handleWorkspaceDirtyChange} />
					</section>
					<section className="room-settings-section">
						<h3>Memory maintenance</h3>
						<RoomMaintenanceSection status={status} />
					</section>
					<section className="room-settings-section">
						<h3>Skills</h3>
						<RoomSkillsSection status={status} />
					</section>
					<section className="room-settings-section">
						<h3>Scheduled tasks</h3>
						<RoomScheduledTasksSection status={status} />
					</section>
					<section className="room-settings-section">
						<h3>Session</h3>
						<RoomSessionSection status={status} onRefresh={onRefresh} />
					</section>
					<section className="room-settings-section room-settings-footer">
						<RoomDangerZone status={status} onArchive={archiveAndClose} />
					</section>
				</div>
			</div>
		</div>
	);
}
