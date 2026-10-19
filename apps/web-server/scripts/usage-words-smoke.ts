// The prompt cache's words on a usage line (apps/web-ui/src/usage-words.ts),
// shared by the Wallet's turn rows and the in-room usage line: all input is
// counted, and the cache is named as reused or stored for reuse.
import { allInput, cacheWords } from "../../web-ui/src/usage-words.js";

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

const full = (tokens: number) => tokens.toLocaleString("en-US");
assert(allInput({ input: 4, cacheRead: 0, cacheWrite: 9409 }) === 9413, "input counts what went into the cache");
assert(cacheWords({ cacheRead: 0, cacheWrite: 9409 }, full) === "9,409 stored for reuse", "a cache write is stored for reuse");
assert(cacheWords({ cacheRead: 9455, cacheWrite: 0 }, full) === "9,455 reused", "a cache read is reused");
assert(cacheWords({ cacheRead: 9000, cacheWrite: 455 }, full) === "9,000 reused, 455 stored", "both name each");
assert(cacheWords({ cacheRead: 0 }, full) === null, "no cache, no words");
console.log("usage-words smoke: ok");
