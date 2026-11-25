import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { listPersistentAgents, type RoomViewer } from "./persistent-agents.js";
import { readPersistentRoomSkillSettings, roomSkillState } from "./persistent-room-skill-settings.js";
import { agentSkillsDir, isAbsent, isSkillId, readSkillFileText, readSkillIdentity, readSkillProvenance, SKILL_PROVENANCE_FILENAME } from "./skills-store.js";
import { type InvisibleUnicodeFinding, isSkillScript, keptFileMode, nameFoldsOnto, scanInvisibleUnicode, filterRepoScanSkillFiles, SCRIPT_HEAD_BYTES, skillFileList, skillOverLimit, SkillTooBigError, type SkillFile } from "./skills-import.js";
import { detectLicense, fitSkillName, parseSkillFrontmatter as parseFrontmatter, registerCheckout, scriptFiles, skillIdFor, skillOutsidePath, skillVersion } from "./skills-repo-fetch.js";
import { SKILL_LIMITS, SKILL_UPLOAD_MAX_BYTES } from "../../web-ui/src/skill-source-copy.js";
import JSZip from "jszip";
import { claimKey, frontmatterFlagTrue, inReadingOrder, libraryKey, librarySkillFolderView, type NameClaim, readLibrary, type SharedFilesView, readLibrarySkill, resolveLibrarySkillManifest, skillDirs, skillManifestReader, type SkillSource } from "./skills-executable.js";
import { roomBoxComputer } from "./room-box/box-available.js";
import { windowsSkillFolder } from "./room-box/windows/windows-engine.js";
import { remoteRoomExposure } from "./request-checks.js";
import { skillUpdatesReader } from "./skill-updates.js";

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
	/** The version its SKILL.md states, or null. */
	version: string | null;
	/** The skill's author marked it `disable-model-invocation`: the model must not
	 *  invoke it on its own. In a room it is kept out of the per-turn
	 *  enabled-skills index and refused by read_skill; it starts only when the
	 *  person begins a message with its name (skill-pick.ts). */
	disableModelInvocation: boolean;
	/** Its SKILL.md is there but can't be read, or isn't a plain file of its own,
	 *  or its import record can't be read: listed with no text, and no room can use it. */
	unreadable?: true;
	/** Its written name fits onto this name, which it can't have (`claimKey`): a skill
	 *  has it as written, or another of its source fits onto it too. Listed under its
	 *  written name, and no room can use it. */
	nameTaken?: string;
}


/** A not-yet-saved skill returned by the upload endpoint for the review screen (spec §3).
 *  The web UI's review component consumes exactly this shape (its clean seam), so an
 *  MR-4 repo-import candidate is interchangeable with an upload candidate. */
interface SkillUploadCandidate {
	/** The name the skill will be saved under and a room's "/" picks it by: its written name fitted (`skillIdFor`). */
	id: string;
	/** Display name (frontmatter displayName/name). */
	name: string;
	/** Its front matter's name, when the standard doesn't allow it as it is: accept writes it back as it came. */
	writtenName?: string;
	description: string;
	/** Full SKILL.md instruction body (post-frontmatter) — the text the user adopts. */
	body: string;
	/** Provenance source recorded on accept ("upload" here; a git URL for MR-4). */
	source: string;
	/** SPDX-ish license, or null when the package declares none. */
	license: string | null;
	/** The version its front matter states, or null. */
	version: string | null;
	/** Hidden/zero-width/bidi characters found in the body (never silently stripped). */
	scanFindings: InvisibleUnicodeFinding[];
	/** Checkout token when the upload was a zip with bundled files: accept passes
	 *  it back so the reviewed files are vendored beside the SKILL.md, the same
	 *  continuity contract as repo import. Absent for single-file uploads. */
	token?: string;
	/** Every file accept writes, SKILL.md included, with its kind, which the review lists. */
	files: SkillFile[];
	/** The author marked it `disable-model-invocation`. Accept writes a new SKILL.md
	 *  from the candidate, so the mark comes back with it. */
	disableModelInvocation: boolean;
	/** The first path, as written, its Markdown reaches above its folder by (`outsidePath`): adding copies the folder alone. */
	outsidePath?: string;
}

