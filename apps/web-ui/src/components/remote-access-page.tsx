import { useCallback, useEffect, useRef, useState } from "react";
import {
	approvePairing,
	broadcastStatus,
	denyPairing,
	disableRemote,
	enableRemote,
	fetchPendingPairings,
	fetchRemoteDevices,
	fetchRemoteRooms,
	fetchRemoteStatus,
	mintRemotePairingCode,
	revokeRemoteDevice,
	setRemoteDeviceCapability,
	setRemoteKeepAwake,
	setRemoteRoomExposure,
	type RemoteAccessStatus,
	type RemoteDeviceRow,
	type RemotePairingCode,
	type RemotePendingPairing,
	type RemoteRoomRow,
} from "../remote-access-api";
import { fetchRemoteClientContext, useRemoteClientContext } from "../remote-client-context";

/**
 * Remote access, managed where the other app-level choices live instead of a
 * terminal. The page is the Settings mirror of the CLI: turn the tunnel
 * listener on or off, pair a phone by QR with the same single-use code and
 * explicit approval, and see or revoke the devices that hold a key.
 *
 * Same honesty rule as the web search pane: nothing on this screen moves
 * until the server says it moved. The toggle, the capability controls, and
 * revocation all render the server's answer, never an optimistic guess, and
 * this page never invents a status it could not read.
 */

/** One SVG path drawing every dark module; the quiet zone is the viewBox margin. */
function qrPath(matrix: boolean[][]): string {
	const parts: string[] = [];
	for (let row = 0; row < matrix.length; row++) {
		for (let col = 0; col < matrix[row].length; col++) {
			if (matrix[row][col]) parts.push(`M${col} ${row}h1v1h-1z`);
		}
	}
	return parts.join("");
}

const QUIET_ZONE = 4;

// Always dark modules on a white card, whatever the app theme: a QR code is
// for the phone's camera, not for the palette.
function PairingQr({ matrix }: { matrix: boolean[][] }) {
	const count = matrix.length;
	const size = count + QUIET_ZONE * 2;
	return (
		<svg
			className="remote-pairing-qr"
			viewBox={`0 0 ${size} ${size}`}
			role="img"
			aria-label="Pairing QR code"
			shapeRendering="crispEdges"
		>
			<rect width={size} height={size} fill="#fff" />
			<path transform={`translate(${QUIET_ZONE} ${QUIET_ZONE})`} d={qrPath(matrix)} fill="#000" />
		</svg>
	);
}

