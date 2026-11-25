// What the model is told when the person cut its answer, stopped it, or sent
// a message while it worked, after exxperts stopped mid-answer, and who sent a
// message where more than one person writes. The
// runtime drops a stopped answer before it reaches the provider, so without
// the note the model would get the person's two messages back to back and
// start its answer again. The note travels in front of the person's message
// only on the way to the model: the bubble, the saved conversation and the
// consent text (userAuthoredPromptText) keep the person's own words. Pure,
// so its smoke runs it in plain node.

import { defangFenceMarkers } from "./consult-handoff.js";
import { STOP_CUT_ANSWER_SENTENCE } from "./turn-ended-by.js";

export const ANSWER_CUT_OFF_OPEN = "[ANSWER CUT OFF]";
export const ANSWER_CUT_OFF_CLOSE = "[/ANSWER CUT OFF]";
export const SENT_WHILE_YOU_WORKED_OPEN = "[SENT WHILE YOU WORKED]";
export const SENT_WHILE_YOU_WORKED_CLOSE = "[/SENT WHILE YOU WORKED]";
export const MESSAGE_FROM_OPEN = "[MESSAGE FROM]";
export const MESSAGE_FROM_CLOSE = "[/MESSAGE FROM]";

/** How the answer before the person's message ended: cut by their message, stopped by their Stop, or cut by exxperts stopping. */
export type AnswerNoteKind = "cut" | "stop" | "server-stop";

export interface AnswerNote {
	kind: AnswerNoteKind;
	/** Exactly the words the person had seen; after a server stop, the words the conversation saved. */
	shown: string;
}

/**
 * Any marker a fence recogniser could match loses its brackets inside quoted
 * text, the consult and specialist families included, so the model's own
 * words can never close the fence early or open a new one. The one list of
 * markers lives in consult-handoff.ts; unlike neutralizeBlockContent, the
 * shown words keep their must-keep emphasis.
 */
export function defangNoteMarkers(text: string): string {
	return defangFenceMarkers(text);
}

/**
 * The words the person saw: the stopped answer's text up to the number of
 * characters the page says it showed. The page's count is only a length:
 * the words come from the server's own copy, so the page cannot put words
 * into the model's mouth.
 */
export function shownPart(text: string, shownChars: number | undefined): string {
	const whole = String(text ?? "");
	if (shownChars === undefined || !Number.isFinite(shownChars)) return whole.trim();
	return whole.slice(0, Math.max(0, Math.floor(shownChars))).trim();
}

const FIRST_LINE: Record<AnswerNoteKind, string> = {
	cut: "Your previous answer was stopped because the person sent the message below while you were writing. This is exactly what they had seen; it stays on their screen:",
	stop: "Your previous answer was stopped by the person. This is exactly what they had seen; it stays on their screen:",
	"server-stop": "Your previous answer was cut off because exxperts stopped while you were writing. This is exactly what had been written; it stays on the person's screen:",
};

/** The fence in front of the person's message after a cut, a Stop or a server stop, or nothing when nothing was shown. */
export function answerNoteText(note: AnswerNote | null | undefined): string {
	const shown = note ? defangNoteMarkers(note.shown).trim() : "";
	if (!note || !shown) return "";
	const first = FIRST_LINE[note.kind];
	const last = note.kind === "cut"
		? "If their message changes what you were doing, follow it. If not (thanks, an addition, a next question), take it into account; if you go back to the stopped answer, start again at the beginning of the sentence it was cut in, and don't repeat anything before that sentence. Never begin with a piece of a sentence. Don't mention the interruption."
		: "Answer their message below. Continue the earlier answer only if they ask you to, and then start again at the beginning of the sentence it stopped in.";
	return [ANSWER_CUT_OFF_OPEN, first, "---", shown, "---", last, ANSWER_CUT_OFF_CLOSE].join("\n");
}

/**
 * The note for the conversation's next message when its last answer is one a
 * server stop cut, from the saved conversation: the stop ended the server
 * run, and with it the note a Stop keeps in memory. The cut answer is saved
 * as the server lands it (the answer, then its own line with the stop's
 * sentence) or as the page saves it (the sentence ending the answer's text).
 * Lines after it (a model switch, a refused message's line) are skipped; any
 * other item means the conversation went on. Whether the model was told
 * already is the caller's to decide, from the model's own history: the page
 * saves a message after the answer to it may have started.
 */
