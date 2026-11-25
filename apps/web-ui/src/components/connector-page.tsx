import { useEffect, useRef, useState, type ReactNode } from "react";
import { changeMcpServerAddress, McpRequestError, resetMcpToolChoices, setMcpServerToolChoice, type McpConnectorStatus } from "../mcp-api";
import { CONNECTOR_ICONS } from "../connector-icons";
import {
	addedInFile,
	catalogEntryOf,
	CONNECTOR_WORDS,
	importedFrom,
	isCustom,
	isSignedIn,
	isUnderWay,
	keyRow,
	noSignInLine,
	lineText,
	removableHere,
	rowLook,
	RUNTIME_INSTALL_URL,
	shownName,
	signInOffered,
	technicalDetails,
	toolGroups,
	wentWrongLine,
	type RowButton,
	type RowState,
	type ToolLine,
	type WentWrongButton,
} from "../connector-rows";
import { CONNECTOR_FORM_LINES, CONNECTOR_REQUEST_LINES, sameConnectorSite } from "../../../web-server/src/connector-form";
import { CONNECTOR_TOOL_CHOICES, type ConnectorToolChoice } from "../../../web-server/src/room-approval-titles";
import { appRouteHash } from "../app-route";
import { AiProfileRowMenu } from "./ai-profile-switcher";
import { confirmDialog } from "./confirm-dialog";
import { GroupHeader, PaneBack, PaneHeader } from "./pane-header";
import { useEscapeKey } from "./use-escape-key";
import { ChevronDownIcon } from "./icons";
import { useSettingsLookNext } from "../settings-look";

const WORDS = CONNECTOR_WORDS;

/** An answer that says the page's list is out of date: 404, the connector no longer exists; 409 on a change, it can't be changed here. */
export const refusedAs = (e: unknown, ...statuses: number[]) => e instanceof McpRequestError && statuses.includes(e.status);

/** A connector's last failure, and the step its line offers: Remove again, or Reset choices where the choices can't be read. */
export type ConnectorFailure = { text: string; retry: "remove" | "reset" | null };

/**
 * What the Connectors pane does for a connector, for its row and for its own
 * page alike: one owner above both keeps a check or a sign-in going while the
 * person moves between them.
 */
export interface ConnectorWork {
	state(server: McpConnectorStatus): RowState;
	/** Its state as last known, whatever runs on it now. */
	known(server: McpConnectorStatus): RowState;
	/** The button the person pressed for this connector, busy until its work ends. */
	busy(name: string): ConnectorButton | null;
	/** What last failed for this connector, and the step its line offers. */
	failure(name: string): ConnectorFailure | null;
	/** A state's own button: Connect, Reconnect, Try again or Cancel (which also stops a program getting ready). */
	press(server: McpConnectorStatus, button: RowButton): void;
	check(server: McpConnectorStatus): void;
	disconnect(server: McpConnectorStatus): void;
	/** Asks in the app's dialog, then removes it from every room and the app; without asking when it is a Try again. */
	remove(server: McpConnectorStatus, asked?: boolean): void;
	/** A new address or key was saved (keyOnly: the key alone): the list is read again, and checked where a check can tell. */
	saved(server: McpConnectorStatus, sameSite: boolean, keyOnly: boolean): Promise<void>;
	/** A change refused because the list is out of date: it is read again, and the line says why. */
	outOfDate(server: McpConnectorStatus, message: string): Promise<void>;
	/** A tool's choice was saved, or may have been: the list is read again, so the page shows what is saved. The connector as read, or null when the read failed. */
	choicesSaved(server: McpConnectorStatus): Promise<McpConnectorStatus | null>;
	/** The choices were reset, or found readable again: the list is read again, and this connector's last failure, which may name them, goes. */
	choicesReset(server: McpConnectorStatus): Promise<void>;
}

export type ConnectorButton = RowButton | "checkConnection" | "disconnect" | "remove";

/** What a fix's button opens on the connector's own page. */
export type ConnectorEdit = "address" | "key";

/** A button that keeps its width while busy: its words stay in place, hidden, under a small spinner. small: the family's size for a row. */
export function SlotButton({ label, busy, onClick, disabled = false, small = false }: { label: string; busy: boolean; onClick: () => void; disabled?: boolean; small?: boolean }) {
	return (
		<button type="button" className={`rs-btn${small ? " rs-btn-sm" : ""} connector-slot-btn${busy ? " is-busy" : ""}`} aria-busy={busy || undefined} disabled={busy || disabled} onClick={onClick}>
			<span className="connector-slot-label">{label}</span>
			{busy && <span className="spinner" aria-hidden="true" />}
		</button>
	);
}

