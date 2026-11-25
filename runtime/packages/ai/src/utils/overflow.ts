import type { AssistantMessage } from "../types.js";

/** A client's words for an answer with no body it could read. */
const NO_BODY = /^4(?:00|13)\s*(?:status code)?\s*\(no body\)/i;

/** Amazon Bedrock's words for a request too big in its bytes or in its tokens. */
const TOO_LONG_FOR_MODEL = /input is too long for requested model/i;

/**
 * Regex patterns to detect context overflow errors from different providers.
 *
 * These patterns match error messages returned when the input exceeds
 * the model's context window.
 *
 * Provider-specific patterns (with example error messages):
 *
 * - Anthropic: "prompt is too long: 213462 tokens > 200000 maximum"
 * - Anthropic: "413 {\"error\":{\"type\":\"request_too_large\",\"message\":\"Request exceeds the maximum size\"}}"
 * - OpenAI: "Your input exceeds the context window of this model"
 * - Google: "The input token count (1196265) exceeds the maximum number of tokens allowed (1048575)"
 * - xAI: "This model's maximum prompt length is 131072 but the request contains 537812 tokens"
 * - Groq: "Please reduce the length of the messages or completion"
 * - OpenRouter: "This endpoint's maximum context length is X tokens. However, you requested about Y tokens"
 * - Together AI: "The input (X tokens) is longer than the model's context length (Y tokens)."
 * - llama.cpp: "the request exceeds the available context size, try increasing it"
 * - LM Studio: "tokens to keep from the initial prompt is greater than the context length"
 * - GitHub Copilot: "prompt token count of X exceeds the limit of Y"
 * - MiniMax: "invalid params, context window exceeds limit"
 * - Kimi For Coding: "Your request exceeded model token limit: X (requested: Y)"
 * - Cerebras: "400/413 status code (no body)"
 * - Mistral: "Prompt contains X tokens ... too large for model with Y maximum context length"
 * - z.ai: Does NOT error, accepts overflow silently - handled via usage.input > contextWindow
 * - Xiaomi MiMo: Truncates input to fill contextWindow exactly, then returns finish_reason "length"
 *   with output=0 (no room left to generate). Detected via stopReason "length" + zero output +
 *   input filling the context window.
 * - Ollama: Some deployments truncate silently, others return errors like "prompt too long; exceeded max context length by X tokens"
 */
const OVERFLOW_PATTERNS = [
	/prompt is too long/i, // Anthropic token overflow
	/request_too_large/i, // Anthropic request byte-size overflow (HTTP 413)
	TOO_LONG_FOR_MODEL, // Amazon Bedrock
	/exceeds the context window/i, // OpenAI (Completions & Responses API)
	/input token count.*exceeds the maximum/i, // Google (Gemini)
	/maximum prompt length is \d+/i, // xAI (Grok)
	/reduce the length of the messages/i, // Groq
	/maximum context length is \d+ tokens/i, // OpenRouter (all backends)
	/input \(\d+ tokens\) is longer than the model'?s context length \(\d+ tokens\)/i, // Together AI
	/exceeds the limit of \d+/i, // GitHub Copilot
	/exceeds the available context size/i, // llama.cpp server
	/greater than the context length/i, // LM Studio
	/context window exceeds limit/i, // MiniMax
	/exceeded model token limit/i, // Kimi For Coding
	/too large for model with \d+ maximum context length/i, // Mistral
	/model_context_window_exceeded/i, // z.ai non-standard finish_reason surfaced as error text
	/prompt too long; exceeded (?:max )?context length/i, // Ollama explicit overflow error
	/context[_ ]length[_ ]exceeded/i, // Generic fallback
	/too many tokens/i, // Generic fallback
	/token limit exceeded/i, // Generic fallback
	NO_BODY, // Cerebras: 400/413 with no body
];

/**
 * Patterns that indicate non-overflow errors (e.g. rate limiting, server errors).
 * Error messages matching any of these are excluded from overflow detection
 * even if they also match an OVERFLOW_PATTERN.
 *
 * Example: Bedrock formats throttling errors as "ThrottlingException: Too many tokens,
 * please wait before trying again." which would match the /too many tokens/i overflow
 * pattern without this exclusion.
 */
const NON_OVERFLOW_PATTERNS = [
	/^(Throttling error|Service unavailable):/i, // AWS Bedrock non-overflow errors (human-readable prefixes from formatBedrockError)
	/rate limit/i, // Generic rate limiting
	/too many requests/i, // Generic HTTP 429 style
];

/**
 * How a provider or a gateway in front of it words its refusal of a request for its size in bytes:
 *
 * - Anthropic: 413, type "request_too_large", "Request exceeds the maximum size"
 * - OpenAI: 413 "Maximum content size limit (26214400) exceeded"
 * - Google: 400 "Request payload size exceeds the limit: 20971520 bytes."
 * - Amazon Bedrock: 400 ValidationException "Input is too long." ("... for requested model." can mean its tokens too: TOO_LONG_FOR_MODEL)
 * - nginx and gateways: 413 "Request Entity Too Large", "Payload Too Large", "Content Too Large"
 */
const REQUEST_TOO_LARGE_PATTERNS = [
	/request_too_large/i,
	/(?:request|payload|content|body|entity) (?:is )?too large/i,
	/request exceeds the maximum size/i,
	/maximum content size limit/i,
	/payload size exceeds/i,
	/input is too long(?! for requested model)/i,
];

