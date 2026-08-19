import Anthropic from "@anthropic-ai/sdk";
import type {
	CacheControlEphemeral,
	ContentBlockParam,
	MessageCreateParamsStreaming,
	MessageParam,
	RawMessageStreamEvent,
} from "@anthropic-ai/sdk/resources/messages.js";
import { getEnvApiKey } from "../env-api-keys.js";
import { calculateCost, clampThinkingLevel, hasExplicitTopTierEffort } from "../models.js";
import type {
	AnthropicMessagesCompat,
	Api,
	AssistantMessage,
	CacheRetention,
	Context,
	ImageContent,
	Message,
	Model,
	SimpleStreamOptions,
	StopReason,
	StreamFunction,
	StreamOptions,
	TextContent,
	ThinkingContent,
	ThinkingLevel,
	Tool,
	ToolCall,
	ToolResultMessage,
} from "../types.js";
import { appendAssistantMessageDiagnostic, createAssistantMessageDiagnostic } from "../utils/diagnostics.js";
import { AssistantMessageEventStream } from "../utils/event-stream.js";
import { headersToRecord } from "../utils/headers.js";
import { parseJsonWithRepair, parseStreamingJson } from "../utils/json-parse.js";
import { sanitizeSurrogates } from "../utils/sanitize-unicode.js";

import { resolveCloudflareBaseUrl } from "./cloudflare.js";
import { buildCopilotDynamicHeaders, hasCopilotVisionInput } from "./github-copilot-headers.js";
import { adjustMaxTokensForThinking, buildBaseOptions } from "./simple-options.js";
import { transformMessages } from "./transform-messages.js";

/**
 * Resolve cache retention preference.
 * Defaults to "short" and uses PI_CACHE_RETENTION for backward compatibility.
 */
function resolveCacheRetention(cacheRetention?: CacheRetention): CacheRetention {
	if (cacheRetention) {
		return cacheRetention;
	}
	if (typeof process !== "undefined" && process.env.PI_CACHE_RETENTION === "long") {
		return "long";
	}
	return "short";
}

function getCacheControl(
	model: Model<"anthropic-messages">,
	cacheRetention?: CacheRetention,
): { retention: CacheRetention; cacheControl?: CacheControlEphemeral } {
	const retention = resolveCacheRetention(cacheRetention);
	if (retention === "none") {
		return { retention };
	}
	const ttl = retention === "long" && getAnthropicCompat(model).supportsLongCacheRetention ? "1h" : undefined;
	return {
		retention,
		cacheControl: { type: "ephemeral", ...(ttl && { ttl }) },
	};
}

// Stealth mode: Mimic Claude Code's tool naming exactly
const claudeCodeVersion = "2.1.75";

// Claude Code 2.x tool names (canonical casing)
// Source: https://cchistory.mariozechner.at/data/prompts-2.1.11.md
// To update: https://github.com/badlogic/cchistory
const claudeCodeTools = [
	"Read",
	"Write",
	"Edit",
	"Bash",
	"Grep",
	"Glob",
	"AskUserQuestion",
	"EnterPlanMode",
	"ExitPlanMode",
	"KillShell",
	"NotebookEdit",
	"Skill",
	"Task",
	"TaskOutput",
	"TodoWrite",
	"WebFetch",
	"WebSearch",
];

const ccToolLookup = new Map(claudeCodeTools.map((t) => [t.toLowerCase(), t]));

// Convert tool name to CC canonical casing if it matches (case-insensitive)
const toClaudeCodeName = (name: string) => ccToolLookup.get(name.toLowerCase()) ?? name;
const fromClaudeCodeName = (name: string, tools?: Tool[]) => {
	if (tools && tools.length > 0) {
		const lowerName = name.toLowerCase();
		const matchedTool = tools.find((tool) => tool.name.toLowerCase() === lowerName);
		if (matchedTool) return matchedTool.name;
	}
	return name;
};

/**
 * Convert content blocks to Anthropic API format
 */
function convertContentBlocks(content: (TextContent | ImageContent)[]):
	| string
	| Array<
			| { type: "text"; text: string }
			| {
					type: "image";
					source: {
						type: "base64";
						media_type: "image/jpeg" | "image/png" | "image/gif" | "image/webp";
						data: string;
					};
			  }
	  > {
	// If only text blocks, return as concatenated string for simplicity
	const hasImages = content.some((c) => c.type === "image");
	if (!hasImages) {
		return sanitizeSurrogates(content.map((c) => (c as TextContent).text).join("\n"));
	}

	// If we have images, convert to content block array
	const blocks = content.map((block) => {
		if (block.type === "text") {
			return {
				type: "text" as const,
				text: sanitizeSurrogates(block.text),
			};
		}
		return {
			type: "image" as const,
			source: {
				type: "base64" as const,
				media_type: block.mimeType as "image/jpeg" | "image/png" | "image/gif" | "image/webp",
				data: block.data,
			},
		};
	});

	// If only images (no text), add placeholder text block
	const hasText = blocks.some((b) => b.type === "text");
	if (!hasText) {
		blocks.unshift({
			type: "text" as const,
			text: "(see attached image)",
		});
	}

	return blocks;
}

export type AnthropicEffort = "low" | "medium" | "high" | "xhigh" | "max";

export type AnthropicThinkingDisplay = "summarized" | "omitted";

const FINE_GRAINED_TOOL_STREAMING_BETA = "fine-grained-tool-streaming-2025-05-14";
const INTERLEAVED_THINKING_BETA = "interleaved-thinking-2025-05-14";

function getAnthropicCompat(model: Model<"anthropic-messages">): Required<AnthropicMessagesCompat> {
	return {
		supportsEagerToolInputStreaming: model.compat?.supportsEagerToolInputStreaming ?? true,
		supportsLongCacheRetention: model.compat?.supportsLongCacheRetention ?? true,
	};
}

export interface AnthropicOptions extends StreamOptions {
	/**
	 * Enable extended thinking.
	 * For Opus 4.6 and Sonnet 4.6: uses adaptive thinking (model decides when/how much to think).
	 * For older models: uses budget-based thinking with thinkingBudgetTokens.
	 */
	thinkingEnabled?: boolean;
	/**
	 * Token budget for extended thinking (older models only).
	 * Ignored for Opus 4.6 and Sonnet 4.6, which use adaptive thinking.
	 */
	thinkingBudgetTokens?: number;
	/**
	 * Effort level for adaptive thinking (Opus 4.6+ and Sonnet 4.6).
	 * Controls how much thinking Claude allocates:
	 * - "max": Always thinks with no constraints (Opus 4.6 only)
	 * - "xhigh": Highest reasoning level (Opus 4.7)
	 * - "high": Always thinks, deep reasoning (default)
	 * - "medium": Moderate thinking, may skip for simple queries
	 * - "low": Minimal thinking, skips for simple tasks
	 * Ignored for older models.
	 */
	effort?: AnthropicEffort;
	/**
	 * Controls how thinking content is returned in API responses.
	 * - "summarized": Thinking blocks contain summarized thinking text (default here).
	 * - "omitted": Thinking blocks return an empty thinking field; the encrypted
	 *   signature still travels back for multi-turn continuity. Use for faster
	 *   time-to-first-text-token when your UI does not surface thinking.
	 *
	 * Note: Anthropic's API default for Claude Opus 4.7 and Claude Mythos Preview
	 * is "omitted". We default to "summarized" here to keep behavior consistent
	 * with older Claude 4 models. Set this explicitly to "omitted" to opt in.
	 */
	thinkingDisplay?: AnthropicThinkingDisplay;
	interleavedThinking?: boolean;
	toolChoice?: "auto" | "any" | "none" | { type: "tool"; name: string };
	/**
	 * Pre-built Anthropic client instance. When provided, skips internal client
	 * construction entirely. Use this to inject alternative SDK clients such as
	 * `AnthropicVertex` that shares the same messaging API.
	 */
	client?: Anthropic;
}

