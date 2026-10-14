// The prompt cache setting of Memory model calls (memory-call-cache.ts): one
// value per call kind, no cache for Remember's three kinds and the fold, the
// provider default for every other kind, and the environment setting the real run
// uses, for every kind or kind by kind. Offline: no model, no server.
export {};

const { MEMORY_CALL_KINDS, memoryCallCacheRetention } = await import("../src/memory-call-cache.js");

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

delete process.env.EXXPERTS_MEMORY_CACHE_RETENTION;
const NO_CACHE_KINDS = ["remember-single", "remember-part", "remember-final", "fold"];
for (const kind of MEMORY_CALL_KINDS) {
	const expected = NO_CACHE_KINDS.includes(kind) ? "none" : undefined;
	assert(memoryCallCacheRetention(kind) === expected, `${kind} answers ${expected ?? "the provider default"} with nothing set, got ${memoryCallCacheRetention(kind)}`);
}
assert(MEMORY_CALL_KINDS.length === 7, "seven call kinds: remember single pass, part and final, fold, review tidy, first read, probe");
console.log("  ok  Remember's kinds and the fold ask for no cache, every other kind keeps the provider default");

process.env.EXXPERTS_MEMORY_CACHE_RETENTION = "long";
for (const kind of MEMORY_CALL_KINDS) assert(memoryCallCacheRetention(kind) === "long", `one value sets every kind, got ${memoryCallCacheRetention(kind)} for ${kind}`);
console.log("  ok  one value sets every kind");

process.env.EXXPERTS_MEMORY_CACHE_RETENTION = "remember-part=long, fold=none, probe=forever";
assert(memoryCallCacheRetention("remember-part") === "long" && memoryCallCacheRetention("fold") === "none", "kinds named by name get their own value");
assert(memoryCallCacheRetention("probe") === undefined && memoryCallCacheRetention("remember-final") === "none", "an unknown value, or a kind not named, keeps its default");
console.log("  ok  kinds by name, an unknown value ignored");

delete process.env.EXXPERTS_MEMORY_CACHE_RETENTION;
console.log("memory call cache smoke passed");
