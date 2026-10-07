// Memorize never gets stuck: the page core.
//
// One Memorize run folds the room's waiting conversations ("pages") one at a
// time. This module owns every decision about how ONE page ends, and the order
// the pages are taken in; the run (absorb-run.ts) owns the prompts, the working
// document and the card, and hands them in as `PageDeps`. The simulation drives
// this same function with fake calls, so the rules it proves are these rules.
//
// How a page ends:
//   - a usable reply is applied: folded, or dropped when the model judged it
//     empty. An apply that throws files the page as its summary;
//   - an unreadable reply is asked again ONCE; still unreadable, the page is
//     filed as its summary in this run;
//   - a readable reply of which nothing lands (every op a trace, and no drop)
//     is filed as its summary at once: asking again would only say it was
//     unreadable, which it was not;
//   - a prompt too large for the window is filed as its summary;
//   - a call that fails asks the same model a tiny question, the probe, after
//     the one retry the failure earns: a short pause for a dropped connection,
//     a long one (what the provider asks for, 20 to 60 seconds) for a rate
//     limit, too many requests or an overload; a quota gets none:
//       - the probe fails, or the failure named a rate limit, a quota, too many
//         requests or an overload: it is an OUTAGE. The run stops, every page
//         left waits, and this page is NOT recorded: an outage never counts
//         against a page;
//       - the probe answers: the failure is the page's. A page that already
//         failed in an earlier run is filed as its summary; otherwise a record
//         is HELD for it and it waits;
//   - a failure whose words say the REQUEST is too large (the provider's own
//     window or per-minute ceiling is below this page's prompt) can never pass
//     at this size: the page is filed as its summary, with no probe, no record,
//     and never an outage. This is checked before the outage words, because a
//     per-minute "request too large" also carries rate_limit_exceeded;
//   - a page that stopped a run as an outage, whatever the cause, is noted as
//     THROTTLED: the next run takes it after every other page, so a page that
//     fails as an outage every time (a rate limit on its size, a probe the model
//     is too slow to answer while this page is in flight) can never hold up the
//     pages behind it. A noted page that stops a run AGAIN after the model
//     answered another call in that run has shown the failure is its own: it is
//     filed as its summary ("stopped-twice"). A noted page alone in its run
//     cannot show that, so it waits and stops that run with the notice. The
//     accepted downgrade: a noted page reached just as a real outage begins,
//     after other pages folded, is filed too;
//   - the person's cancel ends the page as waiting, never as a failure.
// Records are held in memory and written ONCE when the loop ends, whatever the
// ending: ready, cancelled, or stopped for an outage. A crash writes nothing.

import type { FoldUnreadableClass } from "./absorb-ops.js";

/** Why a page was filed as its summary. Records written before each op was decided alone may also say "refused-twice". */
export type SummaryReason = "unreadable-twice" | "nothing-usable" | "oversize" | "too-large" | "apply-threw" | "failed-twice" | "stopped-twice";
export type WaitingReason = "first-failure" | "filing-threw";
export type OutageClass = "rate-limit" | "quota" | "too-many-requests" | "overload";
export type PageFailureCode = "timed-out" | "provider-error" | "worker-failed";

/** What a room's pages carry between runs: failure records, and throttle notes. Keys only, dates and codes; no room text. */
export interface PageFailureState {
	records: Map<string, PageFailureRecord>;
	/** Pages that stopped a run as an outage: they go last next run. */
	throttled: Map<string, { at: string }>;
}

/** The failure record a page carries between runs. No room text. */
export interface PageFailureRecord {
	at: string;
	provider: string;
	model: string;
	code: PageFailureCode;
}

export type PageEnding =
	| { kind: "folded" }
	| { kind: "dropped" }
	| { kind: "summarized"; reason: SummaryReason }
	| { kind: "waiting"; reason: WaitingReason }
	/** The page whose call failed and whose probe failed too (or whose failure named a rate limit): it waits, unrecorded, and the run stops. */
	| { kind: "outage"; outageClass?: OutageClass }
	/** The person cancelled while this page was in flight: it waits, unrecorded, and the run stops. */
	| { kind: "cancelled" };

/** What one page's model call gave back. */
export interface PageReply {
	text: string;
	truncated?: boolean;
}

/** What the run made of a reply: ops to apply, no op list at all, or a list of which nothing lands. */
export type PageRead =
	| { usable: true; ops: unknown; earlierFence?: true }
	| { usable: false; unreadable: FoldUnreadableClass }
	| { usable: false; nothingLands: true; earlierFence?: true };

/** The second ask of a page, after an unreadable reply. */
export type PageRetryAsk = { kind: "unreadable"; cutOff: boolean };

