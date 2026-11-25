// Skills library client (MR-3). Mirrors the per-domain module shape (mcp-api.ts):
// tiny typed wrappers over the server CRUD at /api/skills, plus the upload/accept
// pair the review screen (the trust moment, spec §3) drives.
import { ApiRequestError, fetchJson } from "./api";
import { SKILL_CHANGED_SINCE_REVIEW, SKILL_INSTRUCTIONS_ONLY_LINES, SKILL_NAME_TAKEN, SKILL_TOO_BIG, SKILL_UNREADABLE_LINE, SKILL_UPDATE_FAILED_LINE, SKILL_UPDATE_NOT_FETCHED, SKILL_UPDATE_UNREADABLE_LINE, SKILL_UPLOAD_GONE, SKILL_UPLOAD_GONE_LINE, skillChangedSinceReviewLine, skillNameTakenLine, skillTooBigLine, skillUpdatesFailedLine, skillUpdateTooBigLine, type SkillFileKind, type SkillTooBig, type SkillUpdateFailure } from "./skill-source-copy";

/** A skill's file by its path inside the skill's folder, and its kind, as the server lists them. */
export interface SkillFile {
	path: string;
	kind: SkillFileKind;
}

/** A hidden/zero-width/bidi character the server's scan flagged in a body. Mirrors
 *  the server `InvisibleUnicodeFinding` — surfaced (never silently stripped) at review. */
export interface SkillScanFinding {
	index: number;
	codePoint: number;
	label: string;
	category: "zero-width" | "bidi" | "invisible";
}

/** Provenance surfaced by the API for a library skill (null for builtin/project). */
export interface SkillProvenanceView {
	source: string;
	license: string | null;
	importedAt: string;
}

/** A skill as the library list returns it. */
export interface SkillListItem {
	name: string;
	displayName?: string;
	description: string;
	body: string;
	/** Store tier: "user" (yours), "builtin", or "project". */
	source: string;
	protected: boolean;
	provenance: SkillProvenanceView | null;
	/** Its import record's license, or else the one its SKILL.md declares. */
	license: string | null;
	/** The version its SKILL.md states, or null. */
	version: string | null;
	/** The rooms that enable this skill. */
	rooms: SkillRoomRef[];
	/** How many files it carries, its SKILL.md included. */
	fileCount: number;
	/** Its SKILL.md can't be opened: listed by its folder's name, with no text, and no room can use it. */
	unreadable?: boolean;
	/** Its written name fits onto this "/" name, which another skill already has: listed under its written name, and no room can use it. */
	nameTaken?: string;
	/** A skill from the folder shared with other tools whose files rooms can't open, though it has some: its link leads to the home folder or above it, or rooms can't open its folder. */
	instructionsOnly?: keyof typeof SKILL_INSTRUCTIONS_ONLY_LINES;
	/** Where the files of a skill from the folder shared with other tools are, with the home folder as ~: only when its link leads outside ~/.agents and rooms open them. */
	filesAt?: string;
	/** On this Windows computer a room with protection on runs its scripts only from a folder the room already opens: its folder holds a link. */
	scriptsReadOnly?: boolean;
	/** Its author marked it to start only when picked by hand. */
	disableModelInvocation?: boolean;
	/** The repository it was added from, for one of your own skills added from one. */
	repository?: SkillRepositoryView;
	/** What its last check for updates found, or that it can't be checked. */
	update?: SkillUpdateView;
}

/** How the ref a skill was added from moves. */
export type SkillRefKind = "default" | "branch" | "tag" | "commit";

/** A skill's repository, as its page shows it. */
export interface SkillRepositoryView {
	address: string;
	ref?: string;
	refKind: SkillRefKind;
	path: string;
	commit: string;
	/** Its "Update automatically" switch. */
	autoUpdate: boolean;
	/** Its repository was last asked over an hour ago. */
	checkDue: boolean;
}

/** Where a skill stands against its repository (the server's `SkillUpdateState`). */
export type SkillUpdateState = "current" | "available" | "pinned" | "unreachable" | "gone" | "renamed" | "untracked";

/** Why a repository could not be asked. */
export type SkillUpdateFailureReason = "offline" | "connect-failed" | "timeout" | "sign-in" | "missing-tool" | "ref-missing" | "failed";

/** The files an update adds, removes and changes. */
export interface SkillUpdateChanges {
	added: SkillFile[];
	removed: SkillFile[];
	changed: SkillFile[];
}

/** Another version of a skill, as a check found it. */
export interface SkillUpdateCandidate {
	/** What Update names: the same while it shows the same. */
	id: string;
	commit: string;
	path: string;
	filesSha256: string;
	changes: SkillUpdateChanges;
	versions: { from: string | null; to: string | null };
	scanFindings: SkillScanFinding[];
	hiddenCharacters: boolean;
	/** The new version's instructions and description, sent only when they hold hidden characters. */
	body?: string;
	description?: string;
	changedHere: boolean;
}

