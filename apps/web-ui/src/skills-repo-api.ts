// Repository library client. Types mirror
// the server's `skills-repo-fetch.ts` shapes but are declared locally so the UI
// never imports that server-only (child_process) module. Uses the shared
// `fetchJson` so {error} bodies surface as thrown Errors the panes can render.
import { apiFetch, ApiRequestError, apiErrorCode, fetchJson } from "./api";
import { invalidateSkillSummaries } from "./skills-api";
import { createDisplayCache } from "./display-cache";
import type { PersistentRoomSourceReview } from "./persistent-room-management-api";

export type RepositoryAccessMode = "anonymous" | "local-git" | "session-token";
export interface RepositoryAccessContext { libraryId?: string; accessId?: string; provider?: "github" | "gitlab"; apiBaseUrl?: string }
export interface RepositoryAccessSettings {
	mode: RepositoryAccessMode;
	rememberLocalAccess: boolean;
	checkOnStartup: boolean;
	consentVersion: 1;
	provider?: "github" | "gitlab";
	apiBaseUrl?: string;
}
export interface RepositorySignInStatus {
	host: string;
	provider: "github" | "gitlab" | null;
	ready: boolean;
	issues: string[];
	setupCommands: string[];
	documentation: string;
	gitAvailable: boolean;
	mode: RepositoryAccessMode;
	granted: boolean;
	confirmed: boolean;
	rememberLocalAccess: boolean;
	checkOnStartup: boolean;
	accessId?: string;
	apiBaseUrl?: string;
}
export function repositorySignInStatus(source: string, context: RepositoryAccessContext = {}, signal?: AbortSignal): Promise<RepositorySignInStatus> {
	return fetchJson("/api/skills/repo/auth/status", { ...jsonPost({ source, ...context }), signal });
}
export async function setRepositoryAccess(source: string, context: RepositoryAccessContext, settings: Omit<RepositoryAccessSettings, "consentVersion"> & { token?: string }): Promise<RepositorySignInStatus> {
	const result = await fetchJson<RepositorySignInStatus>("/api/skills/repo/access", jsonPost({ source, ...context, ...settings }));
	invalidateSkillLibraries();
	return result;
}
export async function revokeRepositoryAccess(source: string, context: RepositoryAccessContext): Promise<RepositorySignInStatus> {
	const result = await fetchJson<RepositorySignInStatus>("/api/skills/repo/access/revoke", jsonPost({ source, ...context }));
	invalidateSkillLibraries();
	return result;
}
export function signInToRepository(source: string, provider: "github" | "gitlab", signal: AbortSignal, context: RepositoryAccessContext & { allowCredentialStorage: boolean }): Promise<{ signedIn: boolean }> {
	return fetchJson("/api/skills/repo/auth/login", { ...jsonPost({ source, provider, ...context }), signal });
}
export function isRepositorySignInRequired(error: unknown): boolean {
	return ["REPOSITORY_AUTH_REQUIRED", "REPOSITORY_ACCESS_REQUIRED", "GIT_REQUIRED"].includes(apiErrorCode(error) ?? "") || (error instanceof Error && /authentication failed|needs a sign-in|turned down the sign-in|refused access to this repository|repository.*not found|terminal prompts disabled/i.test(error.message));
}

/** One invisible/zero-width/bidi character flagged in a skill body (spec §7 must 1). */
export interface InvisibleUnicodeFinding {
	index: number;
	codePoint: number;
	label: string;
	category: "zero-width" | "bidi" | "invisible";
}

export interface InvisibleUnicodeScan {
	count: number;
	findings: InvisibleUnicodeFinding[];
}

/** A skill discovered in a scanned repo (the multi-select / Browse card). */
export interface RepoFoundSkill {
	originalName?: string;
	referencePaths?: string[];
	path: string;
	name: string;
	description: string;
	license: string | null;
	hasBundledScripts: boolean;
}

export type ReferenceKind = "markdown" | "text" | "styles" | "html" | "svg" | "pdf" | "word" | "excel" | "images" | "fonts";

export interface RepoPolicy {
	designRepo: boolean;
	allowedTypes: ReferenceKind[];
	skillRoot: string;
	referenceRoots: string[];
}

export const defaultRepoPolicy: RepoPolicy = { designRepo: false, allowedTypes: ["markdown"], skillRoot: "", referenceRoots: [] };

function normalizedPolicy(policy: RepoPolicy): RepoPolicy {
	return { designRepo: policy.designRepo, allowedTypes: policy.allowedTypes, skillRoot: policy.skillRoot.trim(), referenceRoots: policy.referenceRoots.map((root) => root === "" ? "." : root.trim()).filter(Boolean) };
}

