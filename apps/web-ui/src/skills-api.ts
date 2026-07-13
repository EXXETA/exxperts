// Skills library client (MR-3). Mirrors the per-domain module shape (mcp-api.ts):
// tiny typed wrappers over the server CRUD at /api/skills, plus the upload/accept
// pair the review screen (the trust moment, spec §3) drives.
import { fetchJson } from "./api";

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
}

/** The detail response = a list item plus the review-screen extras. */
export interface SkillDetail extends SkillListItem {
	scanFindings: SkillScanFinding[];
	bundledScripts: string[];
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
	scanFindings: SkillScanFinding[];
	bundledScripts: string[];
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

/** Map a library skill to the review-screen candidate shape (the detail view reuses the
 *  review component in read mode). Imported skills keep no bundled scripts. */
export function skillDetailToCandidate(skill: SkillDetail): SkillCandidate {
	return {
		id: skill.name,
		name: skill.displayName || skill.name,
		description: skill.description,
		body: skill.body,
		source: skill.provenance?.source ?? skill.source,
		license: skill.provenance?.license ?? null,
		scanFindings: skill.scanFindings,
		bundledScripts: skill.bundledScripts,
	};
}
