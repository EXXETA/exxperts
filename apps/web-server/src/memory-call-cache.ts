// The prompt cache of Memory model calls: one setting, per call kind.
//
// A provider can keep a prompt's start cached for a while ("short", its
// default, or "long"), or not at all ("none"). What pays off depends on the
// call, and was measured: no Memory model call reads its cache back (Remember
// was 18 to 20% cheaper on Claude without it), so every kind asks for none.
// A discussion turn re-sends the same notes each turn, but its prompt changes
// before them (the trigger time and the token budget come first), so a cache
// written on one turn is never read on the next: it asks for none too.
// The usage record of each call carries its kind beside cacheRead and
// cacheWrite for the run to compare.
//
// EXXPERTS_MEMORY_CACHE_RETENTION sets it for the real run, over any kind's
// own value: one value for every kind ("long"), or kinds by name
// ("remember-part=long,fold=none").

export const MEMORY_CALL_KINDS = ["remember-single", "remember-part", "remember-final", "fold", "review-tidy", "first-read", "discussion", "probe"] as const;

export type MemoryCallKind = (typeof MEMORY_CALL_KINDS)[number];

export type MemoryCacheRetention = "none" | "short" | "long";

const RETENTIONS: readonly MemoryCacheRetention[] = ["none", "short", "long"];

function isRetention(value: string): value is MemoryCacheRetention {
	return (RETENTIONS as readonly string[]).includes(value);
}

/** Each kind's own value, measured; a kind not listed keeps the provider default. */
const MEASURED: Partial<Record<MemoryCallKind, MemoryCacheRetention>> = { "remember-single": "none", "remember-part": "none", "remember-final": "none", fold: "none", "review-tidy": "none", "first-read": "none", discussion: "none", probe: "none" };

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
