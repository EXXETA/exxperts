import { type FormEvent, useEffect, useRef, useState } from "react";
import type { PersistentAgentStatus, PersistentRoomCapabilityPolicyView, PersistentRoomWorkspaceAccessMode } from "../types";
import { chooseSystemFolder, clearPersistentRoomWorkspaceDefault, fetchPersistentRoomWorkspaceDefault, savePersistentRoomWorkspaceDefault } from "../persistent-room-workspace-api";
import { useRemoteClientContext } from "../remote-client-context";
import { PaneHeader } from "./pane-header";
import { useRegisteredSave, type RegisterSave } from "./use-registered-save";

const BOUNDED_WORKSPACE_TOOL_OPTIONS = [
	{ name: "read", label: "Read" },
	{ name: "ls", label: "List" },
	{ name: "find", label: "Find" },
	{ name: "grep", label: "Search" },
	{ name: "write", label: "Write" },
	{ name: "edit", label: "Edit" },
] as const;

const LOCAL_FILES_TOOL_OPTIONS = [
	{ name: "read", label: "Read" },
	{ name: "ls", label: "List" },
	{ name: "find", label: "Find" },
	{ name: "grep", label: "Search" },
	{ name: "write", label: "Write" },
	{ name: "edit", label: "Edit" },
] as const;

const READ_TOOL_NAMES = new Set(["ls", "find", "grep", "read"]);

interface WorkspaceToolOption {
	name: string;
	label: string;
}

function workspaceToolGroupsForMode(mode: PersistentRoomWorkspaceAccessMode): { label: string; tools: WorkspaceToolOption[] }[] {
	const options: readonly WorkspaceToolOption[] = mode === "localFiles" ? LOCAL_FILES_TOOL_OPTIONS : BOUNDED_WORKSPACE_TOOL_OPTIONS;
	return [
		{ label: "Read & explore", tools: options.filter((tool) => READ_TOOL_NAMES.has(tool.name)) },
		{ label: "Write & edit", tools: options.filter((tool) => !READ_TOOL_NAMES.has(tool.name)) },
	].filter((group) => group.tools.length > 0);
}

const ALL_BOUNDED_WORKSPACE_TOOL_NAMES = BOUNDED_WORKSPACE_TOOL_OPTIONS.map((tool) => tool.name);
const ALL_LOCAL_FILES_TOOL_NAMES = LOCAL_FILES_TOOL_OPTIONS.map((tool) => tool.name);

function workspaceToolNamesForMode(mode: PersistentRoomWorkspaceAccessMode): string[] {
	return mode === "localFiles" ? [...ALL_LOCAL_FILES_TOOL_NAMES] : [...ALL_BOUNDED_WORKSPACE_TOOL_NAMES];
}

function draftToolNamesForPolicy(policy: PersistentRoomCapabilityPolicyView | null): string[] {
	if (!policy) return workspaceToolNamesForMode("localFiles");
	return [...policy.allowedToolNames];
}

function formatWorkspaceToolName(toolName: string): string {
	switch (toolName) {
		case "ls": return "List";
		case "find": return "Find";
		case "grep": return "Search";
		case "read": return "Read";
		case "write": return "Write";
		case "edit": return "Edit";
		default: return toolName;
	}
}

const WRITER_TOOL_NAMES = new Set(["write", "edit"]);

/** The honest capability sentence, derived from what is actually enabled:
 * no writer tools and no Bash means the room cannot change anything; no
 * writer tools with Bash on means Bash is the remaining way to modify files. */
function workspaceHonestyNote(input: { toolNames: readonly string[]; localFiles: boolean; bashEnabled: boolean }): string | null {
	if (input.toolNames.some((name) => WRITER_TOOL_NAMES.has(name))) return null;
	if (input.localFiles && input.bashEnabled) return "Write tools are off, but Bash can still modify files.";
	return "With this setup the room is read-only: it can see files here but cannot change anything.";
}

function accessModeLabel(mode: PersistentRoomWorkspaceAccessMode): string {
	return mode === "localFiles" ? "Full access" : "Bounded workspace";
}

function accessModeHint(mode: PersistentRoomWorkspaceAccessMode): string {
	return mode === "localFiles"
		? "The room works with files like you do, in this folder and beyond it, and can create, edit and overwrite. Bash is available in this mode."
		: "The room stays inside this folder. It can read everything here, and with write tools enabled it can create and edit files inside it.";
}

