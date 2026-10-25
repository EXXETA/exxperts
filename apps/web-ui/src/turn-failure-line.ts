// The plain line a room shows when a chat turn fails, and the note while the
// runtime retries it. The server reads the cause from the provider's words,
// and from the status where they name nothing (turnFailureOf and
// retryFailureOf in model-call-causes.ts). Under the line,
// Details holds the provider's own sentence, keys masked; the whole words go
// only to the console.

import type { CredentialKey } from "../../web-server/src/model-not-offered";

/** A model that could not be reached: over the internet, or at an address on this computer, where a local model's app answers. */
export type Unreached = "connection" | "local-connection";

/**
 * A failed turn's cause: a spent usage limit or credit, still busy once the runtime's own retries gave up, a dropped connection, a refusal, an answer cut off part way, a request larger than the account takes at once, more than the model reads at once, an empty answer, or anything else.
 * A refused sign-in and a model no longer offered are named only when the status said so: the page reads them from the words otherwise.
 * A gateway's bare "not found" is its own cause: there it almost always means a wrong address or model name.
 */
export type TurnFailure = "quota" | "region-or-plan" | "gateway-refused" | "gateway-not-found" | "still-busy" | Unreached | "refused" | "cut-off" | "too-large" | "overflow" | "empty-answer" | "signed-out" | "not-offered" | "other";

/** Why the runtime is asking again: the model is busy, the connection dropped, or its provider had an error. */
export type RetryFailure = "busy" | "connection" | "provider-error";

// A model that could not be reached: the chat's line, the Memory model's
// notice and Review's and Memorize's paused lines say the cause after the
// model's name, then what is safe, then the way on.

/** Who can lift a spent usage limit or credit: a key's own account, the Claude key's console, a company gateway's owner, a sign-in's plan, or a shared server's admin. */
export type QuotaWay = { kind: "key" | "gateway"; provider: string } | { kind: "sign-in"; provider: string; resetsAt?: string } | { kind: "claude-key" | "shared" };

/**
 * The clock time a person reads, in their own zone and clock: "5:27 PM" where their locale keeps a 12-hour clock, "17:27" where it
 * keeps a 24-hour one. The memory wait line and a plan's reset both read it here, on the page, from the time the server sends as data.
 */
export function clockTime(iso: string): string {
	const at = new Date(iso);
	if (Number.isNaN(at.getTime())) return "";
	const twelveHour = /^h1[12]$/.test(new Intl.DateTimeFormat(undefined, { hour: "numeric" }).resolvedOptions().hourCycle ?? "");
	return at.toLocaleTimeString(undefined, { hour: twelveHour ? "numeric" : "2-digit", minute: "2-digit" });
}

/** When something happens, by the clock: "at 15:40", "tomorrow at 09:10", or "on 23 Oct at 09:10". */
export function clockWhen(iso: string, now = new Date()): string {
	const at = new Date(iso);
	const sameDay = (a: Date, b: Date) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
	const tomorrow = new Date(now);
	tomorrow.setDate(now.getDate() + 1);
	if (sameDay(at, now)) return `at ${clockTime(iso)}`;
	if (sameDay(at, tomorrow)) return `tomorrow at ${clockTime(iso)}`;
	return `on ${at.toLocaleDateString(undefined, { day: "numeric", month: "short" })} at ${clockTime(iso)}`;
}

/** When a sign-in plan resets, by the clock, so a line made once stays true: "at 15:40", "tomorrow at 09:10"; null once it is past or unknown. */
function planResetWhen(resetsAt: string | undefined): string | null {
	const ms = resetsAt ? Date.parse(resetsAt) - Date.now() : NaN;
	return ms > 0 ? clockWhen(resetsAt!) : null;
}

/** Whether a sign-in plan's reset time is known and already behind us. */
function planResetPassed(resetsAt: string | undefined): boolean {
	const at = resetsAt ? Date.parse(resetsAt) : NaN;
	return Number.isFinite(at) && at <= Date.now();
}

/** A spent usage limit or credit, after the model's name; a sign-in's is its plan's. */
const QUOTA_CAUSE = "has reached its usage limit or run out of credit";
export function quotaCause(way: QuotaWay | undefined): string {
	return way?.kind === "sign-in" ? "has reached your plan's usage limit" : QUOTA_CAUSE;
}