/** What a skill's row and page say of its updates. */
export interface SkillUpdateView {
	state: SkillUpdateState;
	checkedAt?: string;
	installedFilesSha256?: string | null;
	candidate?: SkillUpdateCandidate;
	renamedTo?: string;
	failure?: { reason: SkillUpdateFailureReason; message: string; host?: string };
	/** Why the last check since this result couldn't ask the repository. */
	missed?: { reason: SkillUpdateFailureReason; message: string; host?: string };
	/** The last update, and whether Update automatically made it and the person closed the notice that named it. */
	updated?: { at: string; changes: SkillUpdateChanges; versions: { from: string | null; to: string | null }; automatic?: true; noticeClosed?: true };
	/** Update automatically left this update for the person: it has hidden characters, or the skill was changed on this computer. */
	autoSkipped?: { noticeClosed?: true };
}

/** A check's answer: when it ran, and each checked skill's result. */
export interface SkillUpdatesCheck {
	checkedAt: string;
	results: Array<{ name: string } & SkillUpdateView>;
}

/** A room that enables a skill. */
export interface SkillRoomRef {
	id: string;
	name: string;
}

/** The detail response = a list item plus the review-screen extras. */
export interface SkillDetail extends SkillListItem {
	scanFindings: SkillScanFinding[];
	/** Every file, with its kind; none for a skill whose folder never opens to a room. */
	files: SkillFile[];
}

/**
 * The candidate object the shared review screen consumes — the clean seam (spec §3):
 * an upload candidate and (MR-4) a repo-import candidate are the same shape, so the
 * review component never knows where the skill came from.
 */
export interface SkillCandidate {
	id: string;
	name: string;
	description: string;
	body: string;
	source: string;
	license: string | null;
	/** The version its front matter states, or null. */
	version: string | null;
	scanFindings: SkillScanFinding[];
	/** Every file adding it writes, its SKILL.md included, with its kind. */
	files: SkillFile[];
	/** A skill of yours already has this name, so adding it replaces that one. */
	replaces?: boolean;
	/** Which version of that skill the review showed: Replace sends it back, so a skill changed since is never the one replaced. */
	replacesVersion?: string;
	/** That skill's own name, when it differs from this one's: it is a different skill. */
	replacesName?: string;
	/** The first path, as written, its instructions reach above its folder by: adding copies the folder alone. */
	outsidePath?: string;
	/** Upload only: its front matter's name, when the standard doesn't allow it as it is; accept writes it back as it came. */
	writtenName?: string;
	/** Upload only: checkout token for the bundled files the zip carried. Passed back
	 *  on accept so those files are vendored next to the SKILL.md. */
	token?: string;
	/** Upload only: the author's manual-only mark, passed back on accept so the new
	 *  SKILL.md keeps it. */
	disableModelInvocation?: boolean;
}

export function fetchSkills(): Promise<SkillListItem[]> {
	return fetchJson<SkillListItem[]>("/api/skills");
}

export function fetchSkill(id: string): Promise<SkillDetail> {
	return fetchJson<SkillDetail>(`/api/skills/${encodeURIComponent(id)}`);
}

export interface WriteSkillRequest {
	id: string;
	displayName: string;
	description: string;
	instructions: string;
}

/** Hand-written skill — server assigns provenance source "local" (spec §3 path 1). */
export function createSkill(request: WriteSkillRequest): Promise<SkillListItem> {
	return fetchJson<SkillListItem>("/api/skills", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(request),
	});
}

/** Asks the repositories of your skills (or only `names`) whether they hold another version. */
export function checkSkillUpdates(names?: string[]): Promise<SkillUpdatesCheck> {
	return fetchJson<SkillUpdatesCheck>("/api/skills/updates/check", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(names ? { names } : {}),
	});
}

/** The page's own check as it opens: asks only the skills whose check is due, with no sign-in, and opens no window. */
export function checkSkillUpdatesQuietly(): Promise<SkillUpdatesCheck> {
	return fetchJson<SkillUpdatesCheck>("/api/skills/updates/check", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ quiet: true }),
	});
}

/** Your yes to a stop an update makes: hidden characters in the new version, or replacing changes made on this computer. */
export interface SkillUpdateConfirm {
	hiddenCharacters?: true;
	replaceMyChanges?: true;
}

/** Installs the version a check found, for the installation it was found for; the server fetches it again when it no longer holds it. */
export function updateSkill(name: string, candidate: SkillUpdateCandidate, installedFilesSha256: string, confirm: SkillUpdateConfirm = {}): Promise<SkillListItem> {
	return fetchJson<SkillListItem>(`/api/skills/${encodeURIComponent(name)}/update`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ candidate: candidate.id, installedFilesSha256, confirm }),
	});
}

