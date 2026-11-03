import { Fragment, useEffect, useRef, useSyncExternalStore } from "react";
import { chordHeld, chordWords, isMacPlatform, isTouchScreen } from "../platform";

/**
 * Every key the app has, as this computer writes it: ⌘ on a Mac, Ctrl
 * elsewhere. A row names only a key that works today; a new key adds its row
 * here with its code. Each key is its own cap; keys that do the same are
 * alternatives ("or"), keys for different actions are listed in the order the
 * row names the actions.
 */
type KeyRow = { what: string; keys: string[]; or?: boolean };
/** The keys in headed sections: those that work on every screen, then those inside a room. */
function keySections(): Array<{ heading: string; rows: KeyRow[] }> {
	const enter = isMacPlatform() ? "↵" : "Enter";
	const sendNow = isMacPlatform() ? "⌘↵" : "Ctrl+Enter";
	return [
		{
			heading: "General",
			rows: [
				{ what: "Shortcuts (this list)", keys: [chordWords("/")] },
				{ what: "Settings", keys: [chordWords(",")] },
			],
		},
		{
			heading: "In rooms",
			rows: [
				{ what: "Send, or queue it while the room answers", keys: [enter] },
				{ what: "New line", keys: [isMacPlatform() ? "⇧↵" : "Shift+Enter"] },
				{ what: "Send now, stopping the answer", keys: [sendNow] },
				{ what: "Stop the answer", keys: ["Esc"] },
				{ what: "Allow a waiting step", keys: [enter] },
				{ what: "Deny a waiting step", keys: ["Esc"] },
				{ what: "Open or close a card or a row you reached with Tab", keys: [enter, "Space"], or: true },
				{ what: "This room's settings", keys: [chordWords(",", true)] },
				{ what: "Diagram viewer: zoom in, zoom out, actual size, fit, close", keys: ["+", "−", "0", "F", "Esc"] },
			],
		},
	];
}

// Windows with keys of their own: a confirm dialog's Enter, a list's arrows,
// a popover or a menu with its own keys (Reasoning effort, the room order),
// the diagram viewer's letters. The chord does not open the list over them.
// Over anything else (the gear menu, Settings, a full screen) it opens, and
// the window takes every Esc before what is behind it (KeysList).
const TAKES_KEYS = [
	'[role="alertdialog"]',
	'[role="listbox"]',
	'[role="dialog"]:not([aria-modal="true"])',
	'[role="menu"]:not(.sidebar-config-menu, .sidebar-config-menu *)',
	".mermaid-viewer-overlay",
].join(", ");

// One window for the whole page: Help › Shortcuts and the chord both open it.
let shown = false;
// A key from a hardware keyboard has been pressed since the page loaded: on a touch screen, Help offers Shortcuts from then on.
let keyboardUsed = false;
const listeners = new Set<() => void>();
const notify = () => {
	for (const listener of [...listeners]) listener();
};
function setShown(next: boolean): void {
	if (shown === next) return;
	shown = next;
	notify();
}
const subscribe = (listener: () => void) => {
	listeners.add(listener);
	return () => listeners.delete(listener);
};
const isShown = () => shown;
const isKeyboardUsed = () => keyboardUsed;

