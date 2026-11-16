import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import {
	addMcpServer,
	cancelMcpServerLogin,
	changeMcpServerAddress,
	fetchMcpConnectorsStatus,
	fetchMcpServerLoginState,
	logoutMcpServer,
	McpRequestError,
	removeMcpServer,
	startMcpServerLogin,
	testMcpServer,
	type McpConnectorCheck,
	type McpConnectorStatus,
	type McpConnectorsStatusResponse,
} from "../mcp-api";
import { CONNECTOR_CATALOG, type ConnectorCatalogEntry } from "../connector-catalog";
import { PHONE_MEDIA } from "../phone-viewport";
import { CONNECTOR_ICONS } from "../connector-icons";
import {
	addedNotice,
	catalogEntryOf,
	checkOf,
	checksInBackground,
	CONNECTOR_WORDS,
	connectorRowState,
	connectsBySignIn,
	addedInFile,
	importedFrom,
	isCustom,
	lineText,
	removeConsequence,
	rowLook,
	rowMenu,
	shownName,
	technicalDetails,
	toolTitle,
	waitsForSignIn,
	wentWrongLine,
	type RowActivity,
	type RowButton,
} from "../connector-rows";
import { CONNECTOR_FORM_LINES, connectorDisplayName, connectorShownName, MAX_CONNECTOR_NAME_LENGTH, sameConnectorSite } from "../../../web-server/src/connector-form";
import { appRouteHash } from "../app-route";
import { fetchRemoteClientContext, SHARED_SERVER_ADMIN_LINE, useRemoteClientContext } from "../remote-client-context";
import { AiProfileRowMenu } from "./ai-profile-switcher";
import { CloseIcon } from "./icons";
import { GroupHeader, PaneHeader } from "./pane-header";
import { isServiceUnreachableLine } from "../api";

const WORDS = CONNECTOR_WORDS;
/** A check the person asked for stays on screen at least this long, so "Checking…" is read rather than flashed. */
const MANUAL_CHECK_MIN_MS = 600;
const SIGN_IN_POLL_MS = 2000;
const SIGN_IN_LIMIT_MS = 3 * 60_000;

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** An answer that says the page's list is out of date: 404, the connector no longer exists; 409 on a change, it can't be changed here. */
const refusedAs = (e: unknown, ...statuses: number[]) => e instanceof McpRequestError && statuses.includes(e.status);

/** A button that keeps its width while busy: its words stay in place, hidden, under a small spinner. */
function SlotButton({ label, busy, onClick }: { label: string; busy: boolean; onClick: () => void }) {
	return (
		<button type="button" className={`rs-btn connector-slot-btn${busy ? " is-busy" : ""}`} aria-busy={busy || undefined} disabled={busy} onClick={onClick}>
			<span className="connector-slot-label">{label}</span>
			{busy && <span className="spinner" aria-hidden="true" />}
		</button>
	);
}

export interface ConnectorRowProps {
	server: McpConnectorStatus;
	/** The newest check: this page's own, else the one the server kept. */
	check: McpConnectorCheck | null;
	open: boolean;
	onToggle: () => void;
	/** A check finished, or what was known no longer holds (null). */
	onCheck: (name: string, check: McpConnectorCheck | null) => void;
	onChanged: () => Promise<void>;
	onNotice: (text: string) => void;
	onOpenRoom?: (agentId: string) => void;
	readOnly: boolean;
	/** The shared connector file's path as the page's line about it shows it, so a row from it names the same file. */
	sharedFile?: string | null;
}

