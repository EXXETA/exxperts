// The prompt cache each kind of model call asks for (memory-call-cache.ts).
//
// - Against a real spawned server, with PI_CACHE_RETENTION=long and one
//   synthetic Anthropic endpoint behind the Claude sign-in (nothing leaves the
//   machine): a chat turn asks for the one-hour cache, while a consult, from
//   the route and from the room's socket, and a memory ask go out with no
//   cache marks.
// - The OpenAI Responses request itself: "long" is sent as "24h" to GPT-5.5,
//   and never to a model that charges for cache writes (GPT-5.6 and later).
// - The policy's table: each kind of call on each provider and sign-in, with
//   nothing set and under each override.

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { authedFetch, SMOKE_AUTH_HEADERS, SMOKE_SERVER_AUTH_ENV, SMOKE_SERVER_SPAWN_TREE_OPTIONS, smokeHomeEnv, stopSmokeServer, freePort, type AuthedFetchInit } from "./smoke-server-process.js";
import { waitEvery } from "./smoke-wait.js";

const waitUntil = waitEvery(100);

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

function pass(label: string): void {
	console.log(`  ok  ${label}`);
}

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const webServerDir = path.resolve(scriptDir, "..");
const repoRoot = path.resolve(webServerDir, "..", "..");
const port = await freePort();
const baseUrl = `http://127.0.0.1:${port}`;

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "exxperts-cache-policy-"));
const tempHome = path.join(tempRoot, "home");
const agentsRoot = path.join(tempHome, ".exxperts", "app", "personalized-agents");
const agentDir = path.join(tempHome, ".exxperts", "agent");
const appDir = path.join(tempHome, ".exxperts", "app");
for (const dir of [agentsRoot, agentDir]) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
process.env.HOME = tempHome;
process.env.USERPROFILE = tempHome;
process.env.EXXPERTS_CODING_AGENT_DIR = agentDir;
process.env.EXXETA_PERSISTENT_AGENTS_ROOT = agentsRoot;

const SIGN_IN = { type: "oauth", access: "sk-ant-oat01-synthetic-sign-in", refresh: "synthetic-refresh", expires: Date.now() + 365 * 24 * 3600 * 1000 };
const ON_SIGN_IN = { provider: "anthropic", model: "claude-haiku-5-5" };
const CONSULT_QUESTION = "What renews in May?";

// --- The synthetic Anthropic endpoint ----------------------------------------------

const requests: string[] = [];

function sse(res: http.ServerResponse, event: string, payload: unknown): void {
	res.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
}

