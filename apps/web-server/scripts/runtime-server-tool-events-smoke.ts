// A search the provider runs itself (Claude's and ChatGPT's own web search)
// is said as it happens, so a room can show it as a step instead of silence.
//
// Hand-written streams in the documented shapes, served from this machine,
// go through the runtime's real providers and its agent loop:
// - Anthropic Messages: a server_tool_use block says the search started,
//   says it again with its query once the arguments are complete, and its
//   web_search_tool_result ends it; a result that is an error object ends it
//   as failed;
// - OpenAI Responses: a web_search_call item says the search started and its
//   done item ends it, with the query it carried; a failed call ends as failed;
// - the agent loop forwards both as message_update frames, in order, between
//   the message's start and the answer's text;
// - a stream without a server tool says neither.

import http from "node:http";
import type { AddressInfo } from "node:net";
import { agentLoop, type AgentEvent } from "@exxeta/exxperts-core";
import { getModel, type AssistantMessageEvent, type Model } from "@exxeta/exxperts-ai";
import { streamAnthropic } from "@exxeta/exxperts-ai/anthropic";
import { streamOpenAIResponses } from "@exxeta/exxperts-ai/openai-responses";

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

function pass(label: string): void {
	console.log(`  ok  ${label}`);
}

type SseEvent = Record<string, unknown> & { type: string };

function anthropicStream(blocks: SseEvent[]): SseEvent[] {
	return [
		{
			type: "message_start",
			message: { id: "msg_fixture", type: "message", role: "assistant", model: "claude-haiku-4-5", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 12, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } },
		},
		...blocks,
		{ type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 9 } },
		{ type: "message_stop" },
	];
}

function anthropicSearch(index: number, id: string, query: string, result: unknown): SseEvent[] {
	const json = JSON.stringify({ query });
	return [
		{ type: "content_block_start", index, content_block: { type: "server_tool_use", id, name: "web_search", input: {} } },
		{ type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: json.slice(0, 9) } },
		{ type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: json.slice(9) } },
		{ type: "content_block_stop", index },
		{ type: "content_block_start", index: index + 1, content_block: { type: "web_search_tool_result", tool_use_id: id, content: result } },
		{ type: "content_block_stop", index: index + 1 },
	];
}

function anthropicText(index: number, text: string): SseEvent[] {
	return [
		{ type: "content_block_start", index, content_block: { type: "text", text: "" } },
		{ type: "content_block_delta", index, delta: { type: "text_delta", text } },
		{ type: "content_block_stop", index },
	];
}

function responsesStream(items: SseEvent[], text: string): SseEvent[] {
	const message = { type: "message", id: "msg_fixture", role: "assistant", status: "completed", content: [{ type: "output_text", text, annotations: [] }] };
	const outputIndex = items.length / 2;
	return [
		{ type: "response.created", response: { id: "resp_fixture", status: "in_progress", output: [] } },
		...items,
		{ type: "response.output_item.added", output_index: outputIndex, item: { ...message, status: "in_progress", content: [] } },
		{ type: "response.content_part.added", output_index: outputIndex, content_index: 0, item_id: "msg_fixture", part: { type: "output_text", text: "", annotations: [] } },
		{ type: "response.output_text.delta", output_index: outputIndex, content_index: 0, item_id: "msg_fixture", delta: text },
		{ type: "response.output_item.done", output_index: outputIndex, item: message },
		{ type: "response.completed", response: { id: "resp_fixture", status: "completed", output: [], usage: { input_tokens: 12, output_tokens: 9, total_tokens: 21, input_tokens_details: { cached_tokens: 0 } } } },
	];
}

/** A web_search_call as the Responses API streams it: added while it searches, done with the query it ran. */
function responsesSearch(outputIndex: number, id: string, query: string, status: "completed" | "failed"): SseEvent[] {
	return [
		{ type: "response.output_item.added", output_index: outputIndex, item: { type: "web_search_call", id, status: "in_progress" } },
		{ type: "response.output_item.done", output_index: outputIndex, item: { type: "web_search_call", id, status, action: { type: "search", query } } },
	];
}