export function ConnectorRow({ server, check, open, onToggle, onCheck, onChanged, onNotice, onOpenRoom, readOnly, sharedFile = null }: ConnectorRowProps) {
	const [activity, setActivity] = useState<RowActivity>(null);
	// The button the person pressed, busy until its work ends; it keeps its place while the row checks.
	const [busyButton, setBusyButton] = useState<RowButton | null>(null);
	const [asking, setAsking] = useState(false);
	const [removing, setRemoving] = useState(false);
	const [menuOpen, setMenuOpen] = useState(false);
	const [edit, setEdit] = useState<{ focus: "address" | "key" } | null>(null);
	const [showAllTools, setShowAllTools] = useState(false);
	const [rowError, setRowError] = useState<string | null>(null);
	const pollRef = useRef<number | null>(null);
	const mountedRef = useRef(true);
	const moreRef = useRef<HTMLButtonElement | null>(null);
	const rowRef = useRef<HTMLDivElement | null>(null);
	// On a phone the status runs on under "⋯", so the menu opens under the whole row header.
	const menuAnchorRef = useMemo<RefObject<HTMLElement | null>>(() => ({
		get current() {
			return window.matchMedia(PHONE_MEDIA).matches ? rowRef.current : moreRef.current;
		},
	}), []);
	const keepRef = useRef<HTMLButtonElement | null>(null);
	const firstItemRef = useRef<HTMLButtonElement | null>(null);
	const shownStatusRef = useRef<string | null>(null);

	useEffect(() => {
		// Set again here: StrictMode undoes and redoes every effect while the page is developed.
		mountedRef.current = true;
		return () => {
			mountedRef.current = false;
			if (pollRef.current !== null) window.clearTimeout(pollRef.current);
		};
	}, []);

	const state = connectorRowState(server, check, activity);
	const look = rowLook(state, readOnly);
	const name = shownName(server);
	const imported = importedFrom(server);
	const tag = imported ? WORDS.tagImported(imported) : isCustom(server) ? WORDS.tagCustom : null;
	const menu = rowMenu(server, state, readOnly);
	// Only a changed status fades in; the first paint and an unchanged row stay still.
	const statusKey = `${look.dot}:${look.status}`;
	const fadeIn = shownStatusRef.current !== null && shownStatusRef.current !== statusKey;
	useEffect(() => {
		shownStatusRef.current = statusKey;
	});

	useEffect(() => {
		if (asking) keepRef.current?.focus();
	}, [asking]);
	// The menu stays hidden until it has measured where it fits, and a hidden
	// item can't take the focus, so it moves on the next frame.
	useEffect(() => {
		if (!menuOpen) return;
		const frame = requestAnimationFrame(() => firstItemRef.current?.focus());
		return () => cancelAnimationFrame(frame);
	}, [menuOpen]);

	/** A check the person asked for; pressed is the row button that asked, which stays busy until it ends. */
	async function runCheck(pressed: RowButton | null = null) {
		setRowError(null);
		setBusyButton(pressed);
		setActivity({ kind: "checking" });
		try {
			const [result] = await Promise.all([testMcpServer(server.name), delay(MANUAL_CHECK_MIN_MS)]);
			if (!mountedRef.current) return;
			if (!result.superseded) onCheck(server.name, checkOf(result));
			setActivity(null);
			setBusyButton(null);
			await onChanged();
		} catch (e) {
			if (!mountedRef.current) return;
			setActivity(null);
			setBusyButton(null);
			if (refusedAs(e, 404)) return void (await readAgain());
			setRowError((e as Error).message);
		}
	}

	/** The list read again, after an answer that says this row is out of date; a connector that no longer exists leaves it. */
	async function readAgain() {
		onCheck(server.name, null);
		await onChanged();
	}

	function pollSignIn(deadline: number) {
		pollRef.current = window.setTimeout(async () => {
			try {
				const login = await fetchMcpServerLoginState(server.name);
				if (!mountedRef.current) return;
				if (login.pending && Date.now() < deadline) return pollSignIn(deadline);
				if (login.pending) {
					await cancelMcpServerLogin(server.name).catch(() => undefined);
					setActivity({ kind: "sign-in-failed" });
				} else if (login.cause) {
					setActivity({ kind: "sign-in-failed", cause: login.cause, detail: login.detail });
				} else {
					setActivity(null);
					onCheck(server.name, null);
					await onChanged();
				}
			} catch (e) {
				if (mountedRef.current) setActivity({ kind: "sign-in-failed", error: (e as Error).message });
			}
		}, SIGN_IN_POLL_MS);
	}

	async function signIn() {
		setRowError(null);
		setBusyButton(look.button);
		try {
			await startMcpServerLogin(server.name);
			if (!mountedRef.current) return;
			setActivity({ kind: "signing-in" });
			pollSignIn(Date.now() + SIGN_IN_LIMIT_MS);
		} catch (e) {
			if (!mountedRef.current) return;
			if (refusedAs(e, 404)) await readAgain();
			else setActivity({ kind: "sign-in-failed", error: (e as Error).message });
		} finally {
			if (mountedRef.current) setBusyButton(null);
		}
	}

	async function cancelSignIn() {
		if (pollRef.current !== null) window.clearTimeout(pollRef.current);
		setBusyButton("cancel");
		try {
			await cancelMcpServerLogin(server.name);
		} catch {
			// the attempt also ends on its own time limit
		}
		if (!mountedRef.current) return;
		setBusyButton(null);
		setActivity(null);
	}

	function pressButton() {
		if (look.button === "cancel") return void cancelSignIn();
		if (look.button === "reconnect" || state.kind === "sign-in-failed" || (look.button === "connect" && connectsBySignIn(server))) return void signIn();
		void runCheck(look.button);
	}

	async function disconnect() {
		setRowError(null);
		try {
			await logoutMcpServer(server.name);
			onCheck(server.name, null);
			await onChanged();
		} catch (e) {
			if (mountedRef.current) setRowError((e as Error).message);
		}
	}

	async function remove() {
		setRemoving(true);
		setRowError(null);
		try {
			await removeMcpServer(server.name);
			await readAgain();
		} catch (e) {
			if (!mountedRef.current) return;
			setRemoving(false);
			setAsking(false);
			if (refusedAs(e, 404)) return void (await readAgain());
			setRowError((e as Error).message);
			// Refused here: it was added somewhere this page doesn't change, which the list read again shows.
			if (refusedAs(e, 409)) await readAgain();
		}
	}

	function closeMenu(returnFocus = true) {
		setMenuOpen(false);
		if (returnFocus) moreRef.current?.focus();
	}

	function chooseFromMenu(item: (typeof menu)[number]) {
		closeMenu(item !== "remove" && item !== "changeAddress");
		if (item === "checkConnection") void runCheck();
		else if (item === "disconnect") void disconnect();
		else if (item === "remove") setAsking(true);
		else {
			if (!open) onToggle();
			setEdit({ focus: "address" });
		}
	}

	function keepIt() {
		setAsking(false);
		requestAnimationFrame(() => moreRef.current?.focus());
	}

	const shownButton = busyButton ?? look.button;
	const buttonLabel = shownButton ? WORDS.button[shownButton] : null;
	const consequence = removeConsequence(server, server.usedIn);
	const askId = `connector-ask-${server.name}`;

	return (
		<div className={`connector-item${open ? " is-open" : ""}${asking ? " is-asking" : ""}`}>
			<div ref={rowRef} className="connector-item-row">
				<button type="button" className="connector-item-hit" aria-expanded={open} onClick={onToggle}>
					<ConnectorAvatar id={catalogEntryOf(server)?.id ?? server.name} name={name} size={32} />
					<span className="connector-item-text">
						<span className="connector-item-name">
							<span className="connector-item-name-text">{name}</span>
							{tag && <span className="connector-dir-kind">{tag}</span>}
						</span>
						<span key={statusKey} className={`connector-item-state${look.broken ? " is-broken" : ""}${fadeIn ? " is-new" : ""}`}>
							<span className={`connector-dot connector-dot-${look.dot}`} aria-hidden="true" />
							<span className="connector-item-status">{look.status}</span>
						</span>
					</span>
					{server.usedIn && !asking && (
						<span className="connector-rooms-link">
							{WORDS.roomsLink(server.usedIn.length)}
							<span className="disclosure-chevron" aria-hidden="true" />
						</span>
					)}
				</button>
				{asking ? (
					<div
						className="connector-ask"
						role="group"
						aria-labelledby={askId}
						onKeyDown={(e) => {
							if (e.key === "Escape") {
								e.stopPropagation();
								keepIt();
							}
						}}
					>
						<span className="connector-ask-q" id={askId}>
							<strong>{WORDS.removeQuestion(name)}</strong>
							{consequence && <span>{consequence}</span>}
						</span>
						<span className="connector-ask-btns">
							<button type="button" className="rs-btn" ref={keepRef} disabled={removing} onClick={keepIt}>{WORDS.button.keep}</button>
							<button
								type="button"
								className={`rs-btn rs-btn-primary rs-btn-danger connector-slot-btn${removing ? " is-busy" : ""}`}
								disabled={removing}
								aria-busy={removing || undefined}
								// Enter never removes: only a click or Space does.
								onKeyDown={(e) => {
									if (e.key === "Enter") e.preventDefault();
								}}
								onClick={() => void remove()}
							>
								<span className="connector-slot-label">{WORDS.button.remove}</span>
								{removing && <span className="spinner" aria-hidden="true" />}
							</button>
						</span>
					</div>
				) : (
					<div className="connector-item-side">
						<span className="connector-item-slot">{buttonLabel && !readOnly && <SlotButton label={buttonLabel} busy={busyButton !== null} onClick={pressButton} />}</span>
						{menu.length > 0 ? (
							<span className="ai-profile-menu-anchor">
								<button
									type="button"
									ref={moreRef}
									className="rs-btn rs-btn-icon ai-profile-menu-btn connector-item-more"
									aria-haspopup="menu"
									aria-expanded={menuOpen}
									aria-label={WORDS.menu.label(name)}
									onClick={() => (menuOpen ? closeMenu() : setMenuOpen(true))}
								>
									···
								</button>
								{menuOpen && (
									<span onKeyDown={(e) => menuKeys(e, () => closeMenu())}>
										<AiProfileRowMenu anchorRef={menuAnchorRef} onDismiss={() => closeMenu()}>
											{menu.map((item, index) => (
												<span key={item} style={{ display: "contents" }}>
													{item === "remove" && index > 0 && <span className="connector-menu-sep" role="separator" />}
													<button type="button" role="menuitem" ref={index === 0 ? firstItemRef : undefined} className={`ai-profile-menu-item connector-menu-item${item === "remove" ? " danger" : ""}`} onClick={() => chooseFromMenu(item)}>
														{WORDS.menu[item]}
													</button>
												</span>
											))}
										</AiProfileRowMenu>
									</span>
								)}
							</span>
						) : (
							<span className="connector-item-more" aria-hidden="true" />
						)}
					</div>
				)}
			</div>
			{rowError && <p className="connector-row-error" role="alert">{rowError}</p>}
			{open && <ConnectorDetails server={server} state={state} edit={edit} onEdit={setEdit} showAllTools={showAllTools} onShowAllTools={setShowAllTools} onTryAgain={() => void runCheck(look.button)} onSaved={async (sameSite, keyOnly) => {
				setEdit(null);
				onNotice(keyOnly ? WORDS.keySaved : WORDS.addressSaved);
				onCheck(server.name, null);
				await onChanged();
				// On the same site its sign-in moved along, or it needs none; on another site one known to need a sign-in waits for the person.
				if (sameSite || !waitsForSignIn(server)) await runCheck();
			}} onOutOfDate={async (message) => {
				setEdit(null);
				setRowError(message);
				await readAgain();
			}} onRemove={menu.includes("remove") ? () => setAsking(true) : undefined} onOpenRoom={onOpenRoom} readOnly={readOnly} sharedFile={sharedFile} />}
		</div>
	);
}

