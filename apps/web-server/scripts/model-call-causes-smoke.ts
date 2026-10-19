// One reading of a failed call to the Memory model, and one patience.
//
// Pins the cause of every provider failure the facts files list (Remember's
// 8a table, Memorize's 6.1), in the words the providers and the runtime really
// send, and the patience every Memory model call gets: busy is waited out a
// bounded number of times with the next try's time published; signed out, out
// of quota and no longer offered end at once; a rate limit that outlasts the
// patience is "still busy"; a stall gets two more tries and a timeout one
// (each can cost the whole ceiling), then the probe; a refusal or a request
// too large is handed back untouched for the caller's own ladder.
//
// Offline: no server, no provider, no network. The clock and the sleep are fakes.

import {
	callWithPatience,
	classifyModelFailure,
	ModelUnreachableError,
	modelNotOffered,
	patienceSpent,
	PATIENCE_WAITS_MS,
	roomCallWait,
	signInFailed,
	withRoomCallWait,
	type PatienceWait,
} from "../src/model-call-causes.js";
import { IsolatedPersistentAgentWorkerTurnError } from "../src/persistent-agent-worker-runtime.js";
// The very function the page's Memory lines read a worker failure with (App.tsx, maintenanceCredentialLine).
import { signInFailed as pageSignInFailed } from "../src/model-not-offered.js";

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

function pass(label: string): void {
	console.log(`  ok  ${label}`);
}

const workerError = (message: string) => new IsolatedPersistentAgentWorkerTurnError("checkpoint compression worker", "error", message);
const model = { provider: "anthropic", model: "claude-sonnet-5", label: "Claude Sonnet 5" };

// --- The causes ---------------------------------------------------------------

const table: Array<[unknown, string, string?]> = [
	// busy
	[workerError('429 {"type":"error","error":{"type":"rate_limit_error","message":"Number of request tokens has exceeded your per-minute rate limit"}}'), "busy", "rate-limit"],
	[workerError("RateLimitError: litellm.RateLimitError: AnthropicException"), "busy", "rate-limit"],
	[workerError("ThrottlingException: Too many tokens, please wait before trying again."), "busy", "rate-limit"],
	[workerError("429 Too Many Requests"), "busy", "too-many-requests"],
	[workerError('529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}'), "busy", "overload"],
	[workerError('500 {"type":"error","error":{"type":"api_error","message":"Internal server error"}}'), "busy", "server-error"],
	[workerError("502 Bad Gateway"), "busy", "server-error"],
	[workerError("504 Gateway Timeout"), "busy", "server-error"],
	[workerError("503 Service Unavailable"), "busy", "server-error"],
	[workerError("Connection error."), "busy", "connection"],
	[workerError("terminated"), "busy", "connection"],
	[workerError("read ECONNRESET"), "busy", "connection"],
	[workerError("getaddrinfo ENOTFOUND api.anthropic.com"), "busy", "connection"],
	[workerError("fetch failed"), "busy", "connection"],
	// a status number inside a rate limit's own words is a count, not a sign-in
	[workerError("429 Rate limit reached for gpt-6 in organization org-x on tokens per min (TPM): Limit 30000, Used 29600, Requested 401. Please try again in 802ms."), "busy", "rate-limit"],
	[workerError('403 {"error":{"message":"rate limit exceeded for this credential, slow down"}}'), "busy", "rate-limit"],
	// Gemini's per-minute limit says "quota" and names its wait: it is a rate limit
	[workerError('429 {"error":{"code":429,"message":"You exceeded your current quota, please check your plan and billing details. Please retry in 32.5s.","status":"RESOURCE_EXHAUSTED"}}'), "busy", "rate-limit"],
	[new IsolatedPersistentAgentWorkerTurnError("w", "aborted", "it ran past its 480 second limit and was stopped", { reason: "timed-out" }), "busy", "timed-out"],
	[new IsolatedPersistentAgentWorkerTurnError("w", "aborted", "it stopped answering for 90 seconds", { reason: "stalled" }), "busy", "stalled"],
	// unreachable
	[workerError('401 {"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}'), "unreachable", "signed-out"],
	[workerError('403 {"type":"error","error":{"type":"permission_error"}}'), "unreachable", "signed-out"],
	[workerError("litellm.AuthenticationError: Error code: 401"), "unreachable", "signed-out"],
	[workerError("HTTP 403 Forbidden"), "unreachable", "signed-out"],
	[new Error("No API key found for anthropic"), "unreachable", "signed-out"],
	[new Error("checkpoint compression model provider not connected: anthropic/claude-sonnet-5"), "unreachable", "signed-out"],
	[Object.assign(new Error("This room's memory model is signed out."), { code: "provider_signed_out" }), "unreachable", "signed-out"],
	[workerError("429 You exceeded your current quota, please check your plan and billing details. insufficient_quota"), "unreachable", "quota"],
	[workerError("RESOURCE_EXHAUSTED: resource exhausted"), "unreachable", "quota"],
	// A spent plan, credit or budget, in each provider's own words, is out of quota.
	[workerError("429 You have hit your ChatGPT usage limit (plus plan). Try again in ~158 min."), "unreachable", "quota"],
	[workerError("429 You have hit your ChatGPT usage limit (pro plan). Try again in 158 min."), "unreachable", "quota"],
	[workerError('400 {"type":"error","error":{"type":"invalid_request_error","message":"Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits."}}'), "unreachable", "quota"],
	[workerError('422 {"error":{"message":"Budget has been exceeded! Current cost: 40.23, Max budget: 40.0","type":"budget_exceeded","param":null,"code":"422"}}'), "unreachable", "quota"],
	[workerError("litellm.BudgetExceededError: ExceededBudget: User=abc over budget"), "unreachable", "quota"],
	// LiteLLM's key, team and organization budgets, as its auth checks word them.
	[workerError("litellm.BudgetExceededError: Budget has been exceeded! Key=sk-...abcd Current cost: 40.23, Max budget: 40.0"), "unreachable", "quota"],
	[workerError("litellm.BudgetExceededError: ExceededBudget: Key over 1d budget. Spend=$12.0000, Limit=$10.00"), "unreachable", "quota"],
	[workerError("litellm.BudgetExceededError: ExceededBudget: Team=t1 over 30d budget. Spend=$12.0000, Limit=$10.00"), "unreachable", "quota"],
	[workerError("litellm.BudgetExceededError: Budget has been exceeded! Organization=o1 Current cost: 101, Max budget: 100"), "unreachable", "quota"],
	// A key or credential without access to one model: that model is not offered to it, signing in again cannot help.
	[workerError("403 Your API key does not have access to this model"), "unreachable", "not-offered"],
	[workerError("403 This credential's organization has no access to model gpt-6-sol"), "unreachable", "not-offered"],
	[new Error("checkpoint compression model not found: anthropic/claude-sonnet-4"), "unreachable", "not-offered"],
	[workerError('404 {"type":"error","error":{"type":"not_found_error","message":"model: claude-old"}}'), "unreachable", "not-offered"],
	[Object.assign(new Error("This room's memory model is no longer offered."), { code: "room_model_unavailable" }), "unreachable", "not-offered"],
	// refused
	[workerError("the model refused to answer this request"), "refused"],
	[workerError("Provider finish_reason: content_filter"), "refused"],
	[workerError("incomplete: content_filter"), "refused"],
	// too large
	[workerError('400 {"type":"error","error":{"type":"invalid_request_error","message":"prompt is too long: 210000 tokens > 200000 maximum"}}'), "too-large"],
	[workerError("Request too large for gpt-6 in organization org-x on tokens per min (TPM): Limit 30000, Requested 90000. rate_limit_exceeded"), "too-large"],
	// cancelled, and the rest
	[new IsolatedPersistentAgentWorkerTurnError("w", "aborted", undefined), "cancelled"],
	[workerError("the model returned an error without a message"), "other"],
	[workerError("Request used 4290 tokens"), "other"],
];
const misread: string[] = [];
for (const [error, cause, detail] of table) {
	const failure = classifyModelFailure(error);
	const words = error instanceof Error ? error.message : String(error);
	if (failure.cause !== cause || (detail && !("detail" in failure && failure.detail === detail))) misread.push(`"${words}" is ${cause}${detail ? `/${detail}` : ""}, got ${JSON.stringify(failure)}`);
}
assert(misread.length === 0, `misread failures:\n${misread.join("\n")}`);
pass(`${table.length} provider failures each read as their cause`);

