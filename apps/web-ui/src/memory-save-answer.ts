// A memory save whose answer never came back, and the lines every memory
// editor shows before Save. A save can land while its answer is lost (the
// connection drops after the server wrote the file, or a proxy answers 502):
// the page never says that nothing was saved, it says the connection dropped,
// asks the server again by itself, and then shows what is true.
import { isUnexplainedRequestFailure } from "./api";
import { fetchMemoryHistory } from "./memory-entries-api";
import type { PersistentAgentId } from "./types";
import { memoryTextHasWords, memoryTypedText } from "../../web-server/src/memory-typed-text";

/** Shown while the page finds out whether a save whose answer was lost landed (draft). */
export const SAVE_ANSWER_LOST_SENTENCE = "The connection dropped while saving. Checking whether it was saved…";
/** Shown when the server answers again and the save had not landed (draft). */
export const SAVE_NOT_LANDED_SENTENCE = "It was not saved. Save again.";
/** Shown when the server answers again and the undo had not landed (draft). */
export const UNDO_NOT_LANDED_SENTENCE = "It was not undone. Undo again.";

/** A save's answer was lost: the network, or a server error with no word of its own. Never a refusal. */
export function saveAnswerLost(error: unknown): boolean {
	return isUnexplainedRequestFailure(error);
}

/** How long the page waits between two asks while the server cannot be reached. */
export const SAVE_ANSWER_RETRY_MS = 2_000;

/**
 * Asks until the server answers: a lost answer again waits and asks again,
 * anything else (an answer or a refusal) is the server speaking and ends the wait.
 */
export async function askUntilAnswered<T>(ask: () => Promise<T>, options: { retryMs?: number; stopped?: () => boolean } = {}): Promise<T> {
	for (;;) {
		try {
			return await ask();
		} catch (error) {
			if (!saveAnswerLost(error) || options.stopped?.()) throw error;
		}
		await new Promise((resolve) => setTimeout(resolve, options.retryMs ?? SAVE_ANSWER_RETRY_MS));
	}
}

/**
 * After a Memorize or Review Save whose answer was lost, what is true: the run
 * is read until the server answers; a run still saving is read again; a run
 * that is ready was not saved; a run that saved, or one that is gone (a
 * restart, a newer run), is asked with the Save itself, which answers that it
 * saved without writing twice, or refuses as it would have.
 */
export async function settleLostRunSave<R extends { state: string }, A>(options: { read: () => Promise<R>; save: () => Promise<A>; gone: (error: unknown) => boolean; stopped: () => boolean; retryMs?: number }): Promise<{ saved: A } | { unsaved: R }> {
	const retryMs = options.retryMs ?? SAVE_ANSWER_RETRY_MS;
	for (;;) {
		let run: R | null = null;
		try {
			run = await askUntilAnswered(options.read, { retryMs, stopped: options.stopped });
		} catch (error) {
			if (!options.gone(error)) throw error;
		}
		if (run?.state === "ready") return { unsaved: run };
		if (run?.state !== "approving") return { saved: await askUntilAnswered(options.save, { retryMs, stopped: options.stopped }) };
		if (options.stopped()) throw new Error("stopped");
		await new Promise((resolve) => setTimeout(resolve, retryMs));
	}
}

/** After an Undo whose answer was lost: whether the room's history shows that save undone, once the server answers. */
export async function lostUndoLanded(agentId: PersistentAgentId, saveId: string, stopped: () => boolean): Promise<boolean> {
	const response = await askUntilAnswered(() => fetchMemoryHistory(agentId), { stopped });
	return (response.history ?? []).some((event) => event.undoneSaveId === saveId);
}

/** A note as the server keeps it, set beside what was typed: the same words once the rule and a list mark are set aside. */
export function sameNoteWords(stored: string | undefined, typed: string): boolean {
	const plain = (text: string) => memoryTypedText(text).trim().replace(/^[-*]\s+/, "").replace(/\s+$/gm, "");
	return stored !== undefined && plain(stored) === plain(typed);
}

/** Where a count starts to show: nine tenths of the limit. */
const NEAR_LIMIT = 0.9;

export interface EditorLimitLine {
	/** False when Save must wait: nothing to keep, or past the limit. */
	canSave: boolean;
	/** The line under the editor, or null when there is nothing to say. */
	line: string | null;
}

/**
 * What an editor says before Save about its text, counted as the server counts
 * it: nothing when the text is well inside the limit, a count near the limit,
 * and past it the count with what to do (drafts). `count` is the length the
 * server will measure; an editor with no words says what to write.
 */
export function editorLimitLine(count: number, max: number, hasWords: boolean, empty = "Write something to keep before saving."): EditorLimitLine {
	if (!hasWords) return { canSave: false, line: empty };
	const counted = `${count.toLocaleString("en-US")} of ${max.toLocaleString("en-US")} characters.`;
	if (count > max) return { canSave: false, line: `${counted} Shorten it to save.` };
	if (count >= max * NEAR_LIMIT) return { canSave: true, line: counted };
	return { canSave: true, line: null };
}

/** The limit line for a note's text, counted after the rule as the server counts it. */
export function noteLimitLine(text: string, max: number, empty?: string): EditorLimitLine {
	const kept = memoryTypedText(text).trim();
	return editorLimitLine(kept.length, max, memoryTextHasWords(kept), empty);
}
