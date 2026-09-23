import { countPersistentRoomInstructionsControlCharacters, normalizePersistentRoomInstructionsText } from "../../../web-server/src/persistent-room-instructions-text";

/**
 * What the two Instructions panes (Settings → Instructions for the global text,
 * Room settings → Instructions for one room) have in common: how a reply
 * is read, how a draft is measured, and how the counter and the saved-at
 * line are worded. One module, so the two panes cannot drift apart.
 */

// A bare status phrase is what the framework puts in `error` when it refuses
// a request itself (a malformed body, a payload too large); whatever it says
// in `message` is at least specific, so prefer that over the bare phrase.
const BARE_STATUS_PHRASE = /^(bad request|not found|payload too large|unsupported media type|internal server error|unauthorized|forbidden|conflict)$/i;

export async function readInstructionsReply<T>(response: Response, fallback: string): Promise<T> {
	const text = await response.text();
	let payload: unknown = null;
	try { payload = text.trim() ? JSON.parse(text) : null; } catch { payload = text; }
	if (!response.ok) {
		const record = payload && typeof payload === "object" ? (payload as { error?: unknown; message?: unknown }) : {};
		const sentence = [record.error, record.message].find((value) => typeof value === "string" && value.trim() && !BARE_STATUS_PHRASE.test(value.trim())) as string | undefined;
		throw new Error(sentence ? sentence.trim() : `${fallback} (${response.status}).`);
	}
	return payload as T;
}

export function savedAtLabel(iso: string | null | undefined): string | null {
	if (!iso) return null;
	const date = new Date(iso);
	if (Number.isNaN(date.getTime())) return null;
	return date.toLocaleString(undefined, { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
}

/**
 * Measured the way the server measures: the normalized text, not the raw box.
 * The same text is what Save sends and what "unsaved" is judged against, so a
 * stray trailing newline is neither a change nor a longer text.
 */
export function measureInstructionsDraft(draft: string, maxChars: number): { measured: string; over: number; controls: number; count: string } {
	const measured = normalizePersistentRoomInstructionsText(draft);
	const over = Math.max(0, measured.length - maxChars);
	const controls = countPersistentRoomInstructionsControlCharacters(draft);
	// The control-character sentence comes first: it is the refusal the server
	// would give first, and shortening the text does not clear it.
	const count = controls > 0
		? `${controls.toLocaleString()} invisible control ${controls === 1 ? "character" : "characters"}, usually from a paste. Remove ${controls === 1 ? "it" : "them"} to save.`
		: over > 0
			? `${measured.length.toLocaleString()} characters, ${over.toLocaleString()} over the limit of ${maxChars.toLocaleString()}. Shorten them to save.`
			: `${measured.length.toLocaleString()} of ${maxChars.toLocaleString()} characters`;
	return { measured, over, controls, count };
}

/**
 * Clear and its way back. Clear empties the box by the app's hand, so the
 * browser's own undo does not bring the text back; the pane remembers what the
 * box held and the same link reads Undo until the offer ends. The whole rule
 * lives here as functions of plain values: a pane keeps one state, sends it
 * the events below and renders what instructionsClearLink says.
 */
export interface InstructionsBoxState {
	/** What the box holds. */
	draft: string;
	/** What Clear took out of the box, or null when there is nothing to put back. */
	remembered: string | null;
}

export type InstructionsBoxEvent =
	/** The Clear or Undo link was clicked; which one follows from the state. */
	| { type: "link" }
	/** The person typed or pasted: the box's new value. */
	| { type: "type"; value: string }
	/** Save was pressed, before the request is sent and whatever its result. */
	| { type: "save" }
	/** The pane set the box from the server: a load, a reload, a save's reply. */
	| { type: "reload"; value: string };

export const EMPTY_INSTRUCTIONS_BOX: InstructionsBoxState = { draft: "", remembered: null };

/** What the link reads, or null for no link. Disabled while saving, in both words. */
export function instructionsClearLink(state: InstructionsBoxState, saving: boolean): { label: "Clear" | "Undo"; disabled: boolean } | null {
	if (state.remembered !== null) return { label: "Undo", disabled: saving };
	if (state.draft !== "") return { label: "Clear", disabled: saving };
	return null;
}

/**
 * Clear remembers the box as it stood, unsaved edits included, and empties it;
 * Undo puts that text back byte for byte. Typing, Save and a reload end the
 * offer. A switch flip in the room pane is not an event here, so it ends nothing.
 */
export function reduceInstructionsBox(state: InstructionsBoxState, event: InstructionsBoxEvent): InstructionsBoxState {
	switch (event.type) {
		case "link":
			if (state.remembered !== null) return { draft: state.remembered, remembered: null };
			if (state.draft !== "") return { draft: "", remembered: state.draft };
			return state;
		case "type":
			return { draft: event.value, remembered: null };
		case "save":
			return state.remembered === null ? state : { draft: state.draft, remembered: null };
		case "reload":
			return { draft: event.value, remembered: null };
	}
}

export const ROOM_INSTRUCTIONS_PLACEHOLDER = "Answer in German unless I write in English.\nLead with the recommendation, then the reasoning.\nAsk before assuming anything about budget or deadlines.";
export const GLOBAL_INSTRUCTIONS_PLACEHOLDER = "Be concise and technically precise.\nAsk before assuming when a request is ambiguous.\nName the trade-off before the recommendation.\nNever invent a date, a name or a number.";
