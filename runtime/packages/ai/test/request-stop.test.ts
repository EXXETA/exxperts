import { AsyncLocalStorage } from "node:async_hooks";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { streamAnthropic, type AnthropicOptions } from "../src/providers/anthropic.js";
import { streamAzureOpenAIResponses } from "../src/providers/azure-openai-responses.js";
import { generateImagesOpenRouter } from "../src/providers/images/openrouter.js";
import { streamOpenAICompletions } from "../src/providers/openai-completions.js";
import { streamOpenAIResponses } from "../src/providers/openai-responses.js";
import type { Api, Context, ImagesModel, Model, StreamOptions } from "../src/types.js";

// The model libraries wait before they ask a busy server again, as long as the
// server says and without looking at the stop signal. These rows run the real
// libraries against a stand-in server on this machine: a stop ends the answer
// during such a wait and nothing is sent afterwards, and a server that asks for
// a longer wait than maxRetryDelayMs is not waited for.

const WORDS = "Too busy for you right now";
const STOPPED = "Request was aborted.";
const ENDS_AT_ONCE_MS = 700;

type Answer = { status: number; headers?: Record<string, string>; body?: string; hold?: Promise<void>; drop?: boolean };
type Outcome = { stopReason: string; errorMessage?: string; errorStatus?: number; text: string };

/** A server that answers each request with the next of `answers`, the last one for every later request. */
class StandIn {
	requests = 0;
	/** Requests whose connection was closed; one whose answer was read stays open for seconds, for the next request. */
	closed = 0;
	private constructor(
		private readonly server: http.Server,
		readonly url: string,
	) {}

