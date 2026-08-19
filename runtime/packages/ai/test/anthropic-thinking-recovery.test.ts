import type Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import { getModel } from "../src/models.js";
import { isResentHistoryRefusal, streamAnthropic, stripValidatedHistoryFromParams } from "../src/providers/anthropic.js";
import type { AssistantMessage, Context, Usage } from "../src/types.js";

const EMPTY_USAGE: Usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

// The provider's verbatim-thinking validation is enforced on its servers, its
// enforcement varies by account, and a conversation recorded by an older build
// may not hold what it wants back. These pin the three defenses: the raw copy
// records citations and keeps whitespace blocks (so "verbatim" is verbatim),
// and when the validator refuses anyway, the request retries once with nothing
// left for it to check.

function sse(events: Array<Record<string, unknown>>): Response {
	const withStop = [...events, { type: "message_stop" }];
	const body = withStop.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n`).join("\n");
	return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

function messageStart(id: string) {
	return {
		type: "message_start",
		message: {
			id, type: "message", role: "assistant", model: "claude-opus-5", content: [],
			stop_reason: null, stop_sequence: null,
			usage: { input_tokens: 10, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
		},
	};
}

function messageDelta(stopReason: string) {
	return { type: "message_delta", delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: 5 } };
}

const SERVER_TOOL = { type: "web_search_20250305", name: "web_search", max_uses: 8 };
const withServerTool = (params: any) => ({ ...params, tools: [...(params.tools ?? []), SERVER_TOOL] });

/** A searched turn whose prose carries citations and whose wire holds a whitespace-only text block. */
function citedSearchedTurn(): Response {
	return sse([
		messageStart("msg_cited"),
		{ type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } },
		{ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "Search first." } },
		{ type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "sig_1" } },
		{ type: "content_block_stop", index: 0 },
		{ type: "content_block_start", index: 1, content_block: { type: "server_tool_use", id: "srv_1", name: "web_search", input: {} } },
		{ type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"query":"news"}' } },
		{ type: "content_block_stop", index: 1 },
		{ type: "content_block_start", index: 2, content_block: { type: "web_search_tool_result", tool_use_id: "srv_1", content: [{ type: "web_search_result", title: "T", url: "https://example.com" }] } },
		{ type: "content_block_stop", index: 2 },
		// A whitespace-only block, as the wire really produces them.
		{ type: "content_block_start", index: 3, content_block: { type: "text", text: "", citations: null } },
		{ type: "content_block_delta", index: 3, delta: { type: "text_delta", text: " \n" } },
		{ type: "content_block_stop", index: 3 },
		// Cited prose off the search result.
		{ type: "content_block_start", index: 4, content_block: { type: "text", text: "", citations: null } },
		{ type: "content_block_delta", index: 4, delta: { type: "text_delta", text: "The headline says so." } },
		{ type: "content_block_delta", index: 4, delta: { type: "citations_delta", citation: { type: "web_search_result_location", url: "https://example.com", title: "T", cited_text: "so" } } },
		{ type: "content_block_stop", index: 4 },
		{ type: "content_block_start", index: 5, content_block: { type: "tool_use", id: "toolu_1", name: "fetch_url", input: {} } },
		{ type: "content_block_delta", index: 5, delta: { type: "input_json_delta", partial_json: '{"url":"https://example.org"}' } },
		{ type: "content_block_stop", index: 5 },
		messageDelta("tool_use"),
	]);
}

function createSequencedClient(responses: Array<Response | Error>): { client: Anthropic; calls: any[] } {
	const calls: any[] = [];
	let next = 0;
	const client = {
		messages: {
			create: (params: unknown) => {
				calls.push(params);
				const entry = responses[Math.min(next, responses.length - 1)];
				next += 1;
				return { asResponse: async () => { if (entry instanceof Error) throw entry; return entry; } };
			},
		},
	} as unknown as Anthropic;
	return { client, calls };
}

const VALIDATION_400 = new Error(
	'400 {"type":"error","error":{"type":"invalid_request_error","message":"messages.5.content.4: `thinking` or `redacted_thinking` blocks in the latest assistant message cannot be modified. These blocks must remain as they were in the original response."}}',
);

const PAIRING_400 = new Error(
	'400 {"type":"error","error":{"type":"invalid_request_error","message":"messages.7.content.4: unexpected `tool_use_id` found in `web_search_tool_result` blocks: srvtoolu_01XYTs8cD9XeoCHn8Skr9tbq. Each `web_search_tool_result` block must have a corresponding `server_tool_use` block before it."}}',
);

describe("anthropic verbatim capture fidelity", () => {
	it("records citations and keeps whitespace-only text blocks in the raw copy", async () => {
		const model = getModel("anthropic", "claude-haiku-4-5")!;
		const { client } = createSequencedClient([citedSearchedTurn()]);
		const context: Context = { messages: [{ role: "user", content: "What is new?", timestamp: Date.now() }] };
		const result = await streamAnthropic(model, context, { client, onPayload: withServerTool } as any).result();

		const raw = result.rawContent as Array<Record<string, any>>;
		expect(raw.map((block) => block.type)).toEqual(["thinking", "server_tool_use", "web_search_tool_result", "text", "text", "tool_use"]);
		// The whitespace block survives; only a truly empty one would not.
		expect(raw[3].text).toBe(" \n");
		// The citation the wire attached is in the copy that goes back.
		expect(raw[4].citations).toEqual([{ type: "web_search_result_location", url: "https://example.com", title: "T", cited_text: "so" }]);
	});
});

describe("anthropic thinking validation recovery", () => {
	it("recognizes both known history refusals and nothing else", () => {
		expect(isResentHistoryRefusal(VALIDATION_400)).toBe(true);
		expect(isResentHistoryRefusal(PAIRING_400)).toBe(true);
		expect(isResentHistoryRefusal(new Error("overloaded_error"))).toBe(false);
		expect(isResentHistoryRefusal(new Error("400 invalid_request_error: tools are malformed"))).toBe(false);
		// A refusal naming the server blocks outside an invalid_request_error is
		// not this class either.
		expect(isResentHistoryRefusal(new Error("529 overloaded while processing web_search_tool_result"))).toBe(false);
		// The family fingerprint: a validator nobody has met yet, complaining in
		// its own words but pointing into the resent history, is still caught.
		expect(isResentHistoryRefusal(new Error('400 {"type":"error","error":{"type":"invalid_request_error","message":"messages.3.content.1: citation references a source block that does not exist"}}'))).toBe(true);
	});

	it("strips thinking AND server tool blocks, disables thinking, keeps tool pairs intact", () => {
		const params: any = {
			thinking: { type: "adaptive", display: "summarized" },
			messages: [
				{ role: "user", content: "hi" },
				{
					role: "assistant",
					content: [
						{ type: "thinking", thinking: "t", signature: "s" },
						{ type: "server_tool_use", id: "srv_1", name: "web_search", input: {} },
						{ type: "web_search_tool_result", tool_use_id: "srv_1", content: [] },
						{ type: "text", text: "Found it.", citations: [{ url: "https://example.com" }] },
						{ type: "tool_use", id: "x", name: "f", input: {} },
					],
				},
				{ role: "user", content: [{ type: "tool_result", tool_use_id: "x", content: "ok" }] },
				{ role: "assistant", content: [{ type: "redacted_thinking", data: "opaque" }] },
			],
		};
		const stripped = stripValidatedHistoryFromParams(params);
		expect(stripped.thinking).toEqual({ type: "disabled" });
		// Only plain text and the client tool call survive; the pairing that
		// validator number two checks is gone entirely rather than half-gone.
		expect(stripped.messages[1].content.map((block: any) => block.type)).toEqual(["text", "tool_use"]);
		// An assistant message left empty is dropped whole, not sent empty.
		expect(stripped.messages.length).toBe(3);
		// The original is untouched.
		expect(params.messages[1].content.length).toBe(5);
	});

	it("refuses to resend a raw copy whose search pairing is broken", async () => {
		const model = getModel("anthropic", "claude-haiku-4-5")!;
		const done = sse([
			messageStart("msg_lean"),
			{ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
			{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Fine." } },
			{ type: "content_block_stop", index: 0 },
			messageDelta("end_turn"),
		]);
		const { client, calls } = createSequencedClient([done]);
		const context: Context = {
			messages: [
				{ role: "user", content: "hi", timestamp: Date.now() },
				{
					role: "assistant",
					content: [{ type: "thinking", thinking: "t", thinkingSignature: "sig" }, { type: "toolCall", id: "x", name: "fetch_url", arguments: {} }],
					// A result whose server_tool_use is missing: structurally unfit.
					rawContent: [
						{ type: "thinking", thinking: "t", signature: "sig" },
						{ type: "web_search_tool_result", tool_use_id: "srvtoolu_orphan", content: [] },
						{ type: "tool_use", id: "x", name: "fetch_url", input: {} },
					],
					api: "anthropic-messages", provider: "anthropic", model: "claude-haiku-4-5",
					usage: {} as any, stopReason: "toolUse", timestamp: Date.now(),
				} as any,
				{ role: "toolResult", toolCallId: "x", toolName: "fetch_url", content: [{ type: "text", text: "ok" }], timestamp: Date.now() },
			],
		};
		await streamAnthropic(model, context, { client, onPayload: withServerTool } as any).result();

		// The unfit raw copy fell back to the lean form: no server blocks on the wire.
		const sentBlocks = calls[0].messages.flatMap((m: any) => (Array.isArray(m.content) ? m.content.map((b: any) => b.type) : []));
		expect(sentBlocks).not.toContain("web_search_tool_result");
		expect(sentBlocks).toContain("tool_use");
	});

	it("retries the refused request once without thinking and completes the turn", async () => {
		const model = getModel("anthropic", "claude-haiku-4-5")!;
		const done = sse([
			messageStart("msg_recovered"),
			{ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
			{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Recovered." } },
			{ type: "content_block_stop", index: 0 },
			messageDelta("end_turn"),
		]);
		const { client, calls } = createSequencedClient([VALIDATION_400, done]);
		const context: Context = {
			messages: [
				{ role: "user", content: "hi", timestamp: Date.now() },
				{
					role: "assistant",
					content: [{ type: "thinking", thinking: "t", thinkingSignature: "sig" }, { type: "toolCall", id: "x", name: "fetch_url", arguments: {} }],
					api: "anthropic-messages", provider: "anthropic", model: "claude-haiku-4-5",
					usage: {} as any, stopReason: "toolUse", timestamp: Date.now(),
				} as any,
				{ role: "toolResult", toolCallId: "x", toolName: "fetch_url", content: [{ type: "text", text: "ok" }], timestamp: Date.now() },
			],
		};
		const result = await streamAnthropic(model, context, { client, onPayload: withServerTool } as any).result();

		expect(calls.length).toBe(2);
		// The retry carries no thinking anywhere and declares thinking off.
		expect(calls[1].thinking).toEqual({ type: "disabled" });
		const retryBlocks = calls[1].messages.flatMap((m: any) => (Array.isArray(m.content) ? m.content.map((b: any) => b.type) : []));
		expect(retryBlocks).not.toContain("thinking");
		expect(retryBlocks).not.toContain("redacted_thinking");
		// The turn completed and says what happened.
		expect(result.stopReason).toBe("stop");
		expect(result.diagnostics?.some((d) => d.type === "anthropic-history-validation-recovery")).toBe(true);
	});

	it("does not swallow unrelated request errors", async () => {
		const model = getModel("anthropic", "claude-haiku-4-5")!;
		const { client, calls } = createSequencedClient([new Error("529 overloaded_error")]);
		const context: Context = { messages: [{ role: "user", content: "hi", timestamp: Date.now() }] };
		const result = await streamAnthropic(model, context, { client, onPayload: withServerTool } as any).result();
		// The stream surfaces request failures as an errored message, untouched
		// by the recovery: one call, no retry, the original error text.
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("overloaded");
		expect(calls.length).toBe(1);
	});
});

// The lean reconstruction (any assistant message without a verbatim raw copy)
// must also hand back exactly what the provider signed. A signed thinking
// block with empty text is real wire output; dropping it is the residual the
// recovery net was catching. And a proxy may deliver content inside
// content_block_start instead of streaming deltas; hardcoding "" there loses it.
describe("anthropic history fidelity on the lean path", () => {
	it("keeps a signed thinking block whose text is empty", async () => {
		const model = getModel("anthropic", "claude-haiku-4-5")!;
		const first = sse([
			messageStart("msg_sig_only"),
			{ type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } },
			{ type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "sig_empty" } },
			{ type: "content_block_stop", index: 0 },
			{ type: "content_block_start", index: 1, content_block: { type: "text", text: "" } },
			{ type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "Answer." } },
			{ type: "content_block_stop", index: 1 },
			messageDelta("end_turn"),
		]);
		const { client: firstClient } = createSequencedClient([first]);
		const assistant = await streamAnthropic(
			model,
			{ messages: [{ role: "user", content: "hi", timestamp: Date.now() }] },
			{ client: firstClient } as any,
		).result();
		// Nothing was lost in parsing, so the follow-up goes through the lean
		// reconstruction, not the verbatim raw copy.
		expect(assistant.rawContent).toBeUndefined();

		const done = sse([
			messageStart("msg_done"),
			{ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
			{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "You are welcome." } },
			{ type: "content_block_stop", index: 0 },
			messageDelta("end_turn"),
		]);
		const { client, calls } = createSequencedClient([done]);
		const context: Context = {
			messages: [
				{ role: "user", content: "hi", timestamp: Date.now() },
				assistant,
				{ role: "user", content: "thanks", timestamp: Date.now() },
			],
		};
		await streamAnthropic(model, context, { client } as any).result();

		const sent = calls[0].messages[1];
		expect(sent.role).toBe("assistant");
		expect(sent.content[0]).toEqual({ type: "thinking", thinking: "", signature: "sig_empty" });
		expect(sent.content[1]).toEqual({ type: "text", text: "Answer." });
	});

	it("still drops an unsigned empty thinking block", async () => {
		const model = getModel("anthropic", "claude-haiku-4-5")!;
		// An aborted stream can leave a thinking block with neither text nor
		// signature; there is nothing to validate and nothing to say, so it goes.
		const first = sse([
			messageStart("msg_aborted"),
			{ type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } },
			{ type: "content_block_stop", index: 0 },
			{ type: "content_block_start", index: 1, content_block: { type: "text", text: "" } },
			{ type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "Answer." } },
			{ type: "content_block_stop", index: 1 },
			messageDelta("end_turn"),
		]);
		const { client: firstClient } = createSequencedClient([first]);
		const assistant = await streamAnthropic(
			model,
			{ messages: [{ role: "user", content: "hi", timestamp: Date.now() }] },
			{ client: firstClient } as any,
		).result();

		const done = sse([
			messageStart("msg_done"),
			{ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
			{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } },
			{ type: "content_block_stop", index: 0 },
			messageDelta("end_turn"),
		]);
		const { client, calls } = createSequencedClient([done]);
		const context: Context = {
			messages: [
				{ role: "user", content: "hi", timestamp: Date.now() },
				assistant,
				{ role: "user", content: "thanks", timestamp: Date.now() },
			],
		};
		await streamAnthropic(model, context, { client } as any).result();

		expect(calls[0].messages[1].content.map((block: any) => block.type)).toEqual(["text"]);
	});

	it("withholds a cut-off turn that produced nothing but thinking", async () => {
		const model = getModel("anthropic", "claude-haiku-4-5")!;
		// A turn that hit the output limit inside its reasoning, persisted, then
		// retried. The API merges consecutive assistant content before validating
		// and refuses two adjacent thinking blocks in the merged turn, so the
		// fragment must not ride along with the retry that replaced it.
		const truncated: AssistantMessage = {
			role: "assistant",
			content: [{ type: "thinking", thinking: "", thinkingSignature: "sig_cut" }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-haiku-4-5",
			usage: EMPTY_USAGE,
			stopReason: "length",
			timestamp: Date.now(),
		};
		const retry: AssistantMessage = {
			...truncated,
			content: [
				{ type: "thinking", thinking: "Retried.", thinkingSignature: "sig_retry" },
				{ type: "text", text: "Answer." },
			],
			stopReason: "stop",
		};
		const done = sse([
			messageStart("msg_done"),
			{ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
			{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } },
			{ type: "content_block_stop", index: 0 },
			messageDelta("end_turn"),
		]);
		const { client, calls } = createSequencedClient([done]);
		const context: Context = {
			messages: [
				{ role: "user", content: "hi", timestamp: Date.now() },
				truncated,
				retry,
				{ role: "user", content: "thanks", timestamp: Date.now() },
			],
		};
		await streamAnthropic(model, context, { client } as any).result();

		// One assistant message goes back: the retry, whole. The fragment is gone.
		const assistants = calls[0].messages.filter((m: any) => m.role === "assistant");
		expect(assistants.length).toBe(1);
		expect(assistants[0].content.map((block: any) => block.type)).toEqual(["thinking", "text"]);
		expect(assistants[0].content[0].signature).toBe("sig_retry");
	});

	it("preserves content delivered inside content_block_start", async () => {
		const model = getModel("anthropic", "claude-haiku-4-5")!;
		const proxied = sse([
			messageStart("msg_proxied"),
			{ type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "Pre-thought." } },
			{ type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "sig_pre" } },
			{ type: "content_block_stop", index: 0 },
			{ type: "content_block_start", index: 1, content_block: { type: "text", text: "Hello " } },
			{ type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "world." } },
			{ type: "content_block_stop", index: 1 },
			messageDelta("end_turn"),
		]);
		const { client } = createSequencedClient([proxied]);
		const result = await streamAnthropic(
			model,
			{ messages: [{ role: "user", content: "hi", timestamp: Date.now() }] },
			{ client } as any,
		).result();

		expect(result.content[0]).toMatchObject({ type: "thinking", thinking: "Pre-thought.", thinkingSignature: "sig_pre" });
		expect(result.content[1]).toMatchObject({ type: "text", text: "Hello world." });
	});
});
