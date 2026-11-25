/**
 * Skills MR-1 canonical store (spec §1). The web library (`/api/skills`) writes
 * the SAME user store the Pi loader reads — `~/.exxperts/agent/skills` — so a
 * skill imported in the web UI is visible to the CLI and vice versa. The dir is
 * resolved through the loader's own `getAgentDir()` (honours PI_CODING_AGENT_DIR),
 * so the two never drift.
 *
 * This module also owns the per-skill provenance sidecar, the sha256 of a
 * SKILL.md it records, and the listing of a skill's files. Server-side only.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getAgentDir } from "@exxeta/exxperts-runtime";
import { stateHome } from "../../../pi-package/product-state-paths.js";

/** The canonical user skills store — the Pi loader's user dir. */
export function agentSkillsDir(): string {
	return path.join(getAgentDir(), "skills");
}

/**
 * The cross-tool shared skills directory (`~/.agents/skills`), the ecosystem
 * convention for skills every compliant agent on the machine can see. exxperts
 * READS it (skills list in the library with a "shared" origin) but never writes
 * into it: no edits, no deletes, no provenance sidecars — other tools own it.
 * A skill from it opens to a room at its real folder, after every link, where
 * rooms may open that and its way enters none of the room's own folders
 * (`roomSkillPlaces`, skills-executable.ts).
 */
export function sharedAgentsSkillsDir(): string {
	return path.join(os.homedir(), ".agents", "skills");
}

/**
 * The pre-unification web store (`~/.exxperts/app/skills`). It had no UI, so
 * real-world content is unlikely, but any skills there are migrated on boot into
 * the canonical store (see `migrateLegacyUserSkills`).
 */
export function legacyUserSkillsDir(): string {
	return path.join(stateHome(), ".exxperts", "app", "skills");
}

/**
 * sha256 hex digest of the UTF-8 bytes of `body`: the provenance sidecar records
 * a skill's, and `read_skill` names the one it serves.
 */
export function sha256(body: string): string {
	return crypto.createHash("sha256").update(String(body ?? ""), "utf8").digest("hex");
}

/** Not there, as opposed to there but not readable. */
export function isAbsent(error: unknown): boolean {
	const code = (error as NodeJS.ErrnoException)?.code;
	return code === "ENOENT" || code === "ENOTDIR";
}

/** A skill's file that is there but isn't a plain file of its own (`readSkillFileText`). */
export class NotPlainSkillFileError extends Error {}

/**
 * Whether a skill's file read or write was refused because the file isn't a plain
 * file of its own, a link included (ELOOP, where O_NOFOLLOW meets one), or is gone.
 */
export function isNotPlainOrAbsent(error: unknown): boolean {
	return error instanceof NotPlainSkillFileError || (error as NodeJS.ErrnoException)?.code === "ELOOP" || isAbsent(error);
}

/**
 * A file directly in a skill's folder, as text: only a plain file that no link
 * leads to and no hard link shares, so a folder a room's command can write never
 * hands the server another file's bytes. A link, a hard link or any other kind
 * of entry throws an error that is not ENOENT: unreadable, never absent.
 */
export function readSkillFileText(skillDir: string, name: string): string {
	const file = path.join(skillDir, name);
	const refused = (): Error => new NotPlainSkillFileError(`${file} is not a plain file of its own`);
	const seen = fs.lstatSync(file);
	if (!seen.isFile() || seen.nlink !== 1) throw refused();
	// No wait on a named pipe put there since the lstat: the fstat below refuses it.
	const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0));
	try {
		// The entry seen above, not one put there since.
		const opened = fs.fstatSync(fd);
		if (!opened.isFile() || opened.nlink !== 1 || opened.ino !== seen.ino || opened.dev !== seen.dev) throw refused();
		return fs.readFileSync(fd, "utf-8");
	} finally {
		fs.closeSync(fd);
	}
}

/**
 * Writes over a file directly in a skill's folder, only when it is a plain file
 * of its own (`readSkillFileText`'s rule): never through a link, nor into a file
 * a hard link shares. Anything else throws and nothing is written. The text goes
 * to a temporary file beside the skill's folder, never in it (a cut would leave
 * it among the skill's files, opened to its rooms), and beside where the folder
 * really is, so a linked folder on another disk is still one disk; renamed over the file: a cut
 * leaves the old text or the new one, never an empty file, and a rename replaces
 * the entry, never writing through it.
 */