/** Arrow keys move through a menu's items, Escape and Tab close it. */
function menuKeys(e: React.KeyboardEvent, close: () => void) {
	const items = [...(e.currentTarget.ownerDocument.querySelectorAll<HTMLButtonElement>(".ai-profile-menu [role=menuitem]"))];
	const at = items.indexOf(e.target as HTMLButtonElement);
	if (e.key === "Escape" || e.key === "Tab") {
		e.preventDefault();
		// Esc closes the menu only, never the Settings window around it.
		if (e.key === "Escape") e.stopPropagation();
		close();
	} else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
		e.preventDefault();
		items[(at + (e.key === "ArrowDown" ? 1 : items.length - 1)) % items.length]?.focus();
	} else if (e.key === "Home" || e.key === "End") {
		e.preventDefault();
		items[e.key === "Home" ? 0 : items.length - 1]?.focus();
	}
}

function ConnectorDetails({ server, state, edit, onEdit, showAllTools, onShowAllTools, onTryAgain, onSaved, onOutOfDate, onRemove, onOpenRoom, readOnly, sharedFile }: {
	server: McpConnectorStatus;
	state: ReturnType<typeof connectorRowState>;
	edit: { focus: "address" | "key" } | null;
	onEdit: (edit: { focus: "address" | "key" } | null) => void;
	showAllTools: boolean;
	onShowAllTools: (all: boolean) => void;
	onTryAgain: () => void;
	onSaved: (sameSiteSignedIn: boolean, keyOnly: boolean) => Promise<void>;
	/** The change was refused because the row is out of date: the edit closes and the row says why. */
	onOutOfDate: (message: string) => Promise<void>;
	/** Asks the row's own remove question; absent where the row can't be removed here. */
	onRemove?: () => void;
	onOpenRoom?: (agentId: string) => void;
	readOnly: boolean;
	sharedFile: string | null;
}) {
	const words = WORDS.details;
	const wentWrong = wentWrongLine(server, state, readOnly);
	const technical = technicalDetails(state);
	const catalogEntry = catalogEntryOf(server);
	const imported = importedFrom(server);
	const fileNote = addedInFile(server, sharedFile);
	const web = server.transport === "http";
	const canEdit = !readOnly && server.editable && !catalogEntry && !imported;
	const tools = server.tools;
	const description = catalogEntry?.description;
	const lines: ReactNode[] = [];
	const line = (key: string, label: string, value: ReactNode) => {
		lines.push(<span key={`${key}-label`} className="connector-label">{label}</span>, <div key={`${key}-value`} className="connector-value">{value}</div>);
	};

	if (wentWrong || technical) {
		const way = !readOnly && wentWrong?.button && !edit ? wentWrong.button : null;
		line("wrong", words.wentWrong, <>
			{wentWrong && <p>{lineText(wentWrong.line, readOnly)}</p>}
			{way === "changeAddress" && canEdit && <button type="button" className="rs-btn connector-way" onClick={() => onEdit({ focus: "address" })}>{WORDS.button.changeAddress}</button>}
			{way === "changeKey" && server.editable && <button type="button" className="rs-btn connector-way" onClick={() => onEdit({ focus: "key" })}>{WORDS.button.changeKey}</button>}
			{way === "tryAgain" && <button type="button" className="rs-btn connector-way" onClick={onTryAgain}>{WORDS.button.tryAgain}</button>}
			{way === "remove" && onRemove && <button type="button" className="rs-btn connector-way" onClick={onRemove}>{WORDS.button.remove}</button>}
			{technical && <TechnicalDetails text={technical} />}
		</>);
	}
	if (web && (!catalogEntry || imported || edit)) {
		line("address", words.address, edit && server.editable ? <AddressEdit server={server} focus={edit.focus} addressFixed={!canEdit} onCancel={() => onEdit(null)} onSaved={onSaved} onOutOfDate={onOutOfDate} onRemove={onRemove} /> : <span className="connector-address">{server.target}</span>);
	}
	if (!web) {
		line("runs", words.runs, <>
			<p>{readOnly ? words.runsHereRemote : words.runsHere}</p>
			<p className="connector-command"><code>{server.target}</code></p>
		</>);
	}
	// Always said, as on a phone the row's rooms link is hidden.
	if (server.usedIn && server.usedIn.length === 0) line("rooms", words.usedIn, <p>{WORDS.roomsLink(0)}</p>);
	if (server.usedIn && server.usedIn.length > 0) {
		line("rooms", words.usedIn, <p className="connector-rooms">
			{server.usedIn.map((room, index) => (
				<span key={room.id}>
					{index > 0 && ", "}
					<a href={appRouteHash({ screen: "room", agentId: room.id })} onClick={(e) => {
						if (!onOpenRoom || e.metaKey || e.ctrlKey || e.shiftKey) return;
						e.preventDefault();
						onOpenRoom(room.id);
					}}>{room.name}</a>
				</span>
			))}
		</p>);
	}
	if (description || (tools && tools.count > 0)) {
		line("can", words.canDo, <>
			{description && <p>{description}</p>}
			{tools && tools.count > 0 && (
				<p>
					{words.toolCount(tools.count)}
					{tools.names.length > 0 && <> · <button type="button" className="connector-text-btn" aria-expanded={showAllTools} onClick={() => onShowAllTools(!showAllTools)}>{showAllTools ? words.showLess : words.showAll}</button></>}
				</p>
			)}
			{showAllTools && tools && <ul className="connector-tool-names">{tools.names.map((toolName, index) => <li key={`${toolName}-${index}`}>{toolTitle(server, toolName)}</li>)}</ul>}
		</>);
	}

	return (
		<div className="connector-details">
			{lines}
			{imported && !readOnly && <p className="connector-note">{WORDS.importedNote(imported)}</p>}
			{fileNote && !readOnly && <p className="connector-note">{fileNote.before}<code>{fileNote.file}</code>{fileNote.after}</p>}
		</div>
	);
}