function mergeHeaders(...headerSources: (Record<string, string | null> | undefined)[]): Record<string, string | null> {
	const merged: Record<string, string | null> = {};
	for (const headers of headerSources) {
		if (headers) {
			Object.assign(merged, headers);
		}
	}
	return merged;
}

interface ServerSentEvent {
	event: string | null;
	data: string;
	raw: string[];
}

interface SseDecoderState {
	event: string | null;
	data: string[];
	raw: string[];
}

const ANTHROPIC_MESSAGE_EVENTS: ReadonlySet<string> = new Set([
	"message_start",
	"message_delta",
	"message_stop",
	"content_block_start",
	"content_block_delta",
	"content_block_stop",
]);

function flushSseEvent(state: SseDecoderState): ServerSentEvent | null {
	if (!state.event && state.data.length === 0) {
		return null;
	}

	const event: ServerSentEvent = {
		event: state.event,
		data: state.data.join("\n"),
		raw: [...state.raw],
	};
	state.event = null;
	state.data = [];
	state.raw = [];
	return event;
}

function decodeSseLine(line: string, state: SseDecoderState): ServerSentEvent | null {
	if (line === "") {
		return flushSseEvent(state);
	}

	state.raw.push(line);
	if (line.startsWith(":")) {
		return null;
	}

	const delimiterIndex = line.indexOf(":");
	const fieldName = delimiterIndex === -1 ? line : line.slice(0, delimiterIndex);
	let value = delimiterIndex === -1 ? "" : line.slice(delimiterIndex + 1);
	if (value.startsWith(" ")) {
		value = value.slice(1);
	}

	if (fieldName === "event") {
		state.event = value;
	} else if (fieldName === "data") {
		state.data.push(value);
	}

	return null;
}

function nextLineBreakIndex(text: string): number {
	const carriageReturnIndex = text.indexOf("\r");
	const newlineIndex = text.indexOf("\n");
	if (carriageReturnIndex === -1) {
		return newlineIndex;
	}
	if (newlineIndex === -1) {
		return carriageReturnIndex;
	}
	return Math.min(carriageReturnIndex, newlineIndex);
}

function consumeLine(text: string): { line: string; rest: string } | null {
	const lineBreakIndex = nextLineBreakIndex(text);
	if (lineBreakIndex === -1) {
		return null;
	}

	let nextIndex = lineBreakIndex + 1;
	if (text[lineBreakIndex] === "\r" && text[nextIndex] === "\n") {
		nextIndex += 1;
	}

	return {
		line: text.slice(0, lineBreakIndex),
		rest: text.slice(nextIndex),
	};
}

async function* iterateSseMessages(
	body: ReadableStream<Uint8Array>,
	signal?: AbortSignal,
): AsyncGenerator<ServerSentEvent> {
	const reader = body.getReader();
	const decoder = new TextDecoder();
	const state: SseDecoderState = { event: null, data: [], raw: [] };
	let buffer = "";

	try {
		while (true) {
			if (signal?.aborted) {
				throw new Error("Request was aborted");
			}

			const { value, done } = await reader.read();
			if (done) {
				break;
			}

			buffer += decoder.decode(value, { stream: true });
			let consumed = consumeLine(buffer);
			while (consumed) {
				buffer = consumed.rest;
				const event = decodeSseLine(consumed.line, state);
				if (event) {
					yield event;
				}
				consumed = consumeLine(buffer);
			}
		}

		buffer += decoder.decode();
		let consumed = consumeLine(buffer);
		while (consumed) {
			buffer = consumed.rest;
			const event = decodeSseLine(consumed.line, state);
			if (event) {
				yield event;
			}
			consumed = consumeLine(buffer);
		}

		if (buffer.length > 0) {
			const event = decodeSseLine(buffer, state);
			if (event) {
				yield event;
			}
		}

		const trailingEvent = flushSseEvent(state);
		if (trailingEvent) {
			yield trailingEvent;
		}
	} finally {
		reader.releaseLock();
	}
}

async function* iterateAnthropicEvents(
	response: Response,
	signal?: AbortSignal,
): AsyncGenerator<RawMessageStreamEvent> {
	if (!response.body) {
		throw new Error("Attempted to iterate over an Anthropic response with no body");
	}

	let sawMessageStart = false;
	let sawMessageEnd = false;

	for await (const sse of iterateSseMessages(response.body, signal)) {
		if (sse.event === "error") {
			throw new Error(sse.data);
		}

		if (!ANTHROPIC_MESSAGE_EVENTS.has(sse.event ?? "")) {
			continue;
		}

		try {
			const event = parseJsonWithRepair<RawMessageStreamEvent>(sse.data);
			if (event.type === "message_start") {
				sawMessageStart = true;
			} else if (event.type === "message_stop") {
				sawMessageEnd = true;
			}
			yield event;
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			throw new Error(
				`Could not parse Anthropic SSE event ${sse.event}: ${message}; data=${sse.data}; raw=${sse.raw.join("\\n")}`,
			);
		}
	}

	if (sawMessageStart && !sawMessageEnd) {
		throw new Error("Anthropic stream ended before message_stop");
	}
}

