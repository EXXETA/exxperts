import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { PersistentAgentStatus } from "../types";
import { fetchPersistentRoomMcpConnectors, updatePersistentRoomMcpConnector, type PersistentRoomMcpConnectorsResponse } from "../persistent-room-management-api";
import { McpRequestError, type McpConnectorStatus } from "../mcp-api";
import { keepRoomConnectors, keptConnectorList, keptRoomConnectors, readConnectorList } from "../connectors-list-kept";
import { fetchRemoteClientContext, SHARED_SERVER_ADMIN_LINE, showsComputerOnlyControls, useRemoteClientContext } from "../remote-client-context";
import { CONNECTOR_ICONS } from "../connector-icons";
import { catalogEntryOf, CONNECTOR_WORDS, connectorRowState, type DotLook, importedFrom, lineText, rowLook, shownName, wentWrongLine } from "../connector-rows";
import { CONNECTOR_REQUEST_LINES, isValidMcpConnectorName } from "../../../web-server/src/connector-form";
import { RsInfo } from "./rs-info";
import { PaneHeader } from "./pane-header";
import { CONNECTORS_EACH_TOOL_LINE, CONNECTORS_WITHOUT_ASKING_LINE } from "../../../web-server/src/room-box/card-text";
import { useSettingsLookNext } from "../settings-look";
import { roomListOnCount } from "../skill-source-copy";
import { ConnectorAvatar } from "./connector-page";
import { useReadAgainWhenBack } from "./ConnectorsPage";

/** In the settings look, the control the keyboard goes to once a change is drawn: a connector's switch or Remove, or the old answer's Remove now at that place in their list. */
type Refocus = { connector: string } | { oldAnswer: number; connector: string };

/**
 * Room settings wheel, Connectors panel (per-room MCP v1). Mirrors the Skills
 * panel's enabled-first shape: the room shows ONLY its enabled connectors,
 * adding more goes through a picker over the globally configured rest. Rows
 * borrow the global Connectors page's avatar + name + target look so the two
 * surfaces read as one feature. Changes apply to a running conversation from
 * the room's next reply on. New rooms start with nothing enabled; connectors
 * are added and managed globally in Settings, Connectors. In the settings look,
 * every connector added in Settings is listed instead, with a switch each and
 * no picker: one list, the ones on first, under how many are on.
 */
