import type { ResponseStreamEvent } from "openai/resources/responses/responses.js";
import { describe, expect, it } from "vitest";
import { getModel } from "../src/models.js";
import { convertResponsesMessages, processResponsesStream } from "../src/providers/openai-responses-shared.js";
import { transformMessages } from "../src/providers/transform-messages.js";
import type { AssistantMessage, AssistantMessageEvent } from "../src/types.js";
import { AssistantMessageEventStream } from "../src/utils/event-stream.js";

// One parser reads every Responses stream (API key, Azure, ChatGPT sign-in).
// A message's output_text parts carry url_citation annotations: streamed one
// by one as annotation.added, then all of them on the finished item. Their
// indexes count in the part's raw text, markers included; the block keeps
// them as JavaScript indexes into its stripped text.

const model = getModel("openai", "gpt-4.1")!;
const MARKER = "citeturn0search0";

function emptyMessage(): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

type Annotation = { type: "url_citation"; url: string; title: string; start_index?: number; end_index?: number };

function cite(text: string, cited: string, url: string, title = "Page"): Annotation {
	const start = [...text.slice(0, text.indexOf(cited))].length;
	return { type: "url_citation", url, title, start_index: start, end_index: start + [...cited].length };
}

/** A message item streamed in `deltas`, its annotations added as they come, then finished with `finalAnnotations`. */
function messageEvents(deltas: string[], streamed: Annotation[], finalAnnotations: Annotation[], finish = true): ResponseStreamEvent[] {
	const text = deltas.join("");
	const events: unknown[] = [
		{ type: "response.created", response: { id: "resp_1" } },
		{ type: "response.output_item.added", output_index: 0, item: { type: "message", id: "msg_1", role: "assistant", status: "in_progress", content: [] } },
		{ type: "response.content_part.added", output_index: 0, content_index: 0, item_id: "msg_1", part: { type: "output_text", text: "", annotations: [] } },
		...deltas.map((delta) => ({ type: "response.output_text.delta", output_index: 0, content_index: 0, item_id: "msg_1", delta })),
		...streamed.map((annotation, index) => ({ type: "response.output_text.annotation.added", output_index: 0, content_index: 0, annotation_index: index, item_id: "msg_1", annotation })),
	];
	if (finish) {
		events.push(
			{ type: "response.output_item.done", output_index: 0, item: { type: "message", id: "msg_1", role: "assistant", status: "completed", content: [{ type: "output_text", text, annotations: finalAnnotations }] } },
			{ type: "response.completed", response: { id: "resp_1", status: "completed", usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2, input_tokens_details: { cached_tokens: 0 } } } },
		);
	}
	return events as ResponseStreamEvent[];
}

async function* feed(events: ResponseStreamEvent[], failAtEnd = false): AsyncGenerator<ResponseStreamEvent> {
	for (const event of events) yield event;
	if (failAtEnd) throw new Error("connection lost");
}

async function run(events: ResponseStreamEvent[], failAtEnd = false): Promise<{ output: AssistantMessage; events: AssistantMessageEvent[]; failed: boolean }> {
	const output = emptyMessage();
	const stream = new AssistantMessageEventStream();
	const seen: AssistantMessageEvent[] = [];
	let failed = false;
	try {
		await processResponsesStream(feed(events, failAtEnd), output, stream, model);
	} catch {
		// The callers end the stream with this same output as the error message.
		failed = true;
	}
	stream.end();
	for await (const event of stream) seen.push(structuredClone(event));
	return { output, events: seen, failed };
}

function cited(output: AssistantMessage, url: string): string {
	const block = output.content[0];
	if (block.type !== "text") throw new Error("no text block");
	const citation = block.citations?.find((c) => c.url === url);
	if (!citation) throw new Error(`no citation for ${url}`);
	return block.text.slice(citation.start, citation.end);
}

