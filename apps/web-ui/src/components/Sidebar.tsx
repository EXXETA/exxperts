import { SidebarToggleButton } from "../sidebar-collapse";
import { ConfigMenu, type ThemeMode } from "./product-shell";

import type { ReactNode } from "react";

interface Props {
	onHome: () => void;
	theme: ThemeMode;
	onToggleTheme: () => void;
	/** Leaves the room first, then opens AI setup. The caller guards on the leave. */
	onAiSetup: () => void;
	/** The Assets section (contract §2 rung 3) — the rail's first occupant below Home. */
	assetsSlot?: ReactNode;
}

export function Sidebar({ theme, onToggleTheme, onAiSetup, onHome, assetsSlot }: Props) {
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
				<div className="sidebar-footer-controls">
					<ConfigMenu onAiSetup={onAiSetup} theme={theme} onToggleTheme={onToggleTheme} />
					<SidebarToggleButton />
				</div>
			</div>
		</aside>
	);
}
