import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from "react";
import {
	addMcpServer,
	cancelMcpServerLogin,
	fetchMcpServerLoginState,
	logoutMcpServer,
	removeMcpServer,
	startMcpServerLogin,
	testMcpServer,
	type McpConnectorCheck,
	type McpConnectorStatus,
	type McpConnectorsStatusResponse,
} from "../mcp-api";
import { keptConnectorList, readConnectorList } from "../connectors-list-kept";
import { CONNECTOR_DIRECTORY, type ConnectorDirectoryEntry } from "../connector-catalog";
import {
	addedNotice,
	catalogEntryOf,
	checkOf,
	checksInBackground,
	CONNECTOR_WORDS,
	connectorRowState,
	connectsBySignIn,
	isSignedIn,
	lineText,
	removableHere,
	removeConsequence,
	rowFix,
	rowLook,
	rowNote,
	shownName,
	waitsForSignIn,
	type DotLook,
	type RowActivity,
	type RowButton,
	type RowState,
} from "../connector-rows";
import { SETTING_LINES } from "../../../web-server/src/connector-command";
import { CONNECTOR_FORM_LINES, CONNECTOR_REQUEST_LINES, connectorDisplayName, connectorShownName, MAX_CONNECTOR_NAME_LENGTH } from "../../../web-server/src/connector-form";
import { fetchRemoteClientContext, SHARED_SERVER_ADMIN_LINE, useRemoteClientContext } from "../remote-client-context";
import { AiProfileRowMenu } from "./ai-profile-switcher";
import { confirmDialog } from "./confirm-dialog";
import { ConnectorAvatar, ConnectorPage, connectorTag, FixButton, menuKeys, refusedAs, type ConnectorButton, type ConnectorEdit, type ConnectorFailure, type ConnectorWork } from "./connector-page";
import { ChevronDownIcon, CloseIcon } from "./icons";
import { useEscapeKey } from "./use-escape-key";
import { GroupHeader, PaneBack, PaneHeader } from "./pane-header";
import { isServiceUnreachableLine } from "../api";
import { useSettingsLookNext } from "../settings-look";
import { useNeededFields } from "./settings-dialog";

const WORDS = CONNECTOR_WORDS;
/** A check the person asked for stays on screen at least this long, so "Checking…" is read rather than flashed. */
const MANUAL_CHECK_MIN_MS = 600;
const SIGN_IN_POLL_MS = 2000;
/** The check of a program that downloads at its first start, still running after this long, is getting ready, which can take minutes the first time: the person may stop it. */
const GETTING_READY_AFTER_MS = 3000;
/** The server's own sign-in waits 5 minutes for the browser and then says it took too long; this page stops waiting only some time after that, should its end never be heard. */
const SIGN_IN_LIMIT_MS = 5 * 60_000 + 30_000;

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** What is under way for one connector: its activity, the button pressed, and what last failed. */
interface Work {
	activity: RowActivity;
	busy: ConnectorButton | null;
	failure: ConnectorFailure | null;
}
const IDLE: Work = { activity: null, busy: null, failure: null };

/**
 * The pane's one owner of each connector's work: a check, a sign-in and its
 * waiting, Disconnect and Remove. The list's row and the connector's own page
 * both read it, so moving between them keeps a sign-in going. Closing Settings
 * or reloading ends the page's waiting, not the sign-in: the next opening asks
 * the server which sign-ins are still waiting for the browser and waits again.
 */
