/**
 * Skills MR-1 canonical store (spec §1). The web library (`/api/skills`) writes
 * the SAME user store the Pi loader reads — `~/.exxperts/agent/skills` — so a
 * skill imported in the web UI is visible to the CLI and vice versa. The dir is
 * resolved through the loader's own `getAgentDir()` (honours PI_CODING_AGENT_DIR),
 * so the two never drift.
 *
 * This module also owns the per-skill provenance sidecar and the sha256
 * fingerprint the later MRs pin against (enablement pins the hash; a changed hash
 * forces re-review — rug-pull protection, spec §0/§2/§7). Server-side only.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getAgentDir } from "@exxeta/exxperts-runtime";
import { stateHome } from "../../../pi-package/product-state-paths.js";
import { normalizeRepoPath, normalizeRepositoryFilePolicy, referenceLocalPath, referencePathPermission, repositoryPathWithin, validatedReferenceText, type ReferenceKind, type RepositoryFilePolicy } from "./skills-file-policy.js";

/** The canonical user skills store — the Pi loader's user dir. */
export function agentSkillsDir(): string {
	return path.join(getAgentDir(), "skills");
}

/**
 * The cross-tool shared skills directory (`~/.agents/skills`), the ecosystem
 * convention for skills every compliant agent on the machine can see. exxperts
 * READS it (skills list in the library with a "shared" origin) but never writes
 * into it: no edits, no deletes, no provenance sidecars — other tools own it.
 * Trust is unaffected by the extra root: enablement still pins the manifest
 * hash per room, so a shared skill changing on disk trips re-review.
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
 * sha256 hex digest of the UTF-8 bytes of `body`. This is the skill fingerprint:
 * the provenance sidecar records it, enablement pins it, and `read_skill` (MR-5)
 * re-derives it to detect a changed body. Exported for those later MRs.
 */
export function sha256(body: string): string {
	return crypto.createHash("sha256").update(String(body ?? ""), "utf8").digest("hex");
}

export interface SkillFilesDigestEntry {
	/** Posix-style path relative to the skill dir. */
	path: string;
	/** sha256 hex of the file's bytes. */
	sha256: string;
}

export interface SkillFilesDigest {
	/** Digest over every file's path+hash — the unit execution approval pins. */
	filesSha256: string;
	files: SkillFilesDigestEntry[];
}

/**
 * Digest of a skill's ENTIRE on-disk content: SKILL.md plus every bundled file,
 * hashed by bytes, keyed by relative path, in sorted order. This is the unit an
 * execution approval pins: any file added, removed, renamed or edited changes
 * the digest and voids the approval. The provenance sidecar is excluded (it is
 * the app's bookkeeping, not the skill's content), as are symlinks (never
 * followed — a symlink cannot smuggle content from outside the dir into an
 * approved digest). Returns null when the dir has no SKILL.md.
 */
