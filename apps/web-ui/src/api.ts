// A 401 means the session cookie is missing or stale (for example cleared
// while the app was open): the server is fine but every further call fails
// the same way, so the actionable surface is the server's sign-in hint page
// at "/". Every fetch helper in the UI (this module's fetchJson plus the
// per-feature clones) routes its response through here so no screen is left
// rendering a raw auth error. The sessionStorage guard keeps a dev tab,
// where Vite serves this app shell unauthenticated, from reload-looping.
export function redirectToSignInOn401(res: Response): void {
	if (res.status !== 401) return;
	const lastRedirect = Number(sessionStorage.getItem("exxperts-auth-redirect") ?? 0);
	if (Number.isFinite(lastRedirect) && Date.now() - lastRedirect < 15000) return;
	sessionStorage.setItem("exxperts-auth-redirect", String(Date.now()));
	location.assign("/");
}

// For call sites that inspect the raw Response instead of using fetchJson:
// same fetch, plus the stale-session redirect above. Every direct API call
// in the UI goes through this or fetchJson; plain fetch stays reserved for
// non-API resources.
export async function apiFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
	const res = await fetch(input, init);
	redirectToSignInOn401(res);
	return res;
}

/** A request the server answered with an error: its sentence, plus the HTTP status and the machine code when it sent one. */
export class ApiRequestError extends Error {
	constructor(message: string, readonly status: number, readonly code?: string) {
		super(message);
	}
}

/** The server's machine code on a failed request, if it sent one. */
export function apiErrorCode(error: unknown): string | undefined {
	return error instanceof ApiRequestError ? error.code : undefined;
}

/**
 * A request that failed without the server saying why in its own words: the
 * network, or a server error with no code. A sentence the server wrote (a busy
 * room, no Memory model) is the server's answer and is shown as it is.
 */
export function isUnexplainedRequestFailure(error: unknown): boolean {
	if (error instanceof ApiRequestError) return error.status >= 500 && error.code === undefined;
	return error instanceof TypeError;
}

// One JSON fetch helper for the whole UI: parses {error} (our endpoints) and
// {message} (framework defaults) into a thrown Error the caller can render.
export async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
	const res = await fetch(url, init);
	redirectToSignInOn401(res);
	if (!res.ok) {
		let message = `Request failed (${res.status})`;
		let code: string | undefined;
		try {
			const body = await res.json();
			if (body?.error) message = String(body.error);
			else if (body?.message) message = String(body.message);
			if (typeof body?.code === "string") code = body.code;
		} catch {}
		throw new ApiRequestError(message, res.status, code);
	}
	return await res.json() as T;
}
