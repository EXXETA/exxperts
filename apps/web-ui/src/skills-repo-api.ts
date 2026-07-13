// MR-4 client for the import-from-repo + featured Browse endpoints. Types mirror
// the server's `skills-repo-fetch.ts` shapes but are declared locally so the UI
// never imports that server-only (child_process) module. Uses the shared
// `fetchJson` so {error} bodies surface as thrown Errors the panes can render.
import { fetchJson } from "./api";
import type { SkillCandidate } from "./skills-api";

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
	path: string;
	name: string;
	description: string;
	license: string | null;
	hasBundledScripts: boolean;
}

/** The review-screen candidate (the MR-3 seam contract shape). */
export interface RepoSkillCandidate {
	name: string;
	description: string;
	body: string;
	source: string;
	license: string | null;
	scanFindings: InvisibleUnicodeScan;
	bundledScripts: string[];
}

export interface RepoScanResponse {
	/** Checkout token — review + accept reuse it so the accepted body matches the reviewed one. */
	token: string;
	source: string;
	skills: RepoFoundSkill[];
}

export interface RepoImportResponse {
	skill: { name: string; description: string; source: string } | null;
	provenance: { source: string; importedAt: string; license: string | null; sha256: string };
	bundledCopied: number;
}

export interface FeaturedSourceResult {
	source: string;
	author: string;
	/** null when the source could not be fetched (see `error`). */
	token: string | null;
	skills: RepoFoundSkill[];
	error?: string;
}

/** Shallow-clone + scan a pasted git/GitHub URL, returning the found skills + a checkout token. */
export function scanRepo(source: string): Promise<RepoScanResponse> {
	return fetchJson<RepoScanResponse>("/api/skills/repo/scan", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ source }),
	});
}

/** Build the review candidate for one skill in a scanned repo (runs the invisible-unicode scan). */
export function fetchRepoCandidate(token: string, skillPath: string): Promise<RepoSkillCandidate> {
	return fetchJson<RepoSkillCandidate>("/api/skills/repo/candidate", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ token, path: skillPath }),
	});
}

/** Accept + persist a reviewed skill into the library (provenance sidecar + pinned hash). */
export function importRepoSkill(token: string, skillPath: string, id?: string): Promise<RepoImportResponse> {
	return fetchJson<RepoImportResponse>("/api/skills/repo/import", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ token, path: skillPath, ...(id ? { id } : {}) }),
	});
}

/** Fetch the curated featured Browse sources with their scanned skills. */
export function fetchFeaturedSources(): Promise<{ sources: FeaturedSourceResult[] }> {
	return fetchJson<{ sources: FeaturedSourceResult[] }>("/api/skills/featured");
}

/** Adapt a repo candidate to the shared review screen's candidate shape (MR-3 seam). */
export function repoCandidateToSkillCandidate(candidate: RepoSkillCandidate, id: string): SkillCandidate {
	return { ...candidate, id, scanFindings: candidate.scanFindings.findings };
}

/** SPDX ids we surface verbatim; everything else is normalized for display. */
const RECOGNIZED_LICENSES = [
	"MIT", "Apache-2.0", "BSD-2-Clause", "BSD-3-Clause", "GPL-2.0", "GPL-3.0",
	"LGPL-3.0", "MPL-2.0", "ISC", "Unlicense", "CC0-1.0", "CC-BY-4.0", "AGPL-3.0", "BSL-1.0",
];

/** Presentation-only license normalizer (MR-P2). Returns a short label plus, when the
 *  raw value was truncated, the full string for a title/tooltip attribute. */
export function licenseLabel(license: string | null | undefined): { text: string; title?: string } {
	const raw = (license ?? "").trim();
	if (!raw) return { text: "License unknown" };
	const spdx = RECOGNIZED_LICENSES.find((id) => id.toLowerCase() === raw.toLowerCase());
	if (spdx) return { text: spdx };
	// A short single token (e.g. "Proprietary", "Custom") shows as-is.
	if (!/\s/.test(raw) && raw.length <= 24) return { text: raw };
	// Long descriptive strings ("Proprietary. LICENSE.txt has complete terms"): keep a
	// leading proper-noun label and stash the full text as a tooltip; otherwise unknown.
	const lead = raw.split(".")[0].trim();
	if (lead && /^[A-Za-z][A-Za-z0-9-]*$/.test(lead) && lead.length <= 24) {
		return { text: lead, title: raw };
	}
	return { text: "License unknown", title: raw };
}

const PLACEHOLDER_PREFIX = "Replace with description";

/** Presentation-only description normalizer (MR-P2): treats empty and template
 *  placeholder descriptions as "no description" so cards render a muted note instead. */
export function skillCardDescription(description: string | null | undefined): string | null {
	const raw = (description ?? "").trim();
	if (!raw || raw.startsWith(PLACEHOLDER_PREFIX)) return null;
	return raw;
}
