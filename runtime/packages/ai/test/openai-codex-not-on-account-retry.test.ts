import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { codexModelNotOnAccount, streamOpenAICodexResponses } from "../src/providers/openai-codex-responses.js";
import type { Context, Model } from "../src/types.js";

// ChatGPT refusing a model for this account is answered once: asking again
// cannot change it. Every other failure keeps its retries.

const originalFetch = global.fetch;
const originalAgentDir = process.env.PI_CODING_AGENT_DIR;

afterEach(() => {
	global.fetch = originalFetch;
	if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
	vi.restoreAllMocks();
});

const WORDS = "The 'gpt-6.1-sol' model is not supported when using Codex with a ChatGPT account.";
const RESPONSES_URL = "https://chatgpt.com/backend-api/codex/responses";

function mockToken(): string {
	const payload = Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acc_test" } }), "utf8").toString("base64");
	return `aaa.${payload}.bbb`;
}

function completedStream(): ReadableStream<Uint8Array> {
	const events = [
		{ type: "response.output_item.added", item: { type: "message", id: "msg_1", role: "assistant", status: "in_progress", content: [] } },
		{ type: "response.content_part.added", part: { type: "output_text", text: "" } },
		{ type: "response.output_text.delta", delta: "Hello" },
		{ type: "response.output_item.done", item: { type: "message", id: "msg_1", role: "assistant", status: "completed", content: [{ type: "output_text", text: "Hello" }] } },
		{ type: "response.completed", response: { status: "completed", usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8, input_tokens_details: { cached_tokens: 0 } } } },
	];
	const body = `${events.map((event) => `data: ${JSON.stringify(event)}`).join("\n\n")}\n\n`;
	return new ReadableStream<Uint8Array>({
		start(controller) {
			controller.enqueue(new TextEncoder().encode(body));
			controller.close();
		},
	});
}

const model: Model<"openai-codex-responses"> = {
	id: "gpt-6.1-sol",
	name: "GPT-6.1 Sol",
	api: "openai-codex-responses",
	provider: "openai-codex",
	baseUrl: "https://chatgpt.com/backend-api",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 400000,
	maxTokens: 128000,
};

const context: Context = { messages: [{ role: "user", content: "Say hello", timestamp: Date.now() }] };

/** The backend answers each request to the responses endpoint with the next of these; the count is the requests made. */
function backend(answers: Array<() => Response>): { requests: () => number } {
	let requests = 0;
	global.fetch = vi.fn(async (input: string | URL) => {
		const url = typeof input === "string" ? input : input.toString();
		if (url !== RESPONSES_URL) return new Response("not found", { status: 404 });
		const answer = answers[Math.min(requests, answers.length - 1)]!;
		requests += 1;
		return answer();
	}) as typeof fetch;
	return { requests: () => requests };
}

async function run() {
	process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), "pi-codex-not-on-account-"));
	return streamOpenAICodexResponses(model, context, { apiKey: mockToken(), transport: "sse" }).result();
}

describe("openai-codex not-on-account refusal", () => {
	it("matches only the refusal's words", () => {
		expect(codexModelNotOnAccount(WORDS)).toBe(true);
		expect(codexModelNotOnAccount("the 'gpt-5.4' MODEL IS NOT SUPPORTED WHEN USING CODEX WITH A CHATGPT ACCOUNT")).toBe(true);
		expect(codexModelNotOnAccount("Unsupported parameter: 'temperature' is not supported with this model.")).toBe(false);
		expect(codexModelNotOnAccount("Selected model is at capacity. Please try a different model.")).toBe(false);
	});

	for (const [shape, body] of [
		["detail", { detail: WORDS }],
		["error", { type: "error", status: 400, error: { type: "invalid_request_error", message: WORDS } }],
	] as const) {
		it(`makes one request for the refusal in a ${shape} body`, async () => {
			const fake = backend([() => new Response(JSON.stringify(body), { status: 400, headers: { "content-type": "application/json" } })]);
			const result = await run();
			expect(result.stopReason).toBe("error");
			expect(result.errorMessage).toBe(WORDS);
			expect(fake.requests()).toBe(1);
		});
	}

	for (const [label, status, text] of [
		["a 500", 500, "upstream failed"],
		["a 429", 429, JSON.stringify({ error: { type: "rate_limit_error", message: "Slow down." } })],
		["another 400", 400, JSON.stringify({ detail: "Unsupported parameter: 'temperature' is not supported with this model." })],
	] as const) {
		it(`still retries ${label}`, async () => {
			const fake = backend([
				() => new Response(text, { status }),
				() => new Response(completedStream(), { status: 200, headers: { "content-type": "text/event-stream" } }),
			]);
			const result = await run();
			expect(result.stopReason).toBe("stop");
			expect(fake.requests()).toBe(2);
		});
	}
});
