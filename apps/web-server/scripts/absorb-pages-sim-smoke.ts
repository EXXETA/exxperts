export {};

// Memorize never gets stuck: the simulation. The REAL page core (foldPages,
// the outage rule, the order, the records) is driven with fake model calls,
// fake probes and a fake room, across the fault mixes the design names and
// at scale. Nothing here decides how a page ends: the fakes only say what the
// model did, and the core decides.
//
// SIM_PAGES sets the scale run's page count (default 3,000; S6 uses 100,000).

const { BLIP_PAUSE_MS, blipClassOf, foldPages, outageClassOf, pageFoldOrder, prunePageFailureState, rateLimitPauseMs, requestTooLarge, RATE_LIMIT_PAUSE_DEFAULT_MS, RATE_LIMIT_PAUSE_MAX_MS, RATE_LIMIT_PAUSE_MIN_MS } = await import("../src/absorb-run-pages.js");
const { fileSessionAsSummary } = await import("../src/absorb-summary.js");
const { parseMemoryDocument } = await import("../src/memory-entries.js");
import type { PageDeps, PageEnding, PageFailureState, PageRead, PageReply, PageRetryAsk, PageTrace } from "../src/absorb-run-pages.js";

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) {
		console.error(`FAIL: ${message}`);
		process.exit(1);
	}
}

// --- The fake world ------------------------------------------------------------

type Kind =
	| "healthy" | "drop" | "sticky-throw" | "sticky-timeout" | "unreadable" | "unreadable-once" | "cutoff"
	/** A readable reply of which nothing lands (only traced ops): filed at once, with no second ask. */
	| "nothing-lands" | "unreadable-then-nothing" | "apply-throw" | "flaky-429" | "tpm-429" | "flaky-drop" | "too-large"
	/** Every call is rate-limited: its size against a per-minute limit. */
	| "sticky-429"
	/** Every call fails, and the probe asked while this page is in flight times out: a model too slow for it. */
	| "sticky-slow-probe"
	| "quota" | "oversize" | "filing-throws";

interface Page { id: string; kind: Kind; born: number }

class CallError extends Error {
	constructor(message: string, readonly retryable: boolean, readonly timedOut = false) { super(message); }
}

const REACHABLE = { provider: "sim", model: "sim-model" };

/** Everything that survives between runs: the waiting pages and the sidecar. */
interface Room {
	waiting: Page[];
	store: PageFailureState;
	notes: number;
	/** How every page left Recent Context. */
	left: Map<string, "folded" | "dropped" | "summarized">;
	/** Pages whose content was filed as a summary (the fake filer's own count). */
	filed: Set<string>;
	/** When set, each filing also runs the REAL filer on the page's text, which must never throw. */
	fileReal?: (page: Page) => void;
	/** Pages filed "stopped-twice". */
	stoppedTwice: Set<string>;
}

interface RunOptions {
	/** The model the run is on; a record counts only on its own. */
	model?: { provider: string; model: string };
	/** Cancel while the first pause of the run is waited out. */
	cancelDuringPause?: boolean;
	/** Cancel while the first probe of the run is asked. */
	cancelDuringProbe?: boolean;
	/** The run's own code throws when this page ends (1-based), out of the loop. */
	throwAtPageEnd?: number;
	/** The model is down for global calls in [from, to). Probes during that window fail too. */
	downFrom?: number;
	downTo?: number;
	/** Cancel while the Nth page of the run is in flight (1-based). */
	cancelAtPage?: number;
	/** The process dies while the Nth page of the run is in flight: the run never finishes. */
	crashAtPage?: number;
}

interface RunResult {
	endings: Map<string, PageEnding>;
	order: string[];
	flushes: number;
	outage: boolean;
	crashed: boolean;
	/** Pages the run's calls reached while the model was down. */
	attemptedWhileDown: Set<string>;
	/** The run reached every waiting page: no stop, or the stop came on the last page of its order. */
	complete: boolean;
	/** The model was up for the whole run (no down window), whatever the rate limits did. */
	modelUp: boolean;
	traces: Map<string, PageTrace>;
	/** Per page, the retry ask each call carried. */
	asks: Map<string, Array<PageRetryAsk | null>>;
	/** The pauses the run waited, in order: "short", or the rate-limit wait in ms. */
	pauses: Array<"short" | number>;
	/** The run threw out of its loop (not a crash: the process lives). */
	threw: boolean;
}

let globalCalls = 0;
/** Per page, how many times each run called it; the flaky kinds read it. */
const lifetimeCalls = new Map<string, number>();
const runsSeen = new Map<string, number>();

async function runOnce(room: Room, run: number, opts: RunOptions = {}): Promise<RunResult> {
	const result: RunResult = { endings: new Map(), order: [], flushes: 0, outage: false, crashed: false, attemptedWhileDown: new Set(), complete: false, modelUp: opts.downFrom === undefined, traces: new Map(), asks: new Map(), pauses: [], threw: false };
	let inFlight: Page | undefined;
	let ended = 0;
	const down = () => opts.downFrom !== undefined && globalCalls >= opts.downFrom && globalCalls < (opts.downTo ?? Infinity);
	let started = 0;
	let cancelled = false;
	const waitingAtStart = room.waiting.length;
	let crashed = false;
	const records = prunePageFailureState(room.store, room.waiting.map((page) => page.id));
	const callsThisRun = new Map<string, number>();
	for (const page of room.waiting) runsSeen.set(page.id, (runsSeen.get(page.id) ?? 0) + 1);

	const deps: PageDeps<Page> = {
		key: (page) => page.id,
		oversize: (page) => page.kind === "oversize",
		call: async (page: Page, retry: PageRetryAsk | null): Promise<PageReply> => {
			const asked = result.asks.get(page.id) ?? [];
			asked.push(retry);
			result.asks.set(page.id, asked);
			if (opts.crashAtPage === started) {
				crashed = true;
				return new Promise<PageReply>(() => {}); // the process is gone
			}
			if (opts.cancelAtPage === started) {
				cancelled = true;
				throw new CallError("aborted by the person", false);
			}
			const isDown = down();
			globalCalls += 1;
			const nThisRun = (callsThisRun.get(page.id) ?? 0) + 1;
			callsThisRun.set(page.id, nThisRun);
			const nLife = (lifetimeCalls.get(page.id) ?? 0) + 1;
			lifetimeCalls.set(page.id, nLife);
			if (isDown) {
				result.attemptedWhileDown.add(page.id);
				throw new CallError("fetch failed: ECONNREFUSED", true);
			}
			switch (page.kind) {
				case "sticky-throw": throw new CallError("provider error: the content was filtered", true);
				case "sticky-timeout": throw new CallError("the turn ran out its ceiling", false, true);
				case "flaky-429": if (nLife <= 1) throw new CallError("429 Too Many Requests", true); break;
				case "tpm-429": if ((runsSeen.get(page.id) ?? 0) === 1) throw new CallError("Error: Rate limit reached for tokens per min (TPM): Limit 30000, Requested 41290", true); break;
				case "flaky-drop": if (nThisRun === 1) throw new CallError("terminated", true); break;
				case "too-large": throw new CallError("Request too large for gpt-4o in organization org-sim on tokens per min (TPM): Limit 30000, Requested 41290. rate_limit_exceeded", true);
				case "sticky-429": throw new CallError("litellm.RateLimitError: Rate limit reached for tokens per min. Please try again in 12s.", true);
				case "sticky-slow-probe": throw new CallError("stream stalled", true);
				case "quota": throw new CallError("You exceeded your current quota, please check your plan and billing details. insufficient_quota", true);
				case "unreadable": return { text: "UNREADABLE" };
				case "unreadable-once": if (nThisRun === 1) return { text: "UNREADABLE" }; break;
				case "cutoff": return { text: "CUT", truncated: true };
				case "nothing-lands": return { text: "NOTHING" };
				case "unreadable-then-nothing": return { text: nThisRun === 1 ? "UNREADABLE" : "NOTHING" };
				case "filing-throws": return { text: "NOTHING" };
				default: break;
			}
			return { text: page.kind === "drop" ? "DROP" : "OK" };
		},
		read: (_page, reply): PageRead => {
			if (reply.text === "UNREADABLE") return { usable: false, unreadable: "no-fence" };
			if (reply.text === "CUT") return { usable: false, unreadable: "cut-off" };
			if (reply.text === "NOTHING") return { usable: false, nothingLands: true };
			return { usable: true, ops: reply.text };
		},
		apply: (page, ops) => {
			if (page.kind === "apply-throw") throw new Error("the applier threw");
			if (ops === "DROP") return "dropped";
			room.notes += 1;
			return "folded";
		},
		fileSummary: (page) => {
			if (page.kind === "filing-throws") throw new Error("the filer threw");
			room.fileReal?.(page);
			room.filed.add(page.id);
			room.notes += 1;
		},
		probe: async () => {
			if (opts.cancelDuringProbe) cancelled = true;
			const isDown = down();
			globalCalls += 1;
			return !isDown && inFlight?.kind !== "sticky-slow-probe";
		},
		retryable: (error) => error instanceof CallError && error.retryable,
		failureMessage: (error) => (error as Error).message,
		failureCode: (error) => (error instanceof CallError && error.timedOut ? "timed-out" : "provider-error"),
		pause: async (ms) => {
			result.pauses.push(ms ?? "short");
			if (opts.cancelDuringPause) cancelled = true;
		},
		cancelled: () => cancelled,
		model: opts.model ?? REACHABLE,
		now: () => new Date(Date.UTC(2026, 8, 28, 0, run)),
		onPageStart: (page) => { started += 1; inFlight = page; result.order.push(page.id); },
		onPageEnd: (page, ending, trace) => {
			result.endings.set(page.id, ending);
			if (ending.kind === "summarized" && ending.reason === "stopped-twice") room.stoppedTwice.add(page.id);
			result.traces.set(page.id, { ...trace });
			if (++ended === opts.throwAtPageEnd) throw new Error("the run's own code threw");
		},
		flush: (held) => {
			result.flushes += 1;
			room.store = { records: new Map(held.records), throttled: new Map(held.throttled) };
		},
	};

	const work = foldPages(room.waiting, records, deps);
	if (opts.crashAtPage !== undefined) {
		// A crashed run never settles: give it every chance to, then walk away.
		const settled = await Promise.race([work.then(() => true), new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 20))]);
		if (!settled && crashed) {
			result.crashed = true;
			return result;
		}
	}
	let outcome;
	try {
		outcome = await work;
	} catch {
		result.threw = true;
		return result;
	}
	result.outage = outcome.stoppedForOutage;
	result.complete = !outcome.cancelled && result.order.length === waitingAtStart;
	// The approve: folded, dropped and summarized pages leave Recent Context; the rest wait.
	if (!outcome.cancelled) {
		room.waiting = room.waiting.filter((page) => {
			const ending = result.endings.get(page.id);
			if (ending && (ending.kind === "folded" || ending.kind === "dropped" || ending.kind === "summarized")) {
				room.left.set(page.id, ending.kind);
				return false;
			}
			return true;
		});
	}
	return result;
}

