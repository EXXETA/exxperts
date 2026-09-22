import { describe, expect, it } from "vitest";
import { getModel, getThinkingLevelLadder } from "../src/models.js";

describe("getThinkingLevelLadder", () => {
	it("folds Anthropic's minimal and low into the one rung they both produce", () => {
		const model = getModel("anthropic", "claude-opus-5");
		expect(model).toBeDefined();
		const ladder = getThinkingLevelLadder(model!);
		// Both internal tokens map to effort "low", so the dial shows it once,
		// under the token whose own name matches the effort.
		expect(ladder.map((rung) => rung.level)).toEqual(["off", "low", "medium", "high", "xhigh", "max"]);
		expect(ladder.map((rung) => rung.label)).toEqual(["off", "low", "medium", "high", "xhigh", "max"]);
	});

	it.each(["claude-fable-5-1", "claude-fable-5", "claude-opus-5-5"] as const)("gives %s no off rung, because its thinking cannot be disabled", (modelId) => {
		const model = getModel("anthropic", modelId);
		expect(model).toBeDefined();
		const ladder = getThinkingLevelLadder(model!);
		// The Fable family and Opus 5.5 take adaptive thinking only, always on:
		// a request to disable it is a 400, so the dial never offers "off".
		expect(ladder.map((rung) => rung.level)).toEqual(["low", "medium", "high", "xhigh", "max"]);
		expect(ladder.map((rung) => rung.label)).toEqual(["low", "medium", "high", "xhigh", "max"]);
	});

	it.each(["claude-sonnet-5", "claude-sonnet-4-5"] as const)("still lets %s be switched off", (modelId) => {
		const model = getModel("anthropic", modelId);
		expect(model).toBeDefined();
		const ladder = getThinkingLevelLadder(model!);
		// Only the Fable and Mythos families and Opus 5.5 reject thinking
		// disabled; every other Claude row keeps "off" as its first rung.
		expect(ladder[0]).toEqual({ level: "off", label: "off" });
	});

	it("keeps every rung distinct for an OpenAI-family model that cannot stop reasoning", () => {
		const model = getModel("github-copilot", "gpt-5.4");
		expect(model).toBeDefined();
		const ladder = getThinkingLevelLadder(model!);
		expect(ladder.map((rung) => rung.level)).toEqual(["minimal", "low", "medium", "high", "xhigh"]);
		// Labels equal the tokens: this family names its efforts the way we do.
		expect(ladder.every((rung) => rung.level === rung.label)).toBe(true);
	});

	it("folds an explicitly mapped duplicate outside the Anthropic family too", () => {
		const model = getModel("openai-codex", "gpt-5.4");
		expect(model).toBeDefined();
		const ladder = getThinkingLevelLadder(model!);
		// This surface maps minimal onto "low", so the dial shows "low" once.
		expect(ladder.map((rung) => rung.level)).toEqual(["off", "low", "medium", "high", "xhigh"]);
		expect(ladder.some((rung) => rung.level === "minimal")).toBe(false);
	});

	it("gives the GPT-6 family the ladder its maker states, low to max with no off", () => {
		const model = getModel("openai", "gpt-6-astra");
		expect(model).toBeDefined();
		const ladder = getThinkingLevelLadder(model!);
		expect(ladder.map((rung) => rung.level)).toEqual(["low", "medium", "high", "xhigh", "max"]);
		expect(ladder.map((rung) => rung.label)).toEqual(["low", "medium", "high", "xhigh", "max"]);
	});

	it("gives GPT-6 Astra on the subscription route the maker's ladder, minimal folded onto low and no off", () => {
		const model = getModel("openai-codex", "gpt-6-astra");
		expect(model).toBeDefined();
		const ladder = getThinkingLevelLadder(model!);
		expect(ladder.map((rung) => rung.level)).toEqual(["low", "medium", "high", "xhigh", "max"]);
		expect(ladder.some((rung) => rung.level === "minimal")).toBe(false);
	});

	it.each(["gpt-6-sol", "gpt-6-luna"] as const)("gives %s on the API route the full ladder, off to max, because it takes effort none", (modelId) => {
		const model = getModel("openai", modelId);
		expect(model).toBeDefined();
		const ladder = getThinkingLevelLadder(model!);
		// Sol and Luna take reasoning.effort "none" (unlike Astra), so off stays;
		// minimal folds onto low, and xhigh and max come from the family rule.
		expect(ladder.map((rung) => rung.level)).toEqual(["off", "low", "medium", "high", "xhigh", "max"]);
		expect(ladder.some((rung) => rung.level === "minimal")).toBe(false);
	});

	it.each(["gpt-6-sol", "gpt-6-luna"] as const)("gives %s on the subscription route the same ladder, off to max", (modelId) => {
		const model = getModel("openai-codex", modelId);
		expect(model).toBeDefined();
		const ladder = getThinkingLevelLadder(model!);
		expect(ladder.map((rung) => rung.level)).toEqual(["off", "low", "medium", "high", "xhigh", "max"]);
		expect(ladder.some((rung) => rung.level === "minimal")).toBe(false);
	});

	it("carries the 5.6 family all the way to max on the subscription route", () => {
		const model = getModel("openai-codex", "gpt-5.6-luna");
		expect(model).toBeDefined();
		const ladder = getThinkingLevelLadder(model!);
		expect(ladder.map((rung) => rung.level)).toEqual(["off", "low", "medium", "high", "xhigh", "max"]);
		// This surface folds minimal onto "low" like its 5.5 sibling does.
		expect(ladder.some((rung) => rung.level === "minimal")).toBe(false);
	});

	it("carries the 5.6 family all the way to max on the API route too", () => {
		const model = getModel("openai", "gpt-5.6-luna");
		expect(model).toBeDefined();
		const ladder = getThinkingLevelLadder(model!);
		expect(ladder.map((rung) => rung.level)).toEqual(["minimal", "low", "medium", "high", "xhigh", "max"]);
	});

	it("labels the off rung with the effort a model actually sends for it", () => {
		const model = getModel("openai", "gpt-5.4");
		expect(model).toBeDefined();
		const ladder = getThinkingLevelLadder(model!);
		expect(ladder[0]).toEqual({ level: "off", label: "none" });
	});

	it("labels a rung with the effort its model actually sends", () => {
		const model = getModel("anthropic", "claude-opus-4-6");
		expect(model).toBeDefined();
		const ladder = getThinkingLevelLadder(model!);
		// Opus 4.6 reaches its top tier through the xhigh token, but the effort
		// it sends is "max", so that is what the dial says.
		expect(ladder.find((rung) => rung.level === "xhigh")?.label).toBe("max");
		expect(ladder.some((rung) => rung.level === "max")).toBe(false);
	});

	it("gives a non-reasoning model a single off rung", () => {
		const model = getModel("anthropic", "claude-haiku-4-5");
		expect(model).toBeDefined();
		const ladder = getThinkingLevelLadder(model!);
		expect(ladder.some((rung) => rung.level === "xhigh")).toBe(false);
		expect(ladder[0]).toEqual({ level: "off", label: "off" });
	});
});
