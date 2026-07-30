// Smoke for the display-time model naming module (apps/web-ui/src/model-names.ts).
//
// Table-driven: every model string observed in real usage.jsonl rows and room
// thread locks (Fernando's Wallet/home screenshots, 2026-07) must map to a
// sensible canonical name, and raw-id spellings of the same model must share
// a canonical key so grouped filters collapse them.
//
// Run: npm run smokes -- model-names   (or tsx this file)

import { canonicalModelKey, canonicalModelName, modelDisplayName, providerDisplayName } from "../../web-ui/src/model-names.js";

let failures = 0;
function check(desc: string, actual: unknown, expected: unknown) {
	const ok = JSON.stringify(actual) === JSON.stringify(expected);
	if (!ok) {
		failures++;
		console.error(`FAIL ${desc}\n  expected ${JSON.stringify(expected)}\n  actual   ${JSON.stringify(actual)}`);
	}
}

// --- canonical names for every observed persisted shape --------------------

const NAME_CASES: Array<{ model?: string; modelLabel?: string; provider?: string; name: string; providerName?: string }> = [
	// Old usage rows: raw id only, no label.
	{ model: "gpt-5.5", name: "GPT-5.5" },
	{ model: "gpt-5.3-codex", name: "GPT-5.3 Codex" },
	// Newer rows: raw id + provider label.
	{ model: "gpt-5.5", modelLabel: "ChatGPT Plus/Pro — GPT-5.5", name: "GPT-5.5", providerName: "ChatGPT Plus/Pro" },
	{ model: "gpt-5.4", modelLabel: "GitHub Copilot — GPT-5.4", name: "GPT-5.4", providerName: "GitHub Copilot" },
	{ model: "claude-opus-5", modelLabel: "Anthropic / Claude — Opus 5", name: "Claude Opus 5", providerName: "Anthropic / Claude" },
	{ model: "claude-opus-4-8", modelLabel: "Anthropic / Claude — Opus 4.8", name: "Claude Opus 4.8", providerName: "Anthropic / Claude" },
	{ model: "claude-sonnet-5", modelLabel: "Anthropic / Claude — Sonnet 5", name: "Claude Sonnet 5", providerName: "Anthropic / Claude" },
	{ model: "claude-sonnet-4-6", modelLabel: "Anthropic / Claude — Sonnet 4.6", name: "Claude Sonnet 4.6", providerName: "Anthropic / Claude" },
	{ model: "claude-sonnet-5", modelLabel: "GitHub Copilot — Claude Sonnet 5", name: "Claude Sonnet 5", providerName: "GitHub Copilot" },
	{ model: "claude-opus-4.6", modelLabel: "GitHub Copilot — Claude Opus 4.6", name: "Claude Opus 4.6", providerName: "GitHub Copilot" },
	{ model: "claude-opus-4.8", modelLabel: "GitHub Copilot — Claude Opus 4.8", name: "Claude Opus 4.8", providerName: "GitHub Copilot" },
	{ model: "claude-opus-4.5", modelLabel: "GitHub Copilot — Claude Opus 4.5 (latest)", name: "Claude Opus 4.5", providerName: "GitHub Copilot" },
	{ model: "claude-haiku-4.5", modelLabel: "GitHub Copilot — Claude Haiku 4.5 (latest)", name: "Claude Haiku 4.5", providerName: "GitHub Copilot" },
	{ model: "gemini-3.5-flash", modelLabel: "GitHub Copilot — Gemini 3.5 Flash", name: "Gemini 3.5 Flash", providerName: "GitHub Copilot" },
	{ model: "gpt-4o", modelLabel: "OpenAI — GPT-4o", name: "GPT-4o", providerName: "OpenAI" },
	{ model: "gpt-4-turbo", modelLabel: "OpenAI — GPT-4 Turbo", name: "GPT-4 Turbo", providerName: "OpenAI" },
	// Gateway rows: label just repeats the raw id after the dash.
	{ model: "moonshotai.kimi-k2.5", modelLabel: "OpenAI-compatible gateway — moonshotai.kimi-k2.5", name: "Kimi K2.5", providerName: "OpenAI-compatible gateway" },
	{ model: "claude-haiku-4.5", modelLabel: "OpenAI-compatible gateway — claude-haiku-4.5", name: "Claude Haiku 4.5", providerName: "OpenAI-compatible gateway" },
	{ model: "deepseek.v3.2", modelLabel: "OpenAI-compatible gateway — deepseek.v3.2", name: "DeepSeek V3.2", providerName: "OpenAI-compatible gateway" },
	{ model: "gpt-image-1-mini", modelLabel: "OpenAI-compatible gateway — gpt-image-1-mini", name: "GPT Image 1 Mini", providerName: "OpenAI-compatible gateway" },
	{ model: "all-team-models", modelLabel: "OpenAI-compatible gateway — all-team-models", name: "All Team Models", providerName: "OpenAI-compatible gateway" },
	// Raw ids alone (thread locks written before labels existed).
	{ model: "moonshotai.kimi-k2.5", name: "Kimi K2.5" },
	{ model: "claude-haiku-4.5", name: "Claude Haiku 4.5" },
	{ model: "claude-opus-5", name: "Claude Opus 5" },
	{ model: "claude-fable-5", name: "Claude Fable 5" },
	{ model: "all-team-models", name: "All Team Models" },
	// Provider id supplies the provider display name when there is no label.
	{ model: "gpt-5.5", provider: "openai-codex", name: "GPT-5.5", providerName: "ChatGPT Plus/Pro" },
	{ model: "claude-opus-4-8", provider: "anthropic", name: "Claude Opus 4.8", providerName: "Anthropic / Claude" },
	// Unknown model with a clean curated label: the label's name part wins.
	{ model: "sonar-pro-x1", modelLabel: "Perplexity — Sonar Pro X1", name: "Sonar Pro X1", providerName: "Perplexity" },
	// Label without a provider dash: used verbatim.
	{ model: "", modelLabel: "Locked model", name: "Locked model" },
	// Bare curated catalog name beats generic tidying of an unknown id.
	{ model: "sonar-pro-x1", modelLabel: "Sonar Pro X1", name: "Sonar Pro X1" },
];