/** Everything the core knows about one page's life, for the card and the diagnostics. */
export interface PageTrace {
	attempts: number;
	/** The last unreadable class a reply had. */
	unreadable?: FoldUnreadableClass;
	/** Each unreadable reply in order, by its class. */
	unusable?: FoldUnreadableClass[];
	/** A code per reply whose list the reader took from before a last json fence holding an empty list ("earlier-fence"). */
	reader?: "earlier-fence"[];
	probe?: "answered" | "failed";
	outageClass?: OutageClass;
	failureCode?: PageFailureCode;
}

export interface PageDeps<P> {
	/** The page's record key: its checkpoint id, or a hash of a hand-written page's text. */
	key(page: P): string;
	/** True when the fold prompt would not fit the model's window. */
	oversize(page: P): boolean;
	/** One model call for the page. The retry ask, when there is one, changes the prompt. Throws when the call fails. */
	call(page: P, retry: PageRetryAsk | null): Promise<PageReply>;
	read(page: P, reply: PageReply): PageRead;
	/** Applies a usable reply to the working copy; the run restores its copy itself when this throws. */
	apply(page: P, ops: unknown): "folded" | "dropped";
	/** Files the page as its summary. Throws only when the filing itself fails. */
	fileSummary(page: P, reason: SummaryReason): void;
	/** The tiny fixed question. True when the model answered anything. */
	probe(): Promise<boolean>;
	/** Whether a thrown call is worth one more ask (a dropped connection is; a call that ran out its ceiling is not). */
	retryable(error: unknown): boolean;
	/** The provider's own words for a failure, which the outage rule reads. */
	failureMessage(error: unknown): string;
	failureCode(error: unknown): PageFailureCode;
	/** Waits out the pause before a retried call: the short one, or `ms` when the failure named a rate limit or a blip. */
	pause(ms?: number): Promise<void>;
	cancelled(): boolean;
	/** The model the run is on, as a record names it. */
	model: { provider: string; model: string };
	now(): Date;
	onPageStart?(page: P): void;
	onAttempt?(page: P, attempt: number): void;
	onPageEnd?(page: P, ending: PageEnding, trace: PageTrace): void;
	/** Writes the records and throttle notes as they stand at the loop's end. Called once, whatever the ending. */
	flush(state: PageFailureState): void;
}

export interface PagesOutcome {
	stoppedForOutage: boolean;
	cancelled: boolean;
	/** The model's rate-limit class that stopped the run, when that was the reason. */
	outageClass?: OutageClass;
}

/**
 * The outage rule for a failure's own words: a rate limit, a quota, too many
 * requests or an overload is the provider refusing the RUN, not this page,
 * whatever the tiny probe says (a tokens-per-minute 429 fails a large page and
 * passes a small probe). Whole words and codes only: "4290" in a token count
 * is not a 429.
 */
export function outageClassOf(message: string): OutageClass | undefined {
	// "RateLimitError" (LiteLLM, the gateway's class name), "ThrottlingException"
	// (Bedrock) and "Request was throttled" (Azure) are rate limits too.
	if (/\brate[ _-]?limit\w*|\bthrottl\w*/i.test(message)) return "rate-limit";
	if (/\b(?:insufficient_)?quota(?:_[a-z]+)?\b|\bresource[ _]exhausted\b/i.test(message)) return "quota";
	if (/\b429\b|\btoo[ _]many[ _]requests\b/i.test(message)) return "too-many-requests";
	if (/\boverload(?:ed)?(?:_error)?\b|\b529\b/i.test(message)) return "overload";
	return undefined;
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
	return /^\s*(?:\w*Error: )?terminated\.?\s*$/i.test(message) || /\bECONN(?:RESET|REFUSED|ABORTED)\b|\bENOTFOUND\b|\bEAI_AGAIN\b|\bEHOSTUNREACH\b|\bUND_ERR_\w+|\bETIMEDOUT\b|\bEPIPE\b|\bsocket hang up\b|\bfetch failed\b|\bother side closed\b|\bpremature close\b|\bnetwork error\b|\bconnection (?:reset|closed|lost|error)\b|\bwebsocket(?: connection)? (?:error|closed)\b/i.test(message);
}

/** The pause before a call that failed on a blip is asked again: long enough for the blip to pass, since the next failure stops the run. */
export const BLIP_PAUSE_MS = 30_000;

/** The long pause before a rate-limited call is asked again: what the provider asks for, within these bounds, else the default. */
export const RATE_LIMIT_PAUSE_MIN_MS = 20_000;
export const RATE_LIMIT_PAUSE_MAX_MS = 60_000;
export const RATE_LIMIT_PAUSE_DEFAULT_MS = 30_000;

