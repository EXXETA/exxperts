/**
 * A provider refusing a model for this account: the person's plan does not
 * include it, an administrator has not turned it on, or the provider retired
 * it for this kind of sign-in. The ONE matcher and the ONE sentence, used by
 * the chat turn, Remember, Memorize, Review, a scheduled run, a specialist
 * task, a consult and HiveMind.
 *
 * Deliberately pure (no node imports) so the web UI imports this source
 * directly, like revise-conflict-notice.ts.
 *
 * Only the wording a provider is known to send matches. ChatGPT's backend
 * says, with a 400: "The 'gpt-6.1-sol' model is not supported when using
 * Codex with a ChatGPT account." It says the same for a model retired from
 * ChatGPT sign-ins, so the sentence says "isn't available", true for both.
 * A 400 about a parameter ("Unsupported parameter: 'temperature' is not
 * supported with this model") and a full model ("at capacity") never match.
 * The runtime keeps a copy of these words (codexModelNotOnAccount in
 * openai-codex-responses.ts) to ask only once; the not-on-account smoke
 * proves the two agree.
 */

const NOT_ON_ACCOUNT_PATTERNS: readonly RegExp[] = [
	// ChatGPT (openai-codex), whatever quotes surround the model's id before it.
	/\bmodel is not supported when using Codex with a ChatGPT account\b/i,
];

export function modelNotOnAccount(message: string): boolean {
	return NOT_ON_ACCOUNT_PATTERNS.some((pattern) => pattern.test(message));
}

/** The account a provider's sign-in is, as the person knows it. */
const ACCOUNT_NAMES: Record<string, string> = {
	"openai-codex": "ChatGPT",
	"anthropic-api-key": "Anthropic",
};

/** The service a provider's credential belongs to, as the person knows it ("Anthropic" for the Claude API key); undefined where the provider's own name says it. */
export function providerAccountName(provider: string): string | undefined {
	return ACCOUNT_NAMES[provider];
}

/** "isn't available on your ChatGPT account" (draft wording), after the model's name. */
export function notOnAccountWhy(provider: string | undefined): string {
	const account = provider ? ACCOUNT_NAMES[provider] : undefined;
	return `isn't available on your ${account ? `${account} ` : ""}account`;
}

/**
 * Where the way out is: this room's Room settings ("room"), this room's
 * Memory model ("room-memory", a specialist task), another room's Memory
 * model by its name (a consult, HiveMind asking one room), or AI setup's
 * defaults (HiveMind asking several rooms).
 */
export type NotOnAccountWayOut = "room" | "room-memory" | { room: string } | "defaults";

/** The line a chat turn, a scheduled run, a specialist task, a consult and HiveMind show (draft wording): what happened and the way out. */
export function modelNotOnAccountSentence(modelName: string, provider: string | undefined, where: NotOnAccountWayOut = "room"): string {
	const wayOut = where === "room"
		? "Choose another model in Room settings, Model."
		: where === "room-memory"
			? "Choose another Memory model in Room settings, Model."
			: where === "defaults"
				? "Choose another default in Settings, AI setup."
				: `Choose another Memory model in ${where.room}'s Room settings, Model.`;
	return `${modelName} ${notOnAccountWhy(provider)}. ${wayOut}`;
}