export const streamAnthropic: StreamFunction<"anthropic-messages", AnthropicOptions> = (
	model: Model<"anthropic-messages">,
	context: Context,
	options?: AnthropicOptions,
): AssistantMessageEventStream => {
	const stream = new AssistantMessageEventStream();

	(async () => {
		const output: AssistantMessage = {
			role: "assistant",
			content: [],
			api: model.api as Api,
			provider: model.provider,
			model: model.id,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now(),
		};

		try {
			let client: Anthropic;
			let isOAuth: boolean;

			if (options?.client) {
				client = options.client;
				isOAuth = false;
			} else {
				const apiKey = options?.apiKey ?? getEnvApiKey(model.provider) ?? "";

				let copilotDynamicHeaders: Record<string, string> | undefined;
				if (model.provider === "github-copilot") {
					const hasImages = hasCopilotVisionInput(context.messages);
					copilotDynamicHeaders = buildCopilotDynamicHeaders({
						messages: context.messages,
						hasImages,
					});
				}

				const created = createClient(
					model,
					apiKey,
					options?.interleavedThinking ?? true,
					shouldUseFineGrainedToolStreamingBeta(model, context),
					options?.headers,
					copilotDynamicHeaders,
				);
				client = created.client;
				isOAuth = created.isOAuthToken;
			}
			let params = buildParams(model, context, isOAuth, options);
			const nextParams = await options?.onPayload?.(params, model);
			if (nextParams !== undefined) {
				params = nextParams as MessageCreateParamsStreaming;
			}
			const requestOptions = {
				...(options?.signal ? { signal: options.signal } : {}),
				...(options?.timeoutMs !== undefined ? { timeout: options.timeoutMs } : {}),
				...(options?.maxRetries !== undefined ? { maxRetries: options.maxRetries } : {}),
			};
			type Block = (ThinkingContent | TextContent | (ToolCall & { partialJson: string })) & { index: number };
			const blocks = output.content as Block[];

			// A turn that uses one of the provider's own server tools can come
			// back with stop_reason "pause_turn". The model has not finished; the
			// provider is handing control back rather than holding a connection
			// open through a long search. Left alone it reads as a clean ending,
			// which is how an answer gets cut off mid-sentence and still looks
			// finished. The documented answer is to send the partial turn back and
			// let it carry on, so that is what happens here, invisibly: one start
			// event, one accumulating assistant message, one stream.
			//
			// Only a request that declares a server tool can pause, so the
			// bookkeeping that makes continuing possible is only paid for then and
			// every other request runs the path it has always run.
			const declaresServerTool =
				Array.isArray((params as any).tools) &&
				(params as any).tools.some((tool: any) => tool && typeof tool.type === "string" && tool.type !== "custom");
			let pausedTurns = 0;
			let started = false;
			// Usage arrives per response, so a continuation's numbers are added to
			// what the turn has already spent instead of replacing it. That sum is
			// what the turn COST, and every request in it resent the whole
			// conversation, so it is not what the turn left behind.
			const usageBase = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
			// What the turn leaves behind is measured from the first request's
			// prompt AS SUBMITTED, which is the one the next turn will resend.
			//
			// Taken from the first usage report of the first response rather than
			// from its last, because a server-side search grows the prompt while
			// the response is still streaming: the results it finds are billed
			// back as cache creation on the same request. Those results never
			// reach our messages, so they are not there to be resent, and counting
			// them leaves the meter reading a conversation that does not exist.
			// A turn with no server tool reports the same prompt at both ends, so
			// for everything else this is the number it always was.
			let firstSegmentPrompt: number | undefined;
			/** Set when a continuation should open with a paragraph break. */
			let needsSegmentSeparator = false;
			// The wire truth of the whole turn, accumulated across continuations.
			// The parsed `output.content` only holds the block types this file
			// understands, so a turn that used a server tool (the provider's own
			// web search) produced blocks the parse dropped. If the model then
			// calls a CLIENT tool, the follow-up request has to send this
			// assistant message back exactly as it was produced: the API checks
			// the thinking blocks of the latest assistant message against what it
			// signed, and a reconstruction with blocks missing moves every index
			// and fails that check as "thinking blocks cannot be modified". So
			// the raw blocks ride along on the finished message and the message
			// conversion resends them verbatim while the message is the latest.
			const turnRawContent: Record<string, any>[] = [];
			/** The recovery below fires at most once per turn. */
			let recoveredThinkingValidation = false;
			// Recomputed wherever the sums are, so a caller reading mid-stream sees
			// a context number that agrees with the tokens counted so far.
			const refreshContextTokens = () => {
				const prompt = firstSegmentPrompt ?? output.usage.input + output.usage.cacheRead + output.usage.cacheWrite;
				output.usage.contextTokens = prompt + output.usage.output;
			};

			for (;;) {
				let response: Response;
				try {
					response = await client.messages.create({ ...params, stream: true }, requestOptions).asResponse();
				} catch (requestError) {
					// The last line of defense against the provider's validation of
					// the history we resend. The verbatim resend above is supposed
					// to satisfy it, but the validators live on the provider's
					// servers, their enforcement varies by account, more of them
					// keep appearing (the verbatim-thinking check and the
					// server-tool pairing check have both been met in the field),
					// and a conversation recorded by an older build may simply not
					// hold what they want back. When the refusal is about that
					// history, the request is retried once with thinking disabled
					// and every thinking and server-tool block stripped: plain text
					// and tool-call pairs, with nothing left for any of them to
					// inspect. The model loses its reasoning trace and its old
					// search citations for this one request; the user keeps a room
					// that answers. Anything else, and the second failure surfaces
					// exactly as the first would have.
					if (recoveredThinkingValidation || !isResentHistoryRefusal(requestError)) throw requestError;
					recoveredThinkingValidation = true;
					appendAssistantMessageDiagnostic(output, createAssistantMessageDiagnostic("anthropic-history-validation-recovery", requestError, { model: model.id }));
					params = stripValidatedHistoryFromParams(params);
					response = await client.messages.create({ ...params, stream: true }, requestOptions).asResponse();
				}
				await options?.onResponse?.({ status: response.status, headers: headersToRecord(response.headers) }, model);
				if (!started) {
					// Exactly one start for the whole turn: the agent loop reads a
					// second one as a second assistant message.
					stream.push({ type: "start", partial: output });
					started = true;
				}
				const rawBlocks = declaresServerTool ? new Map<number, Record<string, any>>() : null;
				let rawStopReason: string | undefined;

				for await (const event of iterateAnthropicEvents(response, options?.signal)) {
					if (rawBlocks) captureRawAnthropicBlock(rawBlocks, event);
					if (event.type === "message_start") {
						// The id of the response the caller started, kept across any
						// continuation so the turn correlates to one thing.
						output.responseId ??= event.message.id;
						// Capture initial token usage from message_start event
						// This ensures we have input token counts even if the stream is aborted early
						output.usage.input = usageBase.input + (event.message.usage.input_tokens || 0);
						output.usage.output = usageBase.output + (event.message.usage.output_tokens || 0);
						output.usage.cacheRead = usageBase.cacheRead + (event.message.usage.cache_read_input_tokens || 0);
						output.usage.cacheWrite = usageBase.cacheWrite + (event.message.usage.cache_creation_input_tokens || 0);
						// The prompt as this request was submitted, pinned before the
						// response has had a chance to grow it. Only the first response
						// of the turn sets it, and only when it actually reported
						// something: a proxy that sends usage-free message_start events
						// leaves it undefined and the seam below picks it up instead.
						if (firstSegmentPrompt === undefined) {
							const submittedPrompt =
								(event.message.usage.input_tokens || 0) +
								(event.message.usage.cache_read_input_tokens || 0) +
								(event.message.usage.cache_creation_input_tokens || 0);
							if (submittedPrompt > 0) firstSegmentPrompt = submittedPrompt;
						}
						// Anthropic doesn't provide total_tokens, compute from components
						output.usage.totalTokens =
							output.usage.input + output.usage.output + output.usage.cacheRead + output.usage.cacheWrite;
						refreshContextTokens();
						calculateCost(model, output.usage);
					} else if (event.type === "content_block_start") {
						if (event.content_block.type === "text") {
							const block: Block = {
								type: "text",
								text: "",
								index: event.index,
							};
							output.content.push(block);
							stream.push({ type: "text_start", contentIndex: output.content.length - 1, partial: output });
							// The first text after a pause opens the paragraph the pause
							// interrupted, so it carries the break the model never got to
							// write.
							if (needsSegmentSeparator) {
								needsSegmentSeparator = false;
								block.text = "\n\n";
								stream.push({ type: "text_delta", contentIndex: output.content.length - 1, delta: "\n\n", partial: output });
							}
							// Proxies can put content in the start event itself instead of
							// streaming it as deltas; hardcoding "" would silently drop it.
							if (typeof event.content_block.text === "string" && event.content_block.text.length > 0) {
								block.text += event.content_block.text;
								stream.push({
									type: "text_delta",
									contentIndex: output.content.length - 1,
									delta: event.content_block.text,
									partial: output,
								});
							}
						} else if (event.content_block.type === "thinking") {
							const block: Block = {
								type: "thinking",
								thinking: typeof event.content_block.thinking === "string" ? event.content_block.thinking : "",
								thinkingSignature: typeof event.content_block.signature === "string" ? event.content_block.signature : "",
								index: event.index,
							};
							output.content.push(block);
							stream.push({ type: "thinking_start", contentIndex: output.content.length - 1, partial: output });
							if (block.thinking.length > 0) {
								stream.push({
									type: "thinking_delta",
									contentIndex: output.content.length - 1,
									delta: block.thinking,
									partial: output,
								});
							}
						} else if (event.content_block.type === "redacted_thinking") {
							const block: Block = {
								type: "thinking",
								thinking: "[Reasoning redacted]",
								thinkingSignature: event.content_block.data,
								redacted: true,
								index: event.index,
							};
							output.content.push(block);
							stream.push({ type: "thinking_start", contentIndex: output.content.length - 1, partial: output });
						} else if (event.content_block.type === "tool_use") {
							const block: Block = {
								type: "toolCall",
								id: event.content_block.id,
								name: isOAuth
									? fromClaudeCodeName(event.content_block.name, context.tools)
									: event.content_block.name,
								arguments: (event.content_block.input as Record<string, any>) ?? {},
								partialJson: "",
								index: event.index,
							};
							output.content.push(block);
							stream.push({ type: "toolcall_start", contentIndex: output.content.length - 1, partial: output });
						}
					} else if (event.type === "content_block_delta") {
						if (event.delta.type === "text_delta") {
							const index = blocks.findIndex((b) => b.index === event.index);
							const block = blocks[index];
							if (block && block.type === "text") {
								block.text += event.delta.text;
								stream.push({
									type: "text_delta",
									contentIndex: index,
									delta: event.delta.text,
									partial: output,
								});
							}
						} else if (event.delta.type === "thinking_delta") {
							const index = blocks.findIndex((b) => b.index === event.index);
							const block = blocks[index];
							if (block && block.type === "thinking") {
								block.thinking += event.delta.thinking;
								stream.push({
									type: "thinking_delta",
									contentIndex: index,
									delta: event.delta.thinking,
									partial: output,
								});
							}
						} else if (event.delta.type === "input_json_delta") {
							const index = blocks.findIndex((b) => b.index === event.index);
							const block = blocks[index];
							if (block && block.type === "toolCall") {
								block.partialJson += event.delta.partial_json;
								block.arguments = parseStreamingJson(block.partialJson);
								stream.push({
									type: "toolcall_delta",
									contentIndex: index,
									delta: event.delta.partial_json,
									partial: output,
								});
							}
						} else if (event.delta.type === "signature_delta") {
							const index = blocks.findIndex((b) => b.index === event.index);
							const block = blocks[index];
							if (block && block.type === "thinking") {
								block.thinkingSignature = block.thinkingSignature || "";
								block.thinkingSignature += event.delta.signature;
							}
						}
					} else if (event.type === "content_block_stop") {
						const index = blocks.findIndex((b) => b.index === event.index);
						const block = blocks[index];
						if (block) {
							delete (block as any).index;
							if (block.type === "text") {
								stream.push({
									type: "text_end",
									contentIndex: index,
									content: block.text,
									partial: output,
								});
							} else if (block.type === "thinking") {
								stream.push({
									type: "thinking_end",
									contentIndex: index,
									content: block.thinking,
									partial: output,
								});
							} else if (block.type === "toolCall") {
								block.arguments = parseStreamingJson(block.partialJson);
								// Finalize in-place and strip the scratch buffer so replay only
								// carries parsed arguments.
								delete (block as { partialJson?: string }).partialJson;
								stream.push({
									type: "toolcall_end",
									contentIndex: index,
									toolCall: block,
									partial: output,
								});
							}
						}
					} else if (event.type === "message_delta") {
						if (event.delta.stop_reason) {
							rawStopReason = event.delta.stop_reason;
							output.stopReason = mapStopReason(event.delta.stop_reason);
						}
						// Only update usage fields if present (not null).
						// Preserves input_tokens from message_start when proxies omit it in message_delta.
						if (event.usage.input_tokens != null) {
							output.usage.input = usageBase.input + event.usage.input_tokens;
						}
						if (event.usage.output_tokens != null) {
							output.usage.output = usageBase.output + event.usage.output_tokens;
						}
						if (event.usage.cache_read_input_tokens != null) {
							output.usage.cacheRead = usageBase.cacheRead + event.usage.cache_read_input_tokens;
						}
						if (event.usage.cache_creation_input_tokens != null) {
							output.usage.cacheWrite = usageBase.cacheWrite + event.usage.cache_creation_input_tokens;
						}
						// Anthropic doesn't provide total_tokens, compute from components
						output.usage.totalTokens =
							output.usage.input + output.usage.output + output.usage.cacheRead + output.usage.cacheWrite;
						refreshContextTokens();
						calculateCost(model, output.usage);
					}
				}

				if (options?.signal?.aborted) {
					throw new Error("Request was aborted");
				}
				// This segment's blocks as the wire produced them, finalized once and
				// shared by both consumers: the continuation below hands them straight
				// back, and the turn's accumulated raw content keeps them for the
				// finished message.
				const segmentRawContent = rawBlocks ? finalizeRawAnthropicBlocks(rawBlocks) : null;
				if (segmentRawContent) turnRawContent.push(...segmentRawContent);
				// A CONTINUATION that said nothing told us nothing, not even that it
				// finished, and breaking here would publish the previous segment as a
				// clean, complete answer. Only continuations though: a first response
				// that streams a message without ever naming a stop reason is a
				// proxy quirk this file tolerates elsewhere, and it has already
				// delivered an answer somebody paid for. Downgrading that to an error
				// would be a regression, so segment one keeps its lenient default.
				if (pausedTurns > 0 && rawStopReason === undefined) {
					throw new Error("Anthropic paused this turn and the continuation returned no stream events");
				}
				if (rawStopReason !== "pause_turn" || !rawBlocks) break;
				if (pausedTurns >= MAX_PAUSED_TURN_RESUBMITS) {
					// Out of patience rather than out of answer. "length" is the honest
					// signal: the turn was cut short, and every consumer already knows
					// what a truncated answer means.
					output.stopReason = "length";
					break;
				}
				pausedTurns += 1;
				// Fallback only. Normally message_start already pinned this from the
				// prompt as submitted; this catches the proxies that report no usage
				// there. It is the end-of-segment figure, so on a segment that ran a
				// server-side search it will read high, which is still better than
				// having no anchor at all and summing every continuation's prompt.
				firstSegmentPrompt ??= output.usage.input + output.usage.cacheRead + output.usage.cacheWrite;
				usageBase.input = output.usage.input;
				usageBase.output = output.usage.output;
				usageBase.cacheRead = output.usage.cacheRead;
				usageBase.cacheWrite = output.usage.cacheWrite;
				// The turn resumes as new blocks, so the last thing written before the
				// pause and the first thing written after it would otherwise run
				// together into one word. The break belongs at the START of the
				// continuation's first text block rather than appended to the
				// previous one, which has already been closed and announced: this way
				// it arrives as an ordinary delta, in order, and a reader sees the
				// paragraph the model would have written had nothing interrupted it.
				// Accumulated, never recomputed: a segment that produced only thinking
				// leaves the pending break pending, so the text that eventually
				// arrives still opens a new paragraph rather than colliding with the
				// last thing written before the first pause. Any trailing whitespace
				// counts as already separated, a space as much as a newline, so the
				// seam never reads as " \n\n".
				const lastBlock = blocks[blocks.length - 1];
				needsSegmentSeparator ||= !!lastBlock && lastBlock.type === "text" && !!lastBlock.text && !/\s$/.test(lastBlock.text);
				params = {
					...params,
					messages: [...params.messages, { role: "assistant", content: segmentRawContent as any }],
				};
			} // end of the pause_turn continuation loop

			if (output.stopReason === "aborted" || output.stopReason === "error") {
				throw new Error("An unknown error occurred");
			}

			// The raw copy is only kept when parsing actually lost something: a
			// turn of nothing but text, thinking and client tool calls
			// reconstructs perfectly, and a byte-identical duplicate of it would
			// grow every session for no protection.
			if (turnRawContent.some((block) => !PARSED_ANTHROPIC_BLOCK_TYPES.has(String(block?.type)))) {
				output.rawContent = turnRawContent;
			}

			stream.push({ type: "done", reason: output.stopReason, message: output });
			stream.end();
		} catch (error) {
			for (const block of output.content) {
				delete (block as { index?: number }).index;
				// partialJson is only a streaming scratch buffer; never persist it.
				delete (block as { partialJson?: string }).partialJson;
			}
			output.stopReason = options?.signal?.aborted ? "aborted" : "error";
			output.errorMessage = error instanceof Error ? error.message : JSON.stringify(error);
			stream.push({ type: "error", reason: output.stopReason, error: output });
			stream.end();
		}
	})();

	return stream;
};

