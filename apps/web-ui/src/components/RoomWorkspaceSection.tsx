import { type FormEvent, type ReactNode, useEffect, useId, useRef, useState } from "react";
import type { PersistentAgentStatus, PersistentRoomCapabilityPolicyView, PersistentRoomProtection, PersistentRoomWorkspaceDefaultResponse } from "../types";
import { addAlsoAllowedFolder, type AlsoAllowedAddResponse, type AlsoAllowedEntryName, type AlsoAllowedFolderView, type AlsoAllowedList, type AlsoAllowedRemoveResponse, chooseSystemFolder, clearPersistentRoomWorkspaceDefault, fetchAlsoAllowed, fetchPersistentRoomWorkspaceDefault, NO_FOLDER_WINDOW_CODES, removeAlsoAllowed, restoreAlsoAllowed, savePersistentRoomWorkspaceDefault, setAlsoAllowedAccess, setPersistentRoomProtection } from "../persistent-room-workspace-api";
import { fetchPersistentRoomBashSettings } from "../persistent-room-management-api";
import { showsComputerOnlyControls, useRemoteClientContext } from "../remote-client-context";
import { ADD_A_FOLDER, ALLOW_CHANGES, ALSO_ALLOWED, ALSO_ALLOWED_LINE, ALSO_ALLOWED_LOAD_FAILED, CAN_CHANGE_FILES, CAN_CHANGE_FILES_OFF_LINE, CAN_CHANGE_FILES_OFF_NO_COMMANDS_LINE, CAN_CHANGE_FILES_OFF_UNPROTECTED_LINE, CAN_CHANGE_FILES_ON_LINE, CAN_READ, CAN_READ_AND_CHANGE, CANCEL, CHANGE_SAVE_FAILED, CHANGE_FOLDER, CHANGEABLE_AT_COMPUTER, CHOOSE_FOLDER, CHOOSING, commandModeOf, type CommandMode, COMMANDS, COMMANDS_FREE_REACH, COMMANDS_NEED_CHANGES_LINE, COMMANDS_NO_PROTECTION_AUTO_REACH, COMMANDS_NO_PROTECTION_REACH, COMMANDS_PROTECTED_REACH, COMMANDS_UNPROTECTED_AUTO_REACH, COMMANDS_UNPROTECTED_REACH, CREATE_ROOM_FIRST, FOLDER_CLEAR_FAILED, FOLDER_LOAD_FAILED, FOLDER_NOT_FOUND, FOLDER_PANE_LINE, FOLDER_PANE_TITLE, FOLDER_REMOVED, FOLDER_REMOVED_NONE, FOLDER_SAVE_FAILED, folderRemovedLine, folderStillReadLine, LOADING, LOCATION, NO_FOLDER, NO_FOLDER_YET, NO_FOLDER_YET_LINE, NO_OTHER_FOLDERS_OR_SITES, NOT_FOUND, ONLY_ALLOW_READING, PROTECTION, PROTECTION_LINE, PROTECTION_OFF_LINE, PROTECTION_ROW_UNAVAILABLE, PROTECTION_ROW_UNAVAILABLE_COMPUTER, PROTECTION_ROW_UNAVAILABLE_FOLDER, PROTECTION_UNAVAILABLE, REMOVE_FROM_LIST, ROOM_ANSWERING_CHANGE_LINE, ROOM_NEEDS_ATTENTION, SAVED, SHARED_SERVER_NO_FOLDER, SITE, siteRemovedLine, STOP_USING, STOP_USING_FOLDER, STOP_USING_FOLDER_BODY, stopUsingFolderTitle, TRY_AGAIN, TURN_OFF, TURN_OFF_PROTECTION_BODY, TURN_OFF_PROTECTION_BODY_COMMANDS_OFF, TURN_OFF_PROTECTION_TITLE, TYPE_THE_PATH, typedPathExample, UNDO, USE_THIS_FOLDER } from "../../../web-server/src/room-box/card-text";
import { CloseIcon, FolderIcon, GlobeIcon, PlusIcon } from "./icons";
import { GroupHeader, PaneHeader } from "./pane-header";
import { confirmDialog } from "./confirm-dialog";
import { useSettingsLookNext } from "../settings-look";

// How long a change's Saved stays in the live line a screen reader hears, so the next change's Saved is heard again.
const SAVED_LINE_MS = 3000;

// The server's codes for a folder it refuses: its own words say why, under Location.
const FOLDER_REFUSAL_CODES = new Set(["missing_root", "root_not_absolute", "root_not_found", "root_not_directory", "forbidden_root", "under_forbidden_root", "ancestor_of_forbidden_root", "folder_refused"]);

/** A room's file tools: all six, or the four it reads with where Can change files is off. */
const ALL_TOOL_NAMES = ["read", "ls", "find", "grep", "write", "edit"];
const READ_TOOL_NAMES = ["read", "ls", "find", "grep"];

const codeOf = (error: unknown): string | undefined => {
	const code = (error as { code?: unknown } | null)?.code;
	return typeof code === "string" ? code : undefined;
};

/** The room's folder as the pane reads it. */
interface RoomFolder {
	policy: PersistentRoomCapabilityPolicyView | null;
	warnings: string[];
	shellMissingNote: string | null;
	/** Absent on a shared server. */
	protection?: PersistentRoomProtection;
	/** The room's mode for its commands, in the protection read with it, which the Commands line says on Auto; Ask where it isn't read. */
	mode: CommandMode;
}

