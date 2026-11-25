// The "/" list in a room's message box: when it opens, which skills it offers
// and in what order, and what a pick puts in the box. No React here, so its
// smoke (apps/web-server/scripts/skill-pick-list-smoke.ts) runs it in plain
// node; components/skill-pick-list.tsx draws it and the message box
// (components/in-room-chat.tsx) drives it. A pick is plain text: the server
// reads the leading "/name" when the message is sent (skill-pick.ts there).

/** A skill the list offers: on in this room, its files readable. */
export interface SkillPickEntry {
	name: string;
	description: string;
	/** Its author marked it to start only when the person picks it. */
	byHand: boolean;
}

/** The library's view of a skill, as the Skills pages read it. */
interface LibrarySkill {
	name: string;
	description: string;
	unreadable?: boolean;
	disableModelInvocation?: boolean;
}

/** A room's view of a skill it has on, as its Skills page reads it. */
interface RoomSkill {
	name: string;
	status: string;
	manualOnly?: boolean;
}

/**
 * The text typed after a "/" that opens the draft, while the caret is in that
 * first word; null otherwise, so a "/" later in the text (a path, a date)
 * never opens the list.
 */
export function skillPickQuery(draft: string, caret: number): string | null {
	const at = Math.max(0, Math.min(caret, draft.length));
	const match = /^\/([^\s/]*)$/.exec(draft.slice(0, at));
	return match ? match[1]! : null;
}

/** The skills on in the room, in the library's order: one the room has on whose files can't be read, or that left the library, is not offered. */
export function skillPickEntries(library: readonly LibrarySkill[], room: readonly RoomSkill[]): SkillPickEntry[] {
	const on = new Map(room.filter((skill) => skill.status === "ok").map((skill) => [skill.name, skill] as const));
	return library.flatMap((skill) => {
		const state = on.get(skill.name);
		if (!state || skill.unreadable) return [];
		return [{ name: skill.name, description: skill.description, byHand: skill.disableModelInvocation === true || state.manualOnly === true }];
	});
}

/** The entries the typed text fits, ignoring case: names that start with it first, then names that hold it. */
export function filterSkillPicks(entries: readonly SkillPickEntry[], query: string): SkillPickEntry[] {
	const needle = query.toLowerCase();
	const starts = entries.filter((entry) => entry.name.toLowerCase().startsWith(needle));
	const holds = entries.filter((entry) => !entry.name.toLowerCase().startsWith(needle) && entry.name.toLowerCase().includes(needle));
	return [...starts, ...holds];
}

/** The draft after a pick: its first word becomes "/name " and the rest stays, a line break after the word too; `caret` goes after the space. */
export function draftAfterSkillPick(draft: string, name: string): { draft: string; caret: number } {
	const picked = `/${name} `;
	const rest = draft.replace(/^\/\S*[ \t]*/, "");
	return { draft: `${picked}${rest}`, caret: picked.length };
}
