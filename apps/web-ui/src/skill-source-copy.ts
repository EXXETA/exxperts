/**
 * The words for a skill exxperts does not own (the store tiers builtin,
 * shared and project): why its page cannot delete it, and what the library
 * table shows where an owned skill shows its date.
 */

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
