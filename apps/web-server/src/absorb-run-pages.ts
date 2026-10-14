// Memorize never gets stuck: the page core.
//
// One Memorize run folds the room's waiting conversations ("pages") one at a
// time. This module owns every decision about how ONE page ends, and the order
// the pages are taken in; the run (absorb-run.ts) owns the prompts, the working
// document and the card, and hands them in as `PageDeps`. The simulation drives
// this same function with fake calls, so the rules it proves are these rules.
//
// How a page ends, all in the run that reads it while the model answers:
//   - a usable reply is applied: folded, or dropped when the model judged it
//     empty;
//   - an unreadable reply, or a readable one of which nothing lands, is asked
//     again ONCE, strictly (one json fence, a few ops, named topics; for
//     nothing landing, a lone drop when nothing is new);
//   - what still does not fold climbs the LADDER (deps.ladder: the page in
//     pieces, then its summary asked as notes), and what is left is filed as
//     one note under a topic (deps.fileSummary: the placement call, then
//     placement by code, which cannot fail). So does a page whose prompt is
//     too large, whose apply threw, or whose call failed while the model
//     answered (the probe said so): that failure is the page's own;
//   - a call that fails gets the one retry the failure earns: a short pause
//     for a dropped connection, a long one (what the provider asks for, 20 to
//     60 seconds) for a rate limit, too many requests or an overload; a quota
//     gets none. A failure that names a rate limit, a quota, too many requests
//     or an overload, or whose probe fails, is an OUTAGE: the run stops, every
//     page left waits, and nothing counts against this page;
//   - a failure whose words say the REQUEST is too large can never pass at
//     this size: it climbs the ladder with no probe, never as an outage. This
//     is checked before the outage words, because a per-minute "request too
//     large" also carries rate_limit_exceeded;
//   - a page that stopped a run as an outage is noted THROTTLED: the next run
//     takes it after every other page, so it can never hold up the pages
//     behind it;
//   - a page in flight when the app restarted carries a "restarted" record,
//     and the next run, on any model, sends it down the ladder without asking
//     for it whole; caught again, it is placed with no fold call;
//   - the person's cancel ends the page as waiting, never as a failure.
// Records and notes are written when each page ends, so a crash keeps them.

import type { FoldUnreadableClass } from "./absorb-ops.js";
import { BLIP_PAUSE_MS, blipClassOf, classifyModelFailure, ModelUnreachableError, outageClassOf, patienceSpent, rateLimitPauseMs, requestTooLarge, type OutageClass, type UnreachableDetail } from "./model-call-causes.js";

/** Why a page climbed the ladder. Older records may also say "refused-twice", "failed-twice" or "stopped-twice". */
export type SummaryReason = "unreadable-twice" | "nothing-usable" | "oversize" | "too-large" | "apply-threw" | "failed" | "refused" | "timed-out" | "restarted" | "restarted-twice" | "filing-threw";
export type WaitingReason = "filing-threw";
export type { OutageClass } from "./model-call-causes.js";
/** "restarted": the page was in flight when the app restarted, which is never a judged failure; "restarted-twice": in its ladder, too; "filing-threw": its filing as one note threw. */
export type PageFailureCode = "timed-out" | "provider-error" | "worker-failed" | "restarted" | "restarted-twice" | "filing-threw";

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
	| { kind: "outage"; outageClass?: OutageClass; unreachable?: UnreachableDetail }
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

/** The second, stricter ask of a page: after an unreadable reply, or one of which nothing landed. */
export type PageRetryAsk = { kind: "unreadable"; cutOff: boolean } | { kind: "nothing-usable" };

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
	/**
	 * Rungs 3 and 4 of the ladder: the page in pieces, then its summary asked
	 * as notes. "folded" when every part of it landed (a part that did not is
	 * filed as one note by the run itself); null when nothing landed. Throws
	 * ModelUnreachableError when the model cannot be reached. Absent: the
	 * page is filed at once.
	 */
	ladder?(page: P, reason: SummaryReason): Promise<"folded" | null>;
	/** Files the page as one note under a topic (rungs 5 and 6). Throws only when the filing itself fails. */
	fileSummary(page: P, reason: SummaryReason): void | Promise<void>;
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
	/** Writes the records and throttle notes as they stand: after every page, and once more at the loop's end. */
	flush(state: PageFailureState): void;
}

