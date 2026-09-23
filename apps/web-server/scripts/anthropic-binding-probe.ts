// Anthropic thinking-binding probe (dev only).
//
// Asks the Anthropic Messages API whether a request that carries the beta
// header thinking-binding-controls-2026-08-01 and the field
// thinking.block_binding.prefix_mismatch_behavior = "drop_block" is accepted
// on the credential exxperts holds. The credential is ANTHROPIC_API_KEY when
// that is set, otherwise the stored Claude sign-in, read the way the provider
// reads it and sent with the same headers the provider sends. Two requests go
// to claude-fable-5-1:
//
//   1. one turn: expect 200;
//   2. a two-turn replay: turn 1 under system prompt A, then turn 2 under
//      system prompt B with turn 1's assistant content replayed verbatim
//      (every block, thinking blocks with their signature, in order): expect
//      200 and an input_transformations entry with the reason
//      prefix_binding_mismatch.
//
// For each request it prints the HTTP status, the content block types,
// input_transformations (or "none") and, on a refusal, the first error
// message. Nothing else is printed: the token travels only inside the
// requests. Exit code 0 when both requests answered 200, 1 otherwise, 2 when
// no credential is found.
//
// The body is built the way the provider builds it on a subscription token
// (buildParams in runtime/packages/ai/src/providers/anthropic.ts): the fixed
// Claude Code system block first, the probe's own system text as the second
// block, ephemeral cache control on both and on the last user block, the same
// thinking object, streamed. No metadata block: exxperts never passes one.
//
// Run from the repository root with a Claude sign-in in place, or with
// ANTHROPIC_API_KEY exported; the model id is optional (default
// claude-fable-5-1) and must name a row of the Anthropic catalogue. Whether
// the model binds its thinking blocks is decided by the provider's own rule
// (usesThinkingBlockBinding, imported here rather than mirrored). The prefix
// replay (request 2) only means something on a model that binds its thinking
// blocks, so on any other model only request 1 runs:
//
//     npx tsx apps/web-server/scripts/anthropic-binding-probe.ts
//     npx tsx apps/web-server/scripts/anthropic-binding-probe.ts claude-opus-5-5
//     npx tsx apps/web-server/scripts/anthropic-binding-probe.ts claude-opus-5

import { getModels } from "@exxeta/exxperts-ai";
import { usesThinkingBlockBinding } from "@exxeta/exxperts-ai/anthropic";
import { AuthStorage } from "@exxeta/exxperts-runtime";

const PROVIDER_ID = "anthropic";
const MESSAGES_URL = "https://api.anthropic.com/v1/messages";
const DEFAULT_MODEL_ID = "claude-fable-5-1";
// The provider's fixed first system block on a subscription token.
const OAUTH_IDENTITY = "You are Claude Code, Anthropic's official CLI for Claude.";
const CACHE_CONTROL = { type: "ephemeral" } as const;
const ANTHROPIC_VERSION = "2023-06-01";
const BINDING_BETA = "thinking-binding-controls-2026-08-01";
// The provider sends these two on a subscription token (createClient in
// runtime/packages/ai/src/providers/anthropic.ts).
const OAUTH_BETAS = ["claude-code-20250219", "oauth-2025-04-20"];
// Same value as claudeCodeVersion in the provider, which is not exported:
// 2.1.280, the minimum the subscription named for claude-opus-5-5 on
// 2026-09-22 (error_code claude_code_version_too_old on 2.1.251).
const CLAUDE_CODE_VERSION = "2.1.280";
// The provider's default: a third of the model's output limit (128000 for the
// Claude 5 line).
const MAX_TOKENS = (128000 / 3) | 0;
const TIMEOUT_MS = 60_000;
const ERROR_PREVIEW_CHARS = 200;
const RAW_BODY_PREVIEW_CHARS = 300;

const SYSTEM_PLAIN = "You are a terse assistant.";
const SYSTEM_A = "You are a terse assistant. Today's project is A.";
const SYSTEM_B = "You are a terse assistant. Today's project is B.";
const USER_FIRST = "Think briefly about why the sky is blue, then answer in one sentence.";
const USER_SECOND = "Now answer again in one sentence, in other words.";
// Request 2 needs a thinking block to replay, so its turn 1 is a short
// multi-step task at effort high; a one-liner at effort low may produce none.
const USER_REASONING =
	"Three friends split a bill: A pays twice B, C pays 4 more than B, total 40; who paid what, and what is the fair per-head amount? Reason it through before answering.";