/**
 * Check if a model supports adaptive thinking (effort-based rather than
 * budget-based).
 *
 * The real test is the model's own metadata: a model that names an effort for
 * a tier above "high" is a model that takes efforts. Matching on ids alone is
 * what left every Claude 5 model on budget thinking, where the tiers above
 * "medium" all spend the same budget and "max" was indistinguishable from
 * "high". The id list stays as a belt for entries whose map shape predates
 * this rule and never named a top tier.
 */
function supportsAdaptiveThinking(model: Model<"anthropic-messages">): boolean {
	if (hasExplicitTopTierEffort(model)) return true;
	// Adaptive-thinking model IDs (with or without date suffix)
	const modelId = model.id;
	return (
		modelId.includes("opus-4-6") ||
		modelId.includes("opus-4.6") ||
		modelId.includes("opus-4-7") ||
		modelId.includes("opus-4.7") ||
		modelId.includes("sonnet-4-6") ||
		modelId.includes("sonnet-4.6")
	);
}

/**
 * Map ThinkingLevel to Anthropic effort levels for adaptive thinking.
 * Note: effort "max" is only valid on Opus 4.6, while Opus 4.7 supports "xhigh".
 */
function mapThinkingLevelToEffort(
	model: Model<"anthropic-messages">,
	level: SimpleStreamOptions["reasoning"],
): AnthropicEffort {
	const mapped = level ? model.thinkingLevelMap?.[level] : undefined;
	if (typeof mapped === "string") return mapped as AnthropicEffort;

	switch (level) {
		case "minimal":
		case "low":
			return "low";
		case "medium":
			return "medium";
		case "high":
			return "high";
		default:
			return "high";
	}
}