/** letters: how many initials stand in for a service with no mark of its own, the first letters of the name's first words. */
export function ConnectorAvatar({ id, name, size = 34, letters = 1 }: { id: string; name: string; size?: number; letters?: 1 | 2 }) {
	const icon = CONNECTOR_ICONS[id];
	const glyph = Math.round(size * 0.6);
	return (
		<span className="connector-avatar" style={{ width: size, height: size }}>
			{icon ? (
				<svg viewBox="0 0 24 24" width={glyph} height={glyph} aria-hidden="true"><path d={icon} fill="currentColor" /></svg>
			) : (
				letters === 1 ? name.slice(0, 1).toUpperCase() : name.split(/\s+/).filter(Boolean).slice(0, letters).map((word) => word.slice(0, 1)).join("").toUpperCase()
			)}
		</span>
	);
}

/** The tag beside a connector's name: where it came from, when that isn't the directory. */
export function connectorTag(server: McpConnectorStatus): string | null {
	const imported = importedFrom(server);
	return imported ? WORDS.tagImported(imported) : isCustom(server) ? WORDS.tagCustom : null;
}

/** A fix's button wherever a fix is offered: on the row and on the page. The ways that open something come from the view. small: the family's size for a row. onRow: in a row's one slot. */
export function FixButton({ server, button, work, onEdit, small = false, onRow = false }: { server: McpConnectorStatus; button: RowButton | WentWrongButton; work: ConnectorWork; onEdit: (edit: ConnectorEdit) => void; small?: boolean; onRow?: boolean }) {
	const busy = work.busy(server.name);
	// A missing runtime's link; on the page, then Try again for when it has been installed. A row has room for the link alone.
	if (button === "installNode" || button === "installUv") {
		const link = <a className={`rs-btn${small ? " rs-btn-sm" : ""} connector-slot-btn connector-way-link`} href={RUNTIME_INSTALL_URL[button]} target="_blank" rel="noreferrer">{WORDS.button.install}</a>;
		return onRow ? link : (
			<>
				{link}
				<FixButton server={server} button="tryAgain" work={work} onEdit={onEdit} small={small} />
			</>
		);
	}
	if (button === "changeAddress" || button === "changeKey") return <SlotButton label={WORDS.button[button]} busy={false} small={small} onClick={() => onEdit(button === "changeKey" ? "key" : "address")} />;
	if (button === "checkConnection") return <SlotButton label={WORDS.button.checkConnection} busy={busy === "checkConnection"} disabled={isUnderWay(work.state(server))} small={small} onClick={() => work.check(server)} />;
	if (button === "remove") return <SlotButton label={WORDS.button.remove} busy={busy === "remove"} small={small} onClick={() => work.remove(server)} />;
	// While its own work runs the pressed button stays, busy; a program getting ready offers Cancel.
	const shown: RowButton = busy === "connect" || busy === "reconnect" || busy === "tryAgain" || busy === "cancel" ? busy : button;
	return <SlotButton label={WORDS.button[shown]} busy={busy === shown} small={small} onClick={() => work.press(server, button)} />;
}

/** A web address that may break after each "/" before it breaks inside a word; copied, it reads whole. */
function addressBreaks(address: string): ReactNode {
	return address.split(/(?<=\/)/).flatMap((part, index) => (index === 0 ? [part] : [<wbr key={index} />, part]));
}

/** A program's command that breaks between its words, never inside one that fits a line (a flag stays whole). */
function commandWords(command: string): ReactNode {
	return command.split(" ").flatMap((word, index) => [...(index === 0 ? [] : [" "]), <span key={index} className="connector-command-word">{word}</span>]);
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

/** One fact of the page: its label and line on the left, its value and action on the right. */
function Fact({ label, sub, value, action, className }: { label: string; sub?: ReactNode; value?: ReactNode; action?: ReactNode; className?: string }) {
	return (
		<div className={`settings-row connector-fact${className ? ` ${className}` : ""}`}>
			<div className="settings-row-main">
				<span className="settings-row-label">{label}</span>
				{sub && <span className="settings-row-sub">{sub}</span>}
			</div>
			{(value || action) && (
				<span className="connector-fact-value">
					{value}
					{action}
				</span>
			)}
		</div>
	);
}

/** Arrow keys move through a menu's items, and Tab closes it (Escape is the layer stack's, through useEscapeKey). */
export function menuKeys(e: React.KeyboardEvent, close: () => void) {
	const items = [...(e.currentTarget.ownerDocument.querySelectorAll<HTMLButtonElement>(".ai-profile-menu [role^=menuitem]"))];
	const at = items.indexOf(e.target as HTMLButtonElement);
	if (e.key === "Tab") {
		e.preventDefault();
		close();
	} else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
		e.preventDefault();
		items[(at + (e.key === "ArrowDown" ? 1 : items.length - 1)) % items.length]?.focus();
	} else if (e.key === "Home" || e.key === "End") {
		e.preventDefault();
		items[e.key === "Home" ? 0 : items.length - 1]?.focus();
	}
}

