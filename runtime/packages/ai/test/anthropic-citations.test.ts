import type Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import { getModel } from "../src/models.js";
import { streamAnthropic } from "../src/providers/anthropic.js";
import type { AssistantMessage, AssistantMessageEvent, Context } from "../src/types.js";

// Claude ties each cited text block to the pages it rests on, one
// citations_delta per citation before the block stops, with no offsets: the
// block is the span. The parsed text block keeps the ones a person can open.

type SseEvent = Record<string, unknown> & { type: string };

function sse(events: SseEvent[]): Response {
	const body = events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n`).join("\n");
	return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

const MESSAGE_START: SseEvent = {
	type: "message_start",
	message: {
		id: "msg_cited",
		type: "message",
		role: "assistant",
		model: "claude-haiku-4-5",
		content: [],
		stop_reason: null,
		stop_sequence: null,
		usage: { input_tokens: 10, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
	},
};
const MESSAGE_END: SseEvent[] = [
	{ type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 5 } },
	{ type: "message_stop" },
];

const SEARCH: SseEvent[] = [
	{ type: "content_block_start", index: 0, content_block: { type: "server_tool_use", id: "srvtoolu_1", name: "web_search", input: {} } },
	{ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"query":"node release"}' } },
	{ type: "content_block_stop", index: 0 },
	{
		type: "content_block_start",
		index: 1,
		content_block: { type: "web_search_tool_result", tool_use_id: "srvtoolu_1", content: [{ type: "web_search_result", title: "Node.js", url: "https://nodejs.org/en/blog", encrypted_content: "x" }] },
	},
	{ type: "content_block_stop", index: 1 },
];

function webCitation(url: string, title: string | null): SseEvent {
	return { type: "web_search_result_location", url, title, encrypted_index: "enc", cited_text: "Node 26 is out." };
}

function citationDelta(index: number, citation: SseEvent): SseEvent {
	return { type: "content_block_delta", index, delta: { type: "citations_delta", citation } };
}

/** A cited text block, as Claude streams it: text, then its citations, then the stop. */
function citedBlock(index: number, text: string, citations: SseEvent[], stop = true): SseEvent[] {
	return [
		{ type: "content_block_start", index, content_block: { type: "text", text: "", citations: [] } },
		{ type: "content_block_delta", index, delta: { type: "text_delta", text } },
		...citations.map((citation) => citationDelta(index, citation)),
		...(stop ? [{ type: "content_block_stop", index }] : []),
	];
}

function clientFor(response: Response): { client: Anthropic; calls: any[] } {
	const calls: any[] = [];
	const client = {
		messages: {
			create: (params: unknown) => {
				calls.push(params);
				return { asResponse: async () => response };
			},
		},
	} as unknown as Anthropic;
	return { client, calls };
}

const model = getModel("anthropic", "claude-haiku-4-5")!;
const context: Context = { messages: [{ role: "user", content: "What is the newest Node release?", timestamp: Date.now() }] };

async function run(events: SseEvent[]): Promise<{ events: AssistantMessageEvent[]; message: AssistantMessage }> {
	const { client } = clientFor(sse(events));
	const stream = streamAnthropic(model, context, { client } as any);
	const seen: AssistantMessageEvent[] = [];
	for await (const event of stream) seen.push(structuredClone(event));
	return { events: seen, message: await stream.result() };
}

describe("anthropic citations", () => {
	it("keeps a cited block's web pages, once each, by the time its text ends", async () => {
		const { events, message } = await run([
			MESSAGE_START,
			...SEARCH,
			...citedBlock(2, "Node 26 is out.", [
				webCitation("https://nodejs.org/en/blog", "Node.js"),
				webCitation("https://nodejs.org/en/blog", "Node.js"),
				webCitation("https://github.com/nodejs/node/releases", null),
				// A document citation points into a file we never sent: no page to open.
				{ type: "char_location", cited_text: "x", document_index: 0, document_title: "notes", start_char_index: 0, end_char_index: 1 },
				{ type: "search_result_location", source: "https://example.com/changelog", title: "Changelog", cited_text: "x", search_result_index: 0, start_block_index: 0, end_block_index: 0 },
				{ type: "search_result_location", source: "kb://internal/42", title: "Internal", cited_text: "x", search_result_index: 1, start_block_index: 0, end_block_index: 0 },
			]),
			...citedBlock(3, " Plain sentence.", []),
			...MESSAGE_END,
		]);

		const expected = [
			{ url: "https://nodejs.org/en/blog", title: "Node.js" },
			{ url: "https://github.com/nodejs/node/releases" },
			{ url: "https://example.com/changelog", title: "Changelog" },
		];
		const textEnd = events.find((event) => event.type === "text_end" && event.contentIndex === 0);
		expect(textEnd?.type === "text_end" && textEnd.partial.content[0]).toMatchObject({ type: "text", citations: expected });
		expect(message.content[0]).toEqual({ type: "text", text: "Node 26 is out.", citations: expected });
		expect(message.content[1]).toEqual({ type: "text", text: " Plain sentence." });
		expect(message.sources).toBeUndefined();
	});

	it("reads citations a proxy put on the block's start", async () => {
		const { message } = await run([
			MESSAGE_START,
			{ type: "content_block_start", index: 0, content_block: { type: "text", text: "Node 26 is out.", citations: [webCitation("https://nodejs.org/en/blog", "Node.js")] } },
			{ type: "content_block_stop", index: 0 },
			...MESSAGE_END,
		]);
		expect(message.content[0]).toEqual({ type: "text", text: "Node 26 is out.", citations: [{ url: "https://nodejs.org/en/blog", title: "Node.js" }] });
	});

	it("keeps the open block's citations on the error message of a cut stream", async () => {
		const { events } = await run([MESSAGE_START, ...citedBlock(0, "Node 26 is out.", [webCitation("https://nodejs.org/en/blog", "Node.js")], false)]);
		const last = events[events.length - 1];
		expect(last.type).toBe("error");
		const error = last.type === "error" ? last.error : undefined;
		// No offsets: the citation covers the whole block, whatever text it kept.
		expect(error?.content[0]).toEqual({ type: "text", text: "Node 26 is out.", citations: [{ url: "https://nodejs.org/en/blog", title: "Node.js" }] });
	});

	it("sends neither citations nor sources back to Claude", async () => {
		const cited: AssistantMessage = {
			role: "assistant",
			content: [{ type: "text", text: "Node 26 is out.", citations: [{ url: "https://cited.example/a", title: "A", end: 4 }] }],
			sources: [{ url: "https://source.example/b", title: "B" }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-haiku-4-5",
			usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
			stopReason: "stop",
			timestamp: Date.now(),
		};
		const { client, calls } = clientFor(sse([MESSAGE_START, ...citedBlock(0, "You are welcome.", []), ...MESSAGE_END]));
		await streamAnthropic(model, { messages: [...context.messages, cited, { role: "user", content: "Thanks", timestamp: Date.now() }] }, { client } as any).result();

		expect(calls[0].messages[1]).toEqual({ role: "assistant", content: [{ type: "text", text: "Node 26 is out." }] });
		const sent = JSON.stringify(calls[0]);
		expect(sent).not.toContain("cited.example");
		expect(sent).not.toContain("source.example");
	});
});
