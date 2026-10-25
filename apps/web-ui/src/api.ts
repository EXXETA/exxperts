import { knownRemoteClientContext } from "./remote-client-context";

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
// same fetch, plus the stale-session redirect above and one plain sentence
// when no answer came. Every direct API call in the UI goes through this or
// fetchJson; plain fetch stays reserved for non-API resources.
export async function apiFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
	let res: Response;
	try {
		res = await fetch(input, init);
	} catch (error) {
		// fetch rejects with a TypeError only when no answer came, in each browser's own words; a cancel is not one.
		if (error instanceof TypeError) throw new ServiceUnreachableError();
		throw error;
	}
	if (GATEWAY_NO_ANSWER_STATUSES.has(res.status) && !(await isOurErrorAnswer(res))) throw new ServiceUnreachableError();
	redirectToSignInOn401(res);
	return res;
}

// What stands in front of a shared server (its entrance, its gate) answers
// for it while it is down or restarting, in its own words: the same as no
// answer. Our own error answers are JSON with a sentence and keep it.
const GATEWAY_NO_ANSWER_STATUSES: ReadonlySet<number> = new Set([502, 503, 504]);

async function isOurErrorAnswer(res: Response): Promise<boolean> {
	if (!/\bapplication\/json\b/i.test(res.headers.get("content-type") ?? "")) return false;
	try {
		const body = await res.clone().json();
		return typeof body?.error === "string" || typeof body?.message === "string";
	} catch {
		return false;
	}
}

const SERVICE_UNREACHABLE_LEAD = "exxperts could not reach its own service just now.";
// The desktop's words, then a shared server's: there the person cannot restart it, and their admin is the way on.
const SERVICE_UNREACHABLE_SENTENCES = [
	`${SERVICE_UNREACHABLE_LEAD} Try again; if it repeats, restart exxperts.`,
	`${SERVICE_UNREACHABLE_LEAD} Try again in a moment; if it repeats, tell your admin.`,
] as const;

/** What the page says when the app's own server did not answer. */
export function serviceUnreachableSentence(): string {
	return SERVICE_UNREACHABLE_SENTENCES[knownRemoteClientContext()?.sharedServer ? 1 : 0];
}

/** Whether a line on screen carries that sentence, in either edition's words. */
export function isServiceUnreachableLine(line: string | null): boolean {
	return line?.includes(SERVICE_UNREACHABLE_LEAD) ?? false;
}

/**
 * A line without that sentence, once the service answers again or while the
 * lost-connection banner speaks for it: a line that is only the sentence goes,
 * and one that gives it as the reason keeps the rest ("Old Room was NOT
 * deleted: <sentence>" keeps "Old Room was NOT deleted.").
 */
export function withoutServiceLine(line: string | null): string | null {
	if (!line || !isServiceUnreachableLine(line)) return line;
	let rest = line;
	for (const sentence of SERVICE_UNREACHABLE_SENTENCES) rest = rest.split(`: ${sentence}`).join(".").split(sentence).join(" ");
	rest = rest.replace(/\s{2,}/g, " ").trim();
	return rest || null;
}

/** A request that got no answer: still a TypeError, which the checks for a restart's dropped request look for. */
export class ServiceUnreachableError extends TypeError {
	constructor() {
		super(serviceUnreachableSentence());
		this.name = "ServiceUnreachableError";
	}
}

/** A request the server answered with an error: its sentence, plus the HTTP status and the machine code when it sent one. */
export class ApiRequestError extends Error {
	constructor(message: string, readonly status: number, readonly code?: string, readonly details?: unknown) {
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
	const res = await apiFetch(url, init);
	if (!res.ok) {
		let message = `Request failed (${res.status})`;
		let code: string | undefined;
		let details: unknown;
		try {
			const body = await res.json();
			if (body?.error) message = String(body.error);
			else if (body?.message) message = String(body.message);
			if (typeof body?.code === "string") code = body.code;
			if (body?.details !== undefined) details = body.details;
		} catch {}
		throw new ApiRequestError(message, res.status, code, details);
	}
	return await res.json() as T;
}
