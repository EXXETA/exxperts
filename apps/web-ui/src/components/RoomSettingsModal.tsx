import { type ReactNode, useCallback, useRef, useState } from "react";
import type { PersistentAgentArchiveResponse, PersistentAgentId, PersistentAgentPurgeResponse, PersistentAgentRenameMemoryMention, PersistentAgentRenameResponse, PersistentAgentStatus } from "../types";
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

type SettingsPane = "workspace" | "memory" | "skills" | "schedules" | "session" | "danger";

const PANES: { id: SettingsPane; label: string }[] = [
	{ id: "workspace", label: "Workspace" },
	{ id: "memory", label: "Memory" },
	{ id: "skills", label: "Skills" },
	{ id: "schedules", label: "Scheduled tasks" },
	{ id: "session", label: "Session" },
];

// Bold the occurrences the rename will actually replace: the server matches the
// old name case-sensitively at word boundaries, so the preview must do the same.
function isNameMentionBoundary(char: string | undefined): boolean {
	if (char === undefined) return true;
	return !/[\p{L}\p{N}]/u.test(char);
}

function highlightMention(text: string, name: string): ReactNode {
	if (!name) return text;
	const parts: ReactNode[] = [];
	let from = 0;
	for (let hit = text.indexOf(name, from); hit !== -1; hit = text.indexOf(name, from)) {
		const isMention = isNameMentionBoundary(text[hit - 1]) && isNameMentionBoundary(text[hit + name.length]);
		if (isMention) {
			if (hit > from) parts.push(text.slice(from, hit));
			parts.push(<b key={parts.length}>{text.slice(hit, hit + name.length)}</b>);
			from = hit + name.length;
		} else {
			// Not a whole-name mention: leave this occurrence unhighlighted.
			parts.push(text.slice(from, hit + name.length));
			from = hit + name.length;
		}
	}
	if (from < text.length) parts.push(text.slice(from));
	return parts.length > 0 ? parts : text;
}

export function RoomSettingsModal({ status, onClose, onArchive, onPurge, onRefresh, onMementoApplied, onMementoForget }: { status: PersistentAgentStatus; onClose: () => void; onArchive: (agentId: PersistentAgentId, confirmation: string) => Promise<PersistentAgentArchiveResponse>; onPurge: (agentId: PersistentAgentId, confirmation: string) => Promise<PersistentAgentPurgeResponse>; onRefresh: () => void; onMementoApplied?: () => void; onMementoForget?: () => void }) {
	const workspaceDirtyRef = useRef(false);
	const handleWorkspaceDirtyChange = useCallback((dirty: boolean) => { workspaceDirtyRef.current = dirty; }, []);
	const [pane, setPane] = useState<SettingsPane>("workspace");
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
	async function purgeAndClose(agentId: PersistentAgentId, confirmation: string): Promise<PersistentAgentPurgeResponse> {
		const response = await onPurge(agentId, confirmation);
		onRefresh();
		onClose();
		return response;
	}
	return (
		<div className="room-settings-overlay" role="dialog" aria-modal="true" aria-labelledby="room-settings-title" onClick={requestClose}>
			<div className="room-settings-modal rs-shell" onClick={(e) => e.stopPropagation()}>
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
											<button className="rs-btn" type="submit" disabled={!canSaveName}>{renaming ? "Checking…" : "Save"}</button>
											<button className="rs-quiet" type="button" disabled={renaming} onClick={cancelNameEdit}>Cancel</button>
										</>
									)}
								</form>
								{renamePreview !== null && (
									<div className="room-settings-rename-preview">
										<p className="room-settings-rename-preview-lead">
											Rename <b>{currentName}</b> to <b>{renamePreview.name}</b>. This also updates {renamePreview.mentions.length} {renamePreview.mentions.length === 1 ? "mention" : "mentions"} in the room's memory:
										</p>
										<ul className="room-settings-rename-preview-lines">
											{renamePreview.mentions.map((mention, index) => (
												<li key={`${mention.line}-${index}`}>{highlightMention(mention.text, currentName)}</li>
											))}
										</ul>
										<div className="room-settings-rename-preview-actions">
											<button className="rs-btn" type="button" disabled={renaming} onClick={() => void applyRename()}>{renaming ? "Applying…" : "Apply"}</button>
											<button className="rs-quiet" type="button" disabled={renaming} onClick={cancelRenamePreview}>Cancel</button>
										</div>
									</div>
								)}
							</>
						) : (
							<div className="room-settings-title-row">
								<h2 id="room-settings-title">{currentName}</h2>
								<button className="rs-quiet room-settings-rename-btn" type="button" aria-label="Rename room" title="Rename this room" onClick={startNameEdit}>Rename</button>
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
				<div className="room-settings-layout">
					<nav className="room-settings-nav" aria-label="Room settings sections">
						{PANES.map((entry) => (
							<button key={entry.id} type="button" className={pane === entry.id ? "rs-nav-item active" : "rs-nav-item"} aria-current={pane === entry.id} onClick={() => setPane(entry.id)}>{entry.label}</button>
						))}
						<div className="rs-nav-spacer" />
						<button type="button" className={pane === "danger" ? "rs-nav-item rs-nav-danger active" : "rs-nav-item rs-nav-danger"} aria-current={pane === "danger"} onClick={() => setPane("danger")}>Delete room</button>
					</nav>
					{/* Panes stay mounted so each section fetches once and keeps its edit state across switches. */}
					<div className="room-settings-body">
						<section className="room-settings-section" hidden={pane !== "workspace"}>
							<RoomWorkspaceSection status={status} onDirtyChange={handleWorkspaceDirtyChange} />
						</section>
						<section className="room-settings-section" hidden={pane !== "memory"}>
							<RoomMaintenanceSection status={status} />
						</section>
						<section className="room-settings-section" hidden={pane !== "skills"}>
							<RoomSkillsSection status={status} />
						</section>
						<section className="room-settings-section" hidden={pane !== "schedules"}>
							<RoomScheduledTasksSection status={status} />
						</section>
						<section className="room-settings-section" hidden={pane !== "session"}>
							<RoomSessionSection status={status} onRefresh={onRefresh} onMementoApplied={onMementoApplied} onMementoForget={onMementoForget} />
						</section>
						<section className="room-settings-section" hidden={pane !== "danger"}>
							<RoomDangerZone status={status} visible={pane === "danger"} onArchive={archiveAndClose} onPurge={purgeAndClose} />
						</section>
					</div>
				</div>
			</div>
		</div>
	);
}