export interface RepoFile {
	path: string;
	kind: ReferenceKind | null;
	allowed: boolean;
	reason?: string;
}

export interface SkillReference {
	path: string;
	description?: string;
	localPath: string;
	kind: ReferenceKind;
	size: number;
	sha256: string;
	preview?: string;
}

export interface SkillFilePreviewData {
	path: string;
	kind: ReferenceKind;
	size: number;
	text?: string;
	mimeType?: string;
	base64?: string;
}

export function previewRepoFile(token: string, reference: string): Promise<SkillFilePreviewData> {
	return fetchJson("/api/skills/repo/preview", jsonPost({ token, reference }));
}

export function previewInstalledReference(name: string, reference: string): Promise<SkillFilePreviewData> {
	return fetchJson(`/api/skills/${encodeURIComponent(name)}/references/${encodeURIComponent(reference)}/preview`);
}

export interface SkillRepoProvenance {
	libraryId?: string;
	source: string;
	ref?: string;
	revision: string;
	skillPath: string;
	policy: RepoPolicy;
	references: SkillReference[];
}

/** The review-screen candidate (the MR-3 seam contract shape). */
export interface RepoSkillCandidate {
	originalName?: string;
	name: string;
	description: string;
	body: string;
	source: string;
	license: string | null;
	scanFindings: InvisibleUnicodeScan;
	bundledScripts: string[];
	revision: string;
	skillPath: string;
	references: SkillReference[];
	reviewSha256: string;
}

export interface RepoScanResponse {
	transport?: "git" | "api";
	accessId?: string;
	/** Checkout token — review + accept reuse it so the accepted body matches the reviewed one. */
	token: string;
	source: string;
	ref?: string;
	libraryId?: string;
	skills: RepoFoundSkill[];
	revision: string;
	files: RepoFile[];
	policy: RepoPolicy;
}

export interface RepoMaterialSuggestion extends RepoFile { skillPaths: string[]; selected: boolean }
export interface RepoDiscoveryProposal {
	token: string;
	source: string;
	revision: string;
	referenced: RepoMaterialSuggestion[];
	additional: RepoMaterialSuggestion[];
	formats: Array<{ kind: ReferenceKind; total: number; referenced: number; additional: number; enabled: boolean }>;
	missing: Array<{ path: string; from: string; skillPath: string }>;
	excludedCounts: Record<string, number>;
	warnings: string[];
	incomplete: boolean;
}

export function discoverRepoMaterials(token: string, skillPaths: string[], progressId?: string): Promise<RepoDiscoveryProposal> {
	return fetchJson("/api/skills/repo/discovery", jsonPost({ token, skillPaths, progressId }));
}

export interface RepositoryProgress { message: string; completed?: number; total?: number; status?: "running" | "complete" | "failed" }

/** Progress is optional display data; losing it never cancels a review or import. */
export async function withRepositoryProgress<T>(work: (id: string) => Promise<T>, onProgress: (progress: RepositoryProgress) => void, signal?: AbortSignal): Promise<T> {
	const id = crypto.randomUUID();
	let active = true;
	let polling = false;
	const timer = setInterval(() => {
		if (polling) return;
		polling = true;
		void fetchJson<{ progress: RepositoryProgress }>(`/api/skills/repo/progress/${id}`).then(({ progress }) => { if (active) onProgress(progress); }).catch(() => {}).finally(() => { polling = false; });
	}, 500);
	const stop = () => { active = false; clearInterval(timer); };
	signal?.addEventListener("abort", stop, { once: true });
	if (signal?.aborted) stop();
	try { return await work(id); }
	finally { stop(); signal?.removeEventListener("abort", stop); }
}

export interface RepoImportResponse {
	skill: { name: string; description: string; source: string } | null;
	provenance: { source: string; importedAt: string; license: string | null; sha256: string };
	bundledCopied: number;
}

/** Build the review candidate for one skill in a scanned repo (runs the invisible-unicode scan). */
export function fetchRepoCandidate(token: string, skillPath: string, references: string[] = [], progressId?: string): Promise<RepoSkillCandidate> {
	return fetchJson<RepoSkillCandidate>("/api/skills/repo/candidate", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ token, path: skillPath, references, progressId }),
	});
}

/** Accept + persist a reviewed skill into the library (provenance sidecar + pinned hash). */
export async function importRepoSkill(token: string, skillPath: string, references: string[], reviewSha256: string): Promise<RepoImportResponse> {
	const result = await fetchJson<RepoImportResponse>("/api/skills/repo/import", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ token, path: skillPath, references, reviewSha256 }),
	});
	invalidateSkillSummaries();
	invalidateSkillLibraries();
	return result;
}

