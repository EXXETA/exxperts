import { useEffect, useRef, useState } from "react";
import { ALLOW, CANCEL, CHANGEABLE_AT_COMPUTER, commandModeOf, type CommandMode, COMMANDS_NO_PROTECTION_REACH, COMMANDS_UNPROTECTED_REACH, FREE_CONFIRM_BODY, FREE_CONFIRM_TITLE, MODE_LINES_PROTECTED, MODE_LINES_UNPROTECTED, MODE_NAMES, MODES_PROTECTED_LINE, MODES_PROTECTED_STAY_LINE, RUN_WITHOUT_ASKING, RUN_WITHOUT_ASKING_BODY, RUN_WITHOUT_ASKING_TITLE } from "../../../web-server/src/room-box/card-text";
import { fetchPersistentRoomBashSettings, type PersistentRoomBashSettingsResponse, updatePersistentRoomBashSettings } from "../persistent-room-management-api";
import { useRemoteClientContext } from "../remote-client-context";
import type { PersistentAgentId, PersistentRoomProtection } from "../types";
import { confirmDialog } from "./confirm-dialog";

/** What the chip last read: the stored mode, and the protection it was read in, which a write is given in. */
type ChipRead = { mode: CommandMode; protection: PersistentRoomProtection };

/** The mode as the server stored it. No protection in the answer (a shared or older server): nothing the chip can show or write. */
function chipReadOf(response: PersistentRoomBashSettingsResponse): ChipRead | null {
	if (!response.protection) return null;
	return { mode: commandModeOf(response.settings, response.protection.state === "on"), protection: response.protection };
}

/** The selector's items for the room's protection now, each with its line, and the line under them; a phone's leaves out the asking, which only the computer does. */
function selectorOf(protection: PersistentRoomProtection, remote: boolean): { items: Array<{ mode: CommandMode; line: string }>; note: string } {
	if (protection.state === "on") return { items: (["ask", "semi", "auto"] as const).map((mode) => ({ mode, line: MODE_LINES_PROTECTED[mode] })), note: remote ? MODES_PROTECTED_STAY_LINE : MODES_PROTECTED_LINE };
	return {
		items: (["ask", "auto"] as const).map((mode) => ({ mode, line: MODE_LINES_UNPROTECTED[mode] })),
		note: protection.cause === "computer" ? COMMANDS_NO_PROTECTION_REACH : COMMANDS_UNPROTECTED_REACH,
	};
}

/**
 * The room's command-mode chip: under the message box beside the model
 * control, or inside the box before Remember on the phone. Visible only in
 * rooms whose workspace policy has Bash enabled, it names the room's mode:
 * Ask, Semi or Auto in a protected room, Ask or Auto in one without
 * protection. Clicking it opens the selector, upwards: each mode with what it
 * means, and a line under them. A choice applies at once. Auto asks first:
 * while protection is off its commands reach every file the person can, also
 * after they leave the room, and in either the room's files could reach any
 * public website.
 * Leaving it asks nothing.
 *
 * Staleness: the chip reads again on a room switch, when the settings window
 * closes, when its selector opens (the moment a stale answer would misdirect a
 * click), on returning to the page and when the room's connection comes back
 * (`connected`), since protection can be turned off in another window meanwhile.
 * The protection it read decides the selector and goes with each write.
 *
 * It shows only a mode the server returned: none before the first good read,
 * none after a failed one, and none after a write whose answer didn't come,
 * until a read says what is stored. The server's refusal of a write with no
 * protection backs it.
 *
 * On a remote client the chip still tells the truth, but the items are
 * disabled: the PUT is loopback-only on the server, so offering the switch
 * would only manufacture an error.
 */
