import fs from "node:fs";
import path from "node:path";

import { persistentAgentRootPath } from "../persistent-room-workspace-policy.js";
import { isInside } from "./box-closed.js";

export type AlsoAllowedFolder = { path: string; access: "read" | "write" };
export type AlsoAllowedSite = { host: string; port: number };
export type AlsoAllowed = { folders: AlsoAllowedFolder[]; sites: AlsoAllowedSite[] };

function listFile(roomId: string): string {
	return path.join(persistentAgentRootPath(roomId), "runtime", "also-allowed.json");
}

/** Temporary file, then rename: a cut leaves the old list whole. */
export function writeRoomJson(file: string, value: unknown): void {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	const temporary = `${file}.${process.pid}.tmp`;
	fs.writeFileSync(temporary, `${JSON.stringify(value, null, "\t")}\n`, { mode: 0o600 });
	fs.renameSync(temporary, file);
}

/**
 * The room's extra folders and sites: its own field, never in a conversation's
 * policy, so it may change during a turn. Read at each command. A list that
 * can't be read reads empty, which opens nothing.
 */
export function readAlsoAllowed(roomId: string): AlsoAllowed {
	let stored: Partial<AlsoAllowed>;
	try {
		stored = JSON.parse(fs.readFileSync(listFile(roomId), "utf8"));
	} catch {
		return { folders: [], sites: [] };
	}
	const folders = (Array.isArray(stored.folders) ? stored.folders : []).filter((entry) => typeof entry?.path === "string" && path.isAbsolute(entry.path) && (entry.access === "read" || entry.access === "write"));
	const sites = (Array.isArray(stored.sites) ? stored.sites : []).filter((entry) => typeof entry?.host === "string" && Number.isInteger(entry.port));
	return { folders, sites };
}

/**
 * Adds a folder; a yes for writing covers reading, and a yes for reading never
 * narrows one for writing. A folder inside it with the same or less access
 * goes, since this one covers it; one inside it that can change more stays.
 */
export function addAlsoAllowedFolder(roomId: string, folder: string, access: AlsoAllowedFolder["access"], at?: number): void {
	const list = readAlsoAllowed(roomId);
	const existing = list.folders.find((entry) => entry.path === folder);
	if (existing?.access === "write" || existing?.access === access) return;
	const covered = (entry: AlsoAllowedFolder) => entry !== existing && isInside(entry.path, folder) && (access === "write" || entry.access === "read");
	if (existing) existing.access = access;
	const kept = list.folders.filter((entry) => !covered(entry));
	if (!existing) kept.splice(at ?? kept.length, 0, { path: folder, access });
	writeRoomJson(listFile(roomId), { ...list, folders: kept });
}

/** Saves the list's folders as given, its sites as they stand. */
export function saveAlsoAllowedFolders(roomId: string, folders: AlsoAllowedFolder[]): void {
	writeRoomJson(listFile(roomId), { ...readAlsoAllowed(roomId), folders });
}

/** A host as sites are compared: lower case, one leading `www.` cut when a name with a dot stays. */
function siteName(host: string): string {
	const name = host.toLowerCase();
	return /^www\.[^.]+\./.test(name) ? name.slice(4) : name;
}

/** A port as sites are compared: 80 and 443 are one web site; any other port is only itself. */
const sitePort = (port: number): number => (port === 80 ? 443 : port);

/**
 * Whether two sites are one for every yes a site gets: the room's list, this
 * answer's yeses and the sites the person named. `example.org` and
 * `www.example.org` are one, and so are ports 80 and 443; no other sub-name,
 * no other port. The list keeps its entries as written.
 */
export function sameSite(one: AlsoAllowedSite, other: AlsoAllowedSite): boolean {
	return siteName(one.host) === siteName(other.host) && sitePort(one.port) === sitePort(other.port);
}

/** Whether any of these sites is this one. */
export const coversSite = (sites: readonly AlsoAllowedSite[], site: AlsoAllowedSite): boolean => sites.some((each) => sameSite(each, site));

/**
 * The sites one answer was given, whoever gave them, computer or phone, and
 * the page addresses declined in it; nothing here is stored, and it all ends
 * with the answer. A command's Allow this time reaches commands and pages; a
 * page's reaches pages alone, never a command.
 */
export class AnswerSites {
	private ended = false;
	private readonly forCommands: AlsoAllowedSite[] = [];
	private readonly forPages: AlsoAllowedSite[] = [];
	private readonly declinedPages = new Set<string>();
	private firstMessageAfter: string | null | undefined;

	/** The entry the answer's first message follows (null: none), so the sites the person names in any message of this answer count. */
	startsAfter(entryId: string | null): void {
		this.firstMessageAfter = entryId;
	}

	/** Where this answer's messages start; undefined where it isn't known, as for a turn that carries on after a failure. */
	messagesAfter(): string | null | undefined {
		return this.firstMessageAfter;
	}

