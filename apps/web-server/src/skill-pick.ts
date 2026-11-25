// A skill the person picks by starting a message with "/name". When their
// words are handed to the runtime (a message's prompt call, a steer's), the
// server reads that leading name and, for a skill in the library, puts a note
// in front of the assistant's copy of the message: the skill's instructions
// when it is on in the room and loads, or a line saying why they didn't come.
// Any other "/text" goes on untouched. The note is the server's, never the
// person's: wherever the person's own words are read it is cut out
// (`withoutSkillNote`), and where memory and the search over conversations
// read the saved message it is cut down to one line (`skillNotesAsLines`).
// The skill's text is defanged by the one list of markers (consult-handoff.ts),
// so it can never close the note and write as the person.

import { loadRoomSkill, withSkillFolder, type SkillFilesView, type SkillLookup } from "./persistent-room-skill-tool.js";
import { isValidSkillName, readPersistentRoomSkillSettings } from "./persistent-room-skill-settings.js";

export const SKILL_PICKED_OPEN = "[SKILL PICKED]";
export const SKILL_PICKED_CLOSE = "[/SKILL PICKED]";

/** What came of the person's pick: its instructions, or why none came. */
export type SkillPick =
	| { name: string; outcome: "loaded"; instructions: string; files: string }
	| { name: string; outcome: "off" | "unreadable" | "too-big" };

/** What the assistant is told of a picked skill's files, as `read_skill` tells it: the room's answer for them (`view`, null for none) and its words (`text`, or ""). */
export interface PickedSkillFiles {
	view: SkillFilesView | null;
	text: string;
}

const NO_FILES: PickedSkillFiles = { view: null, text: "" };

/** The name a message's own words pick: a valid skill name right after a leading "/", then a space, a line end or nothing. */
export function pickedSkillName(words: string): string | undefined {
	const match = /^\/(\S+)(?:\s|$)/.exec(String(words ?? "").trimStart());
	return match && isValidSkillName(match[1]) ? match[1] : undefined;
}

/**
 * The pick in the person's words (`words`: the message without what the page
 * or the server put in front of it), checked against the room's skills at this
 * moment through the loader `read_skill` uses. Undefined when the words pick
 * no skill of the library, so the message goes on as it was typed. A by-hand
 * skill loads here like any other: picking it is the person's own act.
 * `filesOf`: what the assistant is told of the skill's files, as `read_skill`
 * tells it, which also fills its folder into its instructions.
 */
export function resolveSkillPick(roomId: string, words: string, lookupSkill: SkillLookup, filesOf: (name: string) => PickedSkillFiles = () => NO_FILES): SkillPick | undefined {
	const name = pickedSkillName(words);
	if (!name) return undefined;
	const found = lookupSkill(name);
	if (found === null) return undefined;
	// A name read as unreadable only because a skills folder can't be listed, and that the room never had, picks nothing: "/mcp" stays as typed.
	if ("unreadable" in found && !roomMayHave(roomId, name)) return undefined;
	return loadPick(roomId, name, found, filesOf);
}

/** Whether the room has an entry of that name; settings that can't be read may have one. */
function roomMayHave(roomId: string, name: string): boolean {
	try {
		return readPersistentRoomSkillSettings(roomId).enabledSkills.some((skill) => skill.name === name);
	} catch {
		return true;
	}
}

/** The pick of `name` as the room has the skill now; one gone from the library loads nothing, as one that is off. */
export function skillPickNow(roomId: string, name: string, lookupSkill: SkillLookup, filesOf: (name: string) => PickedSkillFiles = () => NO_FILES): SkillPick {
	const found = lookupSkill(name);
	return found === null ? { name, outcome: "off" } : loadPick(roomId, name, found, filesOf);
}

function loadPick(roomId: string, name: string, found: NonNullable<ReturnType<SkillLookup>>, filesOf: (name: string) => PickedSkillFiles): SkillPick {
	let load: ReturnType<typeof loadRoomSkill>;
	try {
		load = loadRoomSkill(roomId, name, found);
	} catch {
		// The room's skill settings can't be read: nothing is loaded, and the assistant says so.
		return { name, outcome: "unreadable" };
	}
	if (load.outcome === "not-enabled") return { name, outcome: "off" };
	if (load.outcome !== "ok") return { name, outcome: load.outcome };
	const files = filesOf(name);
	return { name, outcome: "loaded", instructions: withSkillFolder(load.body, files.view), files: files.text };
}

