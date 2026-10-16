import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { reportRepositoryProgress } from "./skills-repository-progress.js";
import { productAppStatePath } from "../../../pi-package/product-state-paths.js";
import { normalizeRepoPath, normalizeRepositoryFilePolicy, referenceBytesSha256, referencePathPermission, validateReferenceBuffer, REFERENCE_ASSET_MAX_BYTES, REFERENCE_TEXT_MAX_BYTES, type ReferenceKind, type RepositoryFilePolicy } from "./skills-file-policy.js";
import { repositoryScanFromToken, readRepositoryMaterial, prefetchRepositoryMaterials } from "./skills-repo-fetch.js";
import { readSkillLibraries } from "./skills-libraries.js";
import { readManagedSkillPackage, type SkillReferenceEntry } from "./skills-store.js";
import { readReviewedReferenceBytes, type SkillReferenceModel, type SkillReferenceReadOptions, type SkillReferenceReadResult } from "./skills-reference-reading.js";

export const LIBRARY_MATERIAL_MAX_FILES = 2000;
export const LIBRARY_MATERIAL_MAX_BYTES = 128 * 1024 * 1024;
const CANDIDATE_TTL_MS = 15 * 60_000;
const HASH = /^[a-f0-9]{64}$/;
const TEXT_KINDS = new Set<ReferenceKind>(["markdown", "text", "styles", "html", "svg"]);

export interface LibraryMaterialFile {
	path: string;
	kind: ReferenceKind;
	size: number;
	sha256: string;
	mimeType: string;
	/** Legacy selections may originate from different reviewed commits. */
	revision?: string;
}
export interface LibraryMaterialsManifest {
	schemaVersion: 1;
	libraryId: string;
	materialsSha256: string;
	source: string;
	ref?: string;
	revision: string;
	policy: RepositoryFilePolicy;
	files: LibraryMaterialFile[];
}
export interface LibraryMaterialsCandidate {
	candidateSha256: string;
	expectedCurrentHash: string | null;
	manifest: LibraryMaterialsManifest;
	added: string[];
	removed: string[];
}
interface PendingMaterials { candidate: LibraryMaterialsCandidate; bytes: Map<string, Buffer>; createdAt: number }
const candidates = new Map<string, PendingMaterials>();

function compare(a: string, b: string): number { return a < b ? -1 : a > b ? 1 : 0; }
function libraryDirectory(libraryId: string): string {
	if (!/^[a-zA-Z0-9-]{1,80}$/.test(libraryId)) throw new Error("Invalid material library identifier.");
	return path.join(productAppStatePath("skill-library-materials"), libraryId);
}
function versionDirectory(libraryId: string, digest: string): string {
	if (!HASH.test(digest)) throw new Error("Invalid material version.");
	return path.join(libraryDirectory(libraryId), "versions", digest);
}
function materialError(message: string, statusCode = 400): Error {
	return Object.assign(new Error(message), { statusCode });
}

interface PublishLock { descriptor: number; owner: string }
function readPublishLock(file: string): { pid: number; owner: string } {
	try {
		const record = JSON.parse(readFile(file, 512).toString("utf8"));
		if (!Number.isSafeInteger(record.pid) || record.pid <= 0 || record.pid > 2147483647 || typeof record.owner !== "string" || !/^[a-f0-9-]{36}$/.test(record.owner)) throw new Error("invalid owner");
		return record;
	} catch { throw materialError("The source-material save lock is invalid. Preserve it for repair.", 409); }
}
function acquirePublishLock(file: string): PublishLock {
	for (let attempt = 0; attempt < 2; attempt += 1) {
		const owner = crypto.randomUUID();
		let descriptor: number;
		try { descriptor = fs.openSync(file, "wx", 0o600); }
		catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			const stale = readPublishLock(file);
			const identity = fs.statSync(file, { bigint: true });
			let dead = false;
			try { process.kill(stale.pid, 0); } catch (error) { dead = (error as NodeJS.ErrnoException).code === "ESRCH"; }
			if (!dead) throw materialError("Source materials are being saved, or the save owner cannot be checked. Retry after that operation finishes.", 409);
			const current = readPublishLock(file);
			const currentIdentity = fs.statSync(file, { bigint: true });
			if (current.pid !== stale.pid || current.owner !== stale.owner || currentIdentity.ino !== identity.ino || currentIdentity.dev !== identity.dev) throw materialError("The source-material save owner changed. Try again.", 409);
			fs.unlinkSync(file);
			continue;
		}
		try { fs.writeFileSync(descriptor, JSON.stringify({ pid: process.pid, owner })); }
		catch (error) { fs.closeSync(descriptor); fs.unlinkSync(file); throw error; }
		return { descriptor, owner };
	}
	throw materialError("Source materials are being saved. Retry after that operation finishes.", 409);
}
function releasePublishLock(file: string, lock: PublishLock): void {
	fs.closeSync(lock.descriptor);
	try {
		const current = readPublishLock(file);
		if (current.pid === process.pid && current.owner === lock.owner) fs.unlinkSync(file);
	} catch { /* Never remove a replaced or damaged lock. */ }
}

