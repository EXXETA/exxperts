import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { listPersistentAgents } from "./persistent-agents.js";
import { readPersistentRoomSkillSettings, isValidSkillName } from "./persistent-room-skill-settings.js";
import { sharedAgentsSkillsDir, agentSkillsDir, readSkillProvenance, computeSkillFilesDigest } from "./skills-store.js";
import { type InvisibleUnicodeFinding, scanInvisibleUnicode, filterRepoScanSkillFiles } from "./skills-import.js";
import { parseSkillFrontmatter as parseFrontmatter, registerCheckout } from "./skills-repo-fetch.js";
import JSZip from "jszip";
import { PKG, REPO_ROOT } from "./server-install-root.js";
import { remoteRoomExposure } from "./request-checks.js";

// --- discovery endpoints used by the UI sidebar -------------------------

interface SkillInfo {
	name: string;
	displayName?: string;
	description: string;
	body: string;
	source: string;
	protected: boolean;
	/** Import origin + license + date from the provenance sidecar (spec §1). Null for
	 *  builtin/project skills, which carry no sidecar. Surfaced by the library list and
	 *  the review/detail screen (the trust moment — where it came from, what license). */
	provenance: { source: string; license: string | null; importedAt: string } | null;
	/** The license the skill carries: its import record's, or else the one its
	 *  SKILL.md declares (a built-in, shared or project skill has no record). */
	license: string | null;
	/** The skill's author marked it `disable-model-invocation`: the model must not
	 *  invoke it on its own. In a room that means it is kept out of the per-turn
	 *  enabled-skills index and refused by read_skill, so it never auto-runs.
	 *  Rooms have no manual trigger yet, so such a skill is inert once enabled;
	 *  the UI says so. */
	disableModelInvocation: boolean;
}

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

/** A not-yet-saved skill returned by the upload endpoint for the review screen (spec §3).
 *  The web UI's review component consumes exactly this shape (its clean seam), so an
 *  MR-4 repo-import candidate is interchangeable with an upload candidate. */
interface SkillUploadCandidate {
	/** Slugified dir/id the skill will be saved under. */
	id: string;
	/** Display name (frontmatter displayName/name). */
	name: string;
	description: string;
	/** Full SKILL.md instruction body (post-frontmatter) — the text the user adopts. */
	body: string;
	/** Provenance source recorded on accept ("upload" here; a git URL for MR-4). */
	source: string;
	/** SPDX-ish license, or null when the package declares none (review shows a warning). */
	license: string | null;
	/** Hidden/zero-width/bidi characters found in the body (never silently stripped). */
	scanFindings: InvisibleUnicodeFinding[];
	/** Checkout token when the upload was a zip with bundled files: accept passes
	 *  it back so the reviewed files are vendored beside the SKILL.md, the same
	 *  continuity contract as repo import. Absent for single-file uploads. */
	token?: string;
	/** Names of bundled scripts in the package. They are NEVER run — the review says so. */
	bundledScripts: string[];
}

/** Hard ceiling on a decoded upload (spec §7 / hard rule: enforce size limits). */
const MAX_SKILL_UPLOAD_BYTES = 8 * 1024 * 1024;

/** Ceiling on a single SKILL.md body pulled from an archive (zip-bomb guard). */
const MAX_SKILL_BODY_BYTES = 512 * 1024;

/** Entry-count guard for uploaded archives. */
const MAX_SKILL_ARCHIVE_ENTRIES = 4096;

/** Extensions we treat as bundled scripts to flag ("instructions only" — never executed). */
const SKILL_SCRIPT_EXTENSIONS = new Set([".py", ".sh", ".bash", ".zsh", ".js", ".mjs", ".cjs", ".ts", ".rb", ".pl", ".ps1", ".bat", ".cmd", ".php", ".rs", ".go"]);

// Frontmatter parsing is unified on skills-repo-fetch's YAML-subset parser
// (imported below as parseFrontmatter) so the library, the room index, and
// repo import all read a manifest identically.

