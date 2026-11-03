/**
 * Platform facts the UI must not guess at render time. The same user-agent
 * check main.tsx uses to stamp `desktop-app-mac`: one signal, one answer.
 * The settings chord binds to the platform's own convention — ⌘ on a Mac,
 * Ctrl elsewhere — and the hints advertise exactly the chord that fires.
 */
export function isMacPlatform(): boolean {
	return navigator.userAgent.includes("Macintosh");
}

/** A screen with no hover is a touch screen: it has no keyboard to press a chord on, so no chord is offered there. */
export function isTouchScreen(): boolean {
	return typeof window.matchMedia === "function" && window.matchMedia("(hover: none)").matches;
}

/** The platform's chord key is held alone: ⌘ on a Mac, Ctrl elsewhere, never both. */
export function chordHeld(event: KeyboardEvent): boolean {
	return isMacPlatform() ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
}

/** A chord as this computer writes it: "⇧⌘," on a Mac (Shift before Command, as Mac menus write it), "Ctrl+Shift+," elsewhere. */
export function chordWords(key: string, shift = false): string {
	return isMacPlatform() ? `${shift ? "\u21e7" : ""}\u2318${key}` : `Ctrl+${shift ? "Shift+" : ""}${key}`;
}

/** The chord that opens Settings, or null on a touch screen. */
export function settingsChordHint(): string | null {
	if (isTouchScreen()) return null;
	return chordWords(",");
}

export function roomSettingsChordHint(): string {
	return chordWords(",", true);
}

/** The chord that opens the Shortcuts window, or null on a touch screen. */
export function shortcutsChordHint(): string | null {
	if (isTouchScreen()) return null;
	return chordWords("/");
}