const roomFolderOf = (response: PersistentRoomWorkspaceDefaultResponse, mode: CommandMode): RoomFolder => ({
	policy: response.policy,
	warnings: response.warnings ?? [],
	shellMissingNote: response.shellMissingNote || null,
	protection: response.protection,
	mode,
});

/**
 * The room's folder and, where the Commands line is drawn (at the computer, not
 * on a shared server), its mode: both read, or the read fails, so a room on
 * Auto never shows another mode's line.
 */
function readRoomFolder(roomId: string, readsMode: boolean): Promise<RoomFolder> {
	return Promise.all([
		fetchPersistentRoomWorkspaceDefault(roomId),
		readsMode ? fetchPersistentRoomBashSettings(roomId) : null,
	]).then(([response, modeRead]) => roomFolderOf(response, modeRead ? commandModeOf(modeRead.settings, response.protection?.state !== "off") : "ask"));
}

const canChangeOf = (policy: PersistentRoomCapabilityPolicyView | null): boolean => policy?.allowedToolNames.some((name) => name === "write" || name === "edit") === true;

/** The Commands line for the room's protection and mode now, and whether the switch can move at all. */
function commandsLineOf(protection: PersistentRoomProtection | undefined, canChange: boolean, mode: CommandMode): { line: string; held: boolean } {
	const auto = mode === "auto";
	if (!protection || protection.state === "on") return { line: auto ? COMMANDS_FREE_REACH : COMMANDS_PROTECTED_REACH, held: false };
	if (protection.cause === "computer") return canChange ? { line: auto ? COMMANDS_NO_PROTECTION_AUTO_REACH : COMMANDS_NO_PROTECTION_REACH, held: false } : { line: COMMANDS_NEED_CHANGES_LINE, held: true };
	return { line: auto ? COMMANDS_UNPROTECTED_AUTO_REACH : COMMANDS_UNPROTECTED_REACH, held: false };
}

/** Can change files' line: off, it says what the room's commands can still do where protection stands now. */
function canChangeLineOf(protection: PersistentRoomProtection | undefined, canChange: boolean): string {
	if (canChange) return CAN_CHANGE_FILES_ON_LINE;
	if (!protection || protection.state === "on") return CAN_CHANGE_FILES_OFF_LINE;
	// This computer holds commands off while Can change files is; anywhere else outside protection they still change files.
	return protection.cause === "computer" ? CAN_CHANGE_FILES_OFF_NO_COMMANDS_LINE : CAN_CHANGE_FILES_OFF_UNPROTECTED_LINE;
}

/** The protection row's line: what it does where it is on, what turning it on does where the person turned it off, and only the cause where it can't work. */
const CAUSE_LINES = { computer: PROTECTION_ROW_UNAVAILABLE_COMPUTER, folder: PROTECTION_ROW_UNAVAILABLE_FOLDER, unknown: PROTECTION_ROW_UNAVAILABLE } as const;
const protectionLineOf = (protection: PersistentRoomProtection): string => protection.state === "on" ? PROTECTION_LINE : protection.cause ? CAUSE_LINES[protection.cause] : PROTECTION_OFF_LINE;

/** Where in the pane a change was made: why it failed shows right there. */
type Spot = "location" | "canChange" | "commands" | "protection";

/** The pane's last change to the room's folder. One at a time; a switch shows its new place while it saves. Saved and removed are heard, not shown. */
type Outcome =
	| { kind: "saving"; at: Spot; on?: boolean }
	| { kind: "saved"; at: Spot }
	| { kind: "failed"; at: Spot; text: string; wait: boolean }
	| { kind: "removed"; text: string };

/**
 * Room settings' Folder pane: Location, Can change files, Commands, the
 * room's protection and Also allowed. Each change saves on its click, one at
 * a time, and none while the room answers. Only the computer changes it: a
 * phone sees it greyed, with names and no paths.
 */
