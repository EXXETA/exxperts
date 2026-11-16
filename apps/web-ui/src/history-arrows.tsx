import { useSyncExternalStore } from "react";

// Back and Forward as the app's own controls: buttons and keys in both desktop
// apps, on the mac app's top row and on the Windows app's sidebar line. A
// browser has its own of both, so it gets neither. They move the history App.tsx keeps, whose popstate does the rest,
// a refused move included; this file holds no route of its own.

type Navigation = EventTarget & { readonly canGoBack: boolean; readonly canGoForward: boolean };
// Undefined in a browser without it, where nothing here runs.
const { navigation } = window as unknown as { navigation: Navigation };

// Settings and the other dialogs are not places: nothing moves behind one.
const dialogOpen = () => !!document.querySelector('[aria-modal="true"]');
// Checked here too, for the keys: an entry before the app's first is another page, not a place in it.
function goBack(): void {
	if (navigation.canGoBack && !dialogOpen()) window.history.back();
}
function goForward(): void {
	if (navigation.canGoForward && !dialogOpen()) window.history.forward();
}

const inDesktopApp = () => document.documentElement.classList.contains("desktop-app");
const inMacApp = () => document.documentElement.classList.contains("desktop-app-mac");

/** The two keys as this computer writes them, Back's first; null in a browser. */
export function historyKeyWords(): [string, string] | null {
	if (!inDesktopApp()) return null;
	return inMacApp() ? ["⌘[", "⌘]"] : ["Alt+Left", "Alt+Right"];
}

/** Matched by the character on a Mac, since [ and ] need other keys on German and Spanish keyboards. */
const MAC_KEYS: Record<string, () => void> = { "[": goBack, "]": goForward };
const ALT_KEYS: Record<string, () => void> = { ArrowLeft: goBack, ArrowRight: goForward };

/** Listens for the two keys for the page's whole life. Called once the desktop classes are set. */
export function installHistoryKeys(): void {
	if (!inDesktopApp()) return;
	const mac = inMacApp();
	document.addEventListener("keydown", (event) => {
		if (event.isComposing || event.repeat) return;
		// Ctrl with Alt is AltGr, which types.
		const held = mac ? event.metaKey && !event.ctrlKey : event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey;
		const move = held ? (mac ? MAC_KEYS : ALT_KEYS)[event.key] : undefined;
		if (!move) return;
		event.preventDefault();
		move();
	});
}

function subscribe(cb: () => void): () => void {
	navigation.addEventListener("currententrychange", cb);
	return () => navigation.removeEventListener("currententrychange", cb);
}

function ArrowIcon({ path }: { path: string }) {
	return (
		<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
			<path d={path} />
		</svg>
	);
}

function Arrows() {
	const canGoBack = useSyncExternalStore(subscribe, () => navigation.canGoBack);
	const canGoForward = useSyncExternalStore(subscribe, () => navigation.canGoForward);
	return (
		<div className="history-arrows">
			<button className="history-arrow" aria-label="Back" title="Back" disabled={!canGoBack} onClick={goBack}>
				<ArrowIcon path="M13 8H3M7 4 3 8l4 4" />
			</button>
			<button className="history-arrow" aria-label="Forward" title="Forward" disabled={!canGoForward} onClick={goForward}>
				<ArrowIcon path="M3 8h10M9 4l4 4-4 4" />
			</button>
		</div>
	);
}

/** The buttons in both desktop apps, always shown, grey with nowhere to go; where they sit is the CSS's (35-sidebar-remote.css). */
export function HistoryArrows() {
	return inDesktopApp() ? <Arrows /> : null;
}
