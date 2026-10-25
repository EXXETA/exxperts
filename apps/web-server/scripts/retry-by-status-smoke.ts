// When the runtime asks a failed message again, read from its status and its
// error type as well as its words, in the runtime's own session:
//
// - a spent plan, credit or gateway budget (OpenAI's documented 429
//   insufficient_quota, a gateway's budget_exceeded) is asked once, even
//   though its words name the 429;
// - a busy status whose words name nothing is asked again for a provider that
//   does not ask again itself, a 529 included;
// - the ChatGPT sign-in's client already asks a 429 or a 5xx again itself:
//   against a local stand-in for its backend, a 503 and a 429 are sent four
//   times in about seven seconds, as before the status was read, not twenty
//   (five where Node has a built-in WebSocket, which the client tries first);
// - only an attempt with a try left is followed by another: the attempt that
//   ends the turn is never marked as asked again.
// Offline: scripted streams and a local fake backend, made-up tokens.
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { Agent } from "@exxeta/exxperts-core";
import { EventStream, getModels, type AssistantMessage, type AssistantMessageEvent } from "@exxeta/exxperts-ai";
import { AgentSession, AuthStorage, createExtensionRuntime, ModelRegistry, SessionManager, SettingsManager, type ResourceLoader } from "@exxeta/exxperts-runtime";

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "exxperts-retry-by-status-"));
process.env.HOME = tempRoot;
process.env.USERPROFILE = tempRoot;

const resourceLoader: ResourceLoader = {
	getExtensions: () => ({ extensions: [], errors: [], runtime: createExtensionRuntime() }),
	getSkills: () => ({ skills: [], diagnostics: [] }),
	getPrompts: () => ({ prompts: [], diagnostics: [] }),
	getThemes: () => ({ themes: [], diagnostics: [] }),
	getAgentsFiles: () => ({ agentsFiles: [] }),
	getSystemPrompt: () => undefined,
	getAppendSystemPrompt: () => [],
	extendResources: () => {},
	reload: async () => {},
} as unknown as ResourceLoader;

let sessionCount = 0;
function sessionOn(agent: Agent, retry?: { maxRetries: number; baseDelayMs: number }, key: [string, string] = ["anthropic", "made-up"]): AgentSession {
	const dir = path.join(tempRoot, `session-${++sessionCount}`);
	fs.mkdirSync(dir, { recursive: true });
	const settingsManager = SettingsManager.create(dir, dir);
	if (retry) settingsManager.applyOverrides({ retry: { enabled: true, ...retry } });
	const auth = AuthStorage.create(path.join(dir, "auth.json"));
	// Made-up keys: the session asks for one before the first call.
	auth.setRuntimeApiKey(...key);
	return new AgentSession({ agent, sessionManager: SessionManager.inMemory(), settingsManager, cwd: dir, modelRegistry: ModelRegistry.create(auth, dir), resourceLoader });
}

class ScriptedStream extends EventStream<AssistantMessageEvent, AssistantMessage> {
	constructor() {
		super((event) => event.type === "done" || event.type === "error", (event: any) => (event.type === "done" ? event.message : event.error));
	}
}

type Failed = { api: string; status?: number; type?: string; words: string };
const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

// Every attempt fails the same way; what the session did, attempt by attempt.
async function askedWith(failed: Failed): Promise<{ calls: number; marks: boolean[] }> {
	let calls = 0;
	const model = getModels("anthropic")[0]!;
	const agent = new Agent({
		getApiKey: () => "made-up",
		initialState: { model, systemPrompt: "Test.", tools: [] },
		streamFn: () => {
			calls++;
			const stream = new ScriptedStream();
			queueMicrotask(() => {
				const message = { role: "assistant", content: [], api: failed.api, provider: "scripted", model: "scripted", usage, stopReason: "error", errorMessage: failed.words, timestamp: Date.now(), ...(failed.status ? { errorStatus: failed.status } : {}), ...(failed.type ? { errorType: failed.type } : {}) } as unknown as AssistantMessage;
				stream.push({ type: "start", partial: message } as AssistantMessageEvent);
				stream.push({ type: "error", reason: "error", error: message } as AssistantMessageEvent);
			});
			return stream as any;
		},
	});
	const session = sessionOn(agent, { maxRetries: 3, baseDelayMs: 1 });
	// Whether the session says each failed attempt will be asked again, at the moment its run ends.
	const marks: boolean[] = [];
	session.subscribe((event: any) => {
		if (event.type !== "agent_end") return;
		const last = [...event.messages].reverse().find((message: any) => message.role === "assistant");
		marks.push(session.retriesAfter(last));
	});
	await session.prompt("Hello.");
	session.dispose();
	return { calls, marks };
}

const failures: string[] = [];
// Each section says ok only when it added no failure; every miss is named at the end.
let failedBefore = 0;
function said(label: string): void {
	if (failures.length === failedBefore) console.log(`  ok  ${label}`);
	failedBefore = failures.length;
}