/** A tool's choice as a button that opens its menu: the three choices and Use default, the one in force checked. `pick` gets null for Use default. */
function ToolChoiceMenu({ tool, busy, locked, onPick }: { tool: ToolLine; busy: boolean; locked: boolean; onPick: (choice: ConnectorToolChoice | null) => void }) {
	const [open, setOpen] = useState(false);
	const next = useSettingsLookNext();
	const buttonRef = useRef<HTMLButtonElement | null>(null);
	const checkedRef = useRef<HTMLButtonElement | null>(null);
	const words = WORDS.tools.choices[tool.choice];
	const checked: ConnectorToolChoice | "default" = tool.source === "chosen" ? tool.choice : "default";
	// The menu stays hidden until it has measured where it fits, and a hidden item can't take the focus, so it moves on the next frame.
	useEffect(() => {
		if (!open) return;
		const frame = requestAnimationFrame(() => checkedRef.current?.focus());
		return () => cancelAnimationFrame(frame);
	}, [open]);
	const close = (returnFocus = true) => {
		setOpen(false);
		if (returnFocus) buttonRef.current?.focus();
	};
	useEscapeKey(() => close(), open);
	const item = (value: ConnectorToolChoice | "default", label: string) => (
		<button key={value} type="button" role="menuitemradio" aria-checked={checked === value} ref={checked === value ? checkedRef : undefined} className="ai-profile-menu-item connector-menu-item connector-choice-item" onClick={() => {
			close();
			if (value !== checked) onPick(value === "default" ? null : value);
		}}>{label}</button>
	);
	return (
		<span className="ai-profile-menu-anchor">
			<button type="button" ref={buttonRef} className={`rs-btn rs-btn-sm connector-choice-btn connector-slot-btn${busy ? " is-busy" : ""}`} data-choice={tool.choice} aria-haspopup="menu" aria-expanded={open} aria-busy={busy || undefined} disabled={busy || locked} aria-label={WORDS.tools.choiceLabel(tool.title, words)} onClick={() => (open ? close() : setOpen(true))}>
				{/* Every choice's words sit unseen in the same cell, so each tool's button is as wide as the widest and the rows line up. */}
				<span className="connector-choice-face">
					<span className="connector-slot-label">{words}</span>
					{CONNECTOR_TOOL_CHOICES.map((choice) => <span key={choice} className="connector-choice-sizer" aria-hidden="true">{WORDS.tools.choices[choice]}</span>)}
					{/* The settings look's select: its value on the left, this chevron at its right end. */}
					{next && <span className="connector-choice-chevron" aria-hidden="true"><ChevronDownIcon size={12} /></span>}
				</span>
				{busy && <span className="spinner" aria-hidden="true" />}
			</button>
			{open && (
				<span onKeyDown={(e) => menuKeys(e, () => close())}>
					<AiProfileRowMenu anchorRef={buttonRef} onDismiss={() => close()}>
						{CONNECTOR_TOOL_CHOICES.map((choice) => item(choice, WORDS.tools.choices[choice]))}
						{item("default", WORDS.tools.useDefault)}
					</AiProfileRowMenu>
				</span>
			)}
		</span>
	);
}

/** A tool's saved choice in a connector as read, by its own key; null when nothing is chosen. */
function savedChoice(server: McpConnectorStatus, tool: string): ConnectorToolChoice | null {
	return server.choices && Object.hasOwn(server.choices, tool) ? server.choices[tool] : null;
}

/**
 * One group of the connector's tools, each with what it may do. At the
 * computer a tool takes a choice from its menu; over remote access, a tool
 * its entry switches off by hand, or one whose choice couldn't be read shows
 * the words alone.
 * While one tool's choice saves, every menu waits, so answers can't cross.
 * A tool whose save can't be told saved or not shows no choice, only Try
 * again, which reads the choices again; every other menu waits for it.
 */
