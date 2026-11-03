// The prompt cache every model call asks for: one policy, by kind of call,
// provider (which also says the sign-in) and model. Every call site asks it and
// passes what it says, so the providers' process-wide PI_CACHE_RETENTION never
// decides for a call the server makes. (The runtime's own summary call when it
// shortens a conversation still follows PI_CACHE_RETENTION.)
//
// A provider can keep a prompt's start cached for a while ("short", its
// default, or "long"), or not at all ("none"). What pays off depends on the
// call:
// - chat, specialists and scheduled runs re-send the same start turn after
//   turn: "short".
// - consult is one call whose prompt starts with the time to the millisecond,
//   so no consult can read another's cache: "none". A memory ask picks the
//   memory it sends by its question, so neither can it: "none".
// - Memory model calls were measured: none reads its cache back (Remember was
//   18 to 20% cheaper on Claude without it), so every kind asks for none. A
//   discussion turn re-sends the same notes each turn, but its prompt changes
//   before them (the trigger time and the token budget come first), so a cache
//   written on one turn is never read on the next: it asks for none too. The
//   usage record of each call carries its kind beside cacheRead and cacheWrite
//   for the run to compare.
//
// "long" is only ever asked where it can pay and is known to be accepted
// (`longPays`); anywhere else it falls back to "short".
//
// Two settings override the kinds' own values, for test runs:
// PI_CACHE_RETENTION=long for chat, specialists and scheduled runs, and
// EXXPERTS_MEMORY_CACHE_RETENTION for the Memory model calls: one value for
// every kind ("long"), or kinds by name ("remember-part=long,fold=none").

import { isDirectAnthropicProvider } from "@exxeta/exxperts-runtime";

export const MEMORY_CALL_KINDS = ["remember-single", "remember-part", "remember-final", "fold", "review-tidy", "first-read", "discussion", "probe"] as const;

export type MemoryCallKind = (typeof MEMORY_CALL_KINDS)[number];

export const CALL_KINDS = ["chat", "specialist", "scheduled", "consult", "memory-ask", ...MEMORY_CALL_KINDS] as const;

export type CallKind = (typeof CALL_KINDS)[number];

export type CacheRetention = "none" | "short" | "long";

const RETENTIONS: readonly CacheRetention[] = ["none", "short", "long"];

function isRetention(value: string): value is CacheRetention {
	return (RETENTIONS as readonly string[]).includes(value);
}

export function isMemoryCallKind(kind: CallKind): kind is MemoryCallKind {
	return (MEMORY_CALL_KINDS as readonly string[]).includes(kind);
}

/** Each kind's own value. */
const BY_KIND: Record<CallKind, CacheRetention> = {
	chat: "short",
	specialist: "short",
	scheduled: "short",
	consult: "none",
	"memory-ask": "none",
	"remember-single": "none",
	"remember-part": "none",
	"remember-final": "none",
	fold: "none",
	"review-tidy": "none",
	"first-read": "none",
	discussion: "none",
	probe: "none",
};

function overrideOf(kind: CallKind): CacheRetention | undefined {
	if (kind === "consult" || kind === "memory-ask") return undefined;
	if (!isMemoryCallKind(kind)) return process.env.PI_CACHE_RETENTION === "long" ? "long" : undefined;
	const raw = String(process.env.EXXPERTS_MEMORY_CACHE_RETENTION ?? "").trim();
	if (isRetention(raw)) return raw;
	for (const pair of raw ? raw.split(",") : []) {
		const [name, value] = pair.split("=").map((part) => part.trim());
		if (name === kind && value && isRetention(value)) return value;
	}
	return undefined;
}

/** What the policy reads of a model: its provider and its catalogue price for cache writes. */
export type CacheCallModel = { provider: string; cost: { cacheWrite: number } };

/**
 * Where "long" can pay and is known to be accepted: Anthropic's own API (the
 * key and the Claude sign-in) and Bedrock, whose one-hour writes are paid back
 * by one read after a pause of five minutes or more, and OpenAI's key on the
 * models whose writes are free (24 hours). The ones that charge for writes
 * (GPT-5.6 and later: 1.25x for their default 30 minutes, 2.5x for 12 hours)
 * already keep 30 minutes. Copilot and gateways have not been tested with the
 * one-hour lifetime, and the ChatGPT sign-in sends none.
 */
function longPays(model: CacheCallModel): boolean {
	if (isDirectAnthropicProvider(model.provider) || model.provider === "amazon-bedrock") return true;
	return model.provider === "openai" && model.cost.cacheWrite === 0;
}

/** The prompt cache a model call of this kind asks for on this model. */
export function callCacheRetention(kind: CallKind, model: CacheCallModel): CacheRetention {
	const retention = overrideOf(kind) ?? BY_KIND[kind];
	return retention === "long" && !longPays(model) ? "short" : retention;
}
