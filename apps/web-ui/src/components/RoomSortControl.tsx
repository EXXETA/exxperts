import { useEffect, useRef, useState } from "react";
import { ROOM_ORDER_MODES, type RoomOrderMode } from "../../../web-server/src/room-order";
import { useRemoteClientContext } from "../remote-client-context";
import type { HomeRoomOrder } from "../home-room-order";

/** What each order is called, in the control and in its menu. Total over the modes: a new mode does not compile without its name. */
export const ROOM_ORDER_LABELS: Record<RoomOrderMode, string> = {
	recent: "Last used",
	"name-asc": "Name A→Z",
	"name-desc": "Name Z→A",
	custom: "Custom",
};

/** The arrange line's hint: every card in arrange mode is described by it (aria-describedby), so a screen reader hears how to move one. */
export const ROOM_ARRANGE_HINT_ID = "room-arrange-hint";

/** Fewer rooms than this and there is nothing to order: the control is not shown. */
export const ROOM_SORT_MIN_ROOMS = 2;

/**
 * The home screen's order, as one quiet line of text at the right of the title:
 * it says which order the rooms are in, and a click offers the others. It
 * draws what it is given and owns nothing but its menu being open: the order,
 * the save in flight and a failed save's sentence belong to the home screen's
 * controller (home-room-order.ts), which outlives this control. A choice is
 * saved first and shown after: the rooms move only once the server holds the
 * new order. A save that fails leaves the rooms where they are and says so,
 * also on a later arrival when the home screen was left meanwhile.
 *
 * A saved order the app could not use (`unreadable`, the server's words for
 * what is wrong with it) or could not load is said too; the rooms are shown
 * A to Z meanwhile. Choosing an order is the way out, except where the server
 * says a save would be refused (`saveBlocked`: a folder sits where the file
 * belongs); then the sentence names that remedy instead.
 *
 * Whatever went wrong is ONE line, never two stacked: a failed save's
 * sentence (the newest news) or else the problem with the saved order. It
 * sits under the control, and in the menu while the menu is open (the menu
 * covers that place, and there the retry is one click); Escape and a click
 * outside close the menu even while a save is in flight.
 *
 * A read-only device sees the order as plain text: the save would be refused,
 * and a menu that can only fail is not offered.
 *
 * The menu holds the four orders and nothing else. Arrange mode is entered
 * from beside the control, by an "Arrange" link drawn only while the order
 * on screen is Custom: it edits that order, so it sits next to it, never in
 * the list of orders. The first time, with nothing arranged yet, choosing
 * Custom opens arrange mode itself (the home screen decides that), so the
 * link is never needed before there is something to change.
 *
 * While the rooms are being arranged (`arranging`), the control is the
 * arrange line instead: what to do (ONE sentence for every device: a drag
 * is the mouse's or a long press's, the arrow keys are the keyboard's), then
 * the app's standard pair as at the end of a form (Cancel outlined, Save
 * filled), and a failed save's sentence under them. Save is one write; Save and Cancel are disabled only
 * while that write is in flight (a write already sent cannot be cancelled,
 * and closing the line under it would say the previous order is back when
 * it may not be). Whether there is anything to save, and what happens on
 * Save and Cancel, is the home screen's (App.tsx, Landing); the line only
 * draws it. The line is drawn whatever the room count: a room gone elsewhere
 * mid-arrange must not take Save and Cancel with it.
 */
export interface RoomSortArranging {
	onSave: () => void;
	onCancel: () => void;
}