type ContentBlock = { type: string; [key: string]: unknown };
type InputTransformation = { type?: unknown; path?: unknown; reason?: unknown };
type MessageParam = { role: "user" | "assistant"; content: ContentBlock[] };
type MessageResponse = {
	content?: unknown;
	input_transformations?: unknown;
	error?: { type?: unknown; message?: unknown } | string;
};
type StreamEvent = Record<string, any>;

type Credential = { token: string; source: "api key" | "stored sign-in" };

type Outcome = {
	ok: boolean;
	status: number;
	content: ContentBlock[];
	transformations: InputTransformation[];
	error?: string;
	/** On a refusal: the error type from the JSON body, if any. */
	errorType?: string;
	/** On a refusal: retry-after and anthropic-ratelimit-* response headers. */
	limitHeaders?: string[];
	/** On a refusal: the start of the raw body, so a usage limit and a model refusal can be told apart. */
	rawBody?: string;
};

function isOAuthToken(token: string): boolean {
	return token.includes("sk-ant-oat");
}

async function resolveCredential(): Promise<Credential | null> {
	const fromEnv = process.env.ANTHROPIC_API_KEY?.trim();
	if (fromEnv) return { token: fromEnv, source: "api key" };
	const stored = await AuthStorage.create().getApiKey(PROVIDER_ID);
	if (stored) return { token: stored, source: "stored sign-in" };
	return null;
}

function buildHeaders(token: string): Headers {
	const headers = new Headers();
	headers.set("anthropic-version", ANTHROPIC_VERSION);
	headers.set("content-type", "application/json");
	headers.set("accept", "application/json");
	if (isOAuthToken(token)) {
		headers.set("Authorization", `Bearer ${token}`);
		headers.set("anthropic-beta", [...OAUTH_BETAS, BINDING_BETA].join(","));
		headers.set("user-agent", `claude-cli/${CLAUDE_CODE_VERSION}`);
		headers.set("x-app", "cli");
	} else {
		headers.set("x-api-key", token);
		headers.set("anthropic-beta", BINDING_BETA);
	}
	return headers;
}

function userTurn(text: string): MessageParam {
	return { role: "user", content: [{ type: "text", text }] };
}

/** The provider's OAuth body: identity block, caller's system block, cache control on both and on the last user block. */
function buildBody(modelId: string, binding: boolean, system: string, messages: MessageParam[], effort: "low" | "high" = "low"): Record<string, unknown> {
	const withCache = messages.map((message, index) => {
		if (index !== messages.length - 1 || message.role !== "user") return message;
		const content = message.content.map((block, blockIndex) =>
			blockIndex === message.content.length - 1 ? { ...block, cache_control: CACHE_CONTROL } : block,
		);
		return { ...message, content };
	});
	const bindingParam = binding ? { block_binding: { prefix_mismatch_behavior: "drop_block" } } : {};
	return {
		model: modelId,
		messages: withCache,
		max_tokens: MAX_TOKENS,
		stream: true,
		system: [
			{ type: "text", text: OAUTH_IDENTITY, cache_control: CACHE_CONTROL },
			{ type: "text", text: system, cache_control: CACHE_CONTROL },
		],
		thinking: { type: "adaptive", display: "summarized", ...bindingParam },
		output_config: { effort },
	};
}

function errorTypeOf(bodyText: string): string | undefined {
	try {
		const parsed = JSON.parse(bodyText) as MessageResponse;
		const type = typeof parsed.error === "object" && parsed.error ? parsed.error.type : undefined;
		return typeof type === "string" && type.length > 0 ? type : undefined;
	} catch {
		return undefined;
	}
}

function limitHeadersOf(headers: Headers): string[] {
	const lines: string[] = [];
	headers.forEach((value, name) => {
		const lower = name.toLowerCase();
		if (lower === "retry-after" || lower.startsWith("anthropic-ratelimit-")) lines.push(`${lower}: ${value}`);
	});
	return lines.sort();
}

