import React, { useSyncExternalStore } from "react";
import { useEscapeKey } from "./components/use-escape-key";

// Sidebar collapse state, shared by the in-header toggles (one per sidebar
// variant) and the collapsed-only floating affordance. A module store instead
// of app state so the sidebars' components stay ignorant of each other; the
// class on <html> is what the CSS keys off, and localStorage persists it.
const STORAGE_KEY = "exxperts.sidebarCollapsed";
let collapsed = false;
try {
	const stored = localStorage.getItem(STORAGE_KEY);
	// No stored choice on a phone-sized screen starts collapsed: at that
	// width the rail overlays the content (see the mobile block in
	// styles.css), so open-by-default would cover the very first screen. An
	// explicit choice, either way, always wins.
	collapsed = stored === null ? window.matchMedia("(max-width: 760px)").matches : stored === "1";
} catch { /* private mode */ }
document.documentElement.classList.toggle("sidebar-collapsed", collapsed);

const listeners = new Set<() => void>();

export function toggleSidebar(): void {
	collapsed = !collapsed;
	document.documentElement.classList.toggle("sidebar-collapsed", collapsed);
	try { localStorage.setItem(STORAGE_KEY, collapsed ? "1" : "0"); } catch { /* private mode */ }
	listeners.forEach((cb) => cb());
}

function subscribe(cb: () => void): () => void {
	listeners.add(cb);
	return () => listeners.delete(cb);
}

function useSidebarCollapsed(): boolean {
	return useSyncExternalStore(subscribe, () => collapsed);
}

// Phone width, reactive: the drawer backdrop must appear/disappear when a
// rotation or window resize crosses the breakpoint, not just on mount.
const phoneQuery = window.matchMedia("(max-width: 760px)");
function subscribePhone(cb: () => void): () => void {
	phoneQuery.addEventListener("change", cb);
	return () => phoneQuery.removeEventListener("change", cb);
}
function usePhoneWidth(): boolean {
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

// The in-header toggle: lives in the sidebar header flow (right-aligned at
// the sidebar's edge), so it scales with layout under zoom and sits outside
// any fixed drag strip. The headers' existing no-drag rules cover it in the
// desktop app.
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
// stack so modals above it keep their own Escape) closes the rail. Closing
// this way is the same explicit, remembered choice as the toggle.
export function SidebarDrawerBackdrop() {
	const isCollapsed = useSidebarCollapsed();
	const isPhone = usePhoneWidth();
	const open = isPhone && !isCollapsed;
	useEscapeKey(toggleSidebar, open);
	if (!open) return null;
	return <div className="sidebar-drawer-backdrop" aria-hidden="true" onClick={toggleSidebar} />;
}

// The collapsed-state home: the header toggle disappears with the sidebar,
// so a small floating affordance takes over at the top-left. Rendered only
// while collapsed; in the desktop app it sits BELOW the drag strip so the
// drag region can never eat its clicks (the round-S1 lesson).
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
