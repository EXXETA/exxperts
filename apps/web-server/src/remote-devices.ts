import crypto from "node:crypto";
import fs from "node:fs";
import { ensureProductAppStateRoot, productAppStatePath } from "../../../pi-package/product-state-paths.js";

// Per-device credentials for remote mode. The master client auth token is
// never a credential on the tunnel listener; instead every enrolled phone
// holds its own server-minted 256-bit key, stored HASHED here, individually
// revocable, with a server-side expiry that is authoritative over any cookie
// lifetime hint. Enrollment is the only mint path: a single-use, short-lived
// code (never the master token) that the phone exchanges, gated on an
// explicit approval on the computer.

const DEVICES_FILE = () => productAppStatePath("remote-devices.json");

/**
 * Server-side device lifetime, sliding: every successful auth pushes the
 * expiry out to a full TTL from now, so a device in regular use stays paired
 * and only an idle device expires. The cookie's Max-Age is only a hint on top.
 */
export const REMOTE_DEVICE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** Enrollment codes and their pending approvals die after this. */
export const ENROLL_CODE_TTL_MS = 10 * 60 * 1000;

export type RemoteDeviceCapability = "full" | "read-only";

export interface RemoteDeviceRecord {
	id: string;
	name: string;
	capability: RemoteDeviceCapability;
	/** sha256 hex of the device key; the key itself only ever lives in the phone's cookie. */
	keyHash: string;
	createdAt: string;
	lastSeenAt: string;
	expiresAt: string;
}

export interface RemoteDevicePublic {
	id: string;
	name: string;
	capability: RemoteDeviceCapability;
	createdAt: string;
	lastSeenAt: string;
	expiresAt: string;
}

export interface PendingEnrollment {
	requestId: string;
	deviceName: string;
	requestedAt: string;
	state: "pending" | "approved" | "denied";
	/** Set on approval; the status poll hands it to the phone exactly once. */
	mintedKey?: string;
	deviceId?: string;
}

function sha256Hex(value: string): string {
	return crypto.createHash("sha256").update(value, "utf8").digest("hex");
}

function hashesEqual(a: string, b: string): boolean {
	const bufferA = Buffer.from(a, "hex");
	const bufferB = Buffer.from(b, "hex");
	if (bufferA.length !== bufferB.length || bufferA.length === 0) return false;
	return crypto.timingSafeEqual(bufferA, bufferB);
}

function sanitizeDeviceName(name: unknown): string {
	const cleaned = String(name ?? "").replace(/[\p{C}]/gu, "").trim().slice(0, 60);
	return cleaned || "Unnamed device";
}

interface RemoteDevicesLogger {
	info: (msg: string) => void;
	warn: (obj: unknown, msg?: string) => void;
}

export interface RemoteDeviceStore {
	/** Timing-safe key check incl. server-side expiry. Null = not a device. */
	authenticate(key: string): RemoteDeviceRecord | null;
	/** Called on each successful device auth: refreshes lastSeen and slides the expiry (throttled persist). */
	touchLastSeen(id: string): void;
	list(): RemoteDevicePublic[];
	revoke(id: string): boolean;
	setCapability(id: string, capability: RemoteDeviceCapability): boolean;
	/** Mint a fresh enrollment code; replaces any outstanding one. */
	mintEnrollCode(): { code: string; expiresAt: string };
	/** Kill the outstanding code and every pending approval (remote disable does this). */
	invalidateEnrollment(): void;
	/**
	 * The phone's exchange: consumes the code (single-use, even when the
	 * approval is later denied) and parks a pending approval for the computer.
	 */
	beginExchange(code: string, deviceName: unknown): { ok: true; requestId: string } | { ok: false; reason: "invalid_code" };
	pendingApprovals(): Array<{ requestId: string; deviceName: string; requestedAt: string }>;
	/** Returns the new device's id, or null when the request is unknown/expired. */
	approve(requestId: string, capability?: RemoteDeviceCapability): string | null;
	deny(requestId: string): boolean;
	/**
	 * The phone's poll. On approved, returns the minted key EXACTLY ONCE and
	 * scrubs it from memory; later polls see plain approved.
	 */
	exchangeStatus(requestId: string): { state: "pending" | "denied" | "approved" | "unknown"; key?: string };
}