export function computeSkillFilesDigest(skillDir: string): SkillFilesDigest | null {
	const root = path.resolve(skillDir);
	if (!fs.existsSync(path.join(root, "SKILL.md"))) return null;
	const files: SkillFilesDigestEntry[] = [];
	// Non-regular entries (symlinks, fifos, sockets) carry no hashable content,
	// but their APPEARANCE must still void an approval: a symlink added after
	// approval points the exposed dir at bytes the digest never covered. They
	// are folded into the digest as their own records, not silently skipped.
	const specials: string[] = [];
	const walk = (dir: string): void => {
		let entries: fs.Dirent[];
		try {
			entries = fs.readdirSync(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			const abs = path.join(dir, entry.name);
			const rel = path.relative(root, abs).split(path.sep).join("/");
			if (entry.isSymbolicLink()) {
				let target = "";
				try { target = fs.readlinkSync(abs); } catch {}
				specials.push(`${JSON.stringify(rel)} symlink ${JSON.stringify(target)}`);
				continue;
			}
			if (entry.isDirectory()) {
				walk(abs);
				continue;
			}
			if (!entry.isFile()) {
				specials.push(`${JSON.stringify(rel)} special`);
				continue;
			}
			if (rel === SKILL_PROVENANCE_FILENAME) continue;
			files.push({ path: rel, sha256: crypto.createHash("sha256").update(fs.readFileSync(abs)).digest("hex") });
		}
	};
	walk(root);
	// Codepoint order, NOT localeCompare: the digest must be byte-identical for
	// the same content on every machine, and locale collation is not.
	files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
	specials.sort();
	// Paths are JSON-encoded in the manifest so a filename containing a newline
	// cannot make two different trees serialize identically (the entry joiner
	// is itself a newline; a raw path could forge entry boundaries).
	const manifest = files.map((f) => `${JSON.stringify(f.path)}\n${f.sha256}\n`).join("") + specials.map((s) => `${s}\n`).join("");
	return { filesSha256: sha256(manifest), files };
}

export interface SkillProvenance {
	/** Where the skill came from: `"local"` for a hand-written (API) skill; a git/URL
	 *  reference for imports (MR-4). */
	source: string;
	/** ISO-8601 timestamp of import/creation. */
	importedAt: string;
	/** SPDX-ish license string, or null when unknown (surfaced as a warning at review). */
	license: string | null;
	/** sha256 of the SKILL.md body (see `sha256`). */
	sha256: string;
	/** Whole-content digest (SKILL.md + every bundled file) at write time — see
	 *  `computeSkillFilesDigest`. Stamped by `writeSkillProvenance`; older
	 *  sidecars lack it, and execution recomputes from disk anyway. */
	filesSha256?: string;
	/** A locally edited legacy import retains its original source and license. */
	locallyModified?: boolean;
	/** A reviewed repository snapshot; absent on legacy and manually created skills. */
	repo?: SkillRepoProvenance;
}

export type SkillReferenceKind = ReferenceKind;

export interface SkillReferenceEntry {
	/** Original repository-relative path, used by the reference reader. */
	path: string;
	/** Relative path inside this skill's installed package. */
	localPath: string;
	kind: SkillReferenceKind;
	size: number;
	sha256: string;
}

export interface SkillRepoProvenance {
	libraryId?: string;
	source: string;
	ref?: string;
	revision: string;
	skillPath: string;
	policy: RepositoryFilePolicy;
	references: SkillReferenceEntry[];
}

export interface ManagedSkillPackage {
	repo: SkillRepoProvenance;
	manifest: string;
	packageSha256: string;
	references: SkillReferenceEntry[];
	/** The same bounded bytes whose hashes form packageSha256. Never expose this map in JSON. */
	referenceBytes: ReadonlyMap<string, Buffer>;
}

/** Read regular, bounded package files without following links outside the package. */
function readPackageFile(root: string, relativePath: string, maxBytes: number): Buffer {
	const relative = normalizeRepoPath(relativePath);
	let current = root;
	for (const segment of relative.split("/")) {
		current = path.join(current, segment);
		if (fs.lstatSync(current).isSymbolicLink()) throw new Error("Skill package contains a symbolic link; re-import the reviewed package.");
	}
	const absolute = path.resolve(root, ...relative.split("/"));
	const descriptor = fs.openSync(absolute, "r");
	try {
		const stat = fs.fstatSync(descriptor);
		if (!stat.isFile() || stat.size > maxBytes) throw new Error("Skill package file is not regular or exceeds its size limit.");
		const real = fs.realpathSync(absolute);
		if (path.relative(root, real) !== path.relative(root, absolute)) throw new Error("Skill package path changed or escapes its directory.");
		const bytes = fs.readFileSync(descriptor);
		if (bytes.length > maxBytes || bytes.length !== stat.size) throw new Error("Skill package file changed while reading.");
		return bytes;
	} finally {
		fs.closeSync(descriptor);
	}
}

/**
 * Read one managed package snapshot. Hash bytes AND the path/policy mapping:
 * editing only a reference or its provenance must require a new room review.
 * Legacy packages return null; malformed or altered managed packages fail closed.
 */
export function readManagedSkillPackage(skillDir: string): ManagedSkillPackage | null {
	const directory = path.resolve(skillDir);
	if (fs.lstatSync(directory).isSymbolicLink()) throw new Error("Managed skill directories cannot be symbolic links.");
	// Resolve parent aliases (macOS /var -> /private/var) before checking package-relative paths.
	const root = fs.realpathSync(directory);
	const sidecar = path.join(root, SKILL_PROVENANCE_FILENAME);
	if (!fs.existsSync(sidecar)) return null;
	const raw = JSON.parse(readPackageFile(root, SKILL_PROVENANCE_FILENAME, 512 * 1024).toString("utf8"));
	if (!raw?.repo) return null;
	const input = raw.repo;
	if (typeof input.source !== "string" || typeof input.revision !== "string" || !/^[0-9a-f]{40,64}$/.test(input.revision)) throw new Error("Invalid managed skill source or revision.");
	if ((input.libraryId !== undefined && typeof input.libraryId !== "string") || (input.ref !== undefined && typeof input.ref !== "string")) throw new Error("Invalid managed skill source metadata.");
	const skillPath = normalizeRepoPath(input.skillPath, true);
	const policy = normalizeRepositoryFilePolicy(input.policy);
	if (policy.skillRoot && skillPath !== policy.skillRoot && !repositoryPathWithin(skillPath, policy.skillRoot)) throw new Error("Managed skill lies outside its library's skill directory.");
	if (!Array.isArray(input.references) || input.references.length > 499) throw new Error("Invalid managed skill reference list.");
	const references: SkillReferenceEntry[] = [];
	const sourcePaths = new Set<string>();
	const localPaths = new Set<string>(["skill.md", SKILL_PROVENANCE_FILENAME]);
	const referenceBytes = new Map<string, Buffer>();
	const manifestBytes = readPackageFile(root, "SKILL.md", 512 * 1024);
	const manifest = validatedReferenceText(manifestBytes);
	let totalBytes = manifestBytes.length;
	for (const ref of input.references) {
		const originalPath = normalizeRepoPath(ref?.path);
		const localPath = normalizeRepoPath(ref?.localPath);
		const permission = referencePathPermission(originalPath, policy);
		if (!permission.allowed || permission.kind !== ref.kind || !Number.isSafeInteger(ref.size) || ref.size < 0 || ref.size > 25 * 1024 * 1024 || !/^[0-9a-f]{64}$/.test(ref.sha256)) throw new Error("Invalid managed skill reference or file policy.");
		if ((!repositoryPathWithin(originalPath, skillPath) && !policy.referenceRoots.some((area) => repositoryPathWithin(originalPath, area))) || localPath !== referenceLocalPath(originalPath, skillPath)) throw new Error("Reference path lies outside its selected directories or has an invalid local mapping.");
		if (sourcePaths.has(originalPath.toLowerCase()) || localPaths.has(localPath.toLowerCase())) throw new Error("Managed skill contains colliding reference paths.");
		sourcePaths.add(originalPath.toLowerCase());
		localPaths.add(localPath.toLowerCase());
		const bytes = readPackageFile(root, localPath, 25 * 1024 * 1024);
		totalBytes += bytes.length;
		if (totalBytes > 64 * 1024 * 1024) throw new Error("Managed skill exceeds the package size limit.");
		const entry: SkillReferenceEntry = { path: originalPath, localPath, kind: ref.kind, size: ref.size, sha256: ref.sha256 };
		references.push(entry);
		referenceBytes.set(originalPath, bytes);
	}
	// Files absent from the selection are never read; their appearance still closes the package gate.
	let fileCount = 0;
	let directoryCount = 0;
	const walk = (dir: string): void => {
		if (++directoryCount > 2000 || path.relative(root, dir).split(path.sep).length > 50) throw new Error("Managed skill contains too many nested directories.");
		for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
			const absolute = path.join(dir, entry.name);
			const relative = path.relative(root, absolute).split(path.sep).join("/");
			if (entry.isSymbolicLink() || (!entry.isDirectory() && !entry.isFile())) throw new Error("Managed skill contains a non-regular entry.");
			if (entry.isDirectory()) { walk(absolute); continue; }
			fileCount += 1;
			if (fileCount > 501 || !localPaths.has(relative.toLowerCase())) throw new Error("Managed skill contains files outside the reviewed selection.");
		}
	};
	walk(root);
	references.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
	const repo: SkillRepoProvenance = {
		...(input.libraryId !== undefined ? { libraryId: input.libraryId } : {}),
		source: input.source,
		...(input.ref !== undefined ? { ref: input.ref } : {}),
		revision: input.revision,
		skillPath,
		policy: { ...policy, allowedTypes: [...policy.allowedTypes].sort(), referenceRoots: [...policy.referenceRoots].sort() },
		references,
	};
	const content = [{ path: "SKILL.md", sha256: crypto.createHash("sha256").update(manifestBytes).digest("hex") }, ...references.map((ref) => ({ path: ref.localPath, sha256: crypto.createHash("sha256").update(referenceBytes.get(ref.path)!).digest("hex") }))];
	return { repo, manifest, references, referenceBytes, packageSha256: sha256(JSON.stringify({ repo, content })) };
}