async function renamePublishedPath(from: string, to: string, verify: () => void): Promise<void> {
	for (let attempt = 0; ; attempt += 1) {
		verify();
		try { fs.renameSync(from, to); return; }
		catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (code !== "EPERM" && code !== "EACCES" && code !== "EBUSY") throw error;
			if (attempt >= 4) throw Object.assign(materialError("Local source materials could not be saved. Existing files were preserved; try again.", 503), { cause: error, code });
			await delay(50 * 2 ** attempt);
		}
	}
}

function removePublicationTemporary(file: string, recursive = false): void {
	try { fs.rmSync(file, { recursive, force: true, maxRetries: 3, retryDelay: 100 }); }
	catch { /* An unused temporary must not hide the save result or remove accepted files. */ }
}
function ensureRegularPath(absolute: string): void {
	const base = productAppStatePath("skill-library-materials");
	const relative = path.relative(base, absolute);
	if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("Material path escapes its store.");
	let current = base;
	for (const segment of ["", ...relative.split(path.sep).filter(Boolean)]) {
		if (segment) current = path.join(current, segment);
		try { if (fs.lstatSync(current).isSymbolicLink()) throw new Error("Material store contains a symbolic link."); }
		catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
	}
}
function readFile(absolute: string, maxBytes: number): Buffer {
	ensureRegularPath(absolute);
	const descriptor = fs.openSync(absolute, "r");
	try {
		const stat = fs.fstatSync(descriptor);
		if (!stat.isFile() || stat.size > maxBytes) throw new Error("Material file is not regular or exceeds its size limit.");
		const base = productAppStatePath("skill-library-materials");
		if (path.relative(fs.realpathSync(base), fs.realpathSync(absolute)) !== path.relative(base, absolute)) throw new Error("Material file changed or escapes its store.");
		const bytes = fs.readFileSync(descriptor);
		if (bytes.length !== stat.size || bytes.length > maxBytes) throw new Error("Material file changed while reading.");
		return bytes;
	} finally { fs.closeSync(descriptor); }
}
function materialPath(raw: unknown, policy: RepositoryFilePolicy): string {
	const result = normalizeRepoPath(raw);
	if (typeof raw !== "string" || raw !== result || path.posix.basename(result).toLowerCase() === "skill.md") throw new Error("Skill manifests cannot be imported as source materials.");
	if (!referencePathPermission(result, policy).allowed) throw new Error("Material path or file type is not allowed.");
	return result;
}
function canonicalManifest(input: Omit<LibraryMaterialsManifest, "materialsSha256">): LibraryMaterialsManifest {
	const content = { schemaVersion: 1 as const, libraryId: input.libraryId, source: input.source, ...(input.ref !== undefined ? { ref: input.ref } : {}), revision: input.revision, policy: normalizeRepositoryFilePolicy(input.policy), files: [...input.files].sort((a, b) => compare(a.path, b.path)) };
	return { ...content, materialsSha256: referenceBytesSha256(Buffer.from(JSON.stringify(content))) };
}
function validateManifest(input: unknown, libraryId: string, digest: string): LibraryMaterialsManifest {
	const raw = input as LibraryMaterialsManifest;
	if (!raw || raw.schemaVersion !== 1 || raw.libraryId !== libraryId || raw.materialsSha256 !== digest || typeof raw.source !== "string" || !raw.source || raw.source.length > 4096 || (raw.ref !== undefined && typeof raw.ref !== "string") || !/^[a-f0-9]{40,64}$/.test(raw.revision) || !Array.isArray(raw.files) || raw.files.length > LIBRARY_MATERIAL_MAX_FILES) throw new Error("Invalid material manifest.");
	const policy = normalizeRepositoryFilePolicy(raw.policy);
	const paths = new Set<string>();
	let total = 0;
	const files = raw.files.map((file) => {
		const original = materialPath(file?.path, policy);
		const folded = original.toLowerCase();
		const kind = referencePathPermission(original, policy).kind;
		if (paths.has(folded) || kind !== file.kind || !Number.isSafeInteger(file.size) || file.size < 0 || file.size > (TEXT_KINDS.has(file.kind) ? REFERENCE_TEXT_MAX_BYTES : REFERENCE_ASSET_MAX_BYTES) || !HASH.test(file.sha256) || typeof file.mimeType !== "string" || file.mimeType.length > 150 || /[\r\n]/.test(file.mimeType) || (file.revision !== undefined && !/^[a-f0-9]{40,64}$/.test(file.revision))) throw new Error("Invalid material file metadata.");
		paths.add(folded);
		total += file.size;
		return { path: original, kind: file.kind, size: file.size, sha256: file.sha256, mimeType: file.mimeType, ...(file.revision !== undefined ? { revision: file.revision } : {}) };
	});
	for (const original of paths) {
		let parent = path.posix.dirname(original);
		while (parent !== ".") { if (paths.has(parent)) throw new Error("Material files collide with a directory."); parent = path.posix.dirname(parent); }
	}
	if (total > LIBRARY_MATERIAL_MAX_BYTES) throw new Error("Materials exceed the 128 MiB limit.");
	const manifest = canonicalManifest({ ...raw, policy, files });
	if (manifest.materialsSha256 !== digest) throw new Error("Material manifest fingerprint changed.");
	return manifest;
}