// A model the provider does not serve, in OpenAI's own words, whatever its id
// holds: dots, a slash, a colon, backticks or quotes around it. Anything else
// that names a model (a parameter, a full model, a size, a rate limit, a
// sign-in, ChatGPT's not-on-account words) is never read as not offered.
const notOfferedWords = [
	"The model `gpt-6.1-sol` does not exist or you do not have access to it.",
	"The model `gpt-5.6-terra` does not exist or you do not have access to it.",
	"The model 'claude-opus-4.6' does not exist",
	"The model \"openai/gpt-6.1-sol\" does not exist or you do not have access to it.",
	"The model `openai/gpt-6.1-sol` does not exist.",
	"The model `llama3.1:70b` does not exist",
	"The model `us.anthropic.claude-opus-4-6-v1:0` does not exist or you do not have access to it.",
	"model gpt-6.1-sol does not exist",
	'404 {"error":{"message":"The model `gpt-6.1-sol` does not exist or you do not have access to it.","type":"invalid_request_error","param":null}}',
	'{"detail":"The model `gpt-6.1-sol` does not exist or you do not have access to it."}',
	'404 {"type":"error","error":{"type":"not_found_error","message":"model: claude-opus-4.6"}}',
	"404 The requested model claude-opus-4.6 was not found",
];
const notNotOfferedWords: Array<[string, string]> = [
	["Unsupported parameter: 'temperature' is not supported with this model.", "other"],
	["Unsupported value: 'reasoning.effort' does not support 'minimal' with the 'gpt-6.1-sol' model.", "other"],
	["reasoning.effort 'xhigh' is not supported for this model", "other"],
	["Selected model is at capacity. Please try a different model.", "other"],
	["400 Bad Request", "other"],
	["This model's maximum context length is 128000 tokens. However, your messages resulted in 130000 tokens.", "too-large"],
	["Rate limit reached for gpt-6.1-sol in organization org-x on tokens per min (TPM): Limit 30000, Used 29600, Requested 900.", "busy"],
	["401 Incorrect API key provided: sk-...abcd. You can find your API key at https://platform.openai.com/account/api-keys.", "unreachable/signed-out"],
	["The 'gpt-6.1-sol' model is not supported when using Codex with a ChatGPT account.", "unreachable/not-on-account"],
	["The model answered. The file report.v2.md does not exist.", "other"],
	["404 Not Found. The model gpt-6.1-sol answered.", "other"],
	["The project `proj_x1` does not exist or you do not have access to it.", "other"],
	["404 Not Found: POST https://gateway.example.com/v1/model/info", "other"],
	["404 Not Found: POST https://api.example.com/v1/models/model-router/x", "other"],
];
const misnamed: string[] = [];
for (const words of notOfferedWords) {
	const failure = classifyModelFailure(workerError(words));
	if (!modelNotOffered(words) || failure.cause !== "unreachable" || failure.detail !== "not-offered") misnamed.push(`${JSON.stringify(words)} is not offered, got ${JSON.stringify(failure)}`);
}
for (const [words, read] of notNotOfferedWords) {
	const failure = classifyModelFailure(workerError(words));
	const got = "detail" in failure && failure.cause === "unreachable" ? `${failure.cause}/${failure.detail}` : failure.cause;
	if (modelNotOffered(words) || got !== read) misnamed.push(`${JSON.stringify(words)} is ${read}, never not offered, got ${got}`);
}
assert(misnamed.length === 0, `the not-offered matcher:\n${misnamed.join("\n")}`);
pass(`a model not offered reads so in OpenAI's words whatever its id holds (${notOfferedWords.length}), and ${notNotOfferedWords.length} other failures never do`);