export function computeManagedSkillPackageDigest(skillDir: string): string | null {
	return readManagedSkillPackage(skillDir)?.packageSha256 ?? null;
}

/** Advisory badges only: hashes declared in provenance never authorize a read or room update. */
export function skillPackageDisplayPin(skillDir: string): { sha256: string; packageSha256: string } | null {
	const input = readSkillProvenance(skillDir)?.repo;
	if (!input) return null;
	const manifestHash = sha256(fs.readFileSync(path.join(skillDir, "SKILL.md"), "utf8"));
	const references = input.references.map((ref) => ({ path: ref.path, localPath: ref.localPath, kind: ref.kind, size: ref.size, sha256: ref.sha256 })).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
	const policy = normalizeRepositoryFilePolicy(input.policy);
	const repo = { ...(input.libraryId !== undefined ? { libraryId: input.libraryId } : {}), source: input.source, ...(input.ref !== undefined ? { ref: input.ref } : {}), revision: input.revision, skillPath: input.skillPath, policy: { ...policy, allowedTypes: [...policy.allowedTypes].sort(), referenceRoots: [...policy.referenceRoots].sort() }, references };
	const content = [{ path: "SKILL.md", sha256: manifestHash }, ...references.map((ref) => ({ path: ref.localPath, sha256: ref.sha256 }))];
	return { sha256: manifestHash, packageSha256: sha256(JSON.stringify({ repo, content })) };
}

