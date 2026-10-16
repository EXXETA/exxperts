/** Display data only. Reviews and permission checks always use fresh server reads. */
export function createDisplayCache<T>() {
	let value: T | undefined;
	let pending: Promise<T> | undefined;
	let generation = 0;
	let stale = false;
	const clear = () => { generation++; value = undefined; pending = undefined; stale = false; };
	const invalidate = () => { generation++; pending = undefined; stale = true; };
	clearers.add(clear);
	invalidators.add(invalidate);
	return {
		peek: () => value,
		invalidate,
		clear,
		load(load: () => Promise<T>, refresh = false): Promise<T> {
			if (pending) return pending;
			if (!refresh && !stale && value !== undefined) return Promise.resolve(value);
			const started = generation;
			const request = load().then((result) => { if (started === generation) { value = result; stale = false; } return result; }).finally(() => { if (pending === request) pending = undefined; });
			pending = request;
			return request;
		},
	};
}

const clearers = new Set<() => void>();
const invalidators = new Set<() => void>();
export function clearDisplayCaches(): void { for (const clear of clearers) clear(); if (typeof window !== "undefined") window.dispatchEvent(new window.Event("display-caches-cleared")); }
export function invalidateDisplayCaches(): void { for (const invalidate of invalidators) invalidate(); }
