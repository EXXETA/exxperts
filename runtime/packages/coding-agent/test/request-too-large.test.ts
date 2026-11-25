import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type AssistantMessage,
	type AssistantMessageEventStream,
	type Context,
	createAssistantMessageEventStream,
	getModels,
	type Message,
	type Model,
	registerApiProvider,
	type SimpleStreamOptions,
	type ToolResultMessage,
	unregisterApiProviders,
} from "@exxeta/exxperts-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentSession, AgentSessionEvent } from "../src/core/agent-session.js";
import { AuthStorage } from "../src/core/auth-storage.js";
import { ModelRegistry } from "../src/core/model-registry.js";
import { APP_PROMPT_MARK, EARLIER_PICTURES_HIGH_MARK, LEFT_OUT_PICTURES_LINE, SEEN_PICTURES_LINE } from "../src/core/request-image-budget.js";
import { createAgentSession } from "../src/core/sdk.js";
import { SessionManager } from "../src/core/session-manager.js";
import { SettingsManager } from "../src/core/settings-manager.js";

// Real sessions over a scripted provider: what goes out, and what it answers.

const API = "request-too-large-test";
const usage = {
	input: 10,
	output: 5,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 15,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
const model: Model<any> = {
	id: "test",
	name: "Test",
	api: API,
	provider: "anthropic",
	baseUrl: "http://127.0.0.1:1",
	reasoning: false,
	input: ["text", "image"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200000,
	maxTokens: 4096,
};
const TOO_LARGE = { errorMessage: "413 Request Entity Too Large", errorStatus: 413, errorType: "request_too_large" };
// Anthropic's own, as its client words it, and an answer with no body a client could read.
const ANTHROPIC_TOO_LARGE = { errorMessage: '413 {"error":{"type":"request_too_large","message":"Request exceeds the maximum size"}}', errorStatus: 413, errorType: "request_too_large" };
const BARE_413 = { errorMessage: "413 status code (no body)", errorStatus: 413 };
const TOO_MANY_TOKENS = { errorMessage: "400 prompt is too long: 213462 tokens > 200000 maximum", errorStatus: 400 };
const TOO_LONG = { errorMessage: "400 Input is too long for requested model.", errorStatus: 400 };
// The same refusal as LiteLLM words it, in front of Amazon Bedrock.
const TOO_LONG_LITELLM = {
	errorMessage: `400 litellm.ContextWindowExceededError: litellm.BadRequestError: BedrockException: Context Window Error - {"message":"Input is too long for requested model."}\nmodel=claude-haiku-5.5. context_window_fallbacks=None. fallbacks=[{"claude-haiku-5.5":["claude-sonnet-5.5"]}].\nLiteLLM: model group 'claude-haiku-5.5' failed with the error above and no fallback model group was found for it, so the request was not retried on another model.`,
	errorStatus: 400,
	errorType: "invalid_request_error",
};

type Reply = Partial<AssistantMessage> | ((options: SimpleStreamOptions | undefined) => Promise<Partial<AssistantMessage>>);
let replies: Reply[];
let requests: Message[][];
// Answers a request by what is in it, instead of the next reply.
let respond: ((context: Context) => Partial<AssistantMessage>) | undefined;

function message(over: Partial<AssistantMessage> = {}): AssistantMessage {
	return {
		role: "assistant",
		content: over.errorMessage ? [] : [{ type: "text", text: "Here you go." }],
		api: API,
		provider: "anthropic",
		model: "test",
		usage,
		stopReason: over.errorMessage ? "error" : "stop",
		timestamp: Date.now(),
		...over,
	};
}

function answering(_model: Model<any>, context: Context, options?: SimpleStreamOptions): AssistantMessageEventStream {
	const stream = createAssistantMessageEventStream();
	requests.push(structuredClone(context.messages));
	const reply = respond ? respond(context) : replies.shift();
	if (!reply) throw new Error("no answer was scripted for this request");
	void (async () => {
		const ended = message(typeof reply === "function" ? await reply(options) : reply);
		stream.push({ type: "start", partial: ended });
		if (ended.stopReason === "error" || ended.stopReason === "aborted") {
			if (ended.content.length > 0) {
				stream.push({ type: "text_start", contentIndex: 0, partial: ended });
				stream.push({ type: "text_delta", contentIndex: 0, delta: "Half", partial: ended });
			}
			stream.push({ type: "error", reason: ended.stopReason, error: ended });
		} else {
			stream.push({ type: "done", reason: ended.stopReason as "stop", message: ended });
		}
	})();
	return stream;
}

// A reply that waits until its request is aborted, as a provider that takes long does.
function untilAborted(options: SimpleStreamOptions | undefined): Promise<Partial<AssistantMessage>> {
	return new Promise((resolve) => {
		const aborted = () => resolve({ stopReason: "aborted", errorMessage: "Request was aborted.", content: [] });
		if (options?.signal?.aborted) aborted();
		else options?.signal?.addEventListener("abort", aborted);
	});
}

function pictureResult(id: string, timestamp: number, bytes = 1000): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: id,
		toolName: "read",
		content: [{ type: "image", data: "A".repeat(bytes), mimeType: "image/png" }],
		isError: false,
		timestamp,
	};
}