export interface PagesOutcome {
	stoppedForOutage: boolean;
	cancelled: boolean;
	/** The model's rate-limit class that stopped the run, when that was the reason. */
	outageClass?: OutageClass;
	/** Why the model could not be reached, when the shared patience said so (signed out, out of quota, no longer offered, still busy, not answering). */
	unreachable?: UnreachableDetail;
}

// The word tests and the pauses live in model-call-causes.ts, the one reading
// of a failed Memory model call that Remember and Review share; the fold loop
// below keeps its own order of reading them.
export { BLIP_PAUSE_MS, blipClassOf, connectionDropped, outageClassOf, RATE_LIMIT_PAUSE_DEFAULT_MS, RATE_LIMIT_PAUSE_MAX_MS, RATE_LIMIT_PAUSE_MIN_MS, rateLimitPauseMs, requestTooLarge } from "./model-call-causes.js";

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
 * above. `state` holds the pruned records and notes the run started from.
 */
export async function foldPages<P>(pages: readonly P[], state: PageFailureState, deps: PageDeps<P>): Promise<PagesOutcome> {
	const held: PageFailureState = { records: new Map(state.records), throttled: new Map(state.throttled) };
	const outcome: PagesOutcome = { stoppedForOutage: false, cancelled: false };
	const group = (page: P) => (state.records.has(deps.key(page)) ? "recorded" : state.throttled.has(deps.key(page)) ? "throttled" : "plain");
	try {
		for (const page of pageFoldOrder(pages, group, (page) => state.throttled.get(deps.key(page))?.at ?? "")) {
			if (deps.cancelled()) { outcome.cancelled = true; break; }
			deps.onPageStart?.(page);
			const trace: PageTrace = { attempts: 0 };
			const ending = await foldOnePage(page, held, deps, trace);
			deps.onPageEnd?.(page, ending, trace);
			// A record is written when the page ends, so a restart mid-run keeps it.
			deps.flush(held);
			if (ending.kind === "cancelled") { outcome.cancelled = true; break; }
			if (ending.kind === "outage") {
				outcome.stoppedForOutage = true;
				if (ending.outageClass) outcome.outageClass = ending.outageClass;
				if (ending.unreachable) outcome.unreachable = ending.unreachable;
				break;
			}
		}
	} finally {
		deps.flush(held);
	}
	return outcome;
}