/** The waiting count, read fresh (a literal narrowed by an earlier assert would not be). */
const waitingCount = (room: Room): number => room.waiting.length;

function newRoom(pages: Page[]): Room {
	return { waiting: [...pages], store: { records: new Map(), throttled: new Map() }, notes: 0, left: new Map(), filed: new Set(), stoppedTwice: new Set() };
}

const cloneState = (state: PageFailureState): PageFailureState => ({ records: new Map(state.records), throttled: new Map(state.throttled) });

let serial = 0;
const serialKind = new Map<string, Kind>();
function pages(kind: Kind, count: number, born = 0): Page[] {
	return Array.from({ length: count }, () => {
		const page = { id: `p-${String(++serial).padStart(6, "0")}`, kind, born };
		serialKind.set(page.id, kind);
		return page;
	});
}

/** Pages reached as a real outage began that were filed "stopped-twice": the accepted downgrade, counted. */
let onsetDowngrades = 0;

/** The assertions every mix must meet, checked after each run. */
function checkRun(room: Room, run: RunResult, before: PageFailureState, label: string): void {
	// Records flush once when the loop ends, a throw out of the loop included, and never after a crash.
	assert(run.crashed ? run.flushes === 0 : run.flushes === 1, `${label}: records are written ${run.crashed ? "never after a crash" : "exactly once"}, got ${run.flushes}`);
	// Plain pages first, then recorded pages, then throttled ones.
	const rank = (id: string) => (before.records.has(id) ? 1 : before.throttled.has(id) ? 2 : 0);
	assert(run.order.every((id, i) => i === 0 || rank(run.order[i - 1]) <= rank(id)), `${label}: plain pages go first, recorded next, throttled last (${run.order.map(rank).join("")})`);
	// An outage never records or summarizes a page, and never blames its first page.
	for (const id of run.attemptedWhileDown) {
		const ending = run.endings.get(id);
		// The accepted downgrade: a page that stopped an earlier run, reached just
		// as a real outage begins after the model answered other pages, is filed.
		if (ending?.kind === "summarized" && ending.reason === "stopped-twice" && before.throttled.has(id)) {
			onsetDowngrades += 1;
			continue;
		}
		assert(!ending || ending.kind === "outage" || ending.kind === "cancelled", `${label}: a page reached while the model was down ends as the outage, got ${ending?.kind} for ${id}`);
		if (!run.crashed) assert(room.store.records.get(id) === before.records.get(id), `${label}: an outage never records a page (${id})`);
		assert(!room.filed.has(id) || !run.endings.has(id) || run.endings.get(id)!.kind !== "summarized", `${label}: an outage never summarizes a page (${id})`);
	}
	// No content lost: a page leaves only as notes or a lone drop, and a summary was filed.
	for (const [id, how] of room.left) if (how === "summarized") assert(room.filed.has(id), `${label}: a summarized page's content was filed (${id})`);
}

async function scenario(label: string, room: Room, runs: RunOptions[], opts: { arrivals?: () => Page[]; reachableEnds?: boolean } = {}): Promise<Room> {
	for (let r = 0; r < runs.length; r++) {
		const before = cloneState(room.store);
		const result = await runOnce(room, r, runs[r]);
		checkRun(room, result, before, `${label}, run ${r + 1}`);
		if (opts.arrivals) room.waiting.push(...opts.arrivals());
	}
	return room;
}

// --- 1. The pure rules ------------------------------------------------------------
{
	assert(outageClassOf("429 Too Many Requests") === "too-many-requests", "a 429 is an outage");
	assert(outageClassOf("Requested 4290 tokens") === undefined, "a 4290 inside a token count is not a 429");
	assert(outageClassOf("error 14290") === undefined && outageClassOf("code=429;") === "too-many-requests", "429 is matched as a whole code");
	assert(outageClassOf("Rate limit reached for tokens per min") === "rate-limit" && outageClassOf("rate_limit_exceeded") === "rate-limit" && outageClassOf("you are being rate-limited") === "rate-limit", "a rate limit is an outage in its spellings");
	assert(outageClassOf("You exceeded your current quota") === "quota" && outageClassOf("insufficient_quota") === "quota" && outageClassOf("RESOURCE_EXHAUSTED") === "quota", "a quota is an outage");
	assert(outageClassOf("overloaded_error: Overloaded") === "overload" && outageClassOf("HTTP 529") === "overload", "an overload is an outage");
	for (const message of ["litellm.RateLimitError: litellm.RateLimitError: AzureException - Requests to the ChatCompletions_Create Operation have exceeded", "RateLimitError", "ThrottlingException: Too many tokens, please wait before trying again.", "Request was throttled. Please retry after 20 seconds."]) assert(outageClassOf(message) === "rate-limit", `the gateway's own spellings are rate limits: ${message.slice(0, 40)}`);
	assert(rateLimitPauseMs("429 Too Many Requests") === RATE_LIMIT_PAUSE_DEFAULT_MS && RATE_LIMIT_PAUSE_DEFAULT_MS === 30_000, "a rate limit that names no wait waits 30 seconds");
	assert(rateLimitPauseMs("Rate limit reached. Please try again in 45s.") === 45_000 && rateLimitPauseMs("Please try again in 37.5 seconds") === 37_500, "the provider's own wait is honoured");
	assert(rateLimitPauseMs("try again in 1.2s") === RATE_LIMIT_PAUSE_MIN_MS && rateLimitPauseMs("try again in 820ms") === RATE_LIMIT_PAUSE_MIN_MS && RATE_LIMIT_PAUSE_MIN_MS === 20_000, "a wait below 20 seconds is raised to it");
	assert(rateLimitPauseMs("try again in 5m0s") === RATE_LIMIT_PAUSE_MAX_MS && rateLimitPauseMs("Request was throttled. Please retry after 90 seconds.") === RATE_LIMIT_PAUSE_MAX_MS && RATE_LIMIT_PAUSE_MAX_MS === 60_000, "a wait above 60 seconds is cut to it");
	assert(rateLimitPauseMs("try again in 1m30s") === RATE_LIMIT_PAUSE_MAX_MS && rateLimitPauseMs("Retry-After: 25") === 25_000 && rateLimitPauseMs("try again in a moment") === RATE_LIMIT_PAUSE_DEFAULT_MS, "minutes, the header and a vague wait are read");
	assert(outageClassOf("the content was filtered") === undefined && outageClassOf("terminated") === undefined && outageClassOf("the model overloads nothing") === undefined, "anything else is not");
	// A blip: the provider's own side failed, or the connection went. Its one retry waits for it to pass.
	const SERVICE_UNAVAILABLE = 'Codex error: {"type":"error","error":{"type":"service_unavailable_error","code":null,"message":"Unable to verify model access right now. Please retry.","param":null},"sequence_number":2}';
	const SERVER_ERROR = 'Codex error: {"type":"error","error":{"type":"server_error","code":"server_error","message":"An error occurred while processing your request. You can retry your request.","param":null}}';
	for (const message of [SERVICE_UNAVAILABLE, SERVER_ERROR, "500 Internal Server Error", "502 Bad Gateway", "504 Gateway Timeout", "HTTP 503", "Request failed with status code 502", "statusCode: 503", "api_error: Internal server error", "500 synthetic upstream failure", "500 status code (no body)", "503 upstream connect error"]) assert(blipClassOf(message) === "server-error", `a server error is a blip: ${message}`);
	for (const message of ["WebSocket error", "websocket connection closed", "read ECONNRESET", "terminated", "fetch failed"]) assert(blipClassOf(message) === "connection", `a dropped connection is a blip: ${message}`);
	for (const message of ["the content was filtered", "400 invalid_request_error: The response was filtered due to the prompt triggering content management policy", "Requested 5030 tokens, max 500 tokens", "error 5030", "Output terminated at max_tokens", "429 Too Many Requests"]) assert(blipClassOf(message) === undefined, `not a blip: ${message}`);
	assert(BLIP_PAUSE_MS === 30_000, "a blip's retry waits 30 seconds");
	const order = pageFoldOrder(["a", "b", "c", "d", "e"], (page) => (page === "a" || page === "c" ? "throttled" : page === "d" ? "recorded" : "plain"));
	assert(order.join("") === "bedac", `plain pages first, then recorded, then throttled, each group in its order (${order.join("")})`);
	const recent = pageFoldOrder(["a", "b", "c"], () => "throttled", (page) => ({ a: "2026-09-01", b: "2026-09-03", c: "2026-09-02" })[page]!);
	assert(recent.join("") === "acb", `the page throttled longest ago goes first among the throttled (${recent.join("")})`);
	const record = { at: "", provider: "", model: "", code: "provider-error" as const };
	const pruned = prunePageFailureState({ records: new Map([["a", record], ["gone", record]]), throttled: new Map([["b", { at: "" }], ["gone-too", { at: "" }]]) }, ["a", "b"]);
	assert(pruned.records.has("a") && !pruned.records.has("gone") && pruned.throttled.has("b") && !pruned.throttled.has("gone-too"), "records and throttle notes whose page left Recent Context are pruned");
	for (const message of [
		"Request too large for gpt-4o in organization org-x on tokens per min (TPM): Limit 30000, Requested 41290. Visit https://platform.openai.com/account/rate-limits to learn more. rate_limit_exceeded",
		"This model's maximum context length is 128000 tokens. However, your messages resulted in 130000 tokens.",
		"context_length_exceeded",
		"prompt is too long: 210000 tokens > 200000 maximum",
		"413 Request Entity Too Large",
		"request_too_large",
		"litellm.ContextWindowExceededError: litellm.BadRequestError: ...",
		"The input exceeds the maximum number of tokens allowed",
		"ValidationException: Input is too long for requested model.",
		"Your input tokens exceed the configured limit of 272000 tokens.",
	]) assert(requestTooLarge(message), `a request too large is read as such: ${message.slice(0, 50)}`);
	for (const message of ["429 Too Many Requests", "Rate limit reached for tokens per min (TPM): Limit 30000, Used 29000, Requested 2000", "the prompt was long", "413", "max_tokens is too large: 16000. This model supports at most 4096 completion tokens, whereas you provided 16000.", "max_tokens: 16000 > 8192, which is the maximum allowed number of output tokens for this model"]) assert(!requestTooLarge(message), `and nothing else is, the output cap against a smaller model included: ${message.slice(0, 50)}`);
	console.log("1. rules: the outage patterns, the rate-limit wait, the order and the pruning");
}