function TechnicalDetails({ text }: { text: string }) {
	const [copied, setCopied] = useState(false);
	return (
		<details className="remote-fold connector-tech">
			<summary>{WORDS.details.technicalDetails}</summary>
			<div className="connector-tech-body">
				<code>{text}</code>
				<button type="button" className="rs-btn rs-btn-quiet rs-btn-sm rs-quiet" onClick={() => {
					void navigator.clipboard?.writeText(text).then(() => {
						setCopied(true);
						window.setTimeout(() => setCopied(false), 2000);
					}, () => undefined);
				}}>{copied ? WORDS.details.copied : WORDS.details.copy}</button>
			</div>
		</details>
	);
}

/**
 * The address as a field, in the opened row. On another site, a connector
 * with a key asks for it again in the same edit, and the line under it says
 * what the move keeps; one that would lose more than that can't move here.
 * "Change key" opens the same edit with the key field. A directory
 * connector's address is the directory's, so only its key changes
 * (addressFixed). The line for a connector that can't move says to remove
 * it, so Remove sits under it and opens the row's own remove question.
 */
function AddressEdit({ server, focus, addressFixed, onCancel, onSaved, onOutOfDate, onRemove }: { server: McpConnectorStatus; focus: "address" | "key"; addressFixed: boolean; onCancel: () => void; onSaved: (sameSite: boolean, keyOnly: boolean) => Promise<void>; onOutOfDate: (message: string) => Promise<void>; onRemove?: () => void }) {
	const [url, setUrl] = useState(server.target);
	const [key, setKey] = useState("");
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const addressRef = useRef<HTMLInputElement | null>(null);
	const keyRef = useRef<HTMLInputElement | null>(null);
	const editRef = useRef<HTMLDivElement | null>(null);
	const otherSite = !sameConnectorSite(server.target, url.trim());
	const moves = !otherSite || server.movesToAnotherSite;
	// On another site the key is typed again, and Save waits for it.
	const keyAgain = otherSite && moves && server.key !== "none";
	const asksKey = focus === "key" || keyAgain;
	const signedIn = server.auth.mode === "oauth" && server.auth.hasStoredTokens;
	const lines = CONNECTOR_FORM_LINES;
	const hint = !otherSite ? null : !moves ? lines.cantMoveSite : keyAgain ? (signedIn ? lines.anotherSiteKeyAndSignIn : lines.anotherSiteKey) : signedIn ? lines.anotherSiteSignIn : null;
	// Save, by its button or Enter, waits until the address or the key changes, and for a key that is needed.
	const canSave = !saving && moves && Boolean(url.trim()) && (keyAgain ? Boolean(key.trim()) : url.trim() !== server.target || Boolean(key.trim()));

	useEffect(() => {
		if (focus === "key") keyRef.current?.focus();
		else {
			addressRef.current?.focus();
			addressRef.current?.select();
		}
		// Focus brings only the field into view; the opened row's end, under Save, comes too.
		editRef.current?.closest(".connector-item")?.scrollIntoView({ block: "nearest" });
	}, [focus]);

	async function save() {
		setSaving(true);
		setError(null);
		try {
			const result = await changeMcpServerAddress(server.name, { url: url.trim(), ...(key.trim() ? { key: key.trim() } : {}) });
			await onSaved(result.sameSite, Boolean(key.trim()) && url.trim() === server.target);
		} catch (e) {
			if (refusedAs(e, 404, 409)) return void (await onOutOfDate((e as Error).message));
			setError((e as Error).message);
			setSaving(false);
		}
	}

	const keys = (e: React.KeyboardEvent) => {
		// Enter in a field saves; on a button it presses that button.
		if (e.key === "Enter" && (e.target as HTMLElement).tagName === "INPUT") {
			e.preventDefault();
			if (canSave) void save();
		} else if (e.key === "Escape") {
			e.preventDefault();
			e.stopPropagation();
			onCancel();
		}
	};

	return (
		<div ref={editRef} className="connector-edit" onKeyDown={keys}>
			{addressFixed
				? <span className="connector-address">{server.target}</span>
				: <input ref={addressRef} type="text" className="connector-edit-input" aria-label={WORDS.details.address} value={url} onChange={(e) => setUrl(e.target.value)} />}
			{asksKey && <input ref={keyRef} type="password" className="connector-edit-input" aria-label={WORDS.details.key} placeholder={WORDS.details.key} value={key} onChange={(e) => setKey(e.target.value)} />}
			{hint && <p className="connector-edit-hint">{hint}</p>}
			{!moves && onRemove && <button type="button" className="rs-btn connector-way" onClick={onRemove}>{WORDS.button.remove}</button>}
			{error && <p className="connector-row-error" role="alert">{error}</p>}
			<div className="settings-form-foot connector-edit-foot">
				<button type="button" className="rs-btn" disabled={saving} onClick={onCancel}>{WORDS.button.cancel}</button>
				<button type="button" className={`rs-btn rs-btn-primary connector-slot-btn${saving ? " is-busy" : ""}`} disabled={!canSave} aria-busy={saving || undefined} onClick={() => void save()}>
					<span className="connector-slot-label">{WORDS.button.save}</span>
					{saving && <span className="spinner" aria-hidden="true" />}
				</button>
			</div>
		</div>
	);
}

