import { type FormEvent, type ReactNode, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { bashRowsError, serializeDocumentWithBashRows, type BashRuleRow, type RoomPermissionsResponse } from "../bash-rules";
import { fetchPersistentRoomPermissions, updatePersistentRoomPermissions } from "../persistent-room-management-api";
import type { PersistentAgentStatus, PersistentRoomCapabilityPolicyView, PersistentRoomWorkspaceAccessMode } from "../types";
import { chooseSystemFolder, clearPersistentRoomWorkspaceDefault, fetchPersistentRoomWorkspaceDefault, savePersistentRoomWorkspaceDefault } from "../persistent-room-workspace-api";
import { showsComputerOnlyControls, useRemoteClientContext } from "../remote-client-context";
import { PaneHeader } from "./pane-header";
import { confirmDialog } from "./confirm-dialog";
import { BashRulesEditor } from "./BashRulesEditor";
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

// The summary lists the tools in the editor's order, whatever order the server keeps.
function orderedWorkspaceToolNames(toolNames: readonly string[]): string[] {
	const order: readonly string[] = ALL_LOCAL_FILES_TOOL_NAMES;
	const rank = (name: string): number => (order.includes(name) ? order.indexOf(name) : order.length);
	return [...toolNames].sort((a, b) => rank(a) - rank(b));
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

// A long path wraps after a folder separator rather than inside a folder's name.
function pathWithBreaks(fullPath: string): ReactNode[] {
	return fullPath.split(/(?<=[\\/])/).map((part, index) => <span key={index}>{part}<wbr /></span>);
}

const WRITER_TOOL_NAMES = new Set(["write", "edit"]);

/** The honest capability sentence, derived from what is actually enabled:
 * no writer tools and no Bash means the room cannot change anything; no
 * writer tools with Bash on means Bash is the remaining way to modify files. */
function workspaceHonestyNote(input: { toolNames: readonly string[]; localFiles: boolean; bashEnabled: boolean }): string | null {
	if (input.toolNames.some((name) => WRITER_TOOL_NAMES.has(name))) return null;
	if (input.localFiles && input.bashEnabled) return "Write tools are off, but Bash can still modify files.";
	if (input.toolNames.length === 0) return "With no tools on, this room can't see or change files here.";
	return "With this setup the room is read-only: it can see files here but cannot change anything.";
}

function accessModeLabel(mode: PersistentRoomWorkspaceAccessMode): string {
	return mode === "localFiles" ? "Full access" : "Bounded";
}

function accessModeHint(mode: PersistentRoomWorkspaceAccessMode): string {
	return mode === "localFiles"
		? "The room works with files like you do, in this folder and beyond it, and can create, edit and overwrite. Bash is available in this mode."
		: "The room stays inside this folder. It can read everything here, and with write tools enabled it can create and edit files inside it.";
}

/** Why saving waits while the room answers: a turn finishes under the rules it started with. */
export const ROOM_ANSWERING_SAVE_LINE = "The room is answering. You can save when it has finished.";
// The same wait beside a greyed Clear, where nothing is being saved.
const ROOM_ANSWERING_CHANGE_LINE = "The room is answering. You can change this when it has finished.";

// The server's codes for a folder it refuses: their lines show under the Folder row.
const FOLDER_REFUSAL_CODES = new Set(["missing_root", "root_not_absolute", "root_not_found", "root_not_directory", "forbidden_root", "under_forbidden_root", "ancestor_of_forbidden_root"]);

/** A line the pane shows by what it is about: under the Folder row, beside the buttons, or under the pane. A wait reads muted, a refusal red. */
interface PaneLine {
	text: string;
	at: "folder" | "buttons" | "pane";
	wait?: boolean;
}

function paneLineForError(error: unknown, fallback: string): PaneLine {
	const code = (error as { code?: unknown } | null)?.code;
	const text = (error as Error | null)?.message || fallback;
	if (typeof code === "string" && FOLDER_REFUSAL_CODES.has(code)) return { text, at: "folder" };
	return { text, at: "buttons", wait: code === "active_turn_in_flight" };
}

/** The pane's buttons, with the line about them right under them: a wait is a quiet status, a failure is announced. */
function WorkspaceButtons({ line, lineId, children }: { line: PaneLine | null; lineId: string; children: ReactNode }) {
	return (
		<div className="workspace-buttons">
			<div className="workspace-buttons-row">{children}</div>
			{line && <div id={lineId} className={line.wait ? "workspace-buttons-line" : "workspace-buttons-line workspace-buttons-refusal"} role={line.wait ? "status" : "alert"}>{line.text}</div>}
		</div>
	);
}

function WorkspaceDefaultPolicySummary({ policy, warnings, bashRuleCount, setupDisabled, onSetWorkspace, sharedServer, shellMissingNote }: { policy: PersistentRoomCapabilityPolicyView | null; warnings: string[]; bashRuleCount: number; setupDisabled: boolean; onSetWorkspace: () => void; sharedServer: boolean; shellMissingNote: string | null }) {
	const currentRoot = policy?.roots[0] ?? null;
	// A shared server is no one's own computer: its folders are not offered to
	// rooms, so there is nothing to set and no invitation to set it.
	if (sharedServer && (!policy || !currentRoot)) {
		return (
			<div className="settings-rows">
				<div className="settings-row">
					<div className="settings-row-main">
						<span className="settings-row-label">No workspace</span>
						<span className="settings-row-sub">On a shared server, rooms don't use a folder.</span>
					</div>
				</div>
			</div>
		);
	}
	if (!policy || !currentRoot) {
		return (
			<div className="settings-rows">
				<div className="settings-row">
					<div className="settings-row-main">
						<span className="settings-row-label">No workspace yet</span>
						<span className="settings-row-sub">Without a folder, this room can't read or write files, export documents, or run commands. Set a project folder to unlock file work.</span>
					</div>
					<button className="rs-btn" type="button" disabled={setupDisabled} onClick={onSetWorkspace}>Set workspace</button>
				</div>
			</div>
		);
	}
	const savedLabel = currentRoot.displayLabel || currentRoot.basename;
	// Only a page on this computer is sent the path; elsewhere the row names the folder alone.
	const fullPath = currentRoot.path || null;
	const folderName = currentRoot.basename;
	// The only warnings are a saved folder that is gone, and then the room has no workspace tools at all.
	const folderMissing = warnings.length > 0;
	const showFolderClue = Boolean(folderName && folderName !== savedLabel);
	// A shown path ends in the folder's name, so the name does not repeat beside it.
	const showNameBeside = folderMissing || !fullPath || showFolderClue;
	const workspaceToolsEnabled = policy.allowedToolNames.length > 0;
	const isLocalFiles = policy.workspaceAccessMode === "localFiles";
	const toolNames = folderMissing ? "Off until the folder is found" : workspaceToolsEnabled ? orderedWorkspaceToolNames(policy.allowedToolNames).map(formatWorkspaceToolName).join(", ") : "None";
	const honestyNote = folderMissing ? null : workspaceHonestyNote({ toolNames: policy.allowedToolNames, localFiles: isLocalFiles, bashEnabled: policy.bashEnabled === true });
	// The button's name stays on one line, so a narrow pane never ends the line on "workspace." alone.
	const goneFolderLine = "This folder was not found on this computer. Choose it again, or another one, in Edit\u00a0workspace.";
	return (
		<div className="workspaces-policy-summary">
			<div className="settings-rows">
				<div className="settings-row">
					<div className="settings-row-main">
						<span className="settings-row-label">Folder</span>
						{(folderMissing || fullPath || showFolderClue) && (
							<span className="settings-row-sub">
								{folderMissing ? goneFolderLine : fullPath && <span className="workspace-folder-path">{pathWithBreaks(fullPath)}</span>}
								{showFolderClue ? ` Folder: ${folderName}.` : ""}
							</span>
						)}
					</div>
					<span className="settings-row-value workspace-folder-value">
						{showNameBeside && <span className="workspace-folder-name" title={savedLabel}>{savedLabel}</span>}
						{folderMissing
							? <span className="settings-row-tag">Not found</span>
							: <span className="settings-row-tag" title={accessModeHint(policy.workspaceAccessMode)}>{accessModeLabel(policy.workspaceAccessMode)}</span>}
					</span>
				</div>
				<div className="settings-row">
					<span className="settings-row-label">Tools</span>
					<span className="settings-row-value">{toolNames}</span>
				</div>
				{isLocalFiles && !folderMissing && (
					<div className="settings-row">
						<span className="settings-row-label">Bash</span>
						<span className="settings-row-value">{policy.bashEnabled ? (bashRuleCount ? `On · ${bashRuleCount} rules` : "On") : "Off"}</span>
					</div>
				)}
				{policy.workspaceAccessMode === "bounded" && <div className="settings-row"><span className="settings-row-label">Access</span><span className="settings-row-value">Bounded workspace</span></div>}
			</div>
			{honestyNote && <p className="settings-help">{honestyNote}</p>}
			{isLocalFiles && policy.bashEnabled && shellMissingNote && <p className="settings-help workspace-shell-missing">{shellMissingNote}</p>}
			<p className="settings-help">Changes apply from your next message, also in a conversation you already started.</p>
		</div>
	);
}

export function RoomWorkspaceSection({ status, answering = false, onRefresh, onDirtyChange, registerSave, onTerminalOnChange }: { status: PersistentAgentStatus; answering?: boolean; onRefresh?: () => void; onDirtyChange?: (dirty: boolean) => void; registerSave?: RegisterSave; onTerminalOnChange?: (on: boolean | null) => void }) {
	const buttonsLineId = useId();
	const [policy, setPolicy] = useState<PersistentRoomCapabilityPolicyView | null>(null);
	const [warnings, setWarnings] = useState<string[]>([]);
	const [loading, setLoading] = useState(false);
	const [loadFailed, setLoadFailed] = useState(false);
	const [loadAttempt, setLoadAttempt] = useState(0);
	const [saving, setSaving] = useState(false);
	const [choosingFolder, setChoosingFolder] = useState(false);
	// The bash auto-approve preference saves the moment it is toggled, outside
	// the draft/save cycle above: it only changes whether the live session's
	// approval guard asks, which reads the stored value fresh on every call,
	// so no policy save or session rebind is involved.
	// The native folder chooser opens a dialog on the computer; from a remote
	// device that can only confuse (the server refuses it anyway), so the
	// button hides and the typed-path input stands alone. On a shared server
	// the folder is not set from here at all: Set workspace, Edit workspace
	// and Clear are not offered, so the editor (folder, tools, Bash) never opens.
	const remoteClient = useRemoteClientContext();
	const sharedServer = remoteClient.sharedServer;
	const [editing, setEditing] = useState(false);
	const [draftRoot, setDraftRoot] = useState("");
	const [draftAccessMode, setDraftAccessMode] = useState<PersistentRoomWorkspaceAccessMode>("localFiles");
	const [draftToolNames, setDraftToolNames] = useState<string[]>([...ALL_LOCAL_FILES_TOOL_NAMES]);
	const [draftBashEnabled, setDraftBashEnabled] = useState(false);
	// The server's own shell lookup (Windows without Git finds none); asked
	// again each time the editor opens, so it goes once Git is installed.
	const [shellMissingNote, setShellMissingNote] = useState<string | null>(null);
	const [permissions, setPermissions] = useState<RoomPermissionsResponse | null>(null);
	const [draftBashRules, setDraftBashRules] = useState<BashRuleRow[]>([]);
	const [permissionsError, setPermissionsError] = useState<string | null>(null);
	const [permissionsLoading, setPermissionsLoading] = useState(false);
	const permissionsRequest = useRef(0);
	const permissionsDraftChanged = useRef(false);
	const currentRoomId = useRef(status.id);
	currentRoomId.current = status.id;
	const [error, setError] = useState<PaneLine | null>(null);
	const [message, setMessage] = useState<string | null>(null);
	// The outcome line renders below the (tall) edit form inside a scrolling
	// pane: without this, a line can land off-screen and look like nothing
	// happened until the user scrolls.
	const outcomeRef = useRef<HTMLDivElement>(null);
	useEffect(() => {
		if (error?.at === "pane" || message) outcomeRef.current?.scrollIntoView({ block: "nearest" });
	}, [error, message]);
	// A path the app puts in the box (Edit opens, Choose folder… returns, Keep saved folder) shows its end, so the
	// folder's name is in view. Only those places count up, never a keystroke, so typing scrolls as any text box does.
	const folderInputRef = useRef<HTMLInputElement>(null);
	const [pathPlaced, setPathPlaced] = useState(0);
	function placeDraftRoot(root: string): void {
		setDraftRoot(root);
		setPathPlaced((count) => count + 1);
	}
	useLayoutEffect(() => {
		const input = folderInputRef.current;
		if (editing && input) input.scrollLeft = input.scrollWidth;
	}, [editing, pathPlaced]);
	// A line beside the buttons belonged to the room's state when it came; once
	// the room starts or stops answering, the buttons say it themselves.
	useEffect(() => {
		setError((current) => (current?.at === "buttons" ? null : current));
	}, [answering]);
	const canManageWorkspace = status.exists && status.status !== "error";
	const trimmedDraftRoot = draftRoot.trim();
	// The saved folder's path, when this page is on the computer: Edit opens with it in the box.
	const savedPath = policy?.roots[0]?.path ?? "";
	const draftRootChanged = trimmedDraftRoot.length > 0 && trimmedDraftRoot !== savedPath;
	const baselineAccessMode = policy?.workspaceAccessMode ?? "localFiles";
	const baselineToolNames = draftToolNamesForPolicy(policy);
	const baselineBashEnabled = policy?.workspaceAccessMode === "localFiles" && policy?.bashEnabled === true;
	const baselineBashRules = permissions?.bashRows ?? [];
	const rulesDirty = JSON.stringify(draftBashRules) !== JSON.stringify(baselineBashRules);
	const rulesShown = draftAccessMode === "localFiles" && draftBashEnabled;
	const dirty = editing && (
		draftRootChanged ||
		draftAccessMode !== baselineAccessMode ||
		draftBashEnabled !== baselineBashEnabled ||
		[...draftToolNames].sort().join(",") !== [...baselineToolNames].sort().join(",") ||
		rulesDirty
	);

	useEffect(() => {
		onDirtyChange?.(dirty);
	}, [dirty, onDirtyChange]);
	useEffect(() => () => onDirtyChange?.(false), [onDirtyChange]);
	// What the saved workspace lets the room run, for the Skills pane's files line; null while unknown.
	const terminalOn = loading || loadFailed || !canManageWorkspace ? null : policy?.workspaceAccessMode === "localFiles" && policy.bashEnabled === true && warnings.length === 0;
	useEffect(() => {
		onTerminalOnChange?.(terminalOn);
	}, [terminalOn, onTerminalOnChange]);

	useEffect(() => {
		let cancelled = false;
		permissionsRequest.current++;
		permissionsDraftChanged.current = false;
		setPermissions(null);
		setDraftBashRules([]);
		setPermissionsError(null);
		setPermissionsLoading(false);
		setPolicy(null);
		setWarnings([]);
		setEditing(false);
		setDraftRoot("");
		setDraftAccessMode("localFiles");
		setDraftToolNames([...ALL_LOCAL_FILES_TOOL_NAMES]);
		setDraftBashEnabled(false);
		setShellMissingNote(null);
		setSaving(false);
		setMessage(null);
		setLoadFailed(false);
		if (!canManageWorkspace) {
			setLoading(false);
			setError({ text: status.exists ? "This room needs attention before its workspace can be managed." : "Create this room before assigning a workspace.", at: "pane" });
			return () => { cancelled = true; };
		}
		setLoading(true);
		setError(null);
		void fetchPersistentRoomWorkspaceDefault(status.id)
			.then((response) => {
				if (cancelled) return;
				setPolicy(response.policy);
				setWarnings(response.warnings ?? []);
				setShellMissingNote(response.shellMissingNote || null);
				if (response.policy?.workspaceAccessMode === "localFiles" && response.policy.bashEnabled) void loadPermissions();
			})
			.catch(() => {
				if (!cancelled) setLoadFailed(true);
			})
			.finally(() => {
				if (!cancelled) setLoading(false);
			});
		return () => { cancelled = true; permissionsRequest.current++; };
	}, [canManageWorkspace, status.exists, status.id, loadAttempt]);

	async function loadPermissions(): Promise<void> {
		const roomId = status.id;
		const request = ++permissionsRequest.current;
		setPermissionsLoading(true);
		setPermissionsError(null);
		setPermissions(null);
		if (!permissionsDraftChanged.current) setDraftBashRules([]);
		try {
			const response = await fetchPersistentRoomPermissions(roomId);
			if (request !== permissionsRequest.current || roomId !== currentRoomId.current) return;
			if (response.error) {
				setPermissions(null);
				setPermissionsError(response.error);
				return;
			}
			setPermissions(response);
			if (!permissionsDraftChanged.current) setDraftBashRules(response.bashRows);
		} catch (e) {
			if (request === permissionsRequest.current && roomId === currentRoomId.current) {
				setPermissions(null);
				setPermissionsError((e as Error).message || "Failed to load permission rules.");
			}
		} finally {
			if (request === permissionsRequest.current && roomId === currentRoomId.current) setPermissionsLoading(false);
		}
	}

	// Save and close in the unsaved question: the editor's own save.
	useRegisteredSave(registerSave, saveWorkspaceDefault);

	// The server refused because the room is answering, which this page had not
	// seen: a fresh status greys the buttons until the answer has finished.
	function showRefusal(e: unknown, fallback: string): void {
		const line = paneLineForError(e, fallback);
		setError(line);
		if (line.wait) onRefresh?.();
	}

	async function submitWorkspaceDefault(event: FormEvent<HTMLFormElement>): Promise<void> {
		event.preventDefault();
		await saveWorkspaceDefault();
	}

	async function saveWorkspaceDefault(): Promise<boolean> {
		if (saving) return false;
		// The saved path left as it is keeps the saved folder: only a new folder is sent.
		const roomId = status.id;
		const root = draftRoot.trim() === savedPath ? "" : draftRoot.trim();
		if (!root && !policy) {
			setError({ text: "Choose a folder for this room workspace.", at: "folder" });
			return false;
		}
		const activeToolNames = workspaceToolNamesForMode(draftAccessMode);
		const selectedToolNames = activeToolNames.filter((toolName) => draftToolNames.includes(toolName));
		const allToolsSelected = activeToolNames.every((toolName) => selectedToolNames.includes(toolName));
		const toolSelection = allToolsSelected && selectedToolNames.length === activeToolNames.length
			? { kind: "standard" as const, allowedToolNames: [...activeToolNames] }
			: { kind: "custom" as const, allowedToolNames: selectedToolNames };
		if (rulesDirty) {
			if (permissionsLoading || !permissions || permissionsError) {
				setError({ text: "Permission rules could not be loaded. Fix runtime/permissions.json before saving Bash rule changes.", at: "pane" });
				return false;
			}
			const validationError = bashRowsError(draftBashRules);
			if (validationError) { setError({ text: validationError, at: "pane" }); return false; }
		}
		permissionsRequest.current++;
		setPermissionsLoading(false);
		setSaving(true);
		setError(null);
		setMessage(null);
		try {
			const response = await savePersistentRoomWorkspaceDefault(roomId, {
				root: root || undefined,
				workspaceAccessMode: draftAccessMode,
				toolSelection,
				bashEnabled: draftAccessMode === "localFiles" && draftBashEnabled,
			});
			if (roomId !== currentRoomId.current) return false;
			setPolicy(response.policy);
			setWarnings(response.warnings ?? []);
			setDraftRoot("");
			setDraftAccessMode(response.policy?.workspaceAccessMode ?? "localFiles");
			setDraftToolNames(draftToolNamesForPolicy(response.policy));
			setDraftBashEnabled(response.policy?.workspaceAccessMode === "localFiles" && response.policy?.bashEnabled === true);
			if (rulesDirty) {
				try {
					const latest = await fetchPersistentRoomPermissions(roomId);
					if (roomId !== currentRoomId.current) return false;
					if (latest.error) throw new Error(latest.error);
					const updated = await updatePersistentRoomPermissions(roomId, serializeDocumentWithBashRows(latest, draftBashRules));
					if (roomId !== currentRoomId.current) return false;
					if (updated.error) throw new Error(updated.error);
					setPermissions(updated);
					setDraftBashRules(updated.bashRows);
				} catch (e) {
					if (roomId !== currentRoomId.current) return false;
					setError({ text: `Workspace policy saved (including Bash access), but the Bash rules were not: ${(e as Error).message || "Failed to save permission rules."} Bash may already be active under previous rules or default approval behavior.`, at: "pane" });
					return false;
				}
			}
			permissionsDraftChanged.current = false;
			if (!rulesDirty && !rulesShown) setDraftBashRules(permissions?.bashRows ?? []);
			if (response.policy?.workspaceAccessMode === "localFiles" && response.policy.bashEnabled && !rulesDirty && (permissions === null || !rulesShown)) void loadPermissions();
			setEditing(false);
			setMessage("Saved.");
			return true;
		} catch (e) {
			showRefusal(e, "Couldn't save the workspace. Try again.");
			return false;
		} finally {
			if (roomId === currentRoomId.current) setSaving(false);
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
			permissionsRequest.current++;
			setPermissionsLoading(false);
			permissionsDraftChanged.current = false;
			setDraftBashRules(permissions?.bashRows ?? []);
			setError(null);
			setMessage(null);
			return;
		}
		placeDraftRoot(savedPath);
		setDraftAccessMode(policy?.workspaceAccessMode ?? "localFiles");
		setDraftToolNames(draftToolNamesForPolicy(policy));
		setDraftBashEnabled(policy?.workspaceAccessMode === "localFiles" && policy?.bashEnabled === true);
		permissionsDraftChanged.current = false;
		setDraftBashRules(permissions?.bashRows ?? []);
		void loadPermissions();
		setEditing(true);
		void fetchPersistentRoomWorkspaceDefault(status.id).then((response) => setShellMissingNote(response.shellMissingNote || null), () => {});
		setError(null);
		setMessage(null);
	}

	async function clearWorkspaceDefault(): Promise<void> {
		const ok = await confirmDialog({
			title: "Clear this room's workspace?",
			body: "The room can't use files until you set a folder again. Its tool and Bash choices are cleared too.",
			confirmLabel: "Clear",
			danger: true,
		});
		if (!ok) return;
		const roomId = status.id;
		setSaving(true);
		setError(null);
		setMessage(null);
		try {
			const response = await clearPersistentRoomWorkspaceDefault(roomId);
			if (roomId !== currentRoomId.current) return;
			setPolicy(null);
			setWarnings(response.warnings ?? []);
			setDraftRoot("");
			setDraftAccessMode("localFiles");
			setDraftToolNames([...ALL_LOCAL_FILES_TOOL_NAMES]);
			setDraftBashEnabled(false);
			permissionsRequest.current++;
			setPermissionsLoading(false);
			permissionsDraftChanged.current = false;
			setDraftBashRules(permissions?.bashRows ?? []);
			setEditing(false);
			setMessage(response.deleted ? "Folder removed." : "This room had no folder saved.");
		} catch (e) {
			if (roomId !== currentRoomId.current) return;
			showRefusal(e, "Couldn't clear the workspace. Try again.");
		} finally {
			if (roomId === currentRoomId.current) setSaving(false);
		}
	}

	async function chooseWorkspaceRootFolder(): Promise<void> {
		setChoosingFolder(true);
		setError(null);
		setMessage(null);
		try {
			const response = await chooseSystemFolder();
			if (response.cancelled) return;
			placeDraftRoot(response.path);
		} catch (e) {
			setError({ text: (e as Error).message || "Folder chooser failed. Try again.", at: "folder" });
		} finally {
			setChoosingFolder(false);
		}
	}

	const activeToolGroups = workspaceToolGroupsForMode(draftAccessMode);
	const draftHonestyNote = workspaceHonestyNote({ toolNames: draftToolNames, localFiles: draftAccessMode === "localFiles", bashEnabled: draftAccessMode === "localFiles" && draftBashEnabled });
	const savedRoot = policy?.roots[0] ?? null;
	const savedFolderLabel = savedRoot ? (savedRoot.displayLabel || savedRoot.basename) : null;
	// While the room answers, saving waits: the server would refuse it, since a
	// turn finishes under the rules it started with.
	const buttonsLine: PaneLine | null = answering ? { text: editing ? ROOM_ANSWERING_SAVE_LINE : ROOM_ANSWERING_CHANGE_LINE, at: "buttons", wait: true } : error?.at === "buttons" ? error : null;
	// A greyed button names the line that says why, for a screen reader.
	const heldReason = answering ? buttonsLineId : undefined;

	return (
		<div className="room-workspace-section">
			<PaneHeader
				title="Workspace"
				actions={editing ? (
					<WorkspaceButtons line={buttonsLine} lineId={buttonsLineId}>
						{dirty && <span className="workspace-unsaved-hint">Unsaved changes</span>}
						<button className="rs-btn" type="button" disabled={saving} onClick={startOrCancelEditing}>Cancel</button>
						<button className="rs-btn rs-btn-primary" type="submit" form="workspace-editor-form" disabled={saving || answering} aria-describedby={heldReason}>{saving ? "Saving…" : policy ? "Save changes" : "Save workspace"}</button>
					</WorkspaceButtons>
				) : policy && !sharedServer && !loadFailed && (
					<WorkspaceButtons line={buttonsLine} lineId={buttonsLineId}>
						<button className="rs-btn" disabled={!canManageWorkspace || loading || saving || answering} aria-describedby={heldReason} title="Remove the saved workspace folder" onClick={() => void clearWorkspaceDefault()}>{saving ? "Updating…" : "Clear"}</button>
						<button className="rs-btn" disabled={!canManageWorkspace || loading || saving} onClick={startOrCancelEditing}>Edit workspace</button>
					</WorkspaceButtons>
				)}
			/>
			<div className="workspaces-room-body">
				{loading ? <p className="settings-empty">Loading…</p> : loadFailed ? (
					<div className="settings-rows"><div className="settings-row"><span className="settings-row-sub">Couldn't load this room's workspace.</span><button className="rs-btn" type="button" onClick={() => setLoadAttempt((attempt) => attempt + 1)}>Try again</button></div></div>
				) : !editing && <WorkspaceDefaultPolicySummary policy={policy} warnings={warnings} bashRuleCount={permissionsError ? 0 : (permissions?.bashRows.length ?? 0)} setupDisabled={!canManageWorkspace || saving} onSetWorkspace={startOrCancelEditing} sharedServer={sharedServer} shellMissingNote={shellMissingNote} />}
				{editing && (
					<form id="workspace-editor-form" className="workspaces-default-form" onSubmit={(event) => void submitWorkspaceDefault(event)}>
						<div className="settings-rows">
							<div className="settings-row">
								<div className="settings-row-main">
									<span className="settings-row-label">Folder</span>
									<span className="settings-row-sub">{savedFolderLabel ? (warnings.length > 0 ? `${savedFolderLabel} was not found on this computer. Pick it again, or another folder.` : `${savedFolderLabel}, saved. Pick another to change it.`) : "Pick the folder this room works in."}</span>
								</div>
								<div className="workspace-folder-field">
									<div className="settings-row-value workspace-folder-controls">
										<input
											ref={folderInputRef}
											className="launcher-path-input workspace-folder-path-input"
											type="text"
											value={draftRoot}
											placeholder={savedFolderLabel ? "Or type a path" : "Type a folder path"}
											aria-label="Workspace folder path"
											disabled={saving || choosingFolder}
											onChange={(event) => { setDraftRoot(event.target.value); setError(null); setMessage(null); }}
											// Enter accepts the folder and leaves Access and Tools to look at: saving stays a click.
											onKeyDown={(event) => { if (event.key === "Enter" && !event.nativeEvent.isComposing) event.preventDefault(); }}
										/>
										{draftRootChanged && policy && (
											<button className="rs-btn" type="button" disabled={saving} onClick={() => { placeDraftRoot(savedPath); setError(null); setMessage(null); }}>Keep saved folder</button>
										)}
										{showsComputerOnlyControls(remoteClient) && (
											<button className="rs-btn" type="button" disabled={saving || choosingFolder} onClick={() => void chooseWorkspaceRootFolder()}>
												{choosingFolder ? "Choosing…" : "Choose folder…"}
											</button>
										)}
									</div>
									{error?.at === "folder" && <span className="workspaces-error workspace-folder-line" role="alert">{error.text}</span>}
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
									<span className="settings-row-sub">Lets the room run commands on this computer, like a terminal. Off by default. Whether each command asks you first is set at the top of the chat.</span>
									{shellMissingNote && <span className="settings-row-sub workspace-shell-missing">{shellMissingNote}</span>}
												</span>
												<input className="workspaces-tool-switch" type="checkbox" checked={draftBashEnabled} disabled={saving} onChange={() => { setDraftBashEnabled((current) => !current); setError(null); setMessage(null); }} aria-label="Bash shell access" />
											</label>
										)}
									</div>
							))}
							</div>
							{draftAccessMode === "localFiles" && draftBashEnabled}
							{rulesShown && (
								<section className="settings-group" aria-label="Bash permissions">
									{permissionsLoading ? <p className="settings-help">Loading Bash rules…</p> : permissionsError ? <div className="workspaces-error">{permissionsError} Fix runtime/permissions.json to edit rules.</div> : permissions ? <BashRulesEditor rows={draftBashRules} onChange={(rows) => { permissionsDraftChanged.current = true; setDraftBashRules(rows); setError(null); setMessage(null); }} disabled={saving} idPrefix={`bash-rule-${status.id}`} /> : null}
								</section>
							)}
							{draftHonestyNote && <p className="settings-help">{draftHonestyNote}</p>}
							{draftAccessMode === "bounded" && <p className="settings-help">Bash is available in Full access mode.</p>}
						</div>
					</form>
				)}
				<div ref={outcomeRef}>
					{message && <div className="workspaces-success">{message}</div>}
					{error?.at === "pane" && <div className="workspaces-error">{error.text}</div>}
				</div>
			</div>
		</div>
	);
}
