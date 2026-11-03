import { describe, expect, it } from "vitest";
import { ANTHROPIC_API_KEY_PROVIDER, clampThinkingLevel, getModel, getThinkingLevelLadder } from "../src/models.js";
import { streamSimple } from "../src/stream.js";
import type { Api, KnownProvider, Model, ModelThinkingLevel } from "../src/types.js";

// The Codex route reads the account id out of the sign-in token before it builds a request.
const CODEX_TOKEN = `aaa.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acc_test" } })).toString("base64")}.bbb`;

const CAPTURED = new Error("payload captured");

interface WirePayload {
	reasoning?: { effort?: string };
	thinking?: { type?: string };
	output_config?: { effort?: string };
}

/**
 * The request body a room's level produces, the way a room sends it: the server
 * clamps the level to the model (ai-models.ts), the session clamps a worker's
 * level the same way (sdk.ts), and the agent turns "off" into no level at all.
 */
async function wireFor(model: Model<Api>, level: ModelThinkingLevel): Promise<WirePayload> {
	const effective = clampThinkingLevel(model, level);
	let captured: WirePayload | undefined;
	const stream = streamSimple({ ...model, baseUrl: "http://127.0.0.1:9" }, { messages: [{ role: "user", content: "Hello", timestamp: Date.now() }] }, {
		apiKey: model.provider === "openai-codex" ? CODEX_TOKEN : "fake-key",
		reasoning: effective === "off" ? undefined : effective,
		onPayload: (payload) => {
			captured = payload as WirePayload;
			throw CAPTURED;
		},
	});
	await stream.result();
	if (!captured) throw new Error(`no payload captured for ${model.provider}/${model.id} at ${level}`);
	return captured;
}

/** What the provider receives for thinking: the effort, or the thinking type and effort on Claude. */
function sentValue(payload: WirePayload): string {
	if (payload.thinking) return [payload.thinking.type, payload.output_config?.effort].filter(Boolean).join("+");
	return payload.reasoning?.effort ?? "(no field)";
}

// The Anthropic key's rows are added at load time, so its name is not a KnownProvider.
function modelOn(provider: KnownProvider | typeof ANTHROPIC_API_KEY_PROVIDER, id: string): Model<Api> {
	const model = getModel(provider as KnownProvider, id as never) as Model<Api> | undefined;
	if (!model) throw new Error(`${provider}/${id} is not in the catalogue`);
	return model;
}

// The efforts OpenAI's Responses API accepted for each model, from live calls
// (a 400 names the supported values; "none" or "max" answered 200 where listed).
// The ChatGPT sign-in and Azure serve the same models and are held to the same values.
const OPENAI_ACCEPTED: Record<string, string[]> = {
	"gpt-6.1-sol": ["low", "medium", "high", "xhigh", "max"],
	"gpt-6.1-terra": ["none", "low", "medium", "high", "xhigh", "max"],
	"gpt-6-sol": ["none", "low", "medium", "high", "xhigh", "max"],
	"gpt-6-luna": ["none", "low", "medium", "high", "xhigh", "max"],
	"gpt-6-astra": ["low", "medium", "high", "xhigh", "max"],
	"gpt-5.6": ["none", "low", "medium", "high", "xhigh", "max"],
	"gpt-5.6-sol": ["none", "low", "medium", "high", "xhigh", "max"],
	"gpt-5.6-terra": ["none", "low", "medium", "high", "xhigh", "max"],
	"gpt-5.6-luna": ["none", "low", "medium", "high", "xhigh", "max"],
	"gpt-5.5": ["none", "low", "medium", "high", "xhigh"],
	"gpt-5.4": ["none", "low", "medium", "high", "xhigh"],
	"gpt-5.4-mini": ["none", "low", "medium", "high", "xhigh"],
	"gpt-5.4-nano": ["none", "low", "medium", "high", "xhigh"],
	"gpt-5.3-codex": ["none", "low", "medium", "high", "xhigh"],
	"gpt-5.2": ["none", "low", "medium", "high", "xhigh"],
	"gpt-5.1": ["none", "low", "medium", "high"],
	"gpt-5": ["minimal", "low", "medium", "high"],
	"gpt-5-pro": ["high"],
	"gpt-5.2-pro": ["medium", "high", "xhigh"],
	"gpt-5.4-pro": ["medium", "high", "xhigh"],
	"gpt-5.5-pro": ["medium", "high", "xhigh"],
	o3: ["low", "medium", "high"],
};

