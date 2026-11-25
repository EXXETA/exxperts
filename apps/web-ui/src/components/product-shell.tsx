import { useEffect, useId, useRef, useState, useSyncExternalStore, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";
import { flushSync } from "react-dom";
import { apiFetch, holdSignInRedirect } from "../api";
import { settingsChordHint, shortcutsChordHint } from "../platform";
import { useRemoteAccessStatus } from "../remote-access-api";
import { showsComputerOnlyControls, useRemoteClientContext } from "../remote-client-context";
import { SidebarToggleButton } from "../sidebar-collapse";
import { requestUpdate, useUpdateNotice } from "../update-notice";
import { Help } from "./Help";
import { GearIcon, MoonIcon, ScreenIcon, SunIcon } from "./icons";
import { openShortcuts, useShortcutsOffered } from "./keys-list";
import { useEscapeKey } from "./use-escape-key";
import { SHARED_USAGE_NAV, SHARED_USAGE_NAV_HOVER } from "../usage-words";

export type ThemeMode = "dark" | "light";
/** What the user picked for the theme; "system" resolves to a ThemeMode via prefers-color-scheme. */
export type AppearancePreference = ThemeMode | "system";

/** The theme's three choices and their words, in the gear menu (as icons) and in Settings, Appearance. */
export const THEME_CHOICES: { id: AppearancePreference; label: string }[] = [
	{ id: "system", label: "System" },
	{ id: "light", label: "Light" },
	{ id: "dark", label: "Dark" },
];
const THEME_ICONS = { system: ScreenIcon, light: SunIcon, dark: MoonIcon } satisfies Record<AppearancePreference, unknown>;
const THEME_TIPS: Partial<Record<AppearancePreference, string>> = { system: "System: follows this device's light or dark setting" };

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
						<span className="menu-row-label">Theme</span>
						<div className="settings-segments menu-theme-seg" role="group" aria-label="Theme">
							{THEME_CHOICES.map(({ id, label }) => {
								const ThemeIcon = THEME_ICONS[id];
								return <button key={id} type="button" className={`settings-segment${appearance === id ? " active" : ""}`} aria-pressed={appearance === id} aria-label={label} title={THEME_TIPS[id] ?? label} onClick={() => onSetAppearance(id)}><ThemeIcon /></button>;
							})}
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
								<button className="rs-btn rs-btn-quiet rs-btn-sm menu-update-later" role="menuitem" onClick={update.dismiss} title="Hide the dot on the gear; the update stays here">Not now</button>
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
				className="rs-btn rs-btn-icon rs-btn-sm sidebar-config-gear"
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
			{signOut && <SignOutEverywhere signOut={signOut} />}
		</div>
	);
}

/** How long the sign-out may take before the page says it did not come. */
export const SIGN_OUT_WAIT_MS = 10_000;

// The server's own sign-out: it ends every session of the person that signed in before it.
const SIGN_OUT_ROUTE = "/api/session/sign-out";

// "failed" and "retrying" show the failure line and its two choices; "retrying" while Try again's request is out.
type SignOutState = "ready" | "sending" | "failed" | "retrying";

// The page's one sign-out, read by every footer that shows Sign out (Home's, a room's, Memory's), so moving between
// screens keeps where it stands, and by the signed-out banner. A reload starts it afresh, as it does the page.
let signOutState: SignOutState = "ready";
const signOutListeners = new Set<() => void>();

function setSignOutState(next: SignOutState): void {
	signOutState = next;
	for (const listener of signOutListeners) listener();
}

function useSignOutState(): SignOutState {
	return useSyncExternalStore(
		(listener) => { signOutListeners.add(listener); return () => { signOutListeners.delete(listener); }; },
		() => signOutState,
	);
}

/** Whether the page's own Sign out was pressed: from then on the footer's line says where things stand. */
export function useOwnSignOutPressed(): boolean {
	return useSignOutState() !== "ready";
}