function useConnectorWork({ status, refresh, readOnly, onRemoved, onNotice }: { status: McpConnectorsStatusResponse | null; /** Reads the list again; null when it couldn't. */ refresh: () => Promise<McpConnectorsStatusResponse | null>; readOnly: boolean; onRemoved: (name: string, stillListed: boolean) => void; onNotice: (text: string) => void }): ConnectorWork & { signIn: (name: string, pressed: ConnectorButton | null) => Promise<void>; checkAdded: (name: string) => Promise<boolean> } {
	const [works, setWorks] = useState<Record<string, Work>>({});
	// The checks this page ran, newer than what the server kept.
	const [checks, setChecks] = useState<Record<string, McpConnectorCheck | null>>({});
	const polls = useRef(new Map<string, number>());
	const checkStops = useRef(new Map<string, AbortController>());
	const mounted = useRef(true);
	// The connectors seen since the pane opened: each is checked in the background, and asked about a waiting sign-in, once at most.
	const seen = useRef(new Set<string>());
	const worksRef = useRef(works);
	worksRef.current = works;

	useEffect(() => {
		// Set again here: StrictMode undoes and redoes every effect while the page is developed.
		mounted.current = true;
		return () => {
			mounted.current = false;
			for (const timer of polls.current.values()) window.clearTimeout(timer);
			polls.current.clear();
			for (const stop of checkStops.current.values()) stop.abort();
			checkStops.current.clear();
		};
	}, []);

	const set = useCallback((name: string, change: Partial<Work>) => {
		if (!mounted.current) return;
		setWorks((current) => ({ ...current, [name]: { ...(current[name] ?? IDLE), ...change } }));
	}, []);
	const onCheck = useCallback((name: string, check: McpConnectorCheck | null) => {
		setChecks((current) => ({ ...current, [name]: check }));
	}, []);
	const checkOfServer = (server: McpConnectorStatus) => (Object.hasOwn(checks, server.name) ? checks[server.name] : server.lastCheck);

	/** The list read again, after an answer that says this connector is out of date; one that no longer exists leaves it. */
	const readAgain = useCallback(async (name: string) => {
		onCheck(name, null);
		return refresh();
	}, [onCheck, refresh]);

	/** Checks the connector as Check connection does; true when it connected and the check still describes it. */
	const runCheck = useCallback(async (server: McpConnectorStatus, pressed: ConnectorButton | null): Promise<boolean> => {
		const name = server.name;
		set(name, { failure: null, busy: pressed, activity: { kind: "checking" } });
		const stop = new AbortController();
		checkStops.current.set(name, stop);
		// A program that downloads at its first start: past a few seconds its row says so, and Cancel stops the check.
		const gettingReady = !server.downloadsAtFirstStart ? null : window.setTimeout(() => {
			if (!stop.signal.aborted) set(name, { activity: { kind: "getting-ready" }, busy: null });
		}, GETTING_READY_AFTER_MS);
		// Once the check has ended the row never says it is getting ready, though the list is still read again.
		const ended = () => {
			if (gettingReady !== null) window.clearTimeout(gettingReady);
		};
		try {
			const [result] = await Promise.all([testMcpServer(name, stop.signal), delay(MANUAL_CHECK_MIN_MS)]);
			ended();
			if (!mounted.current) return false;
			if (!result.superseded) onCheck(name, checkOf(result));
			set(name, { activity: null, busy: null });
			await refresh();
			return result.ok && !result.superseded;
		} catch (e) {
			ended();
			if (!mounted.current) return false;
			set(name, { activity: null, busy: null });
			// Stopped by the person: the connector is as it was before.
			if (stop.signal.aborted) return false;
			if (refusedAs(e, 404)) await readAgain(name);
			else set(name, { failure: { text: (e as Error).message, retry: null } });
			return false;
		} finally {
			if (checkStops.current.get(name) === stop) checkStops.current.delete(name);
		}
	}, [set, onCheck, refresh, readAgain]);

	/**
	 * A connector the person has just added: checked once, as Check connection
	 * would, so its row says whether it works. Only the Add click comes here;
	 * opening the page starts no program, except Open in Settings from a room's
	 * failed step, which checks that one connector (see `focus` below). Its row
	 * reads "Checking…" from the moment the list shows it, and this check takes
	 * the place of the one the page runs behind a new web row. One known to
	 * wait for a sign-in isn't checked, as it isn't behind the list. True when
	 * it connected.
	 */
	const checkAdded = useCallback(async (name: string): Promise<boolean> => {
		set(name, { failure: null, activity: { kind: "checking" } });
		const added = (await refresh())?.servers.find((server) => server.name === name);
		// Settings closed meanwhile, or the list couldn't be read: nothing starts, and the row says what it knows.
		if (!added || !mounted.current || (added.transport === "http" && !checksInBackground(added, connectorRowState(added, added.lastCheck, null)))) {
			set(name, { activity: null });
			return false;
		}
		return runCheck(added, null);
	}, [set, refresh, runCheck]);

	const pollSignIn = useCallback((name: string, deadline: number) => {
		// One wait per connector: a second start replaces the first, so Cancel stops the only one.
		const waiting = polls.current.get(name);
		if (waiting !== undefined) window.clearTimeout(waiting);
		polls.current.set(name, window.setTimeout(async () => {
			polls.current.delete(name);
			try {
				const login = await fetchMcpServerLoginState(name);
				if (!mounted.current) return;
				// Cancelled meanwhile: the person's Cancel decided.
				if (worksRef.current[name]?.activity?.kind !== "signing-in") return;
				if (login.pending && Date.now() < deadline) return pollSignIn(name, deadline);
				if (login.pending) {
					// The server's own end was never heard: the same end, said here.
					await cancelMcpServerLogin(name).catch(() => undefined);
					set(name, { activity: { kind: "sign-in-failed", cause: "too-slow" } });
				} else if (login.cause) {
					set(name, { activity: { kind: "sign-in-failed", cause: login.cause, detail: login.detail } });
				} else {
					set(name, { activity: null });
					await readAgain(name);
				}
			} catch (e) {
				set(name, { activity: { kind: "sign-in-failed", error: (e as Error).message } });
			}
		}, SIGN_IN_POLL_MS));
	}, [set, readAgain]);

	const signIn = useCallback(async (name: string, pressed: ConnectorButton | null) => {
		set(name, { failure: null, busy: pressed });
		try {
			await startMcpServerLogin(name);
			set(name, { activity: { kind: "signing-in" } });
			if (mounted.current) pollSignIn(name, Date.now() + SIGN_IN_LIMIT_MS);
		} catch (e) {
			if (!mounted.current) return;
			if (refusedAs(e, 404)) await readAgain(name);
			else set(name, { activity: { kind: "sign-in-failed", error: (e as Error).message } });
		} finally {
			set(name, { busy: null });
		}
	}, [set, pollSignIn, readAgain]);

	/** A connector that left: its work, checks and waiting go with it, so one added again by the same name starts afresh. */
	const forget = useCallback((name: string) => {
		const timer = polls.current.get(name);
		if (timer !== undefined) window.clearTimeout(timer);
		polls.current.delete(name);
		checkStops.current.get(name)?.abort();
		checkStops.current.delete(name);
		seen.current.delete(name);
		setWorks(({ [name]: _gone, ...rest }) => rest);
		setChecks(({ [name]: _gone, ...rest }) => rest);
	}, []);

	const cancelSignIn = useCallback(async (name: string) => {
		const timer = polls.current.get(name);
		if (timer !== undefined) window.clearTimeout(timer);
		polls.current.delete(name);
		set(name, { busy: "cancel" });
		try {
			await cancelMcpServerLogin(name);
		} catch {
			// the attempt also ends on its own time limit
		}
		set(name, { busy: null, activity: null });
	}, [set]);

	// Once per opening, and once for a connector added while it is open: each
	// row shows what was last known at once, the web connectors that can be
	// checked are checked behind it, and a sign-in still waiting for the
	// browser, from before Settings closed or the page reloaded, is waited for again.
	useEffect(() => {
		if (!status || readOnly) return;
		// One removed elsewhere leaves its work here too.
		const listed = new Set(status.servers.map((server) => server.name));
		for (const name of [...seen.current].filter((one) => !listed.has(one))) forget(name);
		const fresh = status.servers.filter((server) => !seen.current.has(server.name));
		for (const server of fresh) seen.current.add(server.name);
		// A row already under way (a check just added, a sign-in) keeps its own. One never checked reads "Checking…" while
		// its first check runs, as nothing is known of it yet; the rest show what was last known meanwhile.
		const due = fresh.filter((server) => !worksRef.current[server.name]?.activity && checksInBackground(server, connectorRowState(server, server.lastCheck, null)));
		const marks = new Map<string, RowActivity>();
		for (const server of due.filter((one) => !one.lastCheck)) {
			const mark: RowActivity = { kind: "checking" };
			marks.set(server.name, mark);
			set(server.name, { activity: mark });
		}
		for (const server of fresh.filter((one) => one.transport === "http" && one.auth.mode === "oauth")) {
			void fetchMcpServerLoginState(server.name).then((login) => {
				if (!login.pending || !mounted.current || worksRef.current[server.name]?.activity) return;
				set(server.name, { activity: { kind: "signing-in" } });
				pollSignIn(server.name, Date.now() + SIGN_IN_LIMIT_MS);
			}, () => undefined);
		}
		if (due.length === 0) return;
		void Promise.allSettled(due.map(async (server) => {
			try {
				const result = await testMcpServer(server.name);
				// A check that outlived a change to its connector says nothing about it now.
				if (!result.superseded) onCheck(server.name, checkOf(result));
			} finally {
				// Only its own "Checking…": a check the person started since, or a sign-in, keeps theirs.
				const mark = marks.get(server.name);
				if (mark && worksRef.current[server.name]?.activity === mark) set(server.name, { activity: null });
			}
		})).then(() => refresh());
	}, [status, readOnly, onCheck, refresh, set, pollSignIn, forget]);

	const remove = useCallback(async (server: McpConnectorStatus, asked = false) => {
		const name = server.name;
		// While the choices can't be read the server refuses a removal: the line says so at once, with no question, and offers the reset where it helps.
		if (server.choicesUnreadable) {
			set(name, { failure: { text: CONNECTOR_REQUEST_LINES.removeChoicesUnreadable[server.choicesUnreadable], retry: server.choicesUnreadable === "cannot-read" ? "reset" : null } });
			return;
		}
		if (!asked) {
			const ok = await confirmDialog({ title: WORDS.removeQuestion(shownName(server)), body: removeConsequence(server, server.usedIn) ?? undefined, confirmLabel: WORDS.button.remove, cancelLabel: WORDS.button.keep, danger: true });
			if (!ok) return;
		}
		set(name, { busy: "remove", failure: null });
		try {
			await removeMcpServer(name);
			forget(name);
			const after = await refresh();
			onRemoved(name, Boolean(after?.servers.some((one) => one.name === name)));
		} catch (e) {
			set(name, { busy: null });
			if (refusedAs(e, 404)) {
				forget(name);
				await refresh();
				return onRemoved(name, false);
			}
			// Refused here: it was added somewhere this page doesn't change, which the list read again shows.
			// Or the choices turned unreadable since the list was read: the list read again says so, and the line offers what it offers on the page.
			if (refusedAs(e, 409)) {
				const why = (await readAgain(name))?.servers.find((one) => one.name === name)?.choicesUnreadable;
				return set(name, { failure: why ? { text: CONNECTOR_REQUEST_LINES.removeChoicesUnreadable[why], retry: why === "cannot-read" ? "reset" : null } : { text: (e as Error).message, retry: null } });
			}
			// Any other failure the server answers leaves the connector here and every room as it was, so the same Remove again tries again; the list read again settles a lost answer.
			set(name, { failure: { text: WORDS.remove.failed, retry: "remove" } });
			await refresh();
		}
	}, [set, refresh, readAgain, onRemoved, forget]);

	return {
		state: (server) => connectorRowState(server, checkOfServer(server), works[server.name]?.activity ?? null),
		known: (server) => connectorRowState(server, checkOfServer(server), null),
		busy: (name) => works[name]?.busy ?? null,
		failure: (name) => works[name]?.failure ?? null,
		press: (server, button) => {
			const state = connectorRowState(server, checkOfServer(server), works[server.name]?.activity ?? null);
			if (state.kind === "getting-ready") return void checkStops.current.get(server.name)?.abort();
			if (button === "cancel") return void cancelSignIn(server.name);
			if (button === "reconnect" || state.kind === "sign-in-failed" || (button === "connect" && connectsBySignIn(server))) return void signIn(server.name, button);
			void runCheck(server, button);
		},
		check: (server) => void runCheck(server, "checkConnection"),
		disconnect: (server) => {
			set(server.name, { failure: null, busy: "disconnect" });
			void logoutMcpServer(server.name).then(() => readAgain(server.name), (e: Error) => set(server.name, { failure: { text: e.message, retry: null } })).finally(() => set(server.name, { busy: null }));
		},
		remove: (server, asked) => void remove(server, asked),
		saved: async (server, sameSite, keyOnly) => {
			onNotice(keyOnly ? WORDS.keySaved : WORDS.addressSaved);
			// What the row said was about the connector before the change: until it is read again and checked, it is
			// checking, never offering a step for the old one. A sign-in under way keeps its own.
			const was = worksRef.current[server.name]?.activity;
			const mark: RowActivity = { kind: "checking" };
			if (!was || was.kind === "sign-in-failed") set(server.name, { activity: mark });
			const after = await readAgain(server.name);
			// On the same site its sign-in moved along, or it needs none; on another site one known to need a sign-in waits for the person.
			const now = after?.servers.find((one) => one.name === server.name) ?? server;
			if (sameSite || !waitsForSignIn(now)) await runCheck(now, null);
			else if (worksRef.current[server.name]?.activity === mark) set(server.name, { activity: null });
		},
		outOfDate: async (server, message) => {
			set(server.name, { failure: { text: message, retry: null } });
			await readAgain(server.name);
		},
		// Its check still describes it: only the choices changed.
		choicesSaved: async (server) => (await refresh())?.servers.find((one) => one.name === server.name) ?? null,
		choicesReset: async (server) => {
			set(server.name, { failure: null });
			await refresh();
		},
		signIn,
		checkAdded,
	};
}