export const streamSimpleAnthropic: StreamFunction<"anthropic-messages", SimpleStreamOptions> = (
	model: Model<"anthropic-messages">,
	context: Context,
	options?: SimpleStreamOptions,
): AssistantMessageEventStream => {
	const apiKey = options?.apiKey || getEnvApiKey(model.provider);
	if (!apiKey) {
		throw new Error(`No API key for provider: ${model.provider}`);
	}

	const base = buildBaseOptions(model, options, apiKey);
	if (!options?.reasoning) {
		return streamAnthropic(model, context, { ...base, thinkingEnabled: false } satisfies AnthropicOptions);
	}

	// For Opus 4.6 and Sonnet 4.6: use adaptive thinking with effort level
	// For older models: use budget-based thinking
	if (supportsAdaptiveThinking(model)) {
		// Clamp first, like every other adapter: an unmapped level would
		// otherwise fall through the switch below to "high", which on a model
		// with tiers above high is a downgrade rather than a fallback.
		// Safe cast: the clamp only returns "off" for a request that WAS "off",
		// and this branch is unreachable unless reasoning is set.
		const clamped = clampThinkingLevel(model, options.reasoning) as ThinkingLevel;
		const effort = mapThinkingLevelToEffort(model, clamped);
		return streamAnthropic(model, context, {
			...base,
			thinkingEnabled: true,
			effort,
		} satisfies AnthropicOptions);
	}

	const adjusted = adjustMaxTokensForThinking(
		base.maxTokens || 0,
		model.maxTokens,
		options.reasoning,
		options.thinkingBudgets,
	);

	return streamAnthropic(model, context, {
		...base,
		maxTokens: adjusted.maxTokens,
		thinkingEnabled: true,
		thinkingBudgetTokens: adjusted.thinkingBudget,
	} satisfies AnthropicOptions);
};

function isOAuthToken(apiKey: string): boolean {
	return apiKey.includes("sk-ant-oat");
}

