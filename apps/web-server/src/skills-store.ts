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
	return path.join(os.homedir(), ".exxperts", "app", "skills");
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