// A conversation that read four pictures, each for its own message.
function fourPictures(bytes?: number): Message[] {
	return [1, 2, 3, 4].flatMap((i): Message[] => [
		{ role: "user", content: `Read ${i}.`, timestamp: i * 10 },
		message({ content: [{ type: "toolCall", id: `p${i}`, name: "read", arguments: {} }], stopReason: "toolUse", timestamp: i * 10 + 1 }),
		pictureResult(`p${i}`, i * 10 + 2, bytes),
		message({ timestamp: i * 10 + 3 }),
	]);
}

function shown(messages: Message[]): string[] {
	return messages.flatMap((m) =>
		m.role === "toolResult" && m.content.some((c) => c.type === "image") ? [m.toolCallId] : [],
	);
}

let dir: string;
let sessions: AgentSession[];
let settings: SettingsManager;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "request-too-large-"));
	sessions = [];
	replies = [];
	requests = [];
	respond = undefined;
	settings = SettingsManager.inMemory({ compaction: { keepRecentTokens: 5 }, retry: { baseDelayMs: 1 } });
	registerApiProvider({ api: API as any, stream: answering as any, streamSimple: answering as any }, API);
});

afterEach(() => {
	for (const session of sessions) session.dispose();
	unregisterApiProviders(API);
	rmSync(dir, { recursive: true, force: true });
});

async function open(conversation: Message[], overModel: Partial<Model<any>> = {}): Promise<{ session: AgentSession; events: AgentSessionEvent[] }> {
	const sessionManager = SessionManager.inMemory(dir);
	for (const saved of conversation) sessionManager.appendMessage(saved);
	const authStorage = AuthStorage.create(join(dir, "auth.json"));
	authStorage.setRuntimeApiKey("anthropic", "made-up");
	const { session } = await createAgentSession({
		cwd: dir,
		agentDir: dir,
		model: { ...model, ...overModel },
		authStorage,
		modelRegistry: ModelRegistry.create(authStorage, join(dir, "models.json")),
		settingsManager: settings,
		sessionManager,
	});
	sessions.push(session);
	const events: AgentSessionEvent[] = [];
	session.subscribe((event) => events.push(event));
	return { session, events };
}

function savedAnswers(session: AgentSession): AssistantMessage[] {
	return session.sessionManager
		.getBranch()
		.flatMap((entry) => (entry.type === "message" && entry.message.role === "assistant" ? [entry.message as AssistantMessage] : []));
}

// For rows that prove nothing more happens: the runtime asks again 100 ms after a shortening.
async function quiet(session: AgentSession): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, 300));
	await session.agent.waitForIdle();
}