export interface SkillLibrary extends RepoPolicy {
	repositoryAccess?: RepositoryAccessSettings;
	transport?: "git" | "api";
	errorCode?: string;
	id: string;
	name: string;
	source: string;
	ref?: string;
	lastCheckedAt?: string;
	lastSuccessfulCheckAt?: string;
	revision?: string;
	status: "unchecked" | "checking" | "current" | "updates" | "error";
	error?: string;
	materialCount?: number;
	materialsSha256?: string;
	installedSkillCount?: number;
	materialUpdates?: string[];
}

export interface LibraryMaterialsManifest {
	schemaVersion: 1;
	libraryId: string;
	materialsSha256: string;
	source: string;
	ref?: string;
	revision: string;
	policy: RepoPolicy;
	files: Array<{ path: string; kind: ReferenceKind; size: number; sha256: string; mimeType: string }>;
}
export interface LibraryMaterialsCandidate {
	candidateSha256: string;
	expectedCurrentHash: string | null;
	manifest: LibraryMaterialsManifest;
	added: string[];
	removed: string[];
}

export function fetchLibraryMaterials(id: string, materialsSha256?: string): Promise<{ manifest: LibraryMaterialsManifest | null }> {
	return fetchJson(`/api/skills/libraries/${encodeURIComponent(id)}/materials${materialsSha256 ? `?version=${encodeURIComponent(materialsSha256)}` : ""}`);
}
export function prepareLibraryMaterials(id: string, token: string, references: string[], expectedCurrentHash: string | null, progressId?: string): Promise<LibraryMaterialsCandidate> {
	return fetchJson(`/api/skills/libraries/${encodeURIComponent(id)}/materials/candidate`, jsonPost({ token, references, expectedCurrentHash, progressId }));
}
export async function acceptLibraryMaterials(id: string, candidateSha256: string, progressId?: string): Promise<{ manifest: LibraryMaterialsManifest }> {
	const result = await fetchJson<{ manifest: LibraryMaterialsManifest }>(`/api/skills/libraries/${encodeURIComponent(id)}/materials/accept`, jsonPost({ candidateSha256, progressId }));
	invalidateSkillLibraries();
	return result;
}
export function previewLibraryMaterial(id: string, hash: string, reference: string): Promise<SkillFilePreviewData> {
	return fetchJson(`/api/skills/libraries/${encodeURIComponent(id)}/materials/${encodeURIComponent(hash)}/preview`, jsonPost({ reference }));
}

export function fetchFeaturedCatalog(): Promise<{ sources: Array<{ source: string; author: string }> }> {
	return fetchJson("/api/skills/featured?view=catalog");
}

export type SkillLibraryInput = Pick<SkillLibrary, "name" | "source" | "ref" | "designRepo" | "allowedTypes" | "skillRoot" | "referenceRoots">;

export interface SkillLibraryUpdate {
	name: string;
	skillPath: string;
	status: "unchanged" | "changed" | "removed" | "local-conflict" | "new";
	localPackageSha256?: string;
	error?: string;
}

export interface SkillUpdateCandidate extends RepoSkillCandidate {
	token: string;
	localPackageSha256: string;
	changes: { path: string; status: "added" | "modified" | "removed"; before?: string; after?: string }[];
	affectedRooms: { id: string; name: string }[];
}

const librariesPath = "/api/skills/libraries";
const libraryPath = (id: string) => `${librariesPath}/${encodeURIComponent(id)}`;
const jsonPost = (value: unknown) => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(value) });

const libraryCache = createDisplayCache<{ libraries: SkillLibrary[] }>();
export const peekSkillLibraries = () => libraryCache.peek();
export const invalidateSkillLibraries = () => { libraryCache.invalidate(); if (typeof window !== "undefined") window.dispatchEvent(new window.Event("skill-libraries-changed")); };

export function fetchSkillLibraries(options?: { refresh?: boolean }): Promise<{ libraries: SkillLibrary[] }> {
	return libraryCache.load(() => fetchJson(librariesPath), options?.refresh);
}

export async function saveSkillLibrary(input: SkillLibraryInput, id?: string): Promise<{ library: SkillLibrary }> {
	const result = await fetchJson<{ library: SkillLibrary }>(id ? libraryPath(id) : librariesPath, { ...jsonPost({ name: input.name.trim(), source: input.source.trim(), ref: input.ref?.trim() || undefined, ...normalizedPolicy(input) }), method: id ? "PUT" : "POST" });
	invalidateSkillLibraries();
	return result;
}

