import { describe, expect, it } from "vitest";
import { clampThinkingLevel, getModel, getSupportedThinkingLevels, resolveThinkingLevelRung } from "../src/models.js";

describe("clampThinkingLevel", () => {
	it("settles a missing tier DOWNWARD rather than buying the model's most expensive one", () => {
		// Sonnet 4.6 names "max" but not "xhigh". Walking up would turn a request
		// for xhigh into the top tier, which is somebody's money.
		const model = getModel("anthropic", "claude-sonnet-4-6");
		expect(getSupportedThinkingLevels(model!)).not.toContain("xhigh");
		expect(clampThinkingLevel(model!, "xhigh")).toBe("high");
	});

	it("climbs only when there is nothing below the request", () => {
		// This ladder is off/high/xhigh, so a request for medium has no lower
		// thinking rung to fall to and must climb to high, never drop to off.
		const model = getModel("deepseek", "deepseek-v4-flash");
		expect(getSupportedThinkingLevels(model!)).toEqual(["off", "high", "xhigh"]);
		expect(clampThinkingLevel(model!, "medium")).toBe("high");
		expect(clampThinkingLevel(model!, "low")).toBe("high");
		expect(clampThinkingLevel(model!, "minimal")).toBe("high");
	});

	it("never answers a request for thinking with no thinking at all", () => {
		const model = getModel("deepseek", "deepseek-v4-flash");
		for (const level of ["minimal", "low", "medium", "high", "xhigh", "max"] as const) {
			expect(clampThinkingLevel(model!, level)).not.toBe("off");
		}
	});

	it("lets a request to stop climb when the model cannot stop", () => {
		// gpt-5 on the responses API pins off to null: it always reasons.
		const model = getModel("github-copilot", "gpt-5.4");
		expect(getSupportedThinkingLevels(model!)).not.toContain("off");
		expect(clampThinkingLevel(model!, "off")).toBe("minimal");
	});

	it("keeps a reachable level exactly as asked", () => {
		const model = getModel("anthropic", "claude-opus-5");
		for (const level of ["off", "low", "medium", "high", "xhigh", "max"] as const) {
			expect(clampThinkingLevel(model!, level)).toBe(level);
		}
	});
});

describe("resolveThinkingLevelRung", () => {
	it("puts an implicitly folded level on the rung that replaced it", () => {
		// Anthropic has no "minimal": the adapter folds it onto "low" with no map
		// entry to look up, which is why matching on the effort is the only way
		// to find the right rung.
		const model = getModel("anthropic", "claude-opus-5");
		expect(model!.thinkingLevelMap?.minimal).toBeUndefined();
		expect(resolveThinkingLevelRung(model!, "minimal")).toEqual({ level: "low", label: "low" });
	});

	it("never sends a thinking level to the off rung", () => {
		const model = getModel("anthropic", "claude-opus-5");
		for (const level of ["minimal", "low", "medium", "high", "xhigh", "max"] as const) {
			expect(resolveThinkingLevelRung(model!, level)?.level).not.toBe("off");
		}
	});

	it("resolves a level reached through a differently named token", () => {
		// Opus 4.6 reaches "max" through the xhigh token, so a stored "max"
		// belongs on the xhigh rung, which is labelled max.
		const model = getModel("anthropic", "claude-opus-4-6");
		expect(resolveThinkingLevelRung(model!, "max")).toEqual({ level: "xhigh", label: "max" });
	});
});
