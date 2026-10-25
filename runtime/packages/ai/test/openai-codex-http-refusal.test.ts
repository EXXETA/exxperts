import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { streamOpenAICodexResponses } from "../src/providers/openai-codex-responses.js";
import type { Context, Model } from "../src/types.js";

// A refused credential (401) or a refused request (403) is answered once:
// asking again cannot change it. A usage limit keeps its reset time.

const originalFetch = global.fetch;
const originalAgentDir = process.env.PI_CODING_AGENT_DIR;

afterEach(() => {
	global.fetch = originalFetch;
	if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
	vi.restoreAllMocks();
});

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
	process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), "pi-codex-http-refusal-"));
	return streamOpenAICodexResponses(model, context, { apiKey: mockToken(), transport: "sse" }).result();
}

describe("openai-codex refusals that asking again cannot change", () => {
	for (const [label, status, text] of [
		["a 401", 401, JSON.stringify({ error: { type: "invalid_request_error", code: "invalid_api_key", message: "Your authentication token has expired." } })],
		["a 403", 403, JSON.stringify({ error: { type: "request_forbidden", code: "unsupported_country_region_territory", message: "Country, region, or territory not supported" } })],
	] as const) {
		it(`makes one request for ${label}`, async () => {
			const fake = backend([() => new Response(text, { status, headers: { "content-type": "application/json" } })]);
			const result = await run();
			expect(result.stopReason).toBe("error");
			expect(fake.requests()).toBe(1);
		}, 20_000);
	}

	it("keeps a usage limit's reset time in its words, and asks once", async () => {
		const resetsAt = Math.round(Date.now() / 1000) + 158 * 60;
		const fake = backend([() => new Response(JSON.stringify({ error: { type: "usage_limit_reached", message: "The usage limit has been reached", plan_type: "plus", resets_at: resetsAt } }), { status: 429, headers: { "content-type": "application/json" } })]);
		const result = await run();
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toMatch(/^You have hit your ChatGPT usage limit \(plus plan\)\. Try again in ~15[78] min\.$/);
		expect(fake.requests()).toBe(1);
	}, 20_000);

	it("keeps a short rate limit's own words and wait, not a usage limit", async () => {
		const words = "Rate limit reached for gpt-6.1-sol on tokens per min (TPM): Limit 30000, Used 29000. Please try again in 20s.";
		backend([() => new Response(JSON.stringify({ error: { type: "tokens", code: "rate_limit_exceeded", message: words } }), { status: 429, headers: { "content-type": "application/json" } })]);
		const result = await run();
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toBe(words);
	}, 20_000);
});
