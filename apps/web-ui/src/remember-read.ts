// How Remember reads a conversation: in one pass, or in parts when it is too
// long for the memory model's window. The server decides and says so; these
// are the sentences the Remember dialog, its approval screen and the context
// chip's popover say it with, kept in one place so the three never disagree.

import { fetchJson } from "./api";
import { meaningfulMaintenanceWarnings } from "./maintenance-warnings";
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
}

/** What the server did, on the proposal. */
export interface RememberRead {
	mode: "one-pass" | "parts";
	reads: number;
	model: RememberReadModel;
	trimmedToolOutputs: number;
	toolOutputCapChars: number;
	mustKeep?: { partNotes: number; body: number };
}

export async function fetchRememberReadEstimate(agentId: string, conversationId: string): Promise<RememberReadEstimate> {
	return await fetchJson<RememberReadEstimate>(`/api/persistent-agents/${encodeURIComponent(agentId)}/checkpoint/estimate?conversationId=${encodeURIComponent(conversationId)}`);
}

/** The model's name as the app shows it everywhere, never the wire label with its provider. */
export function rememberModelName(model: RememberReadModel): string {
	return modelDisplayName({ model: model.model, modelLabel: model.label, provider: model.provider }) || model.model;
}

/** The Remember dialog, before generating. */
export function rememberEstimateSentence(estimate: RememberReadEstimate): string {
	const name = rememberModelName(estimate.model);
	return estimate.reads > 1
		? `This conversation is long: Remember reads it in ${estimate.reads} parts on ${name}. A memory model with a larger window reads it in one pass (Room settings, Model).`
		: `Remember reads this conversation in one pass on ${name}.`;
}

/** The context chip's popover: said only when the conversation no longer fits one pass. */
export function rememberChipValue(estimate: RememberReadEstimate | null): string | null {
	if (!estimate || estimate.reads <= 1) return null;
	return `in ${estimate.reads} parts on ${rememberModelName(estimate.model)}`;
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

/** The approval screen: how it was read, by which model, and what was shortened. */
export function rememberReadSentences(read: RememberRead): string[] {
	const name = rememberModelName(read.model);
	const sentences = [read.reads > 1 ? `Read in ${read.reads} parts by ${name}.` : `Read in one pass by ${name}.`];
	const trimmed = rememberToolOutputSentence(read);
	if (trimmed) sentences.push(trimmed);
	return sentences;
}

/** What the read shortened, in plain words, or null when it shortened nothing. */
export function rememberToolOutputSentence(read: Pick<RememberRead, "trimmedToolOutputs" | "toolOutputCapChars"> | null | undefined): string | null {
	if (!read || read.trimmedToolOutputs <= 0) return null;
	const cap = read.toolOutputCapChars.toLocaleString("en-US");
	return read.trimmedToolOutputs === 1
		? `One tool output over ${cap} characters was shortened before reading.`
		: `${read.trimmedToolOutputs} tool outputs over ${cap} characters were shortened before reading.`;
}

/**
 * What keeps "Remember without the preview" from saving on its own, so the
 * preview opens with these reasons instead: the worker's parse warnings or an
 * incomplete proposal. The server's status line ("no memory has been
 * written") is not a problem, and shortened tool output is a count on the
 * read, not a warning: the saved line discloses it.
 */
export function quickRememberBlockers(proposal: { warnings: string[]; fields: { sessionArc: string; body: string } }): string[] {
	const blockers = meaningfulMaintenanceWarnings(proposal.warnings);
	if (!proposal.fields.sessionArc.trim()) blockers.push("the proposal is missing its session arc");
	if (!proposal.fields.body.trim()) blockers.push("the proposal is missing its body");
	return blockers;
}

/** The generating dialog's line: which part is being read, once there are parts. */
export function rememberProgressSentence(progress: { read: number; of: number } | null): string {
	if (!progress || progress.of <= 1) return "Remember is reading the conversation.";
	return `Remember is reading the conversation (part ${Math.min(progress.read + 1, progress.of)} of ${progress.of}).`;
}

/**
 * The sentences the server writes for Remember in the person's words (the
 * generation gate, a conversation too long for the memory model, a part that
 * could not be read, notes too long after every part was read, a cancel). The dialog shows them as they are.
 */
export function isPlainRememberSentence(message: string): boolean {
	return /^(Remember is (already )?reading this conversation|This conversation is too long for .+ to remember|Remember could not read part \d+ of \d+|All \d+ parts of this conversation were read|Remember was cancelled|The memory model changed after this proposal was written)/.test(message);
}