// A spent quota stays spent: one call, whatever its words.
{
	const spent = await askedWith({ api: "openai-responses", status: 429, type: "insufficient_quota", words: "429 You exceeded your current quota, please check your plan and billing details." });
	if (spent.calls !== 1) failures.push(`OpenAI's 429 insufficient_quota is asked once, got ${spent.calls} calls`);
	const plan = await askedWith({ api: "openai-codex-responses", status: 429, type: "usage_limit_reached", words: "You have hit your ChatGPT usage limit (plus plan)." });
	if (plan.calls !== 1) failures.push(`a ChatGPT plan's usage limit is asked once, got ${plan.calls} calls`);
	// A LiteLLM-style gateway's spent budget, answered with a 429: its status and its words alone would ask it again.
	const budget = await askedWith({ api: "openai-completions", status: 429, type: "budget_exceeded", words: "429 Budget has been exceeded! Current cost: 40.23, Max budget: 40.0" });
	if (budget.calls !== 1) failures.push(`a gateway's spent budget (budget_exceeded) is asked once, got ${budget.calls} calls`);
}
said("a spent plan, credit or gateway budget is asked once, even when its words name the 429");

// A busy status whose words name nothing: asked again where the provider did not ask again itself.
{
	const gateway = await askedWith({ api: "anthropic-messages", status: 502, words: "Bad Gateway" });
	if (gateway.calls !== 4) failures.push(`a 502 whose words name nothing is asked again for a provider that does not ask again itself, got ${gateway.calls} calls`);
	const overload = await askedWith({ api: "openai-codex-responses", status: 529, words: "Something unusual happened." });
	if (overload.calls !== 4) failures.push(`a 529, which the ChatGPT sign-in's client does not ask again itself, is asked again, got ${overload.calls} calls`);
	const codex = await askedWith({ api: "openai-codex-responses", status: 503, words: "Something unusual happened." });
	if (codex.calls !== 1) failures.push(`a 503 the ChatGPT sign-in's client already asked again itself is not asked again on top, got ${codex.calls} calls`);
	const plain = await askedWith({ api: "anthropic-messages", status: 400, words: "Bad request" });
	if (plain.calls !== 1) failures.push(`a 400 is never asked again, got ${plain.calls} calls`);
	// Only an attempt with a try left is marked: three retries, then the attempt that ends the turn.
	if (JSON.stringify(gateway.marks) !== JSON.stringify([true, true, true, false])) failures.push(`only an attempt with a try left is marked as asked again, got ${JSON.stringify(gateway.marks)}`);
	if (JSON.stringify(plain.marks) !== JSON.stringify([false])) failures.push(`an attempt never asked again is never marked, got ${JSON.stringify(plain.marks)}`);
}
said("a busy status is asked again where the provider did not ask itself, and only an attempt with a try left is marked");

// The ChatGPT sign-in's own client against a local stand-in, with the runtime's default retries.
{
	const base64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64").replace(/=+$/, "");
	const token = `${base64({ alg: "none" })}.${base64({ "https://api.openai.com/auth": { chatgpt_account_id: "made-up-account" } })}.made-up`;
	const backendCase = async (status: number, body: unknown) => {
		let hits = 0;
		const backend = http.createServer((req, res) => {
			req.resume();
			req.on("end", () => {
				hits++;
				res.writeHead(status, { "content-type": "application/json" });
				res.end(JSON.stringify(body));
			});
		});
		await new Promise<void>((resolve) => backend.listen(0, "127.0.0.1", resolve));
		try {
			const model = { ...getModels("openai-codex")[0]!, baseUrl: `http://127.0.0.1:${(backend.address() as AddressInfo).port}` };
			const agent = new Agent({ getApiKey: () => token, initialState: { model, systemPrompt: "Test.", tools: [] } });
			const session = sessionOn(agent, undefined, ["openai-codex", token]);
			const started = Date.now();
			await session.prompt("Hello.");
			session.dispose();
			return { status, hits, seconds: (Date.now() - started) / 1000 };
		} finally {
			(backend as any).closeAllConnections?.();
			backend.close();
		}
	};
	const results = await Promise.all([backendCase(503, { detail: "Something nobody reads." }), backendCase(429, { error: { type: "rate_limit_exceeded", message: "Slow down." } })]);
	// The client tries a WebSocket first where Node has one built in (22 and later), and the stand-in counts that try too; Node 20, which CI runs, has none.
	const hitsExpected = typeof (globalThis as { WebSocket?: unknown }).WebSocket === "function" ? 5 : 4;
	for (const result of results) {
		if (result.hits !== hitsExpected || result.seconds > 12) failures.push(`a ChatGPT sign-in's ${result.status} is sent ${hitsExpected} times in about seven seconds, got ${result.hits} calls in ${result.seconds.toFixed(1)} s`);
	}
	said(`the ChatGPT sign-in's 503 and 429 are sent ${hitsExpected} times in about seven seconds, its client's own tries only (${results.map((result) => `${result.status}: ${result.hits} calls in ${result.seconds.toFixed(1)} s`).join(", ")})`);
}

fs.rmSync(tempRoot, { recursive: true, force: true });
assert(failures.length === 0, `retry by status:\n  ${failures.join("\n  ")}`);
console.log("retry-by-status smoke: ok");