function ToolGroup({ title, tools, readOnly, saving, failed, unsure, onPick, onCheckAgain }: { title: string; tools: ToolLine[]; readOnly: boolean; saving: string | null; failed: string | null; unsure: string | null; onPick: (tool: string, choice: ConnectorToolChoice | null) => void; onCheckAgain: () => void }) {
	// The settings look cuts a tool's line to one, so the whole line is its tip.
	const next = useSettingsLookNext();
	if (tools.length === 0) return null;
	return (
		<>
			<p className="connector-tools-kicker">{title}</p>
			<div className="settings-rows connector-tools">
				{tools.map((tool) => (
					<div key={tool.name} className="settings-row connector-tool" data-tool={tool.name}>
						<div className="settings-row-main">
							<span className="settings-row-label">{tool.title}</span>
							{tool.description && <span className="settings-row-sub" title={next ? tool.description : undefined}>{tool.description}</span>}
							{failed === tool.name && <span className="connector-row-error" role="alert" title={next ? CONNECTOR_REQUEST_LINES.saveFailed : undefined}>{CONNECTOR_REQUEST_LINES.saveFailed}</span>}
							{unsure === tool.name && <span className="connector-row-error" role="alert" title={next ? WORDS.tools.unsure : undefined}>{WORDS.tools.unsure}</span>}
						</div>
						{unsure === tool.name ? (
							<span className="connector-choice">
								<SlotButton label={WORDS.button.tryAgain} busy={saving === tool.name} disabled={saving !== null} small={next} onClick={onCheckAgain} />
							</span>
						) : (
							<span className="connector-choice">
								{readOnly || tool.source === "excluded" || tool.source === "unknown"
									? <span className="connector-choice-words" data-choice={tool.choice}>{WORDS.tools.choices[tool.choice]}</span>
									: <ToolChoiceMenu tool={tool} busy={saving === tool.name} locked={saving !== null || unsure !== null} onPick={(choice) => onPick(tool.name, choice)} />}
							</span>
						)}
					</div>
				))}
			</div>
		</>
	);
}

/**
 * A connector's own page: what it is and where it is on, the one step its
 * state asks for, its tools in two groups, and Remove at the end. Opening it
 * starts nothing: a program is started only by Check connection.
 */