// One stream per request, in the order the requests come.
const queue: SseEvent[][] = [];
const server = http.createServer((req, res) => {
	req.resume();
	req.on("end", () => {
		const events = queue.shift();
		if (!events) {
			res.writeHead(500).end("no fixture left");
			return;
		}
		res.writeHead(200, { "content-type": "text/event-stream" });
		res.end(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""));
	});
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

// Not a real key: the fixture server is the only thing that reads it.
const FIXTURE_KEY = "fixture-key";
const anthropicModel = { ...getModel("anthropic", "claude-haiku-4-5")!, baseUrl } as Model<"anthropic-messages">;
const responsesModel = { ...getModel("openai", "gpt-4.1")!, baseUrl: `${baseUrl}/v1` } as Model<"openai-responses">;
const context = { messages: [{ role: "user" as const, content: "What is the newest Node release?", timestamp: Date.now() }] };

type Said = string;
function said(event: AssistantMessageEvent): Said | null {
	if (event.type === "server_tool_start") return `start ${event.id} ${event.name}${event.input ? ` ${JSON.stringify(event.input)}` : ""}`;
	if (event.type === "server_tool_end") return `end ${event.id} ${event.ok ? "ok" : "failed"}`;
	if (event.type === "text_start" || event.type === "done" || event.type === "start") return event.type;
	return null;
}

async function saidBy(stream: AsyncIterable<AssistantMessageEvent>): Promise<Said[]> {
	const out: Said[] = [];
	for await (const event of stream) {
		if (event.type === "error") throw new Error(`the fixture stream failed: ${event.error.errorMessage}`);
		const line = said(event);
		if (line) out.push(line);
	}
	return out;
}

function same(actual: Said[], expected: Said[], label: string): void {
	assert(JSON.stringify(actual) === JSON.stringify(expected), `${label}: expected\n  ${expected.join("\n  ")}\ngot\n  ${actual.join("\n  ")}`);
}

try {
	queue.push(anthropicStream([...anthropicSearch(0, "srvtoolu_1", "latest Node release", [{ type: "web_search_result", title: "Node.js", url: "https://nodejs.org", encrypted_content: "x" }]), ...anthropicText(2, "Node 26 is the newest.")]));
	same(await saidBy(streamAnthropic(anthropicModel, context, { apiKey: FIXTURE_KEY })), ["start", "start srvtoolu_1 web_search", 'start srvtoolu_1 web_search {"query":"latest Node release"}', "end srvtoolu_1 ok", "text_start", "done"], "Anthropic search");
	pass("Anthropic: the search starts, gets its query, and ends, before the answer");

	queue.push(anthropicStream([...anthropicSearch(0, "srvtoolu_2", "blocked query", { type: "web_search_tool_result_error", error_code: "max_uses_exceeded" }), ...anthropicText(2, "I could not search.")]));
	same(await saidBy(streamAnthropic(anthropicModel, context, { apiKey: FIXTURE_KEY })), ["start", "start srvtoolu_2 web_search", 'start srvtoolu_2 web_search {"query":"blocked query"}', "end srvtoolu_2 failed", "text_start", "done"], "Anthropic failed search");
	pass("Anthropic: a result that is an error object ends the search as failed");

	queue.push(anthropicStream(anthropicText(0, "No search needed.")));
	same(await saidBy(streamAnthropic(anthropicModel, context, { apiKey: FIXTURE_KEY })), ["start", "text_start", "done"], "Anthropic without a search");
	pass("Anthropic: a plain answer says no server tool");

	queue.push(responsesStream(responsesSearch(0, "ws_1", "latest Node release", "completed"), "Node 26 is the newest."));
	same(await saidBy(streamOpenAIResponses(responsesModel, context, { apiKey: FIXTURE_KEY })), ["start", "start ws_1 web_search", 'start ws_1 web_search {"query":"latest Node release"}', "end ws_1 ok", "text_start", "done"], "Responses search");
	pass("OpenAI Responses: web_search_call starts the search, its done item gives the query and ends it");

	queue.push(responsesStream(responsesSearch(0, "ws_2", "blocked query", "failed"), "I could not search."));
	same(await saidBy(streamOpenAIResponses(responsesModel, context, { apiKey: FIXTURE_KEY })), ["start", "start ws_2 web_search", 'start ws_2 web_search {"query":"blocked query"}', "end ws_2 failed", "text_start", "done"], "Responses failed search");
	pass("OpenAI Responses: a failed web_search_call ends the search as failed");

	queue.push(responsesStream([], "No search needed."));
	same(await saidBy(streamOpenAIResponses(responsesModel, context, { apiKey: FIXTURE_KEY })), ["start", "text_start", "done"], "Responses without a search");
	pass("OpenAI Responses: a plain answer says no server tool");

	// The agent loop is what a room's session listens to: a frame it does not forward never reaches the room.
	queue.push(anthropicStream([...anthropicSearch(0, "srvtoolu_3", "latest Node release", []), ...anthropicText(2, "Node 26 is the newest.")]));
	const loopEvents: AgentEvent[] = [];
	const loop = agentLoop(
		[{ role: "user", content: "What is the newest Node release?", timestamp: Date.now() }],
		{ systemPrompt: "", messages: [], tools: [] },
		{ model: anthropicModel, apiKey: FIXTURE_KEY, convertToLlm: (messages) => messages as any },
	);
	for await (const event of loop) loopEvents.push(event);
	const loopSaid = loopEvents.flatMap((event): Said[] => {
		if (event.type === "message_start" && event.message.role === "assistant") return ["message_start"];
		if (event.type === "message_end" && event.message.role === "assistant") return ["message_end"];
		if (event.type !== "message_update") return [];
		const line = said(event.assistantMessageEvent);
		return line ? [`update ${line}`] : [];
	});
	same(loopSaid, ["message_start", "update start srvtoolu_3 web_search", 'update start srvtoolu_3 web_search {"query":"latest Node release"}', "update end srvtoolu_3 ok", "update text_start", "message_end"], "agent loop");
	pass("agent loop: the search's start, query and end reach the session as message_update frames, in order");
} finally {
	server.close();
}

console.log("runtime server tool events smoke ok");