// --- 2. The fault mixes -------------------------------------------------------------
{
	// Two and five sticky poison pages at the head, healthy pages behind.
	for (const poison of [2, 5]) {
		const room = newRoom([...pages("sticky-throw", poison), ...pages("healthy", 8)]);
		await scenario(`${poison} poison pages at the head`, room, [{}, {}]);
		assert(waitingCount(room) === 0, `${poison} poison pages: every page ends within two runs, ${room.waiting.length} still wait`);
		assert([...room.left.values()].filter((how) => how === "summarized").length === poison, `${poison} poison pages: exactly the poison pages are summarized`);
	}
	// A lone sticky page, a sticky timeout, unreadable and cut-off replies, a reply of which nothing lands, and an apply throw.
	for (const kind of ["sticky-throw", "sticky-timeout"] as Kind[]) {
		const room = newRoom(pages(kind, 1));
		await scenario(`a lone ${kind} page`, room, [{}]);
		assert(waitingCount(room) === 1 && room.store.records.size === 1, `a lone ${kind} page waits with a record after its first run`);
		await scenario(`a lone ${kind} page`, room, [{}]);
		assert(waitingCount(room) === 0 && room.left.values().next().value === "summarized" && (room.store.records.size as number) === 0, `and is summarized in its second, its record gone`);
	}
	{
		const room = newRoom([...pages("unreadable", 1), ...pages("cutoff", 1), ...pages("nothing-lands", 1), ...pages("apply-throw", 1), ...pages("unreadable-once", 1), ...pages("drop", 1), ...pages("flaky-drop", 1)]);
		const result = await runOnce(room, 0);
		assert(waitingCount(room) === 0, `content failures all end in the same run, ${room.waiting.length} wait`);
		const endingsByKind = new Map([...result.endings].map(([id, ending]) => [serialKind.get(id), ending]));
		const expect: Array<[Kind, string]> = [["unreadable", "summarized:unreadable-twice"], ["cutoff", "summarized:unreadable-twice"], ["nothing-lands", "summarized:nothing-usable"], ["apply-throw", "summarized:apply-threw"], ["unreadable-once", "folded"], ["drop", "dropped"], ["flaky-drop", "folded"]];
		for (const [kind, wanted] of expect) {
			const ending = endingsByKind.get(kind)!;
			const got = ending.kind === "summarized" ? `summarized:${ending.reason}` : ending.kind;
			assert(got === wanted, `${kind} ends ${wanted}, got ${got}`);
		}
		assert(room.store.records.size === 0, "content failures never leave a record");
	}
	// A real outage mid-run: the page it hits is not blamed, the rest wait, nothing is recorded.
	{
		const room = newRoom(pages("healthy", 10));
		globalCalls = 0;
		const result = await runOnce(room, 0, { downFrom: 4, downTo: 1_000 });
		checkRun(room, result, newRoom([]).store, "outage mid-run");
		assert(result.outage && waitingCount(room) === 6 && room.store.records.size === 0, `an outage stops the run: 4 fold, 6 wait, none recorded (${room.waiting.length} wait, ${room.store.records.size} recorded)`);
		const hit = result.order[4];
		assert(result.endings.get(hit)?.kind === "outage" && room.waiting.some((page) => page.id === hit), "the first page of the outage waits, unblamed");
		// A lone page in an outage run is not summarized either, however many outage runs pass.
		const lone = newRoom(pages("healthy", 1));
		for (let r = 0; r < 3; r++) {
			globalCalls = 0;
			const outageRun = await runOnce(lone, r, { downFrom: 0, downTo: 1_000 });
			checkRun(lone, outageRun, newRoom([]).store, `a lone page in outage run ${r + 1}`);
		}
		assert(waitingCount(lone) === 1 && lone.store.records.size === 0 && lone.filed.size === 0, "a lone page through three outage runs waits, unrecorded and unfiled");
		globalCalls = 0;
		await runOnce(room, 1, {});
		assert(waitingCount(room) === 0, "the model back, every waiting page folds");
	}
	// A flaky 429 waits out one long pause and folds in the same run.
	{
		const room = newRoom([...pages("healthy", 3), ...pages("flaky-429", 1), ...pages("healthy", 3)]);
		const result = await runOnce(room, 0);
		checkRun(room, result, newRoom([]).store, "flaky 429");
		assert(!result.outage && waitingCount(room) === 0 && room.filed.size === 0 && room.store.throttled.size === 0, "a flaky 429 folds in the same run, after its pause");
		assert(result.pauses.length === 1 && result.pauses[0] === RATE_LIMIT_PAUSE_DEFAULT_MS, `the pause is the long one, got ${JSON.stringify(result.pauses)}`);
	}
	// A tokens-per-minute 429 through its pause and retry: an outage, never a record; the next run folds it last.
	{
		const room = newRoom([...pages("healthy", 3), ...pages("tpm-429", 1), ...pages("healthy", 3)]);
		globalCalls = 0;
		const first = await runOnce(room, 0);
		checkRun(room, first, newRoom([]).store, "tpm-429");
		assert(first.outage && room.store.records.size === 0 && room.filed.size === 0 && room.store.throttled.size === 1, "tpm-429: the run stops as an outage, records nothing and notes the page");
		assert(waitingCount(room) === 4 && first.pauses.length === 1, `tpm-429: the pages before it fold, it and those behind wait, after one pause (${room.waiting.length}, ${first.pauses.length})`);
		const before = cloneState(room.store);
		const second = await runOnce(room, 1);
		checkRun(room, second, before, "tpm-429, run 2");
		assert(waitingCount(room) === 0 && room.filed.size === 0 && second.order[second.order.length - 1] === [...before.throttled.keys()][0], "tpm-429: the next run folds them all, the noted page last, none as a summary");
	}
	// A quota does not pass by waiting: it stops at once, with no pause.
	{
		const room = newRoom([...pages("quota", 1), ...pages("healthy", 2)]);
		const result = await runOnce(room, 0);
		checkRun(room, result, newRoom([]).store, "quota");
		assert(result.outage && result.pauses.length === 0 && result.traces.get(result.order[0])?.outageClass === "quota", `a quota stops the run at once, got ${JSON.stringify(result.pauses)}`);
	}
	// A page the provider says is too large is kept as its summary at once: no probe, no record, no outage.
	{
		const room = newRoom([...pages("too-large", 1), ...pages("healthy", 3)]);
		globalCalls = 0;
		const result = await runOnce(room, 0);
		checkRun(room, result, newRoom([]).store, "too large");
		const ending = [...result.endings.values()][0];
		assert(!result.outage && ending.kind === "summarized" && ending.reason === "too-large" && waitingCount(room) === 0 && room.store.records.size === 0 && room.store.throttled.size === 0, `a too-large page is summarized in its first run, got ${JSON.stringify(ending)}`);
	}
	// A page that stops every run as an outage (a rate limit on its size, a probe
	// the model is too slow to answer while it is in flight): the next run takes it
	// last, and when it stops that run too after other pages folded, it is filed.
	for (const kind of ["sticky-429", "sticky-slow-probe"] as Kind[]) {
		const room = newRoom([...pages(kind, 1), ...pages("sticky-throw", 1), ...pages("healthy", 4)]);
		const stubborn = room.waiting[0].id;
		let before = cloneState(room.store);
		const first = await runOnce(room, 0);
		checkRun(room, first, before, `${kind}, run 1`);
		assert(first.outage && first.order.length === 1 && room.store.throttled.has(stubborn) && !room.store.records.has(stubborn), `${kind}: the first run stops at it, noted, unrecorded`);
		assert(kind === "sticky-429" ? first.pauses.length === 1 && first.pauses[0] === 20_000 : first.traces.get(stubborn)?.probe === "failed", `${kind}: ${kind === "sticky-429" ? "its 'try again in 12s' is waited as 20 seconds" : "its probe failed"}`);
		before = cloneState(room.store);
		const second = await runOnce(room, 1);
		checkRun(room, second, before, `${kind}, run 2`);
		const ending = second.endings.get(stubborn);
		assert(second.order[second.order.length - 1] === stubborn && ending?.kind === "summarized" && ending.reason === "stopped-twice", `${kind}: the second run takes it last and files it, got ${JSON.stringify(ending)} in ${second.order.join(",")}`);
		assert(!second.outage && room.store.throttled.size === 0 && waitingCount(room) === 1, `${kind}: the run goes on, the note is gone, only the recorded page waits (${room.waiting.length})`);
		await scenario(`${kind}, run 3`, room, [{}]);
		assert(waitingCount(room) === 0 && [...room.left.values()].filter((how) => how === "summarized").length === 2, `${kind}: the sticky page behind it gets its second try and every page has ended`);
	}
	// The model dies after a page folds, with three noted pages behind: the
	// evidence is spent on the first, so exactly one is filed at the onset and
	// the next one stops the run; the third waits with its note.
	{
		const room = newRoom([...pages("healthy", 1), ...pages("healthy", 3)]);
		const [p1, t1, t2, t3] = room.waiting.map((page) => page.id);
		room.store.throttled = new Map([[t1, { at: "2026-09-01T00:00:00.000Z" }], [t2, { at: "2026-09-02T00:00:00.000Z" }], [t3, { at: "2026-09-03T00:00:00.000Z" }]]);
		const before = cloneState(room.store);
		globalCalls = 0;
		const result = await runOnce(room, 0, { downFrom: 1, downTo: 1_000 });
		checkRun(room, result, before, "the model dies before three noted pages");
		const endings = [t1, t2, t3].map((id) => result.endings.get(id)?.kind ?? "unreached");
		assert(result.endings.get(p1)?.kind === "folded" && JSON.stringify(endings) === JSON.stringify(["summarized", "outage", "unreached"]) && result.outage, `one noted page is filed at the onset and the next stops the run, got ${JSON.stringify(endings)}`);
		assert(room.store.throttled.get(t2)?.at !== before.throttled.get(t2)?.at && room.store.throttled.get(t3)?.at === before.throttled.get(t3)?.at, "the page that stopped the run renews its note, the one behind keeps its own");
	}
	// A noted page alone in its run cannot show the failure is its own: it waits, and renews its note.
	{
		const room = newRoom(pages("sticky-429", 1));
		const lone = room.waiting[0].id;
		for (let r = 0; r < 3; r++) {
			const before = cloneState(room.store);
			const result = await runOnce(room, r);
			checkRun(room, result, before, `a lone sticky-429 page, run ${r + 1}`);
			assert(result.outage && result.endings.get(lone)?.kind === "outage" && room.store.throttled.get(lone)?.at === new Date(Date.UTC(2026, 8, 28, 0, r)).toISOString(), `alone, it stops each run and its note is renewed (run ${r + 1})`);
		}
		assert(waitingCount(room) === 1 && room.filed.size === 0, "alone, it is never filed");
		room.waiting.push(...pages("healthy", 1));
		const before = cloneState(room.store);
		const result = await runOnce(room, 3);
		checkRun(room, result, before, "a lone sticky-429 page, with company");
		assert(waitingCount(room) === 0 && result.endings.get(lone)?.kind === "summarized", "once another page folds first in its run, it is filed");
	}
	// A record counts only on the model that wrote it.
	{
		const room = newRoom(pages("sticky-throw", 1));
		const id = room.waiting[0].id;
		await scenario("a record on model A", room, [{}]);
		assert(room.store.records.get(id)?.model === "sim-model", "the first failure is recorded with its model");
		const other = { provider: "sim", model: "other-model" };
		const before = cloneState(room.store);
		const result = await runOnce(room, 1, { model: other });
		checkRun(room, result, before, "the same page on model B");
		assert(result.endings.get(id)?.kind === "waiting" && room.store.records.get(id)?.model === "other-model", `another model gets its own first try, and its record replaces the old one, got ${JSON.stringify(result.endings.get(id))}`);
		await runOnce(room, 2, { model: other });
		assert(waitingCount(room) === 0 && room.left.get(id) === "summarized", "and its own second failure files the page");
	}
	// Oversize, a filer that throws, the retry asks, and a trace that keeps both replies.
	{
		const room = newRoom([...pages("oversize", 1), ...pages("filing-throws", 1), ...pages("cutoff", 1), ...pages("unreadable", 1), ...pages("nothing-lands", 1), ...pages("unreadable-then-nothing", 1), ...pages("sticky-throw", 1)]);
		const [oversize, filingThrows, cutoff, unreadable, nothing, mixed, sticky] = room.waiting.map((page) => page.id);
		const result = await runOnce(room, 0);
		checkRun(room, result, newRoom([]).store, "oversize, filing and asks");
		const reasonOf = (id: string) => { const ending = result.endings.get(id)!; return "reason" in ending ? `${ending.kind}:${ending.reason}` : ending.kind; };
		assert(reasonOf(oversize) === "summarized:oversize" && !result.asks.has(oversize), "an oversize page is filed without a call");
		assert(reasonOf(filingThrows) === "waiting:filing-threw" && !room.store.records.has(filingThrows) && room.waiting.some((page) => page.id === filingThrows), "a filing that throws leaves the page waiting, unrecorded");
		assert(JSON.stringify(result.asks.get(cutoff)) === JSON.stringify([null, { kind: "unreadable", cutOff: true }]), `a cut-off reply is asked again with the cut-off line, got ${JSON.stringify(result.asks.get(cutoff))}`);
		assert(JSON.stringify(result.asks.get(unreadable)) === JSON.stringify([null, { kind: "unreadable", cutOff: false }]), "an unreadable reply is asked again with the unreadable line");
		assert(JSON.stringify(result.asks.get(nothing)) === JSON.stringify([null]) && reasonOf(nothing) === "summarized:nothing-usable", `a reply of which nothing lands is filed at once, never asked again, got ${JSON.stringify(result.asks.get(nothing))}`);
		assert(reasonOf(mixed) === "summarized:nothing-usable" && JSON.stringify(result.traces.get(mixed)?.unusable) === JSON.stringify(["no-fence"]) && result.traces.get(mixed)?.attempts === 2, `the trace keeps the unreadable reply's class before the one of which nothing landed, got ${JSON.stringify(result.traces.get(mixed))}`);
		const stickyTrace = result.traces.get(sticky)!;
		assert(stickyTrace.attempts === 2 && stickyTrace.probe === "answered" && stickyTrace.failureCode === "provider-error" && JSON.stringify(result.pauses.filter((pause) => pause === "short")) === JSON.stringify(["short"]), `a thrown page's trace holds its attempts, its probe and its code, after one short pause, got ${JSON.stringify(stickyTrace)} ${JSON.stringify(result.pauses)}`);
	}
	// Cancel while a pause or a probe is waited out: the page waits, unrecorded and un-noted.
	for (const when of ["pause", "probe"] as const) {
		const room = newRoom([...pages(when === "pause" ? "sticky-429" : "sticky-throw", 1), ...pages("healthy", 2)]);
		const id = room.waiting[0].id;
		const result = await runOnce(room, 0, when === "pause" ? { cancelDuringPause: true } : { cancelDuringProbe: true });
		checkRun(room, result, newRoom([]).store, `cancel during the ${when}`);
		assert(result.endings.get(id)?.kind === "cancelled" && room.store.records.size === 0 && room.store.throttled.size === 0 && waitingCount(room) === 3, `a cancel during the ${when} is never a failure, got ${JSON.stringify(result.endings.get(id))}`);
	}
	// The run's own code throwing out of the loop is not a crash: the records held so far are written.
	{
		const room = newRoom([...pages("sticky-throw", 1), ...pages("healthy", 2)]);
		const result = await runOnce(room, 0, { throwAtPageEnd: 2 });
		checkRun(room, result, newRoom([]).store, "a throw out of the loop");
		assert(result.threw && result.flushes === 1 && room.store.records.size === 1, "a throw out of the loop still writes the probe-confirmed records it held");
	}
	// Cancel mid-run: the records held so far are written, the page in flight is not blamed.
	{
		const room = newRoom([...pages("sticky-throw", 2), ...pages("healthy", 4)]);
		const result = await runOnce(room, 0, { cancelAtPage: 4 });
		checkRun(room, result, newRoom([]).store, "cancel mid-run");
		assert(result.flushes === 1 && room.store.records.size === 2, `cancel still writes the records held before it (${room.store.records.size})`);
		assert(result.endings.get(result.order[3])?.kind === "cancelled" && !room.store.records.has(result.order[3]), "the page in flight at the cancel is not a failure");
		assert(waitingCount(room) === 6, "a cancelled run saves nothing");
	}
	// A crash before the flush: nothing is written, and the next run simply starts again.
	{
		const room = newRoom([...pages("sticky-throw", 2), ...pages("healthy", 4)]);
		const result = await runOnce(room, 0, { crashAtPage: 4 });
		checkRun(room, result, newRoom([]).store, "crash mid-run");
		assert(result.crashed && result.flushes === 0 && room.store.records.size === 0, "a crash writes no record");
		await scenario("after the crash", room, [{}, {}]);
		assert(waitingCount(room) === 0, "two runs after a crash, every page has ended");
	}
	console.log("2. mixes: poison heads, lone and sticky pages, content failures, outage, 429s and quota, pages that stop every run, records per model, filing, asks, traces, cancel, a throw and a crash");
}

