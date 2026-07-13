import { type FormEvent, useEffect, useState } from "react";
import type { PersistentAgentStatus, PersistentRoomCapabilityPolicyView, PersistentRoomWorkspaceAccessMode } from "../types";
import { chooseSystemFolder, clearPersistentRoomWorkspaceDefault, fetchPersistentRoomWorkspaceDefault, savePersistentRoomWorkspaceDefault } from "../persistent-room-workspace-api";

const BOUNDED_WORKSPACE_TOOL_OPTIONS = [
	{ name: "ls", label: "List" },
	{ name: "find", label: "Find" },
	{ name: "read", label: "Read" },
	{ name: "read_spreadsheet", label: "Spreadsheet read" },
	{ name: "write_markdown_file", label: "Markdown write" },
] as const;

const LOCAL_FILES_TOOL_OPTIONS = [
	{ name: "read", label: "Read" },
	{ name: "ls", label: "List" },
	{ name: "find", label: "Find" },
	{ name: "grep", label: "Search" },
	{ name: "write", label: "Write" },
	{ name: "edit", label: "Edit" },
	{ name: "read_spreadsheet", label: "Spreadsheet read" },
] as const;

const READ_TOOL_NAMES = new Set(["read", "ls", "find", "grep", "read_spreadsheet"]);

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
		case "read_spreadsheet": return "Spreadsheet read";
		case "write_markdown_file": return "Markdown write";
		default: return toolName;
	}
}

function accessModeLabel(mode: PersistentRoomWorkspaceAccessMode): string {
	return mode === "localFiles" ? "Full access" : "Bounded workspace";
}

function accessModeHint(mode: PersistentRoomWorkspaceAccessMode): string {
	return mode === "localFiles"
		? "The room works directly in the chosen folder."
		: "The room works in a managed copy inside the folder, so the originals stay untouched.";
}

function WorkspaceDefaultPolicySummary({ policy, warnings }: { policy: PersistentRoomCapabilityPolicyView | null; warnings: string[] }) {
	const currentRoot = policy?.roots[0] ?? null;
	if (!policy || !currentRoot) {
		return <p className="workspaces-empty-state">No workspace saved yet. Set a project folder for this room.</p>;
	}
	const savedLabel = currentRoot.displayLabel || currentRoot.basename;
	const folderName = currentRoot.basename;
	const showFolderClue = Boolean(folderName && folderName !== savedLabel);
	const workspaceToolsEnabled = policy.allowedToolNames.length > 0;
	const isLocalFiles = policy.workspaceAccessMode === "localFiles";
	const toolNames = workspaceToolsEnabled ? policy.allowedToolNames.map(formatWorkspaceToolName).join(", ") : "None";
	return (
		<div className="workspaces-policy-summary">
			<div className="workspace-summary-card">
				<div className="workspace-summary-folder">
					<svg className="workspace-folder-icon" viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M1.5 2.5A1.5 1.5 0 0 1 3 1h3.2c.4 0 .78.16 1.06.44L8.6 2.78c.1.1.22.15.35.15H13a1.5 1.5 0 0 1 1.5 1.5v8.07A1.5 1.5 0 0 1 13 14H3a1.5 1.5 0 0 1-1.5-1.5v-10Z" /></svg>
					<strong>{savedLabel}</strong>
					<span className="workspace-summary-mode">{accessModeLabel(policy.workspaceAccessMode)}</span>
				</div>
				<dl className="workspace-summary-facts">
					<div>
						<dt>Tools</dt>
						<dd>{toolNames}</dd>
					</div>
					{isLocalFiles && (
						<div>
							<dt>Bash</dt>
							<dd>{policy.bashEnabled ? "On" : "Off"}</dd>
						</div>
					)}
				</dl>
				<p className="workspace-summary-note">
					The full local path is stored on this machine and not shown here.{showFolderClue ? ` Folder: ${folderName}.` : ""} Existing thread workspaces remain unchanged.
				</p>
			</div>
			{warnings.length > 0 && (
				<ul className="workspaces-warnings">
					{warnings.map((warning, index) => <li key={`${warning}-${index}`}>{warning}</li>)}
				</ul>
			)}
		</div>
	);
}