// --- Patience -----------------------------------------------------------------

function fakeClock() {
	let at = Date.parse("2026-10-08T10:00:00.000Z");
	const slept: number[] = [];
	return {
		slept,
		now: () => new Date(at),
		sleep: async (ms: number) => { slept.push(ms); at += ms; },
	};
}

function scripted(failures: unknown[], answer = "ok") {
	let calls = 0;
	return {
		get calls() { return calls; },
		call: async () => {
			calls += 1;
			const next = failures.shift();
			if (next !== undefined) throw next;
			return answer;
		},
	};
}

async function rejects(promise: Promise<unknown>): Promise<unknown> {
	try {
		await promise;
	} catch (error) {
		return error;
	}
	throw new Error("expected the call to fail");
}

{
	const clock = fakeClock();
	const waits: Array<PatienceWait | null> = [];
	const fake = scripted([workerError("429 rate_limit_error"), workerError("429 rate_limit_error")]);
	const result = await callWithPatience(fake.call, { model, sleep: clock.sleep, now: clock.now, onWait: (wait) => waits.push(wait) });
	assert(result === "ok" && fake.calls === 3, `a 429 twice, then the answer: three calls, got ${fake.calls}`);
	assert(clock.slept.join(",") === `${PATIENCE_WAITS_MS[0]},${PATIENCE_WAITS_MS[1]}`, `the waits follow the schedule, got ${clock.slept.join(",")}`);
	const shown = waits.filter((wait): wait is PatienceWait => wait !== null);
	assert(shown.length === 2 && shown[0]!.attempt === 2 && shown[1]!.attempt === 3, "each wait is published with the try that comes next");
	assert(shown[0]!.nextTryAt === "2026-10-08T10:00:15.000Z" && shown[1]!.nextTryAt === "2026-10-08T10:00:45.000Z", `each wait names the next try's time, got ${shown.map((wait) => wait.nextTryAt).join(", ")}`);
	assert(!shown[0]!.again && shown[1]!.again === true, "the second wait is marked as again: busy was already said");
	const afterUnreached = scripted([workerError("Connection error."), workerError("429 rate_limit_error"), workerError("429 rate_limit_error")]);
	const unreachedClock = fakeClock();
	const unreachedWaits: PatienceWait[] = [];
	await callWithPatience(afterUnreached.call, { model, sleep: unreachedClock.sleep, now: unreachedClock.now, probe: async () => "ok", onWait: (wait) => { if (wait) unreachedWaits.push(wait); } });
	assert(unreachedWaits.map((wait) => `${wait.cause}${wait.again ? "+again" : ""}`).join(",") === "unreached,busy,busy+again", `after an unreached wait the first busy wait is not marked again, got ${JSON.stringify(unreachedWaits)}`);
	assert(waits[waits.length - 1] === null, "the wait line is cleared once the call answered");
	pass("a busy model is waited out, and the line names the next try's time on each try");
}