function WorkspaceDefaultPolicySummary({ policy, warnings, setupDisabled, onSetWorkspace }: { policy: PersistentRoomCapabilityPolicyView | null; warnings: string[]; setupDisabled: boolean; onSetWorkspace: () => void }) {
	const currentRoot = policy?.roots[0] ?? null;
	if (!policy || !currentRoot) {
		return (
			<div className="settings-rows">
				<div className="settings-row">
					<div className="settings-row-main">
						<span className="settings-row-label">No workspace yet</span>
						<span className="settings-row-sub">Without a folder, this room can't read or write files, export documents, or use Bash. Set a project folder to unlock file work.</span>
					</div>
					<button className="rs-btn" type="button" disabled={setupDisabled} onClick={onSetWorkspace}>Set workspace</button>
				</div>
			</div>
		);
	}
	const savedLabel = currentRoot.displayLabel || currentRoot.basename;
	const folderName = currentRoot.basename;
	const showFolderClue = Boolean(folderName && folderName !== savedLabel);
	const workspaceToolsEnabled = policy.allowedToolNames.length > 0;
	const isLocalFiles = policy.workspaceAccessMode === "localFiles";
	const toolNames = workspaceToolsEnabled ? policy.allowedToolNames.map(formatWorkspaceToolName).join(", ") : "None";
	const honestyNote = workspaceHonestyNote({ toolNames: policy.allowedToolNames, localFiles: isLocalFiles, bashEnabled: policy.bashEnabled === true });
	return (
		<div className="workspaces-policy-summary">
			<div className="settings-rows">
				<div className="settings-row">
					<div className="settings-row-main">
						<span className="settings-row-label">Folder</span>
						<span className="settings-row-sub">The full path stays on this machine and is not shown here.{showFolderClue ? ` Folder: ${folderName}.` : ""}</span>
					</div>
					<span className="settings-row-value">
						{savedLabel}
						<span className="settings-row-tag" title={accessModeHint(policy.workspaceAccessMode)}>{accessModeLabel(policy.workspaceAccessMode)}</span>
					</span>
				</div>
				<div className="settings-row">
					<span className="settings-row-label">Tools</span>
					<span className="settings-row-value">{toolNames}</span>
				</div>
				{isLocalFiles && (
					<div className="settings-row">
						<span className="settings-row-label">Bash</span>
						<span className="settings-row-value">{policy.bashEnabled ? "On" : "Off"}</span>
					</div>
				)}
			</div>
			{honestyNote && <p className="settings-help">{honestyNote}</p>}
			<p className="settings-help">Changes apply from your next message, also in a conversation that is already running.</p>
			{warnings.length > 0 && (
				<ul className="workspaces-warnings">
					{warnings.map((warning, index) => <li key={`${warning}-${index}`}>{warning}</li>)}
				</ul>
			)}
		</div>
	);
}

