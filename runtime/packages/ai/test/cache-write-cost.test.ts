import http from "node:http";
import type { AddressInfo } from "node:net";
import type Anthropic from "@anthropic-ai/sdk";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { calculateCost, getModel } from "../src/models.js";
import { streamAnthropic } from "../src/providers/anthropic.js";
import { streamMistral } from "../src/providers/mistral.js";
import type { Context, Usage } from "../src/types.js";

// What a turn is shown to cost is what the provider bills for it. Anthropic
// bills a one-hour cache write at twice the input price and a five-minute one
// at 1.25x, and Mistral bills cached prompt tokens at its cache-read price, so
// both have to be read from the provider's usage report and priced apart.

const context: Context = { messages: [{ role: "user", content: "Hello", timestamp: Date.now() }] };

function sse(events: Array<Record<string, unknown>>): Response {
	const body = events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n`).join("\n");
	return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

function anthropicClient(responses: Response[]): Anthropic {
	let next = 0;
	return { messages: { create: () => ({ asResponse: async () => responses[next++] }) } } as unknown as Anthropic;
}

function anthropicTurn(id: string, usage: Record<string, unknown>, deltaUsage: Record<string, unknown>, stopReason = "end_turn") {
	return [
		{
			type: "message_start",
			message: { id, type: "message", role: "assistant", model: "claude-opus-5-5", content: [], stop_reason: null, stop_sequence: null, usage },
		},
		{ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
		{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hi." } },
		{ type: "content_block_stop", index: 0 },
		{ type: "message_delta", delta: { stop_reason: stopReason, stop_sequence: null }, usage: deltaUsage },
		{ type: "message_stop" },
	];
}

function emptyUsage(): Usage {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
}

describe("cache write cost", () => {
	const opus = getModel("anthropic", "claude-opus-5-5")!;

	it("prices one-hour writes at twice the input price and five-minute writes at the catalogue's write price", async () => {
		// The measured turn: 11,797 tokens written for one hour, 577 out, plus 1,000 written for five minutes.
		const usage = {
			input_tokens: 3,
			output_tokens: 1,
			cache_read_input_tokens: 0,
			cache_creation_input_tokens: 12_797,
			cache_creation: { ephemeral_1h_input_tokens: 11_797, ephemeral_5m_input_tokens: 1_000 },
		};
		const result = await streamAnthropic(opus, context, {
			client: anthropicClient([sse(anthropicTurn("msg_1", usage, { output_tokens: 577 }))]),
		} as any).result();

		expect(result.usage.cacheWrite).toBe(12_797);
		expect(result.usage.cacheWrite1h).toBe(11_797);
		const oneHour = (11_797 * opus.cost.input * 2) / 1_000_000;
		const fiveMinutes = (1_000 * opus.cost.cacheWrite) / 1_000_000;
		expect(opus.cost.cacheWrite).toBe(opus.cost.input * 1.25);
		expect(result.usage.cost.cacheWrite).toBeCloseTo(oneHour + fiveMinutes, 12);
		expect(result.usage.cost.total).toBeCloseTo((3 * 4 + 577 * 20 + 11_797 * 8 + 1_000 * 5) / 1_000_000, 12);
	});

	it("keeps the one-hour count across a paused turn's continuation", async () => {
		const serverTool = { type: "web_search_20250305", name: "web_search", max_uses: 8 };
		const first = { input_tokens: 3, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 500, cache_creation: { ephemeral_1h_input_tokens: 500, ephemeral_5m_input_tokens: 0 } };
		const second = { input_tokens: 2, output_tokens: 1, cache_read_input_tokens: 500, cache_creation_input_tokens: 300, cache_creation: { ephemeral_1h_input_tokens: 100, ephemeral_5m_input_tokens: 200 } };
		const result = await streamAnthropic(opus, context, {
			client: anthropicClient([sse(anthropicTurn("msg_1", first, { output_tokens: 5 }, "pause_turn")), sse(anthropicTurn("msg_2", second, { output_tokens: 7 }))]),
			onPayload: (params: any) => ({ ...params, tools: [...(params.tools ?? []), serverTool] }),
		} as any).result();

		expect(result.usage.cacheWrite).toBe(800);
		expect(result.usage.cacheWrite1h).toBe(600);
		expect(result.usage.cost.cacheWrite).toBeCloseTo((600 * 8 + 200 * 5) / 1_000_000, 12);
	});

	it("prices a usage report without the split exactly as before", async () => {
		const usage = { input_tokens: 3, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 1_000 };
		const result = await streamAnthropic(opus, context, {
			client: anthropicClient([sse(anthropicTurn("msg_1", usage, { output_tokens: 10 }))]),
		} as any).result();

		expect(result.usage.cacheWrite1h).toBeUndefined();
		expect(result.usage.cost.cacheWrite).toBeCloseTo((1_000 * 5) / 1_000_000, 12);
	});

	it("never prices more one-hour tokens than were written", () => {
		const usage = { ...emptyUsage(), cacheWrite: 100, cacheWrite1h: 250 };
		expect(calculateCost(opus, usage).cacheWrite).toBeCloseTo((100 * 8) / 1_000_000, 12);
	});
});

describe("mistral cache reads", () => {
	let server: http.Server;
	let baseUrl = "";
	let reportedUsage: Record<string, unknown> = {};

	beforeAll(async () => {
		server = http.createServer((req, res) => {
			req.resume();
			req.on("end", () => {
				res.writeHead(200, { "content-type": "text/event-stream" });
				const chunk = (choice: Record<string, unknown>, usage?: Record<string, unknown>) =>
					`data: ${JSON.stringify({ id: "cmpl_1", object: "chat.completion.chunk", created: 1, model: "codestral-latest", choices: [choice], ...(usage ? { usage } : {}) })}\n\n`;
				res.write(chunk({ index: 0, delta: { role: "assistant", content: "Hi." }, finish_reason: null }));
				res.write(chunk({ index: 0, delta: { content: "" }, finish_reason: "stop" }, reportedUsage));
				res.end("data: [DONE]\n\n");
			});
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	});

	afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

	const codestral = () => ({ ...getModel("mistral", "codestral-latest")!, baseUrl });

	it("counts and prices the cached prompt tokens Mistral reports", async () => {
		reportedUsage = { prompt_tokens: 1_000, completion_tokens: 50, total_tokens: 1_050, prompt_tokens_details: { cached_tokens: 800 } };
		const model = codestral();
		const result = await streamMistral(model, context, { apiKey: "synthetic-key" }).result();

		expect(result.stopReason).toBe("stop");
		expect(result.usage.cacheRead).toBe(800);
		expect(result.usage.input).toBe(200);
		expect(result.usage.totalTokens).toBe(1_050);
		expect(model.cost.cacheRead).toBeGreaterThan(0);
		expect(result.usage.cost.cacheRead).toBeCloseTo((800 * model.cost.cacheRead) / 1_000_000, 12);
		expect(result.usage.cost.input).toBeCloseTo((200 * model.cost.input) / 1_000_000, 12);
	});

	it("reads the older cached-token count too", async () => {
		reportedUsage = { prompt_tokens: 1_000, completion_tokens: 50, total_tokens: 1_050, num_cached_tokens: 300 };
		const result = await streamMistral(codestral(), context, { apiKey: "synthetic-key" }).result();

		expect(result.usage.cacheRead).toBe(300);
		expect(result.usage.input).toBe(700);
	});

	it("counts the cached tokens in the total when Mistral sends no total", async () => {
		reportedUsage = { prompt_tokens: 1_000, completion_tokens: 50, prompt_tokens_details: { cached_tokens: 800 } };
		const result = await streamMistral(codestral(), context, { apiKey: "synthetic-key" }).result();

		expect(result.usage.cacheRead).toBe(800);
		expect(result.usage.totalTokens).toBe(1_050);
	});

	it("keeps a report without cached tokens all input", async () => {
		reportedUsage = { prompt_tokens: 1_000, completion_tokens: 50, total_tokens: 1_050 };
		const result = await streamMistral(codestral(), context, { apiKey: "synthetic-key" }).result();

		expect(result.usage.cacheRead).toBe(0);
		expect(result.usage.input).toBe(1_000);
	});
});
