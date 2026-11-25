import http from "node:http";
import type { AddressInfo } from "node:net";
import { Type } from "typebox";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { streamOpenAICompletions } from "../src/providers/openai-completions.js";
import type { AssistantMessage, Message, Model, OpenAICompletionsCompat, ToolResultMessage } from "../src/types.js";

// A Claude model behind an OpenAI-style gateway reads the conversation from
// the cache up to the newest message that carries a mark. Each row sends a
// request with the real client to a gateway on this machine and reads the
// body that arrived.

interface SentMessage {
	role: string;
	content: string | null | Array<{ type: string; text?: string; cache_control?: unknown }>;
	tool_calls?: unknown[];
	tool_call_id?: string;
	cache_control?: unknown;
}

interface SentBody {
	messages: SentMessage[];
	tools?: Array<{ cache_control?: unknown }>;
}

interface Sent {
	raw: string;
	body: SentBody;
}

const MARK = { type: "ephemeral" };
const sent: Sent[] = [];
let server: http.Server;
let baseUrl = "";

beforeAll(async () => {
	server = http.createServer((req, res) => {
		let raw = "";
		req.on("data", (chunk) => {
			raw += chunk;
		});
		req.on("end", () => {
			sent.push({ raw, body: JSON.parse(raw) as SentBody });
			const base = { id: "chatcmpl-test", object: "chat.completion.chunk", created: 0, model: "test" };
			res.writeHead(200, { "content-type": "text/event-stream" });
			for (const chunk of [
				{ ...base, choices: [{ index: 0, delta: { role: "assistant", content: "ok" }, finish_reason: null }] },
				{ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
			]) {
				res.write(`data: ${JSON.stringify(chunk)}\n\n`);
			}
			res.end("data: [DONE]\n\n");
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
});

afterAll(() => {
	server.close();
});

beforeEach(() => {
	sent.length = 0;
});

const CLAUDE: OpenAICompletionsCompat = { cacheControlFormat: "anthropic" };

function gatewayModel(compat: OpenAICompletionsCompat | null = CLAUDE, provider = "gateway-test", input: Model<"openai-completions">["input"] = ["text"]) {
	return {
		id: "bedrock/eu.anthropic.claude-opus-5-5",
		name: "Gateway test",
		api: "openai-completions",
		provider,
		baseUrl,
		reasoning: false,
		input,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200000,
		maxTokens: 8192,
		...(compat ? { compat } : {}),
	} satisfies Model<"openai-completions">;
}

const QUESTION: Message = { role: "user", content: "Please read the three files.", timestamp: 1 };

function calls(ids: string[], text?: string): AssistantMessage {
	return {
		role: "assistant",
		content: [
			...(text ? [{ type: "text" as const, text }] : []),
			...ids.map((id) => ({ type: "toolCall" as const, id, name: "read_file", arguments: { path: `${id}.txt` } })),
		],
		api: "openai-completions",
		provider: "gateway-test",
		model: "bedrock/eu.anthropic.claude-opus-5-5",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		stopReason: "toolUse",
		timestamp: 2,
	};
}

function result(id: string, text: string): ToolResultMessage {
	return { role: "toolResult", toolCallId: id, toolName: "read_file", content: [{ type: "text", text }], isError: false, timestamp: 3 };
}

function imageResult(id: string): ToolResultMessage {
	return { ...result(id, "a picture"), content: [{ type: "text", text: "a picture" }, { type: "image", data: "AAAA", mimeType: "image/png" }] };
}

/** A run of tool calls, one per step, with or without text beside each. */
function run(rounds: number, text?: string): Message[] {
	const messages: Message[] = [QUESTION];
	for (let round = 1; round <= rounds; round++) {
		messages.push(calls([`call_${round}`], text && `${text} ${round}`), result(`call_${round}`, `contents of file ${round}`));
	}
	return messages;
}

async function send(messages: Message[], options: { model?: Model<"openai-completions">; systemPrompt?: string; cacheRetention?: "none" | "short" | "long" } = {}): Promise<Sent> {
	await streamOpenAICompletions(
		options.model ?? gatewayModel(),
		{
			systemPrompt: options.systemPrompt ?? "You are a test.",
			messages,
			tools: [
				{ name: "read_file", description: "Read a file", parameters: Type.Object({ path: Type.String() }) },
				{ name: "list_folder", description: "List a folder", parameters: Type.Object({ path: Type.String() }) },
			],
		},
		{ apiKey: "test-key", cacheRetention: options.cacheRetention },
	).result();
	return sent[sent.length - 1];
}

function marks({ raw }: Sent): number {
	return raw.split('"cache_control"').length - 1;
}

/** Where the conversation's marks sit: the message's number, and "message" or "part". */
function conversationMarks({ body }: Sent): Array<[number, "message" | "part"]> {
	return body.messages.flatMap((message, index): Array<[number, "message" | "part"]> => {
		if (message.role === "system" || message.role === "developer") return [];
		if (message.cache_control) return [[index, "message"]];
		return Array.isArray(message.content) && message.content.some((part) => part.cache_control) ? [[index, "part"]] : [];
	});
}

/** The messages up to a mark as a gateway reads them: one text part for a plain string, and no marks. */
function upTo({ body }: Sent, index: number): string {
	return JSON.stringify(
		body.messages.slice(0, index + 1).map(({ cache_control: _mark, content, ...message }) => ({
			...message,
			content: typeof content === "string" ? [{ type: "text", text: content }] : content?.map(({ cache_control: _partMark, ...part }) => part),
		})),
	);
}

describe("openai-completions: the conversation's cache mark on a gateway", () => {
	it("user text only: on the newest message, on its text part", async () => {
		const request = await send([QUESTION]);
		expect(conversationMarks(request)).toEqual([[1, "part"]]);
		expect(request.body.messages[1].content).toEqual([{ type: "text", text: QUESTION.content, cache_control: MARK }]);
	});

	it("three rounds of only a tool call and its result: on the newest result", async () => {
		const request = await send(run(3));
		expect(conversationMarks(request)).toEqual([[7, "message"]]);
		expect(request.body.messages[7]).toEqual({ role: "tool", content: "contents of file 3", tool_call_id: "call_3", cache_control: MARK });
		expect(request.body.messages[2]).toEqual({
			role: "assistant",
			content: null,
			tool_calls: [{ id: "call_1", type: "function", function: { name: "read_file", arguments: '{"path":"call_1.txt"}' } }],
		});
	});

	it("three rounds of text with a tool call and its result: on the newest result, the text unmarked", async () => {
		const request = await send(run(3, "Reading file"));
		expect(conversationMarks(request)).toEqual([[7, "message"]]);
		expect(request.body.messages[6].content).toBe("Reading file 3");
	});

	it("several tool results in one step: on the last result only", async () => {
		const request = await send([QUESTION, calls(["call_a", "call_b", "call_c"]), result("call_a", "a"), result("call_b", "b"), result("call_c", "c")]);
		expect(conversationMarks(request)).toEqual([[5, "message"]]);
	});

	it("a message after a tool result: on that user message", async () => {
		const request = await send([...run(1), { role: "user", content: "And now?", timestamp: 4 }]);
		expect(conversationMarks(request)).toEqual([[4, "part"]]);
	});

	it("at every step of a growing run the earlier mark's messages are a prefix of the next request", async () => {
		for (const text of [undefined, "Reading file"]) {
			const steps: Sent[] = [];
			for (let rounds = 0; rounds <= 3; rounds++) steps.push(await send(run(rounds, text)));
			for (let step = 1; step < steps.length; step++) {
				const [[mark]] = conversationMarks(steps[step - 1]);
				expect(mark).toBe(steps[step - 1].body.messages.length - 1);
				expect(upTo(steps[step], mark)).toBe(upTo(steps[step - 1], mark));
			}
			// A mark beside a result leaves every byte before it as the next request sends them.
			for (let step = 2; step < steps.length; step++) {
				const untilMark = steps[step - 1].raw.slice(0, steps[step - 1].raw.indexOf(',"cache_control"', steps[step - 1].raw.lastIndexOf('"role":"tool"')));
				expect(untilMark.endsWith(`"tool_call_id":"call_${step - 1}"`)).toBe(true);
				expect(steps[step].raw.startsWith(untilMark)).toBe(true);
			}
		}
	});
});

describe("openai-completions: how many marks a gateway request carries", () => {
	it("three, and never more than Anthropic's four, whatever the conversation", async () => {
		const conversations: Message[][] = [
			[QUESTION],
			run(3),
			run(3, "Reading file"),
			run(40),
			[QUESTION, calls(["call_a", "call_b"]), result("call_a", "a"), imageResult("call_b")],
			[QUESTION, calls(["call_a"])],
			[...run(1), { role: "user", content: "And now?", timestamp: 4 }],
		];
		for (const messages of conversations) {
			for (const model of [gatewayModel(), gatewayModel(CLAUDE, "openrouter"), gatewayModel(CLAUDE, "gateway-test", ["text", "image"])]) {
				const request = await send(messages, { model });
				expect(marks(request)).toBe(3);
			}
		}
	});

	it("none for a model without cacheControlFormat", async () => {
		for (const compat of [{}, null]) {
			const request = await send(run(3), { model: gatewayModel(compat) });
			expect(marks(request)).toBe(0);
		}
	});

	it('none with cacheRetention "none"', async () => {
		expect(marks(await send(run(3), { cacheRetention: "none" }))).toBe(0);
		expect(marks(await send(run(3)))).toBe(3);
	});
});

describe("openai-completions: messages that change how the mark is sent", () => {
	it("a tool result with an image: on the text part of the user message that carries the image", async () => {
		const request = await send([QUESTION, calls(["call_a"]), imageResult("call_a")], { model: gatewayModel(CLAUDE, "gateway-test", ["text", "image"]) });
		expect(request.body.messages[3]).toEqual({ role: "tool", content: "a picture", tool_call_id: "call_a" });
		expect(request.body.messages[4]).toEqual({
			role: "user",
			content: [
				{ type: "text", text: "Attached image(s) from tool result:", cache_control: MARK },
				{ type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
			],
		});
	});

	it("a tool result with an image for a model that takes none: on the result", async () => {
		const request = await send([QUESTION, calls(["call_a"]), imageResult("call_a")]);
		expect(request.body.messages[3]).toEqual({
			role: "tool",
			content: "a picture\n(tool image omitted: model does not support images)",
			tool_call_id: "call_a",
			cache_control: MARK,
		});
		expect(request.body.messages).toHaveLength(4);
	});

	// A conversation that ends on calls without results is sent a result for
	// each, so an assistant message with only calls is never the last one sent.
	it("calls without results: on the result sent in their place, the calls unmarked", async () => {
		const request = await send([QUESTION, calls(["call_a"])]);
		expect(request.body.messages.map((message) => message.role)).toEqual(["system", "user", "assistant", "tool"]);
		expect(request.body.messages[2]).not.toHaveProperty("cache_control");
		expect(conversationMarks(request)).toEqual([[3, "message"]]);
	});

	it("an answer as the newest message keeps its mark on its text", async () => {
		const answer = { ...calls([]), content: [{ type: "text" as const, text: "Done." }], stopReason: "stop" as const };
		const request = await send([...run(1), answer]);
		expect(request.body.messages[4]).toEqual({ role: "assistant", content: [{ type: "text", text: "Done.", cache_control: MARK }] });
		expect(conversationMarks(request)).toEqual([[4, "part"]]);
	});

	it("an empty tool result: on the placeholder sent for it", async () => {
		const request = await send([QUESTION, calls(["call_a"]), result("call_a", "")]);
		expect(request.body.messages[3]).toEqual({ role: "tool", content: "(see attached image)", tool_call_id: "call_a", cache_control: MARK });
	});

	it("a blank tool result: on the nearest earlier result or user message", async () => {
		const several = await send([QUESTION, calls(["call_a", "call_b"]), result("call_a", "a"), result("call_b", " \n ")]);
		expect(conversationMarks(several)).toEqual([[3, "message"]]);
		expect(several.body.messages[4]).toEqual({ role: "tool", content: " \n ", tool_call_id: "call_b" });
		const alone = await send([QUESTION, calls(["call_a"], "Reading."), result("call_a", " \n ")]);
		expect(conversationMarks(alone)).toEqual([[1, "part"]]);
	});

	it("a blank user message: on the nearest earlier result", async () => {
		for (const content of ["  ", [{ type: "text" as const, text: " " }]]) {
			const request = await send([...run(1), { role: "user", content, timestamp: 4 }]);
			expect(conversationMarks(request)).toEqual([[3, "message"]]);
		}
	});

	it("a user message with only an image: on the nearest earlier result", async () => {
		const messages: Message[] = [...run(1), { role: "user", content: [{ type: "image", data: "AAAA", mimeType: "image/png" }], timestamp: 4 }];
		const request = await send(messages, { model: gatewayModel(CLAUDE, "gateway-test", ["text", "image"]) });
		expect(request.body.messages[4].content).toEqual([{ type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } }]);
		expect(conversationMarks(request)).toEqual([[3, "message"]]);
	});

	it("a user message's blank last text: on the text before it", async () => {
		const content = ["Look at this.", " "].map((text) => ({ type: "text" as const, text }));
		const request = await send([{ role: "user", content, timestamp: 1 }]);
		expect(request.body.messages[1].content).toEqual([
			{ type: "text", text: "Look at this.", cache_control: MARK },
			{ type: "text", text: " " },
		]);
	});

	it("nothing that can carry a mark: no conversation mark", async () => {
		const request = await send([{ role: "user", content: " ", timestamp: 1 }]);
		expect(conversationMarks(request)).toEqual([]);
		expect(marks(request)).toBe(2);
	});

	it("OpenRouter: on the newest result's text part, the only place its schema has for it", async () => {
		const request = await send(run(3), { model: gatewayModel(CLAUDE, "openrouter") });
		expect(request.body.messages[7]).toEqual({ role: "tool", content: [{ type: "text", text: "contents of file 3", cache_control: MARK }], tool_call_id: "call_3" });
		expect(request.body.messages[5]).toEqual({ role: "tool", content: "contents of file 2", tool_call_id: "call_2" });
		expect(conversationMarks(request)).toEqual([[7, "part"]]);
	});

	it("OpenRouter: a blank result moves the mark to the result before it", async () => {
		const request = await send([QUESTION, calls(["call_a", "call_b"]), result("call_a", "a"), result("call_b", " ")], { model: gatewayModel(CLAUDE, "openrouter") });
		expect(request.body.messages[3]).toEqual({ role: "tool", content: [{ type: "text", text: "a", cache_control: MARK }], tool_call_id: "call_a" });
		expect(request.body.messages[4]).toEqual({ role: "tool", content: " ", tool_call_id: "call_b" });
	});
});
