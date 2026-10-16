import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { productAppStatePath } from "../../../pi-package/product-state-paths.js";
import { agentSkillsDir, computeSkillFilesDigest, readManagedSkillPackage, readSkillProvenance, type ManagedSkillPackage, type SkillRepoProvenance } from "./skills-store.js";
import { assertRepositoryBudget, fetchRepoCandidate, prefetchRepositoryMaterials, readRepositoryMaterial, removeCheckout, repositoryScanFromToken, repositorySnapshotObservedAt, RepositoryBudgetError, RepositoryFetchError, resolveRepoSource, scanRepository, withRepositoryBudget, type RepositoryScan, type ReviewedRepoSkillCandidate } from "./skills-repo-fetch.js";
import { normalizeRepositoryFilePolicy, referenceBytesSha256, validatedReferenceText, type RepositoryFilePolicy } from "./skills-file-policy.js";
import { normalizeRepositoryAccess, resolveRepositoryAccess, revokeRepositoryAccess, repositoryAccessSource, type RepositoryAccessSettings } from "./skills-repository-access.js";

export interface LibraryFileChange {
	path: string;
	status: "added" | "modified" | "removed";
	before?: string;
	after?: string;
}
export interface LibrarySkillUpdate {
	name: string;
	skillPath: string;
	status: "unchanged" | "changed" | "removed" | "local-conflict" | "new";
	localPackageSha256: string;
	changes?: LibraryFileChange[];
	error?: string;
}
export interface SkillLibrary extends RepositoryFilePolicy {
	repositoryAccess?: RepositoryAccessSettings;
	transport?: "git" | "api";
	id: string;
	name: string;
	source: string;
	ref?: string;
	lastCheckedAt?: string;
	lastSuccessfulCheckAt?: string;
	revision?: string;
	status: "unchecked" | "checking" | "current" | "updates" | "error";
	error?: string;
	updates?: LibrarySkillUpdate[];
	errorCode?: string;
	materialUpdates?: string[];
	checkedSnapshotAt?: number;
}
export type SkillLibraryInput = Partial<SkillLibrary> & { source: string };
export function skillBelongsToLibrary(repo: Pick<SkillRepoProvenance, "libraryId" | "source" | "ref"> | undefined, library: Pick<SkillLibrary, "id" | "source" | "ref">): boolean {
	if (!repo) return false;
	if (repo.libraryId !== undefined) return repo.libraryId === library.id;
	return repo.source === library.source && (repo.ref ?? "") === (library.ref ?? "");
}
const STATUS = new Set(["unchecked", "checking", "current", "updates", "error"]);
const checking = new Map<string, Promise<SkillLibrary>>();
const localGenerations = new Map<string, number>();

function hasInstalledUpdates(updates: LibrarySkillUpdate[], materials: string[] = []): boolean {
	return materials.length > 0 || updates.some((entry) => entry.status !== "unchanged" && entry.status !== "new");
}

/** An accepted import supersedes an in-flight check; unselected skills are discovery, not updates. */
export function recordSkillLibraryImport(id: string, revision: string, skillPath?: string): void {
	const initial = findLibrary(id);
	localGenerations.set(id, (localGenerations.get(id) ?? 0) + 1);
	if (initial.revision !== revision) {
		recordCheck(initial, { status: "unchecked", updates: undefined, materialUpdates: undefined, error: undefined });
		return;
	}
	const updates = (initial.updates ?? []).map((entry) => entry.skillPath === skillPath ? { ...entry, status: "unchanged" as const, changes: [], error: undefined } : entry);
	const materialUpdates = skillPath === undefined ? [] : initial.materialUpdates;
	recordCheck(initial, { updates: initial.updates ? updates : undefined, materialUpdates, status: hasInstalledUpdates(updates, materialUpdates) ? "updates" : initial.updates ? "current" : "unchecked", error: undefined });
}

