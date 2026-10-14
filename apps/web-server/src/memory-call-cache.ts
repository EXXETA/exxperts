// The prompt cache of Memory model calls: one setting, per call kind.
//
// A provider can keep a prompt's start cached for a while ("short", its
// default, or "long"), or not at all ("none"). What pays off depends on the
// call: a Remember's parts share nothing with each other, a fold repeats the
// room's memory page after page. It is chosen by measurement. Remember's three
// kinds never read their cache (measured: 18 to 20% cheaper on Claude without
// it, the same output, no change on ChatGPT), and neither does the fold
// (measured: 0 cache reads over 14 back-to-back folds, the same quality, 20%
// cheaper), so they ask for none. Every other kind names no value until it is
// measured, so the provider's own default holds (PI_CACHE_RETENTION included). The usage record of each call
// carries its kind beside cacheRead and cacheWrite for the run to compare.
//
// EXXPERTS_MEMORY_CACHE_RETENTION sets it for the real run, over any kind's
// own value: one value for every kind ("long"), or kinds by name
// ("remember-part=long,fold=none").

export const MEMORY_CALL_KINDS = ["remember-single", "remember-part", "remember-final", "fold", "review-tidy", "first-read", "probe"] as const;

export type MemoryCallKind = (typeof MEMORY_CALL_KINDS)[number];

export type MemoryCacheRetention = "none" | "short" | "long";

const RETENTIONS: readonly MemoryCacheRetention[] = ["none", "short", "long"];

function isRetention(value: string): value is MemoryCacheRetention {
	return (RETENTIONS as readonly string[]).includes(value);
}

/** Each kind's own value, measured; a kind not listed keeps the provider default. */
const MEASURED: Partial<Record<MemoryCallKind, MemoryCacheRetention>> = { "remember-single": "none", "remember-part": "none", "remember-final": "none", fold: "none" };

/** The cache retention a Memory model call of this kind asks for; undefined means the provider default. */
export function memoryCallCacheRetention(kind: MemoryCallKind): MemoryCacheRetention | undefined {
	const raw = String(process.env.EXXPERTS_MEMORY_CACHE_RETENTION ?? "").trim();
	if (isRetention(raw)) return raw;
	for (const pair of raw ? raw.split(",") : []) {
		const [name, value] = pair.split("=").map((part) => part.trim());
		if (name === kind && value && isRetention(value)) return value;
	}
	return MEASURED[kind];
}