function skillDirs(): { dir: string; source: string }[] {
	return [
		{ dir: path.join(PKG, "skills"), source: "builtin" },
		// The cross-tool shared directory (~/.agents/skills). Read-only from our
		// side: skills there are listed but never edited, deleted, or given
		// provenance sidecars — other tools own that directory. It sits BELOW the
		// user store so a name the user explicitly put in the exxperts store wins
		// over the ambient shared one.
		{ dir: sharedAgentsSkillsDir(), source: "shared" },
		// The canonical user store is the Pi loader's user dir (spec §1) — a skill
		// written here is visible to the CLI and vice versa.
		{ dir: agentSkillsDir(), source: "user" },
		{ dir: path.join(REPO_ROOT, ".exxeta", "skills"), source: "project" },
	];
}

function listSkills(): SkillInfo[] {
	const byName = new Map<string, SkillInfo>();
	for (const { dir, source } of skillDirs()) {
		if (!fs.existsSync(dir)) continue;
		for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
			if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
			const file = path.join(dir, entry.name, "SKILL.md");
			if (!fs.existsSync(file)) continue;
			const { fm, body } = parseFrontmatter(fs.readFileSync(file, "utf-8"));
			const name = (fm.name || entry.name).trim();
			if (!name) continue;
			// Provenance lives only next to user-store skills (builtin/project carry none).
			const sidecar = source === "user" ? readSkillProvenance(path.join(dir, entry.name)) : null;
			byName.set(name, {
				name,
				displayName: fm.displayName || fm.display_name || undefined,
				description: fm.description || "",
				body: body.trim(),
				source,
				protected: source !== "user",
				provenance: sidecar ? { source: sidecar.source, license: sidecar.license, importedAt: sidecar.importedAt } : null,
				license: sidecar?.license?.trim() || fm.license?.trim() || null,
				disableModelInvocation: frontmatterFlagTrue(fm["disable-model-invocation"]),
			});
		}
	}
	return Array.from(byName.values()).sort((a, b) => a.name.localeCompare(b.name));
}

/** A room that enables a library skill, as the Skills pages name it. */
interface SkillRoomRef {
	id: string;
	name: string;
}

/** Which rooms enable each library skill, by skill name, read from every room's
 *  skill settings. A remote device never sees a hidden room here either. */
function skillRoomsByName(req: unknown): Map<string, SkillRoomRef[]> {
	const remote = Boolean((req as any)?.exxRemoteDevice);
	const byName = new Map<string, SkillRoomRef[]>();
	for (const room of listPersistentAgents()) {
		if (remote && remoteRoomExposure.isHidden(room.id)) continue;
		const ref = { id: room.id, name: room.displayName?.trim() || room.id };
		for (const skill of readPersistentRoomSkillSettings(room.id).enabledSkills) {
			const rooms = byName.get(skill.name) ?? [];
			rooms.push(ref);
			byName.set(skill.name, rooms);
		}
	}
	for (const rooms of byName.values()) rooms.sort((a, b) => a.name.localeCompare(b.name));
	return byName;
}

/** A library skill as the Skills pages read it: its rooms and how many files it
 *  carries, the files a room can be allowed to run (the room's Skills pane lists
 *  the same ones). */
function librarySkillView(skill: SkillInfo, roomsByName: Map<string, SkillRoomRef[]>, files: string[] = resolveExecutableSkillFiles(skill.name)?.files ?? []) {
	return { ...skill, rooms: roomsByName.get(skill.name) ?? [], fileCount: files.length };
}

function slugifySkillId(value: string): string {
	return value
		.toLowerCase()
		.replace(/[^a-z0-9\s-]/g, "")
		.trim()
		.replace(/\s+/g, "-")
		.replace(/-+/g, "-")
		.slice(0, 48);
}

function skillExistsAnySource(id: string): boolean {
	return skillDirs().some(({ dir }) => fs.existsSync(path.join(dir, id, "SKILL.md")));
}

/**
 * The per-room skill-settings body resolver (spec §4): the CURRENT library body
 * of a skill by name, or null when the skill no longer exists. This is the seam
 * `enablePersistentRoomSkill`/`computeSkillStatuses` hash against, so enablement
 * pins — and mismatch detection re-derives — `sha256` server-side from the
 * canonical store, never from client input.
 */
/**
 * Resolve a library skill's full SKILL.md manifest + parsed parts by name,
 * matching listSkills' source precedence (builtin < user < project, last wins).
 * The FINGERPRINT is `sha256(manifest)` — the whole SKILL.md, frontmatter
 * included — so a description/license/name edit trips re-review just like a body
 * edit (skills MR-5 hardening: the L2 index injects the description, so it must
 * be inside the pinned region — spec §7 must 2). read_skill still returns only
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

/** The enablement fingerprint source (spec §7 must 2): the full SKILL.md manifest
 *  by name, or null when the skill is gone. enablePersistentRoomSkill hashes it. */
