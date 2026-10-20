import type { PersistentRoomEnabledSkillStatus } from "./persistent-room-management-api";

// What the paused-skills notice says and remembers, apart from React so a
// smoke can drive it (paused-skills-notice.ts is the hook).

const SEEN_LIMIT = 300;

/** The skills this room paused for review. */
export function pausedSkills(skills: readonly PersistentRoomEnabledSkillStatus[]): PersistentRoomEnabledSkillStatus[] {
	return skills.filter((skill) => skill.status === "hash-mismatch");
}

/** One paused skill's change, as remembered: the room, the skill and the version it changed to. */
export function pausedSkillMark(agentId: string, skill: PersistentRoomEnabledSkillStatus): string {
	return `${agentId}:${skill.name}@${skill.currentSha256 ?? ""}${skill.currentPackageSha256 ? `/${skill.currentPackageSha256}` : ""}`;
}

/** The notice's words: the fact, and what to do about it. Null when nothing is paused. */
export function pausedSkillsWords(paused: readonly PersistentRoomEnabledSkillStatus[]): { text: string; sub: string } | null {
	if (paused.length === 0) return null;
	// One skill is named by its display name, as the pane lists it; without one
	// (an older server) it is not named, since the pinned name can differ.
	if (paused.length === 1) {
		const name = paused[0]!.displayName?.trim();
		return { text: name ? `“${name}” changed, so this room paused it.` : "A skill changed, so this room paused it.", sub: "Review the new version to use it again." };
	}
	return { text: `${paused.length} skills changed, so this room paused them.`, sub: "Review the new versions to use them again." };
}

/**
 * Which paused skills are new to this device: none seen yet means the notice
 * shows. `seen` is what the device remembers; the result says whether to show
 * and what to remember next (the newest kept, at most SEEN_LIMIT).
 */
export function pausedSkillsDecision(agentId: string, skills: readonly PersistentRoomEnabledSkillStatus[], seen: readonly string[]): { show: { text: string; sub: string } | null; remember: string[] } {
	const paused = pausedSkills(skills);
	const marks = paused.map((skill) => pausedSkillMark(agentId, skill));
	const known = new Set(seen);
	const words = pausedSkillsWords(paused);
	if (!words || marks.every((mark) => known.has(mark))) return { show: null, remember: [...seen] };
	return { show: words, remember: [...seen.filter((mark) => !marks.includes(mark)), ...marks].slice(-SEEN_LIMIT) };
}
