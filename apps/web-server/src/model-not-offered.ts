/**
 * A model the provider no longer offers: the ONE matcher for its words and
 * the ONE sentence for a row whose chosen model cannot run (no longer
 * offered, or its provider signed out or without its key), with the ONE set
 * of words for a provider whose credential is gone. Used by the room's refusals
 * (room-models.ts), the Memory model's failures (model-call-causes.ts) and
 * the chat turn's line in the web page.
 *
 * Deliberately pure (no node imports) so the web UI imports this source
 * directly, like model-not-on-account.ts.
 */

/**
 * The model is gone: not in the registry, or the provider no longer serves it.
 * A model's id may hold dots ("gpt-6.1-sol", "claude-opus-4.6"): a dot inside a word does not end the sentence.
 * "The model `gpt-6.1-sol` does not exist." matches whatever the id holds; the same words about anything but a model
 * (a project, a file) do not. OpenAI's words for a model this key cannot use match too, but every caller reads them
 * first as not available on the account (model-not-on-account.ts), true whether or not the model is retired.
 * A 404 counts only when "model" follows it before a slash: a URL's path ("/v1/model/info") never carries it.
 */
export function modelNotOffered(message: string): boolean {
	return /\b(?:does not|doesn't|has no) (?:have )?access to (?:this |the )?model\b|\bmodel not found\b|\bmodel_not_found\b|\bno longer offered\b|\bmodel\b(?:[^.]|\.(?=[\w-])){0,120}\bdoes not exist\b|\bnot_found_error\b(?:[^.]|\.(?=[\w-])){0,120}\bmodel\b|\b404\b(?:[^./]|\.(?=[\w-])){0,120}\bmodel\b/i.test(message);
}

/** Whose row it is: the room at hand, another room by name (a consult), or AI setup's Default models. */
export type RoomModelRefusalOf = "room" | "defaults" | { room: string };

/**
 * How a provider's credential is gone: a sign-in is signed out; a key
 * provider's or a gateway's key is missing, or saved and refused by the
 * service.
 */
export type CredentialGone = "signed-out" | "key-missing" | "key-refused" | "key-no-workspace";

/** A key connection's state, as the server carries it beside "signed-out"; absent for a sign-in. */
export type CredentialKey = "missing" | "refused" | "no-workspace";

export function credentialGoneOf(key: CredentialKey | undefined): CredentialGone {
	return key === "missing" ? "key-missing" : key === "refused" ? "key-refused" : key === "no-workspace" ? "key-no-workspace" : "signed-out";
}

/**
 * A missing or rejected sign-in, at the call or in the registry before it.
 * Pure, like the rest of this module, so the web page reads failures with the
 * same words. A 401 counts only as a status (opening the message, or beside
 * "status", "HTTP" or "error code"): inside other words it is a count, as in a
 * rate limit's "Requested 401". A 403 or a permission error is the request
 * refused (a region, a plan), not the credential. Words that only name an API key do not
 * count (Anthropic's workspace 400 says "This API key is not scoped ..."):
 * only the known phrases of a refused or missing credential do, the runtime's
 * own two among them.
 */
export function signInFailed(message: string): boolean {
	return /\bNo API key for provider: |\bAuthentication failed for "[^"]+"\. Credentials may have expired\b|authentication_error|unauthori[sz]ed|^\s*401\b|\b(?:status(?:[ _]?code)?|http(?:\/[\d.]+)?|error[ _]code)\s*[:=]?\s*401\b|\binvalid[ _-]?(?:x-)?api[ _-]?key\b|\bincorrect api key\b|\bapi key (?:is )?(?:invalid|not valid|expired|revoked)\b|\bmissing (?:an? )?api key\b|\bfailed to refresh oauth token\b|\btoken refresh (?:request )?failed\b|token (?:has |is )?(?:expired|invalid|revoked)|invalid[_ ]token|\binvalid credentials?\b|not (?:logged|signed) in|\bprovider not connected\b|\bsigned out\b/i.test(message);
}

