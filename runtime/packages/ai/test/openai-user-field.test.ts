import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { getModel } from "../src/models.js";
import { streamSimpleAnthropic } from "../src/providers/anthropic.js";
import { streamSimpleAzureOpenAIResponses } from "../src/providers/azure-openai-responses.js";
import { streamSimpleOpenAICompletions } from "../src/providers/openai-completions.js";
import { streamSimpleOpenAIResponses } from "../src/providers/openai-responses.js";
import type { Context, Model, SimpleStreamOptions } from "../src/types.js";

// The person a call names reaches the provider's own field: `user` for the
// OpenAI-style three, `metadata.user_id` for Anthropic. Each request is read
// where it lands, a local server that records the body and refuses the call.
// The simple stream functions are the ones a session's calls go through.

const context: Context = {
	systemPrompt: "You are a helpful assistant.",
	messages: [{ role: "user", content: "Hello", timestamp: Date.now() }],
};

const azureBaseUrl = process.env.AZURE_OPENAI_BASE_URL;
let server: http.Server;
let baseUrl = "";
let bodies: Record<string, unknown>[] = [];

beforeAll(async () => {
	server = http.createServer((req, res) => {
		let raw = "";
		req.on("data", (chunk) => {
			raw += chunk;
		});
		req.on("end", () => {
			bodies.push(JSON.parse(raw));
			res.writeHead(400, { "content-type": "application/json" });
			res.end(JSON.stringify({ error: { message: "refused by the test server", type: "invalid_request_error" } }));
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
	if (azureBaseUrl === undefined) delete process.env.AZURE_OPENAI_BASE_URL;
	else process.env.AZURE_OPENAI_BASE_URL = azureBaseUrl;
	await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
	bodies = [];
});

type Send = (options: SimpleStreamOptions) => Promise<unknown>;

const providers: Record<string, Send> = {
	"openai-completions": (options) =>
		streamSimpleOpenAICompletions({ ...getModel("openai", "gpt-4o-mini"), api: "openai-completions", baseUrl: `${baseUrl}/v1` }, context, options).result(),
	"openai-responses": (options) =>
		streamSimpleOpenAIResponses({ ...getModel("openai", "gpt-4o-mini"), baseUrl: `${baseUrl}/v1` }, context, options).result(),
	"azure-openai-responses": (options) => {
		process.env.AZURE_OPENAI_BASE_URL = baseUrl;
		return streamSimpleAzureOpenAIResponses(getModel("azure-openai-responses", "gpt-4o-mini"), context, options).result();
	},
};

async function sentBody(send: Send, metadata: Record<string, unknown> | undefined): Promise<Record<string, unknown>> {
	await send({ apiKey: "test-key", maxRetries: 0, ...(metadata ? { metadata } : {}) });
	expect(bodies).toHaveLength(1);
	return bodies[0];
}

describe.each(Object.keys(providers))("%s sends the person as user", (name) => {
	const send = providers[name];

	it("puts user from metadata.user_id", async () => {
		const body = await sentBody(send, { user_id: "person-7f3a" });
		expect(body.user).toBe("person-7f3a");
	});

	it("sends no user without metadata", async () => {
		const body = await sentBody(send, undefined);
		expect("user" in body).toBe(false);
	});

	it("sends no user for an empty user_id", async () => {
		const body = await sentBody(send, { user_id: "" });
		expect("user" in body).toBe(false);
	});

	it("sends no user for a user_id that is not a string", async () => {
		const body = await sentBody(send, { user_id: 42 });
		expect("user" in body).toBe(false);
	});

	it("sends no metadata field of its own", async () => {
		const body = await sentBody(send, { user_id: "person-7f3a" });
		expect("metadata" in body).toBe(false);
	});
});

// A provider the completions file treats as non-standard is not sent `user`,
// since nobody has seen what it does with the field. The base URL rows put the
// host a provider is detected by in the path, so the call still lands here.
describe("openai-completions sends user only to a provider known to take it", () => {
	const person = { user_id: "person-7f3a" };
	const completions =
		(fields: Partial<Model<"openai-completions">>, path = "/v1"): Send =>
		(options) =>
			streamSimpleOpenAICompletions(
				{ ...getModel("openai", "gpt-4o-mini"), api: "openai-completions", baseUrl: `${baseUrl}${path}`, ...fields },
				context,
				options,
			).result();

	it.each([
		"cerebras",
		"xai",
		"together",
		"zai",
		"moonshotai",
		"moonshotai-cn",
		"opencode",
		"cloudflare-workers-ai",
		"cloudflare-ai-gateway",
	])("sends no user to provider %s", async (provider) => {
		const body = await sentBody(completions({ provider }), person);
		expect("user" in body).toBe(false);
		expect("store" in body).toBe(false);
	});

	it.each([
		"/api.cerebras.ai/v1",
		"/api.x.ai/v1",
		"/api.together.ai/v1",
		"/api.together.xyz/v1",
		"/llm.chutes.ai/v1",
		"/api.deepseek.com/v1",
		"/api.z.ai/api/paas/v4",
		"/api.moonshot.ai/v1",
		"/opencode.ai/zen/v1",
		"/api.cloudflare.com/client/v4/accounts/a/ai/v1",
		"/gateway.ai.cloudflare.com/v1/a/g/compat",
	])("sends no user to base URL %s", async (path) => {
		const body = await sentBody(completions({ provider: "custom" }, path), person);
		expect("user" in body).toBe(false);
		expect("store" in body).toBe(false);
	});

	it("sends user to a standard provider by its own id", async () => {
		const body = await sentBody(completions({ provider: "openrouter" }), person);
		expect(body.user).toBe("person-7f3a");
	});

	it("sends user to an unknown gateway", async () => {
		const body = await sentBody(completions({ provider: "company-gateway" }, "/llm-gateway.example.com/v1"), person);
		expect(body.user).toBe("person-7f3a");
	});

	it("sends user to a non-standard provider whose model sets supportsUser", async () => {
		const body = await sentBody(completions({ provider: "xai", compat: { supportsUser: true } }), person);
		expect(body.user).toBe("person-7f3a");
		expect("store" in body).toBe(false);
	});

	it("sends no user to a standard provider whose model turns supportsUser off", async () => {
		const body = await sentBody(completions({ provider: "openai", compat: { supportsUser: false } }), person);
		expect("user" in body).toBe(false);
		expect(body.store).toBe(false);
	});

	it("sends no user to a model whose compat sets only supportsStore off", async () => {
		const body = await sentBody(completions({ provider: "openai", compat: { supportsStore: false } }), person);
		expect("user" in body).toBe(false);
	});

	it("sends user to a model that turns supportsStore off and supportsUser on", async () => {
		const body = await sentBody(
			completions({ provider: "openai", compat: { supportsStore: false, supportsUser: true } }),
			person,
		);
		expect(body.user).toBe("person-7f3a");
		expect("store" in body).toBe(false);
	});

	it.each([
		["github-copilot", "claude-fable-5.1"],
		["together", "MiniMaxAI/MiniMax-M3"],
		["moonshotai", "kimi-k2.7-code"],
	] as const)("sends no user to the %s model %s as listed", async (provider, id) => {
		const listed = getModel(provider, id as never) as Model<"openai-completions">;
		const send: Send = (options) =>
			streamSimpleOpenAICompletions({ ...listed, baseUrl: `${baseUrl}/v1` }, context, options).result();
		const body = await sentBody(send, person);
		expect("user" in body).toBe(false);
	});
});

describe("anthropic keeps metadata.user_id", () => {
	const send: Send = (options) => streamSimpleAnthropic({ ...getModel("anthropic", "claude-haiku-4-5"), baseUrl }, context, options).result();

	it("sends metadata.user_id and no user", async () => {
		const body = await sentBody(send, { user_id: "person-7f3a" });
		expect(body.metadata).toEqual({ user_id: "person-7f3a" });
		expect("user" in body).toBe(false);
	});

	it("sends no metadata without one", async () => {
		const body = await sentBody(send, undefined);
		expect("metadata" in body).toBe(false);
	});
});