/** A refusal over money or pace, which may speak of a size too: a limit on tokens per minute answers 413 "Request too large" at some providers. */
const SPEND_OR_RATE =
	/rate[ _-]?limit|too many requests|throttl|tokens per (?:min|hour|day)|quota|budget|billing|credits?\b|spend|usage[ _]limit/i;

/**
 * Whether a failed answer is a refusal because the request was too big, and
 * in which way: "size" for its bytes, which a summary of the conversation does
 * not cure, "length" for its tokens, "either" when its words leave it open.
 * A 413 is "size" unless its words speak of tokens. A refusal over money or
 * pace is none of them.
 */
export function tooBigRefusal(
	message: Pick<AssistantMessage, "stopReason" | "errorMessage" | "errorStatus" | "errorType">,
): "size" | "length" | "either" | undefined {
	if (message.stopReason !== "error") return undefined;
	const words = `${message.errorType ?? ""} ${message.errorMessage ?? ""}`;
	if (message.errorStatus === 402 || message.errorStatus === 429 || SPEND_OR_RATE.test(words)) return undefined;
	if (REQUEST_TOO_LARGE_PATTERNS.some((pattern) => pattern.test(words))) return "size";
	const errorMessage = message.errorMessage ?? "";
	const overflow = overflowWords(errorMessage);
	if (message.errorStatus === 413 && (!overflow || NO_BODY.test(errorMessage))) return "size";
	if (!overflow) return undefined;
	return TOO_LONG_FOR_MODEL.test(errorMessage) || NO_BODY.test(errorMessage) ? "either" : "length";
}

/** Whether a failure's words are a provider's for a context overflow. */
function overflowWords(errorMessage: string): boolean {
	// Skip messages matching known non-overflow patterns (e.g. throttling / rate-limit)
	return (
		!NON_OVERFLOW_PATTERNS.some((p) => p.test(errorMessage)) && OVERFLOW_PATTERNS.some((p) => p.test(errorMessage))
	);
}

/**
 * Check if an assistant message represents a context overflow error.
 *
 * This handles two cases:
 * 1. Error-based overflow: Most providers return stopReason "error" with a
 *    specific error message pattern.
 * 2. Silent overflow: Some providers accept overflow requests and return
 *    successfully. For these, we check if usage.input exceeds the context window.
 *
 * ## Reliability by Provider
 *
 * **Reliable detection (returns error with detectable message):**
 * - Anthropic: "prompt is too long: X tokens > Y maximum" or "request_too_large"
 * - OpenAI (Completions & Responses): "exceeds the context window"
 * - Google Gemini: "input token count exceeds the maximum"
 * - xAI (Grok): "maximum prompt length is X but request contains Y"
 * - Groq: "reduce the length of the messages"
 * - Cerebras: 400/413 status code (no body)
 * - Mistral: "Prompt contains X tokens ... too large for model with Y maximum context length"
 * - OpenRouter (all backends): "maximum context length is X tokens"
 * - Together AI: "The input (X tokens) is longer than the model's context length (Y tokens)."
 * - llama.cpp: "exceeds the available context size"
 * - LM Studio: "greater than the context length"
 * - Kimi For Coding: "exceeded model token limit: X (requested: Y)"
 *
 * **Unreliable detection:**
 * - z.ai: Sometimes accepts overflow silently (detectable via usage.input > contextWindow),
 *   sometimes returns rate limit errors. Pass contextWindow param to detect silent overflow.
 * - Xiaomi MiMo: Truncates input to fit contextWindow then returns stopReason "length" with
 *   output=0. Pass contextWindow param to detect via the "filled context + zero output" signal.
 * - Ollama: May truncate input silently for some setups, but may also return explicit
 *   overflow errors that match the patterns above. Silent truncation still cannot be
 *   detected here because we do not know the expected token count.
 *
 * ## Custom Providers
 *
 * If you've added custom models via settings.json, this function may not detect
 * overflow errors from those providers. To add support:
 *
 * 1. Send a request that exceeds the model's context window
 * 2. Check the errorMessage in the response
 * 3. Create a regex pattern that matches the error
 * 4. The pattern should be added to OVERFLOW_PATTERNS in this file, or
 *    check the errorMessage yourself before calling this function
 *
 * @param message - The assistant message to check
 * @param contextWindow - Optional context window size for detecting silent overflow (z.ai)
 * @returns true if the message indicates a context overflow
 */
export function isContextOverflow(message: AssistantMessage, contextWindow?: number): boolean {
	// Case 1: Check error message patterns
	if (message.stopReason === "error" && message.errorMessage && overflowWords(message.errorMessage)) {
		return true;
	}

	// Case 2: Silent overflow (z.ai style) - successful but usage exceeds context
	if (contextWindow && message.stopReason === "stop") {
		const inputTokens = message.usage.input + message.usage.cacheRead;
		if (inputTokens > contextWindow) {
			return true;
		}
	}

	// Case 3: Length-stop overflow (Xiaomi MiMo style) - server truncates oversized input
	// to fit the context window, leaving no room for output. Returns stopReason "length"
	// with output=0 and input+cacheRead filling the context window.
	if (contextWindow && message.stopReason === "length" && message.usage.output === 0) {
		const inputTokens = message.usage.input + message.usage.cacheRead;
		if (inputTokens >= contextWindow * 0.99) {
			return true;
		}
	}

	return false;
}

/**
 * Get the overflow patterns for testing purposes.
 */
export function getOverflowPatterns(): RegExp[] {
	return [...OVERFLOW_PATTERNS];
}