/** A room's skill statuses with the name the Skills pane shows, so a notice can name the skill. */
function withSkillDisplayNames<T extends { name: string }>(skills: T[]): Array<T & { displayName?: string }> {
	const names = new Map(listSkills().map((skill) => [skill.name, skill.displayName] as const));
	return skills.map((skill) => {
		const displayName = names.get(skill.name);
		return displayName ? { ...skill, displayName } : skill;
	});
}

function skillLibraryFingerprint(name: string): string | null {
	return resolveLibrarySkillManifest(name)?.manifest ?? null;
}

/**
 * The execution side of the library (executable skills): a skill's on-disk
 * location and whole-content digest, or null when the skill is not
 * execution-capable AT ALL, regardless of any room's approval. Only the
 * canonical user store qualifies — shared (~/.agents/skills, writable by any
 * local agent), builtin and project skills never do. The user-store copy must
 * also be the copy the library actually serves for that name (a project-store
 * shadow disqualifies it: what the model reads must be what was approved), it
 * must carry its provenance sidecar, and its manifest must be free of invisible
 * unicode — hidden characters make it instructions-only forever.
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

function getUserSkillFile(id: string): string | null {
	const safeId = slugifySkillId(id);
	if (!safeId || safeId !== id) return null;
	const file = path.join(agentSkillsDir(), id, "SKILL.md");
	if (!fs.existsSync(file)) return null;
	const { fm } = parseFrontmatter(fs.readFileSync(file, "utf-8"));
	return (fm.name || id) === id ? file : null;
}

/**
 * Emit a frontmatter scalar that round-trips through parseFrontmatter. A value that
 * BEGINS with a quote char, written as a bare plain scalar, would be mis-read by the
 * parser (a leading `'`/`"` is the quoted-scalar sigil) — so wrap those in an escaped
 * double-quoted scalar. Everything else stays a plain scalar, so no existing manifest
 * changes shape (and its sha256 fingerprint is unaffected).
 */
function frontmatterScalar(value: string): string {
	if (value.startsWith('"') || value.startsWith("'")) {
		return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
	}
	return value;
}

function buildUserSkillMarkdown(input: { id: string; displayName: string; description: string; instructions: string }): string {
	return [
		"---",
		`name: ${input.id}`,
		`displayName: ${input.displayName.trim()}`,
		`description: ${frontmatterScalar(input.description.trim())}`,
		"---",
		"",
		input.instructions.trim(),
		"",
	].join("\n");
}

function validateSkillWritePayload(body: any, expectedId?: string, opts: { grandfatheredDescription?: string } = {}): { ok: true; value: { id: string; displayName: string; description: string; instructions: string } } | { ok: false; code: number; error: string } {
	const rawId = String(body.id ?? expectedId ?? "");
	const id = slugifySkillId(rawId);
	const displayName = String(body.displayName ?? "").trim();
	const description = String(body.description ?? "").trim();
	const instructions = String(body.instructions ?? body.body ?? "").trim();

	if (!id || id !== rawId || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id)) return { ok: false, code: 400, error: "invalid skill id" };
	if (expectedId && id !== expectedId) return { ok: false, code: 400, error: "skill id cannot be changed" };
	if (!displayName) return { ok: false, code: 400, error: "displayName is required" };
	if (displayName.includes("\n")) return { ok: false, code: 400, error: "displayName must be one line" };
	if (!description) return { ok: false, code: 400, error: "description is required" };
	if (description.includes("\n")) return { ok: false, code: 400, error: "description must be one line" };
	// The ≤1024 rule applies to NEW or CHANGED descriptions only. On the edit path an
	// unchanged (byte-identical) description is grandfathered, so a pre-existing skill
	// whose stored description already exceeds the limit can still have its body edited.
	if (description.length > 1024 && description !== opts.grandfatheredDescription) return { ok: false, code: 400, error: "description must be at most 1024 characters" };
	if (!instructions) return { ok: false, code: 400, error: "instructions are required" };
	return { ok: true, value: { id, displayName, description, instructions } };
}

function segmentCount(relPath: string): number {
	return relPath.split("/").filter(Boolean).length;
}

