// The words for a failed model call that depend on who can do something
// about it. No server, no browser: the classifier, the sentences and the
// page's lines are plain functions.
//
// - A 403 (a region the provider does not serve, a permission error) is not a
//   refused key: it says the request was refused, with Choose another model.
// - A provider's server error is not "busy": the wait line names the provider.
// - A spent usage limit or credit says so, and the way on fits who can lift
//   it: a key's own account, the Claude key's console, a company gateway's
//   owner. In chat the way on also offers another model.
// - On a shared server, the person cannot check the internet connection or
//   the balance: the lines send them to their admin. A gateway's bare 403 on
//   a memory screen does the same, with no Replace key, as the chat's line.
// - The newest chat line offers a button for each way on it names, Try again
//   only where trying now can work, none for telling the admin; the words
//   leave out what a button does; an overflow offers Review memory, and a
//   message too large by itself has its own line. A model that reads less
//   than the window set for it in AI setup says so first, whatever is in
//   memory, and a room with nothing in memory names the conversation. A row shows the cause,
//   then the rest, and a line saved in an earlier order is read in today's.
//   Try again sends a message that stayed above again whole, files
//   included, or is not offered.
import { classifyModelFailure, callWithPatience, modelUnreachableSentence, signInFailed, type PatienceWait } from "../src/model-call-causes.js";
import * as causes from "../src/model-call-causes.js";
import { IsolatedPersistentAgentWorkerTurnError } from "../src/persistent-agent-worker-runtime.js";
import { registerServerHooks } from "../src/server-hooks.js";
import { failureLineText, turnFailureLine as turnFailureParts, unreachedWayOn } from "../../web-ui/src/turn-failure-line.js";
// A chat line's text as it is first said, nothing of the message lost.
const turnFailureLine = (...args: Parameters<typeof turnFailureParts>): string => failureLineText(turnFailureParts(...args), "lost");
import * as lines from "../../web-ui/src/turn-failure-line.js";
import { isSignInFailure } from "../../web-ui/src/sign-in-failure.js";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { memoryModelStopWayOn, memoryModelStopWhy, reviewRunPausedSentence } from "../../web-ui/src/memory-v2-copy.js";
import { fetchRemoteClientContext } from "../../web-ui/src/remote-client-context.js";