/**
 * How long a rate-limited call waits before its one retry. Providers say it in
 * their own words ("Please try again in 12.5s", "retry after 20 seconds",
 * "try again in 1m30s", "Retry-After: 40"); a wait below the floor is raised
 * to it, since most per-minute limits need that long to reset, and one above
 * the ceiling is cut to it, since the run stops anyway if the retry fails.
 */
export function rateLimitPauseMs(message: string): number {
	const clamp = (ms: number) => Math.min(RATE_LIMIT_PAUSE_MAX_MS, Math.max(RATE_LIMIT_PAUSE_MIN_MS, Math.round(ms)));
	const phrase = /\b(?:try again|retry)\s+(?:in|after)\s+(?:(\d+(?:\.\d+)?)\s*m(?:in(?:ute)?s?)?(?![a-z])\s*)?(?:(\d+(?:\.\d+)?)\s*(ms|milliseconds?|s|secs?|seconds?)\b)?/i.exec(message);
	if (phrase && (phrase[1] || phrase[2])) {
		const minutes = Number(phrase[1] ?? 0);
		const rest = Number(phrase[2] ?? 0);
		const restMs = /^m/i.test(phrase[3] ?? "") ? rest : rest * 1000;
		return clamp(minutes * 60_000 + restMs);
	}
	const header = /\bretry[- ]after\s*[:=]\s*(\d+(?:\.\d+)?)\b/i.exec(message);
	if (header) return clamp(Number(header[1]) * 1000);
	return RATE_LIMIT_PAUSE_DEFAULT_MS;
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
		|| /\bexceeds the maximum number of tokens\b/i.test(message)
		|| /\binput is too long\b|\binput tokens? exceeds?\b/i.test(message); // Bedrock, and the Responses API
}

/**
 * The pages in the order a run takes them, each group in its own order: plain
 * pages, then pages carrying a failure record (their second try), then pages
 * that stopped a run as an outage last time. The throttled go LAST so a page
 * that stops every run can neither hold up a plain page nor keep a recorded
 * page from its second try. Among the throttled, the one throttled LONGEST ago
 * goes first: a page that stops a run again has its note renewed and moves to
 * the back, so it cannot hold up one that was throttled once either.
 */
export function pageFoldOrder<P>(pages: readonly P[], group: (page: P) => "plain" | "recorded" | "throttled", throttledAt: (page: P) => string = () => ""): P[] {
	const of = (wanted: string) => pages.filter((page) => group(page) === wanted);
	const throttled = of("throttled").map((page, index) => ({ page, index, at: throttledAt(page) }));
	throttled.sort((a, b) => (a.at === b.at ? a.index - b.index : a.at < b.at ? -1 : 1));
	return [...of("plain"), ...of("recorded"), ...throttled.map((entry) => entry.page)];
}

/** What a run starts from: only the records and notes whose page is still waiting. */
export function prunePageFailureState(state: PageFailureState, waitingKeys: Iterable<string>): PageFailureState {
	const keep = new Set(waitingKeys);
	return {
		records: new Map([...state.records].filter(([key]) => keep.has(key))),
		throttled: new Map([...state.throttled].filter(([key]) => keep.has(key))),
	};
}

/**
 * Folds the pages, in record order, deciding each page's ending by the rules
 * above. `records` are the pruned records the run started from; the ones this
 * run adds are held beside them and everything is flushed once, at the end.
 */
export async function foldPages<P>(pages: readonly P[], state: PageFailureState, deps: PageDeps<P>): Promise<PagesOutcome> {
	const held: PageFailureState = { records: new Map(state.records), throttled: new Map(state.throttled) };
	const outcome: PagesOutcome = { stoppedForOutage: false, cancelled: false };
	const group = (page: P) => (state.records.has(deps.key(page)) ? "recorded" : state.throttled.has(deps.key(page)) ? "throttled" : "plain");
	const run: RunEvidence = { answered: false };
	try {
		for (const page of pageFoldOrder(pages, group, (page) => state.throttled.get(deps.key(page))?.at ?? "")) {
			if (deps.cancelled()) { outcome.cancelled = true; break; }
			deps.onPageStart?.(page);
			const trace: PageTrace = { attempts: 0 };
			const ending = await foldOnePage(page, { held, noted: state.throttled.has(deps.key(page)), run }, deps, trace);
			deps.onPageEnd?.(page, ending, trace);
			if (ending.kind === "cancelled") { outcome.cancelled = true; break; }
			if (ending.kind === "outage") {
				outcome.stoppedForOutage = true;
				if (ending.outageClass) outcome.outageClass = ending.outageClass;
				break;
			}
		}
	} finally {
		deps.flush(held);
	}
	return outcome;
}