	static async answering(...answers: Answer[]): Promise<StandIn> {
		const server = http.createServer((req, res) => {
			const answer = answers[Math.min(standIn.requests, answers.length - 1)]!;
			standIn.requests += 1;
			req.socket.on("close", () => {
				standIn.closed += 1;
			});
			req.resume();
			req.on("end", async () => {
				if (answer.drop) {
					req.socket.destroy();
					return;
				}
				await answer.hold;
				res.writeHead(answer.status, { "content-type": "application/json", ...answer.headers });
				res.end(answer.body ?? JSON.stringify({ error: { type: "rate_limit_error", message: WORDS } }));
			});
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const standIn = new StandIn(server, `http://127.0.0.1:${(server.address() as AddressInfo).port}`);
		opened.push(standIn);
		return standIn;
	}

	close(): void {
		this.server.closeAllConnections();
		this.server.close();
	}
}

const opened: StandIn[] = [];
const context: Context = { messages: [{ role: "user", content: "hi", timestamp: 0 }] };

function modelOf<TApi extends Api>(api: TApi, provider: string, baseUrl: string): Model<TApi> {
	return { id: "stand-in-model", name: "Stand-in", api, provider, baseUrl, reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200000, maxTokens: 4096 } as Model<TApi>;
}

function sse(events: unknown[], named = false): Answer {
	const body = events.map((event) => `${named ? `event: ${(event as { type: string }).type}\n` : ""}data: ${typeof event === "string" ? event : JSON.stringify(event)}\n\n`).join("");
	return { status: 200, headers: { "content-type": "text/event-stream" }, body };
}

const responsesAnswer = sse([
	{ type: "response.created", response: { id: "resp_1" } },
	{ type: "response.output_item.added", item: { type: "message", id: "msg_1", role: "assistant", status: "in_progress", content: [] } },
	{ type: "response.content_part.added", part: { type: "output_text", text: "" } },
	{ type: "response.output_text.delta", delta: "Answered." },
	{ type: "response.output_item.done", item: { type: "message", id: "msg_1", role: "assistant", status: "completed", content: [{ type: "output_text", text: "Answered." }] } },
	{ type: "response.completed", response: { id: "resp_1", status: "completed", usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } },
]);
const anthropicAnswer = sse(
	[
		{ type: "message_start", message: { id: "msg_1", type: "message", role: "assistant", model: "m", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 } } },
		{ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
		{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Answered." } },
		{ type: "content_block_stop", index: 0 },
		{ type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } },
		{ type: "message_stop" },
	],
	true,
);
const completionsAnswer = sse([{ id: "chatcmpl-1", object: "chat.completion.chunk", created: 0, model: "m", choices: [{ index: 0, delta: { content: "Answered." }, finish_reason: "stop" }] }, "[DONE]"]);
const imagesAnswer: Answer = { status: 200, body: JSON.stringify({ id: "img-1", choices: [{ message: { content: "Answered." } }] }) };

async function outcome(message: Promise<{ stopReason: string; errorMessage?: string; errorStatus?: number; content: unknown[] }>): Promise<Outcome> {
	const { stopReason, errorMessage, errorStatus, content } = await message;
	const text = content.map((block) => (block as { text?: string }).text ?? "").join("");
	return { stopReason, errorMessage, errorStatus, text };
}

function anthropicOn(provider: string, apiKey = "made-up-key") {
	return (url: string, options: AnthropicOptions) => outcome(streamAnthropic(modelOf("anthropic-messages", provider, url), context, { apiKey, ...options }).result());
}

type Provider = { name: string; answer: Answer; ask: (url: string, options: StreamOptions) => Promise<Outcome> };

/** One row per provider file that uses a library. */
const providers: Provider[] = [
	{ name: "openai-completions", answer: completionsAnswer, ask: (url, options) => outcome(streamOpenAICompletions(modelOf("openai-completions", "stand-in", url), context, { apiKey: "made-up-key", ...options }).result()) },
	{ name: "openai-responses", answer: responsesAnswer, ask: (url, options) => outcome(streamOpenAIResponses(modelOf("openai-responses", "openai", url), context, { apiKey: "made-up-key", ...options }).result()) },
	{ name: "azure-openai-responses", answer: responsesAnswer, ask: (url, options) => outcome(streamAzureOpenAIResponses(modelOf("azure-openai-responses", "azure-openai-responses", url), context, { apiKey: "made-up-key", azureBaseUrl: url, ...options }).result()) },
	{ name: "anthropic", answer: anthropicAnswer, ask: anthropicOn("anthropic") },
	{
		name: "images/openrouter",
		answer: imagesAnswer,
		ask: async (url, options) => {
			const model = { id: "stand-in-image", name: "Stand-in", api: "openrouter-images", provider: "openrouter", baseUrl: url, input: ["text"], output: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } } as unknown as ImagesModel<"openrouter-images">;
			const images = await generateImagesOpenRouter(model, { input: [{ type: "text", text: "hi" }] }, { apiKey: "made-up-key", ...(options as object) });
			return outcome(Promise.resolve({ ...images, content: images.output }));
		},
	},
];

/** Each other client the Claude provider makes, beside the key's. */
const claudeClients: Provider[] = [
	{ name: "anthropic sign-in", answer: anthropicAnswer, ask: anthropicOn("anthropic", "sk-ant-oat-made-up") },
	{ name: "anthropic through copilot", answer: anthropicAnswer, ask: anthropicOn("github-copilot") },
	{ name: "anthropic through cloudflare", answer: anthropicAnswer, ask: anthropicOn("cloudflare-ai-gateway") },
];

/** Waits for a state, less long than a client keeps a connection it has read; `expect.poll` loses its test in rows that run side by side. */
async function until(reached: () => boolean, what: string): Promise<void> {
	for (const deadline = Date.now() + 2500; !reached(); await passed(10)) {
		if (Date.now() > deadline) throw new Error(`timed out waiting until ${what}`);
	}
}

const passed = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function busy(headers: Record<string, string>): Answer {
	return { status: 429, headers };
}

/** The waits a library has begun for one row's request: rows run side by side, so each is asked in a context of its own. */
type Waits = { begun: number };
const asking = new AsyncLocalStorage<Waits>();
const plainSetTimeout = globalThis.setTimeout;
const watchedSetTimeout = ((...args: Parameters<typeof setTimeout>) => {
	const waits = asking.getStore();
	// The libraries wait in this one helper of theirs, and nowhere else.
	if (waits && /[\\/]internal[\\/]utils[\\/]sleep\.(?:m?js|ts)/.test(new Error().stack ?? "")) waits.begun += 1;
	return plainSetTimeout(...args);
}) as typeof setTimeout;

const inWait = (number: number) => (waits: Waits) => until(() => waits.begun === number, `the library is in its wait number ${number}`);

/** Asks, stops when `stopNow` says so, and says how it ended and how long after the stop. */
async function stopped(ask: (options: StreamOptions) => Promise<Outcome>, stopNow: (waits: Waits) => Promise<void>, options: StreamOptions = {}) {
	const controller = new AbortController();
	const waits: Waits = { begun: 0 };
	const answer = asking.run(waits, () => ask({ ...options, signal: controller.signal }));
	await stopNow(waits);
	const stoppedAt = Date.now();
	controller.abort();
	const ended = await answer;
	return { ...ended, tookMs: Date.now() - stoppedAt };
}

function expectStopped(result: Outcome & { tookMs: number }, row: string): void {
	expect(result.stopReason, row).toBe("aborted");
	expect(result.errorMessage, row).toBe(STOPPED);
	expect(result.tookMs, `${row}: milliseconds from the stop to the end`).toBeLessThan(ENDS_AT_ONCE_MS);
}

const unhandled: unknown[] = [];
const keepUnhandled = (reason: unknown) => {
	unhandled.push(reason);
};
beforeAll(() => {
	globalThis.setTimeout = watchedSetTimeout;
	process.on("unhandledRejection", keepUnhandled);
});
afterAll(() => {
	process.off("unhandledRejection", keepUnhandled);
	globalThis.setTimeout = plainSetTimeout;
	for (const standIn of opened) standIn.close();
	expect(unhandled, "a request that lost to the stop ends handled").toEqual([]);
});

describe.concurrent("a stop during a library's wait ends the answer at once", () => {
	for (const { name, ask } of providers) {
		it(`${name}: the server's wait in seconds, as a date and in milliseconds`, async () => {
			const waits: Record<string, () => Answer> = {
				seconds: () => busy({ "retry-after": "3" }),
				// A date has whole seconds, so this one is three to four seconds away.
				date: () => busy({ "retry-after": new Date(Date.now() + 4000).toUTCString() }),
				milliseconds: () => busy({ "retry-after-ms": "3000" }),
			};
			await Promise.all(
				Object.entries(waits).map(async ([shape, answer]) => {
					const server = await StandIn.answering(answer());
					expectStopped(await stopped((options) => ask(server.url, options), inWait(1)), `${name} ${shape}`);
					await passed(4300);
					expect(server.requests, `${name} ${shape}: requests after the wait would have ended`).toBe(1);
				}),
			);
		});

		// The library's second own wait lasts 0.75 s or more.
		it(`${name}: the library's own wait after a dropped connection`, async () => {
			const server = await StandIn.answering({ status: 0, drop: true });
			const result = await stopped((options) => ask(server.url, options), inWait(2));
			expect(result.stopReason, name).toBe("aborted");
			expect(result.errorMessage, name).toBe(STOPPED);
			expect(result.tookMs, name).toBeLessThan(300);
			expect(server.requests, name).toBe(2);
			await passed(1300);
			expect(server.requests, `${name}: requests after the wait would have ended`).toBe(2);
		});

		it(`${name}: the library's own wait after a refused connection`, async () => {
			const closed = http.createServer();
			await new Promise<void>((resolve) => closed.listen(0, "127.0.0.1", resolve));
			const { port } = closed.address() as AddressInfo;
			await new Promise((resolve) => closed.close(resolve));
			const url = `http://127.0.0.1:${port}`;
			const result = await stopped((options) => ask(url, options), inWait(2));
			expect(result.stopReason, name).toBe("aborted");
			expect(result.errorMessage, name).toBe(STOPPED);
			expect(result.tookMs, name).toBeLessThan(300);
		});

		it(`${name}: a stop before the request sends nothing`, async () => {
			const server = await StandIn.answering(busy({ "retry-after": "3" }));
			const controller = new AbortController();
			controller.abort();
			const result = await ask(server.url, { signal: controller.signal });
			expect(result.stopReason, name).toBe("aborted");
			expect(result.errorMessage, name).toBe(STOPPED);
			await passed(200);
			expect(server.requests, name).toBe(0);
		});

		it(`${name}: a response that comes after the stop is let go`, async () => {
			let answerNow = () => {};
			const hold = new Promise<void>((resolve) => {
				answerNow = resolve;
			});
			const server = await StandIn.answering({ status: 200, hold, body: JSON.stringify({ late: true }) });
			expectStopped(await stopped((options) => ask(server.url, options), () => until(() => server.requests === 1, `${name}: the server has the request`)), name);
			answerNow();
			await until(() => server.closed === 1, `${name}: the connection is closed unread`);
			expect(server.requests, name).toBe(1);
		});
	}

	// The two requests the Claude provider sends again itself, after a refusal.
	const refusals: Array<[string, string, AnthropicOptions]> = [
		["the history recovery's request", "messages.1.content.0: `thinking` blocks cannot be modified", {}],
		["the thinking-off recovery's request", "thinking.type.disabled is not supported for this model", { thinkingEnabled: false }],
	];
	for (const [name, message, more] of refusals) {
		it(`anthropic: ${name}`, async () => {
			const refusal: Answer = { status: 400, body: JSON.stringify({ type: "error", error: { type: "invalid_request_error", message } }) };
			const server = await StandIn.answering(refusal, busy({ "retry-after": "3" }));
			const model = { ...modelOf("anthropic-messages", "anthropic", server.url), reasoning: true };
			const result = await stopped((options) => outcome(streamAnthropic(model, context, { apiKey: "made-up-key", ...more, ...options }).result()), inWait(1));
			expectStopped(result, name);
			expect(server.requests, name).toBe(2);
			await passed(3300);
			expect(server.requests, `${name}: requests after the wait would have ended`).toBe(2);
		});
	}
});

describe("a request that lost to the stop", () => {
	const cancelled: string[] = [];
	afterEach(() => {
		cancelled.length = 0;
	});

	function bodyNamed(name: string): Response {
		return new Response(new ReadableStream({ cancel: () => void cancelled.push(name) }));
	}

	async function untilStopped<T extends Response | { response: Response }>(request: Promise<T>, signal?: AbortSignal): Promise<T> {
		return (await import("../src/utils/request-stop.js")).untilStopped(request, signal);
	}

	it("has its late response's body cancelled, in both shapes the libraries give", async () => {
		const controller = new AbortController();
		let bare = (_response: Response) => {};
		let wrapped = (_value: { response: Response }) => {};
		const ended = Promise.all([
			expect(untilStopped(new Promise<Response>((resolve) => { bare = resolve; }), controller.signal)).rejects.toThrow(STOPPED),
			expect(untilStopped(new Promise<{ response: Response }>((resolve) => { wrapped = resolve; }), controller.signal)).rejects.toThrow(STOPPED),
		]);
		await passed(20);
		controller.abort();
		await ended;
		bare(bodyNamed("bare"));
		wrapped({ response: bodyNamed("wrapped") });
		await passed(20);
		expect(cancelled.sort()).toEqual(["bare", "wrapped"]);
	});

	it("has its response let go too when the stop came before the request", async () => {
		const controller = new AbortController();
		controller.abort();
		await expect(untilStopped(Promise.resolve(bodyNamed("after the stop")), controller.signal)).rejects.toThrow(STOPPED);
		await passed(20);
		expect(cancelled).toEqual(["after the stop"]);
	});

	it("may have read its response already, which can't be cancelled, and ends handled", async () => {
		const controller = new AbortController();
		controller.abort();
		const response = new Response("read");
		await response.text();
		await expect(untilStopped(Promise.resolve(response), controller.signal)).rejects.toThrow(STOPPED);
		await passed(20);
	});

	it("is not touched when no stop comes: its response arrives unread, its error as it is", async () => {
		const controller = new AbortController();
		const response = bodyNamed("kept");
		expect(await untilStopped(Promise.resolve(response), controller.signal)).toBe(response);
		const refused = new Error("refused");
		await expect(untilStopped(Promise.reject(refused), controller.signal)).rejects.toBe(refused);
		await expect(untilStopped(Promise.reject(refused))).rejects.toBe(refused);
		controller.abort();
		await passed(20);
		expect(cancelled).toEqual([]);
	});
});

describe.concurrent("a wait the server asks for is bounded", () => {
	for (const { name, answer, ask } of [...providers, ...claudeClients]) {
		it(`${name}: longer than a minute fails at once, with the words of a refusal that is never asked again`, async () => {
			const plain = await StandIn.answering(busy({}));
			const expected = await ask(plain.url, { maxRetries: 0 });
			expect(expected.stopReason, name).toBe("error");
			expect(expected.errorMessage, name).toContain(WORDS);
			const waits: Record<string, Answer> = {
				seconds: busy({ "retry-after": "61" }),
				date: busy({ "retry-after": new Date(Date.now() + 70_000).toUTCString() }),
				milliseconds: busy({ "retry-after-ms": "61000" }),
				"a 503": { status: 503, headers: { "retry-after": "61" } },
				"a 409": { status: 409, headers: { "retry-after": "61" } },
				"the server insists": busy({ "retry-after": "61", "x-should-retry": "true" }),
			};
			await Promise.all(
				Object.entries(waits).map(async ([shape, refusal]) => {
					const server = await StandIn.answering(refusal);
					const started = Date.now();
					const result = await ask(server.url, {});
					expect(Date.now() - started, `${name} ${shape}`).toBeLessThan(2000);
					expect(result.stopReason, `${name} ${shape}`).toBe("error");
					expect(result.errorMessage, `${name} ${shape}`).toBe(expected.errorMessage?.replace("429", String(refusal.status)));
					// The images answer carries no status beside its words.
					if (expected.errorStatus !== undefined) expect(result.errorStatus, `${name} ${shape}`).toBe(refusal.status);
					expect(server.requests, `${name} ${shape}`).toBe(1);
				}),
			);
		}, 12_000);

		it(`${name}: two seconds are waited for and answered, and so is a wait of exactly the bound`, async () => {
			const server = await StandIn.answering(busy({ "retry-after": "2" }), answer);
			const atTheBound = await StandIn.answering(busy({ "retry-after": "1" }), answer);
			const started = Date.now();
			const [result, bounded] = await Promise.all([ask(server.url, {}), ask(atTheBound.url, { maxRetryDelayMs: 1000 })]);
			expect(Date.now() - started, name).toBeGreaterThanOrEqual(1950);
			expect(result, name).toMatchObject({ stopReason: "stop", text: "Answered." });
			expect(bounded, name).toMatchObject({ stopReason: "stop", text: "Answered." });
			expect([server.requests, atTheBound.requests], name).toEqual([2, 2]);
		});

		it(`${name}: the caller's own bound counts, and 0 switches it off`, async () => {
			const overOwnBound = await StandIn.answering(busy({ "retry-after": "2" }), answer);
			expect(await ask(overOwnBound.url, { maxRetryDelayMs: 1000 }), name).toMatchObject({ stopReason: "error" });
			expect(overOwnBound.requests, name).toBe(1);
			const unbounded = await StandIn.answering(busy({ "retry-after": "61" }), answer);
			expectStopped(await stopped((options) => ask(unbounded.url, options), inWait(1), { maxRetryDelayMs: 0 }), `${name}: waits`);
			expect(unbounded.requests, name).toBe(1);
		});

		it(`${name}: an answer that names a long wait is still the answer, as it came`, async () => {
			const server = await StandIn.answering({ ...answer, headers: { ...answer.headers, "retry-after": "61" } });
			let seen: Record<string, string> = {};
			const onResponse: StreamOptions["onResponse"] = (response) => void (seen = response.headers);
			expect(await ask(server.url, { onResponse }), name).toMatchObject({ stopReason: "stop", text: "Answered." });
			expect(seen["retry-after"], name).toBe("61");
			expect(seen, `${name}: not marked`).not.toHaveProperty("x-should-retry");
		});
	}
});