{
	const clock = fakeClock();
	const fake = scripted([workerError("429 rate_limit_error. Please try again in 50s")]);
	await callWithPatience(fake.call, { model, sleep: clock.sleep, now: clock.now });
	assert(clock.slept[0] === 50_000, `a wait the provider names is kept, got ${clock.slept[0]}`);
	const short = scripted([workerError("429 rate_limit_error. retry after 2 seconds")]);
	const shortClock = fakeClock();
	await callWithPatience(short.call, { model, sleep: shortClock.sleep, now: shortClock.now });
	assert(shortClock.slept[0] === 15_000, `a named wait below the floor is raised to it, got ${shortClock.slept[0]}`);
	const gemini = classifyModelFailure(workerError("RESOURCE_EXHAUSTED: You exceeded your current quota. Please retry in 32.5s."));
	assert(gemini.cause === "busy" && gemini.waitMs === 32_500, `Gemini's per-minute limit keeps the wait it names, got ${JSON.stringify(gemini)}`);
	pass("a wait the provider names is used, within its bounds");
}

{
	// A first call that could not connect waits about 15 s under a true line, then asks the probe:
	// no answer is the notice; an answer makes it a blip (a network switch), waited out as busy.
	// The probe goes after the wait, since a network switch fails it too while it lasts.
	for (const message of ["fetch failed", "connect ECONNREFUSED 127.0.0.1:9", "getaddrinfo ENOTFOUND gateway.example", "fetch failed: ECONNREFUSED", "Connection error."]) {
		const clock = fakeClock();
		const waits: Array<PatienceWait | null> = [];
		const fake = scripted([workerError(message), workerError(message)]);
		let probes = 0;
		const error = await rejects(callWithPatience(fake.call, { model, sleep: clock.sleep, now: clock.now, onWait: (wait) => waits.push(wait), probe: async () => { probes += 1; throw workerError(message); } }));
		assert(error instanceof ModelUnreachableError && error.details.detail === "not-answering" && fake.calls === 1 && probes === 1, `a dead address ("${message}") is not answering after one wait, got ${String(error)} after ${fake.calls} call(s) and ${probes} probe(s)`);
		assert(clock.slept.join(",") === String(PATIENCE_WAITS_MS[0]), `the notice comes after the first wait, about 15 s, got ${clock.slept.join(",")}`);
		assert(waits[0]?.cause === "unreached" && waits[0].nextTryAt === "2026-10-08T10:00:15.000Z" && waits.at(-1) === null, `the wait is said at once as unreached, and cleared for the notice, got ${JSON.stringify(waits)}`);
	}
	for (const message of ["Connection error.", "fetch failed"]) {
		const clock = fakeClock();
		const blip = scripted([workerError(message)]);
		let probes = 0;
		// The probe fails while the switch lasts: it answers only once the first wait has passed.
		const probe = async () => { probes += 1; if (clock.slept.length === 0) throw workerError(message); return "ok"; };
		const result = await callWithPatience(blip.call, { model, sleep: clock.sleep, now: clock.now, probe });
		assert(result === "ok" && blip.calls === 2 && probes === 1 && clock.slept.length === 1, `a first call's "${message}" with the probe answering after the wait is a blip, waited out, got ${blip.calls} call(s), ${probes} probe(s), ${clock.slept.length} wait(s)`);
		const again = scripted([workerError(message), workerError(message)]);
		const againClock = fakeClock();
		const againWaits: PatienceWait[] = [];
		assert(await callWithPatience(again.call, { model, sleep: againClock.sleep, now: againClock.now, probe: async () => "ok", onWait: (wait) => { if (wait) againWaits.push(wait); } }) === "ok" && again.calls === 3, `a blip that fails once more is waited out as busy, got ${again.calls} call(s)`);
		assert(againWaits.map((wait) => wait.cause).join(",") === "unreached,busy" && againClock.slept.join(",") === `${PATIENCE_WAITS_MS[0]},${PATIENCE_WAITS_MS[1]}`, `then the busy line, on the busy schedule, got ${JSON.stringify(againWaits)} ${againClock.slept.join(",")}`);
		const bare = scripted([workerError(message)]);
		const bareClock = fakeClock();
		assert(await callWithPatience(bare.call, { model, sleep: bareClock.sleep, now: bareClock.now }) === "ok" && bareClock.slept.length === 1, `without a probe, a first call's "${message}" is waited out`);
	}
	{
		// A probe that meets a busy model after the unreached wait: the model answered, busy, so it is waited out, never "not answering".
		const clock = fakeClock();
		const fake = scripted([workerError("Connection error.")]);
		const result = await callWithPatience(fake.call, { model, sleep: clock.sleep, now: clock.now, probe: async () => { throw workerError('529 {"type":"error","error":{"type":"overloaded_error"}}'); } });
		assert(result === "ok" && fake.calls === 2, `a busy probe after the unreached wait goes on, got ${fake.calls} call(s)`);
		// A cancel that lands just as the probe answers: the wait line comes down, and no further call starts.
		{
			const controller = new AbortController();
			const answered = scripted([workerError("Connection error.")]);
			const answeredClock = fakeClock();
			const lines: Array<PatienceWait | null> = [];
			await rejects(callWithPatience(answered.call, { model, signal: controller.signal, sleep: answeredClock.sleep, now: answeredClock.now, onWait: (wait) => lines.push(wait), probe: async () => { controller.abort(); return "ok"; } }));
			assert(answered.calls === 1 && lines.length > 0 && lines[lines.length - 1] === null, `a cancel right after the probe answered takes the wait down, got ${JSON.stringify(lines.map((wait) => wait?.cause ?? null))} after ${answered.calls} call(s)`);
		}
		// A probe that timed out, went silent or dropped did not answer: the notice, with no further call.
		for (const [label, probeError] of [
			["timed out", new IsolatedPersistentAgentWorkerTurnError("w", "aborted", "ran past its limit", { reason: "timed-out" })],
			["went silent", new IsolatedPersistentAgentWorkerTurnError("w", "aborted", "stopped answering", { reason: "stalled" })],
			["dropped", workerError("read ECONNRESET")],
		] as const) {
			const silent = scripted([workerError("Connection error.")]);
			const silentClock = fakeClock();
			const ended = await rejects(callWithPatience(silent.call, { model, sleep: silentClock.sleep, now: silentClock.now, probe: async () => { throw probeError; } }));
			assert(ended instanceof ModelUnreachableError && ended.details.detail === "not-answering" && silent.calls === 1, `a probe that ${label} after the unreached wait is not an answer: the notice, got ${(ended as Error)?.message} after ${silent.calls} call(s)`);
		}
		// The line is taken down while the next try runs: the model may be answering it.
		const events: string[] = [];
		const busy = scripted([workerError("429 rate_limit_error")]);
		const busyClock = fakeClock();
		await callWithPatience(async () => { events.push("call"); return busy.call(); }, { model, sleep: busyClock.sleep, now: busyClock.now, onWait: (wait) => events.push(wait ? "wait" : "clear") });
		assert(events.join(",") === "call,wait,clear,call", `the wait is cleared before the next try, got ${events.join(",")}`);
		// Cancel during the first-call probe: the probe gets the signal, and no call starts after it.
		const controller = new AbortController();
		const cancelled = scripted([workerError("Connection error.")]);
		const cancelClock = fakeClock();
		let probeSignal: AbortSignal | undefined;
		const stopped = await rejects(callWithPatience(cancelled.call, { model, sleep: cancelClock.sleep, now: cancelClock.now, signal: controller.signal, probe: async (signal?: AbortSignal) => { probeSignal = signal; controller.abort(); return "ok"; } }));
		assert(cancelled.calls === 1 && probeSignal === controller.signal && !(stopped instanceof ModelUnreachableError), `a cancel during the probe starts no further call and the probe has the signal, got ${cancelled.calls} call(s), signal ${probeSignal === controller.signal}`);
	}
	{
		// A caller with its own probe for the end of the patience (Memorize's fold, sort and placement) still gets the first-call probe.
		const clock = fakeClock();
		const fake = scripted([workerError("Connection error."), workerError("Connection error.")]);
		let probes = 0;
		const error = await rejects(callWithPatience(fake.call, { model, sleep: clock.sleep, now: clock.now, connectProbe: async () => { probes += 1; throw workerError("Connection error."); } }));
		assert(error instanceof ModelUnreachableError && error.details.detail === "not-answering" && fake.calls === 1 && probes === 1 && clock.slept.length === 1, `a dead address with only the first-call probe is the notice after one wait, got ${String(error)} after ${fake.calls} call(s)`);
		const server = scripted(Array.from({ length: 6 }, () => workerError("502 Bad Gateway")));
		const serverClock = fakeClock();
		let serverProbes = 0;
		const spent = await rejects(callWithPatience(server.call, { model, sleep: serverClock.sleep, now: serverClock.now, connectProbe: async () => { serverProbes += 1; return "ok"; } }));
		assert(patienceSpent(spent) && serverProbes === 0, "the first-call probe is not the end-of-patience probe: a server error past the patience is handed back spent, for the caller's own probe");
	}
	const clock = fakeClock();
	const dropped = scripted([workerError("terminated")]);
	assert(await callWithPatience(dropped.call, { model, sleep: clock.sleep, now: clock.now }) === "ok" && clock.slept.length === 1, "a connection that dropped after it opened is waited out");
	const later = scripted([workerError("terminated"), workerError("fetch failed")]);
	const laterClock = fakeClock();
	assert(await callWithPatience(later.call, { model, sleep: laterClock.sleep, now: laterClock.now }) === "ok" && later.calls === 3, "a refused connection after one that opened is waited out too: the server may be restarting");
	pass("a dead address is the notice after one said wait of about 15 s; a blip on the first call and a dropped connection are waited out");
}

