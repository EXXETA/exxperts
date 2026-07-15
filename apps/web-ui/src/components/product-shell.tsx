import { useEffect, useRef, useState } from "react";
import type { PersistentAgentAiProfileSelectionStatus, PersistentAgentAiProfileStatus } from "../types";
import { Help } from "./Help";

export type ThemeMode = "dark" | "light";

// Injected at build time from the root package.json "version" field (vite define).
const APP_VERSION = __APP_VERSION__;
const GITHUB_URL = "https://github.com/EXXETA/exxperts";

export interface SidebarAiProfileProps {
	aiProfileStatus: PersistentAgentAiProfileSelectionStatus | null;
	onSelectAiProfile: (profileId: string) => Promise<void>;
	onRefreshAiProfile?: () => void;
	/** Locked models of rooms currently on standby — used to warn when switching profile would leave them unable to resume. */
	standbyLockedModels?: Array<{ provider: string; model: string }>;
}

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

export function ThemeToggle({ theme, onToggle }: { theme: ThemeMode; onToggle: () => void }) {
	return (
		<button className="theme-toggle" onClick={onToggle} title={`Switch to ${theme === "dark" ? "light" : "dark"} mode`}>
			{theme === "dark" ? "Light" : "Dark"}
		</button>
	);
}

function SidebarConfigMenu({ onAiSetup, theme, onToggleTheme, active, aiProfileStatus, onSelectAiProfile, onRefreshAiProfile, standbyLockedModels }: { onAiSetup: () => void; theme: ThemeMode; onToggleTheme: () => void; active: ProductSidebarActive } & SidebarAiProfileProps) {
	const [open, setOpen] = useState(false);
	const [helpOpen, setHelpOpen] = useState(false);
	const [switchingId, setSwitchingId] = useState<string | null>(null);
	const [selectError, setSelectError] = useState<string | null>(null);
	const wrapRef = useRef<HTMLDivElement>(null);

	const profiles = aiProfileStatus?.profiles;
	// No profile explicitly chosen yet — the "active" one is just the default,
	// so don't present it as a selection the user made.
	const notConfigured = aiProfileStatus ? aiProfileStatus.state.source === "default" : false;

	async function selectProfile(profileId: string) {
		setSwitchingId(profileId);
		setSelectError(null);
		try {
			await onSelectAiProfile(profileId);
			onRefreshAiProfile?.();
		} catch (e) {
			setSelectError((e as Error).message);
		} finally {
			setSwitchingId(null);
		}
	}

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
					<div className="menu-section menu-ai-profile">
						<div className="menu-section-head">
							<span className="menu-row-label">AI profile</span>
						</div>
						{aiProfileStatus ? (
							profiles && profiles.length > 0 ? (
								<div className="menu-ai-profile-list" role="radiogroup" aria-label="AI profile">
									{profiles.map((profile) => {
										const activeProfile = aiProfileStatus.activeProfile;
										const strandedCount = strandedBySwitchCount(standbyLockedModels, activeProfile, profile);
										// Sublines only when they say something actionable — healthy rows stay one line,
										// and the strand warning surfaces on hover/focus, at the moment of decision.
										// The same state reads the same on every row: "not signed in" when the
										// provider is signed out, "setup needed" only for signed-in-but-broken.
										// No "set up" hint: unready rows are inert here, AI setup is the path.
										const notReadyText = profile.provider.configured ? "setup needed" : "not signed in";
										// A selection that cannot run is not presented as one: the dot and
										// active styling only show when the active profile is signed in.
										const presentedActive = profile.active && profile.provider.configured;
										const subline = switchingId === profile.id
											? { text: "selecting…", warn: false, hoverOnly: false }
											: presentedActive
												? notConfigured
													? { text: "default", warn: false, hoverOnly: false }
													: profile.ready
														? null
														: { text: notReadyText, warn: true, hoverOnly: false }
												: !profile.ready
													? { text: notReadyText, warn: false, hoverOnly: false }
													: strandedCount > 0
														? { text: `${strandedCount} standby room${strandedCount === 1 ? "" : "s"} can only resume on ${firstWordOfLabel(activeProfile.label)}`, warn: true, hoverOnly: true }
														: null;
										const title = profile.active
											? undefined
											: profile.ready
												? "Select this AI profile. New room threads start on it; standby threads keep their model"
												: "Sign in from AI setup to use this profile";
										// Unready rows are inert: nothing to select, so nothing to click.
										// The AI setup item below is the way to sign in.
										const disabled = !profile.ready;
										return (
											<div
												key={profile.id}
												className={`menu-profile-row${presentedActive ? " active" : ""}${disabled ? " notready" : ""}`}
												role="radio"
												aria-checked={presentedActive}
												aria-disabled={disabled || undefined}
												tabIndex={disabled ? -1 : 0}
												title={title}
												onClick={() => {
													if (disabled || profile.active || switchingId !== null) return;
													void selectProfile(profile.id);
												}}
												onKeyDown={(e) => {
													if (e.key !== "Enter" && e.key !== " ") return;
													e.preventDefault();
													(e.currentTarget as HTMLElement).click();
												}}
											>
												<span className="menu-profile-radio" aria-hidden="true" />
												<span className="menu-profile-text">
													<span className="menu-profile-name">{profile.label}</span>
													{subline && <span className={`menu-profile-sub${subline.warn ? " warn" : ""}${subline.hoverOnly ? " hover-only" : ""}`}>{subline.text}</span>}
												</span>
											</div>
										);
									})}
								</div>
							) : (
								<p className="menu-ai-profile-note">Profiles still loading</p>
							)
						) : null}
						{selectError && <p className="menu-ai-profile-error">{selectError}</p>}
					</div>
					<button
						className={`menu-item ${active === "ai-setup" ? "active" : ""}`}
						role="menuitem"
						onClick={() => {
							onAiSetup();
							setOpen(false);
						}}
					>
						<span>AI setup</span>
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
					<div className="menu-meta-row">
						<span className="menu-meta-version">{APP_VERSION}</span>
						<a className="menu-meta-link" href={GITHUB_URL} target="_blank" rel="noopener noreferrer">GitHub</a>
					</div>
				</div>
			)}
			{helpOpen && <Help onClose={() => setHelpOpen(false)} />}
			<button
				className="sidebar-config-gear"
				aria-label="Settings"
				aria-haspopup="menu"
				aria-expanded={open}
				onClick={() => setOpen((v) => !v)}
			>
				⚙
			</button>
		</div>
	);
}

export function ProductSidebar({ onHome, onAiSetup, onDashboard, onConnectors, onMemory, onSkills, connected, theme, onToggleTheme, active, aiProfileStatus, onSelectAiProfile, onRefreshAiProfile, standbyLockedModels }: { onHome: () => void; onAiSetup: () => void; onDashboard: () => void; onConnectors?: () => void; onMemory?: () => void; onSkills?: () => void; connected: boolean; theme: ThemeMode; onToggleTheme: () => void; active: ProductSidebarActive } & SidebarAiProfileProps) {
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
			<div className="product-sidebar-footer">
				<div className="sidebar-connection-status" title={connected ? "Connected" : "Offline"} aria-label={connected ? "Connected" : "Offline"}>
					<span className={`dot ${connected ? "ok" : "bad"}`} />
					{connected ? "connected" : "offline"}
				</div>
				<SidebarConfigMenu onAiSetup={onAiSetup} theme={theme} onToggleTheme={onToggleTheme} active={active} aiProfileStatus={aiProfileStatus} onSelectAiProfile={onSelectAiProfile} onRefreshAiProfile={onRefreshAiProfile} standbyLockedModels={standbyLockedModels} />
			</div>
		</aside>
	);
}
