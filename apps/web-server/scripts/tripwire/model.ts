// The model for the tripwire's runs: an OpenAI-compatible gateway on this
// computer. Each leg of a turn makes its scripted tool calls, then it answers in
// words. It keeps every tool a session offered and every tool it called, for
// the run's check that each offered tool was called or named.
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";

export type Call = { name: string; args: Record<string, unknown> };
/** A leg's calls, or what makes them from the results so far in this turn. */
export type Leg = Call[] | ((results: string[]) => Call[]);

export const MODEL = { provider: "openai-compatible", model: "room-model" };

export interface Gateway {
	/** The legs the next turn makes, in order. A request with no tools offered (a summary, a title) answers in words. */
	script(legs: Leg[]): void;
	/** What each call of the current turn gave back, in order. */
	results(): string[];
	offered: Set<string>;
	called: Set<string>;
	close(): void;
}

const sse = (payload: unknown): string => `data: ${JSON.stringify(payload)}\n\n`;

export async function startGateway(agentDir: string, appRoot: string): Promise<Gateway> {
	let legs: Leg[] = [];
	let toolResults: string[] = [];
	const offered = new Set<string>();
	const called = new Set<string>();
	const server = http.createServer((req, res) => {
		let body = "";
		req.on("data", (chunk) => { body += chunk; });
		req.on("end", () => {
			const parsed = JSON.parse(body || "{}");
			const tools: any[] = parsed.tools ?? [];
			for (const tool of tools) offered.add(String(tool?.function?.name ?? tool?.name));
			const messages: any[] = Array.isArray(parsed.messages) ? parsed.messages : [];
			const sinceUser = messages.slice(messages.map((message) => message?.role).lastIndexOf("user") + 1);
			if (tools.length > 0) toolResults = sinceUser.filter((message) => message?.role === "tool").map((message) => (typeof message.content === "string" ? message.content : message.content.map((part: any) => String(part?.text ?? "")).join("")));
			const done = sinceUser.filter((message) => message?.role === "assistant").length;
			const leg = tools.length > 0 ? legs[done] : undefined;
			const base = { id: `cmpl_${done}`, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: MODEL.model };
			res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
			const calls = leg ? (typeof leg === "function" ? leg(toolResults) : leg) : [];
			if (calls.length > 0) {
				for (const call of calls) called.add(call.name);
				const tool_calls = calls.map((call, index) => ({ index, id: `call_${done}_${index}`, type: "function", function: { name: call.name, arguments: JSON.stringify(call.args) } }));
				res.write(sse({ ...base, choices: [{ index: 0, delta: { role: "assistant", tool_calls }, finish_reason: null }] }));
				res.write(sse({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } }));
			} else {
				res.write(sse({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: "Done." }, finish_reason: null }] }));
				res.write(sse({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 150, completion_tokens: 4, total_tokens: 154 } }));
			}
			res.end("data: [DONE]\n\n");
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const write = (file: string, value: unknown) => fs.writeFileSync(file, JSON.stringify(value, null, 2), { mode: 0o600 });
	write(path.join(agentDir, "models.json"), { providers: { "openai-compatible": { name: "Synthetic Gateway", baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`, api: "openai-completions", models: [{ id: MODEL.model, name: "Room Model", contextWindow: 200000, maxTokens: 4096 }] } } });
	write(path.join(agentDir, "auth.json"), { "openai-compatible": { type: "api_key", key: "synthetic-tripwire" } });
	write(path.join(appRoot, "openai-compatible-ai-profile.json"), { profileId: "openai-compatible", providerId: "openai-compatible", label: "Synthetic Gateway", roomModels: [{ modelId: MODEL.model, label: "Room Model" }], maintenanceModel: MODEL.model });
	write(path.join(appRoot, "persistent-agent-ai-profile.json"), { profileId: "openai-compatible" });
	return {
		script(next) {
			legs = next;
			toolResults = [];
		},
		results: () => toolResults,
		offered,
		called,
		close: () => server.close(),
	};
}
