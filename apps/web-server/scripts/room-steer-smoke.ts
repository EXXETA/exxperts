import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { authedFetch, freePort, smokeHomeEnv, SMOKE_AUTH_HEADERS, SMOKE_SERVER_AUTH_ENV, SMOKE_SERVER_SPAWN_TREE_OPTIONS, stopSmokeServer, type AuthedFetchInit } from "./smoke-server-process.js";

// A message sent while a room answers, over a real socket, the server
// deciding where it goes from its own state (steer-route.ts):
// - with no answer running it is refused (the page sends it as its own);
// - during a step it waits (steer_waiting) and goes in after the step, as
//   written; two sent during one step both go in at that step (steering
//   mode "all"); the provider's own search counts as a step;
// - while the model thinks or writes, Enter waits and goes in right after
//   the answer, in the same turn: nothing is cut;
// - Cmd/Ctrl+Enter (`now`) cuts (steer_cut): the next message carries
//   [ANSWER CUT OFF] around exactly the characters the page showed; with
//   nothing shown yet the cut is quiet and carries no note; during a step
//   it stops the step; the message the page sends the moment the cut
//   answer ends waits for the turn to close instead of being refused, and
//   starts nothing if its window closed meanwhile;
// - a question open before the person typed is declined once, their
//   message first; one that opened after they started typing stays, and
//   the message waits for it;
// - Stop hands back what the runtime has not taken (steer_returned), and
//   the next message carries Stop's note; a Stop or a reveal stop lands
//   only the words shown;
// - a turn that lands while nobody watches lands the messages it took,
//   once, before its answer; a window that stepped back in steers the
//   turn it adopted;
// - messages no answer took are held on disk (held-messages-store.ts): a
//   page's `hold` keeps each once, a new connection's ready lists them,
//   `held_drop` or sending one takes it off; a message waiting when the
//   server stops is held over the restart, and nothing sends it by itself.
// A real server with a synthetic gateway that plays the model. Throwaway HOME.

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const webServerDir = path.resolve(scriptDir, "..");
const repoRoot = path.resolve(webServerDir, "..", "..");
const { serverLaunchArgs } = createRequire(import.meta.url)(path.join(repoRoot, "bin", "lib", "server-entry.cjs")) as {
	serverLaunchArgs: (root: string, options?: { tsxLoader?: boolean; env?: NodeJS.ProcessEnv }) => string[];
};

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "exxperts-steer-"));
const home = path.join(tempRoot, "home");
const workspaceRoot = path.join(tempRoot, "workspace");
fs.mkdirSync(workspaceRoot, { recursive: true, mode: 0o700 });
fs.writeFileSync(path.join(workspaceRoot, "notes.txt"), "The export runs on Fridays.\nThe import runs on Mondays.\n", { mode: 0o600 });
const agentDir = path.join(home, ".exxperts", "agent");
const appRoot = path.join(home, ".exxperts", "app");
const agentsRoot = path.join(appRoot, "personalized-agents");

