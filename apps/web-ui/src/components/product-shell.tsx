import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";
import { settingsChordHint, shortcutsChordHint } from "../platform";
import { useRemoteAccessStatus } from "../remote-access-api";
import { showsComputerOnlyControls, useRemoteClientContext } from "../remote-client-context";
import { SidebarToggleButton } from "../sidebar-collapse";
import { requestUpdate, useUpdateNotice } from "../update-notice";
import { Help } from "./Help";
import { GearIcon } from "./icons";
import { openShortcuts, useShortcutsOffered } from "./keys-list";
import { useEscapeKey } from "./use-escape-key";

export type ThemeMode = "dark" | "light";
/** What the user picked in the Appearance control; "system" resolves to a ThemeMode via prefers-color-scheme. */
export type AppearancePreference = ThemeMode | "system";

// Injected at build time from the root package.json "version" field (vite define).
const APP_VERSION = __APP_VERSION__;
const GITHUB_URL = "https://github.com/EXXETA/exxperts";

// Where Help's rows have no room beside the menu (a touch screen, a
// phone): there they open in place, under Help. styles/27-menu-and-notices.css
// keeps the same query.
const HELP_ROWS_IN_PLACE = "(hover: none), (max-width: 760px)";

export type ProductSidebarActive = "home" | "ai-setup" | "remote" | "dashboard" | "connectors" | "memory" | "skills";

/**
 * The one settings menu behind the gear. Home and the in-room rail render the
 * same component, so the same settings are one click away wherever you are.
 * `onSettings` opens the Settings overlay; the optional section targets it.
 */
