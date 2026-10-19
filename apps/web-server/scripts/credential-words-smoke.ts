// The words for a connection whose credential is gone: a name that already
// ends in "key" is never followed by "key" again.
import { modelCredentialWords, nameEndsInKey, providerCredentialClause, roomModelUnavailableLine } from "../src/model-not-offered.js";

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

function same(actual: unknown, expected: unknown, label: string): void {
	assert(JSON.stringify(actual) === JSON.stringify(expected), `${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

same(nameEndsInKey("Claude API key"), true, "a name ending in key");
same(nameEndsInKey("Monkey"), false, "a word that only ends in the letters");
same(providerCredentialClause("Claude API key", "key-missing"), "No Claude API key is saved", "a missing key after a name ending in key");
same(providerCredentialClause("Fake GPT", "key-missing"), "Fake GPT has no key saved", "a missing key after another name");
same(providerCredentialClause("Claude API key", "key-refused"), "Claude API key did not accept the saved key", "only the missing state changes");
same(modelCredentialWords("Claude Opus 5.5", "Claude API key", "Claude Opus 5.5 on Claude API key", "key-missing"), { subject: "Claude Opus 5.5", state: "has no Claude API key saved" }, "a model on a provider ending in key");
same(modelCredentialWords("GPT Fake", "Fake GPT", "GPT Fake on Fake GPT", "key-missing"), { subject: "GPT Fake on Fake GPT", state: "has no key saved" }, "a model on another provider");
same(roomModelUnavailableLine("Claude Opus 5.5 on Claude API key", "signed-out", "conversation", "room", false, { model: "Claude Opus 5.5", provider: "Claude API key" }), "This room's model, Claude Opus 5.5, has no Claude API key saved. Add the key again in Settings, AI setup, or choose another model in Room settings, Model.", "the room's line");
same(roomModelUnavailableLine("GPT Fake on Fake GPT", "signed-out", "conversation", "room", false, { model: "GPT Fake", provider: "Fake GPT" }), "This room's model, GPT Fake on Fake GPT, has no key saved. Add the key again in Settings, AI setup, or choose another model in Room settings, Model.", "the room's line for another provider");

console.log("credential-words smoke: ok");