/** Metadata-only index; selected file bytes are hash-checked at every read. */
export function readLibraryMaterialsIndex(libraryId: string, materialsSha256?: string): LibraryMaterialsManifest | null {
	const digest = materialsSha256 ?? currentLibraryMaterialsSha256(libraryId);
	if (!digest) return null;
	const file = path.join(versionDirectory(libraryId, digest), "manifest.json");
	return validateManifest(JSON.parse(readFile(file, 2 * 1024 * 1024).toString("utf8")), libraryId, digest);
}
export function currentLibraryMaterialsSha256(libraryId: string): string | null {
	const file = path.join(libraryDirectory(libraryId), "current.json");
	ensureRegularPath(file);
	let bytes: Buffer;
	try { bytes = readFile(file, 1024); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
	const value = JSON.parse(bytes.toString("utf8"));
	if (value?.schemaVersion !== 1 || typeof value.materialsSha256 !== "string" || !HASH.test(value.materialsSha256)) throw new Error("Invalid current material version; existing data was preserved.");
	return value.materialsSha256;
}
function requireLibrarySnapshot(libraryId: string, manifest: LibraryMaterialsManifest): void {
	const library = readSkillLibraries().find((entry) => entry.id === libraryId);
	if (!library || library.source !== manifest.source || library.ref !== manifest.ref || JSON.stringify(normalizeRepositoryFilePolicy(library)) !== JSON.stringify(manifest.policy)) throw materialError("The source settings changed. Read the repository again.", 409);
}
function sweepCandidates(): void {
	for (const [key, entry] of candidates) if (Date.now() - entry.createdAt >= CANDIDATE_TTL_MS) candidates.delete(key);
}
function candidateFor(manifest: LibraryMaterialsManifest, bytes: Map<string, Buffer>, expectedCurrentHash: string | null): LibraryMaterialsCandidate {
	const current = readLibraryMaterialsIndex(manifest.libraryId);
	if ((current?.materialsSha256 ?? null) !== expectedCurrentHash) throw materialError("Local source materials changed. Review them again.", 409);
	const before = new Map(current?.files.map((file) => [file.path, file.sha256]) ?? []);
	const after = new Set(manifest.files.map((file) => file.path));
	const candidate = { candidateSha256: referenceBytesSha256(Buffer.from(JSON.stringify({ manifest, expectedCurrentHash }))), expectedCurrentHash, manifest, added: manifest.files.filter((file) => before.get(file.path) !== file.sha256).map((file) => file.path), removed: [...before.keys()].filter((original) => !after.has(original)) };
	sweepCandidates();
	if (!candidates.has(candidate.candidateSha256) && candidates.size >= 20) throw materialError("Too many material reviews are open. Finish a review or retry later.", 409);
	const buffered = [...candidates].reduce((sum, [key, entry]) => sum + (key === candidate.candidateSha256 ? 0 : [...entry.bytes.values()].reduce((size, file) => size + file.length, 0)), 0);
	if (buffered + [...bytes.values()].reduce((size, file) => size + file.length, 0) > 2 * LIBRARY_MATERIAL_MAX_BYTES) throw materialError("Material reviews reached their memory limit. Finish a review or retry later.", 409);
	candidates.set(candidate.candidateSha256, { candidate, bytes, createdAt: Date.now() });
	return candidate;
}

/** Build one immutable, explicitly selected material review without installing anything. */
export async function prepareLibraryMaterials(libraryId: string, token: string, paths: string[], expectedCurrentHash: string | null): Promise<LibraryMaterialsCandidate> {
	libraryDirectory(libraryId);
	if (expectedCurrentHash !== null && !HASH.test(expectedCurrentHash)) throw new Error("Invalid expected material version.");
	const scan = repositoryScanFromToken(token);
	if (scan.libraryId !== libraryId) throw new Error("Repository snapshot belongs to another library.");
	if (!Array.isArray(paths) || paths.length > LIBRARY_MATERIAL_MAX_FILES) throw new Error("Material selection exceeds the 2000-file limit.");
	const selected = paths.map((original) => materialPath(original, scan.policy));
	if (new Set(selected.map((original) => original.toLowerCase())).size !== selected.length) throw new Error("Duplicate material selection.");
	requireLibrarySnapshot(libraryId, canonicalManifest({ schemaVersion: 1, libraryId, source: scan.source, ref: scan.ref, revision: scan.revision, policy: scan.policy, files: [] }));
	if (currentLibraryMaterialsSha256(libraryId) !== expectedCurrentHash) throw materialError("Local source materials changed. Review them again.", 409);
	const bytes = new Map<string, Buffer>();
	const files: LibraryMaterialFile[] = [];
	let total = 0;
	await prefetchRepositoryMaterials(token, selected);
	reportRepositoryProgress("Verifying selected reference files", 0, selected.length);
	for (const original of selected) {
		const file = await readRepositoryMaterial(token, original);
		total += file.bytes.length;
		if (total > LIBRARY_MATERIAL_MAX_BYTES) throw new Error("Materials exceed the 128 MiB limit.");
		bytes.set(original, Buffer.from(file.bytes));
		files.push({ path: original, kind: file.kind, size: file.bytes.length, sha256: referenceBytesSha256(file.bytes), mimeType: file.mimeType });
		reportRepositoryProgress("Verifying selected reference files", files.length, selected.length);
	}
	let manifest = canonicalManifest({ schemaVersion: 1, libraryId, source: scan.source, ref: scan.ref, revision: scan.revision, policy: scan.policy, files });
	const previous = readLibraryMaterialsIndex(libraryId);
	if (previous && previous.source === manifest.source && previous.ref === manifest.ref && JSON.stringify(previous.policy) === JSON.stringify(manifest.policy) && previous.files.length === manifest.files.length && previous.files.every((file) => manifest.files.some((next) => next.path === file.path && next.kind === file.kind && next.size === file.size && next.sha256 === file.sha256 && next.mimeType === file.mimeType))) manifest = previous;
	validateManifest(manifest, libraryId, manifest.materialsSha256);
	requireLibrarySnapshot(libraryId, manifest);
	return candidateFor(manifest, bytes, expectedCurrentHash);
}

async function publishMaterials(pending: PendingMaterials, checkLibrary: boolean): Promise<LibraryMaterialsManifest> {
	const { manifest, expectedCurrentHash } = pending.candidate;
	validateManifest(manifest, manifest.libraryId, manifest.materialsSha256);
	if (referenceBytesSha256(Buffer.from(JSON.stringify({ manifest, expectedCurrentHash }))) !== pending.candidate.candidateSha256) throw new Error("Material review changed after preparation.");
	const base = libraryDirectory(manifest.libraryId);
	ensureRegularPath(base);
	fs.mkdirSync(base, { recursive: true, mode: 0o700 });
	const stage = fs.mkdtempSync(path.join(base, ".staging-"));
	let lock: PublishLock | undefined;
	let pointerTemporary: string | undefined;
	try {
		let savedFiles = 0;
		reportRepositoryProgress("Saving reviewed reference files", savedFiles, manifest.files.length);
		for (const file of manifest.files) {
			const bytes = pending.bytes.get(file.path);
			if (!bytes || bytes.length !== file.size || referenceBytesSha256(bytes) !== file.sha256) throw new Error("Material candidate changed after review.");
			const checked = await validateReferenceBuffer(file.path, bytes, manifest.policy);
			if (checked.kind !== file.kind || checked.mimeType !== file.mimeType) throw new Error("Material file type changed after review.");
			const target = path.join(stage, "files", ...file.path.split("/"));
			fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
			fs.writeFileSync(target, bytes, { mode: 0o600, flag: "wx" });
			reportRepositoryProgress("Saving reviewed reference files", ++savedFiles, manifest.files.length);
		}
		fs.writeFileSync(path.join(stage, "manifest.json"), `${JSON.stringify(manifest)}\n`, { mode: 0o600, flag: "wx" });
		lock = acquirePublishLock(path.join(base, ".publish.lock"));
		const verifyPublication = () => {
			const owner = readPublishLock(path.join(base, ".publish.lock"));
			if (owner.pid !== process.pid || owner.owner !== lock!.owner) throw materialError("The source-material save owner changed. Try again.", 409);
			if (checkLibrary) requireLibrarySnapshot(manifest.libraryId, manifest);
			else {
				const library = readSkillLibraries().find((entry) => entry.id === manifest.libraryId);
				if (!library || library.source !== manifest.source || library.ref !== manifest.ref) throw materialError("The source changed while its existing materials were being collected.", 409);
			}
			if (currentLibraryMaterialsSha256(manifest.libraryId) !== expectedCurrentHash) throw materialError("Local source materials changed. Review them again.", 409);
		};
		verifyPublication();
		const version = versionDirectory(manifest.libraryId, manifest.materialsSha256);
		ensureRegularPath(version);
		fs.mkdirSync(path.dirname(version), { recursive: true, mode: 0o700 });
		if (fs.existsSync(version)) {
			const existing = readLibraryMaterialsIndex(manifest.libraryId, manifest.materialsSha256)!;
			for (const file of existing.files) {
				const bytes = readFile(path.join(version, "files", ...file.path.split("/")), file.size);
				if (bytes.length !== file.size || referenceBytesSha256(bytes) !== file.sha256) throw new Error("Existing material version was altered; it was preserved.");
			}
		} else await renamePublishedPath(stage, version, verifyPublication);
		pointerTemporary = path.join(base, `.current-${crypto.randomUUID()}.tmp`);
		fs.writeFileSync(pointerTemporary, `${JSON.stringify({ schemaVersion: 1, materialsSha256: manifest.materialsSha256 })}\n`, { mode: 0o600, flag: "wx" });
		await renamePublishedPath(pointerTemporary, path.join(base, "current.json"), verifyPublication);
		return manifest;
	} finally {
		if (pointerTemporary) removePublicationTemporary(pointerTemporary);
		if (lock !== undefined) releasePublishLock(path.join(base, ".publish.lock"), lock);
		if (path.dirname(path.resolve(stage)) === path.resolve(base) && path.basename(stage).startsWith(".staging-")) removePublicationTemporary(stage, true);
	}
}
export async function acceptLibraryMaterials(libraryId: string, candidateSha256: string): Promise<LibraryMaterialsManifest> {
	sweepCandidates();
	const pending = candidates.get(candidateSha256);
	if (!pending || pending.candidate.manifest.libraryId !== libraryId) throw materialError("Material review expired or belongs to another source. Review it again.", 409);
	const result = await publishMaterials(pending, true);
	candidates.delete(candidateSha256);
	return result;
}

function resolveMaterialPath(manifest: LibraryMaterialsManifest, reference: string, from?: string, allowDirectory = false): string {
	if (from === undefined && manifest.files.some((file) => file.path === reference)) return reference;
	let raw: string;
	try { raw = decodeURIComponent(reference.split(/[?#]/)[0]); } catch { throw new Error("Invalid encoded material path."); }
	if (/[\\\x00-\x1f\x7f]/.test(raw) || raw.startsWith("/") || /^[a-z][a-z0-9+.-]*:/i.test(raw)) throw new Error("Material must be an accepted repository path.");
	let directory = "";
	if (from !== undefined) {
		if (!manifest.files.some((file) => file.path === from)) throw new Error("The link's source must be an accepted material file.");
		directory = path.posix.dirname(from);
	}
	const resolved = normalizeRepoPath(path.posix.normalize(path.posix.join(directory, raw)), allowDirectory);
	if (manifest.files.some((file) => file.path === resolved) || (allowDirectory && (resolved === "" || manifest.files.some((file) => file.path.startsWith(`${resolved}/`))))) return resolved;
	throw new Error("This material was not included in the reviewed source version.");
}
export async function readLibraryMaterialBytes(libraryId: string, materialsSha256: string, reference: string, from?: string) {
	const manifest = readLibraryMaterialsIndex(libraryId, materialsSha256);
	if (!manifest) throw new Error("This source has no reviewed materials.");
	const original = resolveMaterialPath(manifest, reference, from);
	const file = manifest.files.find((entry) => entry.path === original)!;
	const bytes = readFile(path.join(versionDirectory(libraryId, materialsSha256), "files", ...original.split("/")), file.size);
	if (bytes.length !== file.size || referenceBytesSha256(bytes) !== file.sha256) throw new Error("Source material changed since review.");
	const checked = await validateReferenceBuffer(original, bytes, manifest.policy);
	if (checked.kind !== file.kind || checked.mimeType !== file.mimeType) throw new Error("Source material no longer matches its reviewed type.");
	return { bytes, name: path.posix.basename(original), mimeType: file.mimeType, reference: { ...file, localPath: original } as SkillReferenceEntry, materialsSha256, source: manifest.source, revision: file.revision ?? manifest.revision };
}
export async function readLibraryMaterialReference(libraryId: string, materialsSha256: string, reference: string, options: SkillReferenceReadOptions = {}, model?: SkillReferenceModel): Promise<SkillReferenceReadResult> {
	const selected = await readLibraryMaterialBytes(libraryId, materialsSha256, reference, options.from);
	const result = await readReviewedReferenceBytes({ ...selected, packageSha256: materialsSha256, referenceTool: "read_library_reference" }, options, model);
	const { packageSha256: _package, ...details } = result.details ?? {};
	return { ...result, details: { ...details, materialsSha256, libraryId } };
}
export function listLibraryMaterialReferences(libraryId: string, materialsSha256: string, reference = "", options: Pick<SkillReferenceReadOptions, "from" | "offset" | "limit"> = {}) {
	const manifest = readLibraryMaterialsIndex(libraryId, materialsSha256);
	if (!manifest) throw new Error("This source has no reviewed materials.");
	const original = resolveMaterialPath(manifest, reference, options.from, true);
	const prefix = original ? `${original}/` : "";
	const selected = manifest.files.filter((file) => file.path === original || file.path.startsWith(prefix));
	const folders = [...new Set(selected.flatMap((file) => { const rest = file.path.slice(prefix.length); return rest.includes("/") ? [`${prefix}${rest.split("/")[0]}`] : []; }))].sort(compare);
	const files = selected.filter((file) => !file.path.slice(prefix.length).includes("/"));
	const offset = options.offset ?? 1;
	if (!Number.isSafeInteger(offset) || offset < 1) throw new Error("Invalid material listing offset.");
	const limit = options.limit === undefined ? 200 : Math.min(Math.floor(options.limit), 200);
	if (!Number.isFinite(limit) || limit < 1) throw new Error("Invalid material listing limit.");
	const entries = [...folders.map((folder) => ({ folder })), ...files.map((file) => ({ file }))];
	const shown = entries.slice(offset - 1, offset - 1 + limit);
	return { path: original, materialsSha256, folders: shown.flatMap((entry) => "folder" in entry ? [entry.folder] : []), files: shown.flatMap((entry) => "file" in entry ? [entry.file] : []), offset, total: entries.length, ...(offset - 1 + limit < entries.length ? { nextOffset: offset + limit } : {}) };
}

/** Existing reviewed selections can seed a source; disagreeing copies require explicit resolution. */
export async function seedLibraryMaterialsFromSkills(libraryId: string, skillDirs: string[]) {
	const existing = readLibraryMaterialsIndex(libraryId);
	if (existing) return { manifest: existing, conflicts: [], seeded: false };
	const library = readSkillLibraries().find((entry) => entry.id === libraryId);
	if (!library) throw new Error("Material source no longer exists.");
	const selected = new Map<string, { file: LibraryMaterialFile; bytes: Buffer; skills: string[] }>();
	const conflicts = new Map<string, string[]>();
	let revision = "";
	let totalBytes = 0;
	for (const dir of skillDirs) {
		const packet = readManagedSkillPackage(dir);
		if (!packet || (packet.repo.libraryId !== undefined && packet.repo.libraryId !== libraryId) || packet.repo.source !== library.source || packet.repo.ref !== library.ref) continue;
		revision ||= packet.repo.revision;
		for (const entry of packet.references) {
			materialPath(entry.path, packet.repo.policy);
			const bytes = packet.referenceBytes.get(entry.path)!;
			const digest = referenceBytesSha256(bytes);
			if (digest !== entry.sha256 || bytes.length !== entry.size) throw new Error("Existing skill reference changed since import; review it before seeding materials.");
			const checked = await validateReferenceBuffer(entry.path, bytes, packet.repo.policy);
			const previous = selected.get(entry.path.toLowerCase());
			if (previous) {
				previous.skills.push(path.basename(dir));
				if (conflicts.has(previous.file.path) || previous.file.sha256 !== digest || previous.file.path !== entry.path) conflicts.set(previous.file.path, [...previous.skills]);
			} else {
				totalBytes += bytes.length;
				if (totalBytes > LIBRARY_MATERIAL_MAX_BYTES || selected.size >= LIBRARY_MATERIAL_MAX_FILES) throw new Error("Existing selected materials exceed the source limits; choose a smaller selection.");
				selected.set(entry.path.toLowerCase(), { file: { path: entry.path, kind: checked.kind, size: bytes.length, sha256: digest, mimeType: checked.mimeType, revision: packet.repo.revision }, bytes, skills: [path.basename(dir)] });
			}
		}
	}
	if (conflicts.size) return { manifest: null, conflicts: [...conflicts].map(([original, skills]) => ({ path: original, skills })), seeded: false };
	if (!revision) return { manifest: null, conflicts: [], seeded: false };
	const policy = normalizeRepositoryFilePolicy({ designRepo: true, allowedTypes: [...new Set([...selected.values()].map((entry) => entry.file.kind))], skillRoot: "", referenceRoots: [""] });
	const manifest = canonicalManifest({ schemaVersion: 1, libraryId, source: library.source, ref: library.ref, revision, policy, files: [...selected.values()].map((entry) => entry.file) });
	validateManifest(manifest, libraryId, manifest.materialsSha256);
	const candidate = candidateFor(manifest, new Map([...selected.values()].map((entry) => [entry.file.path, entry.bytes])), null);
	try { return { manifest: await publishMaterials(candidates.get(candidate.candidateSha256)!, false), conflicts: [], seeded: true }; }
	finally { candidates.delete(candidate.candidateSha256); }
}
