import type { KeyboardEvent as ReactKeyboardEvent } from "react";

const FOCUSABLE = "button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex='-1'])";

/** The controls inside a window that Tab can reach, in page order. */
function focusablesIn(container: HTMLElement): HTMLElement[] {
	// A control taken out of the Tab order (a list's roving rows) is reachable
	// by its own keys, not by Tab; the one its keys moved focus to still counts,
	// so Tab from it wraps inside the window instead of leaving it.
	return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((el) => (el.tabIndex >= 0 || el === document.activeElement) && el.getClientRects().length > 0);
}

/** Puts focus on a window's first control, or on the window itself when it has none. */
export function focusIntoWindow(container: HTMLElement | null): void {
	if (!container) return;
	(focusablesIn(container)[0] ?? container).focus();
}

/**
 * Keeps Tab and Shift+Tab inside a modal window whose controls come and go
 * with its steps: the room behind it (the message box's Enter among it) stays
 * out of reach. Reads the controls on each key, so a step that replaces its
 * buttons needs no wiring of its own.
 */
export function containTab(event: ReactKeyboardEvent, container: HTMLElement | null): void {
	if (event.key !== "Tab" || !container) return;
	const controls = focusablesIn(container);
	if (controls.length === 0) { event.preventDefault(); container.focus(); return; }
	const first = controls[0];
	const last = controls[controls.length - 1];
	const active = document.activeElement;
	if (!container.contains(active)) { event.preventDefault(); first.focus(); }
	else if (event.shiftKey && (active === first || active === container)) { event.preventDefault(); last.focus(); }
	else if (!event.shiftKey && active === last) { event.preventDefault(); first.focus(); }
}
