import fs from "node:fs";
import path from "node:path";

import { realPlace } from "../path-shapes.js";
import { closedForReading, homeFolders, isInside, realPathOf } from "./box-closed.js";

/** What one room's commands may reach right now, read fresh for each command. */
export interface BoxPolicy {
	folder: string;
	canChangeFiles: boolean;
	alsoAllowed: readonly { path: string; access: "read" | "write" }[];
	/** The folders of the skills on in the room (`roomSkillFolders`): reopened for reading and running. They never add or take away a write: the room's write roots alone decide writes. */
	skillFolders: readonly string[];
	places: BoxPlaces;
}

/** The room's own pieces under its closed data folder, which the box reopens. */
export interface BoxPlaces {
	temp: string;
	caches: string;
	shim: string;
	gitTemplate: string;
}

/** Files other tools run from a folder, and shell startup files. Closed in every write root, at any depth. */
export const NEVER_WRITABLE_FILES = [
	".gitmodules", ".gitconfig", ".ripgreprc", ".mcp.json", ".envrc",
	".bashrc", ".bash_profile", ".bash_login", ".profile", ".zshrc", ".zshenv", ".zprofile", ".zlogin", ".zlogout",
	".devcontainer.json", ".clinerules", ".pre-commit-config.yaml", ".npmrc", ".yarnrc.yml",
] as const;

/** Folders other tools run from. All of each is closed, in every write root, at any depth. */
export const NEVER_WRITABLE_FOLDERS = [
	".vscode", ".idea", ".zed", ".devcontainer", ".claude", ".cursor", ".codex", ".gemini", ".agents", ".windsurf", ".exxperts",
	".nova", ".fleet", ".vs", ".continue", ".roo", ".kiro", ".opencode", ".cline", ".husky",
] as const;

/** Name globs other tools run from, closed in every write root, at any depth. Kept apart from the exact names: only the write-deny patterns glob. */
export const NEVER_WRITABLE_GLOBS = ["*.code-workspace"] as const;

/**
 * Of the names commands run from, what the file tools never change in a room
 * that asks nothing (Auto with protection off), at any depth: the connector
 * settings and the app's own data. The fence (room-files.ts) and the file
 * program's rules both read this list; the fence alone closes more there, as
 * the app's other names.
 */
export const CLOSED_TO_WRITES_ASKING_NOTHING = [".mcp.json", ".exxperts"] as const satisfies readonly ((typeof NEVER_WRITABLE_FILES)[number] | (typeof NEVER_WRITABLE_FOLDERS)[number])[];

/** Inside a repository, what the file tools never change: the settings and programs git runs, the rebase and sequencer todo it runs `exec` lines from. Commands change nothing in a `.git`. */
export const GIT_CLOSED = [
	".git/config", ".git/config.lock", ".git/config.worktree", ".git/hooks", ".git/commondir", ".git/gitdir",
	".git/rebase-merge", ".git/rebase-apply", ".git/sequencer",
	".git/worktrees/*/config.worktree", ".git/worktrees/*/commondir", ".git/worktrees/*/gitdir", ".git/worktrees/*/hooks",
	".git/worktrees/*/rebase-merge", ".git/worktrees/*/rebase-apply", ".git/worktrees/*/sequencer",
	".git/modules/**/config", ".git/modules/**/config.worktree", ".git/modules/**/hooks", ".git/modules/**/commondir", ".git/modules/**/gitdir",
	".git/modules/**/rebase-merge", ".git/modules/**/rebase-apply", ".git/modules/**/sequencer",
] as const;

/**
 * The layout git reads to take a folder for a git directory (`is_git_directory`
 * in git's setup.c): a valid `HEAD` in the folder itself, with `objects` and
 * `refs` there or in the folder its `commondir` names. Without a `HEAD` git
 * never takes the folder for a git directory of its own, whatever else it
 * holds, so `HEAD` carries the guard: a command can't make it at the top by a
 * write, a move or a link, since each makes the name the rule closes. `objects`
 * and `refs` are closed beside it, so a command can't lay out a common
 * directory either, which a linked worktree elsewhere reads with no `HEAD` in it.
 */
const GIT_LAYOUT = ["HEAD", "objects", "refs"] as const;