async function foldOnePage<P>(page: P, held: PageFailureState, deps: PageDeps<P>, trace: PageTrace): Promise<PageEnding> {
	const key = deps.key(page);
	const forget = () => {
		held.records.delete(key);
		held.throttled.delete(key);
	};
	const summarize = async (reason: SummaryReason): Promise<PageEnding> => {
		try {
			await deps.fileSummary(page, reason);
		} catch (error) {
			// The placement call can meet an outage too: the page waits, unfiled.
			if (deps.cancelled()) return { kind: "cancelled" };
			if (error instanceof ModelUnreachableError) return { kind: "outage", unreachable: error.details.detail };
			// Recorded, so the next run places it by code with no call, never the same way again.
			held.records.set(key, { at: deps.now().toISOString(), provider: deps.model.provider, model: deps.model.model, code: "filing-threw" });
			return { kind: "waiting", reason: "filing-threw" };
		}
		forget();
		return { kind: "summarized", reason };
	};
	/** The ladder, then one note under a topic for what is left. Only an outage or a cancel stops it. */
	const climb = async (reason: SummaryReason): Promise<PageEnding> => {
		if (deps.ladder) {
			try {
				if ((await deps.ladder(page, reason)) === "folded") {
					forget();
					return { kind: "folded" };
				}
			} catch (error) {
				if (deps.cancelled()) return { kind: "cancelled" };
				if (error instanceof ModelUnreachableError) return { kind: "outage", unreachable: error.details.detail };
			}
			if (deps.cancelled()) return { kind: "cancelled" };
		}
		return summarize(reason);
	};
	/** The run stops here as an outage, and this page goes last next run. */
	const outage = (outageClass?: OutageClass): Extract<PageEnding, { kind: "outage" }> => {
		held.throttled.set(key, { at: deps.now().toISOString() });
		return outageClass ? { kind: "outage", outageClass } : { kind: "outage" };
	};
	// A page in flight when the app restarted may be what brought it down: it
	// is never asked whole again, on any model; caught a second time, it is
	// placed by code with no call at all. So it cannot loop. A page whose
	// filing threw is placed by code at once too.
	const restarted = held.records.get(key)?.code;
	if (restarted === "restarted-twice" || restarted === "filing-threw") return summarize(restarted);
	if (restarted === "restarted") return climb("restarted");
	if (deps.oversize(page)) return climb("oversize");

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
			// The shared patience already waited out a busy model and found it
			// cannot be reached: the run stops with the one notice. Signed out,
			// out of quota or no longer offered says nothing about this page,
			// so it is neither noted nor recorded; "still busy" is the rate
			// limit it always was here.
			if (error instanceof ModelUnreachableError) {
				trace.failureCode = deps.failureCode(error);
				const detail = error.details.detail;
				if (detail === "still-busy") {
					const busyClass: OutageClass = error.details.busy === "too-many-requests" || error.details.busy === "overload" ? error.details.busy : "rate-limit";
					trace.outageClass = busyClass;
					return { ...outage(busyClass), unreachable: detail };
				}
				return { kind: "outage", unreachable: detail };
			}
			const message = deps.failureMessage(error);
			if (requestTooLarge(message)) {
				trace.failureCode = deps.failureCode(error);
				return climb("too-large");
			}
			const outageClass = outageClassOf(message);
			// One retry after a throw, of the kind the failure asks for: a rate
			// limit, too many requests or an overload waits out the provider's
			// own wait; a quota does not pass by waiting; a blip waits for itself
			// to pass; anything else is asked again after the short pause.
			const waits = outageClass !== undefined && outageClass !== "quota";
			// A failure the shared patience already waited out gets no second wait here.
			if (!retriedAfterThrow && !patienceSpent(error) && (waits || (outageClass === undefined && deps.retryable(error)))) {
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
			const probed = await deps.probe().catch((probeError: unknown) => probeError instanceof ModelUnreachableError ? probeError : false);
			if (deps.cancelled()) return { kind: "cancelled" };
			const answered = probed === true;
			trace.probe = answered ? "answered" : "failed";
			if (probed instanceof ModelUnreachableError) return { kind: "outage", unreachable: probed.details.detail };
			if (!answered) return outage();
			// The model answers, so the failure is this page's own: down the ladder.
			// A call that ran out its time limit is not asked in pieces: each
			// could take as long again.
			return climb(trace.failureCode === "timed-out" ? "timed-out" : classifyModelFailure(error).cause === "refused" ? "refused" : "failed");
		}
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
				return climb("apply-threw");
			}
		}
		if ("nothingLands" in read) {
			if (askedAgain) return climb("nothing-usable");
			askedAgain = true;
			retry = { kind: "nothing-usable" };
			continue;
		}
		trace.unreadable = read.unreadable;
		(trace.unusable ??= []).push(read.unreadable);
		if (askedAgain) return climb("unreadable-twice");
		askedAgain = true;
		retry = { kind: "unreadable", cutOff: read.unreadable === "cut-off" };
	}
}