// --- 3. At scale, with pages arriving between runs --------------------------------------
{
	const target = Number(process.env.SIM_PAGES ?? 3_000);
	let seed = 20260928;
	const random = () => {
		seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
		return seed / 2_147_483_648;
	};
	const mix: Array<[Kind, number]> = [["healthy", 0.631], ["drop", 0.05], ["unreadable-once", 0.06], ["flaky-drop", 0.05], ["unreadable", 0.03], ["cutoff", 0.02], ["nothing-lands", 0.03], ["unreadable-then-nothing", 0.005], ["apply-throw", 0.01], ["sticky-throw", 0.03], ["sticky-timeout", 0.02], ["flaky-429", 0.02], ["tpm-429", 0.02], ["too-large", 0.005], ["oversize", 0.005], ["quota", 0.002], ["sticky-429", 0.006], ["sticky-slow-probe", 0.006]];
	const draw = (): Kind => {
		let x = random();
		for (const [kind, weight] of mix) if ((x -= weight) < 0) return kind;
		return "healthy";
	};
	// Every summary also goes through the REAL filer, on a small memory and a
	// page text of one of the shapes a room writes, to show the filing never
	// throws (a throw would leave the page waiting "filing-threw").
	const SHAPES = [
		(id: string) => `### ${id} | OPEN | 2026-09-11 | A title\n\n**Session arc:** Something was settled.\n\n**Body:**\n- A durable point.\n- **must-keep** A line to keep.\n  - its detail\n\n**Parked:**\n- Ask about the renewal\n  still open\n`,
		(id: string) => `### ${id} | OPEN | 2026-09-11 | ### A heading title\n\n**Session arc:** One sentence.\n\n**Body**:\n##\n###\n####### deep\n<!-- a comment -->\n- A point.\n\n**Parked:**\nNone yet\n`,
		(id: string) => `### ${id} | OPEN | 2026-09-11 | Hand written\n\nJust some notes someone typed.\n# not a heading\n\nMore.\n`,
		(id: string) => `### ${id} | OPEN | 2026-09-11 | **must-keep** Empty\n\n**Session arc:** \n\n**Body:**\n\n**Parked:**\nNo open threads\n`,
	];
	const MEMORY = ["<!-- exxeta:l1b schema_version=1 -->", "", "## Deep Memory", "", "<!-- entries: next=10 -->", "", "### Renewals", "", "<!-- e: id=m-0001 kind=fact saved=2026-09-01 -->", "- The contract renews in April.", "", "## Active Items", "", "## Recent Context", ""].join("\n");
	const memory = parseMemoryDocument(MEMORY);
	const room = newRoom([]);
	room.fileReal = (page) => {
		const text = SHAPES[Number(page.id.slice(2)) % SHAPES.length](page.id);
		fileSessionAsSummary(memory, { id: page.id, title: "A title", text }, { savedDate: "2026-09-28", nextEntryNumber: 10 });
	};
	let drained = 0;
	let made = 0;
	let run = 0;
	let maxWaiting = 0;
	let maxAfterReachable = 0;
	let outages = 0;
	const started = Date.now();
	/** Per waiting page, the complete runs (no outage stop) that reached it while the model was up. */
	const reachableRuns = new Map<string, number>();
	while (made < target || room.waiting.length > 0) {
		// Remember's door: a room holds at most 20 waiting conversations. Once the
		// target is made the room keeps being used, with plain conversations, so a
		// noted page left alone at the end gets company and can be filed.
		const arriving = made < target ? Math.min(target - made, 4 + Math.floor(random() * 6), 20 - room.waiting.length) : Math.min(1, 20 - room.waiting.length);
		for (let i = 0; i < arriving; i++) {
			const page = { id: `s-${String(++serial).padStart(7, "0")}`, kind: made < target ? draw() : "healthy" as Kind, born: run };
			serialKind.set(page.id, page.kind);
			room.waiting.push(page);
		}
		if (made < target) made += arriving;
		else drained += arriving;
		maxWaiting = Math.max(maxWaiting, room.waiting.length);
		// Every 25th run the model goes down part-way through, in the plain head;
		// every 25th run from the 13th it goes down as the run reaches its noted
		// tail, where a noted page may be filed at the onset.
		const plainAhead = room.waiting.filter((page) => !room.store.throttled.has(page.id)).length;
		const opts: RunOptions = run % 25 === 24 ? { downFrom: globalCalls + 3, downTo: globalCalls + 3 + 1_000_000 } : run % 25 === 12 ? { downFrom: globalCalls + plainAhead, downTo: globalCalls + plainAhead + 1_000_000 } : {};
		const before = cloneState(room.store);
		const onsetBefore = onsetDowngrades;
		const result = await runOnce(room, run, opts);
		checkRun(room, result, before, `scale run ${run + 1}`);
		assert(onsetDowngrades - onsetBefore <= 1, `scale run ${run + 1}: at most one noted page is filed at an outage onset (${onsetDowngrades - onsetBefore})`);
		if (result.outage) outages += 1;
		// A complete run counts for every page it reached while the model was up,
		// outage window or not: only a page the run tried while the model was down
		// did not get a fair run. An outage stop leaves the run incomplete, so its
		// unreached pages are not counted either.
		if (result.complete) {
			for (const page of room.waiting) {
				if (result.attemptedWhileDown.has(page.id)) continue;
				const seen = (reachableRuns.get(page.id) ?? 0) + 1;
				reachableRuns.set(page.id, seen);
				assert(seen < 2, `scale run ${run + 1}: every page ends within two runs while the model is reachable (${page.id}, a ${page.kind} page, waited through ${seen})`);
			}
		}
		globalCalls += 2_000_000; // any outage window closes with its run
		// Reachable: the model was up AND no rate limit stopped the run early
		// (a rate limit is an outage by design, and an outage leaves pages waiting).
		if (result.modelUp && result.complete) {
			maxAfterReachable = Math.max(maxAfterReachable, room.waiting.length);
			assert(room.waiting.length < 20, `scale run ${run + 1}: Recent Context never reaches 20 waiting pages while the model is reachable (${room.waiting.length})`);
		}
		run += 1;
		assert(run < target * 2, "the scale run terminates");
	}
	const summarized = [...room.left.values()].filter((how) => how === "summarized").length;
	const folded = [...room.left.values()].filter((how) => how === "folded").length;
	const dropped = [...room.left.values()].filter((how) => how === "dropped").length;
	// The drain, for real: a noted page left alone waits, and is filed once a plain page arrives and folds first.
	{
		const [lone] = pages("sticky-429", 1);
		room.waiting.push(lone);
		const alone = await runOnce(room, run++);
		assert(alone.outage && room.waiting.length === 1 && room.store.throttled.has(lone.id), "a sticky page alone at the end waits, noted");
		while (room.waiting.length > 0) {
			room.waiting.push(...pages("healthy", 1));
			drained += 1;
			const before = cloneState(room.store);
			checkRun(room, await runOnce(room, run++), before, "the drain");
			assert(drained < 5, "the drain ends");
		}
		assert(drained === 1 && room.left.get(lone.id) === "summarized", `one plain page is enough to file it (${drained})`);
	}
	const stoppedTwice = [...room.left.keys()].filter((id) => room.stoppedTwice.has(id)).length;
	assert(room.left.size === target + drained + 1, `every page ended (${room.left.size} of ${target}, the lone sticky page and ${drained} plain after them)`);
	assert(room.store.records.size === 0 && room.store.throttled.size === 0, "no record or note outlives its page: 0 throttled for good");
	const seconds = (Date.now() - started) / 1000;
	console.log(`3. scale: ${target} pages (+${drained} plain after them) over ${run} runs (${outages} with an outage), ${folded} folded, ${dropped} dropped, ${summarized} summarized (${stoppedTwice} stopped twice, ${onsetDowngrades} of them at an outage onset), 0 throttled for good, at most ${maxWaiting} waiting before a run and ${maxAfterReachable} after a complete one, ${seconds.toFixed(2)}s`);
}

