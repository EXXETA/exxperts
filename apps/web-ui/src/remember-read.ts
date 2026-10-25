// How Remember reads a conversation: in one pass, or in parts when it is too
// long for the Memory model's window. The server decides; the person is told
// only what they must act on (a window too small for any read) and where the
// read is (the progress line). How it read goes to the diagnostics.

import { fetchJson } from "./api";
import { modelDisplayName } from "./model-names";

export interface RememberReadModel {
	provider: string;
	model: string;
	label?: string;
}

/** The server's estimate before anything is generated. */
export interface RememberReadEstimate {
	mode: "one-pass" | "parts";
	reads: number;
	model: RememberReadModel;
	contextWindow?: number;
	/** The memory beside the conversation: whole, as its outline, or a window too small for any read. */
	fits?: "full" | "short-memory" | "no";
}

/** What the server did, on the proposal. */
export interface RememberRead {
	mode: "one-pass" | "parts";
	reads: number;
	model: RememberReadModel;
	trimmedToolOutputs: number;
	toolOutputCapChars: number;
	mustKeep?: { partNotes: number; body: number };
	/** Every part was refused and the page holds only the date. */
	refusedWhole?: boolean;
}

export async function fetchRememberReadEstimate(agentId: string, conversationId: string): Promise<RememberReadEstimate> {
	return await fetchJson<RememberReadEstimate>(`/api/persistent-agents/${encodeURIComponent(agentId)}/checkpoint/estimate?conversationId=${encodeURIComponent(conversationId)}`);
}

/** The model's name as the app shows it everywhere, never the wire label with its provider. */
export function rememberModelName(model: RememberReadModel): string {
	return modelDisplayName({ model: model.model, modelLabel: model.label, provider: model.provider }) || model.model;
}

/** The Remember dialog, before generating: only a window too small for any read is said. */
export function rememberEstimateSentence(estimate: RememberReadEstimate): string | null {
	if (estimate.fits !== "no") return null;
	return `This conversation and this room's memory are more than ${rememberModelName(estimate.model)} can read, even in parts. Choose a Memory model that can read more at once in Room settings, Model.`;
}

/**
 * Whether a Remember request carries the visible transcript: only for a
 * conversation from before session files (the recap kind), which the server
 * reads from what the client shows. A session-backed conversation is read from
 * its session file, so the request stays small however long it is; an unknown
 * kind sends it, as before.
 */
export function rememberSendsTranscript(runtimeKind: string | undefined): boolean {
	return runtimeKind !== "pi-session-jsonl";
}

/**
 * Whether "Remember without the preview" opens the preview instead of saving:
 * only for an entry with no arc or no body (a bug, since the server repairs
 * both). No engine warning stops the quick save, and no reason is shown.
 */
export function quickRememberNeedsPreview(proposal: { fields: { sessionArc: string; body: string } }): boolean {
	return !proposal.fields.sessionArc.trim() || !proposal.fields.body.trim();
}

/** The generating dialog's line: which part is being read, once there are parts. */
export function rememberProgressSentence(progress: { read: number; of: number } | null): string {
	if (!progress || progress.of <= 1) return "Remember is reading the conversation.";
	return `Remember is reading the conversation (part ${Math.min(progress.read + 1, progress.of)} of ${progress.of}).`;
}

/** A Remember stopped because another window saved its conversation: an outcome, not an error. */
export const REMEMBER_SAVED_ELSEWHERE = "This conversation was saved from another window.";
/** A Remember stopped because another window forgot its conversation: an outcome too. */
export const REMEMBER_FORGOTTEN_ELSEWHERE = "This conversation was forgotten from another window.";

/**
 * The sentences Remember says in the person's words (the generation gate, a
 * conversation too long for the Memory model, a cancel, a conversation that
 * changed or another one open, an entry Save cannot take). The dialog shows
 * them as they are.
 */
