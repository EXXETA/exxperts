import { useEffect, useMemo, useState } from "react";
import type { PersistentAgentStatus } from "../types";
import { fetchPersistentRoomMcpConnectors, updatePersistentRoomMcpConnector, type PersistentRoomGrantedConnectorStatus } from "../persistent-room-management-api";
import { fetchMcpConnectorsStatus, type McpConnectorStatus } from "../mcp-api";
import { CONNECTOR_ICONS } from "../connector-icons";
import { RsInfo } from "./rs-info";

/**
 * Room settings wheel, Connectors panel (per-room MCP v1). Mirrors the Skills
 * panel's enabled-first shape: the room shows ONLY its enabled connectors,
 * adding more goes through a picker over the globally configured rest. Rows
 * borrow the global Connectors page's avatar + name + target look so the two
 * surfaces read as one feature. Changes apply to a running conversation from
 * the room's next reply on. New rooms start with nothing enabled; connectors
 * are added and managed globally under Connectors in the sidebar.
 */
export function RoomConnectorsSection({ status }: { status: PersistentAgentStatus }) {
	const [granted, setGranted] = useState<PersistentRoomGrantedConnectorStatus[] | null>(null);
	const [configured, setConfigured] = useState<string[] | null>(null);
	const [globalServers, setGlobalServers] = useState<Map<string, McpConnectorStatus>>(new Map());
	const [busyName, setBusyName] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [pickerOpen, setPickerOpen] = useState(false);
	const [query, setQuery] = useState("");

	useEffect(() => {
		let cancelled = false;
		setGranted(null);
		setConfigured(null);
		setError(null);
		Promise.all([fetchPersistentRoomMcpConnectors(status.id), fetchMcpConnectorsStatus().catch(() => null)])
			.then(([room, global]) => {
				if (cancelled) return;
				setGranted(room.granted);
				setConfigured(room.configuredConnectors);
				if (global) setGlobalServers(new Map(global.servers.map((server) => [server.name, server] as const)));
			})
			.catch((e) => {
				if (!cancelled) setError((e as Error).message);
			});
		return () => {
			cancelled = true;
		};
	}, [status.id]);

	async function toggle(name: string, action: "grant" | "revoke") {
		setBusyName(name);
		setError(null);
		try {
			const response = await updatePersistentRoomMcpConnector(status.id, action, name);
			setGranted(response.granted);
			setConfigured(response.configuredConnectors);
		} catch (e) {
			setError((e as Error).message);
		} finally {
			setBusyName(null);
		}
	}

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
			return `${name} ${server?.target ?? ""}`.toLowerCase().includes(q);
		});
	}, [enableable, query, globalServers]);

	const loaded = granted !== null && configured !== null;
	const enabledCount = (granted ?? []).filter((entry) => entry.configured).length;

	return (
		<div className="room-skills-section room-connectors-section">
			<header className="rs-pane-head">
				<h3>Connectors</h3>
				{loaded && enableable.length > 0 && !pickerOpen && (
					<div className="rs-pane-actions">
						<button className="rs-btn" onClick={() => { setPickerOpen(true); setQuery(""); }}>Enable connectors…</button>
					</div>
				)}
			</header>
			<p className="rs-pane-sub">
				{enabledCount > 0 ? `${enabledCount} enabled. Controls which connectors this room can use.` : "Controls which connectors this room can use."}
				<RsInfo text="This room can only see and call the connectors enabled here. Enabling or disabling takes effect right away, from the room's next reply on, and scheduled runs of this room use the same list. Deleting a connector on the Connectors page disables it in every room. Connectors are added and managed globally under Connectors in the sidebar." />
			</p>
			{error && granted === null && <div className="checkpoint-proposal-error">{error}</div>}
			{!loaded && error === null && <p className="ai-setup-copy">Loading connectors…</p>}
			{loaded && configured.length === 0 && granted.length === 0 && (
				<p className="ai-setup-copy">No connectors configured yet. Add them under Connectors in the sidebar, then enable them here for this room.</p>
			)}
			{loaded && (configured.length > 0 || granted.length > 0) && (
				<>
					{error && <div className="checkpoint-proposal-error">{error}</div>}
					{granted.length === 0 && configured.length > 0 && (
						<p className="ai-setup-copy room-skills-empty">No connectors enabled for this room yet.</p>
					)}
					<div className="room-skills-rows">
						{granted.map((entry) => {
							const server = globalServers.get(entry.name);
							return (
								<div key={entry.name} className="room-skills-row">
									<RoomConnectorAvatar name={entry.name} />
									<div className="room-skills-row-main">
										<span className="room-skills-name-row">
											<span className="room-skills-name">{entry.name}</span>
											{entry.configured && <span className="room-skills-live">enabled</span>}
										</span>
										{server && (
											<span className="room-skills-desc" title={server.target}>
												{server.transport === "http" ? server.target : `local: ${server.target}`}
												{server.tools ? ` · ${server.tools.count} tool${server.tools.count === 1 ? "" : "s"}` : ""}
											</span>
										)}
										{!entry.configured && (
											<span className="room-skills-warn">This connector was removed on the Connectors page. It grants nothing here. Remove it to clear this entry.</span>
										)}
									</div>
									<div className="room-skills-row-actions">
										<button className="rs-quiet" disabled={busyName === entry.name} title="Disconnect from this room — the connector stays configured" onClick={() => void toggle(entry.name, "revoke")}>
											{busyName === entry.name ? "Removing…" : "Remove"}
										</button>
									</div>
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
								<button className="icon-btn" aria-label="Close connector picker" onClick={() => setPickerOpen(false)}>✕</button>
							</div>
							<div className="room-skills-picker-list">
								{available.length === 0 && <p className="ai-setup-copy">{query.trim() ? "No connectors match." : "Every configured connector is already enabled."}</p>}
								{available.map((name) => {
									const server = globalServers.get(name);
									return (
										<div key={name} className="room-skills-row">
											<RoomConnectorAvatar name={name} />
											<div className="room-skills-row-main">
												<span className="room-skills-name">{name}</span>
												{server && (
													<span className="room-skills-desc" title={server.target}>
														{server.transport === "http" ? server.target : `local: ${server.target}`}
														{server.tools ? ` · ${server.tools.count} tool${server.tools.count === 1 ? "" : "s"}` : ""}
													</span>
												)}
											</div>
											<div className="room-skills-row-actions">
												<button className="rs-btn" disabled={busyName === name} title="Let this room use this connector" onClick={() => void toggle(name, "grant")}>
													{busyName === name ? "Enabling…" : "Enable"}
												</button>
											</div>
										</div>
									);
								})}
							</div>
						</div>
					)}
				</>
			)}
		</div>
	);
}

/** Same avatar the global Connectors page uses: brand glyph or monogram. */
function RoomConnectorAvatar({ name }: { name: string }) {
	const icon = CONNECTOR_ICONS[name];
	return (
		<span className="connector-avatar" style={{ width: 28, height: 28 }}>
			{icon ? (
				<svg viewBox="0 0 24 24" width={15} height={15} aria-hidden="true"><path d={icon} fill="currentColor" /></svg>
			) : (
				name.slice(0, 1).toUpperCase()
			)}
		</span>
	);
}
