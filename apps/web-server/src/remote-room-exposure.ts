import fs from "node:fs";
import { ensureProductAppStateRoot, productAppStatePath } from "../../../pi-package/product-state-paths.js";

// Per-room remote exposure. Every room is reachable remotely by default
// (full remote power is the point of remote mode); the user can hide any
// room from remote devices, so this store keeps the HIDDEN set, not the
// exposed one. Writes happen only through loopback-only admin routes: a
// phone must never be able to change what it can see.
//
// A hidden room must be indistinguishable from a nonexistent one to a remote
// device: absent from listings, refused on direct access with the same
// not-found shape as an unknown id, filtered out of memory aggregations, and
// its task artifacts unreachable. The enforcement lives in index.ts; this
// module is only the stored set.

const EXPOSURE_FILE = () => productAppStatePath("remote-room-exposure.json");

interface RemoteRoomExposureLogger {
	warn: (msg: string) => void;
}

export interface RemoteRoomExposureStore {
	hiddenRooms(): ReadonlySet<string>;
	isHidden(roomId: string): boolean;
	setExposed(roomId: string, exposed: boolean): void;
}

export function createRemoteRoomExposureStore(log: RemoteRoomExposureLogger): RemoteRoomExposureStore {
	let hidden = load();

	function load(): Set<string> {
		try {
			const parsed = JSON.parse(fs.readFileSync(EXPOSURE_FILE(), "utf8")) as { hidden?: unknown };
			if (!Array.isArray(parsed?.hidden)) return new Set();
			return new Set(parsed.hidden.map((id) => String(id)).filter(Boolean));
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
				// Fail toward exposure DEFAULTS, which is the documented default
				// state; hiding is a user preference, not a security boundary
				// against the user's own enrolled devices. Still say so loudly.
				log.warn(`remote room exposure file unreadable (${(error as Error).message}); treating all rooms as exposed`);
			}
			return new Set();
		}
	}

	function save(): void {
		ensureProductAppStateRoot();
		fs.writeFileSync(EXPOSURE_FILE(), `${JSON.stringify({ hidden: [...hidden].sort() }, null, "\t")}\n`, { mode: 0o600 });
	}

	return {
		hiddenRooms(): ReadonlySet<string> {
			return hidden;
		},
		isHidden(roomId: string): boolean {
			return hidden.has(roomId);
		},
		setExposed(roomId: string, exposed: boolean): void {
			if (exposed) hidden.delete(roomId);
			else hidden.add(roomId);
			save();
		},
	};
}
