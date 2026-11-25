import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isValidPersistentAgentId } from "./persistent-agent-store.js";
import { isValidSkillName, readPersistentRoomSkillSettings, roomSkillState } from "./persistent-room-skill-settings.js";
import { refusedShape, walkPlace, type WalkedPlace } from "./path-shapes.js";
import { DEFAULT_PERSISTENT_ROOM_AGENTS_ROOT, PERSISTENT_ROOM_WORKSPACE_DEFAULT_CONVERSATION_ID, resolvePersistentRoomCapabilityPolicy } from "./persistent-room-workspace-policy.js";
import { readAlsoAllowed } from "./room-box/also-allowed.js";
import { appDataPlaces, isInside, neverOpened, realPathOf } from "./room-box/box-closed.js";
import { writeEntries } from "./room-box/folder-offer.js";
import { localPath } from "./room-box/windows/box-request.js";
import { PKG, REPO_ROOT } from "./server-install-root.js";
import { isSharedServer } from "./server-hooks.js";
import { defangSkillBody, scanInvisibleUnicode } from "./skills-import.js";
import { parseSkillFrontmatter as parseFrontmatter, skillIdFor } from "./skills-repo-fetch.js";
import { agentSkillsDir, countSkillFiles, isAbsent, listSkillFiles, NotPlainSkillFileError, readSkillFileText, readSkillIdentity, sharedAgentsSkillsDir } from "./skills-store.js";

// Where skills live and whose folder a room may open, apart from the rest of the library:
// the room's file fence reads this, and the library's other imports reach the
// server's start-up, which a scheduled run must not load.

/** True when a frontmatter value (a raw string from the skill's YAML) reads as an
 *  affirmative boolean. Skill authors write `disable-model-invocation: true`. */