// The synthetic gateway answers each model call with the next leg of the
// scene: a tool call or text. A held leg writes its lead, then waits until
// the scene lets it go, so the scene can act while the model writes.
// `thinking`: a held leg thinks these words instead of writing its lead; `silent`: it sends nothing before the wait; `refused`: the call is refused with this request error.
interface Leg { tool?: { name: string; args: Record<string, unknown> }; text?: string; lead?: string; thinking?: string; silent?: boolean; held?: boolean; refused?: string }
let legs: Leg[] = [];
let release = () => {};
let held: Promise<void> = Promise.resolve();
const holdNextLeg = () => { held = new Promise<void>((resolve) => { release = resolve; }); };
// The provider's own web search (an Anthropic Messages stream) waits here until the scene lets it go.
const SEARCH = { provider: "anthropic-api-key", model: "claude-haiku-5-5" };
let releaseSearch = () => {};
let searchHeld: Promise<void> = Promise.resolve();
// Every model call: its user messages and its tool results, in order.
const calls: { userTexts: string[]; toolTexts: string[]; roles: string[] }[] = [];
const sseChunk = (payload: unknown): string => `data: ${JSON.stringify(payload)}\n\n`;
const textOf = (content: unknown): string => typeof content === "string" ? content : Array.isArray(content) ? content.map((part: any) => (typeof part?.text === "string" ? part.text : "")).join("") : "";
async function searchingAnswer(res: http.ServerResponse): Promise<void> {
	const send = (event: Record<string, unknown>) => { if (!res.destroyed) res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`); };
	const text = (index: number, words: string) => {
		send({ type: "content_block_start", index, content_block: { type: "text", text: "" } });
		send({ type: "content_block_delta", index, delta: { type: "text_delta", text: words } });
		send({ type: "content_block_stop", index });
	};
	res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
	send({ type: "message_start", message: { id: `msg_search_${calls.length}`, type: "message", role: "assistant", model: SEARCH.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 100, output_tokens: 1 } } });
	text(0, "Let me search.");
	send({ type: "content_block_start", index: 1, content_block: { type: "server_tool_use", id: `srvtoolu_${calls.length}`, name: "web_search", input: {} } });
	send({ type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: JSON.stringify({ query: "node lts" }) } });
	send({ type: "content_block_stop", index: 1 });
	await searchHeld;
	send({ type: "content_block_start", index: 2, content_block: { type: "web_search_tool_result", tool_use_id: `srvtoolu_${calls.length}`, content: [{ type: "web_search_result", title: "Node.js releases", url: "https://nodejs.org/en/about/previous-releases", encrypted_content: "synthetic", page_age: null }] } });
	send({ type: "content_block_stop", index: 2 });
	text(3, " Node.js 24 is the active LTS line.");
	send({ type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 30 } });
	send({ type: "message_stop" });
	res.end();
}
const gateway = http.createServer((req, res) => {
	if (req.method === "POST" && String(req.url ?? "").endsWith("/v1/messages")) {
		let body = "";
		req.on("data", (chunk) => { body += chunk; });
		req.on("end", () => {
			let parsed: any = {};
			try { parsed = JSON.parse(body); } catch {}
			const messages: any[] = Array.isArray(parsed?.messages) ? parsed.messages : [];
			calls.push({ userTexts: messages.filter((m) => m?.role === "user").map((m) => textOf(m.content)), toolTexts: [], roles: messages.map((m) => String(m?.role)) });
			const asked = messages.at(-1)?.role === "user" ? textOf(messages.at(-1).content) : "";
			// The first call searches; the one that reads the person's message just answers.
			if (asked.includes("Only the LTS line.")) {
				res.writeHead(200, { "content-type": "text/event-stream" });
				const send = (event: Record<string, unknown>) => res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
				send({ type: "message_start", message: { id: `msg_after_${calls.length}`, type: "message", role: "assistant", model: SEARCH.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 100, output_tokens: 1 } } });
				send({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
				send({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Only the LTS line: 24." } });
				send({ type: "content_block_stop", index: 0 });
				send({ type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 10 } });
				send({ type: "message_stop" });
				res.end();
				return;
			}
			void searchingAnswer(res);
		});
		return;
	}
	if (req.method !== "POST" || !String(req.url ?? "").endsWith("/chat/completions")) { res.writeHead(404).end(); return; }
	let body = "";
	req.on("data", (chunk) => { body += chunk; });
	req.on("end", async () => {
		let parsed: any = {};
		try { parsed = JSON.parse(body); } catch {}
		const messages: any[] = Array.isArray(parsed?.messages) ? parsed.messages : [];
		calls.push({ userTexts: messages.filter((m) => m?.role === "user").map((m) => textOf(m.content)), toolTexts: messages.filter((m) => m?.role === "tool").map((m) => textOf(m.content)), roles: messages.map((m) => String(m?.role)) });
		const leg = legs.shift() ?? { text: "Done." };
		if (leg.refused) {
			res.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({ error: { message: leg.refused, type: "invalid_request_error" } }));
			return;
		}
		res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
		const base = { id: `cmpl_${calls.length}`, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: String(parsed?.model ?? "room-model") };
		if (leg.held) {
			// The lead, so the turn is visibly writing or thinking, then the wait.
			if (!leg.silent) res.write(sseChunk({ ...base, choices: [{ index: 0, delta: leg.thinking !== undefined ? { role: "assistant", reasoning_content: leg.thinking } : { role: "assistant", content: leg.lead ?? "" }, finish_reason: null }] }));
			await held;
			if (res.destroyed || res.writableEnded) return;
		}
		if (leg.tool) {
			// A lead before the call, when the leg is not held: text the model writes before its step.
			if (!leg.held && leg.lead) res.write(sseChunk({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: leg.lead }, finish_reason: null }] }));
			res.write(sseChunk({ ...base, choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: `call_${calls.length}`, type: "function", function: { name: leg.tool.name, arguments: "" } }] }, finish_reason: null }] }));
			res.write(sseChunk({ ...base, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: JSON.stringify(leg.tool.args) } }] }, finish_reason: null }] }));
			res.write(sseChunk({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } }));
		} else {
			res.write(sseChunk({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: leg.text ?? "Done." }, finish_reason: null }] }));
			res.write(sseChunk({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 150, completion_tokens: 12, total_tokens: 162 } }));
		}
		res.write("data: [DONE]\n\n");
		res.end();
	});
});

const WebSocketImpl: any = (await import("ws")).default;
let serverProcess: ChildProcessWithoutNullStreams | undefined;
const serverOutput: string[] = [];
let port = 0;
async function json(pathname: string, init: AuthedFetchInit = {}): Promise<{ status: number; body: any }> {
	const response = await authedFetch(`http://127.0.0.1:${port}${pathname}`, { ...init, headers: { ...(init.body ? { "content-type": "application/json" } : {}), ...init.headers } });
	const text = await response.text();
	return { status: response.status, body: text ? JSON.parse(text) : null };
}
async function waitUntil(predicate: () => boolean, label: string, timeoutMs = 30_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!predicate()) {
		assert(Date.now() < deadline, `timed out waiting until ${label}`);
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
}
async function waitUntilAsync(predicate: () => Promise<boolean>, label: string, timeoutMs = 10_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!(await predicate())) {
		assert(Date.now() < deadline, `timed out waiting until ${label}`);
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
}
const CUT_OPEN = "[ANSWER CUT OFF]\nYour previous answer was stopped because the person sent the message below while you were writing.";
const STOP_OPEN = "[ANSWER CUT OFF]\nYour previous answer was stopped by the person.";
const DECLINED = "The person declined this step and sent a message instead.";

try {
	await new Promise<void>((resolve) => gateway.listen(0, "127.0.0.1", resolve));
	const gatewayPort = (gateway.address() as AddressInfo).port;
	for (const dir of [agentsRoot, agentDir, appRoot]) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
	fs.writeFileSync(path.join(agentDir, "models.json"), JSON.stringify({ providers: { "openai-compatible": { name: "Synthetic Gateway", baseUrl: `http://127.0.0.1:${gatewayPort}/v1`, api: "openai-completions", models: [{ id: "room-model", name: "Room Model", contextWindow: 128000, maxTokens: 16384 }] }, [SEARCH.provider]: { baseUrl: `http://127.0.0.1:${gatewayPort}` } } }, null, 2), { mode: 0o600 });
	fs.writeFileSync(path.join(agentDir, "auth.json"), JSON.stringify({ "openai-compatible": { type: "api_key", key: "synthetic-steer" }, [SEARCH.provider]: { type: "api_key", key: "synthetic-search" } }, null, 2), { mode: 0o600 });
	fs.writeFileSync(path.join(appRoot, "openai-compatible-ai-profile.json"), JSON.stringify({ profileId: "openai-compatible", providerId: "openai-compatible", label: "Synthetic Gateway", roomModels: [{ modelId: "room-model", label: "Room Model" }], maintenanceModel: "room-model" }, null, 2), { mode: 0o600 });
	fs.writeFileSync(path.join(appRoot, "persistent-agent-ai-profile.json"), JSON.stringify({ profileId: "openai-compatible" }, null, 2), { mode: 0o600 });

	port = await freePort();
	const startServer = async () => {
		const env = { ...process.env, ...smokeHomeEnv(home), EXXPERTS_CODING_AGENT_DIR: agentDir, EXXETA_PERSISTENT_AGENTS_ROOT: agentsRoot, PORT: String(port), ...SMOKE_SERVER_AUTH_ENV, EXXETA_HOME: repoRoot, EXXPERTS_TEST_INTROSPECTION: "1" } as NodeJS.ProcessEnv;
		delete env.EXXPERTS_SERVER_BUNDLE;
		// The spawned process is the server itself, as on a shared server, so
		// H2's SIGTERM reaches it alone: through npx and tsx's CLI the signal is
		// relayed, and tsx's relay SIGKILLs a server busy for a moment during its stop.
		const started = spawn(process.execPath, serverLaunchArgs(repoRoot, { tsxLoader: true, env }), {
			...SMOKE_SERVER_SPAWN_TREE_OPTIONS,
			cwd: webServerDir,
			env,
		});
		serverProcess = started;
		started.stdout.on("data", (chunk) => serverOutput.push(String(chunk)));
		started.stderr.on("data", (chunk) => serverOutput.push(String(chunk)));
		const ready = Date.now() + 30_000;
		for (;;) {
			assert(Date.now() < ready, "the server came up");
			try { if ((await fetch(`http://127.0.0.1:${port}/healthz`)).ok) break; } catch {}
			await new Promise((resolve) => setTimeout(resolve, 150));
		}
	};
	await startServer();
	const created = await json("/api/persistent-agents", { method: "POST", body: JSON.stringify({ displayName: "Steer Room", userName: "Synthetic User", preferredUserAddress: "Synthetic User" }) });
	const room = String(created.body?.agent?.id ?? created.body?.agent?.agentId ?? "");
	assert(created.status === 201 && room, `room created, got ${created.status}`);
	const workspace = await json(`/api/persistent-agents/${encodeURIComponent(room)}/workspace-default`, { method: "PUT", body: JSON.stringify({ root: workspaceRoot, displayLabel: "Steer Workspace", workspaceAccessMode: "localFiles", bashEnabled: true }) });
	assert(workspace.status === 200, `workspace set, got ${workspace.status}`);
	const conversationId = "conv-steer";
	const threadPath = `/api/persistent-agents/${encodeURIComponent(room)}/threads/${conversationId}`;
	const model = { provider: "openai-compatible", model: "room-model" };
	assert((await json(threadPath, { method: "PUT", body: JSON.stringify({ state: "active", origin: "launcher", model, items: [] }) })).status === 200, "thread seeded");

	const frames: any[] = [];
	const connect = async (pick: { provider: string; model: string } = model, conversation = conversationId, extraParams = ""): Promise<any> => {
		const ws = new WebSocketImpl(`ws://127.0.0.1:${port}/ws?persistentAgentId=${room}&conversationId=${conversation}&modelProvider=${pick.provider}&model=${pick.model}&reattach=1${extraParams}`, { headers: { ...SMOKE_AUTH_HEADERS } });
		const mark = frames.length;
		ws.addEventListener("message", (event: any) => { try { frames.push(JSON.parse(String(event.data))); } catch {} });
		await new Promise<void>((resolve, reject) => { ws.addEventListener("open", () => resolve()); ws.addEventListener("error", () => reject(new Error("websocket failed to connect"))); });
		await waitUntil(() => frames.slice(mark).some((frame) => frame.type === "ready"), "the room is ready");
		return ws;
	};
	let socket = await connect();
	const since = (mark: number) => frames.slice(mark);
	const has = (mark: number, test: (frame: any) => boolean) => since(mark).some(test);
	const turnEnded = (mark: number) => has(mark, (frame) => frame.type === "event" && frame.event?.type === "agent_end");
	const routed = (mark: number, id: string) => since(mark).find((frame) => (frame.type === "steer_waiting" || frame.type === "steer_cut" || frame.type === "steer_refused") && frame.id === id);
	const steer = (id: string, text: string, extra: Record<string, unknown> = {}) => socket.send(JSON.stringify({ type: "steer", id, text, ...extra }));
	const question = (mark: number) => since(mark).find((frame) => frame.type === "ui_request" && frame.kind === "confirm");
	const roomIdle = async () => {
		const deadline = Date.now() + 20_000;
		for (;;) {
			const statuses = await json("/api/persistent-agents");
			const status = (statuses.body?.agents ?? statuses.body ?? []).find?.((agent: any) => agent.id === room);
			if (status && status.activeThread?.inFlight !== true) return;
			assert(Date.now() < deadline, "the room went idle");
			await new Promise((resolve) => setTimeout(resolve, 100));
		}
	};
	// The window left and the turn goes on with nobody in the room.
	const roomDetached = async () => {
		const deadline = Date.now() + 10_000;
		for (;;) {
			const rooms = await json("/api/persistent-agents");
			const list: any[] = rooms.body?.agents ?? rooms.body ?? [];
			if (list.some((row) => row.id === room && row.answeringDetached === true)) return;
			assert(Date.now() < deadline, "the turn went on with nobody in the room");
			await new Promise((resolve) => setTimeout(resolve, 50));
		}
	};
	// The conversation's saved items once `landed` holds for them: a landing is written just after the room goes idle.
	const threadOnceLanded = async (landed: (items: any[]) => boolean, label: string): Promise<any[]> => {
		const deadline = Date.now() + 10_000;
		for (;;) {
			const items: any[] = (await json(threadPath)).body?.thread?.items ?? [];
			if (landed(items)) return items;
			assert(Date.now() < deadline, `timed out waiting until ${label}`);
			await new Promise((resolve) => setTimeout(resolve, 100));
		}
	};
	// A command that asks first, allowed at once: the step then runs for `seconds`.
	const runSlowStep = async (prompt: string, seconds: number, after: Leg[] = [{ text: "Done after the step." }]) => {
		legs = [{ tool: { name: "bash", args: { command: `sleep ${seconds}` } } }, ...after];
		const mark = frames.length;
		socket.send(JSON.stringify({ type: "prompt", text: prompt }));
		await waitUntil(() => !!question(mark), "the command asks first");
		socket.send(JSON.stringify({ type: "ui_response", id: question(mark).id, value: true }));
		await waitUntil(() => has(mark, (frame) => frame.type === "event" && frame.event?.type === "tool_execution_start"), "the step runs");
		return mark;
	};

	// A case that fails says so and the next one still runs: Stop what is left, let any held answer go, wait for the room.
	const failed: string[] = [];
	const scene = async (name: string, run: () => Promise<void>) => {
		try {
			await run();
		} catch (error) {
			failed.push(`case ${name}: ${(error as Error).message}`);
			console.log(`FAIL case ${name}: ${(error as Error).message}`);
			try { socket.send(JSON.stringify({ type: "abort" })); } catch {}
			release();
			releaseSearch();
		}
		await roomIdle().catch(() => {});
	};

	// --- 1. With no answer running, a message is refused, so the page sends it as its own.
	await scene("1", async () => {
		const mark = frames.length;
		steer("s-idle", "Nothing is running.");
		await waitUntil(() => routed(mark, "s-idle")?.type === "steer_refused", "the idle message is refused");
		assert(calls.length === 0, `a refused message starts no model call, got ${calls.length}`);
		console.log("ok 1 a message with no answer running is refused");
	});

	// --- 2. During a step two messages wait, and both go in after the step, together and as written.
	await scene("2", async () => {
		const before = calls.length;
		const mark = await runSlowStep("Run the slow check.", 2);
		steer("s-step-1", "Only the Friday line, please.");
		steer("s-step-2", "And keep it short.");
		await waitUntil(() => routed(mark, "s-step-1")?.type === "steer_waiting" && routed(mark, "s-step-2")?.type === "steer_waiting", "both wait for the step");
		assert(!routed(mark, "s-step-1").afterText, "a message during a step waits for the step, not for text already finished");
		await waitUntil(() => turnEnded(mark), "the steered turn ended");
		const taken = since(mark).filter((frame) => frame.type === "steer_taken");
		assert(JSON.stringify(taken.map((frame) => [frame.id, frame.text])) === JSON.stringify([["s-step-1", "Only the Friday line, please."], ["s-step-2", "And keep it short."]]), `both are taken, in order, got ${JSON.stringify(taken)}`);
		const stepDone = since(mark).findIndex((frame) => frame.type === "event" && frame.event?.type === "tool_execution_end");
		const firstTaken = since(mark).findIndex((frame) => frame.type === "steer_taken");
		assert(firstTaken > stepDone && stepDone >= 0, "they go in after the step ended");
		const next = calls[before + 1];
		assert(calls.length === before + 2 && next, `one more model call after the step, got ${calls.length - before}: ${JSON.stringify(calls.slice(before).map((call) => call.userTexts.slice(-2)))}`);
		assert(JSON.stringify(next.userTexts.slice(-2)) === JSON.stringify(["Only the Friday line, please.", "And keep it short."]), `the call after the step carries both as written, got ${JSON.stringify(next.userTexts.slice(-2))}`);
		console.log("ok 2 messages sent during a step all go in after it, as written");
	});

	// --- 3. Enter while the model only thinks (nothing shown): it waits, nothing is stopped, and it goes in after the answer.
	await scene("3", async () => {
		legs = [{ held: true, thinking: "Which day was it again", text: "Fridays." }, { text: "Mondays: the import." }];
		holdNextLeg();
		const before = calls.length;
		const mark = frames.length;
		socket.send(JSON.stringify({ type: "prompt", text: "What runs on Fridays?" }));
		await waitUntil(() => has(mark, (frame) => frame.type === "event" && frame.event?.assistantMessageEvent?.type === "thinking_start"), "the model thinks");
		steer("s-thinks", "And on Mondays?", { shown: 0 });
		await waitUntil(() => !!routed(mark, "s-thinks"), "the server routed it");
		const way = routed(mark, "s-thinks");
		const endedEarly = turnEnded(mark);
		release();
		assert(way.type === "steer_waiting" && !way.afterText && !endedEarly, `Enter while it only thinks waits and stops nothing, got ${JSON.stringify(way)}`);
		await waitUntil(() => turnEnded(mark), "the turn ended");
		assert(has(mark, (frame) => frame.type === "steer_taken" && frame.id === "s-thinks") && calls.length === before + 2 && calls.at(-1)!.userTexts.at(-1) === "And on Mondays?", `the thought runs to its answer and the message goes in after it, got ${JSON.stringify(calls.slice(before).map((call) => call.userTexts.at(-1)))}`);
		console.log("ok 3 Enter while it only thinks waits for the answer");
	});

	// --- 4. Enter before anything came back: it waits as while it thinks.
	await scene("4", async () => {
		legs = [{ held: true, silent: true, text: "Fridays." }, { text: "Mondays." }];
		holdNextLeg();
		const before = calls.length;
		const mark = frames.length;
		socket.send(JSON.stringify({ type: "prompt", text: "Which day is the export?" }));
		await waitUntil(() => calls.length === before + 1, "the model was asked");
		steer("s-asking", "And the import?", { shown: 0 });
		await waitUntil(() => !!routed(mark, "s-asking"), "the server routed it");
		const way = routed(mark, "s-asking");
		release();
		assert(way.type === "steer_waiting", `Enter before anything came back waits, got ${JSON.stringify(way)}`);
		await waitUntil(() => turnEnded(mark), "the turn ended");
		assert(calls.length === before + 2 && calls.at(-1)!.userTexts.at(-1) === "And the import?", "it goes in after the answer");
		console.log("ok 4 Enter before anything came back waits");
	});

	// --- 5. Enter while the model writes: the text finishes and the message is answered right after it, in the same turn.
	await scene("5", async () => {
		legs = [{ held: true, lead: "The export runs on Fridays.", text: " Every week." }, { text: "The import runs on Mondays." }];
		holdNextLeg();
		const before = calls.length;
		const mark = frames.length;
		socket.send(JSON.stringify({ type: "prompt", text: "Just the export day." }));
		await waitUntil(() => has(mark, (frame) => frame.type === "event" && frame.event?.type === "message_update"), "the answer is being written");
		steer("s-finish", "And the import day?", { shown: 10 });
		await waitUntil(() => routed(mark, "s-finish")?.type === "steer_waiting", "it waits for the text");
		release();
		await waitUntil(() => turnEnded(mark), "the turn ended");
		assert(since(mark).filter((frame) => frame.type === "event" && frame.event?.type === "agent_end").length === 1, "one turn, nothing cut");
		assert(has(mark, (frame) => frame.type === "steer_taken" && frame.id === "s-finish") && calls.length === before + 2 && calls.at(-1)!.userTexts.at(-1) === "And the import day?", "it is answered right after the text");
		const firstAnswer = since(mark).find((frame) => frame.type === "event" && frame.event?.type === "message_end" && frame.event.message?.role === "assistant");
		assert(textOf(firstAnswer?.event?.message?.content).includes("Every week."), "the answer written before it ran to its end");
		console.log("ok 5 Enter while it writes: the message is answered after the text");
	});

	// --- 6. Cmd/Ctrl+Enter while the model writes: the answer is cut at the characters shown, and the next message says exactly what was seen.
	await scene("6", async () => {
		const lead = "The export runs on Fridays. The import runs on Mondays and the backup runs nightly.";
		const shown = "The export runs on Fridays.".length;
		legs = [{ held: true, lead, text: " More text nobody saw." }];
		holdNextLeg();
		const mark = frames.length;
		socket.send(JSON.stringify({ type: "prompt", text: "Tell me the schedule." }));
		await waitUntil(() => has(mark, (frame) => frame.type === "event" && frame.event?.type === "message_update"), "the answer is being written");
		steer("s-cut", "Thanks, that is all I needed.", { shown, now: true });
		await waitUntil(() => !!routed(mark, "s-cut"), "the server routed it");
		assert(routed(mark, "s-cut").type === "steer_cut" && routed(mark, "s-cut").quiet === false, `the writing answer is cut for it, got ${JSON.stringify(routed(mark, "s-cut"))}`);
		await waitUntil(() => turnEnded(mark), "the cut turn ended");
		release();
		await roomIdle();
		const before = calls.length;
		const next = frames.length;
		socket.send(JSON.stringify({ type: "prompt", text: "Thanks, that is all I needed." }));
		await waitUntil(() => turnEnded(next), "the next turn ended");
		const sent = calls[before]?.userTexts.at(-1) ?? "";
		assert(sent.startsWith(CUT_OPEN) && sent.includes("\n---\nThe export runs on Fridays.\n---\n") && sent.endsWith("[/ANSWER CUT OFF]\n\nThanks, that is all I needed."), `the next message carries the cut note around exactly the shown words, got ${JSON.stringify(sent)}`);
		assert(!sent.includes("Mondays"), "nothing the page did not show is in the note");
		// The note is for one message only.
		const after = calls.length;
		const third = frames.length;
		socket.send(JSON.stringify({ type: "prompt", text: "One more thing." }));
		await waitUntil(() => turnEnded(third), "the third turn ended");
		assert(calls[after]?.userTexts.at(-1) === "One more thing.", `the message after it carries no note, got ${JSON.stringify(calls[after]?.userTexts.at(-1))}`);
		console.log("ok 6 Cmd/Ctrl+Enter cuts at the words shown and the next message says so, once");
	});

	// --- 7. Cmd/Ctrl+Enter with nothing shown yet (it only thinks): a quiet cut, no note; the model gets the two messages back to back.
	await scene("7", async () => {
		legs = [{ held: true, thinking: "Thinking it over" }];
		holdNextLeg();
		const mark = frames.length;
		socket.send(JSON.stringify({ type: "prompt", text: "What runs on Fridays, again?" }));
		await waitUntil(() => has(mark, (frame) => frame.type === "event" && frame.event?.assistantMessageEvent?.type === "thinking_start"), "the model thinks");
		steer("s-quiet", "And on Mondays, again?", { shown: 0, now: true });
		await waitUntil(() => !!routed(mark, "s-quiet"), "the server routed it");
		assert(routed(mark, "s-quiet").type === "steer_cut" && routed(mark, "s-quiet").quiet === true, `nothing shown gives a quiet cut, got ${JSON.stringify(routed(mark, "s-quiet"))}`);
		await waitUntil(() => turnEnded(mark), "the cut turn ended");
		release();
		await roomIdle();
		const before = calls.length;
		const next = frames.length;
		socket.send(JSON.stringify({ type: "prompt", text: "And on Mondays, again?" }));
		await waitUntil(() => turnEnded(next), "the next turn ended");
		const users = calls[before]?.userTexts ?? [];
		assert(users.at(-1) === "And on Mondays, again?" && users.at(-2) === "What runs on Fridays, again?", `no note, the question and the message back to back, got ${JSON.stringify(users.slice(-2))}`);
		console.log("ok 7 Cmd/Ctrl+Enter with nothing shown: a quiet cut and no note");
	});

	// --- 8. A question open before the person typed: the message goes in first, then the question is declined once.
	await scene("8", async () => {
		legs = [{ tool: { name: "bash", args: { command: "echo deleted" } } }, { text: "All right, I left it." }];
		const before = calls.length;
		const mark = frames.length;
		socket.send(JSON.stringify({ type: "prompt", text: "Clean the folder." }));
		await waitUntil(() => !!question(mark), "the command asks first");
		steer("s-decline", "Do not delete anything.", { declines: true });
		await waitUntil(() => turnEnded(mark), "the turn ended");
		assert(routed(mark, "s-decline")?.type === "steer_waiting", "the message waits for the step it declines");
		assert(has(mark, (frame) => frame.type === "ui_request_closed" && frame.id === question(mark).id && frame.reason === "declined"), "the card is told it was declined");
		const next = calls[before + 1];
		assert(next && next.toolTexts.at(-1)?.includes(DECLINED) && next.userTexts.at(-1) === "Do not delete anything." && next.roles.at(-1) === "user" && next.roles.at(-2) === "tool", `the model reads the declined step, then the message, got ${JSON.stringify(next)}`);
		console.log("ok 8 a question open before the message is declined once by it");
	});

	// --- 9. A question that opened after the person started typing: the message waits, the question stays; allowed, the step runs and the message goes in after it.
	await scene("9", async () => {
		legs = [{ tool: { name: "bash", args: { command: "echo kept" } } }, { text: "Done." }];
		const before = calls.length;
		const mark = frames.length;
		socket.send(JSON.stringify({ type: "prompt", text: "Echo something." }));
		await waitUntil(() => !!question(mark), "the command asks first");
		steer("s-waits", "Then tell me the time.");
		await waitUntil(() => routed(mark, "s-waits")?.type === "steer_waiting", "the message waits");
		// Nothing to wait on for something that must not happen: the next frames the room sends are checked instead.
		socket.send(JSON.stringify({ type: "ui_response", id: question(mark).id, value: true }));
		await waitUntil(() => turnEnded(mark), "the turn ended");
		assert(!has(mark, (frame) => frame.type === "ui_request_closed"), "the question stayed open until the person answered it");
		const next = calls[before + 1];
		assert(next && next.toolTexts.at(-1)?.includes("kept") && next.userTexts.at(-1) === "Then tell me the time.", `the step ran, then the message went in, got ${JSON.stringify(next)}`);
		console.log("ok 9 a question opened after the person typed stays, and the message waits for it");
	});

	// --- 10. Cmd/Ctrl+Enter during a step stops it, and the message goes next.
	await scene("10", async () => {
		const mark = await runSlowStep("Run a long command.", 20);
		steer("s-now", "Stop that, use the cached file.", { now: true });
		await waitUntil(() => !!routed(mark, "s-now"), "the server routed it");
		assert(routed(mark, "s-now").type === "steer_cut", `now stops the step, got ${JSON.stringify(routed(mark, "s-now"))}`);
		await waitUntil(() => turnEnded(mark), "the stopped turn ended", 10_000);
		console.log("ok 10 Cmd/Ctrl+Enter stops a running step for the message");
	});

	// --- 11. Stop hands back what the runtime has not taken, and the next message carries Stop's note.
	await scene("11", async () => {
		const lead = "First part of a long answer that keeps going";
		const mark = await runSlowStep("Run it once more.", 3, [{ held: true, lead }]);
		steer("s-stop", "Never mind the import.");
		await waitUntil(() => routed(mark, "s-stop")?.type === "steer_waiting", "it waits");
		socket.send(JSON.stringify({ type: "abort", shown: 0 }));
		await waitUntil(() => has(mark, (frame) => frame.type === "steer_returned"), "the message comes back");
		const returned = since(mark).filter((frame) => frame.type === "steer_returned");
		assert(returned.length === 1 && JSON.stringify(returned[0].messages) === JSON.stringify([{ id: "s-stop", text: "Never mind the import." }]), `Stop hands it back once, with its id, got ${JSON.stringify(returned)}`);
		await waitUntil(() => turnEnded(mark), "the stopped turn ended");
		assert(!has(mark, (frame) => frame.type === "steer_taken"), "a message handed back was never taken");
		await roomIdle();
		// Stopped while writing, with words shown: the next message carries Stop's note.
		legs = [{ held: true, lead: "The schedule has three lines. The export" }];
		holdNextLeg();
		const writing = frames.length;
		socket.send(JSON.stringify({ type: "prompt", text: "Tell me the schedule again." }));
		await waitUntil(() => has(writing, (frame) => frame.type === "event" && frame.event?.type === "message_update"), "the answer is being written");
		socket.send(JSON.stringify({ type: "abort", shown: "The schedule has three lines.".length }));
		await waitUntil(() => turnEnded(writing), "the stopped turn ended");
		release();
		await roomIdle();
		const before = calls.length;
		const next = frames.length;
		legs = [{ text: "Here is the summary." }];
		socket.send(JSON.stringify({ type: "prompt", text: "Summarise what you know." }));
		await waitUntil(() => turnEnded(next), "the next turn ended");
		const sent = calls[before]?.userTexts.at(-1) ?? "";
		assert(sent.startsWith(STOP_OPEN) && sent.includes("\n---\nThe schedule has three lines.\n---\n") && sent.endsWith("Summarise what you know."), `the next message carries Stop's note, got ${JSON.stringify(sent)}`);
		assert(!calls.slice(before).flatMap((call) => call.userTexts).some((text) => text.includes("Never mind the import.")), "the handed-back message rides into no later message");
		console.log("ok 11 Stop hands back the untaken message and the next message carries Stop's note");
	});

	// --- 12. The page sends the message a cut was for the moment the cut answer ends: it goes in, never refused as a running turn.
	await scene("12", async () => {
		legs = [{ held: true, lead: "The export runs on Fridays. The import runs on Mondays.", text: " More text nobody saw." }];
		holdNextLeg();
		const mark = frames.length;
		socket.send(JSON.stringify({ type: "prompt", text: "Tell me the schedule once more." }));
		await waitUntil(() => has(mark, (frame) => frame.type === "event" && frame.event?.type === "message_update"), "the answer is being written");
		const sendOnEnd = (event: any) => {
			let frame: any = null;
			try { frame = JSON.parse(String(event.data)); } catch {}
			if (frame?.type !== "event" || frame.event?.type !== "agent_end") return;
			socket.removeEventListener("message", sendOnEnd);
			socket.send(JSON.stringify({ type: "prompt", text: "Only Fridays, please." }));
		};
		socket.addEventListener("message", sendOnEnd);
		steer("s-cut-now", "Only Fridays, please.", { shown: "The export runs on Fridays.".length, now: true });
		await waitUntil(() => since(mark).filter((frame) => frame.type === "event" && frame.event?.type === "agent_end").length >= 2 || has(mark, (frame) => frame.type === "error"), "the next turn ended or was refused");
		release();
		const refused = since(mark).find((frame) => frame.type === "error");
		assert(!refused, `the message sent at the cut's end goes in, got ${JSON.stringify(refused)}`);
		assert(calls.at(-1)?.userTexts.at(-1)?.endsWith("[/ANSWER CUT OFF]\n\nOnly Fridays, please.") === true, `it carries the cut's note, got ${JSON.stringify(calls.at(-1)?.userTexts.at(-1))}`);
		console.log("ok 12 the message sent the moment a cut answer ends goes in at once");
	});

	// --- 13. The same, but the window closes while the message waits for the cut turn to close: nothing starts from it.
	await scene("13", async () => {
		legs = [{ held: true, lead: "The export runs on Fridays. The import runs on Mondays.", text: " More text nobody saw." }];
		holdNextLeg();
		const mark = frames.length;
		socket.send(JSON.stringify({ type: "prompt", text: "Tell me the schedule a last time." }));
		await waitUntil(() => has(mark, (frame) => frame.type === "event" && frame.event?.type === "message_update"), "the answer is being written");
		const closing = socket;
		const sendThenClose = (event: any) => {
			let frame: any = null;
			try { frame = JSON.parse(String(event.data)); } catch {}
			if (frame?.type !== "event" || frame.event?.type !== "agent_end") return;
			closing.removeEventListener("message", sendThenClose);
			closing.send(JSON.stringify({ type: "prompt", text: "Sent as the window closed." }));
			closing.close();
		};
		closing.addEventListener("message", sendThenClose);
		steer("s-cut-close", "Sent as the window closed.", { shown: "The export runs on Fridays.".length, now: true });
		await waitUntil(() => turnEnded(mark), "the cut turn ended");
		release();
		await roomIdle();
		socket = await connect();
		await roomIdle();
		const started = calls.filter((call) => call.userTexts.at(-1)?.endsWith("Sent as the window closed."));
		assert(started.length === 0, `a message from a window that closed while it waited starts no model call, got ${started.length}`);
		console.log("ok 13 a window that closes while its message waits starts nothing");
	});

	// --- 13b. The same in a window that stepped back into the running turn: the message sent at the cut's end goes in.
	await scene("13b", async () => {
		legs = [{ held: true, lead: "The export runs on Fridays. The import runs on Mondays.", text: " More text nobody saw." }, { text: "Mondays: the import." }];
		holdNextLeg();
		const mark = frames.length;
		socket.send(JSON.stringify({ type: "prompt", text: "Tell me the schedule from the top." }));
		await waitUntil(() => has(mark, (frame) => frame.type === "event" && frame.event?.type === "message_update"), "the answer is being written");
		socket.close();
		await roomDetached();
		const back = frames.length;
		socket = await connect();
		await waitUntil(() => has(back, (frame) => frame.type === "turn_reattach_replay_done"), "the window stepped back in");
		const adopted = socket;
		const sendOnEnd = (event: any) => {
			let frame: any = null;
			try { frame = JSON.parse(String(event.data)); } catch {}
			if (frame?.type !== "event" || frame.event?.type !== "agent_end") return;
			adopted.removeEventListener("message", sendOnEnd);
			adopted.send(JSON.stringify({ type: "prompt", text: "Only Mondays, please." }));
		};
		adopted.addEventListener("message", sendOnEnd);
		steer("s-cut-adopted", "Only Mondays, please.", { shown: "The export runs on Fridays.".length, now: true });
		await waitUntil(() => routed(back, "s-cut-adopted")?.type === "steer_cut", "the adopted answer is cut");
		release();
		await waitUntil(() => calls.some((call) => call.userTexts.at(-1)?.endsWith("Only Mondays, please.")) || has(back, (frame) => frame.type === "error"), "the next message reached the model or was refused");
		const refused = since(back).find((frame) => frame.type === "error");
		assert(!refused, `the message sent at the adopted cut's end goes in, got ${JSON.stringify(refused)}`);
		await waitUntil(() => since(back).filter((frame) => frame.type === "event" && frame.event?.type === "agent_end").length >= 2, "the next turn ended");
		// The window leaves before it saved anything: both turns land, each prompt before its answer.
		socket.close();
		await roomIdle();
		const items = await threadOnceLanded((landed) => landed.some((item) => item.kind === "assistant" && String(item.text).includes("Mondays: the import.")), "the next answer landed");
		const at = (kind: string, text: string) => items.findIndex((item) => item.kind === kind && String(item.text ?? "").startsWith(text));
		const order = [at("user", "Tell me the schedule from the top."), at("assistant", "The export runs on Fridays."), at("user", "Only Mondays, please."), at("assistant", "Mondays: the import.")];
		assert(order.every((index, i) => index >= 0 && (i === 0 || index > order[i - 1])), `both turns land in order, got ${JSON.stringify(items.map((item) => `${item.kind}:${String(item.text ?? "").slice(0, 24)}`).slice(-6))}`);
		socket = await connect();
		console.log("ok 13b in a window that stepped back in, the message sent at the cut's end goes in, and both turns land");
	});

	// --- 13e. The page saves the message sent at the adopted cut's end before its turn starts, then its unfinished answer, and the window leaves: the message lands once, after the cut answer, and the whole answer replaces the unfinished one.
	await scene("13e", async () => {
		const first = "What runs this week?";
		const next = "Only Fridays, please.";
		legs = [{ held: true, lead: "The export runs on Fridays. The import runs on Mondays.", text: " More text nobody saw." }, { held: true, lead: "Fridays only", text: ": the export." }];
		holdNextLeg();
		const mark = frames.length;
		socket.send(JSON.stringify({ type: "prompt", text: first }));
		await waitUntil(() => has(mark, (frame) => frame.type === "event" && frame.event?.type === "message_update"), "the answer is being written");
		socket.close();
		await roomDetached();
		const back = frames.length;
		// The message waits between its arrival and its turn's start, as a settings rebind holds it: the page's save lands in that wait.
		socket = await connect(model, conversationId, "&testPromptStartDelayMs=2000");
		await waitUntil(() => has(back, (frame) => frame.type === "turn_reattach_replay_done"), "the window stepped back in");
		const adopted = socket;
		const sendOnEnd = (event: any) => {
			let frame: any = null;
			try { frame = JSON.parse(String(event.data)); } catch {}
			if (frame?.type !== "event" || frame.event?.type !== "agent_end") return;
			adopted.removeEventListener("message", sendOnEnd);
			adopted.send(JSON.stringify({ type: "prompt", text: next }));
		};
		adopted.addEventListener("message", sendOnEnd);
		steer("s-cut-saved", next, { shown: "The export runs on Fridays.".length, now: true });
		await waitUntil(() => routed(back, "s-cut-saved")?.type === "steer_cut", "the adopted answer is cut");
		release();
		holdNextLeg();
		const cutLanded = await threadOnceLanded((landed) => landed.some((item) => item.kind === "user" && item.text === first) && landed.some((item) => item.kind === "assistant" && String(item.text).startsWith("The export runs on Fridays.")), "the cut answer landed");
		const writing = frames.length;
		const promptSave = await json(threadPath, { method: "PUT", body: JSON.stringify({ state: (await json(threadPath)).body?.thread?.state ?? "active", origin: "unknown", model, items: [...cutLanded, { kind: "user", id: "u-13e-next", text: next, ts: Date.now() }] }) });
		assert(promptSave.status === 200, `the page saved the message, got ${promptSave.status} ${JSON.stringify(promptSave.body)}`);
		await waitUntil(() => has(writing, (frame) => frame.type === "event" && frame.event?.type === "message_update"), "the next answer is being written");
		const current = (await json(threadPath)).body?.thread;
		const partialSave = await json(threadPath, { method: "PUT", body: JSON.stringify({ state: current?.state ?? "active", origin: "unknown", model, items: [...(current?.items ?? []), { kind: "assistant", id: "a-13e-partial", text: "Fridays only", streaming: true }] }) });
		assert(partialSave.status === 200, `the page saved the unfinished answer, got ${partialSave.status} ${JSON.stringify(partialSave.body)}`);
		socket.close();
		await roomDetached();
		release();
		await roomIdle();
		const items = await threadOnceLanded((landed) => landed.some((item) => item.kind === "assistant" && String(item.text).includes("Fridays only: the export.")), "the next answer landed");
		const shown = items.map((item) => `${item.kind}:${String(item.text ?? "").slice(0, 24)}`).slice(-6);
		assert(items.filter((item) => item.kind === "user" && item.text === next).length === 1, `the message lands once, got ${JSON.stringify(shown)}`);
		assert(!items.some((item) => item.kind === "assistant" && item.text === "Fridays only"), `the unfinished answer gives way to the whole one, got ${JSON.stringify(shown)}`);
		// The last match: case 13b landed the same first answer earlier in this conversation.
		const at = (kind: string, text: string) => {
			for (let i = items.length - 1; i >= 0; i--) if (items[i].kind === kind && String(items[i].text ?? "").startsWith(text)) return i;
			return -1;
		};
		const order = [at("user", first), at("assistant", "The export runs on Fridays."), at("user", next), at("assistant", "Fridays only: the export.")];
		assert(order.every((index, i) => index >= 0 && (i === 0 || index > order[i - 1])), `both turns land in order, got ${JSON.stringify(shown)}`);
		socket = await connect();
		console.log("ok 13e a message the page saved before its turn started lands once after the adopted cut, and its whole answer replaces the unfinished one");
	});

	// --- 13c. A message after a Stop that fails goes back to the box with the person's own words, and carries the note again when sent again; a Stop that names no count tells the model nothing.
	await scene("13c", async () => {
		legs = [{ held: true, lead: "The schedule has three lines. The export" }, { refused: "messages: this request is not accepted" }];
		holdNextLeg();
		const writing = frames.length;
		socket.send(JSON.stringify({ type: "prompt", text: "Tell me the schedule one more time." }));
		await waitUntil(() => has(writing, (frame) => frame.type === "event" && frame.event?.type === "message_update"), "the answer is being written");
		socket.send(JSON.stringify({ type: "abort", shown: "The schedule has three lines.".length }));
		await waitUntil(() => turnEnded(writing), "the stopped turn ended");
		release();
		await roomIdle();
		const failing = frames.length;
		socket.send(JSON.stringify({ type: "prompt", text: "Which line runs first?" }));
		await waitUntil(() => has(failing, (frame) => frame.type === "prompt_returned") || (turnEnded(failing) && has(failing, (frame) => frame.type === "event" && frame.event?.failure)), "the failed message was handed back or left above");
		await roomIdle();
		const returned = since(failing).find((frame) => frame.type === "prompt_returned");
		assert(returned?.text === "Which line runs first?", `the failed message goes back with the person's own words, got ${JSON.stringify(returned ?? since(failing).filter((frame) => frame.type !== "event").map((frame) => frame.type))}`);
		socket.send(JSON.stringify({ type: "returned_prompt_handled", kept: false }));
		const before = calls.length;
		const again = frames.length;
		legs = [{ text: "The export." }];
		socket.send(JSON.stringify({ type: "prompt", text: "Which line runs first?" }));
		await waitUntil(() => turnEnded(again), "the message sent again was answered");
		const sent = calls[before]?.userTexts.at(-1) ?? "";
		assert(sent.startsWith(STOP_OPEN) && sent.includes("\n---\nThe schedule has three lines.\n---\n") && sent.endsWith("Which line runs first?"), `sent again, it carries Stop's note, got ${JSON.stringify(sent)}`);
		await roomIdle();
		// A Stop with no count from the page: nobody knows what was on screen, so the model is told nothing.
		legs = [{ held: true, lead: "A long answer the page may not have shown yet." }];
		holdNextLeg();
		const bare = frames.length;
		socket.send(JSON.stringify({ type: "prompt", text: "Write a long answer." }));
		await waitUntil(() => has(bare, (frame) => frame.type === "event" && frame.event?.type === "message_update"), "the answer is being written");
		socket.send(JSON.stringify({ type: "abort" }));
		await waitUntil(() => turnEnded(bare), "the stopped turn ended");
		release();
		await roomIdle();
		const after = calls.length;
		const next = frames.length;
		legs = [{ text: "Sure." }];
		socket.send(JSON.stringify({ type: "prompt", text: "Something else." }));
		await waitUntil(() => turnEnded(next), "the next turn ended");
		assert(calls[after]?.userTexts.at(-1) === "Something else.", `a Stop with no count carries no note, got ${JSON.stringify(calls[after]?.userTexts.at(-1))}`);
		console.log("ok 13c a failed message after a Stop goes back as typed and keeps its note; a Stop with no count adds none");
	});

	// --- 13d. Cmd/Ctrl+Enter while a question is open: the question is declined by the message, not by Stop.
	await scene("13d", async () => {
		legs = [{ tool: { name: "bash", args: { command: "echo removed" } } }];
		const mark = frames.length;
		socket.send(JSON.stringify({ type: "prompt", text: "Tidy the folder." }));
		await waitUntil(() => !!question(mark), "the command asks first");
		steer("s-now-question", "Leave it, do nothing.", { now: true });
		await waitUntil(() => routed(mark, "s-now-question")?.type === "steer_cut", "the answer stops for the message");
		await waitUntil(() => turnEnded(mark), "the stopped turn ended");
		const closed = since(mark).find((frame) => frame.type === "ui_request_closed" && frame.id === question(mark).id);
		assert(closed?.reason === "declined", `the card is told the message declined it, got ${JSON.stringify(closed)}`);
		await roomIdle();
		console.log("ok 13d Cmd/Ctrl+Enter declines an open question by the message");
	});

	// --- 14. A turn that lands while nobody watches lands the message it took, once, before its answer, even when the page saved its bubble.
	await scene("14", async () => {
		const text = "Also list the failures.";
		// A fresh window, as after a reload: the cases above sent messages this smoke never saved, which a landing would count as earlier turns.
		socket.close();
		await roomIdle();
		socket = await connect();
		const mark = await runSlowStep("Run the nightly check.", 3, [{ text: "The nightly check passed." }]);
		steer("s-away", text);
		await waitUntil(() => has(mark, (frame) => frame.type === "steer_taken" && frame.id === "s-away"), "the room took it");
		// The page saves the taken message as its own bubble, as it does while it watches.
		const saved = (await json(threadPath)).body?.thread;
		const pageSave = await json(threadPath, { method: "PUT", body: JSON.stringify({ state: saved?.state ?? "active", origin: "unknown", model, items: [...(saved?.items ?? []), { kind: "user", id: "out-s-away", text, ts: Date.now() }] }) });
		assert(pageSave.status === 200, `the page's save went in, got ${pageSave.status} ${JSON.stringify(pageSave.body)}`);
		socket.close();
		await roomIdle();
		const items = await threadOnceLanded((landed) => landed.some((item) => item.kind === "assistant" && String(item.text).includes("The nightly check passed.")), "the answer landed");
		const copies = items.filter((item) => item.kind === "user" && item.text === text);
		const answer = items.findIndex((item) => item.kind === "assistant" && String(item.text).includes("The nightly check passed."));
		assert(copies.length === 1 && copies[0].steered === true && items.indexOf(copies[0]) < answer, `the taken message lands once, before the answer, got ${JSON.stringify(items.map((item) => [item.kind, item.id, String(item.text ?? item.name ?? "").slice(0, 30)]))}`);
		socket = await connect();
		console.log("ok 14 a landing keeps the message the turn took, once, before its answer");
	});

	// --- 14b. A taken message and then the window leaves while the answer streams: the turn's own prompt lands, and the message once.
	await scene("14b", async () => {
		socket.close();
		await roomIdle();
		socket = await connect();
		legs = [{ tool: { name: "bash", args: { command: "sleep 2" } } }, { held: true, lead: "Both lines, then.", text: " Done." }];
		const mark = frames.length;
		socket.send(JSON.stringify({ type: "prompt", text: "Check the export line." }));
		await waitUntil(() => !!question(mark), "the command asks first");
		socket.send(JSON.stringify({ type: "ui_response", id: question(mark).id, value: true }));
		await waitUntil(() => has(mark, (frame) => frame.type === "event" && frame.event?.type === "tool_execution_start"), "the step runs");
		holdNextLeg();
		steer("s-also", "Check the import line too.");
		await waitUntil(() => has(mark, (frame) => frame.type === "steer_taken" && frame.id === "s-also"), "the room took it");
		await waitUntil(() => calls.at(-1)?.userTexts.at(-1) === "Check the import line too.", "the answer to both streams");
		socket.close();
		await roomDetached();
		release();
		await roomIdle();
		const items = await threadOnceLanded((landed) => landed.some((item) => item.kind === "assistant" && String(item.text).includes("Both lines, then.")), "the answer landed");
		const prompts = items.filter((item) => item.kind === "user" && item.text === "Check the export line.");
		const steers = items.filter((item) => item.kind === "user" && item.text === "Check the import line too.");
		assert(prompts.length === 1 && steers.length === 1 && items.indexOf(prompts[0]) < items.indexOf(steers[0]), `the prompt lands once and the message once after it, got ${JSON.stringify(items.map((item) => `${item.kind}:${String(item.text ?? item.name ?? "").slice(0, 24)}`).slice(-6))}`);
		socket = await connect();
		console.log("ok 14b a landing keeps the turn's own prompt when a taken message changed its consent");
	});

	// --- 15. A window that stepped back into a running turn steers it, and its Stop lands only the words it showed.
	await scene("15", async () => {
		await runSlowStep("Run the weekly check.", 3, [{ text: "The weekly check passed." }]);
		socket.close();
		await roomDetached();
		const back = frames.length;
		socket = await connect();
		await waitUntil(() => has(back, (frame) => frame.type === "turn_reattach_replay_done"), "the window stepped back in");
		steer("s-back", "Only the failures, please.");
		await waitUntil(() => !!routed(back, "s-back"), "the server routed it");
		assert(routed(back, "s-back").type === "steer_waiting", `the adopted turn takes the message after its step, got ${JSON.stringify(routed(back, "s-back"))}`);
		await waitUntil(() => turnEnded(back), "the adopted turn ended");
		assert(has(back, (frame) => frame.type === "steer_taken" && frame.id === "s-back") && calls.at(-1)?.userTexts.at(-1) === "Only the failures, please.", "the message went in after the step");
		await roomIdle();
		// Stop in a window that stepped back in: the landing keeps only the words that window showed.
		// The page counts the text as written, the blank line in front included.
		const lead = "\n\nThe export runs on Fridays. The import runs on Mondays and the backup runs nightly.";
		const shown = "The export runs on Fridays.";
		legs = [{ held: true, lead, text: " Never sent." }];
		holdNextLeg();
		const writing = frames.length;
		socket.send(JSON.stringify({ type: "prompt", text: "Tell me the whole schedule." }));
		await waitUntil(() => has(writing, (frame) => frame.type === "event" && frame.event?.type === "message_update"), "the answer is being written");
		socket.close();
		await roomDetached();
		const again = frames.length;
		socket = await connect();
		await waitUntil(() => has(again, (frame) => frame.type === "turn_reattach_replay_done"), "the window stepped back in again");
		socket.send(JSON.stringify({ type: "abort", shown: shown.length + 2 }));
		await waitUntil(() => turnEnded(again), "the stopped turn ended");
		release();
		await roomIdle();
		const items = await threadOnceLanded((landed) => landed.some((item) => item.kind === "assistant" && String(item.text).includes("export")), "the stopped answer landed");
		const landed = [...items].reverse().find((item) => item.kind === "assistant");
		assert(landed && String(landed.text).trim() === shown, `the landing keeps exactly the words shown, got ${JSON.stringify(landed?.text)}`);
		console.log("ok 15 a window that stepped back in steers the turn, and its Stop lands only the words shown");
	});

	// --- 15b. A reload during a step with two messages waiting: the window that steps back in is told both, on ready and on turn_reattach; once the room took them, a second window's ready names them as taken and nothing waiting.
	await scene("15b", async () => {
		// The step runs until the scene opens its gate, after both windows were told what waits.
		const gate = path.join(tempRoot, "gate-15b");
		holdNextLeg();
		legs = [{ tool: { name: "bash", args: { command: `until [ -e '${gate}' ]; do sleep 0.1; done` } } }, { held: true, lead: "The monthly check", text: " passed." }];
		const mark = frames.length;
		socket.send(JSON.stringify({ type: "prompt", text: "Run the monthly check." }));
		await waitUntil(() => !!question(mark), "the command asks first");
		socket.send(JSON.stringify({ type: "ui_response", id: question(mark).id, value: true }));
		await waitUntil(() => has(mark, (frame) => frame.type === "event" && frame.event?.type === "tool_execution_start"), "the step runs");
		const both = [{ id: "s-wait-1", text: "Only the failures." }, { id: "s-wait-2", text: "And keep it short." }];
		for (const message of both) steer(message.id, message.text);
		await waitUntil(() => both.every((message) => routed(mark, message.id)?.type === "steer_waiting"), "both wait for the step");
		socket.close();
		await roomDetached();
		const back = frames.length;
		socket = await connect();
		await waitUntil(() => has(back, (frame) => frame.type === "turn_reattach_replay_done"), "the window stepped back in");
		const ready = since(back).find((frame) => frame.type === "ready");
		const reattach = since(back).find((frame) => frame.type === "turn_reattach");
		assert(JSON.stringify(ready?.waiting) === JSON.stringify(both) && ready?.reattaching === true, `ready lists both waiting messages, got ${JSON.stringify({ waiting: ready?.waiting, reattaching: ready?.reattaching })}`);
		assert(JSON.stringify(reattach?.waiting) === JSON.stringify(both), `turn_reattach lists both waiting messages, got ${JSON.stringify(reattach?.waiting)}`);
		fs.writeFileSync(gate, "");
		await waitUntil(() => both.every((message) => has(back, (frame) => frame.type === "steer_taken" && frame.id === message.id)), "the room took both after the step");
		// A second window while the answer to both is written.
		const first = socket;
		const second = frames.length;
		socket = await connect();
		const secondReady = since(second).find((frame) => frame.type === "ready");
		assert(JSON.stringify(secondReady?.waiting) === "[]" && both.every((message) => secondReady?.taken?.includes(message.id)), `a second window's ready names both as taken and none waiting, got ${JSON.stringify({ waiting: secondReady?.waiting, taken: secondReady?.taken })}`);
		release();
		await waitUntil(() => turnEnded(second), "the turn ended in the second window");
		first.close();
		await roomIdle();
		console.log("ok 15b a reload during a step is told the waiting messages, and a second window which ones the room took");
	});

	// --- 15e. A second window opened beside the window that answers, which stays: the running answer is not the new window's, so its ready lists nothing waiting and no reattach follows; the answering window's messages still go in after the step.
	await scene("15e", async () => {
		const gate = path.join(tempRoot, "gate-15e");
		legs = [{ tool: { name: "bash", args: { command: `until [ -e '${gate}' ]; do sleep 0.1; done` } } }, { text: "The weekly check passed." }];
		const mark = frames.length;
		socket.send(JSON.stringify({ type: "prompt", text: "Run the weekly check." }));
		await waitUntil(() => !!question(mark), "the command asks first");
		socket.send(JSON.stringify({ type: "ui_response", id: question(mark).id, value: true }));
		await waitUntil(() => has(mark, (frame) => frame.type === "event" && frame.event?.type === "tool_execution_start"), "the step runs");
		const both = [{ id: "s-beside-1", text: "Only the errors." }, { id: "s-beside-2", text: "In one line." }];
		for (const message of both) steer(message.id, message.text);
		await waitUntil(() => both.every((message) => routed(mark, message.id)?.type === "steer_waiting"), "both wait for the step");
		const beside = frames.length;
		const other = await connect();
		const ready = since(beside).find((frame) => frame.type === "ready");
		assert(JSON.stringify(ready?.waiting) === "[]" && ready?.reattaching === false, `a window beside the answering one lists nothing waiting and no reattach, got ${JSON.stringify({ waiting: ready?.waiting, reattaching: ready?.reattaching })}`);
		fs.writeFileSync(gate, "");
		await waitUntil(() => both.every((message) => has(mark, (frame) => frame.type === "steer_taken" && frame.id === message.id)), "the answering window's messages go in after the step");
		await waitUntil(() => turnEnded(mark), "the answer ended");
		assert(!has(beside, (frame) => frame.type === "turn_reattach"), "no turn_reattach reached the window beside");
		// The room's lock went to the window beside: the scenes after this start from a fresh window.
		other.close();
		socket.close();
		await roomIdle();
		socket = await connect();
		console.log("ok 15e a window beside the answering one is told nothing waiting, and the answering window keeps its messages");
	});

	// --- 16. Stop while the page still shows the rest of a finished answer, then the page is gone before it saves: the landing keeps the words shown.
	await scene("16", async () => {
		const shown = "The backup runs nightly.";
		legs = [{ text: `${shown} The restore drill runs every quarter and takes an hour.` }];
		const mark = frames.length;
		socket.send(JSON.stringify({ type: "prompt", text: "When does the backup run?" }));
		await waitUntil(() => turnEnded(mark), "the model finished");
		socket.send(JSON.stringify({ type: "stop_reveal", shown: shown.length }));
		socket.close();
		await roomIdle();
		const items = await threadOnceLanded((landed) => landed.some((item) => item.kind === "assistant" && String(item.text).includes("backup")), "the answer landed");
		const landed = [...items].reverse().find((item) => item.kind === "assistant");
		assert(landed && String(landed.text).trim() === shown, `the landing keeps exactly the words shown, got ${JSON.stringify(landed?.text)}`);
		socket = await connect();
		const before = calls.length;
		legs = [{ text: "Noted." }];
		const next = frames.length;
		socket.send(JSON.stringify({ type: "prompt", text: "Thanks." }));
		await waitUntil(() => turnEnded(next), "the next turn ended");
		const told = calls.slice(before)[0]?.userTexts.at(-1) ?? "";
		assert(told.startsWith(STOP_OPEN) && told.includes(shown) && !told.includes("restore drill"), `the next message tells the model what was on screen, got ${JSON.stringify(told.slice(0, 80))}`);
		console.log("ok 16 Stop on a finished answer keeps the words shown, even when the page never saved");
	});

	// --- 16c. A saved steered message is no prompt of its own: a later turn's landing keeps the earlier turn's answer and adds its own prompt.
	await scene("16c", async () => {
		socket.close();
		await roomIdle();
		socket = await connect();
		const first = await runSlowStep("Count the notes.", 2, [{ text: "Two notes, and here they are." }]);
		steer("s-count", "And name them.");
		await waitUntil(() => turnEnded(first), "the first turn ended");
		await roomIdle();
		legs = [{ held: true, lead: "The second answer starts here.", text: " And ends here." }];
		holdNextLeg();
		const second = frames.length;
		socket.send(JSON.stringify({ type: "prompt", text: "What else is in the folder?" }));
		await waitUntil(() => has(second, (frame) => frame.type === "event" && frame.event?.type === "message_update"), "the second answer is being written");
		// The page's save comes late: the first turn whole, its steered bubble marked, before the second prompt.
		const current = (await json(threadPath)).body?.thread;
		const saved: any[] = current?.items ?? [];
		const late = [...saved, { kind: "user", id: "u-count", text: "Count the notes.", ts: Date.now() }, { kind: "user", id: "out-s-count", text: "And name them.", ts: Date.now(), steered: true }, { kind: "assistant", id: "a-count", text: "Two notes, and here they are.", ts: Date.now() }];
		// The page keeps the conversation's state while an answer runs: a parked conversation stays parked.
		const lateSave = await json(threadPath, { method: "PUT", body: JSON.stringify({ state: current?.state ?? "active", origin: "unknown", model, items: late }) });
		assert(lateSave.status === 200, `the late save went in, got ${lateSave.status} ${JSON.stringify(lateSave.body).slice(0, 300)}`);
		socket.close();
		await roomDetached();
		release();
		await roomIdle();
		const items = await threadOnceLanded((landed) => landed.some((item) => item.kind === "assistant" && String(item.text).includes("The second answer starts here.")), "the second answer landed");
		const order = items.map((item) => `${item.kind}:${String(item.text ?? item.name ?? "").slice(0, 24)}`);
		const at = (text: string) => items.findIndex((item) => String(item.text ?? "").startsWith(text));
		assert(at("Two notes") >= 0 && at("What else is in the folder?") > at("Two notes") && at("The second answer starts here.") > at("What else is in the folder?"), `the first answer stays and the second prompt lands before its answer, got ${JSON.stringify(order)}`);
		socket = await connect();
		console.log("ok 16c a saved steered message is not counted as a later turn's prompt");
	});

	// --- 16d. A reveal stopped before any of the last answer showed, then the page is gone: the prompt and the steps still land.
	await scene("16d", async () => {
		const asked = "List the files, quickly.";
		legs = [{ tool: { name: "bash", args: { command: "ls" } } }, { text: "Here is the list of files." }];
		const mark = frames.length;
		socket.send(JSON.stringify({ type: "prompt", text: asked }));
		await waitUntil(() => !!question(mark), "the command asks first");
		socket.send(JSON.stringify({ type: "ui_response", id: question(mark).id, value: true }));
		await waitUntil(() => turnEnded(mark), "the model finished");
		socket.send(JSON.stringify({ type: "stop_reveal", shown: 0 }));
		socket.close();
		await roomIdle();
		const items = await threadOnceLanded((landed) => landed.some((item) => item.kind === "user" && item.text === asked), "the prompt landed");
		const prompt = items.findIndex((item) => item.kind === "user" && item.text === asked);
		assert(items.slice(prompt).some((item) => item.kind === "tool" && item.name === "bash"), `the step lands after the prompt, got ${JSON.stringify(items.slice(prompt).map((item) => item.kind))}`);
		assert(!items.some((item) => item.kind === "assistant" && String(item.text).includes("Here is the list of files.")), "the answer nobody saw does not land");
		socket = await connect();
		console.log("ok 16d a reveal stopped at nothing still lands the prompt and its steps");
	});

	// --- 16e. One answer holds at most 20 waiting messages: the 21st is refused and queues nothing, the first 20 all go in after the step.
	await scene("16e", async () => {
		const before = calls.length;
		const mark = await runSlowStep("Run the long check.", 3, [{ text: "Read all of them." }]);
		for (let n = 1; n <= 21; n++) steer(`s-cap-${n}`, `Note ${n}.`);
		await waitUntil(() => Array.from({ length: 21 }, (_, i) => routed(mark, `s-cap-${i + 1}`)).every(Boolean), "all 21 were routed");
		const waiting = Array.from({ length: 20 }, (_, i) => routed(mark, `s-cap-${i + 1}`)?.type);
		assert(waiting.every((type) => type === "steer_waiting") && routed(mark, "s-cap-21")?.type === "steer_refused", `the first 20 wait and the 21st is refused, got ${JSON.stringify([...waiting, routed(mark, "s-cap-21")?.type])}`);
		await waitUntil(() => turnEnded(mark), "the turn ended");
		const taken = since(mark).filter((frame) => frame.type === "steer_taken").map((frame) => frame.id);
		assert(taken.length === 20 && !taken.includes("s-cap-21"), `the first 20 are taken, the refused one never is, got ${taken.length}: ${JSON.stringify(taken.slice(-2))}`);
		const after = calls[before + 1]?.userTexts ?? [];
		assert(after.at(-1) === "Note 20." && !after.includes("Note 21."), `the call after the step carries the first 20 only, got ${JSON.stringify(after.slice(-2))}`);
		await roomIdle();
		console.log("ok 16e one answer holds at most 20 waiting messages");
	});

	// --- Keyed turns (thread-items-by-id.ts): the page names its question, the server names what the turn makes, and a save is merged by id.
	// Each scene runs in a conversation of its own; the page's saves are played by hand, under the ids the frames named.
	const answeredAsks = new Set<string>();
	const approveAsked = (mark: number) => {
		for (const frame of since(mark)) {
			if (frame.type !== "ui_request" || frame.kind !== "confirm" || answeredAsks.has(frame.id)) continue;
			answeredAsks.add(frame.id);
			socket.send(JSON.stringify({ type: "ui_response", id: frame.id, value: true }));
		}
	};
	const keyedConversation = async (name: string): Promise<string> => {
		socket.close();
		await roomIdle();
		const pathname = `/api/persistent-agents/${encodeURIComponent(room)}/threads/${name}`;
		const opened = await json(pathname, { method: "PUT", body: JSON.stringify({ state: "active", origin: "launcher", model, items: [] }) });
		assert(opened.status === 200, `conversation ${name} opened, got ${opened.status} ${JSON.stringify(opened.body).slice(0, 300)}`);
		socket = await connect(model, name);
		return pathname;
	};
	const itemsOf = async (pathname: string): Promise<any[]> => (await json(pathname)).body?.thread?.items ?? [];
	const itemsOnceLanded = async (pathname: string, landed: (items: any[]) => boolean, label: string): Promise<any[]> => {
		const deadline = Date.now() + 10_000;
		for (;;) {
			const items = await itemsOf(pathname);
			if (landed(items)) return items;
			assert(Date.now() < deadline, `timed out waiting until ${label}, got ${JSON.stringify(items.map((item) => item.id))}`);
			await new Promise((resolve) => setTimeout(resolve, 100));
		}
	};
	const saveItems = async (pathname: string, items: any[], removed?: string[]) => {
		const state = (await json(pathname)).body?.thread?.state ?? "active";
		const saved = await json(pathname, { method: "PUT", body: JSON.stringify({ state, origin: "unknown", model, items, ...(removed ? { removed } : {}) }) });
		assert(saved.status === 200, `the save went in, got ${saved.status} ${JSON.stringify(saved.body).slice(0, 200)}`);
	};
	const sendKeyed = (key: string, text: string, extra: Record<string, unknown> = {}) => socket.send(JSON.stringify({ type: "prompt", text, id: key, shown: { text, files: [] }, ...extra }));
	const runKeyed = async (key: string, text: string, turnLegs: Leg[], extra: Record<string, unknown> = {}): Promise<number> => {
		legs = turnLegs;
		const mark = frames.length;
		sendKeyed(key, text, extra);
		await waitUntil(() => { approveAsked(mark); return turnEnded(mark); }, `the keyed turn ${key} ended`);
		await roomIdle();
		return mark;
	};
	// The ids the turn's frames named, in the order they opened, as the page keeps them.
	const namedIds = (mark: number): string[] => {
		const named: string[] = [];
		for (const frame of since(mark)) {
			const id = frame.type === "event" ? frame.event?.itemId ?? frame.event?.assistantMessageEvent?.itemId : undefined;
			if (typeof id === "string" && !named.includes(id)) named.push(id);
		}
		return named;
	};
	const idList = (items: any[]) => items.map((item) => item.id).join(",");
	// The server answers an effort frame at once, and handles a frame with no turn before it awaits anything: once the answer is back, every frame sent before it was handled.
	const framesHandled = async () => {
		const mark = frames.length;
		socket.send(JSON.stringify({ type: "effort", level: "medium" }));
		await waitUntil(() => has(mark, (frame) => frame.type === "effort"), "the frames sent before were handled");
	};
	const bashLs: Leg = { tool: { name: "bash", args: { command: "ls" } } };

	// --- K1. A watched keyed turn lands at its settle: after the page saved it all and left, an older save keeps the step and the answer.
	await scene("K1", async () => {
		const pathname = await keyedConversation("conv-keyed-1");
		const mark = await runKeyed("kq1", "List the files.", [bashLs, { text: "Two files." }]);
		const named = namedIds(mark);
		assert(named.includes("kq1-t1") && named.some((id) => /^kq1-a\d+$/.test(id)), `the frames named the step and the answer, got ${JSON.stringify(named)}`);
		// The frame that opens the step names it; a bare heartbeat of the call never does, so the coalescer still merges those.
		const stepFrames = since(mark).filter((frame) => frame.type === "event" && frame.event?.assistantMessageEvent?.itemId === "kq1-t1");
		const bare = stepFrames.filter((frame) => frame.event.assistantMessageEvent.type !== "toolcall_start" && Object.keys(frame.event.assistantMessageEvent).every((key) => ["type", "contentIndex", "itemId"].includes(key)));
		assert(stepFrames[0]?.event.assistantMessageEvent.type === "toolcall_start" && bare.length === 0, `the opening frame names the step and no heartbeat does, got ${JSON.stringify(stepFrames.map((frame) => frame.event.assistantMessageEvent))}`);
		const landed = await itemsOnceLanded(pathname, (items) => items.some((item) => item.id === "kq1-t1"), "the turn landed");
		const answerId = landed.find((item) => item.kind === "assistant")?.id;
		assert(idList(landed) === `kq1,kq1-t1,${answerId}` && landed.every((item) => item.landed === true), `question, step and answer, each marked, got ${JSON.stringify(landed.map((item) => [item.id, item.landed]))}`);
		assert(landed[0].text === "List the files." && landed[1].status === "done" && landed[2].text === "Two files.", `as the page showed them, got ${JSON.stringify(landed)}`);
		// The page's full save, then the window leaves, then an older save holding only the question.
		await saveItems(pathname, landed.map(({ landed: _mark, ...item }) => item));
		socket.close();
		await roomIdle();
		await saveItems(pathname, [{ kind: "user", id: "kq1", text: "List the files.", ts: Date.now() }]);
		const after = await itemsOf(pathname);
		assert(idList(after) === `kq1,kq1-t1,${answerId}`, `the step and the answer stay, in order, got ${idList(after)}`);
		socket = await connect(model, "conv-keyed-1");
		console.log("ok K1 a watched keyed turn lands at its settle and survives an older save");
	});

	// --- K2. A message the turn took mid-step lands where it was taken, under its bubble's id; a late save without it brings it back there.
	await scene("K2", async () => {
		const pathname = await keyedConversation("conv-keyed-2");
		legs = [{ tool: { name: "bash", args: { command: "sleep 2" } } }, { text: "Done, the short way." }];
		const mark = frames.length;
		sendKeyed("kq2", "Run the slow check.");
		await waitUntil(() => { approveAsked(mark); return has(mark, (frame) => frame.type === "event" && frame.event?.type === "tool_execution_start"); }, "the step runs");
		steer("ks2", "Keep it short.");
		await waitUntil(() => turnEnded(mark), "the turn ended");
		await roomIdle();
		const landed = await itemsOnceLanded(pathname, (items) => items.some((item) => item.id === "out-ks2"), "the taken message landed");
		const answerId = landed.find((item) => item.kind === "assistant")?.id;
		assert(idList(landed) === `kq2,kq2-t1,out-ks2,${answerId}`, `the taken message sits after the step, got ${idList(landed)}`);
		await saveItems(pathname, landed.filter((item) => item.id !== "out-ks2"));
		assert(idList(await itemsOf(pathname)) === `kq2,kq2-t1,out-ks2,${answerId}`, "a save without it brings it back in its place");
		console.log("ok K2 a taken message lands where it was taken and comes back there");
	});

	// --- K3. A reveal stopped at nothing after two runs of one command: both cards finish, the unseen answer does not land.
	await scene("K3", async () => {
		const pathname = await keyedConversation("conv-keyed-3");
		legs = [bashLs, bashLs, { text: "Here is the list of files." }];
		const mark = frames.length;
		sendKeyed("kq3", "List the files twice.");
		await waitUntil(() => { approveAsked(mark); return turnEnded(mark); }, "the model finished");
		// The page saved the first card done and the second still running, then the reveal stops at nothing and the window leaves.
		await saveItems(pathname, [{ kind: "user", id: "kq3", text: "List the files twice.", ts: Date.now() }, { kind: "tool", id: "kq3-t1", name: "bash", args: { command: "ls" }, status: "done", result: "x" }, { kind: "tool", id: "kq3-t2", name: "bash", args: { command: "ls" }, status: "running" }]);
		const answerId = namedIds(mark).filter((id) => /^kq3-a\d+$/.test(id)).at(-1);
		socket.send(JSON.stringify({ type: "stop_reveal", shown: 0, itemId: answerId }));
		socket.close();
		await roomIdle();
		const items = await itemsOnceLanded(pathname, (all) => all.filter((item) => item.kind === "tool" && item.status === "done").length === 2, "both cards finished");
		assert(idList(items) === "kq3,kq3-t1,kq3-t2", `both runs, no answer, got ${idList(items)}`);
		assert(!items.some((item) => item.kind === "assistant"), "the answer nobody saw does not land");
		socket = await connect(model, "conv-keyed-3");
		console.log("ok K3 a reveal stopped at nothing lands both runs finished and no answer");
	});

	// --- K4. A landed question comes back to a save that lacks it, unless the save names it removed; then no later save brings it back.
	await scene("K4", async () => {
		const pathname = await keyedConversation("conv-keyed-4");
		await runKeyed("kq4", "Say hello.", [{ text: "Hello." }]);
		const landed = await itemsOnceLanded(pathname, (items) => items.some((item) => item.id === "kq4" && item.landed === true), "the turn landed");
		await saveItems(pathname, []);
		assert(idList(await itemsOf(pathname)) === idList(landed), "a save without the question brings it and its answer back");
		await saveItems(pathname, landed.filter((item) => item.kind === "assistant"), ["kq4"]);
		assert(!(await itemsOf(pathname)).some((item) => item.id === "kq4"), "a save naming it removed takes it out");
		await saveItems(pathname, landed);
		assert(!(await itemsOf(pathname)).some((item) => item.id === "kq4"), "an older save still holding it does not bring it back");
		console.log("ok K4 a removed question stays out, a lacking save brings a landed one back");
	});

	// --- K5. A failed message the room offers back lands only when the page keeps it above; handed back, it stays out.
	await scene("K5", async () => {
		const pathname = await keyedConversation("conv-keyed-5");
		for (const kept of [true, false]) {
			const key = kept ? "kq5a" : "kq5b";
			legs = [{ refused: "The request was malformed." }];
			const mark = frames.length;
			sendKeyed(key, kept ? "Keep me above." : "Hand me back.");
			await waitUntil(() => has(mark, (frame) => frame.type === "prompt_returned"), "the room offers the message back");
			await roomIdle();
			assert(!(await itemsOf(pathname)).some((item) => item.id === key), `the settle lands nothing of an offered message, got ${idList(await itemsOf(pathname))}`);
			socket.send(JSON.stringify({ type: "returned_prompt_handled", kept }));
			if (kept) {
				const items = await itemsOnceLanded(pathname, (all) => all.some((item) => item.id === key && item.landed === true), "the kept message landed");
				await saveItems(pathname, []);
				assert((await itemsOf(pathname)).some((item) => item.id === key), `an older save keeps the kept message, got ${idList(items)}`);
			} else {
				await framesHandled();
				await saveItems(pathname, (await itemsOf(pathname)), [key]);
				assert(!(await itemsOf(pathname)).some((item) => item.id === key), "the handed-back message stays out");
			}
		}
		console.log("ok K5 a kept message lands on the page's word, a handed-back one never");
	});

	// --- K6. Stop on a landed part from the window that ran it: the file keeps the cut against a save holding the whole text.
	await scene("K6", async () => {
		const pathname = await keyedConversation("conv-keyed-6");
		await runKeyed("kq6", "Explain it.", [{ text: "Shown words. Unseen words." }]);
		const landed = await itemsOnceLanded(pathname, (items) => items.some((item) => item.kind === "assistant" && item.landed === true), "the answer landed");
		const part = landed.find((item) => item.kind === "assistant");
		socket.send(JSON.stringify({ type: "stop_reveal", shown: "Shown words.".length, itemId: part.id }));
		const cut = await itemsOnceLanded(pathname, (items) => items.some((item) => item.id === part.id && item.stoppedAt !== undefined), "the cut reached the file");
		assert(cut.find((item) => item.id === part.id).text === "Shown words.", `the part keeps the shown words, got ${JSON.stringify(cut.find((item) => item.id === part.id))}`);
		await saveItems(pathname, landed.map(({ landed: _mark, ...item }) => item));
		const after = (await itemsOf(pathname)).find((item) => item.id === part.id);
		assert(after.text === "Shown words." && after.stoppedAt === "Shown words.".length, `a save with the whole text keeps the cut, got ${JSON.stringify(after)}`);
		// The next message tells the model what the person saw of it.
		const before = calls.length;
		await runKeyed("kq6b", "Go on.", [{ text: "Noted." }]);
		const told = calls.slice(before)[0]?.userTexts.at(-1) ?? "";
		assert(told.startsWith(STOP_OPEN) && told.includes("Shown words.") && !told.includes("Unseen words."), `the next message carries Stop's note, got ${JSON.stringify(told.slice(0, 120))}`);
		console.log("ok K6 a Stop on a landed part cuts it in the file, the cut holds, and the next message is told");
	});

	// --- K7. A turn without an id moves the latest-turn marker: a late Stop and a stopped copy cut nothing older.
	await scene("K7", async () => {
		const pathname = await keyedConversation("conv-keyed-7");
		await runKeyed("kq7", "First question.", [{ text: "The whole older answer." }]);
		const landed = await itemsOnceLanded(pathname, (items) => items.some((item) => item.kind === "assistant" && item.landed === true), "the keyed answer landed");
		const part = landed.find((item) => item.kind === "assistant");
		legs = [{ text: "An answer from an old page." }];
		const mark = frames.length;
		socket.send(JSON.stringify({ type: "prompt", text: "Second question." }));
		await waitUntil(() => turnEnded(mark), "the old page's turn ended");
		await roomIdle();
		socket.send(JSON.stringify({ type: "stop_reveal", shown: 5, itemId: part.id }));
		await framesHandled();
		await saveItems(pathname, [...landed.map(({ landed: _mark, ...item }) => item.id === part.id ? { ...item, text: "The w", stoppedAt: 5 } : item)]);
		const after = (await itemsOf(pathname)).find((item) => item.id === part.id);
		assert(after?.text === "The whole older answer." && after.stoppedAt === undefined, `the older answer stays whole, got ${JSON.stringify(after)}`);
		console.log("ok K7 a late Stop cuts nothing once a newer turn ran");
	});

	// --- K8. A cut whose write failed is kept: the next write of the conversation, a newer turn's landing, applies it.
	// Taking the owner's write away refuses nothing on Windows or as root.
	const canForceFsRefusal = process.platform !== "win32" && process.getuid?.() !== 0;
	if (canForceFsRefusal) await scene("K8", async () => {
		const pathname = await keyedConversation("conv-keyed-8");
		await runKeyed("kq8", "Explain it.", [{ text: "Kept words. Cut words." }]);
		const landed = await itemsOnceLanded(pathname, (items) => items.some((item) => item.kind === "assistant" && item.landed === true), "the answer landed");
		const part = landed.find((item) => item.kind === "assistant");
		const threadDir = path.join(agentsRoot, room, "runtime", "threads");
		assert(fs.existsSync(path.join(threadDir, "conv-keyed-8.json")), "the conversation's file was found");
		fs.chmodSync(threadDir, 0o500);
		try {
			const logged = serverOutput.join("").length;
			socket.send(JSON.stringify({ type: "stop_reveal", shown: "Kept words.".length, itemId: part.id }));
			await waitUntil(() => serverOutput.join("").slice(logged).includes("a Stop's cut waits for the conversation's next write"), "the server refused the cut's write and kept the cut");
		} finally {
			fs.chmodSync(threadDir, 0o700);
		}
		// The cut holds from here on, for every reader and every write built from a read, before any write carries it.
		assert((await itemsOf(pathname)).find((item) => item.id === part.id)?.text === "Kept words.", `a read after the refused write shows the cut, got ${JSON.stringify((await itemsOf(pathname)).find((item) => item.id === part.id))}`);
		// The next write is an old page's turn landing while nobody is in the room: it applies the kept cut too.
		legs = [{ held: true, lead: "Newer", text: " answer." }];
		holdNextLeg();
		const mark = frames.length;
		socket.send(JSON.stringify({ type: "prompt", text: "And now?" }));
		await waitUntil(() => has(mark, (frame) => frame.type === "event" && frame.event?.type === "message_update"), "the newer answer is being written");
		socket.close();
		await roomDetached();
		release();
		await roomIdle();
		const after = await itemsOnceLanded(pathname, (items) => items.some((item) => String(item.id).startsWith("detached-assistant-")), "the newer turn landed");
		assert(after.find((item) => item.id === part.id)?.text === "Kept words.", `the newer landing applied the kept cut, got ${JSON.stringify(after.find((item) => item.id === part.id))}`);
		socket = await connect(model, "conv-keyed-8");
		console.log("ok K8 a cut whose write failed is applied by the next write, whoever writes");
	});
	else console.log("SKIP: K8 needs a refused write, which Windows and root cannot force");

	// --- K9. A question with only files, its page saves lost, lands with every chip; a malformed chip goes alone.
	await scene("K9", async () => {
		const pathname = await keyedConversation("conv-keyed-9");
		const files = Array.from({ length: 21 }, (_, n) => ({ name: `file-${n}.txt`, bytes: 10 + n, extension: "txt" }));
		legs = [{ held: true, lead: "Reading them.", text: " All read." }];
		holdNextLeg();
		const mark = frames.length;
		socket.send(JSON.stringify({ type: "prompt", text: "[Attached files: 21]", id: "kq9", shown: { text: "", files: [...files, { name: 3, bytes: "x" }] } }));
		await waitUntil(() => has(mark, (frame) => frame.type === "event" && frame.event?.type === "message_update"), "the answer is being written");
		socket.close();
		await roomDetached();
		release();
		await roomIdle();
		const items = await itemsOnceLanded(pathname, (all) => all.some((item) => item.id === "kq9"), "the question landed");
		const asked = items.find((item) => item.id === "kq9");
		assert(asked.text === "" && asked.attachments?.length === 21 && asked.attachments[20].name === "file-20.txt", `the question with all 21 chips and no words, got ${JSON.stringify(asked).slice(0, 300)}`);
		assert(items.findIndex((item) => item.kind === "assistant") > items.indexOf(asked), "then the answer");
		socket = await connect(model, "conv-keyed-9");
		console.log("ok K9 a files-only question lands with its chips");
	});

	// --- K10. The reader keeps a keyed part whose words sit inside an old landed answer.
	await scene("K10", async () => {
		const pathname = await keyedConversation("conv-keyed-10");
		await saveItems(pathname, [
			{ kind: "user", id: "u10", text: "Check the files.", ts: 1 },
			{ kind: "assistant", id: "detached-assistant-turn_10", text: "Checking the files. The first one failed.", ts: 2 },
			{ kind: "assistant", id: "kc10-a1", text: "Checking the files.", ts: 3 },
			{ kind: "tool", id: "kc10-t1", name: "bash", args: { command: "ls" }, status: "done", result: "x" },
		]);
		const items = await itemsOf(pathname);
		assert(idList(items) === "u10,detached-assistant-turn_10,kc10-a1,kc10-t1", `both answers stay, got ${idList(items)}`);
		console.log("ok K10 the reader keeps a keyed part beside an old answer holding its words");
	});

	// --- K11. An id the conversation already used makes the turn old-style: its frames name nothing.
	await scene("K11", async () => {
		await keyedConversation("conv-keyed-11");
		await runKeyed("kq11", "Once.", [{ text: "First." }]);
		const again = await runKeyed("kq11", "Twice.", [{ text: "Second." }]);
		assert(namedIds(again).length === 0, `a used id names nothing, got ${JSON.stringify(namedIds(again))}`);
		const malformed = await runKeyed("bad-id", "Hyphen.", [{ text: "Third." }]);
		assert(namedIds(malformed).length === 0, "a malformed id names nothing");
		console.log("ok K11 a used or malformed id makes the turn old-style");
	});

	// --- K12. A save naming an old landed answer removed keeps it out: the old merge does not bring it back.
	await scene("K12", async () => {
		const pathname = await keyedConversation("conv-keyed-12");
		await saveItems(pathname, [{ kind: "user", id: "u12", text: "Old question.", ts: 1 }, { kind: "assistant", id: "detached-assistant-turn_12", text: "Old landed answer.", ts: 2 }]);
		await saveItems(pathname, [{ kind: "user", id: "u12", text: "Old question.", ts: 1 }], ["detached-assistant-turn_12"]);
		assert(idList(await itemsOf(pathname)) === "u12", `the removed answer stays out, got ${idList(await itemsOf(pathname))}`);
		console.log("ok K12 a removed old answer stays out");
	});

	// Held messages: the conversation's queued messages no answer took, kept on disk until the person acts.
	const heldConversation = "conv-held";
	const heldFile = path.join(agentsRoot, room, "runtime", "held-messages", `${heldConversation}.json`);
	const heldOnDisk = (): Array<{ id: string; text: string }> => (fs.existsSync(heldFile) ? JSON.parse(fs.readFileSync(heldFile, "utf-8")).messages ?? [] : []);
	const readyHeld = (mark: number) => since(mark).find((frame) => frame.type === "ready")?.held;

	// --- H1. A page holds what it queued; a repeat keeps one; a new connection lists them; held_drop takes them off.
	await scene("H1", async () => {
		await keyedConversation(heldConversation);
		socket.send(JSON.stringify({ type: "hold", messages: [{ id: "h-1", text: "First held." }, { id: "h-2", text: "Second held." }] }));
		socket.send(JSON.stringify({ type: "hold", messages: [{ id: "h-1", text: "First held." }] }));
		// Read leniently: an entry with no id or no words is no message.
		socket.send(JSON.stringify({ type: "hold", messages: [{ id: "", text: "No id." }, { id: "h-3", text: "  " }, "not a message"] }));
		await waitUntilAsync(async () => JSON.stringify(heldOnDisk()) === JSON.stringify([{ id: "h-1", text: "First held." }, { id: "h-2", text: "Second held." }]), `both are held once each, in order, got ${JSON.stringify(heldOnDisk())}`);
		socket.close();
		await roomIdle();
		const mark = frames.length;
		socket = await connect(model, heldConversation);
		assert(JSON.stringify(readyHeld(mark)) === JSON.stringify([{ id: "h-1", text: "First held." }, { id: "h-2", text: "Second held." }]), `a new connection's ready lists them, got ${JSON.stringify(readyHeld(mark))}`);
		socket.send(JSON.stringify({ type: "held_drop", id: "h-1" }));
		await waitUntilAsync(async () => JSON.stringify(heldOnDisk().map((message) => message.id)) === JSON.stringify(["h-2"]), "held_drop takes the edited or removed one off");
		socket.send(JSON.stringify({ type: "held_drop", id: "h-2" }));
		await waitUntilAsync(async () => !fs.existsSync(heldFile), "the last one dropped, an empty list leaves no file");
		console.log("ok H1 held messages are kept once each, listed on a new connection, and taken off when dropped");
	});

	// --- H3. The held list has limits: a message past them is refused, and none held already is pushed out.
	await scene("H3", async () => {
		const many = Array.from({ length: 50 }, (_, index) => ({ id: `m-${index}`, text: `Held ${index}.` }));
		socket.send(JSON.stringify({ type: "hold", messages: many }));
		socket.send(JSON.stringify({ type: "hold", messages: [{ id: "m-50", text: "One too many." }] }));
		// A message as long as one may be fits, one character more never does.
		socket.send(JSON.stringify({ type: "hold", messages: [{ id: "long", text: "x".repeat(100_001) }] }));
		await waitUntilAsync(async () => heldOnDisk().length === 50, `fifty are held, got ${heldOnDisk().length}`);
		// A frame after the others has been read: the refused ones are not there.
		socket.send(JSON.stringify({ type: "held_drop", id: "m-49" }));
		await waitUntilAsync(async () => heldOnDisk().length === 49, "the drop after them has been read");
		const ids = heldOnDisk().map((message) => message.id);
		assert(ids[0] === "m-0" && !ids.includes("m-50") && !ids.includes("long"), `the first held stays, the fifty-first and the over-long one are refused, got ${JSON.stringify(ids.slice(0, 2))}… ${ids.length}`);
		for (const message of many) socket.send(JSON.stringify({ type: "held_drop", id: message.id }));
		await waitUntilAsync(async () => !fs.existsSync(heldFile), "all dropped");
		// By size: twenty full-length messages fill the conversation's share, and a short one more is refused.
		const full = Array.from({ length: 20 }, (_, index) => ({ id: `f-${index}`, text: String(index % 10).repeat(100_000) }));
		socket.send(JSON.stringify({ type: "hold", messages: full }));
		socket.send(JSON.stringify({ type: "hold", messages: [{ id: "f-20", text: "Short." }] }));
		socket.send(JSON.stringify({ type: "held_drop", id: "f-19" }));
		await waitUntilAsync(async () => heldOnDisk().length === 19 && heldOnDisk()[0]?.id === "f-0", `twenty full ones were held, then one dropped, got ${heldOnDisk().length}`);
		assert(!heldOnDisk().some((message) => message.id === "f-20"), "past the size, a short one more is refused");
		for (const message of full) socket.send(JSON.stringify({ type: "held_drop", id: message.id }));
		await waitUntilAsync(async () => !fs.existsSync(heldFile), "all dropped again");
		console.log("ok H3 the held list refuses past fifty messages, a message over 100,000 characters and past 2,000,000 in all, and pushes none out");
	});

	// --- H2. A message waiting for the answer when the server stops is held, and the restarted server lists it.
	if (process.platform === "win32") console.log("skip H2 (a stop on Windows is a kill)");
	else await scene("H2", async () => {
		legs = [{ held: true, lead: "Writing while the server stops." }];
		holdNextLeg();
		const mark = frames.length;
		socket.send(JSON.stringify({ type: "prompt", text: "Start an answer the server stops." }));
		await waitUntil(() => has(mark, (frame) => frame.type === "event" && frame.event?.type === "message_update"), "the answer is being written");
		steer("s-restart", "Keep me over the restart.", { shown: 0 });
		await waitUntil(() => routed(mark, "s-restart")?.type === "steer_waiting", "it waits for the answer");
		await stopSmokeServer(serverProcess);
		release();
		assert(JSON.stringify(heldOnDisk()) === JSON.stringify([{ id: "s-restart", text: "Keep me over the restart." }]), `the stopping server held it, got ${JSON.stringify(heldOnDisk())}`);
		await startServer();
		const back = frames.length;
		socket = await connect(model, heldConversation);
		assert(JSON.stringify(readyHeld(back)) === JSON.stringify([{ id: "s-restart", text: "Keep me over the restart." }]), `the restarted server lists it, got ${JSON.stringify(readyHeld(back))}`);
		assert(!calls.some((call) => call.userTexts.includes("Keep me over the restart.")), "nothing sent it by itself");
		socket.send(JSON.stringify({ type: "held_drop", id: "s-restart" }));
		await waitUntilAsync(async () => !fs.existsSync(heldFile), "removed, it is held no longer");
		console.log("ok H2 a message waiting when the server stops is held over the restart, and nothing sends it");
	});

	socket.close();
	await roomIdle();
	socket = await connect();

	// --- 17. The provider's own web search is a step: Enter during it waits for the step, it does not cut.
	await scene("17", async () => {
		const approved = await json("/api/persistent-agent-ai-profiles/custom", { method: "PUT", body: JSON.stringify({ providerId: SEARCH.provider, label: "Claude API key", roomModels: [SEARCH.model], learnModel: SEARCH.model }) });
		assert(approved.status === 200, `the search model is approved, got ${approved.status}`);
		assert((await json(`/api/persistent-agents/${encodeURIComponent(room)}/models`, { method: "PUT", body: JSON.stringify({ conversation: SEARCH }) })).status === 200, "the room picks the search model");
		socket.close();
		await roomIdle();
		// A conversation of its own on the search model: a room binds on its conversation's model.
		assert((await json(`/api/persistent-agents/${encodeURIComponent(room)}/threads/conv-search`, { method: "PUT", body: JSON.stringify({ state: "active", origin: "launcher", model: SEARCH, items: [] }) })).status === 200, "a conversation on the search model");
		socket = await connect(SEARCH, "conv-search");
		const before = calls.length;
		searchHeld = new Promise<void>((resolve) => { releaseSearch = resolve; });
		const mark = frames.length;
		socket.send(JSON.stringify({ type: "prompt", text: "What is the newest Node release?" }));
		await waitUntil(() => has(mark, (frame) => frame.type === "event" && frame.event?.assistantMessageEvent?.type === "server_tool_start"), "the provider searches");
		steer("s-search", "Only the LTS line.", { shown: "Let me search.".length });
		await waitUntil(() => !!routed(mark, "s-search"), "the server routed it");
		const way = routed(mark, "s-search");
		releaseSearch();
		assert(way.type === "steer_waiting", `a message during the provider's search waits for it, got ${JSON.stringify(way)}`);
		await waitUntil(() => turnEnded(mark), "the turn ended");
		assert(has(mark, (frame) => frame.type === "steer_taken" && frame.id === "s-search") && calls.slice(before).some((call) => call.userTexts.at(-1) === "Only the LTS line."), "the model gets it once the search's answer is written");
		await roomIdle();
		// An answer in two text blocks, stopped while the page revealed its first: the landing keeps that block only.
		searchHeld = Promise.resolve();
		const twoBlocks = frames.length;
		socket.send(JSON.stringify({ type: "prompt", text: "And the release before it?" }));
		await waitUntil(() => turnEnded(twoBlocks), "the two-block answer ended");
		socket.send(JSON.stringify({ type: "stop_reveal", shown: "Let me search.".length }));
		socket.close();
		await roomIdle();
		const searchThread = `/api/persistent-agents/${encodeURIComponent(room)}/threads/conv-search`;
		const deadline = Date.now() + 10_000;
		let landed = "";
		for (;;) {
			const items: any[] = (await json(searchThread)).body?.thread?.items ?? [];
			landed = String([...items].reverse().find((item) => item.kind === "assistant")?.text ?? "");
			if (landed.includes("Let me search.")) break;
			assert(Date.now() < deadline, "the two-block answer landed");
			await new Promise((resolve) => setTimeout(resolve, 100));
		}
		assert(landed.trim() === "Let me search.", `the landing keeps only the block shown, got ${JSON.stringify(landed)}`);
		console.log("ok 17 a message during the provider's search waits for the step, and a two-block answer lands as far as it showed");
	});

	assert(failed.length === 0, `room-steer:\n  ${failed.join("\n  ")}`);
	console.log("room-steer-smoke: OK");
} catch (error) {
	console.error(serverOutput.join("").slice(-6000));
	throw error;
} finally {
	release();
	releaseSearch();
	try { gateway.close(); } catch {}
	await stopSmokeServer(serverProcess);
	fs.rmSync(tempRoot, { recursive: true, force: true });
}
