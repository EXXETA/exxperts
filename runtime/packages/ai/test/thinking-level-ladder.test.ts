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