/** What a person can do about it where a button offers another model; for a sign-in, when its plan resets, if that is known. */
export function quotaWayOn(way: QuotaWay | undefined): string {
	switch (way?.kind) {
		case "key": return `Check your plan or balance with ${way.provider}.`;
		case "claude-key": return "Check the balance at console.anthropic.com.";
		case "gateway": return `Ask whoever runs ${way.provider} about the limit.`;
		case "shared": return "Tell your admin.";
		case "sign-in": {
			const when = planResetWhen(way.resetsAt);
			if (when) return `It resets ${when}.`;
			return planResetPassed(way.resetsAt) ? "It has reset: try again." : "Try again later.";
		}
		default: return "";
	}
}

/** Whether Try again can help: only a plan whose reset is unknown is sure to refuse again now. */
export function quotaOffersTryAgain(way: QuotaWay | undefined): boolean {
	return !(way?.kind === "sign-in" && planResetWhen(way.resetsAt) === null && !planResetPassed(way.resetsAt));
}

/** In chat no button offers another model, so the way on offers it too. */
function quotaChatWayOn(way: QuotaWay | undefined): string {
	const when = way?.kind === "sign-in" ? planResetWhen(way.resetsAt) : null;
	if (when) return `It resets ${when}: try again then, or choose another model in Room settings, Model.`;
	if (way?.kind === "sign-in" && planResetPassed(way.resetsAt)) return "It has reset: try again, or choose another model in Room settings, Model.";
	const wayOn = quotaWayOn(way);
	return wayOn ? `${wayOn.slice(0, -1)}, or choose another model in Room settings, Model.` : "Choose another model in Room settings, Model.";
}

/** A 403's cause, after the model's name: the provider refused the request, not the key. */
export const REGION_OR_PLAN_CAUSE = "refused this request: it may not be offered in your region or on your plan";

/** A company gateway's bare 403, after the model's name: the key or the model, the gateway does not say which. */
export const GATEWAY_REFUSED_CAUSE = "refused this request: the gateway may not accept the saved key, or the model may not be offered to you";

/** A gateway's bare 403's way on: on a shared server the gateway's key is the admin's, so the admin is the way on. */
export function gatewayRefusedWayOn(shared: boolean): string {
	return shared ? "Tell your admin" : "Replace the gateway's key in Settings, AI setup";
}

/**
 * What one look at a gateway's model list said after its bare "not found": the model is no longer listed, the list
 * itself is not found at the saved address, the model is listed but its call still failed, or the list could not be read.
 */
export type GatewayFind = "model-gone" | "address" | "model-listed" | "unread";

/**
 * A gateway's bare "not found", by what its model list said; the gateway named as AI setup names it. Without a look yet,
 * the list unread. On a shared server AI setup is the admin's, so the admin ends each line, as for a gateway's key.
 */
export function gatewayNotFoundLine(gateway: string, modelName: string, find: GatewayFind | undefined, shared: boolean): FailureLineParts {
	const admin = gatewayRefusedWayOn(true);
	switch (find) {
		case "model-gone": return { cause: `${gateway} no longer has ${modelName}.`, wayOn: shared ? `Choose one of its current models, or ${admin.toLowerCase()}.` : "Choose one of its current models." };
		case "address": return { cause: `${gateway} isn't answering at its saved address.`, wayOn: shared ? `${admin}.` : "Check the address in AI setup." };
		case "model-listed": return { cause: `${gateway} lists ${modelName} but couldn't run it.`, wayOn: shared ? `Try again later, or ${admin.toLowerCase()}.` : "Try again later, or tell whoever runs the gateway." };
		default: return { cause: `${gateway} could not find ${modelName}.`, wayOn: shared ? `${admin}.` : "Check the gateway in AI setup." };
	}
}

/** Whether a value a frame or a saved line carries is one of the four. */
export function isGatewayFind(value: unknown): value is GatewayFind {
	return value === "model-gone" || value === "address" || value === "model-listed" || value === "unread";
}