/**
 * The entries of a git directory git runs programs from: the layout, the
 * settings and hooks it then runs, and the rebase and sequencer state. All are
 * closed at the top of a write root that already holds a `HEAD`, or both
 * `objects` and `refs` (a linked worktree elsewhere can take such a folder for
 * its common directory and read its `config` and hooks), or whose own git
 * settings may lead git to them (a hooks path of `hooks`, an include of
 * `../config`); see `closedAtTop`. Not
 * at depth: these are ordinary names deeper in a tree, and a bare repository in
 * a subfolder is the known limit.
 */
export const GIT_DIR_ENTRIES = [
	"HEAD", "config", "config.worktree", "hooks", "objects", "refs", "packed-refs",
	"commondir", "gitdir", "worktrees", "modules", "rebase-merge", "rebase-apply", "sequencer",
] as const;

/** The names closed at a folder's top only where git may already use them; see `closedAtTop`. */
const OPENED_AT_TOP = GIT_DIR_ENTRIES.filter((name) => !(GIT_LAYOUT as readonly string[]).includes(name));

// git's settings files are a few lines; one bigger than this is not read and counts as pointing at the top.
const GIT_SETTINGS_LIMIT = 64 * 1024;

/**
 * The names closed for writing at the top of a folder a room can change, read
 * from the disk at each call, so the disk's own rule for upper and lower case
 * decides what is there: git's layout everywhere, and every git directory
 * entry where the folder already holds a `HEAD`, or both `objects` and
 * `refs`, or where its own git settings may lead git to one of those names
 * (`settingsPointAtTop`). A name that can't be looked up counts as there.
 * Elsewhere `config`, `hooks` and `modules` are a project's own names.
 */
export function closedAtTop(folder: string): readonly string[] {
	const holds = (name: string) => entryAt(folder, name) !== null;
	if (holds("HEAD") || (holds("objects") && holds("refs"))) return GIT_DIR_ENTRIES;
	return settingsPointAtTop(folder) ? GIT_DIR_ENTRIES : GIT_LAYOUT;
}

/** What is at a name in a folder, by `lstat`: null when nothing is, "unknown" when it can't be looked up. */
function entryAt(folder: string, name: string): fs.Stats | null | "unknown" {
	try {
		return fs.lstatSync(path.join(folder, name), { throwIfNoEntry: false }) ?? null;
	} catch {
		return "unknown";
	}
}

/**
 * Whether the folder's own git settings may lead git to a name opened at its
 * top: a `.git` that is not a plain folder, or one with a `commondir` (its
 * settings then live elsewhere), or a `.git/config` or `.git/config.worktree`
 * with an include section, which may name the top's `config`, a `worktree`
 * key, which moves where a hooks path starts, or a hooks path that isn't a
 * plain relative one, or leads into one of those names. Not git's whole
 * format: anything this reading can't make sense of answers yes, and it never
 * throws.
 *
 * As before, a relative hooks path with another name leaves the names open,
 * and neither settings above the folder nor the person's own git settings are
 * read. A repository below the folder
 * whose own settings point up at the folder's top (a hooks path of `../hooks`,
 * an include of `../../config`) is not looked for. A setting that names a
 * program, as `core.fsmonitor`, is the person's own and is not judged.
 */
