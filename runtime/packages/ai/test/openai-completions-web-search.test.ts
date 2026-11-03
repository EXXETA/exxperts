import { describe, expect, it, vi } from "vitest";
import { getModel } from "../src/models.js";
import { streamSimple } from "../src/stream.js";
import type { AssistantMessage, AssistantMessageEvent } from "../src/types.js";

// A model that searches the web through its own provider is asked to by one
// field on the request, web_search_options. It is opt-in per model, because a
// gateway routes some deployments that offer it and some that do not, and
// sending it where it is not offered is an error on the whole request. These
// pin both directions: the flag put it there, and its absence keeps it out.

const CLOSING_CHUNK = {
	choices: [{ delta: {}, finish_reason: "stop" }],
	usage: {
		prompt_tokens: 1,
		completion_tokens: 1,
		prompt_tokens_details: { cached_tokens: 0 },
		completion_tokens_details: { reasoning_tokens: 0 },
	},
};

const mockState = vi.hoisted(() => ({
	lastParams: undefined as unknown,
	// The chunks the next request streams; empty means one closing chunk.
	chunks: [] as unknown[],
	// The connection drops after the chunks.
	cut: false,
}));

vi.mock("openai", () => {
	class FakeOpenAI {
		chat = {
			completions: {
				create: (params: unknown) => {
					mockState.lastParams = params;
					const stream = {
						async *[Symbol.asyncIterator]() {
							const { chunks, cut } = mockState;
							mockState.chunks = [];
							mockState.cut = false;
							if (chunks.length === 0) {
								yield {
									choices: [{ delta: {}, finish_reason: "stop" }],
									usage: {
										prompt_tokens: 1,
										completion_tokens: 1,
										prompt_tokens_details: { cached_tokens: 0 },
										completion_tokens_details: { reasoning_tokens: 0 },
									},
								};
							}
							for (const chunk of chunks) yield chunk;
							if (cut) throw new Error("connection lost");
						},
					};
					const promise = Promise.resolve(stream) as Promise<typeof stream> & {
						withResponse: () => Promise<{ data: typeof stream; response: { status: number; headers: Headers } }>;
					};
					promise.withResponse = async () => ({ data: stream, response: { status: 200, headers: new Headers() } });
					return promise;
				},
			},
		};
	}
	return { default: FakeOpenAI };
});

async function paramsFor(compat: Record<string, unknown> | undefined): Promise<Record<string, unknown>> {
	const { compat: _compat, ...baseModel } = getModel("openai", "gpt-4o-mini")!;
	const model = { ...baseModel, api: "openai-completions", ...(compat ? { compat } : {}) } as never;
	let payload: unknown;
	await streamSimple(
		model,
		{ messages: [{ role: "user", content: "What happened today?", timestamp: Date.now() }] },
		{ apiKey: "test", onPayload: (params: unknown) => { payload = params; } } as unknown as Parameters<typeof streamSimple>[2],
	).result();
	return (payload ?? mockState.lastParams) as Record<string, unknown>;
}

describe("openai-completions web search", () => {
	it("asks for provider search when the model declares it", async () => {
		// Exactly the compat block the gateway settings write into models.json.
		const params = await paramsFor({ supportsWebSearch: true });
		expect(params.web_search_options).toEqual({});
	});

	it("says nothing about search for a model that never declared it", async () => {
		expect(await paramsFor(undefined)).not.toHaveProperty("web_search_options");
		expect(await paramsFor({ supportsWebSearch: false })).not.toHaveProperty("web_search_options");
		// A model with an unrelated compat override must not pick it up by accident.
		expect(await paramsFor({ supportsStrictMode: false })).not.toHaveProperty("web_search_options");
	});
});

// A gateway puts the provider's sources on the answer as url_citation
// annotations, nested, with optional offsets: on a chunk's delta (the closing
// one, usually) or on a final message. Their offsets count code points in the
// message's raw text, markers included; the text block keeps them as
// JavaScript indexes into its stripped text.

const MARKER = "\ue200cite\ue202turn0search0\ue201";

function annotation(url: string, title: string, offsets?: { text: string; cited: string }) {
	if (!offsets) return { type: "url_citation", url_citation: { url, title } };
	const start = [...offsets.text.slice(0, offsets.text.indexOf(offsets.cited))].length;
	return { type: "url_citation", url_citation: { url, title, start_index: start, end_index: start + [...offsets.cited].length } };
}

function textChunk(content: string) {
	return { id: "chatcmpl-1", choices: [{ delta: { content }, finish_reason: null }] };
}

async function answer(chunks: unknown[], cut = false): Promise<{ message: AssistantMessage; events: AssistantMessageEvent[] }> {
	mockState.chunks = chunks;
	mockState.cut = cut;
	const { compat: _compat, ...baseModel } = getModel("openai", "gpt-4o-mini")!;
	const model = { ...baseModel, api: "openai-completions" } as never;
	const stream = streamSimple(
		model,
		{ messages: [{ role: "user", content: "What happened today?", timestamp: Date.now() }] },
		{ apiKey: "test" } as unknown as Parameters<typeof streamSimple>[2],
	);
	const events: AssistantMessageEvent[] = [];
	for await (const event of stream) events.push(structuredClone(event));
	return { message: await stream.result(), events };
}