export function RoomWorkspaceSection({ status, onDirtyChange }: { status: PersistentAgentStatus; onDirtyChange?: (dirty: boolean) => void }) {
	const [policy, setPolicy] = useState<PersistentRoomCapabilityPolicyView | null>(null);
	const [warnings, setWarnings] = useState<string[]>([]);
	const [loading, setLoading] = useState(false);
	const [saving, setSaving] = useState(false);
	const [choosingFolder, setChoosingFolder] = useState(false);
	const [editing, setEditing] = useState(false);
	const [draftRoot, setDraftRoot] = useState("");
	const [draftAccessMode, setDraftAccessMode] = useState<PersistentRoomWorkspaceAccessMode>("localFiles");
	const [draftToolNames, setDraftToolNames] = useState<string[]>([...ALL_LOCAL_FILES_TOOL_NAMES]);
	const [draftBashEnabled, setDraftBashEnabled] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [message, setMessage] = useState<string | null>(null);
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

	async function submitWorkspaceDefault(event: FormEvent<HTMLFormElement>): Promise<void> {
		event.preventDefault();
		const root = draftRoot.trim();
		if (!root && !policy) {
			setError("Choose a folder for this room workspace.");
			return;
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
				mode: "read",
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
			setMessage("Workspace default saved.");
		} catch (e) {
			setError((e as Error).message || "Failed to save workspace default.");
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
	const savedRoot = policy?.roots[0] ?? null;
	const savedFolderLabel = savedRoot ? (savedRoot.displayLabel || savedRoot.basename) : null;

	return (
		<div className="room-workspace-section">
			{!editing && (
				<div className="workspaces-row-actions">
					<button className="inline-action" disabled={!canManageWorkspace || loading || saving} onClick={startOrCancelEditing}>{policy ? "Edit workspace" : "Set workspace"}</button>
					<button className="inline-action" disabled={!canManageWorkspace || loading || saving || !policy} onClick={() => void clearWorkspaceDefault()}>{saving ? "Updating…" : "Clear"}</button>
				</div>
			)}
			<div className="workspaces-room-body">
				{loading ? <p className="workspaces-empty-state">Loading workspace default…</p> : !editing && <WorkspaceDefaultPolicySummary policy={policy} warnings={warnings} />}
				{editing && (
					<form className="workspaces-default-form" onSubmit={(event) => void submitWorkspaceDefault(event)}>
						<div className="workspaces-field">
							<strong>Workspace folder</strong>
							<div className="workspace-folder-row">
								<button className="inline-action workspace-folder-choice-action" type="button" disabled={saving || choosingFolder} onClick={() => void chooseWorkspaceRootFolder()}>
									<svg className="workspace-folder-icon" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path fill="currentColor" d="M1.5 2.5A1.5 1.5 0 0 1 3 1h3.2c.4 0 .78.16 1.06.44L8.6 2.78c.1.1.22.15.35.15H13a1.5 1.5 0 0 1 1.5 1.5v8.07A1.5 1.5 0 0 1 13 14H3a1.5 1.5 0 0 1-1.5-1.5v-10Z" /></svg>
									{choosingFolder ? "Choosing…" : "Choose folder…"}
								</button>
								<input
									className="launcher-path-input workspace-folder-path-input"
									type="text"
									value={draftRoot}
									placeholder={savedFolderLabel ? `Keeping the saved folder: ${savedFolderLabel}` : "Type a folder path, or choose one"}
									aria-label="Workspace folder path"
									disabled={saving || choosingFolder}
									onChange={(event) => { setDraftRoot(event.target.value); setError(null); setMessage(null); }}
								/>
								{trimmedDraftRoot.length > 0 && policy && (
									<button className="inline-action" type="button" disabled={saving} onClick={() => { setDraftRoot(""); setError(null); setMessage(null); }}>Keep saved folder</button>
								)}
							</div>
						</div>
						<div className="workspaces-tool-options">
							<strong>Access mode</strong>
							<div className="workspace-mode-segments" role="radiogroup" aria-label="Workspace access mode">
								<button type="button" role="radio" aria-checked={draftAccessMode === "localFiles"} className={`workspace-mode-segment${draftAccessMode === "localFiles" ? " active" : ""}`} disabled={saving} onClick={() => changeAccessMode("localFiles")}>Full access</button>
								<button type="button" role="radio" aria-checked={draftAccessMode === "bounded"} className={`workspace-mode-segment${draftAccessMode === "bounded" ? " active" : ""}`} disabled={saving} onClick={() => changeAccessMode("bounded")}>Bounded workspace</button>
							</div>
							<p className="workspaces-session-note">{accessModeHint(draftAccessMode)}</p>
						</div>
						<div className="workspaces-tool-options">
							<strong>Tools</strong>
							<div className="workspace-tool-groups">
								{activeToolGroups.map((group) => (
									<div className="workspace-tool-group" key={group.label}>
										<span className="workspace-tool-group-label">{group.label}</span>
										<div className="workspaces-tool-list">
											{group.tools.map((tool) => {
												const checked = draftToolNames.includes(tool.name);
												return (
													<label className="workspaces-tool-row" key={tool.name}>
														<span>{tool.label}</span>
														<input className="workspaces-tool-switch" type="checkbox" checked={checked} disabled={saving} onChange={() => toggleTool(tool.name)} aria-label={`${tool.label} workspace tool`} />
													</label>
												);
											})}
										</div>
									</div>
								))}
							</div>
						</div>
						{draftAccessMode === "localFiles" && (
							<div className="workspace-power-user">
								<label className="workspaces-tool-row">
									<span><strong>Bash</strong></span>
									<input className="workspaces-tool-switch" type="checkbox" checked={draftBashEnabled} disabled={saving} onChange={() => { setDraftBashEnabled((current) => !current); setError(null); setMessage(null); }} aria-label="Bash shell access" />
								</label>
								<p className="workspaces-session-note">Power-user tool, off by default. Gives the room shell command access when enabled.</p>
							</div>
						)}
						<div className="workspace-form-actions">
							{dirty && <span className="workspace-unsaved-hint">Unsaved changes</span>}
							<button className="landing-action" disabled={saving}>{saving ? "Saving…" : policy ? "Save change" : "Save workspace"}</button>
							<button className="inline-action" type="button" disabled={saving} onClick={startOrCancelEditing}>Cancel</button>
						</div>
					</form>
				)}
				{message && <div className="workspaces-success">{message}</div>}
				{error && <div className="workspaces-error">{error}</div>}
			</div>
		</div>
	);
}
