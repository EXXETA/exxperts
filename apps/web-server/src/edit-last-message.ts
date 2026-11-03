// The person edits their last message: the conversation steps back to before
// it with the runtime's own tree move (as failed-prompt-step-back.ts does), so
// the model no longer reads the message or its answer, and the edited text is
// sent in its place. Steps of the removed answer that changed something are
// not undone: the model is told which in a note in front of the edited
// message, so it still knows those files exist, and the step back writes them
// down, so a second edit of the same message tells the model about both.

import { defangNoteMarkers, withoutAnswerNote } from "./cut-answer-note.js";
import { commandRan } from "./persistent-room-bash-approval.js";
import { userAuthoredPromptText } from "./persistent-room-delegate-tool.js";

/** What the edit needs of a room's session. */
interface EditingSession {
	sessionManager: {
		getLeafEntry(): EditEntry | undefined;
		getEntry(id: string): EditEntry | undefined;
		appendCustomEntry(customType: string, data?: unknown): string;
	};
	navigateTree(targetId: string): Promise<{ cancelled: boolean }>;
}

interface EditEntry {
	id: string;
	parentId: string | null;
	type: string;
	customType?: string;
	data?: unknown;
	message?: { role?: string; content?: unknown; toolCallId?: string; isError?: boolean; details?: unknown; stopReason?: string };
}

/** Why an edit was refused: the page puts everything back and says so. */
export type EditRefusal = "running" | "held" | "no-message" | "not-typed" | "not-shown" | "shortened" | "cancelled";

/** `ran`: what the replaced answer changed, for the line; `kept`: that and what earlier edits of this message had already left, for the model's note. */
export type EditStepBack = { ok: true; ran: string[]; kept: string[] } | { ok: false; refused: EditRefusal };

// A summary of the conversation: stepping back past it would leave the paid summary on an abandoned branch.
export const SUMMARY_ENTRY_TYPES: ReadonlySet<string> = new Set(["compaction", "branch_summary"]);

// Written right after every edit's step back, so it sits just before the edited message: what had changed and stays (maybe nothing). Written down, the step back also outlasts a reload: the session file reopens on its last entry.
const EDIT_KEPT = "edit-kept-steps";
// Written right before a prompt the server sends by itself (the request for a missing answer), so an edit passes over it to the person's message.
const APP_PROMPT = "app-prompt";

export const EDITED_MESSAGE_OPEN = "[EDITED MESSAGE]";
export const EDITED_MESSAGE_CLOSE = "[/EDITED MESSAGE]";

function textOnly(content: unknown): string | undefined {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return undefined;
	if (content.some((part) => (part as { type?: unknown })?.type !== "text")) return undefined;
	return content.map((part) => String((part as { text?: unknown }).text ?? "")).join("");
}