{
	const clock = fakeClock();
	const fake = scripted(Array.from({ length: 6 }, () => workerError('529 {"type":"error","error":{"type":"overloaded_error"}}')));
	const error = await rejects(callWithPatience(fake.call, { model, sleep: clock.sleep, now: clock.now }));
	assert(error instanceof ModelUnreachableError, `six overloads end unreachable, got ${String(error)}`);
	assert(error.details.detail === "still-busy" && error.code === "model_unreachable" && error.statusCode === 503, `the cause is "still busy", got ${JSON.stringify(error.details)}`);
	assert(fake.calls === 6, `five retries after the first call, got ${fake.calls} calls`);
	const total = clock.slept.reduce((sum, ms) => sum + ms, 0);
	assert(total === PATIENCE_WAITS_MS.reduce((sum, ms) => sum + ms, 0) && total >= 5 * 60_000 && total <= 7 * 60_000, `about six minutes of patience, got ${total / 1000} s`);
	pass("a model busy past about six minutes of tries is unreachable, as 'still busy'");
}

{
	// A provider incident mixes its kinds (an overload, then a server error,
	// then a dropped connection): one budget for all of them, not one each.
	const kinds = ['529 {"type":"error","error":{"type":"overloaded_error"}}', '500 {"type":"error","error":{"type":"api_error"}}', "read ECONNRESET"];
	const clock = fakeClock();
	const waits: PatienceWait[] = [];
	const fake = scripted(Array.from({ length: 12 }, (_, index) => workerError(kinds[index % kinds.length]!)));
	const error = await rejects(callWithPatience(fake.call, { model, sleep: clock.sleep, now: clock.now, onWait: (wait) => { if (wait) waits.push(wait); } }));
	assert(fake.calls === 6, `a mixed incident gets five retries in all, got ${fake.calls} calls`);
	const total = clock.slept.reduce((sum, ms) => sum + ms, 0);
	assert(total <= 7 * 60_000, `a mixed incident is about six minutes of patience, got ${total / 1000} s`);
	assert(waits.map((wait) => wait.attempt).join(",") === "2,3,4,5,6", `the tries count across kinds, got ${waits.map((wait) => wait.attempt).join(",")}`);
	assert(patienceSpent(error), `without a probe, the last dropped connection is handed back spent, got ${String(error)}`);
	const overloadLast = scripted([kinds[1], kinds[2], kinds[0], kinds[1], kinds[2], kinds[0]].map((words) => workerError(words!)));
	const overloadClock = fakeClock();
	const stillBusy = await rejects(callWithPatience(overloadLast.call, { model, sleep: overloadClock.sleep, now: overloadClock.now }));
	assert(overloadLast.calls === 6 && stillBusy instanceof ModelUnreachableError && stillBusy.details.detail === "still-busy", `ending on an overload is still busy, got ${overloadLast.calls} calls, ${String(stillBusy)}`);
	pass("the busy kinds share one budget of five retries, about six minutes");
}