function createClient(
	model: Model<"anthropic-messages">,
	apiKey: string,
	interleavedThinking: boolean,
	useFineGrainedToolStreamingBeta: boolean,
	optionsHeaders?: Record<string, string>,
	dynamicHeaders?: Record<string, string>,
): { client: Anthropic; isOAuthToken: boolean } {
	// Adaptive thinking models (Opus 4.6, Sonnet 4.6) have interleaved thinking built-in.
	// The beta header is deprecated on Opus 4.6 and redundant on Sonnet 4.6, so skip it.
	const needsInterleavedBeta = interleavedThinking && !supportsAdaptiveThinking(model);
	const betaFeatures: string[] = [];
	if (useFineGrainedToolStreamingBeta) {
		betaFeatures.push(FINE_GRAINED_TOOL_STREAMING_BETA);
	}
	if (needsInterleavedBeta) {
		betaFeatures.push(INTERLEAVED_THINKING_BETA);
	}

	if (model.provider === "cloudflare-ai-gateway") {
		const client = new Anthropic({
			apiKey: null,
			authToken: null,
			baseURL: resolveCloudflareBaseUrl(model),
			dangerouslyAllowBrowser: true,
			defaultHeaders: mergeHeaders(
				{
					accept: "application/json",
					"anthropic-dangerous-direct-browser-access": "true",
					"cf-aig-authorization": `Bearer ${apiKey}`,
					"x-api-key": null,
					Authorization: null,
					...(betaFeatures.length > 0 ? { "anthropic-beta": betaFeatures.join(",") } : {}),
				},
				model.headers,
				optionsHeaders,
			),
		});

		return { client, isOAuthToken: false };
	}

	// Copilot: Bearer auth, selective betas.
	if (model.provider === "github-copilot") {
		const client = new Anthropic({
			apiKey: null,
			authToken: apiKey,
			baseURL: model.baseUrl,
			dangerouslyAllowBrowser: true,
			defaultHeaders: mergeHeaders(
				{
					accept: "application/json",
					"anthropic-dangerous-direct-browser-access": "true",
					...(betaFeatures.length > 0 ? { "anthropic-beta": betaFeatures.join(",") } : {}),
				},
				model.headers,
				dynamicHeaders,
				optionsHeaders,
			),
		});

		return { client, isOAuthToken: false };
	}

	// OAuth: Bearer auth, Claude Code identity headers
	if (isOAuthToken(apiKey)) {
		const client = new Anthropic({
			apiKey: null,
			authToken: apiKey,
			baseURL: model.baseUrl,
			dangerouslyAllowBrowser: true,
			defaultHeaders: mergeHeaders(
				{
					accept: "application/json",
					"anthropic-dangerous-direct-browser-access": "true",
					"anthropic-beta": ["claude-code-20250219", "oauth-2025-04-20", ...betaFeatures].join(","),
					"user-agent": `claude-cli/${claudeCodeVersion}`,
					"x-app": "cli",
				},
				model.headers,
				optionsHeaders,
			),
		});

		return { client, isOAuthToken: true };
	}

	// API key auth
	const client = new Anthropic({
		apiKey,
		baseURL: model.baseUrl,
		dangerouslyAllowBrowser: true,
		defaultHeaders: mergeHeaders(
			{
				accept: "application/json",
				"anthropic-dangerous-direct-browser-access": "true",
				...(betaFeatures.length > 0 ? { "anthropic-beta": betaFeatures.join(",") } : {}),
			},
			model.headers,
			optionsHeaders,
		),
	});

	return { client, isOAuthToken: false };
}

function buildParams(
	model: Model<"anthropic-messages">,
	context: Context,
	isOAuthToken: boolean,
	options?: AnthropicOptions,
): MessageCreateParamsStreaming {
	const { cacheControl } = getCacheControl(model, options?.cacheRetention);
	const params: MessageCreateParamsStreaming = {
		model: model.id,
		messages: convertMessages(context.messages, model, isOAuthToken, cacheControl),
		max_tokens: options?.maxTokens || (model.maxTokens / 3) | 0,
		stream: true,
	};

	// For OAuth tokens, we MUST include Claude Code identity
	if (isOAuthToken) {
		params.system = [
			{
				type: "text",
				text: "You are Claude Code, Anthropic's official CLI for Claude.",
				...(cacheControl ? { cache_control: cacheControl } : {}),
			},
		];
		if (context.systemPrompt) {
			params.system.push({
				type: "text",
				text: sanitizeSurrogates(context.systemPrompt),
				...(cacheControl ? { cache_control: cacheControl } : {}),
			});
		}
	} else if (context.systemPrompt) {
		// Add cache control to system prompt for non-OAuth tokens
		params.system = [
			{
				type: "text",
				text: sanitizeSurrogates(context.systemPrompt),
				...(cacheControl ? { cache_control: cacheControl } : {}),
			},
		];
	}

	// Temperature is incompatible with extended thinking (adaptive or budget-based).
	if (options?.temperature !== undefined && !options?.thinkingEnabled) {
		params.temperature = options.temperature;
	}

	if (context.tools && context.tools.length > 0) {
		params.tools = convertTools(
			context.tools,
			isOAuthToken,
			getAnthropicCompat(model).supportsEagerToolInputStreaming,
			cacheControl,
		);
	}

	// Configure thinking mode: adaptive (Opus 4.6+ and Sonnet 4.6),
	// budget-based (older models), or explicitly disabled.
	if (model.reasoning) {
		if (options?.thinkingEnabled) {
			// Default to "summarized" so Opus 4.7 and Mythos Preview behave like
			// older Claude 4 models (whose API default is also "summarized").
			const display: AnthropicThinkingDisplay = options.thinkingDisplay ?? "summarized";
			if (supportsAdaptiveThinking(model)) {
				// Adaptive thinking: Claude decides when and how much to think.
				params.thinking = { type: "adaptive", display };
				if (options.effort) {
					// The Anthropic SDK types can lag newly supported effort values such
					// as "xhigh" and "max".
					params.output_config =
						options.effort === "xhigh" || options.effort === "max"
							? ({ effort: options.effort } as unknown as NonNullable<
									MessageCreateParamsStreaming["output_config"]
								>)
							: { effort: options.effort };
				}
			} else {
				// Budget-based thinking for older models
				params.thinking = {
					type: "enabled",
					budget_tokens: options.thinkingBudgetTokens || 1024,
					display,
				};
			}
		} else if (options?.thinkingEnabled === false) {
			params.thinking = { type: "disabled" };
		}
	}

	if (options?.metadata) {
		const userId = options.metadata.user_id;
		if (typeof userId === "string") {
			params.metadata = { user_id: userId };
		}
	}

	if (options?.toolChoice) {
		if (typeof options.toolChoice === "string") {
			params.tool_choice = { type: options.toolChoice };
		} else {
			params.tool_choice = options.toolChoice;
		}
	}

	return params;
}

// Normalize tool call IDs to match Anthropic's required pattern and length
function normalizeToolCallId(id: string): string {
	return id.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);
}