/** Under way and stoppable: in the settings look its Cancel and its sentence wait in the pane's foot, not on its row. */
const waitsInFoot = (state: RowState) => state.kind === "signing-in" || state.kind === "getting-ready";

/**
 * The settings look's second line of a row, its one line under the name: what
 * a press failed with; else a broken row's reason in its status's place;
 * else a connected row's tool count after its status; else the status. How
 * many rooms have it on ends the line, but never a press's failure.
 */
function lookLine(look: ReturnType<typeof rowLook>, state: RowState, failure: string | null, reason: string | null, rooms: number | null): { text: string; dot: DotLook; broken: boolean } {
	if (failure) return { text: failure, dot: "err", broken: true };
	const withRooms = (text: string) => (rooms === null ? text : `${text.replace(/\.$/, "")} · ${WORDS.roomsInLine(rooms)}`);
	if (look.broken && reason) return { text: withRooms(reason), dot: look.dot, broken: true };
	if (state.kind === "connected" && reason) return { text: withRooms(`${look.status} · ${reason}`), dot: look.dot, broken: false };
	return { text: withRooms(look.status), dot: look.dot, broken: look.broken };
}

/**
 * A connector in the list: its name, its status, and the one line every row
 * keeps room for, so no row grows or shifts in any state. The row opens the
 * connector's page; the one button beside it is its state's step or its fix.
 * In the settings look a row has two lines and one height in every state.
 */