for (const [words, detail] of [["401 authentication_error", "signed-out"], ["insufficient_quota", "quota"], ["model not found: x/y", "not-offered"]] as const) {
	const clock = fakeClock();
	const fake = scripted([workerError(words)]);
	const error = await rejects(callWithPatience(fake.call, { model, sleep: clock.sleep, now: clock.now }));
	assert(error instanceof ModelUnreachableError && error.details.detail === detail, `"${words}" ends at once as ${detail}, got ${String(error)}`);
	assert(fake.calls === 1 && clock.slept.length === 0, `"${words}" is never retried`);
	assert(error.message.includes("Claude Sonnet 5") && !error.message.includes(words), "the sentence names the model and never the provider's raw words");
}
pass("signed out, out of quota and no longer offered end at once, in the product's words");

{
	// A key connection says which way its key is gone; a sign-in stays signed out.
	const keyModel = { provider: "openai", model: "gpt-5.5", label: "GPT-5.5" };
	const clock = fakeClock();
	const refused = await rejects(callWithPatience(scripted([workerError("401 Incorrect API key provided")]).call, { model: keyModel, sleep: clock.sleep, now: clock.now }));
	assert(refused instanceof ModelUnreachableError && refused.details.detail === "signed-out" && refused.details.key === "refused" && refused.message === "GPT-5.5 cannot answer because its provider did not accept the saved key. Nothing was lost.", `a 401 on a key is the saved key refused, got ${String(refused)} ${JSON.stringify((refused as any)?.details)}`);
	const missing = new ModelUnreachableError("signed-out", keyModel, new Error("No API key found for openai"));
	assert(missing.details.key === "missing" && missing.message === "GPT-5.5 cannot answer because its provider has no key saved. Nothing was lost.", `no key found is the key missing, got ${missing.message}`);
	assert(new ModelUnreachableError("signed-out", { provider: "gateway-synthetic", model: "m", label: "Gateway Model" }).details.key === "missing", "a gateway refused before any call has no key saved");
	const signedOut = new ModelUnreachableError("signed-out", model, workerError("401 authentication_error"));
	assert(signedOut.details.key === undefined && signedOut.message === "Claude Sonnet 5 cannot answer because its provider is signed out. Nothing was lost.", `a sign-in stays signed out, got ${signedOut.message}`);
	const claudeKey = { provider: "anthropic-api-key", model: "claude-opus-5-5", label: "Claude Opus 5.5" };
	const workspace = workerError('400 {"type":"error","error":{"type":"invalid_request_error","message":"This API key is not scoped to a workspace, so this request must include the anthropic-workspace-id header with the ID of the workspace to use. Add the header, or use an API key that is scoped to a workspace."}}');
	const noWorkspace = await rejects(callWithPatience(scripted([workspace]).call, { model: claudeKey, sleep: clock.sleep, now: clock.now }));
	assert(noWorkspace instanceof ModelUnreachableError && noWorkspace.details.key === "no-workspace" && noWorkspace.message === "Claude Opus 5.5 cannot answer because its key isn't tied to a workspace. Nothing was lost.", `Anthropic's workspace 400 is its own case, never signed out, got ${String(noWorkspace)}`);
	assert(classifyModelFailure(new Error("The api key field in this request was ignored")).cause === "other" && !signInFailed("Set the OAuth scope or a credential helper in your config"), "words that only name an API key, OAuth or a credential are not a sign-in");
	pass("a key connection's Memory model says no key saved, the saved key refused, or a key outside a workspace; a sign-in says signed out; a passing mention of an API key is not a sign-in");
}

