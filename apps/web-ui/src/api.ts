import { endPageRefused, knownRemoteClientContext, pagePersonId, personHasChanged } from "./remote-client-context";

// A 401 means the session cookie is missing or stale (for example cleared
// while the app was open): the server is fine but every further call fails
// the same way, so the actionable surface is the server's sign-in hint page
// at "/". Every fetch helper in the UI (this module's fetchJson plus the
// per-feature clones) routes its response through here so no screen is left
// rendering a raw auth error. The sessionStorage guard keeps a dev tab,
// where Vite serves this app shell unauthenticated, from reload-looping.
export function redirectToSignInOn401(res: Response): void {
	if (res.status !== 401 || signInRedirectHeld) return;
	const lastRedirect = Number(sessionStorage.getItem("exxperts-auth-redirect") ?? 0);
	if (Number.isFinite(lastRedirect) && Date.now() - lastRedirect < 15000) return;
	sessionStorage.setItem("exxperts-auth-redirect", String(Date.now()));
	location.assign("/");
}

// From the press of the page's own Sign out, only the sign-out moves the page: it follows the server's link on a
// confirmed answer or on the person's choice, all of which leave the page. Its record ends this session, so the page's
// other requests answer 401 meanwhile, and those send it nowhere, however long the person takes to choose.
let signInRedirectHeld = false;

/** For the page's own Sign out, at its press: a 401 no longer sends the page to sign in. */
export function holdSignInRedirect(): void {
	signInRedirectHeld = true;
}

// For call sites that inspect the raw Response instead of using fetchJson:
// same fetch, plus the stale-session redirect above and one plain sentence
// when no answer came. Every direct API call in the UI goes through this or
// fetchJson; plain fetch stays reserved for non-API resources.
export async function apiFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
	// This page has ended: nothing it still has in flight may read or save.
	if (personHasChanged()) throw new Error(PAGE_ENDED_SENTENCE);
	let res: Response;
	try {
		res = await fetch(input, withPagePerson(input, init));
	} catch (error) {
		// fetch rejects with a TypeError only when no answer came, in each browser's own words; a cancel is not one.
		if (error instanceof TypeError) throw new ServiceUnreachableError();
		throw error;
	}
	if (GATEWAY_NO_ANSWER_STATUSES.has(res.status) && !(await isOurErrorAnswer(res))) throw new ServiceUnreachableError();
	// A refusal can say this page ends, and with which words: it ends here, and its words cover it. Only a 403 or a 409
	// is read for it: a stalled body on any other status must not hold that answer up, and the gateway
	// statuses keep their own handling. Other refusals and conflicts reach their caller.
	if (PAGE_ENDING_STATUSES.has(res.status)) {
		const body = await errorAnswerBody(res);
		if (body?.endsPage === true) {
			endPageRefused(typeof body.error === "string" && body.error.trim() !== "" ? body.error : null);
			throw new Error(PAGE_ENDED_SENTENCE);
		}
	}
	// Sent before the page ended, answered after: whatever the answer, it reaches no caller, and a 401 sends the page nowhere.
	if (personHasChanged()) throw new Error(PAGE_ENDED_SENTENCE);
	redirectToSignInOn401(res);
	return res;
}

const PAGE_ENDING_STATUSES: ReadonlySet<number> = new Set([403, 409]);

// What a request on an ended page throws. The cover hides the page, so no one reads it there.
const PAGE_ENDED_SENTENCE = "This page has ended.";

// On a shared server every request names the person the page was opened for, so the server refuses it once another
// person is signed in. Init's headers replace a Request's own in fetch, so the person joins whichever set fetch would send.
function withPagePerson(input: RequestInfo | URL, init: RequestInit | undefined): RequestInit | undefined {
	const person = pagePersonId();
	if (person === null) return init;
	const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
	headers.set("X-Exxperts-Page-Person", person);
	return { ...init, headers };
}

// What stands in front of a shared server (its entrance, its gate) answers
// for it while it is down or restarting, in its own words: the same as no
// answer. Our own error answers are JSON with a sentence and keep it.
const GATEWAY_NO_ANSWER_STATUSES: ReadonlySet<number> = new Set([502, 503, 504]);

async function isOurErrorAnswer(res: Response): Promise<boolean> {
	const body = await errorAnswerBody(res);
	return typeof body?.error === "string" || typeof body?.message === "string";
}

// A JSON answer's body, read from a copy so the caller still reads the answer; null when it is not JSON.
async function errorAnswerBody(res: Response): Promise<Record<string, unknown> | null> {
	if (!/\bapplication\/json\b/i.test(res.headers.get("content-type") ?? "")) return null;
	try {
		const body: unknown = await res.clone().json();
		return typeof body === "object" && body !== null ? body as Record<string, unknown> : null;
	} catch {
		return null;
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