export function ConnectorRow({ server, work, readOnly, onOpen }: { server: McpConnectorStatus; work: ConnectorWork; readOnly: boolean; onOpen: (edit?: ConnectorEdit) => void }) {
	const next = useSettingsLookNext();
	const state = work.state(server);
	const look = rowLook(state, readOnly);
	const name = shownName(server);
	const tag = connectorTag(server);
	const failure = work.failure(server.name);
	const reason = rowNote(server, state, readOnly);
	const note = failure?.text ?? reason;
	const line = next ? lookLine(look, state, failure?.text ?? null, reason, server.usedIn ? server.usedIn.length : null) : { text: look.status, dot: look.dot, broken: look.broken };
	// While a check it started runs, the pressed button stays in its place, busy, and keeps the focus.
	const pressed = work.busy(server.name);
	const fix = next && waitsInFoot(state) ? null : rowFix(server, state, readOnly) ?? (!readOnly && (pressed === "connect" || pressed === "reconnect" || pressed === "tryAgain" || pressed === "checkConnection") ? pressed : null);
	// The name line runs up to the button, as wide as its words make it (the phone's layout reads it).
	const itemRef = useRef<HTMLDivElement | null>(null);
	useLayoutEffect(() => {
		const button = itemRef.current?.querySelector<HTMLElement>(".connector-item-slot > *");
		itemRef.current?.style.setProperty("--connector-slot-now", `${button?.offsetWidth ?? 0}px`);
	});
	const shownStatusRef = useRef<string | null>(null);
	// Only a changed status fades in; the first paint and an unchanged row stay still.
	const statusKey = `${line.dot}:${line.text}`;
	const fadeIn = shownStatusRef.current !== null && shownStatusRef.current !== statusKey;
	useEffect(() => {
		shownStatusRef.current = statusKey;
	});

	return (
		<div className="connector-item" ref={itemRef}>
			<div className="connector-item-row">
				<button type="button" className="connector-item-hit" onClick={() => onOpen()}>
					<ConnectorAvatar id={catalogEntryOf(server)?.id ?? server.name} name={name} size={32} letters={next ? 2 : 1} />
					<span className="connector-item-text">
						<span className="connector-item-name">
							<span className="connector-item-name-text">{name}</span>
							{tag && <span className="connector-dir-kind" title={next ? tag : undefined}>{tag}</span>}
						</span>
						<span key={statusKey} className={`connector-item-state${line.broken ? " is-broken" : ""}${fadeIn ? " is-new" : ""}`} role={next && failure ? "alert" : undefined} title={next ? line.text : undefined}>
							<span className={`connector-dot connector-dot-${line.dot}`} aria-hidden="true" />
							<span className="connector-item-status">{next ? line.text.split(" · ").map((part, at, parts) => <span className="connector-item-part" key={at}>{part}{at < parts.length - 1 && " ·"}</span>).flatMap((part, at) => (at ? [" ", part] : [part])) : line.text}</span>
						</span>
					</span>
					{/* In the settings look the rooms are in the status line, and a row's button stands in the chevron's place. */}
					<span className="connector-rooms-link">
						{server.usedIn && !next && <span className="connector-rooms-words">{WORDS.roomsLink(server.usedIn.length)}</span>}
						{!(next && fix) && <span className="disclosure-chevron" aria-hidden="true" />}
					</span>
					{!next && <span className={`connector-item-note${failure ? " is-error" : ""}`} role={failure ? "alert" : state.kind === "signing-in" || state.kind === "getting-ready" ? "status" : undefined} title={note ?? undefined}>{note}</span>}
				</button>
				<div className="connector-item-side">
					<span className="connector-item-slot">{fix && <FixButton server={server} button={fix} work={work} onEdit={onOpen} small={next} onRow />}</span>
				</div>
			</div>
		</div>
	);
}

type AddWay = keyof typeof WORDS.addWays;
const ADD_WAYS: AddWay[] = ["directory", "web", "program"];

/** The title row's Add connector: a menu of the three ways to add one. */
function AddConnectorMenu({ onChoose }: { onChoose: (way: AddWay) => void }) {
	// In the settings look it is the page's one ink button, with a caret.
	const next = useSettingsLookNext();
	const [open, setOpen] = useState(false);
	const buttonRef = useRef<HTMLButtonElement | null>(null);
	const firstRef = useRef<HTMLButtonElement | null>(null);
	// The menu stays hidden until it has measured where it fits, and a hidden item can't take the focus, so it moves on the next frame.
	useEffect(() => {
		if (!open) return;
		const frame = requestAnimationFrame(() => firstRef.current?.focus());
		return () => cancelAnimationFrame(frame);
	}, [open]);
	const close = (returnFocus = true) => {
		setOpen(false);
		if (returnFocus) buttonRef.current?.focus();
	};
	// Escape closes the menu only, never the Settings window around it, even before the focus has moved into it.
	useEscapeKey(() => close(), open);
	return (
		<span className="ai-profile-menu-anchor">
			<button type="button" ref={buttonRef} className={`rs-btn${next ? " rs-btn-sm" : ""} connector-add-btn`} aria-haspopup="menu" aria-expanded={open} onClick={() => (open ? close() : setOpen(true))}>
				{WORDS.addConnector}
				{next && <span className="connector-add-caret" aria-hidden="true"><ChevronDownIcon size={12} /></span>}
			</button>
			{open && (
				<span onKeyDown={(e) => menuKeys(e, () => close())}>
					<AiProfileRowMenu anchorRef={buttonRef} onDismiss={() => close()}>
						{ADD_WAYS.map((way, index) => (
							<button key={way} type="button" role="menuitem" ref={index === 0 ? firstRef : undefined} className="ai-profile-menu-item connector-menu-item" onClick={() => {
								close(false);
								onChoose(way);
							}}>{WORDS.addWays[way]}</button>
						))}
					</AiProfileRowMenu>
				</span>
			)}
		</span>
	);
}

type NameValueRow = { name: string; value: string };

/** What a half-filled row or a name twice says, for headers or a program's settings. */
interface RowLines {
	unnamed: string;
	noValue: (name: string) => string;
	twice: (name: string) => string;
	/** Headers' names are read without case; settings' names keep theirs. */
	anyCase: boolean;
	/** A setting's value goes as typed, spaces and all, as a password may have them; a header's is trimmed. */
	exactValue: boolean;
}

const HEADER_ROW_LINES: RowLines = { unnamed: CONNECTOR_FORM_LINES.headerUnnamed, noValue: WORDS.form.headerNoValue, twice: WORDS.form.headerTwice, anyCase: true, exactValue: false };
const SETTING_ROW_LINES: RowLines = { ...SETTING_LINES, anyCase: false, exactValue: true };

/** The filled rows as names and values; a half-filled row or a name twice is an error in words. */
function valuesFromRows(rows: NameValueRow[], lines: RowLines): Record<string, string> | undefined {
	const filled = rows.map((row) => ({ name: row.name.trim(), value: lines.exactValue && row.value.trim() ? row.value : row.value.trim() })).filter((row) => row.name || row.value);
	if (filled.length === 0) return undefined;
	const values: Array<[string, string]> = [];
	const seen = new Set<string>();
	for (const row of filled) {
		if (!row.name) throw new Error(lines.unnamed);
		if (!row.value) throw new Error(lines.noValue(row.name));
		const key = lines.anyCase ? row.name.toLowerCase() : row.name;
		if (seen.has(key)) throw new Error(lines.twice(row.name));
		seen.add(key);
		values.push([row.name, row.value]);
	}
	return Object.fromEntries(values);
}

/** Name and value rows, as headers and a program's settings are typed: the value hidden, as it may be a key. */
function NameValueRows({ rows, onChange, namePlaceholder, nameLabel, valueLabel, removeLabel, addLabel }: {
	rows: NameValueRow[];
	onChange: (update: (rows: NameValueRow[]) => NameValueRow[]) => void;
	namePlaceholder: string;
	nameLabel: (n: number) => string;
	valueLabel: (n: number) => string;
	removeLabel: (n: number) => string;
	addLabel: string;
}) {
	return (
		<>
			{rows.map((row, index) => (
				<div className="connector-header-row" key={index}>
					<div className="connector-form-field">
						<input type="text" aria-label={nameLabel(index + 1)} value={row.name} placeholder={namePlaceholder} onChange={(e) => onChange((current) => current.map((r, i) => (i === index ? { ...r, name: e.target.value } : r)))} />
					</div>
					<div className="connector-form-field">
						<input type="password" aria-label={valueLabel(index + 1)} value={row.value} placeholder="Value" onChange={(e) => onChange((current) => current.map((r, i) => (i === index ? { ...r, value: e.target.value } : r)))} />
					</div>
					<button type="button" className="rs-btn rs-btn-icon rs-btn-sm connector-header-remove" aria-label={removeLabel(index + 1)} onClick={() => onChange((current) => (current.length > 1 ? current.filter((_, i) => i !== index) : [{ name: "", value: "" }]))}><CloseIcon size={14} /></button>
				</div>
			))}
			<button type="button" className="connector-text-btn connector-header-add" onClick={() => onChange((current) => [...current, { name: "", value: "" }])}>{addLabel}</button>
		</>
	);
}

