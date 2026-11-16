import fs from "node:fs";
import path from "node:path";
import { isValidSkillName, readPersistentRoomSkillSettings } from "./persistent-room-skill-settings.js";
import { PKG, REPO_ROOT } from "./server-install-root.js";
import { scanInvisibleUnicode } from "./skills-import.js";
import { parseSkillFrontmatter as parseFrontmatter } from "./skills-repo-fetch.js";
import { agentSkillsDir, computeSkillFilesDigest, readSkillProvenance, sharedAgentsSkillsDir } from "./skills-store.js";

// Where skills live and which one may run, apart from the rest of the library:
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

function skillDirs(): { dir: string; source: string }[] {
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

/**
 * Resolve a library skill's full SKILL.md manifest + parsed parts by name,
 * matching listSkills' source precedence (builtin < user < project, last wins).
 * The FINGERPRINT is `sha256(manifest)`, the whole SKILL.md with its frontmatter,
 * so a description/license/name edit trips re-review just like a body
 * edit (the room's skills index carries the description, so it must be inside
 * the pinned region). read_skill still returns only
 * the (defanged) body; the manifest is the integrity unit, not the output.
 */
function resolveLibrarySkillManifest(name: string): { manifest: string; body: string; description: string; disableModelInvocation: boolean } | null {
	let match: { manifest: string; body: string; description: string; disableModelInvocation: boolean } | null = null;
	for (const { dir } of skillDirs()) {
		let entries: fs.Dirent[];
		try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
		for (const entry of entries) {
			// Symlinked skill dirs and manifests fingerprint like regular ones (the
			// shared ~/.agents/skills root is commonly populated by symlinks). The
			// hash pin is content-based, so a retargeted link is just a changed
			// manifest: the room flips to re-review, same as any edit.
			if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
			const file = path.join(dir, entry.name, "SKILL.md");
			let manifest: string;
			try {
				manifest = fs.readFileSync(file, "utf-8");
			} catch { continue; }
			const { fm, body } = parseFrontmatter(manifest);
			const skillName = (fm.name || entry.name).trim();
			if (skillName !== name) continue;
			match = { manifest, body, description: (fm.description || "").trim(), disableModelInvocation: frontmatterFlagTrue(fm["disable-model-invocation"]) }; // last source wins, mirroring listSkills
		}
	}
	return match;
}

/**
 * The execution side of the library (executable skills): a skill's on-disk
 * location and whole-content digest, or null when the skill is not
 * execution-capable AT ALL, regardless of any room's approval. Only the
 * canonical user store qualifies: shared (~/.agents/skills, writable by any
 * local agent), builtin and project skills never do. The user-store copy must
 * also be the copy the library actually serves for that name (a project-store
 * shadow disqualifies it: what the model reads must be what was approved), it
 * must carry its provenance sidecar, and its manifest must be free of invisible
 * unicode: hidden characters make it instructions-only forever.
 */
function resolveExecutableSkillFiles(name: string): { skillDir: string; filesSha256: string; files: string[] } | null {
	if (!isValidSkillName(name)) return null;
	const skillDir = path.join(agentSkillsDir(), name);
	const digest = computeSkillFilesDigest(skillDir);
	if (!digest) return null;
	let manifest: string;
	try {
		manifest = fs.readFileSync(path.join(skillDir, "SKILL.md"), "utf-8");
	} catch {
		return null;
	}
	const served = resolveLibrarySkillManifest(name);
	if (!served || served.manifest !== manifest) return null;
	if (!readSkillProvenance(skillDir)) return null;
	if (scanInvisibleUnicode(manifest).findings.length > 0) return null;
	return { skillDir, filesSha256: digest.filesSha256, files: digest.files.map((f) => f.path).filter((p) => p !== "SKILL.md") };
}

/** A skill a room approved to run whose files still match that approval: its folder in the user store, and its files. */
interface ApprovedSkill {
	name: string;
	skillDir: string;
	files: string[];
}

/**
 * The skills a room's commands may run right now, read fresh at each call: approved,
 * and their files' digest still the approval's. A changed file or a withdrawn
 * approval drops a skill. Both boxes, the file fence and the skill's text read this.
 */
function approvedSkills(roomId: string): ApprovedSkill[] {
	return readPersistentRoomSkillSettings(roomId).enabledSkills.flatMap((skill) => {
		if (!skill.executeApproval) return [];
		const executable = resolveExecutableSkillFiles(skill.name);
		if (!executable || executable.filesSha256 !== skill.executeApproval.filesSha256) return [];
		return [{ name: skill.name, skillDir: executable.skillDir, files: executable.files }];
	});
}

export { approvedSkills, type ApprovedSkill, frontmatterFlagTrue, resolveExecutableSkillFiles, resolveLibrarySkillManifest, skillDirs };
