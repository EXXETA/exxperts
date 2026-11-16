import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { productAppStateRoot, stateHome } from "../../../../pi-package/product-state-paths.js";
import { REPO_ROOT } from "../server-install-root.js";
import { PERSISTENT_ROOM_DEFAULT_DENY_CREDENTIAL_PATHS, PERSISTENT_ROOM_HOME_CLOSED_PATHS } from "../persistent-room-workspace-policy.js";

// Credential folders the workspace lists don't name, because file tools never
// had a reason to pass through them. Under each home.
const BOX_ONLY_CLOSED = ["Library/Keychains", ".azure", ".kube", ".docker", ".config/gh", ".config/mcp"] as const;

/**
 * A person's own data outside any home: the databases Homebrew's services keep,
 * apps' data for the whole computer, the network homes and shares the
 * automounter puts in place, and the local mail. Broad, like `/Users`: a yes can
 * still open one folder inside. Homebrew lists and shows its packages without
 * its `var`.
 */
const DATA_OUTSIDE_HOMES = ["/opt/homebrew/var", "/usr/local/var", "/Library/Application Support", "/home", "/Network", "/net", "/private/var/mail"] as const;

/**
 * A name as a Mac's disk compares it: `.SSH`, `.ſsh`, `.ßh` and either Unicode
 * form of an accent all open one folder. For comparing only: a rule names the
 * real path, since a folded name is another folder on a case-sensitive disk.
 */
export function foldedName(name: string): string {
	return name.normalize("NFD").toUpperCase().toLowerCase().normalize("NFD");
}

/** A path by the disk's own spelling where it exists, or by its closest real parent where it doesn't yet. */
export function realPathOf(target: string): string {
	let current = path.resolve(target);
	const missing: string[] = [];
	for (;;) {
		try {
			return path.join(fs.realpathSync.native(current), ...missing);
		} catch {
			const parent = path.dirname(current);
			if (parent === current) return path.resolve(target);
			missing.unshift(path.basename(current));
			current = parent;
		}
	}
}

/** Every home this server can name: a data profile moves `os.homedir()`, and the login home stays the person's. */
export function homeFolders(): string[] {
	let login: string | undefined;
	try {
		login = os.userInfo().homedir || undefined;
	} catch {
		// No account record: the other names still count.
	}
	return [...new Set([stateHome(), process.env.EXXPERTS_REAL_HOME?.trim(), login, os.homedir()].filter((home): home is string => !!home).map(realPathOf))];
}

// The system's names for its per-user folders don't change while the server runs.
const userFolders = new Map<string, string | undefined>();

/** The system's own name for one of its per-user folders under `/var/folders`, or nothing when it can't be read. Asked once. */
function darwinUserFolder(name: string): string | undefined {
	if (!userFolders.has(name)) userFolders.set(name, spawnSync("/usr/bin/getconf", [name], { encoding: "utf8" }).stdout?.trim() || undefined);
	return userFolders.get(name);
}

/**
 * The computer's shared folders a command never reads or writes: the temp
 * folder, the per-user caches folder (the app's own cache sits there among
 * hundreds), and the per-user `0` folder beside them, each by the system's own
 * name for it, since TMPDIR can say something else. The box gives commands a
 * private temp and private caches of their own instead.
 */
function sharedSystemFolders(): string[] {
	const named = ["DARWIN_USER_TEMP_DIR", "DARWIN_USER_CACHE_DIR", "DARWIN_USER_DIR"].map(darwinUserFolder);
	return [...new Set([...named, os.tmpdir(), "/private/tmp", "/private/var/tmp"].filter((folder): folder is string => !!folder).map(realPathOf))];
}

/** A shape in the workspace lists that names one place under a home: no `**`, and not another computer's. */
function homePlaces(): string[] {
	const listed = [...PERSISTENT_ROOM_DEFAULT_DENY_CREDENTIAL_PATHS, ...PERSISTENT_ROOM_HOME_CLOSED_PATHS, ...BOX_ONLY_CLOSED]
		.filter((place) => !place.includes("*") && !place.startsWith("AppData/") && !place.startsWith("proc/") && !place.startsWith("id_"));
	return homeFolders().flatMap((home) => listed.map((place) => path.join(home, place)));
}

/** The app's data, every data profile's among it. Listed by what is on disk now, so a profile made later counts from its first command. */
export function appDataPlaces(): string[] {
	const places = [productAppStateRoot()];
	for (const home of homeFolders()) {
		places.push(path.join(home, ".exxperts"));
		try {
			for (const entry of fs.readdirSync(home)) if (entry.startsWith(".exxperts-") || entry.startsWith(".exxperts.")) places.push(path.join(home, entry));
		} catch {
			// An unreadable home is closed as a whole below.
		}
	}
	return [...new Set(places.map(realPathOf))];
}

/** What a command in the box never reads, whatever else is open. The broad places come first; the box reopens the room inside them. `shared` names the computer's shared folders among them. */
export function closedForReading(): { broad: string[]; always: string[]; shared: string[] } {
	const shared = sharedSystemFolders();
	const broad = [...homeFolders(), ...shared, "/Users", "/Volumes", ...DATA_OUTSIDE_HOMES.map(realPathOf)];
	const always = [...appDataPlaces(), ...homePlaces().map(realPathOf), "/Library/Keychains"];
	return { broad: [...new Set(broad)], always: [...new Set(always)], shared };
}

export function isInside(child: string, parent: string): boolean {
	const [inner, outer] = [foldedName(child), foldedName(parent)];
	return inner === outer || inner.startsWith(outer.endsWith(path.sep) ? outer : `${outer}${path.sep}`);
}

/** What a yes can never open: the always-closed places, and the app's own files, which it starts outside the box. Commands may still read those. */
export function neverOpened(): string[] {
	return [...closedForReading().always, realPathOf(REPO_ROOT)];
}
