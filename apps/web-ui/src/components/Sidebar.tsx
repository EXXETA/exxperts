import { useEffect, useRef, useState } from "react";
import { ThemeToggle, type ThemeMode } from "./product-shell";

import type { ReactNode } from "react";

interface Props {
	onHome: () => void;
	connected: boolean;
	theme: ThemeMode;
	onToggleTheme: () => void;
	onHelp: () => void;
	/** The Assets section (contract §2 rung 3) — the rail's first occupant below Home. */
	assetsSlot?: ReactNode;
}

function InRoomSidebarConfigMenu({ theme, onToggleTheme, onHelp }: { theme: ThemeMode; onToggleTheme: () => void; onHelp: () => void }) {
	const [open, setOpen] = useState(false);
	const wrapRef = useRef<HTMLDivElement>(null);

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
						<ThemeToggle theme={theme} onToggle={onToggleTheme} />
					</div>
					<button
						className="menu-item"
						role="menuitem"
						onClick={() => {
							onHelp();
							setOpen(false);
						}}
					>
						Help
					</button>
				</div>
			)}
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

export function Sidebar({ connected, theme, onToggleTheme, onHelp, onHome, assetsSlot }: Props) {
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

			<div className="sidebar-footer">
				<div className="sidebar-connection-status" title={connected ? "Connected" : "Offline"} aria-label={connected ? "Connected" : "Offline"}>
					<span className={`dot ${connected ? "ok" : "bad"}`} />
					{connected ? "connected" : "offline"}
				</div>
				<InRoomSidebarConfigMenu theme={theme} onToggleTheme={onToggleTheme} onHelp={onHelp} />
			</div>
		</aside>
	);
}