export function writeSkillFileText(skillDir: string, name: string, text: string): void {
	const file = path.join(skillDir, name);
	const refused = (): Error => new NotPlainSkillFileError(`${file} is not a plain file of its own`);
	const seen = fs.lstatSync(file);
	if (!seen.isFile() || seen.nlink !== 1) throw refused();
	// A file made read-only keeps its refusal, as a write in place would meet it: the rename alone would pass it by.
	fs.accessSync(file, fs.constants.W_OK);
	const realDir = fs.realpathSync(skillDir);
	const temp = path.join(path.dirname(realDir), `.${path.basename(realDir)}.${name}.${crypto.randomUUID()}.tmp`);
	try {
		fs.writeFileSync(temp, text, { mode: 0o600, flag: "wx" });
		fs.renameSync(temp, file);
	} catch (error) {
		fs.rmSync(temp, { force: true });
		throw error;
	}
}

/**
 * A skill's files, by posix-style path from its folder in codepoint order,
 * SKILL.md included and the provenance sidecar left out. Only plain files are
 * listed: a link or another special entry is never followed or named. Null
 * when the folder has no SKILL.md, or any folder in it can't be listed: a list
 * of what could be read would name less than is there.
 */
export function listSkillFiles(skillDir: string): string[] | null {
	const root = path.resolve(skillDir);
	if (!fs.existsSync(path.join(root, "SKILL.md"))) return null;
	const files: string[] = [];
	const walk = (dir: string): void => {
		for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
			const abs = path.join(dir, entry.name);
			const rel = path.relative(root, abs).split(path.sep).join("/");
			if (entry.isDirectory()) walk(abs);
			else if (entry.isFile() && rel !== SKILL_PROVENANCE_FILENAME) files.push(rel);
		}
	};
	try {
		walk(root);
	} catch {
		return null;
	}
	// Codepoint order, NOT localeCompare: the same on every machine.
	return files.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/**
 * How many files a skill's folder holds beside SKILL.md, counted as
 * `listSkillFiles` lists them, and only to one past `limit`: each folder's files
 * are counted before any folder in it is opened, and the walk stops there, so a
 * folder of any size costs no more than that. Null when a folder it opens can't
 * be read.
 */
export function countSkillFiles(skillDir: string, limit: number): number | null {
	const root = path.resolve(skillDir);
	const left = [root];
	let count = 0;
	try {
		for (let dir = left.pop(); dir !== undefined; dir = left.pop()) {
			const entries = fs.opendirSync(dir);
			try {
				for (let entry = entries.readSync(); entry !== null; entry = entries.readSync()) {
					if (entry.isDirectory()) left.push(path.join(dir, entry.name));
					else if (entry.isFile() && !(dir === root && (entry.name === "SKILL.md" || entry.name === SKILL_PROVENANCE_FILENAME)) && ++count > limit) return count;
				}
			} finally {
				entries.closeSync();
			}
		}
	} catch {
		return null;
	}
	return count;
}

export interface SkillProvenance {
	/** Where the skill came from: `"local"` for a hand-written (API) skill; a git/URL
	 *  reference for imports (MR-4). */
	source: string;
	/** ISO-8601 timestamp of import/creation. */
	importedAt: string;
	/** SPDX-ish license string, or null when unknown. */
	license: string | null;
	/** sha256 of the SKILL.md body (see `sha256`). */
	sha256: string;
	/** Which added skill this is, made only when a skill is added (`reserveSkillIdentity`)
	 *  and kept by every edit. A room switches on a skill by name AND identity, so a
	 *  skill deleted and added again under its name is not the one a room had on.
	 *  Absent on records written before it existed: that skill's identity is none. */
	identity?: string;
	/** Where a skill added from a repository came from and which of its versions it holds;
	 *  written by that add and by an update, kept by an edit. Absent on a skill added
	 *  any other way, and on one added from a repository before it existed. */
	repository?: SkillRepository;
	/** The person's "Update automatically" switch, for a skill that follows a branch or a
	 *  tag of its repository; absent is off. Beside `repository`, never in it: a check
	 *  binds to the repository and writes it back as it read it. Kept by an edit, an
	 *  update and a Replace from the same repository; a delete takes it with the folder. */
	autoUpdate?: true;
}