function frontmatterFlagTrue(value: string | undefined): boolean {
	if (typeof value !== "string") return false;
	// The frontmatter parser hands plain scalars over with trailing comments
	// intact; in YAML a `#` preceded by whitespace starts a comment, so
	// `disable-model-invocation: true # why` must still read as true. A flag
	// misread as off fails OPEN (the skill becomes model-invocable), which is
	// the wrong direction to fail in.
	const scalar = value.split(/\s#/)[0];
	return ["true", "yes", "1", "on"].includes(scalar.trim().toLowerCase());
}

// Frontmatter parsing is unified on skills-repo-fetch's YAML-subset parser
// (imported below as parseFrontmatter) so the library, the room index, and
// repo import all read a manifest identically.

type SkillSource = "builtin" | "shared" | "user" | "project";

function skillDirs(): { dir: string; source: SkillSource }[] {
	return [
		{ dir: path.join(PKG, "skills"), source: "builtin" },
		// The cross-tool shared directory (~/.agents/skills). Read-only from our
		// side: skills there are listed but never edited, deleted, or given
		// provenance sidecars: other tools own that directory. It sits BELOW the
		// user store so a name the user explicitly put in the exxperts store wins
		// over the ambient shared one.
		{ dir: sharedAgentsSkillsDir(), source: "shared" },
		// The canonical user store is the Pi loader's user dir, so a skill
		// written here is visible to the CLI and vice versa.
		{ dir: agentSkillsDir(), source: "user" },
		{ dir: path.join(REPO_ROOT, ".exxeta", "skills"), source: "project" },
	];
}

/** A library skill as a room reads it: its whole SKILL.md and parsed parts, the
 *  identity it was added with (null for none), and the source and folder of the
 *  copy that won. */
interface LibrarySkill {
	manifest: string;
	body: string;
	description: string;
	disableModelInvocation: boolean;
	identity: string | null;
	source: SkillSource;
	folder: string;
}

type LibraryRead = LibrarySkill | { unreadable: true } | null;

/** The most links a linked SKILL.md's way may pass, from its skill's real folder on. */
const SKILL_FILE_LINK_HOPS = 16;

/**
 * The folders rooms' saved settings open to their commands, for every room
 * there is, read fresh: the rooms' data (each room's own data, and on a Mac its
 * commands' temp and caches), and each room's own folder and Also allowed
 * folders, whatever their right, since a right can change later. Not a folder
 * given to one answer only, nor one a room could write before: what keeps a
 * link a room made from leading to its secrets is the name rule of
 * `skillManifestReader`. Throws when the rooms can't be listed.
 */
function everyRoomFolder(): string[] {
	const folders = [DEFAULT_PERSISTENT_ROOM_AGENTS_ROOT];
	let entries: fs.Dirent[] = [];
	try {
		entries = fs.readdirSync(DEFAULT_PERSISTENT_ROOM_AGENTS_ROOT, { withFileTypes: true });
	} catch (error) {
		if (!isAbsent(error)) throw error;
	}
	for (const entry of entries) {
		// A name no room has, as a purged room's leftover, is no room's folder.
		if (!entry.isDirectory() || !isValidPersistentAgentId(entry.name)) continue;
		const room = resolvePersistentRoomCapabilityPolicy(entry.name, PERSISTENT_ROOM_WORKSPACE_DEFAULT_CONVERSATION_ID).policy?.roots[0];
		folders.push(...(room ? [room.path, room.realpath] : []), ...readAlsoAllowed(entry.name).folders.map((folder) => folder.path));
	}
	return folders.map(realPathOf);
}

/**
 * Reads a skill's SKILL.md for one read of the library. A plain file of its own
 * is read as `readSkillFileText` reads it. One that is a link, in a folder read
 * in place (built-in, shared, project) on this computer, is followed
 * (`walkPlace`) and read where its way ends, only when that end is itself a
 * plain file of its own named SKILL.md: whoever made the link, and whenever, it
 * can lead only to another skill's instructions, since a room can't give a file
 * it may not read that name (a rename needs a write where that file lives, a
 * second name is refused, a copy needs a read), and the end is opened by that
 * name, never followed. Nor may a folder rooms' settings open lie on the way,
 * the skill's real folder included (`everyRoomFolder`), the way pass more than
 * SKILL_FILE_LINK_HOPS links, or end in the app's own data. Anything else, and
 * every link in the app's own store or on a shared server, throws
 * NotPlainSkillFileError: unreadable, never absent.
 */
function skillManifestReader(): (source: SkillSource, folder: string) => string {
	let roomFolders: string[] | undefined;
	return function readSkillManifest(source, folder) {
		const file = path.join(folder, "SKILL.md");
		if (source === "user" || isSharedServer() || !fs.lstatSync(file).isSymbolicLink()) return readSkillFileText(folder, "SKILL.md");
		try {
			const stopAt = (roomFolders ??= everyRoomFolder());
			const skillDir = walkPlace(folder, [], { stopAt });
			const way = skillDir.stoppedAt === undefined ? walkPlace(path.join(skillDir.real, "SKILL.md"), [], { stopAt }) : null;
			if (way && way.stoppedAt === undefined && way.linkPlaces.length <= SKILL_FILE_LINK_HOPS && path.basename(way.real) === "SKILL.md" && !appDataPlaces().some((place) => isInside(way.real, place))) {
				return readSkillFileText(path.dirname(way.real), "SKILL.md");
			}
		} catch {
			// A way that can't be walked or ends at no plain file is refused below, as a link in the way is.
		}
		throw new NotPlainSkillFileError(`${file} is a link to a file exxperts doesn't read`);
	};
}

/**
 * A skill's name in the library. A name a room can switch on (`isValidSkillName`)
 * stays as written, at any length, so what a room had on before names were fitted
 * is still there; the person's own skill is the exception when its folder is the
 * name the app gives it (`skillIdFor` of its written name and folder), which every
 * way in uses: then it is that folder. Any other name is fitted (`skillIdFor`), so
 * a skill whose written name the standard doesn't allow can still be switched on.
 * `exact` when the name is the one written; the person's own always holds theirs.
 */
function libraryKey(source: SkillSource, folderName: string, writtenName?: string): { key: string; exact: boolean } {
	const fitted = skillIdFor(writtenName, folderName);
	const asWritten = writtenName?.trim() || folderName;
	if (source === "user") return { key: fitted !== folderName && isValidSkillName(asWritten) ? asWritten : folderName, exact: true };
	if (isValidSkillName(asWritten)) return { key: asWritten, exact: true };
	return { key: fitted, exact: false };
}

/** A skills folder's entries in the order the library reads them: by name, so which of two skills takes a name never hangs on how the disk lists them. */
function inReadingOrder(entries: fs.Dirent[]): fs.Dirent[] {
	return [...entries].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/** Who holds a name in the library as it is read: whether its name was written exactly so, its source, and whether two of that source only fit onto it. */
interface NameClaim {
	exact: boolean;
	source: SkillSource;
	contested: boolean;
}

/**
 * What a skill read next does to the name it has in the library (`claims`: each
 * name's holder so far): "take" it, "lose" (it is listed under its written name),
 * or "contest" it, when it and the holder are of one source and both only fit
 * onto that name: then neither has it. A name written exactly so takes it from
 * any skill read before; one only fitted never takes it from a skill that has it
 * as written, so a skill a room has on stays that skill, and takes it from one
 * only fitted in an earlier source, the later source winning as for one name.
 */
function claimKey(claims: Map<string, NameClaim>, key: string, exact: boolean, source: SkillSource): "take" | "lose" | "contest" {
	const held = claims.get(key);
	if (!exact && held && (held.exact || held.source === source)) {
		if (held.exact || held.contested) return "lose";
		held.contested = true;
		return "contest";
	}
	claims.set(key, { exact, source, contested: false });
	return "take";
}

/**
 * The library as it is right now, read once, as a lookup by name (`libraryKey`)
 * matching listSkills' source precedence (builtin < shared < user < project,
 * last wins, `claimKey`): the skill, or `{ unreadable: true }` when the copy that would win can't be
 * read, or null when no skill has that name. Unreadable is a skills folder that
 * can't be listed, a folder of that name whose SKILL.md can't be read (in the
 * built-in, shared and project folders the name is inside SKILL.md, so only the
 * folder's name is left to go on), or a user-store skill whose record can't be
 * read: a failed read is never taken for a skill that isn't there. read_skill
 * returns only the (defanged) body.
 */
function readLibrary(): (name: string) => LibraryRead {
	const byName = new Map<string, LibraryRead>();
	const claims = new Map<string, NameClaim>();
	// What a name not seen since the last folder that can't be listed reads as.
	let unseen: LibraryRead = null;
	const readManifest = skillManifestReader();
	for (const { dir, source } of skillDirs()) {
		let entries: fs.Dirent[];
		try {
			entries = fs.readdirSync(dir, { withFileTypes: true });
		} catch (error) {
			if (!isAbsent(error)) {
				unseen = { unreadable: true };
				for (const name of byName.keys()) byName.set(name, unseen);
			}
			continue;
		}
		for (const entry of inReadingOrder(entries)) {
			// A linked skill folder reads like a plain one (the shared
			// ~/.agents/skills root is commonly populated by links); whether it
			// opens to a room is judged per room (`roomSkillPlaces`). Its
			// SKILL.md is read as `skillManifestReader` allows.
			if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
			const folder = path.join(dir, entry.name);
			let manifest: string;
			try {
				manifest = readManifest(source, folder);
			} catch (error) {
				const { key, exact } = libraryKey(source, entry.name);
				if (isAbsent(error)) continue;
				const claim = claimKey(claims, key, exact, source);
				if (claim === "take") byName.set(key, { unreadable: true });
				else if (claim === "contest") byName.delete(key);
				continue;
			}
			const { fm, body } = parseFrontmatter(manifest);
			const { key: skillName, exact } = libraryKey(source, entry.name, fm.name);
			const claim = claimKey(claims, skillName, exact, source);
			if (claim === "contest") byName.delete(skillName);
			if (claim !== "take") continue;
			// Only the user store keeps records; every other skill's identity is none.
			const identity = source === "user" ? readSkillIdentity(folder) : null;
			byName.set(skillName, identity === "unreadable"
				? { unreadable: true }
				: { manifest, body, description: (fm.description || "").trim(), disableModelInvocation: frontmatterFlagTrue(fm["disable-model-invocation"]), identity, source, folder }); // last source wins, mirroring listSkills
		}
	}
	return (name) => (byName.has(name) ? byName.get(name)! : unseen);
}

/** What the library holds under one skill's name right now (`readLibrary`). */
function readLibrarySkill(name: string): LibraryRead {
	return readLibrary()(name);
}

/** A library skill by name, or null when there is none or it can't be read. */
function resolveLibrarySkillManifest(name: string): LibrarySkill | null {
	const read = readLibrarySkill(name);
	return read && !("unreadable" in read) ? read : null;
}

/** A skill's folder that may open to a room, and its files beside SKILL.md. */
interface SkillFolder {
	skillDir: string;
	files: string[];
	/** A shared-folder skill's, at the real folder `sharedFolder` judged. */
	shared?: true;
}

/**
 * Whether a skill's folder may go into the model's text as its path is written:
 * no control character (line breaks among them), no U+2028 or U+2029, no
 * character the hidden-character check reports, and nothing the defang would
 * change (every note's marker, the must-keep mark, a `<skill>` tag). Such a path
 * could close a note early and pass what follows off as the person's own words,
 * so a folder whose path fails never opens to a room and its path never reaches
 * the model.
 */
function skillPathFitsText(folder: string): boolean {
	return !/[\p{Cc}\u2028\u2029]/u.test(folder) && scanInvisibleUnicode(folder).count === 0 && defangSkillBody(folder) === folder;
}

/** The person's home folders by their real paths: HOME, the one the supervisor named and the login home. A data folder moved elsewhere is not one: it is the app's data. */
function personHomes(): string[] {
	let login: string | undefined;
	try {
		login = os.userInfo().homedir || undefined;
	} catch {
		// No account record: the other names still count.
	}
	return [os.homedir(), process.env.EXXPERTS_REAL_HOME?.trim(), login].filter((home): home is string => !!home).map(realPathOf);
}

/** Why a skill in the folder shared with other tools keeps to its instructions: its link leads to a home folder or above it, or rooms can't open its folder. */
type SkillFilesKept = "home" | "cant-open";

/**
 * Why rooms can't open a shared-folder skill whose real folder is `real`; null
 * when they may, wherever its link leads. A home folder or any folder above it,
 * the disk's top included, is "home": it would open the person's whole home. A
 * place the fence refuses by its shape (a network or device place, on Windows
 * anything but a local disk), a path that doesn't fit the model's text, and a
 * place inside or holding one no room ever opens (the app's data, its own
 * files and the key places of a home) or the rooms' data are "cant-open".
 */
function sharedPlaceKept(real: string): SkillFilesKept | null {
	if (personHomes().some((home) => isInside(home, real))) return "home";
	if (refusedShape(real) || (process.platform === "win32" && localPath(real) === undefined) || !skillPathFitsText(real)) return "cant-open";
	const closed = [...neverOpened(), realPathOf(DEFAULT_PERSISTENT_ROOM_AGENTS_ROOT)];
	return closed.some((place) => isInside(real, place) || isInside(place, real)) ? "cant-open" : null;
}

/**
 * A shared-folder skill's folder, judged at each read from its real path after
 * every link, nothing kept: its real folder and files when `sharedPlaceKept`
 * lets rooms open it and it can be listed whole, otherwise why not. Null on a
 * shared server, where nothing opens, and for a link whose target is gone.
 */
function sharedFolder(skill: LibrarySkill): SkillFolder | SkillFilesKept | null {
	if (isSharedServer()) return null;
	let real: string;
	try {
		real = fs.realpathSync.native(skill.folder);
	} catch {
		return null;
	}
	return sharedFolderAt(real);
}

/** A shared-folder skill's folder at its real path `real`, as `sharedFolder` judges it. */
function sharedFolderAt(real: string): SkillFolder | SkillFilesKept {
	const kept = sharedPlaceKept(real);
	if (kept) return kept;
	const files = listSkillFiles(real);
	return files ? { skillDir: real, files: files.filter((file) => file !== "SKILL.md"), shared: true } : "cant-open";
}

/**
 * The folder of a copy in the app's own skills folder, when a room may open it,
 * and never for writing: a plain folder, never a link, directly inside that
 * skills folder, that can be listed whole and whose path fits the model's text
 * (`skillPathFitsText`). Built-in and project copies, one shadowing another
 * included, are instructions only; a shared-folder copy is judged by
 * `sharedFolder`, and per room by `roomSkillPlaces`.
 */
function ownFolder(skill: LibrarySkill): SkillFolder | null {
	if (skill.source !== "user") return null;
	// A user copy's folder is its entry in the app's skills folder (`readLibrary`),
	// so a plain folder there is directly inside it.
	try {
		if (!fs.lstatSync(skill.folder).isDirectory()) return null;
	} catch {
		return null;
	}
	if (!skillPathFitsText(skill.folder)) return null;
	const files = listSkillFiles(skill.folder);
	return files ? { skillDir: skill.folder, files: files.filter((file) => file !== "SKILL.md") } : null;
}

/**
 * The library's skill of that name: the folder a room may open, or null
 * (`ownFolder`, `sharedFolder`), what the Skills pages list as its files; and for a
 * shared-folder skill what they say of them (`SharedFilesView`), from one
 * judgment of its folder. A caller asking for many names passes one
 * `readLibrary()` so the library is read once.
 */
function librarySkillFolderView(name: string, read: (name: string) => LibraryRead = readLibrary()): { folder: SkillFolder | null; shared: SharedFilesView } {
	const skill = read(name);
	if (!skill || "unreadable" in skill) return { folder: null, shared: {} };
	if (skill.source !== "shared") return { folder: ownFolder(skill), shared: {} };
	const judged = sharedFolder(skill);
	return { folder: judged !== null && typeof judged === "object" ? judged : null, shared: sharedFilesView(skill, judged) };
}

/** What the Skills pages say of a shared-folder skill's files (`sharedFolder`), when it has any beside SKILL.md. */
interface SharedFilesView {
	/** Where its files are, with the home folder written as ~: only when rooms open them and its real folder lies outside ~/.agents. */
	filesAt?: string;
	/** Why rooms use only its instructions, when its folder holds a file beside SKILL.md or can't be listed. */
	instructionsOnly?: SkillFilesKept;
}

/** What the Skills pages say of a shared-folder skill's files, from its folder as `sharedFolder` judged it; nothing for a skill of instructions alone. */
function sharedFilesView(skill: LibrarySkill, shared: SkillFolder | SkillFilesKept | null): SharedFilesView {
	if (shared === null) return {};
	if (typeof shared !== "object") return countSkillFiles(skill.folder, 0) === 0 ? {} : { instructionsOnly: shared };
	if (shared.files.length === 0 || isInside(shared.skillDir, realPathOf(path.dirname(sharedAgentsSkillsDir())))) return {};
	const home = realPathOf(os.homedir());
	return { filesAt: isInside(shared.skillDir, home) ? `~${shared.skillDir.slice(home.length)}` : shared.skillDir };
}

/** A skill on in a room whose folder its commands may read and run. */
interface RoomSkillFolder extends SkillFolder {
	name: string;
}

/** The folders a room's commands and file tools can write, by their real paths: its folder and its Also allowed folders for writing. */
function roomWriteRoots(roomId: string): string[] {
	const room = resolvePersistentRoomCapabilityPolicy(roomId, PERSISTENT_ROOM_WORKSPACE_DEFAULT_CONVERSATION_ID).policy?.roots[0];
	return [...(room ? [room.path, room.realpath] : []), ...writeEntries(readAlsoAllowed(roomId).folders)].map(realPathOf);
}

/** A skill on in a room whose way from ~/.agents/skills enters the room's own folders: where it does, as the links before it spell it. */
interface RoomSkillInRoom {
	name: string;
	place: string;
}

/**
 * The skills on in a room (`roomSkillState`), read fresh at each call: those
 * whose folders the server opens to it (`opened`, from `ownFolder`, one its
 * author marked for picking by hand included, since the person picks it in the
 * room), and the shared-folder skills whose way enters a folder the room can
 * write (`inRoom`). A shared-folder skill's way is walked from its entry,
 * following only links that lie outside those folders, and stops where it
 * enters one: from there on the room's own commands could change it, a folder
 * above included, so the server opens nothing for it and the room reaches it by
 * its own rights. A way that never enters one is opened where the walk found
 * it: nothing on it is the room's to change.
 */
function roomSkillPlaces(roomId: string): { opened: RoomSkillFolder[]; inRoom: RoomSkillInRoom[] } {
	const entries = readPersistentRoomSkillSettings(roomId).enabledSkills;
	const opened: RoomSkillFolder[] = [];
	const inRoom: RoomSkillInRoom[] = [];
	if (entries.length === 0) return { opened, inRoom };
	const library = readLibrary();
	let writable: string[] | undefined;
	for (const entry of entries) {
		const read = library(entry.name);
		if (roomSkillState(entry, read) !== "ok" || !read || "unreadable" in read) continue;
		if (read.source !== "shared") {
			const folder = ownFolder(read);
			if (folder) opened.push({ name: entry.name, ...folder });
			continue;
		}
		if (isSharedServer()) continue;
		let walked: WalkedPlace;
		try {
			walked = walkPlace(read.folder, [], { stopAt: (writable ??= roomWriteRoots(roomId)) });
		} catch {
			continue;
		}
		if (walked.stoppedAt !== undefined) {
			if (walked.stoppedAt !== null && skillPathFitsText(walked.stoppedAt)) inRoom.push({ name: entry.name, place: walked.stoppedAt });
			continue;
		}
		const folder = sharedFolderAt(walked.real);
		if (typeof folder === "object") opened.push({ name: entry.name, ...folder });
	}
	return { opened, inRoom };
}

/** The skills whose folders a room may open right now (`roomSkillPlaces`): both boxes, the file fence, the folders a file call holds and the skill's text read this. */
function roomSkillFolders(roomId: string): RoomSkillFolder[] {
	return roomSkillPlaces(roomId).opened;
}

/** Where a shared-folder skill on in the room enters the room's own folders (`roomSkillPlaces`), or undefined. */
function roomSkillInRoom(roomId: string, name: string): string | undefined {
	return roomSkillPlaces(roomId).inRoom.find((skill) => skill.name === name)?.place;
}

export { claimKey, frontmatterFlagTrue, skillManifestReader, inReadingOrder, libraryKey, librarySkillFolderView, readLibrary, readLibrarySkill, resolveLibrarySkillManifest, roomSkillFolders, roomSkillInRoom, sharedPlaceKept, skillPathFitsText, type NameClaim, type RoomSkillFolder, skillDirs, type SharedFilesView, type SkillFilesKept, type SkillSource };
