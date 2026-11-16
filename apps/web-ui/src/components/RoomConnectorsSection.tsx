import { useEffect, useMemo, useRef, useState } from "react";
import type { PersistentAgentStatus } from "../types";
import { fetchPersistentRoomMcpConnectors, updatePersistentRoomMcpConnector, type PersistentRoomGrantedConnectorStatus, type PersistentRoomMcpConnectorsResponse } from "../persistent-room-management-api";
import { fetchMcpConnectorsStatus, McpRequestError, type McpConnectorStatus } from "../mcp-api";
import { fetchRemoteClientContext, SHARED_SERVER_ADMIN_LINE, showsComputerOnlyControls, useRemoteClientContext } from "../remote-client-context";
import { CONNECTOR_ICONS } from "../connector-icons";
import { CONNECTOR_WORDS, importedFrom, lineText, shownName } from "../connector-rows";
import { CONNECTOR_REQUEST_LINES, isValidMcpConnectorName } from "../../../web-server/src/connector-form";
import { RsInfo } from "./rs-info";
import { PaneHeader } from "./pane-header";

/**
 * Room settings wheel, Connectors panel (per-room MCP v1). Mirrors the Skills
 * panel's enabled-first shape: the room shows ONLY its enabled connectors,
 * adding more goes through a picker over the globally configured rest. Rows
 * borrow the global Connectors page's avatar + name + target look so the two
 * surfaces read as one feature. Changes apply to a running conversation from
 * the room's next reply on. New rooms start with nothing enabled; connectors
 * are added and managed globally in Settings, Connectors.
 */
export function RoomConnectorsSection({ status, onOpenConnectors }: { status: PersistentAgentStatus; onOpenConnectors?: () => void }) {
	const [granted, setGranted] = useState<PersistentRoomGrantedConnectorStatus[] | null>(null);
	const [configured, setConfigured] = useState<string[] | null>(null);
	const [globalServers, setGlobalServers] = useState<Map<string, McpConnectorStatus>>(new Map());
	const [displayNames, setDisplayNames] = useState<Record<string, string>>({});
	const [allowedTools, setAllowedTools] = useState<NonNullable<PersistentRoomMcpConnectorsResponse["allowedTools"]>>({});
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

	useEffect(() => {
		let cancelled = false;
		latest.current++;
		setGranted(null);
		setConfigured(null);
		setError(null);
		setLoadFailure(null);
		// The connector status only adds detail to the rows, and the pane works
		// without it. On a shared server only the admin may read it (it shows
		// every connector's address or command line), so it is not asked for.
		const globalStatus = fetchRemoteClientContext()
			.then((context) => (context.sharedServer ? null : fetchMcpConnectorsStatus()))
			.catch(() => null);
		Promise.all([fetchPersistentRoomMcpConnectors(status.id), globalStatus])
			.then(([room, global]) => {
				if (cancelled) return;
				showRoom(room);
				if (global) setGlobalServers(new Map(global.servers.map((server) => [server.name, server] as const)));
			})
			.catch((e) => {
				if (!cancelled) setLoadFailure(refusedAs(e, 410) ? "archived" : "failed");
			});
		return () => {
			cancelled = true;
		};
	}, [status.id, readCount]);

	function showRoom(room: PersistentRoomMcpConnectorsResponse) {
		setGranted(room.granted);
		setConfigured(room.configuredConnectors);
		setDisplayNames(room.displayNames ?? {});
		setAllowedTools(room.allowedTools ?? {});
	}

	/** Remove takes its own button away: focus goes to the connector's next allowed tool, or to the connector's own button. */
	function focusAfterRemove(name: string) {
		const row = Array.from(rowsRef.current?.querySelectorAll<HTMLElement>(".room-skills-row") ?? []).find((element) => element.dataset.connector === name);
		(row?.querySelector<HTMLButtonElement>(".room-connector-allowed button") ?? row?.querySelector<HTMLButtonElement>(".room-skills-row-actions button"))?.focus();
	}

	async function toggle(name: string, action: "grant" | "revoke" | "forget-tool", tool?: string) {
		const mine = ++latest.current;
		setBusyName(tool === undefined ? name : busyTool(name, tool));
		setError(null);
		try {
			showRoom(await updatePersistentRoomMcpConnector(status.id, action, name, tool));
			if (action === "forget-tool") setFocusAfter(name);
		} catch (e) {
			if (refusedAs(e, 410)) setError(words.archived);
			else if (refusedAs(e, 400) && action === "grant") {
				// Turning on is refused only for a connector that has gone since the list was read, which reading it again drops.
				setError(CONNECTOR_REQUEST_LINES.noLongerExists);
				void fetchPersistentRoomMcpConnectors(status.id).then((room) => {
					if (latest.current === mine) showRoom(room);
				}, () => undefined);
			} else setError(CONNECTOR_REQUEST_LINES.saveFailed);
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

	return (
		<div className="room-skills-section room-connectors-section">
			<PaneHeader
				title="Connectors"
				line={<>
					{enabledCount > 0 ? `${enabledCount} enabled. Controls which connectors this room can use.` : "Controls which connectors this room can use."}
					<RsInfo text="This room can only see and call the connectors enabled here. Enabling or disabling takes effect right away, from the room's next reply on, and scheduled runs of this room use the same list. Deleting a connector on the Connectors page disables it in every room. Connectors are added and managed globally in Settings, Connectors (the gear at the bottom of the sidebar)." />
					{loaded && (configured.length > 0 || granted.length > 0) && <><br />{remoteClient.sharedServer ? "Reading runs freely. Anything else asks you first. This goes by what each connector says about its own tools." : "Reading runs freely. Anything else asks you first, unless you allowed it below."}</>}
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
											<span className="room-connector-allowed-label">Allowed without asking:</span>
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

/** What a Remove under a connector waits on: a name can't hold a line break, so it never meets a connector's own. */
const busyTool = (name: string, tool: string) => `${name}\n${tool}`;

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