describe("openai responses citations", () => {
	it("places a citation on text without markers", async () => {
		const text = "Node 26 is out. Bun 2 too.";
		const node = cite(text, "Node 26 is out.", "https://nodejs.org", "Node.js");
		const { output, events } = await run(messageEvents(["Node 26 is ", "out. Bun 2 too."], [node], [node]));

		const block = output.content[0];
		expect(block).toMatchObject({ type: "text", text, citations: [{ url: "https://nodejs.org", title: "Node.js", start: 0, end: 15 }] });
		expect(cited(output, "https://nodejs.org")).toBe("Node 26 is out.");
		const textEnd = events.find((event) => event.type === "text_end");
		expect(textEnd?.type === "text_end" && textEnd.partial.content[0]).toMatchObject({ citations: [{ url: "https://nodejs.org" }] });
	});

	it("counts past the markers it strips and an emoji before the point", async () => {
		const raw = `Café 😀 Node 26 is out.${MARKER} Bun 2 too.${MARKER}`;
		const node = cite(raw, "Node 26 is out.", "https://nodejs.org");
		const bun = cite(raw, "Bun 2 too.", "https://bun.sh");
		// The marker is split across deltas, as the stream filter has to handle.
		const { output } = await run(messageEvents([raw.slice(0, 26), raw.slice(26)], [node, bun], [node, bun]));

		expect(output.content[0]).toMatchObject({ text: "Café 😀 Node 26 is out. Bun 2 too." });
		expect(cited(output, "https://nodejs.org")).toBe("Node 26 is out.");
		expect(cited(output, "https://bun.sh")).toBe("Bun 2 too.");
	});

	it("lets the finished item's list replace the streamed one, without duplicates", async () => {
		const text = "Node 26 is out. Bun 2 too.";
		const node = cite(text, "Node 26 is out.", "https://nodejs.org");
		const bun = cite(text, "Bun 2 too.", "https://bun.sh");
		const dropped = cite(text, "Node", "https://dropped.example");
		const { output } = await run(messageEvents([text], [node, node, dropped], [node, bun, bun]));

		const block = output.content[0];
		expect(block.type === "text" && block.citations?.map((c) => c.url)).toEqual(["https://nodejs.org", "https://bun.sh"]);
	});

	it("replaces the streamed sources too, when the finished item lists only a loose one", async () => {
		const text = "Node 26 is out.";
		const node = cite(text, "Node 26 is out.", "https://nodejs.org");
		const streamedLoose: Annotation = { type: "url_citation", url: "https://streamed.example", title: "Streamed" };
		const finalLoose: Annotation = { type: "url_citation", url: "https://nodejs.org/about", title: "About" };
		const { output } = await run(messageEvents([text], [node, streamedLoose], [finalLoose]));

		expect(output.content[0]).not.toHaveProperty("citations");
		expect(output.sources).toEqual([{ url: "https://nodejs.org/about", title: "About" }]);
	});

	it("lets an explicitly empty final list clear what streamed, and keeps it when the list is left out", async () => {
		const text = "Node 26 is out.";
		const node = cite(text, "Node 26 is out.", "https://nodejs.org");
		const loose: Annotation = { type: "url_citation", url: "https://streamed.example", title: "Streamed" };
		const { output: cleared } = await run(messageEvents([text], [node, loose], []));
		expect(cleared.content[0]).not.toHaveProperty("citations");
		expect(cleared).not.toHaveProperty("sources");

		const events = messageEvents([text], [node], [], false) as unknown[];
		events.push({ type: "response.output_item.done", output_index: 0, item: { type: "message", id: "msg_1", role: "assistant", status: "completed", content: [{ type: "output_text", text }] } });
		const { output: kept } = await run(events as ResponseStreamEvent[]);
		expect(cited(kept, "https://nodejs.org")).toBe("Node 26 is out.");
	});

	it("places a citation in a later part when a marker runs across the parts", async () => {
		const parts = ["Hello\ue200cite", "\ue201 world"];
		const world = { type: "url_citation" as const, url: "https://world.example", title: "World", start_index: 2, end_index: 7 };
		const events = messageEvents([], [], [], false) as unknown[];
		events.push(
			{ type: "response.output_item.done", output_index: 0, item: { type: "message", id: "msg_1", role: "assistant", status: "completed", content: [{ type: "output_text", text: parts[0], annotations: [] }, { type: "output_text", text: parts[1], annotations: [world] }] } },
		);
		const { output } = await run(events as ResponseStreamEvent[]);

		expect(output.content[0]).toMatchObject({ text: "Hello world" });
		expect(cited(output, "https://world.example")).toBe("world");
	});

	it("counts past a stray marker start as the final text does", async () => {
		const raw = "A\ue200Node 26 is out.";
		const node = cite(raw, "Node 26 is out.", "https://nodejs.org");
		const { output } = await run(messageEvents([raw], [], [node]));

		expect(output.content[0]).toMatchObject({ text: "ANode 26 is out." });
		expect(cited(output, "https://nodejs.org")).toBe("Node 26 is out.");
	});

	it("keeps an annotation without an index, and only web pages", async () => {
		const text = "Node 26 is out.";
		const loose: Annotation = { type: "url_citation", url: "https://nodejs.org/about", title: "About" };
		const file = { ...cite(text, "Node", "file:///etc/hosts") };
		const { output } = await run(messageEvents([text], [], [loose, file]));

		expect(output.content[0]).not.toHaveProperty("citations");
		expect(output.sources).toEqual([{ url: "https://nodejs.org/about", title: "About" }]);
	});

	it("keeps the streamed citations at the right end when the stream is cut before the item finishes", async () => {
		const raw = `é 😀 Node 26 is out.${MARKER} And more`;
		const node = cite(raw, "Node 26 is out.", "https://nodejs.org");
		const { output, failed } = await run(messageEvents([raw], [node], [], false), true);

		expect(failed).toBe(true);
		expect(output.content[0]).toMatchObject({ type: "text", text: "é 😀 Node 26 is out. And more" });
		expect(cited(output, "https://nodejs.org")).toBe("Node 26 is out.");
	});

	it("sends neither citations nor sources back, nor into another model's copy", async () => {
		const message: AssistantMessage = {
			...emptyMessage(),
			content: [{ type: "text", text: "Node 26 is out.", citations: [{ url: "https://cited.example/a", start: 0, end: 4 }] }],
			sources: [{ url: "https://source.example/b" }],
		};
		const context = { messages: [{ role: "user" as const, content: "News?", timestamp: 1 }, message] };
		const sent = JSON.stringify(convertResponsesMessages(model, context, new Set([model.provider])));
		expect(sent).not.toContain("cited.example");
		expect(sent).not.toContain("source.example");

		const other = getModel("anthropic", "claude-haiku-4-5")!;
		const copy = transformMessages(context.messages, other);
		expect((copy[1] as AssistantMessage).content).toEqual([{ type: "text", text: "Node 26 is out." }]);
		expect(copy[1]).not.toHaveProperty("sources");
	});
});
