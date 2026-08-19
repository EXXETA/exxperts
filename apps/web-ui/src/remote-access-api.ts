import { useEffect, useState } from "react";
import { fetchJson } from "./api";
import { fetchRemoteClientContext } from "./remote-client-context";

// The Settings face of remote mode. Everything here talks to the loopback
// admin API; on a remote device those routes answer 403 by design (a phone
// must never manage its own access path), so the hooks below simply stay
// silent there instead of surfacing errors for a surface that does not
// apply.

export interface RemoteAccessStatus {
	enabled: boolean;
	address: string | null;
	port: number;
	tunnelAddress: string | null;
	scheme: "http" | "https" | null;
	dnsName: string | null;
	tlsFallbackReason: string | null;
	degradedReason: string | null;
	stateFile: "absent" | "valid" | "malformed";
	keepAwake: boolean;
}

export interface RemoteDeviceRow {
	id: string;
	name: string;
	capability: "full" | "read-only";
	createdAt: string;
	lastSeenAt: string;
	expiresAt: string;
}

export interface RemotePairingCode {
	url: string;
	/** Absent when the server's QR encoder is unavailable; the url is the mechanism. */
	matrix?: boolean[][];
	expiresAt: string;
}

export interface RemotePendingPairing {
	requestId: string;
	deviceName: string;
	requestedAt: string;
}

export function fetchRemoteStatus(): Promise<RemoteAccessStatus> {
	return fetchJson<RemoteAccessStatus>("/api/remote/status");
}

export async function enableRemote(): Promise<RemoteAccessStatus> {
	const res = await fetchJson<{ status: RemoteAccessStatus }>("/api/remote/enable", { method: "POST" });
	broadcastStatus(res.status);
	return res.status;
}

export async function disableRemote(): Promise<RemoteAccessStatus> {
	const res = await fetchJson<{ status: RemoteAccessStatus }>("/api/remote/disable", { method: "POST" });
	broadcastStatus(res.status);
	return res.status;
}

export async function setRemoteKeepAwake(keepAwake: boolean): Promise<RemoteAccessStatus> {
	const res = await fetchJson<{ status: RemoteAccessStatus }>("/api/remote/keep-awake", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ keepAwake }),
	});
	broadcastStatus(res.status);
	return res.status;
}

export async function fetchRemoteDevices(): Promise<RemoteDeviceRow[]> {
	return (await fetchJson<{ devices: RemoteDeviceRow[] }>("/api/remote/devices")).devices;
}

export async function revokeRemoteDevice(id: string): Promise<RemoteDeviceRow[]> {
	return (await fetchJson<{ devices: RemoteDeviceRow[] }>("/api/remote/devices/revoke", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ id }),
	})).devices;
}

export async function setRemoteDeviceCapability(id: string, capability: "full" | "read-only"): Promise<RemoteDeviceRow[]> {
	return (await fetchJson<{ devices: RemoteDeviceRow[] }>("/api/remote/devices/capability", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ id, capability }),
	})).devices;
}

export interface RemoteRoomRow {
	id: string;
	displayName: string;
	exposed: boolean;
	bashEnabled: boolean;
}

export async function fetchRemoteRooms(): Promise<RemoteRoomRow[]> {
	return (await fetchJson<{ rooms: RemoteRoomRow[] }>("/api/remote/rooms")).rooms;
}

export async function setRemoteRoomExposure(id: string, exposed: boolean): Promise<void> {
	await fetchJson<{ ok: boolean }>("/api/remote/rooms/exposure", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ id, exposed }),
	});
}

export function mintRemotePairingCode(): Promise<RemotePairingCode> {
	return fetchJson<RemotePairingCode>("/api/remote/enroll-code", { method: "POST" });
}

export async function fetchPendingPairings(): Promise<RemotePendingPairing[]> {
	return (await fetchJson<{ pending: RemotePendingPairing[] }>("/api/remote/enroll-pending")).pending;
}

export async function approvePairing(requestId: string, capability: "full" | "read-only"): Promise<RemoteDeviceRow[]> {
	return (await fetchJson<{ devices: RemoteDeviceRow[] }>("/api/remote/enroll-approve", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ requestId, capability }),
	})).devices;
}

export function denyPairing(requestId: string): Promise<{ ok: boolean }> {
	return fetchJson<{ ok: boolean }>("/api/remote/enroll-deny", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ requestId }),
	});
}

// One shared status cell for every mounted indicator plus the Settings page,
// so the "remote is on" pill agrees with the page that changed it: admin
// actions broadcast the fresh status through here, and a slow background
// poll catches changes made from the CLI while the app is open.
let sharedStatus: RemoteAccessStatus | null = null;
const listeners = new Set<(status: RemoteAccessStatus | null) => void>();

export function broadcastStatus(status: RemoteAccessStatus | null): void {
	sharedStatus = status;
	for (const listener of listeners) listener(status);
}

async function refreshSharedStatus(): Promise<void> {
	try {
		broadcastStatus(await fetchRemoteStatus());
	} catch {
		// Unknown beats invented: an unreachable or refusing server clears the
		// indicator rather than freezing a stale claim on screen.
		broadcastStatus(null);
	}
}

const POLL_MS = 60_000;
let pollTimer: number | null = null;

function ensurePolling(): void {
	if (pollTimer !== null) return;
	pollTimer = window.setInterval(() => void refreshSharedStatus(), POLL_MS);
}

function stopPollingWhenUnwatched(): void {
	if (listeners.size === 0 && pollTimer !== null) {
		window.clearInterval(pollTimer);
		pollTimer = null;
	}
}

/**
 * The current remote status, null while unknown (still loading, admin
 * surface refused, or the probe failed). On a remote device this stays null
 * forever, on purpose: the admin surface does not exist there.
 */
export function useRemoteAccessStatus(): RemoteAccessStatus | null {
	const [status, setStatus] = useState<RemoteAccessStatus | null>(sharedStatus);
	useEffect(() => {
		let alive = true;
		const listener = (next: RemoteAccessStatus | null) => {
			if (alive) setStatus(next);
		};
		listeners.add(listener);
		void fetchRemoteClientContext().then((context) => {
			if (!alive || context.remote) return;
			ensurePolling();
			void refreshSharedStatus();
		});
		return () => {
			alive = false;
			listeners.delete(listener);
			stopPollingWhenUnwatched();
		};
	}, []);
	return status;
}
