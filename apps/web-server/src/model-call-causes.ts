// Why a call to the Memory model failed, and how long to wait it out.
//
// Remember, Memorize and Review all ask the room's Memory model, and all of
// them used to read a failure in their own way: Memorize told six kinds apart,
// Remember three, Review none. This module is the one place that decides what
// a failure means, and the one patience every call gets:
//
//   - busy: a rate limit, too many requests, an overload, the provider's own
//     server error, a dropped connection, a stream that stopped coming, or a
//     call that ran out its ceiling. Waited out quietly, a bounded number of
//     times, with the time of the next try published so the screen can say it;
//   - unreachable: signed out, out of quota, the model no longer offered or
//     not available on this account, or busy for longer than the patience
//     lasts. One notice, never a retry;
//   - refused: the provider's safety check declined the content. Never retried
//     with the same prompt; the caller makes the request smaller or plainer;
//   - too large: the provider says the request is too big. The caller makes it
//     smaller;
//   - cancelled, and anything else: handed back as it came.
//
// No other model is ever tried: the module names the cause, it never chooses.

import { rememberSentenceModelName } from "./checkpoint-compression.js";
import { modelNotOnAccount, modelNotOnAccountSentence, notOnAccountWhy, type NotOnAccountWayOut } from "./model-not-on-account.js";
import { isSignInFailure } from "../../web-ui/src/sign-in-failure.js";
import { GATEWAY_REFUSED_CAUSE, gatewayNotFoundLine, gatewayRefusedWayOn, namedContextLimit, quotaCause, quotaWayOn, REGION_OR_PLAN_CAUSE, unreachedCause, unreachedWayOn, type GatewayFind, type QuotaWay, type RetryFailure, type TurnFailure, type Unreached } from "../../web-ui/src/turn-failure-line.js";
import { readOpenAiCompatibleGateways } from "./openai-compatible-gateways.js";
import { gatewayModelFind } from "./gateway-model-find.js";
import { statusAskedAgainByProvider } from "@exxeta/exxperts-runtime";
import { isSharedServer } from "./server-hooks.js";
import { anthropicKeyNeedsWorkspace, credentialGoneOf, credentialGoneWhy, credentialGoneWords, modelNotOffered, signInFailed, type CredentialKey } from "./model-not-offered.js";
import { providerOnThisComputer } from "./openai-compatible-gateway-catalog.js";
import { IsolatedPersistentAgentWorkerTurnError } from "./persistent-agent-worker-runtime.js";
import { catalogModelNames, createRoomModelCatalog, providerSignsIn, roomModelUnavailableSentence, type RoomModelRefusalOf } from "./room-models.js";

export type OutageClass = "rate-limit" | "quota" | "too-many-requests" | "overload";
export type BusyDetail = "rate-limit" | "too-many-requests" | "overload" | "server-error" | "connection" | "stalled" | "timed-out";
export type UnreachableDetail = "signed-out" | "quota" | "not-offered" | "not-on-account" | "region-or-plan" | "gateway-refused" | "gateway-not-found" | "not-answering" | "still-busy";

export type ModelFailure =
	| { cause: "busy"; detail: BusyDetail; waitMs?: number }
	| { cause: "unreachable"; detail: UnreachableDetail }
	| { cause: "refused" }
	| { cause: "too-large" }
	| { cause: "cancelled" }
	| { cause: "other" };

// --- The words ------------------------------------------------------------------

/**
 * The outage rule for a failure's own words: a rate limit, a quota, too many
 * requests or an overload is the provider refusing the RUN, not this request,
 * whatever a tiny probe says (a tokens-per-minute 429 fails a large prompt and
 * passes a small probe). Whole words and codes only: "4290" in a token count
 * is not a 429.
 */
export function outageClassOf(message: string): OutageClass | undefined {
	// "RateLimitError" (LiteLLM, the gateway's class name), "ThrottlingException"
	// (Bedrock) and "Request was throttled" (Azure) are rate limits too.
	if (/\brate[ _-]?limit\w*|\bthrottl\w*/i.test(message)) return "rate-limit";
	// A spent plan, credit or budget too: ChatGPT's usage limit, Anthropic's credit balance, a gateway's budget.
	if (/\b(?:insufficient_)?quota(?:_[a-z]+)?\b|\bresource[ _]exhausted\b|\busage[ _]limit\b|\bcredit balance is too low\b|\bbudget\b[^.!]{0,60}\bexceeded\b|\bexceeded[ _]?budget\b|\bbudget_exceeded\b|\bcredit balance (?:is )?exhausted\b|\bspend limit reached\b|\bdaily free allocation\b/i.test(message)) return "quota";
	if (/\b429\b|\btoo[ _]many[ _]requests\b/i.test(message)) return "too-many-requests";
	if (/\boverload(?:ed)?(?:_error)?\b|\b529\b/i.test(message)) return "overload";
	return undefined;
}

/** A plan, credit or budget that is spent, in each provider's own words (OpenAI's spend limits, Workers AI's daily allocation): waiting does not bring it back. */
function spentCredit(message: string): boolean {
	return /\binsufficient_quota\b|\bplan and billing\b|\busage[ _]limit|\bcredit balance is too low\b|\bbudget\b[^.!]{0,60}\bexceeded\b|\bexceeded[ _]?budget\b|\bbudget_exceeded\b|\bcredit balance (?:is )?exhausted\b|\bspend limit reached\b|\bdaily free allocation\b/i.test(message);
}

/**
 * A blip: the provider saying its own side failed (a 5xx status beside its
 * word or opening the message, "server_error", "service unavailable", a bad
 * gateway or a gateway timeout), or the connection going (a WebSocket error, a dropped socket).
 * Either clears within a minute, and a call asked again at once fails again.
 * A content refusal names none of these words: it is a 400 or a reply, so
 * it keeps the short pause. The outage rule reads first: a 529 or an
 * overload is the provider refusing the run.
 */
export function blipClassOf(message: string): "server-error" | "connection" | undefined {
	if (/\bserver[ _]error\b|\bservice[ _]unavailable\w*|\bbad[ _]gateway\b|\bgateway[ _]time-?out\b|\b(?:status(?:[ _]?code)?|http(?:\/[\d.]+)?)\s*[:=]?\s*5\d\d\b|^\s*5\d\d(?=\s|$)/i.test(message)) return "server-error";
	if (connectionDropped(message)) return "connection";
	return undefined;
}

