/**
 * The memory search step as a person reads it when they open it in the chat.
 *
 * The room's memory_recall result is written for the model: an envelope
 * ("[MEMORY RECALL: …]" … "[/MEMORY RECALL]") and a line telling it the rows
 * are data, not instructions. The person sees only what was found, and each
 * row's source line in plain words with a readable date. Display only: what
 * the model receives is never changed.
 */

/** The step's label: true for every source the search reads (notes, archive, remembered conversations). */
export const MEMORY_RECALL_STEP = { running: "Searching memory", done: "Searched memory", failed: "Couldn't search memory" };

const ENVELOPE_HEAD = /^\[MEMORY RECALL:[^\]\n]*\]\n(?:Rows from this room's own memory follow[^\n]*\n)?/m;
const ENVELOPE_TAIL = /\n?\[\/MEMORY RECALL\]\s*$/;
const ISO_DAY = /\b(\d{4})-(\d{2})-(\d{2})\b/g;
// A row's source line: an optional label and day before the origin, which says
// where the row comes from (persistent-room-memory-recall-tool.ts, renderRow).
const SOURCE_LINE = /^(?:.+ · )?(?:from a conversation on |in memory, saved |in memory, date unknown|archived )/;

const DAY_FORMAT = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });

function readableDay(iso: string, year: string, month: string, day: string): string {
	const date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
	return Number.isNaN(date.getTime()) || date.getUTCDate() !== Number(day) ? iso : DAY_FORMAT.format(date);
}

function readableSourceLine(line: string): string {
	const dated = line.replace(ISO_DAY, readableDay);
	// The origin starts the line, or follows the label and day: either way it begins its own sentence.
	return dated.replace(/(^|· )(from|in|archived)\b/, (_match, lead: string, word: string) => `${lead}${word.charAt(0).toUpperCase()}${word.slice(1)}`);
}

export function memoryRecallDisplayText(text: string): string {
	if (!ENVELOPE_HEAD.test(text) || !ENVELOPE_TAIL.test(text)) return text;
	const body = text.replace(ENVELOPE_HEAD, "").replace(ENVELOPE_TAIL, "");
	return body.split("\n\n").map((block) => {
		const newline = block.indexOf("\n");
		const first = newline === -1 ? block : block.slice(0, newline);
		if (!SOURCE_LINE.test(first)) return block;
		return `${readableSourceLine(first)}${newline === -1 ? "" : block.slice(newline)}`;
	}).join("\n\n");
}