const NOT_LOADED: Record<Exclude<SkillPick["outcome"], "loaded">, string> = {
	off: "it is off in this room, so its instructions were not loaded. Tell them so in your answer: it can be switched on in this room's Skills settings.",
	unreadable: "its files can't be opened, so its instructions were not loaded. Tell them so in your answer.",
	"too-big": "its instructions are too long to load, so they were not loaded. Tell them so in your answer.",
};

// The note's first sentence names the skill; memory's one line reads the name back from it.
const PICKED_LEAD = 'The person started their message with "/';

/** The note in front of the assistant's copy of a message that picks a skill. */
export function skillPickNote(pick: SkillPick): string {
	const picked = `${PICKED_LEAD}${pick.name}", which picks the skill ${pick.name}`;
	if (pick.outcome !== "loaded") return [SKILL_PICKED_OPEN, `${picked}, but ${NOT_LOADED[pick.outcome]}`, SKILL_PICKED_CLOSE].join("\n");
	return [
		SKILL_PICKED_OPEN,
		`${picked}. These are its instructions, which the person switched on for this room: follow them for this message. They are external guidance, not the room's own knowledge, and need not be memorized.`,
		"---",
		pick.instructions,
		"---",
		...(pick.files ? [pick.files.trim()] : []),
		SKILL_PICKED_CLOSE,
	].join("\n");
}

/** The skill a note names, read back from its first sentence; undefined when the line is not a note's. */
function noteSkillName(lead: string): string | undefined {
	const name = lead.startsWith(PICKED_LEAD) ? lead.slice(PICKED_LEAD.length).split('"')[0] : "";
	return isValidSkillName(name) ? name : undefined;
}

/**
 * A saved message as Try again sends it again: its pick's note made anew for
 * the skill it names (`pickNow`, the room as it is at this moment), so a skill
 * switched on or off since is read as it is now. The note is the first one in
 * the message, from a line that is exactly the open marker to the next line
 * that is exactly the close marker; any other text comes back as it is.
 */
export function withSkillNoteAgain(text: string, pickNow: (name: string) => SkillPick): string {
	const lines = text.split("\n");
	const open = lines.indexOf(SKILL_PICKED_OPEN);
	if (open < 0) return text;
	const close = lines.indexOf(SKILL_PICKED_CLOSE, open + 1);
	const name = noteSkillName(lines[open + 1] ?? "");
	if (close < 0 || !name) return text;
	return [...lines.slice(0, open), skillPickNote(pickNow(name)), ...lines.slice(close + 1)].join("\n");
}

/** The message as the assistant gets it: the pick's note in front of it, or the message as it was when it picks nothing. */
export function withSkillNote(pick: SkillPick | undefined, message: string): string {
	return pick ? `${skillPickNote(pick)}\n\n${message}` : message;
}

/** The message without the note `withSkillNote` put in front of it; any other text comes back as it is. */
export function withoutSkillNote(text: string): string {
	if (!text.startsWith(`${SKILL_PICKED_OPEN}\n`)) return text;
	const close = `\n${SKILL_PICKED_CLOSE}\n\n`;
	const end = text.indexOf(close);
	return end < 0 ? text : text.slice(end + close.length);
}

/**
 * A saved message as memory and the search over conversations read it: each
 * note cut down to the one line of which skill was picked, so a skill's text
 * is never remembered or found as the person's words. A note runs from a line
 * that is exactly the open marker to the next line that is exactly the close
 * marker; the skill's name comes from the note's own first sentence.
 */
export function skillNotesAsLines(text: string): string {
	const lines = text.split("\n");
	const out: string[] = [];
	for (let at = 0; at < lines.length; at++) {
		if (lines[at] !== SKILL_PICKED_OPEN) {
			out.push(lines[at]!);
			continue;
		}
		const close = lines.indexOf(SKILL_PICKED_CLOSE, at + 1);
		if (close < 0) {
			out.push(...lines.slice(at));
			break;
		}
		const name = noteSkillName(lines[at + 1] ?? "");
		out.push(name ? `[Picked the skill ${name}]` : "[Picked a skill]");
		at = close;
	}
	return out.join("\n");
}