/** The filled header rows as the request's headers; a half-filled row or a name twice is an error in words. */
function headersFromRows(rows: Array<{ name: string; value: string }>): Record<string, string> | undefined {
	const filled = rows.map((row) => ({ name: row.name.trim(), value: row.value.trim() })).filter((row) => row.name || row.value);
	if (filled.length === 0) return undefined;
	const headers: Record<string, string> = {};
	const seen = new Set<string>();
	for (const row of filled) {
		if (!row.name) throw new Error(CONNECTOR_FORM_LINES.headerUnnamed);
		if (!row.value) throw new Error(WORDS.form.headerNoValue(row.name));
		if (seen.has(row.name.toLowerCase())) throw new Error(WORDS.form.headerTwice(row.name));
		seen.add(row.name.toLowerCase());
		headers[row.name] = row.value;
	}
	return headers;
}

function AddConnectorForm({ onAdded, onCancel, prefill, focusFirst }: { onAdded: (name: string, typedName: string) => Promise<void>; onCancel: () => void; prefill?: AddConnectorPrefill; focusFirst?: boolean }) {
	const form = WORDS.form;
	const [name, setName] = useState(prefill?.name ?? "");
	const [kind, setKind] = useState<"url" | "command">("url");
	const [url, setUrl] = useState(prefill?.url ?? "");
	const [bearerToken, setBearerToken] = useState("");
	const [command, setCommand] = useState("");
	const [showOAuthClient, setShowOAuthClient] = useState(prefill?.openOAuthClient ?? false);
	const [oauthClientId, setOauthClientId] = useState("");
	const [oauthClientSecret, setOauthClientSecret] = useState("");
	const [oauthScope, setOauthScope] = useState("");
	const [showHeaders, setShowHeaders] = useState(false);
	const [headerRows, setHeaderRows] = useState<Array<{ name: string; value: string }>>([{ name: "", value: "" }]);
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const blockRef = useRef<HTMLDivElement | null>(null);
	const nameRef = useRef<HTMLInputElement | null>(null);

	// The form opens right under what opened it; scroll only as far as it
	// takes to show it whole, and from the title row start in its first field.
	useEffect(() => {
		blockRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
		if (focusFirst) nameRef.current?.focus({ preventScroll: true });
	}, []);

	async function save() {
		setSaving(true);
		setError(null);
		try {
			const added = kind === "url"
				? await addMcpServer({
						name,
						url: url.trim(),
						bearerToken: bearerToken.trim() || undefined,
						oauth: oauthClientId.trim() || oauthClientSecret.trim() || oauthScope.trim() ? { clientId: oauthClientId.trim(), clientSecret: oauthClientSecret.trim() || undefined, scope: oauthScope.trim() || undefined } : undefined,
						headers: headersFromRows(headerRows),
					})
				: await (() => {
						const parts = command.trim().split(/\s+/);
						return addMcpServer({ name, command: parts[0] ?? "", args: parts.slice(1) });
					})();
			await onAdded(added.name, name);
		} catch (e) {
			setError((e as Error).message);
		} finally {
			setSaving(false);
		}
	}

	return (
		<div className="ai-setup-block connector-custom-form" aria-label={form.title} ref={blockRef}>
			<p className="settings-group-kicker">{form.title}</p>
			{(prefill?.note || prefill?.docsUrl) && (
				<p className="cli-note">
					{prefill.note}
					{prefill.note && prefill.docsUrl && <br />}
					{prefill.docsUrl && <a className="connector-form-guide" href={prefill.docsUrl} target="_blank" rel="noreferrer">Setup guide ↗</a>}
				</p>
			)}
			<div className="connector-form">
				<label className="connector-form-field">
					<span>{form.name}</span>
					<input ref={nameRef} type="text" value={name} maxLength={MAX_CONNECTOR_NAME_LENGTH} placeholder={form.namePlaceholder} onChange={(e) => setName(e.target.value)} />
				</label>
				<div className="connector-form-kind" role="radiogroup" aria-label={form.howItConnects}>
					<label><input type="radio" checked={kind === "url"} onChange={() => setKind("url")} /> {form.web}</label>
					<label><input type="radio" checked={kind === "command"} onChange={() => setKind("command")} /> {form.program}</label>
				</div>
				{kind === "url" ? (
					<>
						<label className="connector-form-field">
							<span>{form.address}</span>
							<input type="text" value={url} placeholder={form.addressPlaceholder} onChange={(e) => setUrl(e.target.value)} />
						</label>
						<label className="connector-form-field">
							<span>{form.key}</span>
							<input type="password" value={bearerToken} onChange={(e) => setBearerToken(e.target.value)} />
						</label>
						<button type="button" className="connector-oauth-toggle" onClick={() => setShowOAuthClient((current) => !current)} aria-expanded={showOAuthClient}>
							<span className="disclosure-chevron" aria-hidden="true" />
							{form.signInApp}
						</button>
						{showOAuthClient && (
							<div className="connector-oauth-fields">
								<p className="cli-note">{form.signInAppHint.before}<code>http://localhost:19876/callback</code>{form.signInAppHint.after}</p>
								<label className="connector-form-field">
									<span>{form.clientId}</span>
									<input type="text" value={oauthClientId} onChange={(e) => setOauthClientId(e.target.value)} />
								</label>
								<label className="connector-form-field">
									<span>{form.clientSecret}</span>
									<input type="password" value={oauthClientSecret} onChange={(e) => setOauthClientSecret(e.target.value)} />
								</label>
								<label className="connector-form-field">
									<span>{form.scopes}</span>
									<input type="text" value={oauthScope} placeholder="crm.objects.contacts.read" onChange={(e) => setOauthScope(e.target.value)} />
								</label>
							</div>
						)}
						<button type="button" className="connector-oauth-toggle" onClick={() => setShowHeaders((current) => !current)} aria-expanded={showHeaders}>
							<span className="disclosure-chevron" aria-hidden="true" />
							{form.headers}
						</button>
						{showHeaders && (
							<div className="connector-oauth-fields">
								<p className="cli-note">{form.headersHint.before}<code>{form.headersHint.example}</code>{form.headersHint.after}</p>
								{headerRows.map((row, index) => (
									<div className="connector-header-row" key={index}>
										<div className="connector-form-field">
											<input type="text" aria-label={form.headerName(index + 1)} value={row.name} placeholder="X-Api-Key" onChange={(e) => setHeaderRows((rows) => rows.map((r, i) => (i === index ? { ...r, name: e.target.value } : r)))} />
										</div>
										<div className="connector-form-field">
											<input type="password" aria-label={form.headerValue(index + 1)} value={row.value} placeholder="Value" onChange={(e) => setHeaderRows((rows) => rows.map((r, i) => (i === index ? { ...r, value: e.target.value } : r)))} />
										</div>
										<button type="button" className="rs-btn rs-btn-icon rs-btn-sm connector-header-remove" aria-label={form.removeHeader(index + 1)} onClick={() => setHeaderRows((rows) => (rows.length > 1 ? rows.filter((_, i) => i !== index) : [{ name: "", value: "" }]))}><CloseIcon size={14} /></button>
									</div>
								))}
								<button type="button" className="connector-text-btn connector-header-add" onClick={() => setHeaderRows((rows) => [...rows, { name: "", value: "" }])}>{form.addHeader}</button>
							</div>
						)}
					</>
				) : (
					<label className="connector-form-field">
						<span>{form.command}</span>
						<input type="text" className="connector-command-input" value={command} placeholder="npx -y @modelcontextprotocol/server-filesystem /path/to/root" onChange={(e) => setCommand(e.target.value)} aria-describedby="connector-command-hint" />
						<span className="connector-form-hint" id="connector-command-hint">{form.commandHint}</span>
					</label>
				)}
				{error && <div className="checkpoint-proposal-error" role="alert">{error}</div>}
				<div className="settings-form-foot">
					<button className="rs-btn" disabled={saving} onClick={onCancel}>{form.cancel}</button>
					<button className="rs-btn rs-btn-primary" disabled={saving || !name.trim() || (kind === "url" ? !url.trim() : !command.trim())} onClick={() => void save()}>
						{saving ? form.adding : form.add}
					</button>
				</div>
			</div>
		</div>
	);
}

