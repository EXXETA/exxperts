import fs from "node:fs";
import { ensureProductAppStateRoot, productAppStatePath } from "../../../pi-package/product-state-paths.js";

// The remote auth audit log: an append-only JSONL file of security-relevant
// remote-mode events, so "what happened on the tunnel and when" is
// answerable after the fact without digging through server logs. REDACTED BY
// CONSTRUCTION: entries carry event names, listener, route/method, device
// ids, and outcomes; never key material, never enrollment codes, never
// user-typed strings. The smoke proves the redaction by scanning the file
// for anything secret-shaped.

const AUDIT_FILE = () => productAppStatePath("remote-auth-audit.jsonl");
const ROTATED_FILE = () => `${AUDIT_FILE()}.1`;
/** One rotation, size-capped: enough history to investigate, never unbounded. */
const MAX_BYTES = 5 * 1024 * 1024;

export type RemoteAuditEvent =
	| "remote_enabled"
	| "remote_disabled"
	| "keepawake_enabled"
	| "keepawake_disabled"
	| "device_auth_failed"
	| "rate_limited"
	| "enroll_code_minted"
	| "enroll_exchange_invalid"
	| "enroll_requested"
	| "enroll_approved"
	| "enroll_denied"
	| "device_revoked"
	| "device_capability_changed";

export interface RemoteAuditDetails {
	method?: string;
	path?: string;
	deviceId?: string;
	capability?: string;
}

interface RemoteAuditLogger {
	warn: (msg: string) => void;
}

export function createRemoteAuditLog(log: RemoteAuditLogger): (event: RemoteAuditEvent, details?: RemoteAuditDetails) => void {
	return (event, details = {}) => {
		// Auditing must never take a request down: best effort, warn once per
		// failure, move on.
		try {
			ensureProductAppStateRoot();
			const file = AUDIT_FILE();
			try {
				if (fs.statSync(file).size > MAX_BYTES) fs.renameSync(file, ROTATED_FILE());
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			}
			const entry = {
				ts: new Date().toISOString(),
				event,
				...(details.method ? { method: details.method } : {}),
				...(details.path ? { path: details.path } : {}),
				...(details.deviceId ? { deviceId: details.deviceId } : {}),
				...(details.capability ? { capability: details.capability } : {}),
			};
			fs.appendFileSync(file, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
		} catch (error) {
			log.warn(`remote audit log write failed: ${(error as Error).message}`);
		}
	};
}
