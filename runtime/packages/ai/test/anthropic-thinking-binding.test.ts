import { beforeEach, describe, expect, it, vi } from "vitest";
import { getModel } from "../src/models.js";
import { streamAnthropic, streamSimpleAnthropic } from "../src/providers/anthropic.js";
import type { Context } from "../src/types.js";

// Claude Fable 5.1, Mythos 5.1 and Opus 5.5 bind every thinking block to the
// exact prefix it was produced under, and this app rebuilds the system prompt with
// live room state on every turn. The provider opts those models into the
// documented remedy (drop the stale block, answer anyway) and records what the
// API dropped, without ever rewriting the stored history. These pin the three
// halves: the request field, the beta header on both auth paths, and the
// diagnostic on the way back.

const mockState = vi.hoisted(() => ({
	constructorOpts: undefined as Record<string, unknown> | undefined,
	createParams: undefined as Record<string, unknown> | undefined,
	messageStartExtras: {} as Record<string, unknown>,
}));

vi.mock("@anthropic-ai/sdk", () => {
	function createSseResponse(): Response {
		const events = [
			{
				type: "message_start",
				message: {
					id: "msg_test",
					type: "message",
					role: "assistant",
					model: "claude-fable-5-1",
					content: [],
					stop_reason: null,
					stop_sequence: null,
					usage: {
						input_tokens: 10,
						output_tokens: 0,
						cache_read_input_tokens: 0,
						cache_creation_input_tokens: 0,
					},
					...mockState.messageStartExtras,
				},
			},
			{ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
			{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hello." } },
			{ type: "content_block_stop", index: 0 },
			{
				type: "message_delta",
				delta: { stop_reason: "end_turn", stop_sequence: null },
				usage: { output_tokens: 5 },
			},
			{ type: "message_stop" },
		];
		const body = events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n`).join("\n");
		return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
	}

	class FakeAnthropic {
		constructor(opts: Record<string, unknown>) {
			mockState.constructorOpts = opts;
		}
		messages = {
			create: (params: Record<string, unknown>) => {
				mockState.createParams = params;
				return { asResponse: async () => createSseResponse() };
			},
		};
	}

	return { default: FakeAnthropic };
});

const BINDING_BETA = "thinking-binding-controls-2026-08-01";
const API_KEY = "sk-ant-api03-test-key";
const OAUTH_KEY = "sk-ant-oat01-test-token";

function makeContext(): Context {
	return {
		systemPrompt: "You are a helpful assistant.",
		messages: [{ role: "user", content: "Hello", timestamp: Date.now() }],
	};
}

async function requestWithReasoning(modelId: string, apiKey: string) {
	const model = getModel("anthropic", modelId);
	expect(model, modelId).toBeDefined();
	const s = streamSimpleAnthropic(model!, makeContext(), { apiKey, reasoning: "high" });
	for await (const event of s) {
		if (event.type === "error") break;
	}
	const headers = (mockState.constructorOpts?.defaultHeaders ?? {}) as Record<string, string>;
	return { params: mockState.createParams as any, beta: headers["anthropic-beta"] ?? "" };
}

beforeEach(() => {
	mockState.constructorOpts = undefined;
	mockState.createParams = undefined;
	mockState.messageStartExtras = {};
});

describe("thinking-block binding on the models that enforce it", () => {
	it("claude-fable-5-1 asks the API to drop a block bound to a different prefix (API key path)", async () => {
		const { params, beta } = await requestWithReasoning("claude-fable-5-1", API_KEY);
		expect(params.thinking.type).toBe("adaptive");
		expect(params.thinking.block_binding).toEqual({ prefix_mismatch_behavior: "drop_block" });
		expect(beta).toContain(BINDING_BETA);
	});

	it("claude-fable-5-1 carries the same field and beta on the subscription (OAuth) path", async () => {
		const { params, beta } = await requestWithReasoning("claude-fable-5-1", OAUTH_KEY);
		expect(params.thinking.block_binding).toEqual({ prefix_mismatch_behavior: "drop_block" });
		expect(beta).toContain(BINDING_BETA);
		// The OAuth identity betas are still there in front of it.
		expect(beta).toContain("oauth-2025-04-20");
	});

	it("claude-opus-5-5 asks the API to drop a block bound to a different prefix (API key path)", async () => {
		const { params, beta } = await requestWithReasoning("claude-opus-5-5", API_KEY);
		expect(params.thinking.type).toBe("adaptive");
		expect(params.thinking.block_binding).toEqual({ prefix_mismatch_behavior: "drop_block" });
		expect(beta).toContain(BINDING_BETA);
	});

	it("claude-opus-5-5 carries the same field and beta on the subscription (OAuth) path", async () => {
		const { params, beta } = await requestWithReasoning("claude-opus-5-5", OAUTH_KEY);
		expect(params.thinking.block_binding).toEqual({ prefix_mismatch_behavior: "drop_block" });
		expect(beta).toContain(BINDING_BETA);
		expect(beta).toContain("oauth-2025-04-20");
	});

	// The negative case: the earlier Claude 5 rows are not bound and must stay
	// free of both the field and the beta.
	it.each(["claude-opus-5", "claude-fable-5"])("%s is not a binding model and carries neither the field nor the beta", async (modelId) => {
		const { params, beta } = await requestWithReasoning(modelId, API_KEY);
		expect(params.thinking.type).toBe("adaptive");
		expect(params.thinking.block_binding).toBeUndefined();
		expect(beta).not.toContain(BINDING_BETA);
	});
});

describe("input_transformations on the way back", () => {
	it("records what the API dropped as one diagnostic and leaves the message content as streamed", async () => {
		mockState.messageStartExtras = {
			input_transformations: [
				{ type: "thinking_dropped", path: "messages.4.content.0", reason: "prefix_binding_mismatch" },
				{ type: "thinking_dropped", path: "messages.6.content.0", reason: "prefix_binding_mismatch" },
			],
		};
		const model = getModel("anthropic", "claude-fable-5-1")!;
		const result = await streamAnthropic(model, makeContext(), {
			apiKey: API_KEY,
			thinkingEnabled: true,
			effort: "high",
		}).result();

		expect(result.stopReason).toBe("stop");
		const dropped = (result.diagnostics ?? []).filter((d) => d.type === "anthropic-thinking-dropped");
		expect(dropped.length).toBe(1);
		expect(dropped[0].details).toEqual({
			model: "claude-fable-5-1",
			dropped: [
				{ type: "thinking_dropped", path: "messages.4.content.0", reason: "prefix_binding_mismatch" },
				{ type: "thinking_dropped", path: "messages.6.content.0", reason: "prefix_binding_mismatch" },
			],
		});
		// A diagnostics view has a sentence to show, not just a type.
		expect(dropped[0].error?.message).toContain("2 thinking blocks");
		// The content is exactly what the stream produced: nothing removed,
		// nothing added, no trace of the transformation in the message itself.
		expect(result.content).toEqual([{ type: "text", text: "Hello." }]);
	});

	it("records nothing when the response carries no transformations", async () => {
		const model = getModel("anthropic", "claude-fable-5-1")!;
		const result = await streamAnthropic(model, makeContext(), {
			apiKey: API_KEY,
			thinkingEnabled: true,
			effort: "high",
		}).result();
		expect((result.diagnostics ?? []).some((d) => d.type === "anthropic-thinking-dropped")).toBe(false);
		expect(result.content).toEqual([{ type: "text", text: "Hello." }]);
	});
});