function ConnectorAvatar({ id, name, size = 34 }: { id: string; name: string; size?: number }) {
	const icon = CONNECTOR_ICONS[id];
	const glyph = Math.round(size * 0.6);
	return (
		<span className="connector-avatar" style={{ width: size, height: size }}>
			{icon ? (
				<svg viewBox="0 0 24 24" width={glyph} height={glyph} aria-hidden="true"><path d={icon} fill="currentColor" /></svg>
			) : (
				name.slice(0, 1).toUpperCase()
			)}
		</span>
	);
}

/** Prefill for the custom form when a directory card routes into it. */
export interface AddConnectorPrefill {
	name?: string;
	url?: string;
	note?: string;
	/** The provider's own setup guide, linked under the note. */
	docsUrl?: string;
	openOAuthClient?: boolean;
}

function DirectoryCard({ entry, installed, onAdd, onOpenCustom, tokenOpen, onTokenOpen, customForm }: { entry: ConnectorCatalogEntry; installed: boolean; onAdd: (entry: ConnectorCatalogEntry, token?: string) => Promise<void>; onOpenCustom: (prefill?: AddConnectorPrefill) => void; tokenOpen: boolean; onTokenOpen: (open: boolean) => void; customForm: React.ReactNode }) {
	const [token, setToken] = useState("");
	const [adding, setAdding] = useState(false);
	const [error, setError] = useState<string | null>(null);

	async function add(withToken?: string) {
		setAdding(true);
		setError(null);
		try {
			await onAdd(entry, withToken);
			onTokenOpen(false);
			setToken("");
		} catch (e) {
			setError((e as Error).message);
		} finally {
			setAdding(false);
		}
	}

	// One Add carries every kind: open and oauth entries add directly, token
	// entries open the key row under this one, oauth-client entries open the
	// prefilled custom form. Guided entries link out to their setup guide.
	// The tag beside the name says which flow Add opens.
	const addLabel = WORDS.directoryAdd(entry);

	return (
		<div className="connector-dir-row-group">
			<div className="settings-row connector-dir-row">
				<ConnectorAvatar id={entry.id} name={entry.name} size={32} />
				<div className="settings-row-main">
					<span className="settings-row-label">{entry.name}<span className="connector-dir-kind">{WORDS.directoryTags[entry.kind]}</span></span>
					<span className="settings-row-sub settings-row-clamp" title={entry.description}>{entry.description}</span>
					{entry.shortNote && <span className="connector-dir-note">{entry.shortNote}</span>}
				</div>
				{installed ? (
					<span className="settings-row-value" aria-label={`${entry.name} is added`}>Added</span>
				) : entry.kind === "guided" ? (
					entry.docsUrl && (
						<a className="rs-btn" href={entry.docsUrl} target="_blank" rel="noreferrer" aria-label={`${entry.name} setup guide`}>Setup guide ↗</a>
					)
				) : entry.kind === "token" && tokenOpen ? (
					<button className="rs-btn" disabled={adding} onClick={() => { onTokenOpen(false); setToken(""); }}>Cancel</button>
				) : (
					<button
						className="rs-btn"
						disabled={adding}
						title={addLabel}
						aria-label={addLabel}
						aria-expanded={entry.kind === "token" ? tokenOpen : undefined}
						onClick={() => {
							if (entry.kind === "oauth-client") onOpenCustom({ name: entry.name, url: entry.url, note: entry.guideNote, docsUrl: entry.docsUrl, openOAuthClient: true });
							else if (entry.kind === "token") onTokenOpen(true);
							else void add();
						}}
					>
						{adding ? "Adding…" : "Add"}
					</button>
				)}
			</div>
			{tokenOpen && !installed && (
				<div className="connector-dir-token-row">
					<input
						type="password"
						className="launcher-path-input connector-dir-token-input"
						placeholder={entry.tokenHint ?? WORDS.directoryKeyPlaceholder}
						value={token}
						autoFocus
						onChange={(e) => setToken(e.target.value)}
						onKeyDown={(e) => { if (e.key === "Enter" && token.trim()) void add(token.trim()); }}
					/>
					<button className="rs-btn rs-btn-primary" disabled={adding || !token.trim()} onClick={() => void add(token.trim())}>
						{adding ? "Adding…" : "Add"}
					</button>
					{entry.docsUrl && (
						<a className="rs-btn rs-btn-quiet rs-btn-sm rs-quiet" href={entry.docsUrl} target="_blank" rel="noreferrer">Where do I get one? ↗</a>
					)}
				</div>
			)}
			{customForm}
			{error && <p className="connector-dir-note connector-outcome-error">{error}</p>}
		</div>
	);
}