function isScriptFile(relPath: string): boolean {
	return SKILL_SCRIPT_EXTENSIONS.has(path.posix.extname(relPath).toLowerCase());
}

/** True when the buffer carries a local-file zip signature ("PK\x03\x04" etc). We sniff
 *  bytes rather than trust the extension, so a `.skill` that is really a zip is handled
 *  as one and a `.zip` that is really text does not blow up the unzip path. */
function looksLikeZip(buffer: Buffer): boolean {
	return buffer.length >= 4 && buffer[0] === 0x50 && buffer[1] === 0x4b && (buffer[2] === 0x03 || buffer[2] === 0x05 || buffer[2] === 0x07);
}

/**
 * Decompress a zip entry to a UTF-8 string via JSZip's PUBLIC `nodeStream()` API,
 * aborting the instant the decompressed size exceeds `maxBytes`. This is the zip-bomb
 * guard: it never trusts JSZip's private `_data.uncompressedSize` shape and never
 * materializes oversized content (a small zip inflating to GBs is stopped mid-stream
 * instead of OOMing the server on a full `async("string")` decompress). Throws
 * `onOverflow()` the moment the cap is crossed.
 */
function readZipEntryCapped(entry: JSZip.JSZipObject, maxBytes: number, onOverflow: () => Error): Promise<string> {
	return readZipEntryBufferCapped(entry, maxBytes, onOverflow).then((buffer) => buffer.toString("utf-8"));
}

/** The binary-safe core of `readZipEntryCapped` — same abort-on-overflow
 *  contract, raw bytes out. Bundled skill files are not necessarily text and
 *  must survive verbatim: their bytes are what the execution-approval digest
 *  pins, so a lossy utf-8 round-trip would silently void every approval. */
function readZipEntryBufferCapped(entry: JSZip.JSZipObject, maxBytes: number, onOverflow: () => Error): Promise<Buffer> {
	return new Promise((resolve, reject) => {
		const chunks: Buffer[] = [];
		let total = 0;
		let aborted = false;
		const stream = entry.nodeStream();
		stream.on("data", (chunk: Buffer | string) => {
			if (aborted) return;
			const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), "utf-8");
			total += buf.length;
			if (total > maxBytes) {
				aborted = true;
				reject(onOverflow());
				stream.pause();
				(stream as unknown as { destroy?: () => void }).destroy?.();
				return;
			}
			chunks.push(buf);
		});
		stream.on("error", (err: Error) => { if (!aborted) reject(err); });
		stream.on("end", () => { if (!aborted) resolve(Buffer.concat(chunks)); });
	});
}

/**
 * Turn an uploaded `.md`/`.skill`/`.zip` into a review candidate (spec §3). NEVER executes
 * anything — a zip is unpacked as file-reads only, and only its single SKILL.md is
 * decompressed; bundled scripts are listed by name (to warn "instructions only"), never run.
 * The invisible-unicode scan flags hidden characters so the review can surface them.
 * Throws a plain Error (mapped to 400) on any validation failure.
 */