function lastSeenLabel(iso: string): string {
	if (!iso) return "never";
	const then = Date.parse(iso);
	if (!Number.isFinite(then)) return "never";
	const minutes = Math.floor((Date.now() - then) / 60_000);
	if (minutes < 1) return "just now";
	if (minutes < 60) return `${minutes} min ago`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours} h ago`;
	return new Date(then).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
}

/** Short pairing date ("Aug 16") so same-named devices stay tellable apart. */
function pairedLabel(iso: string): string | null {
	const then = Date.parse(iso);
	if (!Number.isFinite(then)) return null;
	return new Date(then).toLocaleDateString(undefined, { day: "numeric", month: "short" });
}

/** "paired Aug 16 · last seen 10 h ago": pairing date plus the humanized
 * last-seen, joined with a middot so duplicate labels stay distinguishable. */
function deviceHint(device: RemoteDeviceRow): string {
	const paired = pairedLabel(device.createdAt);
	const seen = lastSeenLabel(device.lastSeenAt);
	const parts = [paired ? `paired ${paired}` : null, seen === "never" ? "not seen yet" : `last seen ${seen}`];
	return parts.filter(Boolean).join(" · ");
}

function CapabilityControl({ value, disabled, onChange }: { value: "full" | "read-only"; disabled: boolean; onChange: (next: "full" | "read-only") => void }) {
	return (
		<div className="remote-capability-seg" role="group" aria-label="Device access">
			<button type="button" className={value === "full" ? "on" : ""} aria-pressed={value === "full"} disabled={disabled} onClick={() => value !== "full" && onChange("full")}>Full access</button>
			<button type="button" className={value === "read-only" ? "on" : ""} aria-pressed={value === "read-only"} disabled={disabled} onClick={() => value !== "read-only" && onChange("read-only")}>Viewing only</button>
		</div>
	);
}

// Copy the serving address to the clipboard. Same pattern as the message copy
// button: the icon flips to a checkmark for a moment so the click is
// acknowledged, and a missing or denied clipboard degrades quietly.
function CopyUrlButton({ text }: { text: string }) {
	const [copied, setCopied] = useState(false);
	const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
	const onCopy = useCallback(() => {
		void navigator.clipboard?.writeText(text).then(() => {
			setCopied(true);
			if (timer.current) clearTimeout(timer.current);
			timer.current = setTimeout(() => setCopied(false), 2000);
		}).catch(() => {});
	}, [text]);
	useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
	return (
		<button
			type="button"
			className={`message-copy${copied ? " is-copied" : ""}`}
			onClick={onCopy}
			title={copied ? "Copied" : "Copy address"}
			aria-label={copied ? "Copied to clipboard" : "Copy address"}
		>
			{copied ? (
				<svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
					<path d="M3.5 8.5l3 3 6-6.5" />
				</svg>
			) : (
				<svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
					<rect x="5.5" y="5.5" width="8" height="8" rx="1.5" />
					<path d="M10.5 5.5V4a1.5 1.5 0 0 0-1.5-1.5H4A1.5 1.5 0 0 0 2.5 4v5A1.5 1.5 0 0 0 4 10.5h1.5" />
				</svg>
			)}
		</button>
	);
}

export function RemoteAccessPage() {
	const remoteClient = useRemoteClientContext();
	const [status, setStatus] = useState<RemoteAccessStatus | null>(null);
	const [loadError, setLoadError] = useState<string | null>(null);
	const [loading, setLoading] = useState(true);
	const [devices, setDevices] = useState<RemoteDeviceRow[] | null>(null);
	const [rooms, setRooms] = useState<RemoteRoomRow[] | null>(null);
	const [roomBusy, setRoomBusy] = useState<string | null>(null);
	const [switching, setSwitching] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [note, setNote] = useState<string | null>(null);
	/** The live pairing code the QR renders; null until the auto-mint lands. */
	const [code, setCode] = useState<RemotePairingCode | null>(null);
	/** requestId of the pairing approval mid-flight, if any. */
	const [approving, setApproving] = useState<string | null>(null);
	/** The last auto-mint failed; one quiet line, retried on the next tick. */
	const [mintFailed, setMintFailed] = useState(false);
	/** Loop guard: never more than one mint request in flight. */
	const mintInFlight = useRef(false);
	const [pending, setPending] = useState<RemotePendingPairing[]>([]);
	/** Which pending request's approval choice, keyed by requestId. */
	const [approveCapability, setApproveCapability] = useState<Record<string, "full" | "read-only">>({});
	/** Device row mid-save (capability change or revoke). */
	const [deviceBusy, setDeviceBusy] = useState<string | null>(null);
	/** Revoke armed on this device id, so removal takes a second click. */
	const [revokeArmed, setRevokeArmed] = useState<string | null>(null);
	/** The keep-awake row mid-save. */
	const [keepAwakeBusy, setKeepAwakeBusy] = useState(false);

	function adoptStatus(next: RemoteAccessStatus) {
		setStatus(next);
		broadcastStatus(next);
	}

	async function load() {
		setLoading(true);
		setLoadError(null);
		try {
			const [nextStatus, nextDevices, nextRooms] = await Promise.all([fetchRemoteStatus(), fetchRemoteDevices(), fetchRemoteRooms()]);
			adoptStatus(nextStatus);
			setDevices(nextDevices);
			setRooms(nextRooms);
		} catch (e) {
			setLoadError((e as Error).message);
		} finally {
			setLoading(false);
		}
	}

	// The probe settles before the first read fires: the hook fails open to
	// local while it resolves, and on a remote device these reads would only
	// land refusals.
	useEffect(() => {
		void fetchRemoteClientContext().then((ctx) => { if (!ctx.remote) void load(); });
	}, []);

	// While remote is off (no tunnel yet, or enabled-but-degraded waiting for
	// the address to return), a quiet status poll keeps the screen honest
	// without a reload: the onboarding card swaps to "ready" by itself the
	// moment Tailscale is running, and a degraded state clears when the
	// server's own watcher rebinds.
	const watchingForTunnel = !loading && !loadError && status !== null && !status.enabled;
	useEffect(() => {
		if (!watchingForTunnel) return;
		const timer = window.setInterval(() => {
			void fetchRemoteStatus().then((next) => {
				setStatus(next);
				broadcastStatus(next);
			}).catch(() => {});
		}, 4000);
		return () => window.clearInterval(timer);
	}, [watchingForTunnel]);

	async function turnOn() {
		setSwitching(true);
		setError(null);
		setNote(null);
		try {
			adoptStatus(await enableRemote());
			setNote("Remote access is on. Scan the code below to pair a device.");
		} catch (e) {
			setError((e as Error).message);
		} finally {
			setSwitching(false);
		}
	}

	async function turnOff() {
		setSwitching(true);
		setError(null);
		setNote(null);
		try {
			adoptStatus(await disableRemote());
			setCode(null);
			setPending([]);
			setNote("Remote access is off. Paired devices are blocked until you turn it back on.");
		} catch (e) {
			setError((e as Error).message);
		} finally {
			setSwitching(false);
		}
	}

	// Auto-mint: while remote is on, the pairing QR is simply there. This is
	// the same loopback-only admin mint the Show-code button used to run, and
	// every pairing still requires the explicit approval click below.
	const mint = useCallback(async () => {
		if (mintInFlight.current) return;
		mintInFlight.current = true;
		try {
			setCode(await mintRemotePairingCode());
			setMintFailed(false);
		} catch {
			setMintFailed(true);
		} finally {
			mintInFlight.current = false;
		}
	}, []);

	// One poll owns the pairing area while remote is on (same cadence the
	// CLI uses): it mints when no live code exists (first open, the switch
	// turned back on, a code used up by approve or decline), silently
	// replaces an expired code so the QR never shows a dead one, and
	// otherwise watches for the phone's pairing request. A failed mint
	// shows one quiet line and is retried on the next tick at most; the
	// in-flight ref keeps it to a single mint at a time.
	const remoteOn = status?.enabled === true;
	useEffect(() => {
		if (!remoteOn) return;
		let stopped = false;
		const tick = async () => {
			if (!code || Date.parse(code.expiresAt) <= Date.now()) {
				await mint();
				return;
			}
			try {
				const rows = await fetchPendingPairings();
				if (!stopped) setPending(rows);
			} catch {
				// A failed poll tick is retried on the next one.
			}
		};
		void tick();
		const timer = window.setInterval(() => void tick(), 1500);
		return () => {
			stopped = true;
			window.clearInterval(timer);
		};
	}, [remoteOn, code, mint]);

	async function approve(request: RemotePendingPairing) {
		setApproving(request.requestId);
		setError(null);
		try {
			setDevices(await approvePairing(request.requestId, approveCapability[request.requestId] ?? "full"));
			setPending([]);
			// The code is single-use; dropping it lets the poll mint a fresh one.
			setCode(null);
			setNote(`Approved. "${request.deviceName}" signs itself in within a few seconds.`);
		} catch (e) {
			setError((e as Error).message);
		} finally {
			setApproving(null);
		}
	}

	async function decline(request: RemotePendingPairing) {
		setError(null);
		try {
			await denyPairing(request.requestId);
			setPending([]);
			setCode(null);
			setNote("Declined. That code is used up; a fresh one is on screen.");
		} catch (e) {
			setError((e as Error).message);
		}
	}

	async function changeCapability(device: RemoteDeviceRow, next: "full" | "read-only") {
		setDeviceBusy(device.id);
		setError(null);
		setNote(null);
		try {
			setDevices(await setRemoteDeviceCapability(device.id, next));
			setNote(
				next === "full"
					? `"${device.name}" has full access again from its next sign-in.`
					: `"${device.name}" is limited to viewing. Its open sessions are closed; it signs back in with the new access.`,
			);
		} catch (e) {
			setError((e as Error).message);
		} finally {
			setDeviceBusy(null);
		}
	}

	async function changeExposure(room: RemoteRoomRow, exposed: boolean) {
		setRoomBusy(room.id);
		setError(null);
		setNote(null);
		try {
			await setRemoteRoomExposure(room.id, exposed);
			setRooms((rows) => (rows ?? []).map((row) => (row.id === room.id ? { ...row, exposed } : row)));
			setNote(
				exposed
					? `"${room.displayName}" is reachable remotely again.`
					: `"${room.displayName}" is hidden from remote devices. Not a security control; to keep it truly unreachable, revoke the device.`,
			);
		} catch (e) {
			setError((e as Error).message);
		} finally {
			setRoomBusy(null);
		}
	}

	async function changeKeepAwake(next: boolean) {
		setKeepAwakeBusy(true);
		setError(null);
		try {
			adoptStatus(await setRemoteKeepAwake(next));
		} catch (e) {
			setError((e as Error).message);
		} finally {
			setKeepAwakeBusy(false);
		}
	}

	async function revoke(device: RemoteDeviceRow) {
		setDeviceBusy(device.id);
		setError(null);
		setNote(null);
		try {
			setDevices(await revokeRemoteDevice(device.id));
			setNote(`"${device.name}" is revoked. Its sessions are closed and its key no longer works.`);
		} catch (e) {
			setError((e as Error).message);
		} finally {
			setDeviceBusy(null);
			setRevokeArmed(null);
		}
	}

	// Viewed from a remote device, this tab is read-only by design: the route
	// policy on the server refuses every remote admin call, including the
	// status reads, so there is nothing live to show and nothing to operate.
	// One honest line instead, and none of the local-only fetches ever fire.
	if (remoteClient.remote) {
		return (
			<section className="ai-setup-section" aria-label="Remote access">
				<h3 className="web-search-fallback-heading">Remote access</h3>
				<p className="cli-note">Remote access is managed on the computer itself.</p>
			</section>
		);
	}

	// Rendering below never invents a state: unknown says unknown.
	// The page hero (in the shell) already says what this is; the section
	// starts straight at the state.
	if (loading) {
		return (
			<section className="ai-setup-section" aria-label="Remote access">
				<p className="ai-setup-copy" role="status">Reading the current state…</p>
			</section>
		);
	}

	if (loadError || !status) {
		return (
			<section className="ai-setup-section" aria-label="Remote access">
				<div className="workspaces-error archived-rooms-note" role="alert">{loadError ?? "Could not read the remote access state."}</div>
				<p><button className="inline-action" type="button" onClick={() => void load()}>Try again</button></p>
			</section>
		);
	}

	const on = status.enabled;
	const degraded = !on && status.stateFile === "valid";
	const tunnelReady = Boolean(status.tunnelAddress);
	const host = status.scheme === "https" && status.dnsName ? status.dnsName : status.address && status.address.includes(":") ? `[${status.address}]` : status.address;
	const servingUrl = `${status.scheme ?? "http"}://${host}:${status.port}`;

	return (
		<section className="ai-setup-section" aria-label="Remote access">
			<div className="remote-master">
				<h3 className="web-search-fallback-heading">General</h3>
				<label className="rs-row">
					<div className="rs-row-main">
						<span className="rs-row-label">Remote access{switching ? " (switching…)" : ""}</span>
						<span className="rs-row-hint">Your phone talks to this computer directly over your private Tailscale tunnel; nothing goes through a cloud. Turning it off blocks every device until you turn it back on.</span>
						{degraded && (
							<span className="rs-row-hint remote-hint-degraded" role="status">
								On, but not serving right now: {status.degradedReason || "waiting for the tunnel address"}. Local
								use is unaffected; it resumes by itself when the tunnel is back.
							</span>
						)}
						{!on && !degraded && tunnelReady && <span className="rs-row-hint">Your tunnel is running.</span>}
					</div>
					<input
						className="workspaces-tool-switch"
						type="checkbox"
						checked={on || degraded}
						disabled={switching || (!on && !degraded && !tunnelReady)}
						onChange={() => void (on || degraded ? turnOff() : turnOn())}
						aria-label="Remote access"
					/>
				</label>
				{/* Status lines live with the switch they most often describe
				    (the off-state note especially), not below the rooms list. */}
				{note && <p className="archived-rooms-note" role="status">{note}</p>}
				{error && <div className="workspaces-error archived-rooms-note" role="alert">{error}</div>}
				{!on && !degraded && !tunnelReady && (
					<div className="remote-onboarding">
						<p className="remote-master-state">Off. Remote access needs a private tunnel first.</p>
						<p className="ai-setup-copy remote-onboarding-copy">
							The tunnel is Tailscale, a free app. Nothing is opened to the internet; only devices signed in to
							your account can reach this computer.
						</p>
						<ol className="remote-onboarding-steps">
							<li>Install Tailscale on this computer and sign in. The free plan is enough.</li>
							<li>Install the Tailscale app on your phone and sign in to the same account.</li>
						</ol>
						<div className="remote-onboarding-actions">
							<a className="rs-btn remote-onboarding-link" href="https://tailscale.com/download" target="_blank" rel="noopener noreferrer">Get Tailscale</a>
							<span className="remote-onboarding-waiting" role="status">Waiting for your tunnel. This screen notices it by itself.</span>
						</div>
						<p className="remote-master-footnote">Another compatible tunnel is detected the same way.</p>
					</div>
				)}
				{on && (
					<label className="rs-row">
						<div className="rs-row-main">
							<span className="rs-row-label">Keep this computer awake{keepAwakeBusy ? " (saving…)" : ""}</span>
							<span className="rs-row-hint">Works best plugged in with the lid open.</span>
						</div>
						<input
							className="workspaces-tool-switch"
							type="checkbox"
							checked={status.keepAwake}
							disabled={keepAwakeBusy}
							onChange={(e) => void changeKeepAwake(e.target.checked)}
							aria-label="Keep this computer awake while remote access is on"
						/>
					</label>
				)}
			</div>

			<div className="remote-devices">
				<h3 className="web-search-fallback-heading">Devices</h3>
				{on && (
					<div className="remote-pairing-panel">
						{code?.matrix ? (
							<PairingQr matrix={code.matrix} />
						) : (
							<div className="remote-pairing-qr-pending" aria-hidden="true" />
						)}
						<div className="remote-pairing-side">
							<p className="ai-setup-copy remote-pairing-copy">
								Scan with the phone's camera to pair. The phone needs Tailscale signed in, VPN on.
							</p>
							<details className="remote-fold">
								<summary>Open exxperts like an app on the phone</summary>
								<p className="remote-master-footnote">
									Add the page to your
									home screen: on iPhone use Share, then Add to Home Screen; on Android use the browser menu, then
									Add to Home screen.
								</p>
								<p className="remote-master-footnote">
									Not paired? Scan the code again, or message yourself the address:
								</p>
								<p className="remote-address">
									<code>{servingUrl}</code>
									<CopyUrlButton text={servingUrl} />
								</p>
								{status.scheme === "http" && (
									<details className="remote-fold">
										<summary>Why the address shows no padlock</summary>
										<p className="remote-master-footnote">
											The app speaks plain http inside your tunnel, and the tunnel itself encrypts everything end
											to end{status.tlsFallbackReason ? ` (${status.tlsFallbackReason})` : ""}. For the padlock,
											enable HTTPS certificates in the{" "}
											<a href="https://login.tailscale.com/admin/dns" target="_blank" rel="noreferrer">Tailscale admin console</a>;
											MagicDNS is usually already on, so that is typically the only step. Then turn remote access
											off and on again. Devices pair again once after the switch.
										</p>
									</details>
								)}
							</details>
							{mintFailed && (
								<p className="rs-row-hint remote-hint-degraded" role="status">
									Could not create a pairing code. It retries by itself.
								</p>
							)}
							{pending.map((request) => (
								<div key={request.requestId} className="remote-pending-row" role="status">
									<span className="remote-pending-name">"{request.deviceName}" asks to pair</span>
									<CapabilityControl
										value={approveCapability[request.requestId] ?? "full"}
										disabled={approving !== null}
										onChange={(next) => setApproveCapability((prev) => ({ ...prev, [request.requestId]: next }))}
									/>
									<div className="remote-pending-actions">
										<button className="rs-btn" type="button" disabled={approving !== null} onClick={() => void approve(request)}>
											{approving === request.requestId ? "Approving…" : "Approve"}
										</button>
										<button className="rs-quiet" type="button" disabled={approving !== null} onClick={() => void decline(request)}>Decline</button>
									</div>
								</div>
							))}
						</div>
					</div>
				)}
				{on && <div className="remote-section-divider" />}
				{(devices ?? []).length === 0 && <p className="ai-setup-copy">No devices are paired yet.</p>}
				{(devices ?? []).map((device) => (
					<div key={device.id} className="rs-row remote-device-row">
						<div className="rs-row-main">
							<span className="rs-row-label">{device.name}</span>
							<span className="rs-row-hint">{deviceHint(device)}</span>
							{revokeArmed === device.id && (
								<span className="rs-row-hint remote-device-armed" role="alert">
									Sign this device out everywhere and remove it? Pairing it again needs a fresh code.
								</span>
							)}
						</div>
						<div className="remote-device-actions">
							<CapabilityControl value={device.capability} disabled={deviceBusy === device.id} onChange={(next) => void changeCapability(device, next)} />
							{revokeArmed === device.id ? (
								<>
									<button className="rs-quiet" type="button" disabled={deviceBusy === device.id} onClick={() => setRevokeArmed(null)}>Keep it</button>
									<button className="rs-btn rs-btn-danger" type="button" disabled={deviceBusy === device.id} onClick={() => void revoke(device)}>
										{deviceBusy === device.id ? "Revoking…" : "Revoke"}
									</button>
								</>
							) : (
								<button className="rs-quiet rs-quiet-danger" type="button" disabled={deviceBusy === device.id} onClick={() => setRevokeArmed(device.id)}>Revoke</button>
							)}
						</div>
					</div>
				))}
			</div>

			{(rooms ?? []).length > 0 && (
				<div className="remote-devices remote-rooms">
					<h3 className="web-search-fallback-heading">Rooms</h3>
					{(rooms ?? []).map((room) => (
						<div key={room.id} className="rs-row remote-room-row">
							<div className="rs-row-main">
								<span className="rs-row-label">{room.displayName}</span>
								{room.bashEnabled && <span className="rs-row-hint">can run commands on this computer</span>}
							</div>
							<div className="remote-device-actions">
								<div className="remote-capability-seg" role="group" aria-label="Remote reachability">
									<button type="button" className={room.exposed ? "on" : ""} aria-pressed={room.exposed} disabled={roomBusy === room.id} onClick={() => !room.exposed && void changeExposure(room, true)}>Reachable</button>
									<button type="button" className={room.exposed ? "" : "on"} aria-pressed={!room.exposed} disabled={roomBusy === room.id} onClick={() => room.exposed && void changeExposure(room, false)}>Hidden</button>
								</div>
							</div>
						</div>
					))}
				</div>
			)}

		</section>
	);
}
