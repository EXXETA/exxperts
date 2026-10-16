/**
 * The words for a skill exxperts does not own (the store tiers builtin,
 * shared and project): why its page cannot delete it, and what the library
 * table shows where an owned skill shows its date.
 */
import type { SkillListItem } from "./skills-api";
import type { SkillLibrary, SkillReference, SkillRepoProvenance } from "./skills-repo-api";

export function skillReferenceVersion(references: readonly Pick<SkillReference, "path" | "sha256">[]): string {
	return JSON.stringify(references.map(({ path, sha256 }) => [path, sha256]));
}

export function skillBelongsToLibrary(repo: Pick<SkillRepoProvenance, "libraryId" | "source" | "ref"> | undefined, library: Pick<SkillLibrary, "id" | "source" | "ref">): boolean {
	return !!repo && (repo.libraryId ? repo.libraryId === library.id : repo.source === library.source && (repo.ref ?? "") === (library.ref ?? ""));
}

/** The Delete row's line for a skill exxperts does not own, per store tier. */
export const PROTECTED_SKILL_DELETE_LINES: Readonly<Record<string, string>> = {
	builtin: "It comes with exxperts, so it can't be deleted. To stop a room using it, remove it in that room's Skills settings.",
	shared: "It lives in ~/.agents/skills, which other tools manage. Delete it there to remove it.",
	project: "It comes with this project's folder. Remove it from .exxeta/skills there.",
};

/** The library table's Updated cell for a skill with no import date. */
export const SKILL_TIER_LABELS: Readonly<Record<string, string>> = {
	builtin: "Built in",
	shared: "Shared",
	project: "This project",
};

export function protectedSkillDeleteLine(tier: string): string | null {
	return PROTECTED_SKILL_DELETE_LINES[tier] ?? null;
}

export function skillTierLabel(tier: string): string | null {
	return SKILL_TIER_LABELS[tier] ?? null;
}

/** Group by repository identity, keeping custom skills as an always-present section. */
export function groupSkillsBySource(skills: SkillListItem[]): Array<{ key: string; label: string; skills: SkillListItem[] }> {
	const groups = new Map<string, { key: string; label: string; skills: SkillListItem[] }>();
	groups.set("custom", { key: "custom", label: "Custom", skills: [] });
	for (const skill of skills) {
		let key = "custom", label = "Custom";
		const tier = skillTierLabel(skill.source);
		if (tier) { key = skill.source; label = tier; }
		else {
			const origin = skill.provenance?.repo?.source ?? skill.provenance?.source;
			if (origin) try {
				const url = new URL(origin.replace(/^[^@/\s]+@([^:/\s]+):/, "ssh://$1/"));
				if (["https:", "http:", "ssh:", "git:"].includes(url.protocol) && url.pathname.replace(/\//g, "")) {
					label = `${url.host}${url.pathname.replace(/\/+$/, "").replace(/\.git$/, "")}`;
					const repo = skill.provenance?.repo;
					key = repo?.libraryId ? `repo:library:${repo.libraryId}` : `repo:${label}${repo?.ref ? `#${repo.ref}` : ""}`;
					if (repo?.ref) label += ` · ${repo.ref}`;
				}
			} catch { /* Local files and unrecognized origins remain custom. */ }
		}
		if (!groups.has(key)) groups.set(key, { key, label, skills: [] });
		groups.get(key)!.skills.push(skill);
	}
	return [...groups.values()].sort((a, b) => {
		const order = (key: string) => key === "builtin" ? 0 : key === "shared" ? 1 : key === "project" ? 2 : key === "custom" ? 4 : 3;
		return order(a.key) - order(b.key) || a.label.localeCompare(b.label);
	});
}
