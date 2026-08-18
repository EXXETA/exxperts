import { useEffect, useRef, useState } from "react";
import { SidebarToggleButton } from "../sidebar-collapse";
import type { PersistentAgentAiProfileStatus } from "../types";
import { requestUpdate, useUpdateNotice } from "../update-notice";
import { Help } from "./Help";

export type ThemeMode = "dark" | "light";

// Injected at build time from the root package.json "version" field (vite define).
const APP_VERSION = __APP_VERSION__;
const GITHUB_URL = "https://github.com/EXXETA/exxperts";

export function profileIncludesModel(profile: PersistentAgentAiProfileStatus, model: { provider: string; model: string }): boolean {
	return profile.processes?.persistentRoom.models.some((candidate) => candidate.provider === model.provider && candidate.model === model.model) ?? true;
}

/**
 * How many standby rooms the switch to `candidate` would actually block:
 * rooms resumable under the ACTIVE profile whose locked model the candidate
 * does not provide. Rooms already stranded today (locked to a model the
 * active profile no longer provides, e.g. a removed gateway) are not counted —
 * the switch changes nothing for them, and counting them inflates every row.
 */
export function strandedBySwitchCount(standbyLockedModels: Array<{ provider: string; model: string }> | undefined, activeProfile: PersistentAgentAiProfileStatus, candidate: PersistentAgentAiProfileStatus): number {
	if (!standbyLockedModels || candidate.active) return 0;
	return standbyLockedModels.filter((model) => profileIncludesModel(activeProfile, model) && !profileIncludesModel(candidate, model)).length;
}

export function firstWordOfLabel(label: string): string {
	return label.split(" ")[0] || label;
}

export type ProductSidebarActive = "home" | "ai-setup" | "dashboard" | "connectors" | "memory" | "skills";

/**
 * The one settings menu behind the gear. Home and the in-room rail render the
 * same component, so the same settings are one click away wherever you are.
 * `active` only exists to mark the AI setup row when that shell is already open.
 */
export function ConfigMenu({ onAiSetup, theme, onToggleTheme, active }: { onAiSetup: () => void; theme: ThemeMode; onToggleTheme: () => void; active?: ProductSidebarActive }) {
	const [open, setOpen] = useState(false);
	const [helpOpen, setHelpOpen] = useState(false);
	const wrapRef = useRef<HTMLDivElement>(null);
	// Desktop only; in a browser tab this stays empty and the row keeps
	// showing the plain version.
	const update = useUpdateNotice();

	useEffect(() => {
		if (!open) return;
		function onDocMouseDown(e: MouseEvent) {
			if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
		}
		function onKeyDown(e: KeyboardEvent) {
			if (e.key === "Escape") setOpen(false);
		}
		document.addEventListener("mousedown", onDocMouseDown);
		document.addEventListener("keydown", onKeyDown);
		return () => {
			document.removeEventListener("mousedown", onDocMouseDown);
			document.removeEventListener("keydown", onKeyDown);
		};
	}, [open]);

	return (
		<div className="sidebar-config" ref={wrapRef}>
			{open && (
				<div className="sidebar-config-menu" role="menu">
					<div className="menu-row">
						<span className="menu-row-label">Theme</span>
						<div className="menu-theme-seg" role="group" aria-label="Theme">
							<button className={theme === "dark" ? "on" : ""} aria-pressed={theme === "dark"} onClick={() => theme !== "dark" && onToggleTheme()}>Dark</button>
							<button className={theme === "light" ? "on" : ""} aria-pressed={theme === "light"} onClick={() => theme !== "light" && onToggleTheme()}>Light</button>
						</div>
					</div>
					<button
						className={`menu-item ${active === "ai-setup" ? "active" : ""}`}
						role="menuitem"
						onClick={() => {
							onAiSetup();
							setOpen(false);
						}}
					>
						<span>Settings</span>
						<span className="menu-item-arrow" aria-hidden="true">→</span>
					</button>
					<button
						className="menu-item"
						role="menuitem"
						onClick={() => {
							setHelpOpen(true);
							setOpen(false);
						}}
					>
						Help
					</button>
					{/* The offer is its own line above the metadata, so the version
					    the user is running stays readable next to the version on
					    offer (a swapped-out version line answered "update to what,
					    from what?" with only half of it). Dismiss silences the gear
					    dot only; the offer stays here for whenever the user wants
					    it. */}
					{update.available && (
						<div className="menu-update-row">
							<button
								className="menu-meta-update-btn"
								onClick={() => {
									requestUpdate();
									setOpen(false);
								}}
							>
								Update to v{update.available}
							</button>
							{update.dotVisible && (
								<button className="menu-meta-dismiss" onClick={update.dismiss}>Dismiss</button>
							)}
						</div>
					)}
					<div className="menu-meta-row">
						<span className="menu-meta-version">{APP_VERSION}</span>
						<a className="menu-meta-link" href={GITHUB_URL} target="_blank" rel="noopener noreferrer">GitHub</a>
					</div>
				</div>
			)}
			{helpOpen && <Help onClose={() => setHelpOpen(false)} />}
			<button
				className="sidebar-config-gear"
				aria-label={update.dotVisible ? "Settings, update available" : "Settings"}
				aria-haspopup="menu"
				aria-expanded={open}
				onClick={() => setOpen((v) => !v)}
			>
				⚙
				{update.dotVisible && <span className="sidebar-config-dot" aria-hidden="true" />}
			</button>
		</div>
	);
}

export function ProductSidebar({ onHome, onAiSetup, onDashboard, onConnectors, onMemory, onSkills, theme, onToggleTheme, active }: { onHome: () => void; onAiSetup: () => void; onDashboard: () => void; onConnectors?: () => void; onMemory?: () => void; onSkills?: () => void; theme: ThemeMode; onToggleTheme: () => void; active: ProductSidebarActive }) {
	return (
		<aside className="product-sidebar">
			<div className="product-sidebar-header">
				<div className="brand">
					<img src={theme === "light" ? "/brand/exxperts-logo.png" : "/brand/exxperts-logo-negative.png"} alt="exxperts" className="logo" />
				</div>
			</div>
			<nav className="product-nav" aria-label="Product navigation">
				<div className="product-nav-section">
					<button className={`list-btn ${active === "home" ? "active" : ""}`} onClick={onHome}>Rooms</button>
				</div>
				{onMemory && (
					<div className="product-nav-section">
						<button className={`list-btn ${active === "memory" ? "active" : ""}`} onClick={onMemory}>Memory</button>
					</div>
				)}
				<div className="product-nav-section">
					<button className={`list-btn ${active === "dashboard" ? "active" : ""}`} onClick={onDashboard}>Wallet</button>
				</div>
				<div className="product-nav-section">
					<div className="product-nav-label">Tools</div>
					{onConnectors && <button className={`list-btn ${active === "connectors" ? "active" : ""}`} onClick={onConnectors}>Connectors</button>}
					{onSkills && <button className={`list-btn ${active === "skills" ? "active" : ""}`} onClick={onSkills}>Skills</button>}
				</div>
			</nav>
			{/* No connection status here on purpose: a healthy app says nothing
			    about its plumbing, and a sustained failure gets a banner that
			    speaks in words the user can act on. */}
			<div className="product-sidebar-footer">
				<div className="sidebar-footer-controls">
					<ConfigMenu onAiSetup={onAiSetup} theme={theme} onToggleTheme={onToggleTheme} active={active} />
					<SidebarToggleButton />
				</div>
			</div>
		</aside>
	);
}