function convertMessages(
	messages: Message[],
	model: Model<"anthropic-messages">,
	isOAuthToken: boolean,
	cacheControl?: CacheControlEphemeral,
): MessageParam[] {
	const params: MessageParam[] = [];

	// Transform messages for cross-provider compatibility
	const transformedMessages = transformMessages(messages, model, normalizeToolCallId);

	// The one assistant message the API still validates verbatim: during a tool
	// loop, the message whose tool calls are being answered. Everything before
	// it is past validation.
	let lastAssistantIndex = -1;
	for (let i = transformedMessages.length - 1; i >= 0; i--) {
		if (transformedMessages[i].role === "assistant") {
			lastAssistantIndex = i;
			break;
		}
	}

	for (let i = 0; i < transformedMessages.length; i++) {
		const msg = transformedMessages[i];

		if (msg.role === "user") {
			if (typeof msg.content === "string") {
				if (msg.content.trim().length > 0) {
					params.push({
						role: "user",
						content: sanitizeSurrogates(msg.content),
					});
				}
			} else {
				const blocks: ContentBlockParam[] = msg.content.map((item) => {
					if (item.type === "text") {
						return {
							type: "text",
							text: sanitizeSurrogates(item.text),
						};
					} else {
						return {
							type: "image",
							source: {
								type: "base64",
								media_type: item.mimeType as "image/jpeg" | "image/png" | "image/gif" | "image/webp",
								data: item.data,
							},
						};
					}
				});
				const filteredBlocks = blocks.filter((b) => {
					if (b.type === "text") {
						return b.text.trim().length > 0;
					}
					return true;
				});
				if (filteredBlocks.length === 0) continue;
				params.push({
					role: "user",
					content: filteredBlocks,
				});
			}
		} else if (msg.role === "assistant") {
			// A turn that used one of the provider's server tools carries its wire
			// truth in rawContent (see the streaming side), because the
			// reconstruction below cannot rebuild the server tool blocks and the
			// API validates the latest assistant message verbatim during a tool
			// loop — signatures, order, every block. Only the latest message and
			// only for the model that signed it: earlier turns are past
			// validation, and resending old search results for the rest of a
			// room's life is exactly the dead weight aged tool results put down.
			// Cloned so nothing downstream can ever mutate the session's stored
			// message through the shared array.
			if (
				Array.isArray(msg.rawContent) &&
				msg.rawContent.length > 0 &&
				i === lastAssistantIndex &&
				msg.api === model.api &&
				msg.provider === model.provider &&
				msg.model === model.id &&
				rawContentPairingIntact(msg.rawContent)
			) {
				params.push({ role: "assistant", content: JSON.parse(JSON.stringify(msg.rawContent)) });
				continue;
			}
			const blocks: ContentBlockParam[] = [];

			for (const block of msg.content) {
				if (block.type === "text") {
					if (block.text.trim().length === 0) continue;
					blocks.push({
						type: "text",
						text: sanitizeSurrogates(block.text),
					});
				} else if (block.type === "thinking") {
					// Redacted thinking: pass the opaque payload back as redacted_thinking
					if (block.redacted) {
						blocks.push({
							type: "redacted_thinking",
							data: block.thinkingSignature!,
						});
						continue;
					}
					// A signed thinking block is the provider's own material and goes
					// back even when its text is empty: on accounts where the API
					// validates resent history, withholding a block it signed is a 400.
					if (block.thinkingSignature && block.thinkingSignature.trim().length > 0) {
						blocks.push({
							type: "thinking",
							thinking: sanitizeSurrogates(block.thinking),
							signature: block.thinkingSignature,
						});
						continue;
					}
					if (block.thinking.trim().length === 0) continue;
					// If thinking signature is missing/empty (e.g., from aborted stream),
					// convert to plain text block without <thinking> tags to avoid API rejection
					// and prevent Claude from mimicking the tags in responses
					blocks.push({
						type: "text",
						text: sanitizeSurrogates(block.thinking),
					});
				} else if (block.type === "toolCall") {
					blocks.push({
						type: "tool_use",
						id: block.id,
						name: isOAuthToken ? toClaudeCodeName(block.name) : block.name,
						input: block.arguments ?? {},
					});
				}
			}
			// A turn cut off inside its reasoning leaves nothing but thinking
			// behind. The API merges consecutive assistant content before
			// validating and refuses two adjacent thinking blocks in the merged
			// turn, so replaying that fragment next to the retry that followed it
			// is a 400. It said nothing and called nothing; it stays out.
			if (
				(msg.stopReason === "length" || msg.stopReason === "error" || msg.stopReason === "aborted") &&
				blocks.length > 0 &&
				blocks.every((b) => b.type === "thinking" || b.type === "redacted_thinking")
			) {
				continue;
			}
			if (blocks.length === 0) continue;
			params.push({
				role: "assistant",
				content: blocks,
			});
		} else if (msg.role === "toolResult") {
			// Collect all consecutive toolResult messages, needed for z.ai Anthropic endpoint
			const toolResults: ContentBlockParam[] = [];

			// Add the current tool result
			toolResults.push({
				type: "tool_result",
				tool_use_id: msg.toolCallId,
				content: convertContentBlocks(msg.content),
				is_error: msg.isError,
			});

			// Look ahead for consecutive toolResult messages
			let j = i + 1;
			while (j < transformedMessages.length && transformedMessages[j].role === "toolResult") {
				const nextMsg = transformedMessages[j] as ToolResultMessage; // We know it's a toolResult
				toolResults.push({
					type: "tool_result",
					tool_use_id: nextMsg.toolCallId,
					content: convertContentBlocks(nextMsg.content),
					is_error: nextMsg.isError,
				});
				j++;
			}

			// Skip the messages we've already processed
			i = j - 1;

			// Add a single user message with all tool results
			params.push({
				role: "user",
				content: toolResults,
			});
		}
	}

	// Add cache_control to the last user message to cache conversation history
	if (cacheControl && params.length > 0) {
		const lastMessage = params[params.length - 1];
		if (lastMessage.role === "user") {
			if (Array.isArray(lastMessage.content)) {
				const lastBlock = lastMessage.content[lastMessage.content.length - 1];
				if (
					lastBlock &&
					(lastBlock.type === "text" || lastBlock.type === "image" || lastBlock.type === "tool_result")
				) {
					(lastBlock as any).cache_control = cacheControl;
				}
			} else if (typeof lastMessage.content === "string") {
				lastMessage.content = [
					{
						type: "text",
						text: lastMessage.content,
						cache_control: cacheControl,
					},
				] as any;
			}
		}
	}

	return params;
}

function shouldUseFineGrainedToolStreamingBeta(model: Model<"anthropic-messages">, context: Context): boolean {
	return !!context.tools?.length && !getAnthropicCompat(model).supportsEagerToolInputStreaming;
}

function convertTools(
	tools: Tool[],
	isOAuthToken: boolean,
	supportsEagerToolInputStreaming: boolean,
	cacheControl?: CacheControlEphemeral,
): Anthropic.Messages.Tool[] {
	if (!tools) return [];

	return tools.map((tool, index) => {
		const schema = tool.parameters as { properties?: unknown; required?: string[] };

		return {
			name: isOAuthToken ? toClaudeCodeName(tool.name) : tool.name,
			description: tool.description,
			...(supportsEagerToolInputStreaming ? { eager_input_streaming: true } : {}),
			input_schema: {
				type: "object",
				properties: schema.properties ?? {},
				required: schema.required ?? [],
			},
			...(cacheControl && index === tools.length - 1 ? { cache_control: cacheControl } : {}),
		};
	});
}

/**
 * How many times a paused turn is handed back before we stop and say so. A
 * bound rather than a loop: a provider that paused three times in a row is not
 * about to finish, and an unbounded resubmit spends somebody's money forever.
 */
const MAX_PAUSED_TURN_RESUBMITS = 3;