/** Ceiling on a single SKILL.md body pulled from an archive (zip-bomb guard). */
const MAX_SKILL_BODY_BYTES = 512 * 1024;

/** Past the limit, an archive's size is measured no further than this (zip-bomb guard), and said as "over". */
const MAX_SKILL_MEASURED_BYTES = 64 * 1024 * 1024;


function listSkills(): SkillInfo[] {
	const byName = new Map<string, SkillInfo>();
	const claims = new Map<string, NameClaim>();
	// A skill takes its name as a room reads it (`libraryKey`, `claimKey`). One
	// whose written name only fits onto a name it can't have is listed under its
	// written name, with the name it can't take; so is one that held it only
	// fitted, once another takes it or contests it.
	const writtenOf = new Map<string, string>();
	const taken = (skill: SkillInfo, written: string, key: string): SkillInfo => ({ ...skill, name: written, displayName: skill.displayName === written ? undefined : skill.displayName, nameTaken: key });
	const list = (source: SkillSource, key: string, exact: boolean, written: string, skill: SkillInfo): void => {
		const held = byName.get(key);
		const heldWritten = writtenOf.get(key);
		const heldFitted = claims.get(key)?.exact === false;
		const claim = claimKey(claims, key, exact, source);
		if (claim !== "take") byName.set(written, taken(skill, written, key));
		if (claim === "lose") return;
		if (held && heldFitted && heldWritten !== undefined) byName.set(heldWritten, taken(held, heldWritten, key));
		if (claim === "contest") {
			byName.delete(key);
			writtenOf.delete(key);
			return;
		}
		byName.set(key, skill);
		writtenOf.set(key, written);
	};
	const readManifest = skillManifestReader();
	for (const { dir, source } of skillDirs()) {
		// A store folder it can't list is left out, so one never fails the list. A
		// SKILL.md that is there but can't be read (`skillManifestReader`) is listed
		// by its folder's name as one that can't be opened, as a room that has it
		// on reads it (readLibrarySkill), so it never just goes missing.
		let entries: fs.Dirent[];
		try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
		for (const entry of inReadingOrder(entries)) {
			if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
			let manifest: string;
			try {
				manifest = readManifest(source, path.join(dir, entry.name));
			} catch (error) {
				if (!isAbsent(error)) {
					const { key, exact } = libraryKey(source, entry.name);
					const record = source === "user" ? readSkillProvenance(path.join(dir, entry.name)) : null;
					list(source, key, exact, entry.name, { name: key, description: "", body: "", source, protected: source !== "user", provenance: record ? { source: record.source, license: record.license, importedAt: record.importedAt } : null, license: record?.license?.trim() || null, version: null, disableModelInvocation: false, unreadable: true });
				}
				continue;
			}
			const { fm, body } = parseFrontmatter(manifest);
			const written = (fm.name || entry.name).trim();
			const { key: name, exact } = libraryKey(source, entry.name, fm.name);
			// A user skill whose import record can't be read has no identity a room
			// could match (`readLibrary`): it can't be opened, on or off.
			if (source === "user" && readSkillIdentity(path.join(dir, entry.name)) === "unreadable") {
				list(source, name, exact, written, { name, description: "", body: "", source, protected: false, provenance: null, license: null, version: null, disableModelInvocation: false, unreadable: true });
				continue;
			}
			// Provenance lives only next to user-store skills (builtin/project carry none).
			const sidecar = source === "user" ? readSkillProvenance(path.join(dir, entry.name)) : null;
			list(source, name, exact, written, {
				name,
				// The written name, when the library keeps the skill under another.
				displayName: fm.displayName || fm.display_name || (written !== name ? written : undefined),
				description: fm.description || "",
				body: body.trim(),
				source,
				protected: source !== "user",
				provenance: sidecar ? { source: sidecar.source, license: sidecar.license, importedAt: sidecar.importedAt } : null,
				license: sidecar?.license?.trim() || fm.license?.trim() || null,
				version: skillVersion(manifest),
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

/** Which of the viewer's rooms enable each library skill, by skill name, read
 *  from each room's skill settings. A room whose entry is of a skill since deleted
 *  (`roomSkillState` gone) does not use the one the library holds now under that
 *  name. A remote device never sees a hidden room here either. */
function skillRoomsByName(viewer: RoomViewer, req: unknown): Map<string, SkillRoomRef[]> {
	const remote = Boolean((req as any)?.exxRemoteDevice);
	const byName = new Map<string, SkillRoomRef[]>();
	// One read of the library for every room's every skill.
	const libraryRead = readLibrary();
	for (const room of listPersistentAgents(viewer)) {
		if (remote && remoteRoomExposure.isHidden(room.id)) continue;
		const ref = { id: room.id, name: room.displayName?.trim() || room.id };
		for (const skill of readPersistentRoomSkillSettings(room.id).enabledSkills) {
			if (roomSkillState(skill, libraryRead(skill.name)) === "gone") continue;
			const rooms = byName.get(skill.name) ?? [];
			rooms.push(ref);
			byName.set(skill.name, rooms);
		}
	}
	for (const rooms of byName.values()) rooms.sort((a, b) => a.name.localeCompare(b.name));
	return byName;
}

/** What the Skills pages show of a library skill's files: the files, with their kinds, and for a shared-folder skill where they are or why rooms use only its instructions. */
interface LibraryFiles {
	files: SkillFile[];
	shared: SharedFilesView;
	/** On a Windows computer whose rooms run commands in their protection: its scripts read there but can't run, because the protection isn't given its folder (`windowsSkillFolder`). */
	scriptsReadOnly?: true;
}

/** Library skills' files (`LibraryFiles`), from one judgment of each folder (`librarySkillFolderView`): SKILL.md included, those of a
 *  folder a room may open, none for any other, a script by its mode and first bytes on disk (`scriptFiles`) listed as one. One reader reads the library
 *  once, for a list of many skills. */
function librarySkillFilesReader(): (name: string) => LibraryFiles {
	const read = readLibrary();
	return (name) => {
		const { folder, shared } = librarySkillFolderView(name, read);
		const files = folder ? skillFileList(["SKILL.md", ...folder.files], scriptFiles(folder.skillDir, folder.files)) : [];
		const readOnly = folder !== null && files.some((file) => file.kind === "scripts") && roomBoxComputer() === "windows" && windowsSkillFolder(folder.skillDir) === undefined;
		return { files, shared, ...(readOnly ? { scriptsReadOnly: true as const } : {}) };
	};
}

/** One library skill's files (`librarySkillFilesReader`). */
function librarySkillFiles(name: string): LibraryFiles {
	return librarySkillFilesReader()(name);
}

/** A library skill as the Skills pages read it: its rooms, how many files it carries and, for a shared-folder skill, where they are or why rooms use only its instructions (`librarySkillFiles`), and, for one of the person's own, its repository and what its last check found (`skillUpdatesReader`). */
function librarySkillView(skill: SkillInfo, roomsByName: Map<string, SkillRoomRef[]>, { files, shared, scriptsReadOnly }: LibraryFiles = librarySkillFiles(skill.name), updatesOf: ReturnType<typeof skillUpdatesReader> = skillUpdatesReader()) {
	return { ...skill, rooms: roomsByName.get(skill.name) ?? [], fileCount: files.length, ...(scriptsReadOnly ? { scriptsReadOnly } : {}), ...(skill.source === "shared" && !skill.unreadable && !skill.nameTaken ? shared : {}), ...(skill.source === "user" && !skill.unreadable ? updatesOf(skill.name) : {}) };
}

/** Whether the library holds a skill under that name, by its keys (`readLibrary`): a built-in, shared or project skill is found by its written name fitted, whatever its folder is called. */
function skillExistsAnySource(id: string): boolean {
	return readLibrary()(id) !== null;
}

/** A room's skill statuses with the name the Skills pane shows, so a notice can name the skill. */
function withSkillDisplayNames<T extends { name: string }>(skills: T[]): Array<T & { displayName?: string }> {
	const names = new Map(listSkills().map((skill) => [skill.name, skill.displayName] as const));
	return skills.map((skill) => {
		const displayName = names.get(skill.name);
		return displayName ? { ...skill, displayName } : skill;
	});
}

/**
 * The per-room skill-settings resolver: what the library holds
 * under a skill's name (`readLibrarySkill`). This is the seam
 * `enablePersistentRoomSkill`/`computeSkillStatuses`/`effectiveEnabledSkills` read,
 * so a room's entry takes the skill's identity server-side, never from client input.
 */
const skillLibraryFingerprint = readLibrarySkill;


/**
 * The SKILL.md an edit or a delete of a user-store skill works on, and its text,
 * found by its folder, which the library names it by: null when there is none.
 * Its text is null when it isn't a plain file of its own (`readSkillFileText`):
 * an edit then finds nothing, so it never writes through a link, and a delete
 * still removes it.
 */
function getUserSkillFile(id: string): { file: string; manifest: string | null } | null {
	if (!isSkillId(id)) return null;
	const dir = path.join(agentSkillsDir(), id);
	const file = path.join(dir, "SKILL.md");
	let manifest: string;
	try {
		manifest = readSkillFileText(dir, "SKILL.md");
	} catch (error) {
		// There but not a plain file of its own: it can be deleted, never edited.
		return isAbsent(error) ? null : { file, manifest: null };
	}
	return { file, manifest };
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

/** A SKILL.md the app writes; its name line is the id, or an upload's written name, kept as it came when the library reads it back under the id (`libraryKey`). */
function buildUserSkillMarkdown(input: { id: string; writtenName?: string; displayName: string; description: string; instructions: string; disableModelInvocation?: boolean; version?: string | null }): string {
	const version = input.version?.trim() ?? "";
	const writtenName = input.writtenName?.trim() ?? "";
	return [
		"---",
		`name: ${writtenName && !/[\r\n]/.test(writtenName) && libraryKey("user", input.id, writtenName).key === input.id ? frontmatterScalar(writtenName) : input.id}`,
		`displayName: ${input.displayName.trim()}`,
		`description: ${frontmatterScalar(input.description.trim())}`,
		// Only when stated, and one line, so an upload's version shows on its page.
		// Double-quoted, so it reads back as the same text however a reader takes YAML (`1.0` stays `1.0`).
		...(version && !/[\r\n]/.test(version) ? [`version: ${JSON.stringify(version)}`] : []),
		// Only when marked, so an unmarked skill's manifest and its fingerprint stay as they were.
		...(input.disableModelInvocation ? ["disable-model-invocation: true"] : []),
		"---",
		"",
		input.instructions.trim(),
		"",
	].join("\n");
}

function validateSkillWritePayload(body: any, expectedId?: string, opts: { grandfatheredDescription?: string } = {}): { ok: true; value: { id: string; displayName: string; description: string; instructions: string } } | { ok: false; code: number; error: string } {
	const rawId = String(body.id ?? expectedId ?? "");
	const id = fitSkillName(rawId);
	const displayName = String(body.displayName ?? "").trim();
	const description = String(body.description ?? "").trim();
	const instructions = String(body.instructions ?? body.body ?? "").trim();

	if (!id || id !== rawId || !isSkillId(id)) return { ok: false, code: 400, error: "invalid skill id" };
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


/** True when the buffer carries a local-file zip signature ("PK\x03\x04" etc). We sniff
 *  bytes rather than trust the extension, so a `.skill` that is really a zip is handled
 *  as one and a `.zip` that is really text does not blow up the unzip path. */
function looksLikeZip(buffer: Buffer): boolean {
	return buffer.length >= 4 && buffer[0] === 0x50 && buffer[1] === 0x4b && (buffer[2] === 0x03 || buffer[2] === 0x05 || buffer[2] === 0x07);
}

/**
 * Decompress a zip entry via JSZip's PUBLIC `nodeStream()` API, aborting the instant
 * the decompressed size exceeds `maxBytes`. This is the zip-bomb guard: it never
 * trusts JSZip's private `_data.uncompressedSize` shape and never materializes
 * oversized content (a small zip inflating to GBs is stopped mid-stream instead of
 * OOMing the server). Throws `onOverflow()` the moment the cap is crossed. Raw bytes
 * out: bundled skill files are not necessarily text and must survive verbatim.
 */
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

/** An entry's decompressed bytes, or null once they pass `maxBytes` (`readZipEntryBufferCapped`). */
function readZipEntryWithin(entry: JSZip.JSZipObject, maxBytes: number): Promise<Buffer | null> {
	const past = new Error("past the limit");
	return readZipEntryBufferCapped(entry, maxBytes, () => past).catch((error) => {
		if (error === past) return null;
		throw error;
	});
}

/** The refusal for a skill folder past the size limit: its real size, measured
 *  again from the start no further than `MAX_SKILL_MEASURED_BYTES`, from the
 *  archive read afresh (an entry whose read was cut short does not read whole again). */
async function measuredTooBig(buffer: Buffer, relPaths: string[]): Promise<SkillTooBigError> {
	const zip = await JSZip.loadAsync(buffer);
	let total = 0;
	for (const rel of relPaths) {
		const bytes = await readZipEntryWithin(zip.files[rel], MAX_SKILL_MEASURED_BYTES - total);
		if (bytes === null) return new SkillTooBigError({ bytes: MAX_SKILL_MEASURED_BYTES, over: true });
		total += bytes.length;
	}
	return new SkillTooBigError({ bytes: total });
}

/**
 * Turn an uploaded `.md`/`.skill`/`.zip` into a review candidate (spec §3). NEVER executes
 * anything: a zip is unpacked as file-reads only; the skill's folder in it (beside
 * its shallowest SKILL.md) is what accept writes, so that is what is listed and held
 * to `SKILL_LIMITS`: its count before anything is read, its bytes as they are read,
 * keeping none past the limit. The invisible-unicode scan flags hidden characters so
 * the review can surface them. Throws `SkillTooBigError` past the limit, and a plain
 * Error (mapped to 400) on any other validation failure.
 */
async function buildSkillCandidateFromUpload(filename: string, buffer: Buffer): Promise<SkillUploadCandidate> {
	if (buffer.byteLength > SKILL_UPLOAD_MAX_BYTES) throw new SkillTooBigError({ bytes: SKILL_UPLOAD_MAX_BYTES, over: true });
	let skillMd: string;
	let dirHint: string;
	// The zip's own name, which an unnamed skill falls back on after its folder's.
	let zipHint = "";
	let written: string[] = ["SKILL.md"];
	const scripts = new Set<string>();
	// Where the zip's other files are kept for accept, once there are any.
	let bundledDir = "";
	let folderLicense: string | null = null;
	let token: string | undefined;

	if (looksLikeZip(buffer)) {
		let zip: JSZip;
		try {
			zip = await JSZip.loadAsync(buffer);
		} catch {
			throw new Error("could not read the archive (not a valid zip)");
		}
		const relPaths = Object.keys(zip.files).filter((p) => !zip.files[p].dir);
		// Only true SKILL.md manifests count — the loader's discovery filter (minus the
		// root-.md rule), so a README/docs file is never mistaken for a skill.
		const manifests = filterRepoScanSkillFiles(relPaths).sort((a, b) => segmentCount(a) - segmentCount(b) || a.localeCompare(b));
		if (manifests.length === 0) throw new Error("no SKILL.md found in the archive");
		const manifestPath = manifests[0];
		const skillRoot = path.posix.dirname(manifestPath);
		const prefix = skillRoot === "." ? "" : `${skillRoot}/`;
		// The files accept writes beside the SKILL.md: its folder's, a nested skill's
		// SKILL.md included, as a repository's add keeps it. Never, at the top, a name
		// a Mac's or Windows' disk takes for SKILL.md (`skill.md`, or Windows'
		// `SKILL.md.`), which would overwrite the instructions reviewed, nor the
		// skill's own `provenance.json`, which the app's import record takes the place of.
		const leftOut = (p: string) => !p.slice(prefix.length).includes("/") && (nameFoldsOnto(path.posix.basename(p), "SKILL.md") || nameFoldsOnto(path.posix.basename(p), SKILL_PROVENANCE_FILENAME));
		const bundledRelPaths = relPaths.filter((p) => p !== manifestPath && (prefix === "" || p.startsWith(prefix)) && !leftOut(p));
		const files = 1 + bundledRelPaths.length;
		const countRefusal = skillOverLimit(files, 0);
		if (countRefusal) throw new SkillTooBigError(countRefusal);
		const skillEntries = [manifestPath, ...bundledRelPaths];
		// Enforce the SKILL.md cap over the DECOMPRESSED byte stream, aborting the moment
		// it is exceeded — a zip bomb never gets fully materialized (zip-bomb guard).
		const manifestBytes = await readZipEntryBufferCapped(zip.files[manifestPath], MAX_SKILL_BODY_BYTES, () => new Error("SKILL.md in the archive is too large"));
		skillMd = manifestBytes.toString("utf-8");
		let remaining = SKILL_LIMITS.bytes - manifestBytes.length;
		written = ["SKILL.md", ...bundledRelPaths.map((p) => p.slice(prefix.length))];
		// Unnamed, a skill takes its folder's name, or at the zip's top the zip's own.
		zipHint = path.basename(filename).replace(/\.(zip|skill)$/i, "");
		dirHint = skillRoot === "." ? zipHint : path.posix.basename(skillRoot);
		// Retain the bundled files for accept — the same reviewed-is-accepted
		// continuity repo import gets from its checkout. Extraction is read-only,
		// held to the limit in total, and refuses traversal paths outright.
		if (bundledRelPaths.length > 0) {
			const retainDir = fs.mkdtempSync(path.join(os.tmpdir(), "exxperts-skill-upload-"));
			// A refused archive leaves nothing behind: the folder is no checkout's yet.
			try {
				for (const rel of bundledRelPaths) {
					const inner = rel.slice(prefix.length);
					const safe = inner.split("/").filter((seg) => seg && seg !== "." && seg !== "..").join("/");
					if (!safe || safe !== inner || inner.includes("\\")) throw new Error(`archive contains an unsafe path: ${rel}`);
					// Control characters in a filename make trouble downstream: a
					// newline lets a name inject lines into the app-authored read_skill
					// text, and a colon on Windows writes an NTFS alternate data stream
					// beside a file instead of the file. No legitimate skill file needs any of them.
					if (/[\p{Cc}\p{Cf}:]/u.test(inner)) throw new Error(`archive contains an unsafe file name: ${rel}`);
					const bytes = await readZipEntryWithin(zip.files[rel], remaining);
					if (bytes === null) throw await measuredTooBig(buffer, skillEntries);
					remaining -= bytes.length;
					const dest = path.join(retainDir, safe);
					fs.mkdirSync(path.dirname(dest), { recursive: true, mode: 0o700 });
					// A script the zip marks runnable stays so (Windows' zips mark none).
					const mode = Number(zip.files[rel].unixPermissions) || 0;
					const head = bytes.subarray(0, SCRIPT_HEAD_BYTES);
					fs.writeFileSync(dest, bytes, { mode: keptFileMode(inner, mode, head) });
					if (isSkillScript(inner, mode, head)) scripts.add(inner);
				}
			} catch (error) {
				fs.rmSync(retainDir, { recursive: true, force: true });
				throw error;
			}
			folderLicense = detectLicense(retainDir);
			bundledDir = retainDir;
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
	const id = skillIdFor(fm.name, dirHint, zipHint);
	const displayName = (fm.displayName || fm.display_name || rawName || id).trim();
	const description = (fm.description || "").trim();
	const license = (fm.license || "").trim() || folderLicense;
	const writtenName = fm.name?.trim();
	const pointsOutside = skillOutsidePath(bundledDir, written, skillMd);
	return {
		id,
		name: displayName,
		...(writtenName && writtenName !== id ? { writtenName } : {}),
		description,
		body: instructions,
		source: "upload",
		license,
		version: skillVersion(skillMd),
		// Scan body AND description — the description reaches the system prompt too.
		scanFindings: scanInvisibleUnicode(`${instructions}\n${description}`).findings,
		files: skillFileList(written, scripts),
		disableModelInvocation: frontmatterFlagTrue(fm["disable-model-invocation"]),
		...(token ? { token } : {}),
		...(pointsOutside ? { outsidePath: pointsOutside } : {}),
	};
}

export { buildSkillCandidateFromUpload, buildUserSkillMarkdown, frontmatterFlagTrue, getUserSkillFile, librarySkillFiles, librarySkillFilesReader, librarySkillView, listSkills, resolveLibrarySkillManifest, skillExistsAnySource, skillLibraryFingerprint, skillRoomsByName, validateSkillWritePayload, withSkillDisplayNames };