/** The cause, after the model's name. */
export function unreachedCause(where: Unreached): string {
	return where === "local-connection" ? "could not be reached on this computer" : "could not be reached";
}

/** What a person can do about it. On a shared server the connection is not theirs to check: their admin is the way on. */
export function unreachedWayOn(where: Unreached, shared = false): string {
	if (where === "local-connection") return "Check that the app running it is open, then try again.";
	return shared ? "Try again in a moment; if it repeats, tell your admin." : "Check your internet connection, then try again.";
}

/**
 * A failure line's words, the cause first. Where the failed message is comes right after the cause and before `wayOn`; a line with no
 * `wayOn` says where only once the message moved (still above, or back in the box), after all its words.
 */
export interface FailureLineParts {
	cause: string;
	wayOn?: string;
}

/** A failure line as its item keeps it. */
export type SavedFailureLine = { text: string; parts?: FailureLineParts; details?: string; failure?: FailureCause; quotaWay?: QuotaWay; gatewayFind?: GatewayFind; messageAbove?: true; messageBack?: true };

/** Where a failed message is: nothing of it lost, still above (Try again continues its turn), or back in the box. */
export type MessageWhere = "lost" | "above" | "back";

const WHERE_SENTENCE: Record<MessageWhere, string> = { lost: "Nothing was lost.", above: "Your message is still above.", back: "Your message is back in the box." };

/** A failure line's text, from its parts and where its message is. */
export function failureLineText(parts: FailureLineParts, where: MessageWhere): string {
	const said = parts.wayOn !== undefined || where !== "lost" ? WHERE_SENTENCE[where] : "";
	return [parts.cause, said, parts.wayOn ?? ""].filter(Boolean).join(" ");
}

/** A failure line's words and where its message is, as its item keeps them: the text and the fields say it together. */
export function failureLine(parts: FailureLineParts, where: MessageWhere): { text: string; parts: FailureLineParts; messageAbove?: true; messageBack?: true } {
	return { text: failureLineText(parts, where), parts, ...(where === "above" ? { messageAbove: true as const } : where === "back" ? { messageBack: true as const } : {}) };
}

/** A failure line's way on when Try again cannot send its message again whole and cannot give its words back to the box. */
export const NOT_SENT_AGAIN = "It can't be sent again as it was. Send what you need in a new message.";

/** A failure line once its message is somewhere else. A line saved without parts keeps its text as its cause. */
export function lineWithMessage<T extends SavedFailureLine>(line: T, where: MessageWhere): T & SavedFailureLine {
	const { messageAbove: _above, messageBack: _back, ...rest } = line;
	return { ...rest, ...failureLine(line.parts ?? { cause: line.text }, where) } as T & SavedFailureLine;
}

const CHOOSE_MODEL = "Choose another model in Room settings, Model.";

/** `quotaWay`: who can lift a spent limit, as the server worked it out; a line without it falls back to the admin on a shared server, else the Claude key's console. `shared`: the admin is the way on for what the person cannot change there (the connection, a gateway's key or address). `gateway`: the provider as AI setup names it; `gatewayFind`: what its model list said after a bare "not found". */
export function turnFailureLine(modelName: string, failure: TurnFailure | undefined, provider?: string, quotaWay?: QuotaWay, shared = false, gateway?: string, gatewayFind?: GatewayFind): FailureLineParts {
	if (failure === "quota") {
		const way = quotaWay ?? (shared ? { kind: "shared" as const } : provider === "anthropic-api-key" ? { kind: "claude-key" as const } : undefined);
		return { cause: `${modelName} ${quotaCause(way)}.`, wayOn: quotaChatWayOn(way) };
	}
	if (failure === "region-or-plan") return { cause: `${modelName} ${REGION_OR_PLAN_CAUSE}.`, wayOn: CHOOSE_MODEL };
	if (failure === "gateway-refused") return { cause: `${modelName} ${GATEWAY_REFUSED_CAUSE}.`, wayOn: `${gatewayRefusedWayOn(shared)}, or choose another model in Room settings, Model.` };
	if (failure === "gateway-not-found") return gatewayNotFoundLine(gateway || provider || "The gateway", modelName, gatewayFind, shared);
	if (failure === "still-busy") return { cause: `${modelName} is still busy after several tries.`, wayOn: "Try again in a minute." };
	if (failure === "empty-answer") return { cause: `${modelName} sent back an empty answer.`, wayOn: "Try again; if it repeats, choose another model in Room settings, Model." };
	if (failure === "connection" || failure === "local-connection") return { cause: `${modelName} ${unreachedCause(failure)}.`, wayOn: unreachedWayOn(failure, shared) };
	if (failure === "refused") return { cause: `${modelName} declined to answer this message.`, wayOn: "You can reword it, or choose another model in Room settings, Model." };
	if (failure === "too-large") return { cause: `${modelName} can't take this much at once on your account.`, wayOn: "Remember, then continue, or choose another model in Room settings, Model." };
	if (failure === "cut-off") return { cause: `${modelName} stopped in the middle of its answer.`, wayOn: "Try again." };
	return { cause: `${modelName} could not answer this message.`, wayOn: "Try again; if it repeats, choose another model in Room settings, Model." };
}

