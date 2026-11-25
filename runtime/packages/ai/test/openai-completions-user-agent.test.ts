import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import rootPackage from "../../../../package.json" with { type: "json" };
import { getModels } from "../src/models.js";
import type { streamOpenAICompletions as Stream } from "../src/providers/openai-completions.js";
import type { Model } from "../src/types.js";

// The name a gateway sees on each request: exxperts and its version, unless
// the model or the call brings its own. Each row reads the header that arrived
// at a gateway on this machine.

const received: Array<string | undefined> = [];
let server: http.Server;
let baseUrl = "";
const startedAs = process.argv[1];
let streamOpenAICompletions: typeof Stream;

beforeAll(async () => {
	server = http.createServer((req, res) => {
		received.push(req.headers["user-agent"]);
		req.resume();
		req.on("end", () => {
			res.writeHead(200, { "content-type": "text/event-stream" });
			const chunk = { id: "chatcmpl-test", object: "chat.completion.chunk", created: 0, model: "test", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] };
			res.end(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`);
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
});

afterAll(() => {
	server.close();
	process.argv[1] = startedAs;
});

// The version is read once per process, so each row loads the provider anew.
beforeEach(async () => {
	received.length = 0;
	process.argv[1] = startedAs;
	vi.resetModules();
	({ streamOpenAICompletions } = await import("../src/providers/openai-completions.js"));
});

async function seenWith(model: Partial<Model<"openai-completions">> = {}, headers?: Record<string, string>): Promise<string | undefined> {
	const gateway: Model<"openai-completions"> = {
		id: "bedrock/eu.anthropic.claude-opus-5-5",
		name: "Gateway test",
		api: "openai-completions",
		provider: "gateway-test",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200000,
		maxTokens: 8192,
		...model,
		baseUrl,
	};
	await streamOpenAICompletions(gateway, { messages: [{ role: "user", content: "Hello", timestamp: 1 }] }, { apiKey: "test-key", headers }).result();
	return received[0];
}

describe("openai-completions: the name a gateway sees", () => {
	it("is exxperts and the product's version", async () => {
		expect(rootPackage.version).toMatch(/^\d+\.\d+\.\d+/);
		expect(await seenWith()).toBe(`exxperts/${rootPackage.version}`);
	});

	it("is the model's own when the model sets one, in any letter case", async () => {
		expect(await seenWith({ headers: { "User-Agent": "ModelClient/1.0" } })).toBe("ModelClient/1.0");
		received.length = 0;
		expect(await seenWith({ headers: { "user-agent": "ModelClient/1.0" } })).toBe("ModelClient/1.0");
	});

	it("is GitHub Copilot's for a Copilot model", async () => {
		const copilot = getModels("github-copilot").find((model) => model.api === "openai-completions");
		expect(await seenWith({ provider: "github-copilot", headers: copilot?.headers })).toBe("GitHubCopilotChat/0.35.0");
	});

	it("is the call's own when the call sets one, in any letter case, over the model's", async () => {
		expect(await seenWith({}, { "User-Agent": "CallClient/2.0" })).toBe("CallClient/2.0");
		received.length = 0;
		expect(await seenWith({ headers: { "User-Agent": "ModelClient/1.0" } }, { "user-agent": "CallClient/2.0" })).toBe("CallClient/2.0");
	});

	it("keeps exxperts' name beside other headers of the model and the call", async () => {
		expect(await seenWith({ headers: { "X-Team": "a" } }, { "X-Task": "b" })).toBe(`exxperts/${rootPackage.version}`);
	});

	it("is exxperts alone when the started program is in no exxperts install", async () => {
		const folder = mkdtempSync(join(tmpdir(), "exxperts-user-agent-"));
		try {
			writeFileSync(join(folder, "package.json"), '{"name":"another-app","version":"9.9.9"}');
			process.argv[1] = join(folder, "server.mjs");
			expect(await seenWith()).toBe("exxperts");
		} finally {
			rmSync(folder, { recursive: true, force: true });
		}
	});
});