export function RoomConnectorsSection({ status, onOpenConnectors }: { status: PersistentAgentStatus; onOpenConnectors?: () => void }) {
	// The room's connectors, and Settings' list for their rows' detail: as last read until this opening's read is in.
	const [room, setRoom] = useState(() => keptRoomConnectors(status.id));
	const [list, setList] = useState(keptConnectorList);
	const granted = room?.granted ?? null;
	const configured = room?.configuredConnectors ?? null;
	const displayNames: Record<string, string> = room?.displayNames ?? NONE;
	const allowedTools: NonNullable<PersistentRoomMcpConnectorsResponse["allowedTools"]> = room?.allowedTools ?? NONE;
	const asksNothing = room?.asksNothing === true;
	const globalServers = useMemo(() => new Map((list?.servers ?? []).map((server) => [server.name, server] as const)), [list]);
	// The connector, or the connector and tool, a change waits on.
	const [busyName, setBusyName] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [pickerOpen, setPickerOpen] = useState(false);
	const [query, setQuery] = useState("");
	// Why the room's connectors couldn't be read: an archived room, or anything else, which Try again reads again.
	const [loadFailure, setLoadFailure] = useState<"archived" | "failed" | null>(null);
	const [readCount, setReadCount] = useState(0);
	// Counts the pane's reads and changes, so a read started before a later one never shows over it.
	const latest = useRef(0);
	// Whether the server has answered since the pane opened: before that the list is the kept one.
	const answered = useRef(false);
	const rowsRef = useRef<HTMLDivElement>(null);
	// The connector a Remove under it took a tool from: focus moves once the list without that tool is drawn.
	const [focusAfter, setFocusAfter] = useState<string | null>(null);
	useEffect(() => {
		if (focusAfter === null) return;
		focusAfterRemove(focusAfter);
		setFocusAfter(null);
	}, [focusAfter, allowedTools]);
	const remoteClient = useRemoteClientContext();
	const remote = remoteClient.remote;
	const words = CONNECTOR_WORDS.room;
	const next = useSettingsLookNext();
	const idBase = useId();
	const sectionRef = useRef<HTMLDivElement>(null);
	// In the settings look: which group each connector sits in, as the room had it when the page was read, so a switch never moves its row.
	const [placement, setPlacement] = useState<ReadonlyMap<string, boolean> | null>(null);
	const [refocus, setRefocus] = useState<Refocus | null>(null);
	useEffect(() => {
		if (refocus === null) return;
		const section = sectionRef.current;
		const answers = Array.from(section?.querySelectorAll<HTMLButtonElement>(".room-connector-answer button") ?? []);
		const row = Array.from(section?.querySelectorAll<HTMLElement>(".room-skills-row") ?? []).find((element) => element.dataset.connector === refocus.connector);
		(("oldAnswer" in refocus ? answers[refocus.oldAnswer] : undefined) ?? row?.querySelector<HTMLElement>(".room-skills-row-actions :is(input, button)"))?.focus();
		setRefocus(null);
	}, [refocus, granted, allowedTools, busyName]);
	// In the settings look a refused change's strip comes into view, after the focus has gone back: the press may be far down the page.
	const errorRef = useRef<HTMLDivElement>(null);
	useEffect(() => {
		if (next && error && refocus === null) errorRef.current?.scrollIntoView({ block: "nearest" });
	}, [next, error, refocus]);

	useEffect(() => {
		let cancelled = false;
		// The opening read takes the same turn as a read on coming back: a slow answer never replaces a newer one.
		const mine = ++latest.current;
		answered.current = false;
		setRoom(keptRoomConnectors(status.id));
		setPlacement(null);
		setError(null);
		setLoadFailure(null);
		// The connector status only adds detail to the rows, and the pane works
		// without it. On a shared server only the admin may read it (it shows
		// every connector's address or command line), so it is not asked for.
		const globalStatus = fetchRemoteClientContext()
			.then((context) => (context.sharedServer ? null : readConnectorList()))
			.catch(() => null);
		Promise.all([fetchPersistentRoomMcpConnectors(status.id), globalStatus])
			.then(([read]) => {
				if (cancelled) return;
				// A switch flipped on the kept list has the room's newer answer, but says nothing of the rows' detail.
				setList(keptConnectorList());
				if (latest.current === mine) showRead(read);
			})
			.catch((e) => {
				if (!cancelled && latest.current === mine) showLoadFailure(e);
			});
		return () => {
			cancelled = true;
		};
	}, [status.id, readCount]);

	// Back in front, the room's connectors and their tool counts are read again in place, unless a change or a read
	// started since. Not while a change is being saved: a read then could have the room from before it and answer after it.
	useReadAgainWhenBack(() => {
		if (busyName !== null) return;
		const mine = ++latest.current;
		// Taking the opening read's place, a failed read says so as the opening read would, so the pane never waits on.
		const opening = !answered.current;
		const globalStatus = fetchRemoteClientContext().then((context) => (context.sharedServer ? null : readConnectorList())).catch(() => null);
		void Promise.all([fetchPersistentRoomMcpConnectors(status.id), globalStatus]).then(([read]) => {
			if (latest.current !== mine) return;
			setLoadFailure(null);
			showRead(read);
			setList(keptConnectorList());
		}, (e) => {
			if (opening && latest.current === mine) showLoadFailure(e);
		});
	});

	function showRoom(read: PersistentRoomMcpConnectorsResponse) {
		answered.current = true;
		keepRoomConnectors(status.id, read);
		setRoom(read);
	}

	/** A read's answer: the pane's first places the rows. */
	function showRead(read: PersistentRoomMcpConnectorsResponse) {
		if (!answered.current) setPlacement(null);
		showRoom(read);
	}

	/** An archived room's connectors can't be changed, so its kept list goes; after any other failure it stays. */
	function showLoadFailure(e: unknown) {
		const archived = refusedAs(e, 410);
		if (archived) {
			keepRoomConnectors(status.id, null);
			setRoom(null);
		}
		setLoadFailure(archived ? "archived" : "failed");
	}

	/** Remove takes its own button away: focus goes to the connector's next allowed tool, or to the connector's own button. */
	function focusAfterRemove(name: string) {
		const row = Array.from(rowsRef.current?.querySelectorAll<HTMLElement>(".room-skills-row") ?? []).find((element) => element.dataset.connector === name);
		(row?.querySelector<HTMLButtonElement>(".room-connector-allowed button") ?? row?.querySelector<HTMLButtonElement>(".room-skills-row-actions button"))?.focus();
	}

	/** focus, in the settings look: where the keyboard goes once the change is saved, and once it is refused. */
	async function toggle(name: string, action: "grant" | "revoke" | "forget-tool", tool?: string, focus?: { saved: Refocus; refused: Refocus }) {
		const mine = ++latest.current;
		setBusyName(tool === undefined ? name : busyTool(name, tool));
		setError(null);
		// The room read again, unless a change or a read started since.
		const readAgain = () => void fetchPersistentRoomMcpConnectors(status.id).then((read) => {
			if (latest.current === mine) showRead(read);
		}, (e) => {
			if (latest.current === mine && !answered.current) showLoadFailure(e);
		});
		try {
			showRoom(await updatePersistentRoomMcpConnector(status.id, action, name, tool));
			if (focus) setRefocus(focus.saved);
			else if (action === "forget-tool" && !next) setFocusAfter(name);
		} catch (e) {
			if (focus) setRefocus(focus.refused);
			// Turning on is refused only for a connector that has gone since the list was read, which reading it again drops.
			const gone = refusedAs(e, 400) && action === "grant";
			// Before the first answer, the change took the opening read's place and brought none of its own.
			if (gone || !answered.current) readAgain();
			if (refusedAs(e, 410)) setError(words.archived);
			// Over remote access the computer refuses every change here, and says so in its own sentence: trying again can't help.
			else if (next && remote && refusedAs(e, 403)) setError((e as Error).message);
			else setError(gone ? CONNECTOR_REQUEST_LINES.noLongerExists : CONNECTOR_REQUEST_LINES.saveFailed);
		} finally {
			setBusyName(null);
		}
	}

	// The room's own answer carries the typed names, so a member who can't read the full status sees them too.
	// A program's line says where it runs; its command stays in the tooltip.
	const targetLine = (server: McpConnectorStatus) => (server.transport === "http" ? server.target : remote ? CONNECTOR_WORDS.status.programRemote : CONNECTOR_WORDS.status.program);
	const shownOf = (name: string) => shownName({ name, displayName: globalServers.get(name)?.displayName ?? displayNames[name] });
	const grantedNames = useMemo(() => new Set((granted ?? []).map((entry) => entry.name)), [granted]);
	// The enable-able set is configured MINUS granted. The button must gate on
	// this count, not on a size comparison: a dangling grant (connector deleted
	// globally) inflates grantedNames without shrinking the enable-able rest.
	const enableable = useMemo(() => (configured ?? []).filter((name) => !grantedNames.has(name)), [configured, grantedNames]);
	const available = useMemo(() => {
		const q = query.trim().toLowerCase();
		if (!q) return enableable;
		return enableable.filter((name) => {
			const server = globalServers.get(name);
			return `${shownOf(name)} ${name} ${server?.target ?? ""}`.toLowerCase().includes(q);
		});
	}, [enableable, query, globalServers, displayNames]);

	const loaded = granted !== null && configured !== null;
	const enabledCount = (granted ?? []).filter((entry) => entry.configured).length;
	const nothingYet = loaded && configured.length === 0 && granted.length === 0;
	// Connectors are added on the Connectors page, so the way there stays once
	// nothing is left to enable. Only where a person can add one: on a shared
	// server or a remote device that page cannot add any.
	const addElsewhere = onOpenConnectors && showsComputerOnlyControls(remoteClient) ? onOpenConnectors : undefined;
	const openConnectors = addElsewhere;
	const emptyWay = remoteClient.sharedServer ? SHARED_SERVER_ADMIN_LINE : remote ? CONNECTOR_WORDS.setUpOnComputer : words.empty;
	const toolLine = remoteClient.sharedServer ? "Reading runs freely. Anything else asks you first. This goes by what each connector says about its own tools." : asksNothing ? CONNECTORS_WITHOUT_ASKING_LINE : CONNECTORS_EACH_TOOL_LINE;

	// The settings look: every connector added in Settings, in Settings' order; then any the room has on that has since been removed. The list below puts the ones on first.
	const lookRows = useMemo(() => {
		if (granted === null || configured === null) return null;
		const on = new Set(granted.map((entry) => entry.name));
		return [...configured.map((name) => ({ name, on: on.has(name), gone: false })), ...granted.filter((entry) => !entry.configured).map((entry) => ({ name: entry.name, on: true, gone: true }))];
	}, [granted, configured]);
	// The first read places the rows; later reads only change their switches.
	useEffect(() => {
		if (next && lookRows && !placement) setPlacement(new Map(lookRows.map((row) => [row.name, row.on] as const)));
	}, [next, lookRows, placement]);

	if (next) {
		const placedOn = (row: LookRow) => placement?.get(row.name) ?? row.on;
		const rows = lookRows ?? [];
		const ordered = [...rows.filter(placedOn), ...rows.filter((row) => !placedOn(row))];
		const oldAnswers = (granted ?? []).flatMap((entry) => (Object.hasOwn(allowedTools, entry.name) ? allowedTools[entry.name] : []).map((answer) => ({ connector: entry.name, ...answer })));
		const renderRow = (row: LookRow, at: number, all: LookRow[]) => {
			const server = globalServers.get(row.name);
			const shown = shownOf(row.name);
			const nameId = `${idBase}-${row.name}-name`;
			const lineId = `${idBase}-${row.name}-line`;
			const badName = !row.gone && !isValidMcpConnectorName(row.name);
			const line = row.gone
				? { text: lineText(words.gone, remote), dot: "err" as const, soft: true, opens: false }
				: badName
					? { text: words.badName(server ? importedFrom(server) : null), dot: "err" as const, soft: true, opens: false }
					: server ? lookLine(server, remote, targetLine(server), openConnectors !== undefined) : null;
			const busy = busyName === row.name;
			const hadFocus = (target: Element) => document.activeElement === target;
			// A Remove that takes its row away hands the keyboard to the row after it, else the one before.
			const neighbour = all[at + 1]?.name ?? all[at - 1]?.name ?? row.name;
			return (
				<div key={row.name} className={`room-skills-row${badName || row.gone ? " is-wrapping" : ""}${line?.opens ? " has-open" : ""}`} data-connector={row.name}>
					<ConnectorAvatar id={(server && catalogEntryOf(server)?.id) ?? row.name} name={shown} size={32} letters={2} />
					<div className="room-skills-row-main">
						<span id={nameId} className="room-skills-name">{shown}</span>
						{line && (
							<span className={`room-connector-line${line.soft ? " is-broken" : ""}`}>
								{line.dot && <span className={`connector-dot connector-dot-${line.dot}`} aria-hidden="true" />}
								{/* What a control on the row is described by: the line's words, not the button after them. */}
								<span id={lineId} className="room-connector-fact" title={line.text}>{line.text}</span>
								{line.opens && <button type="button" className="rs-text-btn room-connector-open" onClick={openConnectors}>Open connectors</button>}
							</span>
						)}
					</div>
					{!badName && (
						<div className="room-skills-row-actions">
							{row.gone
								? <button type="button" className="rs-btn rs-btn-sm" disabled={busy} title={words.removeGoneTitle} aria-describedby={line ? lineId : undefined} onClick={(e) => void toggle(row.name, "revoke", undefined, hadFocus(e.currentTarget) ? { saved: { connector: neighbour }, refused: { connector: row.name } } : undefined)}>{busy ? "Removing…" : "Remove"}</button>
								: <label className="room-connector-switch">
									<input
										className="workspaces-tool-switch"
										data-look-only=""
										type="checkbox"
										role="switch"
										checked={busy ? !row.on : row.on}
										disabled={busy}
										aria-labelledby={nameId}
										aria-describedby={line ? lineId : undefined}
										onChange={(e) => void toggle(row.name, row.on ? "revoke" : "grant", undefined, hadFocus(e.currentTarget) ? { saved: { connector: row.name }, refused: { connector: row.name } } : undefined)}
									/>
								</label>}
						</div>
					)}
				</div>
			);
		};
		const onCount = loaded && rows.length > 0 ? roomListOnCount(rows.filter((row) => row.on).length, rows.length) : null;
		return (
			<div className="room-skills-section room-connectors-section" ref={sectionRef}>
				<PaneHeader
					title="Connectors"
					beside={onCount}
					// An archived room can't change its connectors: no lead telling a person to switch one on.
					line={loadFailure === "archived" ? null : <>{words.lead}{loaded && (configured.length > 0 || granted.length > 0) && <>{" "}{toolLine}</>}{openConnectors && <>{" "}<button type="button" className="rs-text-btn pane-lead-link" onClick={openConnectors}>{words.manage}</button></>}</>}
				/>
				{loadFailure === "archived" && <div className="checkpoint-proposal-error is-archived">{words.archived}</div>}
				{loadFailure === "failed" && (
					<div className="checkpoint-proposal-error connector-load-error">
						<span>{words.loadFailed}</span>
						<button type="button" className="rs-btn rs-btn-sm" onClick={() => setReadCount((count) => count + 1)}>{CONNECTOR_WORDS.loadAgain}</button>
					</div>
				)}
				{!loaded && loadFailure === null && <p className="ai-setup-copy">Loading connectors…</p>}
				{/* At the computer, the way to add one is at the end of the lead. */}
				{nothingYet && <p className="settings-empty">{CONNECTOR_WORDS.noneYet}{(remoteClient.sharedServer || remote) && ` ${emptyWay}`}</p>}
				{loaded && rows.length > 0 && (
					<>
						{error && <div ref={errorRef} className="checkpoint-proposal-error" role="alert">{error}</div>}
						<div className="room-connector-groups" ref={rowsRef}>
							<div className="room-connector-group">
								{/* A phone's: the bar names the page there, so no title has it beside. */}
								<p className="room-list-count">{onCount}</p>
								<div className="room-skills-rows">{ordered.map(renderRow)}</div>
							</div>
							{oldAnswers.length > 0 && (
								<div className="room-connector-group">
									<h3 className="room-connector-group-title">{words.allowedHereTitle}</h3>
									<div className="room-skills-rows room-connector-answers">
										{oldAnswers.map(({ connector, tool, shown }, at) => {
											const busy = busyName === busyTool(connector, tool);
											return (
												<div key={busyTool(connector, tool)} className="room-connector-answer">
													<span className="room-connector-answer-text"><span className="room-connector-tool">{shown}</span><span className="room-connector-of">{shownOf(connector)}</span></span>
													{!remote && (
														<button type="button" className="rs-btn rs-btn-sm" disabled={busy} aria-label={`Remove ${shown}`} onClick={(e) => void toggle(connector, "forget-tool", tool, document.activeElement === e.currentTarget ? { saved: { oldAnswer: at, connector }, refused: { oldAnswer: at, connector } } : undefined)}>
															{busy ? "Removing…" : "Remove"}
														</button>
													)}
												</div>
											);
										})}
									</div>
								</div>
							)}
						</div>
					</>
				)}
			</div>
		);
	}

	return (
		<div className="room-skills-section room-connectors-section">
			<PaneHeader
				title="Connectors"
				line={<>
					{enabledCount > 0 ? `${enabledCount} enabled. Controls which connectors this room can use.` : "Controls which connectors this room can use."}
					<RsInfo text="This room can only see and call the connectors enabled here. Enabling or disabling takes effect right away, from the room's next reply on, and scheduled runs of this room use the same list. Deleting a connector on the Connectors page disables it in every room. Connectors are added and managed globally in Settings, Connectors (the gear at the bottom of the sidebar)." />
					{loaded && (configured.length > 0 || granted.length > 0) && <><br />{toolLine}</>}
				</>}
				actions={loaded && enableable.length > 0 && !pickerOpen
					? <button className="rs-btn" onClick={() => { setPickerOpen(true); setQuery(""); }}>Enable connectors</button>
					: loaded && enableable.length === 0 && !pickerOpen && openConnectors
						? <button className="rs-btn" type="button" onClick={openConnectors}>Open connectors</button>
						: null}
			/>
			{loadFailure === "archived" && <div className="checkpoint-proposal-error">{words.archived}</div>}
			{loadFailure === "failed" && (
				<div className="checkpoint-proposal-error connector-load-error">
					<span>{words.loadFailed}</span>
					<button type="button" className="rs-btn" onClick={() => setReadCount((count) => count + 1)}>{CONNECTOR_WORDS.loadAgain}</button>
				</div>
			)}
			{!loaded && loadFailure === null && <p className="ai-setup-copy">Loading connectors…</p>}
			{nothingYet && (
				<p className="settings-empty">{CONNECTOR_WORDS.noneYet} {emptyWay}</p>
			)}
			{loaded && (configured.length > 0 || granted.length > 0) && (
				<>
					{error && <div className="checkpoint-proposal-error">{error}</div>}
					{granted.length === 0 && configured.length > 0 && (
						<p className="ai-setup-copy room-skills-empty">No connectors enabled for this room yet.</p>
					)}
					<div className="room-skills-rows" ref={rowsRef}>
						{granted.map((entry) => {
							const server = globalServers.get(entry.name);
							return (
								<div key={entry.name} className="room-skills-row" data-connector={entry.name}>
									<RoomConnectorAvatar name={entry.name} shown={shownOf(entry.name)} />
									<div className="room-skills-row-main">
										<span className="room-skills-name-row">
											<span className="room-skills-name">{shownOf(entry.name)}</span>
											{entry.configured && <span className="room-skills-live">Enabled</span>}
										</span>
										{server && (
											<span className="room-skills-desc" title={server.target}>
												{targetLine(server)}
												{server.tools ? ` · ${server.tools.count} tool${server.tools.count === 1 ? "" : "s"}` : ""}
											</span>
										)}
										{!entry.configured && (
											<span className="room-skills-warn">{lineText(words.gone, remote)}</span>
										)}
									</div>
									<div className="room-skills-row-actions">
										<button className="rs-btn" disabled={busyName === entry.name} title={entry.configured ? words.removeTitle : words.removeGoneTitle} onClick={() => void toggle(entry.name, "revoke")}>
											{busyName === entry.name ? "Removing…" : "Remove"}
										</button>
									</div>
									{(Object.hasOwn(allowedTools, entry.name) ? allowedTools[entry.name] : []).length > 0 && (
										// Its own line under the connector, so each Remove sits by what it takes back; only at the computer, as a phone can't change the room's connectors.
										<div className="room-connector-allowed">
											<span className="room-connector-allowed-label">{words.allowedHere}</span>
											<ul>
												{allowedTools[entry.name].map(({ tool, shown }) => (
													<li key={tool}>
														<span>{shown}</span>
														{!remote && (
															<button type="button" className="rs-btn rs-btn-sm" disabled={busyName === busyTool(entry.name, tool)} aria-label={`Remove ${shown}`} onClick={() => void toggle(entry.name, "forget-tool", tool)}>
																{busyName === busyTool(entry.name, tool) ? "Removing…" : "Remove"}
															</button>
														)}
													</li>
												))}
											</ul>
										</div>
									)}
								</div>
							);
						})}
					</div>
					{pickerOpen && (
						<div className="room-skills-picker">
							<div className="room-skills-picker-head">
								<input
									type="text"
									className="room-skills-picker-search"
									placeholder="Search configured connectors…"
									value={query}
									autoFocus
									onChange={(e) => setQuery(e.target.value)}
								/>
								<button className="rs-btn rs-btn-icon" aria-label="Close connector picker" onClick={() => setPickerOpen(false)}>✕</button>
							</div>
							<div className="room-skills-picker-list">
								{available.length === 0 && <p className="ai-setup-copy">{query.trim() ? "No connectors match." : "Every configured connector is already enabled."}</p>}
								{available.map((name) => {
									const server = globalServers.get(name);
									// A name rooms can't take is shown with why, not with an Enable that would be refused.
									const roomsTakeIt = isValidMcpConnectorName(name);
									return (
										<div key={name} className="room-skills-row">
											<RoomConnectorAvatar name={name} shown={shownOf(name)} />
											<div className="room-skills-row-main">
												<span className="room-skills-name">{shownOf(name)}</span>
												{server && (
													<span className="room-skills-desc" title={server.target}>
														{targetLine(server)}
														{server.tools ? ` · ${server.tools.count} tool${server.tools.count === 1 ? "" : "s"}` : ""}
													</span>
												)}
												{!roomsTakeIt && <span className="room-skills-warn">{words.badName(server ? importedFrom(server) : null)}</span>}
											</div>
											{roomsTakeIt && (
												<div className="room-skills-row-actions">
													<button className="rs-btn" disabled={busyName === name} title="Let this room use this connector" onClick={() => void toggle(name, "grant")}>
														{busyName === name ? "Enabling…" : "Enable"}
													</button>
												</div>
											)}
										</div>
									);
								})}
							</div>
							{addElsewhere && (
								<div className="room-connectors-picker-foot">
									<span>Not in this list? Add it on the Connectors page first.</span>
									<button className="rs-btn" type="button" onClick={addElsewhere}>Open connectors</button>
								</div>
							)}
						</div>
					)}
				</>
			)}
		</div>
	);
}