export function ConnectorPage({ server, work, readOnly, sharedFile, edit, onEdit, onBack, onOpenRoom, notice }: {
	server: McpConnectorStatus;
	/** A line about what was just done here, such as a saved address. */
	notice: string | null;
	work: ConnectorWork;
	readOnly: boolean;
	/** The shared connector file's path, as the list's rows from it name it. */
	sharedFile: string | null;
	edit: ConnectorEdit | null;
	onEdit: (edit: ConnectorEdit | null) => void;
	onBack: () => void;
	onOpenRoom?: (agentId: string) => void;
}) {
	const next = useSettingsLookNext();
	const name = shownName(server);
	const state = work.state(server);
	const look = rowLook(state, readOnly);
	const busy = work.busy(server.name);
	const failure = work.failure(server.name);
	const wentWrong = wentWrongLine(server, state, readOnly);
	const technical = technicalDetails(state);
	const imported = importedFrom(server);
	const fileNote = addedInFile(server, sharedFile);
	const tag = connectorTag(server);
	const web = server.transport === "http";
	const signedIn = isSignedIn(server);
	const canChangeAddress = !readOnly && server.editable && isCustom(server);
	const key = keyRow(server, readOnly);
	// A check says nothing about the sign-in until it ends: the Sign-in row stays as it was, so nothing under it moves.
	const offersSignIn = signInOffered(server, state.kind === "checking" ? work.known(server) : state, readOnly);
	const noSignIn = noSignInLine(server, state);
	// The choices as last saved here, until the list read again brings them.
	const [choices, setChoices] = useState(server.choices);
	const [saving, setSaving] = useState<string | null>(null);
	const [failed, setFailed] = useState<string | null>(null);
	// A save that can't be told saved or not, with the choice it tried: every menu waits until Try again reads it.
	const [unsure, setUnsure] = useState<{ tool: string; choice: ConnectorToolChoice | null } | null>(null);
	const choicesKey = JSON.stringify(server.choices ?? null);
	// A read that brings other choices, by Try again or any other read: what it says is saved replaces what this page last knew.
	useEffect(() => {
		setChoices(server.choices);
		setUnsure(null);
	}, [choicesKey]);
	const groups = toolGroups({ ...server, choices });
	const pick = async (tool: string, choice: ConnectorToolChoice | null) => {
		setSaving(tool);
		setFailed(null);
		setUnsure(null);
		try {
			setChoices((await setMcpServerToolChoice(server.name, tool, choice, server.identity)).choices);
			await work.choicesSaved(server);
		} catch (e) {
			// Changed or gone since the page showed it: the list is read again, and the line says why.
			if (refusedAs(e, 404, 409)) await work.outOfDate(server, (e as Error).message);
			else {
				// A failure can come after the save, or the answer can be lost: the control shows what the list read again says is saved,
				// and where that read fails too, no choice at all.
				const now = await work.choicesSaved(server);
				if (!now) setUnsure({ tool, choice });
				else {
					setChoices(now.choices);
					if (savedChoice(now, tool) !== choice) setFailed(tool);
				}
			}
		} finally {
			setSaving(null);
		}
	};
	// Try again where a save couldn't be told saved or not: the choices are read again.
	const checkAgain = async ({ tool, choice }: { tool: string; choice: ConnectorToolChoice | null }) => {
		setSaving(tool);
		try {
			const now = await work.choicesSaved(server);
			if (now) {
				setChoices(now.choices);
				setUnsure(null);
				if (savedChoice(now, tool) !== choice) setFailed(tool);
			}
		} finally {
			setSaving(null);
		}
	};
	// Reset choices, where they can't be read: asked first, since a tool the person blocked is no longer blocked after it.
	const [resetting, setResetting] = useState(false);
	// A failed reset says so once: in the removal's line it was pressed in while that line is up, and under Tools otherwise. Any later removal line, from whichever Remove, is a new one and shows its own words.
	const [resetFailure, setResetFailure] = useState<{ text: string; inLine: ConnectorFailure | null } | null>(null);
	const resetChoices = async (inLine: ConnectorFailure | null) => {
		const ok = await confirmDialog({ title: WORDS.tools.resetQuestion, body: WORDS.tools.resetConsequence, confirmLabel: WORDS.tools.reset, cancelLabel: WORDS.button.cancel, danger: true });
		if (!ok) return;
		setResetting(true);
		setResetFailure(null);
		try {
			await resetMcpToolChoices();
			await work.choicesReset(server);
		} catch (e) {
			// Readable again, or from a newer version: the list read again shows which, and the line says nothing was reset.
			if (refusedAs(e, 409)) await work.choicesReset(server);
			setResetFailure({ text: (e as Error).message, inLine });
		} finally {
			setResetting(false);
		}
	};
	const underWay = isUnderWay(state);
	// No tools yet: a connector that answers, or a program never checked, waits for a check; any other waits to connect.
	const toolsWait = state.kind === "connected" || state.kind === "program" ? WORDS.tools.notChecked : WORDS.tools.notConnected;
	const backRef = useRef<HTMLButtonElement | null>(null);

	// The page opens at its beginning with the focus on its way back, as a new page does, though the list was scrolled down; opened by a fix's button, the edit's field has it.
	useEffect(() => {
		if (edit) return;
		backRef.current?.focus({ preventScroll: true });
		// In the settings look the way back sits on the title line that stays put, so showing it scrolls nothing: the pane goes to its top.
		const pane = next ? backRef.current?.closest(".settings-dialog-pane") : null;
		if (pane) pane.scrollTop = 0;
		else backRef.current?.scrollIntoView({ block: "start" });
	}, []);

	// One line for where it is and the one step that state asks for: a sign-in's, when it signs in.
	const signInState = state.kind === "signing-in" || state.kind === "sign-in-failed" || state.kind === "needs-reconnecting" || (server.auth.mode === "oauth" && (state.kind === "not-connected" || (state.kind === "connected" && signedIn)));
	const stateWords = state.kind === "connected" && signedIn ? WORDS.details.signedIn : look.status;
	const stateNote = state.kind === "signing-in" ? WORDS.signingInNote : state.kind === "getting-ready" ? WORDS.gettingReadyNote : null;
	// While a check it started runs, the pressed button stays in its place, busy; Sign in and Reconnect in the Sign-in row show their own press there.
	const pressedInRow = (busy === "connect" && offersSignIn) || (busy === "reconnect" && signedIn);
	const stateButton = look.button ?? ((busy === "connect" || busy === "reconnect" || busy === "tryAgain") && !pressedInRow ? busy : null);
	// A stored sign-in can be made again, with the same account or another, beside taking it away.
	const signedInActions = (
		<>
			{/* Not while a check or sign-in is under way: its end would end the sign-in this one starts. */}
			<SlotButton label={WORDS.button.reconnect} busy={busy === "reconnect"} disabled={busy === "disconnect" || underWay} small={next} onClick={() => work.press(server, "reconnect")} />
			<SlotButton label={WORDS.button.disconnect} busy={busy === "disconnect"} disabled={busy === "reconnect"} small={next} onClick={() => work.disconnect(server)} />
		</>
	);
	const stateAction = readOnly ? null
		: stateButton && !next ? <FixButton server={server} button={stateButton} work={work} onEdit={onEdit} />
		: state.kind === "connected" && signedIn ? signedInActions
		: null;
	// What went wrong offers its fix, each button once on the page: the Web address row then leaves out its own
	// Change address, and a line that says to remove it leaves Remove to the Remove row below.
	const wrongFix = !readOnly && wentWrong?.button && wentWrong.button !== "remove" ? wentWrong.button : null;
	const fixEdits = wrongFix === "changeAddress" || wrongFix === "changeKey";
	// In the settings look the Status row's one step is the state's own, else the fix the words name, else Check connection;
	// with a named fix, Check connection follows the words as a link. A fix they don't name, one beside the state's own step
	// and a first key stay on their own rows; none shows while its edit is open.
	const wordsNameFix = fixEdits && !stateButton && Boolean(wentWrong?.line.way) && !(wrongFix === "changeKey" && server.key === "none");
	const fixButton = fixEdits && (edit || (next && !wordsNameFix)) ? null : wrongFix;
	const checkAfterWords = next && wordsNameFix;
	const statusButton = readOnly ? null : stateButton ?? fixButton ?? (checkAfterWords ? null : "checkConnection");
	const keyButton = key?.button === "changeKey" && fixButton !== "changeKey";
	const stateValue = <span className={`connector-item-state${look.broken ? " is-broken" : ""}`}><span className={`connector-dot connector-dot-${state.kind === "connected" && signedIn ? "ok" : look.dot}`} aria-hidden="true" /><span className="connector-item-status">{stateWords}</span></span>;
	// The settings look's Status row says a sign-in's state too and has its step: a Sign-in row stands beside it where
	// there is a sign-in to take away, and where one failed, whose sentence takes the status words' place.
	const stateRow = !next || (signInState && (state.kind === "connected" || state.kind === "sign-in-failed"));

	const avatar = <ConnectorAvatar id={catalogEntryOf(server)?.id ?? server.name} name={name} size={next ? 24 : 32} letters={next ? 2 : 1} />;

	return (
		<div className="connector-page">
			{!next && <button type="button" ref={backRef} className="skill-detail-back connector-page-back" onClick={onBack}>{WORDS.details.back}</button>}
			<div className="connector-page-head">
				{!next && avatar}
				{/* The settings look leaves the service's description to the Directory, where a connector is chosen. */}
				<PaneHeader
					title={name}
					tip={name}
					line={next ? undefined : catalogEntryOf(server)?.description}
					back={<PaneBack ref={backRef} className="connector-page-back" aria-label={WORDS.details.backName} onClick={onBack} />}
					tile={avatar}
					beside={tag}
				/>
				{!next && tag && <span className="connector-dir-kind">{tag}</span>}
			</div>
			{notice && <p className="cli-note connector-notice" role="status">{notice}</p>}

			<div className="settings-group">
				<div className="settings-rows connector-facts">
					{/* What went wrong says it in full in the words' place, so the page says it once. */}
					{next && (
						<Fact
							label={WORDS.details.status}
							className="connector-fact-status"
							value={
								<div className="connector-status">
									<span className={`connector-dot connector-dot-${look.dot}`} aria-hidden="true" />
									<div className="connector-status-text">
										<p>
											<span className="connector-status-words" role="status">{wentWrong ? lineText(wentWrong.line, readOnly) : look.status}</span>
											{checkAfterWords && <>{" "}<span className="connector-status-check"><button type="button" className="rs-text-btn pane-lead-link pane-check-link" onClick={() => work.check(server)}>{WORDS.button.checkConnection}</button></span></>}
										</p>
										{stateNote && <p className="connector-status-note">{stateNote}</p>}
										{technical && <TechnicalDetails text={technical} />}
									</div>
								</div>
							}
							action={statusButton && <FixButton server={server} button={statusButton} work={work} onEdit={onEdit} small />}
						/>
					)}
					{!next && (wentWrong || technical) && (
						<Fact
							label={WORDS.details.wentWrong}
							className="connector-fact-wrong"
							sub={<>
								{wentWrong && <span className="connector-fact-line">{lineText(wentWrong.line, readOnly)}</span>}
								{technical && <TechnicalDetails text={technical} />}
							</>}
							action={fixButton && <FixButton server={server} button={fixButton} work={work} onEdit={onEdit} />}
						/>
					)}
					{web && (
						edit ? (
							<div className="settings-row connector-fact connector-fact-edit">
								<div className="settings-row-main">
									<span className="settings-row-label">{edit === "key" && !canChangeAddress ? WORDS.details.key : WORDS.details.address}</span>
									<AddressEdit
										server={server}
										focus={edit}
										addressFixed={!canChangeAddress}
										onCancel={() => onEdit(null)}
										onSaved={async (sameSite, keyOnly) => {
											onEdit(null);
											await work.saved(server, sameSite, keyOnly);
										}}
										onOutOfDate={async (message) => {
											onEdit(null);
											await work.outOfDate(server, message);
										}}
										onRemove={removableHere(server) && !readOnly ? () => work.remove(server) : undefined}
									/>
								</div>
							</div>
						) : (
							<Fact
								label={WORDS.details.address}
								sub={imported ? WORDS.wentWrong.imported(imported).fact : undefined}
								value={<span className="connector-address">{next ? addressBreaks(server.target) : server.target}</span>}
								action={canChangeAddress && fixButton !== "changeAddress" && <SlotButton label={WORDS.button.changeAddress} busy={false} small={next} onClick={() => onEdit("address")} />}
							/>
						)
					)}
					{/* Its key, where one can be changed or is kept: the button once on the page, so no row where what went wrong has it, and none while the edit holds the key field. */}
					{key && !edit && (key.line || keyButton) && (
						<Fact
							label={WORDS.details.key}
							value={server.key === "none" ? WORDS.details.keyNone : WORDS.details.keySaved}
							sub={key.line ?? undefined}
							action={keyButton && <SlotButton label={WORDS.button.changeKey} busy={false} small={next} onClick={() => onEdit("key")} />}
						/>
					)}
					{!web && (
						<Fact
							label={WORDS.details.runs}
							sub={<code className="connector-command">{next ? commandWords(server.target) : server.target}</code>}
							value={readOnly ? WORDS.details.runsHereRemote : WORDS.details.runsHere}
						/>
					)}
					{stateRow && (
						<Fact
							label={signInState ? WORDS.details.signIn : WORDS.details.connection}
							sub={stateNote ?? undefined}
							value={stateValue}
							action={stateAction}
						/>
					)}
					{/* Signed in while the connection says something else: the sign-in keeps its own line, and Disconnect. */}
					{signedIn && !signInState && (
						<Fact
							label={WORDS.details.signIn}
							value={<span className="connector-item-state"><span className="connector-dot connector-dot-ok" aria-hidden="true" /><span className="connector-item-status">{WORDS.details.signedIn}</span></span>}
							action={!readOnly && signedInActions}
						/>
					)}
					{/* Connected with no sign-in, where its service may offer one: the way in a refused call names. */}
					{noSignIn && <Fact label={WORDS.details.signIn} value={<span className="connector-fact-note">{lineText(noSignIn, readOnly)}</span>} />}
					{offersSignIn && (
						<Fact
							label={WORDS.details.signIn}
							value={WORDS.details.notSignedIn}
							action={<SlotButton label={WORDS.button.signIn} busy={busy === "connect"} disabled={underWay} small={next} onClick={() => work.press(server, "connect")} />}
						/>
					)}
					{server.usedIn && (
						<Fact
							label={WORDS.details.usedIn}
							className={next ? "connector-fact-rooms" : undefined}
							value={server.usedIn.length === 0 ? WORDS.roomsLink(0) : (
								<span className="connector-rooms">
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
								</span>
							)}
						/>
					)}
				</div>
			</div>

			<section className="settings-group connector-tools-group" aria-label={WORDS.tools.title}>
				<GroupHeader
					kicker={WORDS.tools.title}
					actions={readOnly || next ? undefined : <SlotButton label={WORDS.button.checkConnection} busy={busy === "checkConnection"} disabled={underWay} onClick={() => work.check(server)} />}
				/>
				{server.choicesUnreadable && (
					<div className="connector-tools-unreadable">
						<p className="cli-note" role="status">{WORDS.tools.unreadable[server.choicesUnreadable]}</p>
						{server.choicesUnreadable === "cannot-read" && !readOnly && <button type="button" className={next ? "rs-btn rs-btn-sm" : "rs-btn"} disabled={resetting} aria-busy={resetting || undefined} onClick={() => void resetChoices(null)}>{WORDS.tools.reset}</button>}
					</div>
				)}
				{resetFailure && !(resetFailure.inLine && resetFailure.inLine === failure) && <p className="connector-row-error" role="alert">{resetFailure.text}</p>}
				{!groups ? (
					<p className="cli-note">{toolsWait}</p>
				) : groups.readOnly.length + groups.change.length === 0 ? (
					<p className="cli-note">{WORDS.tools.none}</p>
				) : (
					<>
						{/* Not while the choices can't be read: every tool asks then, a room on Auto with protection off too. */}
						{!server.choicesUnreadable && <p className="cli-note connector-tools-line">{WORDS.tools.applies}</p>}
						<ToolGroup title={WORDS.tools.readOnly} tools={groups.readOnly} readOnly={readOnly} saving={saving} failed={failed} unsure={unsure?.tool ?? null} onPick={(tool, choice) => void pick(tool, choice)} onCheckAgain={() => unsure && void checkAgain(unsure)} />
						<ToolGroup title={WORDS.tools.change} tools={groups.change} readOnly={readOnly} saving={saving} failed={failed} unsure={unsure?.tool ?? null} onPick={(tool, choice) => void pick(tool, choice)} onCheckAgain={() => unsure && void checkAgain(unsure)} />
					</>
				)}
			</section>

			{!readOnly && (
				<div className="settings-group connector-remove-group">
					{removableHere(server) ? (
						<div className="settings-rows">
							{/* Red words end the row as its own last button, on the row's edge, as a skill's Delete does. */}
							<div className="settings-row">
								<div className="settings-row-main">
									<span className="settings-row-label">{WORDS.remove.title}</span>
									<span className="settings-row-sub">{WORDS.remove.line}</span>
								</div>
								<button type="button" className={next ? "rs-btn rs-btn-danger rs-btn-danger-soft" : "rs-btn rs-btn-danger"} disabled={busy === "remove"} aria-busy={busy === "remove" || undefined} onClick={() => work.remove(server)}>{WORDS.button.remove}</button>
							</div>
						</div>
					) : imported ? (
						<p className="connector-note">{WORDS.importedNote(imported)}</p>
					) : null}
					{fileNote && <p className="connector-note">{fileNote.before}<code>{fileNote.file}</code>{fileNote.after}</p>}
				</div>
			)}
			{failure && (
				<div className="checkpoint-proposal-error connector-page-error" role="alert">
					<span>{resetFailure?.inLine === failure ? resetFailure.text : failure.retry === "reset" ? CONNECTOR_REQUEST_LINES.removeChoicesUnreadableBesideReset : failure.text}</span>
					{failure.retry === "remove" && <button type="button" className={next ? "rs-btn rs-btn-sm" : "rs-btn"} onClick={() => work.remove(server, true)}>{WORDS.button.tryAgain}</button>}
					{failure.retry === "reset" && !readOnly && <button type="button" className={next ? "rs-btn rs-btn-sm" : "rs-btn"} disabled={resetting} aria-busy={resetting || undefined} onClick={() => void resetChoices(failure)}>{WORDS.tools.reset}</button>}
				</div>
			)}
		</div>
	);
}