export const SKILL_PROVENANCE_FILENAME = "provenance.json";

/** Provenance for a hand-written (API POST/PUT) skill — `source: "local"`, unknown
 *  license. `fingerprintSource` is the whole SKILL.md manifest, so a description or
 *  body edit changes the hash and forces re-review. */
export function localSkillProvenance(fingerprintSource: string): SkillProvenance {
	return { source: "local", importedAt: new Date().toISOString(), license: null, sha256: sha256(fingerprintSource) };
}

/** Write `provenance.json` next to a skill's SKILL.md (0o600, like the SKILL.md
 *  itself), stamping the whole-content files digest of whatever is on disk at
 *  this moment — callers therefore write provenance LAST, after any bundled
 *  files have landed. */
export function writeSkillProvenance(skillDir: string, provenance: SkillProvenance): void {
	const digest = computeSkillFilesDigest(skillDir);
	const payload: SkillProvenance = digest ? { ...provenance, filesSha256: digest.filesSha256 } : provenance;
	fs.writeFileSync(path.join(skillDir, SKILL_PROVENANCE_FILENAME), `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
}

/** Read a skill's provenance sidecar, or null when absent/corrupt (never throws). */
export function readSkillProvenance(skillDir: string): SkillProvenance | null {
	try {
		const parsed = JSON.parse(fs.readFileSync(path.join(skillDir, SKILL_PROVENANCE_FILENAME), "utf-8"));
		if (parsed && typeof parsed.source === "string" && typeof parsed.sha256 === "string") return parsed as SkillProvenance;
	} catch {}
	return null;
}

/** Classify the local copy without changing its import baseline or update ownership. */
export function skillHasLocalEdits(skillDir: string): boolean {
	const provenance = readSkillProvenance(skillDir);
	if (!provenance || provenance.source === "local" || provenance.source === "upload") return false;
	if (provenance.locallyModified === true) return true;
	try {
		const digest = computeSkillFilesDigest(skillDir);
		return provenance.filesSha256 ? digest?.filesSha256 !== provenance.filesSha256
			: digest?.files.find((file) => file.path === "SKILL.md")?.sha256 !== provenance.sha256;
	} catch { return true; }
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
