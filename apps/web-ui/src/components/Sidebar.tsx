import { SidebarToggleButton } from "../sidebar-collapse";
import { RemoteOnPill, ConfigMenu, type AppearancePreference, type ThemeMode } from "./product-shell";

import type { ReactNode } from "react";

interface Props {
	onHome: () => void;
	theme: ThemeMode;
	appearance: AppearancePreference;
	onSetAppearance: (pref: AppearancePreference) => void;
	/** Opens the Settings overlay over the room; the optional section targets it. */
	onSettings: (section?: "remote") => void;
	/** The Assets section (contract §2 rung 3) — the rail's first occupant below Home. */
	assetsSlot?: ReactNode;
}

export function Sidebar({ theme, appearance, onSetAppearance, onSettings, onHome, assetsSlot }: Props) {
	return (
		<aside className="sidebar">
			<div className="sidebar-header">
				<div className="brand">
					<img src={theme === "light" ? "/brand/exxperts-logo.png" : "/brand/exxperts-logo-negative.png"} alt="exxperts" className="logo" />
				</div>
			</div>
			<nav className="sidebar-primary-nav" aria-label="Room navigation">
				<button className="list-btn sidebar-home-btn" onClick={onHome}>Home</button>
			</nav>
			{assetsSlot}

			{/* No connection status here on purpose: the room's own reconnect
			    affordance sits on the composer, where it can actually act. */}
			<div className="sidebar-footer">
				<RemoteOnPill onSettings={onSettings} />
				<div className="sidebar-footer-controls">
					<ConfigMenu onSettings={onSettings} appearance={appearance} onSetAppearance={onSetAppearance} />
					<SidebarToggleButton />
				</div>
			</div>
		</aside>
	);
}