for (const c of NAME_CASES) {
	const got = canonicalModelName({ model: c.model, modelLabel: c.modelLabel, provider: c.provider });
	check(`name(${c.model ?? ""} | ${c.modelLabel ?? ""})`, got.name, c.name);
	if (c.providerName) check(`provider(${c.model ?? ""} | ${c.modelLabel ?? ""})`, got.provider, c.providerName);
}

// --- grouping: raw-id spellings + label eras of one model share a key ------

const SAME_GROUP: Array<Array<{ model?: string; modelLabel?: string }>> = [
	[
		{ model: "claude-opus-4-8", modelLabel: "Anthropic / Claude — Opus 4.8" },
		{ model: "claude-opus-4.8", modelLabel: "GitHub Copilot — Claude Opus 4.8" },
		{ model: "claude-opus-4-8" },
	],
	[
		{ model: "gpt-5.5" },
		{ model: "gpt-5.5", modelLabel: "ChatGPT Plus/Pro — GPT-5.5" },
	],
	[
		{ model: "claude-haiku-4.5", modelLabel: "GitHub Copilot — Claude Haiku 4.5 (latest)" },
		{ model: "claude-haiku-4.5", modelLabel: "OpenAI-compatible gateway — claude-haiku-4.5" },
	],
];

for (const group of SAME_GROUP) {
	const keys = new Set(group.map((g) => canonicalModelKey(g)));
	check(`one key for ${JSON.stringify(group.map((g) => g.modelLabel ?? g.model))}`, keys.size, 1);
}

// Distinct models must NOT collapse.
const DISTINCT = [
	{ model: "gpt-5.5" },
	{ model: "gpt-5.4", modelLabel: "GitHub Copilot — GPT-5.4" },
	{ model: "gpt-5.3-codex" },
	{ model: "claude-opus-4-8" },
	{ model: "claude-opus-4.6" },
	{ model: "claude-sonnet-5" },
	{ model: "claude-haiku-4.5" },
];
check("distinct models keep distinct keys", new Set(DISTINCT.map((d) => canonicalModelKey(d))).size, DISTINCT.length);

// --- helpers ----------------------------------------------------------------

check("modelDisplayName shorthand", modelDisplayName({ model: "moonshotai.kimi-k2.5" }), "Kimi K2.5");
check("providerDisplayName known id", providerDisplayName("github-copilot"), "GitHub Copilot");
check("providerDisplayName unknown id passes through", providerDisplayName("acme-gw"), "acme-gw");

if (failures > 0) {
	console.error(`\nmodel-names smoke: ${failures} failure(s)`);
	process.exit(1);
}
console.log("model-names smoke: all checks passed");