// One form open at a time in the directory: a key row or the custom form,
// under the row that opened it ("" is the custom connector row itself).
function ConnectorDirectory({ status, onChanged, onNotice, customFor, onOpenCustom, onCloseCustom, customForm, searchRef }: { status: McpConnectorsStatusResponse | null; onChanged: () => Promise<void>; onNotice: (text: string) => void; customFor: string | null; onOpenCustom: (at: string, prefill?: AddConnectorPrefill) => void; onCloseCustom: () => void; customForm: React.ReactNode; searchRef: RefObject<HTMLInputElement> }) {
	const [query, setQuery] = useState("");
	const [tokenOpenId, setTokenOpenId] = useState<string | null>(null);
	const openCustom = (at: string, prefill?: AddConnectorPrefill) => {
		setTokenOpenId(null);
		onOpenCustom(at, prefill);
	};

	const configured = status?.servers ?? [];
	const isInstalled = (entry: ConnectorCatalogEntry) =>
		configured.some((server) => server.name === entry.id || (entry.url && server.target === entry.url));

	const q = query.trim().toLowerCase();
	const entries = CONNECTOR_CATALOG.filter(
		(entry) => !q || entry.name.toLowerCase().includes(q) || entry.description.toLowerCase().includes(q),
	);

	async function add(entry: ConnectorCatalogEntry, token?: string) {
		await addMcpServer({ name: entry.id, url: entry.url, bearerToken: token });
		onNotice(addedNotice(entry));
		await onChanged();
	}

	return (
		<section className="ai-setup-section settings-group" aria-label="Connector directory">
			<GroupHeader
				kicker="Directory"
				line="Apps you can add. Each one says what it needs to connect."
				actions={(
					<input
						ref={searchRef}
						type="search"
						className="launcher-path-input connector-dir-search"
						placeholder="Search connectors…"
						value={query}
						onChange={(e) => setQuery(e.target.value)}
						aria-label="Search connectors"
					/>
				)}
			/>
			<div className="settings-rows">
				{entries.map((entry) => (
					<DirectoryCard
						key={entry.id}
						entry={entry}
						installed={isInstalled(entry)}
						onAdd={add}
						onOpenCustom={(prefill) => openCustom(entry.id, prefill)}
						tokenOpen={tokenOpenId === entry.id}
						onTokenOpen={(open) => {
							setTokenOpenId(open ? entry.id : null);
							if (open) onCloseCustom();
						}}
						customForm={customFor === entry.id ? customForm : null}
					/>
				))}
				<div className="connector-dir-row-group">
					<div className="settings-row connector-dir-row">
						<span className="connector-avatar" style={{ width: 32, height: 32 }}>+</span>
						<div className="settings-row-main">
							<span className="settings-row-label">Custom connector<span className="connector-dir-kind">{WORDS.tagCustom}</span></span>
							<span className="settings-row-sub">Add any connector that isn't in the list.</span>
						</div>
						<button className="rs-btn" onClick={() => openCustom("")} disabled={customFor === ""} title={customFor === "" ? "Fill in the form below" : "Add a custom connector"} aria-label="Add a custom connector">Add</button>
					</div>
					{customFor === "" && customForm}
				</div>
			</div>
			{entries.length === 0 && <p className="cli-note">No matches. Use the custom connector row to add one.</p>}
		</section>
	);
}

/** Where the custom form is open: under the title row's button, the directory's custom row (""), or a directory entry's id. */
type FormAt = { at: "title" | string; prefill?: AddConnectorPrefill };