/** Turns a skill's Update automatically on or off. */
export function setSkillAutoUpdate(name: string, on: boolean): Promise<SkillListItem> {
	return fetchJson<SkillListItem>(`/api/skills/${encodeURIComponent(name)}/auto-update`, {
		method: "PUT",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ on }),
	});
}

/** What the notice showed of one skill: the update made at `updatedAt`, and the left version with `skippedVersion`'s files. */
export interface SkillNoticeShown {
	name: string;
	updatedAt?: string;
	skippedVersion?: string;
}

/** Closes the notice of what Update automatically did, for what it showed: one that came after stays named. */
export function closeSkillUpdateNotices(notices: SkillNoticeShown[]): Promise<{ ok: true }> {
	return fetchJson<{ ok: true }>("/api/skills/updates/seen", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ notices }),
	});
}

export function deleteSkill(id: string): Promise<{ ok: boolean; deleted: string }> {
	return fetchJson(`/api/skills/${encodeURIComponent(id)}`, { method: "DELETE" });
}

/** Upload a `.md`/`.zip`/`.skill` and get back a review candidate (NOT yet saved). The
 *  file is sent as base64 JSON — no multipart, so it rides the same transport as every
 *  other endpoint. The server unpacks/validates and never executes anything. */
export function uploadSkillFile(filename: string, contentBase64: string): Promise<SkillCandidate> {
	return fetchJson<SkillCandidate>("/api/skills/upload", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ filename, contentBase64 }),
	});
}

/** Persist a reviewed candidate to the library (Accept on the review screen). */
export function acceptSkillCandidate(candidate: SkillCandidate): Promise<SkillListItem> {
	return fetchJson<SkillListItem>("/api/skills/accept", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			id: candidate.id,
			displayName: candidate.name,
			description: candidate.description,
			instructions: candidate.body,
			source: candidate.source,
			license: candidate.license,
			version: candidate.version,
			disableModelInvocation: candidate.disableModelInvocation,
			replace: candidate.replaces === true,
			...(candidate.replacesVersion ? { replacesVersion: candidate.replacesVersion } : {}),
			...(candidate.writtenName ? { writtenName: candidate.writtenName } : {}),
			...(candidate.token ? { token: candidate.token } : {}),
		}),
	});
}

/** Read a File as base64 (no data: prefix), chunked so large files don't overflow the
 *  call stack. Used to hand an uploaded file to the base64-JSON upload endpoint. */
export async function fileToBase64(file: File): Promise<string> {
	const bytes = new Uint8Array(await file.arrayBuffer());
	let binary = "";
	const chunk = 0x8000;
	for (let i = 0; i < bytes.length; i += chunk) {
		binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
	}
	return btoa(binary);
}

/** The words for a refused skills request: past the size limit, a name the library holds, a skill that can't be opened; else the server's own. */
export function skillRefusalLine(error: unknown): string {
	if (error instanceof ApiRequestError && error.details && typeof error.details === "object") {
		if (error.code === SKILL_TOO_BIG) return skillTooBigLine(error.details as SkillTooBig);
		if (error.code === SKILL_NAME_TAKEN) return skillNameTakenLine(String((error.details as { name?: unknown }).name ?? ""));
		if (error.code === SKILL_CHANGED_SINCE_REVIEW) return skillChangedSinceReviewLine(String((error.details as { name?: unknown }).name ?? ""));
	}
	if (error instanceof ApiRequestError && error.code === "skill-unreadable") return SKILL_UNREADABLE_LINE;
	if (error instanceof ApiRequestError && error.code === SKILL_UPLOAD_GONE) return SKILL_UPLOAD_GONE_LINE;
	return error instanceof Error ? error.message : String(error);
}

/** A Replace refused because the skill changed after its review opened: that review can't replace it any more. */
export function replaceRefusedSinceReview(error: unknown): boolean {
	return error instanceof ApiRequestError && error.code === SKILL_CHANGED_SINCE_REVIEW;
}

/** The words for an update of `name` the server refused or could not install: past the size limit, a new version it could not fetch or read, or a failure. */
export function skillUpdateRefusalLine(error: unknown, name: string): string {
	if (error instanceof ApiRequestError && error.code === SKILL_UPDATE_NOT_FETCHED && error.details && typeof error.details === "object") return skillUpdatesFailedLine(error.details as SkillUpdateFailure, [name], "update");
	if (error instanceof ApiRequestError && error.code === SKILL_TOO_BIG && error.details && typeof error.details === "object") return skillUpdateTooBigLine(error.details as SkillTooBig);
	if (error instanceof ApiRequestError && error.status === 502) return SKILL_UPDATE_UNREADABLE_LINE;
	if (error instanceof ApiRequestError && error.status === 500) return SKILL_UPDATE_FAILED_LINE;
	return error instanceof Error ? error.message : String(error);
}
