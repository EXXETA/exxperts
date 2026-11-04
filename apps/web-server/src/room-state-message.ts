/**
 * The room's live state as one hidden message: today's date, who the room is
 * now, the instructions in force, the workspace, the enabled skills and the
 * Attachments list. The boot snapshot's date is the day the conversation started, so
 * a conversation reopened days later learns the day from here.
 *
 * These used to be appended to the system prompt on every message, so any
 * change (a rename, an instruction edit, a skill switch, a new file) changed
 * the system prompt and the provider wrote the whole conversation to its cache
 * again. The system prompt now stays as the conversation booted, and the state
 * rides a message of the runtime's reserved room-state type after the person's
 * message. A turn sends a copy only when its text differs from the latest copy
 * the model can see: the first turn, any change, and a compaction that removed
 * the latest copy. Each copy is whole and says it replaces the earlier ones, so
 * the model never has to add copies up.
 *
 * The parts as sent are kept in the message's details (never sent to the
 * model), so a part that cannot be read this turn carries the latest copy's
 * part unchanged and never sends a copy on its own. That part comes from the
 * session's latest copy, which a compaction may have left out of what the
 * model is sent.
 */
import { ROOM_STATE_CUSTOM_TYPE } from "@exxeta/exxperts-runtime";
import type { PersistentRoomInstructionsNow } from "./persistent-room-instructions.js";

/**
 * What a run can say about the room this turn. A section string is rendered,
 * leading blank lines included; null means it could not be read this turn
 * (the latest copy's part is kept); a part left out is one this run has no
 * tools for, such as the skills and Attachments on a scheduled run. Instructions
 * that cannot be read keep the latest copy's part too, and silent ones are
 * left out, so the instructions the conversation started with stand.
 */
export interface RoomStateParts {
	identity: string | null;
	instructions: PersistentRoomInstructionsNow;
	workspace: string | null;
	skills?: string;
	files?: string | null;
}

/** The copy's first line, so a reader of the wire (a test's synthetic model) can tell a copy from the person's message. */
export const ROOM_STATE_HEADING = "# Room state";

const PART_NAMES = ["date", "identity", "instructions", "workspace", "skills", "files"] as const;
type PartName = (typeof PART_NAMES)[number];

/** Kept in the message's details: each part's section as this copy sent it. */
interface RoomStateDetails {
	parts: Partial<Record<PartName, string>>;
}

export interface RoomStateMessage {
	customType: typeof ROOM_STATE_CUSTOM_TYPE;
	content: string;
	display: false;
	details: RoomStateDetails;
}

/**
 * The local calendar day as YYYY-MM-DD: this message's date and the boot
 * envelope's. It lives here because this module imports nothing that reads
 * the home folder while loading, and smokes import it before they set theirs.
 */
export function localDateStamp(now: Date): string {
	const year = now.getFullYear();
	const month = String(now.getMonth() + 1).padStart(2, "0");
	const day = String(now.getDate()).padStart(2, "0");
	return `${year}-${month}-${day}`;
}

const NO_SKILLS = `

## Enabled skills

No skills are enabled in this room right now.`;

const NO_FILES = `

## Attachments in this room

The room has no files right now.`;

/**
 * The latest room-state copy among `items`, read leniently: an old or
 * hand-edited session may carry another shape. `kind` names the field that
 * marks one: "role" for the messages the model is sent, "type" for the
 * session's own entries.
 */
function latestCopy(items: readonly unknown[], kind: "role" | "type"): { content: unknown; parts: Partial<Record<PartName, string>> } | undefined {
	const marker = kind === "role" ? "custom" : "custom_message";
	for (let at = items.length - 1; at >= 0; at--) {
		const message = items[at] as { role?: unknown; type?: unknown; customType?: unknown; content?: unknown; details?: unknown };
		if (message?.[kind] !== marker || message.customType !== ROOM_STATE_CUSTOM_TYPE) continue;
		const kept = (message.details as { parts?: unknown } | undefined)?.parts;
		const parts: Partial<Record<PartName, string>> = {};
		if (kept && typeof kept === "object") {
			for (const name of PART_NAMES) {
				const part = (kept as Record<string, unknown>)[name];
				if (typeof part === "string") parts[name] = part;
			}
		}
		return { content: message.content, parts };
	}
	return undefined;
}

/** Unreadable instructions keep the latest copy's part (null); silent ones are left out. */
function instructionsSection(now: PersistentRoomInstructionsNow): string | null | undefined {
	if (now.kind === "unreadable") return null;
	if (now.kind === "silent") return undefined;
	return now.section;
}

/** Each part's section for this copy; a part that cannot be read keeps the latest copy's, and one this run cannot use is left out. */
function sectionsFor(state: RoomStateParts, latest: Partial<Record<PartName, string>>, now: Date): Partial<Record<PartName, string>> {
	const read: Record<PartName, string | null | undefined> = {
		date: `\n\n## Current date\n\nToday is ${localDateStamp(now)}.`,
		identity: state.identity || null,
		instructions: instructionsSection(state.instructions),
		workspace: state.workspace,
		skills: state.skills === undefined ? undefined : state.skills || NO_SKILLS,
		files: state.files == null ? state.files : state.files || NO_FILES,
	};
	const sections: Partial<Record<PartName, string>> = {};
	for (const name of PART_NAMES) {
		const section = read[name] === null ? latest[name] : read[name];
		if (section) sections[name] = section;
	}
	return sections;
}

function render(sections: Partial<Record<PartName, string>>, scheduled: boolean): string {
	const intro = `${ROOM_STATE_HEADING}

Live runtime state from the app as of this message, not words from the user. It replaces every earlier room-state message: where they differ, this one is in force.${scheduled ? `

This is a scheduled run: no one is present and no one can answer. Never ask, offer or wait: make the reasonable choice, say which, finish the work, and list what you could not do. This run has no skills or Attachments tools, so this message leaves them out.` : ""}`;
	return intro + PART_NAMES.map((name) => sections[name] ?? "").join("");
}

/**
 * The copy a turn sends after the person's message, or undefined when the
 * latest copy among `messages` (what the model is sent, compaction applied)
 * already says the same. A part that cannot be read keeps the parts `held`
 * returns, the session's latest copy's, read only then; they default to the
 * latest visible copy's. The date is the day of `now`, so a new day sends a
 * new copy.
 */
export function roomStateMessageFor(state: RoomStateParts, messages: readonly unknown[], held?: () => Partial<Record<PartName, string>> | undefined, now: Date = new Date()): RoomStateMessage | undefined {
	const latest = latestCopy(messages, "role");
	const unread = !state.identity || state.instructions.kind === "unreadable" || state.workspace === null || state.files === null;
	const sections = sectionsFor(state, (unread ? held?.() : undefined) ?? latest?.parts ?? {}, now);
	// Only a scheduled run leaves these parts out.
	const content = render(sections, state.skills === undefined || state.files === undefined);
	if (latest?.content === content) return undefined;
	return { customType: ROOM_STATE_CUSTOM_TYPE, content, display: false, details: { parts: sections } };
}

/** The same, for a before_agent_start handler: it reads the session the turn runs on, its branch for the parts it holds. */
export function nextRoomStateMessage(state: RoomStateParts, sessionManager: { buildSessionContext(): { messages: readonly unknown[] }; getBranch(): readonly unknown[] }, now: Date = new Date()): RoomStateMessage | undefined {
	return roomStateMessageFor(state, sessionManager.buildSessionContext().messages, () => latestCopy(sessionManager.getBranch(), "type")?.parts, now);
}
