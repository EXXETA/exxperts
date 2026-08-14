import type Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import { getModel } from "../src/models.js";
import { streamAnthropic } from "../src/providers/anthropic.js";
import type { AssistantMessage, Context } from "../src/types.js";

// A turn that used the provider's own web search AND a client tool. The parsed
// assistant message cannot hold the server tool blocks, but the API validates
// the latest assistant message verbatim while its tool calls are being
// answered: signatures, order, every block. Reconstructing that message from
// the parsed blocks therefore comes back 400, "`thinking` or
// `redacted_thinking` blocks in the latest assistant message cannot be
// modified". These pin the fix: the wire truth rides on the message and is
// resent verbatim exactly while the message is the latest.

function sse(events: Array<Record<string, unknown>>): Response {
	const withStop = [...events, { type: "message_stop" }];
	const body = withStop.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n`).join("\n");
	return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

function messageStart(id: string) {
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
			usage: { input_tokens: 10, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
		},
	};
}

function signedThinkingBlocks(index: number) {
	return [
		{ type: "content_block_start", index, content_block: { type: "thinking", thinking: "" } },
		{ type: "content_block_delta", index, delta: { type: "thinking_delta", thinking: "I should look this up." } },
		{ type: "content_block_delta", index, delta: { type: "signature_delta", signature: "sig_abc123" } },
		{ type: "content_block_stop", index },
	];
}

function serverSearchBlocks(startIndex: number) {
	return [
		{ type: "content_block_start", index: startIndex, content_block: { type: "server_tool_use", id: "srvtoolu_1", name: "web_search", input: {} } },
		{ type: "content_block_delta", index: startIndex, delta: { type: "input_json_delta", partial_json: '{"query":"weather today"}' } },
		{ type: "content_block_stop", index: startIndex },
		{
			type: "content_block_start",
			index: startIndex + 1,
			content_block: { type: "web_search_tool_result", tool_use_id: "srvtoolu_1", content: [{ type: "web_search_result", title: "Forecast", url: "https://example.com" }] },
		},
		{ type: "content_block_stop", index: startIndex + 1 },
	];
}

function textBlock(index: number, text: string) {
	return [
		{ type: "content_block_start", index, content_block: { type: "text", text: "" } },
		{ type: "content_block_delta", index, delta: { type: "text_delta", text } },
		{ type: "content_block_stop", index },
	];
}

function clientToolCallBlocks(index: number) {
	return [
		{ type: "content_block_start", index, content_block: { type: "tool_use", id: "toolu_client_1", name: "fetch_url", input: {} } },
		{ type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: '{"url":"https://example.com/x"}' } },
		{ type: "content_block_stop", index },
	];
}

function messageDelta(stopReason: string) {
	return {
		type: "message_delta",
		delta: { stop_reason: stopReason, stop_sequence: null },
		usage: { output_tokens: 5 },
	};
}

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

function withServerTool(params: any) {
	return { ...params, tools: [...(params.tools ?? []), SERVER_TOOL] };
}

/** The searched-then-called-a-client-tool turn, as one streamed response. */
function searchedTurnWithClientCall(): Response {
	return sse([
		messageStart("msg_searched"),
		...signedThinkingBlocks(0),
		...serverSearchBlocks(1),
		...textBlock(3, "Let me open that page. "),
		...clientToolCallBlocks(4),
		messageDelta("tool_use"),
	]);
}

async function runSearchedTurn(): Promise<AssistantMessage> {
	const model = getModel("anthropic", "claude-haiku-4-5")!;
	const { client } = createSequencedClient([searchedTurnWithClientCall()]);
	const context: Context = { messages: [{ role: "user", content: "What is the weather today?", timestamp: Date.now() }] };
	return await streamAnthropic(model, context, {
		client,
		onPayload: (params: unknown) => withServerTool(params),
	} as any).result();
}

describe("anthropic server tool replay", () => {
	it("keeps the wire truth beside the parsed content when a server tool ran", async () => {
		const result = await runSearchedTurn();

		// The parsed message holds what the app understands...
		expect(result.content.map((block) => block.type)).toEqual(["thinking", "text", "toolCall"]);
		// ...and the raw copy holds everything the wire produced, in order.
		const raw = result.rawContent as Array<Record<string, any>>;
		expect(raw.map((block) => block.type)).toEqual(["thinking", "server_tool_use", "web_search_tool_result", "text", "tool_use"]);
		expect(raw[0].signature).toBe("sig_abc123");
		expect(raw[1].input).toEqual({ query: "weather today" });
	});

	it("resends the latest assistant message verbatim while its tool call is being answered", async () => {
		const model = getModel("anthropic", "claude-haiku-4-5")!;
		const assistant = await runSearchedTurn();

		const done = sse([messageStart("msg_done"), ...textBlock(0, "The page says sunny."), messageDelta("end_turn")]);
		const { client, calls } = createSequencedClient([done]);
		const context: Context = {
			messages: [
				{ role: "user", content: "What is the weather today?", timestamp: Date.now() },
				assistant,
				{ role: "toolResult", toolCallId: "toolu_client_1", toolName: "fetch_url", content: [{ type: "text", text: "sunny" }], timestamp: Date.now() },
			],
		};
		await streamAnthropic(model, context, { client, onPayload: (params: unknown) => withServerTool(params) } as any).result();

		const sent = calls[0].messages[1];
		expect(sent.role).toBe("assistant");
		// Every block the wire produced goes back: the signed thinking exactly as
		// signed, and the server tool blocks whose absence is what shifted the
		// indexes and produced the 400.
		expect(sent.content.map((block: any) => block.type)).toEqual(["thinking", "server_tool_use", "web_search_tool_result", "text", "tool_use"]);
		expect(sent.content[0].signature).toBe("sig_abc123");
		expect(sent.content[0].thinking).toBe("I should look this up.");
		expect(sent.content[2].tool_use_id).toBe("srvtoolu_1");
	});

	it("lets an older searched turn go back to the lean form", async () => {
		const model = getModel("anthropic", "claude-haiku-4-5")!;
		const searched = await runSearchedTurn();

		// A later turn has happened: the searched message is no longer the one
		// under validation, so it reconstructs lean and the search results stop
		// riding along.
		const laterAssistant: AssistantMessage = {
			role: "assistant",
			content: [{ type: "text", text: "It is sunny." }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-haiku-4-5",
			usage: searched.usage,
			stopReason: "stop",
			timestamp: Date.now(),
		};
		const done = sse([messageStart("msg_done"), ...textBlock(0, "You are welcome."), messageDelta("end_turn")]);
		const { client, calls } = createSequencedClient([done]);
		const context: Context = {
			messages: [
				{ role: "user", content: "What is the weather today?", timestamp: Date.now() },
				searched,
				{ role: "toolResult", toolCallId: "toolu_client_1", toolName: "fetch_url", content: [{ type: "text", text: "sunny" }], timestamp: Date.now() },
				laterAssistant,
				{ role: "user", content: "Thanks!", timestamp: Date.now() },
			],
		};
		await streamAnthropic(model, context, { client, onPayload: (params: unknown) => withServerTool(params) } as any).result();

		const olderSent = calls[0].messages[1];
		expect(olderSent.content.map((block: any) => block.type)).toEqual(["thinking", "text", "tool_use"]);
	});

	it("keeps no raw copy when parsing lost nothing", async () => {
		const model = getModel("anthropic", "claude-haiku-4-5")!;
		const plain = sse([
			messageStart("msg_plain"),
			...signedThinkingBlocks(0),
			...textBlock(1, "Just an answer."),
			messageDelta("end_turn"),
		]);
		const { client } = createSequencedClient([plain]);
		const context: Context = { messages: [{ role: "user", content: "Hello", timestamp: Date.now() }] };
		const result = await streamAnthropic(model, context, {
			client,
			onPayload: (params: unknown) => withServerTool(params),
		} as any).result();

		expect(result.rawContent).toBeUndefined();
	});
});
