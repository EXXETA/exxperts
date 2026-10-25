// Details shows the provider's own sentence with anything shaped like a key or
// a token masked. A provider's key often has a hyphen in its prefix (xai-,
// pplx-) or in its body (a Google AIza… key), which the old rule kept whole to
// spare model ids; the model ids a provider names must still show.
export {}; // a module, so the top-level awaits below are allowed

const { providerSentence } = await import("../../web-ui/src/turn-failure-line.js");

const failures: string[] = [];

// Built from one repeated part, so the secret scan does not read them as real keys.
const FAKE = "Ab12";
const KEYS: Array<[string, string]> = [
	["an OpenAI key", `sk-proj-${FAKE.repeat(8)}`],
	["an xAI key", `xai-${FAKE.repeat(12)}`],
	["a Perplexity key", `pplx-${FAKE.repeat(10)}`],
	["a Google key with a hyphen", `AIzaSy-${FAKE.repeat(8)}`],
	["a Google key", `AIzaSy${FAKE.repeat(8)}`],
	["a long hyphenated token", [FAKE.repeat(2), FAKE, FAKE, FAKE.repeat(3), FAKE.repeat(2)].join("-")],
	["a bearer token", "Bearer abc.def-123"],
];
for (const [what, key] of KEYS) {
	const shown = providerSentence(`Incorrect API key provided: ${key}. Check your key.`) ?? "";
	const bare = key.replace(/^Bearer /, "");
	if (shown.includes(bare) || shown.includes(bare.slice(6, 18))) failures.push(`${what} shows in Details: ${JSON.stringify(shown)}`);
}

const MODEL_IDS = ["claude-opus-5-5", "gpt-6.1-sol", "gemini-3.0-pro-preview-06-05", "llama-3.3-70b-instruct", "mistral-large-2411", "us.anthropic.claude-sonnet-5-5-20260101-v1:0", "claude-haiku-5-5-20261001-scripted-preview", "deepseek-r1-distill-llama-70b-instruct-preview-0528"];
for (const id of MODEL_IDS) {
	const shown = providerSentence(`The model \`${id}\` does not exist or you do not have access to it.`) ?? "";
	if (!shown.includes(id)) failures.push(`the model id ${id} is masked: ${JSON.stringify(shown)}`);
}

if (failures.length > 0) throw new Error(`failure details mask:\n  ${failures.join("\n  ")}`);
console.log("failure-details-mask smoke: ok");