/** How the ref a skill was added from moves: the default branch's latest commit, a branch's, a tag (wherever it points), or one commit, which never moves. */
export type SkillRefKind = "default" | "branch" | "tag" | "commit";

/** A skill's repository, as its record keeps it. */
export interface SkillRepository {
	/** The address to reach it again: never a password, a token or an HTTPS user name; an SSH address keeps its login. */
	address: string;
	/** The `#branch`, `#tag` or `#commit` of the address it was added from; absent for the default branch. */
	ref?: string;
	refKind: SkillRefKind;
	/** The skill's folder inside the repository, "" for a SKILL.md at its root. */
	path: string;
	/** The commit its files are from. */
	commit: string;
	/** `skillFilesSha256` of the files it was given, so a change made on this computer shows. */
	filesSha256: string;
}

export const SKILL_PROVENANCE_FILENAME = "provenance.json";

/** Files an operating system writes into a folder by itself when it is opened: never a change by the person. */
const SYSTEM_FILE_RE = /(^|\/)(\.DS_Store|\._[^/]*|Thumbs\.db|desktop\.ini)$/i;
export const isSystemFile = (file: string): boolean => SYSTEM_FILE_RE.test(file);

/**
 * One hash over a skill's files: each in code point order, its posix path, a NUL,
 * its size, a NUL, then its bytes. `files` are relative to `dir`; the import record
 * is never among them, and neither are the files a system writes by itself. The
 * same files give the same hash in the store and in a repository's checkout.
 */
export function skillFilesSha256(dir: string, files: readonly string[]): string {
	const hash = crypto.createHash("sha256");
	for (const file of [...files].filter((file) => !isSystemFile(file)).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))) {
		const bytes = fs.readFileSync(path.join(dir, file));
		hash.update(`${file}\0${bytes.length}\0`);
		hash.update(bytes);
	}
	return hash.digest("hex");
}

/** The files' hash of an installed skill (`listSkillFiles`), or null when its folder can't be listed or read whole. */
export function installedSkillFilesSha256(skillDir: string): string | null {
	const files = listSkillFiles(skillDir);
	if (!files) return null;
	try {
		return skillFilesSha256(skillDir, files);
	} catch {
		return null;
	}
}

/** Provenance for a hand-written (API POST/PUT) skill — `source: "local"`, unknown
 *  license. `fingerprintSource` is the whole SKILL.md manifest. */
export function localSkillProvenance(fingerprintSource: string): SkillProvenance {
	return { source: "local", importedAt: new Date().toISOString(), license: null, sha256: sha256(fingerprintSource) };
}

/** Write `provenance.json` next to a skill's SKILL.md (0o600, like the SKILL.md itself). */
export function writeSkillProvenance(skillDir: string, provenance: SkillProvenance): void {
	writeRecordWhole(skillDir, `${JSON.stringify(provenance, null, 2)}\n`);
}

/**
 * Writes a skill's record whole or not at all: a temporary file, then a rename, so
 * a cut or a full disk leaves the record as it was. A record that doesn't parse
 * makes the skill unreadable in every room, and an edit leaves it alone. The
 * temporary file sits in the store beside the skill's folder, never inside it,
 * where a leftover one would count among the skill's files. A skill folder that
 * links to another disk can't take a rename from the store, so its record is
 * written in place, as before.
 */
function writeRecordWhole(skillDir: string, text: string): void {
	const record = path.join(skillDir, SKILL_PROVENANCE_FILENAME);
	const temp = path.join(path.dirname(skillDir), `.${path.basename(skillDir)}.${SKILL_PROVENANCE_FILENAME}.${crypto.randomUUID()}.tmp`);
	try {
		fs.writeFileSync(temp, text, { mode: 0o600, flag: "wx" });
		fs.renameSync(temp, record);
	} catch (error) {
		fs.rmSync(temp, { force: true });
		if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error;
		fs.writeFileSync(record, text, { mode: 0o600 });
	}
}

/** The longest skill id; `fitSkillName` in skills-repo-fetch.ts cuts a name to it. */
export const SKILL_ID_MAX_LENGTH = 48;

/** A name the library takes as a skill's id as it is: lowercase letters and numbers, in parts joined by single hyphens, at most `SKILL_ID_MAX_LENGTH` long. */
export function isSkillId(name: string): boolean {
	return name.length <= SKILL_ID_MAX_LENGTH && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name);
}

