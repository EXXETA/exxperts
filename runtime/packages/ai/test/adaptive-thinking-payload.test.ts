import { describe, expect, it } from "vitest";
import { getModel } from "../src/models.js";
import { streamSimpleAnthropic } from "../src/providers/anthropic.js";
import { streamSimpleBedrock } from "../src/providers/amazon-bedrock.js";
import type { Api, Context, Model, ThinkingLevel } from "../src/types.js";

// The tiers above "high" are only real if they reach the provider as an
// EFFORT. A model that falls to budget-based thinking sends a token budget
// instead, and every tier above "medium" shares the same budget, so "max",
// "xhigh" and "high" become the same request with three different names. That
// is exactly what happened to the Claude 5 generation while the adaptive-
// thinking gate matched on model ids. These probes capture the outgoing
// payload and fail if a top tier ever silently becomes a budget again.

interface AnthropicThinkingPayload {
	thinking?: { type: string; budget_tokens?: number; display?: string };
	output_config?: { effort?: string };
}

interface BedrockThinkingPayload {
	additionalModelRequestFields?: {
		thinking?: { type: string; budget_tokens?: number; display?: string };
		output_config?: { effort?: string };
	};
}

function makeContext(): Context {
	return { messages: [{ role: "user", content: "Hello", timestamp: Date.now() }] };
}

async function capture<TApi extends Api>(
	stream: (model: Model<TApi>, context: Context, options?: any) => AsyncIterable<{ type: string }>,
	model: Model<TApi>,
	reasoning: ThinkingLevel,
): Promise<any> {
	let captured: unknown;
	// The request is aborted before it leaves: the payload is built either way,
	// and nothing here needs a network or a key.
	const events = stream(model, makeContext(), {
		reasoning,
		apiKey: "probe-key",
		signal: AbortSignal.abort(),
		onPayload: (payload: unknown) => {
			captured = payload;
			return payload;
		},
	});
	for await (const event of events) {
		if (event.type === "error") break;
	}
	if (!captured) throw new Error(`no payload captured for reasoning=${reasoning}`);
	return captured;
}

describe("adaptive thinking reaches the provider as an effort", () => {
	it.each(["claude-opus-5", "claude-fable-5", "claude-sonnet-5"] as const)(
		"%s sends output_config effort, never a thinking budget",
		async (modelId) => {
			const model = getModel("anthropic", modelId);
			expect(model).toBeDefined();

			for (const [level, effort] of [
				["high", "high"],
				["xhigh", "xhigh"],
				["max", "max"],
			] as const) {
				const payload = (await capture(streamSimpleAnthropic, model!, level)) as AnthropicThinkingPayload;
				expect(payload.output_config, `${modelId} at ${level} should carry an effort`).toEqual({ effort });
				expect(payload.thinking?.type, `${modelId} at ${level} should think adaptively`).toBe("adaptive");
				expect(
					payload.thinking?.budget_tokens,
					`${modelId} at ${level} must not fall back to a token budget`,
				).toBeUndefined();
			}
		},
	);

	it("gives the three top levels three DIFFERENT requests, which budgets could not", async () => {
		const model = getModel("anthropic", "claude-opus-5");
		const efforts = [];
		for (const level of ["high", "xhigh", "max"] as const) {
			const payload = (await capture(streamSimpleAnthropic, model!, level)) as AnthropicThinkingPayload;
			efforts.push(payload.output_config?.effort);
		}
		expect(new Set(efforts).size).toBe(3);
	});

	it("clamps a level the model cannot reach down instead of collapsing it to high", async () => {
		// Opus 4.7 names "xhigh" and not "max", so a request for max is its top
		// tier, not a fall through the mapping switch back to "high".
		const model = getModel("anthropic", "claude-opus-4-7");
		const payload = (await capture(streamSimpleAnthropic, model!, "max")) as AnthropicThinkingPayload;
		expect(payload.output_config).toEqual({ effort: "xhigh" });
	});

	it("carries the same fix through Bedrock", async () => {
		const model = getModel("amazon-bedrock", "us.anthropic.claude-opus-5");
		expect(model).toBeDefined();
		const payload = (await capture(streamSimpleBedrock, model!, "max")) as BedrockThinkingPayload;
		expect(payload.additionalModelRequestFields?.output_config).toEqual({ effort: "max" });
		expect(payload.additionalModelRequestFields?.thinking?.budget_tokens).toBeUndefined();
	});

	it("leaves a budget-thinking model on budgets", async () => {
		// Sonnet 4.5 names no effort at all, so it must keep the older path.
		const model = getModel("anthropic", "claude-sonnet-4-5");
		const payload = (await capture(streamSimpleAnthropic, model!, "high")) as AnthropicThinkingPayload;
		expect(payload.thinking?.type).toBe("enabled");
		expect(payload.output_config).toBeUndefined();
	});
});
