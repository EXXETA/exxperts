import { describe, expect, it } from "vitest";
import type { AssistantMessage } from "../src/types.js";
import { isContextOverflow, tooBigRefusal } from "../src/utils/overflow.js";

function createErrorMessage(errorMessage: string): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: "openai-completions",
		provider: "ollama",
		model: "qwen3.5:35b",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				total: 0,
			},
		},
		stopReason: "error",
		errorMessage,
		timestamp: Date.now(),
	};
}

describe("isContextOverflow", () => {
	it("detects explicit Ollama prompt-too-long errors", () => {
		const message = createErrorMessage("400 `prompt too long; exceeded max context length by 100918 tokens`");
		expect(isContextOverflow(message, 32768)).toBe(true);
	});

	it("detects Together AI context length errors", () => {
		const message = createErrorMessage(
			"400 The input (516368 tokens) is longer than the model's context length (262144 tokens).",
		);
		expect(isContextOverflow(message, 262144)).toBe(true);
	});

	it("does not treat generic non-overflow Ollama errors as overflow", () => {
		const message = createErrorMessage("500 `model runner crashed unexpectedly`");
		expect(isContextOverflow(message, 32768)).toBe(false);
	});

	it("does not treat Bedrock throttling 'Too many tokens' as overflow", () => {
		// Bedrock returns this for HTTP 429 rate limiting, NOT context overflow.
		// formatBedrockError uses a human-readable prefix for ThrottlingException.
		const message = createErrorMessage("Throttling error: Too many tokens, please wait before trying again.");
		expect(isContextOverflow(message, 200000)).toBe(false);
	});

	it("does not treat Bedrock service unavailable as overflow", () => {
		const message = createErrorMessage("Service unavailable: The service is temporarily unavailable.");
		expect(isContextOverflow(message, 200000)).toBe(false);
	});

	it("does not treat generic rate limit errors as overflow", () => {
		const message = createErrorMessage("Rate limit exceeded, please retry after 30 seconds.");
		expect(isContextOverflow(message, 200000)).toBe(false);
	});

	it("does not treat HTTP 429 style errors as overflow", () => {
		const message = createErrorMessage("Too many requests. Please slow down.");
		expect(isContextOverflow(message, 200000)).toBe(false);
	});

	function createLengthStopMessage(input: number, cacheRead: number, output: number): AssistantMessage {
		return {
			role: "assistant",
			content: [],
			api: "openai-completions",
			provider: "xiaomi",
			model: "mimo-v2.5-pro",
			usage: {
				input,
				output,
				cacheRead,
				cacheWrite: 0,
				totalTokens: input + cacheRead + output,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "length",
			timestamp: Date.now(),
		};
	}

	it("detects Xiaomi-style overflow (length stop with zero output and filled context)", () => {
		const message = createLengthStopMessage(58, 1048512, 0);
		expect(isContextOverflow(message, 1048576)).toBe(true);
	});

	it("does not treat normal length stops with output as overflow", () => {
		const message = createLengthStopMessage(1000, 0, 4096);
		expect(isContextOverflow(message, 200000)).toBe(false);
	});

	it("does not treat length stops far below context as overflow", () => {
		const message = createLengthStopMessage(100, 0, 0);
		expect(isContextOverflow(message, 200000)).toBe(false);
	});
});

describe("tooBigRefusal", () => {
	const refusal = (errorMessage: string, fields: Partial<AssistantMessage> = {}) =>
		tooBigRefusal({ ...createErrorMessage(errorMessage), ...fields });

	it.each([
		["a gateway's 413", "413 Request Entity Too Large", { errorStatus: 413, errorType: "request_too_large" }],
		["Bedrock's short words", "Validation error: Input is too long.", { errorStatus: 400, errorType: "ValidationException" }],
		["the short words through a gateway", "400 Input is too long.", { errorStatus: 400 }],
		["Anthropic's 413", '413 {"error":{"type":"request_too_large","message":"Request exceeds the maximum size"}}', { errorStatus: 413, errorType: "request_too_large" }],
		["OpenAI's 413", "413 Maximum content size limit (26214400) exceeded (26453458 bytes read)", { errorStatus: 413 }],
		["Google's 400", "Request payload size exceeds the limit: 20971520 bytes.", { errorStatus: 400 }],
		["nginx's page", "413 <html><head><title>413 Request Entity Too Large</title></head></html>", { errorStatus: 413 }],
		["a 413 with no body", "413 status code (no body)", { errorStatus: 413 }],
		["a 413 whose body the client did not read", '413 status code (no body)\n{"message":"Request Too Long"}', { errorStatus: 413 }],
		["words alone, with no status", "Payload Too Large", {}],
	])("counts %s as size", (_name, words, fields) => {
		expect(refusal(words, fields)).toBe("size");
	});

	it.each([
		["Anthropic", "400 prompt is too long: 213462 tokens > 200000 maximum"],
		["OpenAI", "400 Your input exceeds the context window of this model"],
		["OpenRouter", "400 This endpoint's maximum context length is 64000 tokens. However, you requested about 90000 tokens"],
	])("counts %s's ordinary token refusal as length, under a 413 too", (_name, words) => {
		expect(refusal(words, { errorStatus: 400 })).toBe("length");
		expect(refusal(words, { errorStatus: 413 })).toBe("length");
	});

	it.each([
		["Bedrock's full words", "Validation error: Input is too long for requested model.", {}],
		["the full words through LiteLLM", `400 litellm.ContextWindowExceededError: litellm.BadRequestError: BedrockException: Context Window Error - {"message":"Input is too long for requested model."}\nmodel=claude-haiku-5.5. context_window_fallbacks=None. fallbacks=[{"claude-haiku-5.5":["claude-sonnet-5.5"]}].\nLiteLLM: model group 'claude-haiku-5.5' failed with the error above and no fallback model group was found for it, so the request was not retried on another model.`, { errorType: "invalid_request_error" }],
		["a 400 with no body", "400 status code (no body)", {}],
	])("counts %s as either", (_name, words, fields) => {
		expect(refusal(words, { errorStatus: 400, ...fields })).toBe("either");
	});

	it("counts LiteLLM's account of a rate limit as neither", () => {
		const words = "400 litellm.RateLimitError: BedrockException - Input is too long for requested model. model=claude-haiku-5.5. fallbacks=[]. Too many requests.";
		expect(refusal(words, { errorStatus: 400, errorType: "invalid_request_error" })).toBeUndefined();
	});

	it.each([
		["a rate limit", "429 rate limit exceeded", { errorStatus: 429 }],
		["a 429 that speaks of size", "429 Request too large", { errorStatus: 429 }],
		["a limit on tokens per minute", "413 Request too large for model `x` on tokens per minute (TPM): Limit 6000, Requested 7000", { errorStatus: 413 }],
		["a rate limit's type", "413 Request too large for model `x`", { errorStatus: 413, errorType: "rate_limit_exceeded" }],
		["a spent budget", "400 Budget has been exceeded: request too large for the key", { errorStatus: 400 }],
		["a spent quota's type", "413 Request too large", { errorStatus: 413, errorType: "insufficient_quota" }],
		["a payment refusal", "402 Request too large for your plan", { errorStatus: 402 }],
		["Bedrock's throttling", "Throttling error: Too many tokens, please wait before trying again.", { errorStatus: 400 }],
		["a single picture over the provider's limit", "400 messages.1.content.0.image: image exceeds 5 MB maximum", { errorStatus: 400 }],
		["a broken server", "500 model runner crashed unexpectedly", { errorStatus: 500 }],
	])("counts %s as neither", (_name, words, fields) => {
		expect(refusal(words, fields)).toBeUndefined();
	});

	it("reads only a failed answer", () => {
		expect(refusal("413 Request Entity Too Large", { errorStatus: 413, stopReason: "aborted" })).toBeUndefined();
	});
});
