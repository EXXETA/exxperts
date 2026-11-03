// Smoke for the display-time model naming module (apps/web-ui/src/model-names.ts).
//
// Table-driven: every model string observed in real usage.jsonl rows and room
// thread locks must map to a
// sensible canonical name, and raw-id spellings of the same model must share
// a canonical key so grouped filters collapse them.
//
// Run: npm run smokes -- model-names   (or tsx this file)

import { canonicalModelKey, canonicalModelName, distinctModelNames, modelDisplayName, modelIdDate, modelOnProvider, providerDisplayName, realModelName } from "../../web-ui/src/model-names.js";

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
	{ model: "claude-opus-5", modelLabel: "Anthropic / Claude — Opus 5", name: "Claude Opus 5", providerName: "Claude" },
	{ model: "claude-opus-4-8", modelLabel: "Anthropic / Claude — Opus 4.8", name: "Claude Opus 4.8", providerName: "Claude" },
	{ model: "claude-sonnet-5", modelLabel: "Anthropic / Claude — Sonnet 5", name: "Claude Sonnet 5", providerName: "Claude" },
	{ model: "claude-sonnet-4-6", modelLabel: "Anthropic / Claude — Sonnet 4.6", name: "Claude Sonnet 4.6", providerName: "Claude" },
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
	// The 0.13.1 catalogue rows: the prettifier already produces them; pinned so they cannot drift.
	{ model: "claude-fable-5-1", name: "Claude Fable 5.1" },
	{ model: "gpt-6-astra", name: "GPT-6 Astra" },
	{ model: "claude-opus-5-5", name: "Claude Opus 5.5" },
	{ model: "claude-sonnet-5-5", name: "Claude Sonnet 5.5" },
	{ model: "claude-haiku-5-5", name: "Claude Haiku 5.5" },
	{ model: "claude-haiku-5-5", provider: "anthropic", name: "Claude Haiku 5.5", providerName: "Claude" },
	{ model: "gpt-6-sol", name: "GPT-6 Sol" },
	{ model: "gpt-6.1-sol", name: "GPT-6.1 Sol" },
	{ model: "gpt-6.1-terra", name: "GPT-6.1 Terra" },
	{ model: "gpt-6-luna", name: "GPT-6 Luna" },
	{ model: "grok-4.7", name: "Grok 4.7" },
	{ model: "all-team-models", name: "All Team Models" },
	// Provider id supplies the provider display name when there is no label.
	{ model: "gpt-5.5", provider: "openai-codex", name: "GPT-5.5", providerName: "ChatGPT Plus/Pro" },
	{ model: "claude-opus-4-8", provider: "anthropic", name: "Claude Opus 4.8", providerName: "Claude" },
	// Unknown model with a clean curated label: the label's name part wins.
	{ model: "sonar-pro-x1", modelLabel: "Perplexity — Sonar Pro X1", name: "Sonar Pro X1", providerName: "Perplexity" },
	// Label without a provider dash: used verbatim.
	{ model: "", modelLabel: "Locked model", name: "Locked model" },
	// Bare curated catalog name beats generic tidying of an unknown id.
	{ model: "sonar-pro-x1", modelLabel: "Sonar Pro X1", name: "Sonar Pro X1" },
	// A gateway model saved with its own label reads that label exactly; the
	// same id with no label is only tidied, which is why Home's card looks
	// the saved label up for a lock that carries the id alone.
	{ model: "quill-70b-instruct", modelLabel: "Northwind AI gateway \u2014 Quill 70B", name: "Quill 70B", providerName: "Northwind AI gateway" },
	{ model: "quill-70b-instruct", name: "Quill 70b Instruct" },
	// On a gateway the saved name wins over the family rule too; with no saved name the id is tidied as before.
	{ model: "llama-3-70b", modelLabel: "Northwind AI gateway \u2014 Finance Assistant", provider: "gateway-northwind-ai-gateway", name: "Finance Assistant", providerName: "Northwind AI gateway" },
	{ model: "llama-3-70b", modelLabel: "Northwind AI gateway \u2014 llama-3-70b", provider: "gateway-northwind-ai-gateway", name: "Llama 3 70b", providerName: "Northwind AI gateway" },
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