export function RoomWorkspaceSection({ status, answering = false, onRefresh }: { status: PersistentAgentStatus; answering?: boolean; onRefresh?: () => void }) {
	const waitLineId = useId();
	const lookNext = useSettingsLookNext();
	const [room, setRoom] = useState<RoomFolder | null>(null);
	// Nothing is known before the first read: no frame draws a room with no folder, or reads its list, before it.
	const [loading, setLoading] = useState(true);
	const [loadFailed, setLoadFailed] = useState(false);
	const [loadAttempt, setLoadAttempt] = useState(0);
	const [outcome, setOutcome] = useState<Outcome | null>(null);
	const [choosing, setChoosing] = useState(false);
	// The computer can't open its folder window: the path is typed in a box under Location.
	const [typing, setTyping] = useState(false);
	const [typedRoot, setTypedRoot] = useState("");
	const remoteClient = useRemoteClientContext();
	const sharedServer = remoteClient.sharedServer;
	const atComputer = showsComputerOnlyControls(remoteClient);
	const readRoom = () => readRoomFolder(status.id, atComputer && !sharedServer);
	const canManageWorkspace = status.exists && status.status !== "error";
	const policy = room?.policy ?? null;
	const savedRoot = policy?.roots[0] ?? null;
	const folderMissing = (room?.warnings.length ?? 0) > 0;
	// No folder, or one no longer found: Location's button is the primary one, to choose a folder; a folder that is there gets changed.
	const needsFolder = !savedRoot || folderMissing;
	// A Saved is a moment, not a state: it goes once it has been heard.
	useEffect(() => {
		if (outcome?.kind !== "saved") return;
		const timer = setTimeout(() => setOutcome((current) => (current === outcome ? null : current)), SAVED_LINE_MS);
		return () => clearTimeout(timer);
	}, [outcome]);
	// A wait the server gave belonged to the room's state when it came; the line above the pane says it now.
	useEffect(() => {
		setOutcome((current) => (current?.kind === "failed" && current.wait ? null : current));
	}, [answering]);

	useEffect(() => {
		let cancelled = false;
		setRoom(null);
		setOutcome(null);
		setTyping(false);
		setLoadFailed(false);
		if (!canManageWorkspace) {
			setLoading(false);
			return () => { cancelled = true; };
		}
		setLoading(true);
		void readRoom()
			.then((read) => { if (!cancelled) setRoom(read); })
			.catch(() => { if (!cancelled) setLoadFailed(true); })
			.finally(() => { if (!cancelled) setLoading(false); });
		return () => { cancelled = true; };
	}, [canManageWorkspace, status.id, loadAttempt, atComputer, sharedServer]);

	/**
	 * Runs one change. A change with no answer that says it saved (lost, or any
	 * error but a wait or a refused folder) is judged by reading the room once:
	 * `landed` says whether the room as stored shows what was asked. A room that
	 * can't be read says so, never a pane that may be stale.
	 */
	async function change(at: Spot, on: boolean | undefined, run: () => Promise<RoomFolder | null>, landed: (stored: RoomFolder) => boolean, failedText: (stored: RoomFolder, code: string | undefined) => string | null): Promise<boolean> {
		setOutcome({ kind: "saving", at, on });
		let refusal: unknown;
		try {
			const saved = await run();
			if (saved) setRoom(saved);
			setOutcome({ kind: "saved", at });
			return true;
		} catch (e) {
			refusal = e;
		}
		const code = codeOf(refusal);
		if (code === "active_turn_in_flight") {
			// The room started answering, which this page hadn't seen: a fresh status greys the pane.
			onRefresh?.();
			setOutcome({ kind: "failed", at, text: ROOM_ANSWERING_CHANGE_LINE, wait: true });
			return false;
		}
		if (code && FOLDER_REFUSAL_CODES.has(code)) {
			setOutcome({ kind: "failed", at, text: (refusal as Error).message || FOLDER_SAVE_FAILED, wait: false });
			return false;
		}
		let stored: RoomFolder;
		try {
			stored = await readRoom();
		} catch {
			setOutcome(null);
			setRoom(null);
			setLoadFailed(true);
			return false;
		}
		setRoom(stored);
		if (landed(stored)) {
			setOutcome({ kind: "saved", at });
			return true;
		}
		const text = failedText(stored, code);
		setOutcome(text ? { kind: "failed", at, text, wait: false } : null);
		return false;
	}

	/** After a save, what the server says around the folder (its protection) is read again; a failed read keeps what the pane has. */
	async function saveFolder(at: "location" | "canChange" | "commands", asked: { root?: string; canChange?: boolean; commands?: boolean }): Promise<boolean> {
		const before = room;
		const canChange = asked.canChange ?? canChangeOf(policy);
		const sentRoot = asked.root;
		const done = await change(at, at === "location" ? undefined : at === "canChange" ? canChange : asked.commands, async () => {
			const response = await savePersistentRoomWorkspaceDefault(status.id, {
				root: sentRoot,
				// Every save with a folder keeps the room's Can change files; with none the server keeps what Stop using left, or all six for a first folder.
				...(policy ? { toolSelection: canChange ? { kind: "standard", allowedToolNames: ALL_TOOL_NAMES } : { kind: "custom", allowedToolNames: READ_TOOL_NAMES } } : {}),
				// Only the Commands switch sends them: any other change keeps them as they stand, the start-on default and a Clear's included.
				...(asked.commands === undefined ? {} : { bashEnabled: asked.commands }),
			});
			const next = await readRoom().catch(() => null);
			return next ?? (before ? { ...before, policy: response.policy, warnings: response.warnings ?? [] } : null);
		}, (stored) => {
			if (at === "location") return Boolean(stored.policy?.roots[0]) && stored.policy?.roots[0]?.path !== before?.policy?.roots[0]?.path;
			if (at === "canChange") return canChangeOf(stored.policy) === asked.canChange;
			return stored.policy?.bashEnabled === asked.commands;
		}, () => (at === "location" ? FOLDER_SAVE_FAILED : CHANGE_SAVE_FAILED));
		if (done) onRefresh?.();
		return done;
	}

	async function chooseLocation(): Promise<void> {
		setChoosing(true);
		setOutcome(null);
		let root: string | null = null;
		try {
			const response = await chooseSystemFolder();
			root = response.cancelled ? null : response.path;
		} catch (e) {
			const code = codeOf(e);
			if (code && NO_FOLDER_WINDOW_CODES.has(code)) setTyping(true);
			else if (code !== "folder_chooser_stopped") setOutcome({ kind: "failed", at: "location", text: FOLDER_SAVE_FAILED, wait: false });
		} finally {
			setChoosing(false);
		}
		if (root) await saveFolder("location", { root });
	}

	async function submitTypedRoot(event: FormEvent<HTMLFormElement>): Promise<void> {
		event.preventDefault();
		const root = typedRoot.trim();
		if (!root) return;
		if (await saveFolder("location", { root })) {
			setTyping(false);
			setTypedRoot("");
		}
	}

	async function stopUsingFolder(): Promise<void> {
		const name = savedRoot ? (savedRoot.displayLabel || savedRoot.basename) : "";
		const ok = await confirmDialog({ title: stopUsingFolderTitle(name), body: STOP_USING_FOLDER_BODY, confirmLabel: STOP_USING, cancelLabel: CANCEL, danger: true });
		if (!ok) return;
		let deleted = true;
		const done = await change("location", undefined, async () => {
			const response = await clearPersistentRoomWorkspaceDefault(status.id);
			deleted = response.deleted === true;
			return readRoom().catch(() => (room ? { ...room, policy: null, warnings: [] } : null));
		}, (stored) => stored.policy === null, () => FOLDER_CLEAR_FAILED);
		if (!done) return;
		setOutcome({ kind: "removed", text: deleted ? FOLDER_REMOVED : FOLDER_REMOVED_NONE });
		onRefresh?.();
	}

	/** Turning the switch off asks first, in words true for the room's Commands as they stand; turning it on saves at once. Either way Home's card follows. */
	async function changeProtection(state: "on" | "off"): Promise<void> {
		const body = policy?.bashEnabled === true ? TURN_OFF_PROTECTION_BODY : TURN_OFF_PROTECTION_BODY_COMMANDS_OFF;
		if (state === "off" && !(await confirmDialog({ title: TURN_OFF_PROTECTION_TITLE, body, confirmLabel: TURN_OFF, cancelLabel: CANCEL, danger: true }))) return;
		await change("protection", state === "on", async () => {
			await setPersistentRoomProtection(status.id, state);
			// The Commands line says the room's mode as the new state reads it, so the room is read again: a failed read goes to the check below, never a guess.
			return readRoom();
		}, (stored) => state === "on" ? stored.protection?.state === "on" : stored.protection?.state === "off" && stored.protection.cause === undefined, (stored, code) => {
			// A cause that stands now says itself on the row.
			if (stored.protection?.state === "off" && stored.protection.cause) return null;
			return code === "protection_unavailable" ? PROTECTION_UNAVAILABLE : CHANGE_SAVE_FAILED;
		});
		onRefresh?.();
	}

	const hasFolder = Boolean(savedRoot);
	const protection = room?.protection;
	const canChange = outcome?.kind === "saving" && outcome.at === "canChange" ? outcome.on === true : canChangeOf(policy);
	const commandsOn = outcome?.kind === "saving" && outcome.at === "commands" ? outcome.on === true : policy?.bashEnabled === true;
	const protectionOn = outcome?.kind === "saving" && outcome.at === "protection" ? outcome.on === true : protection?.state === "on";
	// Where a cause stands the switch shows off and can't move: only the person's own choice can.
	const protectionHeld = protection?.state === "off" && protection.cause !== undefined;
	const commands = commandsLineOf(protection, canChange, room?.mode ?? "ask");
	// One change at a time, and none while the room answers.
	const locked = answering || outcome?.kind === "saving" || choosing;
	// A greyed control names the line that says why, for a screen reader.
	const heldReason = answering && atComputer ? waitLineId : undefined;
	// The row shows wherever the room has a folder, and wherever the person turned protection off, folder or not.
	const showsProtection = protection !== undefined && (hasFolder || (protection.state === "off" && protection.cause === undefined));

	const failureLine = (at: Spot) => outcome?.kind === "failed" && outcome.at === at && (
		<span className={outcome.wait ? "settings-row-sub folder-pane-line" : "settings-row-sub folder-pane-line also-allowed-failed"} role={outcome.wait ? "status" : "alert"}>{outcome.text}</span>
	);

	/** A switch row: the label, at most a line under it, and the switch centred on them. */
	const switchRow = (at: Spot, label: string, line: string | null, on: boolean, held: boolean, toggle: (on: boolean) => void) => (
		<label className={at === "protection" ? "settings-row folder-pane-switch-row folder-pane-protection" : "settings-row folder-pane-switch-row"}>
			<span className="settings-row-main">
				<span className="settings-row-label">{label}</span>
				{line && <span className="settings-row-sub">{line}</span>}
				{at === "commands" && room?.shellMissingNote && atComputer && <span className="settings-row-sub workspace-shell-missing">{room.shellMissingNote}</span>}
				{failureLine(at)}
			</span>
			<input className="workspaces-tool-switch" type="checkbox" role="switch" checked={on} disabled={!atComputer || locked || held} aria-describedby={heldReason} onChange={(event) => toggle(event.target.checked)} aria-label={label} />
		</label>
	);

	const folderName = savedRoot ? (savedRoot.displayLabel || savedRoot.basename) : null;
	const locationLine = !savedRoot
		? (atComputer ? NO_FOLDER_YET_LINE : NO_FOLDER_YET)
		// The folder's name; only a page on this computer is sent its path, which the pointer finds on the name.
		: <>
			<span className="workspace-folder-name" title={savedRoot.path || undefined}>{folderName}</span>
			{/* A screen reader hears no tip. */}
			{lookNext && savedRoot.path && <span className="sr-only">{savedRoot.path}</span>}
		</>;
	// While the path is typed, its Use this folder is the row's main button.
	const chooseClass = needsFolder && !(lookNext && typing) ? "rs-btn rs-btn-primary" : "rs-btn";

	let body: ReactNode;
	if (!canManageWorkspace) body = <div className="workspaces-error">{status.exists ? ROOM_NEEDS_ATTENTION : CREATE_ROOM_FIRST}</div>;
	else if (loading) body = <p className="settings-empty">{LOADING}</p>;
	else if (loadFailed || !room) body = (
		<div className="settings-rows">
			<div className="settings-row">
				<span className="settings-row-sub">{FOLDER_LOAD_FAILED}</span>
				<button className="rs-btn" type="button" onClick={() => setLoadAttempt((attempt) => attempt + 1)}>{TRY_AGAIN}</button>
			</div>
		</div>
	);
	// A shared server is no one's own computer: its folders are not offered to rooms.
	else if (sharedServer && !hasFolder) body = (
		<div className="settings-rows">
			<div className="settings-row">
				<div className="settings-row-main">
					<span className="settings-row-label">{NO_FOLDER}</span>
					<span className="settings-row-sub">{SHARED_SERVER_NO_FOLDER}</span>
				</div>
			</div>
		</div>
	);
	else body = (
		<>
			{!atComputer ? <p className="folder-pane-elsewhere">{CHANGEABLE_AT_COMPUTER}</p>
				: answering && <p className="folder-pane-elsewhere" id={waitLineId} role="status">{ROOM_ANSWERING_CHANGE_LINE}</p>}
			<div className="settings-rows">
				<div className="settings-row folder-pane-location">
					<div className="settings-row-main">
						<span className="settings-row-label">{LOCATION}</span>
						<span className="settings-row-sub">{locationLine}</span>
						{/* On a phone the tag says it: "this computer" would read as the phone. */}
						{folderMissing && atComputer && <span className="settings-row-sub folder-pane-not-found">{FOLDER_NOT_FOUND}</span>}
						{failureLine("location")}
					</div>
					{atComputer ? (
						<span className="also-allowed-actions">
							<button className={chooseClass} type="button" disabled={locked} aria-describedby={heldReason} onClick={() => void chooseLocation()}>{choosing ? CHOOSING : needsFolder ? CHOOSE_FOLDER : CHANGE_FOLDER}</button>
							{savedRoot && <button className="rs-btn rs-btn-icon rs-btn-sm also-allowed-cross" type="button" aria-label={STOP_USING_FOLDER} title={STOP_USING_FOLDER} disabled={locked} aria-describedby={heldReason} onClick={() => void stopUsingFolder()}><CloseIcon size={14} /></button>}
						</span>
					) : folderMissing && <span className="settings-row-tag">{NOT_FOUND}</span>}
					{atComputer && typing && (
						<form className="folder-pane-typed" onSubmit={(event) => void submitTypedRoot(event)}>
							<span className="settings-row-sub" role="status">{TYPE_THE_PATH}</span>
							<span className="folder-pane-typed-field">
								<input className="launcher-path-input" type="text" value={typedRoot} placeholder={typedPathExample(/win/i.test(navigator.platform || navigator.userAgent))} aria-label={LOCATION} disabled={locked} onChange={(event) => setTypedRoot(event.target.value)} />
								<button className="rs-btn rs-btn-primary" type="submit" disabled={locked || !typedRoot.trim()} aria-describedby={heldReason}>{USE_THIS_FOLDER}</button>
							</span>
						</form>
					)}
				</div>
				{hasFolder && switchRow("canChange", CAN_CHANGE_FILES, atComputer ? canChangeLineOf(protection, canChange) : null, canChange, false, (on) => void saveFolder("canChange", { canChange: on }))}
				{hasFolder && switchRow("commands", COMMANDS, atComputer ? commands.line : null, commandsOn && !commands.held, commands.held, (on) => void saveFolder("commands", { commands: on }))}
				{/* Like the rows above, its line is the computer's: on a phone, "this computer" would read as the phone. */}
				{showsProtection && switchRow("protection", PROTECTION, atComputer && protection ? protectionLineOf(protection) : null, protectionOn && !protectionHeld, protectionHeld, (on) => void changeProtection(on ? "on" : "off"))}
			</div>
			{/* A shared server has no list. A room with no folder shows only the sites a yes added, so they can be taken back. */}
			{!sharedServer && (
				// Stop using or a first folder starts the list afresh: a folder's Undo line has no place in a room with no folder.
				<AlsoAllowedSection key={hasFolder ? "folder" : "none"} roomId={status.id} roomFolder={hasFolder} atComputer={atComputer} answering={answering} waitLineId={heldReason} readOnlyRoom={!canChangeOf(policy)} folderId={savedRoot?.id ?? null} onRefresh={onRefresh} />
			)}
		</>
	);

	return (
		<div className={outcome?.kind === "saving" ? "room-workspace-section folder-pane-saving" : "room-workspace-section"}>
			<PaneHeader title={FOLDER_PANE_TITLE} line={FOLDER_PANE_LINE} />
			<div className="workspaces-room-body">{body}</div>
			{/* One live line, there before any change, so a screen reader hears each one take: no row shows Saved, and Stop using is said by the row's own line. */}
			<span className="sr-only" role="status">{outcome?.kind === "saved" ? SAVED : outcome?.kind === "removed" ? outcome.text : ""}</span>
		</div>
	);
}

