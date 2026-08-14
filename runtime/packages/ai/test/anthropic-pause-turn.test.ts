import type Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import { getModel } from "../src/models.js";
import { streamAnthropic } from "../src/providers/anthropic.js";
import type { Context } from "../src/types.js";

// A turn using the provider's own web search can come back with stop_reason
// "pause_turn": not finished, just handed back. Mapped to "stop" and left
// alone, it reads as a complete answer that happens to end mid-sentence. These
// pin the continuation: the turn is sent back and carries on, the caller sees
// one message and one stream, and the paused turn is handed back with its
// server-tool blocks intact, because a tool_use without its result is a
// request the API refuses.

function sse(events: Array<Record<string, unknown>>): Response {
	const withStop = [...events, { type: "message_stop" }];
	const body = withStop.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n`).join("\n");
	return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

function messageStart(id: string, inputTokens: number) {
	return {
		type: "message_start",
		message: {
			id,
			type: "message",
			role: "assistant",
			model: "claude-opus-5",
			content: [],
			stop_reason: null,
			stop_sequence: null,
			usage: { input_tokens: inputTokens, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
		},
	};
}

function textBlock(index: number, text: string) {
	return [
		{ type: "content_block_start", index, content_block: { type: "text", text: "" } },
		{ type: "content_block_delta", index, delta: { type: "text_delta", text } },
		{ type: "content_block_stop", index },
	];
}

/** The server tool's call and its results, in the shape the provider streams them. */
function serverSearchBlocks(startIndex: number) {
	return [
		{ type: "content_block_start", index: startIndex, content_block: { type: "server_tool_use", id: "srvtoolu_1", name: "web_search", input: {} } },
		{ type: "content_block_delta", index: startIndex, delta: { type: "input_json_delta", partial_json: '{"query":"weather' } },
		{ type: "content_block_delta", index: startIndex, delta: { type: "input_json_delta", partial_json: ' today"}' } },
		{ type: "content_block_stop", index: startIndex },
		{
			type: "content_block_start",
			index: startIndex + 1,
			content_block: { type: "web_search_tool_result", tool_use_id: "srvtoolu_1", content: [{ type: "web_search_result", title: "Forecast", url: "https://example.com" }] },
		},
		{ type: "content_block_stop", index: startIndex + 1 },
	];
}

function messageDelta(stopReason: string, outputTokens: number) {
	return {
		type: "message_delta",
		delta: { stop_reason: stopReason, stop_sequence: null },
		usage: { output_tokens: outputTokens },
	};
}

/** Hands out one response per call and records what it was asked for. */
function createSequencedClient(responses: Response[]): { client: Anthropic; calls: any[] } {
	const calls: any[] = [];
	let next = 0;
	const client = {
		messages: {
			create: (params: unknown) => {
				calls.push(params);
				const response = responses[Math.min(next, responses.length - 1)];
				next += 1;
				return { asResponse: async () => response };
			},
		},
	} as unknown as Anthropic;
	return { client, calls };
}

const SERVER_TOOL = { type: "web_search_20250305", name: "web_search", max_uses: 8 };

function contextWithServerTool(): Context {
	return { messages: [{ role: "user", content: "What is the weather today?", timestamp: Date.now() }] };
}

/** The declaration rides on the payload, the way the web-server extension puts it there. */
function withServerTool(params: any) {
	return { ...params, tools: [...(params.tools ?? []), SERVER_TOOL] };
}

describe("anthropic pause_turn", () => {
	it("continues a paused turn and reports it as one finished message", async () => {
		const model = getModel("anthropic", "claude-haiku-4-5")!;
		const paused = sse([
			messageStart("msg_first", 10),
			...serverSearchBlocks(0),
			...textBlock(2, "Let me check. "),
			messageDelta("pause_turn", 5),
		]);
		const finished = sse([
			messageStart("msg_second", 20),
			...textBlock(0, "It is sunny."),
			messageDelta("end_turn", 7),
		]);
		const { client, calls } = createSequencedClient([paused, finished]);

		const result = await streamAnthropic(model, contextWithServerTool(), {
			client,
			onPayload: (params: unknown) => withServerTool(params),
		} as any).result();

		expect(calls.length).toBe(2);
		// One message, both halves of the answer in it, ending as a real ending.
		expect(result.stopReason).toBe("stop");
		const text = result.content.filter((block: any) => block.type === "text").map((block: any) => block.text).join("");
		// This first half already ends in a space, so it is already separated and
		// gets nothing added: the seam only supplies a break where the text would
		// otherwise collide. The break case is pinned in its own test below.
		expect(text).toBe("Let me check. It is sunny.");
		// The id of the response the caller started, not the continuation's.
		expect(result.responseId).toBe("msg_first");
		// What the turn COST: every request resent the conversation, and the bill
		// is the sum of them.
		expect(result.usage.input).toBe(30);
		expect(result.usage.output).toBe(12);
		expect(result.usage.totalTokens).toBe(42);
		// What the turn LEAVES BEHIND is a different number: the conversation as
		// it stood when the turn began, plus everything the turn produced. The
		// continuations resent the same conversation, and counting it once per
		// round trip is what made rooms read several times fuller than they were.
		expect(result.usage.contextTokens).toBe(22);
	});

	it("hands the paused turn back with its server tool blocks intact", async () => {
		const model = getModel("anthropic", "claude-haiku-4-5")!;
		const paused = sse([
			messageStart("msg_first", 10),
			...serverSearchBlocks(0),
			...textBlock(2, "Checking. "),
			messageDelta("pause_turn", 5),
		]);
		const finished = sse([messageStart("msg_second", 20), ...textBlock(0, "Done."), messageDelta("end_turn", 7)]);
		const { client, calls } = createSequencedClient([paused, finished]);

		await streamAnthropic(model, contextWithServerTool(), {
			client,
			onPayload: (params: unknown) => withServerTool(params),
		} as any).result();

		const continuation = calls[1];
		const lastMessage = continuation.messages[continuation.messages.length - 1];
		expect(lastMessage.role).toBe("assistant");
		const types = lastMessage.content.map((block: any) => block.type);
		// The blocks our own content model has no home for are exactly the ones a
		// continuation cannot go without.
		expect(types).toContain("server_tool_use");
		expect(types).toContain("web_search_tool_result");
		expect(types).toContain("text");
		const call = lastMessage.content.find((block: any) => block.type === "server_tool_use");
		// Streamed as fragments of JSON, handed back as the object it spelled.
		expect(call.input).toEqual({ query: "weather today" });
		expect(call.id).toBe("srvtoolu_1");
		const searchResult = lastMessage.content.find((block: any) => block.type === "web_search_tool_result");
		expect(searchResult.tool_use_id).toBe("srvtoolu_1");
	});

	it("gives up after a bounded number of pauses and says the answer was cut short", async () => {
		const model = getModel("anthropic", "claude-haiku-4-5")!;
		const alwaysPaused = () => sse([messageStart("msg_x", 1), ...textBlock(0, "..."), messageDelta("pause_turn", 1)]);
		const { client, calls } = createSequencedClient([alwaysPaused(), alwaysPaused(), alwaysPaused(), alwaysPaused(), alwaysPaused()]);

		const result = await streamAnthropic(model, contextWithServerTool(), {
			client,
			onPayload: (params: unknown) => withServerTool(params),
		} as any).result();

		// The first request plus the bounded resubmits, and no more.
		expect(calls.length).toBe(4);
		expect(result.stopReason).toBe("length");
	});

	it("measures context from the prompt as submitted, not after a search grew it", async () => {
		const model = getModel("anthropic", "claude-haiku-4-5")!;
		// One response, no pause, but a server-side search running inside it. The
		// results it finds are billed back as cache creation on the same request,
		// so the prompt reported at the end is much larger than the one that was
		// sent. Those results never reach our messages and so are not there to be
		// resent next turn: counting them is what made the chip jump after a
		// search answer and quietly correct itself one turn later.
		const searched = sse([
			{
				type: "message_start",
				message: {
					id: "msg_search", type: "message", role: "assistant", model: "claude-opus-5", content: [], stop_reason: null, stop_sequence: null,
					usage: { input_tokens: 500, output_tokens: 0, cache_read_input_tokens: 9500, cache_creation_input_tokens: 1000 },
				},
			},
			...serverSearchBlocks(0),
			...textBlock(2, "here is what I found"),
			// The end of the same response, after the search results landed.
			{
				type: "message_delta",
				delta: { stop_reason: "end_turn", stop_sequence: null },
				usage: { input_tokens: 500, output_tokens: 400, cache_read_input_tokens: 9500, cache_creation_input_tokens: 9000 },
			},
		]);
		const { client, calls } = createSequencedClient([searched]);

		const result = await streamAnthropic(model, contextWithServerTool(), {
			client,
			onPayload: (params: unknown) => withServerTool(params),
		} as any).result();

		expect(calls.length).toBe(1);
		// Cost still counts every token the request was billed for.
		expect(result.usage.cacheWrite).toBe(9000);
		expect(result.usage.totalTokens).toBe(19400);
		// Context counts the conversation that will actually be resent: the
		// prompt as submitted (500 + 9500 + 1000) plus what the turn produced.
		expect(result.usage.contextTokens).toBe(11400);
		expect(result.usage.contextTokens).toBeLessThan(result.usage.totalTokens);
	});

	it("falls back to the end-of-segment prompt when a proxy reports no usage up front", async () => {
		const model = getModel("anthropic", "claude-haiku-4-5")!;
		// Some proxies send a message_start with all-zero usage and report the
		// real numbers only at the end. There is no submitted-prompt figure to
		// pin, so the anchor comes from the seam instead of being lost.
		const zeroStart = sse([
			{
				type: "message_start",
				message: {
					id: "msg_proxy", type: "message", role: "assistant", model: "claude-opus-5", content: [], stop_reason: null, stop_sequence: null,
					usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
				},
			},
			...textBlock(0, "answer"),
			{ type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { input_tokens: 700, output_tokens: 50 } },
		]);
		const { client } = createSequencedClient([zeroStart]);

		const result = await streamAnthropic(model, contextWithServerTool(), {
			client,
			onPayload: (params: unknown) => withServerTool(params),
		} as any).result();

		expect(result.usage.input).toBe(700);
		expect(result.usage.contextTokens).toBe(750);
		expect(result.usage.contextTokens).toBe(result.usage.totalTokens);
	});

	it("keeps cost summed and context measured from the first prompt across two pauses", async () => {
		const model = getModel("anthropic", "claude-haiku-4-5")!;
		// Three requests. Each resends the whole conversation, so each reports a
		// prompt of its own; only the first one describes the conversation that
		// will still be there next turn.
		const first = sse([
			{ ...messageStart("msg_1", 100), message: { ...messageStart("msg_1", 100).message, usage: { input_tokens: 100, output_tokens: 0, cache_read_input_tokens: 900, cache_creation_input_tokens: 0 } } },
			...serverSearchBlocks(0),
			...textBlock(2, "one"),
			messageDelta("pause_turn", 10),
		]);
		const second = sse([
			{ ...messageStart("msg_2", 0), message: { ...messageStart("msg_2", 0).message, usage: { input_tokens: 150, output_tokens: 0, cache_read_input_tokens: 900, cache_creation_input_tokens: 0 } } },
			...serverSearchBlocks(0),
			...textBlock(2, "two"),
			messageDelta("pause_turn", 20),
		]);
		const third = sse([
			{ ...messageStart("msg_3", 0), message: { ...messageStart("msg_3", 0).message, usage: { input_tokens: 200, output_tokens: 0, cache_read_input_tokens: 900, cache_creation_input_tokens: 0 } } },
			...textBlock(0, "three"),
			messageDelta("end_turn", 30),
		]);
		const { client, calls } = createSequencedClient([first, second, third]);

		const result = await streamAnthropic(model, contextWithServerTool(), {
			client,
			onPayload: (params: unknown) => withServerTool(params),
		} as any).result();

		expect(calls.length).toBe(3);
		// Cost: every prompt the turn paid for, added up. Unchanged behaviour.
		expect(result.usage.input).toBe(450);
		expect(result.usage.cacheRead).toBe(2700);
		expect(result.usage.output).toBe(60);
		expect(result.usage.totalTokens).toBe(3210);
		// Context: the first request's prompt (100 + 900) plus everything the turn
		// generated (60). Reading the cost total here is what made a room report
		// roughly three times its real size after a two-pause turn.
		expect(result.usage.contextTokens).toBe(1060);
		expect(result.usage.contextTokens).toBeLessThan(result.usage.totalTokens);
	});

	it("refuses to publish a continuation that returned nothing at all", async () => {
		const model = getModel("anthropic", "claude-haiku-4-5")!;
		const paused = sse([messageStart("msg_a", 1), ...textBlock(0, "half an answer"), messageDelta("pause_turn", 1)]);
		// A response with no events says nothing, not even that it finished.
		const silent = new Response("", { status: 200, headers: { "content-type": "text/event-stream" } });
		const { client } = createSequencedClient([paused, silent]);

		const result = await streamAnthropic(model, contextWithServerTool(), {
			client,
			onPayload: (params: unknown) => withServerTool(params),
		} as any).result();

		// Half an answer must not be published as a whole one.
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toMatch(/no stream events/);
	});

	it("still publishes a first response that never named a stop reason", async () => {
		const model = getModel("anthropic", "claude-haiku-4-5")!;
		// Some proxies stream a perfectly good message and omit stop_reason, a
		// quirk this provider has always tolerated. That answer was paid for and
		// must not be downgraded to an error just because the pause check exists.
		const noStopReason = sse([messageStart("msg_only", 10), ...textBlock(0, "a complete answer")]);
		const { client, calls } = createSequencedClient([noStopReason]);

		const result = await streamAnthropic(model, contextWithServerTool(), {
			client,
			onPayload: (params: unknown) => withServerTool(params),
		} as any).result();

		expect(calls.length).toBe(1);
		expect(result.stopReason).toBe("stop");
		expect(result.content.filter((block: any) => block.type === "text").map((block: any) => block.text).join("")).toBe("a complete answer");
	});

	it("keeps the paragraph break waiting across a segment that only thought", async () => {
		const model = getModel("anthropic", "claude-haiku-4-5")!;
		const first = sse([messageStart("msg_1", 1), ...textBlock(0, "before"), messageDelta("pause_turn", 1)]);
		// A middle segment with thinking and no text at all. The break is still
		// owed to whatever text arrives next, not cancelled by the silence.
		const thinkingOnly = sse([
			messageStart("msg_2", 1),
			{ type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } },
			{ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "hmm" } },
			{ type: "content_block_stop", index: 0 },
			messageDelta("pause_turn", 1),
		]);
		const last = sse([messageStart("msg_3", 1), ...textBlock(0, "after"), messageDelta("end_turn", 1)]);
		const { client } = createSequencedClient([first, thinkingOnly, last]);

		const result = await streamAnthropic(model, contextWithServerTool(), {
			client,
			onPayload: (params: unknown) => withServerTool(params),
		} as any).result();

		const text = result.content.filter((block: any) => block.type === "text").map((block: any) => block.text).join("");
		expect(text).toBe("before\n\nafter");
	});

	it("does not add a break after text that already ends in whitespace", async () => {
		const model = getModel("anthropic", "claude-haiku-4-5")!;
		// A trailing space separates as well as a newline does, and "word \n\n"
		// is not something the model would have written.
		const paused = sse([messageStart("msg_1", 1), ...textBlock(0, "before "), messageDelta("pause_turn", 1)]);
		const finished = sse([messageStart("msg_2", 1), ...textBlock(0, "after"), messageDelta("end_turn", 1)]);
		const { client } = createSequencedClient([paused, finished]);

		const result = await streamAnthropic(model, contextWithServerTool(), {
			client,
			onPayload: (params: unknown) => withServerTool(params),
		} as any).result();

		const text = result.content.filter((block: any) => block.type === "text").map((block: any) => block.text).join("");
		expect(text).toBe("before after");
	});

	it("leaves an ordinary turn exactly as it was", async () => {
		const model = getModel("anthropic", "claude-haiku-4-5")!;
		const finished = sse([messageStart("msg_only", 10), ...textBlock(0, "Hello."), messageDelta("end_turn", 3)]);
		const { client, calls } = createSequencedClient([finished]);

		const result = await streamAnthropic(model, contextWithServerTool(), { client } as any).result();

		expect(calls.length).toBe(1);
		expect(result.stopReason).toBe("stop");
		expect(result.responseId).toBe("msg_only");
		expect(result.usage.input).toBe(10);
		expect(result.usage.output).toBe(3);
		// A turn with no server tool reports the same prompt at both ends, so the
		// context measure and the cost total are the same number and consumers
		// that fall back to the total get the identical answer. This is the
		// assertion that keeps the ordinary path bit-identical to before any of
		// this existed.
		expect(result.usage.contextTokens).toBe(result.usage.totalTokens);
		expect(result.usage.contextTokens).toBe(13);
	});

	it("emits one start event for a continued turn, so the loop above sees one message", async () => {
		const model = getModel("anthropic", "claude-haiku-4-5")!;
		const paused = sse([messageStart("msg_a", 1), ...textBlock(0, "one "), messageDelta("pause_turn", 1)]);
		const finished = sse([messageStart("msg_b", 1), ...textBlock(0, "two"), messageDelta("end_turn", 1)]);
		const { client } = createSequencedClient([paused, finished]);

		const stream = streamAnthropic(model, contextWithServerTool(), {
			client,
			onPayload: (params: unknown) => withServerTool(params),
		} as any);
		const seen: string[] = [];
		for await (const event of stream) seen.push(event.type);

		expect(seen.filter((type) => type === "start").length).toBe(1);
		expect(seen.filter((type) => type === "done").length).toBe(1);
	});
});
