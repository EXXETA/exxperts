// What the model is told when the person cut its answer, stopped it, or sent
// a message while it worked, and after exxperts stopped mid-answer. The
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

/** A message that goes in after a step, as the model gets it. */
export function sentWhileYouWorked(message: string): string {
	return `${SENT_WHILE_YOU_WORKED_OPEN} Sent by the person while you worked. Take it into account; keep going with the task unless it changes it. ${SENT_WHILE_YOU_WORKED_CLOSE}\n\n${message}`;
}
