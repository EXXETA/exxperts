/**
 * A model the provider no longer offers: the ONE matcher for its words and
 * the ONE sentence for a row whose chosen model cannot run (no longer
 * offered, or its provider signed out). Used by the room's refusals
 * (room-models.ts), the Memory model's failures (model-call-causes.ts) and
 * the chat turn's line in the web page.
 *
 * Deliberately pure (no node imports) so the web UI imports this source
 * directly, like model-not-on-account.ts.
 */

/**
 * The model is gone: not in the registry, the provider no longer serves it, or this key has no access to it.
 * A model's id may hold dots ("gpt-6.1-sol", "claude-opus-4.6"): a dot inside a word does not end the sentence.
 * OpenAI's own words, "The model `gpt-6.1-sol` does not exist or you do not have access to it.", match whatever the id holds;
 * the same words about anything but a model (a project, a file) do not. A 404 counts only when "model" follows it
 * before a slash: a URL's path ("/v1/model/info") never carries it.
 */
export function modelNotOffered(message: string): boolean {
	return /\b(?:does not|doesn't|has no) (?:have )?access to (?:this |the )?model\b|\bmodel not found\b|\bmodel_not_found\b|\bno longer offered\b|\bmodel\b(?:[^.]|\.(?=[\w-])){0,120}\bdoes not exist\b|\bnot_found_error\b(?:[^.]|\.(?=[\w-])){0,120}\bmodel\b|\b404\b(?:[^./]|\.(?=[\w-])){0,120}\bmodel\b/i.test(message);
}

/** Whose row it is: the room at hand, another room by name (a consult), or AI setup's Default models. */
export type RoomModelRefusalOf = "room" | "defaults" | { room: string };

/**
 * The sentence (draft wording) for a row whose chosen model cannot run, also
 * for a call the provider refused because it no longer serves the model.
 * `model` is the model as the picker names it, with its provider
 * ("GPT-6.1 Sol on OpenAI", see modelOnProvider).
 */
export function roomModelUnavailableLine(model: string, reason: "signed-out" | "not-offered", task: "conversation" | "memory", of: RoomModelRefusalOf = "room"): string {
	const row = task === "memory" ? "memory model" : "model";
	const subject = of === "room" ? `This room's ${row}` : of === "defaults" ? `The default ${row}` : `The ${row} of ${of.room}`;
	const settings = typeof of === "object" ? "its Room settings, Model" : "Room settings, Model";
	const state = reason === "signed-out" ? "is signed out" : "is no longer offered";
	const wayOut = of !== "defaults"
		? reason === "signed-out" ? `Sign in again in Settings, AI setup, or choose another model in ${settings}.` : `Choose another ${task === "memory" ? "Memory model" : "model"} in ${settings}.`
		: reason === "signed-out" ? "Sign in again, or choose another default, in Settings, AI setup." : "Choose another default in Settings, AI setup.";
	return `${subject}, ${model}, ${state}. ${wayOut}`;
}