/** Where a typed address leads, for the trust line: its host, or null before it reads as a web address. */
function hostOf(url: string): string | null {
	try {
		const parsed = new URL(url.trim());
		return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.host || null : null;
	} catch {
		return null;
	}
}

/**
 * Adding by web address or a program on this computer, each its own form.
 * The program's line under its fields is the one warning before it runs:
 * nothing asks again before it starts.
 */
function AddConnectorForm({ kind, onAdded, onCancel }: { kind: "web" | "program"; onAdded: (name: string, typedName: string) => void; onCancel: () => void }) {
	const form = WORDS.form;
	const [name, setName] = useState("");
	const [url, setUrl] = useState("");
	const [bearerToken, setBearerToken] = useState("");
	const [command, setCommand] = useState("");
	const [showMore, setShowMore] = useState(false);
	const [oauthClientId, setOauthClientId] = useState("");
	const [oauthClientSecret, setOauthClientSecret] = useState("");
	const [oauthScope, setOauthScope] = useState("");
	const [headerRows, setHeaderRows] = useState<NameValueRow[]>([{ name: "", value: "" }]);
	const [settingRows, setSettingRows] = useState<NameValueRow[]>([{ name: "", value: "" }]);
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const blockRef = useRef<HTMLDivElement | null>(null);
	const nameRef = useRef<HTMLInputElement | null>(null);
	const urlRef = useRef<HTMLInputElement | null>(null);
	const commandRef = useRef<HTMLInputElement | null>(null);
	const needed = useNeededFields();
	const nameNeeded = needed.field("name", name);
	const urlNeeded = needed.field("url", url);
	const commandNeeded = needed.field("command", command, "connector-command-hint");
	const web = kind === "web";
	const title = web ? form.webTitle : form.programTitle;
	// The settings look opens the form as a page of its own, in the list's place, with its way back first.
	const next = useSettingsLookNext();

	// The form opens under the title row; scroll only as far as it takes to
	// show it whole, and start in its first field. As a page of its own it
	// opens at its beginning, though the list was scrolled down.
	useEffect(() => {
		const pane = next ? blockRef.current?.closest(".settings-dialog-pane") : null;
		if (pane) pane.scrollTop = 0;
		else blockRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
		nameRef.current?.focus({ preventScroll: true });
	}, []);

	// The settings look's Add stays pressable: pressed too early, it marks what is missing.
	function press() {
		if (needed.filled([[name, nameRef.current], web ? [url, urlRef.current] : [command, commandRef.current]])) void save();
	}

	async function save() {
		setSaving(true);
		setError(null);
		try {
			const added = web
				? await addMcpServer({
						name,
						url: url.trim(),
						bearerToken: bearerToken.trim() || undefined,
						oauth: oauthClientId.trim() || oauthClientSecret.trim() || oauthScope.trim() ? { clientId: oauthClientId.trim(), clientSecret: oauthClientSecret.trim() || undefined, scope: oauthScope.trim() || undefined } : undefined,
						headers: valuesFromRows(headerRows, HEADER_ROW_LINES),
					})
				: await addMcpServer({ name, commandLine: command, env: valuesFromRows(settingRows, SETTING_ROW_LINES) });
			onAdded(added.name, name);
		} catch (e) {
			setError((e as Error).message);
		} finally {
			setSaving(false);
		}
	}

	return (
		<div className="ai-setup-block connector-custom-form" aria-label={title} ref={blockRef}>
			{next
				// The way back waits while Add saves, as Cancel does: its answer would close a page opened since.
				? <PaneHeader back={<PaneBack className="connector-page-back" aria-label={WORDS.details.backName} disabled={saving} onClick={onCancel} />} title={title} />
				: <p className="settings-group-kicker">{title}</p>}
			<div className="connector-form">
				<label className="connector-form-field">
					<span>{form.name}</span>
					<input ref={nameRef} type="text" value={name} {...nameNeeded.props} maxLength={MAX_CONNECTOR_NAME_LENGTH} placeholder={form.namePlaceholder} onChange={(e) => setName(e.target.value)} />
					{nameNeeded.line}
				</label>
				{web ? (
					<>
						<label className="connector-form-field">
							<span>{form.address}</span>
							<input ref={urlRef} type="text" value={url} {...urlNeeded.props} placeholder={form.addressPlaceholder} onChange={(e) => setUrl(e.target.value)} />
							{urlNeeded.line}
						</label>
						<button type="button" className="connector-oauth-toggle" onClick={() => setShowMore((current) => !current)} aria-expanded={showMore}>
							<span className="disclosure-chevron" aria-hidden="true" />
							{form.more}
						</button>
						{showMore && (
							<div className="connector-oauth-fields">
								<label className="connector-form-field">
									<span>{form.key}</span>
									<input type="password" value={bearerToken} onChange={(e) => setBearerToken(e.target.value)} />
								</label>
								<p className="connector-form-sub">{form.signInApp}</p>
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
								<p className="connector-form-sub">{form.headers}</p>
								<p className="cli-note">{form.headersHint.before}<code>{form.headersHint.example}</code>{form.headersHint.after}</p>
								<NameValueRows rows={headerRows} onChange={setHeaderRows} namePlaceholder="X-Api-Key" nameLabel={form.headerName} valueLabel={form.headerValue} removeLabel={form.removeHeader} addLabel={form.addHeader} />
							</div>
						)}
						<p className="cli-note connector-form-line">{form.signInLater}</p>
						<p className="cli-note connector-form-line connector-form-warning">{form.trustWeb(hostOf(url))}</p>
					</>
				) : (
					<>
						<label className="connector-form-field">
							<span>{form.command}</span>
							<input ref={commandRef} type="text" className="connector-command-input" value={command} {...commandNeeded.props} placeholder="npx -y @modelcontextprotocol/server-filesystem /path/to/root" onChange={(e) => setCommand(e.target.value)} />
							{commandNeeded.line}
							<span className="connector-form-hint" id="connector-command-hint">{form.commandHint}</span>
						</label>
						<div className="connector-form-field" role="group" aria-labelledby="connector-settings-label">
							<span id="connector-settings-label">{form.settings}</span>
							<NameValueRows rows={settingRows} onChange={setSettingRows} namePlaceholder="API_KEY" nameLabel={form.settingName} valueLabel={form.settingValue} removeLabel={form.removeSetting} addLabel={form.addSetting} />
						</div>
						<p className="cli-note connector-form-line connector-form-warning">{form.trustProgram}</p>
						<p className="cli-note connector-form-line">{form.programChecked}</p>
					</>
				)}
				{error && <div className="checkpoint-proposal-error" role="alert">{error}</div>}
				<div className="settings-form-foot">
					{/* The settings look puts Add first, then a quiet Cancel. */}
					{!next && <button className="rs-btn" disabled={saving} onClick={onCancel}>{form.cancel}</button>}
					<button className="rs-btn rs-btn-primary" disabled={saving || (!next && (!name.trim() || (web ? !url.trim() : !command.trim())))} onClick={next ? press : () => void save()}>
						{saving ? form.adding : form.add}
					</button>
					{next && <button type="button" className="rs-btn rs-btn-quiet" disabled={saving} onClick={onCancel}>{form.cancel}</button>}
				</div>
			</div>
		</div>
	);
}

