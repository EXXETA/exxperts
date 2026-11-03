// The condition wait the smokes share: poll a predicate until it holds, or
// throw "timed out waiting until <label>" once the deadline has passed. Each
// smoke fixes its poll once, as `const waitUntil = waitEvery(150)`, and its
// default deadline with a second argument when 25 s does not fit it
// (`waitEvery(100, 15_000)`); a call can still give its own deadline.
export type WaitCondition = () => Promise<boolean> | boolean;
export type WaitUntil = (predicate: WaitCondition, label: string, timeoutMs?: number) => Promise<void>;

export function waitEvery(pollMs: number, defaultTimeoutMs = 25_000): WaitUntil {
	return async (predicate, label, timeoutMs = defaultTimeoutMs) => {
		const deadline = Date.now() + timeoutMs;
		while (Date.now() < deadline) {
			if (await predicate()) return;
			await new Promise((resolve) => setTimeout(resolve, pollMs));
		}
		throw new Error(`timed out waiting until ${label}`);
	};
}
