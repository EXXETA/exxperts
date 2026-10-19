// The words a usage line uses for the provider's prompt cache. Input read back
// from it is "reused", input written to it is "stored for reuse"; both are
// input, so the line's input count includes them.

/** All the input a turn sent: fresh, read from the cache and written to it. */
export function allInput(usage: { input: number; cacheRead: number; cacheWrite?: number }): number {
	return usage.input + usage.cacheRead + (usage.cacheWrite || 0);
}

/** "9.4k reused", "9.4k stored for reuse" or "9.0k reused, 455 stored"; null without a cache. */
export function cacheWords(usage: { cacheRead: number; cacheWrite?: number }, count: (tokens: number) => string): string | null {
	const read = usage.cacheRead;
	const write = usage.cacheWrite || 0;
	if (read > 0 && write > 0) return `${count(read)} reused, ${count(write)} stored`;
	if (read > 0) return `${count(read)} reused`;
	if (write > 0) return `${count(write)} stored for reuse`;
	return null;
}