function settingsPointAtTop(folder: string): boolean {
	try {
		const git = entryAt(folder, ".git");
		if (git === null) return false;
		if (git === "unknown" || !git.isDirectory() || entryAt(folder, path.join(".git", "commondir")) !== null) return true;
		const texts = ["config", "config.worktree"].map((name) => settingsText(path.join(folder, ".git", name)));
		if (texts.some((text) => text === null)) return true;
		const all = texts.join("\n");
		// `[include]` and `[includeIf ...]`, wherever a header can start; section names ignore case.
		if (/\[\s*include/i.test(all)) return true;
		const lines = all.split(/\r?\n/);
		// `core.worktree`, in any section; `extensions.worktreeConfig` and a value that holds the word are other keys.
		if (lines.some((line) => /worktree/i.test(line) && [undefined, "worktree"].includes(lineKey(line)))) return true;
		const values = lines.filter((line) => /hookspath/i.test(line) && !/^\s*[#;]/.test(line)).map(hooksPathValue);
		if (values.length === 0) return false;
		const [value] = values;
		return value === undefined || values.some((other) => other !== value) || hooksPathLeadsToTop(value, folder);
	} catch {
		return true;
	}
}

/** A settings file's text: empty when it isn't there, null when it is anything but a plain file within the limit, or can't be read. */
function settingsText(file: string): string | null {
	const kind = fs.lstatSync(file, { throwIfNoEntry: false });
	if (!kind) return "";
	return kind.isFile() && kind.size <= GIT_SETTINGS_LIMIT ? fs.readFileSync(file, "utf8") : null;
}

// Section headers at a line's start, `[name]` or `[name "sub"]`, with git's escapes inside the quotes.
const HEADERS = /^(?:\s*\[[^\]"]*(?:"(?:[^"\\]|\\.)*"\s*)?\])*/;

/** The key one settings line sets after any headers, lower case: "" when it sets none, undefined when this reading can't tell. */
function lineKey(line: string): string | undefined {
	const rest = line.replace(HEADERS, "").trimStart();
	if (rest === "" || /^[#;]/.test(rest)) return "";
	return /^([a-z][\w-]*)\s*(?:$|[=#;])/i.exec(rest)?.[1].toLowerCase();
}

// The only hooks paths judged: relative, in plain path characters. An absolute one can name the folder by another
// spelling (on a Mac through `/System/Volumes/Data`), and `~` is the person's own home, which a data profile moves.
// In git's settings a backslash is an escape, and a space, a `$` or a letter beyond ASCII is a spelling this reading won't guess at.
const PLAIN_HOOKS_PATH = /^[\w.-][\w./-]*$/;

/**
 * The value of one line that names `hooksPath`: headers before the key, `=`,
 * and a value as written, bare or in one pair of quotes, with a comment after
 * it cut off. Undefined for any other line, or a value outside the plainest
 * spelling.
 */
function hooksPathValue(line: string): string | undefined {
	const key = line.replace(HEADERS, "");
	const raw = /^\s*hookspath\s*=(.*)$/i.exec(key)?.[1];
	if (raw === undefined) return undefined;
	const value = (/^\s*"([^"]*)"\s*(?:[#;].*)?$/.exec(raw) ?? /^\s*([^\s"#;]*)\s*(?:[#;].*)?$/.exec(raw))?.[1];
	return value !== undefined && PLAIN_HOOKS_PATH.test(value) ? value : undefined;
}

/**
 * Whether a plain relative hooks path leads to a name opened at the folder's
 * top, as git runs hooks from there. The place is judged by its name and by
 * where it really is, so a link at the top that leads to `hooks` counts too.
 * `folder` is a real path, as every caller's is.
 */
function hooksPathLeadsToTop(value: string, folder: string): boolean {
	// git walks a `..` on the disk, through links. Windows drops a part's trailing dots, so `hooks.` opens `hooks` there.
	if (value.split("/").some((part) => part === ".." || (part !== "." && part.endsWith(".")))) return true;
	const place = path.resolve(folder, value);
	const real = realPlace(place);
	return real === null || [place, real].some((at) => OPENED_AT_TOP.some((name) => isInside(at, path.join(folder, name))));
}

// The library always writes these two, for its own default temp. Our temp is the private one.
const LIBRARY_DEFAULT_TEMP = ["/tmp/claude", "/private/tmp/claude"];

/** A folder's name as glob text: the library's glob has no escape, so each special character is written as a set of itself. */
function globLiteral(folder: string): string {
	return folder.replace(/[[*?]/g, (character) => `[${character}]`);
}

/**
 * A `.git` and all it holds, at any depth: git's own folders are read, never
 * changed or made, so nothing git runs later can be planted through one.
 */
function gitPatterns(root: string): string[] {
	const anchor = globLiteral(root);
	return [`${anchor}/.git`, `${anchor}/**/.git`];
}

/** Each name at any depth below a root. The sandbox ignores case in its rules, on every disk format, so `.GIT` and `.VSCODE` need no names of their own. */
function atAnyDepth(root: string, names: readonly string[]): string[] {
	const anchor = globLiteral(root);
	return names.flatMap((name) => [`${anchor}/${name}`, `${anchor}/**/${name}`]);
}

/** `.git` and the names other tools run from, at any depth: what a folder may never carry into the room. */
function carriedPatterns(root: string): string[] {
	return [...gitPatterns(root), ...atAnyDepth(root, [...NEVER_WRITABLE_FILES, ...NEVER_WRITABLE_FOLDERS, ...NEVER_WRITABLE_GLOBS])];
}

function closedPatterns(root: string): string[] {
	// git's names only at the top of a write root: deeper, they are ordinary names.
	const atTop = closedAtTop(root).map((name) => `${globLiteral(root)}/${name}`);
	return [...carriedPatterns(root), ...atTop];
}

function regexLiteral(text: string): string {
	return text.replace(/[.^$*+?()[\]{}|\\-]/g, "\\$&");
}

// Its place in an app bundle, not one Mac's path: a copy, a renamed app and `~/Applications` too. The library allows every start before this.
const LIBREOFFICE_STARTS_NOWHERE = `(deny process-exec (regex ${JSON.stringify(`${regexLiteral(".app/Contents/MacOS/soffice")}$`)}))`;

/**
 * The rules the library has no way to say, added at the end of its profile: a
 * private temp and caches that can't be swapped for a link, since the server
 * takes both by name at a turn's start. The specific operations are named too,
 * because the library re-allows them on write roots. Each writable folder of
 * the room can't be moved, removed or made again at its name, whatever its name
 * holds: the library's own rule for that comes only as a side effect, and not
 * for a name its globs can't spell. Like every rule here, they carry none of the
 * library's log tag, so a refusal raises no folder card: a yes couldn't open
 * them. A command can't start LibreOffice, in any app bundle and through whatever
 * starts it: it needs the Mac's window system, which the box refuses, and would
 * wait for it for ever. The last rule stops a command reading another program's
 * start-up environment and arguments.
 */
export function profileRules(policy: BoxPolicy, writeRoots: readonly string[]): string {
	const operations = "file-write* file-write-create file-write-unlink file-write-data";
	const roomRoots = writeRoots.filter((root) => root !== policy.places.temp && root !== policy.places.caches);
	const places = [policy.places.temp, policy.places.caches].map((place) => `(deny ${operations} (literal ${JSON.stringify(place)}))`);
	const stay = (folder: string) => `(deny file-write-unlink file-write-create (literal ${JSON.stringify(folder)}))`;
	const links = homeLinksTo([policy.folder, ...policy.alsoAllowed.map((entry) => entry.path)]).map((link) => `(allow file-read* (literal ${JSON.stringify(link)}))`);
	return [...places, ...roomRoots.map(stay), ...links, LIBREOFFICE_STARTS_NOWHERE, "(deny process-info* (target others))"].join("\n");
}

/**
 * The links in a home that lead to one of the room's folders, or to a folder
 * holding one, as OneDrive's `~/OneDrive - <org>` does: a command that passes
 * through one reads the link itself in the closed home. Reading a link gives
 * only where it leads, and what is there keeps its own rules.
 */
export function homeLinksTo(folders: readonly string[]): string[] {
	const links: string[] = [];
	for (const home of homeFolders()) {
		let names: string[];
		try {
			names = fs.readdirSync(home);
		} catch {
			continue;
		}
		for (const name of names) {
			const link = path.join(home, name);
			if (!fs.lstatSync(link, { throwIfNoEntry: false })?.isSymbolicLink()) continue;
			const target = realPathOf(link);
			if (folders.some((folder) => isInside(folder, target) || isInside(target, folder))) links.push(link);
		}
	}
	return links;
}

type LiteralEntry = { path: string; literal: true };
const literal = (place: string): LiteralEntry => ({ path: place, literal: true });

/** The library's per-command file rules, and ours to add to its profile. */
export function boxRules(policy: BoxPolicy): { filesystem: Record<string, unknown>; profileRules: string } {
	const { temp, caches, shim, gitTemplate } = policy.places;
	const { broad, always } = closedForReading();
	const roomRoots = [policy.folder, ...policy.alsoAllowed.filter((entry) => entry.access === "write").map((entry) => entry.path)];
	const writableRoots = policy.canChangeFiles ? roomRoots : [];
	const writeRoots = [...writableRoots, temp, caches];
	// By name, never the folder: git keeps stored logins beside these.
	const gitSettings = homeFolders().flatMap((home) => [".gitconfig", ".config/git/config", ".config/git/ignore", ".config/git/attributes"].map((name) => path.join(home, name)));
	// The app's data folder holds the room's own temp and caches, so it can't be a deny: it stays closed by not being a write root.
	const closedAroundRoom = always.filter((closed) => !isInside(temp, closed));
	const reopened = [policy.folder, ...policy.alsoAllowed.map((entry) => entry.path), ...policy.skillFolders, ...gitSettings, temp, caches, shim, gitTemplate];
	// A skill's folder in or holding a room's write root keeps the room's writes there; every other one stays closed to writes.
	const skillsOutsideRoom = policy.skillFolders.filter((skill) => !writableRoots.some((root) => isInside(skill, root) || isInside(root, skill)));
	return {
		filesystem: {
			denyRead: [...broad, ...always].map(literal),
			allowRead: reopened.map(literal),
			allowWrite: writeRoots.map(literal),
			denyWrite: [
				...writableRoots.flatMap(closedPatterns),
				// In the private temp and caches too, so no repository or file another tool runs is made there and moved into the room. The bare-repository names are ordinary there.
				...[temp, caches].flatMap(carriedPatterns),
				...[...closedAroundRoom, ...skillsOutsideRoom, ...LIBRARY_DEFAULT_TEMP, ...homeFolders().map((home) => path.join(home, "Library/LaunchAgents"))].map(literal),
			],
		},
		profileRules: profileRules(policy, writeRoots),
	};
}

/** What one file tool call may reach: the places the room's fence opens, and nothing a command could read beyond them. */
export interface FilePolicy {
	/** The fence's folders by real path, with their access, and the exact files it opens. */
	roots: readonly { path: string; access: "read" | "write" }[];
	/** Whether this call writes: only then is any root writable. */
	writes: boolean;
	/**
	 * Names closed for reading below every root, as runs of parts with `*` in a
	 * part and `**` for any run: secrets, keys and the app's data. The server's
	 * fence closes the same names; here the Mac holds them at the open.
	 */
	closedBelow: readonly string[];
	/** The fence's answer for this call: a room that asks nothing, where only CLOSED_TO_WRITES_ASKING_NOTHING stays closed to writes. */
	asksNothing: boolean;
	/** The file program, the Node that runs it and the libraries that Node loads from outside the system's, each reopened by name, never by folder. */
	program: readonly string[];
}

// What Node and the shell that starts it read before the program runs, measured
// under these rules: the system's own libraries, and the disk's root for its first lookup.
const PROGRAM_START_READS = ["(subpath \"/System\")", "(subpath \"/usr/lib\")", "(literal \"/\")", "(literal \"/bin/bash\")", "(literal \"/dev/null\")", "(literal \"/dev/urandom\")"];

/** One part of a closed name as the sandbox's regex: `*` within the part, everything else as itself. */
function partRegex(part: string): string {
	return part.split("*").map(regexLiteral).join("[^/]*");
}

/** A run of parts, `**` for any run of parts between them. */
function runRegex(run: string): string {
	return run.split("/").reduce((source, part) => (part === "**" ? `${source}(/[^/]+)*` : `${source}${source ? "/" : ""}${partRegex(part)}`), "");
}

/**
 * Names closed for these operations below each root, and whatever is inside
 * them. A root's own place is the fence's to judge, and no job can move it.
 * Committed templates such as `.env.example` hold no secret: left out as the
 * last part, and closed again under any closed part above them. Denies only,
 * so nothing another rule closes opens again.
 */
function closedBelowRoots(operations: string, roots: readonly string[], names: readonly string[]): string[] {
	if (names.length === 0) return [];
	const closed = names.map(runRegex).join("|");
	const below = (root: string, tail: string) => `(regex ${JSON.stringify(`^${regexLiteral(root)}/(.*/)?${tail}`)})`;
	return roots.flatMap((root) => [
		`(deny ${operations} (require-all ${below(root, `(${closed})(/.*)?$`)} (require-not ${below(root, "\\.env\\.(example|sample|template|dist)$")})))`,
		`(deny ${operations} ${below(root, `(${closed})/.+$`)})`,
	]);
}

/**
 * The rules for the file program. It reads only what the fence opens, so a link
 * a job left behind inside the room leads nowhere: not to a system file a command
 * could read, not to a closed name in the room. It writes only when the call
 * writes, under a command's never-writable names, or in a room that asks
 * nothing under CLOSED_TO_WRITES_ASKING_NOTHING alone. It has no network, and it can't read another program's start-up details.
 */
export function fileRules(policy: FilePolicy): { filesystem: Record<string, unknown>; profileRules: string } {
	const { broad, always } = closedForReading();
	const writable = policy.writes ? policy.roots.filter((root) => root.access === "write").map((root) => root.path) : [];
	const opened = [...policy.roots.map((root) => root.path), ...policy.program];
	const quoted = (place: string) => JSON.stringify(place);
	const roots = policy.roots.map((root) => root.path);
	const reads = [
		`(deny file-read-data (require-not (require-any ${[...PROGRAM_START_READS, ...opened.map((place) => `(literal ${quoted(place)})`), ...roots.map((root) => `(subpath ${quoted(root)})`)].join(" ")})))`,
		...closedBelowRoots("file-read*", roots, policy.closedBelow),
		...always.filter((place) => roots.some((root) => isInside(place, root))).map((place) => `(deny file-read* (subpath ${quoted(place)}))`),
	];
	const writes = `(deny file-write* (require-not (require-any (literal "/dev/null") ${writable.map((root) => `(subpath ${quoted(root)})`).join(" ")})))`;
	const closedToWrites = policy.asksNothing ? (root: string) => atAnyDepth(root, CLOSED_TO_WRITES_ASKING_NOTHING) : closedPatterns;
	return {
		filesystem: {
			denyRead: [...broad, ...always].map(literal),
			allowRead: opened.map(literal),
			allowWrite: writable.map(literal),
			denyWrite: [...writable.flatMap(closedToWrites), ...LIBRARY_DEFAULT_TEMP.map(literal)],
		},
		profileRules: [...reads, writes, "(deny network*)", "(deny process-info* (target others))"].join("\n"),
	};
}

// Names of a person's own that a command may keep. Everything else is out: the
// server's whole environment holds its token and whatever keys were exported.
const KEPT_VARIABLES = new Set(["PATH", "HOME", "USER", "LOGNAME", "LANG", "TERM", "TZ", "__CF_USER_TEXT_ENCODING"]);

/** A boxed command's environment, built from the short list and never inherited. */
export function boxEnvironment(base: NodeJS.ProcessEnv, places: BoxPlaces): NodeJS.ProcessEnv {
	const kept = Object.fromEntries(Object.entries(base).filter(([name]) => KEPT_VARIABLES.has(name) || name.startsWith("LC_")));
	const cache = (name: string) => path.join(places.caches, name);
	return {
		...kept,
		// The shim first, so `mktemp` keeps to the private temp. The developer tools' own folder next, so Apple's launchers don't reach for the shared temp.
		PATH: [places.shim, "/Library/Developer/CommandLineTools/usr/bin", base.PATH].filter(Boolean).join(":"),
		SHELL: "/bin/bash",
		NODE_USE_ENV_PROXY: "1",
		GIT_TEMPLATE_DIR: places.gitTemplate,
		GIT_TERMINAL_PROMPT: "0",
		// Git's keychain helper fails on every network command in the box.
		GIT_CONFIG_COUNT: "1",
		GIT_CONFIG_KEY_0: "credential.helper",
		GIT_CONFIG_VALUE_0: "",
		XDG_CACHE_HOME: cache("xdg"),
		npm_config_cache: cache("npm"),
		npm_config_store_dir: cache("pnpm"),
		YARN_CACHE_FOLDER: cache("yarn"),
		PIP_CACHE_DIR: cache("pip"),
		// Where pip installs when the system's Python can't be written, and where Python finds it: kept for the room, so a library is installed once.
		PYTHONUSERBASE: cache("python"),
		// A Python that calls itself externally managed refuses that install otherwise. Safe here: a boxed command can't write the system's Python, so the install goes into the room's caches.
		PIP_BREAK_SYSTEM_PACKAGES: "1",
		UV_CACHE_DIR: cache("uv"),
		GOCACHE: cache("go-build"),
		GOMODCACHE: cache("go-mod"),
		CARGO_HOME: cache("cargo"),
	};
}

/**
 * Mac's `mktemp` with no template ignores TMPDIR and uses the shared temp, which
 * the box closes. This one comes first on PATH and gives it a template. The
 * system's own by its full path fails, which is safe.
 */
export const MKTEMP_SHIM = `#!/bin/sh
dir= prefix=tmp template=
while [ $# -gt 0 ]; do
  case "$1" in
    -d) dir=-d ;;
    -q|-u) ;;
    -t) shift; prefix="$1" ;;
    *) template="$1" ;;
  esac
  shift
done
[ -n "$template" ] && exec /usr/bin/mktemp $dir "$template"
exec /usr/bin/mktemp $dir "$TMPDIR/$prefix.XXXXXXXX"
`;