/** Anthropic's words for a key outside any workspace: "This API key is not scoped to a workspace, so this request must include the anthropic-workspace-id header ...". */
export function anthropicKeyNeedsWorkspace(message: string): boolean {
	return /not scoped to a workspace|anthropic-workspace-id/i.test(message);
}

/**
 * The words for a provider whose credential is gone. `state` follows the
 * provider's name (for a refused key, the service's name: "Anthropic did not
 * accept the saved key"), `again` is the way back, `button` the notice's
 * button that opens it.
 */
export function credentialGoneWords(gone: CredentialGone): { state: string; again: string; button: string } {
	switch (gone) {
		case "signed-out": return { state: "is signed out", again: "Sign in again", button: "Sign in" };
		case "key-missing": return { state: "has no key saved", again: "Add the key again", button: "Add key" };
		case "key-refused": return { state: "did not accept the saved key", again: "Replace the key", button: "Replace key" };
		// Anthropic refuses every call with a key made outside a workspace.
		case "key-no-workspace": return { state: "has a key that isn't tied to a workspace", again: "Replace it with a key made inside a workspace", button: "Replace key" };
	}
}

/** A name that already ends in "key" ("Claude API key"): the words after it never say "key" again. */
export function nameEndsInKey(name: string): boolean {
	return /\bkey$/i.test(name.trim());
}

/** "{provider} {state}", or "No Claude API key is saved" where the name already ends in "key". */
export function providerCredentialClause(provider: string, gone: CredentialGone): string {
	if (gone === "key-missing" && nameEndsInKey(provider)) return `No ${provider} is saved`;
	return `${provider} ${credentialGoneWords(gone).state}`;
}

/** A model whose provider's credential is gone, as a sentence's subject and state; `named` is the model with its provider, as the caller shows it. */
export function modelCredentialWords(model: string, provider: string | null | undefined, named: string, gone: CredentialGone): { subject: string; state: string } {
	if (gone === "key-missing" && provider && nameEndsInKey(provider)) return { subject: model, state: `has no ${provider} saved` };
	return { subject: named, state: credentialGoneWords(gone).state };
}

/** Why a model cannot answer for its credential, after the model's name. */
export function credentialGoneWhy(gone: CredentialGone): string {
	if (gone === "key-no-workspace") return "cannot answer because its key isn't tied to a workspace";
	return `cannot answer because its provider ${credentialGoneWords(gone).state}`;
}

/**
 * The sentence (draft wording) for a row whose chosen model cannot run, also
 * for a call the provider refused because it no longer serves the model.
 * `model` is the model as the picker names it, with its provider
 * ("GPT-6.1 Sol on OpenAI", see modelOnProvider). `signsIn` is false for a
 * key provider or a gateway, whose signed-out row has no key saved.
 */
export function roomModelUnavailableLine(model: string, reason: "signed-out" | "not-offered", task: "conversation" | "memory", of: RoomModelRefusalOf = "room", signsIn = true, bare?: { model: string; provider: string }): string {
	const row = task === "memory" ? "memory model" : "model";
	const subject = of === "room" ? `This room's ${row}` : of === "defaults" ? `The default ${row}` : `The ${row} of ${of.room}`;
	const settings = typeof of === "object" ? "its Room settings, Model" : "Room settings, Model";
	const gone = credentialGoneWords(signsIn ? "signed-out" : "key-missing");
	const words = reason === "signed-out" && !signsIn && bare ? modelCredentialWords(bare.model, bare.provider, model, "key-missing") : { subject: model, state: reason === "signed-out" ? gone.state : "is no longer offered" };
	const wayOut = of !== "defaults"
		? reason === "signed-out" ? `${gone.again} in Settings, AI setup, or choose another model in ${settings}.` : `Choose another ${task === "memory" ? "Memory model" : "model"} in ${settings}.`
		: reason === "signed-out" ? `${gone.again}, or choose another default, in Settings, AI setup.` : "Choose another default in Settings, AI setup.";
	return `${subject}, ${words.subject}, ${words.state}. ${wayOut}`;
}