/** A well-formed skill identity, as `reserveSkillIdentity` makes it. */
export const SKILL_IDENTITY_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * A fresh identity for a skill being added, written into its folder's record
 * BEFORE its SKILL.md: a skill seen without a record reads as added before
 * identities, which an old room entry of its name would match, so an add cut
 * halfway must never leave one. The add writes the full record last, with this
 * identity. An edit never makes one.
 */
export function reserveSkillIdentity(skillDir: string): string {
	const identity = crypto.randomUUID();
	fs.mkdirSync(skillDir, { recursive: true, mode: 0o700 });
	writeRecordWhole(skillDir, `${JSON.stringify({ identity })}\n`);
	return identity;
}

/**
 * A skill's identity as its record holds it: null for none (no record, or one
 * written before identities), "unreadable" when the record is there but can't be
 * read or parsed, or holds an identity that isn't well formed. A failed read is
 * never none: none matches a room's entry made before identities.
 */
export function readSkillIdentity(skillDir: string): string | null | "unreadable" {
	let text: string;
	try {
		text = readSkillFileText(skillDir, SKILL_PROVENANCE_FILENAME);
	} catch (error) {
		return (error as NodeJS.ErrnoException)?.code === "ENOENT" ? null : "unreadable";
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return "unreadable";
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return "unreadable";
	const identity = (parsed as { identity?: unknown }).identity;
	if (identity === undefined) return null;
	return typeof identity === "string" && SKILL_IDENTITY_RE.test(identity) ? identity : "unreadable";
}

/** Read a skill's provenance sidecar, or null when absent/corrupt (never throws). */
export function readSkillProvenance(skillDir: string): SkillProvenance | null {
	try {
		const parsed = JSON.parse(readSkillFileText(skillDir, SKILL_PROVENANCE_FILENAME));
		if (parsed && typeof parsed.source === "string" && typeof parsed.sha256 === "string") return parsed as SkillProvenance;
	} catch {}
	return null;
}

/** Where a replace builds a skill's new folder: beside the store, so the swap is a
 *  rename on the same disk and nothing reads it as a skill meanwhile. */
const REPLACE_PREFIX = ".skill-replace-";

/**
 * Where a replace stages its folders: beside the store's real folder, so the two
 * renames stay on one disk when the skills folder is a link to another one.
 */
function replaceStagingParent(store: string): string {
	try {
		return path.dirname(fs.realpathSync(store));
	} catch {
		return path.dirname(store);
	}
}

/**
 * Replaces the folder of the user skill `id` whole: `fill` writes the new one in
 * a folder beside the store, then two renames swap it in. Any failure before or
 * in the swap leaves the old folder in place, as it was. A replace cut between
 * the two renames (the server stopped there) leaves the old folder beside the
 * store; the next start puts it back (`restoreCutReplaces`).
 */
export function replaceSkillDir(id: string, fill: (dir: string) => void): void {
	const store = agentSkillsDir();
	const parent = replaceStagingParent(store);
	restoreCutReplaces();
	const target = path.join(store, id);
	const staging = fs.mkdtempSync(path.join(parent, `${REPLACE_PREFIX}${id}-`));
	const fresh = path.join(staging, "new");
	const old = path.join(staging, "old");
	// Set when the old folder could not be put back: it stays beside the store for `restoreCutReplaces`.
	let oldStranded = false;
	try {
		fs.mkdirSync(fresh, { mode: 0o700 });
		fill(fresh);
		fs.renameSync(target, old);
		try {
			fs.renameSync(fresh, target);
		} catch (error) {
			try {
				fs.renameSync(old, target);
			} catch {
				oldStranded = true;
			}
			throw error;
		}
	} finally {
		if (!oldStranded) {
			try {
				fs.rmSync(staging, { recursive: true, force: true });
			} catch {
				// What is left is cleared by `restoreCutReplaces`; the swap itself is done or undone.
			}
		}
	}
}

/**
 * Puts back an old folder a replace cut halfway left beside the store, where its
 * place is empty, and clears what is left of each replace; one whose place is
 * taken is kept as it is. A replace runs
 * start to end without a pause, so at the server's start (`minAgeMs` 0) every one
 * found was cut; later, one younger than `minAgeMs` may be another server's at work.
 */
export function restoreCutReplaces(minAgeMs = 60_000): void {
	const store = agentSkillsDir();
	const parent = replaceStagingParent(store);
	let names: string[];
	try { names = fs.readdirSync(parent); } catch { return; }
	for (const name of names) {
		if (!name.startsWith(REPLACE_PREFIX)) continue;
		const staging = path.join(parent, name);
		try {
			// A younger one may be another replace at work.
			if (Date.now() - fs.statSync(staging).mtimeMs < minAgeMs) continue;
			const id = name.slice(REPLACE_PREFIX.length, name.lastIndexOf("-"));
			const old = path.join(staging, "old");
			// Only a swap that never finished still holds its new folder; after one that did, the old folder is spent.
			if (id && fs.existsSync(old) && fs.existsSync(path.join(staging, "new"))) {
				// A skill added under its name since holds the place: the old one is kept here, never deleted, until the place is free.
				if (fs.existsSync(path.join(store, id))) continue;
				fs.renameSync(old, path.join(store, id));
			}
			fs.rmSync(staging, { recursive: true, force: true });
		} catch {
			// Left for the next one.
		}
	}
}

/**
 * Recursively remove a skill directory — but ONLY when it is a direct child of
 * the canonical user store and actually holds a `SKILL.md`. Repo-imported skills
 * (MR-4) may bundle asset files next to their SKILL.md, so the delete path can no
 * longer assume a two-file dir (unlink SKILL.md + provenance then rmdir, which
 * silently fails on a non-empty dir). The two guards keep this from ever touching
 * a path outside the managed store. Returns false (no-op) when the guards fail.
 */
export function removeManagedSkillDir(skillDir: string): boolean {
	const store = path.resolve(agentSkillsDir());
	const resolved = path.resolve(skillDir);
	// Must be an immediate `<store>/<id>` directory containing a real SKILL.md —
	// never the store root, a nested path, or anything outside the store.
	if (path.dirname(resolved) !== store) return false;
	if (!fs.existsSync(path.join(resolved, "SKILL.md"))) return false;
	fs.rmSync(resolved, { recursive: true, force: true });
	return true;
}

export interface SkillsMigrationResult {
	/** Names moved into the canonical store. */
	moved: string[];
	/** Names left in the legacy store because a canonical skill of that name already exists. */
	skipped: string[];
}

/**
 * Move-on-boot migration (spec §1): relocate skill dirs from the pre-unification
 * web store into the canonical loader store. Never overwrites — on a name
 * collision the canonical skill wins, the legacy copy is left in place, and a
 * warning is logged. Idempotent: after a clean move the legacy store holds no
 * skill dirs, so subsequent boots are no-ops. Non-skill files and the empty
 * legacy dir are left untouched (the product-state bootstrap recreates it).
 */
export function migrateLegacyUserSkills(log?: (message: string) => void): SkillsMigrationResult {
	const result: SkillsMigrationResult = { moved: [], skipped: [] };
	const from = legacyUserSkillsDir();
	const to = agentSkillsDir();
	if (path.resolve(from) === path.resolve(to)) return result;

	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(from, { withFileTypes: true });
	} catch {
		return result; // no legacy store → nothing to migrate
	}

	for (const entry of entries) {
		if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
		const src = path.join(from, entry.name);
		// Only migrate real skill dirs — a bare SKILL.md marks the store's own unit.
		if (!fs.existsSync(path.join(src, "SKILL.md"))) continue;
		const dst = path.join(to, entry.name);
		if (fs.existsSync(dst)) {
			result.skipped.push(entry.name);
			log?.(`skills migration: canonical skill "${entry.name}" already exists — keeping canonical, leaving the legacy copy at ${src}`);
			continue;
		}
		fs.mkdirSync(to, { recursive: true, mode: 0o700 });
		try {
			fs.renameSync(src, dst);
		} catch (err) {
			// Cross-device (e.g. HOME on a different mount than the agent dir): copy+remove.
			if ((err as NodeJS.ErrnoException)?.code === "EXDEV") {
				fs.cpSync(src, dst, { recursive: true });
				fs.rmSync(src, { recursive: true, force: true });
			} else {
				throw err;
			}
		}
		result.moved.push(entry.name);
		log?.(`skills migration: moved "${entry.name}" from ${from} into the canonical store ${to}`);
	}
	return result;
}
