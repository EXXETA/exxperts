import type { PersistentRoomInstructionsResponse } from "./types";

/**
 * The green line the room pane shows after a write, whole, lead word
 * included. ONE table for Save, the Save of an empty box (which the server
 * treats as a removal) and both flips, derived from the view the server
 * returned, so no two sentences can disagree about one state. The plain
 * rows are short: what happened, then "Applies from the next message.".
 * The rows that carry more than timing keep it, and never promise a
 * next-message effect: this room's own file cannot be read (the per-turn
 * section is silent, so a FLIP does not reach an open conversation; a save
 * is different: the writer refuses only a folder, and a write that went
 * through has replaced or removed whatever sat there, so the open
 * conversation IS told, and the sentence for a save never treats the file
 * as stuck), the global file cannot be read with the switch on (silent as
 * well), and a switch turned on while no global text is written. `view` is
 * the view the write returned.
 */
/** The two fields the table reads; the pane passes its response, the smoke passes the server's view. */
export type RoomInstructionsOutcomeView = Pick<PersistentRoomInstructionsResponse, "instructions" | "global">;

export type RoomInstructionsAction = "save" | "saveEmpty" | "on" | "off";

const APPLIES = "Applies from the next message.";
const NO_OWN = "This room has no instructions of its own.";

/** The row and whether it says nothing beyond its lead and "Applies from the next message.". */
function outcomeRow(view: RoomInstructionsOutcomeView | null, action: RoomInstructionsAction): { sentence: string; timingOnly: boolean } {
	const lead = action === "on" ? "Switched on." : action === "off" ? "Switched off." : action === "saveEmpty" ? `Saved. ${NO_OWN}` : "Saved.";
	const roomStuck = !!view?.instructions.unreadable && (action === "on" || action === "off");
	const globalOn = action === "off" ? false : action === "on" ? true : (view?.global?.enabled ?? false);
	const globalText = !!view?.global?.instructions.text;
	const globalStuck = !!view?.global?.instructions.unreadable && globalOn;
	const followsGlobal = globalOn && globalText && !globalStuck;
	if (roomStuck) {
		return { sentence: `${lead} New conversations ${followsGlobal ? "follow the global instructions" : "start without instructions"}; an open conversation keeps its text until this room's instructions can be read again.`, timingOnly: false };
	}
	if (globalStuck) {
		const fresh = action === "save" ? "follow these instructions" : action !== "saveEmpty" && view?.instructions.text ? "follow this room's own instructions" : "start without instructions";
		return { sentence: `${lead} New conversations ${fresh}; an open conversation catches up when the global instructions can be read again.`, timingOnly: false };
	}
	switch (action) {
		case "save": return { sentence: `${lead} ${APPLIES}`, timingOnly: true };
		case "saveEmpty": return { sentence: followsGlobal ? `${lead} It follows the global instructions.` : lead, timingOnly: false };
		case "on": return followsGlobal ? { sentence: `${lead} ${APPLIES}`, timingOnly: true } : { sentence: `${lead} No global instructions are written yet; once they are, this room follows them.`, timingOnly: false };
		case "off": return { sentence: `${lead} ${APPLIES}`, timingOnly: true };
	}
}

export function outcomeAfter(view: RoomInstructionsOutcomeView | null, action: RoomInstructionsAction): string {
	return outcomeRow(view, action).sentence;
}

/**
 * The green line under the room pane after a Save, or null when the row says
 * only that it applies from the next message: the pane's "Saved · just now"
 * and its description already say that, and one notice is enough.
 */
export function savedLineAfter(view: RoomInstructionsOutcomeView | null, action: "save" | "saveEmpty"): string | null {
	const row = outcomeRow(view, action);
	return row.timingOnly ? null : row.sentence;
}

/**
 * The green line of Settings → Instructions after its Save, from the text
 * the server returned: none after a saved text, which has its "Saved · just
 * now", and an empty Save says there are none. A save the server refuses
 * keeps the server's sentence.
 */
export function globalSavedLineAfter(savedText: string): string | null {
	return savedText ? null : "Saved. There are no global instructions.";
}

/**
 * The sentence under the switch: the state of the global instructions for
 * this room, said once, without restating what the toggle already shows. The
 * same module as the outcome table, so the hint and every result come
 * from one place and the smoke holds them all to the server.
 * "" before the view is loaded. A view from an older server, which has no
 * global part, says so and the pane offers nothing.
 */
export function switchHint(view: RoomInstructionsOutcomeView | null): string {
	if (!view) return "";
	const global = view.global;
	if (!global) return "This server does not have global instructions yet.";
	if (!global.enabled) return "This room follows only its own instructions.";
	if (global.instructions.unreadable) {
		// The per-turn section is silent while the global file cannot be read
		// (the record holds one composed fingerprint), so an open conversation
		// keeps its text whatever this room's own file does; a new one boots
		// with this room's own text when there is one to read.
		const fresh = view.instructions.unreadable || !view.instructions.text ? "without instructions" : "with this room's own instructions";
		return `They cannot be read right now (${global.instructions.unreadable}). New conversations start ${fresh}; a conversation that is already open keeps what it started with, edits to this room's text included, until that is fixed.`;
	}
	if (!global.instructions.text) return "None are written yet. Write them in Settings, Instructions (the gear at the bottom of the sidebar); every room with this switch on follows them.";
	if (view.instructions.unreadable || !view.instructions.text) return "This room follows them.";
	return "Where the two disagree, this room's own instructions win.";
}