/**
 * The block types the streaming parse above turns into `output.content`.
 * Anything the wire sends outside this set (server_tool_use,
 * web_search_tool_result, whatever the provider adds next) is invisible to the
 * parsed message, which is exactly when the raw copy has to be kept.
 */
const PARSED_ANTHROPIC_BLOCK_TYPES = new Set(["text", "thinking", "redacted_thinking", "tool_use"]);

/**
 * The provider's refusal to accept the HISTORY we resent, in any of its known
 * voices. Two validators have been met in the field: the verbatim-thinking
 * check ("thinking blocks in the latest assistant message cannot be modified")
 * and the server-tool pairing check ("each web_search_tool_result block must
 * have a corresponding server_tool_use block before it"). Both complain about
 * material only the app's resend puts on the wire, and the provider is
 * entitled to add more relatives; the match is therefore kept to refusals that
 * name that material rather than to one memorized sentence.
 */
export function isResentHistoryRefusal(error: unknown): boolean {
	const message = error instanceof Error ? error.message : String(error);
	if (!/invalid_request_error/i.test(message)) return false;
	return (
		/(thinking|redacted_thinking)[^.]*cannot be modified|must remain as they were in the original response/i.test(message) ||
		/(server_tool_use|web_search_tool_result)/i.test(message) ||
		// The family fingerprint, for the validator nobody has met yet: every
		// history refusal seen in the field pinpoints a position in the resent
		// conversation. A complaint that points into messages.N is a complaint
		// about material we sent back, whatever vocabulary it uses, and one
		// sanitized retry is cheaper than one walled room. A false match costs
		// exactly one extra request before the original error surfaces.
		/messages\.\d+/.test(message)
	);
}

/**
 * The same request with nothing left for a history validator to check:
 * thinking declared off, every thinking block removed, and every server tool
 * block (the search calls and results the provider itself wove into earlier
 * answers) removed with them. What remains is plain text and tool-call pairs,
 * the shape every effort-off conversation sends all day. An assistant message
 * left with no blocks at all is dropped whole rather than sent empty.
 */
export function stripValidatedHistoryFromParams<T extends { messages: any[]; thinking?: unknown }>(params: T): T {
	const stripped = new Set(["thinking", "redacted_thinking", "server_tool_use", "web_search_tool_result"]);
	return {
		...params,
		thinking: { type: "disabled" },
		messages: params.messages
			.map((message: any) => {
				if (message?.role !== "assistant" || !Array.isArray(message.content)) return message;
				const content = message.content.filter((block: any) => !stripped.has(String(block?.type)));
				return { ...message, content };
			})
			.filter((message: any) => message?.role !== "assistant" || !Array.isArray(message.content) || message.content.length > 0),
	};
}

/**
 * Whether a raw copy is structurally fit to resend: every search result must
 * be preceded, in the same message, by the search call it answers. The
 * provider validates that pairing on input, so a copy that lost a call (a
 * fault in the recording, however it happened) must fall back to the lean
 * form rather than be sent and refused.
 */
export function rawContentPairingIntact(rawContent: unknown[]): boolean {
	const seenServerToolUse = new Set<string>();
	for (const block of rawContent as Array<Record<string, any>>) {
		if (block?.type === "server_tool_use" && typeof block.id === "string") seenServerToolUse.add(block.id);
		if (block?.type === "web_search_tool_result") {
			const id = block.tool_use_id;
			if (typeof id !== "string" || !seenServerToolUse.has(id)) return false;
		}
	}
	return true;
}

/**
 * The provider's own blocks, kept exactly as they arrived.
 *
 * Continuing a paused turn means handing the turn back the way it came, and
 * the assistant message we build for the caller cannot do that job: it has no
 * home for a server tool's call or its results, which is the right shape for
 * reading an answer and the wrong one for resuming it. A block dropped on the
 * way out would be a block missing on the way back in, and a tool_use without
 * its result is a request the API refuses. So the raw blocks are accumulated
 * beside the parsed ones, used only to build the continuation, and thrown away
 * with the response.
 */
function captureRawAnthropicBlock(rawBlocks: Map<number, Record<string, any>>, event: any): void {
	if (event.type === "content_block_start") {
		rawBlocks.set(event.index, JSON.parse(JSON.stringify(event.content_block)));
		return;
	}
	if (event.type === "content_block_delta") {
		const block = rawBlocks.get(event.index);
		if (!block) return;
		const delta = event.delta;
		if (delta.type === "text_delta") block.text = (block.text ?? "") + delta.text;
		else if (delta.type === "thinking_delta") block.thinking = (block.thinking ?? "") + delta.thinking;
		else if (delta.type === "signature_delta") block.signature = (block.signature ?? "") + delta.signature;
		else if (delta.type === "input_json_delta") block.partialJsonScratch = (block.partialJsonScratch ?? "") + delta.partial_json;
		// Citations arrive as their own delta on text written from server search
		// results. A block resent without them is not the block the provider
		// signed, so they are accumulated exactly like text.
		else if (delta.type === "citations_delta" && delta.citation !== undefined) {
			block.citations = Array.isArray(block.citations) ? [...block.citations, delta.citation] : [delta.citation];
		}
		return;
	}
	if (event.type === "content_block_stop") {
		const block = rawBlocks.get(event.index);
		if (!block) return;
		if (typeof block.partialJsonScratch === "string") {
			try {
				block.input = block.partialJsonScratch ? JSON.parse(block.partialJsonScratch) : {};
			} catch {
				block.input = {};
			}
			delete block.partialJsonScratch;
		}
	}
}

/** The paused turn as content the provider will accept back. */
function finalizeRawAnthropicBlocks(rawBlocks: Map<number, Record<string, any>>): Record<string, any>[] {
	const content: Record<string, any>[] = [];
	for (const block of rawBlocks.values()) {
		const { partialJsonScratch: _scratch, ...rest } = block;
		// Only a block with NOTHING in it is withheld: the API refuses a text
		// block whose text is the empty string. A whitespace-only block, on the
		// other hand, is something the provider itself produced and signed -
		// dropping it moves every later block down one index, which is exactly
		// the modification the verbatim validation rejects.
		if (rest.type === "text" && String(rest.text ?? "") === "") continue;
		content.push(rest);
	}
	return content;
}

function mapStopReason(reason: Anthropic.Messages.StopReason | string): StopReason {
	switch (reason) {
		case "end_turn":
			return "stop";
		case "max_tokens":
			return "length";
		case "tool_use":
			return "toolUse";
		case "refusal":
			return "error";
		// The streaming function resubmits a paused turn before anyone sees this,
		// so by the time a stop reason reaches a caller the turn really has
		// stopped. This mapping only covers the case where it paused more times
		// than we were willing to follow, and there the turn is genuinely over.
		case "pause_turn":
			return "stop";
		case "stop_sequence":
			return "stop"; // We don't supply stop sequences, so this should never happen
		case "sensitive": // Content flagged by safety filters (not yet in SDK types)
			return "error";
		default:
			// Handle unknown stop reasons gracefully (API may add new values)
			throw new Error(`Unhandled stop reason: ${reason}`);
	}
}
