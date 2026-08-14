// Canonical model naming at DISPLAY time.
//
// Model strings reach the UI from rows persisted at very different times:
// old usage rows carry only a raw id ("gpt-5.5"), newer rows a provider label
// ("ChatGPT Plus/Pro — GPT-5.5"), thread locks whatever label existed at
// lock-write time, and gateway models raw vendor ids ("moonshotai.kimi-k2.5").
// This module turns any of those into one canonical display name so the same
// model reads the same everywhere, without touching persisted formats.
//
// Dedupe spec (for the Wallet filter and any grouping surface): group entries
// by `canonicalModelKey(...)` — the same model recorded under different raw
// ids or label eras collapses into one group ("claude-opus-4-8" and
// "claude-opus-4.8" share a key). A group renders as `canonicalModelName(...)`
// once; selecting it must match ALL underlying raw model strings in the group.
//
// Naming rules, in order:
// 1. Known-family ids (GPT, Claude, Gemini, Kimi, DeepSeek, …) are prettified
//    from the raw id — the most stable source across label eras.
// 2. Otherwise a persisted "Provider — Name" label contributes its name part
//    (decoration like "(latest)" stripped).
// 3. Otherwise the raw id is tidied generically: vendor prefixes dropped,
//    separators normalised, words Title-Cased, version tokens kept
//    ("kimi-k2.5" → "Kimi K2.5"). Nothing is invented — ambiguous ids stay
//    close to raw, just consistently formatted.

export interface ModelNameInput {
	/** Raw model id as persisted (may be empty when only a label survived). */
	model?: string | null;
	/** Persisted display label, usually "Provider — Name". */
	modelLabel?: string | null;
	/** Provider id ("github-copilot") when the caller knows it. */
	provider?: string | null;
}

export interface CanonicalModelName {
	/** Canonical display name, e.g. "Claude Opus 4.8". */
	name: string;
	/** Provider display name when known, e.g. "GitHub Copilot". */
	provider?: string;
}

/**
 * Provider ids the app mints for saved gateways all start with this. Shared so
 * nothing has to spell it out again: a gateway's id is a slug of the name its
 * owner chose, which is never a name to show anybody.
 */
export const GATEWAY_PROVIDER_ID_PREFIX = "gateway-";

// Mirrors the server's WEB_CHAT_PROVIDER_LABELS so client-side fallbacks agree
// with labels minted by the server for new rows.
const PROVIDER_DISPLAY_NAMES: Record<string, string> = {
	"openai-codex": "ChatGPT Plus/Pro",
	openai: "OpenAI",
	anthropic: "Anthropic / Claude",
	"github-copilot": "GitHub Copilot",
	"openai-compatible": "OpenAI-compatible gateway",
	google: "Google / Gemini",
	openrouter: "OpenRouter",
};

// Vendor prefixes seen on gateway ids ("moonshotai.kimi-k2.5"). Dropped when a
// family token remains; otherwise the vendor becomes the family name itself
// ("deepseek.v3.2" → "DeepSeek V3.2").
const VENDOR_TOKENS: Record<string, string> = {
	moonshotai: "Moonshot AI",
	moonshot: "Moonshot AI",
	deepseek: "DeepSeek",
	anthropic: "Anthropic",
	openai: "OpenAI",
	google: "Google",
	meta: "Meta",
	mistralai: "Mistral",
	qwen: "Qwen",
	"z-ai": "Z.ai",
	zhipuai: "Zhipu AI",
};

// Casing for word tokens the generic tidier can't derive: acronyms and brands.
const WORD_CASING: Record<string, string> = {
	gpt: "GPT",
	glm: "GLM",
	deepseek: "DeepSeek",
	openai: "OpenAI",
	kimi: "Kimi",
	qwen: "Qwen",
	llama: "Llama",
	claude: "Claude",
	gemini: "Gemini",
	mistral: "Mistral",
	codestral: "Codestral",
	grok: "Grok",
	ai: "AI",
	xl: "XL",
};

function stripDecoration(name: string): string {
	// "(latest)"-style qualifiers are aliases, not identity — the same model
	// appears with and without them depending on the catalog that labelled it.
	return name.replace(/\s*\((?:latest|preview|beta|new)\)\s*$/i, "").trim();
}

/** Splits a persisted "Provider — Name" label. Returns null when it is not one. */
export function splitProviderLabel(label: string): { provider: string; name: string } | null {
	const idx = label.indexOf("—");
	if (idx < 0) return null;
	const provider = label.slice(0, idx).trim();
	const name = label.slice(idx + 1).trim();
	return provider && name ? { provider, name } : null;
}

/** Provider display name for a provider id; falls back to the id itself. */
export function providerDisplayName(providerId: string): string {
	return PROVIDER_DISPLAY_NAMES[providerId] ?? providerId;
}

function isVersionToken(token: string): boolean {
	// "4", "4.8", "5.3", "4o", "k2.5", "v3.2", "r1", "o3"…
	return /^\d/.test(token) || /^[vkro]\d/i.test(token);
}

function caseVersionToken(token: string): string {
	// Keep digits/dots verbatim; single leading letter markers uppercase for
	// K2.5 / V3.2, but "4o"-style suffix letters stay lowercase.
	if (/^[vk]\d/i.test(token)) return token[0].toUpperCase() + token.slice(1);
	return token;
}