async function until(condition: () => boolean): Promise<void> {
	for (const deadline = Date.now() + 5000; !condition(); ) {
		if (Date.now() > deadline) throw new Error("timed out");
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}

describe("a request refused for its size", () => {
	it("is sent again without the oldest pictures, as one answer, and stays small for the next message", async () => {
		const { session, events } = await open(fourPictures());
		replies = [TOO_LARGE, {}, {}];
		await session.prompt("And now?");
		expect(requests.map(shown)).toEqual([["p1", "p2", "p3", "p4"], ["p3", "p4"]]);
		expect(JSON.stringify(requests[1][2])).toContain(LEFT_OUT_PICTURES_LINE);
		expect(savedAnswers(session).at(-1)).toMatchObject({ stopReason: "stop" });
		expect(savedAnswers(session).filter((answer) => answer.stopReason === "error")).toEqual([]);
		expect(events.filter((event) => event.type === "message_start" && event.message.role === "assistant")).toHaveLength(1);
		await session.prompt("And then?");
		expect(shown(requests[2])).toEqual(["p3", "p4"]);
		expect(JSON.stringify(session.sessionManager.getBranch()).split('"type":"image"')).toHaveLength(5);
	});

	it("says of a picture the conversation answered about that it was seen, by the model that answered, the same in a new session", async () => {
		const takesPictures = getModels("anthropic").find((candidate) => candidate.input.includes("image"))!;
		const takesNone = getModels("mistral").find((candidate) => !candidate.input.includes("image"))!;
		// The first was answered by a model that takes pictures, the second by one that takes none, the rest by one the registry doesn't know.
		const by = new Map<number, Model<any>>([[13, takesPictures], [23, takesNone]]);
		const answeredBy = fourPictures().map((m) => (m.role === "assistant" && by.has(m.timestamp) ? { ...m, provider: by.get(m.timestamp)!.provider, model: by.get(m.timestamp)!.id } : m));
		const { session } = await open(answeredBy);
		replies = [TOO_LARGE, TOO_LARGE, {}];
		await session.prompt("And now?");
		const lines = () => requests.at(-1)!.flatMap((m) => (m.role === "toolResult" ? [m.content] : []));
		const said = [SEEN_PICTURES_LINE, LEFT_OUT_PICTURES_LINE, LEFT_OUT_PICTURES_LINE, LEFT_OUT_PICTURES_LINE].map((line) => [{ type: "text", text: line }]);
		expect(requests.map(shown)).toEqual([["p1", "p2", "p3", "p4"], ["p3", "p4"], []]);
		expect(lines()).toEqual(said);

		const saved = session.sessionManager.getBranch().flatMap((entry) => (entry.type === "message" ? [entry.message as Message] : []));
		const { session: reopened } = await open(saved);
		requests = [];
		replies = [TOO_LARGE, TOO_LARGE, {}];
		await reopened.prompt("And then?");
		expect(lines()).toEqual(said);
	});

	it("is sent again twice and no more, and fails once", async () => {
		const { session, events } = await open(fourPictures());
		replies = [TOO_LARGE, TOO_LARGE, TOO_LARGE];
		await session.prompt("And now?");
		await quiet(session);
		expect(requests.map(shown)).toEqual([["p1", "p2", "p3", "p4"], ["p3", "p4"], []]);
		expect(savedAnswers(session).filter((answer) => answer.stopReason === "error")).toHaveLength(1);
		expect(events.some((event) => event.type === "compaction_start" || event.type === "auto_retry_start")).toBe(false);
	});

	it.each([
		["Anthropic's words", ANTHROPIC_TOO_LARGE],
		["a gateway's words", TOO_LARGE],
		["a bare 413", BARE_413],
	])("in %s, with nothing left to leave out, fails once and starts no shortening, then or before the next message", async (_name, refusal) => {
		const { session, events } = await open(fourPictures());
		replies = [refusal, refusal, refusal];
		await session.prompt("And now?");
		await quiet(session);
		expect(requests.map(shown)).toEqual([["p1", "p2", "p3", "p4"], ["p3", "p4"], []]);
		expect(savedAnswers(session).filter((answer) => answer.stopReason === "error")).toHaveLength(1);
		replies = [{}];
		await session.prompt("And then?");
		await quiet(session);
		expect(requests).toHaveLength(4);
		expect(savedAnswers(session).at(-1)).toMatchObject({ stopReason: "stop" });
		expect(events.some((event) => event.type === "compaction_start" || event.type === "auto_retry_start")).toBe(false);
	});

	it("starts no shortening either where the conversation is past the line for one", async () => {
		// The runtime keeps 16,384 tokens free: the last answer's 15 fit, the message on top of them does not.
		const { session, events } = await open(fourPictures(), { contextWindow: 16384 + 16 });
		replies = [ANTHROPIC_TOO_LARGE, ANTHROPIC_TOO_LARGE, ANTHROPIC_TOO_LARGE];
		await session.prompt("And now?");
		await quiet(session);
		expect(requests).toHaveLength(3);
		expect(events.some((event) => event.type === "compaction_start")).toBe(false);
	});

	it("that failed on another model does not stop this one's shortening", async () => {
		const old = message({ ...ANTHROPIC_TOO_LARGE, model: "other", timestamp: 60 });
		const { session, events } = await open([...fourPictures(), { role: "user", content: "And now?", timestamp: 50 }, old], { contextWindow: 16000 });
		replies = [{}, {}, {}];
		await session.prompt("And then?");
		expect(events.some((event) => event.type === "compaction_start")).toBe(true);
	});

	it("says in the log how many pictures were left out, and nothing of them", async () => {
		const warned = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			const { session } = await open(fourPictures());
			replies = [TOO_LARGE, TOO_LARGE, {}];
			await session.prompt("And now?");
			expect(warned.mock.calls).toEqual([
				["[request refused as too big] sent again without 2 more earlier pictures that tools returned"],
				["[request refused as too big] sent again without 2 more earlier pictures that tools returned"],
			]);
		} finally {
			warned.mockRestore();
		}
	});

	it("is not sent again with no older picture, for a model that takes none, or with pictures blocked", async () => {
		// The pictures came since the person's last message.
		const own = await open(fourPictures().filter((m, i) => i === 0 || m.role !== "user").slice(0, 9));
		replies = [TOO_LARGE];
		await own.session.agent.continue();
		expect(requests).toHaveLength(1);

		const blind = await open(fourPictures(), { input: ["text"] });
		requests = [];
		replies = [TOO_LARGE];
		await blind.session.prompt("And now?");
		expect(requests).toHaveLength(1);

		settings.setBlockImages(true);
		const blocked = await open(fourPictures());
		requests = [];
		replies = [TOO_LARGE];
		await blocked.session.prompt("And now?");
		expect(requests).toHaveLength(1);
		expect(JSON.stringify(requests[0])).not.toContain('"type":"image"');
		expect(JSON.stringify(requests[0])).toContain("Image reading is disabled.");
	});

	it("is not sent again once its answer began", async () => {
		const { session } = await open(fourPictures());
		replies = [{ ...TOO_LARGE, content: [{ type: "text", text: "Half" }] }];
		await session.prompt("And now?");
		expect(requests).toHaveLength(1);
	});

	it("is not sent again when the refusal speaks of a rate or a spend limit", async () => {
		settings.setRetryEnabled(false);
		for (const refusal of [
			{ errorMessage: "413 Request too large for model `x` on tokens per minute (TPM): Limit 6000, Requested 7000", errorStatus: 413, errorType: "rate_limit_exceeded" },
			{ errorMessage: "429 Request too large", errorStatus: 429 },
			{ errorMessage: "400 Budget has been exceeded: request too large for the key", errorStatus: 400, errorType: "budget_exceeded" },
			{ errorMessage: "413 Your credit balance is too low for a request too large", errorStatus: 413 },
		]) {
			const { session } = await open(fourPictures());
			requests = [];
			replies = [refusal];
			await session.prompt("And now?");
			expect(requests, refusal.errorMessage).toHaveLength(1);
		}
	});

	it("leaves old pictures out before it shortens, and shortens only when that does not help", async () => {
		const helped = await open(fourPictures());
		replies = [TOO_LONG, {}];
		await helped.session.prompt("And now?");
		await quiet(helped.session);
		expect(requests).toHaveLength(2);
		expect(helped.events.some((event) => event.type === "compaction_start")).toBe(false);

		const not = await open(fourPictures());
		requests = [];
		replies = [TOO_LONG, TOO_LONG, TOO_LONG, {}, {}, {}];
		await not.session.prompt("And now?");
		// The three tries and the one ask-again; the others are the summary's.
		const asked = () => requests.filter((sent) => JSON.stringify(sent.at(-1)).includes("And now?"));
		await until(() => asked().length === 4 && savedAnswers(not.session).at(-1)?.stopReason === "stop");
		await quiet(not.session);
		expect(not.events.filter((event) => event.type === "compaction_start")).toHaveLength(1);
		expect(asked()).toHaveLength(4);
	});

	it("for its tokens is sent again once, without any older picture, before it shortens", async () => {
		const { session, events } = await open(fourPictures());
		replies = [TOO_MANY_TOKENS, {}];
		await session.prompt("And now?");
		await quiet(session);
		expect(requests.map(shown)).toEqual([["p1", "p2", "p3", "p4"], []]);
		expect(events.some((event) => event.type === "compaction_start")).toBe(false);
	});

	it("keeps the pictures of the person's message when the app's own prompt after it is refused", async () => {
		const { session } = await open(fourPictures());
		session.sessionManager.appendCustomEntry(APP_PROMPT_MARK, {});
		replies = [TOO_LARGE, TOO_LARGE, TOO_LARGE];
		await session.prompt("Write the missing answer.");
		// p4 came since the person's last message, "Read 4.".
		expect(requests.map(shown)).toEqual([["p1", "p2", "p3", "p4"], ["p3", "p4"], ["p4"]]);
		expect(savedAnswers(session).at(-1)).toMatchObject({ stopReason: "error" });
		// It counts as earlier once the person writes again, as they do a moment later.
		const prompted = Date.now();
		await until(() => Date.now() > prompted);
		requests = [];
		replies = [TOO_LARGE, {}];
		await session.prompt("And now?");
		expect(requests.map(shown)).toEqual([["p4"], []]);
	});

	// A provider that refuses a request while it carries what was read for the newest message; the model reads it again each time.
	const readsAgain = (refusal: Partial<AssistantMessage>, times: number, file = "big.png") => {
		writeFileSync(join(dir, "long.txt"), "A long text. ".repeat(400));
		writeFileSync(join(dir, "big.png"), Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64"));
		let calls = 0;
		respond = (context) => {
			// The summary is asked for without tools.
			if (!context.tools?.length) return {};
			if (context.messages.some((m) => m.role === "toolResult")) return refusal;
			if (calls === times) return {};
			return { content: [{ type: "toolCall", id: `big${++calls}`, name: "read", arguments: { path: file } }], stopReason: "toolUse" };
		};
		return () => calls;
	};
	const shortenings = (events: AgentSessionEvent[]) => events.filter((event) => event.type === "compaction_start").length;

	it.each([
		["Bedrock's", TOO_LONG],
		["LiteLLM's", TOO_LONG_LITELLM],
	])("in %s words, which leave size or tokens open, shortens once for a message that reads pictures, then fails once for its size", async (_name, refusal) => {
		const { session, events } = await open(fourPictures().filter((m) => m.role !== "toolResult" && !(m.role === "assistant" && m.stopReason === "toolUse")));
		const calls = readsAgain(refusal, 5);
		await session.prompt("Read the big one.");
		const refused = () => savedAnswers(session).filter((answer) => answer.stopReason === "error");
		await until(() => refused().length === 2);
		await quiet(session);
		expect(calls()).toBe(2);
		expect(shortenings(events)).toBe(1);
		expect(refused()).toHaveLength(2);
		expect(refused()[0].refusedForSize).toBeUndefined();
		expect(refused()[1]).toMatchObject({ ...refusal, refusedForSize: true });
		expect(refused()[1].errorType).toBe((refusal as Partial<AssistantMessage>).errorType);
		expect(events.some((event) => event.type === "compaction_end" && event.errorMessage)).toBe(false);
		// The next message starts anew.
		respond = undefined;
		requests = [];
		replies = [{}, {}];
		await session.prompt("And now?");
		expect(savedAnswers(session).at(-1)).toMatchObject({ stopReason: "stop" });
		expect(shortenings(events)).toBe(1);
	});

	it.each([
		["Bedrock's", TOO_LONG],
		["LiteLLM's", TOO_LONG_LITELLM],
	])("in %s words shortens as often as its window fills where no picture came since the message", async (_name, refusal) => {
		const { session, events } = await open(fourPictures().filter((m) => m.role !== "toolResult" && !(m.role === "assistant" && m.stopReason === "toolUse")));
		readsAgain(refusal, 2, "long.txt");
		await session.prompt("Read the long one.");
		await until(() => savedAnswers(session).at(-1)?.stopReason === "stop" && shortenings(events) === 2);
		await quiet(session);
		expect(shortenings(events)).toBe(2);
		expect(savedAnswers(session).some((answer) => answer.refusedForSize)).toBe(false);
	});

	it("in words that name tokens shortens as often as its window fills", async () => {
		const { session, events } = await open(fourPictures().filter((m) => m.role !== "toolResult" && !(m.role === "assistant" && m.stopReason === "toolUse")));
		readsAgain(TOO_MANY_TOKENS, 2);
		await session.prompt("Read the big one.");
		await until(() => savedAnswers(session).at(-1)?.stopReason === "stop" && shortenings(events) === 2);
		await quiet(session);
		expect(shortenings(events)).toBe(2);
	});

	it("is not sent again after a stop", async () => {
		const { session } = await open(fourPictures());
		replies = [
			async () => {
				session.agent.abort();
				return TOO_LARGE;
			},
		];
		await session.prompt("And now?");
		expect(requests).toHaveLength(1);
	});
});

describe("a conversation whose earlier pictures are past the high mark", () => {
	// Four of these are just over the high mark; one fits under the low one.
	const large = Math.floor(EARLIER_PICTURES_HIGH_MARK / 4) + 1;

	it("is sent without the oldest from its first request on, in every request of the message, and stays whole itself", async () => {
		const warned = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			// A model that gives no answer to a request over two thirds of the high mark, nor a refusal.
			respond = (context) => JSON.stringify(context.messages).length < (EARLIER_PICTURES_HIGH_MARK * 2) / 3 ? (requests.length === 1 ? { content: [{ type: "toolCall", id: "none", name: "nothing", arguments: {} }], stopReason: "toolUse" } : {}) : { stopReason: "aborted", errorMessage: "Request was aborted." };
			const conversation = fourPictures(large);
			const { session } = await open(conversation);
			await session.prompt("And now?");
			expect(requests.map(shown)).toEqual([["p4"], ["p4"]]);
			expect(savedAnswers(session).at(-1)).toMatchObject({ stopReason: "stop" });
			await session.prompt("And then?");
			expect(shown(requests[2])).toEqual(["p4"]);
			expect(requests[2].slice(0, requests[1].length)).toEqual(requests[1]);
			const saved = session.sessionManager.getBranch().flatMap((entry) => (entry.type === "message" ? [entry.message] : []));
			expect(JSON.stringify(saved.slice(0, conversation.length)) === JSON.stringify(conversation)).toBe(true);
			expect(warned.mock.calls).toEqual([["[pictures past the high mark] sent without 3 more earlier pictures that tools returned"]]);
		} finally {
			warned.mockRestore();
		}
	});

	it("is sent whole just under it", async () => {
		const { session } = await open(fourPictures(large - 1));
		replies = [{}];
		await session.prompt("And now?");
		expect(shown(requests[0])).toEqual(["p1", "p2", "p3", "p4"]);
	});

	it("is left to the provider for a model that takes none, and to the setting that blocks them", async () => {
		const warned = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			const blind = await open(fourPictures(large), { input: ["text"] });
			replies = [{}];
			await blind.session.prompt("And now?");
			expect(JSON.stringify(requests[0])).not.toContain(LEFT_OUT_PICTURES_LINE);
			settings.setBlockImages(true);
			const blocked = await open(fourPictures(large));
			replies = [{}];
			await blocked.session.prompt("And now?");
			expect(JSON.stringify(requests[1])).not.toContain(LEFT_OUT_PICTURES_LINE);
			expect(JSON.stringify(requests[1])).toContain("Image reading is disabled.");
			expect(warned.mock.calls).toEqual([]);
		} finally {
			warned.mockRestore();
		}
	});
});