function librariesPath(): string { return productAppStatePath("skill-libraries.json"); }

function normalizedLibrary(input: SkillLibraryInput, id: string): SkillLibrary {
	if (input.name !== undefined && typeof input.name !== "string") throw new Error("library name must be text");
	const policy = normalizeRepositoryFilePolicy(input);
	if (typeof input.source !== "string") throw new Error("library source must be a repository address");
	if (input.ref !== undefined && typeof input.ref !== "string") throw new Error("branch or tag must be text");
	const embeddedRef = input.source.includes("#") ? input.source.slice(input.source.indexOf("#") + 1).trim() : undefined;
	const ref = input.ref?.trim() || embeddedRef;
	if (ref && (ref.length > 255 || /[\s\x00-\x1f~^:?*\[\\]|\.\.|@\{|\/\//.test(ref) || ref.startsWith("-") || ref.endsWith("/") || ref.endsWith("."))) throw new Error("invalid branch or tag");
	const resolved = resolveRepoSource(input.source.split("#")[0], { allowLocal: process.env.EXXETA_SKILLS_ALLOW_LOCAL_REPO === "1" });
	if (!resolved.ok) throw new Error(resolved.error);
	// Libraries never persist URL credentials, even when a transient direct import accepts them.
	if (resolved.value.cloneArg !== resolved.value.display) throw new Error("library addresses must not contain credentials; use the sign-in stored by git");
	const name = input.name?.trim() || resolved.value.display.replace(/\/+$/, "").split(/[/\\:]/).pop()!.replace(/\.git$/i, "");
	if (!name || name.length > 120 || /[\x00-\x1f\x7f]/.test(name)) throw new Error("library name must contain 1–120 readable characters");
	return { id, name, source: resolved.value.display, ...(ref ? { ref } : {}), ...policy, repositoryAccess: normalizeRepositoryAccess(input.repositoryAccess), status: "unchecked" };
}

/** Corrupt state is an error, never an empty list that a later save could overwrite. */
export function readSkillLibraries(): SkillLibrary[] {
	const file = librariesPath();
	if (!fs.existsSync(file)) return [];
	let parsed: unknown;
	try { parsed = JSON.parse(fs.readFileSync(file, "utf8")); } catch { throw new Error("Skill library configuration cannot be read. Preserve and repair the file before saving."); }
	if (!Array.isArray(parsed) || parsed.length > 100) throw new Error("Invalid skill library configuration; existing data was preserved.");
	const ids = new Set<string>();
	return parsed.map((raw) => {
		if (!raw || typeof raw !== "object" || typeof raw.name !== "string" || !raw.name.trim() || typeof raw.id !== "string" || !/^[a-zA-Z0-9-]{1,80}$/.test(raw.id) || ids.has(raw.id) || !STATUS.has(raw.status)) throw new Error("Invalid skill library record; existing data was preserved.");
		ids.add(raw.id);
		const clean = normalizedLibrary(raw, raw.id);
		return { ...clean, ...raw, ...normalizeRepositoryFilePolicy(raw), repositoryAccess: clean.repositoryAccess, source: clean.source, ref: clean.ref, status: raw.status === "checking" && !checking.has(raw.id) ? "unchecked" : raw.status } as SkillLibrary;
	});
}

function writeLibraries(libraries: SkillLibrary[]): void {
	const file = librariesPath();
	fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
	const temporary = `${file}.${crypto.randomUUID()}.tmp`;
	try {
		fs.writeFileSync(temporary, `${JSON.stringify(libraries, null, 2)}\n`, { mode: 0o600, flag: "wx" });
		fs.renameSync(temporary, file);
	} finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
}

export function saveSkillLibrary(input: SkillLibraryInput): SkillLibrary {
	const libraries = readSkillLibraries();
	const existing = input.id ? libraries.find((library) => library.id === input.id) : undefined;
	if (input.id && !existing) throw new Error("skill library no longer exists");
	if (!existing && libraries.length >= 100) throw new Error("the 100-library limit was reached");
	const normalized = normalizedLibrary({ ...input, repositoryAccess: input.repositoryAccess ?? existing?.repositoryAccess }, existing?.id ?? crypto.randomUUID());
	if (existing && repositoryAccessSource(existing.source) !== repositoryAccessSource(normalized.source)) {
		revokeRepositoryAccess(existing.source, existing.id); normalized.repositoryAccess = undefined;
	}
	if (existing && JSON.stringify(existing.repositoryAccess && { ...existing.repositoryAccess, checkOnStartup: false }) !== JSON.stringify(normalized.repositoryAccess && { ...normalized.repositoryAccess, checkOnStartup: false })) revokeRepositoryAccess(existing.source, existing.id);
	const library = existing && libraryConfiguration(existing) === libraryConfiguration(normalized) ? { ...existing, ...normalized, status: existing.status } : normalized;
	if (existing) libraries[libraries.indexOf(existing)] = library;
	else libraries.push(library);
	writeLibraries(libraries);
	return library;
}

export function deleteSkillLibrary(id: string): boolean {
	const libraries = readSkillLibraries();
	const remaining = libraries.filter((library) => library.id !== id);
	if (remaining.length === libraries.length) return false;
	const removed = libraries.find((library) => library.id === id)!;
	revokeRepositoryAccess(removed.source, id);
	writeLibraries(remaining);
	return true;
}

export function resetSkillLibraryAccess(id: string): SkillLibrary {
	const libraries = readSkillLibraries();
	const library = libraries.find((entry) => entry.id === id);
	if (!library) throw new Error("Skill library no longer exists.");
	revokeRepositoryAccess(library.source, id);
	delete library.repositoryAccess;
	library.status = "unchecked"; delete library.error; delete library.errorCode;
	localGenerations.set(id, (localGenerations.get(id) ?? 0) + 1);
	writeLibraries(libraries); return library;
}

function findLibrary(id: string): SkillLibrary {
	const library = readSkillLibraries().find((entry) => entry.id === id);
	if (!library) throw new Error("skill library no longer exists");
	return library;
}
function librarySource(library: SkillLibrary): string { return library.ref ? `${library.source}#${library.ref}` : library.source; }
function libraryConfiguration(library: SkillLibrary): string { return JSON.stringify({ source: library.source, ref: library.ref, policy: normalizeRepositoryFilePolicy(library), repositoryAccess: library.repositoryAccess }); }

export async function scanSkillLibrary(id: string, options?: { forceRefresh?: boolean; token?: string }): Promise<RepositoryScan> {
	const library = findLibrary(id);
	return scanRepository(librarySource(library), library, id, process.env.EXXETA_SKILLS_ALLOW_LOCAL_REPO === "1", { ...options, repositoryAccess: library.repositoryAccess });
}

function installedLibrarySkills(libraryId: string): Array<{ name: string; dir: string; package: ManagedSkillPackage | null; error?: string }> {
	const library = findLibrary(libraryId);
	const root = agentSkillsDir();
	if (!fs.existsSync(root)) return [];
	const result: Array<{ name: string; dir: string; package: ManagedSkillPackage | null; error?: string }> = [];
	for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
		if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
		const dir = path.join(root, entry.name);
		const provenance = readSkillProvenance(dir);
		if (!provenance || !skillBelongsToLibrary(provenance.repo, library)) continue;
		try {
			const managed = readManagedSkillPackage(dir);
			const digest = computeSkillFilesDigest(dir);
			if (!managed || !digest || !provenance.filesSha256 || digest.filesSha256 !== provenance.filesSha256 || referenceBytesSha256(Buffer.from(managed.manifest)) !== provenance.sha256 || managed.references.some((ref) => referenceBytesSha256(managed.referenceBytes.get(ref.path)!) !== ref.sha256)) {
				result.push({ name: entry.name, dir, package: managed, error: "local package changed; preserve local edits and review the conflict before updating" });
			} else result.push({ name: entry.name, dir, package: managed });
		} catch (error) { result.push({ name: entry.name, dir, package: null, error: error instanceof Error ? error.message : "local package cannot be read" }); }
	}
	return result;
}

function referencePreview(bytes: Buffer, kind: string, sha256: string): string {
	if (["markdown", "text", "styles", "html", "svg"].includes(kind)) {
		try { return validatedReferenceText(bytes); } catch { return "Text reference is no longer valid."; }
	}
	return `${kind} asset; ${bytes.length} bytes; SHA-256 ${sha256}`;
}

function updateChanges(managed: ManagedSkillPackage, candidate: ReviewedRepoSkillCandidate): LibraryFileChange[] {
	const changes: LibraryFileChange[] = [];
	if (managed.manifest !== candidate.manifest) changes.push({ path: "SKILL.md", status: "modified", before: managed.manifest, after: candidate.manifest });
	const before = new Map(managed.references.map((ref) => [ref.path, ref]));
	const after = new Map(candidate.references.map((ref) => [ref.path, ref]));
	for (const original of Array.from(new Set([...before.keys(), ...after.keys()])).sort()) {
		const old = before.get(original);
		const next = after.get(original);
		if (old?.sha256 === next?.sha256 && old?.localPath === next?.localPath && old?.kind === next?.kind) continue;
		changes.push({ path: original, status: !old ? "added" : !next ? "removed" : "modified", ...(old ? { before: referencePreview(managed.referenceBytes.get(original)!, old.kind, old.sha256) } : {}), ...(next ? { after: next.preview ?? `${next.kind} asset; ${next.size} bytes; SHA-256 ${next.sha256}` } : {}) });
	}
	return changes;
}

async function summarizeSkill(scan: RepositoryScan, installed: ReturnType<typeof installedLibrarySkills>[number], referencesOverride?: string[]): Promise<{ update: LibrarySkillUpdate; candidate?: ReviewedRepoSkillCandidate }> {
	const managed = installed.package;
	const skillPath = managed?.repo.skillPath ?? readSkillProvenance(installed.dir)?.repo?.skillPath ?? "";
	const base = { name: installed.name, skillPath, localPackageSha256: managed?.packageSha256 ?? "" };
	if (installed.error || !managed) return { update: { ...base, status: "local-conflict", error: installed.error ?? "local package is unavailable" } };
	if (!scan.skills.some((skill) => skill.path === skillPath)) return { update: { ...base, status: "removed", error: "skill was removed from the repository; the installed copy is preserved" } };
	try {
		const candidate = await fetchRepoCandidate(scan.token, skillPath, referencesOverride ?? managed.references.map((ref) => ref.path));
		const changes = updateChanges(managed, candidate);
		if (managed.repo.libraryId !== scan.libraryId) changes.push({ path: "[repository library]", status: "modified", before: managed.repo.libraryId ?? "Unassigned", after: scan.libraryId });
		const policyChanged = JSON.stringify(normalizeRepositoryFilePolicy(managed.repo.policy)) !== JSON.stringify(normalizeRepositoryFilePolicy(scan.policy));
		if (policyChanged) changes.push({ path: "[reference policy]", status: "modified", before: JSON.stringify(managed.repo.policy), after: JSON.stringify(scan.policy) });
		return { candidate, update: { ...base, status: changes.length ? "changed" : "unchanged", changes } };
	} catch (error) {
		if (error instanceof RepositoryBudgetError || error instanceof RepositoryFetchError || String((error as any)?.code ?? "").startsWith("REPOSITORY_")) throw error;
		const removed = managed.references.filter((reference) => !scan.files.some((file) => file.path === reference.path));
		return { update: { ...base, status: "changed", changes: removed.map((reference) => ({ path: reference.path, status: "removed", before: referencePreview(managed.referenceBytes.get(reference.path)!, reference.kind, reference.sha256) })), error: error instanceof Error ? error.message : "selected remote files are unavailable" } };
	}
}

function recordCheck(initial: SkillLibrary, patch: Partial<SkillLibrary>): SkillLibrary {
	const libraries = readSkillLibraries();
	const current = libraries.find((entry) => entry.id === initial.id);
	if (!current) throw new Error("library was removed while checking");
	if (libraryConfiguration(current) !== libraryConfiguration(initial)) return current;
	const next = { ...current, ...patch };
	libraries[libraries.indexOf(current)] = next;
	writeLibraries(libraries);
	return next;
}

async function performLibraryCheck(id: string): Promise<SkillLibrary> {
	const initial = findLibrary(id);
	const generation = localGenerations.get(id) ?? 0;
	const attempted = new Date().toISOString();
	recordCheck(initial, { status: "checking", lastCheckedAt: attempted, error: undefined, errorCode: undefined });
	let scan: RepositoryScan | undefined;
	try {
		scan = await scanSkillLibrary(id, { forceRefresh: true });
		const result = await compareInstalledSelection(id, scan);
		if (generation !== (localGenerations.get(id) ?? 0)) return findLibrary(id);
		return recordCheck(initial, { ...result, lastCheckedAt: attempted, lastSuccessfulCheckAt: new Date().toISOString(), checkedSnapshotAt: repositorySnapshotObservedAt(scan.token), revision: scan.revision, transport: scan.transport, error: undefined, errorCode: undefined });
	} catch (error) {
		if (generation !== (localGenerations.get(id) ?? 0)) return findLibrary(id);
		return recordCheck(initial, { lastCheckedAt: attempted, status: "error", error: error instanceof Error ? error.message : "repository check failed", errorCode: ["REPOSITORY_AUTH_REQUIRED", "REPOSITORY_ACCESS_REQUIRED", "GIT_REQUIRED"].includes((error as { code?: string })?.code ?? "") ? (error as { code: string }).code : undefined });
	} finally { if (scan) removeCheckout(scan.token); }
}

async function compareInstalledSelection(id: string, scan: RepositoryScan): Promise<Pick<SkillLibrary, "updates" | "materialUpdates" | "status">> {
	const installed = installedLibrarySkills(id);
	const updates: LibrarySkillUpdate[] = [];
	for (const entry of installed) { assertRepositoryBudget(); updates.push((await summarizeSkill(scan, entry)).update); }
	for (const skill of scan.skills) {
		if (!installed.some((entry) => entry.package?.repo.skillPath === skill.path)) updates.push({ name: skill.name, skillPath: skill.path, status: "new", localPackageSha256: "" });
	}
	const { readLibraryMaterialsIndex } = await import("./skills-library-materials.js");
	const materialUpdates: string[] = [];
	const files = readLibraryMaterialsIndex(id)?.files ?? [];
	await prefetchRepositoryMaterials(scan.token, files.filter((file) => scan.files.some((remote) => remote.path === file.path && remote.allowed)).map((file) => file.path));
	for (const file of files) {
		assertRepositoryBudget();
		try {
			const remote = await readRepositoryMaterial(scan.token, file.path);
			if (referenceBytesSha256(remote.bytes) !== file.sha256) materialUpdates.push(file.path);
		} catch (error) {
			if (error instanceof RepositoryBudgetError || error instanceof RepositoryFetchError || String((error as any)?.code ?? "").startsWith("REPOSITORY_")) throw error;
			materialUpdates.push(file.path);
		}
	}
	return { updates, materialUpdates, status: hasInstalledUpdates(updates, materialUpdates) ? "updates" : "current" };
}

/** Reconcile once from the reviewed snapshot; only a newer remote check requires another fetch. */
export async function refreshSkillLibraryFromSnapshot(id: string, token: string): Promise<SkillLibrary> {
	const initial = findLibrary(id);
	const scan = repositoryScanFromToken(token);
	if (scan.libraryId !== id || scan.source !== initial.source || scan.ref !== initial.ref || JSON.stringify(scan.policy) !== JSON.stringify(normalizeRepositoryFilePolicy(initial))) throw new Error("The source configuration changed. Review it again.");
	const generation = (localGenerations.get(id) ?? 0) + 1;
	localGenerations.set(id, generation);
	const observedAt = repositorySnapshotObservedAt(token);
	if (initial.revision !== scan.revision && (initial.checkedSnapshotAt ?? 0) > observedAt) {
		// A review may predate a newer remote check; do not advertise that older snapshot as current.
		await checking.get(id);
		return checkSkillLibrary(id);
	}
	return withRepositoryBudget(async () => {
		const result = await compareInstalledSelection(id, scan);
		return generation === localGenerations.get(id) ? recordCheck(initial, { ...result, revision: scan.revision, transport: scan.transport, checkedSnapshotAt: observedAt, error: undefined, errorCode: undefined }) : findLibrary(id);
	});
}

let activeChecks = 0;
const checkQueue: Array<() => void> = [];
async function limitedCheck(id: string): Promise<SkillLibrary> {
	if (activeChecks >= 2) await new Promise<void>((resolve) => checkQueue.push(resolve));
	else activeChecks += 1;
	try { return await withRepositoryBudget(() => performLibraryCheck(id)); }
	finally {
		const next = checkQueue.shift();
		if (next) next();
		else activeChecks -= 1;
	}
}

/** Startup and manual calls share both source deduplication and the two-source cap. */
export function checkSkillLibrary(id: string): Promise<SkillLibrary> {
	const existing = checking.get(id);
	if (existing) return existing;
	const promise = limitedCheck(id).finally(() => checking.delete(id));
	checking.set(id, promise);
	return promise;
}

export async function checkAllSkillLibraries(): Promise<SkillLibrary[]> {
	const results = await Promise.allSettled(readSkillLibraries().filter((library) => library.repositoryAccess?.consentVersion === 1 && library.repositoryAccess.checkOnStartup).map((library) => {
		try { resolveRepositoryAccess(library.source, library.id, library.repositoryAccess); }
		catch { return recordCheck(library, { status: "error", error: "Repository access is required before updates can be checked.", errorCode: "REPOSITORY_ACCESS_REQUIRED" }); }
		return checkSkillLibrary(library.id);
	}));
	return results.flatMap((result) => result.status === "fulfilled" ? [result.value] : []);
}

/** Refreshes an update into a review token; no installation or room pin is changed. */
export async function prepareLibraryUpdate(id: string, name: string, referencesOverride?: string[], snapshotToken?: string): Promise<{ token: string; candidate: ReviewedRepoSkillCandidate; update: LibrarySkillUpdate }> {
	let token: string | undefined;
	try {
		return await withRepositoryBudget(async () => {
			const installed = installedLibrarySkills(id).find((entry) => entry.name === name);
			if (!installed) throw new Error("this skill is not installed from the selected library");
			const library = findLibrary(id);
			const scan = snapshotToken ? repositoryScanFromToken(snapshotToken) : await scanSkillLibrary(id);
			if (scan.libraryId !== id || scan.source !== library.source || scan.ref !== library.ref || JSON.stringify(scan.policy) !== JSON.stringify(normalizeRepositoryFilePolicy(library))) throw new Error("The source configuration changed since this scan. Scan the library again.");
			token = scan.token;
			const result = await summarizeSkill(scan, installed, referencesOverride);
			if (!result.candidate || result.update.status === "local-conflict" || result.update.status === "removed") throw new Error(result.update.error ?? "update cannot be prepared");
			return { token: scan.token, candidate: result.candidate, update: result.update };
		});
	} catch (error) { if (token && !snapshotToken) removeCheckout(token); throw error; }
}
