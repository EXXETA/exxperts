import { BedrockRuntimeClient } from "@aws-sdk/client-bedrock-runtime";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getModel } from "../src/models.js";
import { streamBedrock } from "../src/providers/amazon-bedrock.js";
import { streamAnthropic } from "../src/providers/anthropic.js";
import type { AssistantMessage, Context, Message, Model } from "../src/types.js";

// The host's hidden room-state copy reaches the provider as a user message
// marked roomState. On the Claude API key route, the models Anthropic lists for
// mid-conversation system messages get it as role "system", carrying the
// conversation's cache mark when it is the final message. Everywhere else, and
// wherever the placement rule would answer 400, it stays plain user text.

const mockState = vi.hoisted(() => ({
	createParams: undefined as Record<string, unknown> | undefined,
	calls: [] as Record<string, unknown>[],
	// Refusals answered, in order, before the stream succeeds.
	refusals: [] as Error[],
}));

vi.mock("@anthropic-ai/sdk", () => {
	function createSseResponse(): Response {
		const events = [
			{
				type: "message_start",
				message: {
					id: "msg_test",
					type: "message",
					role: "assistant",
					model: "claude-opus-5-5",
					content: [],
					stop_reason: null,
					stop_sequence: null,
					usage: {
						input_tokens: 10,
						output_tokens: 0,
						cache_read_input_tokens: 0,
						cache_creation_input_tokens: 0,
					},
				},
			},
			{ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
			{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hello." } },
			{ type: "content_block_stop", index: 0 },
			{
				type: "message_delta",
				delta: { stop_reason: "end_turn", stop_sequence: null },
				usage: { output_tokens: 5 },
			},
			{ type: "message_stop" },
		];
		const body = events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n`).join("\n");
		return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
	}

	class FakeAnthropic {
		messages = {
			create: (params: Record<string, unknown>) => {
				mockState.createParams = params;
				mockState.calls.push(params);
				const refusal = mockState.refusals.shift();
				return {
					asResponse: async () => {
						if (refusal) throw refusal;
						return createSseResponse();
					},
				};
			},
		};
	}

	return { default: FakeAnthropic };
});

const API_KEY = "sk-ant-api03-test-key";
const OAUTH_KEY = "sk-ant-oat01-test-token";
const STATE_TEXT = "Room state (replaces any earlier copy): files: notes.md";
const T = 1_700_000_000_000;

interface WireMessage {
	role: string;
	content: string | Record<string, unknown>[];
}

function anthropicModel(id: string, provider = "anthropic"): Model<"anthropic-messages"> {
	const known = getModel(provider as "anthropic", id as "claude-opus-5-5");
	// Mythos is not in the generated catalogue; it takes a listed row's shape.
	const model = known ?? { ...getModel("anthropic", "claude-fable-5-1")!, id };
	return model as Model<"anthropic-messages">;
}

function roomState(text = STATE_TEXT): Message {
	return { role: "user", content: [{ type: "text", text }], timestamp: T, roomState: true };
}

function user(text: string): Message {
	return { role: "user", content: text, timestamp: T };
}

function assistant(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-opus-5-5",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: T,
	};
}

async function wireParams(model: Model<"anthropic-messages">, messages: Message[], apiKey = API_KEY) {
	mockState.createParams = undefined;
	const context: Context = { systemPrompt: "You are a helpful assistant.", messages };
	// Short retention pinned, so a PI_CACHE_RETENTION from the shell cannot change the bytes.
	await streamAnthropic(model, context, { apiKey, cacheRetention: "short" }).result();
	expect(mockState.createParams, "the request reached the SDK").toBeDefined();
	return mockState.createParams as unknown as { messages: WireMessage[] } & Record<string, unknown>;
}

function lastBlock(message: WireMessage): Record<string, unknown> {
	expect(Array.isArray(message.content)).toBe(true);
	return (message.content as Record<string, unknown>[]).at(-1)!;
}

beforeEach(() => {
	mockState.createParams = undefined;
	mockState.calls = [];
	mockState.refusals = [];
});

const LISTED_MODELS = [
	"claude-fable-5",
	"claude-fable-5-1",
	"claude-mythos-5",
	"claude-mythos-5-1",
	"claude-mythos-preview",
	"claude-opus-5",
	"claude-opus-5-5",
	"claude-opus-4-8",
	"claude-sonnet-5-5",
	"claude-haiku-5-5",
];

describe("a final room-state message on the listed models (API key)", () => {
	it.each(LISTED_MODELS)("%s sends it as role system with the cache mark on its last block", async (id) => {
		const { messages } = await wireParams(anthropicModel(id), [user("Hello"), roomState()]);
		expect(messages).toHaveLength(2);
		expect(messages[0]).toEqual({ role: "user", content: "Hello" });
		expect(messages[1].role).toBe("system");
		expect(lastBlock(messages[1])).toEqual({
			type: "text",
			text: STATE_TEXT,
			cache_control: expect.objectContaining({ type: "ephemeral" }),
		});
		// The person's message no longer carries the mark: one breakpoint, at the end.
		expect(JSON.stringify(messages[0])).not.toContain("cache_control");
	});

	it("also on the anthropic-api-key provider row", async () => {
		const { messages } = await wireParams(anthropicModel("claude-opus-5-5", "anthropic-api-key"), [
			user("Hello"),
			roomState(),
		]);
		expect(messages.at(-1)!.role).toBe("system");
	});

	it("earlier copies followed by an assistant turn go as role system too, and only the final one is marked", async () => {
		const { messages } = await wireParams(anthropicModel("claude-opus-5-5"), [
			user("Hello"),
			roomState("state one"),
			assistant("Hi."),
			user("And now?"),
			roomState("state two"),
		]);
		expect(messages.map((m) => m.role)).toEqual(["user", "system", "assistant", "user", "system"]);
		expect(JSON.stringify(messages[1])).not.toContain("cache_control");
		expect(lastBlock(messages[4]).cache_control).toBeDefined();
	});
});

// Today's path: plain user text, the cache mark on its last block.
function expectUserText(messages: WireMessage[]) {
	expect(messages.some((m) => m.role === "system")).toBe(false);
	const last = messages.at(-1)!;
	expect(last.role).toBe("user");
	expect(lastBlock(last)).toEqual({
		type: "text",
		text: STATE_TEXT,
		cache_control: expect.objectContaining({ type: "ephemeral" }),
	});
}

describe("everywhere else it stays plain user text", () => {
	it("the Claude sign-in (subscription token) on a listed model", async () => {
		const { messages } = await wireParams(anthropicModel("claude-opus-5-5"), [user("Hello"), roomState()], OAUTH_KEY);
		expectUserText(messages);
	});

	it.each(["claude-sonnet-5", "claude-opus-4-7", "claude-opus-4-6", "claude-sonnet-4-6", "claude-haiku-4-5"])(
		"%s, which the feature does not cover",
		async (id) => {
			const { messages } = await wireParams(anthropicModel(id), [user("Hello"), roomState()]);
			expectUserText(messages);
		},
	);

	it("a listed model reached through another provider (Copilot)", async () => {
		const { messages } = await wireParams(anthropicModel("claude-opus-4.8", "github-copilot"), [
			user("Hello"),
			roomState(),
		]);
		expectUserText(messages);
	});

	it("Bedrock", async () => {
		vi.spyOn(BedrockRuntimeClient.prototype, "send").mockRejectedValue(new Error("no request in this test"));
		const model = {
			...getModel("amazon-bedrock", "global.anthropic.claude-opus-4-6-v1"),
			id: "global.anthropic.claude-opus-5-5",
		};
		let payload: { messages: { role: string; content: Record<string, unknown>[] }[] } | undefined;
		const s = streamBedrock(
			model,
			{ systemPrompt: "You are helpful.", messages: [user("Hello"), roomState()] },
			{
				signal: AbortSignal.abort(),
				onPayload: (p) => {
					payload = p as typeof payload;
					return p;
				},
			},
		);
		for await (const event of s) if (event.type === "error") break;
		expect(payload).toBeDefined();
		expect(payload!.messages.every((m) => m.role === "user" || m.role === "assistant")).toBe(true);
		expect(JSON.stringify(payload!.messages.at(-1))).toContain(STATE_TEXT);
		vi.restoreAllMocks();
	});
});

describe("placement: role system only where the API takes it", () => {
	it("a copy followed by a user message (after a failed turn) goes as user text; the newest copy still goes as system", async () => {
		const failed: AssistantMessage = {
			...assistant(""),
			content: [],
			stopReason: "error",
			errorMessage: "overloaded",
		};
		const { messages } = await wireParams(anthropicModel("claude-opus-5-5"), [
			user("First try"),
			roomState("stale state"),
			failed,
			user("Second try"),
			roomState(),
		]);
		expect(messages.map((m) => m.role)).toEqual(["user", "user", "user", "system"]);
		expect(messages[1]).toEqual({ role: "user", content: [{ type: "text", text: "stale state" }] });
		expect(lastBlock(messages[3]).cache_control).toBeDefined();
	});

	it("two copies in a row before the answer both go as system", async () => {
		const { messages } = await wireParams(anthropicModel("claude-opus-5-5"), [
			user("Hello"),
			roomState("state one"),
			roomState(),
		]);
		expect(messages.map((m) => m.role)).toEqual(["user", "system", "system"]);
	});

	it("a copy right after an assistant turn stays user text, since it must follow a user turn", async () => {
		const { messages } = await wireParams(anthropicModel("claude-opus-5-5"), [
			user("Hello"),
			assistant("Hi."),
			roomState(),
		]);
		expectUserText(messages);
	});

	it("a copy carrying an image stays user text, since a system message takes text only", async () => {
		const withImage: Message = {
			role: "user",
			content: [
				{ type: "image", data: "aGVsbG8=", mimeType: "image/png" },
				{ type: "text", text: STATE_TEXT },
			],
			timestamp: T,
			roomState: true,
		};
		const { messages } = await wireParams(anthropicModel("claude-opus-5-5"), [user("Hello"), withImage]);
		expectUserText(messages);
	});
});

describe("the history-refusal retry", () => {
	it("sends a copy left before a user message as user text once the stripped answer is gone", async () => {
		// A signed thinking-only answer keeps the first copy as system on the first try;
		// the retry strips thinking, drops that empty answer, and must not leave
		// system before the next user message (a placement 400).
		const thinkingOnly: AssistantMessage = {
			...assistant(""),
			content: [{ type: "thinking", thinking: "", thinkingSignature: "sig-1" }],
		};
		mockState.refusals = [
			new Error(
				'400 {"type":"error","error":{"type":"invalid_request_error","message":"messages.2.content.0: Invalid signature in thinking block. The block is bound to a different conversation."}}',
			),
		];
		const result = await streamAnthropic(
			anthropicModel("claude-opus-5-5"),
			{
				systemPrompt: "You are a helpful assistant.",
				messages: [user("Hello"), roomState("state one"), thinkingOnly, user("And now?"), roomState()],
			},
			{ apiKey: API_KEY },
		).result();
		expect(result.stopReason).toBe("stop");
		expect(mockState.calls).toHaveLength(2);
		const roles = (call: Record<string, unknown>) => (call.messages as WireMessage[]).map((m) => m.role);
		expect(roles(mockState.calls[0])).toEqual(["user", "system", "assistant", "user", "system"]);
		expect(roles(mockState.calls[1])).toEqual(["user", "user", "user", "system"]);
		const retried = (mockState.calls[1].messages as WireMessage[]).at(-1)!;
		expect(lastBlock(retried).cache_control).toBeDefined();
	});
});

describe("a request with no room-state message", () => {
	it("is byte-identical to main's", async () => {
		const toolTurn: AssistantMessage = {
			...assistant("Reading it."),
			content: [
				{ type: "text", text: "Reading it." },
				{ type: "toolCall", id: "toolu_1", name: "read_file", arguments: { path: "notes.md" } },
			],
			stopReason: "toolUse",
		};
		const params = await wireParams(anthropicModel("claude-opus-5-5"), [
			user("Hello"),
			assistant("Hi."),
			{ role: "user", content: [{ type: "text", text: "Look at this" }], timestamp: T },
			toolTurn,
			{
				role: "toolResult",
				toolCallId: "toolu_1",
				toolName: "read_file",
				content: [{ type: "text", text: "# Notes" }],
				isError: false,
				timestamp: T,
			},
		]);
		expect(JSON.stringify(params)).toBe(MAIN_PARAMS);
	});
});

// Captured from main for the request above.
const MAIN_PARAMS =
	'{"model":"claude-opus-5-5","messages":[{"role":"user","content":"Hello"},{"role":"assistant","content":[{"type":"text","text":"Hi."}]},{"role":"user","content":[{"type":"text","text":"Look at this"}]},{"role":"assistant","content":[{"type":"text","text":"Reading it."},{"type":"tool_use","id":"toolu_1","name":"read_file","input":{"path":"notes.md"}}]},{"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_1","content":"# Notes","is_error":false,"cache_control":{"type":"ephemeral"}}]}],"max_tokens":42666,"stream":true,"system":[{"type":"text","text":"You are a helpful assistant.","cache_control":{"type":"ephemeral"}}]}';
