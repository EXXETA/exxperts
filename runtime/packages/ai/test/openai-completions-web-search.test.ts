import { describe, expect, it, vi } from "vitest";
import { getModel } from "../src/models.js";
import { streamSimple } from "../src/stream.js";

// A model that searches the web through its own provider is asked to by one
// field on the request, web_search_options. It is opt-in per model, because a
// gateway routes some deployments that offer it and some that do not, and
// sending it where it is not offered is an error on the whole request. These
// pin both directions: the flag put it there, and its absence keeps it out.

const mockState = vi.hoisted(() => ({ lastParams: undefined as unknown }));

vi.mock("openai", () => {
	class FakeOpenAI {
		chat = {
			completions: {
				create: (params: unknown) => {
					mockState.lastParams = params;
					const stream = {
						async *[Symbol.asyncIterator]() {
							yield {
								choices: [{ delta: {}, finish_reason: "stop" }],
								usage: {
									prompt_tokens: 1,
									completion_tokens: 1,
									prompt_tokens_details: { cached_tokens: 0 },
									completion_tokens_details: { reasoning_tokens: 0 },
								},
							};
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
