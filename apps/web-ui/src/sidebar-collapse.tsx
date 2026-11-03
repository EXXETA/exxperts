import { useSyncExternalStore } from "react";
import { useEscapeKey } from "./components/use-escape-key";
import { PHONE_MEDIA } from "./phone-viewport";

// Sidebar collapse state, shared by the in-header toggles (one per sidebar
// variant) and the collapsed-only floating affordance. A module store instead
// of app state so the sidebars' components stay ignorant of each other; the
// class on <html> is what the CSS keys off, and localStorage persists it.
const STORAGE_KEY = "exxperts.sidebarCollapsed";
// Phone width: the rail overlays the content (see the mobile block in
// styles/35-sidebar-remote.css), so there it is a drawer that starts closed and is never
// remembered; the stored choice is the wide screen's.
const phoneQuery = window.matchMedia(PHONE_MEDIA);
function storedCollapsed(): boolean {
	try {
		return localStorage.getItem(STORAGE_KEY) === "1";
	} catch {
		return false;
	}
}
let collapsed = phoneQuery.matches || storedCollapsed();
document.documentElement.classList.toggle("sidebar-collapsed", collapsed);

const listeners = new Set<() => void>();

function setCollapsed(next: boolean): void {
	if (collapsed === next) return;
	collapsed = next;
	document.documentElement.classList.toggle("sidebar-collapsed", collapsed);
	listeners.forEach((cb) => cb());
}

export function toggleSidebar(): void {
	setCollapsed(!collapsed);
	if (phoneQuery.matches) return;
	try { localStorage.setItem(STORAGE_KEY, collapsed ? "1" : "0"); } catch { /* private mode */ }
}

/** A dialog opening at phone width closes the drawer, so the dialog is what the person sees. */
export function closeSidebarOnPhone(): void {
	if (phoneQuery.matches) setCollapsed(true);
}

// Narrowing to phone width closes the drawer; widening gives back the wide screen's choice.
phoneQuery.addEventListener("change", () => setCollapsed(phoneQuery.matches || storedCollapsed()));

// The mac app's window buttons keep their size under page zoom while the page
// scales, so the toggle beside them needs the zoom (--window-zoom in
// styles/35-sidebar-remote.css). The window has no frame there, so its outer size in points over
// the page's size in CSS pixels is the zoom; DevTools docked in the window
// shrinks the page along one axis only, so the smaller ratio is the zoom. A
// zoom change is a resize. Early in a page load the window reports its outer
// size as 0 and fills it in without a resize, so until then it looks again on
// the next frame.
function trackWindowZoom(): void {
	if (!document.documentElement.classList.contains("desktop-app-mac")) return;
	if (!window.outerWidth || !window.outerHeight) {
		requestAnimationFrame(trackWindowZoom);
		return;
	}
	const zoom = Math.min(window.outerWidth / window.innerWidth, window.outerHeight / window.innerHeight);
	document.documentElement.style.setProperty("--window-zoom", String(zoom));
}
window.addEventListener("resize", trackWindowZoom);
// After the entry module has set the desktop classes.
queueMicrotask(trackWindowZoom);

function subscribe(cb: () => void): () => void {
	listeners.add(cb);
	return () => listeners.delete(cb);
}

function useSidebarCollapsed(): boolean {
	return useSyncExternalStore(subscribe, () => collapsed);
}

// Phone width, reactive: the drawer backdrop must appear/disappear when a
// rotation or window resize crosses the breakpoint, not just on mount.
function subscribePhone(cb: () => void): () => void {
	phoneQuery.addEventListener("change", cb);
	return () => phoneQuery.removeEventListener("change", cb);
}
export function usePhoneWidth(): boolean {
	return useSyncExternalStore(subscribePhone, () => phoneQuery.matches);
}

function PanelIcon() {
	return (
		<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" aria-hidden="true">
			<rect x="1.5" y="2.5" width="13" height="11" rx="2" />
			<line x1="6" y1="2.5" x2="6" y2="13.5" />
		</svg>
	);
}

// The in-header toggle: first in the sidebar header, before the logo, but
// fixed on exactly the floating affordance's spot (styles/35-sidebar-remote.css), so hiding and
// showing the sidebar are two clicks in one place. The headers' existing
// no-drag rules cover it in the desktop app.
export function SidebarToggleButton() {
	const isCollapsed = useSidebarCollapsed();
	return (
		<button
			className="sidebar-toggle"
			aria-label={isCollapsed ? "Show sidebar" : "Hide sidebar"}
			aria-expanded={!isCollapsed}
			title={isCollapsed ? "Show sidebar" : "Hide sidebar"}
			onClick={toggleSidebar}
		>
			<PanelIcon />
		</button>
	);
}

// Phone-only: at the breakpoint the in-room rail overlays the chat, so an
// open rail dims what it covers; tapping the dim (or Escape, via the shared
// stack so modals above it keep their own Escape) closes the rail.
export function SidebarDrawerBackdrop() {
	const isCollapsed = useSidebarCollapsed();
	const isPhone = usePhoneWidth();
	const open = isPhone && !isCollapsed;
	useEscapeKey(toggleSidebar, open);
	if (!open) return null;
	return <div className="sidebar-drawer-backdrop" aria-hidden="true" onClick={toggleSidebar} />;
}

// The collapsed-state home: the header toggle disappears with the sidebar,
// so a small floating affordance takes over on the same spot. Rendered only
// while collapsed; in the mac app it paints above the drag strip and opts out
// of it, or the drag region would eat its clicks.
export function SidebarCollapsedAffordance() {
	const isCollapsed = useSidebarCollapsed();
	if (!isCollapsed) return null;
	return (
		<button
			className="sidebar-toggle sidebar-toggle-floating"
			aria-label="Show sidebar"
			aria-expanded={false}
			title="Show sidebar"
			onClick={toggleSidebar}
		>
			<PanelIcon />
		</button>
	);
}