/**
 * A failure's words that say the connection itself went: the stream ended
 * (undici's whole message "terminated", never a sentence that merely uses the
 * word), the socket reset or the WebSocket failed, the host could not be
 * reached, the fetch failed. A 502 or 504 is the provider's answer, not a dropped connection.
 */
export function connectionDropped(message: string): boolean {
	return /^\s*(?:\w*Error: )?terminated\.?\s*$/i.test(message) || /\bECONN(?:RESET|REFUSED|ABORTED)\b|\bENOTFOUND\b|\bEAI_AGAIN\b|\bEHOSTUNREACH\b|\bUND_ERR_\w+|\bETIMEDOUT\b|\bEPIPE\b|\bsocket hang up\b|\bfetch failed\b|\bother side closed\b|\bpremature close\b|\bnetwork error\b|\bconnection (?:reset|closed|lost|error)\b|\bwebsocket(?: connection)? (?:error|closed)\b|^\s*Connection error\.?\s*$/i.test(message);
}

/**
 * A failure's words that say no connection was ever made: refused, a name that
 * does not resolve, or the fetch failing outright. The Anthropic and OpenAI
 * clients say "Connection error." for any failure before a reply, and the
 * workers make one attempt, so it may be a blip: the patience asks the probe.
 */
export function connectionNeverOpened(message: string): boolean {
	return /\bECONNREFUSED\b|\bENOTFOUND\b|\bEHOSTUNREACH\b|^\s*(?:\w*Error: )?fetch failed\b|^\s*Connection error\.?\s*$/i.test(message);
}

/** The pause before a call that failed on a blip is asked again: long enough for the blip to pass, since the next failure stops the run. */
export const BLIP_PAUSE_MS = 30_000;

/** The long pause before a rate-limited call is asked again: what the provider asks for, within these bounds, else the default. */
/** A quota whose named wait is longer than this is spent, not a per-minute limit. */
const QUOTA_SPENT_WAIT_MS = 10 * 60_000;
export const RATE_LIMIT_PAUSE_MIN_MS = 20_000;
export const RATE_LIMIT_PAUSE_MAX_MS = 60_000;
export const RATE_LIMIT_PAUSE_DEFAULT_MS = 30_000;

/**
 * The wait a provider names in its own words ("Please try again in 12.5s",
 * "retry after 20 seconds", "try again in 1m30s", "Retry-After: 40"), in
 * milliseconds, or undefined when it names none.
 */
export function providerNamedWaitMs(message: string): number | undefined {
	const phrase = /\b(?:try again|retry)\s+(?:in|after)\s+(?:~\s*|about\s+)?(?:(\d+(?:\.\d+)?)\s*m(?:in(?:ute)?s?)?(?![a-z])\s*)?(?:(\d+(?:\.\d+)?)\s*(ms|milliseconds?|s|secs?|seconds?)\b)?/i.exec(message);
	if (phrase && (phrase[1] || phrase[2])) {
		const minutes = Number(phrase[1] ?? 0);
		const rest = Number(phrase[2] ?? 0);
		const restMs = /^m/i.test(phrase[3] ?? "") ? rest : rest * 1000;
		return minutes * 60_000 + restMs;
	}
	const header = /\bretry[- ]after\s*[:=]\s*(\d+(?:\.\d+)?)\b/i.exec(message);
	if (header) return Number(header[1]) * 1000;
	return undefined;
}

/**
 * How long a rate-limited fold waits before its one retry: what the provider
 * asks for, raised to the floor (most per-minute limits need that long to
 * reset) and cut to the ceiling, else the default.
 */
export function rateLimitPauseMs(message: string): number {
	const named = providerNamedWaitMs(message);
	if (named === undefined) return RATE_LIMIT_PAUSE_DEFAULT_MS;
	return Math.min(RATE_LIMIT_PAUSE_MAX_MS, Math.max(RATE_LIMIT_PAUSE_MIN_MS, Math.round(named)));
}

/**
 * The provider saying the REQUEST is too large for it: a context window or a
 * per-minute token ceiling below this prompt. Whole phrases only, in the
 * shapes the providers and gateways send.
 */
export function requestTooLarge(message: string): boolean {
	return /\brequest too large for\b/i.test(message) // OpenAI, per-minute ceiling: "Request too large for gpt-4o in organization ... on tokens per min (TPM)"
		|| /\bcontext_length_exceeded\b|\bmaximum context length is\b/i.test(message) // OpenAI and compatible gateways
		|| /\bprompt is too long\b/i.test(message) // Anthropic
		|| /\brequest entity too large\b|\brequest_too_large\b/i.test(message) // HTTP 413
		|| /\bContextWindowExceededError\b/.test(message) // LiteLLM passthrough
		|| /\bContext Window Error\b/i.test(message) // Bedrock's exception, as LiteLLM passes it on
		|| /\bexceed context limit\b/i.test(message) // "input length and `max_tokens` exceed context limit"
		|| /\bexceeds the maximum number of tokens\b/i.test(message)
		|| /\binput is too long\b|\binput tokens? exceeds?\b/i.test(message) // Bedrock, and the Responses API
		|| /\btoo large for model with \d+ maximum context length\b/i.test(message); // Mistral
}

/**
 * The provider's safety check declining the content: Anthropic's refusal stop
 * reason (the runtime's own words), a content filter finish (OpenAI chat and
 * Responses, Azure), a content-policy rejection, Google's safety finishes.
 */
export function contentRefused(message: string): boolean {
	return /\bthe model refused to answer this request\b/i.test(message)
		|| /\bcontent[_ ]filter\b/i.test(message)
		|| /\bcontent[_ ]policy(?:[_ ]violation)?\b|\bcontent management policy\b/i.test(message)
		|| /\bfinish[_ ]?reason\W+(?:SAFETY|PROHIBITED_CONTENT|BLOCKLIST|SPII)\b/i.test(message);
}

export { modelNotOffered, signInFailed };

// --- The decision -----------------------------------------------------------------

/** The provider's own words for a failure, whatever shape it came in. */
export function failureWords(error: unknown): string {
	if (error instanceof IsolatedPersistentAgentWorkerTurnError) return error.providerMessage ?? error.message;
	return error instanceof Error ? error.message : String(error);
}

/** A failed call's HTTP status and the provider's error type, as the runtime keeps them beside the words of a failed message, and the API it was made through. */
export interface FailureCodes {
	errorStatus?: number;
	errorType?: string;
	api?: string;
}

