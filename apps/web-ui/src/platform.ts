/**
 * Platform facts the UI must not guess at render time. The same user-agent
 * check main.tsx uses to stamp `desktop-app-mac`: one signal, one answer.
 * The settings chord binds to the platform's own convention — ⌘ on a Mac,
 * Ctrl elsewhere — and the hints advertise exactly the chord that fires.
 */
export function isMacPlatform(): boolean {
	return navigator.userAgent.includes("Macintosh");
}

export function settingsChordHint(): string {
	return isMacPlatform() ? "\u2318," : "Ctrl+,";
}

export function roomSettingsChordHint(): string {
	return isMacPlatform() ? "\u2318\u21e7," : "Ctrl+Shift+,";
}