// --- 4. The sidecar ---------------------------------------------------------------------
{
	const fs = await import("node:fs");
	const os = await import("node:os");
	const path = await import("node:path");
	const { pageFailureKey, pageFailuresPath, readPageFailures, writePageFailures, MEMORIZE_PAGE_FAILURES_FILE } = await import("../src/absorb-page-failures.js");
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "page-failures-"));
	assert(pageFailuresPath(dir).endsWith(MEMORIZE_PAGE_FAILURES_FILE) && MEMORIZE_PAGE_FAILURES_FILE === "memorize-page-failures.json", "the sidecar is memorize-page-failures.json in the room's runtime state");
	assert(readPageFailures(dir).records.size === 0, "no file reads as no records");
	const record = { at: "2026-09-28T10:00:00.000Z", provider: "sim", model: "sim-model", code: "timed-out" as const };
	writePageFailures(dir, { records: new Map([["cp-1", record]]), throttled: new Map([["cp-2", { at: "2026-09-28T10:00:00.000Z" }]]) });
	const back = readPageFailures(dir);
	assert(back.records.size === 1 && JSON.stringify(back.records.get("cp-1")) === JSON.stringify(record) && back.throttled.get("cp-2")?.at === "2026-09-28T10:00:00.000Z", "a record and a throttle note read back as written");
	assert(fs.readdirSync(dir).length === 1, "the atomic write leaves no temporary file");
	const text = fs.readFileSync(pageFailuresPath(dir), "utf8");
	assert(!/text|title|body/i.test(Object.keys(JSON.parse(text).records["cp-1"]).join(" ")), "a record holds no room text");
	fs.writeFileSync(pageFailuresPath(dir), "{ not json");
	assert(readPageFailures(dir).records.size === 0, "an unreadable file reads as no records");
	writePageFailures(dir, { records: new Map(), throttled: new Map() });
	assert(!fs.existsSync(pageFailuresPath(dir)), "no records, no file");
	assert(pageFailureKey({ checkpointId: "cp-9", text: "x" }) === "cp-9" && /^text:[0-9a-f]{16}$/.test(pageFailureKey({ text: "hand written" })) && pageFailureKey({ text: "a" }) !== pageFailureKey({ text: "b" }), "the key is the checkpoint id, or a hash of a hand-written page");
	fs.rmSync(dir, { recursive: true, force: true });
	console.log("4. sidecar: atomic, tolerant, text-free, keyed by checkpoint or text hash");
}