/** The codes a failed message or a failure carries; a saved message from before they were kept has none. */
export function failureCodesOf(failed: unknown): FailureCodes {
	if (!failed || typeof failed !== "object") return {};
	const { errorStatus, errorType, api } = failed as { errorStatus?: unknown; errorType?: unknown; api?: unknown };
	return {
		...(typeof errorStatus === "number" && Number.isInteger(errorStatus) && errorStatus >= 400 && errorStatus <= 599 ? { errorStatus } : {}),
		...(typeof errorType === "string" && /^[A-Za-z][\w.-]{0,63}$/.test(errorType) ? { errorType } : {}),
		...(typeof api === "string" && /^[A-Za-z][\w.-]{0,63}$/.test(api) ? { api } : {}),
	};
}

/**
 * The HTTP status a failure carries (the runtime's errorStatus, a client's
 * status or statusCode), else the one its words name: "400 …", "Error: 400 …",
 * "status 400", "status code 400", "HTTP 403", "HTTP/1.1 503", "error (400): …".
 * Review and the log line both read it. Undefined when there is none.
 */
export function failureStatusOf(error: unknown): number | undefined {
	const carried = failureCodesOf(error).errorStatus ?? (error as { status?: unknown } | null)?.status ?? (error as { statusCode?: unknown } | null)?.statusCode;
	if (typeof carried === "number" && Number.isInteger(carried) && carried >= 400 && carried <= 599) return carried;
	const named = /^\s*(?:\w*Error: )?([45]\d\d)\b|\b(?:status(?:[ _]?code)?|http(?:\/[\d.]+)?)\s*[:=]?\s*([45]\d\d)\b|\(([45]\d\d)\)/i.exec(failureWords(error));
	const status = named?.[1] ?? named?.[2] ?? named?.[3];
	return status ? Number(status) : undefined;
}

/** A failed message's words as an error that carries its codes, for the one reading. */
export function failedMessageError(words: string, codes: FailureCodes = {}): Error {
	return Object.assign(new Error(words), failureCodesOf(codes));
}

/** A 403 or a permission error: the provider refused this request (a region it does not serve, a plan without the model), not the key. */
function refusedForRegionOrPlan(words: string): boolean {
	// Gemini's region refusals come as a 400: "User location is not supported", "free tier is not available in your country".
	return /\bpermission_error\b|\bunsupported_country_region_territory\b|\bcountry, region,? or territory not supported\b|\buser location is not supported\b|\bnot available in your country\b|^\s*403\b|\b(?:status(?:[ _]?code)?|http(?:\/[\d.]+)?|error[ _]code)\s*[:=]?\s*403\b/i.test(words);
}

/** A 403 that names no reason: only its status, with no permission or region words. */
function bare403(words: string): boolean {
	return !/\bpermission_error\b|\bunsupported_country_region_territory\b|\bcountry, region,? or territory\b|\bregion\b/i.test(words);
}

/**
 * What a status says when the words name nothing: only the statuses that
 * mean the same for every provider. A 403 reads as the 403 rule above. A
 * 404 from a gateway (a company's, or a model server on this computer) is
 * almost always a wrong address or model name, not a model withdrawn.
 */
function statusFailure(status: number | undefined, words: string, provider: string | undefined, named: number | undefined): ModelFailure | undefined {
	switch (status) {
		case 401: return { cause: "unreachable", detail: "signed-out" };
		case 402: return { cause: "unreachable", detail: "quota" };
		case 403: return { cause: "unreachable", detail: provider && bare403(words) && gatewayProvider(provider) ? "gateway-refused" : "region-or-plan" };
		case 404: return { cause: "unreachable", detail: provider && gatewayProvider(provider) ? "gateway-not-found" : "not-offered" };
		case 413: return { cause: "too-large" };
		case 429: return named === undefined ? { cause: "busy", detail: "too-many-requests" } : { cause: "busy", detail: "too-many-requests", waitMs: named };
		case 500: case 502: case 503: case 504: return { cause: "busy", detail: "server-error" };
		case 529: return { cause: "busy", detail: "overload" };
		default: return undefined;
	}
}

/**
 * The ONE reading of a failed call. Order matters: the request-too-large
 * words before the rate-limit words (a per-minute "request too large" also
 * carries rate_limit_exceeded), a refusal before anything that a refusal's
 * text could also mention, the busy words before sign-in (a rate limit may
 * name its credential), and sign-in before quota.
 */
export function classifyModelFailure(error: unknown, options: { signal?: AbortSignal; provider?: string } = {}): ModelFailure {
	if (options.signal?.aborted) return { cause: "cancelled" };
	const code = typeof (error as { code?: unknown })?.code === "string" ? (error as { code: string }).code : undefined;
	if (error instanceof ModelUnreachableError) return { cause: "unreachable", detail: error.details.detail };
	if (code === "provider_signed_out") return { cause: "unreachable", detail: "signed-out" };
	if (code === "room_model_unavailable") return { cause: "unreachable", detail: "not-offered" };
	if (error instanceof IsolatedPersistentAgentWorkerTurnError) {
		if (error.reason === "timed-out") return { cause: "busy", detail: "timed-out" };
		if (error.reason === "stalled") return { cause: "busy", detail: "stalled" };
		if (error.stopReason === "aborted") return { cause: "cancelled" };
	}
	if ((error as { name?: unknown })?.name === "AbortError") return { cause: "cancelled" };
	const words = failureWords(error);
	if (requestTooLarge(words)) return { cause: "too-large" };
	if (contentRefused(words)) return { cause: "refused" };
	const outage = outageClassOf(words);
	const named = providerNamedWaitMs(words);
	if (outage && outage !== "quota") return named === undefined ? { cause: "busy", detail: outage } : { cause: "busy", detail: outage, waitMs: named };
	// The provider refusing the model for this account (its plan, its admin) is not a sign-in either.
	if (modelNotOnAccount(words)) return { cause: "unreachable", detail: "not-on-account" };
	// A key with no access to one model is that model not offered, not a sign-in.
	if (modelNotOffered(words)) return { cause: "unreachable", detail: "not-offered" };
	// A key made outside a workspace: refused on every call, so a credential cause with its own words, never "signed out".
	if (/^No API key found for/i.test(words) || anthropicKeyNeedsWorkspace(words) || signInFailed(words)) return { cause: "unreachable", detail: "signed-out" };
	// A company gateway answers a key it does not accept with a bare 403 too (behind API Gateway, Kong or Apigee).
	if (refusedForRegionOrPlan(words)) return { cause: "unreachable", detail: options.provider && bare403(words) && gatewayProvider(options.provider) ? "gateway-refused" : "region-or-plan" };
	// Gemini says "quota" for its per-minute limit too, and then names the
	// wait; Google's own per-minute 429 says "resource exhausted (check quota)"
	// and names none. Only the spent-credit words, or a wait of hours, are spent.
	if (outage === "quota") {
		// A plan's usage limit is spent however soon it resets; a per-minute quota with a short wait is busy.
		if (named !== undefined && named <= QUOTA_SPENT_WAIT_MS && !/\busage[ _]limit/i.test(words)) return { cause: "busy", detail: "rate-limit", waitMs: named };
		return named !== undefined || spentCredit(words) ? { cause: "unreachable", detail: "quota" } : { cause: "busy", detail: "rate-limit" };
	}
	const blip = blipClassOf(words);
	if (blip) return { cause: "busy", detail: blip };
	// Words that name nothing known: the status, where the call kept one.
	return statusFailure(failureCodesOf(error).errorStatus, words, options.provider, named) ?? { cause: "other" };
}