async function buildSkillCandidateFromUpload(filename: string, buffer: Buffer): Promise<SkillUploadCandidate> {
	let skillMd: string;
	let dirHint: string;
	let bundledScripts: string[] = [];
	let token: string | undefined;

	if (looksLikeZip(buffer)) {
		let zip: JSZip;
		try {
			zip = await JSZip.loadAsync(buffer);
		} catch {
			throw new Error("could not read the archive (not a valid zip)");
		}
		const relPaths = Object.keys(zip.files).filter((p) => !zip.files[p].dir);
		if (relPaths.length > MAX_SKILL_ARCHIVE_ENTRIES) throw new Error("archive has too many entries");
		// Only true SKILL.md manifests count — the loader's discovery filter (minus the
		// root-.md rule), so a README/docs file is never mistaken for a skill.
		const manifests = filterRepoScanSkillFiles(relPaths).sort((a, b) => segmentCount(a) - segmentCount(b) || a.localeCompare(b));
		if (manifests.length === 0) throw new Error("no SKILL.md found in the archive");
		const manifestPath = manifests[0];
		const entry = zip.files[manifestPath];
		// Enforce the SKILL.md cap over the DECOMPRESSED byte stream, aborting the moment
		// it is exceeded — a zip bomb never gets fully materialized (zip-bomb guard).
		skillMd = await readZipEntryCapped(entry, MAX_SKILL_BODY_BYTES, () => new Error("SKILL.md in the archive is too large"));
		const skillRoot = path.posix.dirname(manifestPath);
		const prefix = skillRoot === "." ? "" : `${skillRoot}/`;
		bundledScripts = Array.from(
			new Set(
				relPaths
					.filter((p) => p !== manifestPath && (prefix === "" || p.startsWith(prefix)) && isScriptFile(p))
					// Relative to the skill's folder, so the review can group them by folder.
					.map((p) => p.slice(prefix.length)),
			),
		).sort();
		dirHint = skillRoot === "." ? "" : path.posix.basename(skillRoot);
		// Retain the bundled files for accept — the same reviewed-is-accepted
		// continuity repo import gets from its checkout. Before this, accept
		// wrote only the SKILL.md and the package's files were silently dropped,
		// while repo import vendored them: the two paths now agree. Extraction is
		// read-only, byte-capped in total, and refuses traversal paths outright.
		const bundledRelPaths = relPaths.filter((p) => p !== manifestPath && (prefix === "" || p.startsWith(prefix)));
		if (bundledRelPaths.length > 0) {
			const retainDir = fs.mkdtempSync(path.join(os.tmpdir(), "exxperts-skill-upload-"));
			let remaining = MAX_SKILL_UPLOAD_BYTES;
			// A refused archive leaves nothing behind: the folder is no checkout's yet.
			try {
				for (const rel of bundledRelPaths) {
					const inner = rel.slice(prefix.length);
					const safe = inner.split("/").filter((seg) => seg && seg !== "." && seg !== "..").join("/");
					if (!safe || safe !== inner || inner.includes("\\")) throw new Error(`archive contains an unsafe path: ${rel}`);
					// Control characters in a filename make trouble downstream: a
					// newline lets two different trees serialize to one files digest
					// (the manifest joins entries with newlines), and it lets a name
					// inject lines into the app-authored read_skill text. A colon on
					// Windows writes an NTFS alternate data stream the digest never
					// sees. No legitimate skill file needs any of them.
					if (/[\p{Cc}\p{Cf}:]/u.test(inner)) throw new Error(`archive contains an unsafe file name: ${rel}`);
					const bytes = await readZipEntryBufferCapped(zip.files[rel], remaining, () => new Error("the archive's bundled files are too large"));
					remaining -= bytes.length;
					const dest = path.join(retainDir, safe);
					fs.mkdirSync(path.dirname(dest), { recursive: true, mode: 0o700 });
					fs.writeFileSync(dest, bytes, { mode: 0o600 });
				}
			} catch (error) {
				fs.rmSync(retainDir, { recursive: true, force: true });
				throw error;
			}
			token = registerCheckout(retainDir, "upload");
		}
	} else {
		if (buffer.byteLength > MAX_SKILL_BODY_BYTES) throw new Error("skill file is too large");
		skillMd = buffer.toString("utf-8");
		dirHint = filename ? path.basename(filename).replace(/\.(md|skill|txt)$/i, "") : "";
	}

	const { fm, body } = parseFrontmatter(skillMd);
	const instructions = body.trim();
	if (!instructions) throw new Error("the SKILL.md has no instruction body");
	const rawName = (fm.name || dirHint || "").trim();
	const id = slugifySkillId(rawName || "uploaded-skill");
	if (!id) throw new Error("could not derive a valid skill id from the upload");
	const displayName = (fm.displayName || fm.display_name || rawName || id).trim();
	const description = (fm.description || "").trim();
	const license = (fm.license || "").trim() || null;
	return {
		id,
		name: displayName,
		description,
		body: instructions,
		source: "upload",
		license,
		// Scan body AND description — the description reaches the system prompt too.
		scanFindings: scanInvisibleUnicode(`${instructions}\n${description}`).findings,
		bundledScripts,
		...(token ? { token } : {}),
	};
}

export { MAX_SKILL_UPLOAD_BYTES, buildSkillCandidateFromUpload, buildUserSkillMarkdown, getUserSkillFile, librarySkillView, listSkills, resolveExecutableSkillFiles, resolveLibrarySkillManifest, skillExistsAnySource, skillLibraryFingerprint, skillRoomsByName, slugifySkillId, validateSkillWritePayload, withSkillDisplayNames };