export function createRemoteDeviceStore(log: RemoteDevicesLogger): RemoteDeviceStore {
	let devices: RemoteDeviceRecord[] = loadDevices();
	// Enrollment state is in-memory only: a server restart voids outstanding
	// codes and pending approvals (re-scan to retry), which fails safe.
	let enrollCodeHash: string | null = null;
	let enrollCodeExpiresAt = 0;
	const pending = new Map<string, PendingEnrollment & { expiresAt: number }>();
	let lastSeenWriteAt = 0;

	function loadDevices(): RemoteDeviceRecord[] {
		try {
			const parsed = JSON.parse(fs.readFileSync(DEVICES_FILE(), "utf8")) as { devices?: RemoteDeviceRecord[] };
			if (!Array.isArray(parsed?.devices)) return [];
			return parsed.devices
				.filter((d) => d && typeof d.id === "string" && typeof d.keyHash === "string")
				// Capability fails closed: a hand-edited, corrupt, or
				// future-version value that is not exactly "full" loads as
				// read-only, mirroring how a corrupt file loads as no devices.
				.map((d) => ({ ...d, capability: d.capability === "full" ? "full" as const : "read-only" as const }));
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
				// A corrupt device file must not take the server down, and it
				// must fail CLOSED: no readable records means no remote access
				// until devices re-enroll.
				log.warn(`remote devices file unreadable (${(error as Error).message}); treating as empty, devices must re-enroll`);
			}
			return [];
		}
	}

	function saveDevices(): void {
		ensureProductAppStateRoot();
		fs.writeFileSync(DEVICES_FILE(), `${JSON.stringify({ devices }, null, "\t")}\n`, { mode: 0o600 });
	}

	function pruneExpired(now: number): void {
		const before = devices.length;
		devices = devices.filter((d) => Date.parse(d.expiresAt) > now);
		if (devices.length !== before) saveDevices();
		for (const [id, entry] of pending) {
			if (entry.expiresAt <= now) pending.delete(id);
		}
	}

	return {
		authenticate(key: string): RemoteDeviceRecord | null {
			if (!key) return null;
			const now = Date.now();
			pruneExpired(now);
			const candidateHash = sha256Hex(key);
			for (const device of devices) {
				if (hashesEqual(candidateHash, device.keyHash)) return device;
			}
			return null;
		},

		touchLastSeen(id: string): void {
			const device = devices.find((d) => d.id === id);
			if (!device) return;
			const now = Date.now();
			device.lastSeenAt = new Date(now).toISOString();
			// Sliding expiry: the deadline moves to a full TTL from this
			// successful auth, so only 30 days of NO use expire a device. The
			// slide always lands in memory (the authenticate() prune reads
			// from there); the disk write below is throttled, and losing at
			// most a throttle window of slide on a crash is harmless.
			device.expiresAt = new Date(now + REMOTE_DEVICE_TTL_MS).toISOString();
			// Throttled: not worth a disk write per request.
			if (now - lastSeenWriteAt > 60_000) {
				lastSeenWriteAt = now;
				try { saveDevices(); } catch (error) {
					log.warn(`remote devices: could not persist last-seen: ${(error as Error).message}`);
				}
			}
		},

		list(): RemoteDevicePublic[] {
			pruneExpired(Date.now());
			return devices.map(({ keyHash: _keyHash, ...device }) => device);
		},

		revoke(id: string): boolean {
			const before = devices.length;
			devices = devices.filter((d) => d.id !== id);
			if (devices.length === before) return false;
			saveDevices();
			log.info(`remote device ${id} revoked`);
			return true;
		},

		setCapability(id: string, capability: RemoteDeviceCapability): boolean {
			const device = devices.find((d) => d.id === id);
			if (!device) return false;
			device.capability = capability;
			saveDevices();
			return true;
		},

		mintEnrollCode(): { code: string; expiresAt: string } {
			const code = crypto.randomBytes(32).toString("hex");
			enrollCodeHash = sha256Hex(code);
			enrollCodeExpiresAt = Date.now() + ENROLL_CODE_TTL_MS;
			return { code, expiresAt: new Date(enrollCodeExpiresAt).toISOString() };
		},

		invalidateEnrollment(): void {
			enrollCodeHash = null;
			enrollCodeExpiresAt = 0;
			pending.clear();
		},

		beginExchange(code: string, deviceName: unknown): { ok: true; requestId: string } | { ok: false; reason: "invalid_code" } {
			const now = Date.now();
			pruneExpired(now);
			if (!enrollCodeHash || now > enrollCodeExpiresAt || !code) return { ok: false, reason: "invalid_code" };
			if (!hashesEqual(sha256Hex(code), enrollCodeHash)) return { ok: false, reason: "invalid_code" };
			// Single use: the code dies on its first successful exchange, even
			// if the approval is later denied. A denial means re-mint.
			enrollCodeHash = null;
			enrollCodeExpiresAt = 0;
			const requestId = crypto.randomBytes(16).toString("hex");
			pending.set(requestId, {
				requestId,
				deviceName: sanitizeDeviceName(deviceName),
				requestedAt: new Date(now).toISOString(),
				state: "pending",
				expiresAt: now + ENROLL_CODE_TTL_MS,
			});
			return { ok: true, requestId };
		},

		pendingApprovals(): Array<{ requestId: string; deviceName: string; requestedAt: string }> {
			pruneExpired(Date.now());
			return [...pending.values()].filter((p) => p.state === "pending").map(({ requestId, deviceName, requestedAt }) => ({ requestId, deviceName, requestedAt }));
		},

		approve(requestId: string, capability: RemoteDeviceCapability = "full"): string | null {
			const entry = pending.get(requestId);
			if (!entry || entry.state !== "pending") return null;
			const key = crypto.randomBytes(32).toString("hex");
			const now = Date.now();
			const device: RemoteDeviceRecord = {
				id: crypto.randomBytes(8).toString("hex"),
				name: entry.deviceName,
				capability,
				keyHash: sha256Hex(key),
				createdAt: new Date(now).toISOString(),
				lastSeenAt: new Date(now).toISOString(),
				expiresAt: new Date(now + REMOTE_DEVICE_TTL_MS).toISOString(),
			};
			devices.push(device);
			saveDevices();
			entry.state = "approved";
			entry.mintedKey = key;
			entry.deviceId = device.id;
			log.info(`remote device approved: ${device.name} (${device.id})`);
			return device.id;
		},

		deny(requestId: string): boolean {
			const entry = pending.get(requestId);
			if (!entry || entry.state !== "pending") return false;
			entry.state = "denied";
			return true;
		},

		exchangeStatus(requestId: string): { state: "pending" | "denied" | "approved" | "unknown"; key?: string } {
			pruneExpired(Date.now());
			const entry = pending.get(requestId);
			if (!entry) return { state: "unknown" };
			if (entry.state !== "approved") return { state: entry.state };
			// Hand the key over exactly once, then scrub it from memory: a
			// later poll (or anything that snapshots the pending map) never
			// sees it again.
			const key = entry.mintedKey;
			entry.mintedKey = undefined;
			if (!key) return { state: "approved" };
			return { state: "approved", key };
		},
	};
}
