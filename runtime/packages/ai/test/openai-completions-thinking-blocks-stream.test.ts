import { once } from "node:events";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { streamOpenAICompletions } from "../src/providers/openai-completions.js";
import type { AssistantMessageEvent, Context, Model, OpenAICompletionsCompat } from "../src/types.js";

const compat = {
	supportsStore: true,
	supportsDeveloperRole: true,
	supportsReasoningEffort: true,
	supportsUsageInStreaming: true,
	maxTokensField: "max_completion_tokens",
	requiresToolResultName: false,
	requiresAssistantAfterToolResult: false,
	requiresThinkingAsText: false,
	requiresReasoningContentOnAssistantMessages: false,
	thinkingFormat: "openai",
	openRouterRouting: {},
	vercelGatewayRouting: {},
	zaiToolStream: false,
	supportsStrictMode: true,
	cacheControlFormat: undefined,
	sendSessionAffinityHeaders: false,
	supportsOpenAIPromptCacheRetention: true,
	supportsAnthropicCacheControlTtl: true,
	supportsLongCacheRetention: true,
	supportsWebSearch: false,
} satisfies Required<Omit<OpenAICompletionsCompat, "cacheControlFormat">> & {
	cacheControlFormat?: OpenAICompletionsCompat["cacheControlFormat"];
};

function buildModel(baseUrl: string): Model<"openai-completions"> {
	return {
		id: "gateway-model",
		name: "Gateway Model",
		api: "openai-completions",
		provider: "gateway-provider",
		baseUrl,
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 4096,
		compat,
	};
}

const context: Context = {
	messages: [{ role: "user", content: "hard question", timestamp: 1 }],
};

async function collectEvents(stream: AsyncIterable<AssistantMessageEvent>): Promise<AssistantMessageEvent[]> {
	const events: AssistantMessageEvent[] = [];
	for await (const event of stream) {
		events.push(event);
	}
	return events;
}

/** Replays a captured chunk sequence and returns the events the provider emitted. */
async function replayChunks(deltaChunks: unknown[]): Promise<AssistantMessageEvent[]> {
	const server = http.createServer(async (req, res) => {
		if (req.method !== "POST" || req.url !== "/chat/completions") {
			res.writeHead(404).end();
			return;
		}
		for await (const _chunk of req) {
			// Drain the request body before answering.
		}
		res.writeHead(200, {
			"content-type": "text/event-stream",
			"cache-control": "no-cache",
			connection: "keep-alive",
		});
		for (const delta of deltaChunks) {
			res.write(
				`data: ${JSON.stringify({
					id: "chatcmpl-gateway",
					object: "chat.completion.chunk",
					created: 0,
					model: "gateway-model",
					choices: [{ index: 0, delta, finish_reason: null }],
				})}\n\n`,
			);
		}
		res.write(
			`data: ${JSON.stringify({
				id: "chatcmpl-gateway",
				object: "chat.completion.chunk",
				created: 0,
				model: "gateway-model",
				choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
				usage: {
					prompt_tokens: 11,
					completion_tokens: 42,
					completion_tokens_details: { reasoning_tokens: 30 },
				},
			})}\n\n`,
		);
		res.write("data: [DONE]\n\n");
		res.end();
	});

	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	try {
		const { port } = server.address() as AddressInfo;
		return await collectEvents(
			streamOpenAICompletions(buildModel(`http://127.0.0.1:${port}`), context, { apiKey: "test-key" }),
		);
	} finally {
		server.close();
		await once(server, "close");
	}
}

function thinkingDeltas(events: AssistantMessageEvent[]): string[] {
	return events
		.filter((event): event is Extract<AssistantMessageEvent, { type: "thinking_delta" }> => {
			return event.type === "thinking_delta";
		})
		.map((event) => event.delta);
}

describe("openai-completions thinking_blocks streaming", () => {
	it("streams thinking_blocks text as live thinking deltas", async () => {
		const events = await replayChunks([
			{
				role: "assistant",
				content: "",
				provider_specific_fields: {},
				thinking_blocks: [{ type: "thinking", thinking: "first " }],
			},
			{
				content: "",
				provider_specific_fields: {},
				thinking_blocks: [{ type: "thinking", thinking: "second" }],
			},
			{ content: "answer" },
		]);

		expect(thinkingDeltas(events)).toEqual(["first ", "second"]);
		const done = events.at(-1);
		expect(done?.type).toBe("done");
		if (done?.type !== "done") throw new Error("expected a done event");
		expect(done.message.content).toEqual([
			{ type: "thinking", thinking: "first second", thinkingSignature: "" },
			{ type: "text", text: "answer" },
		]);
		expect(done.message.usage.output).toBe(42);
		expect(done.message.usage.input).toBe(11);
	});

	it("emits no thinking for a signature-only chunk", async () => {
		const events = await replayChunks([
			{ reasoning_content: "", thinking_blocks: [{ type: "thinking", signature: "c2lnbmF0dXJl" }] },
			{ content: "answer" },
		]);

		expect(thinkingDeltas(events)).toEqual([]);
		expect(events.some((event) => event.type === "thinking_start")).toBe(false);
		const done = events.at(-1);
		if (done?.type !== "done") throw new Error("expected a done event");
		expect(done.message.content).toEqual([{ type: "text", text: "answer" }]);
	});

	it("ignores an empty reasoning_content sent alongside thinking_blocks", async () => {
		const events = await replayChunks([
			{ reasoning_content: "", thinking_blocks: [{ type: "thinking", thinking: "weighing it" }] },
			{ reasoning_content: "", thinking_blocks: [{ type: "thinking", thinking: "", signature: "c2ln" }] },
			{ content: "answer" },
		]);

		expect(thinkingDeltas(events)).toEqual(["weighing it"]);
		const done = events.at(-1);
		if (done?.type !== "done") throw new Error("expected a done event");
		expect(done.message.content).toEqual([
			{ type: "thinking", thinking: "weighing it", thinkingSignature: "" },
			{ type: "text", text: "answer" },
		]);
	});

	it("appends mirrored text once when both fields carry it in one chunk", async () => {
		const events = await replayChunks([
			{ reasoning_content: "mirrored", thinking_blocks: [{ type: "thinking", thinking: "mirrored" }] },
			{ content: "answer" },
		]);

		expect(thinkingDeltas(events)).toEqual(["mirrored"]);
		const done = events.at(-1);
		if (done?.type !== "done") throw new Error("expected a done event");
		expect(done.message.content).toEqual([
			{ type: "thinking", thinking: "mirrored", thinkingSignature: "reasoning_content" },
			{ type: "text", text: "answer" },
		]);
	});

	it("keeps both fragments when a reasoning field and thinking_blocks differ", async () => {
		const events = await replayChunks([
			{ reasoning_content: "from field ", thinking_blocks: [{ type: "thinking", thinking: "from blocks" }] },
			{ content: "answer" },
		]);

		expect(thinkingDeltas(events)).toEqual(["from field ", "from blocks"]);
	});
});