function citedText(message: AssistantMessage, url: string): string | undefined {
	const block = message.content.find((b) => b.type === "text");
	const citation = block?.type === "text" ? block.citations?.find((c) => c.url === url) : undefined;
	return citation && block?.type === "text" ? block.text.slice(citation.start, citation.end) : undefined;
}

describe("openai-completions citations", () => {
	const raw = `Café 😀 Node 26 is out.${MARKER} Bun 2 too.`;

	it("keeps the closing chunk's delta annotations, without a search being asked for", async () => {
		const { message, events } = await answer([
			textChunk(raw.slice(0, 20)),
			textChunk(raw.slice(20)),
			{
				...CLOSING_CHUNK,
				choices: [
					{
						delta: {
							annotations: [
								annotation("https://nodejs.org", "Node.js", { text: raw, cited: "Node 26 is out." }),
								annotation("https://bun.sh", "Bun", { text: raw, cited: "Bun 2 too." }),
								annotation("javascript:alert(1)", "Nope", { text: raw, cited: "Bun" }),
							],
						},
						finish_reason: "stop",
					},
				],
			},
		]);

		expect(message.stopReason).toBe("stop");
		expect(message.content[0]).toMatchObject({ type: "text", text: "Café 😀 Node 26 is out. Bun 2 too." });
		expect(citedText(message, "https://nodejs.org")).toBe("Node 26 is out.");
		expect(citedText(message, "https://bun.sh")).toBe("Bun 2 too.");
		const block = message.content[0];
		expect(block.type === "text" && block.citations?.length).toBe(2);
		// They land before the block's end is said.
		const textEnd = events.find((event) => event.type === "text_end");
		expect(textEnd?.type === "text_end" && textEnd.partial.content[0]).toMatchObject({ citations: [{ url: "https://nodejs.org" }, { url: "https://bun.sh" }] });
	});

	it("reads a final message's annotations, and keeps one without offsets as a source of the answer", async () => {
		const { message } = await answer([
			textChunk(raw),
			{
				...CLOSING_CHUNK,
				choices: [
					{
						finish_reason: "stop",
						message: {
							role: "assistant",
							content: raw,
							annotations: [annotation("https://nodejs.org", "Node.js", { text: raw, cited: "Node 26 is out." }), annotation("https://exa.ai/result", "Exa result")],
						},
					},
				],
			},
		]);

		expect(citedText(message, "https://nodejs.org")).toBe("Node 26 is out.");
		expect(message.sources).toEqual([{ url: "https://exa.ai/result", title: "Exa result" }]);
	});

	it("places an annotation that comes before the text it cites", async () => {
		const early = { id: "chatcmpl-1", choices: [{ delta: { annotations: [annotation("https://nodejs.org", "Node.js", { text: raw, cited: "Node 26 is out." })] }, finish_reason: null }] };
		for (const chunks of [[early, textChunk(raw), CLOSING_CHUNK], [textChunk("Café"), early, textChunk(raw.slice(4)), CLOSING_CHUNK]]) {
			const { message } = await answer(chunks);
			expect(citedText(message, "https://nodejs.org")).toBe("Node 26 is out.");
			expect(message.sources).toBeUndefined();
		}
	});

	it("keeps the citations at the right end on the error message of a cut stream", async () => {
		const { message } = await answer(
			[
				textChunk(raw),
				{ id: "chatcmpl-1", choices: [{ delta: { annotations: [annotation("https://nodejs.org", "Node.js", { text: raw, cited: "Node 26 is out." })] }, finish_reason: null }] },
			],
			true,
		);

		expect(message.stopReason).toBe("error");
		expect(citedText(message, "https://nodejs.org")).toBe("Node 26 is out.");

		const early = { id: "chatcmpl-1", choices: [{ delta: { annotations: [annotation("https://nodejs.org", "Node.js", { text: raw, cited: "Node 26 is out." })] }, finish_reason: null }] };
		const { message: cutAfterEarly } = await answer([early, textChunk(raw)], true);
		expect(cutAfterEarly.stopReason).toBe("error");
		expect(citedText(cutAfterEarly, "https://nodejs.org")).toBe("Node 26 is out.");
	});

	it("sends neither citations nor sources back to the gateway", async () => {
		const { compat: _compat, ...baseModel } = getModel("openai", "gpt-4o-mini")!;
		const model = { ...baseModel, api: "openai-completions" } as never;
		const cited: AssistantMessage = {
			role: "assistant",
			content: [{ type: "text", text: "Node 26 is out.", citations: [{ url: "https://cited.example/a", start: 0, end: 4 }] }],
			sources: [{ url: "https://source.example/b" }],
			api: "openai-completions",
			provider: "openai",
			model: "gpt-4o-mini",
			usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
			stopReason: "stop",
			timestamp: Date.now(),
		};
		let payload: unknown;
		await streamSimple(
			model,
			{ messages: [{ role: "user", content: "News?", timestamp: 1 }, cited, { role: "user", content: "Thanks", timestamp: 2 }] },
			{ apiKey: "test", onPayload: (params: unknown) => { payload = params; } } as unknown as Parameters<typeof streamSimple>[2],
		).result();
		const sent = JSON.stringify(payload);
		expect(sent).toContain("Node 26 is out.");
		expect(sent).not.toContain("cited.example");
		expect(sent).not.toContain("source.example");
	});
});