export async function deleteSkillLibrary(id: string): Promise<{ deleted: boolean }> {
	const result = await fetchJson<{ deleted: boolean }>(libraryPath(id), { method: "DELETE" });
	invalidateSkillLibraries();
	return result;
}

export function scanSkillLibrary(id: string, options?: { forceRefresh?: boolean; token?: string; progressId?: string; accessId?: string }): Promise<RepoScanResponse> {
	return fetchJson(`${libraryPath(id)}/scan`, jsonPost(options ?? {}));
}

export async function checkSkillLibrary(id: string): Promise<{ library: SkillLibrary; updates: SkillLibraryUpdate[] }> {
	const result = await fetchJson<{ library: SkillLibrary; updates: SkillLibraryUpdate[] }>(`${libraryPath(id)}/check`, jsonPost({}));
	invalidateSkillLibraries();
	return result;
}

export async function reconcileSkillLibrary(id: string, token: string): Promise<void> {
	await fetchJson(`${libraryPath(id)}/reconcile`, jsonPost({ token }));
	invalidateSkillLibraries();
}

export interface LibraryRoomsReview extends PersistentRoomSourceReview {
	reviewSha256: string;
	rooms: Array<{ id: string; name: string; busy: boolean; enabledSkills: string[]; independentSkills: string[]; changes: {
		total: number;
		skills: Array<{ name: string; status: "added" | "changed" | "removed"; instructionsChanged: boolean; enabled: boolean }>;
		references: Array<{ path: string; status: "added" | "changed" | "removed" | "review"; beforeVersion?: string; afterVersion?: string }>;
		referenceVersionChanged: boolean;
		previousReferencesUnavailable: boolean;
	} }>;
}
export function fetchLibraryRoomsReview(id: string): Promise<LibraryRoomsReview> {
	return fetchJson(`${libraryPath(id)}/rooms/review`);
}
export async function applyLibraryRoomsReview(id: string, reviewSha256: string, roomIds: string[]): Promise<{ updated: string[]; failures: Array<{ id: string; name: string; error: string }> }> {
	const result = await fetchJson<{ updated: string[]; failures: Array<{ id: string; name: string; error: string }> }>(`${libraryPath(id)}/rooms/apply`, jsonPost({ reviewSha256, roomIds }));
	invalidateSkillLibraries();
	return result;
}

export function fetchSkillUpdateCandidate(id: string, name: string, references?: string[], token?: string, progressId?: string): Promise<SkillUpdateCandidate> {
	return fetchJson(`${libraryPath(id)}/updates/${encodeURIComponent(name)}/candidate`, jsonPost({ ...(references ? { references } : {}), ...(token ? { token } : {}), progressId }));
}

export async function applySkillLibraryUpdate(id: string, name: string, candidate: SkillUpdateCandidate): Promise<Pick<RepoImportResponse, "skill">> {
	const result = await fetchJson<Pick<RepoImportResponse, "skill">>(`${libraryPath(id)}/updates/${encodeURIComponent(name)}/apply`, jsonPost({
		token: candidate.token,
		path: candidate.skillPath,
		references: candidate.references.map((reference) => reference.path),
		reviewSha256: candidate.reviewSha256,
		localPackageSha256: candidate.localPackageSha256,
	}));
	invalidateSkillSummaries();
	invalidateSkillLibraries();
	return result;
}

async function downloadReference(url: string, path: string, init?: RequestInit): Promise<void> {
	const response = await apiFetch(url, init);
	if (!response.ok) {
		const payload = await response.json().catch(() => null);
		throw new ApiRequestError(payload?.message || payload?.error || `Reference download failed (${response.status}).`, response.status, payload?.code);
	}
	// Downloads stay attachments: HTML/SVG are never embedded as an active preview.
	const objectUrl = URL.createObjectURL(await response.blob());
	const link = document.createElement("a");
	link.href = objectUrl;
	link.download = path.split("/").pop() || "reference";
	link.click();
	setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
}

export function isRepoSnapshotExpired(error: unknown): boolean {
	return apiErrorCode(error) === "REPOSITORY_SNAPSHOT_EXPIRED"
		|| (error instanceof Error && /\brepository (?:snapshot|checkout) expired\b/i.test(error.message));
}

export function downloadInstalledReference(name: string, reference: string): Promise<void> {
	return downloadReference(`/api/skills/${encodeURIComponent(name)}/references/${encodeURIComponent(reference)}`, reference);
}