/** A line the room's model row says too, in its words with its way out: where the message is goes before that way out. */
export function lineBeforeChooseModel(line: string): FailureLineParts {
	return line.endsWith(` ${CHOOSE_MODEL}`) ? { cause: line.slice(0, -CHOOSE_MODEL.length - 1), wayOn: CHOOSE_MODEL } : { cause: line };
}

/**
 * A failure line's cause, kept with it: the server's, or what the provider's words said (the model not on the account, no longer offered,
 * the conversation and memory more than it reads at once, the message alone more than that, the conversation alone in a room with nothing
 * in memory, or a model that reads less than the window set for it).
 */
export type FailureCause = TurnFailure | "not-on-account" | "message-over-window" | "conversation-over-window" | "window-set-larger" | "could-not-shorten";

/** The conversation and the room's memory are more than the model reads at once: Review shrinks memory, a larger model reads more. */
export function overflowLine(modelName: string): FailureLineParts {
	return { cause: `${modelName} can't read this conversation and the room's memory at once.`, wayOn: "Shrink memory with Review from Maintain, or continue on a model that can read more at once in Room settings, Model." };
}

/** The message alone is more than the model reads at once, so shrinking memory cannot help. */
export function messageOverWindowLine(modelName: string): FailureLineParts {
	return { cause: `${modelName} can't read this message at once.`, wayOn: "Shorten it, or continue on a model that can read more at once in Room settings, Model." };
}

/** In a room with nothing in memory, a message that fits by itself: the conversation as the model gets it is more than it reads at once. */
export function conversationOverWindowLine(modelName: string): FailureLineParts {
	return { cause: `${modelName} can't read this conversation at once.`, wayOn: "Continue on a model that can read more at once in Room settings, Model." };
}

/**
 * The room could not shorten the conversation for its model, a size problem: a summary cut at the model's output limit needs a model
 * that writes longer answers (`summaryCut`), anything else one that reads more at once. `messageAbove`: a message failed for it and is
 * still above, said right after the cause; with none, the line says nothing of a message until one moves.
 */
export function couldNotShortenLine(modelName: string, summaryCut: boolean, messageAbove = false): FailureLineParts {
	const cause = `The room could not shorten this conversation enough for ${modelName}.`;
	const wayOn = `Your memory is unchanged. Remember, then continue, or choose a model that ${summaryCut ? "writes longer answers" : "reads more at once"} in Room settings, Model.`;
	return messageAbove ? { cause, wayOn } : { cause: `${cause} ${wayOn}` };
}

// Grouped as the other token counts on screen (fmtTokenCount in memory-v2-copy.ts, which imports this file).
const tokenCount = (value: number) => Math.round(value).toLocaleString("en-US");

/**
 * The provider names the model's real limit, smaller than the context window set for it: every check of the app judged by the larger number.
 * On a shared server the number is the admin's to correct.
 */
export function windowSetLargerLine(modelName: string, limit: number, window: number, shared = false): FailureLineParts {
	return shared
		? { cause: `${modelName} can read only ${tokenCount(limit)} tokens at once, less than the context window set for it (${tokenCount(window)}).`, wayOn: "Tell your admin, or choose another model in Room settings, Model." }
		: { cause: `${modelName} can read only ${tokenCount(limit)} tokens at once, less than the context window set in AI setup (${tokenCount(window)}).`, wayOn: "Correct it in AI setup, or choose another model in Room settings, Model." };
}