function caseWordToken(token: string): string {
	const known = WORD_CASING[token.toLowerCase()];
	if (known) return known;
	return token.charAt(0).toUpperCase() + token.slice(1).toLowerCase();
}

function tokenizeModelId(id: string): string[] {
	const tokens: string[] = [];
	for (const rough of id.split(/[-_/\s]+/)) {
		if (!rough) continue;
		// Split "vendor.family" / "vendor.v3.2" dots that follow a word, but
		// keep version dots ("3.5", "k2.5") intact.
		let rest = rough;
		for (;;) {
			const m = /^([a-zA-Z]{2,})\.(.+)$/.exec(rest);
			if (!m) break;
			tokens.push(m[1]);
			rest = m[2];
		}
		if (rest) tokens.push(rest);
	}
	return tokens;
}

/** Merge runs of 2+ consecutive integer tokens into a dotted version ("4","8" → "4.8"). */
function mergeVersionRuns(tokens: string[]): string[] {
	const out: string[] = [];
	let i = 0;
	while (i < tokens.length) {
		if (/^\d+$/.test(tokens[i])) {
			let j = i;
			while (j + 1 < tokens.length && /^\d+$/.test(tokens[j + 1])) j++;
			if (j > i) {
				out.push(tokens.slice(i, j + 1).join("."));
				i = j + 1;
				continue;
			}
		}
		out.push(tokens[i]);
		i++;
	}
	return out;
}

/** Tidy a raw model id into a readable name without inventing anything. */
function prettifyModelId(rawId: string): string {
	let tokens = mergeVersionRuns(tokenizeModelId(rawId));
	if (tokens.length === 0) return rawId;

	// Vendor prefix: drop it when a word token remains to carry the family;
	// otherwise the vendor is the family ("deepseek.v3.2" → DeepSeek V3.2).
	const vendor = VENDOR_TOKENS[tokens[0]?.toLowerCase() ?? ""];
	if (vendor && tokens.length > 1) {
		const rest = tokens.slice(1);
		if (rest.some((t) => !isVersionToken(t))) tokens = rest;
		else tokens = [vendor.split(/\s+/)[0], ...rest];
	}

	const cased = tokens.map((t) => (isVersionToken(t) ? caseVersionToken(t) : caseWordToken(t)));

	// OpenAI convention: the version hyphenates onto GPT ("GPT-5.5", "GPT-4o",
	// "GPT-4 Turbo"); everything else joins with spaces.
	if (cased[0] === "GPT" && cased.length > 1 && isVersionToken(cased[1])) {
		return [`GPT-${cased[1]}`, ...cased.slice(2)].join(" ");
	}
	return cased.join(" ");
}

// Families whose raw ids fully determine the canonical name. For these the id
// beats any persisted label — labels differ per catalog era, ids don't.
const KNOWN_FAMILY_ID = /^(gpt|claude|gemini|o[13457]\b|kimi|deepseek|moonshotai\.|glm|qwen|llama|mistral|codestral|grok)/i;

/**
 * Canonical display name for a model however it was persisted.
 * Same model (any label era, any raw-id spelling) → same name.
 */
export function canonicalModelName(input: ModelNameInput): CanonicalModelName {
	const rawId = (input.model ?? "").trim();
	const label = (input.modelLabel ?? "").trim();
	const split = label ? splitProviderLabel(label) : null;
	const provider = split?.provider ?? (input.provider ? providerDisplayName(input.provider.trim()) : undefined);

	if (rawId && KNOWN_FAMILY_ID.test(rawId)) {
		return { name: prettifyModelId(rawId), ...(provider ? { provider } : {}) };
	}
	if (split) {
		const namePart = stripDecoration(split.name);
		// Gateway labels often just repeat the raw id after the dash — tidy it.
		const name = namePart && namePart !== rawId ? (KNOWN_FAMILY_ID.test(namePart) ? prettifyModelId(namePart) : namePart) : prettifyModelId(rawId || namePart);
		return { name, provider: split.provider };
	}
	// A dashless label is already a curated name — better than tidying an
	// unknown id generically.
	if (label && label !== rawId) return { name: stripDecoration(label), ...(provider ? { provider } : {}) };
	if (rawId) return { name: prettifyModelId(rawId), ...(provider ? { provider } : {}) };
	return { name: "", ...(provider ? { provider } : {}) };
}

/** Just the canonical name (most call sites only render the name). */
export function modelDisplayName(input: ModelNameInput): string {
	return canonicalModelName(input).name;
}

/**
 * "Name (Provider)". The face of the app shows the name alone; the tooltip is
 * where the provider belongs, so two look-alike models from different
 * providers are still tellable apart. Falls back to the bare name when the
 * provider is unknown.
 */
export function formatModelWithProvider(name: string, provider: string | null | undefined): string {
	if (!name) return provider ?? "";
	return provider ? `${name} (${provider})` : name;
}

/** The canonical name with its provider, ready for a title attribute. */
export function modelTooltipName(input: ModelNameInput): string {
	const { name, provider } = canonicalModelName(input);
	return formatModelWithProvider(name, provider);
}

/**
 * Grouping key: two persisted rows share a key iff they display as the same
 * model. Lowercased so casing quirks never split a group.
 */
export function canonicalModelKey(input: ModelNameInput): string {
	return canonicalModelName(input).name.toLowerCase();
}
