// MR-4 client for the import-from-repo + featured Browse endpoints. Types mirror
// the server's `skills-repo-fetch.ts` shapes but are declared locally so the UI
// never imports that server-only (child_process) module. Uses the shared
// `fetchJson` so {error} bodies surface as thrown Errors the panes can render.
import { fetchJson } from "./api";
import type { SkillCandidate, SkillFile } from "./skills-api";
import type { SkillTooBig } from "./skill-source-copy";

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
	/** The name the library keeps it under and a room's "/" picks it by. */
	id?: string;
	description: string;
	license: string | null;
	hasBundledScripts: boolean;
	/** The author marked it to start only when picked: the list shows the tag. */
	disableModelInvocation?: boolean;
	/** Past the size limit, with its real count or size: it can't be added. */
	tooBig?: SkillTooBig;
}

/** The review-screen candidate (the MR-3 seam contract shape). */
export interface RepoSkillCandidate {
	name: string;
	/** The name the library keeps it under and a room's "/" picks it by. */
	id: string;
	description: string;
	body: string;
	source: string;
	license: string | null;
	version: string | null;
	scanFindings: InvisibleUnicodeScan;
	/** Every file an import writes, its SKILL.md included, with its kind. */
	files: SkillFile[];
	/** The author marked it for picking by hand: the review tags it so. */
	disableModelInvocation?: boolean;
	/** A skill of yours already has this name: adding it replaces that one, which keeps its rooms. */
	replaces?: boolean;
	/** Which version of that skill the review showed: the import sends it back, so a skill changed since is never the one replaced. */
	replacesVersion?: string;
	/** That skill's own name, when it differs from this one's: it is a different skill. */
	replacesName?: string;
	/** The first path, as written, its instructions reach above its folder by: adding copies the folder alone. */
	outsidePath?: string;
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
	/** The error is a tool this machine lacks (Git, or Apple's developer tools), the same for every source. */
	missingTool?: boolean;
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

/** Accept + persist a reviewed skill into the library, with its provenance record; a Replace when its review asked to replace a skill of that name, of the version it showed. */
export function importRepoSkill(token: string, skillPath: string, reviewed: Pick<RepoSkillCandidate, "replaces" | "replacesVersion"> | null): Promise<RepoImportResponse> {
	return fetchJson<RepoImportResponse>("/api/skills/repo/import", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ token, path: skillPath, ...(reviewed?.replaces === true ? { replace: true, ...(reviewed.replacesVersion ? { replacesVersion: reviewed.replacesVersion } : {}) } : {}) }),
	});
}

/** Fetch the curated featured Browse sources with their scanned skills. */
export function fetchFeaturedSources(): Promise<{ sources: FeaturedSourceResult[] }> {
	return fetchJson<{ sources: FeaturedSourceResult[] }>("/api/skills/featured");
}

/** Adapt a repo candidate to the shared review screen's candidate shape (MR-3 seam). */
export function repoCandidateToSkillCandidate(candidate: RepoSkillCandidate): SkillCandidate {
	return { ...candidate, scanFindings: candidate.scanFindings.findings };
}

/** Another offered skill has this one's name, so the rows show their folders. */
export function sharesName(skills: readonly RepoFoundSkill[], skill: RepoFoundSkill): boolean {
	return skills.some((other) => other !== skill && other.name === skill.name);
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