/**
 * The plain line for a failed call that is the provider refusing the model
 * for this account, or undefined for any other failure. For the paths that
 * show a line, not the notice: a consult, a specialist task, HiveMind.
 */
export function notOnAccountLine(error: unknown, model: ModelNoticeModel, where?: NotOnAccountWayOut): string | undefined {
	return modelNotOnAccount(failureWords(error)) ? modelNotOnAccountSentence(rememberSentenceModelName(model), model.provider, where) : undefined;
}

/**
 * The plain line for a failed call on a Memory model the provider no longer
 * serves, or undefined for any other failure: the sentence the row's own
 * refusal says before a call. For the same paths as notOnAccountLine.
 */
export function notOfferedLine(error: unknown, model: ModelNoticeModel, of: RoomModelRefusalOf): string | undefined {
	const failure = classifyModelFailure(error);
	if (failure.cause !== "unreachable" || failure.detail !== "not-offered") return undefined;
	return roomModelUnavailableSentence({ provider: model.provider, model: model.model }, "not-offered", "memory", catalogModelNames(createRoomModelCatalog()), of);
}

// --- The one notice's error -------------------------------------------------------

export interface ModelNoticeModel {
	provider: string;
	model: string;
	label?: string;
}

export interface ModelUnreachableDetails {
	cause: "unreachable";
	detail: UnreachableDetail;
	provider: string;
	model: string;
	label?: string;
	/** For a busy model given up on: the busy kind it last answered with. */
	busy?: BusyDetail;
	/** Signed out on a key connection: its key is missing, or saved and refused. */
	key?: CredentialKey;
	/** Out of quota: who can lift it, with a sign-in plan's reset when the provider named it. */
	quotaWay?: QuotaWay;
	/** Not answering because no connection opened, or because the model runs on this computer. */
	unreached?: Unreached;
	/** A gateway's bare "not found": what its model list said. */
	gatewayFind?: GatewayFind;
}

/**
 * A signed-out key connection's state, from the failure: no key found (or no
 * failure, a refusal before any call) is missing; Anthropic's 400 for a key
 * made outside a workspace is its own case; anything else, a 401 or a 403, is
 * the service refusing the saved key. Undefined for a sign-in.
 */
export function credentialKeyOf(detail: UnreachableDetail, provider: string, last?: unknown): CredentialKey | undefined {
	// The gateway may not accept its saved key: the key's button is one way on.
	if (detail === "gateway-refused") return "refused";
	if (detail !== "signed-out" || providerSignsIn(provider)) return undefined;
	if (last === undefined || (last as { code?: unknown })?.code === "provider_signed_out") return "missing";
	const words = failureWords(last);
	if (anthropicKeyNeedsWorkspace(words)) return "no-workspace";
	return /^No API key found for|\bNo API key for provider: |\bprovider not connected\b/i.test(words) ? "missing" : "refused";
}

/**
 * A credential a chat turn failed for, read with the page's own matcher,
 * which leaves out a 403 or a permission error on purpose: a key
 * connection's state, or "signed-out" for a sign-in; undefined for any other
 * failure.
 */
export function failedTurnCredential(provider: string, words: string, codes: FailureCodes = {}): CredentialKey | "signed-out" | undefined {
	if (!provider || !(isSignInFailure(words) || anthropicKeyNeedsWorkspace(words) || turnFailureOf(words, false, provider, false, codes) === "signed-out")) return undefined;
	return credentialKeyOf("signed-out", provider, new Error(words)) ?? "signed-out";
}

/** A key connection's state when a chat turn on it failed for its credential; undefined for a sign-in or any other failure. */
export function failedTurnKey(provider: string, words: string, codes: FailureCodes = {}): CredentialKey | undefined {
	const credential = failedTurnCredential(provider, words, codes);
	return credential === "signed-out" ? undefined : credential;
}

const BUSY_MODEL: ReadonlySet<BusyDetail> = new Set(["rate-limit", "too-many-requests", "overload"]);

/** A message's content holds some answer text: the model was reached and had begun. */
export function answerStarted(content: unknown): boolean {
	return Array.isArray(content) && content.some((part) => (part as { type?: unknown })?.type === "text" && typeof (part as { text?: unknown }).text === "string" && (part as { text: string }).text.trim() !== "");
}

/**
 * A failed chat turn's cause, for the room's plain line: "still busy" only
 * when the runtime really asked again, or the provider's own client asked a
 * 429 again, since the line says "after several tries".
 * `answerStarted`: the failed message already holds part of an answer, so the
 * model was reached: anything but a refusal reads as cut off. `codes`: the
 * failed message's status, error type and API, read where the words name nothing.
 */