/** One row of the list as the pane draws it. A page away from the computer has no path. */
type ListRow = ({ kind: "folder" } & AlsoAllowedFolderView) | { kind: "site"; host: string; port: number };

/** Where a row's change shows why it failed. The list's own spot is under its heading. */
type ListSpot = "list" | `row:${string}`;

/**
 * The list's last change. Each change saves on its click, one at a time; a
 * removed row's place says what changed, with Undo, until the next change.
 */
type ListOutcome =
	| { kind: "saving"; at: ListSpot }
	| { kind: "saved"; at: ListSpot }
	| { kind: "line"; text: string; refused: boolean }
	| { kind: "failed"; at: ListSpot; text: string; wait: boolean }
	| { kind: "removed"; row: ListRow; index: number; line: string; undoing?: boolean; failure?: { text: string; wait: boolean } };

const rowsOf = (list: AlsoAllowedList): ListRow[] => [...list.folders.map((folder) => ({ kind: "folder" as const, ...folder })), ...list.sites.map((site) => ({ kind: "site" as const, ...site }))];
// A site on a web port is named by its host alone, as its card named it.
const siteName = (site: { host: string; port: number }): string => (site.port === 443 || site.port === 80 ? site.host : `${site.host}:${site.port}`);
const rowName = (row: ListRow): string => (row.kind === "folder" ? row.name : siteName(row));
const rowSpot = (row: ListRow, index: number): ListSpot => `row:${row.kind === "site" ? `site:${row.host}:${row.port}` : `folder:${row.path ?? index}`}`;
/** Whether a listed folder holds another, by the disk spellings the server stores. */
const holds = (parent: string, child: string): boolean => child !== parent && child.startsWith(/[\\/]$/.test(parent) ? parent : `${parent}${child.includes("\\") ? "\\" : "/"}`);
const entryName = (row: ListRow): AlsoAllowedEntryName | null => (row.kind === "site" ? { host: row.host, port: row.port } : row.path ? { path: row.path } : null);