// Keys an on-screen keyboard does not send: Esc, the arrows, and Shift, Alt,
// Ctrl or ⌘ pressed alone (as before a capital letter on a hardware keyboard).
const HARDWARE_ONLY_KEYS = new Set(["Escape", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Shift", "Alt", "Control", "Meta"]);

/**
 * Whether a key press came from a hardware keyboard. An on-screen keyboard
 * fires key presses too, but only into the field it types in, and it has no
 * ⌘, Ctrl, Esc or arrows: typing a message on a phone is not a keyboard.
 * Letters typed into a field cannot tell the two apart, so they never count.
 */
function fromHardwareKeyboard(event: KeyboardEvent): boolean {
	if (event.isComposing) return false;
	if (event.metaKey || event.ctrlKey || HARDWARE_ONLY_KEYS.has(event.key)) return true;
	const target = event.target;
	return !(target instanceof HTMLElement && (target.isContentEditable || target.matches("input, textarea, select")));
}

/**
 * Whether Help offers Shortcuts: always with a mouse; on a touch screen, whose
 * keys most people cannot press, only once a hardware keyboard is used, as on
 * a tablet with one.
 */
export function useShortcutsOffered(): boolean {
	const used = useSyncExternalStore(subscribe, isKeyboardUsed, isKeyboardUsed);
	return used || !isTouchScreen();
}

/** Opens the Shortcuts window (Help › Shortcuts in the gear menu). */
export function openShortcuts(): void {
	setShown(true);
}

/**
 * The Shortcuts window, mounted once for the whole app. ⌘/ on a Mac, Ctrl+/
 * elsewhere, opens it from any screen. The key is matched by the character it
 * types, since / needs Shift on German and Spanish keyboards. Esc or the same
 * key closes it, and the focus goes back where it was.
 *
 * While it is open it owns Esc and the focus, whatever is behind it: Esc is
 * taken in the window's capture phase, before any other listener (several
 * screens listen for Esc on their own, outside the shared Esc stack), and a
 * step that asks behind it cannot take the focus, or the next Esc would
 * answer that question unseen. Only a confirm dialog draws above it, and its
 * keys and focus stay its own.
 */
export function KeysList() {
	const open = useSyncExternalStore(subscribe, isShown, isShown);
	const closeRef = useRef<HTMLButtonElement>(null);
	const dialogRef = useRef<HTMLDivElement>(null);
	useEffect(() => {
		const onKey = (event: KeyboardEvent) => {
			if (!chordHeld(event) || event.altKey || event.key !== "/" || event.repeat || event.isComposing) return;
			if (!shown && document.querySelector(TAKES_KEYS)) return;
			event.preventDefault();
			setShown(!shown);
		};
		const noteKeyboard = (event: KeyboardEvent) => {
			if (keyboardUsed || !fromHardwareKeyboard(event)) return;
			keyboardUsed = true;
			notify();
		};
		document.addEventListener("keydown", onKey);
		// Captured, so a key another listener stops still counts.
		document.addEventListener("keydown", noteKeyboard, true);
		return () => {
			document.removeEventListener("keydown", onKey);
			document.removeEventListener("keydown", noteKeyboard, true);
		};
	}, []);
	useEffect(() => {
		if (!open) return;
		const before = document.activeElement instanceof HTMLElement ? document.activeElement : null;
		closeRef.current?.focus();
		const inConfirm = (target: EventTarget | null) => target instanceof Element && !!target.closest('[role="alertdialog"]');
		const ownEscape = (event: KeyboardEvent) => {
			if (event.key !== "Escape" || inConfirm(event.target)) return;
			event.preventDefault();
			event.stopImmediatePropagation();
			setShown(false);
		};
		const keepFocus = (event: FocusEvent) => {
			if (inConfirm(event.target) || dialogRef.current?.contains(event.target as Node)) return;
			closeRef.current?.focus();
		};
		window.addEventListener("keydown", ownEscape, true);
		document.addEventListener("focusin", keepFocus);
		return () => {
			window.removeEventListener("keydown", ownEscape, true);
			document.removeEventListener("focusin", keepFocus);
			if (before?.isConnected) before.focus();
		};
	}, [open]);
	if (!open) return null;
	return (
		<div className="help-overlay keys-list-overlay" onClick={() => setShown(false)}>
			<div ref={dialogRef} className="help-modal keys-list" role="dialog" aria-modal="true" aria-label="Shortcuts" onClick={(event) => event.stopPropagation()}>
				<div className="help-head">
					<h2>Shortcuts</h2>
					<button ref={closeRef} className="icon-btn" onClick={() => setShown(false)} aria-label="Close">✕</button>
				</div>
				<table className="keys-list-table">
					{/* One row group per section; its heading cell names the rows under it for a screen reader. */}
					{keySections().map(({ heading, rows }) => (
						<tbody key={heading}>
							<tr className="keys-list-section">
								<th scope="rowgroup" colSpan={2}>{heading}</th>
							</tr>
							{rows.map(({ what, keys, or }) => (
								<tr key={what}>
									<td>{what}</td>
									<td>
										{/* "or" stays with the cap before it, so a wrapped row never starts with it. */}
										{keys.map((key, at) => (
											<Fragment key={key}>
												{at > 0 && " "}
												<span>
													<kbd>{key}</kbd>
													{or && at < keys.length - 1 && " or"}
												</span>
											</Fragment>
										))}
									</td>
								</tr>
							))}
						</tbody>
					))}
				</table>
			</div>
		</div>
	);
}