const endpoint = http.createServer((req, res) => {
	let raw = "";
	req.on("data", (chunk) => { raw += chunk; });
	req.on("end", () => {
		const body = JSON.parse(raw || "{}");
		requests.push(raw);
		res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
		sse(res, "message_start", { type: "message_start", message: { id: `msg_${requests.length}`, type: "message", role: "assistant", model: body.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 100, output_tokens: 1 } } });
		sse(res, "content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
		sse(res, "content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: `Answer from ${body.model}.` } });
		sse(res, "content_block_stop", { type: "content_block_stop", index: 0 });
		sse(res, "message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 20 } });
		sse(res, "message_stop", { type: "message_stop" });
		res.end();
	});
});

async function api(pathname: string, init: AuthedFetchInit = {}): Promise<{ status: number; body: any }> {
	const response = await authedFetch(`${baseUrl}${pathname}`, { ...init, headers: { ...(init.body ? { "content-type": "application/json" } : {}), ...init.headers } });
	const text = await response.text();
	return { status: response.status, body: text ? JSON.parse(text) : null };
}

/** The cache marks a request carries: each cache_control object, in order. */
function cacheMarks(raw: string): Array<{ type: string; ttl?: string }> {
	const marks: Array<{ type: string; ttl?: string }> = [];
	JSON.parse(raw, (key, value) => {
		if (key === "cache_control") marks.push(value);
		return value;
	});
	return marks;
}

const WebSocketImpl: any = (await import("ws")).default;

let server: ChildProcessWithoutNullStreams | undefined;
const serverOutput: string[] = [];

try {
	await new Promise<void>((resolve) => endpoint.listen(0, "127.0.0.1", resolve));
	const endpointUrl = `http://127.0.0.1:${(endpoint.address() as AddressInfo).port}`;
	fs.writeFileSync(path.join(agentDir, "models.json"), JSON.stringify({ providers: { anthropic: { baseUrl: endpointUrl } } }, null, 2), { mode: 0o600 });
	fs.writeFileSync(path.join(agentDir, "auth.json"), JSON.stringify({ anthropic: SIGN_IN }, null, 2), { mode: 0o600 });
	fs.writeFileSync(path.join(appDir, "persistent-agent-ai-profile.json"), JSON.stringify({ profileId: "anthropic" }, null, 2), { mode: 0o600 });

	const agents = await import("../src/persistent-agents.js");
	const roomModels = await import("../src/room-models.js");
	const newRoom = (displayName: string) => agents.createPersistentAgentFromScaffoldInput({ displayName, userName: "Synthetic User", preferredUserAddress: "Synthetic User" }).agent.agentId;
	const askingRoom = newRoom("Asking Room");
	const consultedRoom = newRoom("Consulted Room");
	roomModels.writeRoomModels(askingRoom, { conversation: ON_SIGN_IN });
	roomModels.writeRoomModels(consultedRoom, { conversation: ON_SIGN_IN });
	// A note for the memory ask to find.
	{
		const l1bPath = path.join(agentsRoot, consultedRoom, "L1b", "current.md");
		const text = fs.readFileSync(l1bPath, "utf-8");
		const active = /^##\s+Active Items\s*$/m.exec(text)!;
		fs.writeFileSync(l1bPath, `${text.slice(0, active.index)}### Renewals\n\n<!-- e: id=m-0201 kind=fact saved=2026-09-01 -->\n- The Nordwind contract renews in May.\n\n${text.slice(active.index)}`, "utf-8");
	}

	server = spawn("npx", ["tsx", "src/index.ts"], {
		shell: process.platform === "win32",
		...SMOKE_SERVER_SPAWN_TREE_OPTIONS,
		cwd: webServerDir,
		env: smokeHomeEnv(tempHome, { PORT: String(port), ...SMOKE_SERVER_AUTH_ENV, EXXETA_HOME: repoRoot, EXXPERTS_CODING_AGENT_DIR: agentDir, EXXETA_PERSISTENT_AGENTS_ROOT: agentsRoot, PI_CACHE_RETENTION: "long" }) as NodeJS.ProcessEnv,
	});
	server.stdout.on("data", (chunk) => serverOutput.push(String(chunk)));
	server.stderr.on("data", (chunk) => serverOutput.push(String(chunk)));
	await waitUntil(() => fetch(`${baseUrl}/healthz`).then((r) => r.ok).catch(() => false), "server ready");
	const memoryPick = await api(`/api/persistent-agents/${consultedRoom}/models`, { method: "PUT", body: JSON.stringify({ memory: ON_SIGN_IN }) });
	assert(memoryPick.status === 200, `the consulted room's Memory model is ${ON_SIGN_IN.model}, got ${memoryPick.status} ${JSON.stringify(memoryPick.body)}`);

	// A chat turn in the asking room, over its socket.
	const conversationId = "c_cache_0001";
	const opened = await api(`/api/persistent-agents/${askingRoom}/threads/${conversationId}`, { method: "PUT", body: JSON.stringify({ state: "active", origin: "home", items: [] }) });
	assert(opened.status === 200, `the conversation opens, got ${opened.status} ${JSON.stringify(opened.body)}`);
	const frames: any[] = [];
	const socket = new WebSocketImpl(`ws://127.0.0.1:${port}/ws?persistentAgentId=${askingRoom}&conversationId=${conversationId}`, { headers: { ...SMOKE_AUTH_HEADERS } });
	socket.addEventListener("message", (event: { data: unknown }) => { try { frames.push(JSON.parse(String(event.data))); } catch {} });
	await new Promise<void>((resolve, reject) => { socket.addEventListener("open", () => resolve()); socket.addEventListener("error", () => reject(new Error("websocket failed to connect"))); });
	try {
		await waitUntil(() => frames.some((frame) => frame.type === "ready"), "ready frame");
		const beforeTurn = requests.length;
		socket.send(JSON.stringify({ type: "prompt", text: "A question in the room." }));
		await waitUntil(async () => requests.length > beforeTurn && (await api(`/api/persistent-agents/${askingRoom}/status`)).body?.activeThread?.inFlight === false, "the chat turn settled");
		const turnMarks = cacheMarks(requests[beforeTurn]!);
		assert(turnMarks.length > 0 && turnMarks.every((mark) => mark.ttl === "1h"), `a chat turn on the Claude sign-in asks for the one-hour cache under PI_CACHE_RETENTION=long, got ${JSON.stringify(turnMarks)}`);
		pass("PI_CACHE_RETENTION=long still gives a chat turn on the Claude sign-in the one-hour cache");

		// A consult from the room's socket.
		const beforeSocketConsult = requests.length;
		socket.send(JSON.stringify({ type: "consult", consultId: "k_cache_0001", targetRoomId: consultedRoom, question: CONSULT_QUESTION }));
		await waitUntil(() => frames.some((frame) => (frame.type === "consult_end" || frame.type === "consult_error") && frame.consultId === "k_cache_0001"), "the socket's consult ended");
		const socketEnd = frames.find((frame) => frame.consultId === "k_cache_0001" && (frame.type === "consult_end" || frame.type === "consult_error"));
		assert(socketEnd.type === "consult_end", `the socket's consult answers, got ${JSON.stringify(socketEnd)}`);
		const socketConsult = requests.slice(beforeSocketConsult);
		assert(socketConsult.length === 1 && socketConsult[0]!.includes(CONSULT_QUESTION), `the socket's consult sends one request, got ${socketConsult.length}`);
		assert(cacheMarks(socketConsult[0]!).length === 0, `a consult from the room's socket asks for no prompt cache, got ${JSON.stringify(cacheMarks(socketConsult[0]!))}`);
		pass("a consult from the room's socket goes out with no cache marks");
	} finally {
		socket.close();
	}

	// A consult from the route.
	const beforeRouteConsult = requests.length;
	const consulted = await api(`/api/persistent-agents/${consultedRoom}/consult`, { method: "POST", body: JSON.stringify({ question: CONSULT_QUESTION, fromRoomId: askingRoom }) });
	assert(consulted.status === 200 && String(consulted.body?.answerMarkdown ?? "").startsWith("Answer from"), `the route's consult answers, got ${consulted.status} ${JSON.stringify(consulted.body)}`);
	const routeConsult = requests.slice(beforeRouteConsult);
	assert(routeConsult.length === 1 && routeConsult[0]!.includes(CONSULT_QUESTION), `the route's consult sends one request, got ${routeConsult.length}`);
	assert(cacheMarks(routeConsult[0]!).length === 0, `a consult from the route asks for no prompt cache, got ${JSON.stringify(cacheMarks(routeConsult[0]!))}`);
	pass("a consult from the route goes out with no cache marks");

	// A memory ask on the consulted room.
	const beforeAsk = requests.length;
	const asked = await api("/api/memory/ask", { method: "POST", body: JSON.stringify({ question: CONSULT_QUESTION, rooms: [consultedRoom] }) });
	assert(asked.status === 200 && asked.body?.ok === true, `the memory ask answers, got ${asked.status} ${JSON.stringify(asked.body)}`);
	const askSent = requests.slice(beforeAsk);
	assert(askSent.length === 1 && askSent[0]!.includes("Nordwind"), `the memory ask sends one request with the room's note, got ${askSent.length}`);
	assert(cacheMarks(askSent[0]!).length === 0, `a memory ask asks for no prompt cache, got ${JSON.stringify(cacheMarks(askSent[0]!))}`);
	pass("a memory ask goes out with no cache marks");
} catch (error) {
	console.error(serverOutput.join("").slice(-6000));
	throw error;
} finally {
	await stopSmokeServer(server);
	endpoint.close();
	fs.rmSync(tempRoot, { recursive: true, force: true });
}

// --- The OpenAI Responses request ----------------------------------------------------

{
	const { getModel, streamSimple } = await import("@exxeta/exxperts-ai");
	const sent = async (modelId: string, cacheRetention?: "short" | "long"): Promise<Record<string, unknown>> => {
		let payload: Record<string, unknown> | undefined;
		const stream = streamSimple(getModel("openai", modelId as any), { messages: [{ role: "user", content: "Hello.", timestamp: Date.now() }] }, {
			apiKey: "synthetic-openai-key",
			sessionId: "s_cache_policy",
			...(cacheRetention ? { cacheRetention } : {}),
			// The request is read here and never sent.
			onPayload: (params) => {
				payload = params as Record<string, unknown>;
				throw new Error("read, not sent");
			},
		});
		for await (const _ of stream);
		assert(payload, `the ${modelId} request was built`);
		return payload;
	};
	process.env.PI_CACHE_RETENTION = "long";
	assert((await sent("gpt-5.5", "long")).prompt_cache_retention === "24h", "GPT-5.5 asked for long is sent the 24-hour lifetime it accepts");
	for (const modelId of ["gpt-6.1-sol", "gpt-6-luna", "gpt-5.6-terra", "gpt-daybreak-blue-latest"]) {
		const asked = await sent(modelId, "long");
		assert(!("prompt_cache_retention" in asked && asked.prompt_cache_retention !== undefined) && !("prompt_cache_options" in asked), `${modelId} asked for long keeps its 30-minute default, got ${JSON.stringify({ retention: asked.prompt_cache_retention, options: asked.prompt_cache_options })}`);
		assert((await sent(modelId)).prompt_cache_retention === undefined, `${modelId} with PI_CACHE_RETENTION=long and no lifetime of its own keeps its default too`);
		assert(asked.prompt_cache_key === "s_cache_policy", `${modelId} still sends its cache key`);
	}
	delete process.env.PI_CACHE_RETENTION;
	pass("an OpenAI Responses request sends GPT-5.5 the 24-hour lifetime and never asks a model that charges for cache writes (GPT-5.6 and later, and their aliases) for one");
}

// --- The policy's table ----------------------------------------------------------------

{
	const { CALL_KINDS, MEMORY_CALL_KINDS, callCacheRetention } = await import("../src/memory-call-cache.js");
	const { getModel } = await import("@exxeta/exxperts-ai");
	const catalogued = (provider: string, id: string) => {
		const model = getModel(provider as any, id as any);
		assert(model, `${provider}/${id} is in the catalogue`);
		return model;
	};
	const ON = {
		"Anthropic key": catalogued("anthropic-api-key", "claude-opus-5-5"),
		"Claude sign-in": catalogued("anthropic", "claude-opus-5-5"),
		"OpenAI key, GPT-5.5": catalogued("openai", "gpt-5.5"),
		"OpenAI key, GPT-6.1 Sol": catalogued("openai", "gpt-6.1-sol"),
		"OpenAI key, GPT-6 Luna": catalogued("openai", "gpt-6-luna"),
		"OpenAI key, GPT-5.6 Terra": catalogued("openai", "gpt-5.6-terra"),
		"OpenAI key, a GPT alias that charges for writes": catalogued("openai", "gpt-daybreak-blue-latest"),
		"ChatGPT sign-in": catalogued("openai-codex", "gpt-6.1-sol"),
		Copilot: catalogued("github-copilot", "claude-sonnet-5.5"),
		"a gateway": { provider: "company-gateway", id: "claude-opus-5-5", cost: { cacheWrite: 0 } },
		Bedrock: catalogued("amazon-bedrock", "anthropic.claude-opus-5-5"),
	};
	const LONG_PAYS = new Set<string>(["Anthropic key", "Claude sign-in", "OpenAI key, GPT-5.5", "Bedrock"]);
	const CONVERSATION_KINDS = new Set<string>(["chat", "specialist", "scheduled"]);
	const ONE_SHOT_KINDS = new Set<string>(["consult", "memory-ask"]);
	assert(CALL_KINDS.length === 13 && MEMORY_CALL_KINDS.length === 8, "thirteen kinds of call: chat, specialist, scheduled, consult, memory ask and the eight Memory model calls");
	const table = (expected: (kind: string, on: string) => string, label: string) => {
		for (const kind of CALL_KINDS) {
			for (const [on, model] of Object.entries(ON)) {
				const got = callCacheRetention(kind, model);
				assert(got === expected(kind, on), `${label}: ${kind} on ${on} asks for ${expected(kind, on)}, got ${got}`);
			}
		}
	};

	delete process.env.PI_CACHE_RETENTION;
	delete process.env.EXXPERTS_MEMORY_CACHE_RETENTION;
	table((kind) => (CONVERSATION_KINDS.has(kind) ? "short" : "none"), "nothing set");
	pass("with nothing set, chat, specialists and scheduled runs ask for the short cache on every provider, consult, memory ask and every Memory model call for none");

	process.env.PI_CACHE_RETENTION = "long";
	table((kind, on) => (CONVERSATION_KINDS.has(kind) ? (LONG_PAYS.has(on) ? "long" : "short") : "none"), "PI_CACHE_RETENTION=long");
	pass("PI_CACHE_RETENTION=long asks for long only where it pays (Anthropic key and sign-in, Bedrock, GPT-5.5), never on GPT-5.6 and later, the ChatGPT sign-in, Copilot or a gateway; consult, memory ask and Memory calls stay at none");
	delete process.env.PI_CACHE_RETENTION;

	process.env.EXXPERTS_MEMORY_CACHE_RETENTION = "long";
	table((kind, on) => (CONVERSATION_KINDS.has(kind) ? "short" : ONE_SHOT_KINDS.has(kind) ? "none" : LONG_PAYS.has(on) ? "long" : "short"), "EXXPERTS_MEMORY_CACHE_RETENTION=long");
	pass("EXXPERTS_MEMORY_CACHE_RETENTION=long sets every Memory model call, and only where long pays");

	process.env.EXXPERTS_MEMORY_CACHE_RETENTION = "remember-part=long, fold=short, probe=forever";
	const claude = ON["Claude sign-in"];
	assert(callCacheRetention("remember-part", claude) === "long" && callCacheRetention("fold", claude) === "short", "kinds named by name get their own value");
	assert(callCacheRetention("probe", claude) === "none" && callCacheRetention("remember-final", claude) === "none", "an unknown value, or a kind not named, keeps its own");
	assert(callCacheRetention("remember-part", ON.Copilot) === "short", "a kind named long stays short on Copilot");
	delete process.env.EXXPERTS_MEMORY_CACHE_RETENTION;
	pass("Memory model calls by name, an unknown value ignored");
}

console.log("cache policy smoke passed");