export function serverStopNote(items: readonly unknown[]): AnswerNote | null {
	type Item = { kind?: unknown; text?: unknown } | undefined;
	const pageLine = `\n\n_${STOP_CUT_ANSWER_SENTENCE}_`;
	const text = (item: Item) => (typeof item?.text === "string" ? item.text : "");
	let at = items.length - 1;
	while (at >= 0 && (items[at] as Item)?.kind === "system" && (items[at] as Item)?.text !== STOP_CUT_ANSWER_SENTENCE) at--;
	const last = items[at] as Item;
	const before = items[at - 1] as Item;
	let shown = "";
	if (last?.kind === "system" && before?.kind === "assistant") shown = text(before);
	else if (last?.kind === "assistant" && text(last).trimEnd().endsWith(pageLine)) shown = text(last).trimEnd().slice(0, -pageLine.length);
	shown = shown.trim();
	return shown ? { kind: "server-stop", shown } : null;
}

/** The person's message as the model gets it after a cut, a Stop or a server stop. */
export function withAnswerNote(note: AnswerNote | null | undefined, message: string): string {
	const fence = answerNoteText(note);
	return fence ? `${fence}\n\n${message}` : message;
}

/**
 * The person's message without the note in front of it, as `withAnswerNote`
 * built it; any other text comes back as it is. The shown words inside are
 * defanged, so the first close marker on its own line ends the note.
 */
export function withoutAnswerNote(text: string): string {
	if (!text.startsWith(`${ANSWER_CUT_OFF_OPEN}\n`)) return text;
	const close = `\n${ANSWER_CUT_OFF_CLOSE}\n\n`;
	const end = text.indexOf(close);
	return end < 0 ? text : text.slice(end + close.length);
}

/**
 * The person's message as the model gets it in a shared server's conversation
 * more than one person wrote in: one line in front of it naming who sent it,
 * the app's line, never theirs. The name comes from the company sign-in but is
 * still words a person chose, so it is folded onto one line, loses its
 * brackets (no marker can be made of it) and is quoted, as data. "" when the
 * sign-in gave none. Such a line inside the message loses its brackets, so
 * the message cannot carry a second one in someone else's name.
 */
export function withMessageFrom(name: string, message: string): string {
	const folded = name.replace(/[[\]]/g, "").replace(/\s+/g, " ").trim();
	const who = folded ? JSON.stringify(folded) : "a person whose name is not known";
	return `${MESSAGE_FROM_OPEN} ${who} ${MESSAGE_FROM_CLOSE}\n\n${withoutMessageFromMarkers(message)}`;
}
// This line's marker-like tokens only, taken as consult-handoff.ts FENCE_MARKER_LIKE takes them: the message may carry
// the server's own envelopes (a transfer's), which a defang of every family would open.
const MESSAGE_FROM_LIKE = /\[(?<![[][\s/]*[[])[[\s/]*MESSAGE\s+FROM\b[^[\]\n]*\]?/gi;
/** The text with the brackets taken off every `[MESSAGE FROM]`-like token in it, as `withMessageFrom` sends a message. */
export function withoutMessageFromMarkers(text: string): string {
	return text.replace(MESSAGE_FROM_LIKE, (marker) => marker.replace(/[[\]]/g, ""));
}

/** The message without the line `withMessageFrom` put in front of it; any other text comes back as it is. A line that is the whole text leaves "" (a blank message, trimmed). */
export function withoutMessageFrom(text: string): string {
	if (!text.startsWith(`${MESSAGE_FROM_OPEN} `)) return text;
	const end = text.indexOf(MESSAGE_FROM_CLOSE) + MESSAGE_FROM_CLOSE.length;
	const after = text.slice(end);
	if (end < MESSAGE_FROM_CLOSE.length || text.slice(0, end).includes("\n") || (after !== "" && !after.startsWith("\n\n"))) return text;
	return after.slice(2);
}

/**
 * A message the server sent with the line naming who sent it, as memory and
 * the search over conversations read it: the notes it put in front of that
 * line stay, and the line goes. It is the last such line in the message: the
 * notes in front of it can quote one, but the person's words behind it lost
 * the brackets of theirs. Only for a message sent with the line
 * (messagesWithSenderLine, edit-last-message.ts): without it, such a line is
 * the person's own.
 */
export function withoutMessageFromLine(text: string): string {
	const open = `${MESSAGE_FROM_OPEN} `;
	const after = text.lastIndexOf(`\n\n${open}`);
	const start = after >= 0 ? after + 2 : text.startsWith(open) ? 0 : -1;
	return start < 0 ? text : text.slice(0, start) + withoutMessageFrom(text.slice(start));
}

/** A message that goes in after a step, as the model gets it. */
export function sentWhileYouWorked(message: string): string {
	return `${SENT_WHILE_YOU_WORKED_OPEN} Sent by the person while you worked. Take it into account; keep going with the task unless it changes it. ${SENT_WHILE_YOU_WORKED_CLOSE}\n\n${message}`;
}