{
	// The runtime's own words, verbatim: every provider's stream without a key
	// (runtime/packages/ai/src/providers/anthropic.ts and the rest), and the
	// session's check for a sign-in it cannot use (agent-session.ts).
	const noKey = (provider: string) => `No API key for provider: ${provider}`;
	const expired = (provider: string) => `Authentication failed for "${provider}". Credentials may have expired or network is unavailable. Run '/login ${provider}' to re-authenticate.`;
	const signIns = [model, { provider: "openai-codex", model: "gpt-6.1-sol", label: "GPT-6.1 Sol" }];
	const keys = [{ provider: "openai", model: "gpt-5.5", label: "GPT-5.5" }, { provider: "anthropic-api-key", model: "claude-opus-5-5", label: "Claude Opus 5.5" }];
	for (const words of [...signIns.flatMap((m) => [noKey(m.provider), expired(m.provider)]), ...keys.map((m) => noKey(m.provider))]) {
		const failure = classifyModelFailure(workerError(words));
		assert(failure.cause === "unreachable" && failure.detail === "signed-out", `"${words}" reads as a credential gone, got ${JSON.stringify(failure)}`);
		assert(pageSignInFailed(words), `the page's Memory line reads "${words}" as a key or sign-in`);
	}
	for (const m of signIns) {
		for (const words of [noKey(m.provider), expired(m.provider)]) {
			const clock = fakeClock();
			const error = await rejects(callWithPatience(scripted([workerError(words)]).call, { model: m, sleep: clock.sleep, now: clock.now }));
			assert(error instanceof ModelUnreachableError && error.details.key === undefined && error.message === `${m.label} cannot answer because its provider is signed out. Nothing was lost.`, `a sign-in's "${words}" says signed out, got ${String(error)}`);
		}
	}
	for (const m of keys) {
		const clock = fakeClock();
		const error = await rejects(callWithPatience(scripted([workerError(noKey(m.provider))]).call, { model: m, sleep: clock.sleep, now: clock.now }));
		assert(error instanceof ModelUnreachableError && error.details.key === "missing" && error.message === `${m.label} cannot answer because its provider has no key saved. Nothing was lost.`, `a key connection's "${noKey(m.provider)}" says no key saved, got ${String(error)}`);
	}
	for (const words of ["Pick a provider: No API key for provider is configured here", "Authentication failed for the proxy", "Credentials may have expired"]) {
		assert(classifyModelFailure(new Error(words)).cause === "other" && !pageSignInFailed(words), `"${words}" is not the runtime's phrase, so not a sign-in`);
	}
	pass("the runtime's \"No API key for provider\" and \"Authentication failed ... Credentials may have expired\" say signed out on a sign-in and no key saved on a key, on the server and on the page");
}

{
	const stall = () => new IsolatedPersistentAgentWorkerTurnError("w", "aborted", "stopped answering", { reason: "stalled" });
	const clock = fakeClock();
	const fake = scripted([stall(), stall(), stall()]);
	let probes = 0;
	const error = await rejects(callWithPatience(fake.call, { model, sleep: clock.sleep, now: clock.now, probe: async () => { probes += 1; throw workerError("Connection error."); } }));
	assert(fake.calls === 3, `a stall is tried at most twice more, got ${fake.calls} calls`);
	assert(probes === 1 && error instanceof ModelUnreachableError && error.details.detail === "not-answering", `then the probe; no answer is "not answering", got ${String(error)}`);

	const timeout = () => new IsolatedPersistentAgentWorkerTurnError("w", "aborted", "ran past its limit", { reason: "timed-out" });
	const timedOut = scripted([timeout(), timeout()]);
	const timedClock = fakeClock();
	const handedBack = await rejects(callWithPatience(timedOut.call, { model, sleep: timedClock.sleep, now: timedClock.now, probe: async () => "OK" }));
	assert(timedOut.calls === 2, `a timeout is tried at most once more, got ${timedOut.calls} calls`);
	assert(handedBack instanceof IsolatedPersistentAgentWorkerTurnError && patienceSpent(handedBack), "a probe that answers hands the failure back as this request's own, marked spent");

	const noProbe = scripted([workerError("502 Bad Gateway"), workerError("502 Bad Gateway"), workerError("502 Bad Gateway"), workerError("502 Bad Gateway"), workerError("502 Bad Gateway"), workerError("502 Bad Gateway")]);
	const noProbeClock = fakeClock();
	const spent = await rejects(callWithPatience(noProbe.call, { model, sleep: noProbeClock.sleep, now: noProbeClock.now }));
	assert(noProbe.calls === 6 && patienceSpent(spent) && !(spent instanceof ModelUnreachableError), "without a probe, a server error past the patience is handed back marked spent, for the caller's own probe");
	pass("a stall gets two more tries and a timeout one, then the probe decides; the worst case per call is bounded");
}