// --- 5. The op layer: every op of a reply decided alone ---------------------------------
// Replies of 1 to 20 ops over a seeded memory (person-pinned notes, a kept note,
// open items, the adds of earlier replies), each op carrying faults keyed by
// the rule they break, several to a reply, at 2, 10 and 30 percent. Each reply
// goes through the page core (at most two calls), the reader, the decision,
// the applier and the file's round trip, and nothing an op said may be lost.
{
	const { applyFoldOps, decideFoldOps, parseFoldOps } = await import("../src/absorb-ops.js");
	const { findStructuralLine, listAreas, renderMemoryDocument, saysMoreThanMustKeep } = await import("../src/memory-entries.js");
	const { noteWordsWithin } = await import("../src/memory-duplicates.js");
	type Doc = ReturnType<typeof parseMemoryDocument>;
	let seed = 20260929;
	const random = () => {
		seed = (seed + 0x6d2b79f5) | 0;
		let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
	const pick = <T,>(list: readonly T[]): T => list[Math.floor(random() * list.length)];
	const PINNED_IDS = ["m-0003", "m-0006"];
	const KEPT_ID = "m-0004";
	const QUOTE = "Please keep the one-page rule pinned; I never want it rewritten.";
	const SESSION = { id: "RC-0007", text: `### RC-0007 | OPEN | 2026-09-08 | Renewal\n\n**Body:**\n- ${QUOTE}\n- The renewal now needs legal sign-off before April.\n` };
	const seedDoc = (): Doc => parseMemoryDocument([
		"<!-- exxeta:l1b schema_version=1 -->", "", "## Chronos", "", "- Persistent agent id: sim", "",
		"## Deep Memory", "", "<!-- entries: next=20 -->", "",
		"### Commercial terms", "",
		"<!-- e: id=m-0001 kind=fact saved=2026-09-01 -->", "- The Nordwind contract renews annually and legal signs before June.", "",
		"<!-- e: id=m-0002 kind=fact saved=2026-09-01 -->", "- The Nordwind maintenance contract renews automatically on 1 June.", "",
		"### Working style", "",
		"<!-- e: id=m-0003 kind=practice saved=2026-09-01 pinned=true -->", "- Send commercial summaries as one page, numbers first.", "",
		// A kept note: a resume pins it in the working copy for its folds.
		"<!-- e: id=m-0004 kind=practice saved=2026-09-01 pinned=true -->", "- Decisions are written down the same day they are taken.", "",
		"### Team", "",
		"<!-- e: id=m-0006 kind=fact saved=2026-09-01 pinned=true -->", "- Anna pays Bert the deposit before the handover.", "",
		"## Active Items", "",
		"<!-- e: id=m-0005 kind=item saved=2026-09-01 status=open -->", "- Close out the billing reconciliation before the renewal.", "",
		"<!-- e: id=m-0007 kind=item saved=2026-09-01 status=open -->", "- Send the draft to legal for the renewal.", "",
		"## Recent Context", "",
	].join("\n"));
	const WORDS = ["amber", "birch", "cedar", "delta", "ember", "fjord", "grove", "heron", "ivory", "jetty", "kiln", "larch", "maple", "north", "orbit", "pilot", "quartz", "river", "slate", "tidal"];
	let tokenCount = 0;
	/** A new text with a word no other text has, so where it went can be read off the file. */
	const newText = () => {
		// Letters only: a digit would read as a value, and every pair of texts as a disagreement.
		let n = ++tokenCount;
		let token = "zq";
		do { token += String.fromCharCode(97 + (n % 26)); n = Math.floor(n / 26); } while (n > 0);
		const [a, b] = [pick(WORDS), pick(WORDS)];
		return { token, text: pick([
			`- The ${a} account ${token} renews through the ${b} channel.`,
			`- ${token} is who signs for ${a} before anything goes to ${b}.`,
			`- Reports for ${a} go out with ${token} attached, never as a ${b} draft.`,
			`- Ask ${token} first when the ${a} team wants a ${b} exception.`,
		]) };
	};
	const HOSTILE = ["## Deep Memory", "### Topic", "<!-- e: id=m-0001 kind=fact saved=2026-01-01 -->", "<!-- rc_metadata: checkpoint_id=cp-1 -->", "<!-- a comment\nthat runs on -->", "# Title", "---"];
	/** The rules a fault breaks, each a change to one op (or the reply). */
	const FAULTS: Record<string, (op: any, doc: Doc) => any> = {
		R06: (op) => ({ ...op, op: pick(["merge", "note", "rewrite"]) }),
		unpin: (op) => ({ op: "unpin", id: pick(PINNED_IDS), because: QUOTE, ...(op.text ? { text: op.text } : {}) }),
		string: (op) => (op.text ? op.text : op),
		R07: (op) => { const { topic: _topic, ...rest } = op; return rest; },
		R08: (op) => ({ ...op, kind: pick(["note", "Fact ", "decision"]) }),
		R09: (op) => ({ ...op, text: pick(["", " ", "###", "---", "- **must-keep**"]) }),
		R10: (op) => { const { id: _id, ...rest } = op; return rest; },
		R19: (op, doc) => ({ ...op, id: pick(listAreas(doc)).id, section: "Deep Memory", ...(op.op === "close" || op.op === "pin" ? { text: newText().text } : {}) }),
		R21: (op) => ({ ...op, topic: `### ${op.topic ?? "Renewals"}` }),
		R22: (op) => ({ ...op, topic: pick(["A", `${"Renewal terms and the people involved ".repeat(3)}`]) }),
		R23: (op) => ({ ...op, topic: pick(["---", "#######", "***"]) }),
		R24: (op) => ({ ...op, topic: pick(["Commercial term", "commercial terms", "The Commercial terms"]) }),
		R25: (op) => ({ ...op, kind: "item" }),
		R26: (op) => ({ ...op, topic: "Active Items", kind: "fact" }),
		R27: (op) => ({ ...op, text: `${op.text ?? newText().text} ${Array.from({ length: 130 }, (_, n) => `word${n}`).join(" ")}` }),
		R28: (op) => ({ ...op, text: (op.text ?? "").replace(/^- /, "") }),
		R29: (op) => ({ ...op, text: `${op.text ?? newText().text}\n${pick(HOSTILE)}` }),
		CRLF: (op) => ({ ...op, text: (op.text ?? newText().text).replace(/\n/g, "\r\n") + "\r\nsecond line" }),
		R34: (op, doc) => ({ ...op, id: pick(["m-9999", `${pick(listAreas(doc)).id} · saved 2026-08-02`]) }),
		R35: (op) => ({ ...op, op: pick(["update", "supersede", "close"]), id: pick(PINNED_IDS), text: op.text ?? newText().text }),
		kept: (op) => ({ ...op, op: pick(["update", "supersede", "close"]), id: KEPT_ID, text: op.text ?? newText().text }),
		R36: (op) => ({ op: "close", id: pick(["m-0001", "m-0003"]), ...(op.text ? { text: op.text } : {}) }),
		R37: (op, doc) => ({ op: "pin", id: pick(listAreas(doc)).id }),
		R38: (op, doc) => ({ op: "pin", id: pick(listAreas(doc)).id, because: pick([`“${QUOTE}”`, "“A sentence nobody said.”"]) }),
		repeat: (_op, doc) => ({ op: "add", topic: "Commercial terms", kind: "fact", text: pick(listAreas(doc)).text }),
		conflict: (_op, doc) => { const text = pick(listAreas(doc)).text; return { op: "add", topic: "Commercial terms", kind: "fact", text: /\d/.test(text) ? text.replace(/\d+/, (n) => String(Number(n) + 1)) : text.replace(/\b(renews|is|are)\b/, "$1 not") }; },
		mustKeep: (op) => ({ ...op, text: `- **must-keep** ${(op.text ?? newText().text).replace(/^- /, "")}` }),
	};
	const baseOp = (doc: Doc): any => {
		const areas = listAreas(doc).filter((area) => area.section !== "Recent Context");
		const open = doc.topics.flatMap((topic) => topic.entries).filter((entry) => entry.kind === "item" && entry.status !== "done");
		const r = random();
		if (r < 0.55) {
			const topic = pick(["Commercial terms", "Working style", "Renewals", "Active Items", "Counterparties"]);
			return { op: "add", topic, kind: topic === "Active Items" ? "item" : pick(["fact", "practice"]), text: newText().text };
		}
		if (r < 0.75) return { op: pick(["update", "supersede"]), id: pick(areas).id, text: newText().text };
		if (r < 0.85 && open.length > 0) return { op: "close", id: pick(open).id };
		if (r < 0.93) return { op: "pin", id: pick(areas).id, because: QUOTE };
		if (r < 0.95) return { op: "drop", reason: "chatter" };
		return FAULTS[pick(["repeat", "conflict"])]({}, doc);
	};
	/** The words an op carries for memory, as the reply wrote them, less a copied metadata line (bookkeeping, which the reader removes). */
	const contentOf = (item: any): string => {
		const raw = typeof item === "string" ? item : Array.isArray(item?.text) ? item.text.join("\n") : typeof item?.text === "string" ? item.text : "";
		const words = raw.replace(/^\s*<!--\s*(?:e\s*:|rc_metadata\b).*-->\s*$/gm, "");
		return saysMoreThanMustKeep(words.replace(/<!--[\s\S]*?-->/g, "")) ? words : "";
	};
	const entriesOf = (doc: Doc) => doc.topics.flatMap((topic) => topic.entries);
	const fateCounts = new Map<string, Map<string, number>>();
	for (const rate of [0.02, 0.1, 0.3]) {
		const counts = new Map<string, number>();
		const codeCounts = new Map<string, number>();
		fateCounts.set(`${rate * 100}%`, counts);
		let replies = 0;
		let opsSeen = 0;
		let faultsPlaced = 0;
		let doc = seedDoc();
		let next = 20;
		for (let conversation = 0; conversation < 600; conversation++) {
			if (conversation % 20 === 0) { doc = seedDoc(); next = 20; }
			const list: any[] = [];
			const size = 1 + Math.floor(random() * 20);
			for (let n = 0; n < size; n++) {
				let op = baseOp(doc);
				// Each op may break a rule, and another on top: several faults in one reply.
				for (let k = 0; k < 2 && random() < rate; k++) { op = FAULTS[pick(Object.keys(FAULTS))](op, doc); faultsPlaced += 1; }
				list.push(op);
				// R33: the same id named twice, a second text on it.
				if (random() < rate / 4 && op.id && (op.op === "update" || op.op === "supersede")) { list.push({ op: pick(["update", "supersede"]), id: op.id, text: newText().text }); faultsPlaced += 1; }
			}
			const reply = `A narrative line.\n\n\`\`\`json\n${JSON.stringify({ ops: list })}\n\`\`\`\n`;
			// The page core: the reply is read, decided and applied in one call, or,
			// once in a while, the first reply is prose and the second the list.
			const areas = listAreas(doc);
			const pinnedBefore = new Map(entriesOf(doc).filter((entry) => entry.pinned || entry.id === KEPT_ID).map((entry) => [entry.id, JSON.stringify([entry.text, entry.kind, entry.pinned, entry.status])]));
			let decided: ReturnType<typeof decideFoldOps> | undefined;
			let applied: ReturnType<typeof applyFoldOps> | undefined;
			let calls = 0;
			const firstUnreadable = random() < rate;
			const deps: PageDeps<string> = {
				key: () => `sim-${conversation}`,
				oversize: () => false,
				call: async () => ({ text: ++calls === 1 && firstUnreadable ? "I have saved this conversation." : reply }),
				read: (_page, got): PageRead => {
					const parsed = parseFoldOps(got.text);
					if (parsed.unreadable) return { usable: false, unreadable: parsed.unreadable };
					decided = decideFoldOps(parsed.items, areas, SESSION, { keptForFolds: new Set([KEPT_ID]) });
					return decided.landed ? { usable: true, ops: decided.ops } : { usable: false, nothingLands: true };
				},
				apply: (_page, ops) => {
					applied = applyFoldOps(doc, ops as any, { sessionId: SESSION.id, savedDate: "2026-09-29", nextEntryNumber: next });
					return applied.record.dropped ? "dropped" : "folded";
				},
				fileSummary: () => {},
				probe: async () => true,
				retryable: () => true,
				failureMessage: (error) => String(error),
				failureCode: () => "provider-error",
				pause: async () => {},
				cancelled: () => false,
				model: REACHABLE,
				now: () => new Date(Date.UTC(2026, 8, 29)),
				flush: () => {},
			};
			let ending: PageEnding | undefined;
			await foldPages([`sim-${conversation}`], { records: new Map(), throttled: new Map() }, { ...deps, onPageEnd: (_page, end) => { ending = end; } });
			replies += 1;
			opsSeen += list.length;
			const label = `rate ${rate * 100}%, reply ${conversation}`;
			assert(calls <= 2, `${label}: at most two calls (${calls})`);
			assert(ending && ending.kind !== "waiting", `${label}: the page ends (${ending?.kind})`);
			assert(ending.kind !== "summarized" || ending.reason === "nothing-usable", `${label}: apply never throws (${ending.kind === "summarized" ? ending.reason : ""})`);
			if (!decided) continue;
			const known = new Set(areas.map((area) => area.id));
			assert(decided.ops.every((op: any) => op.id === undefined || known.has(op.id)), `${label}: no applied op names a missing id`);
			assert(decided.ops.every((op: any) => op.besideOf === undefined || known.has(op.besideOf)), `${label}: a tagged add names a note of memory`);
			const after = applied?.doc ?? doc;
			for (const [id, before] of pinnedBefore) {
				const entry = entriesOf(after).find((e) => e.id === id);
				assert(entry && JSON.stringify([entry.text, entry.kind, entry.pinned, entry.status]) === before, `${label}: pinned and kept notes stay byte for byte (${id})`);
			}
			const texts = entriesOf(after).map((entry) => entry.text);
			for (const decision of decided.decisions) {
				counts.set(decision.fate, (counts.get(decision.fate) ?? 0) + 1);
				for (const value of decision.codes) codeCounts.set(value, (codeCounts.get(value) ?? 0) + 1);
				const said = contentOf(list[decision.index]);
				if (!said) continue;
				const token = /\bzq[a-z]+\b/.exec(said)?.[0];
				if (token && texts.some((text) => new RegExp(`\\b${token}\\b`).test(text))) {
					// Every line after the first is kept as written, or escaped with a backslash when it would change the file's structure.
					const rest = said.replace(/\r\n?/g, "\n").split("\n").slice(1).map((line) => line.trimEnd()).filter((line) => line.trim());
					const holder = texts.filter((text) => new RegExp(`\\b${token}\\b`).test(text)).map((text) => text.split("\n"));
					assert(holder.some((lines) => rest.every((line) => lines.includes(line) || lines.includes(line.replace(/^(\s*)/, "$1\\")))), `${label}: op ${decision.index} kept its later lines, escaped where needed (${JSON.stringify(rest)} in ${JSON.stringify(holder)})`);
					continue;
				}
				if (!token && texts.some((text) => noteWordsWithin(said, text))) continue;
				// Not in the file in its own words: it may only have been left out as what a note already says.
				const why = decision.codes.find((c: string) => c === "subset" || c === "same-in-reply" || c === "foreign-text");
				assert(why, `${label}: op ${decision.index} (${JSON.stringify(list[decision.index]).slice(0, 160)}) lost its content as ${decision.fate}:${decision.codes.join("+")}`);
				assert(texts.some((text) => noteWordsWithin(said, text)), `${label}: op ${decision.index} was left out as ${why}, but no note holds its words in order: ${said.slice(0, 120)}`);
			}
			assert(decided.decisions.every((d: any) => d.fate !== "left-out" || d.codes.some((c: string) => c === "subset" || c === "same-in-reply")), `${label}: every left-out op was a repeat`);
			if (!applied) continue;
			const stored = renderMemoryDocument(applied.doc, "storage");
			const back = parseMemoryDocument(stored);
			assert(renderMemoryDocument(back, "storage") === stored, `${label}: the file's round trip is a fixed point`);
			const adds = decided.ops.filter((op: any) => op.op === "add").length;
			assert(entriesOf(back).length === entriesOf(doc).length + adds && back.topics.length === doc.topics.length + applied.record.newTopics.length, `${label}: the file holds every note, and only the adds are new (${entriesOf(back).length} of ${entriesOf(doc).length} + ${adds})`);
			assert(entriesOf(back).every((entry) => findStructuralLine(entry.text) === null), `${label}: no note carries a line that opens a topic or forges a metadata line`);
			doc = back;
			next = applied.nextEntryNumber;
		}
		const listed = (map: Map<string, number>) => [...map.entries()].sort((a, b) => b[1] - a[1]).map(([key, n]) => `${key} ${n}`).join(", ");
		console.log(`5. ops at ${rate * 100}%: ${replies} replies, ${opsSeen} ops, ${faultsPlaced} faults, 0 lost; fates: ${listed(counts)}; codes: ${listed(codeCounts)}`);
	}
}

// --- 6. Dates decide: facts whose value changes, folded in shuffled order -----------------
// Rooms of three facts, each restated with a new value by four to six dated
// conversations across the year, the pages folded in a shuffled order (as a
// failed page, Try again and throttling produce), each page rewriting the
// fact's note or adding its value, with unrelated adds between. A third of the
// rooms start from notes the upgrade brought, with no day. Every reply goes
// through the reader, the decision and the applier with its page's day.
// Every value of a fact disagrees with every other, so no older text is ever
// a refinement: the older-beside path is not drawn here (absorb-ops-smoke
// covers it), and the section asserts only that it drew tagged adds.
{
	const { applyFoldOps, decideFoldOps, parseFoldOps } = await import("../src/absorb-ops.js");
	const { listAreas, renderMemoryDocument } = await import("../src/memory-entries.js");
	type Doc = ReturnType<typeof parseMemoryDocument>;
	let seed = 20260930;
	const random = () => {
		seed = (seed + 0x6d2b79f5) | 0;
		let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
	const pick = <T,>(list: readonly T[]): T => list[Math.floor(random() * list.length)];
	const FACTS = ["volume price is", "support hours are", "notice period is"];
	const factText = (fact: number, value: number) => `- The Nordwind ${FACTS[fact]} ${value} ${fact === 0 ? "k per year" : fact === 1 ? "per day" : "days"}.`.replace(" k per", "k per");
	const factOf = (text: string) => FACTS.findIndex((fact) => text.startsWith(`- The Nordwind ${fact} `));
	const dayOf = (n: number) => new Date(Date.UTC(2026, 0, 10) + n * 86_400_000).toISOString().slice(0, 10);
	const entriesOf = (doc: Doc) => doc.topics.flatMap((topic) => topic.entries);
	const totals = { rooms: 0, pages: 0, applied: 0, history: 0, olderBeside: 0, tagged: 0, redirected: 0, olderAdds: 0 };
	for (let room = 0; room < 300; room++) {
		const upgraded = room % 3 === 0;
		let doc: Doc = parseMemoryDocument([
			"<!-- exxeta:l1b schema_version=1 -->", "", "## Deep Memory", "", "<!-- entries: next=20 -->", "", "### Commercial terms", "",
			...FACTS.flatMap((_, fact) => [`<!-- e: id=m-000${fact + 1} kind=fact saved=2026-01-05${upgraded ? "" : " learned=2026-01-05"} -->`, factText(fact, 5 + fact), ""]),
			"## Recent Context", "",
		].join("\n"));
		let next = 20;
		// Distinct days for the whole room, and a distinct value for every page.
		const days = [...new Set(Array.from({ length: 40 }, () => 1 + Math.floor(random() * 250)))];
		const pages: Array<{ id: string; fact: number; value: number; day: string }> = [];
		FACTS.forEach((_, fact) => {
			const count = 4 + Math.floor(random() * 3);
			for (let i = 0; i < count; i++) pages.push({ id: `RC-${String(pages.length + 1).padStart(4, "0")}`, fact, value: 10 + pages.length * 7, day: dayOf(days[pages.length]) });
		});
		const order = [...pages].sort(() => random() - 0.5);
		const history: Array<{ text: string; learned?: string; until: string }> = [];
		const replacedTexts: string[] = [];
		for (const page of order) {
			const text = factText(page.fact, page.value);
			const notes = listAreas(doc).filter((area) => factOf(area.text) === page.fact);
			const shape = random();
			const ops: unknown[] = [shape < 0.45 ? { op: "update", id: pick(notes).id, text } : shape < 0.65 ? { op: "supersede", id: pick(notes).id, text } : { op: "add", topic: "Commercial terms", kind: "fact", text }];
			if (random() < 0.3) ops.push({ op: "add", topic: "Commercial terms", kind: "fact", text: `- An unrelated point zq${page.id.slice(3)} holds.` });
			const session = { id: page.id, text: `### ${page.id} | OPEN | ${page.day} | Update\n\n**Body:**\n${text}\n`, date: page.day };
			const parsed = parseFoldOps(`A narrative line.\n\n\`\`\`json\n${JSON.stringify({ ops })}\n\`\`\`\n`);
			const areas = listAreas(doc);
			const decided = decideFoldOps(parsed.items, areas, session);
			const learnedBefore = new Map(entriesOf(doc).map((entry) => [entry.id, entry.learned]));
			const applied = applyFoldOps(doc, decided.ops, { sessionId: page.id, savedDate: "2026-09-30", sessionDate: page.day, nextEntryNumber: next });
			const label = `room ${room}, ${page.id} of ${page.day}`;
			// A3: an add of a value older than any dated note of its fact is history
			// against the newest of them, never a note beside them.
			const newerLearned = notes.map((area) => area.learned).filter((day): day is string => day !== undefined && day > page.day).sort().at(-1);
			if ((ops[0] as { op: string }).op === "add" && newerLearned) {
				const row = (applied.record.history ?? []).find((row) => row.text === text);
				assert(row && row.until === newerLearned, `${label}: an add older than a note of its fact learned ${newerLearned} is history until that day, got ${JSON.stringify(row ?? null)}`);
				assert(!entriesOf(applied.doc).some((entry) => entry.text === text), `${label}: an older add is not a current note`);
				totals.olderAdds += 1;
			}
			// No page rewrites a note learned after it.
			for (const row of [...applied.record.updated, ...applied.record.superseded]) {
				assert(!row.learnedBefore || row.learnedBefore <= page.day, `${label}: ${row.id}, learned ${row.learnedBefore}, was rewritten by an older page`);
				replacedTexts.push(row.before);
			}
			// A8: the day a note was learned never goes backwards, and a dated page never takes it away.
			for (const entry of entriesOf(applied.doc)) {
				const before = learnedBefore.get(entry.id);
				if (before) assert(entry.learned !== undefined && entry.learned >= before, `${label}: ${entry.id} went from ${before} to ${entry.learned}`);
			}
			for (const row of applied.record.history ?? []) {
				assert(row.learned === page.day && row.learned < row.until, `${label}: a history row is learned on its page's day, before it held until (${row.learned} < ${row.until})`);
				history.push(row);
			}
			const stored = renderMemoryDocument(applied.doc, "storage");
			const back = parseMemoryDocument(stored);
			assert(renderMemoryDocument(back, "storage") === stored, `${label}: the file's round trip is a fixed point`);
			totals.pages += 1;
			totals.history += (applied.record.history ?? []).length;
			totals.tagged += applied.record.added.filter((row) => row.beside === "may-disagree").length;
			for (const decision of decided.decisions) {
				if (decision.codes.includes("older-beside")) totals.olderBeside += 1;
				if (decision.fate === "applied" || decision.fate === "normalised") totals.applied += 1;
				if (decision.fate === "redirected") totals.redirected += 1;
			}
			doc = back;
			next = applied.nextEntryNumber;
		}
		const current = entriesOf(doc).map((entry) => entry.text);
		FACTS.forEach((_, fact) => {
			const newest = pages.filter((page) => page.fact === fact).sort((a, b) => (a.day < b.day ? 1 : -1))[0];
			assert(current.includes(factText(fact, newest.value)), `room ${room}: the newest value of "${FACTS[fact]}" (${newest.value}, ${newest.day}) is current, got ${JSON.stringify(current.filter((text) => factOf(text) === fact))}`);
		});
		for (const page of pages) {
			const text = factText(page.fact, page.value);
			assert(current.includes(text) || history.some((row) => row.text === text) || replacedTexts.includes(text), `room ${room}: ${page.id}'s value is lost: ${text}`);
		}
		totals.rooms += 1;
	}
	assert(totals.history > 0 && totals.olderAdds > 0, `the date layer drew history rows and older adds (${JSON.stringify(totals)})`);
	assert(totals.tagged > 0, `the date layer drew newer adds tagged may-disagree; older texts beside a newer note are not drawn (${JSON.stringify(totals)})`);
	console.log(`6. dates: ${totals.rooms} rooms, ${totals.pages} pages in shuffled order; ${totals.applied} ops applied, ${totals.redirected} redirected, ${totals.history} older values kept as history (${totals.olderAdds} of them older adds, each history against the newest note of its fact), ${totals.tagged} new notes tagged may-disagree, ${totals.olderBeside} older texts beside a newer note; the newest value current, nothing lost, no day backwards`);
}

// --- 7. The summary re-read: a note filed whole, read again by later runs -------------------
// Rooms of summary notes in Unsorted (dated and undated, one pinned, one moved
// out of Unsorted, one with a hand-added must-keep line), re-read by runs on
// two Memory models, some runs saved and some thrown away. Each page's reply
// gives back every point, some, only a drop, only empty texts, points memory
// already holds, nothing readable, a failure the model answers for, or no
// answer at all (an outage). Every page goes through the REAL page core, the
// reader, the decision and the applier, on the re-read helpers' page; what
// the run itself owns (the save, tried, the archive row) is played as the run
// plays it. Nothing a summary said may leave memory unless its note is in the
// archive whole; a point the reply gave back is current; the note is never in
// what its own fold reads; at most REREAD_CAP a run; once per model.
{
	const { applyFoldOps, decideFoldOps, parseFoldOps } = await import("../src/absorb-ops.js");
	const { cloneDocument, listAreas } = await import("../src/memory-entries.js");
	const { REREAD_CAP, rereadModelKey, rereadPage, rereadSorted, rereadTriedOn, selectRereads, withTried } = await import("../src/absorb-reread.js");
	type Doc = ReturnType<typeof parseMemoryDocument>;
	type Entry = Doc["topics"][number]["entries"][number];
	let seed = 20261001;
	const random = () => {
		seed = (seed + 0x6d2b79f5) | 0;
		let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
	const pick = <T,>(list: readonly T[]): T => list[Math.floor(random() * list.length)];
	const WORDS = ["amber", "birch", "cedar", "delta", "ember", "fjord", "grove", "heron", "ivory", "jetty"];
	let tokenCount = 0;
	/** A word no other text has, so where a point went can be read off memory. Letters only: a digit reads as a value. */
	const token = () => {
		let n = ++tokenCount;
		let word = "zr";
		do { word += String.fromCharCode(97 + (n % 26)); n = Math.floor(n / 26); } while (n > 0);
		return word;
	};
	const MODELS = [{ provider: "sim", model: "model-a" }, { provider: "sim", model: "model-b" }];
	const HELD = "- Invoices for Nordwind go out on the first working day.";
	type Behaviour = "all" | "some" | "held" | "drop" | "empty" | "unreadable" | "answered-failure" | "outage";
	const BEHAVIOURS: Behaviour[] = ["all", "all", "some", "held", "drop", "empty", "unreadable", "answered-failure", "outage"];
	const entriesOf = (doc: Doc) => doc.topics.flatMap((topic) => topic.entries);
	const totals = { rooms: 0, runs: 0, pages: 0, sorted: 0, triedAgainOnAnother: 0, outages: 0, capped: 0 };
	for (let room = 0; room < 150; room++) {
		const notes: string[] = [];
		const points = new Map<string, string[]>();
		const lines: string[] = ["<!-- exxeta:l1b schema_version=1 -->", "", "## Deep Memory", "", "<!-- entries: next=200 -->", "", "### Commercial terms", "", "<!-- e: id=m-0001 kind=fact saved=2026-09-01 learned=2026-09-20 -->", HELD, "", "### Unsorted", ""];
		const count = 3 + Math.floor(random() * 7);
		for (let n = 0; n < count; n++) {
			const id = `m-${String(100 + n).padStart(4, "0")}`;
			const words = Array.from({ length: 2 + Math.floor(random() * 3) }, () => token());
			const learned = random() < 0.7 ? ` learned=2026-08-${String(1 + Math.floor(random() * 28)).padStart(2, "0")}` : "";
			const pinned = n === 0 ? " pinned=true" : "";
			const mustKeep = n === 1 ? [`  - **must-keep** The ${token()} rule stays as the person wrote it.`] : [];
			lines.push(`<!-- e: id=${id} kind=fact saved=2026-09-01 from=RC-000${1 + (n % 3)}${pinned}${learned} summary=true -->`, `- Call about the ${pick(WORDS)} account`, ...words.map((word) => `  - The ${word} point is agreed with the ${pick(WORDS)} team.`), ...mustKeep, "");
			notes.push(id);
			points.set(id, words);
		}
		// A summary note a hand edit left with nothing but a must-keep line has nothing to re-read.
		lines.push("<!-- e: id=m-0149 kind=fact saved=2026-09-01 learned=2026-07-01 summary=true -->", `- **must-keep** The ${token()} rule stays as written.`, "");
		// A summary note Review moved out of Unsorted is sorted already.
		lines.push("### Accounts", "", "<!-- e: id=m-0150 kind=fact saved=2026-09-01 summary=true -->", `- The ${token()} call was sorted by hand.`, "", "## Recent Context", "");
		let doc: Doc = parseMemoryDocument(lines.join("\n"));
		let next = 200;
		const archive: Array<Entry & { why: string }> = [];
		/** (note, model) pairs a saved run re-read to an ending that tried it. */
		const triedPairs = new Set<string>();
		const pinnedId = notes[0];
		for (const [runIndex, model] of [MODELS[0], MODELS[0], MODELS[1], MODELS[0], MODELS[1], MODELS[1]].entries()) {
			const key = rereadModelKey(model);
			const saved = random() < 0.8;
			const selected = selectRereads(doc, model);
			const label = `room ${room}, run ${runIndex} on ${key}`;
			assert(REREAD_CAP === 5 && selected.length <= 5, `${label}: at most 5 re-reads, got ${selected.length} (cap ${REREAD_CAP})`);
			if (selected.length === 5) totals.capped += 1;
			assert(selected.every((entry) => entry.id !== pinnedId && entry.id !== "m-0150" && entry.id !== "m-0149" && !(entry.tried ?? []).includes(key)), `${label}: a pinned note, a sorted one, one with only must-keep lines and one this model tried are never re-read`);
			const days = selected.map((entry) => entry.learned ?? "~");
			assert(days.every((day, i) => i === 0 || days[i - 1] <= day), `${label}: oldest learned first, undated last, got ${days.join(",")}`);
			for (const entry of selected) if (entriesOf(doc).some((other) => other.id !== entry.id && other.summary && !other.pinned && (other.tried ?? []).length > 0 && !(other.tried ?? []).includes(key) && doc.topics.some((topic) => topic.title === "Unsorted" && topic.entries.includes(other)))) totals.triedAgainOnAnother += 1;
			let working = cloneDocument(doc);
			let workingNext = next;
			const rows: Array<Entry & { why: string }> = [];
			const triedIds = new Set<string>();
			const behaviours = new Map<string, Behaviour>();
			const gaveBack = new Map<string, string[]>();
			const endings = new Map<string, PageEnding>();
			let page: ReturnType<typeof rereadPage> = null;
			const deps: PageDeps<{ id: string }> = {
				key: (p) => `reread:${p.id}`,
				oversize: () => false,
				onPageStart: (p) => {
					page = rereadPage(working, p.id);
					assert(page && page.id === p.id && page.date === (entriesOf(working).find((entry) => entry.id === p.id)!.learned ?? ""), `${label}: ${p.id}'s page is dated with its learned day`);
					assert(!entriesOf(page.doc).some((entry) => entry.id === p.id), `${label}: ${p.id} is not in the memory its own fold reads`);
					assert(!/must-keep/i.test(page.text), `${label}: ${p.id}'s page reads without its must-keep lines`);
					behaviours.set(p.id, pick(BEHAVIOURS));
				},
				call: async (p) => {
					const behaviour = behaviours.get(p.id)!;
					if (behaviour === "outage" || behaviour === "answered-failure") throw new CallError("the provider failed", false);
					if (behaviour === "unreadable") return { text: "A reply with no list at all." };
					const mine = points.get(p.id)!;
					const back = behaviour === "all" ? mine : behaviour === "some" ? mine.filter((_, i) => i === 0 || random() < 0.5) : [];
					gaveBack.set(p.id, back);
					const ops = behaviour === "drop" ? [{ op: "drop", reason: "Nothing here to keep." }]
						: behaviour === "empty" ? mine.map(() => ({ op: "add", topic: "Accounts", kind: "fact", text: "" }))
						: behaviour === "held" ? [{ op: "add", topic: "Commercial terms", kind: "fact", text: HELD }]
						: back.map((word) => ({ op: "add", topic: "Accounts", kind: "fact", text: `- The ${word} point is agreed with the account team.` }));
					return { text: `A narrative line.\n\n\`\`\`json\n${JSON.stringify({ ops })}\n\`\`\`\n` };
				},
				read: (_p, reply): PageRead => {
					const parsed = parseFoldOps(reply.text, { truncated: reply.truncated });
					if (parsed.unreadable) return { usable: false, unreadable: parsed.unreadable };
					const decided = decideFoldOps(parsed.items, listAreas(page!.doc), { text: page!.text, date: page!.date });
					return decided.landed ? { usable: true, ops: decided.ops } : { usable: false, nothingLands: true };
				},
				apply: (_p, ops) => {
					const applied = applyFoldOps(page!.doc, ops as any, { sessionId: page!.from ?? "", savedDate: "2026-09-30", nextEntryNumber: workingNext, ...(page!.date ? { sessionDate: page!.date } : {}) });
					// A lone drop sorts nothing: the note stays where it was.
					if (applied.record.dropped) return "dropped";
					working = applied.doc;
					workingNext = applied.nextEntryNumber;
					rows.push({ ...page!.note, why: "sorted" });
					return "folded";
				},
				fileSummary: () => {},
				probe: async () => behaviours.get(page!.id) !== "outage",
				retryable: () => false,
				failureMessage: (error) => (error as Error).message,
				failureCode: () => "provider-error",
				pause: async () => {},
				cancelled: () => false,
				model,
				now: () => new Date("2026-09-30T10:00:00.000Z"),
				onPageEnd: (p, ending) => {
					endings.set(p.id, ending);
					if (rereadTriedOn(ending)) triedIds.add(p.id);
				},
				flush: () => {},
			};
			await foldPages(selected.map((entry) => ({ id: entry.id })), { records: new Map(), throttled: new Map() }, deps);
			totals.runs += 1;
			totals.pages += endings.size;
			for (const [id, ending] of endings) {
				const behaviour = behaviours.get(id)!;
				const expectSorted = behaviour === "all" || behaviour === "some" || behaviour === "held";
				assert(rereadSorted(ending) === expectSorted, `${label}: ${id} (${behaviour}) ended ${JSON.stringify(ending)}, sorted must be ${expectSorted}`);
				if (behaviour === "outage") { totals.outages += 1; assert(!triedIds.has(id), `${label}: an outage never tries ${id}`); }
			}
			if (!saved) continue;
			// The save: tried into the written document and the archive rows, the sorted notes archived whole.
			for (const topic of working.topics) topic.entries = topic.entries.map((entry) => (triedIds.has(entry.id) ? withTried(entry, key) : entry));
			for (const row of rows) archive.push({ ...withTried(row, key), why: row.why });
			for (const id of triedIds) {
				assert(!triedPairs.has(`${id} ${key}`), `${label}: ${id} was re-read twice on ${key}`);
				triedPairs.add(`${id} ${key}`);
			}
			doc = working;
			next = workingNext;
			totals.sorted += rows.length;
			// Nothing lost: every point is current, or its whole note is in the archive.
			const current = entriesOf(doc).map((entry) => entry.text).join("\n");
			const archived = archive.map((row) => row.text).join("\n");
			for (const [id, words] of points) for (const word of words) assert(current.includes(word) || archived.includes(word), `${label}: ${id}'s point ${word} is lost`);
			// A point a sorted note's reply gave back is current, not only in the archive.
			for (const row of rows) for (const word of gaveBack.get(row.id) ?? []) assert(current.includes(word), `${label}: ${row.id}'s point ${word} came back but is not current`);
			for (const [id, ending] of endings) {
				const entry = entriesOf(doc).find((candidate) => candidate.id === id);
				if (rereadSorted(ending)) assert(!entry && archive.some((row) => row.id === id && row.why === "sorted" && row.summary && (row.tried ?? []).includes(key)), `${label}: sorted ${id} is archived whole, with its tried`);
				else assert(entry && entry.summary && (ending.kind === "outage" ? !(entry.tried ?? []).includes(key) : (entry.tried ?? []).includes(key)), `${label}: unsorted ${id} stays, tried unless an outage, got ${JSON.stringify(entry ?? null)} after ${ending.kind}`);
			}
		}
		totals.rooms += 1;
	}
	assert(totals.capped > 0 && totals.outages > 0 && totals.triedAgainOnAnother > 0 && totals.sorted > 0, `the section drew the cap, outages, a second model's try and sorted notes (${JSON.stringify(totals)})`);
	console.log(`7. re-read: ${totals.rooms} rooms, ${totals.runs} runs on two models, ${totals.pages} re-read pages, ${totals.sorted} notes sorted and archived whole, ${totals.outages} outages that tried nothing, ${totals.capped} runs at the cap of ${REREAD_CAP}; nothing lost, every point given back is current, never twice on one model`);
}

console.log("absorb-pages-sim smoke passed");
