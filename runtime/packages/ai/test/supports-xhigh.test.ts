import { describe, expect, it } from "vitest";
import { getModel, getSupportedThinkingLevels } from "../src/models.js";

describe("getSupportedThinkingLevels", () => {
	it("includes xhigh for Anthropic Opus 4.6 on anthropic-messages API", () => {
		const model = getModel("anthropic", "claude-opus-4-6");
		expect(model).toBeDefined();
		expect(getSupportedThinkingLevels(model!)).toContain("xhigh");
	});

	it("includes xhigh for Anthropic Opus 4.7 on anthropic-messages API", () => {
		const model = getModel("anthropic", "claude-opus-4-7");
		expect(model).toBeDefined();
		expect(getSupportedThinkingLevels(model!)).toContain("xhigh");
	});

	it("does not include xhigh for non-Opus Anthropic models", () => {
		const model = getModel("anthropic", "claude-sonnet-4-5");
		expect(model).toBeDefined();
		expect(getSupportedThinkingLevels(model!)).not.toContain("xhigh");
	});

	it.each(["gpt-5.4", "gpt-5.5"] as const)("includes xhigh for %s models", (modelId) => {
		const model = getModel("openai-codex", modelId);
		expect(model).toBeDefined();
		expect(getSupportedThinkingLevels(model!)).toContain("xhigh");
	});

	it.each(["gpt-5.6-luna", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-6-sol", "gpt-6-luna"] as const)(
		"includes xhigh and max for %s models",
		(modelId) => {
			const model = getModel("openai-codex", modelId);
			expect(model).toBeDefined();
			expect(getSupportedThinkingLevels(model!)).toContain("xhigh");
			expect(getSupportedThinkingLevels(model!)).toContain("max");
		},
	);

	it("includes xhigh and max for the 5.6 family on the API route too", () => {
		const model = getModel("openai", "gpt-5.6-luna");
		expect(model).toBeDefined();
		expect(getSupportedThinkingLevels(model!)).toContain("xhigh");
		expect(getSupportedThinkingLevels(model!)).toContain("max");
	});

	it("carries the GPT-6 family to xhigh and max on the API route and never offers off", () => {
		const model = getModel("openai", "gpt-6-astra");
		expect(model).toBeDefined();
		const levels = getSupportedThinkingLevels(model!);
		expect(levels).toContain("xhigh");
		expect(levels).toContain("max");
		// Astra has no "none" effort: an "off" here would reach the wire as
		// reasoning.effort "none", which the model rejects.
		expect(levels).not.toContain("off");
	});

	it("does not include max for the generation below 5.6", () => {
		const model = getModel("openai-codex", "gpt-5.5");
		expect(model).toBeDefined();
		expect(getSupportedThinkingLevels(model!)).not.toContain("max");
	});

	it("includes only high/xhigh plus off for DeepSeek V4 Flash on the DeepSeek provider", () => {
		const model = getModel("deepseek", "deepseek-v4-flash");
		expect(model).toBeDefined();
		expect(getSupportedThinkingLevels(model!)).toEqual(["off", "high", "xhigh"]);
	});

	it("includes only high/xhigh plus off for DeepSeek V4 Flash on opencode-go", () => {
		const model = getModel("opencode-go", "deepseek-v4-flash");
		expect(model).toBeDefined();
		expect(getSupportedThinkingLevels(model!)).toEqual(["off", "high", "xhigh"]);
	});

	it("includes only high/xhigh plus off for DeepSeek V4 Flash on OpenRouter", () => {
		const model = getModel("openrouter", "deepseek/deepseek-v4-flash");
		expect(model).toBeDefined();
		expect(getSupportedThinkingLevels(model!)).toEqual(["off", "high", "xhigh"]);
	});

	it("includes xhigh for OpenRouter Opus 4.6 (openai-completions API)", () => {
		const model = getModel("openrouter", "anthropic/claude-opus-4.6");
		expect(model).toBeDefined();
		expect(getSupportedThinkingLevels(model!)).toContain("xhigh");
	});
});
