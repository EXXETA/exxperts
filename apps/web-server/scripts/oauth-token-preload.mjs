// Test-only, loaded with `node --import` by key-refused-setup-smoke: sends the
// Claude sign-in's token requests (a refresh, a new sign-in's code exchange) to
// the smoke's local endpoint, so a made-up credential never leaves the machine.
// The runtime names Anthropic's token address in its own code, with no setting.
const target = process.env.SMOKE_OAUTH_TOKEN_URL;
const CLAUDE_TOKEN_URL = "https://platform.claude.com/v1/oauth/token";

if (target) {
	const realFetch = globalThis.fetch;
	globalThis.fetch = (input, init) => {
		const url = typeof input === "string" ? input : input instanceof URL ? input.href : input?.url;
		return realFetch(url === CLAUDE_TOKEN_URL ? target : input, init);
	};
}