function firstErrorMessage(bodyText: string): string {
	try {
		const parsed = JSON.parse(bodyText) as MessageResponse;
		if (typeof parsed.error === "string") return parsed.error;
		const message = parsed.error?.message;
		if (typeof message === "string" && message.length > 0) return message;
	} catch {}
	return bodyText.slice(0, ERROR_PREVIEW_CHARS);
}

/** Rebuilds the message from the SSE body the way the provider does: blocks from content_block_start, text, thinking and signature deltas appended, input_transformations from message_start. */
function assembleStream(bodyText: string): { content: ContentBlock[]; transformations: InputTransformation[]; error?: string } {
	const content: ContentBlock[] = [];
	let transformations: InputTransformation[] = [];
	let error: string | undefined;
	for (const chunk of bodyText.split("\n\n")) {
		const data = chunk
			.split("\n")
			.filter((line) => line.startsWith("data:"))
			.map((line) => line.slice(5).trim())
			.join("\n")
			.trim();
		if (!data) continue;
		let event: StreamEvent;
		try {
			event = JSON.parse(data) as StreamEvent;
		} catch {
			continue;
		}
		if (event.type === "message_start") {
			const message = event.message as MessageResponse | undefined;
			if (Array.isArray(message?.input_transformations)) transformations = message.input_transformations as InputTransformation[];
		} else if (event.type === "content_block_start" && typeof event.index === "number") {
			const block = event.content_block as ContentBlock | undefined;
			if (block) content[event.index] = { ...block };
		} else if (event.type === "content_block_delta" && typeof event.index === "number") {
			const block = content[event.index];
			const delta = event.delta as StreamEvent | undefined;
			if (!block || !delta) continue;
			if (delta.type === "text_delta") block.text = `${block.text ?? ""}${delta.text ?? ""}`;
			else if (delta.type === "thinking_delta") block.thinking = `${block.thinking ?? ""}${delta.thinking ?? ""}`;
			else if (delta.type === "signature_delta") block.signature = `${block.signature ?? ""}${delta.signature ?? ""}`;
		} else if (event.type === "error") {
			const detail = event.error as { type?: unknown; message?: unknown } | undefined;
			error = typeof detail?.message === "string" ? detail.message : JSON.stringify(event).slice(0, ERROR_PREVIEW_CHARS);
		}
	}
	return { content: content.filter((block) => block !== undefined), transformations, error };
}

async function send(headers: Headers, body: Record<string, unknown>): Promise<Outcome> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
	const failed = (error: string): Outcome => ({ ok: false, status: 0, content: [], transformations: [], error });
	try {
		let response: Response;
		try {
			response = await fetch(MESSAGES_URL, {
				method: "POST",
				headers,
				body: JSON.stringify(body),
				signal: controller.signal,
			});
		} catch (error) {
			if (controller.signal.aborted) {
				return failed(`aborted: no response within ${TIMEOUT_MS / 1000} s`);
			}
			return failed(`request failed before a response: ${error instanceof Error ? error.message : String(error)}`);
		}

		let bodyText: string;
		try {
			bodyText = await response.text();
		} catch (error) {
			if (controller.signal.aborted) {
				return { ...failed(`aborted: the body did not arrive within ${TIMEOUT_MS / 1000} s`), status: response.status };
			}
			return {
				...failed(`reading the body failed: ${error instanceof Error ? error.message : String(error)}`),
				status: response.status,
			};
		}

		if (!response.ok) {
			return {
				ok: false,
				status: response.status,
				content: [],
				transformations: [],
				error: firstErrorMessage(bodyText),
				errorType: errorTypeOf(bodyText),
				limitHeaders: limitHeadersOf(response.headers),
				rawBody: bodyText.slice(0, RAW_BODY_PREVIEW_CHARS),
			};
		}

		const assembled = assembleStream(bodyText);
		if (assembled.error) {
			return { ok: false, status: response.status, content: assembled.content, transformations: assembled.transformations, error: assembled.error, rawBody: bodyText.slice(0, RAW_BODY_PREVIEW_CHARS) };
		}
		return { ok: true, status: response.status, content: assembled.content, transformations: assembled.transformations };
	} finally {
		clearTimeout(timer);
	}
}