export function turnFailureOf(words: string, retried: boolean, provider: string, answerStarted = false, codes: FailureCodes = {}): TurnFailure {
	// More than the model reads at once (the providers' phrases, or a limit they name) is a size problem whatever else the words say, so it is read first.
	if (/context(?:[ _-]?window| length)|too many tokens|maximum context|prompt is too long|exceeds? (?:the )?(?:model'?s? )?(?:context|token|input)/i.test(words.trim().slice(0, 300)) || namedContextLimit(words) !== undefined) return "overflow";
	const failure = classifyModelFailure(failedMessageError(words, codes), { provider });
	// A refusal can come after part of an answer: it is still a refusal, never "cut off".
	if (failure.cause === "refused") return "refused";
	if (answerStarted) return "cut-off";
	// OpenAI's per-minute ceiling: this one request is larger than the account takes in a minute, so waiting never helps.
	if (failure.cause === "too-large" && /\brequest too large for\b/i.test(words)) return "too-large";
	if (failure.cause === "unreachable" && failure.detail === "quota") return "quota";
	if (failure.cause === "unreachable" && failure.detail === "region-or-plan") return "region-or-plan";
	if (failure.cause === "unreachable" && failure.detail === "gateway-refused") return "gateway-refused";
	if (failure.cause === "unreachable" && failure.detail === "gateway-not-found") return "gateway-not-found";
	if (failure.cause === "busy" && failure.detail === "connection") return providerOnThisComputer(provider) ? "local-connection" : "connection";
	// A 429 the provider's own client already asked again was tried several times too, though the runtime does not ask it again.
	const askedAgain = retried || (codes.errorStatus === 429 && statusAskedAgainByProvider(codes.api, 429));
	if (askedAgain && failure.cause === "busy" && BUSY_MODEL.has(failure.detail)) return "still-busy";
	// The page reads a sign-in and a model no longer offered from the words; one only the status said is named for it.
	if (failure.cause === "unreachable" && (failure.detail === "signed-out" || failure.detail === "not-offered") && codes.errorStatus !== undefined && classifyModelFailure(new Error(words), { provider }).cause === "other") return failure.detail;
	return "other";
}

/**
 * Why the room could not shorten a conversation, from the runtime's
 * compaction error, read with the one reader. A size problem (the summary
 * call too large, a summary cut at the model's output limit, or the runtime's
 * own refusal) has no `failure`; any other cause is the chat's cause for it,
 * as after the runtime's tries. `words`: the provider's words for Details,
 * without the runtime's prefixes; none where the runtime said it.
 */
export function compactionFailureOf(errorMessage: string, provider: string): { failure?: TurnFailure; words?: string; summaryCut: boolean } {
	const words = errorMessage.replace(/^(?:Context overflow recovery|Auto-compaction) failed: (?:(?:Turn prefix )?[Ss]ummarization failed: )?/, "");
	const summaryCut = /\bhit the token cap\b/.test(words);
	const cause = classifyModelFailure(failedMessageError(words), { provider }).cause;
	if (summaryCut || cause === "other" || cause === "cancelled") return { summaryCut };
	if (cause === "too-large") return { words, summaryCut };
	return { failure: turnFailureOf(words, true, provider), words, summaryCut };
}

/** Why the runtime is asking again, for the note it shows meanwhile; never "busy" for a spent quota. */
export function retryFailureOf(words: string, codes: FailureCodes = {}): RetryFailure {
	const failure = classifyModelFailure(failedMessageError(words, codes));
	if (failure.cause === "busy" && BUSY_MODEL.has(failure.detail)) return "busy";
	if (failure.cause === "busy" && failure.detail === "connection") return "connection";
	return "provider-error";
}

export interface ProviderFailureLogFields {
	cause: string;
	status?: number;
	errorType?: string;
	requestId?: string;
}

/**
 * What a failed provider call's log line holds: its cause, the HTTP status,
 * and the provider's error type and request id when the failure kept them or
 * its words carry them.
 * Codes only, never the words, so a key a provider echoes back cannot reach
 * the log. Undefined for a call that was cancelled. `provider`: the call's,
 * so a gateway's bare 403 is logged as the chat reads it.
 */
export function providerFailureLogFields(error: unknown, provider?: string): ProviderFailureLogFields | undefined {
	const failure = classifyModelFailure(error, { provider });
	if (failure.cause === "cancelled") return undefined;
	const words = failureWords(error);
	const codes = failureCodesOf(error);
	const status = failureStatusOf(error);
	const errorType = codes.errorType ?? /"error"\s*:\s*\{[^{}]*?"type"\s*:\s*"([A-Za-z][\w.-]{0,63})"/.exec(words)?.[1];
	const requestId = /"request_id"\s*:\s*"([\w-]{1,128})"/.exec(words)?.[1];
	return {
		cause: "detail" in failure ? `${failure.cause}:${failure.detail}` : failure.cause,
		...(status !== undefined ? { status } : {}),
		...(errorType ? { errorType } : {}),
		...(requestId ? { requestId } : {}),
	};
}

/**
 * Providers whose saved key the service refused at the last call, or whose
 * sign-in the last call found gone, so AI setup does not call them ready.
 * Kept by this process only: after a restart the next call tells again.
 */
const keyRefusals = new Map<string, KeyRefusal>();

/** Why the last call failed for the saved credential: the key itself, a key made outside a workspace, or a sign-in gone (expired, revoked, or its refresh refused). */
export type KeyRefusal = "refused" | "no-workspace" | "signed-out";

/** When each provider's key was last saved or removed, or its sign-in made or ended. */
const keySavedAt = new Map<string, number>();

/**
 * What a call said about its provider's credential: a key refused (or outside
 * a workspace), a sign-in gone, answered, or nothing either way. A refusal of
 * a call that started before the key was last saved, or the sign-in last
 * made, is about the credential before, and is not kept.
 */
export function noteKeyOutcome(provider: string, outcome: CredentialKey | "signed-out" | "answered" | undefined, callStartedAt?: number): void {
	if (outcome === "answered") keyRefusals.delete(provider);
	else if ((outcome === "refused" || outcome === "no-workspace" || outcome === "signed-out") && (callStartedAt ?? Infinity) >= (keySavedAt.get(provider) ?? 0)) keyRefusals.set(provider, outcome);
}

/** A key saved again or removed, or a sign-in made or ended: the last refusal was about the credential before. */
export function forgetKeyRefusal(provider: string): void {
	keyRefusals.delete(provider);
	keySavedAt.set(provider, Date.now());
}

export function keyRefusalOf(provider: string): KeyRefusal | undefined {
	return keyRefusals.get(provider);
}

/** The profile's words for a refused key or a sign-in gone, with the room's own cause: only ours, never the provider's text, which can hold part of the key. */
export function keyRefusedSetupSentence(refusal: KeyRefusal): string {
	// A shared server has no sign-ins: AI setup never shows one there.
	if (refusal === "signed-out") return `Signed out at the last try. ${credentialGoneWords("signed-out").again} to continue.`;
	// On a shared server only the admin can replace the key: AI setup is locked there.
	const wayOn = isSharedServer() ? "Tell your admin." : "Replace the key to continue.";
	if (refusal === "no-workspace") return `Not accepted at the last try: this key isn't tied to a workspace. ${wayOn}`;
	return `Not accepted at the last try. ${wayOn}`;
}

/**
 * The sentence the notice leads with (draft wording). It names the model as
 * the app shows it everywhere, whether the caller passed a label or a bare
 * model lock.
 */
export function modelUnreachableSentence(detail: UnreachableDetail, model: ModelNoticeModel, key?: CredentialKey, unreached?: Unreached, quotaWay?: QuotaWay, gatewayFind?: GatewayFind): string {
	const name = rememberSentenceModelName(model);
	if (detail === "not-answering" && unreached) return `${name} ${unreachedCause(unreached)}. Nothing was lost. ${unreachedWayOn(unreached, isSharedServer())}`;
	switch (detail) {
		case "signed-out": return `${name} ${credentialGoneWhy(credentialGoneOf(key))}. Nothing was lost.`;
		case "quota": {
			const way = quotaWay ?? quotaWayOf(model.provider);
			// A plan's reset ahead is a time of day: the page words it from the details' quotaWay, in the person's own zone and clock, never the server's.
			const wayOn = quotaWayOn(way.kind === "sign-in" && Date.parse(way.resetsAt ?? "") > Date.now() ? { kind: "sign-in", provider: way.provider } : way);
			return `${name} ${quotaCause(way)}. Nothing was lost.${wayOn ? ` ${wayOn}` : ""}`;
		}
		case "not-offered": return `${name} is no longer offered. Nothing was lost.`;
		case "not-on-account": return `${name} ${notOnAccountWhy(model.provider)}. Nothing was lost.`;
		case "region-or-plan": return `${name} ${REGION_OR_PLAN_CAUSE}. Nothing was lost.`;
		case "gateway-refused": return `${name} ${GATEWAY_REFUSED_CAUSE}. Nothing was lost.${isSharedServer() ? ` ${gatewayRefusedWayOn(true)}.` : ""}`;
		case "gateway-not-found": {
			const line = gatewayNotFoundLine(providerNameOf(model.provider), name, gatewayFind, isSharedServer());
			return `${line.cause} Nothing was lost. ${line.wayOn}`;
		}
		case "still-busy": return `${name} is still busy after several tries. Nothing was lost.`;
		case "not-answering": return `${name} isn't answering right now. Nothing was lost.`;
	}
}

/**
 * The model cannot be reached. It carries the product's sentence as its
 * message and the cause as `details`, under the code the screens branch on to
 * show the one notice with its buttons (Try again, Choose another model, and
 * Sign in when that is the cause).
 */
export class ModelUnreachableError extends Error {
	readonly statusCode = 503;
	readonly code = "model_unreachable";
	readonly details: ModelUnreachableDetails;
	/** The failure that ended the patience, for the log only. */
	readonly last: unknown;
	constructor(detail: UnreachableDetail, model: ModelNoticeModel, last?: unknown, busy?: BusyDetail, gatewayFind?: GatewayFind) {
		const key = credentialKeyOf(detail, model.provider, last);
		const unreached = detail !== "not-answering" ? undefined : providerOnThisComputer(model.provider) ? "local-connection" : last !== undefined && connectionNeverOpened(failureWords(last)) ? "connection" : undefined;
		const quotaWay = detail === "quota" ? quotaWayOf(model.provider, last === undefined ? undefined : failureWords(last)) : undefined;
		super(modelUnreachableSentence(detail, model, key, unreached, quotaWay, gatewayFind));
		this.name = "ModelUnreachableError";
		this.details = { cause: "unreachable", detail, provider: model.provider, model: model.model, ...(model.label ? { label: model.label } : {}), ...(busy ? { busy } : {}), ...(key ? { key } : {}), ...(unreached ? { unreached } : {}) , ...(quotaWay ? { quotaWay } : {}), ...(gatewayFind ? { gatewayFind } : {}) };
		this.last = last;
	}
}

// --- Patience ---------------------------------------------------------------------

/** The waits before each new try of a busy call: about six minutes in all. */
export const PATIENCE_WAITS_MS: readonly number[] = [15_000, 30_000, 60_000, 120_000, 120_000];
/** A wait the provider names is kept within these bounds. */
export const PATIENCE_NAMED_WAIT_MIN_MS = 15_000;
export const PATIENCE_NAMED_WAIT_MAX_MS = 120_000;
/** A stream that stopped coming is asked again at most this often, and a call that ran out its ceiling at most this often: each try can cost the whole ceiling. */
export const PATIENCE_STALL_RETRIES = 2;
export const PATIENCE_TIMEOUT_RETRIES = 1;
/** The short pause before a stalled or timed-out call is asked again. */
export const PATIENCE_RETRY_PAUSE_MS = 2_000;

/** What a screen shows while a call is waited out: busy, or not reached yet (a first call that could not connect, before the probe), which try comes next, and when. */
export interface PatienceWait {
	cause: "busy" | "unreached";
	detail: BusyDetail;
	/** The try that comes next: 2 for the first retry. */
	attempt: number;
	nextTryAt: string;
	/** Set when an earlier wait of this call already said the model is busy. */
	again?: true;
	/** For a server error: the provider as AI setup names it, since the problem is on its side. */
	provider?: string;
}

/** Who can lift a provider's spent usage limit or credit, for the lines' way on; a sign-in's plan with its reset, when the provider's words name it. */
export function quotaWayOf(provider: string, words?: string): QuotaWay {
	if (isSharedServer()) return { kind: "shared" };
	if (provider === "anthropic-api-key") return { kind: "claude-key" };
	const name = providerNameOf(provider);
	if (providerSignsIn(provider)) {
		const resetMs = words ? providerNamedWaitMs(words) : undefined;
		// "~0 min" is a reset already behind, not an unknown one.
		return { kind: "sign-in", provider: name, ...(resetMs !== undefined ? { resetsAt: new Date(Date.now() + resetMs).toISOString() } : {}) };
	}
	return { kind: gatewayProvider(provider) ? "gateway" : "key", provider: name };
}

/** A company gateway the person saved in AI setup. */
function gatewayProvider(provider: string): boolean {
	try {
		return readOpenAiCompatibleGateways().gateways.some((entry) => entry.providerId === provider);
	} catch {
		return false;
	}
}

/** A company gateway's name as AI setup shows it, for a line that names it; undefined for a provider that is no gateway, or a gateway the catalog has no name for. */
export function gatewayNameOf(provider: string): string | undefined {
	if (!gatewayProvider(provider)) return undefined;
	const name = providerNameOf(provider);
	return name && name !== provider ? name : undefined;
}

/** The provider as AI setup names it: a gateway by its label, a built-in provider by its profile's. */
export function providerNameOf(provider: string): string {
	try {
		return catalogModelNames(createRoomModelCatalog()).provider(provider);
	} catch {
		return provider;
	}
}

export interface PatienceOptions {
	/** The model the call is on, as the notice names it. */
	model: ModelNoticeModel;
	/** Told of every wait before it starts, and with null once the call answered. */
	onWait?: (wait: PatienceWait | null) => void;
	signal?: AbortSignal;
	/** Tests replace the clock and the sleep. */
	sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
	now?: () => Date;
	/**
	 * The tiny question asked when a server error, a dropped connection, a
	 * stall or a timeout outlasted the patience. It answering means the model
	 * is up and the failure is this request's own; the error is then handed
	 * back to the caller. Without a probe, such an error is handed back marked
	 * as spent (see `patienceSpent`), for a caller that has its own probe.
	 */
	probe?: (signal?: AbortSignal) => Promise<unknown>;
	/** Asked after the first wait when the first call could not connect; `probe` when not given. For a caller whose own probe ends the patience. */
	connectProbe?: (signal?: AbortSignal) => Promise<unknown>;
}

/**
 * One wait line for calls that wait side by side (Remember's parts, Review's
 * tidy groups, Memorize's calls, two screens' calls in one room): each call
 * keeps its own wait, and the line shows the one that tries again last, so a
 * call that ends or wakes never takes down a wait another call is still in.
 */
export class WaitLine {
	private readonly open = new Map<object, PatienceWait>();
	constructor(private readonly publish: (wait: PatienceWait | undefined) => void = () => {}) {}

	/** One call's own onWait. */
	call(): (wait: PatienceWait | null) => void {
		const own = {};
		return (wait) => {
			if (wait) this.open.set(own, wait);
			else this.open.delete(own);
			this.publish(this.current());
		};
	}

	/** The wait the line shows: the one whose next try comes last. */
	current(): PatienceWait | undefined {
		let shown: PatienceWait | undefined;
		for (const wait of this.open.values()) if (!shown || wait.nextTryAt > shown.nextTryAt) shown = wait;
		return shown;
	}
}

/** The screens that wait on a room's request-shaped calls: Memorize's and Review's. */
export type RoomCallFlow = "absorb" | "review";

/**
 * The waits of a room's request-shaped Memory model calls (a first read, a
 * discussion turn, a sign-off), per flow, kept in memory so the flow's status
 * route can say them while the screen's one request is still open.
 */
const roomCallWaits = new Map<string, { line: WaitLine; calls: number }>();

function roomCallKey(agentId: string, flow: RoomCallFlow): string {
	return `${agentId}\u0000${flow}`;
}

export function roomCallWait(agentId: string, flow: RoomCallFlow): PatienceWait | undefined {
	return roomCallWaits.get(roomCallKey(agentId, flow))?.line.current();
}

/** Runs one such call with its wait published for the room's flow, and gone once it ends. */
export async function withRoomCallWait<T>(agentId: string, flow: RoomCallFlow, call: (onWait: (wait: PatienceWait | null) => void) => Promise<T>): Promise<T> {
	const key = roomCallKey(agentId, flow);
	const room = roomCallWaits.get(key) ?? { line: new WaitLine(), calls: 0 };
	roomCallWaits.set(key, room);
	room.calls += 1;
	const onWait = room.line.call();
	try {
		return await call(onWait);
	} finally {
		onWait(null);
		room.calls -= 1;
		if (room.calls === 0 && roomCallWaits.get(key) === room) roomCallWaits.delete(key);
	}
}

/** Set on an error handed back after the patience ran out without a probe, so the caller does not wait it out a second time. */
export function patienceSpent(error: unknown): boolean {
	return !!error && typeof error === "object" && (error as { patienceSpent?: unknown }).patienceSpent === true;
}

function markSpent(error: unknown): unknown {
	if (error && typeof error === "object") {
		try { (error as { patienceSpent?: boolean }).patienceSpent = true; } catch {}
	}
	return error;
}

export function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve) => {
		if (signal?.aborted || ms <= 0) { resolve(); return; }
		const timer = setTimeout(() => { signal?.removeEventListener("abort", onAbort); resolve(); }, ms);
		const onAbort = () => { clearTimeout(timer); resolve(); };
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

/** The busy answers that come from the provider itself: the model was reached. */
const PROVIDER_ANSWERED_BUSY: ReadonlySet<BusyDetail> = new Set(["rate-limit", "too-many-requests", "overload", "server-error"]);

/** The five network kinds share one budget; a stall and a timeout each have their own small one. */
type PatienceBudget = "busy" | "stalled" | "timed-out";

function budgetOf(detail: BusyDetail): PatienceBudget {
	return detail === "stalled" || detail === "timed-out" ? detail : "busy";
}

function busyWaitMs(failure: Extract<ModelFailure, { cause: "busy" }>, retriesSoFar: number): number {
	if (failure.detail === "stalled" || failure.detail === "timed-out") return PATIENCE_RETRY_PAUSE_MS;
	if (failure.waitMs !== undefined) return Math.min(PATIENCE_NAMED_WAIT_MAX_MS, Math.max(PATIENCE_NAMED_WAIT_MIN_MS, Math.round(failure.waitMs)));
	return PATIENCE_WAITS_MS[Math.min(retriesSoFar, PATIENCE_WAITS_MS.length - 1)]!;
}

function retriesAllowed(budget: PatienceBudget): number {
	if (budget === "stalled") return PATIENCE_STALL_RETRIES;
	if (budget === "timed-out") return PATIENCE_TIMEOUT_RETRIES;
	return PATIENCE_WAITS_MS.length;
}

/** Unreachable, as the notice says it; a gateway's bare "not found" first takes one look at its model list, shared with the chat's, to say which way on is real. */
export async function unreachableError(detail: UnreachableDetail, model: ModelNoticeModel, last?: unknown): Promise<ModelUnreachableError> {
	return new ModelUnreachableError(detail, model, last, undefined, detail === "gateway-not-found" ? await gatewayModelFind(model.provider, model.model) : undefined);
}

/**
 * Runs one call to the Memory model with the shared patience:
 *   - busy is waited out: five more tries in all for a rate limit, too many
 *     requests, an overload, a server error or a dropped connection, in any
 *     mix (about six minutes);
 *     two for a stream that stopped coming; one for a call that ran out its
 *     ceiling. Each wait is published first, with the time of the next try;
 *   - a rate limit, too many requests or an overload still failing after that
 *     is the model "still busy": unreachable, whatever a probe would say;
 *   - a server error, a dropped connection, a stall or a timeout still
 *     failing asks the probe: no answer is "not answering", an answer hands
 *     the error back as this request's own;
 *   - signed out, out of quota or no longer offered is unreachable at once;
 *   - a refusal, a request too large, a cancel or anything else is handed back
 *     as it came, untouched.
 * Unreachable is always thrown as ModelUnreachableError.
 */
export async function callWithPatience<T>(call: () => Promise<T>, options: PatienceOptions): Promise<T> {
	const sleep = options.sleep ?? abortableSleep;
	const now = options.now ?? (() => new Date());
	const retries = new Map<PatienceBudget, number>();
	let calls = 0;
	let callStartedAt = 0;
	let waited = false;
	let busySaid = false;
	for (;;) {
		try {
			calls += 1;
			callStartedAt = Date.now();
			const result = await call();
			if (waited) options.onWait?.(null);
			noteKeyOutcome(options.model.provider, "answered");
			return result;
		} catch (error) {
			const failure = classifyModelFailure(error, { signal: options.signal, provider: options.model.provider });
			if (failure.cause === "unreachable") {
				if (waited) options.onWait?.(null);
				const unreachable = error instanceof ModelUnreachableError ? error : await unreachableError(failure.detail, options.model, error);
				// A gateway's bare 403 may be the model, not the key: the card offers the key's button, AI setup keeps the key unmarked.
				if (unreachable.details.detail !== "gateway-refused") noteKeyOutcome(options.model.provider, unreachable.details.key ?? (unreachable.details.detail === "signed-out" ? "signed-out" : undefined), callStartedAt);
				throw unreachable;
			}
			if (failure.cause !== "busy") {
				if (waited) options.onWait?.(null);
				throw error;
			}
			// The first call could not even connect (nothing listens at the address, the
			// name does not resolve): the first wait is said as such, then the probe is asked,
			// after the wait since a network switch fails it too while it lasts. No answer is
			// the notice; an answer makes it a blip, waited out as busy from the next try.
			const connectProbe = options.connectProbe ?? options.probe;
			if (calls === 1 && connectProbe && connectionNeverOpened(failureWords(error))) {
				const ms = PATIENCE_WAITS_MS[0]!;
				retries.set("busy", 1);
				waited = true;
				options.onWait?.({ cause: "unreached", detail: failure.detail, attempt: 2, nextTryAt: new Date(now().getTime() + ms).toISOString() });
				await sleep(ms, options.signal);
				if (options.signal?.aborted) {
					options.onWait?.(null);
					throw error;
				}
				try {
					await connectProbe(options.signal);
				} catch (probeError) {
					options.onWait?.(null);
					if (options.signal?.aborted) throw error;
					const probeFailure = classifyModelFailure(probeError, { provider: options.model.provider });
					if (probeFailure.cause === "unreachable") {
						const unreachable = await unreachableError(probeFailure.detail, options.model, probeError);
						// Cancelled while the gateway's list was read: the cancel wins.
						if (options.signal?.aborted) throw error;
						throw unreachable;
					}
					// Only a probe the provider answered, busy (a rate limit, too many requests, an overload, a server error), reached the model:
					// waited out as busy. One that timed out, went silent or dropped did not answer.
					if (probeFailure.cause !== "busy" || !PROVIDER_ANSWERED_BUSY.has(probeFailure.detail) || connectionNeverOpened(failureWords(probeError))) throw new ModelUnreachableError("not-answering", options.model, error, failure.detail);
				}
				if (options.signal?.aborted) {
					options.onWait?.(null);
					throw error;
				}
				// The next try may be answered: the line comes down while it runs.
				options.onWait?.(null);
				waited = false;
				continue;
			}
			const budget = budgetOf(failure.detail);
			const used = retries.get(budget) ?? 0;
			if (used < retriesAllowed(budget)) {
				retries.set(budget, used + 1);
				const ms = busyWaitMs(failure, used);
				waited = true;
				options.onWait?.({ cause: "busy", detail: failure.detail, attempt: calls + 1, nextTryAt: new Date(now().getTime() + ms).toISOString(), ...(busySaid ? { again: true as const } : {}), ...(failure.detail === "server-error" ? { provider: providerNameOf(options.model.provider) } : {}) });
				if (budget === "busy" && failure.detail !== "connection") busySaid = true;
				await sleep(ms, options.signal);
				if (options.signal?.aborted) {
					options.onWait?.(null);
					throw error;
				}
				options.onWait?.(null);
				waited = false;
				continue;
			}
			if (waited) options.onWait?.(null);
			if (failure.detail === "rate-limit" || failure.detail === "too-many-requests" || failure.detail === "overload") {
				throw new ModelUnreachableError("still-busy", options.model, error, failure.detail);
			}
			if (!options.probe) throw markSpent(error);
			let answered = true;
			try {
				await options.probe(options.signal);
			} catch (probeError) {
				if (options.signal?.aborted) throw error;
				const probeFailure = classifyModelFailure(probeError, { provider: options.model.provider });
				if (probeFailure.cause === "unreachable") {
					const unreachable = await unreachableError(probeFailure.detail, options.model, probeError);
					// Cancelled while the gateway's list was read: the cancel wins.
					if (options.signal?.aborted) throw error;
					throw unreachable;
				}
				answered = false;
			}
			if (!answered) throw new ModelUnreachableError("not-answering", options.model, error, failure.detail);
			throw markSpent(error);
		}
	}
}

/** The silence ceiling every Memory model call gets: a stream with no event for this long has stalled. The wait for the first event is twice this. */
export const MODEL_CALL_IDLE_TIMEOUT_MS = 90_000;