// How providers name the most a model reads at once, from their documented
// error texts: OpenAI, Azure, vLLM and LiteLLM ("maximum context length is
// 8192 tokens"), LM Studio ("context length of only 4096 tokens"), Mistral
// ("too large for model with 32768 maximum context length"), newer vLLM
// ("the maximum model length of 4096"), llama.cpp, which Ollama and LM Studio
// build on ("the available context size (4096 tokens)"), text-generation-
// inference ("must be <= 4096"), Anthropic ("> 200000 maximum"). A count the
// request reached, or went over by, is never read as the limit.
const NAMED_LIMITS: readonly RegExp[] = [
	/maximum context length is (\d[\d,]*)/i,
	/context length of only (\d[\d,]*)/i,
	/(\d[\d,]*) maximum context length/i,
	/maximum model length (?:is |of )?(\d[\d,]*)/i,
	/context size \((\d[\d,]*) tokens\)/i,
	/max_new_tokens`? must be <= (\d[\d,]*)/i,
	/tokens > (\d[\d,]*) maximum/i,
];

/** The most the model reads at once, in tokens, when the provider's words name it. */
export function namedContextLimit(words: string): number | undefined {
	// Providers name the limit near the start; a gateway's error body has no cap, and a long run of digits makes these patterns slow, on a shared server for everyone.
	const head = words.slice(0, 4000);
	for (const form of NAMED_LIMITS) {
		const limit = Number(form.exec(head)?.[1]?.replace(/,/g, ""));
		if (Number.isFinite(limit) && limit > 0) return limit;
	}
	return undefined;
}

/** What the page knows of an overflow. `windowSetInSetup`: the window AI setup holds for a gateway's model, undefined where the number is the app's own. */
export interface OverflowFacts {
	modelName: string;
	words: string;
	messageOverWindow: boolean;
	memoryEmpty: boolean;
	windowSetInSetup?: number;
	shared: boolean;
}

/**
 * The overflow line, by its real cause: a model that reads less than the window set for it first, whatever is in memory; then a message
 * over the window by itself; then, with nothing in memory, the conversation; else the conversation and memory, which Review shrinks.
 */
export function overflowLineOf(facts: OverflowFacts): { parts: FailureLineParts; failure: FailureCause } {
	const limit = namedContextLimit(facts.words);
	if (limit !== undefined && facts.windowSetInSetup !== undefined && limit < facts.windowSetInSetup) {
		return { parts: windowSetLargerLine(facts.modelName, limit, facts.windowSetInSetup, facts.shared), failure: "window-set-larger" };
	}
	if (facts.messageOverWindow) return { parts: messageOverWindowLine(facts.modelName), failure: "message-over-window" };
	if (facts.memoryEmpty) return { parts: conversationOverWindowLine(facts.modelName), failure: "conversation-over-window" };
	return { parts: overflowLine(facts.modelName), failure: "overflow" };
}

/** The buttons of the newest failure line, one for each way on its words name. */
export interface FailureButtons {
	tryAgain: boolean;
	chooseModel: boolean;
	replaceKey: boolean;
	reviewMemory: boolean;
	aiSetup: boolean;
}

// Try again only where trying now can work: never for credit, a plan whose reset is ahead or unknown, a model the account, region or plan lacks, a refusal or a request too long.
const TRYING_AGAIN_CAN_WORK: ReadonlySet<FailureCause> = new Set<FailureCause>(["connection", "local-connection", "other", "cut-off", "empty-answer", "still-busy"]);
const ANOTHER_MODEL_NAMED: ReadonlySet<FailureCause> = new Set<FailureCause>(["quota", "region-or-plan", "gateway-refused", "refused", "too-large", "empty-answer", "other", "not-on-account", "not-offered", "overflow", "message-over-window", "conversation-over-window", "window-set-larger", "could-not-shorten"]);

/**
 * `shared`: on a shared server a gateway's key and address are the admin's, and no button tells the admin. `gatewayFind`: after a
 * gateway's bare "not found", what its model list said: a model gone offers another, one listed Try again, else AI setup.
 */
export function failureButtons(cause: FailureCause | undefined, quotaWay: QuotaWay | undefined, shared: boolean, gatewayFind?: GatewayFind): FailureButtons {
	if (!cause) return { tryAgain: false, chooseModel: false, replaceKey: false, reviewMemory: false, aiSetup: false };
	const notFound = cause === "gateway-not-found";
	return {
		tryAgain: TRYING_AGAIN_CAN_WORK.has(cause) || (cause === "quota" && quotaWay?.kind === "sign-in" && planResetPassed(quotaWay.resetsAt)) || (notFound && gatewayFind === "model-listed"),
		chooseModel: ANOTHER_MODEL_NAMED.has(cause) || (notFound && gatewayFind === "model-gone"),
		replaceKey: cause === "gateway-refused" && !shared,
		reviewMemory: cause === "overflow",
		aiSetup: notFound && !shared && (gatewayFind === undefined || gatewayFind === "address" || gatewayFind === "unread"),
	};
}

/** The newest line's words: a button takes the place of the words that say where its way on is, and of a sentence that says only what it does. */
export function failureLineWords(text: string, buttons: FailureButtons): string {
	let words = text;
	if (buttons.tryAgain) words = words.replace(/(^|\s)Try again\.(?=\s|$)/g, "$1");
	if (buttons.chooseModel) words = words.replace(/(^|\s)Choose another model in Room settings, Model\.(?=\s|$)/g, "$1").replace(/ in Room settings, Model(?=[.,;:])/g, "");
	if (buttons.replaceKey) words = words.replace(/ in Settings, AI setup(?=[.,;:])/g, "");
	if (buttons.reviewMemory) words = words.replace(/ with Review from Maintain(?=[.,;:])/g, " with Review");
	if (buttons.aiSetup) words = words.replace(/ in AI setup(?=[.,;:])/g, "");
	return words.replace(/\s{2,}/g, " ").trim();
}

/** A file a message carried, as its item keeps it. */
export interface CarriedFile {
	name: string;
	bytes: number;
	extension: string;
}

/** What Try again sends again for a line whose message stayed above; null when the page cannot send it whole or it holds nothing. `existingNames`: the room's files, once listed. */
export function messageSentAgain(items: ReadonlyArray<{ kind: string; id: string; text?: string; attachments?: CarriedFile[] }>, lineId: string, existingNames?: ReadonlySet<string>): { text: string; attachments: CarriedFile[] } | null {
	const lastUserBefore = (end: number) => {
		for (let index = end - 1; index >= 0; index--) if (items[index]!.kind === "user") return index;
		return -1;
	};
	const user = lastUserBefore(items.findIndex((item) => item.id === lineId));
	if (user < 0) return null;
	// A transfer rides ahead of the next message sent; its item stays, what rode with the message does not.
	if (items.slice(lastUserBefore(user) + 1, user).some((item) => item.kind === "consult" || item.kind === "task")) return null;
	const text = String(items[user]!.text ?? "");
	const attachments = items[user]!.attachments ?? [];
	if (existingNames && attachments.some((file) => !existingNames.has(file.name))) return null;
	return text.trim() || attachments.length > 0 ? { text, attachments } : null;
}

/** A failure line as its row shows it: the cause its parts keep, whatever full stops the model's name holds, then the rest; a line with nothing after its cause, or none kept, by its first sentence. */
export function failureLineParts(line: { text: string; parts?: FailureLineParts }): { cause: string; rest: string } {
	const cause = line.parts?.cause;
	if (cause !== undefined && line.text.length > cause.length) return { cause, rest: line.text.slice(cause.length).trim() };
	const cut = (/[.!?](?=\s+\S)/.exec(line.text)?.index ?? -1) + 1;
	return cut > 0 ? { cause: line.text.slice(0, cut).trim(), rest: line.text.slice(cut).trim() } : { cause: line.text.trim(), rest: "" };
}

/** The note Stop leaves; with the message back in the box, lineWithMessage adds that it is. */
export const STOPPED_LINE = "Response interrupted by Stop.";

/** A message handed back by the server, with the cause and the model its last attempt ran on. */
export interface ReturnedPromptFrame {
	/** The step back's id: the line that says it carries it, so a later open adds none. */
	id?: string;
	text: string;
	failure?: string;
	model?: { provider: string; model: string };
	quotaWay?: QuotaWay;
	/** After a gateway's bare "not found": what its model list said. */
	gatewayFind?: GatewayFind;
	/** The failed attempt's own words, from which the page says the live line again. */
	words?: string;
	notice?: true;
	/** For the key notice: the key is missing, refused, or made outside a workspace. */
	key?: CredentialKey;
	stopped?: true;
}

/** A failure that ended while nobody was in the room, worded on the way in from what the server kept. */
export function returnedFailureLine(modelName: string, returned: ReturnedPromptFrame, shared: boolean, gateway?: string): FailureLineParts {
	return returned.stopped ? { cause: STOPPED_LINE } : turnFailureLine(modelName, returned.failure as TurnFailure | undefined, returned.model?.provider, returned.quotaWay, shared, gateway, returned.gatewayFind);
}

/** A message sent while the last answer was still running, put back in the box. A passing note: it goes once the turn is over and is never saved. */
export const TURN_RUNNING_LINE = "The last answer is still finishing. Your message is back in the box; send it in a moment.";

export function isTurnRunningNote(item: { kind: string; text?: unknown }): boolean {
	return item.kind === "system" && item.text === TURN_RUNNING_LINE;
}

export function retryNoteLine(modelName: string, failure: RetryFailure | undefined): string {
	if (failure === "busy") return `${modelName} is busy. Trying again…`;
	if (failure === "connection") return "Connection hiccup. Retrying…";
	return `${modelName} hit an error at its provider. Trying again…`;
}

/** The readable message inside a provider's JSON: its `message` or `detail`, under `error` too. */
function messageOf(body: unknown): string | undefined {
	if (typeof body === "string") return body.trim() || undefined;
	if (!body || typeof body !== "object") return undefined;
	const fields = body as Record<string, unknown>;
	for (const key of ["message", "detail"]) if (typeof fields[key] === "string" && (fields[key] as string).trim()) return (fields[key] as string).trim();
	return fields.error === undefined ? undefined : messageOf(fields.error);
}

const mixesLettersAndDigits = (text: string): boolean => /\d/.test(text) && /[A-Za-z]/.test(text);

/**
 * Anything shaped like a key or a token: a provider key by its prefix (sk-,
 * xai-, pplx-, a Google AIza… key), a bearer token, a long run of letters and
 * digits with no hyphen, or a run of 40 characters or more with hyphens where
 * one part of 8 or more mixes letters and digits. A model's id is made of
 * words, numbers and short parts like "70b", so it stays even when long.
 */
function maskSecrets(text: string): string {
	return text
		.replace(/\bBearer\s+[^\s,;"']+/gi, "Bearer …")
		.replace(/\b(sk|rk|pk|xai|pplx)-[\w.*-]{4,}/g, "$1-…")
		.replace(/\bAIza[\w-]{20,}/g, "AIza…")
		.replace(/[\w-]{24,}/g, (word) => mixesLettersAndDigits(word) && (!word.includes("-") || (word.length >= 40 && word.split("-").some((part) => part.length >= 8 && mixesLettersAndDigits(part)))) ? "…" : word);
}

const SHOWN_MAX = 500;

/**
 * The provider's own sentence for a failure, for Details: the message field
 * of its JSON when there is one, an error page's title, otherwise its words,
 * never the JSON or the markup around it and never a leading status code;
 * anything that looks like a key or a token masked, and a cut said with "…".
 */
export function providerSentence(raw: string): string | undefined {
	// The runtime's own words, not the provider's: a stream that ended early says so; no connection made says nothing.
	const runtimeWords = /^(?:\w*Error: )?(terminated|Connection error|fetch failed)(?::\s*[A-Z_]+)?\.?$/i.exec(raw.trim());
	if (runtimeWords) return /^terminated$/i.test(runtimeWords[1]!) ? "The connection closed before the answer arrived." : undefined;
	// The OpenAI library's own words for an answer with no body: nothing the provider said.
	if (/^(?:[1-5]\d\d\s+)?status code \(no body\)$/i.test(raw.trim())) return undefined;
	const text = raw.trim().replace(/^[1-5]\d\d\s+(?=[A-Za-z<{"])/, "");
	const start = text.indexOf("{");
	const end = text.lastIndexOf("}");
	let sentence = text;
	if (/<(?:!doctype|html|head|body|title)\b/i.test(text)) {
		// A proxy's error page: its title says it; the rest is markup.
		sentence = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(text)?.[1] ?? text.replace(/<[^>]*>/g, " ");
	} else if (start >= 0) {
		try {
			sentence = messageOf(JSON.parse(text.slice(start, end + 1))) ?? "";
		} catch {
			// A cut-off body (an old saved line kept 300 characters): its message field alone, or the words outside the braces.
			const field = /"(?:message|detail)"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(text)?.[1];
			try { sentence = field ? JSON.parse(`"${field}"`) : text.slice(0, start); } catch { sentence = text.slice(0, start); }
		}
	}
	const shown = maskSecrets(sentence.replace(/\s+/g, " ").trim());
	if (shown.length <= SHOWN_MAX) return shown || undefined;
	return `${shown.slice(0, SHOWN_MAX - 1).replace(/\s+\S*$/, "")}…`;
}

/** A retry note a window saved before it left; the retry it speaks of is long over by the time anyone reads it. */
export function isRetryNote(text: string): boolean {
	return / Trying again…$|^Connection hiccup\. Retrying…$/.test(text);
}

// Older builds wrote the provider's raw words into the conversation. The
// fallback line is shown as the plain line, without a model's name, since it
// never said which model failed; the overflow line keeps its words. Both keep
// the provider's sentence, in Details.
const SAVED_RAW_FAILURE_LINE = /^The model could not respond · (?:([\s\S]*) · )?check the model and its sign-in in AI setup\.$/;
const SAVED_OVERFLOW_LINE_DETAIL = /^(The model could not respond: the conversation plus this room's memory (?:are more than it can read at once|exceed its context window)) · ([\s\S]*)(\. Run Review from Maintain to shrink memory, or [^.]+\.)$/;


/**
 * A saved failure line as it shows when the conversation opens: a line an older build saved is read into fields here, once, and a
 * plan's reset is worded for now ("at 15:40" is false the next morning).
 */
export function savedFailureLineShown<T extends SavedFailureLine>(line: T): T & SavedFailureLine {
	const read = line.parts ? line : savedLineRead(line);
	if (read.failure !== "quota" || read.quotaWay?.kind !== "sign-in" || read.parts?.wayOn === undefined) return read;
	return { ...read, ...failureLine({ ...read.parts, wayOn: quotaChatWayOn(read.quotaWay) }, read.messageAbove ? "above" : read.messageBack ? "back" : "lost") };
}

function savedLineRead<T extends SavedFailureLine>(line: T): T & SavedFailureLine {
	const details = (raw: string | undefined) => {
		const said = raw && !line.details ? providerSentence(raw) : undefined;
		return said ? { details: said } : {};
	};
	const raw = SAVED_RAW_FAILURE_LINE.exec(line.text);
	if (raw) return { ...line, ...failureLine(turnFailureLine("The model", "other"), "lost"), ...details(raw[1]) };
	const overflow = SAVED_OVERFLOW_LINE_DETAIL.exec(line.text);
	if (overflow) return { ...line, text: `${overflow[1]}${overflow[3]}`, ...details(overflow[2]) };
	// Saved before its words were kept as fields: where the message is says where the cause ends.
	const said = (Object.entries(WHERE_SENTENCE) as Array<[MessageWhere, string]>).map(([where, sentence]) => ({ where, at: line.text.indexOf(sentence), sentence })).filter(({ at }) => at > 0).sort((a, b) => a.at - b.at)[0];
	if (!said) return line;
	const before = line.text.slice(0, said.at).trim();
	const after = line.text.slice(said.at + said.sentence.length).trim();
	// Older builds put the way on before where the message is: it is read out of the cause.
	return { ...line, ...failureLine({ wayOn: after, ...(after ? { cause: before } : lineBeforeChooseModel(before)) }, said.where) };
}