function clip(text: string, max = 60): string {
	const line = text.split("\n")[0]!.trim();
	return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/**
 * How a step ended: with a result, with an error after it ran (a command that
 * failed may have changed things first), with an error and nothing run (a
 * refused, missing or failed step), or with no result at all (stopped while
 * it ran). The runtime gives a result to every call it starts, a stopped one
 * included, so a call with no result began only when its message asked for
 * the tools to run; one cut while the model was still writing it never ran.
 */
export type StepEnd = "done" | "ran-and-failed" | "failed" | "unanswered";

/** What one step changed, in the words of the not-undone line, or nothing for a step that only read or changed nothing. */
export function changedThingOf(name: string, args: unknown, end: StepEnd): string | undefined {
	if (end === "failed") return undefined;
	const a = (args && typeof args === "object" ? args : {}) as Record<string, unknown>;
	const named = (key: string) => (typeof a[key] === "string" && a[key] ? clip(String(a[key])) : "");
	if (name === "write") return `wrote ${named("path") || "a file"}`;
	if (name === "edit") return `edited ${named("path") || "a file"}`;
	if (name === "artifact_write" || name === "artifact_write_html_deck") return `wrote ${named("name") || named("path") || named("title") || "an artifact"}`;
	if (name === "bash") return `ran ${named("command") || "a command"}`;
	// Only a connector's own tool acts; listing, searching and describing its tools read.
	if (name === "mcp" && named("tool")) return `used ${named("tool")}${named("server") ? ` (${named("server")})` : ""}`;
	if (name === "delegate_task") return "started a helper";
	return undefined;
}

function stepEndOf(result: EditEntry["message"] | undefined, askedToRun: boolean): StepEnd {
	if (!result) return askedToRun ? "unanswered" : "failed";
	if (!result.isError) return "done";
	return commandRan(result.details) ? "ran-and-failed" : "failed";
}

/** The entry before this one, passing over what carries no words (a model or thinking change, the room's marks), up to a message or a summary. */
function wordsBefore(manager: EditingSession["sessionManager"], entry: EditEntry): { at?: EditEntry; marks: EditEntry[] } {
	const marks: EditEntry[] = [];
	let at = entry.parentId ? manager.getEntry(entry.parentId) : undefined;
	while (at && at.type !== "message" && !SUMMARY_ENTRY_TYPES.has(at.type)) {
		if (at.type === "custom") marks.push(at);
		at = at.parentId ? manager.getEntry(at.parentId) : undefined;
	}
	return { at, marks };
}

function readKept(data: unknown): string[] {
	const kept = (data as { kept?: unknown } | undefined)?.kept;
	return Array.isArray(kept) ? kept.filter((thing): thing is string => typeof thing === "string" && thing.trim() !== "") : [];
}

/**
 * The newest message the person sent and what came after it, on the
 * session's current path: the entry, the steps that changed things in
 * between, in order and without repeats, and what earlier edits of this
 * message had already left. A prompt the server sent by itself belongs to
 * the answer, not the person. `shortened` when a summary lies between, since
 * stepping back past it would throw the summary away.
 */
function lastMessageOf(manager: EditingSession["sessionManager"]): { entry?: EditEntry; ran: string[]; earlier: string[]; shortened: boolean } {
	const calls: { id: string; name: string; args: unknown; askedToRun: boolean }[] = [];
	const results = new Map<string, EditEntry["message"]>();
	let entry = manager.getLeafEntry();
	let earlier: string[] = [];
	while (entry) {
		if (SUMMARY_ENTRY_TYPES.has(entry.type)) return { ran: [], earlier: [], shortened: true };
		const message = entry.type === "message" ? entry.message : undefined;
		const before = wordsBefore(manager, entry);
		if (message?.role === "user" && !before.marks.some((mark) => mark.customType === APP_PROMPT)) {
			earlier = readKept(before.marks.find((mark) => mark.customType === EDIT_KEPT)?.data);
			break;
		}
		if (message?.role === "toolResult" && message.toolCallId) results.set(message.toolCallId, message);
		if (message?.role === "assistant" && Array.isArray(message.content)) {
			const askedToRun = message.stopReason === "toolUse";
			const own = message.content.filter((part: any) => part?.type === "toolCall" && typeof part.name === "string").map((part: any) => ({ id: String(part.id ?? ""), name: String(part.name), args: part.arguments, askedToRun }));
			calls.unshift(...own);
		}
		entry = before.at;
	}
	const ran = [...new Set(calls.map((call) => changedThingOf(call.name, call.args, stepEndOf(results.get(call.id), call.askedToRun))).filter((thing): thing is string => !!thing))];
	return { entry, ran, earlier, shortened: false };
}

/**
 * The typed text of a user message as the room shows it, without the notes
 * the room puts in front of it (after a cut, a Stop or an edit), or nothing
 * for one carrying more than the person typed (a file note, a transfer, an
 * image), since only typed text can go back into a box.
 */
export function typedMessageText(content: unknown): string | undefined {
	const wire = textOnly(content);
	const sent = wire === undefined ? undefined : withoutEditNote(withoutAnswerNote(wire));
	if (sent === undefined || !sent.trim() || userAuthoredPromptText(sent).trim() !== sent.trim()) return undefined;
	return sent.trim();
}

function typedText(entry: EditEntry): string | undefined {
	return typedMessageText(entry.message?.content);
}

/** Whether the conversation's newest message can still be edited: typed text, with no shortening since. */
export function lastMessageEditable(session: Pick<EditingSession, "sessionManager"> | null | undefined): boolean {
	const manager = session?.sessionManager;
	if (!manager) return false;
	const { entry, shortened } = lastMessageOf(manager);
	return !shortened && !!entry && typedText(entry) !== undefined;
}

/**
 * The saved bubble of the newest message when it cannot be edited (a
 * shortening since; `notThePersons`: a message handed back, or a scheduled
 * run's prompt, which the person never sent), named by its id so that the
 * page holds back only that one, never a message sent after it.
 */
export function notEditableMessageId(session: Pick<EditingSession, "sessionManager"> | null | undefined, items: ReadonlyArray<unknown> | undefined, notThePersons: boolean): string | undefined {
	const bubble = [...(items ?? [])].reverse().find((item) => (item as { kind?: unknown } | null)?.kind === "user") as { id?: unknown } | undefined;
	if (typeof bubble?.id !== "string" || !bubble.id) return undefined;
	return notThePersons || !lastMessageEditable(session) ? bubble.id : undefined;
}

/**
 * Steps the session back to before its newest message, when that message is
 * typed text, reads as `shown` (the bubble the person edited), and no
 * shortening came after it; answers the steps that had changed something,
 * and writes them down with the earlier edits' ones for the next edit.
 */
export async function stepBackForEdit(session: EditingSession, shown: string): Promise<EditStepBack> {
	const manager = session.sessionManager;
	const { entry, ran, earlier, shortened } = lastMessageOf(manager);
	if (shortened) return { ok: false, refused: "shortened" };
	if (!entry) return { ok: false, refused: "no-message" };
	const typed = typedText(entry);
	if (typed === undefined) return { ok: false, refused: "not-typed" };
	if (typed !== shown.trim()) return { ok: false, refused: "not-shown" };
	const moved = await session.navigateTree(entry.id);
	if (moved.cancelled) return { ok: false, refused: "cancelled" };
	const kept = [...new Set([...earlier, ...ran])];
	// A custom entry never reaches the model; the next message's note and the next edit read it back.
	manager.appendCustomEntry(EDIT_KEPT, { kept });
	return { ok: true, ran, kept };
}

/**
 * What the next message's note names: the steps an edit's step back wrote
 * down, while no message has come after it. So the edited message carries
 * them, and so does the same text sent again after a failed attempt handed
 * it back.
 */
export function keptBeforeNextMessage(session: Pick<EditingSession, "sessionManager"> | null | undefined): string[] {
	const manager = session?.sessionManager;
	let at = manager?.getLeafEntry();
	while (manager && at && at.type !== "message" && !SUMMARY_ENTRY_TYPES.has(at.type)) {
		if (at.type === "custom" && at.customType === EDIT_KEPT) return readKept(at.data);
		at = at.parentId ? manager.getEntry(at.parentId) : undefined;
	}
	return [];
}

/** Marks the next prompt as the server's own, so an edit after it goes to the person's message before it. */
export function markAppPrompt(session: Pick<EditingSession, "sessionManager">): void {
	session.sessionManager.appendCustomEntry(APP_PROMPT, {});
}

/** The line the room shows where the replaced answer was, when steps of it had changed something: the page shows it live and the new turn's landing saves it, under one id. */
export interface NotUndoneLine { id: string; text: string }

export function notUndoneLine(turnKey: string, ran: readonly string[]): NotUndoneLine | undefined {
	if (ran.length === 0) return undefined;
	return { id: `edit-ran-${turnKey}`, text: `Done before your edit and not undone: ${ran.join(", ")}.` };
}

/** The note in front of the edited message, or nothing when no step of a removed answer changed anything. */
export function editNoteText(kept: readonly string[]): string {
	if (kept.length === 0) return "";
	const list = defangNoteMarkers(kept.join(", "));
	return [EDITED_MESSAGE_OPEN, `The person edited their last message. The earlier answer was removed, but these steps had already run and their effects remain: ${list}.`, EDITED_MESSAGE_CLOSE].join("\n");
}

/** The edited message as the model gets it. */
export function withEditNote(kept: readonly string[], message: string): string {
	const note = editNoteText(kept);
	return note ? `${note}\n\n${message}` : message;
}

/** The message without the note `withEditNote` put in front of it; any other text comes back as it is. */
export function withoutEditNote(text: string): string {
	if (!text.startsWith(`${EDITED_MESSAGE_OPEN}\n`)) return text;
	const close = `\n${EDITED_MESSAGE_CLOSE}\n\n`;
	const end = text.indexOf(close);
	return end < 0 ? text : text.slice(end + close.length);
}

/** An edit as the prompt frame names it: the bubble's id and the text it showed. */
export interface EditFrame { replaces: string; text: string }

export function readEditFrame(raw: unknown): EditFrame | undefined {
	if (!raw || typeof raw !== "object") return undefined;
	const { replaces, text } = raw as { replaces?: unknown; text?: unknown };
	if (typeof replaces !== "string" || !replaces || replaces.length > 200 || typeof text !== "string" || !text.trim()) return undefined;
	return { replaces, text };
}

/**
 * The thread items the edit replaces: the edited bubble and its answer, up to
 * the next message, or none when the file lacks it. The next message is the
 * edited text itself once the page has saved it, and it stays.
 */
export function replacedItemIds(items: ReadonlyArray<unknown>, bubbleId: string): string[] {
	const isUser = (item: unknown) => (item as { kind?: unknown } | null)?.kind === "user";
	const idOf = (item: unknown) => String((item as { id?: unknown } | null)?.id ?? "");
	const at = items.findIndex((item) => isUser(item) && idOf(item) === bubbleId);
	if (at < 0) return [];
	const next = items.findIndex((item, index) => index > at && isUser(item));
	return items.slice(at, next < 0 ? undefined : next).map(idOf).filter(Boolean);
}