export function RoomWorkspaceSection({ status, onDirtyChange, registerSave }: { status: PersistentAgentStatus; onDirtyChange?: (dirty: boolean) => void; registerSave?: RegisterSave }) {
	const [policy, setPolicy] = useState<PersistentRoomCapabilityPolicyView | null>(null);
	const [warnings, setWarnings] = useState<string[]>([]);
	const [loading, setLoading] = useState(false);
	const [saving, setSaving] = useState(false);
	const [choosingFolder, setChoosingFolder] = useState(false);
	// The bash auto-approve preference saves the moment it is toggled, outside
	// the draft/save cycle above: it only changes whether the live session's
	// approval guard asks, which reads the stored value fresh on every call,
	// so no policy save or session rebind is involved.
	// The native folder chooser opens a dialog on the computer; from a remote
	// device that can only confuse (the server refuses it anyway), so the
	// button hides and the typed-path input stands alone.
	const remoteClient = useRemoteClientContext();
	const [editing, setEditing] = useState(false);
	const [draftRoot, setDraftRoot] = useState("");
	const [draftAccessMode, setDraftAccessMode] = useState<PersistentRoomWorkspaceAccessMode>("localFiles");
	const [draftToolNames, setDraftToolNames] = useState<string[]>([...ALL_LOCAL_FILES_TOOL_NAMES]);
	const [draftBashEnabled, setDraftBashEnabled] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [message, setMessage] = useState<string | null>(null);
	// The outcome line renders below the (tall) edit form inside a scrolling
	// pane: without this, a refusal can land off-screen and look like nothing
	// happened until the user scrolls.
	const outcomeRef = useRef<HTMLDivElement>(null);
	useEffect(() => {
		if (error || message) outcomeRef.current?.scrollIntoView({ block: "nearest" });
	}, [error, message]);
	const canManageWorkspace = status.exists && status.status !== "error";
	const trimmedDraftRoot = draftRoot.trim();
	const baselineAccessMode = policy?.workspaceAccessMode ?? "localFiles";
	const baselineToolNames = draftToolNamesForPolicy(policy);
	const baselineBashEnabled = policy?.workspaceAccessMode === "localFiles" && policy?.bashEnabled === true;
	const dirty = editing && (
		trimmedDraftRoot.length > 0 ||
		draftAccessMode !== baselineAccessMode ||
		draftBashEnabled !== baselineBashEnabled ||
		[...draftToolNames].sort().join(",") !== [...baselineToolNames].sort().join(",")
	);

	useEffect(() => {
		onDirtyChange?.(dirty);
	}, [dirty, onDirtyChange]);
	useEffect(() => () => onDirtyChange?.(false), [onDirtyChange]);

	useEffect(() => {
		let cancelled = false;
		setPolicy(null);
		setWarnings([]);
		setEditing(false);
		setDraftRoot("");
		setDraftAccessMode("localFiles");
		setDraftToolNames([...ALL_LOCAL_FILES_TOOL_NAMES]);
		setDraftBashEnabled(false);
		setMessage(null);
		if (!canManageWorkspace) {
			setLoading(false);
			setError(status.exists ? "This room needs attention before its workspace can be managed." : "Create this room before assigning a workspace.");
			return () => { cancelled = true; };
		}
		setLoading(true);
		setError(null);
		void fetchPersistentRoomWorkspaceDefault(status.id)
			.then((response) => {
				if (cancelled) return;
				setPolicy(response.policy);
				setWarnings(response.warnings ?? []);
			})
			.catch((e) => {
				if (!cancelled) setError((e as Error).message || "Failed to load workspace default.");
			})
			.finally(() => {
				if (!cancelled) setLoading(false);
			});
		return () => { cancelled = true; };
	}, [canManageWorkspace, status.exists, status.id]);

	// Save and close in the unsaved question: the editor's own save.
	useRegisteredSave(registerSave, saveWorkspaceDefault);

	async function submitWorkspaceDefault(event: FormEvent<HTMLFormElement>): Promise<void> {
		event.preventDefault();
		await saveWorkspaceDefault();
	}

	async function saveWorkspaceDefault(): Promise<boolean> {
		if (saving) return false;
		const root = draftRoot.trim();
		if (!root && !policy) {
			setError("Choose a folder for this room workspace.");
			return false;
		}
		const activeToolNames = workspaceToolNamesForMode(draftAccessMode);
		const selectedToolNames = activeToolNames.filter((toolName) => draftToolNames.includes(toolName));
		const allToolsSelected = activeToolNames.every((toolName) => selectedToolNames.includes(toolName));
		const toolSelection = allToolsSelected && selectedToolNames.length === activeToolNames.length
			? { kind: "standard" as const, allowedToolNames: [...activeToolNames] }
			: { kind: "custom" as const, allowedToolNames: selectedToolNames };
		setSaving(true);
		setError(null);
		setMessage(null);
		try {
			const response = await savePersistentRoomWorkspaceDefault(status.id, {
				root: root || undefined,
				workspaceAccessMode: draftAccessMode,
				toolSelection,
				bashEnabled: draftAccessMode === "localFiles" && draftBashEnabled,
			});
			setPolicy(response.policy);
			setWarnings(response.warnings ?? []);
			setDraftRoot("");
			setDraftAccessMode(response.policy?.workspaceAccessMode ?? "localFiles");
			setDraftToolNames(draftToolNamesForPolicy(response.policy));
			setDraftBashEnabled(response.policy?.workspaceAccessMode === "localFiles" && response.policy?.bashEnabled === true);
			setEditing(false);
			setMessage("Saved. Applies from your next message.");
			return true;
		} catch (e) {
			setError((e as Error).message || "Failed to save workspace default.");
			return false;
		} finally {
			setSaving(false);
		}
	}

	function toggleTool(toolName: string): void {
		const activeToolNames = workspaceToolNamesForMode(draftAccessMode);
		setDraftToolNames((current) => current.includes(toolName)
			? current.filter((name) => name !== toolName)
			: activeToolNames.filter((name) => name === toolName || current.includes(name)));
		setError(null);
		setMessage(null);
	}

	function changeAccessMode(mode: PersistentRoomWorkspaceAccessMode): void {
		setDraftAccessMode(mode);
		setDraftToolNames(workspaceToolNamesForMode(mode));
		if (mode === "bounded") setDraftBashEnabled(false);
		setError(null);
		setMessage(null);
	}

	function startOrCancelEditing(): void {
		if (editing) {
			setEditing(false);
			setDraftRoot("");
			setDraftAccessMode(policy?.workspaceAccessMode ?? "localFiles");
			setDraftToolNames(draftToolNamesForPolicy(policy));
			setDraftBashEnabled(policy?.workspaceAccessMode === "localFiles" && policy?.bashEnabled === true);
			setError(null);
			setMessage(null);
			return;
		}
		setDraftRoot("");
		setDraftAccessMode(policy?.workspaceAccessMode ?? "localFiles");
		setDraftToolNames(draftToolNamesForPolicy(policy));
		setDraftBashEnabled(policy?.workspaceAccessMode === "localFiles" && policy?.bashEnabled === true);
		setEditing(true);
		setError(null);
		setMessage(null);
	}

	async function clearWorkspaceDefault(): Promise<void> {
		setSaving(true);
		setError(null);
		setMessage(null);
		try {
			const response = await clearPersistentRoomWorkspaceDefault(status.id);
			setPolicy(null);
			setWarnings(response.warnings ?? []);
			setDraftRoot("");
			setDraftAccessMode("localFiles");
			setDraftToolNames([...ALL_LOCAL_FILES_TOOL_NAMES]);
			setDraftBashEnabled(false);
			setEditing(false);
			setMessage(response.deleted ? "Workspace default cleared." : "No default workspace was saved.");
		} catch (e) {
			setError((e as Error).message || "Failed to clear workspace default.");
		} finally {
			setSaving(false);
		}
	}

	async function chooseWorkspaceRootFolder(): Promise<void> {
		setChoosingFolder(true);
		setError(null);
		setMessage(null);
		try {
			const response = await chooseSystemFolder();
			if (response.cancelled) return;
			setDraftRoot(response.path);
		} catch (e) {
			setError((e as Error).message || "Folder chooser failed. Try again.");
		} finally {
			setChoosingFolder(false);
		}
	}

	const activeToolGroups = workspaceToolGroupsForMode(draftAccessMode);
	const draftHonestyNote = workspaceHonestyNote({ toolNames: draftToolNames, localFiles: draftAccessMode === "localFiles", bashEnabled: draftAccessMode === "localFiles" && draftBashEnabled });
	const savedRoot = policy?.roots[0] ?? null;
	const savedFolderLabel = savedRoot ? (savedRoot.displayLabel || savedRoot.basename) : null;

	return (
		<div className="room-workspace-section">
			<PaneHeader
				title="Workspace"
				line="The folder this room works in, and what it may do there."
				actions={editing ? (
					<>
						{dirty && <span className="workspace-unsaved-hint">Unsaved changes</span>}
						<button className="rs-btn" type="button" disabled={saving} onClick={startOrCancelEditing}>Cancel</button>
						<button className="rs-btn rs-btn-primary" type="submit" form="workspace-editor-form" disabled={saving}>{saving ? "Saving…" : policy ? "Save changes" : "Save workspace"}</button>
					</>
				) : policy && (
					<>
						<button className="rs-btn" disabled={!canManageWorkspace || loading || saving} title="Remove the saved workspace folder" onClick={() => void clearWorkspaceDefault()}>{saving ? "Updating…" : "Clear"}</button>
						<button className="rs-btn" disabled={!canManageWorkspace || loading || saving} onClick={startOrCancelEditing}>Edit workspace</button>
					</>
				)}
			/>
			<div className="workspaces-room-body">
				{loading ? <p className="settings-empty">Loading workspace default…</p> : !editing && <WorkspaceDefaultPolicySummary policy={policy} warnings={warnings} setupDisabled={!canManageWorkspace || saving} onSetWorkspace={startOrCancelEditing} />}
				{editing && (
					<form id="workspace-editor-form" className="workspaces-default-form" onSubmit={(event) => void submitWorkspaceDefault(event)}>
						<div className="settings-rows">
							<div className="settings-row">
								<div className="settings-row-main">
									<span className="settings-row-label">Folder</span>
									<span className="settings-row-sub">{savedFolderLabel ? `${savedFolderLabel}, saved. Pick another to change it.` : "Pick the folder this room works in."}</span>
								</div>
								<div className="settings-row-value workspace-folder-controls">
									<input
										className="launcher-path-input workspace-folder-path-input"
										type="text"
										value={draftRoot}
										placeholder={savedFolderLabel ? "Or type a path" : "Type a folder path"}
										aria-label="Workspace folder path"
										disabled={saving || choosingFolder}
										onChange={(event) => { setDraftRoot(event.target.value); setError(null); setMessage(null); }}
									/>
									{trimmedDraftRoot.length > 0 && policy && (
										<button className="rs-btn" type="button" disabled={saving} onClick={() => { setDraftRoot(""); setError(null); setMessage(null); }}>Keep saved folder</button>
									)}
									{!remoteClient.remote && (
										<button className="rs-btn" type="button" disabled={saving || choosingFolder} onClick={() => void chooseWorkspaceRootFolder()}>
											{choosingFolder ? "Choosing…" : "Choose folder…"}
										</button>
									)}
								</div>
							</div>
							<div className="settings-row">
								<div className="settings-row-main">
									<span className="settings-row-label">Access</span>
									<span className="settings-row-sub">{accessModeHint(draftAccessMode)}</span>
								</div>
								<div className="settings-segments" role="radiogroup" aria-label="Workspace access mode">
									<button type="button" role="radio" aria-checked={draftAccessMode === "localFiles"} className={`settings-segment${draftAccessMode === "localFiles" ? " active" : ""}`} disabled={saving} title={accessModeHint("localFiles")} onClick={() => changeAccessMode("localFiles")}>Full access</button>
									<button type="button" role="radio" aria-checked={draftAccessMode === "bounded"} className={`settings-segment${draftAccessMode === "bounded" ? " active" : ""}`} disabled={saving} title={accessModeHint("bounded")} onClick={() => changeAccessMode("bounded")}>Bounded</button>
								</div>
							</div>
						</div>
						<div className="settings-group">
							<p className="settings-group-kicker">Tools</p>
							{/* Reading tools in one column, writing ones in the other; Bash is
							    one more row of the second, in Full access only. */}
							<div className="workspace-tool-columns">
								{activeToolGroups.map((group, index) => (
									<div className="settings-rows" key={group.label} aria-label={group.label}>
										{group.tools.map((tool) => (
											<label className="settings-row" key={tool.name}>
												<span className="settings-row-label">{tool.label}</span>
												<input className="workspaces-tool-switch" type="checkbox" checked={draftToolNames.includes(tool.name)} disabled={saving} onChange={() => toggleTool(tool.name)} aria-label={`${tool.label} workspace tool`} />
											</label>
										))}
										{index === activeToolGroups.length - 1 && draftAccessMode === "localFiles" && (
											<label className="settings-row">
												<span className="settings-row-main">
													<span className="settings-row-label">Bash</span>
													<span className="settings-row-sub">Shell commands, off by default. Whether they ask first is set in the chat header.</span>
												</span>
												<input className="workspaces-tool-switch" type="checkbox" checked={draftBashEnabled} disabled={saving} onChange={() => { setDraftBashEnabled((current) => !current); setError(null); setMessage(null); }} aria-label="Bash shell access" />
											</label>
										)}
									</div>
								))}
							</div>
							{draftHonestyNote && <p className="settings-help">{draftHonestyNote}</p>}
							{draftAccessMode === "bounded" && <p className="settings-help">Bash is available in Full access mode.</p>}
						</div>
					</form>
				)}
				<div ref={outcomeRef}>
					{message && <div className="workspaces-success">{message}</div>}
					{error && <div className="workspaces-error">{error}</div>}
				</div>
			</div>
		</div>
	);
}