/**
 * The address as a field, on the connector's page. On another site, a
 * connector with a key asks for it again in the same edit, and the line under
 * it says what the move keeps; one that would lose more than that can't move
 * here. "Change key" opens the same edit with the key field. A directory
 * connector's address is the directory's, so only its key changes
 * (addressFixed). The line for a connector that can't move says to remove it,
 * so Remove sits under it and asks the page's own remove question.
 */
function AddressEdit({ server, focus, addressFixed, onCancel, onSaved, onOutOfDate, onRemove }: { server: McpConnectorStatus; focus: ConnectorEdit; addressFixed: boolean; onCancel: () => void; onSaved: (sameSite: boolean, keyOnly: boolean) => Promise<void>; onOutOfDate: (message: string) => Promise<void>; onRemove?: () => void }) {
	const next = useSettingsLookNext();
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
	const signedIn = isSignedIn(server);
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
		// Focus brings only the field into view; the edit's end, under Save, comes too.
		editRef.current?.scrollIntoView({ block: "nearest" });
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
				{/* The settings look puts Save first, then a quiet Cancel. */}
				{!next && <button type="button" className="rs-btn" disabled={saving} onClick={onCancel}>{WORDS.button.cancel}</button>}
				<button type="button" className={`rs-btn rs-btn-primary connector-slot-btn${saving ? " is-busy" : ""}`} disabled={!canSave} aria-busy={saving || undefined} onClick={() => void save()}>
					<span className="connector-slot-label">{WORDS.button.save}</span>
					{saving && <span className="spinner" aria-hidden="true" />}
				</button>
				{next && <button type="button" className="rs-btn rs-btn-quiet" disabled={saving} onClick={onCancel}>{WORDS.button.cancel}</button>}
			</div>
		</div>
	);
}
