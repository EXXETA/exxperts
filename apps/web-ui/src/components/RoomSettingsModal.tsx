import { type ReactNode, useCallback, useRef, useState } from "react";
import type { PersistentAgentArchiveResponse, PersistentAgentId, PersistentAgentPurgeResponse, PersistentAgentRenameMemoryMention, PersistentAgentRenameResponse, PersistentAgentStatus, RoomModelLockView } from "../types";
import { renamePersistentRoom } from "../persistent-room-management-api";
import { RoomSessionSection } from "./RoomSessionSection";
import { RoomWorkspaceSection } from "./RoomWorkspaceSection";
import { RoomMaintenanceSection } from "./RoomMaintenanceSection";
import { RoomModelSection } from "./RoomModelSection";
import type { ConversationSwitchNotice } from "../room-models-api";
import { RoomInstructionsSection } from "./RoomInstructionsSection";
import { RoomSkillsSection } from "./RoomSkillsSection";
import { RoomConnectorsSection } from "./RoomConnectorsSection";
import { RoomScheduledTasksSection } from "./RoomScheduledTasksSection";
import { RoomDangerZone } from "./RoomDangerZone";
import { confirmChoice } from "./confirm-dialog";
import { SettingsDialog } from "./settings-dialog";

function roomStatusLabel(status: PersistentAgentStatus["status"]): string {
	return status === "needs_absorb" ? "ready to memorize" : status;
}

export type SettingsPane = "workspace" | "model" | "memory" | "instructions" | "skills" | "connectors" | "schedules" | "session" | "danger";