type QuotaWay = { kind: string; provider?: string; resetsAt?: string };
const { modelWaitLine } = await import(pathToFileURL(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../web-ui/src/components/model-notice.tsx")).href) as { modelWaitLine: (wait: unknown) => string };
// Read optionally, so a build without them fails each check by name.
const quotaWayOf: (provider: string, words?: string) => QuotaWay = (causes as any).quotaWayOf ?? (() => ({ kind: "(none)" }));
const quotaWayOn: (way: QuotaWay) => string = (lines as any).quotaWayOn ?? (() => "(none)");

const failures: string[] = [];
function check(condition: unknown, message: string): void {
	if (!condition) failures.push(message);
}

const workerError = (message: string) => new IsolatedPersistentAgentWorkerTurnError("checkpoint compression worker", "error", message);
const model = { provider: "anthropic-api-key", model: "claude-sonnet-5", label: "Claude Sonnet 5" };

// --- a 403 is not a refused key -----------------------------------------------
const REGION_403 = [
	'403 {"type":"error","error":{"type":"permission_error","message":"Country, region, or territory not supported"}}',
	'403 {"error":{"code":"unsupported_country_region_territory","message":"Country, region, or territory not supported","param":null,"type":"request_forbidden"}}',
	'403 {"type":"error","error":{"type":"permission_error"}}',
	"HTTP 403 Forbidden",
];
for (const words of REGION_403) {
	const failure = classifyModelFailure(workerError(words));
	check(failure.cause === "unreachable" && (failure as { detail?: string }).detail === "region-or-plan", `a 403 reads as refused for region or plan, not a refused key: ${words.slice(0, 60)} gave ${JSON.stringify(failure)}`);
	check(!signInFailed(words) && !isSignInFailure(words), `the server's and the chat's sign-in matchers both leave the 403 out: ${words.slice(0, 60)}`);
}
check(modelUnreachableSentence("region-or-plan" as never, model) === "Claude Sonnet 5 refused this request: it may not be offered in your region or on your plan. Nothing was lost.", `the Memory notice's 403 sentence, got "${modelUnreachableSentence("region-or-plan" as never, model)}"`);
check(memoryModelStopWhy("region-or-plan" as never) === "refused this request: it may not be offered in your region or on your plan", `the memory cards' 403 cause, got "${memoryModelStopWhy("region-or-plan" as never)}"`);
// A 401 is still a refused key.
check(classifyModelFailure(workerError('401 {"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}')).cause === "unreachable", "a 401 stays a refused key");

// --- a server error names the provider -----------------------------------------
{
	const waits: Array<PatienceWait | null> = [];
	let calls = 0;
	await callWithPatience(async () => { calls += 1; if (calls === 1) throw workerError('500 {"type":"error","error":{"type":"api_error","message":"Internal server error"}}'); return "ok"; }, { model: { provider: "openai", model: "gpt-6" }, onWait: (wait) => waits.push(wait), sleep: async () => {} });
	const wait = waits.find((entry) => entry !== null) as (PatienceWait & { provider?: string }) | undefined;
	check(wait?.detail === "server-error" && typeof wait.provider === "string" && wait.provider.length > 0, `a server error's wait names the provider, got ${JSON.stringify(wait)}`);
	const line = wait ? modelWaitLine({ ...wait, nextTryAt: "2026-10-21T10:05:00" } as never) : "";
	check(line === `${wait?.provider} has a problem on its side. Trying again at ${lines.clockTime("2026-10-21T10:05:00")}.`, `the wait line for a server error, got "${line}"`);
}

// --- usage limit or credit, by who can lift it --------------------------------
check(JSON.stringify(quotaWayOf("anthropic-api-key")) === JSON.stringify({ kind: "claude-key" }), `the Claude key's way, got ${JSON.stringify(quotaWayOf("anthropic-api-key"))}`);
check(quotaWayOf("openai").kind === "key", `a key provider's way, got ${JSON.stringify(quotaWayOf("openai"))}`);
check(quotaWayOf("openai-codex").kind === "sign-in", `a sign-in's way, got ${JSON.stringify(quotaWayOf("openai-codex"))}`);
const WAYS: Array<[QuotaWay, string]> = [
	[{ kind: "key", provider: "OpenAI" }, "Check your plan or balance with OpenAI."],
	[{ kind: "claude-key" }, "Check the balance at console.anthropic.com."],
	[{ kind: "gateway", provider: "Acme gateway" }, "Ask whoever runs Acme gateway about the limit."],
	[{ kind: "shared" }, "Tell your admin."],
	[{ kind: "sign-in", provider: "ChatGPT" }, "Try again later."],
];
for (const [way, words] of WAYS) check(quotaWayOn(way) === words, `the way on for ${JSON.stringify(way)}, got "${quotaWayOn(way)}"`);
const CHAT: Array<[QuotaWay, string]> = [
	[{ kind: "key", provider: "OpenAI" }, "GPT 6 has reached its usage limit or run out of credit. Nothing was lost. Check your plan or balance with OpenAI, or choose another model in Room settings, Model."],
	[{ kind: "claude-key" }, "GPT 6 has reached its usage limit or run out of credit. Nothing was lost. Check the balance at console.anthropic.com, or choose another model in Room settings, Model."],
	[{ kind: "gateway", provider: "Acme gateway" }, "GPT 6 has reached its usage limit or run out of credit. Nothing was lost. Ask whoever runs Acme gateway about the limit, or choose another model in Room settings, Model."],
	[{ kind: "shared" }, "GPT 6 has reached its usage limit or run out of credit. Nothing was lost. Tell your admin, or choose another model in Room settings, Model."],
	[{ kind: "sign-in", provider: "ChatGPT" }, "GPT 6 has reached your plan's usage limit. Nothing was lost. Try again later, or choose another model in Room settings, Model."],
];
for (const [way, line] of CHAT) {
	const shown = (turnFailureLine as any)("GPT 6", "quota", "openai", way);
	check(shown === line, `the chat's line for ${JSON.stringify(way)}, got "${shown}"`);
}
check(modelUnreachableSentence("quota", model) === "Claude Sonnet 5 has reached its usage limit or run out of credit. Nothing was lost. Check the balance at console.anthropic.com.", `the Memory notice on the Claude key, got "${modelUnreachableSentence("quota", model)}"`);
check(memoryModelStopWhy("quota") === "has reached its usage limit or run out of credit", `the memory cards' quota cause, got "${memoryModelStopWhy("quota")}"`);
check((memoryModelStopWayOn as any)("quota", undefined, { kind: "key", provider: "OpenAI" }) === "Check your plan or balance with OpenAI.", `the memory card's way on, got "${(memoryModelStopWayOn as any)("quota", undefined, { kind: "key", provider: "OpenAI" })}"`);
{
	const paused = reviewRunPausedSentence("GPT 6", { cause: "quota", model: { provider: "openai" }, quotaWay: { kind: "gateway", provider: "Acme gateway" } } as never, false);
	check(paused.includes("has reached its usage limit or run out of credit") && paused.endsWith(" Ask whoever runs Acme gateway about the limit.") && !paused.includes("Room settings"), `Review's paused line on a gateway, got "${paused}"`);
}

// --- A ChatGPT sign-in's 429: a short rate limit waits, a spent plan says when it resets ---
{
	const spent = "You have hit your ChatGPT usage limit (plus plan). Try again in ~42 min.";
	check(causes.providerNamedWaitMs(spent) === 42 * 60_000, `"in ~42 min" is a named wait, got ${causes.providerNamedWaitMs(spent)}`);
	check((classifyModelFailure(workerError(spent)) as { detail?: string }).detail === "quota", `a spent plan is a quota, got ${JSON.stringify(classifyModelFailure(workerError(spent)))}`);
	const rateLimited = "Rate limit reached for gpt-6.1-sol in organization org-x on tokens per min (TPM): Limit 30000, Used 29000. Please try again in 20s.";
	check(classifyModelFailure(workerError(rateLimited)).cause === "busy", `a short rate limit is busy, got ${JSON.stringify(classifyModelFailure(workerError(rateLimited)))}`);
	const way = quotaWayOf("openai-codex", spent);
	const minutes = way.resetsAt ? Math.round((Date.parse(way.resetsAt) - Date.now()) / 60_000) : NaN;
	check(way.kind === "sign-in" && Math.abs(minutes - 42) <= 1, `a spent plan's way carries its reset, got ${JSON.stringify(way)}`);
	// By the clock, so a line made once stays true.
	const resets = `It resets ${lines.clockWhen(way.resetsAt!)}`;
	check(quotaWayOn(way) === `${resets}.`, `a spent plan's way on, got "${quotaWayOn(way)}"`);
	const chat = (turnFailureLine as any)("GPT 6", "quota", "openai-codex", way);
	check(chat === `GPT 6 has reached your plan's usage limit. Nothing was lost. ${resets}: try again then, or choose another model in Room settings, Model.`, `the chat's line for a spent plan, got "${chat}"`);
	const notice = new causes.ModelUnreachableError("quota", { provider: "openai-codex", model: "gpt-6.1-sol", label: "GPT-6.1 Sol" }, workerError(spent));
	// A time of day is worded on the page, in the person's own zone and clock: the server's sentence leaves it out, and its details carry it.
	check(notice.message === "GPT-6.1 Sol has reached your plan's usage limit. Nothing was lost. Try again later.", `the Memory notice for a spent plan, got "${notice.message}"`);
	const card = reviewRunPausedSentence("GPT 6", { cause: "quota", model: { provider: "openai-codex" }, quotaWay: way } as never, false);
	check(card === `GPT 6 has reached your plan's usage limit. Nothing was lost. ${resets}.`, `Review's card for a spent plan, under its "Review paused." headline, got "${card}"`);
	check((notice.details as { quotaWay?: QuotaWay }).quotaWay?.resetsAt !== undefined, `the notice's details carry the reset for the cards, got ${JSON.stringify(notice.details)}`);
}

// --- The Memory notice's quota sentence is worded on the page, in the viewer's clock ---
{
	const { ApiRequestError } = await import("../../web-ui/src/api.js");
	const noticeModule = await import(pathToFileURL(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../web-ui/src/components/model-notice.tsx")).href) as Record<string, unknown>;
	const wordNotice = noticeModule.modelNoticeSentence as ((notice: unknown) => string) | undefined;
	check(typeof wordNotice === "function", "the notice's sentence is worded on the page");
	if (wordNotice) {
		const resetsAt = new Date(Date.now() + 42 * 60_000).toISOString();
		const fromServer = new ApiRequestError("GPT-6.1 Sol has reached your plan's usage limit. Nothing was lost. Try again later.", 503, "model_unreachable", { detail: "quota", provider: "openai-codex", model: "gpt-6.1-sol", label: "GPT-6.1 Sol", quotaWay: { kind: "sign-in", provider: "ChatGPT", resetsAt } });
		const shown = (noticeModule.modelNoticeFromError as (error: unknown) => unknown)(fromServer);
		check(wordNotice(shown) === `GPT-6.1 Sol has reached your plan's usage limit. Nothing was lost. It resets ${lines.clockWhen(resetsAt)}.`, `the page words the quota from quotaWay, got "${wordNotice(shown)}"`);
		const old = new ApiRequestError("GPT-6.1 Sol has reached your plan's usage limit. Nothing was lost.", 503, "model_unreachable", { detail: "quota", provider: "openai-codex", model: "gpt-6.1-sol" });
		check(wordNotice((noticeModule.modelNoticeFromError as (error: unknown) => unknown)(old)) === "GPT-6.1 Sol has reached your plan's usage limit. Nothing was lost.", "a notice with no quotaWay keeps the server's sentence");
	}
}

// --- A plan that resets within ten minutes is still a spent plan, never busy ---
{
	const soon = "You have hit your ChatGPT usage limit (plus plan). Try again in ~7 min.";
	const failure = classifyModelFailure(workerError(soon));
	check(failure.cause === "unreachable" && (failure as { detail?: string }).detail === "quota", `a plan resetting in 7 minutes is a quota, got ${JSON.stringify(failure)}`);
	check(causes.turnFailureOf(soon, false, "openai-codex") === "quota", `the chat reads it as a quota, got ${causes.turnFailureOf(soon, false, "openai-codex")}`);
	const way = quotaWayOf("openai-codex", soon);
	const minutes = way.resetsAt ? Math.round((Date.parse(way.resetsAt) - Date.now()) / 60_000) : NaN;
	check(way.kind === "sign-in" && Math.abs(minutes - 7) <= 1, `its reset carries through, got ${JSON.stringify(way)}`);
	// Gemini's per-minute limit says "plan and billing" and names a short wait: still busy.
	const gemini = "429 You exceeded your current quota, please check your plan and billing details. Please retry in 32.5s.";
	check(classifyModelFailure(workerError(gemini)).cause === "busy", `a per-minute quota with a short wait stays busy, got ${JSON.stringify(classifyModelFailure(workerError(gemini)))}`);
}

// A plan whose reset is already behind when the provider answers ("~0 min"): it has reset, never "later".
{
	const passed = "You have hit your ChatGPT usage limit (plus plan). Try again in ~0 min.";
	const way = quotaWayOf("openai-codex", passed);
	check(way.kind === "sign-in" && typeof way.resetsAt === "string" && Date.parse(way.resetsAt) <= Date.now(), `a reset of 0 minutes is a reset that has passed, got ${JSON.stringify(way)}`);
	check(quotaWayOn(way) === "It has reset: try again.", `the cards' way on for a reset already behind, got "${quotaWayOn(way)}"`);
	check(lines.quotaOffersTryAgain(way as never) === true, "a reset already behind offers Try again");
	const chat = (turnFailureLine as any)("GPT 6", "quota", "openai-codex", way);
	check(chat === "GPT 6 has reached your plan's usage limit. Nothing was lost. It has reset: try again, or choose another model in Room settings, Model.", `the chat's line for a reset already behind, got "${chat}"`);
	const notice = new causes.ModelUnreachableError("quota", { provider: "openai-codex", model: "gpt-6.1-sol", label: "GPT-6.1 Sol" }, workerError(passed));
	check(notice.message === "GPT-6.1 Sol has reached your plan's usage limit. Nothing was lost. It has reset: try again.", `the Memory notice for a reset already behind, got "${notice.message}"`);
}

// --- A plan's reset: always a clock time in the wait line's form, with the day when it is not today ---
{
	const inMs = (ms: number) => new Date(Date.now() + ms).toISOString();
	const reset = (ms: number) => quotaWayOn({ kind: "sign-in", provider: "ChatGPT", resetsAt: inMs(ms) });
	// Pinned to a minute that is not about to turn, so the expectation and the line read the same minute.
	const steady = (ms: number) => { const at = new Date(Date.now() + ms); at.setSeconds(30, 0); return at; };
	const soonAt = steady(42 * 60_000);
	const soonWords = quotaWayOn({ kind: "sign-in", provider: "ChatGPT", resetsAt: soonAt.toISOString() });
	const sameDay = soonAt.toDateString() === new Date().toDateString();
	const clock = lines.clockTime(soonAt.toISOString());
	check(soonWords === `It resets ${sameDay ? "at" : "tomorrow at"} ${clock}.`, `a reset within the hour says its clock time, got "${soonWords}"`);
	check(!/\bin (?:a|about)\b/.test(reset(30_000)) && reset(30_000).startsWith("It resets "), `under a minute, a clock time too, got "${reset(30_000)}"`);
	const otherDay = steady(3 * 24 * 3_600_000);
	const otherWords = quotaWayOn({ kind: "sign-in", provider: "ChatGPT", resetsAt: otherDay.toISOString() });
	check(otherWords === `It resets on ${otherDay.toLocaleDateString(undefined, { day: "numeric", month: "short" })} at ${lines.clockTime(otherDay.toISOString())}.`, `a reset on another day names the day, got "${otherWords}"`);
	const clockWhen: ((iso: string, now?: Date) => string) | undefined = (lines as any).clockWhen;
	check(typeof clockWhen === "function", "the clock time comes from the wait line's one formatter, exported for both");
	if (clockWhen) {
		const now = new Date(2026, 9, 21, 10, 0);
		check(clockWhen(new Date(2026, 9, 21, 15, 40).toISOString(), now) === `at ${lines.clockTime(new Date(2026, 9, 21, 15, 40).toISOString())}`, `the same day, got "${clockWhen(new Date(2026, 9, 21, 15, 40).toISOString(), now)}"`);
		check(clockWhen(new Date(2026, 9, 22, 9, 10).toISOString(), now) === `tomorrow at ${lines.clockTime(new Date(2026, 9, 22, 9, 10).toISOString())}`, `the next day, got "${clockWhen(new Date(2026, 9, 22, 9, 10).toISOString(), now)}"`);
		const later = new Date(2026, 9, 23, 9, 10);
		const day = later.toLocaleDateString(undefined, { day: "numeric", month: "short" });
		check(clockWhen(later.toISOString(), now) === `on ${day} at ${lines.clockTime(later.toISOString())}`, `a later day, got "${clockWhen(later.toISOString(), now)}"`);
		const hours = reset(3 * 3_600_000);
		check(hours === `It resets ${clockWhen(inMs(3 * 3_600_000))}.`, `from an hour on, a clock time, got "${hours}"`);
	}
	check(modelWaitLine({ cause: "busy", detail: "rate-limit", attempt: 2, nextTryAt: new Date(2026, 9, 21, 16, 24).toISOString() }) === `The Memory model is busy. Trying again at ${lines.clockTime(new Date(2026, 9, 21, 16, 24).toISOString())}.`, `the wait line keeps its clock, got "${modelWaitLine({ cause: "busy", detail: "rate-limit", attempt: 2, nextTryAt: new Date(2026, 9, 21, 16, 24).toISOString() })}"`);
	// A plan with no known reset: Try again later, and no Try again button where it is sure to fail.
	const offers: ((way: QuotaWay | undefined) => boolean) | undefined = (lines as any).quotaOffersTryAgain;
	check(typeof offers === "function" && offers({ kind: "sign-in", provider: "ChatGPT" }) === false && offers({ kind: "sign-in", provider: "ChatGPT", resetsAt: inMs(42 * 60_000) }) === true && offers({ kind: "key", provider: "OpenAI" }) === true, "Try again is offered unless a plan's reset is unknown");
	check((memoryModelStopWayOn as any)("quota", undefined, { kind: "sign-in", provider: "ChatGPT" }) === "Try again later.", `a card's way on with no known reset, got "${(memoryModelStopWayOn as any)("quota", undefined, { kind: "sign-in", provider: "ChatGPT" })}"`);
}

// --- A 403 in chat uses the memory words, with no Try again ----------------------------
{
	const failure = causes.turnFailureOf('403 {"type":"error","error":{"type":"permission_error","message":"Country, region, or territory not supported"}}', false, "anthropic-api-key");
	check(failure === "region-or-plan", `a 403 in chat is refused for region or plan, got ${failure}`);
	const shown = (turnFailureLine as any)("GPT 6", "region-or-plan", "openai");
	check(shown === "GPT 6 refused this request: it may not be offered in your region or on your plan. Nothing was lost. Choose another model in Room settings, Model.", `the chat's 403 line, got "${shown}"`);
}

// --- On a shared server ---------------------------------------------------------------
check(unreachedWayOn("connection") === "Check your internet connection, then try again.", "the desktop's connection way on stays");
check((memoryModelStopWayOn as any)("gateway-refused") === "", "on this computer a memory card's gateway refusal leaves its way on to the Replace key button");
check(modelUnreachableSentence("gateway-refused" as never, model) === "Claude Sonnet 5 refused this request: the gateway may not accept the saved key, or the model may not be offered to you. Nothing was lost.", `on this computer the Memory notice's gateway refusal is unchanged, got "${modelUnreachableSentence("gateway-refused" as never, model)}"`);
check((unreachedWayOn as any)("connection", true) === "Try again in a moment; if it repeats, tell your admin.", `a shared server's connection way on, got "${(unreachedWayOn as any)("connection", true)}"`);
check((turnFailureLine as any)("GPT 6", "connection", "openai", undefined, true) === "GPT 6 could not be reached. Nothing was lost. Try again in a moment; if it repeats, tell your admin.", `the chat's connection line on a shared server, got "${(turnFailureLine as any)("GPT 6", "connection", "openai", undefined, true)}"`);
{
	const realFetch = globalThis.fetch;
	globalThis.fetch = (async () => new Response(JSON.stringify({ remote: false, capability: "full", sharedServer: true }), { status: 200, headers: { "content-type": "application/json" } })) as typeof fetch;
	try { await fetchRemoteClientContext(); } finally { globalThis.fetch = realFetch; }
	check((memoryModelStopWayOn as any)("not-answering", "connection") === "Try again in a moment; if it repeats, tell your admin.", `a memory card's connection way on on a shared server, got "${(memoryModelStopWayOn as any)("not-answering", "connection")}"`);
	// A gateway's bare 403 on a memory screen: as in the chat, the gateway's key is the admin's, so the line says so and no Replace key leads into the locked AI setup.
	check((memoryModelStopWayOn as any)("gateway-refused") === "Tell your admin.", `a memory card's gateway refusal on a shared server tells the admin, got "${(memoryModelStopWayOn as any)("gateway-refused")}"`);
	const pageRequire = (await import("node:module")).createRequire(new URL("../../web-ui/package.json", import.meta.url));
	const { createElement } = pageRequire("react");
	(globalThis as any).React = pageRequire("react");
	const { renderToStaticMarkup } = pageRequire("react-dom/server");
	const component = (file: string) => import(pathToFileURL(path.resolve(path.dirname(fileURLToPath(import.meta.url)), `../../web-ui/src/components/${file}`)).href) as Promise<any>;
	const noop = () => {};
	const buttonsIn = (html: string) => [...html.matchAll(/<button[^>]*>([^<]*)<\/button>/g)].map((match) => match[1]).join("|");
	const gatewayStop = { kind: "outage", model: { provider: "acme-gw", model: "acme-model" }, cause: "gateway-refused", gateway: "Acme Gateway" };
	const reviewRun = { runId: "r1", agentId: "room-1", state: "ready", depth: "tidy", startedAt: "2026-09-14T09:00:00.000Z", updatedAt: "2026-09-14T09:00:00.000Z", progress: { group: 1, groups: 1 }, topics: ["Hiring"], changes: [], leftAsIs: [{ topics: ["Hiring"], reason: "The Memory model could not be reached, so these notes were not tidied." }], budget: { before: 1_000, after: 1_000, budgetTokens: 20_000, savedBudgetTokens: 20_000, overBudgetAfter: false, ceilingTokens: 80_000 }, demotion: { entries: [], keepIds: [], keepTopics: [], overageTokens: 0, protectedOpenItems: 0, counts: { leaving: 0, kept: 0, instead: 0 } }, candidate: null, guidance: null, migration: null, warnings: [], stop: gatewayStop };
	const reviewCard = renderToStaticMarkup(createElement((await component("review-screen.tsx")).ReviewCard, { run: reviewRun, roomName: "Supplier Desk", keepIds: [], busy: false, error: null, onToggleKeep: noop, onToggleKeepTopic: noop, onRaiseBudget: noop, onCancel: noop, onBack: noop, backLabel: "Back", onSave: noop, onClose: noop, onTryAgain: noop, onChooseModel: noop, onSignIn: noop })) as string;
	check(reviewCard.includes("Nothing was lost. Tell your admin.") && buttonsIn(reviewCard) === "Close|Choose another model", `Review's card on a shared server: the admin, and no Replace key, got ${buttonsIn(reviewCard)} in ${JSON.stringify(reviewCard.slice(0, 400))}`);
	const absorbRun = { runId: "a1", agentId: "room-1", state: "ready", startedAt: "2026-09-14T09:00:00.000Z", updatedAt: "2026-09-14T09:00:00.000Z", progress: { folded: 0, total: 1 }, sessions: [{ id: "RC-0001", title: "The call", date: "2026-09-12", outcome: "pending", attempts: 1 }], prepass: { demoted: [] }, budget: reviewRun.budget, demotion: reviewRun.demotion, candidate: null, guidance: null, migration: null, warnings: [], stop: gatewayStop };
	const absorbCard = renderToStaticMarkup(createElement((await component("absorb-run-screen.tsx")).AbsorbRunCard, { run: absorbRun, roomName: "Supplier Desk", keepIds: [], busy: false, error: null, onToggleKeep: noop, onToggleKeepTopic: noop, onRaiseBudget: noop, onApprove: noop, onCancel: noop, onBackToAssessment: noop, onResume: noop, onChooseModel: noop, onSignIn: noop })) as string;
	check(absorbCard.includes("Tell your admin.") && !buttonsIn(absorbCard).includes("Replace key") && buttonsIn(absorbCard).includes("Choose another model"), `Memorize's card on a shared server: the admin, and no Replace key, got ${buttonsIn(absorbCard)}`);
	const notice = renderToStaticMarkup(createElement((await component("model-notice.tsx")).ModelNoticePanel, { notice: { detail: "gateway-refused", sentence: "Acme Model refused this request. Nothing was lost. Tell your admin.", provider: "acme-gw" }, onTryAgain: noop, onChooseModel: noop, onSignIn: noop })) as string;
	check(buttonsIn(notice) === "Choose another model", `the first read's notice on a shared server offers no Replace key, got ${buttonsIn(notice)}`);
}
// --- the step back hands back only the message the room shows, with who can lift a spent limit ---
{
	const { stepBackFromFailedPrompt } = await import("../src/failed-prompt-step-back.js");
	const fakeSession = (sent: string, failed: { provider: string; model: string; errorMessage: string }) => {
		const entries = new Map<string, any>([
			["u1", { id: "u1", parentId: null, type: "message", message: { role: "user", content: [{ type: "text", text: sent }] } }],
			["a1", { id: "a1", parentId: "u1", type: "message", message: { role: "assistant", stopReason: "error", content: [], ...failed } }],
		]);
		return {
			sessionManager: { getLeafEntry: () => entries.get("a1"), getEntry: (id: string) => entries.get(id), appendCustomEntry: () => "c1" },
			navigateTree: async () => ({ cancelled: false }),
		};
	};
	const restored = "[RESTORED PERSISTENT ROOM LIVE THREAD CONTEXT]\nThis persistent-agent room was resumed from its saved live-thread transcript.\n[END RESTORED PERSISTENT ROOM LIVE THREAD CONTEXT]\n\nWhat changed?";
	const busy = { provider: "anthropic-api-key", model: "claude-sonnet-5", errorMessage: "529 {\"type\":\"error\",\"error\":{\"type\":\"overloaded_error\",\"message\":\"Overloaded\"}}" };
	const legacy = await (stepBackFromFailedPrompt as any)(fakeSession(restored, busy), { shown: "What changed?" });
	check(legacy === undefined, `a message the room shows otherwise (a restored block before it) is never handed back, got ${JSON.stringify(legacy?.text)}`);
	const typed = await (stepBackFromFailedPrompt as any)(fakeSession("What changed?", busy), { shown: " What changed? " });
	check(typed?.text === "What changed?", `the message the room shows is handed back, got ${JSON.stringify(typed)}`);
	const spent = await (stepBackFromFailedPrompt as any)(fakeSession("Summarise this.", { provider: "openai", model: "gpt-5.5", errorMessage: "429 You exceeded your current quota, please check your plan and billing details. insufficient_quota" }), { shown: "Summarise this." });
	check(spent?.failure === "quota" && spent?.quotaWay?.kind === "key", `a spent key's hand-back carries who can lift it, got ${JSON.stringify(spent)}`);
	const handBack = (name: string, returned: lines.ReturnedPromptFrame, shared: boolean) => lines.failureLineText(lines.returnedFailureLine(name, returned, shared), "lost");
	if (spent?.quotaWay) {
		const line = handBack("GPT-5.5", spent, false);
		check(line.includes(`Check your plan or balance with ${spent.quotaWay.provider}, or choose another model in Room settings, Model.`), `a spent key's hand-back line keeps its way on, got "${line}"`);
	}
	const keyLine = handBack("GPT-5.5", { text: "x", failure: "quota", model: { provider: "openai", model: "gpt-5.5" }, quotaWay: { kind: "key", provider: "OpenAI" } }, false);
	check(keyLine === "GPT-5.5 has reached its usage limit or run out of credit. Nothing was lost. Check your plan or balance with OpenAI, or choose another model in Room settings, Model.", `the hand-back line uses the way on it carries, got "${keyLine}"`);
	// A summary between two failed attempts: stepping back over it would leave the paid summary on an abandoned branch.
	const overflow = { provider: "anthropic-api-key", model: "claude-sonnet-5", errorMessage: "prompt is too long: 210000 tokens > 200000 maximum" };
	for (const boundary of ["compaction", "branch_summary"]) {
		const entries = new Map<string, any>([
			["u1", { id: "u1", parentId: null, type: "message", message: { role: "user", content: [{ type: "text", text: "Summarise this." }] } }],
			["e1", { id: "e1", parentId: "u1", type: "message", message: { role: "assistant", stopReason: "error", content: [], ...overflow } }],
			["c1", { id: "c1", parentId: "e1", type: boundary, summary: "The conversation so far." }],
			["e2", { id: "e2", parentId: "c1", type: "message", message: { role: "assistant", stopReason: "error", content: [], ...overflow } }],
		]);
		const moves: string[] = [];
		const across = await (stepBackFromFailedPrompt as any)({
			sessionManager: { getLeafEntry: () => entries.get("e2"), getEntry: (id: string) => entries.get(id), appendCustomEntry: () => "m1" },
			navigateTree: async (id: string) => { moves.push(id); return { cancelled: false }; },
		}, { shown: "Summarise this." });
		check(across === undefined && moves.length === 0, `the step back never crosses a ${boundary} entry, got ${JSON.stringify(across?.text)} and moves ${JSON.stringify(moves)}`);
	}
}

registerServerHooks({});
check(JSON.stringify(quotaWayOf("anthropic-api-key")) === JSON.stringify({ kind: "shared" }), `on a shared server the Claude key's way is the admin, got ${JSON.stringify(quotaWayOf("anthropic-api-key"))}`);
check(modelUnreachableSentence("quota", model) === "Claude Sonnet 5 has reached its usage limit or run out of credit. Nothing was lost. Tell your admin.", `the Memory notice's quota on a shared server, got "${modelUnreachableSentence("quota", model)}"`);
check(modelUnreachableSentence("not-answering", model, undefined, "connection" as never) === "Claude Sonnet 5 could not be reached. Nothing was lost. Try again in a moment; if it repeats, tell your admin.", `the Memory notice's connection line on a shared server, got "${modelUnreachableSentence("not-answering", model, undefined, "connection" as never)}"`);
check(modelUnreachableSentence("gateway-refused" as never, model) === "Claude Sonnet 5 refused this request: the gateway may not accept the saved key, or the model may not be offered to you. Nothing was lost. Tell your admin.", `the Memory notice's gateway refusal on a shared server tells the admin, got "${modelUnreachableSentence("gateway-refused" as never, model)}"`);

// A failure that ended while nobody was in the room is worded on the way in: on a shared server
// its way on is the admin, as the live line's is.
{
	const handBack = (name: string, returned: lines.ReturnedPromptFrame, shared: boolean) => lines.failureLineText(lines.returnedFailureLine(name, returned, shared), "lost");
	{
	const connection = handBack("GPT-5.5", { text: "hello", failure: "connection", model: { provider: "openai", model: "gpt-5.5" } }, true);
	check(connection === "GPT-5.5 could not be reached. Nothing was lost. Try again in a moment; if it repeats, tell your admin.", `a connection hand-back on a shared server tells the admin, got "${connection}"`);
	const quota = handBack("Claude Sonnet 5", { text: "hello", failure: "quota", model: { provider: "anthropic-api-key", model: "claude-sonnet-5" } }, true);
	check(quota === "Claude Sonnet 5 has reached its usage limit or run out of credit. Nothing was lost. Tell your admin, or choose another model in Room settings, Model.", `a quota hand-back on a shared server tells the admin, got "${quota}"`);
	check(handBack("GPT-5.5", { text: "hello", failure: "connection", model: { provider: "openai", model: "gpt-5.5" } }, false).endsWith("Check your internet connection, then try again."), "on someone's own computer the connection line is unchanged");
	check(handBack("GPT-5.5", { text: "hello", stopped: true }, true) === lines.STOPPED_LINE, "a stopped hand-back keeps the Stop line");
	}
}

// A plan's reset that has passed: Try again shows, and says so; a saved line is worded again when it is shown.
{
	const past = { kind: "sign-in" as const, provider: "ChatGPT", resetsAt: new Date(Date.now() - 5 * 60_000).toISOString() };
	const soon = { kind: "sign-in" as const, provider: "ChatGPT", resetsAt: new Date(Date.now() + 42 * 60_000 + 20_000).toISOString() };
	const unknown = { kind: "sign-in" as const, provider: "ChatGPT" };
	check(lines.quotaOffersTryAgain(past) === true, "a plan whose reset has passed offers Try again");
	check(lines.quotaOffersTryAgain(unknown) === false, "a plan whose reset is unknown still hides Try again");
	check(lines.quotaWayOn(past) === "It has reset: try again.", `a passed reset on the cards, got "${lines.quotaWayOn(past)}"`);
	const shownAgain = (text: string, way: lines.QuotaWay) => lines.savedFailureLineShown({ text, failure: "quota", quotaWay: way }).text;
	{
		const saved = "GPT-5.5 has reached your plan's usage limit. Nothing was lost. It resets in about 42 minutes: try again then, or choose another model in Room settings, Model.";
		check(shownAgain(saved, past) === "GPT-5.5 has reached your plan's usage limit. Nothing was lost. It has reset: try again, or choose another model in Room settings, Model.", `a saved line whose reset has passed, got "${shownAgain(saved, past)}"`);
		check(shownAgain(saved, soon) === `GPT-5.5 has reached your plan's usage limit. Nothing was lost. It resets ${lines.clockWhen(soon.resetsAt)}: try again then, or choose another model in Room settings, Model.`, `a saved line whose reset is still ahead says its clock time, got "${shownAgain(saved, soon)}"`);
		const kept = saved.replace("Nothing was lost.", "Your message is back in the box.");
		check(shownAgain(kept, past) === "GPT-5.5 has reached your plan's usage limit. Your message is back in the box. It has reset: try again, or choose another model in Room settings, Model.", "the middle sentence stays as it was");
	}
}

// The newest failure line: one button per way on it names, only where it can work, and its
// words lose only what a button does. Read optionally, so a build without them fails by name.
{
	type Buttons = { tryAgain: boolean; chooseModel: boolean; replaceKey: boolean; reviewMemory?: boolean };
	const buttonsOf = (lines as Record<string, unknown>).failureButtons as ((cause: string | undefined, way: QuotaWay | undefined, shared: boolean) => Buttons) | undefined;
	const wordsOf = (lines as Record<string, unknown>).failureLineWords as ((text: string, buttons: Buttons) => string) | undefined;
	// A line as saved, without its fields, is read into them once on the way in: then its cause and the rest.
	const partsOf = (text: string) => lines.failureLineParts(lines.savedFailureLineShown({ text }));
	check(typeof buttonsOf === "function", "the newest line's buttons are decided in one place");
	check(typeof wordsOf === "function", "the newest line's words are said in one place");
	if (buttonsOf) {
		const named = (cause: string | undefined, way?: QuotaWay, shared = false) => {
			const buttons = buttonsOf(cause, way, shared);
			return [buttons.tryAgain && "Try again", buttons.reviewMemory && "Review memory", buttons.chooseModel && "Choose another model", buttons.replaceKey && "Replace key"].filter(Boolean).join("|");
		};
		const passed = { kind: "sign-in", provider: "ChatGPT", resetsAt: new Date(Date.now() - 5 * 60_000).toISOString() };
		const ahead = { kind: "sign-in", provider: "ChatGPT", resetsAt: new Date(Date.now() + 42 * 60_000).toISOString() };
		const expected: Array<[string | undefined, QuotaWay | undefined, boolean, string]> = [
			["quota", { kind: "key", provider: "OpenAI" }, false, "Choose another model"],
			["quota", { kind: "claude-key" }, false, "Choose another model"],
			["quota", { kind: "gateway", provider: "Acme gateway" }, false, "Choose another model"],
			["quota", { kind: "shared" }, true, "Choose another model"],
			["quota", ahead, false, "Choose another model"],
			["quota", { kind: "sign-in", provider: "ChatGPT" }, false, "Choose another model"],
			["quota", passed, false, "Try again|Choose another model"],
			["other", undefined, false, "Try again|Choose another model"],
			["empty-answer", undefined, false, "Try again|Choose another model"],
			["connection", undefined, false, "Try again"],
			["connection", undefined, true, "Try again"],
			["local-connection", undefined, false, "Try again"],
			["cut-off", undefined, false, "Try again"],
			["still-busy", undefined, false, "Try again"],
			["region-or-plan", undefined, false, "Choose another model"],
			["refused", undefined, false, "Choose another model"],
			["too-large", undefined, false, "Choose another model"],
			["not-on-account", undefined, false, "Choose another model"],
			["not-offered", undefined, false, "Choose another model"],
			["overflow", undefined, false, "Review memory|Choose another model"],
			["message-over-window", undefined, false, "Choose another model"],
			["conversation-over-window", undefined, false, "Choose another model"],
			["window-set-larger", undefined, false, "Choose another model"],
			["window-set-larger", undefined, true, "Choose another model"],
			["gateway-refused", undefined, false, "Choose another model|Replace key"],
			["gateway-refused", undefined, true, "Choose another model"],
			[undefined, undefined, false, ""],
		];
		for (const [cause, way, shared, buttons] of expected) {
			check(named(cause, way, shared) === buttons, `the newest ${cause ?? "uncaused"} line${way ? ` (${way.kind}${way.resetsAt ? `, reset ${Date.parse(way.resetsAt) < Date.now() ? "passed" : "ahead"}` : ""})` : ""}${shared ? " on a shared server" : ""} offers ${JSON.stringify(buttons)}, got ${JSON.stringify(named(cause, way, shared))}`);
		}
		if (wordsOf) {
			const newest = (text: string, cause: string, way?: QuotaWay, shared = false) => wordsOf(text, buttonsOf(cause, way, shared));
			const gatewayCause = "refused this request: the gateway may not accept the saved key, or the model may not be offered to you";
			const pairs: Array<[string, string, QuotaWay | undefined, boolean, string]> = [
				["GPT 6 has reached its usage limit or run out of credit. Your message is back in the box. Check your plan or balance with OpenAI, or choose another model in Room settings, Model.", "quota", { kind: "key", provider: "OpenAI" }, false, "GPT 6 has reached its usage limit or run out of credit. Your message is back in the box. Check your plan or balance with OpenAI, or choose another model."],
				["GPT 6 refused this request: it may not be offered in your region or on your plan. Your message is back in the box. Choose another model in Room settings, Model.", "region-or-plan", undefined, false, "GPT 6 refused this request: it may not be offered in your region or on your plan. Your message is back in the box."],
				[`Acme Model ${gatewayCause}. Your message is back in the box. Replace the gateway's key in Settings, AI setup, or choose another model in Room settings, Model.`, "gateway-refused", undefined, false, `Acme Model ${gatewayCause}. Your message is back in the box. Replace the gateway's key, or choose another model.`],
				[`Acme Model ${gatewayCause}. Your message is back in the box. Tell your admin, or choose another model in Room settings, Model.`, "gateway-refused", undefined, true, `Acme Model ${gatewayCause}. Your message is back in the box. Tell your admin, or choose another model.`],
				["GPT 6 could not answer this message. Your message is still above. Try again; if it repeats, choose another model in Room settings, Model.", "other", undefined, false, "GPT 6 could not answer this message. Your message is still above. Try again; if it repeats, choose another model."],
				["GPT 6 could not respond: the conversation plus this room's memory are more than it can read at once. Your message is back in the box. Run Review from Maintain to shrink memory, or continue on a model that can read more at once in Room settings, Model.", "overflow", undefined, false, "GPT 6 could not respond: the conversation plus this room's memory are more than it can read at once. Your message is back in the box. Run Review from Maintain to shrink memory, or continue on a model that can read more at once."],
				["GPT 6 can't read this conversation and the room's memory at once. Your message is back in the box. Shrink memory with Review from Maintain, or continue on a model that can read more at once in Room settings, Model.", "overflow", undefined, false, "GPT 6 can't read this conversation and the room's memory at once. Your message is back in the box. Shrink memory with Review, or continue on a model that can read more at once."],
				["GPT 6 can't read this message at once. Your message is back in the box. Shorten it, or continue on a model that can read more at once in Room settings, Model.", "message-over-window", undefined, false, "GPT 6 can't read this message at once. Your message is back in the box. Shorten it, or continue on a model that can read more at once."],
				["Acme Model can read only 8,192 tokens at once, less than the context window set in AI setup (32,768). Your message is back in the box. Correct it in AI setup, or choose another model in Room settings, Model.", "window-set-larger", undefined, false, "Acme Model can read only 8,192 tokens at once, less than the context window set in AI setup (32,768). Your message is back in the box. Correct it in AI setup, or choose another model."],
				["Acme Model can read only 8,192 tokens at once, less than the context window set for it (32,768). Your message is back in the box. Tell your admin, or choose another model in Room settings, Model.", "window-set-larger", undefined, true, "Acme Model can read only 8,192 tokens at once, less than the context window set for it (32,768). Your message is back in the box. Tell your admin, or choose another model."],
				["GPT 6 can't read this conversation at once. Your message is back in the box. Continue on a model that can read more at once in Room settings, Model.", "conversation-over-window", undefined, false, "GPT 6 can't read this conversation at once. Your message is back in the box. Continue on a model that can read more at once."],
				["GPT 6 could not be reached. Your message is back in the box. Check your internet connection, then try again.", "connection", undefined, false, "GPT 6 could not be reached. Your message is back in the box. Check your internet connection, then try again."],
				// A sentence that only says what the Try again button does goes; one that says when, or what to do first, stays.
				["GPT 6 stopped in the middle of its answer. Your message is back in the box. Try again.", "cut-off", undefined, false, "GPT 6 stopped in the middle of its answer. Your message is back in the box."],
				["GPT 6 is still busy after several tries. Your message is back in the box. Try again in a minute.", "still-busy", undefined, false, "GPT 6 is still busy after several tries. Your message is back in the box. Try again in a minute."],
			];
			for (const [text, cause, way, shared, shown] of pairs) check(newest(text, cause, way, shared) === shown, `the newest ${cause} line${shared ? " on a shared server" : ""} reads ${JSON.stringify(shown)}, got ${JSON.stringify(newest(text, cause, way, shared))}`);
			// The overflow line names memory only where the conversation and memory overflow; the message alone has its own line.
			const overflowOf = (name: string) => lines.failureLineText(lines.overflowLine(name), "lost");
			const overWindowOf = (name: string) => lines.failureLineText(lines.messageOverWindowLine(name), "lost");
			check(overflowOf?.("GPT 6") === "GPT 6 can't read this conversation and the room's memory at once. Nothing was lost. Shrink memory with Review from Maintain, or continue on a model that can read more at once in Room settings, Model.", `the overflow line, got ${JSON.stringify(overflowOf?.("GPT 6"))}`);
			check(overWindowOf?.("GPT 6") === "GPT 6 can't read this message at once. Nothing was lost. Shorten it, or continue on a model that can read more at once in Room settings, Model.", `the line for a message larger than the model reads at once, got ${JSON.stringify(overWindowOf?.("GPT 6"))}`);
			// A model that reads less than the window set for it: the provider's words name its limit, and that is the cause, before any other.
			type Facts = { modelName: string; words: string; messageOverWindow: boolean; memoryEmpty: boolean; windowSetInSetup?: number; shared: boolean };
			const overflowLineOf = (facts: Facts) => { const chosen = lines.overflowLineOf(facts); return { parts: chosen.parts, text: lines.failureLineText(chosen.parts, "lost"), cause: chosen.failure }; };
			const namedLimitOf = (lines as Record<string, unknown>).namedContextLimit as ((words: string) => number | undefined) | undefined;
			check(typeof namedLimitOf === "function", "the limit a provider names is read in one place");
			if (namedLimitOf) {
				const named: Array<[string, number | undefined]> = [
					["400 This model's maximum context length is 8192 tokens. However, your messages resulted in 9100 tokens. Please reduce the length of the messages.", 8192],
					["litellm.ContextWindowExceededError: ContextWindowExceededError: OpenAIException - This model's maximum context length is 8192 tokens.", 8192],
					["400 This model's maximum context length is 4096 tokens. However, you requested 5000 tokens (4000 in the messages, 1000 in the completion). Please reduce the length of the messages or completion.", 4096],
					["400 The decoder prompt (length 5000) is longer than the maximum model length of 4096. Make sure that `max_model_len` is no smaller than the number of text tokens.", 4096],
					["400 Trying to keep the first 5000 tokens when context the overflows. However, the model is loaded with context length of only 4096 tokens, which is not enough. Try to load the model with a larger context length, or provide a shorter input", 4096],
					["400 the request exceeds the available context size (4096 tokens), try increasing it", 4096],
					["Prompt contains 40000 tokens, too large for model with 32768 maximum context length", 32768],
					["422 Input validation error: `inputs` tokens + `max_new_tokens` must be <= 4096. Given: 5000 `inputs` tokens and 100 `max_new_tokens`", 4096],
					['400 {"type":"error","error":{"type":"invalid_request_error","message":"prompt is too long: 212345 tokens > 200000 maximum"}}', 200000],
					["This model's maximum context length is 128,000 tokens.", 128000],
					["400 prompt too long; exceeded max context length by 100 tokens", undefined],
					["400 the input length exceeds the context length", undefined],
					["Validation error: Input is too long for requested model.", undefined],
				];
				for (const [words, limit] of named) check(namedLimitOf(words) === limit, `${JSON.stringify(words.slice(0, 70))} names the limit ${limit ?? "nowhere"}, got ${namedLimitOf(words)}`);
			}
			{
				const smaller = "400 This model's maximum context length is 8192 tokens. However, your messages resulted in 9100 tokens.";
				const unnamed = "400 the input length exceeds the context length";
				const facts = (over: Partial<Facts>): Facts => ({ modelName: "Acme Model", words: smaller, messageOverWindow: false, memoryEmpty: false, windowSetInSetup: 32_768, shared: false, ...over });
				const chosen: Array<[string, Facts, string, string]> = [
					["a smaller named limit on this computer, the room with memory: C1 before the memory line", facts({}), "window-set-larger", "Acme Model can read only 8,192 tokens at once, less than the context window set in AI setup (32,768). Nothing was lost. Correct it in AI setup, or choose another model in Room settings, Model."],
					["a smaller named limit on a shared server", facts({ shared: true }), "window-set-larger", "Acme Model can read only 8,192 tokens at once, less than the context window set for it (32,768). Nothing was lost. Tell your admin, or choose another model in Room settings, Model."],
					["a smaller named limit in a room with nothing in memory", facts({ memoryEmpty: true }), "window-set-larger", "Acme Model can read only 8,192 tokens at once, less than the context window set in AI setup (32,768). Nothing was lost. Correct it in AI setup, or choose another model in Room settings, Model."],
					["a smaller named limit and a message over the window", facts({ messageOverWindow: true }), "window-set-larger", "Acme Model can read only 8,192 tokens at once, less than the context window set in AI setup (32,768). Nothing was lost. Correct it in AI setup, or choose another model in Room settings, Model."],
					["a named limit no smaller than the window set: the memory line", facts({ windowSetInSetup: 8192 }), "overflow", "Acme Model can't read this conversation and the room's memory at once. Nothing was lost. Shrink memory with Review from Maintain, or continue on a model that can read more at once in Room settings, Model."],
					["a built-in provider's own window: the memory line", facts({ windowSetInSetup: undefined }), "overflow", "Acme Model can't read this conversation and the room's memory at once. Nothing was lost. Shrink memory with Review from Maintain, or continue on a model that can read more at once in Room settings, Model."],
					["no named limit, a room with nothing in memory, the message fits: C2", facts({ words: unnamed, memoryEmpty: true }), "conversation-over-window", "Acme Model can't read this conversation at once. Nothing was lost. Continue on a model that can read more at once in Room settings, Model."],
					["a built-in provider's limit, a room with nothing in memory, the message fits: C2", facts({ windowSetInSetup: undefined, memoryEmpty: true }), "conversation-over-window", "Acme Model can't read this conversation at once. Nothing was lost. Continue on a model that can read more at once in Room settings, Model."],
					["no named limit, a message over the window by itself: the message line", facts({ words: unnamed, memoryEmpty: true, messageOverWindow: true }), "message-over-window", "Acme Model can't read this message at once. Nothing was lost. Shorten it, or continue on a model that can read more at once in Room settings, Model."],
					["no named limit, a room with memory: the memory line", facts({ words: unnamed }), "overflow", "Acme Model can't read this conversation and the room's memory at once. Nothing was lost. Shrink memory with Review from Maintain, or continue on a model that can read more at once in Room settings, Model."],
				];
				for (const [label, given, cause, text] of chosen) {
					const got = overflowLineOf(given);
					check(got.cause === cause && got.text === text, `${label}: ${cause}, ${JSON.stringify(text)}, got ${JSON.stringify(got)}`);
				}
				// Where the message is follows the rule every line follows.
				const c1 = overflowLineOf(facts({}));
				const c1Back = lines.lineWithMessage({ text: c1.text, parts: c1.parts }, "back");
				const c1Kept = lines.lineWithMessage({ text: c1.text, parts: c1.parts }, "above");
				check(c1Back.text.includes("(32,768). Your message is back in the box. Correct it") && c1Back.messageBack === true, `C1 says the message is back in the box once it is, got ${JSON.stringify(c1Back)}`);
				check(c1Kept.text.includes("(32,768). Your message is still above. Correct it") && c1Kept.messageAbove === true, `C1 says the message is still above while it stays, got ${JSON.stringify(c1Kept)}`);
				check(lines.failureLineParts(c1Back).cause === "Acme Model can read only 8,192 tokens at once, less than the context window set in AI setup (32,768).", `C1's cause is its first sentence, got ${JSON.stringify(lines.failureLineParts(c1Back))}`);
			}
			const plain = "The model could not answer this message. Nothing was lost. Try again; if it repeats, choose another model in Room settings, Model.";
			check(wordsOf(plain, { tryAgain: false, chooseModel: false, replaceKey: false }) === plain, `a line with no buttons keeps every word, got ${JSON.stringify(wordsOf(plain, { tryAgain: false, chooseModel: false, replaceKey: false }))}`);
		}
	}
	{
		const parts: Array<[string, string, string]> = [
			["Claude Haiku 5.5 has reached its usage limit or run out of credit. Your message is back in the box. Check the balance at console.anthropic.com.", "Claude Haiku 5.5 has reached its usage limit or run out of credit.", "Your message is back in the box. Check the balance at console.anthropic.com."],
			["Claude Haiku 5.5 can't read this conversation and the room's memory at once. Your message is back in the box. Shrink memory with Review, or continue on a model that can read more at once.", "Claude Haiku 5.5 can't read this conversation and the room's memory at once.", "Your message is back in the box. Shrink memory with Review, or continue on a model that can read more at once."],
			["This room's model, Acme Inc. Model on Acme, is no longer offered. Your message is still above. Choose another model in Room settings, Model.", "This room's model, Acme Inc. Model on Acme, is no longer offered.", "Your message is still above. Choose another model in Room settings, Model."],
			["The room could not shorten this conversation enough for Claude Haiku 5.5. Your memory is unchanged.", "The room could not shorten this conversation enough for Claude Haiku 5.5.", "Your memory is unchanged."],
			["Response interrupted: the connection was lost.", "Response interrupted: the connection was lost.", ""],
		];
		for (const [text, cause, rest] of parts) {
			const read = partsOf(text);
			check(read.cause === cause && read.rest === rest, `a line reads as its cause, then the rest: ${JSON.stringify(text.slice(0, 50))} gave ${JSON.stringify(read)}`);
		}
	}
	// A line saved before its words were kept as fields is read into them once on the way in, its words as they were.
	{
		const kept = "GPT 6 isn't available on your account. Your message is still above. Choose another model in Room settings, Model.";
		const read = lines.savedFailureLineShown({ text: kept });
		check(read.text === kept && read.messageAbove === true && read.parts?.cause === "GPT 6 isn't available on your account." && read.parts?.wayOn === "Choose another model in Room settings, Model.", `a saved line says where its message is by its fields, got ${JSON.stringify(read)}`);
		const back = lines.savedFailureLineShown({ text: "Response interrupted by Stop. Your message is back in the box." });
		check(back.messageBack === true && back.text === "Response interrupted by Stop. Your message is back in the box.", `a saved Stop line back in the box keeps its words, got ${JSON.stringify(back)}`);
		// An older order, the way on before where the message is: the way on is read out of the cause, and the line says it in today's order.
		const older = lines.savedFailureLineShown({ text: "GPT 6 isn't available on your account. Choose another model in Room settings, Model. Your message is back in the box." });
		check(older.parts?.cause === "GPT 6 isn't available on your account." && older.parts?.wayOn === "Choose another model in Room settings, Model." && older.messageBack === true && older.text === "GPT 6 isn't available on your account. Your message is back in the box. Choose another model in Room settings, Model.", `a line saved with the way on first reads it out of the cause, got ${JSON.stringify(older)}`);
		const plain = lines.savedFailureLineShown({ text: "Response interrupted: the connection was lost." });
		check(plain.parts === undefined && plain.messageAbove === undefined && plain.messageBack === undefined, `a line that says nothing of a message gets no fields, got ${JSON.stringify(plain)}`);
	}
	// Try again on a line whose message stayed above sends that message again whole, its files included, or not at all.
	type Carried = { name: string; bytes: number; extension: string };
	const sentAgain = (lines as Record<string, unknown>).messageSentAgain as ((items: unknown[], lineId: string, existingNames?: ReadonlySet<string>) => { text: string; attachments: Carried[] } | null) | undefined;
	check(typeof sentAgain === "function", "what Try again sends again is decided in one place");
	if (sentAgain) {
		const notes: Carried = { name: "notes.txt", bytes: 24, extension: ".txt" };
		const picture: Carried = { name: "chart.png", bytes: 2048, extension: ".png" };
		const line = { kind: "system", id: "line", level: "error", text: "GPT 6 could not answer this message. Your message is still above. Try again." };
		const earlier = [{ kind: "user", id: "u0", text: "Earlier." }, { kind: "assistant", id: "a0", text: "An answer." }];
		const files = new Set(["notes.txt", "chart.png"]);
		const shown = (value: unknown) => JSON.stringify(value);
		check(shown(sentAgain([...earlier, { kind: "user", id: "u1", text: "Summarise this." }, line], "line", files)) === shown({ text: "Summarise this.", attachments: [] }), "typed text is sent again as typed");
		check(shown(sentAgain([...earlier, { kind: "user", id: "u1", text: "Summarise this.", attachments: [notes] }, line], "line", files)) === shown({ text: "Summarise this.", attachments: [notes] }), "a message with a file is sent again with its file");
		check(shown(sentAgain([...earlier, { kind: "user", id: "u1", text: "", attachments: [picture] }, line], "line", files)) === shown({ text: "", attachments: [picture] }), "a picture alone is sent again");
		check(shown(sentAgain([...earlier, { kind: "user", id: "u1", text: "Summarise this.", attachments: [notes] }, line], "line")) === shown({ text: "Summarise this.", attachments: [notes] }), "while the room's files are not read yet, the file is taken as there");
		check(sentAgain([...earlier, { kind: "user", id: "u1", text: "Summarise this.", attachments: [notes] }, line], "line", new Set(["chart.png"])) === null, "a file no longer in the room's Files: nothing is sent again");
		check(sentAgain([...earlier, { kind: "consult", id: "c1" }, { kind: "user", id: "u1", text: "Use what Notes said." }, line], "line", files) === null, "a message a transfer rode ahead of: nothing is sent again");
		check(sentAgain([...earlier, { kind: "task", id: "t1" }, { kind: "user", id: "u1", text: "Use the chart." }, line], "line", files) === null, "a message a specialist's result rode ahead of: nothing is sent again");
		check(shown(sentAgain([{ kind: "consult", id: "c0" }, ...earlier, { kind: "user", id: "u1", text: "Summarise this." }, line], "line", files)) === shown({ text: "Summarise this.", attachments: [] }), "a transfer an earlier message carried does not count");
		check(sentAgain([...earlier, { kind: "user", id: "u1", text: "  " }, line], "line", files) === null, "nothing to send: nothing is sent again");
		check(sentAgain([line], "line", files) === null, "no message above: nothing is sent again");
	}
	const backInBox = lines.lineWithMessage(lines.savedFailureLineShown({ text: "GPT 6 could not answer this message. Your message is still above. Try again." }), "back");
	check(backInBox.text === "GPT 6 could not answer this message. Your message is back in the box. Try again." && backInBox.messageBack === true && backInBox.messageAbove === undefined, `a line that said the message is still above says it is back in the box once it is, got ${JSON.stringify(backInBox)}`);
}

// --- The room could not shorten a conversation: the summary call's own cause, read with the one reader ---
{
	const read = (causes as Record<string, unknown>).compactionFailureOf as ((errorMessage: string, provider: string) => { failure?: string; words?: string; summaryCut: boolean }) | undefined;
	check(typeof read === "function", "a failed summary call is read with the one failure reader");
	if (read) {
		const busy = read('Context overflow recovery failed: Summarization failed: 429 {"type":"error","error":{"type":"rate_limit_error","message":"Number of request tokens has exceeded your per-minute rate limit."}}', "anthropic-api-key");
		check(busy.failure === "still-busy" && (busy.words ?? "").startsWith("429 "), `a rate limit on the summary call is the busy line, with the provider's words, got ${JSON.stringify(busy)}`);
		const dropped = read("Context overflow recovery failed: Summarization failed: Connection error.", "anthropic-api-key");
		check(dropped.failure === "connection", `a lost connection on the summary call is the connection line, got ${JSON.stringify(dropped)}`);
		const cut = read("Auto-compaction failed: Summarization failed: generation hit the token cap and the summary is incomplete", "anthropic-api-key");
		check(cut.failure === undefined && cut.summaryCut && cut.words === undefined, `a summary cut at the output limit is a size problem, in the room's words, got ${JSON.stringify(cut)}`);
		const tooLong = read("Context overflow recovery failed: Summarization failed: prompt is too long: 210000 tokens > 200000 maximum", "anthropic-api-key");
		check(tooLong.failure === undefined && !tooLong.summaryCut && tooLong.words === "prompt is too long: 210000 tokens > 200000 maximum", `a summary call too large is a size problem, its words kept for Details, got ${JSON.stringify(tooLong)}`);
		const nothing = read("Context overflow recovery failed: Nothing to compact (session too small)", "anthropic-api-key");
		check(nothing.failure === undefined && nothing.words === undefined, `the runtime's own refusal is a size problem, with no Details, got ${JSON.stringify(nothing)}`);
	}
	{
		const shorten = (summaryCut: boolean, messageAbove = false) => { const parts = lines.couldNotShortenLine("Claude Haiku 5.5", summaryCut, messageAbove); return { text: lines.failureLineText(parts, messageAbove ? "above" : "lost"), parts }; };
		check(shorten(false).text === "The room could not shorten this conversation enough for Claude Haiku 5.5. Your memory is unchanged. Remember, then continue, or choose a model that reads more at once in Room settings, Model.", `the words stay as they were, got ${JSON.stringify(shorten(false).text)}`);
		const above = shorten(true, true);
		const back = lines.lineWithMessage(above, "back");
		check(lines.failureLineParts(above).cause === "The room could not shorten this conversation enough for Claude Haiku 5.5." && lines.failureLineParts(back).rest.startsWith("Your message is back in the box. Your memory is unchanged."), `the cause first, then where the message is, got ${JSON.stringify(back.text)}`);
		const buttons = lines.failureButtons("could-not-shorten" as never, undefined, false);
		check(buttons.chooseModel && !buttons.tryAgain, `a size problem offers another model and no Try again, got ${JSON.stringify(buttons)}`);
	}
}

// --- More than the model reads at once: the server names it on the frame, whatever else the words say ---
{
	const overflowOf = (words: string) => causes.turnFailureOf(words, false, "anthropic-api-key");
	check(overflowOf("prompt is too long: 210000 tokens > 200000 maximum") === "overflow", `a provider's overflow words are the overflow cause, got ${overflowOf("prompt is too long: 210000 tokens > 200000 maximum")}`);
	check(overflowOf("the request exceeds the available context size (4096 tokens), try increasing it") === "overflow", "words that name the model's limit are the overflow cause");
	check(causes.turnFailureOf("This model's maximum context length is 8192 tokens.", false, "openai", true) === "overflow", "an overflow is read before an answer cut off part way");
	check(overflowOf("Request too large for gpt-6 in organization org-x on tokens per min (TPM): Limit 30000, Requested 50000.") === "too-large", "a per-minute ceiling stays too large, not an overflow");
}

if (failures.length > 0) throw new Error(`failure words by kind:\n  ${failures.join("\n  ")}`);
console.log("failure-words-kinds smoke: ok");
