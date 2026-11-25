const DEFAULT_MAX_RETRY_DELAY_MS = 60_000;

/**
 * The request's answer, or the stop's error as soon as the signal fires. The
 * model libraries wait before they ask a busy server again without looking at
 * the signal, so on their own a stop takes effect only when that wait ends;
 * they do look before they send, so nothing goes out after a stop, and a
 * request started after one ends by itself, with their error. The words here
 * are theirs for a stop.
 *
 * A response that still arrives is let go: its body is cancelled, never read.
 */
export function untilStopped<T extends Response | { response: Response }>(
	request: Promise<T>,
	signal: AbortSignal | undefined,
): Promise<T> {
	if (!signal) return request;
	return new Promise<T>((resolve, reject) => {
		const stop = () => reject(new Error("Request was aborted."));
		signal.addEventListener("abort", stop, { once: true });
		request
			.then((value) => {
				if (!signal.aborted) return resolve(value);
				letGo("response" in value ? value.response : value);
				stop();
			})
			.catch(reject)
			.finally(() => signal.removeEventListener("abort", stop));
	});
}

function letGo(response: Response): void {
	// A body already read, or cut off by the stop, can't be cancelled, and need not be.
	response.body?.cancel().catch(() => {});
}

/**
 * A fetch for the model libraries that keeps `maxRetryDelayMs` (its meaning and
 * default are on StreamOptions): they wait as long as a server asks before they
 * ask again, so a refusal that asks for longer is marked as not to be asked
 * again, and fails at once with the server's own words.
 */
export function fetchWithBoundedRetryDelay(maxRetryDelayMs = DEFAULT_MAX_RETRY_DELAY_MS) {
	return async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
		const response = await fetch(input, init);
		if (response.ok || maxRetryDelayMs <= 0 || !(askedDelayMs(response.headers) > maxRetryDelayMs)) return response;
		const headers = new Headers(response.headers);
		headers.set("x-should-retry", "false");
		return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
	};
}

/** The wait a server asks for, read as the libraries read it (`retryRequest` in their clients); NaN when it asks for none. */
function askedDelayMs(headers: Headers): number {
	const milliseconds = Number.parseFloat(headers.get("retry-after-ms") ?? "");
	if (milliseconds) return milliseconds;
	const retryAfter = headers.get("retry-after") ?? "";
	const seconds = Number.parseFloat(retryAfter);
	return Number.isNaN(seconds) ? Date.parse(retryAfter) - Date.now() : seconds * 1000;
}