{
	for (const words of ["the model refused to answer this request", "prompt is too long: 300000 tokens > 200000 maximum", "the model returned an error without a message"]) {
		const fake = scripted([workerError(words)]);
		const clock = fakeClock();
		const error = await rejects(callWithPatience(fake.call, { model, sleep: clock.sleep, now: clock.now }));
		assert(fake.calls === 1 && clock.slept.length === 0, `"${words}" is not waited out`);
		assert(error instanceof IsolatedPersistentAgentWorkerTurnError && !patienceSpent(error), `"${words}" is handed back untouched`);
	}
	const controller = new AbortController();
	const fake = scripted([workerError("429 rate_limit_error")]);
	const sleep = async () => { controller.abort(); };
	const error = await rejects(callWithPatience(fake.call, { model, sleep, signal: controller.signal }));
	assert(fake.calls === 1 && error instanceof IsolatedPersistentAgentWorkerTurnError, "a cancel during a wait ends the patience, with no further call");
	pass("a refusal, a request too large and an unknown failure are handed back untouched; a cancel ends the wait");
}

{
	// The first read, the discussion and the sign-off pass the room's model
	// lock, which carries no label; Remember passes the chat's label, the
	// provider and the name joined by a dash. Either way the notice names the
	// model as the app shows it.
	const bare = new ModelUnreachableError("not-answering", { provider: "anthropic", model: "claude-sonnet-5-5" });
	assert(bare.message === "Claude Sonnet 5.5 isn't answering right now. Nothing was lost.", `a model lock without a label is named as the app shows it, got "${bare.message}"`);
	const wire = new ModelUnreachableError("quota", { provider: "anthropic", model: "claude-sonnet-5-5", label: "Anthropic / Claude \u2014 Claude Sonnet 5.5" });
	assert(wire.message === "Claude Sonnet 5.5 has reached its usage limit. Nothing was lost.", `a label with its provider is named without it, got "${wire.message}"`);
	const gateway = new ModelUnreachableError("not-offered", { provider: "gateway-acme", model: "moonshotai.kimi-k2.5" });
	assert(gateway.message === "Kimi K2.5 is no longer offered. Nothing was lost.", `a gateway's raw id is tidied, got "${gateway.message}"`);
	const fake = scripted([workerError("litellm.AuthenticationError: Error code: 401")]);
	const clock = fakeClock();
	const signedOut = await rejects(callWithPatience(fake.call, { model: { provider: "openai-codex", model: "gpt-6.1-sol" }, sleep: clock.sleep, now: clock.now }));
	assert(signedOut instanceof ModelUnreachableError && signedOut.message === "GPT-6.1 Sol cannot answer because its provider is signed out. Nothing was lost.", `a patient call without a label names the model as the app shows it, got "${String((signedOut as Error).message)}"`);
	assert(signedOut.details.model === "gpt-6.1-sol" && signedOut.details.label === undefined, "the details keep the lock as it came");
	pass("the notice names the model as the app shows it, never its raw id or its provider label");
}

// A room's flows wait apart: Memorize's wait is never shown on Review's status, and one call ending never takes down another's.
{
	const waitOf = (at: string): PatienceWait => ({ cause: "busy", detail: "rate-limit", attempt: 2, nextTryAt: at });
	let endReview!: () => void;
	let endAbsorb!: () => void;
	const absorb = withRoomCallWait("flows-room", "absorb", (onWait) => { onWait(waitOf("2026-10-11T01:00:00.000Z")); return new Promise<void>((resolve) => { endAbsorb = resolve; }); });
	const review = withRoomCallWait("flows-room", "review", (onWait) => { onWait(waitOf("2026-10-11T01:02:00.000Z")); return new Promise<void>((resolve) => { endReview = resolve; }); });
	const second = withRoomCallWait("flows-room", "absorb", (onWait) => { onWait(waitOf("2026-10-11T00:59:00.000Z")); return Promise.resolve(); });
	await second;
	assert(roomCallWait("flows-room", "absorb")?.nextTryAt === "2026-10-11T01:00:00.000Z", `a call that ended leaves the wait of the one still waiting, got ${JSON.stringify(roomCallWait("flows-room", "absorb"))}`);
	assert(roomCallWait("flows-room", "review")?.nextTryAt === "2026-10-11T01:02:00.000Z", "each flow says its own wait");
	endReview();
	await review;
	assert(roomCallWait("flows-room", "review") === undefined && roomCallWait("flows-room", "absorb")?.nextTryAt === "2026-10-11T01:00:00.000Z", "Review's call ending leaves Memorize's wait as it was");
	endAbsorb();
	await absorb;
	assert(roomCallWait("flows-room", "absorb") === undefined, "the wait is gone once the last call ended");
	pass("a room's flows and calls wait apart: one ending never takes down another's wait");
}

console.log("model call causes smoke passed");