describe("a stop", () => {
	const tooLongBefore = (): Message[] => [
		{ role: "user", content: "First question, with enough words to be worth a summary.", timestamp: 1 },
		message({ timestamp: 2 }),
		{ role: "user", content: "Second question.", timestamp: 3 },
		message({ ...TOO_LONG, timestamp: 4 }),
	];

	it("during the shortening before a send ends it, and the message goes nowhere", async () => {
		const { session, events } = await open(tooLongBefore());
		replies = [untilAborted];
		const prompted = session.prompt("Third question.");
		await until(() => requests.length === 1);
		await session.abort();
		await prompted;
		await quiet(session);
		// The one request is the summary.
		expect(requests).toHaveLength(1);
		expect(events.filter((event) => event.type === "compaction_end")).toEqual([
			{ type: "compaction_end", reason: "overflow", result: undefined, aborted: true, willRetry: false },
		]);
		expect(savedAnswers(session).at(-1)).toMatchObject({ stopReason: "aborted", content: [] });
		expect(events.flatMap((event) => (event.type === "agent_end" ? event.messages.map((m) => m.role) : []))).toEqual(["user", "assistant"]);
		// The next message goes out, with the stopped one before it.
		replies = [{}, {}, {}];
		await session.prompt("Fourth question.");
		const answered = requests.find((sent) => JSON.stringify(sent.at(-1)).includes("Fourth question."));
		expect(JSON.stringify(answered)).toContain("Third question.");
		expect(savedAnswers(session).at(-1)).toMatchObject({ stopReason: "stop" });
	});

	it("during the shortening after a refusal ends it, and the model is not asked again", async () => {
		const { session, events } = await open(tooLongBefore().slice(0, 2));
		replies = [TOO_LONG, untilAborted];
		await session.prompt("Second question.");
		await until(() => requests.length === 2);
		await session.abort();
		await quiet(session);
		expect(requests).toHaveLength(2);
		expect(events.some((event) => event.type === "compaction_end" && event.willRetry)).toBe(false);
	});

	it("as a shortening ends skips the ask-again", async () => {
		const { session, events } = await open(tooLongBefore().slice(0, 2));
		session.subscribe((event) => {
			if (event.type === "compaction_end") void session.abort();
		});
		replies = [TOO_LONG, {}];
		await session.prompt("Second question.");
		await until(() => events.some((event) => event.type === "compaction_end"));
		await quiet(session);
		expect(requests).toHaveLength(2);
	});

	it("right after a refusal starts no shortening", async () => {
		const { session, events } = await open(tooLongBefore().slice(0, 2));
		session.subscribe((event) => {
			if (event.type === "message_end" && event.message.role === "assistant") void session.abort();
		});
		replies = [TOO_LONG];
		await session.prompt("Second question.");
		await quiet(session);
		expect(requests).toHaveLength(1);
		expect(events.some((event) => event.type === "compaction_start")).toBe(false);
	});

	it("right after a failed answer ends its wait to try again", async () => {
		const { session, events } = await open(tooLongBefore().slice(0, 2));
		session.subscribe((event) => {
			if (event.type === "message_end" && event.message.role === "assistant") void session.abort();
		});
		replies = [{ errorMessage: "503 overloaded", errorStatus: 503 }];
		await session.prompt("Second question.");
		await quiet(session);
		expect(requests).toHaveLength(1);
		expect(events.find((event) => event.type === "auto_retry_end")).toMatchObject({ success: false });
	});

	it("leaves a failed shortening's words out, and one nobody stopped still says them", async () => {
		const failing = await open(tooLongBefore());
		replies = [{ errorMessage: "400 no summary", errorStatus: 400 }, {}];
		await failing.session.prompt("Third question.");
		expect(failing.events.find((event) => event.type === "compaction_end")).toMatchObject({ aborted: false, errorMessage: expect.stringContaining("no summary") });
	});
});