export function RoomSortControl({ order, saving, saveError, onChoose, onArrange, arranging }: {
	order: HomeRoomOrder;
	saving: boolean;
	saveError: string | null;
	/** Resolves true when what was chosen is what is saved (or, for Custom with nothing arranged yet, when arrange mode opened). */
	onChoose: (mode: RoomOrderMode) => Promise<boolean>;
	/** The "Arrange" link beside the control (Custom only): arrange mode opens on the order on screen. */
	onArrange: () => void;
	arranging: RoomSortArranging | null;
}) {
	const { mode, unreadable, saveBlocked, loadFailed } = order;
	const [open, setOpen] = useState(false);
	// What `select` reads after its await: whether the menu it was started from
	// is still open. State captured before the await would always say yes.
	const openRef = useRef(false);
	openRef.current = open;
	const rootRef = useRef<HTMLDivElement | null>(null);
	const buttonRef = useRef<HTMLButtonElement | null>(null);
	const remoteClient = useRemoteClientContext();
	const readOnly = remoteClient.remote && remoteClient.capability === "read-only";
	const wayOut = readOnly ? "" : saveBlocked ? " Remove that folder, then choose an order." : " Choosing an order saves a new one.";
	const problem: string | null = unreadable
		? `The saved order could not be used (${unreadable}), so your rooms are shown A to Z.${wayOut}`
		: loadFailed
			? "The saved order could not be loaded, so your rooms are shown A to Z."
			: null;
	const failedSave = saveError && !readOnly ? saveError : null;
	const line = failedSave ?? problem;

	useEffect(() => {
		if (!open) return;
		function onPointerDown(event: PointerEvent) {
			if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false);
		}
		function onKeyDown(event: KeyboardEvent) {
			if (event.key !== "Escape") return;
			setOpen(false);
			buttonRef.current?.focus();
		}
		document.addEventListener("pointerdown", onPointerDown);
		document.addEventListener("keydown", onKeyDown);
		return () => {
			document.removeEventListener("pointerdown", onPointerDown);
			document.removeEventListener("keydown", onKeyDown);
		};
	}, [open]);

	async function select(next: RoomOrderMode): Promise<void> {
		if (!(await onChoose(next))) return;
		// Escape and a click outside close the menu even while a save is in
		// flight; the user is somewhere else by then, and focus stays with them.
		if (!openRef.current) return;
		setOpen(false);
		buttonRef.current?.focus();
	}

	if (arranging) {
		return (
			<div className="room-sort room-arrange-line" ref={rootRef}>
				<div className="room-arrange-line-row">
					<span className="room-arrange-hint" id={ROOM_ARRANGE_HINT_ID}>Drag rooms into order, or use tab + arrow keys.</span>
					<span className="room-arrange-buttons">
						<button type="button" className="rs-btn room-arrange-cancel" disabled={saving} onClick={arranging.onCancel}>Cancel</button>
						<button type="button" className="rs-btn rs-btn-primary room-arrange-save" disabled={saving} onClick={arranging.onSave}>{saving ? "Saving…" : "Save"}</button>
					</span>
				</div>
				{saveError && <p className="room-sort-problem room-sort-save-error" role="alert">{saveError}</p>}
			</div>
		);
	}

	return (
		<div className="room-sort" ref={rootRef}>
			<div className="room-sort-row">
				{readOnly ? (
					<span className="room-sort-current">Sort: {ROOM_ORDER_LABELS[mode]}</span>
				) : (
					<button
						type="button"
						ref={buttonRef}
						className="room-sort-btn"
						aria-haspopup="menu"
						aria-expanded={open}
						title="Choose the order of your rooms"
						onClick={() => setOpen((value) => !value)}
					>
						Sort: {ROOM_ORDER_LABELS[mode]} <span className="room-sort-caret" aria-hidden="true">▾</span>
					</button>
				)}
				{mode === "custom" && !readOnly && (
					<button type="button" className="room-sort-btn room-sort-arrange" disabled={saving} title="Move your rooms into the order you want" onClick={onArrange}>Arrange</button>
				)}
			</div>
			{open && !readOnly && (
				<div className="room-sort-menu" role="menu" aria-label="Order of your rooms">
					{ROOM_ORDER_MODES.map((option) => (
						<button
							key={option}
							type="button"
							role="menuitemradio"
							className={`room-sort-option${option === mode ? " is-current" : ""}`}
							aria-checked={option === mode}
							disabled={saving}
							onClick={() => void select(option)}
						>{ROOM_ORDER_LABELS[option]}</button>
					))}
					{line && <p className={`room-sort-menu-error${failedSave ? "" : " is-note"}`} role={failedSave ? "alert" : "status"}>{line}</p>}
				</div>
			)}
			{line && !(open && !readOnly) && <p className={`room-sort-problem${failedSave ? " room-sort-save-error" : ""}`} role={failedSave ? "alert" : "status"}>{line}</p>}
		</div>
	);
}