// Anthropic's answers: the thinking types and efforts a live call accepted,
// and the ones it refused with a 400.
const ANTHROPIC_ACCEPTED: Record<string, string[]> = {
	"claude-sonnet-5-5": ["between_tools", "adaptive+low", "adaptive+medium", "adaptive+high", "adaptive+xhigh", "adaptive+max"],
	"claude-opus-5-5": ["adaptive+low", "adaptive+medium", "adaptive+high", "adaptive+xhigh", "adaptive+max"],
	"claude-fable-5-1": ["adaptive+low", "adaptive+medium", "adaptive+high", "adaptive+xhigh", "adaptive+max"],
	"claude-fable-5": ["adaptive+low", "adaptive+medium", "adaptive+high", "adaptive+xhigh", "adaptive+max"],
	"claude-opus-4-7": ["disabled", "adaptive+low", "adaptive+medium", "adaptive+high", "adaptive+xhigh", "adaptive+max"],
	"claude-sonnet-4-6": ["disabled", "adaptive+low", "adaptive+medium", "adaptive+high", "adaptive+max"],
};

const OPENAI_SURFACES = ["openai", "openai-codex", "azure-openai-responses"] as const;

/** Every level a person can reach on a model: each rung of its dial, plus off, which a room or a worker may ask for anyway. */
function reachableLevels(model: Model<Api>): ModelThinkingLevel[] {
	return [...new Set<ModelThinkingLevel>(["off", ...getThinkingLevelLadder(model).map((rung) => rung.level)])];
}