function DirectoryCard({ entry, installed, onAdd, tokenOpen, onTokenOpen }: { entry: ConnectorDirectoryEntry; installed: boolean; onAdd: (entry: ConnectorDirectoryEntry, token?: string) => Promise<void>; tokenOpen: boolean; onTokenOpen: (open: boolean) => void }) {
	// In the settings look a row's buttons are the small ones, and the key row's Add is not ink: Add connector is the page's one.
	const next = useSettingsLookNext();
	const rowButton = next ? "rs-btn rs-btn-sm" : "rs-btn";
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
	// entries open the key row under this one. The tag beside the name says
	// which flow Add opens.
	const addLabel = WORDS.directoryAdd(entry);

	return (
		<div className="connector-dir-row-group">
			<div className="settings-row connector-dir-row">
				<ConnectorAvatar id={entry.id} name={entry.name} size={32} />
				<div className="settings-row-main">
					<span className="settings-row-label">{entry.name}<span className="connector-dir-kind">{WORDS.directoryTags[entry.kind]}</span></span>
					<span className="settings-row-sub settings-row-clamp" title={entry.description}>{entry.description}</span>
				</div>
				{installed ? (
					<span className="settings-row-value" aria-label={`${entry.name} is added`}>Added</span>
				) : entry.kind === "token" && tokenOpen ? (
					<button className={rowButton} disabled={adding} onClick={() => { onTokenOpen(false); setToken(""); }}>Cancel</button>
				) : (
					<button
						className={rowButton}
						disabled={adding}
						title={addLabel}
						aria-label={addLabel}
						aria-expanded={entry.kind === "token" ? tokenOpen : undefined}
						onClick={() => {
							if (entry.kind === "token") onTokenOpen(true);
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
					<button className={next ? rowButton : "rs-btn rs-btn-primary"} disabled={adding || !token.trim()} onClick={() => void add(token.trim())}>
						{adding ? "Adding…" : "Add"}
					</button>
					{entry.docsUrl && (
						<a className="rs-btn rs-btn-quiet rs-btn-sm rs-quiet" href={entry.docsUrl} target="_blank" rel="noreferrer">Where do I get one? ↗</a>
					)}
				</div>
			)}
			{error && <p className="connector-dir-note connector-outcome-error">{error}</p>}
		</div>
	);
}

// One form open at a time: a key row opened under its entry closes an add form.
function ConnectorDirectory({ status, onAdd, onCloseForm, searchRef }: { status: McpConnectorsStatusResponse | null; onAdd: (entry: ConnectorDirectoryEntry, token?: string) => Promise<void>; onCloseForm: () => void; searchRef: RefObject<HTMLInputElement> }) {
	const next = useSettingsLookNext();
	const [query, setQuery] = useState("");
	const [tokenOpenId, setTokenOpenId] = useState<string | null>(null);

	const configured = status?.servers ?? [];
	const isInstalled = (entry: ConnectorDirectoryEntry) =>
		configured.some((server) => server.name === entry.id || server.target === entry.url);

	const q = query.trim().toLowerCase();
	const entries = CONNECTOR_DIRECTORY.filter(
		(entry) => !q || entry.name.toLowerCase().includes(q) || entry.description.toLowerCase().includes(q),
	);

	return (
		<section className={`ai-setup-section settings-group${next ? " connector-directory" : ""}`} aria-label="Connector directory">
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
			{entries.length > 0 && (
				<div className="settings-rows">
					{entries.map((entry) => (
						<DirectoryCard
							key={entry.id}
							entry={entry}
							installed={isInstalled(entry)}
							onAdd={onAdd}
							tokenOpen={tokenOpenId === entry.id}
							onTokenOpen={(open) => {
								setTokenOpenId(open ? entry.id : null);
								if (open) onCloseForm();
							}}
						/>
					))}
				</div>
			)}
			{entries.length === 0 && <p className="cli-note">{WORDS.directoryNoMatch}</p>}
		</section>
	);
}

/** Which add form is open, under the title row. */
type FormAt = { at: "web" | "program" };

/** The fewest milliseconds between two reads when a window comes back: switching windows back and forth reads once. */
const READ_AGAIN_GAP_MS = 5_000;

/**
 * Reads again when the window comes back in front or becomes visible, at most
 * once every few seconds: a connector's list can change while the view stays
 * open (a tool it adds, a check or a removal in another window). A return
 * sooner reads once the few seconds are up.
 */
export function useReadAgainWhenBack(read: () => void): void {
	const readRef = useRef(read);
	readRef.current = read;
	useEffect(() => {
		let lastAt = Date.now();
		let later: ReturnType<typeof setTimeout> | undefined;
		const readNow = () => {
			later = undefined;
			lastAt = Date.now();
			readRef.current();
		};
		const back = () => {
			if (document.visibilityState !== "visible" || later !== undefined) return;
			const wait = READ_AGAIN_GAP_MS - (Date.now() - lastAt);
			if (wait <= 0) readNow();
			else later = setTimeout(readNow, wait);
		};
		window.addEventListener("focus", back);
		document.addEventListener("visibilitychange", back);
		return () => {
			clearTimeout(later);
			window.removeEventListener("focus", back);
			document.removeEventListener("visibilitychange", back);
		};
	}, []);
}

export function ConnectorsPage({ serviceBack, focus, onOpenRoom }: { /** Counts the page's reconnects after an outage. */ serviceBack?: number; /** A connector to open on and check, as Check connection does: from a failed step in a room. A new object each time. */ focus?: { name: string } | null; /** Leaves Settings for a room named on a connector's page. */ onOpenRoom?: (agentId: string) => void }) {
	// What this opening read, over the list as it was last read before: a connector's page opens on that one, but nothing is checked or started on it alone.
	const [read, setRead] = useState<McpConnectorsStatusResponse | null>(null);
	const [kept] = useState(keptConnectorList);
	const status = read ?? kept;
	// Whether the list on screen is what the last read that ended brought: not before the first, nor after a failed one until one succeeds.
	const [upToDate, setUpToDate] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [loading, setLoading] = useState(true);
	const [formAt, setFormAt] = useState<FormAt | null>(null);
	// The connector whose own page is open, and what its fix opened there; null shows the list.
	const [opened, setOpened] = useState<{ name: string; edit: ConnectorEdit | null } | null>(null);
	const [notice, setNotice] = useState<string | null>(null);
	const searchRef = useRef<HTMLInputElement>(null);
	// The directory's title goes to the top of the pane, so its search and first entries show, even under a phone's keyboard.
	const goToDirectory = () => {
		searchRef.current?.closest("section")?.scrollIntoView({ behavior: "smooth", block: "start" });
		searchRef.current?.focus({ preventScroll: true });
	};
	// Remote devices may read connector status, but the server's remote route
	// policy keeps add, remove, sign-in, sign-out, checks and address changes
	// local-only, so the section renders read-only over the tunnel. On a shared
	// server the status is not read at all (it shows every connector's address
	// or command line, which only the admin may see): one line says who sets
	// connectors up, and each room still chooses its own in room settings.
	const remoteClient = useRemoteClientContext();
	const readOnly = remoteClient.remote;
	const next = useSettingsLookNext();

	// The newest read started: an older one that answers after it, such as one from before a removal, draws nothing
	// and doesn't end the loading the newer one is still doing.
	const newestRead = useRef(0);
	const newestAnswer = useRef<Promise<McpConnectorsStatusResponse | null>>(Promise.resolve(null));
	const refresh = useCallback((): Promise<McpConnectorsStatusResponse | null> => {
		const mine = ++newestRead.current;
		setError(null);
		const answer = async () => {
			try {
				if ((await fetchRemoteClientContext()).sharedServer) return null;
				const list = await readConnectorList();
				if (mine === newestRead.current) {
					setRead(list);
					setUpToDate(true);
				}
				return list;
			} catch (e) {
				if (mine === newestRead.current) {
					setError((e as Error).message);
					setUpToDate(false);
				}
				return null;
			} finally {
				if (mine === newestRead.current) setLoading(false);
			}
		};
		newestAnswer.current = answer();
		return newestAnswer.current;
	}, []);

	useEffect(() => {
		void refresh();
	}, [refresh]);
	// With nothing read yet (the first read failed), the reread shows it is loading, as Try again does, not an empty list.
	useReadAgainWhenBack(() => {
		if (!status) setLoading(true);
		void refresh();
	});

	// A line saying the service could not be reached goes once it answers again
	// after an outage, and the connectors are read again.
	useEffect(() => {
		if (isServiceUnreachableLine(error)) void refresh();
	}, [serviceBack]);

	const work = useConnectorWork({
		status: read,
		refresh,
		readOnly,
		onNotice: setNotice,
		// One brought in from another app under the same name stays, with where to remove it; otherwise the list.
		onRemoved: (name, stillListed) => setOpened((current) => (current?.name === name && !stillListed ? null : current)),
	});

	const servers = status?.servers ?? [];
	const sharedSource = status?.configSources.find((source) => !source.path.includes(".exxperts"));
	const openedServer = useMemo(() => (opened ? servers.find((server) => server.name === opened.name) ?? null : null), [opened, servers]);
	// A connector gone from the list, removed elsewhere included, closes its page: a later one of the same name never opens by itself.
	useEffect(() => {
		if (opened && status && !openedServer) setOpened(null);
	}, [opened, status, openedServer]);

	// A room's failed step asked for this connector: its page opens and checks it, as Check connection does (for a program, that starts it, as the failed call already tried), so the page says why.
	// It opens at once where the list read before has it, and is checked once the list is read; never over remote access, where checks are the computer's.
	const [focusDone, setFocusDone] = useState<{ name: string } | null>(null);
	const focusWaits = focus && focusDone !== focus ? focus : null;
	useLayoutEffect(() => {
		if (!focusWaits || read || error || !kept?.servers.some((one) => one.name === focusWaits.name)) return;
		setNotice(null);
		setOpened({ name: focusWaits.name, edit: null });
	}, [focusWaits]);
	useEffect(() => {
		if (!focusWaits || !read) return;
		setFocusDone(focusWaits);
		const server = read.servers.find((one) => one.name === focusWaits.name);
		if (!server) return;
		setNotice(null);
		setOpened((current) => (current?.name === server.name ? current : { name: server.name, edit: null }));
		if (!readOnly) work.check(server);
	}, [focusWaits, read]);
	// A page opened on the list read before goes back to the list, and its failure line, where this opening's read failed.
	useEffect(() => {
		if (opened && !read && error) setOpened(null);
	}, [opened, read, error]);

	// While the list isn't up to date, a button waits for the read under way, reads again where it failed, and acts on
	// what it says, if the connector is still there and still offers the button pressed, which is busy meanwhile. A
	// row's page opens at once while this opening's first read is under way, and waits for one only after a failed read.
	const workNow = useRef(work);
	workNow.current = work;
	const mounted = useRef(true);
	useEffect(() => {
		mounted.current = true;
		return () => { mounted.current = false; };
	}, []);
	const [held, setHeld] = useState<Record<string, ConnectorButton>>({});
	const onceRead = async (name: string, act: (server: McpConnectorStatus) => void) => {
		let asked = error ? refresh() : newestAnswer.current;
		let answer = await asked;
		// Another read began meanwhile: only the newest one's answer is the list on screen.
		while (asked !== newestAnswer.current) answer = await (asked = newestAnswer.current);
		const server = answer?.servers.find((one) => one.name === name);
		if (server && mounted.current) act(server);
	};
	const offers = (server: McpConnectorStatus, button: ReturnType<typeof rowFix>) => rowFix(server, workNow.current.state(server), readOnly) === button;
	const pressOnceRead = async (name: string, button: RowButton | "remove" | "disconnect", act: (server: McpConnectorStatus) => void, still: (server: McpConnectorStatus) => boolean) => {
		setHeld((current) => ({ ...current, [name]: button }));
		await onceRead(name, (server) => { if (still(server)) act(server); });
		setHeld(({ [name]: _done, ...rest }) => rest);
	};
	const rowWork: ConnectorWork = upToDate ? work : {
		...work,
		busy: (name) => held[name] ?? work.busy(name),
		// Cancel stops what this page runs, so it never waits.
		press: (server, button) => void (button === "cancel" ? work.press(server, button) : pressOnceRead(server.name, button, (now) => workNow.current.press(now, button), (now) => offers(now, button))),
		remove: (server, asked) => void pressOnceRead(server.name, "remove", (now) => workNow.current.remove(now, asked), (now) => offers(now, "remove")),
	};
	// A page open before this opening's first read has answered, or before the check a room asked for has begun, says
	// Checking…, and what is pressed on it acts on that answer.
	const opening = opened !== null && (!read || focusWaits?.name === opened.name);
	const pageWork: ConnectorWork = !opening ? work : {
		...work,
		state: () => ({ kind: "checking" }),
		busy: (name) => held[name] ?? work.busy(name),
		disconnect: (server) => void pressOnceRead(server.name, "disconnect", (now) => workNow.current.disconnect(now), isSignedIn),
		remove: (server, asked) => void pressOnceRead(server.name, "remove", (now) => workNow.current.remove(now, asked), removableHere),
	};

	// The settings look's foot: each connector signing in or getting ready, in the order each began, newest last.
	// Drawn from the rows' states, so a sign-in the page waits for again after a reload is there too. None over remote access.
	const nowWaiting = next && !readOnly ? servers.filter((server) => waitsInFoot(work.state(server))).map((server) => server.name) : [];
	const waitingOrder = useRef<string[]>([]);
	waitingOrder.current = [...waitingOrder.current.filter((name) => nowWaiting.includes(name)), ...nowWaiting.filter((name) => !waitingOrder.current.includes(name))];
	const waiting = waitingOrder.current;
	const footRef = useRef<HTMLDivElement | null>(null);
	const listRef = useRef<HTMLDivElement | null>(null);
	const footShown = useRef<string[]>([]);
	// The strip whose Cancel has the focus: when it goes, the focus goes back to its row.
	const footFocus = useRef<string | null>(null);
	useEffect(() => {
		const before = footShown.current;
		footShown.current = waiting;
		const lost = !document.activeElement || document.activeElement === document.body;
		const gone = footFocus.current;
		if (gone !== null && !waiting.includes(gone)) {
			footFocus.current = null;
			const row = listRef.current?.children[servers.findIndex((server) => server.name === gone)];
			if (lost && row) return void (row.querySelector<HTMLElement>(".connector-item-side :is(button, a)") ?? row.querySelector<HTMLElement>(".connector-item-hit"))?.focus();
		}
		const newest = waiting.reduce((last, name, at) => (before.includes(name) ? last : at), -1);
		// The control the person pressed left the page as its sign-in or download began: the focus goes to the new strip's Cancel.
		if (newest < 0 || !lost) return;
		footRef.current?.children[newest]?.querySelector<HTMLElement>("button")?.focus();
	});

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

	const open = (name: string, edit: ConnectorEdit | null = null) => {
		setNotice(null);
		setOpened({ name, edit });
	};
	const openRow = (name: string, edit: ConnectorEdit | null) => {
		if (upToDate || (!edit && !read && !error)) return open(name, edit);
		void onceRead(name, (server) => open(name, edit && offers(server, edit === "key" ? "changeKey" : "changeAddress") ? edit : null));
	};

	if (opened && openedServer) {
		return (
			<ConnectorPage
				key={openedServer.name}
				server={openedServer}
				work={pageWork}
				readOnly={readOnly}
				sharedFile={sharedSource?.path ?? null}
				edit={opened.edit}
				onEdit={(edit) => {
					const show = () => setOpened((current) => (current?.name === openedServer.name ? { ...current, edit } : current));
					if (opening && edit) void onceRead(openedServer.name, show);
					else show();
				}}
				onBack={() => {
					setNotice(null);
					setOpened(null);
					// Left before its check began: the answer doesn't open it again.
					if (focusWaits) setFocusDone(focusWaits);
				}}
				onOpenRoom={onOpenRoom}
				notice={notice}
			/>
		);
	}

	async function addFromDirectory(entry: ConnectorDirectoryEntry, token?: string) {
		const added = await addMcpServer({ name: entry.id, url: entry.url, bearerToken: token });
		await refresh();
		setNotice(null);
		// One that signs in through its service goes on to its sign-in page at once: its row waits for it.
		if (entry.kind === "oauth") await work.signIn(added.name, null);
		// The rest are checked at once, their row reading "Checking…"; the notice follows once it connected.
		else if (await work.checkAdded(added.name)) setNotice(addedNotice(entry));
	}

	const closeForm = () => setFormAt(null);
	const formFor = (at: FormAt) => (
		<AddConnectorForm
			key={at.at}
			kind={at.at}
			onAdded={(name, typedName) => {
				setFormAt(null);
				const added = WORDS.addedCustom(connectorShownName(name, connectorDisplayName(typedName)));
				// Its row says how its check went; the notice follows only once it connected.
				setNotice(null);
				void work.checkAdded(name).then((connected) => {
					if (connected) setNotice(added);
				});
			}}
			onCancel={closeForm}
		/>
	);
	// The settings look opens an add form as a page of its own, in the list's place.
	if (next && formAt) return formFor(formAt);

	return (
		<>
			<PaneHeader
				title={WORDS.title}
				line={lineText(WORDS.subtitle, readOnly)}
				actions={readOnly ? undefined : (
					<AddConnectorMenu onChoose={(way) => {
						if (way === "directory") {
							setFormAt(null);
							goToDirectory();
						} else setFormAt({ at: way });
					}} />
				)}
			/>
			<section className="ai-setup-section settings-group connector-list-section" aria-label={WORDS.listTitle}>
				<GroupHeader kicker={WORDS.listTitle} />
				{notice && <p className="cli-note connector-notice" role="status">{notice}</p>}
				{error && (
					<div className="checkpoint-proposal-error connector-load-error">
						<span>{error}</span>
						<button type="button" className={next ? "rs-btn rs-btn-sm" : "rs-btn"} onClick={() => {
							setLoading(true);
							void refresh();
						}}>{WORDS.loadAgain}</button>
					</div>
				)}
				{formAt && formFor(formAt)}
				{!error && loading && !status && <p className="ai-setup-copy">Loading connectors…</p>}
				{servers.length > 0 && (
					<div className="connector-list" ref={listRef}>
						{servers.map((server) => (
							<ConnectorRow key={server.name} server={server} work={rowWork} readOnly={readOnly} onOpen={(edit) => openRow(server.name, edit ?? null)} />
						))}
					</div>
				)}
				{!error && status && servers.length === 0 && (
					readOnly ? (
						<p className="cli-note">{WORDS.setUpOnComputer}</p>
					) : (
						<p className="settings-empty">
							{WORDS.noneYet} {WORDS.empty.before}
							<button type="button" className="connector-text-btn" onClick={goToDirectory}>{WORDS.empty.link}</button>
							{WORDS.empty.after}
						</p>
					)
				)}
				{readOnly && servers.length > 0 && <p className="cli-note">{WORDS.setUpOnComputer}</p>}
			</section>
			{!readOnly && (
				<ConnectorDirectory
					status={status}
					onAdd={addFromDirectory}
					searchRef={searchRef}
					onCloseForm={closeForm}
				/>
			)}
			{status && (
				<section className="ai-setup-section connector-config-note" aria-label={WORDS.title}>
					<p className="cli-note">All product names and logos are trademarks of their respective owners, used for identification only.</p>
				</section>
			)}
			{waiting.length > 0 && (
				<div className="connector-waiting-foot" role="status" ref={footRef}>
					{waiting.map((name) => {
						const server = servers.find((one) => one.name === name)!;
						return (
							<div className="connector-waiting" key={name} onFocus={() => { footFocus.current = name; }} onBlur={(e) => { if (e.relatedTarget) footFocus.current = null; }}>
								<span className="connector-dot connector-dot-busy" aria-hidden="true" />
								<span className="connector-waiting-text">
									<span className="connector-waiting-name">{shownName(server)}</span>
									<span className="connector-waiting-line">{rowNote(server, work.state(server), readOnly)}</span>
								</span>
								<FixButton server={server} button="cancel" work={work} onEdit={(edit) => open(name, edit)} small />
							</div>
						);
					})}
				</div>
			)}
		</>
	);
}