export function ConfigMenu({ onSettings, appearance, onSetAppearance }: { onSettings: (section?: "remote") => void; appearance: AppearancePreference; onSetAppearance: (pref: AppearancePreference) => void }) {
	const [open, setOpen] = useState(false);
	const [helpOpen, setHelpOpen] = useState(false);
	// Help › and its rows, How it works and Shortcuts: beside the menu with a
	// mouse, in place under Help on a touch screen and on a phone. A touch
	// screen offers Shortcuts once a hardware keyboard is used (useShortcutsOffered).
	const [helpRows, setHelpRows] = useState(false);
	const wrapRef = useRef<HTMLDivElement>(null);
	const helpRef = useRef<HTMLButtonElement>(null);
	const helpRowsRef = useRef<HTMLDivElement>(null);
	// Desktop only; in a browser tab nothing offers an update, so the menu
	// has no update row.
	const update = useUpdateNotice();
	const chord = settingsChordHint();
	const shortcutsChord = shortcutsChordHint();
	const shortcutsOffered = useShortcutsOffered();
	// Remote-access admin lives on the computer; a phone viewing the app over
	// the tunnel gets neither the menu entry nor the indicator (the server
	// refuses the admin routes there regardless).

	useEffect(() => {
		if (!open) {
			setHelpRows(false);
			return;
		}
		function onDocMouseDown(e: MouseEvent) {
			if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
		}
		document.addEventListener("mousedown", onDocMouseDown);
		return () => document.removeEventListener("mousedown", onDocMouseDown);
	}, [open]);
	// On the shared stack, so Escape closes only the menu, not a page or dialog on that stack under it.
	useEscapeKey(() => setOpen(false), open);
	// Above the menu on the stack: Esc closes Help's rows first, back on Help.
	useEscapeKey(() => {
		setHelpRows(false);
		helpRef.current?.focus();
	}, helpRows);

	const helpRowButtons = () => [...(helpRowsRef.current?.querySelectorAll<HTMLButtonElement>("button") ?? [])];
	// The keyboard opens the rows with the focus on the first; the mouse leaves it where it is.
	const openHelpRowsByKey = () => {
		setHelpRows(true);
		requestAnimationFrame(() => helpRowButtons()[0]?.focus());
	};
	const onHelpRowKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>) => {
		const rows = helpRowButtons();
		const at = rows.indexOf(event.currentTarget);
		if (event.key === "ArrowDown" || event.key === "ArrowUp") {
			event.preventDefault();
			rows[(at + (event.key === "ArrowDown" ? 1 : rows.length - 1)) % rows.length]?.focus();
		} else if (event.key === "ArrowLeft") {
			event.preventDefault();
			setHelpRows(false);
			helpRef.current?.focus();
		}
	};
	const besideByMouse = (event: ReactPointerEvent) => event.pointerType === "mouse" && !window.matchMedia(HELP_ROWS_IN_PLACE).matches;

	return (
		<div className="sidebar-config" ref={wrapRef}>
			{open && (
				<div className="sidebar-config-menu" role="menu">
					<div className="menu-row">
						<span className="menu-row-label">Appearance</span>
						<div className="menu-appearance-seg" role="group" aria-label="Appearance">
							<button className={appearance === "system" ? "on" : ""} aria-pressed={appearance === "system"} title="Follow this device's light or dark setting" onClick={() => onSetAppearance("system")}>System</button>
							<button className={appearance === "light" ? "on" : ""} aria-pressed={appearance === "light"} onClick={() => onSetAppearance("light")}>Light</button>
							<button className={appearance === "dark" ? "on" : ""} aria-pressed={appearance === "dark"} onClick={() => onSetAppearance("dark")}>Dark</button>
						</div>
					</div>
					<button
						className="menu-item"
						role="menuitem"
						onClick={() => {
							onSettings();
							setOpen(false);
						}}
					>
						<span>Settings</span>
						{chord && <span className="menu-item-kbd" aria-hidden="true">{chord}</span>}
					</button>
					<div
						className="menu-sub-wrap"
						onPointerEnter={(event) => { if (besideByMouse(event)) setHelpRows(true); }}
						onPointerLeave={(event) => { if (besideByMouse(event)) setHelpRows(false); }}
					>
						<button
							ref={helpRef}
							className="menu-item"
							role="menuitem"
							aria-haspopup="menu"
							aria-expanded={helpRows}
							// Beside the menu the pointer has opened them already, so a click keeps them open; in place it toggles them.
							onClick={() => setHelpRows((value) => !value || !window.matchMedia(HELP_ROWS_IN_PLACE).matches)}
							onKeyDown={(event) => {
								if (event.key === "ArrowRight" || event.key === "Enter" || event.key === " ") {
									event.preventDefault();
									openHelpRowsByKey();
								} else if (event.key === "ArrowLeft" && helpRows) {
									event.preventDefault();
									setHelpRows(false);
								}
							}}
						>
							<span>Help</span>
							<span className="menu-item-caret" aria-hidden="true">›</span>
						</button>
						{helpRows && (
							<div className="menu-sub" role="menu" aria-label="Help" ref={helpRowsRef}>
								<button
									className="menu-item"
									role="menuitem"
									onKeyDown={onHelpRowKeyDown}
									onClick={() => {
										setHelpOpen(true);
										setOpen(false);
									}}
								>
									How it works
								</button>
								{shortcutsOffered && (
									<button
										className="menu-item"
										role="menuitem"
										onKeyDown={onHelpRowKeyDown}
										onClick={() => {
											openShortcuts();
											setOpen(false);
										}}
									>
										<span>Shortcuts</span>
										{shortcutsChord && <span className="menu-item-kbd" aria-hidden="true">{shortcutsChord}</span>}
									</button>
								)}
							</div>
						)}
					</div>
					{/* The offer is a menu row like Settings and Help. "Not now" hides
					    the gear dot only; the row stays until the update is installed. */}
					{update.available && (
						<div className="menu-update-row">
							<button
								className="menu-item menu-update"
								role="menuitem"
								onClick={() => {
									requestUpdate();
									setOpen(false);
								}}
							>
								<span>Update to {update.available}</span>
								{update.dotVisible && <span className="menu-update-dot" aria-hidden="true" />}
							</button>
							{update.dotVisible && (
								<button className="menu-update-later" role="menuitem" onClick={update.dismiss} title="Hide the dot on the gear; the update stays here">Not now</button>
							)}
						</div>
					)}
					<div className="menu-meta-row">
						<span>Version <span className="menu-meta-version">{APP_VERSION}</span></span>
						<a className="menu-meta-link" href={GITHUB_URL} target="_blank" rel="noopener noreferrer">GitHub</a>
					</div>
				</div>
			)}
			{helpOpen && <Help onClose={() => setHelpOpen(false)} />}
			<button
				className="sidebar-config-gear"
				aria-label={update.dotVisible ? "Settings, update available" : "Settings"}
				title={`${update.dotVisible ? "Settings, update available" : "Settings"}${chord ? ` (${chord})` : ""}`}
				aria-haspopup="menu"
				aria-expanded={open}
				onClick={() => setOpen((v) => !v)}
			>
				<GearIcon size={16} />
				{update.dotVisible && <span className="sidebar-config-dot" aria-hidden="true" />}
			</button>
		</div>
	);
}