/**
 * The room's Also allowed list: the other folders it can use, and the sites
 * its commands may reach. Each change saves on its click. While the room
 * answers only what narrows works: the crosses and Only allow reading, from
 * the next command and the next file call. A phone sees the names alone.
 * A room with no folder can't add a folder: it shows its sites alone, and
 * nothing when it has none. A list that can't be read says so in any room,
 * since a row that vanished would read as a site taken back. The pane's own
 * line says why a control waits (`waitLineId`), and that a phone can't change it.
 */
function AlsoAllowedSection({ roomId, roomFolder, atComputer, answering, waitLineId, readOnlyRoom, folderId, onRefresh }: { roomId: string; roomFolder: boolean; atComputer: boolean; answering: boolean; waitLineId: string | undefined; readOnlyRoom: boolean; folderId: string | null; onRefresh?: () => void }) {
	const sectionRef = useRef<HTMLElement>(null);
	// Undo in a room with no Add a folder to go on from: the keyboard goes on from the row it put back.
	const [refocus, setRefocus] = useState<ListSpot | null>(null);
	const [list, setList] = useState<AlsoAllowedList | null>(null);
	const [loadFailed, setLoadFailed] = useState(false);
	const [loadAttempt, setLoadAttempt] = useState(0);
	const [outcome, setOutcome] = useState<ListOutcome | null>(null);
	const [choosing, setChoosing] = useState(false);
	const undoRef = useRef<HTMLButtonElement>(null);
	const addRef = useRef<HTMLButtonElement>(null);
	// Each change the person starts counts here, so a quiet read that began before it never puts back what it changed.
	const listChanges = useRef(0);

	useEffect(() => {
		let cancelled = false;
		setList(null);
		setLoadFailed(false);
		setOutcome(null);
		fetchAlsoAllowed(roomId).then((loaded) => { if (!cancelled) setList(loaded); }, () => { if (!cancelled) setLoadFailed(true); });
		return () => { cancelled = true; };
	}, [roomId, loadAttempt]);
	// What each row offers follows the room's folder and whether it can change files: read the list again when either changes, keeping any Undo line. A failed read keeps the rows as they were.
	const firstShape = useRef(true);
	useEffect(() => {
		if (firstShape.current) {
			firstShape.current = false;
			return;
		}
		let cancelled = false;
		const before = listChanges.current;
		fetchAlsoAllowed(roomId).then((loaded) => { if (!cancelled && listChanges.current === before) setList(loaded); }, () => {});
		return () => { cancelled = true; };
	}, [roomId, readOnlyRoom, folderId]);
	// A Saved is a moment, not a state: it goes once it has been heard.
	useEffect(() => {
		if (outcome?.kind !== "saved") return;
		const timer = setTimeout(() => setOutcome((current) => (current === outcome ? null : current)), SAVED_LINE_MS);
		return () => clearTimeout(timer);
	}, [outcome]);
	// A wait the server gave belonged to the room's state when it came; the line above the list says it now.
	useEffect(() => {
		setOutcome((current) => (current?.kind === "failed" && current.wait ? null : current?.kind === "removed" && current.failure?.wait ? { ...current, failure: undefined } : current));
	}, [answering]);
	// The cross took the row's place away: the keyboard goes on from its Undo.
	useEffect(() => {
		if (outcome?.kind === "removed") undoRef.current?.focus();
	}, [outcome]);
	useEffect(() => {
		if (!refocus) return;
		sectionRef.current?.querySelector<HTMLButtonElement>(`[data-spot="${CSS.escape(refocus)}"] .also-allowed-cross`)?.focus();
		setRefocus(null);
	}, [refocus]);

	if (!list) {
		return loadFailed ? (
			<section className="also-allowed" aria-label={ALSO_ALLOWED}>
				<GroupHeader kicker={ALSO_ALLOWED} />
				<div className="settings-rows">
					<div className="settings-row">
						<span className="settings-row-sub">{ALSO_ALLOWED_LOAD_FAILED}</span>
						<button className="rs-btn" type="button" onClick={() => setLoadAttempt((attempt) => attempt + 1)}>{TRY_AGAIN}</button>
					</div>
				</div>
			</section>
		) : null;
	}

	const rows = rowsOf(roomFolder ? list : { ...list, folders: [] });
	// One change at a time. While the room answers, what widens waits; what narrows doesn't.
	const busy = outcome?.kind === "saving" || (outcome?.kind === "removed" && outcome.undoing === true) || choosing;
	const widenHeld = busy || answering;
	const heldReason = waitLineId;

	/**
	 * Runs one change. Only the computer changes the list, and its server is on
	 * the same computer, so a change with no answer that says it saved (lost, or
	 * any error) is judged by reading the list once: `landed` says what the list
	 * as stored shows of what was asked, and a row as it was keeps the failed
	 * save's line. A list that can't be read says so, never a row that may be stale.
	 */
	async function change(pending: ListOutcome, run: () => Promise<{ list: AlsoAllowedList }>, done: (answer: any) => ListOutcome | null, landed: (stored: AlsoAllowedList) => ListOutcome | undefined, failed: (text: string, wait: boolean) => ListOutcome): Promise<boolean> {
		listChanges.current += 1;
		setOutcome(pending);
		let refusal: unknown;
		try {
			const answer = await run();
			setList(answer.list);
			setOutcome(done(answer));
			return true;
		} catch (e) {
			refusal = e;
		}
		let stored: AlsoAllowedList;
		try {
			stored = await fetchAlsoAllowed(roomId);
		} catch {
			setOutcome(null);
			setList(null);
			setLoadFailed(true);
			return false;
		}
		setList(stored);
		const saved = landed(stored);
		if (saved) {
			setOutcome(saved);
			return true;
		}
		const wait = (refusal as { code?: unknown } | null)?.code === "active_turn_in_flight";
		// The room started answering, which this page hadn't seen: a fresh status greys what waits.
		if (wait) onRefresh?.();
		setOutcome(failed(wait ? ROOM_ANSWERING_CHANGE_LINE : CHANGE_SAVE_FAILED, wait));
		return false;
	}
	const failedAt = (at: ListSpot) => (text: string, wait: boolean): ListOutcome => ({ kind: "failed", at, text, wait });

	async function addFolder(): Promise<void> {
		setChoosing(true);
		const before = new Set(list?.folders.map((folder) => folder.path));
		// The new row, saved: the one the list holds that it didn't before.
		const added = (folders: AlsoAllowedFolderView[]): ListOutcome | undefined => {
			const index = folders.findIndex((folder) => !before.has(folder.path));
			return index >= 0 ? { kind: "saved", at: rowSpot({ kind: "folder", ...folders[index] }, index) } : undefined;
		};
		await change({ kind: "saving", at: "list" }, () => addAlsoAllowedFolder(roomId), (answer: AlsoAllowedAddResponse) => {
			if (answer.state === "already" || answer.state === "refused") return { kind: "line", text: answer.line, refused: answer.state === "refused" };
			return answer.state === "added" ? added(answer.list.folders) ?? null : null;
		}, (stored) => added(stored.folders), failedAt("list"));
		setChoosing(false);
	}

	function setAccess(row: ListRow, index: number, access: "read" | "write"): void {
		if (row.kind !== "folder" || !row.path) return;
		const folder = row.path;
		const at = rowSpot(row, index);
		const saved: ListOutcome = { kind: "saved", at };
		void change({ kind: "saving", at }, () => setAlsoAllowedAccess(roomId, folder, access), () => saved, (stored) => (stored.folders.find((each) => each.path === folder)?.access === access ? saved : undefined), failedAt(at));
	}

	function remove(row: ListRow, index: number): void {
		const named = entryName(row);
		if (!named) return;
		const at = rowSpot(row, index);
		const removed = (through: string | undefined): ListOutcome => ({ kind: "removed", row, index, line: row.kind === "site" ? siteRemovedLine(siteName(row)) : through ? folderStillReadLine(row.name, through) : folderRemovedLine(row.name) });
		void change({ kind: "saving", at }, () => removeAlsoAllowed(roomId, named), (answer: AlsoAllowedRemoveResponse) => removed(answer.stillReadThrough), (stored) => {
			if (rowsOf(stored).some((each) => rowSpot(each, -1) === rowSpot(row, -1))) return undefined;
			// The server names the row that still lets the room read it; read back, it is the listed row that holds this one.
			const through = row.kind === "folder" && row.path ? stored.folders.find((each) => each.path && holds(each.path, row.path as string)) : undefined;
			return removed(through?.name);
		}, failedAt(at));
	}

	/** Undo keeps the cross's line until it lands: a failed one shows why under it, with Undo to try again. */
	function undo(removed: Extract<ListOutcome, { kind: "removed" }>): void {
		const named = entryName(removed.row);
		if (!named) return;
		const shown = { ...removed, undoing: false, failure: undefined };
		const saved: ListOutcome = { kind: "saved", at: rowSpot(removed.row, removed.index) };
		const back = (stored: AlsoAllowedList) => (rowsOf(stored).some((each) => rowSpot(each, -1) === rowSpot(removed.row, -1)) ? saved : undefined);
		void change({ ...shown, undoing: true }, () => restoreAlsoAllowed(roomId, named), () => saved, back, (text, wait) => ({ ...shown, failure: { text, wait } })).then((done) => {
			if (!done) return;
			if (addRef.current) addRef.current.focus();
			else setRefocus(saved.at);
		});
	}

	const failureText = ({ text, wait }: { text: string; wait: boolean }) => <span className={wait ? "settings-row-sub" : "settings-row-sub also-allowed-failed"} role={wait ? "status" : "alert"}>{text}</span>;
	const failureLine = (at: ListSpot) => outcome?.kind === "failed" && outcome.at === at && failureText(outcome);

	const drawn: ReactNode[] = rows.map((row, index) => {
		const at = rowSpot(row, index);
		const name = rowName(row);
		const canChange = row.kind === "folder" && row.access === "write" && !readOnlyRoom;
		return (
			<li className="also-allowed-row" key={at} data-spot={at}>
				<span className="also-allowed-icon">{row.kind === "folder" ? <FolderIcon /> : <GlobeIcon />}</span>
				<span className="settings-row-main">
					{/* A folder's path, which only the computer is sent, is on its name for the pointer. */}
					<span className="settings-row-label also-allowed-name" title={row.kind === "folder" ? row.path || undefined : undefined}>{name}</span>
					<span className="settings-row-sub also-allowed-access">{row.kind === "site" ? SITE : canChange ? CAN_READ_AND_CHANGE : CAN_READ}</span>
					{failureLine(at)}
				</span>
				{atComputer && (
					<span className="also-allowed-actions">
						{row.kind === "folder" && row.access === "read" && row.canAllowChanges && <button className="rs-btn" type="button" disabled={widenHeld} aria-describedby={heldReason} onClick={() => setAccess(row, index, "write")}>{ALLOW_CHANGES}</button>}
						{canChange && <button className="rs-btn" type="button" disabled={busy} onClick={() => setAccess(row, index, "read")}>{ONLY_ALLOW_READING}</button>}
						<button className="rs-btn rs-btn-icon rs-btn-sm also-allowed-cross" type="button" aria-label={`${REMOVE_FROM_LIST}: ${name}`} title={REMOVE_FROM_LIST} disabled={busy} onClick={() => remove(row, index)}><CloseIcon size={14} /></button>
					</span>
				)}
			</li>
		);
	});
	// Right after the cross, the row's place says what changed, with Undo.
	if (outcome?.kind === "removed") {
		const removed = outcome;
		drawn.splice(removed.index, 0, (
			<li className="also-allowed-row also-allowed-removed" key="removed">
				<span className="settings-row-main">
					<span className="settings-row-sub">{removed.line}</span>
					{removed.failure && failureText(removed.failure)}
				</span>
				<span className="also-allowed-actions">
					<button ref={undoRef} className="rs-btn" type="button" disabled={widenHeld} aria-describedby={heldReason} onClick={() => undo(removed)}>{UNDO}</button>
				</span>
			</li>
		));
	}
	if (!roomFolder && drawn.length === 0) return null;

	return (
		<section ref={sectionRef} className={busy ? "also-allowed also-allowed-saving" : "also-allowed"} aria-label={ALSO_ALLOWED}>
			<GroupHeader
				kicker={ALSO_ALLOWED}
				// The line speaks of folders, and only a room with a folder can add one.
				line={atComputer && roomFolder ? ALSO_ALLOWED_LINE : undefined}
				actions={atComputer && roomFolder && (
					<button ref={addRef} className="rs-btn also-allowed-add" type="button" disabled={widenHeld} aria-describedby={heldReason} onClick={() => void addFolder()}><PlusIcon />{choosing ? CHOOSING : ADD_A_FOLDER}</button>
				)}
			/>
			{outcome?.kind === "line" && <span className={outcome.refused ? "settings-row-sub also-allowed-failed" : "settings-row-sub also-allowed-line"} role={outcome.refused ? "alert" : "status"}>{outcome.text}</span>}
			{failureLine("list")}
			{drawn.length > 0 ? <ul className="settings-rows also-allowed-list">{drawn}</ul> : !atComputer && <p className="also-allowed-elsewhere">{NO_OTHER_FOLDERS_OR_SITES}</p>}
			{/* One live line, there before any change, so a screen reader hears each one take. */}
			<span className="sr-only" role="status">{outcome?.kind === "saved" ? SAVED : outcome?.kind === "removed" ? outcome.line : ""}</span>
		</section>
	);
}
