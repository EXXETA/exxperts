import type Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import { getModel } from "../src/models.js";
import { streamAnthropic } from "../src/providers/anthropic.js";
import type { Context } from "../src/types.js";

// Some Claude models cannot have thinking off: Fable 5, 5.1 and Opus 5.5 answer a
// `thinking: { type: "disabled" }` request with a 400 that names the remedy.
// The catalogue is supposed to withhold "off" for them, but a stale
// hand-written row or a model newer than the catalogue can still send it, so
// the provider heals the one measured refusal itself: once per turn it retries
// with adaptive thinking at the lowest effort and says so in a diagnostic.
// Nothing else is retried, and a model that accepts "off" keeps it.

function sse(events: Array<Record<string, unknown>>): Response {
	const withStop = [...events, { type: "message_stop" }];
	const body = withStop.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n`).join("\n");
	return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

function doneResponse(): Response {
	return sse([
		{
			type: "message_start",
			message: {
				id: "msg_healed",
				type: "message",
				role: "assistant",
				model: "claude-fable-5",
				content: [],
				stop_reason: null,
				stop_sequence: null,
				usage: { input_tokens: 10, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
			},
		},
		{ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
		{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Healed." } },
		{ type: "content_block_stop", index: 0 },
		{ type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 5 } },
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
				return {
					asResponse: async () => {
						if (entry instanceof Error) throw entry;
						return entry;
					},
				};
			},
		},
	} as unknown as Anthropic;
	return { client, calls };
}

// The measured message, verbatim.
const DISABLED_400 = new Error(
	'400 {"type":"error","error":{"type":"invalid_request_error","message":"\\"thinking.type.disabled\\" is not supported for this model. Use \\"thinking.type.adaptive\\" and \\"output_config.effort\\" to control thinking behavior."}}',
);

const OTHER_400 = new Error(
	'400 {"type":"error","error":{"type":"invalid_request_error","message":"tools are malformed"}}',
);

function makeContext(): Context {
	return { messages: [{ role: "user", content: "hi", timestamp: Date.now() }] };
}

describe("anthropic self-healing for a model that rejects thinking off", () => {
	it("retries once with adaptive thinking at effort low and records a diagnostic", async () => {
		const model = getModel("anthropic", "claude-fable-5")!;
		const { client, calls } = createSequencedClient([DISABLED_400, doneResponse()]);
		const result = await streamAnthropic(model, makeContext(), { client, thinkingEnabled: false } as any).result();

		expect(calls.length).toBe(2);
		expect(calls[0].thinking).toEqual({ type: "disabled" });
		expect(calls[1].thinking.type).toBe("adaptive");
		expect(calls[1].thinking.budget_tokens).toBeUndefined();
		expect(calls[1].output_config).toEqual({ effort: "low" });
		expect(result.stopReason).toBe("stop");
		const healed = (result.diagnostics ?? []).filter((d) => d.type === "anthropic-thinking-off-unsupported");
		expect(healed.length).toBe(1);
		expect(healed[0].details).toEqual({ model: "claude-fable-5" });
		expect(healed[0].error?.message).toContain("thinking.type.disabled");
	});

	it("keeps the binding flag on the retry for a model that binds thinking blocks", async () => {
		const model = getModel("anthropic", "claude-fable-5-1")!;
		const { client, calls } = createSequencedClient([DISABLED_400, doneResponse()]);
		await streamAnthropic(model, makeContext(), { client, thinkingEnabled: false } as any).result();

		expect(calls.length).toBe(2);
		expect(calls[1].thinking).toEqual({
			type: "adaptive",
			block_binding: { prefix_mismatch_behavior: "drop_block" },
		});
		expect(calls[1].output_config).toEqual({ effort: "low" });
	});

	it("heals the same refusal on Opus 5.5, which words it the same way and binds its blocks too", async () => {
		const model = getModel("anthropic", "claude-opus-5-5")!;
		const { client, calls } = createSequencedClient([DISABLED_400, doneResponse()]);
		const result = await streamAnthropic(model, makeContext(), { client, thinkingEnabled: false } as any).result();

		expect(calls.length).toBe(2);
		expect(calls[0].thinking).toEqual({ type: "disabled" });
		expect(calls[1].thinking).toEqual({
			type: "adaptive",
			block_binding: { prefix_mismatch_behavior: "drop_block" },
		});
		expect(calls[1].output_config).toEqual({ effort: "low" });
		expect(result.stopReason).toBe("stop");
		const healed = (result.diagnostics ?? []).filter((d) => d.type === "anthropic-thinking-off-unsupported");
		expect(healed.length).toBe(1);
		expect(healed[0].details).toEqual({ model: "claude-opus-5-5" });
	});

	it("surfaces any other 400 after one call, with no retry", async () => {
		const model = getModel("anthropic", "claude-fable-5")!;
		const { client, calls } = createSequencedClient([OTHER_400]);
		const result = await streamAnthropic(model, makeContext(), { client, thinkingEnabled: false } as any).result();

		expect(calls.length).toBe(1);
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("tools are malformed");
		expect((result.diagnostics ?? []).some((d) => d.type === "anthropic-thinking-off-unsupported")).toBe(false);
	});

	it("surfaces the second refusal after exactly two calls when the retry fails the same way", async () => {
		const model = getModel("anthropic", "claude-fable-5")!;
		const { client, calls } = createSequencedClient([DISABLED_400, DISABLED_400]);
		const result = await streamAnthropic(model, makeContext(), { client, thinkingEnabled: false } as any).result();

		expect(calls.length).toBe(2);
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("thinking.type.disabled");
	});

	it("does not touch a request that had thinking on", async () => {
		// The refusal is about a "disabled" request. A request that already
		// thinks and fails with the same text is not this case; it surfaces.
		const model = getModel("anthropic", "claude-fable-5")!;
		const { client, calls } = createSequencedClient([DISABLED_400, doneResponse()]);
		const result = await streamAnthropic(model, makeContext(), {
			client,
			thinkingEnabled: true,
			effort: "high",
		} as any).result();

		expect(calls.length).toBe(1);
		expect(result.stopReason).toBe("error");
	});
});
