import { useEffect, useRef, useState } from "react";
import { ROOM_ORDER_MODES, type RoomOrderMode } from "../../../web-server/src/room-order";
import { useRemoteClientContext } from "../remote-client-context";
import type { HomeRoomOrder } from "../home-room-order";
import type { HomeRoomOrderFailedSave } from "../use-home-room-order";
import { ROOM_ARRANGE_DONE_FAILED, ROOM_ARRANGE_FAILED_AWAY, ROOM_ARRANGE_HINT_POINTER, ROOM_ARRANGE_HINT_TOUCH } from "../home-room-arrange";
import { isTouchScreen } from "../platform";

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
 * arrange line instead: what to do (where a pointer hovers, a drag or the
 * keyboard; on a touch screen, a held drag or the cards' arrows), then Done
 * in Arrange's place, and a failed Done's line under them. Done reads
 * "Saving…" and is off while its write is in flight. What Done keeps, and
 * what Escape and the ways out of Home do, is the home screen's (landing.tsx,
 * Landing); the line only draws it. The line is drawn whatever the room
 * count: a room gone elsewhere mid-arrange must not take Done with it.
 *
 * A failed arrangement is said in arranging's own words, never the server's
 * (home-room-arrange.ts): while arranging, only once this arranging's own
 * Done has failed ("try again" is about that Done); at rest, whichever save
 * it was, the next visit included. A menu choice's failure keeps the words
 * the controller kept, and is shown at rest only. At rest, where a folder
 * sits in the saved order's place, the line that says to remove it wins:
 * no try again can succeed before that. Not while arranging, where its "shown
 * A to Z" is untrue of the cards being moved.
 */
export interface RoomSortArranging {
	onDone: () => void;
	/** This arranging's Done failed, and no Done or Arrange has started since. */
	doneFailed: boolean;
}

export function RoomSortControl({ order, saving, failedSave, onChoose, onArrange, arranging }: {
	order: HomeRoomOrder;
	saving: boolean;
	failedSave: HomeRoomOrderFailedSave | null;
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
	const folderInTheWay = saveBlocked && problem !== null;
	const failedLine = !failedSave || readOnly || folderInTheWay ? null : failedSave.kind === "arrangement" ? ROOM_ARRANGE_FAILED_AWAY : failedSave.sentence;
	const line = failedLine ?? problem;

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
					<span className="room-arrange-hint" id={ROOM_ARRANGE_HINT_ID}>{isTouchScreen() ? ROOM_ARRANGE_HINT_TOUCH : ROOM_ARRANGE_HINT_POINTER}</span>
					<button type="button" className="rs-btn rs-btn-quiet rs-btn-sm room-sort-btn room-arrange-done" disabled={saving} onClick={arranging.onDone}>{saving ? "Saving…" : "Done"}</button>
				</div>
				{arranging.doneFailed && <p className="room-sort-problem room-sort-save-error" role="alert">{ROOM_ARRANGE_DONE_FAILED}</p>}
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
						className="rs-btn rs-btn-quiet rs-btn-sm room-sort-btn"
						aria-haspopup="menu"
						aria-expanded={open}
						title="Choose the order of your rooms"
						onClick={() => setOpen((value) => !value)}
					>
						Sort: {ROOM_ORDER_LABELS[mode]} <span className="room-sort-caret" aria-hidden="true">▾</span>
					</button>
				)}
				{mode === "custom" && !readOnly && (
					<button type="button" className="rs-btn rs-btn-quiet rs-btn-sm room-sort-btn room-sort-arrange" disabled={saving} title="Move your rooms into the order you want" onClick={onArrange}>Arrange</button>
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
					{line && <p className={`room-sort-menu-error${failedLine ? "" : " is-note"}`} role={failedLine ? "alert" : "status"}>{line}</p>}
				</div>
			)}
			{line && !(open && !readOnly) && <p className={`room-sort-problem${failedLine ? " room-sort-save-error" : ""}`} role={failedLine ? "alert" : "status"}>{line}</p>}
		</div>
	);
}