export function ConnectorsPage({ serviceBack, onOpenRoom }: { /** Counts the page's reconnects after an outage. */ serviceBack?: number; /** Leaves Settings for a room named in a connector's details. */ onOpenRoom?: (agentId: string) => void }) {
	const [status, setStatus] = useState<McpConnectorsStatusResponse | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [loading, setLoading] = useState(true);
	const [formAt, setFormAt] = useState<FormAt | null>(null);
	const [openRow, setOpenRow] = useState<string | null>(null);
	const [notice, setNotice] = useState<string | null>(null);
	// The checks this page ran, newer than what the server kept.
	const [checks, setChecks] = useState<Record<string, McpConnectorCheck | null>>({});
	// The connectors seen since the page opened: each is checked in the background once at most.
	const backgroundChecked = useRef(new Set<string>());
	const searchRef = useRef<HTMLInputElement>(null);
	// Remote devices may read connector status, but the server's remote route
	// policy keeps add, remove, sign-in, sign-out, checks and address changes
	// local-only, so the section renders read-only over the tunnel. On a shared
	// server the status is not read at all (it shows every connector's address
	// or command line, which only the admin may see): one line says who sets
	// connectors up, and each room still chooses its own in room settings.
	const remoteClient = useRemoteClientContext();
	const readOnly = remoteClient.remote;

	const refresh = useCallback(async () => {
		setError(null);
		try {
			if ((await fetchRemoteClientContext()).sharedServer) return;
			setStatus(await fetchMcpConnectorsStatus());
		} catch (e) {
			setError((e as Error).message);
		} finally {
			setLoading(false);
		}
	}, []);

	useEffect(() => {
		void refresh();
	}, [refresh]);

	// A line saying the service could not be reached goes once it answers again
	// after an outage, and the connectors are read again.
	useEffect(() => {
		if (isServiceUnreachableLine(error)) void refresh();
	}, [serviceBack]);

	const onCheck = useCallback((name: string, check: McpConnectorCheck | null) => {
		setChecks((current) => ({ ...current, [name]: check }));
	}, []);

	// Once per opening, and once for a connector added while it is open: each
	// row shows what was last known at once, and the web connectors that can be
	// checked are checked behind it; a row changes only when its check says
	// something new.
	useEffect(() => {
		if (!status || readOnly) return;
		const seen = backgroundChecked.current;
		const due = status.servers.filter((server) => !seen.has(server.name) && checksInBackground(server, connectorRowState(server, server.lastCheck, null)));
		for (const server of status.servers) seen.add(server.name);
		if (due.length === 0) return;
		void Promise.allSettled(due.map(async (server) => {
			const result = await testMcpServer(server.name);
			// A check that outlived a change to its connector says nothing about it now.
			if (!result.superseded) onCheck(server.name, checkOf(result));
		})).then(() => refresh());
	}, [status, readOnly, onCheck, refresh]);

	const servers = status?.servers ?? [];
	const exxSource = status?.configSources.find((source) => source.path.includes(".exxperts"));
	const sharedSource = status?.configSources.find((source) => !source.path.includes(".exxperts"));

	if (remoteClient.sharedServer) {
		return (
			<>
				<PaneHeader title={WORDS.title} line={WORDS.sharedServerSubtitle} />
				<section className="ai-setup-section" aria-label={WORDS.title}>
					<p className="cli-note">{SHARED_SERVER_ADMIN_LINE}</p>
					<p className="cli-note">Rooms choose their connectors in room settings.</p>
				</section>
			</>
		);
	}

	const closeForm = () => setFormAt(null);
	const customForm = formAt ? (
		<AddConnectorForm
			key={`${formAt.at}:${formAt.prefill?.name ?? "blank"}`}
			prefill={formAt.prefill}
			focusFirst={formAt.at === "title"}
			onAdded={async (name, typedName) => {
				const fromDirectory = CONNECTOR_CATALOG.find((entry) => entry.id === formAt.at);
				setFormAt(null);
				setNotice(fromDirectory ? addedNotice(fromDirectory) : WORDS.addedCustom(connectorShownName(name, connectorDisplayName(typedName))));
				await refresh();
			}}
			onCancel={closeForm}
		/>
	) : null;

	return (
		<>
			<PaneHeader
				title={WORDS.title}
				line={lineText(WORDS.subtitle, readOnly)}
				actions={readOnly ? undefined : (
					<button type="button" className="rs-btn" aria-expanded={formAt?.at === "title"} onClick={() => setFormAt(formAt?.at === "title" ? null : { at: "title" })}>{WORDS.addCustom}</button>
				)}
			/>
			<section className="ai-setup-section settings-group connector-list-section" aria-label={WORDS.listTitle}>
				<GroupHeader kicker={WORDS.listTitle} />
				{notice && <p className="cli-note connector-notice" role="status">{notice}</p>}
				{error && (
					<div className="checkpoint-proposal-error connector-load-error">
						<span>{error}</span>
						<button type="button" className="rs-btn" onClick={() => {
							setLoading(true);
							void refresh();
						}}>{WORDS.loadAgain}</button>
					</div>
				)}
				{formAt?.at === "title" && customForm}
				{!error && loading && !status && <p className="ai-setup-copy">Loading connectors…</p>}
				{!error && servers.length > 0 && (
					<div className="connector-list">
						{servers.map((server) => (
							<ConnectorRow
								key={server.name}
								server={server}
								check={server.name in checks ? checks[server.name] : server.lastCheck}
								open={openRow === server.name}
								onToggle={() => setOpenRow((current) => (current === server.name ? null : server.name))}
								onCheck={onCheck}
								onChanged={refresh}
								onNotice={setNotice}
								onOpenRoom={onOpenRoom}
								readOnly={readOnly}
								sharedFile={sharedSource?.path ?? null}
							/>
						))}
					</div>
				)}
				{!error && !loading && servers.length === 0 && (
					readOnly ? (
						<p className="cli-note">{WORDS.setUpOnComputer}</p>
					) : (
						<p className="settings-empty">
							{WORDS.noneYet} {WORDS.empty.before}
							<button type="button" className="connector-text-btn" onClick={() => {
								searchRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
								searchRef.current?.focus({ preventScroll: true });
							}}>{WORDS.empty.link}</button>
							{WORDS.empty.after}
						</p>
					)
				)}
				{readOnly && servers.length > 0 && <p className="cli-note">{WORDS.setUpOnComputer}</p>}
			</section>
			{!readOnly && (
				<ConnectorDirectory
					status={status}
					onChanged={refresh}
					onNotice={setNotice}
					searchRef={searchRef}
					customFor={formAt && formAt.at !== "title" ? formAt.at : null}
					onOpenCustom={(at, prefill) => setFormAt({ at, prefill })}
					onCloseCustom={closeForm}
					customForm={formAt && formAt.at !== "title" ? customForm : null}
				/>
			)}
			{status && (
				<section className="ai-setup-section connector-config-note" aria-label="Where connectors are stored">
					<details className="remote-fold">
						<summary>Where this list lives</summary>
						<p className="cli-note">
							Saved to <code>{exxSource?.path ?? "~/.exxperts/agent/mcp.json"}</code>.
							{sharedSource && (
								<> {WORDS.sharedFile.before}<code>{sharedSource.path}</code>{WORDS.sharedFile.after}</>
							)}
						</p>
						<p className="cli-note">
							Full reference: <code>docs/mcp.md</code>.
						</p>
					</details>
					<p className="cli-note">All product names and logos are trademarks of their respective owners, used for identification only.</p>
				</section>
			)}
		</>
	);
}