// A sentence names the provider only when the model's name does not already say it.
check("modelOnProvider drops a provider the name already says", modelOnProvider("Claude Opus 4.8", "Claude"), "Claude Opus 4.8");
check("modelOnProvider keeps another provider", modelOnProvider("Claude Opus 4.8", "GitHub Copilot"), "Claude Opus 4.8 on GitHub Copilot");
check("modelOnProvider keeps ChatGPT", modelOnProvider("GPT-6.1 Sol", "ChatGPT Plus/Pro"), "GPT-6.1 Sol on ChatGPT Plus/Pro");
check("modelOnProvider needs a whole word", modelOnProvider("Claudette 2", "Claude"), "Claudette 2 on Claude");

// A trailing release date is not part of the name; a list shows it only beside a look-alike.
check("a dated Claude id reads as its name", modelDisplayName({ model: "claude-haiku-4-5-20251001" }), "Claude Haiku 4.5");
check("a dashed date is dropped too", modelDisplayName({ model: "gpt-4o-2024-08-06" }), "GPT-4o");
check("the date in plain form", modelIdDate("claude-sonnet-4-5-20250929"), "29 Sep 2025");
check("no date, no date", modelIdDate("claude-opus-5-5"), null);
check("a list dates only its look-alikes", distinctModelNames([{ model: "claude-sonnet-4-5" }, { model: "claude-sonnet-4-5-20250929" }, { model: "claude-haiku-4-5-20251001" }]), ["Claude Sonnet 4.5", "Claude Sonnet 4.5 (29 Sep 2025)", "Claude Haiku 4.5"]);

// The model behind a Bedrock id, for counting real models: region and version
// shapes are not part of the name, and the date reads as for any dated id.
check("a Bedrock id reads as its model, dated", realModelName("anthropic.claude-sonnet-4-5-20250929-v1:0"), { name: "Claude Sonnet 4.5", date: "29 Sep 2025" });
check("a Bedrock region id reads as the same model", realModelName("eu.anthropic.claude-3-7-sonnet-20250219-v1:0"), { name: "Claude 3.7 Sonnet", date: "19 Feb 2025" });
check("a Bedrock version suffix without a v is dropped too", realModelName("openai.gpt-oss-120b-1:0"), { name: "GPT Oss 120b", date: null });
check("a Bedrock Llama id reads its version apart from the family", realModelName("meta.llama3-3-70b-instruct-v1:0"), { name: "Llama 3.3 70b Instruct", date: null });
check("a bare Bedrock version on a Claude id is dropped", realModelName("anthropic.claude-opus-4-6-v1"), { name: "Claude Opus 4.6", date: null });
for (const region of ["au", "jp", "in", "us-gov", "apac", "global", "us"]) check(`a Bedrock ${region}. region id reads as the same model`, realModelName(`${region}.anthropic.claude-opus-4-6-v1`).name, "Claude Opus 4.6");
check("a version that names the model stays", realModelName("nvidia.nemotron-nano-12b-v2").name, modelDisplayName({ model: "nvidia.nemotron-nano-12b-v2" }));
check("an id with no Bedrock shape reads as everywhere", realModelName("llama3-70b-8192"), { name: modelDisplayName({ model: "llama3-70b-8192" }), date: null });
// A list to choose from still tells a gateway's region copies of one model apart.
check(
	"a picker's names for Bedrock region ids are untouched",
	distinctModelNames(["anthropic", "eu.anthropic", "us.anthropic"].map((prefix) => ({ model: `${prefix}.claude-sonnet-4-5-20250929-v1:0` }))),
	["Claude Sonnet 4.5.20250929 V1:0", "Eu Anthropic Claude Sonnet 4.5.20250929 V1:0", "Us Anthropic Claude Sonnet 4.5.20250929 V1:0"],
);

if (failures > 0) {
	console.error(`\nmodel-names smoke: ${failures} failure(s)`);
	process.exit(1);
}
console.log("model-names smoke: all checks passed");