/**
 * The standing "remote is on" signal, anchored at the app's bottom left on
 * its own line above the gear row: as long as the tunnel listener is meant
 * to be up, the fact is one glance away without crowding the gear. "VPN off"
 * = remote stays enabled but the tunnel address is gone — a deliberate state,
 * so it renders calm grey, not amber. Renders nothing on remote devices, on a
 * shared server and while remote access is off.
 */
export function RemoteOnPill({ onSettings }: { onSettings: (section?: "remote") => void }) {
	const clientContext = useRemoteClientContext();
	const remoteStatus = useRemoteAccessStatus();
	const showRemote = showsComputerOnlyControls(clientContext);
	const remoteOn = showRemote && remoteStatus?.enabled === true;
	const remotePaused = showRemote && !remoteStatus?.enabled && remoteStatus?.stateFile === "valid";
	if (!remoteOn && !remotePaused) return null;
	return (
		<button
			className={`remote-on-pill${remotePaused ? " paused" : ""}`}
			type="button"
			title={remotePaused ? "Remote stays available again when your VPN is back on" : "Remote access is on; paired devices can reach this app"}
			onClick={() => onSettings("remote")}
		>
			<span className="remote-on-dot" aria-hidden="true" />
			{remotePaused ? "VPN off" : "Remote on"}
		</button>
	);
}

/**
 * Who is signed in, on a shared server only. The name is text (isolated for
 * right-to-left names), never markup; "Sign out" is offered only when the
 * server gave its link.
 */
export function SignedInAs() {
	const { sharedServer, person, signOut } = useRemoteClientContext();
	if (!sharedServer || !person || (person.name === "" && !signOut)) return null;
	return (
		<div className="signed-in-as">
			{person.name !== "" && (
				<span className="signed-in-as-line">
					Signed in as <bdi className="signed-in-as-name">{person.name}</bdi>
					{person.admin && <span className="signed-in-as-tag">Admin</span>}
				</span>
			)}
			{signOut && <a className="signed-in-as-out" href={signOut}>Sign out</a>}
		</div>
	);
}

export function ProductSidebar({ onHome, onSettings, onDashboard, onMemory, theme, appearance, onSetAppearance, active }: { onHome: () => void; onSettings: (section?: "remote") => void; onDashboard: () => void; onMemory?: () => void; theme: ThemeMode; appearance: AppearancePreference; onSetAppearance: (pref: AppearancePreference) => void; active: ProductSidebarActive }) {
	// The Wallet reads the whole usage log, which on a shared server only its
	// admin may read: it is not offered there.
	const { sharedServer } = useRemoteClientContext();
	return (
		<aside className="product-sidebar">
			<div className="product-sidebar-header">
				<SidebarToggleButton />
				<div className="brand">
					<img src={theme === "light" ? "/brand/exxperts-logo.png" : "/brand/exxperts-logo-negative.png"} alt="exxperts" className="logo" />
				</div>
			</div>
			<nav className="product-nav" aria-label="Product navigation">
				<div className="product-nav-section">
					<button className={`list-btn ${active === "home" ? "active" : ""}`} onClick={onHome} title="Your rooms, one per project or topic">Rooms</button>
				</div>
				{onMemory && (
					<div className="product-nav-section">
						<button className={`list-btn ${active === "memory" ? "active" : ""}`} onClick={onMemory} title="What your rooms know, and questions across all of it">Memory</button>
					</div>
				)}
				{!sharedServer && (
					<div className="product-nav-section">
						<button className={`list-btn ${active === "dashboard" ? "active" : ""}`} onClick={onDashboard} title="What your rooms spend: API costs and plan usage">Wallet</button>
					</div>
				)}
			</nav>
			{/* No connection status here on purpose: a healthy app says nothing
			    about its plumbing, and a sustained failure gets a banner that
			    speaks in words the user can act on. */}
			<div className="product-sidebar-footer">
				<SignedInAs />
				<RemoteOnPill onSettings={onSettings} />
				<div className="sidebar-footer-controls">
					<ConfigMenu onSettings={onSettings} appearance={appearance} onSetAppearance={onSetAppearance} />
				</div>
			</div>
		</aside>
	);
}