/** What the run has seen so far that says the model is answering: a reply to any call, or an answered probe. */
interface RunEvidence {
	answered: boolean;
}

async function foldOnePage<P>(page: P, context: { held: PageFailureState; noted: boolean; run: RunEvidence }, deps: PageDeps<P>, trace: PageTrace): Promise<PageEnding> {
	const { held, run } = context;
	const key = deps.key(page);
	/** Whether the model answered a call of the run before this page; read before this page adds to it. */
	const answeredBefore = run.answered;
	const forget = () => {
		held.records.delete(key);
		held.throttled.delete(key);
	};
	const summarize = (reason: SummaryReason): PageEnding => {
		try {
			deps.fileSummary(page, reason);
		} catch {
			return { kind: "waiting", reason: "filing-threw" };
		}
		forget();
		return { kind: "summarized", reason };
	};
	/**
	 * The run stops here as an outage, and this page goes last next run. A page
	 * that already stopped an earlier run, in a run where the model answered
	 * other calls first, is the cause itself: it is filed as its summary and the
	 * run goes on. The evidence is spent on it: the next noted page needs the
	 * model to answer again first, so when the model really goes down, at most
	 * one noted page is filed at the onset and the next one stops the run.
	 */
	const outage = (outageClass?: OutageClass): PageEnding => {
		if (context.noted && answeredBefore) {
			run.answered = false;
			return summarize("stopped-twice");
		}
		held.throttled.set(key, { at: deps.now().toISOString() });
		return outageClass ? { kind: "outage", outageClass } : { kind: "outage" };
	};
	if (deps.oversize(page)) return summarize("oversize");

	let retry: PageRetryAsk | null = null;
	let retriedAfterThrow = false;
	let askedAgain = false;
	for (;;) {
		trace.attempts += 1;
		deps.onAttempt?.(page, trace.attempts);
		let reply: PageReply;
		try {
			reply = await deps.call(page, retry);
		} catch (error) {
			if (deps.cancelled()) return { kind: "cancelled" };
			const message = deps.failureMessage(error);
			if (requestTooLarge(message)) {
				trace.failureCode = deps.failureCode(error);
				return summarize("too-large");
			}
			const outageClass = outageClassOf(message);
			// One retry after a throw, of the kind the failure asks for: a rate
			// limit, too many requests or an overload waits out the provider's
			// own wait; a quota does not pass by waiting; a blip waits for itself
			// to pass; anything else is asked again after the short pause.
			const waits = outageClass !== undefined && outageClass !== "quota";
			if (!retriedAfterThrow && (waits || (outageClass === undefined && deps.retryable(error)))) {
				retriedAfterThrow = true;
				await deps.pause(waits ? rateLimitPauseMs(message) : blipClassOf(message) ? BLIP_PAUSE_MS : undefined);
				if (deps.cancelled()) return { kind: "cancelled" };
				continue;
			}
			trace.failureCode = deps.failureCode(error);
			if (outageClass) {
				trace.outageClass = outageClass;
				return outage(outageClass);
			}
			const answered = await deps.probe().catch(() => false);
			if (deps.cancelled()) return { kind: "cancelled" };
			trace.probe = answered ? "answered" : "failed";
			if (!answered) return outage();
			run.answered = true;
			// A record counts only on the model that wrote it: another Memory
			// model gets its own first try, and its record replaces the old one.
			// Two hand-written pages with the same text share a key, so the second
			// one's first failure in a run reads the first one's record as its own.
			const prior = held.records.get(key);
			if (prior && prior.provider === deps.model.provider && prior.model === deps.model.model) return summarize("failed-twice");
			held.records.set(key, { at: deps.now().toISOString(), provider: deps.model.provider, model: deps.model.model, code: trace.failureCode });
			return { kind: "waiting", reason: "first-failure" };
		}
		run.answered = true;
		// A reply that lands after the person cancelled is not read: the page
		// waits, unrecorded, and costs the next run one fold.
		if (deps.cancelled()) return { kind: "cancelled" };
		const read = deps.read(page, reply);
		if ("earlierFence" in read && read.earlierFence) (trace.reader ??= []).push("earlier-fence");
		if (read.usable) {
			forget();
			try {
				return { kind: deps.apply(page, read.ops) };
			} catch {
				return summarize("apply-threw");
			}
		}
		if ("nothingLands" in read) return summarize("nothing-usable");
		trace.unreadable = read.unreadable;
		(trace.unusable ??= []).push(read.unreadable);
		if (askedAgain) return summarize("unreadable-twice");
		askedAgain = true;
		retry = { kind: "unreadable", cutOff: read.unreadable === "cut-off" };
	}
}