function printOutcome(label: string, outcome: Outcome): void {
	console.log(`${label}: status ${outcome.status === 0 ? "none" : outcome.status}`);
	if (outcome.error) {
		console.log(`${label}: error: ${outcome.error}`);
		if (outcome.errorType) console.log(`${label}: error type: ${outcome.errorType}`);
		for (const line of outcome.limitHeaders ?? []) console.log(`${label}: header ${line}`);
		if (outcome.rawBody !== undefined) console.log(`${label}: raw body: ${outcome.rawBody.length > 0 ? outcome.rawBody : "(empty)"}`);
		return;
	}
	const types = outcome.content.map((block) => block.type);
	console.log(`${label}: content block types: ${types.length > 0 ? types.join(", ") : "none"}`);
	console.log(
		`${label}: input_transformations: ${outcome.transformations.length > 0 ? JSON.stringify(outcome.transformations) : "none"}`,
	);
}

function refusalLine(request: number, outcome: Outcome): string {
	return `outcome: request ${request} refused: ${outcome.error ?? `status ${outcome.status}`}`;
}

async function main(): Promise<number> {
	const modelId = process.argv[2]?.trim() || DEFAULT_MODEL_ID;
	// The catalogue row decides the binding rule, the same way the provider
	// decides it; an id without a row gets no request at all. The lookup goes
	// through the provider's row list because the id arrives as a plain string.
	const model = getModels(PROVIDER_ID).find((row) => row.id === modelId);
	if (!model) {
		console.log(`model: ${modelId} is not a row of the Anthropic catalogue (regenerate it, or check the id)`);
		return 1;
	}
	const binding = usesThinkingBlockBinding(model);
	console.log(`model: ${modelId}${binding ? "" : " (does not bind its thinking blocks: request 1 only)"}`);
	const credential = await resolveCredential();
	if (!credential) {
		console.log("no Claude sign-in found (sign in to exxperts with Claude first, or set ANTHROPIC_API_KEY)");
		return 2;
	}
	console.log(`using: ${credential.source}, sent as ${isOAuthToken(credential.token) ? "a subscription bearer token" : "an API key"}`);
	const headers = buildHeaders(credential.token);

	// Request 1: one turn.
	const first = await send(headers, buildBody(modelId, binding, SYSTEM_PLAIN, [userTurn(USER_FIRST)]));
	printOutcome("request 1", first);
	if (!first.ok) {
		console.log(refusalLine(1, first));
		return 1;
	}
	if (!binding) {
		console.log("outcome: request 1 answered 200; the prefix replay is skipped on a model that does not bind its thinking blocks");
		return 0;
	}

	// Request 2, turn 1: under system prompt A; the assistant content is kept verbatim.
	const turnOne = await send(headers, buildBody(modelId, binding, SYSTEM_A, [userTurn(USER_REASONING)], "high"));
	printOutcome("request 2 turn 1", turnOne);
	if (!turnOne.ok) {
		console.log(refusalLine(2, turnOne));
		return 1;
	}
	if (turnOne.content.length === 0) {
		console.log("request 2 turn 1: the answer carries no content blocks, nothing to replay");
		console.log("outcome: request 2 refused: no content to replay");
		return 1;
	}
	if (!turnOne.content.some((block) => block.type === "thinking" || block.type === "redacted_thinking")) {
		console.log("turn 1 produced no thinking block; nothing to drop");
		console.log("outcome: both 200, but the drop path is unproven: turn 1 produced no thinking block");
		return 1;
	}

	// Request 2, turn 2: under system prompt B, replaying turn 1's content unchanged.
	const turnTwo = await send(
		headers,
		buildBody(modelId, binding, SYSTEM_B, [userTurn(USER_REASONING), { role: "assistant", content: turnOne.content }, userTurn(USER_SECOND)], "high"),
	);
	printOutcome("request 2 turn 2", turnTwo);
	if (!turnTwo.ok) {
		console.log(refusalLine(2, turnTwo));
		return 1;
	}

	const present = turnTwo.transformations.length > 0 ? "yes" : "no";
	console.log(`outcome: both 200, input_transformations present: ${present}`);
	return 0;
}

main().then(
	(code) => process.exit(code),
	(error) => {
		console.log(`probe failed: ${error instanceof Error ? error.message : String(error)}`);
		process.exit(1);
	},
);
