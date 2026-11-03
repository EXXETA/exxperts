import { BedrockRuntimeClient } from "@aws-sdk/client-bedrock-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getModel } from "../src/models.js";
import { type BedrockOptions, streamBedrock } from "../src/providers/amazon-bedrock.js";
import type { Model } from "../src/types.js";

interface BedrockCachePayload {
	system?: Record<string, unknown>[];
	messages: { role: string; content: Record<string, unknown>[] }[];
}

// The name defaults to the id, so a case about an id form cannot pass on its name alone.
function bedrockModel(id: string, name = id): Model<"bedrock-converse-stream"> {
	return { ...getModel("amazon-bedrock", "global.anthropic.claude-opus-4-6-v1"), id, name };
}

async function capturePayload(
	model: Model<"bedrock-converse-stream">,
	options?: BedrockOptions,
): Promise<BedrockCachePayload> {
	let captured: BedrockCachePayload | undefined;
	const s = streamBedrock(
		model,
		{
			systemPrompt: "You are helpful.",
			messages: [{ role: "user", content: "Hello", timestamp: Date.now() }],
		},
		{
			...options,
			signal: AbortSignal.abort(),
			onPayload: (payload) => {
				captured = payload as BedrockCachePayload;
				return payload;
			},
		},
	);
	for await (const event of s) {
		if (event.type === "error") break;
	}
	if (!captured) throw new Error("Expected the Bedrock payload to be captured before the request aborts");
	return captured;
}

function cachePoints(payload: BedrockCachePayload): { system: unknown; lastUser: unknown } {
	const lastUser = payload.messages[payload.messages.length - 1];
	return {
		system: payload.system?.at(-1)?.cachePoint,
		lastUser: lastUser.role === "user" ? lastUser.content.at(-1)?.cachePoint : undefined,
	};
}

const CLAUDE_5_MODELS = [
	"anthropic.claude-opus-5-5",
	"anthropic.claude-sonnet-5-5",
	"anthropic.claude-fable-5-1",
	"anthropic.claude-haiku-5-5",
	"anthropic.claude-opus-5",
	"anthropic.claude-sonnet-5",
	"anthropic.claude-fable-5",
];
const PROFILE_PREFIXES = ["", "us.", "eu.", "global.", "apac."];

const CLAUDE_5_CASES = CLAUDE_5_MODELS.flatMap((id) => PROFILE_PREFIXES.map((prefix) => `${prefix}${id}`));

// Both settings change the cache points, so a value inherited from the shell must not leak into a case.
const CACHE_SETTINGS = ["AWS_BEDROCK_FORCE_CACHE", "PI_CACHE_RETENTION"] as const;

describe("Bedrock cache points", () => {
	const saved = CACHE_SETTINGS.map((key) => [key, process.env[key]] as const);
	beforeEach(() => {
		for (const key of CACHE_SETTINGS) delete process.env[key];
		// The payload is all these cases read; a rejected send skips AWS credential discovery.
		vi.spyOn(BedrockRuntimeClient.prototype, "send").mockRejectedValue(new Error("no request in this test"));
	});
	afterEach(() => {
		vi.restoreAllMocks();
		for (const [key, value] of saved) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	});

	it.each(CLAUDE_5_CASES)("caches the system prompt and last user message for %s", async (id) => {
		const payload = await capturePayload(bedrockModel(id));
		expect(cachePoints(payload)).toEqual({ system: { type: "default" }, lastUser: { type: "default" } });
	});

	it.each(CLAUDE_5_CASES)("uses the one-hour TTL for %s on long retention", async (id) => {
		const payload = await capturePayload(bedrockModel(id), { cacheRetention: "long" });
		const oneHour = { type: "default", ttl: "1h" };
		expect(cachePoints(payload)).toEqual({ system: oneHour, lastUser: oneHour });
	});

	it.each([
		"anthropic.claude-opus-4-8",
		"us.anthropic.claude-opus-4-1-20250805-v1:0",
		"eu.anthropic.claude-sonnet-4-20250514-v1:0",
		"global.anthropic.claude-haiku-4-5-20251001-v1:0",
		"us.anthropic.claude-3-7-sonnet-20250219-v1:0",
		"anthropic.claude-3-5-haiku-20241022-v1:0",
	])("keeps caching %s", async (id) => {
		const payload = await capturePayload(bedrockModel(id));
		expect(cachePoints(payload)).toEqual({ system: { type: "default" }, lastUser: { type: "default" } });
	});

	it.each(["Claude Opus 5.5", "Claude Fable 5.1", "Claude Sonnet 4", "Claude 4.5 Haiku", "Claude 4 Sonnet"])(
		"caches an application inference profile named %s",
		async (name) => {
			const arn = "arn:aws:bedrock:us-east-1:123456789012:application-inference-profile/my-profile";
			const payload = await capturePayload(bedrockModel(arn, name));
			expect(cachePoints(payload)).toEqual({ system: { type: "default" }, lastUser: { type: "default" } });
		},
	);

	it.each([
		"anthropic.claude-3-haiku-20240307-v1:0",
		"anthropic.claude-instant-v1",
		"amazon.nova-pro-v1:0",
		"openai.gpt-6.1-sol",
	])("adds no cache points for %s", async (id) => {
		const payload = await capturePayload(bedrockModel(id));
		expect(cachePoints(payload)).toEqual({ system: undefined, lastUser: undefined });
	});

	it("adds no cache points when retention is none", async () => {
		const payload = await capturePayload(bedrockModel("global.anthropic.claude-opus-5-5"), {
			cacheRetention: "none",
		});
		expect(cachePoints(payload)).toEqual({ system: undefined, lastUser: undefined });
	});

	it("caches an unnamed application profile only when AWS_BEDROCK_FORCE_CACHE is set", async () => {
		const model = bedrockModel("arn:aws:bedrock:us-east-1:123456789012:application-inference-profile/p", "p");
		expect(cachePoints(await capturePayload(model))).toEqual({ system: undefined, lastUser: undefined });
		process.env.AWS_BEDROCK_FORCE_CACHE = "1";
		expect(cachePoints(await capturePayload(model))).toEqual({
			system: { type: "default" },
			lastUser: { type: "default" },
		});
	});
});