describe("effort on the wire", () => {
	describe("every level a probed model offers is one its provider accepts", () => {
		const openAiCases = OPENAI_SURFACES.flatMap((provider) =>
			Object.keys(OPENAI_ACCEPTED)
				.filter((id) => getModel(provider, id as never) !== undefined)
				.map((id) => [provider, id] as const),
		);
		it.each(openAiCases)("%s %s", async (provider, id) => {
			const model = modelOn(provider, id);
			const accepted = [...OPENAI_ACCEPTED[id], "(no field)"];
			for (const level of reachableLevels(model)) {
				expect(accepted, `${provider}/${id} at ${level}`).toContain(sentValue(await wireFor(model, level)));
			}
		});

		it.each(Object.keys(ANTHROPIC_ACCEPTED).flatMap((id) => [["anthropic", id] as const, ["anthropic-api-key", id] as const]))("%s %s", async (provider, id) => {
			const model = modelOn(provider, id);
			for (const level of reachableLevels(model)) {
				expect(ANTHROPIC_ACCEPTED[id], `${provider}/${id} at ${level}`).toContain(sentValue(await wireFor(model, level)));
			}
		});
	});

	it("offers max on Claude Opus 4.7, which Anthropic accepts", async () => {
		const model = modelOn("anthropic", "claude-opus-4-7");
		expect(getThinkingLevelLadder(model).map((rung) => rung.level)).toEqual(["off", "low", "medium", "high", "xhigh", "max"]);
		expect(sentValue(await wireFor(model, "max"))).toBe("adaptive+max");
		// xhigh stays its own rung below max.
		expect(sentValue(await wireFor(model, "xhigh"))).toBe("adaptive+xhigh");
	});

	it.each([
		["openai", "gpt-5.1"],
		["openai", "gpt-5.4"],
		["openai", "gpt-5.6-sol"],
		["openai-codex", "gpt-5.1"],
		["openai-codex", "gpt-5.1-codex-max"],
		["azure-openai-responses", "gpt-5.5"],
		["github-copilot", "gpt-5.4"],
		["github-copilot", "gpt-5.6-luna"],
	] as const)("folds minimal onto low on %s %s, which rejects minimal", async (provider, id) => {
		const model = modelOn(provider, id);
		expect(getThinkingLevelLadder(model).some((rung) => rung.level === "minimal")).toBe(false);
		// A room that stored minimal before still sends an effort the model takes.
		expect(sentValue(await wireFor(model, "minimal"))).toBe("low");
	});

	it.each(["openai", "azure-openai-responses", "github-copilot"] as const)("keeps minimal on GPT-5 on %s, which accepts it", async (provider) => {
		const model = modelOn(provider, provider === "github-copilot" ? "gpt-5-mini" : "gpt-5");
		expect(getThinkingLevelLadder(model)[0]).toEqual({ level: "minimal", label: "minimal" });
		expect(sentValue(await wireFor(model, "minimal"))).toBe("minimal");
	});

	it.each([
		["openai", "gpt-5.6"],
		["openai", "gpt-5.6-sol"],
		["openai", "gpt-5.6-terra"],
		["openai", "gpt-5.6-luna"],
		["azure-openai-responses", "gpt-5.6-sol"],
		["azure-openai-responses", "gpt-5.4"],
		["azure-openai-responses", "gpt-6-sol"],
	] as const)("offers off on %s %s and sends it as effort none", async (provider, id) => {
		const model = modelOn(provider, id);
		expect(getThinkingLevelLadder(model)[0]).toEqual({ level: "off", label: "none" });
		expect(sentValue(await wireFor(model, "off"))).toBe("none");
	});

	it.each([
		["openai", "gpt-5-pro", ["high"]],
		["openai", "gpt-5.2-pro", ["medium", "high", "xhigh"]],
		["openai", "gpt-5.4-pro", ["medium", "high", "xhigh"]],
		["openai", "gpt-5.5-pro", ["medium", "high", "xhigh"]],
		["azure-openai-responses", "gpt-5-pro", ["high"]],
		["azure-openai-responses", "gpt-5.5-pro", ["medium", "high", "xhigh"]],
		["openai", "o3", ["low", "medium", "high"]],
		["openai", "o4-mini", ["low", "medium", "high"]],
		["azure-openai-responses", "o3", ["low", "medium", "high"]],
	] as const)("offers %s %s only the efforts it takes", async (provider, id, levels) => {
		const model = modelOn(provider, id);
		expect(getThinkingLevelLadder(model).map((rung) => rung.level)).toEqual(levels);
		// Off on a model that cannot stop thinking goes out at its cheapest rung, never as "none".
		expect(sentValue(await wireFor(model, "off"))).toBe(levels[0]);
	});

	describe("off on a ChatGPT sign-in room", () => {
		it.each(["gpt-5.1", "gpt-5.4", "gpt-5.5", "gpt-5.6-sol", "gpt-6-sol", "gpt-6-luna", "gpt-6.1-terra"])("sends effort none on %s, which takes it", async (id) => {
			const model = modelOn("openai-codex", id);
			expect(getThinkingLevelLadder(model)[0]).toEqual({ level: "off", label: "none" });
			expect(sentValue(await wireFor(model, "off"))).toBe("none");
			// A level still goes out as that level.
			expect(sentValue(await wireFor(model, "medium"))).toBe("medium");
		});

		it.each(["gpt-6.1-sol", "gpt-6-astra"])("never offers off on %s, and a worker's off goes out at low", async (id) => {
			// The memory upkeep calls ask for off; these models reject effort none.
			const model = modelOn("openai-codex", id);
			expect(getThinkingLevelLadder(model).some((rung) => rung.level === "off")).toBe(false);
			expect(sentValue(await wireFor(model, "off"))).toBe("low");
		});
	});

	describe("off on Claude Sonnet 5.5", () => {
		it.each(["anthropic", "anthropic-api-key"] as const)("is offered on %s and sends thinking between_tools", async (provider) => {
			const model = modelOn(provider, "claude-sonnet-5-5");
			// The rung keeps the name off: between_tools is how this model stops thinking, not an effort.
			expect(getThinkingLevelLadder(model)[0]).toEqual({ level: "off", label: "off" });
			const payload = await wireFor(model, "off");
			expect(payload.thinking).toEqual({ type: "between_tools" });
			expect(payload.output_config).toBeUndefined();
		});

		it.each(["claude-opus-5-5", "claude-fable-5-1", "claude-fable-5"])("stays hidden on %s, which rejects both disabled and between_tools", async (id) => {
			const model = modelOn("anthropic", id);
			expect(getThinkingLevelLadder(model).some((rung) => rung.level === "off")).toBe(false);
			expect(sentValue(await wireFor(model, "off"))).toBe("adaptive+low");
		});

		it("still sends disabled on Sonnet 5, which accepts it", async () => {
			expect(sentValue(await wireFor(modelOn("anthropic", "claude-sonnet-5"), "off"))).toBe("disabled");
		});
	});
});