export function BashModeChip({ agentId, bashEnabled, settingsOpen = false, connected = true }: {
	agentId: PersistentAgentId;
	bashEnabled: boolean;
	settingsOpen?: boolean;
	/** The room's live connection: its coming back reads the room again. */
	connected?: boolean;
}) {
	const [read, setRead] = useState<ChipRead | null>(null);
	const [open, setOpen] = useState(false);
	const [saving, setSaving] = useState(false);
	const [saveError, setSaveError] = useState<string | null>(null);
	const [refetchTick, setRefetchTick] = useState(0);
	const rootRef = useRef<HTMLDivElement | null>(null);
	// While a question is open, the selector stays open under it: a click on its backdrop or its Escape is the question's.
	const confirmingRef = useRef(false);
	// The room this chip shows, or null once it is gone: a question answered after that changes nothing.
	const shownRoomRef = useRef<PersistentAgentId | null>(agentId);
	useEffect(() => {
		shownRoomRef.current = agentId;
		return () => { shownRoomRef.current = null; };
	}, [agentId]);
	const remoteClient = useRemoteClientContext();

	// Load the stored mode. Reruns when the room changes, when a refetch is
	// requested (selector open, settings-window close), and only while the chip
	// is actually shown: a room without commands never fetches.
	useEffect(() => {
		if (!bashEnabled) return;
		let cancelled = false;
		void fetchPersistentRoomBashSettings(agentId)
			.then((response) => {
				if (!cancelled) setRead(chipReadOf(response));
			})
			// A failed read is unknown: no mode shows until a read succeeds.
			.catch(() => {
				if (!cancelled) setRead(null);
			});
		return () => { cancelled = true; };
	}, [agentId, bashEnabled, refetchTick]);

	// Room switch: drop any open selector and show no mode until the new room's answer lands, so the previous room's mode never shows on it.
	useEffect(() => {
		setOpen(false);
		setRead(null);
		setSaveError(null);
	}, [agentId]);

	// Settings-window close is a moment the stored value may have changed.
	const prevSettingsOpenRef = useRef(settingsOpen);
	useEffect(() => {
		const wasOpen = prevSettingsOpenRef.current;
		prevSettingsOpenRef.current = settingsOpen;
		if (wasOpen && !settingsOpen) setRefetchTick((tick) => tick + 1);
	}, [settingsOpen]);

	const prevConnectedRef = useRef(connected);
	useEffect(() => {
		const wasConnected = prevConnectedRef.current;
		prevConnectedRef.current = connected;
		if (!wasConnected && connected) setRefetchTick((tick) => tick + 1);
	}, [connected]);

	useEffect(() => {
		if (!bashEnabled) return;
		const reread = () => { if (document.visibilityState === "visible") setRefetchTick((tick) => tick + 1); };
		window.addEventListener("focus", reread);
		document.addEventListener("visibilitychange", reread);
		return () => {
			window.removeEventListener("focus", reread);
			document.removeEventListener("visibilitychange", reread);
		};
	}, [bashEnabled]);

	useEffect(() => {
		if (!open) return;
		function onPointerDown(event: PointerEvent) {
			if (confirmingRef.current) return;
			if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false);
		}
		function onKeyDown(event: KeyboardEvent) {
			if (event.key === "Escape" && !confirmingRef.current) setOpen(false);
		}
		document.addEventListener("pointerdown", onPointerDown);
		// Capture: ahead of the shared Escape listener (use-escape-key.ts), which answers the question first.
		document.addEventListener("keydown", onKeyDown, true);
		return () => {
			document.removeEventListener("pointerdown", onPointerDown);
			document.removeEventListener("keydown", onKeyDown, true);
		};
	}, [open]);

	if (!bashEnabled || !read) return null;
	const shown = read;

	function toggleMenu(): void {
		setOpen((value) => {
			const next = !value;
			if (next) {
				// Opening is when staleness matters: another window may have changed the mode since it was read.
				setSaveError(null);
				setRefetchTick((tick) => tick + 1);
			}
			return next;
		});
	}

	/** The question before a mode, if it has one: Auto, in the words for the room's protection. True to go on. */
	async function confirmed(next: CommandMode, givenIn: PersistentRoomProtection): Promise<boolean> {
		const question = next !== "auto" ? null
			: givenIn.state === "on" ? { title: FREE_CONFIRM_TITLE, body: FREE_CONFIRM_BODY, confirmLabel: ALLOW }
			: { title: RUN_WITHOUT_ASKING_TITLE, body: RUN_WITHOUT_ASKING_BODY, confirmLabel: RUN_WITHOUT_ASKING };
		if (!question) return true;
		confirmingRef.current = true;
		try {
			return await confirmDialog({ ...question, cancelLabel: CANCEL, danger: true });
		} finally {
			confirmingRef.current = false;
		}
	}

	async function select(next: CommandMode): Promise<void> {
		// `saving` also guards the rapid-double-click race: the second click returns before a second PUT can leave.
		if (saving || confirmingRef.current || remoteClient.remote) return;
		if (next === shown.mode) {
			setOpen(false);
			return;
		}
		// Given in the protection it was read in: if that changed meanwhile, the server refuses the write.
		const givenIn = shown.protection;
		// A room left while the question was open keeps its own mode.
		if (!(await confirmed(next, givenIn)) || shownRoomRef.current !== agentId) return;
		setSaving(true);
		setSaveError(null);
		try {
			const response = await updatePersistentRoomBashSettings(agentId, { autoApprove: next !== "ask", ...(next === "auto" && givenIn.state === "on" ? { free: true } : {}), protection: givenIn });
			setRead(chipReadOf(response));
			setOpen(false);
		} catch (e) {
			// What is stored is unknown until a read says: no mode shows meanwhile. The selector comes back
			// open with the failure named, so a retry is one click, given in the protection read again.
			setSaveError((e as Error).message || "Failed to save bash approval setting.");
			setRead(null);
			setRefetchTick((tick) => tick + 1);
		} finally {
			setSaving(false);
		}
	}

	const optionsDisabled = saving || remoteClient.remote;
	const selector = selectorOf(shown.protection, remoteClient.remote);
	const shownLine = selector.items.find((item) => item.mode === shown.mode)?.line ?? MODE_LINES_PROTECTED[shown.mode];

	return (
		<div className="bash-mode-chip-anchor" ref={rootRef}>
			<button
				type="button"
				className={`bash-mode-chip is-${shown.mode}`}
				title={remoteClient.remote ? shownLine : `${shownLine} Click to change.`}
				aria-label={`Commands: ${MODE_NAMES[shown.mode]}`}
				aria-haspopup="menu"
				aria-expanded={open}
				onClick={toggleMenu}
			>
				<span className="bash-mode-chip-label">{MODE_NAMES[shown.mode]}</span>
			</button>
			{open && (
				<div className={`bash-mode-menu${remoteClient.remote ? " is-read-only" : ""}`} role="menu" aria-label="Commands">
					{selector.items.map((item) => (
						<button
							key={item.mode}
							type="button"
							role="menuitemradio"
							className={`bash-mode-option${item.mode === shown.mode ? " is-current" : ""}`}
							aria-checked={item.mode === shown.mode}
							disabled={optionsDisabled}
							onClick={() => void select(item.mode)}
						>
							<span className="bash-mode-option-text">
								<span className="bash-mode-option-name">{MODE_NAMES[item.mode]}</span>
								<span className="bash-mode-option-line">{item.line}</span>
							</span>
						</button>
					))}
					<p className="bash-mode-menu-line">{selector.note}</p>
					{remoteClient.remote && <p className="bash-mode-menu-note">{CHANGEABLE_AT_COMPUTER}</p>}
					{saveError && <p className="bash-mode-menu-error">{saveError}</p>}
				</div>
			)}
		</div>
	);
}