const PANES: { id: SettingsPane; label: string }[] = [
	{ id: "workspace", label: "Workspace" },
	{ id: "model", label: "Model" },
	{ id: "memory", label: "Memory" },
	{ id: "instructions", label: "Instructions" },
	{ id: "skills", label: "Skills" },
	{ id: "connectors", label: "Connectors" },
	{ id: "schedules", label: "Scheduled tasks" },
	{ id: "session", label: "Conversation" },
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

export function RoomSettingsModal({ status, onClose, onArchive, onPurge, onRefresh, onMementoApplied, onMementoForget, onBeforeMemento, onOpenSkillsLibrary, onOpenConnectors, onConversationSwitched, initialPane }: { status: PersistentAgentStatus; onClose: () => void; onArchive: (agentId: PersistentAgentId, confirmation: string) => Promise<PersistentAgentArchiveResponse | null>; onPurge: (agentId: PersistentAgentId, confirmation: string) => Promise<PersistentAgentPurgeResponse | null>; onRefresh: () => void; onMementoApplied?: () => void; onMementoForget?: () => void; onBeforeMemento?: (continueAction: () => void) => boolean; onOpenSkillsLibrary?: () => void; onOpenConnectors?: () => void; onConversationSwitched?: (conversationId: string, model: RoomModelLockView, notice: ConversationSwitchNotice) => void; initialPane?: SettingsPane }) {
	const workspaceDirtyRef = useRef(false);
	const handleWorkspaceDirtyChange = useCallback((dirty: boolean) => { workspaceDirtyRef.current = dirty; }, []);
	const workspaceSaveRef = useRef<(() => Promise<boolean>) | null>(null);
	const registerWorkspaceSave = useCallback((save: () => Promise<boolean>) => { workspaceSaveRef.current = save; }, []);
	const instructionsDirtyRef = useRef(false);
	const handleInstructionsDirtyChange = useCallback((dirty: boolean) => { instructionsDirtyRef.current = dirty; }, []);
	const instructionsSaveRef = useRef<(() => Promise<boolean>) | null>(null);
	const registerInstructionsSave = useCallback((save: () => Promise<boolean>) => { instructionsSaveRef.current = save; }, []);
	// The one question before closing over an unsaved draft, naming the pane
	// that holds it; each pane reports its own flag and its save, this reads
	// them all. Save and close runs every draft's save in turn; the first that
	// fails keeps the dialog open on its pane, which shows the pane's error.
	async function confirmLeavingUnsaved(): Promise<boolean> {
		const drafts = [
			workspaceDirtyRef.current ? { label: "The workspace section", pane: "workspace" as const, save: workspaceSaveRef } : null,
			instructionsDirtyRef.current ? { label: "The instructions", pane: "instructions" as const, save: instructionsSaveRef } : null,
		].filter((draft) => draft !== null);
		if (drafts.length === 0) return true;
		const subject = drafts.length === 1 ? drafts[0].label : `${drafts[0].label} and ${drafts[1].label.toLowerCase()}`;
		const choice = await confirmChoice({
			title: "Unsaved changes",
			body: `${subject} ${drafts.length === 1 && drafts[0].pane === "workspace" ? "has" : "have"} unsaved changes.`,
			confirmLabel: "Save and close",
			alternateLabel: "Close without saving",
			cancelLabel: "Keep editing",
		});
		if (choice === "cancel") return false;
		if (choice === "alternate") return true;
		for (const draft of drafts) {
			if (!(await draft.save.current?.())) {
				setPane(draft.pane);
				return false;
			}
		}
		return true;
	}
	// Callers that open the modal at a particular pane (the Memory tab's link
	// into this room's memory) say so once; the nav owns it from then on.
	const [pane, setPane] = useState<SettingsPane>(initialPane ?? "workspace");
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
		void confirmLeavingUnsaved().then((ok) => { if (ok) onClose(); });
	}
	// The jumps to the skills library and to the connectors page close this
	// modal too, so they pass the same unsaved-workspace gate as any other
	// close: the modal owns the closing, the parent callback only navigates
	// afterwards.
	function closeThen(navigate: (() => void) | undefined): void {
		void confirmLeavingUnsaved().then((ok) => {
			if (!ok) return;
			onClose();
			navigate?.();
		});
	}
	async function archiveAndClose(agentId: PersistentAgentId, confirmation: string): Promise<PersistentAgentArchiveResponse | null> {
		const response = await onArchive(agentId, confirmation);
		if (!response) return null;
		onRefresh();
		onClose();
		return response;
	}
	async function purgeAndClose(agentId: PersistentAgentId, confirmation: string): Promise<PersistentAgentPurgeResponse | null> {
		const response = await onPurge(agentId, confirmation);
		if (!response) return null;
		onRefresh();
		onClose();
		return response;
	}
	// What the rename has to say (the preview, an error, the notes after it)
	// floats under the title, so the header keeps its height and nothing
	// below it moves.
	const renameMessages = (renamePreview !== null || renameError || renameNotes.length > 0) && (
		<div className="settings-dialog-head-note" role="status">
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
						<button className="rs-btn" type="button" disabled={renaming} onClick={cancelRenamePreview}>Cancel</button>
					</div>
				</div>
			)}
			{renameError && <div className="workspaces-error room-settings-rename-message">{renameError}</div>}
			{renameNotes.map((note) => (
				<p key={note} className="room-settings-meta room-settings-rename-message">{note}</p>
			))}
			{renameNotes.length > 0 && !editingName && <button className="rs-btn" type="button" onClick={() => setRenameNotes([])}>OK</button>}
		</div>
	);
	const title = editingName ? (
		<form className="room-settings-rename-form" onSubmit={(e) => { e.preventDefault(); void submitRename(); }}>
			<input
				className="room-settings-rename-input"
				type="text"
				value={nameDraft}
				autoFocus
				aria-label="Room name"
				disabled={renaming || renamePreview !== null}
				onChange={(e) => setNameDraft(e.target.value)}
			/>
			{renamePreview === null && (
				<>
					<button className="rs-btn rs-btn-primary" type="submit" disabled={!canSaveName}>{renaming ? "Checking…" : "Save"}</button>
					<button className="rs-btn" type="button" disabled={renaming} onClick={cancelNameEdit}>Cancel</button>
				</>
			)}
		</form>
	) : (
		<div className="settings-dialog-title-row">
			<h2 id="room-settings-title" className="settings-dialog-title">{currentName}</h2>
			<button className="settings-dialog-title-action" type="button" aria-label="Rename room" title="Rename this room" onClick={startNameEdit}>Rename</button>
			{status.status !== "ready" && (
				<span className={`room-settings-status ${status.status}`}>{roomStatusLabel(status.status)}</span>
			)}
		</div>
	);
	return (
		<SettingsDialog
			className="rs-shell"
			labelledBy={editingName ? undefined : "room-settings-title"}
			label={editingName ? "Room settings" : undefined}
			kicker="Room settings"
			title={title}
			headNote={renameMessages}
			navLabel="Room settings sections"
			nav={[...PANES, { id: "danger" as const, label: "Delete room", danger: true }]}
			active={pane}
			onSelect={setPane}
			onClose={requestClose}
			initialShowList={!initialPane}
		>
			{/* Panes stay mounted so each section fetches once and keeps its edit state across switches. */}
			<section className="room-settings-section" hidden={pane !== "workspace"}>
				<RoomWorkspaceSection status={status} onDirtyChange={handleWorkspaceDirtyChange} registerSave={registerWorkspaceSave} />
			</section>
			<section className="room-settings-section" hidden={pane !== "model"}>
				<RoomModelSection status={status} onRefresh={onRefresh} onSwitched={(conversationId, model, notice) => { requestClose(); onConversationSwitched?.(conversationId, model, notice); }} />
			</section>
			<section className="room-settings-section" hidden={pane !== "memory"}>
				<RoomMaintenanceSection status={status} />
			</section>
			<section className="room-settings-section" hidden={pane !== "instructions"}>
				<RoomInstructionsSection status={status} onDirtyChange={handleInstructionsDirtyChange} registerSave={registerInstructionsSave} />
			</section>
			<section className="room-settings-section" hidden={pane !== "skills"}>
				<RoomSkillsSection status={status} onOpenSkillsLibrary={onOpenSkillsLibrary ? () => closeThen(onOpenSkillsLibrary) : undefined} />
			</section>
			<section className="room-settings-section" hidden={pane !== "connectors"}>
				<RoomConnectorsSection status={status} onOpenConnectors={onOpenConnectors ? () => closeThen(onOpenConnectors) : undefined} />
			</section>
			<section className="room-settings-section" hidden={pane !== "schedules"}>
				<RoomScheduledTasksSection status={status} />
			</section>
			<section className="room-settings-section" hidden={pane !== "session"}>
				<RoomSessionSection status={status} onRefresh={onRefresh} onMementoApplied={onMementoApplied} onMementoForget={onMementoForget} onBeforeMemento={onBeforeMemento} />
			</section>
			<section className="room-settings-section" hidden={pane !== "danger"}>
				<RoomDangerZone status={status} visible={pane === "danger"} onArchive={archiveAndClose} onPurge={purgeAndClose} />
			</section>
		</SettingsDialog>
	);
}