const NONE: Record<string, never> = {};

/** What a Remove under a connector waits on: a name can't hold a line break, so it never meets a connector's own. */
const busyTool = (name: string, tool: string) => `${name}\n${tool}`;

/** A connector as the settings look lists it in a room: on or off here, or on here and since removed from the app. */
interface LookRow {
	name: string;
	on: boolean;
	gone: boolean;
}

/**
 * A row's second line in the settings look, from the state the connectors'
 * list reads: a healthy one's place and tool count, with no dot; one that
 * needs a sign-in its state; a broken one what went wrong. It says the same
 * whether the row's switch is on or off, so a switch flipped moves nothing.
 * opens: "Open connectors" follows, on a row that needs a sign-in and a broken
 * one, where the person can add or fix one.
 */
function lookLine(server: McpConnectorStatus, remote: boolean, place: string, canOpen: boolean): { text: string; dot: DotLook | null; soft: boolean; opens: boolean } {
	const state = connectorRowState(server, server.lastCheck, null);
	const look = rowLook(state, remote);
	if (state.kind === "not-connected" || state.kind === "needs-reconnecting") return { text: look.status, dot: look.dot, soft: look.broken, opens: canOpen };
	if (look.broken) return { text: wentWrongLine(server, state, remote)?.line.fact ?? look.status, dot: look.dot, soft: true, opens: canOpen };
	return { text: server.tools ? `${place} · ${CONNECTOR_WORDS.toolCount(server.tools.count)}` : place, dot: null, soft: false, opens: false };
}

/** A refusal with one of these statuses: 410, the room is archived; 400 on turning one on, the connector is gone. */
const refusedAs = (e: unknown, status: number) => e instanceof McpRequestError && e.status === status;

/** Same avatar the global Connectors page uses: brand glyph or monogram. */
function RoomConnectorAvatar({ name, shown }: { name: string; shown: string }) {
	const icon = CONNECTOR_ICONS[name];
	return (
		<span className="connector-avatar" style={{ width: 28, height: 28 }}>
			{icon ? (
				<svg viewBox="0 0 24 24" width={15} height={15} aria-hidden="true"><path d={icon} fill="currentColor" /></svg>
			) : (
				shown.slice(0, 1).toUpperCase()
			)}
		</span>
	);
}