function sendSignOut(signOut: string, sending: "sending" | "retrying"): void {
	// From here on only this sign-out moves the page, whatever else answers 401 meanwhile.
	holdSignInRedirect();
	// Drawn before the request goes, so a second press finds the button already disabled.
	flushSync(() => setSignOutState(sending));
	void signOutConfirmed().then((confirmed) => {
		if (confirmed) location.assign(signOut);
		else setSignOutState("failed");
	});
}

// Confirmed by the route's own success, { ok: true }: the record written and the open connections closed; or by the
// edge's 401 session_signed_out, which a stored record already ending this session answers (an earlier try whose
// answer was lost), so every session from before it is ended too. Any other status, no answer, or none within
// SIGN_OUT_WAIT_MS is not.
async function signOutConfirmed(): Promise<boolean> {
	try {
		const res = await apiFetch(SIGN_OUT_ROUTE, { method: "POST", signal: AbortSignal.timeout(SIGN_OUT_WAIT_MS) });
		const body: unknown = await res.json().catch(() => null);
		const fields = typeof body === "object" && body !== null ? body as Record<string, unknown> : {};
		return (res.ok && fields.ok === true) || (res.status === 401 && fields.code === "session_signed_out");
	} catch {
		return false;
	}
}

// Sign out first ends the person's sessions on the server, then follows the server's link, which ends this
// browser's. Nothing is followed while the answer is out, or when it fails: the person chooses.
function SignOutEverywhere({ signOut }: { signOut: string }) {
	const state = useSignOutState();
	const scopeId = useId();
	const tryAgainRef = useRef<HTMLButtonElement>(null);
	// The pressed button is gone or disabled, so focus comes to Try again unless the person has moved it elsewhere.
	useEffect(() => {
		if (state === "failed" && (document.activeElement === null || document.activeElement === document.body)) tryAgainRef.current?.focus();
	}, [state]);
	if (state === "ready" || state === "sending") {
		return (
			<span className="signed-in-as-out-row">
				<button type="button" className="signed-in-as-out" disabled={state === "sending"} aria-describedby={scopeId} onClick={() => sendSignOut(signOut, "sending")}>Sign out</button>
				<span id={scopeId} className="signed-in-as-scope">This signs you out on every device.</span>
			</span>
		);
	}
	return (
		<span className="signed-in-as-out-failed" role="alert">
			<span className="signed-in-as-scope">Your other devices may still be signed in.</span>
			<span className="signed-in-as-out-row">
				<button type="button" className="signed-in-as-out" ref={tryAgainRef} disabled={state === "retrying"} onClick={() => sendSignOut(signOut, "retrying")}>Try again</button>
				<button type="button" className="signed-in-as-out" onClick={() => location.assign(signOut)}>Sign out of this browser only</button>
			</span>
		</span>
	);
}

export function ProductSidebar({ onHome, onSettings, onDashboard, onMemory, theme, appearance, onSetAppearance, active }: { onHome: () => void; onSettings: (section?: "remote") => void; onDashboard: () => void; onMemory?: () => void; theme: ThemeMode; appearance: AppearancePreference; onSetAppearance: (pref: AppearancePreference) => void; active: ProductSidebarActive }) {
	// On a shared server the same page is each person's own usage, with no
	// money, so it goes by another name there.
	const { sharedServer, person, signOut } = useRemoteClientContext();
	// When SignedInAs shows, on a phone the footer takes a row of its own under the bar (35-sidebar-remote.css):
	// the person's name, and Sign out when the server gives it, get the whole width, and the tabs keep theirs.
	const withPersonRow = sharedServer && person !== null && (person.name !== "" || signOut !== null);
	return (
		<aside className={`product-sidebar${withPersonRow ? " with-person-row" : ""}`}>
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
				<div className="product-nav-section">
					{sharedServer ? (
						<button className={`list-btn ${active === "dashboard" ? "active" : ""}`} onClick={onDashboard} title={SHARED_USAGE_NAV_HOVER}>{SHARED_USAGE_NAV}</button>
					) : (
						<button className={`list-btn ${active === "dashboard" ? "active" : ""}`} onClick={onDashboard} title="What your rooms spend: API costs and plan usage">Wallet</button>
					)}
				</div>
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