export function isPlainRememberSentence(message: string): boolean {
	return /^(Remember is (already )?reading this conversation|This conversation is too long for .+ to remember|.+ could not write notes for part of this conversation\. Choose another Memory model|Remember was cancelled|Remember could not store the entry on this computer|Remember stopped (unexpectedly|because another conversation is open)|This conversation (changed after Remember read it|was (saved|forgotten) from another window)|The Memory model changed after this entry was written|The app restarted while Remember was reading|A heading line or an HTML comment|Write what to keep before saving|Part of this entry can't be read|This entry is too long to save|A line saying checkpoint_id or session_id is none|This window is out of date)/.test(message);
}

/** Whether a Remember line is the plain outcome of what happened, shown as a status, not an error. */
export function isRememberOutcome(message: string): boolean {
	return message === REMEMBER_SAVED_ELSEWHERE || message === REMEMBER_FORGOTTEN_ELSEWHERE;
}

/** The dialog after the app restarted while Remember was reading; the notes it read are kept either way. */
export function rememberRestartSentence(): string {
	return "The app restarted while Remember was reading. Generate again to finish.";
}

/** Whose safety check refused a conversation: the maker of the Memory model, from the model itself. */
function safetyCheckOwner(model: { provider: string; model: string; label?: string }): string {
	if (model.provider === "anthropic" || /claude/i.test(model.model) || /claude/i.test(model.label ?? "")) return "Claude";
	if (model.provider === "openai-codex" || model.provider === "openai") return "ChatGPT";
	return modelDisplayName({ provider: model.provider, model: model.model, modelLabel: model.label ?? null });
}

/**
 * The one line at the save of a page the provider refused whole (decision 40:
 * the day alone, as title, arc and point), else null (draft). Its words stay
 * searchable: the room finds a remembered conversation from its Remember on.
 */
export function rememberRefusedWholeSentence(proposal: { process: { model: { provider: string; model: string; label?: string } }; rememberRead?: { refusedWhole?: boolean } }): string | null {
	// The server says it: a dated page also comes from a conversation of greetings, which no safety check refused.
	if (proposal.rememberRead?.refusedWhole !== true) return null;
	return `Saved. ${safetyCheckOwner(proposal.process.model)}'s safety check would not read this conversation, so its memory keeps only the date. The room can still look it up when you ask about it.`;
}

/** A sentence written for the person: plain words, ending a sentence, with no code, path or status in it. The product's name opens one in lower case. */
export function isPlainProductSentence(message: string): boolean {
	return /^(?:[A-Z]|exxperts\b)[^{}<>\[\]=]*[.!?]$/.test(message.trim()) && !/\b(?:Error|failed|ENOENT|EACCES|ENOSPC|ECONN\w*|HTTP|status \d+)\b|\(\d{3}\)|\/[\w.-]+\//.test(message);
}

/** The one plain stop for a Remember failure nothing classified (a full disk, an odd provider reply); its detail goes to the console. */
export const REMEMBER_STOPPED_SENTENCE = "Remember stopped unexpectedly. Nothing was saved. Generate again.";
/** The conversations a room holds before Memorize must make room; mirrors RECENT_CONTEXT_BLOCK_CAP in persistent-agents.ts. */
export const RECENT_SESSIONS_BLOCK_CAP = 20;

/** The warning one Remember before the room fills, and the line once it is full. */
export function recentSessionsHeadsUp(count: number | null | undefined, room = "This room"): string | null {
	if (count === RECENT_SESSIONS_BLOCK_CAP - 1) return "One more remembered conversation fills this room. Then Memorize before starting a new one.";
	if (typeof count === "number" && count >= RECENT_SESSIONS_BLOCK_CAP) return `${room} now holds ${count} conversations, as many as it can. Memorize them to start a new conversation.`;
	return null;
}

/**
 * Before Save: the heads-up for the count this save leaves. The proposal
 * counts the room's conversations before the save; the save adds one.
 */
export function rememberFillsRoomHeadsUp(countBefore: number | null | undefined, room = "this room"): string | null {
	if (typeof countBefore !== "number") return null;
	if (countBefore + 1 >= RECENT_SESSIONS_BLOCK_CAP) return `This save fills ${room}: it will hold ${countBefore + 1} conversations, as many as it can. Then Memorize them to start a new conversation.`;
	return recentSessionsHeadsUp(countBefore + 1);
}

/** A save that landed whose fresh conversation could not be opened (draft): the plain outcome, never "did not work". */
export const REMEMBER_SAVED_REOPEN_SENTENCE = "Saved. Enter the room again from its card.";

/** A Save that finds the entry saved by another window: the plain outcome, and why this window is on Home. */
export const REMEMBER_SAVED_ELSEWHERE_SENTENCE = "Already saved in another window. Enter the room again from its card.";

/** A memory file whose structure is broken: saving cannot work until it is repaired, so no Generate again is offered. Null for any other line. */
export const REMEMBER_DAMAGED_SENTENCE = "This room's memory file is damaged, so Remember cannot save. Nothing was lost.";

export function rememberDamagedSentence(message: string): string | null {
	// The server's structure checks (persistent-agents.ts, memory-shape.ts); a change there changes this match.
	return /\bL1b (?:missing mandatory section|topology must be|Recent Context contains (?:duplicate|malformed))/.test(message) ? REMEMBER_DAMAGED_SENTENCE : null;
}

export function rememberFailureSentence(message: string): string {
	if (isPlainProductSentence(message)) return message;
	console.info(`[remember] ${message}`);
	return REMEMBER_STOPPED_SENTENCE;
}