	/** A yes for the rest of the answer; false once it ended. */
	give(site: AlsoAllowedSite, to: "commands" | "pages"): boolean {
		if (this.ended) return false;
		(to === "commands" ? this.forCommands : this.forPages).push({ host: site.host, port: site.port });
		return true;
	}

	commandsReach(site: AlsoAllowedSite): boolean {
		return coversSite(this.forCommands, site);
	}

	pagesReach(site: AlsoAllowedSite): boolean {
		return coversSite(this.forPages, site) || this.commandsReach(site);
	}

	declinePage(address: string): void {
		if (!this.ended) this.declinedPages.add(address);
	}

	pageDeclined(address: string): boolean {
		return this.declinedPages.has(address);
	}

	end(): void {
		this.ended = true;
		this.forCommands.length = 0;
		this.forPages.length = 0;
		this.declinedPages.clear();
	}
}

/** Adds a site with its port, so a yes for a web site doesn't open port 22. */
export function addAlsoAllowedSite(roomId: string, host: string, port: number, at?: number): void {
	const list = readAlsoAllowed(roomId);
	if (list.sites.some((entry) => entry.host === host && entry.port === port)) return;
	list.sites.splice(at ?? list.sites.length, 0, { host, port });
	writeRoomJson(listFile(roomId), list);
}

/** One entry of the list, as a removal names it and Undo puts it back; `at` is where it stood. */
export type AlsoAllowedEntry = (({ kind: "folder" } & AlsoAllowedFolder) | ({ kind: "site" } & AlsoAllowedSite)) & { at?: number };

const sameEntry = (entry: AlsoAllowedEntry, other: AlsoAllowedEntry): boolean =>
	entry.kind === "folder" ? other.kind === "folder" && other.path === entry.path : other.kind === "site" && other.host === entry.host && other.port === entry.port;

// What Undo may put back: the last entries Remove took off, so a reload or a restart keeps the way back.
const REMOVED_KEPT = 20;

function removedFile(roomId: string): string {
	return path.join(persistentAgentRootPath(roomId), "runtime", "also-allowed-removed.json");
}

function readRemoved(roomId: string): AlsoAllowedEntry[] {
	try {
		const stored = JSON.parse(fs.readFileSync(removedFile(roomId), "utf8"));
		return (Array.isArray(stored) ? stored : []).filter((entry: any): entry is AlsoAllowedEntry =>
			(entry?.kind === "folder" && typeof entry.path === "string" && path.isAbsolute(entry.path) && (entry.access === "read" || entry.access === "write")) ||
			(entry?.kind === "site" && typeof entry.host === "string" && Number.isInteger(entry.port)))
			// The file can be edited by hand: a place that isn't a row's index is no place.
			.map((entry: AlsoAllowedEntry) => (Number.isInteger(entry.at) && (entry.at as number) >= 0 ? entry : { ...entry, at: undefined }));
	} catch {
		return [];
	}
}

/**
 * Takes a folder or a site off the list and keeps it, with its access, for
 * Undo. Only what is on the list goes; it comes back as it stood there.
 */
export function removeAlsoAllowedEntry(roomId: string, named: { path: string } | { host: string; port: number }): AlsoAllowedEntry | null {
	const list = readAlsoAllowed(roomId);
	const at = "path" in named ? list.folders.findIndex((each) => each.path === named.path) : list.sites.findIndex((each) => each.host === named.host && each.port === named.port);
	if (at < 0) return null;
	const entry: AlsoAllowedEntry = "path" in named ? { kind: "folder", ...list.folders[at], at } : { kind: "site", ...list.sites[at], at };
	// Kept before the list changes: a cut between the two leaves the entry on the list, never lost.
	writeRoomJson(removedFile(roomId), [...readRemoved(roomId).filter((each) => !sameEntry(each, entry)), entry].slice(-REMOVED_KEPT));
	writeRoomJson(listFile(roomId), entry.kind === "folder" ? { ...list, folders: list.folders.filter((each) => each.path !== entry.path) } : { ...list, sites: list.sites.filter((each) => each.host !== entry.host || each.port !== entry.port) });
	return entry;
}

/** The entry Remove kept under that name, for Undo: what the server kept, never what the page says. */
export function removedAlsoAllowedEntry(roomId: string, named: { path: string } | { host: string; port: number }): AlsoAllowedEntry | null {
	const wanted: AlsoAllowedEntry = "path" in named ? { kind: "folder", path: named.path, access: "read" } : { kind: "site", ...named };
	return readRemoved(roomId).find((each) => sameEntry(each, wanted)) ?? null;
}

/** Undo: the entry goes back on the list with the access it had, and is no longer kept. */
export function restoreAlsoAllowedEntry(roomId: string, entry: AlsoAllowedEntry): void {
	if (entry.kind === "folder") addAlsoAllowedFolder(roomId, entry.path, entry.access, entry.at);
	else addAlsoAllowedSite(roomId, entry.host, entry.port, entry.at);
	writeRoomJson(removedFile(roomId), readRemoved(roomId).filter((each) => !sameEntry(each, entry)));
}
